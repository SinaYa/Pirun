# pirun

Front door for delegating work to coding-agent harness CLIs. An orchestrating
AI (or a human) names the task, the provider/account, and the timers; pirun
drives the harness, keeps the full event stream on disk, and returns a compact
digest with an actionable exit code (`0` output · `1` failed/empty/timeout/
killed · `2` still running).

Two consumption sources, one grammar:

| Source | Example | Needs |
|---|---|---|
| OpenAI-completions endpoints | `--use deepseek`, `--use myapi` | an API key |
| Harness accounts (Antigravity) | `--use antigravity/<account>` | one browser sign-in |

## Install

An orchestrating AI can perform every step; pointing it at this repo is
enough. Windows, macOS, Linux.

1. Node.js ≥ 22.18 (`winget install OpenJS.NodeJS.LTS`). No build step — the
   TypeScript sources run directly.
2. Clone this repo, `cd` into it.
3. `node bin/install.ts` — installs dependencies and the Pi CLI, puts `pirun`
   on PATH. Re-runnable; `--no-pi` skips Pi (Antigravity-only use);
   `--uninstall` reverses everything it did.
4. Antigravity only: install the `agy` CLI yourself — pirun drives it but
   never installs it.
5. Endpoints only: set the provider's key (`DEEPSEEK_API_KEY=…`, or `.env`
   here, or `pirun provider key <provider> <account> --env VAR`).

Then hand the AI [FOR-AGENTS.md](FOR-AGENTS.md) — the complete runbook.
`pirun help` is the command reference. [ORCHESTRATION.md](ORCHESTRATION.md)
is an optional standing prompt of delegation strategy an orchestrator can
adopt as it sees fit.

## Presets

`pirun <command> <preset> …` everywhere. A preset is a persistent pointer:
provider/account (`--use`), model, effort, prefix, dir, behavior flags.
Settings supplied on a launch persist into it; omitted ones load from it.
Prompts and `--time` never persist. No setup command; the first launch names
`--use` once (no default provider):

```bash
pirun agent fast worker --time 10m/2h "Inspect the repo" --use deepseek --model <model-id>
pirun agent fast worker --time 10m/2h "Now implement it"
```

Named agents remember prior turns (and keep the provider's prefix cache);
`run` is one-shot; `fork` branches a primed agent. `--time
<return-after>/<timeout>` is required on every start: return-after bounds only
your wait (exit 2 + progress digest, run continues detached); timeout is the
hard stop, live-movable with `pirun time <preset> <id> +30m`. Digest answers
cap at 2000 chars; `pirun poll <preset> <id> --answer` prints the complete
response text alone, ready to redirect into a file.

## Providers

Credentials live in one machine-global store
(`%LOCALAPPDATA%\Pirun\providers.json`), never in presets. `pirun providers
[--json]` shows everything `--use` can say.

- Canonical endpoints (openai, deepseek, openrouter, groq, mistral, xai):
  zero setup when the standard env var is set — `DEEPSEEK_API_KEY` auto-creates
  account `main`, `DEEPSEEK_API_KEY_WORK` account `work`.
- Custom endpoints (a local proxy included): `pirun provider add myapi
  --base-url <url>`, compat flags via `provider set`, model limits via
  `provider model`.
- `--model` resolves any unambiguous fragment against the provider catalog;
  `pirun models <preset> --refresh` pulls the live `/models` list. `--effort
  off|min|low|medium|high|max|<n>k` is stored intent, mapped per model/harness
  at call time. `--prefix` persists standing instructions per preset,
  delivered once on each fresh context's first prompt (never repeated on an
  agent's follow-up turns).
- `--permissions read|ask|edit|all` — what the agent may do without a grant,
  mapped per harness (Antigravity: plan / accept-edits / skip-permissions;
  Pi: tool scopes). Default `edit`. Denied actions surface in the digest as
  `permission:` asks with the exact widening command; levels a harness cannot
  honor are refused naming the alternatives.
- `pirun spend [provider[/account]]`: endpoint accounts → credits/balance;
  Antigravity accounts → five-hour/weekly/monthly windows, % remaining, reset
  times.

## Antigravity accounts

`pirun login antigravity <name>` — once per account; first use also triggers
it. Each account gets an isolated profile (OAuth token, settings,
conversations); accounts run signed-in concurrently. The sign-in is pirun's
own dialog — Antigravity's UI never appears: the browser opens, the human
signs in with Google, pastes the authorization code if shown, done. On
Windows a separate paste-ready console window opens (closes itself on
success), so headless AI invocations still reach a human terminal; `--inline`
stays in the current one.

Isolation is verified, not assumed: pirun refuses to log in if `agy` would use
the shared OS keyring. Fresh profiles are seeded `enableTelemetry: false`.
Credentials never enter presets, the store, or the repo. `logout` sets the
profile aside recoverably.

Auth stays alive on its own: any pirun invocation notices accounts idle past
`PIRUN_AUTH_KEEPALIVE_DAYS` (default 3, `0` disables) and refreshes them in a
detached worker via one ordinary `agy` usage call — unused accounts stay
signed in.

## Storage and development

All state — presets, runs, profiles — lives in the machine-global Pirun home
(`%LOCALAPPDATA%\Pirun`, or `~/.local/state/pirun`), never in this folder:
the clone is replaceable without losing anything. Finished one-shots and
orphaned sessions are pruned
after 30 days (`PIRUN_RETENTION_DAYS`) or 1024 MB (`PIRUN_MAX_STORAGE_MB`);
active-agent history is kept. `pirun retire`/`clean` remove the rest.

`npm test` — offline suite + the anti-bloat guard (no source file over 400
lines; also a pre-commit hook, re-armed by `npm install`). `npm run check` —
syntax-check all sources. Tests never touch OAuth, browsers, or live
accounts. Known gaps: [LIMITATIONS.md](LIMITATIONS.md). Session handoff:
[HANDOFF.md](HANDOFF.md).
