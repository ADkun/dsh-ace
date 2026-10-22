// dsh-ace 单元测试：playbook 持久化层（解析/序列化/增量操作/原子写/互斥锁）。
// 运行：npm test（node --test tests/）。只测纯逻辑层，不测工具注册（需要宿主）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePlaybook, serializePlaybook, applyOps, digestEntries, withLock, withExclusiveLock, writeFileAtomic, readOrInitPlaybook, readPlaybookSnapshot, detectConflicts, restoreLock, matchEntries, querySegments, withFileLock, LOCK_STALE_MS } from '../lib/playbook.js';

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

test('detectConflicts：无冲突返回 null（目标条目在快照与最新手册中完全一致）', () => {
  const entries = [E('ace-001', '编辑前先读', '修改既有文件之前', '先 read 再动手', '')];
  const snapshot = { entries };
  const latest = { entries };
  assert.equal(detectConflicts(snapshot, latest, [{ op: 'update', id: 'ace-001', title: 'x' }]), null);
  assert.equal(detectConflicts(snapshot, latest, [{ op: 'add', title: '新条目' }]), null);
});

test('detectConflicts：目标条目在复盘期间被删除 / 被修改 / 新出现 —— 明确报错而不是静默覆盖', () => {
  const snapshot = { entries: [E('ace-001', '标题A', '条件A', '做法A', '')] };
  // 被删除
  const deleted = detectConflicts(snapshot, { entries: [] }, [{ op: 'update', id: 'ace-001' }]);
  assert.match(deleted, /手册在本次复盘期间被其他进程改动，请重试/);
  assert.match(deleted, /已被删除/);
  // 被修改（内容不同）
  const modified = detectConflicts(snapshot, { entries: [E('ace-001', '标题B', '条件A', '做法A', '')] }, [{ op: 'update', id: 'ace-001' }]);
  assert.match(modified, /已被修改/);
  // 快照里没有、复盘期间新出现
  const appeared = detectConflicts({ entries: [] }, { entries: [E('ace-002', 'x', 'y', 'z', '')] }, [{ op: 'remove', id: 'ace-002' }]);
  assert.match(appeared, /是复盘期间新出现的/);
  // 快照里没有、最新也没有 → 交给 applyOps 按既有规则报「id 不存在」，这里不算冲突
  assert.equal(detectConflicts({ entries: [] }, { entries: [] }, [{ op: 'update', id: 'ace-404' }]), null);
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