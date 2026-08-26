import { createHash } from 'node:crypto';
import { encode } from 'gpt-tokenizer';

export const SPEED_TEST_PROMPT =
	'Write the complete text of Abraham Lincoln’s Second Inaugural Address of March 4, 1865. Do not include anything else in your output.';

export const SPEED_TEST_MODELS = [
	{ id: 'commandcode>ox-alpha', label: 'Ox Alpha' },
	{ id: 'commandcode>muse-spark-1.2', label: 'Muse Contributor' },
	{ id: 'commandcode>qwen3.7-flash', label: 'Qwen 3.7 Flash' }
] as const;

export interface PhaseMetrics {
	characters: number;
	tokens: number;
	chunks: number;
	first_token_ms: number | null;
	decode_duration_ms: number | null;
	decode_tokens_per_second: number | null;
}

export interface SpeedSample {
	model: string;
	label: string;
	status: 'ok' | 'failed';
	error?: string;
	http_headers_ms: number | null;
	total_duration_ms: number;
	reasoning: PhaseMetrics;
	final: PhaseMetrics;
	provider_usage: Record<string, unknown> | null;
	provider_output_tokens: number | null;
	observed_output_tokens: number;
	unattributed_provider_tokens: number | null;
	reasoning_sha256: string;
	final_sha256: string;
	reasoning_text: string;
	final_text: string;
}

interface BenchmarkOptions {
	baseUrl: string;
	apiKey?: string;
	model: string;
	label: string;
	prompt?: string;
	maxTokens?: number;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rounded(value: number) {
	return Math.round(value * 100) / 100;
}

function sha256(text: string) {
	return createHash('sha256').update(text).digest('hex');
}

function errorMessage(value: unknown) {
	if (typeof value === 'string') return value;
	if (isRecord(value) && typeof value.message === 'string') return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function phaseMetrics(
	text: string,
	chunks: number,
	firstAt: number | null,
	endAt: number | null,
	startedAt: number
): PhaseMetrics {
	const tokens = text ? encode(text).length : 0;
	const duration = firstAt !== null && endAt !== null ? Math.max(0, endAt - firstAt) : null;
	return {
		characters: text.length,
		tokens,
		chunks,
		first_token_ms: firstAt === null ? null : rounded(firstAt - startedAt),
		decode_duration_ms: duration === null ? null : rounded(duration),
		decode_tokens_per_second:
			duration !== null && duration > 0 && tokens > 0 ? rounded(tokens / (duration / 1000)) : null
	};
}

async function* ssePayloads(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { value, done } = await reader.read();
		buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
		let boundary = buffer.indexOf('\n\n');
		while (boundary !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = frame
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (data) yield data;
			boundary = buffer.indexOf('\n\n');
		}
		if (done) {
			const data = buffer
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n');
			if (data) yield data;
			break;
		}
	}
}

export async function benchmarkModel(options: BenchmarkOptions): Promise<SpeedSample> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const now = options.now ?? performance.now.bind(performance);
	const startedAt = now();
	let headersAt: number | null = null;
	let finishedAt: number | null = null;
	let reasoningFirstAt: number | null = null;
	let finalFirstAt: number | null = null;
	let reasoningText = '';
	let finalText = '';
	let reasoningChunks = 0;
	let finalChunks = 0;
	let providerUsage: Record<string, unknown> | null = null;
	let failure = '';

	try {
		const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {})
			},
			body: JSON.stringify({
				model: options.model,
				messages: [{ role: 'user', content: options.prompt ?? SPEED_TEST_PROMPT }],
				stream: true,
				...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
			})
		});
		headersAt = now();
		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
		}

		for await (const payload of ssePayloads(response.body)) {
			const eventAt = now();
			if (payload === '[DONE]') {
				finishedAt = eventAt;
				break;
			}
			let event: unknown;
			try {
				event = JSON.parse(payload);
			} catch {
				continue;
			}
			if (!isRecord(event)) continue;
			if (event.error !== undefined) {
				failure = errorMessage(event.error);
				finishedAt = eventAt;
				break;
			}
			if (isRecord(event.usage)) providerUsage = event.usage;
			const choices = Array.isArray(event.choices) ? event.choices : [];
			const choice = isRecord(choices[0]) ? choices[0] : null;
			const delta = choice && isRecord(choice.delta) ? choice.delta : null;
			if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
				reasoningFirstAt ??= eventAt;
				reasoningText += delta.reasoning_content;
				reasoningChunks += 1;
			}
			if (delta && typeof delta.content === 'string' && delta.content) {
				finalFirstAt ??= eventAt;
				finalText += delta.content;
				finalChunks += 1;
			}
			if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) finishedAt = eventAt;
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}

	finishedAt ??= now();
	const reasoning = phaseMetrics(
		reasoningText,
		reasoningChunks,
		reasoningFirstAt,
		finalFirstAt ?? finishedAt,
		startedAt
	);
	const final = phaseMetrics(finalText, finalChunks, finalFirstAt, finishedAt, startedAt);
	const providerOutput = Number(providerUsage?.completion_tokens);
	const providerOutputTokens = Number.isFinite(providerOutput) ? providerOutput : null;
	const observedOutputTokens = reasoning.tokens + final.tokens;
	return {
		model: options.model,
		label: options.label,
		status: failure ? 'failed' : 'ok',
		...(failure ? { error: failure } : {}),
		http_headers_ms: headersAt === null ? null : rounded(headersAt - startedAt),
		total_duration_ms: rounded(finishedAt - startedAt),
		reasoning,
		final,
		provider_usage: providerUsage,
		provider_output_tokens: providerOutputTokens,
		observed_output_tokens: observedOutputTokens,
		unattributed_provider_tokens:
			providerOutputTokens === null ? null : providerOutputTokens - observedOutputTokens,
		reasoning_sha256: sha256(reasoningText),
		final_sha256: sha256(finalText),
		reasoning_text: reasoningText,
		final_text: finalText
	};
}

export function withoutGeneratedText(sample: SpeedSample) {
	const { reasoning_text: _reasoning, final_text: _final, ...summary } = sample;
	return summary;
}
