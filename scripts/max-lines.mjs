#!/usr/bin/env node
/**
 * Anti-bloat guard: no TypeScript source file may exceed MAX_LINES lines.
 * Runs in `npm test`, `npm run check`, and the pre-commit hook. Zero deps.
 *
 * When this fails, the fix is to split the file into modules (see src/cli/,
 * src/proxy/, src/inference/, src/command-code/ for the established pattern),
 * never to raise the cap or extend the exempt list casually.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const MAX_LINES = 400;
const ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['bin', 'src', 'test', 'scripts'];
/** Pure-data or generated files may be listed here, with a reason. */
const EXEMPT = new Map([
	// (none — keep it that way)
]);

const offenders = [];
for (const dir of SCAN_DIRS) {
	walk(join(ROOT, dir));
}

function walk(path) {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return;
	}
	if (stats.isDirectory()) {
		if (path.includes('node_modules')) return;
		for (const entry of readdirSync(path)) walk(join(path, entry));
		return;
	}
	if (!/\.(ts|mts|cts|mjs|cjs|js)$/.test(path)) return;
	const lines = readFileSync(path, 'utf8').split('\n').length;
	const rel = relative(ROOT, path).replace(/\\/g, '/');
	if (lines > MAX_LINES && !EXEMPT.has(rel)) offenders.push({ rel, lines });
}

if (offenders.length) {
	console.error(`max-lines: ${offenders.length} file(s) exceed the ${MAX_LINES}-line cap:`);
	for (const { rel, lines } of offenders.sort((a, b) => b.lines - a.lines)) {
		console.error(`  ${String(lines).padStart(5)}  ${rel}`);
	}
	console.error('Split the file into focused modules instead of raising the cap.');
	process.exit(1);
}
console.log(`max-lines: every source file is within the ${MAX_LINES}-line cap.`);
