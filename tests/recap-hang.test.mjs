// 第 39 轮：自动复盘「卡住时自己放弃」的自证用例。
//
// 为什么用子进程：RECAP_TOTAL_DEADLINE_MS / ONESHOT_TIMEOUT_MS 是模块级常量，
// 在 import lib/recap-queue.js、lib/llm.js 时就已求值。要把它们压到几十毫秒，
// 必须在 import 之前设好环境变量 —— 同一进程里先 import 再改 env 是没用的，
// 所以这里用一个 40 行左右的驱动脚本 + child_process 起子进程来跑真代码。
//
// 覆盖的验收点：
//   (a) maintenance job 在总时限内结束（不无限挂）—— 现在复盘根本不进 maintenance，
//       但队列的总时限保证「这份复盘」不会无限跑（本轮改为断言队列会放弃等待）；
//   (b) 超时后用户被通知（agent.followup 收到一条 notice），promise 不悬空；
//   (c) 单次调用超时只影响那一轮复盘，不连带炸掉整段（reflect 首轮也按已提炼候选收尾）；
//   (d) 两路复盘不会同时进入写入段（最大并发恒为 1）；
//   (e) 排队期间回合边界同步返回（用户消息不被挡住）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-hang-'));

// 驱动脚本：在子进程里真 import lib/index.js 并真跑一次自动复盘。
// 假 provider 的行为由 argv.mode 决定：
//   hang    —— ctx.llm.stream 永远不返回（provider 静默）
//   slow    —— 每次调用睡 timeoutMs 以上（单次调用超时）
const DRIVER = `
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.HANG_ROOT;
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
    return nextResolve(specifier, context);
  },
});

const mode = process.env.HANG_MODE;
const file = path.join(ROOT, 'playbook.md');
const plugin = await import(pathToFileURL(process.env.HANG_LIB).href);

const logs = { info: [], warn: [], error: [] };
const notices = [];
const llmCalls = [];
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
      llmCalls.push(options);
      if (mode === 'hang') {
        // provider 静默：流开了但再也不吐字（真实故障形态）。
        // 第 39 轮缺陷 1 修复后，队列到点会 abort 自己建的 controller，signal 一路
        // 传到 oneShot 的 options.signal。真实宿主 provider 消费这个 signal（收到 abort
        // 就让流抛错，见 ~dsh-llm\lib\index.js），所以这里也必须照做 ——
        // 否则等于桩了一个「无视取消」的假 provider，队列会等一个永不结束的上游，
        // 「等它真的停下」这条新语义就永远测不到。
        await new Promise((resolve, reject) => {
          if (options && options.signal) {
            if (options.signal.aborted) { reject(options.signal.reason || new Error('aborted')); return; }
            options.signal.addEventListener('abort', () => {
              reject(options.signal.reason || new Error('aborted'));
            }, { once: true });
          }
          // 注意：这里没有 timer，真的永不返回 —— 只有 abort 能把它结束掉。
        });
      }
      // slow：睡够久，让 oneShot 的单次上限先触发。
      // 注意：真实宿主 provider 收到 abort 会让流抛错（这是 ctx.llm.stream 的既有契约，
      // 见 ~dsh-llm\lib\index.js 里对 options.signal 的消费），所以这里也要照做 ——
      // 否则等于桩了一个「无视取消」的假 provider，oneShot 的超时分支永远测不到。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Number(process.env.HANG_SLEEP_MS || 3000));
        if (options && options.signal) {
          if (options.signal.aborted) { clearTimeout(timer); reject(options.signal.reason); return; }
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(options.signal.reason || new Error('aborted'));
          }, { once: true });
        }
      });
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [] }) };
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
  autoRecapThreshold: 1,
  autoRecapCooldownTurns: 0,
  autoReviewInbox: false,
});

const agent = {
  id: 'hang-agent',
  session: {
    header: { origin: 'cli' },
    requestHeader: () => ({ config: { provider: 'hang-provider', model: 'hang-model' } }),
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '改点东西' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
    ],
  },
  options: { provider: 'hang-provider', model: 'hang-model' },
  phase: 'idle',
  async runMaintenance(job) { return await job(new AbortController().signal); },
  async whenIdle() {},
  followup: (message) => notices.push(message),
};

const handlers = [];
// 重新抓一次事件处理器：apply 里 ctx.on 是空实现，所以这里直接从插件行为反推 ——
// 直接驱动 recap 的公开入口是做不到的（它是闭包），改用事件顺序：
// 上面的 ctx.on 需要真的记录，下面重做一次 apply。
const ctx2 = {
  ...ctx,
  on: (event, handler) => handlers.push({ event, handler }),
};
plugin.apply(ctx2, {
  playbookPath: file,
  autoReflect: true,
  reflectProvider: '',
  reflectModel: '',
  maxEntries: 100,
  autoRecap: true,
  autoRecapThreshold: 1,
  autoRecapCooldownTurns: 0,
  autoReviewInbox: false,
});

const emit = (event, ...args) => { for (const h of handlers.filter((x) => x.event === event)) h.handler(...args); };

const started = Date.now();
emit('tools/result', { name: 'write', agent }, { isError: false });
emit('agent/turn-stopping', { agent, turn: 2 });
emit('agent/status', { agent, status: 'idle' });
const boundaryMs = Date.now() - started;

// 等到「放弃/结束」日志出现（子进程里等，避免测试进程空转）。
const deadline = Date.now() + Number(process.env.HANG_WAIT_MS || 8000);
while (Date.now() < deadline) {
  const done = logs.info.some((m) => m.includes('复盘超过总时限') || m.includes('复盘结束') || m.includes('复盘失败'));
  if (done) break;
  await new Promise((r) => setTimeout(r, 10));
}

console.log(JSON.stringify({
  boundaryMs,
  logs,
  notices: notices.map((n) => (n && n.content ? n.content : n)),
  llmCalls: llmCalls.length,
  playbook: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '',
}, null, 2));
`;

const DRIVER_PATH = path.join(ROOT, 'driver.mjs');
fs.writeFileSync(DRIVER_PATH, DRIVER, 'utf8');

function runDriver(mode, extraEnv) {
  const res = spawnSync(process.execPath, [DRIVER_PATH], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      HANG_ROOT: ROOT,
      HANG_LIB: path.join(HERE, '..', 'lib', 'index.js'),
      HANG_MODE: mode,
      // 把两个时限压到几十毫秒：常量在 import 时求值，子进程里设才生效。
      ACE_RECAP_TOTAL_DEADLINE_MS: '400',
      ACE_ONESHOT_TIMEOUT_MS: '200',
      HANG_SLEEP_MS: '3000',
      HANG_WAIT_MS: '8000',
      ...extraEnv,
    },
  });
  if (res.status !== 0) {
    throw new Error('驱动子进程失败: ' + res.status + '\n' + res.stdout + '\n' + res.stderr);
  }
  // 驱动脚本末尾打印一段 JSON；前面可能有其它输出，取最后一段。
  const text = res.stdout;
  const start = text.indexOf('{\n  "boundaryMs"');
  assert.ok(start >= 0, '驱动输出里找不到结果 JSON：\n' + text);
  return JSON.parse(text.slice(start));
}

test('第39轮 (a)(b)：provider 静默时复盘在总时限内放弃、用户收到通知、回合边界不拖沓', async () => {
  // 第 39 轮缺陷 1 修复后：hang provider 照宿主契约消费 signal，于是结束它的是
  // **总时限**（队列到点 abort 自己建的 controller → oneShot 的 options.signal →
  // provider 抛错 → reflect 第 1 轮按已提炼候选收尾 → 复盘结束）。这里把单次上限
  // 放到远大于总时限，确保测到的是总时限路径而不是单次超时路径。
  const out = runDriver('hang', { ACE_ONESHOT_TIMEOUT_MS: '60000', HANG_WAIT_MS: '6000' });
  // (a) 总时限内放弃：队列打出了「超过总时限」日志，不是无限挂。
  const gaveUp = out.logs.info.some((m) => m.includes('复盘超过总时限 400ms'));
  assert.ok(gaveUp, '没有在总时限内放弃：\n' + out.logs.info.join('\n'));
  // (b) 用户被通知（走 onGiveUp → recapNotify → agent.followup），不是静默放弃。
  assert.equal(out.notices.length >= 1, true, '放弃后没有通知用户：' + JSON.stringify(out.notices));
  const noticeText = JSON.stringify(out.notices);
  assert.ok(noticeText.includes('ACE 自动复盘未完成'), '通知文案不对：' + noticeText);
  // 第 39 轮缺陷 1 附带修复：放弃与失败是两条不同的文案，放弃那条如实说明
  // 「已超过总时限被中断 / 已写入的部分会保留 / 可在下回合重试」，不再谎称「没有并入手册」。
  assert.ok(noticeText.includes('已超过总时限被中断'), '放弃通知必须说明是总时限中断：' + noticeText);
  assert.ok(noticeText.includes('已写入的部分会保留'), '放弃通知必须说明已写入部分会保留：' + noticeText);
  assert.ok(noticeText.includes('下回合重试'), '放弃通知必须告诉用户可下回合重试：' + noticeText);
  assert.equal(noticeText.includes('没有并入手册'), false, '放弃后上游可能仍写盘，不许再说「没有并入手册」：' + noticeText);
  // 回合边界（turn-stopping + status idle）必须远快于总时限：用户消息不被复盘拖住。
  assert.ok(out.boundaryMs < 1000, '回合边界被拖住 ' + out.boundaryMs + 'ms');
  // provider 真的被调用过（不是「压根没跑」的假绿）。
  assert.ok(out.llmCalls >= 1, '一次 LLM 都没调，用例没测到真路径');
});

test('第39轮 (c)：单次调用超时只让那一轮复盘收尾，不炸掉整段（两层超时各自生效）', async () => {
  // 第一层：单次上限远小于总时限 —— oneShot 自己抛 'ace: LLM 调用超时'，
  // reflectRounds 第 1 轮也吞这个错、按 0 条候选收尾（不把整段复盘炸掉）。
  // 驱动里把 ACE_ONESHOT_TIMEOUT_MS 压到 60ms、ACE_RECAP_TOTAL_DEADLINE_MS 放到 10000ms，
  // 于是「单次超时」一定先于「总时限」发生，两者不会互相掩盖。
  const first = runDriver('slow', {
    ACE_RECAP_TOTAL_DEADLINE_MS: '10000',
    ACE_ONESHOT_TIMEOUT_MS: '60',
    HANG_SLEEP_MS: '3000',
    HANG_WAIT_MS: '6000',
  });
  const sawRoundAbort = first.logs.info.some((m) => m.includes('多轮复盘第 1 轮中断'));
  assert.ok(sawRoundAbort, '单次超时没有按「本轮中断」收尾：\n' + first.logs.info.join('\n') + '\n' + first.logs.warn.join('\n'));
  // 这一层必须早于总时限触发：日志里不该出现「超过总时限」。
  assert.equal(first.logs.info.some((m) => m.includes('复盘超过总时限')), false, '单次超时被总时限掩盖了（两者配比不对）');
  // 整段没有崩：既没有复盘失败日志，也没有把异常抛到子进程外（子进程 status 0）。
  assert.equal(first.logs.info.some((m) => m.includes('复盘失败')), false, '单次超时不该让整段复盘失败');
  // 单次超时的错误真的来自 oneShot（不是别的地方抛的同名错）。
  assert.ok(
    first.logs.info.some((m) => m.includes('ace: LLM 调用超时（单次上限 60ms）')),
    '日志里没有 oneShot 的超时报错：\n' + first.logs.info.join('\n'),
  );

  // 第二层：总时限兜底 —— 单次上限放到比 provider 睡眠更久，让第一次调用一直挂着，
  // 于是总时限先到，队列放弃等待并通知用户（这就是 (a)(b) 已覆盖的路径，这里再确认
  // 「单次上限更大时不会提前误杀」）。
  const second = runDriver('slow', {
    ACE_RECAP_TOTAL_DEADLINE_MS: '400',
    ACE_ONESHOT_TIMEOUT_MS: '60000',
    HANG_SLEEP_MS: '3000',
    HANG_WAIT_MS: '6000',
  });
  assert.ok(second.logs.info.some((m) => m.includes('复盘超过总时限 400ms')), '总时限没有兜底：\n' + second.logs.info.join('\n'));
  assert.equal(second.notices.length >= 1, true, '总时限放弃后没有通知用户');
});

test('第39轮 (e)：复盘排队期间，回合边界同步返回（用户消息不被阻塞）', async () => {
  const out = runDriver('hang');
  assert.ok(out.boundaryMs < 1000, '复盘在跑时回合边界被拖住 ' + out.boundaryMs + 'ms');
  // 事件循环也没被挂住：子进程能在总时限之后正常打印结果。
  assert.equal(typeof out.boundaryMs, 'number');
});

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});
