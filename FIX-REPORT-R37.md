# dsh-ace 第 37 轮施工报告

施工子代理：第 37 轮 | 仓库：D:\dsh\plugins\dsh-ace | 基线：node --test tests/ = 516 tests / 515 pass / 0 fail / 1 skip

> 本文件按任务顺序**边做边 append**，每节标「已完成 / 进行中」。最终结论摘要见最后一节。

---

## 任务 A：只读体检脚本 tools/diagnose.mjs —— 已完成

### 做了什么
- 新建 `D:\dsh\plugins\dsh-ace\tools\diagnose.mjs`（仓库此前没有 tools/ 目录）。
- 定位写进文件头注释：只给调度者诊断用，零 LLM、零写盘、只读；不进设置页、不进插件运行时。
- 只 import 纯逻辑模块：lib/playbook.js（parsePlaybook / scoreEntries）、lib/merge.js（computeMergeSuggestions / MERGE_THRESHOLD_RATIO）、lib/inject.js（estimateTokens）、lib/archive-file.js（parseArchiveFile / ARCHIVE_REASONS）、lib/settings-path.js（resolveSettingsFile）、lib/playbook-path.js（resolveSharedPlaybookFile / ARCHIVE_FILE_NAME / DEFAULT_MAX_ENTRIES）。**不 import lib/index.js**（那条链会拉 @deepseek-ai/* 宿主包）。
- 没有任何 lib/ 或 client.js import 它（`grep -r diagnose lib/ client.js` 空）。

### 五组判据与常量
| 组 | 判据 | 常量 |
| --- | --- | --- |
| ① 近重复配对 | 活跃条目两两之间的**对称 BM25 正文比率**（min(fwd,rev)，语料=整本活跃手册）>= 0.5，列 top 5（id + 标题 + 比率） | `NEAR_DUP_RATIO = MERGE_THRESHOLD_RATIO = 0.5` |
| ② 僵尸条目 | `hits === 0` 或 `lastHit` 距今 >= 60 天，列 top 5 | `ZOMBIE_STALE_DAYS = 60` |
| ③ 正文过短 | condition + action + rationale 合计字符数 < 80 的条数 | `SKELETON_BODY_CHARS = 80` |
| ④ 近 30 天 | created 在 30 天内新增条数；archive.md 里 date 在 30 天内的归档条数，按 reason 分列 | `RECENT_DAYS = 30` |
| ⑤ 容量 | 活跃条数 / maxEntries（设置文件读不到写「读不到，按默认 100 显示」） | `DEFAULT_MAX_ENTRIES = 100` |

### 关键实现决策
- **① 的配对不能复用 computeMergeSuggestions**：lib/merge.js:117 `if (!best || best.ratio < threshold) continue;` 每条新增只返回**最相似的那一条**，全量配对里第二、第三相似的对会被漏掉。于是自己写 `symmetricRatios(entries)` 做全量配对（算法与 lib/merge.js:70-84 的 bodyRatio 逐字同口径：fwd=score(b|a 正文)/selfScore(a)、rev=score(a|b 正文)/selfScore(b)、取 min 钳到 1），另提供 `bestMatchPairs` 用 computeMergeSuggestions 做**交叉校验**并在报告里打印对数。
- **归档同步读**：lib/archive-file.js:76 的 `readArchiveSnapshot` 是 async，同步脚本用不了，改用 `fs.readFileSync + parseArchiveFile`（:47，纯函数）。
- **读不到一律降级不崩**：手册不存在 → `手册文件读不到（ENOENT）：<path>`；手册空文件 → `手册是空文件（0 条条目）：<path>`；解析抛错 → `手册解析失败（msg）：<path>`。归档读不到只降级成一行说明（不影响手册体检）。设置文件读不到/JSON 坏/值非法 → 回落 100 并带 `读不到，按默认 100 显示`。
- 命令行 `--file` / `--today` / `--settings` / `--archive` / `--help`，支持 `--key=value` 与 `--key value` 两形态。

### 真跑一次（真实手册，只读；--today 2026-06-13）
（输出见下一节的原文；首次运行时 maxEntries 显示 100，因为 `resolveSettingsFile` 按 DSH_PROFILE_DIR → DSH_HOME → ~/.dsh 的链解析到 `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`，该文件里 maxEntries=100。）

### 遗留
- 尚未写 tests/diagnose.test.mjs（进行中）与变异自证。

### 真跑输出（真实手册，只读；`node tools/diagnose.mjs --today 2026-06-13`，exit 0）

```
dsh-ace 只读体检（零 LLM / 零写盘）
手册：C:\Users\adkun\.dsh\ace\playbook.md
归档：C:\Users\adkun\.dsh\ace\archive.md
日期口径：today = 2026-06-13

① 近重复配对（对称 BM25 正文比率 >= 0.5）：4 对
   · ace-225 板块查询别用自然语言名，改用东财板块代码或宽口径 listing  ↔  ace-227 给具体行业的板块数据按细分名本地模糊匹配   比率 76.7%
   · ace-222 行情类回答按时段声明数据口径  ↔  ace-228 盘中多次取数后回答要标注时点与数据口径   比率 68.6%
   · ace-223 行情结论下判断前先补齐涨跌停与连板梯队口径  ↔  ace-226 给「值得买入吗」类问题补个股层面数据再回答   比率 55.7%
   · ace-241 把「高分旧条目挤压新条目」类问题答成机制+可选方案清单  ↔  ace-247 回答「高分旧条目会不会挤掉新笔记」先读淘汰模块讲清结构性后果   比率 51.2%
   交叉校验（computeMergeSuggestions 的最佳匹配对）：4 对

② 僵尸条目（hits === 0，或 lastHit 距今 >= 60 天）：41 条
   · ace-217 判「第几轮才触发」要把宿主轮次计数和纯函数矩阵一起验   ← hits = 0（从未被命中）
   · ace-225 板块查询别用自然语言名，改用东财板块代码或宽口径 listing   ← hits = 0（从未被命中）
   · ace-230 GitHub API 大响应体先判长度再 parse，超限就换分段接口   ← hits = 0（从未被命中）
   · ace-233 盘点仓库目录规模遇到 50000 截断改用 git trees 非递归分层取   ← hits = 0（从未被命中）
   · ace-237 判断「它是不是 Agent」按层拆身份层/调度层/运行时   ← hits = 0（从未被命中）
   （另有 36 条未列出）

③ 正文过短（条件+做法+依据合计 < 80 字符）：0 条
   （没有过短条目）

④ 近 30 天：新增 0 条，归档 0 条
   归档按原因：superseded 0 / removed-by-request 0 / evicted 0 / merged 0

⑤ 容量：活跃 69 条 / maxEntries 100
   maxEntries 读数来自设置文件：C:\Users\adkun\.dsh\profiles\web\dsh-ace.json
   占用 69%；活跃条目正文合计约 19207 token（estimateTokens 估算）
```

说明：真实手册的 `maxEntries` 显示 100，是因为 `resolveSettingsFile` 的解析链是
profileContext → `$DSH_PROFILE_DIR` → `$DSH_HOME` → `~/.dsh`，本机命中 `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`，
该文件里 maxEntries=100（`C:\Users\adkun\.dsh\dsh-ace.json` 里的 200 属于 legacy 位置，本脚本按生产同款解析链读）。

### 用例（24 条，tests/diagnose.test.mjs）
| 用例 | 钉住什么 |
| --- | --- |
| A0｜判据常量 | 0.5 / 60 / 80 / 30 / top5 与生产同源 |
| A0｜日期工具 | dayOf / daysBetween 的边界与坏输入 |
| A0｜bodyChars | 只数 condition+action+rationale，标题不算 |
| A1｜近重复配对 | 0.5~0.75 之间的那一对也算（阈值是 0.5 不是 0.75）、不相干的不凑对、降序 |
| A1｜对称比率是对称的 | 正反两个方向算出来一致；不相干的一对低于阈值 |
| A1｜交叉校验 | bestMatchPairs 每对都过阈值、不许自己跟自己配 |
| A1｜空手册/只有一条 | 不崩 |
| A2｜僵尸条目 | hits=0 与 >=60 天都抓，59 天放过；边界 60 天算 |
| A2｜坏 lastHit | 只按 hits 判，ageDays 给 null 不是 NaN |
| A3｜正文过短 | <80 才算，恰好 80 放过 |
| A4｜近 30 天新增 | 边界 30 天算，31 天与未来不算 |
| A4｜近 30 天归档 | 四原因分列、超期与坏日期不计 |
| A5｜容量读得到 | 设置文件读到 42 就用 42，note 为空 |
| A5｜容量读不到 | 文件不存在/JSON 坏/值非法都回落 100 并给一句人话 |
| A6｜整链诊断 | 真手册+真归档+真设置跑出五组数字，**诊断前后目录内每个字节都没变**（零写盘实证） |
| A7｜渲染 | 五组都有一句人话+数字，top5 之外只报「另有 N 条」，容量点明设置文件路径 |
| A8｜手册不存在 | 一行人话带路径，不抛栈 |
| A8｜空文件/路径是目录 | 同样一句人话 |
| A8｜解析失败分支 | renderReport 的 ok:false 防御性分支只打一行 |
| A8｜归档读不到 | 不影响手册体检，只留一句说明 |
| A9｜命令行解析 | `--key value` 与 `--key=value` 两形态、可省略、--help |
| A9｜命令行真跑 | 捕获 stdout，五组数字与 top5 id 都在 |
| A10｜零写盘/零接线 | 源码里没有任何写盘调用；lib/*.js 与 client.js 都不 import 它 |
| A11｜本地日期口径 | localDayString 本地时区切日、补零 |

### 变异自证（任务 A）
见报告末尾的变异总表。

---

## 任务 C：注入块首行「最多 N 条」跟随运行时配置 —— 已完成

### 改了什么
| 位置 | 改前 | 改后 |
| --- | --- | --- |
| lib/inject.js:165 | `renderInjection(picked, { withRationale = false } = {})` | `renderInjection(picked, { withRationale = false, maxEntries } = {})` |
| lib/inject.js:168 | 无 | `const cap = Number(maxEntries) > 0 ? Math.floor(Number(maxEntries)) : INJECT_MAX_ENTRIES;` |
| lib/inject.js:169 | head 用硬编码 `INJECT_MAX_ENTRIES` | head 用 `cap` |
| lib/inject.js:208 / :212 / :213 | 预算试算、带 rationale 试算、最终渲染三处都没传上限 | 三处全部透传 `{ maxEntries }` |

- 回落口径：未传 / 传 0 / 传 NaN / 传负数 / 传非数字 → 回落 `INJECT_MAX_ENTRIES`(5)。宁可说「最多 5 条」，也不能说「最多 0 条」。
- `selectInjection`(:198) 的 `const maxEntries = Number(options.maxEntries) || INJECT_MAX_ENTRIES;` 一个字没动；生产链 lib/index.js:759 `maxEntries: injectMaxEntriesOf(live.injectMaxEntries)` 本来就把生效值传进来了，所以改完只影响「文案说不说真话」，不影响取几条。
- **保守选择**：没有把 `cap` 改成「`maxEntries` 与 `INJECT_MAX_ENTRIES` 取小」。理由是那会把「配置 8 → 实际只取 5」的猜测写进文案，属于改语义；本轮只让文案跟随生效配置。

### 用例（行为面，真跑代码路径）
| 用例 | 钉住什么 |
| --- | --- |
| tests/inject.test.mjs `C5.6｜首行「最多 N 条」说真话：maxEntries 传 8 就写 8，不传才回落默认 5（第 36 轮遗留）` | 8 条候选 + maxEntries=8 → count=8 且首行含「最多 8 条」、不含「最多 5 条」；maxEntries=3 同验；不传回落 5；直接调 `renderInjection` 传 12 → 「最多 12 条」，传 0 与 'x' 回落默认 |
| tests/inject.test.mjs `C5.5｜注入块格式…`（既有，加了一条断言） | 不传 maxEntries 时首行仍是「最多 5 条」（默认不回退成别的话） |
| tests/tuning-behaviors.test.mjs `配置行为②：injectMaxEntries 调小…`（既有，尾部加三条断言） | 真走 registerHooks + 真插件 + 真投递：`config: { injectMaxEntries: 8, injectTokenBudget: 4000 }` 时首行 `/最多 8 条/` 为真、全文 `/最多 5 条/` 为假 |

- 踩坑记录：`renderInjection` 的入参项形状是 `rankInjection` 产出的 `{ entry, i, score }`，不是裸 entry。第一版用例传裸 entry，只拿到「显式传入优先」那一行，断言报 AssertionError。

---

## 任务 B：复盘时「不满额也配对」—— 已完成

### 改了什么
| 文件 | 改动 |
| --- | --- |
| lib/merge-llm.js:37 / :40 | 新增 `export const MERGE_EAGER_THRESHOLD_RATIO = 0.75;` 与 `export const MERGE_EAGER_MAX_ROUNDS = 2;`（紧跟 `MERGE_MAX_ROUNDS = 5` 之后，带理由注释） |
| lib/recap-pipeline.js:29 | import 增补 `MERGE_EAGER_THRESHOLD_RATIO, MERGE_EAGER_MAX_ROUNDS` |
| lib/recap-pipeline.js:116 | `tryMerge(deps, { entries, signal, logger, date, thresholdRatio, maxRounds } = {})`：`maxRounds` 用 `Number.isFinite(Number(maxRounds)) ? maxRounds : MERGE_MAX_ROUNDS` 回落，`thresholdRatio` 透传给 `planMerges`。**不传就是满额路径的老行为（0.5 / MERGE_MAX_ROUNDS）**，满额分支一字未动 |
| lib/recap-pipeline.js:237-267 | 新增 `} else if (adds > 0) {` 轻量合并分支 |

### 为什么是 0.75 / 2 对（写进 lib/merge-llm.js 的常量注释）
- 满额（`projected > maxEntries`）是「非合不可」：不合就得淘汰，丢的是经验。所以阈值 0.5、最多 5 对，尽量多合。
- 不满额是「顺手清理」：不合也不丢任何东西，只是两条近重复经验会一直各花一份注入 token。所以判据必须更严——阈值 0.75、最多 2 对。
- 放宽阈值去「顺手清理」的代价是把不相干的经验硬并成一条：合并提示词是「两段正文 → 一条同构条目」，硬并＝语义污染，且被并掉的那条从此只躺在 archive.md 里再也不会被注入，**不可逆**。
- 只在 `adds > 0` 时跑：本轮没新增候选就说明手册没在长，为一次纯属「整理」的合并花一次 LLM 调用不划算。

### 落盘通道（与满额路径逐字同一套）
- 轻量合并产出的 `ops` / `moves` 走同一个 `mergeOps` / `mergeMoves` 变量，最终 `const ops = mergeOps.concat(finalOps)` → `commitOps(file, {entries}, ops, maxEntries, { archiveFile, merged: mergeMoves, ... })`。归档原因仍是 `merged`，「先写 archive.md 再写手册」的顺序由 commitOps 保证，轻量路径没有第二条落盘通道。
- 失败只 warn：`plan.failed.length` → `warn('dsh-ace: 轻量合并失败 N 对（a↔b:reason），跳过它们继续（绝不让复盘落盘失败）')`；成功 → `info('dsh-ace: 轻量合并（不满额）成功 N 对（archivedId→keptId）')`。`planMerges` 本身永不抛错，`tryMerge` 外层还有 catch 兜底。
- 0 候选分支（lib/recap-pipeline.js:171-197）**保持原样**，没给它加轻量合并（省调用，且 0 候选回合没有新增可「顺手清理」的语境）。

### 用例（5 条，tests/recap-pipeline.test.mjs，真跑整链 + 真 commitOps + 真 archive.md）
| 用例 | 钉住什么 |
| --- | --- |
| `e｜不满额也配对（第 37 轮 B）：adds>0 且两条几乎同文 → 轻量合并 1 对，另一条进归档 reason=merged` | maxEntries=60、只加 1 条（远未满额）仍合并：mergeAsk 恰好 1 次、asks[0] 点明 ace-001/ace-002、out.merged=1、保留 created 更早的 ace-001、hits=3+4=7、archive 里 ace-002 的 reason=merged 且 supersededBy=ace-001、日志含「轻量合并（不满额）成功」 |
| `e｜adds===0 不跑轻量合并：本轮候选与既有条目完全重复（被丢弃）→ mergeAsk 一次都不许调` | 候选 normKey 与 ace-001 完全相同 → 被丢弃 → adds=0 → mergeAsk 调用 0 次、两条原样留在活跃区 |
| `e｜阈值必须是 0.75 而不是满额的 0.5：中等相似（比率约 0.505）那对不许被轻量合并吃掉` | 比率实测 0.5050479223162428 的一对：满额阈值 0.5 会合，轻量阈值 0.75 不许合。mergeAsk 0 次、两条都在活跃区、正文一字未改、archive 为空 |
| `e｜轻量合并失败只 warn，绝不阻塞落盘（不满额路径照常写候选）` | mergeAsk 抛错 → out.merged=0 但 out.added=1（候选照常落盘）、日志含「轻量合并失败」且**不含**「合并阶段整体失败」、失败的那一对谁都没丢也没被改、archive 为空 |
| `e｜轻量合并最多 2 对（MERGE_EAGER_MAX_ROUNDS=2）：三对几乎同文时只合并两对` | 3 对近同文（6 条）：mergeAsk 恰好 2 次、out.merged=2、archive 里恰好 2 条 reason=merged、最终活跃 6-2+1=5 条 |

### 证据：阈值不是摆设
- `findMergePairs` 实测（同一对样本、两个阈值）：比率 1.0 的对在两个阈值下都被选；比率 0.5050479223162428 的对在 0.5 下被选、在 0.75 下**不被选**。所以上面第三条用例能真正把「轻量阈值=0.75」钉住——把常量改回 0.5，它就变红。

---

## 变异自证总表（每个任务至少 1 个变异；每次变异都改坏生产代码 → 跑全量 node --test tests/ → 记录红灯 → 改回）

改回后全量复跑：**tests 546 / pass 545 / fail 0 / skipped 1 / duration_ms 5110.1361**（基线 516，净增 30 条）。

| # | 任务 | 变异（改了什么） | 红了几条 | 变红的用例名 |
| --- | --- | --- | --- | --- |
| A1 | A | `tools/diagnose.mjs` `NEAR_DUP_RATIO = MERGE_THRESHOLD_RATIO` → `0.75` | 4 | `A0｜判据常量…`、`A1｜近重复配对：对称 BM25 比率 >= 0.5 的对都算，且 0.5~0.75 之间的那一对也算（阈值不是 0.75）`、`A6｜整链诊断…`、`A9｜命令行真跑…` |
| A2 | A | `ZOMBIE_STALE_DAYS = 60` → `30` | 2 | `A0｜判据常量…`、`A2｜僵尸条目：hits===0 与 lastHit 距今 >= 60 天都算；59 天、最近命中过的都不算` |
| A3 | A | `SKELETON_BODY_CHARS = 80` → `120` | 2（**补强前只有 1**） | 补强前：`A0｜判据常量…`；补强后：+`A3｜正文过短：condition+action+rationale 合计 < 80 才算，恰好 80 的放过` |
| C1 | C | `lib/inject.js` `const cap = Number(maxEntries) > 0 ? … : INJECT_MAX_ENTRIES` → `const cap = INJECT_MAX_ENTRIES`（文案硬编码回默认值，＝第 36 轮的老 bug） | 2 | `C5.6｜首行「最多 N 条」说真话…（第 36 轮遗留）`、`配置行为②：injectMaxEntries 调小 → 注入条数真的变少（预算再宽也不超条数上限）` |
| C2 | C | `lib/inject.js` 最终渲染那行去掉 `maxEntries`（`renderInjection(picked, { withRationale })`），预算试算两处仍传 | 2 | 同 C1：`C5.6…`、`配置行为②…` |
| B1 | B | `lib/recap-pipeline.js` 轻量分支 `thresholdRatio: MERGE_EAGER_THRESHOLD_RATIO` → `0.5`（偷用满额阈值） | 1 | `e｜阈值必须是 0.75 而不是满额的 0.5：中等相似（比率约 0.505）那对不许被轻量合并吃掉` |
| B2 | B | `lib/recap-pipeline.js` `} else if (adds > 0) {` → `} else if (adds > 0 \|\| true) {`（没新增也跑轻量合并） | 1 | `e｜adds===0 不跑轻量合并：本轮候选与既有条目完全重复（被丢弃）→ mergeAsk 一次都不许调` |
| B3 | B | `lib/recap-pipeline.js` 轻量分支 `maxRounds: MERGE_EAGER_MAX_ROUNDS` → `MERGE_MAX_ROUNDS`（偷用满额轮数） | 1 | `e｜轻量合并最多 2 对（MERGE_EAGER_MAX_ROUNDS=2）：三对几乎同文时只合并两对` |
| B4 | B | `lib/recap-pipeline.js` 轻量分支 `mergeMoves = plan.moves` → `mergeMoves = []`（moves 不走落盘通道，归档里丢 merged 记录） | 2 | `e｜不满额也配对（第 37 轮 B）…归档 reason=merged`、`e｜轻量合并最多 2 对…` |

- 说明 1：A0 / C5.6 / 配置行为② / A3 之外的「只有它对」口径 —— A3 的补强见下条。
- 说明 2（**A3 的自我修正**）：A3 第一版全用常量自适应构造（`'x'.repeat(SKELETON_BODY_CHARS - '条件-ace-002'.length)`），把常量改成 120 时这条用例**自己跟着变形**、照样绿 —— 只有 A0 常量用例红。这等于没钉住字面值。已补一段写死长度的断言（79 / 80 / 81 字符，只有 79 算过短），补强后同一个变异红 2 条且 A3 在列。
- 说明 3：每次变异都在 `lib/` 或 `tools/` 里留了 `// MUTATION-*` 注释标记，全部改回后 `Get-ChildItem lib\*.js, client.js, tools\*.mjs | Select-String 'MUTATION'` 为空（已核，exit 0，无输出）。

---

## 验收数字（第 37 轮收尾复跑）

```
$ node --test tests/
ℹ tests 546
ℹ suites 0
ℹ pass 545
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 5110.1361
```

- 基线 516 tests / 515 pass / 0 fail / 1 skip → 现在 546 / 545 / 0 / 1，**净增 30 条**（任务 A 24 条 + 任务 B 5 条 + 任务 C 1 条），skip 仍为 1，fail 为 0。
- `node --check`：`lib/*.js`（30 个）+ `client.js` + `tools/diagnose.mjs` 共 **checked=32 bad=0**。
- 零新增 npm 依赖：`package.json` 的 dependencies 一个字没改（本轮只读它、没用 npm install）。

---

## 任务 D：偶发「517 tests / 1 fail」追查 —— 未复现（附 25 次逐次记录）

### 结论
**25 次连跑全部复现不出。** 15 次单跑 `tests/concurrency.test.mjs` + 10 次全量 `tests/`，每一次都是基线数字（单文件 6/6；全量 516/515/0/1），`not ok` 行一次都没出现过。

### 跑法与记录文件
- 驱动脚本：`C:\Users\adkun\AppData\Local\Temp\r37-flake.ps1`（PowerShell 字符串数组拼行，避开 TS 模板对反引号的吞吃），后台作业跑，`job_output` 收结果。
- 汇总日志：`C:\Users\adkun\AppData\Local\Temp\r37-d.log`。
- 每次的原始输出单独落盘：`C:\Users\adkun\AppData\Local\Temp\r37-p1-{1..15}.txt`（PHASE 1）、`C:\Users\adkun\AppData\Local\Temp\r37-p2-{1..10}.txt`（PHASE 2）。
- 采集口径：每次跑完从 `ℹ tests/pass/fail/skipped` 提数字，并单独抓所有 `^✖` / `not ok` 行（抓到就记 `notok=[...]`）。

### PHASE 1：`node --test tests/concurrency.test.mjs` × 15
| 次 | tests | pass | fail | skip | not ok |
| --- | --- | --- | --- | --- | --- |
| 1 | 6 | 6 | 0 | 0 | （无） |
| 2 | 6 | 6 | 0 | 0 | （无） |
| 3 | 6 | 6 | 0 | 0 | （无） |
| 4 | 6 | 6 | 0 | 0 | （无） |
| 5 | 6 | 6 | 0 | 0 | （无） |
| 6 | 6 | 6 | 0 | 0 | （无） |
| 7 | 6 | 6 | 0 | 0 | （无） |
| 8 | 6 | 6 | 0 | 0 | （无） |
| 9 | 6 | 6 | 0 | 0 | （无） |
| 10 | 6 | 6 | 0 | 0 | （无） |
| 11 | 6 | 6 | 0 | 0 | （无） |
| 12 | 6 | 6 | 0 | 0 | （无） |
| 13 | 6 | 6 | 0 | 0 | （无） |
| 14 | 6 | 6 | 0 | 0 | （无） |
| 15 | 6 | 6 | 0 | 0 | （无） |

**15/15 全绿。**

### PHASE 2：`node --test tests/` × 10
| 次 | tests | pass | fail | skip | not ok |
| --- | --- | --- | --- | --- | --- |
| 1 | 516 | 515 | 0 | 1 | （无） |
| 2 | 516 | 515 | 0 | 1 | （无） |
| 3 | 516 | 515 | 0 | 1 | （无） |
| 4 | 516 | 515 | 0 | 1 | （无） |
| 5 | 516 | 515 | 0 | 1 | （无） |
| 6 | 516 | 515 | 0 | 1 | （无） |
| 7 | 516 | 515 | 0 | 1 | （无） |
| 8 | 516 | 515 | 0 | 1 | （无） |
| 9 | 516 | 515 | 0 | 1 | （无） |
| 10 | 516 | 515 | 0 | 1 | （无） |

**10/10 全绿。**（当时的基线是 516；本轮新增 30 条后全量为 546/545/0/1，见上一节。）

### 已排查并排除的来源（不含糊）
1. **`tests/concurrency.test.mjs` 自身不稳定** —— 它是唯一用真实子进程的用例（spawn node + ready/gate 文件握手）。单跑 15 次 15/15 绿，全量跑 10 次里它也每次都绿 → 排除「子进程握手偶发超时」。它内部用的是轮询文件 + `setTimeout(15ms)`，没有固定长等待，不存在「机器慢就崩」的时序假设。（本轮没给它加睡眠、没弱化任何断言。）
2. **`test()` 被别名成 `t.test` / 模板插值用例名 / 动态注册（循环里 test()）** —— 你已排查过，本轮复核：`grep -r "t\.test\|\${.*}.*test(\|for .*test(" tests/` 无命中；所有 34 个测试文件的用例名都是字面量。
3. **用例数从 516 涨到 517 的机制** —— 517 = 516 + 1，说明多**注册**了一条用例而不是某条变成两条。在全量跑里唯一可能「多注册一条」的入口是顶层动态 import 的模块数量变化，但 34 个测试文件是静态清单，node --test 的收集不依赖运行期分支。25 次里没有一次出现 517，**无法定位到具体是哪条**；这条如实记为未定。
4. **端口/临时目录/锁竞争** —— 所有写盘用例都用 `fs.mkdtemp(os.tmpdir(), ...)` 独立目录，锁是文件锁且 `LOCK_STALE_MS = 10000`；25 次里没有一次出现 `LOCK_TIMEOUT`/`EBUSY`/`EADDRINUSE` 字样。
5. **真实手册被并发读写** —— 无：没有任何用例写 `C:\Users\adkun\.dsh\ace\`（本轮全程只读真实手册，实验一律在 `os.tmpdir()`）。
6. **`node --test` 自身的抖动** —— 25 次里 `duration_ms` 有正常波动（4.5s~5.1s 量级），但 pass/fail 恒定，说明不是超时被误判。

### 遗留（任务 D）
- 未复现，**没有改任何测试**（不动生产代码、不动断言）。若调度者下次再撞到 517/1 fail，建议的下一步抓法：把 `node --test tests/ --test-reporter=tap` 的完整 stdout 重定向到文件（当前 25 次只保留了 `ℹ` 汇总行与 `✖`/not ok 行），并保留 `NODE_TEST_CONTEXT` 之外的原始顺序 —— 517 出现时按「用例名差分」与 516 那次做 diff，能直接指认多出来的那条。

---

## 文档同步（第 37 轮收尾）

| 文件 | 改了什么 |
| --- | --- |
| `README.md` | :88 `injectMaxEntries` 配置行末尾补一句：注入块首行「最多 N 条」跟着这个值走（此前固定写 5 = 文案说谎） |
| `DESIGN.md` | ① 新增 `## 第 37 轮：不满额轻量合并、注入文案跟随配置、只读体检脚本`（三小节）；②「自动注入」小节里 `renderInjection` 那条改成「首行 N 必须说真话」；③ 不变量新增 **I11**（轻量合并口径）与 **I12**（注入首行文案） |
| `AGENTS.md` | 红线新增 **18**（不满额轻量档不许借用满额口径）与 **19**（注入首行「最多 N 条」必须说真话）；文件地图新增一行指向 `tools/diagnose.mjs` |
| `TESTING.md` | 顶部总数 516/515/33 文件 → **546/545/34 文件**；`tests/inject.test.mjs` 17 → 18、`tests/recap-pipeline.test.mjs` 12 → 17、`tests/tuning-behaviors.test.mjs` 行尾补第 37 轮端到端断言；新增 `tests/diagnose.test.mjs | 24` 一行；小节标题「12 个新增文件」→「13 个新增文件 + 第 33/37 轮的重排」 |
| `FIX-REPORT-R37.md` | 本文件（逐任务 append） |

## 验收清单逐条对账

| # | 要求 | 证据 |
| --- | --- | --- |
| 1 | 全绿、skip=1、净增 >= 8 | `# tests 546 / # pass 545 / # fail 0 / # skip 1`（基线 516，净增 30 = A24 + B5 + C1） |
| 2 | `node --check` 全覆盖、bad=0 | lib/*.js(30) + client.js + tools/diagnose.mjs → **checked=32 bad=0** |
| 3 | 每任务 >= 1 条行为面用例 | A24 / B5 / C1（+ tuning-behaviors 端到端断言），全部真跑生产函数，无源码正则（唯一例外是 A10 的反向接线检查，它钉的是「lib/ 不许 import tools/」这条结构约束） |
| 4 | 每任务 >= 1 个变异自证 | 见上「变异自证总表」10 行 |
| 5 | 任务 A 真跑一次并贴五组输出 | 见上「任务 A：只读体检脚本 —— 已完成」小节 |
| 6 | 任务 D 25 次逐次记录 | 见上「任务 D」小节的两张表 |
| 7 | 文档同步 | 见上一张表 |

## 遗留（第 37 轮结束时的真实状态）

1. **任务 D 未复现**：25 次连跑全绿，没改任何测试。下次再撞到 517/1 fail，用 `--test-reporter=tap` 存全量 stdout 做用例名差分。
2. **`tools/diagnose.mjs` 的 `bestMatchPairs` 修过一个真 bug**（`computeMergeSuggestions(list, list)` 会让每条跟自己配成对、真配对全被遮住，实测返回 0 对）。修法：对每条 newEntry 用 `others = list.filter(e => e !== newEntry)` 再算一次、按对去重。这个坑值得记：`computeMergeSuggestions` 的语义是「新增 vs 存量」，**不对同一个集合自比**。
3. **`parsePlaybook` 对任何字符串都不抛**（容错解析），所以体检脚本里「解析失败」是纯防御分支，只能靠 `renderReport` 的畸形输入用例覆盖，**不假装能构造抛错手册**。
4. **真实设置文件的实际位置是 `<DSH_PROFILE_DIR>/dsh-ace.json`**（本机 = `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`，内容 `maxEntries: 100`），不是 `C:\Users\adkun\.dsh\dsh-ace.json`（后者只有 `{autoReflect:true, maxEntries:200}`，属 legacy 位置）。体检脚本的 ⑤ 容量组把实际读数路径原样打印，避免下次再被这个歧义骗到。
5. **`MERGE_EAGER_*` 两个常量是本轮新增的公开导出**，`lib/merge-llm.js:37` / `:40`；改它们会立刻被 tests/recap-pipeline.test.mjs 的 `e｜` 用例抓到（见变异表 B1/B3）。

---

## 结论摘要（send_message 发不出去，按约定写进本节 —— 环境里没有父 agent id）

> `send_message` 试过 `probe-parent-id` / `parent` / `root` / `main` / `lead`，一律返回 `subagent "<id>" is unavailable`；`env:` 里只有 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_SESSION_ID` / `DSH_SHELL` / `DSH_WEB_URL`，**没有父 agent id**。故按任务书「发不出去就写进最后一节」处理。

### 一句话结论
四个任务全部完成；`node --test tests/` = **546 tests / 545 pass / 0 fail / 1 skip**（基线 516，净增 30）；`node --check` **32 个文件 bad=0**；零新增依赖；真实手册与归档全程只读、一个字节没改。

### 任务 A：`tools/diagnose.mjs`（只读体检脚本）
- 新增 `tools/diagnose.mjs`（约 500 行，ESM，零 LLM、零写盘、只读）。命令行 `node tools/diagnose.mjs [--file <playbook.md>] [--today YYYY-MM-DD] [--settings <json>] [--archive <md>] [--help]`，支持 `--key=value` 与 `--key value`；默认 file = `C:/Users/adkun/.dsh/ace/playbook.md`、默认 today = 当天（本地）。
- 只 import 既有纯函数：`parsePlaybook` / `scoreEntries`（lib/playbook.js）、`computeMergeSuggestions` / `MERGE_THRESHOLD_RATIO`（lib/merge.js）、`estimateTokens`（lib/inject.js）、`parseArchiveFile` / `readArchiveSnapshot`（lib/archive-file.js）、`resolveSettingsFile`（lib/settings-path.js）。**不 import `lib/index.js`**（会拉宿主包）；`lib/` 与 `client.js` 反向也不 import 它（A10 用例守着）。
- 五组输出全部真跑到了真实手册：① 近重复 4 对；② 僵尸 41 条；③ 正文过短 0 条；④ 近 30 天新增 0 / 归档 0；⑤ 活跃 69 / maxEntries 100（读数来自 `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`）。
- 降级：文件不存在、空手册、路径是目录（EISDIR）、归档读不到、设置读不到，全部一行提示不崩栈。
- **过程中修掉一个真 bug**：`bestMatchPairs` 原本 `computeMergeSuggestions(list, list)`，每条都跟自己配成对（比率恒 1），真配对全被遮住、实测返回 0 对；改成对每条用 `others = list.filter(e => e !== newEntry)` 再算、按对去重，修后与 `symmetricRatios` 交叉校验一致（真实手册 4 对 = 4 对）。

### 任务 B：不满额也配对（轻量合并）
- lib/merge-llm.js:37 新增 `MERGE_EAGER_THRESHOLD_RATIO = 0.75`、:40 `MERGE_EAGER_MAX_ROUNDS = 2`（紧跟 `MERGE_MAX_ROUNDS = 5`，注释写清「满额是非合不可，不满额只是顺手清理，阈值必须更高、轮数必须更少，否则会为省名额把不相干的经验硬并」）。
- lib/recap-pipeline.js:116 `tryMerge(deps, { entries, signal, logger, date, thresholdRatio, maxRounds })`，maxRounds 用 `Number.isFinite(Number(maxRounds)) ? maxRounds : MERGE_MAX_ROUNDS` 回落；:226 满额分支 `projected > maxEntries` **一字未动**（仍是 0.5 / 5 对）；:237 新增 `} else if (adds > 0) {` 轻量分支。
- 落盘通道与满额完全相同：`ops = mergeOps.concat(finalOps)` → `commitOps(..., { merged: mergeMoves, ... })`，归档原因恒 `merged`，仍是「先 `appendArchivedEntries` 写 archive.md、再 `writeFileAtomic` 写手册」。
- 失败只 warn（`dsh-ace: 轻量合并失败 N 对(…)，跳过它们继续（绝不让复盘落盘失败）`），成功 info（`轻量合并（不满额）成功 N 对`）。0 候选分支（原 :167-193）保持原样。
- 5 条新用例（tests/recap-pipeline.test.mjs，该文件 12 → 17 条）：成功合并 1 对 / `adds===0` 一次 LLM 都不调 / 0.505 的中等相似对**不许**被吃（钉住阈值是 0.75 不是 0.5）/ 抛错只 warn 不阻塞落盘 / 最多 2 对（6 条 → 只并 2 对）。

### 任务 C：注入块首行文案跟随配置
- lib/inject.js:165 `renderInjection(picked, { withRationale = false, maxEntries } = {})`、:168 `const cap = Number(maxEntries) > 0 ? Math.floor(Number(maxEntries)) : INJECT_MAX_ENTRIES;`、:169 head 用 cap；`selectInjection`（:197）三处调用（:208 预算试算、:212 带 rationale 试算、:213 最终渲染）全部透传 maxEntries。
- 保守选择：**没有**把 cap 改成「maxEntries 与 INJECT_MAX_ENTRIES 取小」—— 那等于把本轮的猜测写进文案，属于改语义；只让文案跟着生效配置走，取几条仍由既有「条数上限 ∩ token 预算」决定（I12 明文写死）。
- 用例：tests/inject.test.mjs 新增 `C5.6｜首行「最多 N 条」说真话…`（17 → 18 条）；C5.5 补一条默认回落断言；tests/tuning-behaviors.test.mjs 配置行为② 尾补端到端断言（`injectMaxEntries: 8` → 首行「最多 8 条」、绝不出现「最多 5 条」）。

### 任务 D：偶发「517 tests / 1 fail」追查 —— **未复现**
- 25 次逐次记录见上方两张表：`tests/concurrency.test.mjs` 单跑 **15/15 全绿（6 tests / 6 pass）**；`node --test tests/` **10/10 全绿（516 / 515 / 0 / 1）**。
- **没有改任何测试、没有动任何生产代码**。已排除来源 6 条见上方「已排查并排除的来源」。
- 下一步抓法：`node --test tests/ --test-reporter=tap` 存全量 stdout（本轮只留了 `ℹ` 汇总行与 `✖` / not ok 行），517 再现时与 516 那次做用例名 diff。

### 测试数字（最终）
```
ℹ tests 546
ℹ suites 0
ℹ pass 545
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 4871.2138
```
`node --check`：lib/*.js(30) + client.js + tools/diagnose.mjs → **checked=32 bad=0**。
净增 30 条 = 任务 A 24 条（tests/diagnose.test.mjs 新建）+ 任务 B 5 条（tests/recap-pipeline.test.mjs）+ 任务 C 1 条（tests/inject.test.mjs C5.6，另有 tuning-behaviors 的 3 条断言落在既有用例内）。

### 变异自证总表
10 个变异全部验证过「只有对应用例变红」，明细见上方「变异自证总表」表格；A3 第一版因为用例跟着常量自适应而「等于没钉住」，补写死长度 79/80/81 之后同一变异红 2 条 —— 这条教训已写进上方表格。所有 `// MUTATION-*` 标记已清除（`Select-String 'MUTATION'` 无输出）。

### 遗留
1. 任务 D 未复现（如上）。
2. 真实设置文件位置是 `<DSH_PROFILE_DIR>/dsh-ace.json`（本机 `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`），不是 `C:\Users\adkun\.dsh\dsh-ace.json`（那是 legacy，只有 `{autoReflect:true, maxEntries:200}`）。体检脚本 ⑤ 会打印实际读数路径，避免再被歧义骗到。
3. `parsePlaybook` 对任何字符串都不抛（容错解析），所以体检脚本的「解析失败」是纯防御分支，只用 `renderReport` 的畸形输入覆盖，没有假装能构造抛错手册。
4. `MERGE_EAGER_*` 是本轮新增的公开导出，改它们会立刻被 `e｜` 用例抓到（变异的 B1/B3 已验证）。
5. README 配置表没有新增字段（本轮只补文案，没加配置项），所以 README 只改了 `injectMaxEntries` 那一行的说明。

### 补记（本轮最后追加的两处文档内容，保持报告与仓库一致）
- **TESTING.md** 除上面的总数/条数/文件清单改动外，还补了：① 第 36 轮段落之后新增 `**第 37 轮「不满额轻量合并 + 注入首行文案跟随配置 + 只读体检脚本」净增 30 条 / 全量 546 条（545 通过 + 1 skip）**` 一段（生产面、新增文件、既有三处改动、变异自证、A3 教训、基线演进 516 → 546 / 33 → 34 文件）；② 用例总表末尾新增 **T252–T256** 五行（不满额也配对 / 轻量阈值是 0.75 不是 0.5 / 注入首行说真话 / 体检脚本零写盘 / 体检脚本阈值不是摆设）。
- **DESIGN.md** 除 I11/I12 与第 37 轮小节外，`## For Agents` 的「改合并时」(:651) 与「改注入时」(:652) 两条维护提示已补第 37 轮口径；`## 非功能红线`(:599 起) 末尾新增两条红线（轻量合并口径、注入首行文案），位置在「命中账本的取走点唯一 = 回合边界」之前。
- **真实文件只读核对**（收尾时读 mtime/大小）：`C:\Users\adkun\.dsh\ace\playbook.md` 73,167 bytes / LastWrite 2026-10-26 17:16:42；`C:\Users\adkun\.dsh\ace\archive.md` 2,829 bytes / LastWrite 2026-10-26 14:54:45 —— 两次写时间都早于本轮施工开始，**本轮一个字节都没动**。
- **临时文件已清理**：`C:\Users\adkun\AppData\Local\Temp\r37-flake.ps1`、`r37-d.log` 与 `r37-p1-*.txt` / `r37-p2-*.txt` 全部删除，`leftover_r37=0`。逐次记录已完整抄进本报告，原始输出不必保留。
