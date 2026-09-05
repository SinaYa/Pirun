import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Set before importing: the run directory is resolved at module load.
process.env.PIRUN_RUNS_DIR = resolve(tmpdir(), 'pirun-agy-digest-test-runs');
const { buildDigest } = await import('../src/cli/digest.ts');
const { RUNS_DIR } = await import('../src/cli/context.ts');

interface Meta {
	id: string;
	exitCode: number;
}

function digestOf(events: unknown[], meta: Meta) {
	const dir = resolve(RUNS_DIR, meta.id);
	mkdirSync(dir, { recursive: true });
	after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(resolve(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join(NEWLINE));
	return buildDigest(meta.id, {
		id: meta.id, harness: 'antigravity', model: 'auto', cwd: dir, task: 'probe', tools: true,
		permissions: 'edit', startedAt: Date.now() - 1000, finishedAt: Date.now(),
		exitCode: meta.exitCode, timeoutSec: 60, returnAfterSec: 10
	});
}

const NEWLINE = String.fromCharCode(10);

test('a licence refusal reaches the digest as one actionable note', () => {
	const id = `lic${randomBytes(2).toString('hex')}`;
	const digest = digestOf(
		[
			{ event: 'init', conversation_id: 'c-1', init: {} },
			{
				event: 'result',
				result: {
					conversation_id: 'c-1', status: 'ERROR', response: '', num_turns: 1,
					error: 'HTTP 403 Forbidden: You do not have a valid license of this product. (#3501)'
				}
			}
		],
		{ id, exitCode: 1 }
	);
	assert.equal(digest.status, 'failed');
	assert.equal(digest.notes.length, 1);
	assert.match(digest.notes[0], /license/);
	// The raw provider text still reaches the caller alongside the diagnosis.
	assert.match(digest.errors.join(' '), /#3501/);
});

test('a location refusal is named as location, not as an account problem', () => {
	const id = `loc${randomBytes(2).toString('hex')}`;
	const digest = digestOf(
		[
			{ event: 'init', conversation_id: 'c-2', init: {} },
			{
				event: 'result',
				result: {
					conversation_id: 'c-2', status: 'ERROR', response: '', num_turns: 1,
					error: 'HTTP 400: User location is not supported for the API use.'
				}
			}
		],
		{ id, exitCode: 1 }
	);
	assert.equal(digest.status, 'failed');
	assert.match(digest.notes.join(' '), /location/);
	assert.doesNotMatch(digest.notes.join(' '), /license/);
});

test('an ordinary successful run gains no diagnosis note', () => {
	const id = `ok${randomBytes(2).toString('hex')}`;
	const digest = digestOf(
		[
			{ event: 'init', conversation_id: 'c-3', init: {} },
			{
				event: 'result',
				result: { conversation_id: 'c-3', status: 'SUCCESS', response: 'done', num_turns: 1 }
			}
		],
		{ id, exitCode: 0 }
	);
	assert.equal(digest.status, 'ok');
	assert.deepEqual(digest.notes, []);
});

test('an unrecognized failure is left alone rather than guessed at', () => {
	const id = `unk${randomBytes(2).toString('hex')}`;
	const digest = digestOf(
		[
			{ event: 'init', conversation_id: 'c-4', init: {} },
			{
				event: 'result',
				result: {
					conversation_id: 'c-4', status: 'ERROR', response: '', num_turns: 1,
					error: 'the model stopped responding'
				}
			}
		],
		{ id, exitCode: 1 }
	);
	assert.equal(digest.status, 'failed');
	assert.deepEqual(digest.notes, []);
});
