// dsh-ace 单元测试：系统提示自动注入（C5.3–C5.5）。
// 运行：npm test（node --test tests/）。纯逻辑，不依赖宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, TOKEN_WIDE_WEIGHT, TOKEN_ASCII_WEIGHT, rankInjection, renderInjection, selectInjection, userTextOf, messageKeyOf,
  createInjectionCache, INJECT_MAX_ENTRIES, INJECT_MIN_ENTRIES, INJECT_TOKEN_BUDGET,
} from '../lib/inject.js';

const mk = (id, title, condition, action, meta = {}, rationale = '') => ({
  id, title, condition, action, rationale,
  meta: { created: '2026-01-01', updated: '2026-01-01', hits: 0, lastHit: '', ...meta },
  extraLines: [],
});

test('P1-2｜token 估算按字符类别加权：汉字 1.0、ASCII 0.4（不再把中文低估一倍）', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  // ASCII：5 × 0.4 = 2（浮点累加不能多算 1，见 lib/inject.js 的 round 说明）
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('ab'), 1);
  // 汉字：每个 1 token（旧公式把 4 个汉字算成 2 —— 低估一倍）
  assert.equal(estimateTokens('中文四个'), 4);
  assert.equal(estimateTokens('中文五个字'), 5);
  // 混合：4 个汉字(4) + 'abcd'(1.6) = 5.6 → 6
  assert.equal(estimateTokens('中文四个abcd'), 6);
  // 全角标点按 1.0 计
  assert.equal(estimateTokens('，。'), 2);
});

test('P1-2｜权重常量写死：非 ASCII 1.0 / ASCII 0.4', () => {
  assert.equal(TOKEN_WIDE_WEIGHT, 1);
  assert.equal(TOKEN_ASCII_WEIGHT, 0.4);
});

test('C5.3｜常量与契约一致（5 / 3 / 900）', () => {
  assert.equal(INJECT_MAX_ENTRIES, 5);
  assert.equal(INJECT_MIN_ENTRIES, 3);
  assert.equal(INJECT_TOKEN_BUDGET, 900);
});

// —— 用户第 33 轮 k：注入排序纯 BM25、同分按 id 升序、hits 高低不影响排序 ——

test('k｜注入排序键就是纯 BM25 相关度：分高的排前面，行里不再有净分项', () => {
  // 两条都跟查询沾边，但 ace-010 的正文把查询词重复得更多 → BM25 分更高
  const entries = [
    mk('ace-011', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-010', '先跑基线 基线 基线', '改代码前 基线', '先跑测试 基线'),
  ];
  const { ranked, topScore } = rankInjection(entries, '基线');
  assert.ok(topScore > 0);
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-010', 'ace-011'], 'BM25 分高的排前面');
  assert.ok(ranked[0].score > ranked[1].score);
  // 归一化相关度仍在行里（可观测数据），但排序键只剩 score 本身
  assert.equal(ranked[0].relevance, 1);
  assert.ok(ranked[1].relevance > 0 && ranked[1].relevance < 1);
  assert.equal('key' in ranked[0], false, '排序行里不许再有合成排序键（净分项已删干净）');
});

test('k｜hits 高低不影响注入排序（防自增强陷阱）：hits=999 也压不过相关度', () => {
  const entries = [
    mk('ace-011', '先跑基线', '改代码前', '先跑测试', { hits: 999, lastHit: '2026-10-01' }),
    mk('ace-010', '先跑基线 基线 基线', '改代码前 基线', '先跑测试 基线', { hits: 0, lastHit: '' }),
  ];
  const { ranked } = rankInjection(entries, '基线');
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-010', 'ace-011'], '命中次数多的条目不会因此排前面');
  // 反证：把 hits 对调，顺序一个字都不变（hits 完全不参与排序）
  const flipped = [
    mk('ace-011', '先跑基线', '改代码前', '先跑测试', { hits: 0, lastHit: '' }),
    mk('ace-010', '先跑基线 基线 基线', '改代码前 基线', '先跑测试 基线', { hits: 999, lastHit: '2026-10-01' }),
  ];
  assert.deepEqual(rankInjection(flipped, '基线').ranked.map((x) => x.entry.id), ['ace-010', 'ace-011']);
  // 注入条目的挑选也不看 hits：selectInjection 的 ids 顺序 = ranked 顺序
  const picked = selectInjection(entries, '基线');
  assert.deepEqual(picked.ids, ['ace-010', 'ace-011']);
});

test('C5.3｜没有出局线与考察位：相关条目一律进常规位，返回形状里没有 probation / excluded', () => {
  const entries = [
    mk('ace-001', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-002', '先跑基线', '改代码前', '先跑测试'),
  ];
  const { ranked } = rankInjection(entries, '先跑基线');
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-001', 'ace-002'], '两条都在候选里，没有条目被挡在外面');
  assert.equal('excluded' in ranked, false);
  const picked = selectInjection(entries, '先跑基线');
  assert.deepEqual(picked.ids, ['ace-001', 'ace-002']);
  assert.equal('probation' in picked, false, '考察位整段已删，返回对象里不许再有 probation');
});

test('C5.3｜最高分 <= 0 时不注入任何条目（只留原提示）', () => {
  const entries = [mk('ace-001', '先跑基线', '改代码前', '先跑测试')];
  const none = selectInjection(entries, '完全不相干的关键词');
  assert.equal(none.count, 0);
  assert.equal(none.text, '');
  assert.deepEqual(none.ids, []);
  assert.equal(none.topScore, 0);
  const empty = selectInjection([], '先跑基线');
  assert.equal(empty.count, 0);
  assert.equal(empty.topScore, 0);
});

test('C5.3｜同分按条目 id 数字升序（稳定）', () => {
  // 三条正文完全一样 → BM25 分数一样 → 只能靠 id 数字升序决定
  const entries = [
    mk('ace-030', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-004', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-100', '先跑基线', '改代码前', '先跑测试'),
  ];
  const { ranked } = rankInjection(entries, '先跑基线');
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-004', 'ace-030', 'ace-100']);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[1].score, ranked[2].score);
});

test('C5.4｜5 条上限：候选更多时最多注入 5 条', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, '改代码前', '先跑测试'));
  const picked = selectInjection(entries, '先跑基线');
  assert.equal(picked.count, INJECT_MAX_ENTRIES);
  assert.equal(picked.ids.length, 5);
  assert.equal(picked.ids.length, INJECT_MAX_ENTRIES);
  // maxEntries 可覆盖（给下一阶段设置页留口子）
  assert.equal(selectInjection(entries, '先跑基线', { maxEntries: 2 }).count, 2);
});

test('C5.4｜900 token 预算：累计到约 900 即停，绝不超预算', () => {
  const pad = (n) => '基线对比口径'.repeat(40) + n; // 每条正文约 240 字
  const entries = [1, 2, 3, 4, 5, 6].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, pad(n), pad(n)));
  const picked = selectInjection(entries, '先跑基线');
  assert.ok(picked.count >= 1, '至少注入 1 条');
  assert.ok(picked.count < 6, '长条目不会把 6 条全塞进去');
  assert.equal(picked.tokens, estimateTokens(picked.text));
  assert.ok(picked.tokens <= INJECT_TOKEN_BUDGET, '渲染后整块 token 不得超过预算，实际 ' + picked.tokens);
  // 再多取一条就必然超预算（证明是预算而不是别的原因停下的）
  const { ranked } = rankInjection(entries, '先跑基线');
  const next = ranked.slice(0, picked.count + 1);
  assert.ok(estimateTokens(renderInjection(next)) > INJECT_TOKEN_BUDGET, '再取一条就超预算');
  // 预算可覆盖：中等长度的条目 + 更紧的预算 → 装得下的条数变少。
  // P1-2 之后 token 估算改成按字符类别加权（汉字 1.0），单条 mid 条目实测约 424 token，
  // 所以这里把「更紧的预算」定在 600（仍远低于 900 的默认预算）：
  // 600 装得下 1 条、装不下 2 条（约 769），刚好能证明是预算在起作用。
  // 注意：预算常量本身没放宽（INJECT_TOKEN_BUDGET 仍是 900），这里只是换了一个
  // 落在「装 1 条不装 2 条」区间里的测试预算。
  const mid = (n) => '基线'.repeat(80) + n;
  const medium = [1, 2, 3, 4, 5, 6].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, mid(n), mid(n)));
  const loose = selectInjection(medium, '先跑基线');
  const tight = selectInjection(medium, '先跑基线', { tokenBudget: 600 });
  assert.ok(loose.tokens <= INJECT_TOKEN_BUDGET);
  assert.ok(tight.tokens <= 600);
  assert.equal(loose.count, 2, '默认 900 预算装得下 2 条');
  assert.equal(tight.count, 1, '600 预算只装得下 1 条');
  assert.ok(tight.count < loose.count, '预算收紧后注入条数变少');
});

test('C5.4｜第一条无条件注入：单条就超预算时也注入它（不让机制静默失效）', () => {
  const pad = (n) => '基线对比口径'.repeat(400) + n; // 单条渲染后远超 900 token（约 2400 token）
  const entries = [mk('ace-001', '超长条目', pad('a'), pad('b'))];
  const picked = selectInjection(entries, '先跑基线');
  assert.equal(picked.count, 1, '第一条照常注入');
  assert.ok(picked.tokens > INJECT_TOKEN_BUDGET);
  // 但后续条目不会因为「第一条超了」而继续塞
  const more = [mk('ace-001', '超长条目', pad('a'), pad('b')), mk('ace-002', '超长条目2', pad('c'), pad('d'))];
  assert.equal(selectInjection(more, '先跑基线').count, 1);
});

test('C5.4｜不足 3 条就按实际条数（不硬凑）', () => {
  const one = [mk('ace-001', '先跑基线', '改代码前', '先跑测试')];
  const picked1 = selectInjection(one, '先跑基线');
  assert.equal(picked1.count, 1);
  assert.ok(picked1.text.includes('最相关的 1 条经验'));
  const two = [mk('ace-001', '先跑基线', '改代码前', '先跑测试'), mk('ace-002', '先跑基线', '改代码前', '先跑测试')];
  const picked2 = selectInjection(two, '先跑基线');
  assert.equal(picked2.count, 2);
  assert.ok(picked2.text.includes('最相关的 2 条经验'));
});

test('C5.5｜注入块格式：每条含 id + 标题 + 何时适用 + 怎么做，整体标出「自动注入的 top N 条」并提示 ace_playbook', () => {
  const entries = [
    mk('ace-012', '手册写入必须走锁', '改 lib/playbook.js 的写入路径时', 'withExclusiveLock + writeFileAtomic，禁止裸 fs.writeFile'),
    mk('ace-031', '先跑基线再改', '动手改代码之前', '先 node --test tests/ 记下 pass/fail/skip，再改'),
  ];
  const picked = selectInjection(entries, '先跑基线 手册写入');
  assert.equal(picked.count, 2);
  const lines = picked.text.split('\n');
  assert.ok(lines[0].startsWith('【ACE 自动注入】'), '首行一眼看出是自动注入的 top N 条经验');
  assert.ok(lines[0].includes('2 条经验'));
  assert.ok(lines[0].includes('最多 ' + INJECT_MAX_ENTRIES + ' 条'), '首行的条数上限跟生效的 maxEntries 走：' + lines[0]);
  assert.ok(lines[0].includes('按检索相关度排序'), '排序口径文案：只讲相关度，不再提净分');
  assert.ok(picked.text.includes('[ace-031] 先跑基线再改'), 'id + 标题');
  assert.ok(picked.text.includes('- 何时适用：动手改代码之前'), 'condition');
  assert.ok(picked.text.includes('- 怎么做：先 node --test tests/'), 'action');
  assert.ok(picked.text.includes('ace_playbook'), '提示可用 ace_playbook 查全量');
  assert.ok(lines[lines.length - 1].startsWith('（自动注入'), '末行是收尾提示');
  // 渲染顺序 = 排序顺序
  const order = picked.text.match(/\[ace-\d+\]/g);
  assert.deepEqual(order, picked.ids.map((id) => '[' + id + ']'));
});

test('C5.6｜首行「最多 N 条」说真话：maxEntries 传 8 就写 8，不传才回落默认 5（第 36 轮遗留）', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mk('ace-' + String(n).padStart(3, '0'), '先跑基线 ' + n, '改代码前', '先跑测试'));
  // 生产上的 maxEntries 来自配置 injectMaxEntries（lib/index.js 的 injectMaxEntriesOf）：配置成 8 时，
  // 注入块首行的「最多 N 条」绝不许还写默认的 5 —— 否则文案在说谎。
  const eight = selectInjection(entries, '先跑基线', { maxEntries: 8 });
  assert.equal(eight.count, 8, '上限 8 时 8 条全进');
  assert.ok(eight.text.split('\n')[0].includes('最多 8 条'), '首行必须写最多 8 条：' + eight.text.split('\n')[0]);
  assert.ok(!eight.text.split('\n')[0].includes('最多 5 条'), '首行不许再出现默认的 5');

  const three = selectInjection(entries, '先跑基线', { maxEntries: 3 });
  assert.equal(three.count, 3);
  assert.ok(three.text.split('\n')[0].includes('最多 3 条'), '首行跟上生效上限：' + three.text.split('\n')[0]);

  // 不传 maxEntries → 回落 INJECT_MAX_ENTRIES（老行为一字不改）。
  const fallback = selectInjection(entries, '先跑基线');
  assert.equal(fallback.count, INJECT_MAX_ENTRIES);
  assert.ok(fallback.text.split('\n')[0].includes('最多 ' + INJECT_MAX_ENTRIES + ' 条'), '未传时回落默认：' + fallback.text.split('\n')[0]);

  // 直接调渲染函数（入参是 rankInjection 产出的条目项，形如 { entry, ... }）：
  // 带 rationale 的预算试算那一支也必须把生效上限带上（否则预估文案与实际不一致）。
  const rank = (entry) => ({ entry, i: 0, score: 1 });
  const picked = entries.slice(0, 2).map(rank);
  assert.ok(renderInjection(picked, { maxEntries: 12 }).split('\n')[0].includes('最多 12 条'), '显式传入优先');
  assert.ok(renderInjection(picked).split('\n')[0].includes('最多 ' + INJECT_MAX_ENTRIES + ' 条'), '未传回落默认');
  assert.ok(renderInjection(picked, { maxEntries: 0 }).split('\n')[0].includes('最多 ' + INJECT_MAX_ENTRIES + ' 条'), '非法值回落默认');
  assert.ok(renderInjection(picked, { maxEntries: 'x' }).split('\n')[0].includes('最多 ' + INJECT_MAX_ENTRIES + ' 条'), '非数字回落默认');
});

test('C5.5｜依据（rationale）按预算决定带不带：预算充足时带上，紧张时省略', () => {
  const entries = [mk('ace-001', '先跑基线', '改代码前', '先跑测试', {}, '盲改会返工')];
  const roomy = selectInjection(entries, '先跑基线');
  assert.ok(roomy.text.includes('- 依据：盲改会返工'), '预算充足时带依据');
  const tight = selectInjection(entries, '先跑基线', { tokenBudget: 40 });
  assert.ok(!tight.text.includes('- 依据：'), '带依据会超预算时省掉依据，但条目照常注入');
  assert.ok(tight.text.includes('[ace-001] 先跑基线'));
});

test('C5.1｜userTextOf：从 ContentBlock[] 里只取 text 块', () => {
  assert.equal(userTextOf({ content: [{ type: 'text', text: '你好' }, { type: 'image', data: 'x' }] }), '你好');
  assert.equal(userTextOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(userTextOf({ content: '裸字符串' }), '裸字符串');
  assert.equal(userTextOf('直接给字符串'), '直接给字符串');
  assert.equal(userTextOf({ content: [{ type: 'image', data: 'x' }] }), '');
  assert.equal(userTextOf(null), '');
});

test('C5.7｜messageKeyOf：优先 message.id，退回文本哈希', () => {
  assert.equal(messageKeyOf({ id: 'msg-1', content: [{ type: 'text', text: 'a' }] }), 'id:msg-1');
  const a = messageKeyOf({ content: [{ type: 'text', text: '同一条消息' }] });
  const b = messageKeyOf({ content: [{ type: 'text', text: '同一条消息' }] });
  const c = messageKeyOf({ content: [{ type: 'text', text: '另一条消息' }] });
  assert.ok(a.startsWith('text:'));
  assert.equal(a, b, '同样文本 → 同样缓存键（同一条消息不重复检索）');
  assert.notEqual(a, c);
});

test('C5.7｜createInjectionCache：按 agent 隔离、按消息 key 命中', () => {
  const cache = createInjectionCache();
  const agentA = {};
  const agentB = {};
  assert.equal(cache.get(agentA, 'id:1'), null);
  cache.set(agentA, 'id:1', { text: 'A1', ids: ['ace-001'] });
  assert.deepEqual(cache.get(agentA, 'id:1'), { text: 'A1', ids: ['ace-001'] });
  assert.equal(cache.get(agentA, 'id:2'), null, '不同消息 key 不串');
  assert.equal(cache.get(agentB, 'id:1'), null, '不同 agent 不串');
  assert.deepEqual(cache.get(agentA), { text: 'A1', ids: ['ace-001'] }, 'key 省略时返回最近一次结果');
  cache.set(agentA, 'id:2', { text: 'A2', ids: [] });
  assert.deepEqual(cache.get(agentA), { text: 'A2', ids: [] });
  assert.deepEqual(cache.get(agentA, 'id:1'), null, '同一 agent 只保留最近一条');
  cache.clear(agentA);
  assert.equal(cache.get(agentA), null);
  assert.equal(cache.get(null, 'id:1'), null, 'agent 非对象时安全返回 null');
});
