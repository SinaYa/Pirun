/** On-disk storage for runs (jobs), named agents, sessions, and their locks. */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
	acquireOwnedLock,
	atomicWriteJson,
	readOwnedLock,
	releaseOwnedLock
} from '../pirun-files.ts';
import type { AntigravityIsolationMode } from '../pirun-antigravity.ts';
import {
	AGENTS_DIR,
	die,
	isAlive,
	MAX_STORAGE_BYTES,
	RETENTION_DAYS,
	RUNS_DIR,
	SESSIONS_DIR,
	state
} from './context.ts';

export interface JobMeta {
	id: string;
	preset?: string;
	harness?: 'pi' | 'antigravity';
	apiMode?: 'openai-completions' | 'antigravity-account';
	antigravity?: {
		profileDir: string;
		isolationMode: AntigravityIsolationMode;
		effort?: string;
		agent?: string;
	};
	model: string;
	cwd: string;
	task: string;
	tools: boolean;
	/** The preset's provider/account at launch time. */
	use?: string;
	/** Reasoning intent, mapped per harness at spawn. */
	effort?: string;
	/** Permission intent (read|edit|all), mapped per harness at spawn. */
	permissions?: string;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number;
	pid?: number;
	timeoutSec: number;
	returnAfterSec: number;
	/** Absolute hard-stop time. Live-updatable with `pirun time`. */
	deadlineAt?: number;
	timedOut?: boolean;
	/** Every Pi process is owned by a detached supervisor, never the caller. */
	supervised?: boolean;
	/** The detached pirun process that owns the timeout and waits on Pi. */
	supervisorPid?: number;
	supervisorReadyAt?: number;
	piStartedAt?: number;
	/** A supervised run whose supervisor went away before it could finish. */
	interrupted?: boolean;
	/** Set by `pirun kill`: a later non-ok outcome renders as KILLED, not FAILED. */
	killedAt?: number;
	supervisorError?: string;
	noContextFiles?: boolean;
	label?: string;
	/** Name of the persistent agent this exchange belongs to, if any. */
	agent?: string;
	/** Ownership token for that agent's cross-process lock. */
	agentLockToken?: string;
	/** How Pi was pointed at a session: create by name, continue, or fork. */
	session?: { mode: 'new' | 'continue' | 'fork'; ref: string };
}

export interface AgentMeta {
	name: string;
	preset?: string;
	harness?: 'pi' | 'antigravity';
	cwd: string;
	model: string;
	createdAt: number;
	lastRunAt: number;
	/** Pi's own session uuid, learned from the first run's event stream. */
	sessionId?: string;
	forkedFrom?: string;
	exchanges: number;
	runs: string[];
	totals: { input: number; cached: number; output: number; cost: number };
	/** Session footprint after the last exchange, for the context gauge. */
	contextTokens?: number;
}

/* -------------------------------------------------------------------------- */
/* jobs                                                                       */
/* -------------------------------------------------------------------------- */

export function jobDir(id: string) {
	return resolve(RUNS_DIR, id);
}

export function readMeta(id: string): JobMeta {
	const path = resolve(jobDir(id), 'meta.json');
	if (!existsSync(path)) die(`no such run "${id}". Try "pirun jobs ${state.presetName || '<preset>'}".`);
	return JSON.parse(readFileSync(path, 'utf8')) as JobMeta;
}

export function writeMeta(meta: JobMeta) {
	const destination = resolve(jobDir(meta.id), 'meta.json');
	atomicWriteJson(destination, meta);
}

export function listJobs(): JobMeta[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.filter((entry) => {
			const path = resolve(RUNS_DIR, entry);
			return statSync(path).isDirectory() && existsSync(resolve(path, 'meta.json'));
		})
		.map((entry) => readMeta(entry))
		.sort((a, b) => b.startedAt - a.startedAt);
}

export function presetJobs() {
	return listJobs().filter((job) => !job.preset || job.preset === state.presetName);
}

export function readPresetJob(id: string) {
	const meta = readMeta(id);
	if (meta.preset && meta.preset !== state.presetName) {
		die(`run "${id}" belongs to preset "${meta.preset}", not "${state.presetName}".`);
	}
	return meta;
}

/* -------------------------------------------------------------------------- */
/* agents                                                                     */
/* -------------------------------------------------------------------------- */

export function agentDir(name: string) {
	return resolve(AGENTS_DIR, name);
}

function agentFile(name: string) {
	return resolve(agentDir(name), 'agent.json');
}

export function validAgentName(name: string) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function readAgent(name: string): AgentMeta | null {
	const path = agentFile(name);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as AgentMeta;
}

export function writeAgent(agent: AgentMeta) {
	atomicWriteJson(agentFile(agent.name), agent);
}

export function listAgents(): AgentMeta[] {
	if (!existsSync(AGENTS_DIR)) return [];
	return readdirSync(AGENTS_DIR)
		.filter((entry) => existsSync(agentFile(entry)))
		.map((entry) => readAgent(entry))
		.filter((agent): agent is AgentMeta => Boolean(agent))
		.sort((a, b) => b.lastRunAt - a.lastRunAt);
}

export function presetAgents() {
	return listAgents().filter((agent) => !agent.preset || agent.preset === state.presetName);
}

/* -------------------------------------------------------------------------- */
/* sessions                                                                   */
/* -------------------------------------------------------------------------- */

function sessionFiles() {
	if (!existsSync(SESSIONS_DIR)) return [];
	return readdirSync(SESSIONS_DIR)
		.map((name) => resolve(SESSIONS_DIR, name))
		.filter((path) => statSync(path).isFile() && path.endsWith('.jsonl'));
}

function sessionRefs(agent: AgentMeta) {
	return new Set([agent.name, agent.sessionId].filter((value): value is string => Boolean(value)));
}

function sessionMatches(path: string, refs: Set<string>) {
	const name = basename(path).replace(/\.jsonl$/, '');
	return [...refs].some((ref) => name.endsWith(`_${ref}`));
}

export function removeAgentSessions(agent: AgentMeta) {
	if (agent.harness === 'antigravity') return 0;
	const refs = sessionRefs(agent);
	let removed = 0;
	for (const path of sessionFiles()) {
		if (!sessionMatches(path, refs)) continue;
		rmSync(path, { force: true });
		removed += 1;
	}
	return removed;
}

export function removeOrphanSessions(olderThan = 0) {
	const activeRefs = new Set(listAgents().flatMap((agent) => [...sessionRefs(agent)]));
	let removed = 0;
	for (const path of sessionFiles()) {
		const stats = statSync(path);
		if (stats.mtimeMs >= olderThan || sessionMatches(path, activeRefs)) continue;
		rmSync(path, { force: true });
		removed += 1;
	}
	return removed;
}

/* -------------------------------------------------------------------------- */
/* retention                                                                  */
/* -------------------------------------------------------------------------- */

function pathBytes(path: string): number {
	if (!existsSync(path)) return 0;
	const stats = statSync(path);
	if (stats.isFile()) return stats.size;
	return readdirSync(path).reduce((sum, entry) => sum + pathBytes(resolve(path, entry)), 0);
}

/** Bounded, conservative retention: never prune active-agent history automatically. */
export function pruneStorage() {
	if (!existsSync(RUNS_DIR)) return;
	const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const protectedRuns = new Set(listAgents().flatMap((agent) => agent.runs));
	const candidates = listJobs()
		.filter((job) => job.finishedAt && !protectedRuns.has(job.id) && !(job.pid && isAlive(job.pid)))
		.sort((a, b) => a.startedAt - b.startedAt);

	for (const job of candidates.filter((entry) => entry.startedAt < cutoff)) {
		rmSync(jobDir(job.id), { recursive: true, force: true });
	}
	removeOrphanSessions(cutoff);

	let bytes = pathBytes(RUNS_DIR);
	for (const job of candidates) {
		if (bytes <= MAX_STORAGE_BYTES || !existsSync(jobDir(job.id))) continue;
		const size = pathBytes(jobDir(job.id));
		rmSync(jobDir(job.id), { recursive: true, force: true });
		bytes -= size;
	}
}

/* -------------------------------------------------------------------------- */
/* agent locks                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One exchange at a time per agent. Two concurrent turns would interleave
 * writes into the same session file and corrupt the very context we are
 * keeping around.
 */
export function agentLockPath(name: string) {
	return resolve(agentDir(name), 'lock');
}

export function lockAgent(name: string) {
	const path = resolve(agentDir(name), 'lock');
	try {
		return acquireOwnedLock(path, isAlive);
	} catch (error) {
		const match = /^busy:(\d+)$/.exec(error instanceof Error ? error.message : '');
		if (match) die(`agent "${name}" is busy (pid ${match[1]}). Wait, or run \`pirun agents ${state.presetName}\`.`);
		throw error;
	}
}

export function unlockAgent(name: string, token?: string) {
	releaseOwnedLock(agentLockPath(name), token);
}

export function agentIsBusy(name: string) {
	const lock = readOwnedLock(agentLockPath(name));
	return Boolean(lock && isAlive(lock.pid));
}
