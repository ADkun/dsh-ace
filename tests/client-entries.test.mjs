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

async function click(node) {
  assert.equal(typeof node.props.onClick, 'function', '节点没有 onClick');
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: node });
  await settle();
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
const refreshBtn = () => findAll(hasClass('ace-entries-btn'))[0];
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
      entry({ id: 'ace-001', title: '自动那条', auto: true, updated: '2026-09-21', condition: '条件A', action: '做法A', rationale: '依据A' }),
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
