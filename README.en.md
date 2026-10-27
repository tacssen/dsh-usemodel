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
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  ],
  "defaultMaxTokens": 8192
}
```

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
