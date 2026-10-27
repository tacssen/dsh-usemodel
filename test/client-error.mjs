// 浏览器半的失败展示自检：用假 react 把 client.js 跑起来，检查渲染树。
//
//   node test/client-error.mjs
//
// 不联网、不开浏览器：client.js 只用到 react 的 createElement，替身足够。
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

const loaded = [];
const shim = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Component: class Component {},
};

const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } },
  fetch: () => Promise.reject(new Error('测试里不该联网')),
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

const log = (...args) => console.log('[client]', ...args);
let failures = 0;
function check(name, condition, extra) {
  if (condition) { log('✅ ' + name); return; }
  failures += 1;
  console.error('[client] ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
}

check('client.js 自我注册了一个模块', loaded.length === 1, loaded.length);
const spec = loaded[0];
check('模块 id 是 dsh-usemodel', spec.id === 'dsh-usemodel', spec.id);

const exported = spec.factory((name) => {
  if (name === 'react') return shim;
  throw new Error('意外的依赖: ' + name);
});
const Failure = exported.__test?.Failure;
check('__test 导出 Failure', typeof Failure === 'function', typeof Failure);

// ── 渲染树遍历工具 ──────────────────────────────────────────────────────────
function render(tree) {
  const strings = [];
  const details = [];
  let detailText = '';
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { strings.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'details') details.push(node);
    if (node.type === 'pre') detailText += (node.children ?? []).join('');
    (node.children ?? []).forEach(walk);
  };
  walk(tree);
  return { strings, text: strings.join('\n'), details, detailText };
}

// ── 完整失败结果：结论 + 提示 + 折叠详情 ────────────────────────────────────
const full = render(Failure({
  result: {
    ok: false,
    status: 403,
    error: 'Key 被拒绝：没权限或被禁用（上游：You do not have access to model gpt-4o）',
    hint: '检查这个 Key 的分组/权限、IP 白名单、所在地区是否受限',
    detail: '{"error":{"message":"You do not have access to model gpt-4o","code":"model_not_found"}}',
  },
}));
log('渲染文本:\n' + full.text);
check('显示人话结论', full.text.includes('Key 被拒绝：没权限或被禁用'), full.text);
check('结论里带 HTTP 状态', full.text.includes('HTTP 403'), full.text);
check('显示下一步提示', full.text.includes('检查这个 Key 的分组/权限'), full.text);
check('原始报文折叠在 details 里', full.details.length === 1 && full.text.includes('详情'), full.details.length);
check('details 里的原始报文完整', full.detailText.includes('model_not_found'), full.detailText);
check('原始报文没混进第一行结论', !full.strings[0].includes('model_not_found'), full.strings[0]);

// ── 只有错误、没有 status/hint/detail ──────────────────────────────────────
const bare = render(Failure({ result: { ok: false, error: '未知错误' } }));
check('缺 status 时不渲染 HTTP 括号', !bare.text.includes('HTTP'), bare.text);
check('缺 hint 时不出现空提示行', !bare.text.includes('→'), bare.text);
check('缺 detail 时不出现空详情块', bare.details.length === 0, bare.details.length);
check('缺 error 时兜底文案', render(Failure({ result: {} })).text.includes('未知错误'));

// ── 拉取失败的标题可覆盖 ───────────────────────────────────────────────────
const pull = render(Failure({ result: { ok: false, error: 'API Key 没被接受', hint: '检查 Key' }, prefix: '拉取失败' }));
check('prefix 生效', pull.strings[0].startsWith('拉取失败 · API Key 没被接受'), pull.strings[0]);

console.log('');
if (failures === 0) {
  log('✅ 全部用例通过');
  process.exit(0);
}
console.error(`[client] ${failures} 个用例失败`);
process.exit(1);
