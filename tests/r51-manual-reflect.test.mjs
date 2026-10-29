// 第 51 轮（R51）：三个缺陷的守护用例。
//
//   D1 —— 手动 ace_reflect 的「本层单次上限到点」必须报「ace: LLM 调用超时」（改前被误报成
//        「调用方取消」，lib/reflect.js:17-21 的 isTimeoutError 认不出，超时豁免失效）；
//        调用方自己取消仍必须报「被取消」、且**不**算超时（豁免只给真超时）。
//   D2 —— 手动填了非法档位名（如 'HIGH!'）时判定层必须落一条带原值的中文 warn（改前静默丢弃）。
//   D3 —— AGENTS.md 的代码地图必须给 lib/inbox.js / lib/heat.js / lib/injection-flow.js 各留一行。
//
// 行为用例全部走真实生产路径：真 import lib/index.js、真调 apply()、真调 ace_reflect 的 execute。
// 宿主 LLM 是假的（本仓库没有 node_modules，也绝不许真发网络请求）：
//   「本层上限到点」= 把单次上限压到 60ms（ACE_ONESHOT_TIMEOUT_MS，先例见 lib/llm.js:54 的注释），
//   假 stream 等 options.signal abort 之后再吐 finish{kind:'aborted'} —— 这正是宿主
//   dsh-llm-pi-ai lib/index.js:1638-1650 在 callerSignal.aborted 时的收尾形状（见 lib/llm.js:143-147）。
//   「调用方取消」= caller 自己 abort，此时合并信号**在流开始前就已中止**（AbortSignal.any 的语义），
//   这一条用「进流那一刻读 options.signal.aborted」钉住，不依赖任何计时。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-r51-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
fs.mkdirSync(HOME_DIR, { recursive: true });
// 红线 20 末段：凡触达 dumpRaw 的测试都必须把 DSH_HOME 指到临时目录。
process.env.DSH_HOME = HOME_DIR;
// 本层单次上限压到 60ms：D1a 的假 stream 要等它到点（生产路径里 cap 到点后宿主给的是 aborted finish）。
process.env.ACE_ONESHOT_TIMEOUT_MS = '60';

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
const reasoning = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'reasoning.js')).href);
const reflect = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'reflect.js')).href);

function configDefaults() {
  const out = {};
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) out[key] = field.defaultValue;
  }
  return out;
}

/** 假 agent：只实现 ace_reflect 真正读到的成员（resolveRoute 读 session.requestHeader）。 */
function makeAgent({ provider = 'r51-provider', model = 'r51-model' } = {}) {
  return {
    session: {
      requestHeader: () => ({ config: { provider, model } }),
      deriveMessages: () => [],
    },
    options: { provider, model },
    async runMaintenance(job) { return await job(new AbortController().signal); },
    async whenIdle() {},
    followup: () => {},
  };
}

/** 造一个假宿主：playbookPath 用临时目录里的绝对路径（不碰真实手册），LLM 流由用例给。 */
function makeHost({ playbookFile, stream }) {
  const record = { tools: [], commands: [], sections: [], handlers: [], injected: [], llmCalls: [], logs: { info: [], warn: [], error: [] } };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const llm = {
    stream(options) { record.llmCalls.push(options); return stream(options); },
  };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: path.join(ROOT, 'profile'), home: HOME_DIR } : undefined),
    llm,
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, { ...configDefaults(), playbookPath: playbookFile, autoReviewInbox: false });
  return { ctx, record, agent: makeAgent() };
}

function reflectTool(record) {
  const tool = record.tools.find((t) => t.name === 'ace_reflect');
  assert.ok(tool, '插件没有注册 ace_reflect');
  return tool;
}

/** 等到信号中止（上限到点）；兜底 500ms 自行放行，绝不挂死用例。 */
function waitForAbort(signal) {
  if (!signal || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(done, 500);
    signal.addEventListener('abort', done, { once: true });
  });
}

const ABORTED_FINISH = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'pi-ai stream aborted', code: 'ABORTED' } } };

test('R51-D1a｜手动 ace_reflect：本层单次上限到点 → 报「ace: LLM 调用超时」且 isTimeoutError 为 true', async () => {
  const caller = new AbortController(); // 调用方**没有**取消：只有本层上限会到点
  const host = makeHost({
    playbookFile: path.join(ROOT, 'd1a.md'),
    stream: async function* (options) {
      yield { type: 'text-delta', index: 0, text: '{"candidates":[' };
      await waitForAbort(options.signal); // 等单次上限把合并信号 abort 掉
      yield ABORTED_FINISH;
    },
  });
  const tool = reflectTool(host.record);
  let err;
  try {
    await tool.execute({ summary: 'R51-D1a 用例：本层上限到点必须报超时' }, { agent: host.agent, signal: caller.signal });
  } catch (e) {
    err = e;
  }
  const sent = host.record.llmCalls[0];
  assert.ok(sent && sent.signal && typeof sent.signal.aborted === 'boolean', '宿主必须收到一个 AbortSignal（本层上限与调用方信号合并后的那个）');
  assert.equal(host.record.llmCalls.length, 1, '一次工具调用只该发一次 LLM 请求（不许重试）');
  assert.ok(err instanceof Error, '本层超时必须以错误上抛：' + err);
  assert.ok(err.message.startsWith(reflect.TIMEOUT_ERROR_PREFIX), 'D1：本层上限到点必须带「ace: LLM 调用超时」前缀（改前是「调用被取消」）：' + (err && err.message));
  assert.equal(reflect.isTimeoutError(err), true, 'D1：超时豁免必须认得出来（改前为 false，豁免失效）：' + (err && err.message));
  assert.ok(err.message.includes('单次上限 60ms'), '文案仍用实际 cap：' + (err && err.message));
  assert.ok(err.message.includes('已收正文'), '文案仍带现场（已收正文/耗时/路由）：' + (err && err.message));
  assert.ok(err.message.includes('r51-provider/r51-model'), '文案仍带路由：' + (err && err.message));
});

test('R51-D1b｜手动 ace_reflect：调用方 signal 已中止 → 报「ace: LLM 调用被取消」且 isTimeoutError 为 false', async () => {
  const caller = new AbortController();
  caller.abort();
  const seen = {};
  const host = makeHost({
    playbookFile: path.join(ROOT, 'd1b.md'),
    stream: async function* (options) {
      // 进流那一刻的真相：调用方已中止时，合并信号**必须**已经中止（AbortSignal.any 的语义）。
      // 改前不透传 exec.signal，这里拿到的是「只有本地超时」的信号，必然是 false。
      seen.abortedAtEntry = options.signal ? options.signal.aborted : 'no-signal';
      yield { type: 'text-delta', index: 0, text: '{"candidates":[' };
      yield ABORTED_FINISH;
    },
  });
  const tool = reflectTool(host.record);
  let err;
  try {
    await tool.execute({ summary: 'R51-D1b 用例：调用方取消不算超时' }, { agent: host.agent, signal: caller.signal });
  } catch (e) {
    err = e;
  }
  assert.equal(seen.abortedAtEntry, true, 'D1：调用方已中止必须原样透传给宿主（改前不透传 ⇒ 这里是 false）');
  assert.ok(err instanceof Error, '调用方取消必须以错误上抛：' + err);
  assert.equal(reflect.isTimeoutError(err), false, 'D1：调用方取消绝不许被当成超时（否则整份复盘被外部取消时按「按已提炼候选收尾」假成功）：' + (err && err.message));
  assert.ok(err.message.startsWith('ace: LLM 调用被取消'), 'D1：必须是「被取消」文案：' + (err && err.message));
  assert.ok(err.message.includes('调用方信号已中止'), '文案要点明是调用方信号：' + (err && err.message));
});

test('R51-D2｜planReasoningEffort 手动档位非法（HIGH!）：落一条带原值的中文 warn，auto 照常回落最低档', () => {
  const warns = [];
  const plan = reasoning.planReasoningEffort({
    manual: 'HIGH!',
    auto: true,
    info: { ok: true, provider: 'p', model: 'm', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] },
    warn: (text) => warns.push(String(text)),
  });
  assert.equal(warns.length, 1, 'D2：非法档位名必须落一条 warn（改前是 0 条、静默丢弃）：' + JSON.stringify(warns));
  assert.ok(warns[0].startsWith('dsh-ace: '), '文案风格与 lib/reasoning.js:197 一致：' + warns[0]);
  assert.ok(warns[0].includes('HIGH!'), 'D2：必须带上用户填的原值（便于排查）：' + warns[0]);
  assert.ok(warns[0].includes(reasoning.REASONING_EFFORT_IDS.join('/')), '合法值清单必须取自 REASONING_EFFORT_IDS（不许手写第二份）：' + warns[0]);
  assert.ok(warns[0].includes('已丢弃'), '文案要点明已丢弃：' + warns[0]);
  assert.equal(plan.effort, 'low', 'D2：非法手动值被丢弃后，auto 照常回落到最低档（efforts[0]）：' + JSON.stringify(plan));
  assert.equal(plan.source, 'auto', 'D2：档位来源必须是 auto：' + JSON.stringify(plan));
  assert.equal(plan.reason, 'ace: 配置的思考档位不在合法档位集里', 'reason 字段的既有含义一个字不许变：' + JSON.stringify(plan));
});

test('R51-D3｜AGENTS.md 代码地图给 lib/inbox.js、lib/heat.js、lib/injection-flow.js 各留一行', async () => {
  const text = await fs.promises.readFile(path.join(HERE, '..', 'AGENTS.md'), 'utf8');
  const TICK = String.fromCharCode(96);
  const rows = text.split(/\r?\n/);
  for (const name of ['lib/inbox.js', 'lib/heat.js', 'lib/injection-flow.js']) {
    const needle = '| ' + TICK + name + TICK + ' |';
    assert.ok(rows.some((line) => line.startsWith(needle)), 'D3：代码地图缺 ' + name + ' 的独立一行（缺行即零次出现）：' + name);
  }
});

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});
