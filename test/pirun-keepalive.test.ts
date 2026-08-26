import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, test } from 'node:test';

// Offline: due-ness is computed from file mtimes in a sandboxed state dir.
const sandbox = mkdtempSync(resolve(tmpdir(), 'pirun-keepalive-'));
process.env.PIRUN_PROVIDERS_PATH = resolve(sandbox, 'providers.json');
process.env.PIRUN_STATE_DIR = sandbox;
delete process.env.PIRUN_AUTH_KEEPALIVE_DAYS;

function profileFor(account: string, ageDays: { marker: number; token: number | null }) {
	const dir = resolve(sandbox, 'profiles-test', account);
	mkdirSync(resolve(dir, 'antigravity-cli'), { recursive: true });
	const stamp = (file: string, days: number) => {
		const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		writeFileSync(file, '{}');
		utimesSync(file, at, at);
	};
	stamp(resolve(dir, 'pirun-auth.json'), ageDays.marker);
	if (ageDays.token !== null) {
		stamp(resolve(dir, 'antigravity-cli', 'antigravity-oauth-token'), ageDays.token);
	}
	return dir;
}

writeFileSync(
	process.env.PIRUN_PROVIDERS_PATH,
	JSON.stringify({
		version: 1,
		endpoints: {},
		harnesses: {
			antigravity: {
				accounts: {
					stale: { profileDir: profileFor('stale', { marker: 30, token: 10 }) },
					fresh: { profileDir: profileFor('fresh', { marker: 30, token: 0 }) },
					tokenless: { profileDir: profileFor('tokenless', { marker: 10, token: null }) },
					unauthenticated: { profileDir: resolve(sandbox, 'profiles-test', 'missing') }
				}
			}
		}
	})
);

const { assertKeepaliveCoverage, keepaliveDueAccounts, HARNESS_KEEPALIVE } = await import('../src/cli/keepalive.ts');
const { HARNESS_PROVIDERS } = await import('../src/pirun-providers.ts');
const { atomicWriteJson } = await import('../src/pirun-files.ts');

after(() => rmSync(sandbox, { recursive: true, force: true }));

const dueAccounts = () => keepaliveDueAccounts().map((entry) => entry.account).sort();

test('ENFORCED: every harness declares a keep-alive policy or that it is impossible', () => {
	assertKeepaliveCoverage();
	for (const name of HARNESS_PROVIDERS) {
		const policy = HARNESS_KEEPALIVE[name];
		assert.ok(policy, `harness "${name}" has no keep-alive policy`);
		if (policy.kind === 'impossible') {
			assert.ok(policy.reason.trim(), `harness "${name}" declared impossible without a reason`);
		}
	}
	// A harness added without deciding fails with the exact fixing pointer.
	assert.throws(
		() => assertKeepaliveCoverage(['antigravity', 'newharness']),
		/harness "newharness" has accounts but no auth keep-alive policy[\s\S]*HARNESS_KEEPALIVE\["newharness"\]/
	);
});

test('due-ness follows the token bundle mtime; fresh and unauthenticated are skipped', () => {
	// stale: token 10 days old — due. fresh: token rewritten today — not due.
	// tokenless: falls back to the 10-day-old marker — due.
	// unauthenticated: no profile/marker — never touched.
	assert.deepEqual(dueAccounts(), ['stale', 'tokenless']);
	assert.ok(keepaliveDueAccounts().every((entry) => entry.harness === 'antigravity'));
});

test('a recent attempt suppresses retries during the cool-down', () => {
	atomicWriteJson(resolve(sandbox, 'auth-keepalive.json'), {
		'antigravity/stale': { attemptedAt: Date.now() - 60_000 }
	});
	assert.deepEqual(dueAccounts(), ['tokenless']);
	// An attempt older than the cool-down no longer suppresses.
	atomicWriteJson(resolve(sandbox, 'auth-keepalive.json'), {
		'antigravity/stale': { attemptedAt: Date.now() - 7 * 60 * 60 * 1000 }
	});
	assert.deepEqual(dueAccounts(), ['stale', 'tokenless']);
});

test('PIRUN_AUTH_KEEPALIVE_DAYS widens the window and 0 disables', () => {
	rmSync(resolve(sandbox, 'auth-keepalive.json'), { force: true });
	process.env.PIRUN_AUTH_KEEPALIVE_DAYS = '30';
	try {
		assert.deepEqual(keepaliveDueAccounts(), []);
		process.env.PIRUN_AUTH_KEEPALIVE_DAYS = '0';
		assert.deepEqual(keepaliveDueAccounts(), []);
		process.env.PIRUN_AUTH_KEEPALIVE_DAYS = '5';
		assert.deepEqual(dueAccounts(), ['stale', 'tokenless']);
	} finally {
		delete process.env.PIRUN_AUTH_KEEPALIVE_DAYS;
	}
});
