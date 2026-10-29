// 第 50 轮：把「这一次 LLM 调用该发哪一档思考强度」从模型路由里拆出来单独判定。
//
// 宿主 API 出处（~ = C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai）：
//   - ctx.llm.resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
//     —— ~\dsh-llm\lib\types\index.d.ts:377
//     （实现 ~\dsh-llm\lib\types\index.js:604-610，signal 真的透传给 adapter.resolveModel；
//      provider/model 对不上时 normalizeModelInfo 会抛 LlmError —— ~\dsh-llm\lib\types\index.js:612-639）
//   - LlmResolvedModelInfo.reasoning?: { efforts: readonly LlmReasoningEffortInfo[]; defaultEffort?: ReasoningEffortId }
//     —— ~\dsh-llm\lib\types\types.d.ts:367-375，
//     注释原文「Supported efforts from least to greatest selectable reasoning effort」
//     ⇒ efforts 由弱到强排列，efforts[0] 就是该模型声明的最低档。
//   - LlmReasoningEffortInfo = { id, name, description? }
//     —— ~\dsh-llm\lib\types\types.d.ts:358-365
//   - 请求侧字段 GenerateOptions.reasoningEffort?: ReasoningEffortId
//     —— ~\dsh-llm\lib\types\types.d.ts:511（ReasoningEffortId 本质是字符串，~\dsh-llm\lib\types\brand.d.ts:49,55）
//
// 两条必须遵守的宿主行为：
//   1. 会话默认档位的解析在 ~\dsh-llm-pi-ai\lib\index.js:1953 的
//      resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)：只要 profile 里写了
//      reasoningEffort（本机 C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml:12 就写着 high），
//      它会盖过模型的 defaultEffort。⇒ 想让插件选档**必须显式传** reasoningEffort，靠「不传」是无效的。
//   2. 传了模型没声明的档位会被宿主直接抛 UNSUPPORTED_REASONING_EFFORT
//      —— ~\dsh-llm-pi-ai\lib\index.js:1785-1789。⇒ 任何要发出去的值都必须先对着 efforts 校验。
//
// 这个文件不 import 任何宿主包（本仓库没有 node_modules），LlmRuntime 一律经参数注入。
// 它也不落盘（红线 9）：缓存只在进程内。

/** 合法档位名（小写英文）。顺序沿用宿主 ReasoningEffortId 的由弱到强。 */
export const REASONING_EFFORT_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 宿主档位查询的超时。与 lib/catalog.js 的 withTimeout 默认 15000ms 同档（一次复盘最多查一次，见下方缓存）。 */
export const EFFORT_QUERY_TIMEOUT_MS = 15000;
/** 查询成功的缓存时长：档位声明只随宿主的模型注册表变，10 分钟内几乎不可能变。 */
const EFFORT_OK_TTL_MS = 10 * 60 * 1000;
/** 查询失败的缓存时长：短一些。失败不该把一次复盘拖成「每轮都去撞一次超时」。 */
const EFFORT_FAIL_TTL_MS = 60 * 1000;
/** 缓存条目上限（超过就整表清空，不做 LRU —— 键的基数是个位数）。 */
const EFFORT_CACHE_LIMIT = 128;

/** provider+model → { value, expiresAt }。进程内，不落盘。 */
const effortCache = new Map();

/** 清空缓存（测试用；生产代码不调）。 */
export function resetReasoningEffortCache() {
  effortCache.clear();
}

/**
 * 校验一个档位名。返回规范值（已去首尾空白）/ 空串（= 未手动指定）/ undefined（非法）。
 * 只认 REASONING_EFFORT_IDS 里的小写英文名，不接受别名与大小写变体。
 */
export function validReasoningEffort(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return REASONING_EFFORT_IDS.includes(trimmed) ? trimmed : undefined;
}

function withinMs(promise, ms) {
  if (!(Number.isFinite(ms) && ms > 0)) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after ' + ms + 'ms')), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function messageOf(error) {
  return String((error && error.message) || error);
}

/**
 * 把宿主的 LlmResolvedModelInfo 归一成插件自己的形状。纯函数，不碰宿主。
 * 返回 { ok:true, provider, model, efforts:[{id,name,description?}], defaultEffort?, note }
 *   note：null（有 ≥2 档，可自动降档）/ 'noReasoning'（非推理模型）/ 'noEfforts'（声明了但一条都没解析出来）
 *         / 'singleEffort'（只声明了一档 —— 降过去等于没改，不干预）。
 */
export function decodeModelEfforts(raw, provider, model) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'ace: 宿主返回的模型信息格式非法（不是对象）' };
  }
  const reasoning = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning : null;
  const declared = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : null;
  const efforts = [];
  for (const item of declared || []) {
    if (!item || typeof item !== 'object') continue;
    const id = validReasoningEffort(item.id);
    if (id === undefined || id === '') continue;
    if (efforts.some((e) => e.id === id)) continue;
    const effort = { id, name: typeof item.name === 'string' && item.name ? item.name : id };
    if (typeof item.description === 'string' && item.description) effort.description = item.description;
    efforts.push(effort);
  }
  // defaultEffort 只是给设置页显示「宿主自己会选哪档」：声明了、且在声明集里，才原样带出。
  // 没声明就是 undefined —— 绝不回落 efforts 末项：efforts 由弱到强，末项是最强档，
  // 而这个值会以「宿主默认档」的名义出现在 GET /api/dsh-ace/efforts 报文里，等于插件凭空造一句宿主没说过的话。
  const declaredDefault = validReasoningEffort(reasoning && reasoning.defaultEffort);
  const defaultEffort = declaredDefault && efforts.some((e) => e.id === declaredDefault)
    ? declaredDefault
    : undefined;
  let note = null;
  if (!declared) note = 'noReasoning';
  else if (!efforts.length) note = 'noEfforts';
  else if (efforts.length === 1) note = 'singleEffort';
  return {
    ok: true,
    provider: typeof raw.provider === 'string' && raw.provider ? raw.provider : provider,
    model: typeof raw.model === 'string' && raw.model ? raw.model : model,
    efforts: note === 'noReasoning' ? [] : efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    note,
  };
}

/**
 * 问宿主「这个 provider/model 声明了哪些思考档位」，带缓存。
 * 永不抛错：任何失败都返回 { ok:false, error }，调用方据此「不干预」继续原路由。
 * 超时有两层：AbortSignal.timeout（宿主规范途径，signal 会透传给 adapter.resolveModel）
 * + 一个硬计时兜底（第三方 adapter 若无视 signal，这里也绝不把复盘挂死）。
 */
export async function queryModelEfforts(llm, provider, model, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : EFFORT_QUERY_TIMEOUT_MS;
  // 错误串**不带** 'ace: ' 前缀：调用方按语境自己加（warn 用 'dsh-ace: '，HTTP 路由用 'ace: '），否则会拼出
  // 「dsh-ace: ace: …」这种双前缀的日志。
  if (!provider || !model) return { ok: false, error: '缺少 provider/model，无法查询思考档位' };
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    return { ok: false, error: '宿主未提供模型档位查询（llm.resolveModelInfo 不存在）' };
  }
  const key = provider + '\u0000' + model;
  const now = Date.now();
  // refresh：绕开缓存重问一次。只给「超时降档重试」用 —— 首次失败那一轮要重问，别被 60s 的失败缓存判死。
  const hit = options.refresh === true ? undefined : effortCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  let value;
  let ttl;
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const raw = await withinMs(
      Promise.resolve({}).then(() => (signal ? llm.resolveModelInfo(provider, model, signal) : llm.resolveModelInfo(provider, model))),
      timeoutMs + 1000,
    );
    value = decodeModelEfforts(raw, provider, model);
    ttl = value.ok ? EFFORT_OK_TTL_MS : EFFORT_FAIL_TTL_MS;
  } catch (error) {
    value = { ok: false, error: '查询思考档位失败（' + messageOf(error) + '）' };
    ttl = EFFORT_FAIL_TTL_MS;
  }
  if (effortCache.size >= EFFORT_CACHE_LIMIT && !effortCache.has(key)) effortCache.clear();
  effortCache.set(key, { value, expiresAt: now + ttl });
  return value;
}

function effortIdsOf(efforts) {
  return (Array.isArray(efforts) ? efforts : [])
    .map((item) => (item && typeof item.id === 'string' ? item.id : ''))
    .filter((id) => id !== '')
    .join('/');
}

/**
 * 纯判定：这一次调用到底发哪个档位。不查宿主、不写盘、不抛错。
 *
 * 判定顺序（DESIGN.md「自动降档」一节是唯一出处）：
 *   1. manual 非空且在声明集里 → 用它（source:'manual'）；
 *   2. manual 非空但模型没声明 → 丢弃 + warn，回落第 3/4 条（绝不硬发，宿主会抛 UNSUPPORTED_REASONING_EFFORT）；
 *   3. manual 为空且 auto 为真 → 取声明的最低档 efforts[0]（efforts 由弱到强，出处见文件头）；
 *      但「只有一档」「没有 reasoning 字段」「查询失败」三种情形不干预（发一个等于没改的值毫无意义）；
 *   4. 其余 → 不干预（source:'none'）。
 *
 * 返回 { effort: <字符串或 null>, source: 'manual'|'auto'|'none', reason?, efforts, defaultEffort, info }。
 * warn 由调用方注入（通常是 ctx.logger.warn），本函数不碰 logger 对象本身。
 */
export function planReasoningEffort({ manual, auto, info, warn }) {
  const query = info && typeof info === 'object' ? info : { ok: false, error: '没有思考档位信息' };
  const efforts = query.ok && Array.isArray(query.efforts) ? query.efforts : [];
  const ids = efforts.map((item) => item.id);
  const label = (query.provider || '?') + '/' + (query.model || '?');
  const note = (text) => { try { if (typeof warn === 'function') warn(text); } catch { /* warn 抛错不影响判定 */ } };
  const base = {
    efforts,
    ...(query.defaultEffort === undefined ? {} : { defaultEffort: query.defaultEffort }),
    info: query,
  };
  const low = efforts.length ? efforts[0].id : null;
  const want = validReasoningEffort(manual);
  // —— 1/2：手动值优先，但必须先在声明集里 ——
  let droppedManual = null;
  if (typeof manual === 'string' && manual.trim() !== '') {
    if (want === undefined) {
      // 第 51 轮（D2）：非法档位名原先**静默丢弃**（只写 reason 字段，日志里一个字都没有），
      // 用户填错档位名时无从排查。文案口径与下面「不在该模型声明集里」那一支一致：
      // 带用户填的原值 + 合法值清单（清单取自 REASONING_EFFORT_IDS，绝不手写第二份）。
      droppedManual = 'ace: 配置的思考档位不在合法档位集里';
      note('dsh-ace: 配置的思考档位 ' + manual.trim() + ' 不在合法档位集里（' + REASONING_EFFORT_IDS.join('/') + '），已丢弃');
    } else if (query.ok && !ids.includes(want)) {
      droppedManual = 'ace: 配置的档位不在该模型声明的档位集里';
      note('dsh-ace: 配置的思考档位 ' + want + ' 不在模型 ' + label + ' 声明的档位集里（' + effortIdsOf(efforts) + '），已丢弃');
    } else {
      return { ...base, effort: want, source: 'manual' };
    }
  }
  // —— 3：自动降到最低档 ——
  if (auto) {
    if (!query.ok) {
      note('dsh-ace: ' + (query.error || '查询思考档位失败') + '，本次不降档');
      return { ...base, effort: null, source: 'none', reason: droppedManual || 'ace: 查询思考档位失败' };
    }
    if (query.note === 'noReasoning' || query.note === 'noEfforts') {
      note('dsh-ace: 模型 ' + label + ' 未提供思考档位信息，不自动降档');
      return { ...base, effort: null, source: 'none', reason: droppedManual || 'ace: 模型未提供思考档位信息' };
    }
    if (efforts.length === 1) {
      note('dsh-ace: 模型 ' + label + ' 只声明了一个思考档位（' + low + '），不自动降档');
      return { ...base, effort: null, source: 'none', reason: droppedManual || 'ace: 模型只声明了一个思考档位' };
    }
    if (low) return { ...base, effort: low, source: 'auto', ...(droppedManual ? { reason: droppedManual } : {}) };
    note('dsh-ace: 模型 ' + label + ' 没有可用的思考档位，不自动降档');
    return { ...base, effort: null, source: 'none', reason: droppedManual || 'ace: 没有可用的思考档位' };
  }
  // —— 4：关掉了自动降档且没有手动值 ——
  return { ...base, effort: null, source: 'none', reason: droppedManual || 'ace: 自动降档已关闭' };
}

/**
 * 某个模型声明的最低档（C 的超时重试用它）。查不到 / 只有一档 / 没有 reasoning 都返回 null，
 * 调用方据此「不重试」—— 降到一个等于没改的值毫无意义。
 */
export function lowestEffortOf(info) {
  const query = info && typeof info === 'object' ? info : null;
  if (!query || !query.ok) return null;
  const efforts = Array.isArray(query.efforts) ? query.efforts : [];
  if (efforts.length < 2) return null;
  return efforts[0].id || null;
}
