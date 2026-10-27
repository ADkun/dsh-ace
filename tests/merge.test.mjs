import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMergeSuggestions, computePairRatios, pairRatioAt, MERGE_THRESHOLD_RATIO } from '../lib/merge.js';
import { scoreEntries } from '../lib/playbook.js';
import {
  MERGE_SYSTEM,
  MERGE_MAX_ROUNDS,
  MERGE_MIN_CALL_MS,
  MERGE_COMMIT_RESERVE_MS,
  mergePairInput,
  parseMergeResult,
  findMergePairs,
  survivingEntry,
  planMerges,
} from '../lib/merge-llm.js';

function makeEntry(id, title, condition, action) {
  return { id, title, condition, action, rationale: '', meta: { created: '', updated: '', hits: 0, lastHit: '' }, extraLines: [] };
}

test('MERGE_THRESHOLD_RATIO is 0.5', () => {
  assert.equal(MERGE_THRESHOLD_RATIO, 0.5);
});

test('computeMergeSuggestions: identical entries => suggestion', () => {
  const existing = [makeEntry('ace-001', '编辑前先读文件', '要修改文件时', '先用 read 读一遍')];
  const newEntries = [makeEntry('ace-002', '编辑前先读文件', '要修改文件时', '先用 read 读一遍')];
  const suggestions = computeMergeSuggestions(existing, newEntries);
  assert.ok(suggestions.length > 0);
  assert.equal(suggestions[0].newEntryId, 'ace-002');
  assert.equal(suggestions[0].bestMatchId, 'ace-001');
});

test('computeMergeSuggestions: totally different => no suggestion', () => {
  const existing = [makeEntry('ace-001', '部署前跑测试', '发布前', 'npm test')];
  const newEntries = [makeEntry('ace-002', '清理临时文件', '磁盘满时', 'rm -rf /tmp')];
  const suggestions = computeMergeSuggestions(existing, newEntries);
  assert.equal(suggestions.length, 0);
});

test('computeMergeSuggestions: empty existing => no suggestion', () => {
  const newEntries = [makeEntry('ace-001', 'test', 'cond', 'act')];
  const suggestions = computeMergeSuggestions([], newEntries);
  assert.equal(suggestions.length, 0);
});

test('computeMergeSuggestions: empty new => no suggestion', () => {
  const existing = [makeEntry('ace-001', 'test', 'cond', 'act')];
  const suggestions = computeMergeSuggestions(existing, []);
  assert.equal(suggestions.length, 0);
});

test('computeMergeSuggestions: multiple new, some match', () => {
  const existing = [
    makeEntry('ace-001', '编辑前先读文件', '要修改文件时', '先用 read 读一遍'),
    makeEntry('ace-002', '部署前跑测试', '发布前', 'npm test'),
  ];
  const newEntries = [
    makeEntry('ace-003', '编辑前先读文件', '要修改文件时', '先用 read 读一遍'), // matches ace-001
    makeEntry('ace-004', '完全不同的东西', '随机条件', '随机做法'), // no match
  ];
  const suggestions = computeMergeSuggestions(existing, newEntries);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].newEntryId, 'ace-003');
  assert.equal(suggestions[0].bestMatchId, 'ace-001');
});

test('computeMergeSuggestions: ratio field in output', () => {
  const existing = [makeEntry('ace-001', '编辑前先读文件', '要修改文件时', '先用 read 读一遍')];
  const newEntries = [makeEntry('ace-002', '编辑前先读文件', '要修改文件时', '先用 read 读一遍')];
  const suggestions = computeMergeSuggestions(existing, newEntries);
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions[0].ratio >= MERGE_THRESHOLD_RATIO);
  assert.ok(suggestions[0].score > 0);
  assert.ok(suggestions[0].selfScore > 0);
});

test('computeMergeSuggestions: custom threshold', () => {
  const existing = [makeEntry('ace-001', '编辑前读文件', '修改文件时', '先 read')];
  const newEntries = [makeEntry('ace-002', '编辑前读文件', '修改文件时', '先 read 再改')];
  // With high threshold, might not match; with low, will
  const high = computeMergeSuggestions(existing, newEntries, { thresholdRatio: 0.99 });
  const low = computeMergeSuggestions(existing, newEntries, { thresholdRatio: 0.01 });
  assert.ok(low.length >= high.length);
});

test('computeMergeSuggestions: ratio 是对称比率且不超过 1（不出现 >100% 的相似度）', () => {
  const existing = [
    makeEntry('ace-001', '配置里缺少超时时间', '配置服务调用时', '设置合理的超时时间'),
    makeEntry('ace-002', '提交前先跑测试', '改完代码要提交', '先跑一遍测试再提交'),
  ];
  const newEntries = [
    makeEntry('ace-003', '配置里缺少重试次数', '配置服务调用时', '设置合理的重试次数'),
    makeEntry('ace-004', '提交前先跑测试', '提交代码之前', '运行 npm test 确认全部通过'),
  ];
  for (const s of computeMergeSuggestions(existing, newEntries)) {
    assert.ok(s.ratio <= 1, '比率必须 ≤ 1，实际 ' + s.ratio);
    assert.ok(s.ratio >= 0);
  }
});

test('computeMergeSuggestions: 只比正文，标题相近但正文不同的两条经验不产生建议', () => {
  const existing = [makeEntry('ace-001', '配置里缺少超时时间', '配置服务调用时', '设置合理的超时时间')];
  const newEntries = [makeEntry('ace-002', '配置里缺少重试次数', '配置服务调用时', '设置合理的重试次数')];
  assert.equal(computeMergeSuggestions(existing, newEntries).length, 0, '同领域不同经验不应被判为高度相似');
});

// —— 第 33 轮：LLM 合并（lib/merge-llm.js） ——
// 找配对仍用 computeMergeSuggestions（对称 BM25 比率 0.5）；找到一对后只把**这一对**的正文
// 喂给 LLM，由它合成一条同构四字段条目。下面是这一层的判据。

test('MERGE_SYSTEM 是四段式提示词：目标 / 只做什么 / 不做什么（含反例）/ 输出契约是 JSON', () => {
  for (const head of ['## 目标', '## 只做什么', '## 不做什么', '## 输出契约']) {
    assert.ok(MERGE_SYSTEM.includes(head), '缺段落：' + head);
  }
  // 段落顺序固定（目标在最前、输出契约在最后）：四段式的价值就在于「各段只有一个落点」。
  const order = ['## 目标', '## 只做什么', '## 不做什么', '## 输出契约'].map((h) => MERGE_SYSTEM.indexOf(h));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, '段落顺序必须固定');
  // 反例：模型对反例的服从度高于抽象要求。
  assert.ok(/反例/.test(MERGE_SYSTEM), '不做什么那一段必须带反例');
  assert.ok(/反例（这样写是错的）/.test(MERGE_SYSTEM), '反例必须点名「这样写是错的」');
  assert.ok(/正例（这样写是对的）/.test(MERGE_SYSTEM), '反例必须配一个正例对照');
  // 输出契约必须是 JSON，且字段名写死在提示词里（否则 parseMergeResult 无从校验）。
  assert.ok(/JSON/i.test(MERGE_SYSTEM), '输出契约必须点明 JSON');
  for (const field of ['title', 'condition', 'action', 'rationale']) {
    assert.ok(MERGE_SYSTEM.includes(field), '输出契约必须写出字段名：' + field);
  }
  // 合并的硬边界：只合成这一对的正文，不许增删别的条目。
  assert.ok(/两条|一对/.test(MERGE_SYSTEM), '提示词必须说明输入是两条经验');
  assert.equal(MERGE_MAX_ROUNDS, 5, '最多 5 轮（每轮处理一对）');
});

test('parseMergeResult：必须过 extractJsonObject；四字段缺一个 / 空字符串都算不合格（返回 null）', () => {
  const good = { title: '迁移前先在影子库试跑', condition: '当要执行数据库迁移时', action: '先在影子库跑一遍', rationale: '实测能提前暴露锁冲突' };
  assert.deepEqual(parseMergeResult(JSON.stringify(good)), good, '标准 JSON 直接通过');
  // 模型常见的「外面裹一层说明」：extractJsonObject 负责剥掉。
  assert.deepEqual(parseMergeResult('好的，结果如下：' + JSON.stringify(good) + ' 希望有帮助'), good, '夹在解释文字里的 JSON 也要能取出来');
  assert.equal(parseMergeResult('这两条可以合并'), null, '不是 JSON → 不合格');
  assert.equal(parseMergeResult(JSON.stringify({ title: '只有一个字段' })), null, '缺字段 → 不合格');
  assert.equal(parseMergeResult(JSON.stringify({ ...good, action: '' })), null, '空字符串 → 不合格');
  assert.equal(parseMergeResult(JSON.stringify({ ...good, title: 42 })), null, '类型不对 → 不合格');
  assert.equal(parseMergeResult(''), null, '空输出 → 不合格');
});

test('survivingEntry：保留 created 更早的那条（同 created 按 id 数字升序）', () => {
  const older = makeEntry('ace-030', 'a', 'c', 'x');
  older.meta.created = '2026-01-01T00:00:00.000+08:00';
  const newer = makeEntry('ace-010', 'b', 'c', 'y');
  newer.meta.created = '2026-05-01T00:00:00.000+08:00';
  // id 编号顺序与创建顺序故意相反：留下谁只许由 created 决定。
  assert.equal(survivingEntry(older, newer).id, 'ace-030');
  assert.equal(survivingEntry(newer, older).id, 'ace-030', '入参顺序不影响结论');

  const same = '2026-03-01T12:00:00.000+08:00';
  const x = makeEntry('ace-100', 'a', 'c', 'x');
  x.meta.created = same;
  const y = makeEntry('ace-009', 'b', 'c', 'y');
  y.meta.created = same;
  assert.equal(survivingEntry(x, y).id, 'ace-009', '同 created → id 数字升序');
});

test('planMerges：一对成功 → 留下更早的 id、另一条 reason=merged、hits 取两条之和、created 沿用留下那条', async () => {
  const a = makeEntry('ace-030', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  a.meta = { created: '2026-01-01T00:00:00.000+08:00', updated: '', hits: 2, lastHit: '2026-02-01T00:00:00.000+08:00' };
  const b = makeEntry('ace-010', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  b.meta = { created: '2026-05-01T00:00:00.000+08:00', updated: '', hits: 1, lastHit: '2026-09-01T00:00:00.000+08:00' };
  const body = { title: '批量重命名要同步调用点', condition: '当批量重命名符号时', action: '先 grep 列调用点，改完再复核', rationale: '漏改来自没有先枚举' };
  const out = await planMerges([a, b], { ask: async () => JSON.stringify(body), date: '2026-10-24T09:00:00.000+08:00' });

  assert.equal(out.moves.length, 1);
  assert.deepEqual(out.moves[0], { id: 'ace-010', reason: 'merged', date: '2026-10-24T09:00:00.000+08:00', supersededBy: 'ace-030' }, '保留 created 更早的 ace-030，另一条按 merged 归档');
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].op, 'update');
  assert.equal(out.ops[0].id, 'ace-030');
  assert.equal(out.ops[0].title, body.title, '正文由 LLM 合成');
  assert.equal(out.ops[0].meta.created, '2026-01-01T00:00:00.000+08:00', 'created 沿用留下那条（更早）');
  assert.equal(out.ops[0].meta.hits, 3, 'hits 取两条之和（2 + 1）');
  assert.equal(out.ops[0].meta.lastHit, '2026-09-01T00:00:00.000+08:00', 'lastHit 取较新者');
  assert.equal(out.failed.length, 0);
});

test('planMerges 永不抛错：LLM 抛错只记 failed；输出不合格只记 bad-output；ask 缺失返回空计划', async () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const out = await planMerges([a, b], { ask: async () => { throw new Error('provider 抽风'); } });
  assert.deepEqual(out.ops, []);
  assert.deepEqual(out.moves, [], '一对都没合并成，就不许有归档搬移');
  assert.equal(out.failed.length >= 1, true, '失败要留痕：' + JSON.stringify(out.failed));
  assert.equal(out.failed[0].reason, 'llm-error');

  // 输出不合格：同样只记 failed，不算合并。
  const bad = await planMerges([a, b], { ask: async () => '我认为可以合并' });
  assert.deepEqual(bad.moves, []);
  assert.equal(bad.failed[0].reason, 'bad-output');

  // 没有合并能力（ask 缺失）→ 直接空计划，也不抛。
  const none = await planMerges([a, b], {});
  assert.deepEqual(none, { ops: [], moves: [], merged: [], failed: [] });
});

test('planMerges：配对只喂这一对（mergePairInput 里只有两条正文，不夹带别的条目）', async () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const noise = makeEntry('ace-003', 'CSS 布局一律用 grid', '要写页面布局时', '直接用 grid 排版');
  const asked = [];
  await planMerges([a, b, noise], {
    ask: async (text) => { asked.push(text); return JSON.stringify({ title: 't', condition: 'c', action: 'a', rationale: 'r' }); },
  });
  assert.equal(asked.length, 1, '只问一轮（一对）');
  assert.ok(asked[0].includes('ace-001') && asked[0].includes('ace-002'), '这一对的两条都要在：' + asked[0]);
  assert.equal(asked[0].includes('ace-003'), false, '绝不夹带第三对');
});

test('findMergePairs：对称 BM25 比率 >= 阈值才成对，且各条只出现在一对里', () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const c = makeEntry('ace-003', 'CSS 布局一律用 grid', '要写页面布局时', '直接用 grid 排版');
  const pairs = findMergePairs([a, b, c]);
  assert.equal(pairs.length, 1, '只有 a↔b 够像：' + JSON.stringify(pairs.map((p) => [p.a.id, p.b.id])));
  assert.deepEqual([pairs[0].a.id, pairs[0].b.id].sort(), ['ace-001', 'ace-002']);
});

// —— 第 45 轮：配对矩阵（computePairRatios + pairRatioAt）——
// 性能修复的前提是「口径不变」：矩阵比值必须和旧 bodyRatio（query=正文对全语料打两遍分）
// 逐位一致。这里在测试里把旧 bodyRatio 的原始算法重抄一遍当对照（scoreEntries 是公开导出），
// 对每对 (i, j) 逐位比较。

/**
 * 旧版 bodyRatio 的原样重抄（lib/merge.js 改造前的算法，保留作对照锚）。
 * 生产里它只被 computeMergeSuggestions 调用，而后者喂进来的语料是 projectBody 投影过的
 * （title 置空 —— 标题不参与相似度），所以对照锚也要先投影，否则锚本身就不是旧口径。
 */
function legacyBodyRatio(entries, ia, ib) {
  const corpus = entries.map((e) => ({ ...e, title: '' }));
  const bodyText = (e) => [e.condition, e.action, e.rationale].filter((s) => typeof s === 'string').join('\n').toLowerCase();
  const qa = bodyText(corpus[ia]);
  const qb = bodyText(corpus[ib]);
  if (!qa || !qb) return 0;
  const byA = scoreEntries(corpus, qa);
  const byB = scoreEntries(corpus, qb);
  const selfA = byA.find((x) => x.i === ia)?.score || 0;
  const hitB = byA.find((x) => x.i === ib)?.score || 0;
  const selfB = byB.find((x) => x.i === ib)?.score || 0;
  const hitA = byB.find((x) => x.i === ia)?.score || 0;
  if (!(selfA > 0) || !(selfB > 0)) return 0;
  const r = Math.min(hitB / selfA, hitA / selfB);
  return r <= 0 ? 0 : Math.min(1, r);
}

test('R45｜computePairRatios + pairRatioAt 与旧 bodyRatio 逐位一致（含空正文=0、对称、钳 1）', () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const c = makeEntry('ace-003', 'CSS 布局一律用 grid', '要写页面布局时', '直接用 grid 排版');
  const d = makeEntry('ace-004', '空正文条目', '', '');
  const e2 = makeEntry('ace-005', '重复提交前先查幂等键', '当要重发请求时', '先带同一个幂等键查询结果再决定重发');
  const entries = [a, b, c, d, e2];
  const ratios = computePairRatios(entries);
  assert.equal(ratios.n, entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = 0; j < entries.length; j++) {
      const got = pairRatioAt(ratios, i, j);
      const want = legacyBodyRatio(entries, i, j);
      assert.equal(got, want, `pairRatioAt(${i},${j}) = ${got}，旧算法 = ${want}`);
      assert.equal(pairRatioAt(ratios, j, i), pairRatioAt(ratios, i, j), '矩阵比值必须对称');
    }
  }
  assert.equal(pairRatioAt(ratios, 0, 3), 0, '空正文那行（rows=null）比值必须是 0');
  assert.equal(pairRatioAt(ratios, 0, 0), 1, '自己对自己的数学值是 1（旧 bodyRatio 同款）；findMergePairs 用 j!==i 跳开它');
  // 完全同文的两条 → 比率恰好 1（min(1,1)），不许冒出 >100%。
  const t1 = makeEntry('ace-010', 't', '同一句话', '同一个做法');
  const t2 = makeEntry('ace-011', 't', '同一句话', '同一个做法');
  const rt = pairRatioAt(computePairRatios([t1, t2]), 0, 1);
  assert.equal(rt, 1, '同文比率必须是 1，实际 ' + rt);
  // 钳 1 必须真的在钳（变异自证的牙齿）：手工造一份「双向比率都 >1」的矩阵
  //（stub，不经打分），没有那层 Math.min(1, r) 时这里拿到的是 1.5。
  const stub = {
    n: 2,
    selfs: Float64Array.from([2, 1]),
    rows: [Float64Array.from([2, 3]), Float64Array.from([3, 1])],
  };
  assert.equal(pairRatioAt(stub, 0, 1), 1, '双向都超 1 时必须钳到 1（无钳会得 1.5）');
  const stub2 = {
    n: 2,
    selfs: Float64Array.from([2, 1]),
    rows: [Float64Array.from([2, 1]), Float64Array.from([0.5, 1])],
  };
  assert.equal(pairRatioAt(stub2, 0, 1), 0.5, '正常子 1 比率必须原样透传');
});

test('R45｜findMergePairs（矩阵版）与旧实现同配对：3 条目还是只成 a↔b 一对', () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const c = makeEntry('ace-003', 'CSS 布局一律用 grid', '要写页面布局时', '直接用 grid 排版');
  const blank = makeEntry('ace-004', '空正文', '', '');
  const pairs = findMergePairs([a, b, c, blank]);
  assert.equal(pairs.length, 1, '空正文条目不参与配对：' + JSON.stringify(pairs.map((p) => [p.a.id, p.b.id])));
  assert.deepEqual([pairs[0].a.id, pairs[0].b.id].sort(), ['ace-001', 'ace-002']);
  assert.ok(pairs[0].ratio >= MERGE_THRESHOLD_RATIO);
});

test('R45｜planMerges 预算闸：剩余预算不足就不发起新的一对（warn、不抛、已有部分照常返回）', async () => {
  assert.equal(MERGE_MIN_CALL_MS, 10000);
  assert.equal(MERGE_COMMIT_RESERVE_MS, 8000);
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const body = { title: 't', condition: 'c', action: 'a', rationale: 'r' };
  const warns = [];
  let asked = 0;
  const out = await planMerges([a, b], {
    ask: async () => { asked += 1; return JSON.stringify(body); },
    date: '2026-10-27T09:00:00.000+08:00',
    logger: { info: () => {}, warn: (m) => warns.push(String(m)) },
    budget: { remaining: () => MERGE_COMMIT_RESERVE_MS + MERGE_MIN_CALL_MS - 1 },
  });
  assert.equal(asked, 0, '预算连一次调用的最小份额都不够 → 一对都不许发起');
  assert.deepEqual(out.ops, []);
  assert.deepEqual(out.moves, []);
  assert.equal(warns.length, 1, '要留一条 warn：' + JSON.stringify(warns));
  assert.ok(warns[0].includes('合并剩余预算不足'), warns[0]);
});

test('R45｜planMerges 预算闸：第一对成功后预算耗尽 → 只合并这一对，部分结果照常返回（红线 12）', async () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const c = makeEntry('ace-003', '重复提交前先查幂等键', '当要重发请求时', '先带同一个幂等键查询结果再决定重发');
  const d = makeEntry('ace-004', '重发请求要带幂等键', '当要重发请求时', '先带同一个幂等键查询结果再决定重发');
  const body = { title: 't', condition: 'c', action: 'a', rationale: 'r' };
  const asked = [];
  let remaining = 200000;
  const out = await planMerges([a, b, c, d], {
    ask: async (text, opts) => {
      asked.push(opts);
      remaining = MERGE_COMMIT_RESERVE_MS + MERGE_MIN_CALL_MS - 1; // 第一问之后预算见底
      return JSON.stringify(body);
    },
    date: '2026-10-27T09:00:00.000+08:00',
    logger: { info: () => {}, warn: () => {} },
    budget: { remaining: () => remaining },
  });
  assert.equal(asked.length, 1, '第二对不许再发起：' + JSON.stringify(asked.length));
  assert.equal(out.merged.length, 1, '第一对的结果要完整保留（部分成功也是成功）');
  assert.equal(out.moves.length, 1);
  assert.equal(out.failed.length, 0, '预算耗尽不是失败，不许记 failed：' + JSON.stringify(out.failed));
  assert.ok(asked[0] && asked[0].maxMs >= MERGE_MIN_CALL_MS, '首次调用要带上剩余预算派生的 maxMs：' + JSON.stringify(asked[0]));
});

test('R45｜planMerges 无预算（deps.budget 缺失）时 ask 不带 maxMs —— 老调用方行为不变', async () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点再改');
  const body = { title: 't', condition: 'c', action: 'a', rationale: 'r' };
  const opts = [];
  await planMerges([a, b], {
    ask: async (text, o) => { opts.push(o); return JSON.stringify(body); },
    date: '2026-10-27T09:00:00.000+08:00',
  });
  assert.equal(opts.length, 1);
  assert.equal(opts[0].maxMs, undefined, '无预算 → 不派 maxMs（单次上限照旧兜底）');
});
