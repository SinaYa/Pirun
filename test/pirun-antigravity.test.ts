import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve, sep } from 'node:path';
import {
	antigravityOAuthUrl,
	antigravityProfileDir,
	antigravityRunArgs,
	classifyAntigravityBlock,
	ensureAntigravityProfile,
	fallbackAntigravityPaths,
	findAntigravityEntry,
	parseAntigravityUsage
} from '../src/pirun-antigravity.ts';

// All tests here are offline: they exercise pure string parsing and local file
// seeding only. Nothing contacts Google, Antigravity, or a browser.

const STATE = 'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=y&state=AbCdEfGhIjKlMnOpQrStUv';

test('extracts an OAuth URL wrapped across terminal lines with ANSI codes', () => {
	const wrapped =
		'\x1b[36mVisit this URL:\x1b[0m\r\n' +
		'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect\r\n' +
		'_uri=y&state=AbCdEfGhIjKlMnOpQrStUv trailing text';
	assert.equal(antigravityOAuthUrl(wrapped), STATE);
});

test('returns empty string when no OAuth URL is present', () => {
	assert.equal(antigravityOAuthUrl('starting agy…\nno url here'), '');
});

test('profile paths are stable and collision-resistant', () => {
	process.env.PIRUN_STATE_DIR = resolve(tmpdir(), 'pirun-test-state');
	try {
		const one = antigravityProfileDir('work-google');
		assert.equal(one, antigravityProfileDir('work-google'));
		// Same sanitized name, different original names, must not collide.
		assert.notEqual(antigravityProfileDir('a.b'), antigravityProfileDir('a_b'));
		assert.match(one.split(sep).at(-2) ?? '', /^work-google-[0-9a-f]{8}$/);
	} finally {
		delete process.env.PIRUN_STATE_DIR;
	}
});

test('run args follow normal agy CLI usage', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'pirun-agy-'));
	try {
		const args = antigravityRunArgs({
			profileDir: dir,
			conversationId: 'conv-1',
			model: 'auto',
			workspaceDir: 'D:\\work\\project',
			permissionArgs: ['--mode', 'accept-edits'],
			timeoutSec: 90
		});
		assert.deepEqual(args, [
			'--gemini_dir', dir,
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--print-timeout', '90s',
			'--conversation', 'conv-1',
			'--add-dir', 'D:\\work\\project',
			'--mode', 'accept-edits'
		]);
		// A continuation must reuse its conversation's project, never make one.
		assert.ok(!args.includes('--new-project'));
		// No permission args = agy's own default policy, nothing injected; and a
		// fresh conversation gets its own project (write_to_file race, see source).
		const fresh = antigravityRunArgs({ profileDir: dir, timeoutSec: 5 });
		assert.ok(!fresh.includes('--mode'));
		assert.ok(fresh.includes('--new-project'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('agy /usage output parses into normalized limit windows', () => {
	const text =
		'Gemini Models\tWeekly Limit Remaining\t95%\t2026-08-31T06:37:38Z\r\n' +
		'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-08-26T22:23:52Z\n' +
		'Claude and GPT models\tMonthly Limit Remaining\t42%\t2026-09-02T20:30:16Z\n' +
		'Fetching available models...\n' +
		'not a limit line';
	assert.deepEqual(parseAntigravityUsage(text), [
		{ models: 'Gemini Models', window: 'weekly', remainingPercent: 95, resetsAt: '2026-08-31T06:37:38Z' },
		{ models: 'Gemini Models', window: 'five-hour', remainingPercent: 100, resetsAt: '2026-08-26T22:23:52Z' },
		{ models: 'Claude and GPT models', window: 'monthly', remainingPercent: 42, resetsAt: '2026-09-02T20:30:16Z' }
	]);
	assert.deepEqual(parseAntigravityUsage('no usage here'), []);
});

test('fresh profiles are seeded with telemetry disabled, existing settings untouched', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'pirun-profile-'));
	try {
		ensureAntigravityProfile(dir);
		const settingsPath = resolve(dir, 'antigravity-cli', 'settings.json');
		assert.ok(existsSync(settingsPath));
		assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { enableTelemetry: false });
		// A second ensure must not rewrite the user's file.
		const before = readFileSync(settingsPath, 'utf8');
		ensureAntigravityProfile(dir);
		assert.equal(readFileSync(settingsPath, 'utf8'), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const WINDOWS = process.platform === 'win32';

/** Runs body with env replaced, then restores exactly what was there. */
function withEnv(overrides: Record<string, string | undefined>, body: () => void) {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		body();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function plantAgy(...segments: string[]) {
	const path = resolve(...segments);
	mkdirSync(resolve(path, '..'), { recursive: true });
	writeFileSync(path, 'binary');
	return path;
}

/** Env that makes the canonical tier and PATH miss deterministically. */
function blankSearchEnv(empty: string) {
	return {
		PIRUN_ANTIGRAVITY_ENTRY: undefined,
		PATH: empty,
		Path: empty,
		LOCALAPPDATA: empty,
		APPDATA: empty,
		ProgramData: empty,
		SCOOP: undefined,
		USERPROFILE: empty,
		PROGRAMFILES: empty,
		'PROGRAMFILES(X86)': empty,
		HOME: empty
	};
}

test('the wider search lists the layouts agy actually installs into', () => {
	const listed = fallbackAntigravityPaths();
	const joined = listed.join('|').replace(/[/]/g, '~').replace(/[^~a-zA-Z0-9.|:-]/g, '~');
	if (WINDOWS) {
		assert.ok(joined.includes('scoop~apps~agy~current~bin~agy.exe'), joined);
		assert.ok(listed.some((path) => path.toLowerCase().includes('programs')), joined);
	} else {
		assert.ok(listed.includes('/opt/antigravity/bin/agy'), joined);
		assert.ok(listed.includes('/usr/local/bin/agy'), joined);
	}
});

/** where.exe/which must itself be resolvable, so PATH always keeps the system dir. */
const SYSTEM_PATH = WINDOWS ? resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32') : '/usr/bin';

function assertSameFile(actual: string, expected: string) {
	const normalize = (path: string) => (WINDOWS ? path.toLowerCase() : path);
	assert.equal(normalize(actual), normalize(expected));
}

test('the search order is unchanged: explicit entry, canonical paths, PATH, then wider', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'pirun-agy-order-'));
	try {
		const empty = resolve(root, 'empty');
		mkdirSync(empty, { recursive: true });
		const canonicalRoot = resolve(root, 'canonical');
		const widerRoot = resolve(root, 'wider');
		const explicit = plantAgy(root, 'explicit', WINDOWS ? 'agy.exe' : 'agy');
		const onPath = plantAgy(root, 'onpath', WINDOWS ? 'agy.exe' : 'agy');
		const canonical = WINDOWS
			? plantAgy(canonicalRoot, 'agy', 'bin', 'agy.exe')
			: plantAgy(canonicalRoot, '.local', 'bin', 'agy');
		const wider = WINDOWS
			? plantAgy(widerRoot, 'agy', 'bin', 'agy.exe')
			: plantAgy(widerRoot, 'bin', 'agy');
		// POSIX reads both tiers off HOME, so the canonical home needs a wider hit too.
		if (!WINDOWS) {
			plantAgy(canonicalRoot, 'bin', 'agy');
			for (const entry of [onPath, canonical, wider]) chmodSync(entry, 0o755);
		}

		const searchPath = [resolve(root, 'onpath'), SYSTEM_PATH].join(delimiter);
		const base = {
			...blankSearchEnv(empty),
			PATH: searchPath,
			Path: searchPath,
			...(WINDOWS ? { PROGRAMFILES: widerRoot } : { HOME: widerRoot })
		};
		const withCanonical = WINDOWS ? { LOCALAPPDATA: canonicalRoot } : { HOME: canonicalRoot };

		// An explicit entry beats every discovered install.
		withEnv({ ...base, ...withCanonical, PIRUN_ANTIGRAVITY_ENTRY: explicit }, () => {
			assertSameFile(findAntigravityEntry(), explicit);
		});
		// The canonical install beats PATH and the wider search.
		withEnv({ ...base, ...withCanonical }, () => {
			assertSameFile(findAntigravityEntry(), canonical);
		});
		// PATH beats the wider search: the tier stays last precisely so an agy a
		// user already resolves through PATH never silently moves to another copy.
		withEnv(base, () => {
			assertSameFile(findAntigravityEntry(), onPath);
		});
		// Only with PATH empty does the wider search decide.
		withEnv({ ...base, PATH: empty, Path: empty }, () => {
			assertSameFile(findAntigravityEntry(), wider);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the wider search finds an install the canonical paths and PATH both miss', (t) => {
	if (!WINDOWS && (existsSync('/usr/local/bin/agy') || existsSync('/usr/bin/agy'))) {
		t.skip('a real system-wide agy would legitimately win this lookup');
		return;
	}
	const root = mkdtempSync(resolve(tmpdir(), 'pirun-agy-wider-'));
	try {
		const empty = resolve(root, 'empty');
		mkdirSync(empty, { recursive: true });
		const target = WINDOWS
			? plantAgy(root, 'scoop', 'apps', 'agy', 'current', 'bin', 'agy.exe')
			: plantAgy(root, 'bin', 'agy');
		const env = { ...blankSearchEnv(empty), ...(WINDOWS ? { USERPROFILE: root } : { HOME: root }) };
		withEnv(env, () => {
			assert.equal(findAntigravityEntry(), target);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('nothing installed still fails with an actionable message', () => {
	const root = mkdtempSync(resolve(tmpdir(), 'pirun-agy-none-'));
	try {
		if (!WINDOWS && (existsSync('/usr/local/bin/agy') || existsSync('/usr/bin/agy'))) return;
		withEnv(blankSearchEnv(root), () => {
			assert.throws(() => findAntigravityEntry(), /could not find the Antigravity CLI[\s\S]*PIRUN_ANTIGRAVITY_ENTRY/);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the three agy refusals are told apart, licence before location', () => {
	const license = classifyAntigravityBlock('{"error":{"code":403,"reason":"SUBSCRIPTION_REQUIRED"}}');
	assert.equal(license?.kind, 'license');
	assert.match(license?.note ?? '', /license/);
	assert.equal(
		classifyAntigravityBlock('You do not have a valid license of this product. (#3501)')?.kind,
		'license'
	);
	const location = classifyAntigravityBlock('User location is not supported for the API use.');
	assert.equal(location?.kind, 'location');
	assert.match(location?.note ?? '', /location/);
	assert.equal(classifyAntigravityBlock('Account ineligible in this location')?.kind, 'location');
	assert.equal(classifyAntigravityBlock('HTTP 500 Internal Server Error')?.kind, 'server');
	assert.equal(classifyAntigravityBlock('Internal error encountered.')?.kind, 'server');
	// A 403 body that also names a location is a licence problem, not a move.
	assert.equal(
		classifyAntigravityBlock('SUBSCRIPTION_REQUIRED: User location is not supported')?.kind,
		'license'
	);
	assert.equal(classifyAntigravityBlock('tool failed: file not found'), null);
	assert.equal(classifyAntigravityBlock(''), null);
});
