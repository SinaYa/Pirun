#!/usr/bin/env node

let task = '';
for await (const chunk of process.stdin) task += chunk;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sessionArg = process.argv.findIndex((arg) => ['--session-id', '--session'].includes(arg));
const sessionId = sessionArg >= 0 ? process.argv[sessionArg + 1] : `fake-${process.pid}`;

emit({ type: 'session', id: sessionId });
emit({ type: 'agent_start' });
emit({ type: 'turn_start' });
emit({ type: 'message_start', message: { role: 'assistant', content: [] } });

if (task.includes('FAKE_HANG')) {
	await sleep(10_000);
} else if (task.includes('FAKE_SLOW')) {
	for (let index = 0; index < 20; index += 1) {
		emit({
			type: 'message_update',
			assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning token stream ' }
		});
		await sleep(100);
	}
} else {
	await sleep(50);
}

if (task.includes('FAKE_TOOL_FAILURE')) {
	const toolCallId = `fake-tool-${process.pid}`;
	emit({
		type: 'message_end',
		message: {
			role: 'assistant',
			content: [{ type: 'toolCall', id: toolCallId, name: 'fakeTool', arguments: { path: 'fixture.txt' } }],
			stopReason: 'toolUse',
			usage: { input: 1, cacheRead: 0, output: 1, cost: { total: 0 } }
		}
	});
	emit({ type: 'turn_end', toolResults: [{ toolCallId, isError: true }] });
}

const text = 'FAKE_READY';
emit({
	type: 'message_update',
	assistantMessageEvent: { type: 'text_delta', delta: text }
});
emit({
	type: 'message_end',
	message: {
		role: 'assistant',
		content: [{ type: 'text', text }],
		stopReason: 'stop',
		usage: { input: 10, cacheRead: 2, output: 64, cost: { total: 0 } }
	}
});
emit({ type: 'turn_end', toolResults: [] });
emit({ type: 'agent_end' });
