import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePirunArgs } from '../src/pirun-args.ts';

test('pirun preserves the documented agent invocation shape', () => {
	const args = parsePirunArgs([
		'agent',
		'work',
		'auth',
		'--model',
		'ox-alpha',
		'--dir',
		'C:\\repo',
		'--file',
		'C:\\task.md',
		'--time',
		'10m/2h'
	]);
	assert.deepEqual(args.positional, ['work', 'auth']);
	assert.equal(args.flags.get('model'), 'ox-alpha');
	assert.equal(args.flags.get('file'), 'C:\\task.md');
	assert.equal(args.flags.get('time'), '10m/2h');
});

test('pirun rejects typos and missing option values', () => {
	assert.throws(() => parsePirunArgs(['run', '--no-tool', 'task']), /unknown option/);
	assert.throws(() => parsePirunArgs(['run', '--model', '--no-tools', 'task']), /requires a value/);
});

test('v1 options are rejected with a pointer to their replacement', () => {
	assert.throws(() => parsePirunArgs(['run', '--timeout', '60', 'task']), /--time <return-after>\/<timeout>/);
	assert.throws(() => parsePirunArgs(['run', '--api-base-url', 'https://x/v1', 'task']), /provider add/);
	assert.throws(() => parsePirunArgs(['agent', 'w', '--bundled-proxy', 'task']), /bundled proxy was removed.*provider add/);
});

test('double dash allows a task beginning with an option-like token', () => {
	const args = parsePirunArgs(['run', '--', '--describe-this']);
	assert.deepEqual(args.positional, ['--describe-this']);
});
