/** Bundled-proxy lifecycle and log correlation. */

import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { PROJECT_DIR } from '../paths.ts';
import {
	BASE_URL,
	die,
	ensureRunsDir,
	isAlive,
	MAX_PROXY_LOG_BYTES,
	PROXY_LOG,
	PROXY_PID,
	SERVER_ENTRY,
	settings,
	truncate
} from './context.ts';

export async function proxyIsUp(timeoutMs = 1500) {
	try {
		const response = await fetch(`${BASE_URL}/health`, {
			signal: AbortSignal.timeout(timeoutMs)
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForProxy(timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await proxyIsUp(1000)) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

export async function startProxy() {
	if (await proxyIsUp()) return { started: false };
	ensureRunsDir();
	if (existsSync(PROXY_LOG) && statSync(PROXY_LOG).size >= MAX_PROXY_LOG_BYTES) {
		rmSync(`${PROXY_LOG}.1`, { force: true });
		renameSync(PROXY_LOG, `${PROXY_LOG}.1`);
	}
	const log = openSync(PROXY_LOG, 'a');
	const child = spawn(process.execPath, ['--no-warnings', SERVER_ENTRY], {
		cwd: PROJECT_DIR,
		detached: true,
		stdio: ['ignore', log, log],
		windowsHide: true
	});
	child.unref();
	if (child.pid) writeFileSync(PROXY_PID, String(child.pid));
	if (!(await waitForProxy(20_000))) {
		die(`the backing service did not start. See ${PROXY_LOG}`);
	}
	return { started: true };
}

export async function stopProxy() {
	if (!(await proxyIsUp())) return 'not running';

	// Ask it to stop, so a proxy started by hand or by start.bat also obeys.
	try {
		const headers: Record<string, string> = {};
		if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
		await fetch(`${BASE_URL}/shutdown`, {
			method: 'POST',
			headers,
			signal: AbortSignal.timeout(3000)
		});
	} catch {
		/* the socket dying under us is the expected outcome */
	}
	if (!(await proxyIsUp(2000))) return 'stopped';

	// Fall back to the pid we recorded, if this proxy was ours.
	if (existsSync(PROXY_PID)) {
		const pid = Number.parseInt(readFileSync(PROXY_PID, 'utf8').trim(), 10);
		if (Number.isFinite(pid) && isAlive(pid)) {
			try {
				process.kill(pid);
				return 'stopped';
			} catch {
				/* fall through */
			}
		}
	}
	return 'still up';
}

/**
 * Proxy log lines inside a run's time window. This is how a silent Pi run gets
 * an explanation: Pi reports an empty assistant turn, the proxy knows it was a
 * 503 from the provider mid-stream.
 */
export function proxyErrorsBetween(startedAt: number, finishedAt: number) {
	if (!existsSync(PROXY_LOG)) return [];
	const lines = readFileSync(PROXY_LOG, 'utf8').split(/\r?\n/);
	const found: string[] = [];
	for (const line of lines) {
		const match = /^\[([^\]]+)\]\s+error\s+(.*)$/.exec(line);
		if (!match) continue;
		const at = Date.parse(match[1]);
		if (!Number.isFinite(at)) continue;
		if (at >= startedAt - 2000 && at <= finishedAt + 2000) found.push(truncate(match[2], 200));
	}
	return found.slice(-4);
}
