// 手册条目清单：设置页「记录列表详情页」的只读数据源（GET /api/dsh-ace/entries）。
//
// 只读红线：本模块只 stat / read 手册文件，**不写盘、不加锁**，不碰
// withLock / withFileLock / writeFileAtomic / commit.js / merge.js 任何写路径。
// 本文件里不会出现任何写手册的代码——它只是把既有解析结果摊平成一份可渲染的清单。
// 清单分两个分区：entries（活跃，可检索/可注入/参与淘汰）与 archived（已归档，**只读展示**，
// 永不物理删除、不参与检索与注入、不计入 maxEntries 容量）。
//
// 第 33 轮：归档从手册的「## 归档区」章节搬进**独立文件** archive.md（与手册同目录），
// 所以这里读两个文件：手册 → 活跃条目，archive.md → 归档条目。手册文件里永远不再有归档区。
//
// 分层（与 ./stats.js 同构，为了能单测）：
//   toEntry(raw)                    纯函数：parsePlaybook 的单条 entry → 固定形状的一条记录
//   toArchivedEntry(raw)            纯函数：parseArchiveFile 的一条 → 带归档信息的只读记录
//   collectEntries(parsed, opts)    纯函数：手册解析结果（或文本）+ 归档解析结果 → { ok, entries, archived, total, archivedTotal, maxEntries }
//   readPlaybookEntries(file, opts) 只读 IO：stat + readFile（手册 + archive.md）→ collectEntries
//   collectPlaybookEntries(...)     解析配置路径（相对路径在 HTTP 面解析不到时降级）
// 端点本身（lib/index.js 的 /entries 分支）只做「调它 + send」，逻辑全在这里。
//
// 复用既有解析：条目结构由 ./playbook.js 的 parsePlaybook 给出（id 补零、'- 条件：' 等标记
// 已剥掉、元数据单独收进 meta），路径解析走 ./playbook-path.js 的 resolvePlaybookFile，
// 本模块不另写一套 Markdown 解析。
//
// 空态与异常一律返回 ok:true 的结构化结果 + reason 字段，绝不抛 500：
// 与 /stats（lib/stats.js 头注）和 /inbox 的静默降级同款，让设置页其余字段照常可用。
//
// 端点写法出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// 自建同源 HTTP 路由 + prefix 注册的范式见 lib/index.js:915-918 注释所引的
// ~\dsh-insert-context\lib\index.js:601-718。

import fs from 'node:fs/promises';
import { parsePlaybook } from './playbook.js';
import { parseArchiveFile } from './archive-file.js';
import { playbookPathKind, resolvePlaybookFile, resolveArchiveFile } from './playbook-path.js';

/** reason 取值：与 /stats 的 STATS_REASONS 同名同义（见 ./stats.js:27-36）。 */
export const ENTRIES_REASONS = {
  /** playbookPath 是相对路径：HTTP 面没有会话工作目录，解析不到文件。 */
  needsSession: 'needs-session',
  /** 文件不存在（还没写过手册）。 */
  missing: 'missing',
  /** 读盘失败（权限等）。 */
  unreadable: 'unreadable',
};

/** 配置的 maxEntries 原样透传；不是有限数则 null（与 ./stats.js 的 skeleton 同口径）。 */
function normalizeMaxEntries(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 纯函数：parsePlaybook 的单条 entry → 固定形状的记录。
 * 字段顺序即契约（{ id, title, condition, action, rationale, auto, created, updated, hits, lastHit }）：
 * 正文缺失给空串，auto 恒为布尔，hits 恒为数字——客户端不必判断字段是否存在。
 *
 * 第 33 轮：helpful / harmful 随正负评分整层删除，换成 hits（命中次数，唯一淘汰依据）与
 * lastHit（最近一次命中时刻，毫秒时间戳）。created / updated / lastHit 都是毫秒精度 ISO，
 * 界面显示只取日期部分（见 lib/stats.js 的 dateKey 与 client.js 的格式化）。
 * @param {object} raw - parsePlaybook 的 entries 里的一条
 * @returns {{id:string,title:string,condition:string,action:string,rationale:string,auto:boolean,created:string,updated:string,hits:number,lastHit:string}}
 */
export function toEntry(raw) {
  const entry = raw ?? {};
  const meta = entry.meta ?? {};
  return {
    id: String(entry.id ?? ''),
    title: String(entry.title ?? ''),
    condition: String(entry.condition ?? ''),
    action: String(entry.action ?? ''),
    rationale: String(entry.rationale ?? ''),
    auto: meta.auto === true,
    created: String(meta.created ?? ''),
    updated: String(meta.updated ?? ''),
    hits: Number(meta.hits) || 0,
    lastHit: String(meta.lastHit ?? ''),
  };
}

/**
 * 纯函数：archive.md 里的归档条目 → 只读记录。
 *
 * 形状 = 活跃条目的 10 个字段 + 一个 `archive: { reason, date, supersededBy }`。
 * 为什么不做成另一套字段：客户端复用同一套行渲染，归档只多显示「归档原因 + 归档日期」两段文字。
 * 归档条目**只读展示**：没有物理删除入口（红线：归档永不物理删除），也不参与检索/注入/合并。
 *
 * @param {object} raw - parseArchiveFile 的一条（带 archived=true 与 archive）
 * @returns {object} 与 toEntry 同形 + archive
 */
export function toArchivedEntry(raw) {
  const entry = raw ?? {};
  const info = entry.archive ?? {};
  return {
    ...toEntry(entry),
    archive: {
      reason: String(info.reason ?? ''),
      date: String(info.date ?? ''),
      supersededBy: String(info.supersededBy ?? ''),
    },
  };
}

/**
 * 纯函数：手册解析结果（或手册全文）+ 归档文件解析结果 → 条目清单（活跃 + 已归档两个分区）。
 *
 * 归档条目来自**独立文件** archive.md 的 parseArchiveFile().entries（第 33 轮），
 * 这里只摊平、不重解析；total / archivedTotal 分别只数各自分区，互不混算。
 *
 * @param {object|string} parsed - parsePlaybook 的返回值，或手册 Markdown 全文
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值，原样回显给页面；只数活跃条目）
 * @param {object|string|null} [opts.archiveParsed] - parseArchiveFile 的返回值，或 archive.md 全文
 * @returns {{ok:true, entries:Array, archived:Array, total:number, archivedTotal:number, maxEntries:number|null}}
 */
export function collectEntries(parsed, { maxEntries = null, archiveParsed = null } = {}) {
  const source = typeof parsed === 'string' ? parsePlaybook(parsed) : parsed;
  const archiveSource = typeof archiveParsed === 'string' ? parseArchiveFile(archiveParsed) : archiveParsed;
  const list = Array.isArray(source?.entries) ? source.entries : [];
  const archivedList = Array.isArray(archiveSource?.entries) ? archiveSource.entries : [];
  const entries = list.map(toEntry);
  const archived = archivedList.map(toArchivedEntry);
  return {
    ok: true,
    entries,
    archived,
    total: entries.length,
    archivedTotal: archived.length,
    maxEntries: normalizeMaxEntries(maxEntries),
  };
}

/**
 * 结构化空态：ok 恒为 true，reason 说明为什么没有数据（形状与成功路径完全一致）。
 * @param {string|null} reason - ENTRIES_REASONS 里的一个值
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值）
 * @returns {{ok:true, reason:string|null, entries:Array, archived:Array, total:number, archivedTotal:number, maxEntries:number|null}}
 */
export function emptyEntries(reason, { maxEntries = null } = {}) {
  return {
    ok: true,
    reason: reason ?? null,
    entries: [],
    archived: [],
    total: 0,
    archivedTotal: 0,
    maxEntries: normalizeMaxEntries(maxEntries),
  };
}

/**
 * 只读 IO：读手册文件并摊平成条目清单。
 * 文件不存在 → reason:'missing'；读失败 → reason:'unreadable'。
 * 两种都是 ok:true 的结构化空态，不抛异常。
 * 归档文件（archive.md）读失败不影响活跃分区：归档只是只读展示，
 * 读不到就当没有（空归档），绝不因为归档文件权限问题让设置页整块 500。
 * @param {string} filePath - 手册绝对路径
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值）
 * @param {string|null} [opts.archivePath] - 归档文件绝对路径（不给则不读归档）
 */
export async function readPlaybookEntries(filePath, { maxEntries = null, archivePath = null } = {}) {
  const base = { maxEntries };
  let info;
  try {
    info = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyEntries(ENTRIES_REASONS.missing, base);
    return emptyEntries(ENTRIES_REASONS.unreadable, base);
  }
  if (!info.isFile()) return emptyEntries(ENTRIES_REASONS.unreadable, base);
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return emptyEntries(ENTRIES_REASONS.unreadable, base);
  }
  let archiveParsed = null;
  if (archivePath) {
    try {
      archiveParsed = parseArchiveFile(await fs.readFile(archivePath, 'utf8'));
    } catch {
      archiveParsed = null; // 归档读不到 → 归档分区空，活跃分区照常返回
    }
  }
  return collectEntries(parsePlaybook(text), { ...base, archiveParsed });
}

/**
 * 解析配置里的 playbookPath 再摊平。
 * 相对路径在 HTTP 面没有会话工作目录 → resolvePlaybookFile 抛 RELATIVE_PATH_NEEDS_SESSION
 * （lib/playbook-path.js:52-53），这里转成 reason:'needs-session' 的空态，而不是 500。
 * @param {string} configuredPath - 配置里的手册路径（空串 = 本机共享层）
 * @param {object} [opts]
 * @param {object} [opts.ctx] - 宿主 ctx（只用于解析 <DSH home>）
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值）
 */
export async function collectPlaybookEntries(configuredPath, { ctx, maxEntries = null } = {}) {
  const pathKind = playbookPathKind(configuredPath);
  let file;
  try {
    file = resolvePlaybookFile(configuredPath, { ctx });
  } catch {
    return { ...emptyEntries(ENTRIES_REASONS.needsSession, { maxEntries }), pathKind, playbookPath: configuredPath ?? '' };
  }
  const archivePath = resolveArchiveFile(configuredPath, { ctx });
  const result = await readPlaybookEntries(file, { maxEntries, archivePath });
  return { ...result, pathKind, playbookPath: file, archivePath };
}
