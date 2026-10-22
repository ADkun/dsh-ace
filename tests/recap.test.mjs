// dsh-ace 自动复盘调度器（lib/recap.js）的行为测试。
//
// 覆盖的核心事实（DSH checkout：~\@deepseek-ai\dsh-agent-loop\lib\index.js）：
// - :823 runMaintenance 只在 phase.kind === 'idle' 时合法，否则同步抛
//   「agent already has active work」；
// - :939 turn() 断言 phase 是 running，而 agent/turn-stopping 在 turn() 内部派发
//   → 回合内只能记账，不能跑维护任务；
// - :887-901 → :794-799：宿主把 phase 置回 idle 后才 emit agent/status
//   → 空闲边沿才是合法的复盘时机。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecapController } from '../lib/recap.js';

/**
 * 造一个模拟宿主 agent：phase 只能是 'running' 或 'idle'，
 * runMaintenance 在 running 时同步抛「already has active work」（复刻宿主 :823 的守卫）。
 */
function makeAgent({ phase = 'idle', whenIdle } = {}) {
  const agent = {
    id: 'a1',
    session: { header: { origin: 'startup' } },
    phase,
    maintenanceCalls: 0,
    maintenanceTasks: [],
    async runMaintenance(job) {
      if (agent.phase !== 'idle') {
        throw new Error('agent "a1" already has active work');
      }
      agent.maintenanceCalls++;
      const controller = new AbortController();
      agent.maintenanceTasks.push(job);
      return job(controller.signal);
    },
  };
  if (whenIdle) agent.whenIdle = whenIdle;
  return agent;
}

/** 造一个调度器，并把执行次数记下来。 */
function makeController(overrides = {}) {
  const calls = { recap: [], notify: [], logs: [] };
  const controller = createRecapController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0 }),
    listAgents: () => [],
    logger: {
      info: (m) => calls.logs.push(['info', m]),
      warn: (m) => calls.logs.push(['warn', m]),
    },
    notifyFailure: (agent, reason) => calls.notify.push(reason),
    runRecap: async (agent, pending) => { calls.recap.push(pending); },
    ...overrides,
  });
  return { controller, calls };
}

test('回合结束只记账：phase 为 running 时绝不调 runMaintenance', async () => {
  const agent = makeAgent({ phase: 'running' });
  const { controller } = makeController();
  controller.countMutating(agent);
  const out = controller.onTurnStopping({ agent, turn: 3 });
  assert.equal(out.trigger, true, '判定命中触发条件');
  assert.ok(out.pending, '复盘请求挂成待办');
  assert.equal(agent.maintenanceCalls, 0, '回合内不得调 runMaintenance');
  assert.equal(controller.stateFor(agent).pending.mutCount, 1);
  assert.equal(controller.stateFor(agent).pending.turn, 3);
});

test('空闲边沿才真正触发复盘', async () => {
  const agent = makeAgent({ phase: 'running' });
  const { controller, calls } = makeController();
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  assert.equal(calls.recap.length, 0, '回合内不执行');
  agent.phase = 'idle';
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 1, 'idle 边沿执行一次');
  assert.deepEqual(calls.recap[0], { turn: 3, mutCount: 1, attempts: 1 });
});

test('agent/status 不是 idle 时不触发', async () => {
  const agent = makeAgent({ phase: 'running' });
  const { controller, calls } = makeController();
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'running' });
  assert.equal(calls.recap.length, 0);
  assert.ok(controller.stateFor(agent).pending, '待办还在队列里等 idle 边沿');
});

test('没有待办时 idle 边沿不误触发', async () => {
  const agent = makeAgent();
  const { controller, calls } = makeController();
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 0);
  assert.equal(agent.maintenanceCalls, 0);
});

test('没有新回合就不产生待办：idle 边沿不会凭空复盘', async () => {
  const agent = makeAgent();
  const { controller, calls } = makeController();
  // 没有 mutating 调用 → 回合结束也不挂待办。
  const out = controller.onTurnStopping({ agent, turn: 3 });
  assert.equal(out.trigger, false);
  assert.equal(out.pending, null);
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 0);
  assert.equal(agent.maintenanceCalls, 0);
});

test('撞上 already has active work：待办回到队列，不重复刷提示', async () => {
  const agent = makeAgent({ phase: 'running' });
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      throw new Error('agent "a1" already has active work');
    },
  });
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  // idle 边沿到了，但宿主被新一轮拉起 → runMaintenance 抛忙。
  await controller.onStatus({ agent, status: 'idle' });
  const st = controller.stateFor(agent);
  assert.ok(st.pending, '待办回到队列');
  assert.equal(st.pending.turn, 3);
  assert.equal(st.pending.attempts, 1);
  assert.equal(calls.notify.length, 0, '预期内竞态不推用户提示');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('already has active work')), '只写日志');
});

test('竞态退避：重试到上限才放弃，且只提示一次', async () => {
  const agent = makeAgent({ phase: 'running' });
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      throw new Error('agent "a1" already has active work');
    },
  });
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'idle' });   // 第 1 次
  await controller.onStatus({ agent, status: 'idle' });   // 第 2 次
  await controller.onStatus({ agent, status: 'idle' });   // 第 3 次 → 用尽
  assert.equal(calls.recap.length, 3, '最多尝试 3 次');
  assert.equal(controller.stateFor(agent).pending, null, '超过上限放弃待办');
  assert.equal(calls.notify.length, 1, '只给一次提示');
  await controller.onStatus({ agent, status: 'idle' });   // 之后不再触发
  assert.equal(calls.recap.length, 3);
  assert.equal(calls.notify.length, 1);
});

test('待办回队后，下一个 idle 边沿会再试', async () => {
  const agent = makeAgent({ phase: 'running' });
  let fail = true;
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      if (fail) { fail = false; throw new Error('agent "a1" already has active work'); }
    },
  });
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 1);
  assert.ok(controller.stateFor(agent).pending);
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2, '第二个 idle 边沿重试并成功');
  assert.equal(controller.stateFor(agent).pending, null);
  assert.equal(calls.notify.length, 0);
});

test('真实失败（LLM/写盘失败）会给用户推一条提示', async () => {
  const agent = makeAgent();
  const { controller, calls } = makeController({
    runRecap: async () => { throw new Error('LLM 调用失败'); },
  });
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.notify.length, 1);
  assert.ok(calls.notify[0].includes('LLM 调用失败'));
});

test('执行前会等宿主空闲（whenIdle）', async () => {
  let idleWaited = 0;
  const agent = makeAgent({
    phase: 'idle',
    whenIdle: async () => { idleWaited++; },
  });
  const { controller } = makeController();
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(idleWaited, 1);
});

test('子代理与有子代理在跑时不触发', async () => {
  const sub = { id: 'sub', session: { header: { origin: 'subagent' } } };
  const { controller, calls } = makeController();
  controller.countMutating(sub);
  const out = controller.onTurnStopping({ agent: sub, turn: 3 });
  assert.equal(out.trigger, false);
  assert.equal(calls.recap.length, 0);

  const agent = makeAgent();
  const busy = makeController({ listAgents: () => [agent, { id: 'other' }] });
  busy.controller.countMutating(agent);
  const out2 = busy.controller.onTurnStopping({ agent, turn: 3 });
  assert.equal(out2.trigger, false);
});
