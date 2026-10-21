// dsh-ace 插件入口：ACE（Agentic Context Engineering, arXiv 2510.04618）的 DSH 原生实现。
//
// 三个模型可见工具：
//   ace_playbook —— 读手册（整本 / 按条目 id / 按关键词过滤）；
//   ace_reflect  —— 输入任务摘要，LLM 复盘产出结构化候选经验（条件/做法/依据）；
//   ace_curate   —— 把候选经验增量并入手册（增/改/删 + LLM 去重 + 容量护栏）。
// 另注入一段系统提示：告诉 agent 何时主动复盘。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - 入口契约 { name, inject, apply, Config }：真实范例 ~\dsh-tool-todo\lib\index.js:196（导出 Config,apply,inject,name）；
//   Config 为 StandardSchemaV1（~\@deepseek-ai\cordis-plugin-loader\lib\index.js:251-252 以 ~standard.vendor === 'schemastery' 识别）。
// - defineTool / ctx.tools.register：~\dsh-tools\lib\types\schema.d.ts:248（defineTool）、DefineToolOptions:178-240；
//   ToolRuntime.register ~\dsh-tools\lib\types\index.d.ts:527,637；defineTool+register 真实用法 ~\dsh-tool-todo\lib\index.js:95-193。
// - 系统提示段：PromptSection {name,order,text} 与 SystemPrompt.section ~\dsh-system-prompt\lib\types\index.d.ts:47-61,250。
// - LLM 调用与路由解析：见 ./llm.js 头注。
// - workingDirectory.ensure：~\dsh-working-directory\lib\types\index.d.ts:73。
// - schemastery z.string().description/.default：~\schemastery\lib\types\index.d.ts:170,166。

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { REFLECTOR_SYSTEM, CURATOR_SYSTEM, reflectorUserInput, curatorUserInput, extractJsonObject } from './prompts.js';
import { parsePlaybook, serializePlaybook, applyOps, digestEntries, withLock, writeFileAtomic, readOrInitPlaybook, matchEntries } from './playbook.js';
import { resolveRoute, oneShot } from './llm.js';
import { buildCatalog } from './catalog.js';
import { resolveSettingsFile, resolveLegacySettingsFile, migrateSettingsFile } from './settings-path.js';

export const name = 'dsh-ace';

// 依赖的宿主服务（dsh-tool-todo 的 inject 同款声明：~\dsh-tool-todo\lib\index.js:12）。
export const inject = ['tools', 'systemPrompt', 'llm', 'workingDirectory'];

/** 插件配置（cordis config schema；字段语义见 README「配置」节）。 */
export const Config = z.object({
  playbookPath: z.string().description('手册 Markdown 路径；相对路径相对会话工作目录解析').default('.ace/playbook.md'),
  autoReflect: z.boolean().description('是否在系统提示里提醒 agent 任务完成后主动复盘').default(true),
  reflectProvider: z.string().description('Reflector/Curator 覆盖 provider；留空跟随会话模型').default(''),
  reflectModel: z.string().description('Reflector/Curator 覆盖 model；留空跟随会话模型').default(''),
  maxEntries: z.number().description('手册最大条目数；超出后 ace_curate 整批拒绝并提示先合并').default(60),
});

const FIELD_TITLES = { title: '标题', condition: '条件', action: '做法', rationale: '依据' };

/** 设置页读写的同源路由（webServer 前缀；见 apply 末尾的 ctx.inject(['webServer'])）。 */
const ROUTE_PATH = '/api/dsh-ace';

const MAX_BODY_BYTES = 64 * 1024;

/** 模型目录里单个 provider 的 listModels 超时：卡住只让它自己带 error，不拖垮整个接口。 */
const CATALOG_TIMEOUT_MS = 15000;

/** maxEntries 的合法区间（与设置页输入框一致）。 */
const MAX_ENTRIES_RANGE = [1, 1000];

/**
 * 设置页保存的位置：跟随 profile 目录（<profileDir>/dsh-ace.json），
 * 每个 profile 各自一份；解析链与容错在 ./settings-path.js（纯逻辑，tests/settings-path.test.mjs 覆盖）。
 * 插件行的 Config 继续充当默认值。
 */
function settingsFile(ctx) {
  return resolveSettingsFile(ctx);
}

/** 接受一个开关值（真布尔或其字符串形式），否则 undefined。 */
function validFlag(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** 接受一段文本（允许空串，用于「跟随会话模型」），否则 undefined。 */
function validString(value, max) {
  if (typeof value !== 'string') return undefined;
  return value.length <= max ? value : undefined;
}

/** 接受一个区间内的整数，否则 undefined。 */
function validInt(value, [min, max]) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * 只保留通过校验的已存值：一条手改坏了的字段被丢弃，而不是毒化整个文件。
 * 未出现的字段表示「跟随插件行 Config」。
 */
function normalizeSettings(raw, logger) {
  const settings = {};
  if (!raw || typeof raw !== 'object') return settings;
  const playbookPath = validString(raw.playbookPath, 1024);
  if (playbookPath !== undefined && playbookPath.trim() !== '') settings.playbookPath = playbookPath;
  const autoReflect = validFlag(raw.autoReflect);
  if (autoReflect !== undefined) settings.autoReflect = autoReflect;
  const reflectProvider = validString(raw.reflectProvider, 200);
  if (reflectProvider !== undefined) settings.reflectProvider = reflectProvider;
  const reflectModel = validString(raw.reflectModel, 200);
  if (reflectModel !== undefined) settings.reflectModel = reflectModel;
  const maxEntries = validInt(raw.maxEntries, MAX_ENTRIES_RANGE);
  if (maxEntries !== undefined) settings.maxEntries = maxEntries;
  if (raw.maxEntries !== undefined && maxEntries === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 maxEntries（需为 ${MAX_ENTRIES_RANGE[0]}–${MAX_ENTRIES_RANGE[1]} 的整数）`);
  }
  return settings;
}

/** 读已存设置；文件缺失或读不动都只表示「没有」。 */
function readStored(file, logger) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')), logger);
  } catch {
    return {};
  }
}

/** 原子写已存设置。 */
function writeStored(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(settings, undefined, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** 同机调用者可合法使用的主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** 把 Host/Origin/Referer 拆成 {scheme, hostname, port}。 */
function authorityOf(value, defaultScheme = 'http') {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value.trim() : defaultScheme + '://' + value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port };
}

/**
 * 本插件 HTTP 面的信任围栏。前缀比内核的 /api 长，而 webServer 派发是
 * 「最长前缀优先」，所以这里必须自己拦：优先用 connection 服务的判定，
 * 没有该服务时退化为结构复刻（回环 Host、非同站、Origin/Referer 与 Host 同源）。
 */
function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req);
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection;
      return undefined;
    } catch {
      // connection 抛错是组合层的问题；退到结构围栏，而不是把所有请求都判 500。
    }
  }
  const host = authorityOf(req.headers.host);
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403;
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403;
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const authority = authorityOf(raw.trim());
    if (authority === null) return 403;
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return 403;
    }
  }
  return undefined;
}

/** 读 JSON 请求体；读不动一律给 {}。 */
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy?.();
        finish({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
  });
}

/**
 * 解析手册文件绝对路径：绝对配置直接用；相对配置相对会话工作目录
 * （workingDirectory.ensure：~\dsh-working-directory\lib\types\index.d.ts:73）。
 */
function makeResolver(ctx, config) {
  return async (exec) => {
    const p = config.playbookPath;
    if (path.isAbsolute(p)) return p;
    if (!exec || !exec.agent) {
      throw new Error('ace: 相对手册路径需要会话上下文（当前调用无 agent）；请在插件配置里把 playbookPath 设为绝对路径。');
    }
    const wd = await ctx.workingDirectory.ensure(exec.agent);
    return path.join(wd, p);
  };
}

function requireStr(op, f, at) {
  if (typeof op[f] !== 'string' || !op[f].trim()) {
    throw new Error('ace: ' + at + ' 缺少必填字段 ' + f + '（' + FIELD_TITLES[f] + '）');
  }
}

export function apply(ctx, config) {
  const settingsPath = settingsFile(ctx);

  // 一次性迁移：旧口径落在 $DSH_HOME 层，新口径跟随 profile 目录。
  // 新位置已存在则绝不覆盖；旧文件只复制、不删除（那是用户数据）。
  migrateSettingsFile({ from: resolveLegacySettingsFile(), to: settingsPath, logger: ctx.logger });

  /** 设置页存下的值；空表示「全部跟随插件行 Config」。 */
  let stored = readStored(settingsPath, ctx.logger);

  /**
   * 实际生效的配置：已存值优先，缺的字段回落到插件行 Config。
   * 设置页每次保存后原地更新它，工具与系统提示段随即读到新值。
   */
  const live = { ...config };

  const applyStored = () => {
    const next = { ...config };
    for (const key of ['playbookPath', 'autoReflect', 'reflectProvider', 'reflectModel', 'maxEntries']) {
      if (stored[key] !== undefined) next[key] = stored[key];
    }
    Object.assign(live, next);
  };
  applyStored();

  const resolveFile = makeResolver(ctx, live);

  // —— 系统提示段：何时主动复盘（设计决策 4） ——
  // 段本身常驻注册，autoReflect 关掉时 text 返回空串（渲染时按长度过滤掉），
  // 这样设置页在运行期开关它无需重启。
  ctx.systemPrompt.section({
    name: 'ace-playbook',
    order: 860,
    text: () => (live.autoReflect ? [
      '【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，' + live.playbookPath + '）。',
      '- 开始一个与既往经验可能相关的任务前，先用 ace_playbook 查阅手册，命中经验就照做。',
      '- 完成一个有实质工作量的任务（排障/实现/重构/调研等）之后，主动调用 ace_reflect 复盘：',
      '  给出任务摘要与轨迹要点，由它产出候选经验；',
      '- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。',
    ].join('\n') : ''),
  });

  // —— 工具 1：ace_playbook（只读，可并行） ——
  ctx.tools.register(defineTool({
    name: 'ace_playbook',
    description: '读取 ACE 操作手册（playbook）：沉淀了既往任务提炼的可复用经验（每条含条件/做法/依据）。开始与既往经验可能相关的任务前先查阅。可整本读取（省略 id 与 query），或按条目 id / 关键词过滤（query 传 1-3 个短关键词，空格分隔，按相关度（BM25）排序；matched=0 时改用整本读取）。',
    parameters: {
      id: { type: 'string', description: '只读这一条：条目 id，如 ace-003。优先于 query。' },
      query: { type: 'string', description: '关键词过滤：传 1-3 个短关键词（空格分隔），命中任一片段的条目都返回，按相关度（BM25）排序。不要传整句自然语言；matched=0 时改用整本读取。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          entryCount: { type: 'integer', required: true },
          matched: { type: 'integer', required: true },
          playbook: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: '手册 ' + value.path + '（共 ' + value.entryCount + ' 条，命中 ' + value.matched + ' 条）\n\n' + value.playbook }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = await resolveFile(exec);
      const parsed = await readOrInitPlaybook(file);
      let entries = parsed.entries;
      if (args.id) {
        const hit = entries.filter((e) => e.id === args.id);
        if (!hit.length) throw new Error('ace: 手册里没有 id 为 ' + args.id + ' 的条目');
        entries = hit;
      } else if (args.query) {
        // 片段 OR 匹配：query 拆片段（汉字块 2-gram），命中任一片段即返回，按命中数降序（matchEntries，lib/playbook.js）。
        entries = matchEntries(entries, args.query);
      }
      return {
        path: file,
        entryCount: parsed.entries.length,
        matched: entries.length,
        playbook: serializePlaybook({ header: parsed.header, entries }),
      };
    },
  }));

  // —— 工具 2：ace_reflect（LLM 复盘，只产出候选、不动手册） ——
  ctx.tools.register(defineTool({
    name: 'ace_reflect',
    description: '复盘一次已完成的任务：给出任务摘要与结果，LLM（Reflector）对照当前手册提炼结构化候选经验（title/condition/action/rationale）。本工具只产出候选，不改手册；把值得沉淀的候选交给 ace_curate 并入。应在完成一个有实质工作量的任务之后调用。',
    parameters: {
      summary: { type: 'string', required: true, description: '本次任务的摘要/轨迹要点：做了什么、踩了什么坑、什么做法起了效。' },
      outcome: { type: 'string', description: '任务结果（成功/失败/部分完成，一句话）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                condition: { type: 'string', required: true },
                action: { type: 'string', required: true },
                rationale: { type: 'string', required: true },
              },
            },
          },
          notes: { type: 'string', required: true },
          existingCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Reflector 产出 ' + value.candidates.length + ' 条候选经验（现有手册 ' + value.existingCount + ' 条）。' + (value.notes ? '备注：' + value.notes : ''),
      }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      const file = await resolveFile(exec);
      const { entries } = await readOrInitPlaybook(file);
      const route = resolveRoute(live, exec);
      const raw = await oneShot(ctx, {
        provider: route.provider,
        model: route.model,
        system: REFLECTOR_SYSTEM,
        userText: reflectorUserInput({ summary: args.summary, outcome: args.outcome, playbookDigest: digestEntries(entries).join('\n') }),
      });
      const parsed = extractJsonObject(raw);
      const candidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.filter((c) => c && typeof c.title === 'string' && typeof c.condition === 'string' && typeof c.action === 'string' && typeof c.rationale === 'string')
        : [];
      return { candidates, notes: typeof parsed.notes === 'string' ? parsed.notes : '', existingCount: entries.length };
    },
  }));

  // —— 工具 3：ace_curate（增量并入手册；互斥锁内 读→LLM 去重→增量应用→原子写） ——
  ctx.tools.register(defineTool({
    name: 'ace_curate',
    description: '把候选经验增量并入 ACE 操作手册：add 新增 / update 修改既有条目 / remove 删除。开启去重时（默认）新增候选会先经 LLM（Curator）与既有条目比对（判定 new/update/drop）再落盘。手册只增量演化，绝不整本重写。',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description: '增量操作列表，按序应用；任一操作非法则整批拒绝（事务式）。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: 'add=新增（需 title/condition/action）；update=修改（需 id + 至少一个字段）；remove=删除（需 id）。' },
            id: { type: 'string', description: '条目 id（update/remove 必填），如 ace-003。' },
            title: { type: 'string', description: '一句话标题（add 必填；update 可选）。' },
            condition: { type: 'string', description: '条件：什么情境下适用（add 必填；update 可选）。' },
            action: { type: 'string', description: '做法：具体怎么做（add 必填；update 可选）。' },
            rationale: { type: 'string', description: '依据：为什么有效（可选）。' },
          },
        },
      },
      dedupe: { type: 'boolean', description: '是否对新增候选做 LLM 去重（默认 true）。手册为空时自动跳过。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'array', required: true, items: { type: 'string' } },
          updated: { type: 'array', required: true, items: { type: 'string' } },
          removed: { type: 'array', required: true, items: { type: 'string' } },
          duplicates: { type: 'array', required: true, items: { type: 'string' } },
          droppedByCurator: { type: 'array', required: true, items: { type: 'string' } },
          entryCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '手册更新完成：新增 ' + value.added.length + '，修改 ' + value.updated.length + '，删除 ' + value.removed.length +
          '，重复跳过 ' + value.duplicates.length + '，Curator 判定无新意丢弃 ' + value.droppedByCurator.length + '；现有 ' + value.entryCount + ' 条。',
      }],
    },
    async execute(args, exec) {
      const file = await resolveFile(exec);
      const ops = args.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error('ace: ops 必须是非空数组');
      // 互斥保护：同一路径的 curate 串行执行（withLock：./playbook.js 的 per-path Promise 链）。
      return withLock(file, async () => {
        const parsed = await readOrInitPlaybook(file);
        let finalOps = ops;
        const droppedByCurator = [];
        const dedupe = args.dedupe !== false;
        const adds = ops.filter((o) => o && o.op === 'add');
        if (dedupe && adds.length && parsed.entries.length) {
          const route = resolveRoute(live, exec);
          const raw = await oneShot(ctx, {
            provider: route.provider,
            model: route.model,
            system: CURATOR_SYSTEM,
            userText: curatorUserInput({ existing: digestEntries(parsed.entries), candidates: adds }),
          });
          const decisions = extractJsonObject(raw).decisions;
          if (!Array.isArray(decisions)) throw new Error('ace: Curator 输出缺少 decisions 数组');
          finalOps = ops
            .map((op) => {
              if (!op || op.op !== 'add') return op;
              const i = adds.indexOf(op);
              const d = decisions.find((x) => x && x.index === i);
              if (!d || d.verdict === 'new') return op;
              if (d.verdict === 'drop') { droppedByCurator.push(String(d.reason || op.title)); return null; }
              if (d.verdict === 'update') {
                const merged = { op: 'update', id: d.id };
                for (const f of ['title', 'condition', 'action', 'rationale']) {
                  if (typeof d[f] === 'string' && d[f].trim()) merged[f] = d[f];
                }
                return merged;
              }
              return op;
            })
            .filter(Boolean);
        }
        const result = applyOps(parsed.entries, finalOps, live.maxEntries);
        const text = serializePlaybook({ header: parsed.header, entries: result.entries });
        await writeFileAtomic(file, text);
        return {
          added: result.added,
          updated: result.updated,
          removed: result.removed,
          duplicates: result.duplicates,
          droppedByCurator,
          entryCount: result.entries.length,
        };
      });
    },
  }));

  // —— 设置页的数据源：自建同源 HTTP 路由 ——
  // webServer 是「问它有没有」而不是注入：没有 HTTP 载体的组合只是失去设置页，别的一概不受影响。
  // 客户端那半边（client.js）不依赖 configForms（宿主不服务 dsh-ace 命名空间），
  // 而是 fetch 这个路由读写设置；范式同 dsh-insert-context 的 index.js:601-718。
  ctx.inject(['webServer'], (scoped) => {
    const describe = () => ({
      ok: true,
      value: { ...live },
      configured: { ...config },
      stored: { ...stored },
      file: settingsPath,
      bounds: { maxEntries: MAX_ENTRIES_RANGE },
    });

    // 模型目录：设置页两个下拉（provider / model）的数据源。
    // 折叠逻辑与容错在 lib/catalog.js（纯逻辑，tests/catalog.test.mjs 覆盖），这里只接服务：
    // ctx.llm 即 LlmRuntime，API 出处见 lib/catalog.js 头注（~\dsh-llm\lib\types\index.d.ts:281,367）。
    const readCatalog = () => buildCatalog(ctx.llm ?? ctx.get?.('llm'), { timeoutMs: CATALOG_TIMEOUT_MS, logger: ctx.logger });

    scoped.effect(
      () => scoped.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const routePath = url.pathname.slice(ROUTE_PATH.length).replace(/\/+$/, '') || '/';
          const method = String(req.method ?? 'GET').toUpperCase();
          const send = (status, payload) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(payload));
          };

          const rejection = rejectionFor(req, ctx.get('connection'));
          if (rejection !== undefined) {
            return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
          }
          // GET /api/dsh-ace/catalog：设置页下拉的模型目录（只读、不落盘、不缓存）。
          if (routePath === '/catalog') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            return send(200, await readCatalog());
          }
          if (routePath !== '/settings') return send(404, { error: 'not found' });

          if (method === 'GET') return send(200, describe());

          // DELETE：清空已存设置，回到插件行 Config。
          if (method === 'DELETE') {
            try {
              fs.rmSync(settingsPath, { force: true });
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法清空设置（' + (error?.message ?? error) + '）');
              return send(500, { error: 'could not clear: ' + (error?.message ?? error) });
            }
            stored = {};
            applyStored();
            ctx.logger?.info?.('dsh-ace: 设置已清空，回到插件行 Config');
            return send(200, describe());
          }

          if (method !== 'POST') return send(405, { error: 'method not allowed' });

          const patch = await readJson(req);
          const body = patch && typeof patch === 'object' ? patch : {};
          const next = { ...stored };
          let error;
          let touched = false;

          if ('playbookPath' in body) {
            touched = true;
            const value = validString(body.playbookPath, 1024);
            if (value === undefined || value.trim() === '') error = 'playbookPath 必须是非空字符串（最多 1024 字符）';
            else next.playbookPath = value;
          }
          if ('autoReflect' in body) {
            touched = true;
            const value = validFlag(body.autoReflect);
            if (value === undefined) error = 'autoReflect 必须是 true 或 false';
            else next.autoReflect = value;
          }
          if ('reflectProvider' in body) {
            touched = true;
            const value = validString(body.reflectProvider, 200);
            if (value === undefined) error = 'reflectProvider 必须是字符串（最多 200 字符，留空表示跟随会话）';
            else next.reflectProvider = value;
          }
          if ('reflectModel' in body) {
            touched = true;
            const value = validString(body.reflectModel, 200);
            if (value === undefined) error = 'reflectModel 必须是字符串（最多 200 字符，留空表示跟随会话）';
            else next.reflectModel = value;
          }
          if ('maxEntries' in body) {
            touched = true;
            const value = validInt(body.maxEntries, MAX_ENTRIES_RANGE);
            if (value === undefined) error = `maxEntries 必须是 ${MAX_ENTRIES_RANGE[0]}–${MAX_ENTRIES_RANGE[1]} 的整数`;
            else next.maxEntries = value;
          }

          if (error === undefined && !touched) error = 'no settings provided';
          if (error !== undefined) return send(400, { error });

          try {
            writeStored(settingsPath, next);
          } catch (failure) {
            ctx.logger?.warn?.('dsh-ace: 无法保存设置（' + (failure?.message ?? failure) + '）');
            return send(500, { error: 'could not save: ' + (failure?.message ?? failure) });
          }
          stored = next;
          applyStored();
          ctx.logger?.info?.(
            'dsh-ace: 设置已保存（手册 ' + live.playbookPath + '，复盘提醒 ' + (live.autoReflect ? '开' : '关') +
            '，容量 ' + live.maxEntries + '）',
          );
          return send(200, describe());
        },
      }),
      'dsh-ace: settings api',
    );
  });
}