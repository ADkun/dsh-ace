// 新条目保护期（第 36 轮）的纯逻辑用例：真跑 lib/evict.js 的 planEvictions，不做源码正则。
//
// 钉死的判据：
//   a. 保护期内的条目**不被先淘汰**（未受保护的够 need 时，一条都不动）；
//   b. 未受保护的不够 need 时，用受保护的按既有全序补齐 —— 绝不死锁、绝不整批拒绝；
//   c. protectDays <= 0 / 非有限数 = 不保护，结果与第 35 轮**逐字相同**。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planEvictions, compareForEviction } from '../lib/evict.js';

const DATE = '2026-10-24T09:00:00.000+08:00';

function entry(id, created, hits = 0) {
  return {
    id,
    title: '经验 ' + id,
    condition: '条件',
    action: '做法',
    rationale: '',
    meta: { created, updated: created, hits, lastHit: '' },
  };
}

const idsOf = (moves) => moves.map((m) => m.id);
/** 既有全序（hits 升序 → created 早先 → id 升序）的前 n 个 id。 */
const orderedTop = (entries, n) => entries.slice().sort(compareForEviction).slice(0, n).map((e) => e.id);

/** 五条混合条目：三条老（未受保护）、两条新（14 天内）。 */
function mixed() {
  return [
    entry('ace-001', '2026-10-01', 0), // 23 天前 → 未受保护
    entry('ace-002', '2026-10-20', 0), // 4 天前 → 受保护
    entry('ace-003', '2026-10-22', 0), // 2 天前 → 受保护
    entry('ace-004', '2026-10-02', 5), // 22 天前，但 hits 最高 → 全序里最后
    entry('ace-005', '', 0), // created 缺失 → 不算受保护
  ];
}

test('保护期①：未受保护的够 need → 只从它们里挑，保护期内的条目一条都不动', () => {
  const moves = planEvictions(mixed(), 2, { date: DATE, protectDays: 14 });
  assert.deepEqual(idsOf(moves), ['ace-005', 'ace-001'], '两条都是未受保护里全序最靠前的');
  assert.equal(idsOf(moves).includes('ace-002'), false, '4 天大的受保护条目不许被先淘汰');
  assert.equal(idsOf(moves).includes('ace-003'), false, '2 天大的受保护条目不许被先淘汰');
  assert.equal(moves.every((m) => m.reason === 'evicted' && m.date === DATE), true, '归档指令形状不变');
});

test('保护期②：未受保护的不够 need → 用受保护的按同一全序补齐（不死锁、不整批拒绝）', () => {
  const moves = planEvictions(mixed(), 4, { date: DATE, protectDays: 14 });
  assert.equal(moves.length, 4, 'need=4 必须真给 4 条（绝不因为保护期交白卷）');
  // 未受保护的按全序：ace-005（created 空视为最小）→ ace-001 → ace-004；还不够 1 条 → 受保护里全序最前的 ace-002。
  assert.deepEqual(idsOf(moves), ['ace-005', 'ace-001', 'ace-004', 'ace-002'], '受保护的只在不够时才按全序顶上');
  assert.equal(new Set(idsOf(moves)).size, 4, '不许重复淘汰同一条');
});

test('保护期②：全都在保护期也必须凑够 need —— 宁可淘汰新条目，也不许死锁或整批拒绝', () => {
  const allFresh = [
    entry('ace-101', '2026-10-22', 0),
    entry('ace-102', '2026-10-23', 0),
    entry('ace-103', '2026-10-24', 0),
  ];
  const moves = planEvictions(allFresh, 2, { date: DATE, protectDays: 14 });
  assert.equal(moves.length, 2, '全在保护期时仍必须腾出 2 位');
  assert.deepEqual(idsOf(moves), ['ace-101', 'ace-102'], '兜底淘汰按既有全序（created 早的先走）');
});

test('保护期②：need 超过总条数时只返回全部条目（不越界、不重复）', () => {
  const list = mixed();
  const moves = planEvictions(list, 99, { date: DATE, protectDays: 14 });
  assert.equal(moves.length, list.length);
  assert.equal(new Set(idsOf(moves)).size, list.length);
  // 受保护与否只改「先淘汰谁」的优先级：未受保护的按全序在前，受保护的按同一全序接在后面。
  assert.deepEqual(idsOf(moves), [...orderedTop([list[0], list[3], list[4]], 3), ...orderedTop([list[1], list[2]], 2)], '先未受保护（全序）后受保护（全序）');
});

test('保护期③：protectDays <= 0 / 非有限数 / 缺省 = 不保护，与第 35 轮逐字相同', () => {
  const list = mixed();
  const legacy = planEvictions(list, 3, { date: DATE });
  assert.deepEqual(idsOf(legacy), orderedTop(list, 3), '缺省 protectDays 就是纯全序取前 3');
  for (const protectDays of [0, -1, -365, NaN, Infinity, -Infinity, undefined, null, '']) {
    const got = planEvictions(list, 3, { date: DATE, protectDays });
    assert.deepEqual(idsOf(got), idsOf(legacy), 'protectDays=' + String(protectDays) + ' 必须等价于不保护');
  }
  // 三条老条目、两条新条目：不保护时 ace-002（4 天大、hits 0、created 更早）会被淘汰。
  assert.equal(idsOf(legacy).includes('ace-002'), true, '不保护时新条目照常进全序');
});

test('保护期③：protectDays 的边界 —— 恰好 N 天前算「不在保护期」（严格小于才保护）', () => {
  // hits 故意反着来：老的那条 hits 高（全序里排在后面），新的那条 hits 0（全序里在最前）。
  // 这样「保护期把哪条挡在门外」才看得出来，否则两条都在全序最前，边界被顺序兜住了。
  const edge = [
    entry('ace-201', '2026-10-10', 5), // 正好 14 天前、hits 高
    entry('ace-202', '2026-10-11', 0), // 13 天前、hits 0（全序里最靠前）
  ];
  assert.deepEqual(idsOf(planEvictions(edge, 1, { date: DATE })), ['ace-202'], '不保护时按全序：hits 0 的先走');

  // protectDays=14：14 天大的 ace-201 在保护期之外（14 < 14 为假）→ 它先走，13 天大的受保护不动。
  assert.deepEqual(idsOf(planEvictions(edge, 1, { date: DATE, protectDays: 14 })), ['ace-201'], '正好 14 天大的条目不在保护期里，先走它');
  // protectDays=15：两条都在保护期里 → 兜底淘汰按同一全序 → hits 0 的 ace-202 顶上。
  assert.deepEqual(idsOf(planEvictions(edge, 1, { date: DATE, protectDays: 15 })), ['ace-202'], '保护期 15 天时两条都受保护，兜底淘汰回到全序');
});

test('保护期③：created 缺失或解析不出来的条目不算受保护（老条目照常先走）', () => {
  const list = [
    entry('ace-301', '', 0),
    entry('ace-302', '不知道什么日期', 0),
    entry('ace-303', '2026-10-24', 0),
  ];
  const moves = planEvictions(list, 2, { date: DATE, protectDays: 14 });
  assert.deepEqual(idsOf(moves), ['ace-301', 'ace-302'], '空 created 视为最小，本来就在全序最前');
});

test('保护期③：protectDays 接受字符串 / 小数（向下取整），非法输入一律退回不保护', () => {
  const list = [entry('ace-401', '2026-10-20', 0), entry('ace-402', '2026-10-24', 0)];
  // '14' 等价于 14：ace-401 是 4 天前 → 受保护 → 只能兜底淘汰它。
  assert.deepEqual(idsOf(planEvictions(list, 1, { date: DATE, protectDays: '14' })), ['ace-401']);
  // 3.9 → 3：4 天大的 ace-401 不再受保护，且它 created 更早 → 仍然是它先走（用第二条证明取整生效）。
  const fractional = planEvictions([entry('ace-401', '2026-10-21', 0), entry('ace-402', '2026-10-24', 0)], 1, { date: DATE, protectDays: 3.9 });
  assert.deepEqual(idsOf(fractional), ['ace-401'], '4 天前（> 3.9→3）不受保护，直接走');
  assert.deepEqual(idsOf(planEvictions(list, 1, { date: DATE, protectDays: '不是数字' })), ['ace-401'], '非法字符串 = 不保护（纯全序）');
});

test('保护期③：计划是纯函数且可复现 —— 同一输入两次调用逐字相同，输入数组不被就地改动', () => {
  const list = mixed();
  const before = list.map((e) => e.id);
  const first = planEvictions(list, 3, { date: DATE, protectDays: 14 });
  const second = planEvictions(list, 3, { date: DATE, protectDays: 14 });
  assert.deepEqual(first, second, '同一输入必须给出同一计划（断点续跑不许抖动）');
  assert.deepEqual(list.map((e) => e.id), before, 'planEvictions 不许就地排序调用方的数组');
  assert.equal(planEvictions(list, 0, { date: DATE, protectDays: 14 }).length, 0, 'need<=0 返回空数组');
  assert.equal(planEvictions([], 3, { date: DATE, protectDays: 14 }).length, 0, '空手册返回空数组');
});

test('保护期②：受保护条目被兜底淘汰时，仍不许把「未受保护里更靠前的」挤掉', () => {
  // 两条未受保护（ace-501 早、ace-502 晚）+ 两条受保护：need=3 时前两位必须是未受保护的两条。
  const list = [
    entry('ace-501', '2026-01-01', 1),
    entry('ace-502', '2026-02-01', 1),
    entry('ace-503', '2026-10-23', 0),
    entry('ace-504', '2026-10-24', 0),
  ];
  const moves = planEvictions(list, 3, { date: DATE, protectDays: 14 });
  assert.equal(moves.length, 3);
  const unprotected = idsOf(moves).filter((id) => id === 'ace-501' || id === 'ace-502');
  assert.deepEqual(unprotected, ['ace-501', 'ace-502'], '未受保护的两条必须都在，且内部仍按全序');
  assert.equal(idsOf(moves).slice(0, 2).join(','), 'ace-501,ace-502', '未受保护的排在前面');
  assert.equal(idsOf(moves)[2], 'ace-503', '缺口由受保护里全序最靠前的补上');
});
