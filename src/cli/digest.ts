/** Building a run digest from the durable event stream. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteJson } from '../pirun-files.ts';
import { isRecord, truncate } from './context.ts';
import { jobDir, type JobMeta } from './store.ts';

export interface ToolUse {
	name: string;
	hint: string;
	failed: boolean;
}

export interface Digest {
	status: 'ok' | 'empty' | 'failed' | 'running' | 'timeout' | 'interrupted';
	sessionId: string;
	turns: number;
	retries: number;
	compactions: number;
	tools: ToolUse[];
	text: string;
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	/**
	 * Tokens the final assistant turn saw plus what it produced. The next
	 * request re-sends all of it, so this is what the session now occupies.
	 */
	contextTokens: number;
	cost: number;
	errors: string[];
	notes: string[];
	/**
	 * Actions the agent wanted that the permission level denied. A headless
	 * harness cannot prompt, so the denial IS the ask — surfaced to the
	 * caller like response text, with the flag that would grant it.
	 */
	permissionAsks: string[];
}

function emptyDigest(): Digest {
	return {
		status: 'running',
		sessionId: '',
		turns: 0,
		retries: 0,
		compactions: 0,
		tools: [],
		text: '',
		inputTokens: 0,
		cachedTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		cost: 0,
		errors: [],
		notes: [],
		permissionAsks: []
	};
}

const PERMISSION_DENIAL_PATTERN = /permission check failed|denied permission|required the .* permission/i;

/**
 * Pi surfaces provider failures as `errorMessage` strings that often wrap a
 * JSON envelope: `502: {"message":"…","type":"…"}`. The caller wants the
 * sentence, not the envelope.
 */
function unwrapErrorMessage(raw: string) {
	const at = raw.indexOf('{');
	if (at === -1) return truncate(raw, 200);
	const status = raw.slice(0, at).replace(/[:\s]+$/, '').trim();
	try {
		const parsed = JSON.parse(raw.slice(at)) as { message?: string; details?: unknown };
		const message = typeof parsed.message === 'string' ? parsed.message : raw.slice(at);
		const details =
			typeof parsed.details === 'string' && parsed.details.length < 240 ? ` — ${parsed.details}` : '';
		return truncate(`${status ? `${status} ` : ''}${message}${details}`, 240);
	} catch {
		return truncate(raw, 200);
	}
}

const ARG_HINT_KEYS = ['path', 'file_path', 'filePath', 'command', 'CommandLine', 'pattern', 'query', 'url'];

export function argHint(args: unknown) {
	if (!args || typeof args !== 'object') return '';
	const record = args as Record<string, unknown>;
	for (const key of ARG_HINT_KEYS) {
		const value = record[key];
		if (typeof value === 'string' && value) return truncate(value, 48);
	}
	const first = Object.values(record).find((value) => typeof value === 'string');
	return typeof first === 'string' ? truncate(first, 48) : '';
}

function buildAntigravityDigest(id: string, meta: JobMeta): Digest {
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	const digestPath = resolve(jobDir(id), 'digest.json');
	if (meta.finishedAt && existsSync(digestPath)) {
		try {
			return JSON.parse(readFileSync(digestPath, 'utf8')) as Digest;
		} catch {
			// Rebuild from the durable stream below.
		}
	}
	const digest = emptyDigest();
	if (meta.supervisorError) digest.errors.push(meta.supervisorError);
	let resultStatus = '';
	const seenTools = new Set<string>();
	const seenErrors = new Set(digest.errors);
	if (existsSync(eventsPath)) {
		for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
			if (!line.trim()) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				const message = truncate(line, 240);
				if (/authentication required|error|failed|invalid/i.test(line) && !seenErrors.has(message)) {
					seenErrors.add(message);
					digest.errors.push(message);
				}
				continue;
			}
			const eventName = String(event.event ?? '');
			if (typeof event.conversation_id === 'string') digest.sessionId = event.conversation_id;
			if (eventName === 'step_update' && isRecord(event.step_update)) {
				const step = event.step_update;
				if (typeof step.conversation_id === 'string') digest.sessionId = step.conversation_id;
				if (step.step_type === 'tool' && (step.state === 'DONE' || step.state === 'ERROR')) {
					const key = String(step.step_index ?? `${step.tool_name}:${digest.tools.length}`);
					if (!seenTools.has(key)) {
						seenTools.add(key);
						const info = isRecord(step.tool_info) ? step.tool_info : null;
						const name = String(step.tool_name ?? info?.name ?? 'tool');
						const hint = argHint(info?.parameters);
						digest.tools.push({ name, hint, failed: Boolean(info?.error) });
						const errorMessage = isRecord(info?.error) && typeof info.error.message === 'string'
							? info.error.message
							: '';
						if (PERMISSION_DENIAL_PATTERN.test(errorMessage)) {
							const ask = `${name}${hint ? `(${hint})` : ''}`;
							if (!digest.permissionAsks.includes(ask)) digest.permissionAsks.push(ask);
						}
					}
				}
			}
			if (eventName !== 'result' || !isRecord(event.result)) continue;
			const result = event.result;
			if (typeof result.conversation_id === 'string') digest.sessionId = result.conversation_id;
			resultStatus = String(result.status ?? '');
			digest.turns = Number(result.num_turns ?? digest.turns);
			if (typeof result.response === 'string') digest.text = result.response.trim();
			const usage = isRecord(result.usage) ? result.usage : null;
			if (usage) {
				digest.inputTokens = Number(usage.input_tokens ?? 0);
				digest.cachedTokens = Number(usage.cache_read_tokens ?? 0);
				digest.outputTokens = Number(usage.output_tokens ?? 0) + Number(usage.thinking_tokens ?? 0);
				digest.contextTokens = Number(usage.total_tokens ?? 0);
			}
			if (typeof result.error === 'string' && result.error.trim() && !seenErrors.has(result.error.trim())) {
				seenErrors.add(result.error.trim());
				digest.errors.push(truncate(result.error, 300));
			}
		}
	}

	if (!meta.finishedAt) return digest;
	if (meta.timedOut) digest.status = 'timeout';
	else if (meta.interrupted && !resultStatus) digest.status = 'interrupted';
	else if (meta.exitCode !== 0 || (resultStatus && resultStatus !== 'SUCCESS') || digest.errors.length) {
		digest.status = 'failed';
	} else if (!resultStatus || !digest.text) digest.status = 'empty';
	else digest.status = 'ok';
	atomicWriteJson(digestPath, digest);
	return digest;
}

export function buildDigest(id: string, meta: JobMeta): Digest {
	if (meta.harness === 'antigravity') return buildAntigravityDigest(id, meta);
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	const digestPath = resolve(jobDir(id), 'digest.json');
	if (meta.finishedAt && existsSync(digestPath)) {
		try {
			return JSON.parse(readFileSync(digestPath, 'utf8')) as Digest;
		} catch {
			// Rebuild a damaged or stale cache from the durable event stream.
		}
	}
	const digest = emptyDigest();
	const seenErrors = new Set<string>();
	if (meta.supervisorError) {
		seenErrors.add(meta.supervisorError);
		digest.errors.push(meta.supervisorError);
	}
	if (!existsSync(eventsPath)) {
		if (meta.finishedAt) {
			if (meta.timedOut) digest.status = 'timeout';
			else if (meta.interrupted) digest.status = 'interrupted';
			else if (meta.exitCode !== 0 || digest.errors.length) digest.status = 'failed';
			else digest.status = 'empty';
			atomicWriteJson(digestPath, digest);
		}
		return digest;
	}

	const failedToolCalls = new Set<string>();
	const toolsByCallId = new Map<string, ToolUse>();
	let lastAssistantText = '';
	let lastAssistantHadTools = false;
	let sawAssistantMessage = false;

	for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Pi writes plain text to the same stream for warnings and startup failures.
			const text = truncate(line, 200);
			if (/error|failed|\b5\d\d\b/i.test(line)) {
				if (!seenErrors.has(text)) {
					seenErrors.add(text);
					digest.errors.push(text);
				}
			} else if (/^warning:/i.test(line)) {
				// Creating a named session is exactly what a new agent is doing.
				if (!/no project session found with id/i.test(line)) digest.notes.push(text);
			}
			continue;
		}

		const type = String(event.type ?? '');
		if (type === 'session' && typeof event.id === 'string') digest.sessionId = event.id;
		if (type === 'turn_start') digest.turns += 1;
		if (type === 'auto_retry_start') digest.retries += 1;
		// Compaction rewrites the prefix, so the provider's cache starts cold
		// again on the next turn. Worth seeing when it happens.
		if (type === 'compaction_end') digest.compactions += 1;

		if (type === 'turn_end' && Array.isArray(event.toolResults)) {
			for (const result of event.toolResults as Array<Record<string, unknown>>) {
				if (result.isError && typeof result.toolCallId === 'string') {
					failedToolCalls.add(result.toolCallId);
					const tool = toolsByCallId.get(result.toolCallId);
					if (tool) tool.failed = true;
				}
			}
		}

		if (type !== 'message_end') continue;
		const message = event.message as Record<string, unknown> | undefined;
		if (!message || message.role !== 'assistant') continue;
		sawAssistantMessage = true;

		const usage = message.usage as Record<string, unknown> | undefined;
		if (usage) {
			digest.inputTokens += Number(usage.input ?? 0);
			digest.cachedTokens += Number(usage.cacheRead ?? 0);
			digest.outputTokens += Number(usage.output ?? 0);
			const footprint =
				Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.output ?? 0);
			if (footprint) digest.contextTokens = footprint;
			const cost = usage.cost as Record<string, unknown> | undefined;
			digest.cost += Number(cost?.total ?? 0);
		}

		const stopReason = String(message.stopReason ?? '');
		if (stopReason === 'error' || stopReason === 'aborted') {
			const raw = typeof message.errorMessage === 'string' ? message.errorMessage : '';
			const described = raw ? unwrapErrorMessage(raw) : `turn ended with stopReason "${stopReason}"`;
			if (!seenErrors.has(described)) {
				seenErrors.add(described);
				digest.errors.push(described);
			}
		}

		const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
		let text = '';
		let hadTools = false;
		for (const part of content) {
			if (part.type === 'text' && typeof part.text === 'string') text += part.text;
			if (part.type === 'toolCall') {
				hadTools = true;
				const callId = typeof part.id === 'string' ? part.id : '';
				const tool = {
					name: String(part.name ?? 'tool'),
					hint: argHint(part.arguments),
					failed: Boolean(callId && failedToolCalls.has(callId))
				};
				digest.tools.push(tool);
				if (callId) toolsByCallId.set(callId, tool);
			}
		}
		if (text.trim()) lastAssistantText = text.trim();
		lastAssistantHadTools = hadTools;
	}

	digest.text = lastAssistantText;

	const running = !meta.finishedAt;
	if (running) {
		digest.status = 'running';
		return digest;
	}
	if (meta.timedOut) digest.status = 'timeout';
	else if (meta.interrupted && !sawAssistantMessage) digest.status = 'interrupted';
	else if (meta.exitCode !== 0 || digest.errors.length) digest.status = 'failed';
	else if (!sawAssistantMessage || (!digest.text && !lastAssistantHadTools)) digest.status = 'empty';
	else digest.status = 'ok';

	atomicWriteJson(digestPath, digest);
	return digest;
}

/** 0 = produced output, 1 = failed/empty/timed out, 2 = still running. */
export function exitCodeFor(status: Digest['status']) {
	if (status === 'ok') return 0;
	if (status === 'running') return 2;
	return 1;
}
