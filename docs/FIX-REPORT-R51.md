# dsh-ace 第 51 轮施工报告（三个已坐实小缺陷：D1 手动复盘超时误报 / D2 非法档位静默 / D3 代码地图缺 inbox）

施工轮次：第 51 轮 | 仓库：D:\dsh\plugins\dsh-ace | 范围：只修 D1/D2/D3；不动 D4，不动 lib/commit.js / lib/archive-file.js / lib/playbook.js / lib/inject-delivery.js / package.json / 生产手册 | 基线（AGENTS.md:90 第 50 轮记录）= 719 tests / 718 pass / 0 fail / 1 skip | 本轮结果（三次实测）= 723 tests / 722 pass / 0 fail / 1 skip，EXIT 0，6495.7749ms / 6540.2657ms / 6855ms

> 宿主事实出处沿用 checkout `~` = `C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai`，逐条写在各处代码注释里（红线 4）。本轮没有发任何真实 LLM 网络请求，全部用假 stream 夹具。

---

## 0. 改动清单（新增/修改与任务一致）

| 文件（绝对路径） | 本轮改动位置 | 本轮增量 |
| --- | --- | --- |
| `D:\dsh\plugins\dsh-ace\lib\index.js` | `:1748-1762` | +15 行（14 行中文注释 + 一行 `signal: exec && exec.signal,`） |
| `D:\dsh\plugins\dsh-ace\lib\reasoning.js` | `:194-198` | +4 行（3 行中文注释 + 一行 `note(...)`） |
| `D:\dsh\plugins\dsh-ace\AGENTS.md` | `:52`、`:53`、`:54` | +3 行（lib/heat.js、lib/injection-flow.js、lib/inbox.js 各一行，插在 `lib/stats.js` 行之前；既有各行一字未改） |
| `D:\dsh\plugins\dsh-ace\tests\r51-manual-reflect.test.mjs` | 新文件 204 行 | 新增，4 条用例（`:118` / `:146` / `:174` / `:192`） |
| `D:\dsh\plugins\dsh-ace\FIX-REPORT-R51.md` | 新文件 | 新增（本文件） |

**没有碰**：`lib/commit.js`、`lib/archive-file.js`、`lib/playbook.js`、`lib/inject-delivery.js`、`package.json`、`lib/inject.js`（门槛未动）、`lib/playbook.js` 的 BM25（未动）、`C:\Users\adkun\.dsh\ace\playbook.md`（未读未写）、`C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml`、`client.js`（D4 只写判断、未改代码）。也没有做任何 git commit / push / 分支操作。

**关于 `git diff --stat` 的两个数字**：`AGENTS.md 9 insertions / 5 deletions` 与 `lib/index.js 255 insertions / 9 deletions` 都是**相对 HEAD 的累计未提交 diff**（工作树里本来压着 R48/R49/R50 的大量未提交内容）。本轮真正贡献的只有上表那 15 / 4 / 3 行；`AGENTS.md` 的 5 行删除与 `lib/index.js` 的 9 行删除全部来自既有 R50 未提交内容，与本轮无关 —— `git diff -U0 -- AGENTS.md` 里本轮只出现在 `@@ -50,0 +52,3 @@` 这一个纯新增、无删除的 hunk。全仓累计：26 files changed, 1392 insertions(+), 130 deletions(-)。

---

## D1（重要）手动 `ace_reflect` 的单次上限到点被误报成「调用被取消」

**现象**：手动复盘时本层单次上限（`ONESHOT_TIMEOUT_MS`，默认 150000）到点，工具报出的错误是「ace: LLM 调用被取消（调用方信号已中止、…）」，不是「ace: LLM 调用超时（单次上限 Nms）」。后果：`lib\reflect.js:17-21` 的 `isTimeoutError` 认不出它（判据是 `message.startsWith('ace: LLM 调用超时')`，`TIMEOUT_ERROR_PREFIX` 在 `:17`），超时豁免失效 —— 自动复盘里「预算用完、按已提炼候选收尾」这条路对手动复盘完全不通。

**根因**：宿主 `ToolExecutionInput` 带 `readonly signal: AbortSignal`（`~\dsh-tools\lib\types\index.d.ts:241`，接口 `:216-242`；实参来源 `~\dsh-tools\lib\index.js:1368-1377` 的 `signal: runController.signal`）。手动 `ace_reflect` 的 `async execute(args, exec)`（`lib\index.js:1734`）从来没把这个信号传给 `oneShot`。而 `oneShot` 靠它区分两种 `finish{kind:'aborted'}`：

```js
// lib\llm.js:169（本轮未改这一行）
if (finishKind === 'aborted' && (signal ? signal.aborted : callSignal.aborted)) { … 'ace: LLM 调用被取消（调用方信号已中止、…' }
```

`signal` 为 `undefined` 时三元退化成「`callSignal` 已 abort」，而 `callSignal = mergeSignals(signal, capMs)`（`lib\llm.js:130`）在本层 cap 到点时**必然**已 abort ⇒ 判据恒真 ⇒ 超时被报成取消。宿主侧两种中止都只产生 `kind:'aborted'`（VERIFY-REPORT-R50.md:104，宿主出处 `~\dsh-llm-pi-ai\lib\index.js:1645` 与 `:1990`），所以「调用方 signal 自己是否已中止」是插件手里唯一的区分依据。

自动复盘路径不受影响：`lib\index.js:1491` 的 `reflectRound({ …, signal, … })` 在 `:1497` 已经透传，`signal` 由 `lib\recap-queue.js` 的 AbortController 提供。这也解释了为什么只有手动路径翻车。

**改法**（`lib\index.js:1748-1762`）：在 `oneShot(ctx, {…})` 的参数对象里加最后一项

```js
signal: exec && exec.signal,
```

- 前置 14 行中文注释写清三件事：宿主出处（`dsh-tools lib/types/index.d.ts:241`，信号所有权归调用方，插件只是借用）；为什么必须传（`lib/llm.js:169` 的判据 + `lib/reflect.js:17-21` 的豁免 + 不透传时的退化后果）；为什么写成 `exec && exec.signal`（显式防御）。
- 显式防御的三个事实：exec 可能整个是 `undefined`（`lib\index.js:502-513` 的 `makeResolver` 就用同款写法 `exec && exec.agent`）；exec 可能没有 `signal`（`tests\wiring.test.mjs` 的 R48-F3 直调 `tool.execute({summary}, {agent: state.agent})`，不传 signal）；`lib/llm.js:72-85` 的 `mergeSignals` 在 `:74` 对 `!signal` 有专门分支（`if (!signal) return timeout;`），`undefined` 精确落回「只有本地上限」的旧行为，不可能因这一行引入新失败。
- 同文件另外两处 `oneShot` 调用（`:1492` 自动复盘、`:1599` 合并）本来就有 signal（`:1497`、`:1604`），本轮一个字没动。

**证据（两条新用例，均已跑绿）**

| 用例（file:line） | 造现场的方式 | 断言要点 |
| --- | --- | --- |
| `tests\r51-manual-reflect.test.mjs:118` `R51-D1a｜手动 ace_reflect：本层单次上限到点 → 报「ace: LLM 调用超时」且 isTimeoutError 为 true` | `ACE_ONESHOT_TIMEOUT_MS='60'` 压本层 cap；调用方**不**取消；假 stream 先 yield 半条正文 `{"candidates":[`，再 `await waitForAbort(options.signal)` 等 cap 把合并信号 abort，然后 yield `{type:'finish', reason:{kind:'aborted', failure:{message:'pi-ai stream aborted', code:'ABORTED'}}}` | `llmCalls.length===1`（不许重试）；`message.startsWith(reflect.TIMEOUT_ERROR_PREFIX)`；`reflect.isTimeoutError(err)===true`；文案仍含 `单次上限 60ms` / `已收正文` / `r51-provider/r51-model` |
| `tests\r51-manual-reflect.test.mjs:146` `R51-D1b｜手动 ace_reflect：调用方 signal 已中止 → 报「ace: LLM 调用被取消」且 isTimeoutError 为 false` | 调用方 AbortController 先 `abort()` 再传 `exec.signal`；假 stream 进流第一行记录 `options.signal ? options.signal.aborted : 'no-signal'`（这就是「有没有透传」的探针） | 探针 `=== true`；`isTimeoutError(err)===false`；`startsWith('ace: LLM 调用被取消')`；含 `调用方信号已中止` |

改前实测（未改源码时）：两条全红 —— D1a 红在 `startsWith` / `isTimeoutError`（真实报文就是「ace: LLM 调用被取消（…单次上限 60ms）」），D1b 红在探针为 `false`（`tests\r51-manual-reflect.test.mjs:167`，`false !== true`）。

---

## D2（轻微）非法手动档位名静默丢弃、日志里一个字都没有

**现象**：用户在设置页把「思考档位」填成 `HIGH!` 这类非法值，插件确实丢弃了它并回落到自动档（返回对象的 `reason` 字段写着 `'ace: 配置的思考档位不在合法档位集里'`），但**日志里一条 warn 都没有**，用户无从排查为什么填了不生效。

**根因**：`lib\reasoning.js` 的 `planReasoningEffort` 手动值有三支（`:192-201`）：`want === undefined` 支（`validReasoningEffort` 判非法，`HIGH!` 落在这里）、「不在模型声明集里」支、手动生效支。后者（`:199-201`）有 `note(...)`；而 `want === undefined` 支（`:193-198`）只设 `droppedManual` 字段、**没有 note**。`note` 是调用方唯一能看到的口子：`lib/index.js:1169` 把它接到 `warnEffortOnce(provider, model, text)`（`:1141-1150`，同模型同句每进程一条、满 64 条清表）→ `ctx.logger?.warn?`。

**改法**（`lib\reasoning.js:194-198`）：补 3 行注释 + 一行 warn

```js
note('dsh-ace: 配置的思考档位 ' + manual.trim() + ' 不在合法档位集里（' + REASONING_EFFORT_IDS.join('/') + '），已丢弃');
```

- 带用户填的**原值**（`manual.trim()`，不转小写、不做归一），排查时能直接对上他填的那串。
- 合法值清单取 `REASONING_EFFORT_IDS`（`lib\reasoning.js:29` = `['off','minimal','low','medium','high','xhigh','max']`），不手写第二份。
- 文案风格与 `:201`「不在模型声明集里」那一支一致：`dsh-ace: ` 前缀 + 「不在…集里（清单），已丢弃」。
- `droppedManual` 的既有文案一个字未变（`'ace: 配置的思考档位不在合法档位集里'`）—— 它是 `plan.reason` 的来源，被 `tests/r50-reasoning.test.mjs` 和设置页读着，不许动。`note` 本身已包 try/catch（`:182`），warn 抛错也不会带崩判档。

**证据**：`tests\r51-manual-reflect.test.mjs:174` `R51-D2｜planReasoningEffort 手动档位非法（HIGH!）：落一条带原值的中文 warn，auto 照常回落最低档` —— 纯单元调用（`manual:'HIGH!'`、`auto:true`、`info:{ok:true, provider:'p', model:'m', efforts:[{id:'low'},{id:'high'}]}`），断言 `warns.length===1`（改前是 0）、`startsWith('dsh-ace: ')`、含 `HIGH!`、含 `REASONING_EFFORT_IDS.join('/')`、含 `已丢弃`、`plan.effort==='low'`、`plan.source==='auto'`、`plan.reason` 与改前一字不差。改前实测：红在 `0 !== 1`（`tests\r51-manual-reflect.test.mjs:182`）。

---

## D3（文档）AGENTS.md 代码地图缺 `lib/inbox.js`（以及 heat.js / injection-flow.js）

**现象**：`lib/inbox.js`（67 行，头注写着 `INBOX_CAP=20`）在 `AGENTS.md` 全文**零次出现**；`lib/heat.js` 与 `lib/injection-flow.js` 也没有独立表格行（前者完全缺席，后者只在 `:51` 的合并行 `| lib/ledger.js / lib/injection-flow.js |` 里露过名字）。新 agent 进仓库读代码地图时，这三块是黑洞。

**根因**：第 28 轮新增 `lib/injection-flow.js`、第 36 轮新增 `lib/heat.js` 时没补独立行；`lib/inbox.js` 从来没进过地图。纯文档欠账，不是代码缺陷。

**改法**（`AGENTS.md:52-54`，插在 `lib/stats.js` 行之前，**只增不改**）。三行内容全部从源码头注与导出核对过，不是猜的：

| 新增行 | 职责要点 |
| --- | --- |
| `AGENTS.md:52` `lib/heat.js` | `HEAT_WINDOW_MESSAGES = 30` / `HEAT_TOP_PER_MESSAGE = 3`；`createHeatWindow()` 按 agent 用 `WeakMap` 存环形窗口（`note` / `messagesOf` 返回副本 / `clear`；宿主重启即清空、不落盘）；`computeHeat(...)` → `Map<id, 计数>`，每条历史用户消息调一次 `rankInjection` 取 top3 各 +1，**调它时绝不传 heat**（否则热度自我强化）；热度只喂 `lib/inject.js` 排序键那 0.1 权重，绝不把 `score <= 0` 顶进候选、绝不写进 `hits`；依赖方向 `lib/inject.js` ← `lib/heat.js` |
| `AGENTS.md:53` `lib/injection-flow.js` | `createInjectionFlow({cache, ledger})` 内部 `delivered` WeakMap：`publish` → `agent/pre-step` 投递时 `take(agent)` 认领（同一批第二次返回 `null`，否则后续每一步都重复追加、凭空多记一次 `hits`）→ `note(agent, ids)` 是账本**唯一**写入点（`isMainAgent` 门）；为什么单独一层 = `tests/wiring.test.mjs` 有源码级红线「`lib/index.js` 里不许出现 `ledger.note(`」；`reset(agent)` 已删除 |
| `AGENTS.md:54` `lib/inbox.js` | merge-inbox 暂存区（疑似重复候选），JSON 数组文件，位置与手册**同目录**（文件名 `merge-inbox`，由 `lib/index.js:943` 的 `inboxPath(file)` 从手册路径派生，不写死绝对路径）；`INBOX_CAP = 20`；`readInbox`（ENOENT → `[]`、JSON 非数组 → `[]`、其余错照抛）、`writeInboxAtomic`（`mkdir -p` + 复用 `lib/playbook.js` 的 `writeFileAtomic`，tmp+rename）、`addToInbox`（满则不 push、返回 `capped:true`）、`inboxFull`；**本文件不自己加锁**，调用侧用 `withExclusiveLock` 把「读 → 加 → 写回」整段包住；三处消费点 = `ace_curate` 落盘后写入（`lib/index.js:1941-1948`）/ `/ace review` 读它（`:1990-1991`）/ `GET /api/dsh-ace/inbox` 只读返回 `{items, full, cap}`（`:2141-2142`）；封顶的实际效果是 add 静默暂停；头注里「systemPrompt 给硬提醒」在生产路径上已不成立（红线 8 不许 section 文本随运行状态变化）；inbox 永不进注入、也永不进任何会话 |

既有的合并行 `| lib/ledger.js / lib/injection-flow.js |` 与其余各行**一个字都没改**：`git diff -U0 -- AGENTS.md` 里本轮只新增 `@@ -50,0 +52,3 @@` 这一个纯 `+` hunk（AGENTS.md 现为 93 行）。

**证据**：`tests\r51-manual-reflect.test.mjs:192` `R51-D3｜AGENTS.md 代码地图给 lib/inbox.js、lib/heat.js、lib/injection-flow.js 各留一行` —— 读 `AGENTS.md`，对三个文件名各按行前缀 `| ` + 反引号 + 名字 + 反引号 + ` |` 判定「有且有一整行」。改前实测：红在 `lib/inbox.js` 缺整行。这条用例把文档缺口变成可回归的断言：以后谁再新增 lib 文件忘了补地图，至少这三个名字不会静默回退。

---

## 变异自证表

手法：把改动改回去 → 跑对应用例转红 → 还原 → 复跑全绿。三处还原均以 SHA-256 逐文件核对结果为 `UNCHANGED`（index.js / reasoning.js / AGENTS.md 三份文件字节级一致）。

命令：`node --test tests/r51-manual-reflect.test.mjs`

| # | 变异动作 | exit | tests | pass | fail | 转红的用例 | 还原后 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 无（基线） | 0 | 4 | 4 | 0 | — | — |
| 1 | `lib\index.js:1762` 的 `signal: exec && exec.signal,` 换成 `/* MUTANT-1 */`（= 回到「不透传 exec.signal」） | **1** | 4 | 2 | **2** | `R51-D1a`、`R51-D1b` | exit 0，4/4 全绿 |
| 2 | `lib\reasoning.js:198` 的 `note('dsh-ace: 配置的思考档位 …` 改成 `void ('dsh-ace: 配置的思考档位 …`（= 删掉这条 warn） | **1** | 4 | 3 | **1** | `R51-D2` | exit 0，4/4 全绿 |
| 3 | 删掉 `AGENTS.md:54` 新插的 `lib/inbox.js` 整行（表格行，以反引号包住文件名开头） | **1** | 4 | 3 | **1** | `R51-D3` | exit 0，4/4 全绿 |
| ALL | 三处**同时**回退 | **1** | 4 | 0 | **4** | 四条全红 | exit 0，4/4 全绿 |

变异 1 的失败原文（改前真实报文，抄自失败输出）：

```
AssertionError: D1：本层上限到点必须带「ace: LLM 调用超时」前缀（改前是「调用被取消」）:
ace: LLM 调用被取消（调用方信号已中止、pi-ai stream aborted、code=ABORTED、已收正文 15 字符、
reasoning 0 字符、耗时 66ms、r51-provider/r51-model、单次上限 60ms）
```

—— 这就是缺陷本身：前缀是「被取消」，现场里却同时写着「单次上限 60ms」，`isTimeoutError` 因此为 false。

（弯路记录：第一次跑变异 1 时用 `Set-Content -Encoding utf8` 改文件，Windows PowerShell 5.1 给 `lib\index.js` 写进了 UTF-8 BOM，导致该模块 import 失败、只报「failing tests」而不报用例名。改用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)` 才得到上表的 `tests 4 / pass 2 / fail 2` 与逐条用例名。下一轮做变异实验别用 `Set-Content`。）

---

## 全量验收

| 项 | 实测 |
| --- | --- |
| `node --test tests/`（三次） | **tests 723 / pass 722 / fail 0 / skipped 1**，耗时 **6495.7749ms / 6540.2657ms / 6855ms**；三次 **EXIT 0** |
| 基线对照（AGENTS.md:90，第 50 轮） | 719 / 718 / 0 / 1 —— 本轮净增 4 条、fail 仍为 0、skip 数不变 |
| `node --check lib/index.js` | exit 0 |
| `node --check lib/reasoning.js` | exit 0 |
| `node --check tests/r51-manual-reflect.test.mjs` | exit 0 |

`git status --porcelain`（仓库根）：本轮只多出两个未跟踪文件 —— `tests/r51-manual-reflect.test.mjs`、`FIX-REPORT-R51.md`；其余 `M` 行（AGENTS.md / DESIGN.md / README.md / TESTING.md / client.js / lib/heat.js / lib/index.js / lib/inject.js / lib/llm.js / lib/prompts.js / lib/recap-pipeline.js / lib/recap-queue.js / lib/reflect.js + 13 个 tests 文件）与既有 `??`（FIX-REPORT-R49.md / FIX-REPORT-R50.md / VERIFY-REPORT-R50.md / lib/reasoning.js / tests/prompts-salvage.test.mjs / tests/r50-reasoning.test.mjs）全部是开工前就存在的未提交内容，本轮一律保持未提交。

`git diff --stat`（仓库根）：26 files changed, 1392 insertions(+), 130 deletions(-)；其中 `AGENTS.md | 14 ++++--`（9 insertions / 5 deletions，本轮只 +3 行）、`lib/index.js | 264 +++…`（255 insertions / 9 deletions，本轮只 +15 行），差额全为既有未提交内容。

---

## D4 判断（只写判断，代码未改，遵嘱）

`lib\reasoning.js:97-100`：`defaultEffort` 缺失/不合法时回落到 `efforts[efforts.length - 1]`，即**最强**档。我的判断：**不是行为缺陷，只是「展示字段的乐观默认」**，三条理由：

1. 没有决策路径读它。`planReasoningEffort` 判档位的输入只有 `manual` 与 `efforts[0]`（`:188` `low = efforts[0].id`）；`defaultEffort` 只是被原样带进返回对象（`:185`）→ `GET /api/dsh-ace/efforts` 的 payload（`lib\index.js:2293`）。
2. 消费端同样不读：`client.js` 里 `defaultEffort` **零次匹配**（grep 计数 0），设置页只读 `payload.effective.source` / `effective.effort` / `effective.reason`（`client.js:1767-1773`）。
3. 语义上它想回答「宿主自己会选哪档」，而宿主在 profile 写了 `reasoningEffort` 时会盖过模型默认档（`~\dsh-llm-pi-ai\lib\index.js:1953`，本机 `C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml:12` 写着 `high`）—— 插件从 `resolveModelInfo` 拿不到 profile 的值，任何回落都是猜；猜最强比猜最弱保守（不会悄悄把用户档位降下来），作为展示默认值可以接受。

**唯一潜在风险**：将来若有人把它渲染成「宿主默认档」给用户看，看到的就是错的值。真到那天，正确改法是回落成 `undefined`（不展示），而不是换一个档。**本轮按指示未改代码。**

---

## 未确认项（如实列出，均未验证成完成）

1. **真实宿主端到端未观测**：D1 的修复只在夹具里验证（`ctx.llm.stream` 是假 stream、`exec.signal` 是测试自造的 AbortController）。真实 GUI 里手动跑一次 `ace_reflect` 并让它撞上单次上限、或中途按停止，**没有实测**（任务明令不许发真实 LLM 网络调用）。宿主是否在每种中止场景下都真的把 `exec.signal` 填上，是读码结论（`~\dsh-tools\lib\index.js:1368-1377`），不是运行结论。
2. **宿主 `exec.signal` 在各入口上的形状未逐个核对**：`~\dsh-tools\lib\index.js` 里 `:1368-1377`（run_code 子调用，`signal: runController.signal`）、`:1508`、`:3557`（直传 `exec.signal`）是不同来源；本轮只确认了「类型上必有 `signal`」这一条（`index.d.ts:241` 注释 Required caller-owned cancellation），没有逐一验证每个工具入口都会填。即便某个入口不填，本插件写了 `exec && exec.signal` 防御，行为退回第 50 轮旧口径（超时误报成取消），不抛错、不崩。
3. **D2 的 warn 在真实设置页链路上的可见性**：单测只证明 `planReasoningEffort` 会调一次 `note`；`lib\index.js:1169` 把它接到 `warnEffortOnce` → `ctx.logger?.warn?`。这条 warn 会不会真的出现在宿主的日志面板里，**没有在 GUI 里看过**。
4. **D3 只是文档 + 一条样例断言**：没有任何机检能保证「以后新增 lib 文件一定补地图」。本轮只给这三个名字加了断言，其余文件仍靠自觉。
5. **`R51-D1a` 靠环境变量造现场**：`ACE_ONESHOT_TIMEOUT_MS='60'` 压本层上限。`lib/llm.js:57-66` 那三处 `return 150000;` 与 `tests/llm-budget.test.mjs:213-224` 的源码级计数断言本轮一条没动（未改 llm.js），全量里照常通过。
6. **临时目录清理未断言**：`tests\r51-manual-reflect.test.mjs` 把 `DSH_HOME` 指到 `os.tmpdir()` 下的独立目录，`test.after` 里 `rmSync` 清理，失败被 try/catch 吞掉。两次全量跑后未发现残留，但没写专门的清理断言。
