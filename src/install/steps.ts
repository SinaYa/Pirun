/** The installer's individual steps. Each checks before it acts; all re-runnable. */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENV_FILE, PROJECT_DIR } from '../paths.ts';
import { describe, heading, report, run } from './report.ts';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
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

	const required = ['gpt-tokenizer'];
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
	const linked = root && existsSync(resolve(root, 'pirun'));
	try {
		run('npm', ['link']);
		report('npm link', linked ? 'already' : 'done', 'run `pirun providers` from any directory');
	} catch (error) {
		report('npm link', 'failed', `${describe(error)} — fall back to: node ${resolve(PROJECT_DIR, 'bin/pirun.ts')}`);
	}
}

function piModelsPath() {
	const home = process.env.USERPROFILE || process.env.HOME || '';
	return home ? resolve(home, '.pi/agent/models.json') : '';
}

export function uninstall() {
	heading('Uninstall');
	try {
		run('npm', ['unlink', '-g', 'pirun']);
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
			// Only the providers pirun itself registered for endpoint presets.
			const managedProviders = Object.keys(document.providers ?? {}).filter((id) =>
				/^pirun-.*-[a-f0-9]{8}$/.test(id)
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
