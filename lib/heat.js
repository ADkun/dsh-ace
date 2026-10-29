// 话题热度（第 36 轮）：注入排序里的「这个 agent 最近老在聊什么」。
//
// 为什么要有热度：纯 BM25 只看**本回合这一条消息**的字面。用户的真实工作往往连续几轮
// 围着同一个话题（「先跑基线」→「基线还是红的」→「把基线修好」），单看一条消息可能
// 谁都不够像，但把最近 30 条用户消息摊开看，话题是清楚的。热度就是把这份「最近的关注点」
// 折算成排序里的一个轻量加分项（权重 0.1，相关度仍是 0.9 的大头）。
//
// 三条硬红线（用户拍板，改代码前先读一遍）：
//   ① **热度只由「用户说过的话」产生**。喂进 note() 的只能是用户消息正文。
//      绝不能把注入出去的条目、工具结果、复盘摘要塞进来 —— 否则「被注入多 → 热度高 →
//      更容易再被注入」就是自增强闭环，等于把噪声写进排序。
//   ② **热度不许制造相关度**。0 相关度的条目即使热度爆表也不进候选：
//      排序里的热度只重排「本来就有字面交集」的那批（见 lib/inject.js 的 filter）。
//   ③ 热度**不落盘、不进条目元数据**。它是进程内的滚动窗口（WeakMap 按 agent 隔离），
//      重启即清空；手册里的五个字段（created/updated/hits/lastHit/auto）一个都不加。
//
// 依赖方向：inject.js ← heat.js（只许 import ./playbook.js 与 ./inject.js，保持可单测）。

import { rankInjection, HEAT_WEIGHT, RELEVANCE_WEIGHT } from './inject.js';

/** 滚动窗口里最多留多少条用户消息（超过就丢最老的）。 */
export const HEAT_WINDOW_MESSAGES = 30;

/** 每条历史消息最多给多少条条目加 1 点热度（只认该消息检索出来的前 N 条）。 */
export const HEAT_TOP_PER_MESSAGE = 3;

export { HEAT_WEIGHT, RELEVANCE_WEIGHT };

// D2：computeHeat 对窗口里每条用户消息各跑一次 rankInjection。窗口是滑动窗口，相邻两次
// 事件里绝大多数消息完全相同 —— 按「消息 + 条目内容 + 门槛档」把每条消息的命中 id 列表
// 记忆化，避免重复打分（单次 computeHeat 实测约 14.3ms）。有界 LRU（Map 插入序当队列，
// 命中即刷新，超过 HEAT_MEMO_MAX 丢最老的），只用内存、不落盘。
const HEAT_MEMO_MAX = 500;
const heatRankMemo = new Map();
function memoGet(key) {
  if (!heatRankMemo.has(key)) return undefined;
  const value = heatRankMemo.get(key);
  heatRankMemo.delete(key);
  heatRankMemo.set(key, value);
  return value;
}
function memoSet(key, value) {
  if (heatRankMemo.has(key)) heatRankMemo.delete(key);
  heatRankMemo.set(key, value);
  while (heatRankMemo.size > HEAT_MEMO_MAX) {
    const oldest = heatRankMemo.keys().next().value;
    heatRankMemo.delete(oldest);
  }
}
/** 清空热度记忆化缓存（测试/排障用）。 */
export function clearHeatRankMemo() { heatRankMemo.clear(); }
/** 当前记忆化缓存条目数（测试/排障用）。 */
export function heatMemoSize() { return heatRankMemo.size; }
function memoSignatureOf(list) {
  let h = 5381;
  for (const e of list) {
    const s = String(e.id) + '\u0001' + String(e.title || '') + '\u0001' + String(e.condition || '')
      + '\u0001' + String(e.action || '') + '\u0001' + String(e.rationale || '');
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36) + ':' + list.length;
}

/**
 * 按 agent 隔离的热度窗口（纯内存，WeakMap 键是 agent 对象）。
 *
 * 为什么用 WeakMap 而不是 Map：agent 对象活多久窗口就活多久，agent 被回收时窗口自动消失，
 * 不会因为长期开着 GUI 而攒下一堆僵尸 agent 的字符串数组。
 *
 * @returns {{note: (agent: object, text: string) => string[],
 *            messagesOf: (agent: object) => string[],
 *            clear: (agent: object) => void}}
 *   note() 返回压入后的窗口快照（最老在前）；messagesOf() 返回副本，调用方改不动内部状态。
 */
export function createHeatWindow() {
  const store = new WeakMap();
  const readable = (agent) => agent !== null && typeof agent === 'object';

  const messagesOf = (agent) => {
    if (!readable(agent)) return [];
    const list = store.get(agent);
    return Array.isArray(list) ? list.slice() : [];
  };

  return {
    messagesOf,
    note(agent, text) {
      if (!readable(agent)) return [];
      const line = String(text ?? '').trim();
      if (!line) return messagesOf(agent);
      const list = Array.isArray(store.get(agent)) ? store.get(agent) : [];
      list.push(line);
      // 环形窗口：只保留最近 HEAT_WINDOW_MESSAGES 条，第 31 条进来就把第 1 条挤出去。
      while (list.length > HEAT_WINDOW_MESSAGES) list.shift();
      store.set(agent, list);
      return list.slice();
    },
    clear(agent) {
      if (readable(agent)) store.delete(agent);
    },
  };
}

/**
 * 算一批条目在最近这些用户消息上的热度：命中的条目每命中一条消息 +1。
 *
 * 「命中」的口径与注入完全一致（复用 lib/inject.js 的 rankInjection）：对每条消息各跑一次
 * 检索，取 score > 0 的前 topPerMessage 条。这样热度回答的问题就是
 * 「这条经验最近被用户的话题反复捞到过几次」，而不是另造一套打分。
 *
 * 注意：这里**绝不把 heat 传回 rankInjection**（否则历史热度会污染「命中」的判定，
 * 同一批消息每算一次分数都不一样，热度就不再可复现）。rankInjection 的 options.heat
 * 只给「最终挑选」用。
 *
 * @param {Array<object>} entries - 条目快照
 * @param {string[]} messages - 用户消息正文（最老在前，通常来自 createHeatWindow().messagesOf）
 * @param {{topPerMessage?: number, injectMinScoreIdfRatio?: number, injectMinRelativeToTop?: number}} [options]
 * @returns {Map<string, number>} id → 命中次数（没命中的 id 不出现在 Map 里）
 */
export function computeHeat(entries, messages, options = {}) {
  const counts = new Map();
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.id) : [];
  const texts = Array.isArray(messages) ? messages : [];
  if (!list.length || !texts.length) return counts;
  const raw = Number(options && options.topPerMessage);
  const topPerMessage = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : HEAT_TOP_PER_MESSAGE;
  const sig = memoSignatureOf(list);
  // 第 50 轮：热度账与注入账必须走**同一档**相关性门槛（否则候选层过滤后热度仍能
  // 给门槛以下的条目加分，注入端却又把它们丢掉 —— 两本账对不上）。不传 = 默认档。
  const gateIdf = options && options.injectMinScoreIdfRatio;
  const gateRel = options && options.injectMinRelativeToTop;
  for (const text of texts) {
    const query = String(text ?? '').trim();
    if (!query) continue;
    // D2：每条消息的命中 id 列表按「消息 + 条目内容 + 门槛档」记忆化（有界 LRU）。
    const memoKey = sig + '\u0002' + String(gateIdf) + '\u0002' + String(gateRel) + '\u0002' + query;
    let rankedIds = memoGet(memoKey);
    if (rankedIds === undefined) {
      const { ranked } = rankInjection(list, query, {
        injectMinScoreIdfRatio: gateIdf,
        injectMinRelativeToTop: gateRel,
      });
      rankedIds = ranked.map((it) => (it && it.entry ? it.entry.id : undefined)).filter(Boolean);
      memoSet(memoKey, rankedIds);
    }
    for (const id of rankedIds.slice(0, topPerMessage)) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}
