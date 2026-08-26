import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ensurePirunRetryDefault, PIRUN_DEFAULT_MAX_RETRIES } from '../src/pirun-pi-settings.ts';

function withTempDir(run: (dir: string) => void) {
	const dir = mkdtempSync(resolve(tmpdir(), 'pirun-settings-'));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('pirun initializes Pi with five retries when no value is configured', () => {
	withTempDir((dir) => {
		const result = ensurePirunRetryDefault(dir);
		const settings = JSON.parse(readFileSync(result.settingsPath, 'utf8'));

		assert.equal(result.changed, true);
		assert.equal(settings.retry.maxRetries, PIRUN_DEFAULT_MAX_RETRIES);
	});
});

test('pirun preserves an explicit Pi retry value and unrelated settings', () => {
	withTempDir((dir) => {
		const settingsPath = resolve(dir, 'settings.json');
		writeFileSync(settingsPath, JSON.stringify({ retry: { maxRetries: 7 }, theme: 'dark' }));

		const result = ensurePirunRetryDefault(dir);
		const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

		assert.equal(result.changed, false);
		assert.equal(settings.retry.maxRetries, 7);
		assert.equal(settings.theme, 'dark');
	});
});

test('pirun adds its retry default without discarding existing retry settings', () => {
	withTempDir((dir) => {
		const settingsPath = resolve(dir, 'settings.json');
		writeFileSync(settingsPath, JSON.stringify({ retry: { enabled: false, baseDelayMs: 1234 } }));

		ensurePirunRetryDefault(dir);
		const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));

		assert.deepEqual(settings.retry, {
			enabled: false,
			baseDelayMs: 1234,
			maxRetries: PIRUN_DEFAULT_MAX_RETRIES
		});
	});
});
