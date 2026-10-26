---
title: dsh-ace 与 ACE 论文条款对照
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-26
---

# dsh-ace ↔ ACE 论文条款对照

**论文**：ACE — *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*，arXiv:2510.04618（v1 2025-10-06 / v3 2026-03-29，ICLR 2026）。章节号按 v3。

**结论：31 条条款里，9 条按论文实现，9 条换了实现（换成了什么、为什么，逐条写在下表），4 条未做（写明理由），9 条无法验证（实验数字类）。一轮合计 31 条，A1–A31 一条不漏。第 33 轮把「正负评分」整层拆掉换成「最少使用淘汰」，受影响的条款是 A2 / A4 / A6 / A8 / A9 / A11 / A12 / A13 / A14 / A15 / A17 / A30（其中 A8 / A15 由「实现」降级为「换实现」，A30 的归档去向改写）。**

## 标注怎么读：三态 + 一个变体

| 标注 | 含义 |
| --- | --- |
| **实现** | 论文的做法在本插件里有对应实现，且能用代码或测试指出来 |
| **换实现** | 目的相同，手段不同；表里写清「换成了什么」与「为什么换」 |
| **未做** | 没实现，表里写原因（不是「以后再说」，是有具体理由的不做） |
| **无法验证** | 属于论文的**实验数字**（分数、秒数、token 数、金额、缓存命中率）。代码侧无从验证：需要评测台、数据集划分、对照组、特定硬件与 tokenizer。这类条款归在「未做」的变体里——我们既没做那个实验，也不声称拿到了那些数字 |

另有一批论文表述**本身就难以程序化验证**（凭据见各条：聚合口径未给公式、依赖 2025-09-20 的 leaderboard 快照、依赖闭源 baseline、「语义近重复」只给定性例子、「多强算够强」纯定性、A30 属展望、Figure 3 只 partially shown）。这些在下表里按「换实现」或「无法验证」标注，并在该行写明是哪一部分不可验。

## 逐条对照（A1–A31）

| 条款 | 论文位置 | 原文要点 | 本插件怎么做 | 状态 |
| --- | --- | --- | --- | --- |
| **A1** | §1 Introduction | context 应是详细、结构化、含领域洞见的 playbook，不是简洁摘要 | 手册就是条目集合（每条 = 标题 / 条件 / 做法 / 依据），代码里不存在「把整本手册交给 LLM 压成摘要」的路径 | **实现** |
| **A2** | §2.2 Brevity Bias | 只做「精简 prompt」会让迭代塌向短而通用的指令（反复产出近乎相同的指令） | 旧条目除非被归档否则逐字保留，只追加不重写；完全重复的候选直接丢弃；从不把「越来越短」当优化目标。**第 33 轮补一条边界：合并是唯一允许的正文增长点** —— 满额腾位时 LLM 可以把最相近的一对合成一条（四字段重写、`hits` 取两条之和、保留 `created` 更早那条的 id），但这是「两条并一条、总条数下降」，不是「把整本手册往短而通用压」：合并只发生在超上限时、最多 5 轮、每轮只喂一对，且绝不重写未被选中的条目 | **实现** |
| **A3** | §2.2 Context Collapse | 每步用 LLM 全量重写 context 会塌缩（AppWorld step 60 有 18282 token / 66.7，下一步塌到 122 token / 57.1，低于无适配基线 63.7） | 没有全量重写入口：`applyOps` 只暴露 add / update / remove 三操作，每次只写增量条目 | **实现** |
| **A4** | §3 架构 | Generator（产轨迹）/ Reflector（蒸馏洞见）/ Curator（整合成 context 更新）三个可分辨角色，三次独立模型调用 | Generator = 宿主 agent 本身；Reflector = LLM 多轮复盘；**Curator 的 LLM 调用已删除**，候选去向由 `decideCandidates` 的确定性规则判。换的理由：判定不需要模型，且让模型挑「覆盖哪一条」会引入「挑错 id → 覆盖掉不相关条目」的静默损坏。**第 33 轮闸门整层删除**（原 `lib/gate.js` 231 行三层可复用性闸门 + `tests/gate.test.mjs` 一起删），候选过滤只剩一条判据：**标题字符数 > 0**（空标题拒绝，其余一律放行）。判定本身仍是三档：完全重复丢弃 / 比率 ≥ 0.5 覆盖或取代 / 0.4–0.5 增量补充。**唯一新增的模型调用是满额合并**（第 33 轮）：它不是 Curator 的复活——只在「超上限、需要腾位」这条路径上、只把**一对**条目的正文喂给 LLM 换回一条同构四字段条目，输出必须过 `extractJsonObject`（`parseMergeResult`），不合格就换下一对、全部失败就直接淘汰，绝不参与「覆盖哪一条」的决定 | **换实现** |
| **A5** | §3 工作流顺序 | generate → reflect（可多轮）→ curate 成 compact delta → 最后由轻量非 LLM 逻辑确定性合并 | 顺序固定：回合结束 → `collectTurnTrajectory` → `reflectRounds` → `decideCandidates` → `commitOps`；合并阶段零模型调用 | **实现** |
| **A6** | §3 + §4.7 | lessons 由 lightweight, non-LLM logic 确定性合并；itemized 允许多 delta 并行合并 | 合并 / 去重 / 淘汰全是纯函数（`lib/archive.js`、`lib/merge.js`、`lib/evict.js`），同输入同输出；**没有计分之后，排序键与淘汰判据都不读分数**：淘汰只看 `hits` / `created` / id 三个稳定量，命中计数在回合边界一次原子写盘，所以复盘读到的 `hits` 必然是上一回合结束时的稳定值 —— 原第八轮的「账本没结算干净就不跑复盘」前置不变量、原第九轮的 `pendingIds` 排除约束，第 33 轮随计分一起整段删除。只有「合并」这一步会调 LLM（`lib/merge-llm.js`），它只影响正文、不影响判定顺序，且失败被完全吸收（见下表 A28）。**注入这一环（第 28 轮起）也全是确定性的**：预检索命中后只在 `agent/pre-step` 把一批经验作为一条 user 消息**追加到历史尾部**，不重写任何已有节点（改写系统提示会让整段缓存前缀重算，实测 cached 恒 8,320 tok、73 次切换累计重付 926.0K token，见 DESIGN.md「为什么注入必须追加进历史」） | **实现** |
| **A7** | §3 末段 + §4.2 | 支持 multi-epoch adaptation（同一批 query 反复遍历逐步增强），offline epoch 上限设为 5 | **未做**：没有评测台就没有「同一批 query 反复遍历」的场景；本插件跑在真实会话里，天然是 online 单遍。用户已决定不做 offline 适配 | **未做** |
| **A8** | §3.1 | bullet = metadata（唯一标识 + 被标 helpful/harmful 的计数）+ content（一个小知识单元） | 条目 = 四字段 meta（created → updated → hits → lastHit，可选 auto=true 恒排最后）+ 正文；id 跨更新稳定。**第 33 轮起 meta 只剩「被用了几次」这一个计数**：`hits` 可累加、`lastHit` 可覆盖，两者都升到毫秒精度（本地时区 ISO，字典序即时间序）。`helpful` / `harmful` 两个字段连同 `netScore` / `bumpScores` 一起从 meta 里彻底删除（旧文件里残留的这两个键在 `parseMeta` 里被静默丢弃，不保留、不迁移）。**换的理由**：论文用 helpful/harmful 做正负反馈，本插件第 33 轮把反馈口径换成使用频次 —— 一次工具报错归因不到具体条目，而「哪条被真正用上了」是可观测的事实。序列化恒写四字段、顺序定死 created → updated → hits → lastHit（可选 `auto=true` 恒排最后），旧格式（只有日期）条目照常解析 | **换实现** |
| **A9** | §3.1 | Generator 标注哪些 bullet 有用或误导，标注驱动 helpful/harmful 计数 | **第 33 轮把这一层整个拆了，方向反过来：不再判成败，只记使用频次。** 删掉的清单：`lib/trigger.js` 的 `classifyTurnOutcome` / `settleTurnOutcome` / `WEAK_FAILURE_MIN_CALLS` / `WEAK_FAILURE_ERROR_RATIO` / `UNOBSERVED_TIER` / `UNOBSERVED_OUTCOME` / openBuckets（工具报错桶）/ `noteToolResult` / `noteAgentError`，`lib/index.js` 的 `ctx.on('agent/error')` 监听，`lib/recap.js` 的 `noteError` / `unobservedTurns` / `orphanUsages` / `adoptUnobservedUsage` / `settleOrphanUsages` / 全部计分结算时序（`settling` / `settlingIds` / `usages` / `settlePendingUsage` / `hasPendingUsage` / `noteTurnUsage` / `pendingUsageIds`），以及 `lib/archive.js` 的 `scanArchives` / `pendingIdSet`。**为什么删**：一次工具报错或被中断的回合，既可能是手册里的经验错了，也可能是网络、权限、模型抽风、外部服务变更——把外部因素记到「某条经验」头上，噪音远大于信号；而一条被误判 harmful 的经验会被永久降权甚至淘汰，代价不可逆。这在原文里也留过证据：`agent/error` 衡量的是链路有没有走完（429 / 超时 / 上下文超长 / 写盘失败），与经验对不对无关，第 31 轮只好给它单开一个「未观测」中性态——中性态越补越多，本身就是判分口径不可靠的信号。**换成什么**：唯一反馈信号是**使用频次** `hits` / `lastHit` —— 自动注入的消息真正追加进历史时 +1（同一批只记一次，`delivered` 去重），`ace_playbook` 带 query/id 的定向检索命中时 +1（整本读取不计数），回合边界一次原子写盘；`hits` 只在手册满额时决定淘汰谁，**不影响注入排序**（排序键是纯 BM25 相关度），因此不存在「被注入 → 分更高 → 更容易被注入」的自增强棘轮 | **换实现** |
| **A10** | §3.1 itemized 三性质 | localization（只更新相关 bullets）/ fine-grained retrieval（聚焦最相关知识）/ incremental adaptation（推理期高效 merge、prune、dedup） | 三条都成立：只改命中条目；按 BM25 相关度只注入子集（最多 5 条、约 900 token）；推理期增量 merge / prune。**fine-grained retrieval 的「注入」只追加、不改写**（第 28 轮）：选中的条目由 `agent/pre-step` 追加成一条 user 消息（`source:{kind:'dsh-ace', form:'injection'}`），系统提示段只剩逐字常量，所以每换一批经验都不会让缓存前缀失效 | **实现** |
| **A11** | §3.1 增量 delta | 每次只产 compact delta contexts，旧知识被保留、新洞见持续追加 | 每次复盘只产小批候选（多轮上限 3），落盘只走 `commitOps` 增量，从未重新生成整本手册；同一次增量写里还带上「命中计数已在上一个回合边界原子写盘」这一前提——复盘读到的 `hits` 是稳定值，不存在「拿旧分数归档」的窗口（第 33 轮删掉计分后，原第八/第九轮那两套前置不变量与 `pendingIds` 数据约束一起消失）。**注入本身也是增量**（第 28 轮）：新经验作为新的一条 user 消息追加在历史尾部，既有消息一个字节都不改——这正是论文「delta 只追加、不重写」在请求层的对应做法 | **实现** |
| **A12** | §3.2 Grow-and-Refine | 新 bullet 用新 id 追加，已有 bullet 原地更新（例如计数器递增） | `decideCandidates`：命中某条的候选 `op:'update'` + id 不变原地改；都不命中则 add 并分配新 id（`nextId` = 活跃 + 归档的最高编号 + 1，高水位标记行保证编号永不复用）。**第 33 轮删掉了「净分 > 0 才原地更新」这条分支**：现在只有两条正文判据决定 update 还是「新增 + 取代」——候选正文比旧条目短、或更短到低于 `BREVITY_MAX_SHRINK_RATIO = 0.5` 就新增并取代旧的，不比旧的短就原地更新 | **实现** |
| **A13** | §3.2 去重（A.6 测 50% / 70% / 90% 阈值） | 用语义嵌入比较 bullets 并对冗余剪枝，阈值可配 | 换实现：用 BM25 对称比率（`MERGE_THRESHOLD_RATIO = 0.5`）+ 完全重复丢弃代替语义嵌入；不引向量依赖。对「冗余」的处理也从剪掉改成**软归档**旧条目 —— 历史仍留在文件里可查。**第 31 轮补中间档**：0.4 ≤ 比率 < 0.5（`SUPPLEMENT_RATIO = 0.4`）既不新增也不覆盖，只把候选里旧条目还没有的那部分正文追加进旧条目的 rationale（旧正文一字不动、不占名额），候选没带新细节则丢弃并记 `supplement-redundant`。0.4 不是把合并阈值降到 0.4，0.5 以上仍走覆盖/取代。**第 33 轮起同一把 BM25 对称比率还用来找「合并配对」**（`findMergePairs`，阈值仍是 `MERGE_THRESHOLD_RATIO = 0.5`）：满额且合并后能降条数时，把最相近的一对喂给 LLM 合成一条，另一条以 `reason='merged'` 软归档 | **换实现** |
| **A14** | §3.2 refine 触发策略（A.6 测 10K / 50K / 100K token） | refine 可 proactive（每 delta 后）也可 lazy（仅 context window 超出时），两种都可配 | **未做**：本插件的手册规模（默认上限 100 条、注入预算 900 token）不会撑爆 context window，没有 lazy 的触发条件。主动腾位仍覆盖 proactive 那一半，但**第 33 轮把触发条件从时间/分数换成了条数**：每轮复盘落盘前先判「本批之后会不会超 `maxEntries`」，会超就先尝试合并、再按最少使用淘汰 | **未做** |
| **A15** | §3.2 + A.4 | 按 harmful 元数据剔除或降权被标为 potentially harmful 的条目 | **第 33 轮改判：换实现 —— 按「最少使用淘汰」，不再有 harmful 判据。** 论文没有讨论计分棘轮，本方案按用户口径改为使用频次淘汰。旧口径（净分 ≤ −3 归档 / 净分 ≤ −1 出局线 + 0.15 降权 / 考察位复出 / `decayed` 时间兜底 / 归档三判据 `ARCHIVE_LOW_SCORE` `ARCHIVE_DECAYED_NET_FLOOR` `ARCHIVE_STALE_DAYS`）**整层删除**，出局线 `INJECT_NET_FLOOR` 与考察位三个常量（`PROBATION_RELATIVE_MIN` / `PROBATION_COOLDOWN_DAYS` / `PROBATION_MAX_PER_TURN`）一并删除，注入排序键从「0.85×归一化相关度 + 0.15×净分饱和」改成**纯 BM25 相关度**（同分按 id 数字升序）。**新机制**：活跃条数超 `maxEntries` 时 ① 先尝试 LLM 合并（最多 5 轮、每轮一对，失败就跳过换下一对）；② 合并后仍超则按 `compareForEviction` 排序 —— `hits` 升序、同 hits 时 `created` 更早的先走、再并列按 id 数字升序 —— 取前 M 条淘汰；③ 被淘汰条目搬进**独立归档文件** `archive.md`（`reason='evicted'`），永不物理删除；④ 任何一步失败都不整批拒绝：合并失败就直接淘汰，落盘照常成功。**为什么不用成败判分**：外部因素主导（网络、权限、模型抽风、外部服务变更），归因不可靠；误判的 harmful 会永久降权一条好经验且不可逆。**为什么淘汰只按 hits、且 hits 不进排序键**：若 `hits` 参与打分，就会出现「命中多 → 排序更高 → 更容易再命中」的自增强棘轮，淘汰机制反而把常青条目锁死在注入位上 | **换实现** |
| **A16** | §4.1 适配范式 | offline（train 上优化 / test 上 pass@1）与 online（test 上顺序评估，先 predict 再 update） | 换实现：只实现 online —— 真实会话里就是「先答、回合结束后再复盘落盘」。offline 需要 train/test 划分与批量评测，不在本插件职责内 | **换实现** |
| **A17** | §4.1 指标 | AppWorld 报 TGC / SGC，FiNER 等报 exact-match，BIRD-SQL 用 LLM-as-a-judge | **未做**：这些指标需要评测台与数据集划分，本插件不引评测台。能观测的替代是设置页的六个数：**注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数**（归档数再按四种结构性原因分列：`superseded` / `removed-by-request` / `evicted` / `merged`）。口径说明：`injectedBatches` = 每收到一条新消息预检索命中并发布一批（量级 ≈ 用户消息数，是「检索频率」）；`injectedAppended` = 这批经验真追加进历史一次（同一批只 +1，恒 ≤ 批次）；`retrievalHits` = `ace_playbook` 带 query/id 的定向检索命中的条目数（整本读取不计数）。**第 33 轮删掉的是「计分」这个格子**（`helpful` / `harmful` / `unobserved` / `gateRejected` / `recaps` / `candidates` / `written`），换成 `evicted` 与 `merged`，`normalizeRuntime` 从 14 键降到 7 键 | **未做** |
| **A18** | §4.2 实验设置 | 三角色同一 LLM、batch size = 1、Reflector 轮数与 offline epoch 上限均设 5 | **未做** offline multi-epoch 那半（无评测台，用户决定）。另外两处偏离如实写明：①Reflector 轮数上限取 **3**（`REFLECT_MAX_ROUNDS`）而非 5 —— 真实会话里 3 轮即收敛，第 4 轮只是多一次 LLM 往返；②模型由 `reflectProvider` / `reflectModel` 配、缺省跟随会话模型，不写死某个模型 | **未做** |
| **A19** | §4.3 Table 1 | AppWorld 上 ReAct 平均 42.4 → ACE(GT✓) 59.4（平均 +10.6%） | **无法验证**：需要 AppWorld 数据集、评测脚本与对照组，本插件无评测台，也不在宿主里跑基准。论文的聚合口径（+10.6%）本身未给公式 | **无法验证** |
| **A20** | §4.4 Table 2 | FiNER / Formula 上 ACE(GT✓) 78.3 / 85.5 / 81.9 | **无法验证**：同上，需数据集与评测脚本 | **无法验证** |
| **A21** | §4.7 Table 4 | adaptation latency 53898s → 9517s（−82.3%）；online FiNER 65104s → 5503s（−91.5%）、$17.7 → $2.9（−83.6%） | **无法验证**：秒数与金额依赖具体硬件、并发、限速与当时的价格表，且这是与 GEPA / DC 的**对照量**，本插件没有对照组 | **无法验证** |
| **A22** | §4.7 / A.3 Table 12 | 输入 token 204.1M → 39.3M（−80.8%）、输出 1.87M → 0.31M、rollouts 1455 → 2075 | **无法验证**：token 计数依赖 tokenizer 版本与日志粒度；本插件只有按字符类别加权的**估算**（ASCII×0.4 + 全角×1.0），不是计量 | **无法验证** |
| **A23** | §4.7 KV Cache Reuse | 评测阶段 91.8% 输入 token 走缓存、计费输入成本降 82.6% | **无法验证**：这是 OpenAI prompt-caching 的实现细节，插件侧既看不到缓存命中、也拿不到计费数据。**第 28 轮按这条把注入改成了缓存友好形态**（只往历史尾部追加、不改写系统提示），但「改完之后复用率涨到多少」同样只能靠 provider 侧账本观测，插件内仍无法自证 | **无法验证** |
| **A24** | §4.5 / A.1 跨模型泛化 | 换其它 LLM 不需要改算法或 prompt（GPT-OSS-120B 上 ReAct 34.6 → ACE 40.5） | **机制成立但涨分无法验证**：换模型只改配置（`reflectProvider` / `reflectModel`），prompt 与算法不变；「在不同模型上还涨多少分」需要评测台与多模型对照 | **无法验证** |
| **A25** | §4.6 Table 3 消融 | 能分别关掉 Reflector / multi-epoch / offline warmup 并复现掉分（ACE 59.4 → w/o Reflector or multi-epoch 55.1） | **无法验证**：开关确实存在（`autoRecap` / `autoReflect` / 清空 `reflectModel` 退回跟随会话），但「关掉后掉多少分」需要评测台复现；只能给出行为证据（关掉后不再产生候选） | **无法验证** |
| **A26** | A.5 增量更新消融 | ACE(no incremental) 56.9 vs ACE(with) 70.3 | **无法验证**：需要同一数据集上跑「有 / 无增量更新」两条通道并对比分数 | **无法验证** |
| **A27** | A.6 超参敏感性 | reflection 轮数、dedup 阈值、pruning 触发点的分数曲线（总评 3–5 轮 / 50–90% / 10K–100K） | **无法验证**：分数曲线依赖具体任务与硬件。本插件把这三个量都导出成常量（`REFLECT_MAX_ROUNDS = 3`、`MERGE_THRESHOLD_RATIO = 0.5`、注入预算 900 token），将来有评测台才可扫 | **无法验证** |
| **A28** | §4.4 + App B + A.4 | 依赖 reasonably strong Reflector；弱 / 坏 Reflector 会让 context 变 noisy / harmful；应优雅降级 | 换实现：把「依赖模型」的部分尽量挪进确定性代码 —— 判定、归档、排序全不调 LLM（模型再差也写不坏手册）；Reflector 抛错时第 1 轮上抛、后续轮按已提炼候选落盘（`aborted`）；**注入投递失败只 warn 不抛**——`createUserMessage` 或追加抛错时只写一行 warn + `injectedFailed + 1` 并原样返回 `decision`，绝不把异常冒到 `agent/pre-step`（pre-step 监听器抛错会打哑整回合）。第 28 轮之前这条写的是「系统提示注入失败只 warn 不抛」，注入搬出系统提示之后失败安全跟着搬到了 `lib/inject-delivery.js` | **换实现** |
| **A29** | App B 适用范围 | 并非所有应用都需要丰富 context（HotPotQA 更受益简洁指令、Game of 24 只需一条规则） | 实现：手册可以为空、条目可以很少，不强制最小条目数；检索无命中就不注入（没有待投递批次时 `agent/pre-step` 监听器原样返回 `next()` 的结果，一条消息都不追加）。**也不强行凑够 3 条**：`INJECT_MIN_ENTRIES` 只有对外契约、逻辑上不做补足（见 TESTING.md 已知取舍 P2-e） | **实现** |
| **A30** | §5 Discussion | context 人可读 → 支持 selective unlearning（按 id 定点移除） | 换实现：`op:'remove'` 确实按 id 定点、其它条目不受影响；但按本项目红线**改为搬进归档文件**（`reason='removed-by-request'`）而不是物理删除。**第 33 轮起归档搬到独立文件 `archive.md`**（与 `playbook.md` 同目录，`resolveSharedArchiveFile` / `resolveArchiveFile` 解析；手册文件里永远不再出现 `## 归档区` 章节）；归档文件**不参与注入、也不进 `ace_playbook` 的整本读取结果**，只有人在设置页的记录列表里能看到。隐私诉求下「不再被检索、不再进任何会话」已达成，只是文件里仍留痕 | **换实现** |
| **A31** | Appendix D Figure 6–14 | 释放三角色 prompt，可与论文逐句比对 | 换实现：Reflector prompt 是本项目自写的（含「只输出增量」「禁止整本重写」等约束），不沿用 Figure 6–14 的措辞；Curator prompt 已删除，不存在可比对对象 | **换实现** |

## 状态汇总

| 状态 | 条数 | 条款 |
| --- | --- | --- |
| 实现 | 9 | A1 / A2 / A3 / A5 / A6 / A10 / A11 / A12 / A29 |
| 换实现 | 9 | A4 / A8 / A9 / A13 / A15 / A16 / A28 / A30 / A31 |
| 未做 | 4 | A7 / A14 / A17 / A18 |
| 无法验证 | 9 | A19 / A20 / A21 / A22 / A23 / A24 / A25 / A26 / A27 |
| **合计** | **31** | A1–A31，一条不漏 |

## 三处最大的偏离（先说清楚）

1. **Curator 这个角色没有独立调用（影响 A4 / A5 / A31）**。论文里 Curator 是第三次独立模型调用，负责把 Reflector 的洞见整合成结构化更新。本插件把这一步换成 `lib/archive.js` 的确定性规则：候选与既有条目的关系只有「完全重复 / 命中某条 / 都不命中」三种，全部能用写死的规则判。省一次 LLM 往返是次要的，主要是让模型碰不到「覆盖哪一条」这个决定——判错 id 会静默改坏一条不相关的条目。**第 33 轮新增的「满额合并」是一次受限于特定路径的模型调用**（`lib/merge-llm.js` 的 `MERGE_SYSTEM`，走 Reflector 同一条 `lib/llm.js` 路径）：只在「手册超上限需要腾位」时触发、最多 5 轮、每轮只喂一对、输出必须过 `extractJsonObject` 的四字段校验，不合格就换下一对、全部失败就直接淘汰。它不选 id、不改未选中的条目、也不阻塞落盘，因此不构成 Curator 的复活。代价仍是：论文里 Curator 能做的「跨条目重组措辞」这类软整合，本插件只在超限两两合并这一种情形下做。
2. **去重不用语义嵌入（影响 A13）**。用 BM25 的对称比率 + 完全重复丢弃。换的理由是零依赖（红线 ⑤ 不许引新 npm 运行时依赖，向量模型动辄几十 MB）；代价是「换个说法讲同一件事」的冗余抓不到，只能靠同标题匹配与相似度比率兜底。对冗余条目也不剪掉，而是软归档。
3. **没有评测台，所有实验数字类条款都没法验证（影响 A19–A27）**。这不是「以后补上」的待办：用户已明确决定不引评测台、不做 offline 适配。所以论文的分数、秒数、token 数、金额、缓存命中率在本仓库里既无实现也无证据，只能如实写「无法验证」。

## 那用什么替代论文的评测证据

论文用数据集分数证明方法有效；本插件拿不出数据集分数，改用**链路证据**：tests/e2e.test.mjs 用假 agent / 假事件流驱动插件真实的事件处理器，跑通「回合结束 → 命中计数原子落盘 → 多轮复盘 → 候选判定 → 满额合并 / 最少使用淘汰 → 落盘 + 归档 → 注入」整条链，断言全部读真实写出的临时手册文件与 `archive.md`（只 mock LLM 与宿主事件，不 mock archive / evict / inject / playbook / commit）。它能证明「接线没断、落盘结果符合契约」，证不了「用了手册比不用手册分数高多少」——后者需要评测台，见上。