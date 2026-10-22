// 设置文件路径解析与一次性迁移（lib/settings-path.js）的单元测试。
// 运行：npm test（node --test tests/）。纯逻辑层，不碰真实 DSH_HOME：env/home 全部注入。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SETTINGS_FILE_NAME,
  resolveSettingsFile,
  resolveLegacySettingsFile,
  migrateSettingsFile,
} from '../lib/settings-path.js';

const HOME = path.join(path.sep + 'fake', 'home');
const DSH_HOME = path.join(path.sep + 'fake', 'dsh-home');
const PROFILE_DIR = path.join(path.sep, 'fake', 'dsh-home', 'profiles', 'web');
const PROFILE_ENV_DIR = path.join(path.sep + 'fake', 'env-profile');

/** 造一个只有 get 的假 ctx；profileContext 为 undefined 表示「非 profile 启动的宿主」。 */
function fakeCtx(profileContext) {
  return { get: (name) => (name === 'profileContext' ? profileContext : undefined) };
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-' + tag + '-'));
}

test('resolveSettingsFile：profileContext.dir 存在时优先于任何环境变量', () => {
  const ctx = fakeCtx({ name: 'web', dir: PROFILE_DIR });
  const file = resolveSettingsFile(ctx, { DSH_PROFILE_DIR: PROFILE_ENV_DIR, DSH_HOME }, HOME);
  assert.equal(file, path.join(PROFILE_DIR, SETTINGS_FILE_NAME));
  assert.equal(file, path.join(PROFILE_DIR, 'dsh-ace.json'));
});

test('resolveSettingsFile：没有 profileContext 时回落 DSH_PROFILE_DIR', () => {
  const file = resolveSettingsFile(fakeCtx(undefined), { DSH_PROFILE_DIR: PROFILE_ENV_DIR, DSH_HOME }, HOME);
  assert.equal(file, path.join(PROFILE_ENV_DIR, SETTINGS_FILE_NAME));
});

test('resolveSettingsFile：再回落 DSH_HOME（旧口径，即当前实际落盘位置）', () => {
  const file = resolveSettingsFile(fakeCtx(undefined), { DSH_HOME }, HOME);
  assert.equal(file, path.join(DSH_HOME, SETTINGS_FILE_NAME));
});

test('resolveSettingsFile：都没有时回落 ~/.dsh', () => {
  const file = resolveSettingsFile(fakeCtx(undefined), {}, HOME);
  assert.equal(file, path.join(HOME, '.dsh', SETTINGS_FILE_NAME));
});

test('resolveSettingsFile：ctx 缺失 / 没有 get / profileContext 无 dir 都算「不存在」', () => {
  const env = { DSH_HOME };
  assert.equal(resolveSettingsFile(undefined, env, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
  assert.equal(resolveSettingsFile({}, env, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
  assert.equal(resolveSettingsFile(fakeCtx({ name: 'web' }), env, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
  assert.equal(resolveSettingsFile(fakeCtx(null), env, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
  // ctx.get 抛错也不许把插件带崩
  const throwing = { get: () => { throw new Error('service unavailable'); } };
  assert.equal(resolveSettingsFile(throwing, env, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
});

test('resolveSettingsFile：空串 / 纯空白被当作不存在，逐级回落', () => {
  // profileContext.dir 空串 → 回落 DSH_PROFILE_DIR
  assert.equal(
    resolveSettingsFile(fakeCtx({ dir: '' }), { DSH_PROFILE_DIR: PROFILE_ENV_DIR, DSH_HOME }, HOME),
    path.join(PROFILE_ENV_DIR, SETTINGS_FILE_NAME),
  );
  // profileContext.dir 纯空白 → 同上
  assert.equal(
    resolveSettingsFile(fakeCtx({ dir: '   ' }), { DSH_PROFILE_DIR: PROFILE_ENV_DIR, DSH_HOME }, HOME),
    path.join(PROFILE_ENV_DIR, SETTINGS_FILE_NAME),
  );
  // DSH_PROFILE_DIR 空串 → 回落 DSH_HOME
  assert.equal(
    resolveSettingsFile(fakeCtx(undefined), { DSH_PROFILE_DIR: '', DSH_HOME }, HOME),
    path.join(DSH_HOME, SETTINGS_FILE_NAME),
  );
  // 三个环境变量全空串 → 回落 ~/.dsh
  assert.equal(
    resolveSettingsFile(fakeCtx({ dir: '' }), { DSH_PROFILE_DIR: '', DSH_HOME: '' }, HOME),
    path.join(HOME, '.dsh', SETTINGS_FILE_NAME),
  );
});

test('resolveLegacySettingsFile：恒指旧口径（不看 profileContext）', () => {
  assert.equal(resolveLegacySettingsFile({ DSH_HOME }, HOME), path.join(DSH_HOME, SETTINGS_FILE_NAME));
  assert.equal(resolveLegacySettingsFile({}, HOME), path.join(HOME, '.dsh', SETTINGS_FILE_NAME));
  // 与解析链的 ②③④ 保持一致：没有 profileContext 时两者同路径
  assert.equal(
    resolveLegacySettingsFile({ DSH_HOME }, HOME),
    resolveSettingsFile(fakeCtx(undefined), { DSH_HOME }, HOME),
  );
});

test('migrateSettingsFile：新位置不存在时把旧内容原样复制过去，旧文件保留', () => {
  const root = tmpDir('migrate');
  const from = path.join(root, 'home', 'dsh-ace.json');
  const to = path.join(root, 'profiles', 'web', 'dsh-ace.json');
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, JSON.stringify({ autoReflect: true }) + '\n');

  const logs = [];
  const result = migrateSettingsFile({ from, to, logger: { info: (m) => logs.push(m) } });

  assert.equal(result.migrated, true);
  assert.equal(result.reason, 'copied');
  assert.equal(fs.readFileSync(to, 'utf8'), fs.readFileSync(from, 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(to, 'utf8')), { autoReflect: true });
  assert.equal(fs.existsSync(from), true, '旧文件必须保留不动');
  assert.equal(fs.existsSync(to + '.tmp'), false, '不留下临时文件');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /dsh-ace/);
  assert.ok(logs[0].includes(path.resolve(to)), '日志要写明新位置');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('migrateSettingsFile：新位置已存在时绝不覆盖', () => {
  const root = tmpDir('nooverwrite');
  const from = path.join(root, 'old', 'dsh-ace.json');
  const to = path.join(root, 'new', 'dsh-ace.json');
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(from, JSON.stringify({ autoReflect: true }));
  fs.writeFileSync(to, JSON.stringify({ maxEntries: 5 }));

  const result = migrateSettingsFile({ from, to });

  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'target-exists');
  assert.deepEqual(JSON.parse(fs.readFileSync(to, 'utf8')), { maxEntries: 5 });
  assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8')), { autoReflect: true });
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('migrateSettingsFile：旧文件不存在 / 两者同路径都跳过', () => {
  const root = tmpDir('skip');
  const from = path.join(root, 'old', 'dsh-ace.json');
  const to = path.join(root, 'new', 'dsh-ace.json');
  assert.deepEqual(migrateSettingsFile({ from, to }), { migrated: false, reason: 'source-missing' });
  assert.equal(fs.existsSync(to), false, '源不存在时不许凭空造新文件');

  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, '{"autoReflect":false}');
  assert.deepEqual(migrateSettingsFile({ from, to: from }), { migrated: false, reason: 'same-path' });
  assert.equal(fs.readFileSync(from, 'utf8'), '{"autoReflect":false}');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('migrateSettingsFile：迁移后的文件权限为 0o600（与 writeStored 同口径）', { skip: process.platform === 'win32' }, () => {
  const root = tmpDir('mode');
  const from = path.join(root, 'old', 'dsh-ace.json');
  const to = path.join(root, 'new', 'dsh-ace.json');
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, '{"autoReflect":true}');
  migrateSettingsFile({ from, to });
  assert.equal(fs.statSync(to).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
