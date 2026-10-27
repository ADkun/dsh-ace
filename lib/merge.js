// dsh-ace 合并建议：判定「被判 new 但与某条旧条目相似度偏高」的对子。
//
// 算法（BM25 近似层）：
// - 比的是**正文**：condition / action / rationale，**不含 title**。
//   同标题由独立的「同标题」层负责（detectAddConflicts 的第 ② 层）——标题进 BM25 会把
//   「同领域不同经验」误判成重复：《配置里缺少超时时间》与《配置里缺少重试次数》就是这么
//   被拦下的（实测单向比率 0.601，阈值 0.5 → 误判为高度相似）。
//   正文投影的字段与 scoreEntries 实际读取的字段一致（title+condition+action+rationale，
//   lib/playbook.js 的 scoreEntries）——**scoreEntries 本身不改**：它同时是 ace_playbook 的
//   检索打分，改了会影响检索语义。
// - 比率是**对称**的：ratio = min(score(a→b)/selfScore(a), score(b→a)/selfScore(b))，
//   并钳到 1。单向比率（score/selfScore）没有上界，实测能到 1.627，渲染出来是
//   「高度相似（163%）」——相似度百分比不可能大于 100%。
// - 阈值仍是 MERGE_THRESHOLD_RATIO = 0.5。
//
// 依赖方向（单向，无循环 import）：playbook.js（基础层：解析/BM25/增量/冲突判定）
//   ← merge.js（相似度层：合并建议 + add 冲突判定）← index.js（调用层）。
// playbook.js **不** import merge.js —— 相似度原语（scoreEntries）留在 playbook.js，
// 由 merge.js 复用；add 的重复判定必须用 BM25，所以放在本文件而不是 playbook.js。
//
// add 冲突判定（缺陷 A）：并发的两个实例各 add 一条标题相同/相近的条目时，
// 后落地的那条会造出语义重复。只在「自快照以来出现过（新增或被改名）」的条目范围内拦，
// 与快照里本就存在、且未被改名的条目重复是 Curator 去重的既有职责（applyOps 的 seen 集合 +
// LLM 去重），不在这里重复拦，避免把正常流程拦死。

import { scoreEntries, normKey, normTitle, detectConflicts } from './playbook.js';

export const MERGE_THRESHOLD_RATIO = 0.5;

/**
 * 把条目投影成「只留正文」的形态（title 置空）。
 * 投影字段与 scoreEntries 实际读取的字段一致：title+condition+action+rationale。
 *
 * @param {object} entry - playbook entry
 * @returns {object} 投影后的条目（id 保留，便于回查原条目）
 */
function projectBody(entry) {
  return {
    id: entry?.id ?? '',
    title: '',
    condition: entry?.condition || '',
    action: entry?.action || '',
    rationale: entry?.rationale || '',
  };
}

/**
 * 条目的**正文**文本（BM25 层比的就是它，不含标题）。
 * @param {object} entry - playbook entry
 * @returns {string}
 */
function bodyText(entry) {
  const p = projectBody(entry);
  return [p.condition, p.action, p.rationale].map((s) => s || '').join('\n');
}

/**
 * 两条正文之间的**对称**相似比率（0..1）。
 *
 * fwd = score(b | 用 a 的正文查询) / selfScore(a)：用 a 的正文去打分 b，比上 a 打自己；
 * rev = score(a | 用 b 的正文查询) / selfScore(b)：反过来同理。
 * 取两者的较小值 —— 单向比率没有上界（实测能到 1.627），对称化并钳到 1 之后，
 * 「相似度百分比」才不可能超过 100%。
 *
 * @param {Array} corpus - 参与 idf/文档长度统计的语料（必须同时含 a 与 b）
 * @param {number} ia - a 在 corpus 里的下标
 * @param {number} ib - b 在 corpus 里的下标
 * @returns {number} 0..1 的比率
 */
function bodyRatio(corpus, ia, ib) {
  const qa = bodyText(corpus[ia]);
  const qb = bodyText(corpus[ib]);
  if (!qa.trim() || !qb.trim()) return 0;
  const byA = scoreEntries(corpus, qa); // query = a 的正文
  const byB = scoreEntries(corpus, qb); // query = b 的正文
  const selfA = byA.find((x) => x.i === ia)?.score ?? 0;
  const hitB = byA.find((x) => x.i === ib)?.score ?? 0;
  const selfB = byB.find((x) => x.i === ib)?.score ?? 0;
  const hitA = byB.find((x) => x.i === ia)?.score ?? 0;
  if (!(selfA > 0) || !(selfB > 0)) return 0;
  const r = Math.min(hitB / selfA, hitA / selfB);
  if (!(r > 0)) return 0;
  return Math.min(1, r);
}

/**
 * 计算合并建议。
 *
 * @param {Array} existingEntries - 旧条目（语料）
 * @param {Array} newEntries - 新增的条目
 * @param {object} [options] - { thresholdRatio: number }
 * @returns {Array} 合并建议数组，每项 { newEntryId, newEntryTitle, bestMatchId, bestMatchTitle, score, selfScore, ratio }
 *   ratio 是对称比率，已钳到 1（0..1）。
 */
export function computeMergeSuggestions(existingEntries, newEntries, options = {}) {
  const threshold = Number(options.thresholdRatio) || MERGE_THRESHOLD_RATIO;
  const existing = Array.isArray(existingEntries) ? existingEntries : [];
  const added = Array.isArray(newEntries) ? newEntries : [];
  const suggestions = [];

  for (const newEntry of added) {
    if (!newEntry) continue;
    if (!bodyText(newEntry).trim()) continue; // 没有正文可比（标题由同标题层负责）
    // 语料：旧条目 + 新条目自身（保证 idf 与文档长度统计一致）。
    const corpus = existing.map(projectBody).concat([projectBody(newEntry)]);
    const newIndex = corpus.length - 1;
    // 展示用的 score / selfScore：正方向（用新条目的正文去打分旧条目）。
    const byNew = scoreEntries(corpus, bodyText(newEntry));
    const selfScore = byNew.find((x) => x.i === newIndex)?.score ?? 0;
    let best = null;
    for (let i = 0; i < existing.length; i++) {
      const ratio = bodyRatio(corpus, i, newIndex);
      if (!best || ratio > best.ratio) {
        best = { i, ratio, score: byNew.find((x) => x.i === i)?.score ?? 0 };
      }
    }
    if (!best || best.ratio < threshold) continue;
    suggestions.push({
      newEntryId: newEntry.id,
      newEntryTitle: newEntry.title,
      bestMatchId: existing[best.i].id,
      bestMatchTitle: existing[best.i].title,
      score: best.score,
      selfScore,
      ratio: best.ratio,
    });
  }

  return suggestions;
}

/**
 * 一次性算出**整份语料**上所有条目两两之间的对称比率矩阵（第 45 轮）。
 *
 * 为什么要有它：findMergePairs 旧实现对每条条目 a 都调一次 computeMergeSuggestions(others, [a])，
 * 内部对 99 条各做两次全语料打分 —— 100 条手册就是 ~19900 次 scoreEntries，实测 78–110s，
 * 一轮复盘的总时限（120000ms）直接被它吃光，合并 LLM 一次都开不了。
 * 矩阵把代价压成 **N 次打分**（同一份语料 → 打分侧索引全命中 + tf 缓存全命中），实测 <0.5s。
 *
 * 数学口径与 bodyRatio 逐位一致：
 *   ratio(i,j) = min(score(j | query=body(i)) / self(i), score(i | query=body(j)) / self(j))，钳到 1；
 *   其中 self(k) = score(k | query=body(k))，全部在同一份语料（projectBody 投影，title 置空）上取值。
 *
 * 与旧实现的唯一差别（写明）：旧实现每选出一对就把 used 两条从语料里摘掉再算下一条，
 * 语料缩小会让 idf/平均长度微移；矩阵版语料固定为整份入参 —— **第一对之前两者逐位一致**，
 * 之后只差这点漂移，贪心顺序、互斥语义与阈值判定完全不变。
 *
 * @param {Array} entries - 条目（id 必填的活条目；调用方负责过滤）
 * @returns {{ corpus: Array, rows: Array<Float64Array|null>, selfs: Float64Array, n: number }}
 *   rows[i] 为 null 表示第 i 条没有正文可比（bodyText 为空）。
 */
export function computePairRatios(entries) {
  const corpus = (entries || []).map(projectBody);
  const n = corpus.length;
  const rows = new Array(n);
  const selfs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = bodyText(corpus[i]);
    if (!q.trim()) { rows[i] = null; continue; }
    const scored = scoreEntries(corpus, q);
    const row = new Float64Array(n);
    for (const s of scored) row[s.i] = s.score;
    rows[i] = row;
    selfs[i] = row[i];
  }
  return { corpus, rows, selfs, n };
}

/**
 * 从 computePairRatios 的结果里取 ratio(i,j)（对称、钳到 1，空正文 / 零自分 → 0）。
 * 与 bodyRatio 的判据逐位一致（任一 self<=0 → 0；r<=0 → 0；min(1, r)）。
 */
export function pairRatioAt(ratios, i, j) {
  if (!ratios || !ratios.rows) return 0;
  const rowA = ratios.rows[i];
  const rowB = ratios.rows[j];
  if (!rowA || !rowB) return 0;
  const selfA = ratios.selfs[i];
  const selfB = ratios.selfs[j];
  if (!(selfA > 0) || !(selfB > 0)) return 0;
  const r = Math.min(rowA[j] / selfA, rowB[i] / selfB);
  if (!(r > 0)) return 0;
  return Math.min(1, r);
}

/**
 * add 操作的冲突判定（缺陷 A：add 不参与冲突检测 → 并发 add 造出语义重复条目）。
 *
 * 只在「自快照以来出现过」的条目范围内判定：
 * - 快照里本就存在、且**未被改名**的条目 → 不拦（Curator 去重的既有职责：
 *   applyOps 的 seen 集合 + LLM 去重）；
 * - 快照之后**新出现**的条目 → 拦（两个实例并发 add 出来的重复）；
 * - 同一 id 在快照里存在、但**标题被改过**的条目 → 它的「新标题」自快照以来出现过，
 *   同标题层照样要拦（并发改名 + 并发同标题新增，磁盘上会留下两条同标题）。
 *
 * 三级判据都复用既有口径，不另造一套：
 * - 完全重复：applyOps 同一套 normKey（title+condition+action 归一化）；
 * - 同标题不同正文：normTitle（标题归一化）——标题是用户唯一可见的标识，同标题两条并存必然重复；
 * - 近似重复：computeMergeSuggestions 的**对称** BM25 比率判据（阈值 MERGE_THRESHOLD_RATIO=0.5，
 *   只比正文、比率钳到 1）。
 *
 * @param {object} snapshot - 锁外快照 { entries }
 * @param {object} latest - 锁内最新手册 { entries }
 * @param {Array} ops - 待应用的操作（只关心 op === 'add'）
 * @returns {Array} 冲突项 { index, op:'add', title, reason, matchId?, matchTitle? }
 */
export function detectAddConflicts(snapshot, latest, ops) {
  const snapEntries = (snapshot?.entries || []).filter(Boolean);
  const snapIds = new Set(snapEntries.map((e) => e.id));
  const snapById = new Map(snapEntries.map((e) => [e.id, e]));
  const latestEntries = (latest?.entries || []).filter(Boolean);
  // 自快照以来**出现过**的条目：
  // ① 复盘期间新出现的（快照里没有这个 id）；
  // ② 同一 id 在快照里存在、但**标题被改过**的（并发改名 → 新标题自快照以来出现过）。
  const sinceSnapshot = latestEntries.filter((e) => {
    if (!snapIds.has(e.id)) return true;
    return normTitle(snapById.get(e.id)) !== normTitle(e);
  });
  // 某条目是「被改名的」还是「新出现的」——只影响文案，不影响判定。
  const renamed = (e) => snapIds.has(e.id) && normTitle(snapById.get(e.id)) !== normTitle(e);
  const list = Array.isArray(ops) ? ops : [];
  const conflicts = [];
  if (!sinceSnapshot.length) return conflicts;
  list.forEach((op, index) => {
    if (!op || op.op !== 'add') return;
    const candidate = { title: op.title || '', condition: op.condition || '', action: op.action || '', rationale: op.rationale || '' };
    // ① 完全重复：normKey 口径（与 applyOps 的 seen 集合同一个函数）
    const exact = sinceSnapshot.find((e) => normKey(e) === normKey(candidate));
    if (exact) {
      conflicts.push({
        index, op: 'add', title: op.title || '',
        reason: '新增条目《' + (op.title || '') + '》与复盘期间' + (renamed(exact) ? '被改名的' : '新出现的') +
          '条目 ' + exact.id + '《' + (exact.title || '') + '》完全重复。',
        matchId: exact.id, matchTitle: exact.title || '',
      });
      return;
    }
    // ② 同标题（归一化后相同）但正文不同 → 也是重复。
    //    条目标题是用户唯一可见的标识，同标题的两条并存必然是重复；
    //    正文差异大到 BM25 比率判不出来时靠这一层兜住（单靠 BM25 会漏，见用例 T76）。
    //    范围是「自快照以来出现过该标题」的条目：含**被改名**的条目（并发改名场景）。
    const sameTitle = sinceSnapshot.find((e) => normTitle(e) === normTitle(candidate) && normTitle(candidate) !== '');
    if (sameTitle) {
      conflicts.push({
        index, op: 'add', title: op.title || '',
        reason: '新增条目《' + (op.title || '') + '》与复盘期间' + (renamed(sameTitle) ? '被改名的' : '新出现的') +
          '条目 ' + sameTitle.id + '《' + (sameTitle.title || '') + '》标题相同。',
        matchId: sameTitle.id, matchTitle: sameTitle.title || '',
      });
      return;
    }
    // ③ 近似重复：复用 computeMergeSuggestions 的**对称** BM25 比率判据（只比正文）
    const suggestions = computeMergeSuggestions(sinceSnapshot, [candidate]);
    const best = suggestions[0];
    if (best) {
      // 百分比钳到 100：比率本身已钳到 1，这里再兜一层，绝不出现「高度相似（163%）」。
      const pct = Math.min(100, Math.round(best.ratio * 100));
      conflicts.push({
        index, op: 'add', title: op.title || '',
        reason: '新增条目《' + (op.title || '') + '》与复盘期间' + (renamed(sinceSnapshot.find((e) => e.id === best.bestMatchId)) ? '被改名的' : '新出现的') +
          '条目 ' + best.bestMatchId + '《' + best.bestMatchTitle + '》高度相似（' + pct + '%）。',
        matchId: best.bestMatchId, matchTitle: best.bestMatchTitle,
      });
    }
  });
  return conflicts;
}

/**
 * 统一的逐条冲突判定入口（lib/index.js 的三条写入路径都调它）。
 *
 * update/remove 的冲突来自 playbook.js 的 detectConflicts（目标条目被改/被删/新出现）；
 * add 的冲突来自本文件的 detectAddConflicts（与自快照以来出现过的条目重复）。
 * 两者合并成一份 { conflicts, safe }：conflicts 是被拦下的那几条，safe 是照常落盘的那几条。
 *
 * @param {object} snapshot - 锁外快照 { entries }
 * @param {object} latest - 锁内最新手册 { entries }
 * @param {Array} ops - 待应用的操作
 * @returns {{ conflicts: Array, safe: Array }}
 */
export function detectAllConflicts(snapshot, latest, ops) {
  const list = Array.isArray(ops) ? ops : [];
  const base = detectConflicts(snapshot, latest, list);
  const conflicts = base.conflicts.concat(detectAddConflicts(snapshot, latest, list));
  const blocked = new Set(conflicts.map((c) => c.index));
  const safe = list.filter((_, i) => !blocked.has(i));
  return { conflicts, safe };
}
