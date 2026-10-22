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
// AsyncLocalStorage：跨进程锁的「本次调用链已持锁」上下文（见 withFileLock 的重入判定）。
import { AsyncLocalStorage } from 'node:async_hooks';

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
    else if (k === 'auto') meta.auto = v === 'true';
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
  const parts = [
    'created=' + (meta.created || ''),
    'updated=' + (meta.updated || ''),
    'helpful=' + (meta.helpful || 0),
    'harmful=' + (meta.harmful || 0),
  ];
  if (meta.auto) parts.push('auto=true');
  return parts.join(' ');
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
 *   { op:'add', title, condition, action, rationale?, auto? }
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
        meta: { created: today(), updated: today(), helpful: 0, harmful: 0, ...(op.auto ? { auto: true } : {}) },
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
export async function writeFileAtomic(filePath, text) {
  return withFileLock(filePath, async () => {
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
export function scoreEntries(entries, query) {
  const terms = querySegments(query);
  if (!terms.length || !entries.length) return entries.map((e, i) => ({ e, i, score: 0 }));
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
    return { header, entries: [] };
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
    return { header: initialHeader(), entries: [] };
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

/**
 * 并发改动检测：把「基于 snapshot 生成的 ops」应用到 latest 之前，先看目标条目
 * 是不是已经被别的进程改掉或删掉了。
 *
 * 共享一本手册时，两个实例的 LLM 提案可能指向同一条目：先落地的那份已经改了它，
 * 后落地的那份若直接套用就会覆盖别人的写（last-writer-wins）。因此这里明确报错，
 * 让调用方重试，而不是静默丢弃或覆盖。
 *
 * @returns null 无冲突 / string 冲突说明（可直接当错误信息）
 */
export function detectConflicts(snapshot, latest, ops) {
  const snapById = new Map((snapshot?.entries || []).map((e) => [e.id, e]));
  const latestById = new Map((latest?.entries || []).map((e) => [e.id, e]));
  for (const op of ops || []) {
    if (!op || (op.op !== 'update' && op.op !== 'remove')) continue;
    const id = op.id;
    const before = snapById.get(id);
    const now = latestById.get(id);
    if (!before) {
      if (now) {
        return '手册在本次复盘期间被其他进程改动，请重试：条目 ' + id + ' 是复盘期间新出现的。';
      }
      continue; // 两边都没有 → 交给 applyOps 按既有规则报「id 不存在」
    }
    if (!now) {
      return '手册在本次复盘期间被其他进程改动，请重试：条目 ' + id + ' 已被删除。';
    }
    if (entryFingerprint(before) !== entryFingerprint(now)) {
      return '手册在本次复盘期间被其他进程改动，请重试：条目 ' + id + ' 已被修改。';
    }
  }
  return null;
}