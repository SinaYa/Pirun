/** Commands that start, observe, retime, and stop runs. */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagString, type PirunArgs as Args } from '../pirun-args.ts';
import { HARNESS_CAN_FORK } from '../pirun-config.ts';
import { atomicWriteJson, updateOwnedLock } from '../pirun-files.ts';
import { terminateProcessTree } from '../pirun-process.ts';
import { humanClock, parseTimeAdjust, parseWaitTime } from '../pirun-time.ts';
import { DEFAULT_RETURN_AFTER_SECONDS } from '../timeouts.ts';
import { die, humanDuration, isAlive, missingFileHint, out, state } from './context.ts';
import { ensureHarnessAuthentication } from './auth.ts';
import { resolveModel } from './preset.ts';
import {
	agentLockPath,
	jobDir,
	lockAgent,
	presetJobs,
	readAgent,
	readMeta,
	readPresetJob,
	unlockAgent,
	validAgentName,
	writeAgent,
	writeMeta,
	type AgentMeta,
	type JobMeta
} from './store.ts';
import { buildDigest, exitCodeFor, type Digest } from './digest.ts';
import { emit, emitRunningHandoff } from './render.ts';
import {
	announce,
	createJob,
	finaliseIfExited,
	observeJob,
	runToCompletion,
	startSupervisor
} from './spawn.ts';

export function readTask(args: Args): string {
	const prefix = state.preset.prefix?.trim();
	const withPrefix = (task: string) => (prefix ? `${prefix}\n\n${task}` : task);
	const inline = flagString(args, 'task');
	if (inline) return withPrefix(inline);

	const file = flagString(args, 'file');
	if (file) {
		if (!existsSync(file)) die(`prompt file not found: ${file}${missingFileHint(file)}`);
		return withPrefix(readFileSync(file, 'utf8'));
	}

	if (args.positional.length) return withPrefix(args.positional.join(' '));

	if (state.stdinUsedForPrefix) {
		die('stdin already carried the prefix (--prefix-file -); pass the task with --task "…", --file <path>, or positionally.');
	}
	if (process.stdin.isTTY) {
		die('no task given. Pass --task "…", --file <path>, a positional argument, or pipe it on stdin.');
	}
	return withPrefix(readFileSync(0, 'utf8'));
}

export async function commandRun(args: Args) {
	await ensureHarnessAuthentication();
	const task = readTask(args);
	const meta = createJob(args, task);
	announce(meta);
	startSupervisor(meta);
	await observeJob(meta, args);
}

/**
 * Fold a finished exchange back into the agent: learn Pi's session id from the
 * first run so later turns can continue it, and accumulate the token totals
 * that make the cache saving visible in `pirun agents`.
 */
function absorbRun(agent: AgentMeta, meta: JobMeta, digest: Digest) {
	if (!agent.sessionId && digest.sessionId) agent.sessionId = digest.sessionId;
	agent.lastRunAt = meta.finishedAt ?? Date.now();
	agent.exchanges += 1;
	agent.runs.push(meta.id);
	agent.totals.input += digest.inputTokens;
	agent.totals.cached += digest.cachedTokens;
	agent.totals.output += digest.outputTokens;
	agent.totals.cost += digest.cost;
	if (digest.contextTokens) agent.contextTokens = digest.contextTokens;
	writeAgent(agent);
}

export async function commandAgent(args: Args) {
	await ensureHarnessAuthentication();
	const name = args.positional[0];
	if (!name) die('usage: pirun agent <preset> <name> <task…>');
	if (!validAgentName(name)) die(`"${name}" is not a usable agent name (letters, digits, . _ -).`);

	const task = readTask({ ...args, positional: args.positional.slice(1) });
	const lockToken = lockAgent(name);
	let meta: JobMeta;
	try {
		let agent = readAgent(name);
		if (!agent) {
			agent = {
				name,
				preset: state.presetName,
				harness: state.preset.harness,
				cwd: resolve(flagString(args, 'dir') || process.cwd()),
				model: resolveModel(flagString(args, 'model')),
				createdAt: Date.now(),
				lastRunAt: Date.now(),
				exchanges: 0,
				runs: [],
				totals: { input: 0, cached: 0, output: 0, cost: 0 }
			};
			writeAgent(agent);
		} else {
			if (agent.preset && agent.preset !== state.presetName) {
				throw new Error(`agent "${name}" belongs to preset "${agent.preset}", not "${state.presetName}".`);
			}
			if (!agent.preset) {
				agent.preset = state.presetName;
				writeAgent(agent);
			}
			if ((agent.harness ?? 'pi') !== state.preset.harness) {
				throw new Error(`agent "${name}" belongs to the ${agent.harness ?? 'pi'} harness, not ${state.preset.harness}.`);
			}
			const wantedDir = flagString(args, 'dir');
			if (wantedDir && resolve(wantedDir) !== agent.cwd) {
				throw new Error(
					`agent "${name}" works in ${agent.cwd}. Retire it, or use a different name for ${resolve(wantedDir)}.`
				);
			}
			if (flagString(args, 'model') && resolveModel(flagString(args, 'model')) !== agent.model) {
				throw new Error(`agent "${name}" is running ${agent.model}. Switching models mid-session would discard its cached prefix.`);
			}
		}
		meta = createJob(args, task, agent, `${name} #${agent.exchanges + 1}`, lockToken);
		announce(meta);
		startSupervisor(meta);
	} catch (error) {
		unlockAgent(name, lockToken);
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(meta, args);
}

export async function commandFork(args: Args) {
	if (!HARNESS_CAN_FORK[state.preset.harness]) {
		die(`${state.preset.harness === 'antigravity' ? 'Antigravity' : state.preset.harness} does not expose conversation forking; start a new named agent instead.`);
	}
	const [parentName, childName] = args.positional;
	if (!parentName || !childName) die('usage: pirun fork <preset> <parent> <child> <task…>');
	if (!validAgentName(childName)) die(`"${childName}" is not a usable agent name.`);

	const parent = readAgent(parentName);
	if (!parent) die(`no agent "${parentName}". Try \`pirun agents ${state.presetName}\`.`);
	if (parent.preset && parent.preset !== state.presetName) {
		die(`agent "${parentName}" belongs to preset "${parent.preset}", not "${state.presetName}".`);
	}
	if (!parent.sessionId) die(`agent "${parentName}" has no session yet — give it a task first.`);
	const task = readTask({ ...args, positional: args.positional.slice(2) });
	const lockToken = lockAgent(childName);
	let meta: JobMeta;
	try {
		if (readAgent(childName)) throw new Error(`agent "${childName}" already exists.`);
		const child: AgentMeta = {
			name: childName,
			preset: state.presetName,
			harness: 'pi',
			cwd: parent.cwd,
			model: parent.model,
			createdAt: Date.now(),
			lastRunAt: Date.now(),
			forkedFrom: parent.sessionId,
			exchanges: 0,
			runs: [],
			totals: { input: 0, cached: 0, output: 0, cost: 0 }
		};
		writeAgent(child);
		meta = createJob(args, task, child, `${childName} #1 forked from ${parentName}`, lockToken);
		announce(meta);
		startSupervisor(meta);
	} catch (error) {
		unlockAgent(childName, lockToken);
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(meta, args);
}

export async function commandStart(args: Args) {
	await ensureHarnessAuthentication();
	const task = readTask(args);
	const meta = createJob(args, task);
	const supervisor = startSupervisor(meta);
	out(`[${meta.id}] STARTED  ${meta.model}  supervisor=${supervisor.pid}`);
	out(`wait: pirun wait ${meta.preset} ${meta.id}`);
}

export async function commandSupervise(args: Args) {
	const id = args.positional[0];
	if (!id) die('missing supervised run id.');
	const readyDeadline = Date.now() + 5000;
	let meta = readMeta(id);
	while (meta.supervisorPid !== process.pid && Date.now() < readyDeadline) {
		await new Promise((resolveReady) => setTimeout(resolveReady, 25));
		meta = readMeta(id);
	}
	if (meta.supervisorPid !== process.pid) {
		throw new Error(`Run ${id} was not assigned to supervisor ${process.pid}.`);
	}
	if (meta.agent) {
		if (!meta.agentLockToken) throw new Error(`Run ${id} has no agent lock token.`);
		updateOwnedLock(agentLockPath(meta.agent), meta.agentLockToken, process.pid, id);
	}
	meta.supervisorReadyAt = Date.now();
	writeMeta(meta);
	try {
		await runToCompletion(meta);
		const digest = buildDigest(id, meta);
		atomicWriteJson(resolve(jobDir(id), 'digest.json'), digest);
		if (meta.agent) {
			const agent = readAgent(meta.agent);
			if (!agent) throw new Error(`Agent "${meta.agent}" disappeared while run ${id} was active.`);
			absorbRun(agent, meta, digest);
		}
		writeMeta(meta);
	} catch (error) {
		meta.finishedAt = Date.now();
		meta.exitCode = 1;
		meta.supervisorError = error instanceof Error ? error.message : String(error);
		writeMeta(meta);
		appendFileSync(
			resolve(jobDir(id), 'events.jsonl'),
			`${JSON.stringify({ type: 'pirun_supervisor_error', error: meta.supervisorError })}\n`
		);
	} finally {
		if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	}
}

export async function commandWait(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	// wait's --time is only its own blocking limit; it never rewrites the
	// already-running job's hard deadline (that is what `pirun time` is for).
	let returnAfterSec = DEFAULT_RETURN_AFTER_SECONDS;
	try {
		returnAfterSec = parseWaitTime(flagString(args, 'time'), DEFAULT_RETURN_AFTER_SECONDS);
	} catch (error) {
		die(error instanceof Error ? error.message : String(error));
	}
	await observeJob(readPresetJob(id), args, returnAfterSec);
}

/**
 * Show or move a live run's hard deadline. `+30m` adds to the current
 * deadline; a bare `45m` sets it to 45 minutes from now — the reference point
 * is always in the spelling.
 */
export function commandTime(args: Args) {
	const tokens = [...args.positional];
	let adjustRaw = '';
	if (tokens.length && /^\+|^\d/.test(tokens[tokens.length - 1]) && !/^[0-9a-f]{6}$/.test(tokens[tokens.length - 1])) {
		adjustRaw = tokens.pop() as string;
	}
	const id = tokens[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	const meta = finaliseIfExited(readPresetJob(id));
	if (meta.finishedAt) {
		out(`[${id}] already finished; nothing to retime.`);
		return;
	}
	let deadline = meta.deadlineAt ?? (meta.piStartedAt ?? meta.startedAt) + meta.timeoutSec * 1000;
	if (adjustRaw) {
		let adjust;
		try {
			adjust = parseTimeAdjust(adjustRaw);
		} catch (error) {
			die(error instanceof Error ? error.message : String(error));
		}
		deadline = adjust.mode === 'add' ? deadline + adjust.seconds * 1000 : Date.now() + adjust.seconds * 1000;
		meta.deadlineAt = deadline;
		writeMeta(meta);
	}
	out(`[${id}] hard stop ${humanClock(deadline)} (in ${humanDuration(Math.max(0, deadline - Date.now()))})`);
	if (!adjustRaw) out(`extend: pirun time ${state.presetName} ${id} +30m   set from now: pirun time ${state.presetName} ${id} 45m`);
}

export function commandPoll(args: Args) {
	const id = args.positional[0] ?? presetJobs()[0]?.id;
	if (!id) die('no runs yet.');
	const meta = finaliseIfExited(readPresetJob(id));
	const digest = buildDigest(id, meta);
	if (!meta.finishedAt) emitRunningHandoff(meta, digest, args);
	else emit(meta, digest, args, meta.label);
	process.exitCode = exitCodeFor(digest.status);
}

export function commandStopJob(args: Args) {
	const id = args.positional[0];
	if (!id) die('usage: pirun kill <preset> <id>');
	let meta = finaliseIfExited(readPresetJob(id));
	if (meta.finishedAt) {
		out(`[${id}] already finished`);
		return;
	}

	// A deliberate stop must read as KILLED afterwards, never FAILED.
	meta.killedAt = Date.now();
	writeMeta(meta);

	// Once Pi has started, stop it and leave the live supervisor to record the
	// real exit and release any named-agent lock. Before that hand-off, the only
	// process to stop is the supervisor itself, so finalise the record here.
	if (meta.pid && meta.supervisorPid && meta.pid !== meta.supervisorPid && isAlive(meta.pid)) {
		terminateProcessTree(meta.pid);
		out(`[${id}] stop requested`);
		return;
	}
	if (meta.supervisorPid && isAlive(meta.supervisorPid)) process.kill(meta.supervisorPid);
	meta = finaliseIfExited(readMeta(id));
	if (!meta.finishedAt) {
		meta.finishedAt = Date.now();
		meta.exitCode = 130;
		meta.interrupted = true;
		writeMeta(meta);
		if (meta.agent) unlockAgent(meta.agent, meta.agentLockToken);
	}
	out(`[${id}] killed`);
}
