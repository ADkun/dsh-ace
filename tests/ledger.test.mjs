// dsh-ace 单元测试：按 agent 分账的命中账本（C1，C5.6 的接缝依赖它）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageLedger } from '../lib/ledger.js';

test('账本｜note / peek / take 基本语义', () => {
  const ledger = createUsageLedger();
  const agent = {};
  assert.deepEqual(ledger.peek(agent), []);
  ledger.note(agent, ['ace-001', 'ace-002']);
  assert.deepEqual(ledger.peek(agent), ['ace-001', 'ace-002'], 'peek 不取走');
  assert.deepEqual(ledger.take(agent), ['ace-001', 'ace-002']);
  assert.deepEqual(ledger.peek(agent), [], 'take 之后清空');
  assert.deepEqual(ledger.take(agent), []);
});

test('账本｜去重：同一 id 记两次只算一次', () => {
  const ledger = createUsageLedger();
  const agent = {};
  ledger.note(agent, ['ace-001']);
  ledger.note(agent, ['ace-001', 'ace-002']);
  assert.deepEqual(ledger.take(agent), ['ace-001', 'ace-002']);
});

test('账本｜按 agent 分账：A 的命中不会记到 B 名下', () => {
  const ledger = createUsageLedger();
  const a = {};
  const b = {};
  ledger.note(a, ['ace-001']);
  ledger.note(b, ['ace-009']);
  assert.deepEqual(ledger.take(a), ['ace-001']);
  assert.deepEqual(ledger.take(b), ['ace-009']);
});

test('账本｜只收非空字符串；agent 非对象时安全忽略', () => {
  const ledger = createUsageLedger();
  const agent = {};
  ledger.note(agent, ['ace-001', '', null, undefined, 42, {}, 'ace-002']);
  assert.deepEqual(ledger.take(agent), ['ace-001', 'ace-002']);
  assert.doesNotThrow(() => ledger.note(null, ['ace-001']));
  assert.deepEqual(ledger.take(null), []);
  assert.deepEqual(ledger.peek(undefined), []);
  assert.doesNotThrow(() => ledger.note(agent, 'not-an-array'));
  assert.deepEqual(ledger.take(agent), []);
});

test('账本｜take 返回的是副本，调用方改动不影响内部状态', () => {
  const ledger = createUsageLedger();
  const agent = {};
  ledger.note(agent, ['ace-001']);
  const ids = ledger.take(agent);
  ids.push('ace-999');
  assert.deepEqual(ledger.peek(agent), []);
});
