import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	benchmarkModel,
	SPEED_TEST_MODELS,
	SPEED_TEST_PROMPT,
	withoutGeneratedText
} from '../src/speed-benchmark.ts';

function streamResponse(events: unknown[]) {
	const text = events
		.map((event) => (event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`))
		.join('');
	return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('the benchmark is frozen to the requested prompt and configured models', () => {
	assert.equal(
		SPEED_TEST_PROMPT,
		'Write the complete text of Abraham Lincoln’s Second Inaugural Address of March 4, 1865. Do not include anything else in your output.'
	);
	assert.deepEqual(
		SPEED_TEST_MODELS.map((model) => model.id),
		['commandcode>ox-alpha', 'commandcode>muse-spark-1.2', 'commandcode>qwen3.7-flash']
	);
});

test('reasoning and final timing/token metrics are measured separately', async () => {
	const times = [0, 100, 200, 500, 1000, 1100];
	const sample = await benchmarkModel({
		baseUrl: 'http://proxy.test',
		model: 'commandcode>ox-alpha',
		label: 'Ox Alpha',
		now: () => times.shift() ?? 1100,
		fetchImpl: async () =>
			streamResponse([
				{
					choices: [{ delta: { reasoning_content: 'I should recall the address.' }, finish_reason: null }]
				},
				{
					choices: [{ delta: { content: 'Fellow-Countrymen:' }, finish_reason: null }]
				},
				{
					choices: [{ delta: {}, finish_reason: 'stop' }],
					usage: { completion_tokens: 17 }
				},
				'[DONE]'
			])
	});

	assert.equal(sample.status, 'ok');
	assert.equal(sample.reasoning.first_token_ms, 200);
	assert.equal(sample.reasoning.decode_duration_ms, 300);
	assert.equal(sample.final.first_token_ms, 500);
	assert.equal(sample.final.decode_duration_ms, 600);
	assert.equal(sample.total_duration_ms, 1100);
	assert.ok(sample.reasoning.tokens > 0);
	assert.ok(sample.final.tokens > 0);
	assert.equal(sample.provider_output_tokens, 17);
	assert.equal(sample.observed_output_tokens, sample.reasoning.tokens + sample.final.tokens);
	assert.equal(
		sample.unattributed_provider_tokens,
		17 - sample.reasoning.tokens - sample.final.tokens
	);
	assert.equal('reasoning_text' in withoutGeneratedText(sample), false);
	assert.equal('final_text' in withoutGeneratedText(sample), false);
});

test('stream errors retain partial phase measurements', async () => {
	const times = [0, 50, 100, 150];
	const sample = await benchmarkModel({
		baseUrl: 'http://proxy.test',
		model: 'commandcode>muse-spark-1.2',
		label: 'Muse Contributor',
		now: () => times.shift() ?? 150,
		fetchImpl: async () =>
			streamResponse([
				{ choices: [{ delta: { reasoning_content: 'partial' }, finish_reason: null }] },
				{ error: { message: 'terminated' } }
			])
	});

	assert.equal(sample.status, 'failed');
	assert.equal(sample.error, 'terminated');
	assert.ok(sample.reasoning.tokens > 0);
	assert.equal(sample.final.tokens, 0);
});
