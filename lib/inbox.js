// dsh-ace merge-inbox 操作。
//
// inbox 是一个 JSON 数组文件（.ace/merge-inbox），存储疑似重复的 playbook 条目。
// 写入走 tmp+rename 原子写（红线 2：写入只走 withLock+writeFileAtomic，inbox 同理）；
// 调用侧用 withExclusiveLock（withLock + withFileLock）把「读 inbox → 加条目 → 写回」
// 整段包住，跨进程并发不会互相覆盖。
// 封顶 INBOX_CAP=20 条：满了暂停 auto-recap 的 add，systemPrompt 里给硬提醒。

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './playbook.js';

export const INBOX_CAP = 20;

/**
 * 读取 inbox 文件。
 * @param {string} file - inbox 文件路径
 * @returns {Promise<Array>} inbox 条目数组（空文件或不存在返回 []）
 */
export async function readInbox(file) {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const items = JSON.parse(text);
    return Array.isArray(items) ? items : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 原子写 inbox 文件（tmp+rename，复用 playbook.js 的 writeFileAtomic）。
 * @param {string} file - inbox 文件路径
 * @param {Array} items - 要写入的条目数组
 * @returns {Promise<void>}
 */
export async function writeInboxAtomic(file, items) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  await writeFileAtomic(file, JSON.stringify(items, null, 2));
}

/**
 * 纯函数：往 inbox 数组里加一条，如果满了（达到 cap）则不加入。
 * @param {Array} items - 现有条目数组
 * @param {object} item - 要加入的条目
 * @param {number} [cap=INBOX_CAP] - 封顶数
 * @returns {{items: Array, capped: boolean}} 新数组和是否被封顶
 */
export function addToInbox(items, item, cap = INBOX_CAP) {
  const arr = Array.isArray(items) ? items.slice() : [];
  if (arr.length >= cap) {
    return { items: arr, capped: true };
  }
  arr.push(item);
  return { items: arr, capped: false };
}

/**
 * 纯函数：判定 inbox 是否已满。
 * @param {Array} items - 现有条目数组
 * @param {number} [cap=INBOX_CAP] - 封顶数
 * @returns {boolean}
 */
export function inboxFull(items, cap = INBOX_CAP) {
  return (Array.isArray(items) ? items.length : 0) >= cap;
}
