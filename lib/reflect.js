// dsh-ace 多轮复盘策略（C3）：Reflector 最多跑 3 轮，某轮返回空数组即收敛。
//
// 为什么抽成独立模块：lib/index.js 依赖宿主包，node --test 里加载不了；
// 而「跑几轮 / 什么时候停 / 候选怎么累积」是纯编排逻辑，抽出后可直接用假的 callRound 驱动。
//
// 收敛判据是**纯程序事实**：本轮返回空数组。绝不解析模型自述的「我已收敛/没有更多经验」，
// 也不让它自己声明结束——上限 3 轮硬停。超时/取消由调用方传下来的 signal 中断，
// 已提炼的候选照常返回（不因为没跑到收敛就丢经验）。

/** 多轮复盘的上限：最多 3 轮（用户拍板的硬上限）。 */
export const REFLECT_MAX_ROUNDS = 3;

// 第 39 轮：单次 LLM 调用超时的标记（与 lib/llm.js 的报错文案前缀保持一致）。
// 用文案前缀而不是 instanceof：超时错误是在 for-await 的 catch 里新构造的 Error，
// 跨模块 instanceof 不可靠，而文案前缀是本仓库既有的错误识别方式（见 lib/trigger.js isBusyError）。
const TIMEOUT_ERROR_PREFIX = 'ace: LLM 调用超时';
function isTimeoutError(error) {
  const message = String((error && error.message) || error || '');
  return message.startsWith(TIMEOUT_ERROR_PREFIX);
}

// 日志绝不能影响复盘：logger 缺失、info 不是函数、甚至 getter 抛错都吞掉（与 lib/trigger.js 的 logInfo 同款容错）。
function logInfo(logger, message) {
  try {
    if (logger && typeof logger.info === 'function') logger.info(message);
  } catch {
    // 日志失败不值得中断复盘
  }
}

/**
 * 跑多轮 Reflector。
 *
 * @param {object} params
 * @param {(round: number, prior: object[]) => Promise<object[]>} params.callRound - 跑一轮；
 *   入参是本轮序号（从 1 起）与此前已提炼的候选，返回本轮候选（空数组 = 收敛）
 * @param {number} [params.maxRounds] - 轮数上限（默认 3，测试可调小）
 * @param {object} [params.logger] - 可选；每轮结果留一行日志
 * @returns {Promise<{candidates: object[], rounds: number, converged: boolean, aborted: boolean}>}
 *   candidates：各轮累积的候选；rounds：实际完成的轮数；converged：是否因空数组收敛；
 *   aborted：是否因中途出错/取消提前结束（此时 candidates 仍返回已提炼的那部分）
 */
export async function reflectRounds({ callRound, maxRounds = REFLECT_MAX_ROUNDS, logger } = {}) {
  if (typeof callRound !== 'function') throw new Error('ace: reflectRounds 需要 callRound 函数');
  const limit = Math.max(1, Number(maxRounds) || REFLECT_MAX_ROUNDS);
  const collected = [];
  let rounds = 0;
  for (let round = 1; round <= limit; round += 1) {
    let batch;
    try {
      batch = await callRound(round, collected.slice());
    } catch (error) {
      // 超时/取消不该把前面几轮已经提炼好的经验一起丢掉：已经拿到候选之后出错，
      // 按「已有候选落盘」处理，并把中断如实标出来。
      //
      // 第 39 轮补充：**单次 LLM 调用超时**（lib/llm.js 抛的 'ace: LLM 调用超时…'）在第 1 轮
      // 也不上抛 —— provider 静默（实测 step/start→assistant/attempt 隔 533 秒）是常态而非异常，
      // 「一次失败即整体失败」只会让整段复盘崩掉、把同一份手册再赌一次。沿用「合并失败只 warn、
      // 跳过继续」的既有风格。**只吞超时标记**：普通错误（解析失败、路由失败等）第 1 轮仍原样
      // 上抛，tests/reflect.test.mjs:71-76 钉住的语义不变。
      const message = (error && error.message) || error;
      if (collected.length || isTimeoutError(error)) {
        logInfo(logger, 'dsh-ace: 多轮复盘第 ' + round + ' 轮中断（' + message + '），按已提炼的 ' + collected.length + ' 条候选落盘');
        return { candidates: collected, rounds: round - 1, converged: false, aborted: true };
      }
      throw error;
    }
    rounds = round;
    const got = Array.isArray(batch) ? batch : [];
    if (!got.length) {
      logInfo(logger, 'dsh-ace: 多轮复盘第 ' + round + ' 轮无新增候选，判定收敛（已提炼 ' + collected.length + ' 条）');
      return { candidates: collected, rounds, converged: true, aborted: false };
    }
    collected.push(...got);
    logInfo(logger, 'dsh-ace: 多轮复盘第 ' + round + ' 轮产出 ' + got.length + ' 条候选（累计 ' + collected.length + ' 条）');
  }
  return { candidates: collected, rounds, converged: false, aborted: false };
}
