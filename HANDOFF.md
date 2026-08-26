# Pirun handoff

Last updated: 2026-08-27. Read this first in a new chat. It records the user's
intent and every standing decision. Supersedes `PIRUN-HANDOFF.md` (kept as
history of the v1 phase). Current usage reference: `README.md`,
`FOR-AGENTS.md`.

## What this project is

Pirun is the stable front door for delegating work to coding-agent harness
CLIs (currently Pi and Antigravity; more will be added). It runs at
`D:\projectx\pirun`, its own git repo, extracted 2026-08-27 from
`D:\projectx\CladGPT\completions-proxy` (root commit `d01d05e`, copy of
CladGPT `f783693`). **Work here, not in the CladGPT copy** — that one is
frozen legacy and still contains the proxy's home docs.

## Product intent (the user's, verbatim in spirit)

1. **Pirun is for AIs.** The primary user is an orchestrating AI. Optimize UXA
   (User Experience for AI): shortest commands, fewest turns, one-call
   discovery, errors that contain the exact fixing command. Zero compromises —
   new features must reduce, not add, turns and length.
2. **Many harnesses.** Antigravity is one of several future harness CLIs.
   Write code and docs harness-agnostically ("never a harness CLI directly",
   capability-based wording), never enumerating the current pair as if final.
3. **Two consumption ways.** A harness's own accounts (Antigravity), and
   OpenAI-completions-compatible endpoints. Some harnesses may someday have
   both; `--use` decides.
4. **Authenticate once, share everywhere.** Providers (endpoints + api keys,
   harnesses + logins) live in one machine-global store
   (`%LOCALAPPDATA%\Pirun\providers.json`), never in presets. Presets are
   pointers: `use`, model, effort, prefix, dir, behavior flags.
5. **No setup ceremony.** No config command. Every preset command takes the
   preset positionally; settings supplied on a launch persist into it, omitted
   ones load from it. Prompts and `--time` never persist. `pirun config` is
   inspection only.
6. **Canonical endpoints have pre-knowledge.** openai, deepseek, openrouter,
   groq, mistral, xai ship with base URL, compat quirks, model catalog,
   standard env var. `--use deepseek` with `DEEPSEEK_API_KEY` set needs zero
   setup; `DEEPSEEK_API_KEY_<NAME>` is the multi-account suffix convention.
7. **One consumption-status interface.** `pirun spend` answers for everything:
   endpoint accounts → credits/balance; harness accounts → rate-limit windows
   (five-hour/weekly/monthly), % remaining, reset times.
8. **Effort is intent.** `--effort off|min|low|medium|high|max|<n>k` is stored
   per preset and mapped per model/harness at call time (Pi `--thinking`,
   Antigravity `--effort`). Safe on knobless models; digest notes when ignored.
9. **Prompt prefix.** `--prefix`/`--prefix-file`/`--no-prefix` persist text
   prepended to every prompt of a preset — standing instructions live there,
   not in every task. Lives on the preset, not the named agent.
10. **Timers are required and never persisted.** One flag,
    `--time <return-after>/<timeout>`, on every run/agent/fork/start. No
    defaults ever — the AI must consciously choose. Meaning (user's framing):
    - **return-after = "when do I next look?"** Bounds only the caller.
      Must be positive: there is NO fire-and-forget flag, by design — the AI
      must always come back to a decision point with stuck-vs-slow evidence
      (exit code 2 + progress digest). True detachment = background the pirun
      command itself, which proves the caller chose concurrency.
    - **timeout = "how long would prove something is wrong?"** A failure
      detector, NOT a completion estimate or budget. Set past any healthy
      duration; firing means broken, not slow.
    - return-after may exceed timeout (stay attached to observe the timeout).
    - `pirun time <preset> <id> +30m` (extend) vs `45m` (set from now): both
      exist so the reference point is in the spelling, never ambiguous.
11. **Easy account adding.** Windows login opens a separate visible console
    window so a human can always paste Google's auth code, even when Pirun was
    invoked by an AI. New Antigravity profiles are seeded
    `enableTelemetry: false` — the user is unequivocal: no interaction-data
    sharing by default, ever.
12. **Docs are dense and model-agnostic.** No prose, no bloat; compact but
    complete. `FOR-AGENTS.md` (the pirun runbook) must contain no concrete
    model names or model-behavior advice — placeholders like `<model-id>`
    only. Provider names (deepseek, antigravity…) are fine. Proxy-specific
    docs (API.md etc.) may keep concrete models; the proxy is a different
    subject.

## Hard constraints (do not violate)

- **The Antigravity backend must see ordinary CLI usage.** No direct calls to
  Google APIs, no synthetic traffic, nothing that could fingerprint the
  accounts or cause undisclosed cost. Quota is fetched via `agy -p "/usage"`
  (agy's own print-mode slash command); models via `agy models`. Keep it that
  way for any new capability.
- **No OAuth secrets anywhere durable** — not in config files, commits, docs,
  or chat. Presence checks only; never print token files or account
  identities.
- **Login is pirun's own dialog** (user requirement 2026-08-27): Antigravity's
  interactive UI must never be shown to the human. agy runs fully piped; pirun
  scrapes the OAuth URL, opens the browser, relays the pasted code, detects
  success from the profile on disk, and terminates agy itself — no `/quit`.
  ⚠ Piped-stdin login is NOT yet validated against a real Google sign-in
  (needs a human); revalidate like the isolation probe on agy upgrades.
  Fallback if agy misbehaves with piped stdin: the pre-dialog flow at commit
  52a6028 (`src/cli/auth.ts`).
- **Auth keep-alive is an enforced per-harness requirement** (user decision
  2026-08-27): every harness in `HARNESS_PROVIDERS` must declare in
  `HARNESS_KEEPALIVE` (src/cli/keepalive.ts) either how its auth is
  exercised or, explicitly with a reason, that keeping it alive is
  impossible. A harness without a policy fails at import time and in tests.
  Mechanism (investigated live): agy stores an access+refresh bundle in
  `antigravity-cli/antigravity-oauth-token` and silently refreshes it on any
  authenticated call when the access token (~1h) has expired, rewriting the
  file. Pirun's keep-alive: every invocation cheap-checks freshness (file
  mtimes only, never contents); accounts idle past
  `PIRUN_AUTH_KEEPALIVE_DAYS` (default 3, 0 disables) get one detached
  `agy -p "/usage"` — ordinary usage — with a 6h retry cool-down
  (`%LOCALAPPDATA%\Pirun\auth-keepalive.json`). The token-file path is
  version-sensitive (proven agy 1.1.21); revalidate on upgrades.
- **Isolation is verified, not assumed.** Before login, Pirun probes that agy
  chose file-backed token storage (Windows: the SSH-env workaround, mode
  `ssh-file`) and refuses on keyring fallback. Version-sensitive: revalidate
  on agy upgrades (proven with agy 1.1.21).
- **Deletions are recoverable.** `logout` renames profiles aside; nothing
  recursively deletes credentials. The user previously required Recycle-Bin
  style removal for profiles.
- **Automated tests never touch OAuth, browsers, or live accounts** — offline
  string/file logic only. Live checks are cheap real runs ("Reply with exactly
  OK.") the user is fine with; run them without asking, guard against waste
  not spend.

## Current state

- 49 tests pass (`npm test`, which also runs the line-cap guard); `npm run
  check` syntax-checks every source file and runs the guard.
- **Anti-bloat guard**: no source file may exceed 400 lines
  (`scripts/max-lines.mjs`). Enforced in `npm test`, `npm run check`, and a
  pre-commit hook (`.githooks/pre-commit`; `core.hooksPath` is set by npm's
  prepare step — after a fresh clone, `npm install` or `npm run setup-hooks`
  re-arms it). When it fires, split the file into modules; do not raise the
  cap or grow the exempt list.
- Two live Antigravity accounts, `antigravity-one` and `antigravity-two`,
  authenticated in isolated profiles under `%LOCALAPPDATA%\Pirun\profiles\`,
  shared through the global store with the legacy checkout. Presets of the
  same names point at them.
- v1→v2 migration is automatic and idempotent (`migratePresetsToProviders`);
  old flags are rejected with pointers to replacements.
- **The proxy is gone from this repo** (removed 2026-08-27, user decision).
  The CladGPT completions proxy is an independent project; Pirun has no
  special logic for it and no canonical familiarity either — the proxy is not
  mature yet, so a user who wants it registers it like any custom endpoint
  (`pirun provider add <name> --base-url <url>`). There is no bundled
  provider, no `up/down/restart`, no proxy auto-start, no proxy-log
  correlation, no speedtest. A fresh preset requires `--use` (no default
  provider); `--use bundled` and the old `--bundled-proxy` flag get targeted
  migration errors. Endpoint presets register as native Pi
  `openai-completions` providers keyed by provider/account in Pi's
  `models.json`.
- Known cosmetic/deferred items: `pirun help` and README examples still name a
  concrete model (`deepseek-chat`) — user wants a placeholder when code is
  next touched; Windows browser auto-open uses `rundll32` (the path that
  works).

## Source map (modularized 2026-08-27; every file ≤ 400 lines)

`bin/pirun.ts` (dispatcher only) → `src/cli/`: `context.ts` (paths, shared
mutable state, out/die, formatters) · `pi.ts` (Pi discovery, registered-model
catalogue) · `preset.ts` (configurePreset, flag persistence, model
resolution) · `store.ts` (jobs, agents, sessions, locks, retention) ·
`digest.ts` (event stream → digest) · `render.ts` (digest and live-progress
output) · `auth.ts` (Antigravity login/isolation) · `spawn.ts` (createJob,
harness spawn, supervisor) · `commands-*.ts` (one file per command family) ·
`help.ts`.

`src/pirun-providers.ts` (store + --use resolution) re-exports
`src/pirun-provider-catalog.ts` (canonical endpoints, models, effort
mapping). `bin/install.ts` (flow) over `src/install/`: `report.ts` ·
`steps.ts`. Support: `pirun-config.ts` (presets, migration, Pi registry
sync) · `pirun-antigravity.ts` · `pirun-provider-net.ts` (spend, /models) ·
`pirun-time.ts` · `pirun-args.ts` · `pirun-files.ts` · `pirun-process.ts` ·
`pirun-pi-settings.ts` · `env.ts` (endpoint keys from .env) · `paths.ts` ·
`timeouts.ts`.

## Next phase (user's explicit plan — wait for instructions per step)

1. ~~**Modularize**~~ — done 2026-08-27 (see source map and the anti-bloat
   guard above). CLI surface characterization tests added in
   `test/pirun-cli-surface.test.ts`.
2. ~~**Separate the proxy concern from the Pirun front door**~~ — done
   2026-08-27: the proxy code was deleted from this repo entirely (it lives
   on in CladGPT), not wrapped. See Current state.
3. Then refactor/code-improvement generally, and eventually more harness CLIs
   behind an adapter boundary (auth, sessions, forking, tools, providers as
   explicit capabilities) — with zero change to what harness backends observe.

## Working style the user expects

- Decide architecture yourself; ask only what only they can answer. Wire to
  the real system — no stand-ins beside dead paths.
- Implement fully in one run, verify live, then commit with detailed messages
  (`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
- When they ask a design question, answer compactly ("without prose") and get
  approval before writing files; keep before-copies when they want to review
  doc rewrites.
- Verification habit for a fresh chat: `git log -5 --oneline`,
  `node bin\pirun.ts providers`, and if needed one minimal live run per
  account: `node bin\pirun.ts run antigravity-one --time 2m/5m "Reply with exactly OK."`
