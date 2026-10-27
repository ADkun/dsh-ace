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
// 缺陷 4（第 40 轮）：上面那句「下一次按 id 去重」只保证**归档侧**不重复，管不住
// **手册侧** —— 手册写失败时活跃区还列着那条已经进归档的条目，下一轮复盘会把它
// 再归档一次（重复归档），人也分不清哪边是真的。修法**不动锁内顺序**：按红线 13
// 的契约（归档条目只存在于 archive.md、手册活跃区里永远不出现它），下一次提交在
// 锁内做一次对账 —— 把「归档文件里已经有、活跃区还列着」的条目从活跃区摘掉并留一行
// dsh-ace 日志。摘掉的是错位，条目正文仍在 archive.md 里，一条都没被物理删除。
//
// **第 41 轮收紧对账口径（审计风险 1）**：只按 id 相同就摘是错的 —— archive.md 里若存在
// 同 id 但正文不同的条目（手工编辑 / 编号复用 / 旧快照覆盖），按 id 摘会把活跃区那一条的
// 正文**物理抹掉**：归档里躺着的是另一份正文，盘上任何文件都不再有活跃区那份，而对外承诺
// 是「一条都没丢」。现在只有「id 相同 **且** 正文关键字段（title/condition/action/rationale）
// 全同」才摘；同 id 但正文不同的一律**保留活跃区那条**并 warn 一句请人工确认。
// 摘与不摘都要能看见：两个生产调用点（lib/recap-pipeline.js 的复盘主路径、lib/index.js 的
// ace_curate 直写路径）都显式传了 logger —— 不传的话自愈动作在生产里一行日志都不打。
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
 * 对账比对的正文关键字段（第 41 轮）：这四项**逐字**全同才算「同一条」，meta 不参与。
 *
 * 第 42 轮起 extraLines 单列一条判据（见 sameBody）：它是挂在条目上的未知行 ——
 * 人手编辑的批注（lib/playbook.js:15「挂在该条目的 extraLines 上原样保留（人手编辑的
 * 批注不丢失）」）。不参与比对时，同 id + 四字段全同、只差批注的两条会被判「一致」，
 * 活跃区那条被摘掉，而归档里是另一份正文 —— **批注在手册与归档里同时消失**，且没有任何
 * warn（第 42 轮审计 CASE 8 实测）。
 *
 * `（未注明）` 是 writeEntryBlock（lib/entry-format.js:184-185）给空 condition / action
 * 写的占位符，落盘后读回来是这几个字而不是空串。序列化时空字段本来就写成占位符，所以
 * 「空串」与「（未注明）」在盘上完全是同一份字节 —— 归一化后再比才既安全又不会自己跟自己
 * 判不一致（第 42 轮低-1）。
 */
const RECONCILE_FIELDS = ['title', 'condition', 'action', 'rationale'];
const NAME_EMPTY_PLACEHOLDER = '（未注明）';

/**
 * 读归档失败时的 warn 去重（第 43 轮，审计低-3）：归档长期不可读（EISDIR /
 * EACCES / 人把文件写坏）时，`commitOps` 与 `commitCapacity` 两条提交路径每次都会各打
 * 一行**一模一样**的 warn，日志被同一句话刷屏，真正有用的那几行被淹掉。
 * 同一路径只在**第一次**读失败时 warn，之后静默跳过。
 *
 * 纯内存（模块级 Set），进程重启即清空 —— **不新增任何落盘文件**（红线 9）。
 * 控制流一字未动：照旧清空 archiveEntries / archiveText、照旧不阻断提交。
 * 没有 logger（或 logger 没有可用的 warn）时不记账 —— 那一行日志根本没送出去，
 * 下次仍该重试；logger 自己抛错也不记账（try/catch 兜住，去重表绝不能把提交弄挂）。
 */
const ARCHIVE_READ_WARNED = new Set();

/**
 * 读归档失败时 warn 一次（同一路径只一次）。
 * 返回值 = **是否记了账**（「这一行已经送出去、后续同路径要静默」），**不表示日志真的到了目的地**：
 * 没有 logger（或 logger 无 warn）时恒为 true（没得记账，下次仍该重试）；logger 自己抛错时是 false。
 * 全仓无调用方读这个返回值（第 44 轮 grep 确认：本文件两处 `readArchiveSnapshot` 的 catch 都是裸调用），
 * 保留是为了让「去重记没记上」在调试时一眼可见。
 */
function warnArchiveReadFailure(logger, archiveFile, error) {
  const canWarn = !!(logger && typeof logger.warn === 'function');
  const keyed = typeof archiveFile === 'string' && archiveFile ? archiveFile : null;
  if (canWarn && keyed && ARCHIVE_READ_WARNED.has(keyed)) return false;
  try {
    logger?.warn?.(
      'dsh-ace: 归档文件读取失败，本次对账（活跃区 vs archive.md）跳过，按活跃区原样提交（' + archiveFile + '）：' + ((error && error.message) || error),
    );
  } catch {
    return false;
  }
  if (canWarn && keyed) ARCHIVE_READ_WARNED.add(keyed);
  return true;
}

/** 正文单字段的比对口径：占位符 `（未注明）` 与空串归一化后逐字比（不做 trim）。 */
function sameField(a, b) {
  const norm = (v) => {
    const s = String(v ?? '');
    return s === NAME_EMPTY_PLACEHOLDER ? '' : s;
  };
  return norm(a) === norm(b);
}

/**
 * 两条条目是不是**同一条**（对账口径）：id 相同 **且** 正文关键字段全同。
 *
 * 为什么不能只看 id：archive.md 里可能有同 id 但正文不同的条目（手工编辑 / 编号复用 /
 * 旧快照覆盖）。只按 id 认账，就会把活跃区那一条的正文从盘上物理抹掉 —— 归档里躺着的是
 * 另一份正文，两个文件都不再有活跃区那一份，而对外承诺是「一条都没丢」。
 * meta（hits / created …）不参与比对：错的只是「手册那一步没写成」，不是计数。
 *
 * extraLines 必须比对（第 42 轮高-1）：这是**唯一**能承载人手批注的字段，四字段全同不代表
 * 两条一样。不一致就走 conflict 路径：保留活跃区那条 + 走既有的 misaligned warn，
 * 不新增第二种处理方式。
 *
 * 但比对**只看非空行**（第 42 轮实测修正）：解析器把条目块之间的空行、文件末尾的空行
 * 也当作「无法识别的行」塞进 extraLines —— 兜底分支是 lib/entry-format.js:175 的
 * `cur.extraLines.push(line)`（任何不认识的行走这里），而 lib/entry-format.js:189 又把
 * extraLines 逐行原样写回，所以手写手册里那些空行**永远不会**在两侧同时出现
 * （插件序列化出来的归档文件不带它们），同一份正文上 extraLines 必然不相等。
 * 用「按换行连接后逐字比」的原始写法实测（第 42 轮审计 mut-njoin）会让既有的
 * **j1 / j3 / j7 / j8**（真错位必须摘掉）变红，条号与行号对应
 * tests/archive.test.mjs:748 / 847 / 1052 / 1102（j2 与 j4 仍是绿的）：
 * 「归档写成功、手册写失败」这条自愈路径会因此失效，同一批错位永久留盘。空行不承载任何
 * 人手批注（批注必有非空文本），过滤掉它才既保住高-1 的牙、又不误伤真错位。
 * 非空行之间仍是逐字比（不做 trim：批注尾部多一个空格也算不同）。
 *
 * **已知取舍（第 43 轮写明，第 42 轮审计低-2 实测）**：只看非空行的代价是——两侧
 * extraLines **只在空行上有差异**时会判「一致」，活跃区那条独有的空行会被静默丢掉。
 * 这是**刻意付的代价**：裸比会让上面那四条真错位用例全红，自愈路径被废掉。空行不是批注
 * （批注必有非空文本），舍它换「真错位能自愈」是划算的。
 */
function sameBody(a, b) {
  if (!a || !b) return false;
  if (typeof a.id !== 'string' || !a.id || a.id !== b.id) return false;
  const fieldsSame = RECONCILE_FIELDS.every((key) => sameField(a[key], b[key]));
  if (!fieldsSame) return false;
  const lines = (v) => (Array.isArray(v) ? v : []).filter((l) => String(l).trim() !== '').join('\n');
  return lines(a.extraLines) === lines(b.extraLines);
}

/**
 * 缺陷 4 的对账（第 40 轮引入，第 41 轮收紧口径）：把活跃区条目对到归档文件里。
 *
 * 返回 { stale, conflict }：
 *   - stale    —— 归档里有**同一条**（id + 正文全同）。按红线 13 的契约它只该存在于
 *                 archive.md，活跃区那一行是「归档写成功、手册写失败」留下的错位 → 摘掉。
 *   - conflict —— 归档里只有**同 id、正文全都不同**的条目。摘掉活跃区那条 = 把它的正文从
 *                 盘上物理抹掉（归档里是另一份），所以**保留**活跃区那条，只 warn 交人工确认。
 *
 * 同 id 在归档里可能有多份（手工编辑 / 编号复用 / 旧快照覆盖都会留痕，第 42 轮低-3）：
 * 全部收集起来，**任意一份**与活跃区那条同体即判 stale。只认最后一份（后者覆盖前者的
 * byId.set）会让「活跃区那份 = 归档里较早的那一份」被误判成 conflict，那条错位就永久留盘。
 *
 * 纯函数、零 IO：两个提交路径（commitOps / commitCapacity）共用同一份口径。
 */
function reconcileWithArchive(entries, archiveEntries) {
  const active = Array.isArray(entries) ? entries : [];
  const archives = Array.isArray(archiveEntries) ? archiveEntries : [];
  const byId = new Map();
  for (const e of archives) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const bucket = byId.get(e.id);
    if (bucket) bucket.push(e);
    else byId.set(e.id, [e]);
  }
  const stale = [];
  const conflict = [];
  for (const e of active) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    const bucket = byId.get(e.id);
    if (!bucket || !bucket.length) continue;
    const same = bucket.find((archived) => sameBody(e, archived));
    if (same) stale.push(e);
    else conflict.push({ active: e, archived: bucket[bucket.length - 1] });
  }
  return { stale, conflict };
}

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
        // 第 42 轮低-2：读归档失败以前是**静默**跳过对账的（档案里有同一条也发现不了，
        // 本次对账等于没做）。控制流一个字不改，只补一行 warn 让人能从日志里看见。
        // 第 43 轮（审计低-3）：去重交给 warnArchiveReadFailure —— 归档长期不可读时，
        // 每次提交都打同一行等于刷屏；同一路径只 warn 一次（纯内存 Set，无新增落盘文件）。
        warnArchiveReadFailure(options?.logger, archiveFile, e);
        archiveEntries = [];
        archiveText = '';
      }
    }
    const emptyResult = () => ({
      added: [], updated: [], removed: [], removedEntries: [], duplicates: [],
      entries: parsed.entries, archived: [], highWater: readIdHighWater(parsed),
    });
    // —— 缺陷 4 对账（第 40 轮）——
    // 锁内硬顺序是「先写归档、再写手册」，所以最坏情形只可能是「归档里多一条、活跃区还在」
    // （见文件头）。可一旦手册那一步真的失败（Windows 上读写冲突的 EPERM 就会），
    // 那条错位会留在盘上：archive.md 说它归档了，手册还在活跃区列着它 ——
    // 下一轮复盘会把它再归档一次（白白再排一遍淘汰），人也分不清哪边是真的。
    //
    // 契约（红线 13）：归档条目只存在于 archive.md，手册的活跃区里永远不出现它。
    // 按这条契约对账，但**口径只认「id + 正文全同」**（第 41 轮收紧，见 reconcileWithArchive）：
    // 同 id 正文也同 → 确实是「归档写成功、手册写失败」留下的错位，摘掉（正文仍在归档里）；
    // 同 id 但正文不同 → 归档里是**另一份**，摘掉活跃区那条等于把它的正文物理抹掉，
    // 所以**保留活跃区那条**并 warn 请人工确认。顺序、锁、原子写一律不变。
    const { stale: reconciled, conflict: misaligned } = reconcileWithArchive(parsed.entries, archiveEntries);
    if (reconciled.length) {
      // 红线 9：新增的自愈动作必须有一行 dsh-ace 日志，人才能在日志里看出发生过什么。
      // 调用方必须把 logger 传进来（复盘主路径 lib/recap-pipeline.js:286 与 ace_curate 直写
      // 路径 lib/index.js:1542 都显式传了），否则这一行在生产里根本不会出现。
      options?.logger?.warn?.(
        'dsh-ace: 手册活跃区里有 ' + reconciled.length + ' 条条目已经在归档文件 archive.md 里、正文完全一致（上一次「归档写成功、手册写失败」留下的错位），本次提交按契约把它们从活跃区摘掉；条目正文仍在归档里、一条都没丢，同一条 id 也不会再被归档一次：' +
          reconciled.map((e) => e.id).join(' / '),
      );
    }
    if (misaligned.length) {
      // 摘不得：归档里那份正文与活跃区这份不同，摘掉就等于把活跃区正文从盘上物理抹掉。
      options?.logger?.warn?.(
        'dsh-ace: archive.md 里有 ' + misaligned.length + ' 条同 id 但正文不同的条目（手工编辑 / 编号复用 / 旧快照覆盖都会造成），未摘除活跃区那条，请人工确认两边哪一份是真的：' +
          misaligned.map((m) => m.active.id).join(' / '),
      );
    }
    if (!safe.length && !archivePlan && !evictPlan && !reconciled.length) {
      // 整批都是冲突项、也没有归档/淘汰/对账要落盘：什么都不写，只把冲突回报给调用方。
      // （正文不一致的 misaligned **不算**要落盘的对账 —— 活跃区那条原样保留，写不写都一样。）
      return { conflicts, entriesBefore, result: emptyResult() };
    }
    const reconciledIds = new Set(reconciled.map((e) => e.id));
    let baseEntries = reconciled.length ? parsed.entries.filter((e) => !reconciledIds.has(e.id)) : parsed.entries;
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
        // 第 42 轮低-2：同 commitOps，读归档失败不再静默（控制流不变，只补一行 warn）。
        // 第 43 轮：同一路径只 warn 一次，见 warnArchiveReadFailure。
        warnArchiveReadFailure(options?.logger, archiveFile, e);
        archiveEntries = [];
        archiveText = '';
      }
    }
    // —— 缺陷 4 对账（第 40 轮引入，第 41 轮收紧口径，与 commitOps 同一个 reconcileWithArchive）——
    // 归档文件里已有的**同一条**（id + 正文全同）绝不许再在手册活跃区里列着；出现这种错位
    // 只可能是上一次「归档写成功、手册写失败」。归档是先写的那一份，是既成事实，所以这里把
    // 错位从活跃区摘掉（正文仍在 archive.md，不违反红线 7），并留一行 dsh-ace 日志（红线 9）。
    // **同 id 但正文不同**的不摘：归档里是另一份正文，摘掉就等于把活跃区这份物理抹掉 ⇒
    // 保留活跃区那条，只 warn 请人工确认。
    const { stale: reconciled, conflict: misaligned } = reconcileWithArchive(parsed.entries, archiveEntries);
    if (reconciled.length) {
      options?.logger?.warn?.(
        'dsh-ace: 手册活跃区里有 ' + reconciled.length + ' 条条目已经在归档文件 archive.md 里、正文完全一致（上一次「归档写成功、手册写失败」留下的错位），本次腾位提交按契约把它们从活跃区摘掉；条目正文仍在归档里、一条都没丢：' +
          reconciled.map((e) => e.id).join(' / '),
      );
    }
    if (misaligned.length) {
      options?.logger?.warn?.(
        'dsh-ace: archive.md 里有 ' + misaligned.length + ' 条同 id 但正文不同的条目（手工编辑 / 编号复用 / 旧快照覆盖都会造成），未摘除活跃区那条，请人工确认两边哪一份是真的：' +
          misaligned.map((m) => m.active.id).join(' / '),
      );
    }
    const reconciledIds = new Set(reconciled.map((e) => e.id));
    let baseEntries = reconciled.length ? parsed.entries.filter((e) => !reconciledIds.has(e.id)) : parsed.entries;
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
