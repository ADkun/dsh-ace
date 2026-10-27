// dsh-ace 的 playbook（操作手册）持久化层。
//
// 手册是纯 Markdown，人可直接翻看编辑；机器侧写入只走 applyOps 的增量操作，
// 以「先写临时文件再 rename」的原子方式落盘；同一路径的写入经 module 级
// Promise 链互斥，保证并发 curate 不会交叉写坏手册（验收标准 3 的并发保护）。
//
// 条目格式（示例）：
//   ### [ace-001] 编辑前先读目标文件
//   - 条件：要对既有文件做任何修改之前
//   - 做法：先用 read 完整读一遍，确认结构后再动手
//   - 依据：盲改导致过两次返工
//   - 元数据：created=2026-10-25T06:12:33.412+08:00 updated=2026-10-25T06:12:33.412+08:00 hits=0 lastHit=
//
// 第一个条目标题之前的行视为文档头，序列化时原样拼回；条目内无法识别的行
// 挂在该条目的 extraLines 上原样保留（人手编辑的批注不丢失）。
//
// 并发语义：共享一本手册时多个实例可能同时提交改动。detectConflicts **逐条判定**——
// 冲突的那几条单独拦下并回报给调用方，其余安全的改动照常落盘（不再整批一票否决）。
// 判据：update/remove 看目标条目在快照之后有没有被改过 / 删过 / 新建过；
// add 看它与「快照之后新出现的条目」是否构成重复——完全重复用 applyOps 同一套 normKey
// 口径，同标题用 normTitle，近似重复用 BM25 相似度 + MERGE_THRESHOLD_RATIO
// （三级判据都在 lib/merge.js，与本文件同一套原语；本文件不 import merge.js）。
//
// 条目 id：单调递增且永不复用已删除过的编号。历史最高编号持久化在文档头的
// <!-- ace:id-highwater: N --> 标记行里（人可直接编辑，渲染时不可见；旧手册没有这行
// 也能正常解析）。编号空间跟着手册文件走，不另开旁路 id 文件。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
// AsyncLocalStorage：跨进程锁的「本次调用链已持锁」上下文（见 withFileLock 的重入判定）。
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ARCHIVE_LINE_RE,
  emptyMeta,
  makeEntry,
  parseMeta,
  serializeEntryDocument,
} from './entry-format.js';
import { nowStamp } from './timestamp.js';

/** 旧手册残留的归档区章节标题行（只用于解析时丢弃，绝不写回）。 */
const LEGACY_ARCHIVE_HEADING_RE = /^##\s*归档区\s*$/;

/** 条目标题行：### [ace-NNN] 标题 */
export const HEADING_RE = /^### \[ace-(\d+)\]\s*(.+?)\s*$/;

/**
 * 条目 id 高水位标记行：文档头里的一行 HTML 注释（人可直接编辑，Markdown 渲染时不可见）。
 * 存量手册没有这行也能正常解析（idHighWater 记 0，行为与旧版一致）。
 */
export const ID_HIGHWATER_RE = /^\s*<!--\s*ace:id-highwater:\s*(\d+)\s*-->\s*$/;

/**
 * 归档相关常量已搬到 lib/entry-format.js（手册与归档文件共用同一套文本语法）：
 * ARCHIVE_LINE_RE / ARCHIVE_REASONS / parseArchiveLine / formatArchiveLine。
 * 本文件把它们**原样再导出**，让老的 import 面不炸；'## 归档区' 章节已整层废弃。
 */
export {
  ARCHIVE_LINE_RE,
  ARCHIVE_REASONS,
  parseArchiveLine,
  formatArchiveLine,
  parseMeta,
  metaLine,
  emptyMeta,
  makeEntry,
  writeEntryBlock,
} from './entry-format.js';

const FIELD_RES = [
  ['condition', /^-\s*条件[:：]\s*/],
  ['action', /^-\s*做法[:：]\s*/],
  ['rationale', /^-\s*依据[:：]\s*/],
];

// 元数据的字段顺序契约（序列化与解析都按它走，后续阶段依赖这个顺序）：
//   created → updated → hits → lastHit  [auto=true]
// 缺字段一律兜底（hits 数字 0、字符串空），旧格式（只有日期）照常解析，绝不报错、不丢条目。
// **helpful / harmful 已整层删除**：解析时直接丢弃，序列化永不写（不留历史遗留、不做兼容保留）。

/**
 * 解析手册文本 → { header, entries, extraLines }。
 * entries：{ id, title, condition, action, rationale, meta, extraLines } 数组。
 *
 * **手册文件里没有归档区**（第 33 轮）：'## 归档区' 章节已整层废弃，归档条目在
 * 独立的 archive.md（lib/archive-file.js）。这里若遇到旧手册残留的 '## 归档区'
 * 标题行，它只是一行普通文本 —— 落进 extraLines 原样保留，绝不把后面的条目
 * 当成"归档条目"吞掉（条目本身仍是活跃条目，宁可视作活跃也不丢正文）。
 */
export function parsePlaybook(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const entries = [];
  // 第一条条目之后、没有任何条目承载的自由行（人手工写的说明），原样保留。
  const extraLines = [];
  // 高水位标记行（文档任何位置都收，不当普通文本）：
  // 人可能把标记挪进条目正文里；解析时先摘出来，绝不塞进条目的 extraLines，
  // 否则写回时会在条目体内留下一份副本（全文出现两份标记，见缺陷 5）。
  const markers = [];
  let cur = null;
  const flush = () => {
    if (cur) entries.push(cur);
    cur = null;
  };
  for (const line of lines) {
    // 旧手册残留的 '## 归档区' 章节标题行：丢弃（第 33 轮起归档搬进独立文件 archive.md）。
    // 章节标题只是旧格式残留，写回时绝不保留 —— 手册文件里永远不再出现归档区章节。
    // 章节里的条目本身照常解析成活跃条目（宁可视作活跃，也不丢正文）。
    if (LEGACY_ARCHIVE_HEADING_RE.test(line)) continue;
    if (ID_HIGHWATER_RE.test(line)) {
      const m = ID_HIGHWATER_RE.exec(line);
      markers.push({ text: line.trim(), value: Number(m[1]) || 0 });
      continue;
    }
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      cur = {
        id: 'ace-' + m[1].padStart(3, '0'),
        title: m[2],
        condition: '',
        action: '',
        rationale: '',
        meta: emptyMeta(),
        extraLines: [],
      };
      continue;
    }
    if (!cur) {
      header.push(line);
      continue;
    }
    let matched = false;
    for (const [field, re] of FIELD_RES) {
      if (re.test(line)) { cur[field] = line.replace(re, ''); matched = true; break; }
    }
    if (matched) continue;
    if (ARCHIVE_LINE_RE.test(line)) {
      // 旧手册残留的归档行（'## 归档区' 章节里的 '- 归档：reason=…'）：**丢弃**。
      // 归档已经搬进独立文件 archive.md，这行若写回手册，手册里就会永远残留归档标记
      // （用户红线：手册文件里永不再出现归档区）。条目正文本身一个字不丢，仍在活跃区。
      continue;
    }
    if (/^-\s*元数据[:：]\s*/.test(line)) {
      cur.meta = parseMeta(line.replace(/^-\s*元数据[:：]\s*/, ''));
      continue;
    }
    cur.extraLines.push(line);
  }
  flush();
  // 标记行归位到文档头的规范位置（正文里的那一份不再随条目写回）。
  let marker = null;
  for (const m of markers) if (!marker || m.value > marker.value) marker = m;
  return {
    header: marker ? insertHighWaterMarker(header, marker.text) : header,
    entries,
    extraLines,
  };
}

/**
 * 条目 created/updated/lastHit 用的**毫秒时间戳**（本地时区 ISO，形如
 * 2026-10-25T06:12:33.412+08:00）。实现在 lib/timestamp.js。
 *
 * 为什么必须是本地时区：与 lib/stats.js 的 dateKey 同一口径（统计按本地时区切日桶）；
 * toISOString() 是 UTC，UTC+8 早上 8 点前写进去的条目会拿到「昨天」，统计对不上。
 * 为什么必须带毫秒：淘汰顺序要「同 hits 时 created 更早的先走」，只到日就分不出先后。
 * 不能在 playbook.js 里 import stats.js：stats.js 已经 import parsePlaybook，反向会成环。
 */
function today() {
  return nowStamp();
}

/**
 * 序列化回 Markdown（parsePlaybook 的逆操作，extraLines 原样保留）。
 *
 * **永不写归档区章节**（第 33 轮）：归档条目搬进了独立的 archive.md，
 * 手册文件里不再出现 '## 归档区'。归档条目多出的
 * '- 归档：reason=… date=…' 一行由 lib/archive-file.js 的序列化负责。
 */
export function serializePlaybook({ header = [], entries = [], extraLines = [] }) {
  return serializeEntryDocument({ header, entries, archiveExtra: extraLines });
}

/** 空手册的初始文档头。 */
export function initialHeader() {
  return [
    '# ACE 操作手册',
    '',
    '> 本文件由 dsh-ace 插件维护：条目经 ace_reflect（复盘）与 ace_curate（增量并入）演化。',
    '> 人可以直接编辑。条目格式：### [ace-NNN] 标题，字段行 - 条件：/- 做法：/- 依据：/- 元数据：',
    '',
  ];
}

/**
 * 条目的「完全重复」归一化口径：title+condition+action 去空白、小写后用 U+241F 连接。
 * applyOps 的 seen 集合、add 冲突判定共用这一个函数（不复制第二份口径）。
 */
export function normKey(e) {
  return [e.title, e.condition, e.action].map(normalizeField).join('\u241f');
}

/**
 * 条目标题的归一化（与 normKey 用同一个归一化函数）。
 * add 冲突判定用它识别「标题相同但正文不同」的并发重复 —— 条目标题是用户唯一
 * 可见的标识，同标题的两条并存必然是重复。
 */
export function normTitle(e) {
  return normalizeField(e?.title);
}

/** 字段归一化：去空白、小写（normKey / normTitle 共用同一份口径）。 */
function normalizeField(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 条目 id 里的数字部分（非 ace-NNN 形态返回 0）。 */
export function idNumber(id) {
  const m = /^ace-(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : 0;
}

/** 一组条目里的最大编号（没有合法 id 时为 0）。 */
export function maxEntryIdNumber(entries) {
  let max = 0;
  for (const e of entries || []) max = Math.max(max, idNumber(e?.id));
  return max;
}

/**
 * 下一个可用 id：现存最大编号与高水位（highWater）两者取大 +1。
 * highWater 是「本手册历史上用过的最大编号」——含已删除的编号，
 * 因此删除最高 id 后再新增**不会复用**那个号（id 单调不复用）。
 */
function nextId(entries, highWater) {
  const max = Math.max(maxEntryIdNumber(entries), Number(highWater) || 0);
  return 'ace-' + String(max + 1).padStart(3, '0');
}

/**
 * 从**整篇文档**读出 id 高水位标记（没有标记 → 0）。
 *
 * 传参两种形态都认：
 * - 数组：文档头行数组（旧调用方口径，lib/commit.js 的 parsed.header）；
 * - 解析后的文档对象 { header, entries }：**扫描全文**（文档头 + 每条目的 extraLines），
 *   因为标记可能被挪进条目正文里（人直接编辑手册时的常见手滑）。
 *
 * 归档条目搬进独立文件后，调用方要把手册与归档文件**两份都传进来**再取 max
 * （编号高水位永不复用，见 lib/commit.js）。
 *
 * 正常情况下全文只有一份标记（ensureIdHighWater 保证「清掉所有、只留一份」），
 * 所以「取全文里出现的最大编号」与「取第一份标记」是同一个值；
 * 取最大是为了在**手写坏文件**（多份标记且数值不同）下也不会把高水位读低。
 */
export function readIdHighWater(target) {
  const lines = [];
  if (Array.isArray(target)) {
    lines.push(...target);
  } else if (target && typeof target === 'object') {
    lines.push(...(target.header || []));
    for (const e of target.entries || []) lines.push(...(e?.extraLines || []));
  }
  let max = 0;
  for (const line of lines) {
    const m = ID_HIGHWATER_RE.exec(line);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return max;
}

/**
 * 把高水位标记行插到文档头的**规范位置**（最后一段文字之后、末尾空行之前）。
 * header 里已有的标记行先清掉，保证「全文只有一份标记」且位置稳定。
 *
 * @param {Array<string>} header - 文档头行（可含旧的标记行）
 * @param {string} marker - 要写入的标记行原文
 * @returns {Array<string>} 新的文档头
 */
function insertHighWaterMarker(header, marker) {
  const kept = (header || []).filter((line) => !ID_HIGHWATER_RE.test(line));
  let cut = kept.length;
  while (cut > 0 && kept[cut - 1].trim() === '') cut--;
  return [...kept.slice(0, cut), marker, ...kept.slice(cut)];
}

/**
 * 保证「历史最高编号」在手册文件里留痕：把高水位写成文档头里的一行 HTML 注释
 * （人可直接编辑，Markdown 渲染不可见；旧手册没有这行也能正常解析）。
 *
 * 为什么这样解决 id 复用：编号空间必须跟着手册文件走（旁路 id 文件会在手册被
 * 拷走/删除时与手册失配），而手册是纯 Markdown —— 文档头本来就是「自由文本区」，
 * 塞一行注释不破坏解析（解析器原样保留 header），也不破坏 I7（extraLines 往返保真）。
 *
 * 标记总是写（只要分配过编号）：它记的是「历史上用过的最大编号」，**含已删除的编号**，
 * 所以人手工删掉最高编号的条目后，下一个 add 仍然大于它（缺陷 C）。
 * 标记插在文档头最后一段文字之后、末尾空行之前，文件观感不变。
 *
 * @param {Array<string>} header - 文档头行
 * @param {number} highWater - 本批之后的编号高水位（applyOps 返回的 highWater）
 * @returns {Array<string>} 新的文档头（需要时追加/更新标记行）
 */
export function ensureIdHighWater(header, highWater) {
  const current = readIdHighWater(header);
  const need = Math.max(Number(highWater) || 0, current);
  if (need <= 0) return header; // 还没有分配过编号 → 不留标记
  const lines = header || [];
  // 已是最新且只有一份标记 → 原样返回（幂等）
  const markers = lines.filter((line) => ID_HIGHWATER_RE.test(line));
  if (need === current && markers.length === 1) return header;
  const marker = '<!-- ace:id-highwater: ' + need + ' -->';
  return insertHighWaterMarker(lines, marker);
}

/**
 * 把高水位写回**整篇手册**：清掉文档里所有位置的标记行（文档头 + 条目正文里的），
 * 只在文档头的规范位置留一份（幂等，绝不出现两份）。
 *
 * @param {object} parsed - 解析后的手册 { header, entries }
 * @param {number} highWater - 本批之后的编号高水位
 * @returns {{ header: Array<string>, entries: Array<object> }} 可直接交给 serializePlaybook
 */
export function applyIdHighWater(parsed, highWater) {
  const header = parsed?.header || [];
  const entries = parsed?.entries || [];
  const extraLines = parsed?.extraLines || [];
  const current = readIdHighWater(parsed);
  const need = Math.max(Number(highWater) || 0, current);
  // 条目正文里的标记行一律剔除（人把它挪进正文时的残留）。
  const clean = (list) => list.map((e) => {
    if (!e || !Array.isArray(e.extraLines)) return e;
    const kept = e.extraLines.filter((line) => !ID_HIGHWATER_RE.test(line));
    if (kept.length === e.extraLines.length) return e;
    return { ...e, extraLines: kept };
  });
  const cleaned = clean(entries);
  if (need <= 0) {
    // 还没有分配过编号 → 不留标记，但正文里的残留仍要清掉
    return {
      header: header.filter((line) => !ID_HIGHWATER_RE.test(line)),
      entries: cleaned,
      extraLines,
    };
  }
  return {
    header: insertHighWaterMarker(header, '<!-- ace:id-highwater: ' + need + ' -->'),
    entries: cleaned,
    extraLines,
  };
}

/**
 * 容量判据（写死，maxEntries 只数**活跃条目**，归档区一条都不算）。
 *
 * applyOps 与 commitOps 的「先归档腾位」必须用同一份判据，否则会出现
 * 「applyOps 说放得下、commitOps 却按另一套公式腾位」的口径漂移，所以抽成纯函数。
 *
 * @param {number} activeCount - 应用前活跃条目数
 * @param {number} addCount - 本批新增条数
 * @param {number} removeCount - 本批 remove 条数（remove 也是软删除，会从活跃区搬走）
 * @param {number} maxEntries - 上限；非正数 / 非有限值表示不限
 * @returns {number} 本批应用后的活跃条目数
 */
export function projectedEntryCount(activeCount, addCount, removeCount) {
  return (Number(activeCount) || 0) + (Number(addCount) || 0) - (Number(removeCount) || 0);
}

/** 本批应用后是否超过 maxEntries（maxEntries 非正数 / 非有限值 = 不限）。 */
export function overflowsCapacity(activeCount, addCount, removeCount, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return false;
  return projectedEntryCount(activeCount, addCount, removeCount) > maxEntries;
}

/**
 * 增量操作（纯函数，事务式：先整批校验、再按序应用，任一校验失败则整批抛错）。
 * op 形态：
 *   { op:'add', title, condition, action, rationale?, auto? }
 *   { op:'update', id, title?, condition?, action?, rationale? }
 *   { op:'remove', id }
 * 返回 { entries, added, updated, removed, removedEntries, duplicates, highWater }。
 * removedEntries 是被 remove 的条目的**完整副本**（带 archived:true 与 archive.reason='removed-by-request'），
 * 由 commitOps 并进归档区 —— remove 是软删除，绝不物理删除。
 * 抛错（整批拒绝）：非法 op / add 缺必填字段 / update 缺字段 / id 不存在 /
 *                 应用后条目数超过 maxEntries（错误信息里列出建议合并的旧条目）。
 *
 * highWater：本手册历史上用过的最大编号（从手册文档头的标记行读出，见 readIdHighWater）。
 * 传它是为了**编号不复用**：删除最高 id 后再新增不会重用那个号。
 * 返回的 highWater 是本批之后的编号高水位（调用方负责写回手册文档头，见 ensureIdHighWater）。
 */
export function applyOps(entries, ops, maxEntries, highWater = 0) {
  if (!Array.isArray(ops)) throw new Error('ace: ops 必须是数组');
  // 本批涉及的编号高水位：入参高水位、现存条目最大编号、以及本批里被删掉的编号。
  let hw = Math.max(Number(highWater) || 0, maxEntryIdNumber(entries));
  const seen = new Set(entries.map(normKey));
  const pendingAdds = [];
  const errors = [];
  // —— 第一遍：校验 ——
  ops.forEach((op, i) => {
    const at = 'ops[' + i + ']';
    if (!op || typeof op !== 'object') { errors.push(at + ' 不是对象'); return; }
    if (op.op === 'add') {
      for (const f of ['title', 'condition', 'action']) {
        if (typeof op[f] !== 'string' || !op[f].trim()) { errors.push(at + ' 缺少必填字段 ' + f); return; }
      }
      pendingAdds.push(op);
    } else if (op.op === 'update') {
      if (typeof op.id !== 'string' || !/^ace-\d+$/.test(op.id)) { errors.push(at + ' id 非法'); return; }
      const has = ['title', 'condition', 'action', 'rationale'].some((f) => typeof op[f] === 'string' && op[f].trim());
      if (!has) { errors.push(at + ' 缺少至少一个待更新字段'); return; }
      if (!entries.some((e) => e.id === op.id)) { errors.push(at + ' 的 ' + op.id + ' 不存在'); return; }
    } else if (op.op === 'remove') {
      if (typeof op.id !== 'string' || !/^ace-\d+$/.test(op.id)) { errors.push(at + ' id 非法'); return; }
      if (!entries.some((e) => e.id === op.id)) { errors.push(at + ' 的 ' + op.id + ' 不存在'); return; }
    } else {
      errors.push(at + ' 的 op 必须是 add|update|remove');
    }
  });
  if (errors.length) throw new Error('ace: 操作被整批拒绝（事务未生效）：\n- ' + errors.join('\n- '));
  // —— 容量校验：应用后的条目数不得超过 maxEntries ——
  const removes = ops.filter((o) => o.op === 'remove');
  const finalCount = entries.length + pendingAdds.length - removes.length;
  if (overflowsCapacity(entries.length, pendingAdds.length, removes.length, maxEntries)) {
    const mergeHint = entries.slice(0, 10).map((e) => e.id + ' ' + e.title).join('；');
    throw new Error('ace: 手册已达上限 ' + maxEntries + ' 条（本批后将为 ' + finalCount + ' 条），整批拒绝：' +
      '没有可淘汰的条目（最少使用淘汰只在复盘落盘时自动腾位，直写路径不做隐式淘汰）。' +
      '请先合并或清理旧条目，优先考虑：' + mergeHint);
  }
  // —— 第二遍：按序应用 ——
  const result = { entries: entries.map((e) => ({ ...e })), added: [], updated: [], removed: [], removedEntries: [], duplicates: [], highWater: hw };
  for (const op of ops) {
    if (op.op === 'add') {
      const candidate = { title: op.title, condition: op.condition, action: op.action, rationale: op.rationale || '' };
      if (seen.has(normKey(candidate))) { result.duplicates.push(op.title); continue; }
      const newId = nextId(result.entries, hw);
      hw = Math.max(hw, idNumber(newId));
      const entry = {
        id: newId,
        title: op.title,
        condition: op.condition,
        action: op.action,
        rationale: op.rationale || '',
        meta: { created: today(), updated: today(), hits: 0, lastHit: '', ...(op.auto ? { auto: true } : {}) },
        extraLines: [],
      };
      result.entries.push(entry);
      seen.add(normKey(candidate));
      result.added.push(entry.id);
    } else if (op.op === 'update') {
      const entry = result.entries.find((e) => e.id === op.id);
      for (const f of ['title', 'condition', 'action', 'rationale']) {
        if (typeof op[f] === 'string' && op[f].trim()) entry[f] = op[f];
      }
      entry.meta = { ...(entry.meta || {}), updated: today() };
      // LLM 合并产出的 update 会带一个 meta（见 lib/merge-llm.js 的 planMerges）：
      // 命中计数取两条之和、created 沿用更早那条、lastHit 取较新者。
      // 只认这三个字段 + auto，别的一律不许从 op 里漏进元数据。
      if (op.meta && typeof op.meta === 'object') {
        for (const f of ['created', 'hits', 'lastHit']) {
          if (op.meta[f] !== undefined) entry.meta[f] = op.meta[f];
        }
        if (op.meta.auto) entry.meta.auto = true;
      }
      result.updated.push(entry.id);
    } else if (op.op === 'remove') {
      // remove 是**软删除**：条目从活跃区搬到归档文件 archive.md（由 commitOps 并进去），
      // 正文与元数据一个字都不丢 —— 「归档永不物理删除」是硬红线。
      const idx = result.entries.findIndex((e) => e.id === op.id);
      if (idx !== -1) {
        const [gone] = result.entries.splice(idx, 1);
        result.removed.push(op.id);
        result.removedEntries.push({ ...gone, archived: true, archive: { reason: 'removed-by-request', date: today() } });
      }
    }
  }
  // 编号高水位：入参高水位与本批新分配编号取大（本批删掉的编号早已被入参高水位覆盖）。
  result.highWater = hw;
  return result;
}

/** 手册压缩摘要（给 Reflector/Curator 看，控制 token）：每条一行。 */
export function digestEntries(entries) {
  return entries.map((e) => '[' + e.id + '] ' + e.title + '｜条件：' + e.condition + '｜做法：' + e.action);
}

// —— 命中计数（第 33 轮）：hits 是**唯一的淘汰依据**，不再有任何正负评分 ——
/**
 * 命中计数：给定 id 集合，命中的条目 hits+1、lastHit=date。
 * 纯函数：返回新数组，meta 显式 spread（applyOps 的浅拷贝会让 meta 共享引用，不能就地改）。
 * 返回 { entries, hit } —— hit 是这次真正被计数的 id 数组。
 *
 * date 由调用方给（测试要可注入）；不给就用毫秒时间戳，与 created/updated 同口径。
 */
export function markHits(entries, ids, date) {
  const wanted = new Set(ids || []);
  // date 由调用方给（测试要可注入）；不给就用本地时区的「今天」，与 created/updated 同口径。
  const day = typeof date === 'string' && date ? date : today();
  const hit = [];
  const out = entries.map((e) => {
    if (!wanted.has(e.id)) return e;
    hit.push(e.id);
    const meta = { ...(e.meta || {}) };
    meta.hits = (Number(meta.hits) || 0) + 1;
    meta.lastHit = day;
    return { ...e, meta };
  });
  return { entries: out, hit };
}

// —— 以下为 IO 层：原子写 + 同路径互斥 ——
const locks = new Map(); // path -> Promise（per-path 串行链）

/**
 * 当前调用链已持有的同进程锁集合（path -> 无）。
 * 用 AsyncLocalStorage 传递：与 withFileLock 的重入保护同款——
 * 同一路径上「已经持锁 → 再取一次锁」必须直接执行，否则会自死锁
 * （典型场景：withExclusiveLock(file) 区间内再调 withExclusiveLock(file)）。
 */
const lockStore = new AsyncLocalStorage();

/**
 * 同一路径上的异步操作串行执行；不同路径互不阻塞。
 *
 * 重入：同一调用链已持有该路径的锁时直接执行 fn（不再排队），
 * 避免嵌套取锁自死锁。不同路径仍各走各的 Promise 链，互不阻塞。
 */
export function withLock(filePath, fn) {
  const held = lockStore.getStore();
  if (held && held.has(filePath)) {
    // 重入：本次调用链已持有该路径的锁 → 直接执行。
    return Promise.resolve().then(() => lockStore.run(held, fn));
  }
  const nextHeld = new Set(held || []);
  nextHeld.add(filePath);
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => lockStore.run(nextHeld, fn));
  locks.set(filePath, next.catch(() => {}));
  return next;
}

/**
 * 「无法归因到进程」的锁的兜底回收阈值：只有锁内容读不出有效 pid（写到一半、
 * 或内容损坏）时才用 mtime 兜底，且必须超过这个时长才允许回收。
 * 锁内容里有有效 pid 时**不看时间**——见 judgeLock 的说明。
 */
export const LOCK_STALE_MS = 10000;

/** 抢锁的总等待上限（超过就抛错，不无限等）。 */
export const LOCK_TIMEOUT_MS = 30000;

/**
 * 锁文件内容：pid + 取得时刻 + 本次获取的随机 id（nonce）。
 * - pid：人排障时一眼看出是谁、多久以前；也用于判活（是否可回收）。
 * - id：finally 清理时核对「这还是我那把锁」——别人的锁绝不能被我删掉。
 */
function lockPayload(id) {
  return JSON.stringify({ pid: process.pid, time: Date.now(), id });
}

/** 本次获取锁的唯一标识（nonce）：随机 8 字节十六进制。 */
function newLockId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 当前调用链已持有的跨进程锁集合（锁路径 -> 无）。
 * 用 AsyncLocalStorage 传递：嵌套调用（区间内再写一次）能识别出「已经持锁」。
 */
const fileLockStore = new AsyncLocalStorage();

/**
 * 持锁进程是否还活着：process.kill(pid, 0) 不抛错即视为存活。
 * 进程被强杀（-9 / 崩溃）后 pid 失效，据此可回收它留下的陈旧锁，
 * 不必干等满 staleMs。
 * @returns 'alive' | 'dead' | 'unknown'（pid 缺失/非法，无法归因到任何进程）
 */
function processState(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return 'unknown';
  try {
    process.kill(n, 0);
    return 'alive';
  } catch (e) {
    // ESRCH = 进程不存在（可回收）；EPERM = 存在但无权限（视作活着）。
    if (e && e.code === 'EPERM') return 'alive';
    return 'dead';
  }
}

/**
 * 读一把锁文件的内容并判活：{ state: 'alive'|'dead'|'unknown', id: string|null }。
 * 内容读不出来（损坏 / 写到一半）时 state 为 'unknown'。
 */
async function readLockPayload(lockPath) {
  let raw = null;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return { state: 'unknown', id: null };
  }
  let info = null;
  try {
    info = JSON.parse(raw);
  } catch {
    return { state: 'unknown', id: null };
  }
  if (!info || typeof info !== 'object') return { state: 'unknown', id: null };
  return {
    state: processState(info.pid),
    id: typeof info.id === 'string' ? info.id : null,
  };
}

/**
 * 把一把锁原样放回 lockPath，且**只在 lockPath 当前没有被占住时**放。
 *
 * 优先用 link + unlink 实现占位语义（Windows 上 rename 会直接覆盖目标）。
 * 任何 link 失败都走同一条兜底路径：EEXIST（位置已占）、EPERM（硬链接不可用）、
 * ENOENT（Windows 跨卷时 link 返回 ENOENT）等一律不直接放弃——兜底用
 * `open(lockPath, 'wx')` 独占创建，抢不到就说明位置已被占住，绝不覆盖别人的新锁。
 *
 * @returns true 放回成功 / false 位置已被别人占住
 */
export async function restoreLock(fromPath, lockPath) {
  try {
    await fs.link(fromPath, lockPath);
    await fs.rm(fromPath, { force: true }).catch(() => {});
    return true;
  } catch {
    // link 失败 → 走「位置未被占住才放回」的兜底（跨卷 / 不支持硬链接 / 已存在）。
  }
  let data;
  try {
    data = await fs.readFile(fromPath);
  } catch {
    return false;
  }
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx'); // 独占创建：位置已被占（EEXIST）就直接放弃
  } catch {
    return false;
  }
  try {
    await handle.writeFile(data);
  } catch {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return false;
  }
  await handle.close().catch(() => {});
  await fs.rm(fromPath, { force: true }).catch(() => {});
  return true;
}
/**
 * 判定一把现存的锁能不能回收。
 *
 * 关键语义（共享手册丢写的根因就在这里）：
 *   **持锁进程还活着 → 绝不因「时间超期」把它判成陈旧。**
 *   旧实现把「时间超期」排在 pid 判活之前（`||` 短路），于是 staleMs 一过
 *   活锁就被抢走，持锁者的写被覆盖——共享一本手册时必然丢写。
 *   现在：内容里有有效 pid 且该进程存活 → 一律 'held'，只能等到 timeoutMs
 *   抛错（失败而不是丢写）。
 *
 * 可回收的只有两种：
 *   ① 内容读不出有效 pid（损坏/写到一半）→ 退到 mtime 兜底：mtime 超过 staleMs
 *      才算陈旧（**不能仅凭时间就抢一把可能还活着的锁**：持锁者写 payload 的
 *      窗口只有几微秒，读不出内容且 mtime 早已过期的，基本可判定为崩溃残留）；
 *   ② 内容里的 pid 对应进程已死（process.kill(pid,0) 抛 ESRCH）→ 立刻可回收。
 *
 * @returns { verdict: 'held'（不可抢） | 'stale'（可回收）, id: string|null }
 *   id 是判定当时读到的锁 nonce；回收后据此核对「回收的仍是我判定的那把」。
 */
async function judgeLock(lockPath, staleMs) {
  let raw = null;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { verdict: 'held', id: null }; // 刚好被释放：调用方重试即可
    raw = null;
  }
  let info = null;
  try {
    info = raw === null ? null : JSON.parse(raw);
  } catch {
    info = null;
  }
  if (info && typeof info === 'object') {
    const id = typeof info.id === 'string' ? info.id : null;
    const state = processState(info.pid);
    if (state === 'alive') return { verdict: 'held', id };  // 活着的持锁者永不被抢
    if (state === 'dead') return { verdict: 'stale', id };  // 持锁进程已死 → 可立即回收
    // state === 'unknown'：pid 缺失/非法 → 归因不到任何进程 → 可回收
    return { verdict: 'stale', id };
  }
  // 内容读不出来（写到一半 / 内容损坏）：mtime 兜底。
  // 注意：这里只用于「无法归因到任何进程」的锁；能读到 pid 的锁绝不因时间被抢。
  try {
    const st = await fs.stat(lockPath);
    return { verdict: Date.now() - st.mtimeMs > staleMs ? 'stale' : 'held', id: null };
  } catch {
    return { verdict: 'held', id: null }; // stat 也拿不到 = 已被释放
  }
}

/**
 * 跨进程写锁：以 O_EXCL 创建 <file>.lock（内含 pid + 时间戳 + nonce id），
 * 抢不到就带退避重试。
 *
 * 回收语义（共享一本手册时不丢写的关键）：
 * - **持锁进程还活着 → 绝不抢**。锁内容里有有效 pid 且该进程存活时一律等待，
 *   最多等到 timeoutMs 抛错（失败，而不是丢写）。「时间超期」不再是回收理由——
 *   持锁者可能正卡在一次慢 LLM 调用上（历史故障：10s 一到活锁就被抢，写被覆盖）。
 * - 只有「持锁进程已死」或「锁内容读不出有效 pid 且 mtime 已远超 staleMs」才回收。
 * - 回收靠 rename 取得回收权（改名成功的那方才删），不会误删新主人的锁。
 * - finally 只删**自己那把**锁：核对 payload 里的 nonce，不符就不删。
 *
 * 与 withLock 的分工：withLock 管**同进程内**的并发（per-path Promise 链），
 * 本函数管**跨进程**的并发（多实例共享同一本手册）；两者叠加使用，
 * 顺序恒为 withLock → withFileLock → 读-改-写。
 *
 * 锁的持有期覆盖**整个读-改-写区间**（不是只包住最后一次写）：读手册、算新条目、
 * 落盘必须在同一把锁内，否则两个实例的区间会重叠（临界区并发，后写者可能覆盖先写者）。
 * 区间内的 writeFileAtomic 会再次调用本函数，靠 AsyncLocalStorage 的持有上下文识别为
 * 重入并直接执行（不再加第二次锁），因此不会自死锁。
 */
export async function withFileLock(filePath, fn, { staleMs = LOCK_STALE_MS, timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const lockPath = filePath + '.lock';
  // 重入判定：本次调用链已持有同一把锁（典型场景：withFileLock 区间内的 writeFileAtomic）
  // → 直接执行，不再加第二次锁，避免自死锁；锁的持有期仍覆盖本次调用。
  const held = fileLockStore.getStore();
  if (held && held.has(lockPath)) return await fn();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const giveUpAt = Date.now() + timeoutMs;
  const myId = newLockId();
  let delay = 20;
  for (;;) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx'); // O_CREAT|O_EXCL|O_WRONLY：同一时刻只有一个进程能建成功
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      // 已被别人持有：判定能不能回收（活着的持锁者一律不可抢）。
      const judged = await judgeLock(lockPath, staleMs);
      if (judged.verdict === 'stale') {
        // 回收权靠 rename 取得：先把锁文件改名，拿到名字的那一方才是回收者，
        // 于是绝不会误删「新主人」刚建的锁（旧实现直接 rm，可能删掉别人的）。
        const trash = lockPath + '.stale-' + crypto.randomBytes(6).toString('hex');
        try {
          await fs.rename(lockPath, trash);
        } catch (renameError) {
          if (renameError && renameError.code === 'ENOENT') continue; // 刚好被释放，重试
          throw renameError;
        }
        // 回收前后核对：万一 rename 抢到的是一把「活着」的锁（判定与 rename 之间的
        // 竞态：别的进程刚回收旧锁、新主人刚建），把锁原样放回去，绝不占别人的锁。
        const stolen = await readLockPayload(trash);
        if (stolen && stolen.state === 'alive') {
          const restored = await restoreLock(trash, lockPath);
          if (!restored) {
            // 放不回（slot 已被新主人占住）→ 不删 trash、不占锁，退回等待。
            await fs.rm(trash, { force: true }).catch(() => {});
            if (Date.now() >= giveUpAt) {
              throw new Error('ace: 等待手册写锁超时（' + lockPath + '），可能有别的进程正长时间占用；稍后重试。');
            }
            await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay)));
            delay = Math.min(delay * 2, 200);
            continue;
          }
          continue; // 锁已放回原位，继续等
        }
        await fs.rm(trash, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= giveUpAt) {
        throw new Error('ace: 等待手册写锁超时（' + lockPath + '），可能有别的进程正长时间占用；稍后重试。');
      }
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay)));
      delay = Math.min(delay * 2, 200);
      continue;
    }
    try {
      await handle.writeFile(lockPayload(myId));
    } finally {
      await handle.close();
    }
    break;
  }
  // 继承外层已持有的锁集合（重入时也带上），再加本锁。
  const nextHeld = new Set(held || []);
  nextHeld.add(lockPath);
  try {
    return await fileLockStore.run(nextHeld, fn);
  } finally {
    // 只清自己的锁：先核对 payload 里的 nonce 是不是我那把。
    // 内容不符（锁已被回收、别人接手）就不删——删了会砸掉新主人的锁。
    const cur = await readLockPayload(lockPath);
    if (cur.id && cur.id === myId) await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * 写入的组合锁：withLock（同进程 per-path 串行）→ withFileLock（跨进程文件锁）。
 * 锁的持有期覆盖**整个读-改-写区间**：调用方把「读文件 → 算新内容 → writeFileAtomic」
 * 整段放进 fn 里，两个实例的临界区就不会重叠（串行）。这只保证「不并发写坏」，
 * 不保证「后写者不覆盖先写者」——跨实例的语义冲突由 detectConflicts 显式报错解决。
 * 内层 writeFileAtomic 会重入 withFileLock（AsyncLocalStorage 识别已持锁），不会自死锁。
 * 红线 2 的「withLock + writeFileAtomic」在此仍然成立：落盘依旧只经 writeFileAtomic。
 *
 * 注意：区间内**只允许纯计算**——任何网络/LLM 调用都必须挪到锁外（见 lib/index.js 的
 * ace_curate：提案在锁外由 LLM 生成，锁内只做校验与落盘）。否则一次慢 LLM 会把
 * 所有其他写者堵到超时。
 */
export function withExclusiveLock(filePath, fn) {
  return withLock(filePath, () => withFileLock(filePath, fn));
}

/**
 * 原子写：先拿跨进程锁（<file>.lock），再写同目录临时文件，最后 rename 覆盖
 * （进程崩溃不会留下半截手册）。调用方仍应先套 withLock（同进程串行）。
 */
/**
 * rename 覆盖目标时值得重试的错误码（第 39 轮缺陷 3）。
 * EPERM：Windows 上目标文件上还有不带 FILE_SHARE_DELETE 的打开句柄（最常见：一个只读快照读者）；
 * EBUSY / EACCES：同类「目标此刻不可替换」的占用语义（跨平台兜底）。
 * 刻意**不含** ENOENT / EISDIR 这类结构性错误：那些重试一万次也不会变。
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 退避等待（不引入新依赖：就一个 setTimeout 包成 promise，与本文件既有的锁退避同一写法）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 重试退避（毫秒）：50 / 150 / 400 —— 三次之后仍失败就把原错误抛出去。
 * 必须**有上限**：一次真占用（比如读者长时间不关句柄）不能变成死循环。
 */
const RENAME_BACKOFF_MS = [50, 150, 400];

export async function writeFileAtomic(filePath, text) {
  return withFileLock(filePath, async () => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    await fs.writeFile(tmp, text, 'utf8');
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      // 第 39 轮缺陷 3：Windows 上 rename 覆盖目标要求「目标文件上没有不带
      // FILE_SHARE_DELETE 的打开句柄」，而 Node 的 fs.readFile 恰恰不满足 ——
      // 一个只读快照的读者就能让整笔 commit 失败（exp/atomic-race2.mjs 实测：
      // 1 个读者 35/300 次写失败、3 个读者 96/300，全部 EPERM）。读者读到的内容
      // 永远是完整的（0 badParses），失败的只有写者，而手册写失败会让整段复盘白跑。
      // 所以对「目标被占用」这类可恢复错误做 2-3 次退避重试（50/150/400ms）：
      // 读者通常几十毫秒内就放开句柄。仍失败才清掉临时文件并把原错误抛出去
      // （调用方语义一字不变）。
      if (RENAME_RETRY_CODES.has(e && e.code)) {
        for (let i = 0; i < RENAME_BACKOFF_MS.length; i += 1) {
          await sleep(RENAME_BACKOFF_MS[i]);
          try {
            await fs.rename(tmp, filePath);
            e = null;
            break;
          } catch (retryError) {
            e = retryError;
          }
        }
      }
      if (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
    }
  });
}

/**
 * 把 query 拆成用于 OR 匹配的片段：按非字母数字切分后，ASCII 词整段保留；
 * 汉字块（无分词器）做重叠 2-gram 短语片段（长度 <=2 的整块保留），
 * 保证中文长自然句也能召回（如「上线之后服务挂了怎么办」含片段「服务」）。
 */
export function querySegments(query) {
  const chunks = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const segs = [];
  for (const chunk of chunks) {
    const runs = chunk.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) || [];
    for (const run of runs) {
      if (/^\p{Script=Han}/u.test(run)) {
        if (run.length <= 2) { segs.push(run); continue; }
        for (let i = 0; i + 2 <= run.length; i++) segs.push(run.slice(i, i + 2));
      } else {
        segs.push(run);
      }
    }
  }
  return [...new Set(segs)];
}

/** 子串出现次数（非重叠，BM25 的 tf）。 */
function countOccurrences(text, term) {
  let n = 0, i = 0;
  while ((i = text.indexOf(term, i)) !== -1) { n++; i += term.length; }
  return n;
}

/**
 * 关键词检索：以 querySegments 的片段为 term，对当前 entries 做标准 BM25 打分
 * （k1=1.2, b=0.75；idf=log((N-df+0.5)/(df+0.5)+1)；tf 在 title+condition+action+rationale
 * 拼接文本上计；文档长度用同一套 querySegments 切片计数）。命中（score>0）的条目按
 * 得分降序返回（同分保持条目原序）；query 无有效片段或全部 0 分时原样返回全部（整本兜底）。
 */
const INDEX_CACHE_LIMIT = 1;        // 只留最近一份语料 —— 注入 / 热度 / 合并都反复打「当前这本手册」
// tf 子缓存的总内存上限（条目数 × 缓存条 term 数）：约 2e6 个 int ≈ 8MB。
// 按语料规模摊：N=100 时留 20000 个 term；N=1000 时留 2000 个。攒满整块丢掉重算（只影响速度、不影响结果）。
const TF_CACHE_TOTAL = 2000000;
const indexCache = new Map();         // 缓存 key = 语料内容摘要；value = 与 query 无关的文档侧索引
const indexStats = { hits: 0, misses: 0 };

/** 条目 → 参与打分的文本：四个字段小写拼接。与加缓存前的表达式逐字一致。 */
function docTextOf(e) {
  return [e.title, e.condition, e.action, e.rationale].map((s) => s || '').join('\n').toLowerCase();
}

/**
 * 语料内容摘要（FNV-1a 32 位，按 UTF-16 code unit 扫）：只用来给缓存**快速定位**。
 * 命中之后还会逐条比对 docs 文本，所以哈希碰撞不会变成错结果。
 * 不用 crypto.createHash —— 每打一次分就要算一次，只有这么轻的哈希才压得住它省下来的开销。
 */
function digestDocs(docs) {
  let h = 0x811c9dc5;
  for (let k = 0; k < docs.length; k++) {
    const d = docs[k];
    for (let i = 0; i < d.length; i++) {
      h ^= d.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 10;                          // 条目分隔符：避免 ["ab","c"] 与 ["a","bc"] 摘要撞车
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + docs.length;
}

/** 摘要相同之后再做一次逐条文本比对：把哈希碰撞彻底挡在缓存之外。 */
function sameDocs(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 取「文档侧索引」：文档文本、文档长度、平均长度、以及懒加载的 term→{df, tfs}。
 * 这几样只跟语料有关、跟 query 无关，所以能跨调用复用；语料一变（内容摘要变了）就整体换新的。
 * 纯同步内存操作：没有 await、没有定时器、不持文件句柄；容量单槽，因此不会随调用次数增长。
 */
function indexFor(entries, docs) {
  const key = digestDocs(docs);
  const hit = indexCache.get(key);
  if (hit && sameDocs(hit.docs, docs)) {
    indexStats.hits++;
    return hit;
  }
  indexStats.misses++;
  const dls = docs.map((d) => querySegments(d).length || 1);
  const built = {
    docs,
    dls,
    N: entries.length,
    avgdl: dls.reduce((a, b) => a + b, 0) / entries.length,
    // tf 子缓存：term → { df, tfs: Int32Array(docs.length) }。一次扫全语料同时得到 df 与
    // 每个文档的 tf（countOccurrences>0 与 includes 命中是同一件事，df 口径与旧实现逐位一致）。
    // 第 45 轮：合并配对要在同一份语料上打 N 次分（旧实现是 N² 次全语料重扫，实测 78–110s），
    // tf 缓存把「同语料第二次之后的打分」变成查表，配对矩阵才跑得进总时限。
    tf: new Map(),
    tfLimit: Math.max(1024, Math.floor(TF_CACHE_TOTAL / Math.max(1, entries.length))),
  };
  if (indexCache.size >= INDEX_CACHE_LIMIT) indexCache.clear();
  indexCache.set(key, built);
  return built;
}

/**
 * term 在整份语料上的词频表：tfs[i] = 第 i 个文档里的出现次数（非重叠计数），df = 命中文档数。
 * 同一份语料 + 同一个 term 只扫一遍库；df 与 tf 在同一次扫描里同时得出，
 * countOccurrences>0 与旧实现的 d.includes(term) 是同一判据，df 口径逐位一致。
 */
function termFreqsOf(idx, term) {
  let entry = idx.tf.get(term);
  if (entry === undefined) {
    const tfs = new Int32Array(idx.docs.length);
    let df = 0;
    for (let i = 0; i < idx.docs.length; i++) {
      const c = countOccurrences(idx.docs[i], term);
      if (c) { tfs[i] = c; df++; }
    }
    if (idx.tf.size >= idx.tfLimit) idx.tf.clear();
    entry = { df, tfs };
    idx.tf.set(term, entry);
  }
  return entry;
}

/** 缓存观测（只在内存里计数，不落盘）：给测试与体检脚本看容量与命中情况。 */
export function bm25IndexStats() {
  return { size: indexCache.size, limit: INDEX_CACHE_LIMIT, hits: indexStats.hits, misses: indexStats.misses };
}

/**
 * 关键词检索：以 querySegments 的片段为 term，对当前 entries 做标准 BM25 打分
 * （k1=1.2, b=0.75；idf=log((N-df+0.5)/(df+0.5)+1)；tf 在 title+condition+action+rationale
 * 拼接文本上计；文档长度用同一套 querySegments 切片计数）。命中（score>0）的条目按
 * 得分降序返回（同分保持条目原序）；query 无有效片段或全部 0 分时原样返回全部（整本兜底）。
 *
 * 打分口径一个字都没改；只是把「只跟语料有关」的那部分（doc 文本 / 文档长度 / term→{df,tf}）
 * 按**语料内容摘要**缓存起来复用：注入、热度、合并都会拿同一本手册反复调它。
 */
export function scoreEntries(entries, query) {
  const terms = querySegments(query);
  if (!terms.length || !entries.length) return entries.map((e, i) => ({ e, i, score: 0 }));
  const docs = entries.map(docTextOf);
  const idx = indexFor(entries, docs);
  const { dls, avgdl, N } = idx;
  const K1 = 1.2, B = 0.75;
  const scored = entries.map((e, i) => {
    let score = 0;
    for (const t of terms) {
      const { df, tfs } = termFreqsOf(idx, t);
      const tf = tfs[i];
      if (!tf) continue;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dls[i] / avgdl));
    }
    return { e, i, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i);
}

export function matchEntries(entries, query) {
  const scored = scoreEntries(entries, query);
  if (!scored.some((x) => x.score > 0)) return entries.slice();
  return scored.filter((x) => x.score > 0).map((x) => x.e);
}

/** 读手册；不存在时写出带文档头的初始手册并返回空条目。 */
export async function readOrInitPlaybook(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return parsePlaybook(text);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    const header = initialHeader();
    await writeFileAtomic(filePath, serializePlaybook({ header, entries: [] }));
    return { header, entries: [], extraLines: [] };
  }
}

/**
 * 读手册快照：**只读、不初始化、不写盘**（文件不存在时返回空条目）。
 * 用于「锁外读快照 → 锁内读最新 → 比对」的两段式写入：锁外阶段不能写盘，
 * 也不能在锁内做 LLM 调用。
 */
export async function readPlaybookSnapshot(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return parsePlaybook(text);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    return { header: initialHeader(), entries: [], extraLines: [] };
  }
}

/** 条目内容指纹：用于判断「这条在快照之后有没有被别人改过」。 */
function entryFingerprint(e) {
  return JSON.stringify({
    title: e.title || '',
    condition: e.condition || '',
    action: e.action || '',
    rationale: e.rationale || '',
  });
}

/** 冲突说明的固定前缀（用户看到的第一句）。 */
export const CONFLICT_PREFIX = '手册在本次复盘期间被其他进程改动，请重试：';

/**
 * 并发改动检测：**逐条判定**（不再整批一票否决）。
 *
 * 共享一本手册时，两个实例的 LLM 提案可能指向同一条目：先落地的那份已经改了它，
 * 后落地的那份若直接套用就会覆盖别人的写（last-writer-wins）。因此这里把**真正
 * 冲突的那一条**单独挑出来，交给调用方回报给用户并重试；同一批里其余安全的改动
 * 照常落盘（见 lib/index.js 的三条写入路径）。
 *
 * 本函数只管 update / remove（目标条目在快照之后有没有被改过 / 删过 / 新建过）；
 * add 的重复判定需要 BM25 相似度，放在 lib/merge.js（detectAddConflicts），
 * 由 lib/merge.js 的 detectAllConflicts 汇总 —— 依赖方向是
 * playbook.js（基础层）← merge.js（相似度层）← index.js（调用层），无循环 import。
 *
 * @param {object} snapshot - 锁外读到的快照 { entries }
 * @param {object} latest - 锁内读到的最新手册 { entries }
 * @param {Array} ops - 待应用的增量操作
 * @returns {{ conflicts: Array, safe: Array }} conflicts 每项
 *   { index, op, id, title, reason }；safe 是未被判为冲突的 op（按原序）。
 */
export function detectConflicts(snapshot, latest, ops) {
  const snapById = new Map((snapshot?.entries || []).map((e) => [e.id, e]));
  const latestById = new Map((latest?.entries || []).map((e) => [e.id, e]));
  const list = Array.isArray(ops) ? ops : [];
  const conflicts = [];
  const safe = [];
  list.forEach((op, index) => {
    if (!op || (op.op !== 'update' && op.op !== 'remove')) { safe.push(op); return; }
    const id = op.id;
    const before = snapById.get(id);
    const now = latestById.get(id);
    if (!before) {
      if (now) {
        conflicts.push({ index, op: op.op, id, title: now.title || '', reason: '条目 ' + id + ' 是复盘期间新出现的。' });
        return;
      }
      safe.push(op); // 两边都没有 → 交给 applyOps 按既有规则报「id 不存在」
      return;
    }
    if (!now) {
      conflicts.push({ index, op: op.op, id, title: before.title || '', reason: '条目 ' + id + ' 已被删除。' });
      return;
    }
    if (entryFingerprint(before) !== entryFingerprint(now)) {
      conflicts.push({ index, op: op.op, id, title: now.title || '', reason: '条目 ' + id + ' 已被修改。' });
      return;
    }
    safe.push(op);
  });
  return { conflicts, safe };
}

/**
 * 把结构化冲突报告渲染成一句人话（旧的「字符串说明」形态，便于做错误信息与测试断言）。
 * @param {{ conflicts: Array }} report
 * @returns {string|null} 无冲突 → null
 */
export function describeConflicts(report) {
  const list = report?.conflicts || [];
  if (!list.length) return null;
  return CONFLICT_PREFIX + list.map((c) => c.reason).join('；');
}