// dsh-ace 的「本回合命中条目」账本（C1 的按 agent 分账 WeakMap 抽出来，便于单测）。
//
// 记什么：本回合被**实际用过**的条目 id（ace_playbook 定向检索命中的 + 自动注入且真追加进历史的）。
// 干什么用：回合边界由 lib/recap.js 取走、一次原子写盘成 meta.hits += 1 / meta.lastHit = 现在
// （lib/index.js 的 recordHits → commitMeta + markHits）。
//
// 第 33 轮：hits 的语义从「被选中过」变成**唯一的淘汰依据**——手册满 maxEntries 时按 hits 升序
// 淘汰（同 hits 时 created 更早的先走）。所以这份账本只记「真的用上了」：
//   · 自动注入：注入消息**真的追加进历史**之后才记（lib/inject-delivery.js 的 onPreStep）；
//   · ace_playbook：只有带 query 或 id 的**定向查找**才记，整本读取不记（那不是「用了某条经验」）。
// 正负评分（bumpScores / helpful / harmful）已整层删除：回合成败被外部因素主导、归因不可靠。
//
// 为什么按 agent 分账：同一进程里多个 agent（主 agent + 子 agent）并行跑，
// 各自的命中不能串账。WeakMap 让 agent 被回收时账本自动消失。

/** 新建一份账本。返回 { note, take, peek }，语义与 lib/index.js 里的同名函数一致。 */
export function createUsageLedger() {
  const byAgent = new WeakMap();
  const keyOf = (agent) => (agent && typeof agent === 'object' ? agent : null);
  const slot = (agent) => {
    const key = keyOf(agent);
    if (!key) return null;
    let u = byAgent.get(key);
    if (!u) {
      u = { ids: [] };
      byAgent.set(key, u);
    }
    return u;
  };
  return {
    /** 记入一批 id（去重、只收非空字符串）。 */
    note(agent, ids) {
      const u = slot(agent);
      if (!u || !Array.isArray(ids)) return;
      for (const id of ids) {
        if (typeof id === 'string' && id && !u.ids.includes(id)) u.ids.push(id);
      }
    },
    /** 取走并清空（回合边界落盘时调用）。 */
    take(agent) {
      const u = slot(agent);
      if (!u) return [];
      const ids = u.ids.slice();
      u.ids = [];
      return ids;
    },
    /** 只读查看（不取走）。 */
    peek(agent) {
      const u = slot(agent);
      return u ? u.ids.slice() : [];
    },
  };
}
