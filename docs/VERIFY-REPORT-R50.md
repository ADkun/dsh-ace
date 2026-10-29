# VERIFY-REPORT-R50 —— 独立对抗验收（第 49/50 轮）

> 验收者身份：未参与任何实现。所有结论只来自**本人读到的源码**与**本人跑出的命令输出**。
> FIX-REPORT-R49/R50、AGENTS.md、DESIGN.md、TESTING.md 中的自述一律按「待证口供」处理：只在被实测复现后才采信。
> 未修改任何 lib/、client.js、tests/ 文件（变异自证期间的临时改动已逐条 SHA256 复核还原，见第 4 节）。
> 唯一写入的文件就是本报告。

## 0. 判定总表

| 条目 | 判定 | 一句话结论 |
| --- | --- | --- |
| A 门槛（lib/inject.js） | **通过** | 算式 4.0×IDF_MAX、每条 max(floor, 0.6×top1)、top1 自身过门槛、门槛在热度之前、N=0/极小 N 安全，正反例已实跑 |
| B 配置面五处一致 | **通过** | 白名单/Config/POST/normalize 四处集合逐键相等（16 键），bounds 覆盖其中 8 个数值区间键 + reasoningEfforts 枚举 + 6 项 defaults，真 import + 真 HTTP 双向验证 |
| C oneShot 四 reason | **通过**（带缺陷 D1） | 四种 finish reason 文案与前缀各自正确、调用方取消不被 isTimeoutError 误认、reasoningEffort 仅在合法非空时写入；但**不传 signal 的调用点（手动 ace_reflect）**会把本层超时说成「调用方取消」 |
| D 自动降档 | **通过**（两处瑕疵 D2/D4） | 判定顺序 手动值 > 自动最低档 > 不干预 实测按序；查档失败/超时永不抛；两闸都 warn 且不干预；缓存只在进程内存 Map，零 fs import |
| E 超时降档重试 | **通过** | 仅 isTimeoutError 才重试、结构上恰好一次（无循环/无计数变量，M4/M5 变异实证）、重试仍失败候选照常落盘、第一轮无预算绝不空手 |
| F 测试守卫 | **通过** | 实测 719 / 718 pass / 0 fail / 1 skip，与红线 20 一致；5 次变异自证（M1–M5）全部转红并全部还原复绿 |
| G 红线 | **部分通过** | 红线 2/5/8/9 实测未破；**扣分项 D3**：AGENTS.md 代码地图缺 `lib/inbox.js` 独立行（该文件名在整个 AGENTS.md 里零次出现），属既有文档缺口、非本轮引入 |

## 1. 我如何取信（证据链）

- 基线：`node --test tests/`（workdir `D:\dsh\plugins\dsh-ace`）→ `tests 719 / suites 0 / pass 718 / fail 0 / cancelled 0 / skipped 1 / todo 0 / duration_ms 6408.7983`，退出码 0；变异全部还原后再跑一次 `duration_ms 7048.3244`，仍 719/718/0/1。
- 所有「跨模块」结论都用**真 import + 真调用**取，不靠数行：`lib/index.js` 的真 `apply()` 在 `node:module` 的 `registerHooks` 下把三个宿主包（schemastery / dsh-tools / dsh-llm）stub 成 `data:` URL，`DSH_HOME`/`DSH_PROFILE_DIR` 指临时目录，再用真 HTTP handler 打真路由。
- 所有代理内部状态结论都用**直 import 纯函数 + 构造输入**取（`rankInjection` / `selectInjection` / `planReasoningEffort` / `lowestEffortOf` / `oneShot`）。
- 凡涉及相邻语义（例如「IDF_MAX 是不是真的就是 df=1 的上界」），都回到被依赖的实现在同一份输入上对照（`lib/playbook.js:1015-1034` 的 `scoreEntries`）。

## 2. A–G 逐条

### A. 注入门槛（lib/inject.js）—— 通过

**(1) 绝对门槛算式与声明一致。**
- `lib/inject.js:54` `export const INJECT_MIN_SCORE_IDF_RATIO = 4.0;`；`lib/inject.js:63` `INJECT_MIN_RELATIVE_TO_TOP = 0.6;`
- `lib/inject.js:70-77` `injectScoreFloor(entryCount, ratio)`：`n` 非有限或 `<= 0` → 返回 `0`；`r` 非有限或 `<= 0` → 返回 `0`（即「关掉这一半门槛」）；否则 `r * Math.log((n - 1 + 0.5) / (1 + 0.5) + 1)`。
- 对照实现：`lib/playbook.js:1028` `idf = Math.log((N - df + 0.5)/(df + 0.5) + 1)`，`N = entries.length`（`lib/playbook.js:966`），`K1=1.2 B=0.75`，`tf=1 且 dl=avgdl` 时归一化因子为 1。故 `df=1` 的单 term 上界**恰为** `log((N-1+0.5)/(1+0.5)+1)` —— 门槛取的就是「只出现在 1 条文档里的最强 term」的分数，×4.0 等价于「至少 4 个独占 term 的强度」。算式自洽。
- 实测：`injectScoreFloor(2)=2.7726`（= 4×log(0.5/1.5+1)）；`injectScoreFloor(30)=12.1141`，对应 `IDF_MAX=3.0285`。

**(2) 每条门槛 = max(floor, 0.6×top1)**，`lib/inject.js:146-149`：

```js
const relative = rawRelative === undefined || rawRelative === null ? INJECT_MIN_RELATIVE_TO_TOP : Number(rawRelative);
const safeRelative = Number.isFinite(relative) && relative > 0 ? relative : 0;
const minScore = Math.max(floor, safeRelative * topScore);
```

过滤在 `lib/inject.js:155-156`：`filter(item => score >= minScore && score > 0)`。

**(3) top1 自己也要过门槛**，`lib/inject.js:141-143`：

```js
if (topScore <= 0 || topScore < floor) return { ranked: [], topScore: 0 };
```

这里把 `topScore` 归零返回，于是 `lib/inject.js:270` `if (topScore <= 0 || !ranked.length) return { ...empty, topScore }` 会把「整轮 0 条」表达成 `{count:0, text:'', tokens:0}`。**「无相关经验 → 注入 0 条」是可达且被表达的结果**，不是靠「top1 分 > 0」硬塞一条。

**(4) 门槛在热度加权之前，热度不能绕过**：
- 过滤在 `lib/inject.js:155-161`，加权与排序在 `lib/inject.js:162-189`（`composite = 0.9×relevance + 0.1×normalizedHeat`，`:177-181`）。被过滤掉的条目根本不在 `ranked` 里，加权无对象可加。
- 反向佐证：`lib/heat.js:97` 的 `computeHeat` 调 `rankInjection` 时**不传 heat**（红线 14 的原始要求），但把两个门槛值传下去（`lib/heat.js:85-107`），保证热度账与注入账同一把尺子。

**正反例实跑（本人构造）**：
- 语料 N=30（A 10 词 / B 5 词 / C 4 词 + 27 填充条），query 与 A/B/C 有交集：`floor=12.1141`、`topScore=26.2311`、`0.6×top=15.7387`。默认门槛下 `ranked` 只有 `ace-001(26.231)` 与 `ace-002(16.034)`；**`ace-003(13.495)` 过了绝对门槛 12.114 却被相对门槛 15.739 挡住**。
  - 反证 1：`injectMinRelativeToTop=0` → `ace-003` 进入（相对门槛确实在起作用）；
  - 反证 2：`injectMinScoreIdfRatio=0` → 仍只有 `ace-001/002`（绝对门槛这一半也独立生效）。
- **热度反例（关键）**：给被挡的 `ace-003` 热度 `100000`，默认门槛下 `ranked` **仍只有 `ace-001/002`**；把 `relative` 设 0 后、同样热度下 `ace-003` 以 composite `0.563` 反超 `ace-002(0.5501)` —— 说明热度只在**已经过门槛的候选之间**重排，**无法把门槛以下的条目顶进候选**。
- 完全无关 query（`今天天气怎么样`）+ 三条高热度条目 → `ranked` 0 条 / `topScore` 0 —— 「无相关经验 → 0 条」正向成立。

**(5) N=0 / 极小 N 安全**：`injectScoreFloor(0)=0`、`(1)=1.1507`、`(-3)=0`、`(NaN)=0`、`(undefined)=0`；`rankInjection([], q)` → `{topScore:0, ranked:[]}`；`selectInjection([], q, {})` → `{count:0, text:'', tokens:0}`；N=1 且该条命中 → `topScore=1.438 >= floor 1.151` → `ranked` 1 条（不误杀）。无除零、无 NaN、无抛错。

### B. 配置面五处一致性 —— 通过（16 键）

用脚本对**集合**（不是行数）比对，且在真 import 下取：
- (a) `lib/index.js:134-153` `Config = z.object({...})` 字段；
- (b) `lib/index.js:547` `applyStored` 白名单数组；
- (c) `lib/index.js:2402-2414` 的 POST 校验块（reflectReasoningEffort `:2403-2408`、autoReasoningDowngrade `:2409-2414`）（16 个「键在 body 里就校验」分支）；
- (d) `lib/index.js:2052-2072` `describe().bounds`（describe 自 `:2044` 起）；
- (e) `lib/index.js:337-395` `normalizeSettings`。

结果：`白名单 == Config == POST == normalize` 四个集合**逐键相等**，缺项与多余项皆为空集。16 键为：
`playbookPath, autoReflect, reflectProvider, reflectModel, maxEntries, evictProtectDays, injectTokenBudget, injectMaxEntries, injectMinScoreIdfRatio, injectMinRelativeToTop, autoRecap, autoRecapThreshold, autoRecapCooldownTurns, autoReviewInbox, reflectReasoningEffort, autoReasoningDowngrade`。

`bounds` 与它们的关系：**只覆盖 8 个有区间的数值键**（`maxEntries` / `autoRecapThreshold` / `autoRecapCooldownTurns` / `evictProtectDays` / `injectTokenBudget` / `injectMaxEntries` / `injectMinScoreIdfRatio` / `injectMinRelativeToTop`）+ `reasoningEfforts: [off,minimal,low,medium,high,xhigh,max]`（`lib/index.js:2063`，来源 `REASONING_EFFORT_IDS`）+ 6 项 `defaults`。8 个字符串/布尔键**本来就没有区间**，不列 bounds 属设计而非缺口 —— 逐键核对过，不存在「白名单有而 bounds 缺（本该有区间的）」或反之。

**真 HTTP 验证**（真 `apply()` + 真 handler）：`GET /api/dsh-ace/settings` → 200，`value` 16 键、`bounds` 8 个区间键、`defaults` 6 项、`reasoningEfforts` 七值；`POST` 16 键逐键：非法值全 `400` 且文案对得上，合法值全 `200` 且读回一致。细节：
- `reflectReasoningEffort`：`''`→200 存空串（= 未指定，合法）；`off`/`max`→200；`REASONING?`→400（文案「必须是 off/minimal/low/medium/high/xhigh/max 之一，或留空表示跟随自动降档」）；`'high '`→200 归一成 `high`（`lib/reasoning.js:52-57` 的 trim）。
- `injectMinScoreIdfRatio`：`4.5`/`0`/`'4.0'`→200；`20.5`/`-1`→400。
- `playbookPath`/`reflectProvider`/`reflectModel` 传任意字符串都 200 —— 无枚举约束，设计如此。

### C. oneShot（lib/llm.js）—— 通过，但手动脉络带缺陷 D1

**(1) 四个 finish reason 的文案与前缀**（`lib/llm.js:154-201`，全部用真 `finish` 块实跑）：

| reason | 触发条件 | 实测文案 | 超时前缀 |
| --- | --- | --- | --- |
| `aborted` + **调用方取消** | 调用方 `signal.aborted === true` | `ace: LLM 调用被取消（调用方信号已中止、已收正文 0 字符、reasoning 0 字符、耗时 1ms、p/m、单次上限 50ms）` | **否**（`lib/llm.js:169-173` 刻意另起一族） |
| `aborted` + **本层单次上限** | 调用方 signal 未中止、本层 cap 到点 | `ace: LLM 调用超时（单次上限 60ms）：已收正文 0 字符、…` | **是**（`lib/llm.js:176-180`） |
| `max-tokens` | 宿主 finish 给 `max-tokens` | `ace: LLM 输出被 max-tokens 截断（p/m、已收正文 7 字符、reasoning 0 字符、耗时 1ms、p/m、单次上限 50ms）` | 否（`lib/llm.js:183-186`） |
| `error` | 宿主 finish 给 `error` | `ace: LLM 调用失败（finish reason=error：boom 401、已收正文 0 字符、…）` | 否（`lib/llm.js:189-193`） |
| （另）宿主流直接 throw | 非 finish 块 | 原样 rethrow，无 `ace:` 前缀（`lib/llm.js:154-161` 只在 `callSignal.aborted && !(signal && signal.aborted)` 时才改写成超时错） | — |
| （另）空正文 | 只有 reasoning | `ace: LLM 本次正文为空（reasoning N 字符、耗时 Nms、provider/model）` | 否（`lib/llm.js:195-201`） |

一个观感瑕疵（不构成缺陷）：`max-tokens` 与 `超时` 两族文案里 `provider/model` 出现两次 —— `sceneOf` 自带 provider/model，前缀又拼了一遍。不影响判定。

**(2) 「调用方取消」不被 isTimeoutError 误认**：`isTimeoutError(x) = x.message.startsWith('ace: LLM 调用超时')`（`lib/reflect.js:17-21`）。上面调用方取消的实测 message **不含**该前缀 → `isTimeoutError = false`。**不误认，符合要求**。

判据的宿主侧依据（已核对宿主源码）：`C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:1645` `reason: mapStopReason(callerSignal?.aborted ? {...event.error, stopReason:'aborted'} : event.error, ...)`，`callerSignal` 即 `options.signal`（同文件 `:1990`）。故**本层 cap 到点与调用方取消在宿主侧产生同一个 `kind:'aborted'`**，只能靠「调用方 signal 自己是否已中止」区分 —— `lib/llm.js:169` 的 `signal ? signal.aborted : callSignal.aborted` 正是这条判据，逻辑必要且正确（其副作用见 D1）。

**(3) reasoningEffort 仅在合法非空时写入**，`lib/llm.js:124`：

```js
if (typeof reasoningEffort === 'string' && reasoningEffort !== '') options.reasoningEffort = reasoningEffort;
```

实测四态（截获**宿主真收到的 options**）：`''` / `undefined` / 键缺失 → `hasOwnProperty('reasoningEffort') === false`；`'low'` → `'low'`。**该键在不需要时确实不存在**，符合「不传 = 不干预」。

**(4) 缺陷 D1（手动脉络）** —— 见第 5 节。

### D. 自动降档（lib/reasoning.js + lib/index.js）—— 通过（瑕疵 D2/D4）

**(1) 判定顺序**：`planReasoningEffort`（`lib/reasoning.js:177-222`）逐支实跑：
- `manual='high'` 且模型声明含 high → `{effort:'high', source:'manual'}`，无 warn（`lib/reasoning.js:199`）；**手动值确实压过自动档**。
- `manual=''`（未指定）→ `{effort:'off', source:'auto'}` = `efforts[0]`（`lib/reasoning.js:216`）。
- `manual='high'` 但模型只有 `off/low` → warn `dsh-ace: 配置的思考档位 high 不在模型 p/m 声明的档位集里（off/low），已丢弃`，回落 `{effort:'off', source:'auto'}` 并带 `reason`（`lib/reasoning.js:195-197`）。
- `auto=false` 且无 manual → `{effort:null, source:'none', reason:'ace: 自动降档已关闭'}`（`lib/reasoning.js:221`）。
顺序判据：先手动（`:192-201`）→ 再自动（`:203-219`）→ 最后「关掉自动」（`:221`）。**实测按序**。

**(2) 查档失败/超时永不抛**：`queryModelEfforts`（`lib/reasoning.js:121-155`）整块包 try/catch，`AbortSignal.timeout(15000)`（`:139`）+ 独立硬计时 `withinMs(timeoutMs+1000)` 兜底（`:141-145`），失败只回 `{ok:false,error}`。实跑：宿主 `resolveModelInfo` 抛 `LlmError: 认不出` → 回 `{ok:false}`；`timeoutMs:20` 的超时 → 回 `{ok:false}` 且 `AbortSignal.aborted === true`；两条路径**都没有抛出**。

**(3) 两个闸都落 warn 且不干预**：
- `noReasoning` / `noEfforts`（模型没声明 reasoning 或 efforts 为空）→ `lib/reasoning.js:208-211`，warn `dsh-ace: 模型 p/m 未提供思考档位信息，不自动降档`，`{effort:null, source:'none'}`；
- 只一档 → `lib/reasoning.js:212-215`，warn `dsh-ace: 模型 p/m 只声明了一个思考档位（high），不自动降档`，`{effort:null, source:'none'}`。
两条均实跑命中，**都是 warn 而非静默、都不下发档位**。

**(4) 缓存只在进程内存、不落盘**：`lib/reasoning.js:41` `const effortCache = new Map();`；**全文件零 import**（`import`/`require`/`node:fs`/`node:os`/`node:path` 的 grep 结果为空数组）→ 结构上不可能落盘。TTL：成功 10min（`:34`）、失败 60s（`:36`），上限 128 条整表 clear（`:38`、`:152`），`refresh:true` 绕缓存（`:134`；超时重试用的就是它，`lib/index.js:1583-1590`）。

**(5) 接线**（lib/index.js）：`:1140` `observedSessionRoute`；`:1141-1150` `effortWarned` + `warnEffortOnce`（同 provider/model/文案每进程一条，≥64 条清空，回调内 try/catch）；`:1152-1156` `autoDowngradeOn`（默认**开**，仅 `false` / `'false'` 关）；`:1161-1172` `effortPlanFor`；`:1185-1188` pre-step 记录会话路由（try/catch 绝不抛）；`:1573-1579` `reflectRound` 包装（显式传了档位就直接用）；`:1595-1608` `mergeAsk` 同口径；`:1741` 手动 `ace_reflect`。

### E. 超时降档重试（lib/recap-pipeline.js）—— 通过

**(1) 只在超时时重试**：`lib/recap-pipeline.js:238` `if (!isTimeoutError(error)) throw error;` 是重试的唯一入口闸；其后 `:239`「无 `deps.downgradeEffort` → 上抛」、`:241`「`lower` 非非空字符串 → 上抛」。**普通错误、解析失败、路由失败一律不重试**（M4 变异实证：删掉 `:238` 这行，用例立即报「普通错误不许重试：2」）。

**(2) 恰好一次、结构上不能叠第二次**：重试是 catch 块内的**一次性 `return await`**（`lib/recap-pipeline.js:249`）：
- `callRound`（`:217-251`）内**没有 for/while、没有重试计数器**；
- 重试那次若再抛错，异常直接穿出 `callRound`，**没有第二层 catch 接住** → 结构上不可能出现第三次调用。
反证：M5 人为把 `:249` 包成 try/catch 再调一次 → 用例报「共 3 次调用：4」转红 —— 证明该用例确实钉着「恰好一次」。

**(3) 重试仍失败时候选照常落盘**：`lib/reflect.js:63-65`，`callRound` 抛错时 `if (collected.length || isTimeoutError(error))` → `return {candidates: collected, rounds: round-1, converged:false, aborted:true}`；**只有** `collected` 为空**且**非超时（`:67`）才原样上抛。故「第 2/3 轮降档重试仍超时」→ 前面轮次的候选原样落盘（R50-8(b) 实测 `success` 且落 1 条候选）。第 1 轮超时重试仍失败 → 因 `isTimeoutError` 为真也走收尾分支，0 条候选 → `lib/recap-pipeline.js:264` 起的 0 候选分支走 `commitCapacity`（腾位，不是假成功）。

**(4) 第一轮无预算绝不空手假成功**，`lib/recap-pipeline.js:222-229`：

```js
const maxMs = budget.sliceFor(mergeReserveMs + MERGE_COMMIT_RESERVE_MS);
if (budget.enabled && !(maxMs >= MERGE_MIN_CALL_MS)) {
  if (priorCandidates.length > 0) { throw new Error('ace: LLM 调用超时（复盘剩余预算不足 …ms，要留给合并与落盘），第 R 轮不再发起'); }
  return deps.reflectRound({ … 无 maxMs … });
}
```

即「预算再紧，第一轮照发、且不派 `maxMs`」。用例 `tests/recap-pipeline.test.mjs:808-843` 守着（「第一轮永不拦」「第二轮预算见底抛前缀超时错、按已有候选落盘、日志含『第 2 轮不再发起』」），本人复跑通过。

### F. 测试守卫 —— 通过

**基线实测**：`719 tests / 718 pass / 0 fail / 1 skip`（`duration_ms 6408.7983`，还原后复跑 `7048.3244`），与 `AGENTS.md:90` 红线 20 声明的第 50 轮基线完全一致。skip 的那 1 条在基线里就存在（两次数跑均 1 skip）。

**变异自证 5 次**全部按「改生产代码 → 跑对应用例 → 确认转红 → 还原 → SHA256 复核 → 复跑全绿」执行，见第 4 节。

**覆盖面的一个缺口**（记在这里而不是缺陷，因为它不违反任何声明）：`noReasoning` / `noEfforts` 两个闸只有 `tests/r50-reasoning.test.mjs:229-230` 的 `decodeModelEfforts` **纯逻辑**断言，**没有端到端「模型未声明 reasoning → 宿主 options 无该键 + 一条 warn」的用例**；单独打坏这两闸不会被专条抓住（只会被别的断言连带）。本人已用直调 `planReasoningEffort` 补验了行为（见 D 节），行为本身正确。

### G. 红线 —— 部分通过

| 红线 | 判定 | 证据 |
| --- | --- | --- |
| 2 写入只能 `withExclusiveLock` + `writeFileAtomic`，先归档再手册 | **通过（未触碰）** | `git status` 里 `lib/commit.js`、`lib/archive-file.js`、`lib/playbook.js` **均未出现在改动清单**；既有写盘点 `lib/commit.js:227/:436/:544`、`lib/archive-file.js:128`、`lib/playbook.js:839` 全部走 `writeFileAtomic`（tmp+rename），`appendArchivedEntries` 顺序原样 |
| 5 无新 npm 依赖 | **通过** | `package.json` 的 peerDependencies 仍是 `@deepseek-ai/dsh-tools`、`dsh-llm`、`schemastery`（+ optional schemastery），`node_modules` 不存在；`lib/` 里裸包 import 仅 `lib/index.js:22/23/92` 三处，全是既有 peer；新文件 `lib/reasoning.js` **零 import** |
| 8 注入只追加进历史 | **通过（未触碰）** | `lib/inject-delivery.js` **不在改动清单**；`tests/inject-delivery.test.mjs` 只有 6 行改动，且只给 `selectInjection` 传 `{injectMinScoreIdfRatio:0, injectMinRelativeToTop:0}` 关门槛（两条目的夹具会被 4.0×IDF_MAX 整片挡空），**投递时序断言一条未改** |
| 9 可观测只内存 + 日志、不落盘 | **通过** | `git diff -U0 -- lib/` 中新增行含 `writeFile/appendFile/createWriteStream/fs.` 的 → **空集**。思考档位缓存为进程内 `Map`（`lib/reasoning.js:41`），零 fs 用法 |
| 9 语义（无新增落盘状态） | **通过** | `GET /api/dsh-ace/efforts` 是**只读路由**，不写任何文件；warn 走 `ctx.logger` |
| 20 基线与实测一致 | **通过** | 声明 719/718/1，实测 719/718/1 |
| AGENTS.md 红线条数 | **通过** | `AGENTS.md:71-90` 行首数字列表计数 = **20** |
| AGENTS.md 代码地图与实测一致 | **部分通过（D3）** | `lib/` 下 33 个 `.js` 中，`heat.js`、`inbox.js`、`injection-flow.js` 三者**没有独立表格行**；其中 **`lib/inbox.js` 在整个 AGENTS.md 里零次出现**（`heat.js` 在 `lib/inject.js` 行与红线 14 里有名；`injection-flow.js` 在 `lib/ledger.js` 行里并列提及）。三者都是第 33 轮之前的既有文件，**非本轮引入** |

## 3. 前端面（需求 3(d)(e) 的 UI 部分）—— 通过（仅代码级）

- 路由常量 `EFFORTS_ROUTE = '/api/dsh-ace/efforts'`（`client.js:24`）；读档位 `setEfforts`（`client.js:1538`）；展示按 `payload.effective.source` 分支（`client.js:1767-1773`）。
- 控件渲染 `client.js:1933-1967`：复用 `ModelPicker`（下拉/搜索）+ `Switch`；`:1945` 查不到档位或列表为空时 `disabled`；`:1963` 开关 `checked = state.value.autoReasoningDowngrade !== false`（默认开）；选择 → `commit('reflectReasoningEffort', id)`，清空 → `commit('', '')`（= 未手动指定）。**两种形态（手动指定 / 留空）都在**。
- 中英双语：`const zh = {`（`client.js:40`）、`const en = {`（`client.js:202`）；实测 zh 146 键 / en 153 键，**R50 的 12 个键在两侧都齐**（`fieldReasoningEffort`、`fieldReasoningEffortDesc`、`pickEffortPlaceholder`、`pickEffortClear`、`pickEffortSearch`、`pickNoMatchEffort`、`effortsFailed`、`effortsAutoNow`、`effortsNoneFallback`、`effortsStaleCleared`、`fieldAutoReasoningDowngrade`、`fieldAutoReasoningDowngradeDesc`）。只在 en 侧的 7 个键（`missing`×2、`unreadable`×2、`superseded`、`evicted`、`merged`）是归档原因/降级文案，与思考档位无关，非本轮引入。

`GET /api/dsh-ace/efforts` 真跑结果（真 `apply()` + 真 handler）：
- `GET ?provider=auto&model=glm` → 200 `{ok:true, provider:'auto', model:'glm', efforts:[off,low,high], defaultEffort:'high', effective:{effort:'off', source:'auto'}}`；
- `POST` → 405 `{error:'method not allowed'}`；
- 宿主 `resolveModelInfo` 抛错 → 200 `{ok:false, error:'ace: 查询思考档位失败（LlmError: 认不出）'}` + warn `dsh-ace: 无法读取思考档位（boom/x：…）`（**绝不 500**）；
- 无参数且无会话路由 → 200 `{ok:false, error:'ace: session model unknown'}`；
- 未登记模型 → 200 `{ok:false, error:'ace: 查询思考档位失败（unknown model）'}`。
实现位置 `lib/index.js:2249-2290`（405 在 `:2250`；回落 `observedSessionRoute` `:2253-2255`；结构化失败 `:2257`/`:2265`；`planReasoningEffort` `:2267-2272`；`effective` 形状 `:2280-2284`）。

## 4. 变异自证清单（5 条，全部已还原）

每次变异前记录 `sha256` 与字节数，还原后逐条复核 `RESTORED-OK`、无 `.bak` 残留，最后再跑一次全量 719/718/0/1。

变异前的生产文件指纹（sha256 前 16 位 / 字节）：`lib/reflect.js` `af18cb3c7f3ab5b0` / 4781；`lib/inject.js` `bd9daa90dd2cc69d` / 21249；`lib/llm.js` `a9e5b070719a683c` / 14023；`lib/recap-pipeline.js` `b4161ac1ec643752` / 25045。

| # | 变异点 | 改法 | 转红用例（实测输出摘要） | 还原后 |
| --- | --- | --- | --- | --- |
| **M1** | 超时判定 `lib/reflect.js:20` | `return message.startsWith(TIMEOUT_ERROR_PREFIX);` → `return false;` | **2 条转红**：R50-7（`tests/r50-reasoning.test.mjs:369`，断言 `:383`，报 `ace: 复盘失败（复盘失败（ace: LLM 调用超时（单次上限 150000ms）：The operation was aborted））`，`'error' !== 'success'`）、R50-8（`:391`，`第 2 轮：首发 + 降档重试一次，共 3 次调用：2`） | 46 pass / 0 fail（r50 + inject + llm-budget 三文件） |
| **M2** | 门槛算式 `lib/inject.js:74` 之前 | 插入 `return 0; // MUTATION-M2` | **3 条转红**：`tests/inject.test.mjs:297`（算式与 N 口径）、`:309`（零意图 → 0 条；关门槛时 3 条的对比）、`:357`（N=100 过 / N=150 挡）。**注意 `:329` 的热度用例在 M2 下仍绿**（floor=0 时 `minScore` 退化成 `0.6×topScore`，仍挡住 701/703）—— 该用例只守相对门槛那一半 | 23 pass / 0 fail |
| **M3** | 档位键无条件写 `lib/llm.js:124` | 整行改成 `options.reasoningEffort = reasoningEffort;` | **3 条转红**：R50-4（`:288`，`关掉自动降档后不许再发 reasoningEffort`）、R50-5（`:313`，`只有一档时发出去等于没改，必须不干预`）、R50-6（`:329`，严格相等失败） | 23 pass / 0 fail |
| **M4** | 删超时闸 `lib/recap-pipeline.js:238` | 整行删 `if (!isTimeoutError(error)) throw error;` | 1 条转红：R50-8，`普通错误不许重试：2`（证明「普通错误不重试」被钉住） | 11 pass / 0 fail |
| **M5** | 结构上叠第二次重试 `lib/recap-pipeline.js:249` | 把一次性 `return await` 包成 try/catch 再调一次 | 1 条转红：R50-8，`第 2 轮：首发 + 降档重试一次，共 3 次调用：4`（证明「恰好一次」被钉住） | 11 pass / 0 fail |

## 5. 真实缺陷列表

### D1（重要）手动脉络把「本层单次超时」说成「调用方取消」，且 `isTimeoutError` 认不出

- 位置：`lib/index.js:1742-1748` 的 `oneShot(ctx, {...})` **不传 `signal`**（`:1741` 的 `effort` 是档位，不是 signal）。
- 机制：`lib/llm.js:169` 的判据是 `signal ? signal.aborted : callSignal.aborted`；没有调用方 `signal` 时退化成 `callSignal.aborted`，而 `callSignal` 是本层自己 `AbortSignal.any` merge 进来的（`lib/llm.js:72-85`、`:131`），本层 cap 到点时它必然已 abort → 走进 `:169-173` 的「调用方取消」分支。
- 实测（`ACE_ONESHOT_TIMEOUT_MS=60`，假 `context.llm.stream` 等到 `signal` abort 后 yield `{type:'finish', reason:{kind:'aborted'}}`，调 `oneShot(ctx, {provider, model, system, userText})` 不传 signal）：`msg = ace: LLM 调用被取消（调用方信号已中止、已收正文 0 字符、reasoning 0 字符、耗时 62ms、p/m、单次上限 60ms）`，`isTimeoutError(msg) === false`。
- 影响：(a) 文案把「本层超时」导向「调用方取消」，与第 49 轮「错误语义不许伪装」的诉求反向；(b) 手动复盘超时因此不走 `lib/reflect.js:63` 的「按已提炼候选收尾」分支，整份失败上抛（手动路径本无重试与采集，**不是行为回归**，但语义与自动路径不一致）。
- **自动复盘不受影响**：`lib/index.js:1296` / `:1379` / `:2020` 的 `run: async (signal, budget) => executeRecap({... signal ...})` 一路把队列 signal 传到 `reflectRound`（`:1497`）→`oneShot`；实测 `cap fires, caller alive` 得 `ace: LLM 调用超时（单次上限 60ms）：…`、`timeout = true`。
- 最小复现：上述探测脚本即最小复现（60ms cap + **不传 signal** + aborted finish 块），不需要真实 LLM。

### D2（轻微）非法档位名被静默丢弃，不落 warn

- 位置：`lib/reasoning.js:193-194`（`want === undefined` 分支只设 `droppedManual`，**不调 `note`**）；对照 `:195-197`（「未在模型声明集」分支是**有** warn 的）。
- 实测：`manual='HIGH!'` → `{effort:'off', source:'auto', reason:'ace: 配置的思考档位不在合法档位集里'}`，warn 回调**一次都没被调用**。
- 为什么算轻微：正常入口（POST）会把非法值 400 掉（`lib/index.js:2402-2414`），要走到这条分支得手工改设置文件或老版本残留值。但「丢弃一个用户指定的值而不留痕」与需求 3(c)「不干预并落日志」的精神有出入。
- 最小复现：`planReasoningEffort({ manual:'HIGH!', auto:true, info:{ok:true, efforts:[{id:'off'},{id:'high'}]}, warn: fn })` → `fn` 未被调用。

### D3（文档）AGENTS.md 代码地图缺 `lib/inbox.js`

- 实测：`lib/` 33 个 `.js` 中 `heat.js`、`inbox.js`、`injection-flow.js` 无独立表格行；`inbox.js` 在整个 `AGENTS.md` 里**零次出现**（另两个至少被别处提到）。
- 属既有缺口（三个文件都是第 33 轮之前的），**非本轮引入**；但它使「AGENTS.md 代码地图 == 实测文件清单」这条验收不成立。
- 最小复现：`node -e "const a=require('fs').readFileSync('AGENTS.md','utf8'); console.log(a.includes('inbox.js'))"` → `false`。

### D4（很轻）`decodeModelEfforts` 在 `defaultEffort` 缺失时回落**最强**档

- 位置：`lib/reasoning.js:97-100` 一带，`defaultEffort` 缺失/不合法时回落到 `efforts[efforts.length - 1]`；而 `efforts` 由弱到强排序（同文件头注），故回落值是**最强档**，非宿主默认语义。
- 为什么很轻：全仓只有 `client.js:1767-1773` 按 `payload.effective.source` 显示，**不读 `defaultEffort`**；选档走 `planReasoningEffort`（用 `efforts[0]`），与该字段无关。不影响任何判定，只在 `GET /efforts` 报文里可能给出一个语义上不准确的 `defaultEffort`。

## 6. 不确定 / 无法验证的事项（明确列出）

1. **真实 provider 下的 finish reason 分布**：全部用假 `stream` 构造 finish 块，未跑真实 LLM（任务明令禁止）。宿主 `mapStopReason` 已读源码（`...dsh-llm-pi-ai\lib\index.js:1645`），但「真实 provider 静默超时时宿主到底先抛错还是先给 aborted finish 块」只能线上观察 —— 这直接决定 D1 在线上是否显形，以及 `lib/llm.js:154-161` 那条 catch 改写分支的实际命中率。
2. **GUI 里的真实渲染效果**：只核了 `client.js` 的控件代码与中英键集合，**没有在浏览器里打开设置页看**下拉/开关的实际外观与交互（本会话无浏览器工具）。「中英双语齐全」「两种形态都能选」在代码与键集合上成立，像素级呈现未验证。
3. **并发面**：本轮新增的 `effortCache` 是进程内 `Map`，多进程（多 DSH 实例）不共享、也不互相污染 —— 这是设计意图，但「同一模型在两个进程里一个查到一个查不到」的时序未实测。
4. **`ONESHOT_TIMEOUT_MS=150000` 与队列 `RECAP_TOTAL_DEADLINE_MS=300000`（`lib/recap-queue.js:40`）的配套关系**：单次 150s × 最多 3 轮 + 合并预留 40s + 落盘 8s 理论上会超过总时限 300s，此时靠 `signal.throwIfAborted`（`lib/recap-pipeline.js:204`）与预算闸收尾。**这条路径只读了代码与既有用例，没有用真时钟跑到 300s 边界**（跑一次要 5 分钟且会污染时序）。
5. **跳过的 1 条用例**：`node --test` 报 `skipped 1`，未逐条确认它 skip 的原因是否与本轮改动相关（它在基线里就存在，两次数跑均 1 skip）。
6. **`lib/prompts.js` 第 49 轮的截断回收**（`recoverCandidatesFromUnclosed`，`lib/prompts.js:335`）：读了函数与用例、跑了全量，但**没有单独构造一份真实形态的超长 Reflector 输出**做端到端「截断 → 回收 N 条」实测；这条（需求 2 的「被截断时回收已完整候选」）目前证据来自 `tests/prompts-salvage.test.mjs` 通过，而非我自己的构造。

## 7. 附：关键命令与数字

```
node --test tests/                       # 719 tests / 718 pass / 0 fail / 1 skip / 6.41s（还原后复跑 7.05s）
node --test tests/r50-reasoning.test.mjs # 11 pass（M4/M5 还原后）
node --test tests/inject.test.mjs        # 23 pass（M2 还原后）
node --test tests/r50-reasoning.test.mjs tests/inject.test.mjs tests/llm-budget.test.mjs  # 46 pass（M1 还原后）
```

所有跨模块实证脚本都是临时文件，跑完即删；`DSH_HOME`/`DSH_PROFILE_DIR` 一律指 `os.tmpdir()` 下的临时目录，**未向用户真实 `~/.dsh` 写入任何东西**，**未读写生产手册 `C:\Users\adkun\.dsh\ace\playbook.md` 与 `archive.md`**。
