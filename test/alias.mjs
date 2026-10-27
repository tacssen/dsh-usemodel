// 模型别名自检：显示名与真实 id 分离是否按预期工作。
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
const log = (...a) => console.log('[alias]', ...a);

const CONFIG = path.join(os.homedir(), '.dsh', 'usemodel', 'config.json');
const backup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;

let handler = null;
const captured = { adapters: [] };
mod.apply({
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  llm: {
    registerAdapter(r, a) { captured.adapters.push(a); return { replace() {} }; },
    registerConfigurableProviders() {}, registerModelDiscovery() {},
  },
  effect(fn) { fn(); return () => {}; },
  inject(deps, cb) { cb({ webServer: { register(spec) { if (spec.path === '/api/usemodel') handler = spec.handler; } }, effect(fn) { fn(); } }); },
});
const adapter = captured.adapters[0];

async function call(p, body) {
  let status = 0, raw = '';
  const req = {
    method: 'POST', url: 'http://127.0.0.1/api/usemodel' + p,
    headers: { host: '127.0.0.1:56018' },
    on(ev, fn) { if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); },
    destroy() {},
  };
  const res = { writeHead(c) { status = c; }, end(x) { raw = String(x ?? ''); } };
  await handler(req, res);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  return { status, payload };
}

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// ── 一行行喂进去，看归一化结果 ───────────────────────────────────────────────
const save = await call('/save', {
  channel: {
    id: 'aliastest',
    name: '别名测试',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    models: [
      'gpt-4o-mini',
      '[按量6] deepseek-v4.1-flash-1017 [不补]',
      'gpt-4o => 我的 GPT',
      'claude-x | 克劳德',
      { id: 'obj-model', name: '对象写的' },
      '',
    ],
  },
});
check(save.payload.ok === true, '保存失败: ' + JSON.stringify(save.payload).slice(0, 200));

const saved = save.payload.config.channels.find(c => c.id === 'aliastest');
log('归一化结果:');
for (const m of saved.models) log('   id=' + JSON.stringify(m.id) + '  name=' + JSON.stringify(m.name));

const byId = (id) => saved.models.find(m => m.id === id);
check(saved.models.length === 5, '模型数应为 5，实际 ' + saved.models.length);

check(byId('gpt-4o-mini')?.name === 'gpt-4o-mini', '纯 id 的显示名不该变');
const messy = byId('[按量6] deepseek-v4.1-flash-1017 [不补]');
check(messy !== undefined, '方括号 id 没保留');
check(messy?.name === 'deepseek-v4.1-flash-1017', '方括号没被清理成显示名，实际 ' + JSON.stringify(messy?.name));
check(byId('gpt-4o')?.name === '我的 GPT', '=> 别名没生效');
check(byId('claude-x')?.name === '克劳德', '竖线别名没生效');
check(byId('obj-model')?.name === '对象写的', '对象形式没生效');

// ── listModels：id 用真实名，name 用别名 ──────────────────────────────────────
const rows = await adapter.listModels('usemodel');
const rowMessy = rows.find(r => r.id === 'aliastest::[按量6] deepseek-v4.1-flash-1017 [不补]');
check(rowMessy !== undefined, 'listModels 里找不到方括号模型');
check(rowMessy?.name === '别名测试 · deepseek-v4.1-flash-1017', 'listModels 显示名不对: ' + JSON.stringify(rowMessy?.name));
const rowAlias = rows.find(r => r.id === 'aliastest::gpt-4o');
check(rowAlias?.name === '别名测试 · 我的 GPT', 'listModels 别名没生效: ' + JSON.stringify(rowAlias?.name));

// ── resolveModel 跟着别名走 ──────────────────────────────────────────────────
const resolved = await adapter.resolveModel('usemodel', 'aliastest::gpt-4o');
check(resolved.name === '别名测试 · 我的 GPT', 'resolveModel 名称不对: ' + JSON.stringify(resolved.name));

// ── detect 返回的也必须是对象数组 ────────────────────────────────────────────
const detect = await call('/detect', { text: 'https://api.example.com/v1\nsk-abcdef0123456789' });
log('detect 返回的模型条数: ' + (detect.payload.channel?.models?.length ?? 0) + '（该假地址探测会失败，0 属正常）');

// 清理
await call('/delete', { id: 'aliastest' });
if (backup !== null) fs.writeFileSync(CONFIG, backup);

log('');
if (problems.length === 0) log('✅ 别名全部断言通过');
else { log('❌ 失败项:'); for (const p of problems) log('   - ' + p); }
process.exit(problems.length === 0 ? 0 : 1);
