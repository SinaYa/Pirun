/** Antigravity account authentication: isolated profiles, verified isolation. */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
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
			antigravityRunArgs({ profileDir, approveTools: false, timeoutSec: 5 }),
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
	out(`Opening Antigravity login for account "${account}".`);
	out('Authenticate in the browser. If the page shows a code, paste it here and press Enter.');
	out('When Antigravity shows the signed-in account, use /quit to continue.');
	const startedAt = Date.now();
	const child = spawn(entry, antigravityBaseArgs(profileDir), {
		cwd,
		stdio: isolationMode === 'ssh-file' ? ['inherit', 'pipe', 'pipe'] : 'inherit',
		windowsHide: false,
		env: antigravityEnv(isolationMode)
	});
	if (isolationMode === 'ssh-file') {
		let opened = false;
		let urlBuffer = '';
		const forward = (stream: NodeJS.ReadableStream | null, destination: NodeJS.WriteStream) => {
			stream?.on('data', (chunk) => {
				const text = String(chunk);
				destination.write(text);
				if (opened) return;
				urlBuffer = `${urlBuffer}${text}`.slice(-32_000);
				const url = antigravityOAuthUrl(urlBuffer);
				if (url) {
					opened = true;
					openBrowserUrl(url);
				}
			});
		};
		forward(child.stdout, process.stdout);
		forward(child.stderr, process.stderr);
	}
	const exitCode = await waitForChildExit(child);
	const inspected = inspectAntigravityProfile(profileDir, startedAt);
	if (!inspected.usesFileStorage || inspected.usesKeyring) {
		throw new Error('Antigravity login did not remain inside the isolated file-backed profile.');
	}
	if (!inspected.authenticated) {
		throw new Error(
			`Antigravity exited (${exitCode}) before Pirun could confirm authentication. Run ` +
			`"pirun login antigravity ${account}" and finish the browser sign-in.`
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
	out('When Antigravity shows the signed-in account, type /quit there. Waiting up to 15 minutes…');
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
