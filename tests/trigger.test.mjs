import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MUTATING_TOOLS,
  isMainAgent,
  isMutatingTool,
  shouldTriggerAutoRecap,
  createRecapState,
  recordTurnEnd,
  takePendingRecap,
  requeuePendingRecap,
  abandonPendingRecap,
  restorePendingMutCount,
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

// —— 第 35 轮：设置页文案承诺的「0」必须真的生效 ——
// 文案（client.js:63 / client.js:65）：threshold「0 表示每次都触发」、cooldown「0 表示不冷却」。
// 旧实现 Number(x) || 默认值 会把显式 0 兜成默认值，与文案不符；现在只有缺失 / 非有限数才回落。

test('shouldTriggerAutoRecap: cooldown 显式配 0 = 不冷却（lastRecapTurn === currentTurn 也触发）', () => {
  const config = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0 };
  // 最严的一档：上一回合就是本回合（差 0）。0 真的表示「不冷却」时必须放行。
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 10, currentTurn: 10 }, config), true,
    'cooldown=0 表示不冷却，差 0 轮也要触发');
  // 验收者实测的那一档（旧实现 10-9=1 < 2 被挡下）
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 }, config), true);
  // 表单输入框给的是字符串，'0' 同样是显式的 0
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 },
    { ...config, autoRecapCooldownTurns: '0' }), true, "字符串 '0' 也算显式 0");
});

test('shouldTriggerAutoRecap: threshold 显式配 0 = 每次都触发（mutCount 0 也触发）', () => {
  const config = { autoRecap: true, autoRecapThreshold: 0, autoRecapCooldownTurns: 2 };
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 10 }, config), true,
    'threshold=0 表示每次都触发，一次都没动手也要触发');
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 10 },
    { ...config, autoRecapThreshold: '0' }), true, "字符串 '0' 也算显式 0");
});

test('shouldTriggerAutoRecap: 配置里没有这两个键 → 仍按默认 2 / 1（钉住「缺失才回落」）', () => {
  // 只有 autoRecap 一个键：threshold 缺 → 默认 1、cooldown 缺 → 默认 2
  assert.equal(shouldTriggerAutoRecap({ mutCount: 1, lastRecapTurn: 0, currentTurn: 3 }, { autoRecap: true }), true);
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 3 }, { autoRecap: true }), false,
    'threshold 缺省仍是 1：一次都没动手不触发');
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 }, { autoRecap: true }), false,
    'cooldown 缺省仍是 2：差 1 轮被挡下');
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 8, currentTurn: 10 }, { autoRecap: true }), true,
    'cooldown 缺省仍是 2：差 2 轮放行');
  // 显式 undefined 与「键不存在」同义
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 },
    { autoRecap: true, autoRecapCooldownTurns: undefined }), false, 'undefined 按缺失处理');
  assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 10 },
    { autoRecap: true, autoRecapThreshold: undefined }), false, 'undefined 按缺失处理');
});

test('shouldTriggerAutoRecap: null / 空串 / 空白串按「没配」回落默认值（契约）', () => {
  // 取舍（见 lib/trigger.js 的 numberOrDefault 注释）：Number(null) 与 Number('') 都是 0，
  // 若照收就会把「输入框被清空 / 配置留了个空值」读成「用户要求最激进配置」，
  // 所以 null / 空串 / 纯空白一律按「没配」回落默认 2 / 1；要 0 就显式写 0。
  for (const empty of [null, '', '   ', '\t']) {
    assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 },
      { autoRecap: true, autoRecapCooldownTurns: empty }), false,
      'cooldown=' + JSON.stringify(empty) + ' 必须回落到默认 2（差 1 轮被挡）');
    assert.equal(shouldTriggerAutoRecap({ mutCount: 0, lastRecapTurn: 0, currentTurn: 10 },
      { autoRecap: true, autoRecapThreshold: empty }), false,
      'threshold=' + JSON.stringify(empty) + ' 必须回落到默认 1（一次都没动手不触发）');
  }
  // 非有限数同样回落（NaN / Infinity），不许被当成 0
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 },
    { autoRecap: true, autoRecapCooldownTurns: NaN }), false, 'NaN 按缺失处理');
  assert.equal(shouldTriggerAutoRecap({ mutCount: 5, lastRecapTurn: 9, currentTurn: 10 },
    { autoRecap: true, autoRecapCooldownTurns: Infinity }), false, 'Infinity 不是有限数 → 回落默认 2（差 1 轮被挡）');
});

test('recordTurnEnd: cooldown 显式配 0 → 同一回合号再记一次也照样挂待办', () => {
  const st = createRecapState();
  st.mutCount = 2;
  const first = recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0 } });
  assert.equal(first.trigger, true);
  assert.equal(st.lastRecapTurn, 7);
  // 旧实现把 cooldown 0 兜成 2，这里 7-7=0 < 2 会被挡下（不挂待办）
  st.pending = null;          // 模拟待办已被空闲边沿取走
  st.mutCount = 1;
  const second = recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 0 } });
  assert.equal(second.trigger, true, 'cooldown=0 表示不冷却，同一回合号也要触发');
  assert.equal(second.pending.turn, 7);
  assert.equal(second.pending.prevLastRecapTurn, 7, '记下改之前的 lastRecapTurn');
  assert.equal(st.pendingSeq, 2, '第二份待办是第 2 代');
});

test('recordTurnEnd: threshold 显式配 0 → 本回合一次都没动手也挂待办', () => {
  const st = createRecapState();
  // mutCount 保持 0：旧实现 threshold 兜成 1，0 < 1 直接不触发
  const out = recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 0, autoRecapCooldownTurns: 2 } });
  assert.equal(out.trigger, true, 'threshold=0 表示每次都触发');
  assert.equal(out.pending.mutCount, 0, '待办照挂，计数就是 0');
  assert.equal(out.pending.turn, 5);
  assert.equal(st.lastRecapTurn, 5, '冷却照样推进');
});
// —— 自动复盘调度用的纯状态机（回合内记账 → 空闲边沿执行）——

test('createRecapState: 初始为空状态', () => {
  const st = createRecapState();
  // pendingSeq 是待办代次（0 表示还没挂过任何待办），所有权判定靠它。
  // 第 33 轮：lastOutcome（C2 三档信号）随回合成败判定一起删除，状态形状定死这五个字段。
  assert.deepEqual(st, { mutCount: 0, lastRecapTurn: 0, currentTurn: 0, pending: null, pendingSeq: 0 });
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
  // prevLastRecapTurn 记的是**改之前**的 lastRecapTurn（这里初始 0），供「没材料跳过」时回滚。
  // seq 是待办代次：第一份待办是第 1 代，回滚时靠它判断「这份待办是否仍归我」。
  assert.deepEqual(out.pending, { turn: 7, mutCount: 4, attempts: 0, prevLastRecapTurn: 0, seq: 1 });
  assert.equal(st.pendingSeq, 1, '挂待办时代次 +1 并记进状态');
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

test('recordTurnEnd: prevLastRecapTurn 记录改之前的回合号（不是本回合）', () => {
  const st = createRecapState();
  st.lastRecapTurn = 5;
  st.mutCount = 2;
  const out = recordTurnEnd(st, { turn: 9, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(out.trigger, true);
  assert.equal(st.pending.prevLastRecapTurn, 5, '必须是赋值前读到的旧值');
  assert.equal(st.lastRecapTurn, 9, '状态里已推进到本回合');
});

test('takePendingRecap: 取出即出队并记一次尝试', () => {
  const st = createRecapState();
  st.pending = { turn: 3, mutCount: 2, attempts: 0, prevLastRecapTurn: 1 };
  const p = takePendingRecap(st);
  assert.deepEqual(p, { turn: 3, mutCount: 2, attempts: 1, prevLastRecapTurn: 1 });
  assert.equal(st.pending, null);
  assert.equal(takePendingRecap(st), null);
});

test('abandonPendingRecap: 清空待办，并把 mutating 计数与 lastRecapTurn 还回去', () => {
  const st = createRecapState();
  st.lastRecapTurn = 5;
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 9, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(st.mutCount, 0, '挂待办时清零');
  assert.equal(st.lastRecapTurn, 9, '挂待办时推进');
  const pending = takePendingRecap(st);
  assert.equal(st.pending, null);

  assert.equal(abandonPendingRecap(st, pending), true);
  assert.equal(st.pending, null, '待办必须清掉（不回队列，这是「放弃」不是「重试」）');
  assert.equal(st.mutCount, 3, '这一轮的 mutating 计数要还回来');
  assert.equal(st.lastRecapTurn, 5, '冷却要回滚到挂待办之前');
  // 还回来之后，下一回合应当立刻可以再次触发（不被冷却误挡）。
  // 注意：若 lastRecapTurn 停在 9，下一回合 turn 10 只有 10-9=1 < cooldown 2，会被挡下。
  const next = recordTurnEnd(st, { turn: 10, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(next.trigger, true, '回滚后不该再被冷却挡住');
  assert.equal(next.pending.turn, 10);
  assert.equal(next.pending.mutCount, 3, '还回来的 3 次一次都不能吞');
});

test('abandonPendingRecap: 畸形输入不抛错', () => {
  assert.doesNotThrow(() => abandonPendingRecap(null, { turn: 1, mutCount: 2 }));
  assert.doesNotThrow(() => abandonPendingRecap(undefined, undefined));
  assert.doesNotThrow(() => abandonPendingRecap(createRecapState(), null));
  assert.doesNotThrow(() => abandonPendingRecap(createRecapState(), 'not an object'));
  assert.equal(abandonPendingRecap(null, { mutCount: 2 }), false);
  assert.equal(abandonPendingRecap(createRecapState(), null), false);

  // 非有限数按 0：mutCount 加 0，lastRecapTurn 归 0
  // 装配体对齐：被放弃的待办就是队列里的那一份（同一对象），否则按所有权规则会被拒绝回滚
  // （新规则：state.pending 已换成别的对象 = 有更新的待办，一律不碰）。断言本身一字未改。
  const st = createRecapState();
  st.mutCount = 7;
  st.lastRecapTurn = 4;
  const malformed = { turn: 9, mutCount: Number.NaN, prevLastRecapTurn: 'x' };
  st.pending = malformed;
  abandonPendingRecap(st, malformed);
  assert.equal(st.mutCount, 7, '非有限数按 0 累加');
  assert.equal(st.lastRecapTurn, 0, '非有限数按 0');
  assert.equal(st.pending, null);

  // mutCount 缺失时 state 里的计数不被 NaN 污染
  const st2 = createRecapState();
  st2.mutCount = 2;
  abandonPendingRecap(st2, { turn: 3 });
  assert.equal(st2.mutCount, 2);
  assert.equal(st2.lastRecapTurn, 0);
});

test('abandonPendingRecap: await 窗口内挂上新待办时，旧 pending 回滚不吞新待办、不破坏计数', () => {
  // 真实时序（lib/recap.js:117-133）：takePendingRecap 之后隔着 await agent.whenIdle() 与
  // await runRecap()。这段窗口里宿主完全可能又跑完一回合并挂上**新的**待办。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  assert.equal(st.lastRecapTurn, 5);
  const oldPending = takePendingRecap(st);
  assert.equal(st.mutCount, 0);

  // 窗口内：turn7 结束，记 1 次 mutating，挂上新待办
  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const fresh = st.pending;
  assert.equal(fresh.turn, 7);
  assert.equal(st.lastRecapTurn, 7);

  // 现在拿**旧**的 pending 来放弃：必须整份拒绝（返回 false），新待办本身不许被吞掉。
  // F1 修法之后：旧待办的 2 次计数**过继**给队列里那份 p7（1+2=3），不再蒸发；
  // 冷却基准也一并过继并取两者中**更早**的：p5.prevLastRecapTurn=0、p7.prevLastRecapTurn=5 → 0。
  // 理由同 recordTurnEnd 不变量 2——回合 5 与回合 7 两次推进都没执行，放弃时应还回到最早那次推进之前（0）。
  // 这是本轮刻意改掉的期望值（mutCount 1→3、prevLastRecapTurn 5→0）：改动前这两笔都被静默丢弃。
  const warn = [];
  assert.equal(abandonPendingRecap(st, oldPending, { warn: (m) => warn.push(m) }), false, '有更新的待办时必须拒绝回滚');
  assert.equal(st.pending, fresh, '新待办不许被吞掉（对象身份不变）');
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 0, seq: 2 }, 'F1：旧待办的 2 次计数与冷却基准都过继进新待办（1+2=3，冷却退到回合 0）');
  assert.equal(st.mutCount, 0, '过继给的是队列里那份，不许同时再还回状态（否则同一批计数算两遍）');
  assert.equal(st.lastRecapTurn, 7, '冷却不许从 7 倒退');

  // 被拒绝时必须留下一条可查的 warn，说明为什么没回滚
  assert.equal(warn.length, 1);
  assert.ok(warn[0].includes('更新的待办'), 'warn 要说明是「有更新的待办」导致没回滚');
});

test('abandonPendingRecap: 同一份待办重复放弃只生效一次（幂等）', () => {
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const pending = takePendingRecap(st);

  assert.equal(abandonPendingRecap(st, pending), true);
  assert.equal(st.mutCount, 2);
  assert.equal(st.lastRecapTurn, 0);

  // 第二次：计数不许再累加、冷却不许再改，且要能区分出「这次没生效」
  assert.equal(abandonPendingRecap(st, pending), false, '重复放弃必须返回 false');
  assert.equal(st.mutCount, 2, '第二次不许把 2 次计数再加一遍变成 4');
  assert.equal(st.lastRecapTurn, 0, '第二次不许再动冷却');
  assert.equal(st.pending, null);
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

test('abandonPendingRecap: 新待办已被另一个空闲边沿取走时，迟到的回滚也必须被拒（代次判定）', () => {
  // 真实时序：两个空闲边沿交错。边沿 A 取走 p5 后在 await 窗口里等 runRecap；
  // 这段窗口里 turn7 结束挂上 p7，p7 又被**边沿 B** 取走（state.pending 于是又变回 null）。
  // 此时只比对象身份的旧护栏（state.pending && state.pending !== pending）判不出来，
  // 会把 A 迟到的回滚当成「仍归我」接受：旧回合的额度被重复计入，冷却还会从 7 倒退。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p5 = takePendingRecap(st);
  assert.equal(st.mutCount, 0);
  assert.equal(st.lastRecapTurn, 5);

  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p7 = takePendingRecap(st); // 边沿 B 取走 p7
  assert.equal(p7.turn, 7);
  assert.equal(st.pending, null, '前置条件：新待办已被取走，队列里空空如也');

  // 情形一：p7 自己的结果还没回来，此刻 mutCount=0、lastRecapTurn=7。
  // F1 修法：队列已空（更新的那份被边沿 B 取走），旧待办的 2 次计数**还回状态**而不是作废；
  // 但 lastRecapTurn 不动——冷却由那份在飞待办 p7 自己的结算去回滚，这里再倒退一次就是退两遍。
  const warn = [];
  assert.equal(abandonPendingRecap(st, p5, { warn: (m) => warn.push(m) }), false, '新待办已被取走时也必须拒绝回滚');
  assert.equal(st.mutCount, 2, 'F1：旧待办的 2 次额度还回状态（队列已空，没有别处可以过继）');
  assert.equal(st.lastRecapTurn, 7, '冷却不许从 7 倒退到 0');
  assert.equal(st.pending, null);
  assert.equal(warn.length, 1);
  assert.ok(warn[0].includes('已被另一个空闲边沿取走'), 'warn 要说清是「新待办已被取走」导致没回滚：' + warn[0]);

  // 情形二：p7 走的是「真实失败」分支，把它的 1 次计数还回来了（mutCount 2+1=3、冷却仍是 7）。
  // 这时 p5 的迟到回滚仍必须被拒，而且**不许再过继一次**（幂等）：期望停在 3，而不是 3+2=5。
  assert.equal(restorePendingMutCount(st, p7), true);
  assert.equal(st.mutCount, 3);
  assert.equal(st.lastRecapTurn, 7);
  const warn2 = [];
  assert.equal(abandonPendingRecap(st, p5, { warn: (m) => warn2.push(m) }), false, '迟到的旧待办回滚一律拒绝');
  assert.equal(st.mutCount, 3, '同一份旧待办只过继一次：第二次被拒不许再把 2 次加一遍（否则 3→5）');
  assert.equal(st.lastRecapTurn, 7, '冷却仍是 turn7');
  assert.ok(warn2[0].includes('过继过一次'), 'F1 幂等：warn 要说明这份待办已经过继过一次了：' + warn2[0]);
});

test('restorePendingMutCount: 单待办正常路径只还计数、不回滚冷却', () => {
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const pending = takePendingRecap(st);
  assert.equal(st.mutCount, 0);

  const warn = [];
  assert.equal(restorePendingMutCount(st, pending, { warn: (m) => warn.push(m) }), true);
  assert.equal(st.mutCount, 2, '这一轮的 mutating 计数要还回来（下一轮还有机会再判定）');
  assert.equal(st.lastRecapTurn, 5, '失败说明确实尝试过：冷却算已消耗，不许回滚');
  assert.equal(st.pending, null);
  assert.equal(warn.length, 0, '正常路径不写 warn');

  // 畸形输入不抛错、返回 false
  assert.equal(restorePendingMutCount(null, { turn: 1 }), false);
  assert.equal(restorePendingMutCount(createRecapState(), null), false);
  assert.equal(restorePendingMutCount(createRecapState(), 'not an object'), false);
});

test('restorePendingMutCount: await 窗口内挂上新待办时不碰队列、额度过继进新待办，并写一条 warn', () => {
  // 复刻验收者实测：turn5 挂待办 (mutCount=2) → idle 取走 → await runRecap 抛错前的窗口里
  // turn7 结束并挂上新待办 (mutCount=1) → 失败分支把 2 次加回，st.mutCount 变 2（应为 0）。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const oldPending = takePendingRecap(st);
  assert.equal(st.mutCount, 0);

  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const fresh = st.pending;
  assert.equal(st.lastRecapTurn, 7);

  const warn = [];
  assert.equal(restorePendingMutCount(st, oldPending, { warn: (m) => warn.push(m) }), false, '有更新的待办时必须拒绝还计数');
  assert.equal(st.mutCount, 0, '旧回合的 2 次额度不许重复计入到状态（过继给的是队列里那份）');
  assert.equal(st.pending, fresh, '新待办不许被吞掉');
  // F1：真实失败这一路只过继**计数**，不过继冷却（失败＝确实尝试过，冷却算已消耗，刻意语义），
  // 所以 prevLastRecapTurn 仍是 5、lastRecapTurn 仍是 7，只有 mutCount 1→3。
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 }, 'F1：旧待办的 2 次计数过继进新待办（1+2=3）');
  assert.equal(st.lastRecapTurn, 7, '冷却不许倒退');
  assert.equal(warn.length, 1);
  assert.ok(warn[0].includes('更新的待办'), 'warn 要说明是「有更新的待办」导致没还计数：' + warn[0]);
});

test('requeue 之后再 take 拿到同一份待办，再放弃仍生效（seq 不变，不误拒）', () => {
  // 忙碌重试路径：requeuePendingRecap 把**同一个对象**放回队列，代次不变，
  // 下一次 take 拿到的还是它，所有权判定必须仍然认它。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p = takePendingRecap(st);
  assert.equal(p.attempts, 1);
  assert.equal(p.seq, 1);

  const out = requeuePendingRecap(st, p, 3);
  assert.equal(out.exhausted, false);
  assert.equal(st.pending, p, '放回的是同一份待办（身份不变）');
  assert.equal(p.seq, 1, 'requeue 不许改代次');
  assert.equal(st.pendingSeq, 1, 'requeue 不许改状态里的代次');

  const again = takePendingRecap(st);
  assert.equal(again, p, '再次 take 拿到的必须是同一份');
  assert.equal(again.attempts, 2);
  assert.equal(abandonPendingRecap(st, again), true, '同一份待办（同一代次）放弃必须仍然生效');
  assert.equal(st.mutCount, 2, '额度要真还回去');
  assert.equal(st.lastRecapTurn, 0, '冷却回滚到挂待办之前');
  assert.equal(st.pending, null);
});

test('requeuePendingRecap: await 窗口里已挂上更新的待办时，队列一个字段都不动、额度过继进新待办并明确拒绝', () => {
  // 验收者实测的复现：turn5 挂 p5 → 空闲边沿取走 → 窗口里 turn7 结束挂上 p7 → 忙碌分支把 p5 放回队列。
  // 旧实现无条件 st.pending = pending，p7 被静默丢弃：p5 之后无论走 abandon 还是 restore 都被
  // 所有权判定判「不归我」而拒绝，p5 的 2 次与 p7 的 1 次额度一起蒸发，而 lastRecapTurn 已经
  // 推进到 7（冷却白吃），日志却只写「待办已放回队列（第 1 次）」。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p5 = takePendingRecap(st);

  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p7 = st.pending;
  assert.equal(p7.seq, 2);

  const warn = [];
  const out = requeuePendingRecap(st, p5, 3, { warn: (m) => warn.push(m) });
  assert.equal(out.rejected, true, '必须明确拒绝，不许静默');
  assert.equal(out.exhausted, false, 'p5 只尝试过 1 次，没到上限');
  assert.equal(out.pending, null, '拒绝时不返回待办：队列里那份不是它的');
  assert.equal(st.pending, p7, '队列里那份更新的待办不许被覆盖（对象身份不变）');
  // F1：旧待办没能回队，但它的 2 次计数**过继**进队列里那份（1+2=3）——改动前它在这里蒸发。
  // 其余字段一字未改（冷却不过继：回队这一路既没放弃也没回滚，冷却归属交给队列里那份自己结算）。
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 }, 'F1：旧待办的 2 次计数过继进新待办（1+2=3），其余字段一字未改');
  assert.equal(st.pendingSeq, 2, '代次不许倒退');
  assert.equal(st.lastRecapTurn, 7, '冷却不许倒退');
  assert.equal(st.mutCount, 0, '计数不许被旧待办改写');
  assert.equal(warn.length, 1, '被拒绝时必须留一条可查的 warn');
  assert.ok(warn[0].includes('更新的待办'), 'warn 要说明是「有更新的待办」导致没放回：' + warn[0]);
});

test('requeuePendingRecap: 耗尽分支也只清自己那一份，队列里更新的待办必须留着', () => {
  // 旧实现的耗尽分支 if (st) st.pending = null 同样是无条件的：p5 试满 3 次时会把窗口里
  // 新挂上的 p7 抹掉，p7 那一轮的计数与冷却一起白吃。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p5 = takePendingRecap(st);
  p5.attempts = 3; // 这份旧待办已经试满

  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p7 = st.pending;

  const warn = [];
  const out = requeuePendingRecap(st, p5, 3, { warn: (m) => warn.push(m) });
  assert.equal(out.exhausted, true, '它自己的尝试次数确实用尽了');
  assert.equal(out.rejected, true, '同时也要标记成「不归我」');
  assert.equal(out.pending, null);
  assert.equal(st.pending, p7, '耗尽也不许抹掉队列里那份更新的待办');
  // F1：耗尽的是 p5 自己的尝试次数，它的 2 次计数仍要过继进 p7（1+2=3），不许跟着一起作废。
  assert.deepEqual(st.pending, { turn: 7, mutCount: 3, attempts: 0, prevLastRecapTurn: 5, seq: 2 });
  assert.equal(st.mutCount, 0);
  assert.equal(st.lastRecapTurn, 7);
  assert.equal(warn.length, 1);
});

test('restorePendingMutCount: 同一份待办重复还计数只生效一次（幂等）', () => {
  // 契约弱点：同一份待办连调三次曾返回 true/true/true，mutCount 3→6→9，凭空多出经验额度。
  // 线上 onStatus 同一份待办只会进一条分支一次，但作为 API 契约与 abandonPendingRecap 不对称。
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p = takePendingRecap(st);
  assert.equal(st.mutCount, 0);

  assert.equal(restorePendingMutCount(st, p), true);
  assert.equal(st.mutCount, 3);
  const warn = [];
  assert.equal(restorePendingMutCount(st, p, { warn: (m) => warn.push(m) }), false, '第二次必须返回 false');
  assert.equal(restorePendingMutCount(st, p, { warn: (m) => warn.push(m) }), false, '第三次同理');
  assert.equal(st.mutCount, 3, '不许变成 6 / 9');
  assert.equal(st.lastRecapTurn, 5, '失败分支不回滚冷却（刻意语义不变）');
  assert.equal(st.pending, null);
  assert.equal(warn.length, 2, '每次被拒各写一条 warn');
  assert.ok(warn[0].includes('结算过'), 'warn 要说明「这份待办已经结算过了」：' + warn[0]);
});

test('两条回滚路径共用同一本已结算账本：交叉调用一律被拒', () => {
  // 先 abandon 再 restore 曾各加一次（3→6）；反过来先 restore 再 abandon 同样会各加一次。
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p = takePendingRecap(st);
  assert.equal(abandonPendingRecap(st, p), true);
  assert.equal(st.mutCount, 3);
  assert.equal(st.lastRecapTurn, 0);
  const warn = [];
  assert.equal(restorePendingMutCount(st, p, { warn: (m) => warn.push(m) }), false, '已结算过，失败分支不许再加一次');
  assert.equal(st.mutCount, 3, '不许变成 6');
  assert.equal(st.lastRecapTurn, 0, '也不许借失败分支改冷却');
  assert.ok(warn[0].includes('结算过'), 'warn 要说明已经结算过：' + warn[0]);

  const st2 = createRecapState();
  st2.mutCount = 3;
  recordTurnEnd(st2, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p2 = takePendingRecap(st2);
  assert.equal(restorePendingMutCount(st2, p2), true);
  assert.equal(st2.mutCount, 3);
  assert.equal(st2.lastRecapTurn, 5);
  const warn2 = [];
  assert.equal(abandonPendingRecap(st2, p2, { warn: (m) => warn2.push(m) }), false, '已结算过，放弃不许再还一遍');
  assert.equal(st2.mutCount, 3, '不许变成 6');
  assert.equal(st2.lastRecapTurn, 5, '冷却不许被放弃路径回滚');
  assert.ok(warn2[0].includes('结算过'), 'warn 要说明已经结算过：' + warn2[0]);
});

test('requeuePendingRecap 不是结算：放回后同一份待办仍能走 restorePendingMutCount', () => {
  // 若把 requeue 也记进已结算账本，重试路径的下一次失败回滚会被误拒，额度同样蒸发。
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 } });
  const p = takePendingRecap(st);
  const out = requeuePendingRecap(st, p, 3);
  assert.equal(out.exhausted, false);
  const again = takePendingRecap(st);
  assert.equal(again, p, '放回的是同一份待办');
  assert.equal(restorePendingMutCount(st, again), true, '放回不是结算，失败分支必须仍能还计数');
  assert.equal(st.mutCount, 2, '额度要真还回去');
  assert.equal(st.lastRecapTurn, 5, '失败分支不回滚冷却');
});

test('ownsPending 旧形状兜底：pendingSeq 已前进过，无 seq 的旧待办一律不认', () => {
  // 生产路径 recordTurnEnd 必写 seq，这一档只由手工构造命中；但旧兜底
  // !(st.pending && st.pending !== pending) 在「队列已空 + 代次已前进」时仍会放行，
  // 让迟到的旧回滚把旧回合计数还回来（实测 0→2）并把 lastRecapTurn 倒退。
  const st = createRecapState();
  st.pendingSeq = 5;   // 代次前进过：之后一定挂过更新的待办
  st.mutCount = 0;
  st.lastRecapTurn = 7;
  st.pending = null;   // 那份新待办已被另一个空闲边沿取走
  const warn = [];
  assert.equal(abandonPendingRecap(st, { turn: 1, mutCount: 2, attempts: 1, prevLastRecapTurn: 0 },
    { warn: (m) => warn.push(m) }), false, '代次已前进，无 seq 的旧待办不许被认领');
  assert.equal(st.mutCount, 0, '不许把 2 次额度还回来');
  assert.equal(st.lastRecapTurn, 7, '冷却不许倒退');
  assert.equal(st.pending, null);
  assert.equal(warn.length, 1);

  assert.equal(restorePendingMutCount(st, { turn: 1, mutCount: 2, attempts: 1 }), false, '失败分支同理');
  assert.equal(st.mutCount, 0);

  // 队列里还压着新待办时同样不认
  const st2 = createRecapState();
  st2.pendingSeq = 2;
  st2.pending = { turn: 7, mutCount: 1, attempts: 0, prevLastRecapTurn: 5, seq: 2 };
  assert.equal(abandonPendingRecap(st2, { turn: 1, mutCount: 2, attempts: 1 }), false);
  assert.equal(st2.mutCount, 0);
  assert.equal(st2.lastRecapTurn, 0);

  // 全新状态（pendingSeq === 0）仍要放行手工构造的旧形状：既有用例走的就是这一档
  const st3 = createRecapState();
  st3.mutCount = 2;
  assert.equal(abandonPendingRecap(st3, { turn: 3 }), true);
  assert.equal(st3.mutCount, 2);
});

test('isBusyError: 只认宿主「正忙」的文案', () => {
  assert.equal(isBusyError(new Error('agent "a1" already has active work')), true);
  assert.equal(isBusyError(new Error('LLM 调用失败')), false);
  assert.equal(isBusyError(null), false);
  assert.equal(isBusyError(undefined), false);
});

// —— 缺陷 D1：recordTurnEnd 曾无条件覆盖队列里还没执行的待办，整轮经验静默丢失 ——
// 现场时序（生产默认 cooldown=2）：回合 5 干 3 次挂 p5 → 空闲边沿撞忙把 p5 放回队列（attempts=1）
// → 回合 6 冷却未到（6-5=1<2）只记账 2 次 → 回合 7 触发。旧实现在这一步直接 st.pending = 新对象，
// p5 连同那 3 次调用一起蒸发，日志里一个字都没提。

test('recordTurnEnd: 队列里还压着没执行的待办时合并计数，不许丢经验（D1）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  // 回合 5：干 3 次活，挂待办
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);          // 空闲边沿取走
  requeuePendingRecap(st, p5, 3);           // 撞忙 → 放回队列（attempts 已 +1）
  assert.equal(st.pending, p5, '放回的是同一份待办');
  assert.equal(p5.attempts, 1, '它已经被尝试过 1 次');

  // 回合 6：冷却未到（6-5=1 < 2），只记账 2 次，p5 仍留在队列里
  st.mutCount = 2;
  const out6 = recordTurnEnd(st, { turn: 6, config: cfg });
  assert.equal(out6.trigger, false, '冷却未到不触发');
  assert.equal(st.pending, p5, 'p5 还在队列里等着');

  // 回合 7：触发 —— 这里曾经是「覆盖」，现在是「合并」
  const out7 = recordTurnEnd(st, { turn: 7, config: cfg });
  assert.equal(out7.trigger, true);
  assert.notEqual(st.pending, p5, '队列里换成新一代待办');
  // 不变量 1：旧待办 3 次 + 本回合 2 次 = 5 次，两笔都进，谁都不覆盖谁。
  assert.equal(st.pending.mutCount, 5, '合并后必须是 3+2=5，不许只剩本回合的 2');
  assert.equal(out7.mutCount, 5, '返回值里的 mutCount 也要是合并后的数');
  // 不变量 3：新待办是新的一笔，旧待办被撞忙浪费的那次尝试不继承。
  assert.equal(st.pending.attempts, 0, 'attempts 从 0 重新计');
  // 不变量 2：prevLastRecapTurn 取旧待办的（= 最老那一笔的原值 0），不是旧待办那一轮 5。
  assert.equal(st.pending.prevLastRecapTurn, 0, '冷却要还回到最老那一笔的原值');
  assert.equal(st.pending.seq, 2, '代次 +1，旧待办从此不归任何人');
  assert.equal(st.lastRecapTurn, 7);
  assert.equal(st.mutCount, 0, '合并后计数清零，避免重复计入');
});

test('recordTurnEnd: 合并后回滚把 lastRecapTurn 还回最老那一笔的原值（D1）', () => {
  // 推导：lastRecapTurn 每次挂待办就推进一次，含义是「冷却从哪一回合起算」。回合 5 与回合 7 的活
  // 合成一笔且都没执行，一旦这笔被放弃，两次推进都不该发生 —— 必须还回到最早那次推进之前的值。
  // 若还回到旧待办那一轮（5），回合 5→7 之间的冷却额度就被白吃了（那几回合什么都没复盘）。
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.lastRecapTurn = 3;            // 更早的账：最老那一笔的原值是 3
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  requeuePendingRecap(st, p5, 3);
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });
  const merged = takePendingRecap(st);

  assert.equal(merged.prevLastRecapTurn, 3, '合并后记的是最老那一笔的原值');
  assert.equal(st.lastRecapTurn, 7, '当前冷却起点是回合 7');
  assert.equal(abandonPendingRecap(st, merged), true);
  assert.equal(st.lastRecapTurn, 3, '放弃后必须还回 3，不是 5（旧待办那一轮）');
  assert.equal(st.mutCount, 5, '合并的 5 次一起还回去');

  // 还回去之后冷却不被白吃：回合 5 立刻就能再触发（5-3=2 已达 cooldown）
  st.mutCount = 1;
  assert.equal(recordTurnEnd(st, { turn: 5, config: cfg }).trigger, true, '还回原值后冷却立刻够用');
});

test('recordTurnEnd: 覆盖合并要留痕——一条 info 写明旧待办被并进新待办（D1）', () => {
  // 旧实现连日志都没有，事后完全看不出某回合的经验去哪了。
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  requeuePendingRecap(st, p5, 3);
  st.mutCount = 2;

  const infos = [];
  recordTurnEnd(st, { turn: 7, config: cfg, logger: { info: (m) => infos.push(m), warn: () => {} } });
  assert.equal(infos.length, 1, '合并必须留一条日志');
  assert.ok(infos[0].includes('回合 5'), '日志要点名被并掉的是回合 5：' + infos[0]);
  assert.ok(infos[0].includes('回合 7'), '也要点名并进了回合 7：' + infos[0]);
  assert.ok(infos[0].includes('还没执行'), '要说明那份待办还没执行过：' + infos[0]);
  assert.ok(infos[0].includes('5 次 mutating'), '要写出累计次数：' + infos[0]);
});

test('recordTurnEnd: 不传 logger 也不炸（既有调用点兼容）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  requeuePendingRecap(st, p5, 3);
  st.mutCount = 2;
  // 不传 logger、传 null、传没有 info 的 logger：三种都不许抛。
  assert.equal(recordTurnEnd(st, { turn: 7, config: cfg }).trigger, true);
  assert.equal(st.pending.mutCount, 5);
  const st2 = createRecapState();
  st2.mutCount = 1;
  recordTurnEnd(st2, { turn: 5, config: cfg });
  const q2 = takePendingRecap(st2);
  requeuePendingRecap(st2, q2, 3);
  st2.mutCount = 1;
  assert.equal(recordTurnEnd(st2, { turn: 7, config: cfg, logger: null }).trigger, true);
  assert.equal(recordTurnEnd(st2, { turn: 9, config: cfg, logger: {} }).trigger, false, '冷却未到，不触发');
});

test('覆盖合并之后，迟到的 abandon/restore/requeue 作用在旧待办上一律被拒且一个字段都不动（D1）', () => {
  // 旧待办的 seq 已被新待办顶替，ownsPending 天然会拒 —— 但这条必须钉住，
  // 否则合并一旦漏改代次，旧待办就能把「已经并进新待办的那 3 次」再还一遍，额度凭空翻倍。
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  requeuePendingRecap(st, p5, 3);
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });
  const p7 = st.pending;

  const snap = () => JSON.stringify({
    mutCount: st.mutCount, lastRecapTurn: st.lastRecapTurn,
    currentTurn: st.currentTurn, pendingSeq: st.pendingSeq,
    pending: st.pending && { ...st.pending },
  });
  const before = snap();
  const warn = [];
  const logger = { warn: (m) => warn.push(m), info: () => {} };

  assert.equal(abandonPendingRecap(st, p5, logger), false, '迟到的放弃必须被拒');
  assert.equal(snap(), before, '放弃被拒后 st 一个字段都不许动');
  assert.equal(restorePendingMutCount(st, p5, logger), false, '迟到的失败回滚必须被拒');
  assert.equal(snap(), before, '回滚被拒后 st 一个字段都不许动');
  const rq = requeuePendingRecap(st, p5, 3, logger);
  assert.equal(rq.rejected, true, '迟到的回队必须标记 rejected');
  assert.equal(rq.pending, null, '拒绝时不返回任何待办');
  assert.equal(snap(), before, '回队被拒后 st 一个字段都不许动');
  assert.equal(st.pending, p7, '队列里仍是合并后的那份');
  assert.equal(warn.length, 3, '三条被拒各留一条可查的 warn');
  assert.ok(warn.every((m) => m.includes('更新的待办')), 'warn 都要说明是「有更新的待办」：' + warn.join(' | '));
});

// —— 缺陷 F1：在飞的旧待办额度永久蒸发 ——
// 现场时序：回合 5 干 3 次挂 p5 → 空闲边沿 takePendingRecap 把 p5 摘走（st.pending=null），停在
// await whenIdle / await runRecap 的窗口里 → 窗口内回合 6、7 结束并干 2 次活，recordTurnEnd 看不到
// 在飞的 p5，挂出 p7{mutCount:2, seq:2} → p5 的 runRecap 返回 {skipped:true} 或抛忙，回滚被代次判定拒。
// 改动前：p5 的 3 次计数既没进 p7、也没还回 st.mutCount，永久蒸发。修法＝过继（见 adoptOrphanPending）。

test('F1：在飞的旧待办被拒时，额度过继给队列里那份更新的待办（不蒸发、不翻倍）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });      // p5{mutCount:3, prevLastRecapTurn:0, seq:1}
  const p5 = takePendingRecap(st);                  // 空闲边沿摘走 → st.pending = null
  assert.equal(st.pending, null, '前置条件：p5 在飞，队列空');

  // 窗口里：回合 6 只记账（6-5=1，冷却未到），回合 7 再记一次并触发挂 p7
  st.mutCount = 1;
  assert.equal(recordTurnEnd(st, { turn: 6, config: cfg }).trigger, false, '冷却未到，只记账不挂待办');
  assert.equal(st.pending, null);
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });
  const p7 = st.pending;
  assert.equal(p7.seq, 2);
  assert.equal(p7.mutCount, 2, '前置条件：p7 只记了窗口里的 2 次，看不到在飞的 p5');

  const warn = [];
  assert.equal(abandonPendingRecap(st, p5, { warn: (m) => warn.push(m) }), false,
    '跳过回滚作用在旧待办上仍必须返回 false（它确实不归当前一代）');
  assert.equal(st.pending, p7, '队列里那份仍是 p7（对象身份不变）');
  assert.equal(st.pending.mutCount, 5, 'F1：3 次过继进 p7（2+3=5），一次不多一次不少');
  assert.equal(st.pending.prevLastRecapTurn, 0, 'F1：放弃这一路把冷却基准退到更早那次推进之前（0 比 5 早）');
  assert.equal(st.mutCount, 0, '过继给队列里那份，就不许同时再还回状态（否则同一批计数算两遍）');
  assert.equal(st.lastRecapTurn, 7, '当前状态的冷却基准不许被旧待办改写');
  assert.equal(warn.length, 1, '过继必须留痕');
  assert.ok(warn[0].includes('更新的待办'), 'warn 要说明是「有更新的待办」：' + warn[0]);
  assert.ok(warn[0].includes('过继给回合 7'), 'warn 要点名过继目标：' + warn[0]);
});

test('F1：队列已被另一个空闲边沿取空时，旧待办额度还回状态、但冷却不回退', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });
  const p7 = takePendingRecap(st);                  // 另一个空闲边沿把 p7 也取走了
  assert.equal(st.pending, null, '前置条件：队列空空如也');
  assert.equal(st.lastRecapTurn, 7);

  const warn = [];
  assert.equal(restorePendingMutCount(st, p5, { warn: (m) => warn.push(m) }), false,
    '失败回滚作用在旧待办上仍返回 false');
  assert.equal(st.mutCount, 3, 'F1：3 次还回状态本身（没有别处可以过继）');
  assert.equal(st.lastRecapTurn, 7, 'F1 刻意取舍：冷却不回退，交给那份在飞待办自己结算（否则退两遍）');
  assert.equal(st.pending, null);
  assert.ok(warn[0].includes('已被另一个空闲边沿取走'), 'warn 要说清队列为什么是空的：' + warn[0]);
  assert.ok(warn[0].includes('冷却不回退'), 'warn 要写明这个取舍：' + warn[0]);

  // p7 自己那份照常结算，与 p5 的过继互不干扰：3 + 2 = 5
  assert.equal(restorePendingMutCount(st, p7), true);
  assert.equal(st.mutCount, 5, '两笔各算一次：p5 的 3 次 + p7 的 2 次');
});

test('F1：同一份旧待办被三条路径连拒，只过继一次（幂等，额度不翻倍）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });
  assert.equal(st.pending.mutCount, 2);

  const warn = [];
  const logger = { warn: (m) => warn.push(m), info: () => {} };
  assert.equal(abandonPendingRecap(st, p5, logger), false);
  assert.equal(st.pending.mutCount, 5, '第一次过继：2+3=5');
  assert.equal(restorePendingMutCount(st, p5, logger), false, '第二次仍必须被拒');
  assert.equal(st.pending.mutCount, 5, '第二次不许再过继（否则 5+3=8）');
  const rq = requeuePendingRecap(st, p5, 3, logger);
  assert.equal(rq.rejected, true, '第三次仍必须被拒');
  assert.equal(st.pending.mutCount, 5, '第三次同样不许再过继');
  assert.equal(st.mutCount, 0, '全程都没把额度还回状态');
  assert.equal(warn.length, 3, '三次被拒各留一条 warn');
  assert.ok(warn[1].includes('过继过一次'), '后两次要说明「已经过继过一次」：' + warn[1]);
  assert.ok(warn[2].includes('过继过一次'), '后两次要说明「已经过继过一次」：' + warn[2]);
});

test('F1：已被 recordTurnEnd 合并吸收的旧待办不许再过继（否则额度翻倍）', () => {
  // 第 6 轮的合并路径：p5 被并进 p7 之后，p5 的 3 次计数**已经**在 p7.mutCount 里。
  // 这时迟到的三条路径都必须仍然一个字段都不动，且 warn 要点明「已经合并进更新的待办」。
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 3;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  requeuePendingRecap(st, p5, 3);                   // 撞忙放回队列（还没结算）
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 7, config: cfg });      // 合并：p7.mutCount = 3+2 = 5
  assert.equal(st.pending.mutCount, 5, '前置条件：合并已经把那 3 次并进来了');

  const snap = () => JSON.stringify({
    mutCount: st.mutCount, lastRecapTurn: st.lastRecapTurn,
    currentTurn: st.currentTurn, pendingSeq: st.pendingSeq,
    pending: st.pending && { ...st.pending },
  });
  const before = snap();
  const warn = [];
  const logger = { warn: (m) => warn.push(m), info: () => {} };
  assert.equal(abandonPendingRecap(st, p5, logger), false);
  assert.equal(restorePendingMutCount(st, p5, logger), false);
  assert.equal(requeuePendingRecap(st, p5, 3, logger).rejected, true);
  assert.equal(snap(), before, '已被吸收的旧待办：三条路径都不许动任何字段');
  assert.equal(st.pending.mutCount, 5, '不许变成 8：那 3 次已经在 p7 里了');
  assert.ok(warn.every((m) => m.includes('已经合并进更新的待办')), 'warn 要说明是「已经合并」而不是「过继」：' + warn.join(' | '));
});

// —— 硬化 H1：负数 / 垃圾 mutCount 不许进入累计 ——

test('H1：合并时负数与垃圾 mutCount 一律按 0 处理，日志里不许出现负累计', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);
  p5.mutCount = -3;                                  // 畸形：负数（生产路径铸不出来，但 API 契约上要挡住）
  requeuePendingRecap(st, p5, 3);
  st.mutCount = 2;
  const infos = [];
  recordTurnEnd(st, { turn: 7, config: cfg, logger: { info: (m) => infos.push(m) } });
  assert.equal(st.pending.mutCount, 2, '负数按 0：合并结果必须是 2，不是 -1');
  assert.ok(infos[0].includes('2 次 mutating'), '日志写的是钳过的值：' + infos[0]);
  assert.ok(!/累计 -/.test(infos[0]), '日志里不许出现「累计 -3」这种负累计：' + infos[0]);

  // 垃圾值同样按 0
  const st2 = createRecapState();
  st2.mutCount = 1;
  recordTurnEnd(st2, { turn: 5, config: cfg });
  const q = takePendingRecap(st2);
  q.mutCount = '不是数字';
  requeuePendingRecap(st2, q, 3);
  st2.mutCount = 1;
  recordTurnEnd(st2, { turn: 7, config: cfg });
  assert.equal(st2.pending.mutCount, 1, '垃圾值按 0：合并结果必须是 1');

  // 负数过继也要钳住
  const st3 = createRecapState();
  st3.mutCount = 3;
  recordTurnEnd(st3, { turn: 5, config: cfg });
  const orphan = takePendingRecap(st3);
  orphan.mutCount = -5;
  st3.mutCount = 2;
  recordTurnEnd(st3, { turn: 7, config: cfg });
  assert.equal(abandonPendingRecap(st3, orphan), false);
  assert.equal(st3.pending.mutCount, 2, '过继负数按 0：p7 仍是 2，不许被拽成负数');
});

// —— 硬化 H2：logger 形状畸形时不许抛（这些日志全在竞态回滚路径上）——

test('H2：logger 各种畸形形状都不抛（info/warn 不是函数、非对象、getter 抛错）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };
  const badLoggers = [
    undefined, null, 0, 5, '', 'logger', true,
    {}, { info: 5 }, { warn: 5 }, { info: 5, warn: 5 },
    { info: null, warn: null }, { info: 'x', warn: 'y' },
    { get info() { throw new Error('boom'); } },   // getter 抛错：可选链也挡不住，但这里连碰都不该碰
  ];
  for (const logger of badLoggers) {
    // 1) recordTurnEnd 的合并留痕（lib/trigger.js 头注「为什么不能继续用 logger?.info?.(…)」讲的就是这里）
    const st = createRecapState();
    st.mutCount = 2;
    recordTurnEnd(st, { turn: 5, config: cfg, logger });
    const p5 = takePendingRecap(st);
    requeuePendingRecap(st, p5, 3, logger);
    st.mutCount = 1;
    assert.doesNotThrow(() => recordTurnEnd(st, { turn: 7, config: cfg, logger }),
      'recordTurnEnd 遇到畸形 logger 不许抛：' + String(logger));

    // 2) 三条被拒路径的 warn（过继留痕）同样不许抛
    const st2 = createRecapState();
    st2.mutCount = 1;
    recordTurnEnd(st2, { turn: 5, config: cfg });
    const orphan = takePendingRecap(st2);
    st2.mutCount = 1;
    recordTurnEnd(st2, { turn: 7, config: cfg });
    assert.doesNotThrow(() => abandonPendingRecap(st2, orphan, logger), 'abandon 不许抛');
    assert.doesNotThrow(() => restorePendingMutCount(st2, orphan, logger), 'restore 不许抛');
    assert.doesNotThrow(() => requeuePendingRecap(st2, orphan, 3, logger), 'requeue 不许抛');

    // 3) 已结算账本命中时的 warn
    const st3 = createRecapState();
    st3.mutCount = 1;
    recordTurnEnd(st3, { turn: 5, config: cfg });
    const done = takePendingRecap(st3);
    assert.equal(abandonPendingRecap(st3, done, logger), true);
    assert.doesNotThrow(() => abandonPendingRecap(st3, done, logger), '重复放弃的 warn 不许抛');
    assert.doesNotThrow(() => restorePendingMutCount(st3, done, logger), '交叉结算的 warn 不许抛');
  }
});

// —— 硬化 H3：过继必须「先搬移、后记账」——
//
// 为什么这条必须有：ADOPTED_PENDINGS 记的是「这份待办已经过继过」。改动前它写在搬移**之前**，
// 于是搬移那一步一旦抛错（队列里那份待办被冻结、或 mutCount 是 getter-only），就会留下
// 「账本说搬过了、额度一次都没搬」的状态：该待办从此被永久封账，那笔 mutating 额度永久蒸发，
// 而且没有任何日志说它去了哪里。所以账本只在搬移**成功**之后才写。

test('H3：过继搬移抛错时额度不蒸发、账本也没封（冻结 / 只读 getter 两种构造）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };

  // 场景 A：队列里那份待办被 Object.freeze（赋值在严格模式下抛 TypeError）
  const st = createRecapState();
  st.mutCount = 2;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p5 = takePendingRecap(st);                    // seq=1, mutCount=2
  st.mutCount = 1;
  recordTurnEnd(st, { turn: 7, config: cfg });        // 队列里 p7: seq=2, mutCount=1
  const frozen = st.pending;
  Object.freeze(frozen);

  assert.throws(() => restorePendingMutCount(st, p5, { warn: () => {} }), TypeError,
    '搬移阶段确实抛错了——这个用例才有意义');
  assert.equal(st.pending, frozen, '抛错后队列里那份原样留着');
  assert.equal(st.pending.mutCount, 1, '抛错时额度一次都没搬走（也没蒸发：它还在这份待办身上）');

  // 换一份可写的同值待办（等价于「下一次路径 / 重试」），额度必须还能搬过去：
  // 若账本在抛错前就记了「已过继」，这里会被判「过继过一次」而拒绝，那 2 次额度就此永久蒸发。
  st.pending = { turn: 7, mutCount: 1, attempts: 0, prevLastRecapTurn: 5, seq: 2 };
  const warn = [];
  assert.equal(restorePendingMutCount(st, p5, { warn: (m) => warn.push(m) }), false, '旧待办仍不归我');
  assert.equal(st.pending.mutCount, 3, '额度不蒸发：重试时 1+2=3 照常搬过去');
  assert.equal(warn.length, 1, '第一次真的过继成功，才留一条 warn');
  assert.ok(!warn[0].includes('过继过一次'), '这条 warn 不该是「过继过一次」：' + warn[0]);

  // 场景 B：队列里那份的 mutCount 是 getter-only（没有 setter，严格模式赋值同样抛错）
  const st2 = createRecapState();
  st2.mutCount = 4;
  recordTurnEnd(st2, { turn: 5, config: cfg });
  const orphan = takePendingRecap(st2);               // seq=1, mutCount=4
  st2.pendingSeq = 2;
  st2.pending = { turn: 7, attempts: 0, prevLastRecapTurn: 5, seq: 2, get mutCount() { return 1; } };

  assert.throws(() => requeuePendingRecap(st2, orphan, 3, { warn: () => {} }), TypeError,
    'getter-only 的 mutCount 赋值同样抛错');
  st2.pending = { turn: 7, mutCount: 1, attempts: 0, prevLastRecapTurn: 5, seq: 2 };
  const out = requeuePendingRecap(st2, orphan, 3, { warn: () => {} });
  assert.equal(out.rejected, true);
  assert.equal(st2.pending.mutCount, 5, '账本没被封：4 次额度仍能过继（1+4=5）');
  assert.equal(st2.mutCount, 0, '过继进队列里那份，不许还回状态');
});

// —— 硬化 H4：结算时的夹取口径必须与 recordTurnEnd / adoptOrphanPending 一致 ——
//
// 改动前两处结算段写的是 Number(...) 当夹取：它只挡 NaN/Infinity，**负数有限值原样收下**，
// 于是 pending.mutCount = -4 会把 st.mutCount 从 10 拽回 6——一次「回滚」反而吃掉 4 次额度。

test('H4：负数 mutCount 不许把 st.mutCount 往回拽（失败回滚与跳过回滚两路同口径）', () => {
  const cfg = { autoRecap: true, autoRecapThreshold: 1, autoRecapCooldownTurns: 2 };

  // 失败回滚：只还计数、不回滚冷却
  const st = createRecapState();
  st.mutCount = 10;
  recordTurnEnd(st, { turn: 5, config: cfg });
  const p = takePendingRecap(st);
  st.mutCount = 10;                                   // 状态里另有 10 次额度
  p.mutCount = -4;                                    // 这份待办的计数被写坏成负数
  assert.equal(restorePendingMutCount(st, p), true);
  assert.equal(st.mutCount, 10, '负数按 0 夹住：10 + 0 = 10（改动前会被拽成 6）');

  // 跳过回滚：还计数且回滚冷却
  const st2 = createRecapState();
  st2.mutCount = 10;
  recordTurnEnd(st2, { turn: 5, config: cfg });
  const p2 = takePendingRecap(st2);
  st2.mutCount = 10;
  p2.mutCount = -4;
  assert.equal(abandonPendingRecap(st2, p2), true);
  assert.equal(st2.mutCount, 10, '同上：不许把 10 拽成 6');
  assert.equal(st2.lastRecapTurn, 0, '冷却照旧回滚（这一条不受夹取口径影响）');
});