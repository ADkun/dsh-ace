// dsh-ace 的 LLM 调用层：路由解析 + 单次调用收集。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - ctx.llm / LlmRuntime.stream(GenerateOptions)：~\dsh-llm\lib\types\index.d.ts（LlmRuntime:30、stream:115,433）、
//   GenerateOptions ~\dsh-llm\lib\types\types.d.ts:506-548
// - 用户消息 content 为 ContentBlock[]、TextBlock {type:'text',text}：~\dsh-llm\lib\types\types.d.ts:46-49、message.d.ts:128,144-146
// - 流块 text-delta {type:'text-delta',index,text}：~\dsh-llm\lib\types\types.d.ts:438-441
// - 会话路由解析链（session.requestHeader().config → agent.options）：真实范例 ~\dsh-tool-fs\lib\index.js:909-914；
//   Session.requestHeader：~\dsh-session\lib\types\index.d.ts:303；AgentOptions.provider/model：~\dsh-agent\lib\types\runtime-types.d.ts:23-25

/**
 * 解析 Reflector/Curator 用的模型路由：
 * 1. 配置了 reflectProvider + reflectModel 则优先（覆盖模型名的设计决策）；
 * 2. 否则跟随当前会话：requestHeader().config → agent.options（与会话同模型为默认）。
 * 都解析不出来则抛错，要求显式配置。
 */
export function resolveRoute(config, exec) {
  if (config && config.reflectProvider && config.reflectModel) {
    return { provider: config.reflectProvider, model: config.reflectModel };
  }
  const agent = exec && exec.agent;
  const routed = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : undefined;
  const rc = routed && routed.config;
  const provider = (rc && rc.provider) ?? (agent && agent.options && agent.options.provider);
  const model = (rc && rc.model) ?? (agent && agent.options && agent.options.model);
  if (!provider || !model) {
    throw new Error('ace: 无法解析模型路由（会话未提供 provider/model）。请在插件配置里显式设置 reflectProvider 与 reflectModel。');
  }
  return { provider, model };
}

/**
 * 单次 LLM 调用：发 system + 一条 user 文本消息，串接所有 text-delta 返回纯文本。
 *
 * 每次调用本身仍是「一次性结构化任务」——不带会话历史、不带 tool、不落对话记忆；
 * 但 Reflector 的**多轮复盘**是由调用方（lib/index.js 的 executeRecap）串起来的：
 * 每轮把「轨迹 + 此前已提炼的候选」重新拼成一条完整 user 消息再发一次，
 * 所以这里不需要也不应该自己维护对话状态。Curator 依旧只调一次。
 */
// 单次 LLM 调用的上限（第 39 轮）：宿主侧 provider 有 300000ms 的 stream idle 看门狗、
// 重试层还有指数退避，实测单次调用能挂数分钟（step/start → assistant/attempt 间隔 533 秒）。
// 复盘最多 3 轮复盘 + 5 轮合并 = 8 次串行调用，若每次都没有本地超时，一次静默就能把
// 宿主维护相位按住数小时、用户消息永远排队。所以这里给每次调用加一个本地硬上限。
// 取 75000ms：比宿主 300000ms 的 idle 看门狗小一个数量级（在它出手前先本地放弃），
// 也小于总时限 RECAP_TOTAL_DEADLINE_MS（120000）的 2/3 —— 保证「最坏 8 次调用」里
// 至少有一次能撞到总时限而不是全部耗在单次上限上。
// 测试可用 ACE_ONESHOT_TIMEOUT_MS 压到几十毫秒（环境变量先例见 e2e.test.mjs 的 ACE_E2E_DEBUG）。
// 刻意**不 export**（第 39 轮缺陷 8）：本文件之外没有任何使用点（tests/recap-hang.test.mjs
// 走的是环境变量而不是这个导出），导出只会误导读者去别处改这个值。
const ONESHOT_TIMEOUT_MS = (() => {
  try {
    const raw = process.env.ACE_ONESHOT_TIMEOUT_MS;
    if (raw === undefined || raw === '') return 75000;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 75000;
  } catch {
    return 75000;
  }
})();

/**
 * 把调用方的 signal 与本地超时合并成一个 signal（任一先触发即放弃）。
 * AbortSignal.any 是 Node 22 的原生能力（engines: node>=22），不引入任何依赖。
 */
function mergeSignals(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  // Node 22 起 AbortSignal.any 可用（engines: node>=22）；老运行时退化成「后 abort 的覆盖」。
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const onTimeout = () => controller.abort(timeout.reason);
  const onCaller = () => controller.abort(signal.reason);
  if (timeout.aborted) controller.abort(timeout.reason);
  else timeout.addEventListener('abort', onTimeout, { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onCaller, { once: true });
  return controller.signal;
}

export async function oneShot(ctx, { provider, model, system, userText, signal, maxTokens, maxMs }) {
  let out = '';
  const options = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  };
  if (maxTokens) options.maxTokens = maxTokens;
  // 单次调用上限：与调用方 signal 合并后透传给 ctx.llm.stream（宿主 stream 本来就会消费 signal）。
  // 第 45 轮：调用方可给 maxMs（复盘剩余预算算出来的本次调用上限），取两者较小值 ——
  // 让「合并的一次调用」在队列总时限**之前**自己到点失败，这一对按失败处理、其余照常落盘，
  // 而不是拖到总时限被整份放弃。报错文案里的毫秒数用实际生效的上限。
  const capMs = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(ONESHOT_TIMEOUT_MS, maxMs) : ONESHOT_TIMEOUT_MS;
  const callSignal = mergeSignals(signal, capMs);
  options.signal = callSignal;
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    }
  } catch (error) {
    // 本地超时（或调用方取消）只让**这一次**调用失败：message 带 'ace: LLM 调用超时' 字样，
    // 上层 reflect.js 识别后按「这一轮放弃」处理，绝不把整段复盘炸掉。
    if (callSignal.aborted && !(signal && signal.aborted)) {
      throw new Error('ace: LLM 调用超时（单次上限 ' + capMs + 'ms）：' + String((error && error.message) || error));
    }
    throw error;
  }
  return out.trim();
}