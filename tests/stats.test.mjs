// 手册统计（lib/stats.js）的单元测试。
// 运行：npm test（node --test tests/）。纯逻辑 + 只读 IO：全部在临时目录里造手册，
// 不碰真实 DSH_HOME / 真实用户手册（C:\Users\<user>\.dsh\ace\playbook.md 只读不写）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATS_WINDOW_DAYS,
  RECENT_LIMIT,
  STATS_REASONS,
  formatStamp,
  dateKey,
  entryTextChars,
  entryStamp,
  toDayKey,
  recentIdNumber,
  summarizePlaybook,
  readPlaybookStats,
  collectPlaybookStats,
  emptyStats,
} from '../lib/stats.js';

const NOW = new Date('2026-10-10T12:00:00');

/** 一份小手册：两条条目，第二条带 auto=true，日期都落在 NOW 的 14 天窗口内。 */
const SAMPLE = [
  '# ACE 操作手册',
  '',
  '> 本文件由插件维护。',
  '',
  '### [ace-001] 标题一',
  '- 条件：条件一',
  '- 做法：做法一',
  '- 依据：依据一',
  '- 元数据：created=2026-10-01 updated=2026-10-02 helpful=0 harmful=0',
  '',
  '### [ace-002] 标题二',
  '- 条件：条件二',
  '- 做法：做法二',
  '- 依据：依据二',
  '- 元数据：created=2026-10-05 updated=2026-10-05 helpful=0 harmful=0 auto=true',
  '',
].join('\n');

/** 造临时目录，返回 { dir, file, cleanup }。 */
function tempPlaybook(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-stats-'));
  const file = path.join(dir, 'playbook.md');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 只有 get 的假 ctx（无 profileContext、无 workingDirectory = HTTP 面的处境）。 */
const fakeCtx = { get: () => undefined };

// —— ① 正常手册：规模 / 来源 / 时间分布 / 最近更新 ——

test('统计①：正常手册返回完整结构（规模、来源、14 天分布、最近 5 条）', () => {
  const stats = summarizePlaybook(SAMPLE, { filePath: '/x/playbook.md', size: 512, mtime: new Date('2026-10-05T08:30:00'), maxEntries: 100, now: NOW });
  assert.equal(stats.ok, true);
  assert.equal(stats.reason, null);
  assert.equal(stats.scale.entries, 2);
  assert.equal(stats.scale.maxEntries, 100);
  // 正文 = title + condition + action + rationale，每条 12 字（3+3+3+3），不含 Markdown 标记与元数据行
  assert.equal(stats.scale.textChars, 24);
  assert.equal(stats.scale.bytes, 512);
  assert.equal(stats.scale.mtime, '2026-10-05 08:30');
  assert.equal(stats.file, '/x/playbook.md');
  // 来源构成：只认 auto=true
  assert.equal(stats.source.total, 2);
  assert.equal(stats.source.auto, 1);
  assert.equal(stats.source.autoRatio, 0.5);
  // 时间分布：固定 14 行，按 updated 落桶
  assert.equal(stats.windowDays, STATS_WINDOW_DAYS);
  assert.equal(stats.daily.length, STATS_WINDOW_DAYS);
  assert.equal(stats.daily[stats.daily.length - 1].date, '2026-10-10');
  const byDate = new Map(stats.daily.map((row) => [row.date, row.count]));
  assert.equal(byDate.get('2026-10-02'), 1);
  assert.equal(byDate.get('2026-10-05'), 1);
  assert.equal(stats.dailyMax, 1);
  // 最近更新：日期倒序
  assert.equal(stats.recent.length, 2);
  assert.deepEqual(stats.recent[0], { id: 'ace-002', title: '标题二', updated: '2026-10-05' });
  assert.deepEqual(stats.recent[1], { id: 'ace-001', title: '标题一', updated: '2026-10-02' });
});

test('统计①b：窗口外的条目不计入时间分布，但计入规模与来源', () => {
  const text = [
    '### [ace-001] 旧条目',
    '- 条件：a',
    '- 做法：b',
    '- 依据：c',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n');
  const stats = summarizePlaybook(text, { now: NOW, maxEntries: 100 });
  assert.equal(stats.scale.entries, 1);
  assert.equal(stats.dailyMax, 0);
  assert.equal(stats.daily.every((row) => row.count === 0), true);
  assert.equal(stats.recent[0].updated, '2026-01-01');
});

test('统计①c：recent 最多 5 条，同日按编号倒序', () => {
  const lines = [];
  for (let i = 1; i <= 7; i += 1) {
    const id = String(i).padStart(3, '0');
    lines.push('### [ace-' + id + '] 标题' + i);
    lines.push('- 条件：c');
    lines.push('- 做法：a');
    lines.push('- 依据：r');
    lines.push('- 元数据：created=2026-10-03 updated=2026-10-03 helpful=0 harmful=0');
    lines.push('');
  }
  const stats = summarizePlaybook(lines.join('\n'), { now: NOW });
  assert.equal(stats.recent.length, RECENT_LIMIT);
  assert.deepEqual(stats.recent.map((row) => row.id), ['ace-007', 'ace-006', 'ace-005', 'ace-004', 'ace-003']);
});

test('统计①d：同日按编号倒序是数值序 —— ace-1000 排在 ace-999 之前', () => {
  // 旧实现是 a.id < b.id 的字符串序：'ace-999' > 'ace-1000'（'9' > '1'），
  // 于是 ace-999 被排在前面，与注释「同日按编号倒序」不符。maxEntries 上限 1000，
  // 四位数编号真实可达。
  const text = ['ace-999', 'ace-1000', 'ace-998'].map((id) => [
    '### [' + id + '] 标题',
    '- 条件：c',
    '- 做法：a',
    '- 依据：r',
    '- 元数据：created=2026-10-03 updated=2026-10-03 helpful=0 harmful=0',
    '',
  ].join('\n')).join('\n');
  const stats = summarizePlaybook(text, { now: NOW });
  assert.deepEqual(stats.recent.map((row) => row.id), ['ace-1000', 'ace-999', 'ace-998']);
});

test('统计①e：recentIdNumber 取尾号，非 ace-N 编号回退 -1', () => {
  assert.equal(recentIdNumber('ace-1000'), 1000);
  assert.equal(recentIdNumber('ace-007'), 7);
  assert.equal(recentIdNumber('ace-999'), 999);
  assert.equal(recentIdNumber('other-1'), -1);
  assert.equal(recentIdNumber(''), -1);
  assert.equal(recentIdNumber(null), -1);
});

// —— ② 空文件 ——

test('统计②：空文件返回 ok:true 的 no-entries 空态（14 行全零，不抛错）', () => {
  const stats = summarizePlaybook('', { filePath: '/x/playbook.md', size: 0, now: NOW, maxEntries: 100 });
  assert.equal(stats.ok, true);
  assert.equal(stats.reason, STATS_REASONS.noEntries);
  assert.equal(stats.scale.entries, 0);
  assert.equal(stats.scale.textChars, 0);
  assert.equal(stats.scale.bytes, 0);
  assert.equal(stats.daily.length, STATS_WINDOW_DAYS);
  assert.equal(stats.dailyMax, 0);
  assert.deepEqual(stats.recent, []);
});

test('统计②b：只有文档头、没有条目的手册也算 no-entries', async () => {
  const { file, cleanup } = tempPlaybook('# ACE 操作手册\n\n> 说明\n');
  try {
    const stats = await readPlaybookStats(file, { now: NOW, maxEntries: 100 });
    assert.equal(stats.ok, true);
    assert.equal(stats.reason, STATS_REASONS.noEntries);
    assert.equal(stats.scale.entries, 0);
    assert.equal(stats.file, file);
    assert.equal(stats.scale.bytes > 0, true);
    assert.equal(stats.scale.mtime !== null, true);
  } finally {
    cleanup();
  }
});

// —— ③ 文件不存在 ——

test('统计③：文件不存在返回 ok:true 的 missing 空态（不抛 ENOENT）', async () => {
  const missing = path.join(os.tmpdir(), 'dsh-ace-stats-not-exist-' + process.pid, 'playbook.md');
  const stats = await readPlaybookStats(missing, { now: NOW, maxEntries: 100 });
  assert.equal(stats.ok, true);
  assert.equal(stats.reason, STATS_REASONS.missing);
  assert.equal(stats.scale.entries, 0);
  assert.equal(stats.daily.length, STATS_WINDOW_DAYS);
  assert.equal(stats.file, missing);
});

// —— ④ 相对路径在 HTTP 面不可解析 ——

test('统计④：相对 playbookPath 无会话上下文 → needs-session 空态（不抛错）', async () => {
  const stats = await collectPlaybookStats('docs/playbook.md', { ctx: fakeCtx, maxEntries: 100, now: NOW });
  assert.equal(stats.ok, true);
  assert.equal(stats.reason, STATS_REASONS.needsSession);
  assert.equal(stats.pathKind, 'relative');
  assert.equal(stats.playbookPath, 'docs/playbook.md');
  assert.equal(stats.scale.entries, 0);
  assert.equal(stats.daily.length, STATS_WINDOW_DAYS);
  assert.deepEqual(stats.recent, []);
});

test('统计④b：绝对 playbookPath 走真实读盘，统计结果可用', async () => {
  const { file, cleanup } = tempPlaybook(SAMPLE);
  try {
    const stats = await collectPlaybookStats(file, { ctx: fakeCtx, maxEntries: 100, now: NOW });
    assert.equal(stats.ok, true);
    assert.equal(stats.reason, null);
    assert.equal(stats.pathKind, 'absolute');
    assert.equal(stats.scale.entries, 2);
    assert.equal(stats.source.auto, 1);
    assert.equal(stats.source.total, 2);
    assert.equal(stats.scale.bytes, fs.statSync(file).size);
    assert.equal(stats.scale.textChars, 24);
    assert.equal(stats.recent[0].id, 'ace-002');
  } finally {
    cleanup();
  }
});

// —— ⑤ 小工具函数 ——

test('统计⑤：formatStamp / dateKey / toDayKey / entryStamp / entryTextChars', () => {
  assert.equal(formatStamp(new Date(2026, 9, 5, 8, 3)), '2026-10-05 08:03');
  assert.equal(formatStamp('not-a-date'), '');
  assert.equal(dateKey(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(toDayKey('2026-10-05'), '2026-10-05');
  assert.equal(toDayKey('2026-10-05 08:03'), '2026-10-05');
  assert.equal(toDayKey('2026-13-01'), null);
  assert.equal(toDayKey(''), null);
  assert.equal(entryStamp({ meta: { created: '2026-01-01', updated: '2026-02-02' } }), '2026-02-02');
  assert.equal(entryStamp({ meta: { created: '2026-01-01' } }), '2026-01-01');
  assert.equal(entryStamp({}), '');
  assert.equal(entryTextChars({ title: 'ab', condition: 'cd', action: 'e', rationale: 'f' }), 6);
});

test('统计⑤b：emptyStats 与 summarizePlaybook 的字段集合一致（客户端不必特判）', () => {
  const empty = emptyStats(STATS_REASONS.missing, { now: NOW, maxEntries: 100, pathKind: 'absolute', playbookPath: '/x/playbook.md', file: '/x/playbook.md' });
  const full = summarizePlaybook(SAMPLE, { now: NOW, maxEntries: 100, pathKind: 'absolute', playbookPath: '/x/playbook.md', filePath: '/x/playbook.md' });
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(full).sort());
  assert.deepEqual(Object.keys(empty.scale).sort(), Object.keys(full.scale).sort());
  assert.deepEqual(Object.keys(empty.source).sort(), Object.keys(full.source).sort());
  assert.equal(empty.ok, true);
  assert.equal(empty.reason, STATS_REASONS.missing);
});

// —— ⑥ 运行统计的归一化（第 33 轮：正负评分删除后只剩六个数字）——

test('统计⑥：runtime 七键原样透传 —— 注入批次 / 注入追加 / 检索命中 / 淘汰 / 合并 / 归档 + 四原因分列', () => {
  const runtime = {
    injectedBatches: 9,
    injectedAppended: 7,
    retrievalHits: 11,
    evicted: 4,
    merged: 3,
    archived: 10,
    archivedByReason: { superseded: 1, 'removed-by-request': 2, evicted: 4, merged: 3 },
  };
  const stats = summarizePlaybook(SAMPLE, { now: NOW, maxEntries: 100, runtime });
  // 关键：非 0 值必须**原样透传**。缺字段时 count() 补 0 会把「映射写错」伪装成「本来就是 0」，
  // 所以这里的夹具必须带非 0 值 —— 否则 stats.js 的取值映射没有任何用例钉得住。
  assert.equal(stats.runtime.injectedBatches, 9, '注入批次原样透传（不是恒 0）');
  assert.equal(stats.runtime.injectedAppended, 7, '注入追加原样透传，且与批次是两个数');
  assert.equal(stats.runtime.retrievalHits, 11, '检索命中原样透传（整本读取不计数的那个数）');
  assert.equal(stats.runtime.evicted, 4, '淘汰数原样透传（不是恒 0）');
  assert.equal(stats.runtime.merged, 3, '合并数原样透传（不是恒 0）');
  assert.equal(stats.runtime.archived, 10, '归档总数原样透传');
  assert.deepEqual(stats.runtime.archivedByReason, {
    superseded: 1, 'removed-by-request': 2, evicted: 4, merged: 3,
  }, '归档按四种结构性原因分列，一个都不能少');
  // 旧口径整层删除：不许以任何形式残留（否则设置页会显示一个永远为 0 的死格子）。
  for (const gone of ['recaps', 'candidates', 'written', 'helpful', 'harmful', 'unobserved', 'gateRejected',
    'injectedSkipped', 'injectedFailed', 'injectedProbation', 'injected']) {
    assert.equal(gone in stats.runtime, false, 'runtime 里不许再有旧字段 ' + gone);
  }
  assert.deepEqual(
    Object.keys(stats.runtime).sort(),
    ['archived', 'archivedByReason', 'evicted', 'injectedAppended', 'injectedBatches', 'merged', 'retrievalHits'],
    'runtime 恒 7 个键（与 GET /api/dsh-ace/stats 的契约一致）',
  );
  // 缺字段 / 畸形值一律补 0，字段本身恒在（客户端不必特判）。
  const empty = summarizePlaybook(SAMPLE, { now: NOW, maxEntries: 100, runtime: { injectedBatches: 'x', injectedAppended: -3 } });
  assert.equal(empty.runtime.injectedBatches, 0, '非数值按 0 处理');
  assert.equal(empty.runtime.injectedAppended, 0, '负数按 0 处理');
  assert.equal(empty.runtime.retrievalHits, 0, '检索命中缺字段补 0');
  assert.equal(empty.runtime.evicted, 0, '淘汰数缺字段补 0');
  assert.equal(empty.runtime.merged, 0, '合并数缺字段补 0');
  assert.deepEqual(empty.runtime.archivedByReason, {
    superseded: 0, 'removed-by-request': 0, evicted: 0, merged: 0,
  }, '归档原因分列缺字段时四键齐全、全 0');
});
