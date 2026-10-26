// dsh-ace 的系统提示段文本（C5.2）：**只有逐字常量**的机制说明。
//
// 为什么单独一层：宿主在每次装配系统提示时**同步**调用 section.text(context)
// （dsh-system-prompt\lib\index.js:388，契约见 dsh-system-prompt\lib\types\index.d.ts:60）。
// 回调里抛错会拖垮整次提示装配，所以本函数绝不抛错。
//
// 前缀缓存红线（第 28 轮）：这段文本**不许再随任何运行状态变化**。
// 系统提示在请求最前面，路由（magpie/group/never-stuck）没有声明 systemPromptUpdate:'in-history'，
// 宿主只能把渲染文本原地重写进首个系统节点 —— 只要这段文本变一个字，从注入点往后
// （系统提示 25.0% 处）的整段缓存前缀就作废。实测：切换请求的 cached 恒为 8,320 tok，
// 73 次切换累计重付 926.0K token。所以：
//   - 注入块已整体搬到 agent/pre-step 的追加消息里（lib/inject-delivery.js）；
//   - merge-inbox 的「手册里有 N 条疑似重复条目」动态句也已删除（它同样会改前缀）；
//   - 这里只剩「不随状态变化」的机制说明（autoRecap / autoReflect 两个开关的措辞 + 手册路径，
//     两者都来自配置，同一会话内恒定）。

/**
 * 生成系统提示段文本。
 *
 * @param {object} spec
 * @param {boolean} spec.autoRecap - 自动复盘已开（措辞改为「采集已自动」）
 * @param {boolean} spec.autoReflect - 手动复盘已开（保留「要求模型主动复盘」的措辞）
 * @param {string} spec.pathText - 手册路径展示文本
 * @returns {string} 系统提示段文本（绝不抛错；不含任何随运行状态变化的片段）
 */
export function playbookSectionText(spec = {}) {
  const { autoRecap, autoReflect, pathText } = spec;
  const lines = [];
  if (autoRecap) {
    lines.push(
      '【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，' + pathText + '）。',
      '- 采集已自动——回合真正结束时会自动复盘归档；你只需在遇同类任务前用 ace_playbook 查旧经验。',
      '- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。',
    );
  } else if (autoReflect) {
    lines.push(
      '【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，' + pathText + '）。',
      '- 开始一个与既往经验可能相关的任务前，先用 ace_playbook 查阅手册，命中经验就照做。',
      '- 完成一个有实质工作量的任务（排障/实现/重构/调研等）之后，主动调用 ace_reflect 复盘：',
      '  给出任务摘要与轨迹要点，由它产出候选经验；',
      '- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。',
    );
  } else {
    return '';
  }
  // 这里**不许**再 push 任何随状态变化的片段（注入块、inbox 计数…）：
  // 每变一个字，宿主就要原地重写系统提示节点，注入点之后的缓存前缀全部重算。
  return defuseTemplateSyntax(lines.join('\n'));
}

/** 系统提示段在宿主里的注册名（dsh-system-prompt 用它做 section 的身份）。 */
export const PLAYBOOK_SECTION_NAME = 'ace-playbook';
/** 系统提示段的排序位（排在宿主其它段之后、工具说明之前）。 */
export const PLAYBOOK_SECTION_ORDER = 860;

/**
 * 产出 `ctx.systemPrompt.section(...)` 的注册选项（P0-3）。
 *
 * 为什么单独做成工厂而不是在 lib/index.js 里就地写字面量：`interpolate: false` 是
 * **安全红线**而不是可选样式 —— 宿主的 interpolate() 遇到手册正文里的 `{{...}}` 会硬抛
 * （dsh-system-prompt\lib\index.js:158-181），而 agent-loop 的 renderPrompt 没有 try/catch、
 * kick() 是 catch (_error) {}，一次抛错会让整个 agent 回合被静默终止。
 * lib/index.js 依赖宿主包、在 node --test 里加载不到，所以把这段配置抽成纯函数放在这里，
 * 让 tests/prompt-section.test.mjs 能**直接断言生产同款对象**（不是源码正则）。
 *
 * 契约见宿主 dsh-system-prompt\lib\index.js:118：`section.interpolate === false`
 * 时直接取 section.text、完全不做变量替换；types/index.d.ts:58-62 亦写明
 * "false preserves literal text"。
 *
 * @param {{text: (context?: object) => string}} spec
 * @returns {{name: string, order: number, interpolate: false, text: Function}}
 */
export function playbookSectionSpec(spec = {}) {
  return {
    name: PLAYBOOK_SECTION_NAME,
    order: PLAYBOOK_SECTION_ORDER,
    // 绝不改成 true：改了就等着某天手册里出现 {{...}} 时静默炸掉整个回合。
    interpolate: false,
    text: spec.text,
  };
}

/**
 * 把 `{{` 安全化成 `{ {`（P0-3 的第二道保险）。
 *
 * 为什么需要：宿主 @deepseek-ai/dsh-system-prompt 的 interpolate() 对 section 文本里的
 * `{{...}}` 做变量替换，遇到非法变量名会**硬抛**
 * （dsh-system-prompt\lib\index.js:158-181，报
 *  malformed prompt variable reference "{{ user_name }}" in section "ace-playbook"）；
 * 而 agent-loop 的 renderPrompt 没有 try/catch、kick() 是 catch (_error) {} ——
 * 一次抛错会让整个 agent 回合被静默终止，用户什么都看不到。
 * 手册条目里写模板语法 / Jinja / 代码片段极其常见，所以：
 *   1) 接线处已经声明 interpolate:false（lib/index.js 的 systemPrompt.section，宿主原生支持）；
 *   2) 这里再把 `{{` 换成 `{ {` —— 即使将来有人漏掉那一行、或宿主换实现，
 *      渲染出来的文本也不再含 `{{`，interpolate 无从抛错，双保险。
 *
 * 只动 `{{` 这一种会被宿主当成变量引用的形状；单个 `{`、`{x}` 都原样保留。
 *
 * @param {string} text
 * @returns {string}
 */
export function defuseTemplateSyntax(text) {
  if (typeof text !== 'string') return '';
  try {
    return text.split('{{').join('{ {');
  } catch {
    // 理论上不可达（字符串 split/join 不会抛）；真抛了也绝不能拖垮宿主提示装配。
    return text;
  }
}
