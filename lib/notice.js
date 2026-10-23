// 通知消息的 ContentBlock 形状守卫：把「一句话」包成宿主能接受的 content 数组。
//
// 为什么要有这个文件：宿主 `createUserMessage` 不做任何形状校验——它只 spread + deepFreeze(
// structuredClone(…))（~\@deepseek-ai\dsh-llm\lib\types\message.js:34-39 createMessage、
// :53-58 createUserMessage），所以传进去的 content 是什么形状就原样进会话历史。类型契约却要求
// `readonly ContentBlock[]`（同包 lib\types\message.d.ts:128），TextBlock = { type: 'text', text }
// （同包 lib\types\types.d.ts:46）。
//
// 真实事故：本插件曾在三处（冲突通知 / 自动复盘失败通知 / /ace review 注入）把 content 传成**裸字符串**。
// 字符串进了会话历史之后，宿主里 52 处 `.content.some(...)` 全部抛
// `TypeError: message.content.some is not a function`；更糟的是这条毒消息留在历史里，之后**每一轮**
// 重建上下文都会再撞一次——该会话从此每一轮第 1 步就失败，用户发「继续」也照样失败，永久坏死。
// 宿主侧「不做运行时校验」是既定契约（不在本插件能改的范围），所以守卫只能放在**生产消息的这一侧**：
// 三处一律经本模块造 content，别处不许再直接写字面量字符串。
//
// 硬约束：**只 import 标准 JS，不 import 任何宿主包**——宿主包在 node --test 里加载不到
// （本仓库无 node_modules，见 AGENTS.md 红线 5），零依赖才能让 tests/notice.test.mjs 直接 import 并断言形状。
// 本文件因此没有任何 import，纯函数、无副作用、不读盘。

/** 通知来源标识：宿主 `source.kind`，与 lib/index.js 里三处调用点保持一致。 */
const NOTICE_KIND = 'dsh-ace';

/**
 * 把任意文本包成宿主契约里的 ContentBlock[]（只含一个 TextBlock）。
 *
 * 为什么非字符串要兜底而不是抛错：这三处全在失败/竞态路径上（复盘失败、手册并发冲突），
 * 在那里再抛一个新异常，只会把「一条提示没发出去」升级成「整个空闲边沿炸掉」。
 * 兜底口径与仓库既有的防御写法一致：`String(text ?? '')`——null/undefined 变空串，
 * 其余（数字、对象、Error）走 String()，保证结果一定是字符串。
 *
 * @param {unknown} text - 要发的正文
 * @returns {Array<{type:'text', text:string}>} 恒为长度 1 的数组（即使 text 为空串）
 */
export function textBlocks(text) {
  return [{ type: 'text', text: text === undefined || text === null ? '' : String(text) }];
}

/**
 * 造一条通知消息的 `{ content, source }`，可直接喂给宿主的 createUserMessage。
 *
 * 为什么不在这里调 createUserMessage：那会把宿主 import 引进本模块，测试就 import 不动了
 * （见头注硬约束）。调用点写 `createUserMessage(noticeMessage({...}))` 即可。
 *
 * @param {object} params
 * @param {unknown} params.text - 正文（非字符串按 textBlocks 的口径兜底）
 * @param {unknown} params.summary - 必带的摘要（ContextForm 'notice' 的契约，
 *   ~\@deepseek-ai\dsh-llm\lib\types\message.d.ts:46-58,75-91）；缺失时按空串兜底
 * @param {string} [params.kind] - 来源 kind，默认 'dsh-ace'
 * @returns {{content: Array<{type:'text', text:string}>, source: {kind:string, form:'notice', summary:string}}}
 */
export function noticeMessage({ text, summary, kind } = {}) {
  return {
    content: textBlocks(text),
    source: {
      kind: typeof kind === 'string' && kind ? kind : NOTICE_KIND,
      form: 'notice',
      summary: summary === undefined || summary === null ? '' : String(summary),
    },
  };
}
