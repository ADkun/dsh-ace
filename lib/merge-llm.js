// LLM 合并（第 33 轮）：满额时先试着「把两条讲同一件事的经验并成一条」。
//
// 分工写死，不许互换：
//   - **找配对**是代码的活（lib/merge.js 的 computePairRatios 矩阵，对称 BM25 比率
//     >= MERGE_THRESHOLD_RATIO(0.5)）—— 阈值是判据，必须可单测、可复现；
//   - **合成正文**是 LLM 的活 —— 只把这一对的正文 + 合并要求喂进去，让它产出一条
//     同构的四字段条目。LLM 不选 id、不选保留谁、不决定归档谁（那些是代码定死的）。
//
// 失败语义（硬红线）：**合并失败绝不许阻塞复盘落盘**。任何一对出错（LLM 抛错、
// 输出不是 JSON、形状不合格）都只是「这一对没合并」，跳过换下一对；全部失败就
// 直接进入淘汰。planMerges 永不抛错，只返回「成了什么、废了什么」。
//
// 走与 Reflector 同一条 LLM 路径（lib/llm.js 的 oneShot），不新开连接方式、不加依赖。

import { computePairRatios, pairRatioAt, MERGE_THRESHOLD_RATIO } from './merge.js';
import { extractJsonObject } from './prompts.js';
// dumpRaw：合并解析失败时把 LLM 原文落一份到 <DSH_HOME>/ace/debug/raw.jsonl（健壮性缺口 B2，
// 见 ./raw-log.js 头注：一切失败全吞、ACE_RAW_LOG=0 可关、锁外调用）。
import { dumpRaw } from './raw-log.js';
import { nowStamp } from './timestamp.js';
import { idNumber } from './playbook.js';

/** 每轮复盘最多尝试合并几对（用户拍板：5 轮）。 */
export const MERGE_MAX_ROUNDS = 5;

/**
 * 合并阶段的预算下限（第 45 轮）。
 *
 * 动因：一轮复盘的总时限是 120000ms，而「提炼（≤3 轮）+ 合并（≤5 对）」最多 8 次串行 LLM 调用
 * 不可能全部跑完。旧实现里合并阶段对剩余预算一无所知， Reflector 把时间花完后才轮到合并 ——
 * 结果就是队列在总时限处整份放弃，一条合并都没写成。这里把预算切成显式契约：
 *   - MERGE_MIN_CALL_MS：一次 LLM 调用的最小合理预算，低于它就不再发起新的一对
 *     （一次注定跑不完的调用只会白花，还把队列逼到总时限处整份丢弃）；
 *   - MERGE_COMMIT_RESERVE_MS：留给落盘（写 archive + 写手册 + merge-inbox）的保底时间。
 * 预算来源是调用方（lib/recap-pipeline.js）从队列拿到的 deadlineAt，不在这里读环境变量。
 */
export const MERGE_MIN_CALL_MS = 10000;
export const MERGE_COMMIT_RESERVE_MS = 8000;

/**
 * 轻量合并（第 37 轮 B）：**手册没满额**时的「顺手清理」阈值与轮数。
 *
 * 为什么和满额路径不一样（0.5 / 5 对 → 0.75 / 2 对）：
 *   - 满额（projected > maxEntries）是**非合不可** —— 不合并就要淘汰，代价是丢经验，
 *     所以宁可放宽阈值（0.5）、多试几对（5），把「有点像」的都试着并一次；
 *   - 不满额是**顺手清理** —— 不合也没事，合并的唯一目的是别让手册越长越啰嗦。
 *     阈值一旦也放到 0.5，模型就会为了省名额把不相干的经验硬并成一条（合并提示词
 *     本身是「两段正文 → 一条同构条目」，硬并的结果是语义污染，且不可逆：
 *     归档文件里躺着的那条再也不会被注入）。所以这里阈值必须更高（0.75）、
 *     轮数必须更少（2）—— 只有真的很像才动手，且一轮复盘最多清两对。
 *
 * 生产接线见 lib/recap-pipeline.js 的不满额分支：adds > 0 才跑（本轮没新增就不花 LLM 调用）。
 */
export const MERGE_EAGER_THRESHOLD_RATIO = 0.75;

/** 轻量合并每轮复盘最多试几对（见上：不满额是顺手清理，不许多花）。 */
export const MERGE_EAGER_MAX_ROUNDS = 2;

/** 合并产物的四字段（形状与手册条目同构）。 */
export const MERGE_FIELDS = ['title', 'condition', 'action', 'rationale'];

/**
 * 合并提示词（四段式：目标 / 只做什么 / 不做什么（含反例）/ 输出契约）。
 * 单独成常量而不是塞进 REFLECTOR_SYSTEM：合并与提炼是两个任务，
 * 提示词混在一起会让模型把「提炼新经验」和「改写两条旧经验」搅在一块。
 */
export const MERGE_SYSTEM = [
  '你是 ACE 手册的合并执行器。给你两条**已经判定为讲同一件事**的经验，你要把它们合成一条更好的经验。',
  '',
  '## 目标',
  '把两条内容重叠的经验合并成**一条**：保留两边各自独有的可执行细节，去掉重复表述，',
  '让人读完就知道「什么场景下、具体怎么做」。合并后的条目必须比原来任意一条更完整或更精炼，',
  '绝不能只是把两条拼在一起。',
  '',
  '## 只做什么',
  '1. 只输出四字段：title / condition / action / rationale。',
  '2. title：写「做什么 + 什么场景」，让人一眼知道这条经验管什么事。',
  '3. condition：写成「当……时」的触发式条件，必须含**用户真会说出口的词**（将来复现这个场景时，',
  '   检索用的就是这些词）。',
  '4. action：动词开头，一步一步可以照做。',
  '5. rationale：写清为什么这么做，把两条原文里**具体**的细节（踩过的坑、实测数字、失败现象）留下来。',
  '',
  '## 不做什么',
  '1. 不写「见上文」「同上」「这两条」之类指代——合并后的条目要能独立读懂。',
  '2. 不写一次性事实（本次改了哪个文件、这一轮跑了什么命令、某天发生了什么）。',
  '3. 不写只在本仓库/本任务成立的东西（具体文件名、编号、日期、本机路径）。',
  '4. 不许丢掉任何一边独有的可执行步骤：如果两条各自有一个关键动作，合并后两个都要在。',
  '5. 反例（这样写是错的）：',
  '   {"title":"合并两条经验","condition":"当需要合并时","action":"把两条内容合成一条","rationale":"两条重复"}',
  '   —— 错在：标题没说什么场景、条件里没有用户会说的词、做法不可照做、依据没有任何细节。',
  '6. 正例（这样写是对的）：',
  '   {"title":"批量重命名符号要同步全部调用点","condition":"当批量重命名某个符号时",',
  '    "action":"先 grep 列出全部调用点，改完用同一条 grep 复核命中数",',
  '    "rationale":"漏改源于没先枚举调用点，实测两次返工都因直接改定义处收工"}',
  '',
  '## 输出契约',
  '只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块：',
  '{"title":"...","condition":"...","action":"...","rationale":"..."}',
].join('\n');

/** 把一对条目渲染成合并请求的 user 文本（只给这一对的正文，不给整本手册）。 */
export function mergePairInput(a, b) {
  const block = (label, e) => [
    '### ' + label,
    '标题：' + (e?.title || ''),
    '条件：' + (e?.condition || ''),
    '做法：' + (e?.action || ''),
  ].join('\n');
  return [
    '## 要合并的两条经验',
    block('经验 A（编号 ' + (a?.id || '') + '）', a),
    '',
    block('经验 B（编号 ' + (b?.id || '') + '）', b),
    '',
    '只输出四字段 JSON 对象（title/condition/action/rationale）：{"title":"...","condition":"...","action":"...","rationale":"..."}',
  ].join('\n');
}

/**
 * 从 LLM 原始输出里取出合法的合并结果（形状不合格 → null，绝不抛错）。
 * 校验口径：必须过 extractJsonObject（红线：LLM 输出必过 JSON 校验），
 * 且四字段都得是**非空字符串**，title 还必须非空（空标题一律拒绝）。
 *
 * @param {string} raw LLM 原始输出
 * @param {{provider?: string, model?: string}} [meta] 只用于把失败现场写得更可查（原样进 raw.jsonl）
 */
export function parseMergeResult(raw, meta) {
  let obj;
  try {
    obj = extractJsonObject(raw);
  } catch (error) {
    // 健壮性缺口 B2：解析失败先记现场（原文、字符数、错误、provider/model），再照旧返回 null。
    // 这里**不 await**：本函数是同步契约（测试与 planMerges 都按同步返回值用），
    // 而 dumpRaw 保证任何情况下都不 reject，所以挂一个 fire-and-forget 也绝不会变成未处理拒绝。
    // 要等它落定用 lib/raw-log.js 的 flushRawLog()：合并阶段收尾时 lib/recap-pipeline.js 的
    // tryMerge 会显式 await 一次，保证这一行在进程收尾前真的落盘（第 48 轮第二轮 Gap 4）。
    void dumpRaw({
      stage: 'merge',
      provider: meta && meta.provider,
      model: meta && meta.model,
      raw,
      error,
    });
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const f of MERGE_FIELDS) {
    const v = obj[f];
    if (typeof v !== 'string' || !v.trim()) return null;
    out[f] = v.trim();
  }
  return out;
}

/**
 * 在现有活跃条目里找「讲同一件事」的配对（代码的活，纯函数）。
 * 用 computePairRatios 一次算出整份语料的对称 BM25 比率矩阵（N 次打分，第 45 轮），
 * 再按入参顺序做贪心配对：每条取「未用掉的那些里比率最高且过阈值」的一条，配对互不重叠。
 *
 * 判据与旧实现（每条 a 调一次 computeMergeSuggestions）逐位一致 —— 见 computePairRatios 的注释：
 * 差别只在「选出第一对之后语料不再缩小」这点 idf 漂移；贪心顺序、平局取先、阈值判定都不变。
 * 单条比率计算抛错时整批返回 []（调用方 planMerges 还有自己的 try/catch 兜底，绝不炸复盘）。
 *
 * @param {Array<object>} entries
 * @param {{thresholdRatio?: number}} [options]
 * @returns {Array<{a: object, b: object, ratio: number}>} 互不重叠的配对（按 a 在入参里的顺序）
 */
export function findMergePairs(entries, { thresholdRatio } = {}) {
  const list = (entries || []).filter((e) => e && e.id);
  const threshold = thresholdRatio || MERGE_THRESHOLD_RATIO;
  let ratios = null;
  try {
    ratios = computePairRatios(list);
  } catch {
    return []; // 相似度计算失败 → 这一批不参与合并（绝不炸整轮）
  }
  const used = new Set();
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (used.has(a.id)) continue;
    let bestJ = -1;
    let bestRatio = -1;
    for (let j = 0; j < list.length; j++) {
      if (j === i || used.has(list[j].id)) continue;
      const ratio = pairRatioAt(ratios, i, j);
      if (ratio > bestRatio) { bestRatio = ratio; bestJ = j; } // 平局取先：与旧实现的 `ratio > best.ratio` 一致
    }
    if (bestJ < 0 || !(bestRatio >= threshold)) continue;
    const b = list[bestJ];
    used.add(a.id);
    used.add(b.id);
    pairs.push({ a, b, ratio: bestRatio });
  }
  return pairs;
}

/** 两条里谁留下：created 更早的那条（同 created 按 id 数字升序兜底）。 */
export function survivingEntry(a, b) {
  const ca = String(a?.meta?.created || '');
  const cb = String(b?.meta?.created || '');
  if (ca !== cb) return ca < cb ? a : b;
  return idNumber(a?.id) <= idNumber(b?.id) ? a : b;
}

/**
 * 跑最多 maxRounds 轮合并（每轮处理一对）。
 *
 * @param {Array<object>} entries - 活跃条目
 * @param {object} deps
 * @param {(userText: string, opts?: {maxMs?: number}) => Promise<string>} deps.ask - LLM 调用
 *   （生产上是 oneShot 的封装；第二参带本轮这次调用的毫秒上限，调用方可透传给 oneShot）
 * @param {number} [deps.maxRounds] - 最多几轮
 * @param {number} [deps.thresholdRatio] - 配对阈值
 * @param {string} [deps.date] - 归档时间戳（可注入）
 * @param {{remaining: () => number}} [deps.budget] - 剩余预算（毫秒）；给了就在每轮开头检查：
 *   `remaining() - MERGE_COMMIT_RESERVE_MS < MERGE_MIN_CALL_MS` 时停止发起新的一对（只 warn 不抛，
 *   已算出的 ops/moves 照常返回）——总时限里得给落盘留出保底时间。
 * @param {object} [deps.logger]
 * @param {string} [deps.provider] 本次合并走的路由 provider —— 只写进失败现场 raw.jsonl，不参与任何判定
 * @param {string} [deps.model] 同上（model）
 * @returns {Promise<{ops: Array<object>, moves: Array<object>, merged: Array<object>, failed: Array<object>}>}
 *   ops：对**留下的那条**的 update 操作（四字段换新）
 *   moves：另一条的归档搬移指令（reason='merged'，supersededBy=留下的 id）
 *   **永不抛错**：任何一对失败只进 failed，其余照常。
 */
export async function planMerges(entries, deps = {}) {
  const ask = typeof deps.ask === 'function' ? deps.ask : null;
  const maxRounds = Math.max(0, Math.floor(Number(deps.maxRounds ?? MERGE_MAX_ROUNDS) || 0));
  const date = typeof deps.date === 'string' && deps.date ? deps.date : nowStamp();
  const logger = deps.logger;
  // 只用于合并解析失败时把 provider/model 一起记进 raw.jsonl（第 48 轮第二轮 Gap 4）。
  const provider = typeof deps.provider === 'string' && deps.provider ? deps.provider : undefined;
  const model = typeof deps.model === 'string' && deps.model ? deps.model : undefined;
  const budget = deps.budget && typeof deps.budget.remaining === 'function' ? deps.budget : null;
  const ops = [];
  const moves = [];
  const merged = [];
  const failed = [];
  if (!ask || maxRounds <= 0) return { ops, moves, merged, failed };

  let working = (entries || []).filter((e) => e && e.id).map((e) => ({ ...e }));
  let rounds = 0;
  while (rounds < maxRounds) {
    // 预算闸（第 45 轮）：剩余时间连「保底落盘 + 一次最小调用」都不够就停手。
    // 只影响要不要**发起**下一对；已经拿到的 ops/moves 原样返回，绝不抛错（红线 12）。
    let callMaxMs;
    if (budget) {
      const left = budget.remaining() - MERGE_COMMIT_RESERVE_MS;
      if (!(left >= MERGE_MIN_CALL_MS)) {
        try { logger?.warn?.('dsh-ace: 合并剩余预算不足（还剩 ' + Math.max(0, budget.remaining()) + 'ms），停止发起新的合并对，已合并 ' + merged.length + ' 对照常落盘'); } catch { /* 日志绝不打断 */ }
        break;
      }
      callMaxMs = left; // 本次调用自己的上限：到点 oneShot 抛超时错，这一对按失败处理，不拖到队列总时限
    }
    let pairs = [];
    try {
      pairs = findMergePairs(working, { thresholdRatio: deps.thresholdRatio });
    } catch {
      pairs = [];
    }
    if (!pairs.length) break;
    const pair = pairs[0];
    rounds += 1;
    const keep = survivingEntry(pair.a, pair.b);
    const drop = keep.id === pair.a.id ? pair.b : pair.a;
    let body = null;
    try {
      const raw = await ask(mergePairInput(pair.a, pair.b), { maxMs: callMaxMs });
      body = parseMergeResult(raw, { provider, model });
    } catch (e) {
      body = null;
      failed.push({ a: pair.a.id, b: pair.b.id, reason: 'llm-error', message: String(e && e.message ? e.message : e) });
      try { logger?.warn?.('dsh-ace: 合并失败（' + pair.a.id + ' ↔ ' + pair.b.id + '），跳过这一对：' + (e && e.message ? e.message : e)); } catch { /* 日志绝不打断 */ }
    }
    if (!body) {
      if (!failed.some((f) => f.a === pair.a.id && f.b === pair.b.id)) {
        failed.push({ a: pair.a.id, b: pair.b.id, reason: 'bad-output' });
        try { logger?.warn?.('dsh-ace: 合并输出不合格（' + pair.a.id + ' ↔ ' + pair.b.id + '），跳过这一对'); } catch { /* 同上 */ }
      }
      // 这一对废了：把它从工作集里摘掉，换下一对（绝不重复试同一对，也绝不阻塞）。
      working = working.filter((e) => e.id !== pair.a.id && e.id !== pair.b.id);
      continue;
    }
    // 命中计数取两条之和（合并后的内容承接了两条各自被真实使用过的历史），
    // created 用留下那条的（它更早），updated/lastHit 用较新的那个时间点。
    const keepMeta = keep.meta || {};
    const dropMeta = drop.meta || {};
    const meta = {
      created: keepMeta.created || dropMeta.created || '',
      updated: nowStamp(),
      hits: (Number(keepMeta.hits) || 0) + (Number(dropMeta.hits) || 0),
      lastHit: String(keepMeta.lastHit || '') > String(dropMeta.lastHit || '') ? keepMeta.lastHit : dropMeta.lastHit,
      ...(keepMeta.auto ? { auto: true } : {}),
    };
    // meta 跟着 update op 一起走：applyOps 会把它并进留下那条的元数据
    // （created 沿用更早那条、hits 取两条之和、lastHit 取较新者）。
    ops.push({ op: 'update', id: keep.id, ...body, meta });
    moves.push({ id: drop.id, reason: 'merged', date, supersededBy: keep.id });
    merged.push({ keptId: keep.id, archivedId: drop.id, title: body.title, meta });
    working = working
      .filter((e) => e.id !== keep.id && e.id !== drop.id)
      .concat([{ ...keep, ...body, meta }]);
  }
  return { ops, moves, merged, failed };
}
