/** Shared types for the proxy's inference-provider configuration and routing. */

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

export interface ProviderConfigRoot {
	version: number;
	providers: Record<string, ProviderConfig>;
	interface_mappings: Record<string, InterfaceMappingConfig>;
}

export interface ProviderConfig {
	label?: string;
	base_url: string;
	api_key_env: string;
	chat_endpoint: string;
	interface_mapping: string;
	models: Record<string, ProviderModelConfig>;
}

export interface ProviderModelConfig {
	default_variant: string;
	variants: Record<string, ProviderModelVariantConfig>;
}

export interface ProviderModelVariantConfig {
	provider_model: string;
	[key: string]: unknown;
}

export interface InterfaceMappingConfig {
	request: Record<string, unknown>;
	response: ProviderResponseMapping;
	stream_response: ProviderResponseMapping;
}

export interface MappingRule {
	if?: Record<string, unknown>;
	set?: unknown;
	omit?: boolean;
	else?: unknown;
}

export interface ProviderMappingContext {
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

export type ModelGroupMap = Map<string, ModelRef[]>;
export type ScoringPreference = Map<string, number>;

export interface InferenceModelScores {
	dimensions: Map<string, ScoreDimension>;
	defaultPreference: ScoringPreference;
	scores: Map<string, Map<string, number>>;
}

export interface ScoreDimension {
	description?: string;
	min: number;
	max: number;
}

export interface RouteTargetExpression {
	raw: string;
	provider: string;
	providerWildcard: boolean;
	condition: ModelCondition;
	direct?: ModelRef;
}

export type ModelCondition =
	| { kind: 'any' }
	| { kind: 'ref'; ref: ModelRef }
	| { kind: 'group'; name: string }
	| { kind: 'same'; scope: 'exact' | 'provider' | 'model' }
	| { kind: 'not'; value: ModelCondition }
	| { kind: 'and'; left: ModelCondition; right: ModelCondition }
	| { kind: 'or'; left: ModelCondition; right: ModelCondition };

export function modelIdentity(ref: Pick<ModelRef, 'providerId' | 'modelId' | 'variantId'>) {
	return `${ref.providerId}>${ref.modelId}@${ref.variantId}`;
}
