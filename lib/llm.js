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
 * 正文为空时**不返回空串**，而是抛一条带现场的普通错误（健壮性缺口 B1）：
 * 模型可能把整段内容写进 reasoning 通道、正文一格不留（线上实测那一趟 72 秒正常结束、
 * text-delta 一个都没来），把空串交给上层只会在 extractJsonObject 里变成「未找到 JSON 对象」，
 * 现场（reasoning 字符数、耗时、provider/model）全靠考古。所以这里自己说清。
 * 该错误是**普通错误**：不带 'ace: LLM 调用超时' 前缀，lib/reflect.js 的 isTimeoutError 不会认它
 * （超时豁免只给真正的超时用，文案与行为一字未改）。
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
// 取 150000ms：仍小于宿主 300000ms 的 idle 看门狗（在它出手前先本地放弃），
// 也仍小于总时限 RECAP_TOTAL_DEADLINE_MS（300000）的 2/3（= 200000，150000 ≤ 200000）
// —— 保证「最坏 8 次调用」里至少有一次能撞到总时限而不是全部耗在单次上限上。
// 测试可用 ACE_ONESHOT_TIMEOUT_MS 压到几十毫秒（环境变量先例见 e2e.test.mjs 的 ACE_E2E_DEBUG）。
// 刻意**不 export**（第 39 轮缺陷 8）：本文件之外没有任何使用点（tests/recap-hang.test.mjs
// 走的是环境变量而不是这个导出），导出只会误导读者去别处改这个值。
const ONESHOT_TIMEOUT_MS = (() => {
  try {
    const raw = process.env.ACE_ONESHOT_TIMEOUT_MS;
    if (raw === undefined || raw === '') return 150000;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 150000;
  } catch {
    return 150000;
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

/**
 * 把 finish 块里的失败现场（reason.failure 是宿主的 LlmFailure，可缺）拍成一行文字。
 * 形状出处：dsh-llm lib/types/types.d.ts:26-44（LlmFailure: message / code / status? …）。
 * 上游给什么都没有时返回空串，绝不塞占位文案进去（现场丢了比多一行更糟）。
 */
function describeFailure(reason) {
  const failure = reason && reason.failure;
  if (!failure || typeof failure !== 'object') return '';
  const parts = [];
  if (typeof failure.message === 'string' && failure.message) parts.push(failure.message);
  if (typeof failure.code === 'string' && failure.code) parts.push('code=' + failure.code);
  if (typeof failure.status === 'number') parts.push('status=' + failure.status);
  return parts.join('、');
}

/**
 * 一次调用的现场：已收正文字符数、reasoning 字符数、耗时、provider/model，以及实际生效的单次上限。
 * 截断/中止时报错全靠它 —— 半截输出被当成功返回时，日志里只有「JSON 不完整」，看不出是超时还是截断。
 */
function sceneOf({ out, reasoning, startedAt, provider, model, capMs }) {
  return '已收正文 ' + out.length + ' 字符、reasoning ' + reasoning + ' 字符、耗时 '
    + (Date.now() - startedAt) + 'ms、' + provider + '/' + model + '、单次上限 ' + capMs + 'ms';
}

export async function oneShot(ctx, { provider, model, system, userText, signal, maxTokens, maxMs, reasoningEffort }) {
  let out = '';
  const options = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  };
  if (maxTokens) options.maxTokens = maxTokens;
  // 第 50 轮：思考强度。**必须显式传**——会话默认档位的解析会读 profile 里的 reasoningEffort
  // 盖过模型的 defaultEffort（~\dsh-llm-pi-ai\lib\index.js:1953），所以「不传」等于「跟随 profile」而不是「最低档」。
  // 传未声明的档位会被宿主抛 UNSUPPORTED_REASONING_EFFORT（~\dsh-llm-pi-ai\lib\index.js:1785-1789），
  // 因此到达这里的值必须已经由 lib/reasoning.js 对着 efforts 校验过；空值一律不写这个键。
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') options.reasoningEffort = reasoningEffort;
  // 单次调用上限：与调用方 signal 合并后透传给 ctx.llm.stream（宿主 stream 本来就会消费 signal）。
  // 第 45 轮：调用方可给 maxMs（复盘剩余预算算出来的本次调用上限），取两者较小值 ——
  // 让「合并的一次调用」在队列总时限**之前**自己到点失败，这一对按失败处理、其余照常落盘，
  // 而不是拖到总时限被整份放弃。报错文案里的毫秒数用实际生效的上限。
  const capMs = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(ONESHOT_TIMEOUT_MS, maxMs) : ONESHOT_TIMEOUT_MS;
  const callSignal = mergeSignals(signal, capMs);
  options.signal = callSignal;
  // 计时与 reasoning 字符数：只用于空正文时报错文案里的现场（不影响超时判据 —— 超时仍只由 callSignal 认）。
  let reasoning = 0;
  // 第 49 轮：终止 finish 块里的原因（形状见下面循环里的注释）。null = 这个流没给 finish 块。
  let finish = null;
  const startedAt = Date.now();
  try {
    for await (const chunk of ctx.llm.stream(options)) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { out += chunk.text; continue; }
      // reasoning-delta 只计数、绝不当正文：它是模型的思考内容，不是可解析的输出。
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') { reasoning += chunk.text.length; continue; }
      // 第 49 轮：**宿主流以 finish 块收尾**，且被取消时它不抛错 ——
      // dsh-llm-pi-ai lib/index.js:1638-1650 在 event 'error' 且 callerSignal.aborted 时
      // 先 yield { type:'finish', reason:{kind:'aborted'} } 再 return；
      // 类型契约 dsh-llm lib/types/types.d.ts:434-464（finish 分支在 :459-464，
      // 判别字段是 reason.kind，取值见同文件 :131-149：stop / tool-calls / max-tokens / aborted / error）。
      // 旧版循环只认 text-delta，于是**半截正文被当成完整输出返回**，上层 extractJsonObject
      // 报「JSON 对象不完整（从第 1 字起未闭合）」—— 超时/截断被伪装成解析错误，真因在日志里完全看不到。
      // 这里先记下原因，等循环正常结束后再翻译成对应语义的错误（不在这里 throw：
      // 在这段 try 里抛会被下面的 catch 当成流抛错、再包一层超时文案）。
      if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason === 'object') finish = chunk.reason;
    }
  } catch (error) {
    // 本地超时（或调用方取消）只让**这一次**调用失败：message 带 'ace: LLM 调用超时' 字样，
    // 上层 reflect.js 识别后按「这一轮放弃」处理，绝不把整段复盘炸掉。
    if (callSignal.aborted && !(signal && signal.aborted)) {
      throw new Error('ace: LLM 调用超时（单次上限 ' + capMs + 'ms）：' + String((error && error.message) || error));
    }
    throw error;
  }
  // 第 49 轮：finish 原因 → 错误语义。三种非成功收尾都必须**当场抛错**，绝不把半截正文当结果返回：
  // 上层（lib/index.js 的解析调用点）看到的是「超时 / 截断」而不是「JSON 不完整」。
  // stop（正常结束）与 tool-calls（本调用不带 tool，见文件头注释）不在这里判，行为一字不变。
  const finishKind = finish && typeof finish.kind === 'string' ? finish.kind : '';
  // 调用方自己取消（总时限到点、回合被停）优先报**调用方取消**：它不是本层的超时，
  // 文案刻意不以 'ace: LLM 调用超时' 开头（lib/reflect.js 的 isTimeoutError 认这个前缀，
  // 那条豁免是给「本次调用到点」用的，不该让整份复盘被外部取消时按「按已提炼候选收尾」假成功）。
  if (finishKind === 'aborted' && (signal ? signal.aborted : callSignal.aborted)) {
    const why = describeFailure(finish);
    throw new Error('ace: LLM 调用被取消（调用方信号已中止、'
      + (why ? why + '、' : '') + sceneOf({ out, reasoning, startedAt, provider, model, capMs }) + '）');
  }
  // 本地单次上限到点：provider 不抛错、只给一个 aborted finish 块 —— 这正是「超时被伪装成
  // JSON 未闭合」的真因。文案**保留 'ace: LLM 调用超时' 前缀**（isTimeoutError 靠它只放弃本轮）。
  if (finishKind === 'aborted') {
    const why = describeFailure(finish);
    throw new Error('ace: LLM 调用超时（单次上限 ' + capMs + 'ms）：'
      + (why ? why + '、' : '') + sceneOf({ out, reasoning, startedAt, provider, model, capMs }));
  }
  // 输出被 max-tokens 截断：不是超时（模型自己说完了、是被上限剪断的），不许走「按已提炼候选收尾」的
  // 豁免，必须按真实失败上抛；带上已收字符数与路由，方便判断要不要调大 maxTokens。
  if (finishKind === 'max-tokens') {
    throw new Error('ace: LLM 输出被 max-tokens 截断（' + provider + '/' + model + '、'
      + sceneOf({ out, reasoning, startedAt, provider, model, capMs }) + '）');
  }
  // provider 侧失败（鉴权、配额、上游 5xx…）由宿主归一化成 error finish 块：上游 reason 与
  // failure.message / code 原样带上，不另起一套文案。
  if (finishKind === 'error') {
    const why = describeFailure(finish);
    throw new Error('ace: LLM 调用失败（finish reason=error'
      + (why ? '：' + why : '') + '、' + sceneOf({ out, reasoning, startedAt, provider, model, capMs }) + '）');
  }
  const text = out.trim();
  if (!text) {
    // 空正文 = 本次调用没有可用输出：明确抛错（普通错误，不是超时）。
    // 信息项一个不少：reasoning 字符数（判断是不是「全写进推理通道」）、耗时（判断是
    // 正常结束还是被截断）、provider/model（判断是不是路由换了模型）。
    throw new Error('ace: LLM 本次正文为空（reasoning ' + reasoning + ' 字符、耗时 '
      + (Date.now() - startedAt) + 'ms、' + provider + '/' + model + '）');
  }
  return text;
}