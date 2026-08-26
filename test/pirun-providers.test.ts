import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	antigravityEffortLevel,
	accountEnvVar,
	endpointEnvVar,
	parseEffortIntent,
	piThinkingLevel,
	resolveEndpointModel,
	resolveUse,
	type ProvidersStore
} from '../src/pirun-providers.ts';
import { migratePresetsToProviders, type PirunConfig } from '../src/pirun-config.ts';

// Offline only: these tests exercise store logic, env detection, and mapping.

function emptyStore(): ProvidersStore {
	return { version: 1, endpoints: {}, harnesses: {} };
}

test('canonical env vars and the per-account suffix convention', () => {
	assert.equal(endpointEnvVar('deepseek'), 'DEEPSEEK_API_KEY');
	assert.equal(endpointEnvVar('my-api'), 'MY_API_API_KEY');
	assert.equal(accountEnvVar('deepseek', 'work'), 'DEEPSEEK_API_KEY_WORK');
});

test('--use auto-creates the first account from the standard env var', () => {
	const store = emptyStore();
	process.env.DEEPSEEK_API_KEY = 'sk-test';
	try {
		const resolved = resolveUse(store, 'deepseek');
		assert.deepEqual(resolved, { kind: 'endpoint', provider: 'deepseek', account: 'main', created: true });
		assert.equal(store.endpoints.deepseek.accounts.main.key, '$DEEPSEEK_API_KEY');
	} finally {
		delete process.env.DEEPSEEK_API_KEY;
	}
});

test('--use provider/name auto-creates from the suffix convention', () => {
	const store = emptyStore();
	process.env.DEEPSEEK_API_KEY_WORK = 'sk-work';
	try {
		const resolved = resolveUse(store, 'deepseek/work');
		assert.equal(resolved.created, true);
		assert.equal(store.endpoints.deepseek.accounts.work.key, '$DEEPSEEK_API_KEY_WORK');
	} finally {
		delete process.env.DEEPSEEK_API_KEY_WORK;
	}
});

test('--use errors name the exact fixing command', () => {
	assert.throws(() => resolveUse(emptyStore(), 'deepseek/nope'), /pirun provider key deepseek nope/);
	assert.throws(() => resolveUse(emptyStore(), 'antigravity'), /pirun login antigravity/);
	assert.throws(() => resolveUse(emptyStore(), 'not-a-thing'), /pirun provider add not-a-thing/);
});

test('harness accounts resolve by name and default to the only account', () => {
	const store = emptyStore();
	store.harnesses.antigravity = { accounts: { luigi: {} } };
	assert.deepEqual(resolveUse(store, 'antigravity'), {
		kind: 'harness', provider: 'antigravity', account: 'luigi', created: false
	});
	const created = resolveUse(store, 'antigravity/second');
	assert.equal(created.created, true);
	assert.ok(store.harnesses.antigravity.accounts.second);
});

test('effort intent maps to Pi thinking levels and Antigravity tiers', () => {
	assert.equal(piThinkingLevel(parseEffortIntent('min')), 'minimal');
	assert.equal(piThinkingLevel(parseEffortIntent('high')), 'high');
	assert.equal(piThinkingLevel(parseEffortIntent('16k')), 'medium');
	assert.equal(piThinkingLevel(parseEffortIntent('64k')), 'xhigh');
	assert.equal(antigravityEffortLevel(parseEffortIntent('max')), 'high');
	assert.equal(antigravityEffortLevel(parseEffortIntent('off')), 'low');
	assert.equal(antigravityEffortLevel(parseEffortIntent('16k')), 'medium');
	assert.throws(() => parseEffortIntent('extreme'), /--effort must be/);
});

test('model fragments resolve against the catalog, unknown ids pass through', () => {
	const store = emptyStore();
	assert.equal(resolveEndpointModel(store, 'deepseek', 'reason'), 'deepseek-reasoner');
	assert.equal(resolveEndpointModel(store, 'deepseek', 'brand-new-model'), 'brand-new-model');
	assert.throws(() => resolveEndpointModel(store, 'deepseek', 'deepseek'), /matches 2 deepseek models/);
});

test('v1 presets migrate into the shared store without losing authentication', () => {
	const config = {
		version: 2,
		presets: {
			'antigravity-one': {
				use: '', harness: 'antigravity', model: 'auto', tools: true, contextFiles: true,
				full: false, json: false, antigravity: { effort: 'high' }
			},
			openai: {
				use: '', harness: 'pi', model: 'gpt-5.2', tools: true, contextFiles: true,
				full: false, json: false,
				api: { baseUrl: 'https://api.openai.com/v1', apiKey: '$OPENAI_API_KEY', reasoning: true }
			},
			local: {
				use: '', harness: 'pi', model: 'cladgpt-proxy/x', tools: true, contextFiles: true,
				full: false, json: false
			}
		}
	} as unknown as PirunConfig;
	const store = emptyStore();
	const result = migratePresetsToProviders(config, store);
	assert.equal(result.configChanged, true);
	assert.equal(result.storeChanged, true);
	assert.equal(config.presets['antigravity-one'].use, 'antigravity/antigravity-one');
	assert.equal(config.presets['antigravity-one'].effort, 'high');
	assert.equal(config.presets['antigravity-one'].antigravity, undefined);
	assert.ok(store.harnesses.antigravity.accounts['antigravity-one']);
	assert.equal(config.presets.openai.use, 'openai/main');
	assert.equal(config.presets.openai.api, undefined);
	assert.equal(store.endpoints.openai.accounts.main.key, '$OPENAI_API_KEY');
	assert.equal(config.presets.local.use, 'bundled');
	// A second pass changes nothing further.
	const again = migratePresetsToProviders(config, store);
	assert.equal(again.configChanged, false);
	assert.equal(again.storeChanged, false);
});
