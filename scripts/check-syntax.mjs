#!/usr/bin/env node
/** Syntax-check every source file (node --check), so `npm run check` cannot
 *  silently miss a file the way a hand-maintained list did. Zero deps. */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_DIRS = ['bin', 'src', 'scripts'];
const files = [];

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
	if (/\.(ts|mts|mjs)$/.test(path)) files.push(path);
}

for (const dir of SCAN_DIRS) walk(join(ROOT, dir));

let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
	} catch (error) {
		failed += 1;
		console.error(`check-syntax: ${relative(ROOT, file)}`);
		console.error(String(error.stderr ?? error.message).trim());
	}
}

if (failed) {
	console.error(`check-syntax: ${failed} of ${files.length} files failed.`);
	process.exit(1);
}
console.log(`check-syntax: ${files.length} files parse cleanly.`);
