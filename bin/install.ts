#!/usr/bin/env node
/**
 * Setup for the completions proxy and the `pirun` CLI.
 *
 * Re-runnable: every step checks before it acts, so running this twice is a
 * no-op with a report. It never overwrites secrets, never clobbers another
 * tool's config, and never silently downgrades values you have tuned by hand.
 *
 *   node bin/install.ts                 do everything that is missing
 *   node bin/install.ts --port 9100     pin a port instead of auto-picking
 *   node bin/install.ts --smoke         finish with a live end-to-end request
 *   node bin/install.ts --uninstall     unlink pirun, drop our Pi provider
 *
 * The step implementations live in src/install/.
 */

import { resolve } from 'node:path';
import { PROJECT_DIR } from '../src/paths.ts';
import { anyStepFailed, heading, stepCounts } from '../src/install/report.ts';
import {
	checkDependencies,
	checkEnv,
	checkLink,
	checkNode,
	checkPi,
	chooseProxyPort,
	uninstall,
	verify
} from '../src/install/steps.ts';
import { checkPiModels } from '../src/install/pi-registry.ts';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(`--${flag}`);
const valueOf = (flag: string) => {
	const at = argv.indexOf(`--${flag}`);
	return at !== -1 ? (argv[at + 1] ?? '') : '';
};

if (has('help') || has('h')) {
	console.log(`Setup for the completions proxy and the pirun CLI.

  node bin/install.ts [options]

  --port <n>     use this port instead of auto-picking a free one
  --refresh-models
                 regenerate Pi's model list from the config, discarding any
                 values edited by hand
  --smoke        finish with a live request through a real provider
  --no-pi        do not install the Pi CLI
  --no-link      do not put pirun on PATH
  --uninstall    unlink pirun and remove our provider from Pi's models.json
  --help         this text

Safe to re-run. It never overwrites .env, never touches other providers in
Pi's models.json, and keeps model settings you have edited by hand.`);
	process.exit(0);
}

console.log(`completions-proxy setup\n  ${PROJECT_DIR}`);

if (has('uninstall')) {
	uninstall();
	process.exit(0);
}

checkNode();
checkDependencies();
checkEnv();
const port = await chooseProxyPort(Number.parseInt(valueOf('port'), 10));
checkPi(has('no-pi'));
await checkPiModels(port, has('refresh-models'));
checkLink(has('no-link'));
await verify(port, has('smoke'));

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
  pirun status                 check the wiring
  pirun models                 what you can address
  pirun run "say hello"        delegate a task

If "pirun" is not found, open a new shell, or use:
  node ${resolve(PROJECT_DIR, 'bin/pirun.ts')}

Agent runbook: ${resolve(PROJECT_DIR, 'FOR-AGENTS.md')}`);
