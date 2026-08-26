/** Preset loading, flag persistence, and model/effort resolution. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagString, type PirunArgs as Args } from '../pirun-args.ts';
import {
	defaultPreset,
	loadPirunConfig,
	migratePresetsToProviders,
	piProviderIdForUse,
	syncPiEndpointProvider,
	validPresetName,
	writePirunConfig,
	type PirunPreset
} from '../pirun-config.ts';
import {
	endpointModels,
	parseEffortIntent,
	resolveEndpointModel,
	resolveUse,
	writeProvidersStore
} from '../pirun-providers.ts';
import { parseTimeSpec } from '../pirun-time.ts';
import { loadEnvFile } from '../env.ts';
import { die, PIRUN_CONFIG, state } from './context.ts';
import { piModelsFile } from './pi.ts';

export function positiveFlagInteger(args: Args, name: string, fallback: number) {
	const raw = flagString(args, name);
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) die(`--${name} must be a positive integer.`);
	return parsed;
}

export function persistentBoolean(
	args: Args,
	positive: string,
	negative: string,
	current: boolean
) {
	if (args.flags.has(positive) && args.flags.has(negative)) {
		die(`--${positive} and --${negative} cannot be used together.`);
	}
	if (args.flags.has(positive)) return true;
	if (args.flags.has(negative)) return false;
	return current;
}

export function validateApiBaseUrl(raw: string) {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
		return raw.replace(/\/+$/, '');
	} catch {
		die(`--api-base-url must be an absolute http(s) URL (usually ending in /v1).`);
	}
}

/** Timers are mandatory for every agent start; there is no default lifetime. */
export function requestedTimeSpec(args: Args) {
	try {
		return parseTimeSpec(flagString(args, 'time'));
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
}

export function resolveModel(input: string) {
	if (state.preset.harness === 'antigravity') return input || state.preset.model || 'auto';
	const id = input
		? resolveEndpointModel(state.providersStore, state.use.provider, input)
		: state.preset.model;
	return `${piProviderIdForUse(state.preset.use)}/${id}`;
}

/**
 * Load the selected preset, merge explicitly supplied persistent settings into
 * it, then hydrate omitted flags from the result. Prompt and timer flags are
 * deliberately absent from this function and therefore never reach the file.
 */
export function configurePreset(args: Args) {
	const name = (args.positional.shift() ?? '').trim();
	if (!name) die(`a preset name is required after "${args.command}" (for example: pirun ${args.command} work …).`);
	if (!validPresetName(name)) die(`"${name}" is not a usable preset name (letters, digits, . _ -).`);

	let loaded: ReturnType<typeof loadPirunConfig>;
	try {
		loaded = loadPirunConfig(PIRUN_CONFIG);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	// v1 presets carried authentication; move it into the shared store once.
	const migrated = migratePresetsToProviders(loaded.config, state.providersStore);
	if (migrated.storeChanged) writeProvidersStore(state.providersStore);
	if (migrated.configChanged) writePirunConfig(PIRUN_CONFIG, loaded.config);
	const preset: PirunPreset = structuredClone(loaded.config.presets[name] ?? defaultPreset());
	loadEnvFile();

	const requestedHarness = flagString(args, 'harness').trim().toLowerCase();
	if (requestedHarness && requestedHarness !== 'pi' && requestedHarness !== 'antigravity') {
		die('--harness must be "pi" or "antigravity".');
	}
	const useRaw = flagString(args, 'use').trim();
	if (useRaw) preset.use = useRaw;
	else if (requestedHarness === 'antigravity' && preset.harness !== 'antigravity') preset.use = 'antigravity';
	else if (requestedHarness === 'pi' && preset.harness === 'antigravity') {
		die('--harness pi needs an endpoint to talk to; pass --use <provider[/account]> (see: pirun providers).');
	}
	if (!preset.use.trim()) {
		die(`preset "${name}" has no provider; pass --use <provider[/account]> (see: pirun providers).`);
	}

	try {
		state.use = resolveUse(state.providersStore, preset.use);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	if (state.use.created) writeProvidersStore(state.providersStore);
	preset.use = `${state.use.provider}/${state.use.account}`;
	const harness: PirunPreset['harness'] = state.use.kind === 'harness' ? 'antigravity' : 'pi';
	if (harness !== preset.harness) {
		preset.harness = harness;
		// The old model belongs to the old source; reset unless one was named.
		if (!flagString(args, 'model').trim()) {
			preset.model = harness === 'antigravity' ? 'auto' : '';
		}
	}

	const model = flagString(args, 'model').trim();
	if (model) {
		try {
			preset.model = harness === 'antigravity'
				? model
				: resolveEndpointModel(state.providersStore, state.use.provider, model);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	} else if (state.use.kind === 'endpoint' && !preset.model.trim()) {
		const known = endpointModels(state.providersStore, state.use.provider);
		if (known.length === 1) preset.model = known[0].id;
	}
	if (!preset.model.trim()) die(`the selected preset has no model; pass --model <id> (see: pirun models ${name}).`);

	const effortRaw = flagString(args, 'effort').trim().toLowerCase();
	if (effortRaw) {
		try {
			parseEffortIntent(effortRaw);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
		preset.effort = effortRaw;
	}
	const antigravityAgent = flagString(args, 'antigravity-agent').trim();
	if (antigravityAgent) {
		if (harness !== 'antigravity') die('--antigravity-agent requires an Antigravity preset (--use antigravity).');
		preset.antigravityAgent = antigravityAgent;
	}

	const prefix = flagString(args, 'prefix');
	const prefixFile = flagString(args, 'prefix-file');
	if ((prefix || prefixFile) && args.flags.has('no-prefix')) die('--no-prefix cannot be combined with --prefix.');
	if (prefix && prefixFile) die('--prefix and --prefix-file cannot be used together.');
	if (prefix) preset.prefix = prefix;
	if (prefixFile) {
		if (!existsSync(prefixFile)) die(`prefix file not found: ${prefixFile}`);
		preset.prefix = readFileSync(prefixFile, 'utf8').trim();
	}
	if (args.flags.has('no-prefix')) delete preset.prefix;

	const dir = flagString(args, 'dir');
	if (dir) preset.dir = resolve(dir);
	preset.tools = persistentBoolean(args, 'tools', 'no-tools', preset.tools);
	preset.contextFiles = persistentBoolean(args, 'context-files', 'no-context-files', preset.contextFiles);
	preset.full = persistentBoolean(args, 'full', 'no-full', preset.full);
	preset.json = persistentBoolean(args, 'json', 'no-json', preset.json);

	loaded.config.presets[name] = preset;
	writePirunConfig(PIRUN_CONFIG, loaded.config);
	state.presetName = name;
	state.preset = preset;
	state.config = loaded.config;

	if (preset.harness === 'antigravity') {
		state.defaultModel = preset.model;
	} else {
		try {
			const providerId = syncPiEndpointProvider(
				piModelsFile(),
				state.providersStore,
				state.use.provider,
				state.use.account,
				preset.model
			);
			state.defaultModel = `${providerId}/${preset.model}`;
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	}

	args.flags.set('model', preset.model);
	if (preset.dir) args.flags.set('dir', preset.dir);
	if (!preset.tools) args.flags.set('no-tools', true);
	else args.flags.delete('no-tools');
	if (!preset.contextFiles) args.flags.set('no-context-files', true);
	else args.flags.delete('no-context-files');
	if (preset.full) args.flags.set('full', true);
	else args.flags.delete('full');
	if (preset.json) args.flags.set('json', true);
	else args.flags.delete('json');
}
