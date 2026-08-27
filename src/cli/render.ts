/** Rendering digests and live-progress handoffs for the caller. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encode } from 'gpt-tokenizer';
import type { PirunArgs as Args } from '../pirun-args.ts';
import { humanDuration, humanTokens, isRecord, out, state, truncate } from './context.ts';
import { jobDir, type JobMeta } from './store.ts';
import type { Digest } from './digest.ts';

export function renderDigest(meta: JobMeta, digest: Digest, options: { full: boolean; label?: string }) {
	const elapsed = (meta.finishedAt ?? Date.now()) - meta.startedAt;
	const total = digest.inputTokens + digest.cachedTokens;
	const hit = total ? Math.round((digest.cachedTokens / total) * 100) : 0;
	const parts = [
		`turns=${digest.turns}`,
		humanDuration(elapsed),
		// Uncached input is what you pay full rate for; the cached half is the
		// whole reason a persistent agent beats a fresh one.
		digest.cachedTokens
			? `in=${humanTokens(digest.inputTokens)}+${humanTokens(digest.cachedTokens)} cached (${hit}%)`
			: `in=${humanTokens(digest.inputTokens)}`,
		`out=${humanTokens(digest.outputTokens)}`
	];
	if (digest.retries) parts.push(`retries=${digest.retries}`);
	if (digest.compactions) parts.push(`compacted=${digest.compactions}`);
	if (digest.cost > 0) parts.push(`$${digest.cost.toFixed(4)}`);

	// Echoing effort next to the model closes the "did my --effort align with
	// the id's tier?" loop from the output instead of a doc round-trip.
	out(
		`[${options.label ?? meta.id}] ${digest.status.toUpperCase()}  ${parts.join('  ')}  ${meta.model}` +
			`${meta.effort ? `  effort=${meta.effort}` : ''}`
	);

	if (digest.tools.length) {
		const rendered = digest.tools
			.map((tool) => `${tool.failed ? '!' : ''}${tool.name}${tool.hint ? `(${tool.hint})` : ''}`)
			.join(' · ');
		out(`tools: ${truncate(rendered, options.full ? 4000 : 300)}`);
	} else if (!meta.tools) {
		// Proof line for guaranteed read-only runs: the harness had no tools.
		out('tools: none (disabled with --no-tools)');
	}

	for (const note of digest.notes.slice(0, 2)) out(`note: ${note}`);
	for (const error of digest.errors.slice(0, 3)) out(`error: ${error}`);

	// A denial is how a headless harness asks: pass the ask up to the caller
	// with the exact flag that would grant it, like any other response.
	const asks = digest.permissionAsks ?? [];
	for (const ask of asks.slice(0, 4)) {
		out(`permission: the agent asked to ${ask} — denied at --permissions ${meta.permissions ?? '(unset)'}`);
	}
	if (asks.length) {
		out(`permission: allow more for this preset: pirun config ${meta.preset ?? state.presetName} --permissions all`);
	}

	if (digest.status === 'interrupted') {
		out(`note: the detached supervisor ended before ${meta.harness === 'antigravity' ? 'Antigravity' : 'Pi'} recorded a result.`);
		out('      Inspect the event log, then retry the task.');
	}

	if (digest.status === 'empty') {
		out(`note: the ${meta.harness === 'antigravity' ? 'Antigravity' : 'direct API'} run produced no assistant content.`);
	}

	out(`events: ${resolve(jobDir(meta.id), 'events.jsonl')}`);

	if (digest.text) {
		const clipped = !options.full && digest.text.length > 2000;
		// A clipped deliverable must never look complete: warn BEFORE the
		// excerpt (a top-down reader may never reach a trailing note) and name
		// the exact command plus the exact byte count --answer will emit, so a
		// captured file can be verified without char-vs-byte doubt.
		if (clipped) {
			out(
				`note: answer truncated below — full ${Buffer.byteLength(digest.text, 'utf8') + 1} bytes: ` +
					`pirun poll ${meta.preset ?? state.presetName} ${meta.id} --answer`
			);
		}
		out('---');
		// The answer is the payload: cap its length but keep its line structure.
		out(clipped ? `${digest.text.slice(0, 2000)}…` : digest.text);
	}
}

interface LiveProgress {
	generatedTokens: number;
	lastTenSecondsTokens: number;
	lastTenSecondsTps: number;
	waitingForFirstToken: boolean;
}

function liveProgress(id: string, meta: JobMeta): LiveProgress {
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	if (!existsSync(eventsPath)) {
		return {
			generatedTokens: 0,
			lastTenSecondsTokens: 0,
			lastTenSecondsTps: 0,
			waitingForFirstToken: true
		};
	}

	let completedTokens = 0;
	let currentText = '';
	let recentText = '';
	let sawGeneratedDelta = false;
	const now = Date.now();
	const recentCutoff = now - 10_000;
	for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = String(event.type ?? '');
		if (meta.harness === 'antigravity') {
			const step = event.event === 'step_update' && isRecord(event.step_update) ? event.step_update : null;
			const delta = typeof step?.text_delta === 'string' ? step.text_delta : '';
			if (step?.step_type === 'agent_response' && delta) {
				sawGeneratedDelta = true;
				currentText += delta;
				if (Number(event._pirun_received_at) >= recentCutoff) recentText += delta;
			}
			if (event.event === 'result' && isRecord(event.result)) {
				const usage = isRecord(event.result.usage) ? event.result.usage : null;
				completedTokens = Number(usage?.output_tokens ?? completedTokens) + Number(usage?.thinking_tokens ?? 0);
				currentText = '';
			}
			continue;
		}
		const message = isRecord(event.message) ? event.message : null;
		if (type === 'message_start' && message?.role === 'assistant') currentText = '';
		if (type === 'message_update') {
			const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
			const updateType = String(update?.type ?? '');
			const delta = typeof update?.delta === 'string' ? update.delta : '';
			if (delta && ['thinking_delta', 'text_delta', 'toolcall_delta'].includes(updateType)) {
				sawGeneratedDelta = true;
				currentText += delta;
				if (Number(event._pirun_received_at) >= recentCutoff) recentText += delta;
			}
		}
		if (type === 'message_end' && message?.role === 'assistant') {
			const usage = isRecord(message.usage) ? message.usage : null;
			completedTokens += Number(usage?.output ?? 0);
			currentText = '';
		}
	}

	const generatedTokens = completedTokens + (currentText ? encode(currentText).length : 0);
	const recentTokens = recentText ? encode(recentText).length : 0;
	const observedWindowSeconds = Math.max(1, Math.min(10, (now - meta.startedAt) / 1000));
	return {
		generatedTokens,
		lastTenSecondsTokens: recentTokens,
		lastTenSecondsTps: recentTokens / observedWindowSeconds,
		waitingForFirstToken: !sawGeneratedDelta
	};
}

export function emitRunningHandoff(meta: JobMeta, digest: Digest, args: Args) {
	// --answer on a still-running run: nothing to print; exit code 2 says so.
	if (args.flags.has('answer')) return;
	const progress = liveProgress(meta.id, meta);
	const hardDeadline = meta.deadlineAt ?? (meta.piStartedAt ?? meta.startedAt) + meta.timeoutSec * 1000;
	const hardRemaining = Math.max(0, hardDeadline - Date.now());
	if (args.flags.has('json')) {
		out(JSON.stringify({ meta, digest, progress, hardRemainingMs: hardRemaining }, null, 2));
		return;
	}
	const label = meta.label ?? meta.id;
	out(
		`[${label}] RUNNING  turns=${digest.turns}  ${humanDuration(Date.now() - meta.startedAt)}  ` +
			`generated≈${humanTokens(progress.generatedTokens)}  last-10s=${progress.lastTenSecondsTps.toFixed(2)} tok/s`
	);
	if (progress.waitingForFirstToken) out('state: waiting for first generated token');
	out(`${meta.harness === 'antigravity' ? 'Antigravity' : 'Pi'} continues in the background; hard stop in ${humanDuration(hardRemaining)}.`);
	const preset = meta.preset ?? state.presetName;
	out(
		`check: pirun wait ${preset} ${meta.id}   ` +
			`progress: pirun poll ${preset} ${meta.id}   stop: pirun kill ${preset} ${meta.id}`
	);
}

export function emit(meta: JobMeta, digest: Digest, args: Args, label?: string) {
	// --answer: the response text alone, complete and verbatim — pipe it
	// straight into a file with no digest header to strip. Exit codes still
	// carry the status.
	if (args.flags.has('answer')) {
		if (digest.text) out(digest.text);
		return;
	}
	if (args.flags.has('json')) out(JSON.stringify({ meta, digest }, null, 2));
	else renderDigest(meta, digest, { full: args.flags.has('full'), label });
}
