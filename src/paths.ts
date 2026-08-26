import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Sub-project root: completions-proxy/ */
export const PROJECT_DIR = resolve(HERE, '..');

/** Routing + model definition configuration, private to this sub-project. */
export const CONFIG_DIR = resolve(PROJECT_DIR, 'config');

/** Basic runtime configuration (port, host, defaults). */
export const CFG_FILE = resolve(PROJECT_DIR, 'proxy.cfg');

/** API keys, copied verbatim from the parent project. */
export const ENV_FILE = resolve(PROJECT_DIR, '.env');
