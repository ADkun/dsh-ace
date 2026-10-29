// 第 49 轮：**未闭合输出的降级回收**（lib/prompts.js 的 recoverCandidatesFromUnclosed）。
//
// 现场：C:\\Users\\adkun\\.dsh\\ace\\debug\\raw.jsonl 最后两条 stage=reflect、round=1 都是
// 「JSON 对象不完整（从第 1 字起未闭合）」，其中 1842 字符那条是**在某条候选的 rationale 字符串中间**
// 被切断的 —— 前面已经有完整候选对象，整轮按「JSON 不完整」丢掉等于把已经提炼出的经验一起扔了。
//
// 这里的判据是双向的：
//   a) `extractJsonObject` 的语义**一个字节都不动**（真截断仍必抛，第 48 轮守的「半条结果不许冒充成功」照旧）；
//   b) 降级回收只在「调用方已确认解析失败」之后兜一次底：扫得到四字段齐全的完整候选就交出它们，
//      一条都扫不到就返回空数组（调用方保持原抛错）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, recoverCandidatesFromUnclosed } from '../lib/prompts.js';

/** 一条四字段齐全的候选（形状与 prompt 契约 candidateLine 一致）。 */
function candidate(title, rationale) {
  return JSON.stringify({
    title,
    condition: '当需要' + title + '时',
    action: '执行' + title + '的步骤',
    rationale: rationale || '依据' + title,
  });
}

test('R49 降级回收｜未闭合正文里已有 2 条完整候选 → 回收这 2 条、不抛错', () => {
  // 线上现场的同构复刻：外层 {"candidates":[ 与第三条候选一起被超时切断，前两条完好。
  const raw = '前言如下：\n{"candidates":['
    + candidate('先跑测试再提交', '线上实测跳过测试导致回滚')
    + ','
    + candidate('改动前先读文件', '盲目改文件把别的任务的改动一起覆盖了')
    + ',{"title":"第三条读到一半就","condition":"当……","action":"……","rationale":"这条在字符串中间被切断';
  // ① 提取层必须仍然拒绝（既有语义不许松动）
  assert.throws(() => extractJsonObject(raw), /JSON 对象不完整（从第 \d+ 字起未闭合）/, '真截断必须仍抛「未闭合」');
  // ② 降级回收救回前两条完整候选，且不抛错
  const salvaged = recoverCandidatesFromUnclosed(raw);
  assert.equal(salvaged.length, 2, '只收配平的完整候选：' + JSON.stringify(salvaged.map((c) => c.title)));
  assert.deepEqual(salvaged.map((c) => c.title), ['先跑测试再提交', '改动前先读文件']);
  assert.equal(salvaged[0].rationale, '线上实测跳过测试导致回滚', '回收出来的正文原样保留');
});

test('R49 降级回收｜一条完整候选都没有 → 返回空数组，调用方保持原来的抛错', () => {
  const raws = [
    '前言 {"candidates":[{"title":"T"', // 真截断：连第一条都没写完
    '[{"title":"a"},{"title":"b"}', // 数组被截断、元素只有 title（凑不齐四字段）
    '没有经验', // 纯噪声
    '', // 空串
  ];
  for (const raw of raws) {
    assert.throws(() => extractJsonObject(raw), undefined, '提取层对这些输入仍必须抛错：' + JSON.stringify(raw.slice(0, 20)));
    assert.deepEqual(recoverCandidatesFromUnclosed(raw), [], '回收不着就必须交空数组，不许编造候选：' + JSON.stringify(raw.slice(0, 20)));
  }
});

test('R49 降级回收｜完整输出的行为不变：与 extractJsonObject 拿到的候选一致', () => {
  const raw = '{"candidates":[' + candidate('A') + ',' + candidate('B') + '],"notes":"两条"}';
  const direct = extractJsonObject(raw).candidates;
  const salvaged = recoverCandidatesFromUnclosed(raw);
  assert.deepEqual(salvaged, direct, '完整输出走的是同一条成功路径，结果一字不差');
});

test('R49 降级回收｜字符串里的花括号不参与配平，被剪断的那条不算完整对象', () => {
  // rationale 里带 } 和 { —— 配平扫描必须当它一个字面量，否则会把半条候选错收进来。
  const raw = '{"candidates":[' + candidate('A', '正文里出现 } 和 { 都是字面量') + ',{"title":"B","rationale":"只写到一半';
  const salvaged = recoverCandidatesFromUnclosed(raw);
  assert.equal(salvaged.length, 1, '只收那一条完整的：' + JSON.stringify(salvaged.map((c) => c.title)));
  assert.equal(salvaged[0].rationale, '正文里出现 } 和 { 都是字面量', '字符串内容原样保留');
});

test('R49 降级回收｜解析调用点已接线：自动复盘与手动复盘两条路径都会先回收再决定抛不抛', async () => {
  // 源码级钉住（与 tests/entries.test.mjs、tests/trajectory.test.mjs 的源码级断言同一口径）：
  // 只改 lib/prompts.js 而忘了接线，这轮修复就白做 —— 线上看到的仍然是「JSON 不完整」。
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const hits = src.split('recoverCandidatesFromUnclosed(raw)').length - 1;
  assert.equal(hits, 2, 'lib/index.js 的两处解析调用点（reflectRound 与 ace_reflect）都要接上降级回收');
  assert.match(src, /if \(!salvaged\.length\) throw error;/, '回收不着时必须原样抛回原来的错误');
});
