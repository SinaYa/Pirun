/** The installer's individual steps. Each checks before it acts; all re-runnable. */

import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_DIR, ENV_FILE, PROJECT_DIR } from '../paths.ts';
import { loadSettings } from '../settings.ts';
import { describe, heading, report, run } from './report.ts';
import { piModelsPath, PI_PROVIDER } from './pi-registry.ts';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const CFG_FILE = resolve(PROJECT_DIR, 'proxy.cfg');
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

export function checkNode() {
	heading('Node');
	const [major, minor] = process.versions.node.split('.').map(Number);
	const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
	if (!ok) {
		report(
			`node ${process.versions.node}`,
			'failed',
			`need >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}; this project runs its TypeScript sources directly`
		);
		console.error('\nInstall a newer Node and run this again. Nothing else was changed.');
		process.exit(1);
	}
	report(`node ${process.versions.node}`, 'already');
}

export function checkDependencies() {
	heading('Dependencies');
	const require = createRequire(import.meta.url);

	const resolves = (name: string) => {
		try {
			require.resolve(name);
			return true;
		} catch {
			return false;
		}
	};

	const required = ['yaml', 'gpt-tokenizer'];
	const localPackage = (name: string) => existsSync(resolve(PROJECT_DIR, 'node_modules', name, 'package.json'));
	if (required.every(localPackage)) {
		for (const name of required) report(name, 'already', 'installed locally');
	} else {
		try {
			run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
			for (const name of required) report(name, resolves(name) ? 'done' : 'failed', 'npm install');
		} catch (error) {
			throw new Error(`dependency installation failed: ${describe(error)}`);
		}
	}

	// Only the commandcode.* provider needs the Command Code CLI. Everything
	// else works without it, so a missing package is a note, not a failure.
	report(
		'command-code',
		resolves('command-code/package.json') ? 'already' : 'skipped',
		resolves('command-code/package.json')
			? undefined
			: 'not installed — commandcode.* models will fail; `npm install` here to add it'
	);
}

function envKeysInUse(): string[] {
	const providers = readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8');
	const keys = new Set<string>();
	for (const match of providers.matchAll(/api_key_env:\s*([A-Z0-9_]+)/g)) keys.add(match[1]);
	return [...keys];
}

export function checkEnv() {
	heading('API keys');
	const example = resolve(PROJECT_DIR, '.env.example');

	if (!existsSync(ENV_FILE)) {
		if (existsSync(example)) {
			copyFileSync(example, ENV_FILE);
			report('.env', 'done', 'created from .env.example — fill in your keys');
		} else {
			writeFileSync(ENV_FILE, envKeysInUse().map((key) => `${key}=`).join('\n') + '\n');
			report('.env', 'done', 'created empty — fill in your keys');
		}
	} else {
		report('.env', 'already', 'left untouched');
	}

	const text = readFileSync(ENV_FILE, 'utf8');
	const missing = envKeysInUse().filter((key) => {
		const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(text);
		return !line || !line[1].trim();
	});
	if (missing.length) {
		report('keys present', 'skipped', `still empty: ${missing.join(', ')}`);
	} else {
		report('keys present', 'already', 'every provider has a key');
	}
}

function portIsFree(port: number) {
	return new Promise<boolean>((done) => {
		const probe = createServer();
		probe.once('error', () => done(false));
		probe.once('listening', () => probe.close(() => done(true)));
		probe.listen(port, '127.0.0.1');
	});
}

function writeCfgPort(port: number) {
	const text = readFileSync(CFG_FILE, 'utf8');
	writeFileSync(CFG_FILE, text.replace(/^port\s*=.*$/m, `port = ${port}`));
}

export async function chooseProxyPort(requestedPort: number) {
	heading('Port');
	const settings = loadSettings();
	const wanted = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : settings.port;

	if (await portIsFree(wanted)) {
		if (wanted !== settings.port) writeCfgPort(wanted);
		report(`port ${wanted}`, wanted === settings.port ? 'already' : 'done', 'free');
		return wanted;
	}

	// Something already listens there. If it is our own proxy, that is fine.
	try {
		const response = await fetch(`http://127.0.0.1:${wanted}/health`, {
			signal: AbortSignal.timeout(1500)
		});
		const body = (await response.json()) as { service?: string };
		if (body.service === 'completions-proxy') {
			report(`port ${wanted}`, 'already', 'our proxy is already listening there');
			return wanted;
		}
	} catch {
		/* not us, or not speaking HTTP */
	}

	if (Number.isFinite(requestedPort)) {
		report(`port ${wanted}`, 'failed', 'in use by something else; pass a different --port');
		return wanted;
	}

	for (let candidate = wanted + 1; candidate < wanted + 40; candidate += 1) {
		if (await portIsFree(candidate)) {
			writeCfgPort(candidate);
			report(`port ${candidate}`, 'done', `${wanted} was taken, moved to ${candidate}`);
			return candidate;
		}
	}
	report('port', 'failed', 'no free port found near the configured one');
	return wanted;
}

function globalNodeModules() {
	try {
		return run('npm', ['root', '-g']).trim();
	} catch {
		return '';
	}
}

function findPi() {
	const root = globalNodeModules();
	if (root) {
		const entry = resolve(root, PI_PACKAGE, 'dist/cli.js');
		if (existsSync(entry)) return entry;
	}
	return '';
}

export function checkPi(skip: boolean) {
	heading('Pi CLI');
	if (skip) {
		report(PI_PACKAGE, 'skipped', '--no-pi');
		return findPi();
	}
	let entry = findPi();
	if (entry) {
		report(PI_PACKAGE, 'already', entry);
		return entry;
	}
	try {
		run('npm', ['install', '-g', PI_PACKAGE]);
		entry = findPi();
		report(PI_PACKAGE, entry ? 'done' : 'failed', entry || 'installed but the entry point was not found');
	} catch (error) {
		report(PI_PACKAGE, 'failed', describe(error));
	}
	return entry;
}

export function checkLink(skip: boolean) {
	heading('pirun on PATH');
	if (skip) {
		report('npm link', 'skipped', '--no-link');
		return;
	}
	const root = globalNodeModules();
	const linked = root && existsSync(resolve(root, 'completions-proxy'));
	try {
		run('npm', ['link']);
		report('npm link', linked ? 'already' : 'done', 'run `pirun status` from any directory');
	} catch (error) {
		report('npm link', 'failed', `${describe(error)} — fall back to: node ${resolve(PROJECT_DIR, 'bin/pirun.ts')}`);
	}
}

export async function verify(port: number, smoke: boolean) {
	heading('Verify');
	const { spawn } = await import('node:child_process');
	const base = `http://127.0.0.1:${port}`;

	const up = async () => {
		try {
			return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok;
		} catch {
			return false;
		}
	};

	let ours = false;
	if (!(await up())) {
		const child = spawn(process.execPath, [resolve(PROJECT_DIR, 'src/server.ts')], {
			cwd: PROJECT_DIR,
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		child.unref();
		ours = true;
		for (let attempt = 0; attempt < 25 && !(await up()); attempt += 1) {
			await new Promise((r) => setTimeout(r, 400));
		}
	}

	if (!(await up())) {
		report('proxy responds', 'failed', `nothing on ${base}/health`);
		return;
	}
	report('proxy responds', 'done', `${base}/v1`);

	const models = (await (await fetch(`${base}/v1/models`)).json()) as { data?: unknown[] };
	report('model catalogue', 'done', `${models.data?.length ?? 0} provider/model/variant ids`);

	if (smoke) {
		// Uses the provider default from proxy.cfg, so it exercises whichever
		// route this machine is actually keyed for. An empty answer counts as a
		// failure — that is the silent-failure shape, not a pass.
		const ask = async () => {
			const response = await fetch(`${base}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'Reply with exactly: INSTALL OK' }],
					max_tokens: 64
				}),
				signal: AbortSignal.timeout(300_000)
			});
			return (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
				error?: { message?: string; details?: unknown };
			};
		};

		try {
			let body = await ask();
			if (!body.error && !body.choices?.[0]?.message?.content?.trim()) body = await ask();

			const content = body.choices?.[0]?.message?.content?.trim() ?? '';
			if (body.error) report('live request', 'failed', body.error.message);
			else if (!content) {
				report('live request', 'failed', 'provider returned an empty completion twice — check .env keys and the proxy log');
			} else report('live request', 'done', JSON.stringify(content));
		} catch (error) {
			report('live request', 'failed', describe(error));
		}
	}

	if (ours) {
		await fetch(`${base}/shutdown`, { method: 'POST' }).catch(() => {});
		report('proxy stopped', 'done', 'it was started only for this check');
	}
}

export function uninstall() {
	heading('Uninstall');
	try {
		run('npm', ['unlink', '-g', 'completions-proxy']);
		report('npm unlink', 'done', 'pirun removed from PATH');
	} catch (error) {
		report('npm unlink', 'failed', describe(error));
	}

	const path = piModelsPath();
	if (path && existsSync(path)) {
		try {
			const document = JSON.parse(readFileSync(path, 'utf8')) as {
				providers?: Record<string, unknown>;
			};
			const managedProviders = Object.keys(document.providers ?? {}).filter(
				(id) => id === PI_PROVIDER || /^pirun-.*-[a-f0-9]{8}$/.test(id)
			);
			if (managedProviders.length) {
				for (const id of managedProviders) delete document.providers?.[id];
				writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
				report('Pirun providers', 'done', `removed ${managedProviders.length} from models.json`);
			} else {
				report('Pirun providers', 'already', 'not present');
			}
		} catch (error) {
			report('models.json', 'failed', describe(error));
		}
	}

	console.log(`\nLeft alone: ${PI_PACKAGE} (npm uninstall -g ${PI_PACKAGE}), ${ENV_FILE}, and this folder.`);
}
