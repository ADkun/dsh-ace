# FIX-REPORT-R36：话题热度 + 新条目保护期 + 三个预算配置项

基线：**477 tests / 476 pass / 0 fail / 1 skip**（`node --test tests/`，D:/dsh/plugins/dsh-ace）。
本轮六节：① lib/heat.js ② lib/inject.js 排序键 ③ lib/index.js 接线 ④ lib/evict.js 保护期
⑤ 三个配置项（evictProtectDays / injectTokenBudget / injectMaxEntries） ⑥ 文档 + 新用例 + 变异自证。

---

## §1 新建 lib/heat.js（纯逻辑，只 import ./inject.js）

- 常量：`HEAT_WINDOW_MESSAGES = 30`、`HEAT_TOP_PER_MESSAGE = 3`、`HEAT_WEIGHT = 0.1`、`RELEVANCE_WEIGHT = 0.9`
  （后两个在 lib/inject.js 里定义、由 heat.js 转出，避免两处各写一份口径）。
- `createHeatWindow()`：WeakMap 按 agent 隔离的环形窗口。`note(agent, text)` 只收非空正文、超 30 条丢最老的；
  `messagesOf(agent)` 返回**副本**（老在前）；`clear(agent)` 只清这一个 agent。
- `computeHeat(entries, messages, options)` → `Map<id, number>`：每条消息各跑一次 `rankInjection(entries, text)`
  （**不传 heat**），取 `ranked.slice(0, topPerMessage)` 命中的 id 各 +1。
- **硬要求（反自增强）**：热度只由「用户说过的话」产生。computeHeat 内部永远不把热度喂回 rankInjection，
  所以把注入出去的条目再喂一遍，计数与排序一字不变（新用例②钉住）。

## §2 lib/inject.js：排序键 = 0.9×相关度 + 0.1×归一化热度

- `rankInjection(entries, query, options)` 支持 `options.heat`（Map 或普通对象都认）。
- 归一化热度 = `heat[id] / 本轮候选里的最大 heat`；候选最大 heat 为 0（含空）时全部按 0 算 —— 不出 NaN。
- 排序：`composite = 0.9 × relevance + 0.1 × normalizedHeat` 降序；**composite 相同按 `idNumber` 升序**（既有确定性保留）。
- **相关度 ≤ 0 的条目仍然绝不进候选**：热度只重排「本来就有字面交集」的条目，不制造相关度。
- `selectInjection(entries, query, options)` 透传 `options`（heat 因此生效）。
- INJECT_MAX_ENTRIES / INJECT_MIN_ENTRIES / INJECT_TOKEN_BUDGET、estimateTokens 公式、预算截断、rationale 整批开关：**一行未动**。

## §4 lib/evict.js：新条目保护期

- `planEvictions(entries, need, { date, protectDays })`：`created` 距 `date` 不足 `protectDays` 天的条目**先进受保护组**；
  未受保护的够 `need` 就只从它们里挑；不够时用受保护条目按**既有全序**（hits 升序 → created 早先 → id 升序）补齐。
- 绝不死锁、绝不整批拒绝：need 超过总条数时返回全部（先去保护组的全序拼接）。
- `protectDays <= 0` 或非有限数 / 缺省 = 不保护（与旧版逐字等价）。

## §3 lib/index.js 接线 + §5 三个配置项

- `:19` 新增 `import { createHeatWindow, computeHeat } from './heat.js';`；`:433` 附近 `const heatWindow = createHeatWindow();`。
- `agent/inbox/inserted` 处理器里 `if (!query) return;` 之后**同步** `heatWindow.note(agent, query);`（按消息到达顺序），
  async IIFE 内 `const heat = computeHeat(snapshot.entries, heatWindow.messagesOf(agent));`，
  然后 `selectInjection(..., { maxEntries: injectMaxEntriesOf(live.injectMaxEntries), tokenBudget: injectTokenBudgetOf(live.injectTokenBudget), heat })`。
  **窗口按 agent 隔味**（WeakMap），子代理与主代理不串。
- Config 新增三字段（12 字段）：`evictProtectDays` 默认 14（0–365）、`injectTokenBudget` 默认 900（100–8000）、
  `injectMaxEntries` 默认 5（1–20）；模块级常量 `EVICT_PROTECT_DAYS_RANGE / INJECT_TOKEN_BUDGET_RANGE / INJECT_MAX_ENTRIES_RANGE`
  与 `DEFAULT_*` 三个默认值常量。
- 读侧口径：`settingsNumber(value, fallback)` 只在 undefined/null/空串/非有限数回落 —— **显式 0 保留**；
  新增 `validTunableInt()`：读设置文件时 null 与空白串一律当「没填」（`Number(null) === 0` 会被误读成「不保护」，
  这是本轮真实修掉的一个缺陷，见「§6 过程中的修正」）。
- 调用点改读配置：`executeRecap` 的 deps 与 curate 的 `commitOps` options 各加 `protectDays: evictProtectDaysOf(live.evictProtectDays)`；
  注入处读注入条数/预算配置。常量仍留作兜底默认值。
- `describe()` 的 bounds 多三个键 + `defaults` 多三个键（**插在 maxEntries 之前**，保持既有源码断言里
  `defaults: { maxEntries: DEFAULT_MAX_ENTRIES` 这个子串仍然成立）；PUT 三键各一支校验（越界 400，文案带范围）。
- client.js：zh/en 字典各加三个标签与说明（中英双语，说清「调大 = 更少注入更省 token / 更晚淘汰新条目」），
  设置页新增三行 number 字段，controlId `ace-field-evictProtectDays` / `ace-field-injectTokenBudget` / `ace-field-injectMaxEntries`。

## §6 新用例（本轮新增 4 个文件 / 35 条）

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| tests/heat.test.mjs | 14 | 常量契约、窗口上限 30 / 按 agent 隔味 / 只收有正文的消息、computeHeat 计数与 topPerMessage、**反自增强**、热改排序、**0 相关度不许靠热度进入**、热度最大值为 0 时不出 NaN、selectInjection 透传 heat |
| tests/heat-wiring.test.mjs | 2 | 真宿主桩：窗口按 agent 隔味 + 热度真的改变注入顺序；重启即清空 |
| tests/evict-protect.test.mjs | 10 | 够/不够/全受保护三条路径、protectDays ≤ 0 与非有限数与旧版逐字等价、边界「恰好 N 天前不算受保护」、字符串与小数、纯函数可复现 |
| tests/config.test.mjs | 9 | Config 12 字段与默认值、GET bounds/defaults、POST 落盘、**evictProtectDays = 0 不被 `|| 14` 吞掉**、越界 400、边界放行、空 body/未知键 400、非法值整批原子、坏值回落口径 |

`node --test tests/` → **512 tests / 511 pass / 0 fail / 1 skip**（基线 477/476/0/1，净增 35 条）。

## §6 过程中的修正（三处，写在这里防丢）

1. **tests/config.test.mjs 的 schemastery 桩**：chain 版桩把 `object(fields)` 的 fields 丢了，
   Config.fields 读不到 → `Cannot convert undefined or null to object`。换成与 tests/wiring.test.mjs 同款的
   `builder(kind)` + `object(fields) => ({ type:'object', fields })`。
2. **设置写入只认 POST，不认 PUT**（lib/index.js:1456 `if (method !== 'POST') return send(405, …)`）——
   用例里的 `put()` 改成 POST，没有改生产契约。
3. **真实的读侧缺陷**：`normalizeSettings` 原来对三个新键用 `validInt`，而 `Number(null) === 0`、`Number('  ') === 0` ——
   手改坏 / 旧版本写下的 `evictProtectDays: null` 会被静默读成「0 = 不保护新条目」。
   新增 `validTunableInt`（null / 空白串 → undefined → 回落默认 14），并保留显式 0。

## §6 既有测试的适配（3 处，都是契约变化，断言没放宽）

- tests/wiring.test.mjs:391-394：Config 字段数 9 → 12，键数组同步补三个新键。
- tests/entries.test.mjs 条目⑧：断言改成 `/defaults: \{[\s\S]*?maxEntries: DEFAULT_MAX_ENTRIES/`（defaults 有四个键了），
  并新增 `/maxEntries: \d+/` 不得匹配。
- tests/e2e.test.mjs 场景 5：`config: { evictProtectDays: 0 }`（该场景故意让条目只有 10 天龄，默认 14 天保护会把旧期望顶掉）。

（更多改动与变异表在本文件后续小节。）


## §6 补：验收 2f 的「配置项行为」用例（tests/tuning-behaviors.test.mjs，4 条）

新增第 5 个测试文件 `tests/tuning-behaviors.test.mjs`（4 条，全绿，555 ms）：全部真跑宿主线，
不是源码正则 —— 每条都走 `agent/inbox/inserted` → `agent/pre-step` 投递链路或真空跑 `ace` 命令（真落盘 + 读 archive.md）。

| 用例 | 断言 |
| --- | --- |
| 配置行为① injectTokenBudget 调小 → 注入条数变少 | 预算 4000 → 注入 5 条；预算 150 → 注入 ≥1 且 < 5 条，且是前者的**前缀**（只砍尾部）；纯函数 `selectInjection(…, { tokenBudget })` 复算同数 |
| 配置行为② injectMaxEntries 调小 → 注入条数变少 | 预算都 4000；maxEntries 5 → 5 条，maxEntries 2 → 恰好 2 条且等于前者的前两条 |
| 配置行为③ evictProtectDays 调大 → 更晚淘汰新条目 | 老条目 ace-001（2020-01-01，hits 9）+ 新条目 ace-002/003（今天，hits 0），maxEntries 3，来 1 条候选：protectDays 0 → 归档 `['ace-002']`；protectDays 14 → 归档 `['ace-001']`（新条目一条不动），reason 都是 `evicted`，活跃条数恒为 3（容量一位不减） |
| 配置行为④ maxEntries 调小 → 淘汰更早发生 | maxEntries 100 → 活跃 4 条、archive 为空；maxEntries 3 → 活跃 3 条、archive 恰好 1 条 reason `evicted` |

## 变异自证（12 个，全部「改了哪一行 → 哪条用例变红」，无落空项）

做法：每次定点改一行 → 跑全量 `node --test tests/` → 记录变红用例 → 立刻改回（改回后全量复跑仍 516/515/0/1）。

| # | 改了哪一行 | 变红用例（数量） |
| --- | --- | --- |
| M1 | lib/inject.js:92 `.filter((item) => (Number(item.score) \|\| 0) > 0)` → `>= 0`（0 分条目放进候选） | 6：E2E 场景6、E2E 场景7、热度接线×2、**热度③「0 相关度条目热度爆表也绝不进候选」**、热度③（端到端） |
| M2 | lib/inject.js:114 `normalizedHeat = heatMax > 0 ? heatOf/heatMax : 0` → `= 0`（热度不进综合分） | 4：热度接线、热度②反自增强、热度③ heat 改排序、热度③ selectInjection 透传 |
| M3 | lib/inject.js:123 同分回落 `idNumber(a) - idNumber(b)` → 反向（破坏确定性） | 7：E2E 场景6、热度③×3、C5.3×2 等 |
| M4 | lib/heat.js:59 `while (list.length > HEAT_WINDOW_MESSAGES) list.shift()` → 不裁剪 | 1：**热度①「窗口上限 30，第 31 条把第 1 条挤出去」** |
| M5 | lib/heat.js:95 `rankInjection(list, query)` → `rankInjection(list, query, { heat: options.heat })`（自增强） | 2：**热度②反自增强**、tests/recap-usage.test.mjs |
| M6 | lib/evict.js:97 删掉 `if (picked.length < want) picked = picked.concat(fresh…)`（不兜底） | 6：**保护期②×3（不够/全受保护/超总数）、保护期③×2、保护期②「不许挤掉更靠前的」** |
| M7 | lib/evict.js:52 `Number.isFinite(days) && days > 0 ? days : 0` → 去掉 `days > 0` | 0 —— **等价变异**：`protectDaysOf` 返回 0 时外层 `if (days > 0)` 直接跳过保护分支，行为与旧版逐字一致，故没有用例可红（这是等价变异，不是落空） |
| M7′ | lib/evict.js:63 `today - created < days` → `<= days`（边界口径） | 1：**保护期③「恰好 N 天前算不在保护期」** |
| M8 | lib/index.js:748 `heatWindow.note(agent, query)` → `void query`（不记用户消息） | 1：**热度接线「窗口按 agent 隔离，热度真的改变注入顺序」** |
| M9 | lib/index.js:260 `Number.isFinite(n) ? n : fallback` → `n \|\| fallback`（0 被默认值吞掉） | 2：**配置行为③（protectDays 0 vs 14）**、E2E 场景5 |
| M10 | lib/index.js:759 `maxEntries: injectMaxEntriesOf(live.injectMaxEntries)` → `INJECT_MAX_ENTRIES` | 1：**配置行为②** |
| M11 | lib/index.js:760 `tokenBudget: injectTokenBudgetOf(live.injectTokenBudget)` → `INJECT_TOKEN_BUDGET` | 7：**配置行为①②**、E2E 场景4/6/7、热度接线×2 |
| M12 | lib/index.js:902 `protectDays: evictProtectDaysOf(live.evictProtectDays)` → `0`（复盘面配置失效） | 1：**配置行为③** |

## 最终自证数字

- `node --test tests/` → **tests 516 / suites 0 / pass 515 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 4776.3618**
  （基线 477 / 476 / 0 / 1 → 净增 39 条，fail 仍 0；skip 仍是那条 Windows 文件权限位 T47）
- 新增用例 **39 条**（heat 14 + heat-wiring 2 + evict-protect 10 + config 9 + tuning-behaviors 4），全部真跑函数 / 真跑宿主线。
- `node --check`：lib/*.js 30 个 + client.js 1 个 = **checked=31 bad=0**。
- 仓库根无多余探针文件：只有 .gitignore / AGENTS.md / DESIGN.md / FIX-REPORT-R36.md / FIX-REPORT.md / LICENSE /
  PAPER-ALIGNMENT.md / README.md / TESTING.md / client.js / cordis.patch.yml / icon.svg / package.json + 目录 lib / locale / tests。

## git diff --stat 与本轮真实改到的文件

`git diff --stat` 报 29 files changed，但仓库里还压着前几轮**未提交**的大改动，
所以这个清单不能隔离本轮。本轮的改动文件按实际编辑记录如下：

**生产代码（4 个）**
- `lib/heat.js`（新建，103 行，本轮 R36 §1）
- `lib/inject.js`（§2：HEAT_WEIGHT/RELEVANCE_WEIGHT、rankInjection 的 heat 归一化与 composite 排序、selectInjection 透传 options）
- `lib/evict.js`（§4：`protectDaysOf` / `dayNumberOf` / `isWithinProtection` / 保护期两段式挑选）
- `lib/index.js`（§3 接线 + §5 三配置项：import heat、Config 三字段、`settingsNumber`/`validTunableInt`/三个 `*Of` 助手、normalizeSettings、applyStored 12 键、inbox 处理器记窗与取热、executeRecap/curate 传 protectDays、describe bounds/defaults、PUT 三分支）
- `lib/commit.js`（`planEvictionMoves` 第六参 `protectDays`，两处调用点透传）
- `lib/recap-pipeline.js`（新增 `resolveProtectDays`，deps.protectDays 传到 commitCapacity / commitOps）

**前端（1 个）**
- `client.js`（zh/en 六条文案 + 六个 bounds 助手常量 + 三行 number FieldRow）

**测试（5 新建 + 3 适配）**
- 新建：`tests/heat.test.mjs`(14)、`tests/heat-wiring.test.mjs`(2)、`tests/evict-protect.test.mjs`(10)、`tests/config.test.mjs`(9)、`tests/tuning-behaviors.test.mjs`(4)
- 适配：`tests/wiring.test.mjs`(Config 9→12)、`tests/entries.test.mjs`(条目⑧ 的 defaults 断言)、`tests/e2e.test.mjs`(场景 5 加 `evictProtectDays: 0`)

**文档（4 个）**
- `README.md`（配置表三行 + 0 的含义 + 回落口径）
- `DESIGN.md`（「话题热度」与「新条目保护期」两节 + 注入/淘汰旧节改写 + For Agents 两条指引）
- `AGENTS.md`（lib/inject.js、lib/evict.js 两行 + 红线 14 改写 + 新增第 17 条红线）
- `TESTING.md`（总数 477→516、文件数 28→33、第 36 轮历史段、五个文件条数表行）

## 遗留问题（如实记）

1. **`injectTokenBudget` 的下游可见性**：注入块文本里的「最多 N 条」现在仍渲染 `INJECT_MAX_ENTRIES`（常量兜底值 5），
   不是运行时的 `injectMaxEntries` 配置值。`tests/e2e.test.mjs:660` 与 `tests/inject.test.mjs:187` 钉了这个文案；
   改它会连带改 `renderInjection` 签名（要额外传 maxEntries）与这两个断言，本轮按「预算截断逻辑一律不动」的约束没动。
   行为面（真正注入几条）已按配置生效，只有文案里的数字是常量。
2. **`archive.test.mjs` 的 `planEvictions` 调用点**都只传 `{ date }`，故仍走「不保护」路径（与旧版逐字一致）；
   保护期只在生产接线（`protectDays` 从配置透传）与 `tests/evict-protect.test.mjs` 里生效。
3. 本轮未动复盘主链「不满额时合并」与体检面板（按要求留给下一轮）。



## 文件:行号 精确索引（本轮 R36 落点，最终代码）

**lib/heat.js（新建，103 行）**
:22 HEAT_WINDOW_MESSAGES = 30 · :25 HEAT_TOP_PER_MESSAGE = 3 · :27 re-export HEAT_WEIGHT/RELEVANCE_WEIGHT ·
:40 createHeatWindow()（:44 messagesOf 返回副本 / :52-62 note 环形裁剪 / :63 clear）· :85 computeHeat()（:87 过滤无 id、:89 空输入早退、:91 topPerMessage、:95 调 rankInjection 不传 heat）

**lib/inject.js**
:29 HEAT_WEIGHT = 0.1 · :32 RELEVANCE_WEIGHT = 0.9 · :84 rankInjection(entries, query, options = {}) ·
:92 0 分条目 filter（硬约束，未动）· :100-110 heat 归一化（Map/普通对象都认，heatMax 取本轮候选）· :114 normalizedHeat · :116 composite · :122-125 排序（同分 idNumber 升序）· :192 selectInjection 透传 options

**lib/evict.js**
:15-19 头部注释（保护期语义 + ≤0 等价旧版）· :42 dayNumberOf · :50 protectDaysOf · :59 isWithinProtection ·
:78 planEvictions(entries, need, { date, protectDays }) · :85 days · :87-98 两段式挑选（:94 先未受保护、:97 不够时兜底补齐）

**lib/index.js**
:58 import heat · :96-101 三组 RANGE 与 DEFAULT 常量 · :112-114 Config 三字段 · :245 validTunableInt ·
:256 settingsNumber · :264/:269/:274 evictProtectDaysOf / injectTokenBudgetOf / injectMaxEntriesOf ·
:299-312 normalizeSettings 三分支（含 warn）· :474 applyStored 12 键数组 · :511 const heatWindow ·
:748 heatWindow.note(agent, query) · :757 computeHeat · :759-760 selectInjection 读配置 · :902 executeRecap deps protectDays · :1210 curate commitOps options protectDays · :1330-1336 describe bounds/defaults · :1507-1523 PUT 三分支

**lib/commit.js** :90 注释 · :95 planEvictionMoves(…, protectDays, logger) · :105 evictPlan(pool, want, { date, protectDays }) · :205 / :321 两处调用点透传 options?.protectDays

**lib/recap-pipeline.js** :72 文档 · :142 resolveProtectDays(deps.protectDays) · :183 commitCapacity 传 protectDays · :243 commitOps 传 protectDays

**client.js** :60-65 zh 六条文案 · :203-208 en 六条文案 · :1473/:1475/:1477 三组范围 · :1675-1690 三行 FieldRow（controlId ace-field-evictProtectDays / ace-field-injectTokenBudget / ace-field-injectMaxEntries）

**文档** README.md:86-88 三行配置 · DESIGN.md:251「新条目保护期」/ :363「话题热度」两节 · AGENTS.md:79 红线 14 改写 / :82 新增红线 17 · TESTING.md:18 总数 / :395 第 36 轮段 / :443-447 五个文件条数表行

