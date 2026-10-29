// 第 50 轮（R50）：思考档位判定的用例。
//
// 钉的是四件事：
//   1. 「这一次调用该发哪一档」的判定顺序（手动值优先 / 自动降到最低档 / 四种不干预情形）；
//   2. 判定结果**真的**进了发给宿主的 GenerateOptions.reasoningEffort（假 provider 首行记 options）；
//   3. 某一轮超时 → 降到最低档**只重试一次**，重试仍失败也不假成功；
//   4. GET /api/dsh-ace/efforts 的返回体形状（前端 client.js 已按这个形状写，改名就接不上）。
//
// 行为用例全部走真实生产路径：真 import lib/index.js、真调 apply()、真跑 /ace → recapQueue →
// executeRecap → runRecapPipeline → reflectRounds。宿主的档位查询（llm.resolveModelInfo）是注入的
// —— 本仓库没有 node_modules，插件也不 import 宿主包（红线 5/6），所以只能由测试喂一个假的进去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-r50-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
fs.mkdirSync(HOME_DIR, { recursive: true });
// 红线 20 末段：凡触达 dumpRaw 的测试都必须把 DSH_HOME 指到临时目录（复盘失败会写 <DSH_HOME>/ace/debug/raw.jsonl）。
process.env.DSH_HOME = HOME_DIR;

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
const { parsePlaybook } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'playbook.js')).href);

const EFFORTS = {
  // 实测参考（DESIGN.md「自动降档」一节里记的那四条，这里取其中三条当夹具）：
  //   auto/deepseek-v4.1-flash → [low, high, xhigh]
  //   auto/glm-5.3-flash       → [off, low, medium, high, xhigh]
  //   auto/minimax-m3.1-flash:free → [low, medium, high, xhigh, max]
  'auto/glm-5.3-flash': ['off', 'low', 'medium', 'high', 'xhigh'],
  'auto/deepseek-v4.1-flash': ['low', 'high', 'xhigh'],
  'auto/minimax-m3.1-flash:free': ['low', 'medium', 'high', 'xhigh', 'max'],
  // group/never-stuck（当前会话模型）实测只声明 high —— 「只有一档 ⇒ 不干预」的夹具。
  'group/never-stuck': ['high'],
  // 走 /efforts 路由用的那个。
  'auto/glm-5.3-flash2': ['off', 'low', 'medium', 'high', 'xhigh'],
};

/** 把 dismiss 列表转成宿主 LlmResolvedModelInfo.reasoning 的形状。
 *  efforts 的**顺序**就是宿主声明的强弱顺序（由弱到强，efforts[0] = 最低档），不许在测试里重排。 */
function modelInfoOf(ids, defaultEffort) {
  return {
    reasoning: {
      efforts: ids.map((id) => ({ id, name: '档位' + id })),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    },
  };
}

/** 假的 llm.resolveModelInfo：key 是 'provider/model'，值是要返回的信息（或要抛的错）。
 *  没登记的 key 一律抛错 —— 走的就是「宿主认不出这个模型」的真实路径。 */
function mockModels(table) {
  return async ({ provider, model }) => {
    const key = provider + '/' + model;
    if (!(key in table)) throw new Error('unknown model ' + key);
    const entry = table[key];
    if (entry instanceof Error) throw entry;
    return { provider, model, ...entry };
  };
}

function configDefaults() {
  const out = {};
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) out[key] = field.defaultValue;
  }
  return out;
}

/** script(index) → 第 index 次 LLM 调用的候选批次；**抛错**就表示这次调用失败（超时/普通错误）。
 *  models：undefined = 宿主没有 resolveModelInfo（能力缺失）；函数 = 假的档位查询。 */
function makeHost({ playbookPath, script = () => [], models, config = {}, profileDir }) {
  const record = { tools: [], sections: [], handlers: [], commands: [], injected: [], llmCalls: [], logs: { info: [], warn: [], error: [] } };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); };
  const dir = profileDir ?? fs.mkdtempSync(path.join(ROOT, 'profile-'));
  fs.mkdirSync(dir, { recursive: true });
  const llm = {
    async *stream(options) {
      const index = record.llmCalls.length;
      record.llmCalls.push(options); // 首行就记下来：断言的是宿主真正收到的 options
      const batch = script(index);
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: batch, notes: 'r50' }) };
    },
  };
  if (models !== undefined) {
    llm.resolveModelInfo = async (provider, model, signal) => models({ provider, model, signal });
  }
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir, home: HOME_DIR } : undefined),
    llm,
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, { ...configDefaults(), playbookPath, autoReviewInbox: false, ...config });
  return { ctx, record, profileDir: dir };
}

function makeAgent({ provider = 'p', model = 'm' } = {}) {
  const notices = [];
  return {
    notices,
    session: {
      header: { origin: 'cli' },
      requestHeader: () => ({ config: { provider, model } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '把 lib/foo.js 的导出改成 bar' }] },
        { role: 'assistant', content: [{ type: 'text', text: '先读一遍再改。' }, { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '写入成功' }] },
      ],
    },
    options: { provider, model },
    phase: 'idle',
    async runMaintenance(job) { return await job(new AbortController().signal); },
    async whenIdle() {},
    followup: (message) => notices.push(message),
  };
}

async function runAceCommand(host, agent) {
  const command = host.record.commands.find((c) => c.name === 'ace');
  assert.ok(command, '插件没有注册 /ace 命令');
  return await command.handler({ agent, rawInput: '' });
}

/** 真跑一遍 pre-step（这一步同时会记下「最近一次观察到的会话路由」，给 /efforts 无参时兜底）。 */
async function emitPreStep(host, agent) {
  const hits = host.record.handlers.filter((h) => h.event === 'agent/pre-step');
  assert.ok(hits.length > 0, '插件没有注册 agent/pre-step');
  const base = { kind: 'enter', messages: [], startsRequestSeries: true };
  for (const h of hits) await h.handler({ agent, messages: [], turn: 1, step: 1, signal: { throwIfAborted() {} } }, async () => base);
}

function mountApi(host) {
  const routes = [];
  host.record.injected[0].callback({
    webServer: { register: (route) => routes.push(route) },
    effect: (fn) => fn(),
    logger: host.ctx.logger,
  });
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
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    end(payload) { this.body = payload ?? ''; return this; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body === '' ? '' : JSON.parse(res.body) };
}

const CANDIDATE = { title: '编辑前先读目标文件', condition: '要改一个还不熟悉的文件时', action: '先用 read 通读再动手改', rationale: '避免改错调用点' };

const warnsOf = (host) => host.record.logs.warn.join(' / ');

function playbookEntries(file) {
  if (!fs.existsSync(file)) return [];
  return parsePlaybook(fs.readFileSync(file, 'utf8')).entries;
}

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});

// —— 附加（纯逻辑）：档位名校验 / 档位解码 / 最低档判定 ——
// 这层是 B 与 C 共用的地基，四个「不干预」情形与「只有一档」都由它判，先钉死语义。
test('R50-0｜纯逻辑：档位名校验 / 宿主档位解码 / 最低档判定（不干预的三种情形都返回 null）', () => {
  assert.deepEqual(reasoning.REASONING_EFFORT_IDS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // 空串是**合法**值（= 未手动指定），不是非法值 —— 读盘归一与 POST 都靠这个区分。
  assert.equal(reasoning.validReasoningEffort(''), '');
  assert.equal(reasoning.validReasoningEffort('   '), '');
  assert.equal(reasoning.validReasoningEffort(' off '), 'off');
  assert.equal(reasoning.validReasoningEffort('HIGH'), undefined, '大写不是合法档位名');
  assert.equal(reasoning.validReasoningEffort('ultra'), undefined);
  assert.equal(reasoning.validReasoningEffort(7), undefined);

  const decoded = reasoning.decodeModelEfforts(modelInfoOf(['off', 'low', 'high'], 'high'), 'auto', 'glm-5.3-flash');
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.efforts.map((e) => e.id), ['off', 'low', 'high']);
  assert.equal(decoded.defaultEffort, 'high');
  assert.equal(decoded.note, null);
  // defaultEffort 不在声明集里 → undefined，不回落最强档（回落值会冒充「宿主默认档」出现在 /efforts 报文里）
  assert.equal(reasoning.decodeModelEfforts(modelInfoOf(['low', 'high'], 'max'), 'p', 'm').defaultEffort, undefined);
  // 宿主**没声明** defaultEffort（只给 efforts）→ 返回对象**自身没有这个键**：缺键 ≠ null。
  // 上游靠这个区分「宿主没说过」（键缺席）与「宿主说过某个值」，组装处就是 lib\reasoning.js:112 的
  // `...(defaultEffort === undefined ? {} : { defaultEffort })`。
  const noDefault = reasoning.decodeModelEfforts(modelInfoOf(['low', 'high']), 'p', 'm');
  assert.equal(noDefault.ok, true, '素材本身是合法模型信息（免得 hasOwnProperty 在失败体上空过）');
  assert.deepEqual(noDefault.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(Object.prototype.hasOwnProperty.call(noDefault, 'defaultEffort'), false, '宿主没声明 defaultEffort 时该键必须整体缺席（缺键 ≠ null）');
  // 三种「不干预」素材
  assert.equal(reasoning.decodeModelEfforts({ reasoning: undefined }, 'p', 'm').note, 'noReasoning');
  assert.equal(reasoning.decodeModelEfforts({ reasoning: { efforts: [{ id: 'bogus' }] } }, 'p', 'm').note, 'noEfforts');
  assert.equal(reasoning.decodeModelEfforts(modelInfoOf(['high']), 'p', 'm').note, 'singleEffort');

  assert.equal(reasoning.lowestEffortOf(reasoning.decodeModelEfforts(modelInfoOf(['off', 'low']), 'p', 'm')), 'off');
  assert.equal(reasoning.lowestEffortOf(reasoning.decodeModelEfforts(modelInfoOf(['high']), 'p', 'm')), null, '只有一档 = 降了等于没改');
  assert.equal(reasoning.lowestEffortOf(reasoning.decodeModelEfforts({ reasoning: undefined }, 'p', 'm')), null);
  assert.equal(reasoning.lowestEffortOf({ ok: false, error: 'x' }), null);
});

// —— 1：默认自动降档（用户要求默认开） ——
test('R50-1｜默认自动降档：模型声明多档 → 发给宿主的 reasoningEffort 等于该模型最低档 efforts[0]', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'auto', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal(host.record.llmCalls.length, 1, '空候选一次就收敛，只该有一次 LLM 调用');
  // 宿主声明的最低档是 off（实测 auto/glm-5.3-flash → [off, low, medium, high, xhigh]）。
  assert.equal(host.record.llmCalls[0].reasoningEffort, 'off', '默认必须自动降到最低档');
});

// —— 2：手动值优先 ——
test('R50-2｜手动档位优先：配置 reflectReasoningEffort=high → 发出去的是 high，不被自动降档覆盖', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'manual', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { reflectReasoningEffort: 'high' },
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal(host.record.llmCalls[0].reasoningEffort, 'high', '手动指定的档位不许被自动降档盖掉');
});

// —— 3：手动值不在声明集 → 丢弃 + warn，回落自动降档 ——
test('R50-3｜手动档位该模型没声明 → 丢弃 + warn，回落自动降档（绝不硬发给宿主）', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'undeclared', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { reflectReasoningEffort: 'max' }, // 这个模型没声明 max
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal(host.record.llmCalls[0].reasoningEffort, 'off', '没声明的档位要丢弃并回落到最低档，不许硬发 max');
  assert.equal(warnsOf(host).includes('max'), true, '丢弃要有日志：' + warnsOf(host));
  assert.equal(warnsOf(host).includes('已丢弃'), true, '日志要说清是丢弃而不是生效：' + warnsOf(host));
});

// —— 4：关掉自动降档且无手动值 → 不发这个字段 ——
test('R50-4｜autoReasoningDowngrade=false 且无手动值 → options 里没有 reasoningEffort 这个键', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'off', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { autoReasoningDowngrade: false },
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal('reasoningEffort' in host.record.llmCalls[0], false, '关掉自动降档后不许再发 reasoningEffort');
  // 字符串 'false' 与布尔 false 同一语义（设置页存的是字符串也得认）
  reasoning.resetReasoningEffortCache();
  const host2 = makeHost({
    playbookPath: path.join(ROOT, 'off2', 'playbook.md'),
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { autoReasoningDowngrade: 'false' },
  });
  await runAceCommand(host2, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal('reasoningEffort' in host2.record.llmCalls[0], false, "字符串 'false' 也要当成关");
});

// —— 5：模型只声明一档 → 不干预 + warn ——
test('R50-5｜模型只声明一个思考档位 → 不干预（不发 reasoningEffort）并落一条 warn', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'single', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({ 'group/never-stuck': modelInfoOf(EFFORTS['group/never-stuck'], 'high') }),
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'group', model: 'never-stuck' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal('reasoningEffort' in host.record.llmCalls[0], false, '只有一档时发出去等于没改，必须不干预');
  assert.equal(warnsOf(host).includes('只声明了一个思考档位'), true, '要落一条说清原因的 warn：' + warnsOf(host));
  assert.equal(warnsOf(host).includes('high'), true, 'warn 要带上那一档是什么：' + warnsOf(host));
});

// —— 6：查询缺失 / 抛错 / 超时 → 不干预，复盘照常走完 ——
test('R50-6｜档位查询缺失/抛错/超时 → 不干预、复盘照常走完（只 warn，绝不抛）', async () => {
  // (a) 宿主根本没提供 resolveModelInfo（老宿主 / 假 ctx）：能力缺失不是错误，不许炸复盘。
  reasoning.resetReasoningEffortCache();
  const noCapFile = path.join(ROOT, 'nocap', 'playbook.md');
  const noCap = makeHost({ playbookPath: noCapFile, script: () => [] });
  const resA = await runAceCommand(noCap, makeAgent());
  assert.equal(resA.kind, 'success', '能力缺失也必须把复盘走完：' + JSON.stringify(resA));
  assert.equal('reasoningEffort' in noCap.record.llmCalls[0], false);
  assert.equal(warnsOf(noCap).includes('未提供模型档位查询'), true, '要说清是能力缺失：' + warnsOf(noCap));

  // (b) 宿主抛错（模型认不出 / adapter 拒绝）：同样只 warn。
  reasoning.resetReasoningEffortCache();
  const boomFile = path.join(ROOT, 'boom', 'playbook.md');
  const boom = makeHost({
    playbookPath: boomFile,
    script: () => [],
    models: mockModels({ 'p/m': new Error('LlmError: INVALID_MODEL_INFO') }),
  });
  const resB = await runAceCommand(boom, makeAgent());
  assert.equal(resB.kind, 'success', '查询抛错也必须把复盘走完：' + JSON.stringify(resB));
  assert.equal('reasoningEffort' in boom.record.llmCalls[0], false);
  assert.equal(warnsOf(boom).includes('查询思考档位失败'), true, '要说清是查询失败：' + warnsOf(boom));

  // (c) 宿主挂死 → AbortSignal.timeout 到点 + 硬计时兜底，返回值而不是抛出。
  //     真跑 15000ms 太慢，这里把 timeoutMs 压到 20ms 钉住同一条代码路径。
  let seenSignal;
  const hang = {
    resolveModelInfo(provider, model, signal) {
      seenSignal = signal;
      return new Promise(() => {}); // 永不 settle
    },
  };
  // 用一个没被上面两条缓存过的 provider（失败结果会缓存 60s，撞键就测不到真超时路径）。
  const out = await reasoning.queryModelEfforts(hang, 'hang-provider', 'hang-model', { timeoutMs: 20 });
  assert.equal(out.ok, false, '超时必须返回结构化失败，不许抛');
  assert.match(out.error, /timeout after/, '错误里要留下超时事实：' + out.error);
  assert.equal(seenSignal && seenSignal.aborted, true, 'AbortSignal.timeout 要到点、signal 要真的中止');
});

// —— 7：某轮超时 → 降到最低档重试这一轮一次 ——
test('R50-7｜某一轮超时 → 降到最低档重试该轮一次（恰好两次调用，第二次带最低档）', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'retry', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    // 第 1 次调用超时（oneShot 的超时错误就是以这个前缀开头的），第 2 次收敛。
    script: (i) => {
      if (i === 0) throw new Error('ace: LLM 调用超时（单次上限 150000ms）：The operation was aborted');
      return [];
    },
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { reflectReasoningEffort: 'high' }, // 首轮先按用户手动档 high 发，重试才降
  });
  const res = await runAceCommand(host, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(res.kind, 'success', JSON.stringify(res));
  assert.equal(host.record.llmCalls.length, 2, '超时只许重试一次：' + host.record.llmCalls.length);
  assert.equal(host.record.llmCalls[0].reasoningEffort, 'high', '第一次按手动档发');
  assert.equal(host.record.llmCalls[1].reasoningEffort, 'off', '重试必须降到该模型声明的最低档');
  assert.equal(warnsOf(host).includes('第 1 轮超时，已降到最低档 off 重试一次'), true, '重试要留一条 dsh-ace: 日志：' + warnsOf(host));
});

// —— 8：重试仍失败 ——
test('R50-8｜重试仍失败：普通错误不重试并上抛；超时重试仍失败时候选照常落盘、不假成功', async () => {
  // (a) 普通错误（非超时）：一次调用都不多，错误原样上抛 → /ace 报失败。
  reasoning.resetReasoningEffortCache();
  const plainFile = path.join(ROOT, 'plain-error', 'playbook.md');
  const plain = makeHost({
    playbookPath: plainFile,
    script: () => { throw new Error('手册写入失败：磁盘满了'); },
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { reflectReasoningEffort: 'high' },
  });
  const resA = await runAceCommand(plain, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(resA.kind, 'error', '普通错误必须上抛成失败：' + JSON.stringify(resA));
  assert.equal(resA.text.includes('复盘失败'), true, resA.text);
  assert.equal(plain.record.llmCalls.length, 1, '普通错误不许重试：' + plain.record.llmCalls.length);
  assert.equal(warnsOf(plain).includes('已降到最低档'), false, '普通错误不该走降档重试：' + warnsOf(plain));

  // (b) 超时重试也失败：第 1 轮已提炼到的候选不许丢，也不许假装成功。
  reasoning.resetReasoningEffortCache();
  const keepFile = path.join(ROOT, 'retry-fail', 'playbook.md');
  const keep = makeHost({
    playbookPath: keepFile,
    script: (i) => {
      if (i === 0) return [CANDIDATE];            // 第 1 轮提炼到 1 条
      throw new Error('ace: LLM 调用超时（单次上限 150000ms）：The operation was aborted'); // 第 2 轮的两次调用都超时
    },
    models: mockModels({ 'auto/glm-5.3-flash': modelInfoOf(EFFORTS['auto/glm-5.3-flash'], 'high') }),
    config: { reflectReasoningEffort: 'high' },
  });
  const resB = await runAceCommand(keep, makeAgent({ provider: 'auto', model: 'glm-5.3-flash' }));
  assert.equal(keep.record.llmCalls.length, 3, '第 2 轮：首发 + 降档重试一次，共 3 次调用：' + keep.record.llmCalls.length);
  assert.equal(keep.record.llmCalls[2].reasoningEffort, 'off', '重试那次必须是降过的档');
  assert.equal(warnsOf(keep).includes('第 2 轮超时，已降到最低档 off 重试一次'), true, warnsOf(keep));
  const entries = playbookEntries(keepFile);
  assert.equal(entries.length, 1, '第 1 轮已回收的候选不许丢：' + JSON.stringify(entries.map((e) => e.title)));
  assert.equal(entries[0].title, CANDIDATE.title);
  assert.equal(resB.kind, 'success', '中断的是第 2 轮，整份复盘按既有语义收尾：' + JSON.stringify(resB));
  assert.equal(resB.text.includes('新增 1 条'), true, resB.text);
});

// —— 9：两个新配置键的读写边界 ——
test('R50-9｜新键配置面：默认值 / bounds / POST 落盘读回 / 非法档位 400 / 读盘归一 / 白名单 17 键', async () => {
  const file = path.join(ROOT, 'config', 'playbook.md');
  const host = makeHost({ playbookPath: file, script: () => [] });
  const handler = mountApi(host);
  const settingsOf = () => callRoute(handler, 'GET', '/api/dsh-ace/settings');
  const put = (body) => callRoute(handler, 'POST', '/api/dsh-ace/settings', body);

  // schema 默认值 + 白名单 17 键（Config.fields 是设置页的唯一边界出处；第 55 轮加 injectRationale）
  const keys = Object.keys(plugin.Config.fields);
  assert.equal(keys.length, 17, 'Config 必须是 17 个字段：' + keys.join(','));
  assert.ok(keys.includes('reflectReasoningEffort') && keys.includes('autoReasoningDowngrade'), keys.join(','));
  assert.equal(plugin.Config.fields.reflectReasoningEffort.defaultValue, '', '默认 = 未手动指定');
  assert.equal(plugin.Config.fields.autoReasoningDowngrade.defaultValue, true, '自动降档默认开');

  let res = await settingsOf();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bounds.reasoningEfforts, reasoning.REASONING_EFFORT_IDS, '设置页需要档位清单');
  assert.equal(res.body.value.autoReasoningDowngrade, true);
  assert.equal(res.body.value.reflectReasoningEffort, '');
  // 老键的 bounds 与 defaults 不许被动过
  assert.deepEqual(res.body.bounds.maxEntries, [1, 1000]);
  assert.deepEqual(res.body.bounds.autoRecapThreshold, [0, 1000]);
  assert.equal(res.body.bounds.defaults.injectTokenBudget, 500);

  // POST 写入 → 落盘 → GET 读回
  res = await put({ reflectReasoningEffort: 'xhigh', autoReasoningDowngrade: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.value.reflectReasoningEffort, 'xhigh');
  assert.equal(res.body.value.autoReasoningDowngrade, false);
  assert.equal(res.body.stored.reflectReasoningEffort, 'xhigh');
  const raw = JSON.parse(fs.readFileSync(res.body.file, 'utf8'));
  assert.equal(raw.reflectReasoningEffort, 'xhigh', '必须真落盘');
  assert.equal(raw.autoReasoningDowngrade, false);
  res = await settingsOf();
  assert.equal(res.body.value.reflectReasoningEffort, 'xhigh', 'GET 要读回落盘值');

  // 非法档位名 → 400，且当前值不许被改
  for (const bad of ['HIGH', 'ultra', 'mid', 7]) {
    const before = (await settingsOf()).body.value.reflectReasoningEffort;
    const badRes = await put({ reflectReasoningEffort: bad });
    assert.equal(badRes.status, 400, String(bad) + ' 必须被拦下');
    assert.ok(/off\/minimal\/low\/medium\/high\/xhigh\/max/.test(badRes.body.error), '报错文案要带合法清单：' + badRes.body.error);
    assert.equal((await settingsOf()).body.value.reflectReasoningEffort, before);
  }
  // 空串是合法值（= 回到「未手动指定」）
  res = await put({ reflectReasoningEffort: '' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.value.reflectReasoningEffort, '');
  // 布尔非法值 → 400
  res = await put({ autoReasoningDowngrade: 'maybe' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'autoReasoningDowngrade 必须是 true 或 false');

  // 读盘归一：手改设置文件（坏档位 / 坏布尔）→ 重新 apply 后丢掉坏值并 warn，绝不带着坏值跑
  const settingsFile = (await settingsOf()).body.file; // 上面几发 400 已经把 res 换掉了，路径重新取
  fs.writeFileSync(settingsFile, JSON.stringify({ reflectReasoningEffort: 'ULTRA', autoReasoningDowngrade: 'nope' }), 'utf8');
  const fresh = makeHost({ playbookPath: file, script: () => [], profileDir: host.profileDir });
  const freshHandler = mountApi(fresh);
  const freshBody = (await callRoute(freshHandler, 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(freshBody.value.reflectReasoningEffort, '', '非法档位读盘归一要丢弃 → 回落 Config 默认空串');
  assert.equal(freshBody.value.autoReasoningDowngrade, true, '非法布尔读盘归一要丢弃 → 回落默认 true');
  assert.equal(freshBody.stored.reflectReasoningEffort, undefined, '丢弃的键不许留在 stored 里');
  assert.equal(warnsOf(fresh).includes('reflectReasoningEffort'), true, '丢弃非法档位要 warn：' + warnsOf(fresh));

  // applyStored 白名单真的包含这两个键：合法值写盘后重新 apply，live 必须读到（漏一个键就是「存了不生效」）
  fs.writeFileSync(freshBody.file, JSON.stringify({ reflectReasoningEffort: 'low', autoReasoningDowngrade: false }), 'utf8');
  const remount = makeHost({ playbookPath: file, script: () => [], profileDir: host.profileDir });
  const remountBody = (await callRoute(mountApi(remount), 'GET', '/api/dsh-ace/settings')).body;
  assert.equal(remountBody.value.reflectReasoningEffort, 'low', '白名单漏了就是存了不生效');
  assert.equal(remountBody.value.autoReasoningDowngrade, false);
  assert.equal(remountBody.configured.reflectReasoningEffort, '', 'configured 是插件行 Config，不该被 stored 改');
});

// —— 10：GET /api/dsh-ace/efforts ——
test('R50-10｜GET /api/dsh-ace/efforts：显式参数 / 宿主抛错不 500 / 无会话路由 / 405 / 落到会话路由', async () => {
  reasoning.resetReasoningEffortCache();
  const file = path.join(ROOT, 'api', 'playbook.md');
  const host = makeHost({
    playbookPath: file,
    script: () => [],
    models: mockModels({
      'auto/glm-5.3-flash2': modelInfoOf(EFFORTS['auto/glm-5.3-flash2'], 'high'),
      'p/m': modelInfoOf(['low', 'high'], 'high'),
      // 宿主**没声明** defaultEffort 的夹具：只给 efforts，没有 default 这一项。
      'auto/glm-5.3-flash-nodefault': modelInfoOf(['low', 'high']),
    }),
  });
  const handler = mountApi(host);

  // (a) 显式给 provider+model
  let res = await callRoute(handler, 'GET', '/api/dsh-ace/efforts?provider=auto&model=glm-5.3-flash2');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.provider, 'auto');
  assert.equal(res.body.model, 'glm-5.3-flash2');
  assert.deepEqual(res.body.efforts.map((e) => e.id), ['off', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(res.body.efforts[0].name, '档位off', 'efforts 项要带 name（前端下拉直接用）');
  assert.equal(res.body.defaultEffort, 'high', '声明了 defaultEffort 就带出来给设置页显示');
  // 换一个**没声明** defaultEffort 的模型（只给 efforts）→ 报文里该键整体缺席，不是 null：
  // 否则设置页会显示一句宿主从没说过的话（第 52 轮删掉的正是「回落 efforts 末项 = 最强档」）。
  const noDefaultRes = await callRoute(handler, 'GET', '/api/dsh-ace/efforts?provider=auto&model=glm-5.3-flash-nodefault');
  assert.equal(noDefaultRes.status, 200);
  assert.equal(noDefaultRes.body.ok, true, JSON.stringify(noDefaultRes.body));
  assert.deepEqual(noDefaultRes.body.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(Object.prototype.hasOwnProperty.call(noDefaultRes.body, 'defaultEffort'), false, '报文里 defaultEffort 除非宿主声明过，绝不出现（缺键 ≠ null）');
  assert.deepEqual(res.body.effective, { effort: 'off', source: 'auto' }, '默认会自动降到最低档');
  // 手动值给出来时 effective 跟着变
  fs.writeFileSync(path.join(host.profileDir, 'dsh-ace.json'), JSON.stringify({ reflectReasoningEffort: 'medium' }), 'utf8');
  const manualHost = makeHost({
    playbookPath: path.join(ROOT, 'api-manual', 'playbook.md'),
    script: () => [],
    models: mockModels({ 'auto/glm-5.3-flash2': modelInfoOf(EFFORTS['auto/glm-5.3-flash2'], 'high') }),
    profileDir: host.profileDir,
  });
  res = await callRoute(mountApi(manualHost), 'GET', '/api/dsh-ace/efforts?provider=auto&model=glm-5.3-flash2');
  assert.deepEqual(res.body.effective, { effort: 'medium', source: 'manual' }, JSON.stringify(res.body.effective));

  // (b) 宿主查询抛错 → ok:false，HTTP 仍是 200（绝不 500、绝不抛到路由外）
  reasoning.resetReasoningEffortCache();
  res = await callRoute(handler, 'GET', '/api/dsh-ace/efforts?provider=nope&model=nothing');
  assert.equal(res.status, 200, '宿主失败也不许整页 500');
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /^ace: /, '失败要带 ace: 前缀：' + res.body.error);
  assert.equal(warnsOf(host).includes('无法读取思考档位'), true, '失败只 warn：' + warnsOf(host));

  // (c) 什么都没给 + 从没观察到会话路由 → 结构化失败，不是 500
  const bare = makeHost({ playbookPath: path.join(ROOT, 'api-bare', 'playbook.md'), script: () => [] });
  res = await callRoute(mountApi(bare), 'GET', '/api/dsh-ace/efforts');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: false, error: 'ace: session model unknown' });

  // (d) 方法不是 GET → 405（与周边路由同一口径）
  res = await callRoute(handler, 'POST', '/api/dsh-ace/efforts', {});
  assert.equal(res.status, 405);
  assert.deepEqual(res.body, { error: 'method not allowed' });

  // (e) 无参但已观察过会话 → 落到最近一次观察到的会话路由
  const observed = makeHost({
    playbookPath: path.join(ROOT, 'api-observed', 'playbook.md'),
    script: () => [],
    models: mockModels({ 'p/m': modelInfoOf(['low', 'high'], 'high') }),
  });
  const observedHandler = mountApi(observed);
  res = await callRoute(observedHandler, 'GET', '/api/dsh-ace/efforts');
  assert.equal(res.body.ok, false, '还没跑过 pre-step 时只该是 session model unknown');
  await emitPreStep(observed, makeAgent());
  res = await callRoute(observedHandler, 'GET', '/api/dsh-ace/efforts');
  assert.equal(res.body.ok, true, JSON.stringify(res.body));
  assert.equal(res.body.provider, 'p');
  assert.equal(res.body.model, 'm');
  assert.deepEqual(res.body.effective, { effort: 'low', source: 'auto' });
  // 只解析问到的这一个 provider+model —— 没问到的模型不许被顺手查一遍
  assert.equal(observed.record.llmCalls.length, 0, 'GET /efforts 不许发 LLM 请求');
});
