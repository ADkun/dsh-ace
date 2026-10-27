// dsh-ace 多轮复盘（C3）的轮次编排用例。
// 只测纯逻辑层（lib/reflect.js），不碰宿主：用假的 callRound 驱动各种收敛/超限/异常路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflectRounds, REFLECT_MAX_ROUNDS } from '../lib/reflect.js';

test('C3｜上限是 3 轮（用户拍板的硬上限）', () => {
  assert.equal(REFLECT_MAX_ROUNDS, 3);
});

test('C3｜第 1 轮就返回空数组 → 立刻收敛，只跑 1 轮', async () => {
  const seen = [];
  const out = await reflectRounds({ callRound: async (round) => { seen.push(round); return []; } });
  assert.deepEqual(seen, [1]);
  assert.equal(out.rounds, 1);
  assert.equal(out.converged, true);
  assert.deepEqual(out.candidates, []);
});

test('C3｜第 2 轮返回空数组 → 收敛，候选只来自第 1 轮（不是「本轮无候选就丢掉前面的」）', async () => {
  const a = [{ title: 'A', condition: 'c', action: 'a', rationale: 'r' }];
  const out = await reflectRounds({
    callRound: async (round) => (round === 1 ? a : []),
  });
  assert.equal(out.rounds, 2);
  assert.equal(out.converged, true);
  assert.deepEqual(out.candidates, a, '第 1 轮的候选必须保留');
});

test('C3｜每轮都有新候选 → 跑满 3 轮硬停（converged=false），候选按轮累积', async () => {
  const rounds = [];
  const out = await reflectRounds({
    callRound: async (round) => {
      rounds.push(round);
      return [{ title: 'T' + round, condition: 'c', action: 'a', rationale: 'r' }];
    },
  });
  assert.deepEqual(rounds, [1, 2, 3], '最多 3 轮，不许无限跑');
  assert.equal(out.rounds, 3);
  assert.equal(out.converged, false, '没出现空数组就不是「收敛」');
  assert.deepEqual(out.candidates.map((c) => c.title), ['T1', 'T2', 'T3']);
});

test('C3｜第 2 轮起把此前已提炼的候选原样传进去（供提示词去重）', async () => {
  const seen = [];
  const c1 = { title: 'A', condition: 'c', action: 'a', rationale: 'r' };
  const c2 = { title: 'B', condition: 'c', action: 'a', rationale: 'r' };
  await reflectRounds({
    callRound: async (round, prior) => {
      seen.push({ round, prior });
      if (round === 1) return [c1];
      if (round === 2) return [c2];
      return [];
    },
  });
  assert.equal(seen[0].prior.length, 0, '第 1 轮没有前置候选');
  assert.deepEqual(seen[1].prior, [c1], '第 2 轮拿到第 1 轮的候选');
  assert.deepEqual(seen[2].prior, [c1, c2], '第 3 轮拿到前两轮的累积');
});

test('C3｜传给 callRound 的 prior 是副本，回调里改它不会污染累积器', async () => {
  const out = await reflectRounds({
    callRound: async (round, prior) => {
      prior.push({ title: '脏数据' });   // 故意改副本
      return round === 1 ? [{ title: 'A', condition: 'c', action: 'a', rationale: 'r' }] : [];
    },
  });
  assert.deepEqual(out.candidates.map((c) => c.title), ['A'], '累积器不被回调污染');
});

test('C3｜第 1 轮就抛错（LLM 失败/取消）原样上抛，不吞掉', async () => {
  await assert.rejects(
    () => reflectRounds({ callRound: async () => { throw new Error('LLM 调用失败'); } }),
    /LLM 调用失败/,
  );
});

test('C3｜后续轮次抛错（超时/取消）→ 按已提炼的候选落盘，标记 aborted，不丢前面几轮的经验', async () => {
  const logs = [];
  const out = await reflectRounds({
    logger: { info: (m) => logs.push(m) },
    callRound: async (round) => {
      if (round === 1) return [{ title: 'A', condition: 'c', action: 'a', rationale: 'r' }];
      throw new Error('aborted by timeout');
    },
  });
  assert.deepEqual(out.candidates.map((c) => c.title), ['A'], '第 1 轮已有的候选必须留下');
  assert.equal(out.rounds, 1, '中断的那轮不计入完成轮数');
  assert.equal(out.aborted, true);
  assert.equal(out.converged, false, '中断不等于收敛');
  assert.ok(logs.some((m) => m.includes('aborted by timeout')), '中断要留日志');
});

test('C3｜callRound 返回非数组按空数组处理（收敛），不炸', async () => {
  const out = await reflectRounds({ callRound: async () => undefined });
  assert.deepEqual(out.candidates, []);
  assert.equal(out.rounds, 1);
  assert.equal(out.converged, true);
});

test('C3｜maxRounds 可调（测试与将来放宽上限用），最小 1 轮', async () => {
  const one = await reflectRounds({ maxRounds: 1, callRound: async () => [{ title: 'X' }] });
  assert.equal(one.rounds, 1);
  assert.equal(one.candidates.length, 1);
  const five = await reflectRounds({ maxRounds: 5, callRound: async (r) => [{ title: 'T' + r }] });
  assert.equal(five.rounds, 5);
  const zero = await reflectRounds({ maxRounds: 0, callRound: async () => [] });
  assert.equal(zero.rounds, 1, '0 也至少跑 1 轮');
});

test('C3｜没有 callRound 直接抛（防止误用导致静默跳过复盘）', async () => {
  await assert.rejects(() => reflectRounds({}), /需要 callRound/);
});

test('C3｜每轮留一行日志（可审计：哪一轮产出了几条、哪一轮收敛）', async () => {
  const logs = [];
  await reflectRounds({
    logger: { info: (m) => logs.push(m) },
    callRound: async (round) => (round === 1 ? [{ title: 'A' }] : []),
  });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /第 1 轮产出 1 条候选/);
  assert.match(logs[1], /第 2 轮无新增候选/);
});

test('C3｜logger 畸形/缺失都不炸', async () => {
  await reflectRounds({ logger: {}, callRound: async () => [] });
  await reflectRounds({ logger: { info: 'not a function' }, callRound: async () => [] });
  await reflectRounds({ logger: { get info() { throw new Error('boom'); } }, callRound: async () => [] });
});

test('C3｜第 39 轮：第 1 轮单次 LLM 超时也按「本轮放弃」收尾，不上抛', async () => {
  // 单次调用超时（lib/llm.js 抛的 'ace: LLM 调用超时…'）只让这一轮放弃：
  // 第 1 轮就超时也应返回 0 条候选 + aborted:true，而不是把整段复盘炸掉。
  const logs = [];
  const result = await reflectRounds({
    logger: { info: (m) => logs.push(m) },
    callRound: async () => { throw new Error('ace: LLM 调用超时（单次上限 75000ms）：The operation was aborted'); },
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.rounds, 0);
  assert.equal(result.converged, false);
  assert.equal(result.aborted, true, '超时必须标成 aborted（调用方据此走通知路径）');
  assert.match(logs[0], /多轮复盘第 1 轮中断/);
  assert.match(logs[0], /ace: LLM 调用超时/);
});

test('C3｜第 39 轮：超时只放弃那一轮，已提炼的候选仍按原样落盘', async () => {
  const logs = [];
  const result = await reflectRounds({
    logger: { info: (m) => logs.push(m) },
    callRound: async (round) => {
      if (round === 1) return [{ title: 'A', condition: 'c', action: 'a', rationale: 'r' }];
      throw new Error('ace: LLM 调用超时（单次上限 75000ms）：The operation was aborted');
    },
  });
  assert.equal(result.candidates.length, 1, '第 1 轮已提炼的候选必须留下');
  assert.equal(result.rounds, 1);
  assert.equal(result.aborted, true);
  assert.match(logs[1], /多轮复盘第 2 轮中断/);
});

test('C3｜第 39 轮：普通错误第 1 轮仍原样上抛（只吞超时，不吞真故障）', async () => {
  await assert.rejects(
    () => reflectRounds({ callRound: async () => { throw new Error('JSON 解析失败：模型输出不是对象'); } }),
    /JSON 解析失败/,
  );
  // 超时标记出现在**中间**也不算（必须是开头）—— 防止别的错误被误判成超时吞掉。
  await assert.rejects(
    () => reflectRounds({ callRound: async () => { throw new Error('上游报错：ace: LLM 调用超时（单次上限 1ms）'); } }),
    /上游报错/,
  );
  // 前缀本身没错、但**不是同一个词**的也不算（防止误吞语义不同的错误）。
  await assert.rejects(
    () => reflectRounds({ callRound: async () => { throw new Error('ace: LLM 调用被限流'); } }),
    /被限流/,
  );
});
