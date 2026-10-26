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
  '提炼「下次同类任务该怎么做」的可复用经验。你不执行任务本身，也不复述过程，只产出经验。',
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
  '反例（模型对反例的服从度高于抽象要求，请照着「好的版本」写）：',
  '  坏的：',
  '    {"title":"重构别漏改","condition":"本次重构时",',
  '     "action":"注意别漏改调用点","rationale":"第 3 轮漏改了 2 处"}',
  '    —— 问题：条件写成「本次」永远匹配不上未来；做法是「注意」这种空话；',
  '       专有细节（第 3 轮、2 处）占住了正文。',
  '  好的：',
  '    {"title":"批量重命名要同步调用点","condition":"当批量重命名某个符号、要保证调用点同步时",',
  '     "action":"先用 grep 列出该符号的全部调用点再动手改，改完用同一条 grep 复核命中数并解释差额",',
  '     "rationale":"漏改来自没有先枚举调用点；具体实例：第 3 轮漏改 2 处"}',
  '    —— 条件是可被未来提问命中的触发式；做法动词开头、可照做；具体轮次与数字退进依据。',
  '',
  '## 怎么写才能被召回',
  '1. 手册的检索是 BM25（词面匹配），**不认语义**：只有字面上真的出现过的词才能把条目捞出来。',
  '2. 所以 condition 与 action 里要主动写出将来会复现的词面：任务对象（如「注入」「归档」「测试」「配置」）、',
  '   动作（如「重命名」「升级」「迁移」「排查」）、症状（如「报错」「超时」「冲突」「不一致」）。',
  '3. 同一个意思尽量用**用户最可能说的那个词**，不要只写内部术语；必要时在 action 里把同义词也带一句。',
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
 * 多轮复盘（C3）：第 2/3 轮除了轨迹，还要附上**此前轮次已提炼的全部候选**，
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
  const lines = [
    '## 当前手册摘要（已有哪些经验，不要重复产出）',
    playbookDigest || '（手册当前为空）',
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
 * 从 LLM 输出中提取第一个平衡的 JSON 对象并解析。
 * 模型可能裹 ```json 围栏或前后加说明文字，这里做容忍性提取。
 */
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('ace: LLM 输出中未找到 JSON 对象');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('ace: LLM 输出中的 JSON 对象不完整');
}