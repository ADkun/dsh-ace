// dsh-ace 自动复盘触发逻辑（纯函数，可独立测试）。
//
// 从 index.js 的命令式逻辑里提成纯函数：判定是否应该触发自动复盘、
// 判定是否主代理、判定是否有在跑子代理、判定工具是否 mutating。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - agent.session.header.origin：~\dsh-session\lib\types\types.d.ts:82（origin?: 'subagent'）
// - agent.session.header.delegationDepth：~\dsh-session\lib\types\types.d.ts:88
// - AgentRegistry.list()：~\dsh-agent\lib\types\index.d.ts:357（all live agents）
// - agent/turn-stopping payload.turn：~\dsh-agent\lib\types\runtime-types.d.ts:387-391（turn: number）
// - tools/result exec.name / exec.agent：~\dsh-tools\lib\types\index.d.ts:223,229

/**
 * Mutating 工具名集合：产生副作用（写文件 / 跑命令 / 执行代码）的工具。
 * 只统计这些工具的调用次数作为「实质工作」判据。
 * run_code 在 PTC 模式下是模型直接调用的入口，内部可能包含 write/edit/pwsh，视为 mutating。
 */
export const MUTATING_TOOLS = new Set([
  'write', 'edit', 'pwsh', 'bash', 'run_code', 'present',
]);

/**
 * 判定一个 agent 是否为主代理（非子代理）。
 * 方案：agent.session.header.origin !== 'subagent' → 主代理。
 * 证据：SessionHeader.origin 字段，~\dsh-session\lib\types\types.d.ts:82；
 *       delegationDepth 字段，~\dsh-session\lib\types\types.d.ts:88（absent=0 表示顶层）。
 * Agent 接口本身无 parent/root 访问器（~\dsh-agent\lib\types\runtime-types.d.ts:11-14 只有 id），
 * SessionStartSource 也只有 'startup'|'resume'|'clear'|'compact'（L105），无 parent 字段。
 * 最终选择：用 session.header.origin 判定最干净——subagent 的 origin === 'subagent'。
 *
 * @param {object} agent - DSH Agent 对象
 * @returns {boolean} true 如果是主代理
 */
export function isMainAgent(agent) {
  if (!agent || !agent.session || !agent.session.header) return true;
  return agent.session.header.origin !== 'subagent';
}

/**
 * 判定当前是否有在跑的子代理。
 * 方案：从 AgentRegistry.list() 拿到所有 live agent，排除当前 agent 自身后看是否还有其他。
 * 证据：AgentRegistry.list()，~\dsh-agent\lib\types\index.d.ts:357（returns Agent[]）。
 * 如果排除自身后列表为空，说明没有在跑的子代理。
 *
 * @param {Array} allAgents - ctx.agents.list() 的结果
 * @param {object} agent - 当前 turn-stopping 的 agent
 * @returns {boolean} true 如果没有其他在跑的 agent
 */
export function hasNoRunningSubagents(allAgents, agent) {
  if (!Array.isArray(allAgents)) return true;
  return allAgents.filter((a) => a && a.id !== agent?.id).length === 0;
}

/**
 * 判定一个工具名是否属于 mutating 工具。
 * @param {string} toolName - exec.name（tools/result 事件里的工具名）
 * @returns {boolean}
 */
export function isMutatingTool(toolName) {
  return MUTATING_TOOLS.has(String(toolName || ''));
}

/**
 * 自动复盘触发判定的纯函数。
 *
 * @param {object} state - { mutCount: number, lastRecapTurn: number, currentTurn: number }
 * @param {object} config - { autoRecap: boolean, autoRecapThreshold: number, autoRecapCooldownTurns: number }
 * @returns {boolean} true 如果应该触发自动复盘
 */
export function shouldTriggerAutoRecap(state, config) {
  if (!config || config.autoRecap === false) return false;
  const mutCount = Number(state?.mutCount) || 0;
  const threshold = Number(config.autoRecapThreshold) || 1;
  if (mutCount < threshold) return false;
  const currentTurn = Number(state?.currentTurn) || 0;
  const lastRecapTurn = Number(state?.lastRecapTurn) || 0;
  const cooldown = Number(config.autoRecapCooldownTurns) || 2;
  if (currentTurn - lastRecapTurn < cooldown) return false;
  return true;
}

// —— 自动复盘调度用的纯状态机（回合内记账 → 空闲边沿执行）——
//
// 为什么要抽成纯函数：lib/index.js 依赖宿主包，node --test 里加载不了；
// 而「记账 / 判定 / 取待办 / 竞态重试计数」这四件事是纯数据操作，抽出后可直接断言。
//
// 时机依据（DSH checkout：~\@deepseek-ai\dsh-agent-loop\lib\index.js）：
// - :823 runMaintenance 在 phase.kind !== 'idle' 时同步抛「already has active work」；
// - :939 turn() 断言 phase 是 running，而 turn-stopping 在 turn() 内部派发
//   → 回合内不能跑维护任务，只能记账，等 idle 边沿（:887-901 → :794-799 emit agent/status）。

/** 竞态退避的上限：一次待办最多尝试多少次（含首次），超过才放弃。 */
export const MAX_RECAP_ATTEMPTS = 3;

/**
 * 新建一个 agent 的复盘状态（纯函数）。
 * @returns {{mutCount:number,lastRecapTurn:number,currentTurn:number,pending:object|null}}
 */
export function createRecapState() {
  return { mutCount: 0, lastRecapTurn: 0, currentTurn: 0, pending: null };
}

/**
 * 记一次回合结束：更新回合号与 mutating 计数，按配置判定该不该挂待办。
 *
 * 命中触发条件时把复盘请求挂成待办（记录本回合号与本回合累计 mutating 次数），
 * 并清零计数、记下 lastRecapTurn —— 真正的执行留到空闲边沿。
 *
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} params - { turn, config }
 * @returns {{trigger:boolean, pending:object|null, mutCount:number, currentTurn:number}}
 */
export function recordTurnEnd(state, { turn, config } = {}) {
  const st = state || createRecapState();
  const currentTurn = Number(turn) || 0;
  st.currentTurn = currentTurn;
  const should = shouldTriggerAutoRecap({ mutCount: st.mutCount, lastRecapTurn: st.lastRecapTurn, currentTurn }, config);
  if (!should) return { trigger: false, pending: null, mutCount: st.mutCount, currentTurn };
  const mutCount = st.mutCount;
  st.pending = { turn: currentTurn, mutCount, attempts: 0 };
  st.lastRecapTurn = currentTurn;
  st.mutCount = 0;
  return { trigger: true, pending: st.pending, mutCount, currentTurn };
}

/**
 * 取出待办（空闲边沿用）：取出即从队列里摘掉，并记一次尝试。
 * @param {object} state - 复盘状态（原地修改）
 * @returns {object|null} 待办；没有待办时返回 null
 */
export function takePendingRecap(state) {
  const st = state;
  if (!st || !st.pending) return null;
  const pending = st.pending;
  st.pending = null;
  pending.attempts = (Number(pending.attempts) || 0) + 1;
  return pending;
}

/**
 * 把待办放回队列（撞上「already has active work」时用）。
 * 尝试次数已达上限则放弃（返回 exhausted:true，并清空队列）。
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} pending - 待办
 * @param {number} maxAttempts - 最多尝试次数（含首次）
 * @returns {{exhausted:boolean, pending:object|null}}
 */
export function requeuePendingRecap(state, pending, maxAttempts = MAX_RECAP_ATTEMPTS) {
  const st = state;
  const limit = Number(maxAttempts) || MAX_RECAP_ATTEMPTS;
  const attempts = Number(pending && pending.attempts) || 0;
  if (attempts >= limit) {
    if (st) st.pending = null;
    return { exhausted: true, pending: null };
  }
  if (st) st.pending = pending;
  return { exhausted: false, pending };
}

/**
 * 判定一个错误是不是「宿主正忙」这种预期内竞态。
 * 宿主文案：agent "xxx" already has active work
 * （~\@deepseek-ai\dsh-agent-loop\lib\index.js:823）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isBusyError(error) {
  const message = String((error && error.message) || error || '');
  return message.includes('already has active work');
}
