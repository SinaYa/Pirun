# UXA test passes — record, findings, pending work

2026-08-27. Read with `HANDOFF.md` (constitution; read that first). This file:
exact results of the Opus-5 test-user passes, what shipped from them, what is
still owed. Continuation in a fresh session starts at "Next: round 3".

## Methodology (reusable; the user wants more rounds)

- Test users = Opus 5 subagent threads acting as first-time orchestrators.
  Briefing contains ONLY: the repo path, "runbook: FOR-AGENTS.md", invocation
  (`node D:\projectx\pirun\bin\pirun.ts …`), one task, the account + model
  family + effort to use, a name token (`uxaN`/`r2x`) for presets/agents,
  "work autonomously, never ask", "only the delegated agent may create the
  deliverables", "don't modify the pirun repo". No pirun knowledge pre-chewed.
- Mandatory ground truth: each thread appends every command verbatim + exit
  code to `<taskdir>\cmds.md` as it goes, and writes a candid `retro.md` at
  the end. Investigate BOTH sides: these logs + pirun's run records
  (`%LOCALAPPDATA%\Pirun\runs\<id>\meta.json|events.jsonl|task.md`).
- Test ground: `D:\projectx\pirun-uxa-test\` (user-approved disposable; round
  1 in `task1..4\`, round 2 in `round2\taskA..D\` — all artifacts still there).
- Delegated model both rounds: `gemini-3.7-flash-high` (except B: `-low`),
  accounts `antigravity-one`/`antigravity-two` (2 threads each, parallel OK).
- Purge `uxa*`/`r2*` presets/agents/runs between rounds (leftover presets
  masked the fresh-machine experience in round 1). Purge = `pirun retire
  <preset> --all` + `pirun clean <preset> --all` + delete preset keys from
  `%LOCALAPPDATA%\Pirun\pirun.json`. Round-2 state NOT yet purged.

## Round 1 (pre-fix baseline) — 4/4 tasks succeeded, 3 wasted turns

Tasks: (1) create+execute fizzbuzz — first-try, chose `--permissions all` up
front; (2) two-turn persistent agent memory — first-try; (3) 60-line spec via
`--file` — 2 wasted launches (shell ate backslashes in unquoted `--file`
path; then agent's read-only `Test-Path` denied at default `edit` → EMPTY,
15k tokens burnt; recovered in one turn via the digest's printed widening
command); (4) read-only review — 1 wasted launch (`--permissions read` = agy
plan mode auto-denied the agent's own `view_file(auth.js)` yet allowed
`view_file(store.js)` same turn, result status `CANCELED`; thread invented
the inline-the-content workaround, then succeeded, all 4 planted flaws found).

Friction by independent-thread count: effort double-encoded in agy model ids
vs `--effort` 4/4 · `models` requires a preset (chicken-and-egg) 3/4 · state
inside the repo 3/4 · permission ladder semantics unclear 3/4 · `--dir`
undocumented 2/4 · `<cmd> --help` errors 2/4 · EMPTY overloads denial 2/4 ·
singles: backslash mangling, "run started"+exit 1 pairing, digest flattens
newlines, `--time` guesswork.

## Fixes shipped from round 1 (commits `2726fe4`, `88b1616`)

State home: presets+runs → `%LOCALAPPDATA%\Pirun` (`pirunStateRoot()`;
overrides PIRUN_STATE_DIR / PIRUN_RUNS_DIR / PIRUN_CONFIG_PATH; one-time
legacy migration, CLI-invocations only, deferred while a legacy run is live;
migrated live D:→C: intact) · effort/model alignment for agy (probe first:
NO unsuffixed Gemini ids exist, tiers vary per model — so align, don't
compose: suffix adopts into stored effort; `--effort` wins and rewrites the
suffix; id reaches agy verbatim) · `DENIED` digest status (contentless run +
permission asks; never "retry" advice) · `pirun models <preset|provider>` ·
`--help`/`-h` anywhere → help · digest answers keep newlines (2000-char cap)
· missing-file errors hint when path looks shell-mangled (`D:projectx…`) ·
`--dir` in help · FOR-AGENTS: ladder sharp edges, DENIED entry, quoting line,
providers-json claim fixed · LIMITATIONS: plan-mode denial nondeterminism,
per-model tier gaps. Explicitly rejected: `--time` calibration hints,
changing the announce/exit-1 pairing.

## Round 2 (post-fix) — 4/4 succeeded, zero blind permission walls

- A (create+execute+report-in-response): first-try; 15 lines quoted from the
  response channel with line breaks intact (newline fix validated); chose
  `all` up front from the new docs; tool-trace used as execution proof.
- B (blind model discovery + 2 parallel jobs): discovered catalog, picked
  `gemini-3.7-flash-low` + `--effort low` — "auto-aligned, no conflict"
  (alignment validated); real parallelism via `start`×2 then `wait` each;
  file ownership held (one `write_to_file` per digest).
- C (standing instructions): found and used `--prefix-file -` stdin form
  unprompted (feature validated); preset created via bare `config` before any
  run (pleasant surprise — document as intended). THEN the round's big catch,
  see bug #1 below. Also: `status`'s "account ineligible in the current
  location" line misread as the failure cause during debugging.
- D (guaranteed read-only review): all 3 planted flaws named, paragraphs
  intact, file hash byte-identical. Built a four-layer guarantee: inline
  content + `--permissions read` + `--no-tools --no-context-files` + foreign
  cwd. Found bug #2 below.

## Round-2 fixes — SHIPPED 2026-08-27 (all approved items done)

1. **agy workspace wiring** — `antigravityRunArgs` takes `workspaceDir`;
   `spawnAntigravity` passes `meta.cwd` as `--add-dir`. Verified live: the
   acid test (relative-path file creation, no absolute paths in the prompt)
   landed `workspace-proof.txt` in `--dir`, agent reported the absolute path.
2. **Truncation notice** — a clipped digest answer now ends with
   `note: answer truncated (N chars) — full: pirun poll <preset> <id> --full`;
   `--full` documented in FOR-AGENTS "Reading failures". Unit-tested
   (`test/pirun-render.test.ts`: note present when clipped, absent with
   `--full` and for short answers).
3. **`models <provider>` multi-account** — accepts
   `models <provider>/<account>`; with no default account, plain catalog
   reads fall back to any logged-in account (catalog is account-independent);
   unknown account errors name the known ones. Verified live on all three
   forms. Runbook claim fixed (`<provider>[/<account>]`).
4. **Read-only recipe** in FOR-AGENTS: `--no-tools --no-context-files` +
   inlined content is the capability guarantee; inlining alone only avoids
   reads. Digest prints `tools: none (disabled with --no-tools)` as proof
   (verified live + unit test).
5. **`--dir`** documented in FOR-AGENTS flag bullets (persists per preset,
   relative paths resolve there).
6. Small: `status` ineligible line reframed as a historical, location-
   dependent note · `retire <preset> --all` with zero agents prints
   "no agents to retire." and exits 0 (verified live).

NOT done (was a "consider", needs design judgment): digest warning when
files were written outside `--dir` (C's misplaced-file case) — the workspace
fix (#1) removes the known cause; revisit only if round 3 shows strays.

Parked design ideas (user judgment, not bugs): permission tier "commands
scoped to --dir" (A) · multi-run `wait` (B) · tool-enforced file ownership
(B) · `--out <file>` clean answer capture (D).

## Next: round 3

Purge `r2*` state first (protocol above), then 4 fresh Opus test users on
new task variants targeting the shipped fixes: a --dir-relative file task
with NO absolute paths in the prompt (acid test for #1, now expected to
pass); a long-deliverable task that must survive >2000 chars (#2); a
fresh-perspective model-discovery task with two accounts and no default
(#3); a guaranteed read-only review using the documented recipe (#4).
