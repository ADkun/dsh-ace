// dsh-ace 轨迹渲染器（lib/trajectory.js）的行为测试。
//
// 覆盖的核心事实：
// - 自动复盘原来只喂「本回合有 N 次 mutating 工具调用」这句计数，实测 Reflector 返回 0 候选；
//   喂真实轨迹才产出候选。所以渲染规则本身就是修复的一部分，必须逐条钉住。
// - 输入形状见 DSH checkout（~\dsh-llm\lib\types\message.d.ts:120-174、
//   types.d.ts:45-126）；本文件只构造普通对象，不 import 任何宿主包。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  renderTrajectory,
  collectTurnTrajectory,
  buildRecapSummary,
  TRAJECTORY_DEFAULTS,
} from '../lib/trajectory.js';

/** 造一条消息：role + 若干内容块。 */
function msg(role, content, extra = {}) {
  return { id: 'm-' + role, role, content, ...extra };
}

const text = (t) => ({ type: 'text', text: t });
const call = (name, args) => ({ type: 'tool-call', id: 'c1', name, arguments: args });
const reasoning = (t) => ({ type: 'reasoning', text: t });

test('renderTrajectory: 默认值可覆盖且形状正确', () => {
  assert.equal(TRAJECTORY_DEFAULTS.maxMessages, 60);
  assert.equal(TRAJECTORY_DEFAULTS.maxChars, 12000);
  assert.equal(TRAJECTORY_DEFAULTS.maxHeadChars, 3000);
  assert.equal(TRAJECTORY_DEFAULTS.maxTextChars, 500);
  assert.equal(TRAJECTORY_DEFAULTS.maxArgChars, 300);
  assert.equal(TRAJECTORY_DEFAULTS.maxToolResultChars, 400);
  const out = renderTrajectory([msg('user', [text('你好')])]);
  assert.deepEqual(Object.keys(out).sort(), ['messageCount', 'text', 'truncated']);
});

test('renderTrajectory: 多轮按原顺序渲染，角色前缀正确', () => {
  const out = renderTrajectory([
    msg('user', [text('把 a.txt 改成 b')]),
    msg('assistant', [text('好的'), call('read', '{"file_path":"a.txt"}')]),
    msg('tool', [text('a')], { toolCallId: 'c1' }),
    msg('assistant', [text('改完了')]),
  ]);
  assert.equal(out.text, [
    '用户: 把 a.txt 改成 b',
    '助手: 好的',
    '  → read({"file_path":"a.txt"})',
    // 格式升级（缺陷 3）：结果行现在带工具名，靠同一次渲染里 tool-call id → 工具名反查。
    '结果(read): a',
    '助手: 改完了',
  ].join('\n'));
  assert.equal(out.messageCount, 4);
  assert.equal(out.truncated, false);
});

test('renderTrajectory: system 与 developer 整条跳过（不参与计数）', () => {
  const out = renderTrajectory([
    msg('system', [text('你是 DSH 的系统提示，很长很长')]),
    msg('developer', [text('工具清单'), { type: 'tool-addition', toolName: 'read' }]),
    msg('user', [text('真正的问题')]),
  ]);
  assert.equal(out.text, '用户: 真正的问题');
  assert.equal(out.messageCount, 1);
  assert.equal(out.truncated, false);
  // 跳过是显式的：其它未知 role 照常渲染（不静默丢材料），所以这条断言让
  // 「删掉 system/developer 的跳过判断」必然变红，而不是被兜底 return [] 掩盖。
  const unknown = renderTrajectory([
    msg('system', [text('系统提示')]),
    msg('some-future-role', [text('别的内容')]),
  ]);
  assert.equal(unknown.text, 'some-future-role: 别的内容');
  assert.equal(unknown.messageCount, 1);
});

test('renderTrajectory: reasoning 块被跳过（不占正文、不触发截断）', () => {
  const out = renderTrajectory([
    msg('assistant', [reasoning('我想了很久'.repeat(1000)), text('结论')]),
  ]);
  assert.equal(out.text, '助手: 结论');
  assert.equal(out.truncated, false);
});

test('renderTrajectory: tool-call 渲染成「→ 工具名(参数)」，参数截断到 maxArgChars', () => {
  const out = renderTrajectory([
    msg('assistant', [call('pwsh', 'x'.repeat(50))]),
  ], { maxArgChars: 10 });
  assert.equal(out.text, '  → pwsh(' + 'x'.repeat(10) + '…)');
  assert.equal(out.truncated, true);
});

test('renderTrajectory: tool 结果失败时带 [失败] 前缀，正文截断到 maxToolResultChars', () => {
  // 这几条没有对应的 tool-call，映射里查不到 id → 退回不带工具名的「结果: 」（缺陷 3 的回退路径）。
  const ok = renderTrajectory([msg('tool', [text('done')], { toolCallId: 'c1' })]);
  assert.equal(ok.text, '结果: done');
  const bad = renderTrajectory([msg('tool', [text('boom')], { toolCallId: 'c1', isError: true })]);
  assert.equal(bad.text, '[失败] 结果: boom');
  const long = renderTrajectory([msg('tool', [text('y'.repeat(20))], { toolCallId: 'c1' })], { maxToolResultChars: 5 });
  assert.equal(long.text, '结果: yyyyy…');
  assert.equal(long.truncated, true);
  // 有映射时失败前缀仍在最前：'[失败] 结果(read): boom'
  const withName = renderTrajectory([
    msg('assistant', [{ type: 'tool-call', id: 'c9', name: 'read', arguments: '{}' }]),
    msg('tool', [text('boom')], { toolCallId: 'c9', isError: true }),
  ]);
  assert.equal(withName.text, '  → read({})\n[失败] 结果(read): boom');
});

test('renderTrajectory: image / file 渲染成占位符，未知块类型忽略', () => {
  const out = renderTrajectory([
    msg('user', [{ type: 'image' }, { type: 'file' }, { type: 'text', text: '看图' }, { type: 'mystery', x: 1 }]),
  ]);
  assert.equal(out.text, '用户: [图片]\n[文件]\n看图');
});

test('renderTrajectory: user/assistant 正文截断到 maxTextChars 并标记 truncated', () => {
  const out = renderTrajectory([
    msg('user', [text('u'.repeat(30))]),
    msg('assistant', [text('a'.repeat(30))]),
  ], { maxTextChars: 4 });
  assert.equal(out.text, '用户: uuuu…\n助手: aaaa…');
  assert.equal(out.truncated, true);
});

test('renderTrajectory: maxMessages 只取尾部，前面的消息不渲染', () => {
  const messages = [];
  for (let i = 1; i <= 5; i++) messages.push(msg('user', [text('第' + i + '条')]));
  const out = renderTrajectory(messages, { maxMessages: 2 });
  assert.equal(out.text, '用户: 第4条\n用户: 第5条');
  assert.equal(out.messageCount, 2);
  assert.equal(out.truncated, true);
  // 恰好等于上限时不算截断
  const exact = renderTrajectory(messages, { maxMessages: 5 });
  assert.equal(exact.messageCount, 5);
  assert.equal(exact.truncated, false);
});

test('renderTrajectory: maxChars 超限时首尾都保留，中间加省略标记且 truncated 为真', () => {
  const messages = [
    msg('user', [text('A'.repeat(50))]),
    msg('user', [text('B'.repeat(50))]),
  ];
  const maxChars = 100;
  const out = renderTrajectory(messages, { maxChars, maxTextChars: 50 });
  // 首尾都留：开头那段也在（缺陷 1 的核心——只留尾部会把开头的任务目标整段切掉）。
  assert.ok(out.text.startsWith('用户: A'), '开头内容必须保留：' + out.text.slice(0, 20));
  assert.ok(out.text.includes('\n…（中间 '), '中间必须有省略标记：' + out.text);
  assert.ok(out.text.includes(' 字符已省略）\n'));
  assert.ok(out.text.endsWith('B'), '尾部内容必须保留（正文末尾那串 B）');
  assert.equal(out.truncated, true);
  const omitted = Number(out.text.match(/中间 (\d+) 字符已省略/)[1]);
  assert.ok(omitted > 0);
  // 省略标记里的数字 = 被丢掉的字符数：保留部分 = 完整渲染长度 - omitted
  const full = renderTrajectory(messages, { maxChars: 1_000_000, maxTextChars: 50 });
  assert.equal(full.truncated, false);
  const kept = out.text.replace(/\n…（中间 \d+ 字符已省略）\n/, '');
  assert.equal(kept.length, full.text.length - omitted);
  // 含省略标记在内，总长必须 ≤ maxChars
  assert.ok(out.text.length <= maxChars, '总长必须 ≤ maxChars：' + out.text.length);
});

test('renderTrajectory: 长回合超限后，第一条 user 的任务目标仍在输出里（缺陷 1 的核心目的）', () => {
  // 复刻验收者的构造：1 条 user 目标 + 25×(assistant 480 字 + tool 结果 390 字) + 1 次 isError。
  // 单块上限（maxTextChars 500 / maxToolResultChars 400）× 条数会撑爆总上限，
  // 旧实现是硬截尾，于是开头的「目标：…」被整段丢掉——那正是喂真轨迹要保住的东西。
  const goal = '目标：修好 build 脚本';
  const messages = [msg('user', [text(goal)])];
  for (let i = 0; i < 25; i++) {
    messages.push(msg('assistant', [text('A'.repeat(480)), { type: 'tool-call', id: 'c' + i, name: 'pwsh', arguments: '{}' }]));
    messages.push(msg('tool', [text('T'.repeat(390))], { toolCallId: 'c' + i }));
  }
  messages.push(msg('tool', [text('E'.repeat(390))], { toolCallId: 'c-last', isError: true }));

  const full = renderTrajectory(messages, { maxChars: 1_000_000 });
  assert.ok(full.text.length > 12000, '这个构造必须真的超限：' + full.text.length);

  const out = renderTrajectory(messages);
  assert.ok(out.text.includes(goal), '超限后任务目标必须仍在输出里：' + out.text.slice(0, 40));
  assert.ok(out.text.startsWith('用户: ' + goal), '目标必须还在开头');
  assert.ok(out.text.includes('…（中间 '), '中间省略标记');
  assert.ok(out.text.length <= TRAJECTORY_DEFAULTS.maxChars, '输出总长必须 ≤ maxChars：' + out.text.length);
  assert.equal(out.truncated, true);
  // 进 buildRecapSummary 之后依然在
  const summary = buildRecapSummary({ mutCount: 51, trajectory: out });
  assert.ok(summary.includes(goal), '拼进 summary 后目标仍必须可见');
});

test('renderTrajectory: maxChars 很小（200）时不抛错，长度仍 ≤ maxChars', () => {
  const messages = [
    msg('user', [text('目标：' + 'X'.repeat(400))]),
    msg('assistant', [text('Y'.repeat(400))]),
    msg('tool', [text('Z'.repeat(400))], { toolCallId: 'c1' }),
  ];
  let out;
  assert.doesNotThrow(() => { out = renderTrajectory(messages, { maxChars: 200 }); });
  assert.ok(out.text.length <= 200, '总长必须 ≤ maxChars：' + out.text.length);
  assert.equal(out.truncated, true);
  // 更极端：连省略标记都快放不下，也不许抛错、不许超长
  for (const tiny of [1, 5, 20, 41, 60]) {
    let o;
    assert.doesNotThrow(() => { o = renderTrajectory(messages, { maxChars: tiny }); });
    assert.ok(o.text.length <= tiny, 'maxChars=' + tiny + ' 时总长必须 ≤ maxChars：' + o.text.length);
  }
  // 首尾预算被 maxChars/2 夹住：head 不会吃掉全部额度
  const half = renderTrajectory(messages, { maxChars: 400, maxHeadChars: 3000 });
  assert.ok(half.text.length <= 400);
  assert.ok(half.text.includes('…（中间 '));
  assert.ok(half.text.startsWith('用户: 目标：'), 'head 预算被 maxChars/2 夹住后开头仍在');
});

test('renderTrajectory: 退化分支（maxChars 小到放不下尾部）里标记的 N 等于真实丢弃数，放不下标记时返回空 text', () => {
  // 40 条消息、全文约 8.8K 字符：maxChars <= 80 时 tailBudget <= 0，走「开头 + 省略标记」退化分支。
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push(msg('user', [text('问题' + i + '：' + 'Q'.repeat(200))]));
    messages.push(msg('assistant', [text('回答' + i + '：' + 'A'.repeat(200))]));
  }
  const full = renderTrajectory(messages, { maxChars: 100000 });
  assert.ok(full.text.length > 8000, '前置条件：全文要足够长：' + full.text.length);

  for (const tiny of [1, 5, 17, 30, 33, 40, 80]) {
    const out = renderTrajectory(messages, { maxChars: tiny });
    assert.ok(out.text.length <= tiny, 'maxChars=' + tiny + ' 时总长必须 ≤ maxChars：' + out.text.length);
    if (out.text === '') continue; // 标记都放不下：按约定返回空 text，调用方走「没材料」分支
    const m = out.text.match(/\n…（中间 (\d+) 字符已省略）\n/);
    assert.ok(m, 'maxChars=' + tiny + ' 时要么是空 text，要么带完整省略标记（不许吐半截标记）：' + JSON.stringify(out.text));
    const omitted = Number(m[1]);
    const head = out.text.slice(0, m.index);
    const tail = out.text.slice(m.index + m[0].length);
    assert.equal(head.length + tail.length + omitted, full.text.length,
      'maxChars=' + tiny + ' 时标记声称省略 ' + omitted + ' 个字符，但真实丢弃了 '
      + (full.text.length - head.length - tail.length) + ' 个');
  }
});

test('buildRecapSummary: 整条 summary（含两行标题）也 ≤ maxChars', () => {
  // 轨迹本身已经贴着 maxChars 上限：标题两行一加就会越界，必须从轨迹预算里扣。
  const rendered = renderTrajectory([
    msg('user', [text('目标：' + 'X'.repeat(400))]),
    msg('assistant', [text('Y'.repeat(400))]),
    msg('tool', [text('Z'.repeat(400))], { toolCallId: 'c1' }),
  ], { maxChars: 600 });
  assert.ok(rendered.text.length > 500, '前置条件：轨迹本身已贴着上限：' + rendered.text.length);
  const s = buildRecapSummary({ mutCount: 12, trajectory: rendered });
  assert.ok(s.length <= TRAJECTORY_DEFAULTS.maxChars, '整条 summary 必须 ≤ 默认 maxChars：' + s.length);
  const budgeted = buildRecapSummary({ mutCount: 12, trajectory: rendered, maxChars: 600 });
  assert.ok(budgeted.length <= 600, '显式传更紧的预算时整条 summary 也要 ≤ 600：' + budgeted.length);
  assert.ok(s.startsWith('自动复盘：本回合有 12 次 mutating 工具调用。'));
  assert.ok(s.includes('## 本回合轨迹（最近 3 条消息）'));
  assert.ok(s.includes('目标：'), '裁掉的是尾部细节，开头任务目标必须还在');

  const tight = buildRecapSummary({ mutCount: 12, trajectory: rendered, maxChars: 120 });
  assert.ok(tight.length <= 120, '显式传 maxChars 时整条 ≤ 120：' + tight.length);
});

test('buildRecapSummary: maxChars 小于计数行长度时以保证计数行完整为准（唯一例外，口径钉死）', () => {
  // 计数行长度随 N 的位数变：一位数 28 个字符，两位数 29 个字符。
  const head = '自动复盘：本回合有 3 次 mutating 工具调用。';
  assert.equal(head.length, 28, '前置条件：N 为一位数时计数行长度就是 28');
  // 用**有轨迹**的输入，确保走的是「拼标题 + 裁轨迹」那条路径，而不是「没材料直接返回计数行」
  const rendered = renderTrajectory([
    msg('user', [text('目标：' + 'X'.repeat(400))]),
    msg('assistant', [text('Y'.repeat(400))]),
  ], { maxChars: 600 });
  assert.ok(rendered.text.length > 300, '前置条件：轨迹本身非空：' + rendered.text.length);

  // maxChars = 1..27（比计数行短一个字符以上）：返回值必须**恰为**完整计数行
  for (let tiny = 1; tiny < head.length; tiny++) {
    const s = buildRecapSummary({ mutCount: 3, trajectory: rendered, maxChars: tiny });
    assert.equal(s, head, 'maxChars=' + tiny + ' 时必须原样返回完整计数行（不截断、不拼接）：' + JSON.stringify(s));
    assert.ok(!s.includes('## 本回合轨迹'), 'maxChars=' + tiny + ' 时不许带上轨迹标题（半截 summary 毫无意义）');
  }
  // 两位数的 N：计数行 29 个字符，同理 maxChars = 1..28 时返回完整计数行
  const head2 = '自动复盘：本回合有 12 次 mutating 工具调用。';
  assert.equal(head2.length, 29, '前置条件：N 为两位数时计数行 29 个字符');
  for (let tiny = 1; tiny < head2.length; tiny++) {
    assert.equal(buildRecapSummary({ mutCount: 12, trajectory: rendered, maxChars: tiny }), head2,
      'maxChars=' + tiny + '（两位数 N）时也必须原样返回完整计数行');
  }
  // 边界另一侧：maxChars 刚好够放计数行时，仍然是「只有计数行」（轨迹预算 <= 0）
  assert.equal(buildRecapSummary({ mutCount: 3, trajectory: rendered, maxChars: head.length }), head);
  // 再大一点就必须恢复「整条 ≤ maxChars」的正常口径
  const roomy = buildRecapSummary({ mutCount: 3, trajectory: rendered, maxChars: head.length + 40 });
  assert.ok(roomy.length <= head.length + 40, '预算够时整条 summary 必须 ≤ maxChars：' + roomy.length);
  assert.ok(roomy.includes('## 本回合轨迹'), '预算够时必须带上轨迹标题：' + JSON.stringify(roomy));
});

test('renderTrajectory: 并行 tool-call 按 id 各自绑定工具名', () => {
  const out = renderTrajectory([
    msg('user', [text('并行读两个文件')]),
    msg('assistant', [
      { type: 'tool-call', id: 'a1', name: 'read', arguments: '{"file_path":"x"}' },
      { type: 'tool-call', id: 'b2', name: 'grep', arguments: '{"pattern":"y"}' },
    ]),
    msg('tool', [text('x 的内容')], { toolCallId: 'a1' }),
    msg('tool', [text('grep 命中 2 行')], { toolCallId: 'b2' }),
  ]);
  assert.equal(out.text, [
    '用户: 并行读两个文件',
    // assistant 这条只有 tool-call、没有 text 块，所以不产出「助手: 」行（既有行为，未改）。
    '  → read({"file_path":"x"})',
    '  → grep({"pattern":"y"})',
    '结果(read): x 的内容',
    '结果(grep): grep 命中 2 行',
  ].join('\n'));
  // 顺序反过来也照样按 id 绑定，不靠位置猜
  const swapped = renderTrajectory([
    msg('assistant', [
      { type: 'tool-call', id: 'a1', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'b2', name: 'grep', arguments: '{}' },
    ]),
    msg('tool', [text('第二个先回')], { toolCallId: 'b2' }),
    msg('tool', [text('第一个后回')], { toolCallId: 'a1' }),
  ]);
  assert.ok(swapped.text.includes('结果(grep): 第二个先回'));
  assert.ok(swapped.text.includes('结果(read): 第一个后回'));
});

test('renderTrajectory: toolCallId 查不到时回退成不带工具名的「结果: 」', () => {
  // 未知 id
  const unknown = renderTrajectory([
    msg('assistant', [{ type: 'tool-call', id: 'a1', name: 'read', arguments: '{}' }]),
    msg('tool', [text('谁的结果？')], { toolCallId: 'zzz' }),
  ]);
  assert.ok(unknown.text.endsWith('结果: 谁的结果？'), '未知 id 必须回退：' + unknown.text);
  // 根本没有 id
  const noId = renderTrajectory([
    msg('assistant', [{ type: 'tool-call', id: 'a1', name: 'read', arguments: '{}' }]),
    msg('tool', [text('没带 id')]),
  ]);
  assert.equal(noId.text, '  → read({})\n结果: 没带 id');
});

test('renderTrajectory: tool-call 映射每次调用各自新建，两次连续调用不串味', () => {
  const first = renderTrajectory([
    msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]),
    msg('tool', [text('第一次')], { toolCallId: 'c1' }),
  ]);
  assert.ok(first.text.includes('结果(read): 第一次'));
  // 第二次没有 tool-call：同一个 id 不该被上一次的名字染上
  const second = renderTrajectory([
    msg('tool', [text('第二次')], { toolCallId: 'c1' }),
  ]);
  assert.equal(second.text, '结果: 第二次', '映射必须每次调用新建，不许跨调用串味');
});

test('renderTrajectory: 各种畸形输入不抛错', () => {
  const cases = [
    undefined, null, [], 'not an array', 42, {},
    [null, undefined, 3, 'x'],
    [{ role: 'user' }],
    [{ role: 'user', content: 'not an array' }],
    [{ role: 'user', content: [null, 5, 'str', {}] }],
    [{ role: 'assistant', content: [{ type: 'tool-call' }] }],
    [{ role: 'assistant', content: [{ type: 'tool-call', name: 42, arguments: null }] }],
    [{ role: 'tool', content: [{ type: 'text', text: 99 }], isError: 'yes' }],
    [{ role: 'unknown-role', content: [text('x')] }],
  ];
  for (const input of cases) {
    assert.doesNotThrow(() => renderTrajectory(input));
  }
  assert.deepEqual(renderTrajectory(undefined), { text: '', messageCount: 0, truncated: false });
  assert.deepEqual(renderTrajectory([]), { text: '', messageCount: 0, truncated: false });
  // 非法的 options 也不抛错，回落到默认值
  assert.doesNotThrow(() => renderTrajectory([msg('user', [text('hi')])], { maxMessages: -1, maxChars: 'x' }));
  assert.equal(renderTrajectory([msg('user', [text('hi')])], { maxChars: 'x' }).text, '用户: hi');
  // 块字段类型不对：忽略该块而不是抛错
  assert.equal(renderTrajectory([{ role: 'user', content: [{ type: 'text', text: 42 }] }]).text, '用户: ');
});

test('collectTurnTrajectory: 读 agent.session.deriveMessages，缺失或抛错返回 null', () => {
  const agent = { session: { deriveMessages: () => [msg('user', [text('真实轨迹')])] } };
  const out = collectTurnTrajectory(agent);
  assert.equal(out.text, '用户: 真实轨迹');
  assert.equal(out.messageCount, 1);

  assert.equal(collectTurnTrajectory(null), null);
  assert.equal(collectTurnTrajectory({}), null);
  assert.equal(collectTurnTrajectory({ session: {} }), null);
  assert.equal(collectTurnTrajectory({ session: { deriveMessages: 'nope' } }), null);
  // 宿主 API 变动不许把复盘搞崩：抛错只记 warn，返回 null
  const logs = [];
  const boom = { session: { deriveMessages: () => { throw new Error('宿主内部错误'); } } };
  assert.doesNotThrow(() => collectTurnTrajectory(boom, { warn: (m) => logs.push(m) }));
  assert.equal(collectTurnTrajectory(boom, { warn: (m) => logs.push(m) }), null);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].includes('宿主内部错误'));
});

test('buildRecapSummary: 首行计数 + 轨迹标题 + 轨迹正文', () => {
  const trajectory = { text: '用户: 干点什么\n助手: 好', messageCount: 2, truncated: false };
  const s = buildRecapSummary({ mutCount: 12, trajectory });
  assert.equal(s, '自动复盘：本回合有 12 次 mutating 工具调用。\n\n## 本回合轨迹（最近 2 条消息）\n用户: 干点什么\n助手: 好');
  assert.ok(s.split('\n')[0].startsWith('自动复盘：本回合有 12 次 mutating 工具调用。'));
});

test('buildRecapSummary: 轨迹缺失/为空时退化成只有计数那一行', () => {
  const head = '自动复盘：本回合有 3 次 mutating 工具调用。';
  assert.equal(buildRecapSummary({ mutCount: 3 }), head);
  assert.equal(buildRecapSummary({ mutCount: 3, trajectory: null }), head);
  assert.equal(buildRecapSummary({ mutCount: 3, trajectory: { text: '', messageCount: 0 } }), head);
  assert.equal(buildRecapSummary({}), '自动复盘：本回合有 0 次 mutating 工具调用。');
  assert.ok(!buildRecapSummary({ mutCount: 3 }).includes('## 本回合轨迹'));
});

test('lib/trajectory.js 红线：零 import（纯函数、不碰宿主包与磁盘）', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../lib/trajectory.js', import.meta.url));
  const src = await readFile(path, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), '不许有任何 import（含宿主包与 node 内置）');
  assert.ok(!/require\s*\(/.test(src), '不许 require');
  assert.ok(!/\bfs\b\./.test(src), '不读盘');
});
// —— lib/index.js 服务半边：自动复盘喂料的源码级断言 ——
//
// lib/index.js 顶层 import 了宿主包（@deepseek-ai/schemastery、dsh-tools、dsh-llm、dsh-timeout），
// 本仓库无 node_modules，测试里 import 不到。所以和 tests/entries.test.mjs 同款做法：
// 读源码、把 runRecap 那段切出来，钉住「喂真轨迹」这件事不被回退。
const indexSource = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');

/** 从 marker 起截到配平的 '}'，返回那段源码。 */
function sliceBalanced(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'lib/index.js 里应有 ' + marker);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('大括号不配平：' + marker);
}

test('lib/index.js runRecap：从宿主取真轨迹并拼进 summary（不回退成只喂计数）', () => {
  const body = sliceBalanced(indexSource, 'runRecap: async (agent, pending) => {');
  assert.ok(body.includes('collectTurnTrajectory(agent'), '必须从宿主会话取轨迹');
  assert.ok(body.includes('buildRecapSummary({ mutCount: pending.mutCount, trajectory })'),
    'summary 必须由计数 + 轨迹共同构成');
  assert.ok(body.includes('executeRecap({ agent, summary, signal })'), 'executeRecap 只换喂料，不改签名');
  assert.ok(!/summary: '自动复盘：本回合有 ' \+ pending\.mutCount/.test(body),
    '不许回退成只喂「本回合有 N 次 mutating 工具调用」这句计数');
  assert.ok(!body.includes("outcome:"), 'executeRecap 的签名不许在这里被改');
});

test('lib/index.js runRecap：轨迹为空就不调 LLM，只写一条 info 日志', () => {
  const body = sliceBalanced(indexSource, 'runRecap: async (agent, pending) => {');
  const guard = body.indexOf('if (!trajectory || !trajectory.text)');
  assert.notEqual(guard, -1, '必须有「轨迹为空」的守卫');
  const recapCall = body.indexOf('executeRecap({ agent, summary, signal })');
  assert.ok(guard < recapCall, '守卫必须在调 LLM 之前');
  const guardBlock = body.slice(guard, body.indexOf('const summary'));
  assert.ok(/logger\?\.info\?\.\(/.test(guardBlock), '跳过时要写一条 logger.info');
  assert.ok(guardBlock.includes('return'), '跳过时必须直接 return，不进 runMaintenance');
  // 缺陷 2：必须是 {skipped:true} 而不是裸 return —— 调度器靠它把冷却与计数还回去
  assert.ok(/return\s*\{\s*skipped:\s*true\s*\}/.test(guardBlock),
    '空轨迹分支必须返回 {skipped:true}（否则白白吃掉冷却窗口与 mutating 计数）');
  assert.ok(!guardBlock.includes('runMaintenance'), '跳过路径不许跑维护任务');
});

test('lib/index.js：拆门后不再装配 listAgents，inject 也不再声明 agents', () => {
  assert.ok(!indexSource.includes('listAgents'), 'ctx.agents.list() 的装配行必须已删除');
  const injectLine = indexSource.split('\n').find((l) => l.startsWith('export const inject'));
  assert.ok(injectLine, '应有 inject 声明');
  assert.ok(!injectLine.includes("'agents'"), 'inject 不许再声明 agents 服务：' + injectLine);
});
