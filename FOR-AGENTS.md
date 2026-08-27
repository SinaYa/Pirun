# Delegating work through Pirun

Use **`pirun`**, never a harness CLI directly. Setup if missing:

```powershell
node D:\projectx\pirun\bin\install.ts
```

## Grammar

Every command: `pirun <command> <preset> …`. A preset is a persistent pointer —
provider/account (`--use`), model, effort, permissions, prefix, dir, output
flags. Settings supplied on any launch persist into the preset; omitted ones
load from it. Prompts and `--time` never persist. There is no setup command.

```powershell
pirun agent local worker --time 10m/2h --use <provider[/account]> --model <model-id> --file C:\path\task.md
pirun agent local worker --time 10m/2h "Continue: address the review notes"
```

The first launch of a preset must name `--use`; after that it persists.

A named agent remembers its prior turns; reuse one name per subsystem so the
provider caches the prefix. `pirun run <preset> …` is one-shot with no memory.

Some models queue long for provider capacity before the first token; a slow
start is not a model failure — read the progress digest before judging.

## Providers and accounts (shared, outside presets)

Authentication lives in one machine-global store. `pirun providers --json`
returns every provider, account, and readiness in one call — everything
`--use` can say. Model catalogs: `pirun models <provider>` (no preset needed;
harness catalogs are fetched live from the harness).

| Source | Select with | Accounts come from |
|---|---|---|
| known endpoints: openai, deepseek, openrouter, groq, mistral, xai | `--use deepseek[/work]` | `DEEPSEEK_API_KEY` auto-creates `main`; `DEEPSEEK_API_KEY_WORK` auto-creates `work`; else `pirun provider key deepseek work --env VAR` |
| custom endpoint (a local proxy included) | `--use myapi[/acct]` | `pirun provider add myapi --base-url <url>`, then `provider key` |
| Antigravity harness | `--use antigravity/<account>` | `pirun login antigravity <account>` — opens a visible console window; the human completes the browser sign-in and pastes the code there |

`pirun spend [provider[/account]] [--json]` is the one consumption interface:
endpoint accounts answer with credits/balance; Antigravity accounts answer with
five-hour/weekly/monthly limits, % remaining, and reset times. Check it before
picking an account for heavy work. `pirun logout antigravity <account>` sets a
profile aside recoverably.

## Model, effort, permissions, prefix (persist per preset)

- `--model <fragment>` — an unambiguous fragment of an id resolves against the
  provider's catalog; unknown ids pass through to the API as given.
  `pirun models <preset|provider> [--refresh]` lists the catalog; `--refresh`
  pulls the live `/models`. Agents pin their model — switching mid-session is
  refused because it would discard the cached prefix.
- `--effort off|min|low|medium|high|max|<n>k` — reasoning intent, mapped at
  call time to whatever knob the model and harness actually speak. Safe to
  set even for models without one; the digest notes when it was ignored.
  Model ids that themselves encode an effort tier are auto-aligned: the tier
  becomes the stored effort, and a later `--effort` rewrites the id's tier —
  set either, never worry about both.
- `--permissions read|ask|edit|all` — what the agent may do without a grant,
  mapped to each harness's own mechanism (default `edit`). Know the ladder's
  sharp edges: `edit` allows file edits but NO commands, not even read-only
  ones; on some harnesses `read` maps to a plan mode that can deny even file
  reads headlessly — for a guaranteed read-only review, inline the content in
  the prompt instead of pointing at files. A level the harness cannot honor
  is refused naming the supported ones. When the agent wants something the
  level denies, the digest carries `permission:` lines with the exact
  widening command — treat them as the agent asking you; decide, then rerun
  or widen.
- `--prefix "…"` / `--prefix-file <path|->` / `--no-prefix` — text prepended
  to every prompt of the preset; `-` reads it from stdin
  (`echo rules | pirun config p --prefix-file -`), no temp file. Put standing
  instructions here once instead of repeating them per task.

## Timers — required, never persisted

`--time <return-after>/<timeout>` on every `run`/`agent`/`fork`/`start`, e.g.
`--time 10m/2h`. The two parts answer two different questions:

- **return-after — when do I next look?** Bounds only your wait, never the
  run. Both parts must be positive: there is no fire-and-forget flag, so you
  always come back for a decision. To run unattended, background the pirun
  command itself.
- **timeout — how long would prove something is wrong?** A failure detector,
  not a completion estimate: set it past any healthy duration for the task, so
  it firing means the run was broken, not slow. A visibly progressing run
  justifies moving it.

If the run outlives return-after you get **exit code 2** plus a progress digest
(turns, generated tokens, last-10s tok/s, time to hard stop) — the
stuck-vs-slow evidence. Then decide:

```powershell
pirun poll <preset> [id]             # progress now, never blocks
pirun wait <preset> [id] --time 5m   # re-attach for up to 5m
pirun time <preset> <id>             # show the hard stop
pirun time <preset> <id> +30m        # extend the deadline by 30m
pirun time <preset> <id> 45m         # set the deadline to now+45m
pirun kill <preset> <id>             # stop the run
```

Exit codes: `0` produced output · `1` failed/empty/timed out · `2` still
running. Branch on the code, not wording. Rule of thumb: return-after = your
check-in cadence; timeout = "longer than this can only mean failure."

## Commands

| Command | Purpose |
|---|---|
| `pirun agent <preset> <name> --time <ra>/<to> <task>` | persistent agent turn |
| `pirun fork <preset> <parent> <child> --time <ra>/<to> <task>` | branch a primed agent (harnesses without native forking reject this) |
| `pirun agents <preset> [name]` | context, token use, busy state |
| `pirun retire <preset> <name>` / `--all` | remove an idle agent |
| `pirun run <preset> --time <ra>/<to> <task>` | one-shot task |
| `pirun start <preset> --time <ra>/<to> <task>` | one-shot, returns immediately after announce |
| `pirun wait <preset> [id] [--time <dur>]` / `poll` | re-attach / inspect |
| `pirun time <preset> <id> [+30m\|45m]` | show / move the hard stop |
| `pirun jobs <preset>` / `log <id>` / `kill <id>` | list / diagnose / stop runs |
| `pirun providers [--json]` | all providers, accounts, readiness |
| `pirun provider key\|add\|set\|default\|rm\|model …` | manage the shared store |
| `pirun login\|logout antigravity <account>` | harness accounts |
| `pirun spend [provider[/account]]` | credits / rate limits everywhere |
| `pirun models <preset> [filter] [--refresh]` | provider catalog |
| `pirun model <preset> [id]` | show / set the preset's model |
| `pirun config <preset>` / `status <preset>` | everything the preset holds (prefix verbatim) / harness wiring |

Old v1 flags (`--timeout`, `--return-after`, `--api-base-url`, `--api-key*`,
`--bundled-proxy`, compat switches) are rejected with the exact replacement.

## Assigning work

Group tasks by subsystem and reuse its agent. Give parallel agents explicit,
non-overlapping file ownership. A new agent has no memory of your
conversation: state objective, exact files/scope, constraints, completion
gates. Standing rules belong in the preset's `--prefix`, not in every task.

Quote Windows paths (or use forward slashes) — your shell can eat unquoted
backslashes before pirun ever sees them.

Long tasks go in a file; prompts travel on stdin either way, so quoting,
newlines, and length are never your problem:

```powershell
pirun agent local auth --time 10m/2h --file C:\path\auth-task.md
```

Do not spend a run on a smoke test first; run the actual task.

## Reading failures

- `RUNNING` — healthy and detached; poll or wait with the printed id.
- `EMPTY` — provider ended without an answer; retry. Not a capability verdict.
- `DENIED` — the run produced nothing because its actions were denied at the
  `--permissions` level. Do NOT retry unchanged (it will loop): widen the
  level with the printed command, or rephrase the task within it.
- `TIMEOUT` — it ran past your something-is-wrong threshold. Inspect the log
  before retrying; do not just retry with a bigger number.
- `FAILED` — read the `error:` lines; they carry the provider's own message.
- `permission:` lines — the agent asked for something its `--permissions`
  level denies. Not a malfunction: decide whether to widen the preset (the
  exact command is printed) or rephrase the task within the level.
- `INTERRUPTED` — supervision died; inspect `pirun log <preset> <id>`.

Transient provider failures retry automatically (five turn retries unless a
global/project budget exists). `pirun log` is for diagnosis only — the digest
is designed for the calling AI. Do not shorten the hard timeout to fail fast;
use return-after to get control back instead.
