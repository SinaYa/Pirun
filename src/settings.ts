import { readFileSync } from 'node:fs';
import { CFG_FILE } from './paths.ts';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.ts';

export interface ProxySettings {
	port: number;
	host: string;
	defaultProvider: string;
	defaultModel: string;
	apiKey: string;
	requestTimeoutMs: number;
	logLevel: 'silent' | 'error' | 'info' | 'debug';
	hotReloadRouting: boolean;
	exposeRoutingEndpoint: boolean;
	sourcePath: string;
}

const DEFAULTS: Omit<ProxySettings, 'sourcePath'> = {
	port: 8787,
	host: '127.0.0.1',
	defaultProvider: 'commandcode',
	defaultModel: 'deepseek-v4-pro',
	apiKey: '',
	requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
	logLevel: 'info',
	hotReloadRouting: true,
	exposeRoutingEndpoint: true
};

function parseCfg(text: string) {
	const values = new Map<string, string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.split('#')[0].trim();
		if (!line) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
	}
	return values;
}

function readBoolean(raw: string | undefined, fallback: boolean) {
	if (raw === undefined || raw === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function readInteger(raw: string | undefined, fallback: number) {
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadSettings(path = CFG_FILE): ProxySettings {
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const cfg = parseCfg(text);
	const logLevel = (cfg.get('log_level') || DEFAULTS.logLevel).toLowerCase();

	return {
		port: readInteger(cfg.get('port'), DEFAULTS.port),
		host: cfg.get('host') || DEFAULTS.host,
		defaultProvider: cfg.get('default_provider') || DEFAULTS.defaultProvider,
		defaultModel: cfg.get('default_model') || DEFAULTS.defaultModel,
		apiKey: cfg.get('api_key') ?? DEFAULTS.apiKey,
		requestTimeoutMs: readInteger(cfg.get('request_timeout_ms'), DEFAULTS.requestTimeoutMs),
		logLevel: (['silent', 'error', 'info', 'debug'].includes(logLevel)
			? logLevel
			: DEFAULTS.logLevel) as ProxySettings['logLevel'],
		hotReloadRouting: readBoolean(cfg.get('hot_reload_routing'), DEFAULTS.hotReloadRouting),
		exposeRoutingEndpoint: readBoolean(
			cfg.get('expose_routing_endpoint'),
			DEFAULTS.exposeRoutingEndpoint
		),
		sourcePath: path
	};
}
