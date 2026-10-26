// dsh-ace 单元测试：系统提示段文本。
//
// 第 28 轮改造后的契约（前缀缓存红线，见 lib/prompt-section.js 头注）：
// 这个 section 的文本**只许是逐字常量** —— 同样的开关与路径必须产出同样的字节。
// 注入块已搬到 agent/pre-step（tests/inject-delivery.test.mjs 钉住），
// merge-inbox 的「手册里有 N 条疑似重复条目」动态句已删除（它的出口变成 HTTP /inbox）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { playbookSectionText, playbookSectionSpec, defuseTemplateSyntax } from '../lib/prompt-section.js';

const BASE = { autoRecap: true, pathText: '/tmp/playbook.md' };

test('C5.2｜原有「【ACE 操作手册】…」提示文本逐字保留（autoRecap 分支）', () => {
  const text = playbookSectionText(BASE);
  assert.ok(text.startsWith('【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，/tmp/playbook.md）。'));
  assert.ok(text.includes('- 采集已自动——回合真正结束时会自动复盘归档；你只需在遇同类任务前用 ace_playbook 查旧经验。'));
  assert.ok(text.includes('- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。'));
});

test('C5.2｜autoReflect 分支的原有四行提示逐字保留', () => {
  const text = playbookSectionText({ autoRecap: false, autoReflect: true, pathText: '/tmp/p.md' });
  assert.ok(text.includes('- 开始一个与既往经验可能相关的任务前，先用 ace_playbook 查阅手册，命中经验就照做。'));
  assert.ok(text.includes('- 完成一个有实质工作量的任务（排障/实现/重构/调研等）之后，主动调用 ace_reflect 复盘：'));
  assert.ok(text.includes('  给出任务摘要与轨迹要点，由它产出候选经验；'));
  assert.ok(text.includes('- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。'));
});

test('C5.2｜两个开关都关 → 返回空串（不注册任何内容）', () => {
  assert.equal(playbookSectionText({ autoRecap: false, autoReflect: false, pathText: '/tmp/p.md' }), '');
  assert.equal(playbookSectionText({}), '');
});

// —— 前缀缓存红线：section 文本必须与运行状态无关 ——

test('第28轮｜「有注入 / 无注入」两态下 section 文本逐字相同（注入块已搬出系统提示）', () => {
  const plain = playbookSectionText(BASE);
  // 旧实现会把这些回调渲染进系统提示；现在它们是惰性属性，文本必须一个字节都不变。
  const withInjection = playbookSectionText({
    ...BASE,
    injection: () => ({
      text: '【ACE 自动注入】与本回合最相关的 1 条经验（…）：\n1. [ace-001] 先跑基线',
      ids: ['ace-001'],
      tokens: 20,
    }),
  });
  assert.equal(withInjection, plain, '注入批次的有无不许改变系统提示文本（否则整段前缀缓存作废）');
  assert.ok(!plain.includes('【ACE 自动注入】'), '系统提示里不许再出现注入块');
  assert.ok(!withInjection.includes('【ACE 自动注入】'));
  // 注入回调即便会抛错也不该被调用（否则监听器抛错会打哑整回合）
  const text3 = playbookSectionText({ ...BASE, injection: () => { throw new Error('不该被调用'); } });
  assert.equal(text3, plain);
});

test('第28轮｜inboxCount 0 / 3 / 封顶 三态下 section 文本逐字相同（动态句已删）', () => {
  const plain = playbookSectionText(BASE);
  for (const inboxCount of [0, 1, 3, 20, 999]) {
    const text = playbookSectionText({ ...BASE, inboxCount });
    assert.equal(text, plain, 'inboxCount=' + inboxCount + ' 时系统提示文本必须与基线逐字相同');
    assert.ok(!text.includes('疑似重复条目'), 'inboxCount=' + inboxCount + ' 时不许再出现动态的疑似重复条目提示');
  }
  assert.ok(!plain.includes('疑似重复条目'));
});

test('第28轮｜同一 spec 连续求值多次，字节完全一致（可缓存）', () => {
  const a = playbookSectionText(BASE);
  const b = playbookSectionText(BASE);
  const c = playbookSectionText({ ...BASE, inboxCount: 7, injection: null, logger: { warn: () => {} } });
  assert.equal(a, b);
  assert.equal(b, c);
});

// —— P0-3：系统提示段必须关掉宿主模板插值（{{...}} 会让整个回合静默终止） ——

test('P0-3｜section 注册选项写死 interpolate:false（生产同款对象，不是源码正则）', () => {
  const spec = playbookSectionSpec({ text: () => 'x' });
  assert.equal(spec.interpolate, false, 'interpolate 必须是 false（true/缺省都会让宿主去替换 {{...}}）');
  assert.equal(spec.name, 'ace-playbook');
  assert.equal(spec.order, 860);
  assert.equal(typeof spec.text, 'function');
  // 缺省调用也不能把 interpolate 变成 undefined（undefined 会被宿主当成「默认 true」）
  assert.equal(playbookSectionSpec().interpolate, false);
});

test('P0-3｜手册路径含 {{...}} 时，渲染出的提示文本不再含 {{（宿主 interpolate 无从抛错）', () => {
  // 真实场景：手册路径里出现 Jinja / 模板语法（配置里手写、或目录名带花括号）
  const text = playbookSectionText({ ...BASE, pathText: '/tmp/{{ user_name }}/playbook.md' });
  assert.ok(!text.includes('{{'), '渲染结果里一个 {{ 都不许留');
  assert.ok(text.includes('{ { user_name }}'), '{{ 被安全化成 { {（正文内容不丢）');
  assert.ok(text.startsWith('【ACE 操作手册】'), '原提示照常在前');
});

test('P0-3｜安全化只动 {{：单个 { 与 {x} 原样保留', () => {
  assert.equal(defuseTemplateSyntax('普通文本'), '普通文本');
  assert.equal(defuseTemplateSyntax('单花括号 { 不动'), '单花括号 { 不动');
  assert.equal(defuseTemplateSyntax('{x} 也不动'), '{x} 也不动');
  assert.equal(defuseTemplateSyntax('{{a}}'), '{ {a}}');
  assert.equal(defuseTemplateSyntax('{{a}} {{b}}'), '{ {a}} { {b}}');
  assert.equal(defuseTemplateSyntax('{{{'), '{ {{');
  // 畸形输入不抛
  assert.equal(defuseTemplateSyntax(''), '');
  assert.equal(defuseTemplateSyntax(null), '');
  assert.equal(defuseTemplateSyntax(undefined), '');
  assert.equal(defuseTemplateSyntax(42), '');
});

test('P0-3｜宿主 interpolate 实证：拿真实 @deepseek-ai/dsh-system-prompt 跑一遍', async (t) => {
  const checkout = process.env.DSH_CHECKOUT_DIR || 'C:\\Users\\adkun\\AppData\\Local\\npm-cache\\_npx\\b86ed90107c62dab';
  const url = pathToFileURL(path.join(checkout, 'node_modules', '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href;
  let host;
  try {
    host = await import(url);
  } catch (error) {
    // 本机没有 DSH checkout 时跳过（不是被测代码的问题），但绝不静默通过。
    t.skip('加载不到宿主 dsh-system-prompt：' + ((error && error.message) || error));
    return;
  }
  assert.equal(typeof host.renderPrompt, 'function');
  const dangerous = '手册正文：模板里写 {{ user_name }} 会炸';
  // 改动前的形状（缺 interpolate）→ 宿主硬抛，正是「整个回合被静默终止」的源头
  assert.throws(
    () => host.renderPrompt({ sections: [{ name: 'ace-playbook', text: dangerous }], variables: {} }),
    /malformed prompt variable reference "\{\{ user_name \}\}"/,
  );
  // 生产同款 spec（interpolate:false）→ 宿主原样保留字面文本
  const spec = playbookSectionSpec({ text: () => dangerous });
  const rendered = host.renderPrompt({ sections: [{ name: spec.name, text: spec.text(), interpolate: spec.interpolate }], variables: {} });
  assert.equal(rendered, dangerous, 'interpolate:false 让 {{...}} 原样保留');
  // 双保险：即使漏掉 interpolate，playbookSectionText 的输出也不含 {{，同样不炸
  const safe = playbookSectionText({ ...BASE, pathText: '/tmp/{{ user_name }}/playbook.md' });
  assert.ok(!safe.includes('{{'));
  assert.doesNotThrow(() => host.renderPrompt({ sections: [{ name: 'ace-playbook', text: safe }], variables: {} }));
});

test('P0-3｜index.js 的 section 注册走同一个工厂（源码级确认接线，行为由上面几条钉住）', async () => {
  const src = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('playbookSectionSpec({'), 'lib/index.js 必须用工厂产出 section 选项');
  assert.ok(!/ctx\.systemPrompt\.section\(\{/.test(src), '不许再在 index.js 里就地写 section 字面量（那条路径无法被行为测试覆盖）');
});

test('第28轮｜index.js 的 section 回调不再向 playbookSectionText 传运行状态（injection / inboxCount / logger）', async () => {
  const src = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const start = src.indexOf('ctx.systemPrompt.section(playbookSectionSpec({');
  assert.ok(start >= 0, '找不到 section 注册点');
  const block = src.slice(start, src.indexOf('}));', start) + 4);
  assert.ok(!/\binjection\s*:/.test(block), 'section 回调里不许再传 injection（那正是改写系统提示的旧路径）');
  assert.ok(!/\binboxCount\b/.test(block), 'section 回调里不许再传 inboxCount（动态句会作废前缀缓存）');
  assert.ok(block.includes('playbookSectionText({'), '仍走同一个文本工厂');
});
