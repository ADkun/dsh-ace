// 复盘失败现场的落盘记录（健壮性缺口 B2）。
//
// 为什么要有这个文件：线上那次「LLM 输出中未找到 JSON 对象」的失败，事后能拿到的只有一句话通知 ——
// 模型到底吐了什么、吐了多少字、是空串还是一段散文，全都没有记录，只能靠源码考古去推断。
// 现在两条解析失败路径（反思轮的 extractJsonObject、合并的 parseMergeResult）在失败时各记一份原文，
// 落进 <DSH_HOME>/ace/debug/raw.jsonl，下次再炸能直接看见现场。
//
// 三条硬约束（都是本仓库的既有惯例，改动时别松）：
//   1. 一切失败全吞：目录建不出、写不进、JSON 序列化炸 —— 全部内部 catch，这个函数**任何情况下都不 reject**。
//      日志是为了排查复盘，绝不能反过来把复盘炸掉。
//   2. 杀开关：ACE_RAW_LOG=0 / 'off' 时完全不写、连目录都不建（线上不想要这份文件的人一个字节都不该被创建）。
//   3. 零宿主依赖：只许用 node: 内置（node:fs / node:path / node:os），且**不许** import 插件其它 lib
//      （避免与 lib/index.js、lib/merge-llm.js 形成循环依赖）。
//
// 锁纪律：调用点都在 withExclusiveLock 之外（解析发生在锁外、落盘才进锁），本模块自己也绝不加锁。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 文件里只保留最近这么多条；超了就把最旧的丢掉重写（简单可靠，不搞索引）。 */
const RAW_LOG_LIMIT = 20;
/** 单条记录里原文的最大保留字符数：够看出「空串 / 散文 / 半截 JSON」，又不至于把文件撑爆。 */
const RAW_SNIPPET_MAX = 4000;

/** 杀开关：只有明确写成 0 或 off 才关；其它任何值（含未设置）都照常记。 */
function rawLogDisabled() {
  const flag = String(process.env.ACE_RAW_LOG ?? '').trim().toLowerCase();
  return flag === '0' || flag === 'off';
}

/** 落点解析：<DSH_HOME>/ace/debug/raw.jsonl，DSH_HOME 缺省为本机 ~/.dsh（与手册同一层）。 */
export function resolveRawLogFile(env = process.env) {
  const home = String((env && env.DSH_HOME) || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'ace', 'debug', 'raw.jsonl');
}

/** 把任意错误取成一行字符串（error 可能是 Error、字符串或垃圾，全都兜住）。 */
function errorText(error) {
  if (!error) return '';
  try {
    if (typeof error === 'string') return error;
    return String(error.message || error);
  } catch {
    return '';
  }
}

/** 把一次失败组装成要落盘的一行记录（序列化失败由外层 catch 兜）。 */
function buildRecord(input) {
  const src = input && typeof input === 'object' ? input : {};
  const raw = typeof src.raw === 'string' ? src.raw : String(src.raw ?? '');
  const record = {
    at: new Date().toISOString(),
    stage: src.stage === 'merge' ? 'merge' : 'reflect',
    rawLength: raw.length,
    raw: raw.slice(0, RAW_SNIPPET_MAX),
    error: errorText(src.error),
  };
  // 选填字段：没有就不写空壳，让每一行都是真话。
  if (src.round !== undefined && src.round !== null) record.round = src.round;
  if (src.provider) record.provider = String(src.provider);
  if (src.model) record.model = String(src.model);
  return record;
}

/** 读历史行：文件不存在 / 读不出来一律当空，绝不上抛。 */
async function readLines(file) {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return String(text).split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

// 写盘串行化：两份复盘同时炸也不会互相覆盖掉一行（本项目本就单进程，这条只是保险）。
let writeChain = Promise.resolve();

/**
 * 记一条失败现场。await 它只是为了不留下悬空 promise，**它永远不 reject、永远不改变调用方的错误语义**。
 * @param {{stage?: 'reflect'|'merge', round?: number, provider?: string, model?: string,
 *          raw?: string, error?: unknown}} input
 * @returns {Promise<boolean>} 真写进去了才 true（杀开关关掉、或任何一步失败都是 false）
 */
export async function dumpRaw(input) {
  const appendOne = async () => {
    try {
      if (rawLogDisabled()) return false;
      const record = buildRecord(input);
      const line = JSON.stringify(record);
      const file = resolveRawLogFile();
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const lines = await readLines(file);
      lines.push(line);
      const kept = lines.length > RAW_LOG_LIMIT ? lines.slice(lines.length - RAW_LOG_LIMIT) : lines;
      await fs.promises.writeFile(file, kept.join('\n') + '\n', 'utf8');
      return true;
    } catch {
      return false;
    }
  };
  // 前一次写失败也不许断链：catch 之后再接下一次。
  const run = writeChain.then(appendOne, appendOne);
  writeChain = run.catch(() => {});
  try {
    return await run;
  } catch {
    return false;
  }
}

/**
 * 等所有已排队的 raw 写入落定（永不 reject）。
 * 给调用方留一个「想确认真写进去了」的抓手：dumpRaw 本身是 fire-and-forget 语义
 * （同步调用点不必为日志改成 async），需要确定性时 await 这个即可（测试用它，生产不需要）。
 */
export async function flushRawLog() {
  try {
    await writeChain;
  } catch {
    /* 铁律：日志绝不外抛 */
  }
}
