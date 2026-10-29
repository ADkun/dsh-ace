// dsh-ace 端到端演练测试（C6 任务 3）—— 替代「真实会话自证」的那条证据。
//
// 为什么要桩宿主包：本仓库不带 node_modules，lib/index.js 顶层 import 三个宿主包
// （@deepseek-ai/schemastery、dsh-tools、dsh-llm）。这里用 node:module 的 registerHooks
// 把它们重定向到 data: URL 形式的最小桩，从而**真 import lib/index.js 并真调 apply()**。
//
// 桩的边界（红线）：只桩宿主包 + 假 agent / 假 ctx / 假事件流。
// archive / inject / playbook / commit / recap-pipeline 这些纯模块**一律不桩**，
// 全部按生产代码真跑，断言也全部读回临时目录里那份真实的手册文件。
//
// 全程临时目录：手册与设置都落在 os.tmpdir() 下的 mkdtemp 里，
// 绝不碰用户的真实手册（<DSH home>/ace/playbook.md）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-e2e-'));
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// 必须在 import lib/index.js **之前**钉住：设置文件与共享手册都按这两个变量解析。
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

// —— 三个宿主包的最小桩（data: URL，不落盘）——
const STUBS = {
  '@deepseek-ai/schemastery':
    'const chain = () => { const f = (v) => f; f.description = () => f; f.default = () => f; f.optional = () => f; return f; };' +
    'export default { string: () => chain(), boolean: () => chain(), number: () => chain(), object: () => chain() };',
  '@deepseek-ai/dsh-tools': 'export function defineTool(options) { return options; }',
  // 照 ~dsh-llm\lib\index.js:59-64 写：只 spread + 补 role/id，不校验形状。
  // 第 28 轮起注入靠它造「追加进历史」的那条 user 消息，所以桩必须给出 role。
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

// 被验证的纯模块（真跑，不桩）。
const { serializePlaybook, parsePlaybook, withExclusiveLock, writeFileAtomic } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'playbook.js')).href
);
const { dayString } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'archive.js')).href);
const { estimateTokens, INJECT_MAX_ENTRIES, INJECT_TOKEN_BUDGET } = await import(
  pathToFileURL(path.join(HERE, '..', 'lib', 'inject.js')).href
);
// 第 33 轮：归档搬进独立文件 archive.md，读它要走 archive-file 的解析器
// （手册解析器 parsePlaybook 已经不认 '## 归档区' 了）。
const { readArchiveSnapshot } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'archive-file.js')).href);
const { dayOf } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'timestamp.js')).href);

const INJECTION_MARK = '【ACE 自动注入】';
// 第 33 轮：dayString 已升到毫秒时间戳，界面/断言里的「日期」口径统一取 dayOf。
const TODAY = dayOf(dayString());
const daysAgo = (n) => dayOf(dayString(new Date(Date.now() - n * 86400000)));
/** 第 33 轮的时间戳口径：本地时区毫秒精度 ISO（字典序即时间序）。 */
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

// —— 夹具 ——

/** 一条手册条目（形状与 lib/playbook.js 的 parsePlaybook 一致，落盘走真序列化器）。 */
function entry(spec) {
  const created = spec.created ?? TODAY;
  return {
    id: spec.id,
    title: spec.title,
    condition: spec.condition,
    action: spec.action,
    rationale: spec.rationale ?? '',
    meta: {
      created,
      updated: spec.updated ?? created,
      hits: spec.hits ?? 0,
      lastHit: spec.lastHit ?? '',
    },
    extraLines: [],
  };
}

/** LLM 候选（四字段齐全，否则 lib/index.js 的 reflectRound 会过滤掉）。 */
const cand = (title, condition, action, rationale = '') => ({ title, condition, action, rationale });

/** 真走生产的锁 + 原子写，把手册写进临时目录。 */
async function writePlaybook(file, entries) {
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header: ['# ACE 手记', ''], entries })));
}

const readParsed = (file) => parsePlaybook(fs.readFileSync(file, 'utf8'));

/** 归档文件与手册同目录（lib/playbook-path.js 的 resolveArchiveFile 就是这个约定）。 */
const archiveFileOf = (file) => path.join(path.dirname(file), 'archive.md');

/**
 * 每个场景一个独立目录：归档文件与手册**同目录**，共用 ROOT 会让场景之间互相污染
 * （场景 5 淘汰出来的 archive.md 会被场景 7 读到）。返回该场景的手册路径。
 */
function scenarioDir(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'playbook.md');
}

/** 归档文件里的条目（文件不存在 → 空数组，绝不因此让用例失败）。 */
async function readArchived(file) {
  const snapshot = await readArchiveSnapshot(archiveFileOf(file));
  return snapshot.entries || [];
}

/**
 * 假宿主 + 假 LLM。script 按「第几次 LLM 调用」返回候选数组（0 基）。
 * 事件处理器、工具、系统提示段、命令全部记进 record，供断言与真驱动。
 */
function makeHost({ playbookPath, script, config = {}, maxEntries = 100 }) {
  const record = {
    tools: [],
    sections: [],
    handlers: [],
    commands: [],
    injected: [],
    llmCalls: [],
    logs: { info: [], warn: [], error: [] },
  };
  const bucket = (name) => (message) => { record.logs[name].push(String(message)); if (process.env.ACE_E2E_DEBUG) console.log('[LOG]', name, String(message)); };
  const ctx = {
    logger: { info: bucket('info'), warn: bucket('warn'), error: bucket('error'), debug: () => {} },
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
    llm: {
      async *stream(options) {
        const index = record.llmCalls.length;
        record.llmCalls.push(options);
        const batch = typeof script === 'function' ? script(index) : script[index] ?? [];
        // 复盘（Reflector）要的是 `{candidates:[…]}` 外壳；合并（MERGE_SYSTEM）要的是**裸四字段 JSON**。
        // 脚本返回字符串 = 供应商原样吐这段文本（合并用），返回数组/对象 = 按候选批次包一层（复盘用）。
        const text = typeof batch === 'string' ? batch : JSON.stringify({ candidates: batch, notes: 'e2e' });
        yield { type: 'text-delta', index: 0, text };
      },
    },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  plugin.apply(ctx, {
    playbookPath,
    autoReflect: true,
    reflectProvider: '',
    reflectModel: '',
    maxEntries,
    autoRecap: true,
    autoRecapThreshold: 1,
    autoRecapCooldownTurns: 0,
    autoReviewInbox: false,
    // 绝对门槛（4.0 × IDF_MAX）另有一组专门用例（tests/inject.test.mjs 的 C5.8）。
    // e2e 钉的是整条回合链路（复核/合并/投递/账本），两三行的小手册夹具会被门槛整片挡空，
    // 所以这里只在本文件关掉门槛（0 = 关）；生产默认仍是 4.0 / 0.6。
    injectMinScoreIdfRatio: 0,
    injectMinRelativeToTop: 0,
    ...config,
  });
  return { ctx, record };
}

/** 假 agent：宿主会话历史可读（复盘要真轨迹），维护任务随时可跑（假宿主永远 idle）。 */
function makeAgent() {
  const notices = [];
  return {
    notices,
    session: {
      header: { origin: 'cli' },
      requestHeader: () => ({ config: { provider: 'e2e-provider', model: 'e2e-model' } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: '把 lib/foo.js 的导出改成 bar' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '先读一遍再改。' },
            { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"path":"lib/foo.js"}' },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '写入成功' }] },
      ],
    },
    options: { provider: 'e2e-provider', model: 'e2e-model' },
    phase: 'idle',
    async runMaintenance(job) {
      return await job(new AbortController().signal);
    },
    async whenIdle() {},
    followup: (message) => notices.push(message),
  };
}

/** 触发插件注册的事件处理器（真处理器，不包装）。 */
function emit(host, event, ...args) {
  const hits = host.record.handlers.filter((h) => h.event === event);
  assert.ok(hits.length > 0, '插件没有注册事件 ' + event);
  for (const h of hits) h.handler(...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, { timeout = 5000, interval = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return true;
    await sleep(interval);
  }
  assert.fail('超时未满足：' + label);
}

const logHas = (host, needle) => host.record.logs.info.some((m) => m.includes(needle));
const warnHas = (host, needle) => host.record.logs.warn.some((m) => m.includes(needle));

/**
 * 「这一回合的写盘真的做完了」的判据：直接看盘，而不是看某一行日志。
 *
 * 手册写入走 writeFileAtomic（同目录临时文件 + rename），所以任何时候读盘都读到完整文件；
 * 只要目标状态已经在盘上，它前面那几次写（计分 commitMeta、落盘 commitOps）就必然已经完成。
 * 日志顺序则会随实现调整而变 —— 第五轮把计分从流水线内部挪到回合边界的 settleUsage 之后，
 * 「计分传播」这行日志就跑到了候选落盘之前；场景 4 原先拿它当 until 判据，于是判据一满足
 * 就往下读盘，写盘还没发生，断言偶发失败（flaky 的根因，不是生产缺陷）。
 */
function diskHas(file, check) {
  return () => {
    try {
      return check(readParsed(file));
    } catch {
      return false;
    }
  };
}

/** 活跃区里出现了这个标题的条目（第 33 轮起归档在独立文件 archive.md，parsePlaybook 不再返回 archives）。 */
const hasTitle = (title) => (parsed) => parsed.entries.some((e) => e.title === title);

/** 走真实事件链跑一个回合：工具结果 → 回合结束 → 空闲边沿（触发自动复盘）。 */
async function runTurn(host, agent, { turn, toolName = 'write', isError = false, until }) {
  emit(host, 'tools/result', { name: toolName, agent }, { isError });
  emit(host, 'agent/turn-stopping', { agent, turn });
  emit(host, 'agent/status', { agent, status: 'idle' });
  if (until) await waitFor(until, '回合 ' + turn + ' 没有跑完｜info: ' + host.record.logs.info.join(' / ') + '｜warn: ' + host.record.logs.warn.join(' / '));
}

/** 取系统提示段的正文（真调插件注册的 section.text 回调）。 */
const sectionText = (host, agent) => host.record.sections[0].text({ agent });

/**
 * 驱动一次宿主派发的 agent/pre-step（waterfall）：payload {agent, messages, turn, step, signal}，
 * next() 返回宿主自己的决策 {kind:'enter', messages}。第 28 轮起注入就挂在这个接缝上。
 */
async function runPreStep(host, agent, { messages = [], step = 1, turn = 1 } = {}) {
  const hits = host.record.handlers.filter((h) => h.event === 'agent/pre-step');
  assert.ok(hits.length > 0, '插件没有注册 agent/pre-step（注入就无处投递了）');
  const base = { kind: 'enter', messages, startsRequestSeries: true };
  let decision = base;
  for (const h of hits) {
    const next = async () => base;
    decision = await h.handler({ agent, messages, turn, step, signal: { throwIfAborted() {} } }, next);
  }
  return decision;
}

/**
 * 投递一条用户消息 → 等预检索把注入批次放进缓存 → 驱动 agent/pre-step 让它追加进历史。
 * 返回追加出来的那条消息、它的正文、以及「第几步才就绪」。
 * 注意：改前这里靠反复求值系统提示段来「取走」注入，而系统提示现在必须是逐字常量，
 * 所以这条用例的判据换成了「历史里多出一条 source.kind='dsh-ace' 的 user 消息」。
 */
async function injectFor(host, agent, { text = '数据库迁移要注意什么', tries = 40 } = {}) {
  emit(host, 'agent/inbox/inserted', {
    agent,
    message: { role: 'user', id: 'msg-' + Math.random().toString(36).slice(2), content: [{ type: 'text', text }] },
  });
  for (let i = 1; i <= tries; i += 1) {
    const decision = await runPreStep(host, agent, { step: i });
    const appended = decision.messages.filter((m) => m && m.source && m.source.kind === 'dsh-ace');
    if (appended.length) {
      const message = appended[appended.length - 1];
      const body = message.content.map((block) => block.text || '').join('\n');
      return { text: body, message, tries: i, decision };
    }
    await sleep(10);
  }
  assert.fail('agent/pre-step 没有把注入追加进历史（等了 ' + tries * 10 + 'ms）');
}

/** 假 HTTP 请求/响应（只覆盖 GET 需要的表面）。 */
async function callRoute(handler, method, urlPath) {
  const req = {
    method,
    url: urlPath,
    headers: { host: '127.0.0.1:3080' },
    on: (event, callback) => {
      if (event === 'end') callback();
      return req;
    },
    destroy: () => {},
  };
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    end(body) {
      this.body = body ?? '';
      return this;
    },
  };
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

/** 注册 webServer 注入并取回 /api/dsh-ace 的路由处理器。 */
function mountRoutes(host) {
  const { deps, callback } = host.record.injected[0];
  assert.deepEqual(deps, ['webServer'], 'webServer 注入的依赖声明被改了');
  const routes = [];
  callback({ webServer: { register: (route) => routes.push(route) }, effect: (fn) => fn(), logger: host.ctx.logger });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, '/api/dsh-ace');
  return routes[0].handler;
}

// ————————————————————————————————————————————————————————————————
// 场景 1：假 agent 的一次 mutating 工具结果 → agent/turn-stopping → agent/status idle
//         真的驱动了一次自动复盘（不是只打日志）。
// ————————————————————————————————————————————————————————————————
test('E2E 场景1｜mutating 工具结果 → turn-stopping → status idle 真的触发自动复盘并落盘', async () => {
  const file = scenarioDir('e2e-1');
  await writePlaybook(file, []);
  const host = makeHost({
    playbookPath: file,
    script: [[cand('数据库迁移前先备份', '要改数据库结构时', '先导出快照再迁移')], []],
  });
  const agent = makeAgent();

  await runTurn(host, agent, { turn: 2, until: diskHas(file, hasTitle('数据库迁移前先备份')) });

  assert.ok(
    logHas(host, '回合 2 记账 1 次 mutating 调用，已挂自动复盘待办（等空闲边沿执行）'),
    '回合内只该记账、不该直接复盘；实际日志：' + host.record.logs.info.join(' / '),
  );
  // 第 33 轮：回合成败判定（三档信号 weak / unobserved / ok）整层删除 —— 外部因素主导、
  // 归因不可靠，所以这里不再断言任何「失败信号」日志，只断言复盘真的发生了。
  assert.equal(warnHas(host, '失败信号'), false, '不该再有回合成败信号：' + host.record.logs.warn.join(' / '));
  assert.equal(host.record.llmCalls.length, 2, '第 1 轮 1 条候选、第 2 轮空数组收敛 → 正好两次 LLM 调用');
  assert.equal(host.record.llmCalls[0].provider, 'e2e-provider', 'LLM 路由没走到会话配置');
  assert.equal(host.record.llmCalls[0].model, 'e2e-model');

  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 1, '真手册里应该落下 1 条');
  assert.equal(parsed.entries[0].title, '数据库迁移前先备份');
  // 毫秒时间戳（第 33 轮）：created 是本地时区毫秒精度 ISO，日期部分仍是当天。
  assert.equal(STAMP_RE.test(parsed.entries[0].meta.created), true, 'created 必须是毫秒时间戳：' + parsed.entries[0].meta.created);
  assert.equal(dayOf(parsed.entries[0].meta.created), TODAY, 'created 的日期部分该是今天');
});

// ————————————————————————————————————————————————————————————————
// 场景 2：多轮复盘 —— 第 1 轮 3 条、第 2 轮空数组 → 收敛在第 2 轮（默认上限 2）、候选共 3 条。
// ————————————————————————————————————————————————————————————————
test('E2E 场景2｜多轮复盘在第 2 轮空数组处收敛，候选总数 3 条', async () => {
  const file = scenarioDir('e2e-2');
  await writePlaybook(file, []);
  const host = makeHost({
    playbookPath: file,
    script: [
      [cand('日志按请求号串联', '排查线上问题时', '先按 trace id 把所有日志捞齐'), cand('改配置前先备份', '要动生产配置时', '先导出当前配置快照'), cand('迁移脚本先在影子库试跑', '要执行数据迁移时', '影子库跑通再上生产')],
      [],
    ],
  });
  const agent = makeAgent();

  await runTurn(host, agent, { turn: 2, until: diskHas(file, (p) => ['日志按请求号串联', '改配置前先备份', '迁移脚本先在影子库试跑'].every((t) => hasTitle(t)(p))) });

  assert.equal(host.record.llmCalls.length, 2, '必须正好 2 轮（第 2 轮空数组即收敛，不再多问一轮）');
  assert.ok(logHas(host, '多轮复盘第 1 轮产出 3 条候选（累计 3 条）'), host.record.logs.info.join(' / '));
  assert.ok(logHas(host, '多轮复盘第 2 轮无新增候选，判定收敛（已提炼 3 条）'), host.record.logs.info.join(' / '));
  assert.ok(logHas(host, '复盘完成 第 1 次（2 轮收敛），本轮候选 3 条，累计候选 3 条'), host.record.logs.info.join(' / '));

  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 3, '3 条候选都该落盘');
  assert.deepEqual(
    parsed.entries.map((e) => e.title).sort(),
    ['改配置前先备份', '日志按请求号串联', '迁移脚本先在影子库试跑'].sort(),
  );
});

// ————————————————————————————————————————————————————————————————
// 场景 3：候选落盘三种结局 —— 一条新增、一条覆盖同标题旧条目（净分>0 原地更新）、
//         一条与旧条目完全重复被丢弃。
// ————————————————————————————————————————————————————————————————
test('E2E 场景3｜候选落盘：新增 / 同标题原地更新 / 完全重复丢弃', async () => {
  const file = scenarioDir('e2e-3');
  await writePlaybook(file, [
    entry({
      id: 'ace-001',
      title: '部署前先跑全量测试',
      condition: '每次部署前',
      action: '跑完整测试套件再部署',
      hits: 2,
    }),
    entry({
      id: 'ace-002',
      title: '写文件前先读一遍',
      condition: '要修改已有文件时',
      action: '先用 read 读完整再动手',
    }),
  ]);
  // 原地 update 的判据（lib/archive.js decideCandidates）：同标题命中后，候选正文**不比旧条目长**才覆盖；
  // 候选更长会走「新增 + 旧条目 superseded 归档」（旧正文不许蒸发）。这里刻意写短一点。
  const update = cand(
    '部署前先跑全量测试',
    '每次部署前',
    '跑完整测试再部署',
  );
  const duplicate = cand('写文件前先读一遍', '要修改已有文件时', '先用 read 读完整再动手');
  const fresh = cand('数据库迁移前先备份', '要改数据库结构时', '先导出快照再迁移');
  const host = makeHost({ playbookPath: file, script: [[update, duplicate, fresh], []] });
  const agent = makeAgent();

  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => p.entries.length === 3 && hasTitle('数据库迁移前先备份')(p))()
      && logHas(host, '新增 1 条、更新 1 条'),
  });

  assert.ok(logHas(host, '候选与既有条目完全重复，丢弃 1 条'), '重复候选必须被丢弃并留痕：' + host.record.logs.info.join(' / '));
  assert.ok(logHas(host, '新增 1 条、更新 1 条'), '落盘计数应为 新增 1 / 更新 1：' + host.record.logs.info.join(' / '));

  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 3, '活跃条目：更新后的 ace-001 + ace-002 + 新增 1 条');
  const updated = parsed.entries.find((e) => e.id === 'ace-001');
  assert.ok(updated, '同标题候选必须原地更新 ace-001，不许新开一条');
  assert.equal(updated.condition, update.condition, '条件没被更新');
  assert.equal(updated.action, update.action, '做法没被更新');
  assert.equal(
    parsed.entries.filter((e) => e.title === '部署前先跑全量测试').length,
    1,
    '同标题候选不许留下两条同名条目',
  );
  const untouched = parsed.entries.find((e) => e.id === 'ace-002');
  assert.equal(untouched.action, '先用 read 读完整再动手', '重复候选不许改动原条目');
  assert.ok(parsed.entries.some((e) => e.title === '数据库迁移前先备份'), '全新主题必须新增');
  // 第 33 轮：归档在独立文件 archive.md 里；容量没满、没有候选被取代 → 根本不该造出归档文件。
  assert.equal(fs.existsSync(archiveFileOf(file)), false, '没有淘汰/合并不该造出 archive.md');
  assert.equal(/##\s*归档区/.test(fs.readFileSync(file, 'utf8')), false, '手册文件里永远不再出现归档区章节');
});

// ————————————————————————————————————————————————————————————————
// 场景 4：命中计数 —— 本轮注入 2 条（真走 injection-flow 的 publish → agent/pre-step 的 take+note），
//         回合边界（agent/turn-stopping）一次原子写盘 → 这 2 条 hits +1、lastHit 是毫秒时间戳。
//         第 33 轮起没有正负评分：helpful/harmful 字段已从元数据里彻底删除。
// ————————————————————————————————————————————————————————————————
test('E2E 场景4｜注入 2 条 → 回合边界落盘：hits +1、lastHit 毫秒戳、元数据里没有 helpful/harmful', async () => {
  const file = scenarioDir('e2e-4');
  await writePlaybook(file, [
    entry({ id: 'ace-001', title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' }),
    entry({ id: 'ace-002', title: '迁移脚本先在影子库试跑', condition: '要执行数据库迁移时', action: '影子库跑通再上生产' }),
  ]);
  const host = makeHost({
    playbookPath: file,
    script: [[cand('迁移失败要能一键回滚', '迁移出问题时', '保留旧表并准备好回滚脚本')], []],
  });
  const agent = makeAgent();

  const injected = await injectFor(host, agent);
  assert.ok(injected.text.includes('[ace-001]'), '注入块里应该有 ace-001：' + injected.text);
  assert.ok(injected.text.includes('[ace-002]'), '注入块里应该有 ace-002：' + injected.text);
  assert.equal(injected.message.role, 'user', '注入是追加的一条 user 消息');
  assert.equal(injected.message.source.kind, 'dsh-ace');
  assert.equal(injected.message.source.form, 'injection');

  // 判据放在盘上：hits 的落盘发生在回合边界（turn-stopping）之后，落盘完成才继续断言。
  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => hasTitle('迁移失败要能一键回滚')(p)
      && ['ace-001', 'ace-002'].every((id) => (p.entries.find((e) => e.id === id) || { meta: {} }).meta.hits === 1))(),
  });

  assert.ok(
    logHas(host, '注入已追加进历史'),
    '注入追加日志缺失：' + host.record.logs.info.join(' / '),
  );
  assert.equal(
    host.record.logs.info.some((m) => m.includes('计分') || m.includes('outcome')),
    false,
    '计分整层已删，不该再有计分日志：' + host.record.logs.info.join(' / '),
  );

  const parsed = readParsed(file);
  for (const id of ['ace-001', 'ace-002']) {
    const got = parsed.entries.find((e) => e.id === id);
    assert.ok(got, id + ' 不该消失');
    assert.equal('helpful' in got.meta, false, id + ' 的元数据里不许再有 helpful');
    assert.equal('harmful' in got.meta, false, id + ' 的元数据里不许再有 harmful');
    assert.equal(got.meta.hits, 1, id + ' 的 hits 应该 +1（注入即算命中）');
    assert.equal(STAMP_RE.test(got.meta.lastHit), true, id + ' 的 lastHit 必须是毫秒时间戳：' + got.meta.lastHit);
    assert.equal(dayOf(got.meta.lastHit), TODAY, id + ' 的 lastHit 日期该是今天');
  }
  const added = parsed.entries.find((e) => e.title === '迁移失败要能一键回滚');
  assert.ok(added, '本轮候选也该落盘');
  assert.equal(added.meta.hits, 0, '新条目没被注入，hits 该是 0');
  assert.equal(added.meta.lastHit, '', '新条目还没被命中过，lastHit 是空串');

  // 元数据行口径（第 33 轮定死）：created → updated → hits → lastHit，helpful/harmful 不再出现。
  const metaLine = fs.readFileSync(file, 'utf8').split('\n').find((line) => line.includes('hits=1'));
  assert.ok(metaLine, '落盘的元数据行里该有 hits=1：\n' + fs.readFileSync(file, 'utf8'));
  assert.equal(/helpful=|harmful=/.test(metaLine), false, '元数据行里不许再有 helpful/harmful：' + metaLine);
  assert.equal(
    /^-\s*元数据：created=\S+ updated=\S+ hits=1 lastHit=\S+$/.test(metaLine.trim()),
    true,
    '元数据字段顺序必须是 created → updated → hits → lastHit：' + metaLine.trim(),
  );
});

// ————————————————————————————————————————————————————————————————
// 场景 5：容量治理 —— 满额时先由 LLM 合并相近的两条，合并后仍超上限就按「最少使用」淘汰；
//         被搬走的条目进同目录的 archive.md（reason=evicted / merged），永不物理删除，
//         而手册文件里**永远不再出现 '## 归档区' 章节**（第 33 轮：归档搬进独立文件）。
// ————————————————————————————————————————————————————————————————
test('E2E 场景5｜满额淘汰：被淘汰条目进 archive.md（reason=evicted），手册里永不出现归档区', async () => {
  const file = scenarioDir('e2e-5');
  await writePlaybook(file, [
    // 三条都跟「迁移」无关，且标题彼此不相似（findMergePairs 不会把它们配成对）：
    // 这样淘汰就一定会发生（不靠合并腾位）。
    entry({ id: 'ace-001', title: '提交前先跑 lint', condition: '提交代码前', action: '先跑 lint 再提交', hits: 3, created: daysAgo(30) }),
    entry({ id: 'ace-002', title: '长命令放后台跑', condition: '命令超过一分钟时', action: '用后台作业跑完再收结果', hits: 1, created: daysAgo(20) }),
    entry({ id: 'ace-003', title: '日志里别打印密钥', condition: '要加调试日志时', action: '先把敏感字段脱敏', hits: 0, created: daysAgo(10) }),
  ]);
  const host = makeHost({
    playbookPath: file,
    maxEntries: 3,
    // config.evictProtectDays: 0 = 关掉第 36 轮的新条目保护期，本场景要钉的是**判据本身**
    // （hits 最少的先走）而不是保护期：ace-003 才 10 天大，默认 14 天会把它保护起来。
    // 注意必须放进 config：makeHost 只解构 { playbookPath, script, config, maxEntries }。
    config: { evictProtectDays: 0 },
    script: [[cand('数据库迁移前先备份', '要改数据库结构时', '先导出快照再迁移')], []],
  });
  const agent = makeAgent();

  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => p.entries.length === 3 && hasTitle('数据库迁移前先备份')(p))()
      && logHas(host, '条目落盘（复盘）'),
  });

  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 3, '活跃条目必须收敛回上限 3 条：' + parsed.entries.map((e) => e.id).join(','));
  assert.ok(parsed.entries.some((e) => e.title === '数据库迁移前先备份'), '本轮候选必须正常落盘（绝不被淘汰连坐）');

  // 淘汰判据：hits 最少的先走（ace-003 hits=0）；hits=1 的 ace-002 与 hits=3 的 ace-001 都留下。
  const archived = await readArchived(file);
  assert.deepEqual(archived.map((e) => e.id), ['ace-003'], 'hits 最少的那条该被淘汰');
  assert.equal(archived[0].archive.reason, 'evicted', '淘汰的归档原因必须是 evicted');
  assert.equal(STAMP_RE.test(archived[0].archive.date), true, '归档日期必须是毫秒时间戳：' + archived[0].archive.date);
  assert.equal(archived[0].title, '日志里别打印密钥', '归档里要保留完整正文（永不物理删除）');

  // 手册文件里永远不再出现归档区章节；归档条目只出现在 archive.md。
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(/##\s*归档区/.test(text), false, '手册文件里永远不再出现归档区章节：\n' + text);
  assert.equal(text.includes('### [ace-003]'), false, '被淘汰的条目不该留在活跃区：\n' + text);
  const archiveText = fs.readFileSync(archiveFileOf(file), 'utf8');
  assert.ok(archiveText.includes('### [ace-003]'), '归档条目必须写进 archive.md：\n' + archiveText);
  assert.ok(/-\s*归档：reason=evicted date=/.test(archiveText), '归档行要带 reason 与 date：\n' + archiveText);

  // 永不物理删除：活跃 + 归档 = 原有 3 条 + 本轮新增 1 条。
  const allIds = [...parsed.entries.map((e) => e.id), ...archived.map((e) => e.id)];
  assert.equal(allIds.length, 4, '条目总数对不上（有东西被物理删了）：' + allIds.join(','));
  assert.equal(new Set(allIds).size, allIds.length, '同一条不许同时出现在活跃与归档：' + allIds.join(','));

  // 统计口径与落盘事实一致。
  const res = await callRoute(mountRoutes(host), 'GET', '/api/dsh-ace/stats');
  assert.equal(res.body.runtime.archived, 1);
  assert.equal(res.body.runtime.evicted, 1, '淘汰数要与落盘一致');
  assert.equal(res.body.runtime.archivedByReason.evicted, 1);
});

// ————————————————————————————————————————————————————————————————
// 场景 5b：合并 —— 满额且两条讲同一件事时，先让 LLM 把这一对合成一条：
//         条数降回上限内（不用淘汰）、保留 created 更早那条的 id、另一条进归档 reason=merged。
// ————————————————————————————————————————————————————————————————
test('E2E 场景5b｜满额先合并：LLM 合成一条、保留更早那条的 id、另一条归档 reason=merged', async () => {
  const file = scenarioDir('e2e-5b');
  await writePlaybook(file, [
    entry({ id: 'ace-001', title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移', hits: 2, created: '2026-01-01T00:00:00.000+08:00' }),
    entry({ id: 'ace-002', title: '数据库迁移之前要先备份', condition: '要改数据库结构时', action: '先导出快照再迁移', hits: 1, created: '2026-02-01T00:00:00.000+08:00' }),
  ]);
  // LLM 调用顺序：第 1 次是复盘候选（空数组，逼出 0 候选分支），第 2 次是合并。
  const merged = { title: '数据库迁移前先备份', condition: '当要改数据库结构时', action: '先导出快照再迁移', rationale: '出问题能回滚' };
  // maxEntries 必须 <= 现有条数（2 条手册 + 上限 2 → 「超了」才成立）：上限 2 时 2 > 2 为假，
  // lib/recap-pipeline.js 的 0 候选分支压根不会去试合并。上限 1 才逼出「先合并」这一步。
  const host = makeHost({
    playbookPath: file,
    maxEntries: 1,
    // 字符串 = 供应商原样吐出的裸文本（合并要求顶层四字段）；数组 = 复盘候选批次。
    script: (index) => (index === 0 ? [] : JSON.stringify(merged)),
  });
  const agent = makeAgent();

  // 这一回合复盘产出 0 候选，走的是 lib/recap-pipeline.js 的 runRecapPipeline「0 候选回合仍做容量治理」分支，
  // 它只为腾位而合并、不落候选，所以日志是「合并结果未落盘」而不是「合并成功」——
  // 判据只看盘：合并确实发生了（活跃降到 1 条），而不是看某一行日志。
  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => p.entries.length === 1 && p.entries[0].id === 'ace-001')(),
  });

  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 1, '合并后活跃只剩一条');
  assert.equal(parsed.entries[0].id, 'ace-001', '必须保留 created 更早那条的 id');
  assert.equal(parsed.entries[0].title, merged.title, '正文换成 LLM 合成的四字段');
  assert.equal(parsed.entries[0].meta.hits, 3, '合并后的 hits 取两条之和（2 + 1）');
  const archived = await readArchived(file);
  assert.deepEqual(archived.map((e) => e.id), ['ace-002'], '另一条进归档');
  assert.equal(archived[0].archive.reason, 'merged');
  assert.equal(archived[0].archive.supersededBy, 'ace-001', '归档行要记明被并进了谁');
});
// ————————————————————————————————————————————————————————————————
// 场景 6：注入契约 —— 追加进历史的那条 user 消息里出现「【ACE 自动注入】」，条数 ≤ 5（token 预算默认 500，此处不再断言具体 token）；
//         排序是**纯 BM25 相关度**（同分按 id 数字升序），hits 高低完全不参与排序
//         （第 33 轮：净分与考察位一起删掉，排序键里不再有任何「历史成绩」项，避免自增强陷阱）。
// ————————————————————————————————————————————————————————————————
test('E2E 场景6｜注入块出现、条数与 token 预算符合契约、排序纯 BM25（hits 高低不影响排序）', async () => {
  const file = scenarioDir('e2e-6');
  // 三条**正文完全相同**的相关条目：词面、词频、文档长度都一样 → BM25 分严格相等 →
  // 顺序只能由「同分按 id 数字升序」决定（这正是要钉死的那条判据，别让分数差异替它兜底）。
  const SAME_BODY = { title: '数据库迁移要怎么准备', condition: '要执行数据库迁移时', action: '先全量备份再迁移' };
  await writePlaybook(file, [
    entry({ id: 'ace-001', ...SAME_BODY, hits: 0 }),
    entry({ id: 'ace-002', ...SAME_BODY, hits: 0 }),
    entry({ id: 'ace-003', ...SAME_BODY, hits: 0 }),
    // 跟 query 毫无字面关系的条目，偏偏 hits 最高：它不该因为「历史上用得多」被塞进注入块。
    entry({ id: 'ace-004', title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版', hits: 999 }),
  ]);
  const host = makeHost({ playbookPath: file, script: [[]] });
  const agent = makeAgent();

  const { text, decision } = await injectFor(host, agent, { text: '数据库迁移怎么做' });

  assert.ok(text.includes(INJECTION_MARK), '追加进历史的注入块必须带标记：\n' + text);
  assert.ok(text.startsWith(INJECTION_MARK), '注入消息的正文就是注入块本身（不再拼在系统提示后面）：\n' + text);
  assert.ok(/最多 5 条/.test(text), '注入头必须写明条数上限：' + text.split('\n')[0]);
  assert.equal(/净分|考察位|probation/.test(text), false, '注入文案里不许再出现净分/考察位：\n' + text);

  // 前缀缓存红线：系统提示段是逐字常量，注入绝不许出现在里面。
  const prompt = sectionText(host, agent);
  assert.equal(prompt.includes(INJECTION_MARK), false, '系统提示段里不许出现注入块：\n' + prompt);
  assert.ok(prompt.startsWith('【ACE 操作手册】'), '系统提示段仍是机制说明：\n' + prompt);
  assert.equal(decision.kind, 'enter', 'pre-step 决策仍是 enter');
  assert.equal(decision.startsRequestSeries, true, '重写决策必须保留 startsRequestSeries');

  const ids = [...text.matchAll(/\[(ace-\d+)\]/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, '注入块里出现了重复条目：' + ids.join(','));
  assert.equal(ids.length >= 1 && ids.length <= INJECT_MAX_ENTRIES, true, '注入条数 ' + ids.length + ' 超出 1–' + INJECT_MAX_ENTRIES);
  // 排序只看 BM25：跟 query 无关的 ace-004（hits=999）一分不得、根本不进注入块。
  assert.equal(ids.includes('ace-004'), false, 'hits 高但字面不相关，绝不许被注入：' + ids.join(','));
  assert.equal(ids.includes('ace-001'), true, '相关条目应该被注入：' + ids.join(','));
  // 同分按 id 数字升序：三条正文逐字相同 → BM25 分相等，顺序必须稳定为 id 升序。
  assert.deepEqual(ids, ['ace-001', 'ace-002', 'ace-003'], '注入顺序必须是纯 BM25（同分按 id 升序）：' + ids.join(','));

  const block = text.slice(text.indexOf(INJECTION_MARK));
  assert.equal(estimateTokens(block) <= INJECT_TOKEN_BUDGET, true, '注入块 token ' + estimateTokens(block) + ' 超预算 ' + INJECT_TOKEN_BUDGET);
  assert.ok(logHas(host, '注入已追加进历史'), '注入成功要留一行日志：' + host.record.logs.info.join(' / '));
  assert.ok(logHas(host, '注入批次已发布'), '预检索命中也要留一行批次日志：' + host.record.logs.info.join(' / '));

  // 投递即命中：被追加进历史的那 3 条 hits +1（第 33 轮：hits 是唯一的淘汰依据）。
  // 记账在内存里累加，**回合边界才一次性原子写盘** —— 所以这里必须真跑一个回合边界。
  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => ids.every((id) => p.entries.find((e) => e.id === id)?.meta.hits === 1))(),
  });
  const parsed = readParsed(file);
  for (const id of ids) {
    assert.equal(parsed.entries.find((e) => e.id === id).meta.hits, 1, id + ' 的 hits 应该 +1');
  }
  assert.equal(parsed.entries.find((e) => e.id === 'ace-004').meta.hits, 999, '没被注入的条目 hits 不变');
});

// ————————————————————————————————————————————————————————————————
// 场景 7：整条链路 + GET /api/dsh-ace/stats 的 runtime 六个数字 ——
//         注入 → 命中落盘 → 两轮复盘 → 设置页统计与日志一一对上。
//         第 33 轮：计分与考察位删除后，runtime 只剩「注入 / 检索 / 淘汰 / 合并 / 归档」。
// ————————————————————————————————————————————————————————————————
test('E2E 场景7｜整条链路落盘 + 设置页统计 runtime 七键（六个数字）与日志一致', async () => {
  const file = scenarioDir('e2e-7');
  await writePlaybook(file, [
    entry({ id: 'ace-001', title: '数据库迁移前先备份', condition: '要改数据库结构时', action: '先导出快照再迁移' }),
    entry({ id: 'ace-002', title: '迁移脚本先在影子库试跑', condition: '要执行数据库迁移时', action: '影子库跑通再上生产' }),
    entry({ id: 'ace-003', title: 'CSS 布局一律用 grid', condition: '要写页面布局时', action: '直接用 grid 排版', hits: 7 }),
    // 上面这条与默认 query（'数据库迁移要注意什么'）零字面交集 → BM25 分 0 → 不进注入块、hits 不改。
    // 场景 6 已经用一模一样的夹具钉过这件事（那里是 hits=999），此处只是复用它做统计口径的对账。
  ]);
  const host = makeHost({
    playbookPath: file,
    script: [
      [cand('迁移失败要能一键回滚', '迁移出问题时', '保留旧表并准备好回滚脚本'), cand('迁移前先冻结写入', '要迁移大表时', '先冻结写入再迁')],
      [],
      [cand('迁移后要跑对账脚本', '迁移完成后', '跑一遍行数与金额对账')],
      [],
    ],
  });
  const agent = makeAgent();
  const handler = mountRoutes(host);

  const injected = await injectFor(host, agent);
  assert.ok(injected.tries >= 1);

  await runTurn(host, agent, {
    turn: 2,
    until: () => diskHas(file, (p) => hasTitle('迁移失败要能一键回滚')(p) && hasTitle('迁移前先冻结写入')(p))()
      && logHas(host, '复盘完成 第 1 次') && logHas(host, '条目落盘（复盘）'),
  });
  await runTurn(host, agent, {
    turn: 5,
    until: () => diskHas(file, hasTitle('迁移后要跑对账脚本'))()
      && logHas(host, '复盘完成 第 2 次')
      && host.record.logs.info.filter((m) => m.includes('条目落盘（复盘）')).length >= 2,
  });

  const res = await callRoute(handler, 'GET', '/api/dsh-ace/stats');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.ok, true);
  const runtime = res.body.runtime;
  assert.deepEqual(
    Object.keys(runtime).sort(),
    ['archived', 'archivedByReason', 'evicted', 'injectedAppended', 'injectedBatches', 'merged', 'retrievalHits'],
    '统计接口的 runtime 必须是这七个键（第 33 轮：计分 / 未观测 / 闸门 / 考察位全部删除）',
  );
  assert.deepEqual(
    Object.keys(runtime.archivedByReason).sort(),
    ['evicted', 'merged', 'removed-by-request', 'superseded'],
    '归档数必须能按四种结构性原因分列（第 33 轮：low-score / stale / decayed 随三判据一起删除）',
  );
  // 旧口径一律不许残留：删干净是用户拍板的验收条件。
  for (const gone of ['injected', 'injectedSkipped', 'injectedFailed', 'injectedProbation', 'recaps', 'candidates', 'written', 'helpful', 'harmful', 'unobserved', 'gateRejected']) {
    assert.equal(gone in runtime, false, '旧统计口径 ' + gone + ' 必须已删除');
  }
  assert.equal(runtime.injectedBatches, 1, '一条用户消息 → 一个注入批次');
  assert.equal(runtime.injectedAppended, 1, '这批注入真进了历史一次（同批不重复）');
  assert.equal(runtime.injectedAppended <= runtime.injectedBatches, true, '追加不可能多于批次');
  // 本场景一次定向检索都还没做：注入不是检索，不许记进 retrievalHits。
  assert.equal(runtime.retrievalHits, 0, '自动注入不记检索命中（那是注入追加的口径）');
  // 手册只有 3 条、maxEntries 默认 100，全程没有超额：既不淘汰也不合并。
  assert.equal(runtime.evicted, 0, '没有超额就不该淘汰');
  assert.equal(runtime.merged, 0, '没有超额就不该花 LLM 调用去合并');
  assert.equal(runtime.archived, 0, '没有淘汰/合并/取代，归档文件就该是空的');
  assert.equal(runtime.archivedByReason.evicted, 0);
  assert.equal(runtime.archivedByReason.merged, 0);
  assert.equal(runtime.archivedByReason.superseded, 0);
  assert.equal(runtime.archivedByReason['removed-by-request'], 0);

  // 落盘事实与统计口径一致（统计不是自说自话）。
  const parsed = readParsed(file);
  assert.equal(parsed.entries.length, 6, '原有 3 条 + 3 条新增 = 6 条活跃');
  assert.equal((await readArchived(file)).length, 0, '没有淘汰/合并 → archive.md 里一条都没有');
  // 投递即命中：被追加进历史的那两条 hits 各 +1，没被注入的 ace-003 保持 7。
  const byId = new Map(parsed.entries.map((e) => [e.id, e]));
  assert.equal(byId.get('ace-001').meta.hits, 1, '被注入的 ace-001 该 +1 命中');
  assert.equal(byId.get('ace-002').meta.hits, 1, '被注入的 ace-002 该 +1 命中');
  assert.equal(byId.get('ace-003').meta.hits, 7, '没被注入的 ace-003 命中数不变');
  // 毫秒时间戳：新增条目的 created 是本地时区 ISO，界面展示仍只到日。
  for (const id of ['ace-004', 'ace-005', 'ace-006']) {
    const e = byId.get(id);
    assert.ok(e, '新增条目 ' + id + ' 没有落盘');
    assert.equal(STAMP_RE.test(e.meta.created), true, id + ' 的 created 必须是毫秒时间戳：' + e.meta.created);
    assert.equal(dayOf(e.meta.created), TODAY, id + ' 的 created 日期必须是今天');
  }

  // 手册文件里永远不再出现归档区章节；归档条目只出现在 archive.md。
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(/##\s*归档区/.test(raw), false, '手册文件里绝不许再出现归档区章节');

  // 整本读取（ace_playbook 无参）不含归档条目、也不计数。
  const tool = host.record.tools.find((t) => t.name === 'ace_playbook');
  const whole = await tool.execute({}, { agent });
  assert.equal(whole.entryCount, 6);
  assert.equal(whole.playbook.includes('## 归档区'), false, '整本读取不再附归档区（第 33 轮）');
  const afterWhole = await callRoute(handler, 'GET', '/api/dsh-ace/stats');
  assert.equal(afterWhole.body.runtime.retrievalHits, 0, '整本读取不记检索命中');

  // 定向检索（带 query）才 +1：命中几条就 +几，并且真的落盘到 hits。
  const found = await tool.execute({ query: '数据库迁移' }, { agent });
  assert.equal(found.matched >= 1, true, '带 query 的检索必须命中：' + JSON.stringify(found.matched));
  const afterQuery = await callRoute(handler, 'GET', '/api/dsh-ace/stats');
  assert.equal(afterQuery.body.runtime.retrievalHits, found.matched, '定向检索命中数要如实计入 retrievalHits');
  const afterQueryParsed = readParsed(file);
  const hitIds = [...found.playbook.matchAll(/^### \[(ace-\d+)\]/gm)].map((m) => m[1]);
  assert.equal(hitIds.length >= 1, true, '检索结果里必须有条目');
  for (const id of hitIds) {
    const before = byId.get(id).meta.hits;
    const now = afterQueryParsed.entries.find((e) => e.id === id).meta.hits;
    assert.equal(now, before + 1, id + ' 被定向检索命中后 hits 该 +1（' + before + ' → ' + now + '）');
  }

  // 日志能对上这些数（零成本可观测：页面上的每个数都有一行日志）。
  assert.ok(logHas(host, '复盘完成 第 1 次（2 轮收敛），本轮候选 2 条，累计候选 2 条'), host.record.logs.info.join(' / '));
  assert.ok(logHas(host, '复盘完成 第 2 次'), '第二次复盘没有记账');
  assert.ok(logHas(host, '条目落盘（复盘）新增 2 条、更新 0 条'), host.record.logs.info.join(' / '));
  assert.equal(warnHas(host, '未知归档原因'), false, '归档原因不该出现未知值');
  assert.equal(logHas(host, '计分'), false, '日志里不许再出现计分（第 33 轮已整层删除）');
});


test.after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});
