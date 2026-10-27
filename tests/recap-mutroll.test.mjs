
// 第 39 轮缺陷 2：队列内真失败必须回滚 mutating 计数（端到端，真跑 lib/index.js 的生产路径）。
//
// 为什么必须端到端：修复是在 lib/index.js 的 runRecap 里加 onFailed 回调（队列只负责
// 「这是真失败」这个判定），所以只测 recap-queue 层证明不了 index.js 真的接上了线。
// 这里与 recap-hang.test.mjs 同样用子进程驱动：常量在 import 时求值，且 lib/index.js
// 需要宿主 stub。
//
// 实测对照（exp/acct.mjs / exp/acct2.mjs）：
//   修复前：场景 1 {queued:true} → mutCount 0；场景 2 executeRecap 抛错 → mutCount 1
//           （失败那一次 mutating 额度被吞，threshold>1 时要重新攒满）。
//   修复后：队列 onFailed → restorePendingMutCount，失败那一次计数被还回来。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-mutroll-'));

const DRIVER = `
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROLL_ROOT;
const HOME_DIR = path.join(ROOT, 'home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

const STUBS = {
  '@deepseek-ai/schemastery':
    'const chain = () => { const f = (v) => f; f.description = () => f; f.default = () => f; f.optional = () => f; return f; };' +
    'export default { string: () => chain(), boolean: () => chain(), number: () => chain(), object: () => chain() };',
  '@deepseek-ai/dsh-tools': 'export function defineTool(options) { return options; }',
  '@deepseek-ai/dsh-llm':
    'export function createUserMessage(input) {' +
    ' return Object.assign({}, input, { role: "user", id: "msg-" + Math.random().toString(36).slice(2) });' +
    ' }',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    return nextResolve(specifier);
  },
});

const file = path.join(ROOT, 'playbook.md');
const plugin = await import(pathToFileURL(process.env.ROLL_LIB).href);

const logs = { info: [], warn: [], error: [] };
const notices = [];
let reflectCalls = 0;
const ctx = {
  logger: {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.error.push(String(m)),
    debug: () => {},
  },
  tools: { register: () => {} },
  systemPrompt: { section: () => {} },
  on: () => {},
  commands: { register: () => {} },
  get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
  llm: {
    async *stream(options) {
      reflectCalls += 1;
      // 让复盘管道在第 1 轮 Reflector 就抛错 —— 这是「真失败」路径，
      // executeRecap 会把这个错带出队列（不是超时放弃）。
      throw new Error('手册写入失败：磁盘满了');
    },
  },
  workingDirectory: { ensure: async () => ROOT },
  inject: () => {},
};

plugin.apply(ctx, {
  playbookPath: file,
  autoReflect: true,
  reflectProvider: '',
  reflectModel: '',
  maxEntries: 100,
  autoRecap: true,
  autoRecapThreshold: Number(process.env.ROLL_THRESHOLD || 1),
  autoRecapCooldownTurns: 0,
  autoReviewInbox: false,
});

const agent = {
  id: 'roll-agent',
  session: {
    header: { origin: 'cli' },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '改点东西' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    ],
  },
  options: { provider: 'p', model: 'm' },
  phase: 'idle',
  async runMaintenance(job) { return await job(new AbortController().signal); },
  async whenIdle() {},
  followup: (message) => notices.push(message),
};

const handlers = [];
const ctx2 = { ...ctx, on: (event, handler) => handlers.push({ event, handler }) };
plugin.apply(ctx2, {
  playbookPath: file,
  autoReflect: true,
  reflectProvider: '',
  reflectModel: '',
  maxEntries: 100,
  autoRecap: true,
  autoRecapThreshold: Number(process.env.ROLL_THRESHOLD || 1),
  autoRecapCooldownTurns: 0,
  autoReviewInbox: false,
});

const emit = (event, ...args) => { for (const h of handlers.filter((x) => x.event === event)) h.handler(...args); };

// 回合 N：N 次 mutating 调用 → 回合边界 → 空闲边缘触发复盘。
const runTurn = (turn, mutating) => {
  for (let i = 0; i < mutating; i += 1) emit('tools/result', { name: 'write', agent }, { isError: false });
  emit('agent/turn-stopping', { agent, turn });
  emit('agent/status', { agent, status: 'idle' });
};

runTurn(2, Number(process.env.ROLL_MUTATING || 1));

// 等复盘真的失败（队列的失败分支跑完），否则断言会早于回滚发生。
const deadline = Date.now() + Number(process.env.ROLL_WAIT_MS || 4000);
while (Date.now() < deadline) {
  const failed = logs.info.some((m) => m.includes('复盘失败'))
    || logs.warn.some((m) => m.includes('复盘失败'))
    || logs.info.some((m) => m.includes('复盘结束'));
  if (failed && reflectCalls >= 1) break;
  await new Promise((r) => setTimeout(r, 10));
}

// 再跑一个回合，看它是否还能触发复盘（计数被还回来 ⇒ 能；被吞 ⇒ 要重新攒满）。
runTurn(3, 1);
await new Promise((r) => setTimeout(r, 300));

console.log(JSON.stringify({
  logs,
  notices: notices.map((n) => (n && n.content ? n.content : n)),
  reflectCalls,
}, null, 2));
`;

const DRIVER_PATH = path.join(ROOT, 'driver.mjs');
fs.writeFileSync(DRIVER_PATH, DRIVER, 'utf8');

function runDriver(extraEnv) {
  const res = spawnSync(process.execPath, [DRIVER_PATH], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ROLL_ROOT: ROOT,
      ROLL_LIB: path.join(HERE, '..', 'lib', 'index.js'),
      ROLL_THRESHOLD: '1',
      ROLL_MUTATING: '1',
      ROLL_WAIT_MS: '4000',
      ...extraEnv,
    },
  });
  if (res.status !== 0) {
    throw new Error('驱动子进程失败: ' + res.status + '\n' + res.stdout + '\n' + res.stderr);
  }
  const text = res.stdout;
  const start = text.indexOf('{\n  "logs"');
  assert.ok(start >= 0, '驱动输出里找不到结果 JSON：\n' + text);
  return JSON.parse(text.slice(start));
}

test('第39轮缺陷2｜队列内真失败后 mutating 计数被还回（threshold=1 也能看到差别）', () => {
  const out = runDriver({});
  const all = out.logs.info.concat(out.logs.warn);
  // 复盘真的失败过（不是压根没跑）。
  assert.ok(out.reflectCalls >= 1, '一次复盘都没跑，用例没测到真路径');
  assert.ok(all.some((m) => m.includes('复盘失败')), '没有看到复盘失败日志：\n' + all.join('\n'));
  // 真失败通知用户（失败那条文案，不是放弃那条）。
  const noticeText = JSON.stringify(out.notices);
  assert.ok(noticeText.includes('ACE 自动复盘未完成'), '失败后没有通知用户：' + noticeText);
  assert.ok(noticeText.includes('磁盘满了'), '通知要带失败原因：' + noticeText);
  // 最锐利的差别在**记账数**：修复前失败那一次 mutating 被吞，第 3 回合的待办
  // 只记 1 次；修复后 onFailed 把计数还回 st.mutCount，第 3 回合记 1+1=2 次。
  // （exp/acct.mjs 场景 1 vs 场景 2 实测 mutCount 0 vs 1 的端到端形态。）
  assert.ok(all.some((m) => m.includes('回合 3 记账 2 次 mutating 调用')),
    '第 3 回合应记 2 次（失败那一次被还回），实际：\n' + all.join('\n'));
  // 并且第 3 回合真的又跑了一次复盘（不是只记账不触发）。
  assert.ok(out.reflectCalls >= 2, '回滚后第 3 回合应再次触发复盘（reflectCalls=' + out.reflectCalls + '）');
});

test('第39轮缺陷2｜threshold=3：失败吞掉计数 ⇒ 要重新攒满 3 次才能再触发', () => {
  // exp/acct2.mjs 的实测形态：threshold=3 时，失败那一次计数被吞，
  // 之后的回合得重新攒满 3 次。修复后 onFailed 把计数还回，只要再攒 2 次即可。
  const out = runDriver({ ROLL_THRESHOLD: '3', ROLL_MUTATING: '3', ROLL_WAIT_MS: '5000' });
  const all = out.logs.info.concat(out.logs.warn);
  assert.ok(out.reflectCalls >= 1, '一次复盘都没跑，用例没测到真路径');
  assert.ok(all.some((m) => m.includes('复盘失败')), '没有看到复盘失败日志：\n' + all.join('\n'));
  // 3 次 mutating 已够阈值，失败后计数被还回 ⇒ 下一个回合再来 1 次就再触发。
  // 这里只断言「再触发过」，具体次数由日志说明。
  assert.ok(out.reflectCalls >= 2,
    'threshold=3 且已攒满 3 次：失败回滚后应只需再攒 1 次即可再触发（reflectCalls=' + out.reflectCalls + '）\n' + all.join('\n'));
});

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});
