import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

// Offline: the login dialog is exercised with an in-process fake agy child and
// a temp profile directory. No OAuth, no browser, no real harness.
process.env.PIRUN_PROVIDERS_PATH = resolve(tmpdir(), 'pirun-login-test-providers.json');
process.env.PIRUN_RUNS_DIR = resolve(tmpdir(), 'pirun-login-test-runs');
const { isExpiredSignInAttempt, runAntigravityLoginDialog } = await import('../src/cli/auth.ts');

const sandbox = mkdtempSync(resolve(tmpdir(), 'pirun-login-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const OAUTH_URL =
	'https://accounts.google.com/o/oauth2/auth?client_id=x&redirect_uri=y&state=' + 'a'.repeat(22);

interface FakeChild {
	stdout: PassThrough;
	stderr: PassThrough;
	stdin: PassThrough;
	pid?: number;
	exitCode: number | null;
	once(event: string, listener: (...args: unknown[]) => void): FakeChild;
	emit(event: string, ...args: unknown[]): void;
}

function fakeChild(): FakeChild {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	return {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		exitCode: null,
		once(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return this;
		},
		emit(event, ...args) {
			for (const listener of listeners.get(event) ?? []) listener(...args);
			listeners.set(event, []);
		}
	};
}

function profileFor(name: string) {
	const dir = resolve(sandbox, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeProfileLog(profileDir: string, text: string) {
	writeFileSync(resolve(profileDir, 'session.log'), text);
}

test('a pasted code reaches agy and success is read from the profile', async () => {
	const profileDir = profileFor('ok');
	writeProfileLog(profileDir, 'Using file-based token storage\n');
	const child = fakeChild();
	const input = new PassThrough();
	const printed: string[] = [];
	const openedUrls: string[] = [];

	// agy asks for the code; the "human" pastes it; agy records success.
	const received: string[] = [];
	child.stdin.on('data', (chunk) => {
		received.push(String(chunk));
		writeProfileLog(
			profileDir,
			'Using file-based token storage\nOAuth: authenticated successfully as someone\n'
		);
	});

	const dialog = runAntigravityLoginDialog({
		account: 'ok',
		profileDir,
		child,
		input,
		openUrl: (url) => openedUrls.push(url),
		print: (line = '') => printed.push(line),
		pollMs: 25
	});

	child.stdout.write(`some agy banner noise\n${OAUTH_URL}\nmore noise\n`);
	await new Promise((r) => setTimeout(r, 50));
	input.write('THE-AUTH-CODE\n');

	const result = await dialog;
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(received, ['THE-AUTH-CODE\n']);
	assert.deepEqual(openedUrls, [OAUTH_URL]);
	assert.ok(printed.some((line) => line.includes('Browser opened — sign in with Google.')));
	assert.ok(printed.some((line) => line.includes('paste it here and press Enter')));
	// Antigravity's own interface must never leak into the dialog.
	assert.ok(!printed.some((line) => line.includes('banner noise')));
	assert.ok(!printed.some((line) => line.includes('/quit')));
});

test('an early agy exit fails with its last output lines as context', async () => {
	const profileDir = profileFor('exit');
	writeProfileLog(profileDir, 'Using file-based token storage\n');
	const child = fakeChild();

	const dialog = runAntigravityLoginDialog({
		account: 'exit',
		profileDir,
		child,
		input: new PassThrough(),
		openUrl: () => {},
		print: () => {},
		pollMs: 25
	});

	child.stderr.write('fatal: network unreachable\n');
	child.exitCode = 1;
	child.emit('exit', 1);

	const result = await dialog;
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.reason, /Antigravity exited \(1\) before authentication completed/);
		assert.ok(result.context.includes('fatal: network unreachable'));
	}
});

test('a keyring fallback during login is refused', async () => {
	const profileDir = profileFor('keyring');
	writeProfileLog(profileDir, 'Using keyring token storage\n');
	const child = fakeChild();

	const result = await runAntigravityLoginDialog({
		account: 'keyring',
		profileDir,
		child,
		input: new PassThrough(),
		openUrl: () => {},
		print: () => {},
		pollMs: 25
	});

	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /keyring/);
});

test('an expired 60-second sign-in link is recognized as retryable', () => {
	// The failure shape observed live: agy exits 1 after its hard-coded
	// 60-second link window lapses, with the timeout on its last output lines.
	assert.equal(
		isExpiredSignInAttempt({
			ok: false,
			reason: 'Antigravity exited (1) before authentication completed',
			context: [
				'Waiting for authentication (timeout 60s)...',
				'Or, paste the authorization code here and press Enter:',
				'Error: authentication timed out.',
				'Error: authentication failed or timed out'
			]
		}),
		true
	);
	assert.equal(
		isExpiredSignInAttempt({
			ok: false,
			reason: 'Antigravity exited (1) before authentication completed',
			context: ['fatal: network unreachable']
		}),
		false
	);
	assert.equal(isExpiredSignInAttempt({ ok: true }), false);
});

test('the dialog times out instead of waiting forever', async () => {
	const profileDir = profileFor('slow');
	writeProfileLog(profileDir, 'Using file-based token storage\n');
	const child = fakeChild();

	const result = await runAntigravityLoginDialog({
		account: 'slow',
		profileDir,
		child,
		input: new PassThrough(),
		openUrl: () => {},
		print: () => {},
		timeoutMs: 100,
		pollMs: 25
	});

	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.reason, /did not complete within/);
});
