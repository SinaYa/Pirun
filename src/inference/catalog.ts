/** The static provider/model catalogue and model scores, loaded from config/. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { CONFIG_DIR } from '../paths.ts';
import { modelIdentity, type InferenceModelScores, type InferenceProviderSummary, type ModelRef, type ProviderConfigRoot, type ProviderModelVariantConfig } from './types.ts';
import { normalizePreference, parseOverrideRef } from './rules-parser.ts';

const baseInterfaceYaml = readFileSync(resolve(CONFIG_DIR, 'base-ai-request-interface.yaml'), 'utf8');
const modelScoresYaml = readFileSync(resolve(CONFIG_DIR, 'inference-model-scores.yaml'), 'utf8');
const providerConfigYaml = readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8');

const baseInterface = YAML.parse(baseInterfaceYaml) as {
	settings?: Record<string, { default?: unknown }>;
	model_defaults?: Record<string, Record<string, unknown>>;
};
export const providerConfig = YAML.parse(providerConfigYaml) as ProviderConfigRoot;

export function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

export function joinUrl(baseUrl: string, endpoint: string) {
	const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	return `${normalizeBaseUrl(baseUrl)}${normalizedEndpoint}`;
}

export function hasConfiguredVariant(providerId: string, modelId: string, variantId: string) {
	return Boolean(providerConfig.providers?.[providerId]?.models?.[modelId]?.variants?.[variantId]);
}

export function providerHasModel(providerId: string, modelId: string) {
	return Boolean(providerConfig.providers?.[providerId]?.models?.[modelId]);
}

export function isDefaultVariant(candidate: ModelRef) {
	return providerConfig.providers?.[candidate.providerId]?.models?.[candidate.modelId]?.default_variant === candidate.variantId;
}

export function allProviderModelCandidates(original: ModelRef) {
	const candidates: ModelRef[] = [];
	const providerEntries = Object.entries(providerConfig.providers ?? {}).sort(([a], [b]) => {
		if (a === original.providerId) return -1;
		if (b === original.providerId) return 1;
		return a.localeCompare(b);
	});
	for (const [providerId, provider] of providerEntries) {
		for (const [modelId, modelConfig] of Object.entries(provider.models ?? {})) {
			const variantIds = [
				modelConfig.default_variant,
				...Object.keys(modelConfig.variants ?? {}).filter((variantId) => variantId !== modelConfig.default_variant)
			].filter(Boolean);
			for (const variantId of variantIds) {
				candidates.push({
					providerId,
					modelId,
					variantId,
					providerWildcard: false,
					modelWildcard: false,
					variantWildcard: false,
					variantSpecified: true,
					raw: `${providerId}>${modelId}@${variantId}`
				});
			}
		}
	}
	return candidates;
}

function parseInferenceModelScores(text: string): InferenceModelScores {
	const parsed = YAML.parse(text) as {
		dimensions?: Record<string, { description?: string; min?: number; max?: number }>;
		default_preference?: Record<string, number>;
		scores?: Record<string, Record<string, number>>;
	};

	const dimensions: InferenceModelScores['dimensions'] = new Map();
	for (const [name, definition] of Object.entries(parsed?.dimensions ?? {})) {
		const min = Number(definition.min ?? 1);
		const max = Number(definition.max ?? 1000);
		if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
			throw new Error(`Inference model score dimension "${name}" must define a valid min/max range.`);
		}
		dimensions.set(name, {
			description: definition.description,
			min,
			max
		});
	}
	if (!dimensions.size) throw new Error('Inference model scores must define at least one scoring dimension.');

	const scores: InferenceModelScores['scores'] = new Map();
	for (const [identity, values] of Object.entries(parsed?.scores ?? {})) {
		const ref = parseOverrideRef(identity, 0, 'selector');
		if (ref.providerWildcard || ref.modelWildcard || !ref.variantSpecified || ref.variantWildcard) {
			throw new Error(`Inference model score "${identity}" must use a concrete provider>model@variant identity.`);
		}
		if (!hasConfiguredVariant(ref.providerId, ref.modelId, ref.variantId)) {
			throw new Error(`Inference model score "${identity}" does not match a configured provider/model/variant.`);
		}

		const scoreValues: Map<string, number> = new Map();
		for (const [dimension, score] of Object.entries(values ?? {})) {
			const definition = dimensions.get(dimension);
			if (!definition) throw new Error(`Inference model score "${identity}" uses unknown dimension "${dimension}".`);
			const numericScore = Number(score);
			if (!Number.isFinite(numericScore) || numericScore < definition.min || numericScore > definition.max) {
				throw new Error(
					`Inference model score "${identity}" dimension "${dimension}" must be between ${definition.min} and ${definition.max}.`
				);
			}
			scoreValues.set(dimension, numericScore);
		}
		scores.set(identity, scoreValues);
	}

	const defaultRaw: Map<string, number> = new Map();
	for (const [dimension, weight] of Object.entries(parsed?.default_preference ?? {})) {
		defaultRaw.set(dimension, Number(weight));
	}

	return {
		dimensions,
		defaultPreference: normalizePreference(defaultRaw, 'Inference model default preference', dimensions),
		scores
	};
}

export const modelScores = parseInferenceModelScores(modelScoresYaml);

/**
 * Fill in what the caller did not send: the model's own tuned defaults first,
 * then the interface-wide ones. `source` is documentation, never a request
 * field. Finally clamp `max_tokens` to what the chosen variant can actually
 * emit, so a generous model default cannot produce a request the provider
 * rejects.
 */
export function applyBaseDefaults(
	input: Record<string, unknown>,
	modelId?: string,
	variant?: ProviderModelVariantConfig
) {
	const result = { ...input };

	const modelDefaults = modelId ? baseInterface.model_defaults?.[modelId] : undefined;
	if (modelDefaults) {
		for (const [key, value] of Object.entries(modelDefaults)) {
			if (key === 'source') continue;
			if (result[key] === undefined) result[key] = value;
		}
	}

	for (const [key, definition] of Object.entries(baseInterface.settings ?? {})) {
		if (result[key] === undefined && Object.prototype.hasOwnProperty.call(definition, 'default')) {
			result[key] = definition.default;
		}
	}

	const ceiling = Number(variant?.max_completion_tokens);
	if (Number.isFinite(ceiling) && ceiling > 0 && Number(result.max_tokens) > ceiling) {
		result.max_tokens = ceiling;
	}
	return result;
}

/** The tuned defaults for a canonical model, for tooling that wants to show them. */
export function getModelDefaults(modelId: string): Record<string, unknown> | null {
	return baseInterface.model_defaults?.[modelId] ?? null;
}

export function getInferenceProvider(providerId: string): InferenceProviderSummary | null {
	const provider = providerConfig.providers?.[providerId];
	if (!provider) return null;
	return {
		id: providerId,
		label: provider.label ?? providerId,
		baseUrl: normalizeBaseUrl(provider.base_url),
		apiKeyEnv: provider.api_key_env,
		chatEndpoint: joinUrl(provider.base_url, provider.chat_endpoint),
		models: Object.keys(provider.models ?? {}),
		modelReferences: Object.entries(provider.models ?? {}).flatMap(([modelId, model]) =>
			Object.entries(model.variants ?? {}).map(([variantId, variant]) => ({
				id: variantId === model.default_variant ? modelId : `${modelId}@${variantId}`,
				providerModel: variant.provider_model
			}))
		)
	};
}

/** All provider ids defined in this sub-project's inference-providers.yaml. */
export function listInferenceProviderIds(): string[] {
	return Object.keys(providerConfig.providers ?? {});
}

export function scoreCandidate(candidate: ModelRef, preference: Map<string, number>, scores: InferenceModelScores) {
	const candidateScores = scores.scores.get(modelIdentity(candidate));
	if (!candidateScores) return Number.NEGATIVE_INFINITY;

	let total = 0;
	for (const [dimension, weight] of preference) {
		const value = candidateScores.get(dimension);
		if (value === undefined) return Number.NEGATIVE_INFINITY;
		total += value * (weight / 100);
	}
	return total;
}
