/** `pirun spend` — one consumption-status interface for every account kind. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PirunArgs as Args } from '../pirun-args.ts';
import { HARNESS_PROVIDERS } from '../pirun-providers.ts';
import {
	antigravityBaseArgs,
	antigravityEnv,
	antigravityIsolationMode,
	findAntigravityEntry,
	hasAntigravityAuthMarker,
	parseAntigravityUsage,
	type AntigravityLimit
} from '../pirun-antigravity.ts';
import { fetchSpend, resolveAccountKey } from '../pirun-provider-net.ts';
import { die, humanSpan, out, state } from './context.ts';
import { antigravityAccountProfileDir } from './auth.ts';

interface SpendRow {
	provider: string;
	account: string;
	kind: 'endpoint' | 'harness';
	supported: boolean;
	lines: string[];
	limits?: AntigravityLimit[];
}

const execFileAsync = promisify(execFile);

async function fetchAntigravityAccountUsage(account: string): Promise<SpendRow> {
	const row: SpendRow = { provider: 'antigravity', account, kind: 'harness', supported: true, lines: [] };
	const profileDir = antigravityAccountProfileDir(account);
	if (!hasAntigravityAuthMarker(profileDir)) {
		row.lines.push(`not logged in — run: pirun login antigravity ${account}`);
		return row;
	}
	try {
		// The harness reports its own rate limits: agy answers /usage
		// non-interactively in print mode, so this is ordinary CLI usage.
		const { stdout: text } = await execFileAsync(
			findAntigravityEntry(),
			[...antigravityBaseArgs(profileDir), '-p', '/usage'],
			{
				encoding: 'utf8',
				windowsHide: true,
				env: antigravityEnv(antigravityIsolationMode(profileDir)),
				timeout: 90_000
			}
		);
		const limits = parseAntigravityUsage(text);
		if (!limits.length) {
			row.lines.push(...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8));
			if (!row.lines.length) row.lines.push('the harness returned no usage information');
			return row;
		}
		row.limits = limits;
		for (const limit of limits) {
			const untilReset = Date.parse(limit.resetsAt) - Date.now();
			row.lines.push(
				`${limit.models.padEnd(22)} ${limit.window.padEnd(10)} ${String(limit.remainingPercent).padStart(3)}% remaining` +
					`  resets ${limit.resetsAt}${untilReset > 0 ? ` (in ${humanSpan(untilReset)})` : ''}`
			);
		}
	} catch (error) {
		row.supported = false;
		row.lines.push(`error: ${error instanceof Error ? error.message : String(error)}`);
	}
	return row;
}

/**
 * One interface for every consumption source: endpoint accounts answer with
 * credits/balance, harness accounts answer with their rate-limit windows and
 * reset times.
 */
async function endpointSpendRow(name: string, account: string, key: string): Promise<SpendRow> {
	const store = state.providersStore;
	try {
		const spend = await fetchSpend(store, name, resolveAccountKey(key));
		return { provider: name, account, kind: 'endpoint', supported: spend.supported, lines: spend.lines };
	} catch (error) {
		return {
			provider: name,
			account,
			kind: 'endpoint',
			supported: false,
			lines: [`error: ${error instanceof Error ? error.message : String(error)}`]
		};
	}
}

export async function commandSpend(args: Args) {
	const store = state.providersStore;
	const only = (args.positional[0] ?? '').trim().toLowerCase();
	const [onlyProvider = '', onlyAccount = ''] = only.split('/');
	// Every account is queried concurrently; the report keeps a stable order.
	const tasks: Array<Promise<SpendRow>> = [];

	for (const name of Object.keys(store.endpoints).sort()) {
		if (onlyProvider && onlyProvider !== name) continue;
		const accounts = store.endpoints[name]?.accounts ?? {};
		for (const [account, value] of Object.entries(accounts)) {
			if (onlyAccount && onlyAccount !== account) continue;
			tasks.push(endpointSpendRow(name, account, value.key));
		}
	}
	for (const name of HARNESS_PROVIDERS) {
		if (onlyProvider && onlyProvider !== name) continue;
		for (const account of Object.keys(store.harnesses[name]?.accounts ?? {})) {
			if (onlyAccount && onlyAccount !== account) continue;
			tasks.push(fetchAntigravityAccountUsage(account));
		}
	}
	const report = await Promise.all(tasks);

	if (!report.length) {
		if (only) die(`no accounts match "${only}". See: pirun providers`);
		out('no accounts configured. See: pirun providers');
		return;
	}
	if (args.flags.has('json')) {
		out(JSON.stringify(report, null, 2));
		return;
	}
	for (const row of report) {
		out(`${row.provider}/${row.account}`);
		for (const line of row.lines) out(`  ${line}`);
	}
}
