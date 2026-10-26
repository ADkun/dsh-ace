#!/usr/bin/env node
// dsh-ace 只读体检脚本（第 37 轮任务 A）。
//
// 定位：**只给调度者（人）诊断用**，不给终端用户用 —— 不进设置页、不进插件运行时、
// 不被 lib/ 或 client.js import。零 LLM 调用、零写盘、只读：本文件没有任何写盘路径。
//
// 用法：
//   node tools/diagnose.mjs
//   node tools/diagnose.mjs --file <playbook.md 路径> --today YYYY-MM-DD
//   node tools/diagnose.mjs --settings <dsh-ace.json 路径>   # 可选，覆盖设置文件解析链
//
// 默认值：手册 = 本机共享层 <DSH home>/ace/playbook.md（本机即 C:/Users/adkun/.dsh/ace/playbook.md），
//         today = 当天（本地时区），设置文件走 lib/settings-path.js 的解析链。
//
// 依赖约束：只 import 本仓库的**纯逻辑**模块。**绝不 import lib/index.js** ——
// 它会拉 @deepseek-ai/* 宿主包，在没有宿主依赖的环境里 import 直接炸。
//
// 五个判据（都在下面具名常量化）：
//   ① 近重复配对：活跃条目两两之间的**对称 BM25 正文比率** >= 0.50 的对数（列 top 5）；
//   ② 僵尸条目：hits === 0，或 lastHit 距今 >= 60 天（列 top 5）；
//   ③ 正文过短：condition + action + rationale 合计字符数 < 80 的条数；
//   ④ 近 30 天：created 在 30 天内的新增条数 + archive.md 里 date 在 30 天内的归档条数（按原因分列）；
//   ⑤ 容量：活跃条数 / maxEntries（设置文件读不到就按默认 100 显示并说明）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parsePlaybook, scoreEntries } from '../lib/playbook.js';
import { computeMergeSuggestions, MERGE_THRESHOLD_RATIO } from '../lib/merge.js';
import { estimateTokens } from '../lib/inject.js';
import { parseArchiveFile, ARCHIVE_REASONS } from '../lib/archive-file.js';
import { resolveSettingsFile } from '../lib/settings-path.js';
import { resolveSharedPlaybookFile, ARCHIVE_FILE_NAME, DEFAULT_MAX_ENTRIES } from '../lib/playbook-path.js';

/** ① 近重复判据：对称 BM25 正文比率阈值（与 lib/merge.js 的 MERGE_THRESHOLD_RATIO 同口径）。 */
export const NEAR_DUP_RATIO = MERGE_THRESHOLD_RATIO;

/** ② 僵尸判据：「lastHit 距今多少天」算长期没被用过。 */
export const ZOMBIE_STALE_DAYS = 60;

/** ③ 过短判据：condition + action + rationale 合计字符数低于此值即「正文太短」。 */
export const SKELETON_BODY_CHARS = 80;

/** ④ 近期判据：多少天内算「近期」。 */
export const RECENT_DAYS = 30;

/** 各组清单最多列几条（top 5）。 */
export const TOP_N = 5;

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 时间戳里的日期部分（毫秒时间戳、纯日期都兼容）；认不出来返回空串。 */
export function dayOf(stamp) {
  const day = String(stamp ?? '').trim().slice(0, 10);
  return DATE_RE.test(day) ? day : '';
}

/** today - day 相差几天（day 比 today 早则为正）；无法解析返回 null。 */
export function daysBetween(today, day) {
  if (!DATE_RE.test(String(today ?? '')) || !DATE_RE.test(String(day ?? ''))) return null;
  const a = Date.parse(String(today) + 'T00:00:00Z');
  const b = Date.parse(String(day) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

/** 条目正文（condition + action + rationale，不含标题；与 lib/merge.js 的 bodyText 同口径）。 */
export function bodyOf(entry) {
  return [entry?.condition, entry?.action, entry?.rationale].map((s) => String(s || '')).join('\n');
}

/** 正文合计字符数（③ 的判据）。 */
export function bodyChars(entry) {
  return [entry?.condition, entry?.action, entry?.rationale].map((s) => String(s || '')).join('').length;
}

/** 投影成「只留正文」的语料条目（title 置空，与 lib/merge.js 的 projectBody 同口径）。 */
function projectBody(entry) {
  return {
    id: entry?.id ?? '',
    title: '',
    condition: String(entry?.condition || ''),
    action: String(entry?.action || ''),
    rationale: String(entry?.rationale || ''),
  };
}

/**
 * 活跃条目两两之间的**对称** BM25 正文比率（全量配对，不只「每条的最相似那一个」）。
 *
 * 算法与 lib/merge.js 的 bodyRatio（:70-84）**逐字同口径**：
 *   fwd = score(b | 用 a 的正文查询) / selfScore(a)
 *   rev = score(a | 用 b 的正文查询) / selfScore(b)
 *   ratio = min(fwd, rev)，再钳到 1
 * 语料是**整本活跃手册**（每对都在同一份 idf / 平均文档长度下算，才能横向比较）。
 *
 * 为什么不直接拿 computeMergeSuggestions 枚举：它每条只返回**最相似的那一条**
 * （:117 的 best），全量配对里第二、第三相似的对会被漏掉。反过来，本函数的口径在
 * 报告里用 computeMergeSuggestions 的返回值做**交叉校验**（见 bestMatchPairs），
 * 保证两处不会悄悄漂移。
 *
 * @param {Array} entries 活跃条目
 * @returns {Array<{aId:string,aTitle:string,bId:string,bTitle:string,ratio:number}>} 按比率降序
 */
export function symmetricRatios(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length < 2) return [];
  const corpus = list.map(projectBody);
  // 每条条目用自己的正文当查询打一遍分：N 次 scoreEntries，之后每对都是查表。
  const scored = list.map((entry) => scoreEntries(corpus, bodyOf(entry)));
  const selfScores = scored.map((hits, i) => {
    const self = hits.find((x) => x.i === i);
    return self ? self.score : 0;
  });
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    if (!(selfScores[i] > 0)) continue; // 正文为空：没有可比的文本
    for (let j = i + 1; j < list.length; j++) {
      if (!(selfScores[j] > 0)) continue;
      const hitJ = scored[i].find((x) => x.i === j);
      const hitI = scored[j].find((x) => x.i === i);
      const fwd = hitJ ? hitJ.score / selfScores[i] : 0;
      const rev = hitI ? hitI.score / selfScores[j] : 0;
      const ratio = Math.min(1, Math.min(fwd, rev));
      if (!(ratio > 0)) continue;
      pairs.push({
        aId: list[i].id,
        aTitle: String(list[i].title || ''),
        bId: list[j].id,
        bTitle: String(list[j].title || ''),
        ratio,
      });
    }
  }
  pairs.sort((x, y) => y.ratio - x.ratio
    || String(x.aId).localeCompare(String(y.aId))
    || String(x.bId).localeCompare(String(y.bId)));
  return pairs;
}

/** ① 近重复配对（比率 >= 阈值）。 */
export function nearDuplicatePairs(entries, threshold = NEAR_DUP_RATIO) {
  const limit = Number(threshold) > 0 ? Number(threshold) : NEAR_DUP_RATIO;
  return symmetricRatios(entries).filter((pair) => pair.ratio >= limit);
}

/**
 * 交叉校验口径：复用 lib/merge.js 的 computeMergeSuggestions（生产合并决策用的就是它）。
 *
 * **每条条目都要跟「除自己以外」的条目比**：直接传 list/list 会让每条都匹配到它自己
 * （语料里它自己就是一份完全相同的文档，比率恒为 1），从而把真正的配对全遮住。
 * 去掉自己之后，语料仍是整本活跃手册（existing + 自己 = 全量），比率与 symmetricRatios 同口径，
 * 两处结果可以直接对照。
 *
 * @returns {Array<{aId:string,bId:string,ratio:number}>}
 */
export function bestMatchPairs(entries, threshold = NEAR_DUP_RATIO) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length < 2) return [];
  const seen = new Set();
  const out = [];
  for (const newEntry of list) {
    const others = list.filter((e) => e !== newEntry);
    if (!others.length) continue;
    const suggestions = computeMergeSuggestions(others, [newEntry], { thresholdRatio: threshold });
    for (const s of suggestions) pushPair(out, seen, s);
  }
  out.sort((x, y) => y.ratio - x.ratio || String(x.aId).localeCompare(String(y.aId)));
  return out;
}

/** 把一条合并建议转成去重后的配对（a/b 有序无关，同一对只留一次）。 */
function pushPair(out, seen, suggestion) {
  const a = String(suggestion.newEntryId || '');
  const b = String(suggestion.bestMatchId || '');
  if (!a || !b || a === b) return;
  const key = a < b ? a + '|' + b : b + '|' + a;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ aId: a, bId: b, ratio: suggestion.ratio });
}

/**
 * ② 僵尸条目：hits === 0，或 lastHit 距今 >= 60 天。
 * lastHit 是空串（从没被命中过）时按 hits 判据走；lastHit 认不出日期则只按 hits 判。
 */
export function zombieEntries(entries, today) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const hits = Number(entry?.meta?.hits) || 0;
    const day = dayOf(entry?.meta?.lastHit);
    const age = day ? daysBetween(today, day) : null;
    const stale = Number.isFinite(age) && age >= ZOMBIE_STALE_DAYS;
    if (hits === 0 || stale) {
      out.push({
        id: String(entry.id || ''),
        title: String(entry.title || ''),
        hits,
        lastHitDay: day,
        ageDays: Number.isFinite(age) ? age : null,
        stale,
      });
    }
  }
  // hits 少的排前面；同 hits 时「更久没被用」的排前面。
  out.sort((x, y) => x.hits - y.hits
    || (y.ageDays === null ? -1 : y.ageDays) - (x.ageDays === null ? -1 : x.ageDays)
    || String(x.id).localeCompare(String(y.id)));
  return out;
}

/** ③ 正文过短的条目。 */
export function skeletonEntries(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const chars = bodyChars(entry);
    if (chars < SKELETON_BODY_CHARS) out.push({ id: String(entry.id || ''), title: String(entry.title || ''), chars });
  }
  out.sort((x, y) => x.chars - y.chars || String(x.id).localeCompare(String(y.id)));
  return out;
}

/** ④ 近 30 天新增的条目。 */
export function recentAdds(entries, today, days = RECENT_DAYS) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const day = dayOf(entry?.meta?.created);
    if (!day) continue;
    const age = daysBetween(today, day);
    if (Number.isFinite(age) && age >= 0 && age <= days) {
      out.push({ id: String(entry.id || ''), title: String(entry.title || ''), createdDay: day });
    }
  }
  out.sort((x, y) => String(y.createdDay).localeCompare(String(x.createdDay)) || String(x.id).localeCompare(String(y.id)));
  return out;
}

/**
 * ④ 近 30 天归档的条目，按原因分列。
 * 「归档时间」取归档行里的 date（lib/archive-file.js 的 archive.date）；认不出日期的不计入。
 */
export function recentArchived(archiveEntries, today, days = RECENT_DAYS) {
  const buckets = {};
  for (const reason of ARCHIVE_REASONS) buckets[reason] = [];
  const unknown = [];
  for (const entry of Array.isArray(archiveEntries) ? archiveEntries : []) {
    const day = dayOf(entry?.archive?.date);
    const age = day ? daysBetween(today, day) : null;
    if (!Number.isFinite(age) || age < 0 || age > days) continue;
    const row = { id: String(entry.id || ''), title: String(entry.title || ''), date: day, reason: String(entry?.archive?.reason || '') };
    if (Object.prototype.hasOwnProperty.call(buckets, row.reason)) buckets[row.reason].push(row);
    else unknown.push(row);
  }
  for (const reason of ARCHIVE_REASONS) {
    buckets[reason].sort((x, y) => String(y.date).localeCompare(String(x.date)) || String(x.id).localeCompare(String(y.id)));
  }
  unknown.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const total = ARCHIVE_REASONS.reduce((n, reason) => n + buckets[reason].length, 0) + unknown.length;
  return { total, buckets, unknown };
}

/**
 * ⑤ 从设置文件读 maxEntries。
 * 读不到（文件不存在 / JSON 坏了 / 值不是 >= 1 的数）都回落 DEFAULT_MAX_ENTRIES 并带一句人话说明，
 * 诊断脚本绝不因为设置文件而崩。
 */
export function readMaxEntries(settingsFile) {
  const file = typeof settingsFile === 'string' && settingsFile.trim() !== '' ? settingsFile : '';
  const fallback = { file, maxEntries: DEFAULT_MAX_ENTRIES, read: false, note: '读不到，按默认 ' + DEFAULT_MAX_ENTRIES + ' 显示' };
  if (!file) return { ...fallback, note: '读不到设置文件路径，按默认 ' + DEFAULT_MAX_ENTRIES + ' 显示' };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && e.code ? e.code : ((e && e.message) || e);
    return { ...fallback, note: '读不到（' + code + '），按默认 ' + DEFAULT_MAX_ENTRIES + ' 显示' };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ...fallback, note: '设置文件不是合法 JSON，按默认 ' + DEFAULT_MAX_ENTRIES + ' 显示' };
  }
  const value = raw && typeof raw === 'object' ? raw.maxEntries : undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    return { ...fallback, note: '设置文件里没有可用的 maxEntries（' + JSON.stringify(value === undefined ? null : value) + '），按默认 ' + DEFAULT_MAX_ENTRIES + ' 显示' };
  }
  return { file, maxEntries: Math.floor(n), read: true, note: '' };
}

/**
 * 跑完五组体检，返回结构化结果（渲染交给 renderReport，两者分开便于单测）。
 *
 * @param {{file?: string, settingsFile?: string, archiveFile?: string, today?: string}} options
 * @returns {object} 失败时 { ok: false, error }，成功时带五组数字
 */
export function diagnose(options = {}) {
  const file = typeof options.file === 'string' && options.file.trim() !== ''
    ? options.file
    : resolveSharedPlaybookFile(undefined);
  const date = String(options.today ?? '').trim();
  const today = DATE_RE.test(date) ? date : localDayString();
  const archiveFile = typeof options.archiveFile === 'string' && options.archiveFile.trim() !== ''
    ? options.archiveFile
    : path.join(path.dirname(file), ARCHIVE_FILE_NAME);
  const settingsFile = typeof options.settingsFile === 'string' && options.settingsFile.trim() !== ''
    ? options.settingsFile
    : resolveSettingsFile(undefined);
  const base = { file, archiveFile, settingsFile, today };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && e.code ? e.code : ((e && e.message) || e);
    return { ...base, ok: false, error: '手册文件读不到（' + code + '）：' + file, entries: [] };
  }
  if (String(text).trim() === '') {
    return { ...base, ok: false, error: '手册是空文件（0 条条目）：' + file, entries: [] };
  }
  let entries;
  try {
    entries = parsePlaybook(String(text)).entries;
  } catch (e) {
    return { ...base, ok: false, error: '手册解析失败（' + ((e && e.message) || e) + '）：' + file, entries: [] };
  }

  // 归档读不了不影响手册体检：降级成「归档读不到」一句说明。
  let archived = { total: 0, buckets: {}, unknown: [] };
  let archiveError = '';
  try {
    const raw = fs.readFileSync(archiveFile, 'utf8');
    archived = recentArchived(parseArchiveFile(raw).entries, today);
  } catch (e) {
    const code = e && e.code ? e.code : ((e && e.message) || e);
    archiveError = '归档读不到（' + code + '）：' + archiveFile;
  }

  return {
    ...base,
    ok: true,
    entries,
    pairs: nearDuplicatePairs(entries),
    crossCheck: bestMatchPairs(entries),
    zombies: zombieEntries(entries, today),
    skeletons: skeletonEntries(entries),
    adds: recentAdds(entries, today),
    archived,
    archiveError,
    capacity: { active: entries.length, ...readMaxEntries(settingsFile) },
    bodyTokens: estimateTokens(entries.map((e) => bodyOf(e)).join('\n')),
  };
}

/** 本地时区的 YYYY-MM-DD（与 lib/archive.js:55 的 dayString 同口径：本地时区切日）。 */
export function localDayString(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

/** 比率渲染成百分比（保留 1 位小数）。 */
function pct(ratio) {
  return (Math.round(Number(ratio) * 1000) / 10).toFixed(1) + '%';
}

/** 结构化结果 → 终端文本（每组一句人话 + 数字 + 清单）。 */
export function renderReport(result) {
  const lines = [];
  lines.push('dsh-ace 只读体检（零 LLM / 零写盘）');
  lines.push('手册：' + (result && result.file ? result.file : '(未知)'));
  lines.push('归档：' + (result && result.archiveFile ? result.archiveFile : '(未知)'));
  lines.push('日期口径：today = ' + (result && result.today ? result.today : '(未知)'));
  lines.push('');
  if (!result || result.ok !== true) {
    lines.push('体检中止：' + ((result && result.error) || '未知原因'));
    return lines.join('\n');
  }
  const pairs = result.pairs || [];
  lines.push('① 近重复配对（对称 BM25 正文比率 >= ' + NEAR_DUP_RATIO + '）：' + pairs.length + ' 对');
  if (!pairs.length) lines.push('   （没有达到阈值的配对）');
  for (const p of pairs.slice(0, TOP_N)) {
    lines.push('   · ' + p.aId + ' ' + p.aTitle + '  ↔  ' + p.bId + ' ' + p.bTitle + '   比率 ' + pct(p.ratio));
  }
  if (pairs.length > TOP_N) lines.push('   （另有 ' + (pairs.length - TOP_N) + ' 对未列出）');
  const cross = result.crossCheck || [];
  lines.push('   交叉校验（computeMergeSuggestions 的最佳匹配对）：' + cross.length + ' 对');

  const zombies = result.zombies || [];
  lines.push('');
  lines.push('② 僵尸条目（hits === 0，或 lastHit 距今 >= ' + ZOMBIE_STALE_DAYS + ' 天）：' + zombies.length + ' 条');
  if (!zombies.length) lines.push('   （没有僵尸条目）');
  for (const z of zombies.slice(0, TOP_N)) {
    // 说清楚是哪一条判据把它抓出来的（hits 判据 / 久未命中判据，可能同时命中）。
    const why = [];
    if (z.hits === 0) why.push('hits = 0（从未被命中）');
    if (z.stale) why.push('lastHit ' + (z.lastHitDay || '（空）') + '，已 ' + z.ageDays + ' 天未命中');
    lines.push('   · ' + z.id + ' ' + z.title + '   ← ' + why.join('；'));
  }
  if (zombies.length > TOP_N) lines.push('   （另有 ' + (zombies.length - TOP_N) + ' 条未列出）');

  const skeletons = result.skeletons || [];
  lines.push('');
  lines.push('③ 正文过短（条件+做法+依据合计 < ' + SKELETON_BODY_CHARS + ' 字符）：' + skeletons.length + ' 条');
  if (!skeletons.length) lines.push('   （没有过短条目）');
  for (const s of skeletons.slice(0, TOP_N)) lines.push('   · ' + s.id + ' ' + s.title + '   正文合计 ' + s.chars + ' 字符');
  if (skeletons.length > TOP_N) lines.push('   （另有 ' + (skeletons.length - TOP_N) + ' 条未列出）');

  const adds = result.adds || [];
  const archived = result.archived || { total: 0, buckets: {}, unknown: [] };
  lines.push('');
  lines.push('④ 近 ' + RECENT_DAYS + ' 天：新增 ' + adds.length + ' 条，归档 ' + archived.total + ' 条');
  const reasonParts = ARCHIVE_REASONS.map((reason) => reason + ' ' + ((archived.buckets && archived.buckets[reason]) || []).length);
  lines.push('   归档按原因：' + reasonParts.join(' / ') + (archived.unknown && archived.unknown.length ? ' / 未标原因 ' + archived.unknown.length : ''));
  for (const reason of ARCHIVE_REASONS) {
    for (const row of ((archived.buckets && archived.buckets[reason]) || []).slice(0, 2)) {
      lines.push('   · ' + reason + '：' + row.id + ' ' + row.title + '（' + row.date + '）');
    }
  }
  if (result.archiveError) lines.push('   ' + result.archiveError);

  const cap = result.capacity || { active: 0, maxEntries: DEFAULT_MAX_ENTRIES, note: '' };
  lines.push('');
  lines.push('⑤ 容量：活跃 ' + cap.active + ' 条 / maxEntries ' + cap.maxEntries + (cap.note ? '（' + cap.note + '）' : ''));
  lines.push('   maxEntries 读数来自设置文件：' + (cap.file || '(未解析出路径)') + (cap.read ? '' : ' —— 未能从该文件读到，故按默认显示'));
  const ratio = cap.maxEntries > 0 ? Math.round((cap.active / cap.maxEntries) * 1000) / 10 : 0;
  lines.push('   占用 ' + ratio + '%；活跃条目正文合计约 ' + (result.bodyTokens || 0) + ' token（estimateTokens 估算）');
  return lines.join('\n');
}

/** 解析命令行参数（--file / --today / --settings / --archive，都支持 --key=value 形态）。 */
export function parseArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] ?? '');
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const value = eq === -1 ? String(argv[++i] ?? '') : arg.slice(eq + 1);
    if (key === 'file') options.file = value;
    else if (key === 'today') options.today = value;
    else if (key === 'settings') options.settingsFile = value;
    else if (key === 'archive') options.archiveFile = value;
    else if (key === 'help') options.help = true;
  }
  return options;
}

/** 命令行入口：把报告打到 stdout。 */
export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write([
      '用法：node tools/diagnose.mjs [--file <playbook.md>] [--today YYYY-MM-DD] [--settings <dsh-ace.json>] [--archive <archive.md>]',
      '',
    ].join('\n'));
    return 0;
  }
  process.stdout.write(renderReport(diagnose(options)) + '\n');
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked && import.meta.url === invoked) main();
