// dsh-ace 单元测试：C5.6 注入 → 命中账本 → 回合边界落盘 这条接缝。
// lib/index.js 无法在测试里 import（顶层依赖宿主包），所以这里用 lib 里的纯逻辑模块
// 把整条事件流原样走一遍：预检索 → publish → 投递（take + note）→ 账本 → commitMeta+markHits。
//
// 第 33 轮：正负评分（helpful/harmful）整层删除，账本的唯一语义是 **hits 的来源**。
// 因此本文件不再有「成功回合 / 失败回合」两条分支 —— 回合成败不再参与任何记账。
//
// 第 28 轮改造（前缀缓存）：注入不再改写系统提示，而是由 lib/inject-delivery.js 在 agent/pre-step
// 追加一条 user 消息。因此本文件里的「投递」= flow.take(agent)（认领这批注入，同一批只认领一次）
// + flow.note(agent, ids)（只有真造出消息、真追加进历史之后才记账）。
// take 与 note 拆开的理由：造消息抛错时不能留下「账本里有、历史里没有」的幽灵注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createInjectionCache, selectInjection } from '../lib/inject.js';
import { createUsageLedger } from '../lib/ledger.js';
import { createInjectionFlow } from '../lib/injection-flow.js';
import { commitMeta } from '../lib/commit.js';
import { markHits, readPlaybookSnapshot } from '../lib/playbook.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-flow-'));
}

function entry(id, title, condition, action, meta = {}) {
  return {
    id,
    title,
    condition,
    action,
    rationale: '',
    meta: { created: '2026-10-01', updated: '2026-10-01', hits: 0, lastHit: '', ...meta },
    extraLines: [],
  };
}

function writePlaybook(dir, entries) {
  const file = path.join(dir, 'playbook.md');
  const lines = ['# ACE 操作手册', ''];
  for (const e of entries) {
    lines.push('### [' + e.id + '] ' + e.title);
    lines.push('- 条件：' + e.condition);
    lines.push('- 做法：' + e.action);
    lines.push('- 元数据：created=' + e.meta.created + ' updated=' + e.meta.updated + ' hits=' + e.meta.hits + ' lastHit=' + e.meta.lastHit);
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// 复刻 lib/index.js 的命中计数落盘（flushHits → recordHits）：commitMeta + markHits。
// 回合成败（outcome）不再参与：账本里只有「谁被真的用上了」，落盘只有 hits+1。
async function settle(file, snapshot, agent, ledger) {
  const usedIds = ledger.take(agent);
  if (!usedIds.length) return { usedIds, changed: [] };
  const marked = await commitMeta(file, snapshot, {
    ids: usedIds,
    apply: (latest, safeIds) => {
      const res = markHits(latest, safeIds);
      return { entries: res.entries, changed: res.hit };
    },
  });
  return { usedIds, changed: marked.changed };
}

// 复刻 lib/inject-delivery.js 的投递动作：先 take（认领），真投递成功后再 note（记账）。
function deliver(flow, agent) {
  const picked = flow.take(agent);
  if (!picked) return null;
  flow.note(agent, picked.ids);
  return picked;
}

const ENTRIES = [
  entry('ace-001', '改代码前先跑基线测试', '接手已有仓库要先确认基线', '跑一遍测试命令并记下 pass/fail/skip 三个数'),
  entry('ace-002', '改动后重跑全量测试', '任何代码改动之后', '重跑全量测试并与基线对比数字'),
];

test('a｜注入投递后条目 id 进账本，回合边界落盘一次 → hits +1、lastHit 刷新', async () => {
  const dir = tmpDir();
  const file = writePlaybook(dir, ENTRIES);
  const snapshot = await readPlaybookSnapshot(file);

  const ledger = createUsageLedger();
  const cache = createInjectionCache();
  const flow = createInjectionFlow({ cache, ledger });
  const agent = { name: 'fake-agent' };

  // ① 预检索（对应 index.js 里 agent/inbox/inserted 的异步回调）
  const picked = selectInjection(snapshot.entries, '先跑一遍基线测试');
  assert.ok(picked.count > 0, '检索命中至少一条');
  flow.publish(agent, 'id:msg-1', picked);

  // ② 投递（对应 agent/pre-step 里 inject-delivery 的 take + note）
  const delivered = deliver(flow, agent);
  assert.ok(delivered, '有待投递批次');
  assert.deepEqual(delivered.ids, picked.ids, '投递出来的就是这批 id');
  assert.deepEqual(ledger.peek(agent), picked.ids, '投递成功后 id 已进账本');

  // ③ 回合边界落盘（对应 flushHits → recordHits）
  const { changed } = await settle(file, snapshot, agent, ledger);
  assert.deepEqual(changed.sort(), picked.ids.slice().sort(), '每个注入条目都被记一次命中');

  const after = await readPlaybookSnapshot(file);
  for (const id of picked.ids) {
    const e = after.entries.find((x) => x.id === id);
    assert.equal(e.meta.hits, 1, id + ' 的 hits +1');
    assert.match(e.meta.lastHit, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'lastHit 是毫秒时间戳');
    assert.equal('helpful' in e.meta, false, 'meta 里不许再有 helpful');
    assert.equal('harmful' in e.meta, false, 'meta 里不许再有 harmful');
  }
  // 没被注入的条目不被动
  const untouched = after.entries.find((x) => !picked.ids.includes(x.id));
  if (untouched) assert.equal(untouched.meta.hits, 0);
});

test('a｜同一批注入重复装配（连跑三次 pre-step）不重复计数', async () => {
  const dir = tmpDir();
  const file = writePlaybook(dir, ENTRIES);
  const snapshot = await readPlaybookSnapshot(file);

  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const agent = {};

  const picked = selectInjection(snapshot.entries, '先跑一遍基线测试');
  flow.publish(agent, 'id:msg-3', picked);

  // 宿主的每个 step 都会派发 agent/pre-step：同一批注入只许追加进历史一次
  const first = flow.take(agent);
  assert.deepEqual(first.ids, picked.ids, '第一步拿到这批注入');
  flow.note(agent, first.ids);
  assert.equal(flow.take(agent), null, '第二步拿不到（同一批已认领，不得重复追加）');
  assert.equal(flow.take(agent), null, '第三步同样拿不到');
  assert.deepEqual(ledger.peek(agent), picked.ids, '账本里没有重复 id');

  const { usedIds } = await settle(file, snapshot, agent, ledger);
  assert.equal(usedIds.length, picked.ids.length);
  const after = await readPlaybookSnapshot(file);
  for (const id of picked.ids) {
    const e = after.entries.find((x) => x.id === id);
    assert.equal(e.meta.hits, 1, '只 +1，不因多次投递尝试而累加');
  }
});

test('C5.6｜不同 agent 分账：A 的注入不会给 B 记命中', async () => {
  const dir = tmpDir();
  const file = writePlaybook(dir, ENTRIES);
  const snapshot = await readPlaybookSnapshot(file);

  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const a = {};
  const b = {};

  const picked = selectInjection(snapshot.entries, '先跑一遍基线测试');
  flow.publish(a, 'id:msg-a', picked);
  deliver(flow, a);

  const { usedIds } = await settle(file, snapshot, b, ledger);
  assert.deepEqual(usedIds, [], 'B 名下没有命中');
  const after = await readPlaybookSnapshot(file);
  for (const e of after.entries) assert.equal(e.meta.hits, 0, e.id + ' 未被计数');
});

test('C5.6｜没有注入时不记任何 id（检索无结果 / 未预检索）', () => {
  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const agent = {};

  // 未 publish 就投递
  assert.equal(flow.take(agent), null);
  assert.deepEqual(ledger.peek(agent), []);

  // publish 了但本轮没有命中条目（text 空、ids 空）
  flow.publish(agent, 'id:msg-4', { text: '', ids: [], tokens: 0, count: 0 });
  assert.equal(flow.take(agent), null);
  assert.deepEqual(ledger.peek(agent), []);
});

test('C5.6｜新消息到达后无需任何清理调用即可重新投递（跨回合不串账靠消息 key，不靠 reset）', () => {
  // P2-3：改前这条用例调 flow.reset(agent) 来模拟「新回合」，而 reset 在生产代码里 0 次调用
  // （grep lib/ 只有定义本身）—— 等于用一条只有测试会走的路径证明生产行为。现在 reset 已删除，
  // 用例改成走真实路径：换一条消息 = 换一个 key，take 内部的 delivered key 比较自然放行。
  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const agent = {};

  flow.publish(agent, 'id:msg-5', { text: '块 A', ids: ['ace-001'], tokens: 5, count: 1 });
  const first = flow.take(agent);
  assert.deepEqual(first.ids, ['ace-001']);
  flow.note(agent, first.ids);
  assert.equal(flow.take(agent), null, '同一条消息第二次投递拿不到批次');
  assert.equal(flow.take(agent), null, '第三次也一样（没有外部清理调用，靠 key 判重）');

  // 新用户消息到来：宿主会 publish 一条新 key 的结果，生产代码里没有任何 reset 调用。
  flow.publish(agent, 'id:msg-6', { text: '块 B', ids: ['ace-002'], tokens: 5, count: 1 });
  const second = flow.take(agent);
  assert.deepEqual(second.ids, ['ace-002'], '新 key → 重新投递');
  flow.note(agent, second.ids);
  assert.deepEqual(ledger.peek(agent), ['ace-001', 'ace-002']);
});

test('D4｜子代理的注入照常渲染，但绝不进命中账本（它没有结算路径，记了只会无限堆积）', () => {
  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const main = { id: 'main', session: { header: { origin: 'startup' } } };
  const sub = { id: 'sub', session: { header: { origin: 'subagent' } } };

  const picked = { text: '【ACE 自动注入】…', ids: ['ace-001', 'ace-002'], tokens: 9, count: 2 };
  flow.publish(sub, 'id:msg-sub', picked);
  const got = flow.take(sub);
  assert.deepEqual(got.ids, ['ace-001', 'ace-002'], '注入块照常交给投递方渲染');
  flow.note(sub, got.ids);
  assert.deepEqual(ledger.peek(sub), [], '子代理账本必须一直是空的（probe-d5：改前 6 回合后长度 6）');

  // 主代理同一条路径照常记账
  flow.publish(main, 'id:msg-main', picked);
  const mainGot = flow.take(main);
  flow.note(main, mainGot.ids);
  assert.deepEqual(ledger.peek(main), ['ace-001', 'ace-002'], '主代理照常记账（结算路径只在它那里）');
  assert.deepEqual(ledger.peek(sub), [], '主代理记账不会串到子代理名下');
});

test('第28轮｜take 之后没 note（造消息/追加抛错）→ 账本不留幽灵注入', async () => {
  const dir = tmpDir();
  const file = writePlaybook(dir, ENTRIES);
  const snapshot = await readPlaybookSnapshot(file);

  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache: createInjectionCache(), ledger });
  const agent = {};

  const picked = selectInjection(snapshot.entries, '先跑一遍基线测试');
  flow.publish(agent, 'id:msg-8', picked);

  // 认领了，但投递失败（inject-delivery 只在造出消息之后才 note）
  const claimed = flow.take(agent);
  assert.ok(claimed);
  assert.deepEqual(ledger.peek(agent), [], 'take 本身不记账');

  // 结算拿不到任何 id：没进历史的注入不许计分
  const { usedIds } = await settle(file, snapshot, agent, ledger);
  assert.deepEqual(usedIds, []);
  const after = await readPlaybookSnapshot(file);
  for (const e of after.entries) assert.equal(e.meta.hits, 0, e.id + ' 未被计数');
});

test('C5.6｜peek 只读：不改账本、不改缓存', () => {
  const ledger = createUsageLedger();
  const cache = createInjectionCache();
  const flow = createInjectionFlow({ cache, ledger });
  const agent = {};
  flow.publish(agent, 'id:msg-7', { text: '块', ids: ['ace-001'], tokens: 1, count: 1 });
  assert.deepEqual(flow.peek(agent), ['ace-001']);
  assert.deepEqual(ledger.peek(agent), [], 'peek 不记账');
  const ids = flow.peek(agent);
  ids.push('ace-999');
  assert.deepEqual(flow.peek(agent), ['ace-001']);
});
