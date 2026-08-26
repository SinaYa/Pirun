import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Project root: pirun/ */
export const PROJECT_DIR = resolve(HERE, '..');

/** Optional API keys for endpoint providers, loaded into the environment. */
export const ENV_FILE = resolve(PROJECT_DIR, '.env');
