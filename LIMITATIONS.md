# Known limits

Things `pirun` cannot currently report or do, and the layer that would have to
change. Written down so nobody re-derives them from an empty field. Each entry
says what was actually observed, not what was assumed.

---

## Cost is always zero for endpoint runs

`pirun` prints a `$` figure only when the cost is non-zero, and for endpoint
presets it never is. Pi computes cost from the `cost` block in its
`models.json`; the entries Pirun registers carry zeros because **nothing in
this project knows any prices**, and no observed provider returns a price in
its `usage` payload.

**To fix:** carry per-model `cost` (input / output / cacheRead / cacheWrite per
million tokens) in the provider catalog and copy it into the registered Pi
model rows. Until then, treat token counts as the cost signal.

---

## Reasoning tokens are not split out on endpoint runs

For Pi-driven endpoint runs, a thinking-heavy turn looks the same as a terse
one in the numbers: the providers observed do not put a reasoning-token count
in `usage`, and Pi reports only its own `usage.reasoning`, which stays `0`.
Antigravity runs do count `thinking_tokens` into the digest's output total.

**To fix:** where a provider reports it (`completion_tokens_details.
reasoning_tokens` is the usual OpenAI shape), the count would still have to
reach Pi's own usage accounting — an upstream change, not a Pirun one.

---

## Cache writes are invisible; cache hits depend on the provider

`cacheRead` is real and useful — it is what makes the agent-versus-one-shot
difference measurable. `cacheWrite` is always `0`: observed providers report
cached-read tokens but nothing about what was *written* into the cache.

There is also no way to *control* caching: no explicit cache breakpoints, no
TTL hint, no way to ask a provider to keep a prefix warm. Prefix caching is
implicit and best-effort, which is why `pirun` pins an agent's model —
switching models mid-session silently discards the prefix.

---

## Context windows are declared, not measured

`pirun agents <preset> <name>` shows `context 14.5k / 128.0k`. The numerator is
real: the last turn's input + cacheRead + output, straight out of the event
stream. The denominator is a **declaration** — the catalog's `contextWindow`
(canonical entry, fetched-list default, or a `provider model --context-window`
override), with a 128k floor. Nothing verifies it against the provider; a model
whose window changed upstream goes unnoticed until a request fails.

**To fix:** no observed provider exposes model metadata reporting context
length, so the numbers stay hand-maintained. A check that flags a session
footprint exceeding the declared window would help.

---

## Live token counts and TPS are estimates

Completed turns use the provider usage from the harness's end-of-message
event. While a turn is in flight, `pirun` estimates generated tokens by
tokenizing the streamed deltas with `gpt-tokenizer` (`o200k_base`); the
last-10-second TPS comes from locally timestamped deltas. The estimate becomes
exact when the turn ends. A long provider-side queue correctly shows
`0.00 tok/s`; a slow start is not a model failure.

---

## Spend coverage is per-provider

`pirun spend` answers with real numbers only where a source exposes them:
DeepSeek balance, OpenRouter credits, Antigravity rate-limit windows (via
`agy -p "/usage"`). Other endpoints report `unsupported` — their APIs offer no
spend/quota endpoint that a bearer key can read. Exhaustion there still arrives
as a failed request, not as something checkable in advance.

---

## Headless plan mode can deny file reads, nondeterministically

Observed live (agy 1.1.21, `--permissions read` → `--mode plan`): in one turn
the agent's `view_file` of one file was auto-denied ("headless mode cannot
prompt … auto-denied") while an identical `view_file` of a second file in the
same directory was allowed, and the result status came back `CANCELED`. No
rule explains the difference. Consequence: `read` is the only level that
guarantees no writes, but it cannot guarantee the reading succeeds. The
working pattern for guaranteed read-only review is to inline the content into
the prompt so no file tool runs at all.

**To fix:** agy would need a headless read-allow policy (its `permissions.allow`
rules are per-profile, and profiles are shared by concurrent runs with
different levels, so pirun cannot seed them per run).

---

## Effort-tier model ids can compose a tier a model lacks

Antigravity publishes effort tiers inside model ids, and tiers vary per model
(some have high/medium/low, some high/low, some one tier, some none). pirun
keeps effort single-sourced by rewriting the id's tier when `--effort`
changes; if the composed id does not exist for that model, the harness rejects
it at run time with its own error. pirun cannot validate offline — the tier
list lives only in the harness's live catalog (`pirun models antigravity`).

---

## Model capability flags are declared, not probed

The catalog's `reasoning` flag decides whether Pi offers thinking levels for a
model; it comes from the shipped canonical rows or from
`pirun provider model <provider> <id> --reasoning`, never from asking the
provider. A model that reasons without being flagged still works — the flag
only gates the knob.

---

## Agent session ids are not always uuids

When an agent is created, Pi is given `--session-id <agent-name>` and reports
that name back as the session id. A forked agent gets a real uuid instead.
Both work for continuation, but the value in `agent.json` is not a stable
identifier type, so anything matching on shape will be surprised by one of the
two.
