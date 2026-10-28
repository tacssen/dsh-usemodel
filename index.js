/**
 * dsh-usemodel — Host half.
 *
 * 把「自己的 OpenAI 兼容 API」接进 DSH：
 *   - 一条 provider 路由 `usemodel`，模型 id 形如 `<渠道id>::<模型名>`
 *   - 一个 settings 页读写的 JSON API（挂在 /api/usemodel）
 *   - 配置存 $DSH_HOME/usemodel/config.json，明文 API Key，仅本机可读
 *
 * 只依赖 `llm` 这一个服务；没有 webServer 的组合里模型照常可用，只是没有设置页。
 * adapter 契约取自 dsh-llm 的 StreamChunk：block-start → 若干 delta → block-end，
 * 最后 usage + finish。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'usemodel'
export const inject = ['llm']

/** provider 路由 id：模型选择器里显示的是 providerInfo 的 name。 */
const PROVIDER = 'usemodel'
const PROVIDER_LABEL = '自定义模型'
const SEP = '::'

// ── 配置存储 ────────────────────────────────────────────────────────────────

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

const DATA_DIR = path.join(dshHome(), 'usemodel')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

function newId() {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * 模型名默认美化：中转站爱把分组倍率塞进 id，像
 * `[按量6] deepseek-v4.1-flash-1017 [不补]`。方括号段对调用没用，只是给人看的标记，
 * 所以拿它当默认显示名，真实 id 另外单独留着。
 */
function prettyModelName(id) {
  const stripped = String(id).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim()
  return stripped !== '' ? stripped : String(id)
}

/**
 * 一行模型配置 → { id, name }。
 *
 * 支持三种写法（都按行）：
 *   `真实id`                     显示名自动从 id 里清理出来
 *   `真实id => 我起的名字`        显式指定
 *   `真实id | 我起的名字`         同上（半角/全角竖线都行）
 * 也接受已经是 { id, name } 的对象，方便手改 JSON。
 */
function parseModelEntry(raw) {
  if (raw !== null && typeof raw === 'object') {
    const id = String(raw.id ?? raw.model ?? '').trim()
    if (id === '') return null
    const name = String(raw.name ?? raw.displayName ?? raw.display ?? '').trim()
    return { id: id.slice(0, 200), name: (name !== '' ? name : prettyModelName(id)).slice(0, 200) }
  }
  const line = String(raw ?? '').trim()
  if (line === '') return null
  const split = line.match(/^(.+?)\s*(?:=>|＝>|→|｜|\|)\s*(.+)$/)
  if (split !== null) {
    const id = split[1].trim()
    const name = split[2].trim()
    if (id === '') return null
    return { id: id.slice(0, 200), name: (name !== '' ? name : prettyModelName(id)).slice(0, 200) }
  }
  return { id: line.slice(0, 200), name: prettyModelName(line).slice(0, 200) }
}

function normalizeChannel(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const rawModels = Array.isArray(raw.models)
    ? raw.models
    : String(raw.models ?? '').split(/\r?\n/).map(m => m.trim()).filter(m => m !== '')
  const seen = new Set()
  const models = []
  for (const entry of rawModels) {
    const parsed = parseModelEntry(entry)
    if (parsed === null) continue
    const dedupe = parsed.id + '\u0000' + parsed.name
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    models.push(parsed)
  }
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id.slice(0, 64) : newId(),
    name: String(raw.name ?? '').trim().slice(0, 80) || '未命名渠道',
    baseURL: String(raw.baseURL ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(raw.apiKey ?? '').trim(),
    models: models.slice(0, 200),
    maxTokens: Number(raw.maxTokens) > 0 ? Math.floor(Number(raw.maxTokens)) : 0,
    contextWindow: Number(raw.contextWindow) > 0 ? Math.floor(Number(raw.contextWindow)) : 0,
    retry: normalizeRetry(raw.retry),
    updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : Date.now(),
  }
}

/**
 * 自动重连参数：0 / 空 = 跟全局（或内置默认）走。
 * attempts 是总尝试次数，含第一次；1 表示不重连。
 */
function normalizeRetry(raw) {
  if (raw === null || typeof raw !== 'object') return { attempts: 0, initialDelayMs: 0, maxDelayMs: 0 }
  const pick = value => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return {
    attempts: Math.min(pick(raw.attempts ?? raw.maxAttempts), 12),
    initialDelayMs: Math.min(pick(raw.initialDelayMs), 60000),
    maxDelayMs: Math.min(pick(raw.maxDelayMs), 120000),
  }
}

function normalizeConfig(raw) {
  const channels = Array.isArray(raw?.channels) ? raw.channels : []
  return {
    channels: channels.map(normalizeChannel).filter(c => c !== null),
    defaultMaxTokens: Number(raw?.defaultMaxTokens) > 0 ? Math.floor(Number(raw.defaultMaxTokens)) : 65536,
    retry: normalizeRetry(raw?.retry),
  }
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch {
    return normalizeConfig(null)
  }
}

function writeConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  fs.renameSync(tmp, CONFIG_FILE)
}

// ── 上游报错翻译 ────────────────────────────────────────────────────────────
//
// 上游（尤其是中转站）出错时爱把原始 HTTP 报错体整段吐出来，用户看到的是
// `HTTP 403：{"error":{"message":"...","type":"...","code":"..."}}` 这种东西，
// 既看不懂也不知道下一步该改哪儿。这里统一翻成三件事：
//   message —— 一句话人话，说清是什么问题（可以带上上游自己的短说明）
//   hint    —— 该动哪儿（设置页 / 对话里都会显示）
//   detail  —— 原始报错体，只在「详情」里展开，永远不丢，方便排查
// code 用 DSH 自己那套失败码，重试策略按它判断能不能重试。

/** 从上游报错体里抠出它自己的错误码和错误消息；不是 JSON 就退化成纯文本。 */
function readUpstreamError(rawText) {
  const text = String(rawText ?? '').trim();
  if (text === '') return { code: '', message: '' };
  try {
    const json = JSON.parse(text);
    const error = json?.error ?? json;
    const code = String(error?.code ?? error?.type ?? json?.code ?? json?.type ?? '').trim();
    const message = String(error?.message ?? error?.msg ?? json?.message ?? json?.detail ?? '').trim();
    return { code: code.slice(0, 80), message: message.replace(/\s+/g, ' ').slice(0, 400) };
  } catch {
    // 网关错误页（Cloudflare 502 之类）是 HTML，去掉标签留文字
    const plain = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { code: '', message: plain.slice(0, 400) };
  }
}

/** HTTP 状态码 → 人话 + 该改什么 + DSH 失败码。 */
function describeHttpStatus(status) {
  switch (status) {
    case 400:
      return { message: '请求被上游判为不合法', hint: '先确认模型名是上游的真实 id（不是显示名），再看参数是否超出该模型支持范围', code: 'INVALID_REQUEST' };
    case 401:
      return { message: 'API Key 没被接受', hint: '检查 Key 有没有复制完整、是否已过期或被吊销；有的中转站要求 Key 不带 sk- 前缀', code: 'AUTH' };
    case 402:
      return { message: '账户余额不足', hint: '去上游控制台充值，或换一个有额度的 Key', code: 'QUOTA' };
    case 403:
      return { message: 'Key 被拒绝：没权限或被禁用', hint: '检查这个 Key 的分组/权限、IP 白名单、所在地区是否受限，或它已被上游停用', code: 'AUTH' };
    case 404:
      return { message: '这个地址下没有接口', hint: 'Base URL 要填到 /v1 这一层（插件自己拼 /chat/completions）；模型名也要在上游真实存在', code: 'INVALID_REQUEST' };
    case 405:
      return { message: '地址指到了网页，不是 API', hint: 'Base URL 大概填成了网站首页，改成 .../v1 这一层', code: 'INVALID_REQUEST' };
    case 408:
      return { message: '上游等太久，先超时了', hint: '稍后重试；长期这样换延迟更低的线路', code: 'TIMEOUT' };
    case 413:
      return { message: '这次请求太大（上下文或图片超限）', hint: '清一清会话历史，或换上下文窗口更大的模型', code: 'INVALID_REQUEST' };
    case 422:
      return { message: '参数不被接受', hint: '多半是模型名不对，或 temperature / max_tokens 超出该模型范围', code: 'INVALID_REQUEST' };
    case 429:
      return { message: '被限流，或额度已经用完', hint: '等几十秒再试；反复出现就去上游看套餐余量和并发限制', code: 'RATE_LIMIT' };
    case 451:
      return { message: '按地区被拒绝', hint: '这条线路对当前 IP 所在地区不开放，换线路或走代理', code: 'AUTH' };
    default:
      break;
  }
  if (status >= 500) {
    return { message: '上游服务自己出错了', hint: '重试一次；一直不好就是上游故障，换渠道或换个时间段', code: 'SERVER' };
  }
  return { message: `上游返回 HTTP ${status}`, hint: '看下面「详情」里上游自己的说法再改配置', code: 'HTTP_' + status };
}

/**
 * 一次上游失败 → 可直接展示的说明。
 * @param {number} status HTTP 状态码；0 表示请求没能发出去
 * @param {string} rawText 上游原始报错体
 * @param {string} statusText response.statusText
 */
function explainUpstreamFailure(status, rawText, statusText) {
  const code = Number(status) > 0 ? Math.floor(Number(status)) : 0;
  const base = code > 0
    ? describeHttpStatus(code)
    : {
      message: '连不上这个地址',
      hint: '检查 Base URL 拼写、网络和代理；必须是 https:// 开头的完整地址',
      code: 'TRANSPORT',
    };
  const upstream = readUpstreamError(rawText);
  // 上游自己说的话通常最准（哪个模型没权限、缺哪个参数），短的话就并进结论里
  let message = base.message;
  if (upstream.message !== '' && upstream.message.length <= 140) message += '（上游：' + upstream.message + '）';
  const detail = String(rawText ?? '').trim();
  return {
    message,
    hint: base.hint,
    code: base.code,
    providerCode: upstream.code,
    detail: detail !== '' ? detail.slice(0, 1200) : String(statusText ?? '').trim(),
  };
}

/** 对话里那一条失败信息：结论 + 该改什么，原始报文只进日志。 */
function failureTextOf(label, explained) {
  const head = label !== '' ? label + '：' : '';
  return explained.hint !== '' ? `${head}${explained.message}｜${explained.hint}` : head + explained.message;
}

// ── 消息投影：DSH 词汇 → OpenAI Chat Completions ──────────────────────────────

function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(part => part !== null && typeof part === 'object')
}

function textOf(blocks) {
  const out = []
  for (const block of blocks ?? []) {
    if ((block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text')
      && typeof block.text === 'string') out.push(block.text)
  }
  return out.join('\n')
}

// ── 图片附件 → data URL ─────────────────────────────────────────────────────
//
// 内核的 ImageBlock 只带 { attachmentId, mediaType, bytes, width, height, name }，
// **没有 url 字段**：attachmentId 形如 `sha256:<hex>`，字节落在
// $DSH_HOME/attachments/v1/objects/<hex 前两位>/<hex>。所以必须自己读盘，
// 读到的 data URL 按 attachmentId + mediaType 缓存在进程内。

const IMAGE_CACHE = new Map()

/** 附件对象在宿主文件系统上的路径；id 不合格时返回 undefined。 */
function attachmentObjectPath(attachmentId) {
  const raw = String(attachmentId ?? '')
  const hex = raw.startsWith('sha256:') ? raw.slice('sha256:'.length) : raw
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined
  return path.join(dshHome(), 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
}

function imageCacheKey(block) {
  return String(block?.attachment?.attachmentId ?? '') + '|' + String(block?.attachment?.mediaType ?? '')
}

/** 已解析的 data URL；未解析返回 undefined。 */
function imageUrlOf(block) {
  const direct = block?.attachment?.url
  if (typeof direct === 'string' && direct !== '') return direct
  return IMAGE_CACHE.get(imageCacheKey(block))
}

/** 把历史里所有图片附件读成 data URL 塞进缓存。 */
async function primeImageCache(messages) {
  const pending = new Map()
  const collect = blocks => {
    for (const block of blocks) {
      if (block?.type !== 'image') continue
      const key = imageCacheKey(block)
      if (key === '|' || IMAGE_CACHE.has(key) || pending.has(key)) continue
      pending.set(key, block)
    }
  }
  for (const message of messages ?? []) {
    collect(blocksOf(message.content))
    for (const result of toolResultsOf(message)) collect(result.content)
  }
  for (const [key, block] of pending) {
    const file = attachmentObjectPath(block.attachment?.attachmentId)
    if (file === undefined) continue
    const data = await fs.promises.readFile(file).catch(() => undefined)
    if (data === undefined) continue
    const mediaType = String(block.attachment?.mediaType ?? 'image/png')
    IMAGE_CACHE.set(key, 'data:' + mediaType + ';base64,' + data.toString('base64'))
  }
}

/** 一条消息携带的工具结果（V4 的 role:'tool' 与 V3 的 tool-result 包装块）。 */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = String(message.toolCallId ?? message.source?.callId ?? '')
    return id === '' ? [] : [{ callId: id, content: blocksOf(message.content) }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id !== '') out.push({ callId: id, content: blocksOf(block.content) })
  }
  return out
}

/**
 * 丢掉「有调用没结果」和「有结果没调用」的孤儿，否则上游对整轮 400。
 * 中断的回合在持久历史里正好长这样。
 */
function repairToolPairing(messages) {
  const answered = new Set()
  for (const message of messages) for (const r of toolResultsOf(message)) answered.add(r.callId)

  const keptCalls = new Set()
  const keep = []
  for (const message of messages) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      const live = results.filter(r => keptCalls.has(r.callId))
      if (message.role === 'tool') {
        if (live.length > 0) keep.push(message)
        continue
      }
      const blocks = blocksOf(message.content)
      const rest = blocks.filter(b => b?.type !== 'tool-result' || keptCalls.has(String(b.toolCallId ?? '')))
      if (rest.length === blocks.length) keep.push(message)
      else if (rest.length > 0) keep.push({ ...message, content: rest })
      continue
    }
    if (message?.role !== 'assistant') { keep.push(message); continue }
    const blocks = blocksOf(message.content)
    const calls = blocks.filter(b => b?.type === 'tool-call'
      && answered.has(String(b.id ?? '')) && String(b.name ?? '') !== '')
    for (const call of calls) keptCalls.add(String(call.id))
    const textBlocks = blocks.filter(b => b?.type !== 'tool-call')
    if (calls.length === blocks.filter(b => b?.type === 'tool-call').length) { keep.push(message); continue }
    if (calls.length === 0) {
      if (textBlocks.length > 0) keep.push({ ...message, content: textBlocks })
      continue
    }
    keep.push({ ...message, content: blocks.filter(b => b?.type !== 'tool-call' || calls.includes(b)) })
  }
  return keep
}

function toChatMessages(messages) {
  const out = []
  const followUp = []
  const flush = () => { if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) }) }

  for (const message of repairToolPairing(messages ?? [])) {
    const results = toolResultsOf(message)
    if (results.length === 0) flush()
    let blocks = blocksOf(message.content)

    if (results.length > 0) {
      for (const result of results) {
        const images = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageUrlOf(block)
          if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
        }
        const text = textOf(result.content)
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: text !== '' ? text : images.length > 0 ? '(见附图)' : '(无输出)',
        })
        if (images.length > 0) {
          followUp.push({ type: 'text', text: `工具调用 ${result.callId} 返回了 ${images.length} 张图片，见下。` }, ...images)
        }
      }
      blocks = blocks.filter(b => b?.type !== 'tool-result')
    }

    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text !== '') out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if ((block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') && block.text) {
            parts.push({ type: 'text', text: String(block.text) })
          } else if (block?.type === 'image') {
            const url = imageUrlOf(block)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else parts.push({ type: 'text', text: '[有一张图片附件没能读取，仅按文字处理]' })
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback !== '') out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          calls.push({
            id: String(block.id ?? '') || `call_${newId()}`,
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: typeof block.arguments === 'string' && block.arguments !== '' ? block.arguments : '{}',
            },
          })
        }
        if (text === '' && calls.length === 0) break
        const entry = { role: 'assistant', content: text !== '' ? text : null }
        if (typeof message.reasoning_content === 'string') entry.reasoning_content = message.reasoning_content
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      default:
        break
    }
  }
  flush()
  return out
}

function toToolDefs(tools) {
  const out = []
  for (const tool of tools ?? []) {
    const source = tool?.function !== null && typeof tool?.function === 'object' ? tool.function : tool
    const fnName = String(source?.name ?? '').trim()
    if (fnName === '') continue
    const parameters = source?.parameters !== null && typeof source?.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    out.push({
      type: 'function',
      function: {
        name: fnName.slice(0, 64),
        description: typeof source?.description === 'string' ? source.description : '',
        parameters,
      },
    })
  }
  return out
}

// ── usage 投影 ──────────────────────────────────────────────────────────────

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens)
  const completion = num(usage.completion_tokens ?? usage.output_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const cached = num(usage.prompt_tokens_details?.cached_tokens) ?? 0
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens)
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

function finishOf(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return { kind: 'tool-calls' }
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

// ── 自动重连 ────────────────────────────────────────────────────────────────
//
// 中转站抖一下、网关 502、连接被掐、上游吐个空流，都很常见。Codex 的做法是
// 「这一轮还没产出内容就安静重发」，用户看到的只是卡顿一下然后继续。这里同样：
//   · 只重连「还没有任何 chunk 交出去」的失败 —— 有内容再重发会出重复块
//   · 指数退避 + 抖动，别把抖动中的上游锤死
//   · 上游给了 Retry-After 就听它的，但不超过 maxDelayMs
//   · 默认总尝试 6 次（≈ Codex 的耐心程度），可在设置页/JSON 里改

/**
 * 这些失败码可以重发：上游 5xx、超时、连不上、空流、以及 429 限流
 * （429 优先按上游的 Retry-After 等）。鉴权、额度、参数错误重发也没用。
 */
const RETRYABLE_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'RATE_LIMIT'])

const RETRY_DEFAULTS = Object.freeze({
  attempts: 6,          // 总尝试次数（含第一次）
  initialDelayMs: 800,
  maxDelayMs: 20000,
  jitterRatio: 0.25,
})

/**
 * 重连参数：渠道自己填了就用渠道的，没填（0/缺失）退到全局，全局也没有就用内置默认。
 * 三个字段各自兜底，所以只改其中一个不会把另外两个清零。
 */
function resolveStreamRetry(config, channel) {
  const pick = (field, fallback, min, max) => {
    for (const source of [channel?.retry, config?.retry]) {
      const value = Math.floor(Number(source?.[field]))
      if (Number.isFinite(value) && value >= min) return Math.min(value, max)
    }
    return fallback
  }
  const resolved = {
    attempts: pick('attempts', RETRY_DEFAULTS.attempts, 1, 12),
    initialDelayMs: pick('initialDelayMs', RETRY_DEFAULTS.initialDelayMs, 1, 60000),
    maxDelayMs: pick('maxDelayMs', RETRY_DEFAULTS.maxDelayMs, 100, 120000),
  }
  if (resolved.initialDelayMs > resolved.maxDelayMs) resolved.initialDelayMs = resolved.maxDelayMs
  return resolved
}

/** 第 n 次失败后的等待时间：指数增长、封顶、带抖动；上游 Retry-After 优先。 */
function backoffDelay(retry, attempt, retryAfterMs) {
  const hinted = Number(retryAfterMs)
  const jitter = 1 - RETRY_DEFAULTS.jitterRatio + 2 * RETRY_DEFAULTS.jitterRatio * Math.random()
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(Math.round(hinted), retry.maxDelayMs)
  const exponent = Math.min(attempt - 1, 10)
  const exponential = Math.min(retry.initialDelayMs * 2 ** exponent, retry.maxDelayMs)
  return Math.min(Math.round(exponential * jitter), retry.maxDelayMs)
}

/** 上游的 Retry-After 可能是秒数也可能是 HTTP 日期。 */
function readRetryAfterMs(response) {
  let header
  try { header = response?.headers?.get?.('retry-after') } catch { return 0 }
  const raw = String(header ?? '').trim()
  if (raw === '') return 0
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return 0
  const delta = at - Date.now()
  return delta > 0 ? delta : 0
}

/** 失败信息带上 providerRetryAfterMs，内核那条重试链也能照着等。 */
function withRetryAfter(failure, retryAfterMs) {
  const value = Number(retryAfterMs)
  if (!Number.isFinite(value) || value <= 0) return failure
  return { ...failure, providerRetryAfterMs: Math.round(value) }
}

/** 可取消的等待；signal 中止就立刻返回 false，别把重连拖到用户点了停止之后。 */
function sleepUnlessAborted(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve(signal?.aborted !== true)
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(true) }, delayMs)
    function onAbort() { clearTimeout(timer); resolve(false) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 一次请求的 body；重连时要原样重发，所以单独抽出来只算一次。 */
function buildChatBody(options, channel, config, upstreamModel) {
  const body = {
    model: upstreamModel,
    stream: true,
    stream_options: { include_usage: true },
    messages: toChatMessages(options.messages),
  }
  const tools = toToolDefs(options.tools)
  if (tools.length > 0) body.tools = tools
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) body.temperature = options.temperature
  const maxTokens = Number(options.maxTokens) > 0
    ? Math.floor(options.maxTokens)
    : channel.maxTokens > 0 ? channel.maxTokens : config.defaultMaxTokens
  if (maxTokens > 0) body.max_tokens = maxTokens
  return body
}

// ── adapter ─────────────────────────────────────────────────────────────────

const FALLBACK_IMAGE_PRICING = Object.freeze({
  priceImages(images) {
    return images.map(image => image.offloaded === true
      ? { visualTokens: 0, text: '[图片已省略]' }
      : { visualTokens: 1024, text: '[图片]' })
  },
})

const MODEL_SEP = SEP

function splitModelId(model) {
  const raw = String(model ?? '')
  const at = raw.indexOf(MODEL_SEP)
  if (at < 0) return { channelId: '', model: raw }
  return { channelId: raw.slice(0, at), model: raw.slice(at + MODEL_SEP.length) }
}

class UseModelAdapter {
  constructor(getConfig, logger) {
    this.getConfig = getConfig
    this.logger = logger
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']),
      initialDelayMs: 700,
      maxDelayMs: 4000,
      jitterRatio: 0.2,
    })
  }

  imageRequestPricing() {
    return FALLBACK_IMAGE_PRICING
  }

  async listModels(provider) {
    const config = this.getConfig()
    const out = []
    for (const channel of config.channels) {
      for (const model of channel.models) {
        out.push({
          provider,
          // DSH 侧的 id 用真实模型名，改名不会把会话里的模型选择改丢
          id: channel.id + MODEL_SEP + model.id,
          name: channel.name + ' · ' + model.name,
          description: channel.baseURL,
          inputModalities: ['text', 'image'],
        })
      }
    }
    return out
  }

  async resolveModel(provider, model) {
    const config = this.getConfig()
    const { channelId, model: upstreamModel } = splitModelId(model)
    const channel = config.channels.find(c => c.id === channelId)
    const entry = channel?.models.find(candidate => candidate.id === upstreamModel)
    return {
      provider,
      id: String(model),
      name: entry !== undefined
        ? (channel.name + ' · ' + entry.name)
        : (channel !== undefined ? channel.name + ' · ' + upstreamModel : upstreamModel),
      inputModalities: ['text', 'image'],
      context: { contextWindow: channel?.contextWindow > 0 ? channel.contextWindow : 512000 },
      defaultMaxTokens: channel?.maxTokens > 0 ? channel.maxTokens : config.defaultMaxTokens,
    }
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options),
    }
  }

  /**
   * 一轮生成。上游只讲 OpenAI Chat Completions（/chat/completions, stream:true）。
   *
   * 失败自动重连：只要这一轮还没有任何 chunk 交给客户端，就退避重发同一个请求
   * （Codex 式，静默进行，用户看到的是「卡一下然后继续」）；一旦已经有内容出去
   * 就绝不重连 —— 重发只会让会话里出现两份重复的块。
   * @param {object} options GenerateOptions
   */
  async * stream(options) {
    const config = this.getConfig()
    const { channelId, model: upstreamModel } = splitModelId(options.model)
    const channel = config.channels.find(c => c.id === channelId)

    if (channel === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `找不到模型渠道：${options.model}`, code: 'CONFIG_INVALID' } } }
      return
    }
    if (channel.baseURL === '' || channel.apiKey === '') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `渠道「${channel.name}」还没填 Base URL 或 API Key`, code: 'CONFIG_INVALID' } } }
      return
    }

    await primeImageCache(options.messages)
    const body = buildChatBody(options, channel, config, upstreamModel)
    const retry = resolveStreamRetry(config, channel)

    let attempt = 0
    while (true) {
      attempt += 1
      const run = this.attemptStream(options, channel, body)
      let delivered = false
      let step = await run.next()
      while (step.done !== true) {
        delivered = true
        yield step.value
        step = await run.next()
      }
      const outcome = step.value
      if (outcome === null) return

      // 内容已经交出去了，或者这次失败不该重发，或者预算用完：如实收尾
      if (delivered || outcome.retryable !== true || attempt >= retry.attempts) {
        yield { type: 'finish', reason: { kind: 'error', failure: withRetryAfter(outcome.failure, outcome.retryAfterMs) } }
        return
      }

      const delayMs = backoffDelay(retry, attempt, outcome.retryAfterMs)
      this.logger?.warn?.(`usemodel: ${channel.name} 第 ${attempt} 次请求失败（${outcome.failure.code}），${delayMs}ms 后自动重连（第 ${attempt + 1}/${retry.attempts} 次尝试）`)
      if (!await sleepUnlessAborted(delayMs, options.signal)) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        return
      }
    }
  }

  /**
   * 发一次请求，把 SSE 读成 StreamChunk。
   *
   * generator 的返回值说明这次尝试怎么结束：
   *   null    —— 正常走完，finish 已经 yield 出去了
   *   outcome —— 失败；retryable 表示这次失败能不能重发（最终要不要重连由外层按
   *              「有没有内容出去」再判一次）
   * @returns {AsyncGenerator<object, null | { failure: object, retryable: boolean, retryAfterMs: number }, void>}
   */
  async * attemptStream(options, channel, body) {
    let response
    try {
      response = await fetch(channel.baseURL + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${channel.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      // 主动取消不算失败，重连也没有意义
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        return null
      }
      const raw = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`usemodel: ${channel.name} 请求发不出去：${raw}`)
      return {
        retryable: true,
        retryAfterMs: 0,
        failure: { message: failureTextOf(channel.name, explainUpstreamFailure(0, raw, '')), code: 'TRANSPORT' },
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const explained = explainUpstreamFailure(response.status, text, response.statusText)
      // 原始报文只进日志：对话里那句必须是能直接看懂的话
      this.logger?.warn?.(`usemodel: ${channel.name} HTTP ${response.status} ${explained.providerCode || ''} ${explained.detail}`)
      const failure = { message: failureTextOf(channel.name, explained), code: explained.code }
      if (!RETRYABLE_CODES.has(explained.code)) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return null
      }
      return { retryable: true, retryAfterMs: readRetryAfterMs(response), failure }
    }
    if (response.body === null) {
      return { retryable: true, retryAfterMs: 0, failure: { message: `${channel.name}：上游没有返回流`, code: 'EMPTY_RESPONSE' } }
    }

    // ── SSE → StreamChunk ──────────────────────────────────────────────────
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let nextIndex = 0
    let textBlock = null            // { index, text }
    let reasoningBlock = null       // { index, text }
    const toolBlocks = new Map()    // key → { index, id, name, args }
    let usageRaw = undefined
    let finishToken = ''
    let sawAny = false
    let lastToolKey = 'c0'

    const openText = () => {
      if (textBlock !== null) return textBlock
      textBlock = { index: nextIndex++, text: '' }
      emit({ type: 'block-start', index: textBlock.index, blockType: 'text' })
      return textBlock
    }
    const openReasoning = () => {
      if (reasoningBlock !== null) return reasoningBlock
      reasoningBlock = { index: nextIndex++, text: '' }
      emit({ type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' })
      return reasoningBlock
    }
    const pending = []
    function emit(chunk) { pending.push(chunk) }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut).replace(/\r$/, '')
          buffer = buffer.slice(cut + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '' || data === '[DONE]') continue

          let event
          try { event = JSON.parse(data) } catch { continue }
          if (event?.usage !== undefined && event.usage !== null) usageRaw = event.usage

          const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined
          if (choice === undefined) continue

          if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
            finishToken = choice.finish_reason
          }
          const delta = choice.delta ?? {}

          const reasonPart = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
            : typeof delta.reasoning === 'string' ? delta.reasoning : ''
          if (reasonPart !== '') {
            const block = openReasoning()
            block.text += reasonPart
            sawAny = true
            emit({ type: 'reasoning-delta', index: block.index, text: reasonPart })
          }

          if (typeof delta.content === 'string' && delta.content !== '') {
            const block = openText()
            block.text += delta.content
            sawAny = true
            emit({ type: 'text-delta', index: block.index, text: delta.content })
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              let key
              if (call?.index !== undefined && call?.index !== null) {
                key = 'c' + call.index
                lastToolKey = key
              } else if (typeof call?.id === 'string' && call.id !== '') {
                key = 'cid:' + call.id
                lastToolKey = key
              } else {
                key = lastToolKey
              }
              let block = toolBlocks.get(key)
              if (block === undefined) {
                block = { index: nextIndex++, id: '', name: '', args: '' }
                toolBlocks.set(key, block)
                emit({ type: 'block-start', index: block.index, blockType: 'tool-call' })
              }
              if (typeof call?.id === 'string' && call.id !== '') block.id = call.id
              const fn = call?.function ?? {}
              if (typeof fn.name === 'string' && fn.name !== '') block.name = fn.name
              if (typeof fn.arguments === 'string' && fn.arguments !== '') {
                block.args += fn.arguments
                sawAny = true
                emit({
                  type: 'tool-call-delta',
                  index: block.index,
                  id: block.id,
                  ...(block.name !== '' ? { name: block.name } : {}),
                  argumentsDelta: fn.arguments,
                })
              }
            }
          }
          // 把本帧生成的 chunk 立刻交出去，客户端才不会等整轮结束
          while (pending.length > 0) yield pending.shift()
        }
        while (pending.length > 0) yield pending.shift()
      }
    } catch (error) {
      while (pending.length > 0) yield pending.shift()
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
        return null
      }
      return {
        retryable: true,
        retryAfterMs: 0,
        failure: {
          message: `${channel.name}：流读取失败 ${error instanceof Error ? error.message : String(error)}`,
          code: 'TRANSPORT',
        },
      }
    } finally {
      try { reader.releaseLock() } catch { /* 已释放 */ }
    }

    while (pending.length > 0) yield pending.shift()

    // 上游什么都没给：按可重连处理，让外层再要一次
    if (!sawAny) {
      return { retryable: true, retryAfterMs: 0, failure: { message: `${channel.name}：上游返回了空响应`, code: 'EMPTY_RESPONSE' } }
    }

    // 收尾：按开块顺序关闭
    if (reasoningBlock !== null && reasoningBlock.text !== '') {
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
    }
    if (textBlock !== null && textBlock.text !== '') {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
    }
    for (const block of toolBlocks.values()) {
      let args = block.args === '' ? '{}' : block.args
      try { JSON.parse(args) } catch { args = '{}' }
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id !== '' ? block.id : `call_${newId()}`,
          name: block.name,
          arguments: args,
        },
      }
    }

    const usage = mapUsage(usageRaw)
    if (usage !== undefined) yield { type: 'usage', usage }

    yield { type: 'finish', reason: finishOf(finishToken) }
    return null
  }
}

// ── 粘贴识别 ────────────────────────────────────────────────────────────────
//
// 用户粘进来的东西五花八门：一句 Base URL、一个 sk- Key、两者混在一段文字里、
// 中转站给的分享链接、curl 命令、甚至 yaml 片段。这里统一抽成
// { baseURL, apiKey, name, models }，能探测就顺手把模型列表拉回来。

/** 这些后缀是「端点」不是「根」，粘进来要砍掉。 */
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|messages|responses|embeddings|models|predict)$/i

/** query 里可能藏着 key 的字段名。 */
const KEY_QUERY_KEYS = ['key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'auth', 'sk']

/** 明显不是对话模型的，探测后先摘掉（用户仍可手填）。 */
const NON_CHAT = /(embed(ding)?|rerank|tts|whisper|transcribe|speech|audio|dall-e|moderation|image-?gen|stable-?diffusion|flux|sd-?\d|midjourney)/i

function normalizeBaseURL(raw) {
  let text = String(raw ?? '').trim().replace(/^[<"'`\s]+|[>"'`\s]+$/g, '')
  if (text === '') return ''
  if (!/^https?:\/\//i.test(text)) {
    if (!/^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(text) && !/^localhost(?:[:/]|$)/i.test(text)) return ''
    text = 'https://' + text
  }
  let url
  try { url = new URL(text) } catch { return '' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''

  const carried = {}
  for (const field of KEY_QUERY_KEYS) {
    const value = url.searchParams.get(field)
    if (typeof value === 'string' && value.length >= 8) { carried.apiKey = value; break }
  }

  let pathname = url.pathname.replace(/\/+$/, '')
  pathname = pathname.replace(ENDPOINT_SUFFIX, '').replace(/\/+$/, '')
  // 有些站给的是 /v1/chat/completions 之外还带个 base 前缀，保持原样即可
  if (pathname === '') pathname = '/v1'

  url.pathname = pathname
  url.search = ''
  url.hash = ''
  const baseURL = url.toString().replace(/\/+$/, '')
  return { baseURL, apiKey: carried.apiKey }
}

function hostNameOf(baseURL) {
  try {
    const host = new URL(baseURL).hostname
    // IP / IPv6 推不出名字，交给上层兜底
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host === 'localhost') return ''
    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 2) return parts.slice(-2).join('.')
    return host
  } catch { return '' }
}

function pickName(text, baseURL) {
  const named = text.match(/(?:name|名称|备注|渠道名|显示名)\s*[:=：]\s*["']?([^\n"',，;；]{1,40})["']?/i)
  if (named !== null) {
    const value = named[1].trim()
    if (value !== '') return value
  }
  return hostNameOf(baseURL)
}

function extractFromText(text) {
  const raw = String(text ?? '').slice(0, 20000)
  const found = { baseURL: '', apiKey: '', name: '', urls: [] }

  // 1) 所有 URL，按「像不像 API 根」排序
  const urls = raw.match(/https?:\/\/[^\s"'`<>，,。；;）)】\]}]+/gi) ?? []
  const scored = []
  for (const candidate of urls) {
    const normalized = normalizeBaseURL(candidate)
    if (normalized === '' || typeof normalized !== 'object') continue
    let score = 0
    if (/\/v1$/i.test(normalized.baseURL) || /\/v\d/i.test(normalized.baseURL)) score += 4
    if (/\/api\//i.test(normalized.baseURL)) score += 2
    if (/\/\/(api|dash|one|new|llm|openai|gateway|proxy)\./i.test(normalized.baseURL)) score += 3
    if (normalized.apiKey !== undefined) score += 2
    scored.push({ ...normalized, score, raw: candidate })
  }
  scored.sort((a, b) => b.score - a.score)
  if (scored.length > 0) {
    found.baseURL = scored[0].baseURL
    if (scored[0].apiKey !== undefined) found.apiKey = scored[0].apiKey
  }
  found.urls = scored.map(item => item.raw)

  // 2) Key：显式 sk- 优先，其次 Bearer，其次 key: value
  if (found.apiKey === '') {
    const patterns = [
      /\b(sk-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})*)/,
      /\b(sk-proj-[A-Za-z0-9_-]{16,})/,
      /\bBearer\s+([A-Za-z0-9._-]{16,})\b/i,
      /(?:api[_-]?key|apikey|api-key|token|access[_-]?token|密钥|令牌)\s*[:=：]\s*["']?([A-Za-z0-9._-]{12,})["']?/i,
    ]
    for (const pattern of patterns) {
      const hit = raw.match(pattern)
      if (hit !== null && hit[1] !== undefined) {
        const value = hit[1].trim()
        if (value !== '' && value !== found.baseURL) { found.apiKey = value; break }
      }
    }
  }

  // 3) 名字
  found.name = pickName(raw, found.baseURL)
  return found
}

/** 远端返回的内容里也许藏着配置：JSON / yaml / toml / 纯文本都试一遍。 */
function extractFromRemoteBody(body, contentType) {
  const out = { baseURL: '', apiKey: '', name: '', models: [] }
  const text = String(body ?? '').slice(0, 200000)

  let json
  try { json = JSON.parse(text) } catch { json = undefined }

  if (json !== undefined && json !== null && typeof json === 'object') {
    const pick = (obj, keys) => {
      for (const key of keys) {
        const value = obj?.[key]
        if (typeof value === 'string' && value !== '') return value.trim()
      }
      return ''
    }
    const nested = json.data !== null && typeof json?.data === 'object' && !Array.isArray(json.data) ? json.data : json
    out.baseURL = pick(json, ['base_url', 'baseURL', 'baseUrl', 'api_base', 'apiBase', 'endpoint', 'url'])
      || pick(nested, ['base_url', 'baseURL', 'baseUrl', 'api_base', 'endpoint', 'url'])
    out.apiKey = pick(json, ['api_key', 'apiKey', 'apikey', 'key', 'token'])
      || pick(nested, ['api_key', 'apiKey', 'apikey', 'key', 'token'])
    out.name = pick(json, ['name', 'title', 'label']) || pick(nested, ['name', 'title'])

    const lists = [json.data, json.models, json.result, nested?.data, nested?.models, json.providers]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      const ids = list
        .map(item => typeof item === 'string' ? item : (item?.id ?? item?.model ?? item?.name ?? item?.slug))
        .filter(value => typeof value === 'string' && value !== '')
      if (ids.length > 0) { out.models = [...new Set(ids)]; break }
    }
    if (out.models.length === 0 && Array.isArray(json)) {
      out.models = json.map(item => typeof item === 'string' ? item : item?.id).filter(v => typeof v === 'string')
    }
    return out
  }

  // yaml / toml / key=value 纯文本
  const grab = (keys) => {
    for (const key of keys) {
      const hit = text.match(new RegExp('["\']?' + key + '["\']?\\s*[:=]\\s*["\']?([^\\s"\',}]+)', 'i'))
      if (hit !== null && hit[1] !== undefined && hit[1] !== '') return hit[1].trim()
    }
    return ''
  }
  out.baseURL = grab(['base_url', 'baseURL', 'baseUrl', 'api_base', 'apiBase', 'endpoint', 'openai_base'])
  out.apiKey = grab(['api_key', 'apiKey', 'apikey', 'key', 'token', 'auth_token'])
  out.name = grab(['name', 'title', 'label'])
  if (contentType.includes('json') && out.baseURL === '' && out.apiKey === '') return out
  return out
}

async function probeModels(baseURL, apiKey, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(baseURL + '/models', {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const explained = explainUpstreamFailure(response.status, text, response.statusText)
      return {
        ok: false,
        status: response.status,
        error: explained.message,
        hint: explained.hint,
        detail: explained.detail,
        code: explained.code,
      }
    }
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch {
      return {
        ok: false,
        status: response.status,
        error: '上游返回的不是 JSON（这个地址多半不是 API）',
        hint: 'Base URL 要填到 /v1 这一层；网页地址拿不到模型列表，模型名可以手填',
        detail: text.slice(0, 1200),
        code: 'INVALID_REQUEST',
      }
    }
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : []
    const ids = list
      .map(item => typeof item === 'string' ? item : (item?.id ?? item?.model ?? item?.name))
      .filter(value => typeof value === 'string' && value !== '')
    const chat = ids.filter(id => !NON_CHAT.test(id))
    return { ok: true, status: response.status, models: chat.length > 0 ? chat : ids, total: ids.length }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      return {
        ok: false,
        status: 0,
        error: '探测超时（12 秒没响应）',
        hint: '检查网络或代理；也可以跳过探测，模型名手填',
        detail: 'probe timeout 12000ms',
        code: 'TIMEOUT',
      }
    }
    return {
      ok: false,
      status: 0,
      error: '连不上这个地址（上游：' + raw.slice(0, 140) + '）',
      hint: '检查 Base URL 拼写、网络和代理；必须是 https:// 开头的完整地址',
      detail: raw,
      code: 'TRANSPORT',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 主入口：把一段粘贴内容变成一条渠道配置。
 * 顺序是「先本地抽，抽不到配置就把它当分享链接抓一次，最后拿 key 探模型」。
 */
async function detectFromInput(text) {
  const notes = []
  const local = extractFromText(text)
  let baseURL = local.baseURL
  let apiKey = local.apiKey
  let name = local.name
  let models = []

  // 当成分享链接抓一次：本地没抽出完整「地址 + Key」，或者那个地址不像 API 根
  const looksLikeRoot = /\/v\d/i.test(baseURL) || /\/api\//i.test(baseURL)
  const shouldFetch = local.urls.length > 0 && (apiKey === '' || !looksLikeRoot)
  if (shouldFetch) {
    const candidates = local.urls.slice(0, 3)
    for (const candidate of candidates) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      try {
        const response = await fetch(candidate, {
          headers: { accept: '*/*', 'user-agent': 'dsh-usemodel/0.1' },
          redirect: 'follow',
          signal: controller.signal,
        })
        if (!response.ok) { notes.push(`抓 ${new URL(candidate).hostname} 返回 HTTP ${response.status}`); continue }
        const body = await response.text()
        if (body.length > 400000) { notes.push('分享链接内容过大，已跳过'); continue }
        const remote = extractFromRemoteBody(body, response.headers.get('content-type') ?? '')
        // 远端明确给了地址就以它为准：用户贴的本来就是分享链接，不是 API 根
        if (remote.baseURL !== '') {
          const normalized = normalizeBaseURL(remote.baseURL)
          if (normalized !== '' && typeof normalized === 'object') {
            baseURL = normalized.baseURL
            if (apiKey === '' && normalized.apiKey !== undefined) apiKey = normalized.apiKey
            notes.push('已按分享链接里的地址覆盖')
          }
        }
        if (remote.apiKey !== '' && apiKey === '') apiKey = remote.apiKey
        if (remote.name !== '') name = remote.name
        if (remote.models.length > 0 && models.length === 0) {
          models = remote.models.filter(id => !NON_CHAT.test(id)).map(id => ({ id, name: prettyModelName(id) }))
          notes.push(`分享链接里带回了 ${remote.models.length} 个模型`)
        }
      } catch (error) {
        notes.push(`抓取失败：${controller.signal.aborted ? '超时' : (error instanceof Error ? error.message : String(error))}`)
      } finally {
        clearTimeout(timer)
      }
      if (baseURL !== '' && apiKey !== '') break
    }
  }

  // 补齐：只给了 key 没给地址 → 默认 OpenAI
  if (baseURL === '' && apiKey !== '') {
    baseURL = 'https://api.openai.com/v1'
    notes.push('只认出 Key，地址先按 OpenAI 官方填，可自行改')
  }

  // 有 key 有地址：探一次 /models
  if (baseURL !== '' && apiKey !== '' && models.length === 0) {
    const probe = await probeModels(baseURL, apiKey)
    if (probe.ok === true) {
      models = probe.models.map(id => ({ id, name: prettyModelName(id) }))
      notes.push(probe.models.length > 0 ? `探测到 ${probe.models.length} 个对话模型` : '上游没返回可用的模型名')
    } else {
      notes.push(`模型探测失败（HTTP ${probe.status || '-'}：${probe.error}），模型名请手填`)
    }
  }

  if (baseURL === '') {
    return { ok: false, error: '没认出 API 地址。可以粘贴 Base URL（例如 https://api.openai.com/v1）、分享链接，或把 Key 和地址一起贴进来。', notes }
  }

  name = name !== '' && name !== '自定义渠道' ? name : (hostNameOf(baseURL) || '自定义渠道')

  return {
    ok: true,
    channel: {
      id: '',
      name,
      baseURL,
      apiKey,
      models: models.slice(0, 200),
      contextWindow: 0,
      maxTokens: 0,
    },
    notes,
  }
}

// ── HTTP API ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 1_000_000) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (error) { reject(new Error('JSON 解析失败: ' + error.message)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 只允许本机来源，防别的页面打到这条 API 上读到 Key。 */
function isLoopback(req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.replace(/:\d+$/, '')
  if (hostname !== '' && hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const url = new URL(origin)
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') return false
    } catch { return false }
  }
  return true
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  let config = readConfig()

  /** 每次都从盘上取，手改 JSON 也能立刻生效；文件只有几 KB。 */
  const getConfig = () => {
    config = readConfig()
    return config
  }

  const adapter = new UseModelAdapter(getConfig, logger)

  // 注册 provider 路由。DSH 会用 listModels 把它挂进模型选择器。
  let registration
  try {
    registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  } catch (error) {
    logger.warn?.(`usemodel: registerAdapter 失败 ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    ctx.llm.registerConfigurableProviders?.([
      { provider: PROVIDER, displayName: PROVIDER_LABEL, settingsNs: name, settingsPath: [] },
    ])
  } catch { /* 老内核没有这个方法 */ }
  try {
    ctx.llm.registerModelDiscovery?.(name, async () => {
      const rows = await adapter.listModels(PROVIDER)
      return rows.map(row => ({ id: row.id, name: row.name, inputModalities: row.inputModalities }))
    })
  } catch { /* 可选 */ }

  /** 模型 id 列表变了要通知内核重新取一次，否则选择器里还是旧的。 */
  function refreshRegistry() {
    try {
      if (registration !== undefined && typeof registration.replace === 'function') registration.replace([PROVIDER])
    } catch { /* 忽略 */ }
  }

  async function handle(req, res) {
    if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
    config = readConfig()
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.replace(/^\/api\/usemodel/, '') || '/state'

    try {
      if (req.method === 'GET' && (route === '/state' || route === '/')) {
        sendJson(res, 200, { ok: true, config, provider: PROVIDER, label: PROVIDER_LABEL })
        return
      }

      if (req.method === 'POST' && route === '/save') {
        const body = await readBody(req)
        const incoming = normalizeChannel(body?.channel)
        if (incoming === null) { sendJson(res, 400, { ok: false, error: '缺少 channel' }); return }
        if (incoming.baseURL === '') { sendJson(res, 400, { ok: false, error: 'Base URL 必填，例如 https://api.openai.com/v1' }); return }
        if (incoming.models.length === 0) { sendJson(res, 400, { ok: false, error: '至少填一个模型名' }); return }
        incoming.updatedAt = Date.now()
        const at = config.channels.findIndex(c => c.id === incoming.id)
        if (at >= 0) config.channels[at] = incoming
        else config.channels.push(incoming)
        if (Number(body?.defaultMaxTokens) > 0) config.defaultMaxTokens = Math.floor(Number(body.defaultMaxTokens))
        writeConfig(config)
        refreshRegistry()
        logger.info?.(`usemodel: 已保存渠道 ${incoming.name}（${incoming.models.length} 个模型）`)
        sendJson(res, 200, { ok: true, config })
        return
      }

      if (req.method === 'POST' && route === '/delete') {
        const body = await readBody(req)
        const id = String(body?.id ?? '')
        config.channels = config.channels.filter(c => c.id !== id)
        writeConfig(config)
        refreshRegistry()
        sendJson(res, 200, { ok: true, config })
        return
      }

      if (req.method === 'POST' && (route === '/detect' || route === '/parse')) {
        const body = await readBody(req)
        const text = String(body?.text ?? '')
        if (text.trim() === '') { sendJson(res, 400, { ok: false, error: '先粘贴一段内容' }); return }
        const result = await detectFromInput(text)
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && route === '/models') {
        const body = await readBody(req)
        const normalized = normalizeBaseURL(body?.baseURL)
        const baseURL = normalized !== '' && typeof normalized === 'object' ? normalized.baseURL : ''
        let apiKey = String(body?.apiKey ?? '').trim()
        if (apiKey === '' && normalized !== '' && typeof normalized === 'object' && normalized.apiKey !== undefined) apiKey = normalized.apiKey
        if (baseURL === '') { sendJson(res, 400, { ok: false, error: 'Base URL 不像有效地址' }); return }
        if (apiKey === '') { sendJson(res, 400, { ok: false, error: '先填 API Key，探测要鉴权' }); return }
        const probe = await probeModels(baseURL, apiKey)
        sendJson(res, 200, {
          ok: probe.ok === true,
          baseURL,
          models: probe.models ?? [],
          total: probe.total ?? 0,
          status: probe.status ?? 0,
          error: probe.error ?? '',
          hint: probe.hint ?? '',
          detail: probe.detail ?? '',
          code: probe.code ?? '',
        })
        return
      }

      if (req.method === 'POST' && route === '/test') {
        const body = await readBody(req)
        const channel = normalizeChannel(body?.channel)
        if (channel === null || channel.baseURL === '' || channel.apiKey === '') {
          sendJson(res, 400, { ok: false, error: 'Base URL 和 API Key 都要填' })
          return
        }
        const model = String(body?.model ?? channel.models[0]?.id ?? '')
        if (model === '') { sendJson(res, 400, { ok: false, error: '先填一个模型名再测' }); return }
        const started = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20000)
        try {
          const response = await fetch(channel.baseURL + '/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${channel.apiKey}`,
            },
            body: JSON.stringify({
              model,
              stream: false,
              max_tokens: 8,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: controller.signal,
          })
          const text = await response.text().catch(() => '')
          const ms = Date.now() - started
          if (!response.ok) {
            const explained = explainUpstreamFailure(response.status, text, response.statusText)
            logger.warn?.(`usemodel: 测连通 ${channel.name} HTTP ${response.status} ${explained.providerCode || ''} ${explained.detail}`)
            sendJson(res, 200, {
              ok: false,
              status: response.status,
              ms,
              error: explained.message,
              hint: explained.hint,
              detail: explained.detail,
              code: explained.code,
            })
            return
          }
          let preview = ''
          try {
            const parsed = JSON.parse(text)
            preview = String(parsed?.choices?.[0]?.message?.content ?? '').slice(0, 200)
          } catch { preview = text.slice(0, 200) }
          sendJson(res, 200, { ok: true, status: response.status, ms, preview })
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error)
          const aborted = controller.signal.aborted
          sendJson(res, 200, {
            ok: false,
            status: 0,
            ms: Date.now() - started,
            error: aborted ? '测试超时（20 秒没响应）' : '连不上这个地址（上游：' + raw.slice(0, 140) + '）',
            hint: aborted
              ? '上游太慢或连不通；检查地址、网络和代理后再试'
              : '检查 Base URL 拼写、网络和代理；必须是 https:// 开头的完整地址',
            detail: aborted ? 'test timeout 20000ms' : raw,
            code: aborted ? 'TIMEOUT' : 'TRANSPORT',
          })
        } finally {
          clearTimeout(timer)
        }
        return
      }

      sendJson(res, 404, { ok: false, error: '未知路由 ' + route })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/usemodel', handler: handle }),
      'usemodel: settings api',
    )
    logger.info?.('usemodel: 设置接口挂载于 /api/usemodel')
  })

  // 配置随时可能被外部改动（手改 JSON），每次请求都读一遍最新值
  ctx.effect(() => {
    config = readConfig()
    return () => {}
  })
}
