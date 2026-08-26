import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDurationSeconds, parseTimeAdjust, parseTimeSpec, parseWaitTime } from '../src/pirun-time.ts';

test('the two-part --time syntax parses units and bare seconds', () => {
	assert.deepEqual(parseTimeSpec('10m/2h'), { returnAfterSec: 600, timeoutSec: 7200 });
	assert.deepEqual(parseTimeSpec('1/10'), { returnAfterSec: 1, timeoutSec: 10 });
	assert.deepEqual(parseTimeSpec('90s/1.5h'), { returnAfterSec: 90, timeoutSec: 5400 });
});

test('timers are required and both parts must be positive', () => {
	assert.throws(() => parseTimeSpec(undefined), /--time .* required/);
	assert.throws(() => parseTimeSpec('10m'), /two parts/);
	assert.throws(() => parseTimeSpec('0/2h'), /background the pirun command itself/);
	assert.throws(() => parseTimeSpec('10m/0'), /positive duration/);
	assert.throws(() => parseTimeSpec('10x/2h'), /duration like/);
});

test('a caller wait longer than the hard stop is allowed', () => {
	assert.deepEqual(parseTimeSpec('5/1'), { returnAfterSec: 5, timeoutSec: 1 });
});

test('adjustments distinguish extend from set-from-now', () => {
	assert.deepEqual(parseTimeAdjust('+30m'), { mode: 'add', seconds: 1800 });
	assert.deepEqual(parseTimeAdjust('45m'), { mode: 'set', seconds: 2700 });
	assert.throws(() => parseTimeAdjust('+nope'), /duration like/);
});

test('wait accepts a single duration and falls back when omitted', () => {
	assert.equal(parseWaitTime('5m', 600), 300);
	assert.equal(parseWaitTime('', 600), 600);
	assert.equal(parseWaitTime('2m/1h', 600), 120);
	assert.equal(parseDurationSeconds('2h', '--x'), 7200);
});
