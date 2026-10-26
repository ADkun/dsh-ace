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
import { REFLECTOR_SYSTEM, reflectorUserInput, extractJsonObject } from './prompts.js';
import { serializePlaybook, digestEntries, withExclusiveLock, readOrInitPlaybook, readPlaybookSnapshot, matchEntries, markHits } from './playbook.js';
import { resolveRoute, oneShot } from './llm.js';
import { buildCatalog } from './catalog.js';
import { resolveSettingsFile, resolveLegacySettingsFile, migrateSettingsFile } from './settings-path.js';
import { resolvePlaybookFile, resolveArchiveFile, playbookPathKind, resolveSharedPlaybookFile, DEFAULT_PLAYBOOK_PATH, DEFAULT_MAX_ENTRIES } from './playbook-path.js';
import { isMainAgent, isMutatingTool } from './trigger.js';
// isBusyError：判定「宿主正忙」（already has active work）这种预期内竞态，见 ./trigger.js。
import { isBusyError } from './trigger.js';
// createRecapController：回合内记账 + 空闲边沿执行的调度器（见 ./recap.js 头注）。
import { createRecapController } from './recap.js';
// renderTrajectory / collectTurnTrajectory / buildRecapSummary：把本回合真实轨迹渲染成
// 复盘模型的输入（见 ./trajectory.js 头注：只喂计数时 Reflector 实测 0 候选）。
import { collectTurnTrajectory, buildRecapSummary } from './trajectory.js';
// noticeMessage：把通知正文包成宿主契约要求的 ContentBlock[]（见 ./notice.js 头注：裸字符串会让
// 宿主的 .content.some 抛错，且那条毒消息留在历史里会让整个会话永久坏死）。
import { noticeMessage } from './notice.js';
import { INBOX_CAP, readInbox, writeInboxAtomic, addToInbox, inboxFull } from './inbox.js';
// collectPlaybookStats：设置页统计块的纯只读聚合（见 ./stats.js 头注：只 stat/read，不写盘不加锁）。
import { collectPlaybookStats, emptyStats, STATS_REASONS } from './stats.js';
// collectPlaybookEntries：设置页「记录列表详情页」的只读数据源（见 ./entries.js 头注：只 stat/read，不写盘不加锁）。
import { collectPlaybookEntries, emptyEntries, ENTRIES_REASONS } from './entries.js';
import { computeMergeSuggestions } from './merge.js';
// commitOps / commitMeta：锁内「读最新 → 逐条冲突判定 → 应用安全部分 → 原子写」（见 ./commit.js 头注）。
// commitMeta 是「只改元数据」的同类写入路径（命中计数 hits/lastHit 走它）。
// 复盘主体（runRecapPipeline）走 ./recap-pipeline.js，那一层不 import 宿主包、可独立测试。
import { commitOps, commitMeta } from './commit.js';
// decideCandidates / dayString：ace_curate 的确定性判定与归档日期
// （见 ./archive.js 头注：判定权从 LLM 收回给代码，归档永不物理删除）。
import { decideCandidates, dayString } from './archive.js';
// selectInjection / userTextOf / messageKeyOf / createInjectionCache：C5 自动注入的纯逻辑
// （见 ./inject.js 头注：纯 BM25 相关度排序、同分按 id 升序，900 token / 5 条预算）。
import { selectInjection, userTextOf, messageKeyOf, createInjectionCache, INJECT_MAX_ENTRIES } from './inject.js';
// 话题热度（第 36 轮）：只由「用户说过的话」驱动的环形窗口；注入结果一律不回流（反自增强）。
import { createHeatWindow, computeHeat } from './heat.js';
// playbookSectionText：系统提示段文本（**只有逐字常量**的机制说明），
// 见 ./prompt-section.js 头注：text 回调绝不抛错，且不许随运行状态变化（前缀缓存红线）。
import { playbookSectionText, playbookSectionSpec } from './prompt-section.js';
// createUsageLedger：C1 的命中账本（按 agent 分账的 WeakMap），见 ./ledger.js 头注。
import { createUsageLedger } from './ledger.js';
// createInjectionFlow：注入 id → 命中账本的接缝（C5.6），见 ./injection-flow.js 头注。
import { createInjectionFlow } from './injection-flow.js';
// createInjectionDelivery：注入**投递**（第 28 轮）—— 在 agent/pre-step 把注入块追加成一条
// user 消息，而不是改写系统提示段，见 ./inject-delivery.js 头注（前缀缓存红线）。
import { createInjectionDelivery } from './inject-delivery.js';
// runRecapPipeline：复盘主体（轮次编排 + 判定/归档 + 合并/淘汰 + merge-inbox），
// 见 ./recap-pipeline.js 头注 —— 那一层零宿主依赖，测试能真跑整链。
import { runRecapPipeline, makeArchivePlan, acceptCandidates } from './recap-pipeline.js';
// planEvictions：最少使用淘汰的排序与计划（第 33 轮，见 ./evict.js 头注）。
import { planEvictions } from './evict.js';
// MERGE_SYSTEM / mergePairInput：满额时的 LLM 合并（第 33 轮，见 ./merge-llm.js 头注）。
import { MERGE_SYSTEM, mergePairInput } from './merge-llm.js';
// createUserMessage：~\@deepseek-ai\dsh-llm\lib\index.js:2429（export list），message.d.ts:213。
import { createUserMessage } from '@deepseek-ai/dsh-llm';
// 注：曾经 import 过 @deepseek-ai/dsh-timeout 的 deadline，但从未使用（孤儿 import），已删除。
// 本插件的唯一超时点是 lib/catalog.js 的 withTimeout（模型目录逐 provider 兜底）：
// deadline 的价值在于把 AbortSignal 往下游传播，而 LlmRuntime.listModels(provider)
// 的签名不接受 signal（~\dsh-llm\lib\types\index.d.ts:367），换过去既不会 abort 上游，
// 也只会把「超时后留一个悬挂 promise」原样保留，还平白多一个宿主依赖 —— 故不改写。

export const name = 'dsh-ace';

// 依赖的宿主服务（dsh-tool-todo 的 inject 同款声明：~\dsh-tool-todo\lib\index.js:12）。
// 'agents' 已移出：拆掉「有没有在跑的子代理」那道门之后，本插件不再读 ctx.agents
// （红线：inject 数组只声明真正用到的服务）。
export const inject = ['tools', 'systemPrompt', 'llm', 'workingDirectory', 'commands'];

/**
 * 第 36 轮新增三个可调项的区间与默认值。
 * 设置页的 min/max 只从 describe().bounds 出（客户端不写死任何数字），这里同时充当
 * 「配置键默认值」与「已存值非法时的回落值」两用，所以必须是模块级常量。
 */
const EVICT_PROTECT_DAYS_RANGE = [0, 365];
const INJECT_TOKEN_BUDGET_RANGE = [100, 8000];
const INJECT_MAX_ENTRIES_RANGE = [1, 20];
const DEFAULT_EVICT_PROTECT_DAYS = 14;
const DEFAULT_INJECT_TOKEN_BUDGET = 900;
const DEFAULT_INJECT_MAX_ENTRIES = 5;

/** 插件配置（cordis config schema；字段语义见 README「配置」节）。 */
export const Config = z.object({
  playbookPath: z.string()
    .description('手册 Markdown 路径。留空 = 本机共享手册（<DSH home>/ace/playbook.md，跨工作区共用一本）；绝对路径（支持 ~ / ~/ / ~\\ 前缀）原样使用；相对路径相对会话工作目录解析，即该工作区私有')
    .default(DEFAULT_PLAYBOOK_PATH),
  autoReflect: z.boolean().description('是否在系统提示里提醒 agent 任务完成后主动复盘').default(true),
  reflectProvider: z.string().description('Reflector/Curator 覆盖 provider；留空跟随会话模型').default(''),
  reflectModel: z.string().description('Reflector/Curator 覆盖 model；留空跟随会话模型').default(''),
  maxEntries: z.number().description('手册最大条目数；超出后先由 LLM 合并相近条目，仍超则按命中次数（hits）从少到多淘汰，被淘汰的搬进同目录的 archive.md').default(DEFAULT_MAX_ENTRIES),
  evictProtectDays: z.number().description('新条目保护期（天）：created 距今不足 N 天的条目优先不淘汰，让刚写下的经验有机会被用上一次；默认 14，0 = 不保护').default(DEFAULT_EVICT_PROTECT_DAYS),
  injectTokenBudget: z.number().description('每次自动注入的 token 预算；调大 = 注入更多经验、更费 token，调小 = 更省 token；默认 900').default(DEFAULT_INJECT_TOKEN_BUDGET),
  injectMaxEntries: z.number().description('每次自动注入最多几条经验；调大 = 一次注入更多条，调小 = 更少；默认 5').default(DEFAULT_INJECT_MAX_ENTRIES),
  autoRecap: z.boolean().description('主代理回合结束时自动复盘归档（reflect+curate），无需模型主动调用').default(true),
  autoRecapThreshold: z.number().description('触发自动复盘所需的 mutating 工具调用下限').default(1),
  autoRecapCooldownTurns: z.number().description('距上次自动复盘至少隔几轮').default(2),
  autoReviewInbox: z.boolean().description('预留开关，当前不生效：merge-inbox 的复审入口是设置页「待合并复审」区块或对话里的 /ace review').default(false),
});

const FIELD_TITLES = { title: '标题', condition: '条件', action: '做法', rationale: '依据' };

/**
 * 冲突报告的固定措辞（缺陷 B：冲突必须对用户可见，不能只写日志）。
 * 三条写入路径（ace_curate / 自动复盘 / /ace 的默认复盘分支）共用同一句人话。
 * 注意：/ace review 只读 merge-inbox、不写手册，因此不在其中。
 */
const CONFLICT_HINT = '手册在本次复盘期间被别的进程改过';

/**
 * 把结构化冲突列表渲染成一句人话 + 逐条清单。
 * @param {Array} conflicts - detectAllConflicts 返回的 conflicts 数组
 * @returns {string} 例如「手册在本次复盘期间被别的进程改过，这 2 条没并入，重试即可：（1）…；（2）…」
 */
function renderConflictNotice(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts : [];
  if (!list.length) return '';
  const items = list.map((c, i) => {
    const what = c.op === 'add' ? ('新增《' + (c.title || '') + '》') : (c.op + ' ' + (c.id || ''));
    return '（' + (i + 1) + '）' + what + '：' + (c.reason || '');
  });
  return CONFLICT_HINT + '，这 ' + list.length + ' 条没并入，重试即可：' + items.join('；');
}

/**
 * 把冲突报告成一条宿主消息（自动复盘 / /ace 的默认复盘分支用）。
 * 手法与 /ace review 注入待审阅条目同源：createUserMessage + source{kind:'dsh-ace',form:'notice'}。
 * API 出处：createUserMessage ~\@deepseek-ai\dsh-llm\lib\index.js:59；
 * ContextForm 'notice' 与必带 summary ~\@deepseek-ai\dsh-llm\lib\types\message.d.ts:46-58,75-91。
 */
function conflictMessage(conflicts) {
  const text = renderConflictNotice(conflicts);
  // content 必须是 ContentBlock[]（MessageBase.content，message.d.ts:128）：宿主不校验形状，
  // 裸字符串会原样进会话历史、让宿主里的 .content.some 抛错。形状由 noticeMessage 统一保证。
  return createUserMessage(noticeMessage({
    text,
    summary: 'ACE 手册有 ' + conflicts.length + ' 条改动因并发冲突未并入',
  }));
}

/**
 * 把冲突报告送到用户眼前（缺陷 B：不能只写日志）。
 *
 * 首选 agent.followup —— 排入一个普通 follow-up 回合并**唤醒**驱动，agent 因此
 * 真的会读到这条提示（/ace review 注入待审阅条目用的就是这一手）；
 * 若宿主没有 followup，退回 agent.inject（排入下一轮上下文，不唤醒驱动，
 * 用户下次说话时 agent 会读到）。
 * API 出处：agent.followup ~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:192；
 * agent.inject 同文件 :209。
 *
 * @param {object} agent - 宿主 agent 运行时
 * @param {Array} conflicts - 结构化冲突列表
 * @returns {boolean} 是否至少用一条通道把消息送出去了
 */
function reportConflicts(agent, conflicts) {
  if (!agent || !Array.isArray(conflicts) || !conflicts.length) return false;
  return sendNotice(agent, conflictMessage(conflicts));
}

/**
 * 把一条宿主消息送到用户眼前：首选 followup（唤醒驱动），退回 inject（排入下一轮上下文）。
 * API 出处：agent.followup ~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:192；
 * agent.inject 同文件 :209。
 * @param {object} agent - 宿主 agent 运行时
 * @param {object} message - createUserMessage 造好的宿主消息
 * @returns {boolean} 是否送出去了
 */
function sendNotice(agent, message) {
  if (!agent || !message) return false;
  try {
    if (typeof agent.followup === 'function') { agent.followup(message); return true; }
  } catch { /* 退到 inject */ }
  try {
    if (typeof agent.inject === 'function') { agent.inject(message); return true; }
  } catch { /* 宿主两条通道都不可用 */ }
  return false;
}

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
 * 读设置文件时的整数口径：undefined / null / 空串 / 非有限数一律当「没填」（返回 undefined，
 * 由默认值兜底），**绝不许把 null 或空白串折算成 0**。
 * 这一点对 evictProtectDays 尤其致命：它的合法区间含 0（= 不保护），
 * 而 `Number(null)` 与 `Number('')` 恰好都是 0 —— 只用 validInt 会把手改坏的文件静默读成「不保护」。
 */
function validTunableInt(value, [min, max]) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return validInt(value, [min, max]);
}

/**
 * 第 36 轮三个可调项的数值口径（与 lib/trigger.js 的 numberOrDefault 同一套判据）：
 * undefined / null / 空串 / 非有限数才回落默认值 —— **显式 0 是有效值**，
 * 绝不能被 `||` 吞掉（evictProtectDays = 0 就是「不保护新条目」这一档）。
 */
function settingsNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 生效的新条目保护期（天）；非法值回落默认 14，0 原样保留（= 不保护）。 */
function evictProtectDaysOf(value) {
  return Math.floor(settingsNumber(value, DEFAULT_EVICT_PROTECT_DAYS));
}

/** 生效的注入 token 预算；非法值回落默认 900（调用点再兜底到 INJECT_TOKEN_BUDGET）。 */
function injectTokenBudgetOf(value) {
  return Math.floor(settingsNumber(value, DEFAULT_INJECT_TOKEN_BUDGET));
}

/** 生效的注入条数上限；非法值回落默认 5（调用点再兜底到 INJECT_MAX_ENTRIES）。 */
function injectMaxEntriesOf(value) {
  return Math.floor(settingsNumber(value, DEFAULT_INJECT_MAX_ENTRIES));
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
  const evictProtectDays = validTunableInt(raw.evictProtectDays, EVICT_PROTECT_DAYS_RANGE);
  if (evictProtectDays !== undefined) settings.evictProtectDays = evictProtectDays;
  if (raw.evictProtectDays !== undefined && evictProtectDays === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 evictProtectDays（需为 ${EVICT_PROTECT_DAYS_RANGE[0]}–${EVICT_PROTECT_DAYS_RANGE[1]} 的整数）`);
  }
  const injectTokenBudget = validTunableInt(raw.injectTokenBudget, INJECT_TOKEN_BUDGET_RANGE);
  if (injectTokenBudget !== undefined) settings.injectTokenBudget = injectTokenBudget;
  if (raw.injectTokenBudget !== undefined && injectTokenBudget === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 injectTokenBudget（需为 ${INJECT_TOKEN_BUDGET_RANGE[0]}–${INJECT_TOKEN_BUDGET_RANGE[1]} 的整数）`);
  }
  const injectMaxEntries = validTunableInt(raw.injectMaxEntries, INJECT_MAX_ENTRIES_RANGE);
  if (injectMaxEntries !== undefined) settings.injectMaxEntries = injectMaxEntries;
  if (raw.injectMaxEntries !== undefined && injectMaxEntries === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 injectMaxEntries（需为 ${INJECT_MAX_ENTRIES_RANGE[0]}–${INJECT_MAX_ENTRIES_RANGE[1]} 的整数）`);
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
    for (const key of ['playbookPath', 'autoReflect', 'reflectProvider', 'reflectModel', 'maxEntries', 'evictProtectDays', 'injectTokenBudget', 'injectMaxEntries', 'autoRecap', 'autoRecapThreshold', 'autoRecapCooldownTurns', 'autoReviewInbox']) {
      if (stored[key] !== undefined) next[key] = stored[key];
    }
    Object.assign(live, next);
  };
  applyStored();

  const resolveFile = makeResolver(ctx, live);
  // 归档文件与手册**同目录**（第 33 轮：归档从手册的「## 归档区」章节搬进独立 archive.md）。
  // 只从手册路径派生，不给单独的配置项 —— 见 lib/playbook-path.js 的 resolveArchiveFile。
  const resolveArchive = async (exec) => {
    if (playbookPathKind(live.playbookPath) !== 'relative') {
      return resolveArchiveFile(live.playbookPath, { ctx });
    }
    const wd = exec && exec.agent ? await ctx.workingDirectory.ensure(exec.agent) : undefined;
    return resolveArchiveFile(live.playbookPath, { ctx, workingDirectory: wd });
  };

  // —— C5 自动注入的接缝：按 agent 分账的命中账本 + 检索结果缓存 ——
  // ledger 是「本轮真的被用上的条目 id」账本（lib/ledger.js）。第 33 轮起它的语义是
  // **hits 的唯一来源**（不再是 ±1 计分）：注入消息真的追加进历史、或 ace_playbook 带
  // id/query 定向查到了，就在账本里记一笔，回合边界一次原子写盘成 hits+1。
  // injectionCache 缓存「最近一条用户消息 → 检索出的注入块」，同一条消息每个 step 不重复检索。
  const ledger = createUsageLedger();
  const injectionCache = createInjectionCache();
  const injectionFlow = createInjectionFlow({ cache: injectionCache, ledger });
  // —— 设置页「ACE 运行统计」的内存计数（C6，零成本可观测）——
  // 进程内存态，重启即归零；**不新增任何落盘文件**：每次累计都配一行 ctx.logger 日志，
  // 页面上的数与本进程日志能一一对上。各项见 runtimeSnapshot()。
  //
  // 注入口径（第 28 轮纠正）：注入从「改写系统提示」改成「agent/pre-step 追加一条 user 消息」，
  // 于是把原来一个 injected 拆成两个量级不同的数 ——
  //   batches   每收到一条新用户消息、预检索挑出一批经验就 +1（量级≈用户消息数）
  //   appended  这一批真的追加进历史才 +1（同一批只 +1；量级≈用户消息数，但永远 <= batches）
  // skipped = 收到新消息但预检索没挑出任何经验；failed = 预检索或追加抛错。
  // （第 33 轮：probation 考察位已随出局线一并删除。）
  // 话题热度窗口：按 agent 隔离（WeakMap），每条用户消息压一行，只保留最近 30 条。
  const heatWindow = createHeatWindow();

  const injectionStats = { batches: 0, appended: 0, skipped: 0, failed: 0 };
  // 检索命中（第 33 轮）：ace_playbook 带 id / query 的**定向检索**真正命中的条目数累计。
  // 整本读取不计数 —— 那不是「用上了某条经验」，只是翻了一下目录。
  const retrievalStats = { hits: 0 };
  // byReason 的键必须与 lib/archive-file.js 的 ARCHIVE_REASONS 对齐（四种结构性原因），
  // 否则 noteArchived 里「byReason[reason] !== undefined」的守卫会静默丢掉这一类归档数。
  // 淘汰数 / 合并数不单独记，直接读 byReason.evicted / byReason.merged（同一份真相，不会对不上）。
  const archiveStats = { archived: 0, byReason: { superseded: 0, 'removed-by-request': 0, evicted: 0, merged: 0 } };
  // 复盘次数 / 候选数 / 落盘数（第 33 轮：helpful/harmful/unobserved/gateRejected 全部删除）。
  // rejected = 标题为空的候选条数（唯一保留的候选过滤判据）。
  const recapStats = { recaps: 0, candidates: 0, written: 0, rejected: 0 };

  /**
   * 把计数器摊平成 GET /api/dsh-ace/stats 的 runtime 块（第 33 轮的六个数字）。
   * 归一化（缺字段补 0）在 lib/stats.js 的 normalizeRuntime 里做，这里只负责取值。
   */
  function runtimeSnapshot() {
    return {
      injectedBatches: injectionStats.batches,
      injectedAppended: injectionStats.appended,
      retrievalHits: retrievalStats.hits,
      evicted: archiveStats.byReason.evicted,
      merged: archiveStats.byReason.merged,
      archived: archiveStats.archived,
      archivedByReason: { ...archiveStats.byReason },
    };
  }

  /**
   * 归档记账（C6 可观测）：把本次搬进归档文件（archive.md）的条目累加进 archiveStats。
   * 未知原因计入总数但分列不增，并 warn 一行 —— 静默丢弃会让「归档数少了」
   * 看起来像归档没跑（P0-1 新增 removed-by-request 时踩过一次）。
   *
   * @param {Array<{id?: string, reason?: string, supersededBy?: string}>} list 本次归档的条目摘要
   * @returns {number} 本次计入的归档条数
   */
  function noteArchived(list) {
    if (!Array.isArray(list) || !list.length) return 0;
    for (const item of list) {
      const reason = item && typeof item.reason === 'string' ? item.reason : '';
      archiveStats.archived += 1;
      if (archiveStats.byReason[reason] !== undefined) archiveStats.byReason[reason] += 1;
      else ctx.logger?.warn?.('dsh-ace: 未知归档原因 ' + reason + '，已计入总数但未分列');
    }
    return list.length;
  }

  /**
   * 落盘记账（C6 可观测）：written = 新增 + 原地更新（commitOps 的语义），
   * 归档与去重丢弃不算落盘。source 只用于日志（'复盘' / 'ace_curate'）。
   *
   * @param {object} result commitOps 的 result（{added, updated, entries, ...}）
   * @param {string} source 写入来源，仅用于日志
   * @returns {number} 本次计入的落盘条数
   */
  function noteWritten(result, source) {
    const r = result && typeof result === 'object' ? result : {};
    const added = Array.isArray(r.added) ? r.added.length : 0;
    const updated = Array.isArray(r.updated) ? r.updated.length : 0;
    const written = added + updated;
    recapStats.written += written;
    const active = Array.isArray(r.entries) ? r.entries.length : 0;
    ctx.logger?.info?.('dsh-ace: 条目落盘（' + source + '）新增 ' + added + ' 条、更新 ' + updated + ' 条，当前活跃 ' + active + ' 条');
    return written;
  }

  // —— 系统提示段：何时主动复盘 ——
  // autoRecap 开：措辞改为"采集已自动"。
  // autoRecap 关 + autoReflect 开：保留原措辞（要求模型主动复盘）。
  //
  // 第 28 轮删除：「手册里有 N 条疑似重复条目」那条聚合提示。
  // 它随 merge-inbox 的条数变化，而这个 section 的文本会**原地重写进首个系统节点**
  // （路由没有声明 systemPromptUpdate:'in-history'），于是每写一条 merge-inbox，
  // 从系统提示注入点往后整段缓存前缀全部作废。系统提示段现在只允许逐字常量，
  // 见 ./prompt-section.js 头注。待合并条目数仍有出口：HTTP GET /api/dsh-ace/inbox
  // 与 /ace review（把条目正文投递给模型复审），只是不再进系统提示。
  function inboxPath(file) { return path.join(path.dirname(file), 'merge-inbox'); }

  /**
   * 把 merge-inbox 条目渲染成模型可读的复审提示（/ace review 注入对话用）。
   * item 只有 { newEntryId, newEntryTitle, bestMatchId, bestMatchTitle, score, selfScore, ratio }
   * （lib/merge.js:118-126），没有条目正文 —— 所以注入 id 对子，正文让模型自己用
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
  // 系统提示段（第 28 轮）：**只剩逐字常量**的机制说明。
  // 注入块搬去了 agent/pre-step（追加成一条 user 消息，见本文件下面的 pre-step 订阅与
  // ./inject-delivery.js 头注）—— 系统提示一旦随状态变化，宿主就得原地重写首个系统节点，
  // 从注入点往后整段前缀缓存全部作废（实测 cached 恒 8,320 tok、73 次切换累计重付 926.0K token）。
  // P0-3：section 的注册选项由 playbookSectionSpec 产出 —— 它把 interpolate 写死成 false。
  // 宿主的 interpolate() 遇到 {{...}} 会硬抛（dsh-system-prompt\lib\index.js:158-181，
  // 非法变量名报 malformed prompt variable reference "{{ user_name }}" in section "ace-playbook"），
  // 而 agent-loop 的 renderPrompt 没有 try/catch、kick() 是 catch (_error) {} ——
  // 一次抛错会让**整个 agent 回合被静默终止**，用户什么都看不到。
  // 手册条目里写模板语法 / Jinja / 代码片段极其常见，所以这条不能靠自觉，
  // 由工厂函数统一产出（tests/prompt-section.test.mjs 直接断言这个对象）。
  // 这个回调不接收任何运行状态（连 context 都不读）：同样的开关与路径 → 同样的字节。
  // 它绝不抛错 —— playbookSectionText 只做字符串拼接与 defuseTemplateSyntax，
  // 没有任何可能抛出的分支（见 tests/prompt-section.test.mjs 的逐字断言）。
  ctx.systemPrompt.section(playbookSectionSpec({
    text: () => playbookSectionText({
      autoRecap: live.autoRecap,
      autoReflect: live.autoReflect,
      pathText: displayPlaybookPath(ctx, live),
    }),
  }));

  // —— 自动复盘：tools/result 计数 + 回合内记账 + 空闲边沿执行 ——
  // 事件出处（DSH checkout ~）：
  // - tools/result：~\dsh-tools\lib\types\index.d.ts:92（emit，scope-filtered by exec.agent L87）。
  //   exec.name=工具名（L223），exec.agent=调用 agent（L229）。
  // - agent/turn-stopping：~\dsh-agent\lib\types\runtime-types.d.ts:387-391（serial，payload {agent,turn,signal}）。
  // - agent/status：~\dsh-agent\lib\types\runtime-types.d.ts:252-255（emit，payload {agent,status}）。
  // - agent.runMaintenance：~\dsh-agent\lib\types\runtime-types.d.ts:174（从 idle 运行非回合维护）。
  // - agent.whenIdle：~\dsh-agent\lib\types\runtime-types.d.ts:164。
  // - isMainAgent：agent.session.header.origin !== 'subagent'（~\dsh-session\lib\types\types.d.ts:82）。
  //
  // 时机（关键）：维护任务只在宿主的 idle 相位合法
  // （~\@deepseek-ai\dsh-agent-loop\lib\index.js:823 在 phase.kind !== 'idle' 时同步抛
  // 「agent already has active work」），而 agent/turn-stopping 在 turn() 内部派发、
  // turn() 开头同文件 :939 断言 phase 是 running —— 回合内跑维护必然抛错。
  // 所以回合内**只记账与判定**，真正复盘等 agent/status 报 idle 的空闲边沿
  // （宿主 kick 的 finally 同文件 :887-901 → setPhase :794-799 emit agent/status）。
  const recapController = createRecapController({
    getConfig: () => live,
    logger: ctx.logger,
    // 真实失败（LLM 调用失败、手册写入失败等）才给用户推一条提示；宿主忙碌这种预期内竞态只写日志。
    notifyFailure: (agent, reason) => {
      try {
        // content 必须是 ContentBlock[]：这条通知正是当初把裸字符串写进会话历史、
        // 让该会话此后每一轮都撞 .content.some 的那个来源（见 ./notice.js 头注）。
        sendNotice(agent, createUserMessage(noticeMessage({
          text: 'ACE 自动复盘未完成：' + reason + '。本次沉淀的经验没有并入手册，可重试。',
          summary: 'ACE 自动复盘未完成，经验未并入手册',
        })));
      } catch { /* 注入失败只记录日志，不让复盘失败变成未捕获异常 */ }
    },
    // 命中记账（第 33 轮）：账本在**回合边界**（agent/turn-stopping）一次取走并落盘。
    // 取走是同步的（ledger.take 只认内存），落盘异步串行跟在后面 —— 这样即使写盘很慢、
    // 甚至写盘失败，也不会把 id 留在账本里被下一个回合重复记一次（旧代码在这里踩过：
    // 回合 A 的注入被记成回合 B 的结果，A 自己的账永久丢失）。
    // 第 34 轮：这里的写盘失败不再只 warn —— recordHits 用 throwOnError:true 把失败抛给调度器，
    // 调度器随即借 noteHitIds 把这批 id **写回账本**，下一个回合边界连同新命中一起重试。
    // 「只 warn」的承诺以前是假的（账本早已取空，命中真丢），现在才是真的尽力重试。
    takeHitIds: (agent) => ledger.take(agent),
    noteHitIds: (agent, ids) => ledger.note(agent, ids),
    flushHits: async ({ agent: hitAgent, ids }) => {
      const file = await resolveFile({ agent: hitAgent });
      const snapshot = await readPlaybookSnapshot(file);
      return recordHits(hitAgent, file, snapshot, ids, { throwOnError: true });
    },
    runRecap: async (agent, pending) => {
      // 喂真轨迹（关键）：只喂「本回合有 N 次 mutating 工具调用」这句计数时，同一个 Reflector
      // 实测返回 candidates: []（notes：「没有任务目标、工具序列或错误细节，无法据此提炼可泛化经验」），
      // 喂真实任务的完整轨迹才产出 6 条候选。所以这里先从宿主会话取模型可见历史并渲染成紧凑轨迹。
      // 轨迹为空（宿主 API 拿不到 / 抛错 / 会话为空）就**不调 LLM**：没有材料可提炼，调了必然 0 条，
      // 白白花一次 LLM 调用与 token。
      const trajectory = collectTurnTrajectory(agent, ctx.logger);
      if (!trajectory || !trajectory.text) {
        // 返回 {skipped:true} 而不是裸 return：调度器据此把挂待办时吃掉的冷却与 mutating
        // 计数还回状态（见 lib/trigger.js 的 abandonPendingRecap）——「没材料」不是「复盘过了」。
        ctx.logger?.info?.('dsh-ace: 本回合没有可用的轨迹（deriveMessages 不可用或为空），跳过自动复盘，不调 LLM');
        return { skipped: true };
      }
      const summary = buildRecapSummary({ mutCount: pending.mutCount, trajectory });
      await agent.runMaintenance(async (signal) => {
        await executeRecap({ agent, summary, signal });
      });
    },
  });

  ctx.on('tools/result', (exec) => {
    if (!exec || !exec.agent) return;
    if (!isMainAgent(exec.agent)) return;
    // 第 33 轮：工具的成败不再参与任何判定（宿主 isError 归因不可靠，见 DESIGN.md），
    // 这里只剩「本回合有没有动过手」这一个用途 —— 触发自动复盘的阈值。
    if (!isMutatingTool(exec.name)) return;
    recapController.countMutating(exec.agent);
  });

  // 回合内只记账与判定：不调 runMaintenance、不调 LLM（宿主此刻是 running，见上面的时机说明）。
  ctx.on('agent/turn-stopping', (payload) => {
    recapController.onTurnStopping(payload);
  });

  // 空闲边沿才真正执行复盘（宿主此刻已是 idle 相位，runMaintenance 合法）。
  ctx.on('agent/status', (payload) => {
    void recapController.onStatus(payload);
  });

  // —— C5.1 取词：订阅 agent/inbox/inserted，按 agent 记住最近一条用户消息并预检索 ——
  // 事件出处：~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:263
  // 「One message entered the live inbox」，payload { agent, message }；
  // 发射点 ~\@deepseek-ai\dsh-agent-loop\lib\index.js:206（payload 里只有 message，
  // agent 由 cordis 的 Scoped 补上，消费范式见 ~\dsh-goal-round-driver\lib\index.js:249）。
  //
  // 为什么在这里检索而不是在系统提示的 text 回调里：那个回调是同步的，而且拿不到消息
  // （~\@deepseek-ai\dsh-system-prompt\lib\types\index.d.ts:37-45 只有 scope/signal）。
  // 所以「收到用户消息 → 异步读手册算 top N → 发布进缓存」，随后由 agent/pre-step 投递
  // （见本文件下面的 pre-step 订阅：把这一批追加成一条 user 消息）。
  // 同一条消息只算一次（messageKeyOf 缓存键），一个回合里每个 step 都不会重算、也不会重复追加。
  //
  // 计数（第 28 轮口径）：batches = 这里真正发布了一批（≈ 用户消息数）；
  // skipped = 收到新消息但没挑出任何经验；failed = 预检索抛错。
  // 「真的追加进历史」是另一本账（appended，见 inject-delivery.js）。
  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent;
    const message = payload?.message;
    if (!agent || !message) return;
    if (message.role !== 'user') return;
    if (!live.autoRecap && !live.autoReflect) return; // 系统提示段本身就不注册任何内容
    const key = messageKeyOf(message);
    if (injectionCache.get(agent, key)) return;
    const query = userTextOf(message);
    if (!query) return;
    // 话题热度只在这里产生：用户真的说了这句话（预检索之后的结果绝不回流，见 lib/heat.js）。
    heatWindow.note(agent, query);
    void (async () => {
      try {
        const file = await resolveFile({ agent });
        const snapshot = await readPlaybookSnapshot(file);
        // 归档条目不在 snapshot.entries 里：归档早就搬进独立文件 archive.md（第 33 轮），
        // 注入根本不读那个文件，所以归档条目天然不参与注入。
        // 排序 = 0.9×相关度 + 0.1×归一化话题热度 → 条数 / token 预算取自设置页配置
        // （lib/index.js 的 injectMaxEntries / injectTokenBudget，常量仍作兜底默认）。
        const heat = computeHeat(snapshot.entries, heatWindow.messagesOf(agent));
        const picked = selectInjection(snapshot.entries, query, {
          maxEntries: injectMaxEntriesOf(live.injectMaxEntries),
          tokenBudget: injectTokenBudgetOf(live.injectTokenBudget),
          heat,
        });
        if (!picked.count) {
          injectionCache.set(agent, key, { key, text: '', ids: [], tokens: 0, count: 0 });
          injectionStats.skipped += 1;
          return;
        }
        injectionFlow.publish(agent, key, picked);
        injectionStats.batches += 1;
        ctx.logger?.info?.('dsh-ace: 注入批次已发布（' + picked.ids.length + ' 条经验：' + picked.ids.join(', ')
          + '，约 ' + (picked.tokens || 0) + ' token；累计批次 ' + injectionStats.batches + '）');
      } catch (error) {
        // 注入是增强项：检索失败绝不能影响宿主收消息。
        injectionStats.failed += 1;
        ctx.logger?.warn?.('dsh-ace: 注入的预检索失败，本回合不注入（' + ((error && error.message) || error) + '）');
      }
    })();
  });

  // —— 注入投递（第 28 轮）：把这一批经验**追加成一条 user 消息**，而不是改写系统提示 ——
  //
  // 宿主接缝（照第一方 dsh-agent-instructions 的写法）：
  //   ~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:304（'agent/pre-step'）、
  //   :92-99（PreStepDecision）；宿主实现 ~\@deepseek-ai\dsh-agent-loop\lib\index.js:902-927；
  //   第一方范例 ~\dsh-agent-instructions\lib\index.js:1406-1424（先 await next()，再 toSpliced 插入）。
  // waterfall 规则（宿主 practices.md:16）：不拥有决策就原样返回 next()；改写决策必须 spread 保留
  // 其它字段（尤其 startsRequestSeries）。
  //
  // 为什么必须追加进历史：系统提示在请求最前面，这条路由没有声明 systemPromptUpdate:'in-history'，
  // 宿主只能原地重写首个系统节点 —— 换一批经验，从注入点往后整段前缀缓存全部作废。
  // 追加一条消息只往历史尾部加节点，前缀一个字节都不动。详见 ./inject-delivery.js 头注。
  //
  // 全部逻辑在 ./inject-delivery.js（不 import 宿主包，可脱离宿主真跑测试）；
  // 这里只做薄委托 + 把宿主的 createUserMessage 注入进去。
  const injectionDelivery = createInjectionDelivery({
    flow: injectionFlow,
    createUserMessage,
    stats: injectionStats,
    logger: ctx.logger,
  });
  ctx.on('agent/pre-step', (payload, next) => injectionDelivery.onPreStep(payload, next));

  // —— 命中计数（第 33 轮）：hits 是**唯一的淘汰依据**，不再有任何正负评分 ——
  //
  // 账本只记住「本轮被**自动注入**（真的追加进历史）的条目 id」：
  //   唯一写入点是 injectionFlow.take → ledger.note（lib/injection-flow.js）。
  //   ace_playbook 的**检索命中不进这本账** —— 检索 ≠ 注入。检索命中当场记 hits
  //   （见下面 ace_playbook 的 retrievalHits 与 recordHits），但不进回合账本：
  //   回合账本是「这一轮真的用上了什么」，一次「顺手查一下手册」不该被当成「用了它」。
  // 回合边界（agent/turn-stopping）一次取走并原子写盘（flushHits → recordHits），
  // 然后账本清空 —— 一个回合只落一次盘，不是每次注入都写一遍文件。
  // 条目按 agent 分账：不同 agent 的回合彼此独立，不会把 A 的注入记到 B 的名下。
  // 实现抽到 lib/ledger.js（createUsageLedger），这里只是薄封装，便于单测（tests/ledger.test.mjs）。

  /**
   * 命中计数落盘：命中的条目 hits+1、lastHit=此刻（手册文件本身，走锁 + 原子写）。
   * 冲突（别的进程在快照之后改过该条目）只写日志，不静默覆盖；这属于副作用，绝不影响检索结果。
   *
   * @param {object} [options]
   * @param {boolean} [options.throwOnError] - 写盘失败时把错误抛出去而不是吞掉。只有**回合边界**
   *   那条路径（flushHits）传 true：那里没有「检索结果」可保，吞掉等于把这批命中真的丢掉；
   *   ace_playbook 检索路径不传，写盘失败照旧只记日志、不影响检索。
   */
  async function recordHits(agent, file, snapshot, hitIds, options = {}) {
    if (!hitIds.length) return { changed: [], conflicts: [] };
    try {
      const { conflicts, changed } = await commitMeta(file, snapshot, {
        ids: hitIds,
        apply: (entries, safeIds) => {
          const res = markHits(entries, safeIds);
          return { entries: res.entries, changed: res.hit };
        },
      });
      if (conflicts.length) ctx.logger?.info?.('dsh-ace: 命中计数撞上并发改动，已按冲突回报跳过 ' + conflicts.length + ' 条（不静默覆盖）');
      return { changed, conflicts };
    } catch (error) {
      // 记命是副作用：写盘失败不能把一次正常的检索（ace_playbook）变成报错。
      ctx.logger?.info?.('dsh-ace: 命中计数写入失败（' + ((error && error.message) || error) + '），检索结果照常返回');
      // 唯一例外是**回合边界**那条路径（flushHits，throwOnError:true）：那里没有「检索结果」可保，
      // 失败还把命中静默吞掉才是真损失 —— 抛给调度器，由它把这批 id 退回账本等下一个回合重试。
      if (options && options.throwOnError) throw error;
      return { changed: [], conflicts: [] };
    }
  }

  /**
   * 一次 Reflector 调用：喂轨迹（+ 多轮时追加「已提炼候选」）→ 解析 → 过滤出合法候选。
   * LLM 输出必须先过 extractJsonObject 校验（红线 3），四个字段齐全才算候选。
   *
   * @returns {Promise<object[]>} 本轮的候选（可能是空数组）
   */
  async function reflectRound({ agent, summary, outcome, playbookDigest, route, signal, priorCandidates, round }) {
    const raw = await oneShot(ctx, {
      provider: route.provider,
      model: route.model,
      system: REFLECTOR_SYSTEM,
      userText: reflectorUserInput({ summary, outcome, playbookDigest, priorCandidates, round }),
      signal,
    });
    const parsed = extractJsonObject(raw);
    return Array.isArray(parsed.candidates)
      ? parsed.candidates.filter((c) => c && typeof c.title === 'string' && typeof c.condition === 'string' && typeof c.action === 'string' && typeof c.rationale === 'string')
      : [];
  }

  /**
   * 复盘主体（自动复盘与 /ace 命令共用）：Reflector → Curator → 逐条冲突判定落盘
   * → 冲突回报 → merge-inbox 写入。
   *
   * LLM 调用全在锁外；锁只覆盖最后的「读最新 → 逐条判定 → 原子写」。
   *
   * 多轮复盘（C3）：Reflector 最多跑 REFLECT_MAX_ROUNDS 轮，第 2/3 轮把「轨迹 + 之前轮次
   * 已提炼的全部候选」一起喂进去，要求只提炼还没覆盖到的新经验。**收敛判据纯程序化**：
   * 某轮返回空数组即停（不许模型自声明收敛），轮数上限 3 轮硬停；超时/取消由 signal 中断，
   * 已提炼的候选照常落盘（不会因为没跑到收敛就丢经验）。
   *
   * @param {object} params
   * @param {object} params.agent - 宿主 agent
   * @param {string} params.summary - 交给 Reflector 的任务摘要（自动复盘写自动文案，/ace 用命令原文）
   * @param {AbortSignal} [params.signal] - 维护任务的取消信号
   * @returns {Promise<{added: string[], conflicts: Array, rounds: number, merged: number, evicted: number}>}
   */
  /**
   * 复盘主体（自动复盘与 /ace 命令共用）：实现全在 lib/recap-pipeline.js
   * （那一层不 import 宿主包，测试能拿真实临时手册 + 假 Reflector 真跑整链）。
   * 这里只把「插件状态与宿主副作用」注入进去：统计、冲突通知、merge-inbox 计数。
   *
   * 时序约束（都由那里的缺陷修复钉住，改这里别破坏）：
   * - 命中账本**不在这里取**：回合边界（lib/recap.js 的 onTurnStopping）是唯一取走点。
   *   流水线再取一次会在并发窗口里抢走不属于本轮的 id。
   * - 0 候选也做容量维护（P0-6）；满额先合并、仍超再淘汰（第 33 轮）在 commit 层锁内。
   */
  async function executeRecap({ agent, summary, signal }) {
    const file = await resolveFile({ agent });
    return runRecapPipeline({
      file,
      // 归档搬进独立文件（第 33 轮）：路径由手册路径派生，见 resolveArchive。
      archiveFile: await resolveArchive({ agent }),
      logger: ctx.logger,
      maxEntries: live.maxEntries,
      // 第 36 轮：新条目保护期（天）随复盘流水线一路透传到 commit 层的淘汰调用。
      protectDays: evictProtectDaysOf(live.evictProtectDays),
      recapStats,
      digestEntries,
      noteArchived,
      noteWritten,
      reportConflicts,
      inboxPath,
      // onInboxCount 的消费者（系统提示里的「手册里有 N 条疑似重复条目」）在第 28 轮删掉了，
      // 这里不再接线：待合并条目数由 recap-pipeline 自己写进 merge-inbox，读侧走 HTTP /inbox。

      reflectRound: ({ agent: a, summary: s, outcome, playbookDigest, priorCandidates, round, signal: sig }) => {
        const route = resolveRoute(live, { agent: a });
        return reflectRound({ agent: a, summary: s, outcome, playbookDigest, route, signal: sig, priorCandidates, round });
      },
      // LLM 合并（第 33 轮）：与 Reflector 同一条 LLM 路径（lib/llm.js 的 oneShot），
      // 不新开连接方式、不新增依赖。契约见 lib/merge-llm.js 的 planMerges：
      // ask({ userText, signal }) → 原始输出字符串，解析与校验都在 merge-llm 里做。
      mergeAsk: async ({ userText, signal: sig }) => {
        const route = resolveRoute(live, { agent });
        return oneShot(ctx, {
          provider: route.provider,
          model: route.model,
          system: MERGE_SYSTEM,
          userText,
          signal: sig,
        });
      },
    }, { agent, summary, signal });
  }

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
      // 命中计数（第 33 轮）：**只有定向查找**（带 id 或带 query）才记 hits —— 整本读取不计数。
      // 整本读取是「翻一下目录」，不是「用上了某条经验」；把它也计进去会让 hits 变成
      // 「手册被打开过几次」的同义词，最少使用淘汰就失去了分辨力。
      // 检索**不进回合账本**：账本只收自动注入的 id（lib/injection-flow.js 是唯一写入点），
      // 检索命中若混进去，会把「查过」误记成「本轮用过」。
      // 写盘在返回前完成（锁 + 原子写），失败只写日志，绝不影响检索结果。
      if (args.id || args.query) {
        const hitIds = entries.map((e) => e.id);
        retrievalStats.hits += hitIds.length;
        // hits/lastHit 立刻落到手册文件（锁 + 原子写，见 recordHits）；失败只记日志。
        await recordHits(exec?.agent, file, parsed, hitIds);
      }
      return {
        path: file,
        entryCount: parsed.entries.length,
        matched: entries.length,
        // 第 33 轮：归档搬进独立文件 archive.md，**任何**读取路径都不再附带归档条目 ——
        // 归档只给人看（设置页），注入与工具都不读它。
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
          // 第 33 轮：三层闸门已删除，唯一保留的候选过滤是「标题非空」（acceptCandidates）。
          rejected: {
            type: 'array',
            required: true,
            description: '标题为空而被拒绝的候选（每项 {title,reason}）。为空表示全部可用。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Reflector 产出 ' + value.candidates.length + ' 条候选经验（现有手册 ' + value.existingCount + ' 条）。' +
          (value.rejected && value.rejected.length
            ? '拒绝 ' + value.rejected.length + ' 条候选（' + value.rejected.map((r) => r.reason).join('、') + '）。'
            : '') +
          (value.notes ? '备注：' + value.notes : ''),
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
      const rawCandidates = Array.isArray(parsed.candidates)
        ? parsed.candidates.filter((c) => c && typeof c.title === 'string' && typeof c.condition === 'string' && typeof c.action === 'string' && typeof c.rationale === 'string')
        : [];
      // 第 33 轮：三层可复用性闸门（lib/gate.js）整份删除，唯一保留的判据是「标题非空」。
      // 理由：闸门的长度上限 / 指代词黑名单 / 文件名规则实测误杀多于命中（第 32 轮报告里
      // 有三处误杀），而真正决定条目有没有用的，是 hits 与最少使用淘汰。
      const { accepted, rejected } = acceptCandidates(rawCandidates);
      if (rejected.length) {
        recapStats.rejected += rejected.length;
        ctx.logger?.info?.('dsh-ace: 拒绝 ' + rejected.length + ' 条候选（' +
          rejected.map((r) => r.reason + '：' + (r.title || '（无标题）')).join('、') + '）');
      }
      return {
        candidates: accepted,
        notes: typeof parsed.notes === 'string' ? parsed.notes : '',
        existingCount: entries.length,
        rejected: rejected.map((r) => ({ title: r.title || '', reason: r.reason })),
      };
    },
  }));

  // —— 工具 3：ace_curate（增量并入手册；锁外读快照 + LLM 去重 → 锁内重读最新 + 冲突检测 + 增量应用 + 原子写） ——
  ctx.tools.register(defineTool({
    name: 'ace_curate',
    description: '把候选经验增量并入 ACE 操作手册：add 新增 / update 修改既有条目 / remove 删除。开启去重时（默认）新增候选会先由确定性规则与既有条目比对（完全重复则丢弃；候选更完整则新增并归档旧条目，否则原地更新旧条目），判定不调用 LLM。手册只增量演化，绝不整本重写。并发场景：若复盘期间手册被别的进程改过，冲突的那几条不并入、其余照常落盘，冲突明细在输出的 conflicts 字段里回报，重试即可。',
    // C4.1 判定权收回：新增/覆盖/覆盖哪条由 lib/archive.js 的确定性规则判，模型不再选 verdict/id。
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
      dedupe: { type: 'boolean', description: '是否对新增候选做去重判定（默认 true，纯确定性规则，不调 LLM）。手册为空时自动跳过。' },
      // 注：并发冲突不通过参数控制 —— 冲突是运行时事实，落在输出 schema 的 conflicts 字段里。
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
          // 第 33 轮：只剩「标题非空」这一条判据（三层闸门已删除）。update/remove 不受影响。
          rejected: {
            type: 'array', required: true,
            description: '被拒绝的 add 候选（每项 {title,reason}，reason 恒为「空标题」）。为空表示全部候选都可用。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          mergeSuggestions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          entryCount: { type: 'integer', required: true },
          conflicts: {
            type: 'array', required: true,
            description: '因并发冲突未并入的改动（每项 {op,id,title,reason}）。为空表示本批全部并入成功。',
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '手册更新完成：新增 ' + value.added.length + '，修改 ' + value.updated.length + '，删除 ' + value.removed.length +
          '，重复跳过 ' + value.duplicates.length + '，判定为完全重复而丢弃 ' + value.droppedByCurator.length +
          '，拒绝空标题 ' + (value.rejected ? value.rejected.length : 0) +
          '，疑似重复待合并 ' + value.mergeSuggestions.length + '；现有 ' + value.entryCount + ' 条。' +
          (value.conflicts && value.conflicts.length
            ? ' ' + CONFLICT_HINT + '，这 ' + value.conflicts.length + ' 条没并入，重试即可：' + value.conflicts
              .map((c, i) => ('（' + (i + 1) + '）' + (c.op === 'add' ? ('新增《' + (c.title || '') + '》') : (c.op + ' ' + (c.id || ''))) + '：' + (c.reason || '')))
              .join('；')
            : ''),
      }],
    },
    async execute(args, exec) {
      const file = await resolveFile(exec);
      const ops = args.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error('ace: ops 必须是非空数组');
      // C4.1：判定权在代码里。droppedByCurator 字段名保留（输出 schema 稳定），
      // 现在装的是「确定性规则判定为完全重复而丢弃的候选」，不再来自 LLM。
      const droppedByCurator = [];
      const dedupe = args.dedupe !== false;
      // 第 33 轮：三层可复用性闸门（lib/gate.js）整份删除，add 候选只过「标题非空」这一条。
      // 拒的是候选、不是整批：一条空标题不许连累同一批里的好候选。
      const { accepted: adds, rejected } = acceptCandidates(ops.filter((o) => o && o.op === 'add'));
      if (rejected.length) {
        recapStats.rejected += rejected.length;
        ctx.logger?.info?.('dsh-ace: 拒绝 ' + rejected.length + ' 条候选（' +
          rejected.map((r) => r.reason + '：' + (r.title || '（无标题）')).join('、') + '）');
      }
      // —— 阶段 1（锁外）：读手册快照 + 纯代码判定候选去向 ——
      // 新增还是覆盖、覆盖哪一条，全由 lib/archive.js 的 decideCandidates 按写死的规则判
      // （完全重复丢弃 / 候选更完整则新增并归档旧条目 / 否则原地更新 / 都不命中新增）。
      // 这里不再有 LLM 调用：判定不需要模型，省一次往返，也免了「模型挑错 id」的风险。
      const snapshot = await readPlaybookSnapshot(file);
      let finalOps = ops;
      let decision = { ops: [], supersedes: [], dropped: [], updates: [], adds: [] };
      if (dedupe && adds.length && snapshot.entries.length) {
        decision = decideCandidates(snapshot.entries, adds);
        const droppedAt = new Set(decision.dropped.map((d) => d.index));
        for (const d of decision.dropped) droppedByCurator.push(String(d.title || ''));
        // 只替换 add 型操作（update/remove 是调用方明确指定的，原样保留、相对顺序不变）。
        // decision.ops 与 adds 一一对应，只有「被判为完全重复丢弃」的候选缺一项，
        // 所以按 dropped 的下标跳过，其余顺序取用（不用 shift 硬凑，避免错位）。
        const decided = decision.ops.slice();
        let cursor = 0;
        finalOps = ops
          .map((op) => {
            if (!op || op.op !== 'add') return op;
            if (!adds.includes(op)) return null; // 空标题候选：不落盘
            const at = adds.indexOf(op);
            if (droppedAt.has(at)) return null;
            const next = decided[cursor];
            cursor += 1;
            return next || op;
          })
          .filter(Boolean);
      } else if (adds.length !== ops.filter((o) => o && o.op === 'add').length) {
        // 没进去重分支（dedupe=false / 手册为空 / 本批没有 add）：被拒的空标题候选仍必须剔除。
        finalOps = ops.filter((op) => !(op && op.op === 'add' && !adds.includes(op)));
      }
      // —— 阶段 2（锁内）：重新读最新手册 → 冲突检测 → 校验 → 软归档 → 原子写 ——
      // 互斥保护：同一路径的 curate 串行执行 —— withLock（同进程）+ withFileLock（跨进程），
      // 锁覆盖整个读-改-写区间（./playbook.js 的 withExclusiveLock）。
      // 锁内：重新读最新手册 → 逐条冲突判定 → 安全部分照常落盘、冲突部分回报给用户。
      const today = dayString();
      const { conflicts, entriesBefore, result } = await commitOps(file, snapshot, finalOps, live.maxEntries, {
        // 归档搬进独立文件（第 33 轮）：被取代的旧条目写进同目录的 archive.md。
        archiveFile: await resolveArchive(exec),
        archive: makeArchivePlan(decision, finalOps, today),
        // 满额时先淘汰最少使用的条目（直写路径不做隐式合并 —— 合并要调 LLM，只在复盘里做）。
        evict: planEvictions,
        protectDays: evictProtectDaysOf(live.evictProtectDays),
        today,
      });
      noteArchived(result.archived);
      noteWritten(result, 'ace_curate');
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
        });
      }
      return {
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        duplicates: result.duplicates,
        droppedByCurator,
        rejected,
        mergeSuggestions,
        entryCount: result.entries.length,
        conflicts: conflicts.map((c) => ({ op: c.op, id: c.id || '', title: c.title || '', reason: c.reason || '' })),
      };
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
            // 同上：content 必须是 ContentBlock[]，不许直接把渲染结果（字符串）塞进去。
            const msg = createUserMessage(noticeMessage({ text: renderReviewText(items), summary }));
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
          // 复盘主体与自动复盘共用（executeRecap）；这里只是把摘要换成命令原文。
          const result = await agent.runMaintenance(async (signal) => {
            // 手动复盘没有回合轨迹，只有命令原文；第 33 轮起也不再有任何「本回合成败」输入。
            return executeRecap({
              agent,
              summary: invocation?.rawInput || '手动复盘',
              signal,
            });
          });
          const conflictText = result?.conflicts?.length
            ? '（' + renderConflictNotice(result.conflicts) + '）'
            : '';
          return { kind: 'success', text: 'ace: 复盘完成，新增 ' + (result?.added?.length || 0) + ' 条。' + conflictText };
        } catch (e) {
          // 宿主正忙（runMaintenance 只在 idle 相位合法，见 ~\@deepseek-ai\dsh-agent-loop\lib\index.js:823）：
          // 给一句人话提示，不要把宿主英文错误直接甩给用户。
          if (isBusyError(e)) {
            return { kind: 'error', text: 'ace: agent 正在忙，稍后重试。' };
          }
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
      // bounds 是设置页那半边的**唯一边界出处**：min/max 与默认值全从这里出，
      // 客户端不再自己写死任何一个数字（旧版文案里写死过「默认 100」）。
      bounds: {
        maxEntries: MAX_ENTRIES_RANGE,
        autoRecapThreshold: [0, 1000],
        autoRecapCooldownTurns: [0, 1000],
        evictProtectDays: EVICT_PROTECT_DAYS_RANGE,
        injectTokenBudget: INJECT_TOKEN_BUDGET_RANGE,
        injectMaxEntries: INJECT_MAX_ENTRIES_RANGE,
        defaults: {
          evictProtectDays: DEFAULT_EVICT_PROTECT_DAYS,
          injectTokenBudget: DEFAULT_INJECT_TOKEN_BUDGET,
          injectMaxEntries: DEFAULT_INJECT_MAX_ENTRIES,
          maxEntries: DEFAULT_MAX_ENTRIES,
        },
      },
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
          // /catalog 是唯一可能「抛完没人接」的路由：readCatalog 内部虽已兜住 llm 缺失与
          // listProviders 失败（lib/catalog.js 的 buildCatalog 恒返回 ok:false 体），
          // 但一旦意外抛出，async handler 就再也没人写响应，浏览器 fetch 会一直挂到超时。
          // 兜底体与 buildCatalog 的失败体同形：{ ok:false, error, providers:[] }。
          if (routePath === '/catalog') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            try {
              return send(200, await readCatalog());
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法读取模型目录（' + (error?.message ?? error) + '）');
              return send(200, { ok: false, error: String(error?.message ?? error), providers: [] });
            }
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
              // 降级体必须与成功路径**同字段**（ok/items/full/cap），只多一个 reason 说明原因。
              // 否则「磁盘读失败」与「真的没有待合并条目」完全同形，页面会把故障当成空态静默吞掉
              // ——/stats、/entries 都带 reason，唯独这里曾经没有。
              return send(200, { ok: true, reason: 'unreadable', items: [], full: false, cap: INBOX_CAP });
            }
          }
          // GET /api/dsh-ace/stats：设置页顶部「手册统计」区块的数据源（只读）。
          // 统计是观察者：只 stat + readFile 手册，不写盘、不加锁，不产生任何新的元数据写入
          // （聚合逻辑全在 lib/stats.js，纯函数可单测）。任何解析/读盘失败都降级成
          // ok:true + reason 的结构化空态，与 /inbox 同款静默降级，绝不 500 拖垮整页。
          if (routePath === '/stats') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            try {
              // runtime：本进程内存态的六项运行计数（复盘 / 候选 / 落盘 / 归档 / 注入 / 计分），
              // 与手册文件内容无关 —— 所以降级分支也照样带上它。
              const stats = await collectPlaybookStats(live.playbookPath, {
                ctx,
                maxEntries: live.maxEntries,
                runtime: runtimeSnapshot(),
              });
              return send(200, stats);
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法统计手册（' + (error?.message ?? error) + '）');
              // 兜底也返回与成功路径**同形**的零值 payload（scale / daily / recent / source /
              // windowDays / generatedAt 一个不少，值全为 0 或空数组），只多一个 reason 说明降级原因。
              // 旧版这里只回 { ok:true, reason:'unreadable' }，缺字段让客户端判失败、整块显示
              // 「统计不可用：宿主可能还没重启」——缺字段不是「没数据」，别让页面把降级当崩溃。
              return send(200, emptyStats(STATS_REASONS.unreadable, { maxEntries: live.maxEntries, runtime: runtimeSnapshot() }));
            }
          }
          // GET /api/dsh-ace/entries：设置页「记录列表详情页」的数据源（只读、全量条目）。
          // 与 /stats 同款观察者：只 stat + readFile 手册，不写盘、不加锁，不产生任何新的元数据写入
          // （摊平逻辑全在 lib/entries.js，纯函数可单测）。手册不可读时降级成
          // ok:true + reason 的结构化空态，与 /stats、/inbox 同款静默降级，绝不 500 拖垮整页。
          if (routePath === '/entries') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            try {
              const entries = await collectPlaybookEntries(live.playbookPath, {
                ctx,
                maxEntries: live.maxEntries,
              });
              return send(200, entries);
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法读取手册条目（' + (error?.message ?? error) + '）');
              // 降级体要与 collectPlaybookEntries 的成功体**同形**：后者带 pathKind / playbookPath
              // 共 7 键，旧版这里只发 5 键的 emptyEntries，客户端拿不到 pathKind 就只能猜。
              return send(200, {
                ...emptyEntries(ENTRIES_REASONS.unreadable, { maxEntries: live.maxEntries }),
                pathKind: playbookPathKind(live.playbookPath),
                playbookPath: live.playbookPath,
              });
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
          if ('evictProtectDays' in body) {
            touched = true;
            const value = validInt(body.evictProtectDays, EVICT_PROTECT_DAYS_RANGE);
            if (value === undefined) error = `evictProtectDays 必须是 ${EVICT_PROTECT_DAYS_RANGE[0]}–${EVICT_PROTECT_DAYS_RANGE[1]} 的整数（0 = 不保护新条目）`;
            else next.evictProtectDays = value;
          }
          if ('injectTokenBudget' in body) {
            touched = true;
            const value = validInt(body.injectTokenBudget, INJECT_TOKEN_BUDGET_RANGE);
            if (value === undefined) error = `injectTokenBudget 必须是 ${INJECT_TOKEN_BUDGET_RANGE[0]}–${INJECT_TOKEN_BUDGET_RANGE[1]} 的整数`;
            else next.injectTokenBudget = value;
          }
          if ('injectMaxEntries' in body) {
            touched = true;
            const value = validInt(body.injectMaxEntries, INJECT_MAX_ENTRIES_RANGE);
            if (value === undefined) error = `injectMaxEntries 必须是 ${INJECT_MAX_ENTRIES_RANGE[0]}–${INJECT_MAX_ENTRIES_RANGE[1]} 的整数`;
            else next.injectMaxEntries = value;
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