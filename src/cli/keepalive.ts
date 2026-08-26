/**
 * Authentication keep-alive for harness accounts.
 *
 * What decays with disuse is the provider-side session/refresh token, and a
 * harness exercises it only when it makes an authenticated call. The
 * keep-alive therefore performs exactly what a user would: one ordinary,
 * cheap authenticated CLI call per idle account — no provider APIs called
 * directly, no credential contents touched.
 *
 * Trigger model: every pirun invocation does a cheap due-check over all
 * accounts (file mtimes only); when something is due, one detached
 * `pirun _keepalive` process is spawned so the caller's task never waits.
 * An account is due when its auth has not been exercised for
 * PIRUN_AUTH_KEEPALIVE_DAYS (default 3; 0 disables). Failed attempts respect
 * a cool-down so an offline machine is not hammered on every invocation.
 *
 * ENFORCED: every harness in HARNESS_PROVIDERS must declare its policy in
 * HARNESS_KEEPALIVE below — either how its auth is exercised, or explicitly
 * that keeping it alive is impossible and why. A harness without a policy
 * fails at import time and in the test suite.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
	antigravityAuthMarkerTime,
	antigravityBaseArgs,
	antigravityEnv,
	antigravityIsolationMode,
	antigravityTokenTime,
	findAntigravityEntry,
	hasAntigravityAuthMarker,
	markAntigravityAuthenticated
} from '../pirun-antigravity.ts';
import { HARNESS_PROVIDERS, providersStorePath } from '../pirun-providers.ts';
import { acquireOwnedLock, atomicWriteJson, releaseOwnedLock } from '../pirun-files.ts';
import { isAlive, PIRUN_ENTRY, state } from './context.ts';
import { antigravityAccountProfileDir } from './auth.ts';

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type HarnessKeepalive =
	| {
			kind: 'exercise';
			/** True when the account is signed in and worth keeping alive. */
			eligible(account: string): boolean;
			/** ms timestamp of the account's last auth exercise; 0 = never seen. */
			freshness(account: string): number;
			/** One ordinary authenticated call, recording success durably. */
			exercise(account: string): Promise<void>;
	  }
	| {
			kind: 'impossible';
			/** Why this harness's auth cannot be exercised without a human. */
			reason: string;
	  };

export const HARNESS_KEEPALIVE: Record<string, HarnessKeepalive> = {
	antigravity: {
		kind: 'exercise',
		eligible: (account) => hasAntigravityAuthMarker(antigravityAccountProfileDir(account)),
		freshness: (account) => {
			const profileDir = antigravityAccountProfileDir(account);
			// agy rewrites its token bundle on silent refresh; the pirun marker
			// is re-stamped after every exercise. Whichever is newer counts.
			return Math.max(antigravityTokenTime(profileDir), antigravityAuthMarkerTime(profileDir));
		},
		exercise: async (account) => {
			const profileDir = antigravityAccountProfileDir(account);
			const isolationMode = antigravityIsolationMode(profileDir);
			// agy answers /usage non-interactively in print mode: an ordinary
			// authenticated call that makes agy refresh an expired access token.
			await execFileAsync(findAntigravityEntry(), [...antigravityBaseArgs(profileDir), '-p', '/usage'], {
				encoding: 'utf8',
				windowsHide: true,
				env: antigravityEnv(isolationMode),
				timeout: 120_000
			});
			markAntigravityAuthenticated(profileDir, isolationMode);
		}
	}
};

/** Every harness must decide its keep-alive story before it can ship. */
export function assertKeepaliveCoverage(harnesses: readonly string[] = HARNESS_PROVIDERS) {
	for (const name of harnesses) {
		if (!HARNESS_KEEPALIVE[name]) {
			throw new Error(
				`harness "${name}" has accounts but no auth keep-alive policy. Add HARNESS_KEEPALIVE["${name}"] ` +
					`in src/cli/keepalive.ts: kind "exercise" (a periodic ordinary authenticated call) or kind ` +
					`"impossible" with the reason it cannot be kept alive without a human.`
			);
		}
	}
}
assertKeepaliveCoverage();

function keepaliveDays() {
	const raw = process.env.PIRUN_AUTH_KEEPALIVE_DAYS;
	if (raw === undefined) return 3;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function attemptsPath() {
	return resolve(dirname(providersStorePath()), 'auth-keepalive.json');
}

type Attempts = Record<string, { attemptedAt: number }>;

function readAttempts(): Attempts {
	try {
		if (!existsSync(attemptsPath())) return {};
		return JSON.parse(readFileSync(attemptsPath(), 'utf8')) as Attempts;
	} catch {
		return {};
	}
}

export interface DueAccount {
	harness: string;
	account: string;
}

/** Accounts whose auth has not been exercised within the window. mtimes only. */
export function keepaliveDueAccounts(now = Date.now()): DueAccount[] {
	const days = keepaliveDays();
	if (days <= 0) return [];
	const attempts = readAttempts();
	const due: DueAccount[] = [];
	for (const harness of HARNESS_PROVIDERS) {
		const policy = HARNESS_KEEPALIVE[harness];
		if (policy.kind !== 'exercise') continue;
		for (const account of Object.keys(state.providersStore.harnesses[harness]?.accounts ?? {})) {
			if (!policy.eligible(account)) continue;
			if (now - policy.freshness(account) < days * DAY_MS) continue;
			if (now - (attempts[`${harness}/${account}`]?.attemptedAt ?? 0) < ATTEMPT_COOLDOWN_MS) continue;
			due.push({ harness, account });
		}
	}
	return due;
}

/** Fire-and-forget: spawn the detached keep-alive worker when anything is due. */
export function maybeSpawnKeepalive() {
	try {
		if (!keepaliveDueAccounts().length) return;
		const worker = spawn(process.execPath, [PIRUN_ENTRY, '_keepalive'], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		worker.unref();
	} catch {
		// Keep-alive is opportunistic; the caller's own command must never suffer.
	}
}

/** The detached worker: one exercise per due account, single instance at a time. */
export async function commandKeepalive() {
	const lockPath = `${attemptsPath()}.lock`;
	let token: string;
	try {
		token = acquireOwnedLock(lockPath, isAlive);
	} catch {
		return; // Another keep-alive is already running.
	}
	try {
		const due = keepaliveDueAccounts();
		if (!due.length) return;
		const attempts = readAttempts();
		const now = Date.now();
		for (const entry of due) attempts[`${entry.harness}/${entry.account}`] = { attemptedAt: now };
		atomicWriteJson(attemptsPath(), attempts);

		await Promise.all(due.map(async (entry) => {
			const policy = HARNESS_KEEPALIVE[entry.harness];
			if (policy.kind !== 'exercise') return;
			try {
				await policy.exercise(entry.account);
			} catch {
				// Still due next time; the attempt cool-down paces retries.
			}
		}));
	} finally {
		releaseOwnedLock(lockPath, token);
	}
}
