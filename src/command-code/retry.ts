/** Retry policy and upstream-error classification for the Command Code adapter. */

import { isRecord } from './protocol.ts';

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

export class CommandCodeUpstreamError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = 'CommandCodeUpstreamError';
		this.status = status;
	}
}

export function configuredRetryCount() {
	const value = Number.parseInt(process.env.COMMANDCODE_ADAPTER_RETRIES ?? '', 10);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_COUNT;
}

export function isRetryableError(error: unknown, signal?: AbortSignal) {
	if (signal?.aborted) return false;
	if (error instanceof Error && error.name === 'AbortError') return false;
	const status = (error as { status?: number })?.status;
	if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500;
	const message = error instanceof Error ? error.message : String(error);
	return !/not authenticated|authentication failed|invalid api key|usage limit|does not define model/i.test(message);
}

export function streamErrorPayload(error: unknown, signal?: AbortSignal) {
	const originalMessage = error instanceof Error ? error.message : String(error);
	const retryable = isRetryableError(error, signal);
	return {
		error: {
			message: retryable
				? `Retryable upstream server error. Please retry your request. ${originalMessage}`
				: originalMessage,
			type: 'api_error',
			code: retryable ? 'upstream_retryable_error' : 'adapter_stream_error'
		}
	};
}

export async function waitBeforeRetry(attempt: number, signal?: AbortSignal) {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
	const delay = DEFAULT_RETRY_DELAY_MS * 2 ** attempt;
	await new Promise<void>((resolve, reject) => {
		const done = () => {
			signal?.removeEventListener('abort', abort);
			resolve();
		};
		const timeout = setTimeout(done, delay);
		const abort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		timeout.unref?.();
	});
}

export async function upstreamResponseError(response: Response) {
	const text = await response.text().catch(() => '');
	let detail = text.trim();
	if (detail) {
		try {
			const parsed = JSON.parse(detail) as unknown;
			if (isRecord(parsed)) {
				const raw = parsed.error ?? parsed.message;
				if (typeof raw === 'string') detail = raw;
				else if (isRecord(raw) && typeof raw.message === 'string') detail = raw.message;
			}
		} catch {
			// Keep a non-JSON upstream body verbatim.
		}
	}
	return new CommandCodeUpstreamError(
		detail
			? `Command Code request failed (${response.status}): ${detail}`
			: `Command Code request failed (${response.status}).`,
		response.status
	);
}
