export const DEFAULT_AGENT_TIMEOUT_SECONDS = 2 * 60 * 60;
export const DEFAULT_RETURN_AFTER_SECONDS = 10 * 60;
export const DEFAULT_REQUEST_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_SECONDS * 1000;

export function parseAgentTimeoutSeconds(raw?: string) {
	if (!raw) return DEFAULT_AGENT_TIMEOUT_SECONDS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error('--timeout must be a positive whole number of seconds.');
	}
	return parsed;
}

export function parseReturnAfterSeconds(raw?: string) {
	if (!raw) return DEFAULT_RETURN_AFTER_SECONDS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error('--return-after must be a non-negative whole number of seconds.');
	}
	return parsed;
}
