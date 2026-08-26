import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { envSnapshot, loadEnvFile, refreshEnvFile } from './env.ts';
import { loadSettings, type ProxySettings } from './settings.ts';
import { CONFIG_DIR, ENV_FILE, PROJECT_DIR } from './paths.ts';
import { providerFetchWithSingle500Retry } from './provider-fetch.ts';
import {
	getInferenceProvider,
	listInferenceProviderIds,
	readProviderMappedPath,
	refreshCascadedInferenceRouting,
	resolveInferenceProviderRequest,
	type CascadedInferenceRoutingSnapshot,
	type InferenceProviderResolution
} from './inference-provider-config.ts';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

const settings = loadSettings();
const envInfo = loadEnvFile();
// Prime the change-detection signature so the first request does not report a
// reload it did not perform.
refreshEnvFile();

let routingSnapshot: CascadedInferenceRoutingSnapshot | undefined;

const LOG_ORDER = { silent: 0, error: 1, info: 2, debug: 3 } as const;

function log(level: 'error' | 'info' | 'debug', message: string, extra?: unknown) {
	if (LOG_ORDER[settings.logLevel] < LOG_ORDER[level]) return;
	const stamp = new Date().toISOString();
	const line = `[${stamp}] ${level.padEnd(5)} ${message}`;
	if (extra === undefined) console.log(line);
	else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

/* -------------------------------------------------------------------------- */
/* request helpers                                                            */
/* -------------------------------------------------------------------------- */

function readBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new Error('Request body too large.'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

function setCors(response: ServerResponse) {
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Access-Control-Allow-Headers', '*');
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
	const body = JSON.stringify(payload, null, 2);
	setCors(response);
	response.statusCode = status;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.setHeader('Content-Length', Buffer.byteLength(body));
	response.end(body);
}

function sendError(response: ServerResponse, status: number, message: string, details?: unknown) {
	log('error', `${status} ${message}`, details);
	sendJson(response, status, {
		error: { message, type: 'completions_proxy_error', code: status, details }
	});
}

function authorized(request: IncomingMessage) {
	if (!settings.apiKey) return true;
	const header = request.headers.authorization ?? '';
	const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header.trim();
	return token === settings.apiKey;
}

/* -------------------------------------------------------------------------- */
/* model naming                                                               */
/* -------------------------------------------------------------------------- */

export interface RequestTarget {
	providerId: string;
	model: string;
	requested: string;
}

/**
 * Accepted `model` spellings:
 *   provider>model@variant   explicit provider, explicit variant
 *   provider>model           explicit provider, default variant
 *   provider.model[@variant] `.` alias — shell-safe, for CLI harnesses
 *   provider:model[@variant] `:` alias
 *   model[@variant]          default_provider from proxy.cfg
 *
 * `>` is unambiguous so it always wins. `.` and `:` only split when the left
 * side names a provider this proxy actually knows, which keeps model ids that
 * contain those characters (`deepseek-v3.2`, `llama3.1:8b`) intact.
 */
export function parseRequestTarget(rawModel: unknown, config: ProxySettings): RequestTarget {
	const requested = typeof rawModel === 'string' ? rawModel.trim() : '';
	if (!requested) {
		return { providerId: config.defaultProvider, model: config.defaultModel, requested: '' };
	}

	const arrow = requested.indexOf('>');
	if (arrow > 0) {
		return {
			providerId: requested.slice(0, arrow).trim(),
			model: requested.slice(arrow + 1).trim() || config.defaultModel,
			requested
		};
	}

	for (const separator of ['.', ':']) {
		const at = requested.indexOf(separator);
		if (at <= 0) continue;
		const maybeProvider = requested.slice(0, at).trim();
		if (!listInferenceProviderIds().includes(maybeProvider)) continue;
		return {
			providerId: maybeProvider,
			model: requested.slice(at + 1).trim() || config.defaultModel,
			requested
		};
	}

	return { providerId: config.defaultProvider, model: requested, requested };
}

/* -------------------------------------------------------------------------- */
/* value building                                                             */
/* -------------------------------------------------------------------------- */

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function definedOnly(values: Record<string, unknown>) {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== null) result[key] = value;
	}
	return result;
}

function buildRequestValues(body: Record<string, unknown>, stream: boolean) {
	const reasoning = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
	return definedOnly({
		messages: body.messages,
		stream,
		temperature: body.temperature,
		top_p: body.top_p,
		max_tokens: body.max_tokens ?? body.max_completion_tokens,
		presence_penalty: body.presence_penalty,
		frequency_penalty: body.frequency_penalty,
		response_format: body.response_format,
		reasoning_effort: reasoning && REASONING_EFFORTS.includes(reasoning) ? reasoning : undefined,
		tools: Array.isArray(body.tools) && body.tools.length ? body.tools : undefined,
		tool_choice: body.tool_choice,
		parallel_tool_calls: body.parallel_tool_calls,
		stop: body.stop,
		seed: body.seed,
		n: body.n
	});
}

/* -------------------------------------------------------------------------- */
/* response shaping                                                           */
/* -------------------------------------------------------------------------- */

function textFromApiContent(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === 'string') return part;
				if (part && typeof part === 'object') {
					const text = (part as Record<string, unknown>).text;
					if (typeof text === 'string') return text;
				}
				return '';
			})
			.join('');
	}
	return '';
}

function routeSummary(resolution: InferenceProviderResolution) {
	return {
		requested_provider: resolution.originalProviderId,
		requested_model: resolution.originalModel,
		provider: resolution.providerId,
		provider_label: resolution.providerLabel,
		model: resolution.modelId,
		variant: resolution.variantId,
		provider_model: resolution.providerModel,
		interface_mapping: resolution.mappingName,
		endpoint: resolution.chatEndpoint,
		override: resolution.override ?? null
	};
}

/* -------------------------------------------------------------------------- */
/* upstream call                                                              */
/* -------------------------------------------------------------------------- */

async function resolveAndCall(input: {
	target: RequestTarget;
	values: Record<string, unknown>;
	signal: AbortSignal;
}) {
	if (settings.hotReloadRouting || !routingSnapshot) {
		const refreshed = await refreshCascadedInferenceRouting();
		routingSnapshot = refreshed.snapshot;
		if (refreshed.error) log('error', `routing rules problem: ${refreshed.error}`);
	}

	const resolution = resolveInferenceProviderRequest({
		providerId: input.target.providerId,
		model: input.target.model,
		values: input.values,
		routingSnapshot
	});

	// An edited .env should reach the very next request. Without this a stale key
	// in a long-running process is indistinguishable from a key never updated.
	if (refreshEnvFile()) log('info', 'reloaded .env — a key changed on disk');

	const apiKey = (process.env[resolution.apiKeyEnv] ?? '').trim();
	if (!apiKey) {
		const error = new Error(
			`Missing ${resolution.apiKeyEnv} in ${ENV_FILE} (needed by provider "${resolution.providerId}").`
		);
		(error as Error & { status?: number }).status = 500;
		throw error;
	}

	log('debug', 'routing', routeSummary(resolution));
	log('debug', 'upstream body', resolution.requestBody);

	const upstream = await providerFetchWithSingle500Retry(
		resolution.chatEndpoint,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(resolution.requestBody),
			signal: input.signal
		},
		{ retryDelayMs: 250 }
	);

	return { resolution, upstream };
}

/* -------------------------------------------------------------------------- */
/* chat completions                                                           */
/* -------------------------------------------------------------------------- */

async function handleChatCompletions(
	request: IncomingMessage,
	response: ServerResponse,
	body: Record<string, unknown>
) {
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		sendError(response, 400, '"messages" must be a non-empty array.');
		return;
	}

	const target = parseRequestTarget(body.model, settings);
	const stream = body.stream === true;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
	request.on('close', () => controller.abort());

	try {
		const { resolution, upstream } = await resolveAndCall({
			target,
			values: buildRequestValues(body, stream),
			signal: controller.signal
		});

		log(
			'info',
			`chat ${target.requested || '(default)'} -> ${resolution.providerId}>${resolution.modelId}@${resolution.variantId}` +
				`${resolution.override ? ' (routed)' : ''}${stream ? ' [stream]' : ''}`
		);

		if (!upstream.ok) {
			const text = await upstream.text();
			sendError(
				response,
				upstream.status,
				`${resolution.providerLabel} request failed (${upstream.status}).`,
				text.slice(0, 4000)
			);
			return;
		}

		if (stream) {
			await pipeStream(response, upstream, resolution, target);
			return;
		}

		const data = (await upstream.json()) as unknown;
		const content = textFromApiContent(
			readProviderMappedPath(data, resolution.responseMapping.content)
		);
		const reasoning = readProviderMappedPath(data, resolution.responseMapping.reasoning_content);
		const toolCalls = readProviderMappedPath(data, resolution.responseMapping.tool_calls);
		const usage = readProviderMappedPath(data, resolution.responseMapping.usage);
		const finish = readProviderMappedPath(data, resolution.responseMapping.finish_reason);

		// A reasoning model can spend its entire max_tokens budget thinking and
		// return nothing at all. `finish_reason: length` with empty content says
		// exactly that, and an empty answer is never useful to a caller — so say
		// what happened instead of handing back a blank turn.
		if (
			!content &&
			finish === 'length' &&
			!(Array.isArray(toolCalls) && toolCalls.length)
		) {
			const reasoned = typeof reasoning === 'string' && reasoning.length > 0;
			sendError(
				response,
				502,
				`${resolution.providerLabel} hit max_tokens before producing any content` +
					(reasoned ? ' — the reasoning trace consumed the whole budget.' : '.'),
				`Raise max_tokens (this request used ${String(
					(usage as Record<string, unknown> | undefined)?.completion_tokens ?? '?'
				)}), or pick a model that reasons less.`
			);
			return;
		}

		const message: Record<string, unknown> = { role: 'assistant', content };
		if (typeof reasoning === 'string' && reasoning) message.reasoning_content = reasoning;
		if (Array.isArray(toolCalls) && toolCalls.length) message.tool_calls = toolCalls;

		sendJson(response, 200, {
			id: `chatcmpl-${randomUUID()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: target.requested || `${target.providerId}>${target.model}`,
			choices: [
				{
					index: 0,
					message,
					finish_reason:
						typeof finish === 'string'
							? finish
							: message.tool_calls
								? 'tool_calls'
								: 'stop'
				}
			],
			usage: usage && typeof usage === 'object' ? usage : undefined,
			x_completions_proxy: routeSummary(resolution)
		});
	} catch (error) {
		handleThrown(response, error);
	} finally {
		clearTimeout(timeout);
	}
}

async function pipeStream(
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

/* -------------------------------------------------------------------------- */
/* legacy text completions                                                    */
/* -------------------------------------------------------------------------- */

async function handleTextCompletions(
	request: IncomingMessage,
	response: ServerResponse,
	body: Record<string, unknown>
) {
	const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt;
	if (typeof prompt !== 'string' || !prompt) {
		sendError(response, 400, '"prompt" must be a non-empty string.');
		return;
	}
	if (body.stream === true) {
		sendError(response, 400, 'Streaming is only supported on /v1/chat/completions.');
		return;
	}

	const target = parseRequestTarget(body.model, settings);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
	request.on('close', () => controller.abort());

	try {
		const { resolution, upstream } = await resolveAndCall({
			target,
			values: buildRequestValues(
				{ ...body, messages: [{ role: 'user', content: prompt }] },
				false
			),
			signal: controller.signal
		});

		log(
			'info',
			`completion ${target.requested || '(default)'} -> ${resolution.providerId}>${resolution.modelId}@${resolution.variantId}`
		);

		if (!upstream.ok) {
			const text = await upstream.text();
			sendError(
				response,
				upstream.status,
				`${resolution.providerLabel} request failed (${upstream.status}).`,
				text.slice(0, 4000)
			);
			return;
		}

		const data = (await upstream.json()) as unknown;
		const text = textFromApiContent(
			readProviderMappedPath(data, resolution.responseMapping.content)
		);
		const usage = readProviderMappedPath(data, resolution.responseMapping.usage);

		sendJson(response, 200, {
			id: `cmpl-${randomUUID()}`,
			object: 'text_completion',
			created: Math.floor(Date.now() / 1000),
			model: target.requested || `${target.providerId}>${target.model}`,
			choices: [{ index: 0, text, logprobs: null, finish_reason: 'stop' }],
			usage: usage && typeof usage === 'object' ? usage : undefined,
			x_completions_proxy: routeSummary(resolution)
		});
	} catch (error) {
		handleThrown(response, error);
	} finally {
		clearTimeout(timeout);
	}
}

/* -------------------------------------------------------------------------- */
/* catalogue + diagnostics                                                    */
/* -------------------------------------------------------------------------- */

function listModels() {
	const created = Math.floor(Date.now() / 1000);
	const data: Array<Record<string, unknown>> = [];
	for (const providerId of listInferenceProviderIds()) {
		const provider = getInferenceProvider(providerId);
		if (!provider) continue;
		for (const reference of provider.modelReferences) {
			data.push({
				id: `${providerId}>${reference.id}`,
				object: 'model',
				created,
				owned_by: providerId,
				provider: providerId,
				provider_label: provider.label,
				provider_model: reference.providerModel
			});
		}
	}
	return { object: 'list', data };
}

async function handleRouting(response: ServerResponse, url: URL) {
	const target = parseRequestTarget(url.searchParams.get('model') ?? '', settings);
	const providerParam = url.searchParams.get('provider');
	if (providerParam) target.providerId = providerParam;

	try {
		const refreshed = await refreshCascadedInferenceRouting();
		routingSnapshot = refreshed.snapshot;
		const resolution = resolveInferenceProviderRequest({
			providerId: target.providerId,
			model: target.model,
			values: { messages: [] },
			routingSnapshot
		});
		sendJson(response, 200, {
			asked: { provider: target.providerId, model: target.model },
			resolved: routeSummary(resolution),
			rules: {
				source: refreshed.snapshot.sourcePath,
				groups_source: refreshed.snapshot.groupSourcePath,
				rule_count: refreshed.snapshot.ruleCount,
				group_count: refreshed.snapshot.groupCount,
				loaded_at: refreshed.snapshot.loadedAt,
				error: refreshed.error ?? null
			},
			upstream_body_preview: resolution.requestBody
		});
	} catch (error) {
		handleThrown(response, error);
	}
}

function handleThrown(response: ServerResponse, error: unknown) {
	if (error instanceof Error && error.name === 'AbortError') {
		sendError(response, 504, 'Upstream request timed out or the client disconnected.');
		return;
	}
	const status = (error as { status?: number })?.status ?? 502;
	sendError(response, status, error instanceof Error ? error.message : String(error));
}

/* -------------------------------------------------------------------------- */
/* router                                                                     */
/* -------------------------------------------------------------------------- */

function normalizePath(pathname: string) {
	const trimmed = pathname.replace(/\/+$/, '') || '/';
	return trimmed.startsWith('/v1/') ? trimmed.slice(3) : trimmed;
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
	const path = normalizePath(url.pathname);

	if (request.method === 'OPTIONS') {
		setCors(response);
		response.statusCode = 204;
		response.end();
		return;
	}

	if (path === '/health' || path === '/') {
		sendJson(response, 200, {
			status: 'ok',
			service: 'completions-proxy',
			port: settings.port,
			default_provider: settings.defaultProvider,
			default_model: settings.defaultModel,
			config_dir: CONFIG_DIR,
			cfg: settings.sourcePath,
			env_file_loaded: envInfo.loaded,
			env_keys: envInfo.keys,
			// Fingerprints, never values: enough to tell a running process's key
			// from the one on disk, which is the whole question when a rotated
			// key appears not to have taken.
			env_key_details: envSnapshot().details,
			env_loaded_at: envSnapshot().loadedAt,
			auth_required: Boolean(settings.apiKey)
		});
		return;
	}

	if (!authorized(request)) {
		sendError(response, 401, 'Invalid or missing Authorization bearer token.');
		return;
	}

	if (request.method === 'GET' && path === '/models') {
		sendJson(response, 200, listModels());
		return;
	}

	if (request.method === 'GET' && path === '/routing') {
		if (!settings.exposeRoutingEndpoint) {
			sendError(response, 404, 'Routing endpoint is disabled in proxy.cfg.');
			return;
		}
		await handleRouting(response, url);
		return;
	}

	// Lets a supervisor (pirun) stop a proxy it did not start. Localhost-bound by
	// default, and behind the bearer token whenever one is configured.
	if (request.method === 'POST' && path === '/shutdown') {
		sendJson(response, 200, { status: 'stopping' });
		log('info', 'shutdown requested');
		setTimeout(() => {
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 1000).unref();
		}, 50);
		return;
	}

	if (request.method !== 'POST') {
		sendError(response, 404, `No route for ${request.method} ${url.pathname}.`);
		return;
	}

	let body: Record<string, unknown>;
	try {
		const raw = await readBody(request);
		body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
	} catch (error) {
		sendError(response, 400, 'Request body must be valid JSON.', String(error));
		return;
	}

	if (path === '/chat/completions') {
		await handleChatCompletions(request, response, body);
		return;
	}
	if (path === '/completions') {
		await handleTextCompletions(request, response, body);
		return;
	}

	sendError(response, 404, `No route for ${request.method} ${url.pathname}.`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 75_000;

server.listen(settings.port, settings.host, async () => {
	const refreshed = await refreshCascadedInferenceRouting();
	routingSnapshot = refreshed.snapshot;
	console.log('completions-proxy');
	console.log(`  root      ${PROJECT_DIR}`);
	console.log(`  listening http://${settings.host}:${settings.port}`);
	console.log(`  base url  http://${settings.host}:${settings.port}/v1`);
	console.log(`  config    ${settings.sourcePath}`);
	console.log(`  routing   ${refreshed.snapshot.sourcePath} (${refreshed.snapshot.ruleCount} rules, ${refreshed.snapshot.groupCount} groups)`);
	if (refreshed.error) console.log(`  routing!  ${refreshed.error}`);
	console.log(`  env       ${envInfo.loaded ? `${envInfo.count} keys from ${ENV_FILE}` : 'no .env found'}`);
	console.log(`  default   ${settings.defaultProvider}>${settings.defaultModel}`);
	console.log(`  auth      ${settings.apiKey ? 'bearer token required' : 'open (no api_key set)'}`);
});

server.on('error', (error) => {
	console.error(`completions-proxy failed to start: ${error.message}`);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref();
	});
}
