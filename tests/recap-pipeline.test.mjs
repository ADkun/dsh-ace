// dsh-ace 行为测试：复盘主体流水线（lib/recap-pipeline.js）。
//
// 为什么单开一个文件：lib/index.js 顶层 import 宿主包（@deepseek-ai/dsh-tools 等），本仓库不带
// node_modules，node --test 里 import 不到 —— 于是「executeRecap 整链」长期只能靠源码正则断言
// （审查报告 4.1 / 4.4 第 6 条）。复盘主体抽到 lib/recap-pipeline.js 后零宿主依赖，这里用
// **真实临时手册 + 真实 commitOps/commitCapacity + 假 Reflector / 假合并 LLM（不调真 LLM）**
// 真跑整链，钉住第 33 轮之后的四条结构：容量治理先合并再淘汰（c）、合并失败绝不阻塞落盘（d）、
// 命中计数只在回合边界落盘（D4 / P1-6）、0 候选回合照样做容量治理（P0-6）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlaybook, serializePlaybook, digestEntries, markHits } from '../lib/playbook.js';
import { dayString } from '../lib/archive.js';
import { createUsageLedger } from '../lib/ledger.js';
import { runRecapPipeline, acceptCandidates } from '../lib/recap-pipeline.js';
import { readArchiveSnapshot } from '../lib/archive-file.js';

const TODAY = dayString();
/** 毫秒时间戳（本地时区）：字典序即时间序。 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

/** 造一条活跃条目（第 33 轮后 meta 只有四个字段：created / updated / hits / lastHit）。 */
const E = (id, title, action, meta = {}) => ({
  id,
  title,
  condition: '条件-' + id,
  action: action || '做法-' + id,
  rationale: '',
  meta: { created: TODAY, updated: TODAY, hits: 1, lastHit: '', ...meta },
  extraLines: [],
});

/** 造一条候选（Reflector 的输出形状：四字段齐全）。 */
const C = (title, action) => ({ title, condition: '条件-' + title, action: action || '做法-' + title, rationale: '' });

/** 合并 LLM 的合规输出（四字段齐全的 JSON 对象）。 */
const MERGED_JSON = JSON.stringify({
  title: '批量重命名符号要同步全部调用点',
  condition: '当批量重命名某个符号并要保证调用点同步时',
  action: '先用 grep 列出该符号的全部调用点并记下命中数，再执行重命名，改完用同一条 grep 复核命中数',
  rationale: '漏改都来自没有先枚举调用点；直接改定义处就收工会留下漏网调用点',
});

/** 两条讲同一件事的条目（对称 BM25 比率远高于 0.5，必然被 findMergePairs 选中）。 */
const SIMILAR_A = E('ace-001', '批量改名前先列调用点', '先用 grep 列出该符号的全部调用点再执行重命名', {
  created: '2026-01-01T00:00:00.000+08:00',
  hits: 3,
});
const SIMILAR_B = E('ace-002', '批量重命名要核对调用点', '先用 grep 列出该符号的全部调用点再执行重命名，改完再 grep 一次复核', {
  created: '2026-02-01T00:00:00.000+08:00',
  hits: 4,
});

async function makeDir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-recap-' + tag + '-'));
}

async function writePlaybook(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializePlaybook({ header: ['# ACE 操作手册', ''], entries }), 'utf8');
}

async function readPlaybook(file) {
  return parsePlaybook(await fs.readFile(file, 'utf8'));
}

/**
 * 装配复盘主体的 deps：真实账本 + 真实统计 + 假 Reflector + 假合并 LLM。
 * 全部副作用（归档/写入/冲突/收件箱计数）都记在返回值里，供断言直接看。
 */
function makeDeps(file, options = {}) {
  const ledger = createUsageLedger();
  const agent = { name: 'test-agent' };
  const recapStats = { recaps: 0, candidates: 0, written: 0 };
  const seen = { archived: [], written: [], conflicts: [], inboxCounts: [], logs: [] };
  const deps = {
    file,
    // 归档文件（第 33 轮起独立成文件）：默认与手册同目录的 archive.md。
    archiveFile: options.archiveFile === undefined ? path.join(path.dirname(file), 'archive.md') : options.archiveFile,
    logger: { info: (m) => seen.logs.push(String(m)), warn: (m) => seen.logs.push(String(m)) },
    maxEntries: options.maxEntries === undefined ? 60 : options.maxEntries,
    recapStats,
    digestEntries,
    // D4：流水线**不许**自己取账本（回合边界是唯一取走点）。这里放一个 tripwire：
    // 谁把 takeUsageIds 调回去，这批用例立刻红，而不是悄悄抢走别的回合的 id。
    takeUsageIds: () => { throw new Error('流水线不许自己取账本：注入 id 只能由回合边界取走（D4）'); },
    noteArchived: (list) => { for (const item of list || []) seen.archived.push(item); },
    noteWritten: (result, source) => seen.written.push({ source, added: result.added, updated: result.updated }),
    reportConflicts: (a, conflicts) => { for (const c of conflicts || []) seen.conflicts.push(c); },
    inboxPath: (f) => path.join(path.dirname(f), 'merge-inbox'),
    onInboxCount: (n) => seen.inboxCounts.push(n),
    reflectRound: options.reflectRound || (async () => []),
  };
  if (options.mergeAsk) deps.mergeAsk = options.mergeAsk;
  return { deps, ledger, agent, recapStats, seen };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// —— D4：命中账本归回合边界管，流水线既不取也不结算 ——

test('P0-4｜0 候选回合也不碰账本（D4）：流水线既不 take 也不改盘上的命中计数', async () => {
  const dir = await makeDir('ledger-zero');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [E('ace-001', '编辑前先读', '先 read 再动手')]);
  const { deps, ledger, agent } = makeDeps(file, { reflectRound: async () => [] });
  ledger.note(agent, ['ace-001']);
  assert.deepEqual(ledger.peek(agent), ['ace-001'], '前置：账本里压着本回合注入的 id');
  // makeDeps 的 takeUsageIds 是 tripwire：流水线一旦自己去取账本就抛错。
  const out = await runRecapPipeline(deps, { agent, summary: '轨迹' });
  assert.deepEqual(out.added, [], '本回合 0 候选');
  assert.deepEqual(ledger.peek(agent), ['ace-001'], '账本原封不动：取走它的是回合边界，不是流水线');
  const before = (await readPlaybook(file)).entries[0].meta;
  assert.equal(before.hits, 1, '没有回合边界落盘 → 命中计数不动');
  // 第二回合：同样没有落盘 → 不会凭空给 ace-001 再加一次命中
  await runRecapPipeline(deps, { agent, summary: '轨迹' });
  const after = (await readPlaybook(file)).entries[0].meta;
  assert.equal(after.hits, before.hits, '第二回合没有注入 → 不许再计一次命中');
  assert.equal('helpful' in after, false, '计分字段已整层删除');
  assert.equal('harmful' in after, false);
  await cleanup(dir);
});

test('P0-4｜Reflector 抛错（复盘失败）时账本仍完好：坏掉的一轮既不吃掉 id 也不重复计数', async () => {
  const dir = await makeDir('ledger-throw');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [E('ace-001', '标题', '做法')]);
  const { deps, ledger, agent } = makeDeps(file, {
    reflectRound: async () => { throw new Error('LLM 挂了'); },
  });
  ledger.note(agent, ['ace-001']);
  await assert.rejects(() => runRecapPipeline(deps, { agent, summary: '轨迹' }), /LLM 挂了/);
  assert.deepEqual(ledger.peek(agent), ['ace-001'], '流水线没碰账本：id 还在，等回合边界结算');
  const meta = (await readPlaybook(file)).entries[0].meta;
  assert.equal(meta.hits, 1, '复盘失败 → 命中计数不动');
  await cleanup(dir);
});

// —— P0-6：0 候选回合也要做容量治理 ——

test('P0-6｜0 候选 + 超容量 → 按最少使用淘汰并落盘（模型一收敛，超额手册也能降下来）', async () => {
  const dir = await makeDir('capacity-zero');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    E('ace-001', '没人用过的老经验', '做法一', { hits: 0, created: '2026-01-01T00:00:00.000+08:00' }),
    E('ace-002', '偶尔用', '做法二', { hits: 1 }),
    E('ace-003', '经常用', '做法三', { hits: 9 }),
  ]);
  const { deps, seen } = makeDeps(file, { reflectRound: async () => [], maxEntries: 2 });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });
  assert.equal(out.evicted, 1, '淘汰 1 条');
  const parsed = await readPlaybook(file);
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-002', 'ace-003'], 'hits 最少的 ace-001 离开活跃区');
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive.map((e) => e.id), ['ace-001'], '被淘汰的条目进了独立归档文件');
  assert.equal(archive[0].archive.reason, 'evicted');
  assert.ok(STAMP_RE.test(archive[0].archive.date), '归档日期是毫秒时间戳：' + archive[0].archive.date);
  assert.deepEqual(seen.archived.map((a) => a.id), ['ace-001'], '统计口径也收到这次归档');
  await cleanup(dir);
});

test('P0-6｜0 候选且没有条目要腾位 → 文件一个字不改（不为了「跑过容量治理」而乱写）', async () => {
  const dir = await makeDir('capacity-noop');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [E('ace-001', '标题', '做法')]);
  const { deps, seen } = makeDeps(file, { reflectRound: async () => [] });
  const before = await fs.readFile(file, 'utf8');
  await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });
  assert.deepEqual(seen.archived, []);
  assert.equal(await fs.readFile(file, 'utf8'), before, '没有可搬移条目就不该写盘');
  await cleanup(dir);
});

// —— c：满额时先合并（合并成功 → 条数降到上限内，旧 id 留给 created 更早那条，另一条 reason=merged） ——

test('c｜满额先合并：LLM 合成一条同构条目，保留 created 更早那条 id，另一条进归档 reason=merged', async () => {
  const dir = await makeDir('merge-ok');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [SIMILAR_A, SIMILAR_B]);
  const asks = [];
  const { deps, seen } = makeDeps(file, {
    maxEntries: 2,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async ({ userText }) => { asks.push(userText); return MERGED_JSON; },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(asks.length, 1, '只把这一对的正文喂给 LLM（不喂整本手册）');
  assert.ok(asks[0].includes('ace-001') && asks[0].includes('ace-002'), '请求里点明是哪两条');
  assert.ok(!asks[0].includes('迁移前先在影子库试跑'), '不许把别的候选/条目塞进合并请求');

  assert.equal(out.merged, 1, '合并成功 1 对');
  assert.equal(out.added.length, 1, '合并腾出的位置照常写进新候选');

  const parsed = await readPlaybook(file);
  const ids = parsed.entries.map((e) => e.id);
  assert.ok(ids.includes('ace-001'), 'created 更早的 ace-001 被保留');
  assert.ok(!ids.includes('ace-002'), '另一条离开活跃区');
  const kept = parsed.entries.find((e) => e.id === 'ace-001');
  assert.equal(kept.title, JSON.parse(MERGED_JSON).title, '留下的那条正文换成 LLM 合成的版本');
  assert.equal(kept.meta.created, SIMILAR_A.meta.created, 'created 沿用更早那条');
  assert.equal(kept.meta.hits, 7, '命中计数取两条之和：3 + 4');
  assert.ok(STAMP_RE.test(kept.meta.updated), 'updated 刷新成毫秒时间戳：' + kept.meta.updated);
  assert.ok(parsed.entries.length <= 2, '条数降到上限内');

  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive.map((e) => e.id), ['ace-002']);
  assert.equal(archive[0].archive.reason, 'merged');
  assert.equal(archive[0].archive.supersededBy, 'ace-001', '归档条目指向留下的那条');
  assert.equal(archive[0].title, SIMILAR_B.title, '归档保留原正文');
  assert.deepEqual(seen.archived.map((a) => a.id), ['ace-002']);
  await cleanup(dir);
});

// —— d：合并失败绝不阻塞复盘落盘（三条守护用例之一） ——

test('守护②｜LLM 合并失败绝不许阻塞落盘（合并抛错 → 跳过该对 → 直接淘汰腾位 → 复盘照常落盘）', async () => {
  const dir = await makeDir('merge-throw');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    SIMILAR_A,
    { ...SIMILAR_B, id: 'ace-002' },
    E('ace-003', '没人碰过', '做法三', { hits: 0 }),
  ]);
  const { deps, seen } = makeDeps(file, {
    maxEntries: 2,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async () => { throw new Error('LLM 超时'); },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(out.merged, 0, '一对都没合并成');
  assert.equal(out.added.length, 1, '合并全失败也照样把候选写进去');
  assert.ok(seen.logs.some((m) => m.includes('合并失败')), '失败要留痕：' + JSON.stringify(seen.logs));
  assert.ok(!seen.logs.some((m) => m.includes('合并阶段整体失败')), 'planMerges 自己吞掉每对的错误，不该走到整体失败那一支');

  const parsed = await readPlaybook(file);
  assert.ok(parsed.entries.some((e) => e.id === out.added[0]), '新候选正常落盘');
  assert.ok(parsed.entries.length <= 2, '条数降到上限内（靠淘汰）');
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.ok(archive.length >= 1, '腾位搬走的那条进了归档文件（没被物理删除）');
  assert.ok(archive.every((e) => e.archive.reason === 'evicted'), '合并失败的那一对没有被标记成 merged：' +
    JSON.stringify(archive.map((e) => [e.id, e.archive.reason])));
  await cleanup(dir);
});

test('d｜合并输出不合格（不是合法 JSON / 四字段不全）：视为该对失败，换下一对/直接淘汰，落盘照常成功', async () => {
  const dir = await makeDir('merge-bad');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [SIMILAR_A, { ...SIMILAR_B, id: 'ace-002' }]);
  const replies = ['我认为这两条可以合并（不是 JSON）', JSON.stringify({ title: '只有一个字段' })];
  const { deps, seen } = makeDeps(file, {
    maxEntries: 2,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async () => replies.shift() ?? replies[replies.length - 1] ?? '{}',
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(out.merged, 0, '形状不合格一律不算合并成功');
  assert.equal(out.added.length, 1, '候选照常落盘');
  assert.ok(seen.logs.some((m) => m.includes('合并输出不合格')), '不合格输出要留痕：' + JSON.stringify(seen.logs));
  // 落盘成功 = 手册真的被写过，且旧条目既没丢也没被改正文。
  const parsed = await readPlaybook(file);
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  const all = parsed.entries.concat(archive);
  assert.ok(all.some((e) => e.id === 'ace-001') && all.some((e) => e.id === 'ace-002'), '失败的这一对谁都没丢（活跃区或归档文件里都找得到）');
  assert.equal(all.find((e) => e.id === 'ace-001').title, SIMILAR_A.title, '失败的那一对正文一个字都不许被改');
  assert.equal(all.find((e) => e.id === 'ace-002').title, SIMILAR_B.title, '失败的那一对正文一个字都不许被改');
  await cleanup(dir);
});

test('d｜合并不成功也必须腾位：满额不再整批拒绝，按淘汰顺序写进 archive.md', async () => {
  const dir = await makeDir('evict-no-merge');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    E('ace-001', '没人用过', '做法一', { hits: 0, created: '2026-01-01T00:00:00.000+08:00' }),
    E('ace-002', '用过一次', '做法二', { hits: 1, created: '2026-02-01T00:00:00.000+08:00' }),
  ]);
  const { deps } = makeDeps(file, {
    maxEntries: 2,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    // 不提供 mergeAsk：等于「这一轮没有合并能力」→ 直接进入淘汰。
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });
  assert.equal(out.added.length, 1, '满额不再整批拒绝（旧行为是 throw 手册已达上限）');
  const parsed = await readPlaybook(file);
  assert.equal(parsed.entries.length, 2, '条数回到上限');
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive.map((e) => e.id), ['ace-001'], 'hits 最少的先走');
  assert.equal(archive[0].archive.reason, 'evicted');
  await cleanup(dir);
});

// —— e（第 37 轮 B）：不满额也配对，但只有「真的很像」才动手 ——
//
// 满额路径（projected > maxEntries）一字未动：阈值 0.5、最多 5 对，由上面的 c / 守护② / d 钉住。
// 这里钉住新增的轻量路径：projected <= maxEntries 且 adds > 0 时跑一次，阈值 0.75、最多 2 对。

/** 正文与条件都逐字相同的两条（对称 BM25 比率 = 1，两条路径都够得着）。 */
const TWIN_COND = '当批量重命名一个符号并保证调用点同步时';
const TWIN_BODY = '先用 grep 列出该符号的全部调用点并记下命中数，再执行重命名，改完用同一条 grep 复核命中数';
const TWIN = (id, hits, created) => ({
  ...E(id, '批量改名前先列调用点', TWIN_BODY, { hits, created }),
  condition: TWIN_COND,
});

test('e｜不满额也配对（第 37 轮 B）：adds>0 且两条几乎同文 → 轻量合并 1 对，另一条进归档 reason=merged', async () => {
  const dir = await makeDir('eager-merge-ok');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    TWIN('ace-001', 3, '2026-01-01T00:00:00.000+08:00'),
    TWIN('ace-002', 4, '2026-02-01T00:00:00.000+08:00'),
  ]);
  const asks = [];
  const { deps, seen } = makeDeps(file, {
    // 上限 60，本轮只加 1 条 → projected = 2，远没到满额：证明这条路**不是**靠超额触发。
    maxEntries: 60,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async ({ userText }) => { asks.push(userText); return MERGED_JSON; },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(asks.length, 1, '不满额也要把这一对喂给 LLM（只喂这一对，不喂整本手册）');
  assert.ok(asks[0].includes('ace-001') && asks[0].includes('ace-002'), '请求里点明是哪两条');
  assert.equal(out.merged, 1, '不满额路径合并成功 1 对');
  assert.equal(out.added.length, 1, '新候选照常落盘（合并不吃名额）');

  const parsed = await readPlaybook(file);
  const ids = parsed.entries.map((e) => e.id);
  assert.ok(parsed.entries.length <= 60, '合并时根本没到上限：' + parsed.entries.length);
  assert.ok(ids.includes('ace-001'), 'created 更早的 ace-001 被保留');
  assert.ok(!ids.includes('ace-002'), '另一条离开活跃区');
  const kept = parsed.entries.find((e) => e.id === 'ace-001');
  assert.equal(kept.meta.hits, 7, '命中计数取两条之和：3 + 4');
  assert.equal(kept.title, JSON.parse(MERGED_JSON).title, '留下的那条正文换成 LLM 合成的版本');

  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive.map((e) => e.id), ['ace-002'], '被并掉的那条进归档（绝不物理删除）');
  assert.equal(archive[0].archive.reason, 'merged', '归档原因与满额路径一致仍是 merged');
  assert.equal(archive[0].archive.supersededBy, 'ace-001', '归档条目指向留下的那条');
  assert.ok(seen.logs.some((m) => m.includes('轻量合并（不满额）成功')), '轻量合并要留痕：' + JSON.stringify(seen.logs));
  await cleanup(dir);
});

test('e｜adds===0 不跑轻量合并：本轮候选与既有条目完全重复（被丢弃）→ mergeAsk 一次都不许调', async () => {
  const dir = await makeDir('eager-no-adds');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    TWIN('ace-001', 3, '2026-01-01T00:00:00.000+08:00'),
    TWIN('ace-002', 4, '2026-02-01T00:00:00.000+08:00'),
  ]);
  const asks = [];
  const { deps } = makeDeps(file, {
    maxEntries: 60,
    // 候选与 ace-001 完全重复（normKey 相同）→ decideCandidates 丢弃它 → adds = 0。
    reflectRound: async () => [{ title: '批量改名前先列调用点', condition: TWIN_COND, action: TWIN_BODY, rationale: '' }],
    mergeAsk: async ({ userText }) => { asks.push(userText); return MERGED_JSON; },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(out.added.length, 0, '完全重复的候选被丢弃');
  assert.equal(asks.length, 0, '本轮没新增就不花 LLM 调用去整理');
  assert.equal(out.merged, 0);
  const parsed = await readPlaybook(file);
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-002'], '两条都原样留在活跃区');
  await cleanup(dir);
});

test('e｜阈值必须是 0.75 而不是满额的 0.5：中等相似（比率约 0.505）那对不许被轻量合并吃掉', async () => {
  const dir = await makeDir('eager-threshold');
  const file = path.join(dir, 'playbook.md');
  // 这一对的对称 BM25 比率实测 0.5050479223162428：过满额阈值 0.5，但不过轻量阈值 0.75。
  const DUP_A = E('ace-011', '批量改名前先列调用点', '先用 grep 列出该符号的全部调用点再执行重命名');
  const DUP_B = E('ace-012', '批量重命名要核对调用点', '先用 grep 列出该符号的全部调用点再执行重命名，改完再 grep 一次复核');
  await writePlaybook(file, [DUP_A, DUP_B]);
  const asks = [];
  const { deps } = makeDeps(file, {
    maxEntries: 60,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async ({ userText }) => { asks.push(userText); return MERGED_JSON; },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(asks.length, 0, '比率不过 0.75 就不该为它花一次 LLM 调用');
  assert.equal(out.merged, 0, '「顺手清理」不许把不相干的经验硬并');
  const parsed = await readPlaybook(file);
  const ids = parsed.entries.map((e) => e.id);
  assert.ok(ids.includes('ace-011') && ids.includes('ace-012'), '中等相似的两条都留在活跃区：' + JSON.stringify(ids));
  assert.equal(parsed.entries.find((e) => e.id === 'ace-011').title, DUP_A.title, '正文一个字都不许被改');
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive, [], '什么都没进归档');
  await cleanup(dir);
});

test('e｜轻量合并失败只 warn，绝不阻塞落盘（不满额路径照常写候选）', async () => {
  const dir = await makeDir('eager-throw');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [
    TWIN('ace-001', 3, '2026-01-01T00:00:00.000+08:00'),
    TWIN('ace-002', 4, '2026-02-01T00:00:00.000+08:00'),
  ]);
  const { deps, seen } = makeDeps(file, {
    maxEntries: 60,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async () => { throw new Error('LLM 超时'); },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(out.merged, 0, '一对都没合并成');
  assert.equal(out.added.length, 1, '轻量合并失败也照样把候选写进去');
  assert.ok(seen.logs.some((m) => m.includes('轻量合并失败')), '失败要留痕：' + JSON.stringify(seen.logs));
  assert.ok(!seen.logs.some((m) => m.includes('合并阶段整体失败')), 'planMerges 自己吞掉每对的错误，不该走到整体失败那一支');
  const parsed = await readPlaybook(file);
  assert.ok(parsed.entries.some((e) => e.id === out.added[0]), '新候选正常落盘');
  assert.deepEqual(
    parsed.entries.map((e) => e.id).sort(),
    ['ace-001', 'ace-002', out.added[0]].sort(),
    '失败的那一对谁都没丢、也没被改',
  );
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.deepEqual(archive, [], '失败的合并不许往归档文件里写 merged');
  await cleanup(dir);
});

test('e｜轻量合并最多 2 对（MERGE_EAGER_MAX_ROUNDS=2）：三对几乎同文时只合并两对', async () => {
  const dir = await makeDir('eager-max-rounds');
  const file = path.join(dir, 'playbook.md');
  const trio = [];
  for (let k = 0; k < 3; k += 1) {
    const body = TWIN_BODY + '（第 ' + k + ' 组）';
    for (const side of ['甲', '乙']) {
      trio.push({ ...E('ace-' + (k + 1) + '0' + (side === '甲' ? '1' : '2'), '组' + k + side, body), condition: TWIN_COND });
    }
  }
  assert.equal(trio.length, 6);
  await writePlaybook(file, trio);
  const asks = [];
  const { deps } = makeDeps(file, {
    maxEntries: 60,
    reflectRound: async () => [C('迁移前先在影子库试跑', '先把迁移脚本在影子库跑一遍再上生产')],
    mergeAsk: async ({ userText }) => { asks.push(userText); return MERGED_JSON; },
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });

  assert.equal(asks.length, 2, '不满额路径最多 2 轮（满额是 5 轮）：' + asks.length);
  assert.equal(out.merged, 2, '只合并 2 对');
  const archive = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
  assert.equal(archive.filter((e) => e.archive.reason === 'merged').length, 2, '归档里恰好 2 条 reason=merged');
  const parsed = await readPlaybook(file);
  assert.equal(parsed.entries.length, 5, '6 - 2（并走）+ 1（新候选）= 5');
  await cleanup(dir);
});

// —— j：候选过滤只剩「标题非空」这一条 ——

test('j｜空标题候选拒绝、非空标题一律放行（不再有长度上限/指代词/文件名规则）', async () => {
  const gate = acceptCandidates([
    { title: '', condition: '当 X 时', action: '做 Y', rationale: '' },
    { title: '   ', condition: '当 X 时', action: '做 Y', rationale: '' },
    { title: '见上文', condition: '条件', action: '做法', rationale: '' },
    { title: '本仓库里的 cli.ts 要改第三行', condition: '当改 cli.ts 时', action: '把第三行注释掉', rationale: '' },
    { title: '很长'.repeat(40), condition: '当很长时', action: '照做', rationale: '' },
  ]);
  assert.deepEqual(gate.rejected.map((r) => r.index), [0, 1], '只拒绝空标题');
  assert.equal(gate.rejected[0].reason, '空标题');
  assert.equal(gate.accepted.length, 3, '指代词、文件名、超长标题一律放行（唯一判据是标题非空）');

  const dir = await makeDir('gate-title');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, []);
  const { deps } = makeDeps(file, {
    reflectRound: async () => [
      { title: '', condition: '当 X 时', action: '做 Y', rationale: '' },
      { title: '见上文', condition: '当 X 时', action: '做 Y', rationale: '' },
    ],
  });
  const out = await runRecapPipeline(deps, { agent: { name: 'a' }, summary: '轨迹' });
  assert.equal(out.added.length, 1, '空标题被拒，另一条照常落盘');
  await cleanup(dir);
});

// —— P1-6：检索命中只记 hits，不进任何「回合」账本 ——

test('P1-6｜检索命中的等效动作（commitMeta + markHits）只动 hits：随后一回合复盘不会再改它', async () => {
  const dir = await makeDir('search-hits');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [E('ace-001', '编辑前先读', '先 read 再动手')]);
  const { deps, ledger, agent } = makeDeps(file, { reflectRound: async () => [] });
  // 1) 模拟 ace_playbook 的检索命中路径（生产同款：recordHits 内部就是这一次 commitMeta + markHits）
  const { commitMeta } = await import('../lib/commit.js');
  const snapshot = await readPlaybook(file);
  await commitMeta(file, { entries: snapshot.entries }, {
    ids: ['ace-001'],
    apply: (entries, safeIds) => {
      const res = markHits(entries, safeIds);
      return { entries: res.entries, changed: res.hit };
    },
  });
  const afterSearch = (await readPlaybook(file)).entries[0].meta;
  assert.equal(afterSearch.hits, 2, '检索命中要记 hits');
  assert.ok(STAMP_RE.test(afterSearch.lastHit), 'lastHit 是毫秒时间戳：' + afterSearch.lastHit);
  assert.deepEqual(ledger.peek(agent), [], '检索命中绝不许进回合账本（P1-6）');

// —— 第 39 轮：abort 检查点（只放锁外；锁内绝不抛中断）——

test('第39轮｜检查点①：读快照之前 abort → 不调 Reflector、手册一字不动', async () => {
  const dir = await makeDir('abort-1');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [E('ace-001', '旧经验', '做法')]);
  const before = await fs.readFile(file, 'utf8');
  const controller = new AbortController();
  controller.abort(new Error('复盘超过总时限'));
  let reflectCalls = 0;
  const { deps } = makeDeps(file, {
    reflectRound: async () => { reflectCalls += 1; return []; },
  });
  await assert.rejects(
    () => runRecapPipeline(deps, { agent: { name: 'test-agent' }, summary: 's', signal: controller.signal }),
    /复盘超过总时限/,
  );
  assert.equal(reflectCalls, 0, 'abort 后不该再调 Reflector');
  assert.equal(await fs.readFile(file, 'utf8'), before, 'abort 后手册必须一字未动');
  await cleanup(dir);
});

test('第39轮｜检查点②：合并之前 abort → 一次合并 LLM 都不花、手册不动', async () => {
  const dir = await makeDir('abort-2');
  const file = path.join(dir, 'playbook.md');
  // 满额：2 条 > 上限 1，逼出「先合并」路径（检查点②就在它前面）。
  await writePlaybook(file, [SIMILAR_A, SIMILAR_B]);
  const before = await fs.readFile(file, 'utf8');
  const controller = new AbortController();
  let mergeCalls = 0;
  const { deps } = makeDeps(file, {
    maxEntries: 1,
    reflectRound: async () => [C('新的经验', '做法')],
    mergeAsk: async () => { mergeCalls += 1; return MERGED_JSON; },
  });
  const pipeline = runRecapPipeline(deps, { agent: { name: 'test-agent' }, summary: 's', signal: controller.signal });
  // Reflector 那一次 await 之后 abort：合并与落盘都还没开始。
  await Promise.resolve();
  controller.abort(new Error('复盘超过总时限'));
  await assert.rejects(() => pipeline, /复盘超过总时限/);
  assert.equal(mergeCalls, 0, 'abort 后不该再花合并 LLM 调用');
  assert.equal(await fs.readFile(file, 'utf8'), before, 'abort 后手册必须一字未动（锁内没被中断）');
  await cleanup(dir);
});

test('第39轮｜没有 signal 的旧调用方式照常工作（向后兼容）', async () => {
  const dir = await makeDir('abort-none');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, []);
  const { deps, seen } = makeDeps(file, { reflectRound: async () => [C('兼容性经验', '做法')] });
  const out = await runRecapPipeline(deps, { agent: { name: 'test-agent' }, summary: 's' });
  assert.equal(out.added.length, 1, '不传 signal 必须照常落盘');
  assert.equal(seen.written.length, 1);
  const parsed = await readPlaybook(file);
  assert.ok(parsed.entries.some((e) => e.title === '兼容性经验'));
  await cleanup(dir);
});
  // 2) 随后一回合复盘：没有自动注入 → 命中计数不许再动
  await runRecapPipeline(deps, { agent, summary: '轨迹' });
  const afterRecap = (await readPlaybook(file)).entries[0].meta;
  assert.equal(afterRecap.hits, 2, '复盘没有注入 → 也不该再加命中');
  assert.equal('helpful' in afterRecap, false);
  assert.equal('harmful' in afterRecap, false);
  await cleanup(dir);
});

test('P1-6｜index.js 里没有把检索命中塞进回合账本的接线（noteEntryUsage 已删除）', async () => {
  const indexSource = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(!/noteEntryUsage\s*\(/.test(indexSource), '检索命中不许再写进回合账本（注释里可以提它，但不许再有调用）');
  assert.ok(/recordHits\(/.test(indexSource), '检索命中仍然要记 hits');
});

// —— 冲突与归档同批（report 4.4 第 8 条的进程内形态；真子进程形态见 tests/concurrency.test.mjs） ——

test('冲突与归档同批｜快照过期导致某条 op 冲突：其余 op 照常落盘，归档也照常生效', async () => {
  const dir = await makeDir('conflict-archive');
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await writePlaybook(file, [
    E('ace-001', '旧经验', '这条要被搬走', { hits: 0, created: '2026-01-01T00:00:00.000+08:00' }),
    E('ace-002', '好经验', '这条有用'),
  ]);
  const snapshotHook = { entries: (await readPlaybook(file)).entries.slice() };
  // 直接改盘模拟「另一个进程」：把 ace-002 的正文换掉（流水线的锁外快照里还是旧正文）
  const parsedNow = await readPlaybook(file);
  await fs.writeFile(file, serializePlaybook({
    header: parsedNow.header,
    entries: [parsedNow.entries[0], { ...parsedNow.entries[1], action: '被别人改过' }],
  }), 'utf8');
  const { commitOps } = await import('../lib/commit.js');
  const out = await commitOps(file, snapshotHook, [
    { op: 'update', id: 'ace-002', action: '我改的做法' },
    { op: 'add', title: '全新经验', condition: '条件-全新经验', action: '新的做法' },
  ], 60, {
    archiveFile,
    archive: () => [{ id: 'ace-001', reason: 'evicted', date: TODAY }],
  });
  assert.equal(out.conflicts.length, 1, '被并发改过的那条必须报冲突');
  assert.deepEqual(out.conflicts[0].id, 'ace-002');
  const parsed = await readPlaybook(file);
  assert.ok(parsed.entries.some((e) => e.title === '全新经验'), '不冲突的那条照常落盘');
  assert.equal(parsed.entries.find((e) => e.id === 'ace-002').action, '被别人改过', '冲突条目不许被静默覆盖');
  const archive = (await readArchiveSnapshot(archiveFile)).entries;
  assert.deepEqual(archive.map((e) => e.id), ['ace-001'], '归档不受冲突影响，同一次原子写里生效');
  assert.equal(archive[0].archive.reason, 'evicted');
  await cleanup(dir);
});
