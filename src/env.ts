import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { ENV_FILE } from './paths.ts';

export interface EnvKeyInfo {
	key: string;
	/** First 12 hex of SHA-256 — enough to compare two keys, useless as a key. */
	fingerprint: string;
	length: number;
	/** 'file' if this process set it from .env, 'environment' if it was already set. */
	source: 'file' | 'environment';
	/** True when .env defines the key but a real environment variable shadows it. */
	shadowed: boolean;
}

export interface EnvSnapshot {
	loaded: boolean;
	count: number;
	keys: string[];
	details: EnvKeyInfo[];
	loadedAt: string;
}

/** Identifies a secret without disclosing it, so two copies can be compared. */
export function fingerprint(value: string) {
	return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Keys this process installed from the file. Anything outside this set was
 * already in the real environment and stays untouched — a `set KEY=… && start`
 * must keep beating the file.
 */
const ownedKeys = new Set<string>();
let signature = '';
let snapshot: EnvSnapshot = { loaded: false, count: 0, keys: [], details: [], loadedAt: '' };

function parseEnvText(text: string) {
	const entries: Array<[string, string]> = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
		const eq = withoutExport.indexOf('=');
		if (eq <= 0) continue;
		const key = withoutExport.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = withoutExport.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		entries.push([key, value]);
	}
	return entries;
}

/**
 * Minimal .env reader. Values already present in the real environment win, so
 * `set DEEPSEEK_API_KEY=... && start.bat` still overrides the file.
 *
 * Re-reading is safe and is how an edited key reaches a running process: a key
 * this process installed is replaced by the file's new value, while one that
 * came from the real environment is never overwritten.
 *
 * Nothing here logs or echoes a value.
 */
export function loadEnvFile(path = ENV_FILE): EnvSnapshot {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			snapshot = { loaded: false, count: 0, keys: [], details: [], loadedAt: new Date().toISOString() };
			return snapshot;
		}
		throw error;
	}

	const details: EnvKeyInfo[] = [];
	for (const [key, value] of parseEnvText(text)) {
		const preexisting = process.env[key] !== undefined && !ownedKeys.has(key);
		if (!preexisting) {
			process.env[key] = value;
			ownedKeys.add(key);
		}
		const effective = process.env[key] ?? '';
		details.push({
			key,
			fingerprint: effective ? fingerprint(effective) : '',
			length: effective.length,
			source: preexisting ? 'environment' : 'file',
			shadowed: preexisting
		});
	}

	snapshot = {
		loaded: true,
		count: details.length,
		keys: details.map((entry) => entry.key),
		details,
		loadedAt: new Date().toISOString()
	};
	return snapshot;
}

/**
 * Re-read .env when it has changed on disk. Editing a key is meant to take
 * effect on the next request, not on the next restart — a stale key in a
 * long-running process looks exactly like a key that was never updated.
 *
 * Returns true when something was reloaded.
 */
export function refreshEnvFile(path = ENV_FILE) {
	let next = '';
	try {
		const stats = statSync(path);
		next = `${stats.mtimeMs}:${stats.size}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		next = 'missing';
	}
	if (next === signature) return false;
	const first = signature === '';
	signature = next;
	loadEnvFile(path);
	return !first;
}

export function envSnapshot() {
	return snapshot;
}
