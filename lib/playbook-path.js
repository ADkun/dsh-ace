// 手册文件路径解析（纯逻辑，可独立测试）。
//
// 解析链（优先级从高到低）：
//   ① 绝对路径 —— 原样使用；同时支持 `~` / `~/` / `~\\` 前缀展开到用户主目录；
//   ② 相对路径 —— 相对会话工作目录 join，即「工作区私有层」（可随仓库进 git）；
//   ③ 空串 / 缺省 —— 本机共享层 `<DSH home>/ace/playbook.md`（跨工作区共用同一本手册）。
//
// DSH home 解析链（与 lib/settings-path.js 的既有范式一致）：
//   ctx.get('profileContext').home → $DSH_HOME → path.join(os.homedir(), '.dsh')
// env 与 home 都通过参数注入，便于测试（不依赖真实宿主与真实用户目录）。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - `~` 展开的官方实现：~\dsh-home-paths\lib\index.js:70
//   （`function expandHomePath(path) { if (path === "~") return homedir(); if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2)); return path; }`）；
// - DSH home 的官方解析：同文件 :109 `function resolveDshHome(configured, env = process.env)`，
//   内部走同文件 :83 `resolveRoot(configured, env, "DSH_HOME", () => join(homedir(), ".dsh"))`，
//   优先级 configured > $DSH_HOME > ~/.dsh，空/纯空白的 DSH_HOME 视为未设；
// - 「home 下再拼固定子目录」的先例：同文件 :124 `resolveAgentsHome`；
// - ProfileContext.home 字段：~\dsh-app-boot\lib\types\profile-context.d.ts:18（`readonly home: string;`），
//   类型定义整体在同文件 :10-25，只在 dsh 启动的 profile 里存在（同文件 :26-31 的
//   `declare module '@deepseek-ai/cordis'` 注释「Present only in a profile launched by dsh」）。
//
// 父目录：本模块只算路径，不建目录。落盘前的 mkdir(recursive) 由 writeFileAtomic 负责
// （lib/playbook.js:534-546，其中 :537 为 `await fs.mkdir(dir, { recursive: true });`）——
// 共享层的 `<DSH home>/ace` 首次使用时并不存在，readOrInitPlaybook（lib/playbook.js:614-624）
// 在 ENOENT 时会立刻 writeFileAtomic，靠的就是那句 mkdir 把父目录补出来。

import os from 'node:os';
import path from 'node:path';

/** 手册文件名（不随位置变化）。 */
export const PLAYBOOK_FILE_NAME = 'playbook.md';

/**
 * `playbookPath` 的默认值：**空串** = 本机共享层（<DSH home>/ace/playbook.md）。
 * 抽成纯逻辑常量是为了让单测能锁住这个核心契约——lib/index.js 无法在测试里
 * import（缺宿主依赖），但这里的常量可以。
 * 相对路径（如 '.ace/playbook.md'）= 该工作区私有，是**显式覆盖**出来的，不是默认值。
 */
export const DEFAULT_PLAYBOOK_PATH = '';

/**
 * `maxEntries` 的默认值：100 条。
 * 同上：抽成纯常量供单测断言，Config 的实际默认值仍由 lib/index.js 引用它定义。
 */
export const DEFAULT_MAX_ENTRIES = 100;

/** 共享层在 DSH home 下的子目录名：`<DSH home>/ace/playbook.md`。 */
export const SHARED_PLAYBOOK_DIR = 'ace';

/** 「相对路径但拿不到会话工作目录」时的统一错误文案（调用方直接抛出）。 */
export const RELATIVE_PATH_NEEDS_SESSION =
  'ace: 相对手册路径需要会话上下文（当前调用无 agent）；请把 playbookPath 设为绝对路径，或留空使用本机共享手册。';

/** 非空字符串才算「有值」：空串/纯空白一律当不存在（与 lib/settings-path.js:32-34 同口径）。 */
function usableDir(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 是否是 `~` 前缀（`~` 自身、`~/`、`~\\`；`~foo` 不算，那是字面目录名）。 */
function hasHomePrefix(value) {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

/**
 * 把 `~` 前缀展开成 home（与 @deepseek-ai/dsh-home-paths:70 的 expandHomePath 同语义）。
 * @param value 待展开的路径字符串。
 * @param home 用户主目录，默认 os.homedir()。
 */
export function expandHomePath(value, home = os.homedir()) {
  if (typeof value !== 'string' || value === '') return value;
  if (!hasHomePrefix(value)) return value;
  const base = usableDir(home) ?? os.homedir();
  if (value === '~') return base;
  return path.join(base, value.slice(2));
}

/**
 * 从 ctx 上取 profile 的 home；profileContext 可能不存在（非 profile 启动的宿主），
 * 也可能 ctx 只是个没有 get 的假对象（测试），一律容错返回 undefined。
 * 与 lib/settings-path.js:40-54 的 profileDirOf 同形状，只换字段名。
 */
function profileHomeOf(ctx) {
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
  return usableDir(profile.home);
}

/**
 * DSH home 绝对路径：profileContext.home 优先，其次 $DSH_HOME，最后 ~/.dsh。
 * @param ctx cordis 上下文（apply 里传进来）；可为 undefined。
 * @param env 环境变量来源，默认 process.env。
 * @param home home 目录，默认 os.homedir()。
 */
export function resolveDshHome(ctx, env = process.env, home = os.homedir()) {
  const base = profileHomeOf(ctx)
    ?? usableDir(env?.DSH_HOME)
    ?? path.join(usableDir(home) ?? os.homedir(), '.dsh');
  // 只展开 ~，不做 path.resolve：与 lib/settings-path.js:62-68 同口径（保留调用方给的形态）。
  return expandHomePath(base, home);
}

/** 共享层手册的绝对路径：`<DSH home>/ace/playbook.md`。 */
export function resolveSharedPlaybookFile(ctx, env = process.env, home = os.homedir()) {
  return path.join(resolveDshHome(ctx, env, home), SHARED_PLAYBOOK_DIR, PLAYBOOK_FILE_NAME);
}

/**
 * 只看配置值判断形态，不需要会话上下文（同步，供系统提示等同步场景用）。
 * @returns 'absolute' | 'relative' | 'shared'
 */
export function playbookPathKind(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') return 'shared';
  if (hasHomePrefix(value)) return 'absolute';
  return path.isAbsolute(value) ? 'absolute' : 'relative';
}

/**
 * 把配置值解析成手册的绝对路径。
 * @param configured Config.playbookPath（空串/undefined = 共享层）。
 * @param options ctx / workingDirectory（会话工作目录，相对路径必需）/ env / home。
 * @throws 相对路径且 workingDirectory 为空时抛 RELATIVE_PATH_NEEDS_SESSION。
 */
export function resolvePlaybookFile(configured, { ctx, workingDirectory, env = process.env, home = os.homedir() } = {}) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  const kind = playbookPathKind(value);
  if (kind === 'shared') return resolveSharedPlaybookFile(ctx, env, home);
  // 绝对路径「原样使用」：只展开 ~，不额外归一化（与 settings-path 同口径）。
  if (kind === 'absolute') return expandHomePath(value, home);
  const workdir = usableDir(workingDirectory);
  if (!workdir) throw new Error(RELATIVE_PATH_NEEDS_SESSION);
  return path.join(workdir, value);
}
