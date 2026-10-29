// dsh-ace 行为测试：oneShot 的 maxMs（第 45 轮复盘预算的最底层一环）。
//
// oneShot 原本只有一个模块级单次上限（ONESHOT_TIMEOUT_MS，第 49 轮由 75000ms 放宽到 150000ms，刻意不导出）。
// 第 45 轮起复盘预算会按剩余时间给每次调用派 maxMs，oneShot 取 min(默认, maxMs)。
// 这里不 import 宿主包：oneShot 只依赖 ctx.llm.stream 的形状（AsyncIterable、吃 options.signal），
// 用一个「挂住直到 signal abort、然后抛错」的假 provider 就能把超时分支真实踩到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { oneShot } from '../lib/llm.js';
import { RECAP_TOTAL_DEADLINE_MS } from '../lib/recap-queue.js';

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
  assert.ok(took >= 70 && took < 3000, '80ms 上限要真的生效（而不是等 150s 默认值）：' + took + 'ms');
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

// ── 第 48 轮健壮性缺口 B1：正文为空时说得清，而不是把空串交给上层去猜 ──
// 线上那一次：模型把整段内容写进 reasoning 通道，text-delta 一个都没来，oneShot 返回 ''，
// extractJsonObject 在空串上抛「未找到 JSON 对象」，耗时 72 秒（对方正常结束，不是超时）。
// 现在 oneShot 自己抛一条带现场的错误，且**必须是普通错误** —— 不许被当成超时吞掉。

test('R48 oneShot｜只有 reasoning-delta、没有 text-delta → 抛「正文为空」并带上 reasoning 字符数、耗时、provider/model', async () => {
  const ctx = {
    llm: {
      async *stream() {
        // 模拟线上那一趟：思考内容全在 reasoning 通道里，正文一格不留。
        yield { type: 'reasoning-delta', text: '我在想该怎么回答'.repeat(10) }; // 8 × 10 = 80 字符
        yield null; // 畸形块不许炸
        yield { type: 'reasoning-delta', text: '嗯'.repeat(20) }; // +20 = 100 字符
        yield { type: 'text-delta', text: '   ' }; // 纯空白也算空正文
      },
    },
  };
  const t0 = Date.now();
  await assert.rejects(
    oneShot(ctx, { provider: 'magpie', model: 'group/never-stuck', system: 's', userText: 'u' }),
    (e) => {
      const msg = e && e.message;
      assert.ok(typeof msg === 'string' && msg.startsWith('ace: LLM 本次正文为空'), '必须是「正文为空」这条明确错误：' + msg);
      assert.ok(msg.includes('reasoning 100 字符'), '要写 reasoning 通道收到多少字符（判断是不是全写进推理了）：' + msg);
      assert.ok(/耗时 \d+ms/.test(msg), '要写耗时（判断是正常结束还是被截断）：' + msg);
      assert.ok(msg.includes('magpie/group/never-stuck'), '要写 provider/model（判断是不是换了模型）：' + msg);
      // 硬约束：这句话绝不能出现 —— 否则 lib/reflect.js 的 isTimeoutError 会把它当超时豁免掉，
      // 真故障被静默吞成「本轮放弃」，复盘变成假成功。
      assert.ok(!msg.includes('调用超时'), '不许带「调用超时」字样：' + msg);
      return true;
    },
  );
  const took = Date.now() - t0;
  assert.ok(took < 3000, '空正文要立刻报错，不许等到超时：' + took + 'ms');
});

test('R48 oneShot｜错误不是超时：lib/reflect.js 的 isTimeoutError 口径（按 ace: LLM 调用超时 前缀认账）认不出来', async () => {
  // 这一条不复用 reflect.js 的内部函数，直接按它的判据（startsWith 前缀）检查，
  // 免得为了一个字符串断言去 import 宿主相关模块。
  const ctx = { llm: { async *stream() { yield { type: 'reasoning-delta', text: '只有思考' }; } } };
  const err = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error, '空正文必须抛错');
  assert.equal(String(err.message).startsWith('ace: LLM 调用超时'), false, '不许被 isTimeoutError 认成超时');
  assert.ok(err.message.startsWith('ace:'), '仍带 ace: 前缀，方便日志 grep');
});

test('R48 oneShot｜正常流不受影响：text-delta 照常累加，reasoning 不混进返回值', async () => {
  const ctx = {
    llm: {
      async *stream() {
        yield { type: 'reasoning-delta', text: '内部思考不该出现在结果里' };
        yield { type: 'text-delta', text: '{"candidates":' };
        yield { type: 'text-delta', text: '[]}' };
      },
    },
  };
  const out = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u' });
  assert.equal(out, '{"candidates":[]}', '正文串接结果不含 reasoning 内容');
});

// ── 第 49 轮：finish 块的终止原因（超时被伪装成「JSON 未闭合」的真因） ──
// 宿主流被取消时**不抛错**：dsh-llm-pi-ai lib/index.js:1638-1650 先 yield 一个 finish 块
// （reason.kind = 'aborted'）再 return；而旧版循环只认 text-delta，于是半截正文被当成功返回，
// 上层 extractJsonObject 报「JSON 对象不完整（从第 1 字起未闭合）」。下面三条钉住新的语义。

/** 假 provider：先吐一段正文，再给一个终止 finish 块（宿主的真实收尾形态）。 */
function finishCtx(text, reason) {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason };
      },
    },
  };
}

test('R49 oneShot｜只来 text-delta 再来 finish{reason:{kind:aborted}} → 抛「调用超时」并带已收字符数与上限', async () => {
  const ctx = finishCtx('{"candidates":[{"title":"半截', { kind: 'aborted', failure: { message: 'pi-ai stream aborted', code: 'ABORTED' } });
  const err = await oneShot(ctx, { provider: 'magpie', model: 'group/never-stuck', system: 's', userText: 'u', maxMs: 1234 }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error, 'aborted finish 必须抛错，绝不许把半截正文当结果返回');
  const msg = String(err.message);
  assert.ok(msg.startsWith('ace: LLM 调用超时'), '前缀必须是 isTimeoutError 认的那一条（复盘据此「只放弃本轮」）：' + msg);
  assert.ok(msg.includes('单次上限 1234ms'), '要写实际生效的上限，而不是模块默认值：' + msg);
  assert.ok(msg.includes('已收正文 ' + '{"candidates":[{"title":"半截'.length + ' 字符'), '要写已收正文字符数：' + msg);
  assert.ok(msg.includes('magpie/group/never-stuck'), '要写 provider/model：' + msg);
  assert.ok(msg.includes('pi-ai stream aborted') && msg.includes('code=ABORTED'), '上游 failure 的 message/code 原样带上：' + msg);
});

test('R49 oneShot｜调用方自己取消（外层 signal 已中止）时的 aborted 不算本层超时：不带「调用超时」前缀', async () => {
  // 取舍说明：外部取消（总时限到点、回合被停）不该让整份复盘按「按已提炼候选收尾」假成功，
  // 所以这条文案刻意不以 'ace: LLM 调用超时' 开头 —— lib/reflect.js 的 isTimeoutError 认不出来。
  const outer = new AbortController();
  outer.abort();
  const ctx = finishCtx('前半截', { kind: 'aborted', failure: { message: 'aborted by caller', code: 'ABORTED' } });
  const err = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u', signal: outer.signal }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error, '取消也必须抛错');
  assert.equal(String(err.message).startsWith('ace: LLM 调用超时'), false, '外部取消不许被 isTimeoutError 认成超时：' + err.message);
  assert.ok(String(err.message).includes('被取消'), '要明说是调用方取消：' + err.message);
});

test('R49 oneShot｜finish{reason:{kind:max-tokens}} → 抛「输出被 max-tokens 截断」并带字符数与 provider/model', async () => {
  const body = '{"candidates":[{"title":"A","condition":"c","action":"a","rationale":"r"}]';
  const ctx = finishCtx(body, { kind: 'max-tokens' });
  const err = await oneShot(ctx, { provider: 'magpie', model: 'group/never-stuck', system: 's', userText: 'u' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error, 'max-tokens 截断必须抛错');
  const msg = String(err.message);
  assert.ok(msg.includes('输出被 max-tokens 截断'), '必须写明是 max-tokens 截断：' + msg);
  assert.ok(msg.includes('已收正文 ' + body.length + ' 字符'), '要写已收字符数：' + msg);
  assert.ok(msg.includes('magpie/group/never-stuck'), '要写 provider/model：' + msg);
  assert.ok(!msg.includes('调用超时'), '截断不是超时，不许混用文案：' + msg);
});

test('R49 oneShot｜finish{reason:{kind:error}} → 上游 reason/message/code 原样带上', async () => {
  const ctx = finishCtx('', { kind: 'error', failure: { message: 'upstream 502 bad gateway', code: 'PROVIDER_ERROR', status: 502 } });
  const err = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u' }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof Error, 'error finish 必须抛错');
  const msg = String(err.message);
  assert.ok(msg.includes('finish reason=error'), '要标明是 finish 的 error：' + msg);
  assert.ok(msg.includes('upstream 502 bad gateway') && msg.includes('code=PROVIDER_ERROR') && msg.includes('status=502'), '上游信息原样带上：' + msg);
});

test('R49 oneShot｜finish{reason:{kind:stop}} 照常返回：正常收尾行为一字不变', async () => {
  const ctx = finishCtx('{"candidates":[]}', { kind: 'stop' });
  const out = await oneShot(ctx, { provider: 'p', model: 'm', system: 's', userText: 'u' });
  assert.equal(out, '{"candidates":[]}');
});

test('R49 oneShot｜两个时间常量：单次上限 150000ms、复盘总时限 300000ms（后者 ≥ 2 倍前者）', async () => {
  // ONESHOT_TIMEOUT_MS 刻意不导出（模块内常量，见 lib/llm.js 头注），行为上只能靠「等 150 秒」观测 ——
  // 代价太大。所以这里读源码钉住字面量：默认值有三处（正常值、env 非法值、env 读取异常三条 return），
  // 全都要是 150000，少改一处就会让 env 非法时的回落值悄悄退回旧值。
  const fsmod = await import('node:fs');
  const source = fsmod.readFileSync(new URL('../lib/llm.js', import.meta.url), 'utf8');
  const defaults = source.match(/150000;/g) || [];
  assert.equal(defaults.length, 3, 'lib/llm.js 的三处默认单次上限都必须是 150000（改前为 75000）：正常值 / env 非法值 / env 读取异常');
  assert.equal(source.includes('return 75000;'), false, '不许残留旧的 75000 默认值');
  assert.ok(source.includes("process.env.ACE_ONESHOT_TIMEOUT_MS"), 'env 覆盖逻辑必须保留');
  // 配比：总时限要容得下两次单次上限（300000 = 2 × 150000），且单次上限不超过总时限的 2/3（150000 ≤ 200000）。
  assert.equal(RECAP_TOTAL_DEADLINE_MS, 300000, '复盘总时限应为 300000ms（改前 120000）');
  assert.ok(RECAP_TOTAL_DEADLINE_MS >= 2 * 150000, '总时限必须容得下两次单次上限：' + RECAP_TOTAL_DEADLINE_MS);
  assert.ok(150000 <= (RECAP_TOTAL_DEADLINE_MS * 2) / 3, '单次上限必须 ≤ 总时限的 2/3');
});
