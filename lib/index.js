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
import { REFLECTOR_SYSTEM, reflectorUserInput, extractJsonObject, recoverCandidatesFromUnclosed } from './prompts.js';
import { serializePlaybook, digestEntries, withExclusiveLock, readOrInitPlaybook, readPlaybookSnapshot, matchEntries, markHits } from './playbook.js';
import { resolveRoute, oneShot } from './llm.js';
// 第 50 轮思考档位（见 ./reasoning.js 头注：档位判定纯逻辑 + 宿主 resolveModelInfo 查询，带超时与进程内缓存）。
import { EFFORT_QUERY_TIMEOUT_MS, lowestEffortOf, planReasoningEffort, queryModelEfforts, REASONING_EFFORT_IDS, validReasoningEffort } from './reasoning.js';
import { buildCatalog } from './catalog.js';
import { resolveSettingsFile, resolveLegacySettingsFile, migrateSettingsFile } from './settings-path.js';
import { resolvePlaybookFile, resolveArchiveFile, playbookPathKind, resolveSharedPlaybookFile, DEFAULT_PLAYBOOK_PATH, DEFAULT_MAX_ENTRIES } from './playbook-path.js';
// isMainAgent / isMutatingTool：主代理判定与 mutating 工具集合（见 ./trigger.js 头注）。
// 第 40 轮缺陷 5 起本文件**不再** import isBusyError：手动复盘已改走插件自有队列，
// 不再调宿主 agent.runMaintenance，也就没有「宿主正忙」这条竞态要识别了。
// isBusyError 本身仍是 lib/trigger.js 的导出（自动复盘调度器与它自己的单测在用）。
import { isMainAgent, isMutatingTool } from './trigger.js';
// restorePendingMutCount：真失败时把这一份待办吃掉的 mutating 计数还回状态。第 39 轮缺陷 2 ——
// 队列里的失败绕过 lib/recap.js 的 catch，回滚改由队列的 onFailed 钩子在这里触发。
import { restorePendingMutCount } from './trigger.js';
// createRecapController：回合内记账 + 空闲边沿执行的调度器（见 ./recap.js 头注）。
import { createRecapController } from './recap.js';
// renderTrajectory / collectTurnTrajectory / buildRecapSummary：把本回合真实轨迹渲染成
// 复盘模型的输入（见 ./trajectory.js 头注：只喂计数时 Reflector 实测 0 候选）。
import { collectTurnTrajectory, buildRecapSummary, TRAJECTORY_DEFAULTS } from './trajectory.js';
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
// （见 ./inject.js 头注：纯 BM25 相关度排序、同分按 id 升序，500 token / 5 条预算）。
import { selectInjection, userTextOf, messageKeyOf, createInjectionCache, createInjectedIds, INJECT_MAX_ENTRIES, INJECT_MIN_SCORE_IDF_RATIO, INJECT_MIN_RELATIVE_TO_TOP } from './inject.js';
// 话题热度（第 36 轮）：只由「用户说过的话」驱动的环形窗口；注入结果一律不回流（反自增强）。
import { createHeatWindow, computeHeat } from './heat.js';
import { nowStamp } from './timestamp.js';
// dumpRaw：复盘解析失败时把 LLM 原文落一份到 <DSH_HOME>/ace/debug/raw.jsonl（健壮性缺口 B2，
// 见 ./raw-log.js 头注：一切失败全吞、ACE_RAW_LOG=0 可关、锁外调用）。
import { dumpRaw } from './raw-log.js';
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
// 第 39 轮：复盘串行队列 + 总时限（复盘不再占宿主维护相位）。
import { createRecapQueue } from './recap-queue.js';
// 只取 createRecapQueue：RECAP_TOTAL_DEADLINE_MS / MAX_QUEUED_RECAPS 是 recap-queue.js
// 自己的默认值，本文件没有使用点（第 39 轮缺陷 8：导入即误导，已删）。
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
const DEFAULT_INJECT_TOKEN_BUDGET = 500;
const DEFAULT_INJECT_MAX_ENTRIES = 5;
/**
 * 第 50 轮：注入相关性门槛的两个可调项。
 * 0 是合法值 = 关掉那半边门槛（绝对 / 相对），留作「退回旧行为」的对照档；
 * 默认值直接取 lib/inject.js 的导出常量，**默认口径只有一处**（改档只改 inject.js）。
 * 两个都必须是**小数**（4.0 / 0.6 是实测出来的档位，取整会改掉方案参数）。
 */
const INJECT_MIN_SCORE_IDF_RATIO_RANGE = [0, 20];
const INJECT_MIN_RELATIVE_TO_TOP_RANGE = [0, 1];
const DEFAULT_INJECT_MIN_SCORE_IDF_RATIO = INJECT_MIN_SCORE_IDF_RATIO;
const DEFAULT_INJECT_MIN_RELATIVE_TO_TOP = INJECT_MIN_RELATIVE_TO_TOP;
/**
 * 第 40 轮 R5：注入链路连续无产出的自检门槛（连续多少次异常就发一次性 notice）。
 * 写成常量而不是散在逻辑里，改口径只改这一处。
 */
const INJECT_STALL_THRESHOLD = 5;

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
  injectTokenBudget: z.number().description('每次自动注入的 token 预算；调大 = 注入更多经验、更费 token，调小 = 更省 token；默认 500').default(DEFAULT_INJECT_TOKEN_BUDGET),
  injectMaxEntries: z.number().description('每次自动注入最多几条经验；调大 = 一次注入更多条，调小 = 更少；默认 5').default(DEFAULT_INJECT_MAX_ENTRIES),
  injectMinScoreIdfRatio: z.number().description('自动注入的绝对相关度门槛（× IDF_MAX）；低于它的条目一条都不注入，整轮可以注入 0 条；0 = 关掉绝对门槛；默认 4.0').default(DEFAULT_INJECT_MIN_SCORE_IDF_RATIO),
  injectMinRelativeToTop: z.number().description('自动注入的相对相关度门槛（相对本轮第一名）；每条候选至少要到 top1 的这么多倍才注入；0 = 关掉相对门槛；默认 0.6').default(DEFAULT_INJECT_MIN_RELATIVE_TO_TOP),
  injectRationale: z.boolean().description('自动注入时是否附带给每条经验一行为什么要有它（依据行）。打开 = 注入块更准、但每批多花约 26% token；默认关 = 省 token，只注入「标题｜条件」与做法').default(false),
  autoRecap: z.boolean().description('主代理回合结束时自动复盘归档（reflect+curate），无需模型主动调用').default(true),
  autoRecapThreshold: z.number().description('触发自动复盘所需的 mutating 工具调用下限').default(1),
  autoRecapCooldownTurns: z.number().description('距上次自动复盘至少隔几轮').default(2),
  autoReviewInbox: z.boolean().description('预留开关，当前不生效：merge-inbox 的复审入口是设置页「待合并复审」区块或对话里的 /ace review').default(false),
  reflectReasoningEffort: z.string().description('复盘用的思考强度（off/minimal/low/medium/high/xhigh/max）；留空 = 未手动指定，跟随下面的自动降档开关；填了会被自动校验，该模型没声明的档位一律丢弃并留日志').default(''),
  autoReasoningDowngrade: z.boolean().description('未手动指定思考强度时，自动降到该模型声明的最低档（efforts[0]）；模型只声明一档或没有档位信息时不干预').default(true),
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

/** 生效的注入 token 预算；非法值回落默认 500（调用点再兜底到 INJECT_TOKEN_BUDGET）。 */
function injectTokenBudgetOf(value) {
  return Math.floor(settingsNumber(value, DEFAULT_INJECT_TOKEN_BUDGET));
}

/** 生效的注入条数上限；非法值回落默认 5（调用点再兜底到 INJECT_MAX_ENTRIES）。 */
function injectMaxEntriesOf(value) {
  return Math.floor(settingsNumber(value, DEFAULT_INJECT_MAX_ENTRIES));
}

/**
 * 第 50 轮两个门槛项的数值口径：与 validTunableInt 同一套「没填」判据，但**允许小数**
 * （4.0 / 0.6 是实测档位，取整就会改掉方案参数）。
 */
function validRatio(value, [min, max]) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** 生效的绝对门槛倍数（× IDF_MAX）；非法值回落默认 4.0，0 原样保留（= 关掉绝对门槛）。 */
function injectMinScoreIdfRatioOf(value) {
  return settingsNumber(value, DEFAULT_INJECT_MIN_SCORE_IDF_RATIO);
}

/** 生效的相对门槛倍数（相对 top1）；非法值回落默认 0.6，0 原样保留（= 关掉相对门槛）。 */
function injectMinRelativeToTopOf(value) {
  return settingsNumber(value, DEFAULT_INJECT_MIN_RELATIVE_TO_TOP);
}

/**
 * 生效的「注入是否带依据行」开关；undefined（没设）与任何非法值一律回落默认 false。
 * 语义照 validFlag：true / false 原样，字符串 'true' / 'false' 收敛，其余 undefined。
 */
function injectRationaleOf(value) {
  return validFlag(value) === true;
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
  const injectRationale = validFlag(raw.injectRationale);
  if (injectRationale !== undefined) settings.injectRationale = injectRationale;
  if (raw.injectRationale !== undefined && injectRationale === undefined) {
    logger?.warn?.('dsh-ace: 丢弃无效的 injectRationale（需为 true 或 false）');
  }
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
  const injectMinScoreIdfRatio = validRatio(raw.injectMinScoreIdfRatio, INJECT_MIN_SCORE_IDF_RATIO_RANGE);
  if (injectMinScoreIdfRatio !== undefined) settings.injectMinScoreIdfRatio = injectMinScoreIdfRatio;
  if (raw.injectMinScoreIdfRatio !== undefined && injectMinScoreIdfRatio === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 injectMinScoreIdfRatio（需为 ${INJECT_MIN_SCORE_IDF_RATIO_RANGE[0]}–${INJECT_MIN_SCORE_IDF_RATIO_RANGE[1]} 的数）`);
  }
  const injectMinRelativeToTop = validRatio(raw.injectMinRelativeToTop, INJECT_MIN_RELATIVE_TO_TOP_RANGE);
  if (injectMinRelativeToTop !== undefined) settings.injectMinRelativeToTop = injectMinRelativeToTop;
  if (raw.injectMinRelativeToTop !== undefined && injectMinRelativeToTop === undefined) {
    logger?.warn?.(`dsh-ace: 丢弃无效的 injectMinRelativeToTop（需为 ${INJECT_MIN_RELATIVE_TO_TOP_RANGE[0]}–${INJECT_MIN_RELATIVE_TO_TOP_RANGE[1]} 的数）`);
  }
  const autoRecap = validFlag(raw.autoRecap);
  if (autoRecap !== undefined) settings.autoRecap = autoRecap;
  const autoRecapThreshold = validInt(raw.autoRecapThreshold, [0, 1000]);
  if (autoRecapThreshold !== undefined) settings.autoRecapThreshold = autoRecapThreshold;
  const autoRecapCooldownTurns = validInt(raw.autoRecapCooldownTurns, [0, 1000]);
  if (autoRecapCooldownTurns !== undefined) settings.autoRecapCooldownTurns = autoRecapCooldownTurns;
  const autoReviewInbox = validFlag(raw.autoReviewInbox);
  if (autoReviewInbox !== undefined) settings.autoReviewInbox = autoReviewInbox;
  // 第 50 轮：思考强度。空串是**合法值**（= 未手动指定），所以不能拿 validString 的空串语义去兜。
  const reflectReasoningEffort = validReasoningEffort(raw.reflectReasoningEffort);
  if (reflectReasoningEffort !== undefined) settings.reflectReasoningEffort = reflectReasoningEffort;
  if (raw.reflectReasoningEffort !== undefined && reflectReasoningEffort === undefined) {
    logger?.warn?.('dsh-ace: 丢弃无效的 reflectReasoningEffort（需为 ' + REASONING_EFFORT_IDS.join('/') + ' 之一，或留空表示跟随自动降档）');
  }
  const autoReasoningDowngrade = validFlag(raw.autoReasoningDowngrade);
  if (autoReasoningDowngrade !== undefined) settings.autoReasoningDowngrade = autoReasoningDowngrade;
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
    for (const key of ['playbookPath', 'autoReflect', 'reflectProvider', 'reflectModel', 'maxEntries', 'evictProtectDays', 'injectTokenBudget', 'injectMaxEntries', 'injectMinScoreIdfRatio', 'injectMinRelativeToTop', 'injectRationale', 'autoRecap', 'autoRecapThreshold', 'autoRecapCooldownTurns', 'autoReviewInbox', 'reflectReasoningEffort', 'autoReasoningDowngrade']) {
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
  // B3：会话内「已经真的注入过的条目 id」集合（WeakMap 按 agent 隔离，带每 agent 上限）。
  const injectedIds = createInjectedIds();
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

  // 第 40 轮 R1（注入链路可观测）：注入「一进来就没了」查不出原因的那次，根因是这几个数
  // 只能说明「有没有发布 / 追加」，说明不了**事件到底有没有到 handler**。所以这里拆成三层：
  //   handled    —— 进入 **agent/inbox/inserted 预检索 handler** 的次数。「事件到底有没有到 handler」
//                 的唯一判据：宿主的每条用户消息都要经过这条接缝
//   preSteps   —— 进入 **agent/pre-step 投递 handler** 的次数。「投递接缝有没有被宿主调用」的判据
  //   earlyReturn —— 被门槛早退的次数，按分支分桶（每个早退分支一个键，见 EarlyReturn 注释）
  //   deliveries —— pre-step 真的追加进历史的次数（= 注入成功送达）
  //   failures.next —— **下游** pre-step 监听器在 next() 里抛错的次数（第 45 轮，审计风险 5）：
  //                    pre-step 接缝确实被调用了（preSteps 在涨），但下游先炸，本插件没机会投递。
  //                    配对 earlyReturn.by.downstreamThrew。改前 await next() 在 try 之外，
  //                    这种情形与「接缝根本没到」在 stats 上一模一样，区分不出来。
  //   lastPublishAt / lastDeliveryAt —— 本进程最后一次「发布批次」/「真的追加进历史」的时刻
  //                    （毫秒精度本地 ISO，空串 = 本进程还没有过）。只有累计数时没法回答
  //                    「注入是从什么时候开始停的」，这正是当初排查「注入停发」时最缺的信息
  //                    （第 45 轮，审计风险 4）。
  //
  // **判定口径（本轮落定，好让人一眼看出三种失效里中的哪一种）**：
  //   - handled > 0 && batches === 0  ⇒ 事件到了 handler，但 handler 没产出（检索没挑出 / 抛错；
  //                                    门槛早退只证明「被挡在门外」，不证明链路坏了）
  //   - handled === 0                 ⇒ 事件根本没到 handler（宿主没派发 / 插件没挂上接缝）
  //   - preSteps === 0                ⇒ 投递接缝没被宿主调用过（宿主的 pre-step 没派发 / 没挂上）
  //   - failures.next > 0             ⇒ 接缝到了，但下游 pre-step 监听器抛错（不是本插件没投递）
  //   - deliveries === 0 && batches > 0 ⇒ 检索发出了批次，但投递层一次都没成功
  //   - lastPublishAt / lastDeliveryAt ⇒ 回答「最后一次注入是什么时候」（停在哪一刻一眼可见）
  //
  // **不进 runtime 七键**：runtime 是 lib/stats.js 钉死的精确七键（不许加键），前端也只渲染那七个。
  // 这一块单独走 injectionSnapshot()，挂在 GET /api/dsh-ace/stats 响应的**并列**键 injection 上。
  // 仍然只在内存里，不新增任何落盘文件（红线 9）。
  const injectionStats = {
    batches: 0,
    appended: 0,
    skipped: 0,
    failed: 0,
    handled: 0,
    preSteps: 0,
    // 第 45 轮（审计风险 4）：时间戳 —— 「最后一次注入发生在什么时候」正是当初排查「注入停发」
    // 时最缺的信息（只有累计数，说不出「停在几点几分」）。只加这两个内存字段：
    // 发布一批批次时写 lastPublishAt、真追加进历史时写 lastDeliveryAt。空串 = 本进程还没有过。
    lastPublishAt: '',
    lastDeliveryAt: '',
    earlyReturn: {
      by: {
        noAgent: 0,
        notUser: 0,
        flagsOff: 0,
        cacheHit: 0,
        noQuery: 0,
        noAgentPicked: 0,
        noText: 0,
        notEnter: 0,
        subAgent: 0,
        // 第 45 轮（审计风险 5）：投递接缝**到了**，但下游 pre-step 监听器在 next() 里抛错。
        // 它落到这个桶 + failures.next，与「接缝根本没到」（两边都不动）区分开。
        downstreamThrew: 0,
      },
    },
    deliveries: 0,
    // 三处静默失败点各自计数（catch 里只 warn 一行、调用方什么都看不到的那种）。
    failures: {
      prerecall: 0, // 预检索 IIFE 的 catch
      empty: 0, // 预检索跑完了但一个候选都挑不出来
      deliver: 0, // pre-step 投递的 catch
      // 第 45 轮（审计风险 5）：下游 pre-step 监听器（宿主自己或别的插件）在 next() 里抛错。
      // 改前 `await next()` 在 try 之外 ⇒「接缝到了、但下游炸了」与「接缝根本没到」在 stats 上
      // 一模一样（两者都不进这道接缝的任何桶）。现在单开一桶记下来（配对的是
      // earlyReturn.by.downstreamThrew），异常照旧原样 rethrow，绝不吞。
      next: 0,
    },
    // 第 40 轮 R5 连续无产出跟踪（自检看的是**连续**次数，任何一次产出就清零）：
    //   noProduce      —— 预检索 handler 真的跑过、但没发出批次的连续次数（只有两处会累加：
    //                     IIFE 里挑不出候选、IIFE 的 catch；门槛早退**不算**，见下面的 early）
    //   deliverySilent —— 发布了批次、但 pre-step 投递一次都没追加成功的连续次数
    //
    // 第 45 轮（审计风险 2、3）：这两个计数**按 agent 分表**，不再是进程级全局。旧口径下
    // A 的失败账会记到 B 头上：审计 PROBE-D 实测「A 错 3 次 + B 错 2 次 ⇒ A 收到『连续 5 次』
    // 通知」。触发条件本来就是「某一个 agent 自己连续 5 次」，所以账必须分开记。
  };
  // 为什么用「以稳定键为键的 Map + 上限」而不是 WeakMap：/stats 的 injection 块要报出
  // 「最接近门槛的那个 agent 的数」（自检比的就是这个数），WeakMap 不可枚举、算不出来。
  // 内存有界由 STALL_AGENT_CAP 兜住（size 恒 ≤ 上限）。
  //
  // 键的优先级（第 42 轮中-2）：agent 有非空字符串 id 时用 'id:' + id —— 宿主 Agent 的 id 是
  // 稳定的会话标识（C:/Users/adkun/AppData/Local/npm-cache/_npx/b86ed90107c62dab/node_modules/
  // @deepseek-ai/dsh-agent/lib/types/types.d.ts:10-14 的 `readonly id: SessionId`）；没有 id 才
  // 退化成对象身份（测试桩就没有 id，这一档是必需的）。原来一律用对象身份，等于默默依赖
  // 「宿主两个事件传同一个 agent 对象引用」这条**未声明契约**：宿主哪天按事件新建包装对象
  // （@deepseek-ai/dsh-agent/lib/index.js 的 fused = (payload) => ({ ...payload, agent }) 就是
  // 这种包装），每个事件一本新账，「连续 N 次」永远攒不满、R5 完全失效且一条告警都没有
  // （第 42 轮审计 PB4 实测 stall.agents = 2 / notices = 0）。只要 id 一致就还是同一本账。
  //
  // 淘汰（第 43 轮改写；第 42 轮高-2 的「优先丢零值账」已作废）：超上限时按**连续计数升序**
  // 挑受害者 —— 计分 = noProduce + deliverySilent，先丢计分最小的那本；计分相同时丢**最早入表**
  // 者（Map 的插入序，确定性、绝不随机）。
  // 第 42 轮的«只找零值账、一条都没有才丢最早入表者»**不够**：表里一条零值账都没有时，最早入表
  // 且已连错 4 次的那本照样被丢，该 agent 新账从 0 重新数、第 5 次失败一条通知都没有
  // （第 43 轮审计实测 notices=0，与上一轮 PB3b 终态完全一致，只是触发条件从「装满 200 本账」
  // 收窄成「装满 200 本非零账」）。被丢的恒是**全表计分最小者**（= 最不接近门槛的那本）。
  //
  // 第 43 轮那版注释还宣称「『正在连错的账』只有在全表 N 本都连错 ≥ INJECT_STALL_THRESHOLD 次时才会
  // 被丢」——**过头了：第 44 轮审计 probe-cap 用反例证伪**（全表 200 本计分都 = 4、谁都没到门槛 5 时，
  // 最早入表、差一次就该报警的那本照样被丢，只是留了一行 warn）。准确表述：零值账（计分 0）最先被
  // 回收；**全表都非零时丢的仍是计分最小的那本，它完全可能已经连错了几次、只差一两次到门槛**。
  // 这里能保证的只有两条：①被丢的永远是全表计分最小者（计分相同取最早入表者）；②计分 > 0 必留
  // 一行 warn 点名。措辞一律以「审计能不能用反例证伪」为准绳（同型问题第三次复发）。
  const STALL_AGENT_CAP = 200;
  const stallByAgent = new Map();
  /** 账本键：有稳定 id 就用 id，没有才退回对象身份。 */
  function stallKeyOf(agent) {
    if (agent && typeof agent.id === 'string' && agent.id) return 'id:' + agent.id;
    return agent;
  }
  /** 日志用的短标签：把键还原成人能认的 agent 名。 */
  function stallKeyLabel(key) {
    if (typeof key === 'string') return key.slice(3);
    try {
      return (key && typeof key.id === 'string' && key.id) ? String(key.id) : '（无 id）';
    } catch {
      return '（无 id）';
    }
  }
  /** 淘汰计分：连续计数之和（越小越接近「还没攒到账」，越该先丢）。 */
  function stallScore(record) {
    const n = Number(record && record.noProduce);
    const d = Number(record && record.deliverySilent);
    return (Number.isFinite(n) ? n : 0) + (Number.isFinite(d) ? d : 0);
  }
  /**
   * 超上限时腾一个名额（第 43 轮改写）：按**连续计数升序**挑受害者 —— 计分 = noProduce +
   * deliverySilent，先丢计分最小的那本；计分相同时丢**最早入表**者（Map 的插入序 ⇒ 确定，
   * 不随机）。零值账（计分 0）最先被回收，但**不保证「绝不动正在连错的账」**：全表都非零时丢的
   * 仍是计分最小的那本，它可能已经连错了几次、只差一两次到门槛（第 44 轮审计 probe-cap 反例：
   * 全表 200 本计分都 = 4 时，最该继续数的那本照样被丢，只是留了一行 warn）。计分 > 0 必补一行
   * warn 点名 —— 静默丢账才会让一个正在连错的 agent 从 0 重新数、第 5 次失败再也发不出通知。
   * 刚入表的 justAdded 永远不选（否则新账一建就被自己挤掉）。
   */
  function evictStallRecord(justAdded) {
    let victim = null;
    let victimScore = Infinity;
    for (const [key, record] of stallByAgent) {
      if (key === justAdded) continue;
      const score = stallScore(record);
      if (score < victimScore) { victim = key; victimScore = score; }
    }
    if (victim === null) return;
    const lost = stallByAgent.get(victim);
    stallByAgent.delete(victim);
    if (lost && (lost.noProduce > 0 || lost.deliverySilent > 0)) {
      ctx.logger?.warn?.(
        'dsh-ace: 注入自检的 agent 计数表已满（上限 ' + STALL_AGENT_CAP + ' 个），被迫丢掉 agent ' + stallKeyLabel(victim) +
          ' 正在累计的账（noProduce=' + lost.noProduce + ' / deliverySilent=' + lost.deliverySilent +
          '）；该 agent 之后的连续失败要重新数到 ' + INJECT_STALL_THRESHOLD + ' 次才会报警',
      );
    }
  }
  /**
   * 取某个 agent 自己的连续计数器（不存在就建一个，并在超上限时腾一个名额出来）。
   * agent 不是对象（载荷畸形 / 测试直连）时返回 null，调用方必须判空。
   */
  function stallRecordOf(agent) {
    if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return null;
    const key = stallKeyOf(agent);
    const found = stallByAgent.get(key);
    if (found) return found;
    const fresh = { noProduce: 0, deliverySilent: 0 };
    stallByAgent.set(key, fresh);
    if (stallByAgent.size > STALL_AGENT_CAP) evictStallRecord(key);
    return fresh;
  }
  /**
   * 把按 agent 分表的连续计数摊平成 /stats 可读的形状：取**最接近门槛**的那个 agent 的数
   * （自检比的就是这个数，报的要同源），并附入表 agent 数 —— 一个会话卡住和多个会话各自
   * 都没产出，指向的原因完全不同（后者多半是配置或手册本身的问题）。
   */
  function stallSnapshot() {
    let noProduce = 0;
    let deliverySilent = 0;
    for (const record of stallByAgent.values()) {
      if (record.noProduce > noProduce) noProduce = record.noProduce;
      if (record.deliverySilent > deliverySilent) deliverySilent = record.deliverySilent;
    }
    return { noProduce, deliverySilent, agents: stallByAgent.size };
  }
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
   * 注入链路的**诊断快照**（第 40 轮 R1）：故意不进 runtime 七键（lib/stats.js 的
   * normalizeRuntime 只认那七个，且前端只渲染那七个），单独作为 /stats 响应的 `injection` 键。
   * 只读内存计数，不读盘、不加锁、不新增文件（红线 9）。
   */
  function injectionSnapshot() {
    return {
      handled: injectionStats.handled,
      batches: injectionStats.batches,
      appended: injectionStats.appended,
      preSteps: injectionStats.preSteps,
      deliveries: injectionStats.deliveries,
      skipped: injectionStats.skipped,
      failed: injectionStats.failed,
      earlyReturn: { ...injectionStats.earlyReturn.by },
      failures: { ...injectionStats.failures },
      stall: stallSnapshot(),
      // 第 45 轮（审计风险 4）：两个时间戳。只有累计数时答不出「注入是从哪一刻停的」——
      // 当初排查「注入停发」缺的就是这一条。空串 = 本进程还没有过（宿主重启即归零，仍是纯内存）。
      lastPublishAt: injectionStats.lastPublishAt,
      lastDeliveryAt: injectionStats.lastDeliveryAt,
      // 判定口径的机器可读版：handled > 0 而 batches === 0 ⇒ handler 被调用了、但没有产出；
      // handled === 0 ⇒ 事件根本没到 handler。两者含义完全不同，别混。
      //
      // 第 43 轮改口径表述（表达式一字未动，第 42 轮的「与 R5 同口径」是过度承诺）：
      // stalled 的**准确语义**只有一个 —— 「本进程里注入 handler 被调用过，但**自进程启动以来
      // 从未成功产出过任何批次**」，也就是「注入链路从启动起就完全没工作」这条判据。
      // batches 是**进程累计**：一旦成功发过一批，它再也回不到 0，所以这一位答的是「链路有没有
      // 工作过」，答不了「某个 agent 最近是不是连续失败」。
      // 按 agent 的连续失败**不归它管**：那是 R5 的 stall.noProduce + notice。两者口径不同、
      // 可以、也允许不同向（第 43 轮用例钉死：同一个 agent 先成功发布过一批、随后连续 5 次
      // 无产出 ⇒ stalled=false 而 stall.noProduce=5；这是刻意的分工，不是自相矛盾）。
      // 唯一保留的口径微调（第 42 轮中-1）：用户合法关掉自动功能（live.autoRecap /
      // live.autoReflect 都是假）时每条都走 flagsOff 早退，batches 必然为 0 —— 那是「没开」
      // 不是「坏了」。旧口径下 stalled 为真，而同份统计里的 stall.noProduce 是 0、
      // earlyReturn.by.flagsOff 等于 handled，那种组合才是真的自相矛盾、把排障的人往链路失效上带。
      // 判据：handled 全部折在 flagsOff 里就不算 stalled；只要有别的早退（或压根没早退），
      // handled > batches === 0 仍然成立就照报。
      stalled:
        injectionStats.handled > 0 &&
        injectionStats.batches === 0 &&
        injectionStats.handled > injectionStats.earlyReturn.by.flagsOff,
      undelivered: injectionStats.batches > 0 && injectionStats.deliveries === 0,
    };
  }

  /**
   * 注入链路自检（第 40 轮 R5）：连续无产出就发一次性 notice。
   *
   * 两种「看起来什么都没发生」的形态各自跟踪（第 45 轮起**按 agent 分表**，各记各的账）：
   *   - noProduce 连续 N 次：handler 确实进来了（handled 在涨），但一次批次都没发出去 ——
   *     包括「预检索抛错」「检索跑完挑不出候选」，这两种都让 batches 原地不动。
   *     **门槛早退不算**（手册为空 / 问法不沾边 / 用户在设置里关了自动功能，都不是失效）；
   *   - deliverySilent 连续 N 次：批次发得出去，但 pre-step 投递一次都没追加成功。
   * 任一越线就发一次 notice 并清零，避免每回合重复刷屏（一次性）。
   * **两种都不算「事件没到 handler」**：那是 handled === 0，看 /api/dsh-ace/stats 的 injection 块
   * 一眼就能分辨（本轮 R1 的全部意义就在这里）。
   * 该函数**绝不抛错**：它挂在 agent/turn-stopping 上，抛出去会打断回合收尾。
   *
   * @param {object} payload 宿主 agent/turn-stopping 的 payload（只用其中的 agent）
   */
  function checkInjectionStall(payload) {
    try {
      const agent = payload?.agent;
      if (!agent || !isMainAgent(agent)) return;
      const st = stallRecordOf(agent);
      if (!st) return;
      const n = INJECT_STALL_THRESHOLD;
      if (st.noProduce >= n) {
        st.noProduce = 0;
        // 分桶细节留在日志里（抛错几次、挑不出几次、早退几次），notice 只给结论与下一步。
        const hit = (bucket) => injectionStats.earlyReturn.by[bucket];
        const detail = '抛错 ' + injectionStats.failures.prerecall + ' 次、挑不出候选 '
          + injectionStats.failures.empty + ' 次、门槛早退 ' + (hit('flagsOff') + hit('notUser') + hit('noQuery')
            + hit('cacheHit') + hit('noAgent')) + ' 次';
        sendNotice(agent, createUserMessage(noticeMessage({
          // 第 45 轮（审计风险 3）：措辞必须与实现相符 —— 计数单位是**预检索次数**（一个回合可能
          // 走几次），旧文案说的「连续 N 次用户消息」与实际触发点对不上（审计 PROBE-3b 实测 3 个
          // 回合就触发），会把排障的人往「回合数」上带。同时补上「用户自己关了自动功能」这条
          // 完全正常的解释（旧文案只覆盖「手册为空 / 问法不沾边」两种，用户在设置里关掉自动功能
          // 时必然误报，审计 PROBE-1）。
          text: 'ACE 注入链路可能已失效：连续 ' + n + ' 次预检索都没能产出一条经验（' + detail + '，均为本进程累计）。'
            + '经验还在手册里，只是没能送到模型眼前。若手册为空、问法与手册完全不沾边，或者你在设置里关掉了注入 / 自动复盘，这条属于正常，可忽略；'
            + '否则请检查手册文件是否可读、以及设置页「ACE 运行统计」里的注入批次是否一直为 0。',
          summary: 'ACE 注入链路可能已失效：预检索连续无产出，经验没能注入',
        })));
        ctx.logger?.warn?.('dsh-ace: 注入链路自检——连续 ' + n + ' 次预检索无产出（' + detail + '），已发一次性通知');
      }
      if (st.deliverySilent >= n) {
        st.deliverySilent = 0;
        sendNotice(agent, createUserMessage(noticeMessage({
          text: 'ACE 注入链路可能已失效：连续 ' + n + ' 次预检索都发出了经验批次，但一次都没能追加进历史（投递层失败）。'
            + '经验还在手册里，只是没能送到模型眼前，请查看日志里的「注入追加进历史失败」。',
          summary: 'ACE 注入链路可能已失效：投递层连续失败，经验没能追加进历史',
        })));
        ctx.logger?.warn?.('dsh-ace: 注入链路自检——连续 ' + n + ' 次发布批次但一次投递都没成功，已发一次性通知');
      }
    } catch { /* 自检是增强项，绝不让它打断回合收尾 */ }
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

  // —— 注入接缝（第 28 轮新增；第 40 轮 R2 前移到 recap 装配之前） ——
  //
  // **为什么前移**：这两条接缝是「经验能不能到模型眼前」的唯一通路。第 40 轮排查发现全库
  // 1563 个会话里真注入只有 57 次、最后一次停在 2026-10-26T14:03:02.375Z，而检索 / 选型 /
  // 去重 / 投递四层纯函数在满额（100 条）手册上全部正常（11 条真实问法都选出 3 条、
  // tokens 709~893 在 900 预算内），装配面用 temp 副本跑真实 apply() 五个 handler 也全挂得上。
  // 失效只剩三种可能：handler 根本没被调用 / handler 被门槛早退 / IIFE 抛错进了 catch。
  // 之前这两条注册在 recapController 之后 —— 那一段里任何一个构造成员抛错，结果就是
  // 「系统提示段在、注入 handler 不在」，症状与本次失效完全一致。现在紧跟 section 注册，
  // 让「section 在 ⇒ 两条注入接缝也在」成为结构保证；这个顺序由 tests/wiring.test.mjs 里
  // 「注入接缝先于其余订阅挂上」那条用例钉住，不许再把它们挪回 recap 之后。
  //
  // 本段只引用其上已经声明的东西（injectionCache / injectionFlow / heatWindow /
  // injectionStats / resolveFile / readPlaybookSnapshot / computeHeat / selectInjection），
  // 真正执行发生在宿主发射事件时，那时 apply 早已跑完。
  //
  // —— C5.1 取词：订阅 agent/inbox/inserted，按 agent 记住最近一条用户消息并预检索 ——
  // 事件出处：~\@deepseek-ai\dsh-agent\lib\types\runtime-types.d.ts:263
  // 「One message entered the live inbox」，payload { agent, message }；
  // 发射点 ~\@deepseek-ai\dsh-agent-loop\lib\index.js:206（payload 里只有 message，
  // agent 由 cordis 的 Scoped 补上，消费范式见 ~\dsh-goal-round-driver\lib\index.js:249）。
  //
  // 为什么在这里检索而不是在系统提示的 text 回调里：那个回调是同步的，而且拿不到消息
  // （~\@deepseek-ai\dsh-system-prompt\lib\types\index.d.ts:37-45 只有 scope/signal）。
  // 所以「收到用户消息 → 异步读手册算 top N → 发布进缓存」，随后由 agent/pre-step 投递
  // （见本段末尾的 pre-step 订阅：把这一批追加成一条 user 消息）。
  // 同一条消息只算一次（messageKeyOf 缓存键），一个回合里每个 step 都不会重算、也不会重复追加。
  //
  // 计数（第 28 轮口径 + 第 40 轮 R1）：batches = 这里真正发布了一批（≈ 用户消息数）；
  // skipped = 收到新消息但没挑出任何经验；failed = 预检索抛错。
  // 「真的追加进历史」是另一本账（appended / deliveries，见 inject-delivery.js）。
  // 第 40 轮加的三层判据见 injectionStats 上方注释：handled=0 ⇒ 事件根本没到 handler。
  ctx.on('agent/inbox/inserted', (payload) => {
    // 第 40 轮 R1：**在任何早退之前**自增。handled === 0 就是「事件根本没到 handler」，
    // 别的数都给不出这个结论。
    injectionStats.handled += 1;
    const agent = payload?.agent;
    const message = payload?.message;
    // 每个早退分支各记一桶。**第 45 轮（审计风险 3）：早退一律不计入 stall.noProduce。**
    // 早退的原因（没有 agent / 不是用户消息 / 手册为空或问法不沾边 / 用户在设置里关了自动功能）
    // 都是**正常**状态，不是链路失效；把它们算成「连续无产出」只会在用户合法关功能时必然误报
    // （审计 PROBE-1、变异实验 M7）。noProduce 现在只在两个真正的失败点累加：
    // 下面 IIFE 里「挑不出候选」与 IIFE 的 catch。
    const early = (bucket) => {
      injectionStats.earlyReturn.by[bucket] += 1;
    };
    if (!agent || !message) return early('noAgent');
    if (message.role !== 'user') return early('notUser');
    if (!live.autoRecap && !live.autoReflect) return early('flagsOff'); // 系统提示段本身就不注册任何内容
    const key = messageKeyOf(message);
    if (injectionCache.get(agent, key)) return early('cacheHit');
    const query = userTextOf(message);
    if (!query) return early('noQuery');
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
        // 第 50 轮：门槛参数必须先算出来，**热度与注入用的是同一档门槛** —— 否则
        // 「候选层已按门槛过滤、热度再排序」这条会被热度账（computeHeat 内部也走 rankInjection）分叉。
        const minScoreIdfRatio = injectMinScoreIdfRatioOf(live.injectMinScoreIdfRatio);
        const minRelativeToTop = injectMinRelativeToTopOf(live.injectMinRelativeToTop);
        // B3：会话内已经真的注入过的条目不再重复注入——先按 agent 的已注入 id 集合排除。
        const available = snapshot.entries.filter((e) => !injectedIds.has(agent, e && e.id));
        const heat = computeHeat(available, heatWindow.messagesOf(agent), {
          injectMinScoreIdfRatio: minScoreIdfRatio,
          injectMinRelativeToTop: minRelativeToTop,
        });
        // 第 55 轮：依据行是否注入由配置开关决定（默认关 = 省 token）；live 即热更新后的生效值，
        // 设置页一保存立即生效。
        const withRationale = injectRationaleOf(live.injectRationale);
        const picked = selectInjection(available, query, {
          maxEntries: injectMaxEntriesOf(live.injectMaxEntries),
          tokenBudget: injectTokenBudgetOf(live.injectTokenBudget),
          injectMinScoreIdfRatio: minScoreIdfRatio,
          injectMinRelativeToTop: minRelativeToTop,
          heat,
          withRationale,
        });
        if (!picked.count) {
          // 静默失败点②（第 40 轮 R1）：检索跑完了但一个候选都挑不出来 —— 手册可能是空的，
          // 也可能是问法跟手册全不沾边。这个数与 failed 分开放，否则「挑不出来」会让
          // 「检索抛错」看起来像没发生过。
          injectionCache.set(agent, key, { key, text: '', ids: [], tokens: 0, count: 0 });
          injectionStats.skipped += 1;
          injectionStats.failures.empty += 1;
          injectionStats.earlyReturn.by.noAgentPicked += 1;
          const noPickStall = stallRecordOf(agent);
          if (noPickStall) noPickStall.noProduce += 1;
          return;
        }
        injectionFlow.publish(agent, key, picked);
        injectionStats.batches += 1;
        // 第 45 轮（审计风险 4）：记下「最后一次发布批次是什么时候」。只有累计数时，
        // 「注入停发」现场没法回答「是从几点几分开始停的」。
        injectionStats.lastPublishAt = nowStamp();
        // 有产出就**把这个 agent 自己**的「连续无产出」清零（自检看的是连续次数，不是累计次数；
        // 第 45 轮起账按 agent 分表，见 stallRecordOf）。变异实验 M8 钉的就是这一行。
        const producedStall = stallRecordOf(agent);
        if (producedStall) producedStall.noProduce = 0;
        ctx.logger?.info?.('dsh-ace: 注入批次已发布（' + picked.ids.length + ' 条经验：' + picked.ids.join(', ')
          + '，约 ' + (picked.tokens || 0) + ' token；累计批次 ' + injectionStats.batches + '）');
      } catch (error) {
        // 注入是增强项：检索失败绝不能影响宿主收消息。
        // 静默失败点①（第 40 轮 R1）：这个 catch 以前只 warn 一行 + failed+1，
        // 与「挑不出来」共用一个数，看不出到底是抛错还是没命中。现在分开记。
        injectionStats.failed += 1;
        injectionStats.failures.prerecall += 1;
        const failedStall = stallRecordOf(agent);
        if (failedStall) failedStall.noProduce += 1;
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
  // 这里只做薄委托 + 把宿主的 createUserMessage 注入进去（外加 R1 的早退分桶计数）。
  const injectionDelivery = createInjectionDelivery({
    flow: injectionFlow,
    createUserMessage,
    stats: injectionStats,
    logger: ctx.logger,
    injectedIds,
    // 第 45 轮（审计风险 2）：R5 的「连续投递失败」与这里「连续无产出」必须记在
    // **同一张按 agent 分表**的账上，否则自检读到的还是进程级合账。
    stallOf: stallRecordOf,
  });
  // —— 第 50 轮：思考档位（自动降到最低档 + 超时降档重试）——
  // 落在这里而不是 lib/llm.js 的 resolveRoute 旁边，是因为它要读「活的配置」（live）与 llm 服务，
  // 而 resolveRoute 是纯路由解析（reflectProvider/reflectModel 的语义一行都不许动）。
  // 宿主出处（DSH checkout ~ = C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai）：
  //   ctx.llm.resolveModelInfo(provider, model, signal?) ~\dsh-llm\lib\types\index.d.ts:377；
  //   档位表 LlmResolvedModelInfo.reasoning（efforts 由弱到强、efforts[0] 即最低档）~\dsh-llm\lib\types\types.d.ts:367-375；
  //   请求侧 GenerateOptions.reasoningEffort ~\dsh-llm\lib\types\types.d.ts:511。
  // 查询结果由 lib/reasoning.js 按 provider+model 缓存（成功 10 分钟 / 失败 60 秒），
  // 一次复盘的多轮调用因此只查一次宿主；**不为此落盘任何文件**（红线 9）。
  let observedSessionRoute = null; // 最近一次在 pre-step 看到的会话路由，给 GET /efforts 无参时兜底
  const effortWarned = new Set(); // 同一模型同一句话每个进程只落一条 warn（一次复盘 3 轮不该刷 3 行）
  const warnEffortOnce = (provider, model, text) => {
    try {
      const key = String(provider) + '\u0000' + String(model) + '\u0000' + text;
      if (effortWarned.has(key)) return;
      if (effortWarned.size >= 64) effortWarned.clear();
      effortWarned.add(key);
      ctx.logger?.warn?.(text);
    } catch { /* 日志绝不打断复盘 */ }
  };
  // autoReasoningDowngrade 的读法：默认开（用户要求），只有显式 false / 'false' 才算关。
  const autoDowngradeOn = () => {
    const raw = live.autoReasoningDowngrade;
    if (raw === false || raw === 'false') return false;
    return true;
  };
  /**
   * 这次调用该发哪个档位。查询失败/超时只会落一条 warn 然后「不干预」，绝不让复盘失败。
   * @returns {Promise<{effort: string|null, source: 'manual'|'auto'|'none', reason: string|undefined, info: object}>}
   */
  const effortPlanFor = async (route) => {
    const provider = route && route.provider;
    const model = route && route.model;
    const info = await queryModelEfforts(ctx.llm ?? ctx.get?.('llm'), provider, model, { timeoutMs: EFFORT_QUERY_TIMEOUT_MS });
    const plan = planReasoningEffort({
      manual: live.reflectReasoningEffort,
      auto: autoDowngradeOn(),
      info,
      warn: (text) => warnEffortOnce(provider, model, text),
    });
    return { effort: plan.effort, source: plan.source, reason: plan.reason, info };
  };
  ctx.on('agent/pre-step', (payload, next) => {
    // 第 40 轮 R1：preSteps 是「投递接缝有没有被宿主调用」的判据，
    // 与 handled（预检索接缝）分开 —— 只有这两个数一起看，才分得出是哪条接缝没通。
    // 第 45 轮（审计风险 4）：删掉这一行不会有任何测试变红（变异实验 M5）⇒ 补了
    // tests/inject-observability.test.mjs 的「投递接缝被调用」用例钉住它。
    // 注意它**只数接缝被调用**：下游在 next() 里抛错时它照样 +1（bind 时刻就会计数），
    // 那种情形另由 failures.next / earlyReturn.by.downstreamThrew 记（审计风险 5）。
    injectionStats.preSteps += 1;
    // 第 50 轮：顺手记一笔「最近一次观察到的会话路由」，给 GET /api/dsh-ace/efforts 在
    // 没带 provider/model 时兜底（设置页不需要先选模型就能显示「现在实际会用什么档」）。
    // 用 resolveRoute 同一套解析、不新增事件订阅（pre-step 是宿主每一步必经的接缝，
    // 出处 ~\dsh-agent-loop\lib\index.js:902-927）；解析不出来就保持上一次观察值，绝不影响投递。
    try {
      const observedAgent = payload && payload.agent;
      if (observedAgent) observedSessionRoute = resolveRoute(live, { agent: observedAgent });
    } catch { /* 会话没给路由：保留上一次观察到的 */ }
    return injectionDelivery.onPreStep(payload, next);
  });

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
  // 第 39 轮：全局唯一的复盘串行队列（插件自己的等待，不占宿主任何相位）。
  // 总时限/队列上限见 lib/recap-queue.js 的常量注释；实例化时可以按需覆盖以便测试。
  const recapQueue = createRecapQueue({ logger: ctx.logger });

  // 复盘失败/放弃时给用户的那条通知（第 39 轮抽成函数：调度器的 catch 路径与
  // 队列的总时限放弃路径共用同一套文案，避免两处漂移）。
  //
  // 第 39 轮缺陷 1 附带：文案必须分叉，不许再说谎。总时限放弃之后，被 abort 的那份复盘
  // 可能已经把一部分经验写进手册了（abort 检查点在锁外，正在锁内等写入的那段仍会写完），
  // 所以「没有并入手册」是假话 —— 用户 150ms 时被告知没并进去，250ms 后同两条已在手册里
  // （exp/late-write.mjs 实测）。于是放弃走 abandoned、真失败走 failed 两条文案：
  //   - abandoned：如实说「已超过总时限被中断，已写入的部分会保留，未完成的经验可在下回合重试」；
  //   - failed：保持原义（这一份确实什么都没写成，用户重试是有效的）。
  const recapNotifyAbandoned = (agent, reason) => {
    try {
      // content 必须是 ContentBlock[]：这条通知正是当初把裸字符串写进会话历史、
      // 让该会话此后每一轮都撞 .content.some 的那个来源（见 ./notice.js 头注）。
      sendNotice(agent, createUserMessage(noticeMessage({
        text: 'ACE 自动复盘未完成：' + reason + '。本次已超过总时限被中断，已写入的部分会保留，未完成的经验可在下回合重试。',
        summary: 'ACE 自动复盘未完成，已超过总时限被中断，已写入的部分会保留',
      })));
    } catch { /* 注入失败只记录日志，不让复盘失败变成未捕获异常 */ }
  };

  const recapNotifyFailed = (agent, reason) => {
    try {
      // content 必须是 ContentBlock[]：同 recapNotifyAbandoned（见 ./notice.js 头注）。
      sendNotice(agent, createUserMessage(noticeMessage({
        text: 'ACE 自动复盘未完成：' + reason + '。本次沉淀的经验没有并入手册，可重试。',
        summary: 'ACE 自动复盘未完成，经验未并入手册',
      })));
    } catch { /* 注入失败只记录日志，不让复盘失败变成未捕获异常 */ }
  };

  // 队列满额、最旧那一份被真丢弃时的通知（第 40 轮缺陷 6）。
  // 以前这条路径完全静默：只在日志里留一句，用户那一轮攒下的经验就这么没了，
  // 而手册看起来「什么都没变」——他只会以为自动复盘坏了。文案必须说真话：
  // 这次是真的丢了 + 下回合还能重新攒一次再试（不是「稍后处理」那种含糊话）。
  const recapNotifyDropped = (agent, reason) => {
    try {
      sendNotice(agent, createUserMessage(noticeMessage({
        text: 'ACE 自动复盘已丢弃一轮经验：' + reason + '。这份经验这次没有并入手册，'
          + '下一次回合结束时会重新判定、重新攒，可照常继续工作。',
        summary: 'ACE 自动复盘丢弃了一轮经验（队列已满），可下回合重试',
      })));
    } catch { /* 注入失败只记录日志，不让通知失败变成未捕获异常 */ }
  };

  // 第 40 轮缺陷 6：队列的 merge 回调（真正接上生产路径）。
  //
  // 以前 enqueue 只传一个参数 ⇒ lib/recap-queue.js 的合并分支**在生产里根本走不到**，
  // 「已有待跑项」时永远排长队 → 涨到 MAX_QUEUED_RECAPS(=2) → shift 掉最旧的一份。
  // 接上之后，同一轮里连续两个回合都要复盘时，第二份并进第一份，队列长度保持不变。
  //
  // 合并语义（与 lib/recap-queue.js「已有待跑项则合并」一致）：
  // - label 记成「回合 2+5」，日志/通知里能看出这是两个回合的合并件；
  // - run 换成把两份摘要**一起**喂给同一条复盘流水线（不跑两遍 LLM、token 不翻倍）；
  // - 摘要拼接时新回合在前（最新改动最可能有价值），两份各分一半整条喂料上限
  //   TRAJECTORY_DEFAULTS.maxChars，超了就保留开头 —— 宁可少喂，也不许把 LLM 输入顶爆；
  // - onGiveUp / onFailed 两份都调（谁失败都得说、谁吃掉的 mutating 额度都得还）。
  const mergeRecapItems = (last, item) => {
    if (!last || !item || typeof item.summary !== 'string') return false;
    // 一份待跑项**最多吸收一个回合**（第 40 轮缺陷 6 的边界口径）。
    // 没有这条上限时，只要队列里还排着一项，后来的每一份都会并进去：摘要链式拼接会越裁越碎、
    // 最终把整条喂料上限顶爆；更要紧的是「队列满额丢弃」会变成永远不可达的死代码，
    // 连带着缺陷 6 里那条「经验被丢了要告诉用户」的 notice 也一起废掉（用户永远看不到真话）。
    // 上限 1 之后：合并仍是常态（不排长队、不丢经验），只有连续多份挤在同一窗口才会真排队，
    // 排满了才丢最旧的那一份并走 notice —— 那时文案说的才是真发生的事。
    if (last.mergedOnce) return false;
    const budget = Math.max(1, Math.floor((TRAJECTORY_DEFAULTS.maxChars || 12000) / 2));
    const clip = (text) => {
      if (typeof text !== 'string') return '';
      if (text.length <= budget) return text;
      return text.slice(0, budget) + '\n……（合并后的摘要已按半份预算截断）';
    };
    const newer = clip(item.summary);
    const older = clip(last.summary);
    if (!newer && !older) return false;
    const mergedSummary = !older ? newer : (!newer ? older
      : '（本份合并了两个回合的待复盘经验：先是较新的那个回合，再是更早那个回合。）\n\n'
        + newer + '\n\n---\n\n' + older);
    const mergedAgent = last.agent || item.agent;
    if (!mergedAgent) return false;
    const lastLabel = typeof last.label === 'string' ? last.label : '';
    const itemLabel = (typeof item.label === 'string' ? item.label : '').replace(/^回合\s*/u, '');
    last.label = lastLabel && itemLabel ? lastLabel + '+' + itemLabel : (lastLabel || itemLabel);
    last.summary = mergedSummary;
    last.agent = mergedAgent;
    last.run = async (signal, budget) => executeRecap({ agent: mergedAgent, summary: mergedSummary, signal, deadlineAt: budget?.deadlineAt });
    const lastGiveUp = last.onGiveUp;
    const itemGiveUp = item.onGiveUp;
    last.onGiveUp = (reason) => {
      if (typeof lastGiveUp === 'function') lastGiveUp(reason);
      if (typeof itemGiveUp === 'function') itemGiveUp(reason);
    };
    const lastFailed = last.onFailed;
    const itemFailed = item.onFailed;
    last.onFailed = (reason) => {
      if (typeof lastFailed === 'function') lastFailed(reason);
      if (typeof itemFailed === 'function') itemFailed(reason);
    };
    // 记下「这一份已经吸收过一个回合」，下一次 enqueue 遇到它就不再合并（见上方的上限说明）。
    last.mergedOnce = true;
    return true;
  };

  const recapController = createRecapController({
    getConfig: () => live,
    logger: ctx.logger,
    // 真实失败（LLM 调用失败、手册写入失败等）才给用户推一条提示；宿主忙碌这种预期内竞态只写日志。
    notifyFailure: recapNotifyFailed,
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
      // 第 39 轮：复盘不再占宿主维护相位（agent.runMaintenance），改由插件自己的串行队列跑。
      // 为什么：宿主 runMaintenance 在 job 返回前一直保持 phase.kind === 'maintenance'，
      // 而 wakeDriver 在非 idle 相位只置 wakeRequested 就 return —— 复盘不结束，
      // 之后到达的用户消息永远排队（UI「发出去了完全没反应」）。详见 lib/recap-queue.js 头注。
      // 宿主维护相位的 signal 在这里不再有（复盘不占相位），executeRecap 只收
      // {agent, summary, signal} 三个字段（tests/trajectory.test.mjs:510 钉住这个字面调用）。
      // 真正决定「何时放弃」的 signal 由队列给：enqueue 之后队列会为每一份建一个
      // AbortController，到点 abort 并把 signal 作为第一个参数传进 run —— 所以这里
      // **不再**自己造 undefined 的 signal（第 39 轮缺陷 1：不接线就等于总时限叫不停）。
      const agentId = agentLabel(agent);
      // 队列项携带三种回调：
      // - onGiveUp(reason)：总时限放弃 + 真失败都通知（用户不能看到静默放弃）；
      // - onFailed(reason)：**只有真失败**才通知，用来补回 mutating 计数（缺陷 2）；
      // - run(signal)：把队列的 signal 一路透传到 executeRecap → runRecapPipeline → oneShot。
      //
      // 缺陷 2 的回滚为什么要放在这里：真实失败发生在队列里（executeRecap 抛错），
      // 而 lib/recap.js 的 catch 只在 runRecap **同步**抛错时触发 —— 队列里跑的那份
      // 根本不经过那条 catch，于是那一次 mutating 额度被吞掉（threshold>1 时要重新攒满，
      // exp/acct.mjs 场景 1 vs 场景 2 实测 mutCount 0 vs 1）。这里补一个 onFailed 钩子，
      // 走与 lib/recap.js 的 restorePendingMutCount 口径完全相同（同一本 SETTLED_PENDINGS
      // 账本 + ownsPending 所有权判定，重复结算会被拒）。
      // 刻意**不**改成 await 回传：那会重新引入「等复盘结束」，违背本次硬化的初衷。
      recapQueue.enqueue({
        agentId,
        label: '回合 ' + pending.turn,
        // 第 40 轮缺陷 6：合并分支需要的三个字段 —— 摘要、agent（合并件要能独立重跑）、
        // 以及下面第二参数的 mergeRecapItems。
        summary,
        agent,
        // 第 45 轮：队列把这份复盘的绝对截止时刻（第二参 budget.deadlineAt）传进来，
        // executeRecap 再传给复盘管线 —— 每次LLM 调用按剩余预算派上限，
        // 提炼/合并/落盘在总时限里各有份额，不再整份撞死在 120000ms 上。
        run: async (signal, budget) => executeRecap({ agent, summary, signal, deadlineAt: budget?.deadlineAt }),
        // 第 40 轮缺陷 6：队列满额丢弃时发一次性 notice（以前完全静默 = 用户永远不知道经验被丢）。
        onDrop: (reason) => {
          const st = recapController.stateFor(agent);
          // 丢弃 = 这一份压根没跑，吃掉的 mutating 额度必须还回去，否则用户得白攒好几轮
          // （与 onFailed 同口径，见 lib/trigger.js 的 restorePendingMutCount）。
          restorePendingMutCount(st, pending, ctx.logger);
          recapNotifyDropped(agent, reason);
        },
        onGiveUp: (reason) => {
          // 放弃与失败的文案必须分叉（缺陷 1 附带）：放弃那份可能已写部分手册，
          // 说「没有并入手册」是说谎。区分方式是 reason 的前缀（队列放弃时恒为
          // '复盘超过总时限 Nms'，真失败恒为 '复盘失败（…）'）。
          if (typeof reason === 'string' && reason.startsWith('复盘超过总时限')) recapNotifyAbandoned(agent, reason);
          else recapNotifyFailed(agent, reason);
        },
        onFailed: (reason) => {
          // 真失败（非总时限放弃）：把这一份待办吃掉的 mutating 计数还回状态，
          // 之后的回合仍有机会重新判定并复盘。冷却不回滚——失败说明确实尝试过，
          // 这与 lib/recap.js 的 restorePendingMutCount 口径一致。
          const st = recapController.stateFor(agent);
          restorePendingMutCount(st, pending, ctx.logger);
        },
      // 第二参数：合并回调（第 40 轮缺陷 6）。不传它 ⇒ 队列的合并分支在生产里永远走不到，
      // 只剩「排长队 → 满额丢最旧」这一条路径。
      }, mergeRecapItems);
      recapQueue.drain();
      // 入队即返回：调度器（lib/recap.js onStatus）await 的只是这一句，复盘本身在队列里跑，
      // 用户消息不被这段 promise 挡住。成功/失败的通知由队列内部的日志 + notifyFailure 负责。
      return { queued: true };
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
    // 第 40 轮 R5：顺手做一次注入链路自检（连续 N 次无产出就发一次性 notice，见
    // checkInjectionStall）。放在这里是因为「回合收尾」是唯一稳定、每个回合都会来一次、
    // 且之后用户还会继续发消息的时点。它自己吞掉所有异常，绝不打断 recapController。
    checkInjectionStall(payload);
  });

  // 空闲边沿才真正执行复盘（宿主此刻已是 idle 相位，runMaintenance 合法）。
  ctx.on('agent/status', (payload) => {
    void recapController.onStatus(payload);
  });

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

  /** 日志里用的 agent 标识：拿不到 id/name 时就写占位符（绝不让日志本身抛错）。 */
  function agentLabel(agent) {
    const id = agent && (agent.id || agent.name);
    return typeof id === 'string' && id ? id : '(未知 agent)';
  }

  /**
   * 一次 Reflector 调用：喂轨迹（+ 多轮时追加「已提炼候选」）→ 解析 → 过滤出合法候选。
   * LLM 输出必须先过 extractJsonObject 校验（红线 3），四个字段齐全才算候选。
   * maxMs（第 45 轮）：复盘预算派下来的本次调用上限，透传给 oneShot（不传 = 只受单次上限管）。
   *
   * @returns {Promise<object[]>} 本轮的候选（可能是空数组）
   */
  async function reflectRound({ agent, summary, outcome, playbookDigest, route, signal, priorCandidates, round, maxMs, reasoningEffort }) {
    const raw = await oneShot(ctx, {
      provider: route.provider,
      model: route.model,
      system: REFLECTOR_SYSTEM,
      userText: reflectorUserInput({ summary, outcome, playbookDigest, priorCandidates, round }),
      signal,
      maxMs,
      // 第 50 轮：档位由调用方（executeRecap 的 reflectRound 包装 / 超时降档重试）算好传进来。
      // 不传 = 不干预，oneShot 就不会写 options.reasoningEffort（沿用宿主 profile 的默认档）。
      reasoningEffort,
    });
    // 健壮性缺口 B2：解析失败先把现场（原文、字符数、轮次、路由）落盘，再把错误原样上抛 ——
    // 复盘照旧失败，但下次能从 raw.jsonl 直接看见模型到底吐了什么。
    // 仍属红线 3：原始文本只进调试日志，绝不进手册。
    let parsed;
    try {
      parsed = extractJsonObject(raw);
    } catch (error) {
      await dumpRaw({ stage: 'reflect', round, provider: route.provider, model: route.model, raw, error });
      // 第 49 轮：整体未闭合时先回收已经写完整的候选（线上 1842 字符那次是在某个 rationale 中间被超时切断，
      // 前面几条其实完好）。回收不着才保持原来的抛错语义；回收到的仍是原始对象，照旧过后面的四字段过滤（红线 3）。
      const salvaged = recoverCandidatesFromUnclosed(raw);
      if (!salvaged.length) throw error;
      parsed = { candidates: salvaged };
    }
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
   * 多轮复盘（C3）：Reflector 最多跑 REFLECT_MAX_ROUNDS 轮（默认 2），第 2 轮把「轨迹 + 之前轮次
   * 已提炼的全部候选」一起喂进去，要求只提炼还没覆盖到的新经验。**收敛判据纯程序化**：
   * 某轮返回空数组即停（不许模型自声明收敛），轮数上限 2 轮硬停；超时/取消由 signal 中断，
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
  async function executeRecap({ agent, summary, signal, deadlineAt }) {
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

      // 第 50 轮：每一次 Reflector 调用都先算「这次该用哪个思考档」（手动值 / 自动降到最低档 / 不干预），
      // 显式传给 oneShot —— 宿主会话默认档位的解析在 ~\dsh-llm-pi-ai\lib\index.js:1953 是
      // resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)，profile 里写了档位就会
      // 盖过模型的 defaultEffort，所以「不传」既不是最低档、也不是模型默认档，必须显式传才生效。
      // 超时降档重试会把 reasoningEffort 直接传下来（那时不再重新判定，用的就是降过的那一档）。
      reflectRound: async ({ agent: a, summary: s, outcome, playbookDigest, priorCandidates, round, signal: sig, maxMs, reasoningEffort }) => {
        const route = resolveRoute(live, { agent: a });
        const effort = typeof reasoningEffort === 'string' && reasoningEffort !== ''
          ? reasoningEffort
          : (await effortPlanFor(route)).effort;
        return reflectRound({ agent: a, summary: s, outcome, playbookDigest, route, signal: sig, priorCandidates, round, maxMs, reasoningEffort: effort });
      },
      // 第 50 轮「超时降档重试一次」的降档钩子：管线在某一轮因**超时**失败时问它「降到哪一档」。
      // 查宿主失败/只有一档/没有档位信息一律返回 null ⇒ 管线原样上抛、不重试，旧行为一字不变。
      // refresh:true 绕开失败缓存 —— 首次查询失败的那次别被 60 秒的失败缓存判死。
      downgradeEffort: async () => {
        const route = resolveRoute(live, { agent });
        const info = await queryModelEfforts(ctx.llm ?? ctx.get?.('llm'), route.provider, route.model, {
          timeoutMs: EFFORT_QUERY_TIMEOUT_MS,
          refresh: true,
        });
        return lowestEffortOf(info);
      },
      // LLM 合并（第 33 轮）：与 Reflector 同一条 LLM 路径（lib/llm.js 的 oneShot），
      // 不新开连接方式、不新增依赖。契约见 lib/merge-llm.js 的 planMerges：
      // ask({ userText, signal, maxMs }) → 原始输出字符串，解析与校验都在 merge-llm 里做。
      // 第 45 轮：maxMs 是 planMerges 按剩余预算算出的本次调用上限，透传给 oneShot。
      mergeAsk: async ({ userText, signal: sig, maxMs }) => {
        const route = resolveRoute(live, { agent });
        // 第 50 轮：合并与复盘走同一档位判定 —— 同一份复盘里的两次 LLM 调用不该一个降档一个不降。
        const effort = (await effortPlanFor(route)).effort;
        return oneShot(ctx, {
          provider: route.provider,
          model: route.model,
          system: MERGE_SYSTEM,
          userText,
          signal: sig,
          maxMs,
          reasoningEffort: effort,
        });
      },
      // 合并失败现场要记 provider/model（第 48 轮第二轮 Gap 4）：recap-pipeline 的 tryMerge 在调
      // planMerges 之前取一次路由，原样透传到 parseMergeResult 的 dumpRaw。只取路由、不发请求，
      // 不参与任何合并判定，放在锁外（与 mergeAsk 同一处、同样不缓存）。
      mergeRoute: () => {
        const route = resolveRoute(live, { agent });
        return { provider: route.provider, model: route.model };
      },
    }, { agent, summary, signal, deadlineAt });
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
      // 第 50 轮：手动 ace_reflect 与自动复盘同一档位口径（同一份配置、同一个模型，档位不该两样）。
      const effort = (await effortPlanFor(route)).effort;
      const raw = await oneShot(ctx, {
        provider: route.provider,
        model: route.model,
        system: REFLECTOR_SYSTEM,
        userText: reflectorUserInput({ summary: args.summary, outcome: args.outcome, playbookDigest: digestEntries(entries).join('\n') }),
        reasoningEffort: effort,
        // 第 51 轮（D1）：把**调用方自己的**取消信号透传下去。宿主的 ToolExecutionInput 带
        // `signal: AbortSignal`（dsh-tools lib/types/index.d.ts:241），这个信号的所有权归调用方
        // （回合被停、传输层断开），本插件只是借用。
        //
        // 必须传的理由：lib/llm.js:169 靠「调用方 signal 自己是否已中止」来区分两种
        // finish{kind:'aborted'} —— 本层单次上限到点（报文必须带 'ace: LLM 调用超时' 前缀，
        // lib/reflect.js:17-21 的 isTimeoutError 靠它给整份复盘留「按已提炼候选收尾」的豁免）
        // 与调用方取消（报文是 'ace: LLM 调用被取消'，不许被当成超时假成功）。不透传时这个判据
        // 退化成「合并信号已 abort」，而 cap 到点必然让它 abort ⇒ 超时被误报成取消、豁免失效。
        //
        // `exec && exec.signal` 是显式防御：exec 既可能没有 signal（老版本宿主 / 测试里的
        // 直调 `execute(args, {agent})`，tests/wiring.test.mjs 的 R48-F3 就是这种），也可能整个
        // exec 为 undefined（makeResolver 用 `exec && exec.agent` 同一写法）。lib/llm.js:74 的
        // mergeSignals 对 !signal 有分支，undefined 落回「只有本地上限」的旧行为，安全。
        signal: exec && exec.signal,
      });
      let parsed;
      try {
        parsed = extractJsonObject(raw);
      } catch (error) {
        // F3（第 48 轮第五轮）：手动复盘与自动复盘（reflectRound）对齐 —— 解析失败先留一份现场
        // （provider/model 取自本次路由，只用于把日志写得更可查、不参与任何判定），再把原生错误
        // 原样抛回工具层，工具的错误语义一个字不变。dumpRaw 永不 reject、也绝不在锁区间内调用。
        await dumpRaw({ stage: 'reflect', provider: route.provider, model: route.model, raw, error });
        // 第 49 轮：与 reflectRound 同一口径 —— 未闭合时先回收已写完整的候选，一条都收不着才原样抛。
        const salvaged = recoverCandidatesFromUnclosed(raw);
        if (!salvaged.length) throw error;
        parsed = { candidates: salvaged };
      }
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
        // 第 45 轮（审计风险 1）：这条直写路径同样必须带 logger —— 否则 lib/commit.js 的
        // 对账自愈（摘错位条目 / 保留正文不同的那条）在这里静默发生，人查不到原因。
        logger: ctx.logger,
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
        // —— 第 40 轮缺陷 5：手动复盘不再进宿主的维护相位 ——
        //
        // 以前这里 await agent.runMaintenance(...)。宿主 runMaintenance 在 job 返回前
        // 一直保持 phase.kind === 'maintenance'（~\@deepseek-ai\dsh-agent-loop\lib\index.js:822-845），
        // 而 wakeDriver 在非 idle 相位只把用户的新消息 latch 成 wakeRequested 就 return
        // （同文件 :854-858）—— 复盘不结束，这条新消息就一直不被拉起，这正是「消息发出去了
        // 完全没反应」的原症状。第 39 轮把自动复盘迁到了插件自有的串行队列（lib/recap-queue.js），
        // 但手动路径仍然占着维护相位，于是老毛病在 /ace 上原样保留。
        // 现在手动复盘和自动复盘走**同一条**队列：全局唯一在跑、FIFO、已有待跑项则合并、
        // maxConcurrent=1（见 lib/recap-queue.js 头注），复盘在插件自己的 promise 里跑，
        // 宿主相位始终 idle —— 用户随时发消息都能立刻被拉起。
        //
        // 返回值语义保持不变（四条分支）：
        //   完成 / agent 正在忙 / 复盘失败 / 当前环境不支持 —— 只是判据换成队列与队列的结果，
        //   不再依赖宿主 runMaintenance 是否存在、是否抛 busy。
        // 「等」的那一下只发生在命令 handler 自己的 promise 里（等这一份 settle），
        // 它不占任何相位；用户看到的是命令结果，不是被冻住的会话。
        if (!agent) return { kind: 'success', text: 'ace: 当前环境不支持（没有可用的 agent）。' };
        if (recapQueue.busy) return { kind: 'error', text: 'ace: agent 正在忙，稍后重试。' };
        const manualSummary = invocation?.rawInput || '手动复盘';
        // onSettled 每份恰好回调一次（成功 / 超时放弃 / 真失败 / 被丢弃 / 被合并），
        // 这里用它把「队列里跑完的结论」变成一个命令返回值。
        let resolveSettled;
        const settled = new Promise((resolve) => { resolveSettled = resolve; });
        recapQueue.enqueue({
          agentId: agentLabel(agent),
          label: '手动复盘',
          summary: manualSummary,
          agent,
          run: async (signal, budget) => executeRecap({ agent, summary: manualSummary, signal, deadlineAt: budget?.deadlineAt }),
          // 手动路径不推自动复盘那两条通知：命令本身就会把结论回给用户，
          // 再推一条 followup 只会让同一个结论在会话里出现两遍。
          onSettled: (outcome) => resolveSettled(outcome),
        });
        recapQueue.drain();
        const outcome = await settled;
        if (outcome && outcome.ok) {
          const result = outcome.result;
          const conflictText = result?.conflicts?.length
            ? '（' + renderConflictNotice(result.conflicts) + '）'
            : '';
          return { kind: 'success', text: 'ace: 复盘完成，新增 ' + (result?.added?.length || 0) + ' 条。' + conflictText };
        }
        return { kind: 'error', text: 'ace: 复盘失败（' + ((outcome && outcome.reason) || '未知原因') + '）' };
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
        injectMinScoreIdfRatio: INJECT_MIN_SCORE_IDF_RATIO_RANGE,
        injectMinRelativeToTop: INJECT_MIN_RELATIVE_TO_TOP_RANGE,
        // 第 50 轮：思考档位的合法集（字符串枚举，不是区间）。设置页的档位下拉拿它做白名单，
        // 具体某个模型声明了哪些档位走 GET /api/dsh-ace/efforts。
        reasoningEfforts: REASONING_EFFORT_IDS,
        defaults: {
          evictProtectDays: DEFAULT_EVICT_PROTECT_DAYS,
          injectTokenBudget: DEFAULT_INJECT_TOKEN_BUDGET,
          injectMaxEntries: DEFAULT_INJECT_MAX_ENTRIES,
          injectMinScoreIdfRatio: DEFAULT_INJECT_MIN_SCORE_IDF_RATIO,
          injectMinRelativeToTop: DEFAULT_INJECT_MIN_RELATIVE_TO_TOP,
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
              // 第 40 轮 R1：注入链路的诊断快照挂在**并列键** injection 上（不是 runtime 的子键）。
              // runtime 是 lib/stats.js / 前端共同钉死的精确七键，不许加键；而这里要答的问题是
              // 「handler 到底有没有被调用」，与 runtime 那六个业务计数不是一回事。
              // 降级分支也照样带上它 —— 与 runtime 同理，它只读内存、不依赖手册能否读出来。
              return send(200, { ...stats, injection: injectionSnapshot() });
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法统计手册（' + (error?.message ?? error) + '）');
              // 兜底也返回与成功路径**同形**的零值 payload（scale / daily / recent / source /
              // windowDays / generatedAt 一个不少，值全为 0 或空数组），只多一个 reason 说明降级原因。
              // 旧版这里只回 { ok:true, reason:'unreadable' }，缺字段让客户端判失败、整块显示
              // 「统计不可用：宿主可能还没重启」——缺字段不是「没数据」，别让页面把降级当崩溃。
              return send(200, {
                ...emptyStats(STATS_REASONS.unreadable, { maxEntries: live.maxEntries, runtime: runtimeSnapshot() }),
                injection: injectionSnapshot(),
              });
            }
          }
          // POST /api/dsh-ace/entries/archive：设置页「记录」页的**手动归档**写入口（唯一的新增写路由）。
          // 语义 = 把一条活跃条目从手册搬进同目录的 archive.md，**绝不物理删除**（红线 7）。
          // 写入通道完全复用 lib/commit.js 的 commitOps：一个 remove 操作就会走
          // 「先 appendArchivedEntries 写归档文件、再 writeFileAtomic 写手册」的锁内硬顺序（红线 2），
          // 归档原因由 lib/playbook.js 的 applyOps 定死为 'removed-by-request'，
          // ID 高水位也由 commitOps 统一取「活跃 + 归档」两侧的最大编号（红线 7），本路由不另算。
          // 失败一律结构化非 2xx + { error }，绝不 500 拖垮整页（客户端把 error 原文显示在页面上）。
          if (routePath === '/entries/archive') {
            // 精确串比较：'/entries/archive' 与 '/entries' 是两个串，绝不 startsWith 混起来。
            // GET（含其余任何非 POST）→ 405，保留「本路由只写不读」的语义。
            if (method !== 'POST') return send(405, { error: 'method not allowed' });
            const payload = await readJson(req);
            const id = payload && typeof payload.id === 'string' ? payload.id.trim() : '';
            if (!/^ace-\d+$/.test(id)) return send(400, { error: 'id 非法：必须形如 ace-<数字>' });
            let target = '';
            try {
              target = await resolveFile({});
            } catch (error) {
              // 相对 playbookPath 需要会话上下文，HTTP 面没有 agent → 直接结构化拒绝，不猜路径。
              return send(400, { error: String(error?.message ?? error) });
            }
            try {
              const snapshot = await readPlaybookSnapshot(target);
              if (!snapshot.entries.some((entry) => entry.id === id)) {
                return send(404, { error: '条目不存在或不在活跃区：' + id });
              }
              const today = dayString();
              const { conflicts, result } = await commitOps(target, snapshot, [{ op: 'remove', id }], live.maxEntries, {
                archiveFile: await resolveArchive({}),
                today,
                logger: ctx.logger,
              });
              if (!result.removed.includes(id)) {
                ctx.logger?.warn?.('dsh-ace: 手动归档未生效（' + id + '），冲突 ' + conflicts.length + ' 条');
                return send(409, { error: '条目在归档过程中被改动，请刷新后重试：' + id });
              }
              const moved = (result.removedEntries || []).find((entry) => entry.id === id);
              const reason = moved?.archive?.reason || 'removed-by-request';
              const date = moved?.archive?.date || today;
              // 记账只走既有 noteArchived：runtime 的 archived / archivedByReason 与 /stats 天然对得上（红线 9）。
              noteArchived(result.archived && result.archived.length ? result.archived : [{ id, reason, supersededBy: '' }]);
              ctx.logger?.info?.(
                'dsh-ace: 手动归档 1 条（' + id + '，reason=' + reason + '），累计归档 ' + archiveStats.archived + ' 条、removed-by-request ' + archiveStats.byReason['removed-by-request'] + ' 条',
              );
              return send(200, { ok: true, archived: { id, reason, date } });
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 手动归档失败（' + id + '）：' + (error?.message ?? error) + '）');
              return send(500, { error: String(error?.message ?? error) });
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
          // —— 第 50 轮：GET /api/dsh-ace/efforts —— 设置页「思考强度」下拉的数据源 ——
          // 返回体形状是与前端约定死的（client.js 的 EFFORTS_ROUTE 已按这个形状写好，只许加字段不许改名）：
          //   { ok:true, provider, model, efforts:[{id,name,description?}], defaultEffort?, effective:{ effort, source, reason? } }
          // 规则：
          //   - provider/model 都给了就用它们；**都没给**才回落到「最近一次在 pre-step 观察到的会话路由」；
          //   - 从没观察到会话 → 结构化 { ok:false, error:'ace: session model unknown' }，**绝不 500**；
          //   - 只解析问到的这一个 provider+model（绝不逐个 provider 全量解析）；
          //   - 任何失败都返回结构化 JSON、不抛到路由外（照 /catalog 的容错风格），宿主查询失败只 warn。
          if (routePath === '/efforts') {
            if (method !== 'GET') return send(405, { error: 'method not allowed' });
            const askedProvider = url.searchParams.get('provider');
            const askedModel = url.searchParams.get('model');
            const target = askedProvider && askedModel
              ? { provider: askedProvider, model: askedModel }
              : observedSessionRoute;
            if (!target || !target.provider || !target.model) {
              return send(200, { ok: false, error: 'ace: session model unknown' });
            }
            try {
              const info = await queryModelEfforts(ctx.llm ?? ctx.get?.('llm'), target.provider, target.model, {
                timeoutMs: EFFORT_QUERY_TIMEOUT_MS,
              });
              if (!info.ok) {
                ctx.logger?.warn?.('dsh-ace: 无法读取思考档位（' + target.provider + '/' + target.model + '：' + info.error + '）');
                return send(200, { ok: false, error: 'ace: ' + info.error });
              }
              const plan = planReasoningEffort({
                manual: live.reflectReasoningEffort,
                auto: autoDowngradeOn(),
                info,
                warn: (text) => warnEffortOnce(target.provider, target.model, text),
              });
              return send(200, {
                ok: true,
                provider: info.provider,
                model: info.model,
                efforts: info.efforts,
                ...(info.defaultEffort === undefined ? {} : { defaultEffort: info.defaultEffort }),
                // effective：设置页据此显示「现在实际会用什么档」。effort:null = 本插件不干预（沿用宿主默认档）。
                effective: {
                  effort: plan.effort === undefined ? null : plan.effort,
                  source: plan.source,
                  ...(plan.reason === undefined ? {} : { reason: plan.reason }),
                },
              });
            } catch (error) {
              ctx.logger?.warn?.('dsh-ace: 无法读取思考档位（' + (error?.message ?? error) + '）');
              return send(200, { ok: false, error: 'ace: ' + String(error?.message ?? error) });
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
          if ('injectMinScoreIdfRatio' in body) {
            touched = true;
            const value = validRatio(body.injectMinScoreIdfRatio, INJECT_MIN_SCORE_IDF_RATIO_RANGE);
            if (value === undefined) error = `injectMinScoreIdfRatio 必须是 ${INJECT_MIN_SCORE_IDF_RATIO_RANGE[0]}–${INJECT_MIN_SCORE_IDF_RATIO_RANGE[1]} 的数（0 = 关掉绝对门槛）`;
            else next.injectMinScoreIdfRatio = value;
          }
          if ('injectMinRelativeToTop' in body) {
            touched = true;
            const value = validRatio(body.injectMinRelativeToTop, INJECT_MIN_RELATIVE_TO_TOP_RANGE);
            if (value === undefined) error = `injectMinRelativeToTop 必须是 ${INJECT_MIN_RELATIVE_TO_TOP_RANGE[0]}–${INJECT_MIN_RELATIVE_TO_TOP_RANGE[1]} 的数（0 = 关掉相对门槛）`;
            else next.injectMinRelativeToTop = value;
          }
          if ('injectRationale' in body) {
            touched = true;
            const value = validFlag(body.injectRationale);
            if (value === undefined) error = 'injectRationale 必须是 true 或 false';
            else next.injectRationale = value;
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
          // 第 50 轮：思考强度。**空串是合法值**（= 未手动指定、跟随自动降档），不能被当成非法拒掉。
          if ('reflectReasoningEffort' in body) {
            touched = true;
            const value = validReasoningEffort(body.reflectReasoningEffort);
            if (value === undefined) error = 'reflectReasoningEffort 必须是 ' + REASONING_EFFORT_IDS.join('/') + ' 之一，或留空表示跟随自动降档';
            else next.reflectReasoningEffort = value;
          }
          if ('autoReasoningDowngrade' in body) {
            touched = true;
            const value = validFlag(body.autoReasoningDowngrade);
            if (value === undefined) error = 'autoReasoningDowngrade 必须是 true 或 false';
            else next.autoReasoningDowngrade = value;
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
            '，注入依据 ' + (live.injectRationale ? '开' : '关') +
            '，容量 ' + live.maxEntries + '）',
          );
          return send(200, describe());
        },
      }),
      'dsh-ace: settings api',
    );
  });

  // 第 40 轮 R2：**一次性开机日志**，把「两条注入接缝到底挂上了没有」写进日志。
  // 全库最后一次真注入停在 2026-10-26T14:03:02.375Z，事后既没有日志也没有计数能回答
  // 「apply 跑完了吗、这两条 handler 挂上去了吗」，只能靠猜。这一行就是那个答案：
  // 日志里有它 + 两个开关的值 ⇒ 插件装配完整、注入接缝在位（之后没注入就只能是
  // handler 早退或抛错，那两种看 /api/dsh-ace/stats 的 injection 块）。
  // 只打一次，用现有 ctx.logger，不引入新依赖、不新增落盘文件（红线 9）。
  ctx.logger?.info?.(
    'dsh-ace: 注入接缝已挂载（inbox handler + pre-step delivery）；autoRecap=' + (live.autoRecap ? '开' : '关')
    + ' autoReflect=' + (live.autoReflect ? '开' : '关')
    + ' injectRationale=' + (live.injectRationale ? '开' : '关'),
  );
}
