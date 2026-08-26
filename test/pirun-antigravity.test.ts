import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import {
	antigravityOAuthUrl,
	antigravityProfileDir,
	antigravityRunArgs,
	ensureAntigravityProfile,
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
			approveTools: true,
			timeoutSec: 90
		});
		assert.deepEqual(args, [
			'--gemini_dir', dir,
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			'--print-timeout', '90s',
			'--conversation', 'conv-1',
			'--dangerously-skip-permissions'
		]);
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
