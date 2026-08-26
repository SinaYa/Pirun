#!/usr/bin/env node
/** Point git at the repo's hooks so the max-lines guard runs on every commit.
 *  Runs automatically via npm's prepare step; silent no-op outside a git repo. */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(ROOT, '.git'))) process.exit(0);
try {
	execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'ignore' });
	console.log('setup-hooks: core.hooksPath -> .githooks (pre-commit runs the max-lines guard)');
} catch {
	// git missing or config refused — the guard still runs in npm test / npm run check.
}
