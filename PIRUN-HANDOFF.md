# Pirun development handoff

Last updated: 2026-08-26

> **Superseded 2026-08-27.** The CLI grammar below is v1. Since then: shared
> provider store with `--use provider/account`, account-based
> `pirun login antigravity <account>`, required `--time <ra>/<to>` timers with
> live `pirun time` retiming, `--effort` intent, `--prefix`, and a unified
> `pirun spend` (endpoint credits + harness rate limits). Current usage:
> [README.md](README.md) and [FOR-AGENTS.md](FOR-AGENTS.md); history: git log.

This document is the complete handoff for the current Pirun improvement effort. It is intended to be pasted into or referenced from a new chat so work can continue without reconstructing the design, implementation history, failures, or machine state.

## Project and scope

Pirun lives in:

`D:\projectx\CladGPT\completions-proxy`

The Git branch is `completions-proxy`. At the start of this handoff the implementation commit at `HEAD` was:

`6eb2d97 completions-proxy: add isolated Antigravity harness`

The relevant preceding commits are:

- `e4e335e completions-proxy: make Pirun presets positional`
- `e51de74 completions-proxy: add persistent Pirun presets`
- `9c1b954 checkpoint ongoing Pirun and Harpoon work`

The parent repository contains other work. Preserve unrelated changes and treat this subproject as the scope unless the user expands it.

Do **not** edit `FOR-AGENTS.md` yet. The user explicitly deferred that file until they provide separate instructions for how it should change.

## Product intent

Pirun originally drove only the Pi harness, and Pi used the bundled completions proxy backed primarily by the Command Code adapter. The broader product direction is:

1. Pirun should be the stable front door for multiple coding-agent harness CLIs, not only Pi.
2. A Pi-backed preset should be able to use any API provider implementing the OpenAI Chat Completions standard, without requiring Pirun's bundled proxy.
3. Harnesses that have useful first-party account/provider support should eventually be able to use their own provider rather than forcing all traffic through an API configured by Pirun.
4. Configuration should feel like starting an agent, not like performing a separate setup procedure.
5. Every public Pirun command must identify a preset. The preset is positional, immediately after the command; users should not have to type `--preset`.
6. Settings supplied on a normal invocation should automatically become persistent for that preset. Omitted settings should load from the preset.
7. Prompts and timers (`--timeout` and `--return-after`) are deliberately invocation-only. Everything else that represents agent/harness/provider behavior should persist by default.
8. Multiple accounts for a harness must be isolated enough to remain logged in and run concurrently without virtual machines.

The intended mental model is:

> “Start or continue this agent under this preset; any settings I supply become that preset's defaults.”

It is explicitly **not**:

> “First run a configuration command, then separately start the agent.”

`pirun config <preset>` remains useful for inspection, but is not a required setup step.

## CLI interface now implemented

Every public command takes the preset as its first positional argument after the command. Examples:

```text
pirun agent local worker "Inspect the repository"
pirun run antigravity-one "Reply with exactly OK."
pirun login antigravity-two --harness antigravity
pirun config openai
pirun status local
pirun wait local <run-id>
```

The parser rejects missing preset names and unknown flags. Preset names allow letters, numbers, `.`, `_`, and `-`, start with an alphanumeric character, and are limited to 64 characters.

### Persistent settings

These settings are accepted on normal public commands and saved into the selected preset when supplied:

- `--harness <pi|antigravity>`
- `--model <id>`
- `--dir <path>`
- `--tools` / `--no-tools`
- `--context-files` / `--no-context-files`
- `--full` / `--no-full`
- `--json` / `--no-json`
- `--api-base-url <url>`
- `--api-key <value>`
- `--api-key-env <name>`
- `--bundled-proxy`
- `--context-window <n>`
- `--max-tokens <n>`
- `--reasoning` / `--no-reasoning`
- `--auth-header` / `--no-auth-header`
- `--developer-role` / `--no-developer-role`
- `--reasoning-effort` / `--no-reasoning-effort`
- Antigravity-specific `--effort <low|medium|high>`
- Antigravity-specific `--antigravity-agent <name>`

Prompts/tasks, `--timeout`, and `--return-after` do not persist.

Preset configuration is stored in the ignored project file:

`D:\projectx\CladGPT\completions-proxy\pirun.json`

At handoff time it contains two Antigravity presets, `antigravity-one` and `antigravity-two`. Both use `model: "auto"`, tools and context files enabled, and normal non-JSON/non-full output defaults.

## Direct OpenAI-compatible APIs through Pi

This phase is implemented. A preset can bypass the bundled Command Code/provider stack and register a native Pi `openai-completions` provider. Example first invocation:

```text
pirun agent openai worker "Implement the feature" --api-base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY --model gpt-5.2 --context-window 400000 --max-tokens 128000 --reasoning --reasoning-effort
```

Later invocations can omit those settings:

```text
pirun agent openai worker "Continue with the next change"
```

Important implementation details:

- `--api-key-env NAME` persists `$NAME`, not the secret value.
- `--api-key` also accepts a literal, Pi's `$ENV_VAR` syntax, or a `!credential-command` value.
- Environment variables from this subproject's `.env` are loaded for direct Pi runs.
- The generated Pi provider ID is deterministic and does not disclose the URL or credentials.
- Direct API presets do not start the bundled proxy.
- `--bundled-proxy` switches a Pi preset back to the bundled proxy.
- API compatibility controls exist for providers that differ at the edges of the OpenAI Chat Completions standard.
- Switching a preset between Pi/direct API and Antigravity removes incompatible configuration rather than mixing modes.
- OAuth secrets are not placed in `pirun.json`.

The main files for this work are:

- `src/pirun-config.ts`
- `src/pirun-args.ts`
- `bin/pirun.ts`
- `README.md`

## Antigravity harness support

Antigravity support is now implemented as a second harness alongside Pi. It uses the Antigravity CLI's own Google account and models, not the bundled proxy and not a separately configured OpenAI API.

The installed CLI used during development is Antigravity CLI `1.1.21`, installed at:

`C:\Users\Luigi\AppData\Local\agy\bin\agy.exe`

Pirun can also find `agy` through `PATH`, or use `PIRUN_ANTIGRAVITY_ENTRY` as an explicit executable override.

### Supported Antigravity workflow

Authenticate in advance:

```text
pirun login antigravity-one --harness antigravity
```

Or let the first agent launch initiate authentication automatically:

```text
pirun agent antigravity-one worker "Inspect the repository" --harness antigravity
```

After the harness is persisted, later calls do not need `--harness`:

```text
pirun agent antigravity-one worker "Continue the work"
```

The normal Antigravity browser OAuth behavior is preserved. The user signs in through the browser, and if Google's callback page presents an authorization code, that code is pasted into the waiting Antigravity terminal. Once the Antigravity UI visibly shows the signed-in account, `/quit` returns control to Pirun and Pirun records successful isolated authentication.

### Isolation design

Each preset receives a deterministic, private Antigravity profile directory. On this machine the two active profiles are:

- `C:\Users\Luigi\AppData\Local\Pirun\profiles\antigravity-one-0fa51343\antigravity`
- `C:\Users\Luigi\AppData\Local\Pirun\profiles\antigravity-two-620b1e96\antigravity`

The directory name consists of a sanitized preset name plus the first eight characters of a SHA-256 hash of the original preset name. This avoids accidental collisions while keeping paths recognizable.

Each profile contains its own:

- OAuth token file
- Antigravity settings
- onboarding state
- cache
- conversation/history state
- MCP-related state
- installation/state files
- Pirun authentication marker

Pirun passes the profile with Antigravity's `--gemini_dir` option.

The critical isolation problem was credential storage. Antigravity normally uses a single operating-system keyring identity. Merely changing `--gemini_dir` is insufficient if OAuth remains in that shared keyring, because multiple presets could silently share or overwrite one account.

Pirun therefore verifies storage behavior **before** allowing a new login. It starts a short probe, inspects Antigravity's own profile logs, and requires confirmation that file-backed token storage is active and keyring storage is not. If that cannot be confirmed, login is stopped rather than risking false isolation.

### Windows storage workaround discovered

The first intended mechanism was:

```text
GEMINI_FORCE_FILE_STORAGE=true
```

In the tested Windows release, that variable alone was not enough. Reverse engineering/behavioral inspection showed that Antigravity deliberately chooses file-backed token storage when it detects an SSH session. Pirun now supplies harmless local `SSH_CLIENT` and `SSH_CONNECTION` capability hints for its child process. No SSH connection is created; the variables only select the CLI's file-storage branch.

The selected isolation mode is recorded in each profile's `pirun-auth.json` marker as `ssh-file`. Subsequent runs reuse that mode.

This workaround is version-sensitive and should be revalidated when upgrading Antigravity. Pirun's pre-login probe and log checks are the guard against silently regressing into the shared keyring.

### Headless execution

Agent jobs run Antigravity using newline-delimited streaming JSON:

```text
--input-format stream-json
--output-format stream-json
--print-timeout <seconds>s
```

Pirun writes the user event to stdin, captures Antigravity events into the existing durable run storage, and translates result data into Pirun's normal digest model. It parses:

- conversation IDs
- assistant text
- result status
- tool calls and failures
- input, cached, output, thinking, and total token usage
- Antigravity errors

Named Pirun agents persist Antigravity conversation IDs and use `--conversation` to continue them. Antigravity does not expose Pi-style conversation forking, so `pirun fork` deliberately rejects Antigravity agents and tells the caller to start a new named agent.

With Pirun tools enabled, Antigravity runs with `--dangerously-skip-permissions`, matching Pirun's unattended harness behavior. `--no-tools` omits that override and retains Antigravity's normal permission policy. This flag does not literally remove Antigravity's tools; it changes permission handling.

Antigravity defaults to its own automatic model selection. Persistent overrides are available through `--model`, `--effort`, and `--antigravity-agent`.

## Authentication attempts and outcomes

No OAuth authorization codes, access tokens, refresh tokens, or full account identifiers are included in this handoff.

### First pair: authentication succeeded, execution failed by region eligibility

Two initially tested Google accounts completed OAuth and were isolated into separate profile directories. Both were distinct accounts. However, real Antigravity execution reported that each account was ineligible in the current location. Authentication itself was valid, but the service rejected use based on account/location eligibility.

This was an important partial success:

- Multi-account OAuth isolation worked.
- File-backed token storage worked.
- Pirun detected and surfaced Antigravity's eligibility failure correctly.
- The accounts could not successfully run agents, so the end-to-end goal was not yet met.

At the user's request, both initial profile directories were removed before trying a new pair. Direct recursive deletion was not used; the exact old profile directories were moved to the Windows Recycle Bin, making the removal recoverable. `pirun.json` was reset before reauthentication.

### Second pair: full success

The user authenticated two different Google accounts into fresh `antigravity-one` and `antigravity-two` profiles.

During onboarding, interaction-data collection was explicitly disabled for each account. Verification of each profile's `settings.json` showed:

```json
{
  "enableTelemetry": false,
  "trustedWorkspaces": [
    "D:\\projectx\\CladGPT\\completions-proxy"
  ]
}
```

Both profiles also showed completed consumer onboarding, separate Pirun auth markers, and separate Antigravity OAuth token files.

The displayed signed-in accounts were different. Their identities are intentionally omitted here.

## Browser OAuth issue encountered

Automatic browser opening was not reliable on this Windows machine.

What happened:

1. Antigravity printed a long Google OAuth URL wrapped across terminal lines.
2. Pirun gained logic to strip terminal escape codes, join wrapped whitespace, and extract the complete URL through the fixed-length OAuth `state` parameter.
3. The code's Windows opener currently uses `explorer.exe`.
4. In actual interactive testing, the user reported that nothing opened on at least one attempt.
5. The successful workaround was to manually launch the extracted URL with Windows `rundll32.exe url.dll,FileProtocolHandler "<url>"`.

Therefore the OAuth flow itself works, but automatic opening should be considered a known reliability issue. A future change should probably use the known-working `rundll32.exe` invocation on Windows, then test it from the Node child-process path. The URL remains visible in the terminal, so manual opening is still possible.

Another small operational detail: authorization codes pasted through Markdown may contain backslashes before underscores (for example, `\_`). Those backslashes are Markdown escaping and are not part of the OAuth code. During testing they were removed before submitting the code to Antigravity.

Never store or reproduce one-time OAuth codes in documentation or source control.

## Verification performed

The implementation phase was intentionally fast and used only minimal testing, per the user's instruction.

Before commit `6eb2d97`, these checks passed:

```text
npm run check
node --test test\pirun-args.test.ts
```

The argument test suite reported three passing tests. It covers the positional preset invocation shape, typo/missing-value rejection, and `--` handling.

Manual verification also confirmed:

- Antigravity CLI `1.1.21` launches.
- File-backed token storage is selected under each private `--gemini_dir` profile.
- The OS keyring is not used for these profiles.
- Two different accounts can remain authenticated simultaneously.
- Each fresh profile has its own `pirun-auth.json` marker.
- Each fresh profile has its own `antigravity-cli\antigravity-oauth-token` file.
- Both profiles have `enableTelemetry: false`.
- `FOR-AGENTS.md` was not changed.

Most importantly, after the second pair was authenticated, real minimal Pirun jobs were run through both profiles:

```text
pirun run antigravity-one --timeout 120 --return-after 120 "Reply with exactly OK."
pirun run antigravity-two --timeout 120 --return-after 120 "Reply with exactly OK."
```

Results:

- `antigravity-one`: run `0bfb47`, succeeded in about 8.4 seconds, returned `OK`.
- `antigravity-two`: run `68d6d1`, succeeded in about 9.4 seconds, returned `OK`.
- Neither fresh account encountered the previous regional-eligibility error.
- Both runs produced normal Antigravity/Pirun token and result metadata.

The corresponding durable event streams are under:

- `D:\projectx\CladGPT\completions-proxy\.runs\0bfb47\events.jsonl`
- `D:\projectx\CladGPT\completions-proxy\.runs\68d6d1\events.jsonl`

These `.runs` artifacts are local/ignored runtime data, not source-controlled fixtures.

## Files changed by the implementation

Commit `6eb2d97` changed six tracked files, with approximately 728 insertions and 38 deletions:

- `bin/pirun.ts`
  - Harness selection and preset switching
  - Antigravity login orchestration
  - browser URL extraction/opening integration
  - isolation verification
  - Antigravity job spawning
  - streaming event digest and live progress support
  - conversation continuation
  - status/config/model/help integration
- `src/pirun-antigravity.ts`
  - Profile path generation
  - CLI discovery
  - isolation environment construction
  - Antigravity argument generation
  - OAuth URL extraction
  - profile/log inspection
  - authentication marker handling
- `src/pirun-config.ts`
  - `pi | antigravity` harness type
  - Antigravity preset configuration
  - migration/default behavior and incompatible-setting cleanup
- `src/pirun-args.ts`
  - Harness and Antigravity flags
  - `login` command parsing
- `README.md`
  - Persistent positional-preset model
  - direct OpenAI-compatible API usage
  - Antigravity account isolation and login usage
- `package.json`
  - Includes `src/pirun-antigravity.ts` in the syntax check

`FOR-AGENTS.md` remained unchanged by design.

## Current known limitations and risks

1. **Automatic browser opening on Windows is unreliable.** Manual URL opening worked. This is the clearest immediate polish item.
2. **The SSH-environment storage selector is an implementation workaround.** It is safe in the current design because it only affects the child environment and creates no network connection, but Antigravity could change its storage-detection logic in a future release. Keep the pre-login file-storage verification.
3. **No Antigravity conversation fork.** The CLI supports continuation by conversation ID, but no equivalent of Pi's fork was found/exposed.
4. **Telemetry opt-out is onboarding state, not a Pirun preset flag.** It was disabled for the two current profiles and verified in each settings file. New profiles require the same onboarding choice unless Pirun later automates it safely.
5. **Tools semantics differ by harness.** For Antigravity, `--no-tools` currently means do not bypass its permission prompts; it does not guarantee that every tool is removed from the harness.
6. **OAuth codes are interactive secrets.** They must not be logged into documentation, committed files, or chat handoffs.
7. **The test pass was intentionally minimal.** There is not yet a dedicated automated test suite for Antigravity URL parsing, event-digest translation, profile pathing, storage-mode detection, or browser launching.
8. **The current account profiles are machine-local.** `pirun.json`, `.runs`, and `%LOCALAPPDATA%\Pirun` are not portable through Git.
9. **Antigravity CLI behavior is version-sensitive.** The implementation was proven with `1.1.21`.

## Suggested next steps

The user stated that the next product phase will add more harness CLIs and, where applicable, allow each harness to use its own providers instead of a Pirun-configured API. Before broadening that architecture, a practical continuation order is:

1. Fix and minimally test Windows automatic OAuth browser opening, likely using `rundll32.exe url.dll,FileProtocolHandler` because that path worked manually.
2. Add small deterministic tests for:
   - wrapped/ANSI OAuth URL extraction;
   - stable and collision-resistant profile paths;
   - Antigravity CLI argument construction;
   - result/tool/error/usage digest parsing;
   - preset switching and incompatible config removal.
3. Decide whether Pirun should automate the telemetry opt-out for every new Antigravity profile or continue exposing the native onboarding choice. The user's preference is unequivocally no interaction-data collection.
4. Abstract harness-specific behavior behind a small adapter interface before adding the next CLI. The current `harness` discriminator and `spawnHarness` split provide the starting point, but authentication, model listing, capabilities, session continuation, forking, tool permissions, and native-provider behavior should become explicit adapter capabilities.
5. Preserve the existing UX contract: positional required preset, configuration merged and persisted during normal agent launches, no separate setup ceremony, and prompts/timers remaining ephemeral.
6. Wait for the user's explicit instructions before changing `FOR-AGENTS.md`.

## How to resume safely in a new chat

Start by checking:

```text
cd D:\projectx\CladGPT\completions-proxy
git status --short
git log -4 --oneline
node bin\pirun.ts config antigravity-one
node bin\pirun.ts config antigravity-two
```

Do not print token-file contents or account identities. Presence checks are sufficient. If a live sanity check is needed, use a minimal request such as:

```text
node bin\pirun.ts run antigravity-one --timeout 120 --return-after 120 "Reply with exactly OK."
```

The currently proven outcome is that Pirun can keep two distinct Antigravity accounts authenticated concurrently in separate local profiles and successfully run an agent through each without the regional error that affected the first discarded account pair.
