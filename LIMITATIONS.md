# Known limits

Things `pirun` cannot currently report or do, and the layer that would have to
change. Written down so nobody re-derives them from an empty field.

Each entry says what was actually observed, not what was assumed.

---

## Cost is always zero

`pirun` prints a `$` figure only when the cost is non-zero, and it never is.

Pi computes cost from the `cost` block in its own `models.json`; the installer
generates entries without one, because **nothing in this project knows any
prices**. `config/inference-providers.yaml` describes capabilities, not rates,
and no provider returns a price in its `usage` payload — DeepSeek returns token
counts only, and Command Code the same.

Observed on a real turn:

```json
"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
```

**To fix:** add per-model `cost` (input / output / cacheRead / cacheWrite per
million tokens) to the canonical `models:` map in
`config/inference-providers.yaml`, and have `bin/install.ts` copy it into each
Pi model entry. Command Code's bundled reference
(`node_modules/command-code/dist/bundled/command-code-knowledge/reference/models.md`)
carries a `$/1M in/out` column for the models it serves, which would cover that
provider. CrofAI and DeepSeek would need their own numbers.

Until then, treat token counts as the cost signal.

---

## Reasoning tokens are not counted

`usage.reasoning` comes back as `0` even for models that reason.

The response mapping in `config/inference-providers.yaml` extracts
`reasoning_content` — the *text* — but there is no field mapped for reasoning
token counts, and the providers observed do not put one in `usage`. So a
thinking-heavy turn looks the same as a terse one in the numbers, while costing
much more.

`pirun speedtest <preset>` works around this only for benchmarking: it counts the
observed reasoning and final text with one fixed `o200k_base` tokenizer and
labels both phase counts as estimates. It also reports the provider's actual
combined completion-token total separately. This does not make phase-specific
provider usage available to Pi or the general API.

**To fix:** find whether each provider reports it (DeepSeek's
`completion_tokens_details.reasoning_tokens` is the usual OpenAI shape), then
add a `reasoning_tokens` path to each `response` mapping. Pi would still need to
be told about it separately; it reads its own `usage.reasoning`.

---

## Cache writes are invisible; cache hits depend on the provider

`cacheRead` is real and useful — it is what makes the agent-versus-one-shot
difference measurable. `cacheWrite` is always `0`.

DeepSeek reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and
`prompt_tokens_details.cached_tokens`, but nothing about what was *written* into
the cache. Command Code reports `prompt_tokens_details.cached_tokens`.

**CrofAI is unverified** — that account has no credits, so no CrofAI request has
ever succeeded here. Whether its cache figures come through at all is unknown.

There is also no way to *control* caching: no explicit cache breakpoints, no TTL
hint, no way to ask a provider to keep a prefix warm. Prefix caching is implicit
and best-effort, which is why `pirun` pins an agent's model — switching models
mid-session silently discards the prefix.

---

## Context windows are declared, not measured

`pirun agents <preset> <name>` shows `context 14.5k / 1000.0k`. The numerator is real: it
is the last turn's input + cacheRead + output, straight out of Pi's event
stream. The denominator is a **declaration**, resolved in this order:

1. the provider variant's `context_length`, if it states one — only CrofAI
   variants do;
2. the canonical model's `context_length` in `config/inference-providers.yaml`,
   which was filled in from vendor model cards and Command Code's own reference;
3. a 128k floor.

`ox-alpha` is at the floor because no published figure exists for it — it is a
stealth model that appears in no catalogue. Its real window is unknown, so its
gauge is a guess.

Nothing verifies these numbers against the provider. A model whose window was
raised or lowered upstream would go unnoticed until a request failed.

**To fix:** no provider here exposes a model-metadata endpoint that reports
context length, so this would stay hand-maintained. What would help is a check
that flags when a session's measured footprint exceeds the declared window.

---

## Sampling knobs the interface does not carry

Vendor guidance for several of these models includes `top_k`, `min_p` and
`repetition_penalty`. `config/base-ai-request-interface.yaml` does not define
them, and none of the three interface mappings send them, so those parts of the
published recommendations are dropped:

| Model | Published, not sent |
| --- | --- |
| Qwen3.x (thinking) | `top_k` 20, `min_p` 0 |
| Qwen3.x (instruct) | `top_k` 20, `top_p` 0.8, `presence_penalty` 1.5 |
| MiniMax M2.5 / M2.7 | `top_k` 40, `min_p` 0.01 (M2.5) |
| Gemma 4 | `top_k` 64–65 |
| Laguna S 2.1 | `top_k` 20 |

This was left alone deliberately rather than added blindly: `top_k` is not an
OpenAI-standard field, DeepSeek's API rejects unknown parameters, and the
Command Code adapter has a fixed whitelist in `internalParams` that would drop
them anyway. Adding them means adding the settings to the base interface **and**
per-provider support checks, so that a model gets `top_k` only where the route
accepts it.

Everything else in the guidance — temperature, top_p, max_tokens, reasoning
effort — is applied, and `pirun models <preset>` shows what each model gets.

---

## Live token counts and TPS are estimates

Completed turns use the provider usage from Pi's `message_end` event. While the
current turn is in flight, `pirun` estimates generated tokens by tokenizing its
streamed reasoning, text, and tool-call deltas with `gpt-tokenizer`. The reported
last-10-second TPS is computed from those locally timestamped deltas.

The estimate becomes exact when the turn ends and provider usage arrives. During
generation it can differ from the provider's tokenizer, and a long quiet period
can correctly show `0.00 tok/s` even after earlier output. No upstream interface
offers phase-specific live usage.

**To fix:** an estimate could be produced by counting characters in the streamed
deltas, but it would be an estimate. Nothing upstream offers better.

---

## No quota, rate-limit or account visibility

Nothing here surfaces remaining credits, rate limits, or per-key spend. The
CrofAI 401 (`Not Enough Credits`) and the Command Code
`MODEL_NOT_IN_PLAN` / `403 Model/provider not recognized` responses are the only
signals, and they arrive as a failed request rather than as something checkable
in advance.

Command Code's CLI has a usage endpoint (`/usage/credits`, `/usage/summary`,
seen in its bundle) but reaching it means authenticating separately from the
generation path this project uses.

---

## Concurrency ceiling on one route

`commandcode.*` requests serialize **two at a time** — a semaphore in
`src/command-code-cli-adapter.ts` (`DEFAULT_CONCURRENCY = 2`, overridable with
`COMMANDCODE_ADAPTER_CONCURRENCY`). Fanning out five agents on those models
queues three of them, and nothing reports the wait.

That route also prepends roughly 7,400 tokens of Command Code's own system
prompt to every request, which no setting here removes.

---

## Model capability flags are inferred, not probed

Pi's model registry records `reasoning: true/false` per model. The installer
derives it from whether a provider variant declares `reasoning_effort` /
`custom_reasoning`, or whether the model has a tuned `reasoning_effort`. Nothing
asks the provider.

`stealth/ox-alpha` is the case that exposed this: it demonstrably returns
`reasoning_content`, but the config states no reasoning capability for it, so Pi
is told `reasoning: false`. The proxy still relays its reasoning either way —
the flag only decides whether Pi offers thinking levels for that model.

**To fix:** a `reasoning: true` field on the canonical model entry, set from
observation. Worth doing when a second model hits the same gap.

## Agent session ids are not always uuids

When an agent is created, Pi is given `--session-id <agent-name>` and reports
that name back as the session id. A forked agent gets a real uuid instead. Both
work for continuation, but the value in `agent.json` is not a stable identifier
type, so anything matching on shape will be surprised by one of the two.
