// 自动重连自检（Codex 式）：失败就退避重发，但有内容出去就不再重发。
//
//   node test/retry.mjs
//
// 全程不联网：globalThis.fetch 按剧本返回假响应 / 抛错 / 半途断流。
import osx from 'node:os';
import pathx from 'node:path';
import fsx from 'node:fs';

const TEST_HOME = pathx.join(osx.tmpdir(), 'usemodel-retry-' + process.pid + '-' + Date.now());
fsx.mkdirSync(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;

const log = (...args) => console.log('[retry]', ...args);
const mod = await import(new URL('../index.js', import.meta.url).href);

const captured = { routes: [], adapters: [] };
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  llm: {
    registerAdapter(routes, adapter) { captured.adapters.push({ routes, adapter }); return { replace() {} }; },
    registerConfigurableProviders() {},
    registerModelDiscovery() {},
  },
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  inject(deps, cb) {
    if (!deps.includes('webServer')) return;
    cb({
      webServer: { register(spec) { captured.routes.push(spec); return () => {}; } },
      effect(fn) { fn(); },
    });
  },
};
mod.apply(ctx);
const handler = captured.routes[0].handler;
const adapter = captured.adapters[0].adapter;

const realFetch = globalThis.fetch;
let failures = 0;
function check(name, condition, extra) {
  if (condition) { log('✅ ' + name); return; }
  failures += 1;
  console.error('[retry] ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
}

// ── 假上游素材 ──────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\n\n';
const DONE = 'data: [DONE]\n\n';
const TEXT_FRAMES = [
  frame({ choices: [{ index: 0, delta: { content: '你好，' } }] }),
  frame({ choices: [{ index: 0, delta: { content: '世界。' } }] }),
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
];

function sseResponse(frames, { status = 200, headers = {} } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const text of frames) controller.enqueue(enc.encode(text));
      controller.enqueue(enc.encode(DONE));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** 吐出前 n 帧后把连接掐断，模拟中途掉线（拉取式，保证前 n 帧先被读到）。 */
function brokenResponse(frames, n) {
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent < n) {
        controller.enqueue(enc.encode(frames[sent]));
        sent += 1;
        return;
      }
      controller.error(new Error('socket hang up'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 按顺序消费剧本；用光了就重复最后一项。 */
function scriptFetch(steps) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step(url, init) : step;
  };
  return calls;
}

async function collect(options, signal) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
    ...(signal === undefined ? {} : { signal }),
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks) {
  return chunks
    .filter(c => c.type === 'block-end' && c.block?.type === 'text')
    .map(c => c.block.text)
    .join('');
}

await callApi('POST', '/save', {
  channel: {
    id: 'rch',
    name: '重连渠道',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test-abcdefgh',
    models: ['model-a'],
    retry: { attempts: 5, initialDelayMs: 5, maxDelayMs: 20 },
  },
});

// ── 1) 502 两次后成功：内容只出现一次 ───────────────────────────────────────
let calls = scriptFetch([
  jsonResponse(502, { error: { message: 'bad gateway' } }),
  jsonResponse(503, { error: { message: 'still booting' } }),
  sseResponse(TEXT_FRAMES),
]);
let chunks = await collect({ model: 'rch::model-a' });
log('1) 请求次数 ' + calls.length + '，文本 ' + JSON.stringify(textOf(chunks)));
check('502/503 之后自动重连并拿到内容', textOf(chunks) === '你好，世界。', textOf(chunks));
check('重连了两次（共 3 次请求）', calls.length === 3, calls.length);
check('只有一条 finish', chunks.filter(c => c.type === 'finish').length === 1, chunks.length);
check('finish 是正常结束', chunks.at(-1)?.reason?.kind === 'stop', chunks.at(-1));

// ── 2) 连接直接抛错（DNS/代理挂了）也重连 ───────────────────────────────────
calls = scriptFetch([
  () => { throw new TypeError('fetch failed') },
  sseResponse(TEXT_FRAMES),
]);
chunks = await collect({ model: 'rch::model-a' });
check('传输失败后重连成功', textOf(chunks) === '你好，世界。', textOf(chunks));
check('传输失败重连共 2 次请求', calls.length === 2, calls.length);

// ── 3) 空流（上游 200 但什么都不给）→ 重连 ──────────────────────────────────
calls = scriptFetch([
  sseResponse([]),
  sseResponse(TEXT_FRAMES),
]);
chunks = await collect({ model: 'rch::model-a' });
check('空响应会重连', textOf(chunks) === '你好，世界。', textOf(chunks));
check('空响应重连共 2 次请求', calls.length === 2, calls.length);

// ── 4) 已经吐出内容再掉线：不重连，如实报错，不留重复块 ─────────────────────
calls = scriptFetch([
  () => brokenResponse(TEXT_FRAMES, 2),
  sseResponse(TEXT_FRAMES),
]);
chunks = await collect({ model: 'rch::model-a' });
const finish = chunks.at(-1);
log('4) 请求次数 ' + calls.length + '，finish ' + JSON.stringify(finish?.reason));
check('吐过内容后不再重连', calls.length === 1, calls.length);
check('吐过内容后以错误收尾', finish?.reason?.kind === 'error', finish?.reason);
check('流中断的失败码是 TRANSPORT', finish?.reason?.failure?.code === 'TRANSPORT', finish?.reason?.failure?.code);
// 流被打断时不会有 block-end（内核用 interruptedBlocks 收尾），看 delta 才是交付了什么
const deltas = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
// 剧本第 3 帧才是 finish_reason，所以断在第 2 帧时两句都已经交出去了
check('已交付的 delta 没有重复（只出现一次全文）', deltas === '你好，世界。', JSON.stringify(deltas));

// ── 5) 401 不重连：重发也没用，别把 Key 错误拖成 6 次 ───────────────────────
calls = scriptFetch([jsonResponse(401, { error: { message: 'bad key' } })]);
chunks = await collect({ model: 'rch::model-a' });
check('401 只请求一次', calls.length === 1, calls.length);
check('401 失败码是 AUTH', chunks.at(-1)?.reason?.failure?.code === 'AUTH', chunks.at(-1)?.reason?.failure?.code);

// ── 6) Retry-After 被尊重 ──────────────────────────────────────────────────
calls = scriptFetch([
  // 用一个不会被夹短的通道，确保真的按 Retry-After 等满 1 秒
  jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }),
  sseResponse(TEXT_FRAMES),
]);
const startedAt = Date.now();
chunks = await collect({ model: 'rch::model-a' });
const waited = Date.now() - startedAt;
log('6) Retry-After=1s，实际等待 ' + waited + 'ms');
check('Retry-After 之后成功', textOf(chunks) === '你好，世界。', textOf(chunks));
check('确实等满了 Retry-After', waited >= 900, waited);

// ── 7) attempts=1 表示不重连 ───────────────────────────────────────────────
await callApi('POST', '/save', {
  channel: {
    id: 'noch',
    name: '不重连渠道',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test-abcdefgh',
    models: ['model-a'],
    retry: { attempts: 1 },
  },
});
calls = scriptFetch([jsonResponse(502, { error: { message: 'nope' } })]);
chunks = await collect({ model: 'noch::model-a' });
check('attempts=1 时 502 只请求一次', calls.length === 1, calls.length);
check('attempts=1 时直接报错', chunks.at(-1)?.reason?.kind === 'error', chunks.at(-1)?.reason);

// ── 8) 重连等待期间取消：立刻停，不再发请求 ────────────────────────────────
await callApi('POST', '/save', {
  channel: {
    id: 'slowch',
    name: '慢重连渠道',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test-abcdefgh',
    models: ['model-a'],
    retry: { attempts: 5, initialDelayMs: 5000, maxDelayMs: 5000 },
  },
});
calls = scriptFetch([jsonResponse(502, { error: { message: 'nope' } })]);
const controller = new AbortController();
setTimeout(() => controller.abort(), 60);
chunks = await collect({ model: 'slowch::model-a' }, controller.signal);
log('8) 取消后请求次数 ' + calls.length + '，finish ' + JSON.stringify(chunks.at(-1)?.reason));
check('取消后只发了 1 次请求', calls.length === 1, calls.length);
check('取消后以 aborted 收尾', chunks.at(-1)?.reason?.kind === 'aborted', chunks.at(-1)?.reason);

// ── 清理 ──────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
await callApi('POST', '/delete', { id: 'rch' });
await callApi('POST', '/delete', { id: 'noch' });
await callApi('POST', '/delete', { id: 'slowch' });
fsx.rmSync(TEST_HOME, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  log('✅ 全部用例通过');
  process.exit(0);
}
console.error(`[retry] ${failures} 个用例失败`);
process.exit(1);

async function callApi(method, path, body) {
  const url = 'http://127.0.0.1/api/usemodel' + path;
  let status = 0;
  let raw = '';
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:61598', origin: 'http://127.0.0.1:61598' },
    on(event, fn) {
      if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
      if (event === 'end') fn();
    },
    destroy() {},
  };
  const res = {
    writeHead(code) { status = code; },
    end(payload) { raw = String(payload ?? ''); },
  };
  await handler(req, res);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  return { ok: payload.ok === true, status, payload };
}
