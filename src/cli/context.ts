/**
 * Shared CLI context: paths, constants, the active-preset state every command
 * module reads, and the small output/formatting helpers. This module must not
 * import any other `src/cli/*` module — it is the root of the import graph.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PROJECT_DIR } from '../paths.ts';
import { loadSettings } from '../settings.ts';
import {
	BUNDLED_PROVIDER,
	loadProvidersStore,
	type ProvidersStore,
	type ResolvedUse
} from '../pirun-providers.ts';
import { defaultPreset, type PirunConfig, type PirunPreset } from '../pirun-config.ts';
import { terminateProcessTree } from '../pirun-process.ts';

export const settings = loadSettings();
export const BASE_URL = `http://${settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host}:${settings.port}`;
export const RUNS_DIR = resolve(PROJECT_DIR, '.runs');
export const AGENTS_DIR = resolve(RUNS_DIR, 'agents');
/**
 * Every agent's Pi session lives in one directory. Pi resolves `--session-id`
 * and `--fork` within a session directory, so keeping them together is what
 * makes forking one agent off another possible at all.
 */
export const SESSIONS_DIR = resolve(RUNS_DIR, 'sessions');
export const PROXY_LOG = resolve(RUNS_DIR, 'proxy.log');
export const PROXY_PID = resolve(RUNS_DIR, 'proxy.pid');
export const SERVER_ENTRY = resolve(PROJECT_DIR, 'src', 'server.ts');
export const PIRUN_ENTRY = resolve(PROJECT_DIR, 'bin', 'pirun.ts');
export const MAX_PROXY_LOG_BYTES = 10 * 1024 * 1024;
export const RETENTION_DAYS = positiveEnvNumber('PIRUN_RETENTION_DAYS', 30);
export const MAX_STORAGE_BYTES = positiveEnvNumber('PIRUN_MAX_STORAGE_MB', 1024) * 1024 * 1024;

/**
 * Default model. Deliberately a direct-provider one: the `commandcode.*` route
 * goes through the Command Code CLI, which prepends roughly 7,400 tokens of its
 * own system prompt to every single request. Pi's entire prompt is under 1,000.
 * Model choice is a bigger token lever here than any Pi flag.
 */
export const PIRUN_CONFIG = process.env.PIRUN_CONFIG_PATH
	? resolve(process.env.PIRUN_CONFIG_PATH)
	: resolve(PROJECT_DIR, 'pirun.json');
export const FALLBACK_MODEL = 'cladgpt-proxy/deepseek.deepseek-v4-flash';

/** Mutable CLI-wide state, populated by configurePreset before dispatch. */
export const state = {
	presetName: '',
	preset: defaultPreset(FALLBACK_MODEL) as PirunPreset,
	config: { version: 2, presets: {} } as PirunConfig,
	defaultModel: FALLBACK_MODEL,
	providersStore: loadProvidersStore() as ProvidersStore,
	/** The preset's resolved provider/account, set by configurePreset. */
	use: { kind: 'bundled', provider: BUNDLED_PROVIDER, account: '', created: false } as ResolvedUse
};

/* -------------------------------------------------------------------------- */
/* output                                                                     */
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

export function out(line = '') {
	if (stdoutClosed) return;
	try {
		process.stdout.write(`${line}\n`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPIPE') stdoutClosed = true;
		else throw error;
	}
}

export function die(message: string, code = 1): never {
	process.stderr.write(`pirun: ${message}\n`);
	process.exit(code);
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

export function ensureRunsDir() {
	if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

export function humanDuration(ms: number) {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	return `${minutes}m${totalSeconds % 60}s`;
}

/** Long spans in days/hours/minutes; short ones defer to humanDuration. */
export function humanSpan(ms: number) {
	if (ms < 60 * 60 * 1000) return humanDuration(ms);
	const totalMinutes = Math.round(ms / 60_000);
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days) return `${days}d ${hours}h`;
	return `${hours}h ${minutes}m`;
}

export function humanTokens(value: number) {
	if (!value) return '0';
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

export function truncate(value: string, max: number) {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAlive(pid: number) {
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

export function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs = 0) {
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
