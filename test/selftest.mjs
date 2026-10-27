// dsh-usemodel 服务端自检：mock 内核 ctx，验证注册与 HTTP API。
import { pathToFileURL } from 'node:url';

const ENTRY = new URL('../index.js', import.meta.url).href;
// 隔离：测试永远用临时 DSH_HOME，绝不碰真实配置
import osx from "node:os";
import pathx from "node:path";
import fsx from "node:fs";
const TEST_HOME = pathx.join(osx.tmpdir(), "usemodel-test-" + process.pid + "-" + Date.now());
fsx.mkdirSync(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;
const mod = await import(ENTRY);

const log = (...args) => console.log('[test]', ...args);

if (typeof mod.apply !== 'function') { console.error('缺少 apply 导出'); process.exit(1); }
if (mod.name !== 'usemodel') { console.error('name 不对: ' + mod.name); process.exit(1); }
if (!Array.isArray(mod.inject) || !mod.inject.includes('llm')) { console.error('inject 不对: ' + JSON.stringify(mod.inject)); process.exit(1); }
log('导出正常: name=' + mod.name + ' inject=' + JSON.stringify(mod.inject));

const captured = { adapters: [], providers: [], discovery: [], routes: [], effects: 0 };
let serverRegister = null;

const fakeLlm = {
  registerAdapter(routes, adapter) {
    captured.adapters.push({ routes, adapter });
    return { replace(next) { captured.adapters.push({ routes: next, adapter, replaced: true }); } };
  },
  registerConfigurableProviders(list) { captured.providers.push(list); },
  registerModelDiscovery(id, fn) { captured.discovery.push({ id, fn }); },
};

const ctx = {
  logger: { info: (...a) => log('info:', ...a), warn: (...a) => log('warn:', ...a), debug: () => {} },
  llm: fakeLlm,
  effect(fn) { captured.effects += 1; const d = fn(); return typeof d === 'function' ? d : () => {}; },
  inject(deps, cb) {
    if (!deps.includes('webServer')) return;
    cb({
      webServer: { register(spec) { captured.routes.push(spec); return () => {}; } },
      effect(fn) { fn(); },
    });
  },
};

try {
  mod.apply(ctx);
} catch (error) {
  console.error('apply 抛异常:', error);
  process.exit(1);
}

const adapter = captured.adapters[0]?.adapter;
log('registerAdapter 路由: ' + JSON.stringify(captured.adapters[0]?.routes));
log('registerConfigurableProviders: ' + JSON.stringify(captured.providers[0]));
log('registerModelDiscovery id: ' + (captured.discovery[0]?.id ?? '未注册'));
log('HTTP 路由: ' + JSON.stringify(captured.routes.map(r => r.kind + ' ' + r.path)));
if (captured.routes.length === 0) { console.error('没挂上 HTTP 路由'); process.exit(1); }
serverRegister = captured.routes[0].handler;

// ── adapter 方法形状 ────────────────────────────────────────────────────────
for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
  if (typeof adapter[method] !== 'function') { console.error('adapter 缺方法: ' + method); process.exit(1); }
}
log('adapter 方法齐全');
log('providerInfo: ' + JSON.stringify(adapter.providerInfo('usemodel')));
const policy = adapter.providerRetryPolicy();
log('retryPolicy: ' + JSON.stringify(policy));

// 空配置下的 listModels
log('空配置 listModels: ' + JSON.stringify(await adapter.listModels('usemodel')));
const resolved = await adapter.resolveModel('usemodel', 'nope::model-x');
log('resolveModel(空渠道): ' + JSON.stringify(resolved));

// ── 写一条渠道，验证落盘与列表 ───────────────────────────────────────────────
const channel = {
  id: 'testch',
  name: '测试渠道',
  baseURL: 'https://api.example.com/v1/',
  apiKey: 'sk-test-1234567890',
  models: ['model-a', 'model-b'],
};
const saveRes = await callApi('POST', '/save', { channel });
log('保存结果 ok=' + saveRes.ok + ' 状态=' + saveRes.status);

const stateRes = await callApi('GET', '/state');
log('state 渠道数=' + stateRes.payload.config.channels.length);
const saved = stateRes.payload.config.channels.at(-1);
log('落盘内容: ' + JSON.stringify({ id: saved.id, name: saved.name, baseURL: saved.baseURL, models: saved.models }));
if (saved.baseURL !== 'https://api.example.com/v1') { console.error('baseURL 末尾斜杠没去掉: ' + saved.baseURL); process.exit(1); }

const rows = await adapter.listModels('usemodel');
log('listModels 行数=' + rows.length + ' 首行=' + JSON.stringify(rows[0]));
if (rows.length !== 2) { console.error('模型数不对'); process.exit(1); }

const one = await adapter.resolveModel('usemodel', 'testch::model-a');
log('resolveModel: ' + JSON.stringify(one));

const prepared = await adapter.prepareCall('usemodel', 'testch::model-a');
log('prepareCall 有 stream: ' + (typeof prepared.stream === 'function'));

// ── stream 对错误渠道的反应（不联网） ────────────────────────────────────────
const chunks = [];
for await (const chunk of adapter.stream({ model: 'ghost::nope', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
  chunks.push(chunk);
}
log('未知渠道 chunk: ' + JSON.stringify(chunks));

// 缺 key 的渠道
const chunks2 = [];
for await (const chunk of adapter.stream({ model: 'testch::model-a', messages: [] })) {
  chunks2.push(chunk);
}
log('未联网渠道 chunk: ' + JSON.stringify(chunks2).slice(0, 300));

// ── 删除 ────────────────────────────────────────────────────────────────────
const delRes = await callApi('POST', '/delete', { id: 'testch' });
log('删除后渠道数=' + delRes.payload.config.channels.length);

// ── 清理测试产物 ────────────────────────────────────────────────────────────
log('自检完成，配置已恢复为空');

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
  await serverRegister(req, res);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  return { ok: payload.ok === true, status, payload };
}
