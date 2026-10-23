// dsh-ace 通知消息的形状守卫（lib/notice.js）测试 + lib/index.js 的源码级回归断言。
//
// 为什么这份测试是「防会话坏死」而不是普通单测：
// 宿主 createUserMessage 不做形状校验（~\@deepseek-ai\dsh-llm\lib\types\message.js:34-39
// createMessage、:53-58 createUserMessage 只 spread + deepFreeze(structuredClone)），
// 但类型契约要求 content 是 readonly ContentBlock[]（同包 lib\types\message.d.ts:128）。
// 本插件曾在三处把 content 传成裸字符串，字符串原样进会话历史后，宿主里 52 处
// `.content.some(...)` 抛 TypeError: message.content.some is not a function；
// 那条毒消息留在历史里，之后每一轮重建上下文都再撞一次 —— 该会话永久坏死。
// 所以这里既直测形状（能 import 到纯模块），也读 lib/index.js 源码钉住每一个调用点
// （lib/index.js 顶层 import 宿主包，本仓库无 node_modules，测试里 import 不到，
// 做法与 tests/trajectory.test.mjs:408-471、tests/entries.test.mjs:69-90 同源）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { textBlocks, noticeMessage } from '../lib/notice.js';

const SHAPE_HINT = 'content 必须是 ContentBlock[]（MessageBase.content，'
  + '~\\@deepseek-ai\\dsh-llm\\lib\\types\\message.d.ts:128）：'
  + '裸字符串会让宿主 .content.some 抛错、那条毒消息留在历史里会让整个会话永久坏死';

test('T222 textBlocks: 恒为长度 1 的 [{type:"text", text}]，空串也照样成块', () => {
  assert.deepEqual(textBlocks('继续'), [{ type: 'text', text: '继续' }]);
  // 空串不许被优化成 []：[] 也是合法 ContentBlock[]，但会让通知变成一条空消息。
  assert.deepEqual(textBlocks(''), [{ type: 'text', text: '' }]);
  // 每次都要新数组，别让调用点之间共享同一个可变数组。
  assert.notEqual(textBlocks('x'), textBlocks('x'));
});

test('T223 textBlocks: 非字符串按 String 兜底，绝不在失败路径上再抛一个异常', () => {
  // null/undefined 变空串（`text ?? ''` 口径）。
  assert.deepEqual(textBlocks(undefined), [{ type: 'text', text: '' }]);
  assert.deepEqual(textBlocks(null), [{ type: 'text', text: '' }]);
  // 其余一律 String()：这三处全在失败/竞态路径上，抛错只会把「一条提示没发出去」
  // 升级成「整个空闲边沿炸掉」。
  assert.deepEqual(textBlocks(0), [{ type: 'text', text: '0' }]);
  assert.deepEqual(textBlocks(42), [{ type: 'text', text: '42' }]);
  assert.deepEqual(textBlocks(new Error('boom')), [{ type: 'text', text: 'Error: boom' }]);
  const block = textBlocks({ toString: () => 'obj' })[0];
  assert.equal(block.text, 'obj');
  assert.equal(typeof block.text, 'string', '结果必须是字符串，否则宿主渲染/序列化仍会怪掉');
});

test('T224 noticeMessage: content 是 ContentBlock[]，source 契约照旧（kind/form/summary）', () => {
  const msg = noticeMessage({ text: 'ACE 手册有 1 条改动因并发冲突未并入', summary: '摘要' });
  assert.ok(Array.isArray(msg.content), SHAPE_HINT);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'ACE 手册有 1 条改动因并发冲突未并入' }]);
  assert.equal(msg.source.kind, 'dsh-ace', 'source.kind 不许变（宿主按它归类通知）');
  assert.equal(msg.source.form, 'notice', 'form 必须仍是 notice');
  assert.equal(msg.source.summary, '摘要');
  // 返回的是「可直接喂 createUserMessage 的入参」，不许自己塞 id/role 之类的宿主字段。
  assert.deepEqual(Object.keys(msg).sort(), ['content', 'source']);
});

test('T225 noticeMessage: 参数缺失/畸形都不抛，形状照样合法', () => {
  const empty = noticeMessage();
  assert.deepEqual(empty.content, [{ type: 'text', text: '' }]);
  assert.equal(empty.source.kind, 'dsh-ace');
  assert.equal(empty.source.form, 'notice');
  assert.equal(empty.source.summary, '');
  // summary 是 notice 的必带字段，非字符串按 String 兜底而不是丢 undefined。
  assert.equal(noticeMessage({ text: 't', summary: 5 }).source.summary, '5');
  // kind 只接受非空字符串，其余回落默认值。
  assert.equal(noticeMessage({ text: 't', kind: '' }).source.kind, 'dsh-ace');
  assert.equal(noticeMessage({ text: 't', kind: 7 }).source.kind, 'dsh-ace');
  assert.equal(noticeMessage({ text: 't', kind: 'other' }).source.kind, 'other');
  assert.ok(Array.isArray(noticeMessage({ text: undefined }).content), SHAPE_HINT);
});

test('T226 lib/notice.js 红线：零 import（纯函数、不碰宿主包与磁盘）', () => {
  const path = fileURLToPath(new URL('../lib/notice.js', import.meta.url));
  const src = readFileSync(path, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), '不许有任何 import（含宿主包与 node 内置）：'
    + '宿主包在无 node_modules 的测试里加载不到，零依赖才能直测形状');
  assert.ok(!/require\s*\(/.test(src), '不许 require');
  assert.ok(!/\bfs\b\./.test(src), '不读盘');
});

// —— lib/index.js 源码级回归断言 ——
const indexSource = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');

/** 从 source[open]（必须是 '('）起截到配平的 ')'，返回括号内的实参源码。 */
function balancedArgs(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('括号不配平（从偏移 ' + open + ' 起）');
}

/** 取一段源码里的「首个非空行」（trim 后非空）；全空则返回空串。 */
function firstNonEmptyLine(src) {
  return src.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
}

/** 把一段源码压成一行并限长，只用于报错文案（便于一眼看出检查器到底看到了什么）。 */
function snippet(src, max = 120) {
  const oneLine = src.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * 检查一段源码里每一个 createUserMessage(...) 的 content 形状。
 *
 * 合法只有三种：直接传数组字面量、或传返回数组的 textBlocks( / noticeMessage( 调用、
 * 或（对象字面量形态）content: 的值是上面两类之一。
 * 返回检出的调用点数；不合法的直接 assert 失败并带上 SHAPE_HINT。
 */
function checkCreateUserMessageContent(source, where) {
  const marker = 'createUserMessage';
  let count = 0;
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    from = at + marker.length;
    // 跳过 import 语句（import { createUserMessage } from ...）与行内注释里的提及。
    const lineStart = source.lastIndexOf('\n', at) + 1;
    const linePrefix = source.slice(lineStart, at);
    if (linePrefix.includes('//')) continue;
    const open = source.indexOf('(', at);
    if (open === -1) continue;
    const between = source.slice(at + marker.length, open);
    if (!/^\s*$/.test(between)) continue; // 不是调用（例如对象属性名、文档叙述）
    count++;
    const args = balancedArgs(source, open).trim();
    const label = where + ' 第 ' + count + ' 处 createUserMessage';
    let value;
    let shown;
    if (args.startsWith('{')) {
      const contentAt = args.indexOf('content:');
      assert.notEqual(contentAt, -1, label + ' 的入参对象必须有 content 字段');
      // 取 content: 之后的「首个非空行」——不是「第一行」：格式化工具按 80 列重排后
      // `content:` 与值分会两行，取第一行会拿到空串，把合法代码冤枉成非法。
      const rest = args.slice(contentAt + 'content:'.length);
      value = firstNonEmptyLine(rest);
      shown = snippet(rest);
    } else {
      value = firstNonEmptyLine(args);
      shown = snippet(args);
    }
    const legal = value.startsWith('[')
      || /^textBlocks\s*\(/.test(value)
      || /^noticeMessage\s*\(/.test(value);
    assert.ok(legal, label + ' 的 content 是「' + value + '」，不是 ContentBlock[]。'
      + '检查器实际看到的原文片段是「' + shown + '」。' + SHAPE_HINT);
    // 双保险：字符串字面量与裸标识符单独点名（报错文案要能直接指向缺陷）。
    assert.ok(!/^['"`]/.test(value), label + ' 的 content 是字符串字面量。'
      + '检查器实际看到的原文片段是「' + shown + '」。' + SHAPE_HINT);
    assert.ok(!/^[A-Za-z_$][\w$]*$/.test(value), label + ' 的 content 是裸标识符。'
      + '检查器实际看到的原文片段是「' + shown + '」。' + SHAPE_HINT);
  }
  return count;
}

// T227 的定位（别把它的分量看错，两个方向都要看清）：
// - 它是「防手滑把 content 写回裸字符串」的**绊线**，不是「证明形状正确」的**证明**。
//   它能抓住的是「照着当初那次事故的样子又写了一遍」；它不是类型检查器，也不会推理。
// - 已知漏点（刻意绕过时才有意义，别为此大改检查器：那是过度工程，验收已判定不阻塞）：
//   1. `content: [text]` —— 数组里塞裸字符串（只验了首字符是 '['）；
//   2. `content: textBlocks(t) + ''` —— 合法调用的返回值被拼成字符串；
//   3. `content: noticeMessage({text}).content.join('')` —— 取完又拼回裸字符串；
//   4. 别名调用 `const cum = createUserMessage; cum({...})` —— 计数 0，这条断言完全看不见；
//   5. `createUserMessage(['just a string'])` —— 数组字面量里的元素形状不管。
// - 它的价值在「有人为了让自己过而放宽它」时提醒：这条断言是唯一的绊线，放宽等于拆掉它。
test('T227 lib/index.js: 每一个 createUserMessage 的 content 都是 ContentBlock[]', () => {
  const count = checkCreateUserMessageContent(indexSource, 'lib/index.js');
  // 三处通知：并发冲突、自动复盘失败、/ace review。少一处说明有人把通知搬走/删了。
  assert.ok(count >= 3, '至少应有 3 处 createUserMessage（冲突/复盘失败/review），实际 ' + count + ' 处');
  // 三处都必须经 noticeMessage：它就是形状守卫本身。
  // 允许两处之间有空白/换行：`createUserMessage(\n  noticeMessage(...)` 是**同一种写法**，
  // 格式化工具按 80 列重排不该被判成「没走 noticeMessage」。严格度不变：仍然要求每一处都经它。
  const viaNotice = (indexSource.match(/createUserMessage\s*\(\s*noticeMessage\s*\(/g) || []).length;
  assert.equal(viaNotice, count, '每一处 createUserMessage 都必须经 noticeMessage( 造 content，'
    + '实际经 noticeMessage 的只有 ' + viaNotice + ' 处 / 共 ' + count + ' 处');
  // 老形状单独点名（报错信息要能直接指向那次事故）。
  assert.ok(!/content:\s*render(ReviewText|ConflictNotice)\(/.test(indexSource),
    '不许回退成 content: renderReviewText(...) / renderConflictNotice(...)。' + SHAPE_HINT);
  assert.ok(!/content:\s*(text|reason)\s*[,}]/.test(indexSource),
    '不许回退成 content: text / content: reason 这种裸标识符。' + SHAPE_HINT);
});

test('T228 形状检查器自证：裸字符串/裸标识符会被当场抓住（否则 T227 就是假绿）', () => {
  // 合成的坏源码：正是当初那次事故的形状（content 传裸字符串）。
  const badLiteral = "const m = createUserMessage({ content: 'ACE 自动复盘未完成：' + reason, source });";
  assert.throws(() => checkCreateUserMessageContent(badLiteral, 'fixture'),
    (err) => err.message.includes('不是 ContentBlock[]') && err.message.includes(SHAPE_HINT),
    'content 是字符串字面量时必须报错，并带上「会话永久坏死」的解释');
  const badIdent = 'const m = createUserMessage({ content: text, source });';
  assert.throws(() => checkCreateUserMessageContent(badIdent, 'fixture'),
    (err) => err.message.includes('不是 ContentBlock[]'));
  const badNoField = 'const m = createUserMessage({ source });';
  assert.throws(() => checkCreateUserMessageContent(badNoField, 'fixture'),
    (err) => err.message.includes('必须有 content 字段'));
  // 合法形态不许误报：数组字面量与两个返回数组的调用。
  assert.equal(checkCreateUserMessageContent('createUserMessage([{ type: "text", text: t }])', 'fixture'), 1);
  assert.equal(checkCreateUserMessageContent('createUserMessage(noticeMessage({ text }))', 'fixture'), 1);
  assert.equal(checkCreateUserMessageContent('createUserMessage(textBlocks(t))', 'fixture'), 1);
  // import 与注释里的提及不算调用点。
  assert.equal(checkCreateUserMessageContent("import { createUserMessage } from 'x';\n// createUserMessage(x)", 'fixture'), 0);
});

test('T229 lib/index.js: 三处通知的文案与 source 一字未改（这是形状修复，不是文案改版）', () => {
  // 复盘失败通知：正文与摘要保持原样，只换了 content 的形状。
  // 这里只钉字面量本身（形状由 T227 钉），所以不写 `text:`/`content:` 前缀。
  assert.ok(indexSource.includes("'ACE 自动复盘未完成：' + reason + '。本次沉淀的经验没有并入手册，可重试。'"),
    '复盘失败通知的正文不许改');
  assert.ok(indexSource.includes("'ACE 自动复盘未完成，经验未并入手册'"), '复盘失败通知的摘要不许改');
  // 并发冲突通知。
  assert.ok(indexSource.includes("'ACE 手册有 ' + conflicts.length + ' 条改动因并发冲突未并入'"),
    '并发冲突通知的摘要不许改');
  // /ace review：摘要由 items.length 拼出来，正文走 renderReviewText，两者必须仍在同一次注入里。
  // 这条只钉文案与 source（形状由 T227 钉），所以写成形状无关的匹配。
  assert.ok(/createUserMessage\([\s\S]{0,200}?renderReviewText\(items\)[\s\S]{0,120}?summary/.test(indexSource),
    '/ace review 注入必须仍用 renderReviewText 渲染正文、summary 变量原样传入');
});
