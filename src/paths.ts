import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Project root: pirun/ — code only; durable state lives in pirunStateRoot(). */
export const PROJECT_DIR = resolve(HERE, '..');

/** Optional API keys for endpoint providers, loaded into the environment. */
export const ENV_FILE = resolve(PROJECT_DIR, '.env');

/**
 * The machine-global Pirun state home (presets, runs, profiles, keep-alive
 * bookkeeping). Never inside the repo: a clone must be replaceable without
 * losing state, and "don't touch the tool's folder" must stay reasonable.
 */
export function pirunStateRoot() {
	if (process.env.PIRUN_STATE_DIR) return resolve(process.env.PIRUN_STATE_DIR);
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		return resolve(process.env.LOCALAPPDATA, 'Pirun');
	}
	if (process.env.XDG_STATE_HOME) return resolve(process.env.XDG_STATE_HOME, 'pirun');
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) throw new Error('No user state directory is available for Pirun state.');
	return resolve(home, '.local', 'state', 'pirun');
}
