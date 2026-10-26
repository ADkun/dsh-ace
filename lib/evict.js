// 最少使用淘汰（第 33 轮）：手册活跃条数超过 maxEntries 时，腾位只剩这一条路径。
//
// 为什么是「使用频次」而不是「成败评分」：回合成败由外部因素主导（模型抽风、环境缺依赖、
// 用户中途改需求），把结果归因到「这条经验帮没帮上忙」不可靠，只会把噪声写进手册。
// hits 只回答一个事实问题：这条经验**被真正用出去过几次**（注入进历史 / 定向检索命中）。
// 它不判断好坏，只判断「有没有人在用」—— 用得最少的先走，语义诚实且不会自增强
// （注入不再看 hits，排序是 0.9 相关度 + 0.1 话题热度，见 lib/inject.js 与 lib/heat.js）。
//
// 淘汰顺序定死（用户拍板，不许改成随机）：
//   ① hits 少的先走；
//   ② 同 hits → created 更早的先走（毫秒时间戳，字典序即时间序）；
//   ③ 再并列 → id 数字升序。
// 任何一步失败都不许整批拒绝：这里全是纯函数，抛错由调用方降级（跳过淘汰而不是丢掉候选）。
//
// 第 36 轮加「新条目保护期」（protectDays，设置项 evictProtectDays）：created 距今不足 N 天的条目
// **优先不淘汰**，让刚写进手册的经验有机会被用上一次 —— 否则「刚记下就被扔掉」等于白花一次 LLM。
// 保护期只改**淘汰顺序**，不改容量硬约束：未受保护的条目不够 need 时，照旧用受保护的条目
// 按同一套全序补齐（兜底淘汰）。宁可淘汰一条新条目，也不许死锁或整批拒绝写入 ——
// 零保护期（protectDays <= 0 或非有限数）精确等价于旧行为。

import { idNumber } from './playbook.js';
import { compareStamps } from './timestamp.js';
import { nowStamp } from './timestamp.js';

/**
 * 淘汰排序比较器（纯函数，稳定且全序）：
 * hits 升序 → created 升序 → id 数字升序。
 *
 * created 用 compareStamps：空串视为「最小」（从没写过 created 的老条目先走），
 * 旧格式（只有日期）与新格式（毫秒 ISO）能直接比 —— 字典序天然成立。
 */
export function compareForEviction(a, b) {
  const ha = Number(a?.meta?.hits) || 0;
  const hb = Number(b?.meta?.hits) || 0;
  if (ha !== hb) return ha - hb;
  const c = compareStamps(a?.meta?.created, b?.meta?.created);
  if (c !== 0) return c;
  return idNumber(a?.id) - idNumber(b?.id);
}

/** 把时间戳里的年月日折成「天数序号」（UTC 零点起算的天数）；解析不出来返回 null。 */
function dayNumberOf(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(stamp ?? ''));
  if (!m) return null;
  const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00.000Z');
  return Number.isFinite(t) ? Math.floor(t / 86400000) : null;
}

/** 保护期天数收敛：非有限数或 <= 0 一律当 0（= 不保护，等价于第 35 轮及以前的行为）。 */
function protectDaysOf(protectDays) {
  const days = Math.floor(Number(protectDays));
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * created 距 date 是否**不足** protectDays 天（= 还在保护期里）。
 * created 缺失 / 解析不出来 → 不算受保护：老条目本来就在全序最前面，得让它照常走。
 */
function isWithinProtection(entry, stamp, days) {
  const created = dayNumberOf(entry?.meta?.created);
  const today = dayNumberOf(stamp);
  if (created === null || today === null) return false;
  return today - created < days;
}

/**
 * 按最少使用顺序挑出 need 条要淘汰的条目（纯函数）。
 *
 * 挑法（第 36 轮起）：先把**未受保护**的按全序排在前面取 need 条；不够时再用受保护的条目
 * 按同一个全序补足。受保护的条目要么先不动，要么被兜底淘汰 —— 绝不整批拒绝、绝不死锁。
 *
 * @param {Array<object>} entries - 活跃条目
 * @param {number} need - 需要腾出的条数（<=0 返回空数组）
 * @param {{date?: string, protectDays?: number}} [options] - date 可注入（测试要可复现），
 *   默认毫秒时间戳；protectDays 是新条目保护期的天数（<=0 / 非有限数 = 不保护）
 * @returns {Array<{id: string, reason: 'evicted', date: string}>} 归档搬移指令
 */
export function planEvictions(entries, need, { date, protectDays } = {}) {
  const want = Math.floor(Number(need) || 0);
  if (!(want > 0)) return [];
  const list = (entries || []).filter((e) => e && e.id);
  if (!list.length) return [];
  const stamp = typeof date === 'string' && date ? date : nowStamp();
  const sorted = list.slice().sort(compareForEviction);
  const days = protectDaysOf(protectDays);
  let picked = sorted;
  if (days > 0) {
    const fresh = [];
    const stale = [];
    for (const e of sorted) {
      if (isWithinProtection(e, stamp, days)) fresh.push(e);
      else stale.push(e);
    }
    picked = stale.slice(0, want);
    // 未受保护的够 need → 只从它们里挑（新条目一条都不动）；
    // 不够 → 用受保护的按同一全序补齐，绝不让「全都在保护期」变成写不进去。
    if (picked.length < want) picked = picked.concat(fresh.slice(0, want - picked.length));
  }
  return picked.slice(0, Math.min(want, picked.length)).map((e) => ({ id: e.id, reason: 'evicted', date: stamp }));
}
