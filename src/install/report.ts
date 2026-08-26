/** Step reporting and command running shared by the installer's steps. */

import { execFileSync } from 'node:child_process';
import { PROJECT_DIR } from '../paths.ts';

export type StepState = 'done' | 'already' | 'skipped' | 'failed';

const steps: Array<{ name: string; state: StepState; note?: string }> = [];
let failed = false;

export function report(name: string, state: StepState, note?: string) {
	const mark = { done: '+', already: '=', skipped: '-', failed: '!' }[state];
	console.log(`  ${mark} ${name}${note ? ` — ${note}` : ''}`);
	steps.push({ name, state, note });
	if (state === 'failed') failed = true;
}

export function heading(text: string) {
	console.log(`\n${text}`);
}

export function anyStepFailed() {
	return failed;
}

export function stepCounts() {
	return steps.reduce<Record<string, number>>((totals, step) => {
		totals[step.state] = (totals[step.state] ?? 0) + 1;
		return totals;
	}, {});
}

/**
 * On Windows `npm` is a .cmd, which Node refuses to execFile directly (EINVAL,
 * the CVE-2024-27980 mitigation) and warns about under `shell: true` (DEP0190).
 * Going through `cmd.exe /c` avoids both.
 */
export function run(command: string, args: string[], cwd = PROJECT_DIR) {
	const [binary, argv] =
		process.platform === 'win32' ? ['cmd.exe', ['/c', command, ...args]] : [command, args];
	return execFileSync(binary, argv, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

export function describe(error: unknown) {
	if (error instanceof Error) {
		const stderr = (error as Error & { stderr?: string }).stderr;
		return (stderr?.trim().split('\n').pop() || error.message).slice(0, 200);
	}
	return String(error).slice(0, 200);
}
