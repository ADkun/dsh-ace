// dsh-ace 单元测试：系统提示自动注入（C5.3–C5.5）。
// 运行：npm test（node --test tests/）。纯逻辑，不依赖宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, TOKEN_WIDE_WEIGHT, TOKEN_ASCII_WEIGHT, rankInjection, renderInjection, selectInjection, userTextOf, messageKeyOf,
  createInjectionCache, createInjectedIds, INJECT_MAX_ENTRIES, INJECT_MIN_ENTRIES, INJECT_TOKEN_BUDGET,
  injectScoreFloor, INJECT_MIN_SCORE_IDF_RATIO, INJECT_MIN_RELATIVE_TO_TOP,
} from '../lib/inject.js';

const mk = (id, title, condition, action, meta = {}, rationale = '') => ({
  id, title, condition, action, rationale,
  meta: { created: '2026-01-01', updated: '2026-01-01', hits: 0, lastHit: '', ...meta },
  extraLines: [],
});

// 绝对门槛（4.0 × IDF_MAX）另有一组专门用例（文件末尾「自动注入相关性门槛」）。
// 其余用例钉的是门槛以外的行为，统一把两边门槛都关掉（0 = 关），
// 这样候选层只保留历史语义「score > 0」——断言语义一个字都不变。
const GATE_OFF = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };

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

test('C5.3｜常量与契约一致（5 / 3 / 500）', () => {
  assert.equal(INJECT_MAX_ENTRIES, 5);
  assert.equal(INJECT_MIN_ENTRIES, 3);
  assert.equal(INJECT_TOKEN_BUDGET, 500);
});

// —— 用户第 33 轮 k：注入排序纯 BM25、同分按 id 升序、hits 高低不影响排序 ——

test('k｜注入排序键就是纯 BM25 相关度：分高的排前面，行里不再有净分项', () => {
  // 两条都跟查询沾边，但 ace-010 的正文把查询词重复得更多 → BM25 分更高
  const entries = [
    mk('ace-011', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-010', '先跑基线 基线 基线', '改代码前 基线', '先跑测试 基线'),
  ];
  const { ranked, topScore } = rankInjection(entries, '基线', GATE_OFF);
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
  const { ranked } = rankInjection(entries, '基线', GATE_OFF);
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-010', 'ace-011'], '命中次数多的条目不会因此排前面');
  // 反证：把 hits 对调，顺序一个字都不变（hits 完全不参与排序）
  const flipped = [
    mk('ace-011', '先跑基线', '改代码前', '先跑测试', { hits: 0, lastHit: '' }),
    mk('ace-010', '先跑基线 基线 基线', '改代码前 基线', '先跑测试 基线', { hits: 999, lastHit: '2026-10-01' }),
  ];
  assert.deepEqual(rankInjection(flipped, '基线', GATE_OFF).ranked.map((x) => x.entry.id), ['ace-010', 'ace-011']);
  // 注入条目的挑选也不看 hits：selectInjection 的 ids 顺序 = ranked 顺序
  const picked = selectInjection(entries, '基线', GATE_OFF);
  assert.deepEqual(picked.ids, ['ace-010', 'ace-011']);
});

test('C5.3｜没有出局线与考察位：相关条目一律进常规位，返回形状里没有 probation / excluded', () => {
  const entries = [
    mk('ace-001', '先跑基线', '改代码前', '先跑测试'),
    mk('ace-002', '先跑基线', '改代码前', '先跑测试'),
  ];
  const { ranked } = rankInjection(entries, '先跑基线', GATE_OFF);
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-001', 'ace-002'], '两条都在候选里，没有条目被挡在外面');
  assert.equal('excluded' in ranked, false);
  const picked = selectInjection(entries, '先跑基线', GATE_OFF);
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
  const { ranked } = rankInjection(entries, '先跑基线', GATE_OFF);
  assert.deepEqual(ranked.map((x) => x.entry.id), ['ace-004', 'ace-030', 'ace-100']);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[1].score, ranked[2].score);
});

test('C5.4｜5 条上限：候选更多时最多注入 5 条', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, '改代码前', '先跑测试'));
  const picked = selectInjection(entries, '先跑基线', GATE_OFF);
  assert.equal(picked.count, INJECT_MAX_ENTRIES);
  assert.equal(picked.ids.length, 5);
  assert.equal(picked.ids.length, INJECT_MAX_ENTRIES);
  // maxEntries 可覆盖（给下一阶段设置页留口子）
  assert.equal(selectInjection(entries, '先跑基线', { ...GATE_OFF, maxEntries: 2 }).count, 2);
});

test('C5.4｜500 token 预算：累计到约 500 即停，绝不超预算', () => {
  const pad = (n) => '基线对比口径'.repeat(10) + n; // 每条正文约 60 字（500 预算下：单条放得下、两条超预算）
  const entries = [1, 2, 3, 4, 5, 6].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, pad(n), pad(n)));
  const picked = selectInjection(entries, '先跑基线', GATE_OFF);
  assert.ok(picked.count >= 1, '至少注入 1 条');
  assert.ok(picked.count < 6, '长条目不会把 6 条全塞进去');
  assert.equal(picked.tokens, estimateTokens(picked.text));
  assert.ok(picked.tokens <= INJECT_TOKEN_BUDGET, '渲染后整块 token 不得超过预算，实际 ' + picked.tokens);
  // 再多取一条就必然超预算（证明是预算而不是别的原因停下的）
  const { ranked } = rankInjection(entries, '先跑基线', GATE_OFF);
  const next = ranked.slice(0, picked.count + 1);
  assert.ok(estimateTokens(renderInjection(next)) > INJECT_TOKEN_BUDGET, '再取一条就超预算');
  // 预算可覆盖：这条用**显式** tokenBudget 验证「预算可覆盖」的行为，不受默认常量下调影响。
  // 单条 mid 条目实测约 424 token：900 装 2 条、600 装 1 条，刚好落在「装 1 不装 2」区间。
  const mid = (n) => '基线'.repeat(80) + n;
  const medium = [1, 2, 3, 4, 5, 6].map((n) => mk('ace-0' + n + '0', '先跑基线' + n, mid(n), mid(n)));
  const loose = selectInjection(medium, '先跑基线', { ...GATE_OFF, tokenBudget: 900 });
  const tight = selectInjection(medium, '先跑基线', { ...GATE_OFF, tokenBudget: 600 });
  assert.ok(loose.tokens <= 900);
  assert.ok(tight.tokens <= 600);
  assert.equal(loose.count, 2, '900 预算装得下 2 条');
  assert.equal(tight.count, 1, '600 预算只装得下 1 条');
  assert.ok(tight.count < loose.count, '预算收紧后注入条数变少');
});

test('C5.4｜预算再紧也注入第一条：前提是候选层已经过门槛，走得到这里的第一条必然合格', () => {
  const pad = (n) => '基线对比口径'.repeat(400) + n; // 单条渲染后远超 900 token（约 2400 token）
  const entries = [mk('ace-001', '超长条目', pad('a'), pad('b'))];
  const picked = selectInjection(entries, '先跑基线', GATE_OFF);
  assert.equal(picked.count, 1, '第一条照常注入');
  assert.ok(picked.tokens > INJECT_TOKEN_BUDGET);
  // 但后续条目不会因为「第一条超了」而继续塞
  const more = [mk('ace-001', '超长条目', pad('a'), pad('b')), mk('ace-002', '超长条目2', pad('c'), pad('d'))];
  assert.equal(selectInjection(more, '先跑基线', GATE_OFF).count, 1);
});

test('C5.4｜门槛挡空时「第一条无条件注入」不适用：整轮 0 条（门槛比预算更靠前）', () => {
  // 预算再宽也救不回被门槛挡掉的候选：selectInjection 在 rankInjection 之后就把空候选短路了。
  const pad = (n) => '基线对比口径'.repeat(400) + n;
  const entries = [mk('ace-001', '完全不沾边的条目标题', pad('a'), pad('b'))];
  const blind = selectInjection(entries, '量子色动力学', { tokenBudget: 8000 });
  assert.equal(blind.count, 0, '分数不到门槛 → 预算再大也是 0 条');
  assert.equal(blind.text, '');
});

test('C5.4｜不足 3 条就按实际条数（不硬凑）', () => {
  const one = [mk('ace-001', '先跑基线', '改代码前', '先跑测试')];
  const picked1 = selectInjection(one, '先跑基线', GATE_OFF);
  assert.equal(picked1.count, 1);
  assert.ok(picked1.text.includes('最相关的 1 条经验'));
  const two = [mk('ace-001', '先跑基线', '改代码前', '先跑测试'), mk('ace-002', '先跑基线', '改代码前', '先跑测试')];
  const picked2 = selectInjection(two, '先跑基线', GATE_OFF);
  assert.equal(picked2.count, 2);
  assert.ok(picked2.text.includes('最相关的 2 条经验'));
});

test('C5.5｜注入块格式：每条含 id + 标题 + 何时适用 + 怎么做，整体标出「自动注入的 top N 条」并提示 ace_playbook', () => {
  const entries = [
    mk('ace-012', '手册写入必须走锁', '改 lib/playbook.js 的写入路径时', 'withExclusiveLock + writeFileAtomic，禁止裸 fs.writeFile'),
    mk('ace-031', '先跑基线再改', '动手改代码之前', '先 node --test tests/ 记下 pass/fail/skip，再改'),
  ];
  const picked = selectInjection(entries, '先跑基线 手册写入', GATE_OFF);
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
  assert.equal(lines[lines.length - 1], '（自动注入；全量手册用 ace_playbook 查）', '末行是新文案（B2）');
  // 渲染顺序 = 排序顺序
  const order = picked.text.match(/\[ace-\d+\]/g);
  assert.deepEqual(order, picked.ids.map((id) => '[' + id + ']'));
});

test('C5.6｜首行「最多 N 条」说真话：maxEntries 传 8 就写 8，不传才回落默认 5（第 36 轮遗留）', () => {
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mk('ace-' + String(n).padStart(3, '0'), '先跑基线 ' + n, '改代码前', '先跑测试'));
  // 生产上的 maxEntries 来自配置 injectMaxEntries（lib/index.js 的 injectMaxEntriesOf）：配置成 8 时，
  // 注入块首行的「最多 N 条」绝不许还写默认的 5 —— 否则文案在说谎。
  const eight = selectInjection(entries, '先跑基线', { ...GATE_OFF, maxEntries: 8 });
  assert.equal(eight.count, 8, '上限 8 时 8 条全进');
  assert.ok(eight.text.split('\n')[0].includes('最多 8 条'), '首行必须写最多 8 条：' + eight.text.split('\n')[0]);
  assert.ok(!eight.text.split('\n')[0].includes('最多 5 条'), '首行不许再出现默认的 5');

  const three = selectInjection(entries, '先跑基线', { ...GATE_OFF, maxEntries: 3 });
  assert.equal(three.count, 3);
  assert.ok(three.text.split('\n')[0].includes('最多 3 条'), '首行跟上生效上限：' + three.text.split('\n')[0]);

  // 不传 maxEntries → 回落 INJECT_MAX_ENTRIES（老行为一字不改）。
  const fallback = selectInjection(entries, '先跑基线', GATE_OFF);
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

test('B1｜默认不带「依据」；显式 options.withRationale===true 才带，超预算再省掉', () => {
  const entries = [mk('ace-001', '先跑基线', '改代码前', '先跑测试', {}, '盲改会返工')];
  const plain = selectInjection(entries, '先跑基线', GATE_OFF);
  assert.ok(!plain.text.includes('- 依据：'), '默认不带依据（B1）');
  const roomy = selectInjection(entries, '先跑基线', { ...GATE_OFF, withRationale: true });
  assert.ok(roomy.text.includes('- 依据：盲改会返工'), '显式开才带依据');
  const tight = selectInjection(entries, '先跑基线', { ...GATE_OFF, withRationale: true, tokenBudget: 40 });
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

test('B3｜createInjectedIds：按 agent 记录已注入 id，有上限 FIFO，agent 非对象安全', () => {
  const ids = createInjectedIds({ maxPerAgent: 3 });
  const a = {};
  const b = {};
  assert.equal(ids.has(a, 'ace-001'), false, '初始没有');
  ids.record(a, ['ace-001', 'ace-002']);
  assert.equal(ids.has(a, 'ace-001'), true);
  assert.equal(ids.size(a), 2);
  assert.equal(ids.has(b, 'ace-001'), false, 'agent 之间不串');
  ids.record(a, ['ace-003', 'ace-004']); // 超上限 3 → 最老的 ace-001 被挤掉
  assert.equal(ids.size(a), 3);
  assert.equal(ids.has(a, 'ace-001'), false, 'FIFO 淘汰最老 id');
  assert.equal(ids.has(a, 'ace-004'), true);
  ids.clear(a);
  assert.equal(ids.size(a), 0, 'clear 清空');
  assert.doesNotThrow(() => ids.record(null, ['x']));
  assert.equal(ids.has(null, 'x'), false, 'agent 非对象安全');
});

// —— 自动注入相关性门槛（绝对 4.0×IDF_MAX + 每条至少 top1 的 0.6 倍）——
// 来历：60 回合真实评测集（18 个空真值回合 + 42 个正例回合）实测，
// 这一档把空回合的误注入从 2.61 条/回合压到 0.00、18/18 回合被注入压到 0/18，
// 同时真值召回仍有 87%、正例覆盖率 100%（REPORT.md）。
// 下面三条只用内存条目，不依赖生产手册。

const filler = (id) => mk(id, '插件改动后先跑全量测试', '改完 lib 里的代码之后', 'node --test tests/ 记下用例数再提交');
const fillers = (n, prefix) => Array.from({ length: n }, (_, i) => filler(prefix + String(i + 1).padStart(3, '0')));

test('C5.8｜门槛算在活跃条目数上：IDF_MAX = log((N-1+0.5)/(1+0.5)+1)，floor = 4.0 × IDF_MAX', () => {
  assert.equal(INJECT_MIN_SCORE_IDF_RATIO, 4);
  assert.equal(INJECT_MIN_RELATIVE_TO_TOP, 0.6);
  // 与 lib/playbook.js 的 N 同口径：N = 活跃条目数
  assert.equal(injectScoreFloor(0), 0, '空手册没有门槛可言（N=0 直接短路，公式不适用）');
  const expected = (n) => 4 * Math.log((n - 1 + 0.5) / (1 + 0.5) + 1);
  for (const n of [1, 2, 5, 100, 150]) {
    assert.ok(Math.abs(injectScoreFloor(n) - expected(n)) < 1e-9, 'N=' + n + ' 的 floor 必须等于 4×IDF_MAX');
  }
  assert.ok(injectScoreFloor(150) > injectScoreFloor(100), '门槛随条目数变严（N 越大 IDF_MAX 越大）');
});

test('C5.8｜零任务意图的回合注入 0 条：手册里没有对应经验时，宁可不注入也不硬凑 N 条', () => {
  // 97 条 filler（保证 N=100，门槛量级与生产手册一致）+ 3 条只在字面上偶尔撞词的条目
  const entries = [
    ...fillers(97, 'ace-'),
    mk('ace-901', '最近一次复盘漏了触发条件', '写复盘条目时', '把触发条件写成能复现的场景'),
    mk('ace-902', '感觉不可靠时先查日志', '排查失败原因时', '先看一行日志再猜'),
    mk('ace-903', '有点多在预算里挤一挤', '注入预算紧张时', '先砍依据再砍条数'),
  ];
  const query = '早上好呀，今天感觉怎么样，最近是不是有点累';
  // 先证明「0 条」不是因为夹具根本没分数：关掉门槛时这 3 条确实进得来
  const open = selectInjection(entries, query, { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 });
  assert.equal(open.count, 3, '关掉门槛时 3 条零任务意图条目会被误注入（这就是要治的病）');
  // 打开门槛（用默认档）→ 一条都不注入
  const gated = selectInjection(entries, query);
  assert.equal(gated.count, 0, '手册里没有相关经验时，这一回合必须注入 0 条');
  assert.equal(gated.text, '', '不注入就是空串，原提示一个字不改');
  assert.deepEqual(gated.ids, []);
  assert.equal(gated.tokens, 0);
});

test('C5.8｜热度只能改顺序、不能把门槛以下的条目顶进候选（门槛必须作用在热度加权之前）', () => {
  const entries = [
    ...fillers(98, 'ace-2'),
    mk('ace-700', '先跑基线再改代码 先跑基线 基线', '动手改代码之前 先跑基线', '先 node --test tests/ 记下 pass fail 再改代码'),
    mk('ace-701', '基线口径偶尔核对', '偶尔想起来时', '看一眼历史记录'),
    mk('ace-703', '基线核对口径', '想起来时', '看一眼历史'),
  ];
  const query = '先跑基线再改代码';
  const hot = new Map([['ace-701', 999], ['ace-703', 0]]);
  const off = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };
  // 先证明 heat 在这个夹具上真的有效：关门槛时 heat 把同量级的 ace-701 顶到 ace-703 前面
  const cold = rankInjection(entries, query, off);
  const warm = rankInjection(entries, query, { ...off, heat: hot });
  const rankOf = (res, id) => res.ranked.findIndex((x) => x.entry.id === id);
  assert.ok(rankOf(cold, 'ace-703') < rankOf(cold, 'ace-701'), '不传 heat 时 ace-703 排在 ace-701 前面（原始相关度）');
  assert.ok(rankOf(warm, 'ace-701') < rankOf(warm, 'ace-703'), '传入 heat 后 ace-701 被顶到 ace-703 前面 —— heat 确实在改顺序');
  // 开门槛（默认档）：ace-701 / ace-703 都被候选层挡掉，heat 再高也进不来
  const gated = selectInjection(entries, query, { heat: hot });
  assert.deepEqual(gated.ids, ['ace-700'], '门槛以下的条目不许因为热度复活');
  assert.ok(!gated.text.includes('ace-701'));
  assert.ok(!gated.text.includes('ace-703'));
  const gatedRank = rankInjection(entries, query, { heat: hot });
  assert.deepEqual(gatedRank.ranked.map((x) => x.entry.id), ['ace-700'], '候选层已过滤，热度只能在合格候选之间调顺序');
  assert.equal(gatedRank.ranked[0].relevance, 1);
  // 拿掉 heat 结论不变：ace-701/ace-703 是被门槛挡的，不是被热度挤掉的
  assert.deepEqual(selectInjection(entries, query).ids, ['ace-700']);
});

test('C5.8｜同一条 query 在 N=100 与 N=150 的条目集上门槛不同：IDF_MAX 随条目数变大', () => {
  // filler 用互不相同的汉字，长度可比：否则长度归一化会同向缩放两组，跨不过门槛的缝。
  const query = '先跑基线再改代码';
  const pool = [];
  for (let i = 0; i < 3000; i += 1) {
    const ch = String.fromCharCode(0x4e00 + i);
    if (!query.includes(ch)) pool.push(ch);
  }
  const diverse = (k) => pool.slice(0, k + 1).join('');
  const base = (n) => Array.from({ length: n }, (_, i) => mk('ace-b' + i, diverse(10), 'zz', 'ww'));
  const candidate = mk('ace-500', '先跑基线再改代码' + diverse(20), '什', '么');
  const additions = Array.from({ length: 50 }, (_, i) => mk('ace-e' + i, diverse(2), 'qq', 'rr'));
  const n100 = [candidate, ...base(99)];
  const n150 = [candidate, ...base(99), ...additions];
  assert.equal(n100.length, 100);
  assert.equal(n150.length, 150);
  // 同一个候选、同一条 query：关门槛时两组都选得出它（证明差别来自门槛，不是候选不存在）
  const off = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };
  assert.equal(selectInjection(n100, query, off).count, 1);
  assert.equal(selectInjection(n150, query, off).count, 1);
  // 开默认门槛：N=100 过、N=150 被挡 → 同一条经验在小手册里算相关，在大手册里不够格
  assert.equal(selectInjection(n100, query).count, 1, 'N=100（floor=' + injectScoreFloor(100).toFixed(3) + '）这条经验过门槛');
  assert.equal(selectInjection(n150, query).count, 0, 'N=150（floor=' + injectScoreFloor(150).toFixed(3) + '）同一分数已不到门槛');
  assert.ok(injectScoreFloor(150) > injectScoreFloor(100), '两档门槛确实不同');
});

