# dsh-usemodel

**中文** · [English](./README.en.md)

把你自己买的 OpenAI 兼容 API 接进 DeepSeek Harness：设置里一栏管理 Key，粘贴一句链接就能认，
模型直接进模型选择器。

## 安装

```powershell
git clone https://github.com/tacssen/dsh-usemodel "$env:USERPROFILE\.dsh\plugins\dsh-usemodel"
mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-usemodel" "$env:USERPROFILE\.dsh\plugins\dsh-usemodel"
```

然后在 `~/.dsh/profiles/desktop/package.json` 里登记：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-usemodel"] } },
  "dependencies": {
    "dsh-usemodel": "link:C:/Users/<你>/.dsh/plugins/dsh-usemodel"
  }
}
```

重启 DSH。插件自带 `cordis.patch.yml`，其余不用接线。

## 用

设置 → 左侧「自定义模型」→ 新增渠道：

| 字段 | 说明 |
|---|---|
| 显示名称 | 模型选择器里显示成「名称 · 模型名」 |
| Base URL | 填到 `/v1` 这一层，插件自己拼 `/chat/completions` |
| API Key | 明文存本机配置文件 |
| 模型名 | 一行一个，必须是上游真实 id |

保存后**不用重启 DSH**，重新打开模型下拉即可看到。

## 粘贴识别

设置页顶部有个粘贴框，把下面任意一种贴进去点「识别」（Ctrl+Enter）：

| 贴进来 | 识别结果 |
|---|---|
| `https://api.openai.com/v1` | 只填地址 |
| `https://api.openai.com/v1/chat/completions` | 砍掉端点后缀 |
| `https://api.deepseek.com` | 自动补 `/v1` |
| `sk-xxxx` | 只认 Key，地址按 OpenAI 官方兜底 |
| `地址` + `Key` 两行（或中间夹别的字） | 两个都认 |
| `curl ... -H "Authorization: Bearer sk-..."` | 两个都认 |
| `https://xxx/v1?key=sk-...` | 从 query 里取 Key |
| `https://中转站/share/abc` | **抓一次**，从返回的 JSON/yaml 里读 `base_url` / `api_key` / 模型 |
| 整段 `base_url: ... api_key: ...` 配置 | 直接读字段 |

认到「地址 + Key」之后会顺手请求一次 `GET {baseURL}/models`，把模型列表填好
（自动滤掉 embedding / rerank / whisper / tts / dall-e 这类非对话模型）。

编辑弹窗里也有「从上游拉取模型列表」按钮，改完地址或 Key 可以重新拉。

## 原理

- Host 半（`index.js`）用 `ctx.llm.registerAdapter(['usemodel'], adapter)` 注册一条 provider 路由，
  模型 id 是 `<渠道id>::<模型名>`。
- adapter 实现 `dsh-llm` 的 StreamChunk 协议：
  `block-start` → `text-delta` / `reasoning-delta` / `tool-call-delta` → `block-end` → `usage` → `finish`。
- 浏览器半（`client.js`）通过 `ctx.slots.inject('settings.section', ...)` 往设置页左栏加一项。
- 两边用插件自己的路由 `/api/usemodel/*` 通信（GET `/state`，POST `/save` `/delete` `/test` `/detect` `/models`，只接受本机来源）。

## 数据

`%USERPROFILE%\.dsh\usemodel\config.json`

```json
{
  "channels": [
    {
      "id": "abc12345",
      "name": "我的 OpenAI",
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

删插件不会动这个文件；手改 JSON 后下一次请求就会重读。

## 装

1. 目录放到 `%USERPROFILE%\.dsh\plugins\dsh-usemodel`
2. 符号链接进 profile：`node_modules\dsh-usemodel -> 上面的目录`
3. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加 `dsh-usemodel`，
   `dependencies` 加 `"dsh-usemodel": "link:C:/Users/23090/.dsh/plugins/dsh-usemodel"`
4. 重启 DSH（bundle 自带的 `cordis.patch.yml` 会 insert 插件本体那一行）

## 自检

开发时用 mock ctx 跑过两类测试（不依赖真实 API Key）：

- `apply()` 的注册调用、适配器方法形状、HTTP API 的增删改查与 baseURL 规范化
- 起一个假 OpenAI 上游返回 SSE，断言完整 chunk 序列：
  reasoning/text 聚合、两个并行工具调用的 id/name/参数拼接、usage 扣缓存、`finish.kind = tool-calls`、
  以及 DSH 消息 → OpenAI 消息的角色投影（system / user / assistant+tool_calls / tool）

## 已知限制

- 只支持 OpenAI Chat Completions 一种线格式（`/chat/completions`），不支持 Anthropic Messages 或 Responses API。
- 某些站不实现 `GET /models`，那就拉不到列表，模型名手填（其余功能不受影响）。
- 粘贴识别会对你贴进来的 URL 发一次 GET（12 秒超时），内网地址也照发，自己贴的东西自己负责。
- API Key 明文落盘，权限依赖用户目录本身的 ACL。
