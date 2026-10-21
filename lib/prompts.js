// dsh-ace 的 LLM 提示词资源：Reflector（复盘）与 Curator（策展）。
//
// 核心约束（ACE 论文方法论，写死在提示词里）：
//   1. 增量并入——手册只允许通过结构化的增/改/删操作演化，任何一步都不许
//      产出「整本重写」的新手册（防止已有条目的细节在多轮演化中被磨平）；
//   2. 经验必须结构化：条件（何时适用）、做法（具体怎么做）、依据（为什么有效）。

/** Reflector 的 system 提示词。输入：任务摘要 + 当前手册摘要；输出：严格 JSON。 */
export const REFLECTOR_SYSTEM = [
  '你是 ACE（Agentic Context Engineering）方法论中的 Reflector：一次任务结束后复盘执行轨迹，',
  '提炼「下次同类任务该怎么做」的可复用经验。你不执行任务本身，也不复述过程，只产出经验。',
  '',
  '产出要求（严格遵守）：',
  '1. 只提炼可泛化的经验：能改变未来同类任务做法的教训/技巧/坑，不写一次性事实。',
  '2. 每条经验必须填齐四个字段：',
  '   - title：一句话标题（命令式，如「编辑前先读目标文件」）；',
  '   - condition：条件——什么情境下适用（具体到可判断）；',
  '   - action：做法——具体怎么做（可执行，不写空话）；',
  '   - rationale：依据——为什么有效（来自本次轨迹的哪个事实）。',
  '3. 对照给出的当前手册摘要：与已有条目明显重复的经验不要产出。',
  '4. 没有值得沉淀的经验就返回空数组，宁缺毋滥。',
  '5. 只输出一个 JSON 对象，不要输出其它任何文字，格式：',
  '   {"candidates":[{"title":"...","condition":"...","action":"...","rationale":"..."}],"notes":"一句话备注"}',
].join('\n');

/** 构造 Reflector 的 user 输入。 */
export function reflectorUserInput({ summary, outcome, playbookDigest }) {
  return [
    '## 当前手册摘要（已有哪些经验，不要重复产出）',
    playbookDigest || '（手册当前为空）',
    '',
    '## 本次任务',
    '结果：' + (outcome || '未说明'),
    '摘要/轨迹要点：',
    summary,
  ].join('\n');
}

/** Curator 的 system 提示词：只做增量 diff，禁止整本重写。 */
export const CURATOR_SYSTEM = [
  '你是 ACE 方法论中的 Curator：把候选经验并入既有手册。你只输出增量操作，',
  '绝对禁止输出「重写后的整本手册」——手册的演化只允许增/改/删三种增量，',
  '这是防止已有条目的细节在多轮演化中被磨平的硬约束。',
  '',
  '输入会给出：既有条目清单（id/标题/条件/做法）与候选经验清单。',
  '对每个候选（按输入顺序）判定：',
  '1. new——手册里没有近似条目，作为新条目加入；',
  '2. update——与某既有条目讲的是同一件事，给出该条目 id，并给出合并后的完整字段',
  '   （title/condition/action/rationale 全量给出：以候选为主、保留既有条目中仍有价值的细节）；',
  '3. drop——无新信息或与既有条目完全重复，给出一句话理由。',
  '',
  '判定标准：condition 相近 + action 相近即视为同一件事；仅表述不同不算重复（取更准确的表述）。',
  '只输出一个 JSON 对象，不要输出其它任何文字，格式：',
  '   {"decisions":[{"index":0,"verdict":"new|update|drop","id":"ace-NNN（仅 update 需要）","title":"...","condition":"...","action":"...","rationale":"...","reason":"仅 drop 需要"}]}',
].join('\n');

/** 构造 Curator 的 user 输入。既有条目用紧凑行表示，控制 token。 */
export function curatorUserInput({ existing, candidates }) {
  const lines = [
    '## 既有条目',
    existing.length
      ? existing.map((e) => '[' + e.id + '] ' + e.title + '｜条件：' + e.condition + '｜做法：' + e.action).join('\n')
      : '（手册当前为空）',
    '',
    '## 候选经验',
  ];
  candidates.forEach((c, i) => {
    lines.push('候选' + i + '｜标题：' + c.title + '｜条件：' + c.condition + '｜做法：' + c.action + '｜依据：' + c.rationale);
  });
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