/** Creating jobs and running them under a detached supervisor. */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PROJECT_DIR } from '../paths.ts';
import { flagString, type PirunArgs as Args } from '../pirun-args.ts';
import { antigravityEffortLevel, parseEffortIntent, piThinkingLevel } from '../pirun-providers.ts';
import { antigravityEnv, antigravityIsolationMode, antigravityRunArgs, findAntigravityEntry } from '../pirun-antigravity.ts';
import { ensurePirunRetryDefault } from '../pirun-pi-settings.ts';
import { updateOwnedLock } from '../pirun-files.ts';
import { terminateProcessTree } from '../pirun-process.ts';
import { DEFAULT_RETURN_AFTER_SECONDS } from '../timeouts.ts';
import { die, ensureRunsDir, isAlive, PIRUN_ENTRY, SESSIONS_DIR, state, truncate } from './context.ts';
import { findPiEntry, LEAN_FLAGS } from './pi.ts';
import { requestedTimeSpec, resolveModel } from './preset.ts';
import { antigravityPermissionArgs, piPermissionTools, type PermissionLevel } from './permissions.ts';
import {
	agentLockPath,
	jobDir,
	pruneStorage,
	readMeta,
	unlockAgent,
	writeMeta,
	type AgentMeta,
	type JobMeta
} from './store.ts';
import { buildDigest, exitCodeFor } from './digest.ts';
import { emit, emitRunningHandoff } from './render.ts';
import { antigravityAccountProfileDir } from './auth.ts';

export function createJob(args: Args, task: string, agent?: AgentMeta, label?: string, agentLockToken?: string): JobMeta {
	const time = requestedTimeSpec(args);
	ensureRunsDir();
	pruneStorage();
	let id = '';
	for (let attempt = 0; attempt < 8; attempt += 1) {
		id = randomBytes(3).toString('hex');
		try {
			mkdirSync(jobDir(id));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			id = '';
		}
	}
	if (!id) die('could not allocate a unique run id.');
	const meta: JobMeta = {
		id,
		preset: state.presetName,
		harness: state.preset.harness,
		apiMode: state.preset.harness === 'antigravity' ? 'antigravity-account' : 'openai-completions',
		model: agent?.model ?? resolveModel(flagString(args, 'model')),
		cwd: agent?.cwd ?? resolve(flagString(args, 'dir') || state.preset.dir || process.cwd()),
		task: truncate(task, 300),
		tools: !args.flags.has('no-tools'),
		use: state.preset.use,
		effort: state.preset.effort,
		permissions: state.preset.permissions,
		startedAt: Date.now(),
		timeoutSec: time.timeoutSec,
		returnAfterSec: time.returnAfterSec,
		noContextFiles: args.flags.has('no-context-files'),
		label
	};
	if (state.preset.harness === 'antigravity') {
		const profileDir = antigravityAccountProfileDir(state.use.account);
		meta.antigravity = {
			profileDir,
			isolationMode: antigravityIsolationMode(profileDir),
			effort: state.preset.effort
				? antigravityEffortLevel(parseEffortIntent(state.preset.effort))
				: undefined,
			agent: state.preset.antigravityAgent
		};
	}
	if (agent) {
		meta.agent = agent.name;
		meta.agentLockToken = agentLockToken;
		meta.session = agent.sessionId
			? { mode: 'continue', ref: agent.sessionId }
			: agent.forkedFrom
				? { mode: 'fork', ref: agent.forkedFrom }
				: { mode: 'new', ref: agent.name };
	}
	writeFileSync(resolve(jobDir(id), 'task.md'), task);
	writeMeta(meta);
	return meta;
}

function piArgs(meta: JobMeta, jsonMode: boolean) {
	const list = [
		findPiEntry(),
		'-p',
		'--mode',
		jsonMode ? 'json' : 'text',
		'--approve',
		...LEAN_FLAGS,
		'--model',
		meta.model
	];
	if (meta.effort) list.push('--thinking', piThinkingLevel(parseEffortIntent(meta.effort)));
	if (!meta.tools) list.push('--no-tools');
	else if (meta.permissions) {
		// Pi has no permission prompts; levels are enforced as tool scopes.
		const scope = piPermissionTools(meta.permissions as PermissionLevel);
		if (scope) list.push('--tools', scope.join(','));
	}
	if (meta.noContextFiles) list.push('--no-context-files');

	if (!meta.session) {
		// Throwaway work: nothing to keep, nothing to pay for keeping.
		list.push('--no-session');
		return list;
	}

	mkdirSync(SESSIONS_DIR, { recursive: true });
	list.push('--session-dir', SESSIONS_DIR);
	if (meta.session.mode === 'new') list.push('--session-id', meta.session.ref);
	else if (meta.session.mode === 'fork') list.push('--fork', meta.session.ref);
	else list.push('--session', meta.session.ref);
	return list;
}

function captureLines(
	stream: NodeJS.ReadableStream | null,
	eventsPath: string,
	stampJson: boolean
) {
	if (!stream) return Promise.resolve();
	return new Promise<void>((resolveCapture) => {
		let buffer = '';
		const writeLine = (line: string) => {
			if (!line) return;
			if (stampJson) {
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					event._pirun_received_at = Date.now();
					appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
					return;
				} catch {
					// Preserve non-JSON output so the digest can report startup failures.
				}
			}
			appendFileSync(eventsPath, `${line}\n`);
		};
		stream.on('data', (chunk) => {
			buffer += String(chunk).replace(/\r\n/g, '\n');
			let boundary = buffer.indexOf('\n');
			while (boundary !== -1) {
				writeLine(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 1);
				boundary = buffer.indexOf('\n');
			}
		});
		stream.once('end', () => {
			if (buffer) writeLine(buffer);
			resolveCapture();
		});
		stream.once('error', () => resolveCapture());
	});
}

async function spawnPi(meta: JobMeta) {
	ensurePirunRetryDefault();
	const eventsPath = resolve(jobDir(meta.id), 'events.jsonl');
	const task = readFileSync(resolve(jobDir(meta.id), 'task.md'), 'utf8');

	const child = spawn(process.execPath, piArgs(meta, true), {
		cwd: meta.cwd,
		detached: process.platform !== 'win32',
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, NO_COLOR: '1', PI_OFFLINE: '1' }
	});
	const captureDone = Promise.all([
		captureLines(child.stdout, eventsPath, true),
		captureLines(child.stderr, eventsPath, false)
	]).then(() => {});

	// The prompt travels on stdin, never in argv. No quoting, no length limit,
	// no temp-file dance for the caller.
	child.stdin.write(task);
	child.stdin.end();

	meta.pid = child.pid;
	meta.piStartedAt = Date.now();
	writeMeta(meta);
	return { child, captureDone };
}

async function spawnAntigravity(meta: JobMeta) {
	if (!meta.antigravity) throw new Error(`Run ${meta.id} has no Antigravity profile metadata.`);
	const eventsPath = resolve(jobDir(meta.id), 'events.jsonl');
	const task = readFileSync(resolve(jobDir(meta.id), 'task.md'), 'utf8');
	const child = spawn(
		findAntigravityEntry(),
		antigravityRunArgs({
			profileDir: meta.antigravity.profileDir,
			conversationId: meta.session?.mode === 'continue' ? meta.session.ref : undefined,
			model: meta.model,
			effort: meta.antigravity.effort,
			agent: meta.antigravity.agent,
			// --no-tools keeps agy's default headless policy (deny everything
			// risky); otherwise the preset's permission level decides.
			permissionArgs: meta.tools && meta.permissions
				? antigravityPermissionArgs(meta.permissions as PermissionLevel)
				: [],
			// agy's --print-timeout cannot be moved after spawn, so it gets a
			// generous internal ceiling; the supervisor enforces the real,
			// live-updatable deadline.
			timeoutSec: Math.max(meta.timeoutSec, 24 * 60 * 60)
		}),
		{
			cwd: meta.cwd,
			detached: process.platform !== 'win32',
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
			env: antigravityEnv(meta.antigravity.isolationMode)
		}
	);
	const captureDone = Promise.all([
		captureLines(child.stdout, eventsPath, true),
		captureLines(child.stderr, eventsPath, false)
	]).then(() => {});
	child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: task } })}\n`);
	meta.pid = child.pid;
	meta.piStartedAt = Date.now();
	writeMeta(meta);
	return { child, captureDone };
}

async function spawnHarness(meta: JobMeta) {
	return meta.harness === 'antigravity' ? spawnAntigravity(meta) : spawnPi(meta);
}

/** Announce the durable handle before either the caller or supervisor can exit. */
export function announce(meta: JobMeta) {
	process.stderr.write(`pirun: run ${meta.id} started — check it with: pirun wait ${meta.preset} ${meta.id}
`);
}

export async function runToCompletion(meta: JobMeta) {
	const { child, captureDone } = await spawnHarness(meta);

	meta.deadlineAt = (meta.piStartedAt ?? Date.now()) + meta.timeoutSec * 1000;
	writeMeta(meta);

	let timedOut = false;
	// The hard deadline lives in meta.json so `pirun time` can move it while
	// the run is live; the supervisor re-reads instead of arming one timer.
	const enforcer = setInterval(() => {
		try {
			const onDisk = JSON.parse(
				readFileSync(resolve(jobDir(meta.id), 'meta.json'), 'utf8')
			) as JobMeta;
			if (onDisk.deadlineAt) meta.deadlineAt = onDisk.deadlineAt;
		} catch {
			/* a transient read race keeps the last known deadline */
		}
		if (meta.deadlineAt && Date.now() >= meta.deadlineAt) {
			timedOut = true;
			if (child.pid) terminateProcessTree(child.pid);
		}
	}, 1000);

	const exitCode: number = await new Promise((resolveExit) => {
		child.on('exit', (code) => resolveExit(code ?? 1));
		child.on('error', () => resolveExit(1));
	});
	clearInterval(enforcer);
	await captureDone;

	meta.finishedAt = Date.now();
	meta.exitCode = exitCode;
	meta.timedOut = timedOut;
	return meta;
}

export function startSupervisor(meta: JobMeta) {
	meta.supervised = true;
	writeMeta(meta);
	const supervisor = spawn(process.execPath, [PIRUN_ENTRY, '_supervise', meta.id], {
		cwd: PROJECT_DIR,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...process.env, NO_COLOR: '1', PI_OFFLINE: '1' }
	});
	meta.pid = supervisor.pid;
	meta.supervisorPid = supervisor.pid;
	if (meta.agent && meta.agentLockToken && supervisor.pid) {
		updateOwnedLock(agentLockPath(meta.agent), meta.agentLockToken, supervisor.pid, meta.id);
	}
	writeMeta(meta);
	supervisor.unref();
	return supervisor;
}

/** Recover a job whose supervisor disappeared before writing final metadata. */
export function finaliseIfExited(meta: JobMeta) {
	if (meta.finishedAt) return meta;
	if (meta.supervisorPid && isAlive(meta.supervisorPid)) return meta;
	if (!meta.supervisorPid && meta.pid && isAlive(meta.pid)) return meta;
	if (meta.supervisorPid && meta.pid && meta.pid !== meta.supervisorPid && isAlive(meta.pid)) {
		terminateProcessTree(meta.pid);
	}
	meta.finishedAt = Date.now();
	meta.exitCode = 1;
	meta.interrupted = true;
	writeMeta(meta);
	if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	return meta;
}

export async function observeJob(meta: JobMeta, args: Args, returnAfterSec = meta.returnAfterSec ?? DEFAULT_RETURN_AFTER_SECONDS) {
	const deadline = Date.now() + returnAfterSec * 1000;
	let current = finaliseIfExited(readMeta(meta.id));
	while (!current.finishedAt && Date.now() < deadline) {
		await new Promise((resolveObservation) => setTimeout(resolveObservation, 500));
		current = finaliseIfExited(readMeta(meta.id));
	}
	const digest = buildDigest(current.id, current);
	if (!current.finishedAt) {
		emitRunningHandoff(current, digest, args);
		process.exitCode = 2;
		return;
	}
	emit(current, digest, args, current.label);
	process.exitCode = exitCodeFor(digest.status);
}
