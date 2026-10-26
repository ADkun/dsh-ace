// 手册条目清单（lib/entries.js）的单元测试 + GET /api/dsh-ace/entries 的 HTTP 面契约。
// 运行：npm test（node --test tests/）。纯逻辑 + 只读 IO：全部在临时目录里造手册，
// 不碰真实 DSH_HOME / 真实用户手册（C:\Users\<user>\.dsh\ace\playbook.md 只读不写）。
//
// 关于 HTTP 面的验证方式（与 tests/client-picker.test.mjs:16、tests/client-stats.test.mjs:17 同款）：
// lib/index.js 顶层 import 了宿主包（@deepseek-ai/schemastery、dsh-tools、dsh-llm），
// 本仓库不带 node_modules（见 tests/playbook-path.test.mjs:148 与 TESTING.md 未验证清单 13），
// 所以 /entries 分支没法在 node:test 里被真正挂起来打一发请求。这里退一步做两件事：
//   ① 行为面：直接跑该分支调用的那两个函数（collectPlaybookEntries / emptyEntries），
//      断言 200 响应的 body 形状与降级 body 形状——分支本体只做「调它 + send」，没有别的逻辑；
//   ② 源码级：把 lib/index.js 里 /entries 分支那段源码切出来，钉住围栏顺序、非 GET → 405、
//      Content-Type、以及 catch 兜底走 emptyEntries（照 tests/client-stats.test.mjs:324-328 的先例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ENTRIES_REASONS,
  toEntry,
  collectEntries,
  emptyEntries,
  readPlaybookEntries,
  collectPlaybookEntries,
} from '../lib/entries.js';
import { parsePlaybook } from '../lib/playbook.js';
import { DEFAULT_MAX_ENTRIES } from '../lib/playbook-path.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const indexPath = path.join(here, '..', 'lib', 'index.js');
const indexSource = fs.readFileSync(indexPath, 'utf8');
const entriesSource = fs.readFileSync(path.join(here, '..', 'lib', 'entries.js'), 'utf8');

/** 一份小手册：两条条目，第二条带 auto=true。 */
const SAMPLE = [
  '# ACE 操作手册',
  '',
  '> 本文件由插件维护。',
  '',
  '### [ace-001] 标题一',
  '- 条件：条件一',
  '- 做法：做法一',
  '- 依据：依据一',
  '- 元数据：created=2026-10-01 updated=2026-10-02 hits=3 lastHit=2026-10-20T08:00:00.000+08:00',
  '',
  '### [ace-002] 标题二',
  '- 条件：条件二',
  '- 做法：做法二',
  '- 依据：依据二',
  '- 元数据：created=2026-10-05 updated=2026-10-05 hits=0 lastHit= auto=true',
  '',
].join('\n');

/** 条目的固定形状：字段与顺序都是对外契约（客户端按字段名直读）。 */
const ENTRY_KEYS = ['id', 'title', 'condition', 'action', 'rationale', 'auto', 'created', 'updated', 'hits', 'lastHit'];

/** 造临时目录，返回 { dir, file, cleanup }。 */
function tempPlaybook(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-entries-'));
  const file = path.join(dir, 'playbook.md');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 只有 get 的假 ctx（无 profileContext、无 workingDirectory = HTTP 面的处境）。 */
const fakeCtx = { get: () => undefined };

/**
 * 把 lib/index.js 里某个路由分支的源码切出来（从 'if (routePath === X) {' 到配平的 '}'）。
 * 只为源码级契约断言服务，不执行它。
 */
function routeBranch(source, route) {
  const start = source.indexOf("if (routePath === '" + route + "') {");
  assert.notEqual(start, -1, 'lib/index.js 里应有 ' + route + ' 分支');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('未能切出 ' + route + ' 分支');
}

// —— ① 空手册 ——

test('条目①：空手册返回 ok:true 的空清单（不抛错、字段齐全）', async () => {
  const empty = collectEntries(parsePlaybook(''), { maxEntries: 100 });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.maxEntries, 100);

  // 只有文档头、没有条目：同样空清单
  const headerOnly = collectEntries('# ACE 操作手册\n\n> 本文件由插件维护。\n', { maxEntries: 100 });
  assert.deepEqual(headerOnly.entries, []);
  assert.equal(headerOnly.total, 0);

  // 直接传手册全文也认（内部走 parsePlaybook，不另写解析）
  assert.deepEqual(collectEntries('', { maxEntries: 100 }).entries, []);
  assert.deepEqual(collectEntries(undefined).entries, []);
});

// —— ② 正常手册（auto 与非 auto 都在） ——

test('条目②：正常手册返回全部条目，auto 与非 auto 都正确', () => {
  const result = collectEntries(parsePlaybook(SAMPLE), { maxEntries: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.total, 2);
  assert.equal(result.entries.length, 2);
  assert.equal(result.maxEntries, 100);
  // 顺序与手册里一致
  assert.deepEqual(result.entries.map((entry) => entry.id), ['ace-001', 'ace-002']);
  // auto 恒为布尔：没有 auto=true 的条目是 false，不是 undefined
  assert.equal(result.entries[0].auto, false);
  assert.equal(result.entries[1].auto, true);
});

// —— ③ 字段映射 ——

test('条目③：字段映射——正文取条目字段、元数据取 meta、缺失给空串/0', () => {
  const result = collectEntries(parsePlaybook(SAMPLE), { maxEntries: 100 });
  const [first, second] = result.entries;

  // 每条 entry 的字段集合与顺序都是固定契约
  assert.deepEqual(Object.keys(first), ENTRY_KEYS);
  assert.deepEqual(Object.keys(second), ENTRY_KEYS);

  assert.deepEqual(first, {
    id: 'ace-001',
    title: '标题一',
    condition: '条件一',
    action: '做法一',
    rationale: '依据一',
    auto: false,
    created: '2026-10-01',
    updated: '2026-10-02',
    hits: 3,
    lastHit: '2026-10-20T08:00:00.000+08:00',
  });
  assert.deepEqual(second, {
    id: 'ace-002',
    title: '标题二',
    condition: '条件二',
    action: '做法二',
    rationale: '依据二',
    auto: true,
    created: '2026-10-05',
    updated: '2026-10-05',
    hits: 0,
    lastHit: '',
  });

  // 类型也要钉住：id/正文/日期恒为 string，auto 恒为 boolean，hits 恒为 number
  for (const entry of result.entries) {
    for (const field of ['id', 'title', 'condition', 'action', 'rationale', 'created', 'updated', 'lastHit']) {
      assert.equal(typeof entry[field], 'string', field + ' 应为 string');
    }
    assert.equal(typeof entry.auto, 'boolean');
    assert.equal(typeof entry.hits, 'number');
  }
  // 第 33 轮：正负评分整层删除，helpful / harmful 不许以任何形式残留在对外契约里。
  assert.equal('helpful' in first, false, 'helpful 已随评分机制删除，条目形状里不许再有它');
  assert.equal('harmful' in first, false, 'harmful 已随评分机制删除，条目形状里不许再有它');
});

test('条目③b：缺字段的条目给空串/0/false（客户端不必判空）', () => {
  // 只有标题行、没有条件/做法/依据/元数据
  const bare = collectEntries(parsePlaybook('### [ace-007] 只有标题\n'), { maxEntries: 100 });
  assert.deepEqual(bare.entries, [{
    id: 'ace-007',
    title: '只有标题',
    condition: '',
    action: '',
    rationale: '',
    auto: false,
    created: '',
    updated: '',
    hits: 0,
    lastHit: '',
  }]);
  // toEntry 对空对象同样稳定（防御性：不炸、不出现 undefined）
  assert.deepEqual(toEntry({}), {
    id: '', title: '', condition: '', action: '', rationale: '',
    auto: false, created: '', updated: '', hits: 0, lastHit: '',
  });
  // 元数据里 hits 写了非数字：回落 0（与 parseMeta 的 Number(v) || 0 同口径）
  const weird = collectEntries(parsePlaybook('### [ace-008] t\n- 元数据：created= updated= hits=abc lastHit=\n'));
  assert.equal(weird.entries[0].hits, 0);
  assert.equal(weird.entries[0].lastHit, '');
  assert.equal(weird.entries[0].auto, false);
});

// —— ④ 不可读降级 ——

test('条目④：文件不存在 → missing 空态（不抛 ENOENT）', async () => {
  const missing = path.join(os.tmpdir(), 'dsh-ace-entries-not-exist-' + process.pid, 'playbook.md');
  const result = await readPlaybookEntries(missing, { maxEntries: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, ENTRIES_REASONS.missing);
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 0);
  assert.equal(result.maxEntries, 100);
});

test('条目④b：路径是目录（读不成文件）→ unreadable 空态（不抛错）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-entries-dir-'));
  try {
    const result = await readPlaybookEntries(dir, { maxEntries: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.reason, ENTRIES_REASONS.unreadable);
    assert.deepEqual(result.entries, []);
    assert.equal(result.maxEntries, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('条目④c：相对 playbookPath 在 HTTP 面无会话上下文 → needs-session 空态（不抛错）', async () => {
  const result = await collectPlaybookEntries('docs/playbook.md', { ctx: fakeCtx, maxEntries: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, ENTRIES_REASONS.needsSession);
  assert.equal(result.pathKind, 'relative');
  assert.equal(result.playbookPath, 'docs/playbook.md');
  assert.deepEqual(result.entries, []);
  assert.equal(result.total, 0);
  assert.equal(result.maxEntries, 100);
});

test('条目④d：绝对 playbookPath 走真实读盘，条目可用', async () => {
  const { file, cleanup } = tempPlaybook(SAMPLE);
  try {
    const result = await collectPlaybookEntries(file, { ctx: fakeCtx, maxEntries: 100 });
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined, '成功路径不带 reason');
    assert.equal(result.pathKind, 'absolute');
    assert.equal(result.playbookPath, file);
    assert.equal(result.total, 2);
    assert.equal(result.entries[1].auto, true);
  } finally {
    cleanup();
  }
});

test('条目④e：降级体与成功体的字段集合一致（客户端不必特判）', () => {
  const ok = collectEntries(parsePlaybook(SAMPLE), { maxEntries: 100 });
  const degraded = emptyEntries(ENTRIES_REASONS.unreadable, { maxEntries: 100 });
  assert.deepEqual(Object.keys(degraded).sort(), [...Object.keys(ok), 'reason'].sort());
  assert.equal(degraded.ok, true);
  assert.equal(degraded.reason, 'unreadable');
  assert.deepEqual(degraded.entries, []);
  assert.equal(degraded.total, 0);
  assert.equal(degraded.maxEntries, 100);
});

// —— ⑤ maxEntries 透传 ——

test('条目⑤：maxEntries 原样透传（不是有限数则 null）', async () => {
  assert.equal(collectEntries(parsePlaybook(SAMPLE), { maxEntries: 42 }).maxEntries, 42);
  assert.equal(collectEntries(parsePlaybook(SAMPLE), { maxEntries: 0 }).maxEntries, 0);
  assert.equal(collectEntries(parsePlaybook(SAMPLE), { maxEntries: null }).maxEntries, null);
  assert.equal(collectEntries(parsePlaybook(SAMPLE)).maxEntries, null);
  assert.equal(collectEntries(parsePlaybook(SAMPLE), { maxEntries: 'lots' }).maxEntries, null);
  assert.equal(collectEntries(parsePlaybook(SAMPLE), { maxEntries: NaN }).maxEntries, null);
  assert.equal(emptyEntries(ENTRIES_REASONS.missing, { maxEntries: 250 }).maxEntries, 250);

  const { file, cleanup } = tempPlaybook(SAMPLE);
  try {
    const result = await collectPlaybookEntries(file, { ctx: fakeCtx, maxEntries: 250 });
    assert.equal(result.maxEntries, 250);
  } finally {
    cleanup();
  }
});

// —— ⑥ 只读红线：本模块里不许出现写手册的代码 ——

test('条目⑥：lib/entries.js 是纯只读模块（不碰锁与原子写，不写盘）', () => {
  // 先剥掉注释：头注里点名「不碰 withLock / writeFileAtomic」是声明，不是调用
  const code = entriesSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['withLock', 'withExclusiveLock', 'withFileLock', 'writeFileAtomic', 'writeFile', 'writeFileSync', 'rename', 'appendFile', 'mkdir', 'commitOps']) {
    assert.equal(code.includes(forbidden), false, '只读模块不应出现 ' + forbidden);
  }
  // 只 import 了既有解析层与路径解析层（不另写 Markdown 解析）
  assert.match(entriesSource, /from '\.\/playbook\.js'/);
  assert.match(entriesSource, /from '\.\/playbook-path\.js'/);
});

// —— ⑦ HTTP 面契约（GET /api/dsh-ace/entries） ——

test('条目⑦：GET /entries 的 200 响应体形状正确（全量条目 + total + maxEntries）', async () => {
  const { file, cleanup } = tempPlaybook(SAMPLE);
  try {
    // 分支本体：await collectPlaybookEntries(live.playbookPath, { ctx, maxEntries: live.maxEntries }) → send(200, it)
    const body = await collectPlaybookEntries(file, { ctx: fakeCtx, maxEntries: 100 });
    const roundTripped = JSON.parse(JSON.stringify(body));
    assert.equal(roundTripped.ok, true);
    assert.equal(roundTripped.total, 2);
    assert.equal(roundTripped.maxEntries, 100);
    assert.equal(roundTripped.entries.length, 2);
    assert.deepEqual(Object.keys(roundTripped.entries[0]), ENTRY_KEYS);
    assert.equal(roundTripped.entries[0].title, '标题一');
    assert.equal(roundTripped.entries[1].auto, true);
  } finally {
    cleanup();
  }
});

test('条目⑦b：/entries 分支源码契约——围栏在前、非 GET → 405、200 只发 ok 体、catch 走 emptyEntries', () => {
  const branch = routeBranch(indexSource, '/entries');
  // 非 GET 一律 405（与 /stats、/catalog 同款写法与同款错误体）
  assert.match(branch, /if \(method !== 'GET'\) return send\(405, \{ error: 'method not allowed' \}\);/);
  // 走既有的配置值与会话上下文（maxEntries 透传，路径解析用 ctx）
  assert.match(branch, /collectPlaybookEntries\(live\.playbookPath, \{/);
  assert.match(branch, /maxEntries: live\.maxEntries/);
  assert.match(branch, /return send\(200, entries\);/);
  // 降级：200 + 结构化空态（绝不 500、绝不抛）
  assert.match(branch, /catch \(error\)/);
  assert.match(branch, /emptyEntries\(ENTRIES_REASONS\.unreadable, \{ maxEntries: live\.maxEntries \}\)/);
  // 降级体必须与成功体同形：成功路径（collectPlaybookEntries）带 pathKind / playbookPath，
  // 旧版 catch 只发 5 键的 emptyEntries —— 客户端拿不到 pathKind 就只能猜。
  assert.match(branch, /pathKind: playbookPathKind\(live\.playbookPath\)/);
  assert.match(branch, /playbookPath: live\.playbookPath/);
  assert.equal(/send\(500/.test(branch), false, '/entries 分支不许回 500');
  assert.equal(/throw /.test(branch), false, '/entries 分支不许往外抛');

  // 围栏（rejectionFor）必须排在 /entries 分支之前：先鉴权再取数据
  const fenceAt = indexSource.indexOf('const rejection = rejectionFor(req, ctx.get(\'connection\'));');
  const branchAt = indexSource.indexOf("if (routePath === '/entries') {");
  assert.notEqual(fenceAt, -1, '应有 rejectionFor 围栏');
  assert.ok(fenceAt < branchAt, '围栏必须在 /entries 分支之前');

  // Content-Type 与其它路由共用同一个 send（json + no-store）
  assert.match(indexSource, /'content-type': 'application\/json; charset=utf-8'/);
  assert.match(indexSource, /'cache-control': 'no-store'/);
});

test('条目⑦c：/stats 的 catch 兜底与成功路径同形（不再是缺字段的残缺 payload）', () => {
  const branch = routeBranch(indexSource, '/stats');
  // 旧的残缺兜底 { ok: true, reason: 'unreadable' } 必须消失
  assert.equal(branch.includes("send(200, { ok: true, reason: 'unreadable' })"), false, '旧残缺兜底应已移除');
  // 改为 emptyStats(STATS_REASONS.unreadable, ...)：scale / daily / recent / source / windowDays / generatedAt 都在
  // C6 起还要带 runtime 块（本进程内存态的六项运行计数）——它和手册文件内容无关，降级分支也必须照带，
  // 否则「手册读不到」时设置页的运行统计会整块消失。
  assert.match(branch, /return send\(200, emptyStats\(STATS_REASONS\.unreadable, \{ maxEntries: live\.maxEntries, runtime: runtimeSnapshot\(\) \}\)\);/);
  assert.equal((branch.match(/runtime: runtimeSnapshot\(\)/g) || []).length, 2, '成功路径与兜底路径都必须带 runtime');
});

test('条目⑦d：/inbox 的降级体带 reason，与「真的没有待合并条目」不再同形', () => {
  const branch = routeBranch(indexSource, '/inbox');
  // 成功路径：{ ok, items, full, cap }
  assert.match(branch, /return send\(200, \{ ok: true, items, full: inboxFull\(items\), cap: INBOX_CAP \}\);/);
  // 旧降级体 { ok:true, items:[], full:false, cap } 和「确实没有条目」一模一样 ——
  // 磁盘读失败被静默吞成空态（/stats、/entries 都带 reason，唯独这里没有）。
  assert.match(branch, /reason: 'unreadable'/);
  // 降级体的字段集合必须与成功路径一致（同形），只多一个 reason。
  const success = branch.match(/send\(200, \{ ok: true, items, full: inboxFull\(items\), cap: INBOX_CAP \}\)/);
  const degraded = branch.match(/send\(200, \{ ok: true, reason: 'unreadable', items: \[\], full: false, cap: INBOX_CAP \}\)/);
  assert.ok(success && degraded, '成功体与降级体都应存在');
  const keys = (body) => body.replace(/^send\(200, \{/, '').replace(/\}\)$/, '')
    .split(',').map((pair) => pair.split(':')[0].trim()).filter(Boolean).sort();
  assert.deepEqual(keys(degraded[0]), [...keys(success[0]), 'reason'].sort(), '降级体 = 成功体 + reason');
});

// —— ⑧ bounds 是设置页那半边的唯一边界出处（含默认值） ——

test('条目⑧：describe() 的 bounds 带 defaults.*，默认值一律引用常量（第 36 轮起有四个键）', () => {
  const start = indexSource.indexOf('const describe = () => ({');
  assert.notEqual(start, -1, 'describe() 应在位');
  const body = indexSource.slice(start, indexSource.indexOf('});', start) + 3);
  // min/max 语义不变（既有契约，T149 依赖它）
  assert.match(body, /maxEntries: MAX_ENTRIES_RANGE/);
  assert.match(body, /autoRecapThreshold: \[0, 1000\]/);
  assert.match(body, /autoRecapCooldownTurns: \[0, 1000\]/);
  // 默认值必须有唯一边界出处：bounds.defaults.maxEntries 直接引用常量。
  // 旧版两边各自写死（客户端文案「默认 100」、placeholder '100'），改常量就漂。
  // 默认值必须有唯一边界出处：bounds.defaults.* 一律引用模块级常量。
  // 第 36 轮起 defaults 里有四个键（三个新可调项 + maxEntries），所以不能再用「单键整体匹配」，
  // 改成「maxEntries 那行的值必须是 DEFAULT_MAX_ENTRIES」+「四个键都不许写死数字」。
  assert.match(body, /defaults: \{[\s\S]*?maxEntries: DEFAULT_MAX_ENTRIES/, 'bounds 带出默认值且引用常量');
  assert.equal(/maxEntries: \d+/.test(body), false, 'bounds 里不许写死默认值数字');
  // 常量本身仍是 100（既有契约，T74 依赖它）。
  assert.equal(DEFAULT_MAX_ENTRIES, 100);
});

test('条目⑧b：客户端不再自带默认值字面量（文案与 placeholder 都从 bounds 取）', () => {
  const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
  // 字典里「默认」后面必须是 {d} 占位符，且 zh/en 两侧都没有写死的 100。
  assert.match(clientSource, /fieldMaxEntriesDesc: '[^']*默认 \{d\}[^']*'/, 'zh 文案用 {d} 占位');
  assert.match(clientSource, /fieldMaxEntriesDesc: '[^']*default \{d\}[^']*'/, 'en 文案用 {d} 占位');
  assert.equal(/默认 100/.test(clientSource), false, 'zh 文案不再写死「默认 100」');
  assert.equal(/default 100/.test(clientSource), false, 'en 文案不再写死「default 100」');
  // placeholder 不再有写死的字典字面量（旧版 maxEntriesPlaceholder: '100' 已删除）。
  assert.equal(/maxEntriesPlaceholder/.test(clientSource), false, 'placeholder 不再走字典字面量');
  assert.match(clientSource, /numProps\('maxEntries', maxEntriesRange\[0\], String\(maxEntriesDefault\), maxEntriesRange\[1\]\)/, 'placeholder 取 bounds 默认值');
});

test('条目⑦e：/catalog 包了 try/catch，读目录抛错也一定会写响应，绝不挂到超时', () => {
  const branch = routeBranch(indexSource, '/catalog');
  // 旧实现是唯一没有 try/catch 的路由：async handler 里 readCatalog() 一抛，
  // 既没人 catch 也没人 send —— 浏览器 fetch 挂到超时。
  assert.match(branch, /try \{/);
  assert.match(branch, /catch \(error\)/);
  // 失败体照抄 lib/catalog.js buildCatalog 的形状 { ok:false, error, providers:[] }
  assert.match(branch, /return send\(200, \{ ok: false, error: String\(error\?\.message \?\? error\), providers: \[\] \}\);/);
  // 非 GET 仍是 405（语义不变）
  assert.match(branch, /if \(method !== 'GET'\) return send\(405, \{ error: 'method not allowed' \}\);/);
  // 成功路径仍在
  assert.match(branch, /return send\(200, await readCatalog\(\)\);/);
});
