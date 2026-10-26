// 真实子进程并发用例（缺陷 A / B 的端到端取证）。
//
// 做法：把「worker 脚本」写到系统临时目录（os.tmpdir() 下的 dsh-ace-conc-<rand>），
// 用两个**真实的 node 子进程**同时操作同一本手册，跑的是生产同款代码路径
// （lib/commit.js 的 commitOps）。用完即删，不在仓库里留脚本。
//
// 覆盖：
// - 两进程同时 add 同名不同内容 → 不产生两条重复（一条成功、一条报冲突）；
// - 两进程同时 update 同一条目 → 一条成功、一条报冲突，且冲突信息可见；
// - 两进程同时 add 不同条目 → 两条都在（不误伤）；
// - 两进程一边删最高编号一边新增 → 新增不复用被删的编号（缺陷 C，跨进程口径）。
// - 两进程各带**淘汰**钩子同时写 → 被淘汰的搬进独立归档文件 archive.md，一条不丢也不重复。
//
// 第 33 轮：归档不再进手册的「## 归档区」，一律进同目录的 archive.md（lib/archive-file.js）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parsePlaybook } from '../lib/playbook.js';
import { readArchiveSnapshot } from '../lib/archive-file.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT_URL = new URL('../lib/commit.js', import.meta.url).href;
const SNAP_URL = new URL('../lib/playbook.js', import.meta.url).href;

const EVICT_URL = new URL('../lib/evict.js', import.meta.url).href;
const STAMP = '2026-10-24T09:00:00.000+08:00';

// worker 脚本：跑生产同款 commitOps。第 6 个参数为 'evict' 时挂上生产同款的淘汰钩子
// （lib/evict.js 的 planEvictions）——用来验「淘汰与并发冲突同批」时归档不会丢。
// 第 7 个参数是 maxEntries（缺省 60）。
//
// 归档一律走**独立文件** archive.md（与手册同目录）：第 33 轮起手册里不再有「## 归档区」，
// 归档条目只可能出现在 archive.md。
const WORKER_SRC = `
import fs from 'node:fs';
import path from 'node:path';
import { commitOps } from '${COMMIT_URL}';
import { readPlaybookSnapshot } from '${SNAP_URL}';
import { planEvictions } from '${EVICT_URL}';

const [file, opsJson, outPath, readyPath, gatePath, mode, maxEntries] = process.argv.slice(1);
const snapshot = await readPlaybookSnapshot(file);
fs.writeFileSync(readyPath, 'ready');
while (!fs.existsSync(gatePath)) {
  await new Promise((r) => setTimeout(r, 15));
}
const options = { archiveFile: path.join(path.dirname(file), 'archive.md') };
if (mode === 'evict') {
  options.evict = planEvictions;
  options.today = '${STAMP}';
}
try {
  const out = await commitOps(file, snapshot, JSON.parse(opsJson), Number(maxEntries) || 60, options);
  fs.writeFileSync(outPath, JSON.stringify({
    ok: true,
    conflicts: out.conflicts,
    added: out.result.added,
    updated: out.result.updated,
    removed: out.result.removed,
    archived: out.result.archived,
  }));
} catch (e) {
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
}
`;

// 元数据字段顺序定死：created → updated → hits → lastHit（第 33 轮，毫秒时间戳）。
// created 决定淘汰顺序（同 hits 时更早的先走），所以这里让它逐条递增。
const ENTRY = (id, title, action, { hits = 0, created = '2026-01-01T00:00:00.000+08:00' } = {}) => [
  '### [' + id + '] ' + title,
  '- 条件：条件-' + id,
  '- 做法：' + action,
  '- 元数据：created=' + created + ' updated=' + created + ' hits=' + hits + ' lastHit=',
  '',
];

async function makePlaybook(dir) {
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, ['# ACE 操作手册', '', ...ENTRY('ace-001', '编辑前先读', '先 read 再动手')].join('\n') + '\n', 'utf8');
  return file;
}

/** 起一个 worker 子进程；返回 { ready, out } 路径。 */
function startWorker(dir, file, ops, tag, mode = 'plain', maxEntries = 60) {
  const outPath = path.join(dir, 'out-' + tag + '.json');
  const readyPath = path.join(dir, 'ready-' + tag);
  const gatePath = path.join(dir, 'gate');
  const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER_SRC, file, JSON.stringify(ops), outPath, readyPath, gatePath, mode, String(maxEntries)], {
    stdio: 'ignore',
    cwd: REPO,
  });
  return { child, outPath, readyPath, gatePath };
}

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** 两个 worker 同时开跑，等两份结果都回来。 */
async function runTwoWorkers(dir, file, opsA, opsB, modes = ['plain', 'plain'], maxEntries = 60) {
  const a = startWorker(dir, file, opsA, 'a', modes[0], maxEntries);
  const b = startWorker(dir, file, opsB, 'b', modes[1], maxEntries);
  const bothReady = await waitFor(async () => {
    try {
      await fs.access(a.readyPath);
      await fs.access(b.readyPath);
      return true;
    } catch { return false; }
  });
  assert.ok(bothReady, '两个 worker 都应就绪');
  await fs.writeFile(a.gatePath, 'go'); // 放闸：两边同时进入 commitOps
  const done = await waitFor(async () => {
    try {
      await fs.access(a.outPath);
      await fs.access(b.outPath);
      return true;
    } catch { return false; }
  });
  assert.ok(done, '两个 worker 都应写回结果');
  const read = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
  try {
    const ra = await read(a.outPath);
    const rb = await read(b.outPath);
    return { a: ra, b: rb };
  } finally {
    a.child.kill();
    b.child.kill();
  }
}

function titlesIn(text) {
  return [...text.matchAll(/^### \[([^\]]+)\] (.+)$/gm)].map((m) => ({ id: m[1], title: m[2].trim() }));
}

test('并发｜两进程同时 add 同名不同内容 → 不产生两条重复（一条成功、一条报冲突）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = await makePlaybook(dir);
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'add', title: '提交前先跑测试', condition: '改完代码要提交', action: '先跑一遍测试再提交', rationale: '避免带病提交' }],
      [{ op: 'add', title: '提交前先跑测试', condition: '提交代码之前', action: '运行 npm test 确认全部通过', rationale: '别把坏代码推上去' }]);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    const conflicted = [a, b].filter((r) => r.conflicts.length > 0);
    const succeeded = [a, b].filter((r) => r.conflicts.length === 0);
    assert.equal(conflicted.length, 1, '恰好一条被判冲突：' + JSON.stringify([a, b]));
    assert.equal(succeeded.length, 1, '恰好一条成功：' + JSON.stringify([a, b]));
    assert.equal(conflicted[0].conflicts[0].op, 'add');
    assert.match(conflicted[0].conflicts[0].reason, /标题相同|完全重复|高度相似/);
    const text = await fs.readFile(file, 'utf8');
    const same = titlesIn(text).filter((e) => e.title === '提交前先跑测试');
    assert.equal(same.length, 1, '同名条目只能有一条：' + JSON.stringify(titlesIn(text)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发｜两进程同时 update 同一条目 → 一条成功一条报冲突，且冲突信息可见', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = await makePlaybook(dir);
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'update', id: 'ace-001', action: '做法A：先 read 再 ask' }],
      [{ op: 'update', id: 'ace-001', action: '做法B：先 ask 再 read' }]);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    const conflicted = [a, b].filter((r) => r.conflicts.length > 0);
    const succeeded = [a, b].filter((r) => r.conflicts.length === 0);
    assert.equal(conflicted.length, 1, '恰好一条被判冲突：' + JSON.stringify([a, b]));
    assert.equal(succeeded.length, 1, '恰好一条成功：' + JSON.stringify([a, b]));
    assert.equal(conflicted[0].conflicts[0].id, 'ace-001');
    assert.match(conflicted[0].conflicts[0].reason, /已被修改|已被删除/);
    assert.ok(conflicted[0].conflicts[0].reason.length > 0, '冲突理由必须能回报给用户');
    const text = await fs.readFile(file, 'utf8');
    const actions = [...text.matchAll(/^- 做法：(.+)$/gm)].map((m) => m[1]);
    assert.equal(actions.length, 1, '只应有一份做法（没有写坏手册）：' + JSON.stringify(actions));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发｜两进程同时 add 不同条目 → 两条都在（不误伤）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = await makePlaybook(dir);
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'add', title: '查询变慢先看索引', condition: '接口变慢时', action: '检查索引并分析执行计划', rationale: 'r' }],
      [{ op: 'add', title: '合并前先跑测试', condition: '准备合并分支时', action: '跑一遍全量测试再合并', rationale: 'r' }]);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    assert.equal(a.conflicts.length, 0, '不同的条目不该被判冲突：' + JSON.stringify(a.conflicts));
    assert.equal(b.conflicts.length, 0, '不同的条目不该被判冲突：' + JSON.stringify(b.conflicts));
    const text = await fs.readFile(file, 'utf8');
    const all = titlesIn(text);
    assert.equal(all.length, 3, '原有 1 条 + 新增 2 条：' + JSON.stringify(all));
    const ids = all.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, '编号不能重复：' + JSON.stringify(ids));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发｜两个进程各带淘汰钩子同时写 → 被淘汰的搬进 archive.md 一条不丢、也不重复', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = path.join(dir, 'playbook.md');
    // 两条命中 0 的老条目 + maxEntries=2：两个进程各 add 一条，每边都得先淘汰一条才腾得出位。
    const lines = [
      '# ACE 操作手册', '',
      ...ENTRY('ace-001', '老条目甲', '做法甲', { hits: 0, created: '2026-01-01T00:00:00.000+08:00' }),
      ...ENTRY('ace-002', '老条目乙', '做法乙', { hits: 0, created: '2026-01-02T00:00:00.000+08:00' }),
    ];
    await fs.writeFile(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'add', title: '新条目甲', condition: '条件甲', action: '做法甲', rationale: 'r' }],
      [{ op: 'add', title: '新条目乙', condition: '条件乙', action: '做法乙', rationale: 'r' }],
      ['evict', 'evict'], 2);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    const activeIds = parsed.entries.map((e) => e.id);
    // 手册文件里不许再有归档区：归档条目只可能在 archive.md。
    assert.equal(/##\s*归档区/.test(await fs.readFile(file, 'utf8')), false, '手册里永不出现归档区章节');
    const archiveIds = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries.map((e) => e.id);
    // 两条命中 0 的老条目最终都必须进 archive.md，且各只有一份（并发不丢、也不重复归档）。
    assert.deepEqual(archiveIds.slice().sort(), ['ace-001', 'ace-002'], '归档不丢也不重复：' + JSON.stringify(archiveIds));
    const archived = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
    assert.ok(archived.every((e) => e.archive.reason === 'evicted'), '淘汰原因就是 evicted：' + JSON.stringify(archived.map((e) => e.archive)));
    assert.deepEqual(activeIds.filter((id) => id === 'ace-001' || id === 'ace-002'), [], '被淘汰的必须离开活跃区');
    assert.equal(activeIds.length, 2, '两个进程各新增一条，两条都要在（容量上限 2）：' + JSON.stringify(activeIds));
    const ids = [...activeIds, ...archiveIds];
    assert.equal(new Set(ids).size, ids.length, '编号不能重复（活跃区 + 归档一起看）：' + JSON.stringify(ids));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发｜淘汰钩子 + 并发冲突同批：冲突那条不落盘，淘汰照常生效', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = path.join(dir, 'playbook.md');
    // maxEntries=1：第一边先淘汰命中 0 的 ace-001 腾位，再改 ace-002；第二边撞冲突。
    const lines = [
      '# ACE 操作手册', '',
      ...ENTRY('ace-001', '没人用的条目', 'a1', { hits: 0, created: '2026-01-01T00:00:00.000+08:00' }),
      ...ENTRY('ace-002', '常用条目', 'a2', { hits: 5, created: '2026-01-02T00:00:00.000+08:00' }),
    ];
    await fs.writeFile(file, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    // 两边都改 ace-002（必然一条冲突），且都带淘汰钩子（先赢的那边会把 ace-001 淘汰掉）。
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'update', id: 'ace-002', action: '做法A：先 read' }],
      [{ op: 'update', id: 'ace-002', action: '做法B：先 ask' }],
      ['evict', 'evict'], 1);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    const conflicted = [a, b].filter((r) => r.conflicts.length > 0);
    assert.equal(conflicted.length, 1, '恰好一条被判冲突：' + JSON.stringify([a, b]));
    const parsed = parsePlaybook(await fs.readFile(file, 'utf8'));
    const archived = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
    assert.deepEqual(archived.map((e) => e.id), ['ace-001'], '淘汰在冲突同批里也要生效，且只有一份');
    assert.equal(archived[0].archive.reason, 'evicted', '淘汰原因：evicted');
    assert.equal(archived[0].action, 'a1', '归档保留正文');
    assert.deepEqual(parsed.entries.map((e) => e.id), ['ace-002'], '冲突那条没落盘、活跃区只剩 ace-002');
    assert.ok(['做法A：先 read', '做法B：先 ask'].includes(parsed.entries[0].action), '只允许一方胜出：' + parsed.entries[0].action);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发｜一进程删最高编号、另一进程新增 → 新增不复用被删的编号（缺陷 C 跨进程口径）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ace-conc-'));
  try {
    const file = path.join(dir, 'playbook.md');
    await fs.writeFile(file, ['# ACE 操作手册', '', ...ENTRY('ace-001', '编辑前先读', '先 read 再动手'), ...ENTRY('ace-002', '提交前先跑测试', '先跑测试再提交')].join('\n') + '\n', 'utf8');
    const { a, b } = await runTwoWorkers(dir, file,
      [{ op: 'remove', id: 'ace-002' }],
      [{ op: 'add', title: '新的条目', condition: '条件X', action: '做法X', rationale: 'r' }]);
    assert.ok(a.ok && b.ok, '两个 worker 都应正常返回：' + JSON.stringify([a, b]));
    const text = await fs.readFile(file, 'utf8');
    const parsed = parsePlaybook(text);
    // P0-1：remove 是软删除 —— 活跃区没有 ace-002，但它必须出现在**独立的** archive.md 里
    // （reason=removed-by-request），正文一个字不丢；编号仍算用过的编号，所以新增拿 ace-003。
    const activeIds = parsed.entries.map((e) => e.id);
    assert.ok(!activeIds.includes('ace-002'), 'ace-002 必须已从活跃区搬走：' + JSON.stringify(activeIds));
    const archiveEntries = (await readArchiveSnapshot(path.join(dir, 'archive.md'))).entries;
    const archived = archiveEntries.find((e) => e.id === 'ace-002');
    assert.ok(archived, '被 remove 的 ace-002 必须出现在 archive.md（绝不物理删除）：' + JSON.stringify(archiveEntries.map((e) => e.id)));
    assert.equal(archived.archive.reason, 'removed-by-request');
    assert.equal(archived.title, '提交前先跑测试', '归档条目正文不得蒸发');
    assert.ok(activeIds.includes('ace-003'), '新增条目必须用 ace-003（不复用被删的 ace-002）：' + JSON.stringify(activeIds));
    const ids = [...parsed.entries, ...archiveEntries].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, '编号不能重复（活跃区 + 归档一起看）：' + JSON.stringify(ids));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});