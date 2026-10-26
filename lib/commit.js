// dsh-ace 手册提交：锁内「读最新 → 逐条冲突判定 → 应用安全部分 → 原子写」。
//
// 这是三条写入路径（ace_curate / 自动复盘 / /ace 的默认复盘分支）共用的核心，
// 抽成独立纯模块是为了让「真实子进程并发」用例能直接跑**生产同款**代码路径
// （lib/index.js 依赖宿主包，无法在 node --test 里加载）。
//
// 依赖方向（单向，无循环 import）：
//   lib/playbook.js（基础层：解析/BM25/增量/原子写/锁）
//     ← lib/merge.js（相似度层：合并建议 + add 冲突判定）
//       ← lib/archive.js（软归档层：搬移，纯函数）
//         ← lib/archive-file.js（归档文件 archive.md 的读写）
//           ← lib/commit.js（本文件：提交编排）← lib/index.js（宿主接入层）。
//
// 契约（缺陷 B）：
// - 冲突是**逐条**判定的：被拦下的那几条不落盘，其余安全的照常落盘；
// - 冲突以结构化形式返回（{ index, op, id, title, reason }），由调用方回报给用户；
// - 编号高水位随本批写回手册文档头（缺陷 C：id 单调不复用）。
//
// 注意：applyOps 自身的**非冲突**校验失败（非法 op / id 不存在 / 超 maxEntries）
// 仍然整批拒绝并抛错 —— 那是 I3/I4 的既有语义，不在逐条冲突判定的范围内。
//
// 归档（第 33 轮）：归档条目搬进**独立文件** archive.md（lib/archive-file.js），
// 手册文件里不再有 '## 归档区' 章节。两处写盘顺序是硬约束：
//   **先追加归档文件，再写手册。** 反过来一旦手册写失败，条目会从两边一起消失
//   ＝物理删除（硬红线）。先归档后写手册最坏只是「归档里多一条、活跃区还在」，
//   下一次 appendArchivedEntries 按 id 去重，不会重复。
//
// 淘汰（第 33 轮）：活跃条目超 maxEntries 时，commitOps 在锁内按 hits 升序
// （同 hits 比 created、再比 id 数字）把最不常用的搬进归档（reason='evicted'），
// 腾出位置让本批照常落盘。判据在 lib/evict.js（纯函数，有用例钉住顺序）。
// **任何一步失败都不许整批拒绝**（第 34 轮落实）：注入的淘汰计划（options.evict）
// 抛错 / 返回不可用结果时，本文件用同一个判据 compareForEviction 当场排一遍兜底，
// 腾出同样的位数后照常落盘；只有连兜底都算不出来时才允许抛错。
// 顺序仍然是全序、确定性、不随机的 —— 兜底换的只是「谁来算」，不是判据。

import { applyOps, serializePlaybook, withExclusiveLock, writeFileAtomic, readOrInitPlaybook, readIdHighWater, applyIdHighWater, detectConflicts, maxEntryIdNumber, overflowsCapacity } from './playbook.js';
import { detectAllConflicts } from './merge.js';
import { applyArchiveMoves, dayString } from './archive.js';
import { readArchiveSnapshot, appendArchivedEntries, maxArchivedIdNumber, markArchived } from './archive-file.js';
import { compareForEviction } from './evict.js';

/**
 * 只改元数据的提交（命中计数 hits / lastHit 的写入路径）。
 *
 * 与 commitOps 同一套口径：锁内「读最新 → 逐条冲突判定 → 应用 → 原子写」，
 * 复盘期间手册被别的进程改过的条目走 detectConflicts 拦下并回报，绝不静默覆盖。
 * 冲突判据复用 update 型 op（entryFingerprint 只看四字段正文、不含 meta，
 * 所以「别人只改了计数字段」不会被误判成冲突）。
 *
 * 本函数**不分配编号**，所以高水位只读手册自身（归档条目的编号必然 ≤ 手册标记：
 * 它们都是先在手册里分配、写进标记行之后才被搬走的）。
 *
 * @param {string} file - 手册路径
 * @param {object} snapshot - 锁外读到的快照 { entries }
 * @param {{ids: string[], apply: (entries: object[], safeIds: string[]) => {entries: object[], changed: string[]}}} spec
 *   ids：打算计数的条目 id；apply：纯函数，返回新条目数组与被实际改动的 id
 * @returns {Promise<{conflicts: Array, changed: string[], entries: Array}>}
 */
export async function commitMeta(file, snapshot, spec) {
  const ids = Array.isArray(spec?.ids) ? spec.ids : [];
  const apply = spec?.apply;
  if (typeof apply !== 'function') throw new Error('ace: commitMeta 需要 apply 纯函数');
  return withExclusiveLock(file, async () => {
    const parsed = await readOrInitPlaybook(file);
    const ops = ids.map((id) => ({ op: 'update', id }));
    const report = detectConflicts(snapshot, parsed, ops);
    const conflicts = report.conflicts;
    const safeIds = report.safe.map((op) => op.id);
    if (!safeIds.length) return { conflicts, changed: [], entries: parsed.entries };
    const transformed = apply(parsed.entries, safeIds);
    const changed = Array.isArray(transformed?.changed) ? transformed.changed : [];
    if (!changed.length) return { conflicts, changed: [], entries: transformed.entries };
    const highWater = Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []));
    const marked = applyIdHighWater({ header: parsed.header, entries: transformed.entries, extraLines: parsed.extraLines }, highWater);
    await writeFileAtomic(file, serializePlaybook({ header: marked.header, entries: marked.entries, extraLines: marked.extraLines }));
    return { conflicts, changed, entries: transformed.entries };
  });
}

/**
 * 算淘汰搬移指令，**计划坏了就兜底**（第 34 轮）。
 *
 * 为什么要兜底：options.evict 由调用方注入（生产是 lib/evict.js 的 planEvictions）。
 * 它一旦抛错，若只做到「不抛错」而指令留空，后面 applyOps 的容量校验就会
 * **整批拒绝**整回合的候选 —— 「任何一步失败都不许整批拒绝」的红线当场破。
 *
 * 兜底判据与 lib/evict.js **同一个** compareForEviction（hits 升序 → created 更早 →
 * id 数字升序；全序、确定性、绝不随机），只是换了个「谁来算」。N = 需要腾出的位数。
 * 保护集（刚合并出来的条目）不参与淘汰，与主路径一致。
 * protectDays（第 36 轮）只影响**先淘汰谁**：新条目优先靠后，够不够兜底由 lib/evict.js 定，
 * 要腾出的位数 N 一位不减 —— 保护期绝不能变成「容量约束的绕过口」。
 *
 * @returns {Array<{id: string, reason: string, date: string}>} 保底为空数组（不抛错）
 */
function planEvictionMoves(evictPlan, entries, protectedIds, need, today, protectDays, logger) {
  const pool = (entries || []).filter((e) => e && e.id && !protectedIds.has(e.id));
  const want = Math.max(0, Math.floor(Number(need) || 0));
  const fallback = () => {
    const sorted = pool.slice().sort(compareForEviction);
    return sorted.slice(0, Math.min(want, sorted.length)).map((e) => ({ id: e.id, reason: 'evicted', date: today }));
  };
  let moves = null;
  try {
    // protectDays 透传给 planEvictions：新条目保护期只改「先淘汰谁」，不改要腾出的位数。
    moves = evictPlan(pool, want, { date: today, protectDays });
  } catch (e) {
    moves = null;
  }
  if (!Array.isArray(moves)) {
    moves = fallback();
    logger?.warn?.(
      'dsh-ace: 淘汰计划失败，已改用内置兜底（按 compareForEviction 全序排序取前 ' + want +
        ' 条，顺序仍确定不随机），本批候选照常落盘',
    );
  }
  return moves;
}

/**
 * 锁内的「读最新 → 逐条冲突判定 → 合并/淘汰腾位 → 应用安全部分 → 软归档 → 原子写」。
 *
 * @param {string} file - 手册路径
 * @param {object} snapshot - 锁外读到的快照 { entries }
 * @param {Array} ops - 待应用的增量操作（可含 merge 阶段产出的 update）
 * @param {number} maxEntries - 活跃条目数上限（归档条目**不计入**）
 * @param {object} [options]
 * @param {string} [options.archiveFile] 归档文件路径（archive.md）。给了才会写归档；
 *   不给时归档条目只从活跃区消失而不落盘 —— **生产路径必须给**（否则＝物理删除）。
 * @param {Array<{id:string, reason?:string, date?:string, supersededBy?:string}>} [options.merged]
 *   LLM 合并阶段产出的搬移指令（reason='merged'）。这些 id 在腾位时被保护，不会被同批淘汰。
 * @param {(ctx: object) => Array} [options.archive]
 *   软归档钩子（superseded）。在锁内、applyOps 之后调用，入参 { result, entriesBefore }，
 *   返回要搬到归档的指令 [{id, reason, date?, supersededBy?}]。
 * @param {(ctx: {entries: object[], need: number, date: string}) => Array} [options.evict]
 *   淘汰计划钩子。**只在超容量时调用**，入参是「应用前的活跃条目 + 需要腾出的条数」，
 *   返回 [{id, reason, date}]。生产路径传 lib/evict.js 的 planEvictions。
 * @param {string} [options.today] 归档日期戳（默认现在，毫秒时间戳）
 * @returns {Promise<{conflicts: Array, entriesBefore: Array, result: object}>}
 *   conflicts：被拦下的那几条（每项 { index, op, id, title, reason }）
 *   entriesBefore：应用前的活跃条目（用于算合并建议）
 *   result：applyOps 的返回值 + archived（本次归档的 {id, reason, supersededBy?} 列表）
 */
export async function commitOps(file, snapshot, ops, maxEntries, options = {}) {
  const archivePlan = typeof options?.archive === 'function' ? options.archive : null;
  const evictPlan = typeof options?.evict === 'function' ? options.evict : null;
  const archiveFile = typeof options?.archiveFile === 'string' && options.archiveFile ? options.archiveFile : '';
  const today = typeof options?.today === 'string' && options.today ? options.today : dayString();
  return withExclusiveLock(file, async () => {
    const parsed = await readOrInitPlaybook(file);
    const report = detectAllConflicts(snapshot, parsed, ops);
    const conflicts = report.conflicts;
    const safe = report.safe;
    const entriesBefore = parsed.entries.slice();
    // 归档文件的**原文**：编号高水位要能看见解析不出来的条目（见 maxArchivedIdNumber）。
    // 读归档失败（EISDIR/EACCES/人把文件写坏）在这里只清空 archiveEntries，
    // **不阻断提交** —— 真正的保证落在写盘那一步：真要把条目搬走时，
    // appendArchivedEntries 会再读一次归档并抛错，于是手册一个字都不写。
    let archiveEntries = [];
    let archiveText = '';
    if (archiveFile) {
      try {
        const snapshot = await readArchiveSnapshot(archiveFile);
        archiveEntries = snapshot.entries;
        archiveText = typeof snapshot.text === 'string' ? snapshot.text : '';
      } catch (e) {
        archiveEntries = [];
        archiveText = '';
      }
    }
    const emptyResult = () => ({
      added: [], updated: [], removed: [], removedEntries: [], duplicates: [],
      entries: parsed.entries, archived: [], highWater: readIdHighWater(parsed),
    });
    if (!safe.length && !archivePlan && !evictPlan) {
      // 整批都是冲突项、也没有归档/淘汰要落盘：什么都不写，只把冲突回报给调用方。
      return { conflicts, entriesBefore, result: emptyResult() };
    }
    let baseEntries = parsed.entries;
    // 本次要搬进归档文件的**完整条目**（正文一个字都不能丢）。
    const toArchive = [];
    const archived = [];
    const noteArchived = (entry) => {
      archived.push({ id: entry.id, reason: entry.archive?.reason || '', supersededBy: entry.archive?.supersededBy || '' });
    };
    const mergeMoves = Array.isArray(options?.merged) ? options.merged : [];
    // —— 第一步：LLM 合并（锁外已算好）。合并成功的那条正文写进 update op（在 safe 里），
    // 另一条在这里搬走。合并后的条数下降，直接影响后面要不要淘汰。 ——
    if (mergeMoves.length) {
      const applied = applyArchiveMoves(baseEntries, [], mergeMoves, today);
      baseEntries = applied.entries;
      for (const e of applied.moved) { toArchive.push(e); noteArchived(e); }
    }
    // 合并后仍在场的条目 id：这些是「刚花了一次 LLM 调用合出来的结果」，同批不许再被淘汰掉。
    const protectedIds = new Set(mergeMoves.map((m) => m.supersededBy).filter(Boolean));
    // —— 第二步：超容量时按「最少使用」淘汰腾位 ——
    // 判据（lib/evict.js）：hits 升序 → created 更早 → id 数字升序。
    // 计划坏了就**当场兜底**（见 planEvictionMoves）：腾出同样的位数，本批候选照常落盘。
    // 只有连兜底都算不出来才抛错 —— 那种情况下表格已经腾不出位，整批拒绝是唯一出路。
    if (evictPlan) {
      const addCount = safe.filter((o) => o.op === 'add').length;
      const removeCount = safe.filter((o) => o.op === 'remove').length;
      if (overflowsCapacity(baseEntries.length, addCount, removeCount, maxEntries)) {
        const projected = baseEntries.length + addCount - removeCount;
        const need = Math.max(0, projected - maxEntries);
        const moves = planEvictionMoves(evictPlan, baseEntries, protectedIds, need, today, options?.protectDays, options?.logger);
        if (Array.isArray(moves) && moves.length) {
          const applied = applyArchiveMoves(baseEntries, [], moves, today);
          baseEntries = applied.entries;
          for (const e of applied.moved) { toArchive.push(e); noteArchived(e); }
        }
      }
    }
    // 编号高水位：读**整篇文档**（标记可能被挪进条目正文），取现存最大编号与标记的较大者；
    // 归档文件里的编号同样是「用过的编号」，必须并进来（归档是软删除，编号绝不复用）。
    // 必须在「腾位」**之后**算：腾位会把活跃条目搬进归档，若先算，被搬走的那些编号
    // 只剩文档头标记兜底 —— 手写手册（没有标记行）下新条目会复用刚被搬走的编号。
    // 归档那一项扫的是**归档原文的标题行**：旧格式 / 空标题的条目解析不出来，但编号确实被用掉了。
    const highWater = Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries));
    const result = applyOps(baseEntries, safe, maxEntries, highWater);
    // 显式 remove 是**软删除**：applyOps 把被删条目放进 result.removedEntries（带 archived:true +
    // archive.reason='removed-by-request'），这里把它们并进归档文件一起落盘。
    // 绝不物理删除 —— 归档文件是唯一的历史账本，编号高水位也靠它兜底。
    if (result.removedEntries && result.removedEntries.length) {
      for (const e of result.removedEntries) { toArchive.push(e); noteArchived(e); }
    }
    // —— 第三步：superseded（候选更完整、旧条目被取代）——
    if (archivePlan) {
      const moves = archivePlan({ result, entriesBefore }) || [];
      const applied = applyArchiveMoves(result.entries, [], moves, today);
      result.entries = applied.entries;
      for (const e of applied.moved) {
        if (archived.some((a) => a.id === e.id)) continue;
        toArchive.push(e);
        noteArchived(e);
      }
    }
    result.archived = archived;
    const dirty = safe.length > 0 || archived.length > 0 || result.entries.length !== parsed.entries.length;
    if (!dirty) return { conflicts, entriesBefore, result };
    // 编号高水位写回文档头：删除过的编号不再被复用。
    // applyIdHighWater 会清掉文档里**所有**位置的标记行，只在文档头的规范位置留一份
    // （幂等，绝不出现两份）。
    const marked = applyIdHighWater({ header: parsed.header, entries: result.entries, extraLines: parsed.extraLines }, result.highWater);
    // **先归档、后写手册**：见文件头的红线说明。归档写失败就整体抛错（宁可不写，
    // 也绝不让条目从活跃区消失却没进归档）。
    if (archiveFile && toArchive.length) {
      await appendArchivedEntries(archiveFile, toArchive, { highWater: result.highWater });
    }
    await writeFileAtomic(file, serializePlaybook({ header: marked.header, entries: marked.entries, extraLines: marked.extraLines }));
    return { conflicts, entriesBefore, result };
  });
}

/**
 * 只做「容量治理」的提交（0 候选回合也要跑的那一步）。
 *
 * 计分删掉后归档不再由「低分/过期/衰减」驱动，只剩两种**结构性**原因会在没有候选时
 * 发生：merged（LLM 合并，锁外算好传进来）与 evicted（超容量淘汰）。本函数把它们
 * 包一次锁内读-改-写，写盘顺序与 commitOps 一致（先归档、后手册）。
 *
 * 合并（第 33 轮）分两步：`merged` 是**搬移指令**（把被并掉那条搬进归档），
 * `ops` 是对**留下那条**的 update（LLM 合成的新正文 + 两条 hits 之和）。
 * 只传 merged 不传 ops 会让留下的那条保持旧正文与旧 hits —— 合并就白做了，
 * 所以这两个参数必须成对传进来。
 *
 * 没有任何搬移、也没有 ops 时**不写盘**（绝不空写一遍文件）。
 *
 * 失败不许阻塞落盘：ops 应用出错只 warn 一句、跳过它，搬移照常落盘；
 * 淘汰计划算不出来就走内置兜底（planEvictionMoves，同一判据当场排一遍）。
 * 任何一步都不整批拒绝。
 *
 * @param {string} file - 手册路径
 * @param {object} [options] 同 commitOps 的 archiveFile / merged / evict / today，
 *   外加 ops（合并留下的那条的 update）与 logger
 * @returns {Promise<{archived: Array, entries: object[]}>}
 */
export async function commitCapacity(file, options = {}) {
  const archiveFile = typeof options?.archiveFile === 'string' && options.archiveFile ? options.archiveFile : '';
  const today = typeof options?.today === 'string' && options.today ? options.today : dayString();
  const evictPlan = typeof options?.evict === 'function' ? options.evict : null;
  const maxEntries = options?.maxEntries;
  return withExclusiveLock(file, async () => {
    const parsed = await readOrInitPlaybook(file);
    let archiveEntries = [];
    let archiveText = '';
    if (archiveFile) {
      try {
        const snapshot = await readArchiveSnapshot(archiveFile);
        archiveEntries = snapshot.entries;
        archiveText = typeof snapshot.text === 'string' ? snapshot.text : '';
      } catch (e) {
        archiveEntries = [];
        archiveText = '';
      }
    }
    let baseEntries = parsed.entries;
    const toArchive = [];
    const archived = [];
    const mergeMoves = Array.isArray(options?.merged) ? options.merged : [];
    if (mergeMoves.length) {
      const applied = applyArchiveMoves(baseEntries, [], mergeMoves, today);
      baseEntries = applied.entries;
      for (const e of applied.moved) { toArchive.push(e); archived.push({ id: e.id, reason: e.archive?.reason || '', supersededBy: e.archive?.supersededBy || '' }); }
    }
    // 合并留下的那条要换新正文与新元数据（hits 取两条之和）。这是**根据** mergeMoves
    // 推导出来的同一次动作，所以搬移完成之后再应用 ops。失败只跳过 ops —— 搬移照常落盘，
    // 绝不让「合并合成失败」变成「本回合什么都不写」。
    const mergedOps = Array.isArray(options?.ops) ? options.ops : [];
    if (mergedOps.length) {
      try {
        // 合并只 update 已存在的条目，不分配编号 → 容量无上限、高水位用同一口径（取最大者，永不复用）。
        const hw = Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries));
        baseEntries = applyOps(baseEntries, mergedOps, Number.POSITIVE_INFINITY, hw).entries;
      } catch (e) {
        options?.logger?.warn?.('dsh-ace: 合并后的正文更新未能应用（' + ((e && e.message) || e) + '），被并掉的条目照常归档，留下的那条保持原样');
      }
    }
    const protectedIds = new Set(mergeMoves.map((m) => m.supersededBy).filter(Boolean));
    if (evictPlan && overflowsCapacity(baseEntries.length, 0, 0, maxEntries)) {
      const need = Math.max(0, baseEntries.length - maxEntries);
      const moves = planEvictionMoves(evictPlan, baseEntries, protectedIds, need, today, options?.protectDays, options?.logger);
      if (Array.isArray(moves) && moves.length) {
        const applied = applyArchiveMoves(baseEntries, [], moves, today);
        baseEntries = applied.entries;
        for (const e of applied.moved) { toArchive.push(e); archived.push({ id: e.id, reason: e.archive?.reason || '', supersededBy: e.archive?.supersededBy || '' }); }
      }
    }
    const changedEntries = baseEntries !== parsed.entries;
    if (!toArchive.length && !changedEntries) return { archived: [], entries: parsed.entries };
    // 四项口径与 commitOps 完全一致：文档标记 + 快照编号 + 归档原文编号 + 腾位后的在场编号。
    const highWater = Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries));
    const marked = applyIdHighWater({ header: parsed.header, entries: baseEntries, extraLines: parsed.extraLines }, highWater);
    if (archiveFile) await appendArchivedEntries(archiveFile, toArchive, { highWater });
    await writeFileAtomic(file, serializePlaybook({ header: marked.header, entries: marked.entries, extraLines: marked.extraLines }));
    return { archived, entries: baseEntries };
  });
}

export { markArchived };
