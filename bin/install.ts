#!/usr/bin/env node
/**
 * Setup for the `pirun` CLI.
 *
 * Re-runnable: every step checks before it acts, so running this twice is a
 * no-op with a report. It never overwrites secrets and never clobbers another
 * tool's config.
 *
 *   node bin/install.ts                 do everything that is missing
 *   node bin/install.ts --uninstall     unlink pirun, drop its Pi providers
 *
 * The step implementations live in src/install/.
 */

import { resolve } from 'node:path';
import { PROJECT_DIR } from '../src/paths.ts';
import { anyStepFailed, heading, stepCounts } from '../src/install/report.ts';
import {
	checkDependencies,
	checkLink,
	checkNode,
	checkPi,
	uninstall
} from '../src/install/steps.ts';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(`--${flag}`);

if (has('help') || has('h')) {
	console.log(`Setup for the pirun CLI.

  node bin/install.ts [options]

  --no-pi        do not install the Pi CLI
  --no-link      do not put pirun on PATH
  --uninstall    unlink pirun and remove its providers from Pi's models.json
  --help         this text

Safe to re-run. It never touches other providers in Pi's models.json.`);
	process.exit(0);
}

console.log(`pirun setup\n  ${PROJECT_DIR}`);

if (has('uninstall')) {
	uninstall();
	process.exit(0);
}

checkNode();
checkDependencies();
checkPi(has('no-pi'));
checkLink(has('no-link'));

heading('Summary');
const counts = stepCounts();
console.log(
	`  ${counts.done ?? 0} changed · ${counts.already ?? 0} already in place · ` +
		`${counts.skipped ?? 0} skipped · ${counts.failed ?? 0} failed`
);

if (anyStepFailed()) {
	console.log('\nSomething above needs your attention. Re-run after fixing it.');
	process.exitCode = 1;
}

console.log(`
Next:
  pirun providers              what --use can say, and account readiness
  pirun login antigravity <account>
  pirun agent <preset> <name> --time 10m/2h "task" --use <provider> --model <id>

If "pirun" is not found, open a new shell, or use:
  node ${resolve(PROJECT_DIR, 'bin/pirun.ts')}

Agent runbook: ${resolve(PROJECT_DIR, 'FOR-AGENTS.md')}`);
