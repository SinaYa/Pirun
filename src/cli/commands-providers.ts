/** Provider-store commands: providers, provider add/key/default/rm/model, login, logout. */

import { existsSync, renameSync } from 'node:fs';
import { flagString, type PirunArgs as Args } from '../pirun-args.ts';
import {
	loadPirunConfig,
	migratePresetsToProviders
} from '../pirun-config.ts';
import {
	accountEnvVar,
	CANONICAL_ENDPOINTS,
	catalogModel,
	detectedEnvAccounts,
	endpointBaseUrl,
	endpointCompat,
	endpointEnvVar,
	endpointModels,
	HARNESS_PROVIDERS,
	providersStorePath,
	validAccountName,
	validProviderName,
	writeProvidersStore
} from '../pirun-providers.ts';
import { hasAntigravityAuthMarker } from '../pirun-antigravity.ts';
import {
	die,
	humanTokens,
	out,
	PIRUN_CONFIG,
	state
} from './context.ts';
import { persistentBoolean, positiveFlagInteger, validateApiBaseUrl } from './preset.ts';
import {
	antigravityAccountProfileDir,
	holdLoginWindowOpen,
	loginAntigravityAccount,
	loginAntigravityWindowed
} from './auth.ts';

function maskKey(key: string) {
	if (!key) return '(missing)';
	if (key.startsWith('$')) return key;
	if (key.startsWith('!')) return '(credential command)';
	return '(literal)';
}

function providerRows() {
	const store = state.providersStore;
	const rows: Array<Record<string, unknown>> = [];
	for (const name of [...new Set([...Object.keys(CANONICAL_ENDPOINTS), ...Object.keys(store.endpoints)])].sort()) {
		const entry = store.endpoints[name];
		const accounts = Object.entries(entry?.accounts ?? {}).map(([account, value]) => ({
			account,
			key: maskKey(value.key),
			ready: value.key.startsWith('$') ? Boolean(process.env[value.key.slice(1)]) : Boolean(value.key)
		}));
		rows.push({
			name,
			kind: 'endpoint',
			canonical: Boolean(CANONICAL_ENDPOINTS[name]),
			baseUrl: endpointBaseUrl(store, name),
			envVar: endpointEnvVar(name),
			accounts,
			detected: detectedEnvAccounts(store, name),
			defaultAccount: entry?.defaultAccount ?? (accounts.length === 1 ? accounts[0].account : ''),
			models: endpointModels(store, name).map((model) => model.id),
			spend: Boolean(CANONICAL_ENDPOINTS[name]?.spend)
		});
	}
	for (const name of HARNESS_PROVIDERS) {
		const entry = store.harnesses[name];
		const accounts = Object.keys(entry?.accounts ?? {}).map((account) => ({
			account,
			key: '(oauth profile)',
			ready: hasAntigravityAuthMarker(antigravityAccountProfileDir(account))
		}));
		rows.push({
			name,
			kind: 'harness',
			canonical: true,
			accounts,
			defaultAccount: entry?.defaultAccount ?? (accounts.length === 1 ? accounts[0].account : ''),
			login: `pirun login ${name} <account>`
		});
	}
	return rows;
}

export function commandProviders(args: Args) {
	const presetUses: Record<string, string> = {};
	try {
		const loaded = loadPirunConfig(PIRUN_CONFIG);
		migratePresetsToProviders(loaded.config, state.providersStore);
		for (const [name, preset] of Object.entries(loaded.config.presets)) presetUses[name] = preset.use;
	} catch {
		/* presets are optional context here */
	}
	const rows = providerRows();
	if (args.flags.has('json')) {
		out(JSON.stringify({ store: providersStorePath(), providers: rows, presets: presetUses }, null, 2));
		return;
	}
	for (const row of rows) {
		const accounts = row.accounts as Array<{ account: string; key: string; ready: boolean }>;
		const detected = (row.detected as Array<{ account: string; envVar: string }> | undefined) ?? [];
		const headline = `${String(row.name).padEnd(12)} ${row.kind}${row.canonical ? '' : ' (custom)'}  ${row.baseUrl ?? ''}`;
		out(headline.trimEnd());
		for (const account of accounts) {
			const mark = account.account === row.defaultAccount && accounts.length > 1 ? '*' : ' ';
			out(`  ${mark}${account.account.padEnd(14)} ${account.key}  ${account.ready ? 'ready' : 'NOT READY'}`);
		}
		for (const hint of detected) {
			out(`   ${hint.account.padEnd(14)} ${'$' + hint.envVar}  detected (use --use ${row.name}/${hint.account})`);
		}
		if (!accounts.length && !detected.length && row.kind === 'endpoint') {
			out(`   no accounts — set ${row.envVar} or run: pirun provider key ${row.name} main --env <VAR>`);
		}
		if (!accounts.length && row.kind === 'harness') {
			out(`   no accounts — run: pirun login ${row.name} <account>`);
		}
	}
	out('');
	out(`store   ${providersStorePath()}`);
	if (Object.keys(presetUses).length) {
		out(`presets ${Object.entries(presetUses).map(([name, use]) => `${name}→${use}`).join('  ')}`);
	}
}

function requireEndpointName(raw: string | undefined, verb: string) {
	const name = (raw ?? '').trim().toLowerCase();
	if (!name || !validProviderName(name)) die(`usage: pirun provider ${verb} <provider> …`);
	return name;
}

export async function commandProvider(args: Args) {
	const store = state.providersStore;
	const sub = (args.positional[0] ?? '').trim().toLowerCase();
	if (sub === 'add' || sub === 'set') {
		const name = requireEndpointName(args.positional[1], sub);
		if (sub === 'add' && (HARNESS_PROVIDERS as readonly string[]).includes(name)) {
			die(`"${name}" is a canonical harness; add its accounts with: pirun login ${name} <account>`);
		}
		const entry = (store.endpoints[name] ??= { accounts: {} });
		const baseUrl = flagString(args, 'base-url').trim();
		if (baseUrl) entry.baseUrl = validateApiBaseUrl(baseUrl);
		if (!CANONICAL_ENDPOINTS[name]) {
			entry.custom = true;
			if (!entry.baseUrl) die(`custom provider "${name}" needs --base-url <url>.`);
		}
		const compat = (entry.compat ??= {});
		if (args.flags.has('auth-header') || args.flags.has('no-auth-header')) {
			compat.authHeader = persistentBoolean(args, 'auth-header', 'no-auth-header', compat.authHeader ?? true);
		}
		if (args.flags.has('developer-role') || args.flags.has('no-developer-role')) {
			compat.supportsDeveloperRole = persistentBoolean(
				args, 'developer-role', 'no-developer-role', compat.supportsDeveloperRole ?? true
			);
		}
		if (args.flags.has('reasoning-effort') || args.flags.has('no-reasoning-effort')) {
			compat.supportsReasoningEffort = persistentBoolean(
				args, 'reasoning-effort', 'no-reasoning-effort', compat.supportsReasoningEffort ?? false
			);
		}
		writeProvidersStore(store);
		out(`provider "${name}"  ${endpointBaseUrl(store, name)}`);
		const shown = endpointCompat(store, name);
		out(`compat  bearer-header ${shown.authHeader ? 'on' : 'off'}  developer-role ${shown.supportsDeveloperRole ? 'on' : 'off'}  reasoning-effort ${shown.supportsReasoningEffort ? 'on' : 'off'}`);
		return;
	}
	if (sub === 'key') {
		const name = requireEndpointName(args.positional[1], 'key <provider> <account>');
		const account = (args.positional[2] ?? '').trim();
		if (!account || !validAccountName(account)) die('usage: pirun provider key <provider> <account> [--env VAR | --key VALUE]');
		if (!CANONICAL_ENDPOINTS[name] && !store.endpoints[name]?.baseUrl) {
			die(`unknown provider "${name}". For a custom endpoint, first: pirun provider add ${name} --base-url <url>`);
		}
		const env = flagString(args, 'env').trim();
		const literal = flagString(args, 'key');
		if (env && literal) die('--env and --key cannot be used together.');
		let key = '';
		if (env) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) die('--env must name an environment variable.');
			key = `$${env}`;
		} else if (literal) {
			key = literal;
		} else {
			// No source named: accept the conventional variables when present.
			const suffixVar = accountEnvVar(name, account);
			const baseVar = endpointEnvVar(name);
			if (process.env[suffixVar]) key = `$${suffixVar}`;
			else if (account === 'main' && process.env[baseVar]) key = `$${baseVar}`;
			else die(`no key given and neither ${suffixVar} nor ${baseVar} is set. Pass --env <VAR> or --key <value>.`);
		}
		const entry = (store.endpoints[name] ??= { accounts: {} });
		entry.accounts[account] = { key };
		writeProvidersStore(store);
		out(`${name}/${account}  ${maskKey(key)}`);
		return;
	}
	if (sub === 'default') {
		const name = requireEndpointName(args.positional[1], 'default <provider> <account>');
		const account = (args.positional[2] ?? '').trim();
		const entry = (HARNESS_PROVIDERS as readonly string[]).includes(name)
			? store.harnesses[name]
			: store.endpoints[name];
		if (!entry?.accounts[account]) die(`no account "${account}" for provider "${name}".`);
		entry.defaultAccount = account;
		writeProvidersStore(store);
		out(`${name} now defaults to account "${account}".`);
		return;
	}
	if (sub === 'rm') {
		const target = (args.positional[1] ?? '').trim().toLowerCase();
		const [name, account] = target.split('/');
		if (!name) die('usage: pirun provider rm <provider>[/<account>]');
		const entry = store.endpoints[name];
		if (!entry) die(`no configured provider "${name}".`);
		if (account) {
			if (!entry.accounts[account]) die(`no account "${account}" for provider "${name}".`);
			delete entry.accounts[account];
			if (entry.defaultAccount === account) delete entry.defaultAccount;
			out(`removed ${name}/${account}.`);
		} else {
			delete store.endpoints[name];
			out(`removed provider "${name}" and its accounts.`);
		}
		writeProvidersStore(store);
		return;
	}
	if (sub === 'model') {
		const name = requireEndpointName(args.positional[1], 'model <provider> <model-id>');
		const modelId = (args.positional[2] ?? '').trim();
		if (!modelId) die('usage: pirun provider model <provider> <model-id> [--context-window n] [--max-tokens n] [--reasoning|--no-reasoning]');
		const entry = (store.endpoints[name] ??= { accounts: {} });
		entry.modelOverrides ??= {};
		const override = (entry.modelOverrides[modelId] ??= {});
		if (args.flags.has('context-window')) override.contextWindow = positiveFlagInteger(args, 'context-window', 128_000);
		if (args.flags.has('max-tokens')) override.maxTokens = positiveFlagInteger(args, 'max-tokens', 32_768);
		if (args.flags.has('reasoning') || args.flags.has('no-reasoning')) {
			override.reasoning = persistentBoolean(args, 'reasoning', 'no-reasoning', override.reasoning === true);
		}
		writeProvidersStore(store);
		const merged = catalogModel(store, name, modelId);
		out(`${name} ${modelId}  ctx ${humanTokens(merged?.contextWindow ?? 128_000)}  out ${humanTokens(merged?.maxTokens ?? 32_768)}  reasoning ${merged?.reasoning ? 'on' : 'off'}`);
		return;
	}
	die('usage: pirun provider add|set|key|default|rm|model …   (see: pirun help)');
}

export async function commandLogin(args: Args) {
	const harness = (args.positional[0] ?? '').trim().toLowerCase();
	const account = (args.positional[1] ?? '').trim();
	if (!(HARNESS_PROVIDERS as readonly string[]).includes(harness) || !account) {
		die(`usage: pirun login antigravity <account>   (harnesses: ${HARNESS_PROVIDERS.join(', ')})`);
	}
	if (!validAccountName(account)) die(`"${account}" is not a usable account name (letters, digits, . _ -).`);
	const entry = (state.providersStore.harnesses[harness] ??= { accounts: {} });
	if (!entry.accounts[account]) {
		entry.accounts[account] = {};
		writeProvidersStore(state.providersStore);
	}
	const holdOpen = args.flags.has('login-window');
	if (process.platform === 'win32' && !holdOpen && !args.flags.has('inline')) {
		await loginAntigravityWindowed(account);
		return;
	}
	try {
		await loginAntigravityAccount(account, true);
		if (holdOpen) {
			// A successful login window closes itself; the human is done here.
			await new Promise((resolveClose) => setTimeout(resolveClose, 3000));
			process.exit(0);
		}
	} catch (error) {
		if (!holdOpen) die(error instanceof Error ? error.message : String(error));
		// Keep a failed window open so the error stays readable.
		out(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		await holdLoginWindowOpen();
	}
}

export function commandLogout(args: Args) {
	const harness = (args.positional[0] ?? '').trim().toLowerCase();
	const account = (args.positional[1] ?? '').trim();
	if (!(HARNESS_PROVIDERS as readonly string[]).includes(harness) || !account) {
		die('usage: pirun logout antigravity <account>');
	}
	const entry = state.providersStore.harnesses[harness];
	if (!entry?.accounts[account]) die(`no ${harness} account "${account}".`);
	const profileDir = antigravityAccountProfileDir(account);
	if (existsSync(profileDir)) {
		// Recoverable removal: the profile (tokens included) is set aside, not
		// destroyed. Delete the retired directory by hand when certain.
		const retired = `${profileDir}-logged-out-${Date.now()}`;
		renameSync(profileDir, retired);
		out(`profile set aside at ${retired}`);
	}
	delete entry.accounts[account];
	if (entry.defaultAccount === account) delete entry.defaultAccount;
	writeProvidersStore(state.providersStore);
	out(`removed ${harness} account "${account}".`);
}
