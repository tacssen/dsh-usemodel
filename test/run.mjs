#!/usr/bin/env node
/**
 * 跑全部自检。任何一个失败，整体退出码非 0。
 *
 *   node test/run.mjs
 *
 * 每个脚本自己把 DSH_HOME 指到临时目录，永远不会碰真实配置。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = [
  ['selftest.mjs', '内核注册 + HTTP API'],
  ['sse.mjs', 'SSE → StreamChunk 协议'],
  ['detect.mjs', '粘贴识别'],
  ['alias.mjs', '模型别名'],
];

let failed = 0;
for (const [file, label] of CASES) {
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  const ms = Date.now() - started;
  if (code === 0) {
    console.log(`✅ ${label} (${file}) — ${ms}ms`);
  } else {
    failed += 1;
    console.log(`❌ ${label} (${file}) — 退出码 ${code}`);
  }
}

console.log('');
if (failed === 0) {
  console.log('全部通过');
  process.exit(0);
}
console.log(`${failed} 个失败`);
process.exit(1);
