/** Resolving a request to a provider/model/variant and building the upstream body. */

import {
	allProviderModelCandidates,
	applyBaseDefaults,
	isDefaultVariant,
	joinUrl,
	normalizeBaseUrl,
	providerConfig,
	providerHasModel,
	scoreCandidate
} from './catalog.ts';
import { currentRoutingSnapshot } from './routing-state.ts';
import type {
	CascadedInferenceRoutingSnapshot,
	InferenceModelScores,
	InferenceProviderOverrideMatch,
	InferenceProviderResolution,
	MappingRule,
	ModelCondition,
	ModelGroupMap,
	ModelRef,
	OverrideRule,
	ProviderMappingContext,
	RouteTargetExpression,
	ScoringPreference
} from './types.ts';

function parseModelRef(rawModel: string) {
	const [modelId, variantId] = rawModel.split('@', 2).map((part) => part.trim());
	return {
		modelId,
		variantId: variantId || ''
	};
}

function modelRefMatches(ref: ModelRef, target: ModelRef, original: ModelRef) {
	if (!ref.providerWildcard) {
		const providerId = ref.providerId === '_same' ? original.providerId : ref.providerId;
		if (providerId !== target.providerId) return false;
	}
	if (!ref.modelWildcard) {
		const modelId = ref.modelId === '_same' ? original.modelId : ref.modelId;
		if (modelId !== target.modelId) return false;
	}
	if (ref.variantSpecified && !ref.variantWildcard) {
		const variantId = ref.variantId === '_same' ? original.variantId : ref.variantId;
		if (variantId !== target.variantId) return false;
	}
	return true;
}

function evaluateCondition(condition: ModelCondition, target: ModelRef, original: ModelRef, groups: ModelGroupMap): boolean {
	switch (condition.kind) {
		case 'any':
			return true;
		case 'ref':
			return modelRefMatches(condition.ref, target, original);
		case 'group':
			return (groups.get(condition.name) ?? []).some((ref) => modelRefMatches(ref, target, original));
		case 'same':
			if (condition.scope === 'provider') return target.providerId === original.providerId;
			if (condition.scope === 'model') return target.modelId === original.modelId;
			return (
				target.providerId === original.providerId &&
				target.modelId === original.modelId &&
				(target.variantId || '') === (original.variantId || '')
			);
		case 'not':
			return !evaluateCondition(condition.value, target, original, groups);
		case 'and':
			return (
				evaluateCondition(condition.left, target, original, groups) &&
				evaluateCondition(condition.right, target, original, groups)
			);
		case 'or':
			return (
				evaluateCondition(condition.left, target, original, groups) ||
				evaluateCondition(condition.right, target, original, groups)
			);
	}
}

function overrideSelectorMatches(selector: RouteTargetExpression, target: ModelRef, groups: ModelGroupMap) {
	if (!selector.providerWildcard && selector.provider !== target.providerId) return false;
	return evaluateCondition(selector.condition, target, target, groups);
}

function routeTargetMatches(route: RouteTargetExpression, target: ModelRef, original: ModelRef, groups: ModelGroupMap) {
	if (!route.providerWildcard && route.provider !== target.providerId) return false;
	return evaluateCondition(route.condition, target, original, groups);
}

function randomChoice<T>(items: T[]) {
	return items[Math.floor(Math.random() * items.length)];
}

function chooseBestCandidate(
	candidates: ModelRef[],
	preference: ScoringPreference,
	scores: InferenceModelScores
) {
	const primaryScored = candidates
		.map((candidate) => ({
			candidate,
			primaryScore: scoreCandidate(candidate, preference, scores)
		}))
		.filter((entry) => entry.primaryScore !== Number.NEGATIVE_INFINITY);

	if (!primaryScored.length) {
		const defaultVariants = candidates.filter(isDefaultVariant);
		return defaultVariants.length ? randomChoice(defaultVariants) : undefined;
	}

	const bestPrimaryScore = Math.max(...primaryScored.map((entry) => entry.primaryScore));
	const primaryWinners = primaryScored
		.filter((entry) => entry.primaryScore === bestPrimaryScore)
		.map((entry) => entry.candidate);
	if (primaryWinners.length === 1) return primaryWinners[0];

	const defaultScored = primaryWinners
		.map((candidate) => ({
			candidate,
			defaultScore: scoreCandidate(candidate, scores.defaultPreference, scores)
		}))
		.filter((entry) => entry.defaultScore !== Number.NEGATIVE_INFINITY);
	if (!defaultScored.length) return randomChoice(primaryWinners);

	const bestDefaultScore = Math.max(...defaultScored.map((entry) => entry.defaultScore));
	const defaultWinners = defaultScored
		.filter((entry) => entry.defaultScore === bestDefaultScore)
		.map((entry) => entry.candidate);
	return randomChoice(defaultWinners);
}

function resolveOverrideTarget(
	override: RouteTargetExpression,
	original: ModelRef,
	groups: ModelGroupMap,
	preference: ScoringPreference,
	scores: InferenceModelScores
) {
	if (override.direct) {
		const providerId = override.direct.providerWildcard ? original.providerId : override.direct.providerId;
		const modelId = override.direct.modelWildcard ? original.modelId : override.direct.modelId;
		if (!providerHasModel(providerId, modelId)) {
			throw new Error(`Provider override routes to "${providerId}>${modelId}", but that provider/model is not defined.`);
		}
		const keepsSameProviderAndModel = providerId === original.providerId && modelId === original.modelId;
		const variantId =
			override.direct.variantSpecified && !override.direct.variantWildcard
				? override.direct.variantId
				: keepsSameProviderAndModel
					? original.variantId
					: '';
		return {
			providerId,
			modelId,
			variantId,
			providerWildcard: false,
			modelWildcard: false,
			variantWildcard: !variantId,
			variantSpecified: Boolean(variantId),
			raw: `${providerId}>${modelId}${variantId ? `@${variantId}` : ''}`
		};
	}

	const matches = allProviderModelCandidates(original).filter((candidate) =>
		routeTargetMatches(override, candidate, original, groups)
	);
	const match = chooseBestCandidate(matches, preference, scores);
	if (!match) {
		if (!matches.length) {
			throw new Error(`Provider override "${override.raw}" did not match any configured provider/model variant.`);
		}
		throw new Error(
			`Provider override "${override.raw}" matched ${matches.length} provider/model variant(s), but none had all preferred score dimensions.`
		);
	}
	return match;
}

function applyProviderOverride(input: {
	providerId: string;
	model: string;
	routingSnapshot: CascadedInferenceRoutingSnapshot;
}) {
	const parsedModel = parseModelRef(input.model);
	const original: ModelRef = {
		providerId: input.providerId.trim() || 'commandcode',
		modelId: parsedModel.modelId,
		variantId: parsedModel.variantId,
		providerWildcard: false,
		modelWildcard: false,
		variantWildcard: !parsedModel.variantId,
		variantSpecified: Boolean(parsedModel.variantId),
		raw: `${input.providerId}>${input.model}`
	};

	let matchedRule: OverrideRule | undefined;
	for (const rule of input.routingSnapshot.rules) {
		if (overrideSelectorMatches(rule.selector, original, input.routingSnapshot.groups)) matchedRule = rule;
	}
	if (!matchedRule) {
		return {
			effective: original,
			override: undefined
		};
	}

	const effective = resolveOverrideTarget(
		matchedRule.override,
		original,
		input.routingSnapshot.groups,
		matchedRule.preference,
		input.routingSnapshot.scores
	);

	return {
		effective,
		override: {
			lineNumber: matchedRule.lineNumber,
			selector: matchedRule.selectorText,
			override: matchedRule.overrideText,
			from: {
				providerId: original.providerId,
				modelId: original.modelId,
				variantId: original.variantId
			},
			to: {
				providerId: effective.providerId,
				modelId: effective.modelId,
				variantId: effective.variantId
			}
		} satisfies InferenceProviderOverrideMatch
	};
}

function valueAtPath(source: unknown, path: string): unknown {
	if (!path.startsWith('$.')) return undefined;
	const parts = path.slice(2).replace(/\[(\d+)\]/g, '.$1').split('.');
	let current = source;
	for (const part of parts) {
		if (!part) continue;
		if (current === null || current === undefined) return undefined;
		if (Array.isArray(current)) {
			const index = Number(part);
			current = Number.isInteger(index) ? current[index] : undefined;
			continue;
		}
		if (typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

export function readProviderMappedPath(source: unknown, path: string | undefined) {
	if (!path) return undefined;
	return valueAtPath(source, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function conditionMatches(input: Record<string, unknown>, condition: Record<string, unknown> | undefined) {
	if (!condition) return false;
	return Object.entries(condition).every(([key, expected]) => {
		const actual = input[key];
		return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
	});
}

function resolveMappingExpression(expression: unknown, context: ProviderMappingContext): unknown {
	if (typeof expression === 'string') {
		if (expression.startsWith('$.')) return valueAtPath(context, expression);
		return expression;
	}
	if (typeof expression !== 'object' || expression === null) return expression;
	if (Array.isArray(expression)) return expression.map((entry) => resolveMappingExpression(entry, context));

	if (isRecord(expression) && Array.isArray(expression.when)) {
		for (const rule of expression.when as MappingRule[]) {
			if ('else' in rule) {
				if (rule.else === true) return true;
				if (rule.else === false || rule.else === undefined) return undefined;
				return resolveMappingExpression(rule.else, context);
			}
			if (conditionMatches(context.input, rule.if)) {
				if (rule.omit) return undefined;
				if ('set' in rule) return resolveMappingExpression(rule.set, context);
				return undefined;
			}
		}
		return undefined;
	}

	if (isRecord(expression) && 'omit' in expression && expression.omit === true) return undefined;
	if (isRecord(expression) && 'set' in expression && Object.keys(expression).length === 1) {
		return resolveMappingExpression(expression.set, context);
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(expression)) {
		const resolved = resolveMappingExpression(value, context);
		if (resolved !== undefined) result[key] = resolved;
	}
	return result;
}

export function resolveInferenceProviderRequest(input: {
	providerId: string;
	model: string;
	values: Record<string, unknown>;
	routingSnapshot?: CascadedInferenceRoutingSnapshot;
}): InferenceProviderResolution {
	const overrideResolution = applyProviderOverride({
		providerId: input.providerId,
		model: input.model,
		routingSnapshot: input.routingSnapshot ?? currentRoutingSnapshot()
	});
	const providerId = overrideResolution.effective.providerId;
	const provider = providerConfig.providers?.[providerId];
	if (!provider) throw new Error(`Unknown inference provider "${providerId}".`);

	const originalModelRef = parseModelRef(input.model);
	const modelRef = overrideResolution.effective;
	const modelConfig = provider.models?.[modelRef.modelId];
	if (!modelConfig) {
		throw new Error(`Provider "${providerId}" does not define model "${modelRef.modelId}".`);
	}

	const variantId = modelRef.variantId || modelConfig.default_variant;
	const variant = modelConfig.variants?.[variantId];
	if (!variant) {
		throw new Error(`Provider "${providerId}" model "${modelRef.modelId}" does not define variant "${variantId}".`);
	}

	const mapping = providerConfig.interface_mappings?.[provider.interface_mapping];
	if (!mapping) throw new Error(`Inference interface mapping "${provider.interface_mapping}" was not found.`);

	const context: ProviderMappingContext = {
		input: applyBaseDefaults(input.values, modelRef.modelId, variant),
		variant,
		provider,
		modelId: modelRef.modelId,
		variantId
	};

	const requestBody: Record<string, unknown> = {};
	for (const [key, expression] of Object.entries(mapping.request ?? {})) {
		const value = resolveMappingExpression(expression, context);
		if (value !== undefined) requestBody[key] = value;
	}

	return {
		originalProviderId: input.providerId.trim() || 'commandcode',
		originalModel: input.model,
		originalModelId: originalModelRef.modelId,
		originalVariantId: originalModelRef.variantId,
		providerId,
		providerLabel: provider.label ?? providerId,
		baseUrl: normalizeBaseUrl(provider.base_url),
		apiKeyEnv: provider.api_key_env,
		chatEndpoint: joinUrl(provider.base_url, provider.chat_endpoint),
		mappingName: provider.interface_mapping,
		modelId: modelRef.modelId,
		variantId,
		providerModel: variant.provider_model,
		override: overrideResolution.override,
		requestBody,
		responseMapping: {
			...mapping.response,
			content_delta: mapping.stream_response?.content_delta,
			reasoning_delta: mapping.stream_response?.reasoning_delta,
			tool_calls_delta: mapping.stream_response?.tool_calls_delta,
			finish_reason: mapping.response?.finish_reason,
			usage: mapping.stream_response?.usage ?? mapping.response?.usage
		}
	};
}
