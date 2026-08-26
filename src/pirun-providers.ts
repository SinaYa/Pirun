/**
 * The shared provider store: consumption sources and authentication, kept
 * outside every preset. Endpoints (OpenAI-completions compatible APIs) hold
 * api-key accounts; canonical harnesses (Antigravity) hold login accounts.
 * Presets only point at `provider/account` — authenticate once, use from any
 * preset.
 *
 * Secrets never enter this file: endpoint accounts store `$ENV_VAR` references
 * (or, if the user insists, a literal they typed), harness accounts store only
 * the derived profile directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteJson } from './pirun-files.ts';

/* -------------------------------------------------------------------------- */
/* store shape                                                                */
/* -------------------------------------------------------------------------- */

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

export interface EndpointAccount {
	/** `$ENV_VAR`, a `!credential-command`, or a literal key. */
	key: string;
}

export interface EndpointEntry {
	/** Required for custom endpoints; canonical ones inherit from the catalog. */
	baseUrl?: string;
	custom?: boolean;
	compat?: EndpointCompat;
	accounts: Record<string, EndpointAccount>;
	defaultAccount?: string;
	/** Live model list from the API, merged over the shipped catalog. */
	fetchedModels?: string[];
	fetchedAt?: number;
	modelOverrides?: Record<string, Partial<CatalogModel>>;
}

export interface HarnessAccount {
	profileDir?: string;
}

export interface HarnessEntry {
	accounts: Record<string, HarnessAccount>;
	defaultAccount?: string;
}

export interface ProvidersStore {
	version: 1;
	endpoints: Record<string, EndpointEntry>;
	harnesses: Record<string, HarnessEntry>;
}

export function providersStorePath() {
	if (process.env.PIRUN_PROVIDERS_PATH) return resolve(process.env.PIRUN_PROVIDERS_PATH);
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		return resolve(process.env.LOCALAPPDATA, 'Pirun', 'providers.json');
	}
	if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, 'pirun', 'providers.json');
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) throw new Error('No user state directory is available for the Pirun provider store.');
	return resolve(home, '.local', 'state', 'pirun', 'providers.json');
}

export function loadProvidersStore(path = providersStorePath()): ProvidersStore {
	const store: ProvidersStore = { version: 1, endpoints: {}, harnesses: {} };
	if (!existsSync(path)) return store;
	let parsed: Partial<ProvidersStore>;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProvidersStore>;
	} catch (error) {
		throw new Error(`Pirun provider store is not valid JSON: ${path} (${String(error)})`);
	}
	for (const [name, entry] of Object.entries(parsed.endpoints ?? {})) {
		if (entry && typeof entry === 'object') store.endpoints[name] = { accounts: {}, ...entry };
	}
	for (const [name, entry] of Object.entries(parsed.harnesses ?? {})) {
		if (entry && typeof entry === 'object') store.harnesses[name] = { accounts: {}, ...entry };
	}
	return store;
}

export function writeProvidersStore(store: ProvidersStore, path = providersStorePath()) {
	atomicWriteJson(path, store);
}

/* -------------------------------------------------------------------------- */
/* canonical catalog                                                          */
/* -------------------------------------------------------------------------- */

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
/* --use resolution                                                           */
/* -------------------------------------------------------------------------- */

export type UseKind = 'endpoint' | 'harness' | 'bundled';

export interface ResolvedUse {
	kind: UseKind;
	provider: string;
	/** Empty for the bundled proxy. */
	account: string;
	/** True when the account was created during this resolution and the store must be saved. */
	created: boolean;
}

export function knownProviderNames(store: ProvidersStore) {
	return [
		BUNDLED_PROVIDER,
		...HARNESS_PROVIDERS,
		...new Set([...Object.keys(CANONICAL_ENDPOINTS), ...Object.keys(store.endpoints)])
	];
}

function pickEndpointAccount(store: ProvidersStore, provider: string, requested: string): { account: string; created: boolean } {
	const entry = (store.endpoints[provider] ??= { accounts: {} });
	if (requested) {
		if (entry.accounts[requested]) return { account: requested, created: false };
		const suffixVar = accountEnvVar(provider, requested);
		if (process.env[suffixVar]) {
			entry.accounts[requested] = { key: `$${suffixVar}` };
			return { account: requested, created: true };
		}
		throw new Error(
			`provider "${provider}" has no account "${requested}".\n` +
				`run: pirun provider key ${provider} ${requested} --env <VAR>  (or set ${suffixVar})`
		);
	}
	if (entry.defaultAccount && entry.accounts[entry.defaultAccount]) {
		return { account: entry.defaultAccount, created: false };
	}
	const names = Object.keys(entry.accounts);
	if (names.length === 1) return { account: names[0], created: false };
	if (names.length > 1) {
		throw new Error(
			`provider "${provider}" has ${names.length} accounts (${names.join(', ')}); name one: --use ${provider}/<account>\n` +
				`or set a default: pirun provider default ${provider} <account>`
		);
	}
	const envVar = endpointEnvVar(provider);
	if (process.env[envVar]) {
		entry.accounts.main = { key: `$${envVar}` };
		return { account: 'main', created: true };
	}
	throw new Error(
		`provider "${provider}" has no accounts and ${envVar} is not set.\n` +
			`run: pirun provider key ${provider} main --env <VAR>  (or set ${envVar})`
	);
}

function pickHarnessAccount(store: ProvidersStore, provider: string, requested: string): { account: string; created: boolean } {
	const entry = (store.harnesses[provider] ??= { accounts: {} });
	if (requested) {
		if (entry.accounts[requested]) return { account: requested, created: false };
		if (!validAccountName(requested)) throw new Error(`"${requested}" is not a usable account name.`);
		entry.accounts[requested] = {};
		return { account: requested, created: true };
	}
	if (entry.defaultAccount && entry.accounts[entry.defaultAccount]) {
		return { account: entry.defaultAccount, created: false };
	}
	const names = Object.keys(entry.accounts);
	if (names.length === 1) return { account: names[0], created: false };
	if (names.length > 1) {
		throw new Error(
			`${provider} has ${names.length} accounts (${names.join(', ')}); name one: --use ${provider}/<account>\n` +
				`or set a default: pirun provider default ${provider} <account>`
		);
	}
	throw new Error(`${provider} has no accounts yet.\nrun: pirun login ${provider} <account>`);
}

/**
 * `deepseek`, `deepseek/work`, `antigravity/luigi`, `bundled`. Mutates the
 * store when an account is auto-created (from a detected env var, or a fresh
 * harness account awaiting login) — check `created` and persist.
 */
export function resolveUse(store: ProvidersStore, raw: string): ResolvedUse {
	const [providerRaw, accountRaw = '', ...extra] = raw.trim().split('/');
	const provider = providerRaw.toLowerCase();
	if (!provider || extra.length) {
		throw new Error(`--use takes provider[/account] (got "${raw}"). See: pirun providers`);
	}
	if (provider === BUNDLED_PROVIDER) {
		if (accountRaw) throw new Error('the bundled proxy has no accounts; use just --use bundled.');
		return { kind: 'bundled', provider, account: '', created: false };
	}
	if ((HARNESS_PROVIDERS as readonly string[]).includes(provider)) {
		const picked = pickHarnessAccount(store, provider, accountRaw);
		return { kind: 'harness', provider, ...picked };
	}
	if (!CANONICAL_ENDPOINTS[provider] && !store.endpoints[provider]) {
		throw new Error(
			`unknown provider "${provider}". Known: ${knownProviderNames(store).join(', ')}.\n` +
				`for a custom endpoint, run: pirun provider add ${provider} --base-url <url>`
		);
	}
	if (!CANONICAL_ENDPOINTS[provider] && !store.endpoints[provider]?.baseUrl) {
		throw new Error(`provider "${provider}" has no base URL. run: pirun provider add ${provider} --base-url <url>`);
	}
	const picked = pickEndpointAccount(store, provider, accountRaw);
	return { kind: 'endpoint', provider, ...picked };
}

/** Non-throwing scan used by `pirun providers`: env vars that imply accounts. */
export function detectedEnvAccounts(store: ProvidersStore, provider: string) {
	const found: Array<{ account: string; envVar: string }> = [];
	const base = endpointEnvVar(provider);
	const existing = new Set(Object.keys(store.endpoints[provider]?.accounts ?? {}));
	if (process.env[base] && !existing.size) found.push({ account: 'main', envVar: base });
	const prefix = `${base}_`;
	for (const name of Object.keys(process.env)) {
		if (!name.startsWith(prefix)) continue;
		const account = name.slice(prefix.length).toLowerCase();
		if (account && !existing.has(account)) found.push({ account, envVar: name });
	}
	return found;
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
