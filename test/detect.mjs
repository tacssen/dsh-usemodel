// 粘贴识别自检：本地假中转站 + 各种真实粘贴格式。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 隔离：测试永远用临时 DSH_HOME，绝不碰真实配置
import osx from "node:os";
import pathx from "node:path";
import fsx from "node:fs";
const TEST_HOME = pathx.join(osx.tmpdir(), "usemodel-test-" + process.pid + "-" + Date.now());
fsx.mkdirSync(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;
const mod = await import(new URL('../index.js', import.meta.url).href);
const log = (...a) => console.log('[detect]', ...a);

// ── 假上游：一个 OpenAI 兼容站 + 一个分享链接站 ──────────────────────────────
const MODELS = [
  { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, { id: 'deepseek-chat' },
  { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'tts-1' },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/v1/models' || url.pathname === '/api/v1/models') {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) { res.writeHead(401).end('{"error":"no key"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS }));
    return;
  }
  if (url.pathname === '/share/abc') {
    // 中转站分享链接：返回一段配置 JSON
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: '某某中转站',
      base_url: `http://127.0.0.1:${port}/v1`,
      api_key: 'sk-shared-0123456789abcdef',
    }));
    return;
  }
  if (url.pathname === '/share/yaml') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('name: YAML 站点\nbase_url: http://127.0.0.1:' + port + '/v1\napi_key: sk-yaml-0123456789abcdef\n');
    return;
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
log('假站端口 ' + port);

// ── mock ctx 拿到 handle ────────────────────────────────────────────────────
let handler = null;
mod.apply({
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  llm: { registerAdapter: () => ({ replace() {} }), registerConfigurableProviders() {}, registerModelDiscovery() {} },
  effect(fn) { fn(); return () => {}; },
  inject(deps, cb) { cb({ webServer: { register(spec) { if (spec.path === '/api/usemodel') handler = spec.handler; } }, effect(fn) { fn(); } }); },
});
if (handler === null) { console.error('没拿到 handler'); process.exit(1); }

async function call(path, body) {
  let status = 0, raw = '';
  const req = {
    method: 'POST', url: 'http://127.0.0.1/api/usemodel' + path,
    headers: { host: '127.0.0.1:52761' },
    on(ev, fn) { if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); },
    destroy() {},
  };
  const res = { writeHead(c) { status = c; }, end(p) { raw = String(p ?? ''); } };
  await handler(req, res);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  return { status, payload };
}

const CASES = [
  {
    name: '纯 Base URL',
    text: 'https://api.openai.com/v1',
    expect: { baseURL: 'https://api.openai.com/v1', apiKey: '' },
  },
  {
    name: 'Base URL 带端点后缀',
    text: 'https://api.openai.com/v1/chat/completions',
    expect: { baseURL: 'https://api.openai.com/v1', apiKey: '' },
  },
  {
    name: '只有域名（自动补 /v1）',
    text: 'https://api.deepseek.com',
    expect: { baseURL: 'https://api.deepseek.com/v1', apiKey: '' },
  },
  {
    name: '只有 Key',
    text: 'sk-abcdef0123456789abcdef',
    expect: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-abcdef0123456789abcdef' },
  },
  {
    name: '两行：地址 + Key',
    text: 'Base URL: http://127.0.0.1:' + 'PORT' + '/v1\nAPI Key: sk-local-0123456789abcdef',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-local-0123456789abcdef', probe: true },
  },
  {
    name: 'curl 命令',
    text: 'curl http://127.0.0.1:PORT/v1/chat/completions -H "Authorization: Bearer sk-curlie-0123456789abcdef"',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-curlie-0123456789abcdef', probe: true },
  },
  {
    name: 'URL query 里带 key',
    text: 'http://127.0.0.1:PORT/v1?key=sk-query-0123456789abcdef',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-query-0123456789abcdef', probe: true },
  },
  {
    name: '中转站分享链接（JSON）',
    text: 'http://127.0.0.1:PORT/share/abc',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-shared-0123456789abcdef', probe: true },
  },
  {
    name: '中转站分享链接（yaml）',
    text: 'http://127.0.0.1:PORT/share/yaml',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-yaml-0123456789abcdef', probe: true },
  },
  {
    name: '一段乱文本里夹着配置',
    text: '给你个号：\n地址 http://127.0.0.1:PORT/v1\n密钥：sk-mixed-0123456789abcdef\n别外传',
    expect: { baseURL: 'http://127.0.0.1:PORT/v1', apiKey: 'sk-mixed-0123456789abcdef', probe: true },
  },
];

let failed = 0;
for (const testCase of CASES) {
  const text = testCase.text.replaceAll('PORT', String(port));
  const { payload } = await call('/detect', { text });
  const channel = payload.channel ?? {};
  const problems = [];

  const wantBase = testCase.expect.baseURL.replaceAll('PORT', String(port));
  if (payload.ok !== true) problems.push('ok=false: ' + payload.error);
  if (channel.baseURL !== wantBase) problems.push(`baseURL 期望 ${wantBase} 实际 ${channel.baseURL}`);
  if (testCase.expect.apiKey !== '' && channel.apiKey !== testCase.expect.apiKey) {
    problems.push(`apiKey 期望 ${testCase.expect.apiKey} 实际 ${channel.apiKey}`);
  }
  if (testCase.expect.apiKey === '' && channel.apiKey !== undefined && channel.apiKey !== '') {
    problems.push('不该认出 key，却认成了 ' + channel.apiKey);
  }
  if (testCase.expect.probe === true) {
    const ids = Array.isArray(channel.models) ? channel.models.map(m => typeof m === 'string' ? m : m.id) : [];
    if (ids.length === 0) problems.push('没探测到模型');
    else if (ids.includes('text-embedding-3-small')) problems.push('embedding 没被滤掉');
    else if (ids.includes('whisper-1')) problems.push('whisper 没被滤掉');
    else if (!ids.includes('gpt-4o-mini')) problems.push('漏了 gpt-4o-mini');
  }

  if (problems.length === 0) {
    log(`✅ ${testCase.name} → ${channel.baseURL} | key=${channel.apiKey ? '有' : '无'} | 模型=${(channel.models ?? []).length}`);
  } else {
    failed += 1;
    log(`❌ ${testCase.name}`);
    for (const p of problems) log('    - ' + p);
    log('    返回: ' + JSON.stringify(payload).slice(0, 400));
  }
}

// 反向用例：纯垃圾文本
const junk = await call('/detect', { text: '今天天气不错' });
log(junk.payload.ok === false ? '✅ 垃圾文本被拒：' + junk.payload.error.slice(0, 40) + '…' : '❌ 垃圾文本竟然识别成功了');

log('');
log(failed === 0 ? '✅ 全部用例通过' : `❌ ${failed} 个用例失败`);
server.close();
process.exit(failed === 0 ? 0 : 1);
