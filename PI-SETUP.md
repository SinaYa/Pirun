# Driving the proxy with the Pi CLI harness

[Pi](https://pi.dev) is an OpenAI-compatible coding agent, so it talks to this
proxy with no adapter in between. This is the exact setup that was used to
verify the proxy end to end.

## 1. Install Pi

```bash
npm install -g @earendil-works/pi-coding-agent
```

`pi --version` should print `0.84.2` or newer. The binary lands in
`%APPDATA%\npm\pi.cmd`; add `%APPDATA%\npm` to `PATH` if the shell cannot find
it.

## 2. Start the proxy

Double-click `start.bat` in this folder, or run `node src/server.ts`. Leave it
running in its own window — Pi needs it alive for every turn.

## 3. Register the proxy as a Pi provider

Pi reads custom providers from `%USERPROFILE%\.pi\agent\models.json`. That file
is already written and looks like this:

```json
{
  "providers": {
    "cladgpt-proxy": {
      "baseUrl": "http://127.0.0.1:8899/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "authHeader": true,
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": true },
      "models": [
        { "id": "commandcode.deepseek-v4-flash", "name": "DeepSeek V4 Flash (via CladGPT proxy)", "reasoning": true, "contextWindow": 1000000, "maxTokens": 32768 },
        { "id": "deepseek.deepseek-v4-pro",      "name": "DeepSeek V4 Pro direct (via CladGPT proxy)", "reasoning": true, "contextWindow": 1000000, "maxTokens": 65536 }
      ]
    }
  }
}
```

Three details matter:

- **`apiKey: "local"` is a placeholder.** The proxy ignores it unless `api_key`
  is set in `proxy.cfg`; Pi just refuses to list a model with no auth at all.
- **Model ids use the `.` separator** (`deepseek.deepseek-v4-flash`), not `>`.
  Pi's `--model` flag reads `:` as a thinking-level suffix and `>` needs shell
  quoting, so the dot form is the one that survives both. The proxy treats all
  three spellings identically.
- **`supportsDeveloperRole: false`** makes Pi send its system prompt as a
  `system` message, which every provider behind the proxy understands.

Pi re-reads this file whenever you open `/model`, so you can add entries from
`GET /v1/models` without restarting.

Check that it took:

```bash
pi --list-models cladgpt
```

```
provider       model                          context  max-out  thinking  images
cladgpt-proxy  commandcode.deepseek-v4-flash  1M       32.8K    yes       no
cladgpt-proxy  deepseek.deepseek-v4-pro       1M       65.5K    yes       no
```

## 4. Run something

Interactive:

```bash
pi --model cladgpt-proxy/deepseek.deepseek-v4-flash
```

One-shot, which is what the verification run used:

```bash
pi -p --approve --model cladgpt-proxy/deepseek.deepseek-v4-flash "Read numbers.txt here, write sum.txt containing only the total, then state the total."
```

Pi reads the file with its `read` tool, writes `sum.txt` with its `write` tool,
and answers — three streaming round-trips through the proxy, all visible in the
proxy's log:

```
info  chat deepseek.deepseek-v4-flash -> deepseek>deepseek-v4-flash@deepseek-v4-flash [stream]
info  chat deepseek.deepseek-v4-flash -> deepseek>deepseek-v4-flash@deepseek-v4-flash [stream]
info  chat deepseek.deepseek-v4-flash -> deepseek>deepseek-v4-flash@deepseek-v4-flash [stream]
```

## 5. Watch routing take over

Append one line to `config/cascaded-inference-routing.rules`:

```
*>deepseek-v4-flash = commandcode>deepseek-v4-flash
```

Run the same Pi command again. Pi still believes it is talking to DeepSeek, and
the task still completes — but every turn went somewhere else:

```
info  chat deepseek.deepseek-v4-flash -> commandcode>deepseek-v4-flash@standard (routed) [stream]
info  chat deepseek.deepseek-v4-flash -> commandcode>deepseek-v4-flash@standard (routed) [stream]
info  chat deepseek.deepseek-v4-flash -> commandcode>deepseek-v4-flash@standard (routed) [stream]
```

No restart, no Pi config change. Delete the line to put it back.

## Notes

- Set `log_level = debug` in `proxy.cfg` to see the full upstream body for each
  of Pi's turns — useful when a provider rejects something Pi sent.
- Pi's thinking levels map onto `reasoning_effort`, which the proxy translates
  per provider (DeepSeek, for example, receives `thinking: {type: enabled}`).
- Pi keeps its own credentials in `~/.pi/agent/auth.json`. The proxy's keys stay
  in this folder's `.env` and are never sent to Pi.
