import { readFileSync } from 'node:fs';
import { ENV_FILE } from './paths.ts';

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
 * Minimal .env reader for endpoint api keys. Values already present in the
 * real environment win, so `set DEEPSEEK_API_KEY=... && pirun …` still
 * overrides the file. Nothing here logs or echoes a value.
 */
export function loadEnvFile(path = ENV_FILE) {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { loaded: false, count: 0 };
		throw error;
	}
	let count = 0;
	for (const [key, value] of parseEnvText(text)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
			count += 1;
		}
	}
	return { loaded: true, count };
}
