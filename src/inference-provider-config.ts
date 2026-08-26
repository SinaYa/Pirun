/**
 * Public surface of the inference-provider configuration. The implementation
 * lives in src/inference/ — this barrel keeps import paths stable.
 */

export {
	getInferenceProvider,
	getModelDefaults,
	listInferenceProviderIds
} from './inference/catalog.ts';
export { refreshCascadedInferenceRouting } from './inference/routing-state.ts';
export {
	readProviderMappedPath,
	resolveInferenceProviderRequest
} from './inference/resolve.ts';
export type {
	CascadedInferenceRoutingRefreshResult,
	CascadedInferenceRoutingSnapshot,
	InferenceProviderOverrideMatch,
	InferenceProviderResolution,
	InferenceProviderSummary,
	ModelRef,
	OverrideRule,
	ProviderResponseMapping
} from './inference/types.ts';
