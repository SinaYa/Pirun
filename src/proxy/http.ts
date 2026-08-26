/** Shared HTTP plumbing for the proxy: settings, logging, request/response helpers. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadSettings } from '../settings.ts';

export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export const settings = loadSettings();

const LOG_ORDER = { silent: 0, error: 1, info: 2, debug: 3 } as const;

export function log(level: 'error' | 'info' | 'debug', message: string, extra?: unknown) {
	if (LOG_ORDER[settings.logLevel] < LOG_ORDER[level]) return;
	const stamp = new Date().toISOString();
	const line = `[${stamp}] ${level.padEnd(5)} ${message}`;
	if (extra === undefined) console.log(line);
	else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export function readBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new Error('Request body too large.'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

export function setCors(response: ServerResponse) {
	response.setHeader('Access-Control-Allow-Origin', '*');
	response.setHeader('Access-Control-Allow-Headers', '*');
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

export function sendJson(response: ServerResponse, status: number, payload: unknown) {
	const body = JSON.stringify(payload, null, 2);
	setCors(response);
	response.statusCode = status;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.setHeader('Content-Length', Buffer.byteLength(body));
	response.end(body);
}

export function sendError(response: ServerResponse, status: number, message: string, details?: unknown) {
	log('error', `${status} ${message}`, details);
	sendJson(response, status, {
		error: { message, type: 'completions_proxy_error', code: status, details }
	});
}

export function handleThrown(response: ServerResponse, error: unknown) {
	if (error instanceof Error && error.name === 'AbortError') {
		sendError(response, 504, 'Upstream request timed out or the client disconnected.');
		return;
	}
	const status = (error as { status?: number })?.status ?? 502;
	sendError(response, status, error instanceof Error ? error.message : String(error));
}

export function authorized(request: IncomingMessage) {
	if (!settings.apiKey) return true;
	const header = request.headers.authorization ?? '';
	const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header.trim();
	return token === settings.apiKey;
}

export function normalizePath(pathname: string) {
	const trimmed = pathname.replace(/\/+$/, '') || '/';
	return trimmed.startsWith('/v1/') ? trimmed.slice(3) : trimmed;
}
