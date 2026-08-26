import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { atomicWriteJson } from './pirun-files.ts';

export const PIRUN_DEFAULT_MAX_RETRIES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function defaultPiAgentDir(env: NodeJS.ProcessEnv = process.env) {
	return env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi', 'agent');
}

/**
 * Pi has no CLI flag for the turn-retry budget. Establish pirun's preferred
 * default in Pi's global settings, but never replace an explicit user value.
 * Project-local Pi settings can still override this global default normally.
 */
export function ensurePirunRetryDefault(agentDir = defaultPiAgentDir()) {
	const settingsPath = resolve(agentDir, 'settings.json');
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
		if (!isRecord(parsed)) throw new Error(`Pi settings must be a JSON object: ${settingsPath}`);
		settings = parsed;
	}

	const retry = isRecord(settings.retry) ? settings.retry : {};
	if (typeof retry.maxRetries === 'number') return { changed: false, settingsPath, maxRetries: retry.maxRetries };

	retry.maxRetries = PIRUN_DEFAULT_MAX_RETRIES;
	settings.retry = retry;
	atomicWriteJson(settingsPath, settings);
	return { changed: true, settingsPath, maxRetries: PIRUN_DEFAULT_MAX_RETRIES };
}
