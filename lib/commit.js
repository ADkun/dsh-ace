// dsh-ace 手册提交：锁内「读最新 → 逐条冲突判定 → 应用安全部分 → 原子写」。
//
// 这是三条写入路径（ace_curate / 自动复盘 / /ace 的默认复盘分支）共用的核心，
// 抽成独立纯模块是为了让「真实子进程并发」用例能直接跑**生产同款**代码路径
// （lib/index.js 依赖宿主包，无法在 node --test 里加载）。
//
// 依赖方向（单向，无循环 import）：
//   lib/playbook.js（基础层：解析/BM25/增量/原子写/锁）
//     ← lib/merge.js（相似度层：合并建议 + add 冲突判定）
//       ← lib/commit.js（本文件：提交编排）← lib/index.js（宿主接入层）。
//
// 契约（缺陷 B）：
// - 冲突是**逐条**判定的：被拦下的那几条不落盘，其余安全的照常落盘；
// - 冲突以结构化形式返回（{ index, op, id, title, reason }），由调用方回报给用户；
// - 编号高水位随本批写回手册文档头（缺陷 C：id 单调不复用）。
//
// 注意：applyOps 自身的**非冲突**校验失败（非法 op / id 不存在 / 超 maxEntries）
// 仍然整批拒绝并抛错 —— 那是 I3/I4 的既有语义，不在逐条冲突判定的范围内。

import { applyOps, serializePlaybook, withExclusiveLock, writeFileAtomic, readOrInitPlaybook, readIdHighWater, applyIdHighWater } from './playbook.js';
import { detectAllConflicts } from './merge.js';

/**
 * 锁内的「读最新 → 逐条冲突判定 → 应用安全部分 → 原子写」。
 *
 * @param {string} file - 手册路径
 * @param {object} snapshot - 锁外读到的快照 { entries }
 * @param {Array} ops - 待应用的增量操作
 * @param {number} maxEntries - 条目数上限
 * @returns {Promise<{conflicts: Array, entriesBefore: Array, result: object}>}
 *   conflicts：被拦下的那几条（每项 { index, op, id, title, reason }）
 *   entriesBefore：应用前的条目（用于算合并建议）
 *   result：applyOps 的返回值（无安全项时是空结果，entries 为最新手册的条目）
 */
export async function commitOps(file, snapshot, ops, maxEntries) {
  return withExclusiveLock(file, async () => {
    const parsed = await readOrInitPlaybook(file);
    const report = detectAllConflicts(snapshot, parsed, ops);
    const conflicts = report.conflicts;
    const safe = report.safe;
    const entriesBefore = parsed.entries.slice();
    if (!safe.length) {
      // 整批都是冲突项：什么都不写，只把冲突回报给调用方。
      return { conflicts, entriesBefore, result: { added: [], updated: [], removed: [], duplicates: [], entries: parsed.entries, highWater: readIdHighWater(parsed) } };
    }
    // 编号高水位：读**整篇文档**（标记可能被挪进条目正文），取现存最大编号与标记的较大者。
    const highWater = readIdHighWater(parsed);
    const result = applyOps(parsed.entries, safe, maxEntries, highWater);
    // 编号高水位写回文档头：删除过的编号不再被复用。
    // applyIdHighWater 会清掉文档里**所有**位置的标记行，只在文档头的规范位置留一份
    // （幂等，绝不出现两份）。
    const marked = applyIdHighWater({ header: parsed.header, entries: result.entries }, result.highWater);
    await writeFileAtomic(file, serializePlaybook({ header: marked.header, entries: marked.entries }));
    return { conflicts, entriesBefore, result };
  });
}
