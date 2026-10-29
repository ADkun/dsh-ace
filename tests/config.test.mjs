// 三个新配置项（第 36 轮）的接线用例：真 import lib/index.js、真调 apply()、真打 POST/GET 路由，
// 验的是「设置页能调、非法值被拦、0 是有效值」这些只有走完整条 HTTP 契约才对得上的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-config-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

const STUBS = {
  // 与 tests/wiring.test.mjs 同款：object(fields) 必须把 fields 留下来（Config.fields 是设置页的唯一边界出处）。
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

function makeHost() {
  const record = { tools: [], sections: [], handlers: [], commands: [], injected: [], logs: { info: [], warn: [], error: [] } };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
    llm: { async *stream() { yield { type: 'text-delta', index: 0, text: '{}' }; } },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  const config = { playbookPath: path.join(ROOT, 'config-playbook.md') };
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) config[key] = field.defaultValue;
  }
  plugin.apply(ctx, config);
  return { ctx, record };
}

/** 真打一发同源 HTTP：GET 无体，POST 带 JSON 体（readJson 走 data/end 两个事件）。
 *  写设置只认 POST —— lib/index.js 的 `if (method !== 'POST') return send(405, …)` 是生产契约。 */
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
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(payload) { this.body = payload ?? ''; return this; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

const host = makeHost();
const { deps, callback } = host.record.injected[0];
const routes = [];
callback({ webServer: { register: (route) => routes.push(route) }, effect: (fn) => fn(), logger: host.ctx.logger });
const route = routes[0].handler;
const get = () => callRoute(route, 'GET', '/api/dsh-ace/settings');
const put = (body) => callRoute(route, 'POST', '/api/dsh-ace/settings', body);

const THREE = ['evictProtectDays', 'injectTokenBudget', 'injectMaxEntries'];
// 第 50 轮加了两个注入门槛项（允许小数）：4.0 / 0.6 是实测档位，取整就改了方案参数。
const FIVE = [...THREE, 'injectMinScoreIdfRatio', 'injectMinRelativeToTop'];
const DEFAULTS = { evictProtectDays: 14, injectTokenBudget: 500, injectMaxEntries: 5, injectMinScoreIdfRatio: 4, injectMinRelativeToTop: 0.6 };
const RANGES = { evictProtectDays: [0, 365], injectTokenBudget: [100, 8000], injectMaxEntries: [1, 20], injectMinScoreIdfRatio: [0, 20], injectMinRelativeToTop: [0, 1] };

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

test('配置①：Config 声明了五个可调字段（共 16 个），默认值 14 / 500 / 5 / 4 / 0.6', () => {
  const keys = Object.keys(plugin.Config.fields);
  // 第 50 轮：加了 reflectReasoningEffort / autoReasoningDowngrade 两个思考档位键 → 16。
  assert.equal(keys.length, 16, 'Config 必须是 16 个字段：' + keys.join(','));
  for (const key of FIVE) assert.equal(keys.includes(key), true, '缺字段 ' + key);
  for (const key of FIVE) {
    assert.equal(plugin.Config.fields[key].defaultValue, DEFAULTS[key], key + ' 的默认值不对');
  }
});

test('配置①：GET 返回五个键的 value / bounds / defaults（设置页的唯一数字出处）', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  for (const key of FIVE) {
    assert.equal(res.body.value[key], DEFAULTS[key], 'value.' + key);
    assert.equal(res.body.configured[key], DEFAULTS[key], 'configured.' + key);
    assert.deepEqual(res.body.bounds[key], RANGES[key], 'bounds.' + key);
    assert.equal(res.body.bounds.defaults[key], DEFAULTS[key], 'bounds.defaults.' + key);
  }
  assert.deepEqual(res.body.bounds.maxEntries, [1, 1000], '老键的 bounds 不许被动过');
  assert.deepEqual(res.body.bounds.autoRecapThreshold, [0, 1000]);
  assert.deepEqual(res.body.bounds.autoRecapCooldownTurns, [0, 1000]);
});

test('配置②：PUT 三个键各写一次，value 与 stored 都跟着变（真落盘）', async () => {
  let res = await put({ evictProtectDays: 30 });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.evictProtectDays, 30);
  assert.equal(res.body.stored.evictProtectDays, 30);

  res = await put({ injectTokenBudget: 1500 });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.injectTokenBudget, 1500);
  assert.equal(res.body.value.evictProtectDays, 30, '前面写的键不许被这一发打回默认');

  res = await put({ injectMaxEntries: 8 });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.injectMaxEntries, 8);
  assert.equal(res.body.value.injectTokenBudget, 1500);

  // 两个门槛项是小数：4.5 / 0.7 必须原样落盘，绝不被取整（取整就改了方案参数）。
  res = await put({ injectMinScoreIdfRatio: 4.5 });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.injectMinScoreIdfRatio, 4.5, '小数不许被取整');

  res = await put({ injectMinRelativeToTop: 0.7 });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.injectMinRelativeToTop, 0.7, '小数不许被取整');
  assert.equal(res.body.value.injectMinScoreIdfRatio, 4.5, '前面写的键不许被这一发打回默认');

  // 重新 GET：值来自 stored（重启后也还在）。
  const again = await get();
  assert.equal(again.body.value.evictProtectDays, 30);
  assert.equal(again.body.value.injectTokenBudget, 1500);
  assert.equal(again.body.value.injectMaxEntries, 8);
  assert.ok(fs.existsSync(again.body.file), '设置文件必须落在磁盘上：' + again.body.file);
  const RAW = JSON.parse(fs.readFileSync(again.body.file, 'utf8'));
  assert.equal(RAW.evictProtectDays, 30, 'stored 的 JSON 里必须有新键');
  assert.equal(RAW.injectTokenBudget, 1500);
  assert.equal(RAW.injectMaxEntries, 8);
  assert.equal(RAW.injectMinScoreIdfRatio, 4.5, '小数门槛同样要落盘');
  assert.equal(RAW.injectMinRelativeToTop, 0.7);
});

test('配置③（0 是有效值）：evictProtectDays=0 必须被原样保存，绝不被 || 14 吞掉', async () => {
  let res = await put({ evictProtectDays: 0 });
  assert.equal(res.status, 200, '0 是合法值（= 不保护新条目）');
  assert.equal(res.body.value.evictProtectDays, 0, '0 不许被当成「没填」回落成 14');
  assert.equal(res.body.stored.evictProtectDays, 0);
  assert.equal(JSON.parse(fs.readFileSync(res.body.file, 'utf8')).evictProtectDays, 0, '落盘的也必须是 0');

  res = await get();
  assert.equal(res.body.value.evictProtectDays, 0, '再读一次仍是 0');

  res = await put({ evictProtectDays: '0' });
  assert.equal(res.status, 200);
  assert.equal(res.body.value.evictProtectDays, 0, '字符串 \'0\' 也收敛成 0');
});

test('配置③：越界值一律 400，且报错文案说清范围（不许静默截断）', async () => {
  const cases = [
    ['evictProtectDays', -1, /0–365/],
    ['evictProtectDays', 366, /0–365/],
    ['evictProtectDays', 1.5, /0–365/],
    ['injectTokenBudget', 99, /100–8000/],
    ['injectTokenBudget', 8001, /100–8000/],
    ['injectMaxEntries', 0, /1–20/],
    ['injectMaxEntries', 21, /1–20/],
    ['injectMaxEntries', '很多', /1–20/],
    ['injectMinScoreIdfRatio', -1, /0–20/],
    ['injectMinScoreIdfRatio', 21, /0–20/],
    ['injectMinScoreIdfRatio', '很大', /0–20/],
    ['injectMinRelativeToTop', -0.1, /0–1/],
    ['injectMinRelativeToTop', 1.1, /0–1/],
  ];
  for (const [key, value, pattern] of cases) {
    const before = (await get()).body.value[key];
    const res = await put({ [key]: value });
    assert.equal(res.status, 400, key + '=' + String(value) + ' 必须被拦下');
    assert.equal(pattern.test(res.body.error), true, '报错文案要带范围：' + res.body.error);
    assert.equal((await get()).body.value[key], before, '被拦下的写入不许改到当前值');
  }
});

test('配置③：五个键的边界值恰好放行（min/max 都是合法值）', async () => {
  for (const key of FIVE) {
    const [min, max] = RANGES[key];
    for (const value of [min, max]) {
      const res = await put({ [key]: value });
      assert.equal(res.status, 200, key + '=' + value + ' 是边界内的合法值');
      assert.equal(res.body.value[key], value);
    }
  }
  await put({ evictProtectDays: 14, injectTokenBudget: 900, injectMaxEntries: 5, injectMinScoreIdfRatio: 4, injectMinRelativeToTop: 0.6 });
});

test('配置③：空 body 400 no settings provided；只带未知键同样 400（不许静默成功）', async () => {
  const empty = await put({});
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'no settings provided');

  const unknown = await put({ 不存在的键: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'no settings provided', '未知键不算「有设置」');
});

test('配置④：非法值被拦时，同一次请求里的合法键也不许落盘（整批原子）', async () => {
  const before = (await get()).body.value;
  const res = await put({ injectMaxEntries: 3, injectTokenBudget: 99999 });
  assert.equal(res.status, 400, '一发请求里只要有非法值就整批拒绝');
  const after = (await get()).body.value;
  assert.equal(after.injectMaxEntries, before.injectMaxEntries, '合法键也不许被写进去');
  assert.equal(after.injectTokenBudget, before.injectTokenBudget);
});

test('配置④：读出坏值时的回落口径 —— 缺省键回落默认值，显式 0 保留', async () => {
  const file = (await get()).body.file;
  // 不导出内部函数（index.js 只导出 name / inject / Config / apply）：直接手改设置文件，
  // 再新 apply 一个宿主把文件重新读一遍 —— 走的就是真实的「读设置文件」口径。
  const remount = () => {
    const fresh = makeHost();
    const mounted = [];
    fresh.record.injected[0].callback({
      webServer: { register: (r) => mounted.push(r) },
      effect: (fn) => fn(),
      logger: fresh.ctx.logger,
    });
    return { handler: mounted[0].handler, warns: fresh.record.logs.warn.join(' / ') };
  };

  // 手改过的设置文件（模拟旧版本 / 手改 JSON）：null 与空白串视为没填 → 默认值兜底；7 是合法值。
  fs.writeFileSync(file, JSON.stringify({ evictProtectDays: null, injectTokenBudget: '  ', injectMaxEntries: 7, injectMinScoreIdfRatio: null, injectMinRelativeToTop: '  ' }), 'utf8');
  let fresh = remount();
  let body = (await callRoute(fresh.handler, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(body.value.evictProtectDays, DEFAULTS.evictProtectDays, 'null 视为没填 → 回落默认 14（绝不许当成「显式 0」）');
  assert.equal(body.value.injectTokenBudget, DEFAULTS.injectTokenBudget, '空白串视为没填 → 回落默认 500');
  assert.equal(body.value.injectMaxEntries, 7, '合法值原样读回');
  assert.equal(body.value.injectMinScoreIdfRatio, DEFAULTS.injectMinScoreIdfRatio, 'null 视为没填 → 回落默认 4');
  assert.equal(body.value.injectMinRelativeToTop, DEFAULTS.injectMinRelativeToTop, '空白串视为没填 → 回落默认 0.6');
  assert.equal(body.stored.evictProtectDays, undefined, '没填的键不许凭空出现在 stored 里');

  // 显式 0 是有效值（= 不保护），读设置文件时也必须原样留下。
  fs.writeFileSync(file, JSON.stringify({ evictProtectDays: 0 }), 'utf8');
  fresh = remount();
  body = (await callRoute(fresh.handler, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(body.value.evictProtectDays, 0, '显式 0 是有效值（= 不保护），不许被 || 14 吞掉');
  assert.equal(body.stored.evictProtectDays, 0);

  // 越界值读入时丢弃 + warn，绝不带着坏值跑。
  fs.writeFileSync(file, JSON.stringify({ evictProtectDays: 999, injectTokenBudget: -1, injectMaxEntries: 0, injectMinScoreIdfRatio: 25, injectMinRelativeToTop: 2 }), 'utf8');
  fresh = remount();
  body = (await callRoute(fresh.handler, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(body.value.evictProtectDays, DEFAULTS.evictProtectDays);
  assert.equal(body.value.injectTokenBudget, DEFAULTS.injectTokenBudget);
  assert.equal(body.value.injectMaxEntries, DEFAULTS.injectMaxEntries);
  assert.ok(fresh.warns.includes('evictProtectDays'), '非法值要 warn：' + fresh.warns);
  assert.ok(fresh.warns.includes('injectTokenBudget'));
  assert.ok(fresh.warns.includes('injectMaxEntries'));
  assert.ok(fresh.warns.includes('injectMinScoreIdfRatio'), '小数门槛的越界值同样要 warn：' + fresh.warns);
  assert.ok(fresh.warns.includes('injectMinRelativeToTop'));
});
