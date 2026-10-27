// dsh-ace 行为测试：oneShot 的 maxMs（第 45 轮复盘预算的最底层一环）。
//
// oneShot 原本只有一个模块级单次上限（ONESHOT_TIMEOUT_MS，默认 75000ms，刻意不导出）。
// 第 45 轮起复盘预算会按剩余时间给每次调用派 maxMs，oneShot 取 min(默认, maxMs)。
// 这里不 import 宿主包：oneShot 只依赖 ctx.llm.stream 的形状（AsyncIterable、吃 options.signal），
// 用一个「挂住直到 signal abort、然后抛错」的假 provider 就能把超时分支真实踩到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { oneShot } from '../lib/llm.js';

/** 假 provider：挂到 signal abort 再抛错（真实 provider 被取消的最坏形态）。 */
function hangCtx() {
  return {
    llm: {
      async *stream(options) {
        const signal = options.signal;
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('stream aborted by signal');
      },
    },
  };
}

test('R45 oneShot｜maxMs 把单次上限压小：到点抛「单次上限 Nms」前缀错，前缀被 reflect.js 认账', async () => {
  const ctx = hangCtx();
  const t0 = Date.now();
  await assert.rejects(
    oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u', maxMs: 80 }),
    (e) => {
      const msg = e && e.message;
      assert.ok(typeof msg === 'string' && msg.startsWith('ace: LLM 调用超时'), '前缀不许变（reflect.js 的 isTimeoutError 靠它收尾）：' + msg);
      assert.ok(msg.includes('单次上限 80ms'), '报错要写实际生效的上限（不是模块默认）：' + msg);
      return true;
    },
  );
  const took = Date.now() - t0;
  assert.ok(took >= 70 && took < 3000, '80ms 上限要真的生效（而不是等 75s 默认值）：' + took + 'ms');
});

test('R45 oneShot｜maxMs 非法（0）当没传：cap 回到默认；外层 signal 先断则原样 rethrow（不加前缀）', async () => {
  const ctx = hangCtx();
  const outer = AbortSignal.timeout(120);
  await assert.rejects(
    oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u', signal: outer, maxMs: 0 }),
    (e) => {
      const msg = e && e.message;
      assert.equal(msg, 'stream aborted by signal', '外层取消必须原样透传（旧语义）：' + msg);
      return true;
    },
  );
});

test('R45 oneShot｜maxMs 之下正常完成照常返回（预算只截断，不影响正常流）', async () => {
  const ctx = {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text: '你好' };
        yield { type: 'text-delta', text: '，世界' };
      },
    },
  };
  const out = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u', maxMs: 5000 });
  assert.equal(out, '你好，世界');
});
