import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { atomicWriteJson } from './pirun-files.ts';
import {
	endpointBaseUrl,
	endpointCompat,
	endpointModels,
	BUNDLED_PROVIDER,
	type CatalogModel,
	type ProvidersStore
} from './pirun-providers.ts';

/** Legacy (v1) per-preset API block, still parsed so it can be migrated. */
export interface PirunOpenAiApi {
	baseUrl: string;
	apiKey?: string;
	authHeader?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
}

export type PirunHarness = 'pi' | 'antigravity';

interface LegacyAntigravityConfig {
	effort?: 'low' | 'medium' | 'high';
	agent?: string;
}

export interface PirunPreset {
	/** `provider/account` in the shared provider store, or `bundled`. */
	use: string;
	harness: PirunHarness;
	model: string;
	/** Reasoning intent: off|min|low|medium|high|max|<n>k. Mapped per model. */
	effort?: string;
	/** Persistent text prepended to every prompt sent under this preset. */
	prefix?: string;
	dir?: string;
	tools: boolean;
	contextFiles: boolean;
	full: boolean;
	json: boolean;
	/** Antigravity's named agent persona, if any. */
	antigravityAgent?: string;
	/** Legacy v1 field, consumed by migration. */
	api?: PirunOpenAiApi;
	/** Legacy v1 field, consumed by migration. */
	antigravity?: LegacyAntigravityConfig;
}

export interface PirunConfig {
	version: 2;
	presets: Record<string, PirunPreset>;
}

interface LegacyPirunConfig {
	defaultModel?: string;
}

export interface PiModelDocument {
	providers?: Record<string, Record<string, unknown>>;
}

export function validPresetName(name: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function defaultPreset(model: string): PirunPreset {
	return {
		use: BUNDLED_PROVIDER,
		harness: 'pi',
		model,
		tools: true,
		contextFiles: true,
		full: false,
		json: false
	};
}

export function loadPirunConfig(path: string, fallbackModel: string) {
	let parsed: (Partial<PirunConfig> & LegacyPirunConfig) | undefined;
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PirunConfig> & LegacyPirunConfig;
		} catch (error) {
			throw new Error(`Pirun configuration is not valid JSON: ${path} (${String(error)})`);
		}
	}
	const legacyModel = typeof parsed?.defaultModel === 'string' && parsed.defaultModel.trim()
		? parsed.defaultModel.trim()
		: fallbackModel;
	const config: PirunConfig = { version: 2, presets: {} };
	for (const [name, raw] of Object.entries(parsed?.presets ?? {})) {
		if (!raw || typeof raw !== 'object') continue;
		const value = raw as Partial<PirunPreset>;
		const harness: PirunHarness = value.harness === 'antigravity' ? 'antigravity' : 'pi';
		const preset: PirunPreset = {
			...defaultPreset(typeof value.model === 'string' && value.model.trim() ? value.model.trim() : legacyModel),
			...value,
			use: typeof value.use === 'string' && value.use.trim() ? value.use.trim() : '',
			harness
		};
		if (harness === 'antigravity' && !preset.model.trim()) preset.model = 'auto';
		config.presets[name] = preset;
	}
	return { config, legacyModel };
}

export function writePirunConfig(path: string, config: PirunConfig) {
	atomicWriteJson(path, config);
}

/**
 * One-time upgrade of v1 presets into the shared provider store. Antigravity
 * presets become harness accounts named after the preset — the derived profile
 * directory is identical, so existing logins keep working with no
 * reauthentication. Direct-API presets become custom endpoints; bundled-proxy
 * presets simply point at `bundled`.
 */
export function migratePresetsToProviders(config: PirunConfig, store: ProvidersStore) {
	let configChanged = false;
	let storeChanged = false;
	for (const [name, preset] of Object.entries(config.presets)) {
		if (preset.antigravity) {
			if (preset.antigravity.effort && !preset.effort) preset.effort = preset.antigravity.effort;
			if (preset.antigravity.agent && !preset.antigravityAgent) preset.antigravityAgent = preset.antigravity.agent;
			delete preset.antigravity;
			configChanged = true;
		}
		if (preset.use) {
			if (preset.api) {
				delete preset.api;
				configChanged = true;
			}
			continue;
		}
		configChanged = true;
		if (preset.harness === 'antigravity') {
			const harness = (store.harnesses.antigravity ??= { accounts: {} });
			if (!harness.accounts[name]) {
				harness.accounts[name] = {};
				storeChanged = true;
			}
			preset.use = `antigravity/${name}`;
			continue;
		}
		if (preset.api) {
			const providerName = name.toLowerCase();
			const entry = (store.endpoints[providerName] ??= { accounts: {} });
			entry.custom = true;
			entry.baseUrl = preset.api.baseUrl.replace(/\/+$/, '');
			entry.compat = {
				authHeader: preset.api.authHeader !== false,
				supportsDeveloperRole: preset.api.supportsDeveloperRole !== false,
				supportsReasoningEffort: preset.api.supportsReasoningEffort === true
			};
			if (!entry.accounts.main) entry.accounts.main = { key: preset.api.apiKey?.trim() || '' };
			entry.modelOverrides ??= {};
			entry.modelOverrides[preset.model] = {
				contextWindow: preset.api.contextWindow ?? 128_000,
				maxTokens: preset.api.maxTokens ?? 32_768,
				reasoning: preset.api.reasoning === true
			};
			storeChanged = true;
			preset.use = `${providerName}/main`;
			if (preset.api.reasoning && !preset.effort) preset.effort = 'medium';
			delete preset.api;
			continue;
		}
		preset.use = BUNDLED_PROVIDER;
	}
	return { configChanged, storeChanged };
}

/** Stable Pi provider id per provider/account, without URLs or credentials. */
export function piProviderIdForUse(use: string) {
	const safe = use.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'endpoint';
	const hash = createHash('sha256').update(use).digest('hex').slice(0, 8);
	return `pirun-${safe.slice(0, 40)}-${hash}`;
}

function piModelRow(model: CatalogModel, provider: string) {
	return {
		id: model.id,
		name: `${model.id} (${provider})`,
		reasoning: Boolean(model.reasoning || model.alwaysReasoning),
		input: ['text'],
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 32_768,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
	};
}

/**
 * Register a provider/account pair as a native Pi `openai-completions`
 * provider carrying the whole known model catalog (plus the requested model,
 * even if the catalog has never heard of it). Presets sharing the pair share
 * the registration.
 */
export function syncPiEndpointProvider(
	modelsPath: string,
	store: ProvidersStore,
	provider: string,
	account: string,
	requestedModel: string
) {
	if (!modelsPath) throw new Error('No home directory is available for Pi models.json.');
	const baseUrl = endpointBaseUrl(store, provider);
	if (!baseUrl) throw new Error(`provider "${provider}" has no base URL.`);
	const key = store.endpoints[provider]?.accounts[account]?.key ?? '';
	let document: PiModelDocument = {};
	if (existsSync(modelsPath)) {
		try {
			document = JSON.parse(readFileSync(modelsPath, 'utf8')) as PiModelDocument;
		} catch (error) {
			throw new Error(`Pi model registry is not valid JSON: ${modelsPath} (${String(error)})`);
		}
	}
	document.providers ??= {};
	const providerId = piProviderIdForUse(`${provider}/${account}`);
	const compat = endpointCompat(store, provider);
	const models = endpointModels(store, provider);
	if (requestedModel && !models.some((model) => model.id === requestedModel)) {
		models.push({ id: requestedModel });
	}
	document.providers[providerId] = {
		baseUrl: baseUrl.replace(/\/+$/, ''),
		api: 'openai-completions',
		apiKey: key || 'local',
		authHeader: compat.authHeader,
		compat: {
			supportsDeveloperRole: compat.supportsDeveloperRole,
			supportsReasoningEffort: compat.supportsReasoningEffort
		},
		models: models.map((model) => piModelRow(model, provider))
	};
	atomicWriteJson(resolve(dirname(modelsPath), 'models.json'), document);
	return providerId;
}

export function removePiEndpointProvider(modelsPath: string, use: string) {
	if (!modelsPath || !existsSync(modelsPath)) return false;
	let document: PiModelDocument;
	try {
		document = JSON.parse(readFileSync(modelsPath, 'utf8')) as PiModelDocument;
	} catch (error) {
		throw new Error(`Pi model registry is not valid JSON: ${modelsPath} (${String(error)})`);
	}
	const providerId = piProviderIdForUse(use);
	if (!document.providers?.[providerId]) return false;
	delete document.providers[providerId];
	atomicWriteJson(modelsPath, document);
	return true;
}
