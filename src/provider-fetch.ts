import {
	commandCodeCliAdapterRequest,
	isCommandCodeCliAdapterUrl
} from './command-code-cli-adapter.ts';

/**
 * One fetch that understands both plain HTTPS providers and the Command Code
 * CLI adapter pseudo-URL (`command-code-cli://adapter/v1`).
 */
export async function providerFetch(input: string, init: RequestInit): Promise<Response> {
	return isCommandCodeCliAdapterUrl(input)
		? commandCodeCliAdapterRequest(input, init)
		: fetch(input, init);
}

/** Same retry behaviour the parent project uses: one retry on a 500 or a throw. */
export async function providerFetchWithSingle500Retry(
	input: string,
	init: RequestInit,
	options: { retryDelayMs?: number } = {}
): Promise<Response> {
	const { retryDelayMs = 250 } = options;
	let first: Response;
	try {
		first = await providerFetch(input, init);
	} catch (error) {
		if ((init.signal as AbortSignal | undefined)?.aborted) throw error;
		if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
		return providerFetch(input, init);
	}
	if (first.status !== 500) return first;
	if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
	return providerFetch(input, init);
}
