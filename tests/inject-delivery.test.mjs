// dsh-ace 单元测试：注入投递（agent/pre-step 追加一条 user 消息）。
//
// 这一组是第 28 轮改造的**行为**用例：真 import lib/inject-delivery.js + lib/injection-flow.js
// + lib/inject.js，真跑 onPreStep(payload, next)，不复刻生产逻辑、不用源码正则。
//
// 唯一的假件是宿主的 createUserMessage（@deepseek-ai/dsh-llm 在插件目录下不可解析）：
// 这里照宿主实现的行为（role:'user' + 深冻结 + 只 spread）写一个最小替身，
// 由 createInjectionDelivery 依赖注入 —— 生产代码里由 lib/index.js 传真件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectionDelivery, INJECTION_SOURCE_KIND, INJECTION_SOURCE_FORM } from '../lib/inject-delivery.js';
import { createInjectionFlow } from '../lib/injection-flow.js';
import { createInjectionCache, selectInjection } from '../lib/inject.js';
import { createUsageLedger } from '../lib/ledger.js';

// —— 宿主 createUserMessage 的最小替身（~@deepseek-ai/dsh-llm\lib\index.js:59-64）——
// 真实实现：createMessage({...input, role:'user'})，content 原样收下（不校验），对象被 deepFreeze。
function hostCreateUserMessage(input) {
  const message = { ...input, role: 'user', id: 'msg-' + Math.random().toString(36).slice(2) };
  return Object.freeze(message);
}

const ENTRIES = [
  { id: 'ace-001', title: '改代码前先跑基线测试', condition: '动手改任何代码之前', action: '先跑一遍全量测试，记下基线数字', rationale: '否则分不清哪些失败是自己引入的', meta: { helpful: 3, harmful: 0 } },
  { id: 'ace-002', title: '改动后重跑全量测试', condition: '改完之后', action: '重跑 node --test 并对比基线', rationale: '防止回归', meta: { helpful: 2, harmful: 0 } },
];

function mainAgent() {
  return { session: { header: { origin: 'cli' } } };
}
function subAgent() {
  return { session: { header: { origin: 'subagent' } } };
}

/** 造一套真件：缓存 + 账本 + 接缝 + 投递器。 */
function rig({ stats, logger, createUserMessage = hostCreateUserMessage, noCreateUserMessage = false, query = '先跑一遍基线测试' } = {}) {
  const cache = createInjectionCache();
  const ledger = createUsageLedger();
  const flow = createInjectionFlow({ cache, ledger });
  const counters = stats || { batches: 0, appended: 0, skipped: 0, failed: 0 };
  const logs = logger || { info: () => {}, warn: () => {} };
  // noCreateUserMessage：故意不注入宿主的 createUserMessage（模拟装配漏了依赖）
  const delivery = createInjectionDelivery({
    flow,
    createUserMessage: noCreateUserMessage ? undefined : createUserMessage,
    stats: counters,
    logger: logs,
  });
  const picked = selectInjection(ENTRIES, query, {});
  return { cache, ledger, flow, delivery, counters, picked };
}

/** 造一条 pre-step 的下游决策（宿主 agent-loop 的默认返回，见 dsh-agent-loop\lib\index.js:902-927）。 */
function decision(extra = {}) {
  return { kind: 'enter', messages: [{ id: 'prior-1', role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...extra };
}

test('第28轮 a｜同一批注入连续 5 次 pre-step：只有第 1 次追加消息，后 4 次 messages 长度不变，appended 只 +1', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);

  const lengths = [];
  const returned = [];
  for (let i = 0; i < 5; i += 1) {
    const base = decision();
    const out = await r.delivery.onPreStep({ agent, messages: base.messages, turn: 1, step: i + 1 }, async () => base);
    lengths.push(out.messages.length);
    returned.push(out);
  }

  assert.deepEqual(lengths, [2, 1, 1, 1, 1], '第 1 次多出一条（2 条），之后 4 次一条都不多（每次仍是 1 条）');
  assert.equal(r.counters.appended, 1, 'injectedAppended 只 +1（同一批只投递一次）');
  assert.equal(r.counters.batches, 0, '投递不改批次计数（批次由预检索发布时计）');
  assert.equal(returned[0].messages[1].role, 'user');
  assert.ok(returned[0].messages[1].content[0].text.includes('[ace-001]'));
});

test('第28轮 a2｜换一条新消息（新 key）→ 新批次照常投递一次，appended 变 2', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const first = await r.delivery.onPreStep({ agent }, async () => decision());
  assert.equal(first.messages.length, 2);

  const picked2 = selectInjection(ENTRIES, '重跑全量测试', {});
  r.flow.publish(agent, 'id:msg-2', picked2);
  const second = await r.delivery.onPreStep({ agent }, async () => decision());
  assert.equal(second.messages.length, 2, '新批次同样只追加一条');
  assert.ok(second.messages[1].content[0].text.includes('[ace-002]'), '追加的正文来自新批次');
  assert.equal(r.counters.appended, 2);
});

test('第28轮 b｜无待投递批次时什么都不做：messages 原样返回（同一个数组引用）', async () => {
  const r = rig();
  const agent = mainAgent();
  const base = decision();
  const out = await r.delivery.onPreStep({ agent }, async () => base);
  assert.equal(out, base, '没有批次时返回的就是 next() 给的那个对象');
  assert.equal(out.messages.length, 1);
  assert.equal(r.counters.appended, 0);
  assert.equal(r.counters.failed, 0);
});

test('第28轮 c｜追加消息的形状：role=user、source.kind/form 正确、正文含被注入条目的 id', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const out = await r.delivery.onPreStep({ agent }, async () => decision());
  const injected = out.messages[out.messages.length - 1];

  assert.equal(injected.role, 'user', '必须是 user 消息（追加进历史，不是系统提示）');
  assert.equal(injected.source.kind, INJECTION_SOURCE_KIND);
  assert.equal(injected.source.kind, 'dsh-ace');
  assert.equal(injected.source.form, INJECTION_SOURCE_FORM);
  assert.equal(injected.source.form, 'injection');
  assert.ok(Array.isArray(injected.content), 'content 必须是 ContentBlock[]（裸字符串会让宿主的 .content.some 抛错）');
  assert.equal(injected.content[0].type, 'text');
  const text = injected.content[0].text;
  assert.ok(text.includes('【ACE 自动注入】'), '沿用既有注入块文本格式');
  for (const id of r.picked.ids) {
    assert.ok(text.includes('[' + id + ']'), '正文必须含被注入条目的 id：' + id);
  }
  assert.ok(text.includes('先跑一遍全量测试'), '正文含条目做法');
  // 追加位置：末尾（历史尾部），不是头部
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].id, 'prior-1', '原有消息一个都没动');
});

test('第28轮 d｜decision 的其它字段被保留（尤其 startsRequestSeries）', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const base = decision({ startsRequestSeries: true, extra: { keep: 'me' } });
  const out = await r.delivery.onPreStep({ agent }, async () => base);

  assert.equal(out.kind, 'enter');
  assert.equal(out.startsRequestSeries, true, 'startsRequestSeries 必须被 spread 保留');
  assert.deepEqual(out.extra, { keep: 'me' }, '未知字段也要保留（spread 而不是重建）');
  assert.equal(out.messages.length, 2);
  assert.notEqual(out, base, '返回的是新对象（messages 变了），但其它字段等价');
});

test('第28轮 d2｜decision.kind==="reject" 时原样返回，绝不追加', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const reject = { kind: 'reject', reason: 'user-aborted' };
  const out = await r.delivery.onPreStep({ agent }, async () => reject);
  assert.equal(out, reject, '宿主的否决必须原样返回');
  assert.equal(r.counters.appended, 0);
  assert.equal(r.ledger.peek(agent).length, 0, '被否决的回合不许记账');
});

test('第28轮 e｜子代理不追加（isMainAgent 门），也不记账', async () => {
  const r = rig();
  const sub = subAgent();
  r.flow.publish(sub, 'id:msg-1', r.picked);
  const base = decision();
  const out = await r.delivery.onPreStep({ agent: sub }, async () => base);

  assert.equal(out, base, '子代理的决策原样返回');
  assert.equal(out.messages.length, 1);
  assert.equal(r.counters.appended, 0);
  assert.equal(r.ledger.peek(sub).length, 0, '子代理不记账（D4：没有结算路径）');
  // 主代理照常
  const main = mainAgent();
  r.flow.publish(main, 'id:msg-2', r.picked);
  const mainOut = await r.delivery.onPreStep({ agent: main }, async () => decision());
  assert.equal(mainOut.messages.length, 2);
  assert.equal(r.ledger.peek(main).length, 2);
});

test('第28轮 f｜createUserMessage 抛错 → failed +1，返回的 decision 与原 decision 等价（不中断回合）', async () => {
  const warns = [];
  const r = rig({ createUserMessage: () => { throw new Error('宿主造消息炸了'); }, logger: { info: () => {}, warn: (m) => warns.push(m) } });
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const base = decision({ startsRequestSeries: true });

  let out;
  await assert.doesNotReject(async () => {
    out = await r.delivery.onPreStep({ agent }, async () => base);
  });
  assert.equal(out.kind, 'enter');
  assert.equal(out.startsRequestSeries, true);
  assert.deepEqual(out.messages, base.messages, 'messages 与原 decision 完全一致');
  assert.equal(r.counters.failed, 1, 'injectedFailed +1');
  assert.equal(r.counters.appended, 0, '没投递成功就不许记追加');
  assert.equal(warns.length, 1, '只写一行 warn');
  assert.ok(warns[0].startsWith('dsh-ace: 注入追加进历史失败，本步不注入'));
  assert.ok(warns[0].includes('宿主造消息炸了'));
  assert.equal(r.ledger.peek(agent).length, 0, '没追加进历史就不许记账');
});

test('第28轮 f2｜createUserMessage 不可用（未注入）也走失败路径，不抛出', async () => {
  const r = rig({ noCreateUserMessage: true });
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  const base = decision();
  const out = await r.delivery.onPreStep({ agent }, async () => base);
  assert.equal(out, base);
  assert.equal(r.counters.failed, 1);
  assert.equal(r.counters.appended, 0);
});

test('第28轮｜下游 next() 抛错时原样冒出去（不吞宿主的错误）', async () => {
  const r = rig();
  const boom = new Error('下游炸了');
  await assert.rejects(() => r.delivery.onPreStep({ agent: mainAgent() }, async () => { throw boom; }), /下游炸了/);
});

test('第28轮｜投递一次只记一次账：ledger 拿到 ids 且不重复', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', r.picked);
  for (let i = 0; i < 3; i += 1) await r.delivery.onPreStep({ agent }, async () => decision());
  assert.deepEqual(r.ledger.peek(agent).sort(), r.picked.ids.slice().sort(), '账本里恰好这一批的 id，去重后不翻倍');
  assert.equal(r.ledger.take(agent).length, r.picked.ids.length);
  assert.equal(r.ledger.peek(agent).length, 0, '取走后清空');
});

test('第28轮｜空 ids / 空文本的批次不投递（无命中时不留空消息）', async () => {
  const r = rig();
  const agent = mainAgent();
  r.flow.publish(agent, 'id:msg-1', { text: '', ids: [], tokens: 0, count: 0 });
  const base = decision();
  const out = await r.delivery.onPreStep({ agent }, async () => base);
  assert.equal(out, base);
  assert.equal(r.counters.appended, 0);

  r.flow.publish(agent, 'id:msg-2', { text: '   ', ids: ['ace-001'], tokens: 1, count: 1 });
  const out2 = await r.delivery.onPreStep({ agent }, async () => base);
  assert.equal(out2, base, '文本全空白也不投递');
  assert.equal(r.counters.appended, 0);
});

test('第28轮｜payload 里没有 agent 时原样返回（不抛）', async () => {
  const r = rig();
  const base = decision();
  const out = await r.delivery.onPreStep({}, async () => base);
  assert.equal(out, base);
  assert.equal(r.counters.appended, 0);
  assert.equal(r.counters.failed, 0);
});
