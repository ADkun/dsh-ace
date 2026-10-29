// dsh-ace 的 LLM 提示词资源：Reflector（复盘）。
//
// 核心约束（ACE 论文方法论，写死在提示词里）：
//   1. 增量并入——手册只允许通过结构化的增/改/删操作演化，任何一步都不许
//      产出「整本重写」的新手册（防止已有条目的细节在多轮演化中被磨平）；
//   2. 经验必须结构化：条件（何时适用）、做法（具体怎么做）、依据（为什么有效）。
//
// C4.1：判定权收回给代码。Reflector **只产候选正文**（title/condition/action/rationale），
// 不再让模型选 verdict（new/update/drop）、也不再让模型选 id —— 「新增还是覆盖、覆盖哪一条」
// 由 lib/archive.js 的 decideCandidates 用确定性规则判（normKey/normTitle + 对称 BM25 比率
// + 净分 + 正文长度），于是 Curator 那一次 LLM 调用整个去掉，一次复盘少一次 LLM 往返。

/**
 * Reflector 的 system 提示词（第 33 轮整份重写，四段式）。
 * 输入：任务摘要 + 当前手册摘要；输出：严格 JSON（输出契约不变）。
 *
 * 为什么写成四段式而不是一串编号要求：编号清单一长，模型会按「最容易满足的那条」妥协；
 * 「目标 / 只做什么 / 不做什么（含反例）/ 怎么写才能被召回」这四段各自有唯一的落点，
 * 尤其最后一段把「BM25 到底吃什么词」讲明白 —— 召回质量的责任在这里，不在后处理里。
 */
export const REFLECTOR_SYSTEM = [
  '你是 ACE（Agentic Context Engineering）方法论中的 Reflector：一次任务结束后复盘执行轨迹，',
  '你不执行任务本身，也不复述过程，只产出经验。',
  '',
  '## 目标',
  '从本回合的执行轨迹里，提炼出**能改变未来同类任务做法**的可复用经验。',
  '一条好经验的判据只有一条：下次遇到同一类任务时，看到它就少走一次弯路。',
  '',
  '## 只做什么',
  '1. 每条经验填齐四个字段，一个都不许空：',
  '   - title：一句话标题 = **做什么 + 什么场景**。写成命令式，如「编辑前先读目标文件」。',
  '   - condition：条件，写成「当……时」的触发式，并且**必须含用户真会说出口的词**。',
  '     用户提问时不会说「本仓库的 dsh-ace 插件」，他会说「加个设置项」「跑测试」「改注入」。',
  '     条件里就该出现这类词，因为召回质量的责任在这里。',
  '   - action：做法，**动词开头、可照做**。写成别人能照着一步步做出来的动作序列。',
  '   - rationale：依据，说明为什么有效，可以放本次轨迹里的具体细节（文件名、编号、数字、日期）。',
  '2. 对照给出的当前手册摘要：与已有条目明显重复的经验不要产出。',
  '3. 若输入里附有「此前轮次已提炼的候选」，本轮只提炼它们**还没覆盖到**的新经验；',
  '   一条新的都没有就返回空数组 —— 这是多轮复盘收敛的信号，宁缺毋滥。',
  '',
  '## 不做什么',
  '1. 不写一次性事实：不写「这次改了 3 个文件」「本次测试 536 条」这类只对本次成立的记录。',
  '2. 不写只在本仓库 / 本任务 / 本次会话成立的东西：换个项目就不成立的经验不是经验，是笔记。',
  '3. 不在 condition 里写「本次」「这一轮」「本回合」「今天」「刚才」—— 这类词永远匹配不上未来的任务，',
  '   条目会变成永不触发、永不证伪、永不淘汰的永久占位。',
  '4. 不写空话：action 里不许出现「注意」「小心」「要谨慎」「仔细检查」这类没有动作的说法。',
  '5. 没有值得沉淀的经验就返回空数组。凑数产出的条目会挤占手册容量，比空着更糟。',
  '',
  '反例（模型对反例的服从度高于抽象要求，只留一坏一好，写法与「不做什么」一一对应）：',
  '  坏的：{"title":"重构别漏改","condition":"本次重构时","action":"注意别漏改调用点","rationale":"第 3 轮漏改了 2 处"}',
  '  好的：{"title":"批量重命名要同步调用点","condition":"当批量重命名某个符号、要保证调用点同步时","action":"先用 grep 列出该符号的全部调用点再动手改，改完用同一条 grep 复核命中数并解释差额","rationale":"漏改来自没有先枚举调用点；具体实例：第 3 轮漏改 2 处"}',
  '',
  '## 怎么写才能被召回',
  '1. 手册的检索是 BM25（词面匹配），**不认语义**：只有字面上真的出现过的词才能把条目捞出来。',
  '2. 所以 condition 与 action 里要主动写出将来会复现的词面 —— 而且这是**硬要求**，不是软建议：',
  '   每条候选的 condition 或 action 里**至少要有 2 个「用户真会打出来的说法」**，三类各挑一些：',
  '   ①日常叫法：用户嘴上说的那个词，不是代码里的内部术语；',
  '   ②症状词：报错原文片段，或「不显示」「对不上」「重复」「超时」这类；',
  '   ③动作词：「排查」「重跑」「对比」「清理」这类。',
  '   凑不够 2 个就把这条候选重写，不要提交 —— 只写内部术语的条目，用户提问时永远捞不出来。',
  '3. **同一个东西有几种叫法就写几种**（同义词、口语叫法、缩写都算），全都写进 condition 与 action：',
  '   用户拿哪个词问，就得靠哪个词召回。',
  '   好的：',
  '    {"condition":"当注入的内容不显示、条目像没生效、看着对不上时",',
  '     "action":"排查打分与热度权重，重跑一次对比结果，确认后清理缓存"}',
  '    —— 症状词「不显示 / 没生效 / 对不上」+ 动作词「排查 / 重跑 / 对比 / 清理」，一条里几种叫法都在，',
  '       用户命中其中任何一个都能把它捞回来。',
  '   坏的：',
  '    {"condition":"当 rankInjection 的 score 归一化异常时",',
  '     "action":"检查 normalizeScore 的边界处理"}',
  '    —— 通篇只有内部术语，用户只会说「不显示」「对不上」；这条永远召不回，还白占手册容量。',
  '4. 反过来：只出现一次的名字（临时脚本名、某个 commit 号）不要写进 condition —— 它们不会复现，',
  '   却会把 BM25 的词频稀释掉。',
  '',
  '## 输出契约',
  '只输出一个 JSON 对象，不要输出其它任何文字，格式：',
  '{"candidates":[{"title":"...","condition":"...","action":"...","rationale":"..."}],"notes":"一句话备注"}',
  '没有候选时输出：{"candidates":[],"notes":"..."}',
].join('\n');

/** 候选经验的单行文本（Reflector 多轮输入与日志共用）。 */
export function candidateLine(candidate, index) {
  return '候选' + index + '｜标题：' + candidate.title + '｜条件：' + candidate.condition
    + '｜做法：' + candidate.action + '｜依据：' + candidate.rationale;
}

/**
 * 构造 Reflector 的 user 输入。
 *
 * 多轮复盘（C3）：第 2 轮除了轨迹，还要附上**此前轮次已提炼的全部候选**，
 * 提示词据此要求「只提炼还没覆盖到的新经验」。priorCandidates 为空或缺省时，
 * 输出与单轮完全一致（第 1 轮走的就是这一档）。
 *
 * @param {object} params
 * @param {string} params.summary - 轨迹要点
 * @param {string} [params.outcome] - 本轮结果（成功/失败/未说明）
 * @param {string} [params.playbookDigest] - 当前手册摘要
 * @param {Array} [params.priorCandidates] - 此前轮次已提炼的候选
 * @param {number} [params.round] - 第几轮（只写进文案，便于日志与复现）
 */
export function reflectorUserInput({ summary, outcome, playbookDigest, priorCandidates, round }) {
  const laterRound = Number(round) > 1;
  // A2：第 2 轮起不再重发手册摘要（它在第 1 轮已经给过），此处给明确占位，判重看下方候选。
  const digestText = playbookDigest
    || (laterRound
      ? '（本轮起不再重发手册摘要；判重请对照下方「此前轮次已提炼的候选」以及已确认条目。）'
      : '（手册当前为空）');
  const lines = [
    '## 当前手册摘要（已有哪些经验，不要重复产出）',
    digestText,
    '',
    '## 本次任务',
    '结果：' + (outcome || '未说明'),
    '摘要/轨迹要点：',
    summary,
  ];
  const prior = Array.isArray(priorCandidates) ? priorCandidates : [];
  if (prior.length) {
    lines.push('');
    lines.push('## 此前轮次已提炼的候选（共 ' + prior.length + ' 条）');
    lines.push('下面这些经验**已经提炼过了**，不要重复产出；本轮只补充它们还没覆盖到的新经验，没有就返回空数组。');
    for (let i = 0; i < prior.length; i += 1) lines.push(candidateLine(prior[i], i + 1));
  }
  if (Number(round) > 1) lines.unshift('（多轮复盘：第 ' + Number(round) + ' 轮）');
  return lines.join('\n');
}

/**
 * 从 start 处的 open 括号起做配对扫描，返回与之配对的 close 的**下标**；走到末尾仍未配平返回 -1。
 * 字符串状态机负责跳过括号内的括号与转义引号，所以 `{"a":"}"}` 不会提前收尾。
 * 单拆出来（第 48 轮第五轮 F2）是因为「配平但 JSON.parse 失败」时要拿到那段方括号的下标范围，
 * 好在其内部做降级回收；只看 scanJson 的返回值拿不到范围。
 */
function scanSpanEnd(src, start, open, close) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) { depth++; continue; }
    if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * 从 start 处的 open 括号起做配对扫描，配平到对应 close 时返回那段**原文**；
 * 走到字符串末尾仍未配平则返回 undefined（由调用方决定报什么错）。
 * 解析一律交给调用方（第 48 轮第六轮 G2：对象路径要给 JSON.parse 的 SyntaxError 包一层带现场的报错，
 * 所以这里不再自己 parse）。
 */
function scanJson(src, start, open, close) {
  const end = scanSpanEnd(src, start, open, close);
  if (end === -1) return undefined;
  return src.slice(start, end + 1);
}

/**
 * scanJson 的三态版：把「没配平（多半是输出被截断）」与「配平了但不是合法 JSON
 * （散文里的 [提示] 这类方括号）」分成两种结果 —— 前者是故障现场必须报出来，后者只是噪声该继续找。
 * 旧版 tryScan 把两者压成同一个 undefined，于是顶层数组被截断时会静默回落到数组内部的
 * 第一个 '{' 上，「成功」解析出半条结果（第 48 轮第二轮 Gap 1）。
 * endAt 是配对 close 的下标：noise（配平但 parse 不了）时 F2 要在这个范围里做降级回收。
 * @returns {{kind:'value', value: unknown, endAt: number} | {kind:'truncated'} | {kind:'noise', endAt: number}}
 */
function scanRange(src, start, open, close) {
  const endAt = scanSpanEnd(src, start, open, close);
  if (endAt === -1) return { kind: 'truncated' };
  try {
    return { kind: 'value', value: JSON.parse(src.slice(start, endAt + 1)), endAt };
  } catch {
    return { kind: 'noise', endAt };
  }
}

/**
 * 一个**非空**数组算不算「候选数组」（第 48 轮第二轮 Gap 2）：
 * 至少要有一个非 null 的普通对象才算；全是标量（`[1,2]`、`["提示"]`）当散文噪声，回落到对象路径。
 *
 * 空数组不在这里判 —— 它是弱候选（见 isEmptyArray 与 extractJsonObject 的 S3 口径）：
 * 空数组既是「本轮没有可沉淀的」这个合法收敛信号，也可能是「真结果还在后面」的前缀。
 *
 * 已知歧义（如实写在这里，不声称已消除）：模型先在正文里贴一段「示例数组」再给真结果时，
 * 只要那段示例数组里**装着对象**，它仍会被当成候选数组、真结果被丢掉。代价是这类输出拿错一次
 * candidates；收益是「前言 [1,2] 然后 {...}」这种真有标量方括号的输出还能回到对象路径。
 * 判据只收窄「全是标量」这一端而不要求四字段齐全，是因为再严会误杀模型合法的空壳候选，
 * 而误杀好经验是不可逆损失（红线 15 的口径）。
 */
function isCandidateArray(arr) {
  if (!Array.isArray(arr)) return false;
  return arr.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
}

/** 空数组：合法的「本轮没有可沉淀的」信号，在 extractJsonObject 里降级成弱候选（S3）。 */
function isEmptyArray(arr) {
  return Array.isArray(arr) && arr.length === 0;
}

/**
 * 契约形状的对象：非空 `candidates` / 任意 `pairs` 数组，或四个字段齐全 —— 这类对象本身就是有效结果，
 * 原样返回（**这是「成功路径返回形状不变」的底线**，`{"pairs":[]}` 这种合并结果也因此不会被误当成空壳）。
 *
 * 第 48 轮第五轮 F5：既没有候选数组、四字段又全不齐的对象（`{}`、`{"notes":"没有经验"}`）算空壳，
 * 交给调用方再去看后面还有没有候选数组 —— 否则上层 filter 出 0 候选，复盘会当「本轮收敛」假成功。
 *
 * 第 48 轮第六轮 G1：`{"candidates":[]}` 也排除在契约之外（与 F5 同源的静默假成功）—— 模型常写
 * 「先给个空的，再给真的一批」，把空壳当契约对象就再也不会看后面的真候选数组，复盘立刻贴上「本轮收敛」。
 * 排除后它继续走调用方的 rescued 回落；rescued 也捞不到时仍原样返回这个空壳，所以**单独出现**的
 * `{"candidates":[]}` 行为一个字节都不变（顶层 `[]` 走的是数组路径的 S3 弱候选，与这里无关）。
 */
function isContractObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (Array.isArray(v.pairs)) return true;
  if (Array.isArray(v.candidates) && v.candidates.length > 0) return true;
  return typeof v.title === 'string' && typeof v.condition === 'string'
    && typeof v.action === 'string' && typeof v.rationale === 'string';
}

/**
 * 在 `src.slice(from, to+1)` 这段范围里**按顶层 `{...}`** 逐个回收普通对象（第 48 轮第五轮 F2）。
 * 专门救「括号配平、整体却不是合法 JSON」的数组：尾逗号 `[{"a":1},]`、全角逗号 `[{"a":1}，{"b":2}]`、
 * 元素之间混了散文 `[ 说 {"a":1},{"b":2}]` —— 这类 JSON.parse 整段必失败，但每个对象本身是好的。
 * 规矩：只收普通对象（**不混标量**）；对象本身解析不了就跳过；对象没配平就停手（绝不拿半条）。
 */
function recoverObjectsInRange(src, from, to) {
  const found = [];
  let i = from;
  while (i <= to) {
    const ch = src[i];
    if (ch === '"') {
      // 跳过字符串，避免把字符串里的 { 当成对象起点（复用同一套转义口径）。
      i += 1;
      while (i <= to) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '{') {
      const end = scanSpanEnd(src, i, '{', '}');
      if (end === -1 || end > to) break;
      let value;
      try {
        value = JSON.parse(src.slice(i, end + 1));
      } catch {
        i = end + 1;
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value);
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * 扫出正文里**所有配平的普通对象**（第 49 轮降级回收专用）。
 *
 * 与 `recoverObjectsInRange` 的唯一差别是「遇到没配平的括号怎么办」：那边直接停手（要救的是范围内那一批），
 * 这边**下沉进去继续扫** —— 线上现场恰恰是外层包壳 `{"candidates":[` 与最后一条候选一起被超时切断，
 * 停手就等于把中间写好的几条完整候选也一起扔掉。字符串里的括号照旧跳过、被截断的那个对象本身配不平，
 * 因此永远不会被当成完整对象收进来。
 */
function collectBalancedObjects(src) {
  const found = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '[' || ch === '{') {
      const end = scanSpanEnd(src, i, ch, ch === '[' ? ']' : '}');
      if (end === -1) { i += 1; continue; }
      if (ch === '{') {
        try {
          const value = JSON.parse(src.slice(i, end + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value);
        } catch {
          // 配平却不是合法 JSON 的对象不算数（F2/G2 那批交给 extractJsonObject 自己的回收路径）。
        }
      }
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/** 四字段齐全的普通对象：降级回收出来的候选只有过得了这一关才有意义 —— 上层解析调用点就是按这四条
 *  过滤的（lib/index.js 的 reflectRound / ace_reflect），凑不齐会被 filter 掉，复盘随即当「本轮收敛」假成功。 */
function isFullCandidate(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return typeof v.title === 'string' && typeof v.condition === 'string'
    && typeof v.action === 'string' && typeof v.rationale === 'string';
}

/**
 * **未闭合输出的降级回收（第 49 轮）**：只在调用方**已经确认解析失败**时才用 ——
 * `extractJsonObject` 的语义一个字节都不动（它仍然「真截断必抛」，第 48 轮守的「半条结果不许冒充成功」照旧成立）。
 * 这条路径救的是另一件事：线上 1842 字符那次输出是在某个候选的 rationale 字符串中间被超时切断的，
 * **前面已经有完整候选对象**，整轮按「JSON 不完整」丢掉等于把模型已经提炼出的经验一起扔了。
 * 超时/截断的真语义已由 lib/llm.js 的 finish 分支（aborted / max-tokens）报出，这里只负责「别把写好的那几条一起赔进去」。
 *
 * 规矩（逐条与第 48 轮口径对齐）：
 *   1) 能正常解析的一律走 `extractJsonObject`，结果原样返回 —— 成功路径行为不变（只留四字段齐全的，与上层 filter 同口径）；
 *   2) 否则扫出**配平的**普通对象，四字段齐全即收（既有的 `recoverObjectsInRange` 只收「整段范围内配平的」，
 *      外层包壳 `{"candidates":[…]}` 一旦被截断就整块跳过、里面写好的那几条一起丢 —— 那条范围回收救不了线上现场，
 *      所以在它旁边另起一个「没配平的括号**下沉进去**继续扫」的版本，见 `collectBalancedObjects`）；
 *   3) 一条完整的都收不着时，才退一步看有没有配平的候选数组（元素里的 `null`/标量在这里被过滤掉）；
 *   4) 还收不着就返回空数组 —— 由调用方保持原来的抛错语义（真截断、纯噪声一条都不放过）。
 *
 * @param {string} text LLM 原始输出
 * @returns {object[]} 回收到的候选（可能为空，空即「没救」）
 */
export function recoverCandidatesFromUnclosed(text) {
  const src = String(text ?? '');
  if (src === '') return [];
  try {
    const parsed = extractJsonObject(src);
    const list = Array.isArray(parsed.candidates) ? parsed.candidates.filter(isFullCandidate) : [];
    return list.length > 0 ? list : [];
  } catch {
    // 掉进降级回收：解析确实失败了。
  }
  const picked = collectBalancedObjects(src).filter(isFullCandidate);
  if (picked.length > 0) return picked;
  const rescued = findCandidateArray(src, 0);
  if (rescued) {
    const list = rescued.filter(isFullCandidate);
    if (list.length > 0) return list;
  }
  return [];
}

/**
 * 从 from 起找**第一个**「候选数组」（第 48 轮第五轮 F5 要用：对象的四字段/candidates 都没有时，
 * 后面可能还跟着真正的候选数组，例如 `{} [{"title":"a"},{"title":"b"}]`）。
 * 只看配平且能整体解析的数组；全是标量的不算（同 isCandidateArray 口径）。
 */
function findCandidateArray(src, from) {
  for (let at = src.indexOf('[', from); at !== -1; at = src.indexOf('[', at + 1)) {
    const scanned = scanRange(src, at, '[', ']');
    if (scanned.kind === 'value' && isCandidateArray(scanned.value)) return scanned.value;
  }
  return null;
}

/** JSON 文本里允许出现的字符（结构符、空白、数字、`true/false/null` 的字母、指数的 e/E 与正负号）。 */
const JSON_TEXT_CHARS = new Set(['{', '}', '[', ']', ',', ':', '"', '-', '+', '.',
  ...'0123456789', ...'eEtrufalsn']);

/**
 * `src.slice(from, to)` 这段里（只检查**字符串之外**）有没有一个不可能出现在 JSON 文本里的字符 ——
 * 用来判断「先出现的那个 '[' 到底是不是数组结构的开头」（第 48 轮第四轮 T1 重写，取代 looksLikeJsonPrefix）。
 *
 * 判据：用与 scanJson 同一个字符串状态机走 from → to，**在字符串之外**只要遇到一个不属于 JSON 语汇的
 * 字符（见 JSON_TEXT_CHARS：结构符 `{}[],:"`、空白、数字、`- . + e E`、`true/false/null` 的字母），
 * 就说明这段方括号是散文里开的符号（返回 true）；整段只有 JSON 语汇字符、一个外来字符都没遇见，
 * 就说明它是数组结构的开头（返回 false）。
 *
 * 为什么只看 `arrAt → objAt` 这一段、不扫到字符串末尾（T1：上一版扫到末尾有反向漏口）：
 * `[{"title":"a"} 然后 {"title":"real"}` 与 `[{"title":"a"},{"title":"b" 然后一些中文` 这两类输出里，
 * 方括号**本身**就是数组结构的开头、只是它内部被截断了，末尾的散文是截断之后模型又接上去的。
 * 扫到字符串末尾会把这两类判成「散文里的方括号」→ 回落到数组内部第一个 '{' → 静默返回半条结果，
 * 等于把「输出被截断」这个故障现场重新伪装成一次成功（正是 Gap 1 要防的那件事）。
 * 只看 arrAt → objAt 这一段就没有这个漏口：那个 '{' 落在 arrAt 到 objAt 之间、中间又没有外来字符，
 * 说明它就在数组结构内部，只能是截断。
 *
 * 两侧边界（如实写在这里，不声称已消除）：
 *   - 能区分「'{' 在数组结构内部」（截断，必抛）与「'[' 是散文里开的符号、'{' 在它之后」（噪声，回落对象路径）；
 *   - **无法**区分「散文前缀恰好只用了 JSON 语汇字符」这种形态（例如 `[1,2` 后面接的对象才是真结果）：
 *     这段文本与真截断在离线状态下完全同形，只能按截断处理 —— 宁可报故障现场，也不静默拿半条结果；
 *   - 收尾处仍处于字符串内部（引号没闭合）⇒ 判**散文**（true）：这一段整个在一个没闭合的引号里，
 *     `模型说 "[" 然后 {...}` 这类输出必须继续走对象路径（第 48 轮第三轮 S1c，既有两条用例钉住）；
 *     第 48 轮第五轮 F1 之前，这类「引号没关、对象被吞进半个字符串」的真截断（`["abc {"title":"real"} def`）
 *     会因此被静默解析成功 —— F1 不用改这里，而是在 extractJsonObject 里加了一条「输出以 '[' 开头
 *     ⇒ 顶层就是数组、没配平只能是截断」的判据（见那里的第 3 条口径），两条口径互补、都不许退。
 */
export function hasForeignCharBetween(src, from, to) {
  let inStr = false;
  let esc = false;
  for (let i = from; i < to; i += 1) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (!JSON_TEXT_CHARS.has(ch) && !/\s/.test(ch)) return true;
  }
  // 收尾仍处于字符串内部 ⇒ 这段本身就在一个没闭合的引号里（S1 的 `模型说 "[" 然后 {...}` 就是
  // 引号里写了个 '['，后面那个 '{' 也被吞进同一段字符串），判「散文」（true）继续走对象路径。
  // 注意：**不能**改成「判截断」——否则 S1c 那条既有两个用例（模型说 "[" 然后 {...} → {"title":"real"}）
  // 会被误杀。F1 那类真截断（`["abc {"title":"real"} def`）由调用方的「输出以 '[' 开头」规则兜住，
  // 见 extractJsonObject 第 3 条口径。
  return inStr;
}

/**
 * 从 LLM 输出中提取第一个能解析的 JSON 值。
 * 模型可能裹 ```json 围栏、前后加说明文字，甚至把答案写成顶层数组，这里做容忍性提取：
 *   1) **按「谁先出现」认顶层结构**：先出现的是 '{' 就走对象路径（与改动前逐字同一口径，
 *      原样返回解析出的对象、不包壳）；先出现的是 '[' 就先试数组路径；
 *   2) 数组路径把「候选数组」包成 { candidates: [...] } 返回 —— 这正是 Reflector 的输出契约里
 *      candidates 的位置，模型直接吐 [{...},{...}] 时能救回来，而不是丢掉只取第一个元素；
 *      什么算候选数组见上面的 isCandidateArray（全是标量的算噪声）；
 *   3) 顶层结构判定成数组、数组括号**没配平**（截断）时三路判据（第 48 轮第三/四/五轮 S1·T1·F1）：
 *      · 输出以 '[' 开头（'[' 是全文第一个非空白字符）⇒ 顶层就是数组，没配平只能是截断，当场报未闭合
 *        （F1：`["abc {"title":"real"} def` 这类「引号开了没关、对象被吞进半个字符串」也算这一类）；
 *      · 没有对象可回落（objAt === -1）⇒ 报未闭合；
 *      · 那个 '{' 落在数组结构内部（arrAt → objAt 之间没有外来字符，看 hasForeignCharBetween）⇒ 同样是
 *        截断（`[{"title":"a"} 然后 {"title":"real"}` 末尾的中文是截断之后接上去的，不许拿半条）；
 *      · 中间夹着外来字符（中文散文、引号里写的 "["）⇒ 那段方括号是散文里开了没关的符号，继续走对象
 *        路径（S1 三例：改动前都能拿到对象，判成截断属于回归）；
 *   4) 配平了却不是合法 JSON 的数组（尾逗号 / 全角逗号 / 元素之间混散文）走**降级回收**（第五轮 F2）：
 *      在这段方括号范围内按顶层 `{...}` 逐个回收普通对象，≥1 个就包成 { candidates } —— 只交出一条等于
 *      静默丢数据；**只收对象不收标量**，截断分支一律不回收（绝不拿半条）；
 *   5) **空数组是弱候选**（S3）：`[]` 单独出现仍是 { candidates: [] }（合法收敛信号），但它后面如果还有
 *      能解析的对象，优先返回那个对象 —— 否则 `[] {"title":"real"}` 会被上层当「本轮收敛」假成功；
 *   6) 对象路径解析成功、但拿到的是**空壳对象**（既无 candidates/pairs 数组、四字段又全不齐）时，再看后面
 *      有没有候选数组（第五轮 F5）：`{} [{"title":"a"},{"title":"b"}]` 真候选在后面，返回 `{}` 会让上层
 *      filter 出 0 候选、复盘假成功；旧口径只在「'[' 比 '{' 先出现」时才回看数组，这里放宽成「还没拿到
 *      候选数组就再看一眼」，`[1,2] [{"title":"a"},{"title":"b"}]` 也能拿到真数组；
 *   7) 全都拿不到时，报错带上本次收到的字符数与开头 60 字符 —— 没有现场只能靠源码考古。
 *
 * 为什么是「按谁先出现」而不是「先试 '{' 再兜底 '['」：`[{...},{...}]` 里第一个 '{' 在数组内部，
 * 「先试 '{'」会把它解析成**第一个元素**返回 —— 上层看到的是「没有 candidates 字段」而静默给出 0 候选，
 * 等于把模型真的提炼出来的经验整批丢掉。顶层结构由先出现的括号决定才符合本意。
 * 先出现 '[' 但那段方括号只是散文（配平却 parse 不了的 [提示]、或全是标量的），
 * 一律当噪声回落到对象路径，结果与旧口径一致。
 *
 * 未闭合报的位置一律 **1-based**（数原文里第几个字符，两条路径同一口径，第 48 轮第三轮 S2）：
 * 数组报 arrAt + 1、对象报 objAt + 1。改动前对象路径报的是 0-based 的 objAt，`前言 {"a":1` 会说
 * 「从第 3 字起」而 '{' 其实是第 4 个字符 —— 文案与原文对不上，等于现场失真。
 *
 * 关于 merge 的不变量：包壳只新增了「顶层数组」这一种原本会抛错的输入。合并路径
 * （lib/merge-llm.js 的 parseMergeResult）要的是 obj.pairs，拿到 { candidates: [...] }
 * 会走进它既有的「形状不合格 → 返回 null」分支，仍是 null、绝不抛错。
 */
export function extractJsonObject(text) {
  const src = String(text ?? '');
  const objAt = src.indexOf('{');
  const arrAt = src.indexOf('[');
  let emptyArray = false;
  if (arrAt !== -1 && (objAt === -1 || arrAt < objAt)) {
    const scanned = scanRange(src, arrAt, '[', ']');
    if (scanned.kind === 'truncated') {
      // F1：输出以 '[' 开头 ⇒ 顶层就是数组，没配平只能是截断（绝不回落到数组内部第一个 '{'）。
      const leading = src.slice(0, arrAt).trim() === '';
      // Gap 1 / T1：没有对象可回落 ⇒ 截断；'{' 落在数组结构内部（中间无外来字符）⇒ 截断；
      // 只有中间夹着散文（S1 那三例）才当噪声，继续走对象路径。
      const foreign = objAt === -1 ? false : hasForeignCharBetween(src, arrAt, objAt);
      if (leading || !foreign) {
        throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (arrAt + 1) + ' 字起未闭合）');
      }
    } else if (scanned.kind === 'value') {
      // Gap 2：只认「候选数组」；配平但不是 JSON 的方括号、或全是标量的数组，都当噪声继续找对象。
      if (isCandidateArray(scanned.value)) return { candidates: scanned.value };
      // S3：空数组是弱候选 —— 先记下，等对象路径也拿不到东西时才用它。
      if (isEmptyArray(scanned.value)) emptyArray = true;
      // F5 的同一口径：先出现的是标量数组（不是候选），后面可能还跟着真候选数组 ——
      // 先试它，否则会落进对象路径、只拿到那个数组内部的第一个元素（[1,2] 后面接真候选数组就是这种）。
      const later = findCandidateArray(src, arrAt + 1);
      if (later) return { candidates: later };
    } else {
      // F2：配平却不是合法 JSON 的数组（尾逗号 / 全角逗号 / 元素之间混散文）——
      // 整段降级成噪声会回落到数组内部第一个 '{'、只交出一条，按顶层对象逐个回收。
      const recovered = recoverObjectsInRange(src, arrAt, scanned.endAt);
      if (recovered.length > 0) return { candidates: recovered };
      // 回收不到对象时，同样先看后面有没有真候选数组，再退回对象路径。
      const later = findCandidateArray(src, arrAt + 1);
      if (later) return { candidates: later };
    }
  }
  if (objAt !== -1) {
    // 对象路径的截断口径与数组路径一致（报未闭合、位置 1-based，S2）。
    const segment = scanJson(src, objAt, '{', '}');
    if (segment === undefined) throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (objAt + 1) + ' 字起未闭合）');
    let v;
    try {
      v = JSON.parse(segment);
    } catch (parseError) {
      // G2：配平但非法 JSON（中文逗号、单引号、尾逗号）原本抛裸 SyntaxError —— 既没有 `ace:` 前缀、
      // 也没有「收到多少字符 / 开头是什么」的现场，日志里认不出来是 ACE 的哪一步出的问题。
      // 这里包一层（与「未找到」/「不完整」同一前缀族），原始 message 保留在末尾，别丢。
      // 文案不以「ace: LLM 调用超时」开头 ⇒ 不会被 lib/reflect.js 的 isTimeoutError 误判成超时。
      throw new Error('ace: LLM 输出中的 JSON 对象无法解析（本次收到 ' + src.length + ' 字符，开头：'
        + JSON.stringify(src.slice(0, 60)) + '）：'
        + (parseError && parseError.message ? parseError.message : parseError));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // F5：空壳对象（无 candidates/pairs、四字段又全不齐）→ 后面若跟着候选数组，优先那批真候选。
      if (isContractObject(v)) return v;
      const rescued = findCandidateArray(src, arrAt === -1 ? 0 : arrAt);
      if (rescued) return { candidates: rescued };
      return v;
    }
  }
  // 还没拿到候选数组：最后再试一次（放宽自旧的「'[' 必须比 '{' 先出现」，
  // 这样 `[1,2] [{"title":"a"},{"title":"b"}]` 也能拿到真数组，而不是只取第一条）。
  const rescued = findCandidateArray(src, arrAt === -1 ? 0 : arrAt);
  if (rescued) return { candidates: rescued };
  if (emptyArray) return { candidates: [] };
  throw new Error('ace: LLM 输出中未找到 JSON 对象（本次收到 ' + src.length + ' 字符，开头：'
    + JSON.stringify(src.slice(0, 60)) + '）');
}