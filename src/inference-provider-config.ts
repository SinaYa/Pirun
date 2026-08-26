import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { CONFIG_DIR } from './paths.ts';

const baseInterfaceYaml = readFileSync(resolve(CONFIG_DIR, 'base-ai-request-interface.yaml'), 'utf8');
const modelScoresYaml = readFileSync(resolve(CONFIG_DIR, 'inference-model-scores.yaml'), 'utf8');
const providerConfigYaml = readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8');

export interface InferenceProviderResolution {
	originalProviderId: string;
	originalModel: string;
	originalModelId: string;
	originalVariantId: string;
	providerId: string;
	providerLabel: string;
	baseUrl: string;
	apiKeyEnv: string;
	chatEndpoint: string;
	mappingName: string;
	modelId: string;
	variantId: string;
	providerModel: string;
	override?: InferenceProviderOverrideMatch;
	requestBody: Record<string, unknown>;
	responseMapping: ProviderResponseMapping;
}

export interface CascadedInferenceRoutingRefreshResult {
	snapshot: CascadedInferenceRoutingSnapshot;
	reloaded: boolean;
	recovered: boolean;
	error?: string;
	invalidPath?: string;
	recoveredPath?: string;
}

export interface CascadedInferenceRoutingSnapshot {
	version: string;
	sourcePath: string;
	groupSourcePath: string;
	ruleCount: number;
	groupCount: number;
	loadedAt: string;
	text: string;
	groupText: string;
	rules: OverrideRule[];
	groups: ModelGroupMap;
	scores: InferenceModelScores;
}

export interface InferenceProviderOverrideMatch {
	lineNumber: number;
	selector: string;
	override: string;
	from: {
		providerId: string;
		modelId: string;
		variantId: string;
	};
	to: {
		providerId: string;
		modelId: string;
		variantId: string;
	};
}

export interface InferenceProviderSummary {
	id: string;
	label: string;
	baseUrl: string;
	apiKeyEnv: string;
	chatEndpoint: string;
	models: string[];
	modelReferences: Array<{ id: string; providerModel: string }>;
}

export interface ProviderResponseMapping {
	content?: string;
	reasoning_content?: string;
	usage?: string;
	attachments?: string;
	tool_calls?: string;
	content_delta?: string;
	reasoning_delta?: string;
	tool_calls_delta?: string;
	finish_reason?: string;
}

interface ProviderConfigRoot {
	version: number;
	providers: Record<string, ProviderConfig>;
	interface_mappings: Record<string, InterfaceMappingConfig>;
}

interface ProviderConfig {
	label?: string;
	base_url: string;
	api_key_env: string;
	chat_endpoint: string;
	interface_mapping: string;
	models: Record<string, ProviderModelConfig>;
}

interface ProviderModelConfig {
	default_variant: string;
	variants: Record<string, ProviderModelVariantConfig>;
}

interface ProviderModelVariantConfig {
	provider_model: string;
	[key: string]: unknown;
}

interface InterfaceMappingConfig {
	request: Record<string, unknown>;
	response: ProviderResponseMapping;
	stream_response: ProviderResponseMapping;
}

interface MappingRule {
	if?: Record<string, unknown>;
	set?: unknown;
	omit?: boolean;
	else?: unknown;
}

interface ProviderMappingContext {
	input: Record<string, unknown>;
	variant: ProviderModelVariantConfig;
	provider: ProviderConfig;
	modelId: string;
	variantId: string;
}

export interface ModelRef {
	providerId: string;
	modelId: string;
	variantId: string;
	providerWildcard: boolean;
	modelWildcard: boolean;
	variantWildcard: boolean;
	variantSpecified: boolean;
	raw: string;
}

export interface OverrideRule {
	lineNumber: number;
	selectorText: string;
	overrideText: string;
	preferenceText: string;
	preference: ScoringPreference;
	selector: RouteTargetExpression;
	override: RouteTargetExpression;
}

type ModelGroupMap = Map<string, ModelRef[]>;
type ScoringPreference = Map<string, number>;

interface InferenceModelScores {
	dimensions: Map<string, ScoreDimension>;
	defaultPreference: ScoringPreference;
	scores: Map<string, Map<string, number>>;
}

interface ScoreDimension {
	description?: string;
	min: number;
	max: number;
}

interface RouteTargetExpression {
	raw: string;
	provider: string;
	providerWildcard: boolean;
	condition: ModelCondition;
	direct?: ModelRef;
}

type ModelCondition =
	| { kind: 'any' }
	| { kind: 'ref'; ref: ModelRef }
	| { kind: 'group'; name: string }
	| { kind: 'same'; scope: 'exact' | 'provider' | 'model' }
	| { kind: 'not'; value: ModelCondition }
	| { kind: 'and'; left: ModelCondition; right: ModelCondition }
	| { kind: 'or'; left: ModelCondition; right: ModelCondition };

const baseInterface = YAML.parse(baseInterfaceYaml) as {
	settings?: Record<string, { default?: unknown }>;
	model_defaults?: Record<string, Record<string, unknown>>;
};
const providerConfig = YAML.parse(providerConfigYaml) as ProviderConfigRoot;
const modelScores = parseInferenceModelScores(modelScoresYaml);
const ROUTING_FILE_PATH = resolve(CONFIG_DIR, 'cascaded-inference-routing.rules');
const ROUTING_RECOVERED_FILE_PATH = resolve(CONFIG_DIR, 'cascaded-inference-routing.recovered.rules');
const GROUP_FILE_PATH = resolve(CONFIG_DIR, 'inference-model-groups.rules');
const BUILTIN_ROUTING_TEXT = '';
const BUILTIN_GROUP_TEXT = '';

let routingCache = createRoutingSnapshot({
	text: BUILTIN_ROUTING_TEXT,
	groupText: BUILTIN_GROUP_TEXT,
	sourcePath: 'builtin:cascaded-inference-routing.rules',
	groupSourcePath: 'builtin:inference-model-groups.rules',
	version: 'bundled'
});
let routingRefreshPromise: Promise<CascadedInferenceRoutingRefreshResult> | null = null;

function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, endpoint: string) {
	const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
	return `${normalizeBaseUrl(baseUrl)}${normalizedEndpoint}`;
}

function parseModelRef(rawModel: string) {
	const [modelId, variantId] = rawModel.split('@', 2).map((part) => part.trim());
	return {
		modelId,
		variantId: variantId || ''
	};
}

function createRoutingSnapshot(input: {
	text: string;
	groupText: string;
	sourcePath: string;
	groupSourcePath: string;
	version: string;
}): CascadedInferenceRoutingSnapshot {
	const groups = parseModelGroups(input.groupText);
	const rules = parseProviderOverrideRules(input.text);
	return {
		version: input.version,
		sourcePath: input.sourcePath,
		groupSourcePath: input.groupSourcePath,
		ruleCount: rules.length,
		groupCount: groups.size,
		loadedAt: new Date().toISOString(),
		text: input.text,
		groupText: input.groupText,
		rules,
		groups,
		scores: modelScores
	};
}

function cloneRoutingSnapshot(snapshot: CascadedInferenceRoutingSnapshot): CascadedInferenceRoutingSnapshot {
	return {
		...snapshot,
		rules: [...snapshot.rules],
		groups: new Map(snapshot.groups),
		scores: snapshot.scores
	};
}

function routingVersion(stats: { mtimeMs: number; size: number }) {
	return `${stats.mtimeMs}:${stats.size}`;
}

function isMissingFileError(error: unknown) {
	return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function timestampForFilename(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function appendRecoveryNote(text: string, note: string) {
	const trimmed = text.endsWith('\n') ? text : `${text}\n`;
	return `${trimmed}\n${note.trim()}\n`;
}

function buildInvalidRecoveryNote(input: { at: string; error: string; recoveredPath: string }) {
	return [
		'# Recovery note:',
		`# This routing file failed to parse at ${input.at}.`,
		`# Error: ${input.error}`,
		`# The previous working routing rules were restored to ${basename(ROUTING_FILE_PATH)}`,
		`# and copied to ${basename(input.recoveredPath)}.`
	].join('\n');
}

function buildRecoveredNote(input: { at: string; error: string; invalidPath: string }) {
	return [
		'# Recovery note:',
		`# This file was restored from the last known-good routing rules at ${input.at}.`,
		`# A broken edit was moved to ${basename(input.invalidPath)}.`,
		`# Error: ${input.error}`
	].join('\n');
}

function stripOverrideComment(line: string) {
	const index = line.indexOf('#');
	return index === -1 ? line : line.slice(0, index);
}

function modelIdentity(ref: Pick<ModelRef, 'providerId' | 'modelId' | 'variantId'>) {
	return `${ref.providerId}>${ref.modelId}@${ref.variantId}`;
}

function hasConfiguredVariant(providerId: string, modelId: string, variantId: string) {
	return Boolean(providerConfig.providers?.[providerId]?.models?.[modelId]?.variants?.[variantId]);
}

function normalizePreference(
	rawWeights: Map<string, number>,
	source: string,
	dimensions = modelScores.dimensions
) {
	let total = 0;
	for (const [dimension, weight] of rawWeights) {
		if (!dimensions.has(dimension)) {
			throw new Error(`${source}: unknown scoring dimension "${dimension}".`);
		}
		if (!Number.isFinite(weight) || weight <= 0) {
			throw new Error(`${source}: scoring weight for "${dimension}" must be greater than 0.`);
		}
		total += weight;
	}
	if (total <= 0) throw new Error(`${source}: scoring preference must include at least one dimension.`);

	const normalized: ScoringPreference = new Map();
	for (const [dimension, weight] of rawWeights) {
		normalized.set(dimension, (weight / total) * 100);
	}
	return normalized;
}

function parsePreferenceText(text: string, source: string) {
	const raw = text.trim();
	if (!raw) return new Map(modelScores.defaultPreference);

	const parts = raw
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts.length) throw new Error(`${source}: "prefer" must name at least one scoring dimension.`);

	const weightedEntries = parts.filter((part) => part.includes(':'));
	if (weightedEntries.length > 0 && weightedEntries.length !== parts.length) {
		throw new Error(`${source}: do not mix weighted and unweighted scoring dimensions in one "prefer" clause.`);
	}

	const rawWeights: ScoringPreference = new Map();
	for (const part of parts) {
		if (part.includes(':')) {
			const [dimensionPart, weightPart] = part.split(':', 2);
			const dimension = dimensionPart.trim();
			const weight = Number(weightPart.trim());
			rawWeights.set(dimension, weight);
			continue;
		}
		rawWeights.set(part, 1);
	}
	return normalizePreference(rawWeights, source);
}

function parseInferenceModelScores(text: string): InferenceModelScores {
	const parsed = YAML.parse(text) as {
		dimensions?: Record<string, { description?: string; min?: number; max?: number }>;
		default_preference?: Record<string, number>;
		scores?: Record<string, Record<string, number>>;
	};

	const dimensions: Map<string, ScoreDimension> = new Map();
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

	const scores: Map<string, Map<string, number>> = new Map();
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

	const defaultRaw: ScoringPreference = new Map();
	for (const [dimension, weight] of Object.entries(parsed?.default_preference ?? {})) {
		defaultRaw.set(dimension, Number(weight));
	}

	return {
		dimensions,
		defaultPreference: normalizePreference(defaultRaw, 'Inference model default preference', dimensions),
		scores
	};
}

function isFullWildcard(raw: string) {
	const compact = raw.replace(/\s+/g, '');
	return compact === '*' || compact === '**' || compact === '*>*';
}

function parseOverrideRef(rawInput: string, lineNumber: number, side: 'selector' | 'override'): ModelRef {
	const raw = rawInput.trim().replace(/\s+/g, '');
	if (!raw) throw new Error(`Provider override line ${lineNumber}: empty ${side}.`);
	if (isFullWildcard(raw)) {
		return {
			providerId: '',
			modelId: '',
			variantId: '',
			providerWildcard: true,
			modelWildcard: true,
			variantWildcard: true,
			variantSpecified: false,
			raw: rawInput.trim()
		};
	}

	let providerPart = '';
	let modelAndVariantPart = raw;
	const providerSeparatorIndex = raw.indexOf('>');
	if (providerSeparatorIndex !== -1) {
		providerPart = raw.slice(0, providerSeparatorIndex);
		modelAndVariantPart = raw.slice(providerSeparatorIndex + 1);
	} else if (raw.startsWith('*') && raw.length > 1) {
		providerPart = '*';
		modelAndVariantPart = raw.slice(1);
	} else if (side === 'override') {
		throw new Error(
			`Provider override line ${lineNumber}: override "${rawInput.trim()}" must include a provider or provider wildcard.`
		);
	} else {
		providerPart = '*';
	}

	let modelPart = modelAndVariantPart;
	let variantPart = '';
	let variantSpecified = false;
	const atIndex = modelAndVariantPart.indexOf('@');
	if (atIndex !== -1) {
		modelPart = modelAndVariantPart.slice(0, atIndex);
		variantPart = modelAndVariantPart.slice(atIndex + 1);
		variantSpecified = true;
	} else {
		const variantSeparatorIndex = modelAndVariantPart.indexOf('>');
		if (variantSeparatorIndex !== -1) {
			modelPart = modelAndVariantPart.slice(0, variantSeparatorIndex);
			variantPart = modelAndVariantPart.slice(variantSeparatorIndex + 1);
			variantSpecified = true;
		}
	}

	const providerWildcard = !providerPart || providerPart === '*';
	const modelWildcard = !modelPart || modelPart === '*';
	const variantWildcard = !variantPart || variantPart === '*';
	if (variantSpecified && !variantWildcard && (providerWildcard || modelWildcard)) {
		throw new Error(
			`Provider override line ${lineNumber}: ${side} "${rawInput.trim()}" specifies a variant, so provider and model must both be concrete names.`
		);
	}

	return {
		providerId: providerWildcard ? '' : providerPart,
		modelId: modelWildcard ? '' : modelPart,
		variantId: variantWildcard ? '' : variantPart,
		providerWildcard,
		modelWildcard,
		variantWildcard,
		variantSpecified,
		raw: rawInput.trim()
	};
}

function parseRouteTargetExpression(rawInput: string, lineNumber: number, side: 'selector' | 'override'): RouteTargetExpression {
	const raw = rawInput.trim();
	const compact = raw.replace(/\s+/g, '');
	if (isFullWildcard(compact)) {
		return {
			raw,
			provider: '',
			providerWildcard: true,
			condition: { kind: 'any' },
			direct: parseOverrideRef(raw, lineNumber, side)
		};
	}

	const groupOrConditionLike = /[$()&|!]/.test(compact);
	if (!groupOrConditionLike) {
		const direct = parseOverrideRef(raw, lineNumber, side);
		return {
			raw,
			provider: direct.providerId,
			providerWildcard: direct.providerWildcard,
			condition: direct.modelWildcard ? { kind: 'any' } : { kind: 'ref', ref: direct },
			direct
		};
	}

	let providerPart = '*';
	let conditionPart = compact;
	const providerSeparatorIndex = compact.indexOf('>');
	if (providerSeparatorIndex !== -1) {
		providerPart = compact.slice(0, providerSeparatorIndex) || '*';
		conditionPart = compact.slice(providerSeparatorIndex + 1);
	}

	if (conditionPart.startsWith('(') && conditionPart.endsWith(')')) {
		conditionPart = conditionPart.slice(1, -1);
	}

	const providerWildcard = providerPart === '*';
	return {
		raw,
		provider: providerWildcard ? '' : providerPart,
		providerWildcard,
		condition: new ModelConditionParser(conditionPart, lineNumber).parse()
	};
}

class ModelConditionParser {
	index = 0;
	input: string;
	lineNumber: number;

	constructor(input: string, lineNumber: number) {
		this.input = input;
		this.lineNumber = lineNumber;
	}

	parse(): ModelCondition {
		const value = this.parseOr();
		if (this.peek()) {
			throw new Error(`Provider override line ${this.lineNumber}: unexpected token near "${this.input.slice(this.index)}".`);
		}
		return value;
	}

	parseOr(): ModelCondition {
		let left = this.parseAnd();
		while (this.consume('|')) {
			left = { kind: 'or', left, right: this.parseAnd() };
		}
		return left;
	}

	parseAnd(): ModelCondition {
		let left = this.parseUnary();
		while (this.consume('&')) {
			left = { kind: 'and', left, right: this.parseUnary() };
		}
		return left;
	}

	parseUnary(): ModelCondition {
		if (this.consume('!')) return { kind: 'not', value: this.parseUnary() };
		if (this.consume('(')) {
			const value = this.parseOr();
			if (!this.consume(')')) throw new Error(`Provider override line ${this.lineNumber}: missing closing ")".`);
			return value;
		}
		return this.parseAtom();
	}

	parseAtom(): ModelCondition {
		const start = this.index;
		while (this.index < this.input.length && !'&|()'.includes(this.input[this.index])) {
			this.index += 1;
		}
		const token = this.input.slice(start, this.index).trim();
		if (!token) throw new Error(`Provider override line ${this.lineNumber}: expected condition token.`);
		if (token === '_same') return { kind: 'same', scope: 'exact' };
		if (token === '*>*@_same') return { kind: 'same', scope: 'exact' };
		if (token === '_same>*' || token === '_same>*@*') return { kind: 'same', scope: 'provider' };
		if (token === '*>_same') return { kind: 'same', scope: 'model' };
		if (token.startsWith('$')) return { kind: 'group', name: token.slice(1) };
		return { kind: 'ref', ref: parseOverrideRef(token, this.lineNumber, 'selector') };
	}

	peek() {
		return this.input[this.index] ?? '';
	}

	consume(value: string) {
		if (this.input[this.index] !== value) return false;
		this.index += 1;
		return true;
	}
}

function parseModelGroups(text: string): ModelGroupMap {
	const groups: ModelGroupMap = new Map();
	let activeGroup = '';
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const lineNumber = index + 1;
		const line = stripOverrideComment(rawLine).trim();
		if (!line) continue;
		if (line.endsWith(':')) {
			activeGroup = line.slice(0, -1).trim();
			if (!activeGroup) throw new Error(`Model group line ${lineNumber}: empty group name.`);
			if (!groups.has(activeGroup)) groups.set(activeGroup, []);
			continue;
		}
		if (!activeGroup) throw new Error(`Model group line ${lineNumber}: selector appears before a group header.`);
		groups.get(activeGroup)?.push(parseOverrideRef(line, lineNumber, 'selector'));
	}
	return groups;
}

function parseProviderOverrideRules(text: string) {
	const rules: OverrideRule[] = [];
	for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
		const lineNumber = index + 1;
		const line = stripOverrideComment(rawLine).trim();
		if (!line) continue;
		const separatorIndex = line.indexOf('=');
		if (separatorIndex === -1) {
			throw new Error(`Provider override line ${lineNumber}: expected "selector = override".`);
		}
		const selectorText = line.slice(0, separatorIndex).trim();
		const rawOverrideText = line.slice(separatorIndex + 1).trim();
		const preferMatch = rawOverrideText.match(/\s+prefer\s+/i);
		const overrideText = preferMatch ? rawOverrideText.slice(0, preferMatch.index).trim() : rawOverrideText;
		const preferenceText = preferMatch
			? rawOverrideText.slice((preferMatch.index ?? 0) + preferMatch[0].length).trim()
			: '';
		if (!overrideText) throw new Error(`Provider override line ${lineNumber}: empty override.`);
		rules.push({
			lineNumber,
			selectorText,
			overrideText,
			preferenceText,
			preference: parsePreferenceText(preferenceText, `Provider override line ${lineNumber}`),
			selector: parseRouteTargetExpression(selectorText, lineNumber, 'selector'),
			override: parseRouteTargetExpression(overrideText, lineNumber, 'override')
		});
	}
	return rules;
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

function allProviderModelCandidates(original: ModelRef) {
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

function scoreCandidate(candidate: ModelRef, preference: ScoringPreference, scores: InferenceModelScores) {
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

function isDefaultVariant(candidate: ModelRef) {
	return providerConfig.providers?.[candidate.providerId]?.models?.[candidate.modelId]?.default_variant === candidate.variantId;
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

function providerHasModel(providerId: string, modelId: string) {
	return Boolean(providerConfig.providers?.[providerId]?.models?.[modelId]);
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

/**
 * Fill in what the caller did not send: the model's own tuned defaults first,
 * then the interface-wide ones. `source` is documentation, never a request
 * field. Finally clamp `max_tokens` to what the chosen variant can actually
 * emit, so a generous model default cannot produce a request the provider
 * rejects.
 */
function applyBaseDefaults(
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

async function readRoutingCandidate() {
	const groupStats = await stat(GROUP_FILE_PATH).catch((error) => {
		if (!isMissingFileError(error)) throw error;
		return null;
	});
	try {
		const stats = await stat(ROUTING_FILE_PATH);
		return {
			path: ROUTING_FILE_PATH,
			stats,
			groupPath: GROUP_FILE_PATH,
			groupStats,
			recovered: false
		};
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	try {
		const stats = await stat(ROUTING_RECOVERED_FILE_PATH);
		return {
			path: ROUTING_RECOVERED_FILE_PATH,
			stats,
			groupPath: GROUP_FILE_PATH,
			groupStats,
			recovered: true
		};
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	return null;
}

async function recoverInvalidRoutingFile(input: {
	invalidText: string;
	groupText: string;
	error: string;
	candidatePath: string;
}) {
	const at = new Date().toISOString();
	const invalidPath = resolve(
		dirname(ROUTING_FILE_PATH),
		`cascaded-inference-routing.${timestampForFilename(new Date(at))}.invalid.rules`
	);
	const recoveredPath = ROUTING_RECOVERED_FILE_PATH;

	if (input.candidatePath === ROUTING_FILE_PATH) {
		await rename(input.candidatePath, invalidPath);
		await appendFile(
			invalidPath,
			`\n${buildInvalidRecoveryNote({ at, error: input.error, recoveredPath })}\n`,
			'utf8'
		);
	} else {
		await writeFile(
			invalidPath,
			appendRecoveryNote(
				input.invalidText,
				buildInvalidRecoveryNote({ at, error: input.error, recoveredPath })
			),
			'utf8'
		);
	}

	const recoveredText = appendRecoveryNote(
		routingCache.text,
		buildRecoveredNote({ at, error: input.error, invalidPath })
	);
	await writeFile(ROUTING_FILE_PATH, recoveredText, 'utf8');
	await writeFile(recoveredPath, recoveredText, 'utf8');
	const stats = await stat(ROUTING_FILE_PATH);
	routingCache = createRoutingSnapshot({
		text: recoveredText,
		groupText: input.groupText,
		sourcePath: ROUTING_FILE_PATH,
		groupSourcePath: GROUP_FILE_PATH,
		version: routingVersion(stats)
	});

	return {
		invalidPath,
		recoveredPath
	};
}

async function refreshCascadedInferenceRoutingInner(): Promise<CascadedInferenceRoutingRefreshResult> {
	const candidate = await readRoutingCandidate();
	if (!candidate) {
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: false,
			recovered: false,
			error: 'No cascaded inference routing file or recovered routing file was found; using in-memory rules.'
		};
	}

	const groupText = candidate.groupStats ? await readFile(candidate.groupPath, 'utf8') : BUILTIN_GROUP_TEXT;
	const groupVersion = candidate.groupStats ? routingVersion(candidate.groupStats) : 'no-groups';
	const version = `${routingVersion(candidate.stats)}:${groupVersion}`;
	if (routingCache.sourcePath === candidate.path && routingCache.version === version) {
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: false,
			recovered: false
		};
	}

	const text = await readFile(candidate.path, 'utf8');
	try {
		routingCache = createRoutingSnapshot({
			text,
			groupText,
			sourcePath: candidate.path,
			groupSourcePath: candidate.groupPath,
			version
		});
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: true,
			recovered: candidate.recovered
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const recovery = await recoverInvalidRoutingFile({
			invalidText: text,
			groupText,
			error: message,
			candidatePath: candidate.path
		});
		return {
			snapshot: cloneRoutingSnapshot(routingCache),
			reloaded: true,
			recovered: true,
			error: message,
			invalidPath: recovery.invalidPath,
			recoveredPath: recovery.recoveredPath
		};
	}
}

export async function refreshCascadedInferenceRouting(): Promise<CascadedInferenceRoutingRefreshResult> {
	if (!routingRefreshPromise) {
		routingRefreshPromise = refreshCascadedInferenceRoutingInner().finally(() => {
			routingRefreshPromise = null;
		});
	}
	const result = await routingRefreshPromise;
	return {
		...result,
		snapshot: cloneRoutingSnapshot(result.snapshot)
	};
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
		routingSnapshot: input.routingSnapshot ?? routingCache
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
