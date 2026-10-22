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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT_URL = new URL('../lib/commit.js', import.meta.url).href;
const SNAP_URL = new URL('../lib/playbook.js', import.meta.url).href;

const WORKER_SRC = `
import fs from 'node:fs';
import { commitOps } from '${COMMIT_URL}';
import { readPlaybookSnapshot } from '${SNAP_URL}';

const [file, opsJson, outPath, readyPath, gatePath] = process.argv.slice(1);
const snapshot = await readPlaybookSnapshot(file);
fs.writeFileSync(readyPath, 'ready');
while (!fs.existsSync(gatePath)) {
  await new Promise((r) => setTimeout(r, 15));
}
try {
  const out = await commitOps(file, snapshot, JSON.parse(opsJson), 60);
  fs.writeFileSync(outPath, JSON.stringify({
    ok: true,
    conflicts: out.conflicts,
    added: out.result.added,
    updated: out.result.updated,
    removed: out.result.removed,
  }));
} catch (e) {
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
}
`;

const ENTRY = (id, title, action) => [
  '### [' + id + '] ' + title,
  '- 条件：条件-' + id,
  '- 做法：' + action,
  '- 元数据：created=2026-01-01 updated=2026-01-01 helpful=0 harmful=0',
  '',
];

async function makePlaybook(dir) {
  const file = path.join(dir, 'playbook.md');
  await fs.writeFile(file, ['# ACE 操作手册', '', ...ENTRY('ace-001', '编辑前先读', '先 read 再动手')].join('\n') + '\n', 'utf8');
  return file;
}

/** 起一个 worker 子进程；返回 { ready, out } 路径。 */
function startWorker(dir, file, ops, tag) {
  const outPath = path.join(dir, 'out-' + tag + '.json');
  const readyPath = path.join(dir, 'ready-' + tag);
  const gatePath = path.join(dir, 'gate');
  const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER_SRC, file, JSON.stringify(ops), outPath, readyPath, gatePath], {
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
async function runTwoWorkers(dir, file, opsA, opsB) {
  const a = startWorker(dir, file, opsA, 'a');
  const b = startWorker(dir, file, opsB, 'b');
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
    const all = titlesIn(text);
    const ids = all.map((e) => e.id);
    assert.ok(!ids.includes('ace-002') || all.length === 2, 'ace-002 已被删除：' + JSON.stringify(all));
    assert.ok(ids.includes('ace-003'), '新增条目必须用 ace-003（不复用被删的 ace-002）：' + JSON.stringify(all));
    assert.equal(new Set(ids).size, ids.length, '编号不能重复：' + JSON.stringify(ids));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});