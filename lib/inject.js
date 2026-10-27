// dsh-ace 的自动注入（C5）：从最近一条用户消息里取词，把最相关的 top 3–5 条
// 经验渲染成一段**追加进历史的 user 消息**（第 28 轮起；改前是渲染进系统提示段）。
//
// 为什么要预检索：agent/inbox/inserted 派发时宿主还没进入请求装配，检索是异步的（要读盘），
// 而投递点是 agent/pre-step 的 waterfall 监听器。所以只能「订阅 agent/inbox/inserted
// → 预先把检索结果算好放进缓存 → pre-step 里同步取走并追加」。
// 本文件只放纯逻辑（取词、排序、预算、渲染、缓存），IO 与事件接线在 lib/index.js。
//
// 依赖方向：playbook.js ← inject.js（不 import merge/commit/index，保持可单测）。

import { scoreEntries, idNumber } from './playbook.js';

/** 一次最多注入 5 条（写死，见契约 C5.4）。 */
export const INJECT_MAX_ENTRIES = 5;

/** 低于 3 条就按实际条数，不硬凑（写死）。 */
export const INJECT_MIN_ENTRIES = 3;

/** 注入块文本的 token 预算（写死）：累计到约 900 token 即停。 */
export const INJECT_TOKEN_BUDGET = 900;

/** 非 ASCII 字符（汉字 / 全角标点）的 token 权重：1 个汉字 ≈ 1 token（P1-2）。 */
export const TOKEN_WIDE_WEIGHT = 1.0;

/** ASCII 字符的 token 权重：1 个 ASCII 字符 ≈ 0.4 token（P1-2）。 */
export const TOKEN_ASCII_WEIGHT = 0.4;

/** 注入排序里「归一化话题热度」的权重（第 36 轮）：0.1。 */
export const HEAT_WEIGHT = 0.1;

/** 注入排序里「归一化 BM25 相关度」的权重（第 36 轮）：0.9。两者之和恒为 1。 */
export const RELEVANCE_WEIGHT = 0.9;

/**
 * token 估算公式（写死，确定性，P1-2）：
 *   tokens = ceil(ASCII 字符数 × 0.4 + 非 ASCII 字符数 × 1.0)
 *
 * 为什么不是原来的「字符数 / 2」：那个公式对中文**低估整整一倍**。
 * 本手册以中文为主（1 个汉字就是 1 个 token），除以 2 等于假装每个汉字只值半个 token，
 * 于是「约 900 token 预算」实测能到 1800 —— 预算形同虚设，把系统提示撑大一倍。
 * 现在按字符类别加权：汉字/全角按 1.0、ASCII 按 0.4（英文与代码约 3-4 字符/token）。
 *
 * 实现注意：0.4 在二进制里不精确，直接累加再 ceil 会多算 1（5 个 ASCII 累加成
 * 2.0000000000000004 → ceil 得 3）。所以先 round 到 1e-6 再 ceil，保证整数倍时不吃亏。
 * 估算对象是**渲染后的注入块全文**（含标题行与结尾提示），不是单条条目。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else wide += 1;
  }
  const raw = ascii * TOKEN_ASCII_WEIGHT + wide * TOKEN_WIDE_WEIGHT;
  return Math.ceil(Math.round(raw * 1e6) / 1e6);
}

/**
 * 注入排序（C5.3；第 36 轮加入话题热度）：**0.9 × 归一化相关度 + 0.1 × 归一化热度**，
 * 同分按条目 id 数字升序。
 *
 * 热度（options.heat，id → 命中次数，由 lib/heat.js 的 computeHeat 从**用户消息**算出来）
 * 只在候选内部重排：归一化热度 = heat[id] / 本轮候选里的最大 heat，所以它永远落在 [0,1]，
 * 最大只能让一条条目多拿 0.1 分 —— 相关度仍是决定性的 0.9。候选里最大 heat 为 0（没有任何
 * 条目有热度）或 heat 没给时，全部按 0 算，等价于旧的纯相关度排序（也避免 0/0 出 NaN）。
 *
 * **相关度 <= 0 的条目仍然绝不进候选**：热度只能重排「本来就有字面交集」的条目，
 * 不许靠热度制造相关度（见下面 filter 的注释）。
 *
 * 改前是「0.85 × 归一化相关度 + 0.15 × 净分饱和值」。为什么删掉净分项（用户的原始理由）：
 * 净分来自回合成败判定，而一次回合的成败被外部因素主导（provider 抽风、网络、上下文超长），
 * 归因不可靠；把它掺进排序键还有自增强风险——被注入多的条目分数更容易涨，于是更容易再被注入，
 * 与「相关度」这个唯一该负责召回的信号无关。现在排序只看 BM25：
 * 谁跟本回合的任务字面更相关谁靠前，命中数（hits）完全不参与排序（只参与淘汰）。
 *
 * 归一化相关度仍算在行里：它是**可观测数据**（设置页/日志用得上），只是不再进排序键。
 *
 * @returns {{ranked: Array<{entry: object, score: number, relevance: number}>,
 *            topScore: number}}
 *   topScore <= 0 表示本轮无相关条目，调用方应只保留原提示文本。
 */
export function rankInjection(entries, query, options = {}) {
  const scored = scoreEntries(entries || [], query);
  const topScore = scored.length ? Number(scored[0].score) || 0 : 0;
  if (topScore <= 0) return { ranked: [], topScore: 0 };
  // 0 分条目**不进候选**：BM25 分 <= 0 意味着与本回合任务零字面交集，把它塞进注入块只是噪声。
  // 与 matchEntries（lib/playbook.js）的 `filter(x => x.score > 0)` 同口径；上面那句 topScore <= 0 早退
  // 只能挡住「整批全 0」，挡不住「一批有分 + 尾部若干 0 分」这种最常见的形态。
  const ranked = scored
    .filter((item) => (Number(item.score) || 0) > 0)
    .map((item) => ({
      entry: item.e,
      score: Number(item.score) || 0,
      relevance: (Number(item.score) || 0) / topScore,
    }));
  // 归一化热度：分母取**本轮候选里**的最大 heat（不是全局最大），除出来天然落在 [0,1]。
  // 候选最大 heat 为 0 时全部按 0 算 —— 既等价于旧行为，也不会除出 NaN/Infinity。
  const heatRaw = options && options.heat;
  const heat = heatRaw && typeof heatRaw.get === 'function' ? heatRaw : new Map(Object.entries(heatRaw || {}));
  const heatOf = (entry) => {
    const value = Number(heat.get(entry?.id));
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  let heatMax = 0;
  for (const item of ranked) {
    const value = heatOf(item.entry);
    if (value > heatMax) heatMax = value;
  }
  // 综合分 = 0.9 × 相关度 + 0.1 × 归一化热度。相关度（relevance）与热度都归一到 [0,1]，
  // 四项加权和仍是确定性的：同样的输入给出同样的顺序。
  for (const item of ranked) {
    const normalizedHeat = heatMax > 0 ? heatOf(item.entry) / heatMax : 0;
    item.heat = normalizedHeat;
    item.composite = RELEVANCE_WEIGHT * Number(item.relevance || 0) + HEAT_WEIGHT * normalizedHeat;
  }
  // 同分按 id 数字升序：保证「两次同样的检索给出同样的顺序」（Array.prototype.sort 在现代 V8 稳定，
  // 但稳定排序只保证「同分保持输入顺序」，而输入顺序来自手册文件顺序 —— 显式定死更好读）。
  // 用 === 而不是减法：综合分是 0.1/0.9 的浮点和，减法差可能是 1e-17 这种噪声，
  // 拿它当「分高者先」会让同分条目被浮点残渣打乱 id 升序（第 36 轮的确定性硬要求）。
  ranked.sort((a, b) => {
    if (b.composite === a.composite) return idNumber(a.entry?.id) - idNumber(b.entry?.id);
    return b.composite > a.composite ? 1 : -1;
  });
  return { ranked, topScore };
}

/** 单条经验渲染成注入块里的一段（id + 标题 + 何时适用 + 怎么做 [+ 依据]）。 */
function renderEntry(item, index, withRationale) {
  const e = item.entry || {};
  const lines = [
    (index + 1) + '. [' + e.id + '] ' + String(e.title || '').trim(),
    '   - 何时适用：' + (String(e.condition || '').trim() || '（未注明）'),
    '   - 怎么做：' + (String(e.action || '').trim() || '（未注明）'),
  ];
  const rationale = String(e.rationale || '').trim();
  if (withRationale && rationale) lines.push('   - 依据：' + rationale);
  return lines.join('\n');
}

/**
 * 注入块文本（C5.5）。整体能一眼看出是「自动注入的 top N 条经验」，
 * 并提示可用 ace_playbook 查全量手册（第 33 轮起归档已搬去独立文件，不在手册里、也不随整本读取返回）。
 *
 * 首行的「最多 N 条」必须说真话（第 37 轮 C）：N 是**本次注入实际生效的条数上限**，
 * 由 options.maxEntries 传进来（生产上是插件配置 injectMaxEntries，见 lib/index.js 的
 * injectMaxEntriesOf）。历史上这里硬编码 INJECT_MAX_ENTRIES(5)，用户把配置调成 8 时
 * 文案仍在说「最多 5 条」——文案撒谎比数字错更难被用户察觉，所以这个值一律由调用方给，
 * 只有没人给（老调用方 / 测试）时才回落到常量 INJECT_MAX_ENTRIES。
 *
 * 真实渲染样例（3 条）：
 *   【ACE 自动注入】与本回合最相关的 3 条经验（按检索相关度排序，最多 5 条）：
 *   1. [ace-012] 手册写入必须走锁
 *      - 何时适用：改 lib/playbook.js 的写入路径时
 *      - 怎么做：withExclusiveLock + writeFileAtomic，禁止裸 fs.writeFile
 *   2. [ace-031] 先跑基线再改
 *      - 何时适用：动手改代码之前
 *      - 怎么做：先 node --test tests/ 记下 pass/fail/skip，再改
 *   3. [ace-044] 长命令用后台作业
 *      - 何时适用：测试耗时超过一分钟时
 *      - 怎么做：pwsh 后台作业 + job_output 收结果
 *   （自动注入，按检索相关度排序；用 ace_playbook 可查全量手册。）
 */
export function renderInjection(picked, { withRationale = false, maxEntries } = {}) {
  if (!picked || !picked.length) return '';
  // 未传 / 传了非法值（0、NaN、负数）→ 回落常量：宁可说「最多 5 条」，也不能说「最多 0 条」。
  const cap = Number(maxEntries) > 0 ? Math.floor(Number(maxEntries)) : INJECT_MAX_ENTRIES;
  const head = '【ACE 自动注入】与本回合最相关的 ' + picked.length + ' 条经验（按检索相关度排序，最多 ' + cap + ' 条）：';
  const body = picked.map((item, i) => renderEntry(item, i, withRationale));
  const tail = '（自动注入，按检索相关度排序；用 ace_playbook 可查全量手册。）';
  return [head, ...body, tail].join('\n');
}

/**
 * 取条数与预算（C5.4）：从高到低取，累计到预算（默认 INJECT_TOKEN_BUDGET = 900 token）或
 * 满条数上限（默认 INJECT_MAX_ENTRIES = 5）即停；
 * 不足 3 条就按实际条数（不硬凑）。
 *
 * 预算按「渲染后的整块文本」估算（estimateTokens）。第一条总会取：
 * 单条就超过预算时不注入会显得莫名其妙，而「一条都装不下」在实践中只会出现在
 * 手册里有一条极长的条目时 —— 宁可注入它，也不让整个机制静默失效。
 * 依据（rationale）只在整块**带上依据**仍不超预算时才写进注入块，省 token。
 *
 * 条数：从高到低取，满 INJECT_MAX_ENTRIES（5）或累计到约 INJECT_TOKEN_BUDGET（900 token）即停。
 * 不足 INJECT_MIN_ENTRIES（3）**不硬凑** —— 相关度不够就按实际条数注入（这个常量只用于
 * 对外契约与测试断言，逻辑上不做任何补足；导出在文件头，见 `INJECT_MIN_ENTRIES`）。
 *
 * 第 33 轮：考察位（probation）整段删除。它存在的唯一理由是给「被判过负分、被出局线挡住」的
 * 条目一条复出通道 —— 出局线与净分一起删掉后，没有「被挡住的条目」，也就没有需要复出的东西。
 *
 * 条数与预算都可覆盖（第 36 轮起由设置项 injectMaxEntries / injectTokenBudget 传入），
 * 两个常量退化成兜底默认值。options.heat（id → 热度）原样透传给 rankInjection。
 *
 * @returns {{text: string, ids: string[], entries: Array<object>, tokens: number, count: number, topScore: number}}
 */
export function selectInjection(entries, query, options = {}) {
  const maxEntries = Number(options.maxEntries) || INJECT_MAX_ENTRIES;
  const budget = Number(options.tokenBudget) || INJECT_TOKEN_BUDGET;
  const { ranked, topScore } = rankInjection(entries, query, options);
  const empty = { text: '', ids: [], entries: [], tokens: 0, count: 0, topScore: 0 };
  if (topScore <= 0) return { ...empty, topScore };
  const picked = [];
  for (const item of ranked) {
    if (picked.length >= maxEntries) break;
    const next = [...picked, item];
    // 第一条无条件取；之后按「渲染后整块」的 token 估算决定收不收。
    if (picked.length && estimateTokens(renderInjection(next, { maxEntries })) > budget) break;
    picked.push(item);
  }
  let withRationale = picked.some((item) => String(item.entry?.rationale || '').trim());
  if (withRationale && estimateTokens(renderInjection(picked, { withRationale: true, maxEntries })) > budget) withRationale = false;
  const text = renderInjection(picked, { withRationale, maxEntries });
  return {
    text,
    ids: picked.map((item) => item.entry.id),
    entries: picked.map((item) => item.entry),
    tokens: estimateTokens(text),
    count: picked.length,
    topScore,
  };
}

/**
 * 从 UserMessage 里取出纯文本（C5.1）。
 * 宿主消息体是 ContentBlock[]（dsh-llm\lib\types\message.d.ts:144），
 * 只拼 type === 'text' 的块；也容忍裸字符串（旧调用方/测试构造）。
 */
export function userTextOf(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/** 稳定短哈希（djb2 → base36）：没有 message.id 时用它做缓存键。 */
function hashText(text) {
  let h = 5381;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 消息缓存键（C5.7）：优先 message.id，退回文本哈希。 */
export function messageKeyOf(message) {
  if (message && typeof message === 'object' && typeof message.id === 'string' && message.id) return 'id:' + message.id;
  return 'text:' + hashText(userTextOf(message));
}

/**
 * 按 agent 隔离的注入缓存（C5.7）：同一条用户消息只检索一次，
 * 检索结果缓存在这里，供 agent/pre-step 的投递（lib/inject-delivery.js）取走一次。
 */
export function createInjectionCache() {
  const store = new WeakMap();
  const keyOf = (agent) => (agent && typeof agent === 'object' ? agent : null);
  return {
    /** key 省略时返回该 agent 最近一次结果。 */
    get(agent, key) {
      const a = keyOf(agent);
      if (!a) return null;
      const slot = store.get(a);
      if (!slot) return null;
      if (key === undefined) return slot.value;
      return slot.key === key ? slot.value : null;
    },
    set(agent, key, value) {
      const a = keyOf(agent);
      if (!a) return value;
      store.set(a, { key, value });
      return value;
    },
    clear(agent) {
      const a = keyOf(agent);
      if (a) store.delete(a);
    },
  };
}