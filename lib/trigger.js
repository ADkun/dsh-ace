// dsh-ace 自动复盘触发逻辑（纯函数，可独立测试）。
//
// 从 index.js 的命令式逻辑里提成纯函数：判定是否应该触发自动复盘、
// 判定是否主代理、判定工具是否 mutating。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - agent.session.header.origin：~\dsh-session\lib\types\types.d.ts:82（origin?: 'subagent'）
// - agent.session.header.delegationDepth：~\dsh-session\lib\types\types.d.ts:88
// - agent/turn-stopping payload.turn：~\dsh-agent\lib\types\runtime-types.d.ts:387-391（turn: number）
// - tools/result exec.name / exec.agent：~\dsh-tools\lib\types\index.d.ts:223,229

/**
 * 安全写一条 info / warn（H2：logger 形状兜底）。
 *
 * 为什么不能继续用 `logger?.info?.(…)`：可选链只挡得住 null / undefined 两个值。
 * 传 `{ info: 5 }`（宿主配置写错、测试里塞了个假对象、插件之间互相转发 logger）时
 * `logger?.info?.(…)` 会当成函数调用直接抛 `TypeError: logger?.info is not a function`——
 * 而这几行日志全在**竞态回滚路径**上：日志本身炸掉会把「额度还没还回去」变成「整个空闲边沿抛异常」，
 * 额度反而永久丢失。所以改成 typeof 判定：日志写不出来是小事，绝不能让它打断记账。
 *
 * @param {object} logger - 任意形状（ctx.logger / 测试假对象 / undefined）
 * @param {string} message - 日志正文
 */
export function logInfo(logger, message) {
  // typeof 判定之外再包一层 try：logger 可能是个带**会抛错的 getter** 的对象（插件之间转发 logger、
  // 代理对象、被宿主回收的 ctx），连读属性都会炸。这些日志全在竞态回滚路径上，宁可写不出来，
  // 也绝不能让「记一条日志」把「额度还没还回去」变成「整个空闲边沿抛异常」。
  try {
    if (logger && typeof logger.info === 'function') logger.info(message);
  } catch {
    // 刻意吞掉：日志失败不影响记账与回滚语义。
  }
}

/** 见 logInfo：warn 通道同理。 */
export function logWarn(logger, message) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch {
    // 刻意吞掉：见 logInfo。
  }
}

/**
 * 把任意输入钳成一个「非负计数」（H1）。
 *
 * 为什么必须钳：mutating 计数是**额度**语义（下一轮凭它判定该不该复盘）。生产路径只会 ++，
 * 但作为 API 契约，`Number(x) || 0` 会把负数原样接受下来，日志里就出现「累计 -3 次 mutating 调用」，
 * 而且负数会把状态里的累计值往回拽、让阈值判定永久失效。非有限数（NaN / Infinity / undefined）同样按 0。
 *
 * @param {unknown} value
 * @returns {number} >= 0 的有限数
 */
export function clampMutCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
 * 判定一个工具名是否属于 mutating 工具。
 * @param {string} toolName - exec.name（tools/result 事件里的工具名）
 * @returns {boolean}
 */
export function isMutatingTool(toolName) {
  return MUTATING_TOOLS.has(String(toolName || ''));
}

/**
 * 把一个数字型配置项解析成有限数：**只有值缺失或不是有限数时**才回落到默认值。
 *
 * 为什么不能写 `Number(x) || fallback`（第 35 轮修）：`||` 会把**显式传的 0**也兜成默认值。
 * 而设置页这两个字段的 min 就是 0（lib/index.js:1242-1243 的 bounds 都是 `[0, 1000]`），
 * 文案还明说「0 表示每次都触发」「0 表示不冷却」（client.js:63 / client.js:65）——
 * 用 `||` 时用户填 0 实际拿到 2 / 1，承诺与行为不符。
 *
 * 取值取舍（undefined / null / 空串 / 负数），这一条就是契约：
 * - `undefined` 与「键不存在」→ 回落默认值，这是「没配」的本义；
 * - `null`、空串、纯空白串 → **同样按「没配」回落默认值**。理由：`Number(null)` 与 `Number('')`
 *   都等于 0，若照收就会把「设置页把输入框清空」「配置文件里留了个空值」读成「用户要求 0」——
 *   cooldown 0 = 每回合都复盘、threshold 0 = 空回合也复盘，等于把一个**没填**读成**最激进的配置**，
 *   代价是整晚白跑模型调用。要 0 就显式写 0（数字 0 与字符串 `'0'` 都算显式）。
 * - 数字字符串（表单输入框给的就是字符串，如 `'3'`）照常按数字收，`Number` 的既有行为不变；
 * - **负数不夹到 0**：设置页把范围限死在 0–1000，负数只可能来自手改配置文件；而夹到 0 会在
 *   `lastRecapTurn > currentTurn` 的反常状态下改变行为（`-3 < 0` 会挡下，`-3 < -5` 不会），
 *   保持既有语义（负 cooldown / 负 threshold 等价「不冷却」/「恒过」）改动面最小。
 *
 * @param {unknown} value - 配置里的原始值
 * @param {number} fallback - 值缺失 / 非有限数时的默认值
 * @returns {number} 有限数
 */
function numberOrDefault(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  // 0 是合法值（「每次都触发」），只有缺失 / 非有限数才回落默认 1 —— 见 numberOrDefault。
  const threshold = numberOrDefault(config.autoRecapThreshold, 1);
  if (mutCount < threshold) return false;
  const currentTurn = Number(state?.currentTurn) || 0;
  const lastRecapTurn = Number(state?.lastRecapTurn) || 0;
  // 0 是合法值（「不冷却」），只有缺失 / 非有限数才回落默认 2 —— 见 numberOrDefault。
  const cooldown = numberOrDefault(config.autoRecapCooldownTurns, 2);
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
 *
 * pendingSeq 是「待办代次」：每挂一份新待办就 +1，并写进那份待办（pending.seq）。
 * 所有权判定靠它而不是靠「state.pending 是不是同一个对象」——因为待办可能在两次 await
 * 之间被**另一个空闲边沿取走**（此时 state.pending 又变回 null），只比对象身份会把
 * 迟到的回滚当成「仍归我」而错误接受。详见 ownsPending。
 *
 * 第 33 轮：这里不再有 lastOutcome —— 回合成败判定（三档信号）整层删除，
 * 手册条目不再按「本回合成功/失败」计分，只按 hits 计使用频次。
 *
 * @returns {{mutCount:number,lastRecapTurn:number,currentTurn:number,pending:object|null,pendingSeq:number}}
 */
export function createRecapState() {
  return { mutCount: 0, lastRecapTurn: 0, currentTurn: 0, pending: null, pendingSeq: 0 };
}

/**
 * 记一次回合结束：更新回合号与 mutating 计数，按配置判定该不该挂待办。
 *
 * 命中触发条件时把复盘请求挂成待办（记录本回合号与本回合累计 mutating 次数，
 * 以及**改之前的** lastRecapTurn），并清零计数、记下 lastRecapTurn —— 真正的执行留到空闲边沿。
 * 待办里留 prevLastRecapTurn 是为了让「没材料、跳过」能把这笔账原样还回去（abandonPendingRecap）。
 * 同时给待办打上代次 seq（= state.pendingSeq），供回滚时判定「这份待办是否仍归我」。
 *
 * 队列里可能还压着一份**没执行过**的待办：上一回合挂了待办、空闲边沿撞忙把它放回队列、
 * 冷却又还没到，于是本回合触发时它会撞上这份旧的。旧实现直接覆盖，把那一整轮的 mutating
 * 经验静默丢掉（日志里一个字都没有）。所以这里改成「合并」而不是「覆盖」，不变量：
 *   1. 不许丢经验：新待办 mutCount = 旧待办 mutCount + 本回合计数（两笔都进，谁都不覆盖谁）。
 *   2. 冷却语义：新待办 prevLastRecapTurn 取**旧待办的** prevLastRecapTurn，也就是最老那一笔的
 *      原值。推导：lastRecapTurn 的含义是「上一次从哪一回合起算冷却」，每挂一次待办就把它推进到
 *      该回合；现在回合 N（旧）和回合 M（本回合）的活合成一笔、都还没执行，一旦这笔被放弃，
 *      就等于这两次推进都不该发生，必须还回到**最早那次推进之前**的值。若还回到旧待办那一轮 N，
 *      回合 N 到 M 之间的冷却额度就被白白吃掉了（那几回合什么都没复盘）。
 *   3. attempts 语义：新待办是**新的一笔**，attempts 从 0 重新计——旧待办被撞忙浪费掉的那次
 *      尝试不该算到新待办头上；但这次丢弃必须留痕（下面那条 info 日志）。
 *   4. 旧待办对象从此不可能再被结算：代次已经 +1 顶替，ownsPending 会拒掉迟到的
 *      abandon / restore / requeue，且一个字段都不动（tests/trigger.test.mjs 有用例钉住）。
 *      这里的「一个字段都不动」是**必须的**，不能拿第 7 轮的 F1 过继去改：它的计数此刻已经在
 *      新待办的 mutCount 里了（下面会把它记进 ABSORBED_PENDINGS），再过继一遍就是同一批计数算两遍。
 *
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} params - { turn, config, logger }（logger 可选，只为覆盖合并留痕）
 *   第 33 轮起不再有 outcome 参数：回合成败判定已整层删除。
 * @returns {{trigger:boolean, pending:object|null, mutCount:number, currentTurn:number}}
 */
export function recordTurnEnd(state, { turn, config, logger } = {}) {
  const st = state || createRecapState();
  const currentTurn = Number(turn) || 0;
  st.currentTurn = currentTurn;
  const should = shouldTriggerAutoRecap({ mutCount: st.mutCount, lastRecapTurn: st.lastRecapTurn, currentTurn }, config);
  if (!should) return { trigger: false, pending: null, mutCount: st.mutCount, currentTurn };
  // 队列里那份还没执行的待办（可能是旧形状：没有 seq / 没有 prevLastRecapTurn，见下面的兜底）。
  const queued = st.pending || null;
  // 不变量 1：两笔计数相加，不是「新的覆盖旧的」也不是「旧的覆盖新的」。
  // H1：两侧都过 clampMutCount。生产路径铸出的计数恒 ≥ 0，但 API 契约上 `Number(x) || 0`
  // 会原样收下负数（日志里就会出现「累计 -3 次 mutating 调用」，还会把累计值往回拽、让阈值判定永久失效）。
  const mutCount = clampMutCount(queued ? queued.mutCount : 0) + clampMutCount(st.mutCount);
  // 顺序要紧：prevLastRecapTurn 必须在下面那行改写 st.lastRecapTurn **之前**读出来。
  // 有旧待办时取它的 prevLastRecapTurn（不变量 2）；旧形状没有这个字段时才退回 st.lastRecapTurn
  // ——那等价于旧行为（还回到旧待办那一轮），只是旧形状本来也还不出更早的值。
  const queuedPrev = queued ? Number(queued.prevLastRecapTurn) : NaN;
  const prevLastRecapTurn = Number.isFinite(queuedPrev) ? queuedPrev : st.lastRecapTurn;
  // 代次 +1：这份待办从此带着「我是第几代」的身份，回滚时用它判断是否仍归自己
  // （state.pending 被另一个空闲边沿取走后会变回 null，只比对象身份判不出来）。
  st.pendingSeq = (Number(st.pendingSeq) || 0) + 1;
  // 不变量 3：attempts 归零——旧待办被撞忙浪费的尝试不计入这笔新的。
  st.pending = { turn: currentTurn, mutCount, attempts: 0, prevLastRecapTurn, seq: st.pendingSeq };
  st.lastRecapTurn = currentTurn;
  st.mutCount = 0;
  // 不变量 3 的后半句：丢弃旧待办这件事必须留痕，否则日志里看不出「回合 N 的经验去哪了」。
  if (queued) {
    // 把被并掉的旧待办记进「已被吸收」账本（F1 不变量 2）：它的计数已经在这里进了新待办，
    // 所以迟到的 abandon / restore / requeue 绝不能再去「过继」一遍，否则额度翻倍。
    ABSORBED_PENDINGS.add(queued);
    logInfo(
      logger,
      'dsh-ace: 回合 ' + queued.turn + ' 的待办还没执行，已合并进回合 ' + currentTurn +
        ' 的待办（累计 ' + mutCount + ' 次 mutating 调用）'
    );
  }
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
 * 已经**结算**过的待办（按对象身份记账）。
 *
 * 两条回滚路径（abandonPendingRecap / restorePendingMutCount）共用同一本账：同一份待办被任一路径
 * 结算过之后，另一条路径再结算一律拒绝——否则同一份待办交叉调用两条路径会把同一批 mutating 计数
 * 还两遍（实测 3 → 6 → 9），凭空多出经验额度。改动前这本账只给 abandon 用，两条路径因此不对称。
 *
 * requeuePendingRecap **不许**把待办记进来：放回队列是「还没结算，等下一次空闲边沿再试」，
 * 记进来会让重试路径被误拒。
 */
const SETTLED_PENDINGS = new WeakSet();

/**
 * 已经被 recordTurnEnd **合并吸收**掉的待办（按对象身份记账）——F1 的判别器。
 *
 * 为什么要跟 SETTLED_PENDINGS 分开两本账：这两件事的后果完全不同。
 * - 记进 SETTLED_PENDINGS 的意思是「它的额度已经还回状态了」，再来一次就是重复计入；
 * - 记进这里的意思是「它的额度已经**并进更新的待办**了」，它的计数此刻正躺在 st.pending.mutCount
 *   （或已被下一个空闲边沿取走的那份里）。所以迟到的 abandon / restore / requeue 对它必须
 *   **一个字段都不动**——要是也走「过继」，同一批计数就会既在新待办里、又被加一遍，额度凭空翻倍。
 *
 * 只由 recordTurnEnd 的合并分支写入，别处一律不写。
 */
const ABSORBED_PENDINGS = new WeakSet();

/**
 * 已经在「不归我」判定里**过继过一次**的待办（按对象身份记账）——F1 的幂等护栏。
 *
 * 为什么需要单独一本：一份在飞的旧待办可能被拒两次（比如 skipped 分支拒绝后，重试路径又拒绝，
 * 或测试里连调三条路径）。过继是「把 K 次计数搬过去」，搬两次就变 2K。所以第一次过继时记进来，
 * 之后同一份对象再来一律只写 warn、不再搬计数。
 */
const ADOPTED_PENDINGS = new WeakSet();

/**
 * 判定「这份待办是否仍归本次调用所有」（内部私有：abandonPendingRecap 与
 * restorePendingMutCount 共用，避免两处判定漂移）。
 *
 * 为什么不能只比 state.pending：
 * - 调用点与 takePendingRecap 之间隔着两次 await（`await agent.whenIdle()` 与
 *   `await runRecap()`）。这段窗口里宿主完全可能结束下一轮并挂上**新的**待办——
 *   只比对象身份能挡住这一种；
 * - 但新待办也可能被**另一个空闲边沿取走**（state.pending 又变回 null），此时
 *   「state.pending && state.pending !== pending」为假，迟到的回滚会被错误接受，
 *   把旧回合的 mutating 计数加回来、还把 lastRecapTurn 从新回合倒退。
 * 所以改用代次比对：recordTurnEnd 每挂一份待办就让 state.pendingSeq +1 并写进
 * pending.seq，只有 seq 相等才说明「队列里最新那一代就是我这代」。
 * 没有 seq 的旧形状待办（测试里手工构造的 {turn, mutCount}）退回旧的「对象身份」兜底。
 *
 * @param {object} st - 复盘状态
 * @param {object} pending - 待办
 * @returns {boolean}
 */
function ownsPending(st, pending) {
  if (pending.seq === undefined || pending.seq === null) {
    // 旧形状兜底要两档：
    // - 代次已经前进过（pendingSeq > 0）说明之后一定挂过更新的待办，这份无 seq 的待办必然过期
    //   ——即使队列此刻是空的（那份新待办已被另一个空闲边沿取走）也不认，否则迟到的旧回滚会把
    //   旧回合的计数还回来、把 lastRecapTurn 倒退；
    // - pendingSeq 仍是 0（全新状态、还没挂过任何带 seq 的待办）才退回旧的「对象身份」判定：
    //   队列里压着另一个对象就拒绝。测试里手工构造 {turn, mutCount} 的用例走的正是这一档。
    // 生产路径 recordTurnEnd 必写 seq，这一档只由手工构造命中。
    if (Number(st.pendingSeq) > 0) return false;
    return !(st.pending && st.pending !== pending);
  }
  return Number(pending.seq) === Number(st.pendingSeq);
}

/**
 * 取两个「冷却基准回合」里更早的那个（F1 过继冷却用）。
 * 非有限值按「没有这一笔」处理，两笔都无效时退回 0（与 abandonPendingRecap 的兜底一致）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
function earlierTurn(a, b) {
  const x = Number(a);
  const y = Number(b);
  const okX = Number.isFinite(x);
  const okY = Number.isFinite(y);
  if (okX && okY) return Math.min(x, y);
  if (okX) return x;
  if (okY) return y;
  return 0;
}

/**
 * 把「在飞的旧待办」记的 mutating 计数**过继**给当前状态（缺陷 F1 的核心修法）。
 *
 * 缺陷现场（真实可达）：回合 5 干了 3 次活挂上 p5{mutCount:3, seq:1}，空闲边沿 takePendingRecap
 * 把 p5 摘走（st.pending 变 null），随后停在 `await agent.whenIdle()` / `await runRecap()` 的
 * 秒级窗口里；这期间宿主结束回合 6、7 并干了 2 次活，recordTurnEnd 因为看不到在飞的 p5，
 * 挂出 p7{mutCount:2, prevLastRecapTurn:5, seq:2}。等 p5 的 runRecap 返回 {skipped:true} 或抛
 * 「already has active work」，回滚路径被 ownsPending 按代次判「不归我」——改动前一个字段都不动，
 * 于是 p5 那 3 次计数既没进 p7、也没还回 st.mutCount，**永久蒸发**。
 * （边界要说清：p7 的轨迹取自 agent.session.deriveMessages() 尾部最近 60 条，回合 5 的**材料**
 *   通常仍会被 p7 那次复盘看到；真正蒸发的是**额度记账**，以及 busy 变体下「这一轮确实没跑成」
 *   这个事实——见 lib/recap.js 的 rejected 分支。别夸大，也别缩小。）
 *
 * 为什么必须过继而不是「拒绝就算了」：mutating 计数是**额度**语义，下一轮凭它判定该不该复盘。
 * 丢掉 3 次额度会让后面明明干了活的回合被阈值挡下，经验被顺延甚至吞掉——正是第 5/6 轮反复修的
 * 同一类「静默丢经验」。
 *
 * 三种情形（顺序要紧，前两种一律不动任何字段）：
 * 1. 已被 recordTurnEnd 合并吸收（ABSORBED_PENDINGS）：它的计数此刻正躺在更新的待办里，
 *    再过继就是同一批计数算两遍，额度凭空翻倍。只写 warn，一个字段都不动。
 * 2. 已经被过继过一次（ADOPTED_PENDINGS）：同一份待办可能被拒两次（skipped 之后再走重试路径、
 *    或测试里连调三条路径），搬两次就变 2K。只写 warn，不再搬。
 * 3. 无 seq 的旧形状：无法判定它属于哪一代、生产路径也铸不出来（recordTurnEnd 必写 seq），
 *    过继会把测试里手工构造的 `{turn, mutCount}` 也搬进去，纯属误伤，一律不认。
 * 之后真正过继：
 * - 队列里还压着一份没被取走的更新的待办 → 计数加进它的 mutCount。abandon 这一路还要把冷却
 *   语义一并过继（prevLastRecapTurn 取两者中**更早**的）：两次推进合并且都没执行，放弃时应当
 *   还回到最早那次推进之前——理由与 recordTurnEnd 注释里的不变量 2 完全相同。
 * - 队列已空（更新的那份也被另一个空闲边沿取走）→ 计数加回 st.mutCount，但**不动 lastRecapTurn**：
 *   冷却由那份在飞待办自己的结算去回滚（它成功就保留推进、skipped 就自己退回原值）；这里再倒退
 *   一次等于同一笔冷却被退两遍，会让冷却被白白多让出去一轮。这个取舍是刻意的。
 *
 * @param {object} st - 复盘状态（原地修改）
 * @param {object} pending - 被判「不归我」的那份旧待办
 * @param {object} options - { rollbackCooldown, action, logger }
 *   rollbackCooldown:true 只给 abandonPendingRecap 用（跳过＝这次推进根本没发生）；
 *   action 是日志里的动作名（「本次跳过」/「本次失败」/「回队」），logger 可选。
 * @returns {boolean} true 表示确实把计数过继出去了；不该过继时返回 false（不抛错）
 */
function adoptOrphanPending(st, pending, { rollbackCooldown, action, logger } = {}) {
  // 队列状态描述（三种情形共用）：它同时是「为什么这次没回滚」的解释。
  const where = st.pending ? '回合 ' + (st.pending.turn ?? '?') + ' 在队列里' : '已被另一个空闲边沿取走';
  // 情形 3：无代次的旧形状待办不参与过继（见函数注释）。但仍要留一条 warn：
  // 改动前这一档本来就写 warn，静默掉会让「旧待办为什么没被认领」从日志里彻底消失。
  if (pending.seq === undefined || pending.seq === null) {
    logWarn(logger, 'dsh-ace: ' + action + '（' + where + '）；回合 ' + (pending.turn ?? '?')
      + ' 的这份待办没有代次标记（旧形状），无法判定归属，额度不过继、一个字段都不动');
    return false;
  }
  if (ABSORBED_PENDINGS.has(pending)) {
    logWarn(logger, 'dsh-ace: ' + action + '（' + where + '）；回合 ' + (pending.turn ?? '?')
      + ' 的这份待办的 ' + clampMutCount(pending.mutCount)
      + ' 次 mutating 计数已经合并进更新的待办，不再重复过继');
    return false;
  }
  if (ADOPTED_PENDINGS.has(pending)) {
    logWarn(logger, 'dsh-ace: ' + action + '（' + where + '）；回合 ' + (pending.turn ?? '?')
      + ' 的这份待办的额度已经过继过一次，不再重复过继');
    return false;
  }
  const moved = clampMutCount(pending.mutCount);
  // 顺序要紧：**先搬移、后记账**。
  // 搬移那一步可能抛错（队列里那份待办被 Object.freeze、或 mutCount 是 getter-only），而
  // ADOPTED_PENDINGS 记的是「这份待办已经过继过」。若先记账再搬，一次抛错就留下「账本说搬过了、
  // 额度一次都没搬」的状态——该待办从此被永久封账，那笔 mutating 额度永久蒸发。所以账本只在
  // 搬移**成功**之后写：抛错时账本干净，下一路径/下一次重试还能把额度搬过去。
  if (st.pending) {
    // 队列里那份更新的待办接住这笔额度。
    const before = clampMutCount(st.pending.mutCount);
    st.pending.mutCount = before + moved;
    // 搬移成功，立刻记账（同一份待办第二次被拒绝不再搬，否则额度翻倍）。放在冷却赋值之前：
    // 冷却那一步若也抛错，额度已经搬过去了，绝不能再被搬第二遍。
    ADOPTED_PENDINGS.add(pending);
    if (rollbackCooldown) {
      // 冷却只过继给**队列里**那份：它才是下一次真正要执行的那一份，把基准退到更早的那次推进之前，
      // 才不会让「两次推进都没执行」白白吃掉冷却。
      st.pending.prevLastRecapTurn = earlierTurn(st.pending.prevLastRecapTurn, pending.prevLastRecapTurn);
    }
    logWarn(logger, 'dsh-ace: ' + action + '（' + where + '）；'
      + '回合 ' + (pending.turn ?? '?') + ' 的待办已不归当前一代，把它的 ' + moved
      + ' 次 mutating 计数过继给回合 ' + (st.pending.turn ?? '?') + ' 的待办（该待办累计 '
      + st.pending.mutCount + ' 次' + (rollbackCooldown ? '，冷却基准退到回合 ' + st.pending.prevLastRecapTurn : '') + '）');
    return true;
  }
  // 队列已空：更新的那份也被另一个空闲边沿取走了，只能还回状态本身。冷却不动（见函数注释）。
  const before = clampMutCount(st.mutCount);
  st.mutCount = before + moved;
  // 同上：搬移成功之后再记账。
  ADOPTED_PENDINGS.add(pending);
  logWarn(logger, 'dsh-ace: ' + action + '（' + where + '）；'
    + '回合 ' + (pending.turn ?? '?') + ' 的待办已不归当前一代，把它的 ' + moved
    + ' 次 mutating 计数还回状态（累计 ' + st.mutCount + ' 次）；冷却不回退，交由那份在飞待办自己结算');
  return true;
}

/**
 * 真实失败时的回滚：只把这份待办的 mutating 计数还回状态，**不**回滚冷却。
 *
 * 与 abandonPendingRecap 的区别是刻意保留的：失败（LLM 调用失败、手册写入失败）
 * 说明这一轮**确实尝试过**复盘，冷却算已消耗（改动前就是这个行为，别改）；
 * 只有「没材料、跳过」才连冷却一起还回去。
 *
 * 所有权判定与 abandonPendingRecap 共用 ownsPending：这段 await 窗口里若已经挂上
 * 更新的待办（或那份新待办已被别的空闲边沿取走），本次调用**不**把额度还回状态——否则会把旧回合的
 * 计数重复计入，让下一轮凭虚高的 mutCount 误触发。但额度本身也不许蒸发（缺陷 F1）：这份在飞的旧待办
 * 若没被 recordTurnEnd 合并吸收，就把它的计数**过继**给当前状态（见 adoptOrphanPending）。
 *
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} pending - takePendingRecap 取出的待办（读 mutCount）
 * @param {object} [logger] - 可选；拒绝回滚时写一条 warn 说明原因
 * @returns {boolean} true 表示确实把计数还回去了；入参缺失、或这份待办已不归自己时返回 false，不抛错
 */
export function restorePendingMutCount(state, pending, logger) {
  const st = state;
  if (!st || !pending || typeof pending !== 'object') return false;
  if (SETTLED_PENDINGS.has(pending)) {
    logWarn(logger, 'dsh-ace: 这份待办已经结算过了（mutating 计数已还过一次），本次失败不再重复累加，也不改冷却');
    return false;
  }
  if (!ownsPending(st, pending)) {
    // F1：不归我 ≠ 额度作废。若这份在飞的旧待办没被 recordTurnEnd 合并吸收，就把它的计数过继给
    // 当前状态（详见 adoptOrphanPending）。返回值仍是 false ——「本次回滚没有作用在这份待办上」这个
    // 事实不变，调用点据此不会谎报「已还回」。冷却不过继（失败＝确实尝试过，冷却算已消耗，刻意语义）。
    adoptOrphanPending(st, pending, {
      rollbackCooldown: false,
      // 动作名沿用改动前的开头，日志仍以「本次失败未回滚 mutating 计数，因为有更新的待办」起头，
      // 好让既有的文案断言（含 '更新的待办'）继续成立。
      action: '本次失败未回滚 mutating 计数，因为有更新的待办',
      logger,
    });
    return false;
  }
  SETTLED_PENDINGS.add(pending);
  if (st.pending === pending) st.pending = null;
  // 与 recordTurnEnd / adoptOrphanPending 同口径：两侧都过 clampMutCount。
  // 改动前这里写的是 Number(...) 当夹取——它只挡 NaN/Infinity，**负数有限值原样收下**，
  // 于是 pending.mutCount = -4 会把 st.mutCount 从 10 拽回 6：一次「回滚」反而把额度吃掉。
  st.mutCount = clampMutCount(st.mutCount) + clampMutCount(pending.mutCount);
  return true;
}

/**
 * 放弃这次待办，并把挂待办时吃掉的额度**原样还回去**。
 *
 * 为什么需要回滚：轨迹为空时 runRecap 不调 LLM 就返回（`{skipped:true}`）。那是「这一轮没有
 * 材料」，不是「这一轮复盘过了」——可 recordTurnEnd 已经在挂待办时写了 lastRecapTurn 并清零
 * mutCount，takePendingRecap 也已经把待办摘走。不还回去的话，这次「没喂成料」会白白吃掉一个
 * 冷却窗口与这一轮的 mutating 计数：下一轮明明干了活，却被冷却挡下，经验被顺延甚至吞掉。
 *
 * 两条护栏（对的是真实重入/竞态，不是防御性洁癖）：
 * - **只回滚自己取出的那一份**：调用点（lib/recap.js 的 skipped 分支）与 takePendingRecap 之间
 *   隔着两次 await（`await agent.whenIdle()` 与 `await runRecap()`）。这段窗口里宿主完全可能
 *   结束下一轮并挂上**新的**待办。此时若照旧 `state.pending = null`，就会把新待办连同它记的
 *   mutating 计数一起吞掉，还会把 lastRecapTurn 从新回合**倒退**回旧值——静默丢经验 + 冷却倒退。
 *   所以只要这份待办已经不归自己（代次不是最新一代，见 ownsPending——包括「更新的待办已被
 *   另一个空闲边沿取走、state.pending 又变回 null」这种只比对象身份判不出来的情形），
 *   就拒绝回滚：不改 lastRecapTurn、不把额度还回状态。
 *   但拒绝 ≠ 作废（缺陷 F1）：这份在飞的旧待办若没被 recordTurnEnd 合并吸收，它的 mutating 计数
 *   会**过继**给当前状态（队列里有更新的待办就加进它的 mutCount 并把冷却基准退到更早那次推进之前；
 *   队列已空就还回 st.mutCount）。详见 adoptOrphanPending。
 * - **幂等**：同一个 pending 第二次调用不再累加 mutCount、不再改 lastRecapTurn（否则计数会被
 *   重复还回去，凭空多出经验额度），返回 false。
 *
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} pending - takePendingRecap 取出的待办（读 mutCount 与 prevLastRecapTurn）
 * @param {object} [logger] - 可选；拒绝回滚时写一条 warn 说明原因（不刷屏，每次拒绝一条）
 * @returns {boolean} true 表示确实回滚了；入参缺失、已有更新的待办、重复放弃时返回 false，不抛错
 */
export function abandonPendingRecap(state, pending, logger) {
  const st = state;
  if (!st || !pending || typeof pending !== 'object') return false;
  if (SETTLED_PENDINGS.has(pending)) {
    logWarn(logger, 'dsh-ace: 这份待办已经结算过了，重复放弃不再累加 mutating 计数、也不再改冷却');
    return false;
  }
  if (!ownsPending(st, pending)) {
    // F1：过继而不是作废（详见 adoptOrphanPending）。这一路连**冷却**一起过继——跳过等于这次推进
    // 根本没发生，两次推进合并且都没执行时应当退回到最早那次推进之前。
    adoptOrphanPending(st, pending, {
      rollbackCooldown: true,
      action: '本次跳过未回滚，因为有更新的待办',
      logger,
    });
    return false;
  }
  SETTLED_PENDINGS.add(pending);
  if (st.pending === pending) st.pending = null;
  // 同 restorePendingMutCount：两侧都过 clampMutCount，负数有限值不许把状态里的计数往回拽。
  st.mutCount = clampMutCount(st.mutCount) + clampMutCount(pending.mutCount);
  const prev = Number(pending.prevLastRecapTurn);
  st.lastRecapTurn = Number.isFinite(prev) ? prev : 0;
  return true;
}

/**
 * 把待办放回队列（撞上「already has active work」时用）。
 *
 * **放回不是结算**：这里既不把待办记进 SETTLED_PENDINGS，也不改它的 attempts/seq，
 * 下一个空闲边沿取到的还是同一个对象、同一代次，所以重试路径不会被所有权判定误拒。
 *
 * 不归自己时的额度归属（缺陷 F1）：这份旧待办没被放回队列，但它的 mutating 计数不许跟着蒸发——
 * 交给 adoptOrphanPending 过继给当前状态。冷却不过继：这一路既没放弃也没回滚，冷却归属留给
 * 队列里那份或那份在飞待办自己结算。返回值仍是 rejected:true（队列里那份确实不是它的），
 * 但必须写一条 warn 说清额度去了哪里，不许像改动前那样连「丢了什么」都不说。
 *
 * 为什么必须做所有权判定（而不是无条件 `st.pending = pending`）：调用点（lib/recap.js 的忙碌分支）
 * 与 takePendingRecap 之间隔着 `await agent.whenIdle()` 与 `await runRecap()` 两次 await。
 * 这段窗口里宿主完全可能结束下一轮并挂上**更新的**待办。此时无条件覆盖会把那份新待办静默丢弃：
 * 旧待办之后无论走 abandonPendingRecap 还是 restorePendingMutCount 都会被 ownsPending 判「不归我」
 * 而拒绝，两份待办的 mutating 额度**一起蒸发**，而新待办那一轮已经把 lastRecapTurn 推进过
 * （冷却白吃）。耗尽分支同理——清空队列会把队列里那份更新的待办抹掉。
 * 所以不归自己时**队列里的字段一个都不动**（那份更新的待办既不许被覆盖、也不许被清空），并在返回值里带
 * rejected:true + 一条 warn，绝不静默吞掉。注意「一个字段都不动」只指队列：这份在飞旧待办的 mutCount
 * 会经 adoptOrphanPending 过继给当前状态（队列里有更新的待办就并进它，队列已空就还回 st.mutCount），
 * 否则旧回合的额度就跟着蒸发了。
 *
 * @param {object} state - 复盘状态（原地修改）
 * @param {object} pending - 待办
 * @param {number} maxAttempts - 最多尝试次数（含首次）
 * @param {object} [logger] - 可选；拒绝放回时写一条 warn 说明原因（不刷屏，每次拒绝一条）
 * @returns {{exhausted:boolean, pending:object|null, rejected:boolean}} rejected:true 表示「这份待办
 *   已不归自己，队列一个字段都没动」；此时 pending 恒为 null，exhausted 照实反映它自己的尝试次数
 */
export function requeuePendingRecap(state, pending, maxAttempts = MAX_RECAP_ATTEMPTS, logger) {
  const st = state;
  const limit = Number(maxAttempts) || MAX_RECAP_ATTEMPTS;
  const attempts = Number(pending && pending.attempts) || 0;
  if (!st || !pending || typeof pending !== 'object') {
    return { exhausted: false, pending: null, rejected: true };
  }
  if (!ownsPending(st, pending)) {
    // F1：这份旧待办没能回队，但它的额度不许跟着蒸发——过继给当前状态（详见 adoptOrphanPending）。
    // 冷却不过继：这一路不放弃、也不回滚，冷却的归属交给队列里那份或那份在飞待办自己结算。
    // 返回 rejected:true 不变（队列里那份不是它的），但日志必须说清额度去了哪里，不许静默。
    adoptOrphanPending(st, pending, {
      rollbackCooldown: false,
      action: '旧待办未放回队列，因为已有更新的待办',
      logger,
    });
    return { exhausted: attempts >= limit, pending: null, rejected: true };
  }
  if (attempts >= limit) {
    st.pending = null;
    return { exhausted: true, pending: null, rejected: false };
  }
  st.pending = pending;
  return { exhausted: false, pending, rejected: false };
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
