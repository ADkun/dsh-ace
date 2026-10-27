// dsh-ace 单元测试：候选合并判定（C4.2）、软归档搬移（C4.3）与「最少使用淘汰」的提交层联动。
// 运行：npm test（node --test tests/）。全部是纯逻辑层 + 临时文件，不依赖宿主。
//
// 第 33 轮：正负评分（netScore / bumpScores）、三条归档判据（low-score / stale / decayed）、
// '## 归档区' 章节、pendingIds 时序约束全部删除。归档搬进独立文件 archive.md，
// 腾位只由 maxEntries 触发、按 hits 升序淘汰（lib/evict.js）。
// 这里删掉了绑旧判据的用例，并补了「淘汰进归档文件」「手册里永不出现归档区」两条新用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parsePlaybook, serializePlaybook, matchEntries, scoreEntries, applyOps,
  readIdHighWater, applyIdHighWater,
} from '../lib/playbook.js';
import { commitOps, commitCapacity } from '../lib/commit.js';
import {
  BREVITY_MAX_SHRINK_RATIO, dayString, bodyLength,
  decideCandidates, resolveSupersedes, applyArchiveMoves, shrinksTooMuch,
} from '../lib/archive.js';
import {
  readArchiveSnapshot, parseArchiveFile, serializeArchiveFile, initialArchiveHeader,
  appendArchivedEntries, maxArchivedIdNumber,
} from '../lib/archive-file.js';
import { dayOf } from '../lib/timestamp.js';
import { planEvictions, compareForEviction } from '../lib/evict.js';

const E = (id, title, condition, action, rationale, overrides = {}) => ({
  id, title, condition, action, rationale: rationale || '',
  meta: { created: '2026-01-01', updated: '2026-01-01', hits: 0, lastHit: '', ...overrides.meta },
  extraLines: overrides.extraLines || [],
});

const C = (title, condition, action, rationale) => ({ title, condition, action, rationale: rationale || '' });

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

const cleanup = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

// —— 归档搬移（纯函数层） ——

test('归档判据｜applyArchiveMoves：搬到归档、字段与元数据完整保留、永不物理删除', () => {
  const entries = [
    E('ace-001', 't1', 'c1', 'a1', 'r1', { meta: { hits: 7 } }),
    E('ace-002', 't2', 'c2', 'a2', ''),
  ];
  const out = applyArchiveMoves(entries, [], [{ id: 'ace-001', reason: 'evicted', date: '2026-10-24T00:00:00.000+08:00' }]);
  assert.deepEqual(out.entries.map((e) => e.id), ['ace-002']);
  assert.equal(out.archives.length, 1);
  const moved = out.archives[0];
  assert.equal(moved.id, 'ace-001');
  assert.equal(moved.condition, 'c1');
  assert.equal(moved.rationale, 'r1');
  assert.equal(moved.meta.hits, 7, '命中计数完整保留（它是唯一的淘汰依据，历史不许丢）');
  assert.deepEqual(moved.archive, { reason: 'evicted', date: '2026-10-24T00:00:00.000+08:00' });
  // moves 里对不上的 id 直接忽略（不抛错、不删条目）
  const untouched = applyArchiveMoves(entries, [], [{ id: 'ace-999', reason: 'evicted', date: '2026-10-24T00:00:00.000+08:00' }]);
  assert.equal(untouched.entries.length, 2);
  assert.deepEqual(untouched.moved, []);
});

// —— C4.2 候选合并判定的三个分支 ——

test('C4.2 分支1｜完全重复（normKey 相同）→ 丢弃候选，不改动任何条目', () => {
  const entries = [E('ace-001', '先读再改', '修改文件前', '先 read 再动手', '')];
  const out = decideCandidates(entries, [C('先读再改', '修改文件前', '先 read 再动手', '')]);
  assert.deepEqual(out.ops, [], '不产生任何操作');
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].reason, 'duplicate');
  assert.equal(out.dropped[0].title, '先读再改');
  assert.deepEqual(out.supersedes, []);
});

test('C4.2 分支2a｜候选不更长 → 旧条目被原地更新（id 与命中计数不变）', () => {
  // 旧做法「记下 pass fail skip 三个数再动手」被候选精炼成「记下三个数再动手」：
  // 候选更短但没到塌缩阈值（缩短 < 50%）→ 允许原地更新，id 与命中计数都不变。
  const entries = [E('ace-007', '先跑基线', '改代码前先跑一遍基线测试', '记下 pass fail skip 三个数再动手', '', { meta: { hits: 9, lastHit: '2026-10-01', created: '2026-01-01' } })];
  const candidate = C('先跑基线', '改代码前先跑一遍基线测试', '记下三个数再动手', '');
  assert.ok(bodyLength(candidate) < bodyLength(entries[0]), '候选必须不更长才测得到这一支');
  assert.ok(!shrinksTooMuch(entries[0], candidate), '且不能短到触发塌缩守卫');
  const out = decideCandidates(entries, [candidate]);
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'update', '候选不更长就走原地更新');
  assert.equal(out.ops[0].id, 'ace-007', '复用既有 id');
  assert.equal(out.ops[0].action, '记下三个数再动手');
  assert.deepEqual(out.supersedes, [], '不产生归档');
  assert.deepEqual(out.updates, ['ace-007']);
  assert.deepEqual(out.adds, []);
  // 命中计数是淘汰的唯一依据，update 绝不许重置它。
  const applied = applyOps(entries, out.ops, 100, 7);
  assert.equal(applied.entries[0].meta.hits, 9, 'update 不改命中计数');
});

test('P1-1｜候选正文塌缩（缩短超过 50%）→ 不覆盖，改为新增 + 旧条目 superseded 归档（旧正文可回溯）', () => {
  // 报告实测的那种塌缩：旧做法 47 字的具体操作被 4 字的泛泛之谈覆盖。
  const longAction = '运行 node --test tests/ 并把 pass / fail / skip 三个数抄进报告，改完再跑一次用同一口径对比。';
  const entries = [E('ace-002', '跑测试前先固定随机种子', '跑测试之前', longAction, '免得 flaky', { meta: { hits: 3 } })];
  const shrunk = C('跑测试前先固定随机种子', '跑测试之前', '固定种子', '免得 flaky');
  assert.ok(bodyLength(shrunk) < bodyLength(entries[0]) * (1 - BREVITY_MAX_SHRINK_RATIO), '候选必须缩短超过阈值才测得到这一支');

  const out = decideCandidates(entries, [shrunk]);
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'add', '候选正文塌缩时不许走原地覆盖');
  assert.deepEqual(out.updates, [], '不许原地更新旧条目');
  assert.equal(out.supersedes.length, 1, '旧条目必须以 superseded 归档，旧正文才可回溯');
  assert.equal(out.supersedes[0].oldId, 'ace-002');

  // 一路走到归档列表：旧正文一个字不丢地出现在 archives 里。
  const applied = applyOps(entries, out.ops, 100, 2);
  const added = applied.entries.filter((e) => applied.added.includes(e.id));
  const moves = resolveSupersedes(out.supersedes, out.ops, added, '2026-10-24');
  const archived = applyArchiveMoves(applied.entries, [], moves, '2026-10-24');
  assert.equal(archived.moved.length, 1);
  const old = archived.archives.find((e) => e.id === 'ace-002');
  assert.ok(old, '旧条目必须进归档（绝不物理删除）');
  assert.equal(old.action, longAction, '旧正文必须原样保留在归档里');
  assert.equal(old.archive.reason, 'superseded');
  assert.equal(old.archive.supersededBy, added[0].id, 'supersededBy 指向新条目');
  assert.deepEqual(archived.entries.map((e) => e.action), [shrunk.action], '活跃区只剩短候选');
});

test('P1-1｜候选只小幅缩短（未超阈值）→ 仍原地更新（守卫不误伤正常改写）', () => {
  const condition = '动手改任何代码之前，先跑一遍完整测试并记下 pass fail skip 三个数作为基准。';
  const action = '运行 node --test tests/ 并把 pass / fail / skip 三个数抄进报告，改完之后再跑一次用同一份口径对比。';
  const entries = [E('ace-008', '先跑基线再动手', condition, action, '盲改会返工', { meta: { hits: 4 } })];
  // 只把 action 里的「用同一份口径对比」改写成「对比」，缩短远小于 50%。
  const slightly = C('先跑基线再动手', condition, action.replace('用同一份口径对比', '对比'), '盲改会返工');
  assert.ok(bodyLength(slightly) >= bodyLength(entries[0]) * (1 - BREVITY_MAX_SHRINK_RATIO), '本用例要测的是「没超阈值」那一侧');
  const out = decideCandidates(entries, [slightly]);
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'update');
  assert.equal(out.ops[0].id, 'ace-008');
  assert.deepEqual(out.supersedes, [], '小幅精炼不归档旧条目');
});

test('P1-1｜shrinksTooMuch：阈值边界（恰好缩短 50% 不算塌缩，超过才算）', () => {
  assert.equal(BREVITY_MAX_SHRINK_RATIO, 0.5);
  // 旧正文总长 12（'t' + 'c' + '0123456789'），一半是 6。
  const old = E('ace-009', 't', 'c', '0123456789', '');
  assert.equal(shrinksTooMuch(old, C('t', 'c', '0123', '')), false, '恰好一半（6 字）：不算塌缩');
  assert.equal(shrinksTooMuch(old, C('t', 'c', '012', '')), true, '短于一半（5 字）：算塌缩');
  assert.equal(shrinksTooMuch(E('ace-010', '', '', '', ''), C('t', 'c', 'a', '')), false, '旧正文为空时不算塌缩');
});

test('C4.2 分支2b｜候选更长 → 新增新条目 + 旧条目按 superseded 归档', () => {
  const condition = '动手改任何代码之前，先跑一遍完整测试并记下 pass fail skip 三个数，作为后续对比的基准。';
  const action = '运行 node --test tests/ 并把 pass / fail / skip 三个数抄进报告；改完之后再跑一次，用同一份口径对比，而不是凭感觉判断有没有改坏。';
  const entries = [E('ace-003', '先跑基线再动手', condition, action, '')];
  const candidate = C('先跑基线再动手（含对比口径）', condition, action, '盲改会返工，返工的成本远高于先跑一次测试。');
  assert.ok(bodyLength(candidate) > bodyLength(entries[0]), '候选正文总长必须大于旧条目');
  const out = decideCandidates(entries, [candidate]);
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'add', '更完整的新版走新增');
  assert.equal(out.supersedes.length, 1);
  assert.equal(out.supersedes[0].oldId, 'ace-003');
  assert.equal(out.supersedes[0].key, out.ops[0].title + '\u241f' + out.ops[0].condition + '\u241f' + out.ops[0].action, 'supersedes 记下候选的 normKey，供之后对上新 id');
  // applyOps 分配好 id 之后才能写 supersededBy
  const applied = applyOps(entries, out.ops, 100, 3);
  const added = applied.entries.filter((e) => applied.added.includes(e.id));
  const moves = resolveSupersedes(out.supersedes, out.ops, added, '2026-10-24');
  assert.deepEqual(moves, [{ id: 'ace-003', reason: 'superseded', date: '2026-10-24', supersededBy: 'ace-004' }]);
});

test('C4.2 分支2c｜候选不更长 → 仍原地更新（不归档、不新增）', () => {
  const entries = [E('ace-003', '很长的旧标题内容', '很长的旧条件内容', '很长的旧做法内容', '很长的旧依据内容')];
  const out = decideCandidates(entries, [C('短标题', '很长的旧条件内容', '很长的旧做法内容', '')]);
  assert.ok(bodyLength(C('短标题', '很长的旧条件内容', '很长的旧做法内容', '')) < bodyLength(entries[0]), '候选必须更短才测得到这一支');
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'update');
  assert.equal(out.ops[0].id, 'ace-003');
  assert.deepEqual(out.supersedes, []);
});

test('C4.2 分支3｜都不命中 → 新增条目', () => {
  const entries = [E('ace-001', '完全不同的主题', '完全不同的条件', '完全不同的做法', '')];
  const out = decideCandidates(entries, [C('另一个主题', '另一个条件', '另一个做法', '')]);
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'add');
  assert.deepEqual(out.supersedes, []);
  assert.deepEqual(out.adds, [0]);
});

test('C4.2｜归档条目不参与合并比对（只拿活跃条目比对）', () => {
  // 调用方只传活跃条目；这里验证「同一候选对空手册就是新增」——
  // 即归档条目若被误传进来才会命中，而 index.js 只传 snapshot.entries。
  const out = decideCandidates([], [C('历史上有过的条目', '条件', '做法', '')]);
  assert.equal(out.ops[0].op, 'add');
  assert.deepEqual(out.dropped, []);
});

// —— 归档与提交层联动：先归档文件、后手册，同一次锁 ——

test('C4.3｜commitOps 的 archive 钩子：归档条目写进 archive.md，手册里不再出现归档区', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archivecommit-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] 从没命中过的条目',
    '- 条件：c1',
    '- 做法：a1',
    '- 元数据：created=2026-01-01 updated=2026-01-01 hits=0 lastHit=',
    '',
    '### [ace-002] 常用条目',
    '- 条件：c2',
    '- 做法：a2',
    '- 元数据：created=2026-10-20 updated=2026-10-20 hits=3 lastHit=2026-10-23',
    '',
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c3', action: 'a3' }], 100, {
    archiveFile,
    archive: ({ result }) => planEvictions(result.entries, 1, { date: '2026-10-24T09:00:00.000+08:00' }),
  });
  assert.deepEqual(out.result.archived, [{ id: 'ace-001', reason: 'evicted', supersededBy: '' }]);
  const onDisk = await fs.readFile(file, 'utf8');
  assert.ok(!onDisk.includes('## 归档区'), '手册文件里永远不再出现归档区章节');
  assert.ok(!onDisk.includes('- 归档：'), '手册文件里不再有归档行');
  assert.ok(onDisk.includes('新条目'), '同一次写入里新增的条目也在');
  const parsed = parsePlaybook(onDisk);
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-002', 'ace-003']);
  // 归档条目只出现在 archive.md，正文一个字不丢。
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id), ['ace-001']);
  assert.equal(archived.entries[0].archive.reason, 'evicted');
  assert.equal(archived.entries[0].meta.hits, 0, '归档条目元数据完整');
  assert.match(archived.entries[0].archive.date, STAMP_RE);
  await cleanup(dir);
});

test('C4.3｜归档只改归档文件时也要落盘（safe 为空但 archived 非空）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archiveonly-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] 从没命中过的条目',
    '- 条件：c1',
    '- 做法：a1',
    '- 元数据：created=2026-01-01 updated=2026-01-01 hits=0 lastHit=',
    '',
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  const out = await commitOps(file, { entries: snapshot.entries }, [], 100, {
    archiveFile,
    archive: ({ result }) => planEvictions(result.entries, 1, { date: '2026-10-24T09:00:00.000+08:00' }),
  });
  assert.deepEqual(out.result.archived, [{ id: 'ace-001', reason: 'evicted', supersededBy: '' }]);
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries, []);
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id), ['ace-001']);
  await cleanup(dir);
});

test('C4.3｜dayString 现在是毫秒时间戳（本地时区 ISO，字典序即时间序）', () => {
  const s = dayString(new Date(2026, 9, 24, 23, 30));
  assert.match(s, STAMP_RE, '落盘的时间戳必须是毫秒精度本地时区 ISO：' + s);
  assert.equal(dayOf(s), '2026-10-24', '取日期部分要用 lib/timestamp.js 的 dayOf，不是测试自己 slice');
  assert.equal(dayOf(dayString(new Date(2026, 0, 1, 0, 5))), '2026-01-01');
  // 跨日边界：23:30 与 00:05 是两个不同的日期，但都必须是「只有日期」的 10 字符形状。
  assert.equal(dayOf(dayString(new Date(2026, 9, 24, 23, 30))).length, 10);
  assert.notEqual(dayOf(dayString(new Date(2026, 9, 24, 23, 30))), dayOf(dayString(new Date(2026, 9, 25, 0, 5))));
});

// 界面「只到日」的**真**守护在 client 渲染侧：tests/client-entries.test.mjs 与
// tests/client-stats.test.mjs 里各有一条「经 client.js 真渲染，断言 10 字符日期」的用例
// （必修 4）。这里只钉住时间戳本身的形状与 dayOf 的取值，不再冒充界面断言。

test('C4.3b｜dayOf 对毫秒戳 / 旧日期 / 空值 / 垃圾值的口径（界面截断所依赖的底层语义）', () => {
  assert.equal(dayOf('2026-10-25T06:12:33.412+08:00'), '2026-10-25', '毫秒戳取日期部分');
  assert.equal(dayOf('2026-10-25'), '2026-10-25', '旧格式原样取');
  assert.equal(dayOf(''), '', '空值取不到 → 空串（界面侧再兜成 —）');
  assert.equal(dayOf(null), '', 'null 取不到 → 空串');
  assert.equal(dayOf('不是时间'), '', '垃圾值取不到 → 空串，绝不抛错');
});

// —— C4.1 判定权收回：源码级断言（index.js 依赖宿主，无法 import） ——

test('C4.1｜不再引用 Curator，判定 / 淘汰 / 合并全部走代码（index.js + recap-pipeline.js 两处源码级确认）', async () => {
  // 复盘主体（executeRecap 的实现）在 lib/recap-pipeline.js —— 它零宿主依赖，行为由
  // tests/recap-pipeline.test.mjs 真跑整链钉住；这里只补一层「接线没被搬歪」的源码级确认。
  const indexSource = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const pipelineSource = await fs.readFile(new URL('../lib/recap-pipeline.js', import.meta.url), 'utf8');
  const promptsSource = await fs.readFile(new URL('../lib/prompts.js', import.meta.url), 'utf8');
  assert.ok(!/CURATOR_SYSTEM/.test(indexSource), 'index.js 不许再引用 CURATOR_SYSTEM');
  assert.ok(!/curatorUserInput/.test(indexSource), 'index.js 不许再引用 curatorUserInput');
  assert.ok(!/export const CURATOR_SYSTEM/.test(promptsSource), 'prompts.js 的 Curator 提示词已删除');
  assert.ok(/decideCandidates\(/.test(indexSource), 'ace_curate 必须走代码判定');
  assert.ok(/decideCandidates\(/.test(pipelineSource), '复盘主体必须走代码判定');
  assert.ok(/resolveSupersedes\(/.test(pipelineSource), 'superseded 归档必须接进提交流程');
  assert.ok(/planEvictions/.test(pipelineSource), '最少使用淘汰必须接进提交流程');
  assert.ok(/evict: planEvictions/.test(pipelineSource), '淘汰计划必须以 evict 钩子交给 commitOps');
  assert.ok(/planMerges\(/.test(pipelineSource), 'LLM 合并必须接进提交流程');
  assert.ok(/acceptCandidates\(/.test(pipelineSource), '候选的唯一闸门是「标题非空」');
  assert.ok(!/scanArchives\(/.test(pipelineSource), '归档三判据已删除，流水线里不许再扫低分/过期');
  assert.ok(/archive: makeArchivePlan\(/.test(pipelineSource), '归档必须走 commitOps 的同一次锁');
  assert.ok(/runRecapPipeline\(/.test(indexSource), 'executeRecap 必须委托给复盘主体');
});

// —— 淘汰（用户用例 e/f 的一部分，纯函数层；提交层见下） ——

test('守护①｜同 hits 时老条目先走（compareForEviction：hits 升序 → created 更早先走 → id 数字升序）', () => {
  // 守护用例之一（报告点名）。三条同 hits=2 的条目里，**编号顺序与创建顺序故意相反**：
  // ace-030 建得最早、ace-010 最晚，所以「正确顺序」既不是 id 升序也不是文件顺序，
  // 只可能是 created 升序。任何把 created 判据去掉 / 换成随机 / 换成 id 兜底的改动都会变红。
  const list = [
    E('ace-030', 'hits 相同、建得最早', 'c', 'a', '', { meta: { hits: 2, created: '2026-01-01T00:00:00.000+08:00' } }),
    E('ace-010', 'hits 相同、建得最晚', 'c', 'a', '', { meta: { hits: 2, created: '2026-05-01T00:00:00.000+08:00' } }),
    E('ace-020', 'hits 相同、建在中间', 'c', 'a', '', { meta: { hits: 2, created: '2026-03-01T00:00:00.000+08:00' } }),
    E('ace-004', 'hits 最少', 'c', 'a', '', { meta: { hits: 0, created: '2026-09-01T00:00:00.000+08:00' } }),
    E('ace-007', 'hits 最多', 'c', 'a', '', { meta: { hits: 9, created: '2026-01-01T00:00:00.000+08:00' } }),
  ];
  const sorted = list.slice().sort(compareForEviction).map((e) => e.id);
  assert.deepEqual(sorted, ['ace-004', 'ace-030', 'ace-020', 'ace-010', 'ace-007'], 'hits 少先走；同 hits 时 created 早的先走；再并列才看 id');
  // planEvictions 必须吃掉同一个顺序（不许自己再排一遍），且实战里先走的就是那条老的。
  assert.deepEqual(
    planEvictions(list, 2, { date: '2026-10-24T09:00:00.000+08:00' }).map((m) => m.id),
    ['ace-004', 'ace-030'],
    '腾位时淘汰的必须是 hits 最少 + 同 hits 里最老的那条',
  );
});

test('e｜同 hits 且同 created → id 数字升序（不是字典序，也不是随机）', () => {
  const same = '2026-03-01T12:00:00.000+08:00';
  const list = [
    E('ace-100', 't', 'c', 'a', '', { meta: { hits: 1, created: same } }),
    E('ace-009', 't', 'c', 'a', '', { meta: { hits: 1, created: same } }),
    E('ace-020', 't', 'c', 'a', '', { meta: { hits: 1, created: same } }),
  ];
  assert.deepEqual(list.slice().sort(compareForEviction).map((e) => e.id), ['ace-009', 'ace-020', 'ace-100']);
  // planEvictions 必须用同一个顺序（不许自己再排一遍）
  assert.deepEqual(planEvictions(list, 2, { date: '2026-10-24T09:00:00.000+08:00' }).map((m) => m.id), ['ace-009', 'ace-020']);
});

// —— f：被淘汰条目进归档文件、活跃区腾位、新条目正常落盘 ——

test('f｜满额淘汰：hits 最少的两条进 archive.md（reason=evicted），活跃区腾位、新条目正常落盘', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-evict-commit-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  const body = (id, title, hits, created) => [
    '### [' + id + '] ' + title,
    '- 条件：c-' + id,
    '- 做法：a-' + id,
    '- 元数据：created=' + created + ' updated=' + created + ' hits=' + hits + ' lastHit=',
    '',
  ];
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    ...body('ace-001', '命中 5 次', 5, '2026-01-01T00:00:00.000+08:00'),
    ...body('ace-002', '命中 1 次', 1, '2026-06-01T00:00:00.000+08:00'),
    ...body('ace-003', '命中 3 次', 3, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  // 上限 2 条，再新增 1 条 → 4 条超 2 条：淘汰 2 条（hits 最少的 ace-002、ace-003）
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 2, {
    archiveFile,
    evict: planEvictions,
    today: '2026-10-24T09:00:00.000+08:00',
  });
  assert.deepEqual(out.result.archived.map((a) => a.id + '/' + a.reason), ['ace-002/evicted', 'ace-003/evicted']);
  assert.deepEqual(out.result.entries.map((e) => e.id), ['ace-001', 'ace-004'], '活跃区腾到位：只剩 hits 最多的 + 新增的');

  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-004'], '新条目正常落盘');
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('## 归档区'), '手册里没有归档区章节');
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id).sort(), ['ace-002', 'ace-003'], '被淘汰的搬进 archive.md');
  assert.ok(archived.entries.every((e) => e.archive.reason === 'evicted'));
  assert.equal(archived.entries.find((e) => e.id === 'ace-002').meta.hits, 1, '归档保留命中计数（软删除，绝不物理删除）');
  // 编号高水位：归档文件里用过的编号不许被复用（新增的是 ace-004，不是 ace-002）
  assert.equal(parsed.entries.find((e) => e.id === 'ace-004').id, 'ace-004');
  assert.equal(readIdHighWater(parsed), 4, '高水位把归档文件的编号也算进去');
  await cleanup(dir);
});

test('f｜commitCapacity（0 候选回合的容量治理）：超限就按 hits 淘汰，没搬移则不写盘', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-evict-capacity-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  const body = (id, hits) => [
    '### [' + id + '] t-' + id,
    '- 条件：c-' + id,
    '- 做法：a-' + id,
    '- 元数据：created=2026-01-01T00:00:00.000+08:00 updated=2026-01-01T00:00:00.000+08:00 hits=' + hits + ' lastHit=',
    '',
  ];
  await fs.writeFile(file, ['# ACE 操作手册', '', ...body('ace-001', 9), ...body('ace-002', 0), ...body('ace-003', 4)].join('\n') + '\n', 'utf8');

  // ① 上限 3 条、活跃正好 3 条 → 不需要搬移，一个字节都不写。
  const before = await fs.readFile(file, 'utf8');
  const noop = await commitCapacity(file, { archiveFile, maxEntries: 3, evict: planEvictions, today: '2026-10-24T09:00:00.000+08:00' });
  assert.deepEqual(noop.archived, []);
  assert.equal(await fs.readFile(file, 'utf8'), before, '没有搬移时绝不空写一遍文件');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['playbook.md'], '不写盘时连归档文件都不创建');

  // ② 上限降到 2 条 → 淘汰 hits 最少的那条（ace-002）。
  const swept = await commitCapacity(file, { archiveFile, maxEntries: 2, evict: planEvictions, today: '2026-10-24T09:00:00.000+08:00' });
  assert.deepEqual(swept.archived.map((a) => a.id + '/' + a.reason), ['ace-002/evicted']);
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-003']);
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id), ['ace-002']);
  await cleanup(dir);
});

// —— g：手册文件里永不出现 '## 归档区'；归档条目只出现在 archive.md ——

test('g｜手册里永不出现 ## 归档区：旧手册残留的归档区章节写回时被清掉，条目不再被当成归档吞掉', async () => {
  // 旧手册（第 33 轮之前）末尾有 '## 归档区' 与归档条目。第 33 轮起 parsePlaybook 不认这个章节：
  // 标题行只是一行普通文本（落进 header/extraLines），后面的条目仍是**活跃条目** ——
  // 宁可视作活跃也不丢正文。序列化不再写这个章节，所以写回后章节标题就没了。
  const legacy = [
    '# ACE 操作手册',
    '',
    '### [ace-001] 活跃条目',
    '- 条件：c1',
    '- 做法：a1',
    '- 元数据：created=2026-01-01 updated=2026-01-01 hits=1 lastHit=2026-01-02',
    '',
    '## 归档区',
    '### [ace-002] 旧归档条目',
    '- 条件：c2',
    '- 做法：a2',
    '- 元数据：created=2026-01-01 updated=2026-01-01 hits=0 lastHit=',
    '- 归档：reason=low-score date=2026-10-01',
    '',
  ].join('\n') + '\n';
  const parsed = parsePlaybook(legacy);
  assert.equal(parsed.entries.length, 2, '两段都是条目（归档区不再被特殊对待，正文一个字不丢）');
  assert.equal('archives' in parsed, false, 'parsePlaybook 不再返回 archives');
  assert.equal('archiveExtra' in parsed, false, 'parsePlaybook 不再返回 archiveExtra');
  const text = serializePlaybook(parsed);
  assert.ok(!text.includes('## 归档区'), '写回时不再输出归档区章节');
  assert.ok(!text.includes('- 归档：'), '写回时不再输出归档行');
  assert.ok(text.includes('旧归档条目'), '条目正文仍在（绝不物理删除）');
});

test('g｜归档文件格式与手册同构：parse → serialize 往返幂等，归档行带 reason/date/supersededBy', () => {
  const header = initialArchiveHeader();
  const entries = [
    { ...E('ace-002', '归档条目 alpha', 'c2', 'a2', 'r2', { meta: { hits: 4 } }), archived: true, archive: { reason: 'evicted', date: '2026-10-25T06:12:33.412+08:00' } },
    { ...E('ace-003', '被合并掉的条目 beta', 'c3', 'a3', '', {}), archived: true, archive: { reason: 'merged', date: '2026-10-25T06:13:00.000+08:00', supersededBy: 'ace-002' } },
  ];
  const text = serializeArchiveFile({ header, entries });
  assert.match(text, /^- 归档：reason=evicted date=2026-10-25T06:12:33\.412\+08:00$/m);
  assert.match(text, /^- 归档：reason=merged date=2026-10-25T06:13:00\.000\+08:00 supersededBy=ace-002$/m);
  const back = parseArchiveFile(text);
  assert.deepEqual(back.entries.map((e) => e.id), ['ace-002', 'ace-003']);
  assert.deepEqual(back.entries[0].archive, { reason: 'evicted', date: '2026-10-25T06:12:33.412+08:00', supersededBy: '' });
  assert.equal(back.entries[0].meta.hits, 4);
  assert.ok(back.entries.every((e) => e.archived === true));
  assert.equal(serializeArchiveFile(back), text, '往返必须逐字节幂等');
});

test('g｜归档文件写入不留残渣（withExclusiveLock + writeFileAtomic：目录里只有两份 .md）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archive-atomic-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    '### [ace-001] 只有一条', '- 条件：c', '- 做法：a',
    '- 元数据：created=2026-01-01T00:00:00.000+08:00 updated=2026-01-01T00:00:00.000+08:00 hits=0 lastHit=', '',
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '第二条', condition: 'c2', action: 'a2' }], 1, {
    archiveFile, evict: planEvictions, today: '2026-10-24T09:00:00.000+08:00',
  });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['archive.md', 'playbook.md'], '写完不许留下 .tmp 或 .lock 残渣');
  await cleanup(dir);
});

// —— h：归档写不进去 → 手册一个字都不写（必修 1）、锁内先归档后手册（必修 2） ——
//
// 造法：把 archive.md 建成一个**目录**，让 appendArchivedEntries 内部的读/写都抛 EISDIR。
// 可观测量只有三个（禁止源码正则断言）：① 调用抛错；② 手册文件**字节完全未变**；
// ③ 归档里没有新条目。第②项正是「锁内先归档、后手册」的钉子：若那两行对调，
// 手册会先被写坏（新条目落盘、被淘汰的条目蒸发、高水位标记被写回），再在写归档时抛错。

const EVICT_STAMP = '2026-10-24T09:00:00.000+08:00';

/** 手写一条手册/归档条目的正文块（不写标记行，模拟人手维护的文件）。 */
const mdBody = (id, title, hits, created) => [
  '### [' + id + '] ' + title,
  '- 条件：c-' + id,
  '- 做法：a-' + id,
  '- 元数据：created=' + created + ' updated=' + created + ' hits=' + hits + ' lastHit=',
  '',
];

test('h1｜必修1：归档不可写（archive.md 是目录）→ commitOps 抛错，手册字节完全未变、归档无新条目', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-eisdir-ops-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 5 次', 5, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 1 次', 1, '2026-06-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 3 次', 3, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  await fs.mkdir(archiveFile); // 目录冒充归档文件：读/写必抛 EISDIR
  const before = await fs.readFile(file);

  let threw = null;
  try {
    await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '不该落盘的新条目', condition: 'c9', action: 'a9' }], 2, {
      archiveFile, evict: planEvictions, today: EVICT_STAMP,
    });
  } catch (e) { threw = e; }
  assert.ok(threw, '归档写不进去时必须抛错（绝不许吞掉 —— 吞掉等于活跃条目蒸发、归档一字未写）');
  assert.match(String(threw.code || threw.message), /EISDIR/);

  const after = await fs.readFile(file);
  assert.ok(after.equals(before), '手册文件必须**字节完全未变**（不是「条数没变」——高水位标记也不许写）');
  const still = parsePlaybook(after.toString('utf8'));
  assert.deepEqual(still.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-003'], '被淘汰的条目一条都不许蒸发');
  assert.ok(!still.entries.some((e) => e.title === '不该落盘的新条目'), '本批候选不许落盘');
  assert.equal((await fs.stat(archiveFile)).isDirectory(), true, '归档仍是那个目录：一条都没写进去');
  assert.deepEqual(await fs.readdir(archiveFile), [], '归档里没有新条目');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['archive.md', 'playbook.md'], '临时文件与锁文件都已清理');
  await cleanup(dir);
});

test('h2｜必修1：归档不可写 → commitCapacity 同样抛错且手册字节完全未变（同源两行的第二条路径）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-eisdir-capacity-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 9 次', 9, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 0 次', 0, '2026-06-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 4 次', 4, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  await fs.mkdir(archiveFile);
  const before = await fs.readFile(file);

  let threw = null;
  try {
    await commitCapacity(file, { archiveFile, maxEntries: 2, evict: planEvictions, today: EVICT_STAMP });
  } catch (e) { threw = e; }
  assert.ok(threw, '腾位路径的归档写失败同样必须抛错');
  assert.match(String(threw.code || threw.message), /EISDIR/);

  const after = await fs.readFile(file);
  assert.ok(after.equals(before), '手册字节必须完全未变');
  const still = parsePlaybook(after.toString('utf8'));
  assert.deepEqual(still.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-003'], '被淘汰的 ace-002 不许从活跃区消失');
  assert.deepEqual(await fs.readdir(archiveFile), [], '归档里没有新条目');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['archive.md', 'playbook.md']);
  await cleanup(dir);
});

test('h3｜必修2：锁内顺序是先归档、后手册 —— 写归档失败时手册连高水位标记都没被写回', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-order-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  // 手写手册、**故意不写高水位标记行**：一旦手册被写坏，readIdHighWater 会从 0 变成 4，
  // 这个可观测量直接暴露顺序反了。
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 9 次', 9, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 0 次', 0, '2026-02-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 1 次', 1, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.equal(readIdHighWater(snapshot), 0, '起手没有高水位标记行');
  await fs.mkdir(archiveFile);
  const before = await fs.readFile(file);

  let threw = null;
  try {
    await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 2, {
      archiveFile, evict: planEvictions, today: EVICT_STAMP,
    });
  } catch (e) { threw = e; }
  assert.ok(threw, '归档写不进去 → 整体抛错');
  const after = await fs.readFile(file);
  assert.ok(after.equals(before), '手册字节完全未变：若实现调换成「先写手册、后写归档」，这一条会立刻变红');
  const still = parsePlaybook(after.toString('utf8'));
  assert.equal(readIdHighWater(still), 0, '高水位标记没有被写回（顺序反了就会写成 4）');
  assert.deepEqual(still.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-003'], '淘汰不许先生效');
  assert.ok(!after.toString('utf8').includes('ace-004'), '候选编号不许先落盘');
  await cleanup(dir);
});

// —— h4/h5：编号高水位必须把归档文件的最大编号算进去（必修 3） ——

test('h4｜必修3：归档里有更大编号（新格式 ace-778 + 旧格式 ace-500）时，手写无标记行手册的新条目编号必须更大', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-highwater-archive-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  // 手写手册：没有高水位标记行，只有一条 ace-001。
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '现存唯一一条', 1, '2026-01-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  // 归档：一条新格式（能被 parseArchiveFile 解析出 ace-778）+ 一条旧格式
  // （### ace-500 过不了 entry-format 的 HEADING_RE，解析结果里看不见，但编号确实被用掉了）。
  // 正文里还埋了一个 ace-999 —— 它**不是标题行**，绝不许被算进高水位（这就是边界）。
  await fs.writeFile(archiveFile, [
    '# ACE 归档区', '',
    '### [ace-778] 新格式归档条目',
    '- 条件：c778',
    '- 做法：a778',
    '- 元数据：created=2026-01-02T00:00:00.000+08:00 updated=2026-01-02T00:00:00.000+08:00 hits=2 lastHit=',
    '- 归档：reason=evicted date=2026-10-01T00:00:00.000+08:00',
    '',
    '### ace-500 旧格式条目（标题行不带方括号，解析不出来）',
    '- 条件：c500',
    '- 做法：a500',
    '- 元数据：created=2026-01-03 updated=2026-01-03 hits=0 lastHit=',
    '',
    '### [ace-601] 正文里提到 ace-999 但那是依据、不是标题',
    '- 条件：c601',
    '- 做法：a601',
    '- 依据：参考 ace-999 那条（不是标题行，不许算进高水位）',
    '- 元数据：created=2026-01-04T00:00:00.000+08:00 updated=2026-01-04T00:00:00.000+08:00 hits=0 lastHit=',
    '- 归档：reason=evicted date=2026-10-01T00:00:00.000+08:00',
    '',
  ].join('\n') + '\n', 'utf8');
  const parsedArchive = parseArchiveFile(await fs.readFile(archiveFile, 'utf8'));
  assert.deepEqual(parsedArchive.entries.map((e) => e.id), ['ace-778', 'ace-601'], '旧格式那条解析不出来（这正是盲区的来源）');
  assert.equal(maxArchivedIdNumber(await fs.readFile(archiveFile, 'utf8')), 778, '扫原文标题行：旧格式 ace-500 也算，正文里的 ace-999 不算');

  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
    archiveFile, evict: planEvictions, today: EVICT_STAMP,
  });
  const newId = out.result.added[0];
  const n = Number(/^ace-(\d+)$/.exec(newId)[1]);
  assert.ok(n > 778, '新编号必须大于归档里的最大编号（' + newId + '）');
  assert.ok(n < 1000, '正文里偶然出现的 ace-999 不算（只扫标题行），否则会凭空跳号');
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.ok(parsed.entries.some((e) => e.id === newId), '新条目正常落盘');
  await cleanup(dir);
});

test('h5｜必修3：满额淘汰 + 同批新增 → 新编号不复用刚被淘汰的号（高水位在淘汰之后重算）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-highwater-evict-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  // 手写手册、无标记行：高水位只能靠「归档原文 + 现存编号」兜底。
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 9 次', 9, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 0 次', 0, '2026-02-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 2 次', 2, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  // 上限 2、再新增 1 条 → 需要腾 2 位：被淘汰的是 ace-002 与 ace-003（hits 最少的）。
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 2, {
    archiveFile, evict: planEvictions, today: EVICT_STAMP,
  });
  assert.deepEqual(out.result.archived.map((a) => a.id), ['ace-002', 'ace-003'], '前两位是 hits 最少的');
  const newId = out.result.added[0];
  assert.equal(newId, 'ace-004', '新编号必须大于被淘汰的 ace-002/ace-003');
  assert.ok(!['ace-002', 'ace-003'].includes(newId), '绝不复用刚被淘汰的编号');
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-004']);
  assert.equal(readIdHighWater(parsed), 4, '高水位取「淘汰 + 新增」之后的最大编号');
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id).sort(), ['ace-002', 'ace-003']);
  assert.ok(archived.entries.every((e) => e.archive.reason === 'evicted'));
  await cleanup(dir);
});

// —— i：淘汰计划失败不许整批拒绝，走内置确定性兜底（建议修 6） ——

test('i1｜建议修6：淘汰计划抛错 → 内置兜底照常腾位，候选落盘、被淘汰条目进 archive.md、日志写明兜底', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-evict-fallback-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 5 次', 5, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 0 次', 0, '2026-06-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 1 次', 1, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  const logs = [];
  const logger = { info: (m) => logs.push('info:' + m), warn: (m) => logs.push('warn:' + m) };
  const boom = () => { throw new Error('evict boomed'); };
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 2, {
    archiveFile, evict: boom, today: EVICT_STAMP, logger,
  });
  // ① 候选照常落盘（绝不整批拒绝）
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-004'], '候选必须落盘，不许整批拒绝');
  // ② 兜底用的判据与 lib/evict.js 完全一致（同一全序、确定性、不随机）
  assert.deepEqual(out.result.archived.map((a) => a.id), ['ace-002', 'ace-003']);
  assert.deepEqual(
    out.result.archived.map((a) => a.id),
    planEvictions(snapshot.entries, 2, { date: EVICT_STAMP }).map((m) => m.id),
    '兜底顺序必须与 planEvictions 逐条相同',
  );
  // ③ 被淘汰条目进归档文件，reason=evicted
  const archived = await readArchiveSnapshot(archiveFile);
  assert.deepEqual(archived.entries.map((e) => e.id).sort(), ['ace-002', 'ace-003']);
  assert.ok(archived.entries.every((e) => e.archive.reason === 'evicted'));
  // ④ 日志写明走了兜底
  assert.ok(logs.some((m) => m.includes('淘汰计划失败') && m.includes('兜底')), '日志必须写明走了内置兜底：' + JSON.stringify(logs));
  await cleanup(dir);
});

test('i2｜建议修6：淘汰计划返回不可用结果（不是数组）→ 同样走兜底，候选照常落盘', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-evict-fallback-useless-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 5 次', 5, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '命中 0 次', 0, '2026-06-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '命中 1 次', 1, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  const logs = [];
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 2, {
    archiveFile, evict: () => undefined, today: EVICT_STAMP, logger: { warn: (m) => logs.push(m) },
  });
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-004'], '候选照常落盘');
  assert.deepEqual(out.result.archived.map((a) => a.id), ['ace-002', 'ace-003'], '兜底腾出同样的位数');
  assert.ok(logs.some((m) => m.includes('兜底')));
  await cleanup(dir);
});

// —— j：缺陷 4（第 40 轮）——「归档写成功、手册写失败」留下的错位必须自愈 ——
//
// 现场（lib/commit.js 的 commitOps）：锁内顺序是「先 appendArchivedEntries 写 archive.md，
// 再 writeFileAtomic 写手册」。手册那一步真失败之后，盘上留下的是错位 —— 归档文件说它已经归档，
// 手册活跃区还列着它。后果有两个：下一轮复盘会把它**再归档一次**（重复归档），人也分不清哪边是真的。
//
// 修法没有动锁内顺序（红线：先归档、后手册）。用的是红线 13 的单向契约：归档条目只存在于
// archive.md，手册活跃区里**永远不出现**它。归档是先写的那一份、是既成事实，所以下一次提交在锁内
// 把「归档里已经有、活跃区还列着」的条目从活跃区摘掉；条目正文仍在 archive.md 里，
// 一条都没有被物理删除（红线 7），同一条 id 也不会再被归档一次。自愈动作必须留一行 dsh-ace 日志（红线 9）。
//
// 错位怎么造：archive.md 里先写好同 id 的归档条目，手册里仍列着它 —— 这正是手册写失败之后的盘上状态。
// 这里不真实复现 EPERM：占住手册文件会让 writeFileAtomic 连临时文件 rename 都失败（见
// tests/playbook.test.mjs:468-497），那样只会测到「整体抛错」，测不到「下一次提交自愈」。

test('j1｜缺陷4：归档里已有、手册活跃区还列着的错位条目 → 下一次 commitOps 把它从活跃区摘掉（不重复归档、不物理删除）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-dup-archive-ops-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '还在用的条', 5, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '已经进归档的条', 1, '2026-06-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  // 归档里已经有完整的 ace-002（＝那一次手册写失败留下的既成事实）。
  await appendArchivedEntries(archiveFile, [{
    id: 'ace-002',
    title: '已经进归档的条',
    condition: 'c-ace-002',
    action: 'a-ace-002',
    rationale: '',
    meta: { created: '2026-06-01T00:00:00.000+08:00', updated: '2026-06-01T00:00:00.000+08:00', hits: 1, lastHit: '' },
    archive: { reason: 'evicted', date: EVICT_STAMP, supersededBy: '' },
  }], { highWater: 2 });
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(snapshot.entries.map((e) => e.id), ['ace-001', 'ace-002'], '起手手册活跃区还列着已归档的 ace-002');
  assert.equal((await readArchiveSnapshot(archiveFile)).entries.length, 1, '起手归档里已经有一条');

  const logs = [];
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 5, {
    archiveFile, today: EVICT_STAMP, logger: { warn: (m) => logs.push(m) },
  });

  // ① 错位被摘掉：活跃区不再出现 ace-002，本批候选照常落盘。
  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-003'], '已归档的 ace-002 必须从活跃区摘掉，候选照常落盘');
  // ② 不重复归档：归档里还是只有一条 ace-002，正文是原来那一份。
  const archiveAfter = (await readArchiveSnapshot(archiveFile)).entries;
  assert.equal(archiveAfter.length, 1, '归档里不许再多出一条 ace-002（不重复归档）');
  assert.equal(archiveAfter[0].id, 'ace-002');
  assert.equal(archiveAfter[0].condition, 'c-ace-002', '归档里那条的正文必须原样还在');
  // ③ 不物理删除：正文在归档文件里，且只有一份（红线 7 / 13）。
  const archiveText = await fs.readFile(archiveFile, 'utf8');
  const hits = archiveText.match(/###\s*\[?ace-002\]?\s*已经进归档的条/g) || [];
  assert.equal(hits.length, 1, '归档里 ace-002 的正文必须还在且只有一份：' + JSON.stringify(hits));
  // ④ 本次没有被「再归档」一次：result.archived 里不出现 ace-002。
  assert.deepEqual((out.result.archived || []).map((a) => a.id), [], '同一条 id 不许再被归档一次');
  // ⑤ 红线 9：自愈动作有一行 dsh-ace 日志，人能看出发生过什么。
  assert.ok(
    logs.some((m) => m.includes('dsh-ace:') && m.includes('ace-002')),
    '自愈必须留一行 dsh-ace 日志：' + JSON.stringify(logs),
  );
  await cleanup(dir);
});

test('j2｜缺陷4：同一种错位在 commitCapacity 上也必须自愈（0 候选回合的腾位路径）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-dup-archive-cap-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...mdBody('ace-001', '命中 9 次', 9, '2026-01-01T00:00:00.000+08:00'),
    ...mdBody('ace-002', '已经进归档的条', 0, '2026-02-01T00:00:00.000+08:00'),
    ...mdBody('ace-003', '还在用的条', 4, '2026-03-01T00:00:00.000+08:00'),
  ].join('\n') + '\n', 'utf8');
  await appendArchivedEntries(archiveFile, [{
    id: 'ace-002',
    title: '已经进归档的条',
    condition: 'c-ace-002',
    action: 'a-ace-002',
    rationale: '',
    meta: { created: '2026-02-01T00:00:00.000+08:00', updated: '2026-02-01T00:00:00.000+08:00', hits: 0, lastHit: '' },
    archive: { reason: 'evicted', date: EVICT_STAMP, supersededBy: '' },
  }], { highWater: 3 });
  const before = await fs.readFile(file, 'utf8');
  assert.ok(before.includes('ace-002'), '起手手册里还列着已归档的 ace-002');

  const logs = [];
  const out = await commitCapacity(file, {
    archiveFile, maxEntries: 2, evict: planEvictions, today: EVICT_STAMP, logger: { warn: (m) => logs.push(m) },
  });

  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-003'], '错位条目必须被摘掉（摘掉后正好回到 maxEntries=2，无需再淘汰）');
  assert.deepEqual((out.archived || []).map((a) => a.id), [], '摘掉错位不算一次归档动作，不许再往归档里写一遍');
  assert.equal((await readArchiveSnapshot(archiveFile)).entries.length, 1, '归档里仍只有原来那一条');
  assert.ok(
    logs.some((m) => m.includes('dsh-ace:') && m.includes('ace-002')),
    '腾位路径的自愈同样要留一行 dsh-ace 日志：' + JSON.stringify(logs),
  );
  await cleanup(dir);
});

// —— j3 / j4：对账口径只认「id + 正文全同」（第 41 轮，审计风险 1）——
//
// 症状：j1/j2 的对账只按 **id** 匹配。archive.md 里若存在同 id 但正文不同的条目
// （手工编辑 / 编号复用 / 旧快照覆盖），活跃区那一条的正文会被**物理抹掉** ——
// 归档里躺着的是另一份正文，盘上任何文件都不再有活跃区那一份，而对外承诺是
// 「一条都没丢」。审计用 work/m12c.mjs 实测到过这个反例（BEFORE/AFTER 原文对得上）。
//
// 修法：只有「id 相同 **且** title/condition/action/rationale 全同」才摘（那是真正的
// 「归档写成功、手册写失败」错位）；同 id 正文不同的一律**保留活跃区那条**并 warn。
// 下面两条用例把两个方向同时钉住：真错位照摘、正文不同的绝不摘。

test('j3｜缺陷4（第 41 轮）：archive.md 里同 id 但正文不同的条目绝不许把活跃区那份正文抹掉（正文不同的保留 + warn，正文一致的真错位照摘）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-misalign-ops-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  const STAMP = '2026-10-24T09:00:00.000+08:00';
  const body = (id, title, condition, action) => [
    '### [' + id + '] ' + title,
    '- 条件：' + condition,
    '- 做法：' + action,
    '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=1 lastHit=',
    '',
  ];
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...body('ace-001', '无关条目', 'c-a1', 'a-a1'),
    // ← 活跃区这份：正文是 c-NEW-ACTIVE（模拟「人在归档之后又改过这一条」）。
    ...body('ace-002', '同 id 异正文', 'c-NEW-ACTIVE', 'a-NEW-ACTIVE'),
    // ← 这一条是真的错位：归档里那份与它逐字相同（id + 正文全同）。
    ...body('ace-003', '真错位', 'c-SAME', 'a-SAME'),
  ].join('\n') + '\n', 'utf8');
  await appendArchivedEntries(archiveFile, [
    {
      id: 'ace-002', title: '同 id 异正文', condition: 'c-OLD-ARCHIVED', action: 'a-OLD-ARCHIVED', rationale: '',
      meta: { created: STAMP, updated: STAMP, hits: 1, lastHit: '' },
      archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
    },
    {
      id: 'ace-003', title: '真错位', condition: 'c-SAME', action: 'a-SAME', rationale: '',
      meta: { created: STAMP, updated: STAMP, hits: 1, lastHit: '' },
      archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
    },
  ], { highWater: 3 });
  const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));

  const logs = [];
  const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
    archiveFile, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
  });

  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  const activeText = await fs.readFile(file, 'utf8');
  const archived = (await readArchiveSnapshot(archiveFile)).entries;

  // ① 正文不同那条：活跃区这份**一个字都不许少**（这正是被抹掉的那份）。
  const activeTwo = parsed.entries.find((e) => e.id === 'ace-002');
  assert.ok(activeTwo, '同 id 但正文不同的条目必须留在活跃区：' + JSON.stringify(parsed.entries.map((e) => e.id)));
  assert.equal(activeTwo.condition, 'c-NEW-ACTIVE', '活跃区那份正文必须原样保留（旧口径会把它物理抹掉）');
  assert.equal(activeTwo.action, 'a-NEW-ACTIVE');
  // ② 盘上两个文件里两份正文**同时**存在 —— 「一条都没丢」这句话才是真的。
  assert.ok(activeText.includes('c-NEW-ACTIVE'), '活跃区那份正文必须还在某个盘上文件里');
  const archiveText = await fs.readFile(archiveFile, 'utf8');
  assert.ok(archiveText.includes('c-OLD-ARCHIVED'), '归档里那份正文也不许动');
  // ③ 正文一致的真错位照旧摘掉（收紧口径不是为了把真错位也放走），本批候选照常落盘。
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-004'], '真错位 ace-003 摘掉、候选落盘、正文不同的 ace-002 保留');
  assert.equal(activeText.includes('c-SAME'), false, '真错位的正文与归档逐字相同，摘掉不丢任何东西');
  // ④ 归档侧一条都不许多、不许动。
  assert.deepEqual(archived.map((e) => e.id).sort(), ['ace-002', 'ace-003'], '归档里仍是那两条（不重复归档）');
  assert.equal(archived.find((e) => e.id === 'ace-002').condition, 'c-OLD-ARCHIVED');
  assert.deepEqual((out.result.archived || []).map((a) => a.id), [], '本次没有任何「再归档」动作');
  // ⑤ 两条 warn 各自说清发生了什么 —— 一句都不能少，否则人查不到正文去哪了。
  const misWarn = logs.find((m) => m.includes('同 id 但正文不同'));
  assert.ok(misWarn, '正文不同必须留一行 warn（这是「为什么活跃区那条没被摘」的唯一线索）：' + JSON.stringify(logs));
  assert.ok(misWarn.includes('ace-002'), 'warn 必须点名是哪条 id：' + misWarn);
  assert.ok(misWarn.includes('未摘除活跃区那条') && misWarn.includes('请人工确认'), 'warn 必须说明「保留了活跃区那条、请人工确认」：' + misWarn);
  const staleWarn = logs.find((m) => m.includes('正文完全一致'));
  assert.ok(staleWarn && staleWarn.includes('ace-003'), '真错位被摘时同样要留一行 dsh-ace 日志：' + JSON.stringify(logs));
  await cleanup(dir);
});

test('j4｜缺陷4（第 41 轮）：commitCapacity 同样只摘「id + 正文全同」的错位，正文不同的保留在活跃区', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-misalign-cap-'));
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  const STAMP = '2026-10-24T09:00:00.000+08:00';
  const body = (id, title, hits, condition, action) => [
    '### [' + id + '] ' + title,
    '- 条件：' + condition,
    '- 做法：' + action,
    '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=' + hits + ' lastHit=',
    '',
  ];
  await fs.writeFile(file, [
    '# ACE 操作手册', '',
    ...body('ace-001', '命中最多', 9, 'c-a1', 'a-a1'),
    ...body('ace-002', '真错位', 0, 'c-SAME', 'a-SAME'),
    ...body('ace-003', '同 id 异正文', 4, 'c-NEW-ACTIVE', 'a-NEW-ACTIVE'),
  ].join('\n') + '\n', 'utf8');
  await appendArchivedEntries(archiveFile, [
    {
      id: 'ace-002', title: '真错位', condition: 'c-SAME', action: 'a-SAME', rationale: '',
      meta: { created: STAMP, updated: STAMP, hits: 0, lastHit: '' },
      archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
    },
    {
      id: 'ace-003', title: '同 id 异正文', condition: 'c-OLD-ARCHIVED', action: 'a-OLD-ARCHIVED', rationale: '',
      meta: { created: STAMP, updated: STAMP, hits: 4, lastHit: '' },
      archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
    },
  ], { highWater: 3 });

  const logs = [];
  await commitCapacity(file, {
    archiveFile, maxEntries: 3, evict: planEvictions, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
  });

  const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
  assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-003'], '真错位 ace-002 摘掉、正文不同的 ace-003 保留');
  assert.equal(parsed.entries.find((e) => e.id === 'ace-003').condition, 'c-NEW-ACTIVE', '活跃区那份正文必须原样保留');
  assert.ok((await fs.readFile(file, 'utf8')).includes('c-NEW-ACTIVE'), '活跃区正文仍在盘上');
  assert.ok((await fs.readFile(archiveFile, 'utf8')).includes('c-OLD-ARCHIVED'), '归档那份也没被动过');
  assert.equal((await readArchiveSnapshot(archiveFile)).entries.length, 2, '归档里仍是那两条（摘错位不算一次归档）');
  assert.ok(
    logs.some((m) => m.includes('同 id 但正文不同') && m.includes('ace-003') && m.includes('请人工确认')),
    '腾位路径同样要留一行「未摘除活跃区那条」的 warn：' + JSON.stringify(logs),
  );
  await cleanup(dir);
});

// —— j5 / j6 / j7 / j8 / j9：第 42 轮对账口径补丁（审计 audit2.md 高-1 / 低-1 / 低-2 / 低-3）——
//
// 高-1（审计 CASE 8 实测）：sameBody 只比四个正文字段，extraLines（人手批注）没进比对 ⇒ 同 id +
// 四字段全同 + 只有批注不同时被判「一致」，活跃区那条被当错位摘掉，而归档里那份**没有**活跃区
// 独有的批注 ⇒ 批注在手册与归档里同时消失、且没有任何 warn。lib/playbook.js:15 的原话是
// 「条目内无法识别的行挂在该条目的 extraLines 上原样保留（人手编辑的批注不丢失）」。
// 修法：extraLines 也进 sameBody（两边换行连接后逐字比），不等就走既有的 conflict 路径（保留活跃区那条 + warn）。
//
// 低-1：writeEntryBlock 把空 condition/action 落盘成占位符（未注明）⇒ 活跃区空串与归档侧（未注明）
// 在**同一性**上是同一份正文，旧写法按字符串比会误判 conflict。先证明两者序列化逐字相同（j6），再归一化比（j7）。
//
// 低-3：同 id 在归档里出现多条时旧写法 byId.set 只认最后一条 ⇒ 活跃区那份等于较早一条时被误判 conflict 永久留盘。

test('j5｜第 42 轮高-1：同 id、四字段全同、仅 extraLines（人手批注）不同的错位，必须保留活跃区那条并 warn', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-misalign-extralines-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    const body = (id, title, condition, action) => [
      '### [' + id + '] ' + title,
      '- 条件：' + condition,
      '- 做法：' + action,
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=1 lastHit=',
      '',
    ];
    // 活跃区这份比归档那份多一行人手批注（模拟人在归档之后往这条上写了备注）。
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      ...body('ace-001', '无关条目', 'c-a1', 'a-a1'),
      ...body('ace-002', '同 id 同正文异批注', 'c-EX', 'a-EX'),
      '> 人手批注：这行只存在于活跃区',
      '',
    ].join('\n') + '\n', 'utf8');
    await appendArchivedEntries(archiveFile, [
      {
        id: 'ace-002', title: '同 id 同正文异批注', condition: 'c-EX', action: 'a-EX', rationale: '',
        meta: { created: STAMP, updated: STAMP, hits: 1, lastHit: '' },
        archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
      },
    ], { highWater: 2 });
    const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));

    const logs = [];
    await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
      archiveFile, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
    });

    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    const activeText = await fs.readFile(file, 'utf8');
    const archiveText = await fs.readFile(archiveFile, 'utf8');
    const activeTwo = parsed.entries.find((e) => e.id === 'ace-002');
    assert.ok(activeTwo, '仅批注不同的那条必须留在活跃区：' + JSON.stringify(parsed.entries.map((e) => e.id)));
    assert.equal(activeTwo.condition, 'c-EX', '四个正文字段全同也不许摘——正文之外还有批注');
    assert.ok(
      (activeTwo.extraLines || []).some((l) => l.includes('人手批注：这行只存在于活跃区')),
      '活跃区独有的批注行必须原样在活跃区：' + JSON.stringify(activeTwo.extraLines),
    );
    // ★ 这两句就是高-1 的现场：旧口径下活跃区那条被摘，批注在手册与归档里同时消失。
    assert.equal(archiveText.includes('人手批注：这行只存在于活跃区'), false, '（前置事实）归档里确实没有这行批注 ⇒ 活跃区那份一旦被摘，批注就是真丢了');
    assert.ok(activeText.includes('人手批注：这行只存在于活跃区'), '人手批注绝不许被静默物理抹掉（旧口径实测：手册 false / 归档 false）');
    const archived = (await readArchiveSnapshot(archiveFile)).entries;
    assert.deepEqual(archived.map((e) => e.id).sort(), ['ace-002'], '归档里还是那一条，不许重复归档');
    const misWarn = logs.find((m) => m.includes('同 id 但正文不同'));
    assert.ok(misWarn, '仅批注不同也必须走既有的 conflict 路径留一行 warn：' + JSON.stringify(logs));
    assert.ok(misWarn.includes('ace-002') && misWarn.includes('未摘除活跃区那条') && misWarn.includes('请人工确认'), 'warn 内容照旧：' + misWarn);
  } finally {
    await cleanup(dir);
  }
});

test('j6｜第 42 轮低-1 前置证明：空字段条目与占位符条目序列化后逐字相同（所以归一化比对是安全的）', () => {
  const STAMP = '2026-10-24T09:00:00.000+08:00';
  const mk = (condition, action) => ({
    id: 'ace-001', title: '同一标题', condition, action, rationale: '',
    meta: { created: STAMP, updated: STAMP, hits: 0, lastHit: '' },
  });
  const emptyDoc = serializePlaybook({ header: ['# ACE 操作手册', ''], entries: [mk('', '')] });
  const placeholderDoc = serializePlaybook({ header: ['# ACE 操作手册', ''], entries: [mk('（未注明）', '（未注明）')] });
  assert.equal(emptyDoc, placeholderDoc, '空字段落盘就是占位符（lib/entry-format.js writeEntryBlock）⇒ 两者在盘上是同一份');
  assert.ok(emptyDoc.includes('- 条件：（未注明）') && emptyDoc.includes('- 做法：（未注明）'));
  // 反过来说：解析回来的两侧**不会**都长成空串 —— 空字段落盘再读回也只剩占位符字符串，
  // 这正是低-1 的现场（活跃区空串 vs 归档侧占位符，旧写法准时误判 conflict）。
  assert.equal(parsePlaybook(emptyDoc).entries[0].condition, '（未注明）', '空字段落盘再读回就是占位符');
  assert.equal(parsePlaybook(placeholderDoc).entries[0].condition, '（未注明）', '手写占位符的那份读回也是占位符');
});

test('j7｜第 42 轮低-1：活跃区空字段与归档侧的占位符必须判「同一份正文」，不许误判 conflict', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-misalign-placeholder-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    const body = (id, title, condition, action) => [
      '### [' + id + '] ' + title,
      '- 条件：' + condition,
      '- 做法：' + action,
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=1 lastHit=',
      '',
    ];
    // 活跃区这份是**空字段**（写盘时被写成占位符）；归档那份是同一份正文的历史快照。
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      ...body('ace-001', '无关条目', 'c-a1', 'a-a1'),
      ...body('ace-002', '空字段条目', '', ''),
    ].join('\n') + '\n', 'utf8');
    await appendArchivedEntries(archiveFile, [
      {
        id: 'ace-002', title: '空字段条目', condition: '', action: '', rationale: '',
        meta: { created: STAMP, updated: STAMP, hits: 1, lastHit: '' },
        archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
      },
    ], { highWater: 2 });
    const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));

    const logs = [];
    await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
      archiveFile, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
    });

    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    assert.deepEqual(
      parsed.entries.map((e) => e.id),
      ['ace-001', 'ace-003'],
      '空字段 vs 占位符 = 同一份正文 ⇒ 真错位，照摘（旧写法在这里误判 conflict 把那条永久留盘）',
    );
    assert.equal(
      logs.some((m) => m.includes('同 id 但正文不同')),
      false,
      '不许报 conflict：两份正文落盘逐字相同（见 j6）：' + JSON.stringify(logs),
    );
    assert.ok(logs.some((m) => m.includes('正文完全一致') && m.includes('ace-002')), '要走既有的「真错位摘掉」warn：' + JSON.stringify(logs));
  } finally {
    await cleanup(dir);
  }
});

test('j8｜第 42 轮低-3：归档里同 id 出现多条时，活跃区那份与任意一份一致即判真错位（不许只认最后一条）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-misalign-duparchive-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    const body = (id, title, condition, action) => [
      '### [' + id + '] ' + title,
      '- 条件：' + condition,
      '- 做法：' + action,
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=1 lastHit=',
      '',
    ];
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      ...body('ace-001', '无关条目', 'c-a1', 'a-a1'),
      // 活跃区这份 = 归档里**较早**那一份（逐字相同）。旧写法 byId.set 只认最后一条 ⇒ 误判 conflict。
      ...body('ace-002', '同 id 双份', 'c-OLD', 'a-OLD'),
    ].join('\n') + '\n', 'utf8');
    // appendArchivedEntries 对同 id 是静默跳过的（lib/archive-file.js 的 seen 集合）⇒ 手工追加第二份造「同 id 两份」。
    await appendArchivedEntries(archiveFile, [
      {
        id: 'ace-002', title: '同 id 双份', condition: 'c-OLD', action: 'a-OLD', rationale: '',
        meta: { created: STAMP, updated: STAMP, hits: 0, lastHit: '' },
        archive: { reason: 'evicted', date: STAMP, supersededBy: '' },
      },
    ], { highWater: 2 });
    const archiveText = await fs.readFile(archiveFile, 'utf8');
    await fs.writeFile(archiveFile, archiveText + [
      '### [ace-002] 同 id 双份（后来那份）',
      '- 条件：c-NEWER',
      '- 做法：a-NEWER',
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=0 lastHit=',
      '- 归档：reason=evicted date=' + STAMP,
      '',
    ].join('\n'), 'utf8');
    const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));

    const logs = [];
    await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
      archiveFile, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
    });

    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    assert.deepEqual(
      parsed.entries.map((e) => e.id),
      ['ace-001', 'ace-003'],
      '活跃区那份与较早那份逐字相同 ⇒ 真错位，摘掉（旧写法只认最后一条 ⇒ 误判 conflict 永久留盘）',
    );
    assert.equal(logs.some((m) => m.includes('同 id 但正文不同')), false, '不许报 conflict：至少有一份归档与活跃区逐字相同：' + JSON.stringify(logs));
    assert.ok(logs.some((m) => m.includes('正文完全一致') && m.includes('ace-002')), '要走既有的真错位 warn：' + JSON.stringify(logs));
  } finally {
    await cleanup(dir);
  }
});

test('j9｜第 42 轮低-2：归档文件读失败时对账静默跳过改成留一行 warn，控制流不变（提交照常成功）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archive-readfail-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    // 归档路径是个**目录**：readArchiveSnapshot 读到 EISDIR 会抛（ENOENT 才算空归档，不进这个 catch）。
    await fs.mkdir(archiveFile, { recursive: true });
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      '### [ace-001] 现有条目',
      '- 条件：c-a1',
      '- 做法：a-a1',
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=0 lastHit=',
      '',
    ].join('\n') + '\n', 'utf8');
    const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));

    const logs = [];
    let out = null;
    let threw = null;
    try {
      out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目', condition: 'c9', action: 'a9' }], 10, {
        archiveFile, today: STAMP, logger: { warn: (m) => logs.push(String(m)) },
      });
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, '读归档失败不许阻断提交（真正保证落在写盘那一步 appendArchivedEntries）：' + (threw && threw.message));
    assert.ok(out, 'commitOps 照常返回');
    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-002'], '候选照常落盘');
    assert.ok(
      logs.some((m) => m.startsWith('dsh-ace: 归档文件读取失败') && m.includes('对账') && m.includes(archiveFile)),
      '第 42 轮低-2：读归档失败从静默改成留一行 warn（带上归档路径），否则「对账为什么没生效」查不到：' + JSON.stringify(logs),
    );
  } finally {
    await cleanup(dir);
  }
});

test('j10｜第 43 轮低-3：归档长期不可读时同一路径只 warn 一次（去重是纯内存，控制流与提交结果一字未变）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archive-readfail-once-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    // 归档路径是个**目录**（EISDIR）—— 与 j9 同一个触发法，这里要的是「反复触发」。
    await fs.mkdir(archiveFile, { recursive: true });
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      '### [ace-001] 现有条目',
      '- 条件：c-a1',
      '- 做法：a-a1',
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=0 lastHit=',
      '',
    ].join('\n') + '\n', 'utf8');

    const logs = [];
    const logger = { warn: (m) => logs.push(String(m)) };
    const expectedWarns = () => logs.filter((m) => m.startsWith('dsh-ace: 归档文件读取失败')).length;

    // ① commitOps 连提交三次：三次都读不动归档，日志只该有一行（第 42 轮是三次三行）。
    for (let i = 1; i <= 3; i += 1) {
      const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
      const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目' + i, condition: 'c' + i, action: 'a' + i }], 10, {
        archiveFile, today: STAMP, logger,
      });
      assert.ok(out, '第 ' + i + ' 次提交照常返回（去重只管日志，绝不影响控制流）');
      assert.equal(expectedWarns(), 1, '第 ' + i + ' 次之后读归档失败的 warn 仍然只有 1 行：' + JSON.stringify(logs));
    }
    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-003', 'ace-004'], '候选照常落盘（提交结果与去重无关）');

    // ② 另一条提交路径（commitCapacity）读同一个归档：同一路径，仍然不重复 warn。
    await commitCapacity(file, {
      archiveFile, today: STAMP, maxEntries: 10,
      evict: [{ id: 'ace-001', reason: 'evicted', date: STAMP }],
      logger,
    });
    assert.equal(expectedWarns(), 1, 'commitCapacity 这条路径也走同一个去重表（两条路径同口径）：' + JSON.stringify(logs));

    // ③ 换一个归档路径（归档文件真的换成一份可读的）：新路径自己的那一行 warn 照发，不被别人的记录吞掉。
    const otherArchive = path.join(dir, 'archive-2.md');
    await fs.mkdir(otherArchive, { recursive: true });
    const snapshot2 = parsePlaybook(await fs.readFile(file, 'utf8'));
    await commitOps(file, { entries: snapshot2.entries }, [{ op: 'add', title: '新条目5', condition: 'c5', action: 'a5' }], 10, {
      archiveFile: otherArchive, today: STAMP, logger,
    });
    assert.equal(expectedWarns(), 2, '去重是按路径记的：换了路径就该有它自己的一行 warn：' + JSON.stringify(logs));
    assert.ok(
      logs.filter((m) => m.startsWith('dsh-ace: 归档文件读取失败')).some((m) => m.includes(otherArchive)),
      '第二行 warn 必须带上新路径（证明两行不是同一句重复）：' + JSON.stringify(logs),
    );
  } finally {
    await cleanup(dir);
  }
});

test('第45轮③c｜warnArchiveReadFailure：logger.warn 自己抛错 ⇒ 不记账、下次同路径仍会 warn（提交照常成功）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-archive-warnthrow-'));
  try {
    const file = path.join(dir, 'playbook.md');
    const archiveFile = path.join(dir, 'archive.md');
    const STAMP = '2026-10-24T09:00:00.000+08:00';
    // 与 j9 / j10 同一个触发法：归档路径是目录 ⇒ readArchiveSnapshot 抛 EISDIR。
    await fs.mkdir(archiveFile, { recursive: true });
    await fs.writeFile(file, [
      '# ACE 操作手册', '',
      '### [ace-001] 现有条目',
      '- 条件：c-a1',
      '- 做法：a-a1',
      '- 元数据：created=' + STAMP + ' updated=' + STAMP + ' hits=0 lastHit=',
      '',
    ].join('\n') + '\n', 'utf8');

    // 日志后端本身炸掉：warnArchiveReadFailure 内部 try/catch 吞掉这个错、**不把路径记进去重表**，
    // 所以同一个不可读的归档下一次提交仍会尝试 warn 一遍（不是「静默」，也不是「报一次就再也不报」）。
    let warnAttempts = 0;
    const logger = { warn: () => { warnAttempts += 1; throw new Error('日志后端挂了'); } };

    let threw = null;
    try {
      for (let i = 1; i <= 2; i += 1) {
        const snapshot = parsePlaybook(await fs.readFile(file, 'utf8'));
        const out = await commitOps(file, { entries: snapshot.entries }, [{ op: 'add', title: '新条目' + i, condition: 'c' + i, action: 'a' + i }], 10, {
          archiveFile, today: STAMP, logger,
        });
        assert.ok(out, '第 ' + i + ' 次提交照常返回（日志炸掉绝不许影响控制流）');
      }
    } catch (e) {
      threw = e;
    }
    assert.equal(threw, null, 'logger.warn 抛的错绝不许冒到调用方：' + (threw && threw.message));
    assert.equal(warnAttempts, 2, 'warn 抛错 ⇒ 去重表没记上账，两次读归档失败各试了一遍 warn：' + warnAttempts);

    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-001', 'ace-002', 'ace-003'], '候选照常落盘（与去重记账无关）');
  } finally {
    await cleanup(dir);
  }
});
