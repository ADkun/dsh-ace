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

import {
  createRecapState,
  recordTurnEnd,
  takePendingRecap,
  requeuePendingRecap,
  isBusyError,
  isMainAgent,
  hasNoRunningSubagents,
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
 * @param {(agent: object, pending: object) => Promise<void>} deps.runRecap - 真正执行一次复盘
 * @param {() => Array} [deps.listAgents] - ctx.agents.list()（判断有没有在跑的子代理）
 * @param {object} [deps.logger] - ctx.logger
 * @param {(agent: object, reason: string) => void} [deps.notifyFailure] - 真实失败时给用户推一条提示
 * @param {number} [deps.maxAttempts] - 竞态退避的重试次数上限（默认 3）
 * @returns {object} 调度器
 */
export function createRecapController({
  getConfig,
  runRecap,
  listAgents,
  logger,
  notifyFailure,
  maxAttempts = MAX_RECAP_ATTEMPTS,
} = {}) {
  // 每个 agent 一份状态；显式挂在 stateFor 上，测试可以直接断言（不做闭包隐式状态）。
  const states = new WeakMap();

  /**
   * 取（并懒建）某个 agent 的复盘状态。
   * @param {object} agent
   * @returns {{mutCount:number,lastRecapTurn:number,currentTurn:number,pending:object|null}}
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
   * 回合结束（agent/turn-stopping）：**只记账与判定**，绝不调 runMaintenance、绝不调 LLM。
   * 命中触发条件时把复盘请求挂成待办，等下一个空闲边沿再执行。
   * @param {object} payload - { agent, turn }
   * @returns {object} { trigger, pending }
   */
  function onTurnStopping(payload) {
    const agent = payload?.agent;
    if (!agent || !isMainAgent(agent)) return { trigger: false, pending: null };
    const all = typeof listAgents === 'function' ? (listAgents() ?? []) : [];
    if (!hasNoRunningSubagents(all, agent)) return { trigger: false, pending: null };
    const st = stateFor(agent);
    const outcome = recordTurnEnd(st, { turn: payload?.turn, config: typeof getConfig === 'function' ? getConfig() : undefined });
    if (outcome.trigger) {
      logger?.info?.('dsh-ace: 回合 ' + outcome.pending.turn + ' 记账 ' + outcome.pending.mutCount + ' 次 mutating 调用，已挂自动复盘待办（等空闲边沿执行）');
    }
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
    const pending = takePendingRecap(st);
    if (!pending) return;
    // 等宿主真正空闲：idle 边沿之后可能已经被新的唤醒请求拉起新一轮。
    if (typeof agent.whenIdle === 'function') {
      try {
        await agent.whenIdle();
      } catch (error) {
        logger?.warn?.('dsh-ace: 等待宿主空闲时出错（' + ((error && error.message) || error) + '）');
      }
    }
    try {
      await runRecap(agent, pending);
    } catch (error) {
      if (isBusyError(error)) {
        // 预期内的竞态：不刷屏，只写日志；待办放回队列等下一个 idle 边沿。
        const outcome = requeuePendingRecap(st, pending, maxAttempts);
        if (outcome.exhausted) {
          logger?.warn?.('dsh-ace: 自动复盘与宿主忙碌冲突，重试 ' + maxAttempts + ' 次仍未腾出空闲，本回合经验未并入手册');
          notifyFailure?.(agent, 'agent 一直忙，重试 ' + maxAttempts + ' 次仍未腾出空闲');
          return;
        }
        logger?.warn?.('dsh-ace: 自动复盘撞上宿主忙碌（already has active work），待办已放回队列（第 ' + outcome.pending.attempts + ' 次），等下一个空闲边沿再试');
        return;
      }
      // 其它真实失败（LLM 调用失败、手册写入失败等）：给用户推一条提示，
      // 并把这回合的 mutating 计数还回状态（沿用改动前的做法），
      // 让之后的回合仍有机会重新判定并复盘。
      logger?.warn?.('dsh-ace: 自动复盘失败（' + ((error && error.message) || error) + '）');
      st.mutCount = (Number(st.mutCount) || 0) + (Number(pending && pending.mutCount) || 0);
      notifyFailure?.(agent, String((error && error.message) || error));
    }
  }

  return { stateFor, countMutating, onTurnStopping, onStatus };
}
