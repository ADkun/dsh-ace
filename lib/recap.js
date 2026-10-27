// dsh-ace 自动复盘的调度器：回合内只记账，空闲边沿才真正跑复盘。
//
// 为什么单独成文件：lib/index.js 依赖宿主包（@deepseek-ai/dsh-tools 等），
// node --test 里加载不了；调度逻辑本身不碰任何宿主 API，因此可以纯 JS 独立测试
// （tests/recap.test.mjs）。
//
// 时机依据（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - agent.runMaintenance 只在宿主的 idle 相位合法：~\@deepseek-ai\dsh-agent-loop\lib\index.js:823
//   在 phase.kind !== 'idle' 时同步抛「agent already has active work」；
//   turn-stopping 在 turn() 内部派发，而 turn() 开头同文件 :939 断言 phase 是 running
//   —— 所以复盘**不能**在 turn-stopping 里跑（那正是自动复盘从未落盘的原因）。
// - 合法空闲点：同文件 :887-901（kick 的 finally 把 phase 置回 idle）→ setPhase 同文件 :794-799
//   先写 this.phase 再 emit agent/status，所以 idle 监听里宿主已经是 idle 相位。
// - agent.whenIdle：~\dsh-agent\lib\types\runtime-types.d.ts:164（等到整台 agent 静默）；
//   实现见 ~\@deepseek-ai\dsh-agent-loop\lib\index.js:870-875。
// - agent/status 载荷 {agent,status}：~\dsh-agent\lib\types\runtime-types.d.ts:252-255
//   （agent 由 fused 注入：~\dsh-agent\lib\types\dispatch.js:42）。
// - 宿主里用 agent/status 做收尾工作的参考实现：~\dsh-goal-round-driver\lib\index.js:223-242、
//   ~\dsh-compaction-basic\lib\index.js:853-855。
//
// —— 第 33 轮（用户拍板）：正负评分整层删除，调度器只剩两件事 ——
//   ① 回合边界把「本回合的命中 id」从内存账本取走，一次原子写盘（hits/lastHit）；
//   ② 空闲边沿取待办、跑复盘（合并 → 淘汰 → 增量写手册）。
// 已删除（连同因果链）：settling / settlingIds / usages / settlePendingUsage / hasPendingUsage /
// noteTurnUsage / pendingUsageIds / adoptUnobservedUsage / settleOrphanUsages / unobservedTurns /
// orphanUsages / noteTool / noteError，以及三档回合信号（settleTurnOutcome 一族）。
// 为什么可以整层删：那套时序机制存在的**唯一**理由是「别把分记错」——账本要先结算落盘，
// 归档扫描才不会按旧净分把刚注入的条目扫走。计分没了，约束的前提也没了：
// hits 只增不减、永不影响淘汰之外的东西，晚一个空闲边沿落盘也不会算错任何东西。

import {
  createRecapState,
  recordTurnEnd,
  takePendingRecap,
  requeuePendingRecap,
  abandonPendingRecap,
  restorePendingMutCount,
  isBusyError,
  isMainAgent,
  logInfo,
  logWarn,
  MAX_RECAP_ATTEMPTS,
} from './trigger.js';

/**
 * 创建自动复盘调度器。
 *
 * 调度器只管「什么时候跑」，不碰手册内容：真正的复盘主体由 runRecap 注入
 * （lib/index.js 里接 agent.runMaintenance + Reflector/Curator）。
 *
 * @param {object} deps
 * @param {() => object} deps.getConfig - 取当前生效配置（autoRecap / autoRecapThreshold / autoRecapCooldownTurns）
 * @param {(agent: object, pending: object) => Promise<object|void>} deps.runRecap - 真正执行一次复盘；
 *   返回值有三种形状（第 39 轮补全契约注释）：
 *   - `{skipped: true}`：这一轮没材料、没调 LLM —— 调度器把冷却与 mutating 计数都还回去（见下）；
 *   - `{queued: true}`：复盘已交给插件自己的串行队列（lib/recap-queue.js），调度器**到此为止**，
 *     不再等待、也不再 catch —— 那份复盘的成功/失败/放弃都在队列内部结算（含它自己的
 *     onFailed 回滚钩子）。这也是第 39 轮起生产路径的真实形状：复盘不占宿主相位。
 *   - `undefined` / 其它：维持旧调用方的形状，语义等同「已执行完」。
 * @param {object} [deps.logger] - ctx.logger
 * @param {(agent: object, reason: string) => void} [deps.notifyFailure] - 真实失败时给用户推一条提示
 * @param {number} [deps.maxAttempts] - 竞态退避的重试次数上限（默认 3）
 * @param {(agent: object) => string[]} [deps.takeHitIds] - 取走并清空该 agent 的命中账本
 *   （生产上是 lib/ledger.js 的 take）；不传则退化为「没有账本」，不影响既有调用方
 * @param {(payload: {agent: object, ids: string[]}) => Promise<object|void>} [deps.flushHits] -
 *   把一批命中 id 原子写盘（生产上是 lib/index.js 的 recordHits → commitMeta + markHits）。
 *   **抛错必须向上冒**（生产接线传 throwOnError: true）：调度器要据此把这批 id 退回账本重试
 * @param {(agent: object, ids: string[]) => void} [deps.noteHitIds] - 把一批命中 id **写回**账本
 *   （生产上是 lib/ledger.js 的 note，复用既有写入通道，不另造状态机）；不传则退化为
 *   「写盘失败即丢弃」（旧语义，仅供没有账本的调用方）
 * @returns {object} 调度器
 */
export function createRecapController({
  getConfig,
  runRecap,
  logger,
  notifyFailure,
  maxAttempts = MAX_RECAP_ATTEMPTS,
  takeHitIds,
  noteHitIds,
  flushHits,
} = {}) {
  // 每个 agent 一份状态；显式挂在 stateFor 上，测试可以直接断言（不做闭包隐式状态）。
  const states = new WeakMap();
  // 命中落盘的在飞链（每个 agent 一条）：回合边界触发的写盘按到达顺序串起来，
  // 保证「先记的命中先落盘」，同时让空闲边沿能等它写完再读手册（复盘读到的 hits 一定是最新的）。
  const hitFlushes = new WeakMap();

  /**
   * 取（并懒建）某个 agent 的复盘状态。
   * @param {object} agent
   * @returns {{mutCount:number,lastRecapTurn:number,currentTurn:number,pending:object|null,pendingSeq:number}}
   */
  function stateFor(agent) {
    let st = states.get(agent);
    if (!st) {
      st = createRecapState();
      states.set(agent, st);
    }
    return st;
  }

  /**
   * 记一次 mutating 工具调用（tools/result 事件用）。
   * @param {object} agent
   */
  function countMutating(agent) {
    if (!agent) return;
    stateFor(agent).mutCount++;
  }

  /**
   * 回合边界：把本回合的命中 id 取走并排一次原子写盘。
   *
   * 为什么在**回合边界**取（而不是投递当下就写盘）：注入投递与 ace_playbook 检索都可能在一回合里
   * 发生多次，逐次写盘会让同一个回合写十几遍同一份手册；攒到回合末一次写，既是「一次原子写」，
   * 也把写盘失败的影响限制在「本回合的命中晚一点记账」——命中只增不减，晚记不会算错任何东西。
   *
   * 写盘失败**只 warn 不抛**：命中记账是尽力而为的观测数据，绝不能因为一次写盘失败
   * 让回合结束这条链路炸掉。但「只 warn」不等于把命中丢掉（第 34 轮修正）：账本已经在取走时
   * 清空，所以失败时**必须把这批 id 原样写回账本**（noteHitIds → ledger.note），让下一个
   * 回合边界连同新的命中一起重试。没有 noteHitIds 可退时才退化为「丢弃 + 明说已丢」。
   *
   * @returns {Promise<object|null>} 本次写盘结果（无实现/无 id 时 null）
   */
  function flushHitsNow(agent, ids) {
    if (typeof flushHits !== 'function' || !ids.length) return Promise.resolve(null);
    const prev = hitFlushes.get(agent) || Promise.resolve();
    const task = prev
      .catch(() => {})
      .then(() => flushHits({ agent, ids: ids.slice() }))
      .catch((error) => {
        const reason = (error && error.message) || error;
        try {
          if (typeof noteHitIds === 'function') {
            noteHitIds(agent, ids.slice());
            logWarn(logger, 'dsh-ace: 命中落盘失败（' + reason + '），这批命中已退回账本，下个回合边界重试');
          } else {
            logWarn(logger, 'dsh-ace: 命中落盘失败（' + reason + '），没有账本可退回，这批命中已丢失');
          }
        } catch (restoreError) {
          logWarn(logger, 'dsh-ace: 命中落盘失败（' + reason + '），退回账本也失败（'
            + ((restoreError && restoreError.message) || restoreError) + '），这批命中已丢失');
        }
        return null;
      });
    hitFlushes.set(agent, task);
    return task;
  }

  /**
   * 从内存账本取走本回合的命中 id（同步、绝不抛）。
   * @param {object} agent
   * @returns {string[]}
   */
  function takeHits(agent) {
    if (typeof takeHitIds !== 'function') return [];
    try {
      const taken = takeHitIds(agent) || [];
      return (Array.isArray(taken) ? taken : []).filter((id) => typeof id === 'string' && id.length > 0);
    } catch (error) {
      // 取账本失败不该让回合结束这条链路炸掉：账本本来就是尽力而为的观测数据。
      logWarn(logger, 'dsh-ace: 取命中账本时出错（' + ((error && error.message) || error) + '），本回合按没有命中处理');
      return [];
    }
  }

  /**
   * 回合结束（agent/turn-stopping）：**只记账**，绝不调 runMaintenance、绝不调 LLM。
   * 命中触发条件时把复盘请求挂成待办，等下一个空闲边沿再执行。
   *
   * @param {object} payload - { agent, turn }
   * @returns {object} { trigger, pending }
   */
  function onTurnStopping(payload) {
    const agent = payload?.agent;
    // 只剩「主代理」这一道门：子代理自己不记账（它的经验由父代理那一轮一并沉淀）。
    // 曾经还有一道「排除自身后 ctx.agents 里不能有别的 agent」的门，已删除——子代理在宿主里是
    // resident，settle 之后才从注册表注销（~\@deepseek-ai\dsh-subagent\lib\index.js:1978-2046
    // 的 finishDisposal，注销那一行在同文件 :2034 的 resident.delete(childId)），而真实用法几乎每轮都在派子代理，
    // 那道门因此几乎总是拦掉整轮，连记账都不发生。
    if (!agent || !isMainAgent(agent)) return { trigger: false, pending: null };
    const st = stateFor(agent);
    // logger 要传进去：recordTurnEnd 撞上队列里还没执行的旧待办时会合并计数，
    // 那次「旧待办被并掉」必须在日志里留痕，否则事后完全看不出某回合的经验去哪了。
    const outcome = recordTurnEnd(st, {
      turn: payload?.turn,
      config: typeof getConfig === 'function' ? getConfig() : undefined,
      logger,
    });
    if (outcome.trigger) {
      logInfo(logger, 'dsh-ace: 回合 ' + outcome.pending.turn + ' 记账 ' + outcome.pending.mutCount + ' 次 mutating 调用，已挂自动复盘待办（等空闲边沿执行）');
    }
    // 第 33 轮：命中记账的唯一落盘点。无条件取（与是否触发复盘无关）——冷却回合、阈值未到的
    // 回合同样要把本回合的命中写盘，否则它们会攒到下一回合去记，lastHit 就对不上真实使用时刻。
    const ids = takeHits(agent);
    if (ids.length) flushHitsNow(agent, ids);
    return outcome;
  }

  /**
   * 空闲边沿（agent/status 报 idle）：取出待办并真正执行复盘。
   *
   * 竞态退避：idle 事件之后宿主可能立刻被新的唤醒请求拉起新一轮
   * （~\@deepseek-ai\dsh-agent-loop\lib\index.js:898），所以真正调 runMaintenance 之前
   * 先等宿主空闲（whenIdle）；仍撞上「already has active work」则把待办放回队列，
   * 等下一个 idle 边沿再试，超过上限才放弃并给一次提示。
   *
   * @param {object} payload - { agent, status }
   */
  async function onStatus(payload) {
    const agent = payload?.agent;
    if (!agent) return;
    if (payload?.status !== 'idle') return;
    const st = stateFor(agent);
    // 第 33 轮：先把在飞的命中写盘等完，再跑复盘——复盘第一步要读手册做容量治理，
    // 读到旧 hits 就会拿过时的使用频次去选淘汰对象（淘汰顺序依赖 hits，必须是最新值）。
    // 没有在飞写盘时这里一个 await 都不引入（既有用例依赖「到第一个真 await 之前全同步」）。
    const pendingFlush = hitFlushes.get(agent);
    if (pendingFlush) {
      try {
        await pendingFlush;
      } catch (error) {
        logWarn(logger, 'dsh-ace: 等待命中落盘时出错（' + ((error && error.message) || error) + '），本次按已落盘继续');
      }
    }
    const pending = takePendingRecap(st);
    if (!pending) return;
    try {
      if (typeof agent.whenIdle === 'function') {
        try {
          await agent.whenIdle();
        } catch (error) {
          logWarn(logger, 'dsh-ace: 等待宿主空闲时出错（' + ((error && error.message) || error) + '）');
        }
      }
      const result = await runRecap(agent, pending);
      if (result && result.skipped) {
        // 约定：runRecap 返回 {skipped:true} 表示「没材料、未调 LLM」。那不是失败，也不是
        // 「复盘过了」——所以既不走 notifyFailure，也不能白吃冷却与 mutating 计数：
        // 把这次待办吃掉的两个额度原样还回去，下一轮该触发就还能触发。
        const rolled = abandonPendingRecap(st, pending, logger);
        if (rolled) {
          logInfo(logger, 'dsh-ace: 回合 ' + (pending.turn ?? '?') + ' 没有可复盘的材料（未调 LLM），'
            + '已把 ' + (Number(pending.mutCount) || 0) + ' 次 mutating 计数与冷却额度还回状态，下一轮照常判定');
        }
        return;
      }
    } catch (error) {
      if (isBusyError(error)) {
        // 预期内的竞态：不刷屏，只写日志；待办放回队列等下一个 idle 边沿。
        // 放回同样要先确认「这份待办仍归我」：与两条回滚路径同理，这段 await 窗口里宿主可能
        // 已经挂上更新的待办——无条件覆盖会把它静默丢弃（旧待办随后还会被所有权判定拒绝回滚，
        // 两份额度一起蒸发）。拒绝原因由 requeuePendingRecap 自己写 warn。
        const outcome = requeuePendingRecap(st, pending, maxAttempts, logger);
        if (outcome.exhausted) {
          logWarn(logger, 'dsh-ace: 自动复盘与宿主忙碌冲突，重试 ' + maxAttempts + ' 次仍未腾出空闲，本回合经验未并入手册'
            + (outcome.rejected ? '（队列里那份更新的待办仍在，等下一个空闲边沿执行）' : ''));
          notifyFailure?.(agent, 'agent 一直忙，重试 ' + maxAttempts + ' 次仍未腾出空闲');
          return;
        }
        // 被拒绝时不能谎报「已放回队列」：队列里那份是别人的。
        //
        // 但也不许静默（第 7 轮 F1 的第二个半）：这一轮复盘**确实没跑成**，而且是在撞忙之后
        // 连队列都挤不进去。改动前这里直接 return，日志里一行都没有——事后看日志会以为
        // 「回合 5 那一轮复盘没被触发过」，实际是被触发过、跑了、被忙回去了、额度去处不明。
        // 额度去哪了由 requeuePendingRecap → adoptOrphanPending 写过一条 warn（过继给更新的
        // 待办，或还回状态），这里补的是「这一轮没跑成」这件事本身。
        if (outcome.rejected) {
          logWarn(logger, 'dsh-ace: 回合 ' + (pending.turn ?? '?') + ' 的自动复盘撞上宿主忙碌（already has active work），'
            + '这一轮没跑成，待办也没放回队列（队列里是更新的待办）；它的 ' + (Number(pending.mutCount) || 0)
            + ' 次 mutating 计数已按过继规则记账（见上一条日志），等下一个空闲边沿执行那份更新的待办');
          return;
        }
        logWarn(logger, 'dsh-ace: 自动复盘撞上宿主忙碌（already has active work），待办已放回队列（第 ' + outcome.pending.attempts + ' 次），等下一个空闲边沿再试');
        return;
      }
      // 其它真实失败（LLM 调用失败、手册写入失败等）：给用户推一条提示，
      // 并把这回合的 mutating 计数还回状态（沿用改动前的做法），
      // 让之后的回合仍有机会重新判定并复盘。
      //
      // 但还计数**必须**先确认「这份待办仍归我」：与 skipped 分支同理，调用点与
      // takePendingRecap 之间隔着两次 await，这段窗口里宿主可能已经挂上更新的待办
      // （甚至那份新待办已被另一个空闲边沿取走）。此时把旧回合的计数加回来会重复计入，
      // 下一轮凭虚高的 mutCount 误触发。冷却不回滚——失败说明确实尝试过，这是改动前
      // 就有的刻意行为（见 restorePendingMutCount 的注释）。
      logWarn(logger, 'dsh-ace: 自动复盘失败（' + ((error && error.message) || error) + '）');
      restorePendingMutCount(st, pending, logger);
      notifyFailure?.(agent, String((error && error.message) || error));
    }
  }

  return { stateFor, countMutating, onTurnStopping, onStatus };
}
