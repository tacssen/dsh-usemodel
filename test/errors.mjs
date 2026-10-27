// 上游报错翻译自检：403/401/404/429/5xx、连不上、超时，都要说人话。
//
//   node test/errors.mjs
//
// 全程不联网：把 globalThis.fetch 换掉，按用例返回假响应或直接抛错。
import osx from 'node:os';
import pathx from 'node:path';
import fsx from 'node:fs';

const TEST_HOME = pathx.join(osx.tmpdir(), 'usemodel-errors-' + process.pid + '-' + Date.now());
fsx.mkdirSync(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;

const log = (...args) => console.log('[errors]', ...args);
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
  console.error('[errors] ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
}

function stubJson(status, body, statusText = '') {
  globalThis.fetch = async () => new Response(body, {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}
function stubThrow(message) {
  globalThis.fetch = async () => { throw new TypeError(message); };
}

await callApi('POST', '/save', {
  channel: {
    id: 'errch',
    name: '报错渠道',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test-abcdefgh',
    models: ['model-a'],
  },
});

// ── /test：403 没权限 ────────────────────────────────────────────────────────
stubJson(403, JSON.stringify({
  error: { message: 'You do not have access to model model-a', type: 'invalid_request_error', code: 'model_not_found' },
}), 'Forbidden');
let res = await callApi('POST', '/test', { channel: baseChannel(), model: 'model-a' });
let p = res.payload;
log('403 结果: ' + JSON.stringify({ error: p.error, hint: p.hint, code: p.code, status: p.status }));
check('403 说人话（不再吐 JSON 体）', typeof p.error === 'string' && !p.error.includes('{"'), p.error);
check('403 带上游自己的短说明', p.error.includes('You do not have access'), p.error);
check('403 有下一步提示', typeof p.hint === 'string' && p.hint.length > 0, p.hint);
check('403 原始报文留在 detail', typeof p.detail === 'string' && p.detail.includes('model_not_found'), p.detail);
check('403 失败码是 AUTH', p.code === 'AUTH', p.code);
check('403 仍保留 status/ms', p.status === 403 && typeof p.ms === 'number', p);

// ── /test：429 限流 ────────────────────────────────────────────────────────
stubJson(429, JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }));
p = (await callApi('POST', '/test', { channel: baseChannel(), model: 'model-a' })).payload;
check('429 失败码是 RATE_LIMIT', p.code === 'RATE_LIMIT', p.code);
check('429 提示里提到限流', p.error.includes('限流'), p.error);

// ── /test：500 + HTML 错误页 ────────────────────────────────────────────────
stubJson(502, '<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>', 'Bad Gateway');
p = (await callApi('POST', '/test', { channel: baseChannel(), model: 'model-a' })).payload;
check('502 说上游自己出错', p.error.includes('上游服务自己出错'), p.error);
check('502 失败码是 SERVER（会被重试）', p.code === 'SERVER', p.code);
check('502 HTML 不混进结论', !p.error.includes('<html>'), p.error);
check('502 HTML 进 detail', p.detail.includes('502 Bad Gateway'), p.detail.slice(0, 80));

// ── /test：连不上 ──────────────────────────────────────────────────────────
stubThrow('fetch failed');
p = (await callApi('POST', '/test', { channel: baseChannel(), model: 'model-a' })).payload;
check('连不上说人话', p.error.includes('连不上这个地址'), p.error);
check('连不上失败码是 TRANSPORT', p.code === 'TRANSPORT', p.code);
check('连不上提示查地址/网络', p.hint.includes('Base URL'), p.hint);

// ── /models：401 Key 无效 ──────────────────────────────────────────────────
stubJson(401, JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }), 'Unauthorized');
let m = (await callApi('POST', '/models', { baseURL: 'https://api.example.com/v1', apiKey: 'sk-bad' })).payload;
log('/models 401: ' + JSON.stringify({ ok: m.ok, error: m.error, hint: m.hint, code: m.code }));
check('/models 401 ok=false', m.ok === false, m);
check('/models 401 说 Key 没被接受', m.error.includes('API Key'), m.error);
check('/models 401 带 hint/detail/code', m.hint.length > 0 && m.detail.includes('invalid_api_key') && m.code === 'AUTH', m);

// ── /models：返回的不是 JSON ───────────────────────────────────────────────
stubJson(200, '<html>this is a website</html>', 'OK');
m = (await callApi('POST', '/models', { baseURL: 'https://example.com/v1', apiKey: 'sk-x' })).payload;
check('/models 非 JSON 说清是地址问题', m.ok === false && m.error.includes('不是 JSON'), m.error);

// ── stream()：404 地址不对 ─────────────────────────────────────────────────
stubJson(404, 'Not Found', 'Not Found');
let finish = await streamOnce({ model: 'errch::model-a' });
log('stream 404: ' + JSON.stringify(finish));
check('stream 404 是 error 结束', finish?.reason?.kind === 'error', finish);
check('stream 404 说地址不对', finish?.reason?.failure?.message.includes('这个地址下没有接口'), finish?.reason?.failure?.message);
check('stream 404 提示 Base URL 填到 /v1', finish?.reason?.failure?.message.includes('/v1'), finish?.reason?.failure?.message);
check('stream 404 失败码是 INVALID_REQUEST', finish?.reason?.failure?.code === 'INVALID_REQUEST', finish?.reason?.failure?.code);

// ── stream()：500 上游挂了 ─────────────────────────────────────────────────
stubJson(500, JSON.stringify({ error: { message: 'internal error' } }), 'Internal Server Error');
finish = await streamOnce({ model: 'errch::model-a' });
check('stream 500 失败码是 SERVER', finish?.reason?.failure?.code === 'SERVER', finish?.reason?.failure?.code);
check('stream 500 不带原始 JSON 大括号', !finish?.reason?.failure?.message.includes('{"'), finish?.reason?.failure?.message);

// ── 真实 socket：本地假上游回 403，走完整 fetch 链路 ────────────────────────
globalThis.fetch = realFetch;
const http = await import('node:http');
const fakeUpstream = http.createServer((req, res) => {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'token group has no access to this model', code: 'no_access' } }));
});
await new Promise((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve));
const port = fakeUpstream.address().port;
globalThis.fetch = realFetch;
p = (await callApi('POST', '/test', {
  channel: { ...baseChannel(), baseURL: 'http://127.0.0.1:' + port + '/v1' },
  model: 'model-a',
})).payload;
log('真实 403: ' + JSON.stringify({ error: p.error, code: p.code, hint: p.hint, status: p.status }));
check('真实请求 403 也翻成人话', p.ok === false && p.error.includes('Key 被拒绝'), p.error);
check('真实请求保留上游 code 与 detail', p.detail.includes('no_access'), p.detail);
await new Promise((resolve) => fakeUpstream.close(resolve));

// ── 清理 ──────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
await callApi('POST', '/delete', { id: 'errch' });
fsx.rmSync(TEST_HOME, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  log('✅ 全部用例通过');
  process.exit(0);
}
console.error(`[errors] ${failures} 个用例失败`);
process.exit(1);

function baseChannel() {
  return {
    id: 'errch',
    name: '报错渠道',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-test-abcdefgh',
    models: ['model-a'],
  };
}

async function streamOnce(options) {
  let last = null;
  for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...options })) {
    last = chunk;
  }
  return last;
}

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
