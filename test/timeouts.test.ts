import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSettings } from '../src/settings.ts';
import {
	DEFAULT_AGENT_TIMEOUT_SECONDS,
	DEFAULT_RETURN_AFTER_SECONDS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	parseAgentTimeoutSeconds,
	parseReturnAfterSeconds
} from '../src/timeouts.ts';

test('agent and proxy defaults share the two-hour ceiling', () => {
	assert.equal(DEFAULT_AGENT_TIMEOUT_SECONDS, 7200);
	assert.equal(DEFAULT_RETURN_AFTER_SECONDS, 600);
	assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 7_200_000);
	assert.equal(loadSettings('Z:\\definitely-missing-proxy.cfg').requestTimeoutMs, 7_200_000);
});

test('a caller can override how long the foreground command waits', () => {
	assert.equal(parseReturnAfterSeconds(), 600);
	assert.equal(parseReturnAfterSeconds('0'), 0);
	assert.equal(parseReturnAfterSeconds('1200'), 1200);
	assert.throws(() => parseReturnAfterSeconds('-1'), /non-negative whole number/);
	assert.throws(() => parseReturnAfterSeconds('1.5'), /non-negative whole number/);
});

test('a caller can override the agent timeout per request', () => {
	assert.equal(parseAgentTimeoutSeconds(), 7200);
	assert.equal(parseAgentTimeoutSeconds('14400'), 14400);
	assert.throws(() => parseAgentTimeoutSeconds('0'), /positive whole number/);
	assert.throws(() => parseAgentTimeoutSeconds('12.5'), /positive whole number/);
});
