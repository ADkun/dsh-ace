import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUTATING_TOOLS,
  isMainAgent,
  hasNoRunningSubagents,
  isMutatingTool,
  shouldTriggerAutoRecap,
  createRecapState,
  recordTurnEnd,
  takePendingRecap,
  requeuePendingRecap,
  isBusyError,
} from '../lib/trigger.js';

test('MUTATING_TOOLS includes write/edit/pwsh/run_code', () => {
  assert.ok(MUTATING_TOOLS.has('write'));
  assert.ok(MUTATING_TOOLS.has('edit'));
  assert.ok(MUTATING_TOOLS.has('pwsh'));
  assert.ok(MUTATING_TOOLS.has('run_code'));
  assert.ok(!MUTATING_TOOLS.has('read'));
  assert.ok(!MUTATING_TOOLS.has('grep'));
});

test('isMainAgent: origin !== "subagent" => true', () => {
  assert.equal(isMainAgent({ session: { header: { origin: 'startup' } } }), true);
  assert.equal(isMainAgent({ session: { header: {} } }), true);
  assert.equal(isMainAgent({ session: {} }), true);
  assert.equal(isMainAgent(null), true);
});

test('isMainAgent: origin === "subagent" => false', () => {
  assert.equal(isMainAgent({ session: { header: { origin: 'subagent' } } }), false);
});

test('hasNoRunningSubagents: empty list => true', () => {
  assert.equal(hasNoRunningSubagents([], { id: 'a1' }), true);
  assert.equal(hasNoRunningSubagents(undefined, { id: 'a1' }), true);
});

test('hasNoRunningSubagents: only self => true', () => {
  assert.equal(hasNoRunningSubagents([{ id: 'a1' }], { id: 'a1' }), true);
});

test('hasNoRunningSubagents: others present => false', () => {
  assert.equal(hasNoRunningSubagents([{ id: 'a1' }, { id: 'a2' }], { id: 'a1' }), false);
});

test('isMutatingTool', () => {
  assert.equal(isMutatingTool('write'), true);
  assert.equal(isMutatingTool('run_code'), true);
  assert.equal(isMutatingTool('read'), false);
  assert.equal(isMutatingTool(''), false);
  assert.equal(isMutatingTool(null), false);
  assert.equal(isMutatingTool(undefined), false);
});

test('shouldTriggerAutoRecap: autoRecap off => false', () => {
  assert.equal(shouldTriggerAutoRecap({ mutCount: 10, lastRecapTurn: 0, currentTurn: 10 }, { autoRecap: false }), false);
});

test('shouldTriggerAutoRecap: below threshold => false', () => {
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 10 }, { autoRecap: true, autoRecapThreshold: 1 }), false);
});

test('shouldTriggerAutoRecap: within cooldown => false', () => {
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 8, currentTurn: 9 }, { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }), false);
});

test('shouldTriggerAutoRecap: past cooldown + above threshold => true', () => {
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 0, currentTurn: 3 }, { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }), true);
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 5, currentTurn: 7 }, { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }), true);
});

test('shouldTriggerAutoRecap: exactly at cooldown boundary => true', () => {
  assert.equal(shouldTriggerAutoRecap({ mutCount: 3, lastRecapTurn: 0, currentTurn: 2 }, { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }), true);
});

test('shouldTriggerAutoRecap: defaults work', () => {
  // threshold defaults to 1, cooldown defaults to 2
  assert.equal(shouldTriggerAutoRecap({ mutCount: 1, lastRecapTurn: 0, currentTurn: 3 }, { autoRecap: true }), true);
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 3 }, { autoRecap: true }), false);
});
// —— 自动复盘调度用的纯状态机（回合内记账 → 空闲边沿执行）——

test('createRecapState: 初始为空状态', () => {
  const st = createRecapState();
  assert.deepEqual(st, { mutCount: 0, lastRecapTurn: 0, currentTurn: 0, pending: null });
});

test('recordTurnEnd: 未达阈值只记账、不挂待办', () => {
  const st = createRecapState();
  st.mutCount = 0;
  const out = recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 3 } });
  assert.equal(out.trigger, false);
  assert.equal(out.pending, null);
  assert.equal(st.currentTurn, 5);
  assert.equal(st.pending, null);
});

test('recordTurnEnd: 命中条件时挂待办并记下回合号与 mutating 次数', () => {
  const st = createRecapState();
  st.mutCount = 4;
  const out = recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(out.trigger, true);
  assert.deepEqual(out.pending, { turn: 7, mutCount: 4, attempts: 0 });
  assert.equal(st.pending, out.pending);
  assert.equal(st.lastRecapTurn, 7);
  assert.equal(st.mutCount, 0, '计数清零，避免下一回合重复计入同一批');
});

test('recordTurnEnd: 冷却期内不重复触发', () => {
  const st = createRecapState();
  st.mutCount = 4;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  st.mutCount = 4;
  const out = recordTurnEnd(st, { turn: 8, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(out.trigger, false);
  assert.equal(st.pending.turn, 7, '待办仍是上一回合挂的那个');
});

test('takePendingRecap: 取出即出队并记一次尝试', () => {
  const st = createRecapState();
  st.pending = { turn: 3, mutCount: 2, attempts: 0 };
  const p = takePendingRecap(st);
  assert.deepEqual(p, { turn: 3, mutCount: 2, attempts: 1 });
  assert.equal(st.pending, null);
  assert.equal(takePendingRecap(st), null);
});

test('requeuePendingRecap: 未到上限放回队列', () => {
  const st = createRecapState();
  const p = { turn: 3, mutCount: 2, attempts: 1 };
  const out = requeuePendingRecap(st, p, 3);
  assert.equal(out.exhausted, false);
  assert.equal(st.pending, p);
  assert.equal(st.pending.attempts, 1);
});

test('requeuePendingRecap: 达到上限则放弃并清空队列', () => {
  const st = createRecapState();
  const p = { turn: 3, mutCount: 2, attempts: 3 };
  const out = requeuePendingRecap(st, p, 3);
  assert.equal(out.exhausted, true);
  assert.equal(out.pending, null);
  assert.equal(st.pending, null);
});

test('isBusyError: 只认宿主「正忙」的文案', () => {
  assert.equal(isBusyError(new Error('agent "a1" already has active work')), true);
  assert.equal(isBusyError(new Error('LLM 调用失败')), false);
  assert.equal(isBusyError(null), false);
  assert.equal(isBusyError(undefined), false);
});

