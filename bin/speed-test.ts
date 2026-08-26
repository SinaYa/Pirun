#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadSettings } from '../src/settings.ts';
import { PROJECT_DIR } from '../src/paths.ts';
import {
	benchmarkModel,
	SPEED_TEST_MODELS,
	SPEED_TEST_PROMPT,
	type SpeedSample,
	withoutGeneratedText
} from '../src/speed-benchmark.ts';

interface CliOptions {
	runs: number;
	model: 'all' | 'ox' | 'muse' | 'qwen';
	prime: boolean;
	json: boolean;
}

function fail(message: string): never {
	throw new Error(message);
}

function parsePositiveInteger(value: string | undefined, name: string) {
	const parsed = Number.parseInt(value ?? '', 10);
	if (!Number.isFinite(parsed) || parsed < 1) fail(`${name} must be a positive integer.`);
	return parsed;
}

function parseOptions(argv: string[]): CliOptions {
	const options: CliOptions = { runs: 1, model: 'all', prime: true, json: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--runs') options.runs = parsePositiveInteger(argv[++index], '--runs');
		else if (arg === '--model') {
			const model = String(argv[++index] ?? '').toLowerCase();
			if (!['all', 'ox', 'muse', 'qwen'].includes(model)) fail('--model must be all, ox, muse, or qwen.');
			options.model = model as CliOptions['model'];
		} else if (arg === '--no-prime') options.prime = false;
		else if (arg === '--json') options.json = true;
		else if (arg === '--help' || arg === '-h') {
			process.stdout.write(
				'Usage: pirun speedtest [--runs N] [--model all|ox|muse|qwen] [--no-prime] [--json]\n'
			);
			process.exit(0);
		} else fail(`Unknown speed-test option: ${arg}`);
	}
	return options;
}

function displayMs(value: number | null) {
	if (value === null) return '—';
	return value < 1000 ? `${value.toFixed(0)}ms` : `${(value / 1000).toFixed(2)}s`;
}

function displayRate(value: number | null) {
	return value === null ? '—' : `${value.toFixed(2)} tok/s`;
}

function printSample(sample: SpeedSample, run: number) {
	process.stdout.write(`${sample.label} #${run}  ${sample.status.toUpperCase()}\n`);
	process.stdout.write(
		`  reasoning  ${String(sample.reasoning.tokens).padStart(5)} tokens  ` +
			`TTFT ${displayMs(sample.reasoning.first_token_ms).padStart(8)}  ` +
			`decode ${displayRate(sample.reasoning.decode_tokens_per_second).padStart(13)}  ` +
			`phase ${displayMs(sample.reasoning.decode_duration_ms)}\n`
	);
	process.stdout.write(
		`  final      ${String(sample.final.tokens).padStart(5)} tokens  ` +
			`TTFT ${displayMs(sample.final.first_token_ms).padStart(8)}  ` +
			`decode ${displayRate(sample.final.decode_tokens_per_second).padStart(13)}  ` +
			`phase ${displayMs(sample.final.decode_duration_ms)}\n`
	);
	process.stdout.write(
		`  total      observed ${sample.observed_output_tokens} tokens (o200k estimate), ` +
			`provider ${sample.provider_output_tokens ?? '—'} tokens, ` +
			`unattributed ${sample.unattributed_provider_tokens ?? '—'}, wall ${displayMs(sample.total_duration_ms)}\n`
	);
	if (sample.error) process.stdout.write(`  error      ${sample.error}\n`);
}

async function primeTransport(baseUrl: string, apiKey: string) {
	const response = await fetch(`${baseUrl}/v1/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
		},
		body: JSON.stringify({
			model: 'commandcode>muse-spark-1.2',
			messages: [{ role: 'user', content: 'Reply with exactly READY.' }],
			max_tokens: 256,
			stream: false
		})
	});
	if (!response.ok) throw new Error(`Transport priming failed (${response.status}): ${await response.text()}`);
	await response.arrayBuffer();
}

export async function runSpeedTestCli(argv = process.argv.slice(2)) {
	const options = parseOptions(argv);
	const settings = loadSettings();
	const host = settings.host === '0.0.0.0' ? '127.0.0.1' : settings.host;
	const baseUrl = `http://${host}:${settings.port}`;
	const health = await fetch(`${baseUrl}/health`).catch(() => null);
	if (!health?.ok) fail(`Proxy is not ready at ${baseUrl}. Run "pirun up" first.`);

	if (options.prime) {
		if (!options.json) process.stdout.write('Priming the Command Code transport (not measured)…\n');
		await primeTransport(baseUrl, settings.apiKey);
	}

	const selected = SPEED_TEST_MODELS.filter(({ id }) => {
		if (options.model === 'all') return true;
		if (options.model === 'ox') return id.endsWith('ox-alpha');
		if (options.model === 'muse') return id.endsWith('muse-spark-1.2');
		return id.endsWith('qwen3.7-flash');
	});
	const samples: Array<SpeedSample & { run: number }> = [];
	for (let run = 1; run <= options.runs; run += 1) {
		const order = run % 2 === 0 ? [...selected].reverse() : selected;
		for (const model of order) {
			if (!options.json) process.stdout.write(`Benchmarking ${model.label} #${run}…\n`);
			const sample = await benchmarkModel({
				baseUrl,
				apiKey: settings.apiKey,
				model: model.id,
				label: model.label
			});
			samples.push({ ...sample, run });
			if (!options.json) printSample(sample, run);
		}
	}

	const directory = resolve(PROJECT_DIR, '.runs', 'speed-tests');
	mkdirSync(directory, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const artifactPath = resolve(directory, `${stamp}-${randomBytes(3).toString('hex')}.json`);
	const artifact = {
		schema_version: 1,
		created_at: new Date().toISOString(),
		prompt: SPEED_TEST_PROMPT,
		token_count_method: 'gpt-tokenizer 4.0.0 o200k_base; phase counts are estimates',
		provider_output_tokens: 'provider-reported total completion tokens when available',
		unattributed_provider_tokens:
			'provider total minus observed o200k phase estimates; may include hidden reasoning and tokenizer variance',
		primed: options.prime,
		runs: options.runs,
		samples
	};
	writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

	if (options.json) {
		process.stdout.write(
			`${JSON.stringify({ ...artifact, samples: samples.map(withoutGeneratedText), artifact: artifactPath }, null, 2)}\n`
		);
	} else {
		process.stdout.write(
			`Token note: reasoning/final counts and tok/s use one consistent o200k_base estimate; ` +
				`provider totals are reported separately.\nArtifact: ${artifactPath}\n`
		);
	}
	if (samples.some((sample) => sample.status === 'failed')) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
	runSpeedTestCli().catch((error) => {
		process.stderr.write(`speed-test: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
