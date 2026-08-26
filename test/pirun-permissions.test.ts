import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, test } from 'node:test';

process.env.PIRUN_PROVIDERS_PATH = resolve(tmpdir(), 'pirun-permissions-test-providers.json');
const {
	antigravityPermissionArgs,
	assertPermissionCoverage,
	HARNESS_PERMISSIONS,
	piPermissionTools,
	resolvePermissionLevel
} = await import('../src/cli/permissions.ts');
const { PIRUN_HARNESSES } = await import('../src/pirun-config.ts');
const { buildDigest } = await import('../src/cli/digest.ts');
const { RUNS_DIR } = await import('../src/cli/context.ts');

test('ENFORCED: every harness declares permission levels and a default above ask', () => {
	assertPermissionCoverage();
	for (const name of PIRUN_HARNESSES) {
		const spec = HARNESS_PERMISSIONS[name];
		assert.ok(spec, `harness "${name}" has no permission declaration`);
		assert.equal(spec.default, 'edit', `harness "${name}" must default one above ask-for-everything`);
		assert.ok(spec.unsupported.ask?.trim(), `harness "${name}" must support ask or say why not`);
	}
	assert.throws(
		() => assertPermissionCoverage(['pi', 'newharness']),
		/harness "newharness" declares no permission levels[\s\S]*HARNESS_PERMISSIONS\["newharness"\]/
	);
});

test('stored intent resolves per harness; impossible levels name the alternatives', () => {
	assert.equal(resolvePermissionLevel('antigravity', undefined), 'edit');
	assert.equal(resolvePermissionLevel('pi', 'read'), 'read');
	assert.throws(() => resolvePermissionLevel('antigravity', 'ask'), /auto-denies[\s\S]*supported: read, edit, all/);
	assert.throws(() => resolvePermissionLevel('pi', 'ask'), /tool[\s\S]*allowlists[\s\S]*supported: read, edit, all/);
	assert.throws(() => resolvePermissionLevel('pi', 'sudo'), /--permissions must be read, ask, edit, all/);
});

test('levels map to each harness mechanism', () => {
	assert.deepEqual(piPermissionTools('read'), ['read', 'grep', 'find', 'ls']);
	assert.deepEqual(piPermissionTools('edit'), ['read', 'grep', 'find', 'ls', 'edit', 'write']);
	assert.equal(piPermissionTools('all'), null);
	assert.deepEqual(antigravityPermissionArgs('read'), ['--mode', 'plan']);
	assert.deepEqual(antigravityPermissionArgs('edit'), ['--mode', 'accept-edits']);
	assert.deepEqual(antigravityPermissionArgs('all'), ['--dangerously-skip-permissions']);
});

test('an agy permission denial surfaces in the digest as a permission ask', () => {
	// The exact event shape observed live from agy 1.1.21 headless print mode.
	const id = `perm${randomBytes(2).toString('hex')}`;
	const dir = resolve(RUNS_DIR, id);
	mkdirSync(dir, { recursive: true });
	after(() => rmSync(dir, { recursive: true, force: true }));
	const events = [
		{ event: 'init', conversation_id: 'c-1', init: {} },
		{
			event: 'step_update',
			step_update: {
				conversation_id: 'c-1', step_index: 2, state: 'ERROR', step_type: 'tool',
				tool_name: 'run_command',
				tool_info: {
					name: 'run_command',
					parameters: { CommandLine: 'Get-Location' },
					error: {
						type: 'TOOL_ERROR',
						message: 'permission check failed for command "Get-Location": user denied permission to run command:\nGet-Location'
					}
				}
			}
		},
		{ event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: '', num_turns: 1 } }
	];
	writeFileSync(resolve(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));

	const digest = buildDigest(id, {
		id, harness: 'antigravity', model: 'auto', cwd: dir, task: 'probe', tools: true,
		permissions: 'edit', startedAt: Date.now() - 1000, finishedAt: Date.now(),
		exitCode: 0, timeoutSec: 60, returnAfterSec: 10
	});
	assert.deepEqual(digest.permissionAsks, ['run_command(Get-Location)']);
	assert.equal(digest.tools.length, 1);
	assert.equal(digest.tools[0].failed, true);
});
