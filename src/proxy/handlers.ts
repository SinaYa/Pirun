/** The proxy's completion handlers: routing refresh, upstream call, streaming. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { refreshEnvFile } from '../env.ts';
import { ENV_FILE } from '../paths.ts';
import { providerFetchWithSingle500Retry } from '../provider-fetch.ts';
import {
	getInferenceProvider,
	listInferenceProviderIds,
	readProviderMappedPath,
	refreshCascadedInferenceRouting,
	resolveInferenceProviderRequest,
	type CascadedInferenceRoutingSnapshot
} from '../inference-provider-config.ts';
import { handleThrown, log, sendError, sendJson, settings } from './http.ts';
import { buildRequestValues, parseRequestTarget, routeSummary, textFromApiContent, type RequestTarget } from './shape.ts';
import { pipeStream } from './stream.ts';

let routingSnapshot: CascadedInferenceRoutingSnapshot | undefined;

/** Refresh the routing snapshot; used at startup and per request when hot reload is on. */
export async function primeRouting() {
	const refreshed = await refreshCascadedInferenceRouting();
	routingSnapshot = refreshed.snapshot;
	return refreshed;
}

async function resolveAndCall(input: {
	target: RequestTarget;
	values: Record<string, unknown>;
	signal: AbortSignal;
}) {
	if (settings.hotReloadRouting || !routingSnapshot) {
		const refreshed = await primeRouting();
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

export async function handleChatCompletions(
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

export async function handleTextCompletions(
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

export function listModels() {
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

export async function handleRouting(response: ServerResponse, url: URL) {
	const target = parseRequestTarget(url.searchParams.get('model') ?? '', settings);
	const providerParam = url.searchParams.get('provider');
	if (providerParam) target.providerId = providerParam;

	try {
		const refreshed = await primeRouting();
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
