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
| 模型 | 一行一个；左边真实 id，`=>` 右边自己起名 |

保存后**不用重启 DSH**，重新打开模型下拉即可看到。

### 模型显示名

真实 id 来自上游，很多中转站会把分组倍率塞进去，长得很难看：

```
[按量6] deepseek-v4.1-flash-1017 [不补]
[反重力1][次][抗截断] gemini-3.8-flash[不补]
```

用 `=>` 把「调接口用的 id」和「你看到的名字」拆开：

```
[按量6] deepseek-v4.1-flash-1017 [不补] => DeepSeek V4.1 Flash
[反重力1][次][抗截断] gemini-3.8-flash[不补] => Gemini 3.8 Flash
gpt-4o-mini
```

- 左边必须是**上游真实 id**，一个字符都不能错。
- 不写 `=>` 就自动把 `[方括号]` 段去掉当显示名。
- 模型在 DSH 侧的 id 用真实 id，所以**改显示名不会把会话里选中的模型弄丢**。
- 真实 id 从哪来：编辑弹窗里点「从上游拉取模型列表」，或者 `curl {baseURL}/models`。

### 报 `This token has no access to model X` 时

密钥没坏，是模型名不精确。new-api 系的中转站遇到找不到的模型名回的是这个 403，
不是 401。照着 `/models` 返回的 id 一字不差抄进去就好。

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
      "models": [
        { "id": "[按量6] deepseek-v4.1-flash-1017 [不补]", "name": "DeepSeek V4.1 Flash" },
        { "id": "gpt-4o-mini", "name": "gpt-4o-mini" }
      ],
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  ],
  "defaultMaxTokens": 8192
}
```

`models` 里的条目也接受旧写法（纯字符串 `"gpt-4o-mini"`），读进来会归一化成
`{ id, name }`，`name` 缺省时自动从 id 里清掉方括号段。

删插件不会动这个文件；手改 JSON 后下一次请求就会重读。

## 装

1. 目录放到 `%USERPROFILE%\.dsh\plugins\dsh-usemodel`
2. 符号链接进 profile：`node_modules\dsh-usemodel -> 上面的目录`
3. `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加 `dsh-usemodel`，
   `dependencies` 加 `"dsh-usemodel": "link:C:/Users/23090/.dsh/plugins/dsh-usemodel"`
4. 重启 DSH（bundle 自带的 `cordis.patch.yml` 会 insert 插件本体那一行）

## 自检

```bash
npm test          # 等价于 node test/run.mjs
```

四套测试全部用 mock 内核跑，不联网、不碰真实配置（每个脚本把 `DSH_HOME` 指到临时目录）：

| 文件 | 覆盖 |
|---|---|
| `test/selftest.mjs` | `apply()` 的注册调用、adapter 方法形状、HTTP API 增删改查、baseURL 规范化 |
| `test/sse.mjs` | 假 OpenAI 上游发 SSE，断言完整 chunk 序列：reasoning/text 聚合、两个并行工具调用的 id/name/参数拼接、usage 扣缓存、`finish.kind = tool-calls`、DSH 消息 → OpenAI 消息的角色投影 |
| `test/detect.mjs` | 10 种粘贴格式 + 假中转站分享链接 + 垃圾文本拒绝 |
| `test/alias.mjs` | `id => 名字`、`id \| 名字`、对象形式、方括号自动清理、listModels/resolveModel 的名称与 id 分离 |

## 已知限制

- 只支持 OpenAI Chat Completions 一种线格式（`/chat/completions`），不支持 Anthropic Messages 或 Responses API。
- 某些站不实现 `GET /models`，那就拉不到列表，模型名手填（其余功能不受影响）。
- 粘贴识别会对你贴进来的 URL 发一次 GET（12 秒超时），内网地址也照发，自己贴的东西自己负责。
- API Key 明文落盘，权限依赖用户目录本身的 ACL。
