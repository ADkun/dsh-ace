// 条目块的文本语法：手册文件（playbook.md）与归档文件（archive.md）**共用同一套**。
//
// 条目格式（示例）：
//   ### [ace-001] 编辑前先读目标文件
//   - 条件：要对既有文件做任何修改之前
//   - 做法：先用 read 完整读一遍，确认结构后再动手
//   - 依据：盲改导致过两次返工
//   - 元数据：created=2026-10-25T06:12:33.412+08:00 updated=… hits=3 lastHit=…
//
// 归档条目多一行（只在 archive.md 里出现）：
//   - 归档：reason=<superseded|removed-by-request|evicted|merged> date=<时间戳> [supersededBy=ace-NNN]
//
// 元数据字段顺序契约（序列化与解析都按它走）：
//   created → updated → hits → lastHit [→ auto=true]
// 缺字段一律兜底（hits 数字 0、字符串空），旧格式（只有日期）照常解析，绝不报错。
// **helpful / harmful 已被整层删除**：解析时直接丢弃，序列化永不写。
//
// 本模块零 IO、零业务：只做「一段文本 ↔ 一组条目对象」的翻译。

import { nowStamp } from './timestamp.js';

/** 条目标题行：### [ace-NNN] 标题 */
export const HEADING_RE = /^### \[ace-(\d+)\]\s*(.+?)\s*$/;

/**
 * 条目 id 高水位标记行：文档头里的一行 HTML 注释（人可直接编辑，Markdown 渲染时不可见）。
 * 存量文档没有这行也能正常解析（idHighWater 记 0）。
 */
export const ID_HIGHWATER_RE = /^\s*<!--\s*ace:id-highwater:\s*(\d+)\s*-->\s*$/;

/** 归档行前缀。 */
export const ARCHIVE_LINE_RE = /^-\s*归档[:：]\s*/;

/**
 * 归档原因（**定死四值**）：
 * - superseded：被新条目取代（候选更完整，旧正文可回溯）
 * - removed-by-request：显式 remove（软删除，绝不物理删除）
 * - evicted：最少使用淘汰（hits 最少的那几条）
 * - merged：被 LLM 合并进另一条（保留 created 更早那条的 id）
 */
export const ARCHIVE_REASONS = ['superseded', 'removed-by-request', 'evicted', 'merged'];

/** 条目四字段的行前缀。 */
const FIELD_RES = [
  ['condition', /^-\s*条件[:：]\s*/],
  ['action', /^-\s*做法[:：]\s*/],
  ['rationale', /^-\s*依据[:：]\s*/],
];

/** 元数据行的前缀。 */
const META_LINE_RE = /^-\s*元数据[:：]\s*/;

/** 空元数据（四字段兜底值）。 */
export function emptyMeta() {
  return { created: '', updated: '', hits: 0, lastHit: '' };
}

/** 解析「- 元数据：」之后的文本 → { created, updated, hits, lastHit, auto? }。 */
export function parseMeta(text) {
  const meta = emptyMeta();
  for (const kv of String(text ?? '').split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i === -1) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === 'hits') meta.hits = Number(v) || 0;
    else if (k === 'created' || k === 'updated' || k === 'lastHit') meta[k] = v;
    else if (k === 'auto') meta.auto = v === 'true';
    // 其余键（含已删除的 helpful / harmful）一律丢弃：不留历史遗留、不做兼容保留。
  }
  return meta;
}

/** 元数据行文本（顺序定死：created → updated → hits → lastHit → auto）。 */
export function metaLine(meta) {
  const m = meta || {};
  const parts = [
    'created=' + (m.created || ''),
    'updated=' + (m.updated || ''),
    'hits=' + (Number(m.hits) || 0),
    'lastHit=' + (m.lastHit || ''),
  ];
  if (m.auto) parts.push('auto=true');
  return parts.join(' ');
}

/** 解析归档行 → { reason, date, supersededBy }（缺字段兜底空串）。 */
export function parseArchiveLine(text) {
  const info = { reason: '', date: '', supersededBy: '' };
  for (const kv of String(text ?? '').replace(ARCHIVE_LINE_RE, '').split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i === -1) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === 'reason' || k === 'date' || k === 'supersededBy') info[k] = v;
  }
  return info;
}

/** 归档行文本（reason/date 必有；supersededBy 只在「被新版取代」时出现）。 */
export function formatArchiveLine(info) {
  const parts = ['reason=' + (info?.reason || ''), 'date=' + (info?.date || '')];
  if (info?.supersededBy) parts.push('supersededBy=' + info.supersededBy);
  return '- 归档：' + parts.join(' ');
}

/** 造一个空条目对象（解析与新增共用同一形状）。 */
export function makeEntry(fields = {}) {
  return {
    id: String(fields.id || ''),
    title: String(fields.title || ''),
    condition: String(fields.condition || ''),
    action: String(fields.action || ''),
    rationale: String(fields.rationale || ''),
    meta: { ...emptyMeta(), ...(fields.meta || {}) },
    extraLines: Array.isArray(fields.extraLines) ? fields.extraLines.slice() : [],
  };
}

/**
 * 解析一段条目文本 → { header, entries, archiveExtra, markers }。
 * - header：第一个条目标题之前的行（文档头）；
 * - entries：每个条目 { id, title, condition, action, rationale, meta, extraLines, archive? }；
 * - archiveExtra：文档头之后、没有任何条目时出现的自由行（人写的说明），原样保留；
 * - markers：出现过的 id 高水位标记行（交给调用方归位，绝不留两份）。
 *
 * 不认「## 归档区」章节 —— 手册与归档文件各写各的文件，章节本身已废弃
 * （旧手册的迁移在 lib/archive-file.js 的 splitLegacyArchiveSection）。
 */
export function parseEntryDocument(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const entries = [];
  const archiveExtra = [];
  const markers = [];
  let cur = null;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (ID_HIGHWATER_RE.test(line)) {
      const m = ID_HIGHWATER_RE.exec(line);
      markers.push({ text: line.trim(), value: Number(m[1]) || 0 });
      continue;
    }
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      cur = makeEntry({ id: 'ace-' + m[1].padStart(3, '0'), title: m[2] });
      continue;
    }
    if (!cur) {
      header.push(line);
      continue;
    }
    let matched = false;
    for (const [field, re] of FIELD_RES) {
      if (re.test(line)) {
        cur[field] = line.replace(re, '');
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (ARCHIVE_LINE_RE.test(line)) {
      cur.archive = parseArchiveLine(line);
      cur.archived = true;
      continue;
    }
    if (META_LINE_RE.test(line)) {
      cur.meta = parseMeta(line.replace(META_LINE_RE, ''));
      continue;
    }
    cur.extraLines.push(line);
  }
  flush();
  return { header, entries, archiveExtra, markers };
}

/** 把一个条目写进输出行数组（手册与归档文件共用同一写法）。 */
export function writeEntryBlock(out, e) {
  out.push('### [' + e.id + '] ' + (e.title || ''));
  out.push('- 条件：' + (e.condition || '（未注明）'));
  out.push('- 做法：' + (e.action || '（未注明）'));
  if (e.rationale) out.push('- 依据：' + e.rationale);
  out.push('- 元数据：' + metaLine(e.meta || {}));
  if (e.archive) out.push(formatArchiveLine(e.archive));
  for (const line of e.extraLines || []) out.push(line);
}

/**
 * 序列化一份条目文档 → 文本。
 * 输入 { header, entries, archiveExtra }；末尾恒补一个换行（人可读的纯文本文件）。
 */
export function serializeEntryDocument({ header = [], entries = [], archiveExtra = [] } = {}) {
  const out = [...header];
  for (const e of entries) writeEntryBlock(out, e);
  for (const line of archiveExtra || []) out.push(line);
  let text = out.join('\n');
  // 完全空白的文档 → 空串（不是 '\n'）：serializePlaybook 的既有契约，
  // 且 writeFileAtomic 写空手册时不该凭空多出一个空行。
  if (text && !text.endsWith('\n')) text += '\n';
  return text;
}

/** 便于调用方造时间戳（不额外 import timestamp.js）。 */
export function stampNow(date) {
  return nowStamp(date);
}
