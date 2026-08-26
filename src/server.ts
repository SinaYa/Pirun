/** Proxy entry point: the HTTP router. The handlers live in src/proxy/. */

import { createServer } from 'node:http';
import { envSnapshot, loadEnvFile, refreshEnvFile } from './env.ts';
import { CONFIG_DIR, ENV_FILE, PROJECT_DIR } from './paths.ts';
import {
	authorized,
	log,
	normalizePath,
	readBody,
	sendError,
	sendJson,
	setCors,
	settings
} from './proxy/http.ts';
import {
	handleChatCompletions,
	handleRouting,
	handleTextCompletions,
	listModels,
	primeRouting
} from './proxy/handlers.ts';

// Keep the public import surface stable for tooling and tests.
export { parseRequestTarget, type RequestTarget } from './proxy/shape.ts';

const envInfo = loadEnvFile();
// Prime the change-detection signature so the first request does not report a
// reload it did not perform.
refreshEnvFile();

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
	const path = normalizePath(url.pathname);

	if (request.method === 'OPTIONS') {
		setCors(response);
		response.statusCode = 204;
		response.end();
		return;
	}

	if (path === '/health' || path === '/') {
		sendJson(response, 200, {
			status: 'ok',
			service: 'completions-proxy',
			port: settings.port,
			default_provider: settings.defaultProvider,
			default_model: settings.defaultModel,
			config_dir: CONFIG_DIR,
			cfg: settings.sourcePath,
			env_file_loaded: envInfo.loaded,
			env_keys: envInfo.keys,
			// Fingerprints, never values: enough to tell a running process's key
			// from the one on disk, which is the whole question when a rotated
			// key appears not to have taken.
			env_key_details: envSnapshot().details,
			env_loaded_at: envSnapshot().loadedAt,
			auth_required: Boolean(settings.apiKey)
		});
		return;
	}

	if (!authorized(request)) {
		sendError(response, 401, 'Invalid or missing Authorization bearer token.');
		return;
	}

	if (request.method === 'GET' && path === '/models') {
		sendJson(response, 200, listModels());
		return;
	}

	if (request.method === 'GET' && path === '/routing') {
		if (!settings.exposeRoutingEndpoint) {
			sendError(response, 404, 'Routing endpoint is disabled in proxy.cfg.');
			return;
		}
		await handleRouting(response, url);
		return;
	}

	// Lets a supervisor (pirun) stop a proxy it did not start. Localhost-bound by
	// default, and behind the bearer token whenever one is configured.
	if (request.method === 'POST' && path === '/shutdown') {
		sendJson(response, 200, { status: 'stopping' });
		log('info', 'shutdown requested');
		setTimeout(() => {
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 1000).unref();
		}, 50);
		return;
	}

	if (request.method !== 'POST') {
		sendError(response, 404, `No route for ${request.method} ${url.pathname}.`);
		return;
	}

	let body: Record<string, unknown>;
	try {
		const raw = await readBody(request);
		body = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
	} catch (error) {
		sendError(response, 400, 'Request body must be valid JSON.', String(error));
		return;
	}

	if (path === '/chat/completions') {
		await handleChatCompletions(request, response, body);
		return;
	}
	if (path === '/completions') {
		await handleTextCompletions(request, response, body);
		return;
	}

	sendError(response, 404, `No route for ${request.method} ${url.pathname}.`);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 75_000;

server.listen(settings.port, settings.host, async () => {
	const refreshed = await primeRouting();
	console.log('completions-proxy');
	console.log(`  root      ${PROJECT_DIR}`);
	console.log(`  listening http://${settings.host}:${settings.port}`);
	console.log(`  base url  http://${settings.host}:${settings.port}/v1`);
	console.log(`  config    ${settings.sourcePath}`);
	console.log(`  routing   ${refreshed.snapshot.sourcePath} (${refreshed.snapshot.ruleCount} rules, ${refreshed.snapshot.groupCount} groups)`);
	if (refreshed.error) console.log(`  routing!  ${refreshed.error}`);
	console.log(`  env       ${envInfo.loaded ? `${envInfo.count} keys from ${ENV_FILE}` : 'no .env found'}`);
	console.log(`  default   ${settings.defaultProvider}>${settings.defaultModel}`);
	console.log(`  auth      ${settings.apiKey ? 'bearer token required' : 'open (no api_key set)'}`);
});

server.on('error', (error) => {
	console.error(`completions-proxy failed to start: ${error.message}`);
	process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref();
	});
}
