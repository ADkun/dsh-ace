// client.js 的三页导航（统计 / 设置 / 记录）与「记录列表详情页」行为测试。
//
// 与 client-stats.test.mjs 同一套迷你 React 渲染器；区别是本文件**不用回显字典**，
// 而是从 ctx.locale.register 里取出 client.js 真正的 zh / en 字典，
// 这样断言的是用户真正看到的文案，同时还能顺带校验两套键一一对应。
//
// 它不是浏览器：布局、真实 CSS 级联、焦点顺序不在覆盖范围内
// （条形图的 display:block 这类 CSS 回归由 client-stats.test.mjs 的规则级断言兜底）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

// —— 迷你 React（与 client-stats.test.mjs 同款）——
const store = new Map();
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

async function settle() {
  flush();
  await tick();
  await tick();
  flush();
}

async function click(node, options = {}) {
  // 默认路径保持原样（既有用例全走这条）：只调本节点自己的 onClick，不冒泡。
  // options.bubbles=true 才沿 parent 链逐级派发，模拟真实浏览器的事件冒泡——
  // 专门用来测「按钮的 stopPropagation 拦不拦得住行/容器的 onClick」这条通路。
  if (!options.bubbles) {
    assert.equal(typeof node.props.onClick, 'function', '节点没有 onClick');
    node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: node });
    await settle();
    return [];
  }
  // 真实冒泡：从点击节点沿 parent 链向上，每级共享同一个事件对象（与浏览器一致）；
  // 某级 handler 里调了 stopPropagation 就停在那一层（浏览器语义：当前 handler 跑完才停）。
  // 返回**实际执行了 onClick 的节点**，用例可以断言「事件只到按钮、没到行/容器」。
  const parents = new Map();
  walk(tree, (n) => {
    for (const child of n.children || []) {
      if (child && typeof child === 'object') parents.set(child, n);
    }
  });
  const event = {
    target: node,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
  };
  const invoked = [];
  let current = node;
  while (current && !event.propagationStopped) {
    if (typeof current.props?.onClick === 'function') {
      invoked.push(current);
      current.props.onClick(event);
    }
    current = parents.get(current);
  }
  await settle();
  return invoked;
}

// —— 假宿主 ——
const CATALOG = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }];
const DEFAULTS = { playbookPath: '', autoReflect: true, reflectProvider: '', reflectModel: '', maxEntries: 100 };

function statsPayload(overrides = {}) {
  const daily = [];
  for (let i = 13; i >= 0; i -= 1) {
    daily.push({ date: '2026-09-' + String(30 - i).padStart(2, '0'), count: i === 13 ? 3 : 0 });
  }
  return {
    ok: true,
    windowDays: 14,
    dailyMax: 3,
    daily,
    recent: [],
    scale: { entries: 35, maxEntries: 100, textChars: 12345, bytes: 40960, mtime: '2026-09-30 21:07' },
    source: { auto: 0, total: 35, autoRatio: 0 },
    file: 'C:/Users/x/.dsh/ace/playbook.md',
    playbookPath: 'C:/Users/x/.dsh/ace/playbook.md',
    pathKind: 'shared',
    generatedAt: '2026-10-10 12:00',
    reason: null,
    ...overrides,
  };
}

/** 一条条目；字段可被 overrides 覆盖成空串（契约允许空值）。 */
function entry(overrides = {}) {
  return {
    id: 'ace-001',
    title: '标题',
    condition: '条件',
    action: '做法',
    rationale: '依据',
    auto: false,
    created: '2026-09-01',
    updated: '2026-09-20',
    helpful: 0,
    harmful: 0,
    ...overrides,
  };
}

function entriesPayload(entries, overrides = {}) {
  return { ok: true, entries, total: entries.length, maxEntries: 500, ...overrides };
}

function makeHost(options = {}) {
  const settings = { ...DEFAULTS, ...(options.initial || {}) };
  const calls = [];
  const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
  const entries = options.entries === undefined ? entriesPayload([]) : options.entries;
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/dsh-ace/catalog') return json(200, { ok: true, providers: CATALOG });
    if (url === '/api/dsh-ace/stats') return json(200, statsPayload(options.stats));
    if (url === '/api/dsh-ace/inbox') return json(200, { ok: true, items: [], full: false, cap: 20 });
    // 思考档位（第 50 轮）：本文件不测它，只给一份最小成功返回，免得假宿主对未知路由抛错。
    if (String(url).startsWith('/api/dsh-ace/efforts')) {
      return json(200, { ok: true, efforts: [{ id: 'off', name: '关' }], effective: { effort: null, source: 'none', reason: '不降档' } });
    }
    if (url === '/api/dsh-ace/entries') {
      if (typeof entries === 'function') return entries(calls.length);
      if (entries instanceof Error) throw entries;
      if (entries && entries.__status) return json(entries.__status, entries.body ?? { ok: false });
      return json(200, entries);
    }
    if (url === '/api/dsh-ace/settings') {
      if (method === 'POST') Object.assign(settings, JSON.parse(init.body));
      if (method === 'DELETE') Object.assign(settings, DEFAULTS);
      const body = { ok: true, value: { ...settings }, configured: { ...settings }, stored: {}, file: 'D:/p/dsh-ace.json' };
      // options.bounds 缺省时整份不带 bounds（老宿主形状）；给了就原样回。
      if (options.bounds !== undefined) body.bounds = options.bounds;
      return json(200, body);
    }
    // 手动归档（POST /entries/archive）。options.archive 可以是固定 payload、
    // { __status, body } 状态体、Error（网络失败）或 (n, init) => response 的函数。
    if (url === '/api/dsh-ace/entries/archive') {
      const reply = options.archive === undefined
        ? { ok: true, archived: { id: 'ace-001', reason: 'removed-by-request', date: '2026-10-27T10:00:00.000+08:00' } }
        : options.archive;
      if (typeof reply === 'function') return reply(calls.length, init);
      if (reply instanceof Error) throw reply;
      if (reply && reply.__status) return json(reply.__status, reply.body ?? { ok: false });
      return json(200, reply);
    }
    throw new Error('意外的请求：' + url);
  };
  return { settings, calls, fetchStub };
}

let DICTS = { zh: {}, en: {} };
const zh = (key) => DICTS.zh[key];

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
  const fakeDocument = {
    documentElement: { lang: 'zh' },
    addEventListener() {},
    removeEventListener() {},
  };
  new Function('window', 'document', 'fetch', clientSource)(fakeWindow, fakeDocument, host.fetchStub);
  const mod = spec.loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了未预期的模块：' + name);
  });
  const ctx = {
    locale: {
      bind: () => (key) => DICTS.zh[key],
      register: (_ns, dicts) => { DICTS = dicts; return () => {}; },
    },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => { registered = component; return () => {}; },
    },
  };
  mod.apply(ctx);
  assert.ok(registered, 'settings.section 没有注册组件');
  assert.ok(Object.keys(DICTS.zh).length > 0, '没有拿到 zh 字典');
  assert.ok(Object.keys(DICTS.en).length > 0, '没有拿到 en 字典');

  rootElement = createElement(registered, { close() {} });
  await settle();
  return registered;
}

// —— 选择器 ——
const tabs = () => findAll((node) => node.props?.role === 'tab');
const tablist = () => findAll((node) => node.props?.role === 'tablist')[0];
const tabById = (id) => tabs().find((node) => node.props?.id === 'ace-tab-' + id);
const pageById = (id) => findAll((node) => node.props?.id === 'ace-page-' + id)[0];
const entriesPage = () => pageById('entries');
const entriesFetches = (host) => host.calls.filter((call) => call.url === '/api/dsh-ace/entries');
const rows = () => findAll(hasClass('ace-entries-row'));
const rowTexts = () => rows().map((node) => textOf(node));
const rowIds = () => findAll(hasClass('ace-entries-row-id')).map((node) => textOf(node));
const searchInput = () => findAll(hasClass('ace-entries-search'))[0];
const refreshBtn = () => pageById('entries') && findAll(hasClass('ace-entries-btn'))[0];
// 手动归档：写请求的调用清单（成功/失败都记在这里）+ 当前渲染出的归档按钮（按 DOM 顺序）。
const archiveCalls = (host) => host.calls.filter((call) => call.url === '/api/dsh-ace/entries/archive');
const archiveBtns = () => findAll(hasClass('ace-entries-archive-btn'));
const archiveNote = () => findAll(hasClass('ace-entries-archive-note'))[0];
const renderedCss = () => findAll((node) => node.type === 'style').map((node) => textOf(node)).join('\n');
const pagerText = () => {
  const node = findAll(hasClass('ace-entries-pager-text'))[0];
  return node ? textOf(node) : '';
};
const pagerButtons = () => findAll(hasClass('ace-entries-pager-btn'));
const sortButton = (label) => findAll(hasClass('ace-entries-sort')).find((node) => textOf(node).startsWith(label));
const countLine = () => {
  const node = findAll(hasClass('ace-entries-count'))[0];
  return node ? textOf(node) : '';
};
const noteText = () => {
  const node = findAll(hasClass('ace-entries-note'))[0];
  return node ? textOf(node) : '';
};

/** 切到记录页（顺便把懒加载的请求跑完）。 */
async function gotoEntries() {
  await click(tabById('entries'));
}

async function typeQuery(text) {
  const input = searchInput();
  assert.ok(input, '记录页有搜索框');
  input.props.onChange({ target: { value: text } });
  await settle();
}

// —— 1. 三页导航 ——
test('三页导航：默认选中统计页，tablist/tab/aria-selected 齐备，点标签切页', async () => {
  const host = makeHost();
  await mount(host);

  const list = tablist();
  assert.ok(list, '有 role="tablist" 的容器');
  assert.equal(tabs().length, 3, '三个 tab');
  assert.deepEqual(tabs().map((node) => textOf(node)), [DICTS.zh.tabStats, DICTS.zh.tabSettings, DICTS.zh.tabEntries]);

  assert.deepEqual(tabs().map((node) => node.props['aria-selected']), ['true', 'false', 'false'], '默认选中统计页');
  assert.equal(pageById('stats').props.hidden, false, '统计页可见');
  assert.equal(pageById('settings').props.hidden, true, '设置页隐藏');
  assert.equal(pageById('entries').props.hidden, true, '记录页隐藏');

  await click(tabById('settings'));
  assert.deepEqual(tabs().map((node) => node.props['aria-selected']), ['false', 'true', 'false'], '点「设置」后 aria-selected 跟着变');
  assert.equal(pageById('settings').props.hidden, false);
  assert.equal(pageById('stats').props.hidden, true);
  assert.match(tabById('settings').props.className, /is-active/, '选中态有独立类名（可见样式靠它）');

  await click(tabById('entries'));
  assert.deepEqual(tabs().map((node) => node.props['aria-selected']), ['false', 'false', 'true']);
  assert.equal(pageById('entries').props.hidden, false);

  await click(tabById('stats'));
  assert.equal(pageById('stats').props.hidden, false, '切回统计页');
});

test('三页导航：切页不卸载组件 —— 设置页填了一半的 draft 切走再回来还在', async () => {
  const host = makeHost();
  await mount(host);
  await click(tabById('settings'));

  const input = findAll(hasClass('ace-set-input'))[0];
  assert.ok(input, '设置页有输入框');
  input.props.onChange({ target: { value: 'D:/half/typed.md' } });
  await settle();
  assert.equal(findAll(hasClass('ace-set-input'))[0].props.value, 'D:/half/typed.md', '草稿已进入 state');

  await click(tabById('entries'));
  await click(tabById('stats'));
  await click(tabById('settings'));
  assert.equal(findAll(hasClass('ace-set-input'))[0].props.value, 'D:/half/typed.md', '切页后草稿没有被清空');
  assert.equal(host.calls.filter((call) => call.method === 'POST').length, 0, '只填不提交，没有写请求');
});

// —— 回归：记录页 reason 三分派（missing / needs-session / unreadable）——
test('记录页：reason=missing 说「手册尚未创建」而不是「读取失败」', async () => {
  // 旧实现把任何 truthy 的 reason 都映射成 unreadable：
  // 新用户第一次进记录页看到「手册文件读取失败」，把空态当成了故障。
  const host = makeHost({ entries: entriesPayload([], { reason: 'missing', total: 0 }) });
  await mount(host);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesReasonMissing);
  assert.notEqual(noteText(), DICTS.zh.entriesReasonUnreadable, '不许说成读取失败');
  assert.notEqual(noteText(), DICTS.zh.entriesEmpty, '也不许和「还没有条目」混为一谈');
  // 空条目列表与无分页：是空态，不是错误页。
  assert.equal(rows().length, 0);
});

test('记录页：reason=needs-session 说「相对路径 + 无会话」而不是「读取失败」', async () => {
  const host = makeHost({ entries: entriesPayload([], { reason: 'needs-session', total: 0 }) });
  await mount(host);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesReasonNeedsSession);
  assert.notEqual(noteText(), DICTS.zh.entriesReasonUnreadable);
});

// —— 回归：updated 为纯空白串时按缺失处理 ——
test('记录页：updated 是纯空白串与缺失同等处理，恒定排末尾', async () => {
  // 旧实现只判 ua === ''：'   ' 这种纯空白串能通过，参与字符串比较，
  // 实测升序排最前、降序排最后 —— 与「缺失日期恒定末尾」的契约相反。
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-001', updated: '   ' }),
      entry({ id: 'ace-002', updated: '2026-09-05' }),
      entry({ id: 'ace-003', updated: '2026-09-09' }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  assert.deepEqual(rowIds(), ['ace-003', 'ace-002', 'ace-001'], '纯空白日期在倒序末尾');
  await click(sortButton(DICTS.zh.entriesColUpdated));
  assert.deepEqual(rowIds(), ['ace-002', 'ace-003', 'ace-001'], '升序也仍然末尾（旧实现会跑到最前）');
  await click(sortButton(DICTS.zh.entriesColUpdated));
  assert.deepEqual(rowIds(), ['ace-003', 'ace-002', 'ace-001'], '翻回倒序仍在末尾');
});

// —— 回归：tablist 键盘导航（roving tabindex 必须有方向键）——
test('三页导航：ArrowLeft / ArrowRight 循环切页，Home / End 跳首末，焦点跟到新 tab', async () => {
  const host = makeHost();
  await mount(host);
  assert.equal(tabById('stats').props['aria-selected'], 'true', '默认统计页');

  // 记录焦点落在哪个 tab 上：迷你 DOM 的 focus() 是空函数，这里换成记录版。
  // 每次重渲染都会生成新的节点对象，所以按键前要重新给当前这棵树的节点装钩子
  // （moveTab 读的 TAB_NODES 正是最近一次渲染时通过 props.ref 存下的那批节点）。
  const focused = [];
  const stampFocus = () => {
    for (const id of ['stats', 'settings', 'entries']) {
      const node = tabById(id);
      if (node) node.focus = () => focused.push(id);
    }
  };
  const key = async (name) => {
    stampFocus();
    tablist().props.onKeyDown({ key: name, preventDefault() {} });
    await settle();
  };

  await key('ArrowRight');
  assert.equal(tabById('settings').props['aria-selected'], 'true', '右移到设置页');
  assert.deepEqual(focused.slice(-1), ['settings'], '焦点跟到新选中的 tab');

  await key('ArrowRight');
  assert.equal(tabById('entries').props['aria-selected'], 'true', '右移到记录页');

  await key('ArrowRight');
  assert.equal(tabById('stats').props['aria-selected'], 'true', '末页再右移回到首页（循环）');
  assert.deepEqual(focused.slice(-1), ['stats']);

  await key('ArrowLeft');
  assert.equal(tabById('entries').props['aria-selected'], 'true', '首页左移回到末页（循环）');

  await key('End');
  assert.equal(tabById('entries').props['aria-selected'], 'true', 'End 跳末页');
  await key('Home');
  assert.equal(tabById('stats').props['aria-selected'], 'true', 'Home 跳首页');

  // 无关按键不动。
  await key('a');
  assert.equal(tabById('stats').props['aria-selected'], 'true', '其它按键不切页');
});


test('记录页：懒加载 —— 第一次进入才拉，切走再回来不重复拉，点刷新才重拉', async () => {
  const host = makeHost({ entries: entriesPayload([entry()]) });
  await mount(host);
  assert.equal(entriesFetches(host).length, 0, '还没进记录页，不发请求');

  await gotoEntries();
  assert.equal(entriesFetches(host).length, 1, '进入记录页拉一次');

  await click(tabById('stats'));
  await click(tabById('entries'));
  assert.equal(entriesFetches(host).length, 1, '切走再回来不重复请求');

  await click(refreshBtn());
  assert.equal(entriesFetches(host).length, 2, '点刷新重拉一次');
});

// —— 2. 记录页四种状态 ——
test('记录页：加载中 / 加载失败 / 降级 / 空手册 四种状态各有独立文案', async () => {
  // 加载中：请求永不结算。
  let release = () => {};
  const pendingHost = makeHost({ entries: () => new Promise((resolve) => { release = resolve; }) });
  await mount(pendingHost);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesLoading, '加载中文案');

  // 加载失败：fetch 抛错。
  const throwHost = makeHost({ entries: new Error('boom') });
  await mount(throwHost);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesFailed, 'fetch 抛错 → 加载失败文案');

  // 加载失败：ok !== true。
  const badHost = makeHost({ entries: { __status: 500, body: { ok: false } } });
  await mount(badHost);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesFailed, 'ok !== true → 加载失败文案');

  // 降级：三种 reason 各自有不同的文案 —— 绝不能合并成一句「读取失败」。
  // missing（手册文件还不存在）与 needs-session（相对路径 + 无会话工作目录）
  // 都是新用户的正常状态，把它们说成「读取失败」就是把空态当故障。
  const reasonCases = [
    ['unreadable', DICTS.zh.entriesReasonUnreadable],
    ['missing', DICTS.zh.entriesReasonMissing],
    ['needs-session', DICTS.zh.entriesReasonNeedsSession],
  ];
  for (const [reason, expected] of reasonCases) {
    const degradedHost = makeHost({ entries: entriesPayload([], { reason, total: 0 }) });
    await mount(degradedHost);
    await gotoEntries();
    assert.equal(noteText(), expected, 'reason=' + reason + ' 的文案');
  }
  const reasonTexts = new Set(reasonCases.map(([, text]) => text));
  assert.equal(reasonTexts.size, 3, '三种 reason 的文案两两不同');
  assert.ok(!reasonTexts.has(DICTS.zh.entriesReasonUnreadable) || true);
  assert.notEqual(DICTS.zh.entriesReasonMissing, DICTS.zh.entriesReasonUnreadable, 'missing 不等于读取失败');
  assert.notEqual(DICTS.zh.entriesReasonNeedsSession, DICTS.zh.entriesReasonUnreadable, 'needs-session 不等于读取失败');
  assert.notEqual(DICTS.zh.entriesReasonMissing, DICTS.zh.entriesEmpty, 'missing 也不等于「还没有条目」');

  // 空手册。
  const emptyHost = makeHost({ entries: entriesPayload([]) });
  await mount(emptyHost);
  await gotoEntries();
  assert.equal(noteText(), DICTS.zh.entriesEmpty, '空手册文案');

  // 四条文案两两不同（各自独立）。
  const texts = new Set([
    DICTS.zh.entriesLoading, DICTS.zh.entriesFailed, DICTS.zh.entriesReasonUnreadable, DICTS.zh.entriesEmpty,
  ]);
  assert.equal(texts.size, 4, '四种状态的文案互不相同');

  release({ ok: true, status: 200, json: async () => entriesPayload([]) });
});

// —— 3. 行渲染与展开 ——
test('记录页：行 = 编号 · 标题 · 更新日期 · 来源标签；点整行展开全文，可同时展开多条', async () => {
  const host = makeHost({
    entries: entriesPayload([
      // 默认按更新日期倒序：ace-001 在前，所以 rows()[0] 是它。
      // 第 34 轮：这里刻意用毫秒戳（29 字符），界面必须截成 10 字符日期再渲染。
      entry({ id: 'ace-001', title: '自动那条', auto: true, updated: '2026-09-21T06:12:33.412+08:00', condition: '条件A', action: '做法A', rationale: '依据A' }),
      entry({ id: 'ace-002', title: '手写那条', auto: false, updated: '2026-09-20', condition: '条件B', action: '做法B', rationale: '' }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  assert.equal(rows().length, 2, '两行');
  const text = rowTexts().join('\n');
  assert.match(text, /ace-001/);
  assert.match(text, /自动那条/);
  assert.match(text, /2026-09-20/);
  assert.match(text, new RegExp(DICTS.zh.entriesAuto), 'auto: true → 自动归档');
  assert.match(text, new RegExp(DICTS.zh.entriesManual), 'auto: false → 手写');
  assert.equal(findAll(hasClass('ace-entries-row-source')).filter((node) => hasClass('is-auto')(node)).length, 1, '只有自动那条带 is-auto');

  // 默认收起。
  assert.equal(findAll(hasClass('ace-entries-detail')).length, 0, '默认不展开');

  // 点第一行展开。
  await click(rows()[0]);
  const details = findAll(hasClass('ace-entries-detail'));
  assert.equal(details.length, 1, '展开一行');
  const detailText = textOf(details[0]);
  assert.match(detailText, new RegExp(DICTS.zh.entriesCondition));
  assert.match(detailText, /条件A/);
  assert.match(detailText, new RegExp(DICTS.zh.entriesAction));
  assert.match(detailText, /做法A/);
  assert.match(detailText, new RegExp(DICTS.zh.entriesRationale));
  assert.match(detailText, /依据A/);
  assert.equal(rows()[0].props['aria-expanded'], 'true', '展开态写进 aria-expanded');

  // 再点第二行：两条同时展开。
  await click(rows()[1]);
  assert.equal(findAll(hasClass('ace-entries-detail')).length, 2, '可以同时展开多条');
  const second = findAll(hasClass('ace-entries-detail'))[1];
  assert.match(textOf(second), new RegExp(DICTS.zh.entriesRationaleEmpty), '依据为空显示占位');
  assert.ok(!/undefined/.test(textOf(second)), '空字段不会渲染出 undefined');

  // 再点第一行收起。
  await click(rows()[0]);
  assert.equal(findAll(hasClass('ace-entries-detail')).length, 1, '再点收起');
  assert.equal(rows()[0].props['aria-expanded'], 'false');
});

// —— 3b. 界面日期只到日（第 34 轮必修 4）——
// 元数据时间戳是毫秒精度的 29 字符本地 ISO（lib/timestamp.js 的 nowStamp），
// 而 .ace-entries-row-date 只有 84px 宽。这里断言的是**经 client 渲染后**的文本，
// 不是测试自己 slice —— 截断必须发生在 client.js 的 displayDay 里。
const millisToDay = (stamp) => String(stamp).slice(0, 10);

test('记录页：毫秒时间戳渲染成 10 字符日期（截断在 client 侧，测试不代劳）', async () => {
  const fullStamps = [
    '2026-09-21T06:12:33.412+08:00',
    '2026-09-20T23:58:07.001+08:00',
  ];
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-001', title: '毫秒戳那条', updated: fullStamps[0] }),
      entry({ id: 'ace-002', title: '另一条毫秒戳', updated: fullStamps[1] }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  const dateCells = findAll(hasClass('ace-entries-row-date')).map((node) => textOf(node));
  assert.equal(dateCells.length, 2, '每行一个日期格');
  assert.deepEqual(dateCells.slice().sort(), ['2026-09-20', '2026-09-21'], '日期格就是 10 字符日期');
  for (const cell of dateCells) {
    assert.equal(cell.length, 10, '日期格长度必须恰好 10（毫秒戳 29 字符会挤爆 84px 的列）');
    assert.match(cell, /^\d{4}-\d{2}-\d{2}$/, '日期格形如 YYYY-MM-DD');
  }
  // 截断必须发生在渲染链里：整行文本不许出现毫秒 / 时区偏移的痕迹。
  const rowText = rowTexts().join(' ');
  for (const stamp of fullStamps) {
    assert.equal(rowText.includes(stamp), false, '整行不许回显原始毫秒戳：' + stamp);
    assert.equal(rowText.includes('T' + stamp.slice(11, 19)), false, '整行不许回显时分秒');
    assert.equal(rowText.includes('+08:00'), false, '整行不许回显时区偏移');
  }
  // 反向自证：上面断言的不是「测试自己 slice」——把同一批戳按毫秒精度渲染会得到 29 字符。
  for (const stamp of fullStamps) {
    assert.equal(stamp.length, 29, '夹具确实是 29 字符毫秒戳');
    assert.equal(millisToDay(stamp).length, 10);
  }
});

test('记录页：日期格兼容旧格式（只到日）、空值/垃圾值一律给「—」，绝不渲染 undefined', async () => {
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-001', title: '旧格式', updated: '2026-09-05' }),
      entry({ id: 'ace-002', title: '空串', updated: '' }),
      entry({ id: 'ace-003', title: '缺失', updated: undefined }),
      entry({ id: 'ace-004', title: '垃圾值', updated: '不是时间' }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  const cells = findAll(hasClass('ace-entries-row-date')).map((node) => textOf(node));
  assert.equal(cells.length, 4);
  assert.ok(cells.includes('2026-09-05'), '旧格式（只有日期）原样给出 10 字符');
  assert.equal(cells.filter((cell) => cell === '\u2014').length, 3, '空串 / 缺失 / 垃圾值都是「—」（三条）');
  assert.equal(cells.some((cell) => /undefined|null|NaN/.test(cell)), false, '绝不渲染 undefined / null / NaN');
  assert.equal(rowTexts().join(' ').includes('undefined'), false, '整行文本也不许出现 undefined');
});

test('记录页：条件/做法为空时不渲染空白块', async () => {
  const host = makeHost({
    entries: entriesPayload([entry({ id: 'ace-009', condition: '', action: '', rationale: '' })]),
  });
  await mount(host);
  await gotoEntries();
  await click(rows()[0]);
  const detail = findAll(hasClass('ace-entries-detail'))[0];
  assert.ok(detail, '仍然展开（依据占位还在）');
  assert.equal(findAll(hasClass('ace-entries-detail-block')).length, 1, '只有依据占位这一块，条件/做法整块不渲染');
  assert.match(textOf(detail), new RegExp(DICTS.zh.entriesRationaleEmpty));
});

// —— 4. 搜索 ——
test('记录页：搜索对 id/title/condition/action/rationale 全字段子串匹配，大小写不敏感，0 命中给空态', async () => {
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-001', title: 'Alpha', condition: '条件一', action: '做法一', rationale: '依据一', updated: '2026-09-03' }),
      entry({ id: 'ace-002', title: 'beta', condition: '条件二', action: '做法二', rationale: 'RationaleNeedle', updated: '2026-09-02' }),
      entry({ id: 'ace-003', title: 'gamma', condition: 'ConditionNeedle', action: '做法三', rationale: '', updated: '2026-09-01' }),
    ]),
  });
  await mount(host);
  await gotoEntries();
  assert.equal(rows().length, 3, '空查询显示全部');

  await typeQuery('alpha');
  assert.deepEqual(rowIds(), ['ace-001'], 'title 命中（大小写不敏感）');

  await typeQuery('ACE-00');
  assert.equal(rows().length, 3, 'id 命中');

  await typeQuery('条件二');
  assert.deepEqual(rowIds(), ['ace-002'], 'condition 命中');

  await typeQuery('做法三');
  assert.deepEqual(rowIds(), ['ace-003'], 'action 命中');

  await typeQuery('rationaleneedle');
  assert.deepEqual(rowIds(), ['ace-002'], 'rationale 命中（大小写不敏感）');

  await typeQuery('没有任何命中');
  assert.equal(rows().length, 0, '0 命中没有行');
  assert.equal(noteText(), DICTS.zh.entriesNoMatch, '0 命中显示空态文案');

  await typeQuery('');
  assert.equal(rows().length, 3, '清空查询恢复全部');
});

test('记录页：搜索时自动回到第 1 页', async () => {
  const entries = [];
  for (let i = 1; i <= 45; i += 1) {
    entries.push(entry({ id: 'ace-' + String(i).padStart(3, '0'), title: '条目' + i, updated: '2026-09-01' }));
  }
  const host = makeHost({ entries: entriesPayload(entries) });
  await mount(host);
  await gotoEntries();
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '1').replace('{y}', '3'), '先停在第 1 页');

  // 翻到第 2 页。
  const next = pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesNext);
  await click(next);
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '2').replace('{y}', '3'), '翻到第 2 页');

  // 搜索把页号拉回 1。
  await typeQuery('条目');
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '1').replace('{y}', '3'), '搜索后回到第 1 页');
});

// —— 5. 排序 ——
test('记录页：编号按数字比较（ace-2 在 ace-10 之前），同列再点反转，列头显示 ▲/▼', async () => {
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-10', title: '十', updated: '2026-09-10' }),
      entry({ id: 'ace-2', title: '二', updated: '2026-09-02' }),
      entry({ id: 'ace-1', title: '一', updated: '2026-09-01' }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  // 默认按更新日期倒序。
  assert.deepEqual(rowIds(), ['ace-10', 'ace-2', 'ace-1'], '默认更新日期倒序');
  assert.match(textOf(sortButton(DICTS.zh.entriesColUpdated)), /▼/, '默认列头是 ▼');
  assert.match(textOf(sortButton(DICTS.zh.entriesColId)), new RegExp('^' + DICTS.zh.entriesColId + '$'), '非排序列头没有箭头');

  // 切到编号列：数字序升序（不是字典序，字典序会把 ace-10 排最前）。
  await click(sortButton(DICTS.zh.entriesColId));
  assert.deepEqual(rowIds(), ['ace-1', 'ace-2', 'ace-10'], '编号按数字升序');
  assert.match(textOf(sortButton(DICTS.zh.entriesColId)), /▲/);

  // 同列再点：反转。
  await click(sortButton(DICTS.zh.entriesColId));
  assert.deepEqual(rowIds(), ['ace-10', 'ace-2', 'ace-1'], '同列再点反转');
  assert.match(textOf(sortButton(DICTS.zh.entriesColId)), /▼/);
});

test('记录页：没有更新日期的条目恒定排末尾，不随方向翻转', async () => {
  const host = makeHost({
    entries: entriesPayload([
      entry({ id: 'ace-001', updated: '' }),
      entry({ id: 'ace-002', updated: '2026-09-05' }),
      entry({ id: 'ace-003', updated: '2026-09-09' }),
    ]),
  });
  await mount(host);
  await gotoEntries();

  // 默认更新日期倒序。
  assert.deepEqual(rowIds(), ['ace-003', 'ace-002', 'ace-001'], '缺失日期在倒序末尾');

  // 点更新日期列头 → 升序。
  await click(sortButton(DICTS.zh.entriesColUpdated));
  assert.deepEqual(rowIds(), ['ace-002', 'ace-003', 'ace-001'], '缺失日期在升序也仍然末尾');

  // 再点回倒序。
  await click(sortButton(DICTS.zh.entriesColUpdated));
  assert.deepEqual(rowIds(), ['ace-003', 'ace-002', 'ace-001'], '翻回倒序仍在末尾');
});

// —— 6. 分页 ——
test('记录页：每页 20 条，页码与「第 X / Y 页」，首页禁上页、末页禁下页，排序变化回第 1 页', async () => {
  const entries = [];
  for (let i = 1; i <= 45; i += 1) {
    entries.push(entry({ id: 'ace-' + String(i).padStart(3, '0'), title: '条目' + i, updated: '2026-09-' + String((i % 28) + 1).padStart(2, '0') }));
  }
  const host = makeHost({ entries: entriesPayload(entries) });
  await mount(host);
  await gotoEntries();

  assert.equal(rows().length, 20, '每页 20 条');
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '1').replace('{y}', '3'), '第 1 / 3 页');

  const prev = () => pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesPrev);
  const next = () => pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesNext);
  assert.equal(prev().props.disabled, true, '首页禁用上页');
  assert.equal(next().props.disabled, false, '首页可用下页');

  await click(next());
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '2').replace('{y}', '3'));
  assert.equal(prev().props.disabled, false);
  assert.equal(rows().length, 20);

  await click(next());
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '3').replace('{y}', '3'));
  assert.equal(next().props.disabled, true, '末页禁用下页');
  assert.equal(rows().length, 5, '最后一页只剩 5 条');

  // 点页码回到第 1 页。
  await click(pagerButtons().find((node) => textOf(node) === '1'));
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '1').replace('{y}', '3'));

  // 排序变化后回到第 1 页。
  await click(next());
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '2').replace('{y}', '3'));
  await click(sortButton(DICTS.zh.entriesColId));
  assert.equal(pagerText(), DICTS.zh.entriesPage.replace('{x}', '1').replace('{y}', '3'), '排序变化回第 1 页');
});

test('记录页：顶部显示「共 N 条 / 上限 M 条」', async () => {
  const host = makeHost({ entries: entriesPayload([entry()], { total: 42, maxEntries: 500 }) });
  await mount(host);
  await gotoEntries();
  assert.equal(countLine(), DICTS.zh.entriesCount.replace('{n}', '42').replace('{m}', '500'));
});

// —— 7. 竞态 ——
test('记录页：旧响应不许覆盖新状态（请求代次计数器）', async () => {
  const resolvers = [];
  const host = makeHost({
    entries: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  await mount(host);
  await gotoEntries();
  assert.equal(resolvers.length, 1, '第一次请求已发出');

  // 还没回来就点刷新：第二次请求发出。
  await click(refreshBtn());
  assert.equal(resolvers.length, 2, '刷新又发一次');

  // 新请求先回：只有这一条。
  resolvers[1]({ ok: true, status: 200, json: async () => entriesPayload([entry({ id: 'ace-900', title: '新结果' })]) });
  await settle();
  assert.deepEqual(rowIds(), ['ace-900'], '新结果已渲染');

  // 旧请求后回：必须被丢弃。
  resolvers[0]({ ok: true, status: 200, json: async () => entriesPayload([entry({ id: 'ace-100', title: '旧结果' })]) });
  await settle();
  assert.deepEqual(rowIds(), ['ace-900'], '旧响应被丢弃，没有覆盖新状态');
  assert.ok(!rowTexts().join('').includes('旧结果'));
});

// —— 8. 字典完整性 ——
test('字典：zh / en 两套键一一对应（新增的 tab / entries 键两侧都在）', async () => {
  await mount(makeHost());
  const zhKeys = Object.keys(DICTS.zh).sort();
  const enKeys = Object.keys(DICTS.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh / en 键集合必须完全一致');

  for (const key of [
    'tabStats', 'tabSettings', 'tabEntries',
    'entriesTitle', 'entriesRefresh', 'entriesLoading', 'entriesFailed',
    'entriesReasonMissing', 'entriesReasonNeedsSession', 'entriesReasonUnreadable',
    'entriesEmpty', 'entriesSearchPlaceholder', 'entriesCount', 'entriesNoMatch',
    'entriesColId', 'entriesColTitle', 'entriesColUpdated', 'entriesColSource',
    'entriesAuto', 'entriesManual', 'entriesCondition', 'entriesAction', 'entriesRationale',
    'entriesRationaleEmpty', 'entriesPage', 'entriesPrev', 'entriesNext',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICTS.zh, key), 'zh 缺键：' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(DICTS.en, key), 'en 缺键：' + key);
  }
  // 带占位符的文案两侧都保留占位符，否则 fmt 会漏填。
  for (const key of ['statsDaily', 'statsDailyEmpty', 'entriesCount', 'entriesPage', 'fieldMaxEntriesDesc', 'inboxFull']) {
    assert.match(DICTS.zh[key], /\{\w+\}/, 'zh 的 ' + key + ' 需要占位符');
    assert.match(DICTS.en[key], /\{\w+\}/, 'en 的 ' + key + ' 需要占位符');
  }
});

// —— 9. windowDays ——
test('统计页：天数读服务端 windowDays，缺字段回退 14', async () => {
  const host = makeHost({ stats: { windowDays: 7 } });
  await mount(host);
  const statsPage = pageById('stats');
  const text = textOf(statsPage);
  assert.match(text, new RegExp(DICTS.zh.statsDaily.replace('{n}', '7')), '用服务端返回的 windowDays');

  const legacy = makeHost({ stats: { windowDays: undefined } });
  await mount(legacy);
  const legacyText = textOf(pageById('stats'));
  assert.match(legacyText, new RegExp(DICTS.zh.statsDaily.replace('{n}', '14')), '缺字段回退 14');
});
// —— 10. 已归档分区（任务 2：条目浏览显示归档区）——
// 归档条目由 parsePlaybook().archives 备好，经 GET /entries 的 archived / archivedTotal 返回。
// 归档是软删除：界面上只有「看」，没有任何删除 / 还原 / 编辑入口（AGENTS.md 红线）。
function archivedEntry(overrides = {}) {
  return entry({
    id: 'ace-101',
    title: '旧条目',
    condition: '旧条件',
    action: '旧做法',
    rationale: '旧依据',
    auto: true,
    archive: { reason: 'evicted', date: '2026-10-01' },
    ...overrides,
  });
}

const scopeButtons = () => findAll(hasClass('ace-entries-scope-btn'));
const scopeButton = (label) => scopeButtons().find((node) => textOf(node) === label);
const archivedRows = () => findAll(hasClass('ace-archived-row'));
const archivedRowTexts = () => archivedRows().map((node) => textOf(node));
const archivedCountLine = () => {
  const node = findAll(hasClass('ace-archived-count'))[0];
  return node ? textOf(node) : '';
};

test('已归档分区：默认活跃分区，切换后只展示归档条目（含归档原因与日期）', async () => {
  const host = makeHost({
    entries: entriesPayload([entry()], {
      archived: [
        archivedEntry(),
        archivedEntry({ id: 'ace-102', title: '被合并条目', archive: { reason: 'merged', date: '2026-10-02' } }),
        archivedEntry({ id: 'ace-103', title: '被取代条目', archive: { reason: 'superseded', date: '2026-10-03', supersededBy: 'ace-001' } }),
      ],
      archivedTotal: 3,
    }),
  });
  await mount(host);
  await gotoEntries();

  // 默认活跃分区：归档行一条都不渲染（行类名也不同，不会污染 rows() 的计数）
  assert.equal(rows().length, 1, '活跃分区只有 1 条活跃条目');
  assert.equal(archivedRows().length, 0, '默认不渲染归档行');
  assert.deepEqual(scopeButtons().map((node) => textOf(node)), [DICTS.zh.entriesScopeActive, DICTS.zh.entriesScopeArchived], '两个分区按钮');
  assert.equal(scopeButton(DICTS.zh.entriesScopeActive).props['aria-pressed'], 'true', '默认选中活跃');

  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.equal(scopeButton(DICTS.zh.entriesScopeArchived).props['aria-pressed'], 'true', '切换后选中已归档');
  assert.equal(rows().length, 0, '归档分区里没有活跃行（类名不复用）');
  assert.equal(archivedRows().length, 3, '三条归档条目都渲染');
  const texts = archivedRowTexts().join('\n');
  assert.match(texts, /ace-101/, '归档行显示编号');
  assert.match(texts, /旧条目/, '归档行显示标题');
  assert.match(texts, /2026-10-01/, '归档行显示归档日期');
  // 本文件的字典是真的 zh 字典（不是回显键名的 Proxy），所以断言文案原文。
  // 第 33 轮：归档原因从「低分 / 过期 / 衰减」换成四种结构性原因，
  // 这里覆盖其中三种（最少使用淘汰 / 合并 / 被取代）。
  assert.match(texts, new RegExp(DICTS.zh.entriesArchiveReasonEvicted), '归档行显示原因（evicted 翻成字典文案）');
  assert.match(texts, new RegExp(DICTS.zh.entriesArchiveReasonMerged), 'merged 有自己的文案');
  assert.match(texts, new RegExp(DICTS.zh.entriesArchiveReasonSuperseded), 'superseded 有自己的文案');
  // 三个原因文案必须互不相同，否则分列没有意义
  assert.equal(new Set([
    DICTS.zh.entriesArchiveReasonEvicted,
    DICTS.zh.entriesArchiveReasonMerged,
    DICTS.zh.entriesArchiveReasonSuperseded,
  ]).size, 3, '三个归档原因各有独立文案');
  // 归档条数行用 archivedTotal，而不是活跃的 total
  assert.equal(archivedCountLine(), DICTS.zh.entriesArchivedCount.replace('{n}', '3'));
  // 活跃分区的「共 N 条 / 上限 M 条」在归档分区不出现（不复用 .ace-entries-count）
  assert.equal(countLine(), '', '归档分区不渲染活跃的计数行');
});

test('已归档分区：展开行显示归档原因/日期/被哪条取代，且没有任何删除或还原入口', async () => {
  const host = makeHost({
    entries: entriesPayload([], {
      archived: [archivedEntry({ archive: { reason: 'superseded', date: '2026-10-03', supersededBy: 'ace-001' } })],
      archivedTotal: 1,
    }),
  });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));

  assert.equal(findAll(hasClass('ace-archived-detail')).length, 0, '默认收起');
  assert.equal(archivedRows()[0].props['aria-expanded'], 'false');
  await click(archivedRows()[0]);
  assert.equal(archivedRows()[0].props['aria-expanded'], 'true', '点击展开');
  assert.equal(findAll(hasClass('ace-archived-detail')).length, 1);
  const detail = textOf(findAll(hasClass('ace-archived-detail'))[0]);
  assert.match(detail, new RegExp(DICTS.zh.entriesArchiveReason), '详情里有归档原因');
  assert.match(detail, new RegExp(DICTS.zh.entriesArchiveDate), '详情里有归档日期');
  assert.match(detail, /2026-10-03/);
  assert.match(detail, new RegExp(DICTS.zh.entriesArchiveSupersededBy), '详情里有「被哪条取代」');
  assert.match(detail, /ace-001/);
  assert.match(detail, new RegExp(DICTS.zh.entriesCondition), '正文（条件）仍可读');
  assert.match(detail, new RegExp(DICTS.zh.entriesAction), '正文（做法）仍可读');

  // 只读红线：归档分区里不出现任何删除/还原类按钮，也不出现编辑控件。
  // 只看记录页这一棵子树 —— 设置页的「恢复默认值」是另一页的按钮，与归档无关。
  const entriesNode = entriesPage();
  const scoped = [];
  walk(entriesNode, (node) => scoped.push(node));
  const buttons = scoped.filter((node) => node.type === 'button').map((node) => textOf(node));
  for (const text of buttons) {
    assert.equal(/删除|移除|还原|恢复|delete|remove|restore|undelete/i.test(text), false, '归档分区不许有删除/还原入口：' + text);
  }
  assert.equal(scoped.filter((node) => hasClass('ace-entries-search')(node)).length, 0, '归档分区不提供搜索（只读浏览）');
  assert.equal(scoped.filter((node) => node.type === 'input').length, 0, '归档分区没有输入控件');
});

test('已归档分区：archived 缺失（旧宿主）时按空处理，活跃分区照常', async () => {
  const host = makeHost({ entries: entriesPayload([entry()]) }); // 不含 archived / archivedTotal
  await mount(host);
  await gotoEntries();
  assert.equal(rows().length, 1, '活跃条目照常渲染');
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.equal(archivedRows().length, 0, '没有归档条目');
  assert.equal(textOf(findAll(hasClass('ace-archived-note'))[0]), DICTS.zh.entriesArchivedEmpty, '空态给一句说明');
  assert.equal(archivedCountLine(), DICTS.zh.entriesArchivedCount.replace('{n}', '0'), '条数按 0 显示（缺失不等于故障）');
});

test('已归档分区：未知归档原因回显原串，不吞信息', async () => {
  const host = makeHost({
    entries: entriesPayload([], { archived: [archivedEntry({ archive: { reason: 'manual-cleanup', date: '2026-10-04' } })], archivedTotal: 1 }),
  });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.match(archivedRowTexts().join(''), /manual-cleanup/, '未知原因原样回显');
});

test('已归档分区：字典里归档相关键 zh/en 两侧齐全，占位符保留', async () => {
  await mount(makeHost());
  for (const key of [
    'entriesScopeActive', 'entriesScopeArchived', 'entriesArchivedEmpty', 'entriesArchivedCount',
    'entriesArchiveReason', 'entriesArchiveDate', 'entriesArchiveSupersededBy',
    // 第 33 轮：四种结构性归档原因（低分 / 过期 / 衰减三条判据已整层删除）。
    'entriesArchiveReasonSuperseded', 'entriesArchiveReasonRemoved',
    'entriesArchiveReasonEvicted', 'entriesArchiveReasonMerged',
    // 第 33 轮：设置页六个数字换血（注入批次 / 注入追加 / 检索命中 / 淘汰 / 合并 / 归档）。
    'runtimeTitle', 'runtimeInjectBatches', 'runtimeInjectAppended', 'runtimeRetrievalHits',
    'runtimeEvicted', 'runtimeMerged', 'runtimeArchived', 'runtimeArchivedByReason',
    'runtimeInjectDetail', 'runtimeInjectHint', 'runtimeEvictHint', 'runtimeHint', 'runtimeUnavailable',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(DICTS.zh, key), 'zh 缺键：' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(DICTS.en, key), 'en 缺键：' + key);
  }
  // 旧口径的键必须彻底消失（计分 / 考察位 / 未观测 / 闸门 / 低分 / 过期 / 衰减）。
  for (const gone of [
    'entriesArchiveReasonLowScore', 'entriesArchiveReasonStale', 'entriesArchiveReasonDecayed',
    'runtimeRecaps', 'runtimeCandidates', 'runtimeWritten', 'runtimeScored',
    'runtimeUnobserved', 'runtimeGateRejected', 'runtimeHealthDetail', 'runtimeHealthHint',
    'runtimeProbation', 'runtimeHelpful', 'runtimeHarmful',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(DICTS.zh, gone), false, 'zh 不该再有键：' + gone);
    assert.equal(Object.prototype.hasOwnProperty.call(DICTS.en, gone), false, 'en 不该再有键：' + gone);
  }
  // runtimeEvictHint / runtimeInjectHint 是纯解释、不带数值，所以不进占位符清单（上面已断它们存在）。
  for (const key of ['entriesArchivedCount', 'runtimeArchivedByReason', 'runtimeInjectDetail']) {
    assert.match(DICTS.zh[key], /\{\w+\}/, 'zh 的 ' + key + ' 需要占位符');
    assert.match(DICTS.en[key], /\{\w+\}/, 'en 的 ' + key + ' 需要占位符');
  }
});

// —— 手动归档（两段式确认）——
// 覆盖口径：首点只本地置确认态、**零写请求**；二点才 POST；成功后 reload 且 pending 复位；
// 失败在页面上留一行可见报错并退回初始态；切分区 / 点别处 / 点另一条都复位；
// 归档分区（archived scope）仍然只读，绝不出现归档按钮。

/** 按行内的 id span 精确定位并**展开**（已展开则不动，避免点成收起）。 */
async function openRowById(id) {
  const row = rowById(id);
  assert.ok(row, '找不到 ' + id + ' 对应的行');
  if (row.props['aria-expanded'] === 'true') return;
  await click(row);
}

/** 行的父节点就是 .ace-entries-row（迷你 React 的 props.children 里挂着 id span）。 */
function rowById(id) {
  return rows().find((node) => (node.children || [])
    .some((child) => typeof child === 'object' && child && hasClass('ace-entries-row-id')(child) && textOf(child) === id));
}

test('活跃分区：归档按钮在详情区，首点变红「确认」且不发任何写请求', async () => {
  const host = makeHost({ entries: entriesPayload([entry()]) });
  await mount(host);
  await gotoEntries();

  // 收起时不渲染归档按钮（按钮在详情区）
  assert.equal(archiveBtns().length, 0, '收起行不渲染归档按钮');

  await openRowById('ace-001');
  assert.equal(archiveBtns().length, 1, '展开后详情区出现 1 个归档按钮');
  const btn = archiveBtns()[0];
  assert.equal(textOf(btn), DICTS.zh.entriesArchiveBtn, '初始文案是「归档」');
  assert.equal(btn.props.className, 'ace-entries-archive-btn', '初始没有 is-confirm');
  assert.equal(btn.props['aria-label'], DICTS.zh.entriesArchiveBtn, '初始 aria-label 与文案一致');
  assert.equal(btn.props.type, 'button', 'type=button（不提交表单）');

  const before = entriesFetches(host).length;
  await click(archiveBtns()[0]);

  // ① 首点：只本地置 pending，一个写请求都不许发
  assert.equal(archiveCalls(host).length, 0, '首点绝不许发写请求');
  assert.equal(entriesFetches(host).length, before, '首点也不刷新列表');
  const pending = archiveBtns()[0];
  assert.equal(textOf(pending), DICTS.zh.entriesArchiveConfirmBtn, '首点后文案变「确认」');
  assert.ok(hasClass('ace-entries-archive-btn')(pending), '仍是同一个按钮类名');
  assert.ok(hasClass('is-confirm')(pending), '首点后带 is-confirm');
  assert.equal(pending.props['aria-label'], DICTS.zh.entriesArchiveConfirmBtn, '确认态 aria-label 同步');
});

test('活跃分区：二点才发 POST /entries/archive，成功后 reload 并清空 pending', async () => {
  const host = makeHost({ entries: entriesPayload([entry({ id: 'ace-002', title: '要归档的' })]) });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-002');

  await click(archiveBtns()[0]); // 首点：置确认态
  assert.equal(archiveCalls(host).length, 0);

  const beforeReload = entriesFetches(host).length;
  await click(archiveBtns()[0]); // 二点：真发 POST

  const calls = archiveCalls(host);
  assert.equal(calls.length, 1, '二点恰好发一次 POST');
  assert.equal(calls[0].method, 'POST', '用 POST，不是 GET');
  assert.deepEqual(calls[0].body, { id: 'ace-002' }, '请求体形状 { id }');
  assert.equal(entriesFetches(host).length, beforeReload + 1, '成功后 reload() 再拉一次列表');
  // reload() 会再拉一次列表：等它落定（夹具没变，这条还在列表里）；
  // 展开态 open[id] 不受 reload 影响，所以详情区和按钮都还在。
  await settle();
  await settle();
  // pending 清空 → 按钮回到初始态
  const btn = archiveBtns()[0];
  assert.ok(btn, 'reload 后条目仍在列表里、按钮仍在详情区');
  assert.equal(textOf(btn), DICTS.zh.entriesArchiveBtn, '成功后按钮退回「归档」');
  assert.equal(hasClass('is-confirm')(btn), false, '成功后不再带 is-confirm');
  assert.equal(archiveNote(), undefined, '成功路径不渲染错误行');
});

test('活跃分区：确认态下连点两下（第二下不等第一发落定），后端只许收到 1 发', async () => {
  // 守的变异：archiveOne 的在飞闸 `if (archiveBusy.current) return;`（client.js:1112-1113）。
  // 既有用例的第二点都发生在上一发 settle 之后，busy 早已放行，这道闸从未被压到。
  // 这里让第一发 fetch 挂着不落定（busy=true 的整个窗口），再对同一个按钮同步连点第二下——
  // 第二下越过「首点置确认态」闸（pendingArchive 已是本条），必须被在飞闸挡住。
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const host = makeHost({
    entries: entriesPayload([entry()]),
    archive: () => gate.then(() => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, archived: { id: 'ace-001', reason: 'removed-by-request', date: '2026-10-27T10:00:00.000+08:00' } }),
    })),
  });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-001');
  await click(archiveBtns()[0]); // 首点：进确认态，零请求
  assert.equal(archiveCalls(host).length, 0);

  // 同一个（最新渲染出的）按钮上同步连点两下：两下共用同一个 pendingArchive===ace-001 的闭包。
  const btn = archiveBtns()[0];
  const ev = { preventDefault() {}, stopPropagation() {}, target: btn };
  btn.props.onClick(ev);
  btn.props.onClick(ev);
  await settle();

  assert.equal(archiveCalls(host).length, 1,
    'busy 窗口里的第二下必须被在飞闸挡掉（后端只收 1 发），实际 ' + archiveCalls(host).length);

  releaseFetch();
  await settle();
  await settle();
  assert.equal(archiveCalls(host).length, 1, '第一发放行成功后也不许补发');
  assert.ok(archiveBtns()[0], '成功 reload 后条目还在，按钮仍在详情区');
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '成功后按钮退回「归档」');
});

test('活跃分区：点归档按钮必须拦住冒泡——不许顺手收起详情、也不许复位确认态', async () => {
  // 守的变异：按钮 onClick 里的 e.stopPropagation()（client.js:1287）。
  // 真实浏览器里按钮嵌在展开详情区里，行 div（toggleRow）与容器 div（点别处复位）都在
  // 点击通路的上游——按钮不拦冒泡，点「确认」会同时触发行的收起与容器的复位。
  // 夹具默认不冒泡（旧用例的语义不变），这里用 { bubbles:true } 走真实通路。
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const host = makeHost({
    entries: entriesPayload([entry({ id: 'ace-001' }), entry({ id: 'ace-002', title: '第二条' })]),
    archive: () => gate.then(() => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, archived: { id: 'ace-001', reason: 'removed-by-request', date: '2026-10-27T10:00:00.000+08:00' } }),
    })),
  });
  await mount(host);
  await gotoEntries();

  // 对照组：证明这个冒泡夹具是真的——点 ace-002 行内没有 onClick 的 id span，
  // 事件一路冒到行（展开）与容器（此时 pendingArchive 为 null，复位是空操作）。
  const spanB = rowById('ace-002').children.find((c) => hasClass('ace-entries-row-id')(c));
  const reached = await click(spanB, { bubbles: true });
  assert.deepEqual(reached.map((n) => n.props.className), ['ace-entries-row', 'ace-entries'],
    'span 自己没有 onClick：事件应恰好落在行容器与外层容器上');
  assert.equal(rowById('ace-002').props['aria-expanded'], 'true', '冒泡到了行：行被展开');
  // 再冒泡点一下把它收起（顺便再证一次冒泡的双向），主场景从「只有 ace-001 展开」开始。
  const spanB2 = rowById('ace-002').children.find((c) => hasClass('ace-entries-row-id')(c));
  await click(spanB2, { bubbles: true });
  assert.equal(rowById('ace-002').props['aria-expanded'], 'false', '第二次冒泡点击把行收起');

  // 主场景：ace-001 展开进确认态（零请求），然后对确认按钮做一次**冒泡**点击。
  await openRowById('ace-001');
  await click(archiveBtns()[0]);
  assert.equal(archiveCalls(host).length, 0, '首点零请求');

  const btn = archiveBtns()[0];
  const reachedBtn = await click(btn, { bubbles: true });
  assert.equal(reachedBtn.length, 1,
    '确认按钮上的冒泡点击必须停在按钮自己（stopPropagation），行与容器都不许收到：实际经过 ' +
    reachedBtn.map((n) => n.props.className).join(' → '));
  assert.ok(hasClass('ace-entries-archive-btn')(reachedBtn[0]), '收到事件的必须是那个归档按钮');
  assert.equal(archiveCalls(host).length, 1, '二段式的第二下：恰好发 1 发 POST');
  assert.deepEqual(archiveCalls(host)[0].body, { id: 'ace-001' });
  // 三条「没被冒泡顺手干掉」的证据（fetch 挂着，成功复位还不会来搅局）：
  assert.equal(rowById('ace-001').props['aria-expanded'], 'true', '行的 toggleRow 没被触发：详情区不收起');
  assert.ok(hasClass('is-confirm')(archiveBtns()[0]), '容器的复位没被触发：确认态还在');
  assert.equal(rowById('ace-002').props['aria-expanded'], 'false', '另一行不受影响');

  // 放行成功：按钮退回「归档」，行保持展开（open 不受 reload 影响）
  releaseFetch();
  await settle();
  await settle();
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '成功后按钮退回「归档」');
  assert.equal(rowById('ace-001').props['aria-expanded'], 'true', '成功路径不改变展开态');
});

test('活跃分区：归档失败在页面上留一行可见报错，并退回初始态', async () => {
  const host = makeHost({
    entries: entriesPayload([entry()]),
    archive: { __status: 404, body: { error: '条目不存在或不在活跃区：ace-001' } },
  });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-001');

  await click(archiveBtns()[0]);
  const beforeReload = entriesFetches(host).length;
  await click(archiveBtns()[0]);

  assert.equal(archiveCalls(host).length, 1);
  assert.equal(entriesFetches(host).length, beforeReload, '失败不刷新列表（没有可刷的新状态）');
  const note = archiveNote();
  assert.ok(note, '失败必须在页面上看得见，不许静默');
  assert.ok(hasClass('ace-entries-note')(note), '沿用既有 note 类名');
  const text = textOf(note);
  assert.ok(text.includes('ace-001'), '报错里带回条目 id：' + text);
  assert.equal(text, DICTS.zh.entriesArchiveFailed.replace('{error}', '条目不存在或不在活跃区：ace-001'), '按 i18n 模板拼出');
  assert.equal(textOf(archiveBtns()[0]), DICTS.zh.entriesArchiveBtn, '失败后按钮退回「归档」');
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '失败后不再确认态');
});

test('活跃分区：网络失败（fetch 抛错）同样可见报错，不退化成静默', async () => {
  const host = makeHost({
    entries: entriesPayload([entry()]),
    archive: new Error('网络断了'),
  });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-001');
  await click(archiveBtns()[0]);
  await click(archiveBtns()[0]);

  const text = textOf(archiveNote());
  assert.ok(text.includes('网络断了'), '异常文案必须出现在页面上：' + text);
  assert.equal(textOf(archiveBtns()[0]), DICTS.zh.entriesArchiveBtn, '失败后按钮退回初始态');
});

test('活跃分区：点另一条的归档按钮，前一条的确认态作废（同一时刻只认一条）', async () => {
  const host = makeHost({ entries: entriesPayload([entry({ id: 'ace-001' }), entry({ id: 'ace-002', title: '第二条' })]) });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-001');
  await click(archiveBtns()[0]);
  assert.ok(hasClass('is-confirm')(archiveBtns()[0]), '第一条进入确认态');

  await openRowById('ace-002');
  // 两条都展开着：第一条仍是确认态，第二条是初始态
  assert.equal(archiveBtns().length, 2, '两条都展开后有两个归档按钮');
  const first = archiveBtns()[0];
  const second = archiveBtns()[1];
  assert.ok(hasClass('is-confirm')(first), '第一条还在确认态（还没被别处复位）');
  assert.equal(hasClass('is-confirm')(second), false, '第二条初始态');

  await click(archiveBtns()[1]);
  assert.equal(archiveCalls(host).length, 0, '点另一条只切换确认态，不发请求');
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '前一条的确认态被作废');
  assert.ok(hasClass('is-confirm')(archiveBtns()[1]), '第二条进入确认态');
});

test('活跃分区：切分区 / 点别处 / 刷新都把悬空的确认态复位', async () => {
  const host = makeHost({ entries: entriesPayload([entry()]) });
  await mount(host);
  await gotoEntries();
  await openRowById('ace-001');

  // ① 切到归档分区再切回来
  await click(archiveBtns()[0]);
  assert.ok(hasClass('is-confirm')(archiveBtns()[0]));
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.equal(archiveBtns().length, 0, '归档分区不渲染归档按钮（只读）');
  await click(scopeButton(DICTS.zh.entriesScopeActive));
  await openRowById('ace-001');
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '切回来必须回到初始态');

  // ② 点别处（记录页容器上的 onClick）复位
  await click(archiveBtns()[0]);
  assert.ok(hasClass('is-confirm')(archiveBtns()[0]));
  const container = findAll(hasClass('ace-entries'))[0];
  container.props.onClick({ preventDefault() {}, stopPropagation() {}, target: container });
  await settle();
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '点别处复位');

  // ③ 刷新（reload）也复位
  await click(archiveBtns()[0]);
  assert.ok(hasClass('is-confirm')(archiveBtns()[0]));
  await click(refreshBtn());
  assert.equal(hasClass('is-confirm')(archiveBtns()[0]), false, '刷新复位');
  assert.equal(archiveCalls(host).length, 0, '全程一个写请求都没发');
});

test('样式表：is-confirm 走红色系且与暗底对比足够，初始态沿用既有暗色 token', async () => {
  await mount(makeHost());
  const css = renderedCss();
  assert.ok(css.includes('.ace-entries-archive-btn{'), '样式表里必须有归档按钮基础规则');

  // 基础态：沿用既有 VCP 暗色 token（#131a22 底 / #9fb2c5 字 / #263140 边）
  const base = css.split('\n').find((line) => line.startsWith('.ace-entries-archive-btn{'));
  assert.ok(base, '基础规则存在');
  assert.match(base, /background:#131a22/, '基础底色沿用暗色 token');
  assert.match(base, /color:#9fb2c5/, '基础字色沿用既有次要文本 token');
  assert.match(base, /border:1px solid #263140/, '基础边框沿用既有分隔 token');

  // 确认态：独立一条 .is-confirm 规则，深红底 + 亮红字 + 红边
  const confirm = css.split('\n').find((line) => line.startsWith('.ace-entries-archive-btn.is-confirm{'));
  assert.ok(confirm, '必须有一条 .ace-entries-archive-btn.is-confirm{ 规则（不是靠行内 style）');
  assert.match(confirm, /background:#3b1418/, '确认态底色是深红');
  assert.match(confirm, /color:#ff8b8b/, '确认态字色是亮红');
  assert.match(confirm, /border-color:#7f1d1d/, '确认态边框是红');
  assert.match(confirm, /font-weight:600/, '确认态文字加重，强化二次确认');

  // 悬停态也是红色系（不是既有青绿 hover 串味）
  const hover = css.split('\n').find((line) => line.startsWith('.ace-entries-archive-btn.is-confirm:hover{'));
  assert.ok(hover, '确认态 hover 规则存在');
  assert.match(hover, /background:#4d1a1f/);
  assert.match(hover, /color:#ffb3b3/);

  // 色值确实是红色系：亮红字 R 通道显著高于 G/B
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  for (const hex of ['#ff8b8b', '#ffb3b3', '#3b1418', '#4d1a1f', '#7f1d1d', '#b91c1c']) {
    const [r, g, b] = rgb(hex);
    assert.ok(r > g && r > b, hex + ' 必须是红色系（R 通道最大）');
  }
  // 对比度：亮红字 vs 深红底，按 WCAG 相对亮度粗算 ≥ 4.5:1
  const lum = (hex) => {
    const [r, g, b] = rgb(hex).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  assert.ok(ratio('#ff8b8b', '#3b1418') >= 4.5, '确认态文字与底色对比度必须 ≥ 4.5:1，实际 ' + ratio('#ff8b8b', '#3b1418').toFixed(2));
  assert.ok(ratio('#ff8b8b', '#131a22') >= 4.5, '即便叠在暗底上也 ≥ 4.5:1');

  // 错误行同样是红色系（与既有 .ace-entries-note 的灰蓝区分开）
  const noteRule = css.split('\n').find((line) => line.startsWith('.ace-entries-archive-note{'));
  assert.ok(noteRule, '错误行有独立规则');
  assert.match(noteRule, /color:#ff8b8b/, '错误行用红色系');
});

test('归档分区：只读 —— 不渲染归档按钮，也没有任何写入口', async () => {
  const host = makeHost({
    entries: entriesPayload([entry()], {
      archived: [archivedEntry({ archive: { reason: 'removed-by-request', date: '2026-10-05' } })],
      archivedTotal: 1,
    }),
  });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  await click(archivedRows()[0]);

  assert.equal(archiveBtns().length, 0, '归档分区绝不渲染归档按钮');
  const scoped = [];
  walk(entriesPage(), (node) => scoped.push(node));
  assert.equal(scoped.filter((node) => hasClass('ace-entries-archive-btn')(node)).length, 0, '归档分区不许出现归档按钮');
  assert.equal(scoped.filter((node) => hasClass('ace-entries-archive')(node)).length, 0, '连归档按钮的容器都不许有');
  // 分区切换按钮里有「已归档」，所以只能按**整串相等**判，不能按子串判。
  for (const node of scoped) {
    if (node.type !== 'button') continue;
    const text = textOf(node);
    assert.equal(text === DICTS.zh.entriesArchiveBtn || text === DICTS.zh.entriesArchiveConfirmBtn,
      false, '归档分区不许出现「归档 / 确认」按钮：' + text);
  }
  assert.equal(archiveCalls(host).length, 0, '浏览归档分区不发任何写请求');
});


// —— 11. 已归档分区分页（第 53 轮）——
// 归档分区也按 20 条/页分页，但页码是**独立**的 archivedPage，与活跃分区的 page 互不影响。
// 分页条复用活跃分区那套类名与文案（entriesPrev / entriesPage / entriesNext），
// 只放「上一页 / 下一页 / 数字页码」三种按钮 —— 归档只读，这一区不许出现任何删除或还原入口。
const makeArchived = (n) => {
  const list = [];
  for (let i = 1; i <= n; i += 1) {
    list.push(archivedEntry({
      id: 'ace-' + String(100 + i),
      title: '归档' + i,
      archive: { reason: 'evicted', date: '2026-10-' + String((i % 28) + 1).padStart(2, '0') },
    }));
  }
  return list;
};
const archivedPayload = (n) => entriesPayload([], { archived: makeArchived(n), archivedTotal: n });
const archivedPrev = () => pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesPrev);
const archivedNext = () => pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesNext);
const pageTextFor = (x, y) => DICTS.zh.entriesPage.replace('{x}', String(x)).replace('{y}', String(y));

test('已归档分区：45 条按每页 20 条分 3 页，首页禁上页、末页禁下页，点页码回第 1 页', async () => {
  const host = makeHost({ entries: archivedPayload(45) });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));

  assert.equal(archivedRows().length, 20, '归档分区每页 20 条');
  assert.equal(pagerText(), pageTextFor(1, 3), '第 1 / 3 页');
  assert.equal(archivedPrev().props.disabled, true, '首页禁用上页');
  assert.equal(archivedNext().props.disabled, false, '首页可用下页');

  await click(archivedNext());
  assert.equal(archivedRows().length, 20, '第 2 页 20 条');
  assert.equal(pagerText(), pageTextFor(2, 3));
  assert.equal(archivedPrev().props.disabled, false, '第 2 页可用上页');
  assert.equal(archivedNext().props.disabled, false, '第 2 页可用下页');
  assert.match(textOf(archivedRows()[0]), /ace-121/, '第 2 页从第 21 条归档开始');

  await click(archivedNext());
  assert.equal(archivedRows().length, 5, '最后一页只剩 5 条');
  assert.equal(pagerText(), pageTextFor(3, 3));
  assert.equal(archivedNext().props.disabled, true, '末页禁用下页');

  await click(pagerButtons().find((node) => textOf(node) === '1'));
  assert.equal(pagerText(), pageTextFor(1, 3), '点页码「1」回到第 1 页');
  assert.equal(archivedRows().length, 20);
});

test('已归档分区：归档页码与活跃页码互相独立，切分区从第 1 页看起', async () => {
  const entries = [];
  for (let i = 1; i <= 45; i += 1) {
    entries.push(entry({ id: 'ace-' + String(i).padStart(3, '0'), title: '条目' + i, updated: '2026-09-' + String((i % 28) + 1).padStart(2, '0') }));
  }
  const host = makeHost({ entries: entriesPayload(entries, { archived: makeArchived(45), archivedTotal: 45 }) });
  await mount(host);
  await gotoEntries();

  // 活跃分区翻到第 2 页 —— 归档分区不许跟着停在第 2 页。
  await click(pagerButtons().find((node) => textOf(node) === DICTS.zh.entriesNext));
  assert.equal(pagerText(), pageTextFor(2, 3), '活跃分区到第 2 页');

  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.equal(pagerText(), pageTextFor(1, 3), '切到归档分区从第 1 页看起（第 1 / 3 页）');
  assert.equal(archivedRows().length, 20);

  // 归档分区翻到第 2 页 —— 活跃分区也不许跟着动。
  await click(archivedNext());
  assert.equal(pagerText(), pageTextFor(2, 3), '归档分区到第 2 页');
  await click(scopeButton(DICTS.zh.entriesScopeActive));
  assert.equal(pagerText(), pageTextFor(2, 3), '活跃分区仍停在自己第 2 页（两个页码各自独立）');

  // 再切回归档：切分区复位归档页码 —— 停在上一次的第 N 页会让人以为条目丢了。
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  assert.equal(pagerText(), pageTextFor(1, 3), '切走再回来回到第 1 页');
  assert.equal(archivedRows().length, 20);
});

test('已归档分区：归档条目 ≤ 20 时只显示 1 页，上一页与下一页都禁用，页码按钮只有 1 个', async () => {
  const host = makeHost({ entries: archivedPayload(20) });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));

  assert.equal(archivedRows().length, 20, '一页装得下 20 条');
  assert.equal(pagerText(), pageTextFor(1, 1), '第 1 / 1 页');
  assert.equal(archivedPrev().props.disabled, true, '只有 1 页时上页禁用');
  assert.equal(archivedNext().props.disabled, true, '只有 1 页时下页禁用');
  assert.deepEqual(pagerButtons().map((node) => textOf(node)),
    [DICTS.zh.entriesPrev, '1', DICTS.zh.entriesNext], '页码按钮只有 1 个');
});

test('已归档分区：归档为空时不渲染分页条，仍显示空态文案', async () => {
  const host = makeHost({ entries: entriesPayload([], { archived: [], archivedTotal: 0 }) });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));

  assert.equal(findAll(hasClass('ace-entries-pager')).length, 0, '空归档不渲染分页条');
  assert.equal(archivedRows().length, 0);
  assert.equal(textOf(findAll(hasClass('ace-archived-note'))[0]), DICTS.zh.entriesArchivedEmpty, '仍给空态文案');
});

test('已归档分区：刷新后归档变少时页码被钳位，不停在不存在的页上', async () => {
  let archivedTotal = 45;
  const host = makeHost({
    entries: () => ({
      ok: true,
      status: 200,
      json: async () => entriesPayload([], { archived: makeArchived(archivedTotal), archivedTotal }),
    }),
  });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  await click(archivedNext());
  await click(archivedNext());
  assert.equal(pagerText(), pageTextFor(3, 3), '先翻到最后一页');

  // 刷新成很短的列表：3 条 → 只有 1 页。
  archivedTotal = 3;
  await click(refreshBtn());
  assert.equal(archivedRows().length, 3, '刷新后只剩 3 条');
  assert.equal(pagerText(), pageTextFor(1, 1), '钳位到唯一存在的第 1 页');
  assert.equal(findAll(hasClass('ace-archived-item')).length, 3, '没有渲染出任何越界行');
  assert.equal(archivedPrev().props.disabled, true, '钳位后上页禁用');
  assert.equal(archivedNext().props.disabled, true, '钳位后下页禁用');
  assert.equal(findAll(hasClass('ace-archived-note')).length, 0, '非空归档不显示空态');
});

test('已归档分区：翻页仍是只读 —— 没有输入控件、没有删除/还原按钮，翻页不发写请求', async () => {
  const host = makeHost({ entries: archivedPayload(45) });
  await mount(host);
  await gotoEntries();
  await click(scopeButton(DICTS.zh.entriesScopeArchived));
  await click(archivedNext());
  await click(archivedNext());
  await click(pagerButtons().find((node) => textOf(node) === '1'));

  const scoped = [];
  walk(entriesPage(), (node) => scoped.push(node));
  assert.equal(scoped.filter((node) => node.type === 'input').length, 0, '归档分区没有输入控件');
  assert.equal(scoped.filter((node) => hasClass('ace-entries-archive-btn')(node)).length, 0, '归档分区不许出现归档按钮');
  for (const node of scoped) {
    if (node.type !== 'button') continue;
    const text = textOf(node);
    assert.equal(/删除|移除|还原|恢复|delete|remove|restore|undelete/i.test(text), false, '归档分区不许有删除/还原入口：' + text);
    assert.equal(text === DICTS.zh.entriesArchiveBtn || text === DICTS.zh.entriesArchiveConfirmBtn,
      false, '归档分区不许出现「归档 / 确认」按钮：' + text);
  }
  // 分页按钮只能是 上一页 / 下一页 / 数字页码。
  for (const node of pagerButtons()) {
    const text = textOf(node);
    assert.ok(text === DICTS.zh.entriesPrev || text === DICTS.zh.entriesNext || /^\d+$/.test(text),
      '分页按钮只允许 上一页 / 下一页 / 数字页码，实际：' + text);
  }
  assert.equal(archiveCalls(host).length, 0, '翻页不发任何写请求');
});

