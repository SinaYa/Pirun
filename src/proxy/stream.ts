/** SSE piping: translate an upstream provider stream into OpenAI chunks. */

import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
	readProviderMappedPath,
	type InferenceProviderResolution
} from '../inference-provider-config.ts';
import { log, setCors } from './http.ts';
import type { RequestTarget } from './shape.ts';

export async function pipeStream(
	response: ServerResponse,
	upstream: Response,
	resolution: InferenceProviderResolution,
	target: RequestTarget
) {
	setCors(response);
	response.statusCode = 200;
	response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	response.setHeader('Cache-Control', 'no-cache, no-transform');
	response.setHeader('Connection', 'keep-alive');
	response.setHeader('X-Accel-Buffering', 'no');
	response.flushHeaders?.();

	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const modelName = target.requested || `${target.providerId}>${target.model}`;

	const emit = (delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) => {
		const chunk: Record<string, unknown> = {
			id,
			object: 'chat.completion.chunk',
			created,
			model: modelName,
			choices: [{ index: 0, delta, finish_reason: finishReason }]
		};
		if (usage) chunk.usage = usage;
		response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	};

	emit({ role: 'assistant', content: '' }, null);

	let finishReason: string | null = null;
	let lastUsage: unknown;
	let sawContent = false;
	let sawToolCall = false;
	let sawReasoning = false;
	let streamError: unknown;

	if (!upstream.body) {
		emit({}, 'stop');
		response.write('data: [DONE]\n\n');
		response.end();
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';

	try {
		for await (const bytes of upstream.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(bytes, { stream: true });
			let cut = buffer.indexOf('\n');
			while (cut !== -1) {
				const line = buffer.slice(0, cut).trim();
				buffer = buffer.slice(cut + 1);
				cut = buffer.indexOf('\n');
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (!payload || payload === '[DONE]') continue;

				let parsed: unknown;
				try {
					parsed = JSON.parse(payload);
				} catch {
					continue;
				}

				// An upstream that fails mid-stream sends an error payload rather than a
				// chunk. Forward it instead of letting the turn end as a silent empty
				// completion, which a harness reads as "the model had nothing to say".
				if (parsed && typeof parsed === 'object' && 'error' in parsed) {
					const upstreamError = (parsed as { error: unknown }).error;
					log('error', `upstream stream error from ${resolution.providerId}`, upstreamError);
					streamError = upstreamError;
					finishReason = 'error';
					response.write(`data: ${JSON.stringify({ error: upstreamError })}\n\n`);
					continue;
				}

				const contentDelta = readProviderMappedPath(
					parsed,
					resolution.responseMapping.content_delta
				);
				const reasoningDelta = readProviderMappedPath(
					parsed,
					resolution.responseMapping.reasoning_delta
				);
				const toolDelta = readProviderMappedPath(
					parsed,
					resolution.responseMapping.tool_calls_delta
				);
				const usage = readProviderMappedPath(parsed, resolution.responseMapping.usage);
				const upstreamFinish = readProviderMappedPath(parsed, '$.choices[0].finish_reason');

				if (usage && typeof usage === 'object') lastUsage = usage;
				if (typeof upstreamFinish === 'string') finishReason = upstreamFinish;

				const delta: Record<string, unknown> = {};
				if (typeof contentDelta === 'string' && contentDelta) {
					delta.content = contentDelta;
					sawContent = true;
				}
				if (typeof reasoningDelta === 'string' && reasoningDelta) {
					delta.reasoning_content = reasoningDelta;
					sawReasoning = true;
				}
				if (Array.isArray(toolDelta) && toolDelta.length) {
					delta.tool_calls = toolDelta;
					sawToolCall = true;
				}
				if (Object.keys(delta).length) emit(delta, null);
			}
		}
	} catch (error) {
		log('error', 'stream interrupted', error instanceof Error ? error.message : String(error));
		response.write(
			`data: ${JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
					type: 'completions_proxy_stream_error'
				}
			})}\n\n`
		);
	}

	if (streamError && !sawContent) {
		log('error', `${resolution.providerLabel} stream produced no content`, streamError);
	}
	if (!sawContent && !sawToolCall && finishReason === 'length') {
		const message =
			`${resolution.providerLabel} hit max_tokens before producing any content` +
			(sawReasoning ? ' — the reasoning trace consumed the whole budget.' : '.');
		log('error', message);
		response.write(
			`data: ${JSON.stringify({ error: { message, type: 'completions_proxy_error', code: 502 } })}

`
		);
	}
	emit({}, finishReason ?? 'stop', lastUsage);
	response.write('data: [DONE]\n\n');
	response.end();
}
