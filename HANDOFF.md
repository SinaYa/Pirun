# Pirun handoff

Last updated: 2026-08-27. Read this first in a new chat — then `UXA-FINDINGS.md`
(test-pass record + the pending, already-approved fix list = the next work
item). Together they continue the working session losslessly. Records the
user's intent and every standing decision. Supersedes `PIRUN-HANDOFF.md`
(v1-phase history). Usage reference: `README.md`, `FOR-AGENTS.md`.

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
4. **Authenticate once, share everywhere; no state in the repo.** Providers
   (endpoints + api keys, harnesses + logins), presets, and runs all live in
   the machine-global state home (`%LOCALAPPDATA%\Pirun`: providers.json,
   pirun.json, runs\), never in presets and never in the clone — the repo
   must be replaceable without losing anything. Presets are pointers: `use`,
   model, effort, permissions, prefix, dir, behavior flags.
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
9. **Prompt prefix.** `--prefix`/`--prefix-file <path|->`/`--no-prefix`
   persist text prepended to every prompt of a preset — standing instructions
   live there, not in every task. Lives on the preset, not the named agent.
   `-` reads stdin (no temp file); stdin can carry prefix OR task, never both.
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
11. **Easy account adding, pirun's own login UI.** Windows login opens a
    separate visible console window (paste-ready even when an AI invoked
    pirun; closes itself on success, stays open on failure). The dialog is
    pirun's — the harness's interactive UI is never shown to the human. New
    Antigravity profiles are seeded `enableTelemetry: false` — the user is
    unequivocal: no interaction-data sharing by default, ever.
12. **Docs are dense and model-agnostic.** No prose, no bloat; compact but
    complete. `FOR-AGENTS.md` (the pirun runbook) must contain no concrete
    model names or model-behavior advice — placeholders like `<model-id>`
    only. Provider names (deepseek, antigravity…) are fine. It also carries
    ONLY what changes how the orchestrator acts: passive traits (auth
    keep-alive and the like) belong in README/HANDOFF, never there.
13. **Permissions are intent.** `--permissions read|ask|edit|all` is stored
    per preset (like effort) and mapped per harness. Default = `edit`, one
    level above ask-for-everything. A denied action IS the agent asking:
    digests carry `permission:` lines with the exact widening command,
    traveling up like response text; contentless denied runs are `DENIED`.
14. **No default provider.** A fresh preset must name `--use` once (error
    carries the exact flag). The removed bundled proxy gets no familiarity —
    the CladGPT proxy is immature; users who want it `provider add` it like
    any endpoint. `--use bundled` / `--bundled-proxy` give migration errors.
15. **Distribution plan.** Public GitHub repo, MIT, later. README carries an
    install sequence an orchestrating AI can execute from the repo link alone
    (human only points their orchestrator at it). Installing harnesses (agy)
    is explicitly NOT pirun's concern — never assume, never install.
16. **UXA is validated empirically.** Improvements are tested by spawning
    fresh **Opus 5** test-user threads that drive pirun blind (methodology
    in `UXA-FINDINGS.md`; never play the test user yourself, that
    contaminates results); friction counted across independent threads decides
    priorities. Friction includes hesitation and wrong first guesses, not
    just failures. Fix root causes, not symptoms; reject changes that add
    grammar without removing turns. Goals, no compromises among them: it
    works · fewest orchestrator turns · shortest commands · compact
    word-dense docs.

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
- **Permission levels are an enforced per-harness requirement** (user
  decision 2026-08-27): `--permissions read|ask|edit|all` is stored intent
  per preset (like --effort), resolved via `HARNESS_PERMISSIONS`
  (src/cli/permissions.ts) — every harness in `PIRUN_HARNESSES` must declare
  a default (one above ask-for-everything ⇒ `edit`) and a reason for each
  level it cannot honor; missing declarations fail at import time and in
  tests. Investigated live: headless agy cannot prompt — it AUTO-DENIES
  (stream TOOL_ERROR "permission check failed"), ladder `--mode plan` <
  default-deny < `--mode accept-edits` < `--dangerously-skip-permissions`;
  Pi has no permission prompts at all — levels are tool allowlists. The
  denial IS the ask: digests carry `permission:` lines with the exact
  widening command, traveling up like response text. Presets predating the
  feature are stamped `all` (their old semantics); new presets get `edit`.
  FIXED 2026-08-27: pirun passes `--add-dir <meta.cwd>` so agy always has a
  workspace (was: agents wrote into the profile scratch dir); verified live
  with a relative-path file task.
- **UXA round-1 fixes (2026-08-27, from 4 live Opus-5 test users):** state
  moved to the machine-global home (see below); antigravity effort-suffix
  model ids auto-align with --effort (--effort wins, rewrites the suffix —
  effort is stored once); contentless permission-denied runs report status
  `DENIED` (never "retry" advice); `pirun models <provider>` browses a
  catalog with no preset (fresh-machine chicken-and-egg); `--help` anywhere
  prints help; digest answers keep newlines (capped, not flattened);
  file-not-found errors hint when a shell ate backslashes. agy plan-mode
  read denials and per-model tier gaps are recorded in LIMITATIONS.md.
- **State home**: presets (`pirun.json`) and runs live in `pirunStateRoot()`
  (`%LOCALAPPDATA%\Pirun`; PIRUN_STATE_DIR / PIRUN_RUNS_DIR /
  PIRUN_CONFIG_PATH override) — never in the repo. Legacy repo state
  migrates once, only from a real CLI invocation with no live runs.
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

- 72 tests pass (`npm test`, which also runs the line-cap guard); `npm run
  check` syntax-checks every source file and runs the guard. Suites: CLI
  surface characterization, lifecycle (fake-pi, fully sandboxed), providers,
  antigravity parsing, login dialog (fake child), keep-alive due-ness,
  permissions (+DENIED digest), args, time, files, pi-settings, timeouts.
- **Six UXA test rounds completed** (4 blind Opus-5 test users each; 24/24
  tasks succeeded overall) across four autonomous improve-and-retest
  cycles finished 2026-08-27; per-round records, friction tallies, shipped
  fixes with rationale, and the convergence statement live in
  `UXA-FINDINGS.md`. Round 6: zero wasted launches, zero DENIED. All
  `uxa*`/`r2*`–`r6*` presets/agents/runs purged (only the two account
  presets remain); test-ground artifacts kept in
  `D:\projectx\pirun-uxa-test\round*\` as the record. Highlights shipped
  along the way: `--answer` capture, self-healing DENIED for the agy
  file-tool race (+ `--new-project`), `KILLED` status, fork capability in
  `providers`, tool-activity liveness in RUNNING output, BOM-tolerant
  state files, evidence-based permissions guidance.
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
  works); `pirun config <preset> --json` persists the json flag (one-off
  JSON reads flip the preset's output mode — unresolved trap).

## Source map (modularized 2026-08-27; every file ≤ 400 lines)

`bin/pirun.ts` (dispatcher only) → `src/cli/`: `context.ts` (paths, shared
mutable state, out/die, formatters) · `pi.ts` (Pi discovery, registered-model
catalogue) · `preset.ts` (configurePreset, flag persistence, model
resolution) · `store.ts` (jobs, agents, sessions, locks, retention) ·
`digest.ts` (event stream → digest, permission-ask extraction) · `render.ts`
(digest and live-progress output) · `auth.ts` (login dialog, isolation) ·
`spawn.ts` (createJob, harness spawn, supervisor) · `keepalive.ts` (auth
keep-alive + HARNESS_KEEPALIVE registry) · `permissions.ts` (levels +
HARNESS_PERMISSIONS registry; both registries assert coverage at import) ·
`commands-*.ts` (one file per command family) · `help.ts`.

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
3. ~~UXA fix-and-retest cycles~~ — four cycles (rounds 3–6) completed
   2026-08-27; converged (see UXA-FINDINGS "State after cycle 4"). Further
   rounds only after new features or harness upgrades.
4. Then refactor/code-improvement generally, and eventually more harness CLIs
   behind an adapter boundary (auth, sessions, forking, tools, providers as
   explicit capabilities; keep-alive and permission registries already
   enforce per-harness declarations) — with zero change to what harness
   backends observe. Then the public MIT GitHub release (intent 15).

## Working style the user expects

- Decide architecture yourself; ask only what only they can answer. Wire to
  the real system — no stand-ins beside dead paths.
- Implement fully in one run, verify live, then commit with detailed messages
  (`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
- When they ask a design question, answer compactly ("without prose") and get
  approval before writing files; keep before-copies when they want to review
  doc rewrites. When asked to "think again", genuinely re-derive from root
  causes — they expect proposals to change.
- Behavior-preserving refactors: characterization tests against the OLD
  binary first, then move-only changes, full suite green after every split.
- Investigate before designing: probe the real harness (ordinary CLI usage,
  file mtimes/names only — never credential contents) and let observed
  behavior pick the design.
- Verification habit for a fresh chat: `git log -5 --oneline`,
  `node bin\pirun.ts providers`, and if needed one minimal live run per
  account: `node bin\pirun.ts run antigravity-one --time 2m/5m "Reply with exactly OK."`
- User messages may arrive mid-task redefining scope (e.g. "make it an
  enforced requirement…") — fold them in as standing decisions immediately.
