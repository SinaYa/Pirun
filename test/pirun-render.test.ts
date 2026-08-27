import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

process.env.PIRUN_PROVIDERS_PATH = resolve(tmpdir(), 'pirun-render-test-providers.json');
process.env.PIRUN_RUNS_DIR = resolve(tmpdir(), 'pirun-render-test-runs');
const { renderDigest } = await import('../src/cli/render.ts');
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

test('a clipped answer always carries the truncation note with the exact --full command', () => {
	const digest = { ...emptyDigest(), status: 'ok', text: 'x'.repeat(7900) };
	const text = captured(() => renderDigest(meta, digest, { full: false }));
	assert.match(text, /…\nnote: answer truncated \(7900 chars\) — full: pirun poll demo ab12cd --full/);

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

test('a --no-tools run prints the tools-disabled proof line', () => {
	const digest = { ...emptyDigest(), status: 'ok', text: 'OK' };
	const text = captured(() => renderDigest({ ...meta, tools: false }, digest, { full: false }));
	assert.ok(text.includes('tools: none (disabled with --no-tools)'));
	// With tools enabled but unused, no proof is claimed.
	const enabled = captured(() => renderDigest(meta, digest, { full: false }));
	assert.ok(!enabled.includes('tools: none'));
});
