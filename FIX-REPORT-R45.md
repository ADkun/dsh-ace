# dsh-ace 第 45 轮施工报告

施工轮次：第 45 轮（用户报障修复） | 仓库：D:\dsh\plugins\dsh-ace | 基线：`node --test tests/` = 617 tests / 616 pass / 0 fail / 1 skip（commit `c6791ab`） | 结果：**632 / 631 / 0 / 1 skip**

> 用户原话（问题单）：「dsh-ace插件目前100条上限已经满了，每次都触发120000ms超时，也没有合并成功。请修复这个问题。」
> 本轮两项改动：①把满额配对从 O(N²) 次全语料重扫降到 O(N) 次打分 + tf 缓存（纯性能，配对结果与旧实现同配对）；②把复盘总时限切成可核算的预算并贯通到每一次 LLM 调用（预算耗尽就停发新调用，已产出的候选照常落盘）。两项均已完成并实测。

---

## 任务 0：根因实测（先量化，后动手）

真实手册 `C:\Users\adkun\.dsh\ace\playbook.md`（100 条 / 112,478 字节，`maxEntries=100` 已满）上，用临时探针（放仓库根、相对 import，跑完即删）实测：

| 环节 | 实测耗时 | 说明 |
| --- | --- | --- |
| `findMergePairs(entries, 0.5)`（旧实现） | **78,000–92,000ms** | 对每条 a 调 `computeMergeSuggestions(others,[a])` → 每次内部对 99 条各做一次 `bodyRatio` → 每个 bodyRatio 2 次 `scoreEntries`（100 文档语料）≈ **19,900 次全语料打分/轮** |
| `findMergePairs` 0.75 档（轻量路径同款函数） | 94,000–110,000ms | 同上 |
| `computeMergeSuggestions(existing≈100,[1条])` | **966ms/次** | `decideCandidates` 每候选最多 2 次 + merge-inbox 1 次，每候选 ≈2s |
| 单次 `scoreEntries`（100 文档语料） | 冷 20.8ms / 暖 5.8ms | 每 term × 每文档 `countOccurrences` 无缓存（第 38 轮只缓存了 df 与分词） |

而 `lib/recap-queue.js` 的总时限是 **`RECAP_TOTAL_DEADLINE_MS = 120000`**。也就是说：手册一满额，光是「找配对」这一步纯 CPU 就吃满总时限，**合并的 LLM 调用从未开跑** → 队列超时 abort → 「复盘超过总时限 120000ms」→ 检查点③抛错 → 什么都不落盘。下一回合手册还是满的，同样的事再来一遍。用户看到的「每次都超时 + 永远合并不了」就是这条死循环，实测坐实。

## 任务 A：scoreEntries 加 tf 缓存（lib/playbook.js，纯缓存、打分口径一个字没改）

### 做了什么
- `DF_CACHE_LIMIT = 2048`（第 38 轮的懒 df 缓存）删除，换成 **tf 子缓存**：`TF_CACHE_TOTAL = 2_000_000`，每份语料的条目上限 `tfLimit = max(1024, floor(TF_CACHE_TOTAL / N))`，超限整块 `clear()`（沿用第 38 轮「满了整块丢」的模式，没有无界 Map）。
- `indexFor` 建的语料索引（现 `:954-978`）新增 `tf: Map<term, {df, tfs: Int32Array(N)}>` 与 `tfLimit`；新私有函数 `termFreqsOf(idx, term)`（现 `:985-999`）**一次扫全语料同时得出 df 与每个文档的 tf**。`countOccurrences(>0)` 与旧 df 缓存的 `d.includes(term)` 是同一判据（数学恒等），df 口径逐位一致。
- `scoreEntries`（现 `:1015`）内循环从「每 term × 每文档重扫子串」改成查表 `const {df, tfs} = termFreqsOf(idx, t); const tf = tfs[i];`。BM25 公式（K1=1.2、B=0.75、idf=log((N-df+0.5)/(df+0.5)+1)、非重叠 tf、同分按原序）**一字未动**；`matchEntries` 不变，自动吃上新实现。

### 为什么这样切
第 38 轮只缓存了「term→df」与分词结果，tf 仍每查询现算——对注入（每回合 1 个 query）这是对的；但第 45 轮的配对矩阵要在**同一份语料**上打 N 次 分，tf 才是重复劳动的大头。把 tf 挂进同一份语料索引（同一摘要 key、同槽位、同淘汰），注入路径零额外成本，配对路径从「每次 100 次全语料重扫」变成「第一次扫、之后查表」。

## 任务 B：配对矩阵原语（lib/merge.js）

- 新增导出 `computePairRatios(entries)`（现 `:152-167`）：语料 = `entries.map(projectBody)` 一次性建好，对每条有正文的条目用**它自己的正文当 query** 打一次 `scoreEntries` → `{ corpus, rows, selfs, n }`（`rows[i]` 是「第 i 条的正文在全语料上的得分行」，空正文为 `null`）。同一份语料 → 第 38 轮的索引缓存与新的 tf 缓存全部命中，N 次打分 ≈ 一次多 query 扫描的成本。
- 新增导出 `pairRatioAt(ratios, i, j)`（现 `:173-184`）：`min(rows[i][j]/selfs[i], rows[j][i]/selfs[j])`，空正文 / 零自分 → 0，结果钳到 1——与 `bodyRatio` 的判据**逐位一致**（测试里用旧算法重抄的锚逐格比对，25 对全等）。
- **与旧实现唯一的语义差别（已写进 JSDoc）**：旧 `findMergePairs` 每选出一对就把两条从候选集里摘掉，后续配对的语料随之缩小（idf/N/avgdl 微变）；矩阵版固定用全量语料。第一对之前两者逐位一致；之后的配对可能有 ±0.001 级 idf 微漂移。实测（真实 100 条手册）：三对配对完全一致，比率 0.6267/0.5578/0.5057（旧 0.6267/0.5582/0.5063），都在 0.5 阈值同侧，结论不变。

## 任务 C：findMergePairs 矩阵化 + planMerges 预算闸（lib/merge-llm.js）

- 新增导出常量 `MERGE_MIN_CALL_MS = 10_000`（`:34`，低于它就不值得再开一次 LLM）与 `MERGE_COMMIT_RESERVE_MS = 8_000`（`:35`，留给落盘的保底）。
- `findMergePairs`（现 `:156`）重写为矩阵版：一次 `computePairRatios`，然后 i 升序贪心（跳过已用、`j!==i`、严格 `>` 取首个最大、`>= thresholdRatio` 才成对、互不重叠），整体 try/catch 失败返回 `[]`。**贪心次序与旧实现逐字同构**（旧的「对每条 a 求最优配偶」就是矩阵里同一行取最大）。
- `planMerges`（现 `:213`）deps 新增 `budget:{remaining}`：每轮开头 `left = budget.remaining() - MERGE_COMMIT_RESERVE_MS`，`left < MERGE_MIN_CALL_MS` → 打一行 warn「合并剩余预算不足（还剩 Nms），停止发起新的合并对，已合并 M 对照常落盘」+ break——**只停、不抛、不吞已算出的部分结果**（红线 12 原样）。预算够时 `ask(mergePairInput(pair.a,pair.b), { maxMs: left })`，把本次调用的上限交给 LLM 层。
- 每轮成功合并后照旧重建 `working`（摘 keep/drop、并回合并结果），下一轮的 `findMergePairs` 在新语料上重算矩阵（满额 5 轮 × 矩阵 ≈ 1s 级，可接受）。

## 任务 D：预算贯通（recap-queue → index → recap-pipeline → reflect/merge → llm）

链路自上而下，每一环都有机检：

1. **lib/recap-queue.js**：`drain()` 调上游改为 `next.run(controller.signal, { deadlineAt: startedAt + totalDeadlineMs })`（原 `:176`）。第二参向后兼容（不认识的调用方忽略它），把「绝对截止时刻」递下去。
2. **lib/index.js**：三处 run 闭包（`mergeRecapItems` `:1179`、自动复盘 `:1262`、`/ace` 手动 `:1843`）改为 `(signal, budget) => executeRecap({ …, deadlineAt: budget?.deadlineAt })`；`executeRecap`（`:1416`）签名加 `deadlineAt` 传给 `runRecapPipeline`；`reflectRound`（`:1374`）与 `mergeAsk`（`:1443`）把 `maxMs` 透传给 `oneShot`。
3. **lib/recap-pipeline.js**：
   - 新增导出 `MERGE_PHASE_RESERVE_MS = 40_000`（`:109`，满额时给合并阶段的预留）与 `makeRecapBudget(deadlineAt)`（`:125`）→ `{ enabled, remaining(), sliceFor(reserveMs) }`；`deadlineAt` 非有限正数 = 无预算（老调用方行为不变）。
   - `runRecapPipeline`（`:174`）第二参加 `deadlineAt`，读快照后建 budget；`mergeReserveMs = entries.length >= maxEntries ? 40_000 : 0`（满额才给合并预留）。
   - **reflect 轮的预算闸**：每轮 `maxMs = budget.sliceFor(mergeReserveMs + MERGE_COMMIT_RESERVE_MS)`；预算启用且 `maxMs < MERGE_MIN_CALL_MS` 时——已有 priorCandidates → 抛 `'ace: LLM 调用超时（复盘剩余预算不足 Nms，要留给合并与落盘），第 R 轮不再发起'`（`lib/reflect.js` 的 `isTimeoutError` 认这个前缀，按已提炼候选收尾）；**第一轮（无 prior）永不拦、不派 maxMs 照旧发起**——绝不许「预算紧就空手假成功」，第一轮连一个候选都没有的复盘宁可真跑。
   - 三处 `tryMerge` 调用（0 候选满额分支 / 有候选满额分支 / 轻量分支）都传 budget。
4. **lib/llm.js**：`oneShot` 加 `maxMs` 参数：`capMs = Number.isFinite(maxMs) && maxMs > 0 ? Math.min(ONESHOT_TIMEOUT_MS, maxMs) : ONESHOT_TIMEOUT_MS`，`mergeSignals(signal, capMs)`；超时报错文案用实际 cap（前缀 `'ace: LLM 调用超时（单次上限 Nms）'` 不变，reflect 的吞错判据认前缀）。

**为什么这条链是修复的另一半**：矩阵化解决了「纯 CPU 吃满时限」；但 LLM 调用本身（3 轮复盘 + 5 对合并）理论上限仍远超 120s。贯通后每一跳都能核算剩余预算：复盘轮不会把合并的口粮吃光，合并轮不会把落盘的保底吃光；合并单次调用超的是**自己的 maxMs**（外层 signal 未 abort）→ `planMerges` 记 failed 换下一对（红线 12）→ 检查点③不抛 → **已合并的部分真能落盘**。

## 用例（净增 15，全绿；另扩 1 条既有用例的断言）

| 用例 | 钉住什么 |
| --- | --- |
| tests/merge.test.mjs 17→22（+5） | ① `computePairRatios`+`pairRatioAt` 与旧 bodyRatio 重抄锚 25 对逐位等（空正文=0、对称、自比=1、同文=1，锚必须先 `projectBody` 再比——生产里 bodyRatio 只在投影语料上跑）；② stub 矩阵钉死「双向都超 1 必须钳到 1」（无钳会得 1.5）与子 1 比率原样透传；③ findMergePairs 矩阵版与旧实现同配对（3+1 条目仍只成 a↔b 一对）；④ planMerges 预算闸三条：起点不足 → asked=0+warn；首对成功后预算见底 → 只合并这一对、failed=0、部分结果照常返回（红线 12）；无 budget → ask 不带 maxMs（老调用方不变） |
| tests/recap-pipeline.test.mjs 21→26（+5） | 预算见底时第一轮照旧发起且不派 maxMs、第二轮闸抛 + 按已有候选落盘（logs 含「第 2 轮不再发起」「按已提炼的 1 条候选落盘」）；预算充足时每次调用带 maxMs（第一轮 ≈112s = 120s−8s 落盘保底）；满额扣合并预留（maxMs ≈72s = 120s−40s−8s）；无 deadlineAt 行为与旧版一致 |
| tests/recap-queue.test.mjs 10→11（+1） | run 收到第二参 `{deadlineAt}` ≈ startedAt+totalDeadlineMs（t0 基准 ±500ms） |
| tests/playbook.test.mjs 80→81（+1） | tf 缓存：同语料冷 → 热 → 被挤掉再冷，打分逐位一致（第 38 轮那版朴素实现对照用例继续守住口径） |
| tests/llm-budget.test.mjs（新文件，3 条） | 假 provider 挂到 signal abort 再 throw：maxMs=80 → 前缀错含「单次上限 80ms」且 70–3000ms 内触发；maxMs=0 当没传 + 外层 signal 先断原样 rethrow；maxMs 之内正常流照常返回 |
| tests/trajectory.test.mjs（31 条不变） | `:510`/`:520` 源码级断言同步为 `executeRecap({ agent, summary, signal, deadlineAt: budget?.deadlineAt })`（签名变了，断言跟着改，只加字段未放宽） |

## 变异自证（每条真跑、跑完逐字复原，备份哈希逐文件核对 IDENTICAL）

| 变异 | 结果 |
| --- | --- |
| M1 `planMerges` 预算闸条件改恒不触发（`if (false)`） | tests/merge.test.mjs **红 2**（两条预算闸用例），EXIT=1 |
| M2 `oneShot` 忽略 maxMs（capMs 恒 undefined，回落单次上限） | tests/llm-budget.test.mjs **红 3**（全文件），EXIT=1 |
| M3 `termFreqsOf` 的 tf 恒写 1（缓存口径劣化） | tests/playbook.test.mjs **红 1**（R38 的朴素实现逐条比对——独立打分锚抓住）；**如实记**：merge.test.mjs 的矩阵对照锚不红，因为锚与被测**共用同一个生产 scoreEntries**，同源漂移互相抵消——口径的牙齿在独立锚上，不在同源对照上 |
| M4 `pairRatioAt` 去掉钳 1（`Math.min(1,r)` → `r`） | tests/merge.test.mjs **红 1**（新增的 stub 钳 1 断言；真实语料里双向超 1 极难自然出现，所以牙齿必须是手工 stub） |
| M5 recap-queue 去掉第二参 `deadlineAt` | tests/recap-queue.test.mjs **红 1** |
| M0（自然发现，非故意变异）首版把第一轮复盘也纳入预算闸 | recap-hang (a)(c) **红 2**（第一轮被拦 → 挂死 provider 不再挂、60ms 上限没机会触发）→ 修成「第一轮永不拦、不派 maxMs」后全绿。这条教训写成了用例：「预算见底时第一轮照旧发起且不派 maxMs」 |

## 性能（真实 100 条手册，改前 / 改后，探针跑完即删）

| 环节 | 改前 | 改后 | 加速 |
| --- | --- | --- | --- |
| `findMergePairs(0.5)` | 78,000–92,000ms | **53.2ms** | ≈ **1,600×** |
| 配对结果 | 3 对（0.6267/0.5582/0.5063） | 3 对（0.6267/0.5578/0.5057），**同配对** | idf 微漂移，同侧过阈 |
| `computeMergeSuggestions(99+1)`（暖） | 966ms | **241ms** | ≈ 4× |
| 矩阵构建 `computePairRatios(100条)` | — | **216.5ms** | 一次构建全语料复用 |
| `planMerges`（有 budget、ask 全失败） | — | 749.5ms（3 对全部尝试+按 failed 收尾） | 预算充足时闸不挡正常流程 |
| 全量测试 | 617 / 616 / 1 skip | **632 / 631 / 0 / 1 skip，6.7s** | — |

改后的满额复盘时间线（同一 120s 总时限内）：配对 CPU ≈0.5s（原 ≈110s）→ 反思轮受 `120s − 40s 合并预留 − 8s 落盘保底` 约束 → 合并对受 `剩余 − 8s` 约束且单次 `min(75s, 剩余)` → 落盘保底 8s 恒在。「每次都 120000ms 超时、合并永远开不了跑」的结构性死因解除。

## 遗留与未验证（如实声明）

- **真实宿主端到端未验证**：全部证据来自单测（含真临时手册的整链用例与子进程 hang 用例）+ 真实手册只读探针。修复要**重启 DSH** 后在真实会话里观察一次满额复盘日志（`dsh-ace: 复盘开始…` → 合并/淘汰日志 → 无「复盘超过总时限」）才算闭环；本环境不许重启宿主。
- **LLM 真实时延分布未测**：预算常量（40s 合并预留 / 10s 最小调用 / 8s 落盘保底）是按「单次上限 75s」与真实手册规模推的保守值，不是对真实 provider 时延的统计。若真实模型普遍 >72s/次，合并仍会因预算不足停发——那是「及时止损、已合并部分落盘」的正确行为，但合并成功率要在真机上复核。
- **merge-inbox 的陈旧建议未修**（超本轮范围）：真实 inbox 里躺着 2 条指向已 superseded 条目的旧建议（ace-235↔224、ace-250↔236），本轮不动 inbox 语义。
- **矩阵版与旧实现的第一对之后 idf 微漂移**已在上文披露；若未来有人要求「逐位复刻旧漂移」，那等于回到 O(N²)，不予采纳。
