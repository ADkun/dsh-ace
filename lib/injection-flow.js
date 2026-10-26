// dsh-ace 的注入接缝（C5.6）：把「本回合注入了哪些条目」接进 C1 的命中账本，
// 并保证**同一批只交付一次**。
//
// 第 28 轮改造后这条接缝的语义（前缀缓存红线，见 ./inject-delivery.js 头注）：
// 注入不再渲染进系统提示，而是由 agent/pre-step 追加成一条 user 消息。于是这里的
// take(agent) 变成「取走一批**尚未投递**的注入结果」：
//   - 有未投递批次 → 把 id 记进账本、标记该批已交付、把整块文本交出去（pre-step 用它造消息）；
//   - 已交付过 / 本轮无命中 → 返回 null，调用方什么都不做（同一批绝不重复追加）。
//
// 为什么要单独一层（而不是在 index.js 里直接调 ledger.note）：
//   tests/wiring.test.mjs 有一条源码级红线 —— index.js 里不许出现 ledger.note(，
//   账本的写入点必须唯一地留在这个模块里，否则「谁记了账」会散成多处、口径失控。
//
// D4：账本**只给主代理记**。子代理没有回合边界落盘路径（lib/recap.js 的 onTurnStopping 有
// isMainAgent 门），记账就等于只增不减，还会让「子代理用过」污染主代理的淘汰顺序。
// 所以在源头就不记，而不是在文档里写一条「已知限制」。子代理连投递都不做（见 inject-delivery.js）。

import { isMainAgent } from './trigger.js';

/**
 * 新建注入接缝。
 * @param {object} spec
 * @param {{get: Function, set: Function, clear: Function}} spec.cache - lib/inject.js 的 createInjectionCache()
 * @param {{note: Function}} spec.ledger - lib/ledger.js 的 createUsageLedger()
 */
export function createInjectionFlow({ cache, ledger } = {}) {
  // agent -> 已经交付过的那条消息的 key（同一批只交付一次的结构性保证）
  const delivered = new WeakMap();
  const keyOf = (agent) => (agent && typeof agent === 'object' ? agent : null);

  return {
    /**
     * 发布一次检索结果（预检索完成后调用）。value 必须带 key（消息标识），
     * 投递时据此判断这条结果是否已经被交付过。
     */
    publish(agent, key, value) {
      const a = keyOf(agent);
      if (!a || !value) return null;
      const payload = { ...value, key };
      cache.set(a, key, payload);
      return payload;
    },

    /**
     * 取走一批尚未投递的注入结果（agent/pre-step 每次进入时调用一次）。
     *
     * 成功交付时副作用：主代理的 id 记进命中账本（去重由账本负责）+ 标记该批已交付。
     * 同一批的第二次调用返回 null —— 这正是「同一回合后续每一步都不重复追加」的实现。
     *
     * @returns {null|{text: string, tokens: number, count: number, ids: string[]}}
     */
    take(agent) {
      const a = keyOf(agent);
      if (!a) return null;
      const value = cache.get(a);
      if (!value || !Array.isArray(value.ids) || !value.ids.length) return null;
      if (delivered.get(a) === value.key) return null;
      delivered.set(a, value.key);
      // 注意：take 只「认领」，**不记账**。记账必须在投递真的成功之后（见下面的 note）——
      // 否则造消息 / 追加抛错时会出现「账本里有、历史里没有」的幽灵命中，
      // 那些条目会凭空多一次 hits、在淘汰时被当成「更常用」而活下来（tests/inject-delivery.test.mjs 的 f 用例钉住这点）。
      return {
        text: value.text,
        tokens: value.tokens || 0,
        count: value.count || value.ids.length,
        ids: value.ids.slice(),
      };
    },

    /**
     * 投递成功之后调用：把这一批 id 记进命中账本（回合边界一次原子写盘成 hits += 1）。
     *
     * 这是**账本唯一的写入点**（index.js 里不许出现 ledger.note(，见 tests/wiring.test.mjs）。
     * D4：只给主代理记（子代理没有回合边界落盘路径，记了只会无限堆积）。
     */
    note(agent, ids) {
      const a = keyOf(agent);
      if (!a || !Array.isArray(ids) || !ids.length) return;
      if (isMainAgent(a)) ledger?.note?.(a, ids);
    },

    /** 该 agent 当前可注入的 id 集合（只读，给设置页/测试看，不记账）。 */
    peek(agent) {
      const a = keyOf(agent);
      if (!a) return [];
      const value = cache.get(a);
      return value && Array.isArray(value.ids) ? value.ids.slice() : [];
    },

    // 曾经这里有一个 reset(agent)（清掉「已交付」标记），P2-3 已删除：
    // 生产代码从不调用它（grep lib/ 只有定义本身）。跨回合不串账真正靠的是下面这条结构性保证 ——
    // delivered 存的是**上一条被交付过的消息 key**，新用户消息的 key 必然不同，于是 take 里
    // `delivered.get(a) !== value.key` 自然为真，新批次照常交付一次。所以没有「需要手动清标记」的时刻，
    // 留着它反而让人以为存在一个必须调用的生命周期钩子。
  };
}