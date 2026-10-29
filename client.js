// dsh-ace 的浏览器半边：在 DSH 设置面板里注册一个独立的「ACE 手册」配置页。
//
// 挂载点：settings.section（ui-settings-general 声明的 list slot；注册选项 id/order/label，
// 占位组件收到 { close }。契约出处：DSH checkout ~\@deepseek-ai\dsh-client-ui-settings\
// lib\types\client\contract\slots.d.ts:73-77,147-157）。
//
// 数据源：宿主侧的 /api/dsh-ace/settings（lib/index.js 末尾的 ctx.inject(['webServer'])）。
// 这里**不**依赖 configForms：宿主并不服务 dsh-ace 命名空间，把 configForms 写进 fiber
// inject 会让 apply 永远等不到服务、页面永不注册（这是本页第一版不出现的真正原因）。
// 客户端只 inject ['slots', 'locale']，读写走 fetch —— 范式同 dsh-insert-context/client.js:19-30。
//
// 视觉：应用户要求本页固定 VCP 暗色 + JetBrains Maple Mono，不走宿主主题 token。
window.__ModuleLoader__.load({
  id: 'dsh-ace',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'settings.dshAce';
    const ROUTE = '/api/dsh-ace/settings';
    // 模型目录（宿主 lib/index.js 的 GET /catalog）：两个下拉的数据源。
    const CATALOG_ROUTE = '/api/dsh-ace/catalog';
    // 思考强度档位：按 provider/model 查该模型声明了哪些档位（不带参数时后端用最近观察到的会话模型）。
    const EFFORTS_ROUTE = '/api/dsh-ace/efforts';
    // 后端钉死的七个合法档位名（小写）。前端只提交这些值：收到别的值一律当「该模型未声明档位」，
    // 绝不让一个宿主流派发不出去的字符串进配置。
    const EFFORT_LEVEL_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    // 待合并复审列表（宿主 lib/index.js 的 GET /inbox）：只读，失败时静默降级。
    const INBOX_ROUTE = '/api/dsh-ace/inbox';
    // 手册统计（宿主 lib/index.js 的 GET /stats）：只读，失败时静默降级成一行灰字。
    const STATS_ROUTE = '/api/dsh-ace/stats';
    // 手册条目清单（宿主 lib/index.js 的 GET /entries，数据源 lib/entries.js）：只读，
    // 记录页懒加载 —— 第一次切到记录页才拉，切走再回来不重复请求。
    const ENTRIES_ROUTE = '/api/dsh-ace/entries';
    // 手动归档（宿主 lib/index.js 的 POST /entries/archive）：把一条活跃条目搬进 archive.md，
    // 两段式确认后才发；动作本身是搬移，绝不物理删除。
    const ENTRIES_ARCHIVE_ROUTE = '/api/dsh-ace/entries/archive';
    const inject = ['slots', 'locale'];

    const zh = {
      'meta.title': 'ACE 手册',
      'meta.description': '可进化的操作手册（playbook）：任务前查阅既往经验，任务后复盘沉淀新经验。在这里配置手册路径、复盘提醒、Reflector/Curator 的模型覆盖与手册容量。',
      nav: 'ACE 手册',
      title: 'ACE 手册',
      subtitle: '可进化的操作手册（playbook）：复盘沉淀经验，任务前查阅',
      sectionTag: 'ACE PLAYBOOK',
      fieldPlaybookPath: '手册路径',
      fieldPlaybookPathDesc: '留空 = 本机共享手册（<DSH home>/ace/playbook.md，跨工作区共用一本）；相对路径 = 该工作区私有（相对会话工作目录解析）；绝对路径（支持 ~ 开头）原样使用',
      playbookPathPlaceholder: '留空 = 本机共享手册；相对路径 = 该工作区私有',
      fieldAutoReflect: '任务完成后提醒复盘',
      fieldAutoReflectDesc: '在系统提示里提醒 agent 主动调用 ace_reflect 复盘',
      fieldProvider: '复盘 provider 覆盖',
      fieldProviderDesc: 'Reflector/Curator 使用的 provider；留空跟随会话模型',
      fieldModel: '复盘 model 覆盖',
      fieldModelDesc: 'Reflector/Curator 使用的 model；留空跟随会话模型',
      pickProviderPlaceholder: '跟随会话模型',
      pickModelPlaceholder: '跟随会话模型',
      pickProviderSearch: '搜索 provider…',
      pickModelSearch: '搜索 model…',
      pickNoMatchProvider: '没有匹配的 provider',
      pickNoMatchModel: '没有匹配的模型',
      pickClear: '跟随会话模型（清空）',
      catalogLoading: '正在读取模型目录…',
      catalogFailed: '模型目录读取失败：宿主可能还没重启（其余字段照常可用）',
      fieldReasoningEffort: '思考强度',
      fieldReasoningEffortDesc: '手动指定 Reflector/Curator 用哪一档思考强度；留空 = 跟随自动降档（由会话模型声明的档位决定，改选 provider/model 会重新读取）',
      pickEffortPlaceholder: '跟随自动（不指定）',
      pickEffortClear: '不指定（跟随自动降档）',
      pickEffortSearch: '搜索思考档位…',
      pickNoMatchEffort: '没有匹配的档位',
      effortsFailed: '该模型未声明思考档位',
      effortsAutoNow: '当前会自动使用：{name}',
      effortsNoneFallback: '当前模型没有可用的思考档位，这一项不影响其它设置。',
      effortsStaleCleared: '原来选的档位不在新模型的声明列表里，已清空为「不指定」。',
      fieldAutoReasoningDowngrade: '自动降到最低思考档',
      fieldAutoReasoningDowngradeDesc: '回合开始时把思考档位自动降到该模型支持的最低一档，省下推理预算；关掉 = 完全按手动档位走',
      warnPair: '只有 provider 与 model 两项都填才生效；只填一项会静默回落到会话模型。',
      fieldMaxEntries: '手册容量上限',
      fieldMaxEntriesDesc: '满额后先由 LLM 把相近的两条合并成一条，仍超则按命中次数从少到多淘汰（搬进同目录的 archive.md，永不物理删除）（默认 {d}，可填 {min}–{max}）',
      fieldEvictProtectDays: '新条目保护天数',
      fieldEvictProtectDaysDesc: '刚写进手册的条目在这几天内不参与淘汰（按元数据的 created 到今天的间隔算）；这一段里仍然只先淘汰老条目，配额需要时才会动它们。调大 = 新条目活得更久、老条目更早被淘汰；填 0 = 不保护（与旧行为一致）（默认 {d}，可填 {min}–{max}）',
      fieldInjectTokenBudget: '注入 token 预算',
      fieldInjectTokenBudgetDesc: '每回合自动注入块的 token 估算上限（ASCII ×0.4 + 汉字 ×1.0 粗略折算）。调小 = 注入更少内容、更省 token 与上下文（超预算的条目直接不注入）；调大 = 多注几条。默认 {d}，可填 {min}–{max}',
      fieldInjectMaxEntries: '一次注入最多几条',
      fieldInjectMaxEntriesDesc: '每回合自动注入最多塞进几条经验。调小 = 更少注入更省 token（默认 5 条之外的候选当场丢弃，不占任何名额）；调大 = 一次看到更多经验。默认 {d}，可填 {min}–{max}',
      fieldInjectMinScoreIdfRatio: '绝对相关度门槛（× IDF_MAX）',
      fieldInjectMinScoreIdfRatioDesc: '低于这个分数的条目一条都不注入 —— 手册里没有相关经验时宁可注入 0 条，也不硬凑条数。IDF_MAX 随手册条目数自动变大，手册越长门槛越严。填 0 = 关掉绝对门槛（退回旧行为）。默认 {d}，可填 {min}–{max}',
      fieldInjectMinRelativeToTop: '相对相关度门槛（× 本轮第一名）',
      fieldInjectMinRelativeToTopDesc: '每条候选至少要到本轮最高分的这么多倍才注入，避免「蹭」着第一名混进来。填 0 = 关掉相对门槛。默认 {d}，可填 {min}–{max}',
      fieldInjectRationale: '注入时附带依据',
      fieldInjectRationaleDesc: '打开后每条注入的经验多一行「依据」，说明为什么要有这条经验（更准，但每批多花约 26% token）；默认关 = 只注入标题、条件与做法，最省 token',
      fieldAutoRecap: '自动归档经验',
      fieldAutoRecapDesc: '回合真正结束时由插件后台复盘并写入手册，不依赖模型主动调用',
      fieldAutoRecapThreshold: '自动归档触发门槛',
      fieldAutoRecapThresholdDesc: '回合内至少发生多少次改动类工具调用才触发自动复盘（0 表示每次都触发）',
      fieldAutoRecapCooldownTurns: '自动归档冷却轮数',
      fieldAutoRecapCooldownTurnsDesc: '距上次自动复盘至少隔几轮，避免每个回合都反复复盘（0 表示不冷却）',
      fieldAutoReviewInbox: '自动复审待合并条目',
      fieldAutoReviewInboxDesc: '预留开关，当前不生效：复审入口仍是设置页的「待合并复审」区块或对话里的 /ace review',
      inboxTitle: '待合并复审',
      inboxEmpty: '没有待合并的条目',
      inboxHint: '在对话里输入 /ace review，模型会逐对读出两条全文并起草合并措辞',
      inboxFull: '待合并已满（{n} 条），自动归档已暂停新增，请先清理',
      inboxUnavailable: '待合并列表不可用：宿主可能还没重启',
      inboxRatio: '相似度',
      statsTitle: '手册统计',
      statsRefresh: '刷新',
      statsLoading: '正在统计手册…',
      statsUnavailable: '统计不可用：宿主可能还没重启',
      statsEntries: '条目',
      statsTextChars: '正文字符',
      statsBytes: '文件字节',
      statsMtime: '最后写入',
      statsPath: '手册路径',
      statsSource: '来源构成',
      statsAuto: '自动归档',
      statsAutoNone: '自动归档尚未落盘过',
      // {n} 由服务端 /stats 的 windowDays 填入（缺字段回退 14）。
      statsDaily: '最近 {n} 天更新',
      statsDailyEmpty: '最近 {n} 天没有条目更新',
      statsRecent: '最近更新',
      statsRecentEmpty: '还没有条目',
      statsGeneratedAt: '统计于',
      statsReasonNeedsSession: '该路径需要会话上下文，暂无法统计',
      statsReasonMissing: '手册文件还不存在，暂无可统计内容',
      statsReasonUnreadable: '手册文件读取失败，暂无法统计',
      statsReasonNoEntries: '手册里还没有条目',
      // —— ACE 运行统计（GET /stats 的 runtime 块：本进程内存态，宿主重启即归零）——
      runtimeTitle: 'ACE 运行统计',
      // 第 33 轮：计分整层删除后，六个数字换成「注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数」。
      runtimeInjectBatches: '注入批次',
      runtimeInjectAppended: '注入追加',
      runtimeRetrievalHits: '检索命中',
      runtimeEvicted: '淘汰数',
      runtimeMerged: '合并数',
      runtimeArchived: '归档数',
      runtimeArchivedByReason: '归档原因：被取代 {superseded} · 显式移除 {removed} · 最少使用淘汰 {evicted} · 合并 {merged}',
      // 第 34 轮：跳过 / 失败两个数从设置页**删掉**，不是漏写。它们只存在于
      // lib/index.js 的进程内计数器（skipped += 1 / failed += 1，继续进日志），
      // 但 runtime（GET /stats）按红线只暴露精确七键，两个键根本不在协议里 ——
      // 以前这两格读 undefined 后被 num() 兜成 0，等于天天给用户看假 0。
      runtimeInjectDetail: '注入：批次 {batches} · 追加 {appended}',
      runtimeInjectHint: '批次 = 每收到一条新消息挑一次经验；追加 = 这批经验真进了历史一次（同一批不重复，所以追加不会超过批次）。检索命中 = 用 ace_playbook 带 query 或 id 定向查找时被查出来的条目数（整本读取不计数）。',
      runtimeEvictHint: '淘汰 = 手册满额、合并之后仍超限时，按命中次数从少到多搬进归档文件的条数（命中次数相同时创建更早的先走，再并列按编号）。合并 = 满额时由 LLM 把两条相近经验合成一条的条数（保留创建更早那条的编号）。',
      runtimeHint: '这些数来自本次会话的内存状态，宿主重启即归零，不落盘。',
      runtimeUnavailable: '宿主还没重启，本次统计里没有运行计数（重启后出现）。',
      // —— 三页导航（统计 / 设置 / 记录）——
      tabStats: '统计',
      tabSettings: '设置',
      tabEntries: '记录',
      // —— 记录页（GET /entries，只读）——
      entriesTitle: '手册条目',
      entriesRefresh: '刷新',
      entriesLoading: '正在读取手册条目…',
      entriesFailed: '条目读取失败：宿主可能还没重启（其余页面照常可用）',
      // 服务端降级 reason 三分派：missing / needs-session 是「还没到能读」的正常状态，
      // 只有 unreadable 才是读盘失败。三者文案一一对应，绝不共用（R2 缺陷）。
      entriesReasonMissing: '手册尚未创建，还没有任何记录',
      entriesReasonNeedsSession: '手册配置为相对路径，在无会话的 HTTP 面无法定位',
      entriesReasonUnreadable: '手册文件读取失败',
      entriesEmpty: '手册里还没有条目',
      entriesSearchPlaceholder: '搜索编号 / 标题 / 条件 / 做法 / 依据…',
      entriesCount: '共 {n} 条 / 上限 {m} 条',
      entriesNoMatch: '没有匹配的条目',
      entriesColId: '编号',
      entriesColTitle: '标题',
      entriesColUpdated: '更新日期',
      entriesColSource: '来源',
      entriesAuto: '自动归档',
      entriesManual: '手写',
      entriesCondition: '条件',
      entriesAction: '做法',
      entriesRationale: '依据',
      entriesRationaleEmpty: '（未填写依据）',
      entriesPage: '第 {x} / {y} 页',
      entriesPrev: '上一页',
      entriesNext: '下一页',
      // —— 记录页「已归档」分区（只读，永不物理删除）——
      entriesScopeActive: '活跃',
      entriesScopeArchived: '已归档',
      entriesArchivedEmpty: '还没有归档条目',
      entriesArchivedCount: '已归档 {n} 条（只读，永不物理删除）',
      entriesArchiveReason: '归档原因',
      entriesArchiveDate: '归档日期',
      entriesArchiveSupersededBy: '被哪条取代',
      entriesArchiveReasonSuperseded: '被新条目取代',
      entriesArchiveReasonRemoved: '被显式移除',
      entriesArchiveReasonEvicted: '最少使用淘汰',
      entriesArchiveReasonMerged: '合并进另一条',
      entriesArchiveBtn: '归档',
      entriesArchiveConfirmBtn: '确认',
      entriesArchiveFailed: '归档失败：{error}',
      on: '开',
      off: '关',
      saved: '已保存',
      reset: '已恢复为插件默认值',
      loading: '正在读取 ACE 配置…',
      failed: '读取失败：宿主没有响应设置接口（插件可能未启用）',
      editableHint: '手册是纯 Markdown，随时可以直接编辑文件。',
      fromStored: '当前值来自设置页保存的配置',
      fromConfigured: '当前值来自插件行 Config（设置页尚未保存过）',
      resetBtn: '恢复默认值',
    };
    const en = {
      'meta.title': 'ACE Playbook',
      'meta.description': 'An evolvable playbook: consult past experience before a task, distil new experience after one. Configure the playbook path, the reflect reminder, Reflector/Curator model overrides and the playbook capacity here.',
      nav: 'ACE Playbook',
      title: 'ACE Playbook',
      subtitle: 'An evolvable playbook: distil experience after tasks, consult before tasks',
      sectionTag: 'ACE PLAYBOOK',
      fieldPlaybookPath: 'Playbook path',
      fieldPlaybookPathDesc: 'Empty = the machine-wide shared playbook (<DSH home>/ace/playbook.md, one book across workspaces); a relative path = private to this workspace (resolved against the session working directory); an absolute path (a leading ~ works) is used as-is',
      playbookPathPlaceholder: 'Empty = shared playbook; relative = private to this workspace',
      fieldAutoReflect: 'Remind to reflect after tasks',
      fieldAutoReflectDesc: 'Nudge the agent in the system prompt to call ace_reflect after real work',
      fieldProvider: 'Reflect provider override',
      fieldProviderDesc: 'Provider for Reflector/Curator; empty follows the session model',
      fieldModel: 'Reflect model override',
      fieldModelDesc: 'Model for Reflector/Curator; empty follows the session model',
      pickProviderPlaceholder: 'Follow session model',
      pickModelPlaceholder: 'Follow session model',
      pickProviderSearch: 'Search providers…',
      pickModelSearch: 'Search models…',
      pickNoMatchProvider: 'No matching provider',
      pickNoMatchModel: 'No matching model',
      pickClear: 'Follow session model (clear)',
      catalogLoading: 'Loading the model catalog…',
      catalogFailed: 'Could not load the model catalog: the host may not have restarted yet (other fields still work)',
      fieldReasoningEffort: 'Reasoning effort',
      fieldReasoningEffortDesc: 'Pin the reasoning effort for Reflector/Curator; empty = follow the automatic downgrade (levels come from the session model, and are re-read whenever provider/model changes)',
      pickEffortPlaceholder: 'Follow automatic (unset)',
      pickEffortClear: 'Unset (follow the automatic downgrade)',
      pickEffortSearch: 'Search effort levels…',
      pickNoMatchEffort: 'No matching effort level',
      effortsFailed: 'This model declares no reasoning effort levels',
      effortsAutoNow: 'Currently using automatically: {name}',
      effortsNoneFallback: 'This model exposes no reasoning effort levels; nothing else is affected.',
      effortsStaleCleared: 'The effort level you picked is not declared by the new model; it has been cleared to “unset”.',
      fieldAutoReasoningDowngrade: 'Auto-downgrade to the lowest reasoning effort',
      fieldAutoReasoningDowngradeDesc: 'At the start of a turn, drop the reasoning effort to the lowest level the model supports to save reasoning budget; off = follow the manual effort only',
      warnPair: 'The override only applies when both provider and model are set; with just one set it silently falls back to the session model.',
      fieldMaxEntries: 'Playbook capacity',
      fieldMaxEntriesDesc: 'Once full, the plugin first asks the LLM to merge two similar entries into one; if still over the cap it evicts the least-hit entries (moved to archive.md beside the playbook, never deleted) (default {d}, {min}–{max})',
      fieldEvictProtectDays: 'New-entry protection days',
      fieldEvictProtectDaysDesc: 'Entries written into the playbook within the last N days are kept out of eviction first (N is measured from their created stamp to today); older entries are still evicted first, and protected ones are only touched when the quota cannot be met otherwise. Larger = new entries live longer and old ones go earlier; 0 = no protection (same as before) (default {d}, {min}–{max})',
      fieldInjectTokenBudget: 'Injection token budget',
      fieldInjectTokenBudgetDesc: 'Token estimate cap for the per-turn injected block (ASCII ×0.4 + CJK ×1.0). Smaller = inject less content and spend fewer tokens and less context (entries over budget are simply not injected); larger = inject more. Default {d}, {min}–{max}',
      fieldInjectMaxEntries: 'Max entries per injection',
      fieldInjectMaxEntriesDesc: 'How many experience entries at most are injected per turn. Smaller = less injected, fewer tokens (candidates beyond the cap are dropped for that turn and take up no quota); larger = see more experience at once. Default {d}, {min}–{max}',
      fieldInjectMinScoreIdfRatio: 'Absolute relevance floor (× IDF_MAX)',
      fieldInjectMinScoreIdfRatioDesc: 'Entries scoring below this are not injected at all: when the playbook holds nothing relevant it injects 0 entries instead of padding the count. IDF_MAX grows with the number of entries, so longer playbooks have a stricter floor. 0 disables the absolute floor (old behaviour). Default {d}, {min}–{max}',
      fieldInjectMinRelativeToTop: 'Relative relevance floor (× this turn top score)',
      fieldInjectMinRelativeToTopDesc: 'Every candidate must reach at least this fraction of the top score for the turn, so weak hits cannot ride along with the best match. 0 disables the relative floor. Default {d}, {min}–{max}',
      fieldInjectRationale: 'Attach rationale when injecting',
      fieldInjectRationaleDesc: 'When on, each injected entry carries one extra “rationale” line explaining why that experience exists (more accurate, but about 26% more tokens per batch); off by default = inject only title, condition and action, cheapest',
      fieldAutoRecap: 'Archive experience automatically',
      fieldAutoRecapDesc: 'Reflect and write into the playbook in the background once a turn truly ends, without relying on the model calling it',
      fieldAutoRecapThreshold: 'Auto-archive trigger threshold',
      fieldAutoRecapThresholdDesc: 'How many mutating tool calls in one turn are needed before an automatic recap fires (0 means every turn)',
      fieldAutoRecapCooldownTurns: 'Auto-archive cooldown turns',
      fieldAutoRecapCooldownTurnsDesc: 'Minimum turns since the last automatic recap, so it does not run every turn (0 means no cooldown)',
      fieldAutoReviewInbox: 'Review pending merges automatically',
      fieldAutoReviewInboxDesc: 'Reserved switch, currently inert: review via the "Pending merges" block on this page or by typing /ace review in the conversation',
      inboxTitle: 'Pending merges',
      inboxEmpty: 'No entries are waiting to be merged',
      inboxHint: 'Type /ace review in the conversation and the model reads both entries in full and drafts the merge wording',
      inboxFull: 'The pending-merge list is full ({n} entries): auto-archiving has paused. Please clean up first',
      inboxUnavailable: 'The pending-merge list is unavailable: the host may not have restarted yet',
      inboxRatio: 'Similarity',
      statsTitle: 'Playbook stats',
      statsRefresh: 'Refresh',
      statsLoading: 'Counting the playbook…',
      statsUnavailable: 'Stats unavailable: the host may not have restarted yet',
      statsEntries: 'Entries',
      statsTextChars: 'Body chars',
      statsBytes: 'File bytes',
      statsMtime: 'Last write',
      statsPath: 'Playbook path',
      statsSource: 'Origin',
      statsAuto: 'Auto-archived',
      statsAutoNone: 'Nothing has been auto-archived yet',
      statsDaily: 'Updates in the last {n} days',
      statsDailyEmpty: 'No entry updated in the last {n} days',
      statsRecent: 'Recently updated',
      statsRecentEmpty: 'No entries yet',
      statsGeneratedAt: 'Counted at',
      statsReasonNeedsSession: 'This path needs a session context, so it cannot be counted here',
      statsReasonMissing: 'The playbook file does not exist yet: nothing to count',
      statsReasonUnreadable: 'The playbook file could not be read: stats unavailable',
      statsReasonNoEntries: 'The playbook has no entries yet',
      // —— ACE runtime counters (the runtime block of GET /stats: in-process, reset on host restart) ——
      runtimeTitle: 'ACE runtime',
      runtimeInjectBatches: 'Injection batches',
      runtimeInjectAppended: 'Appended to history',
      runtimeRetrievalHits: 'Retrieval hits',
      runtimeEvicted: 'Evicted',
      runtimeMerged: 'Merged',
      runtimeArchived: 'Archived',
      runtimeArchivedByReason: 'Archive reasons: superseded {superseded} · removed {removed} · least-used eviction {evicted} · merged {merged}',
      // Round 34: skipped/failed were dropped from the panel on purpose -- the counters still
      // exist in the process (lib/index.js) and still go to the log, but the runtime payload
      // exposes exactly seven keys and neither of them is one, so the old cells rendered a
      // hardcoded 0 forever.
      runtimeInjectDetail: 'Injections: batches {batches} · appended {appended}',
      runtimeInjectHint: 'A batch is picked once per incoming user message; appended counts the batches that actually entered the history (never twice for the same batch, so appended <= batches). Retrieval hits count the entries returned by a targeted ace_playbook lookup (with a query or an id); reading the whole playbook is not counted.',
      runtimeEvictHint: 'Evicted = entries moved to the archive file because the playbook was full even after merging, picked by fewest hits first (ties go to the older created stamp, then to the lower id). Merged = pairs the LLM folded into one entry while the playbook was full (the older entry keeps its id).',
      runtimeHint: 'These counters live in this process only: they reset when the host restarts and are never written to disk.',
      runtimeUnavailable: 'The host has not been restarted yet, so this payload carries no runtime counters.',
      // —— Three tabs (stats / settings / entries) ——
      tabStats: 'Stats',
      tabSettings: 'Settings',
      tabEntries: 'Entries',
      // —— Entries page (GET /entries, read-only) ——
      entriesTitle: 'Playbook entries',
      entriesRefresh: 'Refresh',
      entriesLoading: 'Loading playbook entries…',
      entriesFailed: 'Could not load entries: the host may not have restarted yet (the other tabs still work)',
      entriesReasonMissing: 'The playbook has not been created yet: there are no records',
      entriesReasonNeedsSession: 'The playbook path is relative and cannot be located on the HTTP surface (no session working directory)',
      entriesReasonUnreadable: 'The playbook file could not be read',
      entriesEmpty: 'The playbook has no entries yet',
      entriesSearchPlaceholder: 'Search id / title / condition / action / rationale…',
      entriesCount: '{n} total / {m} max',
      entriesNoMatch: 'No matching entries',
      entriesColId: 'Id',
      entriesColTitle: 'Title',
      entriesColUpdated: 'Updated',
      entriesColSource: 'Origin',
      entriesAuto: 'Auto-archived',
      entriesManual: 'Written by hand',
      entriesCondition: 'Condition',
      entriesAction: 'Action',
      entriesRationale: 'Rationale',
      entriesRationaleEmpty: '(no rationale)',
      entriesPage: 'Page {x} / {y}',
      entriesPrev: 'Previous',
      entriesNext: 'Next',
      // —— Entries page "archived" scope (read-only, never physically deleted) ——
      entriesScopeActive: 'Active',
      entriesScopeArchived: 'Archived',
      entriesArchivedEmpty: 'Nothing has been archived yet',
      entriesArchivedCount: '{n} archived (read-only, never physically deleted)',
      entriesArchiveReason: 'Archive reason',
      entriesArchiveDate: 'Archived on',
      entriesArchiveSupersededBy: 'Superseded by',
      entriesArchiveReasonSuperseded: 'Superseded by a newer entry',
      entriesArchiveReasonRemoved: 'Removed on request',
      entriesArchiveReasonEvicted: 'Evicted as least used',
      entriesArchiveReasonMerged: 'Merged into another entry',
      entriesArchiveBtn: 'Archive',
      entriesArchiveConfirmBtn: 'Confirm',
      entriesArchiveFailed: 'Archive failed: {error}',
      on: 'On',
      off: 'Off',
      saved: 'Saved',
      reset: 'Back to the plugin defaults',
      loading: 'Loading ACE configuration…',
      failed: 'Could not load: the host did not answer the settings endpoint (plugin may be disabled)',
      editableHint: 'The playbook is plain Markdown and can be edited directly at any time.',
      fromStored: 'These values come from what the settings page saved',
      fromConfigured: 'These values come from the plugin row Config (the settings page never saved)',
      resetBtn: 'Restore defaults',
    };

    // VCP 暗色（应用户指定：本页固定暗色，不随宿主主题切换）。
    const CSS = [
      '.ace-set{font-family:\'JetBrains Maple Mono\',\'Maple Mono\',\'JetBrains Mono\',ui-monospace,\'Cascadia Code\',Consolas,monospace;color:#dce6f1;background:#0c1117;border:1px solid #223041;border-radius:12px;padding:20px 22px 16px;box-sizing:border-box;max-width:640px;line-height:1.55}',
      '.ace-set *{box-sizing:border-box;font-family:inherit}',
      '.ace-set-tag{display:inline-block;font-size:10px;letter-spacing:.18em;color:#2dd4bf;border:1px solid #1d3a38;border-radius:4px;padding:2px 8px;margin-bottom:10px;background:#0f1a1a}',
      '.ace-set-title{font-size:16px;font-weight:700;color:#eaf2fb;margin:0 0 4px}',
      '.ace-set-sub{font-size:12px;color:#8fa1b3;margin:0 0 18px}',
      '.ace-set-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid #1a2430}',
      '.ace-set-label{font-size:13px;font-weight:600;color:#dce6f1;margin:0 0 3px}',
      '.ace-set-desc{font-size:11px;color:#7d8fa1;margin:0;max-width:380px}',
      '.ace-set-input{background:#131a22;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:7px 10px;width:220px;outline:none;transition:border-color .15s}',
      '.ace-set-input:focus{border-color:#2dd4bf}',
      '.ace-set-input::placeholder{color:#55677a}',
      '.ace-set-switch{flex:none;width:38px;height:21px;border-radius:11px;background:#263140;border:1px solid #33465c;position:relative;cursor:pointer;transition:background .15s,border-color .15s}',
      '.ace-set-switch[aria-checked="true"]{background:#134e4a;border-color:#2dd4bf}',
      '.ace-set-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#e6edf3;transition:left .15s}',
      '.ace-set-switch[aria-checked="true"] .ace-set-knob{left:19px;background:#5eead4}',
      '.ace-set-status{font-size:11px;margin-top:12px;min-height:16px}',
      '.ace-set-status-ok{color:#2dd4bf}',
      '.ace-set-status-err{color:#f87171}',
      '.ace-set-hint{font-size:10px;color:#5d6f82;margin-top:10px;border-top:1px dashed #1a2430;padding-top:8px}',
      '.ace-set-note{font-size:12px;color:#8fa1b3;padding:12px 0}',
      '.ace-set-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}',
      '.ace-set-btn{background:#131a22;border:1px solid #2a3746;border-radius:6px;color:#9fb2c5;font-size:11px;padding:5px 10px;cursor:pointer;font-family:inherit}',
      '.ace-set-btn:hover{border-color:#3d4d60;color:#dce6f1}',
      // —— 模型下拉（provider / model 两行共用）——
      '.ace-pick{position:relative;width:220px;flex:none}',
      '.ace-pick-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;background:#131a22;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:7px 10px;cursor:pointer;text-align:left;font-family:inherit;transition:border-color .15s}',
      '.ace-pick-trigger:hover{border-color:#3d4d60}',
      '.ace-pick-trigger[aria-expanded="true"]{border-color:#2dd4bf}',
      '.ace-pick-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ace-pick-value.is-empty{color:#55677a}',
      '.ace-pick-caret{flex:none;color:#7d8fa1;font-size:10px}',
      '.ace-pick-panel{position:absolute;top:calc(100% + 6px);right:0;width:320px;max-width:calc(100vw - 32px);background:#131a22;border:1px solid #263140;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.55);z-index:200;overflow:hidden;padding:6px;display:flex;flex-direction:column;gap:6px}',
      '.ace-pick-search{width:100%;background:#0c1117;border:1px solid #263140;border-radius:6px;color:#e6edf3;font-size:12px;padding:6px 9px;outline:none;font-family:inherit}',
      '.ace-pick-search:focus{border-color:#2dd4bf}',
      '.ace-pick-search::placeholder{color:#55677a}',
      '.ace-pick-list{max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:1px}',
      '.ace-pick-group{font-size:10px;letter-spacing:.12em;color:#7d8fa1;padding:6px 8px 3px;text-transform:uppercase}',
      '.ace-pick-item{display:flex;flex-direction:column;gap:2px;width:100%;background:transparent;border:none;border-radius:5px;color:#dce6f1;font-size:12px;padding:6px 8px;cursor:pointer;text-align:left;font-family:inherit}',
      '.ace-pick-item:hover{background:#1a2430}',
      '.ace-pick-item.is-active{background:#16302e}',
      '.ace-pick-item[aria-selected="true"]{color:#5eead4}',
      '.ace-pick-item-id{font-size:10px;color:#7d8fa1}',
      '.ace-pick-item-desc{font-size:10px;color:#5d6f82}',
      '.ace-pick-empty{font-size:11px;color:#7d8fa1;padding:8px}',
      '.ace-pick-err{font-size:11px;color:#f87171;padding:8px}',
      '.ace-pick-foot{border-top:1px solid #263140;padding-top:6px}',
      '.ace-pick-clear{color:#9fb2c5}',
      '.ace-set-warn{font-size:11px;line-height:1.6;color:#f0b429;padding:0 0 10px}',
      '.ace-set-effort-note{font-size:11px;line-height:1.6;color:#9fb2c5;padding:0 0 10px}',
      '.ace-pick-trigger:disabled{color:#55677a;border-color:#1f2a36;cursor:not-allowed}',
      '.ace-pick-trigger:disabled:hover{border-color:#1f2a36}',
      // —— 待合并复审区块 ——
      '.ace-inbox{padding:4px 0 6px;border-top:1px solid #1a2430}',
      '.ace-inbox-title{font-size:13px;font-weight:600;color:#eaf2fb;margin:12px 0 2px}',
      '.ace-inbox-note{font-size:11px;color:#8fa1b3;margin:0 0 8px;line-height:1.6}',
      '.ace-inbox-empty{font-size:11px;color:#7d8fa1;padding:2px 0 4px}',
      '.ace-inbox-full{font-size:11px;color:#f0b429;padding:2px 0 6px;line-height:1.6}',
      '.ace-inbox-list{display:flex;flex-direction:column;gap:8px;margin:0 0 4px;padding:0;list-style:none}',
      '.ace-inbox-item{background:#131a22;border:1px solid #263140;border-radius:8px;padding:9px 11px}',
      '.ace-inbox-pair{font-size:12px;color:#dce6f1;line-height:1.7}',
      '.ace-inbox-id{color:#5eead4}',
      '.ace-inbox-title2{color:#eaf2fb}',
      '.ace-inbox-arrow{color:#7d8fa1;padding:0 4px}',
      '.ace-inbox-ratio{font-size:10px;color:#7d8fa1;padding-top:2px}',
      // —— 手册统计区块（只读）——
      '.ace-stats{padding:4px 0 8px;border-top:1px solid #1a2430;margin-bottom:6px}',
      '.ace-stats-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 2px}',
      '.ace-stats-title{font-size:13px;font-weight:600;color:#eaf2fb}',
      '.ace-stats-btn{font-size:11px;color:#9fb2c5;background:#131a22;border:1px solid #263140;border-radius:6px;padding:3px 9px;cursor:pointer}',
      '.ace-stats-btn:hover{color:#2dd4bf;border-color:#1d3a38}',
      '.ace-stats-note{font-size:11px;color:#7d8fa1;line-height:1.6;padding:2px 0 4px}',
      '.ace-stats-grid{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px}',
      '.ace-stats-cell{background:#131a22;border:1px solid #263140;border-radius:8px;padding:6px 10px;min-width:104px}',
      '.ace-stats-k{font-size:10px;color:#7d8fa1;letter-spacing:.04em}',
      '.ace-stats-v{font-size:13px;color:#eaf2fb;padding-top:2px}',
      '.ace-stats-acc{color:#2dd4bf}',
      '.ace-stats-path{font-size:10px;color:#7d8fa1;word-break:break-all;padding:0 0 6px}',
      '.ace-stats-sub{font-size:11px;color:#8fa1b3;margin:10px 0 4px;letter-spacing:.04em}',
      '.ace-stats-daily{display:flex;flex-direction:column;gap:2px;margin:0 0 4px}',
      '.ace-stats-day{display:flex;align-items:center;gap:8px;font-size:10px;color:#7d8fa1}',
      '.ace-stats-day-label{width:64px;flex:0 0 64px;color:#7d8fa1}',
      '.ace-stats-bar{flex:1 1 auto;height:6px;background:#0f1720;border:1px solid #1a2430;border-radius:3px;overflow:hidden}',
      // display:block 是必须的：.ace-stats-bar 不是 flex 容器，内联 <span> 上的 width/height
      // 会被浏览器直接忽略（这正是「条形恒空」的根因）。这里选给填充块加 display:block，
      // 而不是把 .ace-stats-bar 改成 display:flex —— 轨道只是 .ace-stats-day（flex）的 flex item，
      // 它本身不需要 flex 上下文；只改填充块的 display 是最小改动，也不会动到 6px 轨道高度的盒模型。
      '.ace-stats-bar-fill{display:block;height:100%;background:#2dd4bf;border-radius:2px}',
      '.ace-stats-day-count{width:20px;flex:0 0 20px;text-align:right;color:#9fb2c5}',
      '.ace-stats-recent{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}',
      '.ace-stats-recent-item{font-size:11px;color:#dce6f1;display:flex;gap:8px;align-items:baseline}',
      '.ace-stats-id{color:#5eead4;flex:0 0 auto}',
      '.ace-stats-recent-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eaf2fb}',
      '.ace-stats-recent-date{flex:0 0 auto;color:#7d8fa1;font-size:10px}',
      // —— 三页导航 ——
      '.ace-tabs{display:flex;flex-direction:row;gap:4px;margin:12px 0 4px;border-bottom:1px solid #1a2430}',
      '.ace-tab{font-size:12px;color:#9fb2c5;background:transparent;border:none;border-bottom:2px solid transparent;padding:6px 12px;margin-bottom:-1px;cursor:pointer;font-family:inherit}',
      '.ace-tab:hover{color:#dce6f1}',
      '.ace-tab.is-active{color:#2dd4bf;border-bottom-color:#2dd4bf;background:#0f1a1a}',
      // 未选中的页面用 [hidden] 隐藏（display:none 显式写出来，避免被其它 display 规则盖掉）。
      // 三个页面始终都在树里，只是被藏起来 —— 组件状态因此不会被卸载清空。
      '.ace-page[hidden]{display:none}',
      // —— 记录页（只读条目清单）——
      '.ace-entries{padding:4px 0 8px}',
      '.ace-entries-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 4px}',
      '.ace-entries-btn{font-size:11px;color:#9fb2c5;background:#131a22;border:1px solid #263140;border-radius:6px;padding:3px 9px;cursor:pointer;font-family:inherit}',
      '.ace-entries-btn:hover{color:#2dd4bf;border-color:#1d3a38}',
      '.ace-entries-title{font-size:13px;font-weight:600;color:#eaf2fb}',
      '.ace-entries-search{width:100%;box-sizing:border-box;font-family:inherit;font-size:12px;color:#dce6f1;background:#0f1720;border:1px solid #263140;border-radius:6px;padding:5px 8px;margin:2px 0 6px}',
      '.ace-entries-search::placeholder{color:#55677a}',
      '.ace-entries-count{font-size:10px;color:#7d8fa1;padding:0 0 6px}',
      '.ace-entries-head-row{display:flex;align-items:center;gap:8px;font-size:10px;color:#7d8fa1;letter-spacing:.04em;border-bottom:1px solid #1a2430;padding:4px 0}',
      '.ace-entries-sort{font-size:10px;color:#9fb2c5;background:transparent;border:none;padding:0;cursor:pointer;font-family:inherit;letter-spacing:.04em}',
      '.ace-entries-sort:hover{color:#2dd4bf}',
      '.ace-entries-sort.is-active{color:#2dd4bf}',
      '.ace-entries-list{margin:0;padding:0;list-style:none}',
      '.ace-entries-row{display:flex;align-items:center;gap:8px;font-size:11px;color:#dce6f1;padding:4px 0;border-bottom:1px solid #131a22;cursor:pointer}',
      '.ace-entries-row:hover{background:#131a22}',
      '.ace-entries-row-id{flex:0 0 64px;color:#5eead4}',
      '.ace-entries-row-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eaf2fb}',
      '.ace-entries-row-date{flex:0 0 84px;color:#7d8fa1;font-size:10px}',
      '.ace-entries-row-source{flex:0 0 auto;font-size:10px;color:#9fb2c5;border:1px solid #263140;border-radius:4px;padding:1px 6px}',
      '.ace-entries-row-source.is-auto{color:#2dd4bf;border-color:#1d3a38}',
      '.ace-entries-detail{padding:2px 0 8px 72px;font-size:11px;color:#9fb2c5;line-height:1.6}',
      '.ace-entries-detail-block{margin:2px 0 4px}',
      '.ace-entries-detail-k{color:#7d8fa1;font-size:10px;letter-spacing:.04em}',
      '.ace-entries-detail-v{color:#c7d5e2}',
      '.ace-entries-detail-empty{color:#5d6f82;font-style:italic}',
      '.ace-entries-pager{display:flex;align-items:center;gap:8px;padding:8px 0 0}',
      '.ace-entries-pager-btn{font-size:11px;color:#9fb2c5;background:#131a22;border:1px solid #263140;border-radius:6px;padding:3px 9px;cursor:pointer;font-family:inherit}',
      '.ace-entries-pager-btn:hover:not(:disabled){color:#2dd4bf;border-color:#1d3a38}',
      '.ace-entries-pager-btn:disabled{opacity:.45;cursor:default}',
      '.ace-entries-pager-btn.is-active{color:#2dd4bf;border-color:#1d3a38}',
      '.ace-entries-pager-text{font-size:10px;color:#7d8fa1}',
      '.ace-entries-note{font-size:11px;color:#7d8fa1;line-height:1.6;padding:2px 0 4px}',
      // —— ACE 运行统计块（GET /stats 的 runtime 部分）——
      // 刻意不复用 .ace-stats-grid / .ace-stats-note / .ace-stats-cell：
      // 那几个类被既有测试按「统计块内恰好 N 个」精确计数，新块另起一套类名互不干扰。
      '.ace-runtime{padding:2px 0 8px;border-top:1px solid #1a2430;margin-top:4px}',
      '.ace-runtime-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:10px 0 2px}',
      '.ace-runtime-title{font-size:13px;font-weight:600;color:#eaf2fb}',
      '.ace-runtime-grid{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px}',
      '.ace-runtime-cell{background:#131a22;border:1px solid #263140;border-radius:8px;padding:6px 10px;min-width:104px}',
      '.ace-runtime-k{font-size:10px;color:#7d8fa1;letter-spacing:.04em}',
      '.ace-runtime-v{font-size:13px;color:#eaf2fb;padding-top:2px}',
      '.ace-runtime-acc{color:#2dd4bf}',
      '.ace-runtime-sub{font-size:11px;color:#8fa1b3;margin:8px 0 2px;letter-spacing:.04em}',
      '.ace-runtime-line{font-size:11px;color:#9fb2c5;line-height:1.6;padding:0 0 2px}',
      '.ace-runtime-body{padding:0}',
      '.ace-runtime-hint{font-size:10px;color:#7d8fa1;line-height:1.6;padding:2px 0 4px}',
      // —— 记录页「已归档」分区（只读）——
      '.ace-archived{padding:2px 0 8px}',
      '.ace-archived-count{font-size:10px;color:#7d8fa1;padding:0 0 6px}',
      '.ace-archived-list{margin:0;padding:0;list-style:none}',
      '.ace-archived-item{border-bottom:1px solid #131a22}',
      '.ace-archived-row{display:flex;align-items:center;gap:8px;font-size:11px;color:#dce6f1;padding:4px 0;cursor:pointer}',
      '.ace-archived-row:hover{background:#131a22}',
      '.ace-archived-id{flex:0 0 64px;color:#5eead4}',
      '.ace-archived-title{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#eaf2fb}',
      '.ace-archived-date{flex:0 0 84px;color:#7d8fa1;font-size:10px}',
      '.ace-archived-reason{flex:0 0 auto;font-size:10px;color:#c7a86b;border:1px solid #3a3320;border-radius:4px;padding:1px 6px}',
      '.ace-archived-detail{padding:2px 0 8px 72px;font-size:11px;color:#9fb2c5;line-height:1.6}',
      '.ace-archived-note{font-size:11px;color:#7d8fa1;line-height:1.6;padding:2px 0 4px}',
      '.ace-entries-scope{display:flex;gap:4px;margin:0 0 6px}',
      '.ace-entries-scope-btn{font-size:11px;color:#9fb2c5;background:#131a22;border:1px solid #263140;border-radius:6px;padding:3px 9px;cursor:pointer;font-family:inherit}',
      '.ace-entries-scope-btn:hover{color:#2dd4bf;border-color:#1d3a38}',
      '.ace-entries-scope-btn.is-active{color:#2dd4bf;border-color:#1d3a38}',
      // —— 记录页「活跃」分区：手写归档按钮（两段式确认，绝不物理删除）——
      // 底色/边框沿用同一批 VCP 暗色 token；确认态切红色系（深红底 #3b1418 + 亮红字 #ff8b8b），
      // 在 #131a22 附近暗底上对比度 ≥ 7:1，够看清也够"危险感"。
      '.ace-entries-archive{margin:2px 0 4px;display:flex;justify-content:flex-end}',
      '.ace-entries-archive-btn{font-size:11px;color:#9fb2c5;background:#131a22;border:1px solid #263140;border-radius:6px;padding:3px 9px;cursor:pointer;font-family:inherit}',
      '.ace-entries-archive-btn:hover{color:#5eead4;border-color:#1d3a38}',
      '.ace-entries-archive-btn.is-confirm{color:#ff8b8b;background:#3b1418;border-color:#7f1d1d;font-weight:600}',
      '.ace-entries-archive-btn.is-confirm:hover{color:#ffb3b3;background:#4d1a1f;border-color:#b91c1c}',
      '.ace-entries-archive-note{color:#ff8b8b}',
    ].join('\n');

    /**
     * 开关。
     * 可访问名必须**恒定是字段名**（由调用方传 label）：旧实现把 onText/offText（"开"/"关"）
     * 当 aria-label，读屏只会念「开，开关」而且名字随状态变化，听不出是哪一项设置。
     * 现在名字只由 label 决定，开关状态只走 aria-checked；title 仍给鼠标用户看当前状态。
     */
    function Switch(props) {
      const { checked, onChange, label, onText, offText, id } = props;
      return h('div', {
        className: 'ace-set-switch',
        id: id || undefined,
        role: 'switch',
        tabIndex: 0,
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label || undefined,
        title: checked ? onText : offText,
        onClick: () => onChange(!checked),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(!checked); }
        },
      }, h('span', { className: 'ace-set-knob' }));
    }

    /**
     * 一行设置：左侧 label + 说明，右侧控件。
     * 控件的可访问名与 label 的关联有两条路（都做，能用的场景都覆盖）：
     * - 控件自带 id（input / Switch）：label 用原生 for 指向它；
     * - 没有 id 的控件（ModelPicker 这种复合组件）：label 侧挂 aria-labelledby，
     *   并把生成的 id 透给控件自己的 aria-label 承载元素。
     */
    function FieldRow(props) {
      const { label, desc, control, controlId } = props;
      // 复合控件（ModelPicker 这种没有原生 id 的）自己拿不到 labelId：
      // 调用点显式传 pickerId / labelId（两者都由 controlId 推出），此组件只负责 label 侧。
      const labelId = controlId ? controlId + '-label' : undefined;
      return h('div', { className: 'ace-set-row' },
        h('div', null,
          h('label', {
            className: 'ace-set-label',
            id: labelId,
            htmlFor: controlId || undefined,
          }, label),
          h('div', { className: 'ace-set-desc', id: controlId ? controlId + '-desc' : undefined }, desc)),
        control);
    }

    /**
     * 模型下拉：可搜索、可分组、可清空。
     * 交互照 DSH 官方模型选择器的键盘模型（~\dsh-client-ui-model-selection\lib\client.js:1362-1414：
     * Esc 关闭、ArrowUp/Down 循环移动高亮、Enter 选中），但不引入它的任何依赖——
     * 这里只有 React.createElement 和本文件内的 CSS。
     * props：
     *   value              当前值（空串表示跟随会话模型）
     *   groups             [{ key, title, items: [{ id, name, description? }] }]；title 为空则不画组标题
     *   placeholder        空值占位文案
     *   searchPlaceholder  搜索框 placeholder
     *   noMatchText        无匹配时的提示
     *   clearText          底部清空项文案（provider/model 是「跟随会话模型（清空）」，
     *                      思考档位是「不指定（跟随自动降档）」）
     *   displayValue       触发器上显示的文字（缺省显示 value；档位要显示 name 而不是 id）
     *   errorText          目录读取失败时的错误行（有则不画列表）
     *   loading            目录读取中的提示
     *   onPick(item) / onClear()
     *   disabled           下拉禁用（档位列表读不到 / 该模型没声明档位时用，此时仍显示占位与说明）
     *   ariaLabel          可访问名（由 FieldRow 的 label 传下来：读屏听得出是哪一项设置）
     *   pickerId           触发按钮的 id（FieldRow 的 htmlFor 指向它，建立 label 关联）
     *   labelId            FieldRow 的 label id（按钮用 aria-labelledby 再兜一层）
     */
    function ModelPicker(props) {
      const {
        value, groups, placeholder, searchPlaceholder, noMatchText, clearText, errorText, loading,
        onPick, onClear, ariaLabel, pickerId, labelId, disabled, displayValue,
      } = props;
      const [open, setOpen] = React.useState(false);
      const [query, setQuery] = React.useState('');
      const [active, setActive] = React.useState(0);
      const rootRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const itemRefs = React.useRef([]);

      // 展开时清空搜索、重置高亮，并把焦点交给搜索框（自动聚焦）。
      React.useEffect(() => {
        if (!open) return undefined;
        setQuery('');
        setActive(0);
        const timer = window.setTimeout(() => { searchRef.current?.focus(); }, 0);
        return () => window.clearTimeout(timer);
      }, [open]);

      // 点击面板外部关闭。
      React.useEffect(() => {
        if (!open) return undefined;
        const onDocDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDocDown);
        return () => document.removeEventListener('mousedown', onDocDown);
      }, [open]);

      const needle = query.trim().toLowerCase();
      const hit = (item) => {
        if (needle === '') return true;
        const hay = [item.name, item.id, item.description]
          .filter((part) => typeof part === 'string')
          .join('\n')
          .toLowerCase();
        return hay.includes(needle);
      };
      const visible = [];
      for (const group of groups || []) {
        const items = (group.items || []).filter(hit);
        if (items.length) visible.push({ key: group.key, title: group.title, items });
      }
      // flat 与列表项的渲染顺序一一对应：高亮索引直接用下标，回车取 flat[activeIndex]。
      const flat = [];
      for (const group of visible) for (const item of group.items) flat.push({ item, groupKey: group.key });
      const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;

      // 高亮项滚进可视区。
      React.useEffect(() => {
        if (!open || activeIndex < 0) return;
        itemRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
      }, [open, activeIndex]);

      const pick = (entry) => {
        setOpen(false);
        onPick(entry.item, entry.groupKey);
      };
      const clear = () => {
        setOpen(false);
        onClear();
      };

      const onKeyDown = (event) => {
        if (disabled === true) return;
        if (event.key === 'Escape') {
          if (open) { event.preventDefault(); setOpen(false); }
          return;
        }
        if (!open) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!flat.length) return;
          event.preventDefault();
          setActive((current) => {
            const base = Math.min(current, flat.length - 1);
            return (base + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
          });
          return;
        }
        if (event.key === 'Enter' && activeIndex >= 0) {
          event.preventDefault();
          pick(flat[activeIndex]);
        }
      };

      // 渲染时的下标游标：与上面 flat 的构造顺序严格一致。
      let rendered = -1;
      return h('div', { className: 'ace-pick', ref: rootRef, onKeyDown },
        h('button', {
          type: 'button',
          className: 'ace-pick-trigger',
          id: pickerId || undefined,
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': ariaLabel || undefined,
          'aria-labelledby': labelId || undefined,
          disabled: disabled === true,
          onClick: () => { if (disabled !== true) setOpen((wasOpen) => !wasOpen); },
        },
          h('span', { className: 'ace-pick-value' + (value ? '' : ' is-empty') },
            value ? (displayValue || value) : placeholder),
          h('span', { className: 'ace-pick-caret' }, '▾')),
        open ? h('div', { className: 'ace-pick-panel' },
          h('input', {
            ref: searchRef,
            className: 'ace-pick-search',
            type: 'text',
            value: query,
            placeholder: searchPlaceholder,
            onChange: (event) => { setQuery(event.target.value); setActive(0); },
          }),
          errorText ? h('div', { className: 'ace-pick-err' }, errorText) : null,
          loading ? h('div', { className: 'ace-pick-empty' }, loading) : null,
          h('div', { className: 'ace-pick-list', role: 'listbox' },
            flat.length === 0
              ? (errorText || loading ? null : h('div', { className: 'ace-pick-empty' }, noMatchText))
              : visible.map((group) => h('div', { key: 'group:' + group.key },
                group.title ? h('div', { className: 'ace-pick-group' }, group.title) : null,
                group.items.map((item) => {
                  rendered += 1;
                  const index = rendered;
                  return h('button', {
                    key: 'item:' + group.key + ':' + item.id,
                    type: 'button',
                    role: 'option',
                    ref: (node) => { itemRefs.current[index] = node; },
                    className: 'ace-pick-item' + (index === activeIndex ? ' is-active' : ''),
                    'aria-selected': item.id === value ? 'true' : 'false',
                    onClick: () => pick(flat[index]),
                  },
                    h('span', null, item.name || item.id),
                    h('span', { className: 'ace-pick-item-id' }, item.id),
                    item.description ? h('span', { className: 'ace-pick-item-desc' }, item.description) : null);
                })))),
          h('div', { className: 'ace-pick-foot' },
            h('button', { type: 'button', className: 'ace-pick-item ace-pick-clear', onClick: clear },
              h('span', null, clearText))))
        : null);
    }

    /** 本地语言标签：shell 把当前语言镜像到 <html lang>，渲染时读一次即可。 */
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.();
        const value = snapshot?.active ?? ctx.locale?.locale;
        return typeof value === 'string' ? value : document.documentElement.lang || 'en';
      } catch {
        return 'en';
      }
    }

    // —— 手册统计区块（只读）——
    // 数据来自宿主 GET /api/dsh-ace/stats（lib/index.js 的 /stats 分支，聚合逻辑在 lib/stats.js）。
    // 失败（宿主还没重启 → 404）只把这一区块变成一行灰字，其余字段照常可用：
    // 范式与上面的 catalog / inbox 一致，绝不让整页报错。
    const STATS_REASON_KEYS = {
      'needs-session': 'statsReasonNeedsSession',
      missing: 'statsReasonMissing',
      unreadable: 'statsReasonUnreadable',
      'no-entries': 'statsReasonNoEntries',
    };

    /** 空态文案：reason 有映射就用它，否则回落到一行通用说明。 */
    function statsReasonText(t, reason) {
      const key = STATS_REASON_KEYS[String(reason ?? '')];
      return t(key ?? 'statsReasonNoEntries');
    }

    /** 'YYYY-MM-DD' → 'MM-DD'（条形图左侧窄列，省宽度）。 */
    function shortDay(date) {
      const text = String(date ?? '');
      return text.length >= 10 ? text.slice(5) : text;
    }

    /**
     * 界面日期**只到日**：把毫秒时间戳（`2026-10-25T06:12:33.412+08:00`）截成 `YYYY-MM-DD`。
     *
     * 为什么必须有这一步：手册元数据的时间戳是毫秒精度本地 ISO（`lib/timestamp.js` 的 `nowStamp`，
     * 29 字符），而这一列只有 84px 宽（`.ace-entries-row-date`），直接渲染会把整行挤爆。
     * 兼容旧格式（只有 `2026-10-25`，原样返回）与空值 → '—'；认证不出的垃圾值同样 → '—'（绝不渲染出 undefined）。
     *
     * 位置要求：**两条渲染路径都必须走这里**（记录页行日期 / 统计页最近更新列表），
     * 不许再在别处写 `String(x.updated)`——tests/archive.test.mjs 与 client 渲染用例守着。
     */
    function displayDay(value) {
      const text = String(value ?? '').trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      return m ? m[1] + '-' + m[2] + '-' + m[3] : '—';
    }

    /**
     * 极简模板替换：把文案里的 {key} 换成 vars[key]。
     * 字典里带数字的文案（「最近 {n} 天更新」「共 {n} 条 / 上限 {m} 条」）用占位符，
     * 免得同一句话在 zh/en 里各写死一个数字。缺值保留占位符，绝不渲染出 "undefined"。
     */
    function fmt(text, vars) {
      const source = String(text ?? '');
      if (!vars) return source;
      return source.replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
      ));
    }

    function StatsBlock(props) {
      const { t, stats, onRefresh } = props;
      const head = h('div', { className: 'ace-stats-head' },
        h('div', { className: 'ace-stats-title' }, t('statsTitle')),
        h('button', { className: 'ace-stats-btn', type: 'button', onClick: onRefresh }, t('statsRefresh')));

      if (!stats || stats.status === 'loading') {
        return h('div', { className: 'ace-stats' }, head, h('div', { className: 'ace-stats-note' }, t('statsLoading')));
      }
      if (stats.status !== 'ready') {
        return h('div', { className: 'ace-stats' }, head, h('div', { className: 'ace-stats-note' }, t('statsUnavailable')));
      }

      const data = stats.data ?? {};
      const scale = data.scale ?? {};
      const source = data.source ?? {};
      const daily = Array.isArray(data.daily) ? data.daily : [];
      const recent = Array.isArray(data.recent) ? data.recent : [];
      const total = Number(source.total || 0);
      const auto = Number(source.auto || 0);
      const autoRatio = total > 0 ? auto / total : 0;
      const maxEntries = typeof scale.maxEntries === 'number' ? scale.maxEntries : null;
      const dailyMax = Math.max(Number(data.dailyMax || 0), 1);
      // 天数取服务端返回的 windowDays（/stats 里有这个字段），缺字段或不是正整数时回退 14 ——
      // 别在客户端写死窗口长度，服务端改了窗口这边跟着变。
      const windowDays = Number.isInteger(Number(data.windowDays)) && Number(data.windowDays) > 0
        ? Number(data.windowDays)
        : 14;
      const entriesText = maxEntries === null
        ? String(Number(scale.entries || 0))
        : String(Number(scale.entries || 0)) + ' / ' + String(maxEntries);

      const cell = (key, text, accent) => h('div', { className: 'ace-stats-cell' },
        h('div', { className: 'ace-stats-k' }, t(key)),
        h('div', { className: accent ? 'ace-stats-v ace-stats-acc' : 'ace-stats-v' }, text));

      // 空态：一行引导，其余（路径、生成时间）照常显示，不报错。
      const emptyNote = data.reason ? h('div', { className: 'ace-stats-note' }, statsReasonText(t, data.reason)) : null;

      return h('div', { className: 'ace-stats' },
        head,
        emptyNote,
        h('div', { className: 'ace-stats-grid' },
          cell('statsEntries', entriesText, true),
          cell('statsTextChars', String(Number(scale.textChars || 0))),
          cell('statsBytes', String(Number(scale.bytes || 0))),
          cell('statsMtime', String(scale.mtime || '—'))),
        h('div', { className: 'ace-stats-path' }, t('statsPath') + ' ' + String(data.file || data.playbookPath || '—')),
        h('div', { className: 'ace-stats-sub' }, t('statsSource')),
        h('div', { className: 'ace-stats-note' },
          t('statsAuto') + ' ' + Math.round(autoRatio * 100) + '%（' + auto + ' / ' + total + '）'
          + (auto === 0 ? ' · ' + t('statsAutoNone') : '')),
        h('div', { className: 'ace-stats-sub' }, fmt(t('statsDaily'), { n: windowDays })),
        h('div', { className: 'ace-stats-daily' },
          daily.length === 0
            ? h('div', { className: 'ace-stats-note' }, fmt(t('statsDailyEmpty'), { n: windowDays }))
            : daily.map((row) => {
              const count = Number(row?.count || 0);
              // 条形宽度用内联 style 百分比（不动态注入 CSS 规则）。
              const width = count === 0 ? 0 : Math.max(4, Math.round((count / dailyMax) * 100));
              return h('div', { className: 'ace-stats-day', key: String(row?.date ?? '') },
                h('span', { className: 'ace-stats-day-label' }, shortDay(row?.date)),
                h('span', { className: 'ace-stats-bar' },
                  h('span', { className: 'ace-stats-bar-fill', style: { width: width + '%' } })),
                h('span', { className: 'ace-stats-day-count' }, String(count)));
            })),
        h('div', { className: 'ace-stats-sub' }, t('statsRecent')),
        recent.length === 0
          ? h('div', { className: 'ace-stats-note' }, t('statsRecentEmpty'))
          : h('ul', { className: 'ace-stats-recent' },
            recent.map((item) => h('li', { className: 'ace-stats-recent-item', key: String(item?.id ?? '') },
              h('span', { className: 'ace-stats-id' }, String(item?.id ?? '')),
              h('span', { className: 'ace-stats-recent-title' }, String(item?.title ?? '')),
              h('span', { className: 'ace-stats-recent-date' }, displayDay(item?.updated))))),
        data.generatedAt ? h('div', { className: 'ace-stats-note' }, t('statsGeneratedAt') + ' ' + String(data.generatedAt)) : null);
    }

    // —— ACE 运行统计（GET /stats 的 runtime 块）——
    // 这些数全部来自宿主进程内存（lib/index.js 的 recapStats / archiveStats / injectionStats），
    // 宿主重启即归零、刻意不落盘，所以这里没有第二个接口，只消费 /stats 同一个 payload。
    // 类名一律 ace-runtime-*：.ace-stats-grid / .ace-stats-note / .ace-stats-cell 被既有测试
    // 按「统计块内恰好 N 个」精确计数，新块另起一套类名，互不干扰。
    function RuntimeBlock(props) {
      const { t, stats } = props;
      const data = stats && typeof stats.data === 'object' && stats.data !== null ? stats.data : null;
      const runtime = data && typeof data.runtime === 'object' && data.runtime !== null ? data.runtime : null;

      const head = h('div', { className: 'ace-runtime-head' },
        h('div', { className: 'ace-runtime-title' }, t('runtimeTitle')));

      // 宿主还没重启（旧版 /stats 没有 runtime 字段）时只留一行灰字：
      // 这一块绝不抛错，也不影响上面的手册统计块。
      if (!runtime) {
        return h('div', { className: 'ace-runtime' }, head,
          h('div', { className: 'ace-runtime-hint' }, t('runtimeUnavailable')));
      }

      const num = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : '0';
      };
      const byReason = runtime.archivedByReason && typeof runtime.archivedByReason === 'object'
        ? runtime.archivedByReason
        : {};

      const cell = (key, text, accent) => h('div', { className: 'ace-runtime-cell' },
        h('div', { className: 'ace-runtime-k' }, t(key)),
        h('div', { className: accent ? 'ace-runtime-v ace-runtime-acc' : 'ace-runtime-v' }, text));

      // 第 33 轮：计分整层删除后只剩六个数字（注入批次 / 注入追加 / 检索命中 / 淘汰数 /
      // 合并数 / 归档数）。设置页不出现任何评分或考察位的内部字段名。
      return h('div', { className: 'ace-runtime' },
        head,
        h('div', { className: 'ace-runtime-body' },
          h('div', { className: 'ace-runtime-grid' },
            // 注入口径：批次与追加是两个数，见字典 runtimeInjectHint 的一句话解释。
            cell('runtimeInjectBatches', num(runtime.injectedBatches), true),
            cell('runtimeInjectAppended', num(runtime.injectedAppended)),
            cell('runtimeRetrievalHits', num(runtime.retrievalHits)),
            cell('runtimeEvicted', num(runtime.evicted)),
            cell('runtimeMerged', num(runtime.merged)),
            cell('runtimeArchived', num(runtime.archived))),
          h('div', { className: 'ace-runtime-sub' }, t('runtimeArchived')),
          h('div', { className: 'ace-runtime-line' }, fmt(t('runtimeArchivedByReason'), {
            superseded: num(byReason.superseded),
            removed: num(byReason['removed-by-request']),
            evicted: num(byReason.evicted),
            merged: num(byReason.merged),
          })),
          h('div', { className: 'ace-runtime-sub' }, t('runtimeInjectBatches')),
          // 只渲染协议里真有的两个数。跳过 / 失败**不许加回来**：runtime 是精确七键
          // （injectedBatches / injectedAppended / retrievalHits / evicted / merged /
          // archived / archivedByReason），两个键不在里面，加回来就是恒显示 0 的假数字。
          h('div', { className: 'ace-runtime-line' }, fmt(t('runtimeInjectDetail'), {
            batches: num(runtime.injectedBatches),
            appended: num(runtime.injectedAppended),
          })),
          h('div', { className: 'ace-runtime-line ace-runtime-note' }, t('runtimeInjectHint')),
          h('div', { className: 'ace-runtime-line ace-runtime-note' }, t('runtimeEvictHint')),
          h('div', { className: 'ace-runtime-hint' }, t('runtimeHint'))));
    }

    // 服务端 /entries 降级 reason → 字典键。missing（手册文件还不存在）与 needs-session
    // （配置的是相对路径、HTTP 面无会话工作目录）都是「还没到能读」的正常状态，
    // 只有 unreadable 才是读盘失败；未知 reason 一律按读盘失败处理。
    const ENTRIES_REASON_KEYS = {
      missing: 'entriesReasonMissing',
      'needs-session': 'entriesReasonNeedsSession',
      unreadable: 'entriesReasonUnreadable',
    };

    function entriesReasonText(t, reason) {
      const key = ENTRIES_REASON_KEYS[String(reason ?? '')];
      return t(key ?? 'entriesReasonUnreadable');
    }

    // 归档原因（superseded / removed-by-request / evicted / merged，
    // 与宿主 lib/entry-format.js 的 ARCHIVE_REASONS 一一对齐）→ 字典键。
    // 未知原因直接回显原字符串，不吞掉信息。
    const ENTRIES_ARCHIVE_REASON_KEYS = {
      superseded: 'entriesArchiveReasonSuperseded',
      'removed-by-request': 'entriesArchiveReasonRemoved',
      evicted: 'entriesArchiveReasonEvicted',
      merged: 'entriesArchiveReasonMerged',
    };

    function archiveReasonText(t, reason) {
      const key = ENTRIES_ARCHIVE_REASON_KEYS[String(reason ?? '')];
      return key ? t(key) : String(reason ?? '');
    }

    // —— 记录页（GET /entries，只读）——
    // 数据源是宿主 lib/entries.js 的只读清单；失败/降级都只让本页显示一行文案，
    // 不影响设置页与统计页。分页固定 20 条/页。
    const ENTRIES_PAGE_SIZE = 20;

    /** 编号里的数字部分：'ace-2' → 2。取不到数字的条目排在所有数字条目之后。 */
    function entryNumber(id) {
      const m = /(\d+)\s*$/.exec(String(id ?? ''));
      return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    }

    /**
     * 条目排序比较器。
     * - 编号列：按数字比较（ace-2 在 ace-10 之前），不是字典序。
     * - 更新日期列：按 'YYYY-MM-DD' 字符串比较（定长格式，字典序即时间序）。
     * - 没有更新日期的条目恒定排末尾，与升降序无关（缺失不等于「最小」）。
     * - 同值时用编号兜底，保证输出顺序稳定（兜底不受方向影响）。
     */
    function compareEntries(a, b, key, dir) {
      const byId = () => {
        const na = entryNumber(a?.id);
        const nb = entryNumber(b?.id);
        if (na !== nb) return na < nb ? -1 : 1;
        const sa = String(a?.id ?? '');
        const sb = String(b?.id ?? '');
        return sa < sb ? -1 : (sa > sb ? 1 : 0);
      };
      if (key === 'id') {
        const na = entryNumber(a?.id);
        const nb = entryNumber(b?.id);
        if (na === nb) return byId();
        const order = na < nb ? -1 : 1;
        return dir === 'desc' ? -order : order;
      }
      // 先 trim 再判空：'   ' 这种纯空白与「没有日期」同等处理，
      // 否则它会以「非空字符串」的身份参与比较（升序排最前、降序排最后）。
      const ua = String(a?.updated ?? '').trim();
      const ub = String(b?.updated ?? '').trim();
      if (ua === '' && ub === '') return byId();
      if (ua === '') return 1;
      if (ub === '') return -1;
      if (ua === ub) return byId();
      const order = ua < ub ? -1 : 1;
      return dir === 'desc' ? -order : order;
    }

    /** 搜索：id / title / condition / action / rationale 全字段子串匹配，不区分大小写。 */
    function entryMatches(entry, needle) {
      if (needle === '') return true;
      return ['id', 'title', 'condition', 'action', 'rationale']
        .some((field) => String(entry?.[field] ?? '').toLowerCase().includes(needle));
    }

    function EntriesPage(props) {
      const { t, active } = props;
      // status：idle（还没进过记录页）| loading | ready | failed | unreadable（服务端降级 reason）
      const [status, setStatus] = React.useState('idle');
      // 降级 reason（missing / needs-session / unreadable）：三分派渲染不同文案，绝不合并。
      const [reason, setReason] = React.useState(null);
      const [data, setData] = React.useState({ entries: [], archived: [], total: 0, archivedTotal: 0, maxEntries: null });
      // 分区：'active'（活跃条目，可搜索/排序/分页）| 'archived'（归档区，只读）。
      // 归档条目永不物理删除，因此这里只有「看」，没有任何删除/还原入口。
      const [scope, setScope] = React.useState('active');
      const [archivedOpen, setArchivedOpen] = React.useState({});
      const [query, setQuery] = React.useState('');
      const [sortKey, setSortKey] = React.useState('updated');
      const [sortDir, setSortDir] = React.useState('desc');
      const [page, setPage] = React.useState(1);
      // 归档分区**独立**的页码：与活跃分区的 page 互不影响。
      // 共用一个页码会让「在活跃分区翻到第 2 页，切到归档分区也停在第 2 页」，
      // 而两个分区的条目数毫无关系，那个页码大概率是个不存在的页。
      const [archivedPage, setArchivedPage] = React.useState(1);
      const [open, setOpen] = React.useState({});
      const [reloadToken, setReloadToken] = React.useState(0);
      const handled = React.useRef(-1);
      // 竞态用请求代次计数器：每次发请求先自增，响应回来时代次对不上就直接丢弃。
      // 不用 AbortController —— 这里只需要「丢弃旧响应」而不是真的取消网络，
      // 且 signal 在宿主 fetch 包装/测试假宿主里不一定被支持，代次计数器没有这个依赖。
      const gen = React.useRef(0);
      // —— 手动归档的两段式确认态（按 id 存，同一时刻只承认一条）——
      // 首点「归档」只把 id 记进来，本地变红「确认」，**不发任何写请求**；
      // 二点「确认」才真发 POST /entries/archive。点别处 / 点另一条 / 切分区 / 刷新
      // 都会把 pending 清空，绝不留下悬空的待确认态。
      const [pendingArchive, setPendingArchive] = React.useState(null);
      // 归档失败的页内可见报错（不弹窗、不静默、不吞掉服务端的 error 原文）。
      const [archiveError, setArchiveError] = React.useState(null);
      // 在飞闸：确认态连点不许打两发写请求（第二次必然 404，会把页面变成假故障）。
      const archiveBusy = React.useRef(false);

      const load = () => {
        const mine = gen.current + 1;
        gen.current = mine;
        setStatus('loading');
        fetch(ENTRIES_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (gen.current !== mine) return;
            if (!payload || payload.ok !== true || !Array.isArray(payload.entries)) {
              setStatus('failed');
              return;
            }
            // archived / archivedTotal 是阶段 2 起 /entries 就带的字段；旧宿主没有这两个字段时
            // 按空数组处理，活跃分区照常可用（缺失不等于故障）。
            const archived = Array.isArray(payload.archived) ? payload.archived : [];
            setData({
              entries: payload.entries,
              archived,
              total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : payload.entries.length,
              archivedTotal: Number.isFinite(Number(payload.archivedTotal))
                ? Number(payload.archivedTotal)
                : archived.length,
              maxEntries: typeof payload.maxEntries === 'number' ? payload.maxEntries : null,
            });
            setReason(payload.reason ? String(payload.reason) : null);
            setStatus(payload.reason ? 'unreadable' : 'ready');
          })
          .catch(() => { if (gen.current === mine) setStatus('failed'); });
      };

      // 懒加载：只有「记录页处于选中态」且这一轮 reloadToken 还没被处理过才拉。
      // 切走再切回来 active 变 true 但 reloadToken 没变 → 不重复请求；点刷新才变。
      React.useEffect(() => {
        if (!active) return;
        if (handled.current === reloadToken) return;
        handled.current = reloadToken;
        load();
      }, [active, reloadToken]);

      // 刷新 = 重新拉列表，同时把两段式确认态与旧报错一起清掉（列表变了，待确认的那条可能已经不在了）。
      const reload = () => {
        setPendingArchive(null);
        setArchiveError(null);
        setReloadToken((n) => n + 1);
      };
      const head = h('div', { className: 'ace-entries-head' },
        h('div', { className: 'ace-entries-title' }, t('entriesTitle')),
        h('button', { type: 'button', className: 'ace-entries-btn', onClick: reload }, t('entriesRefresh')));

      if (status === 'loading' || status === 'idle') {
        return h('div', { className: 'ace-entries' }, head,
          h('div', { className: 'ace-entries-note' }, t('entriesLoading')));
      }
      if (status === 'failed') {
        return h('div', { className: 'ace-entries' }, head,
          h('div', { className: 'ace-entries-note' }, t('entriesFailed')));
      }
      if (status === 'unreadable') {
        return h('div', { className: 'ace-entries' }, head,
          h('div', { className: 'ace-entries-note' }, entriesReasonText(t, reason)));
      }

      const all = Array.isArray(data.entries) ? data.entries : [];
      const archivedAll = Array.isArray(data.archived) ? data.archived : [];

      // 活跃 / 已归档 切换。归档区只读：没有删除、没有还原、没有编辑入口 ——
      // 归档条目按设计永不物理删除（见 AGENTS.md 红线），界面上也就不能出现这类按钮。
      const scopeButton = (id, label) => h('button', {
        type: 'button',
        className: 'ace-entries-scope-btn' + (scope === id ? ' is-active' : ''),
        'aria-pressed': scope === id ? 'true' : 'false',
        // 切分区也复位确认态：切走之后那条可能已不在视野里，留着悬空确认态会误删。
        // 切分区复位的理由：切走再回来停在上一次的第 N 页，会让人以为条目丢了。
        onClick: () => { setScope(id); setPendingArchive(null); setArchivedPage(1); },
      }, label);
      const scopeSwitch = h('div', { className: 'ace-entries-scope', role: 'group', 'aria-label': t('entriesTitle') },
        scopeButton('active', t('entriesScopeActive')),
        scopeButton('archived', t('entriesScopeArchived')));

      // 手动归档动作：按当前态分流 —— 该条还没进确认态 → 只置 pending（**零写操作**）；
      // 已经是确认态 → 真发 POST。点另一条 = 换成那一条（上一条的确认自然作废）。
      const archiveOne = (id) => {
        if (pendingArchive !== id) {
          setPendingArchive(id);
          setArchiveError(null);
          return;
        }
        if (archiveBusy.current) return;
        archiveBusy.current = true;
        setArchiveError(null);
        let httpStatus = 0;
        fetch(ENTRIES_ARCHIVE_ROUTE, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        })
          .then((response) => {
            httpStatus = response.status;
            // 服务端的错误体是 { error }；解析失败也别吞掉状态码。
            return response.json().catch(() => null);
          })
          .then((payload) => {
            if (payload && payload.ok === true) {
              setPendingArchive(null);
              reload();
              return;
            }
            setArchiveError(payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + (httpStatus || '?'));
            setPendingArchive(null);
          })
          .catch((error) => {
            setArchiveError(String(error?.message ?? error));
            setPendingArchive(null);
          })
          .then(() => { archiveBusy.current = false; });
      };

      const needle = query.trim().toLowerCase();
      const filtered = all.filter((entry) => entryMatches(entry, needle));
      const sorted = filtered.slice().sort((a, b) => compareEntries(a, b, sortKey, sortDir));
      const pageCount = Math.max(1, Math.ceil(sorted.length / ENTRIES_PAGE_SIZE));
      const currentPage = Math.min(Math.max(page, 1), pageCount);
      const rows = sorted.slice((currentPage - 1) * ENTRIES_PAGE_SIZE, currentPage * ENTRIES_PAGE_SIZE);

      const toggleSort = (key) => {
        if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        else {
          setSortKey(key);
          setSortDir(key === 'updated' ? 'desc' : 'asc');
        }
        setPage(1);
      };

      const sortButton = (key, label) => h('button', {
        type: 'button',
        className: 'ace-entries-sort' + (sortKey === key ? ' is-active' : ''),
        'aria-sort': sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
        onClick: () => toggleSort(key),
      }, label + (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''));

      const detailBlock = (labelKey, value, emptyKey) => {
        const text = String(value ?? '');
        if (text.trim() === '') {
          // 依据为空：显示占位行，不渲染空白块；条件/做法为空则整块不渲染。
          return emptyKey
            ? h('div', { className: 'ace-entries-detail-block' },
              h('div', { className: 'ace-entries-detail-k' }, t(labelKey)),
              h('div', { className: 'ace-entries-detail-empty' }, t(emptyKey)))
            : null;
        }
        return h('div', { className: 'ace-entries-detail-block' },
          h('div', { className: 'ace-entries-detail-k' }, t(labelKey)),
          h('div', { className: 'ace-entries-detail-v' }, text));
      };

      const toggleRow = (id) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }));

      // —— 已归档分区（只读展示）——
      // 行/详情一律用 ace-archived-* 类名：.ace-entries-row / .ace-entries-detail 被既有测试
      // 按「活跃分区里有几条」精确计数，归档行不能混进同一个类名。
      const archivedDetailBlock = (labelKey, value, emptyKey) => {
        const text = String(value ?? '');
        if (text.trim() === '') {
          return emptyKey
            ? h('div', { className: 'ace-archived-detail-block' },
              h('div', { className: 'ace-archived-detail-k' }, t(labelKey)),
              h('div', { className: 'ace-entries-detail-empty' }, t(emptyKey)))
            : null;
        }
        return h('div', { className: 'ace-archived-detail-block' },
          h('div', { className: 'ace-archived-detail-k' }, t(labelKey)),
          h('div', { className: 'ace-archived-detail-v' }, text));
      };

      const archivedView = () => {
        // 归档分区也按 20 条/页分页（与活跃分区同一个页长），但页码用的是**独立**的 archivedPage，
        // 两个分区的页码互不影响。归档是只读历史、条数只增不减，全量铺开没有上限。
        const archivedPageCount = Math.max(1, Math.ceil(archivedAll.length / ENTRIES_PAGE_SIZE));
        // 钳位：刷新后归档条目变少时，绝不留在不存在的页码上（越界的 page 只影响本帧渲染，不回写 state）。
        const archivedCurrentPage = Math.min(Math.max(archivedPage, 1), archivedPageCount);
        const archivedRows = archivedAll.slice(
          (archivedCurrentPage - 1) * ENTRIES_PAGE_SIZE,
          archivedCurrentPage * ENTRIES_PAGE_SIZE,
        );

        const archivedList = archivedAll.length === 0
          ? h('div', { className: 'ace-archived-note' }, t('entriesArchivedEmpty'))
          : h('ul', { className: 'ace-archived-list' },
            archivedRows.map((entry) => {
              const id = String(entry?.id ?? '');
              const isOpen = archivedOpen[id] === true;
              const archive = entry?.archive && typeof entry.archive === 'object' ? entry.archive : {};
              const toggleArchived = () => setArchivedOpen((prev) => ({ ...prev, [id]: !prev[id] }));
              return h('li', { key: 'archived:' + id, className: 'ace-archived-item' },
                h('div', {
                  className: 'ace-archived-row',
                  role: 'button',
                  tabIndex: 0,
                  'aria-expanded': isOpen ? 'true' : 'false',
                  onClick: toggleArchived,
                  onKeyDown: (e) => {
                    if (e?.key !== 'Enter' && e?.key !== ' ') return;
                    if (typeof e.preventDefault === 'function') e.preventDefault();
                    toggleArchived();
                  },
                },
                  h('span', { className: 'ace-archived-id' }, id),
                  h('span', { className: 'ace-archived-title' }, String(entry?.title ?? '')),
                  h('span', { className: 'ace-archived-date' }, displayDay(archive.date)),
                  h('span', { className: 'ace-archived-reason' }, archiveReasonText(t, archive.reason))),
                isOpen
                  ? h('div', { className: 'ace-archived-detail' },
                    archivedDetailBlock('entriesArchiveReason', archiveReasonText(t, archive.reason), null),
                    archivedDetailBlock('entriesArchiveDate', archive.date, null),
                    archivedDetailBlock('entriesArchiveSupersededBy', archive.supersededBy, null),
                    archivedDetailBlock('entriesCondition', entry?.condition, null),
                    archivedDetailBlock('entriesAction', entry?.action, null),
                    archivedDetailBlock('entriesRationale', entry?.rationale, 'entriesRationaleEmpty'))
                  : null);
            }));

        // 归档分页条：类名与文案（entriesPrev / entriesPage / entriesNext）全部复用活跃分区那一套，
        // 样式在 client.js 的 .ace-entries-pager 系列里已经存在，因此自动继承本页固定的 VCP 暗色与字体。
        // 只放上一页 / 下一页 / 数字页码三种按钮 —— 归档只读，这一区绝不能出现删除或还原入口。
        const archivedPageButtons = [];
        for (let i = 1; i <= archivedPageCount; i += 1) {
          archivedPageButtons.push(h('button', {
            key: 'archived-page:' + i,
            type: 'button',
            className: 'ace-entries-pager-btn' + (i === archivedCurrentPage ? ' is-active' : ''),
            'aria-current': i === archivedCurrentPage ? 'page' : 'false',
            onClick: () => setArchivedPage(i),
          }, String(i)));
        }

        const archivedPager = h('div', { className: 'ace-entries-pager' },
          h('button', {
            type: 'button',
            className: 'ace-entries-pager-btn',
            disabled: archivedCurrentPage <= 1,
            onClick: () => setArchivedPage(archivedCurrentPage - 1),
          }, t('entriesPrev')),
          archivedPageButtons,
          h('span', { className: 'ace-entries-pager-text' },
            fmt(t('entriesPage'), { x: archivedCurrentPage, y: archivedPageCount })),
          h('button', {
            type: 'button',
            className: 'ace-entries-pager-btn',
            disabled: archivedCurrentPage >= archivedPageCount,
            onClick: () => setArchivedPage(archivedCurrentPage + 1),
          }, t('entriesNext')));

        // 显隐条件与活跃分区一致：空归档只给空态、不渲染分页条；非空就连只有 1 页也渲染。
        return h('div', { className: 'ace-entries' }, head, scopeSwitch,
          h('div', { className: 'ace-archived' },
            h('div', { className: 'ace-archived-count' },
              fmt(t('entriesArchivedCount'), { n: data.archivedTotal })),
            archivedList,
            archivedAll.length === 0 ? null : archivedPager));
      };

      if (scope === 'archived') return archivedView();

      if (all.length === 0) {
        return h('div', { className: 'ace-entries' }, head, scopeSwitch,
          h('div', { className: 'ace-entries-note' }, t('entriesEmpty')));
      }

      const list = h('ul', { className: 'ace-entries-list' },
        rows.map((entry) => {
          const id = String(entry?.id ?? '');
          const isOpen = open[id] === true;
          return h('li', { key: 'entry:' + id, className: 'ace-entries-item' },
            h('div', {
              className: 'ace-entries-row',
              role: 'button',
              tabIndex: 0,
              'aria-expanded': isOpen ? 'true' : 'false',
              onClick: () => toggleRow(id),
              onKeyDown: (e) => {
                if (e?.key !== 'Enter' && e?.key !== ' ') return;
                if (typeof e.preventDefault === 'function') e.preventDefault();
                toggleRow(id);
              },
            },
              h('span', { className: 'ace-entries-row-id' }, id),
              h('span', { className: 'ace-entries-row-title' }, String(entry?.title ?? '')),
              h('span', { className: 'ace-entries-row-date' }, displayDay(entry?.updated)),
              h('span', {
                className: 'ace-entries-row-source' + (entry?.auto === true ? ' is-auto' : ''),
              }, entry?.auto === true ? t('entriesAuto') : t('entriesManual'))),
            isOpen
              ? h('div', { className: 'ace-entries-detail' },
                detailBlock('entriesCondition', entry?.condition, null),
                detailBlock('entriesAction', entry?.action, null),
                detailBlock('entriesRationale', entry?.rationale, 'entriesRationaleEmpty'),
                // 归档按钮放**详情区**而不是行内：整行本身是 role=button（点行 = 展开/收起），
                // 行内塞按钮要么得 stopPropagation 抢掉行的点击，要么键盘可达性出错；详情区最干净。
                // 两段式：首点只把这条置成确认态（不发请求），二点才真归档。
                h('div', { className: 'ace-entries-archive' },
                  h('button', {
                    type: 'button',
                    className: 'ace-entries-archive-btn' + (pendingArchive === id ? ' is-confirm' : ''),
                    'aria-label': pendingArchive === id ? t('entriesArchiveConfirmBtn') : t('entriesArchiveBtn'),
                    onClick: (e) => {
                      // 拦住冒泡：容器上的「点别处复位」监听不能把刚点出来的确认态立刻清掉。
                      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
                      archiveOne(id);
                    },
                  }, pendingArchive === id ? t('entriesArchiveConfirmBtn') : t('entriesArchiveBtn'))))
              : null);
        }));

      const pageButtons = [];
      for (let i = 1; i <= pageCount; i += 1) {
        pageButtons.push(h('button', {
          key: 'page:' + i,
          type: 'button',
          className: 'ace-entries-pager-btn' + (i === currentPage ? ' is-active' : ''),
          'aria-current': i === currentPage ? 'page' : 'false',
          onClick: () => setPage(i),
        }, String(i)));
      }

      const pager = h('div', { className: 'ace-entries-pager' },
        h('button', {
          type: 'button',
          className: 'ace-entries-pager-btn',
          disabled: currentPage <= 1,
          onClick: () => setPage(currentPage - 1),
        }, t('entriesPrev')),
        pageButtons,
        h('span', { className: 'ace-entries-pager-text' }, fmt(t('entriesPage'), { x: currentPage, y: pageCount })),
        h('button', {
          type: 'button',
          className: 'ace-entries-pager-btn',
          disabled: currentPage >= pageCount,
          onClick: () => setPage(currentPage + 1),
        }, t('entriesNext')));

      return h('div', {
        className: 'ace-entries',
        // 点别处复位：容器吞掉冒泡上来的点击（行本身、刷新、分区切换都算「别处」），
        // 只把悬空的确认态清掉；按钮自己的 onClick 已 stopPropagation，不会被这里抢掉。
        onClick: () => { if (pendingArchive !== null) setPendingArchive(null); },
      },
        head,
        scopeSwitch,
        archiveError === null
          ? null
          : h('div', { className: 'ace-entries-note ace-entries-archive-note' },
            fmt(t('entriesArchiveFailed'), { error: archiveError })),
        h('input', {
          className: 'ace-entries-search',
          type: 'text',
          value: query,
          placeholder: t('entriesSearchPlaceholder'),
          'aria-label': t('entriesSearchPlaceholder'),
          onChange: (e) => { setQuery(String(e?.target?.value ?? '')); setPage(1); },
        }),
        h('div', { className: 'ace-entries-count' },
          fmt(t('entriesCount'), { n: data.total, m: data.maxEntries === null ? '—' : data.maxEntries })),
        h('div', { className: 'ace-entries-head-row' },
          sortButton('id', t('entriesColId')),
          h('span', { className: 'ace-entries-row-title' }, t('entriesColTitle')),
          sortButton('updated', t('entriesColUpdated')),
          h('span', { className: 'ace-entries-row-source' }, t('entriesColSource'))),
        filtered.length === 0
          ? h('div', { className: 'ace-entries-note' }, t('entriesNoMatch'))
          : list,
        filtered.length === 0 ? null : pager);
    }

    // 三页标签的固定顺序（方向键循环/Home/End 的基准）与它们的 DOM 节点表。
    // 节点表在每次渲染时由 tabButton 的 ref 回填，只在切页后用来 .focus() —— 因此
    // 没有真实 DOM 的环境（测试 / SSR）里表里是空或陈旧对象，moveTab 会做守卫跳过。
    const TAB_IDS = ['stats', 'settings', 'entries'];
    const TAB_NODES = {};

    function AceSection(props) {
      const { t } = props;
      const [state, setState] = React.useState({ status: 'loading' });
      const [draft, setDraft] = React.useState({});
      const [status, setStatus] = React.useState(null);
      // 模型目录：status 取 'loading' | 'ready' | 'failed'。
      // failed 只影响两个下拉（面板里显示错误行），其余字段照常可用——
      // 宿主还没重启时 /catalog 会 404，这是正常状态。
      const [catalog, setCatalog] = React.useState({ status: 'loading', providers: [] });
      // 思考档位：state 取 'loading' | 'ready' | 'failed'，items 是该模型声明的档位，
      // effective 是后端算出来的「自动模式现在会用什么」。失败只让这一行降级成一行说明，
      // 其余字段与其余页面照常可用 —— 范式同上面的 catalog failed。
      const [efforts, setEfforts] = React.useState({ state: 'loading', items: [], effective: null });
      // 「手选档位在新模型里不存在、已被清空」的说明位（只影响一句提示，不影响任何值）。
      const [effortCleared, setEffortCleared] = React.useState(false);
      // 待合并复审列表：status 取 'loading' | 'ready' | 'failed'。
      // failed（宿主还没重启时会 404）只让这一区块变成一行灰字，其余字段照常可用 ——
      // 范式同上面的 catalog failed，绝不能因此让整页报错。
      // cap 是宿主 INBOX_CAP 的实时值（/inbox 返回），文案里的条数不许写死。
      const [inbox, setInbox] = React.useState({ status: 'loading', items: [], full: false, cap: 20 });
      // 手册统计：status 取 'loading' | 'ready' | 'failed'；data 是 /stats 的完整返回。
      // 刷新不清空已有数据（旧数字留在原地，等新结果覆盖），避免页面跳动。
      const [stats, setStats] = React.useState({ status: 'loading', data: null });
      const [statsReload, setStatsReload] = React.useState(0);
      // 当前选中的页面：'stats' | 'settings' | 'entries'，默认统计页。
      // 刻意不写 localStorage —— 刷新回统计页是明确要求。
      const [tabId, setTabId] = React.useState('stats');

      React.useEffect(() => {
        let alive = true;
        // 必须同时验 response.ok 与 payload.ok：围栏拒绝时回的是 403 { error: 'forbidden' }，
        // 没有 value 字段。旧实现直接把它喂给 adopt()，value 兜底成 {}，
        // 整页就渲染成「全默认值」并在底栏声称「当前值来自插件行 Config」——用户看到的是假配置。
        fetch(ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || typeof payload.value !== 'object' || payload.value === null) {
              setState({ status: 'failed' });
              return;
            }
            setState({
              status: 'ready',
              value: payload.value,
              configured: payload.configured ?? {},
              stored: payload.stored ?? {},
              file: payload.file,
              bounds: payload.bounds ?? null,
            });
            setDraft({});
          })
          .catch(() => { if (alive) setState({ status: 'failed' }); });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        let alive = true;
        fetch(INBOX_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || !Array.isArray(payload.items)) {
              setInbox({ status: 'failed', items: [], full: false, cap: 20 });
              return;
            }
            setInbox({
              status: 'ready',
              items: payload.items,
              full: payload.full === true,
              // 宿主改 INBOX_CAP 后这里自动跟上；cap 缺失才回退 20（老宿主）。
              cap: Number.isFinite(Number(payload.cap)) && Number(payload.cap) > 0 ? Number(payload.cap) : 20,
            });
          })
          .catch(() => { if (alive) setInbox({ status: 'failed', items: [], full: false, cap: 20 }); });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        let alive = true;
        fetch(CATALOG_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || !Array.isArray(payload.providers)) {
              setCatalog({ status: 'failed', providers: [] });
              return;
            }
            setCatalog({ status: 'ready', providers: payload.providers });
          })
          .catch(() => { if (alive) setCatalog({ status: 'failed', providers: [] }); });
        return () => { alive = false; };
      }, []);

      // —— 思考档位：provider/model 一改就重拉（旧档位列表对新模型没有意义）——
      // 查询参数：两项都填了才带上（只填一项宿主不会用覆盖值，带上反而查错模型）；
      // 都空 = 不带参数，后端用最近观察到的会话模型 —— 与 lib/llm.js:17-30 的 && 语义一致。
      // 这里读已落盘的 state.value 而不是 value()：value() 是渲染期的 draft 兜底，hook 里拿不到。
      const effortProvider = String(state.value?.reflectProvider ?? '');
      const effortModel = String(state.value?.reflectModel ?? '');
      const effortQuery = effortProvider !== '' && effortModel !== ''
        ? '?provider=' + encodeURIComponent(effortProvider) + '&model=' + encodeURIComponent(effortModel)
        : '';
      React.useEffect(() => {
        // 设置还没读回来时不发请求：那时 provider/model 都是 undefined，先带空参拉一次
        // 再带真参拉一次等于白打一发（还会把「未声明档位」的中间态闪给用户看）。
        if (state.status !== 'ready') return undefined;
        let alive = true;
        setEfforts({ state: 'loading', items: [], effective: null });
        fetch(EFFORTS_ROUTE + effortQuery, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || !Array.isArray(payload.efforts)) {
              setEfforts({ state: 'failed', items: [], effective: null });
              return;
            }
            const items = payload.efforts
              .map((entry) => ({ id: String(entry?.id ?? ''), name: entry?.name || String(entry?.id ?? ''), description: entry?.description }))
              // 只认后端钉死的七个档位名：别的值发不出去，进列表只会让用户选了报错。
              .filter((entry) => EFFORT_LEVEL_IDS.includes(entry.id));
            setEfforts({ state: 'ready', items, effective: payload.effective || null });
          })
          .catch(() => { if (alive) setEfforts({ state: 'failed', items: [], effective: null }); });
        return () => { alive = false; };
      }, [state.status, effortQuery]);

      // 打开页面拉一次；statsReload 变化时（点「刷新」按钮、设置保存成功后）再拉一次。
      React.useEffect(() => {
        let alive = true;
        fetch(STATS_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            if (!payload || payload.ok !== true || typeof payload.scale !== 'object' || payload.scale === null) {
              setStats({ status: 'failed', data: null });
              return;
            }
            setStats({ status: 'ready', data: payload });
          })
          .catch(() => { if (alive) setStats({ status: 'failed', data: null }); });
        return () => { alive = false; };
      }, [statsReload]);

      const reloadStats = () => setStatsReload((n) => n + 1);

      const send = (method, body, doneText) => {
        setStatus(null);
        fetch(ROUTE, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
          .then((response) => response.json().then((payload) => {
            if (!response.ok) throw new Error(payload?.error ?? ('HTTP ' + response.status));
            return payload;
          }))
          .then((payload) => {
            if (!payload || payload.ok !== true) throw new Error(payload?.error ?? 'unexpected response');
            adopt(payload);
            setStatus({ kind: 'ok', text: doneText });
            // 保存成功后顺手重拉统计：手册路径/容量可能刚被改过。
            reloadStats();
          })
          .catch((error) => setStatus({ kind: 'err', text: String(error?.message ?? error) }));
      };

      const commit = (field, value) => {
        const body = {};
        body[field] = value;
        send('POST', body, t('saved'));
      };

      // 换模型后旧手选档位可能不再合法（新模型的声明列表里没有它）：清空成「不指定」并说一句。
      // 只在「列表已就绪 + 值确实不在列表里」时提交一次，绝不每次进页面都白写一次配置。
      const pinnedEffort = String(state.value?.reflectReasoningEffort ?? '');
      React.useEffect(() => {
        if (efforts.state !== 'ready') return;
        if (pinnedEffort !== '' && (efforts.items || []).some((item) => item.id === pinnedEffort)) {
          setEffortCleared(false);
          return;
        }
        if (pinnedEffort === '') return;
        setEffortCleared(true);
        commit('reflectReasoningEffort', '');
      }, [efforts.state, efforts.items, pinnedEffort]);

      if (state.status === 'loading') {
        return h('div', { className: 'ace-set' }, h('style', null, CSS), h('div', { className: 'ace-set-note' }, t('loading')));
      }
      if (state.status !== 'ready') {
        return h('div', { className: 'ace-set' }, h('style', null, CSS), h('div', { className: 'ace-set-note' }, t('failed')));
      }

      // 设置回写后的整体接管：POST / DELETE 与 GET 返回同一个 describe() 形状，
      // 两边共用一份 adopt，bounds 也一起刷新（绝不各自解析一遍）。
      const adopt = (payload) => {
        setState({
          status: 'ready',
          value: payload.value,
          configured: payload.configured ?? {},
          stored: payload.stored ?? {},
          file: payload.file,
          bounds: payload.bounds ?? null,
        });
        setDraft({});
      };

      const value = (field) => (Object.prototype.hasOwnProperty.call(draft, field) ? draft[field] : state.value[field]);
      const setDraftField = (field, v) => setDraft((d) => ({ ...d, [field]: v }));

      const textProps = (field, ph) => ({
        className: 'ace-set-input',
        type: 'text',
        value: String(value(field) == null ? '' : value(field)),
        placeholder: ph || '',
        onChange: (e) => setDraftField(field, e.target.value),
        onBlur: () => {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) return;
          const v = draft[field];
          if (String(v) === String(state.value[field] == null ? '' : state.value[field])) return;
          commit(field, v);
        },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });

      // bounds 来自 describe()（lib/index.js 的 MAX_ENTRIES_RANGE 等），
      // 客户端不再自己写死边界：同一组数字只准有服务端一个出处。
      const bounds = state.bounds && typeof state.bounds === 'object' ? state.bounds : null;
      const boundsOf = (field, fallback) => {
        const pair = bounds ? bounds[field] : null;
        if (Array.isArray(pair) && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1]))) {
          return [Number(pair[0]), Number(pair[1])];
        }
        return fallback;
      };
      // 默认值也只有一个出处：服务端 describe() 的 bounds.defaults（其值是 lib/playbook-path.js
      // 的 DEFAULT_MAX_ENTRIES）。缺失（老宿主）时回退 100 —— 这个 100 仅作向后兼容兜底，
      // 正常路径下文案与 placeholder 的数字全部来自 payload。
      const boundsDefaults = bounds && typeof bounds.defaults === 'object' && bounds.defaults ? bounds.defaults : null;
      const boundsDefault = (field, fallback) => {
        const raw = boundsDefaults ? boundsDefaults[field] : null;
        return Number.isFinite(Number(raw)) && raw !== null ? Number(raw) : fallback;
      };
      const maxEntriesRange = boundsOf('maxEntries', [1, 1000]);
      const maxEntriesDefault = boundsDefault('maxEntries', 100);
      const thresholdRange = boundsOf('autoRecapThreshold', [0, 1000]);
      const cooldownRange = boundsOf('autoRecapCooldownTurns', [0, 1000]);
      // 第 36 轮三个预算项：边界与默认值同样只从 describe() 来，客户端不再写死数字。
      const protectDaysRange = boundsOf('evictProtectDays', [0, 365]);
      const protectDaysDefault = boundsDefault('evictProtectDays', 14);
      const injectBudgetRange = boundsOf('injectTokenBudget', [100, 8000]);
      const injectBudgetDefault = boundsDefault('injectTokenBudget', 500);
      const injectCountRange = boundsOf('injectMaxEntries', [1, 20]);
      const injectCountDefault = boundsDefault('injectMaxEntries', 5);
      // 第 50 轮两个门槛项：都允许小数（4.0 / 0.6 是实测档位，取整就改了方案参数）。
      const minIdfRatioRange = boundsOf('injectMinScoreIdfRatio', [0, 20]);
      const minIdfRatioDefault = boundsDefault('injectMinScoreIdfRatio', 4);
      const minRelativeRange = boundsOf('injectMinRelativeToTop', [0, 1]);
      const minRelativeDefault = boundsDefault('injectMinRelativeToTop', 0.6);

      const numProps = (field, min = 1, ph, max) => ({
        className: 'ace-set-input',
        type: 'number',
        min,
        max,
        step: 1,
        placeholder: ph || '',
        value: String(value(field) == null ? '' : value(field)),
        onChange: (e) => setDraftField(field, e.target.value),
        onBlur: () => {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) return;
          const raw = Math.floor(Number(draft[field]));
          if (!Number.isFinite(raw)) return;
          const upper = Number.isFinite(Number(max)) ? Number(max) : Number.POSITIVE_INFINITY;
          const n = Math.min(upper, Math.max(min, raw));
          if (n === Number(state.value[field])) return;
          commit(field, n);
        },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });

      // 小数版数值输入：与 numProps 同一套写入路径，差别只有 step 与**不取整**
      // （numProps 的 Math.floor 会把 0.6 压成 0 = 静默关掉门槛）。
      const decimalProps = (field, min = 0, ph, max) => ({
        className: 'ace-set-input',
        type: 'number',
        min,
        max,
        step: 0.1,
        placeholder: ph || '',
        value: String(value(field) == null ? '' : value(field)),
        onChange: (e) => setDraftField(field, e.target.value),
        onBlur: () => {
          if (!Object.prototype.hasOwnProperty.call(draft, field)) return;
          const raw = Number(draft[field]);
          if (!Number.isFinite(raw)) return;
          const upper = Number.isFinite(Number(max)) ? Number(max) : Number.POSITIVE_INFINITY;
          const n = Math.min(upper, Math.max(min, raw));
          if (n === Number(state.value[field])) return;
          commit(field, n);
        },
        onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur(); },
      });

      const fromStored = Object.keys(state.stored ?? {}).length > 0;

      // —— 两个下拉的数据与提交 ——
      const catalogError = catalog.status === 'failed' ? t('catalogFailed') : undefined;
      const catalogLoading = catalog.status === 'loading' ? t('catalogLoading') : undefined;
      const currentProvider = String(value('reflectProvider') || '');
      const currentModel = String(value('reflectModel') || '');

      // —— 思考档位：拉取、候选、说明、提交 ——
      // 后端只服务七个钉死的档位名；收到的 id 不在其中一律当「该模型未声明档位」（见 EFFORT_LEVEL_IDS）。
      const levelName = (id) => {
        const found = (efforts.items || []).find((item) => item.id === id);
        return found ? (found.name || found.id || String(id)) : String(id ?? '');
      };
      // 候选是该模型声明的档位；「不指定（跟随自动）」由 ModelPicker 底部的清空项承担
      // （clearText 已改成档位语境的文案），不再重复画一条同样的空值项。
      const effortGroups = [{
        key: 'efforts',
        title: '',
        items: (efforts.items || []).map((item) => ({
          id: item.id,
          name: item.name || item.id,
          description: item.description,
        })),
      }];
      const manualEffort = String(value('reflectReasoningEffort') || '');
      // 手选值不在当前声明列表里 = 后端不认这一档（改选了不声明它的 model 就会这样）。
      // 界面不许显示这个发不出去的值，选中态回落到「不指定」。
      const staleEffort = manualEffort !== '' && (efforts.state === 'ready'
        ? !(efforts.items || []).some((item) => item.id === manualEffort)
        : false);
      const effortValue = staleEffort ? '' : manualEffort;
      const effortsLoading = efforts.state === 'loading' ? t('catalogLoading') : undefined;
      // 说明行：手动档位 > 自动档位 > 后端给的原因 > 通用兜底。任何一格都只影响这一句文案，
      // 绝不影响其它字段 —— 路由失败时这一行必须仍然可用。
      const effortNote = (() => {
        if (efforts.state === 'failed') return t('effortsFailed');
        // 旧档位被新模型否掉：明确说出来，别让用户以为选择被默默吃了。
        if (staleEffort || effortCleared) return t('effortsStaleCleared');
        if (efforts.state === 'loading') return '';
        // 模型声明了空列表：同样是「没有可用档位」，这一句必须说出来。
        if ((efforts.items || []).length === 0) return t('effortsFailed');
        const effective = efforts.effective;
        // 手动档位在触发器上已经显示，说明行不再重复；只有自动/无档位两种情况需要解释。
        if (manualEffort !== '') return '';
        if (effective && effective.source === 'auto' && effective.effort) {
          return fmt(t('effortsAutoNow'), { name: levelName(effective.effort) });
        }
        if (effective && effective.source === 'none') return String(effective.reason || t('effortsNoneFallback'));
        return '';
      })();

      const providerGroups = [{
        key: 'providers',
        title: '',
        items: catalog.providers.map((entry) => ({
          id: entry.id,
          name: entry.name || entry.id,
          description: entry.error ? '⚠ ' + entry.error : undefined,
        })),
      }];
      // model 下拉按 provider 分组：reflectProvider 非空时只显示这一组，否则显示所有组。
      const modelGroups = catalog.providers
        .filter((entry) => currentProvider === '' || entry.id === currentProvider)
        .map((entry) => ({
          key: entry.id,
          title: entry.name && entry.name !== entry.id ? entry.name + ' · ' + entry.id : entry.id,
          items: (entry.models || []).map((model) => ({
            id: model.id,
            name: model.name || model.id,
            description: model.description,
          })),
        }));

      const pickProvider = (item) => commit('reflectProvider', String(item?.id ?? ''));
      const pickModel = (item, providerKey) => {
        const modelId = String(item?.id ?? '');
        // provider 为空时一次 POST 同时提交两项（宿主 POST 已支持多字段），
        // 否则只改 model —— 避免把用户已选好的 provider 悄悄改掉。
        if (currentProvider === '') send('POST', { reflectProvider: String(providerKey ?? ''), reflectModel: modelId }, t('saved'));
        else commit('reflectModel', modelId);
      };

      // 语义红线（lib/llm.js:17-30 resolveRoute）：两项都非空才用覆盖值，只填一项会静默回落。
      const pairIncomplete = (currentProvider !== '') !== (currentModel !== '');

      // 一个 tab：role="tab" + aria-selected + 可见选中态（.ace-tab.is-active 的底边高亮/背景差）。
      // roving tabindex：只有选中的 tab 进 tab 序（tabIndex=0），其余 -1 —— 于是「切页」
      // 完全靠 tablist 上的方向键（见 moveTab），绝不能停在原地出不去。
      const tabButton = (id, label) => h('button', {
        key: 'tab:' + id,
        type: 'button',
        role: 'tab',
        id: 'ace-tab-' + id,
        ref: (node) => { if (node) TAB_NODES[id] = node; },
        'aria-selected': tabId === id ? 'true' : 'false',
        'aria-controls': 'ace-page-' + id,
        tabIndex: tabId === id ? 0 : -1,
        className: 'ace-tab' + (tabId === id ? ' is-active' : ''),
        onClick: () => setTabId(id),
      }, label);

      // 方向键循环移动 / Home、End 跳首末；移动后把焦点交给新选中的 tab。
      // 焦点转移必须做存在性守卫：宿主环境有真实 DOM，测试与 SSR 里没有 ——
      // 没有 DOM 时只是不挪焦点，绝不能抛错让整页崩掉。
      const moveTab = (nextId) => {
        setTabId(nextId);
        const node = TAB_NODES[nextId];
        if (node && typeof node.focus === 'function') node.focus();
      };
      const onTabsKeyDown = (event) => {
        if (!event) return;
        const ids = TAB_IDS;
        const current = ids.indexOf(tabId) === -1 ? 0 : ids.indexOf(tabId);
        let next = null;
        if (event.key === 'ArrowLeft') next = ids[(current - 1 + ids.length) % ids.length];
        else if (event.key === 'ArrowRight') next = ids[(current + 1) % ids.length];
        else if (event.key === 'Home') next = ids[0];
        else if (event.key === 'End') next = ids[ids.length - 1];
        if (next === null) return;
        event.preventDefault();
        if (next !== tabId) moveTab(next);
      };

      return h('div', { className: 'ace-set' },
        h('style', null, CSS),
        h('span', { className: 'ace-set-tag' }, t('sectionTag')),
        h('div', { className: 'ace-set-title' }, t('title')),
        h('div', { className: 'ace-set-sub' }, t('subtitle')),
        // —— 三页导航（标题之下、内容之上）——
        h('div', { className: 'ace-tabs', role: 'tablist', 'aria-label': t('nav'), onKeyDown: onTabsKeyDown },
          tabButton('stats', t('tabStats')),
          tabButton('settings', t('tabSettings')),
          tabButton('entries', t('tabEntries'))),
        // 三个页面始终都在树里，只把未选中的用 [hidden] 藏起来（.ace-page[hidden]{display:none}）。
        // 因此切页不会卸载任何组件：设置页填了一半的 draft、记录页的搜索词与页码都留在原地。
        h('div', {
          className: 'ace-page',
          role: 'tabpanel',
          id: 'ace-page-stats',
          'aria-labelledby': 'ace-tab-stats',
          hidden: tabId !== 'stats',
        },
          h(StatsBlock, { t, stats, onRefresh: reloadStats }),
          // 运行统计单独一块（同一个 /stats payload 的 runtime 字段），
          // 刷新按钮与手册统计共用上面那个。
          h(RuntimeBlock, { t, stats })),
        h('div', {
          className: 'ace-page',
          role: 'tabpanel',
          id: 'ace-page-settings',
          'aria-labelledby': 'ace-tab-settings',
          hidden: tabId !== 'settings',
        },
          // 每个控件的可访问名都由 FieldRow 的 label 关联过来（htmlFor/id 或 aria-labelledby），
          // Switch 的 aria-label 恒定为字段名，开关状态只由 aria-checked 承载。
          h(FieldRow, {
            label: t('fieldPlaybookPath'), desc: t('fieldPlaybookPathDesc'), controlId: 'ace-field-playbookPath',
            control: h('input', { ...textProps('playbookPath', t('playbookPathPlaceholder')), id: 'ace-field-playbookPath' }),
          }),
          h(FieldRow, {
            label: t('fieldAutoReflect'), desc: t('fieldAutoReflectDesc'), controlId: 'ace-field-autoReflect',
            control: h(Switch, {
              id: 'ace-field-autoReflect',
              label: t('fieldAutoReflect'),
              checked: state.value.autoReflect !== false,
              onChange: (next) => commit('autoReflect', next),
              onText: t('on'), offText: t('off'),
            }),
          }),
          h(FieldRow, {
            label: t('fieldProvider'), desc: t('fieldProviderDesc'), controlId: 'ace-field-reflectProvider',
            control: h(ModelPicker, {
              ariaLabel: t('fieldProvider'),
              pickerId: 'ace-field-reflectProvider',
              labelId: 'ace-field-reflectProvider-label',
              value: currentProvider,
              groups: providerGroups,
              placeholder: t('pickProviderPlaceholder'),
              searchPlaceholder: t('pickProviderSearch'),
              noMatchText: t('pickNoMatchProvider'),
              clearText: t('pickClear'),
              errorText: catalogError,
              loading: catalogLoading,
              onPick: pickProvider,
              onClear: () => commit('reflectProvider', ''),
            }),
          }),
          h(FieldRow, {
            label: t('fieldModel'), desc: t('fieldModelDesc'), controlId: 'ace-field-reflectModel',
            control: h(ModelPicker, {
              ariaLabel: t('fieldModel'),
              pickerId: 'ace-field-reflectModel',
              labelId: 'ace-field-reflectModel-label',
              value: currentModel,
              groups: modelGroups,
              placeholder: t('pickModelPlaceholder'),
              searchPlaceholder: t('pickModelSearch'),
              noMatchText: t('pickNoMatchModel'),
              clearText: t('pickClear'),
              errorText: catalogError,
              loading: catalogLoading,
              onPick: pickModel,
              onClear: () => commit('reflectModel', ''),
            }),
          }),
          // 只填一项时的显式警告：两项恰好只有一个非空才出现（见 lib/llm.js:17-30 的 && 语义）。
          pairIncomplete ? h('div', { className: 'ace-set-warn' }, t('warnPair')) : null,
          // 思考强度：复用 ModelPicker（provider / model 两行的同一套交互），候选由 /efforts 按模型给出。
          // 失败或空列表时控件禁用、只显一行说明 —— 绝不让这一行拖垮整页。
          h(FieldRow, {
            label: t('fieldReasoningEffort'), desc: t('fieldReasoningEffortDesc'), controlId: 'ace-field-reasoningEffort',
            control: h(ModelPicker, {
              ariaLabel: t('fieldReasoningEffort'),
              pickerId: 'ace-field-reasoningEffort',
              labelId: 'ace-field-reasoningEffort-label',
              value: effortValue,
              // 触发器显示档位名（「高」「中」），值与提交语义仍是 id。
              displayValue: effortValue ? levelName(effortValue) : undefined,
              groups: effortGroups,
              disabled: efforts.state === 'failed' || (efforts.state === 'ready' && (efforts.items || []).length === 0),
              placeholder: t('pickEffortPlaceholder'),
              searchPlaceholder: t('pickEffortSearch'),
              noMatchText: t('pickNoMatchEffort'),
              clearText: t('pickEffortClear'),
              errorText: efforts.state === 'failed' ? t('effortsFailed') : undefined,
              loading: effortsLoading,
              onPick: (item) => commit('reflectReasoningEffort', String(item?.id ?? '')),
              onClear: () => commit('reflectReasoningEffort', ''),
            }),
          }),
          effortNote ? h('div', { className: 'ace-set-effort-note' }, effortNote) : null,
          // 自动降到最低思考档：照 autoReflect 那一行的写法，值只来自 /settings 的 value。
          h(FieldRow, {
            label: t('fieldAutoReasoningDowngrade'), desc: t('fieldAutoReasoningDowngradeDesc'), controlId: 'ace-field-autoReasoningDowngrade',
            control: h(Switch, {
              id: 'ace-field-autoReasoningDowngrade',
              label: t('fieldAutoReasoningDowngrade'),
              checked: state.value.autoReasoningDowngrade !== false,
              onChange: (next) => commit('autoReasoningDowngrade', next),
              onText: t('on'), offText: t('off'),
            }),
          }),
          // min/max 与文案里的数字全部取自 payload.bounds（服务端 describe() 的唯一边界出处）。
          h(FieldRow, {
            label: t('fieldMaxEntries'),
            desc: fmt(t('fieldMaxEntriesDesc'), { min: maxEntriesRange[0], max: maxEntriesRange[1], d: maxEntriesDefault }),
            controlId: 'ace-field-maxEntries',
            // placeholder 也是同一份默认值（不再写死 '100'）：宿主改了 DEFAULT_MAX_ENTRIES，这里跟着变。
            control: h('input', { ...numProps('maxEntries', maxEntriesRange[0], String(maxEntriesDefault), maxEntriesRange[1]), id: 'ace-field-maxEntries' }),
          }),
          // 第 36 轮三个预算项：都是 number 输入，写入路径与其它字段完全一致。
          h(FieldRow, {
            label: t('fieldEvictProtectDays'),
            desc: fmt(t('fieldEvictProtectDaysDesc'), { min: protectDaysRange[0], max: protectDaysRange[1], d: protectDaysDefault }),
            controlId: 'ace-field-evictProtectDays',
            control: h('input', { ...numProps('evictProtectDays', protectDaysRange[0], String(protectDaysDefault), protectDaysRange[1]), id: 'ace-field-evictProtectDays' }),
          }),
          h(FieldRow, {
            label: t('fieldInjectTokenBudget'),
            desc: fmt(t('fieldInjectTokenBudgetDesc'), { min: injectBudgetRange[0], max: injectBudgetRange[1], d: injectBudgetDefault }),
            controlId: 'ace-field-injectTokenBudget',
            control: h('input', { ...numProps('injectTokenBudget', injectBudgetRange[0], String(injectBudgetDefault), injectBudgetRange[1]), id: 'ace-field-injectTokenBudget' }),
          }),
          h(FieldRow, {
            label: t('fieldInjectMaxEntries'),
            desc: fmt(t('fieldInjectMaxEntriesDesc'), { min: injectCountRange[0], max: injectCountRange[1], d: injectCountDefault }),
            controlId: 'ace-field-injectMaxEntries',
            control: h('input', { ...numProps('injectMaxEntries', injectCountRange[0], String(injectCountDefault), injectCountRange[1]), id: 'ace-field-injectMaxEntries' }),
          }),
          // 第 50 轮两个门槛项：小数输入（step 0.1），写入路径与其它字段完全一致。
          h(FieldRow, {
            label: t('fieldInjectMinScoreIdfRatio'),
            desc: fmt(t('fieldInjectMinScoreIdfRatioDesc'), { min: minIdfRatioRange[0], max: minIdfRatioRange[1], d: minIdfRatioDefault }),
            controlId: 'ace-field-injectMinScoreIdfRatio',
            control: h('input', { ...decimalProps('injectMinScoreIdfRatio', minIdfRatioRange[0], String(minIdfRatioDefault), minIdfRatioRange[1]), id: 'ace-field-injectMinScoreIdfRatio' }),
          }),
          h(FieldRow, {
            label: t('fieldInjectMinRelativeToTop'),
            desc: fmt(t('fieldInjectMinRelativeToTopDesc'), { min: minRelativeRange[0], max: minRelativeRange[1], d: minRelativeDefault }),
            controlId: 'ace-field-injectMinRelativeToTop',
            control: h('input', { ...decimalProps('injectMinRelativeToTop', minRelativeRange[0], String(minRelativeDefault), minRelativeRange[1]), id: 'ace-field-injectMinRelativeToTop' }),
          }),
          h(FieldRow, {
            label: t('fieldInjectRationale'), desc: t('fieldInjectRationaleDesc'), controlId: 'ace-field-injectRationale',
            control: h(Switch, {
              id: 'ace-field-injectRationale',
              label: t('fieldInjectRationale'),
              checked: state.value.injectRationale === true,
              onChange: (next) => commit('injectRationale', next),
              onText: t('on'), offText: t('off'),
            }),
          }),
          h(FieldRow, {
            label: t('fieldAutoRecap'), desc: t('fieldAutoRecapDesc'), controlId: 'ace-field-autoRecap',
            control: h(Switch, {
              id: 'ace-field-autoRecap',
              label: t('fieldAutoRecap'),
              checked: state.value.autoRecap !== false,
              onChange: (next) => commit('autoRecap', next),
              onText: t('on'), offText: t('off'),
            }),
          }),
          h(FieldRow, {
            label: t('fieldAutoRecapThreshold'), desc: t('fieldAutoRecapThresholdDesc'), controlId: 'ace-field-autoRecapThreshold',
            control: h('input', { ...numProps('autoRecapThreshold', thresholdRange[0], undefined, thresholdRange[1]), id: 'ace-field-autoRecapThreshold' }),
          }),
          h(FieldRow, {
            label: t('fieldAutoRecapCooldownTurns'), desc: t('fieldAutoRecapCooldownTurnsDesc'), controlId: 'ace-field-autoRecapCooldownTurns',
            control: h('input', { ...numProps('autoRecapCooldownTurns', cooldownRange[0], undefined, cooldownRange[1]), id: 'ace-field-autoRecapCooldownTurns' }),
          }),
          h(FieldRow, {
            label: t('fieldAutoReviewInbox'), desc: t('fieldAutoReviewInboxDesc'), controlId: 'ace-field-autoReviewInbox',
            control: h(Switch, {
              id: 'ace-field-autoReviewInbox',
              label: t('fieldAutoReviewInbox'),
              checked: state.value.autoReviewInbox === true,
              onChange: (next) => commit('autoReviewInbox', next),
              onText: t('on'), offText: t('off'),
            }),
          }),
          // —— 待合并复审（独立区块；失败只降级成一行灰字）——
          h('div', { className: 'ace-inbox' },
            h('div', { className: 'ace-inbox-title' }, t('inboxTitle')),
            inbox.status === 'failed'
              ? h('div', { className: 'ace-inbox-empty' }, t('inboxUnavailable'))
              : (inbox.full ? h('div', { className: 'ace-inbox-full' }, fmt(t('inboxFull'), { n: inbox.cap })) : null),
            inbox.status === 'ready' && !inbox.full && inbox.items.length === 0
              ? h('div', { className: 'ace-inbox-empty' }, t('inboxEmpty'))
              : null,
            inbox.status === 'ready' && inbox.items.length > 0 ? h('ul', { className: 'ace-inbox-list' },
              inbox.items.map((item, index) => h('li', { key: 'inbox:' + index + ':' + item.newEntryId, className: 'ace-inbox-item' },
                h('div', { className: 'ace-inbox-pair' },
                  h('span', { className: 'ace-inbox-id' }, String(item.newEntryId ?? '')),
                  h('span', { className: 'ace-inbox-title2' }, ' 《' + String(item.newEntryTitle ?? '') + '》'),
                  h('span', { className: 'ace-inbox-arrow' }, '↔'),
                  h('span', { className: 'ace-inbox-id' }, String(item.bestMatchId ?? '')),
                  h('span', { className: 'ace-inbox-title2' }, ' 《' + String(item.bestMatchTitle ?? '') + '》')),
                h('div', { className: 'ace-inbox-ratio' },
                  t('inboxRatio') + ' ' + Math.round(Number(item.ratio || 0) * 100) + '%'))))
              : null,
            inbox.status === 'ready' ? h('div', { className: 'ace-inbox-note' }, t('inboxHint')) : null),
          h('div', {
            className: status ? ('ace-set-status ace-set-status-' + (status.kind === 'ok' ? 'ok' : 'err')) : 'ace-set-status',
          }, status ? status.text : ''),
          h('div', { className: 'ace-set-foot' },
            h('span', { className: 'ace-set-hint', style: { borderTop: 'none', marginTop: 0, paddingTop: 0 } },
              fromStored ? t('fromStored') : t('fromConfigured')),
            h('button', { className: 'ace-set-btn', type: 'button', onClick: () => send('DELETE', undefined, t('reset')) }, t('resetBtn'))),
          h('div', { className: 'ace-set-hint' }, t('editableHint'))),
        h('div', {
          className: 'ace-page',
          role: 'tabpanel',
          id: 'ace-page-entries',
          'aria-labelledby': 'ace-tab-entries',
          hidden: tabId !== 'entries',
        }, h(EntriesPage, { t, active: tabId === 'entries' })));
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ace: dictionaries');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-ace',
        order: 900,
        label: () => t('nav'),
        locale: NS,
      }, (props) => h(AceSection, {
        ...props,
        t: Object.assign((key) => t(key), { locale: localeTag(ctx) }),
      })));
    }

    return { inject, apply, name: 'dsh-ace' };
  },
});
