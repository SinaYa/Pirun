import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

process.env.PIRUN_PROVIDERS_PATH = resolve(tmpdir(), 'pirun-render-test-providers.json');
process.env.PIRUN_RUNS_DIR = resolve(tmpdir(), 'pirun-render-test-runs');
const { emit, renderDigest } = await import('../src/cli/render.ts');
const { emptyDigest } = await import('../src/cli/digest.ts');

// Offline: renderDigest is pure formatting over meta + digest; capture stdout.

function captured(run: () => void) {
	const lines: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
	} finally {
		process.stdout.write = original;
	}
	return lines.join('');
}

const meta = {
	id: 'ab12cd',
	preset: 'demo',
	harness: 'antigravity' as const,
	model: 'auto',
	cwd: tmpdir(),
	task: 'probe',
	tools: true,
	startedAt: Date.now() - 1000,
	finishedAt: Date.now(),
	exitCode: 0,
	timeoutSec: 60,
	returnAfterSec: 10
};

test('a clipped answer carries the truncation note before the excerpt, with exact bytes', () => {
	const digest = { ...emptyDigest(), status: 'ok', text: 'x'.repeat(7900) };
	const text = captured(() => renderDigest(meta, digest, { full: false }));
	// 7900 ascii chars + the trailing newline --answer appends = 7901 bytes,
	// and the note precedes the --- excerpt so a top-down reader sees it first.
	assert.match(text, /note: answer truncated below — full 7901 bytes: pirun poll demo ab12cd --answer\n---\n/);

	// --full prints everything and must not warn.
	const full = captured(() => renderDigest(meta, digest, { full: true }));
	assert.ok(full.includes('x'.repeat(7900)));
	assert.ok(!full.includes('answer truncated'));

	// Short answers are complete as printed; no note.
	const short = captured(() =>
		renderDigest(meta, { ...emptyDigest(), status: 'ok', text: 'done' }, { full: false })
	);
	assert.ok(!short.includes('answer truncated'));
});

test('--answer emits the response text alone, complete and verbatim', () => {
	const digest = { ...emptyDigest(), status: 'ok', text: `line one\n${'y'.repeat(6000)}\n---\nline after separator` };
	const answerArgs = { command: 'poll', positional: [], flags: new Map([['answer', true]]) };
	const text = captured(() => emit(meta, digest, answerArgs));
	// Exactly the answer plus the trailing newline out() appends — no header,
	// no cap, no truncation note, embedded --- lines untouched.
	assert.equal(text, `${digest.text}\n`);
});

test('a --no-tools run prints the tools-disabled proof line', () => {
	const digest = { ...emptyDigest(), status: 'ok', text: 'OK' };
	const text = captured(() => renderDigest({ ...meta, tools: false }, digest, { full: false }));
	assert.ok(text.includes('tools: none (disabled with --no-tools)'));
	// With tools enabled but unused, no proof is claimed.
	const enabled = captured(() => renderDigest(meta, digest, { full: false }));
	assert.ok(!enabled.includes('tools: none'));
});
