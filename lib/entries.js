// 手册条目清单：设置页「记录列表详情页」的只读数据源（GET /api/dsh-ace/entries）。
//
// 只读红线：本模块只 stat / read 手册文件，**不写盘、不加锁**，不碰
// withLock / withFileLock / writeFileAtomic / commit.js / merge.js 任何写路径。
// 本文件里不会出现任何写手册的代码——它只是把既有解析结果摊平成一份可渲染的清单。
//
// 分层（与 ./stats.js 同构，为了能单测）：
//   toEntry(raw)                    纯函数：parsePlaybook 的单条 entry → 固定形状的一条记录
//   collectEntries(parsed, opts)    纯函数：手册解析结果（或文本）→ { ok, entries, total, maxEntries }
//   readPlaybookEntries(file, opts) 只读 IO：stat + readFile → collectEntries
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
import { playbookPathKind, resolvePlaybookFile } from './playbook-path.js';

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
 * 字段顺序即契约（{ id, title, condition, action, rationale, auto, created, updated, helpful, harmful }）：
 * 正文缺失给空串，auto 恒为布尔，helpful/harmful 恒为数字——客户端不必判断字段是否存在。
 * @param {object} raw - parsePlaybook 的 entries 里的一条
 * @returns {{id:string,title:string,condition:string,action:string,rationale:string,auto:boolean,created:string,updated:string,helpful:number,harmful:number}}
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
    helpful: Number(meta.helpful) || 0,
    harmful: Number(meta.harmful) || 0,
  };
}

/**
 * 纯函数：手册解析结果（或手册全文）→ 条目清单。
 * @param {object|string} parsed - parsePlaybook 的返回值，或手册 Markdown 全文
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值，原样回显给页面）
 * @returns {{ok:true, entries:Array, total:number, maxEntries:number|null}}
 */
export function collectEntries(parsed, { maxEntries = null } = {}) {
  const source = typeof parsed === 'string' ? parsePlaybook(parsed) : parsed;
  const list = Array.isArray(source?.entries) ? source.entries : [];
  const entries = list.map(toEntry);
  return { ok: true, entries, total: entries.length, maxEntries: normalizeMaxEntries(maxEntries) };
}

/**
 * 结构化空态：ok 恒为 true，reason 说明为什么没有数据（形状与成功路径完全一致）。
 * @param {string|null} reason - ENTRIES_REASONS 里的一个值
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值）
 * @returns {{ok:true, reason:string|null, entries:Array, total:number, maxEntries:number|null}}
 */
export function emptyEntries(reason, { maxEntries = null } = {}) {
  return { ok: true, reason: reason ?? null, entries: [], total: 0, maxEntries: normalizeMaxEntries(maxEntries) };
}

/**
 * 只读 IO：读手册文件并摊平成条目清单。
 * 文件不存在 → reason:'missing'；读失败 → reason:'unreadable'。
 * 两种都是 ok:true 的结构化空态，不抛异常。
 * @param {string} filePath - 手册绝对路径
 * @param {object} [opts]
 * @param {number|null} [opts.maxEntries] - 容量上限（配置值）
 */
export async function readPlaybookEntries(filePath, { maxEntries = null } = {}) {
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
  return collectEntries(parsePlaybook(text), base);
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
  const result = await readPlaybookEntries(file, { maxEntries });
  return { ...result, pathKind, playbookPath: file };
}
