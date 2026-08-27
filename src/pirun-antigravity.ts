import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import { pirunStateRoot } from './paths.ts';

const FILE_STORAGE_PATTERN = /Using file-based token storage/i;
const KEYRING_PATTERN = /authenticated via keyring|Using keyring token storage/i;
const AUTH_SUCCESS_PATTERN = /OAuth: authenticated successfully as|Print mode: silent auth succeeded/i;
const INELIGIBLE_PATTERN = /Account ineligible|not eligible for Antigravity/i;

export function antigravityProfileDir(presetName: string) {
	const safe = presetName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset';
	const hash = createHash('sha256').update(presetName).digest('hex').slice(0, 8);
	return resolve(pirunStateRoot(), 'profiles', `${safe.slice(0, 40)}-${hash}`, 'antigravity');
}

export function ensureAntigravityProfile(profileDir: string) {
	mkdirSync(profileDir, { recursive: true, mode: 0o700 });
	seedAntigravityProfileDefaults(profileDir);
}

/**
 * Fresh profiles start with interaction-data collection disabled. Antigravity
 * treats this as onboarding state, so writing it before the first launch makes
 * "do not share data" the default for every new Pirun account. An existing
 * settings file is never touched: the user's own choice wins.
 */
export function seedAntigravityProfileDefaults(profileDir: string) {
	const cliDir = resolve(profileDir, 'antigravity-cli');
	const settingsPath = resolve(cliDir, 'settings.json');
	if (existsSync(settingsPath)) return;
	mkdirSync(cliDir, { recursive: true, mode: 0o700 });
	writeFileSync(settingsPath, `${JSON.stringify({ enableTelemetry: false }, null, 2)}\n`, { mode: 0o600 });
}

export function findAntigravityEntry() {
	const candidates = [
		process.env.PIRUN_ANTIGRAVITY_ENTRY,
		process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
		process.env.HOME && resolve(process.env.HOME, '.local', 'bin', 'agy')
	].filter((entry): entry is string => Boolean(entry));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	try {
		const command = process.platform === 'win32' ? 'where.exe' : 'which';
		const found = execFileSync(command, ['agy'], { encoding: 'utf8', windowsHide: true })
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		if (found) return found;
	} catch {
		// Fall through to the actionable error below.
	}
	throw new Error(
		'could not find the Antigravity CLI. Install agy from https://antigravity.google/docs/cli/install/ ' +
			'or set PIRUN_ANTIGRAVITY_ENTRY to the executable path.'
	);
}

export type AntigravityIsolationMode = 'force-file' | 'ssh-file';

export function antigravityEnv(mode: AntigravityIsolationMode = 'force-file') {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NO_COLOR: '1',
		// Antigravity otherwise uses one fixed OS-keyring identity, which makes
		// concurrent accounts impossible. This keeps OAuth inside --gemini_dir.
		GEMINI_FORCE_FILE_STORAGE: 'true'
	};
	if (mode === 'ssh-file') {
		// Current agy releases explicitly choose file storage for SSH sessions.
		// The values are only a local capability hint; no SSH connection is made.
		env.SSH_CLIENT = env.SSH_CLIENT || '127.0.0.1 1 1';
		env.SSH_CONNECTION = env.SSH_CONNECTION || '127.0.0.1 1 127.0.0.1 1';
	}
	return env;
}

export function antigravityBaseArgs(profileDir: string) {
	ensureAntigravityProfile(profileDir);
	return ['--gemini_dir', profileDir];
}

export function antigravityOAuthUrl(terminalOutput: string) {
	const plain = terminalOutput.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
	const urlStart = plain.indexOf('https://accounts.google.com/o/oauth2/auth?');
	if (urlStart === -1) return '';
	const compact = plain.slice(urlStart).replace(/\s+/g, '');
	return /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?.*?&state=[A-Za-z0-9_-]{22}/.exec(compact)?.[0] ?? '';
}

export interface AntigravityLimit {
	/** Model group the limit applies to, e.g. "Gemini Models". */
	models: string;
	/** Normalized window: five-hour, weekly, monthly — or the raw label. */
	window: string;
	remainingPercent: number;
	/** ISO timestamp at which the window resets. */
	resetsAt: string;
}

/**
 * `agy -p "/usage"` prints one tab-separated row per limit window:
 * `<model group>\t<label> Limit Remaining\t<percent>%\t<reset ISO>`. Parsing
 * stays permissive — unknown labels pass through so a new window kind never
 * hides data.
 */
export function parseAntigravityUsage(text: string): AntigravityLimit[] {
	const limits: AntigravityLimit[] = [];
	for (const line of text.split(/\r?\n/)) {
		const parts = line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
		if (parts.length < 4) continue;
		const percent = /^(\d+(?:\.\d+)?)%$/.exec(parts[2]);
		if (!percent || Number.isNaN(Date.parse(parts[3]))) continue;
		const label = parts[1].replace(/\s*limit\s*remaining\s*$/i, '').trim().toLowerCase();
		const window = label.includes('five hour')
			? 'five-hour'
			: ['weekly', 'monthly', 'daily'].find((kind) => label.includes(kind.slice(0, -2))) ?? label;
		limits.push({
			models: parts[0],
			window,
			remainingPercent: Number(percent[1]),
			resetsAt: parts[3]
		});
	}
	return limits;
}

export function antigravityRunArgs(options: {
	profileDir: string;
	conversationId?: string;
	model?: string;
	effort?: string;
	agent?: string;
	/**
	 * The run's working directory, registered as agy's workspace. Without
	 * --add-dir, agy has "no active workspace set" and writes relative paths
	 * into the profile scratch dir instead of the cwd (confirmed UXA round 2).
	 */
	workspaceDir?: string;
	/** From the permission registry; empty = agy's default deny-when-headless. */
	permissionArgs?: string[];
	timeoutSec: number;
}) {
	const args = [
		...antigravityBaseArgs(options.profileDir),
		'--input-format',
		'stream-json',
		'--output-format',
		'stream-json',
		'--print-timeout',
		`${options.timeoutSec}s`
	];
	if (options.conversationId) args.push('--conversation', options.conversationId);
	if (options.model && options.model !== 'auto') args.push('--model', options.model);
	if (options.effort) args.push('--effort', options.effort);
	if (options.agent) args.push('--agent', options.agent);
	if (options.workspaceDir) args.push('--add-dir', options.workspaceDir);
	args.push(...(options.permissionArgs ?? []));
	return args;
}

function filesBelow(path: string): string[] {
	if (!existsSync(path)) return [];
	const result: string[] = [];
	for (const entry of readdirSync(path)) {
		const child = resolve(path, entry);
		let stats;
		try {
			stats = statSync(child);
		} catch {
			continue;
		}
		if (stats.isDirectory()) result.push(...filesBelow(child));
		else if (stats.isFile() && stats.size <= 4 * 1024 * 1024) result.push(child);
	}
	return result;
}

function recentProfileText(profileDir: string, since = 0) {
	const pieces: string[] = [];
	for (const path of filesBelow(profileDir)) {
		let stats;
		try {
			stats = statSync(path);
			if (stats.mtimeMs < since - 2_000) continue;
			pieces.push(readFileSync(path, 'utf8'));
		} catch {
			// Binary databases and files changing during inspection are irrelevant.
		}
	}
	return pieces.join('\n');
}

export function inspectAntigravityProfile(profileDir: string, since = 0) {
	const text = recentProfileText(profileDir, since);
	return {
		usesFileStorage: FILE_STORAGE_PATTERN.test(text),
		usesKeyring: KEYRING_PATTERN.test(text),
		authenticated: AUTH_SUCCESS_PATTERN.test(text),
		ineligible: INELIGIBLE_PATTERN.test(text)
	};
}

function authMarkerPath(profileDir: string) {
	return resolve(profileDir, 'pirun-auth.json');
}

export function hasAntigravityAuthMarker(profileDir: string) {
	return existsSync(authMarkerPath(profileDir));
}

/** Marker modification time in ms, or 0 when no marker exists. */
export function antigravityAuthMarkerTime(profileDir: string) {
	try {
		return statSync(authMarkerPath(profileDir)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * When agy last rewrote its OAuth token bundle (ms), or 0 when absent. agy
 * refreshes the bundle silently whenever an authenticated call finds the
 * access token expired, so this mtime is the auth-freshness signal — read as
 * metadata only, never contents. Version-sensitive: path proven with agy
 * 1.1.21; revalidate on upgrades.
 */
export function antigravityTokenTime(profileDir: string) {
	try {
		return statSync(resolve(profileDir, 'antigravity-cli', 'antigravity-oauth-token')).mtimeMs;
	} catch {
		return 0;
	}
}

export function antigravityIsolationMode(profileDir: string): AntigravityIsolationMode {
	try {
		const marker = JSON.parse(readFileSync(authMarkerPath(profileDir), 'utf8')) as { isolationMode?: unknown };
		return marker.isolationMode === 'ssh-file' ? 'ssh-file' : 'force-file';
	} catch {
		return 'force-file';
	}
}

export function markAntigravityAuthenticated(profileDir: string, isolationMode: AntigravityIsolationMode) {
	ensureAntigravityProfile(profileDir);
	writeFileSync(
		authMarkerPath(profileDir),
		JSON.stringify({ authenticatedAt: new Date().toISOString(), storage: 'file', isolationMode }, null, 2),
		{ mode: 0o600 }
	);
}
