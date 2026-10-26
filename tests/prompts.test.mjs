import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFLECTOR_SYSTEM, candidateLine } from '../lib/prompts.js';

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
