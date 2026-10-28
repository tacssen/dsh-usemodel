// 回归：真实附件 → 上游 body 必须带 image_url（DSH 的 ImageBlock 没有 url 字段）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const mod = await import('../index.js')

const HEX = 'ca3bdde257bad1508bbde68daf7c91cb9446af37e78d07479e74dd2e29482fdd'
const file = path.join(os.homedir(), '.dsh', 'attachments', 'v1', 'objects', HEX.slice(0, 2), HEX)
if (!fs.existsSync(file)) throw new Error('缺少真实附件: ' + file)

const imageBlock = {
  type: 'image',
  attachment: {
    attachmentId: 'sha256:' + HEX,
    mediaType: 'image/png',
    bytes: 156128, width: 1280, height: 1026, name: 'image.png',
  },
}

let registered
const ctx = {
  logger: { warn() {}, info() {} },
  llm: {
    registerAdapter(_p, adapter) { registered = adapter; return { replace() {} } },
    registerConfigurableProviders() {},
    registerModelDiscovery() {},
  },
  get() { return undefined },
  inject(_names, fn) { /* 测试里不需要 webServer */ },
  effect(fn) { /* 生命周期钩子，测试里不需要 */ },
}
mod.apply(ctx)
if (!registered) throw new Error('adapter 未注册')

let captured = null
globalThis.fetch = async (url, init) => {
  captured = JSON.parse(init.body)
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const messages = [{
  role: 'user',
  content: [imageBlock, { type: 'text', text: '帮我解决这个' }],
}]

const stream = registered.stream ? registered.stream : null
const model = await registered.resolveModel('usemodel', '144zu565::gpt-6.1-sol')
for await (const _ of registered[Object.keys(registered).length ? 'stream' : 'stream'] === undefined ? [] : []) break

// 直接走 prepareCall 拿 stream
const prepared = await registered.prepareCall('usemodel', '144zu565::gpt-6.1-sol')
for await (const _chunk of prepared.stream({ model: '144zu565::gpt-6.1-sol', messages, tools: [], maxTokens: 128 })) {}

const content = captured.messages[0].content
const img = content.find(part => part.type === 'image_url')
if (!img) {
  console.log('FAIL 上游 body 里没有 image_url，实际:', JSON.stringify(content).slice(0, 400))
  process.exit(1)
}
const url = img.image_url.url
if (!url.startsWith('data:image/png;base64,')) { console.log('FAIL 不是 data URL:', url.slice(0, 60)); process.exit(1) }
const b64 = url.slice('data:image/png;base64,'.length)
const decoded = Buffer.from(b64, 'base64')
const orig = fs.readFileSync(file)
if (!decoded.equals(orig)) { console.log('FAIL 字节不一致'); process.exit(1) }
console.log('PASS image_url 已进入上游 body，字节与附件对象完全一致（' + decoded.length + ' bytes）')
console.log('PASS model =', captured.model, '| parts =', content.map(p => p.type).join(','))
