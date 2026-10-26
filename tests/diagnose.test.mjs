// dsh-ace 行为测试：只读体检脚本 tools/diagnose.mjs（第 37 轮任务 A）。
//
// 为什么单开文件：这个脚本是**给调度者诊断用**的旁路工具（零 LLM / 零写盘 / 只读），
// 不进设置页、不进插件运行时，但它的判据（近重复阈值 0.5、僵尸 60 天、过短 80 字符、
// 近 30 天、容量读数）必须跟生产口径同源，否则体检结论会悄悄漂移。
// 这里用**真实临时手册 + 真实归档文件 + 真实设置文件**真跑诊断代码路径（不 mock 内部函数），
// 钉住五组判据的阈值边界、以及「读不到也要给人话、不许崩栈」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serializePlaybook } from '../lib/playbook.js';
import { serializeArchiveFile, markArchived, initialArchiveHeader } from '../lib/archive-file.js';
import {
  NEAR_DUP_RATIO,
  ZOMBIE_STALE_DAYS,
  SKELETON_BODY_CHARS,
  RECENT_DAYS,
  TOP_N,
  dayOf,
  daysBetween,
  bodyChars,
  symmetricRatios,
  nearDuplicatePairs,
  bestMatchPairs,
  zombieEntries,
  skeletonEntries,
  recentAdds,
  recentArchived,
  readMaxEntries,
  diagnose,
  renderReport,
  parseArgs,
  localDayString,
  main,
} from '../tools/diagnose.mjs';

const TODAY = '2026-06-13';
const dayBefore = (n) => {
  const t = Date.parse(TODAY + 'T00:00:00Z') - n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
};
const stamp = (day) => day + 'T09:00:00.000+08:00';

/** 造一条活跃条目（字段与 lib/playbook.js 的 parsePlaybook 产出一致）。 */
const E = (id, title, action, meta = {}, extra = {}) => ({
  id,
  title,
  condition: extra.condition === undefined ? '条件-' + id : extra.condition,
  action,
  rationale: extra.rationale === undefined ? '' : extra.rationale,
  meta: { created: stamp(TODAY), updated: stamp(TODAY), hits: 1, lastHit: '', ...meta },
  extraLines: [],
});

// 近重复对一号：两句讲同一件事（比率落在 0.5 ~ 0.75 之间 —— 正好钉住「阈值是 0.5 不是 0.75」）
const DUP_A = E('ace-001', '批量改名前先列调用点', '先用 grep 列出该符号的全部调用点再执行重命名');
const DUP_B = E('ace-002', '批量重命名要核对调用点', '先用 grep 列出该符号的全部调用点再执行重命名，改完再 grep 一次复核');
// 近重复对二号：正文一模一样（比率必然接近 1）
const TWIN_A = E('ace-003', '接口超时先看日志再重试', '先翻服务端日志确认是超时还是业务报错，再决定重试还是改代码');
const TWIN_B = E('ace-004', '接口超时先看日志再重试', '先翻服务端日志确认是超时还是业务报错，再决定重试还是改代码');
// 完全不相干的一条（不该出现在近重复清单里）
const LONER = E('ace-005', '数据库迁移前先备份', '先把全量快照导出到临时目录再跑迁移脚本，失败立刻回滚', {}, {
  condition: '要改表结构时',
});

async function makeDir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-diagnose-' + tag + '-'));
}

async function writePlaybook(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializePlaybook({ header: ['# ACE 操作手册', ''], entries }), 'utf8');
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** 直接抓 stdout（main 只往 stdout 写）。 */
async function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

// —— 判据常量：跟生产口径同源 ——

test('A0｜判据常量：近重复 0.5（= MERGE_THRESHOLD_RATIO）、僵尸 60 天、过短 80 字符、近 30 天、top 5', () => {
  assert.equal(NEAR_DUP_RATIO, 0.5, '近重复阈值必须跟生产合并阈值同口径（0.5）');
  assert.equal(ZOMBIE_STALE_DAYS, 60);
  assert.equal(SKELETON_BODY_CHARS, 80);
  assert.equal(RECENT_DAYS, 30);
  assert.equal(TOP_N, 5);
});

test('A0｜日期工具：dayOf 取毫秒时间戳的日期部分、daysBetween 算天数、认不出来返回 null', () => {
  assert.equal(dayOf('2026-06-01T09:00:00.000+08:00'), '2026-06-01');
  assert.equal(dayOf('2026-06-01'), '2026-06-01');
  assert.equal(dayOf(''), '');
  assert.equal(dayOf(undefined), '');
  assert.equal(dayOf('6/1/2026'), '');
  assert.equal(daysBetween(TODAY, dayBefore(61)), 61);
  assert.equal(daysBetween(TODAY, TODAY), 0);
  assert.equal(daysBetween('not-a-day', TODAY), null);
});

test('A0｜bodyChars 只数 condition+action+rationale（标题不算）', () => {
  const entry = E('ace-001', '标题很长很长很长很长很长很长', '做法', { }, { condition: '条件', rationale: '依据' });
  assert.equal(bodyChars(entry), '条件'.length + '做法'.length + '依据'.length);
});

// —— ① 近重复配对 ——

test('A1｜近重复配对：对称 BM25 比率 >= 0.5 的对都算，且 0.5~0.75 之间的那一对也算（阈值不是 0.75）', () => {
  const entries = [DUP_A, DUP_B, TWIN_A, TWIN_B, LONER];
  const pairs = nearDuplicatePairs(entries);
  const key = (p) => [p.aId, p.bId].sort().join('~');
  const keys = pairs.map(key);
  assert.ok(keys.includes('ace-001~ace-002'), '讲同一件事的两条必须被抓到：' + JSON.stringify(pairs.map((p) => [key(p), p.ratio])));
  assert.ok(keys.includes('ace-003~ace-004'), '正文一模一样的两条必须被抓到');
  assert.ok(!keys.some((k) => k.includes('ace-005')), '不相干的那条不许被凑成对');
  const medium = pairs.find((p) => key(p) === 'ace-001~ace-002');
  assert.ok(medium.ratio >= 0.5, '比率落在阈值之上：' + medium.ratio);
  assert.ok(medium.ratio < 0.75, '这一对故意卡在 0.5~0.75 之间（0.75 的轻量合并阈值抓不到它）：' + medium.ratio);
  assert.ok(pairs.every((p, i) => i === 0 || pairs[i - 1].ratio >= p.ratio), '结果按比率降序');
  for (const p of pairs) assert.ok(p.aTitle && p.bTitle, '每一对都要带标题，报告才好读');
});

test('A1｜对称比率是对称的：正反两次算出来的比率一致，且不相干的一对低于阈值', () => {
  const forward = symmetricRatios([DUP_A, DUP_B]).find((p) => p.aId === 'ace-001' && p.bId === 'ace-002');
  const backward = symmetricRatios([DUP_B, DUP_A]).find((p) => p.aId === 'ace-002' && p.bId === 'ace-001');
  assert.ok(forward && backward, '两个方向都要给出这一对');
  assert.ok(Math.abs(forward.ratio - backward.ratio) < 1e-12, '对称比率跟条目顺序无关：' + forward.ratio + ' vs ' + backward.ratio);
  const lonely = symmetricRatios([DUP_A, LONER]);
  assert.ok(!lonely.length || lonely[0].ratio < NEAR_DUP_RATIO, '不相干的两条不该过 0.5：' + JSON.stringify(lonely));
});

test('A1｜交叉校验：bestMatchPairs 复用 computeMergeSuggestions 的口径，给出的每对都必须过阈值', () => {
  const entries = [DUP_A, DUP_B, TWIN_A, TWIN_B, LONER];
  const cross = bestMatchPairs(entries);
  assert.ok(cross.length >= 1, '至少给出正文一模一样的那一对：' + JSON.stringify(cross));
  for (const pair of cross) {
    assert.notEqual(pair.aId, pair.bId, '不许自己跟自己配对');
    assert.ok(pair.ratio >= NEAR_DUP_RATIO, '越过阈值的才返回：' + pair.ratio);
  }
});

test('A1｜空手册/只有一条：不给配对，不崩', () => {
  assert.deepEqual(nearDuplicatePairs([]), []);
  assert.deepEqual(nearDuplicatePairs([DUP_A]), []);
  assert.deepEqual(symmetricRatios([]), []);
  assert.deepEqual(bestMatchPairs([DUP_A]), []);
});

// —— ② 僵尸条目 ——

test('A2｜僵尸条目：hits===0 与 lastHit 距今 >= 60 天都算；59 天、最近命中过的都不算', () => {
  const entries = [
    E('ace-001', '从没被命中过', '做法一', { hits: 0 }),
    E('ace-002', '六十一天没命中', '做法二', { hits: 5, lastHit: stamp(dayBefore(61)) }),
    E('ace-003', '正好六十天', '做法三', { hits: 5, lastHit: stamp(dayBefore(60)) }),
    E('ace-004', '五十九天', '做法四', { hits: 5, lastHit: stamp(dayBefore(59)) }),
    E('ace-005', '昨天刚命中', '做法五', { hits: 5, lastHit: stamp(dayBefore(1)) }),
  ];
  const zombies = zombieEntries(entries, TODAY);
  assert.deepEqual(zombies.map((z) => z.id), ['ace-001', 'ace-002', 'ace-003'],
    'hits=0 与 >= 60 天的三条都要抓；59 天的、昨天命中的不许抓：' + JSON.stringify(zombies.map((z) => [z.id, z.hits, z.ageDays, z.stale])));
  const sixty = zombies.find((z) => z.id === 'ace-003');
  assert.equal(sixty.ageDays, 60, '边界值 60 天算僵尸');
  assert.equal(sixty.stale, true);
  assert.equal(zombies.find((z) => z.id === 'ace-001').hits, 0, 'hits=0 即使 lastHit 是空串也照抓');
});

test('A2｜lastHit 认不出日期时只按 hits 判，且不会因为 NaN 误判成僵尸', () => {
  const entries = [
    E('ace-001', '坏时间戳但有命中', '做法一', { hits: 9, lastHit: '上周三' }),
    E('ace-002', '坏时间戳且零命中', '做法二', { hits: 0, lastHit: '上周三' }),
  ];
  const zombies = zombieEntries(entries, TODAY);
  assert.deepEqual(zombies.map((z) => z.id), ['ace-002'], '只有 hits=0 那条算僵尸');
  assert.equal(zombies[0].ageDays, null, '算不出天数就给 null，不是 NaN');
});

// —— ③ 正文过短 ——

test('A3｜正文过短：condition+action+rationale 合计 < 80 才算，恰好 80 的放过', () => {
  const short = E('ace-001', '很短', '很短的做法');
  const exact = E('ace-002', '凑满八十', 'x'.repeat(SKELETON_BODY_CHARS - '条件-ace-002'.length));
  const long = E('ace-003', '够长', 'y'.repeat(200));
  assert.equal(bodyChars(exact), SKELETON_BODY_CHARS, '构造的这条正好 80 字符');
  const skeletons = skeletonEntries([short, exact, long]);
  assert.deepEqual(skeletons.map((s) => s.id), ['ace-001'], '只有 < 80 的算过短：' + JSON.stringify(skeletons));
  assert.equal(skeletons[0].chars, bodyChars(short));

  // 上面三条是按常量自适应的（常量一改就跟着改，钉不住字面值）。这里再钉三条**写死长度**的：
  // 79 / 80 / 81 字符，只有 79 那条算过短 —— 常量被改成 120 或 60 时，这条立刻红。
  const pad = (id, n) => ({ ...E(id, 't-' + id, ''), condition: 'c'.repeat(n), action: '', rationale: '' });
  const fixed = skeletonEntries([pad('ace-101', 79), pad('ace-102', 80), pad('ace-103', 81)]);
  assert.deepEqual(fixed.map((s) => s.id), ['ace-101'], '写死的 79/80/81：只有 79 算过短（阈值字面值就是 80）：' + JSON.stringify(fixed));
});

// —— ④ 近 30 天 ——

test('A4｜近 30 天新增：created 在 30 天内才算，31 天前的、未来时间的都不算', () => {
  const entries = [
    E('ace-001', '今天建的', '做法一', { created: stamp(TODAY) }),
    E('ace-002', '三十天前建的', '做法二', { created: stamp(dayBefore(30)) }),
    E('ace-003', '三十一天前建的', '做法三', { created: stamp(dayBefore(31)) }),
    E('ace-004', '未来时间', '做法四', { created: stamp(dayBefore(-3)) }),
  ];
  const adds = recentAdds(entries, TODAY);
  assert.deepEqual(adds.map((a) => a.id).sort(), ['ace-001', 'ace-002'], '边界 30 天算近期，31 天与未来不算：' + JSON.stringify(adds));
});

test('A4｜近 30 天归档：按四个原因分列，未标原因的单列，超期的与坏日期的都不计', () => {
  const rows = [
    markArchived(E('ace-001', '被取代', '做法一'), { reason: 'superseded', date: TODAY }),
    markArchived(E('ace-002', '被淘汰', '做法二'), { reason: 'evicted', date: dayBefore(10) }),
    markArchived(E('ace-003', '被合并', '做法三'), { reason: 'merged', date: dayBefore(29), supersededBy: 'ace-009' }),
    markArchived(E('ace-004', '应要求移除', '做法四'), { reason: 'removed-by-request', date: dayBefore(31) }),
    markArchived(E('ace-005', '坏日期', '做法五'), { reason: 'merged', date: '不知道' }),
  ];
  const out = recentArchived(rows, TODAY);
  assert.equal(out.total, 3, '只数 30 天内的三条：' + JSON.stringify(out));
  assert.deepEqual(out.buckets.superseded.map((r) => r.id), ['ace-001']);
  assert.deepEqual(out.buckets.evicted.map((r) => r.id), ['ace-002']);
  assert.deepEqual(out.buckets.merged.map((r) => r.id), ['ace-003']);
  assert.deepEqual(out.buckets['removed-by-request'], [], '31 天前的不计');
});

// —— ⑤ 容量 ——

test('A5｜容量：能从设置文件读到 maxEntries 就用它', async () => {
  const dir = await makeDir('settings-ok');
  const settingsFile = path.join(dir, 'dsh-ace.json');
  await fs.writeFile(settingsFile, JSON.stringify({ maxEntries: 42, autoReflect: true }), 'utf8');
  const cap = readMaxEntries(settingsFile);
  assert.equal(cap.read, true);
  assert.equal(cap.maxEntries, 42);
  assert.equal(cap.note, '', '读到了就不该有降级说明');
  await cleanup(dir);
});

test('A5｜容量：文件不存在 / 不是合法 JSON / 值非法 都回落默认 100 并给一句人话', async () => {
  const dir = await makeDir('settings-bad');
  const missing = path.join(dir, 'nope.json');
  const broken = path.join(dir, 'broken.json');
  const weird = path.join(dir, 'weird.json');
  await fs.writeFile(broken, '{ not json', 'utf8');
  await fs.writeFile(weird, JSON.stringify({ maxEntries: '一百' }), 'utf8');

  const a = readMaxEntries(missing);
  assert.equal(a.maxEntries, 100);
  assert.equal(a.read, false);
  assert.ok(a.note.includes('读不到'), '必须明说读不到：' + a.note);
  assert.ok(a.note.includes('默认 100'), '必须写明按默认 100 显示：' + a.note);

  const b = readMaxEntries(broken);
  assert.equal(b.maxEntries, 100);
  assert.ok(b.note.includes('不是合法 JSON'), 'JSON 坏了要点明：' + b.note);

  const c = readMaxEntries(weird);
  assert.equal(c.maxEntries, 100, '值非法也要回落默认');
  assert.ok(c.note.includes('默认 100'), c.note);
  await cleanup(dir);
});

// —— 整体：真跑一次诊断 ——

test('A6｜整链诊断：真手册真归档真设置，五组数字与 crossCheck 一起产出，且不动任何文件', async () => {
  const dir = await makeDir('full');
  const file = path.join(dir, 'playbook.md');
  const archiveFile = path.join(dir, 'archive.md');
  const settingsFile = path.join(dir, 'dsh-ace.json');
  const entries = [
    DUP_A,
    DUP_B,
    TWIN_A,
    TWIN_B,
    LONER,
    E('ace-006', '从没命中过', '做法六', { hits: 0 }),
    E('ace-007', '很久没用了', '做法七', { hits: 3, lastHit: stamp(dayBefore(90)) }),
  ];
  await writePlaybook(file, entries);
  await fs.writeFile(archiveFile, serializeArchiveFile({
    header: initialArchiveHeader(),
    entries: [
      markArchived(E('ace-090', '上轮被淘汰的', '做法九十'), { reason: 'evicted', date: dayBefore(3) }),
      markArchived(E('ace-091', '上轮被合并的', '做法九十一'), { reason: 'merged', date: dayBefore(2), supersededBy: 'ace-003' }),
    ],
    extraLines: [],
  }), 'utf8');
  await fs.writeFile(settingsFile, JSON.stringify({ maxEntries: 7 }), 'utf8');

  const before = await fs.readdir(dir);
  const snapshot = {};
  for (const name of before) snapshot[name] = await fs.readFile(path.join(dir, name), 'utf8');

  const result = diagnose({ file, archiveFile, settingsFile, today: TODAY });
  assert.equal(result.ok, true, '诊断成功：' + result.error);
  assert.equal(result.today, TODAY);
  assert.equal(result.entries.length, 7);
  assert.ok(result.pairs.length >= 2, '两对近重复：' + JSON.stringify(result.pairs.map((p) => [p.aId, p.bId, p.ratio])));
  assert.deepEqual(result.zombies.map((z) => z.id).sort(), ['ace-006', 'ace-007']);
  // 过短判据与手册内容无关地成立：这几条正文都短，逐条核对「< 80 才算」。
  const skeletonIds = result.skeletons.map((s) => s.id).sort();
  assert.deepEqual(skeletonIds, entries.filter((e) => bodyChars(e) < SKELETON_BODY_CHARS).map((e) => e.id).sort(),
    '过短清单必须与逐条手算的结果一致：' + JSON.stringify(result.skeletons));
  assert.ok(skeletonIds.length >= 1, '这批造出来的条目里确实有过短的');
  assert.equal(result.adds.length, 7, '七条都是今天建的');
  assert.equal(result.archived.total, 2, '归档里 30 天内的两条');
  assert.equal(result.archived.buckets.evicted.length, 1);
  assert.equal(result.archived.buckets.merged.length, 1);
  assert.equal(result.capacity.active, 7);
  assert.equal(result.capacity.maxEntries, 7, '读数来自设置文件');
  assert.ok(result.bodyTokens > 0, '正文 token 估算要给出正数');

  const after = await fs.readdir(dir);
  assert.deepEqual(after, before, '诊断不许新建/删除任何文件');
  for (const name of before) {
    assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), snapshot[name], '诊断不许改动 ' + name);
  }
  await cleanup(dir);
});

test('A7｜渲染：五组都有一句人话 + 数字，top 5 之外只报「另有 N 条」', async () => {
  const entries = [];
  for (let i = 1; i <= 8; i++) entries.push(E('ace-' + String(i).padStart(3, '0'), '零命中 ' + i, '做法' + i, { hits: 0 }));
  const binary = renderReport({
    ok: true,
    file: 'X:/playbook.md',
    archiveFile: 'X:/archive.md',
    today: TODAY,
    entries,
    pairs: [],
    crossCheck: [],
    zombies: zombieEntries(entries, TODAY),
    skeletons: [],
    adds: [],
    archived: recentArchived([], TODAY),
    archiveError: '',
    capacity: { active: entries.length, file: 'X:/dsh-ace.json', maxEntries: 100, read: true, note: '' },
    bodyTokens: 12,
  });
  assert.ok(binary.includes('① 近重复配对'), '第一组有标题');
  assert.ok(binary.includes('② 僵尸条目'), '第二组有标题');
  assert.ok(binary.includes('③ 正文过短'), '第三组有标题');
  assert.ok(binary.includes('④ 近 30 天'), '第四组有标题');
  assert.ok(binary.includes('⑤ 容量'), '第五组有标题');
  assert.ok(/② 僵尸条目[^\n]*8 条/.test(binary), '僵尸条数要带数字：\n' + binary);
  const shown = binary.split('\n').filter((line) => line.startsWith('   · ace-'));
  assert.equal(shown.length, TOP_N, '只列 top 5：' + JSON.stringify(shown));
  assert.ok(binary.includes('另有 3 条未列出'), '剩下的用一句「另有 N 条」收口');
  assert.ok(binary.includes('X:/dsh-ace.json'), '容量那组要点明读的是哪个设置文件');
});

// —— 读不到/空/解析失败：一句人话，不崩 ——

test('A8｜手册不存在：报告一行说清楚路径与原因，不抛栈', async () => {
  const dir = await makeDir('missing');
  const file = path.join(dir, 'nope.md');
  const result = diagnose({ file, archiveFile: path.join(dir, 'archive.md'), settingsFile: path.join(dir, 'dsh-ace.json'), today: TODAY });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('手册文件读不到'), result.error);
  assert.ok(result.error.includes(file), '要点名是哪个文件：' + result.error);
  const text = renderReport(result);
  assert.ok(text.includes('体检中止'), '报告要有一句人话：' + text);
  assert.ok(!text.includes('① 近重复配对'), '中止时不该继续打印后面的组');
  await cleanup(dir);
});

test('A8｜手册是空文件 / 路径是个目录：同样只给一句人话，不抛栈', async () => {
  const dir = await makeDir('empty');
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, '', 'utf8');
  const empty = diagnose({ file, archiveFile: path.join(dir, 'archive.md'), settingsFile: path.join(dir, 'x.json'), today: TODAY });
  assert.equal(empty.ok, false);
  assert.ok(empty.error.includes('空文件'), empty.error);
  assert.ok(renderReport(empty).includes('体检中止'));

  // 读不出来但不是 ENOENT：把路径指成一个目录（readFileSync 抛 EISDIR）。
  const asDir = path.join(dir, 'playbook-dir');
  await fs.mkdir(asDir);
  const weird = diagnose({ file: asDir, archiveFile: path.join(dir, 'archive.md'), settingsFile: path.join(dir, 'x.json'), today: TODAY });
  assert.equal(weird.ok, false, '读不出来必须判失败，不许假装成功');
  assert.ok(weird.error.includes('手册文件读不到'), weird.error);
  assert.ok(weird.error.includes(asDir), '要点名是哪个路径：' + weird.error);
  assert.ok(renderReport(weird).includes('体检中止'), '渲染也要给一句人话');
  await cleanup(dir);
});

test('A8｜解析失败分支：renderReport 拿到 ok:false + 解析失败原因时只打一句人话（防御性分支）', () => {
  // 说明：lib/playbook.js 的 parsePlaybook 对任何字符串都不抛（容错解析），
  // 所以 diagnose 里的「手册解析失败」是**防御性分支** —— 靠 renderReport 的行为覆盖，
  // 而不假装能构造出抛错的手册。真抛错时这一段保证只输出人话、不把栈丢给调度者。
  const text = renderReport({
    ok: false,
    file: 'X:/playbook.md',
    archiveFile: 'X:/archive.md',
    today: TODAY,
    error: '手册解析失败（boom）：X:/playbook.md',
  });
  assert.ok(text.includes('体检中止'), text);
  assert.ok(text.includes('手册解析失败（boom）'), '原因要原样带出来：' + text);
  assert.ok(!text.includes('\n① '), '中止时不许继续打印五组');
  assert.equal(text.split('\n').filter((line) => line.startsWith('体检中止')).length, 1, '只打一行');
});

test('A8｜归档读不到不影响手册体检：只是少一组数字并留一句说明', async () => {
  const dir = await makeDir('no-archive');
  const file = path.join(dir, 'playbook.md');
  await writePlaybook(file, [LONER]);
  const result = diagnose({ file, archiveFile: path.join(dir, 'archive.md'), settingsFile: path.join(dir, 'x.json'), today: TODAY });
  assert.equal(result.ok, true);
  assert.equal(result.archived.total, 0);
  assert.ok(result.archiveError.includes('归档读不到'), result.archiveError);
  const text = renderReport(result);
  assert.ok(text.includes('① 近重复配对'), '手册体检照常跑完');
  assert.ok(text.includes('归档读不到'), '缺归档要留痕');
  await cleanup(dir);
});

// —— 命令行 ——

test('A9｜命令行：--file / --today 两形态都能解析，--help 只打用法', async () => {
  assert.deepEqual(parseArgs(['--file', 'a.md', '--today', '2026-06-13']), { file: 'a.md', today: '2026-06-13' });
  assert.deepEqual(parseArgs(['--file=b.md', '--today=2026-01-02']), { file: 'b.md', today: '2026-01-02' });
  assert.deepEqual(parseArgs(['--settings', 's.json', '--archive', 'ar.md']), { settingsFile: 's.json', archiveFile: 'ar.md' });
  assert.deepEqual(parseArgs([]), {}, '两个参数都可省略');
  assert.equal(parseArgs(['--help']).help, true);
  const help = await captureStdout(() => main(['--help']));
  assert.ok(help.includes('--file'), '帮助里要写清参数：' + help);
  assert.ok(!help.includes('① 近重复配对'), '--help 不该真去体检');
});

test('A9｜命令行真跑：--file 指向临时手册 + --today 固定日期，报告带上五组数字', async () => {
  const dir = await makeDir('cli');
  const file = path.join(dir, 'playbook.md');
  const settingsFile = path.join(dir, 'dsh-ace.json');
  await writePlaybook(file, [DUP_A, DUP_B]);
  await fs.writeFile(settingsFile, JSON.stringify({ maxEntries: 3 }), 'utf8');
  const out = await captureStdout(() => main([
    '--file', file,
    '--today', TODAY,
    '--settings', settingsFile,
    '--archive', path.join(dir, 'archive.md'),
  ]));
  assert.ok(out.includes('手册：' + file), '报告要写清读的是哪本手册：' + out);
  assert.ok(out.includes('① 近重复配对'), out);
  assert.ok(/① 近重复配对[^\n]*1 对/.test(out), '这一对讲同一件事：\n' + out);
  assert.ok(out.includes('ace-001') && out.includes('ace-002'), 'top 5 里要带 id');
  assert.ok(/⑤ 容量：活跃 2 条 \/ maxEntries 3/.test(out), '容量读数来自设置文件：\n' + out);
  await cleanup(dir);
});

test('A10｜零写盘：诊断源码里没有任何写盘调用（writeFile/appendFile/mkdir/rm 等）', async () => {
  const source = await fs.readFile(new URL('../tools/diagnose.mjs', import.meta.url), 'utf8');
  for (const banned of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm(', 'writeFileAtomic', 'withExclusiveLock']) {
    assert.ok(!source.includes(banned), '只读脚本里不许出现 ' + banned);
  }
  assert.ok(!/from '.*\/index\.js'/.test(source), '不许 import lib/index.js（会拉宿主包）');
  const libs = await fs.readdir(new URL('../lib/', import.meta.url));
  for (const name of libs) {
    const text = await fs.readFile(new URL('../lib/' + name, import.meta.url), 'utf8');
    assert.ok(!text.includes('tools/diagnose'), 'lib/' + name + ' 不许 import 体检脚本');
  }
  const client = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
  assert.ok(!client.includes('diagnose'), 'client.js 不许 import 体检脚本');
});

test('A11｜本地日期口径：localDayString 给 YYYY-MM-DD（本地时区切日，与归档口径同源）', () => {
  const day = localDayString(new Date(2026, 5, 13, 23, 59, 59));
  assert.equal(day, '2026-06-13');
  assert.equal(localDayString(new Date(2026, 0, 2, 0, 0, 0)), '2026-01-02', '个位数月份/日期要补零');
});
