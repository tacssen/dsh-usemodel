# dsh-usemodel

[中文说明](./README.md) · **English**

Plug your own OpenAI-compatible API into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Paste a base URL, an API key, or a share link — the plugin parses it, pulls the model
list from the upstream, and the models appear in the model picker.

## Install

```powershell
# 1. drop the plugin into your dsh home
git clone https://github.com/tacssen/dsh-usemodel "$env:USERPROFILE\.dsh\plugins\dsh-usemodel"

# 2. link it into the desktop profile
mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-usemodel" "$env:USERPROFILE\.dsh\plugins\dsh-usemodel"
```

Then add it to `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-usemodel"] } },
  "dependencies": {
    "dsh-usemodel": "link:C:/Users/<you>/.dsh/plugins/dsh-usemodel"
  }
}
```

Restart DSH. The bundle ships its own `cordis.patch.yml`, so nothing else to wire.

## Use

**Settings → 自定义模型 (Custom Models)** in the left column.

Paste box at the top handles all of these:

| You paste | It produces |
|---|---|
| `https://api.openai.com/v1` | base URL only |
| `https://api.openai.com/v1/chat/completions` | endpoint suffix stripped |
| `https://api.deepseek.com` | `/v1` appended |
| `sk-xxxx` | key only, base URL defaults to OpenAI |
| base URL + key on two lines (other text allowed) | both |
| `curl ... -H "Authorization: Bearer sk-..."` | both |
| `https://xxx/v1?key=sk-...` | key from query string |
| `https://some-proxy/share/abc` | **fetched once**, reads `base_url` / `api_key` / models from the JSON or YAML it returns |
| a `base_url: ... api_key: ...` config blob | fields read directly |

Once it has both a URL and a key it calls `GET {baseURL}/models` and fills in the model
list, dropping embedding / rerank / whisper / tts / dall-e style entries.

Recognition pre-fills the editor — nothing is saved until you confirm.

### Model aliases

Upstream ids from relay sites are ugly — they carry group and billing markers:

```
[按量6] deepseek-v4.1-flash-1017 [不补]
[反重力1][次][抗截断] gemini-3.8-flash[不补]
```

Put `=>` between the real id and the name you want to see:

```
[按量6] deepseek-v4.1-flash-1017 [不补] => DeepSeek V4.1 Flash
gpt-4o-mini
```

- Left side must be the exact upstream id.
- Without `=>`, bracketed segments are stripped automatically for the display name.
- The DSH-side model id keeps the real id, so renaming never breaks a selected model.
- Get exact ids via the "pull model list from upstream" button, or `curl {baseURL}/models`.

### Reading an error

Raw upstream bodies (relay sites love dumping JSON blobs) no longer hit the UI. You get
what went wrong plus what to change, and the upstream's own wording and the full body sit
in a collapsed **details** section:

| You see | HTTP | What it means / what to fix |
|---|---|---|
| API key was not accepted | 401 | key truncated, expired or revoked; some relays want it without the `sk-` prefix |
| Key rejected: no permission or disabled | 403 | group/permission, IP allow-list, region lock, or the key was disabled |
| Not enough balance | 402 | top up upstream, or use a key with quota |
| No endpoint at this address | 404 | base URL must end at `/v1`; the model name must exist upstream |
| Address points at a web page | 405 | base URL is the site root, not the API |
| Rate limited, or quota used up | 429 | wait a bit; check plan quota and concurrency |
| Upstream is failing | 5xx | retried automatically with backoff (see below); if it persists the provider is down |
| Cannot reach this address | 0 | check base URL spelling, network, proxy |
| Probe/test timed out | 0 | 12s / 20s without a response; try another route or fill model names by hand |

`403 This token has no access to model X` lands in the 403 row: the key is fine, the model
name is not exact. new-api style relays answer 403 (not 401) for an unknown model.

### Automatic retry

Relay sites flap, gateways throw 502, sockets get cut, upstream returns an empty stream.
The plugin re-sends quietly, Codex style: you just see a short pause and the answer
continuing, instead of having to press continue.

- It only retries while **nothing from this turn has reached the UI yet**. Content you
  already saw is never re-sent, otherwise the transcript would carry duplicate blocks.
- Exponential backoff with jitter: 800 ms first, capped at 20 s, 6 total attempts by default.
- A provider `Retry-After` header wins (seconds or an HTTP date), bounded by the max delay.
- Retried: 5xx, timeouts, unreachable, empty stream, 429 rate limits.
  Not retried: 401/403/404/402, where re-sending cannot help.
- Pressing stop during the wait aborts at once and sends no further request.

Tune it per channel; empty means "use the global default":

| Field | Default | Meaning |
|---|---|---|
| `retry.attempts` | 6 | total attempts including the first; 1 disables retry, max 12 |
| `retry.initialDelayMs` | 800 | wait before the first retry |
| `retry.maxDelayMs` | 20000 | per-wait cap, also the `Retry-After` cap |

Editable in the settings dialog, or directly in `config.json`: per channel inside a
`channels[]` entry, globally as a top-level `retry` object (channel wins).

## How it works

- Host half (`index.js`) registers one provider route:
  `ctx.llm.registerAdapter(['usemodel'], adapter)`. Model ids are `<channelId>::<modelId>`.
- The adapter implements the `dsh-llm` StreamChunk protocol:
  `block-start` → `text-delta` / `reasoning-delta` / `tool-call-delta` → `block-end` → `usage` → `finish`.
- Browser half (`client.js`) adds a settings column via
  `ctx.slots.inject('settings.section', ...)`.
- The two halves talk over the plugin's own routes under `/api/usemodel`
  (`GET /state`, `POST /save` `/delete` `/test` `/detect` `/models`), loopback only.

## Data

`%USERPROFILE%\.dsh\usemodel\config.json`

```json
{
  "channels": [
    {
      "id": "abc12345",
      "name": "My OpenAI",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": ["gpt-4o-mini"],
      "contextWindow": 1000000,
      "maxTokens": 65536,
      "retry": { "attempts": 6, "initialDelayMs": 800, "maxDelayMs": 20000 }
    }
  ],
  "defaultMaxTokens": 65536,
  "retry": { "attempts": 6, "initialDelayMs": 800, "maxDelayMs": 20000 }
}
```

Both token fields are optional; leave them 0 to use the plugin defaults:

| Field | Default | Effect |
|---|---|---|
| `contextWindow` | `1000000` | Capacity reported to the kernel; drives the auto-compaction threshold (`floor(contextWindow × 0.8)`) and the usage bar |
| `maxTokens` / `defaultMaxTokens` | `65536` | Per-response `max_tokens`, also the completion budget reserved during compaction |

Constraint: keep `maxTokens` well below `contextWindow`, and
`floor(contextWindow × 0.8) > maxTokens + headroomTokens(65536)`, otherwise the compactor refuses to
start with `leaving no pressure budget`. The defaults `1000000 / 65536` satisfy it: threshold 800000,
reserved 65536.

`contextWindow` is a **local declaration**: it only paces DSH compaction and does not make the upstream
accept more tokens. A value above the upstream real ceiling gets long requests rejected there.
Same for `max_tokens`: raising it grants headroom, the model still stops when it is done.

Plaintext key, local machine only. Removing the plugin leaves the file alone; hand edits are
picked up on the next request.

## Limitations

- Chat Completions wire format only — no Anthropic Messages, no Responses API.
- Upstreams without `GET /models` return no list; type the model names yourself.
- Paste detection issues one GET to whatever URL you pasted (12 s timeout), including LAN
  addresses, so local Ollama works. Your paste, your call.
- Keys are stored in plaintext; protection is whatever your user-profile ACL gives.

## License

MIT
