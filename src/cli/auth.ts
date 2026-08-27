/** Antigravity account authentication: isolated profiles, verified isolation. */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
	antigravityAuthMarkerTime,
	antigravityBaseArgs,
	antigravityEnv,
	antigravityIsolationMode,
	antigravityOAuthUrl,
	antigravityProfileDir,
	antigravityRunArgs,
	findAntigravityEntry,
	hasAntigravityAuthMarker,
	inspectAntigravityProfile,
	markAntigravityAuthenticated,
	type AntigravityIsolationMode
} from '../pirun-antigravity.ts';
import { terminateProcessTree } from '../pirun-process.ts';
import { die, out, state, waitForChildExit } from './context.ts';

export function openBrowserUrl(url: string) {
	let command: string;
	let args: string[];
	if (process.platform === 'win32') {
		// explorer.exe silently failed to open OAuth URLs on tested machines;
		// the shell's own URL handler is the path that reliably worked.
		command = 'rundll32.exe';
		args = ['url.dll,FileProtocolHandler', url];
	} else if (process.platform === 'darwin') {
		command = 'open';
		args = [url];
	} else {
		command = 'xdg-open';
		args = [url];
	}
	try {
		const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
		opener.unref();
	} catch {
		// The URL remains visible in the terminal for manual opening.
	}
}

async function verifyAntigravityIsolation(entry: string, profileDir: string, cwd: string) {
	const modes: AntigravityIsolationMode[] = process.platform === 'win32'
		? ['ssh-file']
		: ['force-file', 'ssh-file'];
	for (const mode of modes) {
		const startedAt = Date.now();
		const child = spawn(
			entry,
			antigravityRunArgs({ profileDir, timeoutSec: 5 }),
			{
				cwd,
				stdio: ['pipe', 'ignore', 'ignore'],
				windowsHide: true,
				env: antigravityEnv(mode)
			}
		);
		child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: 'Reply with exactly OK.' } })}\n`);
		const exit = waitForChildExit(child, 12_000);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && child.exitCode === null) {
			const inspected = inspectAntigravityProfile(profileDir, startedAt);
			if (inspected.usesFileStorage && !inspected.usesKeyring) {
				if (child.pid) terminateProcessTree(child.pid);
				await exit;
				return mode;
			}
			if (inspected.usesKeyring) break;
			await new Promise((resolveProbe) => setTimeout(resolveProbe, 200));
		}
		if (child.pid && child.exitCode === null) terminateProcessTree(child.pid);
		await exit;
	}
	throw new Error(
		'Antigravity did not confirm file-backed credential storage. Pirun stopped before login ' +
			'because using the shared OS keyring would break account isolation.'
	);
}

/** One isolated profile per account; presets share accounts, never profiles. */
export function antigravityAccountProfileDir(account: string) {
	const stored = state.providersStore.harnesses.antigravity?.accounts[account]?.profileDir;
	return stored ? resolve(stored) : antigravityProfileDir(account);
}

/** The minimal child surface the login dialog needs; a test can fake it. */
export interface LoginChild {
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	stdin: NodeJS.WritableStream | null;
	pid?: number;
	exitCode: number | null;
	once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
}

function stripAnsi(text: string) {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
}

/**
 * Pirun's own login interface. Antigravity's interactive UI is never shown:
 * agy runs fully piped in the background while the human sees only these
 * prompts. The OAuth URL is scraped from agy's output for the browser, pasted
 * lines are relayed to agy's stdin, and success is detected by inspecting the
 * profile on disk — so no `/quit`, no harness TUI. On failure, agy's last
 * output lines are surfaced as context.
 */
export async function runAntigravityLoginDialog(options: {
	account: string;
	profileDir: string;
	child: LoginChild;
	input?: NodeJS.ReadableStream;
	openUrl?: (url: string) => void;
	print?: (line?: string) => void;
	timeoutMs?: number;
	pollMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string; context: string[] }> {
	const print = options.print ?? out;
	const openUrl = options.openUrl ?? openBrowserUrl;
	const input = options.input ?? process.stdin;
	const startedAt = Date.now();
	const deadline = startedAt + (options.timeoutMs ?? 15 * 60_000);
	const child = options.child;

	print(`Signing in Antigravity account "${options.account}" (isolated profile).`);
	print('Waiting for the sign-in link…');

	let buffer = '';
	let opened = false;
	const watch = (stream: NodeJS.ReadableStream | null) => {
		stream?.on('data', (chunk) => {
			buffer = `${buffer}${String(chunk)}`.slice(-32_000);
			if (opened) return;
			const url = antigravityOAuthUrl(buffer);
			if (url) {
				opened = true;
				openUrl(url);
				print('Browser opened — sign in with Google.');
				print(`If it did not open, use this link: ${url}`);
				print('If the page shows an authorization code, paste it here and press Enter.');
				print('Antigravity gives each link only ~60 seconds; an expired link gets a fresh one automatically.');
			}
		});
	};
	watch(child.stdout);
	watch(child.stderr);

	const reader = createInterface({ input, terminal: false });
	reader.on('line', (line) => child.stdin?.write(`${line}\n`));

	let exited = false;
	let spawnFailed = false;
	child.once('exit', () => {
		exited = true;
	});
	child.once('error', () => {
		exited = true;
		spawnFailed = true;
	});

	const lastOutput = () =>
		stripAnsi(buffer).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5);
	let warnedSilent = false;

	try {
		while (Date.now() < deadline) {
			const inspected = inspectAntigravityProfile(options.profileDir, startedAt);
			if (inspected.usesKeyring) {
				return { ok: false, reason: 'the login left the isolated file-backed profile (keyring detected)', context: lastOutput() };
			}
			if (inspected.authenticated && inspected.usesFileStorage) return { ok: true };
			if (exited) {
				// One last look: the success record can land just before exit.
				const final = inspectAntigravityProfile(options.profileDir, startedAt);
				if (final.authenticated && final.usesFileStorage && !final.usesKeyring) return { ok: true };
				return {
					ok: false,
					reason: spawnFailed
						? 'Antigravity could not be started (spawn error)'
						: `Antigravity exited (${child.exitCode}) before authentication completed`,
					context: lastOutput()
				};
			}
			if (!opened && !warnedSilent && buffer.length === 0 && Date.now() - startedAt > 30_000) {
				warnedSilent = true;
				print('Antigravity has produced no output for 30 seconds.');
				print(`If this persists, check the logs under ${options.profileDir} and re-run the login.`);
			}
			await new Promise((resolvePoll) => setTimeout(resolvePoll, options.pollMs ?? 500));
		}
		return { ok: false, reason: 'the sign-in did not complete within 15 minutes', context: lastOutput() };
	} finally {
		reader.close();
		if (child.exitCode === null && child.pid) terminateProcessTree(child.pid);
	}
}

/** True when agy gave up because its 60-second sign-in link lapsed, which a
 * fresh attempt (new link, browser session still signed in) usually fixes. */
export function isExpiredSignInAttempt(result: { ok: boolean; reason?: string; context?: string[] }) {
	if (result.ok) return false;
	const text = [result.reason ?? '', ...(result.context ?? [])].join('\n').toLowerCase();
	return text.includes('authentication timed out') || text.includes('authentication failed or timed out');
}

export async function loginAntigravityAccount(account: string, force = false) {
	const profileDir = antigravityAccountProfileDir(account);
	const alreadyAuthenticated = hasAntigravityAuthMarker(profileDir);
	if (alreadyAuthenticated && !force) {
		out(`Antigravity account "${account}" is already authenticated in ${profileDir}`);
		return;
	}
	const entry = findAntigravityEntry();
	const cwd = process.cwd();
	let isolationMode = antigravityIsolationMode(profileDir);
	if (!alreadyAuthenticated) {
		out(`Checking isolated credential storage for account "${account}"…`);
		isolationMode = await verifyAntigravityIsolation(entry, profileDir, cwd);
	}
	// Login must run agy in print mode: the interactive TUI emits nothing on
	// piped stdio — with stdin held open it blocks reading stdin before printing
	// a single byte (verified agy 1.1.19 on Windows: 0 bytes on stdout+stderr,
	// language server never starts). Print mode is what emits "Authentication
	// required. Please visit the URL to log in:" on stderr, accepts a pasted
	// authorization code on stdin, and records "Print mode: silent auth
	// succeeded" — the success pattern this login already detects.
	// agy hard-codes a 60-second window per sign-in link and there is no flag or
	// env var to widen it (binary literal "Waiting for authentication (timeout
	// 60s)", agy 1.1.19). A first sign-in — password, consent, copying the code —
	// rarely fits, and every fresh agy run mints a new PKCE link that invalidates
	// the previous code. So expired links retry automatically: the browser
	// session survives between attempts, making the next link a few clicks.
	const deadline = Date.now() + 15 * 60_000;
	for (;;) {
		const child = spawn(entry, [...antigravityBaseArgs(profileDir), '-p', 'Reply with exactly OK.'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: antigravityEnv(isolationMode)
		});
		const result = await runAntigravityLoginDialog({
			account,
			profileDir,
			child,
			timeoutMs: Math.max(deadline - Date.now(), 1)
		});
		if (result.ok) break;
		if (isExpiredSignInAttempt(result) && Date.now() < deadline) {
			out('');
			out('That sign-in link expired (Antigravity allows only ~60 seconds per link).');
			out('Requesting a fresh link — you are likely still signed in, so approving it is quick.');
			continue;
		}
		for (const line of result.context) out(`agy: ${line}`);
		throw new Error(
			`${result.reason}. Run "pirun login antigravity ${account}" to try again.`
		);
	}
	markAntigravityAuthenticated(profileDir, isolationMode);
	out(`Authenticated Antigravity account "${account}" in an isolated profile.`);
	if (inspectAntigravityProfile(profileDir).ineligible) {
		out('warning: Antigravity reports that this account is not eligible in the current location.');
	}
}

/**
 * Windows login opens a separate visible console window so the user always has
 * a real terminal to paste the Google authorization code into, even when Pirun
 * itself was launched from a non-interactive caller (an agent, a script). The
 * parent waits for the isolated profile's auth marker instead of the window.
 */
export async function loginAntigravityWindowed(account: string) {
	const profileDir = antigravityAccountProfileDir(account);
	const script = resolve(process.argv[1]);
	const startedAt = Date.now();
	const child = spawn(
		'cmd.exe',
		[
			'/c', 'start', 'Pirun Antigravity login',
			process.execPath, script, 'login', 'antigravity', account, '--inline', '--login-window'
		],
		{ detached: true, stdio: 'ignore', windowsHide: false }
	);
	child.unref();
	out(`Opened a separate login window for Antigravity account "${account}".`);
	out('Sign in with the browser. If Google shows an authorization code, paste it into that window.');
	out('The window closes itself when the sign-in completes. Waiting up to 15 minutes…');
	const deadline = Date.now() + 15 * 60_000;
	while (Date.now() < deadline) {
		if (antigravityAuthMarkerTime(profileDir) >= startedAt) {
			out(`Authenticated Antigravity account "${account}" in an isolated profile.`);
			if (inspectAntigravityProfile(profileDir).ineligible) {
				out('warning: Antigravity reports that this account is not eligible in the current location.');
			}
			return;
		}
		await new Promise((resolvePoll) => setTimeout(resolvePoll, 2_000));
	}
	die(
		`the login window did not finish within 15 minutes. Complete the sign-in there, ` +
			`then run "pirun providers" to check the account.`
	);
}

export async function holdLoginWindowOpen() {
	out('');
	out('Press Enter to close this window.');
	await new Promise<void>((resolveKey) => {
		process.stdin.resume();
		process.stdin.once('data', () => resolveKey());
	});
	process.stdin.pause();
}

export async function ensureHarnessAuthentication() {
	if (state.preset.harness !== 'antigravity') return;
	const account = state.use.account;
	if (hasAntigravityAuthMarker(antigravityAccountProfileDir(account))) return;
	if (process.platform === 'win32') await loginAntigravityWindowed(account);
	else await loginAntigravityAccount(account);
}
