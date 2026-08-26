# completions-proxy API

A local, OpenAI-compatible completions endpoint that sits in front of every
inference provider CladGPT knows about, and applies the same cascaded routing
rules — but from its **own** configuration files. Nothing in this folder reads
or writes the parent project's config, and the parent project does not know
this proxy exists.

- Base URL: `http://127.0.0.1:8899/v1`
- Auth: none by default (set `api_key` in `proxy.cfg` to require a bearer token)
- Wire format: OpenAI Chat Completions, streaming and non-streaming

---

## Starting it

Double-click **`start.bat`**, or:

```bash
node src/server.ts
```

Node 22.18+ is required — the proxy runs its TypeScript sources directly, with
no build step. On startup it prints the port, the routing files it loaded, and
how many API keys it found.

Everything tunable lives in [`proxy.cfg`](proxy.cfg): port, host, default
provider/model, bearer token, timeout, log level.

---

## Naming a model

The `model` field accepts four spellings:

| You send | Means |
| --- | --- |
| `deepseek>deepseek-v4-pro` | provider `deepseek`, model `deepseek-v4-pro`, default variant |
| `crofai>kimi-k2.6@kimi-k2.6-precision` | explicit provider, model **and** variant |
| `deepseek:deepseek-v4-pro` | `:` alias, for clients that mangle `>` |
| `deepseek-v4-pro` | model only — the provider comes from `default_provider` in `proxy.cfg` |

Omit `model` entirely and you get `default_provider` + `default_model`.

`GET /v1/models` lists every valid id.

Whatever you ask for is only a **request**. The routing rules in
`config/cascaded-inference-routing.rules` get the final say — see
[Routing](#routing) below.

---

## `POST /v1/chat/completions`

Standard OpenAI request body. Recognised fields:

`messages` (required), `model`, `stream`, `temperature`, `top_p`, `max_tokens`
(or `max_completion_tokens`), `presence_penalty`, `frequency_penalty`,
`response_format`, `reasoning_effort`, `tools`, `tool_choice`,
`parallel_tool_calls`, `stop`, `seed`, `n`.

Fields you omit fall back to the defaults in
`config/base-ai-request-interface.yaml`. Fields the chosen provider does not
understand are dropped by that provider's interface mapping rather than sent
and rejected.

`reasoning_effort` accepts `none | minimal | low | medium | high | xhigh` and is
translated per provider — DeepSeek, for example, turns it into its own
`thinking: {type: enabled}` shape.

### Non-streaming

```bash
curl -s http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek>deepseek-v4-flash","messages":[{"role":"user","content":"Say hello"}],"max_tokens":20}'
```

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1787393805,
  "model": "deepseek>deepseek-v4-flash",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hello!" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14 },
  "x_completions_proxy": {
    "requested_provider": "deepseek",
    "requested_model": "deepseek-v4-flash",
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "variant": "deepseek-v4-flash",
    "provider_model": "deepseek-v4-flash",
    "interface_mapping": "deepseek-chat-completions",
    "endpoint": "https://api.deepseek.com/chat/completions",
    "override": null
  }
}
```

`x_completions_proxy` is the one non-standard field: it reports where the
request actually went. OpenAI clients ignore unknown top-level keys, so it is
safe to leave on.

When the model returns reasoning, it arrives as
`choices[0].message.reasoning_content`.

### Streaming

Set `"stream": true` and you get normal OpenAI SSE: `chat.completion.chunk`
objects terminated by `data: [DONE]`. The proxy normalises every provider's
delta shape, so `delta.content`, `delta.reasoning_content` and
`delta.tool_calls` are always in the same place regardless of who served the
request.

```bash
curl -N http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek>deepseek-v4-flash","messages":[{"role":"user","content":"Count to five"}],"stream":true}'
```

If the provider fails **after** the stream has opened — a mid-generation 503, a
dropped connection — the headers are already sent, so there is no status code
left to change. The proxy writes the upstream error as its own SSE payload and
closes the turn with `finish_reason: "error"`:

```
data: {"error":{"type":"server_error","message":"Service temporarily unavailable."}}

data: {"id":"chatcmpl-…","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}

data: [DONE]
```

Without this a mid-stream failure looks exactly like a model that chose to say
nothing, which an agent harness reads as a finished turn and acts on.

### Tool calling

Pass OpenAI `tools` / `tool_choice` through untouched:

```json
{
  "model": "deepseek>deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "Weather in Paris?" }],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
      }
    }
  ]
}
```

Tool calls come back on `choices[0].message.tool_calls` with
`finish_reason: "tool_calls"`, and stream as `delta.tool_calls`.

---

## `POST /v1/completions`

Legacy text completions, for tools that still speak it. `prompt` (string or
array of strings) is wrapped into a single user message. Streaming is not
supported here — use the chat endpoint.

```bash
curl -s http://127.0.0.1:8899/v1/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek>deepseek-v4-flash","prompt":"Finish this line: the sky is","max_tokens":10}'
```

Returns an `object: "text_completion"` payload with `choices[0].text`.

---

## `GET /v1/models`

Every provider/model/variant combination defined in
`config/inference-providers.yaml`, in OpenAI list shape:

```json
{
  "object": "list",
  "data": [
    {
      "id": "crofai>kimi-k2.6@kimi-k2.6-precision",
      "object": "model",
      "owned_by": "crofai",
      "provider": "crofai",
      "provider_label": "CrofAI",
      "provider_model": "kimi-k2.6-precision"
    }
  ]
}
```

The default variant of a model is listed without the `@variant` suffix.

---

## `GET /v1/routing?model=…`

Diagnostics. Explains, without spending a token, exactly where a given model
name would land — including which rule (and which line of which file)
rewrote it.

```bash
curl -s "http://127.0.0.1:8899/v1/routing?model=commandcode>glm-5.2"
```

```json
{
  "asked": { "provider": "commandcode", "model": "glm-5.2" },
  "resolved": { "provider": "deepseek", "model": "deepseek-v4-flash", "…": "…",
    "override": { "lineNumber": 70, "selector": "*>glm-5.2", "override": "deepseek>deepseek-v4-flash" } },
  "rules": { "source": "…/cascaded-inference-routing.rules", "rule_count": 1, "group_count": 6, "error": null },
  "upstream_body_preview": { "model": "deepseek-v4-flash", "…": "…" }
}
```

Turn it off with `expose_routing_endpoint = false` in `proxy.cfg`.

---

## `GET /health`

Liveness plus a summary of what the process loaded: port, defaults, config
paths, and the **names** (never values) of the API keys it found in `.env`.
This endpoint is reachable without the bearer token.

---

## Routing

Three files in `config/` decide where a request actually goes. They started as
copies of the parent project's, and diverge freely from here.

| File | Job |
| --- | --- |
| `inference-providers.yaml` | Providers, base URLs, API-key env var names, models, variants, and the request/response field mappings per provider |
| `cascaded-inference-routing.rules` | `selector = override` rules that rewrite a requested provider/model into a different one |
| `inference-model-groups.rules` | Named groups (`$strong-model`, `$fast-model`, …) referenced from the rules |
| `inference-model-scores.yaml` | Per-candidate `price` / `speed` / `reliability` / `intelligence` scores used by `prefer` clauses |
| `base-ai-request-interface.yaml` | The neutral request shape and its defaults |

A rule is `selector = override`, optionally with a `prefer` clause. Later
matching rules win.

```
# send every GLM-5.2 request to DeepSeek instead
*>glm-5.2 = deepseek>deepseek-v4-flash

# if anything asks for a weak model, upgrade it to the best-scoring strong one
*>($weak-model & !$cheap-model) = *>$strong-model prefer intelligence:70,price:30

# retry-elsewhere style: any reliable model that is not the one asked for
* = *>($reliable-model & !_same) prefer reliability:50,intelligence:30,price:20
```

The syntax is documented in full in the comment headers of the two `.rules`
files.

With `hot_reload_routing = true` (the default) the rules are re-read before
every request, so editing them takes effect immediately — no restart. If a
rules file is malformed the proxy keeps the last good version, moves the broken
one aside as `*.invalid.*`, and reports the problem in `GET /v1/routing`.

---

## API keys

`.env` in this folder is a copy of the parent project's and is read at startup;
real environment variables take precedence over it. Each provider declares
which key it needs via `api_key_env` in `inference-providers.yaml`
(`DEEPSEEK_API_KEY`, `CROF_API_KEY`, `COMMANDCODE_API_KEY`). A request for a
provider whose key is missing fails with a 500 naming the variable.

Keys are never logged and never returned by any endpoint.

---

## Errors

Errors use the OpenAI envelope, with the upstream body preserved under
`details`:

```json
{
  "error": {
    "message": "CrofAI request failed (401).",
    "type": "completions_proxy_error",
    "code": 401,
    "details": "{\"error\":{\"code\":401,\"message\":\"Not Enough Credits\"}}"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Bad JSON, missing `messages`/`prompt` |
| 401 | `api_key` is set in `proxy.cfg` and the bearer token did not match |
| 404 | Unknown route, or the routing endpoint is disabled |
| 500 | Unknown provider/model/variant, or a missing API key |
| 502 | Provider unreachable or returned something unusable |
| 504 | `request_timeout_ms` elapsed, or the client hung up |

Upstream 5xx responses are retried once after 250 ms before the error is
returned. The Command Code adapter separately retries transient transport and
stream failures up to twice when no content, reasoning, finish event, or tool
call has reached the client. A stream is never replayed after output is visible.

---

## Pointing a client at it

Anything that speaks OpenAI works. Set the base URL to
`http://127.0.0.1:8899/v1`, and any non-empty API key (the proxy ignores it
unless `api_key` is set in `proxy.cfg`).

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8899/v1
export OPENAI_API_KEY=local
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="local")
print(client.chat.completions.create(
    model="deepseek>deepseek-v4-pro",
    messages=[{"role": "user", "content": "hello"}],
).choices[0].message.content)
```

For the Pi CLI harness specifically, see [`PI-SETUP.md`](PI-SETUP.md).
