/**
 * Network-facing provider operations: live model lists and spend/balance for
 * endpoints Pirun has premeditated support for. Everything here is on-demand
 * only — nothing in the agent-start path calls out to these APIs.
 */

import { execSync } from 'node:child_process';
import {
	CANONICAL_ENDPOINTS,
	endpointBaseUrl,
	type ProvidersStore
} from './pirun-providers.ts';

/** `$VAR` reads the environment, `!cmd` runs a credential command, else literal. */
export function resolveAccountKey(key: string): string {
	if (key.startsWith('$')) {
		const value = process.env[key.slice(1)];
		if (!value) throw new Error(`environment variable ${key.slice(1)} is not set.`);
		return value.trim();
	}
	if (key.startsWith('!')) {
		return execSync(key.slice(1), { encoding: 'utf8', windowsHide: true }).trim();
	}
	return key;
}

async function apiGet(url: string, key: string): Promise<unknown> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw new Error(`${url} responded ${response.status}.`);
	return response.json();
}

/** Live `GET /models` id list for an endpoint provider. */
export async function fetchEndpointModels(store: ProvidersStore, provider: string, key: string): Promise<string[]> {
	const baseUrl = endpointBaseUrl(store, provider);
	if (!baseUrl) throw new Error(`provider "${provider}" has no base URL.`);
	const body = await apiGet(`${baseUrl.replace(/\/+$/, '')}/models`, key);
	const data = (body as { data?: Array<{ id?: unknown }> }).data;
	if (!Array.isArray(data)) throw new Error(`${provider} /models returned an unexpected shape.`);
	return data
		.map((row) => (typeof row.id === 'string' ? row.id : ''))
		.filter(Boolean)
		.sort();
}

export interface SpendReport {
	supported: boolean;
	lines: string[];
}

/** Balance/usage where the API exposes it; a plain answer where it does not. */
export async function fetchSpend(store: ProvidersStore, provider: string, key: string): Promise<SpendReport> {
	const kind = CANONICAL_ENDPOINTS[provider]?.spend;
	if (kind === 'deepseek-balance') {
		const body = (await apiGet('https://api.deepseek.com/user/balance', key)) as {
			is_available?: boolean;
			balance_infos?: Array<{ currency?: string; total_balance?: string; topped_up_balance?: string; granted_balance?: string }>;
		};
		const lines = (body.balance_infos ?? []).map(
			(info) =>
				`balance ${info.total_balance ?? '?'} ${info.currency ?? ''}` +
				`  (topped-up ${info.topped_up_balance ?? '?'}, granted ${info.granted_balance ?? '?'})`
		);
		if (body.is_available === false) lines.push('account unavailable for new requests');
		return { supported: true, lines: lines.length ? lines : ['no balance information returned'] };
	}
	if (kind === 'openrouter-credits') {
		const body = (await apiGet('https://openrouter.ai/api/v1/credits', key)) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		const credits = body.data?.total_credits ?? 0;
		const usage = body.data?.total_usage ?? 0;
		return {
			supported: true,
			lines: [`credits $${credits.toFixed(2)}  used $${usage.toFixed(2)}  remaining $${(credits - usage).toFixed(2)}`]
		};
	}
	return { supported: false, lines: ['spend: not exposed by this API'] };
}
