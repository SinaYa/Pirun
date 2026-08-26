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
import {
	accountEnvVar,
	CANONICAL_ENDPOINTS,
	endpointEnvVar,
	HARNESS_PROVIDERS,
	validAccountName,
	type CatalogModel,
	type EndpointCompat
} from './pirun-provider-catalog.ts';

/* -------------------------------------------------------------------------- */
/* store shape                                                                */
/* -------------------------------------------------------------------------- */

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
/* --use resolution                                                           */
/* -------------------------------------------------------------------------- */

export type UseKind = 'endpoint' | 'harness';

export interface ResolvedUse {
	kind: UseKind;
	provider: string;
	account: string;
	/** True when the account was created during this resolution and the store must be saved. */
	created: boolean;
}

export function knownProviderNames(store: ProvidersStore) {
	return [
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
 * `deepseek`, `deepseek/work`, `antigravity/luigi`. Mutates the store when an
 * account is auto-created (from a detected env var, or a fresh harness account
 * awaiting login) — check `created` and persist.
 */
export function resolveUse(store: ProvidersStore, raw: string): ResolvedUse {
	const [providerRaw, accountRaw = '', ...extra] = raw.trim().split('/');
	const provider = providerRaw.toLowerCase();
	if (!provider || extra.length) {
		throw new Error(`--use takes provider[/account] (got "${raw}"). See: pirun providers`);
	}
	if (provider === 'bundled') {
		throw new Error(
			'the bundled proxy was removed; a proxy is just another endpoint now.\n' +
				'register it: pirun provider add <name> --base-url <url>   then: --use <name>'
		);
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

export * from './pirun-provider-catalog.ts';
