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

### 报错怎么读

上游（尤其是中转站）的原始报错不再糊到界面上，插件把它翻成「什么问题 + 该改哪儿」，
上游自己的原话和完整报文收在**详情**里，点一下展开：

| 你看到的分支 | HTTP | 真实情况 / 该改哪 |
|---|---|---|
| API Key 没被接受 | 401 | Key 没复制全、已过期或被吊销；有的站要求 Key 不带 `sk-` 前缀 |
| Key 被拒绝：没权限或被禁用 | 403 | 分组/权限、IP 白名单、地区限制，或 Key 已被停用 |
| 账户余额不足 | 402 | 去上游控制台充值，或换一个有额度的 Key |
| 这个地址下没有接口 | 404 | Base URL 要填到 `/v1` 这一层；模型名也要在上游真实存在 |
| 地址指到了网页，不是 API | 405 | Base URL 填成了网站首页 |
| 被限流，或额度已经用完 | 429 | 等几十秒再试；反复出现就看套餐余量和并发限制 |
| 上游服务自己出错了 | 5xx | 插件自动退避重连（见下节），全试完还不行就是上游故障 |
| 连不上这个地址 | 0 | 查 Base URL 拼写、网络、代理 |
| 探测超时 / 测试超时 | 0 | 12s / 20s 没响应；换线路，或手填模型名跳过探测 |

`This token has no access to model X` 属于 403 那一档：密钥没坏，是模型名不精确。
new-api 系中转站遇到找不到的模型名回的是 403 不是 401，照着 `/models` 返回的 id
一字不差抄进去就好。

### 失败自动重连

中转站抖一下、网关 502、连接被掐、上游吐个空流，都是常态。插件按 Codex 的做法**安静重发**，
用户看到的只是「卡一下然后继续」，不用手点继续：

- 只在**这一轮还没吐出任何内容**时重连。已经流到你眼前的内容不会再重发一次，
  否则会话里会出现两份重复的块。
- 指数退避 + 抖动，默认 800ms 起、封顶 20s，总共尝试 6 次（含第一次）。
- 上游给了 `Retry-After` 就听它的（秒数或 HTTP 日期都认），但不超过最长等待。
- 会重连的失败：5xx、超时、连不上、空流、429 限流。
  不会重连的失败：401/403/404/402 这类重发也没用的错误。
- 等待期间点停止会立刻中断，不再发下一次请求。

每个渠道可以单独调，留空就跟全局默认走：

| 字段 | 默认 | 含义 |
|---|---|---|
| `retry.attempts` | 6 | 总尝试次数（含第一次），1 = 不重连，最大 12 |
| `retry.initialDelayMs` | 800 | 第一次重连前等多久 |
| `retry.maxDelayMs` | 20000 | 单次等待上限，也是 `Retry-After` 的上限 |

设置页里在「上下文窗口 / 单次最大输出」下面就能改；也可以直接改 `config.json`：
渠道级写在某条 `channels[]` 里，全局级写在顶层 `retry` 对象里（渠道级优先）。

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

## 缓存命中率（中转站实测）

`prompt_tokens_details.cached_tokens` 反映的是**中转站后端**的前缀缓存，插件只能透传，改不了。
本机对 `ckffai.com` 的实测结论：

| 现象 | 实测 |
|---|---|
| 完全相同的请求连发 10 次 | 只有 2 次命中（99.6%），8 次 0% |
| 并发 8 个相同请求 | 只有 2 个命中，命中率 ≈ 25% |
| 静态长历史、零变更、间隔 30 s 连发 6 次 | 前 4 次只命中固定的 24k 头部，第 5 次才到 99.8% |
| 加 `cache_control: ephemeral` 或 `prompt_cache_key` | 无提升 |
| 非流式请求 | `cached_tokens` 恒为 0，只有流式才上报 |

两个成因：

1. **多实例负载均衡，KV 缓存不共享**。同一份前缀要恰好再落到当初写缓存的那台机器上才命中，
   所以命中率约等于 1/实例数。
2. **缓存写入是懒的**。命中固定停在 `system + tools` 那 ≈24k 的位置，说明只有"第二次见到"
   的前缀才会落盘；历史一旦每步增长，新尾部永远是首次出现。

另外自动压缩会重置前缀，实测压缩后紧邻的轮次平均命中 54.7%，其余轮次 78.2%。

能做的只有把自己的前缀压小、压稳：`contextWindow` 别开太大（压缩越晚、单请求越长）、
工具表别动、`AGENTS.md` 别塞长文。剩下的取决于中转站是否给会话粘性路由，客户端无法干预。

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
      "contextWindow": 1000000,
      "maxTokens": 65536,
      "retry": { "attempts": 6, "initialDelayMs": 800, "maxDelayMs": 20000 }
    }
  ],
  "defaultMaxTokens": 65536,
  "retry": { "attempts": 6, "initialDelayMs": 800, "maxDelayMs": 20000 }
}
```

两个 token 字段都可空，留 0 就用插件默认值：

| 字段 | 缺省 | 作用 |
|---|---|---|
| `contextWindow` | `1000000` | 上报给内核的上下文容量，决定自动压缩阈值（`floor(contextWindow × 0.8)`）和界面占用条 |
| `maxTokens` / `defaultMaxTokens` | `65536` | 单次响应的 `max_tokens`，同时是压缩时预留的完成额度 |

约束：`maxTokens` 要明显小于 `contextWindow`，且
`floor(contextWindow × 0.8) > maxTokens + headroomTokens(65536)`，否则压缩器会拒绝启动并报
`leaving no pressure budget`。默认 `1000000 / 65536` 满足：阈值 800000，预留 65536，余量充裕。

`contextWindow` 是**本地声明**，只影响 DSH 的压缩节奏，不会让上游真的多收 token；
填超过上游真实上限的值，超长请求会被上游直接拒绝。`max_tokens` 同理：填大只是给模型更大空间，
模型该停还是停，不会硬凑。

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

七套测试全部用 mock 内核跑，不联网、不碰真实配置（每个脚本把 `DSH_HOME` 指到临时目录）：

| 文件 | 覆盖 |
|---|---|
| `test/selftest.mjs` | `apply()` 的注册调用、adapter 方法形状、HTTP API 增删改查、baseURL 规范化 |
| `test/sse.mjs` | 假 OpenAI 上游发 SSE，断言完整 chunk 序列：reasoning/text 聚合、两个并行工具调用的 id/name/参数拼接、usage 扣缓存、`finish.kind = tool-calls`、DSH 消息 → OpenAI 消息的角色投影 |
| `test/detect.mjs` | 10 种粘贴格式 + 假中转站分享链接 + 垃圾文本拒绝 |
| `test/alias.mjs` | `id => 名字`、`id \| 名字`、对象形式、方括号自动清理、listModels/resolveModel 的名称与 id 分离 |
| `test/errors.mjs` | 上游报错翻译：401/403/404/429/5xx、HTML 错误页、连不上、真实 socket 403；断言结论是人话、hint 存在、原始报文留在 detail、失败码能驱动重试 |
| `test/client-error.mjs` | 设置页失败展示：假 react 跑 `client.js`，断言结论/提示/折叠详情的渲染树、缺字段时不渲染空块 |
| `test/retry.mjs` | 失败自动重连：502/503 连击后成功、传输失败、空流、吐过内容后断流不重连、401 不重连、`Retry-After` 被尊重、`attempts=1` 关闭、等待中取消 |

## 已知限制

- 只支持 OpenAI Chat Completions 一种线格式（`/chat/completions`），不支持 Anthropic Messages 或 Responses API。
- 某些站不实现 `GET /models`，那就拉不到列表，模型名手填（其余功能不受影响）。
- 粘贴识别会对你贴进来的 URL 发一次 GET（12 秒超时），内网地址也照发，自己贴的东西自己负责。
- API Key 明文落盘，权限依赖用户目录本身的 ACL。
