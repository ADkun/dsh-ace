// dsh-ace 行为测试：复盘失败现场的落盘（健壮性缺口 B2，lib/raw-log.js）。
//
// 这个模块的全部价值是「下次炸了能看见现场」，所以它自己绝不能成为新的故障源：
// 一切失败全吞、任何情况下不 reject、ACE_RAW_LOG=0 时连目录都不建、只保留最近 20 条。
// 这里用 os.tmpdir() 下的临时 DSH_HOME 真跑文件系统（落点是 DSH_HOME 派生的，不需要动真实 ~/.dsh）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dumpRaw, flushRawLog, resolveRawLogFile } from '../lib/raw-log.js';

/** 建一个临时 DSH_HOME 并把 process.env.DSH_HOME 指过去；返回 { dir, file, restore }。 */
function withTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-rawlog-'));
  const prevHome = process.env.DSH_HOME;
  const prevFlag = process.env.ACE_RAW_LOG;
  process.env.DSH_HOME = dir;
  delete process.env.ACE_RAW_LOG;
  return {
    dir,
    file: path.join(dir, 'ace', 'debug', 'raw.jsonl'),
    restore() {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      if (prevFlag === undefined) delete process.env.ACE_RAW_LOG;
      else process.env.ACE_RAW_LOG = prevFlag;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

test('R48 dumpRaw｜落点是 <DSH_HOME>/ace/debug/raw.jsonl，一行一个 JSON 且字段齐全', async () => {
  const home = withTempHome();
  try {
    const wrote = await dumpRaw({
      stage: 'reflect',
      round: 2,
      provider: 'magpie',
      model: 'group/never-stuck',
      raw: '{"candidates":[{"title":"半截',
      error: new Error('ace: LLM 输出中的 JSON 对象不完整（从第 0 字起未闭合）'),
    });
    await flushRawLog();
    assert.equal(wrote, true, '正常路径要真写进去');
    assert.equal(resolveRawLogFile(), home.file, '落点必须由 DSH_HOME 派生');
    const lines = readLines(home.file);
    assert.equal(lines.length, 1, '追加一行');
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.stage, 'reflect');
    assert.equal(rec.round, 2);
    assert.equal(rec.provider, 'magpie');
    assert.equal(rec.model, 'group/never-stuck');
    assert.equal(rec.rawLength, '{"candidates":[{"title":"半截'.length, 'rawLength 是原文全长');
    assert.equal(rec.raw, '{"candidates":[{"title":"半截');
    assert.ok(rec.error.includes('未闭合'), 'error 存 error.message：' + rec.error);
    assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at 必须是可解析的 ISO 时间：' + rec.at);
  } finally {
    home.restore();
  }
});

test('R48 dumpRaw｜原文超过 4000 字符只留前 4000，但 rawLength 记全长', async () => {
  const home = withTempHome();
  try {
    await dumpRaw({ stage: 'merge', raw: 'x'.repeat(4321), error: '失败了' });
    await flushRawLog();
    const rec = JSON.parse(readLines(home.file)[0]);
    assert.equal(rec.rawLength, 4321, 'rawLength 记全文长度');
    assert.equal(rec.raw.length, 4000, 'raw 只留前 4000 字符');
    assert.equal(rec.round, undefined, 'reflect 才有的字段不该凭空出现（每行都是真话）');
  } finally {
    home.restore();
  }
});

test('R48 dumpRaw｜只保留最近 20 条：写 21 次后文件里只剩 20 行，且丢的是最旧那条', async () => {
  const home = withTempHome();
  try {
    for (let i = 0; i < 21; i += 1) {
      await dumpRaw({ stage: 'reflect', raw: 'raw-' + i, error: 'err-' + i });
    }
    await flushRawLog();
    const lines = readLines(home.file);
    assert.equal(lines.length, 20, '上限 20 条');
    const records = lines.map((line) => JSON.parse(line));
    assert.equal(records[0].raw, 'raw-1', '最旧那条（raw-0）被丢掉');
    assert.equal(records[19].raw, 'raw-20', '最新那条在末尾');
    // 行里不许残留空行或半截 JSON —— 每条都得能单独 parse。
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    home.restore();
  }
});

test('R48 dumpRaw｜杀开关 ACE_RAW_LOG=0 / off：完全不写、连目录都不建', async () => {
  for (const flag of ['0', 'off', 'OFF']) {
    const home = withTempHome();
    try {
      process.env.ACE_RAW_LOG = flag;
      const wrote = await dumpRaw({ stage: 'reflect', raw: '不该落盘', error: 'x' });
      await flushRawLog();
      assert.equal(wrote, false, 'ACE_RAW_LOG=' + flag + ' 时必须不写');
      assert.equal(fs.existsSync(path.join(home.dir, 'ace')), false, 'ACE_RAW_LOG=' + flag + ' 时连目录都不许建');
    } finally {
      home.restore();
    }
  }
  // 其它值（含未设置）照常记 —— 默认是「记」，不是「不记」。
  const home = withTempHome();
  try {
    process.env.ACE_RAW_LOG = '1';
    assert.equal(await dumpRaw({ stage: 'reflect', raw: 'r', error: 'e' }), true, '只有 0 / off 才关');
    await flushRawLog();
  } finally {
    home.restore();
  }
});

test('R48 dumpRaw｜一切失败全吞：目录建不出来 / 畸形入参都不抛错（日志绝不许炸掉复盘）', async () => {
  const home = withTempHome();
  try {
    // 用一个文件占住 DSH_HOME，mkdir recursive 必然失败（ENOTDIR/EEXIST）。
    const blocker = path.join(home.dir, 'ace');
    fs.writeFileSync(blocker, 'not a directory');
    await assert.doesNotReject(dumpRaw({ stage: 'reflect', raw: 'r', error: 'e' }), '写不进去也必须静默');
    await flushRawLog();
    assert.equal(readLines(blocker).length, 1, '阻塞文件没被动过（我们没写进去）');
    // 畸形入参：undefined / null / 循环引用（JSON.stringify 会炸）都不许外抛。
    await assert.doesNotReject(dumpRaw(undefined));
    await assert.doesNotReject(dumpRaw(null));
    const cyclic = { stage: 'reflect' };
    cyclic.self = cyclic;
    // 循环引用只可能炸在 raw 上（raw 已被 String 化），这里主要确认「不认识的对象」不炸。
    await assert.doesNotReject(dumpRaw({ stage: 'reflect', raw: cyclic, error: cyclic }));
    await flushRawLog();
  } finally {
    home.restore();
  }
});

test('R48 dumpRaw｜并发的多次写入不互相覆盖（每次都落在同一份重写里）', async () => {
  const home = withTempHome();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => dumpRaw({ stage: 'merge', raw: 'c-' + i, error: 'e' })));
    await flushRawLog();
    const lines = readLines(home.file);
    assert.equal(lines.length, 10, '并发 10 次 → 10 行，一条都没丢');
  } finally {
    home.restore();
  }
});
