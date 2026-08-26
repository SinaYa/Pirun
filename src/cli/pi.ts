/** Pi CLI discovery and the bundled-proxy model catalogue. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getModelDefaults } from '../inference-provider-config.ts';
import { die, state } from './context.ts';

/** Flags that keep Pi from scanning disk and injecting things nobody asked for. */
export const LEAN_FLAGS = [
	'--no-extensions',
	'--no-skills',
	'--no-prompt-templates',
	'--no-themes',
	'--offline'
];

export const PI_CANDIDATES = [
	process.env.PIRUN_PI_ENTRY,
	process.env.APPDATA && resolve(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
	'/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
	process.env.HOME && resolve(process.env.HOME, '.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
].filter((entry): entry is string => Boolean(entry));

let cachedPiEntry: string | null = null;

export function findPiEntry() {
	if (cachedPiEntry) return cachedPiEntry;
	for (const candidate of PI_CANDIDATES) {
		if (existsSync(candidate)) {
			cachedPiEntry = candidate;
			return candidate;
		}
	}
	try {
		const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim();
		const candidate = resolve(root, '@earendil-works/pi-coding-agent/dist/cli.js');
		if (existsSync(candidate)) {
			cachedPiEntry = candidate;
			return candidate;
		}
	} catch {
		/* fall through to the error below */
	}
	die(
		'could not find the Pi CLI. Install it with "npm install -g @earendil-works/pi-coding-agent", ' +
			'or set PIRUN_PI_ENTRY to its dist/cli.js path.'
	);
}

export function piModelsFile() {
	const home = process.env.USERPROFILE || process.env.HOME || '';
	return home ? resolve(home, '.pi/agent/models.json') : '';
}

export interface PiModelRow {
	id: string;
	name: string;
	provider: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

export function knownPiModels(): PiModelRow[] {
	const path = piModelsFile();
	if (!path || !existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
			providers?: Record<
				string,
				{
					models?: Array<{
						id: string;
						name?: string;
						contextWindow?: number;
						maxTokens?: number;
						reasoning?: boolean;
					}>;
				}
			>;
		};
		const rows: PiModelRow[] = [];
		for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
			for (const model of config.models ?? []) {
				rows.push({
					id: `${provider}/${model.id}`,
					name: model.name ?? model.id,
					provider,
					contextWindow: model.contextWindow ?? 0,
					maxTokens: model.maxTokens ?? 0,
					reasoning: Boolean(model.reasoning)
				});
			}
		}
		return rows;
	} catch {
		return [];
	}
}

/**
 * `cladgpt-proxy/commandcode.ox-alpha` splits into a provider part, a
 * provider-qualified part (`commandcode.ox-alpha`) and a bare name
 * (`ox-alpha`). Matching only ever looks at the last two — the Pi provider name
 * and the human labels both contain "proxy", so matching the whole string makes
 * half the alphabet ambiguous.
 */
export function modelParts(id: string) {
	const qualified = id.slice(id.indexOf('/') + 1);
	const dot = qualified.indexOf('.');
	return { qualified, bare: dot === -1 ? qualified : qualified.slice(dot + 1) };
}

export interface CatalogueRow {
	id: string;
	name: string;
	canonical: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	defaults: Record<string, unknown> | null;
}

/**
 * What Pi can address, enriched with the tuned per-model defaults this project
 * applies on the way out. The defaults are not something Pi knows about — they
 * are filled in downstream — so this is the only place both halves meet.
 */
export function catalogue(): CatalogueRow[] {
	return knownPiModels().map((model) => {
		const canonical = modelParts(model.id).bare;
		return {
			id: model.id,
			name: model.name,
			canonical,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
			defaults: getModelDefaults(canonical)
		};
	});
}

/** Accepts a full `provider/id`, a `provider.model`, a bare name, or a fragment. */
export function resolveProxyModel(input: string) {
	if (!input) return state.defaultModel;
	const models = knownPiModels().filter((model) => model.provider === 'cladgpt-proxy');
	if (!models.length) return input;

	const needle = input.toLowerCase();
	const tiers: Array<(model: { id: string }) => boolean> = [
		(model) => model.id.toLowerCase() === needle,
		(model) => modelParts(model.id).qualified.toLowerCase() === needle,
		(model) => modelParts(model.id).bare.toLowerCase() === needle,
		(model) => modelParts(model.id).qualified.toLowerCase().includes(needle)
	];

	for (const matches of tiers.map((predicate) => models.filter(predicate))) {
		if (matches.length === 1) return matches[0].id;
		if (matches.length > 1) {
			die(
				`"${input}" matches ${matches.length} models:\n  ${matches.map((m) => m.id).join('\n  ')}\n` +
					'Use a longer fragment, or name the provider (e.g. "deepseek.deepseek-v4-flash").'
			);
		}
	}
	return input;
}
