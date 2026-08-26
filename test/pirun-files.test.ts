import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
	acquireOwnedLock,
	readOwnedLock,
	releaseOwnedLock,
	updateOwnedLock
} from '../src/pirun-files.ts';

test('agent locks are exclusive, transferable, and ownership-aware', () => {
	const dir = mkdtempSync(resolve(tmpdir(), 'pirun-lock-'));
	const path = resolve(dir, 'agent.lock');
	try {
		const token = acquireOwnedLock(path, (pid) => pid === process.pid);
		assert.throws(() => acquireOwnedLock(path, () => true), /busy/);
		updateOwnedLock(path, token, 4242, 'run-id');
		assert.deepEqual(readOwnedLock(path), {
			pid: 4242,
			token,
			createdAt: readOwnedLock(path)?.createdAt,
			runId: 'run-id'
		});
		assert.equal(releaseOwnedLock(path, 'wrong-owner'), false);
		assert.equal(releaseOwnedLock(path, token), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
