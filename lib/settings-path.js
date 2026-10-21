// 设置文件的路径解析与一次性迁移（纯逻辑 + 少量同步 fs，可独立测试）。
//
// 解析链（优先级从高到低）：
//   ① ctx.get('profileContext').dir —— DSH profile 目录本身（官方惯例，每个 profile 一份设置）；
//   ② process.env.DSH_PROFILE_DIR     —— 旧口径的回落（服务进程里通常没有，见下）；
//   ③ process.env.DSH_HOME            —— 旧口径的回落；
//   ④ path.join(os.homedir(), '.dsh') —— 最后兜底。
// 文件名固定 dsh-ace.json。env 与 home 通过参数注入，便于测试。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - ProfileContext 类型定义（含 readonly dir）：~\dsh-app-boot\lib\types\profile-context.d.ts:10-25，
//   其中 :14 为 `readonly dir: string;`；
// - ctx.profileContext 的声明与「Present only in a profile launched by dsh」注释：
//   同文件 :26-31（declare module '@deepseek-ai/cordis' { interface Context { profileContext: ProfileContext } }）；
// - profile 目录布局 $DSH_HOME/profiles/<name>：~\dsh-app-boot\lib\index.js:488-497；
// - 取值先例：~\dsh-config-editor\lib\index.js:72,78（this.ownerContext.profileContext.dir）、
//   ~\dsh-shell-env\lib\index.js:90（const profile = this.ctx.get("profileContext")）。
//
// 为什么不能只靠环境变量：DSH_PROFILE_DIR 只由 ~\dsh-shell-env\lib\index.js:90-93 在每次
// shell 工具调用时现塞进子进程，宿主服务进程自己身上没有这个变量——所以 apply() 里
// process.env.DSH_PROFILE_DIR 恒为 undefined，旧实现实际落在 $DSH_HOME/dsh-ace.json。
// 要「跟随 profile」只能问 ctx 要 profileContext。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 设置文件名（与旧实现一致，不随位置变化）。 */
export const SETTINGS_FILE_NAME = 'dsh-ace.json';

/** 非空字符串才算「有值」：空串/纯空白一律当不存在。 */
function usableDir(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 从 ctx 上取 profile 目录；profileContext 可能不存在（非 profile 启动的宿主），
 * 也可能 ctx 只是个没有 get 的假对象（测试），一律容错返回 undefined。
 */
function profileDirOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return undefined;
  let profile;
  if (typeof ctx.get === 'function') {
    try {
      profile = ctx.get('profileContext');
    } catch {
      return undefined;
    }
  } else {
    profile = ctx.profileContext;
  }
  if (profile === undefined || profile === null) return undefined;
  return usableDir(profile.dir);
}

/**
 * 设置文件绝对路径：profile 目录优先，其次 DSH_PROFILE_DIR / DSH_HOME / ~/.dsh。
 * @param ctx cordis 上下文（apply 里传进来）；可为 undefined。
 * @param env 环境变量来源，默认 process.env。
 * @param home home 目录，默认 os.homedir()。
 */
export function resolveSettingsFile(ctx, env = process.env, home = os.homedir()) {
  const base = profileDirOf(ctx)
    ?? usableDir(env?.DSH_PROFILE_DIR)
    ?? usableDir(env?.DSH_HOME)
    ?? path.join(home, '.dsh');
  return path.join(base, SETTINGS_FILE_NAME);
}

/**
 * 旧实现落盘的位置（DSH_HOME 层）：只看环境变量，不看 profileContext。
 * 迁移时用它找旧文件；解析链与 resolveSettingsFile 的 ②③④ 完全一致。
 */
export function resolveLegacySettingsFile(env = process.env, home = os.homedir()) {
  const base = usableDir(env?.DSH_PROFILE_DIR)
    ?? usableDir(env?.DSH_HOME)
    ?? path.join(home, '.dsh');
  return path.join(base, SETTINGS_FILE_NAME);
}

/**
 * 一次性迁移：把旧位置的设置**复制**到新位置。
 *
 * 只在「新位置不存在 + 旧位置存在 + 两者不是同一路径」时动手；
 * 新位置已存在则绝不覆盖（用户已经在新位置写过设置，那才是权威）。
 * 旧文件保留不动——那是用户数据，删了无法恢复。
 * 写入走与 writeStored 同口径的原子写：临时文件 + rename、mode 0o600。
 *
 * 内容按原样复制（不重新序列化）：读侧 readStored 本来就会过滤无效字段。
 *
 * @returns {{ migrated: boolean, reason: string, from?: string, to?: string }}
 */
export function migrateSettingsFile({ from, to, logger } = {}) {
  if (typeof from !== 'string' || typeof to !== 'string' || from.trim() === '' || to.trim() === '') {
    return { migrated: false, reason: 'invalid-path' };
  }
  const fromPath = path.resolve(from);
  const toPath = path.resolve(to);
  if (fromPath === toPath) return { migrated: false, reason: 'same-path' };
  if (fs.existsSync(toPath)) return { migrated: false, reason: 'target-exists' };
  if (!fs.existsSync(fromPath)) return { migrated: false, reason: 'source-missing' };

  let content;
  try {
    content = fs.readFileSync(fromPath, 'utf8');
  } catch (error) {
    logger?.warn?.('dsh-ace: 读取旧设置失败，跳过迁移（' + (error?.message ?? error) + '）');
    return { migrated: false, reason: 'source-unreadable' };
  }

  try {
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    const temporary = toPath + '.tmp';
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, toPath);
  } catch (error) {
    try {
      fs.rmSync(toPath + '.tmp', { force: true });
    } catch {
      /* 清理临时文件失败不影响结论：新位置仍然是「不存在」 */
    }
    logger?.warn?.('dsh-ace: 旧设置迁移失败（' + (error?.message ?? error) + '）');
    return { migrated: false, reason: 'write-failed' };
  }

  logger?.info?.('dsh-ace: 已把旧设置从 ' + fromPath + ' 复制到 ' + toPath + '（旧文件保留未动）');
  return { migrated: true, reason: 'copied', from: fromPath, to: toPath };
}
