export interface PirunArgs {
	command: string;
	positional: string[];
	flags: Map<string, string | true>;
}

const RUN_FLAGS = new Set([
	'file',
	'task',
	'time'
]);

/** Settings accepted by every preset command and persisted into its preset. */
const PRESET_FLAGS = new Set([
	'use',
	'harness',
	'model',
	'effort',
	'antigravity-agent',
	'prefix',
	'prefix-file',
	'no-prefix',
	'dir',
	'tools',
	'no-tools',
	'context-files',
	'no-context-files',
	'full',
	'no-full',
	'json',
	'no-json'
]);

/** Commands that address the shared provider store, not a preset. */
export const PROVIDER_COMMANDS = new Set(['providers', 'provider', 'spend', 'login', 'logout']);

const PROVIDER_FLAGS = new Set([
	'base-url',
	'env',
	'key',
	'auth-header',
	'no-auth-header',
	'developer-role',
	'no-developer-role',
	'reasoning-effort',
	'no-reasoning-effort',
	'reasoning',
	'no-reasoning',
	'context-window',
	'max-tokens',
	'json'
]);

const ALLOWED_FLAGS: Record<string, Set<string>> = {
	run: RUN_FLAGS,
	agent: RUN_FLAGS,
	fork: RUN_FLAGS,
	start: RUN_FLAGS,
	wait: new Set(['time', 'full', 'json']),
	poll: new Set(['full', 'json']),
	agents: new Set(['json']),
	retire: new Set(['all']),
	clean: new Set(['all', 'sessions']),
	log: new Set(['grep']),
	models: new Set(['json', 'refresh']),
	model: new Set(),
	jobs: new Set(),
	kill: new Set(),
	time: new Set(),
	status: new Set(),
	login: new Set(['inline', 'login-window']),
	logout: new Set(),
	providers: new Set(['json']),
	provider: PROVIDER_FLAGS,
	spend: new Set(['json']),
	config: new Set(),
	up: new Set(),
	down: new Set(),
	restart: new Set(),
	help: new Set(),
	'--help': new Set(),
	'-h': new Set()
};

const VALUED_FLAGS = new Set([
	'use',
	'harness',
	'model',
	'effort',
	'antigravity-agent',
	'prefix',
	'prefix-file',
	'dir',
	'file',
	'task',
	'time',
	'grep',
	'base-url',
	'env',
	'key',
	'context-window',
	'max-tokens'
]);

/**
 * Options that existed in v1 and moved. A targeted rejection is the fastest
 * possible recovery for a caller still speaking the old grammar.
 */
const MOVED_FLAGS: Record<string, string> = {
	timeout: 'timers are one required option now: --time <return-after>/<timeout>, e.g. --time 10m/2h',
	'return-after': 'timers are one required option now: --time <return-after>/<timeout>, e.g. --time 10m/2h',
	'api-base-url': 'endpoints live in the shared provider store now: pirun provider add <name> --base-url <url>, then --use <name>',
	'api-key': 'api keys live in the shared provider store now: pirun provider key <provider> <account> --key <value>, then --use <provider>/<account>',
	'api-key-env': 'api keys live in the shared provider store now: pirun provider key <provider> <account> --env <VAR>, then --use <provider>/<account>',
	'bundled-proxy': 'select the bundled proxy with --use bundled',
	'auth-header': 'API compatibility moved to the provider: pirun provider set <name> --auth-header',
	'no-auth-header': 'API compatibility moved to the provider: pirun provider set <name> --no-auth-header',
	'developer-role': 'API compatibility moved to the provider: pirun provider set <name> --developer-role',
	'no-developer-role': 'API compatibility moved to the provider: pirun provider set <name> --no-developer-role',
	'reasoning-effort': 'API compatibility moved to the provider: pirun provider set <name> --reasoning-effort',
	'no-reasoning-effort': 'API compatibility moved to the provider: pirun provider set <name> --no-reasoning-effort',
	reasoning: 'model reasoning moved to the catalog: pirun provider model <provider> <model> --reasoning; pick strength with --effort',
	'no-reasoning': 'model reasoning moved to the catalog: pirun provider model <provider> <model> --no-reasoning',
	'context-window': 'model limits moved to the catalog: pirun provider model <provider> <model> --context-window <n>',
	'max-tokens': 'model limits moved to the catalog: pirun provider model <provider> <model> --max-tokens <n>'
};

/** Strict parsing prevents a typo from silently changing how an agent run behaves. */
export function parsePirunArgs(argv: string[]): PirunArgs {
	const command = argv[0] ?? 'help';
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const allowed = ALLOWED_FLAGS[command];
	let positionalOnly = false;

	// speedtest owns its richer option grammar. Its first positional token is
	// still Pirun's preset; every token after that is forwarded unchanged.
	const validate = command !== 'speedtest';
	if (!validate) {
		return { command, positional: argv.slice(1), flags };
	}
	if (validate && !allowed) return { command, positional: argv.slice(1), flags };

	const presetFlagsApply = !PROVIDER_COMMANDS.has(command);
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index];
		if (positionalOnly || token === '-' || !token.startsWith('--')) {
			positional.push(token);
			continue;
		}
		if (token === '--') {
			positionalOnly = true;
			continue;
		}

		const raw = token.slice(2);
		const at = raw.indexOf('=');
		const name = at === -1 ? raw : raw.slice(0, at);
		if (validate && !allowed?.has(name) && !(presetFlagsApply && PRESET_FLAGS.has(name))) {
			if (presetFlagsApply && MOVED_FLAGS[name]) {
				throw new Error(`option "--${name}" moved: ${MOVED_FLAGS[name]}`);
			}
			throw new Error(`unknown option "--${name}" for "${command}"`);
		}

		if (VALUED_FLAGS.has(name)) {
			const value = at === -1 ? argv[index + 1] : raw.slice(at + 1);
			if (value === undefined || (at === -1 && value.startsWith('--'))) {
				throw new Error(`option "--${name}" requires a value`);
			}
			if (at === -1) index += 1;
			flags.set(name, value);
			continue;
		}

		if (at !== -1) throw new Error(`option "--${name}" does not take a value`);
		flags.set(name, true);
	}

	return { command, positional, flags };
}

export function flagString(args: PirunArgs, name: string, fallback = '') {
	const value = args.flags.get(name);
	return typeof value === 'string' ? value : fallback;
}
