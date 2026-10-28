import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
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
// 这条用例要同时钉住「上游把顶层数组包成 candidates」与「下游拿到这个壳仍返回 null」两端，
// 所以直接拿 prompts.js 的实现做对照（不是复制逻辑）。
import { extractJsonObject as extractJsonObjectForTest } from '../lib/prompts.js';
import { flushRawLog, resolveRawLogFile } from '../lib/raw-log.js';

// —— 第 48 轮第二轮 Gap 3：本文件的 DSH_HOME 隔离 ——
// lib/merge-llm.js 的 parseMergeResult 解析失败时会 dumpRaw 一份现场到 <DSH_HOME>/ace/debug/raw.jsonl
// （缺口 B2）。本文件里既有的几条用例故意喂垃圾输出，于是它们会往**用户真实日志**里灌夹具：
// 报告里那 19 行全是这么来的。所以整个文件把 DSH_HOME 指到 os.tmpdir() 下的临时目录，
// 跑完连目录一起删 —— 测试再也不许碰 ~/.dsh。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-merge-home-'));
const PREV_HOME = process.env.DSH_HOME;
const PREV_FLAG = process.env.ACE_RAW_LOG;
process.env.DSH_HOME = TEST_HOME;
delete process.env.ACE_RAW_LOG;
/** 真实 home 的失败现场文件（用户自己的），本文件一个字节都不许往里写。 */
const REAL_RAW_LOG = path.join(os.homedir(), '.dsh', 'ace', 'debug', 'raw.jsonl');
/** 读一个 raw.jsonl 的有效行数；文件不存在算 0 行。 */
function countRawLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
}
/**
 * 给一个 raw.jsonl 拍一张「指纹」：行数 + 字节数 + 全文件摘要 + 末行原文。
 *
 * 为什么不止比行数（第 48 轮第三轮 S5）：只比行数时，某条路径若把真实文件「整行改写」而不是
 * 「追加一行」，行数照样不变、守护照样绿，用户的现场已经被换掉了却报平安。四件一起比才守得住。
 */
function fingerprintRawLog(file) {
  try {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    return {
      exists: true,
      lines: lines.length,
      bytes: buf.length,
      digest: crypto.createHash('sha256').update(buf).digest('hex'),
      lastLine: lines.length > 0 ? lines[lines.length - 1] : '',
    };
  } catch {
    return { exists: false, lines: 0, bytes: 0, digest: '', lastLine: '' };
  }
}
// 模块加载时先给真实文件拍一张指纹：本文件跑完再比一次（见末尾的守护用例）。
const REAL_RAW_LOG_BASELINE = countRawLines(REAL_RAW_LOG);
const REAL_RAW_LOG_FINGERPRINT = fingerprintRawLog(REAL_RAW_LOG);

after(async () => {
  await flushRawLog();
  if (PREV_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_HOME;
  if (PREV_FLAG === undefined) delete process.env.ACE_RAW_LOG;
  else process.env.ACE_RAW_LOG = PREV_FLAG;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

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

// ── 第 48 轮健壮性缺口「洞 1」的合并侧回归 ──
// extractJsonObject 现在会把「顶层数组」包成 { candidates: [...] }。
// 合并要的是 obj.pairs，这个新形状必须走进 parseMergeResult 既有的「形状不合格 → 返回 null」
// 分支：仍然是 null、绝不抛错 —— 合并的失败语义（红线 12：某对失败只跳过这一对）不许被改动波及。
test('R48 parseMergeResult｜顶层数组被 extractJsonObject 包成 {candidates} 后仍是 null，绝不抛错', () => {
  const arr = [
    { title: 'T1', condition: 'C1', action: 'A1', rationale: 'R1' },
    { title: 'T2', condition: 'C2', action: 'A2', rationale: 'R2' },
  ];
  // 先确认上游确实把它包了壳（否则这条用例就成了空转）。
  assert.deepEqual(extractJsonObjectForTest(JSON.stringify(arr)), { candidates: arr }, '上游形状变了要看得见');
  assert.equal(parseMergeResult(JSON.stringify(arr)), null, '顶层数组 → 没有 pairs → null（不抛错）');
  assert.equal(parseMergeResult('合并结果：' + JSON.stringify(arr)), null, '夹在文字里的顶层数组也走同一条 → null');
  assert.equal(parseMergeResult(JSON.stringify({ candidates: arr })), null, '即便模型自己写了 candidates 外壳，没有 pairs 也是 null');
  assert.equal(parseMergeResult('[]'), null, '空数组同样 → null');
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

// ── 第 48 轮第二轮 Gap 3 / Gap 4：失败现场落在临时 home、且 merge 行带 provider/model ──

test('R48-Gap3｜本文件的失败现场只落在临时 DSH_HOME：真实 ~/.dsh 的 raw.jsonl 一行都不许多', () => {
  // 文件顶部已把 DSH_HOME 指到临时目录；这里守两件事：落点跟着走、真实文件没被碰过。
  assert.equal(resolveRawLogFile(), path.join(TEST_HOME, 'ace', 'debug', 'raw.jsonl'), '落点必须由临时 DSH_HOME 派生');
  // S5：行数、字节数、全文件摘要、末行原文四件一起比 —— 追加一行会被行数抓到，整行改写会被
  // 摘要与末行原文抓到，删掉再补同数量行会被字节数与摘要抓到。
  const now = fingerprintRawLog(REAL_RAW_LOG);
  assert.equal(now.exists, REAL_RAW_LOG_FINGERPRINT.exists,
    '真实日志的存在性不许变（开始时 ' + (REAL_RAW_LOG_FINGERPRINT.exists ? '存在' : '不存在') + '）');
  assert.equal(now.lines, REAL_RAW_LOG_FINGERPRINT.lines,
    '测试不许往用户真实日志里写夹具（行数：' + REAL_RAW_LOG_FINGERPRINT.lines + ' → ' + now.lines + '）');
  assert.equal(now.bytes, REAL_RAW_LOG_FINGERPRINT.bytes,
    '字节数也不许变（整行改写而非追加会在这里露馅）：' + REAL_RAW_LOG_FINGERPRINT.bytes + ' → ' + now.bytes);
  assert.equal(now.digest, REAL_RAW_LOG_FINGERPRINT.digest,
    '全文件摘要必须逐字节一致（同数量替换行也会被抓到）');
  assert.equal(now.lastLine, REAL_RAW_LOG_FINGERPRINT.lastLine,
    '末行原文必须一致：改动前 ' + JSON.stringify(REAL_RAW_LOG_FINGERPRINT.lastLine.slice(0, 80))
      + '，改动后 ' + JSON.stringify(now.lastLine.slice(0, 80)));
  assert.equal(REAL_RAW_LOG_BASELINE, REAL_RAW_LOG_FINGERPRINT.lines, '两个基线口径必须自洽（行数）');
});

test('R48-Gap4｜planMerges 透传的 provider/model 真的进了 merge 失败现场（不是空壳行）', async () => {
  const a = makeEntry('ace-001', '批量改名前先列调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const b = makeEntry('ace-002', '批量重命名要核对调用点', '当批量重命名符号时', '先用 grep 列出全部调用点');
  const file = resolveRawLogFile();
  const before = countRawLines(file);
  await planMerges([a, b], {
    ask: async () => '我认为可以合并',
    provider: 'magpie',
    model: 'group/never-stuck',
  });
  await flushRawLog();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= before + 1, '解析失败必须留一行现场：' + (lines.length - before));
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.stage, 'merge');
  assert.equal(last.provider, 'magpie', '缺 provider 的现场等于半份现场：' + JSON.stringify(last));
  assert.equal(last.model, 'group/never-stuck', '带上 model：' + JSON.stringify(last));
  assert.equal(last.raw, '我认为可以合并');
  assert.ok(typeof last.error === 'string' && last.error.startsWith('ace: LLM 输出中未找到 JSON 对象'), '现场要带错误原文：' + last.error);
});

// ── 第 48 轮第五轮 F2：数组降级回收不许破坏合并路径的「形状不合格 → null，绝不抛错」不变量 ──

test('R48-F2 回归｜配平但非法 JSON 的数组送 parseMergeResult 仍是 null、绝不抛错', () => {
  // 尾逗号 / 全角逗号这两类现在会被 extractJsonObject 回收成 { candidates: [...] }。
  // parseMergeResult 要的是 obj.pairs，拿不到就按既有分支返回 null —— 这条不变量一条都不许退。
  for (const raw of ['[{"title":"a"},{"title":"b"},]', '[{"title":"a"}，{"title":"b"}]']) {
    let out;
    assert.doesNotThrow(() => { out = parseMergeResult(raw); }, '合并路径不许因数组回收而抛错：' + raw);
    assert.equal(out, null, '形状不合格（无 pairs）必须返回 null：' + raw);
  }
  // 反向确认回收真的发生了 —— 否则上面两条就退化成永真断言（永远走「没找到 JSON」）。
  const recovered = extractJsonObjectForTest('[{"title":"a"},{"title":"b"},]');
  assert.deepEqual(recovered.candidates.map((c) => c.title), ['a', 'b'], '回收必须真拿到两条（断言不许是永真）');
});
