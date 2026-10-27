// 假 OpenAI 上游 + 真 adapter：验证 SSE → StreamChunk 的完整序列。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const log = (...a) => console.log('[sse]', ...a);

/** 上游剧本：先思考、再文本、再来两个工具调用，最后 usage。 */
const SCRIPT = [
  { choices: [{ index: 0, delta: { reasoning_content: '先想一下。' } }] },
  { choices: [{ index: 0, delta: { content: '你好，' } }] },
  { choices: [{ index: 0, delta: { content: '世界。' } }] },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
        ],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
  {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 1, id: 'call_def', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
        ],
      },
    }],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 12 } } },
];

let receivedBody = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of SCRIPT) res.write('data: ' + JSON.stringify(frame) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
log('假上游端口 ' + port);

// 写入一条指向假上游的渠道
const configPath = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'usemodel', 'config.json');
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const backup = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null;
fs.writeFileSync(configPath, JSON.stringify({
  channels: [{
    id: 'local',
    name: '本地假上游',
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    apiKey: 'sk-local',
    models: ['demo-model'],
    contextWindow: 64000,
    maxTokens: 4096,
    updatedAt: Date.now(),
  }],
  defaultMaxTokens: 8192,
}, null, 2));

// 最简 ctx
const captured = { adapters: [] };
mod.apply({
  logger: { info: () => {}, warn: (...a) => log('warn:', ...a), debug: () => {} },
  llm: {
    registerAdapter(routes, adapter) { captured.adapters.push(adapter); return { replace() {} }; },
    registerConfigurableProviders() {}, registerModelDiscovery() {},
  },
  effect(fn) { fn(); return () => {}; },
  inject() {},
});
const adapter = captured.adapters[0];

const messages = [
  { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
  { role: 'user', content: [{ type: 'text', text: '看下 a.txt' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我看看' },
      { type: 'tool-call', id: 'call_old', name: 'read_file', arguments: '{"path":"b.txt"}' },
    ],
  },
  { role: 'tool', toolCallId: 'call_old', content: [{ type: 'text', text: '文件内容' }] },
];

const tools = [{
  name: 'read_file',
  description: '读文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

const chunks = [];
for await (const chunk of adapter.stream({
  model: 'local::demo-model',
  messages,
  tools,
  temperature: 0.3,
  maxTokens: 2048,
  signal: new AbortController().signal,
})) {
  chunks.push(chunk);
}

log('上游收到的请求: ' + JSON.stringify({
  model: receivedBody.model,
  stream: receivedBody.stream,
  temperature: receivedBody.temperature,
  max_tokens: receivedBody.max_tokens,
  toolCount: receivedBody.tools?.length,
  messages: receivedBody.messages,
}, null, 1).slice(0, 1400));

log('chunk 序列:');
for (const c of chunks) log('  ' + JSON.stringify(c));

// ── 断言 ────────────────────────────────────────────────────────────────────
const problems = [];
const starts = chunks.filter(c => c.type === 'block-start');
const ends = chunks.filter(c => c.type === 'block-end');
const textDeltas = chunks.filter(c => c.type === 'text-delta');
const reasoningDeltas = chunks.filter(c => c.type === 'reasoning-delta');
const toolDeltas = chunks.filter(c => c.type === 'tool-call-delta');
const usage = chunks.find(c => c.type === 'usage');
const finish = chunks.find(c => c.type === 'finish');

if (starts.length !== 4) problems.push('block-start 应为 4（reasoning/text/2×tool-call），实际 ' + starts.length);
if (ends.length !== 4) problems.push('block-end 应为 4，实际 ' + ends.length);
if (textDeltas.length !== 2) problems.push('text-delta 应为 2，实际 ' + textDeltas.length);
if (reasoningDeltas.length !== 1) problems.push('reasoning-delta 应为 1，实际 ' + reasoningDeltas.length);
if (toolDeltas.length !== 3) problems.push('tool-call-delta 应为 3（call_abc 两段 + call_def 一段），实际 ' + toolDeltas.length);

const textEnd = ends.find(c => c.block.type === 'text');
if (textEnd?.block.text !== '你好，世界。') problems.push('文本聚合错误: ' + JSON.stringify(textEnd?.block));
const reasoningEnd = ends.find(c => c.block.type === 'reasoning');
if (reasoningEnd?.block.text !== '先想一下。') problems.push('思考聚合错误');

const toolEnds = ends.filter(c => c.block.type === 'tool-call');
if (toolEnds.length !== 2) problems.push('工具 block-end 应为 2，实际 ' + toolEnds.length);
const t0 = toolEnds[0]?.block;
if (t0?.id !== 'call_abc' || t0?.name !== 'read_file') problems.push('第一个工具 id/name 错: ' + JSON.stringify(t0));
if (t0?.arguments !== '{"path":"a.txt"}') problems.push('第一个工具参数拼接错: ' + JSON.stringify(t0?.arguments));
const t1 = toolEnds[1]?.block;
if (t1?.id !== 'call_def' || t1?.name !== 'list_dir') problems.push('第二个工具错: ' + JSON.stringify(t1));

if (usage?.usage?.inputTokens !== 100) problems.push('inputTokens 应扣掉缓存 120-20=100，实际 ' + usage?.usage?.inputTokens);
if (usage?.usage?.outputTokens !== 45) problems.push('outputTokens 错: ' + usage?.usage?.outputTokens);
if (usage?.usage?.cacheReadTokens !== 20) problems.push('cacheReadTokens 错');
if (usage?.usage?.reasoningTokens !== 12) problems.push('reasoningTokens 错');
if (finish?.reason?.kind !== 'tool-calls') problems.push('finish 应为 tool-calls，实际 ' + JSON.stringify(finish?.reason));

if (receivedBody?.temperature !== 0.3) problems.push('temperature 没透传');
if (receivedBody?.max_tokens !== 2048) problems.push('max_tokens 没透传: ' + receivedBody?.max_tokens);
if (receivedBody?.tools?.length !== 1) problems.push('tools 没透传');
if (receivedBody?.tools?.[0]?.function?.name !== 'read_file') problems.push('tools 形状不对');
const roles = (receivedBody?.messages ?? []).map(m => m.role);
if (JSON.stringify(roles) !== JSON.stringify(['system', 'user', 'assistant', 'tool'])) {
  problems.push('消息角色投影错: ' + JSON.stringify(roles));
}
const toolMsg = receivedBody?.messages?.find(m => m.role === 'tool');
if (toolMsg?.tool_call_id !== 'call_old') problems.push('tool_call_id 丢失: ' + JSON.stringify(toolMsg));

log('');
if (problems.length === 0) {
  log('✅ 全部断言通过');
} else {
  log('❌ 失败项:');
  for (const p of problems) log('   - ' + p);
}

// 还原配置
if (backup === null) fs.rmSync(configPath, { force: true });
else fs.writeFileSync(configPath, backup);
server.close();
process.exit(problems.length === 0 ? 0 : 1);
