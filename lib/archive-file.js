/**
 * 归档文件（archive.md）的读写：手册的「归档条目」搬进这个与手册同目录的独立文件。
 *
 * 为什么独立（第 33 轮）：计分删掉后归档不再由「低分/过期/衰减」驱动，只剩
 * superseded / removed-by-request / evicted / merged 四种**结构原因**。归档区
 * 埋在手册末尾会带来两个实际问题：① 手册越长越难人读；② 归档条目混在手册里，
 * 解析层永远要防它漏进检索与注入。独立文件把这两件事一起解决：
 * **注入不读它、ace_playbook 整本读取也不附它，只有人能在设置页看到。**
 *
 * 格式与手册同构（同样的 ### [ace-NNN] 标题 + 四字段 + 元数据行），多一行：
 *   - 归档：reason=<superseded|removed-by-request|evicted|merged> date=<毫秒时间戳> [supersededBy=ace-NNN]
 * 人可以直接读、直接手改；写入同样走 withExclusiveLock + writeFileAtomic
 * （与手册同一把锁语义，见 lib/playbook.js 的 IO 层）。
 */
import fs from 'node:fs/promises';
import {
  ARCHIVE_LINE_RE,
  ARCHIVE_REASONS,
  parseArchiveLine,
  formatArchiveLine,
  parseEntryDocument,
  serializeEntryDocument,
  writeEntryBlock,
  stampNow,
} from './entry-format.js';
import { withExclusiveLock, writeFileAtomic, applyIdHighWater } from './playbook.js';

export { ARCHIVE_REASONS };

/** 归档文件的文档头（与手册同构，只是标题与说明不同）。 */
export function initialArchiveHeader() {
  return [
    '# ACE 归档',
    '',
    '> 本文件由 dsh-ace 插件维护：**已离开活跃手册的条目**（软归档，永不物理删除）。',
    '> 注入与 ace_playbook 都**不读**这个文件，只有设置页会展示它；人可以直接编辑。',
    '> 条目格式与手册同构：### [ace-NNN] 标题，字段行 - 条件：/- 做法：/- 依据：/- 元数据：，',
    '> 外加一行 - 归档：reason=<superseded|removed-by-request|evicted|merged> date=<时间戳>。',
    '',
  ];
}

/**
 * 解析归档文件文本 → { header, entries, extraLines }。
 * entries 每条都带 archived:true 与 archive:{reason,date,supersededBy}。
 */
export function parseArchiveFile(text) {
  const parsed = parseEntryDocument(text);
  const entries = parsed.entries.map((e) => ({ ...e, archived: true, archive: e.archive || { reason: '', date: '', supersededBy: '' } }));
  return { header: parsed.header, entries, extraLines: parsed.archiveExtra };
}

/** 归档文件文本（parseArchiveFile 的逆操作）。 */
export function serializeArchiveFile({ header = [], entries = [], extraLines = [] }) {
  return serializeEntryDocument({ header, entries, archiveExtra: extraLines });
}

/** 给一条活跃条目盖上归档戳（纯函数，返回新对象，不改入参）。 */
export function markArchived(entry, { reason, date, supersededBy } = {}) {
  const stamp = typeof date === 'string' && date ? date : stampNow();
  const info = { reason: reason || '', date: stamp };
  if (supersededBy) info.supersededBy = supersededBy;
  return { ...entry, archived: true, archive: info };
}

/**
 * 读归档文件（只读、不初始化、不写盘）。文件不存在 → 空归档。
 * 解析失败（人把文件写坏了）时**抛出**，由调用方决定降级方式 ——
 * 绝不静默当成空归档，否则下一次写入会把整份归档覆盖掉（＝物理删除）。
 *
 * 返回对象带原文 `text`（第 34 轮）：编号高水位要能看见**解析不出来**的条目
 * （旧格式 `### ace-500`、空标题 `### [ace-888]` 都过不了 HEADING_RE），
 * 所以 maxArchivedIdNumber 扫的是原文的标题行，不是解析结果。text 为空串表示
 * 「归档文件不存在」；读失败（EISDIR/EACCES 等）照旧抛出。
 */
export async function readArchiveSnapshot(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { ...parseArchiveFile(text), text };
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    return { header: initialArchiveHeader(), entries: [], extraLines: [], text: '' };
  }
}

/** 读归档；不存在时写出带文档头的初始归档文件。 */
export async function readOrInitArchive(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return parseArchiveFile(text);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    const header = initialArchiveHeader();
    await writeFileAtomic(filePath, serializeArchiveFile({ header, entries: [] }));
    return { header, entries: [], extraLines: [] };
  }
}

/**
 * 把一批归档条目**追加**到归档文件（锁内读最新 → 合并 → 原子写）。
 *
 * 语义要点：
 * - 纯追加：已有的归档条目一条都不删（软归档永不物理删除）；
 * - 同一 id 重复归档时保留**先到的那条**（第二次归档是同一条目的重复触发，不覆盖历史原因）；
 * - 高水位与手册共用一套标记行：写归档时也把标记归位，保证跨两份文件取 max 时不会读低。
 */
export async function appendArchivedEntries(filePath, incoming, { highWater = 0 } = {}) {
  const list = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  if (!list.length) return { added: [], entries: [] };
  return withExclusiveLock(filePath, async () => {
    let parsed;
    try {
      parsed = await readOrInitArchive(filePath);
    } catch (e) {
      // 归档文件坏掉时绝不覆盖写：抛给调用方，宁可不归档也不能毁掉历史。
      throw e;
    }
    const seen = new Set(parsed.entries.map((e) => e.id));
    const added = [];
    for (const raw of list) {
      if (!raw || !raw.id || seen.has(raw.id)) continue;
      seen.add(raw.id);
      added.push(raw);
    }
    if (!added.length) return { added: [], entries: parsed.entries };
    const merged = [...parsed.entries, ...added];
    const next = applyIdHighWater({ header: parsed.header, entries: merged, extraLines: parsed.extraLines }, highWater);
    await writeFileAtomic(filePath, serializeArchiveFile({ header: next.header, entries: next.entries, extraLines: next.extraLines }));
    return { added, entries: merged };
  });
}

/** 标题行里的编号：`### [ace-500] 标题` / 旧格式 `### ace-500` 都能取到。 */
const HEADING_ID_RE = /\[?ace-(\d+)\]?/;
/** 「这是标题行」的判据：行首（允许缩进）三连 #。 */
const HEADING_LINE_RE = /^\s*###/;

/**
 * 归档文件里出现过的最大编号（给「编号高水位永不复用」用）。
 *
 * **边界（第 34 轮）：只扫原文里的标题行**（`^\s*###` 开头的行），不扫正文。
 * 理由：正文里可能偶然出现「ace-500」这类字样（比如依据里提到某条编号），
 * 把它算进高水位会让新编号凭空跳号；而标题行就是「一条归档条目的编号声明」，
 * 人怎么写都能认（`### [ace-500] 标题`、空标题 `### [ace-888]`、旧格式
 * `### ace-500`）—— 这三种都过不了 entry-format 的 HEADING_RE（它要求标题非空），
 * 解析结果里看不见，但编号**确实被用掉了**，所以必须扫原文。
 *
 * 入参可以是归档原文（字符串，推荐）或解析后的条目数组（兼容旧调用）。
 */
export function maxArchivedIdNumber(source) {
  let max = 0;
  const bump = (value) => {
    const n = Number(value) || 0;
    if (n > max) max = n;
  };
  if (typeof source === 'string') {
    for (const line of source.split(/\r?\n/)) {
      if (!HEADING_LINE_RE.test(line)) continue;
      const m = HEADING_ID_RE.exec(line);
      if (m) bump(m[1]);
    }
    return max;
  }
  for (const e of source || []) {
    const m = /^ace-(\d+)$/.exec(e?.id || '');
    if (m) bump(m[1]);
  }
  return max;
}

export { ARCHIVE_LINE_RE, parseArchiveLine, formatArchiveLine, writeEntryBlock };
