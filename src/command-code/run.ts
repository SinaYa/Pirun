/** Starting Command Code adapter runs: CLI bootstrap bridge, warm reuse, retries. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../timeouts.ts';
import {
	configuredRetryCount,
	isRetryableError,
	waitBeforeRetry
} from "./retry.ts";
export {
	CommandCodeUpstreamError,
	configuredRetryCount,
	isRetryableError,
	streamErrorPayload,
	upstreamResponseError,
	waitBeforeRetry
} from "./retry.ts";
import {
	COMMAND_CODE_BOOTSTRAP_MODEL,
	generationEnvelope,
	type OpenAiChatRequest
} from './protocol.ts';

export const COMMAND_CODE_VERSION = '1.32.1';
const COMMAND_CODE_UPSTREAM = 'https://api.commandcode.ai';
const DEFAULT_CONCURRENCY = 2;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export interface AdapterRun {
	response: Response;
	child: ChildProcess | null;
	transportTemplate: WarmTransportTemplate | null;
	cleanup: () => Promise<void>;
}

export interface WarmTransportTemplate {
	apiKeyFingerprint: string;
	headers: Record<string, string>;
	envelope: Record<string, unknown>;
}

export type AdapterRunStarter = (
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

function apiKeyFingerprint(apiKey: string) {
	return createHash('sha256').update(apiKey).digest('hex');
}

export function setWarmTransportTemplate(template: WarmTransportTemplate | null) {
	warmTransportTemplate = template;
}

export function getWarmTransportTemplate() {
	return warmTransportTemplate;
}

export function invalidateWarmTransport(template: WarmTransportTemplate | null) {
	if (template && warmTransportTemplate === template) warmTransportTemplate = null;
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

export async function startWarmAdapterRun(
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

export async function startAdapterRun(body: OpenAiChatRequest, apiKey: string, signal?: AbortSignal): Promise<AdapterRun> {
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

export async function startAdapterRunWithRetries(body: OpenAiChatRequest, apiKey: string, signal?: AbortSignal) {
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
