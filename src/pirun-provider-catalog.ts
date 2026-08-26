/**
 * Canonical endpoint pre-knowledge (base URLs, standard env vars, compat
 * quirks, shipped model catalogs), merged model lists, and the per-harness
 * mapping of stored effort intent. Split from pirun-providers.ts, which
 * re-exports everything here — import from either.
 */

import type { ProvidersStore } from './pirun-providers.ts';

export interface CatalogModel {
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	/** Supports controllable extended thinking. */
	reasoning?: boolean;
	/** Reasons unconditionally with no knob (e.g. R1-style models). */
	alwaysReasoning?: boolean;
}

export interface EndpointCompat {
	authHeader?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
}

export interface CanonicalEndpoint {
	baseUrl: string;
	envVar: string;
	compat: EndpointCompat;
	models: CatalogModel[];
	spend?: 'deepseek-balance' | 'openrouter-credits';
}

/**
 * Endpoints Pirun already knows: base URL, standard key variable, API-edge
 * quirks, and a shipped model catalog. Nothing here is fetched — the shipped
 * rows are a starting point and `models --refresh` merges the live list in.
 */
export const CANONICAL_ENDPOINTS: Record<string, CanonicalEndpoint> = {
	openai: {
		baseUrl: 'https://api.openai.com/v1',
		envVar: 'OPENAI_API_KEY',
		compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
		models: [
			{ id: 'gpt-5.2', contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
			{ id: 'gpt-5.2-mini', contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
			{ id: 'gpt-4.1', contextWindow: 1_000_000, maxTokens: 32_768 }
		]
	},
	deepseek: {
		baseUrl: 'https://api.deepseek.com/v1',
		envVar: 'DEEPSEEK_API_KEY',
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [
			{ id: 'deepseek-chat', contextWindow: 128_000, maxTokens: 8_192 },
			{ id: 'deepseek-reasoner', contextWindow: 128_000, maxTokens: 64_000, alwaysReasoning: true }
		],
		spend: 'deepseek-balance'
	},
	openrouter: {
		baseUrl: 'https://openrouter.ai/api/v1',
		envVar: 'OPENROUTER_API_KEY',
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		models: [],
		spend: 'openrouter-credits'
	},
	groq: {
		baseUrl: 'https://api.groq.com/openai/v1',
		envVar: 'GROQ_API_KEY',
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: []
	},
	mistral: {
		baseUrl: 'https://api.mistral.ai/v1',
		envVar: 'MISTRAL_API_KEY',
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: []
	},
	xai: {
		baseUrl: 'https://api.x.ai/v1',
		envVar: 'XAI_API_KEY',
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
		models: [{ id: 'grok-4', contextWindow: 256_000, maxTokens: 64_000, reasoning: true }]
	}
};

export const HARNESS_PROVIDERS = ['antigravity'] as const;
export const BUNDLED_PROVIDER = 'bundled';

export function validProviderName(name: string) {
	return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

export function validAccountName(name: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** The standard env var for a provider, e.g. `myapi` → `MYAPI_API_KEY`. */
export function endpointEnvVar(provider: string) {
	return CANONICAL_ENDPOINTS[provider]?.envVar
		?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** Suffix convention: `DEEPSEEK_API_KEY_WORK` is a ready account named `work`. */
export function accountEnvVar(provider: string, account: string) {
	return `${endpointEnvVar(provider)}_${account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function endpointBaseUrl(store: ProvidersStore, provider: string) {
	return store.endpoints[provider]?.baseUrl ?? CANONICAL_ENDPOINTS[provider]?.baseUrl ?? '';
}

export function endpointCompat(store: ProvidersStore, provider: string): Required<EndpointCompat> {
	const canonical = CANONICAL_ENDPOINTS[provider]?.compat ?? {};
	const stored = store.endpoints[provider]?.compat ?? {};
	return {
		authHeader: stored.authHeader ?? canonical.authHeader ?? true,
		supportsDeveloperRole: stored.supportsDeveloperRole ?? canonical.supportsDeveloperRole ?? true,
		supportsReasoningEffort: stored.supportsReasoningEffort ?? canonical.supportsReasoningEffort ?? false
	};
}

/** Shipped catalog + fetched ids + per-model overrides, one merged list. */
export function endpointModels(store: ProvidersStore, provider: string): CatalogModel[] {
	const entry = store.endpoints[provider];
	const byId = new Map<string, CatalogModel>();
	for (const model of CANONICAL_ENDPOINTS[provider]?.models ?? []) byId.set(model.id, { ...model });
	for (const id of entry?.fetchedModels ?? []) {
		if (!byId.has(id)) byId.set(id, { id });
	}
	for (const [id, override] of Object.entries(entry?.modelOverrides ?? {})) {
		byId.set(id, { ...byId.get(id), ...override, id });
	}
	return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/* reasoning effort: stored intent, mapped per harness/model at call time     */
/* -------------------------------------------------------------------------- */

export type EffortIntent =
	| { kind: 'level'; level: 'off' | 'min' | 'low' | 'medium' | 'high' | 'max' }
	| { kind: 'budget'; tokens: number };

export function parseEffortIntent(raw: string): EffortIntent {
	const value = raw.trim().toLowerCase();
	if (['off', 'min', 'low', 'medium', 'high', 'max'].includes(value)) {
		return { kind: 'level', level: value as Extract<EffortIntent, { kind: 'level' }>['level'] };
	}
	const budget = /^(\d+(?:\.\d+)?)k$/.exec(value);
	if (budget) return { kind: 'budget', tokens: Math.round(Number(budget[1]) * 1000) };
	throw new Error(`--effort must be off, min, low, medium, high, max, or a token budget like 16k (got "${raw}").`);
}

/** Pi speaks --thinking off|minimal|low|medium|high|xhigh|max. */
export function piThinkingLevel(effort: EffortIntent): string {
	if (effort.kind === 'level') {
		return { off: 'off', min: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }[effort.level];
	}
	const k = effort.tokens;
	if (k < 4_000) return 'minimal';
	if (k < 12_000) return 'low';
	if (k < 24_000) return 'medium';
	if (k < 48_000) return 'high';
	if (k < 96_000) return 'xhigh';
	return 'max';
}

/** Antigravity speaks --effort low|medium|high; off has no representation. */
export function antigravityEffortLevel(effort: EffortIntent): 'low' | 'medium' | 'high' {
	if (effort.kind === 'level') {
		return { off: 'low', min: 'low', low: 'low', medium: 'medium', high: 'high', max: 'high' }[effort.level];
	}
	if (effort.tokens < 12_000) return 'low';
	if (effort.tokens < 48_000) return 'medium';
	return 'high';
}

/* -------------------------------------------------------------------------- */
/* model resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exact id, then prefix, then substring — an unambiguous fragment is enough
 * (`r1` → the only id containing it). An unknown name passes through
 * unchanged: the API may know models the catalog does not.
 */
export function resolveEndpointModel(store: ProvidersStore, provider: string, input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	const models = endpointModels(store, provider);
	const needle = trimmed.toLowerCase();
	const tiers = [
		(id: string) => id.toLowerCase() === needle,
		(id: string) => id.toLowerCase().startsWith(needle),
		(id: string) => id.toLowerCase().includes(needle)
	];
	for (const matches of tiers.map((predicate) => models.filter((model) => predicate(model.id)))) {
		if (matches.length === 1) return matches[0].id;
		if (matches.length > 1) {
			throw new Error(
				`"${trimmed}" matches ${matches.length} ${provider} models:\n  ${matches.map((m) => m.id).join('\n  ')}\n` +
					'Use a longer fragment or the exact id.'
			);
		}
	}
	return trimmed;
}

export function catalogModel(store: ProvidersStore, provider: string, id: string): CatalogModel | undefined {
	return endpointModels(store, provider).find((model) => model.id === id);
}
