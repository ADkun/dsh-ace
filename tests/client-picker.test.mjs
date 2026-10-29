// client.js 的下拉组件行为测试。
//
// 本机没有 react / react-dom（require.resolve('react') 失败），所以这里自带一个
// 极小的 React 渲染器（createElement + useState/useRef/useEffect + 同步重渲染），
// 在 node 里真实渲染 AceSection 并派发点击 / 输入事件，检查：
// 两个下拉的占位与展开、搜索过滤、按 provider 分组、选中即提交的 POST 体、
// 清空回「跟随会话模型」、以及「只填一项」警告的显隐条件。
// 它不是浏览器：布局、CSS、真实焦点顺序不在覆盖范围内。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

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

// 多段异步链（提交 → adopt → 重拉档位 → 清空提交）要逐段结算：每次 tick 让假 fetch 落地、
// flush 把 setState 触发的效果跑完。比 click() 多等几轮，专给「点一下会有后续请求」的用例用。
async function settle(rounds = 4) {
  flush();
  for (let i = 0; i < rounds; i += 1) {
    await tick();
    await tick();
    flush();
  }
}

// —— 假宿主 ——
const CATALOG = [
  { id: 'deepseek', name: 'DeepSeek', models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
  ] },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
];
const DEFAULTS = {
  playbookPath: '', autoReflect: true, reflectProvider: '', reflectModel: '',
  maxEntries: 100, reflectReasoningEffort: '', autoReasoningDowngrade: true,
};

// /efforts 的默认返回：三个档位 + 自动模式当前会用的那一档。
// opts.efforts 可以整份替换（函数形式收到完整 url，用来测「按 provider/model 重拉」）。
const EFFORTS = {
  ok: true,
  provider: 'deepseek',
  model: 'deepseek-chat',
  efforts: [
    { id: 'high', name: '高' },
    { id: 'medium', name: '中' },
    { id: 'off', name: '关' },
  ],
  effective: { effort: 'medium', source: 'auto', reason: '自动降档' },
};

function makeHost(initial = {}, opts = {}) {
  const settings = { ...DEFAULTS, ...initial };
  const calls = [];
  const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
  const fetchStub = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === '/api/dsh-ace/catalog') return json(200, { ok: true, providers: CATALOG });
    if (url.startsWith('/api/dsh-ace/efforts')) {
      if (typeof opts.efforts === 'function') return opts.efforts(url);
      return json(200, opts.efforts || EFFORTS);
    }
    if (url === '/api/dsh-ace/settings') {
      if (method === 'POST') Object.assign(settings, JSON.parse(init.body));
      if (method === 'DELETE') Object.assign(settings, DEFAULTS);
      return json(200, { ok: true, value: { ...settings }, configured: { ...settings }, stored: {}, file: 'D:/p/dsh-ace.json' });
    }
    throw new Error('意外的请求：' + url);
  };
  return { settings, calls, fetchStub };
}

// 假字典：默认把键名当文案返回（断言文案键用）；需要验插值的少数几条给出带 {占位} 的模板。
const DICT_OVERRIDES = {
  // 「当前会自动使用：{name}」——档位名必须由前端反查后插进来。
  effortsAutoNow: '当前会自动使用：{name}',
};
const DICT = new Proxy(DICT_OVERRIDES, { get: (target, key) => (key in target ? target[key] : String(key)) });

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
  // 只取 factory 的 require('react')：其余依赖一概不允许（本插件不引第三方依赖）。
  new Function('window', 'document', 'fetch', clientSource)(fakeWindow, fakeDocument, host.fetchStub);
  const mod = spec.loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client.js 请求了未预期的模块：' + name);
  });
  const ctx = {
    locale: { bind: () => (key) => DICT[key], register: () => () => {} },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (_spec, component) => { registered = component; return () => {}; },
    },
  };
  mod.apply(ctx);
  assert.ok(registered, 'settings.section 没有注册组件');

  rootElement = createElement(registered, { close() {} });
  // 两段落链（/settings → /catalog + /efforts）都要结算：每轮 tick 让假 fetch 的 promise 落地，
  // 再 flush 把 setState 的效果跑完。旧版本只等一轮，页面停在「档位读取中」。
  flush();
  for (let round = 0; round < 3; round += 1) {
    await tick();
    await tick();
    flush();
  }
  return registered;
}

function triggers() { return findAll(hasClass('ace-pick-trigger')); }
// 列表项：排除底部「跟随会话模型（清空）」那条（它也带 ace-pick-item，但另有 ace-pick-clear）。
function panelItems() {
  return findAll((node) => hasClass('ace-pick-item')(node) && !hasClass('ace-pick-clear')(node));
}
function warning() { return findAll(hasClass('ace-set-warn')); }

test('client.js：两个下拉以占位文案渲染，初始无「只填一项」警告', async () => {
  const host = makeHost();
  await mount(host);
  const pickers = triggers();
  // provider / model / 思考强度三个下拉；思考强度那一行的占位是「跟随自动」。
  assert.equal(pickers.length, 3, 'provider / model / 思考强度三个下拉触发器');
  for (const picker of pickers) {
    assert.match(textOf(picker), /跟随会话模型|pickProviderPlaceholder|pickModelPlaceholder|pickEffortPlaceholder/);
  }
  assert.equal(warning().length, 0, '两项都空时不该出现警告');
});

test('client.js：provider 下拉展开后可搜索、选中即提交 reflectProvider', async () => {
  const host = makeHost();
  await mount(host);
  await click(triggers()[0]);

  const search = findAll(hasClass('ace-pick-search'))[0];
  assert.ok(search, '展开后应当有搜索框');
  assert.equal(panelItems().length, 2, 'provider 列表应当列出两个 provider');

  search.props.onChange({ target: { value: 'OPEN' } }); // 大小写不敏感
  flush();
  const filtered = panelItems();
  assert.equal(filtered.length, 1, '搜索 open 后只应剩 OpenAI');
  assert.match(textOf(filtered[0]), /OpenAI/);

  await click(filtered[0]);
  const posts = host.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [{ reflectProvider: 'openai' }]);
  assert.equal(host.settings.reflectProvider, 'openai');
  assert.equal(findAll(hasClass('ace-pick-panel')).length, 0, '选中后面板应当关闭');
  assert.equal(warning().length, 1, '只填 provider 时应当出现警告');
});

test('client.js：model 下拉按 provider 分组，provider 已选时只列该组', async () => {
  const host = makeHost({ reflectProvider: 'deepseek' });
  await mount(host);
  await click(triggers()[1]);
  const items = panelItems();
  assert.equal(items.length, 2, '只应列出 deepseek 的两个模型');
  assert.match(textOf(items[0]), /deepseek-chat/);
  assert.equal(findAll(hasClass('ace-pick-group')).length, 1);
  assert.match(textOf(findAll(hasClass('ace-pick-group'))[0]), /DeepSeek/);
});

test('client.js：provider 为空时选 model 一次 POST 同时提交两项', async () => {
  const host = makeHost();
  await mount(host);
  await click(triggers()[1]);
  const items = panelItems();
  assert.equal(items.length, 3, 'provider 为空时应当列出所有 provider 的模型');
  assert.equal(findAll(hasClass('ace-pick-group')).length, 2, '应当有两个分组标题');

  const gpt = items.find((item) => textOf(item).includes('gpt-4o'));
  await click(gpt);
  const posts = host.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [{ reflectProvider: 'openai', reflectModel: 'gpt-4o' }]);
  assert.equal(warning().length, 0, '两项都填后警告应当消失');
});

test('client.js：清空项提交空串并回到「跟随会话模型」', async () => {
  const host = makeHost({ reflectProvider: 'openai', reflectModel: 'gpt-4o' });
  await mount(host);
  await click(triggers()[1]);
  const clearItem = findAll(hasClass('ace-pick-foot'))[0].children[0];
  assert.match(textOf(clearItem), /pickClear/);
  await click(clearItem);
  const posts = host.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [{ reflectModel: '' }]);
  assert.equal(warning().length, 1, '清空 model 后只剩 provider，应当出现警告');
});

test('client.js：键盘 Esc 关闭、ArrowDown/ArrowUp 循环移高亮、Enter 选中', async () => {
  const host = makeHost();
  await mount(host);
  // 展开会重渲染，onKeyDown 闭包随 open/active 变化，所以每次派发前重新取节点。
  const keydown = (key) => {
    const root = findAll(hasClass('ace-pick'))[0];
    assert.equal(typeof root.props.onKeyDown, 'function', '面板容器没有 onKeyDown');
    root.props.onKeyDown({ key, preventDefault() {} });
    flush();
  };

  await click(triggers()[0]);
  assert.equal(findAll(hasClass('ace-pick-panel')).length, 1);

  keydown('ArrowDown');
  flush();
  assert.match(textOf(findAll(hasClass('ace-pick-item'))[1]), /OpenAI/, 'ArrowDown 后高亮第二项');

  // 循环：末项再 ArrowDown 回到首项，ArrowUp 又从首项回到末项。
  keydown('ArrowDown');
  assert.ok(hasClass('is-active')(findAll(hasClass('ace-pick-item'))[0]), 'ArrowDown 到末项后循环回首项');
  keydown('ArrowUp');
  assert.ok(hasClass('is-active')(findAll(hasClass('ace-pick-item'))[1]), 'ArrowUp 从首项循环到末项');

  keydown('Enter');
  const posts = host.calls.filter((call) => call.method === 'POST');
  assert.deepEqual(posts.map((call) => call.body), [{ reflectProvider: 'openai' }]);

  await click(triggers()[0]);
  keydown('Escape');
  assert.equal(findAll(hasClass('ace-pick-panel')).length, 0, 'Esc 应当关闭面板');
});

// —— R50：思考强度（reflectReasoningEffort / autoReasoningDowngrade）——
// 下拉复用 ModelPicker：第三个触发器就是它（provider=0、model=1、effort=2）。
const effortTrigger = () => triggers()[2];
const effortPosts = (host) => host.calls.filter((call) => call.method === 'POST');
const effortFetches = (host) => host.calls.filter((call) => String(call.url).startsWith('/api/dsh-ace/efforts'));
const switchById = (id) => findAll((node) => node.props?.id === id)[0];
const effortNote = () => findAll(hasClass('ace-set-effort-note')).map(textOf).join('');

test('R50｜设置页渲染出「思考强度」下拉与「自动降到最低档」开关，可访问名与 label 关联符合现有口径', async () => {
  const host = makeHost();
  await mount(host);

  const picker = effortTrigger();
  assert.ok(picker, '缺少思考强度下拉');
  assert.equal(picker.props.id, 'ace-field-reasoningEffort');
  assert.equal(picker.props['aria-label'], 'fieldReasoningEffort');
  assert.equal(picker.props['aria-labelledby'], 'ace-field-reasoningEffort-label');
  const labels = findAll((node) => node.props?.htmlFor === 'ace-field-reasoningEffort');
  assert.equal(labels.length, 1, 'FieldRow 的 label 应当 htmlFor 指向选中器');
  assert.equal(labels[0].props.id, 'ace-field-reasoningEffort-label');
  assert.match(textOf(labels[0]), /fieldReasoningEffort/);

  const sw = switchById('ace-field-autoReasoningDowngrade');
  assert.ok(sw, '缺少自动降档开关');
  assert.equal(sw.props.role, 'switch');
  assert.equal(sw.props['aria-label'], 'fieldAutoReasoningDowngrade');
  assert.equal(sw.props['aria-checked'], 'true', '默认开');
  assert.equal(findAll((node) => node.props?.htmlFor === 'ace-field-autoReasoningDowngrade').length, 1);
});

test('R50｜下拉展开列出后端声明的三个档位，选中一档即 POST { reflectReasoningEffort }', async () => {
  const host = makeHost();
  await mount(host);
  assert.equal(effortTrigger().props.disabled, false);

  await click(effortTrigger());
  const items = panelItems();
  // 列表项只算声明的档位（「不指定」是底部清空项，按 ace-pick-clear 排除）。
  assert.equal(items.length, 3, '应当列出三个档位');
  assert.deepEqual(items.map((n) => textOf(n).slice(0, 1)), ['高', '中', '关']);

  const high = items.find((item) => textOf(item).includes('高'));
  await click(high);
  assert.deepEqual(effortPosts(host).map((call) => call.body), [{ reflectReasoningEffort: 'high' }]);
  assert.equal(host.settings.reflectReasoningEffort, 'high');
  // 触发器显示档位名，不是 id。
  assert.match(textOf(effortTrigger()), /高/);
});

test('R50｜选「不指定」提交空串，触发器回到占位文案', async () => {
  const host = makeHost({ reflectReasoningEffort: 'medium' });
  await mount(host);
  assert.match(textOf(effortTrigger()), /中/, '已选档位显示 name');

  await click(effortTrigger());
  const clearItem = findAll(hasClass('ace-pick-clear'))[0];
  assert.ok(clearItem, '缺少「不指定」清空项');
  assert.match(textOf(clearItem), /pickEffortClear/);
  await click(clearItem);

  assert.deepEqual(effortPosts(host).map((call) => call.body), [{ reflectReasoningEffort: '' }]);
  assert.equal(host.settings.reflectReasoningEffort, '');
  assert.match(textOf(effortTrigger()), /pickEffortPlaceholder/);
});

test('R50｜自动降档开关点击提交 { autoReasoningDowngrade: false }，再点回落 true', async () => {
  const host = makeHost();
  await mount(host);

  await click(switchById('ace-field-autoReasoningDowngrade'));
  assert.deepEqual(effortPosts(host).map((call) => call.body), [{ autoReasoningDowngrade: false }]);
  assert.equal(host.settings.autoReasoningDowngrade, false);
  assert.equal(switchById('ace-field-autoReasoningDowngrade').props['aria-checked'], 'false');

  await click(switchById('ace-field-autoReasoningDowngrade'));
  assert.deepEqual(effortPosts(host).map((call) => call.body), [
    { autoReasoningDowngrade: false }, { autoReasoningDowngrade: true },
  ]);
  assert.equal(switchById('ace-field-autoReasoningDowngrade').props['aria-checked'], 'true');
});

test('R50｜/efforts 打不通（ok:false 与网络抛错）时页面照常渲染、下拉禁用并说明，绝不抛错', async () => {
  for (const shape of ['http', 'payload', 'throw']) {
    const host = makeHost({}, {
      efforts: async () => {
        if (shape === 'http') return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
        if (shape === 'payload') return { ok: true, status: 200, json: async () => ({ ok: false, error: 'boom' }) };
        throw new Error('network down');
      },
    });
    await mount(host);

    const picker = effortTrigger();
    assert.equal(picker.props.disabled, true, shape + '：档位读不到时下拉必须禁用');
    assert.equal(panelItems().length, 0);
    // 整页其余部分完全不受影响。
    assert.ok(findAll(hasClass('ace-set-input')).length >= 2, shape + '：数值输入框仍在');
    assert.ok(findAll(hasClass('ace-set-btn')).length >= 1, shape + '：恢复默认按钮仍在');
    assert.ok(switchById('ace-field-autoReasoningDowngrade'), shape + '：开关仍在');
    assert.equal(findAll(hasClass('ace-set-warn')).length, 0, shape + '：不该冒出配对警告');
    // 说明行：只显示一行，不额外拉一坨文案。
    assert.match(effortNote(), /effortsFailed/, shape + '：应当说明该模型未声明思考档位');
  }
});

test('R50｜自动模式说明：source=auto 显示「当前会自动使用：<档位名>」，source=none 显示后端 reason', async () => {
  const autoHost = makeHost({}, {
    efforts: {
      ok: true,
      efforts: [{ id: 'minimal', name: '最低' }, { id: 'high', name: '高' }],
      effective: { effort: 'minimal', source: 'auto', reason: '按会话模型降档' },
    },
  });
  await mount(autoHost);
  // 假字典里 effortsAutoNow 的模板是「当前会自动使用：{name}」，所以断言插值结果而不是键名：
  // 键在就说明这条分支走了，档位名在就说明 id → name 的反查真的做了。
  assert.match(effortNote(), /当前会自动使用/, '手选为空时应当说明自动会用哪一档');
  assert.match(effortNote(), /最低/, '档位名要反查出来，不能只显示 id');
  assert.doesNotMatch(effortNote(), /minimal/, '不许把 id 直接甩给用户');

  const noneHost = makeHost({}, {
    efforts: {
      ok: true,
      efforts: [{ id: 'off', name: '关' }],
      effective: { effort: null, source: 'none', reason: '该模型不允许降档' },
    },
  });
  await mount(noneHost);
  assert.match(effortNote(), /该模型不允许降档/, 'source=none 时显示后端 reason');

  // 手动选了档位：触发器已经显示，说明行不再重复同一句。
  const manualHost = makeHost({ reflectReasoningEffort: 'high' });
  await mount(manualHost);
  assert.equal(effortNote(), '', '手选档位时说明行应当留白');
  assert.match(textOf(effortTrigger()), /高/);
});

test('R50｜改选 model 后按新 provider/model 重拉 /efforts；旧手选档位不在新列表里则清空为「」', async () => {
  const seen = [];
  const host = makeHost({ reflectProvider: 'deepseek', reflectModel: 'deepseek-chat', reflectReasoningEffort: 'high' }, {
    efforts: async (url) => {
      seen.push(url);
      // 第二个模型只声明 off / low —— 没有 high。
      if (url.includes('deepseek-reasoner')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, efforts: [{ id: 'off', name: '关' }, { id: 'low', name: '低' }], effective: { effort: 'off', source: 'auto' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], effective: { effort: 'high', source: 'auto' } }) };
    },
  });
  await mount(host);

  assert.equal(seen.length, 1, '首次进入按已选 provider/model 拉一次');
  assert.equal(seen[0], '/api/dsh-ace/efforts?provider=deepseek&model=deepseek-chat');
  assert.match(textOf(effortTrigger()), /高/);

  // 改选 model：面板里挑 deepseek-reasoner。
  await click(triggers()[1]);
  const reasoner = panelItems().find((item) => textOf(item).includes('deepseek-reasoner'));
  await click(reasoner);
  // 一条链：POST model → adopt → 按新 model 重拉 /efforts → 发现旧档位不合法 → POST 清空。
  await settle();

  assert.equal(seen.length, 2, '改选 model 后必须重新拉一次档位');
  assert.equal(seen[1], '/api/dsh-ace/efforts?provider=deepseek&model=deepseek-reasoner');
  // 旧档位 high 不在新列表里：清空提交，且界面回落到占位。
  assert.deepEqual(effortPosts(host).map((call) => call.body), [
    { reflectModel: 'deepseek-reasoner' },
    { reflectReasoningEffort: '' },
  ]);
  assert.equal(host.settings.reflectReasoningEffort, '');
  assert.match(textOf(effortTrigger()), /pickEffortPlaceholder/);
  assert.match(effortNote(), /effortsStaleCleared/, '清空动作要有一句说明');
});

test('client.js：catalog 取不到时面板显示错误行，其余字段照常可用', async () => {
  const host = makeHost();
  const failing = async (url, init) => {
    if (url === '/api/dsh-ace/catalog') return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return host.fetchStub(url, init);
  };
  const hostWithFailure = { ...host, fetchStub: failing };
  await mount(hostWithFailure);
  await click(triggers()[0]);
  assert.equal(findAll(hasClass('ace-pick-err')).length, 1, '应当显示目录读取失败提示');
  assert.equal(panelItems().length, 0, '失败时不应列出条目');
  // 其余字段照常渲染
  assert.ok(findAll(hasClass('ace-set-input')).length >= 2, '手册路径与容量输入框仍在');
  assert.ok(findAll(hasClass('ace-set-btn')).length >= 1, '恢复默认按钮仍在');
});