import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { __commandCodeAdapterTest as adapter } from '../src/command-code-cli-adapter.ts';

function eventResponse(events: Array<Record<string, unknown>>, status = 200) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
		status,
		headers: { 'Content-Type': 'text/event-stream' }
	});
}

function fakeRun(
	response: Response,
	transportTemplate: { apiKeyFingerprint: string; headers: Record<string, string>; envelope: Record<string, unknown> } | null = null
) {
	let cleanupCalls = 0;
	let cleaned = false;
	return {
		response,
		child: null,
		transportTemplate,
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			cleanupCalls += 1;
		},
		get cleanupCalls() {
			return cleanupCalls;
		}
	};
}

const body = { model: 'stealth/ox-alpha', messages: [{ role: 'user', content: 'test' }] };

afterEach(() => {
	delete process.env.COMMANDCODE_ADAPTER_RETRIES;
	adapter.setWarmTransportTemplate(null);
});

test('a pre-output stream error invalidates the warm transport and retries', async () => {
	process.env.COMMANDCODE_ADAPTER_RETRIES = '1';
	const template = { apiKeyFingerprint: 'key', headers: {}, envelope: {} };
	adapter.setWarmTransportTemplate(template);
	const first = fakeRun(eventResponse([{ type: 'error', error: { message: 'terminated' } }]), template);
	const second = fakeRun(
		eventResponse([
			{ type: 'text-delta', delta: 'READY' },
			{ type: 'finish', finishReason: 'stop' }
		])
	);
	let starts = 0;
	const result = await adapter.collectInternalResponseWithRetries(
		first,
		body,
		'test-key',
		undefined,
		async () => {
			starts += 1;
			return second;
		}
	);

	assert.equal(result.content, 'READY');
	assert.equal(starts, 1);
	assert.equal(first.cleanupCalls, 1);
	assert.equal(second.cleanupCalls, 1);
	assert.equal(adapter.getWarmTransportTemplate(), null);
});

test('a warm transport fetch failure invalidates the cached template', async () => {
	const template = { apiKeyFingerprint: 'key', headers: {}, envelope: {} };
	adapter.setWarmTransportTemplate(template);
	let releases = 0;

	await assert.rejects(
		adapter.startWarmAdapterRun(
			template,
			body,
			undefined,
			() => {
				releases += 1;
			},
			async () => {
				throw new Error('socket closed');
			}
		),
		/socket closed/
	);
	assert.equal(adapter.getWarmTransportTemplate(), null);
	assert.equal(releases, 1);
});

test('streaming retries before output becomes visible', async () => {
	process.env.COMMANDCODE_ADAPTER_RETRIES = '1';
	const first = fakeRun(eventResponse([{ type: 'error', error: 'terminated' }]));
	const second = fakeRun(
		eventResponse([
			{ type: 'text-delta', delta: 'READY' },
			{ type: 'finish', finishReason: 'stop' }
		])
	);
	let starts = 0;
	const stream = adapter.openAiStream(
		first,
		body,
		'test-key',
		new AbortController().signal,
		body.model,
		async () => {
			starts += 1;
			return second;
		}
	);
	const output = await new Response(stream).text();

	assert.equal(starts, 1);
	assert.match(output, /READY/);
	assert.doesNotMatch(output, /terminated/);
	assert.match(output, /\[DONE\]/);
});

test('streaming never replays after output has become visible', async () => {
	process.env.COMMANDCODE_ADAPTER_RETRIES = '1';
	const first = fakeRun(
		eventResponse([
			{ type: 'text-delta', delta: 'partial' },
			{ type: 'error', error: { message: 'terminated after output' } }
		])
	);
	let starts = 0;
	const stream = adapter.openAiStream(
		first,
		body,
		'test-key',
		new AbortController().signal,
		body.model,
		async () => {
			starts += 1;
			throw new Error('must not retry');
		}
	);
	const output = await new Response(stream).text();

	assert.equal(starts, 0);
	assert.match(output, /partial/);
	assert.match(output, /terminated after output/);
	assert.match(output, /Please retry your request/);
	assert.match(output, /upstream_retryable_error/);
});

test('terminal transient stream errors activate Pi retry classification', () => {
	const payload = adapter.streamErrorPayload(
		new Error('Service temporarily unavailable. Please try again shortly.')
	);

	assert.equal(payload.error.code, 'upstream_retryable_error');
	assert.match(payload.error.message, /Retryable upstream server error/);
	assert.match(payload.error.message, /Please retry your request/);
	assert.match(payload.error.message, /Service temporarily unavailable/);
});

test('terminal authentication errors are not mislabeled as retryable', () => {
	const payload = adapter.streamErrorPayload(new Error('Invalid API key'));

	assert.equal(payload.error.code, 'adapter_stream_error');
	assert.equal(payload.error.message, 'Invalid API key');
});

test('non-OK responses preserve the upstream status and message', async () => {
	process.env.COMMANDCODE_ADAPTER_RETRIES = '0';
	const run = fakeRun(
		new Response(JSON.stringify({ error: { message: 'provider terminated the request' } }), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		})
	);

	await assert.rejects(
		adapter.collectInternalResponseWithRetries(run, body, 'test-key'),
		/Command Code request failed \(502\): provider terminated the request/
	);
});
