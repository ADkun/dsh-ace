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
//   - 元数据：created=2026-02-07 updated=2026-02-07 helpful=0 harmful=0
//
// 第一个条目标题之前的行视为文档头，序列化时原样拼回；条目内无法识别的行
// 挂在该条目的 extraLines 上原样保留（人手编辑的批注不丢失）。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 条目标题行：### [ace-NNN] 标题 */
export const HEADING_RE = /^### \[ace-(\d+)\]\s*(.+?)\s*$/;

const FIELD_RES = [
  ['condition', /^-\s*条件[:：]\s*/],
  ['action', /^-\s*做法[:：]\s*/],
  ['rationale', /^-\s*依据[:：]\s*/],
];

function parseMeta(text) {
  const meta = { created: '', updated: '', helpful: 0, harmful: 0 };
  for (const kv of text.split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i === -1) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === 'helpful' || k === 'harmful') meta[k] = Number(v) || 0;
    else if (k === 'created' || k === 'updated') meta[k] = v;
  }
  return meta;
}

/**
 * 解析手册文本 → { header, entries, extraOf }。
 * entries：{ id, title, condition, action, rationale, meta, extraLines } 数组。
 */
export function parsePlaybook(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = [];
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      cur = {
        id: 'ace-' + m[1].padStart(3, '0'),
        title: m[2],
        condition: '',
        action: '',
        rationale: '',
        meta: { created: '', updated: '', helpful: 0, harmful: 0 },
        extraLines: [],
      };
      continue;
    }
    if (!cur) { header.push(line); continue; }
    let matched = false;
    for (const [field, re] of FIELD_RES) {
      if (re.test(line)) { cur[field] = line.replace(re, ''); matched = true; break; }
    }
    if (matched) continue;
    if (/^-\s*元数据[:：]\s*/.test(line)) {
      cur.meta = parseMeta(line.replace(/^-\s*元数据[:：]\s*/, ''));
      continue;
    }
    cur.extraLines.push(line);
  }
  if (cur) entries.push(cur);
  return { header, entries };
}

function metaLine(meta) {
  return 'created=' + (meta.created || '') + ' updated=' + (meta.updated || '') +
    ' helpful=' + (meta.helpful || 0) + ' harmful=' + (meta.harmful || 0);
}

function today() { return new Date().toISOString().slice(0, 10); }

/** 序列化回 Markdown（parsePlaybook 的逆操作，extraLines 原样保留）。 */
export function serializePlaybook({ header = [], entries = [] }) {
  const out = [...header];
  for (const e of entries) {
    out.push('### [' + e.id + '] ' + e.title);
    out.push('- 条件：' + (e.condition || '（未注明）'));
    out.push('- 做法：' + (e.action || '（未注明）'));
    if (e.rationale) out.push('- 依据：' + e.rationale);
    out.push('- 元数据：' + metaLine(e.meta || {}));
    for (const extra of e.extraLines || []) out.push(extra);
  }
  let text = out.join('\n');
  if (text && !text.endsWith('\n')) text += '\n';
  return text;
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

function normKey(e) {
  return [e.title, e.condition, e.action].map((s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()).join('\u241f');
}

function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = /^ace-(\d+)$/.exec(e.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return 'ace-' + String(max + 1).padStart(3, '0');
}

/**
 * 增量操作（纯函数，事务式：先整批校验、再按序应用，任一校验失败则整批抛错）。
 * op 形态：
 *   { op:'add', title, condition, action, rationale? }
 *   { op:'update', id, title?, condition?, action?, rationale? }
 *   { op:'remove', id }
 * 返回 { entries, added, updated, removed, duplicates }。
 * 抛错（整批拒绝）：非法 op / add 缺必填字段 / update 缺字段 / id 不存在 /
 *                 应用后条目数超过 maxEntries（错误信息里列出建议合并的旧条目）。
 */
export function applyOps(entries, ops, maxEntries) {
  if (!Array.isArray(ops)) throw new Error('ace: ops 必须是数组');
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
  if (Number.isFinite(maxEntries) && maxEntries > 0 && finalCount > maxEntries) {
    const mergeHint = entries.slice(0, 10).map((e) => e.id + ' ' + e.title).join('；');
    throw new Error('ace: 手册已达上限 ' + maxEntries + ' 条（本批后将为 ' + finalCount + ' 条），整批拒绝。' +
      '请先合并或清理旧条目，优先考虑：' + mergeHint);
  }
  // —— 第二遍：按序应用 ——
  const result = { entries: entries.map((e) => ({ ...e })), added: [], updated: [], removed: [], duplicates: [] };
  for (const op of ops) {
    if (op.op === 'add') {
      const candidate = { title: op.title, condition: op.condition, action: op.action, rationale: op.rationale || '' };
      if (seen.has(normKey(candidate))) { result.duplicates.push(op.title); continue; }
      const entry = {
        id: nextId(result.entries),
        title: op.title,
        condition: op.condition,
        action: op.action,
        rationale: op.rationale || '',
        meta: { created: today(), updated: today(), helpful: 0, harmful: 0 },
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
      result.updated.push(entry.id);
    } else if (op.op === 'remove') {
      const idx = result.entries.findIndex((e) => e.id === op.id);
      if (idx !== -1) { result.entries.splice(idx, 1); result.removed.push(op.id); }
    }
  }
  return result;
}

/** 手册压缩摘要（给 Reflector/Curator 看，控制 token）：每条一行。 */
export function digestEntries(entries) {
  return entries.map((e) => '[' + e.id + '] ' + e.title + '｜条件：' + e.condition + '｜做法：' + e.action);
}

// —— 以下为 IO 层：原子写 + 同路径互斥 ——
const locks = new Map(); // path -> Promise（per-path 串行链）

/** 同一路径上的异步操作串行执行；不同路径互不阻塞。 */
export function withLock(filePath, fn) {
  const prev = locks.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(filePath, next.catch(() => {}));
  return next;
}

/** 原子写：先写同目录临时文件，再 rename 覆盖（进程崩溃不会留下半截手册）。 */
export async function writeFileAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
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
export function matchEntries(entries, query) {
  const terms = querySegments(query);
  if (!terms.length || !entries.length) return entries.slice();
  const docs = entries.map((e) => [e.title, e.condition, e.action, e.rationale].map((s) => s || '').join('\n').toLowerCase());
  const dls = docs.map((d) => querySegments(d).length || 1);
  const avgdl = dls.reduce((a, b) => a + b, 0) / entries.length;
  const N = entries.length;
  const K1 = 1.2, B = 0.75;
  const scored = entries.map((e, i) => {
    let score = 0;
    for (const t of terms) {
      const tf = countOccurrences(docs[i], t);
      if (!tf) continue;
      let df = 0;
      for (const d of docs) if (d.includes(t)) df++;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dls[i] / avgdl));
    }
    return { e, i, score };
  });
  if (!scored.some((x) => x.score > 0)) return entries.slice();
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.e);
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
    return { header, entries: [] };
  }
}