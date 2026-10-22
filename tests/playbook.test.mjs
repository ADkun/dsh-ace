// dsh-ace 单元测试：playbook 持久化层（解析/序列化/增量操作/原子写/互斥锁）。
// 运行：npm test（node --test tests/）。只测纯逻辑层，不测工具注册（需要宿主）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlaybook, serializePlaybook, applyOps, digestEntries, withLock, withExclusiveLock, writeFileAtomic, readOrInitPlaybook, readPlaybookSnapshot, detectConflicts, describeConflicts, restoreLock, matchEntries, querySegments, withFileLock, LOCK_STALE_MS, readIdHighWater, ensureIdHighWater, ID_HIGHWATER_RE } from '../lib/playbook.js';
import { detectAddConflicts, detectAllConflicts } from '../lib/merge.js';
import { commitOps } from '../lib/commit.js';

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
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// —— 跨进程文件锁（withFileLock / <file>.lock） ——

test('withFileLock：正常加锁后执行、结束即释放（不残留 .lock）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  let sawLock = false;
  const r = await withFileLock(file, async () => {
    sawLock = (await fs.readFile(lock, 'utf8')).includes('"pid"');
    return 'done';
  });
  assert.equal(r, 'done');
  assert.ok(sawLock, '临界区内应存在 .lock 且含 pid');
  await assert.rejects(fs.stat(lock), /ENOENT/, '锁文件应在 finally 里清理');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：持锁进程已死的陈旧锁被下一个写者回收（时间戳再旧也回收）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  // 模拟上一个进程崩溃：锁文件留着，时间戳远早于 staleMs。
  await fs.writeFile(lock, JSON.stringify({ pid: 999999, time: Date.now() - LOCK_STALE_MS - 5000 }), 'utf8');
  const t0 = Date.now();
  const r = await withFileLock(file, async () => 'reclaimed');
  assert.equal(r, 'reclaimed');
  assert.ok(Date.now() - t0 < 5000, '死进程留下的锁应立刻回收，而不是等到超时');
  await assert.rejects(fs.stat(lock), /ENOENT/);
  // 内容读不懂的锁文件（写到一半）也能靠 mtime 回收：把 mtime 改到很久以前。
  await fs.writeFile(lock, '{not json', 'utf8');
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  await fs.utimes(lock, old, old);
  assert.equal(await withFileLock(file, async () => 'reclaimed-2'), 'reclaimed-2');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// —— 回归：新锁语义（活着的持锁者永不被抢 + nonce 校验 + rename 回收） ——

test('withFileLock：持锁进程存活时，即使持锁超过 staleMs 也不被抢（等到超时才失败）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  let entered = false;
  // 第一个写者：持锁 800ms（远超注入的 staleMs=50ms），pid 是本进程 → 活着。
  const holder = withFileLock(file, async () => {
    await new Promise((r) => setTimeout(r, 800));
    return 'held';
  }, { staleMs: 50, timeoutMs: 5000 });
  // 第二个写者：不得进入临界区，只能等到超时抛错。
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(
    withFileLock(file, async () => { entered = true; return 'stole'; }, { staleMs: 50, timeoutMs: 150 }),
    /等待手册写锁超时/,
    '活着的持锁者不应被抢：第二个写者应等到超时抛错',
  );
  assert.equal(entered, false, '第二个写者绝不能进入临界区');
  assert.equal(await holder, 'held');
  await assert.rejects(fs.stat(lock), /ENOENT/, '结束后不应残留 .lock');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：持锁进程已死时锁可被回收并正常取得（不必等满 staleMs）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  // pid 不存在（被强杀）；时间戳很新 —— 靠「进程已死」判定回收，与时间无关。
  await fs.writeFile(lock, JSON.stringify({ pid: 999999, time: Date.now(), id: 'dead-owner' }), 'utf8');
  const t0 = Date.now();
  const r = await withFileLock(file, async () => 'reclaimed', { staleMs: 60000, timeoutMs: 5000 });
  assert.equal(r, 'reclaimed');
  assert.ok(Date.now() - t0 < 3000, '死进程的锁应立刻回收');
  await assert.rejects(fs.stat(lock), /ENOENT/);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：三写者并发且其中一个持锁超过 staleMs —— 临界区不重叠、不丢写、无 .lock 残留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'counter.txt');
  await fs.writeFile(file, '0', 'utf8');
  let inCritical = 0;
  let maxConcurrent = 0;
  // 三个写者都在锁内做读-改-写；其中第一个刻意持锁 300ms（远超 staleMs=50ms）。
  const bump = (label, holdMs) => withFileLock(file, async () => {
    inCritical += 1;
    maxConcurrent = Math.max(maxConcurrent, inCritical);
    try {
      const n = Number(await fs.readFile(file, 'utf8'));
      await new Promise((r) => setTimeout(r, holdMs));
      await fs.writeFile(file, String(n + 1), 'utf8');
    } finally {
      inCritical -= 1;
    }
    return label;
  }, { staleMs: 50, timeoutMs: 10000 });
  await Promise.all([bump('A', 300), bump('B', 20), bump('C', 20)]);
  assert.equal(maxConcurrent, 1, '临界区绝不能重叠');
  assert.equal(await fs.readFile(file, 'utf8'), '3', '三次读-改-写应全部生效（不丢写）');
  const left = await fs.readdir(dir);
  assert.deepEqual(left, ['counter.txt'], '结束后不应残留 .lock');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：锁被回收后，原持锁者的 finally 不会删掉新主人的锁', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  // 模拟：我的锁被别人回收了，新主人已经建了新锁（nonce 不同）。
  const holder = withFileLock(file, async () => {
    await fs.rename(lock, lock + '.stale-sim');           // 别人回收走了我的锁
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, time: Date.now(), id: 'other-owner' }), 'utf8');
    return 'ok';
  });
  assert.equal(await holder, 'ok');
  // 我的 finally 已执行：它必须核对 nonce，发现不是自己的锁 → 不删。
  const still = await fs.readFile(lock, 'utf8');
  assert.ok(still.includes('other-owner'), '原持锁者不应删掉新主人的锁');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：并发两个写者串行，读-改-写不丢写', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'counter.txt');
  await fs.writeFile(file, '0', 'utf8');
  // 每个写者：读 → 等一会儿（放大竞态窗口）→ 写回 +1。锁生效则两次都算上。
  const bump = () => withFileLock(file, async () => {
    const n = Number(await fs.readFile(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 60));
    await fs.writeFile(file, String(n + 1), 'utf8');
  });
  await Promise.all([bump(), bump(), bump()]);
  assert.equal(await fs.readFile(file, 'utf8'), '3', '三次读-改-写应全部生效（串行不丢写）');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withExclusiveLock：锁覆盖整个读-改-写区间（区间内嵌 writeFileAtomic 不自死锁）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  // 区间内调用 writeFileAtomic —— 它内部还会再进一次 withFileLock，
  // 必须被识别为重入（否则自己等自己 → 超时）。
  const r = await withExclusiveLock(file, async () => {
    await writeFileAtomic(file, '# 手册\n');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.equal(await fs.readFile(file, 'utf8'), '# 手册\n');
  const left = await fs.readdir(dir);
  assert.deepEqual(left, ['playbook.md'], '区间结束后不应残留 .lock');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withExclusiveLock：并发写者各自读-改-写不丢写（区间在锁内）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'counter.txt');
  await fs.writeFile(file, '0', 'utf8');
  // 模拟真实写路径：读 → 算 → 写回，整段都在锁内。
  const bump = () => withExclusiveLock(file, async () => {
    const n = Number(await fs.readFile(file, 'utf8'));
    await new Promise((r) => setTimeout(r, 60));
    await fs.writeFile(file, String(n + 1), 'utf8');
  });
  await Promise.all([bump(), bump(), bump()]);
  assert.equal(await fs.readFile(file, 'utf8'), '3', '三次读-改-写应全部生效（串行不丢写）');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('withFileLock：持锁进程已死（pid 不存在）的锁被立刻回收，不必等满 staleMs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  const lock = file + '.lock';
  // 时间戳还很新（未过 staleMs），但 pid 是一个不存在的进程 —— 被强杀后留下的锁。
  await fs.writeFile(lock, JSON.stringify({ pid: 999999, time: Date.now() }), 'utf8');
  const t0 = Date.now();
  assert.equal(await withFileLock(file, async () => 'reclaimed'), 'reclaimed');
  assert.ok(Date.now() - t0 < 5000, '死进程留下的锁应立刻回收');
  await assert.rejects(fs.stat(lock), /ENOENT/);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('writeFileAtomic：写入后不残留 .lock 与临时文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-lock-'));
  const file = path.join(dir, 'playbook.md');
  await writeFileAtomic(file, 'x');
  const left = await fs.readdir(dir);
  assert.deepEqual(left, ['playbook.md']);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

// —— T68-T70：并发冲突检测（锁外快照 → 锁内最新手册的语义冲突） ——

test('readPlaybookSnapshot：只读不写盘；文件不存在时返回空条目而不是创建文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-snap-'));
  const file = path.join(dir, 'playbook.md');
  const snap = await readPlaybookSnapshot(file);
  assert.deepEqual(snap.entries, []);
  assert.ok(snap.header.length > 0, '缺省文档头应存在');
  // 关键：只读，不初始化
  await assert.rejects(fs.stat(file), /ENOENT/);
  // 有文件时读到条目
  await fs.writeFile(file, SAMPLE, 'utf8');
  const snap2 = await readPlaybookSnapshot(file);
  assert.equal(snap2.entries.length, 2);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('detectConflicts：无冲突时返回 {conflicts:[], safe:[…]}（目标条目在快照与最新手册中完全一致）', () => {
  const entries = [E('ace-001', '编辑前先读', '修改既有文件之前', '先 read 再动手', '')];
  const snapshot = { entries };
  const latest = { entries };
  const ok = detectConflicts(snapshot, latest, [{ op: 'update', id: 'ace-001', title: 'x' }]);
  assert.deepEqual(ok.conflicts, []);
  assert.equal(ok.safe.length, 1);
  assert.equal(describeConflicts(ok), null, '无冲突时 describeConflicts 返回 null');
  // add 不在 detectConflicts 的职责内（它的重复判定在 lib/merge.js），这里只确认不误报
  const withAdd = detectConflicts(snapshot, latest, [{ op: 'add', title: '新条目' }]);
  assert.deepEqual(withAdd.conflicts, []);
  assert.equal(withAdd.safe.length, 1);
});

test('detectConflicts：目标条目在复盘期间被删除 / 被修改 / 新出现 —— 逐条挑出冲突而不是整批一票否决', () => {
  const snapshot = { entries: [E('ace-001', '标题A', '条件A', '做法A', '')] };
  // 被删除
  const deleted = detectConflicts(snapshot, { entries: [] }, [{ op: 'update', id: 'ace-001' }]);
  assert.equal(deleted.conflicts.length, 1);
  assert.equal(deleted.conflicts[0].op, 'update');
  assert.equal(deleted.conflicts[0].id, 'ace-001');
  assert.match(deleted.conflicts[0].reason, /已被删除/);
  assert.match(describeConflicts(deleted), /手册在本次复盘期间被其他进程改动，请重试/);
  // 被修改（内容不同）
  const modified = detectConflicts(snapshot, { entries: [E('ace-001', '标题B', '条件A', '做法A', '')] }, [{ op: 'update', id: 'ace-001' }]);
  assert.match(modified.conflicts[0].reason, /已被修改/);
  // 快照里没有、复盘期间新出现
  const appeared = detectConflicts({ entries: [] }, { entries: [E('ace-002', 'x', 'y', 'z', '')] }, [{ op: 'remove', id: 'ace-002' }]);
  assert.match(appeared.conflicts[0].reason, /是复盘期间新出现的/);
  // 快照里没有、最新也没有 → 交给 applyOps 按既有规则报「id 不存在」，这里不算冲突
  const missing = detectConflicts({ entries: [] }, { entries: [] }, [{ op: 'update', id: 'ace-404' }]);
  assert.deepEqual(missing.conflicts, []);
  assert.equal(missing.safe.length, 1);
});

// —— 缺陷 A：add 参与冲突检测 ——

test('缺陷A｜detectAddConflicts：add 与「快照之后新出现的条目」完全重复 → 判为冲突', () => {
  const appeared = E('ace-002', '提交前先跑测试', '改完代码要提交', '先跑一遍测试再提交', '避免带病提交');
  const snapshot = { entries: [] };
  const latest = { entries: [appeared] };
  const out = detectAddConflicts(snapshot, latest, [{
    op: 'add', title: '提交前先跑测试', condition: '改完代码要提交', action: '先跑一遍测试再提交', rationale: '别的原因',
  }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'add');
  assert.equal(out[0].matchId, 'ace-002');
  assert.match(out[0].reason, /完全重复/);
});

test('缺陷A｜detectAddConflicts：add 与「快照之后新出现的条目」标题相同但正文不同 → 判为冲突（不靠 BM25 也能拦）', () => {
  const appeared = E('ace-002', '提交前先跑测试', '改完代码要提交', '先跑一遍测试再提交', '避免带病提交');
  const snapshot = { entries: [] };
  const latest = { entries: [appeared] };
  const out = detectAddConflicts(snapshot, latest, [{
    op: 'add', title: '提交前先跑测试', condition: '提交代码之前', action: '运行 npm test 确认全部通过', rationale: '避免把坏代码推上去',
  }]);
  assert.equal(out.length, 1, '同名不同内容的并发 add 必须被拦下');
  assert.equal(out[0].matchId, 'ace-002');
  assert.match(out[0].reason, /标题相同/);
});

test('缺陷A｜detectAddConflicts：与「快照里本就存在的条目」重复 → 不拦（Curator 去重的既有职责，不重复拦）', () => {
  const existed = E('ace-001', '编辑前先读', '修改既有文件之前', '先 read 再动手', '');
  const snapshot = { entries: [existed] };
  const latest = { entries: [existed] };
  const out = detectAddConflicts(snapshot, latest, [{
    op: 'add', title: '编辑前先读', condition: '修改既有文件之前', action: '先 read 再动手',
  }]);
  assert.deepEqual(out, [], '快照里本就存在的重复交给 applyOps/curator，不在冲突层拦');
});

test('缺陷A｜detectAddConflicts：与新出现条目无关的 add → 不拦（不误伤）', () => {
  const appeared = E('ace-002', '数据库索引要定期维护', '查询变慢时', '重建索引并分析执行计划', '');
  const out = detectAddConflicts({ entries: [] }, { entries: [appeared] }, [{
    op: 'add', title: '提交前先跑测试', condition: '改完代码要提交', action: '先跑一遍测试再提交',
  }]);
  assert.deepEqual(out, []);
});

test('缺陷A｜detectAllConflicts：同一批里冲突项与安全项分离（冲突的那条被挑出，其余照常落盘）', () => {
  const snapshot = { entries: [E('ace-001', '标题A', '条件A', '做法A', '')] };
  const latest = { entries: [E('ace-001', '标题B', '条件A', '做法A', ''), E('ace-002', '新条目', 'c', 'a', '')] };
  const ops = [
    { op: 'update', id: 'ace-001', action: '新做法' },   // 冲突：ace-001 已被改过
    { op: 'add', title: '新条目', condition: 'c', action: 'a' }, // 冲突：与新出现的 ace-002 完全重复
    { op: 'add', title: '安全条目', condition: 'c2', action: 'a2' }, // 安全
  ];
  const report = detectAllConflicts(snapshot, latest, ops);
  assert.equal(report.conflicts.length, 2);
  assert.equal(report.safe.length, 1);
  assert.equal(report.safe[0].title, '安全条目');
  assert.equal(report.conflicts[0].index, 0);
  assert.equal(report.conflicts[1].index, 1);
});

// —— 缺陷 B：冲突逐条判定 + 冲突回报 ——

test('缺陷B｜commitOps：同批里一条冲突 + 一条安全 → 安全的落盘、冲突的不落盘并被结构化回报', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-partial-'));
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] 标题A',
    '- 条件：条件A',
    '- 做法：做法A',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n') + '\n', 'utf8');
  // 快照：ace-001 是「标题A」
  const snapshot = { entries: [E('ace-001', '标题A', '条件A', '做法A', '')] };
  // 最新手册：ace-001 已被别人改成「标题B」
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] 标题B',
    '- 条件：条件A',
    '- 做法：做法A',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n') + '\n', 'utf8');
  const out = await commitOps(file, snapshot, [
    { op: 'update', id: 'ace-001', action: '新做法' },
    { op: 'add', title: '安全条目', condition: 'c2', action: 'a2' },
  ], 60);
  assert.equal(out.conflicts.length, 1, '冲突的那一条要被挑出来');
  assert.equal(out.conflicts[0].id, 'ace-001');
  assert.match(out.conflicts[0].reason, /已被修改/);
  assert.deepEqual(out.result.added, ['ace-002'], '安全的那条照常落盘');
  const onDisk = await fs.readFile(file, 'utf8');
  assert.ok(onDisk.includes('安全条目'), '安全条目已落盘');
  assert.ok(onDisk.includes('标题B'), '别人写的版本没被覆盖');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('缺陷B｜commitOps：整批都是冲突项 → 一条都不写盘，冲突原样回报', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-allconflict-'));
  const file = path.join(dir, 'playbook.md');
  const text = [
    '# ACE 操作手册',
    '',
    '### [ace-001] 标题A',
    '- 条件：条件A',
    '- 做法：做法A',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n') + '\n';
  await fs.writeFile(file, text, 'utf8');
  const snapshot = { entries: [E('ace-001', '标题A', '条件A', '做法A', '')] };
  await fs.writeFile(file, text.replace('标题A', '标题B'), 'utf8');
  const out = await commitOps(file, snapshot, [{ op: 'update', id: 'ace-001', action: 'x' }], 60);
  assert.equal(out.conflicts.length, 1);
  assert.deepEqual(out.result.added, []);
  assert.deepEqual(out.result.updated, []);
  assert.equal(await fs.readFile(file, 'utf8'), text.replace('标题A', '标题B'), '全冲突时不该有任何写入');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// —— 缺陷 C：条目 id 不复用 ——

test('缺陷C｜applyOps：删掉最高编号后再新增 → 不复用那个编号（highWater 生效）', () => {
  const entries = [E('ace-001', 't1', 'c1', 'a1', ''), E('ace-002', 't2', 'c2', 'a2', ''), E('ace-003', 't3', 'c3', 'a3', '')];
  const removed = applyOps(entries, [{ op: 'remove', id: 'ace-003' }], 60, 3);
  assert.deepEqual(removed.removed, ['ace-003']);
  assert.equal(removed.highWater, 3, '高水位记住已用过的最大编号');
  const added = applyOps(removed.entries, [{ op: 'add', title: 't4', condition: 'c4', action: 'a4' }], 60, removed.highWater);
  assert.deepEqual(added.added, ['ace-004'], '删除最高编号后新增必须大于它');
});

test('缺陷C｜applyOps：不传 highWater 且最高编号被删 → 仍按现存最大编号 +1（高水位由调用方负责传）', () => {
  const entries = [E('ace-001', 't1', 'c1', 'a1', ''), E('ace-002', 't2', 'c2', 'a2', ''), E('ace-003', 't3', 'c3', 'a3', '')];
  const removed = applyOps(entries, [{ op: 'remove', id: 'ace-003' }], 60);
  assert.equal(removed.highWater, 3, '即使没传 highWater，也把现存最大编号记成高水位');
});

test('缺陷C｜readIdHighWater / ensureIdHighWater：高水位存在文档头标记行里，人可直接编辑、渲染不可见', () => {
  const header = ['# ACE 操作手册', '', '> 人可以直接编辑。', ''];
  assert.equal(readIdHighWater(header), 0);
  const marked = ensureIdHighWater(header, 7);
  assert.equal(readIdHighWater(marked), 7);
  assert.ok(marked.some((l) => ID_HIGHWATER_RE.test(l)), '标记行应存在');
  assert.ok(marked.some((l) => l.includes('ace:id-highwater: 7')));
  // 旧手册没有这行也能读（记 0）
  assert.equal(readIdHighWater(['# ACE 操作手册', '']), 0);
  // 幂等：同样的高水位不重复追加
  assert.deepEqual(ensureIdHighWater(marked, 7), marked);
  // 高水位变大 → 更新标记
  const bumped = ensureIdHighWater(marked, 9);
  assert.equal(readIdHighWater(bumped), 9);
  assert.equal(bumped.filter((l) => ID_HIGHWATER_RE.test(l)).length, 1, '标记行只留一行');
  // 人手把标记删了 → 重新写回
  assert.equal(readIdHighWater(bumped.filter((l) => !ID_HIGHWATER_RE.test(l))), 0);
});

test('缺陷C｜commitOps：删掉最高编号条目后新增 → 新编号大于被删的编号，且高水位落进文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-idhw-'));
  const file = path.join(dir, 'playbook.md');
  const mk = (id, title) => [
    '### [' + id + '] ' + title,
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ];
  await fs.writeFile(file, ['# ACE 操作手册', '', ...mk('ace-001', 't1'), ...mk('ace-002', 't2'), ...mk('ace-003', 't3')].join('\n') + '\n', 'utf8');
  const snapshot = { entries: [E('ace-001', 't1', 'c', 'a', ''), E('ace-002', 't2', 'c', 'a', ''), E('ace-003', 't3', 'c', 'a', '')] };
  const rm = await commitOps(file, snapshot, [{ op: 'remove', id: 'ace-003' }], 60);
  assert.deepEqual(rm.result.removed, ['ace-003']);
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.includes('ace:id-highwater: 3'), '高水位标记应写进文档头');
  const snap2 = { entries: rm.result.entries };
  const add = await commitOps(file, snap2, [{ op: 'add', title: 't4', condition: 'c', action: 'a' }], 60);
  assert.deepEqual(add.result.added, ['ace-004'], '删除最高编号后新增不得复用 ace-003');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('缺陷C｜commitOps：人手编辑插入高编号条目 → 下一个新增大于它', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-manual-id-'));
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] t1',
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
    '### [ace-042] 人手插入的条目',
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n') + '\n', 'utf8');
  const snapshot = { entries: [E('ace-001', 't1', 'c', 'a', ''), E('ace-042', '人手插入的条目', 'c', 'a', '')] };
  const out = await commitOps(file, snapshot, [{ op: 'add', title: '新条目', condition: 'c2', action: 'a2' }], 60);
  assert.deepEqual(out.result.added, ['ace-043'], '新增编号必须大于人手工插入的最高编号');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// —— T71-T73：锁的重入与回收兜底 ——

test('withExclusiveLock：同路径嵌套调用不死锁（withLock 重入保护）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-reentrant-'));
  const file = path.join(dir, 'playbook.md');
  const order = [];
  await withExclusiveLock(file, async () => {
    order.push('outer-start');
    // 同路径再取一次同一把锁：必须直接执行，不能自死锁
    await withExclusiveLock(file, async () => {
      order.push('inner');
    });
    // 跨进程锁也要能重入（writeFileAtomic 内部会再取一次）
    await writeFileAtomic(file, 'inner-write');
    order.push('outer-end');
  });
  assert.deepEqual(order, ['outer-start', 'inner', 'outer-end']);
  assert.equal(await fs.readFile(file, 'utf8'), 'inner-write');
  // 不同路径仍互不阻塞（重入保护不改变这一点）
  const other = path.join(dir, 'other.md');
  const t0 = Date.now();
  await Promise.all([
    withExclusiveLock(file, async () => { await new Promise((r) => setTimeout(r, 80)); }),
    withExclusiveLock(other, async () => { await new Promise((r) => setTimeout(r, 80)); }),
  ]);
  assert.ok(Date.now() - t0 < 150, '不同路径的两个锁应并行');
  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, ['playbook.md'], '不应有 .lock 残留');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('restoreLock：目标位置已被占住时绝不覆盖别人的锁', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-restore-'));
  const from = path.join(dir, 'a.lock.stale-x');
  const to = path.join(dir, 'a.lock');
  await fs.writeFile(from, JSON.stringify({ pid: process.pid, time: Date.now(), id: 'mine' }), 'utf8');
  await fs.writeFile(to, JSON.stringify({ pid: process.pid, time: Date.now(), id: 'other' }), 'utf8');
  const ok = await restoreLock(from, to);
  assert.equal(ok, false, '位置被占住时必须放弃放回');
  const content = JSON.parse(await fs.readFile(to, 'utf8'));
  assert.equal(content.id, 'other', '别人的锁不能被覆盖');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('restoreLock：跨卷（link 返回 ENOENT）也能把锁放回原位', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-restore2-'));
  const from = path.join(dir, 'a.lock.stale-x');
  const to = path.join(dir, 'a.lock');
  const payload = JSON.stringify({ pid: process.pid, time: Date.now(), id: 'mine' });
  await fs.writeFile(from, payload, 'utf8');
  // 目标为空 → 无论 link 成功还是失败（跨卷 ENOENT），最终锁都必须回到 to，且内容一致
  const ok = await restoreLock(from, to);
  assert.equal(ok, true, '位置为空时应放回成功');
  assert.equal(await fs.readFile(to, 'utf8'), payload);
  await assert.rejects(fs.stat(from), /ENOENT/, '源文件应被清理');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
// —— 独立验收发现的 5 个缺陷（缺陷 1/2/3/4/5）——

test('缺陷1｜detectAddConflicts：同领域不同经验（《配置里缺少重试次数》vs《配置里缺少超时时间》）→ 不判冲突', () => {
  const appeared = E('ace-009', '配置里缺少超时时间', '配置服务调用时', '设置合理的超时时间');
  const out = detectAddConflicts({ entries: [] }, { entries: [appeared] }, [{
    op: 'add', title: '配置里缺少重试次数', condition: '配置服务调用时', action: '设置合理的重试次数',
  }]);
  assert.deepEqual(out, [], '两条都是「配置」领域但经验不同，必须各自落盘，不得判成高度相似');
});

test('缺陷2｜冲突理由里的相似度百分比不超过 100%（不出现「高度相似（163%）」）', () => {
  const appeared = E('ace-009', '配置里缺少超时时间', '配置服务调用时', '设置合理的超时时间', '曾因超时导致请求堆积');
  const out = detectAddConflicts({ entries: [] }, { entries: [appeared] }, [{
    op: 'add', title: '配置里缺少重试次数', condition: '配置服务调用时', action: '设置合理的重试次数', rationale: '曾因超时导致请求堆积',
  }]);
  assert.equal(out.length, 1, '这个用例应当仍被判为高度相似（只是百分比不得越界）');
  const reason = out[0].reason;
  assert.match(reason, /高度相似（\d{1,3}%）/);
  const pct = Number(reason.match(/高度相似（(\d{1,3})%）/)[1]);
  assert.ok(pct <= 100, '相似度百分比不得大于 100：' + reason);
  assert.ok(!/（\d{3,}%）/.test(reason), '不得出现三位数百分比：' + reason);
});

test('缺陷3｜并发改名 + 同标题新增 → 冲突被检出（走 commitOps 真实路径）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-rename-'));
  const file = path.join(dir, 'playbook.md');
  // 别人把 ace-002 改名成「重复标题」并落盘
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-002] 重复标题',
    '- 条件：条件A',
    '- 做法：做法A',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n'), 'utf8');
  // 自己持的是改名前的快照
  const snapshot = { entries: [E('ace-002', '旧标题', '条件A', '做法A', '')] };
  const out = await commitOps(file, snapshot, [{ op: 'add', title: '重复标题', condition: '条件B', action: '做法B' }], 60);
  assert.equal(out.conflicts.length, 1, '并发改名后的同标题新增必须被检出');
  assert.match(out.conflicts[0].reason, /标题相同/);
  assert.deepEqual(out.result.added, [], '冲突的那条不落盘');
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal((onDisk.match(/^### /gm) || []).length, 1, '磁盘上不得留下两条同标题');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('缺陷4｜高水位标记被挪进条目体内 → 写回后全文只剩一份标记、且在文档头，条目数与新编号都正确', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-markerin-'));
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] t1',
    '- 条件：c',
    '- 做法：a',
    '<!-- ace:id-highwater: 5 -->',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
    '### [ace-002] t2',
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n'), 'utf8');
  const snapshot = { entries: [E('ace-001', 't1', 'c', 'a', ''), E('ace-002', 't2', 'c', 'a', '')] };
  const out = await commitOps(file, snapshot, [{ op: 'add', title: 't3', condition: 'c2', action: 'a2' }], 60);
  const after = await fs.readFile(file, 'utf8');
  const lines = after.split('\n');
  const markerLines = lines.filter((l) => ID_HIGHWATER_RE.test(l));
  assert.equal(markerLines.length, 1, '全文只能有一份高水位标记，实际：' + JSON.stringify(markerLines));
  assert.ok(lines.indexOf(markerLines[0]) < lines.findIndex((l) => l.startsWith('### ')), '标记必须在文档头的规范位置');
  assert.match(markerLines[0], /ace:id-highwater: 6/, '标记应被更新为新的高水位');
  assert.equal((after.match(/^### /gm) || []).length, 3, '条目数 = 原 2 条 + 新增 1 条');
  assert.deepEqual(out.result.added, ['ace-006'], '新编号必须大于标记里的历史高水位 5');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('缺陷5｜人手同时删掉最高编号条目与高水位标记 → 编号被复用一次，随后标记被重写为当前最大编号，也就是刚被复用的那个号（当前行为钉住）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-reuse-'));
  const file = path.join(dir, 'playbook.md');
  // 手册里只剩 ace-001/ace-002，且没有高水位标记（历史最大值 ace-003 无法从文件恢复）
  await fs.writeFile(file, [
    '# ACE 操作手册',
    '',
    '### [ace-001] t1',
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
    '### [ace-002] t2',
    '- 条件：c',
    '- 做法：a',
    '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
    '',
  ].join('\n'), 'utf8');
  const snapshot = { entries: [E('ace-001', 't1', 'c', 'a', ''), E('ace-002', 't2', 'c', 'a', '')] };
  const out = await commitOps(file, snapshot, [{ op: 'add', title: 't3', condition: 'c2', action: 'a2' }], 60);
  assert.deepEqual(out.result.added, ['ace-003'], '无 marker 且最高号已删 → 该编号被复用一次（已知限制）');
  const after = await fs.readFile(file, 'utf8');
  const markerLines = after.split('\n').filter((l) => ID_HIGHWATER_RE.test(l));
  assert.equal(markerLines.length, 1);
  assert.match(markerLines[0], /ace:id-highwater: 3/, '复用之后标记被重写为 3');
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
