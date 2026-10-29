// 话题热度（第 36 轮）纯逻辑用例：真跑 lib/heat.js 与 lib/inject.js 的排序函数，不做源码正则。
//
// 钉死的三条红线：
//   ① 热度只由「用户说过的话」产生 —— 把注入结果/热度图喂回 computeHeat，计数与顺序一字不变；
//   ② 热度不许制造相关度 —— 0 相关度的条目热度爆表也不进候选；
//   ③ 窗口是按 agent 隔离的 30 条环形窗口，第 31 条进来把第 1 条挤出去。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEAT_WINDOW_MESSAGES,
  HEAT_TOP_PER_MESSAGE,
  HEAT_WEIGHT,
  RELEVANCE_WEIGHT,
  createHeatWindow,
  computeHeat,
  heatMemoSize,
  clearHeatRankMemo,
} from '../lib/heat.js';
import { rankInjection, selectInjection, INJECT_MAX_ENTRIES } from '../lib/inject.js';

/** 造一条条目（形状与 lib/playbook.js 的 parsePlaybook 一致；本文件只关心正文与 id）。 */
function entry(id, spec = {}) {
  return {
    id,
    title: spec.title ?? '数据库迁移前先备份',
    condition: spec.condition ?? '要改数据库结构时',
    action: spec.action ?? '先导出快照再迁移',
    rationale: spec.rationale ?? '',
    meta: { created: '2026-01-01', updated: '2026-01-01', hits: 0, lastHit: '' },
  };
}

const ids = (listed) => listed.map((item) => item.entry.id);

// 绝对门槛（4.0 × IDF_MAX）另有一组专门用例（tests/inject.test.mjs 的 C5.8）。
// 本文件钉的是「热度只改顺序、不许制造相关度」，为免低 N 夹具被门槛挡空，
// 统一把绝对门槛关掉（0 = 关）——断言语义一个字都不变。
const GATE_OFF = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };

test('热度①：常量按用户拍板的取值导出（窗口 30 条 / 每条最多 3 条 / 权重 0.9 相关度 + 0.1 热度）', () => {
  assert.equal(HEAT_WINDOW_MESSAGES, 30);
  assert.equal(HEAT_TOP_PER_MESSAGE, 3);
  assert.equal(HEAT_WEIGHT, 0.1);
  assert.equal(RELEVANCE_WEIGHT, 0.9);
});

test('热度①：窗口上限 30 —— 第 31 条消息进来，第 1 条被挤出去', () => {
  const win = createHeatWindow();
  const agent = {};
  for (let n = 1; n <= HEAT_WINDOW_MESSAGES; n += 1) win.note(agent, '消息' + n);
  assert.equal(win.messagesOf(agent).length, 30, '满窗口时正好 30 条');
  assert.equal(win.messagesOf(agent)[0], '消息1', '还没溢出时最老的是第 1 条');

  win.note(agent, '消息31');
  const after = win.messagesOf(agent);
  assert.equal(after.length, 30, '第 31 条进来后仍然是 30 条（不是 31 条）');
  assert.equal(after[0], '消息2', '第 31 条进来后，第 1 条必须被挤出去');
  assert.equal(after[after.length - 1], '消息31', '最新一条永远在末尾');
  assert.equal(after.includes('消息1'), false, '被挤出的消息不许还在窗口里');
});

test('热度①：窗口按 agent 隔离 —— 两个 agent 的话题绝不互相串味', () => {
  const win = createHeatWindow();
  const a = {};
  const b = {};
  win.note(a, 'A 的话题');
  win.note(b, 'B 的话题');
  win.note(a, 'A 的第二个话题');
  assert.deepEqual(win.messagesOf(a), ['A 的话题', 'A 的第二个话题']);
  assert.deepEqual(win.messagesOf(b), ['B 的话题'], 'B 的窗口里不许出现 A 的消息');

  win.clear(a);
  assert.deepEqual(win.messagesOf(a), [], 'clear 只清自己那个 agent');
  assert.deepEqual(win.messagesOf(b), ['B 的话题'], 'clear(a) 不许影响 b');
});

test('热度①：窗口只收「有正文的用户消息」—— 空白/空串不进窗，返回的是快照副本', () => {
  const win = createHeatWindow();
  const agent = {};
  assert.deepEqual(win.note(agent, '   '), [], '空白消息不该占窗口');
  assert.deepEqual(win.note(agent, undefined), [], 'undefined 不该占窗口');
  assert.deepEqual(win.messagesOf(agent), []);
  win.note(agent, '  有效话题  ');
  assert.deepEqual(win.messagesOf(agent), ['有效话题'], '入窗时 trim');

  const snapshot = win.messagesOf(agent);
  snapshot.push('外部塞进来的');
  assert.deepEqual(win.messagesOf(agent), ['有效话题'], 'messagesOf 返回副本，调用方改不动内部窗口');
});

test('热度②：computeHeat 只认用户消息 —— 同一条消息命中的前 3 条各 +1', () => {
  const entries = [entry('ace-001'), entry('ace-002'), entry('ace-003')];
  const counts = computeHeat(entries, ['数据库迁移前先备份'], GATE_OFF);
  assert.equal(counts.get('ace-001'), 1);
  assert.equal(counts.get('ace-002'), 1);
  assert.equal(counts.get('ace-003'), 1);

  const twice = computeHeat(entries, ['数据库迁移前先备份', '数据库迁移前先备份'], GATE_OFF);
  assert.equal(twice.get('ace-001'), 2, '同一话题在窗口里出现两次就记 2 点');
  assert.equal(twice.get('ace-002'), 2);
});

test('热度②：computeHeat 的每条消息最多记 topPerMessage 条（默认 3，可覆盖）', () => {
  const entries = [1, 2, 3, 4, 5].map((n) => entry('ace-00' + n));
  const defaults = computeHeat(entries, ['数据库迁移前先备份'], GATE_OFF);
  assert.equal(defaults.size, HEAT_TOP_PER_MESSAGE, '默认每条消息只给前 3 条加 1 点');
  assert.equal([...defaults.values()].every((v) => v === 1), true, '每条命中只加 1 点，不是加分数');

  const capped = computeHeat(entries, ['数据库迁移前先备份'], { ...GATE_OFF, topPerMessage: 1 });
  assert.equal(capped.size, 1, 'topPerMessage=1 时每条消息只认第 1 名');
});

test('热度②（反自增强）：把热度图喂回 computeHeat 也不改任何计数 —— 注入结果绝不回流', () => {
  const entries = [entry('ace-001'), entry('ace-002'), entry('ace-003')];
  const messages = ['数据库迁移前先备份', '要改数据库结构时怎么做'];
  const baseline = computeHeat(entries, messages, GATE_OFF);
  const baselineList = [...baseline.entries()];

  // 伪造一份「注入已经把 ace-003 捧上天」的热度图，连同注入文本一起喂回去。
  const spilled = new Map([['ace-003', 999]]);
  const again = computeHeat(entries, messages, { ...GATE_OFF, heat: spilled, topPerMessage: 3 });
  assert.deepEqual([...again.entries()], baselineList, '热度和注入结果都不许改变 computeHeat 的计数');
  assert.equal(again.get('ace-003'), baseline.get('ace-003'), '被注入过的条目热度不许自己涨');

  // 排序侧也一样稳：带着同一份 heat 反复排，顺序与综合分一字不变（注入结果不许回流进排序）。
  const once = rankInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat: spilled });
  for (let i = 0; i < 3; i += 1) {
    const again = rankInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat: spilled });
    assert.deepEqual(ids(again.ranked), ids(once.ranked), '同一输入重复排序必须给出同一顺序');
    assert.deepEqual(again.ranked.map((item) => item.composite), once.ranked.map((item) => item.composite), '综合分不许漂移');
  }
  assert.deepEqual(ids(once.ranked)[0], 'ace-003', '热度只影响排序位置，不影响计数口径');
});

test('热度②：computeHeat 空输入安全 —— 没有条目/没有消息 → 空 Map（不是 undefined）', () => {
  assert.equal(computeHeat([], ['数据库迁移']).size, 0);
  assert.equal(computeHeat([entry('ace-001')], []).size, 0);
  assert.equal(computeHeat(null, null).size, 0);
  assert.equal(computeHeat([{ title: '没有 id' }], ['数据库迁移']).size, 0, '没有 id 的条目不入热度');
});

test('热度③：rankInjection 不传 heat 时与旧行为一致（纯 BM25 + 同分按 id 升序）', () => {
  const same = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  const entries = [entry('ace-001', same), entry('ace-002', same), entry('ace-003', same)];
  const { ranked } = rankInjection(entries, '数据库迁移前先备份', GATE_OFF);
  assert.deepEqual(ids(ranked), ['ace-001', 'ace-002', 'ace-003'], '同分时仍按 id 数字升序');
  assert.equal(ranked[0].relevance, 1);
});

test('热度③：heat 能改变排序 —— 同分条目里热度高的排到前面（热度只重排已有字面交集的条目）', () => {
  const same = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  const entries = [entry('ace-001', same), entry('ace-002', same), entry('ace-003', same)];
  const plain = rankInjection(entries, '数据库迁移前先备份', GATE_OFF);
  assert.deepEqual(ids(plain.ranked), ['ace-001', 'ace-002', 'ace-003'], '没有热度时是 id 升序');

  const heated = rankInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat: new Map([['ace-003', 3]]) });
  assert.deepEqual(ids(heated.ranked), ['ace-003', 'ace-001', 'ace-002'], '热度高的先排，其余仍按 id 升序');
  assert.equal(heated.ranked[0].relevance, 1, '相关度不受热度影响（热度只做 0.1 的加分项）');
  assert.equal(heated.ranked[0].heat, 1, '归一化热度：本条是候选里最高的 → 1');
  assert.equal(heated.ranked[1].heat, 0, '没热度的条目归一化到 0');

  // 普通对象与 Map 等价（配置/JSON 往返后不该改变排序）。
  const asObject = rankInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat: { 'ace-003': 3 } });
  assert.deepEqual(ids(asObject.ranked), ids(heated.ranked), '普通对象与 Map 的 heat 必须等价');
});

test('热度③（不许制造相关度）：0 相关度条目热度爆表也绝不进候选', () => {
  const entries = [
    entry('ace-001', { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' }),
    entry('ace-002', { title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版' }),
  ];
  const { ranked } = rankInjection(entries, '数据库迁移前先备份', { heat: new Map([['ace-002', 9999]]) });
  assert.deepEqual(ids(ranked), ['ace-001'], '字面无关的 ace-002 一分都不该得，热度不许把它拉进来');

  const picked = selectInjection(entries, '数据库迁移前先备份', { heat: new Map([['ace-002', 9999]]) });
  assert.deepEqual(picked.ids, ['ace-001'], 'selectInjection 同样不许让热度绕过相关度');
});

test('热度③：候选里最大热度为 0 时全部按 0 算 —— 不许因除零出 NaN、不许排序抖动', () => {
  const same = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  const entries = [entry('ace-001', same), entry('ace-002', same)];
  for (const heat of [new Map(), {}, new Map([['ace-099', 5]]), null, undefined, new Map([['ace-001', 0]])]) {
    const { ranked } = rankInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat });
    assert.deepEqual(ids(ranked), ['ace-001', 'ace-002'], '没有候选热度时保持 id 升序');
    for (const item of ranked) {
      assert.equal(Number.isFinite(item.composite), true, '综合分必须是有限数：' + JSON.stringify(item.composite));
      assert.equal(item.heat, 0, '候选最大热度为 0 时归一化热度一律 0');
    }
  }
});

test('热度③：selectInjection 透传 heat —— 排序真的按热度重排，且重复调用结果一字不变（无自增强漂移）', () => {
  const same = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  const entries = [entry('ace-001', same), entry('ace-002', same)];
  const heat = new Map([['ace-002', 2]]);
  const first = selectInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat, maxEntries: INJECT_MAX_ENTRIES });
  assert.deepEqual(first.ids, ['ace-002', 'ace-001'], '热度高的排前面');
  for (let i = 0; i < 3; i += 1) {
    const again = selectInjection(entries, '数据库迁移前先备份', { ...GATE_OFF, heat, maxEntries: INJECT_MAX_ENTRIES });
    assert.deepEqual(again.ids, first.ids, '同一输入重复调用必须给出同一顺序');
    assert.equal(again.text, first.text, '注入正文也必须逐字相同（注入结果不许回流影响后续排序）');
  }
});

test('热度③（端到端）：computeHeat 的计数直接当 heat 喂给 selectInjection —— 热门话题的条目被提前，但字面无关的条目仍进不来', () => {
  const same = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
  const entries = [
    entry('ace-001', same),
    entry('ace-002', same),
    // 跟查询毫无字面交集（连一个词都不共用）、但正是窗口里最近在聊的话题：热度最高也进不了候选。
    entry('ace-003', { title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版' }),
  ];
  const heat = computeHeat(entries, ['CSS 布局一律用 grid', 'CSS 布局一律用 grid']);
  assert.equal(heat.get('ace-003'), 2, '窗口里的两条消息都命中 ace-003');

  const picked = selectInjection(entries, '数据库迁移前先备份', { heat });
  assert.deepEqual(picked.ids, ['ace-001', 'ace-002'], '候选只能是真有字面交集的条目，热度不许把 ace-003 拉进来');
  // 与直接调 rankInjection 的顺序一致（selectInjection 只是透传 heat，没有第二套排序）。
  assert.deepEqual(picked.ids, ids(rankInjection(entries, '数据库迁移前先备份', { heat }).ranked));
});

test('D2｜computeHeat 记忆化：同一批消息重复计算计数不变、只命中缓存；clear 可清空', () => {
  clearHeatRankMemo();
  const entries = [
    entry('ace-001'),
    entry('ace-002'),
    entry('ace-003', { title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版' }),
  ];
  const messages = ['数据库迁移前先备份', '要改数据库结构时', 'CSS 布局一律用 grid'];
  const first = computeHeat(entries, messages);
  const sizeAfterFirst = heatMemoSize();
  assert.ok(sizeAfterFirst > 0, '应当写入了记忆化缓存');
  const second = computeHeat(entries, messages);
  assert.deepEqual([...second.entries()].sort(), [...first.entries()].sort(), '重复计算计数不变');
  assert.equal(heatMemoSize(), sizeAfterFirst, '同一批消息再次计算只命中缓存、不新增条目');
  clearHeatRankMemo();
  assert.equal(heatMemoSize(), 0, 'clear 后缓存清空');
});
