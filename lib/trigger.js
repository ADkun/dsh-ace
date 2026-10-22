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
