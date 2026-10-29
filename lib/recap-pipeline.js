// dsh-ace 复盘主体流水线（从 lib/index.js 的 executeRecap 抽出的纯编排层）。
//
// 为什么要抽出来：lib/index.js 顶层 import 宿主包（@deepseek-ai/dsh-tools 等），而本仓库
// 不带 node_modules，测试里 import 不到 —— 于是「executeRecap 整链行为」长期只能靠源码正则
// 断言（审查报告 4.1/4.4 第 6 条）。抽成不依赖宿主包的模块后，测试能拿真实临时手册 +
// 假 Reflector（不调 LLM）真跑一遍整链。
//
// 这一层只做编排，不碰宿主 API：所有与宿主/插件状态相关的副作用都通过 deps 注入
// （logger、reportConflicts、noteArchived、noteWritten、reflectRound、mergeAsk）。
//
// 第 33 轮（用户拍板）：正负评分、回合成败判定、计分时序（settling/usages/pendingIds）
// 已整层删除。这里不再有 scoreUsedIds、不再有三档信号、不再有考察位与出局线。
// 现在只有一件事是自动发生的：**命中计数 hits**（唯一的淘汰依据）。
//
// 容量治理（满 maxEntries 时）的顺序是硬要求：
//   ① 先尝试 LLM 合并（lib/merge-llm.js，最多 MERGE_MAX_ROUNDS 对）；
//   ② 合并后仍超 → 按 hits 升序淘汰（lib/evict.js）；
//   ③ 被搬走的条目进独立归档文件 archive.md（reason=evicted / merged）。
// **任何一步失败都不许整批拒绝**：合并失败就跳过合并直接淘汰；淘汰计划失败就交给
// applyOps 自己判容量（最坏是整批拒绝 + 明确错误），绝不把候选悄悄丢掉、绝不让复盘失败。
//
// 依赖方向：playbook.js ← merge.js ← archive.js ← archive-file.js ← commit.js ← recap-pipeline.js ← index.js

import { readPlaybookSnapshot, withExclusiveLock, markHits } from './playbook.js';
import { decideCandidates, resolveSupersedes, dayString } from './archive.js';
import { commitOps, commitCapacity } from './commit.js';
// isTimeoutError（第 50 轮）：超时降档重试只认「超时」这一种错误，普通错误绝不重试。
import { reflectRounds, REFLECT_MAX_ROUNDS, isTimeoutError } from './reflect.js';
import { computeMergeSuggestions } from './merge.js';
import { planMerges, findMergePairs, MERGE_MAX_ROUNDS, MERGE_EAGER_THRESHOLD_RATIO, MERGE_EAGER_MAX_ROUNDS, MERGE_MIN_CALL_MS, MERGE_COMMIT_RESERVE_MS } from './merge-llm.js';
// flushRawLog：合并阶段解析失败时 parseMergeResult 只挂了个 fire-and-forget 的 dumpRaw（同步契约不许改），
// 这里在合并收尾时显式 await 一次，保证那条失败现场在进程收尾前真的落盘（第 48 轮第二轮 Gap 4）。
// 永不 reject，也不改变任何返回语义（见 ./raw-log.js 头注）。
import { flushRawLog } from './raw-log.js';
import { planEvictions } from './evict.js';
import { readInbox, writeInboxAtomic, addToInbox, inboxFull } from './inbox.js';
import { DEFAULT_MAX_ENTRIES } from './playbook-path.js';

/**
 * superseded 归档计划：commitOps 的 options.archive 钩子（锁内调用）。
 * 被更完整的候选取代掉的旧条目在这里搬进 archive.md，supersededBy 用真实分配到的 id。
 * 第 33 轮起这是**唯一**由候选判定触发的归档原因（低分/过期/衰减三判据已删）。
 */
export function makeArchivePlan(decision, ops, today) {
  return ({ result: applied }) => {
    const addedEntries = applied.entries.filter((e) => applied.added.includes(e.id));
    return resolveSupersedes(decision?.supersedes || [], ops, addedEntries, today);
  };
}

/**
 * 容量上限的入口兜底（P0-2 的接线侧）。
 *
 * lib/playbook.js 的 overflowsCapacity 把「非有限值 / <= 0」一律当成**不限**，
 * 于是只要接线时漏传 deps.maxEntries，容量上限就整个失效：3 条的手册照样能写第 4 条。
 * 这里在流水线入口把非法值收敛成默认值并 warn —— 宁可退回默认上限，也绝不让它变成「无限制」。
 *
 * @param {unknown} value deps.maxEntries（正常来自插件配置 live.maxEntries）
 * @param {object} [logger] 宿主 logger（可选链调用，测试里可传 null）
 * @returns {number} 一定是正整数
 */
export function resolveMaxEntries(value, logger) {
  if (Number.isInteger(value) && value > 0) return value;
  logger?.warn?.(
    'dsh-ace: 复盘收到无效的 maxEntries（' + String(value) + '），已按默认值 ' + DEFAULT_MAX_ENTRIES + ' 条兜底（不允许变成无限制）',
  );
  return DEFAULT_MAX_ENTRIES;
}

/**
 * 新条目保护期的入口兜底（第 36 轮，接线侧）。
 *
 * 与 resolveMaxEntries 相反：这里的非法值一律收敛成 **0（不保护）**，而不是默认 14 ——
 * 保护期是「缓一步淘汰」的软化项，配置读坏了就该退回旧的、已经被验证过的行为，
 * 绝不能凭空给一批条目加保护（那等于悄悄让容量约束更难满足）。
 *
 * @param {unknown} value deps.protectDays（正常来自插件配置 live.evictProtectDays）
 * @returns {number} 一定 >= 0；0 = 不保护
 */
export function resolveProtectDays(value) {
  const days = Math.floor(Number(value));
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * 只要「标题字符数 > 0」的候选过滤（第 33 轮：三层可复用性闸门整层删除）。
 *
 * 闸门删掉的理由：它按「标题长度上限 / 指代词 / 文件名规则」判候选可复用性，
 * 而那三条都是**启发式猜测**，实测既误杀过好条目（第 32 轮修过三处），
 * 也没能真正挡住空壳候选 —— 真正该负责召回质量的是提示词（lib/prompts.js 的
 * REFLECTOR_SYSTEM 四段式），不是代码里的字符串规则。
 *
 * 唯一保留的一条是**结构性的**：空标题条目在手册里连 ### 行都写不出来，属于坏数据。
 *
 * @param {Array<object>} candidates
 * @returns {{accepted: Array<object>, rejected: Array<{index: number, title: string, reason: string}>}}
 */
export function acceptCandidates(candidates) {
  const accepted = [];
  const rejected = [];
  (candidates || []).forEach((c, index) => {
    const title = String(c?.title ?? '');
    if (!title.trim()) {
      rejected.push({ index, title, reason: '空标题' });
      return;
    }
    accepted.push(c);
  });
  return { accepted, rejected };
}

/** 满额时给合并阶段预留的毫秒数（第 45 轮）：Reflector 每次调用的预算要扣掉它，
 *  保证合并阶段在总时限里至少还能开一次 LLM 调用（合并是满额回合的必需步骤，不能饿死）。 */
export const MERGE_PHASE_RESERVE_MS = 40000;

/**
 * 复盘的剩余预算（第 45 轮）。
 *
 * 来源：recap-queue 为每份复盘算出 `deadlineAt = startedAt + totalDeadlineMs`，经 index.js
 * 传到这里。没有 deadlineAt（测试直跑 / 旧调用方）就是「无预算」，一切行为与旧版一致。
 *
 * 切法：Reflector 的每次调用预算 = 剩余 − 合并阶段预留 − 落盘保底；合并阶段自己
 * （planMerges）再按 MERGE_MIN_CALL_MS / MERGE_COMMIT_RESERVE_MS 逐对检查。
 * 手册满额（entries.length >= maxEntries）时合并几乎必跑，所以预留必须给；
 * 不满额时合并只是轻量清理（阈值 0.75、最多 2 对），不为它扣 Reflector 的时间。
 *
 * @param {number} deadlineAt - 队列算出的绝对截止时刻（epoch ms）；0/undefined = 无预算
 * @returns {{remaining: () => number, sliceFor: (reserveMs: number) => number, enabled: boolean}}
 */
export function makeRecapBudget(deadlineAt) {
  const at = Number(deadlineAt);
  const enabled = Number.isFinite(at) && at > 0;
  const remaining = () => (enabled ? at - Date.now() : Number.POSITIVE_INFINITY);
  return {
    enabled,
    remaining,
    // 本次 LLM 调用可用的毫秒数：剩余时间扣掉 reserveMs（合并预留 / 落盘保底）。
    // 一次调用不该知道后面还有几步 —— 预算切法留给调用方，这里只管算术。
    sliceFor: (reserveMs) => remaining() - (Number(reserveMs) || 0),
  };
}

/**
 * 容量治理第一步：满额时先试合并（LLM）。
 *
 * @param {object} [overrides] 第 37 轮 B：轻量合并（不满额路径）用它换阈值与轮数，
 *   { thresholdRatio: MERGE_EAGER_THRESHOLD_RATIO, maxRounds: MERGE_EAGER_MAX_ROUNDS }。
 *   **不传就是满额路径的老行为**（0.5 / MERGE_MAX_ROUNDS）—— 满额路径一字未动。
 * @returns {Promise<{ops: Array<object>, moves: Array<object>, merged: Array<object>, failed: Array<object>}>}
 *   **永不抛错**：ask 缺失、planMerges 内部炸掉都只是「这次没合并」。
 */
async function tryMerge(deps, { entries, signal, logger, date, thresholdRatio, maxRounds, budget } = {}) {
  const ask = typeof deps.mergeAsk === 'function' ? deps.mergeAsk : null;
  if (!ask) return { ops: [], moves: [], merged: [], failed: [] };
  // 路由只用来给失败现场（raw.jsonl）记 provider/model，不参与合并判定；
  // 取不到就是 undefined，raw-log.js 那边不写空壳字段（第 48 轮第二轮 Gap 4）。
  let route = null;
  try {
    route = typeof deps.mergeRoute === 'function' ? deps.mergeRoute() : null;
  } catch {
    route = null;
  }
  try {
    return await planMerges(entries, {
      ask: (userText, opts) => ask({ userText, signal, maxMs: opts?.maxMs }),
      maxRounds: Number.isFinite(Number(maxRounds)) ? maxRounds : MERGE_MAX_ROUNDS,
      thresholdRatio,
      date,
      logger,
      budget: budget && budget.enabled ? { remaining: budget.remaining } : null,
      provider: route && route.provider,
      model: route && route.model,
    });
  } catch (e) {
    try { logger?.warn?.('dsh-ace: 合并阶段整体失败（' + ((e && e.message) || e) + '），跳过合并直接进入淘汰'); } catch { /* 日志绝不打断复盘 */ }
    return { ops: [], moves: [], merged: [], failed: [] };
  } finally {
    // planMerges 里每对失败挂的是 fire-and-forget 的 dumpRaw；收尾等一次，别让失败现场随进程一起走掉。
    // flushRawLog 永不 reject（见 ./raw-log.js），这里不需要再包 try。
    await flushRawLog();
  }
}

/**
 * 复盘主体：Reflector（deps.reflectRound，多轮）→ 代码判定 → 合并/淘汰 → 原子写 → merge-inbox。
 *
 * @param {object} deps 见 lib/index.js 的调用点（全部副作用注入，便于测试真跑整链）
 * @param {{agent: object, summary: string, signal?: AbortSignal, deadlineAt?: number}} params
 *   deadlineAt（第 45 轮）：队列的总时限绝对时刻；给了就按剩余预算给每次 LLM 调用派 maxMs，
 *   让「提炼 / 合并 / 落盘」三段在 120000ms 总时限里各自有份额，不再整份撞死在总时限上。
 * @returns {Promise<{added: string[], conflicts: Array, rounds: number, merged: number, evicted: number}>}
 */
export async function runRecapPipeline(deps, { agent, summary, signal, deadlineAt }) {
  const { file, logger } = deps;
  const archiveFile = typeof deps.archiveFile === 'string' ? deps.archiveFile : '';
  // 容量上限先收敛成合法正整数：undefined / 0 / NaN 都会让 overflowsCapacity 判定为「不限」。
  const maxEntries = resolveMaxEntries(deps.maxEntries, logger);
  // 第 36 轮：新条目保护期随 deps 进来（插件配置 live.evictProtectDays）。
  const protectDays = resolveProtectDays(deps.protectDays);
  // 锁外只读快照（不写盘）；LLM 调用也全在锁外。
  // 第 39 轮 abort 检查点①（锁外、读快照之前）：provider 静默时让这一次复盘尽早放弃，
  // 不要白跑后面的 LLM 轮次。**只放在锁外**：commitOps / withExclusiveLock 内部绝不抛中断，
  // 否则会破坏「先写 archive 再写手册」的既有顺序（见 lib/commit.js 的 commitOps：先 appendArchivedEntries 再 writeFileAtomic）。
  signal?.throwIfAborted?.();
  const { entries } = await readPlaybookSnapshot(file);
  // 第 45 轮：总时限预算（deadlineAt 由队列经 index.js 传来；测试直跑没有它 = 无预算，行为不变）。
  // 满额（>= maxEntries）时合并几乎必跑，Reflector 的调用预算要扣出合并份额，否则合并永远排在后面挨饿。
  const budget = makeRecapBudget(deadlineAt);
  // C2：满额也不是无条件预留合并时间——先用纯函数 findMergePairs 算这次到底有没有
  // ≥ 阈值（MERGE_THRESHOLD_RATIO=0.5，与满额路径同一档）的配对；没有配对就不预留这 40 秒，
  // 把时间让给 Reflector 的轮次预算。
  const hasMergePair = entries.length >= maxEntries && findMergePairs(entries).length > 0;
  const mergeReserveMs = hasMergePair ? MERGE_PHASE_RESERVE_MS : 0;
  const playbookDigest = deps.digestEntries(entries).join('\n');
  // C3 多轮复盘：轮次编排在 lib/reflect.js（纯逻辑，有用例）；这里只负责「一轮怎么跑」。
  // 第 33 轮起不再有「本回合成功/失败」信号：反思只吃轨迹摘要（成败判分已删，
  // 因为一次回合的外部因素太多，归因不可靠 —— 见 DESIGN.md）。
  const { candidates, rounds } = await reflectRounds({
    maxRounds: REFLECT_MAX_ROUNDS,
    logger,
    callRound: async (round, priorCandidates) => {
      // 预算闸（第 45 轮）：剩余时间不够「这次调用 + 合并预留 + 落盘保底」时 ——
      // **已经提炼出候选**就抛带 oneShot 同款前缀的错，reflect.js 会按「本轮中断、按已有候选落盘」收尾；
      // 还什么都没有（第一轮）就照旧发起、不派 maxMs（单次上限照旧管着，总时限照旧能整份放弃）——
      // 绝不出现「预算不够干脆连第一次调用都不发、复盘空手而归」的假成功。
      const maxMs = budget.sliceFor(mergeReserveMs + MERGE_COMMIT_RESERVE_MS);
      if (budget.enabled && !(maxMs >= MERGE_MIN_CALL_MS)) {
        if (priorCandidates.length > 0) {
          throw new Error('ace: LLM 调用超时（复盘剩余预算不足 ' + Math.max(0, budget.remaining()) +
            'ms，要留给合并与落盘），第 ' + round + ' 轮不再发起');
        }
        return deps.reflectRound({ agent, summary, outcome: '', playbookDigest: round === 1 ? playbookDigest : '', priorCandidates, round, signal });
      }
      const callMaxMs = budget.enabled ? maxMs : undefined;
      try {
        return await deps.reflectRound({ agent, summary, outcome: '', playbookDigest: round === 1 ? playbookDigest : '', priorCandidates, round, signal, maxMs: callMaxMs });
      } catch (error) {
        // 第 50 轮：真超时兜底 —— 只对**超时**、且这一轮还没降过档时，用该模型声明的最低档重试一次。
        // 落点在管线而不是 lib/reflect.js：轮次编排（收敛判据 / 中断收尾）是纯逻辑，不许知道「模型有什么档位」；
        // 「这一轮为什么超时」与「降到哪一档」都是生产侧知识，必须留在管线里由 deps 注入。
        // 拿不到能力（deps.downgradeEffort 缺席）或拿不到更低的档（null）就原样上抛 —— 旧行为一字不变。
        if (!isTimeoutError(error)) throw error;
        if (typeof deps.downgradeEffort !== 'function') throw error;
        const lower = await deps.downgradeEffort({ round, priorCandidates, maxMs: callMaxMs, error });
        if (typeof lower !== 'string' || lower === '') throw error;
        // 这条日志不含「复盘失败」字样：重试是**挽救**动作，一次超时还不等于整份复盘失败
        // （tests/recap-hang.test.mjs 用「不含复盘失败」钉的就是这个语义）。
        try {
          logger?.warn?.('dsh-ace: 多轮复盘第 ' + round + ' 轮超时，已降到最低档 ' + lower + ' 重试一次');
        } catch { /* 日志绝不打断复盘 */ }
        // 重试仍失败就把那个错误原样上抛（铁律：绝不假成功）；reflect.js 按既有语义收尾，
        // 这一轮之前已回收的候选照常落盘（第 49 轮的行为不变）。
        return await deps.reflectRound({ agent, summary, outcome: '', playbookDigest: round === 1 ? playbookDigest : '', priorCandidates, round, signal, maxMs: callMaxMs, reasoningEffort: lower });
      }
    },
  });
  const stats = deps.recapStats;
  if (stats) {
    stats.recaps += 1;
    stats.candidates += candidates.length;
  }
  logger?.info?.(
    'dsh-ace: 复盘完成 第 ' + (stats ? stats.recaps : 0) + ' 次（' + rounds + ' 轮收敛），本轮候选 ' + candidates.length +
      ' 条，累计候选 ' + (stats ? stats.candidates : 0) + ' 条',
  );
  const today = dayString();

  // —— 0 候选分支：仍然要做容量治理（合并 → 淘汰），否则模型一收敛，
  //    已经超额的旧手册就永远降不下来（P0-6 的同一条理由）。 ——
  if (!candidates.length) {
    let merged = [];
    let mergeOps = [];
    if (entries.length > maxEntries) {
      const plan = await tryMerge(deps, { entries, signal, logger, date: today, budget });
      merged = plan.moves;
      mergeOps = plan.ops;
    }
    const swept = await commitCapacity(file, {
      archiveFile,
      merged,
      // 合并留下的那条必须换上新正文与「两条 hits 之和」，否则合并只搬走一条、
      // 留下的那条还是旧数据 —— 等于把一条经验悄悄丢了。ops 与 merged 成对传。
      ops: mergeOps,
      evict: planEvictions,
      maxEntries,
      protectDays,
      today,
      logger,
    });
    deps.noteArchived?.(swept.archived || []);
    if (merged.length) {
      logger?.info?.('dsh-ace: 0 候选回合的合并已落盘（只合并、不新增候选）：' +
        merged.map((m) => m.id + '→' + (m.supersededBy || '')).join('、'));
    }
    return { added: [], conflicts: [], rounds, merged: merged.length, evicted: (swept.archived || []).filter((a) => a.reason === 'evicted').length };
  }

  // 第 33 轮：候选过滤只剩「标题非空」这一条结构性判据（三层闸门整层删除）。
  const { accepted, rejected } = acceptCandidates(candidates);
  if (stats && rejected.length) {
    stats.rejected = (Number(stats.rejected) || 0) + rejected.length;
  }
  if (rejected.length) {
    logger?.info?.('dsh-ace: 拒绝 ' + rejected.length + ' 条空标题候选（' +
      rejected.map((r) => r.reason + '：' + (r.title || '（无标题）')).join('、') + '）');
  }
  // C4.1 判定权收回给代码：模型只产候选正文（title/condition/action/rationale），
  // 「新增还是覆盖、覆盖哪一条」全部由 lib/archive.js 的 decideCandidates 按写死的规则判。
  const decision = decideCandidates(entries, accepted);
  const finalOps = decision.ops;
  if (decision.supplements && decision.supplements.length) {
    logger?.info?.('dsh-ace: 近似重复（比率 ' + decision.supplements.map((s) => s.ratio.toFixed(3)).join('、') +
      '）不占新名额，改为对旧条目增量补充：' + decision.supplements.map((s) => s.oldId).join('、'));
  }
  if (decision.dropped.length) {
    logger?.info?.('dsh-ace: 候选与既有条目完全重复，丢弃 ' + decision.dropped.length + ' 条（' + decision.dropped.map((d) => d.title).join('、') + '）');
  }

  // —— 容量治理第一步：**只有会超额时才去合并**（合并要花 LLM 调用，不超额就不花） ——
  const adds = finalOps.filter((o) => o.op === 'add').length;
  const removes = finalOps.filter((o) => o.op === 'remove').length;
  const projected = entries.length + adds - removes;
  let mergeOps = [];
  let mergeMoves = [];
  // 第 39 轮 abort 检查点②（锁外、任何 LLM 合并之前）：provider 静默导致本份复盘已被放弃时，
  // 连合并 LLM 都不再花（检查点③同理：只放锁外，commitOps / withExclusiveLock 内部绝不抛中断，
  // 否则会破坏 lib/commit.js「先写 archive 再写手册」的顺序）。
  signal?.throwIfAborted?.();
  if (projected > maxEntries) {
    const plan = await tryMerge(deps, { entries, signal, logger, date: today, budget });
    mergeOps = plan.ops;
    mergeMoves = plan.moves;
    if (plan.failed.length) {
      logger?.warn?.('dsh-ace: 合并失败 ' + plan.failed.length + ' 对（' + plan.failed.map((f) => f.a + '↔' + f.b + ':' + f.reason).join('、') +
        '），跳过它们继续（绝不让复盘落盘失败）');
    }
    if (plan.merged.length) {
      logger?.info?.('dsh-ace: 合并成功 ' + plan.merged.length + ' 对（' + plan.merged.map((m) => m.archivedId + '→' + m.keptId).join('、') + '）');
    }
  } else if (adds > 0) {
    // —— 第 37 轮 B：**不满额也配对**，但只有「真的很像」才动手 ——
    //
    // 动因：满额才合并意味着手册一旦没满，两条几乎重复的经验就能一直并存到下次爆额，
    // 期间每次注入都在花双份 token 讲同一件事。但不满额时合并**不是必需的**（不合也不会
    // 丢任何东西），所以判据必须比满额严：阈值 0.75（满额 0.5）、最多 2 对（满额 5 对）。
    // 放宽阈值去「顺手清理」的代价是把不相干的经验硬并成一条 —— 那是语义污染，
    // 且被并掉的那条从此只躺在 archive.md 里，不可逆。见 lib/merge-llm.js 的常量注释。
    //
    // 只在 adds > 0 时跑：本轮没新增候选就说明手册没在长，为一次纯属「整理」的合并
    // 花一次 LLM 调用不划算（0 候选分支同理，见上面的 if）。
    // 落盘通道与满额路径**完全相同**（同一个 commitOps 的 merged + ops），归档原因仍是 merged，
    // 「先写 archive.md 再写手册」的顺序由 commitOps 保证；失败只 warn，绝不阻塞落盘。
    const plan = await tryMerge(deps, {
      entries,
      signal,
      logger,
      date: today,
      thresholdRatio: MERGE_EAGER_THRESHOLD_RATIO,
      maxRounds: MERGE_EAGER_MAX_ROUNDS,
      budget,
    });
    mergeOps = plan.ops;
    mergeMoves = plan.moves;
    if (plan.failed.length) {
      logger?.warn?.('dsh-ace: 轻量合并失败 ' + plan.failed.length + ' 对（' + plan.failed.map((f) => f.a + '↔' + f.b + ':' + f.reason).join('、') +
        '），跳过它们继续（绝不让复盘落盘失败）');
    }
    if (plan.merged.length) {
      logger?.info?.('dsh-ace: 轻量合并（不满额）成功 ' + plan.merged.length + ' 对（' + plan.merged.map((m) => m.archivedId + '→' + m.keptId).join('、') + '）');
    }
  }

  // 第 39 轮 abort 检查点③（锁外、commitOps 之前）：最后一次放弃机会。
  // 再往里就是 withExclusiveLock + 「先写 archive 再写手册」（lib/commit.js 的 commitOps：先 appendArchivedEntries 再 writeFileAtomic），
  // 那段内部绝不抛中断，否则会写出「手册改了但归档没写」的半截状态。
  signal?.throwIfAborted?.();
  // 锁覆盖整个读-改-写区间：跨进程实例不会各自读到旧版本再互相覆盖。
  // 锁内只有纯计算与落盘——没有 LLM 调用（LLM 在上面的锁外阶段已完成）。
  // 冲突的那几条不落盘、其余照常落盘（缺陷 B）。
  const ops = mergeOps.concat(finalOps);
  const { conflicts, entriesBefore, result } = await commitOps(file, { entries }, ops, maxEntries, {
    archiveFile,
    merged: mergeMoves,
    evict: planEvictions,
    protectDays,
    archive: makeArchivePlan(decision, finalOps, today),
    today,
    // 第 45 轮（审计风险 1）：logger 必须传 —— 对账自愈（lib/commit.js 的 reconcileWithArchive）
    // 只在真的摘了/退了条目时写 warn，不传就等于生产里一行日志都没有。deps.logger 见本文件 :141。
    logger,
  });
  deps.noteArchived?.(result.archived);
  deps.noteWritten?.(result, '复盘');
  if (conflicts.length) {
    // 冲突必须让用户看见：把冲突报告作为 notice 送到用户眼前（首选 followup，退回 inject）。
    deps.reportConflicts?.(agent, conflicts);
  }
  // merge-inbox：新增条目与既有条目的相似度提示（人在设置页里决定要不要合并）。
  const addedEntries = result.entries.filter((e) => result.added.includes(e.id));
  const mergeSuggestions = computeMergeSuggestions(entriesBefore, addedEntries);
  if (mergeSuggestions.length) {
    const iFile = deps.inboxPath(file);
    await withExclusiveLock(iFile, async () => {
      const current = await readInbox(iFile);
      let items = current;
      for (const s of mergeSuggestions) {
        if (inboxFull(items)) break;
        const res = addToInbox(items, s);
        items = res.items;
      }
      await writeInboxAtomic(iFile, items);
      deps.onInboxCount?.(items.length);
    });
  }
  const archived = result.archived || [];
  return {
    added: result.added,
    conflicts,
    rounds,
    merged: archived.filter((a) => a.reason === 'merged').length,
    evicted: archived.filter((a) => a.reason === 'evicted').length,
  };
}
