// dsh-ace 的注入投递（第 28 轮）：把「本回合最相关的几条经验」**追加成一条 user 消息**，
// 而不是改写系统提示段。
//
// 为什么必须追加进历史（前缀缓存红线）：
// 系统提示在请求最前面，而本插件跑的那条路由（magpie/group/never-stuck）没有声明
// systemPromptUpdate:'in-history'，宿主只能把渲染文本**原地重写**进首个系统节点。
// 于是每换一批经验，从注入点（系统提示 25.0% 处）往后整段缓存前缀全部作废 ——
// 真实 provider 缓存账本实测：切换请求的 cached 恒为 8,320 tok，单笔重付
// 87.1K / 88.4K / 73.4K / 97.8K token，73 次切换累计重付 926.0K token。
// 追加一条消息只往历史尾部加节点，前缀一个字节都不动。
//
// 宿主接缝（照第一方 dsh-agent-instructions 的写法）：
//   ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => { ... })
//   - 事件与决策类型：~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:304（'agent/pre-step'）、
//     :92-99（PreStepDecision = {kind:'reject'} | {kind:'enter', messages, startsRequestSeries?:true}）
//   - 宿主实现：~\@deepseek-ai\dsh-agent-loop\lib\index.js:902-927
//   - 第一方范例：~\dsh-agent-instructions\lib\index.js:1406-1424（先 await next()，再 toSpliced 插入）
// waterfall 规则（宿主 practices.md:16）：不拥有决策就原样返回 next() 的结果；
// 要改写决策必须 spread 保留其它字段（尤其 startsRequestSeries）。
//
// 本文件**不 import 任何宿主包**：createUserMessage 由 lib/index.js 注入进来
// （@deepseek-ai/dsh-llm 在插件目录下不可解析，见 tests/wiring.test.mjs 的桩宿主包），
// 于是 tests/inject-delivery.test.mjs 能用假实现**真跑**这条路径，而不是复刻生产逻辑。

import { isMainAgent, logInfo, logWarn } from './trigger.js';
// textBlocks：宿主消息的 content 必须是 ContentBlock[]，裸字符串会让宿主的 .content.some 抛错
// （见 ./notice.js 头注记录的真实事故），造 content 一律走这个口径。
import { textBlocks } from './notice.js';
import { nowStamp } from './timestamp.js';

/** 注入消息的来源标记：kind 是产出者（本插件），form 是种类（自动注入）。 */
export const INJECTION_SOURCE_KIND = 'dsh-ace';
export const INJECTION_SOURCE_FORM = 'injection';

function bump(stats, key) {
  if (!stats || typeof stats !== 'object') return 0;
  const next = (Number.isFinite(stats[key]) ? stats[key] : 0) + 1;
  stats[key] = next;
  return next;
}

/**
 * 早退分桶（第 40 轮 R1）：每个门槛分支各自计数。
 *
 * 为什么需要它：注入「一次都没发生过」只能靠计数分清三种失效 —— 接缝根本没被宿主调用
 * （preSteps === 0）、被调用了但每个回合都在某个门槛上早退（earlyReturn.by 某一桶在涨）、
 * 真的抛错（failures.deliver 在涨）。只记一个 failed 是把三者混成一个数。
 * stats 里没有这块结构时静默跳过（老桩只传 {batches, appended, ...}，不许因此抛错）。
 */
function bumpEarlyReturn(stats, bucket) {
  const by = stats && typeof stats === 'object' ? stats.earlyReturn?.by : null;
  if (!by || typeof by !== 'object') return;
  by[bucket] = (Number.isFinite(by[bucket]) ? by[bucket] : 0) + 1;
}

/** 取嵌套计数块（failures / stall），不存在时返回 null —— 调用方必须判空。 */
function nestedStats(stats, group) {
  const target = stats && typeof stats === 'object' ? stats[group] : null;
  return target && typeof target === 'object' ? target : null;
}

/**
 * 连续计数自增（第 40 轮 R5 的分子）；delta 也可为负或 0 用于清零/回退。
 */
function addNested(target, key, delta) {
  if (!target) return;
  const base = Number.isFinite(target[key]) ? target[key] : 0;
  target[key] = Math.max(0, base + delta);
}

function errorText(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

/**
 * 新建注入投递器。
 *
 * @param {object} spec
 * @param {{take: Function, note: Function}} spec.flow - lib/injection-flow.js 的 createInjectionFlow()；
 *   take(agent) 取走**尚未投递**的那一批（同一批只交付一次，见该文件头注）；
 *   note(agent, ids) 在追加成功之后才把它记进命中账本（失败时不记，避免幽灵注入）
 * @param {Function} spec.createUserMessage - 宿主 @deepseek-ai/dsh-llm 的 createUserMessage
 * @param {{appended?: number, failed?: number}} [spec.stats] - 内存计数器（lib/index.js 的 injectionStats）
 * @param {object} [spec.logger] - ctx.logger
 */
export function createInjectionDelivery({ flow, createUserMessage, stats, logger, stallOf, injectedIds } = {}) {
  return {
    /**
     * agent/pre-step 监听器的全部逻辑（lib/index.js 只做薄委托）。
     *
     * 语义：
     *   - 先 await next()：不拥有决策时原样返回，绝不吞掉下游的决定；
     *   - decision.kind !== 'enter' → 原样返回（'reject' 是宿主的否决，不许改写）；
     *   - 只有主代理 + 存在「已发布但尚未投递」的批次时才追加一条 user 消息到 messages 末尾；
     *   - 投递成功后同一批不会再被交付（injection-flow 的 delivered 标记），
     *     所以同一回合后续每一步都不会重复追加；
     *   - **本函数自己造成的**异常只写一行 warn + failed += 1，**绝不冒到宿主** ——
     *     pre-step 监听器抛错会让整个回合打哑（已知事故模式）；
     *   - **下游 next() 抛的错不在此列**：它原样 rethrow（宿主的错误不属于「注入失败」）。
     *     但第 41 轮起**先记一桶再看**：改前 `await next()` 在 try 之外 ⇒
     *     「接缝到了、但下游炸了」与「接缝根本没到 handler」在 stats 上完全同形，
     *     排障时无法区分（审计风险 5）。现在前者落 failures.next + earlyReturn.by.downstreamThrew。
     *
     * @param {{agent?: object, messages?: Array, turn?: number, step?: number, signal?: object}} payload
     * @param {Function} next - waterfall 的下游
     * @returns {Promise<object>} PreStepDecision
     */
    async onPreStep(payload, next) {
      const failures = nestedStats(stats, 'failures');
      // 第 41 轮（审计风险 2）：R5 的「连续投递失败」计数必须**按 agent 分表**，与
      // lib/index.js 的 stallRecordOf 同源（生产路径由 index.js 把 stallOf 注入进来）。
      // 没注入 stallOf 时（直接单测本文件）退化成旧的单份 stats.stall 对象，行为不变。
      const sharedStall = nestedStats(stats, 'stall');
      const stallFor = (a) => (typeof stallOf === 'function' ? stallOf(a) : sharedStall);
      // settled 的用途只有一个：分清「next() 自己抛错」和「next() 回来了、后面我们自己炸了」。
      // 前者原样 rethrow（宿主的错误不吞），但仍先记进 failures.next + downstreamThrew。
      let settled = false;
      let decision;
      try {
        decision = await next();
        settled = true;
        if (!decision || decision.kind !== 'enter') {
          bumpEarlyReturn(stats, 'notEnter');
          return decision;
        }
        const agent = payload?.agent;
        if (!agent) {
          bumpEarlyReturn(stats, 'noAgent');
          return decision;
        }
        // 子代理不注入（D4）：子代理没有回合边界落盘路径，注入了只会让 hits 只增不减、
        // 还会污染主代理的淘汰顺序。
        if (!isMainAgent(agent)) {
          bumpEarlyReturn(stats, 'subAgent');
          return decision;
        }
        const picked = typeof flow?.take === 'function' ? flow.take(agent) : null;
        // ids 为空 = 这一批已经投递过 / 本轮无命中 → 什么都不做（不重复追加）。
        if (!picked || !Array.isArray(picked.ids) || !picked.ids.length) {
          bumpEarlyReturn(stats, 'noAgentPicked');
          return decision;
        }
        const text = typeof picked.text === 'string' ? picked.text.trim() : '';
        if (!text) {
          bumpEarlyReturn(stats, 'noText');
          return decision;
        }
        if (typeof createUserMessage !== 'function') {
          throw new TypeError('createUserMessage 不可用（宿主 @deepseek-ai/dsh-llm 未注入）');
        }
        const message = createUserMessage({
          content: textBlocks(text),
          source: { kind: INJECTION_SOURCE_KIND, form: INJECTION_SOURCE_FORM },
        });
        const messages = Array.isArray(decision.messages) ? decision.messages : [];
        const entered = typeof messages.toSpliced === 'function'
          ? messages.toSpliced(messages.length, 0, message)
          : [...messages, message];
        // 消息真的造出来了 → 这一批才算交付成功：记账 + 计数。
        // 顺序很关键：先拿到 message 再 note，失败路径（上面两个 throw）就不会留下幽灵注入。
        if (typeof flow?.note === 'function') flow.note(agent, picked.ids);
        // B3：消息真的追加进历史之后，把这批条目记进「会话内已注入」集合（下次不再重复注入）。
        if (injectedIds && typeof injectedIds.record === 'function') injectedIds.record(agent, picked.ids);
        const appended = bump(stats, 'appended');
        // 第 40 轮 R1：deliveries 是「经验真的送到模型眼前」的唯一判据（batches 只说检索发出了
        // 一批，投递层可能一次都没接住）。R5 的连续失败计数在这里清零 —— 只有**送成功**才算
        // 断开的那条链重新通了。
        bump(stats, 'deliveries');
        // 第 41 轮（审计风险 4）：记下「最后一次经验真的追加进历史」的时刻。
        // 与 lastPublishAt 配对：只有发布时刻说明不了「发出去但没送进去」，两个一前一后即可定位。
        if (stats && typeof stats === 'object') stats.lastDeliveryAt = nowStamp();
        const deliveredStall = stallFor(agent);
        if (deliveredStall) deliveredStall.deliverySilent = 0;
        logInfo(logger, 'dsh-ace: 注入已追加进历史（' + picked.ids.length + ' 条经验：' + picked.ids.join(', ')
          + '，约 ' + (picked.tokens || 0) + ' token；累计追加 ' + appended + ' 次）');
        // spread 保留 decision 的其它字段（尤其 startsRequestSeries），只换 messages。
        return { ...decision, messages: entered };
      } catch (error) {
        if (!settled) {
          // 第 41 轮（审计风险 5）：接缝**到了**，但下游 pre-step 监听器在 next() 里抛错。
          // 记一桶再原样 rethrow —— 吞掉宿主的错误是另一类事故，绝不是本插件的权限
          // （tests/inject-delivery.test.mjs「下游 next() 抛错时原样冒出去」钉着这条）。
          addNested(failures, 'next', 1);
          bumpEarlyReturn(stats, 'downstreamThrew');
          logWarn(logger, 'dsh-ace: 注入接缝已到达，但下游 pre-step 监听器抛错（' + errorText(error) + '），错误已原样上抛');
          throw error;
        }
        // 注入是增强项：这里抛出去会把整个回合打哑（pre-step 监听器没有兜底）。
        // 静默失败点③（第 40 轮 R1）：以前只 failed + 一行 warn，与预检索的失败混在一个数里。
        // 现在 failures.deliver 单独记，并累加 R5 的「连续投递失败」分子（第 41 轮起按 agent 分表）。
        bump(stats, 'failed');
        addNested(failures, 'deliver', 1);
        addNested(stallFor(payload?.agent), 'deliverySilent', 1);
        logWarn(logger, 'dsh-ace: 注入追加进历史失败，本步不注入（' + errorText(error) + '）');
        return decision;
      }
    },
  };
}
