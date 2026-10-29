// 话题热度的接线用例（第 36 轮）：真 import lib/index.js、真调 apply()、真发 agent/inbox/inserted，
// 验的是「窗口按 agent 隔离 + 热度真参与排序」这两件只有接线才对得上的事。
//
// 为什么单开一个文件而不是塞进 tests/heat.test.mjs：heat.test.mjs 只跑纯函数，
// 任何一个 agent 把消息压进同一个（全局）窗口都测不出来 —— 那正是接线最可能犯的错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-heat-wiring-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

// 与 tests/e2e.test.mjs 同款最小宿主桩（data: URL，不落盘）。
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
const { computeHeat } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'heat.js')).href);
const { rankInjection, selectInjection } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'inject.js')).href);

const INJECTION_MARK = '【ACE 自动注入】';

/** 造一条条目（与 lib/playbook.js 的 parsePlaybook 形状一致，落盘走真序列化器）。 */
function entry(spec) {
  return {
    id: spec.id,
    title: spec.title,
    condition: spec.condition,
    action: spec.action,
    rationale: spec.rationale ?? '',
    meta: { created: '2026-01-01', updated: '2026-01-01', hits: 0, lastHit: '' },
    extraLines: [],
  };
}

async function writePlaybook(file, entries) {
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

const SEED_TOPIC = '数据库迁移前先备份';
const WINDOW_TOPIC = '回滚';

/** 三条条目：001/002 正文字面完全相同（BM25 分几乎相等），002 多一个只跟「回滚」相关的依据。 */
function fixtureEntries() {
  const body = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  return [
    entry({ id: 'ace-001', ...body }),
    entry({ id: 'ace-002', ...body, rationale: '回滚' }),
    entry({ id: 'ace-003', title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版' }),
  ];
}

function makeHost({ playbookPath, config = {} }) {
  const record = { tools: [], sections: [], handlers: [], commands: [], injected: [], logs: { info: [], warn: [], error: [] } };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [], notes: 'heat-wiring' }) };
      },
    },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, {
    playbookPath,
    autoReflect: true,
    reflectProvider: '',
    reflectModel: '',
    maxEntries: 100,
    autoRecap: true,
    autoRecapThreshold: 1,
    autoRecapCooldownTurns: 0,
    autoReviewInbox: false,
    // 绝对门槛（4.0 × IDF_MAX）另有一组专门用例（tests/inject.test.mjs 的 C5.8）；
    // 本文件钉的是热度接线，三条条目的小手册夹具会整片被门槛挡空，所以这里关掉（0 = 关）。
    injectMinScoreIdfRatio: 0,
    injectMinRelativeToTop: 0,
    ...config,
  });
  return { ctx, record };
}

function makeAgent() {
  const notices = [];
  return {
    notices,
    session: { header: { origin: 'cli' }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }), deriveMessages: () => [] },
    options: { provider: 'p', model: 'm' },
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

async function runPreStep(host, agent, { messages = [], step = 1 } = {}) {
  const hits = host.record.handlers.filter((h) => h.event === 'agent/pre-step');
  const base = { kind: 'enter', messages, startsRequestSeries: true };
  let decision = base;
  for (const h of hits) decision = await h.handler({ agent, messages, turn: 1, step, signal: { throwIfAborted() {} } }, async () => base);
  return decision;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 发一条用户消息，取回被追加进历史的那条注入块正文。 */
async function injectFor(host, agent, text, tries = 40) {
  emit(host, 'agent/inbox/inserted', {
    agent,
    message: { role: 'user', id: 'msg-' + Math.random().toString(36).slice(2), content: [{ type: 'text', text }] },
  });
  for (let i = 1; i <= tries; i += 1) {
    const decision = await runPreStep(host, agent, { step: i });
    const appended = decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace');
    if (appended.length) {
      const message = appended[appended.length - 1];
      return message.content.map((block) => block.text || '').join('\n');
    }
    await sleep(10);
  }
  assert.fail('agent/pre-step 没有把注入追加进历史（' + text + '）');
}

const idsOf = (text) => [...text.matchAll(/\[(ace-\d+)\]/g)].map((m) => m[1]);
const heatMapOf = (entries, messages, options = {}) => computeHeat(entries, messages, options);

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

test('注入接线｜已注入集合按 agent 隔离（B3），热度纯函数口径不变', async () => {
  const file = path.join(ROOT, 'per-agent', 'playbook.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = fixtureEntries();
  await writePlaybook(file, entries);
  const host = makeHost({ playbookPath: file });
  const a = makeAgent();
  const b = makeAgent();

  // 先钉住纯函数的口径：窗口里三条「回滚」消息只捞到 ace-002 → 它的热度最高；
  // 而 ace-001 与 ace-002 对种子话题的相关度几乎相同（002 只多一个词的正文长度差）。
  const gateOff = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };
  const heat = heatMapOf(entries, [WINDOW_TOPIC, WINDOW_TOPIC, WINDOW_TOPIC], gateOff);
  assert.equal(heat.get('ace-002'), 3, '三条历史消息都命中 ace-002');
  assert.equal(heat.get('ace-001'), undefined, 'ace-001 跟「回滚」没有字面交集');
  const dry = selectInjection(entries, SEED_TOPIC, { ...gateOff, heat });
  assert.deepEqual(dry.ids, ['ace-002', 'ace-001'], '纯函数口径：热度能把几乎同分的 ace-002 顶到前面');
  const noHeat = rankInjection(entries, SEED_TOPIC, gateOff);
  assert.deepEqual(noHeat.ranked.map((r) => r.entry.id), ['ace-001', 'ace-002'], '不看热度时是 id 升序（字面无关的 ace-003 根本不进候选）');

  // agent A：先聊一轮「回滚」——这条消息会把命中的 ace-002 注入进历史（同时进热度窗口）。
  const warm = await injectFor(host, a, WINDOW_TOPIC);
  assert.ok(warm.includes('ace-002'), '暖窗消息自身会注入命中的 ace-002：\n' + warm);

  // 再发种子消息：B3 会话内去重 → ace-002 已注入过，不再重复注入，只剩别的条目。
  const textA = await injectFor(host, a, SEED_TOPIC);
  assert.ok(textA.includes(INJECTION_MARK), 'A 的注入块必须出现：\n' + textA);
  const idsA = idsOf(textA);
  assert.equal(idsA.includes('ace-002'), false, 'B3：ace-002 本会话已注入过，种子消息不再重复注入：' + idsA.join(','));
  assert.ok(idsA.includes('ace-001'), '未注入过的相关条目照常注入：' + idsA.join(','));
  assert.equal(idsA.includes('ace-003'), false, '字面无关的 ace-003 不许进注入块：' + idsA.join(','));

  // agent B：全新会话、没注入过任何条目 → 同一条种子消息按旧口径 id 升序两条都注入。
  const textB = await injectFor(host, b, SEED_TOPIC);
  const idsB = idsOf(textB);
  assert.deepEqual(idsB, ['ace-001', 'ace-002'], 'B 没注入过任何条目 → 两条都注入（id 升序）：' + idsB.join(','));
  assert.notDeepEqual(idsA, idsB, 'A、B 结果不同 → 「已注入集合」确实按 agent 隔离');
});

test('热度接线｜重启即清空：全新 host（空窗口）对同一条消息排出旧口径顺序', async () => {
  const file = path.join(ROOT, 'fresh', 'playbook.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writePlaybook(file, fixtureEntries());
  const host = makeHost({ playbookPath: file });
  const agent = makeAgent();
  const text = await injectFor(host, agent, SEED_TOPIC);
  assert.deepEqual(idsOf(text), ['ace-001', 'ace-002'], '空窗口下热度不参与加权（等价于旧行为）');
});
