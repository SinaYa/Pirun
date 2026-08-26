/** Pi CLI discovery and its registered-model catalogue. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { die } from './context.ts';

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

export interface CatalogueRow {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

/** Everything Pi can address, straight from its models.json. */
export function catalogue(): CatalogueRow[] {
	return knownPiModels().map((model) => ({
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning
	}));
}

