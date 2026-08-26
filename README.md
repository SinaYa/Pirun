# pirun

The stable front door for delegating work to coding-agent harness CLIs. An
orchestrating AI (or a human) says *what* to run, on *which* provider/account,
with *which* timers — pirun drives the harness, keeps the full event stream on
disk, and hands back a compact digest with an actionable exit code.

Two ways to consume models, one grammar:

- **Harness accounts** — e.g. `--use antigravity/<account>`: the Antigravity
  CLI on an isolated, authenticated Google account.
- **OpenAI-completions endpoints** — e.g. `--use deepseek`: any
  OpenAI-compatible API, driven through the Pi harness. Canonical endpoints
  (openai, deepseek, openrouter, groq, mistral, xai) ship with base URL, compat
  quirks, and a starter model catalog; anything else (a local proxy included)
  is added once with `pirun provider add <name> --base-url <url>`.

```
pirun/
  install.bat      one-time setup — run this first (or: node bin/install.ts)
  pirun.bat        the `pirun` CLI
  pirun.json       ignored presets (use/model/effort/prefix/behavior); credentials
                   live in the machine-global %LOCALAPPDATA%\Pirun\providers.json
  .env             optional endpoint API keys (gitignored)
  FOR-AGENTS.md    runbook for an AI delegating work    <- start here
  LIMITATIONS.md   what cannot be reported yet, and what would have to change
  HANDOFF.md       intent, decisions, constraints (read first in a new session)
  bin/ src/ test/  the CLI (TypeScript, run directly by Node — no build)
```

## Setup

```bash
node bin/install.ts
```

or double-click **`install.bat`**. It checks Node (22.18+; the `.ts` sources
run directly), installs dependencies, installs the Pi CLI, and puts `pirun` on
PATH. Safe to re-run; `--uninstall` reverses it. `npm install` also arms a
pre-commit hook that enforces the 400-line source-file cap (`npm run
setup-hooks` re-arms it manually).

## Presets

Every preset command takes its preset name immediately after the command. The
first launch creates the preset; later invocations load omitted settings and
persist supplied ones. No setup step. Prompts and `--time` are invocation-only;
`--use`, model, effort, prefix, dir, and tool/context-file/output behavior
persist. A fresh preset must name its provider once:

```bash
pirun agent fast worker --time 10m/2h "Inspect the repository" --use deepseek --model deepseek-chat
pirun agent fast worker --time 10m/2h "Now implement it"
```

## Providers: shared authentication, presets as pointers

Consumption sources and their credentials live in one machine-global store
(`%LOCALAPPDATA%\Pirun\providers.json`), never in presets. A preset selects one
with `--use provider[/account]`; each provider holds any number of accounts.
`pirun providers [--json]` lists them all — providers, accounts, readiness,
models, default account.

- `--use deepseek` — canonical endpoints need zero setup when their standard
  env var is set: `DEEPSEEK_API_KEY` auto-creates account `main`; the suffix
  convention `DEEPSEEK_API_KEY_WORK` auto-creates account `work` for
  `--use deepseek/work`. Explicitly: `pirun provider key deepseek work --env VAR`
  (or `--key <literal>`). Only the reference persists, never the secret; a
  local `.env` is loaded if present.
- `--use myapi` — custom endpoints: `pirun provider add myapi --base-url <url>`,
  compat via `provider set` (`--no-auth-header`, `--no-developer-role`,
  `--reasoning-effort`), per-model limits via `provider model`.
- `--use antigravity/<account>` — harness accounts (below).

Endpoint presets register as native Pi `openai-completions` providers keyed by
provider/account, shared between presets. `--model` accepts any unambiguous
fragment of a catalog model id; `pirun models <preset> --refresh` pulls the
live `/models` list into the catalog. `--effort off|min|low|medium|high|max|<n>k`
stores reasoning *intent*, mapped per model at call time (Pi `--thinking`
levels, Antigravity effort tiers) — safe for knobless models.
`--prefix`/`--prefix-file` persist text prepended to every prompt of the
preset; `--no-prefix` clears it.

`pirun spend [provider[/account]] [--json]` is one interface for every source:
endpoint accounts report credits/balance (DeepSeek balance, OpenRouter
credits); Antigravity accounts report five-hour/weekly/monthly limit windows
with percent remaining and reset times, fetched through `agy -p "/usage"`
itself.

## Antigravity harness and isolated accounts

`--use antigravity/<account>` runs the `agy` CLI on its own Google account and
models. Each *account* gets one isolated profile (OAuth token, settings, cache,
conversations, MCP state) under the Pirun state directory; any number of
presets share it, and different accounts stay signed in and run concurrently.
Authenticate once per account:

```bash
pirun login antigravity work-google
pirun agent g worker --time 10m/2h "Implement the change" --use antigravity/work-google
```

The first launch of an unauthenticated account also triggers login. On Windows
the login opens a separate visible console window, so there is always a real
terminal for Google's authorization code even when Pirun was invoked by a
script or agent: sign in via browser, paste the code there, `/quit` when the
account shows. `--inline` keeps the flow in the current terminal.
`pirun logout antigravity <account>` sets the profile aside recoverably.

Fresh profiles are seeded with `enableTelemetry: false` (existing settings are
never overwritten). OAuth credentials never enter `pirun.json`,
`providers.json`, or the repository; before login Pirun verifies `agy` selected
file-backed token storage and refuses if it falls back to the shared OS
keyring. Antigravity defaults to automatic model selection; `--model`,
`--effort`, and `--antigravity-agent` override persistently. With tools on
(default) headless runs use its all-tools approval mode; `--no-tools` keeps
Antigravity's normal permission policy.

## Timers

`--time <return-after>/<timeout>` (e.g. `10m/2h`) is **required** on every
`run`/`agent`/`fork`/`start` and never persisted — no defaults, so a caller
always chose both answers. **return-after** is "when do I next look?": it
bounds only the invoking command, which returns by then with either the result
or a progress digest and run id (exit code 2) while the detached supervisor
keeps the run going. Both parts must be positive — there is no fire-and-forget
flag; background the pirun command itself instead. **timeout** is "how long
would prove something is wrong?": a failure detector rather than a completion
estimate, set past any healthy duration so it firing means the run was broken,
not slow. It stays live: `pirun time <preset> <id> +30m` extends it, `… 45m`
sets it to 45 minutes from now, no argument shows it. `pirun wait <preset>
<id> --time 5m` re-attaches without touching the deadline.

## Storage

Run storage is bounded conservatively. Finished one-shot runs and orphaned
sessions older than 30 days are pruned when a new run starts, while
active-agent history is retained. `PIRUN_RETENTION_DAYS` changes the age and
`PIRUN_MAX_STORAGE_MB` changes the default 1024 MB ceiling.
`pirun retire <preset> <name>` removes the retired agent's Pi session;
`pirun clean <preset> --sessions` removes other orphaned sessions.

## Development

`npm test` runs the offline suite plus the anti-bloat guard (no source file
over 400 lines; `scripts/max-lines.mjs`, also a pre-commit hook). `npm run
check` syntax-checks every source file. Tests never touch OAuth, browsers, or
live accounts. The full command reference is `pirun help`; the AI-facing
runbook is [FOR-AGENTS.md](FOR-AGENTS.md).
