// 接线测试（P0-7）：**真 import** lib/index.js 并真调一次 apply()。
//
// 为什么单开一个文件：本仓库不带 node_modules（见 tests/entries.test.mjs:6-8），lib/index.js 顶层
// import 了三个宿主包（@deepseek-ai/schemastery、dsh-tools、dsh-llm；曾经的 dsh-timeout 已随孤儿
// import 一起删除，见 lib/index.js:69），别的测试文件因此都只测「被 index.js 调用的纯逻辑模块」，
// 从没有一行代码真正加载过 index.js。
// 后果：index.js 里「引用了但没定义」的标识符（P0-7：noteArchived / noteWritten）能一路溜到线上，
// 直到 e2e 子代理用桩宿主包真 import 才被抓到。
//
// 这里的做法：node:module 的 registerHooks 把三个宿主包重定向到临时目录里的**最小桩**
// （只实现本插件真正用到的那几个成员，见下方 STUBS），然后动态 import lib/index.js，
// 再用一个假 ctx 真调 apply()。断言全部落在「行为」上：注册了什么、execute 真跑一遍返回什么、
// /stats 路由的 runtime 数字对不对 —— 不是对源码做正则。
//
// 硬约束：全程在临时目录里跑，不读也不写真实手册（C:\Users\<user>\.dsh\ace\playbook.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
// 直接读手册文件做断言（纯逻辑模块，不依赖宿主包；静态 import 不会绕过上面的桩）。
import { parsePlaybook, serializePlaybook, withExclusiveLock, writeFileAtomic, overflowsCapacity } from '../lib/playbook.js';
import { dayString } from '../lib/archive.js';
import { readArchiveSnapshot } from '../lib/archive-file.js';
import { resolveMaxEntries } from '../lib/recap-pipeline.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ace-wiring-'));
const STUB_ROOT = path.join(ROOT, 'host-stubs');
const HOME_DIR = path.join(ROOT, 'dsh-home');
const PROFILE_DIR = path.join(ROOT, 'profile');

/** 宿主包的最小桩：只实现 lib/index.js 真正用到的那几个导出。 */
const STUBS = {
  schemastery: [
    '// 最小 schemastery 桩：只够 Config 声明（z.string/boolean/number/object + description/default）。',
    'function builder(kind) {',
    '  const b = { type: kind };',
    '  b.description = () => b;',
    '  b.default = (v) => { b.defaultValue = v; return b; };',
    '  b.optional = () => b;',
    '  return b;',
    '}',
    'const z = {',
    "  string: () => builder('string'),",
    "  boolean: () => builder('boolean'),",
    "  number: () => builder('number'),",
    "  object: (fields) => ({ type: 'object', fields }),",
    '};',
    'export default z;',
  ].join('\n'),
  'dsh-tools': [
    '// 最小 dsh-tools 桩：defineTool 只做形状校验并把定义原样返回（真实现做的事见 ~\\dsh-tools\\lib\\types\\schema.d.ts:248）。',
    'export function defineTool(def) {',
    "  if (!def || typeof def !== 'object') throw new TypeError('defineTool: def 必须是对象');",
    "  if (typeof def.name !== 'string' || !def.name) throw new TypeError('defineTool: name 必填');",
    "  if (typeof def.execute !== 'function') throw new TypeError('defineTool: execute 必填');",
    '  return def;',
    '}',
    'export default { defineTool };',
  ].join('\n'),
  'dsh-llm': [
    '// 最小 dsh-llm 桩：createUserMessage 只保证 content 是 ContentBlock[]（~\dsh-llm\lib\types\message.d.ts:128）。',
    'export function createUserMessage(input) {',
    "  const content = Array.isArray(input?.content) ? input.content : [];",
    "  const message = { role: 'user', content };",
    '  if (input && typeof input.summary === "string") message.summary = input.summary;',
    '  // noticeMessage 把摘要放在 source.summary 里（lib/notice.js:51-59），真宿主会原样带上。',
    '  if (input && input.source && typeof input.source === "object") message.source = input.source;',
    '  return message;',
    '}',
    'export default { createUserMessage };',
  ].join('\n'),
};

for (const [name, source] of Object.entries(STUBS)) {
  const dir = path.join(STUB_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), source + '\n', 'utf8');
}
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// 环境变量必须在 import 之前钉好：apply() 里的设置迁移会读 $DSH_PROFILE_DIR / $DSH_HOME。
// 不钉住的话会去读真实用户目录里的 dsh-ace.json。
process.env.DSH_HOME = HOME_DIR;
process.env.DSH_PROFILE_DIR = PROFILE_DIR;

// 重定向只认 @deepseek-ai/<包名>（本插件只 import 这四个），其余解析原样交给 Node。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      const name = specifier.slice('@deepseek-ai/'.length);
      const stub = path.join(STUB_ROOT, name, 'index.js');
      if (fs.existsSync(stub)) return nextResolve(pathToFileURL(stub).href, context);
    }
    return nextResolve(specifier, context);
  },
});

// 测试文件自己的目录（Windows 上 pathname 形如 /D:/...，要先剥掉前导斜杠）。
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const INDEX_FILE = path.join(HERE, '..', 'lib', 'index.js');

// 真 import：这一行就是 P0-7 的判据 —— index.js 顶层任何解析失败 / 引用未定义都会当场抛。
const plugin = await import(pathToFileURL(INDEX_FILE).href);

/** 用例之间共享的 apply 结果（同一进程、同一份插件状态）。 */
const state = {};

/** 造一个假 agent：只实现本插件真正调到的成员。 */
function fakeAgent() {
  // followup 必须把 message 收下来：冲突通知（reportConflicts → sendNotice）唯一的出口就是它，
  // 丢掉的话「冲突被拦下但用户永远收不到通知」这种接线断点测不出来。
  const notices = [];
  return {
    session: {
      requestHeader: () => ({ config: { provider: 'stub-provider', model: 'stub-model' } }),
      deriveMessages: () => [],
    },
    options: { provider: 'stub-provider', model: 'stub-model' },
    runMaintenance: async (fn) => fn(new AbortController().signal),
    followup: (message) => { notices.push(message); },
    notices,
  };
}

/** 造一个假 ctx，记录 apply() 做的每一次注册。 */
function fakeCtx(llmStream) {
  const record = {
    tools: [],
    sections: [],
    handlers: [],
    commands: [],
    injected: [],
    logs: { info: [], warn: [], error: [] },
  };
  const logger = {
    info: (m) => record.logs.info.push(String(m)),
    warn: (m) => record.logs.warn.push(String(m)),
    error: (m) => record.logs.error.push(String(m)),
    debug: () => {},
  };
  const ctx = {
    logger,
    tools: { register: (def) => record.tools.push(def) },
    systemPrompt: { section: (spec) => record.sections.push(spec) },
    on: (event, handler) => record.handlers.push({ event, handler }),
    commands: { register: (def) => record.commands.push(def) },
    get: (name) => (name === 'profileContext' ? { dir: PROFILE_DIR, home: HOME_DIR } : undefined),
    llm: { stream: llmStream },
    workingDirectory: { ensure: async () => ROOT },
    inject: (deps, callback) => record.injected.push({ deps, callback }),
  };
  return { ctx, record };
}

/**
 * 按 Config schema 解析出默认配置。
 * 真宿主会用 @deepseek-ai/schemastery 把缺省字段填好再交给 apply()；这里的桩只把
 * .default(v) 记在 defaultValue 上，所以要自己走一遍 —— 否则 apply(ctx, {}) 拿到的是
 * 一堆 undefined，autoRecap/autoReflect 都是 falsy，系统提示段直接返回空串。
 */
function configDefaults() {
  const out = {};
  for (const [key, field] of Object.entries(plugin.Config.fields)) {
    if (field && 'defaultValue' in field) out[key] = field.defaultValue;
  }
  return out;
}

/** 造一个假 req/res，把 HTTP 路由真的打一发（handler 是 lib/index.js 里注册的那个）。 */
async function callRoute(handler, method, urlPath) {
  const req = {
    method,
    url: urlPath,
    headers: { host: '127.0.0.1:3080' },
    on: (event, cb) => { if (event === 'end') cb(); return req; },
    destroy: () => {},
  };
  const res = {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body === undefined ? undefined : JSON.parse(res.body) };
}

// —— 静态求差扫描器（用例⑦ 用；纯手写，无依赖）——
// 用来抓「被调用但无处定义」的标识符（P0-7 的形态）。判据与盲区见用例⑦ 的注释。

/** JS 关键字 / 不是标识符的保留词：出现在 `name(` 位置时不算调用。 */
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'yield', 'delete', 'void', 'in', 'of', 'case', 'do', 'else', 'try', 'finally', 'throw', 'instanceof', 'super', 'import', 'export', 'class', 'const', 'let', 'var', 'with', 'default', 'break', 'continue', 'this', 'async', 'static', 'get', 'set', 'extends', 'debugger']);

/** Node / 语言内置的全局函数与构造器：不在文件里定义也合法。 */
const GLOBAL_CALLS = new Set(['Object', 'Array', 'String', 'Number', 'Boolean', 'Function', 'Promise', 'Symbol', 'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'Reflect', 'Proxy', 'BigInt', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'console', 'process', 'Buffer', 'globalThis', 'undefined', 'NaN', 'Infinity']);

/**
 * 去掉注释与字符串/模板字面量（字符串位置统一换成 `""`），只留下「结构性」代码。
 * 否则注释里的中文、字符串里的 `foo(` 会污染后面的扫描。
 */
/**
 * `/` 出现在这里时是**正则字面量的开头**而不是除号？
 * 判据：上一个有意义字符是「表达式还没写完」的那类（运算符、开括号、逗号、分号……），
 * 或者上一个词是 `return` / `typeof` / `case` 这类后面必跟表达式的关键字。
 * 这只是扫描器的辅助工具，宁可把 `/` 当除法（少 strip 一段）也不许把代码当真则抹掉。
 */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'case', 'yield', 'await', 'in']);

function regexCanStartAfter(out) {
  const tail = out.replace(/\s+$/, '');
  if (!tail) return true;
  const last = tail[tail.length - 1];
  if (REGEX_PRECEDERS.has(last)) return true;
  const word = (tail.match(/([A-Za-z_$][\w$]*)$/) || [])[1];
  return Boolean(word && REGEX_KEYWORDS.has(word));
}

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    // 正则字面量：里面的 `foo(` 是**字面量内容**，不是调用（review6 §3.1 通道 O 的误报）。
    // 必须在除号分支之前判掉：`a / b` 的 `/` 上一个字符是标识符，regexCanStartAfter 会说不。
    // `//` 与 `/*` 一定是注释放，绝不能进正则试探（否则 `//…` 会被当成一个空正则，
    // 整行注释的正文留在 out 里变成「代码」—— 实测 lib/index.js:1087 的注释就因此漏出的 `trim(` 误报）。
    if (ch === '/' && nx !== '/' && nx !== '*' && regexCanStartAfter(out)) {
      // 先只**试探**到配对的 `/`：找到了才当正则抹掉。没找到、或者中途撞上
      // `;` `{` `}` 换行（那时它更像除号）就退回普通字符，免得把整份代码吞进一个假正则。
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '\n' || c === ';' || c === '{' || c === '}') break;
        if (c === '\\') { j += 2; continue; }
        if (c === '[') { inClass = true; j++; continue; }
        if (c === ']') { inClass = false; j++; continue; }
        if (!inClass && c === '/') { closed = true; break; }
        j++;
      }
      if (closed) { out += ' "" '; i = j + 1; continue; }
    }
    if (ch === '/' && nx === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; out += ' '; continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === ch) { i++; break; } i++; }
      out += '""'; continue;
    }
    if (ch === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { i++; break; }
        // 模板里的 ${...} 是**代码**，不是字符串：整段抹掉会让里面的裸调用假绿（P2-4 通道②）。
        // 做法：把 ${ 到配对的 } 之间的内容递归走一遍 strip（内部的字符串/注释照常处理），
        // 结果以空格包围拼回 out —— 结构代码保留，字面量部分照旧换成 ""。
        if (src[i] === '$' && src[i + 1] === '{') {
          const start = i + 2;
          let depth = 1;
          let j = start;
          while (j < n && depth > 0) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '{') { depth++; j++; continue; }
            if (src[j] === '}') { depth--; if (depth === 0) break; j++; continue; }
            if (src[j] === '"' || src[j] === "'" || src[j] === '`') {
              const q = src[j];
              j++;
              while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) { j++; break; } j++; }
              continue;
            }
            j++;
          }
          out += ' ' + stripCommentsAndStrings(src.slice(start, j)) + ' ';
          i = j + 1;
          continue;
        }
        i++;
      }
      out += '""'; continue;
    }
    out += ch; i++;
  }
  return out;
}

/** 取出一段文本里所有标识符形态的词。 */
function identifiersIn(text) {
  return text.match(/[A-Za-z_$][\w$]*/g) || [];
}

/**
 * 收集「已知名字」：import 子句 / function|const|let|var|class 声明 / 解构声明 / 所有形参表。
 * 形参表取全文件并集是刻意的「宁可放过不可误报」—— 代价是盲区，写进用例注释。
 */
function declaredNames(code) {
  const names = new Set();
  let m;
  const importRe = /import\s+([^;]*?)\s+from\s+['"][^'"]*['"]/g;
  while ((m = importRe.exec(code))) {
    for (const tok of identifiersIn(m[1])) {
      if (tok === 'as' || tok === 'default') continue;
      names.add(tok);
    }
  }
  const bareImportRe = /import\s+([A-Za-z_$][\w$]*)\s+from/g;
  while ((m = bareImportRe.exec(code))) names.add(m[1]);
  const declRe = /\b(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(code))) names.add(m[1]);
  const destrRe = /\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]\s*=/g;
  while ((m = destrRe.exec(code))) {
    for (const tok of identifiersIn(m[1])) names.add(tok);
  }
  const fnHeadRe = /([A-Za-z_$][\w$]*)?\s*\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = fnHeadRe.exec(code))) {
    // 控制流关键字的括号里是**表达式**，不是形参表：`if (noteDeleted) {…}` 不许把 noteDeleted
    // 收成「已知名字」（P2-4 通道③④：if 守卫与 catch 形参都靠这一行挡住）。
    if (m[1] && NOT_CALLS.has(m[1])) continue;
    for (const tok of identifiersIn(m[2])) names.add(tok);
  }
  return names;
}

/** 返回「被裸调用但不在已知名字/关键字/全局白名单里」的标识符（升序）。 */
function findUnknownIdentifiers(rawSource) {
  const code = stripCommentsAndStrings(rawSource);
  const known = declaredNames(code);
  const unknown = new Set();
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callRe.exec(code))) {
    const name = m[1];
    const prevChar = (code.slice(0, m.index).match(/\S(?=\s*$)/) || [''])[0];
    // 只跳过成员调用（obj.name(…)）。'?' 后面紧跟「标识符 + 括号」是**三元右支**
    // （cond ? call(…) : …），那是真调用（P2-4 通道①）；可选调用 obj?.(…) 的 '(' 前面没有标识符，
    // callRe 根本不会匹配到它，所以去掉 ? 判断不会误报可选调用。
    if (prevChar === '.') continue;
    if (NOT_CALLS.has(name) || GLOBAL_CALLS.has(name) || known.has(name)) continue;
    // 函数定义头（name(...) 后面紧跟 {）不是调用
    let depth = 0;
    let closed = -1;
    for (let j = m.index + name.length; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') { depth--; if (depth === 0) { closed = j; break; } }
    }
    if (closed >= 0) {
      const after = code.slice(closed + 1).match(/^\s*(.)/);
      if (after && after[1] === '{') continue;
    }
    unknown.add(name);
  }
  // 逗号表达式间接调用 `(0, noteDeleted)(1)`：`noteDeleted` 后面跟的是 `)` 而不是 `(`，
  // 上面的 callRe 抓不到（review6 §3.1 通道 N）。这里补一条：括号里顶层有逗号、且右括号紧跟
  // 左括号 —— 取最后一段末尾的标识符，再走同样的关键字/全局/已知名字过滤。
  // 判据刻意只认「最外层括号」，因此 `f(a, g)(1)` 这种先调用的写法不会被误当成 `g` 被间接调用。
  const sequenceRe = /\(([^()]*)\)\s*\(/g;
  while ((m = sequenceRe.exec(code))) {
    const inner = m[1];
    const comma = inner.lastIndexOf(',');
    if (comma < 0) continue;
    const tail = inner.slice(comma + 1).trim();
    const tailName = (tail.match(/([A-Za-z_$][\w$]*)$/) || [])[1];
    if (!tailName) continue;
    // `(0, obj.fn)(…)` 仍然是成员调用，不许报
    if (tail.slice(0, tail.length - tailName.length).trim().endsWith('.')) continue;
    if (NOT_CALLS.has(tailName) || GLOBAL_CALLS.has(tailName) || known.has(tailName)) continue;
    unknown.add(tailName);
  }
  return [...unknown].sort();
}

test('P0-7｜lib/index.js 真 import 成功，导出入口契约 { name, inject, apply, Config }', () => {
  assert.equal(plugin.name, 'dsh-ace');
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'llm', 'workingDirectory', 'commands']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.Config, 'object');
  assert.equal(plugin.Config.type, 'object');
  // 第 36 轮加了三个可调项（evictProtectDays / injectTokenBudget / injectMaxEntries）→ 9 + 3 = 12。
  assert.equal(Object.keys(plugin.Config.fields).length, 12, 'Config 十二个字段');
  for (const key of ['playbookPath', 'autoReflect', 'reflectProvider', 'reflectModel', 'maxEntries', 'evictProtectDays', 'injectTokenBudget', 'injectMaxEntries', 'autoRecap', 'autoRecapThreshold', 'autoRecapCooldownTurns', 'autoReviewInbox']) {
    assert.ok(plugin.Config.fields[key], 'Config 缺字段 ' + key);
  }
});

test('P0-7｜apply() 真跑一次不抛：注册 3 个工具 / 1 段系统提示 / 5 个事件 / 1 个命令 / 1 次 webServer 注入', async () => {
  // LLM 桩：第一轮返回 1 条候选，之后返回空数组（reflectRounds 以空数组为收敛判据）。
  // 候选正文故意与后面 ace_curate 手写的那条不同 —— 否则复盘会判成「同一条无需改动」，
  // 落盘数为 0，/stats 的数字就测不出东西。
  let llmCalls = 0;
  const llmStream = async function* () {
    llmCalls += 1;
    const payload = llmCalls === 1
      // 第 33 轮起唯一的候选过滤判据是「标题非空」（三层可复用性闸门已删）。
      // 本用例要验的是「复盘真的落盘」，所以候选写成真实 Reflector 的产出形状。
      ? { candidates: [{ title: '复盘产出的候选要真落盘', condition: '要验证自动复盘链路时', action: '把候选写进手册再看盘上文件', rationale: 'recap 链路必须真落盘' }], notes: '' }
      : { candidates: [], notes: '已收敛' };
    yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) };
  };
  const { ctx, record } = fakeCtx(llmStream);
  const config = configDefaults();
  assert.equal(config.autoRecap, true, 'Config 默认开自动复盘');
  assert.equal(config.autoReflect, true, 'Config 默认开手动复盘提示');
  assert.equal(config.maxEntries, 100);

  // apply 是同步注册，但启动时 void 了一个异步读 inbox；给它一个微任务让那次读跑完。
  assert.doesNotThrow(() => plugin.apply(ctx, config));
  await new Promise((r) => setTimeout(r, 20));

  // 先把手柄交出去：下面的断言即使失败，后面的用例也能给出更具体的失败点。
  state.ctx = ctx;
  state.record = record;
  state.agent = fakeAgent();

  assert.deepEqual(record.tools.map((t) => t.name).sort(), ['ace_curate', 'ace_playbook', 'ace_reflect']);
  for (const tool of record.tools) assert.equal(typeof tool.execute, 'function', tool.name + ' 缺 execute');

  assert.equal(record.sections.length, 1, '只注册一段系统提示');
  const section = record.sections[0];
  assert.equal(section.name, 'ace-playbook');
  assert.equal(section.order, 860);
  assert.equal(section.interpolate, false, 'P0-3：section 必须 interpolate:false');
  assert.equal(typeof section.text, 'function');

  assert.deepEqual(
    record.handlers.map((h) => h.event),
    // 第 33 轮：agent/error 监听已随「回合成败判定」整层删除（不再有未观测态要收）。
    ['tools/result', 'agent/turn-stopping', 'agent/status', 'agent/inbox/inserted', 'agent/pre-step'],
    'agent/pre-step 是第 28 轮新增的注入投递接缝（注入只许追加进历史）',
  );
  assert.deepEqual(record.commands.map((c) => c.name), ['ace']);
  assert.deepEqual(record.injected.map((i) => i.deps), [['webServer']]);

  // 系统提示段的 text 回调：同步求值一次，必须给出人可读文本且绝不抛错。
  const text = section.text({ scope: fakeAgent() });
  assert.equal(typeof text, 'string');
  assert.ok(text.startsWith('【ACE 操作手册】'), '提示段正文格式');
  assert.ok(!text.includes('{{'), 'P0-3 双保险：渲染结果里不许留 {{');
});

test('P0-7｜ace_playbook.execute 真读手册（共享层落在临时 DSH home，不碰真实手册）', async () => {
  const tool = state.record.tools.find((t) => t.name === 'ace_playbook');
  const value = await tool.execute({}, { agent: state.agent });
  assert.equal(value.path, path.join(HOME_DIR, 'ace', 'playbook.md'), '共享层路径必须落在临时 home 里');
  assert.equal(typeof value.playbook, 'string');
  assert.equal(value.entryCount, 0, '新手册 0 条');
  assert.ok(fs.existsSync(value.path), '首次读取会初始化手册文件');
});

test('P0-7｜ace_curate.execute 真落盘：noteWritten 写日志、noteArchived 记账（P0-7 的两处未定义标识符）', async () => {
  const tool = state.record.tools.find((t) => t.name === 'ace_curate');
  const value = await tool.execute({
    // 第 33 轮起候选只过一条判据：标题 trim 后非空（三层可复用性闸门整份删除）。
    ops: [{
      op: 'add',
      title: '接线经验要真落盘',
      condition: '真 import 插件并跑 apply 时',
      action: '断言 apply 不抛错并检查注册清单',
      rationale: 'P0-7 就是这样被抓到的',
    }],
  }, { agent: state.agent });
  assert.equal(value.added.length, 1);
  assert.equal(value.entryCount, 1);
  assert.ok(
    state.record.logs.info.some((m) => m.includes('条目落盘（ace_curate）新增 1 条')),
    'noteWritten 必须真被调用（改动前这里抛 ReferenceError: noteWritten is not defined）',
  );
  assert.ok(
    !state.record.logs.warn.some((m) => m.includes('未知归档原因')),
    'noteArchived 对已知原因不该 warn',
  );

  // 手册文件真的写进去了（走锁 + 原子写）
  const text = fs.readFileSync(path.join(HOME_DIR, 'ace', 'playbook.md'), 'utf8');
  assert.ok(text.includes('### [ace-001] 接线经验'));
});

test('P0-7｜/ace 命令真跑 executeRecap 全链（deps 对象逐个成员都被用到）', async () => {
  const command = state.record.commands.find((c) => c.name === 'ace');
  assert.equal(typeof command.handler, 'function');
  const result = await command.handler({ agent: state.agent, rawInput: '' });
  assert.equal(result.kind, 'success', '命令必须返回 CommandResult（不许把异常漏出去）：' + JSON.stringify(result));
  assert.match(result.text, /复盘完成/);
  // 复盘路径同样走 noteWritten（source='复盘'）
  assert.ok(
    state.record.logs.info.some((m) => m.includes('条目落盘（复盘）')),
    'executeRecap 的 deps.noteWritten 必须接上',
  );
  assert.ok(
    state.record.logs.info.some((m) => m.includes('复盘完成 第 1 次')),
    'recapStats 必须被真累加',
  );
});

test('P0-7｜GET /api/dsh-ace/stats 真打一发：runtime 数字与前面几次写入对得上', async () => {
  const { callback } = state.record.injected.find((i) => i.deps.includes('webServer'));
  const routes = [];
  const scoped = {
    webServer: { register: (route) => routes.push(route) },
    effect: (fn) => fn(),
    logger: state.ctx.logger,
  };
  callback(scoped);
  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, '/api/dsh-ace');

  const { status, body } = await callRoute(route.handler, 'GET', '/api/dsh-ace/stats');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(typeof body.runtime, 'object');
  // runtime 各项（见 lib/index.js 的 runtimeSnapshot）：第 33 轮起是六个数字 + 四原因分列。
  // 口径：注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数。
  assert.deepEqual(
    Object.keys(body.runtime).sort(),
    ['archived', 'archivedByReason', 'evicted', 'injectedAppended', 'injectedBatches', 'merged', 'retrievalHits'],
    'runtime 只剩七键（六个数 + 四原因分列）',
  );
  assert.equal(body.runtime.archived, 0, '本轮没有任何归档');
  assert.deepEqual(body.runtime.archivedByReason, { superseded: 0, 'removed-by-request': 0, evicted: 0, merged: 0 }, '归档按四种结构性原因分列');
  assert.equal(body.runtime.evicted, 0, '淘汰数直接读 byReason.evicted（同一份真相）');
  assert.equal(body.runtime.merged, 0, '合并数直接读 byReason.merged（同一份真相）');
  // 第 28 轮口径：注入拆成「批次」与「追加进历史」两个数（旧的 injected 数的是系统提示重渲染次数≈步数）。
  assert.equal(typeof body.runtime.injectedBatches, 'number', '注入批次：每收到一条新消息挑一次经验');
  assert.equal(typeof body.runtime.injectedAppended, 'number', '追加进历史：这批经验真进了历史一次');
  assert.equal(body.runtime.injectedBatches, 0, '本轮没有任何用户消息进来，不该有批次');
  assert.equal(body.runtime.injectedAppended, 0, '没有批次就谈不上追加');
  // 检索命中：只有带 id / query 的定向检索才计数，本轮没查过 → 0。
  assert.equal(body.runtime.retrievalHits, 0, '本轮没有定向检索，检索命中应为 0');
  // 旧口径一个都不许留（计分整层删除，两套口径并存会让页面读错数）。
  for (const gone of ['injected', 'recaps', 'candidates', 'written', 'helpful', 'harmful', 'unobserved', 'gateRejected', 'injectedSkipped', 'injectedFailed', 'injectedProbation']) {
    assert.equal(gone in body.runtime, false, '旧口径 ' + gone + ' 已删除');
  }

  // 非 GET 走 405，围栏不放松
  const notAllowed = await callRoute(route.handler, 'PUT', '/api/dsh-ace/stats');
  assert.equal(notAllowed.status, 405);
});

test('b｜ace_playbook 命中计数：只有带 query / id 的定向查找 +1，整本读取一次都不计', async () => {
  // 第 33 轮：hits 是**唯一的淘汰依据**，所以「什么算用过一条经验」必须钉死 ——
  // 定向查找（带 query 或 id）= 真的用上了某条；整本读取 = 翻目录，不许计数。
  // 这里走真工具 + 真手册 + 真锁/原子写，数字一律从 /api/dsh-ace/stats 的 runtime 读，不靠猜。
  const { callback } = state.record.injected.find((i) => i.deps.includes('webServer'));
  const routes = [];
  callback({ webServer: { register: (r) => routes.push(r) }, effect: (fn) => fn(), logger: state.ctx.logger });
  const route = routes[0];
  const runtimeNow = async () => (await callRoute(route.handler, 'GET', '/api/dsh-ace/stats')).body.runtime;

  const curate = state.record.tools.find((t) => t.name === 'ace_curate');
  const added = await curate.execute({
    ops: [{
      op: 'add',
      title: 'zzzz 检索专项技巧',
      condition: '当需要检索专项时',
      action: '照做检索专项这一步',
      rationale: 'b 用例的夹具条目，用来量命中计数',
    }],
  }, { agent: state.agent });
  const id = added.added[0];
  assert.match(id, /^ace-\d+$/, '新增条目要有编号');

  const playbook = state.record.tools.find((t) => t.name === 'ace_playbook');
  const hitsOf = (rid) => {
    const parsed = parsePlaybook(fs.readFileSync(path.join(HOME_DIR, 'ace', 'playbook.md'), 'utf8'));
    const found = parsed.entries.find((e) => e.id === rid);
    return found ? found.meta.hits : null;
  };
  const before = await runtimeNow();

  // ① 整本读取（不带参数）：条目照常返回，但一次都不许记 hits、不许记检索命中。
  const whole = await playbook.execute({}, { agent: state.agent });
  assert.ok(whole.entryCount >= 1, '整本读取要返回全部条目：' + whole.entryCount);
  assert.equal(hitsOf(id), 0, '整本读取不计数（否则 hits 会退化成「手册被打开过几次」）');
  const afterWhole = await runtimeNow();
  assert.equal(afterWhole.retrievalHits, before.retrievalHits, '整本读取不许增加检索命中');

  // ② 带 query 的定向查找：命中几条就记几条，被命中的条目 hits +1。
  const found = await playbook.execute({ query: '检索专项' }, { agent: state.agent });
  assert.equal(found.matched, 1, 'query 只该命中夹具那一条：' + JSON.stringify([found.entryCount, found.matched]));
  assert.equal(hitsOf(id), 1, '定向检索命中一次 → hits +1');
  const afterQuery = await runtimeNow();
  assert.equal(afterQuery.retrievalHits, before.retrievalHits + found.matched, '检索命中数如实计入 runtime.retrievalHits');

  // ③ 带 id 的定向查找：同样 +1。
  const one = await playbook.execute({ id }, { agent: state.agent });
  assert.equal(one.matched, 1);
  assert.equal(hitsOf(id), 2, '按 id 查一次 → hits 再 +1');
  const afterId = await runtimeNow();
  assert.equal(afterId.retrievalHits, afterQuery.retrievalHits + 1, 'id 查找也算一次检索命中');

  // ④ lastHit 是毫秒精度本地时区 ISO，且写的是「现在」的日期。
  const meta = parsePlaybook(fs.readFileSync(path.join(HOME_DIR, 'ace', 'playbook.md'), 'utf8')).entries.find((e) => e.id === id).meta;
  assert.match(meta.lastHit, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/, 'lastHit 必须是毫秒时间戳：' + meta.lastHit);
  assert.equal(meta.lastHit.slice(0, 10), dayString().slice(0, 10), 'lastHit 的日期部分该是今天');
});

test('P0-7｜静态求差：index.js 里每个被「裸调用」的标识符都有定义 / import / 形参 / 全局兜底', async () => {
  // 判据：把源码去掉注释与字符串后，扫出所有「裸调用」形态 `name(...)`（排除成员调用 obj.name(...)、
  // 关键字、全局白名单、函数定义头 `function name(...) {`），再核这个名字是否在下面四类「已知名字」里：
  //   ① import 子句里出现的标识符  ② function/const/let/var/class 声明
  //   ③ 解构声明里的标识符          ④ 所有形参表里的标识符（宁可放过不可误报）
  // 剩下的就是「被调用但无处定义」的名字 —— P0-7 的 noteArchived / noteWritten 正是这一类。
  //
  // 为什么不用 new Function(source)：它只查语法，对未定义标识符零覆盖
  // （new Function('totallyUndefinedFn(); return 1;') 不会抛）。
  // 为什么不用正则找 'function noteArchived('：等价改写（const noteArchived = (list) => {…}）会假红，
  // 而新冒出来的未定义 noteDeleted(...) 照样绿。
  //
  // 已知盲区（写在这里，别指望它查）：
  //   - 只查「裸调用」形态；纯引用不调用的未定义变量（return foo;）、对象属性名、正则字面量内容不查；
  //   - 形参名取「全文件并集」，宁可放过：某函数体里误用了另一个函数的形参名不会被抓到；
  //   - 只对 lib/index.js 生效，其它模块的同类别缺陷要靠各自的用例。
  // 真正的覆盖仍来自上面 6 条真跑用例（真 import + 真调 apply/工具/命令/路由）。

  // 先用四段人造样本钉住扫描器自己的判据（否则它可能退化成「永远返回 []」的永真断言）。
  assert.deepEqual(findUnknownIdentifiers('export function a(x) { return x; } a(1);'), [], '正常定义+调用不该报');
  assert.deepEqual(
    findUnknownIdentifiers('function noteArchived(list) { return list.length; } noteArchived(1);'),
    [],
    'function 声明形态',
  );
  assert.deepEqual(
    findUnknownIdentifiers('const noteArchived = (list) => list.length; noteArchived(1);'),
    [],
    '等价改写 const x = (...) => 不许假红',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a() { noteArchived([1]); } a();'),
    ['noteArchived'],
    '被调用但无处定义 → 必须报出来（P0-7 的形态）',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a(list) { noteDeleted(list); } a(1);'),
    ['noteDeleted'],
    '新冒出来的未定义调用 → 必须报出来',
  );
  assert.deepEqual(findUnknownIdentifiers('const o = { f() { return 1; } }; o.f();'), [], '对象方法不算裸调用');
  // —— 四条「假绿通道」（P2-4）：这些形态以前会被扫描器悄悄放过，于是「真文件 === []」这条断言
  // 就成了永真的假证据。每条各钉一个人造样本，判据改成「必须报出 noteDeleted」，再断言真文件为空。
  //   ① 三元右支：`flag ? noteDeleted(1) : 2` 曾是 prevChar==='?' 被当可选调用跳过；
  //   ② 模板插值：模板字面量整段被抹成 ""，`${...}` 里的调用一起消失；
  //   ③ catch 形参：`catch (noteDeleted)` 的形参进了「全文件形参并集」，别处的裸调用被放过；
  //   ④ if 守卫：`if (noteDeleted) {…}` 的括号被当成形参表，同样污染并集。
  assert.deepEqual(
    findUnknownIdentifiers('function a(flag) { const v = flag ? noteDeleted(1) : 2; return v; } a(1);'),
    ['noteDeleted'],
    '通道①三元右支：cond ? call(…) 是真调用，不许被当成可选调用跳过',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a() { const v = `x${noteDeleted(1)}y`; return v; } a();'),
    ['noteDeleted'],
    '通道②模板插值：${…} 里是代码，整段抹掉等于放过它',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a(n) { return `hello ${n} world`; } a(1);'),
    [],
    '通道②的反面：模板插值里只有普通引用时不许假红',
  );
  assert.deepEqual(
    findUnknownIdentifiers(
      'function a() { try { b(); } catch (noteDeleted) { } } function b() {} function c() { noteDeleted(1); } a(); c();',
    ),
    ['noteDeleted'],
    '通道③catch 形参：catch 的形参不许进全文件并集',
  );
  assert.deepEqual(
    findUnknownIdentifiers(
      'function a(v) { if (noteDeleted) { b(); } } function b() {} function c() { noteDeleted(1); } a(1); c();',
    ),
    ['noteDeleted'],
    '通道④if 守卫：if 的括号里是表达式、不是形参表',
  );
  assert.deepEqual(findUnknownIdentifiers('function a(o) { o?.(1); } a({});'), [], '可选调用 obj?.(…) 不算裸调用（去掉 ? 判断后的回归位）');
  assert.deepEqual(findUnknownIdentifiers('const f = (x) => x(1); f((v) => v);'), [], '箭头函数形参照旧算已知名字');
  // —— 两条「判据通道」（P2-b，review6 §3.1）——
  //   N 逗号表达式间接调用：(0, noteDeleted)(1) 的标识符后面跟的是 ')' 不是 '('，老 callRe 抓不到；
  //   O 正则字面量：/foo(/ 里的 'noteDeleted(' 是**字面量内容**，不许报成裸调用。
  assert.deepEqual(
    findUnknownIdentifiers('function a() { return (0, noteDeleted)(1); } a();'),
    ['noteDeleted'],
    '通道N 逗号表达式间接调用：(0, fn)(…) 也是调用，漏了它就是假绿',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a() { return (0, b)(1); } function b(v) { return v; } a();'),
    [],
    '通道N 的反面：(0, fn)(…) 里 fn 有定义 → 不许假红',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a(o) { const r = /noteDeleted(/; return r.test(o); } a("x");'),
    [],
    '通道O 正则字面量：/noteDeleted(/ 里的内容不是调用，误报会让真文件那条断言变成噪音',
  );
  assert.deepEqual(
    findUnknownIdentifiers('function a(n) { const r = n / 2 / 3; return r; } a(6);'),
    [],
    '通道O 的反面：连除的 / 不许被吃成一个正则',
  );

  // 再对真文件求差：必须为空（等价于「全仓没有被裸调用的未定义标识符」）。
  const source = fs.readFileSync(INDEX_FILE, 'utf8');
  assert.doesNotThrow(
    () => new Function(source.replace(/^import .*$/gm, '').replace(/^export /gm, '')),
    '去掉 import/export 后必须仍是合法函数体（语法层兜底）',
  );
  assert.deepEqual(findUnknownIdentifiers(source), [], 'index.js 里不许有「被调用但没有定义/import/形参」的标识符');
});

// —— 三条「不幸福路径」：把 makeDeps() 的成员逐个摘掉时，下面每条都必须变红 ——
// 背景：只跑「1 条候选、无冲突、无重复、不满额」的幸福路径时，deps 里摘掉 reportConflicts /
// onInboxCount / maxEntries 全套用例仍然全绿 —— 接线断点测不出来。这三条各钉一个出口。

/** 一条手写条目的 markdown 文本（与 lib/playbook.js 的序列化格式一致，用真序列化器拼）。 */
function entryBlock({ id, title, condition, action, rationale = '', created, hits = 0 }) {
  return {
    id,
    title,
    condition,
    action,
    rationale,
    meta: { created, updated: created, hits, lastHit: '' },
    extraLines: [],
  };
}

/** 把整篇手册原子写进临时目录里的某个文件（走生产的锁 + 原子写，测试里也不裸写）。 */
async function writePlaybookFile(file, header, entries) {
  await withExclusiveLock(file, () => writeFileAtomic(file, serializePlaybook({ header, entries })));
}

/** 读手册并数活跃条目（归档条目在独立的 archive.md 里，根本不会出现在手册文件里）。 */
function activeEntryCount(file) {
  return parsePlaybook(fs.readFileSync(file, 'utf8')).entries.length;
}

test('接线｜冲突路径：并发改动被逐条拦下时，reportConflicts 必须真的把通知送到 agent.followup', async () => {
  // 每个用例一个独立子目录：归档文件 archive.md 是从手册路径**派生**的（同目录），
  // 共用 ROOT 会让两条用例互相污染归档。
  const file = path.join(ROOT, 'conflict', 'playbook.md');
  const base = entryBlock({
    id: 'ace-001',
    title: '已有经验',
    condition: '任何时候',
    action: '照做即可',
    created: '2026-01-01',
  });
  await writePlaybookFile(file, ['# ACE 手记', ''], [base]);

  const candidate = {
    title: '并发写入的经验',
    condition: '两个实例同时复盘时',
    action: '候选与别人新写的条目撞标题，应当被拦成冲突',
    rationale: '同标题并存必然是重复',
  };
  // 关键：LLM 桩在被调用时（锁外快照已经读完、锁内还没开始写）往手册里塞一条同标题条目，
  // 模拟「另一个实例刚刚写了同样的经验」——这样候选才会落进 detectAddConflicts 的 sinceSnapshot 范围。
  let llmCalls = 0;
  const llmStream = async function* () {
    llmCalls += 1;
    if (llmCalls === 1) {
      const intruder = entryBlock({
        id: 'ace-002',
        title: candidate.title,
        condition: '另一个实例写的',
        action: '另一份正文',
        created: dayString(),
      });
      await writePlaybookFile(file, ['# ACE 手记', ''], [base, intruder]);
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [candidate], notes: '' }) };
      return;
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates: [], notes: '已收敛' }) };
  };

  const { ctx, record } = fakeCtx(llmStream);
  const config = configDefaults();
  config.playbookPath = file;
  plugin.apply(ctx, config);
  await new Promise((r) => setTimeout(r, 20));

  const agent = fakeAgent();
  const command = record.commands.find((c) => c.name === 'ace');
  const result = await command.handler({ agent, rawInput: '' });

  assert.equal(result.kind, 'success', '冲突不该让命令抛错：' + JSON.stringify(result));
  assert.ok(result.text.includes('手册在本次复盘期间被别的进程改过'), '命令回执里必须带上冲突提示：' + result.text);

  // 冲突通知的唯一出口：lib/index.js 的 reportConflicts → sendNotice → agent.followup(message)。
  assert.equal(agent.notices.length >= 1, true, 'reportConflicts 必须真的调到 agent.followup（摘掉 deps.reportConflicts 就会变 0）');
  const notice = agent.notices[agent.notices.length - 1];
  assert.equal(notice.role, 'user', '通知必须是 createUserMessage 造的消息对象');
  assert.ok(
    String(notice.source?.summary || '').includes('并发冲突'),
    '通知摘要要点明并发冲突：' + String(notice.source?.summary),
  );
  assert.ok(
    String(notice.content?.[0]?.text || '').includes('手册在本次复盘期间被别的进程改过'),
    '通知正文必须说清「哪些改动没并入」：' + String(notice.content?.[0]?.text),
  );

  // 手册没被写坏：并发者写进去的那条原样在，候选没有被硬塞进去。
  // 第 33 轮起归档三判据（低分 / 过期 / 衰减）已删除，容量未满时**不淘汰任何条目**：
  // ace-001 与 ace-002 都留在活跃区，归档文件里一条都没有。
  const after = parsePlaybook(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.entries.map((e) => e.id).sort(), ['ace-001', 'ace-002'], '两条都必须留在活跃区');
  assert.equal(
    after.entries.some((e) => e.title === candidate.title && e.condition === candidate.condition),
    false,
    '被拦下的候选不许落盘',
  );
  const archiveFile = path.join(path.dirname(file), 'archive.md');
  assert.equal(fs.existsSync(archiveFile), false, '没有淘汰/合并就不该凭空造出归档文件');
});

test('接线｜疑似重复路径：computeMergeSuggestions 有产出时必须落进 merge-inbox（HTTP /inbox 读得到），且系统提示段绝不许因此变化', async () => {
  const file = path.join(ROOT, 'merge-playbook.md');
  const old = entryBlock({
    id: 'ace-001',
    title: '编辑前先读目标文件',
    condition: '要对既有文件做任何修改之前',
    action: '先用 read 完整读一遍确认结构后再动手',
    rationale: '盲改导致过两次返工',
    created: dayString(),
    hits: 1,
  });
  await writePlaybookFile(file, ['# ACE 手记', ''], [old]);

  // 标题换掉（同标题会被判成 update/supersede，不产 add → 没有合并建议），正文高度相似。
  const candidate = {
    title: '改文件前先读',
    condition: '要对既有文件做任何修改之前',
    action: '先用 read 完整读一遍确认结构后再动手，改完再读一次核对',
    rationale: '盲改导致过两次返工',
  };
  let llmCalls = 0;
  const llmStream = async function* () {
    llmCalls += 1;
    const payload = llmCalls === 1 ? { candidates: [candidate], notes: '' } : { candidates: [], notes: '已收敛' };
    yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) };
  };

  const { ctx, record } = fakeCtx(llmStream);
  const config = configDefaults();
  config.playbookPath = file;
  plugin.apply(ctx, config);
  await new Promise((r) => setTimeout(r, 20));

  const agent = fakeAgent();
  const command = record.commands.find((c) => c.name === 'ace');
  const result = await command.handler({ agent, rawInput: '' });
  assert.equal(result.kind, 'success', JSON.stringify(result));

  // 第 28 轮：疑似重复条目的计数不再进系统提示段（那句动态文案会改写缓存前缀），
  // 唯一出口是 HTTP /api/dsh-ace/inbox。这条断言是前缀缓存红线的守门人：
  // 谁把 inbox 计数塞回 section 文本，这里立刻变红。
  const section = record.sections[0];
  const text = section.text({ scope: agent });
  assert.equal(
    text.includes('疑似重复条目'),
    false,
    '系统提示段必须是逐字常量，不许出现随运行状态变化的 inbox 计数句：' + text,
  );

  // 同一条数据也必须能从 HTTP 路由读到（写进 merge-inbox 文件了）。
  const { callback } = record.injected.find((i) => i.deps.includes('webServer'));
  const routes = [];
  callback({ webServer: { register: (route) => routes.push(route) }, effect: (fn) => fn(), logger: ctx.logger });
  const inbox = await callRoute(routes[0].handler, 'GET', '/api/dsh-ace/inbox');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.items.length >= 1, true, 'merge-inbox 文件里必须有建议条目');
});

test('接线｜满额路径：maxEntries 必须真的管住写入（不许静默超限），非法值不许退化成无限制', async () => {
  const file = path.join(ROOT, 'cap', 'playbook.md');
  const today = dayString();
  const full = [1, 2, 3].map((n) => entryBlock({
    id: 'ace-' + String(n).padStart(3, '0'),
    title: '占位经验 ' + n,
    condition: '占位条件 ' + n,
    action: '占位做法 ' + n,
    created: today,
  }));
  await writePlaybookFile(file, ['# ACE 手记', ''], full);

  const candidate = {
    // 本用例要验的是满额时的落盘行为：先尝试 LLM 合并，合并不成再按 hits 淘汰腾位。
    title: '手册满额时先归档腾位再写入',
    condition: '要往手册里写入新条目且已达上限时',
    action: '要么先归档腾位，要么整批拒绝，绝不能静默超限',
    rationale: '容量上限是硬红线',
  };
  let llmCalls = 0;
  const llmStream = async function* () {
    llmCalls += 1;
    const payload = llmCalls === 1 ? { candidates: [candidate], notes: '' } : { candidates: [], notes: '已收敛' };
    yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) };
  };

  const { ctx, record } = fakeCtx(llmStream);
  const config = configDefaults();
  config.playbookPath = file;
  config.maxEntries = 3;
  plugin.apply(ctx, config);
  await new Promise((r) => setTimeout(r, 20));

  const agent = fakeAgent();
  const command = record.commands.find((c) => c.name === 'ace');
  const result = await command.handler({ agent, rawInput: '' });

  // 关键判据：不许静默超限。写完后活跃条目数必须 <= maxEntries。
  const count = activeEntryCount(file);
  assert.equal(count <= 3, true, '写完后活跃条目数 ' + count + ' 超过 maxEntries=3（容量上限失效）');
  // 且手册没被写坏：原条目一条都没消失 —— 要么原样在活跃区，要么在独立的 archive.md 里。
  const parsed = parsePlaybook(fs.readFileSync(file, 'utf8'));
  const archiveFile = path.join(path.dirname(file), 'archive.md');
  const archiveEntries = fs.existsSync(archiveFile) ? (await readArchiveSnapshot(archiveFile)).entries : [];
  const archivedIds = archiveEntries.map((e) => e.id);
  const allIds = [...parsed.entries.map((e) => e.id), ...archivedIds];
  for (const id of ['ace-001', 'ace-002', 'ace-003']) {
    assert.equal(allIds.includes(id), true, '原条目 ' + id + ' 不许凭空消失');
  }
  // 满额时只有两种合法结局：腾位后写入成功，或按文案整批拒绝。两者都要有痕迹。
  const rejected = result.kind === 'error' && /已达上限/.test(result.text);
  const written = parsed.entries.some((e) => e.title === candidate.title);
  assert.equal(rejected || written, true, '满额时要么归档腾位写入、要么如实拒绝，不许两者都不是：' + JSON.stringify(result));
  assert.equal(overflowsCapacity(parsed.entries.length, 0, 0, 3), false, '落盘后不许仍处于超限状态');
  // 腾位成功时：被淘汰的那条必须带 reason=evicted 躺在 archive.md 里（软归档，永不物理删除）。
  if (written) {
    assert.equal(archivedIds.length >= 1, true, '腾位必须留下归档痕迹（archive.md）');
    for (const e of archiveEntries) {
      assert.equal(e.archive.reason, 'evicted', '被淘汰条目只能是 evicted：' + JSON.stringify(e.archive));
    }
  }
});

test('接线｜满额路径：resolveMaxEntries 把 undefined / 0 / NaN 收敛成默认上限，绝不当成「不限」', async () => {
  // overflowsCapacity 把非有限值/<=0 当「不限」（lib/playbook.js:431-434），
  // 于是接线漏传 maxEntries 就会让容量上限整个失效。流水线入口必须兜住。
  const warns = [];
  const logger = { warn: (m) => warns.push(String(m)) };
  for (const bad of [undefined, null, 0, -1, NaN, '3', 2.5]) {
    const got = resolveMaxEntries(bad, logger);
    assert.equal(Number.isInteger(got) && got > 0, true, '非法值 ' + String(bad) + ' 必须收敛成正整数，实际 ' + got);
    assert.equal(got, 100, '非法值 ' + String(bad) + ' 必须按 DEFAULT_MAX_ENTRIES 兜底');
  }
  assert.equal(warns.length, 7, '每次兜底都要 warn 一行（不许静默）');
  assert.ok(warns[0].includes('无效的 maxEntries'), 'warn 文案要说清是 maxEntries 无效：' + warns[0]);
  // 合法值原样透传，不 warn。
  assert.equal(resolveMaxEntries(3, logger), 3);
  assert.equal(resolveMaxEntries(1000, logger), 1000);
  assert.equal(warns.length, 7, '合法值不该 warn');
});

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});
