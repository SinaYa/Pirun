/** `pirun help` — the complete command reference. */

import { CANONICAL_ENDPOINTS, endpointEnvVar } from '../pirun-providers.ts';
import { out, PIRUN_CONFIG } from './context.ts';

export function commandHelp() {
	out(`pirun — delegate work to persistent coding-agent harnesses.

Every preset command takes its preset name immediately after the command.
Options supplied while starting an agent automatically update that preset in
${PIRUN_CONFIG}; omitted options load from it. There is no setup step.
Prompts and --time are never persisted. Authentication lives in the shared
provider store, not in presets — authenticate once, use from any preset.

  pirun agent <preset> <name> --time <ra>/<to> <task…>
                                   give a named agent a task; it remembers
  pirun agents <preset> [<name>] [--json]
                                   roster, or one agent's context and token use
  pirun fork <preset> <parent> <child> --time <ra>/<to> <task…>
                                   branch a primed agent; the child inherits
                                   its context, and the provider's cache
  pirun retire <preset> <name> | --all
                                   end an agent and drop its session

  pirun run <preset> --time <ra>/<to> <task…>
                                   one-shot, no memory; for throwaway work
  pirun start <preset> --time <ra>/<to> <task…>
                                   one-shot, detached; prints a run id
  pirun poll <preset> [id] [--full|--answer|--json]
                                   digest for a run (default: the most recent);
                                   --answer prints only the complete response
                                   text, ready to redirect into a file
  pirun wait <preset> [id] [--time <dur>] [--full|--answer|--json]
                                   re-attach to a run for up to <dur> (default 10m)
  pirun time <preset> [id] [+30m|45m]
                                   show or move a live run's hard stop:
                                   +30m extends it, 45m sets it from now
  pirun jobs <preset>              recent runs, one line each
  pirun log <preset> [id] [--grep <text>]
                                   the raw JSON event stream for a run
  pirun kill <preset> <id>         stop a run
  pirun clean <preset> [--all|--sessions]
                                   delete old runs or orphaned sessions

  pirun config <preset>            inspect the selected preset
  pirun status <preset>            service, harness and model wiring at a glance
  pirun models <preset|provider> [filter] [--json] [--refresh]
                                   a preset's — or, with no preset yet, any
                                   provider's — model catalog (--refresh pulls
                                   the live /models list)
  pirun model <preset> [<id>]      show or set the preset's model

Provider store (shared across presets; no preset argument):
  pirun providers [--json]         every provider, account, and readiness —
                                   the one call that shows what --use can say
  pirun login antigravity <account>
                                   authenticate an isolated harness account
                                   (Windows opens a separate paste-ready login
                                   window; --inline stays in this terminal)
  pirun logout antigravity <account>
  pirun provider add <name> --base-url <url>
                                   register a custom OpenAI-compatible endpoint
  pirun provider set <name> [--base-url <url>] [compat flags]
  pirun provider key <provider> <account> [--env VAR | --key VALUE]
                                   add or replace an api-key account
  pirun provider default <provider> <account>
  pirun provider rm <provider>[/<account>]
  pirun provider model <provider> <id> [--context-window n] [--max-tokens n]
                                   [--reasoning|--no-reasoning]
  pirun spend [provider[/account]] [--json]
                                   one interface for every source: endpoint
                                   accounts report credits/balance, harness
                                   accounts report their rate-limit windows
                                   (five-hour/weekly/monthly) and reset times

Timers are required on every start and never persisted:
  --time <return-after>/<timeout>  e.g. --time 10m/2h — the caller gets its
  progress checkpoint after 10m (exit code 2, run keeps going), and the run is
  hard-stopped at 2h. Both parts must be positive; to run unattended,
  background the pirun command itself.

Persistent preset options (accepted by every preset command):
  --use <provider[/account]>       the consumption source. Canonical endpoints
                                   (${Object.keys(CANONICAL_ENDPOINTS).join(', ')})
                                   need zero setup when their standard env var
                                   is set (${endpointEnvVar('deepseek')}, or
                                   ${endpointEnvVar('deepseek')}_<ACCOUNT> per account).
                                   Harness accounts: --use antigravity/<account>.
                                   Custom endpoints: pirun provider add first.
  --model <id-or-fragment>         resolved against the provider's catalog
  --effort <off|min|low|medium|high|max|Nk>
                                   reasoning intent, mapped per model — safe to
                                   set even for models without a knob
  --permissions <read|ask|edit|all>
                                   what the agent may do without a grant,
                                   mapped per harness (default: edit). A level
                                   a harness cannot honor is refused with its
                                   alternatives; denied actions surface in the
                                   digest as permission asks
  --prefix "<text>" | --prefix-file <path|-> | --no-prefix
                                   text prepended to every prompt of this
                                   preset; "-" reads it from stdin
  --dir <path>                     working directory for the preset's runs
  --antigravity-agent <name>       Antigravity persona for this preset
  --tools|--no-tools --context-files|--no-context-files
  --full|--no-full --json|--no-json

First launch (one command, everything persists):
  pirun agent fast worker --time 10m/2h "Implement the change" \\
    --use deepseek --model <model-id> --effort high

Later launches load the saved settings:
  pirun agent fast worker --time 10m/2h "Continue with the next change"

Exit status: 0 the run produced output, 1 it failed / came back empty / timed
out, 2 it is still running (poll again). A failed or empty digest carries the
provider's own error.`);
}
