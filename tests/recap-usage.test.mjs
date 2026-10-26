// 第 33 轮：命中记账（hits）在**回合边界**一次原子写盘的行为测试。
//
// 钉住的三件事：
// - 回合边界**无条件**取走命中账本（冷却回合、阈值未到的回合同样要取），
//   一次 commitMeta 原子写盘：hits += 1、lastHit = 毫秒时间戳。
//   冷却不是豁免理由 —— 留着不记会让 lastHit 对不上真实使用时刻，下一回合还会算错归属。
// - 同一个 agent 的多次写盘按到达顺序串成一条链；空闲边沿跑复盘前先等它写完。
//   复盘第一步要按 hits 选淘汰对象（lib/evict.js 的 compareForEviction），读到旧 hits 会选错条目。
// - 命中记账是尽力而为的观测数据：取账本抛错、写盘失败都只 warn，绝不让回合结束这条链路炸掉。
//
// 正负评分（bumpScores / helpful / harmful）与「结算重试 / 未观测态」那一整套时序机制已在第 33 轮
// 整层删除（外部因素主导回合成败，归因不可靠），对应的旧用例随之删除；这里保留
// 「回合边界取空账本 + 一次原子写盘」的骨架，按新语义重写。
//
// 全部真跑生产模块：createRecapController（真控制器）、createUsageLedger（真账本）、
// commitMeta + markHits（与 lib/index.js 的 recordHits 是同一组合，见 lib/index.js:733-750）。
// 手册落在 os.tmpdir() 下的临时目录，写入走生产的 withExclusiveLock + writeFileAtomic，
// 绝不碰真实手册。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-recap-usage-'));
const load = (name) => import(pathToFileURL(path.join(HERE, '..', 'lib', name)).href);

const { createRecapController } = await load('recap.js');
const { createUsageLedger } = await load('ledger.js');
const { serializePlaybook, parsePlaybook, withExclusiveLock, writeFileAtomic, readPlaybookSnapshot, markHits } = await load('playbook.js');
const { commitMeta } = await load('commit.js');
const { nowStamp, dayOf } = await load('timestamp.js');
const { compareForEviction } = await load('evict.js');

const REPO = path.resolve(HERE, '..');

/** 一个完全独立的子进程：自己读盘、自己按生产比较器算一遍淘汰顺序，把 id 列表写出来。 */
const ORDER_WORKER_SRC = `
import fs from 'node:fs';
const [PLAYBOOK_URL, EVICT_URL, file, outPath] = process.argv.slice(1);
const { readPlaybookSnapshot } = await import(PLAYBOOK_URL);
const { compareForEviction } = await import(EVICT_URL);
const snapshot = await readPlaybookSnapshot(file);
const ids = snapshot.entries.slice().sort(compareForEviction).map((e) => e.id);
fs.writeFileSync(outPath, JSON.stringify({ ok: true, ids }), 'utf8');
`;

function runOrderWorker(file, tag) {
  const outPath = path.join(ROOT, 'order-' + tag + '.json');
  try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', ORDER_WORKER_SRC,
      new URL('../lib/playbook.js', import.meta.url).href,
      new URL('../lib/evict.js', import.meta.url).href,
      file,
      outPath,
    ], { stdio: 'ignore', cwd: REPO });
    child.on('error', reject);
    child.on('exit', (code) => {
      try {
        const raw = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        if (!raw.ok) return reject(new Error('worker 失败：' + JSON.stringify(raw)));
        resolve(raw.ids);
      } catch (error) {
        reject(new Error('worker ' + tag + ' 没有产出（exit ' + code + '）：' + ((error && error.message) || error)));
      }
    });
  });
}

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;
const TODAY = dayOf(nowStamp());
let seq = 0;

/** 一条手册条目（形状与 parsePlaybook 一致，落盘走真序列化器）。元数据定死四字段。 */
function entry(spec) {
  const created = spec.created ?? nowStamp();
  return {
    id: spec.id,
    title: spec.title ?? '标题',
    condition: spec.condition ?? '条件',
    action: spec.action ?? '做法',
    rationale: spec.rationale ?? '',
    meta: {
      created,
      updated: spec.updated ?? created,
      hits: spec.hits ?? 0,
      lastHit: spec.lastHit ?? '',
    },
    extraLines: [],
  };
}

/** 真走生产的锁 + 原子写，把手册写进本次用例自己的临时目录。 */
async function writePlaybook(entries) {
  const file = path.join(ROOT, 'playbook-' + (seq += 1) + '.md');
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
  return file;
}

const readParsed = (file) => parsePlaybook(fs.readFileSync(file, 'utf8'));
const byId = (entries, id) => entries.find((e) => e.id === id);

function makeAgent() {
  return {
    id: 'a1',
    session: { header: { origin: 'startup' } },
    phase: 'idle',
    async runMaintenance(job) { return await job(new AbortController().signal); },
    async whenIdle() {},
  };
}

/** 与 lib/index.js:733-750 的 recordHits 同一组合：读快照 → commitMeta → markHits。 */
async function defaultFlush(file, { ids }) {
  const snapshot = await readPlaybookSnapshot(file);
  return commitMeta(file, snapshot, {
    ids,
    apply: (entries, safeIds) => {
      const res = markHits(entries, safeIds);
      return { entries: res.entries, changed: res.hit };
    },
  });
}

/**
 * 真控制器 + 真账本。runRecap 默认只记账不跑真复盘（真复盘链路由 tests/recap-pipeline.test.mjs 与
 * tests/e2e.test.mjs 覆盖）。flush 的实现可热替换（holder.impl），用来模拟写盘失败/写盘在飞。
 */
function makeHarness({ file, config = {}, runRecap, takeHitIds, flushHits } = {}) {
  const ledger = createUsageLedger();
  const logs = [];
  const push = (level) => (message) => logs.push([level, String(message)]);
  const logger = { info: push('info'), warn: push('warn'), error: push('error'), debug: () => {} };
  const calls = { flush: [], recap: [], take: 0, note: [] };
  const holder = { impl: flushHits || ((payload) => defaultFlush(file, payload)) };
  const agent = makeAgent();
  const controller = createRecapController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0, ...config }),
    logger,
    takeHitIds: (a) => { calls.take += 1; return (takeHitIds || ((x) => ledger.take(x)))(a); },
    // 与 lib/index.js:600-601 的生产接线同款：写盘失败时调度器借这个通道把 ids 写回账本。
    noteHitIds: (a, ids) => { calls.note.push({ agent: a, ids: ids.slice() }); ledger.note(a, ids); },
    flushHits: async (payload) => {
      calls.flush.push(payload);
      return holder.impl(payload);
    },
    runRecap: async (a, pending) => {
      calls.recap.push({ pending });
      if (runRecap) return runRecap(a, pending);
      return null;
    },
  });
  const warns = () => logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
  const infos = () => logs.filter(([lvl]) => lvl === 'info').map(([, m]) => m);
  return { controller, ledger, agent, logs, calls, warns, infos, file, holder };
}

/** 走真事件语义：回合里发生一次 mutating 调用 → 回合结束 → 空闲边沿。 */
async function endTurn(h, turn) {
  h.controller.countMutating(h.agent);
  h.controller.onTurnStopping({ agent: h.agent, turn });
  await h.controller.onStatus({ agent: h.agent, status: 'idle' });
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('回合边界｜注入过的条目 hits +1、lastHit 是毫秒时间戳、账本当场取空', async () => {
  const file = await writePlaybook([
    entry({ id: 'ace-001', title: '数据库迁移前先备份' }),
    entry({ id: 'ace-002', title: '改表前先看依赖' }),
  ]);
  const h = makeHarness({ file });
  h.ledger.note(h.agent, ['ace-001']);

  await endTurn(h, 2);

  const parsed = readParsed(file);
  const hit = byId(parsed.entries, 'ace-001');
  assert.equal(hit.meta.hits, 1, '被用过一次的条目 hits 必须是 1');
  assert.match(hit.meta.lastHit, STAMP_RE, 'lastHit 必须是毫秒精度本地时区 ISO：' + hit.meta.lastHit);
  assert.equal(dayOf(hit.meta.lastHit), TODAY, 'lastHit 的日期部分该是今天');
  assert.equal(byId(parsed.entries, 'ace-002').meta.hits, 0, '没被用过的条目不许被连带记账');
  assert.equal(byId(parsed.entries, 'ace-002').meta.lastHit, '', '没被用过的条目 lastHit 保持空串');
  assert.deepEqual(h.ledger.peek(h.agent), [], '回合边界必须把账本取空（否则会漏到下一回合去记）');
  assert.equal(h.calls.flush.length, 1, '一个回合只许一次原子写盘：' + h.calls.flush.length);
  assert.deepEqual(h.calls.flush[0].ids, ['ace-001'], '写盘的就是本回合真用过的那些 id');
});

test('回合边界｜同一批命中只落一次盘：同回合再结束一次不会重复 +1', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const h = makeHarness({ file });
  h.ledger.note(h.agent, ['ace-001']);
  h.ledger.note(h.agent, ['ace-001', 'ace-001']);

  await endTurn(h, 2);
  await endTurn(h, 2);

  assert.equal(byId(readParsed(file).entries, 'ace-001').meta.hits, 1, '同一批命中只许 +1 次');
  assert.equal(h.calls.flush.length, 1, '只有第一批有 id，第二批不该再写盘：' + h.calls.flush.length);
});

test('回合边界｜冷却回合不挂复盘待办，命中照样写盘（绝不留到下一回合）', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  // 冷却 99 回合：本轮绝不触发复盘（既没有待办，也不调 runRecap）。
  const h = makeHarness({ file, config: { autoRecapCooldownTurns: 99 } });
  h.ledger.note(h.agent, ['ace-001']);

  const outcome = h.controller.onTurnStopping({ agent: h.agent, turn: 2 });
  assert.equal(outcome.trigger, false, '冷却回合同样不触发复盘');
  await h.controller.onStatus({ agent: h.agent, status: 'idle' });

  assert.equal(h.calls.recap.length, 0, '冷却回合不跑复盘');
  assert.equal(byId(readParsed(file).entries, 'ace-001').meta.hits, 1, '冷却回合的命中也要记账（B1 的回潮防线）');
  assert.deepEqual(h.ledger.peek(h.agent), [], '冷却回合也要把账本取空');
});

test('回合边界｜没有命中就不写盘：手册一个字不改', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const before = fs.readFileSync(file, 'utf8');
  const statBefore = fs.statSync(file).mtimeMs;
  const h = makeHarness({ file });

  await endTurn(h, 2);

  assert.equal(fs.readFileSync(file, 'utf8'), before, '没有命中就不该有任何写入');
  assert.equal(fs.statSync(file).mtimeMs, statBefore, '一次空写都不许发生');
  assert.equal(h.calls.flush.length, 0, '没有 id 就不该调写盘');
});

test('回合边界｜写盘失败只 warn 不抛：这批命中退回账本，下个回合边界真重试落盘', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const h = makeHarness({ file });
  let boom = true;
  h.holder.impl = async (payload) => {
    if (boom) throw new Error('磁盘满了');
    return defaultFlush(file, payload);
  };

  h.ledger.note(h.agent, ['ace-001']);
  await endTurn(h, 2); // 写盘失败：不抛
  assert.ok(
    h.warns().some((m) => m.includes('命中落盘失败') && m.includes('已退回账本') && m.includes('下个回合边界重试')),
    '写盘失败的 warn 必须说清「已退回账本、下个回合边界重试」（旧文案「下个回合边界再记」是假话）：' + JSON.stringify(h.warns()),
  );
  assert.equal(byId(readParsed(file).entries, 'ace-001').meta.hits, 0, '这次确实没写进去（失败是真的失败，不是静默成功）');
  assert.deepEqual(h.ledger.peek(h.agent), ['ace-001'], '写盘失败必须把这批 id 退回账本 —— 不许像旧实现那样真丢');

  // 第 34 轮的关键：这一回合**故意不 note 任何新命中**，落盘成功只能来自「退回账本」那批。
  boom = false;
  await endTurn(h, 3);
  assert.equal(byId(readParsed(file).entries, 'ace-001').meta.hits, 1, '下个回合边界必须真的把退回账本的命中重试落盘（不许丢）');
  assert.deepEqual(h.ledger.peek(h.agent), [], '重试成功后账本必须重新清空');
  assert.equal(h.calls.flush.length, 2, '失败一次 + 重试一次 = 两次写盘尝试：' + h.calls.flush.length);
  assert.deepEqual(h.calls.flush[1].ids, ['ace-001'], '第二次写盘的就是上一回合退回的那批 id');
});

test('回合边界｜退回账本的命中与下一批新命中合并成一次写盘（不拆成两笔）', async () => {
  const file = await writePlaybook([
    entry({ id: 'ace-001', title: '数据库迁移前先备份' }),
    entry({ id: 'ace-002', title: '改表前先看依赖' }),
  ]);
  const h = makeHarness({ file });
  let boom = true;
  h.holder.impl = async (payload) => {
    if (boom) throw new Error('磁盘满了');
    return defaultFlush(file, payload);
  };

  h.ledger.note(h.agent, ['ace-001']);
  await endTurn(h, 2);
  assert.deepEqual(h.ledger.peek(h.agent), ['ace-001']);

  boom = false;
  h.ledger.note(h.agent, ['ace-002']);
  await endTurn(h, 3);

  assert.equal(h.calls.flush.length, 2, '一个回合边界只许一次写盘：' + h.calls.flush.length);
  assert.deepEqual(h.calls.flush[1].ids, ['ace-001', 'ace-002'], '退回的那批排在前面，与新的命中合并成一批');
  const parsed = readParsed(file);
  assert.equal(byId(parsed.entries, 'ace-001').meta.hits, 1, '退回的命中重试成功');
  assert.equal(byId(parsed.entries, 'ace-002').meta.hits, 1, '新命中照常记账');
});

test('回合边界｜没有 noteHitIds 可退时，warn 明说这批命中已丢失（不许再说「下个回合边界再记」）', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const ledger = createUsageLedger();
  const logs = [];
  const controller = createRecapController({
    getConfig: () => ({ autoRecap: false }),
    logger: { info: (m) => logs.push(['info', String(m)]), warn: (m) => logs.push(['warn', String(m)]), error: () => {}, debug: () => {} },
    takeHitIds: (a) => ledger.take(a),
    // 故意不传 noteHitIds：退化为「写盘失败即丢弃」，但文案必须是诚实的。
    flushHits: async () => { throw new Error('磁盘满了'); },
  });
  const agent = makeAgent();
  ledger.note(agent, ['ace-001']);
  controller.onTurnStopping({ agent, turn: 2 });
  await controller.onStatus({ agent, status: 'idle' });

  const warns = logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
  assert.ok(warns.some((m) => m.includes('命中落盘失败') && m.includes('没有账本可退回') && m.includes('已丢失')), '退化路径也必须说真话：' + JSON.stringify(warns));
  assert.ok(!warns.some((m) => m.includes('下个回合边界再记')), '旧文案「再记」已删（那是没实现的承诺）：' + JSON.stringify(warns));
});

test('回合边界｜取账本抛错只 warn：本回合按没有命中处理，回合结束不炸', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const h = makeHarness({ file, takeHitIds: () => { throw new Error('账本坏了'); } });

  h.controller.countMutating(h.agent);
  const outcome = h.controller.onTurnStopping({ agent: h.agent, turn: 2 });
  assert.equal(outcome.trigger, true, '取账本出错不该影响复盘判定');
  await h.controller.onStatus({ agent: h.agent, status: 'idle' });

  assert.ok(h.warns().some((m) => m.includes('取命中账本时出错') && m.includes('按没有命中处理')), '取账本失败必须留 warn：' + JSON.stringify(h.warns()));
  assert.equal(h.calls.flush.length, 0, '没取到 id 就不写盘');
  assert.equal(h.calls.recap.length, 1, '复盘照常跑（命中记账失败不影响复盘）');
});

test('空闲边沿｜先等在飞的命中落盘，再跑复盘（复盘读到的 hits 一定是最新的）', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const steps = [];
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const h = makeHarness({
    file,
    flushHits: async (payload) => {
      steps.push('flush:start');
      await gate;
      const out = await defaultFlush(file, payload);
      steps.push('flush:done');
      return out;
    },
    runRecap: async () => {
      steps.push('recap');
      return null;
    },
  });
  h.ledger.note(h.agent, ['ace-001']);

  h.controller.countMutating(h.agent);
  h.controller.onTurnStopping({ agent: h.agent, turn: 2 });
  const idle = h.controller.onStatus({ agent: h.agent, status: 'idle' });
  // 写盘被卡在 gate 上：此刻空闲边沿绝不能跑到复盘去（否则复盘会读到旧 hits，按错误顺序选淘汰对象）。
  await new Promise((r) => setTimeout(r, 30));
  release();
  await idle;

  assert.deepEqual(steps, ['flush:start', 'flush:done', 'recap'], '复盘必须排在命中落盘之后：' + JSON.stringify(steps));
  assert.equal(byId(readParsed(file).entries, 'ace-001').meta.hits, 1, '复盘跑之前 hits 已经落盘');
});

test('空闲边沿｜两个空闲边沿重叠不许抢同一份待办（只跑一次复盘）', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const h = makeHarness({
    file,
    runRecap: async () => {
      await gate;
      return null;
    },
  });
  h.controller.countMutating(h.agent);
  h.controller.onTurnStopping({ agent: h.agent, turn: 2 });
  const first = h.controller.onStatus({ agent: h.agent, status: 'idle' });
  const second = h.controller.onStatus({ agent: h.agent, status: 'idle' });
  release();
  await Promise.all([first, second]);

  assert.equal(h.calls.recap.length, 1, '同一份待办只许跑一次复盘：' + h.calls.recap.length);
});

test('退化为没有账本｜不传 takeHitIds / flushHits 时什么都不做，也绝不抛', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份' })]);
  const before = fs.readFileSync(file, 'utf8');
  const h = makeHarness({ file, takeHitIds: undefined, flushHits: undefined });
  // makeHarness 里 takeHitIds 默认接到真账本、flushHits 默认接真写盘；这里把默认实现摘掉。
  const bare = createRecapController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0 }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    runRecap: async () => null,
  });
  assert.doesNotThrow(() => bare.onTurnStopping({ agent: h.agent, turn: 2 }));
  await bare.onStatus({ agent: h.agent, status: 'idle' });
  assert.equal(fs.readFileSync(file, 'utf8'), before, '没有账本/没有写盘实现时不许动文件');
});

test('i｜毫秒时间戳：写入 → 读回 → 排序正确，同毫秒按 id 兜底，旧日期格式照常解析', async () => {
  // 淘汰顺序第二判据是 created（早的先走）。日期精度一天以内分不开「谁先被写进来」，
  // 所以 created/updated/lastHit 三字段一起升到毫秒、本地时区 ISO（字典序即时间序）。
  const file = await writePlaybook([
    entry({ id: 'ace-001', title: 'A', hits: 1, created: '2026-10-25T06:12:33.412+08:00' }),
    entry({ id: 'ace-002', title: 'B', hits: 1, created: '2026-10-25T06:12:33.100+08:00' }),
    entry({ id: 'ace-003', title: 'C', hits: 1, created: '2026-10-25T06:12:33.412+08:00' }), // 与 ace-001 同毫秒
    entry({ id: 'ace-004', title: 'D', hits: 0, created: '2026-10-25T09:00:00.000+08:00' }),
    entry({ id: 'ace-005', title: 'E', hits: 2, created: '2026-10-25T06:12:33.412+08:00' }),
    entry({ id: 'ace-006', title: 'F', hits: 1, created: '2026-10-25' }), // 旧格式：只有日期
  ]);

  // ① 写进去的就是毫秒戳，读回来一个字不丢（序列化不许把精度截断成日期）。
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^- 元数据：created=2026-10-25T06:12:33\.412\+08:00 updated=\S+ hits=1 lastHit=$/m, '毫秒戳必须原样落盘');
  const parsed = readParsed(file);
  assert.equal(byId(parsed.entries, 'ace-001').meta.created, '2026-10-25T06:12:33.412+08:00', '读回的 created 必须保留毫秒');
  assert.equal(byId(parsed.entries, 'ace-006').meta.created, '2026-10-25', '旧格式（只有日期）照常解析，不许报错也不许补成 00:00:00');

  // ② 排序（真跑生产比较器）：hits 少的先走 → 同 hits created 早的先走 → 同毫秒 id 数字升序。
  const order = parsed.entries.slice().sort(compareForEviction).map((e) => e.id);
  assert.deepEqual(
    order,
    ['ace-004', 'ace-006', 'ace-002', 'ace-001', 'ace-003', 'ace-005'],
    '秒内的毫秒差必须真的分出先后，同毫秒才落到 id：' + JSON.stringify(order),
  );
  // 同一毫秒并列时，id 数字升序决定先后（不是按文件里的出现顺序、更不是随机）。
  assert.equal(order.indexOf('ace-001') < order.indexOf('ace-003'), true, '同毫秒同 hits：id 小的先走');
});

test('守护③｜毫秒时间戳跨进程仍能正确排序（两次完全独立的子进程各算一遍，结论必须一致）', async () => {
  // 跨进程口径：排序不许依赖任何进程内的状态（缓存、时间、locale、进程启动时刻）。
  // 两个子进程各自加载 lib/evict.js + lib/playbook.js，各自读盘、各自算一遍，结果必须逐字相同。
  const file = await writePlaybook([
    entry({ id: 'ace-001', title: 'A', hits: 1, created: '2026-10-25T06:12:33.412+08:00' }),
    entry({ id: 'ace-002', title: 'B', hits: 1, created: '2026-10-25T06:12:33.100+08:00' }),
    entry({ id: 'ace-003', title: 'C', hits: 1, created: '2026-10-25T06:12:33.412+08:00' }),
    entry({ id: 'ace-004', title: 'D', hits: 0, created: '2026-10-25T09:00:00.000+08:00' }),
    entry({ id: 'ace-005', title: 'E', hits: 2, created: '2026-10-25T06:12:33.412+08:00' }),
    entry({ id: 'ace-006', title: 'F', hits: 1, created: '2026-10-25' }),
  ]);
  const orderA = await runOrderWorker(file, 'i-a');
  const orderB = await runOrderWorker(file, 'i-b');
  const expected = ['ace-004', 'ace-006', 'ace-002', 'ace-001', 'ace-003', 'ace-005'];
  assert.deepEqual(orderA, expected, '第一个进程算出的淘汰顺序：' + JSON.stringify(orderA));
  assert.deepEqual(orderB, expected, '第二个进程算出的淘汰顺序：' + JSON.stringify(orderB));
  assert.deepEqual(orderA, orderB, '两次独立进程的结论必须逐字相同');
});

test('命中记账｜元数据行里没有 helpful / harmful（正负评分已整层删除）', async () => {
  const file = await writePlaybook([entry({ id: 'ace-001', title: '数据库迁移前先备份', hits: 2 })]);
  const h = makeHarness({ file });
  h.ledger.note(h.agent, ['ace-001']);
  await endTurn(h, 2);

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(/helpful|harmful/.test(text), false, '手册里不许再出现 helpful/harmful：' + text);
  assert.match(text, /^- 元数据：created=\S+ updated=\S+ hits=3 lastHit=\S+$/m, '字段顺序定死 created → updated → hits → lastHit');
  const meta = byId(readParsed(file).entries, 'ace-001').meta;
  assert.deepEqual(Object.keys(meta).sort(), ['created', 'hits', 'lastHit', 'updated'], 'meta 只有这四个字段：' + JSON.stringify(meta));
});
