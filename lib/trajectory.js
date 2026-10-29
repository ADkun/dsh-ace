// dsh-ace 自动复盘的轨迹渲染器：把宿主的模型可见历史渲染成一段给 Reflector 看的紧凑文本。
//
// 为什么要有这个文件：自动复盘原来只把「本回合有 N 次 mutating 工具调用」这句计数喂给
// Reflector，实测同一个 Reflector 收到计数时返回 candidates: []（notes 原文：「本回合轨迹只给出
// 『12 次 mutating 工具调用』这一计数，没有任务目标、工具序列或错误细节，无法据此提炼可泛化经验，
// 宁缺毋滥。」），收到真实任务的完整轨迹时返回 6 条候选。所以「喂什么」才是决定性的一环，
// 渲染逻辑单独成模块、纯函数、可独立测试（tests/trajectory.test.mjs）。
//
// 两处体量策略都是「为了不丢关键材料」而定的，不是随手取的数：
// - 总量超限时**首尾都保留**（开头 min(maxHeadChars, maxChars/2)，中间省略标记，结尾吃剩下的
//   预算）。只留尾部会把开头的任务目标整段切掉——而「让 Reflector 看到任务目标」正是喂真轨迹的目的。
// - tool 结果行带上工具名（`结果(read): …`）。tool 消息自身只有 toolCallId，工具名要靠同一次渲染里
//   assistant tool-call 记下的映射反查；并行/多连调用时靠位置猜会错。
//
// 输入形状（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - Message 联合类型：~\dsh-llm\lib\types\message.d.ts:120-174
//   （role: 'system'|'developer'|'user'|'assistant'|'tool'，每条带 content: ContentBlock[]）；
//   tool 消息另带 toolCallId（:157）与 isError（:159）。
// - ContentBlock：~\dsh-llm\lib\types\types.d.ts:45-126
//   （text / reasoning / image / file / tool-call / tool-addition / tool-removal；
//    tool-call 的 arguments 是模型产出的原始 JSON 字符串，:91）。
// - 历史来源：Session.deriveMessages()，~\dsh-session\lib\index.js:1655-1684、
//   ~\dsh-session\lib\types\index.d.ts:347（每次调用返回一份新的快照，消息对象是共享且深冻结的）。
//
// 硬约束：**只 import 标准 JS，不 import 任何宿主包**——宿主包在 node --test 里加载不到
// （本仓库无 node_modules，见 AGENTS.md 红线 5）。本文件因此没有任何 import，纯函数、无副作用、不读盘。

/** 渲染默认值：既控制「取多少条历史」，也控制「每条消息里每类块留多少字」。 */
export const TRAJECTORY_DEFAULTS = {
  maxMessages: 60,
  maxChars: 12000,
  // 超限时留给「开头」的预算：任务目标就在第一条 user 消息里，硬截尾等于把最该看的材料丢掉。
  // 实际生效值取 min(maxHeadChars, floor(maxChars / 2))，保证首尾都留得下。
  maxHeadChars: 3000,
  maxTextChars: 500,
  maxArgChars: 300,
  maxToolResultChars: 400,
};

/** 首尾截断时给中间省略标记预留的字符数（够放「…（中间 N 字符已省略）」这一行）。 */
const MID_MARKER_RESERVE = 40;

/** 取一个正整数选项，非法值（非有限数 / <= 0 / 非数字）一律回退默认值。 */
function pickLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * 截断一个字符串到 max 字符，返回 { text, clipped }。
 * 非字符串一律当空串（宿主字段类型变动不许把复盘搞崩）。
 */
function clip(value, max) {
  if (typeof value !== 'string') return { text: '', clipped: false };
  if (value.length <= max) return { text: value, clipped: false };
  return { text: value.slice(0, max) + '…', clipped: true };
}

/** 中间省略标记：'
…（中间 N 字符已省略）
'。 */
function midMarker(omitted) {
  return '\n…（中间 ' + omitted + ' 字符已省略）\n';
}

/** 取开头 budget 个字符；切点落在高位代理（0xD800–0xDBFF）上就退一位，避免切开代理对。 */
function sliceHeadSafe(str, budget) {
  let n = Math.min(Math.max(0, budget), str.length);
  if (n > 0 && n < str.length) {
    const code = str.charCodeAt(n - 1);
    if (code >= 0xd800 && code <= 0xdbff) n -= 1;
  }
  return str.slice(0, n);
}

/** 取末尾 budget 个字符；切点落在低位代理（0xDC00–0xDFFF）上就前进一位，避免切开代理对。 */
function sliceTailSafe(str, budget) {
  let start = Math.max(0, str.length - budget);
  const code = str.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return str.slice(start);
}

/**
 * 把一段长文本按「首尾都保留」裁到 maxChars 以内（渲染器与 summary 组装共用）。
 *
 * 保留开头 min(maxHeadChars, floor(maxChars/2)) 个字符（任务目标在这儿）+ 一行中间省略标记
 * + 保留结尾，**最终长度恒 ≤ maxChars**。头尾放不下时退化成「开头 + 省略标记」，那里标记里的
 * 省略数也恒等于真实丢弃量；标记自己都放不下时返回空字符串，由调用方按「没材料」处理。
 *
 * @param {string} text - 已渲染好的长文本
 * @param {number} maxChars - 硬上限（正整数）
 * @param {number} [maxHeadChars] - 开头最多留多少字符（缺省 TRAJECTORY_DEFAULTS.maxHeadChars）
 * @returns {string}
 */
function clipTrajectory(text, maxChars, maxHeadChars) {
  if (text.length <= maxChars) return text;
  const headLimit = Math.max(0, Number.isFinite(maxHeadChars) ? maxHeadChars : TRAJECTORY_DEFAULTS.maxHeadChars);
  const headBudget = Math.min(headLimit, Math.floor(maxChars / 2));
  const head = sliceHeadSafe(text, headBudget);
  const tailBudget = maxChars - head.length - MID_MARKER_RESERVE;
  if (tailBudget > 0) {
    const tailText = sliceTailSafe(text, tailBudget);
    const omitted = Math.max(0, text.length - head.length - tailText.length);
    return head + midMarker(omitted) + tailText;
  }
  // 极端小的 maxChars：没有地方放尾部，退化成「开头 + 省略标记」。
  // 标记里的省略数必须**恒等于真实被丢弃的字符数**：先定最终的 head 长度，再拿它算 N
  // （反过来先算 N 再削 head，标记就会谎报丢弃量）。标记自己都放不下时返回空字符串，
  // 让调用方走「没材料」分支，而不是吐半截标记或一堆垃圾字符。
  let headLen = Math.min(head.length, Math.max(0, maxChars - MID_MARKER_RESERVE));
  let marker = midMarker(Math.max(0, text.length - headLen));
  while (headLen > 0 && headLen + marker.length > maxChars) {
    headLen -= 1;
    marker = midMarker(Math.max(0, text.length - headLen));
  }
  return headLen + marker.length <= maxChars ? sliceHeadSafe(text, headLen) + marker : '';
}

/**
 * 判断一条消息是不是**本插件自己投递的注入消息**（第 28 轮起注入是历史里的一条 user 消息）。
 *
 * 为什么要跳过滤：注入的正文就是手册里已有的经验条目。若把它当普通 user 消息喂给 Reflector，
 * 会自污染两层 —— ① 每次复盘白白多送几百到上千 token 的自产内容；② Reflector 会把
 * 「手册里已有的条目」当成「本轮用户说过的话」再提炼一遍，产出与既有条目高度相似的候选，
 * 撞进 decideCandidates 的近似重复分支：净分 > 0 时用一段被复述过的文本原地覆盖真实条目，
 * 净分 ≤ 0 时新增 + 把旧条目按 superseded 归档。
 *
 * 过滤条件**只认这两个字段**（source.kind + source.form），不是「所有非用户手打的消息都跳过」：
 * notice（source.form === 'notice'）等其它插件自产消息照旧渲染。
 *
 * 两个字符串字面量必须与 lib/inject-delivery.js 的 INJECTION_SOURCE_KIND / INJECTION_SOURCE_FORM
 * 保持一致；改动任一处要同步另一处（本文件零 import，不能 import 那两个常量）。
 *
 * @param {object} message - 一条宿主 Message
 * @returns {boolean} true = 本插件投递的注入消息，整条不渲染
 */
function isAceInjectionMessage(message) {
  const source = message && typeof message === 'object' ? message.source : null;
  if (!source || typeof source !== 'object') return false;
  // 'dsh-ace' / 'injection'：与 lib/inject-delivery.js 的 INJECTION_SOURCE_KIND / _FORM 一致。
  return source.kind === 'dsh-ace' && source.form === 'injection';
}

/** 从一条消息的 content 里挑出某一类块的占位符（image/file）。 */
function blockPlaceholder(block) {
  if (block.type === 'image') return '[图片]';
  if (block.type === 'file') return '[文件]';
  return null;
}

/**
 * 渲染一条消息，返回若干行（assistant 的 tool-call 会各自成行，因此可能多于一行）。
 * 跳过而不是抛错：消息为 null / content 不是数组 / 块不是对象 / 字段类型不对。
 *
 * @param {object} message - 一条宿主 Message
 * @param {object} limits - 已解析的体量上限
 * @param {object} state - { truncated }，原地修改
 * @param {Map<string,string>} toolNames - 本次渲染内 tool-call id → 工具名的映射
 *   （由调用方每次新建；结果行靠它把「哪条结果属于哪个工具」标出来）
 */
function renderMessage(message, limits, state, toolNames) {
  if (!message || typeof message !== 'object') return [];
  // 本插件自己投递的注入消息整条跳过（自污染防护，见上面的 isAceInjectionMessage）。
  if (isAceInjectionMessage(message)) return [];
  const role = message.role;
  // 系统提示词与工具清单对复盘没有意义，而且极长——整条跳过。
  if (role === 'system' || role === 'developer') return [];
  const blocks = message.content;
  if (!Array.isArray(blocks)) return [];
  const lines = [];

  if (role === 'user') {
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const r = clip(block.text, limits.maxTextChars);
        if (r.clipped) state.truncated = true;
        parts.push(r.text);
      } else {
        const mark = blockPlaceholder(block);
        if (mark) parts.push(mark);
      }
    }
    if (parts.length) lines.push('用户: ' + parts.join('\n'));
    return lines;
  }

  if (role === 'assistant') {
    const parts = [];
    const calls = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const r = clip(block.text, limits.maxTextChars);
        if (r.clipped) state.truncated = true;
        parts.push(r.text);
      } else if (block.type === 'tool-call') {
        const name = typeof block.name === 'string' && block.name ? block.name : '未知工具';
        // 记下 id → 工具名，供后面同一次渲染里的 tool 结果行标注「结果(工具名)」。
        const id = block.id;
        if ((typeof id === 'string' || typeof id === 'number') && String(id) !== '') {
          toolNames.set(String(id), name);
        }
        const r = clip(block.arguments, limits.maxArgChars);
        if (r.clipped) state.truncated = true;
        calls.push('  → ' + name + '(' + r.text + ')');
      }
      // reasoning / image / file / 未知块：跳过（reasoning 对复盘无用，且往往很长）。
    }
    if (parts.length) lines.push('助手: ' + parts.join('\n'));
    for (const call of calls) lines.push(call);
    return lines;
  }

  if (role === 'tool') {
    const parts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const r = clip(block.text, limits.maxToolResultChars);
        if (r.clipped) state.truncated = true;
        parts.push(r.text);
      } else {
        const mark = blockPlaceholder(block);
        if (mark) parts.push(mark);
      }
    }
    if (!parts.length) return [];
    // tool 消息自身只有 toolCallId（~\dsh-llm\lib\types\message.d.ts:157），工具名要靠
    // 同一次渲染里 assistant tool-call 记下的映射反查；查不到就退回不带名字的「结果: 」。
    const callId = message.toolCallId;
    const toolName = (typeof callId === 'string' || typeof callId === 'number')
      ? toolNames.get(String(callId))
      : undefined;
    const label = toolName ? '结果(' + toolName + '): ' : '结果: ';
    // 失败前缀仍在最前：'[失败] 结果(read): …'
    const prefix = message.isError === true ? '[失败] ' : '';
    lines.push(prefix + label + parts.join('\n'));
    return lines;
  }

  // 其它 role（宿主将来新增的角色）：照常渲染，不静默丢掉材料。
  // system/developer 在上面已被**显式**跳过——它们的正文是系统提示与工具清单，极长且对复盘无意义；
  // 这个显式判断是承重的，不是可省的兜底（tests/trajectory.test.mjs 有一条用例专门钉住它）。
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      const r = clip(block.text, limits.maxTextChars);
      if (r.clipped) state.truncated = true;
      parts.push(r.text);
    } else {
      const mark = blockPlaceholder(block);
      if (mark) parts.push(mark);
    }
  }
  if (!parts.length) return [];
  lines.push(String(role) + ': ' + parts.join('\n'));
  return lines;
}

/**
 * 把宿主的模型可见历史渲染成给复盘模型看的紧凑轨迹文本。
 *
 * 渲染规则（每条消息一行，按原顺序；assistant 的每个 tool-call 另起一行）：
 * - 本插件投递的注入消息（source.kind === 'dsh-ace' && source.form === 'injection'）：整条跳过
 *   （第 28 轮；注入正文就是手册里已有的经验条目，喂进去会让 Reflector 复述自产内容，
 *   见 isAceInjectionMessage）；
 * - system / developer：整条跳过；
 * - user：`用户: ` + text 块拼接（截断 maxTextChars）；
 * - assistant：`助手: ` + text 块拼接（截断 maxTextChars），其 tool-call 各渲染成
 *   `  → 工具名(参数)`（参数原文截断 maxArgChars）；reasoning 跳过；
 * - tool：`结果(工具名): ` + text 块拼接（截断 maxToolResultChars），isError === true 时前缀
 *   `[失败] `（即 `[失败] 结果(read): …`）。工具名靠**同一次渲染内**的
 *   tool-call id → 工具名映射反查（tool 消息自身只带 toolCallId）；映射里查不到（未知 id、
 *   没有 id）就退回 `结果: `。这张映射每次调用新建，绝不跨调用复用——并行/多连调用时
 *   靠位置猜「哪条结果属于哪个工具」会错，带上名字才不歧义；
 * - image → `[图片]`，file → `[文件]`，其余未知 type 忽略；
 * - 其它 role（宿主将来新增的）：`<role>: ` + text 块拼接——照常渲染而不是静默丢材料。
 *
 * 体量控制：maxMessages 只取尾部这么多条消息；渲染完超过 maxChars 则**首尾都保留**——
 * 保留开头 min(maxHeadChars, floor(maxChars / 2)) 个字符 + 一行 `…（中间 N 字符已省略）`
 * + 保留结尾（预算 = maxChars - 开头长度 - 40 个字符的标记预留量），最终长度 ≤ maxChars。
 * 为什么不能只留尾部：任务目标写在第一条 user 消息里，硬截尾等于把最该看的材料丢掉
 * （单块上限 maxTextChars / maxToolResultChars 乘条数很容易撑爆总上限）。
 * 头尾两段放不下时（maxChars 小到连中间标记都挤不下）退化成「开头 + 省略标记」；
 * 这种退化形状里标记的 N 也**恒等于真实被丢弃的字符数**（先定开头长度，再拿它算 N），
 * 标记自己都放不下时返回空字符串 —— 让调用方按「没材料」处理，绝不吐半截标记或垃圾字符。
 * maxTextChars / maxArgChars / maxToolResultChars 控制单块截断。
 *
 * @param {Array} messages - 宿主 session.deriveMessages() 的返回值（Message[]）；非数组视为空
 * @param {object} [options] - 覆盖 TRAJECTORY_DEFAULTS 的任意项
 * @returns {{text: string, messageCount: number, truncated: boolean}}
 *   messageCount 是**实际产生了输出行**的消息条数（被跳过的 system/developer 等不计）；
 *   truncated 表示发生过任何一种截断/省略（单块截断或整体 maxChars 省略）。
 */
export function renderTrajectory(messages, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const limits = {
    maxMessages: pickLimit(opts.maxMessages, TRAJECTORY_DEFAULTS.maxMessages),
    maxChars: pickLimit(opts.maxChars, TRAJECTORY_DEFAULTS.maxChars),
    maxHeadChars: pickLimit(opts.maxHeadChars, TRAJECTORY_DEFAULTS.maxHeadChars),
    maxTextChars: pickLimit(opts.maxTextChars, TRAJECTORY_DEFAULTS.maxTextChars),
    maxArgChars: pickLimit(opts.maxArgChars, TRAJECTORY_DEFAULTS.maxArgChars),
    maxToolResultChars: pickLimit(opts.maxToolResultChars, TRAJECTORY_DEFAULTS.maxToolResultChars),
  };
  const state = { truncated: false };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: '', messageCount: 0, truncated: false };
  }
  // 真实会话可能几千条消息：只取尾部，避免把整段历史都渲染一遍。
  const tail = messages.length > limits.maxMessages ? messages.slice(-limits.maxMessages) : messages;
  if (tail.length < messages.length) state.truncated = true;

  // tool-call id → 工具名：**每次调用各自新建**，不挂模块级变量，跨调用不串味。
  const toolNames = new Map();
  const lines = [];
  // A4：完全相同的行只留首次出现。轨迹里大量重复行（同一工具反复返回同一条目、
  // 重复的提示行）白占 maxChars；折叠后信息不丢、长度更省。seen 只在本函数内，
  // 不挂模块级状态；折叠后整条 summary 仍受 maxChars（clipTrajectory）硬约束。
  const seen = new Set();
  let messageCount = 0;
  for (const message of tail) {
    const rendered = renderMessage(message, limits, state, toolNames);
    if (!rendered.length) continue;
    let pushed = 0;
    for (const line of rendered) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      pushed += 1;
    }
    if (pushed) messageCount++;
  }

  let text = lines.join('\n');
  if (text.length > limits.maxChars) {
    state.truncated = true;
    // 首尾都保留：开头保证任务目标在（硬截尾会把最该看的材料丢掉），中间加省略标记。
    text = clipTrajectory(text, limits.maxChars, limits.maxHeadChars);
  }

  return { text, messageCount, truncated: state.truncated };
}

/**
 * 从宿主 agent 上取本回合的模型可见轨迹。
 *
 * 宿主 API 变动不许把复盘搞崩：用 typeof 判存在 + try/catch 包住，
 * 拿不到（agent/session 缺失、deriveMessages 不存在或抛错）一律返回 null，
 * 由调用方退回「只有计数」的旧文案——宁可信息少，也不让复盘失败。
 * 出处：Session.deriveMessages()，~\dsh-session\lib\index.js:1655-1684、
 * ~\dsh-session\lib\types\index.d.ts:347。
 *
 * @param {object} agent - 宿主 agent（读 agent.session.deriveMessages）
 * @param {object} [logger] - ctx.logger（只用于记录失败原因）
 * @param {object} [options] - 透传给 renderTrajectory
 * @returns {{text: string, messageCount: number, truncated: boolean}|null}
 */
export function collectTurnTrajectory(agent, logger, options) {
  try {
    const session = agent && agent.session;
    if (!session || typeof session.deriveMessages !== 'function') return null;
    return renderTrajectory(session.deriveMessages(), options);
  } catch (error) {
    logger?.warn?.('dsh-ace: 读取本回合轨迹失败（' + ((error && error.message) || error) + '），本次复盘退回只喂计数');
    return null;
  }
}

/**
 * 组装自动复盘喂给 Reflector 的 summary。
 *
 * 形状固定为：第一行计数（沿用改造前的文案，便于日志与人工比对），空行，
 * 然后 `## 本回合轨迹（最近 K 条消息）` 与轨迹文本。轨迹拿不到时退化成只有计数那一行。
 *
 * 总长口径：**整条 summary ≤ maxChars**（默认 12000，即 TRAJECTORY_DEFAULTS.maxChars）。
 * renderTrajectory 只保证**轨迹本身** ≤ maxChars；summary 前面还要加两行标题（计数行 +
 * 轨迹标题行，几十个字符），直接拼起来会到 12030 这种超过上限的长度，于是「本回合的喂料上限」
 * 就说不清了。这里改成把标题行的长度从轨迹预算里扣：轨迹先按 maxChars 渲染，超出的部分
 * 再在本地按「首尾都保留」裁一次（开头至少保住任务目标），最后拼上标题，整条 ≤ maxChars。
 * 调用方要自己控制更紧的总预算时，传 maxChars 进来即可。
 *
 * **唯一例外（口径写清，免得说成无条件成立）**：计数行本身就是 28 个字符
 * （`自动复盘：本回合有 N 次 mutating 工具调用。`，N 为一位数时）。当 maxChars 小于计数行
 * 长度时，返回值**恰为完整计数行**、长度会超过 maxChars —— 这时以保证计数行完整为准，
 * 因为截断后的 summary（半句「自动复盘：本回合有…」）对 Reflector 毫无意义，
 * 还不如明确告诉它「这一轮只给得出计数」。生产路径（lib/index.js）不传 maxChars，
 * 走默认 12000，所以线上不会碰到这个例外。
 *
 * @param {object} params
 * @param {number} params.mutCount - 本回合 mutating 工具调用次数
 * @param {{text: string, messageCount: number}|null} [params.trajectory] - collectTurnTrajectory 的结果
 * @param {number} [params.maxChars] - 整条 summary 的总长上限（缺省 TRAJECTORY_DEFAULTS.maxChars）
 * @returns {string}
 */
export function buildRecapSummary({ mutCount, trajectory, maxChars } = {}) {
  const limit = pickLimit(maxChars, TRAJECTORY_DEFAULTS.maxChars);
  const head = '自动复盘：本回合有 ' + (Number(mutCount) || 0) + ' 次 mutating 工具调用。';
  const text = trajectory && typeof trajectory.text === 'string' ? trajectory.text : '';
  if (!text) return head;
  const count = Number(trajectory.messageCount) || 0;
  const title = '\n\n## 本回合轨迹（最近 ' + count + ' 条消息）\n';
  const textBudget = limit - head.length - title.length;
  // 轨迹本身已经 ≤ maxChars，但标题行一加就可能越界：这里把轨迹按剩余预算再裁一次。
  const capped = textBudget <= 0 ? '' : clipTrajectory(text, textBudget);
  if (!capped) return head;
  return head + title + capped;
}

