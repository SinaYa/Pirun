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
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG_DIR, ENV_FILE, PROJECT_DIR } from '../src/paths.ts';
import { loadSettings } from '../src/settings.ts';

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_PROVIDER = 'cladgpt-proxy';
const CFG_FILE = resolve(PROJECT_DIR, 'proxy.cfg');
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(`--${flag}`);
const valueOf = (flag: string) => {
	const at = argv.indexOf(`--${flag}`);
	return at !== -1 ? (argv[at + 1] ?? '') : '';
};

const steps: Array<{ name: string; state: 'done' | 'already' | 'skipped' | 'failed'; note?: string }> = [];
let failed = false;

function report(name: string, state: 'done' | 'already' | 'skipped' | 'failed', note?: string) {
	const mark = { done: '+', already: '=', skipped: '-', failed: '!' }[state];
	console.log(`  ${mark} ${name}${note ? ` — ${note}` : ''}`);
	steps.push({ name, state, note });
	if (state === 'failed') failed = true;
}

function heading(text: string) {
	console.log(`\n${text}`);
}

/**
 * On Windows `npm` is a .cmd, which Node refuses to execFile directly (EINVAL,
 * the CVE-2024-27980 mitigation) and warns about under `shell: true` (DEP0190).
 * Going through `cmd.exe /c` avoids both.
 */
function run(command: string, args: string[], cwd = PROJECT_DIR) {
	const [binary, argv] =
		process.platform === 'win32' ? ['cmd.exe', ['/c', command, ...args]] : [command, args];
	return execFileSync(binary, argv, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
}

/* -------------------------------------------------------------------------- */
/* 1. node                                                                    */
/* -------------------------------------------------------------------------- */

function checkNode() {
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

/* -------------------------------------------------------------------------- */
/* 2. dependencies                                                            */
/* -------------------------------------------------------------------------- */

function checkDependencies() {
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

/* -------------------------------------------------------------------------- */
/* 3. .env                                                                    */
/* -------------------------------------------------------------------------- */

function envKeysInUse(): string[] {
	const providers = readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8');
	const keys = new Set<string>();
	for (const match of providers.matchAll(/api_key_env:\s*([A-Z0-9_]+)/g)) keys.add(match[1]);
	return [...keys];
}

function checkEnv() {
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

/* -------------------------------------------------------------------------- */
/* 4. port                                                                    */
/* -------------------------------------------------------------------------- */

function portIsFree(port: number) {
	return new Promise<boolean>((done) => {
		const probe = createServer();
		probe.once('error', () => done(false));
		probe.once('listening', () => probe.close(() => done(true)));
		probe.listen(port, '127.0.0.1');
	});
}

async function chooseProxyPort() {
	heading('Port');
	const settings = loadSettings();
	const requested = Number.parseInt(valueOf('port'), 10);
	const wanted = Number.isFinite(requested) && requested > 0 ? requested : settings.port;

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

	if (Number.isFinite(requested)) {
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

function writeCfgPort(port: number) {
	const text = readFileSync(CFG_FILE, 'utf8');
	writeFileSync(CFG_FILE, text.replace(/^port\s*=.*$/m, `port = ${port}`));
}

/* -------------------------------------------------------------------------- */
/* 5. pi                                                                      */
/* -------------------------------------------------------------------------- */

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

function checkPi() {
	heading('Pi CLI');
	if (has('no-pi')) {
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

/* -------------------------------------------------------------------------- */
/* 6. Pi model registry                                                       */
/* -------------------------------------------------------------------------- */

interface PiModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

function piModelsPath() {
	const home = process.env.USERPROFILE || process.env.HOME || '';
	return home ? resolve(home, '.pi/agent/models.json') : '';
}

/**
 * Build the model list from this proxy's own provider config, so it cannot
 * drift from what the proxy will actually accept. Only default variants are
 * listed — the non-default ones are still reachable by typing the full
 * `provider>model@variant` id at the API.
 */
async function modelsFromProxyConfig(port: number): Promise<PiModel[]> {
	const YAML = (await import('yaml')).default;
	const baseInterface = YAML.parse(
		readFileSync(resolve(CONFIG_DIR, 'base-ai-request-interface.yaml'), 'utf8')
	) as { model_defaults?: Record<string, Record<string, unknown>> };
	const config = YAML.parse(readFileSync(resolve(CONFIG_DIR, 'inference-providers.yaml'), 'utf8')) as {
		models?: Record<string, { label?: string; context_length?: number }>;
		providers?: Record<
			string,
			{
				label?: string;
				models?: Record<
					string,
					{
						default_variant: string;
						variants?: Record<string, Record<string, unknown>>;
					}
				>;
			}
		>;
	};

	const rows: PiModel[] = [];
	for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
		for (const [modelId, model] of Object.entries(provider.models ?? {})) {
			const variant = model.variants?.[model.default_variant] ?? {};
			const canonical = config.models?.[modelId];
			const label = canonical?.label ?? modelId;
			const tuned = baseInterface.model_defaults?.[modelId];
			rows.push({
				// The `.` form: shell-safe, and Pi reads `:` as a thinking suffix.
				id: `${providerId}.${modelId}`,
				name: `${label} via ${provider.label ?? providerId}`,
				// A provider variant that states its own limit wins; otherwise the
				// canonical model's published window, and only then a safe floor.
				reasoning:
					variant.reasoning_effort === true ||
					variant.custom_reasoning === true ||
					Boolean(tuned?.reasoning_effort),
				contextWindow: Number(variant.context_length) || Number(canonical?.context_length) || 128_000,
				maxTokens:
					Number(variant.max_completion_tokens) || Number(tuned?.max_tokens) || 32_768
			});
		}
	}
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function checkPiModels(port: number) {
	heading('Pi model registry');
	const path = piModelsPath();
	if (!path) {
		report('models.json', 'failed', 'no home directory to write into');
		return;
	}

	let document: { providers?: Record<string, Record<string, unknown>> } = {};
	if (existsSync(path)) {
		try {
			document = JSON.parse(readFileSync(path, 'utf8')) as typeof document;
		} catch {
			report('models.json', 'failed', `${path} is not valid JSON; fix or delete it and re-run`);
			return;
		}
	} else {
		mkdirSync(dirname(path), { recursive: true });
	}

	document.providers ??= {};
	const existing = document.providers[PI_PROVIDER] as { models?: PiModel[] } | undefined;
	const generated = await modelsFromProxyConfig(port);

	// Keep any hand-tuned numbers: an id already present wins over the generated
	// row. New ids get added; ids no longer in the proxy config get dropped.
	// `--refresh-models` throws that away and takes the config's word for it,
	// which is what you want after correcting a context window or a default.
	const previous = has('refresh-models')
		? new Map<string, PiModel>()
		: new Map((existing?.models ?? []).map((model) => [model.id, model]));
	const merged = generated.map((model) => previous.get(model.id) ?? model);
	const added = merged.filter((model) => !previous.has(model.id)).length;
	const removed = [...previous.keys()].filter((id) => !generated.some((m) => m.id === id)).length;

	document.providers[PI_PROVIDER] = {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		api: 'openai-completions',
		apiKey: 'local',
		authHeader: true,
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
		models: merged
	};

	const next = `${JSON.stringify(document, null, 2)}\n`;
	if (existsSync(path) && readFileSync(path, 'utf8') === next) {
		report(`provider "${PI_PROVIDER}"`, 'already', `${merged.length} models at port ${port}`);
		return;
	}
	if (existsSync(path)) {
		copyFileSync(path, `${path}.bak`);
		report('backup', 'done', `${path}.bak`);
	}
	writeFileSync(path, next);
	const others = Object.keys(document.providers).filter((key) => key !== PI_PROVIDER);
	report(
		`provider "${PI_PROVIDER}"`,
		added || removed ? 'done' : 'already',
		`${merged.length} models (+${added} −${removed}) at port ${port}` +
			(others.length ? `; left ${others.length} other provider(s) untouched` : '')
	);
}

/* -------------------------------------------------------------------------- */
/* 7. the pirun command                                                       */
/* -------------------------------------------------------------------------- */

function checkLink() {
	heading('pirun on PATH');
	if (has('no-link')) {
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

/* -------------------------------------------------------------------------- */
/* 8. verify                                                                  */
/* -------------------------------------------------------------------------- */

async function verify(port: number) {
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

	if (has('smoke')) {
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

/* -------------------------------------------------------------------------- */
/* uninstall                                                                  */
/* -------------------------------------------------------------------------- */

function uninstall() {
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

/* -------------------------------------------------------------------------- */

function describe(error: unknown) {
	if (error instanceof Error) {
		const stderr = (error as Error & { stderr?: string }).stderr;
		return (stderr?.trim().split('\n').pop() || error.message).slice(0, 200);
	}
	return String(error).slice(0, 200);
}

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
const port = await chooseProxyPort();
checkPi();
await checkPiModels(port);
checkLink();
await verify(port);

heading('Summary');
const counts = steps.reduce<Record<string, number>>((totals, step) => {
	totals[step.state] = (totals[step.state] ?? 0) + 1;
	return totals;
}, {});
console.log(
	`  ${counts.done ?? 0} changed · ${counts.already ?? 0} already in place · ` +
		`${counts.skipped ?? 0} skipped · ${counts.failed ?? 0} failed`
);

if (failed) {
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
