// 第 55 轮：注入依据开关 injectRationale 的接线级用例。
// 钉四件事：①默认（不传）注入块不含「依据」；②配置打开后**真实装配路径**的注入块真多出依据行、
// 且依据原文一字不截；③配置层 POST 接受 true/false、非法值被拒并说清口径；④热更新（设置页保存后
// 立即生效，走 live.injectRationale 而不是启动时的 config）。走的是真生产路径：真 import lib/index.js、
// 真调 apply()、真发 agent/inbox/inserted、真跑 agent/pre-step 投递、真打 POST /settings。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-r55-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

const STUBS = {
  '@deepseek-ai/schemastery':
    'function builder(kind) { const b = { type: kind }; b.description = () => b; b.default = (v) => { b.defaultValue = v; return b; }; b.optional = () => b; return b; }' +
    'export default { string: () => builder(\'string\'), boolean: () => builder(\'boolean\'), number: () => builder(\'number\'), object: (fields) => ({ type: \'object\', fields }) };',
  '@deepseek-ai/dsh-tools': 'export function defineTool(options) { return options; }',
  '@deepseek-ai/dsh-llm':
    'export function createUserMessage(input) {' +
    ' return { ...input, role: \'user\', id: \'msg-\' + Math.random().toString(36).slice(2) };' +
    ' }',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: 'data:text/javascript,' + encodeURIComponent(stub), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const plugin = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'index.js')).href);
const { serializePlaybook, withExclusiveLock, writeFileAtomic } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'playbook.js')).href
);
const { selectInjection, estimateTokens } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'inject.js')).href);

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

// 依据行文案（lib/inject.js 的 renderEntry）：「   - 依据：」。
const RATIONALE_MARK = '- 依据：';
const countRationale = (text) => String(text).split(RATIONALE_MARK).length - 1;

const QUALITY = { title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' };
const LONG_RATIONALE = '上一次没备份就改表结构，回滚花了四十分钟，最后靠库里的影子表手工比对才恢复';

function entryBlock({ id, title, condition, action, rationale = '', created, hits = 0 }) {
  return {
    id, title, condition, action, rationale,
    meta: { created, updated: created, hits, lastHit: '' },
    extraLines: [],
  };
}

async function writePlaybookFile(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

function configDefaults() {
  const out = {};
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) out[key] = field.defaultValue;
  }
  return out;
}

// 每个宿主一份独立的 profile 目录：设置文件（dsh-ace.json）是按 profile 落盘的，共用一份会让
// 后一条用例读到前一条 POST 写下的值（R55-6 的热更新用例尤其需要「保存前」的干净状态）。
let profileSeq = 0;
function freshProfileDir() {
  profileSeq += 1;
  return path.join(ROOT, 'profile-' + profileSeq);
}

function makeHost({ playbookPath, config = {}, profileDir = freshProfileDir() }) {
  const record = { tools: [], sections: [], handlers: [], commands: [], injected: [], logs: { info: [], warn: [], error: [] } };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: profileDir, home: HOME_DIR } : undefined),
    llm: { async *stream() { yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [], notes: 'r55' }) }; } },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, {
    ...configDefaults(),
    playbookPath,
    autoReviewInbox: false,
    ...config,
  });
  return { ctx, record };
}

function makeAgent() {
  return {
    notices: [],
    session: {
      header: { origin: 'cli' },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '把 lib/foo.js 的导出改成 bar' }] },
      ],
    },
    options: { provider: 'p', model: 'm' },
    phase: 'idle',
    async runMaintenance(job) { return await job(new AbortController().signal); },
    async whenIdle() {},
    followup: (message) => { this.notices.push(message); },
  };
}

function emit(host, event, ...args) {
  const hits = host.record.handlers.filter((h) => h.event === event);
  assert.ok(hits.length > 0, '插件没有注册事件 ' + event);
  for (const h of hits) h.handler(...args);
}

async function runPreStep(host, agent, { messages = [], step = 1 } = {}) {
  const hits = host.record.handlers.filter((h) => h.event === 'agent/pre-step');
  const base = { kind: 'enter', messages, startsRequestSeries: true };
  let decision = base;
  for (const h of hits) decision = await h.handler({ agent, messages, turn: 1, step, signal: { throwIfAborted() {} } }, async () => base);
  return decision;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function injectFor(host, agent, text, tries = 40) {
  emit(host, 'agent/inbox/inserted', {
    agent,
    message: { role: 'user', id: 'msg-' + Math.random().toString(36).slice(2), content: [{ type: 'text', text }] },
  });
  for (let i = 1; i <= tries; i += 1) {
    const decision = await runPreStep(host, agent, { step: i });
    const appended = decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace');
    if (appended.length) return appended[appended.length - 1].content.map((b) => b.text || '').join('\n');
    await sleep(10);
  }
  assert.fail('agent/pre-step 没有把注入追加进历史（' + text + '）');
}

/** 真把设置路由注册起来，返回一个能真打 HTTP 的 handler（同 tests/config.test.mjs 的口径）。 */
function settingsRoute(host) {
  const entry = host.record.injected.find((x) => Array.isArray(x.deps) && x.deps.includes('webServer'))
    ?? host.record.injected[0];
  const routes = [];
  entry.callback({ webServer: { register: (r) => routes.push(r) }, effect: (fn) => fn(), logger: host.ctx.logger });
  assert.ok(routes[0] && routes[0].handler, '插件没有注册设置路由');
  return routes[0].handler;
}

async function callRoute(handler, method, urlPath, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    url: urlPath,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    on(event, callback) {
      if (event === 'data' && text) callback(Buffer.from(text, 'utf8'));
      if (event === 'end') callback();
      return req;
    },
    destroy: () => {},
  };
  const res = {
    statusCode: 0, headers: null, body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(payload) { this.body = payload ?? ''; return this; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// 只读用例：同一批候选在两种开关下的纯函数口径，供后面两条接线级用例做对照。
// 关掉两个门槛（0 = 关）是既有惯例：单条小手册会被门槛整片挡空，本组钉的不是门槛。
const GATE_OFF = { injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0 };

function seedEntries() {
  return [entryBlock({
    id: 'ace-001',
    ...QUALITY,
    rationale: LONG_RATIONALE,
    created: '2020-01-01',
  })];
}

test('R55-1｜Config 默认关：injectRationale 是 boolean，默认 false，且不进 bounds.defaults（与其它布尔键同口径）', async () => {
  const field = plugin.Config.fields.injectRationale;
  assert.ok(field, 'Config 必须有 injectRationale 字段');
  assert.equal(field.type, 'boolean', 'injectRationale 必须是布尔字段');
  assert.equal(field.defaultValue, false, '默认必须是 false（省 token 的那一档）');
  assert.ok(String(field.description).length > 0, '字段必须有一句中文说明');

  const file = path.join(ROOT, 'schema', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const host = makeHost({ playbookPath: file, config: GATE_OFF });
  const body = (await callRoute(settingsRoute(host), 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(body.value.injectRationale, false, 'GET 的生效值默认 false');
  assert.equal(body.bounds.defaults.injectRationale, undefined, '布尔键不进 bounds.defaults（autoReflect 也不在）');
});

test('R55-2｜接线级默认关：真实装配路径的注入块里「依据」出现 0 次，条目本身照常注入', async () => {
  const file = path.join(ROOT, 'off', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const host = makeHost({ playbookPath: file, config: { ...GATE_OFF, injectTokenBudget: 4000 } });
  const text = await injectFor(host, makeAgent(), QUALITY.title);

  assert.ok(text.includes('[ace-001]'), '条目必须照常注入：' + text);
  assert.equal(countRationale(text), 0, '默认配置下注入块里不许出现「依据」行：' + text);
  assert.equal(text.includes(RATIONALE_MARK), false);
  assert.equal(text.includes(LONG_RATIONALE), false, '默认关时依据正文一个字都不许出现在注入块里');
  assert.ok(text.includes('怎么做：' + QUALITY.action), '做法照常注入');
});

test('R55-3｜接线级打开：injectRationale=true 时同一条目的注入块真的多出依据行，且依据原文一字不截', async () => {
  const file = path.join(ROOT, 'on', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const off = makeHost({ playbookPath: file, config: { ...GATE_OFF, injectTokenBudget: 4000 } });
  const on = makeHost({ playbookPath: file, config: { ...GATE_OFF, injectTokenBudget: 4000, injectRationale: true } });

  const textOff = await injectFor(off, makeAgent(), QUALITY.title);
  const textOn = await injectFor(on, makeAgent(), QUALITY.title);

  assert.equal(countRationale(textOff), 0);
  assert.equal(countRationale(textOn), 1, '打开开关后必须恰好多一行依据：' + textOn);
  assert.ok(textOn.includes('   ' + RATIONALE_MARK + LONG_RATIONALE), '依据行必须带完整原文（不许截断）：' + textOn);
  assert.ok(textOn.includes('[ace-001]') && textOn.includes('怎么做：' + QUALITY.action), '打开依据不许动其余三行');

  // 同一批候选的纯函数口径复算：token 差就是依据行本身的成本（供报告里的数字对照）。
  const entries = seedEntries();
  const offPick = selectInjection(entries, QUALITY.title, { ...GATE_OFF, tokenBudget: 4000, maxEntries: 5 });
  const onPick = selectInjection(entries, QUALITY.title, { ...GATE_OFF, tokenBudget: 4000, maxEntries: 5, withRationale: true });
  assert.equal(offPick.count, 1);
  assert.equal(onPick.count, 1);
  assert.equal(countRationale(offPick.text), 0);
  assert.equal(countRationale(onPick.text), 1);
  assert.ok(estimateTokens(onPick.text) > estimateTokens(offPick.text), '带依据必然更费 token');
  assert.equal(estimateTokens(textOff), offPick.tokens, 'HTTP 面看到的文本必须与纯函数口径一致');
  assert.equal(estimateTokens(textOn), onPick.tokens);
});

test('R55-4｜配置层：POST injectRationale true/false 被接受且读回一致并真落盘', async () => {
  const file = path.join(ROOT, 'cfg', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const host = makeHost({ playbookPath: file, config: GATE_OFF });
  const route = settingsRoute(host);

  let res = await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: true });
  assert.equal(res.status, 200, 'true 必须被接受');
  assert.equal(res.body.value.injectRationale, true);
  assert.equal(res.body.stored.injectRationale, true);

  const RAW = JSON.parse(fs.readFileSync(res.body.file, 'utf8'));
  assert.equal(RAW.injectRationale, true, '必须真落盘到设置文件');

  let again = (await callRoute(route, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(again.value.injectRationale, true, '再读一次仍是 true');

  res = await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: false });
  assert.equal(res.status, 200);
  again = (await callRoute(route, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(again.value.injectRationale, false, 'false 同样被接受并读回');
  assert.equal(JSON.parse(fs.readFileSync(again.file, 'utf8')).injectRationale, false);
});

test('R55-5｜配置层：非法值（yes / 1 / null）一律 400 且文案说清「必须是 true 或 false」，不动当前值', async () => {
  const file = path.join(ROOT, 'bad', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const host = makeHost({ playbookPath: file, config: GATE_OFF });
  const route = settingsRoute(host);

  await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: true });
  for (const bad of ['yes', 1, null, 'TRUE!']) {
    const before = (await callRoute(route, 'GET', '/api/dsh-ace/settings')).body.value.injectRationale;
    const res = await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: bad });
    assert.equal(res.status, 400, JSON.stringify(bad) + ' 必须被拦下');
    assert.equal(res.body.error, 'injectRationale 必须是 true 或 false', '报错文案要照相邻布尔键的口径：' + res.body.error);
    assert.equal((await callRoute(route, 'GET', '/api/dsh-ace/settings')).body.value.injectRationale, before, '被拦下的写入不许改到当前值');
  }
});

test('R55-6｜热更新：设置页保存后立即生效（下一批注入就带依据，无需重启）', async () => {
  const file = path.join(ROOT, 'hot', 'playbook.md');
  await writePlaybookFile(file, seedEntries());
  const host = makeHost({ playbookPath: file, config: { ...GATE_OFF, injectTokenBudget: 4000 } });
  const route = settingsRoute(host);

  const before = await injectFor(host, makeAgent(), QUALITY.title);
  assert.equal(countRationale(before), 0, '保存前默认不带依据');

  const saved = await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: true });
  assert.equal(saved.status, 200);

  // 注入去重是按 agent 记账的（B3），换代 agent 才能拿到同一批条目。
  const after = await injectFor(host, makeAgent(), QUALITY.title);
  assert.ok(after.includes('[ace-001]'), '热更新后条目照常注入：' + after);
  assert.equal(countRationale(after), 1, '保存后必须立即带依据（走 live.injectRationale 而不是启动时的 config）：' + after);

  // 关回去也要立刻生效。
  const off = await callRoute(route, 'POST', '/api/dsh-ace/settings', { injectRationale: false });
  assert.equal(off.status, 200);
  const back = await injectFor(host, makeAgent(), QUALITY.title);
  assert.equal(countRationale(back), 0, '关掉后同一宿主的下一条注入必须立刻不带依据：' + back);
});
