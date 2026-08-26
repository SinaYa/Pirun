/** Request-target parsing and value shaping for the proxy's OpenAI surface. */

import type { ProxySettings } from '../settings.ts';
import {
	listInferenceProviderIds,
	type InferenceProviderResolution
} from '../inference-provider-config.ts';

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

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function definedOnly(values: Record<string, unknown>) {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== null) result[key] = value;
	}
	return result;
}

export function buildRequestValues(body: Record<string, unknown>, stream: boolean) {
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

export function textFromApiContent(value: unknown): string {
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

export function routeSummary(resolution: InferenceProviderResolution) {
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
