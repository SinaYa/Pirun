import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.ts';

const COMMAND_CODE_VERSION = '1.32.1';
const COMMAND_CODE_UPSTREAM = 'https://api.commandcode.ai';

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
const COMMAND_CODE_BOOTSTRAP_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const COMMAND_CODE_GO_MODELS = [
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

interface OpenAiChatRequest {
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

interface AdapterRun {
	response: Response;
	child: ChildProcess | null;
	transportTemplate: WarmTransportTemplate | null;
	cleanup: () => Promise<void>;
}

interface WarmTransportTemplate {
	apiKeyFingerprint: string;
	headers: Record<string, string>;
	envelope: Record<string, unknown>;
}

interface InternalStreamResult {
	content: string;
	reasoningContent: string;
	toolCalls: Array<Record<string, unknown>>;
	finishReason: string;
	usage?: Record<string, unknown>;
}

type AdapterRunStarter = (
	body: OpenAiChatRequest,
	apiKey: string,
	signal?: AbortSignal
) => Promise<AdapterRun>;

class Semaphore {
	active = 0;
	readonly waiters: Array<() => void> = [];
	readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	async acquire() {
		if (this.active < this.limit) {
			this.active += 1;
			return () => this.release();
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.active += 1;
		return () => this.release();
	}

	release() {
		this.active = Math.max(0, this.active - 1);
		this.waiters.shift()?.();
	}
}

const configuredConcurrency = Number.parseInt(process.env.COMMANDCODE_ADAPTER_CONCURRENCY ?? '', 10);
const semaphore = new Semaphore(
	Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
		? configuredConcurrency
		: DEFAULT_CONCURRENCY
);
let warmTransportTemplate: WarmTransportTemplate | null = null;

class CommandCodeUpstreamError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = 'CommandCodeUpstreamError';
		this.status = status;
	}
}

function apiKeyFingerprint(apiKey: string) {
	return createHash('sha256').update(apiKey).digest('hex');
}

function openAiError(message: string, status: number, code: string, type = 'invalid_request_error') {
	return new Response(JSON.stringify({ error: { message, type, code, param: null } }), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function describeStreamError(event: Record<string, unknown>) {
	const raw = event.error ?? event.message ?? 'Command Code stream failed.';
	if (typeof raw === 'string') return raw;
	if (isRecord(raw) && typeof raw.message === 'string') return raw.message;
	try {
		return JSON.stringify(raw);
	} catch {
		return String(raw);
	}
}

function invalidateWarmTransport(template: WarmTransportTemplate | null) {
	if (template && warmTransportTemplate === template) warmTransportTemplate = null;
}

function configuredRetryCount() {
	const value = Number.parseInt(process.env.COMMANDCODE_ADAPTER_RETRIES ?? '', 10);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_COUNT;
}

function isRetryableError(error: unknown, signal?: AbortSignal) {
	if (signal?.aborted) return false;
	if (error instanceof Error && error.name === 'AbortError') return false;
	const status = (error as { status?: number })?.status;
	if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500;
	const message = error instanceof Error ? error.message : String(error);
	return !/not authenticated|authentication failed|invalid api key|usage limit|does not define model/i.test(message);
}

function streamErrorPayload(error: unknown, signal?: AbortSignal) {
	const originalMessage = error instanceof Error ? error.message : String(error);
	const retryable = isRetryableError(error, signal);
	return {
		error: {
			message: retryable
				? `Retryable upstream server error. Please retry your request. ${originalMessage}`
				: originalMessage,
			type: 'api_error',
			code: retryable ? 'upstream_retryable_error' : 'adapter_stream_error'
		}
	};
}

async function waitBeforeRetry(attempt: number, signal?: AbortSignal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
	const delay = DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
	await new Promise<void>((resolve, reject) => {
		const done = () => {
			signal?.removeEventListener('abort', abort);
			resolve();
		};
		const timeout = setTimeout(done, delay);
		const abort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		timeout.unref?.();
	});
}

async function upstreamResponseError(response: Response) {
	const text = await response.text().catch(() => '');
	let detail = text.trim();
	if (detail) {
		try {
			const parsed = JSON.parse(detail) as unknown;
			if (isRecord(parsed)) {
				const raw = parsed.error ?? parsed.message;
				if (typeof raw === 'string') detail = raw;
				else if (isRecord(raw) && typeof raw.message === 'string') detail = raw.message;
			}
		} catch {
			// Keep a non-JSON upstream body verbatim.
		}
	}
	return new CommandCodeUpstreamError(
		detail
			? `Command Code request failed (${response.status}): ${detail}`
			: `Command Code request failed (${response.status}).`,
		response.status
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeChatRequest(value: unknown): OpenAiChatRequest | null {
	return isRecord(value) ? (value as OpenAiChatRequest) : null;
}

function validateChatRequest(body: OpenAiChatRequest) {
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

function generationEnvelope(template: Record<string, unknown>, body: OpenAiChatRequest) {
	const envelope = structuredClone(template);
	envelope.params = internalParams(body);
	envelope.permissionMode = 'standard';
	envelope.memory = null;
	envelope.taste = null;
	envelope.skills = null;
	envelope.threadId = randomUUID();
	return envelope;
}

async function readNodeRequest(request: IncomingMessage) {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > MAX_REQUEST_BYTES) throw new Error('Command Code bridge request exceeded its size limit.');
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function forwardHeaders(request: IncomingMessage) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined || name.toLowerCase() === 'host' || name.toLowerCase() === 'content-length') continue;
		headers.set(name, Array.isArray(value) ? value.join(', ') : value);
	}
	return headers;
}

async function pipeWebStream(stream: ReadableStream<Uint8Array> | null, response: ServerResponse) {
	if (!stream) return response.end();
	try {
		for await (const chunk of Readable.fromWeb(stream as never)) response.write(chunk);
		response.end();
	} catch (error) {
		response.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

function commandCodeEntryPath() {
	const require = createRequire(import.meta.url);
	const packageJson = require.resolve('command-code/package.json');
	return join(dirname(packageJson), 'dist', 'index.mjs');
}

function installedCommandCodeVersion() {
	const require = createRequire(import.meta.url);
	const packageJson = require('command-code/package.json') as { version?: string };
	return packageJson.version ?? '';
}

async function startWarmAdapterRun(
	template: WarmTransportTemplate,
	body: OpenAiChatRequest,
	signal: AbortSignal | undefined,
	release: () => void,
	upstreamFetch: typeof fetch = fetch
): Promise<AdapterRun> {
	const controller = new AbortController();
	const timeoutMs = Number.parseInt(process.env.COMMANDCODE_ADAPTER_TIMEOUT_MS ?? '', 10) || DEFAULT_REQUEST_TIMEOUT_MS;
	const timeout = setTimeout(() => controller.abort(new Error('Command Code CLI adapter timed out.')), timeoutMs);
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener('abort', abort, { once: true });
	const headers = new Headers(template.headers);
	const envelope = generationEnvelope(template.envelope, body);
	headers.set('x-session-id', String(envelope.threadId));
	let cleanupPromise: Promise<void> | null = null;
	const cleanup = () => {
		cleanupPromise ??= Promise.resolve().then(() => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			controller.abort();
			release();
		});
		return cleanupPromise;
	};
	try {
		const response = await upstreamFetch(`${COMMAND_CODE_UPSTREAM}/alpha/generate`, {
			method: 'POST',
			headers,
			body: JSON.stringify(envelope),
			signal: controller.signal
		});
		return { response, child: null, transportTemplate: template, cleanup };
	} catch (error) {
		invalidateWarmTransport(template);
		await cleanup();
		throw error;
	}
}

async function startAdapterRun(body: OpenAiChatRequest, apiKey: string, signal?: AbortSignal): Promise<AdapterRun> {
	if (installedCommandCodeVersion() !== COMMAND_CODE_VERSION) {
		throw new Error(`Command Code CLI adapter requires command-code@${COMMAND_CODE_VERSION}.`);
	}

	const release = await semaphore.acquire();
	const fingerprint = apiKeyFingerprint(apiKey);
	if (warmTransportTemplate?.apiKeyFingerprint === fingerprint) {
		return startWarmAdapterRun(warmTransportTemplate, body, signal, release);
	}
	const root = await mkdtemp(join(tmpdir(), 'cladgpt-command-code-'));
	let child: ChildProcess | null = null;
	let settled = false;
	let capturedTemplate: WarmTransportTemplate | null = null;
	let resolveGenerate!: (response: Response) => void;
	let rejectGenerate!: (error: Error) => void;
	const generateResponse = new Promise<Response>((resolve, reject) => {
		resolveGenerate = resolve;
		rejectGenerate = reject;
	});

	const server = createServer(async (request, response) => {
		try {
			const requestBody = await readNodeRequest(request);
			const url = new URL(request.url ?? '/', COMMAND_CODE_UPSTREAM);
			let upstreamBody: BodyInit | undefined = requestBody.length ? requestBody : undefined;
			if (url.pathname === '/alpha/generate' && requestBody.length) {
				const parsed = JSON.parse(requestBody.toString('utf8')) as Record<string, unknown>;
				const headers = forwardHeaders(request);
				capturedTemplate = {
					apiKeyFingerprint: fingerprint,
					headers: Object.fromEntries(headers.entries()),
					envelope: structuredClone(parsed)
				};
				warmTransportTemplate = capturedTemplate;
				upstreamBody = JSON.stringify(generationEnvelope(parsed, body));
			}

			const upstream = await fetch(url, {
				method: request.method,
				headers: forwardHeaders(request),
				body: request.method === 'GET' || request.method === 'HEAD' ? undefined : upstreamBody,
				signal
			});
			response.statusCode = upstream.status;
			upstream.headers.forEach((value, name) => {
				if (name.toLowerCase() !== 'content-encoding' && name.toLowerCase() !== 'content-length') {
					response.setHeader(name, value);
				}
			});

			if (url.pathname === '/alpha/generate' && !settled) {
				settled = true;
				if (!upstream.body) {
					const text = await upstream.text();
					resolveGenerate(new Response(text, { status: upstream.status, headers: upstream.headers }));
					response.end(text);
					return;
				}
				const [cliBody, adapterBody] = upstream.body.tee();
				resolveGenerate(new Response(adapterBody, { status: upstream.status, headers: upstream.headers }));
				await pipeWebStream(cliBody, response);
				return;
			}
			await pipeWebStream(upstream.body, response);
		} catch (error) {
			const normalized = error instanceof Error ? error : new Error(String(error));
			invalidateWarmTransport(capturedTemplate);
			if (!settled) rejectGenerate(normalized);
			response.statusCode = 502;
			response.end(JSON.stringify({ error: normalized.message }));
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Command Code bridge did not bind to a TCP port.');

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: root,
		USERPROFILE: root,
		COMMAND_CODE_API_KEY: apiKey,
		COMMANDCODE_SANDBOX: 'true',
		COMMANDCODE_API_URL: `http://127.0.0.1:${address.port}`,
		COMMANDCODE_SKIP_UPDATES: '1',
		DO_NOT_TRACK: '1',
		NO_COLOR: '1',
		CI: '1'
	};
	delete env.COMMANDCODE_API_KEY;

	child = spawn(
		process.execPath,
		[
			commandCodeEntryPath(),
			'-p',
			'Complete the supplied request.',
			'--model',
			COMMAND_CODE_BOOTSTRAP_MODEL,
			'--max-turns',
			'1',
			'--skip-onboarding',
			'--trust'
		],
		{ cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
	);
	let stderr = '';
	child.stderr?.on('data', (chunk) => {
		stderr = `${stderr}${String(chunk)}`.slice(-8_000);
	});
	child.once('error', (error) => {
		if (!settled) rejectGenerate(error);
	});
	child.once('exit', (code) => {
		if (!settled) {
			rejectGenerate(new Error(`Command Code CLI exited before generation (${code ?? 'unknown'}): ${stderr.trim()}`));
		}
	});

	const timeoutMs = Number.parseInt(process.env.COMMANDCODE_ADAPTER_TIMEOUT_MS ?? '', 10) || DEFAULT_REQUEST_TIMEOUT_MS;
	const timeout = setTimeout(() => {
		if (!settled) rejectGenerate(new Error('Command Code CLI adapter timed out before generation started.'));
		child?.kill();
	}, timeoutMs);
	const abort = () => child?.kill();
	signal?.addEventListener('abort', abort, { once: true });

	let cleanupPromise: Promise<void> | null = null;
	const cleanup = () => {
		cleanupPromise ??= (async () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			if (child && child.exitCode === null) child.kill();
			if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true }).catch(() => {});
			release();
		})();
		return cleanupPromise;
	};

	try {
		const response = await generateResponse;
		return { response, child, transportTemplate: capturedTemplate, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

async function startAdapterRunWithRetries(body: OpenAiChatRequest, apiKey: string, signal?: AbortSignal) {
	const retries = configuredRetryCount();
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await startAdapterRun(body, apiKey, signal);
		} catch (error) {
			if (attempt >= retries || !isRetryableError(error, signal)) throw error;
			await waitBeforeRetry(attempt, signal);
		}
	}
}

function mapUsage(value: unknown) {
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

function mapFinishReason(value: unknown) {
	if (value === 'tool-calls' || value === 'tool_calls') return 'tool_calls';
	if (value === 'length' || value === 'max_tokens') return 'length';
	return 'stop';
}

async function* internalEvents(body: ReadableStream<Uint8Array>) {
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

function eventText(event: Record<string, unknown>) {
	for (const key of ['delta', 'textDelta', 'text', 'content']) {
		if (typeof event[key] === 'string') return event[key] as string;
	}
	return '';
}

function streamChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) {
	return {
		id,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {})
	};
}

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
	setWarmTransportTemplate(template: WarmTransportTemplate | null) {
		warmTransportTemplate = template;
	},
	getWarmTransportTemplate() {
		return warmTransportTemplate;
	}
};
