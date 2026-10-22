// 手册统计：设置页「ACE 手册」页顶部只读统计块的数据源（GET /api/dsh-ace/stats）。
//
// 只读红线：本模块只 stat / read 手册文件，**不写盘、不加锁**，不碰
// withLock / withFileLock / writeFileAtomic / commit.js / merge.js 任何写路径。
// 统计是观察者，不是写入方；因此这里也不产生任何新的元数据写入。
//
// 分层（为了能单测）：
//   summarizePlaybook(text, opts)  纯函数：文本 → 统计结构（不碰 IO）
//   readPlaybookStats(file, opts)  只读 IO：stat + readFile → summarizePlaybook
//   collectPlaybookStats(...)      解析配置路径（相对路径在 HTTP 面解析不到时降级）
// 端点本身（lib/index.js 的 /stats 分支）只做「调它 + send」，逻辑全在这里。
//
// 空态与异常一律返回 ok:true 的结构化结果 + reason 字段，绝不抛 500：
// 与 /inbox 的静默降级同款（lib/index.js:962-975），让设置页其余字段照常可用。

import fs from 'node:fs';
import { parsePlaybook } from './playbook.js';
import { playbookPathKind, resolvePlaybookFile } from './playbook-path.js';

/** 时间分布窗口：最近 14 天（每天一行）。 */
export const STATS_WINDOW_DAYS = 14;
/** 「最近更新」列表长度。 */
export const RECENT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** reason 取值（客户端据此选文案，见 client.js 的 statsReason* 字典项）。 */
export const STATS_REASONS = {
  /** playbookPath 是相对路径：HTTP 面没有会话工作目录，解析不到文件。 */
  needsSession: 'needs-session',
  /** 文件不存在（还没写过手册）。 */
  missing: 'missing',
  /** 文件存在但没有任何条目（空文件 / 只有文档头）。 */
  noEntries: 'no-entries',
  /** 读盘失败（权限等）。 */
  unreadable: 'unreadable',
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD HH:mm'（本地时区，与手册元数据里的日期同口径）。 */
export function formatStamp(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
export function dateKey(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * 条目正文字符数：title + condition + action + rationale。
 * parsePlaybook 已经把 '- 条件：' 这类 Markdown 标记剥掉、元数据行单独收进 meta，
 * 所以这里量的就是正文本身（不含标记与元数据）。
 */
export function entryTextChars(entry) {
  const e = entry ?? {};
  return ['title', 'condition', 'action', 'rationale']
    .reduce((sum, field) => sum + String(e[field] ?? '').length, 0);
}

/** 条目日期：优先 meta.updated，缺省回落到 meta.created；都没有则空串。 */
export function entryStamp(entry) {
  const meta = entry?.meta ?? {};
  const updated = String(meta.updated ?? '').trim();
  if (updated) return updated;
  return String(meta.created ?? '').trim();
}

/**
 * recent 排序用的编号取号：'ace-1000' → 1000。
 * 必须按数值而不是字符串比较（字符串序里 'ace-999' > 'ace-1000'）；取不到编号的返回 -1。
 */
export function recentIdNumber(id) {
  const m = /^ace-(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : -1;
}

/** 'YYYY-MM-DD'（或带时间的字符串）→ 'YYYY-MM-DD'；不是合法日期则 null。 */
export function toDayKey(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}

/** 统计结构的骨架：所有分支都返回同一组字段，客户端不必判断字段是否存在。 */
function skeleton({ now, maxEntries, pathKind, playbookPath, filePath }) {
  return {
    ok: true,
    reason: null,
    generatedAt: formatStamp(now),
    pathKind: pathKind ?? null,
    playbookPath: playbookPath ?? null,
    file: filePath ?? null,
    scale: {
      entries: 0,
      maxEntries: typeof maxEntries === 'number' && Number.isFinite(maxEntries) ? maxEntries : null,
      textChars: 0,
      bytes: 0,
      mtime: null,
    },
    source: { auto: 0, total: 0, autoRatio: 0 },
    windowDays: STATS_WINDOW_DAYS,
    dailyMax: 0,
    daily: emptyDaily(now),
    recent: [],
  };
}

/** 14 天全零的时间分布（空态也返回同样长度，客户端条形图不必特判）。 */
function emptyDaily(now) {
  const at = now instanceof Date ? now : new Date(now ?? Date.now());
  const base = Number.isNaN(at.getTime()) ? new Date() : at;
  const rows = [];
  for (let i = STATS_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    rows.push({ date: dateKey(new Date(base.getTime() - i * DAY_MS)), count: 0 });
  }
  return rows;
}

/**
 * 结构化空态：ok 恒为 true，reason 说明为什么没有数据。
 * 客户端只把 reason 翻译成一行灰字引导，不弹错、不阻塞整页。
 */
export function emptyStats(reason, { now = new Date(), maxEntries = null, pathKind = null, playbookPath = null, file = null } = {}) {
  const stats = skeleton({ now, maxEntries, pathKind, playbookPath, filePath: file });
  stats.reason = reason ?? null;
  return stats;
}

/**
 * 纯函数：手册文本 → 统计结构。
 * @param text 手册 Markdown 全文（空串 = 空手册）。
 * @param opts.filePath 手册绝对路径（原样回显给页面）。
 * @param opts.size 文件字节数；不传则按 text 的 UTF-8 长度算。
 * @param opts.mtime 最后写入时间（Date 或毫秒）；不传则为 null。
 * @param opts.maxEntries 容量上限（配置值，用于「35 / 100」占用显示）。
 * @param opts.now 计算 14 天窗口的基准时刻（可注入，便于测试）。
 */
export function summarizePlaybook(text, opts = {}) {
  const { filePath = null, size = null, mtime = null, maxEntries = null, now = new Date(), pathKind = null, playbookPath = null } = opts;
  const source = String(text ?? '');
  const stats = skeleton({ now, maxEntries, pathKind, playbookPath, filePath });
  stats.scale.bytes = typeof size === 'number' && Number.isFinite(size) ? size : Buffer.byteLength(source, 'utf8');
  stats.scale.mtime = mtime === null || mtime === undefined ? null : formatStamp(mtime);
  stats.scale.entries = 0;
  if (source.trim() === '') {
    stats.reason = STATS_REASONS.noEntries;
    return stats;
  }

  const parsed = parsePlaybook(source);
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  stats.scale.entries = entries.length;
  stats.scale.textChars = entries.reduce((sum, entry) => sum + entryTextChars(entry), 0);
  stats.source.total = entries.length;
  stats.source.auto = entries.filter((entry) => entry?.meta?.auto === true).length;
  stats.source.autoRatio = entries.length === 0 ? 0 : stats.source.auto / entries.length;

  if (entries.length === 0) {
    stats.reason = STATS_REASONS.noEntries;
    return stats;
  }

  // —— 时间分布：最近 14 天，按条目日期（updated，缺省 created）落桶 ——
  const at = now instanceof Date ? now : new Date(now ?? Date.now());
  const base = Number.isNaN(at.getTime()) ? new Date() : at;
  const buckets = new Map();
  for (const row of stats.daily) buckets.set(row.date, row);
  for (const entry of entries) {
    const key = toDayKey(entryStamp(entry));
    const row = key ? buckets.get(key) : undefined;
    if (row) row.count += 1;
  }
  stats.dailyMax = stats.daily.reduce((max, row) => Math.max(max, row.count), 0);

  // —— 最近更新的 5 条：日期倒序，同日按编号倒序（稳定、可测） ——
  // 同日兜底必须按**编号数值**比较：字符串序会把 ace-999 排在 ace-1000 之前
  // （maxEntries 上限 1000，四位数编号是常态）。取不到编号的按 -1 处理。
  stats.recent = entries
    .map((entry) => ({ id: String(entry?.id ?? ''), title: String(entry?.title ?? ''), updated: entryStamp(entry) }))
    .sort((a, b) => {
      if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
      const na = recentIdNumber(a.id);
      const nb = recentIdNumber(b.id);
      if (na !== nb) return na < nb ? 1 : -1;
      return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0);
    })
    .slice(0, RECENT_LIMIT);

  return stats;
}

/**
 * 只读 IO：读手册文件并统计。
 * 文件不存在 → reason:'missing'；读失败 → reason:'unreadable'；空文件 → reason:'no-entries'。
 * 三种都是 ok:true 的结构化空态，不抛异常（除调用方明确要求时）。
 */
export async function readPlaybookStats(filePath, opts = {}) {
  const { maxEntries = null, now = new Date(), pathKind = null, playbookPath = null } = opts;
  const base = { now, maxEntries, pathKind, playbookPath, file: filePath };
  let info;
  try {
    info = await fs.promises.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStats(STATS_REASONS.missing, base);
    return emptyStats(STATS_REASONS.unreadable, base);
  }
  if (!info.isFile()) return emptyStats(STATS_REASONS.unreadable, base);
  let text;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return emptyStats(STATS_REASONS.unreadable, base);
  }
  return summarizePlaybook(text, { ...base, filePath, size: info.size, mtime: info.mtime });
}

/**
 * 解析配置里的 playbookPath 再统计。
 * 相对路径在 HTTP 面没有会话工作目录 → resolvePlaybookFile 抛 RELATIVE_PATH_NEEDS_SESSION
 * （lib/playbook-path.js:52-53），这里转成 reason:'needs-session' 的空态，
 * 让页面显示「该路径需要会话上下文，暂无法统计」而不是 500。
 */
export async function collectPlaybookStats(configuredPath, { ctx, maxEntries = null, now = new Date() } = {}) {
  const pathKind = playbookPathKind(configuredPath);
  let file;
  try {
    file = resolvePlaybookFile(configuredPath, { ctx });
  } catch {
    return emptyStats(STATS_REASONS.needsSession, { now, maxEntries, pathKind, playbookPath: configuredPath ?? '' });
  }
  return readPlaybookStats(file, { maxEntries, now, pathKind, playbookPath: file });
}
