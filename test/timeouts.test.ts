import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RETURN_AFTER_SECONDS } from '../src/timeouts.ts';

test('the default re-attach window is ten minutes', () => {
	assert.equal(DEFAULT_RETURN_AFTER_SECONDS, 600);
});
