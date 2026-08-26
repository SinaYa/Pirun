import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const projectDir = resolve(import.meta.dirname, '..');
const pirunEntry = resolve(projectDir, 'bin', 'pirun.ts');
const fakePiEntry = resolve(import.meta.dirname, 'fixtures', 'fake-pi.mjs');
const runsDir = resolve(projectDir, '.runs');
const testPreset = `lifecycle-${randomBytes(4).toString('hex')}`;
const testEnv = {
	...process.env,
	PIRUN_PI_ENTRY: fakePiEntry,
	PIRUN_SKIP_PROXY: '1',
	PIRUN_CONFIG_PATH: resolve(runsDir, `${testPreset}.json`),
	PIRUN_PROVIDERS_PATH: resolve(runsDir, `${testPreset}-providers.json`),
	NO_COLOR: '1'
};

function pirun(args: string[], timeout = 15_000) {
	return spawnSync(process.execPath, [pirunEntry, args[0], testPreset, ...args.slice(1)], {
		cwd: projectDir,
		env: testEnv,
		encoding: 'utf8',
		timeout
	});
}

function runId(result: ReturnType<typeof pirun>) {
	const match = result.stderr.match(/run ([a-f0-9]{6}) started/);
	assert.ok(match, `missing run id in stderr: ${result.stderr}`);
	return match[1];
}

function cleanupRun(id: string) {
	const path = resolve(runsDir, id);
	if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

test('attached invocation hands off a live job with progress, then wait returns its result', () => {
	const started = pirun(['run', '--model', 'muse', '--time', '1/10', 'FAKE_SLOW']);
	const id = runId(started);
	try {
		assert.equal(started.status, 2, started.stdout + started.stderr);
		assert.match(started.stdout, /RUNNING\s+turns=1/);
		assert.match(started.stdout, /generated≈[1-9]/);
		assert.match(started.stdout, /last-10s=[1-9][0-9.]* tok\/s/);
		assert.match(started.stdout, new RegExp(`check: pirun wait ${testPreset} ${id}`));

		const polled = pirun(['poll', id]);
		assert.equal(polled.status, 2, polled.stdout + polled.stderr);
		assert.match(polled.stdout, /Pi continues in the background/);

		const waited = pirun(['wait', id, '--time', '5', '--full']);
		assert.equal(waited.status, 0, waited.stdout + waited.stderr);
		assert.match(waited.stdout, /\] OK\s+turns=1/);
		assert.match(waited.stdout, /FAKE_READY/);
	} finally {
		cleanupRun(id);
	}
});

test('completion before the caller timer returns the normal digest', () => {
	const completed = pirun(['run', '--model', 'muse', '--time', '5/10', 'FAKE_FAST']);
	const id = runId(completed);
	try {
		assert.equal(completed.status, 0, completed.stdout + completed.stderr);
		assert.match(completed.stdout, /\] OK\s+turns=1/);
		assert.doesNotMatch(completed.stdout, /Pi continues in the background/);
	} finally {
		cleanupRun(id);
	}
});

test('a tool failure is reconciled after its later turn result arrives', () => {
	const completed = pirun(['run', '--model', 'muse', '--time', '5/30', 'FAKE_TOOL_FAILURE']);
	const id = runId(completed);
	try {
		assert.equal(completed.status, 0, completed.stdout + completed.stderr);
		assert.match(completed.stdout, /tools: !fakeTool\(fixture\.txt\)/);
	} finally {
		cleanupRun(id);
	}
});

test('the hard timeout remains independent of the caller timer', () => {
	// A caller wait beyond the hard stop deliberately stays attached until the
	// timeout itself is the observed result.
	const timedOut = pirun(['run', '--model', 'muse', '--time', '5/1', 'FAKE_HANG']);
	const id = runId(timedOut);
	try {
		assert.equal(timedOut.status, 1, timedOut.stdout + timedOut.stderr);
		assert.match(timedOut.stdout, /\] TIMEOUT\s+turns=1/);
		const meta = JSON.parse(readFileSync(resolve(runsDir, id, 'meta.json'), 'utf8'));
		assert.equal(meta.timeoutSec, 1);
		assert.equal(meta.returnAfterSec, 5);
		assert.equal(meta.timedOut, true);
	} finally {
		cleanupRun(id);
	}
});

test('a named agent remains locked during handoff and absorbs the detached result', () => {
	const name = `lifecycle-${randomBytes(4).toString('hex')}`;
	const started = pirun(['agent', name, '--model', 'muse', '--time', '1/10', 'FAKE_SLOW']);
	const id = runId(started);
	const agentDir = resolve(runsDir, 'agents', name);
	try {
		assert.equal(started.status, 2, started.stdout + started.stderr);
		assert.equal(existsSync(resolve(agentDir, 'lock')), true);

		const waited = pirun(['wait', id, '--time', '5']);
		assert.equal(waited.status, 0, waited.stdout + waited.stderr);
		const agent = JSON.parse(readFileSync(resolve(agentDir, 'agent.json'), 'utf8'));
		assert.equal(agent.exchanges, 1);
		assert.deepEqual(agent.runs, [id]);
		assert.equal(agent.totals.output, 64);
		assert.equal(existsSync(resolve(agentDir, 'lock')), false);
	} finally {
		cleanupRun(id);
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	}
});
