# completions-proxy

A small, self-contained OpenAI-compatible completions server that puts CladGPT's
inference routing in front of any tool that speaks the OpenAI API — CLI
harnesses, SDKs, editors, `curl`.

It is a **sibling** of the parent project, not a part of it. It has its own
provider definitions, its own routing rules, its own `.env`, and its own port.
Nothing in `../src` reads anything in here, and editing the routing rules in
this folder cannot affect the main app.

```
completions-proxy/
  install.bat      one-time setup — run this first
  start.bat        double-click to run the proxy
  proxy.cfg        port, host, defaults, timeout, log level
  .env             API keys (copied from the parent project, gitignored)
  API.md           how to call the API this creates   <- start here
  FOR-AGENTS.md    runbook for an AI delegating work to Pi
  LIMITATIONS.md   what cannot be reported yet, and what would have to change
  PI-SETUP.md      driving it with the Pi CLI harness by hand
  pirun.bat        the `pirun` CLI (see FOR-AGENTS.md)
  pirun.json       ignored presets (use/model/effort/prefix/behavior); credentials
                   live in the machine-global %LOCALAPPDATA%\Pirun\providers.json
  config/          routing + model definitions (copied from the parent project)
  src/             the server (TypeScript, run directly by Node — no build)
  bin/             pirun.ts, speed-test.ts, install.ts
```

## Setup

On a new machine, run this once:

```bash
node bin/install.ts
```

or double-click **`install.bat`**. It checks Node, installs dependencies,
creates `.env` from the example if missing, picks a free port, installs the Pi
CLI, registers this proxy as a provider in Pi's `models.json`, puts the `pirun`
command on your PATH, and finishes by proving the proxy answers.

It is safe to re-run — every step reports `already in place` and changes
nothing. It never overwrites `.env`, never touches other providers in Pi's
config, and keeps model entries you have tuned by hand. `--smoke` adds a live
request through a real provider; `--uninstall` reverses it.

The only manual step is putting real API keys in `.env`; the installer tells you
which ones are still blank.

Once installed, `pirun` is the front door for anything driving a supported agent harness —
see [FOR-AGENTS.md](FOR-AGENTS.md). It deliberately never mentions this proxy to
its caller: an agent delegating work should not have to know a proxy exists.

Every preset command takes its preset name immediately after the command. The
first launch creates the preset in the ignored `pirun.json`; later invocations
load omitted settings and persist supplied ones. No setup step. Prompts and
`--time` are invocation-only; `--use`, model, effort, prefix, dir, and
tool/context-file/output behavior persist.

```bash
pirun agent local worker --time 10m/2h "Inspect the repository" --model <model-id>
pirun agent local worker --time 10m/2h "Now implement it"
```

### Providers: shared authentication, presets as pointers

Consumption sources and their credentials live in one machine-global store
(`%LOCALAPPDATA%\Pirun\providers.json`), never in presets. A preset selects one
with `--use provider[/account]`; each provider holds any number of accounts.
`pirun providers [--json]` lists them all — providers, accounts, readiness,
models, default account.

- `--use bundled` — the bundled proxy (default for new presets).
- `--use deepseek` — canonical endpoints (openai, deepseek, openrouter, groq,
  mistral, xai) carry base URL, compat quirks, and a model catalog in Pirun
  itself. With `DEEPSEEK_API_KEY` set, account `main` auto-creates; the suffix
  convention `DEEPSEEK_API_KEY_WORK` auto-creates account `work` for
  `--use deepseek/work`. Explicitly: `pirun provider key deepseek work --env VAR`
  (or `--key <literal|$VAR|!command>`). Only the reference persists, never the
  secret; `.env` here is loaded for direct runs.
- `--use myapi` — custom endpoints: `pirun provider add myapi --base-url <url>`,
  compat via `provider set` (`--no-auth-header`, `--no-developer-role`,
  `--reasoning-effort`), per-model limits via `provider model`.
- `--use antigravity/<account>` — harness accounts (below).

Endpoint presets register as native Pi `openai-completions` providers keyed by
provider/account, shared between presets; the bundled proxy is not started for
their runs. `--model` accepts any unambiguous fragment of a catalog model id;
`pirun models <preset> --refresh` pulls the live `/models`
list into the catalog. `--effort off|min|low|medium|high|max|<n>k` stores
reasoning *intent*, mapped per model at call time (Pi `--thinking` levels,
Antigravity effort tiers) — safe for knobless models. `--prefix`/`--prefix-file`
persist text prepended to every prompt of the preset; `--no-prefix` clears it.

`pirun spend [provider[/account]] [--json]` is one interface for every source:
endpoint accounts report credits/balance (DeepSeek balance, OpenRouter
credits); Antigravity accounts report five-hour/weekly/monthly limit windows
with percent remaining and reset times, fetched through `agy -p "/usage"`
itself.

### Antigravity harness and isolated accounts

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

### Timers

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

Run storage is bounded conservatively. Finished one-shot runs and orphaned
sessions older than 30 days are pruned when a new run starts, while active-agent
history is retained. `PIRUN_RETENTION_DAYS` changes the age and
`PIRUN_MAX_STORAGE_MB` changes the default 1024 MB ceiling. `pirun retire <preset> <name>`
removes the retired agent's Pi session; `pirun clean <preset> --sessions` removes other
orphaned sessions. The proxy log rotates at 10 MB on service startup.

## Quick start

1. Double-click **`start.bat`** (or `node src/server.ts`).
2. Point any OpenAI client at `http://127.0.0.1:8899/v1`.

```bash
curl -s http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek>deepseek-v4-flash","messages":[{"role":"user","content":"Say hello"}]}'
```

Requires Node 22.18+ (it runs the `.ts` sources directly) and the `yaml` package,
which it picks up from the parent project's `node_modules` — or run
`npm install` here for a standalone copy.


## What it gives you

- **One endpoint, every provider.** Command Code (via its CLI adapter), CrofAI
  and DeepSeek all answer on the same OpenAI-shaped URL.
- **Routing.** `config/cascaded-inference-routing.rules` can rewrite any
  requested provider/model into another one, including score-weighted `prefer`
  choices across named model groups. Rules reload on every request.
- **Streaming, tools, reasoning.** Normalised into one shape regardless of which
  provider served the request.
- **Visible decisions.** Every response carries an `x_completions_proxy` block
  saying where it actually went, and `GET /v1/routing?model=…` explains a route
  without spending a token.

Full endpoint reference: **[API.md](API.md)**.

## Ox/Muse/Qwen proxy speed benchmark

`pirun speedtest <preset>` sends one frozen prompt directly through the proxy to Ox Alpha
Muse Contributor, and Qwen 3.7 Flash. Pi is not involved. The Command Code
transport is primed with a short unmeasured request first, so CLI bootstrap time
is not charged to only the first measured model.

```bash
pirun speedtest local
pirun speedtest local --runs 3 --json
pirun speedtest local --model ox
pirun speedtest local --model qwen
```

Each reasoning and final-output phase reports observed token count, time to its
first token, phase duration, and decode tokens/second. Command Code exposes only
one provider-reported completion-token total, so the phase counts use
`gpt-tokenizer`'s `o200k_base` consistently as an estimate; the actual combined
provider count is shown separately, along with the unattributed difference. That
difference can include hidden reasoning as well as tokenizer variance and is not
automatically classified as reasoning. Full generated text and hashes are retained
in an ignored `.runs/speed-tests/*.json` artifact, while normal console output
shows metrics only. Even-numbered repeated runs reverse model order.

## Configuring it

- **`proxy.cfg`** — port, bind host, default provider/model, optional bearer
  token, timeout, log level, routing hot-reload.
- **`config/inference-providers.yaml`** — providers, models, variants, and the
  per-provider request/response field mappings.
- **`config/cascaded-inference-routing.rules`** + **`inference-model-groups.rules`**
  + **`inference-model-scores.yaml`** — the routing layer.
- **`config/base-ai-request-interface.yaml`** — the neutral request shape, its
  global defaults, and `model_defaults`: per-canonical-model tuning
  (temperature, top_p, max_tokens, reasoning effort) taken from each vendor's
  published guidance. Every entry records a `source`; `inferred-*` means the
  value follows the model's family rather than a published figure, and
  `unpublished` means none was found and the global defaults apply.

  Precedence is caller value → `model_defaults[<model>]` → global default, and
  `max_tokens` is then clamped by the variant's `max_completion_tokens`. Canonical
  models also carry `context_length` in `inference-providers.yaml`, used when a
  provider variant declares none.

  After changing either, run `node bin/install.ts --refresh-models` so Pi's model
  list picks the new values up — the normal merge preserves what is already
  there.

These started as copies of the parent project's files. Change them freely; they
are the proxy's own.

## Adding a Command Code model

Add the canonical name and label to `models:` at the top of
`config/inference-providers.yaml`, then an entry under
`providers.commandcode.models` pointing at the upstream id:

```yaml
  ox-alpha: { label: Ox Alpha (stealth) }
...
      ox-alpha:
        default_variant: standard
        variants:
          standard: { provider_model: stealth/ox-alpha }
```

Two things will waste your afternoon otherwise:

- **The upstream id is case-sensitive.** `cmdc --list-models` prints everything
  lowercase, and the CLI accepts the lowercase form because it canonicalises the
  casing internally before sending. Our id goes to the API verbatim, so the
  *server* rejects a lowercase one with
  `403 Model/provider not recognized: anthropic:qwen/qwen3.8-max`. Use the
  catalogue's own casing — `Qwen/Qwen3.8-Max`, `moonshotai/Kimi-K3`.
- **`cmdc --list-models` is not the catalogue.** It is a list compiled into the
  npm package at publish time, minus everything flagged `hidden`. Models the
  account can genuinely use are missing from it — `stealth/ox-alpha` and
  `meta/muse-spark-1.2-contributor` appear nowhere in it and both answer fine.
  The only real test of a model id is a request.

The adapter deliberately does not consult the CLI's list — see
[The CLI is only an auth bootstrap](#the-cli-is-only-an-auth-bootstrap) below.
A `403 Model/provider not recognized` means wrong casing or a genuinely absent
model; `MODEL_NOT_IN_PLAN` means the model is real but the account's plan does
not include it.

## The CLI is only an auth bootstrap

Worth understanding before touching `src/command-code-cli-adapter.ts`.

Command Code has no public HTTP endpoint we can call. The adapter gets one by
spawning the real CLI against a loopback bridge: the CLI authenticates and POSTs
its own `/alpha/generate` envelope, the bridge intercepts it, swaps in our
params, and forwards it upstream — teeing the response so both the CLI and we
can read it.

So `params.model` in that swapped body is what the API actually sees. The
`--model` argument handed to the CLI never reaches the API; it only has to be a
name the *installed CLI* will accept.

That distinction is load-bearing. The CLI validates `--model` against a list
frozen into the package at publish time (`command-code@1.32.1` here), and exits
with `unknown model "…"` before dialling out. The API's catalogue moves
independently and is already ahead of it. Passing the requested model through to
the CLI therefore blocked models the account could genuinely use.

The adapter now spawns with a fixed `COMMAND_CODE_BOOTSTRAP_MODEL` and lets the
real id travel in the body, where only the API judges it. Any model the plan can
reach is reachable, no matter how old the installed CLI is.

The adapter caches a warm transport template after the bootstrap and skips the
CLI on healthy later calls. Any failed fetch, non-OK response, timeout, or stream
error invalidates that exact template before another request can reuse it. A
transient failure before any output is visible is retried with a fresh transport;
once content or a tool call is visible, it is never replayed. If the adapter
exhausts those transport retries, it labels transient terminal errors so Pi's
own turn retry can recognize them. `pirun` initializes Pi's turn retry budget to
five when the user has not configured one; explicit global and project values
remain authoritative.

## Differences from the parent's copies

Kept deliberately, to make the proxy usable by agent harnesses:

- `tools`, `tool_choice`, `parallel_tool_calls`, `stop`, `seed` and `n` are
  passed through to providers, and tool calls are mapped back out. The parent's
  interface is chat-only.
- The Command Code CLI is spawned with a fixed bootstrap model instead of the
  requested one, so the installed CLI's frozen model list no longer gates which
  models the account can reach.
- Command Code is pinned to 1.32.1, which includes its mid-stream retry and
  stuck-session recovery fixes. The adapter additionally rebuilds failed warm
  transports and retries only requests that have emitted no observable output.
- A provider that fails mid-stream is reported as an error payload plus
  `finish_reason: "error"`, instead of ending the turn as a silent empty
  completion.
- The Command Code CLI adapter's request translation was fixed for tool use:
  tool schemas go out as `input_schema`, and OpenAI tool round-trips are
  converted to the AI SDK `ModelMessage` shape Command Code validates against.
  Without that, an agent gets one tool call and then an empty reply. The parent
  project never sent tools through this path, so it never hit either bug — but
  they are worth porting back.
