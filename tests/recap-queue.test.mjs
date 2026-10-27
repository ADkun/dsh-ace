// 第 39 轮：复盘串行队列（lib/recap-queue.js）的专项自证。
//
// 覆盖用户拍板的三条硬要求（m00117）：
//   1. 任一时刻全局只允许一份复盘在跑（最大并发恒为 1）；
//   2. 排队期间新回合的复盘并进已在排队的那一份，而不是排成一长串；
//   3. 队列上限之外的请求丢弃最旧的一项（不无限堆积）。
// 另外覆盖：总时限只「放弃等待」、不 abort 上游；放弃/失败都通知调用方。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecapQueue, RECAP_TOTAL_DEADLINE_MS, MAX_QUEUED_RECAPS } from '../lib/recap-queue.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('第39轮 队列｜常量取值落在用户批准的区间内', () => {
  assert.ok(RECAP_TOTAL_DEADLINE_MS >= 90000 && RECAP_TOTAL_DEADLINE_MS <= 180000, '总时限越界：' + RECAP_TOTAL_DEADLINE_MS);
  assert.equal(RECAP_TOTAL_DEADLINE_MS, 120000, '本取值应固定为 120000（理由见 DESIGN.md 第 39 轮）');
  assert.ok(MAX_QUEUED_RECAPS >= 1 && MAX_QUEUED_RECAPS <= 2, '队列上限越界：' + MAX_QUEUED_RECAPS);
});

test('第39轮 队列｜两路复盘不会同时跑：最大并发恒为 1（计数器实测）', async () => {
  // maxQueued 给到 5：这条用例要验证的是「串行」，不是「丢弃」。
  const queue = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 5000, maxQueued: 5 });
  let concurrent = 0;
  let maxConcurrent = 0;
  let insideCriticalSection = 0;
  let maxInsideCriticalSection = 0;

  const run = async () => {
    // 「读手册 → 检查候选 → 写入」的整段流程：这里用计数器模拟，
    // 任何时刻只允许一份复盘进入这一段（withExclusiveLock 只保护写入那一小段）。
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    insideCriticalSection += 1;
    if (insideCriticalSection > maxInsideCriticalSection) maxInsideCriticalSection = insideCriticalSection;
    await sleep(30);
    insideCriticalSection -= 1;
    concurrent -= 1;
    return 'ok';
  };

  queue.enqueue({ agentId: 'a1', label: '回合 2', run });
  queue.enqueue({ agentId: 'a1', label: '回合 3', run });
  queue.enqueue({ agentId: 'a1', label: '回合 4', run });
  queue.drain();
  // 每份跑 30ms，三份串行 = 90ms 左右；等 300ms 足够跑完（宁多勿少，避免 flaky）。
  await sleep(300);

  assert.equal(maxConcurrent, 1, '出现了并发复盘：' + maxConcurrent);
  assert.equal(maxInsideCriticalSection, 1, '两路复盘同时进入了「检查→写入」段：' + maxInsideCriticalSection);
  assert.equal(queue.snapshot().maxConcurrent, 1, '队列自己记录的最大并发也必须是 1');
  assert.equal(queue.snapshot().started, 3, '三份复盘都该跑完：' + JSON.stringify(queue.snapshot()));
});

test('第39轮 队列｜新回合并进已在排队的那一份（不排长队）', async () => {
  const logs = [];
  const queue = createRecapQueue({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, totalDeadlineMs: 5000 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const summaries = [];

  const run = async (item) => { await firstGate; summaries.push(item.label); return 'ok'; };

  // 第一份必须先「在跑」：merge 只在**有待跑项**时生效，正在跑的那份不参与合并。
  // 所以先用一个 gate 让第一份跑起来，再入队第二份（它成为待跑项），
  // 之后的新请求才全部并进这唯一一个待跑项。
  queue.enqueue({ agentId: 'a1', label: '回合 2', run: () => run({ label: '回合 2' }) });
  queue.drain();
  await sleep(10); // 让第一份真的跑起来（卡在 gate 上）

  queue.enqueue({ agentId: 'a1', label: '回合 3', run: () => run({ label: '回合 3' }) });
  for (const turn of [4, 5]) {
    queue.enqueue(
      { agentId: 'a1', label: '回合 ' + turn, run: () => run({ label: '回合 ' + turn }) },
      (last, item) => { last.label = item.label; last.run = item.run; return true; },
    );
  }

  assert.equal(queue.size, 1, '应只剩唯一一个待跑项（后面的全被并进去）：' + queue.size);
  assert.equal(queue.snapshot().merged, 2, '合并次数应为 2（回合 4、5 并进回合 3）：' + JSON.stringify(queue.snapshot()));
  assert.ok(
    logs.some((m) => m.includes('复盘排队——新回合的复盘并进已在排队的那一份')),
    '缺少合并日志：' + logs.join(' | '),
  );

  releaseFirst();
  await sleep(50);
  // 跑了两份：卡住的那份（回合 2）+ 合并后的那一份（回合 5，回合 3 的 run 被覆盖）。
  // 关键在「回合 3 / 回合 4」没有各自排成一项 —— 队列最多只剩 1 个待跑项。
  assert.deepEqual(summaries, ['回合 2', '回合 5'], '合并后只该跑「在跑的那份 + 最新一份」：' + JSON.stringify(summaries));
});

test('第39轮 队列｜队列上限外丢弃最旧的一项', async () => {
  const logs = [];
  const queue = createRecapQueue({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, totalDeadlineMs: 5000, maxQueued: 2 });
  const gate = new Promise(() => {}); // 永不 resolve：让队列排满
  const run = async () => { await gate; };

  queue.enqueue({ agentId: 'a1', label: '回合 2', run });
  queue.drain();
  await sleep(10);

  // 跑动一份后，队列里连塞 3 份（上限 2）→ 最旧的那份被丢弃。
  queue.enqueue({ agentId: 'a1', label: '回合 3', run });
  queue.enqueue({ agentId: 'a1', label: '回合 4', run });
  queue.enqueue({ agentId: 'a1', label: '回合 5', run });

  assert.equal(queue.size, 2, '队列长度应被压回上限 2：' + queue.size);
  assert.equal(queue.snapshot().dropped, 1, '应丢弃 1 份：' + JSON.stringify(queue.snapshot()));
  assert.ok(logs.some((m) => m.includes('复盘排队已满')), '缺少丢弃日志：' + logs.join(' | '));
  assert.ok(logs.some((m) => m.includes('回合 3')), '被丢弃的应是最旧的「回合 3」：' + logs.join(' | '));
});

test('R45 队列｜run 收到第二参 { deadlineAt } = startedAt + totalDeadlineMs（复盘预算的源头）', async () => {
  const logs = [];
  const queue = createRecapQueue({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, totalDeadlineMs: 5000 });
  const seen = [];
  const settledOutcomes = [];
  queue.enqueue({
    agentId: 'a1',
    label: '回合 2',
    run: async (signal, budget) => {
      seen.push({ hasSignal: signal instanceof AbortSignal, budget });
      return 'ok';
    },
    onSettled: (o) => settledOutcomes.push(o),
  });
  const drainAt = Date.now();
  queue.drain();
  await sleep(20);
  assert.equal(seen.length, 1, 'run 应被调到一次');
  assert.equal(seen[0].hasSignal, true, '第一参照旧是 AbortSignal');
  const at = seen[0].budget && seen[0].budget.deadlineAt;
  assert.equal(typeof at, 'number', '第二参要有 budget.deadlineAt（数字）：' + JSON.stringify(seen[0].budget));
  const t0 = drainAt;
  assert.ok(at >= t0 + 4500 && at <= t0 + 5500, 'deadlineAt ≈ startedAt + 5000ms：' + at + ' vs t0=' + t0);
  assert.equal(settledOutcomes.length, 1);
  assert.equal(settledOutcomes[0].ok, true);
});

test('第39轮 队列｜总时限到点：abort 上游、等它真正 settle 才放行，且通知调用方', async () => {
  // 第 39 轮缺陷 1 修复后的新语义：总时限的含义从「我们不等了」变成「我们开始叫停，
  // 并等它真的停下」。三条硬断言缺一不可：
  //   1. 到点即 abort 本份自己的 controller（signal 作为第一个参数传给 run）；
  //   2. 上游还没 settle 时队列**仍占着** running（busy === true）—— 这正是缺陷 1 的
  //      成因（旧实现到点就置 false，下一份立刻开始，两份复盘同时读写手册）；
  //   3. 上游 settle 之后才 busy === false，才打「复盘超过总时限」日志并通知调用方。
  const logs = [];
  const giveUps = [];
  const failed = [];
  const queue = createRecapQueue({
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    totalDeadlineMs: 50,
  });
  let upstreamAborted = false;
  let upstreamSettled = false;

  queue.enqueue({
    agentId: 'a1',
    label: '回合 2',
    run: async (signal) => {
      // 模拟「真实 provider 忽略 abort」的最坏形态：收到 abort 后**照样继续跑**，
      // 150ms 之后才自己结束。这正是审计报告点名的未验证项——真实 provider 是否
      // 消费 signal 没人验证过，所以队列必须在上游真停下之前一直占着 running。
      signal.addEventListener('abort', () => { upstreamAborted = true; }, { once: true });
      await sleep(150);
      upstreamSettled = true;
      return 'late-but-ignored';
    },
    onGiveUp: (reason) => giveUps.push(reason),
    onFailed: (reason) => failed.push(reason),
  });
  queue.drain();

  // 50ms 期限已过、上游还在跑（且无视 abort）：此刻队列必须还在等（busy === true），
  // 而且**还没有**任何放弃日志/通知（那些都发生在「等它停下」之后）。
  await sleep(120);
  assert.equal(upstreamAborted, true, '总时限到点必须 abort 上游（signal 已接线）');
  assert.equal(upstreamSettled, false, '上游此时还没跑完');
  assert.equal(queue.busy, true, '上游没 settle 之前队列不许放行（缺陷 1：不许提前置 running=false）');
  assert.equal(giveUps.length, 0, '没等上游停下就通知，用户会看到「没并进去」而其实还在写');
  assert.equal(failed.length, 0, '总时限放弃不是真失败，不许触发 onFailed（缺陷 2）');

  // 上游自己跑完之后：队列才恢复空闲，才打日志、才通知。
  await sleep(200);
  assert.equal(upstreamSettled, true, '被放弃的上游应被允许自行跑完（不杀进程、不 reject）');
  assert.ok(logs.some((m) => m.includes('复盘超过总时限 50ms')), '缺少放弃日志：' + logs.join(' | '));
  assert.ok(logs.some((m) => m.includes('等上游停止')), '放弃日志要说明「已中断并等上游停止」：' + logs.join(' | '));
  assert.deepEqual(giveUps, ['复盘超过总时限 50ms'], '放弃后必须通知调用方：' + JSON.stringify(giveUps));
  assert.deepEqual(failed, [], '放弃不是失败，onFailed 一次都不该被调：' + JSON.stringify(failed));
  assert.equal(queue.busy, false, '等上游停下后队列应恢复空闲');
});

test('第39轮 队列｜M1 防线：生产形状（每回合 enqueue 后都 drain）下多次入队不会并发', async () => {
  // 缺陷 7 第一条：lib/recap-queue.js 的 `if (state.running) return;` 这道防线
  // 之前**没有任何用例覆盖**（审计把它注释掉后全仓 570/569 仍全绿）。
  // 而生产形状正是「每回合 enqueue 后立刻 drain」（lib/index.js 的 runRecap 里
  // enqueue → drain → return {queued:true}），审计的 exp/m1-gap.mjs 实测：
  // 注释掉这一行 → maxConcurrent 3；复原 → 1。所以这里必须复刻生产形状：
  // **每 enqueue 一次就 drain 一次**（而不是一次 drain 等三份）。
  const queue = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 5000, maxQueued: 10 });
  let concurrent = 0;
  let maxConcurrent = 0;

  const run = async () => {
    concurrent += 1;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    await sleep(30);
    concurrent -= 1;
    return 'ok';
  };

  for (const turn of [2, 3, 4]) {
    queue.enqueue({ agentId: 'a1', label: '回合 ' + turn, run });
    queue.drain(); // ← 生产形状：每回合都 drain
  }
  await sleep(300);

  assert.equal(maxConcurrent, 1, '生产形状下出现了并发复盘（M1 防线失效）：' + maxConcurrent);
  assert.equal(queue.snapshot().maxConcurrent, 1, '队列记录的最大并发也必须是 1：' + JSON.stringify(queue.snapshot()));
  assert.equal(queue.snapshot().started, 3, '三份复盘都该跑完：' + JSON.stringify(queue.snapshot()));
});

test('第39轮 队列｜真失败也通知调用方，且不把异常抛出去', async () => {
  const giveUps = [];
  const queue = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 5000 });
  queue.enqueue({
    agentId: 'a1',
    label: '回合 2',
    run: async () => { throw new Error('手册写入失败：磁盘满了'); },
    onGiveUp: (reason) => giveUps.push(reason),
  });
  queue.drain();
  await sleep(50);
  assert.equal(giveUps.length, 1, '失败也应通知一次：' + JSON.stringify(giveUps));
  assert.ok(giveUps[0].includes('磁盘满了'), '通知要带原因：' + giveUps[0]);
  assert.equal(queue.busy, false, '失败后队列应恢复空闲');
});

test('第39轮 队列｜真失败触发 onFailed（缺陷 2：mutating 计数的回滚钩子），放弃不触发', async () => {
  // 缺陷 2：生产路径的真实失败发生在队列里（lib/index.js 的 executeRecap 抛错 →
  // 队列的失败分支），**绕过** lib/recap.js 的 catch —— 那条 catch 只在 runRecap 同步
  // 抛错时触发。于是失败那一次 mutating 额度被吞，threshold>1 时要重新攒满
  // （exp/acct.mjs 场景 1 vs 场景 2 实测 mutCount 0 vs 1；acct2.mjs threshold=3 下回合 4
  // 要重新攒 3 次）。回滚钩子就是队列的 onFailed。
  const failedReasons = [];
  const q1 = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 5000 });
  q1.enqueue({
    agentId: 'a1',
    label: '回合 2',
    run: async () => { throw new Error('手册写入失败：磁盘满了'); },
    onFailed: (reason) => failedReasons.push(reason),
  });
  q1.drain();
  await sleep(50);
  assert.deepEqual(failedReasons, ['复盘失败（手册写入失败：磁盘满了）'],
    '真失败必须触发 onFailed，且带完整原因：' + JSON.stringify(failedReasons));

  // 反证：总时限放弃**不许**触发 onFailed —— 放弃的那份可能已写了部分手册，
  // 回滚 mutating 会让下一轮把同一批经验再复盘一次。
  const failedReasons2 = [];
  const q2 = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 30 });
  q2.enqueue({
    agentId: 'a1',
    label: '回合 3',
    run: async (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => resolve('ok'), 200);
    }),
    onFailed: (reason) => failedReasons2.push(reason),
  });
  q2.drain();
  await sleep(150);
  assert.deepEqual(failedReasons2, [], '总时限放弃不是真失败，onFailed 一次都不该被调：' + JSON.stringify(failedReasons2));

  // onFailed 自己抛错也不许把队列弄坏（与 giveUp 同一条红线：通知失败只当没通知）。
  const q3 = createRecapQueue({ logger: { info: () => {}, warn: () => {} }, totalDeadlineMs: 5000 });
  q3.enqueue({
    agentId: 'a1',
    label: '回合 4',
    run: async () => { throw new Error('boom'); },
    onFailed: () => { throw new Error('回调炸了'); },
  });
  q3.drain();
  await sleep(50);
  assert.equal(q3.busy, false, 'onFailed 抛错时队列仍应恢复空闲');
});

test('第39轮 队列｜logger 畸形/缺失都不炸', async () => {
  for (const logger of [undefined, null, {}, { info: 42 }, { info: () => { throw new Error('日志炸了'); } }]) {
    const queue = createRecapQueue({ logger, totalDeadlineMs: 5000 });
    queue.enqueue({ agentId: 'a1', label: '回合 2', run: async () => 'ok', onGiveUp: () => {} });
    queue.drain();
    await sleep(30);
    assert.equal(queue.busy, false, 'logger 畸形时队列应照常跑完');
  }
});

test('第45轮③b｜merge 回调返回假值 ⇒ 不合并、照常排队（既不许谎报合并，也不许把它丢掉）', async () => {
  const logs = [];
  const queue = createRecapQueue({ logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, totalDeadlineMs: 5000 });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const summaries = [];
  const run = async (item) => { await firstGate; summaries.push(item.label); return 'ok'; };

  // 与上一条（merge 返回 true）同一套桩：先让第一份真的在跑，第二份成为唯一待跑项。
  queue.enqueue({ agentId: 'a1', label: '回合 2', run: () => run({ label: '回合 2' }) });
  queue.drain();
  await sleep(10);
  queue.enqueue({ agentId: 'a1', label: '回合 3', run: () => run({ label: '回合 3' }) });

  // 第三份带一个「说没合」的 merge 回调（enqueue 的第二个参数）。
  const out = queue.enqueue(
    { agentId: 'a1', label: '回合 4', run: () => run({ label: '回合 4' }) },
    () => false,
  );

  assert.equal(out.merged, false, 'merge 说不合，返回值就必须说不合（不许谎报已经并进上一份）');
  assert.equal(out.queued, true, '不合并的唯一正确结局是照常入队 —— 绝不能静默丢掉这一份');
  assert.equal(queue.size, 2, '队列里两份都在（回合 3 + 回合 4）：' + queue.size);
  assert.equal(queue.snapshot().merged, 0, '合并计数不许涨：' + JSON.stringify(queue.snapshot()));
  assert.equal(queue.snapshot().dropped, 0, '「没合并」不等于「被丢弃」：' + JSON.stringify(queue.snapshot()));
  assert.ok(
    !logs.some((m) => m.includes('复盘排队——新回合的复盘并进已在排队的那一份')),
    '没合并就不许打合并日志：' + logs.join(' | '),
  );

  releaseFirst();
  await sleep(60);
  assert.deepEqual(summaries, ['回合 2', '回合 3', '回合 4'], '三份都要跑到（既没被合并吃掉、也没被丢掉）：' + JSON.stringify(summaries));
});
