// dsh-ace 的候选合并判定（C4.2）与归档搬移的纯函数。
//
// 这一层把「新增还是覆盖」的判定权从 LLM 收回给代码（C4.1）：Curator 不再选 verdict/id，
// 候选只带正文四字段，合并规则在这里写死，纯函数、可单测、无 IO。
//
// 依赖方向单向：playbook.js ← merge.js ← archive.js（archive.js 不 import commit.js / index.js）。
//
// **归档判据只剩结构性的三种**（第 33 轮：低分/过期/衰减三条判据已整层删除）：
//   superseded          被更完整的候选取代（decideCandidates 产出）
//   removed-by-request  显式 remove（applyOps 产出）
//   evicted             最少使用淘汰（lib/evict.js 产出）
//   merged              LLM 合并掉的另一半（lib/merge-llm.js 产出）
// 没有「多久没用就归档」的时间判据了：那套东西的前提是「分数会随成败变化」，
// 而分数已经不存在 —— 腾位只由 maxEntries 触发，按 hits 升序淘汰（lib/evict.js）。
// 归档**永不物理删除**：条目搬进独立的 archive.md（lib/archive-file.js）。

import { MERGE_THRESHOLD_RATIO, computeMergeSuggestions } from './merge.js';
import { normKey, normTitle } from './playbook.js';
import { nowStamp } from './timestamp.js';

/**
 * brevity bias 守卫阈值（P1-1，论文 §2.2 点名的塌缩路径）：
 * 旧条目本来会被候选正文直接覆盖，而覆盖是**不可回溯**的 ——
 * 旧正文既不留在活跃区也不进归档文件。于是「越优化越短越通用」会一路把一条
 * 47 字的具体做法覆盖成 4 字的泛泛之谈，且没有任何痕迹。
 * 因此：候选正文比旧正文**短掉超过这个比例**时，不再覆盖，改成
 * 「新增候选 + 旧条目以 superseded 归档」，让旧正文可回溯。
 * 取 0.5（缩短一半以上才算塌缩）：正常的「改写更精炼」通常只缩短 10%~30%，
 * 而真正的塌缩（47 字 → 4 字）远超一半，两侧都有余量，不会被误判。
 */
export const BREVITY_MAX_SHRINK_RATIO = 0.5;

/**
 * 中间档「增量补充」的比率下限（第 31 轮）。
 *
 * **这不是把合并阈值降到 0.4** —— 三档的分工是：
 *   - ratio >= MERGE_THRESHOLD_RATIO（0.5）：现行逻辑不变，覆盖旧正文或「新增 + superseded 归档」；
 *   - SUPPLEMENT_RATIO(0.4) <= ratio < 0.5：同一件事被两个回合各总结了一遍，但候选可能带着旧条目
 *     没有的细节。既不值得占两个名额（900 token 预算下等于砍掉一条真经验的位置），直接丢又浪费
 *     → 不新增、不覆盖，把候选里旧条目**还没有的那部分正文**追加进旧条目；
 *   - ratio < 0.4：两件事，按新增处理。
 *
 * 实测依据（第 31 轮真实手册）：ace-154 ↔ ace-161 ratio=0.4249、ace-159 ↔ ace-162 ratio=0.3936，
 * 都在 0.5 之下，同一件事占着两个名额。
 */
export const SUPPLEMENT_RATIO = 0.4;

/**
 * 归档行/元数据行用的时间戳。
 * 名字是历史遗留（原来只到日），第 33 轮起返回**毫秒时间戳**
 * （本地时区 ISO，形如 2026-10-25T06:12:33.412+08:00）：
 * 淘汰顺序要「同 hits 时 created 更早的先走」，只到日就分不出先后。
 * 所有调用方（commit.js / recap-pipeline.js / index.js）都走这里，口径只有一处。
 */
export function dayString(date = new Date()) {
  return nowStamp(date);
}

/** 条目正文总长（title+condition+action+rationale 的字符数），C4.2 的「候选更长」判据用它。 */
export function bodyLength(entry) {
  return ['title', 'condition', 'action', 'rationale']
    .map((f) => String(entry?.[f] || ''))
    .join('').length;
}

/**
 * 候选正文是否把旧正文「塌缩」掉了（P1-1）：新正文比旧正文短掉超过 BREVITY_MAX_SHRINK_RATIO。
 * 旧正文长度为 0 时不算塌缩（没有可丢的内容）。纯函数，供 decideCandidates 的守卫使用。
 */
export function shrinksTooMuch(oldEntry, body) {
  const before = bodyLength(oldEntry);
  const after = bodyLength(body);
  if (before <= 0) return false;
  return after < before * (1 - BREVITY_MAX_SHRINK_RATIO);
}

/**
 * 候选合并判定（C4.2，写死）：
 * 对每条候选，按序与现有**活跃**条目比对：
 *   1. 完全重复（normKey 相同）→ 丢弃候选，不改动任何条目
 *   2. 同标题（normTitle 相同）或近似（对称 BM25 比率 >= MERGE_THRESHOLD_RATIO）：
 *      - 候选正文显著更短（塌缩，见 shrinksTooMuch）→ 新增 + 旧条目归档（superseded）
 *      - 候选正文更长（更完整）→ 新增 + 旧条目归档（superseded）
 *      - 其余 → 原地更新旧条目（保留 id / 命中计数，只换正文四字段与 updated）
 *   3. 都不命中 → 新增条目
 *
 * 第 33 轮：原来「旧条目净分 > 0 → 无条件覆盖」的分支随净分一起删掉。
 * 没有净分之后，「谁更完整」只能由正文长度判：候选更长就留旧正文（归档可回溯），
 * 否则就地更新。brevity 守卫保留 —— 它防的是「越优化越短越通用」的塌缩，与计分无关。
 *
 * 同一批内已判定的候选会进入 working 视图：更新过的旧条目按新正文继续参与后续比对；
 * 本批新加的条目只用于「完全重复」判定（还没落盘，无法 update 它，命中时按新增处理）。
 *
 * @returns {{ops: Array<object>, supersedes: Array<object>, dropped: Array<object>,
 *            updates: Array<string>, adds: Array<number>}}
 *   ops：可直接交给 applyOps 的增量操作（update 复用既有 id）
 *   supersedes：[{ oldId, candidateIndex }]，新条目 id 要等 applyOps 分配后才能填 supersededBy
 */
export function decideCandidates(entries, candidates, { thresholdRatio } = {}) {
  const threshold = Number(thresholdRatio) || MERGE_THRESHOLD_RATIO;
  const active = (entries || []).filter(Boolean);
  const working = active.map((e) => ({ ...e, provisional: false }));
  const ops = [];
  const supersedes = [];
  const dropped = [];
  const updates = [];
  const adds = [];
  // 中间档「增量补充」的留痕：{ oldId, candidateIndex, ratio, added }
  const supplements = [];
  const fields = (c) => ({
    title: String(c?.title || ''),
    condition: String(c?.condition || ''),
    action: String(c?.action || ''),
    rationale: String(c?.rationale || ''),
  });

  (candidates || []).forEach((candidate, index) => {
    const body = fields(candidate);
    const candidateKey = normKey(body);
    const candidateTitle = normTitle(body);
    // 1) 完全重复 → 丢弃（不改动任何条目）
    const exact = working.find((e) => normKey(e) === candidateKey);
    if (exact) {
      dropped.push({ index, title: body.title, reason: 'duplicate' });
      return;
    }
    // 2) 同标题优先，其次近似（对称 BM25 比率取最大者）
    let match = working.find((e) => normTitle(e) === candidateTitle) || null;
    if (!match && working.length) {
      const [best] = computeMergeSuggestions(working, [body], { thresholdRatio: threshold });
      if (best) match = working.find((e) => e.id === best.bestMatchId) || null;
    }
    // 2b) 中间档（第 31 轮）：0.4 <= ratio < 0.5 走「增量补充」，不新增也不覆盖。
    //     必须在 0.5 的匹配落空之后才算，否则会把本来该走覆盖/取代的候选抢过来。
    if (!match && working.length && threshold > SUPPLEMENT_RATIO) {
      const [near] = computeMergeSuggestions(working, [body], { thresholdRatio: SUPPLEMENT_RATIO });
      if (near && near.ratio < threshold) {
        const old = working.find((e) => e.id === near.bestMatchId) || null;
        if (old && !old.provisional) {
          const extra = missingText(old, body);
          if (extra) {
            const nextRationale = old.rationale ? old.rationale + ' ' + extra : extra;
            ops.push({ op: 'update', id: old.id, title: old.title, condition: old.condition, action: old.action, rationale: nextRationale });
            updates.push(old.id);
            supplements.push({ oldId: old.id, candidateIndex: index, ratio: near.ratio, added: extra });
            Object.assign(old, { rationale: nextRationale });
            return;
          }
          // 候选没有带来任何新细节 → 就是同一件事的重复总结，直接丢（不占名额）。
          dropped.push({ index, title: body.title, reason: 'supplement-redundant' });
          return;
        }
      }
    }
    if (!match) {
      // 3) 都不命中 → 新增
      ops.push({ op: 'add', ...body, auto: true });
      adds.push(index);
      working.push({ ...body, id: '', provisional: true });
      return;
    }
    if (match.provisional) {
      // 本批刚加、还没落盘的条目无法 update：按新增处理（applyOps 会用 normKey 兜底去重）
      ops.push({ op: 'add', ...body, auto: true });
      adds.push(index);
      working.push({ ...body, id: '', provisional: true });
      return;
    }
    // 「新增候选 + 旧条目以 superseded 归档」：旧正文一个字不丢，搬进归档区可回溯。
    const addAndSupersede = () => {
      ops.push({ op: 'add', ...body, auto: true });
      adds.push(index);
      supersedes.push({ oldId: match.id, candidateIndex: index, key: candidateKey });
      const at = working.indexOf(match);
      if (at !== -1) working.splice(at, 1);
      working.push({ ...body, id: '', provisional: true });
    };

    // P1-1 brevity bias 守卫：候选显著更短（缩短超过 BREVITY_MAX_SHRINK_RATIO）时不覆盖 ——
    // 覆盖会让旧正文彻底蒸发，正是论文 §2.2 说的「越优化越短越通用」塌缩。
    // 改为新增 + 旧条目归档（旧正文可回溯）。
    if (shrinksTooMuch(match, body)) {
      addAndSupersede();
      return;
    }
    if (bodyLength(body) > bodyLength(match)) {
      // 候选更完整 → 新增新条目 + 旧条目归档（superseded）
      addAndSupersede();
      return;
    }
    ops.push({ op: 'update', id: match.id, ...body });
    updates.push(match.id);
    Object.assign(match, body);
  });

  return { ops, supersedes, dropped, updates, adds, supplements };
}

/**
 * 中间档「增量补充」用：候选正文里**旧条目还没有的那部分**。
 *
 * 切句口径取保守的一档 —— 按换行与中文句读（。；！？）切成小句，逐句判「旧条目正文里是否已含
 * 这段（去空白后）」。已含的跳过，避免同一句话被追加两遍；候选整体已被旧条目覆盖则返回空串。
 *
 * @param {object} oldEntry - 活跃区里的旧条目
 * @param {object} body - 候选的四字段正文
 * @returns {string} 需要追加的新文本（空串 = 没有新东西）
 */
function missingText(oldEntry, body) {
  const oldBlob = [oldEntry?.condition, oldEntry?.action, oldEntry?.rationale]
    .map((s) => String(s || '')).join('\n');
  const squash = (s) => s.replace(/\s+/g, '');
  const oldFlat = squash(oldBlob);
  const pieces = [body?.condition, body?.action, body?.rationale]
    .map((s) => String(s || ''))
    .join('\n')
    .split(/[\n。；！？;!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = [];
  for (const piece of pieces) {
    const flat = squash(piece);
    if (!flat) continue;
    if (oldFlat.includes(flat)) continue;
    if (kept.some((k) => squash(k) === flat)) continue;
    kept.push(piece);
  }
  return kept.join('；');
}

/**
 * 把 supersedes 解析成归档搬移指令：applyOps 分配好新 id 之后才能写 supersededBy。
 * 靠 normKey 把「计划新增的候选」对上「实际新增的条目」（applyOps 跳过重复项时自然对不上，
 * 对不上就不归档旧条目 —— 宁可少归档，也不写一条指向不存在条目的 supersededBy）。
 */
export function resolveSupersedes(supersedes, ops, addedEntries, date) {
  const day = typeof date === 'string' && date ? date : dayString();
  const moves = [];
  const added = (addedEntries || []).filter(Boolean);
  for (const s of supersedes || []) {
    // 优先用判定时记下的 normKey：被丢弃的候选不会产生 op，用 ops 下标会错位。
    const planned = s && s.key ? null : (ops || [])[s.candidateIndex];
    const key = s && s.key ? s.key : (planned ? normKey(planned) : '');
    if (!key) continue;
    const fresh = added.find((e) => normKey(e) === key);
    if (!fresh) continue;
    moves.push({ id: s.oldId, reason: 'superseded', date: day, supersededBy: fresh.id });
  }
  return moves;
}

/**
 * 执行归档搬移（纯函数）：命中 moves 的条目从活跃区搬到归档列表，
 * 字段与元数据完整保留，并补一条 archive 信息（序列化成 '- 归档：…' 行）。
 * **永不物理删除**：moves 里对不上的 id 直接忽略，绝不抛错。
 */
export function applyArchiveMoves(entries, archives, moves, date) {
  const day = typeof date === 'string' && date ? date : dayString();
  const byId = new Map();
  for (const m of moves || []) if (m && m.id) byId.set(m.id, m);
  const kept = [];
  const moved = [];
  for (const e of entries || []) {
    const move = byId.get(e?.id);
    if (!move) { kept.push(e); continue; }
    const info = { reason: move.reason || '', date: move.date || day };
    if (move.supersededBy) info.supersededBy = move.supersededBy;
    moved.push({ ...e, archived: true, archive: info });
  }
  return { entries: kept, archives: [...(archives || []), ...moved], moved };
}
