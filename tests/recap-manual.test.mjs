// 第 40 轮缺陷 5 / 缺陷 6：手动 /ace 复盘改走插件自有队列之后的行为。
//
// 缺陷 5 的原症状：`/ace` 与 ace_curate 走宿主 agent.runMaintenance(job)
// （~\@deepseek-ai\dsh-agent-loop\lib\index.js:822-845），维护相位期间用户新消息只会被
// 同文件 :854-858 的 wakeDriver 记成 wakeRequested，必须等 job 返回才被拉起 ——
// 「发消息没反应」。本文件钉住两件事：手动复盘期间宿主维护相位一次都没被占用、
// 而且宿主真的在忙时 /ace 会如实回「agent 正在忙」而不是硬占相位。
//
// 缺陷 6：队列满额会把最旧的一份 shift() 掉，之前没有任何人被告知。修法是让 enqueue
// 带上 merge 回调（合并分支终于可达）+ 丢弃时走 form==='notice' 通道发一次性通知。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-recap-manual-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
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
    ' return { ...input, role: \'user\', id: \'msg-\' + Math.random().toString(36).slice(2) };' +
    ' }',
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const plugin = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href);
const { serializePlaybook, withExclusiveLock, writeFileAtomic } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'playbook.js')).href
);

function configDefaults() {
  return {
    playbookPath: '',
    autoReflect: true,
    reflectProvider: '',
    reflectModel: '',
    maxEntries: 100,
    evictProtectDays: 14,
    injectTokenBudget: 900,
    injectMaxEntries: 5,
    autoRecap: true,
    autoRecapThreshold: 1,
    autoRecapCooldownTurns: 0,
    autoReviewInbox: false,
  };
}

async function writePlaybook(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, { timeout = 5000, interval = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return true;
    await sleep(interval);
  }
  assert.fail('超时未满足：' + label);
}

/**
 * 假宿主 + 假 LLM。
 * `gate` 为真时 LLM 流会先停 `gateMs` 毫秒 —— 用来把「一份复盘正在跑」这个窗口撑开。
 */
function makeHost({ playbookPath, config = {}, gateMs = 0, script = () => [] }) {
  const record = {
    tools: [],
    sections: [],
    handlers: [],
    commands: [],
    injected: [],
    llmCalls: [],
    logs: { info: [], warn: [], error: [] },
    gateLetThrough: null,
    gateOpen: false,
  };
  const gate = gateMs > 0
    ? { promise: new Promise((resolve) => { record.gateLetThrough = resolve; }) }
    : null;
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
    llm: {
      async *stream(options) {
        const index = record.llmCalls.length;
        record.llmCalls.push(options);
        if (gate && !record.gateOpen) {
          await gate.promise;
        }
        const batch = typeof script === 'function' ? script(index) : script[index] ?? [];
        const text = typeof batch === 'string' ? batch : JSON.stringify({ candidates: batch, notes: 'recap-manual' });
        yield { type: 'text-delta', index: 0, text };
      },
    },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, { ...configDefaults(), playbookPath, ...config });
  return { ctx, record, gate };
}

/**
 * 假 agent。`runMaintenance` 是**探针**：进入就记一次、并把 phase 置成宿主里的
 * 'maintenance'（~@deepseek-aidsh-agent-looplibindex.js:822-845 是这么做的），
 * finally 再回 'idle'。缺陷 5 修好之后它一次都不该被调用。
 */
function makeAgent() {
  const notices = [];
  const agent = {
    notices,
    maintenanceCalls: 0,
    phasesSeen: [],
    session: {
      header: { origin: 'cli' },
      requestHeader: () => ({ config: { provider: 'manual-provider', model: 'manual-model' } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '把 lib/foo.js 的导出改成 bar' }] },
        { role: 'assistant', content: [{ type: 'text', text: '先读一遍再改。' }, { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"path":"lib/foo.js"}' }] },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '写入成功' }] },
      ],
    },
    options: { provider: 'manual-provider', model: 'manual-model' },
    phase: 'idle',
    async runMaintenance(job) {
      agent.maintenanceCalls += 1;
      agent.phase = 'maintenance';
      agent.phasesSeen.push('maintenance');
      try {
        return await job(new AbortController().signal);
      } finally {
        agent.phase = 'idle';
        agent.phasesSeen.push('idle');
      }
    },
    async whenIdle() {},
    followup: (message) => notices.push(message),
  };
  return agent;
}

function emit(host, event, ...args) {
  const hits = host.record.handlers.filter((h) => h.event === event);
  assert.ok(hits.length > 0, '插件没有注册事件 ' + event);
  for (const h of hits) h.handler(...args);
}

const aceCommand = (host) => {
  const command = host.record.commands.find((c) => c.name === 'ace');
  assert.ok(command, '插件没有注册 /ace 命令');
  return command;
};

const isNotice = (message) => message && message.source && message.source.form === 'notice';
const noticeText = (message) => (message.content || []).map((b) => b.text).join('');
const logHas = (record, needle) => record.logs.info.some((line) => line.includes(needle));

const CANDIDATE = (title) => ({
  title,
  condition: '要验证手动 /ace 复盘链路时',
  action: '跑一次 /ace，再看手册是否落盘',
  rationale: '手动复盘与自动复盘共用同一条队列，谁也不该占宿主的维护相位',
});

const playbookAt = async (name) => {
  const playbookPath = path.join(ROOT, name, 'playbook.md');
  await writePlaybook(playbookPath, []);
  return playbookPath;
};

const startedCount = (record) => record.logs.info.filter((line) => line.includes('复盘开始（agent ')).length;
const finishedCount = (record) => record.logs.info.filter((line) => line.includes('复盘结束（agent ')).length;
const lineHas = (record, needle) => record.logs.info.some((line) => line.includes(needle));

/** 一个回合：mutating 工具结果 → turn-stopping → status idle（自动复盘的实际触发序列）。 */
async function runTurn(host, agent, turn) {
  emit(host, 'tools/result', { name: 'write', agent }, { isError: false });
  emit(host, 'agent/turn-stopping', { agent, turn });
  emit(host, 'agent/status', { agent, status: 'idle' });
  await sleep(60);
}

test('缺陷5｜手动 /ace 复盘走插件自有队列：整段没进宿主的维护相位', async () => {
  const playbookPath = await playbookAt('case-manual-plain');
  const host = makeHost({ playbookPath, script: () => [CANDIDATE('手动复盘产出的经验要落盘')] });
  const agent = makeAgent();
  const result = await aceCommand(host).handler({ agent, rawInput: '' });

  assert.equal(result.kind, 'success', '手动复盘应当成功返回：' + JSON.stringify(result));
  assert.match(result.text, /复盘完成/);

  // 缺陷 5 的核心断言：宿主维护相位一次都没被占用。
  // 旧实现走 agent.runMaintenance(job)，进去后宿主 phase.kind==='maintenance'，
  // 期间用户新消息只会被 latch 成 wakeRequested（宿主 ~@deepseek-ai/dsh-agent-loop/lib/index.js:822-845 / :854-858）
  // —— 这就是「发消息没反应」。修完后这条路径压根不碰宿主相位。
  assert.equal(agent.maintenanceCalls, 0, '手动复盘不许调用宿主 agent.runMaintenance');
  assert.deepEqual(agent.phasesSeen, [], '宿主相位不该经历 maintenance');
  assert.equal(agent.phase, 'idle');

  // 走的是插件自己的串行队列（日志能指出这一点）
  assert.ok(logHas(host.record, '复盘开始（agent '), '手动复盘应当由 recapQueue.drain() 执行');
  assert.ok(logHas(host.record, '复盘结束（agent '));
});

test('缺陷5｜一份手动复盘正在跑时，第二条 /ace 如实回「正在忙」，也不去抢宿主相位', async () => {
  const playbookPath = await playbookAt('case-manual-busy');
  const host = makeHost({ playbookPath, gateMs: 5000, script: () => [CANDIDATE('忙的时候别硬插队')] });
  const agent = makeAgent();
  const command = aceCommand(host);

  const first = command.handler({ agent, rawInput: '' });
  await waitFor(() => startedCount(host.record) >= 1, '第一份手动复盘进入队列并开始跑');

  const second = await command.handler({ agent, rawInput: '' });
  assert.equal(second.kind, 'error', '队列在跑时第二条应当被挡下：' + JSON.stringify(second));
  assert.match(second.text, /agent 正在忙/);
  assert.equal(agent.maintenanceCalls, 0, '被挡下的那条更不该去占宿主维护相位');
  assert.deepEqual(agent.phasesSeen, []);

  host.record.gateOpen = true;
  host.record.gateLetThrough();
  const firstResult = await first;
  assert.equal(firstResult.kind, 'success', '放行后第一份照常完成：' + JSON.stringify(firstResult));
  await waitFor(() => finishedCount(host.record) >= 1, '第一份复盘收尾');
  assert.equal(agent.maintenanceCalls, 0);
});

test('缺陷6｜队列里已有待跑项时，新回合的第一份并进去（合并分支在生产里真的可达）', async () => {
  const playbookPath = await playbookAt('case-merge');
  const host = makeHost({ playbookPath, gateMs: 5000, script: () => [CANDIDATE('排队时合并而不是排长队')] });
  const agent = makeAgent();

  const first = aceCommand(host).handler({ agent, rawInput: '' });
  await waitFor(() => startedCount(host.record) >= 1, '第一份复盘开始跑');

  await runTurn(host, agent, 2); // 入队（队列为空 ⇒ push）
  await runTurn(host, agent, 3); // 队列里已有待跑项 ⇒ 合并分支

  assert.ok(
    lineHas(host.record, '复盘排队——新回合的复盘并进已在排队的那一份'),
    '合并分支必须真的被走到（缺陷 6 之前 enqueue 不传 merge，这条日志在生产里永远不出现）',
  );
  assert.ok(lineHas(host.record, '队列长度保持'));
  assert.equal(lineHas(host.record, '复盘排队已满'), false, '能合并的时候不该丢经验');

  host.record.gateOpen = true;
  host.record.gateLetThrough();
  await first;
  await waitFor(() => finishedCount(host.record) >= 2, '手册跑空（手动 + 合并件）');
});

test('缺陷6｜队列真满额时丢掉最旧一份，并如实发一条 notice 告诉用户经验丢了、可下回合重试', async () => {
  const playbookPath = await playbookAt('case-drop');
  const host = makeHost({ playbookPath, gateMs: 5000, script: () => [CANDIDATE('队列满额不能静默丢经验')] });
  const agent = makeAgent();

  const first = aceCommand(host).handler({ agent, rawInput: '' });
  await waitFor(() => startedCount(host.record) >= 1, '第一份复盘开始跑');

  // 一份在跑、队列上限 2：回合 2 入队、回合 3 合并进去、回合 4 入队、回合 5 合并进去、
  // 回合 6 无处可并 ⇒ 丢掉队列里最旧的那一份（回合 2 的合并件）
  for (const turn of [2, 3, 4, 5, 6]) await runTurn(host, agent, turn);

  assert.ok(
    lineHas(host.record, '复盘排队已满'),
    '满额丢弃必须真的发生（没有 mergedOnce 上限时这条分支是死代码）',
  );

  const dropped = agent.notices.filter(isNotice).find((m) => noticeText(m).includes('已丢弃一轮经验'));
  assert.ok(dropped, '丢弃必须发 notice，用户得知道自己刚沉淀的经验被丢了：' + JSON.stringify(agent.notices));
  assert.match(noticeText(dropped), /这份经验这次没有并入手册/);
  assert.match(noticeText(dropped), /下一次回合结束时会重新判定/);
  assert.match(dropped.source.summary, /可下回合重试/);

  host.record.gateOpen = true;
  host.record.gateLetThrough();
  await first;
  await waitFor(() => finishedCount(host.record) >= 2, '队列跑空');
});

test.after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

