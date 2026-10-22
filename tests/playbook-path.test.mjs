// 手册文件路径解析（lib/playbook-path.js）的单元测试。
// 运行：npm test（node --test tests/）。纯逻辑层，不碰真实 DSH_HOME 与真实用户目录：
// env / home 全部注入，ctx 用只带 get 的假对象。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAYBOOK_FILE_NAME,
  SHARED_PLAYBOOK_DIR,
  RELATIVE_PATH_NEEDS_SESSION,
  DEFAULT_PLAYBOOK_PATH,
  DEFAULT_MAX_ENTRIES,
  expandHomePath,
  resolveDshHome,
  resolveSharedPlaybookFile,
  resolvePlaybookFile,
  playbookPathKind,
} from '../lib/playbook-path.js';

const HOME = path.join(path.sep + 'fake', 'home');
const DSH_HOME = path.join(path.sep + 'fake', 'dsh-home');
const PROFILE_HOME = path.join(path.sep + 'fake', 'profile-home');
const WORKDIR = path.join(path.sep + 'work', 'repo');

/** 造一个只有 get 的假 ctx；profileContext 为 undefined 表示「非 profile 启动的宿主」。 */
function fakeCtx(profileContext) {
  return { get: (name) => (name === 'profileContext' ? profileContext : undefined) };
}

const SHARED = path.join(DSH_HOME, SHARED_PLAYBOOK_DIR, PLAYBOOK_FILE_NAME);

// —— ① 绝对路径：原样使用 ——

test('解析链①：绝对路径原样使用，与环境变量和工作目录无关', () => {
  const abs = path.join(path.sep + 'data', 'my-playbook.md');
  assert.equal(playbookPathKind(abs), 'absolute');
  assert.equal(resolvePlaybookFile(abs, { ctx: fakeCtx(undefined), env: { DSH_HOME }, home: HOME }), abs);
  // 给了工作目录也不该被 join 进去
  assert.equal(
    resolvePlaybookFile(abs, { ctx: fakeCtx({ home: PROFILE_HOME }), workingDirectory: WORKDIR, env: { DSH_HOME }, home: HOME }),
    abs,
  );
});

// —— ② ~ / ~\ 展开 ——

test('解析链①（~）：~ 与 ~/ 与 ~\\ 前缀都展开到 home，~foo 仍是字面目录名', () => {
  assert.equal(expandHomePath('~', HOME), HOME);
  assert.equal(expandHomePath('~/a/b.md', HOME), path.join(HOME, 'a', 'b.md'));
  assert.equal(expandHomePath('~\\a\\b.md', HOME), path.join(HOME, 'a', 'b.md'));
  assert.equal(expandHomePath('~foo/b.md', HOME), '~foo/b.md');
  assert.equal(expandHomePath('a/b.md', HOME), 'a/b.md');
  // 经 resolvePlaybookFile 也一致：~ 开头视为绝对，不参与工作目录 join
  assert.equal(
    resolvePlaybookFile('~/ace/playbook.md', { ctx: fakeCtx(undefined), workingDirectory: WORKDIR, env: { DSH_HOME }, home: HOME }),
    path.join(HOME, 'ace', 'playbook.md'),
  );
  assert.equal(
    resolvePlaybookFile('~\\ace\\playbook.md', { ctx: fakeCtx(undefined), env: { DSH_HOME }, home: HOME }),
    path.join(HOME, 'ace', 'playbook.md'),
  );
  assert.equal(playbookPathKind('~/x.md'), 'absolute');
});

// —— ③ 相对路径 + 工作目录 ——

test('解析链②：相对路径相对会话工作目录 join（工作区私有层）', () => {
  assert.equal(playbookPathKind('.ace/playbook.md'), 'relative');
  assert.equal(
    resolvePlaybookFile('.ace/playbook.md', { ctx: fakeCtx(undefined), workingDirectory: WORKDIR, env: { DSH_HOME }, home: HOME }),
    path.join(WORKDIR, '.ace', 'playbook.md'),
  );
});

test('解析链②：相对路径拿不到会话工作目录时抛明确错误', () => {
  assert.throws(
    () => resolvePlaybookFile('.ace/playbook.md', { ctx: fakeCtx(undefined), env: { DSH_HOME }, home: HOME }),
    (e) => e.message === RELATIVE_PATH_NEEDS_SESSION && /相对手册路径需要会话上下文/.test(e.message),
  );
});

// —— ④ 空串 → 共享层 ——

test('解析链③：空串 / 纯空白 / undefined 都落到共享层 <DSH home>/ace/playbook.md', () => {
  const env = { DSH_HOME };
  assert.equal(playbookPathKind(''), 'shared');
  assert.equal(playbookPathKind(undefined), 'shared');
  for (const configured of ['', '   ', undefined, null]) {
    assert.equal(resolvePlaybookFile(configured, { ctx: fakeCtx(undefined), env, home: HOME }), SHARED);
  }
  assert.equal(SHARED, path.join(DSH_HOME, 'ace', 'playbook.md'));
  // 共享层不需要会话上下文：没有工作目录也能解析
  assert.equal(resolvePlaybookFile('', { ctx: fakeCtx(undefined), env, home: HOME }), SHARED);
});

// —— ⑤ DSH_HOME 未设 → ~/.dsh ——

test('home 解析链：DSH_HOME 未设（或空串/纯空白）时回落 ~/.dsh', () => {
  for (const env of [{}, { DSH_HOME: '' }, { DSH_HOME: '   ' }]) {
    assert.equal(resolveDshHome(fakeCtx(undefined), env, HOME), path.join(HOME, '.dsh'));
    assert.equal(resolveSharedPlaybookFile(fakeCtx(undefined), env, HOME), path.join(HOME, '.dsh', 'ace', 'playbook.md'));
  }
  assert.equal(resolveDshHome(fakeCtx(undefined), { DSH_HOME }, HOME), DSH_HOME);
});

// —— ⑥ profileContext.home 优先于 env ——

test('home 解析链：profileContext.home 优先于 $DSH_HOME 与 ~/.dsh', () => {
  const ctx = fakeCtx({ name: 'web', home: PROFILE_HOME });
  assert.equal(resolveDshHome(ctx, { DSH_HOME }, HOME), PROFILE_HOME);
  assert.equal(resolvePlaybookFile('', { ctx, env: { DSH_HOME }, home: HOME }), path.join(PROFILE_HOME, 'ace', 'playbook.md'));
  // 容错：没有 get / get 抛错 / profileContext 无 home 都算「不存在」
  assert.equal(resolveDshHome({}, { DSH_HOME }, HOME), DSH_HOME);
  assert.equal(resolveDshHome(fakeCtx({ name: 'web' }), { DSH_HOME }, HOME), DSH_HOME);
  const throwing = { get: () => { throw new Error('service unavailable'); } };
  assert.equal(resolveDshHome(throwing, { DSH_HOME }, HOME), DSH_HOME);
});

test('共享层路径可与 merge-inbox 对接：空串配置下解析出的目录里读得到 inbox（HTTP 面同款调用）', async () => {
  const { readInbox } = await import('../lib/inbox.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-shared-'));
  const env = { DSH_HOME: dir };
  const file = resolvePlaybookFile('', { ctx: fakeCtx(undefined), env, home: HOME });
  assert.equal(file, path.join(dir, 'ace', 'playbook.md'));
  // 与 lib/index.js 的 inboxPath 同口径：<playbook 目录>/merge-inbox
  const inbox = path.join(path.dirname(file), 'merge-inbox');
  assert.deepEqual(await readInbox(inbox), [], '不存在时返回空列表');
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  const item = { kind: 'merge', a: 'ace-001', b: 'ace-002', score: 0.62 };
  fs.writeFileSync(inbox, JSON.stringify([item]), 'utf8');
  assert.deepEqual(await readInbox(inbox), [item], '共享层的 merge-inbox 能被读到');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('默认 home（不注入）时解析结果落在 os.homedir()/.dsh/ace/playbook.md', () => {
  // 只断言形状，不依赖真实用户目录里是否已有该文件。
  assert.equal(
    resolvePlaybookFile('', { ctx: fakeCtx(undefined), env: {} }),
    path.join(os.homedir(), '.dsh', 'ace', 'playbook.md'),
  );
});

// —— T74：核心默认值（playbookPath 空串 = 共享层、maxEntries = 100） ——

test('核心默认值：playbookPath 默认空串（本机共享层）、maxEntries 默认 100', () => {
  // 这两个默认值是本次改造最核心的契约，lib/index.js 因缺宿主依赖无法在测试里 import，
  // 因此默认值抽成纯逻辑常量（lib/playbook-path.js）供此处断言。
  assert.equal(DEFAULT_PLAYBOOK_PATH, '', 'playbookPath 默认必须是空串 = 本机共享层');
  assert.equal(DEFAULT_MAX_ENTRIES, 100, 'maxEntries 默认必须是 100');
  // 空串解析出来的就是共享层那本手册
  assert.equal(
    resolvePlaybookFile(DEFAULT_PLAYBOOK_PATH, { ctx: fakeCtx(undefined), env: {}, home: HOME }),
    path.join(HOME, '.dsh', SHARED_PLAYBOOK_DIR, PLAYBOOK_FILE_NAME),
  );
});
