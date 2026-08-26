#!/usr/bin/env node
/**
 * pirun — a persistent front door to coding-agent harnesses.
 *
 * Pi's own non-interactive modes make an operating agent choose badly:
 *   `-p` prints the final message and nothing else, so a run that failed
 *   mid-stream is indistinguishable from a model that had nothing to say;
 *   `--mode json` tells you everything but costs hundreds of lines of event
 *   stream in the caller's context for a two-tool task.
 *
 * pirun takes the JSON stream, keeps it on disk in full, and hands back a
 * three-line digest. It also does the things the community subagent skills tell
 * you to remember — lean flags, prompt out of argv — by default instead of by
 * discipline, and it correlates a silent Pi run against the proxy's own log so
 * "empty answer" comes back with the upstream error attached.
 *
 * This file is only the dispatcher; every concern lives in src/cli/.
 */

import { parsePirunArgs, PROVIDER_COMMANDS, type PirunArgs as Args } from '../src/pirun-args.ts';
import { die, out } from '../src/cli/context.ts';
import { configurePreset } from '../src/cli/preset.ts';
import { startProxy, stopProxy } from '../src/cli/proxy.ts';
import {
	commandAgent,
	commandFork,
	commandPoll,
	commandRun,
	commandStart,
	commandStopJob,
	commandSupervise,
	commandTime,
	commandWait
} from '../src/cli/commands-lifecycle.ts';
import { commandAgents, commandRetire } from '../src/cli/commands-agents.ts';
import {
	commandLogin,
	commandLogout,
	commandProvider,
	commandProviders
} from '../src/cli/commands-providers.ts';
import { commandSpend } from '../src/cli/commands-spend.ts';
import {
	commandClean,
	commandConfig,
	commandJobs,
	commandLog,
	commandModel,
	commandModels,
	commandStatus
} from '../src/cli/commands-info.ts';
import { commandHelp } from '../src/cli/help.ts';

let args: Args;
try {
	args = parsePirunArgs(process.argv.slice(2));
} catch (error) {
	die(error instanceof Error ? error.message : String(error));
}

if (!['_supervise', 'help', '--help', '-h'].includes(args.command) && !PROVIDER_COMMANDS.has(args.command)) {
	configurePreset(args);
}

switch (args.command) {
	case 'agent':
		await commandAgent(args);
		break;
	case 'agents':
		commandAgents(args);
		break;
	case 'fork':
		await commandFork(args);
		break;
	case 'retire':
		commandRetire(args);
		break;
	case 'run':
		await commandRun(args);
		break;
	case 'start':
		await commandStart(args);
		break;
	case '_supervise':
		await commandSupervise(args);
		break;
	case 'poll':
		commandPoll(args);
		break;
	case 'wait':
		await commandWait(args);
		break;
	case 'jobs':
		commandJobs();
		break;
	case 'log':
		commandLog(args);
		break;
	case 'kill':
		commandStopJob(args);
		break;
	case 'clean':
		commandClean(args);
		break;
	case 'status':
		await commandStatus();
		break;
	case 'config':
		commandConfig();
		break;
	case 'login':
		await commandLogin(args);
		break;
	case 'logout':
		commandLogout(args);
		break;
	case 'providers':
		commandProviders(args);
		break;
	case 'provider':
		await commandProvider(args);
		break;
	case 'spend':
		await commandSpend(args);
		break;
	case 'time':
		commandTime(args);
		break;
	case 'models':
		await commandModels(args);
		break;
	case 'model':
		commandModel(args);
		break;
	case 'speedtest': {
		const { runSpeedTestCli } = await import('./speed-test.ts');
		await runSpeedTestCli(args.positional);
		break;
	}
	case 'up': {
		const result = await startProxy();
		out(result.started ? 'service started' : 'service already running');
		break;
	}
	case 'restart': {
		await stopProxy();
		await new Promise((r) => setTimeout(r, 500));
		await startProxy();
		out('service restarted');
		break;
	}
	case 'down': {
		const result = await stopProxy();
		out(`service ${result === 'still up' ? 'still running' : result}`);
		if (result === 'still up') process.exitCode = 1;
		break;
	}
	case 'help':
	case '--help':
	case '-h':
		commandHelp();
		break;
	default:
		die(`unknown command "${args.command}". Run "pirun help".`);
}
