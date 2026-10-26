// 毫秒精度时间戳（本地时区 ISO，形如 2026-10-25T06:12:33.412+08:00）。
//
// 为什么要有这个模块：条目的 created / updated / lastHit 三字段既要「人能读」
// （界面上只显示到日），又要「能排序」（同一毫秒内的先后、同一天内的先后）。
// 只有日期时，同一天创建的条目顺序完全丢失，淘汰顺序（created 更早的先走）
// 就退化成靠 id 猜 —— 那是把判据交给偶然因素。
//
// 本模块零 import（除 Date 本身），供 lib/entry-format.js 使用。
//
// 形状契约：YYYY-MM-DDTHH:mm:ss.SSS±HH:MM
// - 定长、本地时区偏移显式写出 → **字典序即时间序**（同一时区内）；
// - 日期部分就是 YYYY-MM-DD，界面上取前 10 个字符即可（dayOf）。
//
// 旧格式（只有 YYYY-MM-DD）照常解析：它天然小于同一天的任意毫秒时刻，
// 字符串比较仍然是「那天 00:00」的语义，不需要补零、不需要特殊分支。

/** 两位补零。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 三位补零（毫秒）。 */
function pad3(n) {
  return String(n).padStart(3, '0');
}

/**
 * 本地时区偏移，形如 +08:00 / -05:00 / +00:00。
 * getTimezoneOffset 返回「UTC - 本地」的分钟数，符号与 ISO 相反。
 */
export function offsetSuffix(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/**
 * 当前时刻的毫秒时间戳（本地时区 ISO）。
 * 传 date 可注入固定时刻（测试用）；非法 date 退回当前时刻，绝不抛错。
 */
export function nowStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes()) +
    ':' + pad2(d.getSeconds()) +
    '.' + pad3(d.getMilliseconds()) +
    offsetSuffix(d)
  );
}

/**
 * 从任意时间戳取值里取出日期部分（YYYY-MM-DD）；取不到返回空串。
 * 排序一律用 nowStamp 的全精度；界面**只到日**这条承诺由 `client.js` 的 `displayDay` 兑现
 * （记录页行日期 / 统计页最近更新 / 归档行日期三处都走它，tests/client-entries.test.mjs 与
 * tests/client-stats.test.mjs 经真实渲染断言 10 字符日期守着）。本函数只给服务端统计落桶用。
 */
export function dayOf(value) {
  const s = String(value ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

/** 是否是可比较的时间戳（日期形态或毫秒形态都算）。 */
export function isStamp(value) {
  return dayOf(value) !== '';
}

/**
 * 时间戳比较：a 早于 b 返回负数，晚于返回正数，相等（含都为空）返回 0。
 * 空串视为「最小」—— 旧条目缺字段时排在最早，与「created 更早的先走」一致。
 */
export function compareStamps(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
