import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, test } from 'node:test';

// Characterization tests for the CLI surface: everything here is offline and
// isolated (own config file, own providers store, own home directory for the
// Pi registry, a fake api key — no harness, no network).
const projectDir = resolve(import.meta.dirname, '..');
const pirunEntry = resolve(projectDir, 'bin', 'pirun.ts');
const sandbox = mkdtempSync(resolve(tmpdir(), 'pirun-surface-'));
const preset = `surface-${randomBytes(3).toString('hex')}`;
const testEnv = {
	...process.env,
	PIRUN_CONFIG_PATH: resolve(sandbox, 'config.json'),
	PIRUN_PROVIDERS_PATH: resolve(sandbox, 'providers.json'),
	HOME: sandbox,
	USERPROFILE: sandbox,
	DEEPSEEK_API_KEY: 'sk-offline-test',
	NO_COLOR: '1'
};

after(() => rmSync(sandbox, { recursive: true, force: true }));

function pirun(...args: string[]) {
	return spawnSync(process.execPath, [pirunEntry, ...args], {
		cwd: projectDir,
		env: testEnv,
		encoding: 'utf8',
		timeout: 30_000
	});
}

test('an unknown command fails with a pointer to help', () => {
	const result = pirun('badcmd', preset);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /unknown command "badcmd"\. Run "pirun help"\./);
});

test('a fresh preset without --use is refused with the exact fixing flag', () => {
	const result = pirun('config', `${preset}-nouse`);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /has no provider; pass --use <provider\[\/account\]> \(see: pirun providers\)/);
});

test('the removed bundled proxy gets a targeted migration error', () => {
	const result = pirun('config', `${preset}-legacy`, '--use', 'bundled');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /bundled proxy was removed/);
	assert.match(result.stderr, /pirun provider add <name> --base-url <url>/);
});

test('starting without --time is refused with the exact fixing flag', () => {
	const result = pirun('run', preset, '--use', 'deepseek', '--model', 'deepseek-chat', 'hi');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--time <return-after>\/<timeout> is required/);
	assert.match(result.stderr, /--time 10m\/2h/);
});

test('a preset command without a preset name says so', () => {
	const result = pirun('run');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /a preset name is required after "run"/);
});

test('config creates an endpoint preset and reports the wiring', () => {
	const result = pirun('config', preset, '--use', 'deepseek', '--model', 'deepseek-chat');
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`preset  ${preset}  \\(pi\\)`));
	assert.match(result.stdout, /use     deepseek\/main  \(openai-completions  https:\/\/api\.deepseek\.com\/v1\)/);
	assert.match(result.stdout, /model   deepseek-chat/);
	assert.match(result.stdout, /tools   on   context-files on/);
	assert.match(result.stdout, /output  digest  text/);
});

test('behavior flags persist into the preset and load on the next call', () => {
	const set = pirun('config', preset, '--no-tools');
	assert.equal(set.status, 0, set.stderr);
	assert.match(set.stdout, /tools   off/);
	const reread = pirun('config', preset);
	assert.match(reread.stdout, /tools   off/);
	const restore = pirun('config', preset, '--tools');
	assert.match(restore.stdout, /tools   on/);
});

test('config reads back everything the preset holds, prefix verbatim', () => {
	const name = `${preset}-all`;
	const prefix = 'Standing rule one.\nStanding rule two, kept verbatim well past sixty characters so truncation would show.';
	const set = pirun(
		'config', name,
		'--use', 'deepseek', '--model', 'deepseek-chat', '--effort', 'high',
		'--prefix', prefix, '--no-context-files', '--full'
	);
	assert.equal(set.status, 0, set.stderr);

	const read = pirun('config', name);
	assert.equal(read.status, 0, read.stderr);
	assert.match(read.stdout, new RegExp(`preset  ${name}  \\(pi\\)`));
	assert.match(read.stdout, /store   .*providers\.json/);
	assert.match(read.stdout, /use     deepseek\/main/);
	assert.match(read.stdout, /model   deepseek-chat   effort high/);
	assert.match(read.stdout, /tools   on   context-files off/);
	assert.match(read.stdout, /output  full  text/);
	assert.match(read.stdout, new RegExp(`prefix  \\(${prefix.length} chars\\)`));
	for (const line of prefix.split('\n')) {
		assert.ok(read.stdout.includes(`  ${line}`), `prefix line not shown verbatim: ${line}`);
	}

	const cleared = pirun('config', name, '--no-prefix');
	assert.match(cleared.stdout, /prefix  \(none\)/);
});

test('conflicting boolean flags are rejected', () => {
	const result = pirun('config', preset, '--tools', '--no-tools');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /--tools and --no-tools cannot be used together/);
});

test('jobs on a fresh preset reports no runs', () => {
	const result = pirun('jobs', `${preset}-empty`, '--use', 'deepseek', '--model', 'deepseek-chat');
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /no runs yet\./);
});

test('providers lists canonical endpoints with their standard env vars', () => {
	const result = pirun('providers', '--json');
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout) as {
		store: string;
		providers: Array<{ name: string; kind: string; envVar?: string; baseUrl?: string }>;
	};
	assert.equal(parsed.store, testEnv.PIRUN_PROVIDERS_PATH);
	const names = parsed.providers.map((row) => row.name);
	for (const canonical of ['openai', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai']) {
		assert.ok(names.includes(canonical), `missing canonical endpoint ${canonical}`);
	}
	const deepseek = parsed.providers.find((row) => row.name === 'deepseek');
	assert.equal(deepseek?.envVar, 'DEEPSEEK_API_KEY');
	assert.equal(deepseek?.baseUrl, 'https://api.deepseek.com/v1');
	assert.ok(names.includes('antigravity'), 'missing the antigravity harness row');
	assert.ok(!names.includes('bundled'), 'the bundled proxy row must be gone');
});

test('a custom endpoint provider can be added, keyed, and removed', () => {
	const added = pirun('provider', 'add', 'customx', '--base-url', 'https://api.example.com/v1');
	assert.equal(added.status, 0, added.stderr);
	assert.match(added.stdout, /provider "customx"  https:\/\/api\.example\.com\/v1/);
	assert.match(added.stdout, /compat  bearer-header on  developer-role on  reasoning-effort off/);

	const keyed = pirun('provider', 'key', 'customx', 'main', '--key', 'sk-test');
	assert.equal(keyed.status, 0, keyed.stderr);
	assert.match(keyed.stdout, /customx\/main  \(literal\)/);

	const removed = pirun('provider', 'rm', 'customx');
	assert.equal(removed.status, 0, removed.stderr);
	assert.match(removed.stdout, /removed provider "customx" and its accounts\./);
});

test('a custom provider without a base url is refused', () => {
	const result = pirun('provider', 'add', 'nourl');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /custom provider "nourl" needs --base-url <url>\./);
});

test('provider key without any source names both conventional env vars', () => {
	const result = pirun('provider', 'key', 'openai', 'spare');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /neither OPENAI_API_KEY_SPARE nor OPENAI_API_KEY is set/);
});

test('login demands a known harness and an account name', () => {
	const result = pirun('login', 'nosuch');
	assert.equal(result.status, 1);
	assert.match(result.stderr, /usage: pirun login antigravity <account>/);
});

test('removed proxy commands are unknown commands', () => {
	for (const command of ['up', 'down', 'restart', 'speedtest']) {
		const result = pirun(command, preset);
		assert.equal(result.status, 1, `${command} should be gone`);
		assert.match(result.stderr, new RegExp(`unknown command "${command}"`));
	}
});

test('help documents every command family and the timer contract', () => {
	const result = pirun('help');
	assert.equal(result.status, 0, result.stderr);
	for (const needle of [
		'pirun agent <preset> <name> --time <ra>/<to> <task…>',
		'pirun fork <preset> <parent> <child>',
		'pirun run <preset> --time <ra>/<to>',
		'pirun providers [--json]',
		'pirun login antigravity <account>',
		'pirun spend [provider[/account]]',
		'--time <return-after>/<timeout>',
		'Timers are required on every start and never persisted',
		'Exit status: 0 the run produced output, 1 it failed'
	]) {
		assert.ok(result.stdout.includes(needle), `help is missing: ${needle}`);
	}
	assert.ok(!result.stdout.includes('bundled'), 'help must not mention the bundled proxy');
	assert.ok(!result.stdout.includes('speedtest'), 'help must not mention speedtest');
});
