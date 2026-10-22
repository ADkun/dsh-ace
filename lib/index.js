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
// - 手册路径解析链（绝对 / ~ / 相对工作目录 / 空串=本机共享层）与 home 解析：见 ./playbook-path.js 头注。
// - schemastery z.string().description/.default：~\schemastery\lib\types\index.d.ts:170,166。

import fs from 'node:fs';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { REFLECTOR_SYSTEM, CURATOR_SYSTEM, reflectorUserInput, curatorUserInput, extractJsonObject } from './prompts.js';
import { parsePlaybook, serializePlaybook, applyOps, digestEntries, withExclusiveLock, writeFileAtomic, readOrInitPlaybook, readPlaybookSnapshot, detectConflicts, matchEntries } from './playbook.js';
import { resolveRoute, oneShot } from './llm.js';
import { buildCatalog } from './catalog.js';
import { resolveSettingsFile, resolveLegacySettingsFile, migrateSettingsFile } from './settings-path.js';
import { resolvePlaybookFile, playbookPathKind, resolveSharedPlaybookFile, DEFAULT_PLAYBOOK_PATH, DEFAULT_MAX_ENTRIES } from './playbook-path.js';
import { MUTATING_TOOLS, isMainAgent, hasNoRunningSubagents, isMutatingTool, shouldTriggerAutoRecap } from './trigger.js';
import { INBOX_CAP, readInbox, writeInboxAtomic, addToInbox, inboxFull } from './inbox.js';
import { computeMergeSuggestions } from './merge.js';
import { scoreEntries } from './playbook.js';
// createUserMessage：~\@deepseek-ai\dsh-llm\lib\index.js:2429（export list），message.d.ts:213。
import { createUserMessage } from '@deepseek-ai/dsh-llm';
// deadline：~\@deepseek-ai\dsh-timeout\lib\types\index.d.ts:76，lib\index.js:57。
import { deadline } from '@deepseek-ai/dsh-timeout';

export const name = 'dsh-ace';

// 依赖的宿主服务（dsh-tool-todo 的 inject 同款声明：~\dsh-tool-todo\lib\index.js:12）。
export const inject = ['tools', 'systemPrompt', 'llm', 'workingDirectory', 'agents', 'commands'];

/** 插件配置（cordis config schema；字段语义见 README「配置」节）。 */
export const Config = z.object({
  playbookPath: z.string()
    .description('手册 Markdown 路径。留空 = 本机共享手册（<DSH home>/ace/playbook.md，跨工作区共用一本）；绝对路径（支持 ~ / ~/ / ~\\ 前缀）原样使用；相对路径相对会话工作目录解析，即该工作区私有')
    .default(DEFAULT_PLAYBOOK_PATH),
  autoReflect: z.boolean().description('是否在系统提示里提醒 agent 任务完成后主动复盘').default(true),
  reflectProvider: z.string().description('Reflector/Curator 覆盖 provider；留空跟随会话模型').default(''),
  reflectModel: z.string().description('Reflector/Curator 覆盖 model；留空跟随会话模型').default(''),
  maxEntries: z.number().description('手册最大条目数；超出后 ace_curate 整批拒绝并提示先合并').default(DEFAULT_MAX_ENTRIES),
  autoRecap: z.boolean().description('主代理回合结束时自动复盘归档（reflect+curate），无需模型主动调用').default(true),
  autoRecapThreshold: z.number().description('触发自动复盘所需的 mutating 工具调用下限').default(1),
  autoRecapCooldownTurns: z.number().description('距上次自动复盘至少隔几轮').default(2),
  autoReviewInbox: z.boolean().description('预留开关，当前不生效：merge-inbox 的复审入口是设置页「待合并复审」区块或对话里的 /ace review').default(false),
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
  // 空串是合法值（= 本机共享层），与「未设置」语义相同但允许显式存下。
  if (playbookPath !== undefined) settings.playbookPath = playbookPath;
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
  const autoRecap = validFlag(raw.autoRecap);
  if (autoRecap !== undefined) settings.autoRecap = autoRecap;
  const autoRecapThreshold = validInt(raw.autoRecapThreshold, [0, 1000]);
  if (autoRecapThreshold !== undefined) settings.autoRecapThreshold = autoRecapThreshold;
  const autoRecapCooldownTurns = validInt(raw.autoRecapCooldownTurns, [0, 1000]);
  if (autoRecapCooldownTurns !== undefined) settings.autoRecapCooldownTurns = autoRecapCooldownTurns;
  const autoReviewInbox = validFlag(raw.autoReviewInbox);
  if (autoReviewInbox !== undefined) settings.autoReviewInbox = autoReviewInbox;
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
 * 解析手册文件绝对路径（解析链与 \`~\` 展开见 lib/playbook-path.js 头注，tests/playbook-path.test.mjs 覆盖）：
 *   ① 绝对路径（含 \`~\` 前缀）—— 原样使用；
 *   ② 相对路径 —— 相对会话工作目录（workingDirectory.ensure：
 *      ~\dsh-working-directory\lib\types\index.d.ts:73），即该工作区私有手册；
 *   ③ 空串 / 缺省 —— 本机共享层 \`<DSH home>/ace/playbook.md\`，不需要会话上下文。
 * 只有 ② 真正需要会话上下文：无 agent 时抛错，其余两种都能解析。
 */
function makeResolver(ctx, config) {
  return async (exec) => {
    // 非相对路径（绝对 / ~ / 共享层）与会话无关，无 agent 也照常解析。
    if (playbookPathKind(config.playbookPath) !== 'relative') {
      return resolvePlaybookFile(config.playbookPath, { ctx });
    }
    // 相对路径才需要会话工作目录；拿不到就由 resolvePlaybookFile 抛
    // RELATIVE_PATH_NEEDS_SESSION（错误文案见 lib/playbook-path.js）。
    const wd = exec && exec.agent ? await ctx.workingDirectory.ensure(exec.agent) : undefined;
    return resolvePlaybookFile(config.playbookPath, { ctx, workingDirectory: wd });
  };
}

/** 系统提示里展示的手册位置：共享层（空串配置）显示实际路径，免得提示里出现一段空白。 */
function displayPlaybookPath(ctx, config) {
  if (playbookPathKind(config.playbookPath) === 'shared') {
    return resolveSharedPlaybookFile(ctx) + '（本机共享，跨工作区共用）';
  }
  return config.playbookPath;
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
    for (const key of ['playbookPath', 'autoReflect', 'reflectProvider', 'reflectModel', 'maxEntries', 'autoRecap', 'autoRecapThreshold', 'autoRecapCooldownTurns', 'autoReviewInbox']) {
      if (stored[key] !== undefined) next[key] = stored[key];
    }
    Object.assign(live, next);
  };
  applyStored();

  const resolveFile = makeResolver(ctx, live);

  // —— 系统提示段：何时主动复盘 ——
  // autoRecap 开：措辞改为"采集已自动"。
  // autoRecap 关 + autoReflect 开：保留原措辞（要求模型主动复盘）。
  // inbox 非空时追加聚合提示（封顶时变硬提醒）。
  let inboxCount = 0;
  function inboxPath(file) { return path.join(path.dirname(file), 'merge-inbox'); }

  /**
   * 刷新「待合并条目数」（系统提示里那条聚合提示用）。
   * 为什么启动时必须读一次：merge-inbox 落在手册目录里，默认是本机共享层
   * <DSH home>/ace/merge-inbox；系统提示段的 text 回调是同步的（契约见
   * dsh-system-prompt\lib\types\index.d.ts:60），只能在别处把计数读进来。
   * 相对路径的私有手册在这里没有会话上下文，解析不到文件 → 计数保持 0，
   * 等第一次真正写手册时（写路径旁会更新计数）才准。
   */
  async function refreshInboxCount(file) {
    try {
      const items = await readInbox(inboxPath(file));
      inboxCount = items.length;
      return items.length;
    } catch (error) {
      ctx.logger?.warn?.('dsh-ace: 无法读取 merge-inbox 计数（' + (error?.message ?? error) + '）');
      return inboxCount;
    }
  }

  // 启动时读一次：能解析出绝对路径（共享层 / 绝对路径）就读；相对路径跳过。
  try {
    if (playbookPathKind(live.playbookPath) !== 'relative') {
      void refreshInboxCount(resolvePlaybookFile(live.playbookPath, { ctx }));
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-ace: 启动时无法定位 merge-inbox（' + (error?.message ?? error) + '）');
  }

  /**
   * 把 merge-inbox 条目渲染成模型可读的复审提示（/ace review 注入对话用）。
   * item 只有 { newEntryId, newEntryTitle, bestMatchId, bestMatchTitle, score, selfScore, ratio }
   * （lib/merge.js:62-70），没有条目正文 —— 所以注入 id 对子，正文让模型自己用
   * ace_playbook 按 id 读（这正是 /ace review 的本意：主模型复审）。
   * 截断到前 REVIEW_INJECT_LIMIT 条：全量注入会撑大上下文。
   */
  const REVIEW_INJECT_LIMIT = 8;
  function renderReviewText(items) {
    const shown = items.slice(0, REVIEW_INJECT_LIMIT);
    const lines = [
      items.length + ' 条疑似重复条目待审阅。请逐对处理：对每一对，先用 ace_playbook 以 id 参数分别读出两条全文（一次调用传一个 id，或分两次），再判断能否合并。',
      '能合并就走 ace_curate（用 update 保留信息更全的一条、把另一条的独有内容并进去，再用 remove 删掉被合并的那条）；不能合并就原样跳过，不要改动手册。',
      '',
    ];
    shown.forEach((item, i) => {
      lines.push(
        (i + 1) + ') ' + item.newEntryId + ' 《' + item.newEntryTitle + '》 ↔ ' +
        item.bestMatchId + ' 《' + item.bestMatchTitle + '》（相似度 ' + Math.round(item.ratio * 100) + '%）',
      );
    });
    if (items.length > shown.length) {
      lines.push('（其余 ' + (items.length - shown.length) + ' 条未展示，处理完这批后再运行 /ace review）');
    }
    return lines.join('\n');
  }
  ctx.systemPrompt.section({
    name: 'ace-playbook',
    order: 860,
    text: () => {
      const lines = [];
      if (live.autoRecap) {
        lines.push(
          '【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，' + displayPlaybookPath(ctx, live) + '）。',
          '- 采集已自动——回合真正结束时会自动复盘归档；你只需在遇同类任务前用 ace_playbook 查旧经验。',
          '- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。',
        );
      } else if (live.autoReflect) {
        lines.push(
          '【ACE 操作手册】本会话挂载了一份可进化的操作手册（playbook，' + displayPlaybookPath(ctx, live) + '）。',
          '- 开始一个与既往经验可能相关的任务前，先用 ace_playbook 查阅手册，命中经验就照做。',
          '- 完成一个有实质工作量的任务（排障/实现/重构/调研等）之后，主动调用 ace_reflect 复盘：',
          '  给出任务摘要与轨迹要点，由它产出候选经验；',
          '- 需要把经验沉淀进手册时用 ace_curate。红线：手册只能增量演化（增/改/删单条），不许整本重写。',
        );
      } else {
        return '';
      }
      if (inboxCount >= INBOX_CAP) {
        lines.push('- ⚠ 待合并已满（' + inboxCount + ' 条），请先用 /ace review 清理。');
      } else if (inboxCount > 0) {
        lines.push('- 手册里有 ' + inboxCount + ' 条疑似重复条目，可用 /ace review 查看。');
      }
      return lines.join('\n');
    },
  });

  // —— 自动复盘：tools/result 计数 + agent/turn-stopping 触发 ——
  // 事件出处（DSH checkout ~）：
  // - tools/result：~\dsh-tools\lib\types\index.d.ts:92（emit，scope-filtered by exec.agent L87）。
  //   exec.name=工具名（L223），exec.agent=调用 agent（L229）。
  // - agent/turn-stopping：~\dsh-agent\lib\types\runtime-types.d.ts:387-391（serial，payload {agent,turn,signal}）。
  // - agent.runMaintenance：~\dsh-agent\lib\types\runtime-types.d.ts:174（从 idle 运行非回合维护）。
  // - ctx.agents.list()：~\dsh-agent\lib\types\index.d.ts:357（返回所有 live agent）。
  // - isMainAgent：agent.session.header.origin !== 'subagent'（~\dsh-session\lib\types\types.d.ts:82）。
  const agentState = new WeakMap();

  ctx.on('tools/result', (exec, _result) => {
    if (!exec || !exec.agent) return;
    if (!isMainAgent(exec.agent)) return;
    if (!isMutatingTool(exec.name)) return;
    let st = agentState.get(exec.agent);
    if (!st) { st = { mutCount: 0, lastRecapTurn: 0 }; agentState.set(exec.agent, st); }
    st.mutCount++;
  });

  ctx.on('agent/turn-stopping', async (payload) => {
    const agent = payload?.agent;
    if (!agent || !isMainAgent(agent)) return;
    const allAgents = ctx.agents?.list?.() ?? [];
    if (!hasNoRunningSubagents(allAgents, agent)) return;
    let st = agentState.get(agent);
    if (!st) { st = { mutCount: 0, lastRecapTurn: 0 }; agentState.set(agent, st); }
    const currentTurn = Number(payload.turn) || 0;
    if (!shouldTriggerAutoRecap({ mutCount: st.mutCount, lastRecapTurn: st.lastRecapTurn, currentTurn }, live)) return;
    st.lastRecapTurn = currentTurn;
    const prevMutCount = st.mutCount;
    st.mutCount = 0;
    try {
      await agent.runMaintenance(async (signal) => {
        const file = await resolveFile({ agent });
        // 锁外只读快照（不写盘）；LLM 调用也全在锁外。
        const { entries } = await readPlaybookSnapshot(file);
        const route = resolveRoute(live, { agent });
        const raw = await oneShot(ctx, {
          provider: route.provider,
          model: route.model,
          system: REFLECTOR_SYSTEM,
          userText: reflectorUserInput({
            summary: '自动复盘：本回合有 ' + prevMutCount + ' 次 mutating 工具调用。',
            outcome: '',
            playbookDigest: digestEntries(entries).join('\n'),
          }),
          signal,
        });
        const parsed = extractJsonObject(raw);
        const candidates = Array.isArray(parsed.candidates)
          ? parsed.candidates.filter((c) => c && typeof c.title === 'string' && typeof c.condition === 'string' && typeof c.action === 'string' && typeof c.rationale === 'string')
          : [];
        if (!candidates.length) return { added: [] };
        const ops = candidates.map((c) => ({ op: 'add', ...c, auto: true }));
        let finalOps = ops;
        if (entries.length) {
          const curatorRaw = await oneShot(ctx, {
            provider: route.provider,
            model: route.model,
            system: CURATOR_SYSTEM,
            userText: curatorUserInput({ existing: digestEntries(entries), candidates: ops }),
            signal,
          });
          const decisions = extractJsonObject(curatorRaw).decisions;
          if (Array.isArray(decisions)) {
            finalOps = ops.map((op, i) => {
              const d = decisions.find((x) => x && x.index === i);
              if (!d || d.verdict === 'new') return op;
              if (d.verdict === 'drop') return null;
              if (d.verdict === 'update') {
                const merged = { op: 'update', id: d.id, auto: true };
                for (const f of ['title', 'condition', 'action', 'rationale']) {
                  if (typeof d[f] === 'string' && d[f].trim()) merged[f] = d[f];
                }
                return merged;
              }
              return op;
            }).filter(Boolean);
          }
        }
        // 锁覆盖整个读-改-写区间：跨进程实例不会各自读到旧版本再互相覆盖。
        // 锁内只有纯计算与落盘——没有 LLM 调用（LLM 在上面的锁外阶段已完成）。
        const result = await withExclusiveLock(file, async () => {
          const pb = await readOrInitPlaybook(file);
          // 快照之后别人改过手册 → 明确报错，不覆盖别人的写。
          const conflict = detectConflicts({ entries }, pb, finalOps);
          if (conflict) throw new Error('ace: ' + conflict);
          const r = applyOps(pb.entries, finalOps, live.maxEntries);
          await writeFileAtomic(file, serializePlaybook({ header: pb.header, entries: r.entries }));
          return r;
        });
        const addedEntries = result.entries.filter((e) => result.added.includes(e.id));
        const entriesBefore = result.entries.filter((e) => !result.added.includes(e.id));
        const mergeSuggestions = computeMergeSuggestions(entriesBefore, addedEntries);
        if (mergeSuggestions.length) {
          const iFile = inboxPath(file);
          await withExclusiveLock(iFile, async () => {
            const current = await readInbox(iFile);
            let items = current;
            for (const s of mergeSuggestions) {
              if (inboxFull(items)) break;
              const res = addToInbox(items, s);
              items = res.items;
            }
            await writeInboxAtomic(iFile, items);
            inboxCount = items.length;
          });
        }
        return { added: result.added };
      });
    } catch (e) {
      ctx.logger?.warn?.('dsh-ace: 自动复盘失败（' + (e?.message ?? e) + '）');
      st.mutCount = prevMutCount;
    }
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
      // 初始化（手册不存在时建文件）必须走 withLock + writeFileAtomic（红线 2）：
      // readOrInitPlaybook 的 ENOENT 分支会写盘，所以把它单独放进锁区间；
      // 后面的过滤/匹配计算在锁外做（锁区间内只允许纯计算）。
      const parsed = await withExclusiveLock(file, () => readOrInitPlaybook(file));
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
      // 同 ace_playbook：初始化会写盘，必须在锁内完成（红线 2）；
      // 随后的 LLM 调用在锁外（锁区间内不允许任何 LLM/网络调用）。
      const { entries } = await withExclusiveLock(file, () => readOrInitPlaybook(file));
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

  // —— 工具 3：ace_curate（增量并入手册；锁外读快照 + LLM 去重 → 锁内重读最新 + 冲突检测 + 增量应用 + 原子写） ——
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
          mergeSuggestions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          entryCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '手册更新完成：新增 ' + value.added.length + '，修改 ' + value.updated.length + '，删除 ' + value.removed.length +
          '，重复跳过 ' + value.duplicates.length + '，Curator 判定无新意丢弃 ' + value.droppedByCurator.length +
          '，疑似重复待合并 ' + value.mergeSuggestions.length + '；现有 ' + value.entryCount + ' 条。',
      }],
    },
    async execute(args, exec) {
      const file = await resolveFile(exec);
      const ops = args.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error('ace: ops 必须是非空数组');
      const droppedByCurator = [];
      const dedupe = args.dedupe !== false;
      const adds = ops.filter((o) => o && o.op === 'add');
      // —— 阶段 1（锁外）：读手册快照 + 跑 Curator 的 LLM ——
      // LLM 绝不能放在锁区间里：一次慢调用会把所有并发写者堵到锁超时，
      // 而旧的「超时即抢锁」语义还会直接导致丢写。锁内只允许纯计算与落盘。
      const snapshot = await readPlaybookSnapshot(file);
      let finalOps = ops;
      if (dedupe && adds.length && snapshot.entries.length) {
        const route = resolveRoute(live, exec);
        const raw = await oneShot(ctx, {
          provider: route.provider,
          model: route.model,
          system: CURATOR_SYSTEM,
          userText: curatorUserInput({ existing: digestEntries(snapshot.entries), candidates: adds }),
        });
        // 红线 3：LLM 输出必须先经 extractJsonObject 校验才允许进入落盘路径。
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
      // —— 阶段 2（锁内）：重新读最新手册 → 冲突检测 → 校验 → 原子写 ——
      // 互斥保护：同一路径的 curate 串行执行 —— withLock（同进程）+ withFileLock（跨进程），
      // 锁覆盖整个读-改-写区间（./playbook.js 的 withExclusiveLock）。
      return withExclusiveLock(file, async () => {
        const parsed = await readOrInitPlaybook(file);
        // 快照之后别人改过手册 → 明确报错，不静默丢弃、更不覆盖别人的写。
        const conflict = detectConflicts(snapshot, parsed, finalOps);
        if (conflict) throw new Error('ace: ' + conflict);
        const entriesBefore = parsed.entries.slice();
        const result = applyOps(parsed.entries, finalOps, live.maxEntries);
        const text = serializePlaybook({ header: parsed.header, entries: result.entries });
        await writeFileAtomic(file, text);
        const addedEntries = result.entries.filter((e) => result.added.includes(e.id));
        const mergeSuggestions = computeMergeSuggestions(entriesBefore, addedEntries);
        // 写入 merge-inbox（如果存在疑似重复）
        if (mergeSuggestions.length) {
          const iFile = path.join(path.dirname(file), 'merge-inbox');
          await withExclusiveLock(iFile, async () => {
            const current = await readInbox(iFile);
            let items = current;
            for (const s of mergeSuggestions) {
              if (inboxFull(items)) break;
              const res = addToInbox(items, s);
              items = res.items;
            }
            await writeInboxAtomic(iFile, items);
            inboxCount = items.length;
          });
        }
        return {
          added: result.added,
          updated: result.updated,
          removed: result.removed,
          duplicates: result.duplicates,
          droppedByCurator,
          mergeSuggestions,
          entryCount: result.entries.length,
        };
      });
    },
  }));

  // —— 命令：/ace（单命令，靠 invocation.rawInput 分流两个用途） ——
  // ctx.commands: CommandRuntime（~\dsh-commands\lib\types\index.d.ts:64-66）。
  // register(definition:CommandDefinition)（dsh-commands\lib\index.js:266-267，进 normalizeDefinition 同文件 :149-153）。
  // 命令名必须匹配 COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u（dsh-commands\lib\index.js:78）——空格非法，
  // 因此不存在 'ace review' 这种名字；子命令语义只能由 handler 读 rawInput 分流。
  // CommandInvocation.rawInput 契约原文（dsh-commands\lib\types\index.d.ts:24-25）：
  //   「Exact text following the registered command name, including separator whitespace.」
  // CommandResult 契约（dsh-commands\lib\types\types.d.ts:33-41）：{kind:'success',text?} | {kind:'error',text}，
  // 由 normalizeResult（dsh-commands\lib\index.js:184-204）校验，其它形状抛 TypeError。
  // CommandDefinition:{name,description,handler,input?}（dsh-commands\lib\types\index.d.ts:38-55）。
  // agent.followup(message)（~\dsh-agent\lib\types\runtime-types.d.ts:192）：排入普通 follow-up 回合并唤醒。
  // createUserMessage（~\@deepseek-ai\dsh-llm\lib\index.js:2429）。
  if (ctx.commands?.register) {
    ctx.commands.register({
      name: 'ace',
      description: '手动触发 ACE 复盘归档（reflect+curate）；输入 /ace review 注入待合并复审条目。',
      input: { hint: 'review' },
      handler: async (invocation) => {
        const agent = invocation?.agent;
        // rawInput = 命令名之后的原文（含分隔空白，契约见上）。trim() 后等于 'review' 走复审分支；
        // 空或其它值走默认复盘分支（/ace 本身的语义就是复盘，多写的文本仍当复盘摘要）。
        const sub = (invocation?.rawInput ?? '').trim();
        if (sub === 'review') {
          try {
            const file = await resolveFile({ agent });
            const iFile = inboxPath(file);
            const items = await readInbox(iFile);
            if (!items.length) return { kind: 'success', text: 'ace review: inbox 为空，无需审阅。' };
            const summary = items.length + ' 条疑似重复待审阅';
            const msg = createUserMessage({
              content: renderReviewText(items),
              source: { kind: 'dsh-ace', form: 'notice', summary },
            });
            // agent.followup（~\dsh-agent\lib\types\runtime-types.d.ts:192）
            if (agent?.followup) {
              agent.followup(msg);
              return { kind: 'success', text: 'ace review: 已注入 ' + items.length + ' 条待审阅条目。' };
            }
            return { kind: 'success', text: 'ace review: 当前环境不支持 followup。inbox 有 ' + items.length + ' 条。' };
          } catch (e) {
            return { kind: 'error', text: 'ace review: 失败（' + (e?.message ?? e) + '）' };
          }
        }
        if (!agent?.runMaintenance) return { kind: 'success', text: 'ace: 当前环境不支持 runMaintenance。' };
        try {
          const result = await agent.runMaintenance(async (signal) => {
            const file = await resolveFile({ agent });
            // 锁外只读快照（不写盘）；LLM 调用也全在锁外。
            const { entries } = await readPlaybookSnapshot(file);
            const route = resolveRoute(live, { agent });
            const raw = await oneShot(ctx, {
              provider: route.provider,
              model: route.model,
              system: REFLECTOR_SYSTEM,
              userText: reflectorUserInput({
                summary: invocation?.rawInput || '手动复盘',
                outcome: '',
                playbookDigest: digestEntries(entries).join('\n'),
              }),
              signal,
            });
            const parsed = extractJsonObject(raw);
            const candidates = Array.isArray(parsed.candidates)
              ? parsed.candidates.filter((c) => c && typeof c.title === 'string' && typeof c.condition === 'string' && typeof c.action === 'string' && typeof c.rationale === 'string')
              : [];
            if (!candidates.length) return { added: [] };
            const ops = candidates.map((c) => ({ op: 'add', ...c, auto: true }));
            let finalOps = ops;
            if (entries.length) {
              const curatorRaw = await oneShot(ctx, {
                provider: route.provider,
                model: route.model,
                system: CURATOR_SYSTEM,
                userText: curatorUserInput({ existing: digestEntries(entries), candidates: ops }),
                signal,
              });
              const decisions = extractJsonObject(curatorRaw).decisions;
              if (Array.isArray(decisions)) {
                finalOps = ops.map((op, i) => {
                  const d = decisions.find((x) => x && x.index === i);
                  if (!d || d.verdict === 'new') return op;
                  if (d.verdict === 'drop') return null;
                  if (d.verdict === 'update') {
                    const merged = { op: 'update', id: d.id, auto: true };
                    for (const f of ['title', 'condition', 'action', 'rationale']) {
                      if (typeof d[f] === 'string' && d[f].trim()) merged[f] = d[f];
                    }
                    return merged;
                  }
                  return op;
                }).filter(Boolean);
              }
            }
            const r = await withExclusiveLock(file, async () => {
              const pb = await readOrInitPlaybook(file);
              // 快照之后别人改过手册 → 明确报错，不覆盖别人的写。
              const conflict = detectConflicts({ entries }, pb, finalOps);
              if (conflict) throw new Error('ace: ' + conflict);
              const r = applyOps(pb.entries, finalOps, live.maxEntries);
              await writeFileAtomic(file, serializePlaybook({ header: pb.header, entries: r.entries }));
              return r;
            });
            return { added: r.added };
          });
          return { kind: 'success', text: 'ace: 复盘完成，新增 ' + (result?.added?.length || 0) + ' 条。' };
        } catch (e) {
          return { kind: 'error', text: 'ace: 复盘失败（' + (e?.message ?? e) + '）' };
        }
      },
    });
  }

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
      bounds: { maxEntries: MAX_ENTRIES_RANGE, autoRecapThreshold: [0, 1000], autoRecapCooldownTurns: [0, 1000] },
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
          // GET /api/dsh-ace/inbox：设置页「待合并复审」区块的数据源（只读）。
          // inbox 文件在宿主磁盘上（<playbook 目录>/merge-inbox），浏览器 fiber 读不到，
          // 所以走这条同源 HTTP 面，而不是让客户端猜路径。只读 GET，不加写操作
          // —— 写仍只走 lib 侧 withExclusiveLock（同进程 withLock + 跨进程 withFileLock）
          //    + writeFileAtomic（单写者原则）。
          if (routePath === '/inbox') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            try {
              // 空串（本机共享层）与绝对路径在这里都能解析——共享层的 inbox 因此能读到；
              // 只有「相对路径」才需要会话工作目录，而 HTTP 面没有会话上下文，
              // 此时解析抛错，按「暂无可看待合并条目」返回空列表，设置页照常渲染，不报错。
              const file = await resolveFile();
              const items = await readInbox(inboxPath(file));
              return send(200, { ok: true, items, full: inboxFull(items), cap: INBOX_CAP });
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法读取 merge-inbox（' + (error?.message ?? error) + '）');
              return send(200, { ok: true, items: [], full: false, cap: INBOX_CAP });
            }
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
            // 空串是合法值：表示本机共享手册（<DSH home>/ace/playbook.md）。
            if (value === undefined) error = 'playbookPath 必须是字符串（最多 1024 字符；留空表示本机共享手册）';
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
          if ('autoRecap' in body) {
            touched = true;
            const value = validFlag(body.autoRecap);
            if (value === undefined) error = 'autoRecap 必须是 true 或 false';
            else next.autoRecap = value;
          }
          if ('autoRecapThreshold' in body) {
            touched = true;
            const value = validInt(body.autoRecapThreshold, [0, 1000]);
            if (value === undefined) error = 'autoRecapThreshold 必须是 0–1000 的整数';
            else next.autoRecapThreshold = value;
          }
          if ('autoRecapCooldownTurns' in body) {
            touched = true;
            const value = validInt(body.autoRecapCooldownTurns, [0, 1000]);
            if (value === undefined) error = 'autoRecapCooldownTurns 必须是 0–1000 的整数';
            else next.autoRecapCooldownTurns = value;
          }
          if ('autoReviewInbox' in body) {
            touched = true;
            const value = validFlag(body.autoReviewInbox);
            if (value === undefined) error = 'autoReviewInbox 必须是 true 或 false';
            else next.autoReviewInbox = value;
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
            'dsh-ace: 设置已保存（手册 ' + displayPlaybookPath(ctx, live) + '，复盘提醒 ' + (live.autoReflect ? '开' : '关') +
            '，自动复盘 ' + (live.autoRecap ? '开' : '关') +
            '，容量 ' + live.maxEntries + '）',
          );
          return send(200, describe());
        },
      }),
      'dsh-ace: settings api',
    );
  });
}