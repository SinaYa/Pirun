/**
 * OpenAI-compatible adapter over the Command Code CLI. This file holds the
 * response assembly and endpoint surface; the CLI bridge and protocol
 * translation live in src/command-code/.
 */

import { randomUUID } from 'node:crypto';
import {
	COMMAND_CODE_GO_MODELS,
	describeStreamError,
	eventText,
	internalEvents,
	mapFinishReason,
	mapUsage,
	normalizeChatRequest,
	openAiError,
	streamChunk,
	validateChatRequest,
	type InternalStreamResult,
	type OpenAiChatRequest
} from './command-code/protocol.ts';
import {
	CommandCodeUpstreamError,
	configuredRetryCount,
	getWarmTransportTemplate,
	invalidateWarmTransport,
	isRetryableError,
	setWarmTransportTemplate,
	startAdapterRun,
	startAdapterRunWithRetries,
	startWarmAdapterRun,
	streamErrorPayload,
	upstreamResponseError,
	waitBeforeRetry,
	type AdapterRun,
	type AdapterRunStarter
} from './command-code/run.ts';

function openAiStream(
	initialRun: AdapterRun,
	body: OpenAiChatRequest,
	apiKey: string,
	signal: AbortSignal,
	model: string,
	startRun: AdapterRunStarter = startAdapterRun
) {
	const id = `chatcmpl-${randomUUID()}`;
	const encoder = new TextEncoder();
	let activeRun: AdapterRun | null = initialRun;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let roleSent = false;
			const retries = configuredRetryCount();
			try {
			for (let attempt = 0; attempt <= retries; attempt += 1) {
				let emitted = false;
				let run: AdapterRun | null = null;
				try {
					run = attempt === 0 ? initialRun : await startRun(body, apiKey, signal);
					activeRun = run;
					if (!run.response.ok || !run.response.body) throw await upstreamResponseError(run.response);
					for await (const event of internalEvents(run.response.body)) {
						const type = String(event.type ?? '');
						if (type === 'error') throw new CommandCodeUpstreamError(describeStreamError(event));
						let delta: Record<string, unknown> | null = null;
						if (type === 'text-delta' || type === 'text_delta') delta = { content: eventText(event) };
						if (type === 'reasoning-delta' || type === 'reasoning_delta') {
							delta = { reasoning_content: eventText(event) };
						}
						if (type === 'tool-call' || type === 'tool_call') {
							delta = {
								tool_calls: [
									{
										index: 0,
										id: event.toolCallId,
										type: 'function',
										function: {
											name: event.toolName,
											arguments: JSON.stringify(event.input ?? {})
										}
									}
								]
							};
						}
						if (delta) {
							if (!roleSent) {
								delta = { role: 'assistant', ...delta };
								roleSent = true;
							}
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(streamChunk(id, model, delta, null))}\n\n`));
							emitted = true;
						}
						if (type === 'finish') {
							const usage = mapUsage(event.totalUsage ?? event.usage);
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify(streamChunk(id, model, {}, mapFinishReason(event.finishReason ?? event.rawFinishReason), usage))}\n\n`
								)
							);
							emitted = true;
						}
					}
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					return;
				} catch (error) {
					invalidateWarmTransport(run?.transportTemplate ?? null);
					if (!emitted && attempt < retries && isRetryableError(error, signal)) {
						await run?.cleanup();
						await waitBeforeRetry(attempt, signal);
						continue;
					}
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify(streamErrorPayload(error, signal))}\n\n`
						)
					);
					return;
				} finally {
					if (activeRun === run) activeRun = null;
					await run?.cleanup();
				}
			}
			} finally {
				controller.close();
			}
		},
		async cancel() {
			await activeRun?.cleanup();
		}
	});
}

async function collectInternalResponse(run: AdapterRun): Promise<InternalStreamResult> {
	if (!run.response.ok || !run.response.body) {
		throw await upstreamResponseError(run.response);
	}
	const result: InternalStreamResult = {
		content: '',
		reasoningContent: '',
		toolCalls: [],
		finishReason: 'stop'
	};
	for await (const event of internalEvents(run.response.body)) {
		const type = String(event.type ?? '');
		if (type === 'text-delta' || type === 'text_delta') result.content += eventText(event);
		if (type === 'reasoning-delta' || type === 'reasoning_delta') result.reasoningContent += eventText(event);
		if (type === 'tool-call' || type === 'tool_call') {
			result.toolCalls.push({
				id: event.toolCallId,
				type: 'function',
				function: { name: event.toolName, arguments: JSON.stringify(event.input ?? {}) }
			});
		}
		if (type === 'finish') {
			result.finishReason = mapFinishReason(event.finishReason ?? event.rawFinishReason);
			result.usage = mapUsage(event.totalUsage ?? event.usage);
		}
		if (type === 'error') throw new Error(describeStreamError(event));
	}
	return result;
}

async function collectInternalResponseWithRetries(
	initialRun: AdapterRun,
	body: OpenAiChatRequest,
	apiKey: string,
	signal?: AbortSignal,
	startRun: AdapterRunStarter = startAdapterRun
) {
	const retries = configuredRetryCount();
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		let run: AdapterRun | null = null;
		try {
			run = attempt === 0 ? initialRun : await startRun(body, apiKey, signal);
			return await collectInternalResponse(run);
		} catch (error) {
			invalidateWarmTransport(run?.transportTemplate ?? null);
			if (attempt >= retries || !isRetryableError(error, signal)) throw error;
			await run?.cleanup();
			await waitBeforeRetry(attempt, signal);
		} finally {
			await run?.cleanup();
		}
	}
	throw new Error('Command Code request exhausted its retry attempts.');
}

async function chatCompletions(request: Request, apiKey: string) {
	const body = normalizeChatRequest(await request.json().catch(() => null));
	if (!body) return openAiError('Request body must be JSON.', 400, 'invalid_json');
	const validationError = validateChatRequest(body);
	if (validationError) return openAiError(validationError, 400, 'invalid_request');
	const model = String(body.model);

	try {
		const run = await startAdapterRunWithRetries(body, apiKey, request.signal);
		if (body.stream === true) {
			return new Response(openAiStream(run, body, apiKey, request.signal, model), {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive'
				}
			});
		}
		const result = await collectInternalResponseWithRetries(run, body, apiKey, request.signal);
		return new Response(
				JSON.stringify({
					id: `chatcmpl-${randomUUID()}`,
					object: 'chat.completion',
					created: Math.floor(Date.now() / 1000),
					model,
					choices: [
						{
							index: 0,
							message: {
								role: 'assistant',
								content: result.content,
								...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
								...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {})
							},
							finish_reason: result.finishReason
						}
					],
					usage: result.usage
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/not authenticated|authentication failed/i.test(message)) return openAiError(message, 401, 'authentication_error', 'authentication_error');
		if (/rate limit|usage limit/i.test(message)) return openAiError(message, 429, 'rate_limit_exceeded', 'rate_limit_error');
		if (/timed out/i.test(message)) return openAiError(message, 504, 'timeout', 'timeout_error');
		return openAiError(message, 502, 'adapter_error', 'api_error');
	}
}

function apiKeyFromRequest(request: Request) {
	const authorization = request.headers.get('authorization') ?? '';
	return authorization.replace(/^Bearer\s+/i, '').trim();
}

export function isCommandCodeCliAdapterUrl(input: string) {
	return input.startsWith('command-code-cli://');
}

export async function commandCodeCliAdapterRequest(input: string, init: RequestInit = {}) {
	const url = new URL(input);
	const request = new Request(`http://command-code-cli.local${url.pathname}${url.search}`, init);
	const apiKey = apiKeyFromRequest(request);
	if (!apiKey) return openAiError('Missing Command Code API key.', 401, 'authentication_error', 'authentication_error');
	if (request.method === 'GET' && url.pathname === '/v1/models') {
		return new Response(
			JSON.stringify({
				object: 'list',
				data: COMMAND_CODE_GO_MODELS.map((model) => ({
					id: model,
					object: 'model',
					created: 0,
					owned_by: 'command-code'
				}))
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		);
	}
	if (request.method === 'POST' && url.pathname === '/v1/chat/completions') return chatCompletions(request, apiKey);
	return openAiError(`Unsupported Command Code CLI adapter endpoint: ${request.method} ${url.pathname}`, 404, 'not_found');
}

export const __commandCodeAdapterTest = {
	collectInternalResponseWithRetries,
	openAiStream,
	streamErrorPayload,
	startWarmAdapterRun,
	setWarmTransportTemplate,
	getWarmTransportTemplate
};
