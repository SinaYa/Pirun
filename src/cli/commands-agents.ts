/** Commands for the named-agent roster. */

import { rmSync } from 'node:fs';
import { readOwnedLock } from '../pirun-files.ts';
import type { PirunArgs as Args } from '../pirun-args.ts';
import { die, humanDuration, humanTokens, isAlive, out, state } from './context.ts';
import { catalogue } from './pi.ts';
import {
	agentDir,
	agentIsBusy,
	agentLockPath,
	presetAgents,
	readAgent,
	removeAgentSessions,
	type AgentMeta
} from './store.ts';

function agentStats(agent: AgentMeta) {
	const row = catalogue().find((entry) => entry.id === agent.model);
	const window = row?.contextWindow ?? 0;
	const used = agent.contextTokens ?? 0;
	const total = agent.totals.input + agent.totals.cached;
	return {
		window,
		used,
		usedPercent: window ? Math.round((used / window) * 100) : 0,
		headroom: window ? Math.max(0, window - used) : 0,
		hitPercent: total ? Math.round((agent.totals.cached / total) * 100) : 0,
		busy: agentIsBusy(agent.name)
	};
}

export function commandAgents(args: Args) {
	const agents = presetAgents();
	if (!agents.length) {
		out(`no agents. Create one: pirun agent ${state.presetName} <name> "<task>"`);
		return;
	}

	const wanted = args.positional[0];
	if (wanted) {
		const agent = readAgent(wanted);
		if (!agent) die(`no agent "${wanted}".`);
		const stats = agentStats(agent);
		if (args.flags.has('json')) {
			out(JSON.stringify({ ...agent, stats }, null, 2));
			return;
		}
		const age = humanDuration(Date.now() - agent.lastRunAt);
		out(`${agent.name}  ${agent.model}${stats.busy ? '  [busy]' : ''}`);
		out(`  dir        ${agent.cwd}`);
		out(`  exchanges  ${agent.exchanges}   last active ${age} ago`);
		out(
			`  context    ${humanTokens(stats.used)} / ${humanTokens(stats.window)}` +
				`  (${stats.usedPercent}% used, ${humanTokens(stats.headroom)} left)`
		);
		out(
			`  tokens     in ${humanTokens(agent.totals.input)} uncached · ` +
				`${humanTokens(agent.totals.cached)} cached (${stats.hitPercent}% hit) · ` +
				`out ${humanTokens(agent.totals.output)}`
		);
		if (agent.forkedFrom) out(`  forked     from session ${agent.forkedFrom.slice(0, 8)}`);
		if (agent.sessionId) out(`  session    ${agent.sessionId}`);
		out(`  runs       ${agent.runs.slice(-8).join(' ')}`);
		return;
	}

	if (args.flags.has('json')) {
		out(JSON.stringify(agents.map((agent) => ({ ...agent, stats: agentStats(agent) })), null, 2));
		return;
	}
	for (const agent of agents) {
		const stats = agentStats(agent);
		out(
			`${agent.name.padEnd(16)} x${String(agent.exchanges).padEnd(3)} ` +
				`ctx ${(humanTokens(stats.used) + '/' + humanTokens(stats.window)).padStart(14)} (${String(stats.usedPercent).padStart(3)}%)  ` +
				`in=${humanTokens(agent.totals.input).padStart(6)} cached=${humanTokens(agent.totals.cached).padStart(6)} (${String(stats.hitPercent).padStart(3)}%) ` +
				`out=${humanTokens(agent.totals.output).padStart(6)}${stats.busy ? '  [busy]' : ''}`
		);
		out(`${' '.repeat(16)} ${agent.model}${agent.forkedFrom ? '  (forked)' : ''}`);
	}
}

export function commandRetire(args: Args) {
	const names = args.flags.has('all') ? presetAgents().map((agent) => agent.name) : args.positional;
	if (!names.length) die('usage: pirun retire <preset> <name> | --all');
	for (const name of names) {
		const agent = readAgent(name);
		if (!agent) {
			out(`${name}: no such agent`);
			continue;
		}
		const lock = readOwnedLock(agentLockPath(name));
		if (lock && isAlive(lock.pid)) {
			out(`${name}: still busy (pid ${lock.pid}) — not retired`);
			continue;
		}
		removeAgentSessions(agent);
		rmSync(agentDir(name), { recursive: true, force: true });
		out(`${name}: retired after ${agent.exchanges} exchange(s)`);
	}
}
