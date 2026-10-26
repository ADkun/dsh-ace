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
export async function oneShot(ctx, { provider, model, system, userText, signal, maxTokens }) {
  let out = '';
  const options = {
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  };
  if (maxTokens) options.maxTokens = maxTokens;
  if (signal) options.signal = signal;
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
  }
  return out.trim();
}