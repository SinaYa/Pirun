import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getModelDefaults, resolveInferenceProviderRequest } from '../src/inference-provider-config.ts';

test('Qwen 3.7 Flash resolves to the exact Command Code model and tuned defaults', () => {
	const resolution = resolveInferenceProviderRequest({
		providerId: 'commandcode',
		model: 'qwen3.7-flash',
		values: {
			messages: [{ role: 'user', content: 'test' }],
			stream: true
		}
	});

	assert.equal(resolution.providerModel, 'Qwen/Qwen3.7-Flash');
	assert.equal(resolution.requestBody.model, 'Qwen/Qwen3.7-Flash');
	assert.equal(resolution.requestBody.temperature, 0.6);
	assert.equal(resolution.requestBody.top_p, 0.95);
	assert.equal(resolution.requestBody.max_tokens, 65536);
	assert.equal(resolution.requestBody.reasoning_effort, undefined);
	assert.deepEqual(getModelDefaults('qwen3.7-flash'), {
		source: 'qwen3.7-thinking-api-defaults',
		temperature: 0.6,
		top_p: 0.95,
		max_tokens: 65536
	});
});
