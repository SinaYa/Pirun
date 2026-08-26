#!/usr/bin/env node
/**
 * pirun — a persistent front door to coding-agent harnesses.
 *
 * Pi's own non-interactive modes make an operating agent choose badly:
 *   `-p` prints the final message and nothing else, so a run that failed
 *   mid-stream is indistinguishable from a model that had nothing to say;
 *   `--mode json` tells you everything but costs hundreds of lines of event
 *   stream in the caller's context for a two-tool task.
 *
 * pirun takes the JSON stream, keeps it on disk in full, and hands back a
 * three-line digest. It also does the things the community subagent skills tell
 * you to remember — lean flags, prompt out of argv — by default instead of by
 * discipline, and it correlates a silent Pi run against the proxy's own log so
 * "empty answer" comes back with the upstream error attached.
 */

import { spawn } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	readdirSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { encode } from 'gpt-tokenizer';
import { CONFIG_DIR, PROJECT_DIR } from '../src/paths.ts';
import { loadSettings } from '../src/settings.ts';
import { loadEnvFile } from '../src/env.ts';
import { getModelDefaults } from '../src/inference-provider-config.ts';
import { ensurePirunRetryDefault } from '../src/pirun-pi-settings.ts';
import { flagString, parsePirunArgs, PROVIDER_COMMANDS, type PirunArgs as Args } from '../src/pirun-args.ts';
import {
	defaultPreset,
	loadPirunConfig,
	migratePresetsToProviders,
	piProviderIdForUse,
	removePiEndpointProvider,
	syncPiEndpointProvider,
	validPresetName,
	writePirunConfig,
	type PirunConfig,
	type PirunPreset
} from '../src/pirun-config.ts';
import {
	antigravityEffortLevel,
	accountEnvVar,
	BUNDLED_PROVIDER,
	CANONICAL_ENDPOINTS,
	catalogModel,
	detectedEnvAccounts,
	endpointBaseUrl,
	endpointCompat,
	endpointEnvVar,
	endpointModels,
	HARNESS_PROVIDERS,
	knownProviderNames,
	loadProvidersStore,
	parseEffortIntent,
	piThinkingLevel,
	providersStorePath,
	resolveEndpointModel,
	resolveUse,
	validAccountName,
	validProviderName,
	writeProvidersStore,
	type ProvidersStore,
	type ResolvedUse
} from '../src/pirun-providers.ts';
import { fetchEndpointModels, fetchSpend, resolveAccountKey } from '../src/pirun-provider-net.ts';
import {
	humanClock,
	parseTimeAdjust,
	parseTimeSpec,
	parseWaitTime,
	TIME_FLAG_HELP
} from '../src/pirun-time.ts';
import {
	acquireOwnedLock,
	atomicWriteJson,
	readOwnedLock,
	releaseOwnedLock,
	updateOwnedLock
} from '../src/pirun-files.ts';
import { terminateProcessTree } from '../src/pirun-process.ts';
import {
	antigravityAuthMarkerTime,
	antigravityBaseArgs,
	antigravityEnv,
	antigravityIsolationMode,
	antigravityOAuthUrl,
	antigravityProfileDir,
	antigravityRunArgs,
	findAntigravityEntry,
	hasAntigravityAuthMarker,
	inspectAntigravityProfile,
	markAntigravityAuthenticated,
	parseAntigravityUsage,
	type AntigravityIsolationMode,
	type AntigravityLimit
} from '../src/pirun-antigravity.ts';
import { DEFAULT_RETURN_AFTER_SECONDS } from '../src/timeouts.ts';

const settings = loadSettings();
const BASE_URL = `http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}`;
const RUNS_DIR = resolve(PROJECT_DIR, '.runs');
const AGENTS_DIR = resolve(RUNS_DIR, 'agents');
/**
 * Every agent's Pi session lives in one directory. Pi resolves `--session-id`
 * and `--fork` within a session directory, so keeping them together is what
 * makes forking one agent off another possible at all.
 */
const SESSIONS_DIR = resolve(RUNS_DIR, 'sessions');
const PROXY_LOG = resolve(RUNS_DIR, 'proxy.log');
const PROXY_PID = resolve(RUNS_DIR, 'proxy.pid');
const SERVER_ENTRY = resolve(PROJECT_DIR, 'src', 'server.ts');
const PIRUN_ENTRY = resolve(PROJECT_DIR, 'bin', 'pirun.ts');
const MAX_PROXY_LOG_BYTES = 10 * 1024 * 1024;
const RETENTION_DAYS = positiveEnvNumber('PIRUN_RETENTION_DAYS', 30);
const MAX_STORAGE_BYTES = positiveEnvNumber('PIRUN_MAX_STORAGE_MB', 1024) * 1024 * 1024;

/**
 * Default model. Deliberately a direct-provider one: the `commandcode.*` route
 * goes through the Command Code CLI, which prepends roughly 7,400 tokens of its
 * own system prompt to every single request. Pi's entire prompt is under 1,000.
 * Model choice is a bigger token lever here than any Pi flag.
 */
const PIRUN_CONFIG = process.env.PIRUN_CONFIG_PATH
	? resolve(process.env.PIRUN_CONFIG_PATH)
	: resolve(PROJECT_DIR, 'pirun.json');
const FALLBACK_MODEL = 'cladgpt-proxy/deepseek.deepseek-v4-flash';
let activePresetName = '';
let activePreset = defaultPreset(FALLBACK_MODEL);
let activeConfig: PirunConfig = { version: 2, presets: {} };
let DEFAULT_MODEL = FALLBACK_MODEL;
let providersStore: ProvidersStore = loadProvidersStore();
/** The preset's resolved provider/account, set by configurePreset. */
let activeUse: ResolvedUse = { kind: 'bundled', provider: BUNDLED_PROVIDER, account: '', created: false };

/** Flags that keep Pi from scanning disk and injecting things nobody asked for. */
const LEAN_FLAGS = [
	'--no-extensions',
	'--no-skills',
	'--no-prompt-templates',
	'--no-themes',
	'--offline'
];

const PI_CANDIDATES = [
	process.env.PIRUN_PI_ENTRY,
	process.env.APPDATA && resolve(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
	'/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
	process.env.HOME && resolve(process.env.HOME, '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
].filter((entry): entry is string => Boolean(entry));

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

// A caller piping into `head` closes stdout early. That is ordinary usage, not
// a crash — without this, pirun dies on an unhandled EPIPE with a stack trace
// where the caller expected output.
let stdoutClosed = false;
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code === 'EPIPE') {
		stdoutClosed = true;
		return;
	}
	throw error;
});

function out(line = '') {
	if (stdoutClosed) return;
	try {
		process.stdout.write(`${line}\n`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPIPE') stdoutClosed = true;
		else throw error;
	}
}

function die(message: string, code = 1): never {
	process.stderr.write(`pirun: ${message}\n`);
	process.exit(code);
}

function ensureRunsDir() {
	if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

function humanDuration(ms: number) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	return `${minutes}m${totalSeconds % 60}s`;
}

function humanTokens(value: number) {
	if (!value) return '0';
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

function truncate(value: string, max: number) {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function positiveEnvNumber(name: string, fallback: number) {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFlagInteger(args: Args, name: string, fallback: number) {
	const raw = flagString(args, name);
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) die(`--${name} must be a positive integer.`);
	return parsed;
}

function persistentBoolean(
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

function validateApiBaseUrl(raw: string) {
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
		return raw.replace(/\/+$/, '');
	} catch {
		die(`--api-base-url must be an absolute http(s) URL (usually ending in /v1).`);
	}
}

/**
 * Load the selected preset, merge explicitly supplied persistent settings into
 * it, then hydrate omitted flags from the result. Prompt and timer flags are
 * deliberately absent from this function and therefore never reach the file.
 */
function configurePreset(args: Args) {
	const name = (args.positional.shift() ?? '').trim();
	if (!name) die(`a preset name is required after "${args.command}" (for example: pirun ${args.command} work …).`);
	if (!validPresetName(name)) die(`"${name}" is not a usable preset name (letters, digits, . _ -).`);

	let loaded: ReturnType<typeof loadPirunConfig>;
	try {
		loaded = loadPirunConfig(PIRUN_CONFIG, FALLBACK_MODEL);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	// v1 presets carried authentication; move it into the shared store once.
	const migrated = migratePresetsToProviders(loaded.config, providersStore);
	if (migrated.storeChanged) writeProvidersStore(providersStore);
	if (migrated.configChanged) writePirunConfig(PIRUN_CONFIG, loaded.config);
	const preset: PirunPreset = structuredClone(
		loaded.config.presets[name] ?? defaultPreset(loaded.legacyModel)
	);
	loadEnvFile();

	const requestedHarness = flagString(args, 'harness').trim().toLowerCase();
	if (requestedHarness && requestedHarness !== 'pi' && requestedHarness !== 'antigravity') {
		die('--harness must be "pi" or "antigravity".');
	}
	const useRaw = flagString(args, 'use').trim();
	if (useRaw) preset.use = useRaw;
	else if (requestedHarness === 'antigravity' && preset.harness !== 'antigravity') preset.use = 'antigravity';
	else if (requestedHarness === 'pi' && preset.harness === 'antigravity') preset.use = BUNDLED_PROVIDER;

	try {
		activeUse = resolveUse(providersStore, preset.use || BUNDLED_PROVIDER);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	if (activeUse.created) writeProvidersStore(providersStore);
	preset.use = activeUse.kind === 'bundled'
		? BUNDLED_PROVIDER
		: `${activeUse.provider}/${activeUse.account}`;
	const harness: PirunPreset['harness'] = activeUse.kind === 'harness' ? 'antigravity' : 'pi';
	if (harness !== preset.harness) {
		preset.harness = harness;
		// The old model belongs to the old source; reset unless one was named.
		if (!flagString(args, 'model').trim()) {
			preset.model = harness === 'antigravity' ? 'auto' : activeUse.kind === 'bundled' ? FALLBACK_MODEL : '';
		}
	}

	const model = flagString(args, 'model').trim();
	if (model) {
		try {
			preset.model = harness === 'antigravity'
				? model
				: activeUse.kind === 'endpoint'
					? resolveEndpointModel(providersStore, activeUse.provider, model)
					: resolveProxyModel(model);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	} else if (activeUse.kind === 'endpoint' && !preset.model.trim()) {
		const known = endpointModels(providersStore, activeUse.provider);
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
	activePresetName = name;
	activePreset = preset;
	activeConfig = loaded.config;

	if (preset.harness === 'antigravity') {
		DEFAULT_MODEL = preset.model;
	} else if (activeUse.kind === 'endpoint') {
		try {
			const providerId = syncPiEndpointProvider(
				piModelsFile(),
				providersStore,
				activeUse.provider,
				activeUse.account,
				preset.model
			);
			DEFAULT_MODEL = `${providerId}/${preset.model}`;
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	} else {
		DEFAULT_MODEL = resolveProxyModel(preset.model);
		if (DEFAULT_MODEL !== preset.model) {
			preset.model = DEFAULT_MODEL;
			writePirunConfig(PIRUN_CONFIG, loaded.config);
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

/* -------------------------------------------------------------------------- */
/* argument parsing                                                           */
/* -------------------------------------------------------------------------- */

/** Timers are mandatory for every agent start; there is no default lifetime. */
function requestedTimeSpec(args: Args) {
	try {
		return parseTimeSpec(flagString(args, 'time'));
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
}

/* -------------------------------------------------------------------------- */
/* proxy lifecycle                                                            */
/* -------------------------------------------------------------------------- */

async function proxyIsUp(timeoutMs = 1500) {
	try {
		const response = await fetch(`${BASE_URL}/health`, {
			signal: AbortSignal.timeout(timeoutMs)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForProxy(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await proxyIsUp(1000)) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

async function startProxy() {
	if (await proxyIsUp()) return { started: false };
	ensureRunsDir();
	if (existsSync(PROXY_LOG) && statSync(PROXY_LOG).size >= MAX_PROXY_LOG_BYTES) {
		rmSync(`${PROXY_LOG}.1`, { force: true });
		renameSync(PROXY_LOG, `${PROXY_LOG}.1`);
	}
	const log = openSync(PROXY_LOG, 'a');
	const child = spawn(process.execPath, ['--no-warnings', SERVER_ENTRY], {
		cwd: PROJECT_DIR,
		detached: true,
		stdio: ['ignore', log, log],
		windowsHide: true
	});
	child.unref();
	if (child.pid) writeFileSync(PROXY_PID, String(child.pid));
	if (!(await waitForProxy(20_000))) {
		die(`the backing service did not start. See ${PROXY_LOG}`);
	}
	return { started: true };
}

async function stopProxy() {
	if (!(await proxyIsUp())) return 'not running';

	// Ask it to stop, so a proxy started by hand or by start.bat also obeys.
	try {
		const headers: Record<string, string> = {};
		if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
		await fetch(`${BASE_URL}/shutdown`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(3000)
		});
	} catch {
		/* the socket dying under us is the expected outcome */
	}
	if (!(await proxyIsUp(2000))) return 'stopped';

	// Fall back to the pid we recorded, if this proxy was ours.
	if (existsSync(PROXY_PID)) {
		const pid = Number.parseInt(readFileSync(PROXY_PID, 'utf8').trim(), 10);
		if (Number.isFinite(pid) && isAlive(pid)) {
			try {
				process.kill(pid);
				return 'stopped';
			} catch {
				/* fall through */
			}
		}
	}
	return 'still up';
}

/**
 * Proxy log lines inside a run's time window. This is how a silent Pi run gets
 * an explanation: Pi reports an empty assistant turn, the proxy knows it was a
 * 503 from the provider mid-stream.
 */
function proxyErrorsBetween(startedAt: number, finishedAt: number) {
	if (!existsSync(PROXY_LOG)) return [];
	const lines = readFileSync(PROXY_LOG, 'utf8').split(/\r?\n/);
	const found: string[] = [];
	for (const line of lines) {
		const match = /^\[([^\]]+)\]\s+error\s+(.*)$/.exec(line);
		if (!match) continue;
		const at = Date.parse(match[1]);
		if (!Number.isFinite(at)) continue;
		if (at >= startedAt - 2000 && at <= finishedAt + 2000) found.push(truncate(match[2], 200));
	}
	return found.slice(-4);
}

/* -------------------------------------------------------------------------- */
/* pi discovery and model resolution                                          */
/* -------------------------------------------------------------------------- */

let cachedPiEntry: string | null = null;

function findPiEntry() {
	if (cachedPiEntry) return cachedPiEntry;
	for (const candidate of PI_CANDIDATES) {
		if (existsSync(candidate)) {
			cachedPiEntry = candidate;
			return candidate;
		}
	}
	try {
		const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
		const candidate = resolve(root, '@earendil-works/pi-coding-agent/dist/cli.js');
		if (existsSync(candidate)) {
			cachedPiEntry = candidate;
			return candidate;
		}
	} catch {
		/* fall through to the error below */
	}
	die(
		'could not find the Pi CLI. Install it with "npm install -g @earendil-works/pi-coding-agent", ' +
			'or set PIRUN_PI_ENTRY to its dist/cli.js path.'
	);
}

function piModelsFile() {
	const home = process.env.USERPROFILE || process.env.HOME || '';
	return home ? resolve(home, '.pi/agent/models.json') : '';
}

interface PiModelRow {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

function knownPiModels(): PiModelRow[] {
	const path = piModelsFile();
	if (!path || !existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			providers?: Record<
				string,
				{
					models?: Array<{
						id: string;
						name?: string;
						contextWindow?: number;
						maxTokens?: number;
						reasoning?: boolean;
					}>;
				}
			>;
		};
		const rows: PiModelRow[] = [];
		for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
			for (const model of config.models ?? []) {
				rows.push({
					id: `${provider}/${model.id}`,
					name: model.name ?? model.id,
					provider,
					contextWindow: model.contextWindow ?? 0,
					maxTokens: model.maxTokens ?? 0,
					reasoning: Boolean(model.reasoning)
				});
			}
		}
		return rows;
	} catch {
		return [];
	}
}

/**
 * `cladgpt-proxy/commandcode.ox-alpha` splits into a provider part, a
 * provider-qualified part (`commandcode.ox-alpha`) and a bare name
 * (`ox-alpha`). Matching only ever looks at the last two — the Pi provider name
 * and the human labels both contain "proxy", so matching the whole string makes
 * half the alphabet ambiguous.
 */
function modelParts(id: string) {
	const qualified = id.slice(id.indexOf('/') + 1);
	const dot = qualified.indexOf('.');
	return { qualified, bare: dot === -1 ? qualified : qualified.slice(dot + 1) };
}

interface CatalogueRow {
	id: string;
	name: string;
	canonical: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	defaults: Record<string, unknown> | null;
}

/**
 * What Pi can address, enriched with the tuned per-model defaults this project
 * applies on the way out. The defaults are not something Pi knows about — they
 * are filled in downstream — so this is the only place both halves meet.
 */
function catalogue(): CatalogueRow[] {
	return knownPiModels().map((model) => {
		const canonical = modelParts(model.id).bare;
		return {
			id: model.id,
			name: model.name,
			canonical,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			defaults: getModelDefaults(canonical)
		};
	});
}

/** Accepts a full `provider/id`, a `provider.model`, a bare name, or a fragment. */
function resolveProxyModel(input: string) {
	if (!input) return DEFAULT_MODEL;
	const models = knownPiModels().filter((model) => model.provider === 'cladgpt-proxy');
	if (!models.length) return input;

	const needle = input.toLowerCase();
	const tiers: Array<(model: { id: string }) => boolean> = [
		(model) => model.id.toLowerCase() === needle,
		(model) => modelParts(model.id).qualified.toLowerCase() === needle,
		(model) => modelParts(model.id).bare.toLowerCase() === needle,
		(model) => modelParts(model.id).qualified.toLowerCase().includes(needle)
	];

	for (const matches of tiers.map((predicate) => models.filter(predicate))) {
		if (matches.length === 1) return matches[0].id;
		if (matches.length > 1) {
			die(
				`"${input}" matches ${matches.length} models:\n  ${matches.map((m) => m.id).join('\n  ')}\n` +
					'Use a longer fragment, or name the provider (e.g. "deepseek.deepseek-v4-flash").'
			);
		}
	}
	return input;
}

function resolveModel(input: string) {
	if (activePreset.harness === 'antigravity') return input || activePreset.model || 'auto';
	if (activeUse.kind === 'endpoint') {
		const id = input
			? resolveEndpointModel(providersStore, activeUse.provider, input)
			: activePreset.model;
		return `${piProviderIdForUse(activePreset.use)}/${id}`;
	}
	return resolveProxyModel(input);
}

/* -------------------------------------------------------------------------- */
/* job storage                                                                */
/* -------------------------------------------------------------------------- */

interface JobMeta {
	id: string;
	preset?: string;
	harness?: 'pi' | 'antigravity';
	apiMode?: 'bundled-proxy' | 'openai-completions' | 'antigravity-account';
	antigravity?: {
		profileDir: string;
		isolationMode: AntigravityIsolationMode;
		effort?: string;
		agent?: string;
	};
	model: string;
	cwd: string;
	task: string;
	tools: boolean;
	/** The preset's provider/account at launch time. */
	use?: string;
	/** Reasoning intent, mapped per harness at spawn. */
	effort?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	pid?: number;
	timeoutSec: number;
	returnAfterSec: number;
	/** Absolute hard-stop time. Live-updatable with `pirun time`. */
	deadlineAt?: number;
	timedOut?: boolean;
	/** Every Pi process is owned by a detached supervisor, never the caller. */
	supervised?: boolean;
	/** The detached pirun process that owns the timeout and waits on Pi. */
	supervisorPid?: number;
	supervisorReadyAt?: number;
	piStartedAt?: number;
	/** A supervised run whose supervisor went away before it could finish. */
	interrupted?: boolean;
	supervisorError?: string;
	noContextFiles?: boolean;
	label?: string;
	/** Name of the persistent agent this exchange belongs to, if any. */
	agent?: string;
	/** Ownership token for that agent's cross-process lock. */
	agentLockToken?: string;
	/** How Pi was pointed at a session: create by name, continue, or fork. */
	session?: { mode: 'new' | 'continue' | 'fork'; ref: string };
}

interface AgentMeta {
	name: string;
	preset?: string;
	harness?: 'pi' | 'antigravity';
	cwd: string;
	model: string;
	createdAt: number;
	lastRunAt: number;
	/** Pi's own session uuid, learned from the first run's event stream. */
	sessionId?: string;
	forkedFrom?: string;
	exchanges: number;
	runs: string[];
	totals: { input: number; cached: number; output: number; cost: number };
	/** Session footprint after the last exchange, for the context gauge. */
	contextTokens?: number;
}

function jobDir(id: string) {
	return resolve(RUNS_DIR, id);
}

function readMeta(id: string): JobMeta {
	const path = resolve(jobDir(id), 'meta.json');
	if (!existsSync(path)) die(`no such run "${id}". Try "pirun jobs ${activePresetName || '<preset>'}".`);
	return JSON.parse(readFileSync(path, 'utf8')) as JobMeta;
}

function writeMeta(meta: JobMeta) {
	const destination = resolve(jobDir(meta.id), 'meta.json');
	atomicWriteJson(destination, meta);
}

function listJobs(): JobMeta[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.filter((entry) => {
			const path = resolve(RUNS_DIR, entry);
			return statSync(path).isDirectory() && existsSync(resolve(path, 'meta.json'));
		})
		.map((entry) => readMeta(entry))
		.sort((a, b) => b.startedAt - a.startedAt);
}

function presetJobs() {
	return listJobs().filter((job) => !job.preset || job.preset === activePresetName);
}

function readPresetJob(id: string) {
	const meta = readMeta(id);
	if (meta.preset && meta.preset !== activePresetName) {
		die(`run "${id}" belongs to preset "${meta.preset}", not "${activePresetName}".`);
	}
	return meta;
}

/* -------------------------------------------------------------------------- */
/* agents                                                                     */
/* -------------------------------------------------------------------------- */

function agentDir(name: string) {
	return resolve(AGENTS_DIR, name);
}

function agentFile(name: string) {
	return resolve(agentDir(name), 'agent.json');
}

function validAgentName(name: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

function readAgent(name: string): AgentMeta | null {
	const path = agentFile(name);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as AgentMeta;
}

function writeAgent(agent: AgentMeta) {
	atomicWriteJson(agentFile(agent.name), agent);
}

function listAgents(): AgentMeta[] {
	if (!existsSync(AGENTS_DIR)) return [];
	return readdirSync(AGENTS_DIR)
		.filter((entry) => existsSync(agentFile(entry)))
		.map((entry) => readAgent(entry))
		.filter((agent): agent is AgentMeta => Boolean(agent))
		.sort((a, b) => b.lastRunAt - a.lastRunAt);
}

function presetAgents() {
	return listAgents().filter((agent) => !agent.preset || agent.preset === activePresetName);
}

function sessionFiles() {
	if (!existsSync(SESSIONS_DIR)) return [];
	return readdirSync(SESSIONS_DIR)
		.map((name) => resolve(SESSIONS_DIR, name))
		.filter((path) => statSync(path).isFile() && path.endsWith('.jsonl'));
}

function sessionRefs(agent: AgentMeta) {
	return new Set([agent.name, agent.sessionId].filter((value): value is string => Boolean(value)));
}

function sessionMatches(path: string, refs: Set<string>) {
	const name = basename(path).replace(/\.jsonl$/, '');
	return [...refs].some((ref) => name.endsWith(`_${ref}`));
}

function removeAgentSessions(agent: AgentMeta) {
	if (agent.harness === 'antigravity') return 0;
	const refs = sessionRefs(agent);
	let removed = 0;
	for (const path of sessionFiles()) {
		if (!sessionMatches(path, refs)) continue;
		rmSync(path, { force: true });
		removed += 1;
	}
	return removed;
}

function removeOrphanSessions(olderThan = 0) {
	const activeRefs = new Set(listAgents().flatMap((agent) => [...sessionRefs(agent)]));
	let removed = 0;
	for (const path of sessionFiles()) {
		const stats = statSync(path);
		if (stats.mtimeMs >= olderThan || sessionMatches(path, activeRefs)) continue;
		rmSync(path, { force: true });
		removed += 1;
	}
	return removed;
}

function pathBytes(path: string): number {
	if (!existsSync(path)) return 0;
	const stats = statSync(path);
	if (stats.isFile()) return stats.size;
	return readdirSync(path).reduce((sum, entry) => sum + pathBytes(resolve(path, entry)), 0);
}

/** Bounded, conservative retention: never prune active-agent history automatically. */
function pruneStorage() {
	if (!existsSync(RUNS_DIR)) return;
	const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const protectedRuns = new Set(listAgents().flatMap((agent) => agent.runs));
	const candidates = listJobs()
		.filter((job) => job.finishedAt && !protectedRuns.has(job.id) && !(job.pid && isAlive(job.pid)))
		.sort((a, b) => a.startedAt - b.startedAt);

	for (const job of candidates.filter((entry) => entry.startedAt < cutoff)) {
		rmSync(jobDir(job.id), { recursive: true, force: true });
	}
	removeOrphanSessions(cutoff);

	let bytes = pathBytes(RUNS_DIR);
	for (const job of candidates) {
		if (bytes <= MAX_STORAGE_BYTES || !existsSync(jobDir(job.id))) continue;
		const size = pathBytes(jobDir(job.id));
		rmSync(jobDir(job.id), { recursive: true, force: true });
		bytes -= size;
	}
}

/**
 * One exchange at a time per agent. Two concurrent turns would interleave
 * writes into the same session file and corrupt the very context we are
 * keeping around.
 */
function agentLockPath(name: string) {
	return resolve(agentDir(name), 'lock');
}

function lockAgent(name: string) {
	const path = resolve(agentDir(name), 'lock');
	try {
		return acquireOwnedLock(path, isAlive);
	} catch (error) {
		const match = /^busy:(\d+)$/.exec(error instanceof Error ? error.message : '');
		if (match) die(`agent "${name}" is busy (pid ${match[1]}). Wait, or run \`pirun agents ${activePresetName}\`.`);
		throw error;
	}
}

function unlockAgent(name: string, token?: string) {
	releaseOwnedLock(agentLockPath(name), token);
}

function agentIsBusy(name: string) {
	const lock = readOwnedLock(agentLockPath(name));
	return Boolean(lock && isAlive(lock.pid));
}

/* -------------------------------------------------------------------------- */
/* digest                                                                     */
/* -------------------------------------------------------------------------- */

interface ToolUse {
	name: string;
	hint: string;
	failed: boolean;
}

interface Digest {
	status: 'ok' | 'empty' | 'failed' | 'running' | 'timeout' | 'interrupted';
	sessionId: string;
	turns: number;
	retries: number;
	compactions: number;
	tools: ToolUse[];
	text: string;
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	/**
	 * Tokens the final assistant turn saw plus what it produced. The next
	 * request re-sends all of it, so this is what the session now occupies.
	 */
	contextTokens: number;
	cost: number;
	errors: string[];
	notes: string[];
}

/**
 * Pi surfaces provider failures as `errorMessage` strings that wrap our own
 * JSON envelope: `502: {"message":"…","type":"completions_proxy_error"}`. The
 * caller wants the sentence, not the envelope.
 */
function unwrapErrorMessage(raw: string) {
	const at = raw.indexOf('{');
	if (at === -1) return truncate(raw, 200);
	const status = raw.slice(0, at).replace(/[:\s]+$/, '').trim();
	try {
		const parsed = JSON.parse(raw.slice(at)) as { message?: string; details?: unknown };
		const message = typeof parsed.message === 'string' ? parsed.message : raw.slice(at);
		const details =
			typeof parsed.details === 'string' && parsed.details.length < 240 ? ` — ${parsed.details}` : '';
		return truncate(`${status ? `${status} ` : ''}${message}${details}`, 240);
	} catch {
		return truncate(raw, 200);
	}
}

const ARG_HINT_KEYS = ['path', 'file_path', 'filePath', 'command', 'CommandLine', 'pattern', 'query', 'url'];

function argHint(args: unknown) {
	if (!args || typeof args !== 'object') return '';
	const record = args as Record<string, unknown>;
	for (const key of ARG_HINT_KEYS) {
		const value = record[key];
		if (typeof value === 'string' && value) return truncate(value, 48);
	}
	const first = Object.values(record).find((value) => typeof value === 'string');
	return typeof first === 'string' ? truncate(first, 48) : '';
}

function buildAntigravityDigest(id: string, meta: JobMeta): Digest {
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	const digestPath = resolve(jobDir(id), 'digest.json');
	if (meta.finishedAt && existsSync(digestPath)) {
		try {
			return JSON.parse(readFileSync(digestPath, 'utf8')) as Digest;
		} catch {
			// Rebuild from the durable stream below.
		}
	}
	const digest: Digest = {
		status: 'running',
		sessionId: '',
		turns: 0,
		retries: 0,
		compactions: 0,
		tools: [],
		text: '',
		inputTokens: 0,
		cachedTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		cost: 0,
		errors: [],
		notes: []
	};
	if (meta.supervisorError) digest.errors.push(meta.supervisorError);
	let resultStatus = '';
	const seenTools = new Set<string>();
	const seenErrors = new Set(digest.errors);
	if (existsSync(eventsPath)) {
		for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
			if (!line.trim()) continue;
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				const message = truncate(line, 240);
				if (/authentication required|error|failed|invalid/i.test(line) && !seenErrors.has(message)) {
					seenErrors.add(message);
					digest.errors.push(message);
				}
				continue;
			}
			const eventName = String(event.event ?? '');
			if (typeof event.conversation_id === 'string') digest.sessionId = event.conversation_id;
			if (eventName === 'step_update' && isRecord(event.step_update)) {
				const step = event.step_update;
				if (typeof step.conversation_id === 'string') digest.sessionId = step.conversation_id;
				if (step.step_type === 'tool' && step.state === 'DONE') {
					const key = String(step.step_index ?? `${step.tool_name}:${digest.tools.length}`);
					if (!seenTools.has(key)) {
						seenTools.add(key);
						const info = isRecord(step.tool_info) ? step.tool_info : null;
						digest.tools.push({
							name: String(step.tool_name ?? info?.name ?? 'tool'),
							hint: argHint(info?.parameters),
							failed: Boolean(info?.error)
						});
					}
				}
			}
			if (eventName !== 'result' || !isRecord(event.result)) continue;
			const result = event.result;
			if (typeof result.conversation_id === 'string') digest.sessionId = result.conversation_id;
			resultStatus = String(result.status ?? '');
			digest.turns = Number(result.num_turns ?? digest.turns);
			if (typeof result.response === 'string') digest.text = result.response.trim();
			const usage = isRecord(result.usage) ? result.usage : null;
			if (usage) {
				digest.inputTokens = Number(usage.input_tokens ?? 0);
				digest.cachedTokens = Number(usage.cache_read_tokens ?? 0);
				digest.outputTokens = Number(usage.output_tokens ?? 0) + Number(usage.thinking_tokens ?? 0);
				digest.contextTokens = Number(usage.total_tokens ?? 0);
			}
			if (typeof result.error === 'string' && result.error.trim() && !seenErrors.has(result.error.trim())) {
				seenErrors.add(result.error.trim());
				digest.errors.push(truncate(result.error, 300));
			}
		}
	}

	if (!meta.finishedAt) return digest;
	if (meta.timedOut) digest.status = 'timeout';
	else if (meta.interrupted && !resultStatus) digest.status = 'interrupted';
	else if (meta.exitCode !== 0 || (resultStatus && resultStatus !== 'SUCCESS') || digest.errors.length) {
		digest.status = 'failed';
	} else if (!resultStatus || !digest.text) digest.status = 'empty';
	else digest.status = 'ok';
	atomicWriteJson(digestPath, digest);
	return digest;
}

function buildDigest(id: string, meta: JobMeta): Digest {
	if (meta.harness === 'antigravity') return buildAntigravityDigest(id, meta);
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	const digestPath = resolve(jobDir(id), 'digest.json');
	if (meta.finishedAt && existsSync(digestPath)) {
		try {
			return JSON.parse(readFileSync(digestPath, 'utf8')) as Digest;
		} catch {
			// Rebuild a damaged or stale cache from the durable event stream.
		}
	}
	const digest: Digest = {
		status: 'running',
		sessionId: '',
		turns: 0,
		retries: 0,
		compactions: 0,
		tools: [],
		text: '',
		inputTokens: 0,
		cachedTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		cost: 0,
		errors: [],
		notes: []
	};
	const seenErrors = new Set<string>();
	if (meta.supervisorError) {
		seenErrors.add(meta.supervisorError);
		digest.errors.push(meta.supervisorError);
	}
	if (!existsSync(eventsPath)) {
		if (meta.finishedAt) {
			if (meta.timedOut) digest.status = 'timeout';
			else if (meta.interrupted) digest.status = 'interrupted';
			else if (meta.exitCode !== 0 || digest.errors.length) digest.status = 'failed';
			else digest.status = 'empty';
			atomicWriteJson(digestPath, digest);
		}
		return digest;
	}

	const failedToolCalls = new Set<string>();
	const toolsByCallId = new Map<string, ToolUse>();
	let lastAssistantText = '';
	let lastAssistantHadTools = false;
	let sawAssistantMessage = false;

	for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Pi writes plain text to the same stream for warnings and startup failures.
			const text = truncate(line, 200);
			if (/error|failed|\b5\d\d\b/i.test(line)) {
				if (!seenErrors.has(text)) {
					seenErrors.add(text);
					digest.errors.push(text);
				}
			} else if (/^warning:/i.test(line)) {
				// Creating a named session is exactly what a new agent is doing.
				if (!/no project session found with id/i.test(line)) digest.notes.push(text);
			}
			continue;
		}

		const type = String(event.type ?? '');
		if (type === 'session' && typeof event.id === 'string') digest.sessionId = event.id;
		if (type === 'turn_start') digest.turns += 1;
		if (type === 'auto_retry_start') digest.retries += 1;
		// Compaction rewrites the prefix, so the provider's cache starts cold
		// again on the next turn. Worth seeing when it happens.
		if (type === 'compaction_end') digest.compactions += 1;

		if (type === 'turn_end' && Array.isArray(event.toolResults)) {
			for (const result of event.toolResults as Array<Record<string, unknown>>) {
				if (result.isError && typeof result.toolCallId === 'string') {
					failedToolCalls.add(result.toolCallId);
					const tool = toolsByCallId.get(result.toolCallId);
					if (tool) tool.failed = true;
				}
			}
		}

		if (type !== 'message_end') continue;
		const message = event.message as Record<string, unknown> | undefined;
		if (!message || message.role !== 'assistant') continue;
		sawAssistantMessage = true;

		const usage = message.usage as Record<string, unknown> | undefined;
		if (usage) {
			digest.inputTokens += Number(usage.input ?? 0);
			digest.cachedTokens += Number(usage.cacheRead ?? 0);
			digest.outputTokens += Number(usage.output ?? 0);
			const footprint =
				Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.output ?? 0);
			if (footprint) digest.contextTokens = footprint;
			const cost = usage.cost as Record<string, unknown> | undefined;
			digest.cost += Number(cost?.total ?? 0);
		}

		const stopReason = String(message.stopReason ?? '');
		if (stopReason === 'error' || stopReason === 'aborted') {
			const raw = typeof message.errorMessage === 'string' ? message.errorMessage : '';
			const described = raw ? unwrapErrorMessage(raw) : `turn ended with stopReason "${stopReason}"`;
			if (!seenErrors.has(described)) {
				seenErrors.add(described);
				digest.errors.push(described);
			}
		}

		const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
		let text = '';
		let hadTools = false;
		for (const part of content) {
			if (part.type === 'text' && typeof part.text === 'string') text += part.text;
			if (part.type === 'toolCall') {
				hadTools = true;
				const callId = typeof part.id === 'string' ? part.id : '';
				const tool = {
					name: String(part.name ?? 'tool'),
					hint: argHint(part.arguments),
					failed: Boolean(callId && failedToolCalls.has(callId))
				};
				digest.tools.push(tool);
				if (callId) toolsByCallId.set(callId, tool);
			}
		}
		if (text.trim()) lastAssistantText = text.trim();
		lastAssistantHadTools = hadTools;
	}

	digest.text = lastAssistantText;

	const running = !meta.finishedAt;
	if (running) {
		digest.status = 'running';
		return digest;
	}
	if (meta.timedOut) digest.status = 'timeout';
	else if (meta.interrupted && !sawAssistantMessage) digest.status = 'interrupted';
	else if (meta.exitCode !== 0 || digest.errors.length) digest.status = 'failed';
	else if (!sawAssistantMessage || (!digest.text && !lastAssistantHadTools)) digest.status = 'empty';
	else digest.status = 'ok';

	atomicWriteJson(digestPath, digest);
	return digest;
}

function renderDigest(meta: JobMeta, digest: Digest, options: { full: boolean; label?: string }) {
	const elapsed = (meta.finishedAt ?? Date.now()) - meta.startedAt;
	const total = digest.inputTokens + digest.cachedTokens;
	const hit = total ? Math.round((digest.cachedTokens / total) * 100) : 0;
	const parts = [
		`turns=${digest.turns}`,
		humanDuration(elapsed),
		// Uncached input is what you pay full rate for; the cached half is the
		// whole reason a persistent agent beats a fresh one.
		digest.cachedTokens
			? `in=${humanTokens(digest.inputTokens)}+${humanTokens(digest.cachedTokens)} cached (${hit}%)`
			: `in=${humanTokens(digest.inputTokens)}`,
		`out=${humanTokens(digest.outputTokens)}`
	];
	if (digest.retries) parts.push(`retries=${digest.retries}`);
	if (digest.compactions) parts.push(`compacted=${digest.compactions}`);
	if (digest.cost > 0) parts.push(`$${digest.cost.toFixed(4)}`);

	out(`[${options.label ?? meta.id}] ${digest.status.toUpperCase()}  ${parts.join('  ')}  ${meta.model}`);

	if (digest.tools.length) {
		const rendered = digest.tools
			.map((tool) => `${tool.failed ? '!' : ''}${tool.name}${tool.hint ? `(${tool.hint})` : ''}`)
			.join(' · ');
		out(`tools: ${truncate(rendered, options.full ? 4000 : 300)}`);
	}

	for (const note of digest.notes.slice(0, 2)) out(`note: ${note}`);
	for (const error of digest.errors.slice(0, 3)) out(`error: ${error}`);

	if (digest.status === 'interrupted') {
		out(`note: the detached supervisor ended before ${meta.harness === 'antigravity' ? 'Antigravity' : 'Pi'} recorded a result.`);
		out('      Inspect the event log, then retry the task.');
	}

	if (digest.status === 'empty' || digest.status === 'failed') {
		const upstream = meta.apiMode !== 'bundled-proxy'
			? []
			: proxyErrorsBetween(meta.startedAt, meta.finishedAt ?? Date.now());
		for (const line of upstream) out(`upstream: ${line}`);
		if (digest.status === 'empty' && !upstream.length) {
			out(
				meta.apiMode !== 'bundled-proxy'
					? `note: the ${meta.harness === 'antigravity' ? 'Antigravity' : 'direct API'} run produced no assistant content.`
					: 'note: the run produced no assistant content and nothing was logged upstream.'
			);
		}
	}

	out(`events: ${resolve(jobDir(meta.id), 'events.jsonl')}`);

	if (digest.text) {
		out('---');
		out(options.full ? digest.text : truncate(digest.text, 2000));
	}
}

interface LiveProgress {
	generatedTokens: number;
	lastTenSecondsTokens: number;
	lastTenSecondsTps: number;
	waitingForFirstToken: boolean;
}

function liveProgress(id: string, meta: JobMeta): LiveProgress {
	const eventsPath = resolve(jobDir(id), 'events.jsonl');
	if (!existsSync(eventsPath)) {
		return {
			generatedTokens: 0,
			lastTenSecondsTokens: 0,
			lastTenSecondsTps: 0,
			waitingForFirstToken: true
		};
	}

	let completedTokens = 0;
	let currentText = '';
	let recentText = '';
	let sawGeneratedDelta = false;
	const now = Date.now();
	const recentCutoff = now - 10_000;
	for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const type = String(event.type ?? '');
		if (meta.harness === 'antigravity') {
			const step = event.event === 'step_update' && isRecord(event.step_update) ? event.step_update : null;
			const delta = typeof step?.text_delta === 'string' ? step.text_delta : '';
			if (step?.step_type === 'agent_response' && delta) {
				sawGeneratedDelta = true;
				currentText += delta;
				if (Number(event._pirun_received_at) >= recentCutoff) recentText += delta;
			}
			if (event.event === 'result' && isRecord(event.result)) {
				const usage = isRecord(event.result.usage) ? event.result.usage : null;
				completedTokens = Number(usage?.output_tokens ?? completedTokens) + Number(usage?.thinking_tokens ?? 0);
				currentText = '';
			}
			continue;
		}
		const message = isRecord(event.message) ? event.message : null;
		if (type === 'message_start' && message?.role === 'assistant') currentText = '';
		if (type === 'message_update') {
			const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
			const updateType = String(update?.type ?? '');
			const delta = typeof update?.delta === 'string' ? update.delta : '';
			if (delta && ['thinking_delta', 'text_delta', 'toolcall_delta'].includes(updateType)) {
				sawGeneratedDelta = true;
				currentText += delta;
				if (Number(event._pirun_received_at) >= recentCutoff) recentText += delta;
			}
		}
		if (type === 'message_end' && message?.role === 'assistant') {
			const usage = isRecord(message.usage) ? message.usage : null;
			completedTokens += Number(usage?.output ?? 0);
			currentText = '';
		}
	}

	const generatedTokens = completedTokens + (currentText ? encode(currentText).length : 0);
	const recentTokens = recentText ? encode(recentText).length : 0;
	const observedWindowSeconds = Math.max(1, Math.min(10, (now - meta.startedAt) / 1000));
	return {
		generatedTokens,
		lastTenSecondsTokens: recentTokens,
		lastTenSecondsTps: recentTokens / observedWindowSeconds,
		waitingForFirstToken: !sawGeneratedDelta
	};
}

function emitRunningHandoff(meta: JobMeta, digest: Digest, args: Args) {
	const progress = liveProgress(meta.id, meta);
	const hardDeadline = meta.deadlineAt ?? (meta.piStartedAt ?? meta.startedAt) + meta.timeoutSec * 1000;
	const hardRemaining = Math.max(0, hardDeadline - Date.now());
	if (args.flags.has('json')) {
		out(JSON.stringify({ meta, digest, progress, hardRemainingMs: hardRemaining }, null, 2));
		return;
	}
	const label = meta.label ?? meta.id;
	out(
		`[${label}] RUNNING  turns=${digest.turns}  ${humanDuration(Date.now() - meta.startedAt)}  ` +
			`generated≈${humanTokens(progress.generatedTokens)}  last-10s=${progress.lastTenSecondsTps.toFixed(2)} tok/s`
	);
	if (progress.waitingForFirstToken) out('state: waiting for first generated token');
	out(`${meta.harness === 'antigravity' ? 'Antigravity' : 'Pi'} continues in the background; hard stop in ${humanDuration(hardRemaining)}.`);
	const preset = meta.preset ?? activePresetName;
	out(
		`check: pirun wait ${preset} ${meta.id}   ` +
			`progress: pirun poll ${preset} ${meta.id}   stop: pirun kill ${preset} ${meta.id}`
	);
}

/* -------------------------------------------------------------------------- */
/* harness authentication and execution                                       */
/* -------------------------------------------------------------------------- */

function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs = 0) {
	return new Promise<number>((resolveExit) => {
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			resolveExit(code);
		};
		child.once('exit', (code) => finish(code ?? 1));
		child.once('error', () => finish(1));
		if (timeoutMs > 0) {
			setTimeout(() => {
				if (settled) return;
				if (child.pid) terminateProcessTree(child.pid);
				finish(124);
			}, timeoutMs).unref();
		}
	});
}

function openBrowserUrl(url: string) {
	let command: string;
	let args: string[];
	if (process.platform === 'win32') {
		// explorer.exe silently failed to open OAuth URLs on tested machines;
		// the shell's own URL handler is the path that reliably worked.
		command = 'rundll32.exe';
		args = ['url.dll,FileProtocolHandler', url];
	} else if (process.platform === 'darwin') {
		command = 'open';
		args = [url];
	} else {
		command = 'xdg-open';
		args = [url];
	}
	try {
		const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
		opener.unref();
	} catch {
		// The URL remains visible in the terminal for manual opening.
	}
}

async function verifyAntigravityIsolation(entry: string, profileDir: string, cwd: string) {
	const modes: AntigravityIsolationMode[] = process.platform === 'win32'
		? ['ssh-file']
		: ['force-file', 'ssh-file'];
	for (const mode of modes) {
		const startedAt = Date.now();
		const child = spawn(
			entry,
			antigravityRunArgs({ profileDir, approveTools: false, timeoutSec: 5 }),
			{
				cwd,
				stdio: ['pipe', 'ignore', 'ignore'],
				windowsHide: true,
				env: antigravityEnv(mode)
			}
		);
		child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: 'Reply with exactly OK.' } })}\n`);
		const exit = waitForChildExit(child, 12_000);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && child.exitCode === null) {
			const inspected = inspectAntigravityProfile(profileDir, startedAt);
			if (inspected.usesFileStorage && !inspected.usesKeyring) {
				if (child.pid) terminateProcessTree(child.pid);
				await exit;
				return mode;
			}
			if (inspected.usesKeyring) break;
			await new Promise((resolveProbe) => setTimeout(resolveProbe, 200));
		}
		if (child.pid && child.exitCode === null) terminateProcessTree(child.pid);
		await exit;
	}
	throw new Error(
		'Antigravity did not confirm file-backed credential storage. Pirun stopped before login ' +
			'because using the shared OS keyring would break account isolation.'
	);
}

/** One isolated profile per account; presets share accounts, never profiles. */
function antigravityAccountProfileDir(account: string) {
	const stored = providersStore.harnesses.antigravity?.accounts[account]?.profileDir;
	return stored ? resolve(stored) : antigravityProfileDir(account);
}

async function loginAntigravityAccount(account: string, force = false) {
	const profileDir = antigravityAccountProfileDir(account);
	const alreadyAuthenticated = hasAntigravityAuthMarker(profileDir);
	if (alreadyAuthenticated && !force) {
		out(`Antigravity account "${account}" is already authenticated in ${profileDir}`);
		return;
	}
	const entry = findAntigravityEntry();
	const cwd = process.cwd();
	let isolationMode = antigravityIsolationMode(profileDir);
	if (!alreadyAuthenticated) {
		out(`Checking isolated credential storage for account "${account}"…`);
		isolationMode = await verifyAntigravityIsolation(entry, profileDir, cwd);
	}
	out(`Opening Antigravity login for account "${account}".`);
	out('Authenticate in the browser. If the page shows a code, paste it here and press Enter.');
	out('When Antigravity shows the signed-in account, use /quit to continue.');
	const startedAt = Date.now();
	const child = spawn(entry, antigravityBaseArgs(profileDir), {
		cwd,
		stdio: isolationMode === 'ssh-file' ? ['inherit', 'pipe', 'pipe'] : 'inherit',
		windowsHide: false,
		env: antigravityEnv(isolationMode)
	});
	if (isolationMode === 'ssh-file') {
		let opened = false;
		let urlBuffer = '';
		const forward = (stream: NodeJS.ReadableStream | null, destination: NodeJS.WriteStream) => {
			stream?.on('data', (chunk) => {
				const text = String(chunk);
				destination.write(text);
				if (opened) return;
				urlBuffer = `${urlBuffer}${text}`.slice(-32_000);
				const url = antigravityOAuthUrl(urlBuffer);
				if (url) {
					opened = true;
					openBrowserUrl(url);
				}
			});
		};
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);
	}
	const exitCode = await waitForChildExit(child);
	const inspected = inspectAntigravityProfile(profileDir, startedAt);
	if (!inspected.usesFileStorage || inspected.usesKeyring) {
		throw new Error('Antigravity login did not remain inside the isolated file-backed profile.');
	}
	if (!inspected.authenticated) {
		throw new Error(
			`Antigravity exited (${exitCode}) before Pirun could confirm authentication. Run ` +
			`"pirun login antigravity ${account}" and finish the browser sign-in.`
		);
	}
	markAntigravityAuthenticated(profileDir, isolationMode);
	out(`Authenticated Antigravity account "${account}" in an isolated profile.`);
	if (inspectAntigravityProfile(profileDir).ineligible) {
		out('warning: Antigravity reports that this account is not eligible in the current location.');
	}
}

/**
 * Windows login opens a separate visible console window so the user always has
 * a real terminal to paste the Google authorization code into, even when Pirun
 * itself was launched from a non-interactive caller (an agent, a script). The
 * parent waits for the isolated profile's auth marker instead of the window.
 */
async function loginAntigravityWindowed(account: string) {
	const profileDir = antigravityAccountProfileDir(account);
	const script = resolve(process.argv[1]);
	const startedAt = Date.now();
	const child = spawn(
		'cmd.exe',
		[
			'/c', 'start', 'Pirun Antigravity login',
			process.execPath, script, 'login', 'antigravity', account, '--inline', '--login-window'
		],
		{ detached: true, stdio: 'ignore', windowsHide: false }
	);
	child.unref();
	out(`Opened a separate login window for Antigravity account "${account}".`);
	out('Sign in with the browser. If Google shows an authorization code, paste it into that window.');
	out('When Antigravity shows the signed-in account, type /quit there. Waiting up to 15 minutes…');
	const deadline = Date.now() + 15 * 60_000;
	while (Date.now() < deadline) {
		if (antigravityAuthMarkerTime(profileDir) >= startedAt) {
			out(`Authenticated Antigravity account "${account}" in an isolated profile.`);
			if (inspectAntigravityProfile(profileDir).ineligible) {
				out('warning: Antigravity reports that this account is not eligible in the current location.');
			}
			return;
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 2_000));
	}
	die(
		`the login window did not finish within 15 minutes. Complete the sign-in there, ` +
			`then run "pirun providers" to check the account.`
	);
}

async function holdLoginWindowOpen() {
	out('');
	out('Press Enter to close this window.');
	await new Promise<void>((resolveKey) => {
		process.stdin.resume();
		process.stdin.once('data', () => resolveKey());
	});
	process.stdin.pause();
}

async function ensureHarnessAuthentication() {
	if (activePreset.harness !== 'antigravity') return;
	const account = activeUse.account;
	if (hasAntigravityAuthMarker(antigravityAccountProfileDir(account))) return;
	if (process.platform === 'win32') await loginAntigravityWindowed(account);
	else await loginAntigravityAccount(account);
}

function readTask(args: Args): string {
	const prefix = activePreset.prefix?.trim();
	const withPrefix = (task: string) => (prefix ? `${prefix}\n\n${task}` : task);
	const inline = flagString(args, 'task');
	if (inline) return withPrefix(inline);

	const file = flagString(args, 'file');
	if (file) {
		if (!existsSync(file)) die(`prompt file not found: ${file}`);
		return withPrefix(readFileSync(file, 'utf8'));
	}

	if (args.positional.length) return withPrefix(args.positional.join(' '));

	if (process.stdin.isTTY) {
		die('no task given. Pass --task "…", --file <path>, a positional argument, or pipe it on stdin.');
	}
	return withPrefix(readFileSync(0, 'utf8'));
}

function piArgs(meta: JobMeta, jsonMode: boolean) {
	const list = [
		findPiEntry(),
		'-p',
		'--mode',
		jsonMode ? 'json' : 'text',
		'--approve',
		...LEAN_FLAGS,
		'--model',
		meta.model
	];
	if (meta.effort) list.push('--thinking', piThinkingLevel(parseEffortIntent(meta.effort)));
	if (!meta.tools) list.push('--no-tools');
	if (meta.noContextFiles) list.push('--no-context-files');

	if (!meta.session) {
		// Throwaway work: nothing to keep, nothing to pay for keeping.
		list.push('--no-session');
		return list;
	}

	mkdirSync(SESSIONS_DIR, { recursive: true });
	list.push('--session-dir', SESSIONS_DIR);
	if (meta.session.mode === 'new') list.push('--session-id', meta.session.ref);
	else if (meta.session.mode === 'fork') list.push('--fork', meta.session.ref);
	else list.push('--session', meta.session.ref);
	return list;
}

function createJob(args: Args, task: string, agent?: AgentMeta, label?: string, agentLockToken?: string): JobMeta {
	const time = requestedTimeSpec(args);
	ensureRunsDir();
	pruneStorage();
	let id = '';
	for (let attempt = 0; attempt < 8; attempt += 1) {
		id = randomBytes(3).toString('hex');
		try {
			mkdirSync(jobDir(id));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			id = '';
		}
	}
	if (!id) die('could not allocate a unique run id.');
	const meta: JobMeta = {
		id,
		preset: activePresetName,
		harness: activePreset.harness,
		apiMode: activePreset.harness === 'antigravity'
			? 'antigravity-account'
			: activeUse.kind === 'endpoint'
				? 'openai-completions'
				: 'bundled-proxy',
		model: agent?.model ?? resolveModel(flagString(args, 'model')),
		cwd: agent?.cwd ?? resolve(flagString(args, 'dir') || activePreset.dir || process.cwd()),
		task: truncate(task, 300),
		tools: !args.flags.has('no-tools'),
		use: activePreset.use,
		effort: activePreset.effort,
		startedAt: Date.now(),
		timeoutSec: time.timeoutSec,
		returnAfterSec: time.returnAfterSec,
		noContextFiles: args.flags.has('no-context-files'),
		label
	};
	if (activePreset.harness === 'antigravity') {
		const profileDir = antigravityAccountProfileDir(activeUse.account);
		meta.antigravity = {
			profileDir,
			isolationMode: antigravityIsolationMode(profileDir),
			effort: activePreset.effort
				? antigravityEffortLevel(parseEffortIntent(activePreset.effort))
				: undefined,
			agent: activePreset.antigravityAgent
		};
	}
	if (agent) {
		meta.agent = agent.name;
		meta.agentLockToken = agentLockToken;
		meta.session = agent.sessionId
			? { mode: 'continue', ref: agent.sessionId }
			: agent.forkedFrom
				? { mode: 'fork', ref: agent.forkedFrom }
				: { mode: 'new', ref: agent.name };
	}
	writeFileSync(resolve(jobDir(id), 'task.md'), task);
	writeMeta(meta);
	return meta;
}

function captureLines(
	stream: NodeJS.ReadableStream | null,
	eventsPath: string,
	stampJson: boolean
) {
	if (!stream) return Promise.resolve();
	return new Promise<void>((resolveCapture) => {
		let buffer = '';
		const writeLine = (line: string) => {
			if (!line) return;
			if (stampJson) {
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					event._pirun_received_at = Date.now();
					appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
					return;
				} catch {
					// Preserve non-JSON output so the digest can report startup failures.
				}
			}
			appendFileSync(eventsPath, `${line}\n`);
		};
		stream.on('data', (chunk) => {
			buffer += String(chunk).replace(/\r\n/g, '\n');
			let boundary = buffer.indexOf('\n');
			while (boundary !== -1) {
				writeLine(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 1);
				boundary = buffer.indexOf('\n');
			}
		});
		stream.once('end', () => {
			if (buffer) writeLine(buffer);
			resolveCapture();
		});
		stream.once('error', () => resolveCapture());
	});
}

async function spawnPi(meta: JobMeta) {
	// The bypass exists for deterministic lifecycle tests. Normal callers never
	// set it and still get the self-starting proxy behavior.
	if (process.env.PIRUN_SKIP_PROXY !== '1' && meta.apiMode !== 'openai-completions') await startProxy();
	ensurePirunRetryDefault();
	const eventsPath = resolve(jobDir(meta.id), 'events.jsonl');
	const task = readFileSync(resolve(jobDir(meta.id), 'task.md'), 'utf8');

	const child = spawn(process.execPath, piArgs(meta, true), {
		cwd: meta.cwd,
		detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, NO_COLOR: '1', PI_OFFLINE: '1' }
	});
	const captureDone = Promise.all([
		captureLines(child.stdout, eventsPath, true),
		captureLines(child.stderr, eventsPath, false)
	]).then(() => {});

	// The prompt travels on stdin, never in argv. No quoting, no length limit,
	// no temp-file dance for the caller.
	child.stdin.write(task);
	child.stdin.end();

	meta.pid = child.pid;
	meta.piStartedAt = Date.now();
	writeMeta(meta);
	return { child, captureDone };
}

async function spawnAntigravity(meta: JobMeta) {
	if (!meta.antigravity) throw new Error(`Run ${meta.id} has no Antigravity profile metadata.`);
	const eventsPath = resolve(jobDir(meta.id), 'events.jsonl');
	const task = readFileSync(resolve(jobDir(meta.id), 'task.md'), 'utf8');
	const child = spawn(
		findAntigravityEntry(),
		antigravityRunArgs({
			profileDir: meta.antigravity.profileDir,
			conversationId: meta.session?.mode === 'continue' ? meta.session.ref : undefined,
			model: meta.model,
			effort: meta.antigravity.effort,
			agent: meta.antigravity.agent,
			approveTools: meta.tools,
			// agy's --print-timeout cannot be moved after spawn, so it gets a
			// generous internal ceiling; the supervisor enforces the real,
			// live-updatable deadline.
			timeoutSec: Math.max(meta.timeoutSec, 24 * 60 * 60)
		}),
		{
			cwd: meta.cwd,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: antigravityEnv(meta.antigravity.isolationMode)
		}
	);
	const captureDone = Promise.all([
		captureLines(child.stdout, eventsPath, true),
		captureLines(child.stderr, eventsPath, false)
	]).then(() => {});
	child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: task } })}\n`);
	meta.pid = child.pid;
	meta.piStartedAt = Date.now();
	writeMeta(meta);
	return { child, captureDone };
}

async function spawnHarness(meta: JobMeta) {
	return meta.harness === 'antigravity' ? spawnAntigravity(meta) : spawnPi(meta);
}

/** Announce the durable handle before either the caller or supervisor can exit. */
function announce(meta: JobMeta) {
	process.stderr.write(`pirun: run ${meta.id} started — check it with: pirun wait ${meta.preset} ${meta.id}
`);
}

async function runToCompletion(meta: JobMeta) {
	const { child, captureDone } = await spawnHarness(meta);

	meta.deadlineAt = (meta.piStartedAt ?? Date.now()) + meta.timeoutSec * 1000;
	writeMeta(meta);

	let timedOut = false;
	// The hard deadline lives in meta.json so `pirun time` can move it while
	// the run is live; the supervisor re-reads instead of arming one timer.
	const enforcer = setInterval(() => {
		try {
			const onDisk = JSON.parse(
				readFileSync(resolve(jobDir(meta.id), 'meta.json'), 'utf8')
			) as JobMeta;
			if (onDisk.deadlineAt) meta.deadlineAt = onDisk.deadlineAt;
		} catch {
			/* a transient read race keeps the last known deadline */
		}
		if (meta.deadlineAt && Date.now() >= meta.deadlineAt) {
			timedOut = true;
			if (child.pid) terminateProcessTree(child.pid);
		}
	}, 1000);

	const exitCode: number = await new Promise((resolveExit) => {
		child.on('exit', (code) => resolveExit(code ?? 1));
		child.on('error', () => resolveExit(1));
	});
	clearInterval(enforcer);
	await captureDone;

	meta.finishedAt = Date.now();
	meta.exitCode = exitCode;
	meta.timedOut = timedOut;
	return meta;
}

function startSupervisor(meta: JobMeta) {
	meta.supervised = true;
	writeMeta(meta);
	const supervisor = spawn(process.execPath, [PIRUN_ENTRY, '_supervise', meta.id], {
		cwd: PROJECT_DIR,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...process.env, NO_COLOR: '1', PI_OFFLINE: '1' }
	});
	meta.pid = supervisor.pid;
	meta.supervisorPid = supervisor.pid;
	if (meta.agent && meta.agentLockToken && supervisor.pid) {
		updateOwnedLock(agentLockPath(meta.agent), meta.agentLockToken, supervisor.pid, meta.id);
	}
	writeMeta(meta);
	supervisor.unref();
	return supervisor;
}

function emit(meta: JobMeta, digest: Digest, args: Args, label?: string) {
	if (args.flags.has('json')) out(JSON.stringify({ meta, digest }, null, 2));
	else renderDigest(meta, digest, { full: args.flags.has('full'), label });
}

async function observeJob(meta: JobMeta, args: Args, returnAfterSec = meta.returnAfterSec ?? DEFAULT_RETURN_AFTER_SECONDS) {
	const deadline = Date.now() + returnAfterSec * 1000;
	let current = finaliseIfExited(readMeta(meta.id));
	while (!current.finishedAt && Date.now() < deadline) {
		await new Promise((resolveObservation) => setTimeout(resolveObservation, 500));
		current = finaliseIfExited(readMeta(meta.id));
	}
	const digest = buildDigest(current.id, current);
	if (!current.finishedAt) {
		emitRunningHandoff(current, digest, args);
		process.exitCode = 2;
		return;
	}
	emit(current, digest, args, current.label);
	process.exitCode = exitCodeFor(digest.status);
}

async function commandRun(args: Args) {
	await ensureHarnessAuthentication();
	const task = readTask(args);
	const meta = createJob(args, task);
	announce(meta);
	startSupervisor(meta);
	await observeJob(meta, args);
}

/**
 * Fold a finished exchange back into the agent: learn Pi's session id from the
 * first run so later turns can continue it, and accumulate the token totals
 * that make the cache saving visible in `pirun agents`.
 */
function absorbRun(agent: AgentMeta, meta: JobMeta, digest: Digest) {
	if (!agent.sessionId && digest.sessionId) agent.sessionId = digest.sessionId;
	agent.lastRunAt = meta.finishedAt ?? Date.now();
	agent.exchanges += 1;
	agent.runs.push(meta.id);
	agent.totals.input += digest.inputTokens;
	agent.totals.cached += digest.cachedTokens;
	agent.totals.output += digest.outputTokens;
	agent.totals.cost += digest.cost;
	if (digest.contextTokens) agent.contextTokens = digest.contextTokens;
	writeAgent(agent);
}

async function commandAgent(args: Args) {
	await ensureHarnessAuthentication();
	const name = args.positional[0];
	if (!name) die('usage: pirun agent <preset> <name> <task…>');
	if (!validAgentName(name)) die(`"${name}" is not a usable agent name (letters, digits, . _ -).`);

	const task = readTask({ ...args, positional: args.positional.slice(1) });
	const lockToken = lockAgent(name);
	let meta: JobMeta;
	try {
		let agent = readAgent(name);
		if (!agent) {
			agent = {
				name,
				preset: activePresetName,
				harness: activePreset.harness,
				cwd: resolve(flagString(args, 'dir') || process.cwd()),
				model: resolveModel(flagString(args, 'model')),
				createdAt: Date.now(),
				lastRunAt: Date.now(),
				exchanges: 0,
				runs: [],
				totals: { input: 0, cached: 0, output: 0, cost: 0 }
			};
			writeAgent(agent);
		} else {
			if (agent.preset && agent.preset !== activePresetName) {
				throw new Error(`agent "${name}" belongs to preset "${agent.preset}", not "${activePresetName}".`);
			}
			if (!agent.preset) {
				agent.preset = activePresetName;
				writeAgent(agent);
			}
			if ((agent.harness ?? 'pi') !== activePreset.harness) {
				throw new Error(`agent "${name}" belongs to the ${agent.harness ?? 'pi'} harness, not ${activePreset.harness}.`);
			}
			const wantedDir = flagString(args, 'dir');
			if (wantedDir && resolve(wantedDir) !== agent.cwd) {
				throw new Error(
					`agent "${name}" works in ${agent.cwd}. Retire it, or use a different name for ${resolve(wantedDir)}.`
				);
			}
			if (flagString(args, 'model') && resolveModel(flagString(args, 'model')) !== agent.model) {
				throw new Error(`agent "${name}" is running ${agent.model}. Switching models mid-session would discard its cached prefix.`);
			}
		}
		meta = createJob(args, task, agent, `${name} #${agent.exchanges + 1}`, lockToken);
		announce(meta);
		startSupervisor(meta);
	} catch (error) {
		unlockAgent(name, lockToken);
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(meta, args);
}

async function commandFork(args: Args) {
	if (activePreset.harness === 'antigravity') {
		die('Antigravity does not expose conversation forking; start a new named agent instead.');
	}
	const [parentName, childName] = args.positional;
	if (!parentName || !childName) die('usage: pirun fork <preset> <parent> <child> <task…>');
	if (!validAgentName(childName)) die(`"${childName}" is not a usable agent name.`);

	const parent = readAgent(parentName);
	if (!parent) die(`no agent "${parentName}". Try \`pirun agents ${activePresetName}\`.`);
	if (parent.preset && parent.preset !== activePresetName) {
		die(`agent "${parentName}" belongs to preset "${parent.preset}", not "${activePresetName}".`);
	}
	if (!parent.sessionId) die(`agent "${parentName}" has no session yet — give it a task first.`);
	const task = readTask({ ...args, positional: args.positional.slice(2) });
	const lockToken = lockAgent(childName);
	let meta: JobMeta;
	try {
		if (readAgent(childName)) throw new Error(`agent "${childName}" already exists.`);
		const child: AgentMeta = {
			name: childName,
			preset: activePresetName,
			harness: 'pi',
			cwd: parent.cwd,
			model: parent.model,
			createdAt: Date.now(),
			lastRunAt: Date.now(),
			forkedFrom: parent.sessionId,
			exchanges: 0,
			runs: [],
			totals: { input: 0, cached: 0, output: 0, cost: 0 }
		};
		writeAgent(child);
		meta = createJob(args, task, child, `${childName} #1 forked from ${parentName}`, lockToken);
		announce(meta);
		startSupervisor(meta);
	} catch (error) {
		unlockAgent(childName, lockToken);
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(meta, args);
}

function agentStats(agent: AgentMeta) {
	const row = catalogue().find((entry) => entry.id === agent.model);
	const window = row?.contextWindow ?? 0;
	const used = agent.contextTokens ?? 0;
	const total = agent.totals.input + agent.totals.cached;
	return {
		window,
		used,
		usedPercent: window ? Math.round((used / window) * 100) : 0,
		headroom: window ? Math.max(0, window - used) : 0,
		hitPercent: total ? Math.round((agent.totals.cached / total) * 100) : 0,
		busy: agentIsBusy(agent.name)
	};
}

function commandAgents(args: Args) {
	const agents = presetAgents();
	if (!agents.length) {
		out(`no agents. Create one: pirun agent ${activePresetName} <name> "<task>"`);
		return;
	}

	const wanted = args.positional[0];
	if (wanted) {
		const agent = readAgent(wanted);
		if (!agent) die(`no agent "${wanted}".`);
		const stats = agentStats(agent);
		if (args.flags.has('json')) {
			out(JSON.stringify({ ...agent, stats }, null, 2));
			return;
		}
		const age = humanDuration(Date.now() - agent.lastRunAt);
		out(`${agent.name}  ${agent.model}${stats.busy ? '  [busy]' : ''}`);
		out(`  dir        ${agent.cwd}`);
		out(`  exchanges  ${agent.exchanges}   last active ${age} ago`);
		out(
			`  context    ${humanTokens(stats.used)} / ${humanTokens(stats.window)}` +
				`  (${stats.usedPercent}% used, ${humanTokens(stats.headroom)} left)`
		);
		out(
			`  tokens     in ${humanTokens(agent.totals.input)} uncached · ` +
				`${humanTokens(agent.totals.cached)} cached (${stats.hitPercent}% hit) · ` +
				`out ${humanTokens(agent.totals.output)}`
		);
		if (agent.forkedFrom) out(`  forked     from session ${agent.forkedFrom.slice(0, 8)}`);
		if (agent.sessionId) out(`  session    ${agent.sessionId}`);
		out(`  runs       ${agent.runs.slice(-8).join(' ')}`);
		return;
	}

	if (args.flags.has('json')) {
		out(JSON.stringify(agents.map((agent) => ({ ...agent, stats: agentStats(agent) })), null, 2));
		return;
	}
	for (const agent of agents) {
		const stats = agentStats(agent);
		out(
			`${agent.name.padEnd(16)} x${String(agent.exchanges).padEnd(3)} ` +
				`ctx ${(humanTokens(stats.used) + '/' + humanTokens(stats.window)).padStart(14)} (${String(stats.usedPercent).padStart(3)}%)  ` +
				`in=${humanTokens(agent.totals.input).padStart(6)} cached=${humanTokens(agent.totals.cached).padStart(6)} (${String(stats.hitPercent).padStart(3)}%) ` +
				`out=${humanTokens(agent.totals.output).padStart(6)}${stats.busy ? '  [busy]' : ''}`
		);
		out(`${' '.repeat(16)} ${agent.model}${agent.forkedFrom ? '  (forked)' : ''}`);
	}
}

function commandRetire(args: Args) {
	const names = args.flags.has('all') ? presetAgents().map((agent) => agent.name) : args.positional;
	if (!names.length) die('usage: pirun retire <preset> <name> | --all');
	for (const name of names) {
		const agent = readAgent(name);
		if (!agent) {
			out(`${name}: no such agent`);
			continue;
		}
		const lock = readOwnedLock(agentLockPath(name));
		if (lock && isAlive(lock.pid)) {
			out(`${name}: still busy (pid ${lock.pid}) — not retired`);
			continue;
		}
		removeAgentSessions(agent);
		rmSync(agentDir(name), { recursive: true, force: true });
		out(`${name}: retired after ${agent.exchanges} exchange(s)`);
	}
}

async function commandStart(args: Args) {
	await ensureHarnessAuthentication();
	const task = readTask(args);
	const meta = createJob(args, task);
	const supervisor = startSupervisor(meta);
	out(`[${meta.id}] STARTED  ${meta.model}  supervisor=${supervisor.pid}`);
	out(`wait: pirun wait ${meta.preset} ${meta.id}`);
}

async function commandSupervise(args: Args) {
	const id = args.positional[0];
	if (!id) die('missing supervised run id.');
	const readyDeadline = Date.now() + 5000;
	let meta = readMeta(id);
	while (meta.supervisorPid !== process.pid && Date.now() < readyDeadline) {
		await new Promise((resolveReady) => setTimeout(resolveReady, 25));
		meta = readMeta(id);
	}
	if (meta.supervisorPid !== process.pid) {
		throw new Error(`Run ${id} was not assigned to supervisor ${process.pid}.`);
	}
	if (meta.agent) {
		if (!meta.agentLockToken) throw new Error(`Run ${id} has no agent lock token.`);
		updateOwnedLock(agentLockPath(meta.agent), meta.agentLockToken, process.pid, id);
	}
	meta.supervisorReadyAt = Date.now();
	writeMeta(meta);
	try {
		await runToCompletion(meta);
		const digest = buildDigest(id, meta);
		atomicWriteJson(resolve(jobDir(id), 'digest.json'), digest);
		if (meta.agent) {
			const agent = readAgent(meta.agent);
			if (!agent) throw new Error(`Agent "${meta.agent}" disappeared while run ${id} was active.`);
			absorbRun(agent, meta, digest);
		}
		writeMeta(meta);
	} catch (error) {
		meta.finishedAt = Date.now();
		meta.exitCode = 1;
		meta.supervisorError = error instanceof Error ? error.message : String(error);
		writeMeta(meta);
		appendFileSync(
			resolve(jobDir(id), 'events.jsonl'),
			`${JSON.stringify({ type: 'pirun_supervisor_error', error: meta.supervisorError })}\n`
		);
	} finally {
		if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	}
}

/** Recover a job whose supervisor disappeared before writing final metadata. */
function finaliseIfExited(meta: JobMeta) {
	if (meta.finishedAt) return meta;
	if (meta.supervisorPid && isAlive(meta.supervisorPid)) return meta;
	if (!meta.supervisorPid && meta.pid && isAlive(meta.pid)) return meta;
	if (meta.supervisorPid && meta.pid && meta.pid !== meta.supervisorPid && isAlive(meta.pid)) {
		terminateProcessTree(meta.pid);
	}
	meta.finishedAt = Date.now();
	meta.exitCode = 1;
	meta.interrupted = true;
	writeMeta(meta);
	if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	return meta;
}

/** 0 = produced output, 1 = failed/empty/timed out, 2 = still running. */
function exitCodeFor(status: Digest['status']) {
	if (status === 'ok') return 0;
	if (status === 'running') return 2;
	return 1;
}

async function commandWait(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	// wait's --time is only its own blocking limit; it never rewrites the
	// already-running job's hard deadline (that is what `pirun time` is for).
	let returnAfterSec = DEFAULT_RETURN_AFTER_SECONDS;
	try {
		returnAfterSec = parseWaitTime(flagString(args, 'time'), DEFAULT_RETURN_AFTER_SECONDS);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(readPresetJob(id), args, returnAfterSec);
}

/**
 * Show or move a live run's hard deadline. `+30m` adds to the current
 * deadline; a bare `45m` sets it to 45 minutes from now — the reference point
 * is always in the spelling.
 */
function commandTime(args: Args) {
	const tokens = [...args.positional];
	let adjustRaw = '';
	if (tokens.length && /^\+|^\d/.test(tokens[tokens.length - 1]) && !/^[0-9a-f]{6}$/.test(tokens[tokens.length - 1])) {
		adjustRaw = tokens.pop() as string;
	}
	const id = tokens[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	const meta = finaliseIfExited(readPresetJob(id));
	if (meta.finishedAt) {
		out(`[${id}] already finished; nothing to retime.`);
		return;
	}
	let deadline = meta.deadlineAt ?? (meta.piStartedAt ?? meta.startedAt) + meta.timeoutSec * 1000;
	if (adjustRaw) {
		let adjust;
		try {
			adjust = parseTimeAdjust(adjustRaw);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
		deadline = adjust.mode === 'add' ? deadline + adjust.seconds * 1000 : Date.now() + adjust.seconds * 1000;
		meta.deadlineAt = deadline;
		writeMeta(meta);
	}
	out(`[${id}] hard stop ${humanClock(deadline)} (in ${humanDuration(Math.max(0, deadline - Date.now()))})`);
	if (!adjustRaw) out(`extend: pirun time ${activePresetName} ${id} +30m   set from now: pirun time ${activePresetName} ${id} 45m`);
}

/* -------------------------------------------------------------------------- */
/* provider commands (shared store, no preset)                                */
/* -------------------------------------------------------------------------- */

function maskKey(key: string) {
	if (!key) return '(missing)';
	if (key.startsWith('$')) return key;
	if (key.startsWith('!')) return '(credential command)';
	return '(literal)';
}

function providerRows() {
	const rows: Array<Record<string, unknown>> = [];
	for (const name of [...new Set([...Object.keys(CANONICAL_ENDPOINTS), ...Object.keys(providersStore.endpoints)])].sort()) {
		const entry = providersStore.endpoints[name];
		const accounts = Object.entries(entry?.accounts ?? {}).map(([account, value]) => ({
			account,
			key: maskKey(value.key),
			ready: value.key.startsWith('$') ? Boolean(process.env[value.key.slice(1)]) : Boolean(value.key)
		}));
		rows.push({
			name,
			kind: 'endpoint',
			canonical: Boolean(CANONICAL_ENDPOINTS[name]),
			baseUrl: endpointBaseUrl(providersStore, name),
			envVar: endpointEnvVar(name),
			accounts,
			detected: detectedEnvAccounts(providersStore, name),
			defaultAccount: entry?.defaultAccount ?? (accounts.length === 1 ? accounts[0].account : ''),
			models: endpointModels(providersStore, name).map((model) => model.id),
			spend: Boolean(CANONICAL_ENDPOINTS[name]?.spend)
		});
	}
	for (const name of HARNESS_PROVIDERS) {
		const entry = providersStore.harnesses[name];
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
	rows.push({ name: BUNDLED_PROVIDER, kind: 'bundled', canonical: true, baseUrl: `${BASE_URL}/v1`, accounts: [] });
	return rows;
}

function commandProviders(args: Args) {
	const presetUses: Record<string, string> = {};
	try {
		const loaded = loadPirunConfig(PIRUN_CONFIG, FALLBACK_MODEL);
		migratePresetsToProviders(loaded.config, providersStore);
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
		const headline = row.kind === 'bundled'
			? `${String(row.name).padEnd(12)} bundled proxy  ${row.baseUrl}`
			: `${String(row.name).padEnd(12)} ${row.kind}${row.canonical ? '' : ' (custom)'}  ${row.baseUrl ?? ''}`;
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

async function commandProvider(args: Args) {
	const sub = (args.positional[0] ?? '').trim().toLowerCase();
	if (sub === 'add' || sub === 'set') {
		const name = requireEndpointName(args.positional[1], sub);
		if (sub === 'add' && (HARNESS_PROVIDERS as readonly string[]).includes(name)) {
			die(`"${name}" is a canonical harness; add its accounts with: pirun login ${name} <account>`);
		}
		const entry = (providersStore.endpoints[name] ??= { accounts: {} });
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
		writeProvidersStore(providersStore);
		out(`provider "${name}"  ${endpointBaseUrl(providersStore, name)}`);
		const shown = endpointCompat(providersStore, name);
		out(`compat  bearer-header ${shown.authHeader ? 'on' : 'off'}  developer-role ${shown.supportsDeveloperRole ? 'on' : 'off'}  reasoning-effort ${shown.supportsReasoningEffort ? 'on' : 'off'}`);
		return;
	}
	if (sub === 'key') {
		const name = requireEndpointName(args.positional[1], 'key <provider> <account>');
		const account = (args.positional[2] ?? '').trim();
		if (!account || !validAccountName(account)) die('usage: pirun provider key <provider> <account> [--env VAR | --key VALUE]');
		if (!CANONICAL_ENDPOINTS[name] && !providersStore.endpoints[name]?.baseUrl) {
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
		const entry = (providersStore.endpoints[name] ??= { accounts: {} });
		entry.accounts[account] = { key };
		writeProvidersStore(providersStore);
		out(`${name}/${account}  ${maskKey(key)}`);
		return;
	}
	if (sub === 'default') {
		const name = requireEndpointName(args.positional[1], 'default <provider> <account>');
		const account = (args.positional[2] ?? '').trim();
		const entry = (HARNESS_PROVIDERS as readonly string[]).includes(name)
			? providersStore.harnesses[name]
			: providersStore.endpoints[name];
		if (!entry?.accounts[account]) die(`no account "${account}" for provider "${name}".`);
		entry.defaultAccount = account;
		writeProvidersStore(providersStore);
		out(`${name} now defaults to account "${account}".`);
		return;
	}
	if (sub === 'rm') {
		const target = (args.positional[1] ?? '').trim().toLowerCase();
		const [name, account] = target.split('/');
		if (!name) die('usage: pirun provider rm <provider>[/<account>]');
		const entry = providersStore.endpoints[name];
		if (!entry) die(`no configured provider "${name}".`);
		if (account) {
			if (!entry.accounts[account]) die(`no account "${account}" for provider "${name}".`);
			delete entry.accounts[account];
			if (entry.defaultAccount === account) delete entry.defaultAccount;
			out(`removed ${name}/${account}.`);
		} else {
			delete providersStore.endpoints[name];
			out(`removed provider "${name}" and its accounts.`);
		}
		writeProvidersStore(providersStore);
		return;
	}
	if (sub === 'model') {
		const name = requireEndpointName(args.positional[1], 'model <provider> <model-id>');
		const modelId = (args.positional[2] ?? '').trim();
		if (!modelId) die('usage: pirun provider model <provider> <model-id> [--context-window n] [--max-tokens n] [--reasoning|--no-reasoning]');
		const entry = (providersStore.endpoints[name] ??= { accounts: {} });
		entry.modelOverrides ??= {};
		const override = (entry.modelOverrides[modelId] ??= {});
		if (args.flags.has('context-window')) override.contextWindow = positiveFlagInteger(args, 'context-window', 128_000);
		if (args.flags.has('max-tokens')) override.maxTokens = positiveFlagInteger(args, 'max-tokens', 32_768);
		if (args.flags.has('reasoning') || args.flags.has('no-reasoning')) {
			override.reasoning = persistentBoolean(args, 'reasoning', 'no-reasoning', override.reasoning === true);
		}
		writeProvidersStore(providersStore);
		const merged = catalogModel(providersStore, name, modelId);
		out(`${name} ${modelId}  ctx ${humanTokens(merged?.contextWindow ?? 128_000)}  out ${humanTokens(merged?.maxTokens ?? 32_768)}  reasoning ${merged?.reasoning ? 'on' : 'off'}`);
		return;
	}
	die('usage: pirun provider add|set|key|default|rm|model …   (see: pirun help)');
}

/** Long spans in days/hours/minutes; short ones defer to humanDuration. */
function humanSpan(ms: number) {
	if (ms < 60 * 60 * 1000) return humanDuration(ms);
	const totalMinutes = Math.round(ms / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days) return `${days}d ${hours}h`;
	return `${hours}h ${minutes}m`;
}

interface SpendRow {
	provider: string;
	account: string;
	kind: 'endpoint' | 'harness';
	supported: boolean;
	lines: string[];
	limits?: AntigravityLimit[];
}

function fetchAntigravityAccountUsage(account: string): SpendRow {
	const row: SpendRow = { provider: 'antigravity', account, kind: 'harness', supported: true, lines: [] };
	const profileDir = antigravityAccountProfileDir(account);
	if (!hasAntigravityAuthMarker(profileDir)) {
		row.lines.push(`not logged in — run: pirun login antigravity ${account}`);
		return row;
	}
	try {
		// The harness reports its own rate limits: agy answers /usage
		// non-interactively in print mode, so this is ordinary CLI usage.
		const text = execFileSync(
			findAntigravityEntry(),
			[...antigravityBaseArgs(profileDir), '-p', '/usage'],
			{
				encoding: 'utf8',
				windowsHide: true,
				env: antigravityEnv(antigravityIsolationMode(profileDir)),
				timeout: 90_000
			}
		);
		const limits = parseAntigravityUsage(text);
		if (!limits.length) {
			row.lines.push(...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8));
			if (!row.lines.length) row.lines.push('the harness returned no usage information');
			return row;
		}
		row.limits = limits;
		for (const limit of limits) {
			const untilReset = Date.parse(limit.resetsAt) - Date.now();
			row.lines.push(
				`${limit.models.padEnd(22)} ${limit.window.padEnd(10)} ${String(limit.remainingPercent).padStart(3)}% remaining` +
					`  resets ${limit.resetsAt}${untilReset > 0 ? ` (in ${humanSpan(untilReset)})` : ''}`
			);
		}
	} catch (error) {
		row.supported = false;
		row.lines.push(`error: ${error instanceof Error ? error.message : String(error)}`);
	}
	return row;
}

/**
 * One interface for every consumption source: endpoint accounts answer with
 * credits/balance, harness accounts answer with their rate-limit windows and
 * reset times.
 */
async function commandSpend(args: Args) {
	const only = (args.positional[0] ?? '').trim().toLowerCase();
	const [onlyProvider = '', onlyAccount = ''] = only.split('/');
	const report: SpendRow[] = [];

	for (const name of Object.keys(providersStore.endpoints).sort()) {
		if (onlyProvider && onlyProvider !== name) continue;
		const accounts = providersStore.endpoints[name]?.accounts ?? {};
		for (const [account, value] of Object.entries(accounts)) {
			if (onlyAccount && onlyAccount !== account) continue;
			try {
				const key = resolveAccountKey(value.key);
				const spend = await fetchSpend(providersStore, name, key);
				report.push({ provider: name, account, kind: 'endpoint', supported: spend.supported, lines: spend.lines });
			} catch (error) {
				report.push({
					provider: name,
					account,
					kind: 'endpoint',
					supported: false,
					lines: [`error: ${error instanceof Error ? error.message : String(error)}`]
				});
			}
		}
	}
	for (const name of HARNESS_PROVIDERS) {
		if (onlyProvider && onlyProvider !== name) continue;
		for (const account of Object.keys(providersStore.harnesses[name]?.accounts ?? {})) {
			if (onlyAccount && onlyAccount !== account) continue;
			report.push(fetchAntigravityAccountUsage(account));
		}
	}

	if (!report.length) {
		if (only) die(`no accounts match "${only}". See: pirun providers`);
		out('no accounts configured. See: pirun providers');
		return;
	}
	if (args.flags.has('json')) {
		out(JSON.stringify(report, null, 2));
		return;
	}
	for (const row of report) {
		out(`${row.provider}/${row.account}`);
		for (const line of row.lines) out(`  ${line}`);
	}
}

function commandPoll(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	const meta = finaliseIfExited(readPresetJob(id));
	const digest = buildDigest(id, meta);
	if (!meta.finishedAt) emitRunningHandoff(meta, digest, args);
	else emit(meta, digest, args, meta.label);
	process.exitCode = exitCodeFor(digest.status);
}

/* -------------------------------------------------------------------------- */
/* other commands                                                             */
/* -------------------------------------------------------------------------- */

async function commandStatus() {
	const usesProxy = activeUse.kind === 'bundled';
	const up = usesProxy ? await proxyIsUp() : false;
	out(`preset  ${activePresetName}`);
	out(`use     ${activePreset.use}`);
	out(`service ${usesProxy ? (up ? 'ready' : 'stopped') : `not used (${activePreset.harness === 'antigravity' ? 'Antigravity account' : 'direct OpenAI completions API'})`}`);
	if (activePreset.harness === 'antigravity') {
		let entry = '';
		try { entry = findAntigravityEntry(); } catch { /* shown below */ }
		const profile = antigravityAccountProfileDir(activeUse.account);
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
	out(`default ${DEFAULT_MODEL}`);
	out(`runs    ${presetJobs().length} for this preset in ${RUNS_DIR}`);
}

function commandConfig() {
	const shown = {
		file: PIRUN_CONFIG,
		providers: providersStorePath(),
		preset: activePresetName,
		use: activePreset.use,
		harness: activePreset.harness,
		model: activePreset.model,
		effort: activePreset.effort ?? '(model default)',
		prefix: activePreset.prefix ?? '',
		dir: activePreset.dir ?? '(invocation cwd)',
		tools: activePreset.tools,
		contextFiles: activePreset.contextFiles,
		full: activePreset.full,
		json: activePreset.json,
		api: activePreset.harness === 'antigravity'
			? {
				mode: 'antigravity-account',
				baseUrl: '(managed by agy)',
				profile: antigravityAccountProfileDir(activeUse.account),
				authenticated: hasAntigravityAuthMarker(antigravityAccountProfileDir(activeUse.account)),
				agent: activePreset.antigravityAgent ?? '(default)'
			}
			: activeUse.kind === 'endpoint'
				? {
					mode: 'openai-completions',
					baseUrl: endpointBaseUrl(providersStore, activeUse.provider),
					account: activeUse.account
				}
				: { mode: 'bundled-proxy', baseUrl: `${BASE_URL}/v1` },
		presets: Object.keys(activeConfig.presets).sort()
	};
	if (activePreset.json) out(JSON.stringify(shown, null, 2));
	else {
		out(`preset  ${shown.preset}  (${shown.harness})`);
		out(`config  ${shown.file}`);
		out(`use     ${shown.use}  (${shown.api.mode}  ${shown.api.baseUrl})`);
		out(`model   ${shown.model}   effort ${shown.effort}`);
		if (shown.prefix) out(`prefix  "${truncate(shown.prefix, 60)}"  (${shown.prefix.length} chars)`);
		out(`dir     ${shown.dir}`);
		out(`tools   ${shown.tools ? 'on' : 'off'}   context-files ${shown.contextFiles ? 'on' : 'off'}`);
		out(`output  ${shown.full ? 'full' : 'digest'}  ${shown.json ? 'json' : 'text'}`);
	}
}

async function commandLogin(args: Args) {
	const harness = (args.positional[0] ?? '').trim().toLowerCase();
	const account = (args.positional[1] ?? '').trim();
	if (!(HARNESS_PROVIDERS as readonly string[]).includes(harness) || !account) {
		die(`usage: pirun login antigravity <account>   (harnesses: ${HARNESS_PROVIDERS.join(', ')})`);
	}
	if (!validAccountName(account)) die(`"${account}" is not a usable account name (letters, digits, . _ -).`);
	const entry = (providersStore.harnesses[harness] ??= { accounts: {} });
	if (!entry.accounts[account]) {
		entry.accounts[account] = {};
		writeProvidersStore(providersStore);
	}
	const holdOpen = args.flags.has('login-window');
	if (process.platform === 'win32' && !holdOpen && !args.flags.has('inline')) {
		await loginAntigravityWindowed(account);
		return;
	}
	try {
		await loginAntigravityAccount(account, true);
	} catch (error) {
		if (!holdOpen) die(error instanceof Error ? error.message : String(error));
		out(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	if (holdOpen) await holdLoginWindowOpen();
}

function commandLogout(args: Args) {
	const harness = (args.positional[0] ?? '').trim().toLowerCase();
	const account = (args.positional[1] ?? '').trim();
	if (!(HARNESS_PROVIDERS as readonly string[]).includes(harness) || !account) {
		die('usage: pirun logout antigravity <account>');
	}
	const entry = providersStore.harnesses[harness];
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
	writeProvidersStore(providersStore);
	out(`removed ${harness} account "${account}".`);
}

async function commandModels(args: Args) {
	if (activePreset.harness === 'antigravity') {
		try {
			const profileDir = antigravityAccountProfileDir(activeUse.account);
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
	if (activeUse.kind === 'endpoint') {
		const provider = activeUse.provider;
		if (args.flags.has('refresh')) {
			try {
				const key = resolveAccountKey(
					providersStore.endpoints[provider]?.accounts[activeUse.account]?.key ?? ''
				);
				const ids = await fetchEndpointModels(providersStore, provider, key);
				const entry = (providersStore.endpoints[provider] ??= { accounts: {} });
				entry.fetchedModels = ids;
				entry.fetchedAt = Date.now();
				writeProvidersStore(providersStore);
				out(`fetched ${ids.length} models from ${provider}.`);
			} catch (error) {
				die(error instanceof Error ? error.message : String(error));
			}
		}
		const filter = (args.positional[0] ?? '').toLowerCase();
		const models = endpointModels(providersStore, provider).filter(
			(model) => !filter || model.id.toLowerCase().includes(filter)
		);
		if (!models.length) {
			out(filter
				? `no ${provider} model matches "${filter}".`
				: `no known models for ${provider}. Fetch the live list: pirun models ${activePresetName} --refresh`);
			return;
		}
		if (args.flags.has('json')) {
			out(JSON.stringify({ provider, current: activePreset.model, models }, null, 2));
			return;
		}
		out(`${'  model'.padEnd(46)}${'ctx'.padStart(7)}${'out'.padStart(8)}   reasoning`);
		for (const model of models) {
			const mark = model.id === activePreset.model ? '* ' : '  ';
			const reasoning = model.alwaysReasoning ? 'always-on' : model.reasoning ? 'levels' : '-';
			out(
				`${mark}${model.id.padEnd(44)}` +
					`${humanTokens(model.contextWindow ?? 0).padStart(7)}${humanTokens(model.maxTokens ?? 0).padStart(8)}   ${reasoning}`
			);
		}
		out('');
		out(`* current. Change with: pirun model ${activePresetName} <id>   refresh: pirun models ${activePresetName} --refresh`);
		return;
	}
	const filter = (args.positional[0] ?? '').toLowerCase();
	const rows = catalogue().filter(
		(row) => !filter || modelParts(row.id).qualified.toLowerCase().includes(filter)
	);
	if (!rows.length) {
		out(filter ? `no model matches "${filter}".` : 'no models configured. Run the setup script.');
		return;
	}
	if (args.flags.has('json')) {
		out(JSON.stringify({ default: DEFAULT_MODEL, models: rows }, null, 2));
		return;
	}

	out(`${'  model'.padEnd(46)}${'ctx'.padStart(7)}${'out'.padStart(8)}   tuning`);
	for (const row of rows) {
		const mark = row.id === DEFAULT_MODEL ? '* ' : '  ';
		const tuning = row.defaults
			? [
					row.defaults.temperature !== undefined ? `temp ${row.defaults.temperature}` : '',
					row.defaults.top_p !== undefined ? `top_p ${row.defaults.top_p}` : '',
					row.defaults.reasoning_effort ? `think ${row.defaults.reasoning_effort}` : ''
				]
					.filter(Boolean)
					.join(' · ') || 'defaults'
			: 'defaults';
		out(
			`${mark}${modelParts(row.id).qualified.padEnd(44)}` +
				`${humanTokens(row.contextWindow).padStart(7)}${humanTokens(row.maxTokens).padStart(8)}   ${tuning}`
		);
	}
	out('');
	out(`* current default. Change it with: pirun model ${activePresetName} <id>`);
}

function commandModel(args: Args) {
	const wanted = args.positional[0];
	if (!wanted) {
		const row = catalogue().find((entry) => entry.id === DEFAULT_MODEL);
		out(activePreset.model);
		out(activePreset.harness === 'antigravity'
			? `provider: Antigravity account (${activePreset.use})`
			: activeUse.kind === 'endpoint'
				? `provider: ${activePreset.use} (${endpointBaseUrl(providersStore, activeUse.provider)})`
				: 'provider: bundled proxy');
		if (activePreset.effort) out(`effort: ${activePreset.effort}`);
		if (row?.defaults) {
			const shown = Object.entries(row.defaults)
				.filter(([key]) => key !== 'source')
				.map(([key, value]) => `${key}=${value}`)
				.join(' ');
			out(`tuning: ${shown || '(interface defaults)'}  [${row.defaults.source}]`);
		}
		return;
	}
	let resolved = wanted;
	if (activePreset.harness !== 'antigravity') {
		try {
			resolved = activeUse.kind === 'endpoint'
				? resolveEndpointModel(providersStore, activeUse.provider, wanted)
				: resolveProxyModel(wanted);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
	}
	if (activeUse.kind === 'bundled' && !catalogue().some((row) => row.id === resolved)) {
		die(`"${wanted}" is not a configured model. Run "pirun models ${activePresetName}" to see the list.`);
	}
	activePreset.model = resolved;
	activeConfig.presets[activePresetName] = activePreset;
	writePirunConfig(PIRUN_CONFIG, activeConfig);
	if (activeUse.kind === 'endpoint') {
		syncPiEndpointProvider(piModelsFile(), providersStore, activeUse.provider, activeUse.account, resolved);
	}
	DEFAULT_MODEL = resolveModel(resolved);
	out(`preset "${activePresetName}" now uses ${resolved}`);
}

function commandJobs() {
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

function commandLog(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	readPresetJob(id);
	const path = resolve(jobDir(id), 'events.jsonl');
	if (!existsSync(path)) die(`no events for "${id}".`);
	const grep = flagString(args, 'grep');
	const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
	for (const line of grep ? lines.filter((l) => l.includes(grep)) : lines) out(line);
}

function commandClean(args: Args) {
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

function commandStopJob(args: Args) {
	const id = args.positional[0];
	if (!id) die('usage: pirun kill <preset> <id>');
	let meta = finaliseIfExited(readPresetJob(id));
	if (meta.finishedAt) {
		out(`[${id}] already finished`);
		return;
	}

	// Once Pi has started, stop it and leave the live supervisor to record the
	// real exit and release any named-agent lock. Before that hand-off, the only
	// process to stop is the supervisor itself, so finalise the record here.
	if (meta.pid && meta.supervisorPid && meta.pid !== meta.supervisorPid && isAlive(meta.pid)) {
		terminateProcessTree(meta.pid);
		out(`[${id}] stop requested`);
		return;
	}
	if (meta.supervisorPid && isAlive(meta.supervisorPid)) process.kill(meta.supervisorPid);
	meta = finaliseIfExited(readMeta(id));
	if (!meta.finishedAt) {
		meta.finishedAt = Date.now();
		meta.exitCode = 130;
		meta.interrupted = true;
		writeMeta(meta);
		if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	}
	out(`[${id}] killed`);
}

function commandHelp() {
	out(`pirun — delegate work to persistent coding-agent harnesses.

Every preset command takes its preset name immediately after the command.
Options supplied while starting an agent automatically update that preset in
${PIRUN_CONFIG}; omitted options load from it. There is no setup step.
Prompts and --time are never persisted. Authentication lives in the shared
provider store, not in presets — authenticate once, use from any preset.

  pirun agent <preset> <name> --time <ra>/<to> <task…>
                                   give a named agent a task; it remembers
  pirun agents <preset> [<name>] [--json]
                                   roster, or one agent's context and token use
  pirun fork <preset> <parent> <child> --time <ra>/<to> <task…>
                                   branch a primed agent; the child inherits
                                   its context, and the provider's cache
  pirun retire <preset> <name> | --all
                                   end an agent and drop its session

  pirun run <preset> --time <ra>/<to> <task…>
                                   one-shot, no memory; for throwaway work
  pirun start <preset> --time <ra>/<to> <task…>
                                   one-shot, detached; prints a run id
  pirun poll <preset> [id] [--full|--json]
                                   digest for a run (default: the most recent)
  pirun wait <preset> [id] [--time <dur>]
                                   re-attach to a run for up to <dur> (default 10m)
  pirun time <preset> [id] [+30m|45m]
                                   show or move a live run's hard stop:
                                   +30m extends it, 45m sets it from now
  pirun jobs <preset>              recent runs, one line each
  pirun log <preset> [id] [--grep <text>]
                                   the raw JSON event stream for a run
  pirun kill <preset> <id>         stop a run
  pirun clean <preset> [--all|--sessions]
                                   delete old runs or orphaned sessions

  pirun config <preset>            inspect the selected preset
  pirun status <preset>            service, harness and model wiring at a glance
  pirun models <preset> [filter] [--json] [--refresh]
                                   the preset's provider's models (--refresh
                                   pulls the live /models list)
  pirun model <preset> [<id>]      show or set the preset's model
  pirun up|down|restart <preset>   manage the bundled proxy
  pirun speedtest <preset> [options]

Provider store (shared across presets; no preset argument):
  pirun providers [--json]         every provider, account, and readiness —
                                   the one call that shows what --use can say
  pirun login antigravity <account>
                                   authenticate an isolated harness account
                                   (Windows opens a separate paste-ready login
                                   window; --inline stays in this terminal)
  pirun logout antigravity <account>
  pirun provider add <name> --base-url <url>
                                   register a custom OpenAI-compatible endpoint
  pirun provider set <name> [--base-url <url>] [compat flags]
  pirun provider key <provider> <account> [--env VAR | --key VALUE]
                                   add or replace an api-key account
  pirun provider default <provider> <account>
  pirun provider rm <provider>[/<account>]
  pirun provider model <provider> <id> [--context-window n] [--max-tokens n]
                                   [--reasoning|--no-reasoning]
  pirun spend [provider[/account]] [--json]
                                   one interface for every source: endpoint
                                   accounts report credits/balance, harness
                                   accounts report their rate-limit windows
                                   (five-hour/weekly/monthly) and reset times

Timers are required on every start and never persisted:
  --time <return-after>/<timeout>  e.g. --time 10m/2h — the caller gets its
  progress checkpoint after 10m (exit code 2, run keeps going), and the run is
  hard-stopped at 2h. Both parts must be positive; to run unattended,
  background the pirun command itself.

Persistent preset options (accepted by every preset command):
  --use <provider[/account]>       the consumption source. Canonical endpoints
                                   (${Object.keys(CANONICAL_ENDPOINTS).join(', ')})
                                   need zero setup when their standard env var
                                   is set (${endpointEnvVar('deepseek')}, or
                                   ${endpointEnvVar('deepseek')}_<ACCOUNT> per account).
                                   Harness accounts: --use antigravity/<account>.
                                   Bundled proxy: --use bundled.
  --model <id-or-fragment>         resolved against the provider's catalog
  --effort <off|min|low|medium|high|max|Nk>
                                   reasoning intent, mapped per model — safe to
                                   set even for models without a knob
  --prefix "<text>" | --prefix-file <path> | --no-prefix
                                   text prepended to every prompt of this preset
  --dir <path>  --antigravity-agent <name>
  --tools|--no-tools --context-files|--no-context-files
  --full|--no-full --json|--no-json

First launch (one command, everything persists):
  pirun agent fast worker --time 10m/2h "Implement the change" \
    --use deepseek --model deepseek-chat --effort high

Later launches load the saved settings:
  pirun agent fast worker --time 10m/2h "Continue with the next change"

Exit status: 0 the run produced output, 1 it failed / came back empty / timed
out, 2 it is still running (poll again). A failed or empty digest carries the
provider's own error, plus anything the backing service logged alongside it.`);
}

/* -------------------------------------------------------------------------- */
/* dispatch                                                                   */
/* -------------------------------------------------------------------------- */

let args: Args;
try {
	args = parsePirunArgs(process.argv.slice(2));
} catch (error) {
	die(error instanceof Error ? error.message : String(error));
}

if (!['_supervise', 'help', '--help', '-h'].includes(args.command) && !PROVIDER_COMMANDS.has(args.command)) {
	configurePreset(args);
}

switch (args.command) {
	case 'agent':
		await commandAgent(args);
		break;
	case 'agents':
		commandAgents(args);
		break;
	case 'fork':
		await commandFork(args);
		break;
	case 'retire':
		commandRetire(args);
		break;
	case 'run':
		await commandRun(args);
		break;
	case 'start':
		await commandStart(args);
		break;
	case '_supervise':
		await commandSupervise(args);
		break;
	case 'poll':
		commandPoll(args);
		break;
	case 'wait':
		await commandWait(args);
		break;
	case 'jobs':
		commandJobs();
		break;
	case 'log':
		commandLog(args);
		break;
	case 'kill':
		commandStopJob(args);
		break;
	case 'clean':
		commandClean(args);
		break;
	case 'status':
		await commandStatus();
		break;
	case 'config':
		commandConfig();
		break;
	case 'login':
		await commandLogin(args);
		break;
	case 'logout':
		commandLogout(args);
		break;
	case 'providers':
		commandProviders(args);
		break;
	case 'provider':
		await commandProvider(args);
		break;
	case 'spend':
		await commandSpend(args);
		break;
	case 'time':
		commandTime(args);
		break;
	case 'models':
		await commandModels(args);
		break;
	case 'model':
		commandModel(args);
		break;
	case 'speedtest': {
		const { runSpeedTestCli } = await import('./speed-test.ts');
		await runSpeedTestCli(args.positional);
		break;
	}
	case 'up': {
		const result = await startProxy();
		out(result.started ? 'service started' : 'service already running');
		break;
	}
	case 'restart': {
		await stopProxy();
		await new Promise((r) => setTimeout(r, 500));
		await startProxy();
		out('service restarted');
		break;
	}
	case 'down': {
		const result = await stopProxy();
		out(`service ${result === 'still up' ? 'still running' : result}`);
		if (result === 'still up') process.exitCode = 1;
		break;
	}
	case 'help':
	case '--help':
	case '-h':
		commandHelp();
		break;
	default:
		die(`unknown command "${args.command}". Run "pirun help".`);
}
