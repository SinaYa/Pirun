/** Inspection and maintenance commands: status, config, models, jobs, log, clean. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagString, type PirunArgs as Args } from '../pirun-args.ts';
import { syncPiEndpointProvider, writePirunConfig } from '../pirun-config.ts';
import {
	endpointBaseUrl,
	endpointModels,
	providersStorePath,
	resolveEndpointModel,
	writeProvidersStore
} from '../pirun-providers.ts';
import {
	antigravityBaseArgs,
	antigravityEnv,
	antigravityIsolationMode,
	findAntigravityEntry,
	hasAntigravityAuthMarker,
	inspectAntigravityProfile
} from '../pirun-antigravity.ts';
import { fetchEndpointModels, resolveAccountKey } from '../pirun-provider-net.ts';
import {
	die,
	humanTokens,
	isAlive,
	out,
	PIRUN_CONFIG,
	RUNS_DIR,
	SESSIONS_DIR,
	state,
	truncate
} from './context.ts';
import { knownPiModels, PI_CANDIDATES, piModelsFile } from './pi.ts';
import { resolveModel } from './preset.ts';
import { jobDir, listAgents, presetJobs, readPresetJob, removeOrphanSessions } from './store.ts';
import { buildDigest } from './digest.ts';
import { finaliseIfExited } from './spawn.ts';
import { antigravityAccountProfileDir } from './auth.ts';

export async function commandStatus() {
	out(`preset  ${state.presetName}`);
	out(`use     ${state.preset.use}  (${state.preset.harness === 'antigravity' ? 'Antigravity account' : 'OpenAI completions endpoint'})`);
	if (state.preset.harness === 'antigravity') {
		let entry = '';
		try { entry = findAntigravityEntry(); } catch { /* shown below */ }
		const profile = antigravityAccountProfileDir(state.use.account);
		out(`agy     ${entry || 'not found'}`);
		out(`profile ${profile}`);
		out(`login   ${hasAntigravityAuthMarker(profile) ? 'ready (isolated file storage)' : 'required'}`);
		if (inspectAntigravityProfile(profile).ineligible) out('account ineligible in the current location');
	} else {
		const entry = PI_CANDIDATES.find((candidate) => existsSync(candidate));
		out(`pi      ${entry ? entry : 'not found on the usual paths'}`);
		const models = knownPiModels();
		out(`models  ${models.length} registered in ${piModelsFile() || '(no home dir)'}`);
	}
	out(`default ${state.defaultModel}`);
	out(`runs    ${presetJobs().length} for this preset in ${RUNS_DIR}`);
}

export function commandConfig() {
	const shown = {
		file: PIRUN_CONFIG,
		providers: providersStorePath(),
		preset: state.presetName,
		use: state.preset.use,
		harness: state.preset.harness,
		model: state.preset.model,
		effort: state.preset.effort ?? '(model default)',
		prefix: state.preset.prefix ?? '',
		dir: state.preset.dir ?? '(invocation cwd)',
		tools: state.preset.tools,
		contextFiles: state.preset.contextFiles,
		full: state.preset.full,
		json: state.preset.json,
		api: state.preset.harness === 'antigravity'
			? {
				mode: 'antigravity-account',
				baseUrl: '(managed by agy)',
				profile: antigravityAccountProfileDir(state.use.account),
				authenticated: hasAntigravityAuthMarker(antigravityAccountProfileDir(state.use.account)),
				agent: state.preset.antigravityAgent ?? '(default)'
			}
			: {
				mode: 'openai-completions',
				baseUrl: endpointBaseUrl(state.providersStore, state.use.provider),
				account: state.use.account
			},
		presets: Object.keys(state.config.presets).sort()
	};
	if (state.preset.json) out(JSON.stringify(shown, null, 2));
	else {
		out(`preset  ${shown.preset}  (${shown.harness})`);
		out(`config  ${shown.file}`);
		out(`store   ${shown.providers}`);
		out(`use     ${shown.use}  (${shown.api.mode}  ${shown.api.baseUrl})`);
		out(`model   ${shown.model}   effort ${shown.effort}`);
		out(`dir     ${shown.dir}`);
		out(`tools   ${shown.tools ? 'on' : 'off'}   context-files ${shown.contextFiles ? 'on' : 'off'}`);
		out(`output  ${shown.full ? 'full' : 'digest'}  ${shown.json ? 'json' : 'text'}`);
		if (state.preset.harness === 'antigravity') {
			const api = shown.api as { profile: string; authenticated: boolean; agent: string };
			out(`profile ${api.profile}`);
			out(`login   ${api.authenticated ? 'ready' : 'required'}   agy-agent ${api.agent}`);
		}
		// The exact prefix, verbatim: a caller must be able to read back the
		// standing instructions it (or someone else) persisted.
		if (shown.prefix) {
			out(`prefix  (${shown.prefix.length} chars)`);
			for (const line of shown.prefix.split(/\r?\n/)) out(`  ${line}`);
		} else {
			out('prefix  (none)');
		}
	}
}

export async function commandModels(args: Args) {
	if (state.preset.harness === 'antigravity') {
		try {
			const profileDir = antigravityAccountProfileDir(state.use.account);
			const text = execFileSync(findAntigravityEntry(), [...antigravityBaseArgs(profileDir), 'models'], {
				encoding: 'utf8',
				windowsHide: true,
				env: antigravityEnv(antigravityIsolationMode(profileDir))
			});
			const filter = (args.positional[0] ?? '').toLowerCase();
			for (const line of text.split(/\r?\n/)) {
				if (!filter || line.toLowerCase().includes(filter)) out(line);
			}
			return;
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	}
	{
		const provider = state.use.provider;
		if (args.flags.has('refresh')) {
			try {
				const key = resolveAccountKey(
					state.providersStore.endpoints[provider]?.accounts[state.use.account]?.key ?? ''
				);
				const ids = await fetchEndpointModels(state.providersStore, provider, key);
				const entry = (state.providersStore.endpoints[provider] ??= { accounts: {} });
				entry.fetchedModels = ids;
				entry.fetchedAt = Date.now();
				writeProvidersStore(state.providersStore);
				out(`fetched ${ids.length} models from ${provider}.`);
			} catch (error) {
				die(error instanceof Error ? error.message : String(error));
			}
		}
		const filter = (args.positional[0] ?? '').toLowerCase();
		const models = endpointModels(state.providersStore, provider).filter(
			(model) => !filter || model.id.toLowerCase().includes(filter)
		);
		if (!models.length) {
			out(filter
				? `no ${provider} model matches "${filter}".`
				: `no known models for ${provider}. Fetch the live list: pirun models ${state.presetName} --refresh`);
			return;
		}
		if (args.flags.has('json')) {
			out(JSON.stringify({ provider, current: state.preset.model, models }, null, 2));
			return;
		}
		out(`${'  model'.padEnd(46)}${'ctx'.padStart(7)}${'out'.padStart(8)}   reasoning`);
		for (const model of models) {
			const mark = model.id === state.preset.model ? '* ' : '  ';
			const reasoning = model.alwaysReasoning ? 'always-on' : model.reasoning ? 'levels' : '-';
			out(
				`${mark}${model.id.padEnd(44)}` +
					`${humanTokens(model.contextWindow ?? 0).padStart(7)}${humanTokens(model.maxTokens ?? 0).padStart(8)}   ${reasoning}`
			);
		}
		out('');
		out(`* current. Change with: pirun model ${state.presetName} <id>   refresh: pirun models ${state.presetName} --refresh`);
	}
}

export function commandModel(args: Args) {
	const wanted = args.positional[0];
	if (!wanted) {
		out(state.preset.model);
		out(state.preset.harness === 'antigravity'
			? `provider: Antigravity account (${state.preset.use})`
			: `provider: ${state.preset.use} (${endpointBaseUrl(state.providersStore, state.use.provider)})`);
		if (state.preset.effort) out(`effort: ${state.preset.effort}`);
		return;
	}
	let resolved = wanted;
	if (state.preset.harness !== 'antigravity') {
		try {
			resolved = resolveEndpointModel(state.providersStore, state.use.provider, wanted);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	}
	state.preset.model = resolved;
	state.config.presets[state.presetName] = state.preset;
	writePirunConfig(PIRUN_CONFIG, state.config);
	if (state.use.kind === 'endpoint') {
		syncPiEndpointProvider(piModelsFile(), state.providersStore, state.use.provider, state.use.account, resolved);
	}
	state.defaultModel = resolveModel(resolved);
	out(`preset "${state.presetName}" now uses ${resolved}`);
}

export function commandJobs() {
	const jobs = presetJobs().slice(0, 20);
	if (!jobs.length) {
		out('no runs yet.');
		return;
	}
	for (const job of jobs) {
		const meta = finaliseIfExited(job);
		const digest = buildDigest(meta.id, meta);
		out(
			`${meta.id}  ${digest.status.padEnd(7)} ${new Date(meta.startedAt).toISOString().slice(11, 19)}  ` +
				`${meta.model.padEnd(40)} ${truncate(meta.task, 60)}`
		);
	}
}

export function commandLog(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	readPresetJob(id);
	const path = resolve(jobDir(id), 'events.jsonl');
	if (!existsSync(path)) die(`no events for "${id}".`);
	const grep = flagString(args, 'grep');
	const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
	for (const line of grep ? lines.filter((l) => l.includes(grep)) : lines) out(line);
}

export function commandClean(args: Args) {
	if (args.flags.has('sessions')) {
		const removed = removeOrphanSessions(Number.POSITIVE_INFINITY);
		out(`removed ${removed} orphaned session${removed === 1 ? '' : 's'} from ${SESSIONS_DIR}`);
		return;
	}
	const all = args.flags.has('all');
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	let removed = 0;
	const live = new Set(listAgents().flatMap((agent) => agent.runs));
	for (const job of presetJobs()) {
		if (!all && job.startedAt >= cutoff) continue;
		if (job.pid && isAlive(job.pid)) continue;
		if (live.has(job.id) && !all) continue;
		rmSync(jobDir(job.id), { recursive: true, force: true });
		removed += 1;
	}
	out(`removed ${removed} run${removed === 1 ? '' : 's'} from ${RUNS_DIR}`);
}
