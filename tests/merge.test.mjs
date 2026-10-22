import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMergeSuggestions, MERGE_THRESHOLD_RATIO } from '../lib/merge.js';
import { scoreEntries } from '../lib/playbook.js';

function makeEntry(id, title, condition, action) {
  return { id, title, condition, action, rationale: '', meta: { created: '', updated: '', helpful: 0, harmful: 0 }, extraLines: [] };
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
