/** OpenAI <-> Command Code protocol translation: pure shaping, no processes. */

import { randomUUID } from 'node:crypto';

/**
 * The CLI's only job in this adapter is to mint one authenticated
 * `/alpha/generate` envelope, which the local bridge intercepts and rewrites
 * with our own params — including `params.model`. So the model we hand the CLI
 * on the command line never reaches the API, and it must simply be a name the
 * installed CLI accepts.
 *
 * That matters because the CLI validates `--model` against a list baked into
 * the package at publish time, while the API's catalogue moves independently.
 * Models the account can genuinely use — `stealth/ox-alpha`,
 * `meta/muse-spark-1.2-contributor` — are rejected by an older CLI before it
 * ever dials out. Bootstrapping with a stable id decouples the two: the CLI
 * validates something it has always known, and the real model id travels in the
 * request body where only the API judges it.
 */
export const COMMAND_CODE_BOOTSTRAP_MODEL = 'deepseek/deepseek-v4-flash';

export const COMMAND_CODE_GO_MODELS = [
	'moonshotai/Kimi-K2.7-Code',
	'moonshotai/Kimi-K2.7-Code-Highspeed',
	'moonshotai/Kimi-K2.6',
	'moonshotai/Kimi-K2.5',
	'deepseek/deepseek-v4-pro',
	'deepseek/deepseek-v4-flash',
	'zai-org/GLM-5.2',
	'zai-org/GLM-5.2-Fast',
	'zai-org/GLM-5.1',
	'zai-org/GLM-5',
	'MiniMaxAI/MiniMax-M3',
	'MiniMaxAI/MiniMax-M2.7',
	'MiniMaxAI/MiniMax-M2.5',
	'xiaomi/mimo-v2.5-pro',
	'xiaomi/mimo-v2.5',
	'Qwen/Qwen3.6-Max-Preview',
	'Qwen/Qwen3.6-Plus',
	'Qwen/Qwen3.7-Max',
	'Qwen/Qwen3.7-Plus',
	'Qwen/Qwen3.7-Flash',
	'stepfun/Step-3.7-Flash',
	'stepfun/Step-3.5-Flash',
	'nvidia/nemotron-3-ultra-550b-a55b',
	'tencent/Hy3',
	'xai/grok-4.5',
	'Qwen/Qwen3.8-27B',
	'deepseek/deepseek-v4-flash-vision-exp',
	'meta/muse-spark-1.2-contributor',
	'poolside/laguna-s-2.1-free',
	'stealth/ox-alpha'
] as const;

interface OpenAiMessage {
	role: string;
	content?: unknown;
	name?: string;
	tool_call_id?: string;
	tool_calls?: unknown;
}

export interface OpenAiChatRequest {
	model?: unknown;
	messages?: unknown;
	stream?: unknown;
	temperature?: unknown;
	top_p?: unknown;
	max_tokens?: unknown;
	max_completion_tokens?: unknown;
	presence_penalty?: unknown;
	frequency_penalty?: unknown;
	response_format?: unknown;
	reasoning_effort?: unknown;
	stop?: unknown;
	tools?: unknown;
	tool_choice?: unknown;
	n?: unknown;
	logprobs?: unknown;
	seed?: unknown;
}

export interface InternalStreamResult {
	content: string;
	reasoningContent: string;
	toolCalls: Array<Record<string, unknown>>;
	finishReason: string;
	usage?: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function openAiError(message: string, status: number, code: string, type = 'invalid_request_error') {
	return new Response(JSON.stringify({ error: { message, type, code, param: null } }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

export function describeStreamError(event: Record<string, unknown>) {
	const raw = event.error ?? event.message ?? 'Command Code stream failed.';
	if (typeof raw === 'string') return raw;
	if (isRecord(raw) && typeof raw.message === 'string') return raw.message;
	try {
		return JSON.stringify(raw);
	} catch {
		return String(raw);
	}
}

export function normalizeChatRequest(value: unknown): OpenAiChatRequest | null {
	return isRecord(value) ? (value as OpenAiChatRequest) : null;
}

export function validateChatRequest(body: OpenAiChatRequest) {
	if (typeof body.model !== 'string' || !body.model.trim()) return 'model is required.';
	if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array.';
	if (body.n !== undefined && body.n !== 1) return 'The Command Code CLI adapter currently supports only n=1.';
	if (body.logprobs !== undefined && body.logprobs !== false) return 'logprobs is not supported by the Command Code CLI adapter.';
	if (body.seed !== undefined) return 'seed is not supported by the Command Code CLI adapter.';
	return '';
}

function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (isRecord(part) && typeof part.text === 'string') return part.text;
			return '';
		})
		.join('');
}

/**
 * Command Code's `/alpha/generate` validates its `messages` against the Vercel
 * AI SDK `ModelMessage[]` schema — the same vocabulary its stream speaks back
 * (`text-delta`, `tool-call`). Incoming requests here are OpenAI-shaped, so a
 * tool round-trip has to be translated:
 *
 *   assistant.tool_calls[]  ->  {type: 'tool-call',   toolCallId, toolName, input}
 *   role: 'tool'            ->  {role: 'tool', content: [{type: 'tool-result', …}]}
 *
 * Without this an agent harness gets exactly one tool call and then an empty
 * reply, because a `role: "tool"` turn means nothing on the other side.
 */
function splitMessages(messages: unknown[]) {
	const system: string[] = [];
	const conversation: Array<{ role: string; content: unknown }> = [];
	const toolNameById = new Map<string, string>();

	const pushToolResult = (part: Record<string, unknown>) => {
		const last = conversation[conversation.length - 1];
		if (last && last.role === 'tool' && Array.isArray(last.content)) {
			(last.content as unknown[]).push(part);
			return;
		}
		conversation.push({ role: 'tool', content: [part] });
	};

	for (const raw of messages) {
		if (!isRecord(raw) || typeof raw.role !== 'string') continue;
		const message = raw as unknown as OpenAiMessage;

		if (message.role === 'system' || message.role === 'developer') {
			const text = contentToText(message.content);
			if (text) system.push(text);
			continue;
		}

		if (message.role === 'tool') {
			const toolCallId = message.tool_call_id ?? '';
			pushToolResult({
				type: 'tool-result',
				toolCallId,
				toolName: toolNameById.get(toolCallId) ?? 'tool',
				output: { type: 'text', value: contentToText(message.content) }
			});
			continue;
		}

		if (message.role === 'assistant') {
			const parts: Array<Record<string, unknown>> = [];
			const text = contentToText(message.content);
			if (text.trim()) parts.push({ type: 'text', text });
			if (Array.isArray(message.tool_calls)) {
				for (const call of message.tool_calls) {
					if (!isRecord(call) || !isRecord(call.function)) continue;
					let input: unknown = {};
					const rawArguments = call.function.arguments;
					if (typeof rawArguments === 'string' && rawArguments.trim()) {
						try {
							input = JSON.parse(rawArguments);
						} catch {
							input = { input: rawArguments };
						}
					} else if (isRecord(rawArguments)) {
						input = rawArguments;
					}
					const toolCallId = typeof call.id === 'string' ? call.id : '';
					const toolName = typeof call.function.name === 'string' ? call.function.name : '';
					toolNameById.set(toolCallId, toolName);
					parts.push({ type: 'tool-call', toolCallId, toolName, input });
				}
			}
			if (!parts.length) continue;
			conversation.push({ role: 'assistant', content: parts });
			continue;
		}

		conversation.push({
			role: 'user',
			content: [{ type: 'text', text: contentToText(message.content) }]
		});
	}

	return { system: system.join('\n\n'), messages: conversation };
}

function normalizeTools(tools: unknown) {
	if (!Array.isArray(tools)) return [];
	return tools.flatMap((tool) => {
		if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) return [];
		const fn = tool.function;
		if (typeof fn.name !== 'string' || !fn.name) return [];
		return [
			{
				name: fn.name,
				description: typeof fn.description === 'string' ? fn.description : '',
				input_schema: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
			}
		];
	});
}

function internalParams(body: OpenAiChatRequest) {
	const { system, messages } = splitMessages(body.messages as unknown[]);
	const params: Record<string, unknown> = {
		model: body.model,
		messages,
		system,
		tools: normalizeTools(body.tools),
		stream: true
	};
	const maxTokens = body.max_completion_tokens ?? body.max_tokens;
	if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) params.max_tokens = Math.max(1, Math.round(maxTokens));
	if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) params.temperature = body.temperature;
	if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) params.top_p = body.top_p;
	if (typeof body.presence_penalty === 'number' && Number.isFinite(body.presence_penalty)) {
		params.presence_penalty = body.presence_penalty;
	}
	if (typeof body.frequency_penalty === 'number' && Number.isFinite(body.frequency_penalty)) {
		params.frequency_penalty = body.frequency_penalty;
	}
	if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none') {
		params.reasoning_effort = body.reasoning_effort;
	}
	if (body.stop !== undefined) params.stop = body.stop;
	if (body.tool_choice !== undefined) params.tool_choice = body.tool_choice;
	return params;
}

export function generationEnvelope(template: Record<string, unknown>, body: OpenAiChatRequest) {
	const envelope = structuredClone(template);
	envelope.params = internalParams(body);
	envelope.permissionMode = 'standard';
	envelope.memory = null;
	envelope.taste = null;
	envelope.skills = null;
	envelope.threadId = randomUUID();
	return envelope;
}

export function mapUsage(value: unknown) {
	if (!isRecord(value)) return undefined;
	const input = Number(value.inputTokens ?? value.input_tokens ?? 0);
	const output = Number(value.outputTokens ?? value.output_tokens ?? 0);
	const cache = Number(
		isRecord(value.inputTokenDetails)
			? value.inputTokenDetails.cacheReadTokens ?? 0
			: value.cache_read_input_tokens ?? 0
	);
	return {
		prompt_tokens: input,
		completion_tokens: output,
		total_tokens: input + output,
		prompt_tokens_details: { cached_tokens: cache }
	};
}

export function mapFinishReason(value: unknown) {
	if (value === 'tool-calls' || value === 'tool_calls') return 'tool_calls';
	if (value === 'length' || value === 'max_tokens') return 'length';
	return 'stop';
}

export async function* internalEvents(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		const decoded = decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
		buffer += decoded;
		let boundary = buffer.indexOf('\n');
		while (boundary !== -1) {
			const line = buffer.slice(0, boundary).trim();
			buffer = buffer.slice(boundary + 1);
			const data = line.startsWith('data:') ? line.slice(5).trimStart() : line;
			if (data && data !== '[DONE]') {
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					// Ignore provider keepalive/non-JSON frames.
				}
			}
			boundary = buffer.indexOf('\n');
		}
		if (done) {
			const data = buffer.trim().replace(/^data:\s*/, '');
			if (data && data !== '[DONE]') {
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					// Ignore an incomplete final frame.
				}
			}
			break;
		}
	}
}

export function eventText(event: Record<string, unknown>) {
	for (const key of ['delta', 'textDelta', 'text', 'content']) {
		if (typeof event[key] === 'string') return event[key] as string;
	}
	return '';
}

export function streamChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) {
	return {
		id,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {})
	};
}
