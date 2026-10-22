// dsh-ace 合并建议：判定「被判 new 但与某条旧条目相似度偏高」的对子。
//
// 算法：对每条新增条目，用 title+condition+action 构造查询，
// 用 scoreEntries（从 playbook.js 导出的 BM25 评分）对旧条目评分，
// 然后把候选条目本身也放进同一语料库做自评分（保证 idf 一致），
// 比较最高旧条目得分 vs 自评分：如果 topHitScore >= selfScore * MERGE_THRESHOLD_RATIO，
// 则判为疑似重复，建议合并。
//
// 证据：matchEntries/scoreEntries BM25 评分在 playbook.js（原 matchEntries L273）。

import { scoreEntries } from './playbook.js';

export const MERGE_THRESHOLD_RATIO = 0.5;

/**
 * 从 entry 构造查询文本。
 * @param {object} entry - playbook entry
 * @returns {string}
 */
function entryQuery(entry) {
  return [entry.title, entry.condition, entry.action].filter(Boolean).join(' ');
}

/**
 * 计算合并建议。
 *
 * @param {Array} existingEntries - applyOps 前的旧条目
 * @param {Array} newEntries - applyOps 后新增的条目（result.added 对应的条目）
 * @param {object} [options] - { thresholdRatio: number }
 * @returns {Array} 合并建议数组，每项 { newEntry, bestMatch, score, selfScore, ratio }
 */
export function computeMergeSuggestions(existingEntries, newEntries, options = {}) {
  const ratio = Number(options.thresholdRatio) || MERGE_THRESHOLD_RATIO;
  const existing = Array.isArray(existingEntries) ? existingEntries : [];
  const added = Array.isArray(newEntries) ? newEntries : [];
  const suggestions = [];

  for (const newEntry of added) {
    const query = entryQuery(newEntry);
    if (!query.trim()) continue;

    // 对旧条目评分
    const scoredExisting = scoreEntries(existing, query);
    if (scoredExisting.length === 0) continue;

    const topHit = scoredExisting[0]; // scoreEntries 返回按分降序

    // 自评分：把候选条目放进同一语料库（保证 idf 一致）
    const corpusWithSelf = existing.concat([newEntry]);
    const scoredSelf = scoreEntries(corpusWithSelf, query);
    // 找到自评得分（排除旧条目，只取 newEntry 自己的得分）
    const selfMatch = scoredSelf.find((s) => s.e === newEntry) ||
                      scoredSelf.find((s) => s.i === existing.length);
    const selfScore = selfMatch ? selfMatch.score : 0;

    if (selfScore <= 0) continue; // 无法计算比率

    const hitScore = topHit.score;
    const actualRatio = hitScore / selfScore;

    if (actualRatio >= ratio) {
      suggestions.push({
        newEntryId: newEntry.id,
        newEntryTitle: newEntry.title,
        bestMatchId: topHit.e.id,
        bestMatchTitle: topHit.e.title,
        score: hitScore,
        selfScore: selfScore,
        ratio: actualRatio,
      });
    }
  }

  return suggestions;
}
