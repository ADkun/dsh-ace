// client.js 的手册统计区块（只读）行为测试。
//
// 与 client-picker.test.mjs 同一套迷你 React 渲染器（本机没有 react / react-dom，
// 这里自带极小的 createElement + useState/useEffect + 同步重渲染），在 node 里真实渲染
// AceSection 并派发点击，检查：
// 统计块渲染在标题之下 / 第一个表单行之前、规模与来源文案、14 天条形图的内联宽度、
// 最近更新列表、空态 reason 文案（needs-session / unreadable 各有专门用例）、失败降级、
// 刷新按钮与「保存成功后重拉」各多发一次请求。
// 它不是浏览器：布局、CSS、真实焦点顺序不在覆盖范围内。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

// —— 迷你 React（与 client-picker.test.mjs 同款）——
// —— 迷你 React ——
const store = new Map(); // 组件路径 -> { hooks: [] }
let pendingEffects = [];
let rerenderRequested = false;
let hookStack = [];

function createElement(type, props, ...children) {
  const flat = [];
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) { child.forEach(push); return; }
    flat.push(child);
  };
  children.forEach(push);
  return { type, props: props || {}, children: flat };
}

function current() { return hookStack[hookStack.length - 1]; }

function useState(initial) {
  const ctx = current();
  const index = ctx.index++;
  if (!(index in ctx.hooks)) ctx.hooks[index] = typeof initial === 'function' ? initial() : initial;
  const set = (next) => {
    const value = typeof next === 'function' ? next(ctx.hooks[index]) : next;
    if (Object.is(value, ctx.hooks[index])) return;
    ctx.hooks[index] = value;
    rerenderRequested = true;
  };
  return [ctx.hooks[index], set];
}

function useRef(initial) {
  const ctx = current();
  const index = ctx.index++;
  if (!(index in ctx.hooks)) ctx.hooks[index] = { current: initial };
  return ctx.hooks[index];
}

function useEffect(fn, deps) {
  const ctx = current();
  const index = ctx.index++;
  const prev = ctx.hooks[index];
  const changed = !prev || !deps || !Array.isArray(prev.deps) || deps.length !== prev.deps.length
    || deps.some((dep, i) => !Object.is(dep, prev.deps[i]));
  if (!changed) return;
  ctx.hooks[index] = { deps };
  pendingEffects.push({ fn, cleanup: prev?.cleanup });
}

const React = { createElement, useState, useRef, useEffect };

function render(node, key) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  const { type, props, children } = node;
  if (typeof type === 'function') {
    const slot = store.get(key) || { hooks: [] };
    store.set(key, slot);
    hookStack.push({ hooks: slot.hooks, index: 0 });
    let output;
    try { output = type({ ...props, children }); } finally { hookStack.pop(); }
    return render(output, key + '#');
  }
  const rendered = { type, props, children: children.map((child, i) => render(child, key + '/' + i)) };
  // 迷你 DOM 里没有布局与焦点：给节点补一个空 focus，让组件里的 searchRef.current?.focus() 走得通。
  rendered.focus = () => {};
  rendered.scrollIntoView = () => {};
  if (typeof props.ref === 'function') props.ref(rendered);
  else if (props.ref && typeof props.ref === 'object') props.ref.current = rendered;
  return rendered;
}

let rootElement = null;
let tree = null;

function flush(limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    rerenderRequested = false;
    pendingEffects = [];
    tree = render(rootElement, '');
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      const cleanup = effect.fn();
      if (typeof cleanup === 'function') effect.cleanup = cleanup;
    }
    if (!rerenderRequested && pendingEffects.length === 0) return;
  }
  throw new Error('渲染没有收敛（可能死循环）');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

function findAll(predicate) {
  const hits = [];
  walk(tree, (node) => { if (predicate(node)) hits.push(node); });
  return hits;
}

const hasClass = (name) => (node) => typeof node.props?.className === 'string'
  && node.props.className.split(/\s+/).includes(name);
const textOf = (node) => (node.children || [])
  .map((child) => (typeof child === 'string' ? child : textOf(child)))
  .join('');

// 点击后要让假 fetch 的 promise 结算（POST 成功后 adopt 会重渲染），所以是异步的。
async function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '节点没有 onClick');
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: node });
  flush();
  await tick();
  await tick();
  flush();
}
// —— 假宿主：认得 /settings、/catalog、/stats ——
const CATALOG = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }];
const DEFAULTS = { playbookPath: '', autoReflect: true, reflectProvider: '', reflectModel: '', maxEntries: 100 };

/** 一份统计返回：规模 / 来源（0 / 35）/ 14 天分布 / 最近 5 条。 */
function statsPayload(overrides = {}) {
  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = String(30 - i).padStart(2, '0');
    daily.push({ date: '2026-09-' + day, count: i === 13 ? 3 : (i === 12 ? 1 : 0) });
  }
  // 第 34 轮必修 4：第一条刻意用 29 字符毫秒戳（生产里 lib/timestamp.js 的 nowStamp 就是这个形状），
  // 界面必须截成 10 字符日期 —— 全用 '2026-09-2n' 这种无毫秒夹具永远测不出问题。
  const recent = [1, 2, 3, 4, 5].map((n) => ({
    id: 'ace-00' + n,
    title: '标题' + n,
    updated: n === 1 ? '2026-09-21T06:12:33.412+08:00' : '2026-09-2' + n,
  }));
  return {
    ok: true,
    reason: null,
    generatedAt: '2026-10-10 12:00',
    pathKind: 'shared',
    playbookPath: 'C:/Users/x/.dsh/ace/playbook.md',
    file: 'C:/Users/x/.dsh/ace/playbook.md',
    scale: { entries: 35, maxEntries: 100, textChars: 12345, bytes: 40960, mtime: '2026-09-30 21:07' },
    source: { auto: 0, total: 35, autoRatio: 0 },
    windowDays: 14,
    dailyMax: 3,
    daily,
    recent,
    ...overrides,
  };
}

// 与服务端 describe() 的真实形状一致：bounds.defaults.maxEntries 的值来自
// lib/playbook-path.js 的 DEFAULT_MAX_ENTRIES（测试里只当数据用，不 import 宿主）。
const DEFAULT_BOUNDS = { maxEntries: [1, 1000], autoRecapThreshold: [0, 1000], autoRecapCooldownTurns: [0, 1000], defaults: { maxEntries: 100 } };

/**
 * 假宿主。
 * opts.bounds          /settings 返回的 bounds（缺省 = 服务端 describe() 的真实形状）
 * opts.settingsStatus  /settings GET 的状态码（403 + { error } 用来模拟围栏拒绝）
 * opts.settingsBody    /settings GET 的整份响应体（压过一切，用于构造畸形 payload）
 * opts.inboxBody      /inbox 的返回体（默认空、未满、cap 20）
 */
function makeHost(initial = {}, stats = statsPayload(), opts = {}) {
  const settings = { ...DEFAULTS, ...initial };
  const bounds = opts.bounds === undefined ? DEFAULT_BOUNDS : opts.bounds;
  const calls = [];
  const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/dsh-ace/catalog') return json(200, { ok: true, providers: CATALOG });
    if (url === '/api/dsh-ace/stats') return json(200, stats);
    if (url === '/api/dsh-ace/inbox') return json(200, opts.inboxBody || { ok: true, items: [], full: false, cap: 20 });
    // 思考档位（第 50 轮）：本文件不测它，只给一份最小成功返回，免得假宿主对未知路由抛错。
    if (String(url).startsWith('/api/dsh-ace/efforts')) {
      return json(200, { ok: true, efforts: [{ id: 'off', name: '关' }], effective: { effort: null, source: 'none', reason: '不降档' } });
    }
    if (url === '/api/dsh-ace/settings') {
      if (method === 'POST') Object.assign(settings, JSON.parse(init.body));
      if (method === 'DELETE') Object.assign(settings, DEFAULTS);
      if (opts.settingsBody !== undefined) {
        return json(opts.settingsStatus === undefined ? 200 : opts.settingsStatus, opts.settingsBody);
      }
      if (opts.settingsStatus !== undefined && opts.settingsStatus >= 400) {
        return json(opts.settingsStatus, { error: opts.settingsStatus === 401 ? 'unauthorized' : 'forbidden' });
      }
      return json(200, {
        ok: true,
        value: { ...settings },
        configured: { ...settings },
        stored: {},
        file: 'D:/p/dsh-ace.json',
        bounds,
      });
    }
    throw new Error('意外的请求：' + url);
  };
  return { settings, calls, fetchStub, bounds };
}

const DICT = new Proxy({}, { get: (_t, key) => String(key) });
// 这份文件沿用 DICT 回显键名（既有用例依赖它），但把真字典另存一份：
// 少数断言要看「文案原文里有没有把数字写死」，那必须读真字符串。
let DICTS_ALL = { zh: {}, en: {} };

async function mount(host) {
  store.clear();
  pendingEffects = [];
  let registered = null;
  const spec = { __captured: true };
  const fakeWindow = {
    __ModuleLoader__: { load(s) { spec.loaded = s; } },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const fakeDocument = { documentElement: { lang: 'zh' }, addEventListener() {}, removeEventListener() {} };
  // 只允许 require('react')：本插件不引第三方依赖。
  new Function('window', 'document', 'fetch', clientSource)(fakeWindow, fakeDocument, host.fetchStub);
  const mod = spec.loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了未预期的模块：' + name);
  });
  const ctx = {
    locale: { bind: () => (key) => DICT[key], register: (_ns, dicts) => { DICTS_ALL = dicts; return () => {}; } },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => { registered = component; return () => {}; },
    },
  };
  mod.apply(ctx);
  assert.ok(registered, 'settings.section 没有注册组件');
  rootElement = createElement(registered, { close() {} });
  flush();
  await tick();
  await tick();
  await tick();
  flush();
  return registered;
}

const statsBlock = () => findAll(hasClass('ace-stats'))[0];
const notes = () => findAll(hasClass('ace-stats-note'));
const statsFetches = (host) => host.calls.filter((call) => call.url === '/api/dsh-ace/stats');

test('统计页：统计块在标题之下、导航标签之下，且不再和表单行同层（只读区块）', async () => {
  const host = makeHost();
  await mount(host);
  const root = findAll(hasClass('ace-set'))[0];
  assert.ok(root, '整页仍然渲染');
  // 顶层顺序：style, tag, title, subtitle, tabs, 三个 .ace-page
  const classes = root.children.map((child) => (typeof child.props?.className === 'string' ? child.props.className : ''));
  const subAt = classes.indexOf('ace-set-sub');
  const tabsAt = classes.indexOf('ace-tabs');
  const pages = classes.reduce((acc, name, i) => (name.split(/\s+/).includes('ace-page') ? acc.concat(i) : acc), []);
  assert.ok(subAt >= 0 && tabsAt >= 0, '副标题与导航条都应当在位：' + classes.join(' | '));
  assert.ok(subAt < tabsAt, '导航条在标题之下');
  assert.equal(pages.length, 3, '三个页面容器都在树里（隐藏而非卸载）');
  assert.ok(tabsAt < pages[0], '导航条在页面容器之上');
  // 统计块在「统计」页里，且那个页面此刻是可见的（没有 hidden）。
  const statsPage = root.children[pages[0]];
  assert.ok(statsPage.props.id === 'ace-page-stats', '第一个页面是统计页');
  assert.ok(!statsPage.props.hidden, '默认选中统计页，它可见');
  const statsInPage = [];
  walk(statsPage, (node) => { if (hasClass('ace-stats')(node)) statsInPage.push(node); });
  assert.equal(statsInPage.length, 1, '统计块渲染在统计页里');
  // 表单行在「设置」页里，不在统计页里。
  const settingsPage = root.children[pages[1]];
  assert.ok(settingsPage.props.hidden, '设置页默认隐藏');
  const rowsInStats = [];
  walk(statsPage, (node) => { if (hasClass('ace-set-row')(node)) rowsInStats.push(node); });
  assert.equal(rowsInStats.length, 0, '统计页里没有表单行');
  const rowsInSettings = [];
  walk(settingsPage, (node) => { if (hasClass('ace-set-row')(node)) rowsInSettings.push(node); });
  assert.ok(rowsInSettings.length >= 1, '设置页里仍有全部表单行');
});

test('条形图 CSS：填充块必须是块级（display:block）且轨道高度规则仍在 —— 抓「条形恒空」回归', async () => {
  // 这一条是 CSS 规则级断言，不是内联 style 断言：
  // 曾经的 BUG 是 .ace-stats-bar-fill 是内联 <span> 且没有 display，父级 .ace-stats-bar 也不是
  // flex 容器 —— 内联元素上的 width/height 被浏览器直接忽略，内联的百分比宽度写了也白写。
  // 只断言 style.width 字符串抓不到这个回归（内联宽度一直是对的），所以这里断言渲染出的 CSS 文本。
  const host = makeHost();
  await mount(host);
  const styleNodes = findAll((node) => node.type === 'style');
  assert.ok(styleNodes.length >= 1, '整页里应当有内联 <style> 节点');
  const css = styleNodes.map((node) => textOf(node)).join('\n');
  assert.ok(css.length > 0, 'CSS 文本不为空');

  const ruleBody = (selector) => {
    const at = css.indexOf(selector + '{');
    if (at < 0) return null;
    const open = at + selector.length + 1;
    const close = css.indexOf('}', open);
    return close < 0 ? null : css.slice(open, close);
  };

  const fill = ruleBody('.ace-stats-bar-fill');
  assert.ok(fill !== null, '必须存在 .ace-stats-bar-fill 规则');
  assert.match(fill, /display\s*:\s*block/, '.ace-stats-bar-fill 必须 display:block（否则内联 span 的宽高被忽略）');
  assert.match(fill, /height\s*:\s*100%/, '填充块仍然撑满轨道高度');
  assert.match(fill, /background\s*:/, '填充块仍然有可见底色');

  const bar = ruleBody('.ace-stats-bar');
  assert.ok(bar !== null, '必须存在 .ace-stats-bar 规则');
  assert.match(bar, /height\s*:\s*\d+px/, '轨道高度规则仍在');
  // 另一种合法修法是把轨道改成 flex 容器；两者至少满足一种（当前实现用 display:block）。
  const trackIsFlex = /display\s*:\s*flex/.test(bar);
  assert.ok(trackIsFlex || /display\s*:\s*block/.test(fill), '填充块可见宽度必须有块级/flex 上下文');

  // 内联宽度本身一直是对的（旧 BUG 里它也是对的），这里只保证没有被顺手改坏。
  const fills = findAll(hasClass('ace-stats-bar-fill'));
  assert.equal(fills.length, 14);
  const widths = fills.map((node) => node.props.style.width);
  assert.equal(widths[0], '100%');
  assert.equal(widths[1], '33%');
  assert.equal(widths[13], '0%');

  // 4% 最小可见宽度仍然生效：count=1 / dailyMax=100 → round(1)=1，被抬到 4%。
  const tiny = makeHost({}, statsPayload({
    dailyMax: 100,
    daily: [{ date: '2026-09-30', count: 1 }, { date: '2026-09-29', count: 0 }],
  }));
  await mount(tiny);
  const tinyWidths = findAll(hasClass('ace-stats-bar-fill')).map((node) => node.props.style.width);
  assert.deepEqual(tinyWidths, ['4%', '0%'], '非零计数的最小可见宽度仍是 4%');
});

test('统计块：规模快照、来源构成、14 天条形图、最近更新都按返回渲染', async () => {
  const host = makeHost();
  await mount(host);
  const text = textOf(statsBlock());
  assert.match(text, /statsTitle/, '有区块标题');
  assert.match(text, /statsRefresh/, '有刷新按钮');
  assert.match(text, /35 \/ 100/, '条目数按「占用 / 上限」显示');
  assert.match(text, /12345/, '正文字符数');
  assert.match(text, /40960/, '文件字节数');
  assert.match(text, /2026-09-30 21:07/, '最后写入时间');
  assert.match(text, /C:\/Users\/x\/\.dsh\/ace\/playbook\.md/, '手册路径');
  // 来源构成：只显示 auto 占比；当前 0 / 35 时给 0% 与灰字说明
  assert.match(text, /statsAuto 0%（0 \/ 35）/, 'auto 占比按 0% 显示');
  assert.match(text, /statsAutoNone/, 'auto 为 0 时附一句灰字说明');
  assert.equal(/helpful|harmful|statsHelpful|statsHarmful/.test(text), false, '不显示 helpful/harmful');

  // 14 天：每天一行，宽度是内联 style 百分比（不是动态 CSS 规则）
  const days = findAll(hasClass('ace-stats-day'));
  assert.equal(days.length, 14, '14 行日分布');
  const fills = findAll(hasClass('ace-stats-bar-fill'));
  assert.equal(fills.length, 14);
  assert.equal(fills[0].props.style.width, '100%', '最大值占满');
  assert.equal(fills[1].props.style.width, '33%', '1/3 按比例缩放');
  assert.equal(fills[13].props.style.width, '0%', '0 条不画');
  assert.match(textOf(days[0]), /09-17/, '日期列显示 MM-DD');
  // 最近更新：id + 标题 + 日期，只读列表
  const recent = findAll(hasClass('ace-stats-recent-item'));
  assert.equal(recent.length, 5, '最近 5 条');
  assert.match(textOf(recent[0]), /ace-001/);
  assert.match(textOf(recent[0]), /标题1/);
  assert.match(textOf(recent[0]), /2026-09-21/);
  // 第 34 轮必修 4：最近更新那个日期格**只到日**，且是客户端渲染的结果（不是测试自己 slice）。
  const recentDates = findAll(hasClass('ace-stats-recent-date')).map((node) => textOf(node));
  assert.equal(recentDates.length, 5, '五条各一个日期格');
  assert.equal(recentDates[0], '2026-09-21', '毫秒戳截成 10 字符日期');
  for (const cell of recentDates) {
    assert.equal(cell.length, 10, '日期格长度必须恰好 10（毫秒戳 29 字符）');
    assert.match(cell, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(textOf(recent[0]).includes('+08:00'), false, '不渲染时区偏移');
  assert.equal(textOf(recent[0]).includes('06:12:33'), false, '不渲染时分秒');
});

test('统计块：最近更新的日期格对空值 / 垃圾值给「—」，绝不渲染 undefined', async () => {
  const host = makeHost({}, statsPayload({
    recent: [
      { id: 'ace-001', title: '空串', updated: '' },
      { id: 'ace-002', title: '缺失', updated: undefined },
      { id: 'ace-003', title: '垃圾值', updated: '不是时间' },
      { id: 'ace-004', title: '旧格式', updated: '2026-09-05' },
    ],
  }));
  await mount(host);
  const cells = findAll(hasClass('ace-stats-recent-date')).map((node) => textOf(node));
  assert.equal(cells.length, 4);
  assert.equal(cells.filter((cell) => cell === '\u2014').length, 3, '空串 / 缺失 / 垃圾值都是「—」');
  assert.equal(cells[3], '2026-09-05', '旧日期格式原样给出');
  assert.equal(cells.some((cell) => /undefined|null|NaN/.test(cell)), false, '绝不渲染 undefined / null / NaN');
});

test('统计块：空态（相对路径需会话）只多一行引导，其余字段照常显示', async () => {
  const host = makeHost({}, statsPayload({ reason: 'needs-session', pathKind: 'relative', playbookPath: 'docs/playbook.md', file: null, scale: { entries: 0, maxEntries: 100, textChars: 0, bytes: 0, mtime: null }, source: { auto: 0, total: 0, autoRatio: 0 }, dailyMax: 0, recent: [] }));
  await mount(host);
  const text = textOf(statsBlock());
  assert.match(text, /statsReasonNeedsSession/, '相对路径给出「需要会话上下文」的说明');
  assert.match(text, /statsPath docs\/playbook\.md/, '路径仍然回显');
  assert.match(text, /statsAuto 0%/, '来源构成照常显示');
  // 空态不报错、不阻塞整页
  assert.equal(findAll(hasClass('ace-stats-note')).length >= 1, true);
  assert.ok(findAll(hasClass('ace-set-row')).length >= 1, '表单行照常渲染');
  assert.ok(findAll(hasClass('ace-set-btn')).length >= 1, '恢复默认按钮仍在');
});

test('统计块：读盘失败（unreadable）也只多一行引导，不抛错、不阻塞整页', async () => {
  // 宿主侧 /stats 的 catch 分支（lib/index.js）与 readPlaybookStats 的读失败分支（lib/stats.js:198-208）
  // 都返回 { ok:true, reason:'unreadable' }，客户端必须把 reason 翻成自己那一句，而不是回落到通用文案。
  const host = makeHost({}, statsPayload({
    reason: 'unreadable',
    pathKind: 'shared',
    playbookPath: 'C:/Users/x/.dsh/ace/playbook.md',
    file: null,
    scale: { entries: 0, maxEntries: 100, textChars: 0, bytes: 0, mtime: null },
    source: { auto: 0, total: 0, autoRatio: 0 },
    dailyMax: 0,
    recent: [],
  }));
  await mount(host);
  const block = statsBlock();
  assert.ok(block, '统计块仍然渲染（不抛错）');
  const text = textOf(block);
  assert.match(text, /statsReasonUnreadable/, 'reason=unreadable 有自己的文案');
  // 不能串到别的 reason 上：映射必须命中 unreadable 这一条
  assert.equal(/statsReasonNeedsSession|statsReasonMissing|statsReasonNoEntries/.test(text), false, '不误用其它 reason 文案');
  // 只多一行灰字：带 reason 文案的 note 恰好一条
  const reasonNotes = notes().filter((node) => /statsReasonUnreadable/.test(textOf(node)));
  assert.equal(reasonNotes.length, 1, 'reason 只占一行灰字');
  // 规模格与其余字段照常可用
  assert.equal(findAll(hasClass('ace-stats-grid')).length, 1, '规模快照照常渲染');
  assert.match(text, /0 \/ 100/, '条目数按「占用 / 上限」显示（空态也显示上限）');
  assert.match(text, /statsPath C:\/Users\/x\/\.dsh\/ace\/playbook\.md/, '路径仍然回显');
  assert.ok(findAll(hasClass('ace-set-row')).length >= 1, '表单行照常渲染');
  assert.ok(findAll(hasClass('ace-set-input')).length >= 2, '手册路径与容量输入框仍在');
  assert.ok(findAll(hasClass('ace-set-btn')).length >= 1, '恢复默认按钮仍在');

  // 渲染断言用的是 DICT 代理（任何 key 都回显 key 名），词条缺失在这里看不出来，
  // 所以补一条源码级断言：zh / en 两个字典都必须有这四个 reason 词条（各 2 处）。
  for (const key of ['statsReasonNeedsSession', 'statsReasonMissing', 'statsReasonUnreadable', 'statsReasonNoEntries']) {
    const hits = clientSource.match(new RegExp(key + ":\\s*'", 'g')) || [];
    assert.equal(hits.length, 2, key + ' 应在 zh 与 en 两个字典里各有一处，实际 ' + hits.length);
  }
});

test('统计块：端点不可用（宿主没重启 → 404）降级成一行灰字，不影响整页', async () => {
  const host = makeHost();
  const failing = async (url, init) => {
    if (url === '/api/dsh-ace/stats') return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return host.fetchStub(url, init);
  };
  await mount({ ...host, fetchStub: failing });
  const text = textOf(statsBlock());
  assert.match(text, /statsUnavailable/, '显示统计不可用');
  assert.equal(findAll(hasClass('ace-stats-grid')).length, 0, '失败时不渲染数字格子');
  assert.ok(findAll(hasClass('ace-set-row')).length >= 1, '其余字段照常可用');
  assert.ok(findAll(hasClass('ace-set-input')).length >= 2, '手册路径与容量输入框仍在');
});

test('统计块：刷新按钮重拉一次；设置保存成功后也顺手重拉一次', async () => {
  const host = makeHost();
  await mount(host);
  assert.equal(statsFetches(host).length, 1, '打开页面拉一次');

  const refresh = findAll(hasClass('ace-stats-btn'))[0];
  await click(refresh);
  assert.equal(statsFetches(host).length, 2, '点「刷新」再拉一次');

  // 保存一次设置（切 autoReflect 开关）→ 统计再拉一次
  const toggle = findAll(hasClass('ace-set-switch'))[0];
  await click(toggle);
  const posts = host.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, '保存确实发生了');
  assert.equal(statsFetches(host).length, 3, '保存成功后重拉统计');
});

// —— 回归：设置页 GET 必须验 HTTP 状态与 payload.ok ——
test('设置页：围栏 403 不许渲染成「全默认值」（判 response.ok && payload.ok）', async () => {
  // 围栏拒绝回 403 { error: 'forbidden' }：没有 value 字段。
  // 旧实现直接把它喂给 adopt()，value 兜底成 {}，整页渲染全默认值，
  // 底栏还声称「当前值来自插件行 Config」—— 用户看到的是假配置。
  const host = makeHost({}, statsPayload(), { settingsStatus: 403 });
  await mount(host);
  const rows = findAll(hasClass('ace-set-row'));
  assert.equal(rows.length, 0, '403 时不许渲染任何设置行');
  const notes = findAll(hasClass('ace-set-note'));
  assert.equal(notes.length, 1, '失败时只给一行说明');
  assert.equal(textOf(notes[0]), 'failed', '失败文案用 failed 键');
  const text = textOf(findAll(hasClass('ace-set'))[0]);
  assert.equal(text.includes('fromConfigured'), false, '不许声称配置来自插件行');
});

test('设置页：HTTP 200 但 payload.ok !== true 同样按失败处理', async () => {
  // 200 + { ok: false }：旧实现会把 value 兜底成 {}，照样画出一整页默认值。
  const host = makeHost({}, statsPayload(), { settingsBody: { ok: false, error: 'nope' } });
  await mount(host);
  assert.equal(findAll(hasClass('ace-set-row')).length, 0, 'ok!==true 时不许渲染设置行');
  assert.equal(textOf(findAll(hasClass('ace-set-note'))[0]), 'failed');
});

test('设置页：正常返回时照常渲染，回归用例的前提成立', async () => {
  const host = makeHost();
  await mount(host);
  assert.ok(findAll(hasClass('ace-set-row')).length >= 6, '正常路径仍渲染全部设置行');
});

// —— 回归：Switch / FieldRow 的可访问名 ——
test('可访问性：开关的 aria-label 恒为字段名，状态只走 aria-checked', async () => {
  const host = makeHost();
  await mount(host);
  const switches = () => findAll((node) => node.props && node.props.role === 'switch');
  assert.ok(switches().length >= 3, '三个开关都在');
  for (const node of switches()) {
    const label = node.props['aria-label'];
    // 旧实现把 onText/offText（"开"/"关"）当可访问名 —— 名字随状态变化，且听不出是哪一项。
    assert.notEqual(label, 'on', 'aria-label 不许是「开」');
    assert.notEqual(label, 'off', 'aria-label 不许是「关」');
    assert.ok(label && label.startsWith('field'), 'aria-label 必须是字段名（字典键 fieldXxx），实际：' + label);
    assert.ok(node.props['aria-checked'] === 'true' || node.props['aria-checked'] === 'false', '状态走 aria-checked');
  }
  // 名字与状态解耦：切换一次后 aria-label 不变、aria-checked 翻转。
  const before = switches()[0].props['aria-label'];
  const checkedBefore = switches()[0].props['aria-checked'];
  await click(switches()[0]);
  const after = switches()[0];
  assert.equal(after.props['aria-label'], before, '切换状态不改变可访问名');
  assert.notEqual(after.props['aria-checked'], checkedBefore, 'aria-checked 确实翻转');
});

test('可访问性：FieldRow 的 label 与控件建立关联（htmlFor 指向真实存在的 id）', async () => {
  const host = makeHost();
  await mount(host);
  const labels = findAll(hasClass('ace-set-label'));
  assert.ok(labels.length >= 6, '每行一个 label');
  const byId = (id) => findAll((node) => node.props && node.props.id === id)[0];
  for (const node of labels) {
    const target = node.props.htmlFor;
    assert.ok(target, 'label 必须有 htmlFor 指向控件');
    const control = byId(target);
    assert.ok(control, 'htmlFor 指向的 id 必须真的存在：' + target);
    // 三种控件：input（原生关联）、role=switch 的开关、下拉的触发按钮（button 不行原生关联，
    // 但要同时挂 aria-labelledby 指向同一个 label）。
    const kind = control.type === 'input' ? 'input'
      : (control.props.role === 'switch' ? 'switch'
        : (control.type === 'button' && control.props['aria-labelledby'] === node.props.id ? 'button' : null));
    assert.ok(kind, 'label 指向的必须是 input / role=switch / 带 aria-labelledby 的按钮，实际：' + String(control.type || control.props.role));
  }
  // 下拉没有原生 id，但触发按钮要有可访问名。
  const triggers = findAll(hasClass('ace-pick-trigger'));
  assert.ok(triggers.length >= 2, 'provider / model 两个下拉');
  for (const node of triggers) {
    assert.ok(node.props['aria-label'], '下拉触发按钮必须有无障碍名');
    assert.ok(String(node.props['aria-label']).startsWith('field'), '名字取自字段 label');
  }
});

// —— 回归：bounds 驱动 maxEntries 的 min/max 与文案数字 ——
test('容量上限：min/max 与文案数字都取自 payload.bounds，不再写死 1/1000', async () => {
  const host = makeHost({}, statsPayload(), { bounds: { maxEntries: [3, 250], autoRecapThreshold: [5, 90], autoRecapCooldownTurns: [2, 60] } });
  await mount(host);
  const byId = (id) => findAll((node) => node.props && node.props.id === id)[0];
  const maxInput = byId('ace-field-maxEntries');
  assert.equal(maxInput.props.min, 3, 'min 取自 bounds');
  assert.equal(maxInput.props.max, 250, 'max 取自 bounds');
  const thresholdInput = byId('ace-field-autoRecapThreshold');
  assert.equal(thresholdInput.props.min, 5);
  assert.equal(thresholdInput.props.max, 90);
  const cooldownInput = byId('ace-field-autoRecapCooldownTurns');
  assert.equal(cooldownInput.props.min, 2);
  assert.equal(cooldownInput.props.max, 60);
  // 本文件的字典是回显键名的 Proxy，看不到 {min}/{max}/{d} 被填成什么数字，
  // 于是用源码契约钉住：这三个数字全部来自 bounds 派生出的值。
  assert.match(clientSource, /desc: fmt\(t\('fieldMaxEntriesDesc'\), \{ min: maxEntriesRange\[0\], max: maxEntriesRange\[1\], d: maxEntriesDefault \}\)/, '文案数字来自 bounds');
  // 默认值也必须来自 bounds.defaults，且真的喂给了 placeholder（下面另有用例实测值）。
  assert.match(clientSource, /const maxEntriesDefault = boundsDefault\('maxEntries', 100\);/, '默认值从 bounds.defaults 取');
  assert.match(clientSource, /numProps\('maxEntries', maxEntriesRange\[0\], String\(maxEntriesDefault\), maxEntriesRange\[1\]\)/, 'placeholder 用同一份默认值');
  const desc = findAll(hasClass('ace-set-desc')).find((node) => textOf(node).includes('fieldMaxEntriesDesc'));
  assert.ok(desc, '容量上限那行说明还在');
  // 字典里的文案本身必须是占位符，不许再写死 1000（否则 bounds 改了文案还是错的）。
  // 破折号用 [^']* 跳过：源码里是 U+2013，不同编辑器容易写成别的破折号。
  assert.match(clientSource, /fieldMaxEntriesDesc: '[^']*\{min\}[^']*\{max\}[^']*'/, 'zh 文案用 {min}/{max} 占位');
  assert.equal(/可填 1[^']*1000/.test(clientSource), false, 'zh 文案不再写死 1–1000');
});

test('容量上限：bounds 缺失（老宿主）时回退 1/1000，仍能渲染', async () => {
  const host = makeHost({}, statsPayload(), { bounds: null });
  await mount(host);
  const maxInput = findAll((node) => node.props && node.props.id === 'ace-field-maxEntries')[0];
  assert.equal(maxInput.props.min, 1, '缺 bounds 回退 1');
  assert.equal(maxInput.props.max, 1000, '缺 bounds 回退 1000');
  // 默认值同样要有兜底：老宿主没有 bounds.defaults，placeholder 回退 100 而不是空串。
  assert.equal(maxInput.props.placeholder, '100', '缺 bounds.defaults 回退 100');
});

// —— 回归：默认值只有一个出处（服务端 bounds.defaults），文案与 placeholder 都跟着它 ——
// 旧版把「默认 100」写死在 zh/en 文案里、placeholder 写死成 '100'：
// 宿主把 DEFAULT_MAX_ENTRIES 改成 250 之后，输入框空着时提示的还是 100，文案也说 100。
// 这里传一份 default=250 的 bounds，实测渲染出来的 placeholder 真的变成了 250。
test('容量上限：默认值读 payload.bounds.defaults，placeholder 跟着变（不再写死 100）', async () => {
  const host = makeHost({}, statsPayload(), {
    bounds: { maxEntries: [5, 400], autoRecapThreshold: [0, 1000], autoRecapCooldownTurns: [0, 1000], defaults: { maxEntries: 250 } },
  });
  await mount(host);
  const maxInput = findAll((node) => node.props && node.props.id === 'ace-field-maxEntries')[0];
  assert.ok(maxInput, '容量上限输入框还在');
  assert.equal(maxInput.props.placeholder, '250', 'placeholder 取自 bounds.defaults，而不是写死的 100');
  assert.equal(maxInput.props.min, 5, 'min 仍取自 bounds.maxEntries');
  assert.equal(maxInput.props.max, 400, 'max 仍取自 bounds.maxEntries');
  // 默认值必须在 min–max 之内，否则 placeholder 会教用户填一个会被 onBlur 夹走的值。
  assert.ok(Number(maxInput.props.placeholder) >= maxInput.props.min && Number(maxInput.props.placeholder) <= maxInput.props.max);

  // 换一份 default=7：同一份组件代码必须跟着变（证明没接死）。
  const other = makeHost({}, statsPayload(), {
    bounds: { maxEntries: [1, 1000], autoRecapThreshold: [0, 1000], autoRecapCooldownTurns: [0, 1000], defaults: { maxEntries: 7 } },
  });
  await mount(other);
  const otherInput = findAll((node) => node.props && node.props.id === 'ace-field-maxEntries')[0];
  assert.equal(otherInput.props.placeholder, '7', '默认值变了 placeholder 也跟着变');

  // 文案那一侧：字典里「默认」后面必须是 {d} 占位符，两侧（zh/en）都要有，
  // 且渲染点把 maxEntriesDefault 填进去（Proxy 字典看不到填值，用源码契约钉住）。
  // 第 33 轮：容量上限的说明文案改写成了「先 LLM 合并、仍超则按命中次数淘汰」，
  // 不再提 ace_curate，所以按「同时带 {d} 与 {min}/{max}」这条稳定的形状去找。
  const zhDesc = Object.values(DICTS_ALL.zh).find((v) => typeof v === 'string' && v.includes('{d}') && v.includes('{min}'));
  assert.ok(zhDesc, 'zh 里有容量上限那条说明');
  assert.match(zhDesc, /默认 \{d\}/, 'zh 文案里默认值是 {d} 占位符');
  assert.equal(/默认 100/.test(zhDesc), false, 'zh 文案不再写死「默认 100」');
  const enDesc = Object.values(DICTS_ALL.en).find((v) => typeof v === 'string' && v.includes('{d}') && v.includes('{min}'));
  assert.match(enDesc, /default \{d\}/, 'en 文案里默认值也是 {d} 占位符');
  assert.equal(/default 100/.test(enDesc), false, 'en 文案不再写死「default 100」');
});

// —— 回归：inboxFull 文案里的条数取自 payload.cap ——
test('待合并已满：文案条数读 /inbox 的 cap，不再写死 20', async () => {
  const capHost = makeHost({}, statsPayload(), {
    inboxBody: { ok: true, items: [], full: true, cap: 5, reason: null },
  });
  await mount(capHost);
  const full = findAll(hasClass('ace-inbox-full'))[0];
  assert.ok(full, '满态渲染一行提示');
  // 本文件的字典是回显键名的 Proxy：确认取的是 inboxFull 键，数值实填由下面两条源码契约钉住。
  assert.equal(textOf(full), 'inboxFull', '满态取 inboxFull 键');
  // 源码契约：n 来自 inbox.cap，字典里不再写死（20 条）。
  assert.match(clientSource, /fmt\(t\('inboxFull'\), \{ n: inbox\.cap \}\)/, '渲染点用 inbox.cap');
  assert.match(clientSource, /cap: Number\.isFinite\(Number\(payload\.cap\)\)/, 'cap 取自 payload');
  assert.equal(/\(20 条\)/.test(clientSource), false, '字典里不再写死「20 条」');
});

// —— 10. ACE 运行统计块（GET /stats 的 runtime 块）——
// 六个数来自宿主进程内存（lib/index.js 的 recapStats / archiveStats / injectionStats），
// 宿主重启即归零、刻意不落盘。类名一律 ace-runtime-*：上面那些按 .ace-stats-* 精确
// 计数的断言（.ace-stats 恰好 1 个、.ace-stats-grid 恰好 1 个、.ace-stats-note 条数）不受影响。
function runtimePayload(overrides = {}) {
  return statsPayload({
    runtime: {
      // 第 33 轮：正负评分整层删除后只剩六个数字（注入批次 / 注入追加 / 检索命中 /
      // 淘汰数 / 合并数 / 归档数）+ 四种结构性归档原因分列。数值各不相同，
      // 映射写错（比如淘汰数读成合并数）不会被补 0 掩盖。
      injectedBatches: 9,
      injectedAppended: 7,
      retrievalHits: 11,
      evicted: 4,
      merged: 3,
      archived: 10,
      // 四种原因合计必须等于 archived（superseded 2 + removed-by-request 1 + evicted 4 + merged 3 = 10）。
      archivedByReason: { superseded: 2, 'removed-by-request': 1, evicted: 4, merged: 3 },
      // 第 34 轮：陷阱字段。真实 runtime 是**精确七键**（上面那七个），injectedSkipped /
      // injectedFailed 从来不在协议里 —— 以前设置页读它们，num(undefined) 兜成 '0'，
      // 于是「跳过 0 · 失败 0」天天挂在界面上。这里故意放两个**非零**值：谁把这两格
      // 加回去，渲染出来的就不再是假 0 而是 999/888，断言立刻打红（两头都钉死）。
      injectedSkipped: 999,
      injectedFailed: 888,
      ...overrides,
    },
  });
}

const runtimeBlock = () => findAll(hasClass('ace-runtime'))[0];

test('运行统计：六个计数格（注入批次/注入追加/检索命中/淘汰/合并/归档）按 runtime 渲染', async () => {
  const host = makeHost({}, runtimePayload());
  await mount(host);
  const block = runtimeBlock();
  assert.ok(block, '运行统计块渲染在统计页里');
  const text = textOf(block);
  assert.match(text, /runtimeTitle/, '有区块标题');
  // 六个格子：每格一个 .ace-runtime-k（名字）+ .ace-runtime-v（数值）。
  // 第 33 轮由 9 格 → 6 格：复盘/候选/落盘三格随计分统计一起删，
  // 「计分变动」「未观测」「闸门拦下」三格随机制删除；新增「检索命中」「淘汰数」「合并数」。
  const cells = findAll(hasClass('ace-runtime-cell'));
  assert.equal(cells.length, 6, '恰好六个计数格');
  const cellTexts = cells.map((node) => textOf(node));
  assert.match(cellTexts[0], /runtimeInjectBatches/, '第一格是注入批次');
  assert.match(cellTexts[0], /9/, '注入批次取自 runtime.injectedBatches');
  assert.match(cellTexts[1], /runtimeInjectAppended/, '第二格是注入追加');
  assert.match(cellTexts[1], /7/, '注入追加取自 runtime.injectedAppended（与批次是两个数）');
  assert.match(cellTexts[2], /runtimeRetrievalHits/, '第三格是检索命中');
  assert.match(cellTexts[2], /11/, '检索命中取自 runtime.retrievalHits');
  assert.match(cellTexts[3], /runtimeEvicted/, '第四格是淘汰数');
  assert.match(cellTexts[3], /4/, '淘汰数取自 runtime.evicted（不许读成合并数 3）');
  assert.match(cellTexts[4], /runtimeMerged/, '第五格是合并数');
  assert.match(cellTexts[4], /3/, '合并数取自 runtime.merged（不许读成淘汰数 4）');
  assert.match(cellTexts[5], /runtimeArchived/, '第六格是归档数');
  assert.match(cellTexts[5], /10/, '归档数取自 runtime.archived');
  // 设置页不出现任何评分/考察位/闸门的内部字段名（计分整层删除后这些词不许回来）。
  assert.equal(/helpful|harmful|statsHelpful|statsHarmful/.test(text), false, '不显示 helpful/harmful 字样');
  assert.equal(/净分|考察位|runtimeScored|runtimeUnobserved|runtimeGateRejected/.test(text), false, '不显示净分/考察位/未观测/闸门字样');
});

test('运行统计：归档按四种结构性原因分列、注入明细只给 批次/追加 两数（跳过/失败已删）+ 两句人话解释', async () => {
  const host = makeHost({}, runtimePayload());
  await mount(host);
  const block = runtimeBlock();
  const text = textOf(block);
  const lines = findAll(hasClass('ace-runtime-line')).map((node) => textOf(node));
  // 第 33 轮由 5 行 → 4 行：归档原因 / 注入明细 / 注入口径解释 / 淘汰与合并口径解释
  // （「未观测回合 · 闸门拦下」那一行随机制删除）。
  assert.equal(lines.length, 4, '四行明细：归档原因 / 注入明细 / 注入口径解释 / 淘汰合并口径解释');
  assert.match(lines[0], /runtimeArchivedByReason/, '归档原因那一行用 runtimeArchivedByReason');
  assert.match(lines[1], /runtimeInjectDetail/, '注入明细那一行用 runtimeInjectDetail');
  assert.match(lines[2], /runtimeInjectHint/, '第三行用一句人话解释批次与追加的区别');
  assert.match(lines[3], /runtimeEvictHint/, '第四行用一句人话解释淘汰与合并');
  assert.match(text, /runtimeHint/, '底部有一行说明这是内存态、不落盘');

  // 本文件的字典是回显键名的 Proxy，看不到占位符被填成什么数，
  // 所以：占位符用真字典断言，填值用源码契约钉住。
  // 归档原因第 33 轮起是四个**结构性**值：superseded / removed-by-request / evicted / merged
  // （低分 low-score、过期 stale、衰减 decayed 三判据随计分整层删除）。
  assert.match(DICTS_ALL.zh.runtimeArchivedByReason, /\{superseded\}/, 'zh 归档原因文案有 {superseded} 占位符');
  assert.match(DICTS_ALL.zh.runtimeArchivedByReason, /\{removed\}/, 'zh 归档原因文案有 {removed} 占位符');
  assert.match(DICTS_ALL.zh.runtimeArchivedByReason, /\{evicted\}/, 'zh 归档原因文案有 {evicted} 占位符');
  assert.match(DICTS_ALL.zh.runtimeArchivedByReason, /\{merged\}/, 'zh 归档原因文案有 {merged} 占位符');
  assert.match(DICTS_ALL.en.runtimeArchivedByReason, /\{superseded\}[\s\S]*\{removed\}[\s\S]*\{evicted\}[\s\S]*\{merged\}/, 'en 四个占位符都在');
  assert.equal(/\{low\}|\{stale\}|\{decayed\}/.test(DICTS_ALL.zh.runtimeArchivedByReason), false, 'zh 不再有 low/stale 占位符');
  assert.match(clientSource, /fmt\(t\('runtimeArchivedByReason'\), \{[\s\S]*?superseded: num\(byReason\.superseded\),[\s\S]*?removed: num\(byReason\['removed-by-request'\]\),[\s\S]*?evicted: num\(byReason\.evicted\),[\s\S]*?merged: num\(byReason\.merged\),/, '四个数字都取自 runtime.archivedByReason');
  // 第 34 轮：注入明细由「批次 / 追加 / 跳过 / 失败」四数收成「批次 / 追加」两数。
  // 跳过与失败两个键**不在** runtime 协议里（七键：injectedBatches / injectedAppended /
  // retrievalHits / evicted / merged / archived / archivedByReason），渲染它们等于
  // 恒显示 num(undefined) === '0' 的假数字 —— 计数器本身还活着、继续进日志，只是不上界面。
  assert.match(DICTS_ALL.zh.runtimeInjectDetail, /\{batches\}[\s\S]*\{appended\}/, 'zh 注入明细两个占位符都在');
  assert.match(DICTS_ALL.en.runtimeInjectDetail, /\{batches\}[\s\S]*\{appended\}/, 'en 注入明细两个占位符都在');
  assert.equal(/\{skipped\}/.test(DICTS_ALL.zh.runtimeInjectDetail), false, 'zh 注入明细不再有 {skipped} 占位符（runtime 没这个键）');
  assert.equal(/\{failed\}/.test(DICTS_ALL.zh.runtimeInjectDetail), false, 'zh 注入明细不再有 {failed} 占位符（runtime 没这个键）');
  assert.equal(/\{skipped\}/.test(DICTS_ALL.en.runtimeInjectDetail), false, 'en 注入明细不再有 {skipped} 占位符');
  assert.equal(/\{failed\}/.test(DICTS_ALL.en.runtimeInjectDetail), false, 'en 注入明细不再有 {failed} 占位符');
  // 行为面：真渲染出来的一行里，两个跳过/失败数字不许出现（两格已删）。
  const injectDetailLine = lines[1];
  assert.match(injectDetailLine, /runtimeInjectDetail/, '注入明细行照常渲染');
  // 行为面：渲染出来的注入明细行必须只带两个数，不许出现「跳过 0 · 失败 0」这类假数字。
  // 夹具（runtimePayload）里**故意塞进**两个不在协议里的字段 injectedSkipped/injectedFailed：
  // 谁把这两格加回渲染，这一行就会渲染出真数（999/888）而不是假 0，照样被下面的断言打红。
  assert.equal(/跳过/.test(injectDetailLine), false, '注入明细行不许出现「跳过」（两格已删）');
  assert.equal(/失败/.test(injectDetailLine), false, '注入明细行不许出现「失败」（两格已删）');
  // 陷阱值：谁把这两格连同字典占位符一起加回去，这一行就是 999/888（不是假 0），照样打红。
  assert.equal(/999|888/.test(injectDetailLine), false, '注入明细行不许渲染 injectedSkipped / injectedFailed 的陷阱值');
  // 一句话解释必须在设置页真的渲染出来（不许只躺在字典里）
  assert.match(clientSource, /t\('runtimeInjectHint'\)/, '渲染点用 runtimeInjectHint');
  assert.match(DICTS_ALL.zh.runtimeInjectHint, /批次[\s\S]*追加/, 'zh 解释把两个数说清');
  assert.match(DICTS_ALL.en.runtimeInjectHint, /batch[\s\S]*appended/i, 'en 解释把两个数说清');
  // 第 33 轮：检索命中 / 淘汰 / 合并三个新口径各要有一句人话解释，且必须真渲染出来。
  assert.match(DICTS_ALL.zh.runtimeInjectHint, /检索命中[\s\S]*整本读取不计数/, 'zh 解释把检索命中的口径说清');
  assert.match(DICTS_ALL.en.runtimeInjectHint, /Retrieval hits[\s\S]*whole playbook is not counted/i, 'en 解释把检索命中的口径说清');
  assert.match(clientSource, /t\('runtimeEvictHint'\)/, '渲染点用 runtimeEvictHint');
  assert.match(DICTS_ALL.zh.runtimeEvictHint, /命中次数从少到多/, 'zh 解释说清淘汰顺序');
  assert.match(DICTS_ALL.zh.runtimeEvictHint, /创建更早的先走/, 'zh 解释说清同 hits 时老条目先走');
  assert.match(DICTS_ALL.zh.runtimeEvictHint, /合并[\s\S]*LLM/, 'zh 解释说清合并是 LLM 做的');
  assert.match(DICTS_ALL.en.runtimeEvictHint, /fewest hits first[\s\S]*older/i, 'en 解释说清淘汰顺序');
  assert.match(DICTS_ALL.en.runtimeEvictHint, /Merged = pairs the LLM/, 'en 解释说清合并是 LLM 做的');
  // 已删除的三格文案不许以任何形式回来。
  for (const gone of ['runtimeScored', 'runtimeUnobserved', 'runtimeGateRejected', 'runtimeHealthDetail', 'runtimeHealthHint', 'runtimeRecaps', 'runtimeCandidates', 'runtimeWritten']) {
    assert.equal(clientSource.includes(gone + ":"), false, '已删除的字典键 ' + gone + ' 不许回来');
  }
});

test('运行统计：runtime 缺失（宿主没重启）只留一行灰字，手册统计块照常', async () => {
  const host = makeHost(); // 既有 statsPayload 不含 runtime
  await mount(host);
  const block = runtimeBlock();
  assert.ok(block, '运行统计块仍然渲染（不抛错）');
  assert.equal(findAll(hasClass('ace-runtime-cell')).length, 0, '没有计数格');
  assert.equal(findAll(hasClass('ace-runtime-hint')).length, 1, '只有一行提示');
  assert.match(textOf(block), /runtimeUnavailable/);
  // 手册统计块不受影响
  assert.equal(findAll(hasClass('ace-stats-grid')).length, 1, '手册统计的规模格照常渲染');
  assert.match(textOf(statsBlock()), /35 \/ 100/);
});

test('运行统计：不复用既有统计块的类名（.ace-stats-grid / .ace-stats-note 计数不变）', async () => {
  const host = makeHost({}, runtimePayload());
  await mount(host);
  assert.equal(findAll(hasClass('ace-stats')).length, 1, '手册统计块仍恰好一个');
  assert.equal(findAll(hasClass('ace-stats-grid')).length, 1, '规模格仍恰好一个');
  assert.equal(findAll(hasClass('ace-runtime-grid')).length, 1, '运行统计用自己的网格类');
  const notesInRuntime = [];
  walk(runtimeBlock(), (node) => { if (hasClass('ace-stats-note')(node)) notesInRuntime.push(node); });
  assert.equal(notesInRuntime.length, 0, '运行统计块里没有 .ace-stats-note（既有用例按它数灰字条数）');
  // 统计页里两个块都在，且顺序是「手册统计」在前、「运行统计」在后
  const statsPage = findAll((node) => node.props?.id === 'ace-page-stats')[0];
  const order = [];
  walk(statsPage, (node) => {
    if (hasClass('ace-stats')(node)) order.push('stats');
    if (hasClass('ace-runtime')(node)) order.push('runtime');
  });
  assert.deepEqual(order, ['stats', 'runtime'], '手册统计在前，运行统计在后');
});
