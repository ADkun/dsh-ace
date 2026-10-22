import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MUTATING_TOOLS, isMainAgent, hasNoRunningSubagents, isMutatingTool, shouldTriggerAutoRecap } from '../lib/trigger.js';

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
