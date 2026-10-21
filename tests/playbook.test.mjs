// dsh-ace 单元测试：playbook 持久化层（解析/序列化/增量操作/原子写/互斥锁）。
// 运行：npm test（node --test tests/）。只测纯逻辑层，不测工具注册（需要宿主）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlaybook, serializePlaybook, applyOps, digestEntries, withLock, writeFileAtomic, readOrInitPlaybook, matchEntries, querySegments } from '../lib/playbook.js';

const E = (id, title, condition, action, rationale, overrides = {}) => ({
  id, title, condition, action, rationale: rationale || '',
  meta: { created: '2026-01-01', updated: '2026-01-01', helpful: 0, harmful: 0, ...overrides.meta },
  extraLines: overrides.extraLines || [],
});

const SAMPLE = [
  '# ACE 操作手册',
  '',
  '> 人可以直接编辑。',
  '',
  '### [ace-001] 编辑前先读',
  '- 条件：修改既有文件之前',
  '- 做法：先 read 再动手',
  '- 依据：盲改返工过两次',
  '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=1 harmful=0',
  '',
  '### [ace-010] 增量演化',
  '- 条件：沉淀经验时',
  '- 做法：只做增/改/删',
  '- 元数据：created=2026-01-02 updated=2026-01-02 helpful=0 harmful=0',
].join('\n') + '\n';

test('parsePlaybook：文档头保留、条目字段与元数据解析、id 补零', () => {
  const { header, entries } = parsePlaybook(SAMPLE);
  assert.equal(header.length, 4);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], E('ace-001', '编辑前先读', '修改既有文件之前', '先 read 再动手', '盲改返工过两次', { meta: { helpful: 1 }, extraLines: [''] }));
  assert.equal(entries[0].meta.helpful, 1);
  assert.equal(entries[1].id, 'ace-010');
  assert.equal(entries[1].rationale, '');
});

test('parsePlaybook：条目内无法识别的行进 extraLines，序列化原样保留', () => {
  const text = ['### [ace-001] t', '- 条件：c', '- 做法：a', '（人写的批注）'].join('\n') + '\n';
  const { entries } = parsePlaybook(text);
  assert.deepEqual(entries[0].extraLines, ['（人写的批注）', '']);
  assert.ok(serializePlaybook({ header: [], entries }).includes('（人写的批注）'));
});

test('parse/serialize 往返等价', () => {
  const { header, entries } = parsePlaybook(SAMPLE);
  assert.equal(serializePlaybook({ header, entries }), SAMPLE);
});

test('serializePlaybook：空手册且无头 → 空串', () => {
  assert.equal(serializePlaybook({ header: [], entries: [] }), '');
});


test('applyOps：add 分配递增 id（取现有最大 +1，零填充 3 位）', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const r = applyOps(entries, [{ op: 'add', title: '新经验', condition: 'c', action: 'a' }], 60);
  assert.deepEqual(r.added, ['ace-011']);
  assert.equal(r.entries.length, 3);
});

test('applyOps：add 与既有条目完全重复 → duplicates 跳过', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const r = applyOps(entries, [{ op: 'add', title: '编辑前先读', condition: '修改既有文件之前', action: '先 read 再动手' }], 60);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.duplicates, ['编辑前先读']);
});

test('applyOps：空白差异不算重复（归一化后比较）', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const r = applyOps(entries, [{ op: 'add', title: '编辑前先读', condition: '修改  既有文件之前', action: '先 read 再动手 ' }], 60);
  assert.deepEqual(r.added, ['ace-011']);
});

test('applyOps：update 合并字段并刷新 updated 日期', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const r = applyOps(entries, [{ op: 'update', id: 'ace-001', action: '先完整 read 再动手' }], 60);
  assert.deepEqual(r.updated, ['ace-001']);
  assert.equal(r.entries[0].action, '先完整 read 再动手');
  assert.equal(r.entries[0].meta.updated, new Date().toISOString().slice(0, 10));
});

test('applyOps：remove 删除条目', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const r = applyOps(entries, [{ op: 'remove', id: 'ace-010' }], 60);
  assert.deepEqual(r.removed, ['ace-010']);
  assert.equal(r.entries.length, 1);
});

test('applyOps：事务式校验——任一 op 非法则整批拒绝、entries 不变', () => {
  const { entries } = parsePlaybook(SAMPLE);
  assert.throws(
    () => applyOps(entries, [{ op: 'update', id: 'ace-999', action: 'x' }], 60),
    /ace-999 不存在/,
  );
  assert.throws(
    () => applyOps(entries, [{ op: 'add', title: '好', condition: 'c', action: 'a' }, { op: 'add', title: '' }], 60),
    /缺少必填字段 title/,
  );
});

test('applyOps：非法 op 名与缺字段 add 都在错误信息里逐条列出', () => {
  const { entries } = parsePlaybook(SAMPLE);
  try {
    applyOps(entries, [{ op: 'replace', id: 'x' }, { op: 'add', title: 't' }], 60);
    assert.fail('should throw');
  } catch (e) {
    assert.match(e.message, /op 必须是 add\|update\|remove/);
    assert.match(e.message, /缺少必填字段 condition/);
  }
});

test('applyOps：超 maxEntries 整批拒绝，错误信息列出可合并旧条目', () => {
  const { entries } = parsePlaybook(SAMPLE);
  try {
    applyOps(entries, [{ op: 'add', title: 't2', condition: 'c', action: 'a' }], 2);
    assert.fail('should throw');
  } catch (e) {
    assert.match(e.message, /已达上限 2 条/);
    assert.match(e.message, /ace-001 编辑前先读/);
  }
});

test('applyOps：同批内两条相同 add —— 第二条记 duplicates', () => {
  const r = applyOps([], [{ op: 'add', title: 't', condition: 'c', action: 'a' }, { op: 'add', title: 'T', condition: 'C', action: 'A' }], 60);
  assert.deepEqual(r.added, ['ace-001']);
  assert.equal(r.duplicates.length, 1);
});

test('digestEntries：压缩为一行一条', () => {
  const { entries } = parsePlaybook(SAMPLE);
  const d = digestEntries(entries);
  assert.equal(d.length, 2);
  assert.ok(d[0].startsWith('[ace-001] 编辑前先读｜条件：'));
});

test('withLock：同一路径串行，后写者读到先写者的结果', async () => {
  const order = [];
  const p = '/virtual/playbook.md';
  await Promise.all([
    withLock(p, async () => { await new Promise((r) => setTimeout(r, 30)); order.push('A'); return 'A'; }),
    withLock(p, async () => { order.push('B'); return 'B'; }),
  ]).then((rs) => assert.deepEqual(rs, ['A', 'B']));
  assert.deepEqual(order, ['A', 'B']);
});

test('withLock：不同路径互不阻塞', async () => {
  const t0 = Date.now();
  await Promise.all([
    withLock('/a', async () => { await new Promise((r) => setTimeout(r, 50)); }),
    withLock('/b', async () => { await new Promise((r) => setTimeout(r, 50)); }),
  ]);
  assert.ok(Date.now() - t0 < 90, '两个 50ms 锁应并行（实测 ' + (Date.now() - t0) + 'ms）');
});

test('withLock：前一个任务抛错不阻塞后续任务', async () => {
  const p = '/virtual/fail.md';
  await assert.rejects(withLock(p, async () => { throw new Error('boom'); }), /boom/);
  const r = await withLock(p, async () => 'ok');
  assert.equal(r, 'ok');
});

test('writeFileAtomic + readOrInitPlaybook：真实文件读写与初始化', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-test-'));
  const file = path.join(dir, 'playbook.md');
  const first = await readOrInitPlaybook(file);
  assert.equal(first.entries.length, 0);
  const onDisk = await fs.readFile(file, 'utf8');
  assert.ok(onDisk.includes('# ACE 操作手册'));
  const second = await readOrInitPlaybook(file);
  assert.equal(second.header.length, first.header.length);
  const r = applyOps(second.entries, [{ op: 'add', title: 't', condition: 'c', action: 'a' }], 60);
  await writeFileAtomic(file, serializePlaybook({ header: second.header, entries: r.entries }));
  const third = await readOrInitPlaybook(file);
  assert.equal(third.entries.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

// —— T19-T23：query 片段 OR 匹配（matchEntries/querySegments） ——

test('matchEntries：中文长自然句 query 经 2-gram 命中含相关词的条目', () => {
  const entries = [
    E('ace-001', '服务上线前先灰度', '服务要上线', '先灰度一批再全量', '直接全量出过事故'),
    E('ace-002', '编辑前先读', '修改既有文件之前', '先 read 再动手', '盲改返工过两次'),
  ];
  const hit = matchEntries(entries, '上线之后服务挂了怎么办');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 'ace-001');
  // 2-gram 片段确实包含「服务」
  assert.ok(querySegments('上线之后服务挂了怎么办').includes('服务'));
});

test('matchEntries：多片段 OR——命中任一片段即返回', () => {
  const entries = [
    E('ace-001', '部署前跑测试', '要部署', '先跑 node --test', ''),
    E('ace-002', '编辑前先读', '修改文件之前', '先 read', ''),
    E('ace-003', '无关条目', '做菜的时候', '少放盐', ''),
  ];
  const hit = matchEntries(entries, '部署 编辑');
  assert.deepEqual(hit.map((e) => e.id), ['ace-001', 'ace-002']);
});

test('matchEntries：BM25——tf 更高/多片段命中的条目排前，同分保持原序', () => {
  const entries = [
    E('ace-001', '读文件', '读之前', '先 read 再改', ''),
    E('ace-002', 'read 和 写 都要小心', 'read 或写', 'read 完再写', 'read 出错过'),
  ];
  const hit = matchEntries(entries, 'read 写');
  assert.equal(hit[0].id, 'ace-002'); // read tf=4 且含「写」→ BM25 分更高
  // 同分保序：两条同形（tf=1、等长），BM25 得分相等 → 保持原序
  const pair = [E('ace-001', '读文件', '读之前', 'read 一下', ''), E('ace-002', '看文件', '看之前', 'read 一下', '')];
  const tie = matchEntries(pair, 'read');
  assert.deepEqual(tie.map((e) => e.id), ['ace-001', 'ace-002']);
});

test('matchEntries：单英文词大小写不敏感；无命中回退整本（兜底语义）', () => {
  const entries = [E('ace-001', 'Run tests first', 'before deploy', 'run npm test', '')];
  assert.equal(matchEntries(entries, 'Deploy').length, 1);
  assert.equal(matchEntries(entries, 'deploy').length, 1);
  // 无任何片段命中（全 0 分）→ 原样返回全部，保持整本读取兜底
  assert.equal(matchEntries(entries, 'no-such-word').length, 1);
  assert.equal(matchEntries(entries, 'no-such-word')[0].id, 'ace-001');
});

test('matchEntries：BM25——稀有词得分高于常见词（df 越小 idf 越大）', () => {
  const entries = [
    E('ace-001', '服务上线前先检查', '服务要上线', '先看服务日志', ''),
    E('ace-002', '灰度发布', '新服务上线时', '先灰度一批', ''),
    E('ace-003', '服务日志怎么翻', '要看服务日志', 'grep 关键字', ''),
  ];
  // 「服务」df=2（常见），「灰度」df=1（稀有）→ 含稀有词的 ace-002 排最前
  const hit = matchEntries(entries, '服务 灰度');
  assert.equal(hit[0].id, 'ace-002');
  assert.equal(hit.length, 3);
});

test('querySegments：空/纯标点 query 无片段；matchEntries 原样返回全部', () => {
  assert.deepEqual(querySegments(''), []);
  assert.deepEqual(querySegments('，。！？  ，'), []);
  const entries = [E('ace-001', 't', 'c', 'a', '')];
  const hit = matchEntries(entries, '，。！');
  assert.equal(hit.length, 1);
});