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
  assert.deepEqual(calls.recap[0], { turn: 3, mutCount: 1, attempts: 1, prevLastRecapTurn: 0, seq: 1 });
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

test('runRecap 返回 {skipped:true}：额度还回去、不推提示、下一回合立刻能再触发', async () => {
  const agent = makeAgent();
  const { controller, calls } = makeController({
    // 复刻 lib/index.js 空轨迹分支：不调 LLM，只回 {skipped:true}
    runRecap: async (a, pending) => { calls.recap.push(pending); return { skipped: true }; },
  });
  const st = controller.stateFor(agent);
  // 本文件的 makeController 默认 getConfig 就是 autoRecapCooldownTurns: 0 —— 第 35 轮起 0 是
  // 合法值（「不冷却」，见 lib/trigger.js 的 numberOrDefault），所以 turn 5 → turn 6 之间没有冷却
  // 可被白吃；本条用例要钉的是 runRecap 报 skipped 时「冷却回滚到 0 + 计数还回 2」这两笔额度，
  // 而不是冷却本身。
  controller.countMutating(agent);
  controller.countMutating(agent);
  const out = controller.onTurnStopping({ agent, turn: 5 });
  assert.equal(out.trigger, true);
  assert.equal(st.pending.prevLastRecapTurn, 0, '待办里记着挂待办之前的 lastRecapTurn');
  assert.equal(st.mutCount, 0);

  // idle 边沿：runRecap 报「没材料」
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 1, '确实尝试过（并回报 skipped）');
  assert.equal(st.pending, null, '待办已清掉，不回队列');
  assert.equal(st.mutCount, 2, '这一轮的 mutating 计数必须还回来');
  assert.equal(st.lastRecapTurn, 0, '冷却必须回滚到触发之前');
  assert.equal(calls.notify.length, 0, '「没材料」不是失败，不许走 notifyFailure');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'info' && m.includes('没有可复盘的材料') && m.includes('还回')),
    '要写一条 info 说明跳过并已还回额度：' + JSON.stringify(calls.logs));

  // 下一回合：只干 1 次活就该立刻再次触发——冷却没被白吃（若 lastRecapTurn 停在 5，
  // turn 6 只有 6-5=1 < cooldown 2，会被挡下，正是缺陷 2 描述的那个症状）。
  controller.countMutating(agent);
  const out2 = controller.onTurnStopping({ agent, turn: 6 });
  assert.equal(out2.trigger, true, '下一个回合必须能立即再次触发，不被冷却误挡');
  assert.equal(out2.pending.turn, 6);
  assert.equal(out2.pending.mutCount, 3, '还回来的 2 次 + 本回合 1 次，一次都不能吞');
});

test('runRecap 返回非 skipped 的返回值（含 undefined）按「已执行」处理：不回滚', async () => {
  const agent = makeAgent();
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => { calls.recap.push(pending); return { added: [] }; },
  });
  const st = controller.stateFor(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 3 });
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(st.pending, null);
  assert.equal(st.mutCount, 0, '已执行就不还计数');
  assert.equal(st.lastRecapTurn, 3, '已执行就保留冷却推进');
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

test('失败分支只在待办仍归我时才还计数：await 窗口里挂上新待办时 mutCount 保持 0', async () => {
  // 验收者实测的复现：turn5 挂待办 (mutCount=2) → idle 取走 → await runRecap 抛错前的窗口里
  // turn7 结束并挂上新待办 (mutCount=1) → 旧实现把 2 次加回，st.mutCount 变 2（应为 0），
  // 下一轮就会凭虚高的 mutCount 误触发。
  const agent = makeAgent();
  let st = null;
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      // 抛错之前的窗口：宿主跑完了下一轮并挂上新待办
      controller.countMutating(a);
      controller.onTurnStopping({ agent: a, turn: 7 });
      throw new Error('LLM 调用失败');
    },
  });
  st = controller.stateFor(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });
  assert.equal(st.pending.mutCount, 2);

  await controller.onStatus({ agent, status: 'idle' });

  assert.equal(st.mutCount, 0, '旧回合的 2 次额度不许重复计入状态（新待办已接管记账）');
  // F1：旧待办的 2 次额度不许蒸发，也不许重复计入状态——它被**过继**进队列里那份新待办（1+2=3）。
  // 真实失败这一路只过继计数、不过继冷却（失败＝确实尝试过，冷却算已消耗），所以其余字段一字未改。
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 },
    'F1：旧回合的 2 次计数过继进新待办（1+2=3），其余字段一字未改');
  assert.equal(st.lastRecapTurn, 7, '冷却仍是新回合的 7');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('自动复盘失败')),
    '真实失败仍要写一条 warn');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('更新的待办')),
    '还要说明为什么没把旧额度还回去');
  assert.equal(calls.notify.length, 1, '失败仍要推一条提示');
  assert.ok(calls.notify[0].includes('LLM 调用失败'));
});

test('两个空闲边沿交错：迟到的 skipped 回滚被拒但额度不蒸发，冷却不回退、不谎报已还回', async () => {
  // 验收者实测的复现：边沿 A 取走 p5 → turn7 挂 p7 → 边沿 B 取走 p7（state.pending 又变 null）
  // → 边沿 A 的 skipped 回滚迟到。只比对象身份的旧护栏会把这次回滚当「仍归我」接受，
  // 结果 mutCount 变 3（期望 1）、lastRecapTurn 从 7 倒退到 0，info 还谎报「回合 5 已还回」。
  const agent = makeAgent();
  const deferred = [];
  const { controller, calls } = makeController({
    runRecap: (a, pending) => new Promise((resolve) => {
      calls.recap.push(pending);
      deferred.push(resolve);
    }),
  });
  const st = controller.stateFor(agent);

  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });          // p5, mutCount=2
  const edgeA = controller.onStatus({ agent, status: 'idle' }); // 边沿 A 取走 p5
  assert.equal(deferred.length, 1);

  // await 窗口里：turn7 结束挂 p7，p7 又被边沿 B 取走
  controller.countMutating(agent);                        // +1
  controller.onTurnStopping({ agent, turn: 7 });          // p7, mutCount=1
  assert.equal(st.pending.seq, 2);
  const edgeB = controller.onStatus({ agent, status: 'idle' }); // 边沿 B 取走 p7
  assert.equal(deferred.length, 2);
  assert.equal(st.pending, null, '前置条件：新待办已被取走，队列空');

  // 边沿 B 报「没材料」：它自己那一代仍归它，回滚照常生效（mutCount 还回 1，冷却回到 5）
  deferred[1]({ skipped: true });
  await edgeB;
  assert.equal(st.mutCount, 1);
  assert.equal(st.lastRecapTurn, 5);
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'info' && m.includes('回合 7')),
    '边沿 B 的回滚是合法的，要写 info');

  // 边沿 A 的 skipped 回滚迟到：回滚本身必须被拒（返回 false、不写「已还回」的 info），
  // 但 F1 修法之后它的 2 次额度**不许蒸发**：队列已空（p7 已被边沿 B 取走并结算过），
  // 于是过继回状态本身，mutCount 1 → 3。
  // 注意 lastRecapTurn 仍是 5 而不是 0：冷却由那份在飞待办自己的结算去回滚，这里再倒退一次就是退两遍。
  const logsBefore = calls.logs.length;
  deferred[0]({ skipped: true });
  await edgeA;
  assert.equal(st.mutCount, 3, 'F1：旧回合的 2 次额度还回状态（1+2=3），不许蒸发也不许重复计入');
  assert.equal(st.lastRecapTurn, 5, '冷却不许倒退（这里不动 lastRecapTurn，交给在飞待办自己结算）');
  const newLogs = calls.logs.slice(logsBefore);
  assert.ok(!newLogs.some(([lvl, m]) => lvl === 'info' && m.includes('回合 5')),
    '不许谎报「回合 5 … 已还回额度」：' + JSON.stringify(newLogs));
  assert.ok(newLogs.some(([lvl, m]) => lvl === 'warn' && m.includes('已被另一个空闲边沿取走')),
    '要写 warn 说明是「新待办已被另一个空闲边沿取走」导致没回滚：' + JSON.stringify(newLogs));
});

test('撞忙回队时窗口里已挂上更新的待办：不许覆盖队列，也不许谎报「已放回队列」', async () => {
  // 端到端复现缺陷 1：turn5 挂 p5 → idle 边沿取走 → runRecap 里宿主跑完 turn7 挂上 p7 后抛忙。
  // 旧实现无条件把 p5 塞回队列，p7 被静默丢弃，日志还写「待办已放回队列（第 1 次）」。
  const agent = makeAgent();
  let mounted = false;
  const { controller, calls } = makeController({
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      if (!mounted) {
        mounted = true;
        controller.countMutating(a);
        controller.onTurnStopping({ agent: a, turn: 7 }); // 窗口里挂上更新的待办
        throw new Error('agent "a1" already has active work');
      }
    },
  });
  const st = controller.stateFor(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });
  assert.equal(st.pending.mutCount, 2);

  await controller.onStatus({ agent, status: 'idle' });

  // F1：队列里那份更新的待办必须留着，而且接住旧待办那 2 次额度（1+2=3），不许跟着蒸发。
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 },
    '队列里必须是那份更新的待办，且已过继旧待办的 2 次计数（1+2=3）');
  assert.equal(st.pendingSeq, 2, '代次不许倒退');
  assert.equal(st.mutCount, 0, '计数不许被旧待办改写');
  assert.equal(st.lastRecapTurn, 7, '冷却仍是新回合的 7');
  assert.equal(calls.notify.length, 0, '撞忙仍是预期内竞态，不推用户提示');
  const warns = calls.logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
  assert.ok(warns.some((m) => m.includes('旧待办未放回队列')), '要写 warn 说明为什么没放回：' + JSON.stringify(warns));
  assert.ok(!warns.some((m) => m.includes('待办已放回队列')), '不许谎报已放回队列：' + JSON.stringify(warns));

  // 下一个空闲边沿：轮到队列里那份更新的待办
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2);
  assert.equal(calls.recap[1].turn, 7, '第二个空闲边沿必须执行 turn7 那一份');
  assert.equal(calls.recap[1].mutCount, 3, 'F1：第二份待办执行时带着过继来的 3 次计数（1+2）');
  assert.equal(st.pending, null);
});

test('撞忙重试到上限时窗口里挂上更新的待办：耗尽也不许抹掉队列里那份', async () => {
  // 端到端复现缺陷 2：maxAttempts=1 让第一轮就撞上限，此时窗口里已有 p7。
  const agent = makeAgent();
  let mounted = false;
  const { controller, calls } = makeController({
    maxAttempts: 1,
    runRecap: async (a, pending) => {
      calls.recap.push(pending);
      if (!mounted) {
        mounted = true;
        controller.countMutating(a);
        controller.onTurnStopping({ agent: a, turn: 7 });
      }
      throw new Error('agent "a1" already has active work');
    },
  });
  const st = controller.stateFor(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });

  await controller.onStatus({ agent, status: 'idle' });

  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 },
    '耗尽分支也不许抹掉队列里那份更新的待办（且 F1 过继旧待办的 2 次计数）');
  assert.equal(calls.notify.length, 1, '上限用尽仍要给一次提示');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('队列里那份更新的待办仍在')),
    '要说明队列里那份还在等下一个空闲边沿：' + JSON.stringify(calls.logs));

  // 之后那个空闲边沿照常执行 p7
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2);
  assert.equal(calls.recap[1].turn, 7);
  assert.equal(st.pending, null);
});

test('子代理自己不记账；有其它 agent 在跑也照常记账触发', async () => {
  // 保留的门：子代理不记账（isMainAgent）
  const sub = { id: 'sub', session: { header: { origin: 'subagent' } } };
  const { controller, calls } = makeController();
  controller.countMutating(sub);
  const out = controller.onTurnStopping({ agent: sub, turn: 3 });
  assert.equal(out.trigger, false);
  assert.equal(calls.recap.length, 0);

  // 拆掉的门：ctx.agents 里还有别的 agent（真实用法里几乎每轮都有在跑的子代理）
  // 不再拦记账。即使把 listAgents 递进来，调度器也不该再看它一眼。
  const agent = makeAgent();
  const busy = makeController({ listAgents: () => [agent, { id: 'other' }] });
  busy.controller.countMutating(agent);
  const out2 = busy.controller.onTurnStopping({ agent, turn: 3 });
  assert.equal(out2.trigger, true, '有其它 agent 在跑也必须记账触发');
  assert.equal(busy.controller.stateFor(agent).pending.mutCount, 1);
});

// —— 缺陷 D1 端到端：队列里那份没执行的待办撞上新一轮触发时必须合并，不许覆盖 ——
// 现场：回合 5 干 3 次活挂待办 → 空闲边沿撞忙把待办放回队列（attempts=1）→ 回合 6 冷却未到
// （6-5=1 < 默认 cooldown 2）只记账 2 次 → 回合 7 触发。旧实现在最后一步直接覆盖，回合 5 的 3 次
// 经验永久丢失且日志里一个字都没提。

test('端到端：撞忙回队后冷却期内又记账，下一轮触发要把两笔合成一份待办（D1）', async () => {
  const agent = makeAgent({ phase: 'running' });
  let busy = true;
  const { controller, calls } = makeController({
    // 这里显式配 cooldown 2（= 默认值），所以 5 → 6 被挡（6-5=1 < 2）、5 → 7 放行（7-5=2 ≥ 2），
    // 正是 D1 缺陷现场。注意：第 35 轮起显式配 0 就真的不冷却了，本条刻意不用 0。
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }),
    runRecap: async (a, pending) => {
      calls.recap.push({ ...pending });
      if (busy) { busy = false; throw new Error('agent "a1" already has active work'); }
    },
  });
  const st = controller.stateFor(agent);

  // 回合 5：3 次 mutating，挂待办
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });
  assert.equal(st.pending.mutCount, 3);

  // 空闲边沿撞忙 → 放回队列
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(st.pending.turn, 5, '待办回到队列');
  assert.equal(st.pending.attempts, 1, '这次尝试已经用掉');

  // 回合 6：冷却未到，只记账 2 次
  controller.countMutating(agent);
  controller.countMutating(agent);
  assert.equal(controller.onTurnStopping({ agent, turn: 6 }).trigger, false, '冷却未到不触发');
  assert.equal(st.pending.turn, 5, '那份待办还在队列里等着');

  // 回合 7：触发 → 合并，不是覆盖
  const out7 = controller.onTurnStopping({ agent, turn: 7 });
  assert.equal(out7.trigger, true);
  assert.equal(st.pending.mutCount, 5, '回合 5 的 3 次 + 回合 6 的 2 次 = 5，一次都不许丢');
  assert.equal(st.pending.attempts, 0, '新待办是新的一笔，尝试次数从 0 计');
  assert.equal(st.pending.prevLastRecapTurn, 0, '冷却要还回到最老那一笔的原值');
  assert.equal(st.pending.seq, 2);
  // 覆盖合并必须留痕，否则事后看不出回合 5 的经验去哪了
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'info'
    && m.includes('回合 5') && m.includes('已合并进回合 7') && m.includes('5 次 mutating')),
    '要有一条 info 说明回合 5 被并进回合 7：' + JSON.stringify(calls.logs));
  assert.equal(calls.notify.length, 0, '合并本身不是失败，不该推用户提示');

  // 下一个空闲边沿真正执行的是合并后的那一份
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2);
  assert.equal(calls.recap[1].turn, 7);
  assert.equal(calls.recap[1].mutCount, 5, '执行时带着合并后的 5 次');
  assert.equal(st.pending, null);
});

test('端到端：合并后的待办被放弃时，冷却回到最老那一笔的原值、额度不白吃（D1）', async () => {
  const agent = makeAgent({ phase: 'running' });
  let busy = true;
  const { controller, calls } = makeController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }),
    runRecap: async (a, pending) => {
      calls.recap.push({ ...pending });
      if (busy) { busy = false; throw new Error('agent "a1" already has active work'); }
      return { skipped: true };   // 之后每次都没材料 → 走 abandon 回滚
    },
  });
  const st = controller.stateFor(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });
  await controller.onStatus({ agent, status: 'idle' });   // 撞忙放回
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 6 });          // 冷却未到
  controller.onTurnStopping({ agent, turn: 7 });          // 合并
  assert.equal(st.lastRecapTurn, 7);
  assert.equal(st.pending.mutCount, 5);

  await controller.onStatus({ agent, status: 'idle' });   // 执行 → skipped → 回滚
  assert.equal(st.pending, null);
  assert.equal(st.mutCount, 5, '合并的 5 次一起还回来');
  assert.equal(st.lastRecapTurn, 0, '冷却还回最老那一笔的原值 0，不是 5');
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'info' && m.includes('没有可复盘的材料')), '要写跳过日志：' + JSON.stringify(calls.logs));

  // 冷却没被白吃：回合 5 立刻就能再触发（5-0 ≥ 2）。若 lastRecapTurn 还回到旧待办那一轮 5，
  // 这里 5-5=0 < 2 会被挡掉，那几回合的活就白干了。
  controller.countMutating(agent);
  assert.equal(controller.onTurnStopping({ agent, turn: 5 }).trigger, true, '冷却还回原值后立刻够用');
  // 还回来的 5 次额度与这次新记的 1 次一起进新待办（还回去就是还没复盘，仍要算账）
  assert.equal(st.pending.mutCount, 6);
});

// —— 缺陷 F1：在飞的旧待办额度永久蒸发（端到端，真实调度器）——
// 时序：回合 5 干 3 次挂 p5 → 空闲边沿 takePendingRecap 摘走 p5（st.pending=null），停在
// await whenIdle / await runRecap 的窗口里 → 窗口内回合 6 只记账、回合 7 触发挂 p7{mutCount:2} →
// p5 的 runRecap 返回 {skipped:true}（或抛忙）→ 回滚被代次判定拒。
// 改动前 p5 的 3 次计数既没进 p7、也没还回 st.mutCount，永久蒸发。
// 注意边界（别夸大也别缩小）：p7 的轨迹取自 deriveMessages() 尾部最近 60 条，回合 5 的**材料**
// 通常仍会被 p7 那次复盘看到；蒸发的是「额度记账」，以及 busy 变体下「这一轮确实没跑成」这件事。

test('F1 端到端（skipped 变体）：在飞的 p5 跳过时，3 次额度必须过继给队列里那份 p7', async () => {
  const agent = makeAgent({ phase: 'running' });
  const deferred = [];
  const { controller, calls } = makeController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }),
    runRecap: (a, pending) => {
      calls.recap.push({ ...pending });
      // 只有第一次调用是「在飞」的：挂住不返回，制造窗口给 recordTurnEnd 插进来。
      // 之后那次（执行过继后的 p7）立刻返回，否则测试会自己把自己吊死。
      if (calls.recap.length > 1) return Promise.resolve();
      return new Promise((resolve) => { deferred.push(resolve); });
    },
  });
  const st = controller.stateFor(agent);

  // 回合 5：干 3 次活 → 挂 p5{mutCount:3, prevLastRecapTurn:0, seq:1}
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });
  assert.equal(st.pending.mutCount, 3);

  // 空闲边沿 A 把 p5 摘走，进入在飞窗口
  const edgeA = controller.onStatus({ agent, status: 'idle' });
  assert.equal(deferred.length, 1, '边沿 A 已经在跑 runRecap');
  assert.equal(st.pending, null, '前置条件：p5 在飞，队列空');

  // 窗口里：回合 6 冷却未到只记账，回合 7 触发挂 p7
  controller.countMutating(agent);
  assert.equal(controller.onTurnStopping({ agent, turn: 6 }).trigger, false, '冷却未到，只记账');
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 7 });
  const p7 = st.pending;
  assert.equal(p7.seq, 2);
  assert.equal(p7.mutCount, 2, '前置条件：p7 只看到窗口里的 2 次，看不到在飞的 p5');

  // p5 报「没材料」：回滚被拒（不谎报已还回），但 3 次额度过继给 p7
  deferred[0]({ skipped: true });
  await edgeA;
  assert.equal(st.pending, p7, '队列里仍是 p7（对象身份不变）');
  assert.equal(st.pending.mutCount, 5, 'F1：3 次过继进 p7（2+3=5）');
  assert.equal(st.pending.prevLastRecapTurn, 0, 'F1：跳过这一路把冷却基准退到更早那次推进之前（0 比 5 早）');
  assert.equal(st.mutCount, 0, '过继给队列里那份，就不许同时再还回状态');
  assert.equal(st.lastRecapTurn, 7, '当前状态的冷却基准不许被旧待办改写');
  assert.ok(!calls.logs.some(([lvl, m]) => lvl === 'info' && m.includes('回合 5') && m.includes('还回状态')),
    '不许谎报「回合 5 … 已还回额度」：' + JSON.stringify(calls.logs));
  assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('过继给回合 7')),
    '要有一条 warn 说清额度过继去了哪：' + JSON.stringify(calls.logs));

  // 下一个空闲边沿真正执行 p7 那一份，带着 5 次
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2);
  assert.equal(calls.recap[1].turn, 7);
  assert.equal(calls.recap[1].mutCount, 5, '执行时带着过继来的 5 次，一次不多一次不少');
  assert.equal(st.pending, null);
});

test('F1 端到端（busy 变体）：在飞的 p5 撞忙被拒时，3 次额度过继给 p7、且不静默', async () => {
  const agent = makeAgent({ phase: 'running' });
  let first = true;
  const { controller, calls } = makeController({
    getConfig: () => ({ autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 }),
    runRecap: async (a, pending) => {
      calls.recap.push({ ...pending });
      if (first) {
        first = false;
        // 在飞窗口里：宿主跑完了回合 6（只记账）与回合 7（触发挂 p7）
        controller.countMutating(a);
        controller.onTurnStopping({ agent: a, turn: 6 });
        controller.countMutating(a);
        controller.onTurnStopping({ agent: a, turn: 7 });
        throw new Error('agent "a1" already has active work');
      }
    },
  });
  const st = controller.stateFor(agent);

  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.countMutating(agent);
  controller.onTurnStopping({ agent, turn: 5 });

  await controller.onStatus({ agent, status: 'idle' });

  // busy 变体下这一轮复盘**确实没跑成**，而且连队列都挤不进去 —— 必须留一条 warn 说清这件事
  const warns = calls.logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m);
  assert.ok(warns.some((m) => m.includes('这一轮没跑成')),
    'F1：busy 变体被拒时不许静默，要写明这一轮没跑成：' + JSON.stringify(warns));
  assert.ok(warns.some((m) => m.includes('过继给回合 7')),
    '还要有一条 warn 说清 3 次额度去了哪：' + JSON.stringify(warns));
  assert.ok(!warns.some((m) => m.includes('待办已放回队列')),
    '不许谎报已放回队列：' + JSON.stringify(warns));
  assert.equal(st.pending.mutCount, 5, 'F1：队列里那份 p7 接住 3 次过继（2+3=5）');
  assert.equal(st.pending.turn, 7);
  assert.equal(st.mutCount, 0, '过继给队列里那份，就不许同时再还回状态');
  assert.equal(calls.notify.length, 0, '撞忙仍是预期内竞态，不推用户提示');

  // 下一个空闲边沿执行 p7，带着 5 次
  await controller.onStatus({ agent, status: 'idle' });
  assert.equal(calls.recap.length, 2);
  assert.equal(calls.recap[1].turn, 7);
  assert.equal(calls.recap[1].mutCount, 5, '执行时带着过继来的 5 次');
});


