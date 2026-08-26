import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface OwnedLock {
	pid: number;
	token: string;
	createdAt: number;
	runId?: string;
}

export function atomicWriteJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = resolve(dirname(path), `.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
	writeFileSync(temporary, JSON.stringify(value, null, 2));
	renameSync(temporary, path);
}

export function readOwnedLock(path: string): OwnedLock | null {
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf8').trim();
		if (/^\d+$/.test(raw)) return { pid: Number(raw), token: 'legacy', createdAt: 0 };
		const parsed = JSON.parse(raw) as OwnedLock;
		return Number.isFinite(parsed.pid) && typeof parsed.token === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

export function acquireOwnedLock(path: string, isAlive: (pid: number) => boolean) {
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const token = randomBytes(16).toString('hex');
		let fd: number | undefined;
		try {
			fd = openSync(path, 'wx');
			writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() } satisfies OwnedLock));
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			const current = readOwnedLock(path);
			if (current && isAlive(current.pid)) throw new Error(`busy:${current.pid}`);
			rmSync(path, { force: true });
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	throw new Error('could not acquire lock');
}

export function updateOwnedLock(path: string, token: string, pid: number, runId?: string) {
	const current = readOwnedLock(path);
	if (!current || current.token !== token) throw new Error(`lock ownership changed: ${path}`);
	atomicWriteJson(path, { ...current, pid, runId });
}

export function releaseOwnedLock(path: string, token?: string) {
	const current = readOwnedLock(path);
	if (!current) return false;
	if (token && current.token !== token) return false;
	rmSync(path, { force: true });
	return true;
}
