// 第 40 轮 R1：注入链路的「handler 到底有没有被调用 / 为什么没产出」可观测性。
//
// 背景（任务书 m00001）：经验注入在 2026-10-26T14:03:02.375Z 之后全库再没发生过一次
// （1563 个会话里真注入只有 57 次）。检索/选型/去重/投递四层纯函数与装配面都已确认正常，
// 于是失效只剩三种可能：① handler 根本没被调用；② handler 被门槛早退；③ IIFE 抛错进了 catch。
// 在这之前没有任何计数能区分这三者 —— 本用例集断言的就是那套计数（injectionStats 的
// handled / earlyReturn 分桶 / failures / deliveries）在每种情形下都如实增长。
//
// 桩的边界（红线）：只桩宿主包 + 假 agent / 假 ctx / 假事件流；
// inject / inject-delivery / injection-flow / playbook / commit / recap-pipeline 一律真跑。
// 手册与设置全部落在 os.tmpdir() 的临时目录，绝不碰用户的真实手册。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-injectobs-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// 必须在 import lib/index.js **之前**钉住：设置文件与共享手册都按这两个变量解析。
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

// —— 三个宿主包的最小桩（data: URL，不落盘）——
const STUBS = {
  '@deepseek-ai/schemastery':
    'const chain = () => { const f = (v) => f; f.description = () => f; f.default = () => f; f.optional = () => f; return f; };' +
    'export default { string: () => chain(), boolean: () => chain(), number: () => chain(), object: () => chain() };',
  '@deepseek-ai/dsh-tools': 'export function defineTool(options) { return options; }',
  // 第 40 轮 R5：宿主 createUserMessage 加一个**盘外开关**。
  // 投递层「经验造不出来」这条失败路径（lib/inject-delivery.js:159-167 的 catch）
  // 在真实形状下无法靠喂畸形 decision 触发（messages 有数组防御），
  // 这是唯一能确定性复现它的手段，且只在用例期间打开。
  '@deepseek-ai/dsh-llm':
    'export function createUserMessage(input) {' +
    ' if (globalThis.__ACE_CREATE_USER_MESSAGE_BOOM__) throw new Error(\'宿主拒绝构造用户消息\');' +
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

/** 一条手册条目（形状与 lib/playbook.js 的 parsePlaybook 一致，落盘走真序列化器）。 */
function entryBlock({ id, title, condition, action, rationale = '', created = '2020-01-01', hits = 0 }) {
  return {
    id,
    title,
    condition,
    action,
    rationale,
    meta: { created, updated: created, hits, lastHit: '' },
    extraLines: [],
  };
}

/** 手册里放一条与 QUERY 高度相关的经验，保证 selectInjection 选得出东西。 */
function baseEntry() {
  return entryBlock({
    id: 'ace-001',
    title: '改代码前先跑基线测试',
    condition: '每次改动之前',
    action: '先跑一遍基线测试确认现状',
  });
}

const QUERY = '先跑一遍基线测试';

async function writePlaybook(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

/**
 * 配置项的默认值（照 lib/index.js:118-133 的 Config 声明抄）。
 * 不读 plugin.Config.fields：schemastery 用的是 data: URL 桩，fields 拿不到默认值。
 */
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

/** 假宿主 + 假 LLM（script 按「第几次 LLM 调用」返回候选数组，0 基）。 */
function makeHost({ playbookPath, script = () => [], config = {} }) {
  const record = {
    tools: [],
    sections: [],
    handlers: [],
    commands: [],
    injected: [],
    llmCalls: [],
    logs: { info: [], warn: [], error: [] },
  };
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
        const batch = typeof script === 'function' ? script(index) : script[index] ?? [];
        const text = typeof batch === 'string' ? batch : JSON.stringify({ candidates: batch, notes: 'injectobs' });
        yield { type: 'text-delta', index: 0, text };
      },
    },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, { ...configDefaults(), playbookPath, ...config });
  return { ctx, record };
}

/** 假 agent（主代理：session.header.origin === 'cli'）。 */
function makeAgent(origin = 'cli') {
  const notices = [];
  return {
    notices,
    session: {
      header: { origin },
      requestHeader: () => ({ config: { provider: 'obs-provider', model: 'obs-model' } }),
      deriveMessages: () => [],
    },
    options: { provider: 'obs-provider', model: 'obs-model' },
    phase: 'idle',
    async runMaintenance(job) { return await job(new AbortController().signal); },
    async whenIdle() {},
    followup: (message) => notices.push(message),
  };
}

function emit(host, event, ...args) {
  const hits = host.record.handlers.filter((h) => h.event === event);
  assert.ok(hits.length > 0, '插件没有注册事件 ' + event);
  for (const h of hits) h.handler(...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, { timeout = 4000, interval = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    // 预检索跑在 IIFE 里（lib/index.js:824 起的 void (async () => ...)），
    // 判定必须允许异步探针，否则等不到它落账就往下走。
    if (await predicate()) return true;
    await sleep(interval);
  }
  assert.fail('超时未满足：' + label);
}

/** 读 GET /api/dsh-ace/stats 的 injection 块（真打插件自己注册的那条路由）。 */
function statsRoute(host) {
  const mount = host.record.injected.find((i) => i.deps.includes('webServer'));
  assert.ok(mount, '插件没有注入 webServer（设置页数据源缺失）');
  const routes = [];
  mount.callback({ webServer: { register: (r) => routes.push(r) }, effect: (fn) => fn(), logger: host.ctx.logger });
  const route = routes.find((r) => r.path === '/api/dsh-ace');
  assert.ok(route, '插件没有注册 /api/dsh-ace 路由');
  return route;
}

async function callStats(route) {
  const req = { method: 'GET', url: '/api/dsh-ace/stats', headers: { host: '127.0.0.1:3080' }, on: () => {}, destroy: () => {} };
  let body = '';
  const res = {
    writeHead() {},
    end(chunk) { body = chunk === undefined ? '' : String(chunk); },
  };
  await route.handler(req, res);
  return JSON.parse(body);
}

const injectionOf = async (route) => (await callStats(route)).injection;

const userMessage = (text, id) => ({ id, role: 'user', content: [{ type: 'text', text }] });

/** 造一条宿主 inbox 插入的 user 消息（真实事件形制）。 */
const sendInbox = (host, agent, text, id) => emit(host, 'agent/inbox/inserted', { agent, message: userMessage(text, id) });

const ENTER = () => ({
  kind: 'enter',
  messages: [{ id: 'prior-1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  startsRequestSeries: true,
});

/** 走真实 agent/pre-step waterfall（next 返回宿主自己的决策）。 */
async function runPreStepWith(host, agent, decision) {
  const hits = host.record.handlers.filter((h) => h.event === 'agent/pre-step');
  assert.ok(hits.length > 0, '插件没有注册 agent/pre-step（注入无处投递）');
  let value = decision;
  for (const h of hits) value = await h.handler({ agent, messages: [], turn: 1, step: 1, signal: { throwIfAborted() {} } }, async () => decision);
  return value;
}

const isNotice = (message) => message && message.source && message.source.form === 'notice';
const noticeText = (message) => (message.content || []).map((b) => b.text).join('');

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

test('R1｜预检索 handler 的每一道早退门各自进桶（noAgent / notUser / noQuery / cacheHit），handled 只数「进过 handler」', async () => {
  const playbookPath = path.join(ROOT, 'case-buckets', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  assert.equal((await injectionOf(route)).handled, 0, '还没触发任何事件，handled 必须是 0');

  // ① 载荷里没有 agent：事件到了 handler，但进 noAgent 桶。
  emit(host, 'agent/inbox/inserted', {});
  // ② 插入的不是 user 消息（assistant 的）→ notUser。
  emit(host, 'agent/inbox/inserted', { agent, message: { id: 'msg-assistant', role: 'assistant', content: [{ type: 'text', text: QUERY }] } });
  // ③ user 消息但没有文本（只有图片块）→ noQuery。
  emit(host, 'agent/inbox/inserted', { agent, message: { id: 'msg-image', role: 'user', content: [{ type: 'image', url: 'x' }] } });

  let stats = await injectionOf(route);
  assert.equal(stats.handled, 3, '三次事件都进了 handler');
  assert.deepEqual(
    { noAgent: stats.earlyReturn.noAgent, notUser: stats.earlyReturn.notUser, noQuery: stats.earlyReturn.noQuery },
    { noAgent: 1, notUser: 1, noQuery: 1 },
  );
  assert.equal(stats.batches, 0, '三次早退一条经验都没发出去');

  // ④ 一条真能选出经验的问法：这次不该早退，batches 涨到 1。
  sendInbox(host, agent, QUERY, 'msg-real-1');
  await waitFor(async () => (await injectionOf(route)).batches === 1, '第一次真检索产出批次');
  assert.equal((await injectionOf(route)).handled, 4);

  // ⑤ 同一条消息再来一遍（同样 id）→ 命中缓存，进 cacheHit 桶，绝不重复检索。
  sendInbox(host, agent, QUERY, 'msg-real-1');
  stats = await injectionOf(route);
  assert.equal(stats.earlyReturn.cacheHit, 1, '重复消息走缓存早退');
  assert.equal(stats.batches, 1, '缓存命中不会产生第二个批次');
  assert.equal(stats.handled, 5, '早退也算 handler 被调用过');
});

test('R1｜自动复盘与自动反思都关掉时：handled 照数，但每一条都进 flagsOff，batches 恒为 0，且 stalled 必须为假（第 42 轮中-1 改口径）', async () => {
  const playbookPath = path.join(ROOT, 'case-flags-off', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath, config: { autoRecap: false, autoReflect: false } });
  const route = statsRoute(host);
  const agent = makeAgent();

  for (let i = 1; i <= 3; i += 1) sendInbox(host, agent, QUERY, 'msg-off-' + i);
  await sleep(60);

  const stats = await injectionOf(route);
  assert.equal(stats.handled, 3);
  assert.equal(stats.earlyReturn.flagsOff, 3, '两条自动开关都关着时，每一次都该进 flagsOff');
  assert.equal(stats.batches, 0);
  // 第 42 轮中-1 改口径。原断言（第 40 轮写的）：
  //   assert.equal(stats.stalled, true, '进了 handler 但一个批次都没有 = 链路无产出（这就是判据）');
  // 为什么它是错的：stalled 的判据只看了「handled > 0 && batches === 0」，而这一场里 batches 恒为 0
  // 的唯一原因是**用户自己在设置里关掉了自动复盘与自动反思**——每次事件都在 flagsOff 那一行早退，
  // 一次预检索都没发生。同一条 handler 分支（lib/index.js:882）对 flagsOff 早退的处理是**不**计数
  // （stall.noProduce 保持 0），于是同一份 /stats 数据自相矛盾：stall.noProduce 说一切正常，
  // 并列的 stalled 却说链路无产出。真正的「链路无产出」必须排除 flagsOff（handled > flagsOff），
  // 否则最会把排障的人带偏的正是这个布尔——他关掉自动功能就会看到 stalled=true。
  //
  // 第 43 轮改口径表述：这不代表两个字段「同口径」。stalled 的准确语义是「**链路自进程启动以来
  // 从未成功产出过任何批次**」，按 agent 的连续失败归 R5 的 stall.noProduce + notice 管；
  // 两者允许不同向（见本文件末尾「第 43 轮 B」那条用例：先成功发过一批、随后连错 5 次 ⇒
  // stalled=false 而 stall.noProduce=5）。这里 flagsOff 全占时不算 stalled，是因为那种「没产出」
  // 的原因是「没开」，不是「链路失效」。
  assert.equal(stats.stalled, false, '全部早退都是 flagsOff（用户的合法选择）⇒ 原因在「没开」而不是「链路没工作过」，不算 stalled');
  assert.equal(stats.stall.noProduce, 0, '同一份统计里的 stall.noProduce 已经说「没人在连错」，stalled 不许反着说');
});

test('R1｜预检索 IIFE 抛错进 catch 时 failures.prerecall 增长，仍算 handled（区分「没调用」与「调用后炸了」）', async () => {
  // 手册路径指向一个**目录**：readPlaybookSnapshot 读到 EISDIR 会抛（ENOENT 才算空手册），
  // 正好落进 lib/index.js 预检索 IIFE 的 catch。
  const dirAsFile = path.join(ROOT, 'case-prerecall-throws', 'ace', 'playbook.md');
  fs.mkdirSync(dirAsFile, { recursive: true });
  const host = makeHost({ playbookPath: dirAsFile });
  const route = statsRoute(host);
  const agent = makeAgent();

  sendInbox(host, agent, QUERY, 'msg-boom-1');
  await waitFor(async () => (await injectionOf(route)).failures.prerecall === 1, '预检索抛错被记账');

  const stats = await injectionOf(route);
  assert.equal(stats.handled, 1, 'handler 确实被调用了');
  assert.equal(stats.batches, 0);
  assert.equal(stats.failed, 1, 'failed 与 failures.prerecall 同步增长');
  assert.equal(stats.stall.noProduce, 1, '抛错也算「这一轮没产出」');
  assert.ok(
    host.record.logs.warn.some((line) => line.startsWith('dsh-ace: 注入的预检索失败，本回合不注入')),
    '静默 catch 必须留下一条 warn（不许无声无息）',
  );
});

test('R1｜挑不出候选：早退进 noAgentPicked、skipped 与 failures.empty 各自 +1，且缓存下一条同消息不再重跑', async () => {
  const playbookPath = path.join(ROOT, 'case-empty-pick', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  // 与手册完全不沾边的问法 → selectInjection 选不出东西。
  sendInbox(host, agent, 'zzz qqq vvv', 'msg-nopick-1');
  await waitFor(async () => (await injectionOf(route)).failures.empty === 1, '挑不出候选被记账');

  let stats = await injectionOf(route);
  assert.equal(stats.handled, 1);
  assert.equal(stats.skipped, 1, 'skipped 记「这一轮没东西可投」');
  assert.equal(stats.earlyReturn.noAgentPicked, 1);
  assert.equal(stats.batches, 0);

  // 同一条消息再插一次：已被缓存成空批次，走 cacheHit，不再重跑检索。
  sendInbox(host, agent, 'zzz qqq vvv', 'msg-nopick-1');
  stats = await injectionOf(route);
  assert.equal(stats.earlyReturn.cacheHit, 1);
  assert.equal(stats.failures.empty, 1, '缓存命中不会重复记一次「挑不出候选」');
});

test('R1｜投递接缝真把经验追加进历史后：deliveries +1、batches 保持、undelivered 为假', async () => {
  const playbookPath = path.join(ROOT, 'case-delivered', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  let stats = await injectionOf(route);
  assert.equal(stats.deliveries, 0);

  sendInbox(host, agent, QUERY, 'msg-deliver-1');
  await waitFor(async () => (await injectionOf(route)).batches === 1, '先有批次');

  const decision = await runPreStepWith(host, agent, ENTER());
  const injected = decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace');
  assert.equal(injected.length, 1, '经验真被追加进了历史');
  assert.match(noticeText(injected[0]), /\[ace-001\]/, '追加的正文带着被注入条目的 id');

  stats = await injectionOf(route);
  assert.equal(stats.deliveries, 1, 'deliveries 记「真的投递成功」');
  assert.equal(stats.batches, 1, '投递不改变批次数');
  assert.equal(stats.appended, 1);
  assert.equal(stats.undelivered, false, '有批次也有投递 ⇒ undelivered 为假');
});

test('R1｜投递接缝的早退门同样进桶：notEnter / noAgent / subAgent / noAgentPicked，且一个都不算投递', async () => {
  const playbookPath = path.join(ROOT, 'case-prestep-easy-exits', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  // ① 宿主决策不是 enter（reject）→ notEnter。
  await runPreStepWith(host, agent, { kind: 'reject', messages: [] });
  // ② 载荷里没有 agent → noAgent。
  const preStep = host.record.handlers.find((h) => h.event === 'agent/pre-step').handler;
  await preStep({ messages: [] }, async () => ENTER());
  // ③ 子代理 → subAgent（不注入）。
  const sub = makeAgent('subagent');
  await runPreStepWith(host, sub, ENTER());
  // ④ 主代理但没有待投递批次 → noAgentPicked。
  await runPreStepWith(host, agent, ENTER());

  const stats = await injectionOf(route);
  assert.equal(stats.earlyReturn.notEnter, 1);
  assert.equal(stats.earlyReturn.noAgent, 1);
  assert.equal(stats.earlyReturn.subAgent, 1);
  assert.equal(stats.earlyReturn.noAgentPicked, 1);
  assert.equal(stats.deliveries, 0, '早退一律不算投递');
  assert.equal(stats.failed, 0, '早退不是失败，不该记进 failed');
});

test('R5｜连续 5 次「进了 handler 但没产出」→ turn-stopping 发一次性 notice，随后计数清零（不刷屏）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-noproduce', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  for (let i = 1; i <= 5; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv ' + i, 'msg-stall-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, '第 ' + i + ' 次无产出被记账');
  }
  assert.equal(agent.notices.length, 0, '还没到 turn-stopping，一条通知都不该出现');

  emit(host, 'agent/turn-stopping', { agent, turn: 9 });

  const notices = agent.notices.filter(isNotice);
  assert.equal(notices.length, 1, '连续 5 次无产出 → 且只发一条一次性通知');
  assert.match(noticeText(notices[0]), /ACE 注入链路可能已失效/);
  assert.match(noticeText(notices[0]), /连续 5 次/);
  assert.ok(
    host.record.logs.warn.some((line) => line.startsWith('dsh-ace: 注入链路自检——连续 5 次预检索无产出')),
    '一次性通知同时留一行 dsh-ace warn（红线 9：可观测只走内存 + 一行日志）',
  );
  const after = await injectionOf(route);
  assert.equal(after.stall.noProduce, 0, '发完通知立刻清零，避免刷屏');

  // 之后只再来 2 次，达不到门槛 → 绝不补发。
  for (let i = 6; i <= 7; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv ' + i, 'msg-stall-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i - 5, '再来第 ' + i + ' 次');
  }
  emit(host, 'agent/turn-stopping', { agent, turn: 10 });
  assert.equal(agent.notices.filter(isNotice).length, 1, '没到门槛时不许重复通知');
});

test('R5｜连续 5 次「发布了批次但一次都没投递成功」→ turn-stopping 另发一条 notice（投递层失效）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-delivery', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  // 投递层「造不出用户消息」是盘上唯一能确定性触发的失败：宿主 createUserMessage 抛错
  // ⇒ lib/inject-delivery.js:159-167 的 catch（failed + failures.deliver + stall.deliverySilent）。
  globalThis.__ACE_CREATE_USER_MESSAGE_BOOM__ = true;
  try {
    for (let i = 1; i <= 5; i += 1) {
      sendInbox(host, agent, QUERY, 'msg-silent-' + i);
      await waitFor(async () => (await injectionOf(route)).batches === i, '第 ' + i + ' 个批次已发布');
      const decision = await runPreStepWith(host, agent, ENTER());
      assert.equal(decision.messages.length, ENTER().messages.length, '投递失败时历史原样返回，不中断回合');    }
  } finally {
    globalThis.__ACE_CREATE_USER_MESSAGE_BOOM__ = false;
  }

  let stats = await injectionOf(route);
  assert.equal(stats.deliveries, 0, '一次都没投递成功');
  assert.equal(stats.failures.deliver, 5);
  assert.equal(stats.stall.deliverySilent, 5);
  assert.equal(stats.undelivered, true, '有批次、零投递 ⇒ undelivered 判据成立');

  emit(host, 'agent/turn-stopping', { agent, turn: 9 });

  const notices = agent.notices.filter(isNotice);
  assert.equal(notices.length, 1);
  assert.match(noticeText(notices[0]), /投递层失败/);
  assert.match(noticeText(notices[0]), /连续 5 次/);
  stats = await injectionOf(route);
  assert.equal(stats.stall.deliverySilent, 0);
});


// —— 第 41 轮（审计风险 2 / 3 / 4 / 5）：下面这六条用例是为「改回旧写法必须变红」而写的 ——
// 审计的变异实验 M5（删 preSteps += 1）、M7（flagsOff 也计 noProduce）、M8（删「有产出就清零」）
// 当时全都不会变红，等于这三行代码没有任何测试钉着；跨 agent 串账（PROBE-D）、「接缝到了但下游炸了」
// 与「接缝没到」在计数上同形、没有时间戳，都是线上排障时会把方向带偏的缺口。

test('R1（第 41 轮）｜投递接缝是否被宿主调用：preSteps 单独可读；下游抛错时接缝仍算「到过」，错误原样上抛', async () => {
  const playbookPath = path.join(ROOT, 'case-presteps-next', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  let stats = await injectionOf(route);
  assert.equal(stats.preSteps, 0, '还没触发任何 pre-step，preSteps 必须是 0');
  assert.equal(stats.handled, 0);

  // ① 正常的一次 pre-step：接缝被宿主调用了一次（即便这一步没投递出去）。
  await runPreStepWith(host, agent, ENTER());
  stats = await injectionOf(route);
  assert.equal(stats.preSteps, 1, 'preSteps 就是「投递接缝有没有被宿主调用」的判据（删掉这行没有任何别的数会变）');
  assert.equal(stats.earlyReturn.noAgentPicked, 1, '这一步是早退，但它照样证明接缝通了');
  assert.equal(stats.failures.next, 0);

  // ② 接缝到了、但**下游** pre-step 监听器在 next() 里抛错。改前 await next() 在 try 之外，
  //    这种情形与「接缝根本没到」在统计上完全同形（两边都是 0），排障时无从区分。
  const preStep = host.record.handlers.find((h) => h.event === 'agent/pre-step').handler;
  await assert.rejects(
    () => preStep({ agent, messages: [], turn: 1, step: 1 }, async () => { throw new Error('下游炸了'); }),
    /下游炸了/,
    '下游的错误必须原样上抛：吞掉宿主的错误是另一类事故，不归本插件管',
  );

  stats = await injectionOf(route);
  assert.equal(stats.preSteps, 2, '下游抛错也证明接缝到过（计数器在 await 之前就 +1）');
  assert.equal(stats.failures.next, 1, 'failures.next 单开一桶记「接缝到了但下游炸了」');
  assert.equal(stats.earlyReturn.downstreamThrew, 1, '配对的 earlyReturn.by.downstreamThrew');
  assert.equal(stats.failed, 0, '下游抛错**不是**注入失败，不许记进 failed（否则「投递层坏了」会被误判）');
  assert.equal(stats.deliveries, 0);
  assert.ok(
    host.record.logs.warn.some((line) => line.startsWith('dsh-ace: 注入接缝已到达，但下游 pre-step 监听器抛错')),
    '这种情形必须留一行 dsh-ace warn，否则线上只能看到一个空白的接缝',
  );
});

test('R1（第 41 轮）｜时间戳：lastPublishAt 记「最后一次发布批次」，lastDeliveryAt 记「最后一次真的追加进历史」', async () => {
  const playbookPath = path.join(ROOT, 'case-timestamps', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();
  const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

  let stats = await injectionOf(route);
  assert.equal(stats.lastPublishAt, '', '本进程还没发布过任何批次');
  assert.equal(stats.lastDeliveryAt, '', '本进程还没成功投递过任何一批');

  sendInbox(host, agent, QUERY, 'msg-stamp-1');
  await waitFor(async () => (await injectionOf(route)).batches === 1, '批次已发布');

  stats = await injectionOf(route);
  // 只有累计数时回答不了「注入是从几点几分开始停的」—— 这正是当初排查「注入停发」时最缺的信息。
  assert.match(stats.lastPublishAt, STAMP_RE, '毫秒精度本地 ISO（lib/timestamp.js 的 nowStamp）');
  assert.equal(stats.lastDeliveryAt, '', '发布了不等于投递了：两个时间戳必须能各自说话');

  await runPreStepWith(host, agent, ENTER());
  stats = await injectionOf(route);
  assert.equal(stats.deliveries, 1);
  assert.match(stats.lastDeliveryAt, STAMP_RE, '真的追加进历史才写 lastDeliveryAt');
  assert.ok(stats.lastDeliveryAt >= stats.lastPublishAt, '按字典序即时间序：投递不可能早于发布');
});

test('R5（第 41 轮）｜连续计数按 agent 分表：A 错 3 次 + B 错 2 次，谁都不该收到「连续 5 次」通知', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-per-agent', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agentA = makeAgent();
  const agentB = makeAgent();

  for (let i = 1; i <= 3; i += 1) {
    sendInbox(host, agentA, 'zzz qqq vvv a' + i, 'msg-a-' + i);
    await waitFor(async () => (await injectionOf(route)).handled === i, 'A 第 ' + i + ' 次');
  }
  for (let i = 1; i <= 2; i += 1) {
    sendInbox(host, agentB, 'zzz qqq vvv b' + i, 'msg-b-' + i);
    await waitFor(async () => (await injectionOf(route)).handled === 3 + i, 'B 第 ' + i + ' 次');
  }
  await waitFor(async () => (await injectionOf(route)).failures.empty === 5, '两边的「挑不出候选」都落账了');

  // 改前这两个数是同一本账（进程级全局），合起来 = 5 ⇒ A 收尾时会收到「连续 5 次」的通知，
  // 而 A 自己只错了 3 次（审计 PROBE-D 实测到的现象）。
  let stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 3, '报的是「最接近门槛的那个 agent」自己的连续数，不是合账');
  assert.equal(stats.stall.agents, 2, '两个 agent 各有一本账');

  emit(host, 'agent/turn-stopping', { agent: agentA, turn: 9 });
  emit(host, 'agent/turn-stopping', { agent: agentB, turn: 10 });

  assert.equal(agentA.notices.filter(isNotice).length, 0, 'A 只错了 3 次，不许被 B 的账推过门槛');
  assert.equal(agentB.notices.filter(isNotice).length, 0, 'B 只错了 2 次，同理');
  stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 3, '没到门槛就不该清零（清零等于把证据擦掉）');

  // 反证：A 自己再错 2 次、凑够自己的 5 次，这时才该收到通知 —— 说明这条分支并没有被整体关掉。
  for (let i = 4; i <= 5; i += 1) {
    sendInbox(host, agentA, 'zzz qqq vvv a' + i, 'msg-a-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'A 第 ' + i + ' 次');
  }
  emit(host, 'agent/turn-stopping', { agent: agentA, turn: 11 });
  assert.equal(agentA.notices.filter(isNotice).length, 1, 'A 自己的账攒到 5 次，照旧发一次性通知');
  assert.equal(agentB.notices.filter(isNotice).length, 0, 'B 依然不受影响');
});

test('R5（第 41 轮）｜用户在设置里关掉自动功能时（flagsOff 早退）绝不计入 noProduce：那不是链路失效', async () => {
  const playbookPath = path.join(ROOT, 'case-flagsoff-not-stall', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath, config: { autoRecap: false, autoReflect: false } });
  const route = statsRoute(host);
  const agent = makeAgent();

  for (let i = 1; i <= 6; i += 1) sendInbox(host, agent, QUERY, 'msg-off-stall-' + i);
  await waitFor(async () => (await injectionOf(route)).handled === 6, '六次事件都进了 handler');

  const stats = await injectionOf(route);
  assert.equal(stats.earlyReturn.flagsOff, 6, '六次都被「自动功能已关」挡在门外');
  // 改前这里每一次都让 noProduce +1 ⇒ 关掉自动功能的用户必然收到「注入链路可能已失效」的误报
  // （审计 PROBE-1 与变异实验 M7）。早退是**用户的合法选择**，不是失效证据。
  assert.equal(stats.stall.noProduce, 0, 'flagsOff 一次都不许记进「连续无产出」');
  assert.equal(stats.batches, 0);

  emit(host, 'agent/turn-stopping', { agent, turn: 9 });
  assert.equal(agent.notices.filter(isNotice).length, 0, '关掉自动功能不该招来任何「可能已失效」的通知');
});

test('R5（第 41 轮）｜「有产出就清零」：中间成功投递过一批，之前的连续无产出账必须归零（自检只看连续次数）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-reset', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  for (let i = 1; i <= 3; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv r' + i, 'msg-reset-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, '第 ' + i + ' 次无产出');
  }

  // 一批真的挑出来了（并且真的追加进了历史）—— 链路是通的，之前那笔连续账作废。
  sendInbox(host, agent, QUERY, 'msg-reset-ok');
  await waitFor(async () => (await injectionOf(route)).batches === 1, '一批被发布');
  const decision = await runPreStepWith(host, agent, ENTER());
  assert.equal(
    decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace').length,
    1,
    '这一批真的追加进了历史',
  );

  let stats = await injectionOf(route);
  assert.equal(stats.deliveries, 1);
  assert.equal(stats.stall.noProduce, 0, '自检看的是**连续**次数：成功一次就归零（删掉清零这行会让下面多出一条误报）');

  // 之后只再来 2 次无产出：论「累计」3 + 2 = 5 正好凑够，但「连续」只有 2 ⇒ 不许发通知。
  for (let i = 1; i <= 2; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv r' + (3 + i), 'msg-reset-' + (3 + i));
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, '清零后再来第 ' + i + ' 次');
  }
  emit(host, 'agent/turn-stopping', { agent, turn: 9 });
  assert.equal(agent.notices.filter(isNotice).length, 0, '累计数凑够 5 但连续数只有 2 ⇒ 不许误报');
  stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 2, '清零之后从 0 重新数，不继承之前那 3 次');
});

test('R5（第 41 轮）｜通知文案与实现相符：说「连续 N 次预检索」（不是「用户消息」），并说明「关掉自动功能属正常」', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-wording', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  for (let i = 1; i <= 5; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv w' + i, 'msg-wording-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, '第 ' + i + ' 次无产出');
  }
  emit(host, 'agent/turn-stopping', { agent, turn: 9 });

  const notices = agent.notices.filter(isNotice);
  assert.equal(notices.length, 1);
  const text = noticeText(notices[0]);
  assert.match(text, /连续 5 次预检索/, '计数单位是**预检索次数**（一个回合可能走好几次），不是用户消息数');
  assert.doesNotMatch(text, /用户消息/, '旧文案的「连续 N 次用户消息」会把排障的人往回合数上带（审计 PROBE-3b）');
  assert.match(text, /你在设置里关掉了注入 \/ 自动复盘/, '用户合法关掉自动功能时必然命中这条自检，文案必须给出这条正常解释');
});

// —— 第 42 轮：中-1 / 中-2 / 高-2 的口径守护 ——
//
// 中-1：stalled 的口径要排除「用户自己关了自动功能」（见上面 :273 那条改过的用例）。
//       第 43 轮更正：stalled 与 R5 的 stall.noProduce **不是**同一个口径 —— 前者答「链路自启动起
//       有没有工作过」，后者答「这个 agent 是不是在连续失败」，两者允许不同向。
// 中-2：R5 的「按 agent 分表」不许建立在「宿主两个事件传同一个 agent 对象引用」这个未声明契约上
//       （审计 PB4 实测：换成另一个包装对象后 stall.agents = 2、notices = 0，即每个事件一本新账、
//        「连续 N 次」永远攒不满、R5 完全失效且无任何告警）。
// 高-2：计数表装满时不许无差别淘汰最早入表者（审计 PB3b 实测 agents=200 notices=0）。
// 第 43 轮 A：第 42 轮那版「优先丢计数值全是 0 的条目、真找不到才丢最早入表者」**不够** ——
//            表里一条零值账都没有时，最早入表且已连错 4 次的那本照样被丢（第 43 轮审计实测
//            notices=0，与 PB3b 终态完全一致）。现在改成**按计分升序**挑受害者
//            （计分 = noProduce + deliverySilent；同分丢最早入表者，绝不随机）：零值账天然先走，
//            被丢的恒是「最不接近门槛的那本」。下面 A① 是审计反例转绿，A② 守住既有行为不退化，
//            A③/A④ 钉住同分兜底与 warn 点名的内容。

// 与 lib/index.js 的 STALL_AGENT_CAP 对齐（有界内存的硬上限；改上限必须同步这里）。
const STALL_AGENT_CAP = 200;
// 测试桩 makeAgent() 没有 id（退化路径必需）；这个变体给它一个非空字符串 id（真宿主的 Agent 恒有 id，
// 见 @deepseek-ai/dsh-agent/lib/types/types.d.ts 的 `readonly id: SessionId`）。
const agentWithId = (id, origin = 'cli') => ({ ...makeAgent(origin), id });

/**
 * 第 43 轮 A 的用例公用：灌 count 本「各自连错 1 次」的账（每本 noProduce=1）。
 * 走的是真生产路径 —— 消息与手册零字面交集 ⇒ 挑不出候选 ⇒ failures.empty +1、
 * earlyReturn.noAgentPicked +1、该 agent 自己的 noProduce +1（lib/index.js:996-1006）。
 * 每个 agent 都带非空 id，所以 warn 点名的标签是可断言的短名。
 */
function spamNoProduceAgents(host, count, label) {
  const agents = [];
  for (let i = 0; i < count; i += 1) {
    const agent = agentWithId('session-r43-' + label + '-' + i);
    agents.push(agent);
    sendInbox(host, agent, 'zzz qqq vvv', 'msg-' + label + '-' + i);
  }
  return agents;
}

test('R1（第 42 轮中-1）｜口径收紧后，真·无产出仍然是 stalled=true（早退里没有一条是 flagsOff）', async () => {
  const playbookPath = path.join(ROOT, 'case-stalled-still-true', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  sendInbox(host, agent, 'zzz qqq vvv 1', 'msg-st-1');
  await waitFor(async () => (await injectionOf(route)).handled === 1, '第 1 次');
  sendInbox(host, agent, 'zzz qqq vvv 2', 'msg-st-2');
  await waitFor(async () => (await injectionOf(route)).failures.empty === 2, '第二次也挑不出候选');

  const stats = await injectionOf(route);
  assert.equal(stats.earlyReturn.flagsOff, 0, '这一场自动功能是开着的：没有一条因 flagsOff 早退');
  assert.equal(stats.earlyReturn.noAgentPicked, 2, '两次都走完了预检索、只是挑不出候选');
  assert.equal(stats.batches, 0);
  // 收紧口径不许把真信号一起关掉：这里 handled(2) > flagsOff(0)，是真·进了 handler 却没产出。
  assert.equal(stats.stalled, true, 'handled > flagsOff ⇒ 真的是「进了 handler 却没产出」，stalled 必须仍为 true');
  assert.equal(stats.stall.noProduce, 2, '与同一份统计里的自检数一致（两者不许互相打架）');
});

test('R5（第 42 轮中-2）｜连续计数按稳定 id 分表：两个不同的 agent 对象、同一个 id 共享同一本账', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-id-key', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);

  // 审计 PB4：宿主若按事件新建包装对象（对象身份不同、id 相同），以对象为键时每个事件都开一本新账。
  const sessionId = 'session-pb4';
  const wrapperA = agentWithId(sessionId);
  const wrapperB = agentWithId(sessionId);

  for (let i = 1; i <= 3; i += 1) {
    sendInbox(host, wrapperA, 'zzz qqq vvv i' + i, 'msg-id-a-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'wrapperA 第 ' + i + ' 次');
  }
  let stats = await injectionOf(route);
  assert.equal(stats.stall.agents, 1, '同一个 id 只占一本账（以对象为键的旧写法在这里是 2）');

  // 换一个**新的包装对象**接着错：只要 id 一致就必须是同一本账。
  for (let i = 4; i <= 5; i += 1) {
    sendInbox(host, wrapperB, 'zzz qqq vvv i' + i, 'msg-id-b-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'wrapperB 接着数第 ' + i + ' 次');
  }
  stats = await injectionOf(route);
  assert.equal(stats.stall.agents, 1, '换了包装对象也还是同一本账');
  assert.equal(stats.stall.noProduce, 5, '两个对象合起来攒满 5 次（旧写法各 3 / 2 次，永远到不了门槛）');

  emit(host, 'agent/turn-stopping', { agent: wrapperB, turn: 9 });
  assert.equal(
    wrapperB.notices.filter(isNotice).length,
    1,
    '第 5 次必须报警——这正是旧写法会静默漏掉的那一条（审计 PB4 实测 notices=0）',
  );
  assert.equal(wrapperA.notices.filter(isNotice).length, 0, '通知只发给当前事件里那个对象，不会凭空复制');
});

test('R5（第 42 轮中-2）｜没有 id 的 agent 退回对象身份：两个对象各一本账（测试桩没有 id，退化是必需的）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-no-id', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const a = makeAgent();
  const b = makeAgent();

  for (let i = 1; i <= 2; i += 1) {
    sendInbox(host, a, 'zzz qqq vvv na' + i, 'msg-na-' + i);
    await waitFor(async () => (await injectionOf(route)).handled === i, 'A 第 ' + i + ' 次');
  }
  for (let i = 1; i <= 2; i += 1) {
    sendInbox(host, b, 'zzz qqq vvv nb' + i, 'msg-nb-' + i);
    await waitFor(async () => (await injectionOf(route)).handled === 2 + i, 'B 第 ' + i + ' 次');
  }
  await waitFor(async () => (await injectionOf(route)).failures.empty === 4, '四次无产出都落账');

  const stats = await injectionOf(route);
  assert.equal(stats.stall.agents, 2, '两个没有 id 的对象各自一本账（对象身份兜底，不会被 id 前缀误并）');
  assert.equal(stats.stall.noProduce, 2, '报的是最接近门槛的那本账（各自 2 次，不是合起来 4 次）');
});

test('R5（第 43 轮 A②）｜有零值账（成功产出过的安静账）时先丢零值账：正在连错的 agent 继续失败照样报警（既有行为不退化）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-cap-recycle', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const victim = makeAgent();

  // ① 最早入表的那本账正在连错 4 次（差一次就该报警）。
  for (let i = 1; i <= 4; i += 1) {
    sendInbox(host, victim, 'zzz qqq vvv v' + i, 'msg-v-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'victim 第 ' + i + ' 次');
  }
  // ② 灌满计数表：这 200 个 agent 各自**成功产出一批**（计数为 0 的安静账）。
  for (let i = 0; i < STALL_AGENT_CAP; i += 1) sendInbox(host, makeAgent(), QUERY, 'msg-fill-' + i);
  await waitFor(
    async () => (await injectionOf(route)).batches === STALL_AGENT_CAP,
    STALL_AGENT_CAP + ' 个安静账都产出了',
    { timeout: 30000 },
  );
  await waitFor(
    async () => (await injectionOf(route)).stall.agents === STALL_AGENT_CAP,
    '计数表恰好顶在上限（有界内存没被突破）',
    { timeout: 30000 },
  );

  // ③ 关键：victim 的账还在 —— 计分 4 不是全表最小（那 200 本成功产出的账计分是 0），
  //    所以被回收的必然是零值账，victim 的连续数一次都不该动（旧写法「无差别丢最早入表者」会先挤掉它）。
  let stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 4, 'victim 的连续数没被清零（计分最小的零值账先走）');

  // ④ 它自己的第 5 次失败仍要报警。
  sendInbox(host, victim, 'zzz qqq vvv v5', 'msg-v-5');
  await waitFor(async () => (await injectionOf(route)).stall.noProduce === 5, 'victim 第 5 次');
  emit(host, 'agent/turn-stopping', { agent: victim, turn: 9 });
  assert.equal(
    victim.notices.filter(isNotice).length,
    1,
    '旧写法（无差别丢最早入表者）在这里是 0 条：账被挤掉后新账从 1 开始，第 5 次失败一条通知都没有（审计 PB3b）',
  );
  stats = await injectionOf(route);
  assert.equal(stats.stall.agents, STALL_AGENT_CAP, '表仍然有界');
  assert.equal(
    host.record.logs.warn.filter((m) => m.includes('计数表已满')).length,
    0,
    '表里一直有零值条目可回收 ⇒ 一条账都不该丢，也就不该有「被迫丢账」的 warn：' + JSON.stringify(host.record.logs.warn),
  );
});

test('R5（第 43 轮 A①）｜表里一条零值账都没有时，连错最多的那本**不许**被丢（第 42 轮审计反例转绿）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-cap-keep-worst', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);

  // 连错最多的那本：4 次（全表其他账都只错 1 次，计分 1）。它同时是**最早入表**的一本 ——
  // 第 42 轮那版「优先丢计分值全是 0 的账、找不到零值账才丢最早入表者」会第一个把它挤掉：
  // 第 43 轮审计实测新账从 0 重新数、第 5 次失败 notices = 0，与 PB3b 终态完全一致，
  // 只是触发条件从「装满 200 本账」收窄成「装满 200 本非零账」。
  const kvictim = agentWithId('session-r43-a1-kvictim');
  for (let i = 1; i <= 4; i += 1) {
    sendInbox(host, kvictim, 'zzz qqq vvv k' + i, 'msg-a1-k' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'kvictim 第 ' + i + ' 次');
  }
  // 灌满：216 本**非零**账（各连错 1 次、计分 1），一条零值账都没有 ⇒ 必然要丢非零账。
  spamNoProduceAgents(host, 196, 'a1q');
  spamNoProduceAgents(host, 20, 'a1z');
  await waitFor(
    async () => (await injectionOf(route)).earlyReturn.noAgentPicked === 4 + 216,
    '216 本账都落账了',
    { timeout: 60000 },
  );
  await waitFor(
    async () => (await injectionOf(route)).stall.agents === STALL_AGENT_CAP,
    '计数表恰好顶在上限（有界内存没被突破）',
    { timeout: 60000 },
  );

  let stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 4, '计分 4 是全表**最大**的一本 ⇒ 计分升序淘汰绝不该碰它（旧写法这里已经是 0）');
  assert.equal(stats.stall.agents, STALL_AGENT_CAP, '有界内存不变（上限仍是 200）');

  const lost = host.record.logs.warn.filter((m) => m.includes('计数表已满'));
  assert.ok(lost.length >= 1, '丢的每一本非零账都要留一行 warn：' + JSON.stringify(host.record.logs.warn));
  assert.ok(
    lost.every((m) => !m.includes('session-r43-a1-kvictim')),
    '连错最多的那本从头到尾不该出现在「被迫丢账」的 warn 里（旧写法第一条就是它）：' + JSON.stringify(lost),
  );
  assert.ok(
    lost.every((m) => m.includes('noProduce=1')),
    '被丢的只能是计分 1 的那些账（全表最小的计分）：' + JSON.stringify(lost.slice(0, 3)),
  );

  // 它自己的第 5 次失败照常接着数（宿主换了个包装对象、id 相同 ⇒ 还是同一本账）。
  sendInbox(host, agentWithId('session-r43-a1-kvictim'), 'zzz qqq vvv k5', 'msg-a1-k5');
  await waitFor(async () => (await injectionOf(route)).stall.noProduce === 5, 'kvictim 第 5 次');
  stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 5, '账没被清零 ⇒ 接着数到门槛（旧写法这里是 1，永远攒不满）');
  assert.equal(stats.stall.agents, STALL_AGENT_CAP, '表仍然有界');
});

test('R5（第 43 轮 A③）｜计分相同时丢最早入表者（Map 插入序 ⇒ 确定，绝不随机）', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-cap-tie', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);

  // 先入表的两本账，各自连错 1 次（计分都是 1）。它们**确认落账之后**才灌其余的账，
  // 所以在 Map 的插入序里稳稳排在最前两位 —— 全表计分并列时，受害者必须是更早入表的那一本。
  const firstIn = agentWithId('session-r43-a3-first');
  const secondIn = agentWithId('session-r43-a3-second');
  sendInbox(host, firstIn, 'zzz qqq vvv t1', 'msg-a3-t1');
  await waitFor(async () => (await injectionOf(route)).stall.agents === 1, 'first 落账');
  sendInbox(host, secondIn, 'zzz qqq vvv t2', 'msg-a3-t2');
  await waitFor(async () => (await injectionOf(route)).stall.agents === 2, 'second 落账（两本账都在）');

  // 灌到恰好满额（2 + 198 = 200），再多灌一本触发唯一一次淘汰：全表计分全是 1。
  spamNoProduceAgents(host, STALL_AGENT_CAP - 2, 'a3r');
  await waitFor(
    async () => (await injectionOf(route)).earlyReturn.noAgentPicked === 2 + (STALL_AGENT_CAP - 2),
    '灌到恰好满额',
    { timeout: 60000 },
  );
  await waitFor(
    async () => (await injectionOf(route)).stall.agents === STALL_AGENT_CAP,
    '计数表恰好顶在上限',
    { timeout: 60000 },
  );
  sendInbox(host, agentWithId('session-r43-a3-trigger'), 'zzz qqq vvv t3', 'msg-a3-t3');
  await waitFor(
    async () => (await injectionOf(route)).earlyReturn.noAgentPicked === 1 + 1 + (STALL_AGENT_CAP - 2) + 1,
    '触发淘汰的那一次也数完了',
    { timeout: 60000 },
  );

  const lost = host.record.logs.warn.filter((m) => m.includes('计数表已满'));
  assert.equal(lost.length, 1, '只超了 1 本 ⇒ 恰好淘汰 1 次：' + JSON.stringify(lost));
  assert.ok(
    lost[0].includes('session-r43-a3-first'),
    '计分并列时必须丢**最早入表**的那本（strict < 而不是 <=）：' + lost[0],
  );
  assert.ok(
    !lost[0].includes('session-r43-a3-second'),
    '并列的后到者不许被越过：' + lost[0],
  );
  assert.equal((await injectionOf(route)).stall.agents, STALL_AGENT_CAP, '表仍然有界');
});

test('R5（第 43 轮 A④）｜被丢的非零账确实留一行 warn：点名是它、计数是它自己的、后果说清', async () => {
  const playbookPath = path.join(ROOT, 'case-stall-cap-warn', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);

  // 一本计分 4 的账（**不**该被丢）打头，再入一本计分 1 的账当受害者 —— 后者必须是自己
  // 的计数（1）进 warn，而不是全表最大值（4）：这证明 warn 读的是被丢那本账自己的字段。
  const big = agentWithId('session-r43-a4-big');
  for (let i = 1; i <= 4; i += 1) {
    sendInbox(host, big, 'zzz qqq vvv b' + i, 'msg-a4-b' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, 'big 第 ' + i + ' 次');
  }
  const victim = agentWithId('session-r43-a4-victim');
  sendInbox(host, victim, 'zzz qqq vvv v1', 'msg-a4-v1');
  await waitFor(async () => (await injectionOf(route)).stall.agents === 2, '受害者落账');

  spamNoProduceAgents(host, STALL_AGENT_CAP - 2, 'a4r');
  await waitFor(
    async () => (await injectionOf(route)).earlyReturn.noAgentPicked === 4 + 1 + (STALL_AGENT_CAP - 2),
    '灌到恰好满额',
    { timeout: 60000 },
  );
  await waitFor(
    async () => (await injectionOf(route)).stall.agents === STALL_AGENT_CAP,
    '计数表恰好顶在上限',
    { timeout: 60000 },
  );
  sendInbox(host, agentWithId('session-r43-a4-trigger'), 'zzz qqq vvv t1', 'msg-a4-t1');
  await waitFor(
    async () => (await injectionOf(route)).earlyReturn.noAgentPicked === 4 + 1 + (STALL_AGENT_CAP - 2) + 1,
    '触发淘汰的那一次也数完了',
    { timeout: 60000 },
  );

  const lost = host.record.logs.warn.filter((m) => m.includes('计数表已满'));
  assert.equal(lost.length, 1, '只超了 1 本 ⇒ 恰好淘汰 1 次：' + JSON.stringify(lost));
  assert.ok(
    lost[0].startsWith('dsh-ace: 注入自检的 agent 计数表已满（上限 ' + STALL_AGENT_CAP + ' 个），被迫丢掉 agent '),
    'warn 必须是「计数表已满 + 被迫丢掉 agent …」这条既有文案：' + lost[0],
  );
  assert.ok(lost[0].includes('session-r43-a4-victim'), '必须点名丢了**哪个** agent：' + lost[0]);
  assert.ok(
    lost[0].includes('noProduce=1 / deliverySilent=0'),
    '必须报出那本账**自己**当时的计数（1），而不是全表最大值（4）：' + lost[0],
  );
  assert.ok(!lost[0].includes('noProduce=4'), '不许张冠李戴把别的账的计数写进去：' + lost[0]);
  assert.ok(lost[0].includes('重新数到 5 次'), '必须说清后果：该 agent 之后的连续失败要重新数到门槛才会报警');
  assert.ok(!lost[0].includes('session-r43-a4-big'), '计分 4 那本不该被丢：' + lost[0]);
});

test('R5（第 43 轮 B）｜stalled 与 stall.noProduce 允许不同向：先成功发布一批、随后连续 5 次无产出 ⇒ stalled=false 而 noProduce=5', async () => {
  const playbookPath = path.join(ROOT, 'case-stalled-vs-noproduce', 'ace', 'playbook.md');
  await writePlaybook(playbookPath, [baseEntry()]);
  const host = makeHost({ playbookPath });
  const route = statsRoute(host);
  const agent = makeAgent();

  // ① 先成功发布一批：batches 是**进程累计**，从这里起再也回不到 0。
  sendInbox(host, agent, QUERY, 'msg-sv-0');
  await waitFor(async () => (await injectionOf(route)).batches === 1, '第一批已发布');
  // ② 随后连续 5 次无产出（这些问法与手册零字面交集 ⇒ 挑不出候选）。
  for (let i = 1; i <= 5; i += 1) {
    sendInbox(host, agent, 'zzz qqq vvv s' + i, 'msg-sv-' + i);
    await waitFor(async () => (await injectionOf(route)).stall.noProduce === i, '第 ' + i + ' 次无产出');
  }

  const stats = await injectionOf(route);
  assert.equal(stats.stall.noProduce, 5, '按 agent 的连续失败由 R5 这本账负责（门槛 5）');
  assert.equal(
    stats.stalled,
    false,
    'stalled 的语义是「本进程里注入 handler 被调用过、但自进程启动以来从未成功产出过任何批次」；'
    + '这一场早就产出过，所以必须是 false —— 它答不了「最近是否连续失败」（第 43 轮改口径表述，表达式一字未动）',
  );

  // 两个字段分工不同，但谁都没被废掉：门槛仍由 stall.noProduce 把守，notice 照发。
  emit(host, 'agent/turn-stopping', { agent, turn: 9 });
  assert.equal(agent.notices.filter(isNotice).length, 1, '攒满门槛照发一次性 notice');
  assert.equal((await injectionOf(route)).stall.noProduce, 0, '发完 notice 清零（一次性，不重复刷屏）');
  assert.equal((await injectionOf(route)).stalled, false, '清零也不会把 stalled 变成 true（两者本就不是同口径）');
});
