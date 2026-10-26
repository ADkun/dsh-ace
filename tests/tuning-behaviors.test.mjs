// 三个新配置项的**行为**用例（第 36 轮验收 2f）：不只验「值存在」，而是「改配置真的改变行为」。
// 三个键各自走真实生产路径：
//   injectTokenBudget / injectMaxEntries → 真发 agent/inbox/inserted + 真跑 agent/pre-step 投递；
//   evictProtectDays / maxEntries        → 真调 /ace 命令，走 recap-pipeline → commitOps → lib/evict.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-tuning-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

// schemastery 桩必须是「保留 fields」的那一版：configDefaults() 靠 plugin.Config.fields 取默认值。
const STUBS = {
  '@deepseek-ai/schemastery':
    'function builder(kind) { const b = { type: kind }; b.description = () => b; b.default = (v) => { b.defaultValue = v; return b; }; b.optional = () => b; return b; }' +
    'export default { string: () => builder(\'string\'), boolean: () => builder(\'boolean\'), number: () => builder(\'number\'), object: (fields) => ({ type: \'object\', fields }) };',
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
const { serializePlaybook, withExclusiveLock, writeFileAtomic, parsePlaybook } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'playbook.js')).href
);
const { readArchiveSnapshot } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'archive-file.js')).href);
const { selectInjection } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'inject.js')).href);

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

const QUALITY = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };

/** 造一条手册条目（形状与 lib/playbook.js 的 parsePlaybook 一致，落盘走真序列化器）。 */
function entryBlock({ id, title, condition, action, rationale = '', created, hits = 0 }) {
  return {
    id, title, condition, action, rationale,
    meta: { created, updated: created, hits, lastHit: '' },
    extraLines: [],
  };
}

async function writePlaybookFile(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

async function archivedEntriesOf(file) {
  const archiveFile = path.join(path.dirname(file), 'archive.md');
  if (!fs.existsSync(archiveFile)) return [];
  return (await readArchiveSnapshot(archiveFile)).entries;
}

function configDefaults() {
  const out = {};
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) out[key] = field.defaultValue;
  }
  return out;
}

/** script(index) → 第 index 次 LLM 调用返回的候选批次。 */
function makeHost({ playbookPath, script = () => [], config = {} }) {
  const record = { tools: [], sections: [], handlers: [], commands: [], injected: [], llmCalls: [], logs: { info: [], warn: [], error: [] } };
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
        const batch = script(index);
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: batch, notes: 'tuning' }) };
      },
    },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, {
    ...configDefaults(),
    playbookPath,
    autoReviewInbox: false,
    ...config,
  });
  return { ctx, record };
}

function makeAgent() {
  const notices = [];
  return {
    notices,
    session: {
      header: { origin: 'cli' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '把 lib/foo.js 的导出改成 bar' }] },
        { role: 'assistant', content: [{ type: 'text', text: '先读一遍再改。' }, { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '写入成功' }] },
      ],
    },
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
const idsOf = (text) => [...String(text).matchAll(/\[(ace-\d+)\]/g)].map((m) => m[1]);

/** 发一条用户消息，取回被追加进历史的那条注入块正文（真走 inbox/inserted → pre-step 投递）。 */
async function injectFor(host, agent, text, tries = 40) {
  emit(host, 'agent/inbox/inserted', {
    agent,
    message: { role: 'user', id: 'msg-' + Math.random().toString(36).slice(2), content: [{ type: 'text', text }] },
  });
  for (let i = 1; i <= tries; i += 1) {
    const decision = await runPreStep(host, agent, { step: i });
    const appended = decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace');
    if (appended.length) return appended[appended.length - 1].content.map((b) => b.text || '').join('\n');
    await sleep(10);
  }
  assert.fail('agent/pre-step 没有把注入追加进历史（' + text + '）');
}

/** 真调 /ace 命令（手动复盘路径）：candidates → 判定 → 满额淘汰 → 落盘。 */
async function runAceCommand(host, agent) {
  const command = host.record.commands.find((c) => c.name === 'ace');
  assert.ok(command, '插件没有注册 /ace 命令');
  return await command.handler({ agent, rawInput: '' });
}

const FIVE = () => [1, 2, 3, 4, 5].map((n) => entryBlock({
  id: 'ace-' + String(n).padStart(3, '0'),
  ...QUALITY,
  created: '2020-01-0' + n,
}));

// —— 配置项①：injectTokenBudget（注入 token 预算）——
test('配置行为①：injectTokenBudget 调小 → 注入条数真的变少（挤不下就不塞）', async () => {
  const file = path.join(ROOT, 'budget', 'playbook.md');
  await writePlaybookFile(file, FIVE());
  const agent = makeAgent();

  const wide = makeHost({ playbookPath: file, config: { injectTokenBudget: 4000, injectMaxEntries: 5 } });
  const textWide = await injectFor(wide, agent, QUALITY.title);
  const idsWide = idsOf(textWide);

  const narrow = makeHost({ playbookPath: file, config: { injectTokenBudget: 150, injectMaxEntries: 5 } });
  const textNarrow = await injectFor(narrow, agent, QUALITY.title);
  const idsNarrow = idsOf(textNarrow);

  assert.equal(idsWide.length, 5, '预算宽时 5 条全进：' + JSON.stringify(idsWide));
  assert.ok(idsNarrow.length >= 1, '预算再小也至少留第一条（不许整块空掉）');
  assert.ok(idsNarrow.length < idsWide.length, '预算从 4000 调到 150 必须真的少注入：' + idsNarrow.length + ' vs ' + idsWide.length);
  assert.equal(idsNarrow.join(','), idsWide.slice(0, idsNarrow.length).join(','), '少注入的是**尾部**，头部顺序不许变');

  // 纯函数口径复算一次，证明差异确实来自预算这一项（其余入参一字不差）。
  const entries = FIVE();
  const pick = (budget) => selectInjection(entries, QUALITY.title, { tokenBudget: budget, maxEntries: 5 });
  assert.equal(pick(4000).count, 5);
  assert.equal(pick(150).count, idsNarrow.length, 'HTTP 面看到的条数必须与纯函数口径一致');
});

// —— 配置项②：injectMaxEntries（一次注入最多几条）——
test('配置行为②：injectMaxEntries 调小 → 注入条数真的变少（预算再宽也不超条数上限）', async () => {
  const file = path.join(ROOT, 'count', 'playbook.md');
  await writePlaybookFile(file, FIVE());
  const agent = makeAgent();

  const many = makeHost({ playbookPath: file, config: { injectTokenBudget: 4000, injectMaxEntries: 5 } });
  const textMany = await injectFor(many, agent, QUALITY.title);

  const few = makeHost({ playbookPath: file, config: { injectTokenBudget: 4000, injectMaxEntries: 2 } });
  const textFew = await injectFor(few, agent, QUALITY.title);

  assert.equal(idsOf(textMany).length, 5);
  assert.equal(idsOf(textFew).length, 2, 'injectMaxEntries=2 就必须只注入 2 条：' + JSON.stringify(idsOf(textFew)));
  assert.deepEqual(idsOf(textFew), idsOf(textMany).slice(0, 2), '被砍掉的是尾部，头部顺序不许变');
  assert.equal(selectInjection(FIVE(), QUALITY.title, { maxEntries: 2 }).count, 2);

  // 第 37 轮任务 C：首行「最多 N 条」跟配置值走（injectMaxEntries=8 首行必须是「最多 8 条」）
  const big = makeHost({ playbookPath: file, config: { injectTokenBudget: 4000, injectMaxEntries: 8 } });
  const textBig = await injectFor(big, agent, QUALITY.title);
  assert.ok(/最多 8 条/.test(textBig.split('\n')[0]), 'injectMaxEntries=8 时首行必须写最多 8 条：' + textBig.split('\n')[0]);
  assert.ok(!/最多 5 条/.test(textBig), '配置是 8 就不许还保留默认的 5：' + textBig.split('\n')[0]);
});

// —— 配置项③：evictProtectDays（新条目保护期）——
test('配置行为③：evictProtectDays 调大 → 不再拿新条目开刀，改从老条目里淘汰', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const setup = async (file) => {
    // 老条目 hits 高（本来排在全序最后），两条新条目 hits 0（本来最先被淘汰）。
    await writePlaybookFile(file, [
      entryBlock({ id: 'ace-001', title: '老经验甲', condition: '当甲时', action: '做甲', created: '2020-01-01', hits: 9 }),
      entryBlock({ id: 'ace-002', title: '新经验乙', condition: '当乙时', action: '做乙', created: today, hits: 0 }),
      entryBlock({ id: 'ace-003', title: '新经验丙', condition: '当丙时', action: '做丙', created: today, hits: 0 }),
    ]);
  };
  const candidate = [{ title: '第四条约新经验', condition: '当丁时', action: '做丁', rationale: '' }];
  const script = (i) => (i === 0 ? candidate : []);

  const oldFile = path.join(ROOT, 'protect-off', 'playbook.md');
  await setup(oldFile);
  const off = makeHost({ playbookPath: oldFile, script, config: { maxEntries: 3, evictProtectDays: 0 } });
  const resOff = await runAceCommand(off, makeAgent());
  assert.equal(resOff.kind, 'success', JSON.stringify(resOff));
  assert.deepEqual((await archivedEntriesOf(oldFile)).map((e) => e.id), ['ace-002'], '不保护时按老全序淘汰 hits 最少的新条目');

  const onFile = path.join(ROOT, 'protect-on', 'playbook.md');
  await setup(onFile);
  const on = makeHost({ playbookPath: onFile, script, config: { maxEntries: 3, evictProtectDays: 14 } });
  const resOn = await runAceCommand(on, makeAgent());
  assert.equal(resOn.kind, 'success', JSON.stringify(resOn));
  const movedOn = await archivedEntriesOf(onFile);
  assert.deepEqual(movedOn.map((e) => e.id), ['ace-001'], '保护期开着时新条目不许被淘汰，只能动老条目：' + JSON.stringify(movedOn.map((e) => e.id)));
  assert.equal(movedOn[0].archive.reason, 'evicted');
  // 容量硬约束一位不减：腾位照常发生，活跃条目数仍然 <= maxEntries=3。
  assert.equal(parsePlaybook(fs.readFileSync(onFile, 'utf8')).entries.length, 3);
});

// —— 配置项③的容量侧：maxEntries 调小 → 淘汰真的发生 ——
test('配置行为③：maxEntries 调小 → 淘汰真的发生（调大就不发生），容量一位不减', async () => {
  const candidate = [{ title: '第四条独立经验', condition: '当戊时', action: '做戊', rationale: '' }];
  const script = (i) => (i === 0 ? candidate : []);
  const seed = async (file) => {
    await writePlaybookFile(file, [1, 2, 3].map((n) => entryBlock({
      id: 'ace-' + String(n).padStart(3, '0'),
      title: '经验第' + n + '条',
      condition: '当第' + n + '种情况时',
      action: '按第' + n + '条做法',
      created: '2020-01-0' + n,
      hits: n,
    })));
  };

  const roomy = path.join(ROOT, 'cap-roomy', 'playbook.md');
  await seed(roomy);
  const big = makeHost({ playbookPath: roomy, script, config: { maxEntries: 100, evictProtectDays: 0 } });
  await runAceCommand(big, makeAgent());
  assert.equal(parsePlaybook(fs.readFileSync(roomy, 'utf8')).entries.length, 4, '上限 100 时四条全都留在活跃区');
  assert.deepEqual(await archivedEntriesOf(roomy), [], '没超限就不许淘汰');

  const tight = path.join(ROOT, 'cap-tight', 'playbook.md');
  await seed(tight);
  const small = makeHost({ playbookPath: tight, script, config: { maxEntries: 3, evictProtectDays: 0 } });
  await runAceCommand(small, makeAgent());
  const kept = parsePlaybook(fs.readFileSync(tight, 'utf8')).entries;
  assert.equal(kept.length, 3, '上限 3 时必须腾位：' + kept.map((e) => e.id).join(','));
  const moved = await archivedEntriesOf(tight);
  assert.equal(moved.length, 1, '恰好腾出 1 位：' + JSON.stringify(moved.map((e) => e.id)));
  assert.equal(moved[0].archive.reason, 'evicted');
});
