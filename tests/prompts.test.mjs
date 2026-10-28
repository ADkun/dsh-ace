import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFLECTOR_SYSTEM, candidateLine, extractJsonObject } from '../lib/prompts.js';

// 第 33 轮：REFLECTOR_SYSTEM 整份重写成四段式。
// 为什么要四段而不是一串编号要求：编号清单一长，模型会按「最容易满足的那条」妥协；
// 「目标 / 只做什么 / 不做什么（含反例）/ 怎么写才能被召回」四段各有唯一落点。
// 输出契约（candidateLine 的 JSON 形状）保持不变 —— 这是下游 parse 的接口。

test('REFLECTOR_SYSTEM 四段式：目标 / 只做什么 / 不做什么（含反例）/ 怎么写才能被召回 / 输出契约', () => {
  const heads = ['## 目标', '## 只做什么', '## 不做什么', '## 怎么写才能被召回', '## 输出契约'];
  for (const head of heads) assert.ok(REFLECTOR_SYSTEM.includes(head), '缺段落：' + head);
  const order = heads.map((h) => REFLECTOR_SYSTEM.indexOf(h));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, '段落顺序必须固定（目标在最前、输出契约在最后）');
});

test('REFLECTOR_SYSTEM 的「只做什么」把召回责任写死在 condition：触发式 + 用户真会说的词', () => {
  // 条件必须是「当……时」的触发式；召回质量的责任在条件与做法里，不在后处理里。
  assert.ok(/当……时|当……的/.test(REFLECTOR_SYSTEM), '条件要写成「当……时」的触发式');
  assert.ok(/用户真会说出口的词/.test(REFLECTOR_SYSTEM), '必须点明「含用户真会说出口的词」');
  // 做法必须动词开头、可照做。
  assert.ok(/动词开头/.test(REFLECTOR_SYSTEM), '做法要求动词开头');
  // 不写一次性事实 / 不写只在本仓库成立的东西。
  assert.ok(/一次性事实/.test(REFLECTOR_SYSTEM), '必须禁止一次性事实');
  assert.ok(/只在本仓库|本仓库/.test(REFLECTOR_SYSTEM), '必须禁止只在本仓库成立的经验');
  // 反例必须真的给出坏版本与好版本（模型对反例的服从度高于抽象要求）。
  assert.ok(/反例/.test(REFLECTOR_SYSTEM), '不做什么那一段必须带反例');
  assert.ok(/坏的：/.test(REFLECTOR_SYSTEM) && /好的：/.test(REFLECTOR_SYSTEM), '反例要配好坏两个版本的对照');
});

test('REFLECTOR_SYSTEM 的「怎么写才能被召回」讲清 BM25 吃什么词（不许写成语义检索）', () => {
  // 必须**在同一句里**讲清「BM25 是词面匹配、不认语义」——
  // 分成两句、或只在别处提一嘴词面，都不足以纠正模型「写语义近义就够了」的默认倾向。
  assert.ok(/BM25[^\n]*不认语义/.test(REFLECTOR_SYSTEM), '必须在同一句里说明 BM25 只认词面、不认语义');
  assert.ok(/复现的词面/.test(REFLECTOR_SYSTEM), '必须要求写出将来会复现的词面');
  assert.ok(/同义词/.test(REFLECTOR_SYSTEM), '要提醒必要时带同义词');
});

// 第 38 轮 L2a：召回那一段从软建议升级成硬要求 —— 每条至少 2 个「用户真会打出来的说法」，
// 且同一件东西的几种叫法都要写出来，配正例（好的）与反例（坏的）。
// 为什么必须钉死断言：这段提示词的典型退化就是被改成「建议多写同义词」这种软话，
// 复盘模型会挑最容易满足的那条妥协，条目于是在用户提问时永远召不回。
test('REFLECTOR_SYSTEM 的召回段是硬要求：每条候选至少 2 个用户真会打出来的说法', () => {
  assert.ok(/硬要求/.test(REFLECTOR_SYSTEM), '召回段必须明说是硬要求，不是软建议');
  assert.ok(/至少.{0,6}2 ?个/.test(REFLECTOR_SYSTEM), '必须写出数量门槛：至少 2 个');
  assert.ok(/用户真会打出来的说法/.test(REFLECTOR_SYSTEM), '必须点明「用户真会打出来的说法」这个口径');
  // 三类说法各要有落点：日常叫法（不是内部术语）/ 症状词 / 动作词。
  assert.ok(/日常叫法/.test(REFLECTOR_SYSTEM) && /内部术语/.test(REFLECTOR_SYSTEM), '要区分日常叫法与内部术语');
  assert.ok(/症状词/.test(REFLECTOR_SYSTEM) && /不显示/.test(REFLECTOR_SYSTEM), '症状词要给例子');
  assert.ok(/动作词/.test(REFLECTOR_SYSTEM) && /排查/.test(REFLECTOR_SYSTEM), '动作词要给例子');
  // 凑不够就重写，不许提交。
  assert.ok(/重写/.test(REFLECTOR_SYSTEM), '凑不够数量要求时要求重写而不是提交');
});

test('REFLECTOR_SYSTEM 的召回段：同一个东西有几种叫法就写几种（正例 + 反例）', () => {
  assert.ok(/有几种叫法就写几种/.test(REFLECTOR_SYSTEM), '必须写死「有几种叫法就写几种」');
  const recall = REFLECTOR_SYSTEM.slice(REFLECTOR_SYSTEM.indexOf('## 怎么写才能被召回'), REFLECTOR_SYSTEM.indexOf('## 输出契约'));
  assert.ok(/好的：/.test(recall), '召回段要带正例');
  assert.ok(/坏的：/.test(recall), '召回段要带反例');
  // 反例必须是「只写内部术语、用户不会那样问」那种坏法，不是随便一条错话。
  assert.ok(/内部术语/.test(recall.split('坏的：')[1]), '反例要指出病根：通篇只有内部术语');
  // 原两条约束一条都不许被冲掉。
  assert.ok(/只出现一次的名字/.test(recall), '必须保留「不写只出现一次的名字」');
  assert.ok(/词频稀释/.test(recall), '必须说明理由：稀释词频');
  assert.ok(/本次|这一轮/.test(REFLECTOR_SYSTEM), '必须保留「不写本次/这一轮这类永不触发的条件词」');
});

test('输出契约不变：仍然是 {candidates:[{title,condition,action,rationale}],notes} 的 JSON', () => {
  assert.ok(/\{"candidates":/.test(REFLECTOR_SYSTEM), '输出契约里 candidates 外壳必须写死');
  for (const field of ['title', 'condition', 'action', 'rationale']) {
    assert.ok(REFLECTOR_SYSTEM.includes(field), '输出契约必须写出字段名：' + field);
  }
  // 上面那条只查「全篇出现过这个词」—— rationale 在别处也出现过，删掉契约里的字段照样能绿。
  // 这里再钉一次「契约那一行本身」的四个字段，改输出形状必须红。
  const contractLine = REFLECTOR_SYSTEM.split('\n').find((l) => l.includes('{"candidates":'));
  assert.ok(contractLine, '必须有一行写出 candidates 的 JSON 形状');
  for (const field of ['title', 'condition', 'action', 'rationale']) {
    assert.ok(contractLine.includes('"' + field + '"'), '契约那一行必须含字段：' + field);
  }
  assert.ok(/没有候选时输出/.test(REFLECTOR_SYSTEM), '空结果也要给契约');
});

test('candidateLine：候选的单行文本仍带四个字段（多轮复盘输入与日志共用）', () => {
  const line = candidateLine({ title: 'T', condition: 'C', action: 'A', rationale: 'R' }, 1);
  for (const piece of ['标题：T', '条件：C', '做法：A', '依据：R']) {
    assert.ok(line.includes(piece), '缺字段：' + piece);
  }
});

// ── 第 48 轮健壮性缺口「洞 1」：extractJsonObject 容错 + 报错带现场 ──
// 线上那次复盘失败只说「未找到 JSON 对象」，连收到几个字都没记；同时顶层数组本是可以救回来的
// 形状（模型偶尔直接吐 [{...},{...}]）。这里三条守着新口径。

test('extractJsonObject：既有的对象路径一字不改 —— 原样返回解析出的对象，不包壳', () => {
  const obj = { candidates: [{ title: 'T', condition: 'C', action: 'A', rationale: 'R' }], notes: 'n' };
  assert.deepEqual(extractJsonObject(JSON.stringify(obj)), obj, '标准 JSON 原样返回');
  assert.deepEqual(extractJsonObject('好的，结果如下：' + JSON.stringify(obj) + ' 希望有帮助'), obj, '夹在说明文字里也能取出来');
  // 顶层就是对象但对象里没有 candidates 时，也照旧原样返回（是否可用是上层的事）。
  assert.deepEqual(extractJsonObject('{"pairs":[]}'), { pairs: [] }, '任意顶层对象都原样返回');
});

test('extractJsonObject：顶层数组也认 —— 包成 { candidates: [...] } 返回（洞 1 的兜底）', () => {
  const arr = [
    { title: 'T1', condition: 'C1', action: 'A1', rationale: 'R1' },
    { title: 'T2', condition: 'C2', action: 'A2', rationale: 'R2' },
  ];
  assert.deepEqual(extractJsonObject(JSON.stringify(arr)), { candidates: arr }, '顶层数组 → candidates 外壳');
  // 裹在 \`\`\`json 围栏里、前后还有散文，也要能兜住。
  assert.deepEqual(
    extractJsonObject('提炼结果：\n\`\`\`json\n' + JSON.stringify(arr) + '\n\`\`\`\n以上。'),
    { candidates: arr },
    '围栏 + 散文里的顶层数组同样兜住',
  );
  assert.deepEqual(extractJsonObject('[]'), { candidates: [] }, '空数组也是合法数组（收敛信号，不是故障）');
});

/** 抓住 fn 抛出的错误（assert.throws 在本机 Node 返回 undefined，拿不到 message）。 */
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test('extractJsonObject：未闭合对象仍报「JSON 对象不完整」，且文案带「未闭合」与起始位置', () => {
  const err = catchError(() => extractJsonObject('前言 {"candidates":[{"title":"T"'));
  assert.ok(err instanceof Error, '未闭合必须抛错，不许静默返回');
  assert.ok(err.message.startsWith('ace: LLM 输出中的 JSON 对象不完整'), '既有报错前缀必须保留（前缀是 grep 与既有断言的锚）');
  assert.ok(err.message.includes('未闭合'), '文案必须说清是「未闭合」而不是「没找到」：' + err.message);
  assert.ok(/从第 \d+ 字起未闭合/.test(err.message), '要带上从第几字起：' + err.message);
});

test('extractJsonObject：空串 / 纯散文报错带现场 —— 收到多少字符 + 开头 60 字符', () => {
  const empty = catchError(() => extractJsonObject(''));
  assert.ok(empty instanceof Error, '空串必须抛错（这正是线上那次到底发生了什么的关键现场）');
  assert.ok(empty.message.startsWith('ace: LLM 输出中未找到 JSON 对象'), '既有报错前缀必须保留');
  assert.ok(empty.message.includes('收到 0 字符'), '空串要说清收到 0 字符：' + empty.message);
  assert.ok(empty.message.includes('开头：""'), '空串的开头是空字符串（JSON 化的引号对）：' + empty.message);

  const proseText = '这两条经验看起来可以合并，但我没有把握。';
  const prose = catchError(() => extractJsonObject(proseText));
  assert.ok(prose instanceof Error, '纯散文必须抛错');
  assert.ok(prose.message.includes('收到 ' + proseText.length + ' 字符'), '纯散文要报真实字符数：' + prose.message);
  assert.ok(prose.message.includes(JSON.stringify(proseText)), '开头片段必须是原文的 JSON 化前缀：' + prose.message);

  // 超过 60 字符也只截 60 —— 免得一条报错把几百字正文糊进日志。
  const long = catchError(() => extractJsonObject('x'.repeat(500)));
  assert.ok(long instanceof Error, '长散文必须抛错');
  assert.ok(long.message.includes(JSON.stringify('x'.repeat(60))), '开头只取前 60 字符：' + long.message);
  assert.ok(!long.message.includes('x'.repeat(61)), '第 61 个字符不许出现（截断必须真的截断）');
  assert.ok(long.message.includes('收到 500 字符'), '字符数是全文长度，不是截断后的长度：' + long.message);
});

// ── 第 48 轮第二轮 Gap 1 / Gap 2：数组路径的两处收窄 ──
//
// 线上那次失败的典型形态就是「输出被截断」；而「前言里先出现方括号」是同一份散文里最常见的噪声。
// 两头都要钉：截断必须报错（不许把半条结果当成功），噪声必须回落（不许把真结果换成 [1,2]）。

test('R48-Gap1：顶层数组没配平（输出被截断）当场报「未闭合」，绝不回落到数组里的第一个对象', () => {
  const err = catchError(() => extractJsonObject('[{"title":"a"},{"title":"b"}'));
  assert.ok(err instanceof Error, '截断的顶层数组必须抛错，不许静默返回第一个元素');
  assert.ok(err.message.startsWith('ace: LLM 输出中的 JSON 对象不完整'), '既有报错前缀必须保留：' + err.message);
  assert.ok(err.message.includes('未闭合'), '要说是「未闭合」而不是「没找到」：' + err.message);
  assert.ok(err.message.includes('从第 1 字起未闭合'), '位置按 1-based 报数组起点：' + err.message);
  // 前面带散文时位置跟着数组起点走（前言 3 个字 → 数组从第 4 字起）。
  const shifted = catchError(() => extractJsonObject('前言 [{"title":"a"},{"title":"b"}'));
  assert.ok(shifted instanceof Error, '同样必须抛错');
  assert.ok(shifted.message.includes('从第 4 字起未闭合'), '按数组真实起点报位置：' + shifted.message);
});

test('R48-Gap2：散文方括号 / 全是标量的数组都算噪声 —— 回落到对象路径，真结果不许被换成 candidates', () => {
  const real = { candidates: [{ title: 'real' }] };
  assert.deepEqual(
    extractJsonObject('参考 [1,2] 然后 ' + JSON.stringify(real)),
    real,
    '标量数组先出现也必须回落：真结果不能被 {candidates:[1,2]} 顶掉',
  );
  assert.deepEqual(
    extractJsonObject('[1,2] {"title":"real"}'),
    { title: 'real' },
    '标量数组在前时回落对象路径，返回真对象（不包壳）',
  );
  assert.deepEqual(
    extractJsonObject('前言 [提示] 然后 {"title":"real"}'),
    { title: 'real' },
    '配平但 parse 不了的方括号是散文，回落对象路径',
  );
  assert.deepEqual(
    extractJsonObject('["提示","说明"] {"title":"real"}'),
    { title: 'real' },
    '连合法 JSON 的字符串数组也算噪声（全是标量，没有可沉淀的候选）',
  );
});

// ── 第 48 轮第三轮 S1 / S2 / S3：数组路径的截断判定再收窄一层 + 位置基数统一 + 空数组降级 ──
//
// S1：Gap 1 的「没配平就报未闭合」太宽 —— 散文里一个开了没关的方括号（`参考 [1,2`、中文里的
// `提示 [见下`、甚至引号里写的 `"["`）也会被判成故障，而真结果就在后面的对象里。改动前这三类
// 输出都能拿到对象，判成截断属于回归。现在只有「方括号从头到尾只有 JSON 语汇字符」才算真截断。
//
// S2：两条路径的「第几字」基数统一成 1-based（数原文第几个字符），与人读原文对位一致。
//
// S3：空数组降级成弱候选 —— 单独出现仍是收敛信号，但后面还有可解析对象时优先那个对象。

test('R48-S1：散文里开了没关的方括号是噪声，必须回落对象路径拿到真结果（不许判成截断）', () => {
  const real = { title: 'real' };
  assert.deepEqual(extractJsonObject('参考 [1,2 然后 {"title":"real"}'), real,
    '前置散文 + 没配平的数值方括号：方括号里是中文散文，回落对象路径');
  assert.deepEqual(extractJsonObject('提示 [见下 {"title":"real"}'), real,
    '中文散文里的方括号（[见下）：同样回落，不许整批失败');
  assert.deepEqual(extractJsonObject('模型说 "[" 然后 {"title":"real"}'), real,
    '引号里写的 "["：方括号后面紧跟中文，回落对象路径');
  // 反过来：方括号里全是 JSON 语汇字符、只是没配平 —— 这正是真截断，必须照旧报错。
  const err = catchError(() => extractJsonObject('[{"title":"a"},{"title":"b"}'));
  assert.ok(err instanceof Error, '真截断仍必须抛错（S1 的收窄不许把故障现场一起放走）');
  assert.ok(err.message.includes('从第 1 字起未闭合'), '真截断的文案与位置不变：' + err.message);
  const shifted = catchError(() => extractJsonObject('前言 [{"title":"a"},{"title":"b"}'));
  assert.ok(shifted instanceof Error, '带前言的同一份真截断同样必须抛错');
  assert.ok(shifted.message.includes('从第 4 字起未闭合'), '位置按数组真实起点报：' + shifted.message);
});

test('R48-S2：未闭合位置一律 1-based —— 对象路径也一样（数原文第几个字符）', () => {
  // '前言 ' 是 3 个字符，'{' 是原文第 4 个字符。改动前报的是 0-based 的「第 3 字」，与原文对不上。
  const err = catchError(() => extractJsonObject('前言 {"a":1'));
  assert.ok(err instanceof Error, '未闭合对象必须抛错');
  assert.ok(err.message.includes('从第 4 字起未闭合'), '{ 在原文第 4 个字符，必须按 1-based 报：' + err.message);
  const head = catchError(() => extractJsonObject('{"a":1'));
  assert.ok(head.message.includes('从第 1 字起未闭合'), '开头就是对象时从第 1 字起：' + head.message);
});

test('R48-S3：空数组是弱候选 —— 后面还有真结果时优先真结果，单独出现仍是收敛信号', () => {
  assert.deepEqual(extractJsonObject('[] {"title":"real"}'), { title: 'real' },
    '空数组后面还有可解析对象时，必须返回对象而不是假收敛的 {candidates:[]}');
  assert.deepEqual(extractJsonObject('[]'), { candidates: [] },
    '空数组单独出现仍是「本轮没有可沉淀的」这个合法信号（既有口径不许改）');
  assert.deepEqual(extractJsonObject('本轮没有可沉淀的经验：[]'), { candidates: [] },
    '散文 + 空数组同样算收敛信号');
  assert.deepEqual(extractJsonObject('[{"title":"a"}] {"title":"b"}'), { candidates: [{ title: 'a' }] },
    '非空候选数组在后面还有对象时仍优先候选数组（数组先出现即顶层结构，行为不变）');
});

// ── 第 48 轮第四轮 T1：S1 判据的反向漏口 ──
//
// S1 的判据原本「从 arrAt 一直扫到字符串末尾」，于是只要末尾出现中文，整段方括号就被判成散文、
// 不抛未闭合，回落到对象路径拿到**数组内部第一个元素** —— 「输出被截断」又被伪装成一次成功。
// 现在判据只看 arrAt → objAt 这一段：那个 '{' 在数组结构内部就是截断，在散文之后就回落。

test('R48-T1：截断的数组后面接散文，仍必须报未闭合 —— 不许拿数组里的半条结果顶替', () => {
  const err = catchError(() => extractJsonObject('[{"title":"a"},{"title":"b" 然后一些中文'));
  assert.ok(err instanceof Error, '数组内部被截断、末尾又接了散文：仍然是截断，必须抛错');
  assert.ok(err.message.startsWith('ace: LLM 输出中的 JSON 对象不完整'), '既有报错前缀必须保留：' + err.message);
  assert.ok(err.message.includes('从第 1 字起未闭合'), '位置报数组起点（1-based）：' + err.message);

  // 后面跟着一个完整对象也不行：数组结构的开头就是顶层结构，坏在内部就是故障现场。
  const half = catchError(() => extractJsonObject('[{"title":"a"} 然后 {"title":"real"}'));
  assert.ok(half instanceof Error, '数组在第一个元素之后断掉：必须抛错，不许返回 {"title":"a"}');
  assert.ok(!half.message.includes('未找到'), '这是「未闭合」不是「没找到」：' + half.message);
  assert.ok(half.message.includes('从第 1 字起未闭合'), '仍按数组起点报位置：' + half.message);
});

test('R48-T1 回归守护：散文方括号仍回落、真截断仍报错（S1 / Gap 1 的口径一条不许退）', () => {
  const real = { title: 'real' };
  assert.deepEqual(extractJsonObject('参考 [1,2 然后 {"title":"real"}'), real,
    '前置散文 + 没配平的数值方括号：那个 { 在散文之后，回落对象路径');
  assert.deepEqual(extractJsonObject('提示 [见下 {"title":"real"}'), real, '中文散文里的方括号：回落对象路径');
  assert.deepEqual(extractJsonObject('模型说 "[" 然后 {"title":"real"}'), real, '引号里写的 "[":回落对象路径');
  const head = catchError(() => extractJsonObject('[{"title":"a"},{"title":"b"}'));
  assert.ok(head instanceof Error && head.message.includes('从第 1 字起未闭合'), '真截断从第 1 字起：' + (head && head.message));
  const shifted = catchError(() => extractJsonObject('前言 [{"title":"a"},{"title":"b"}'));
  assert.ok(shifted instanceof Error && shifted.message.includes('从第 4 字起未闭合'), '带前言的真截断从第 4 字起：' + (shifted && shifted.message));
});

// ── 第 48 轮第五轮 F1 / F2 / F5：终验报出的三类「静默丢数据」 ──
//
// F1：hasForeignCharBetween 收尾原来「仍在字符串内部 ⇒ 判散文」，与 scanJson 的「没配平 ⇒ 截断」
// 正好相反，于是「字符串没闭合」的截断会被放行、回落到数组内部/后面的对象上。现在收尾判截断
// （与 scanJson 同侧），S1 的三条散文用例靠「那个 { 在散文之后」照旧回落（实测，不是推理）。
//
// F2：数组结构配平、但 JSON.parse 不认（尾逗号 / 全角逗号 / 元素间混散文）时，整段被降级成噪声、
// 回落到对象路径，只能拿到第一条。现在在 arrAt→配对右括号 的范围里按顶层 {...} 逐个回收。
//
// F5：对象路径拿到「空壳对象」（既没有 candidates/pairs 数组、四字段又不齐）就直接返回，
// 后面的真候选数组整批丢掉 —— 比抛错更坏（上层当成本轮收敛）。现在先回头看候选数组。

test('R48-F1：数组开头但字符串没闭合的截断，必须报未闭合（不许拿后面的对象顶替）', () => {
  const a = catchError(() => extractJsonObject('["abc {"title":"real"} def'));
  assert.ok(a instanceof Error, '引号没闭合的数组截断必须抛错，不许返回 {"title":"real"}');
  assert.ok(a.message.startsWith('ace: LLM 输出中的 JSON 对象不完整'), '既有报错前缀必须保留：' + a.message);
  assert.ok(a.message.includes('从第 1 字起未闭合'), '位置按数组起点报（1-based）：' + a.message);

  const b = catchError(() => extractJsonObject('[提示 {"title":"a"},{"title":"b"'));
  assert.ok(b instanceof Error, '数组里先混散文、末尾又没配平：仍是截断，必须抛错');
  assert.ok(b.message.includes('从第 1 字起未闭合'), '仍按数组起点报位置：' + b.message);

  // S1c 反向守护：引号里的 "[" 后面是中文散文，那个 { 在散文之后 —— 必须照旧回落。
  assert.deepEqual(extractJsonObject('模型说 "[" 然后 {"title":"real"}'), { title: 'real' },
    'S1c：引号里写的 "[":那个 { 在散文之后，回落对象路径（F1 不许把它误杀）');
});

test('R48-F2：配平但非法 JSON 的数组，按顶层对象回收 —— 不许只拿第一条', () => {
  const tailComma = extractJsonObject('[{"title":"a"},{"title":"b"},]');
  assert.ok(Array.isArray(tailComma.candidates), '尾逗号数组要回收成 candidates：' + JSON.stringify(tailComma));
  assert.deepEqual(tailComma.candidates.map((c) => c.title), ['a', 'b'], '尾逗号不许丢掉第二条');

  const fullWidth = extractJsonObject('[{"title":"a"}，{"title":"b"}]');
  assert.deepEqual(fullWidth.candidates.map((c) => c.title), ['a', 'b'], '全角逗号同样要两条都收回来');

  const mixed = extractJsonObject('[ 说 {"title":"a","condition":"c","action":"x","rationale":"r"},{"title":"b","condition":"c","action":"x","rationale":"r"}]');
  assert.deepEqual(mixed.candidates.map((c) => c.title), ['a', 'b'], '数组里混了散文但结构配平：两条都要');

  // 截断分支绝不启用回收（Gap 1 / T1 的铁律：截断当场抛，不拿半条）。
  const truncated = catchError(() => extractJsonObject('[{"title":"a"},{"title":"b"}'));
  assert.ok(truncated instanceof Error && truncated.message.includes('从第 1 字起未闭合'),
    '截断仍必须抛错，绝不许走回收：' + (truncated && truncated.message));
});

test('R48-F5：对象路径的「空壳对象」后面还有真候选数组时，必须拿数组', () => {
  const a = { title: 'a', condition: 'c1', action: 'x1', rationale: 'r1' };
  const b = { title: 'b', condition: 'c2', action: 'x2', rationale: 'r2' };
  const gotA = extractJsonObject('{} ' + JSON.stringify([a, b]));
  assert.ok(Array.isArray(gotA.candidates), '空对象后面跟着候选数组：必须拿数组，不许返回 {}：' + JSON.stringify(gotA));
  assert.deepEqual(gotA.candidates.map((c) => c.title), ['a', 'b'], '两条候选都要拿到');

  const gotB = extractJsonObject('{"notes":"没有经验"} ' + JSON.stringify([a]));
  assert.deepEqual(gotB.candidates.map((c) => c.title), ['a'], '带 notes 的空壳对象同样要让位给候选数组');

  const gotC = extractJsonObject('[1,2] ' + JSON.stringify([a, b]));
  assert.deepEqual(gotC.candidates.map((c) => c.title), ['a', 'b'], '标量数组后面还有真候选数组：拿真数组，不是 [1,2]');

  // 形状底线一条不许退：契约对象原样返回（candidates / pairs / 四字段齐全）。
  assert.deepEqual(extractJsonObject('{"pairs":[]}'), { pairs: [] }, '{"pairs":[]} 必须原样返回（merge 的不变量）');
  assert.deepEqual(extractJsonObject(JSON.stringify(a)), a, '四字段齐全的对象原样返回，不许包壳');
  assert.deepEqual(extractJsonObject('[]'), { candidates: [] }, '空数组单独出现仍是收敛信号');
});

// ── 第 48 轮第六轮 G1 / G2：终验报告的两条低危（都属「静默假成功 / 现场丢失」） ──
//
// G1：`{"candidates":[]}` 曾被当成契约对象直接返回，于是「先给个空的、再给真的一批」的模型输出
// 拿到 0 候选 ⇒ 上层贴上「本轮收敛」假成功。现在空 candidates 走 rescued 回落；单独出现时仍原样返回。
//
// G2：对象路径配平但非法 JSON（中文逗号 / 单引号 / 尾逗号）原来抛裸 SyntaxError，没有 `ace:` 前缀、
// 也没有「收到多少字符 / 开头是什么」的现场。现在包成与「未找到」「不完整」同一前缀族的报错，
// 原始 message 保留在末尾。

test('R48-G1a：空 candidates 壳后面跟着真候选数组时，必须拿真数组（不许假成功）', () => {
  const real = [{ title: 'a', condition: 'c', action: 'x', rationale: 'r' }];
  const rescued = extractJsonObject(JSON.stringify({ candidates: [] }) + ' ' + JSON.stringify(real));
  assert.deepEqual(rescued, { candidates: real }, '空壳后面跟着真数组：必须拿真数组：' + JSON.stringify(rescued));
});

test('R48-G1b：空 candidates 壳单独出现时行为一个字节都不变（仍是那个空壳）', () => {
  assert.deepEqual(extractJsonObject('{"candidates":[]}'), { candidates: [] }, '空壳单独出现时原样返回，不许改成外层包壳');
  assert.deepEqual(extractJsonObject('[]'), { candidates: [] }, '顶层 [] 仍是收敛信号（既有用例的底线）');
  assert.deepEqual(extractJsonObject('[] {"title":"real"}'), { title: 'real' }, '[] 后面有真对象时优先真对象（既有用例的底线）');
  assert.deepEqual(extractJsonObject('{"candidates":[{"title":"a"}]}'), { candidates: [{ title: 'a' }] }, '非空 candidates 仍是契约对象，原样返回');
  assert.deepEqual(extractJsonObject('{"pairs":[]}'), { pairs: [] }, 'merge 的 {"pairs":[]} 仍原样返回');
  const rejected = catchError(() => extractJsonObject('本轮没有可沉淀的经验'));
  assert.ok(rejected instanceof Error, '纯散文照旧抛「未找到」（G1 不许把无候选放行成成功）');
});

/** G2 三条用例共用的断言（三种非法 JSON 形态各一条用例，断言口径一致）。 */
function assertJsonUnparseable(text) {
  const err = catchError(() => extractJsonObject(text));
  assert.ok(err instanceof Error, '非法 JSON 必须抛错：' + text);
  assert.ok(err.message.startsWith('ace: LLM 输出中的 JSON 对象无法解析'), '前缀族必须与「未找到」「不完整」连成一片：' + err.message);
  assert.ok(err.message.includes('收到 ' + text.length + ' 字符'), '要带本次收到的字符数：' + err.message);
  assert.ok(err.message.includes(JSON.stringify(text.slice(0, 60))), '要带开头 60 字符的现场：' + err.message);
  assert.ok(/：Expected .+in JSON at position \d+ \(line \d+ column \d+\)$/.test(err.message), '原始 SyntaxError 的 message 必须原样保留在末尾：' + err.message);
  assert.ok(err.message.indexOf('ace:') === 0, '整条必须以 ace: 起头');
  assert.ok(!err.message.includes('调用超时'), '不许被认成超时：' + err.message);
}

test('R48-G2a：对象路径遇中文逗号，报错带 ace: 前缀 + 现场 + 原始 message', () => {
  assertJsonUnparseable('{"a":1，"b":2}');
});

test('R48-G2b：对象路径遇单引号，报错带 ace: 前缀 + 现场 + 原始 message', () => {
  assertJsonUnparseable("{'title':'a'}");
});

test('R48-G2c：对象路径遇尾逗号，报错带 ace: 前缀 + 现场 + 原始 message', () => {
  assertJsonUnparseable('{"title":"a","condition":"c",}');
});
