---
title: dsh-ace 测试指南
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-21
---

# 测试

## 运行方式

**结论：`npm test`（即 `node --test tests/`），无网络、无构建、秒级完成。**

```
npm test
```

当前 213 条用例：212 通过 + 1 条在 Windows 上条件跳过（T47 文件权限位，见未验证清单 7）。其中「记录列表详情页」的只读条目清单新增 14 条（T133–T146，tests/entries.test.mjs）：空手册 / 正常手册（auto 与非 auto）/ 字段映射 / 四种降级（missing、unreadable、needs-session）/ maxEntries 透传 / 只读红线 / `GET /api/dsh-ace/entries` 的 200 体形状与源码级契约，以及 `/stats` catch 兜底改成同形零值 payload 的断言。其中只读统计 16 条（T117–T132）为「设置页只读手册统计」新增：纯函数与读盘降级 10 条（tests/stats.test.mjs）、统计块渲染 / 四种 reason 降级 / 刷新时机 6 条（tests/client-stats.test.mjs）。其中手册路径解析链 9 条（T48–T56）、跨进程文件锁 4 条（T57–T60）、跨进程锁覆盖整个读-改-写区间 3 条（T61–T63）为「手册默认本机共享层」改造新增；跨进程锁语义返工又新增 4 条（T64–T67，见下表）；并发冲突检测（快照 + 冲突报错）再新增 3 条（T68–T70，见下表）；锁的重入与回收兜底 3 条（T71–T73）与核心默认值 1 条（T74）见下表。**逐条冲突判定 + add 参与冲突检测 + 编号不复用**这轮改造新增 16 条：单元 12 条（T75–T86，见下表）与真实子进程并发 4 条（T87–T90，见下表，测试文件 tests/concurrency.test.mjs，脚本写在系统临时目录、用完即删，仓库里不留脚本）。**自动复盘触发时机迁到空闲边沿**这轮新增 19 条：纯状态机 8 条（T91–T98，tests/trigger.test.mjs）与调度器行为 11 条（T99–T109，tests/recap.test.mjs，见下表）。**独立对抗性验收发现的 8 个缺陷修复**这轮新增 7 条（T110–T116）：近似层只比正文、同领域不同经验不判冲突、相似度百分比封顶 100%、并发改名 + 同标题新增被检出、高水位标记归位且全文只留一份、无标记时编号复用一次的行为钉住（见下表）。语法自检：对每个 `lib/*.js` 跑 `node --check`；`package.json` 以 `JSON.parse` 校验。

## 用例总表

**结论：覆盖持久化层的解析、序列化、增量操作、并发与原子写；LLM 相关与工具注册不在单测范围（见「未验证清单」）。**

并发相关用例分两层：进程内的锁与冲突判定在 tests/playbook.test.mjs（纯逻辑），**真实多进程**在 tests/concurrency.test.mjs —— 两个 node 子进程同时操作同一本手册，跑的是生产同款路径（lib/commit.js 的 `commitOps`），子进程脚本写在系统临时目录、用完即删，仓库里不留脚本。

| 用例ID | 对象 | 断言内容 | 对应不变量 | 载体 |
| --- | --- | --- | --- | --- |
| T01 | parsePlaybook | 文档头保留、字段/元数据解析、id 补零 | I2 | tests/playbook.test.mjs |
| T02 | parsePlaybook | 条目内无法识别行进 extraLines 且序列化保留 | I7 | 同上 |
| T03 | parse↔serialize | 样例往返等价 | I7 | 同上 |
| T04 | serializePlaybook | 空手册且无头得空串 | — | 同上 |
| T05 | applyOps | add 分配 max+1 递增 id | I2 | 同上 |
| T06 | applyOps | 完全重复 add 记 duplicates 跳过 | I1 | 同上 |
| T07 | applyOps | 空白差异归一化后不算重复 | — | 同上 |
| T08 | applyOps | update 合并字段并刷新 updated | — | 同上 |
| T09 | applyOps | remove 删除条目 | — | 同上 |
| T10 | applyOps | 任一 op 非法整批拒绝、数组不变 | I3 | 同上 |
| T11 | applyOps | 错误信息逐条列出全部违规 | I3 | 同上 |
| T12 | applyOps | 超 maxEntries 整批拒绝并列出可合并旧条目 | I4 | 同上 |
| T13 | applyOps | 同批重复 add 第二条进 duplicates | I1 | 同上 |
| T14 | digestEntries | 每条压缩为一行 | — | 同上 |
| T15 | withLock | 同路径串行、结果按序返回 | I5 | 同上 |
| T16 | withLock | 不同路径并行 | I5 | 同上 |
| T17 | withLock | 前序抛错不阻塞后序 | I5 | 同上 |
| T18 | 写路径 | 初始化/原子写/重读往返 | I6 | 同上 |
| T19 | matchEntries/querySegments | 中文长句经 2-gram 片段命中含相关词条目 | — | 同上 |
| T20 | matchEntries | 多片段 OR，命中任一片段即返回 | — | 同上 |
| T21 | matchEntries | BM25：tf 高/多片段命中排前；同形条目同分保序 | — | 同上 |
| T22 | matchEntries | 单英文词大小写不敏感；无命中回退整本兜底 | — | 同上 |
| T23 | querySegments/matchEntries | 空或纯标点 query 无片段、原样返回全部 | — | 同上 |
| T24 | matchEntries | BM25：稀有词（df 小→idf 大）得分高于常见词 | — | 同上 |
| T25 | buildCatalog | provider/model 目录折叠为 `{id,name,models[{id,name,description?}]}` | — | tests/catalog.test.mjs |
| T26 | buildCatalog | 单个 provider 的 listModels 抛错 → 它自己 `models:[]` 且带 `error`，接口仍 `ok:true` | — | 同上 |
| T27 | buildCatalog | listModels 卡住 → 按超时收尾（默认 15s，测试注入 30ms），不拖垮接口 | — | 同上 |
| T28 | buildCatalog | listProviders 抛错 / llm 服务缺失 → 返回 `ok:false` 而不抛异常 | — | 同上 |
| T29 | withTimeout | 正常值按时返回；超时与内部拒绝都以 Error 拒绝 | — | 同上 |
| T30 | ModelPicker（client.js） | 两个下拉以占位「跟随会话模型」渲染，两项都空时无「只填一项」警告 | — | tests/client-picker.test.mjs |
| T31 | ModelPicker | 展开后可搜索（大小写不敏感子串）、选中 provider 即 POST `reflectProvider` | — | 同上 |
| T32 | ModelPicker | model 下拉按 provider 分组，已选 provider 时只列该组 | — | 同上 |
| T33 | ModelPicker | provider 为空时选 model → 一次 POST 同时提交 `reflectProvider` 与 `reflectModel` | — | 同上 |
| T34 | ModelPicker | 底部清空项提交空串并回到「跟随会话模型」 | — | 同上 |
| T35 | ModelPicker | Esc 关闭、ArrowDown/ArrowUp 循环移高亮、Enter 选中 | — | 同上 |
| T36 | AceSection | `/catalog` 404 时面板显示错误行，其余字段照常可用 | — | 同上 |
| T37 | resolveSettingsFile | `profileContext.dir` 存在时优先于任何环境变量 | — | tests/settings-path.test.mjs |
| T38 | resolveSettingsFile | 无 profileContext → 回落 `DSH_PROFILE_DIR` | — | 同上 |
| T39 | resolveSettingsFile | 再回落 `DSH_HOME`（即当前实际落盘位置） | — | 同上 |
| T40 | resolveSettingsFile | 三者皆无 → 回落 `~/.dsh` | — | 同上 |
| T41 | resolveSettingsFile | ctx 缺失 / 无 `get` / 无 `dir` / `get` 抛错 → 均视为不存在并回落 | — | 同上 |
| T42 | resolveSettingsFile | 空串与纯空白被当作不存在，逐级回落（三级各测一次） | — | 同上 |
| T43 | resolveLegacySettingsFile | 恒指旧口径（不看 profileContext），且与无 profileContext 时的解析结果同路径 | — | 同上 |
| T44 | migrateSettingsFile | 新位置不存在 → 旧内容原样复制，旧文件保留、无 `.tmp` 残留、记一条 info 日志 | — | 同上 |
| T45 | migrateSettingsFile | 新位置已存在 → 绝不覆盖（两侧内容都不变） | — | 同上 |
| T46 | migrateSettingsFile | 旧文件不存在 → 跳过且不凭空造文件；源与目标同路径 → 跳过 | — | 同上 |
| T47 | migrateSettingsFile | 迁移后文件权限 0o600（**Windows 上 skip**，见未验证清单 7） | — | 同上 |
| T48 | resolvePlaybookFile | 绝对路径原样使用（给了工作目录也不 join） | — | tests/playbook-path.test.mjs |
| T49 | expandHomePath / resolvePlaybookFile | `~`、`~/`、`~\\` 前缀展开到 home；`~foo` 仍是字面目录名 | — | 同上 |
| T50 | resolvePlaybookFile | 相对路径相对会话工作目录 join（工作区私有层） | — | 同上 |
| T51 | resolvePlaybookFile | 相对路径拿不到工作目录 → 抛 `RELATIVE_PATH_NEEDS_SESSION` | — | 同上 |
| T52 | resolvePlaybookFile | 空串 / 纯空白 / undefined / null → `<DSH home>/ace/playbook.md`（共享层，无需会话上下文） | — | 同上 |
| T53 | resolvePlaybookFile + readInbox | 共享层解析出的目录里读得到 merge-inbox（HTTP 面同款调用，目录缺失返回空列表） | — | 同上 |
| T54 | resolveDshHome | `DSH_HOME` 未设 / 空串 / 纯空白 → 回落 `~/.dsh` | — | 同上 |
| T55 | resolveDshHome | `profileContext.home` 优先于 `$DSH_HOME`；ctx 缺失/无 get/抛错均容错 | — | 同上 |
| T56 | resolvePlaybookFile | 不注入 home 时落在 `os.homedir()/.dsh/ace/playbook.md` | — | 同上 |
| T57 | withFileLock | 临界区内 `<file>.lock` 存在且含 pid，结束后 finally 清理 | I5 | tests/playbook.test.mjs |
| T58 | withFileLock | 持锁进程**已死**（pid 不存在）的陈旧锁被下一个写者立刻回收（时间戳再旧也回收） | I5 / I5b | 同上 |
| T59 | withFileLock | 并发两个写者读-改-写串行，计数不丢写 | I5 | 同上 |
| T60 | writeFileAtomic | 写入后目录里只剩手册文件，无 `.lock` / `.tmp` 残留 | I5 / I6 | 同上 |
| T61 | withExclusiveLock | 锁覆盖整个读-改-写区间；区间内嵌 `writeFileAtomic` 识别为重入，不自死锁 | I5 | 同上 |
| T62 | withExclusiveLock | 并发写者各自「读→写回」在锁内串行，计数不丢写 | I5 | 同上 |
| T63 | withFileLock | 持锁进程已死（pid 不存在）时锁被立刻回收，不必等满 staleMs | I5 | 同上 |
| T64 | withFileLock | 持锁进程**存活**且持锁时长 > staleMs → 第二个写者**不得进入**临界区，等到 timeout 才抛「等待手册写锁超时」；结束后无 `.lock` 残留 | I5b | 同上 |
| T65 | withFileLock | 持锁进程已死（pid 不存在）时锁可被回收并正常取得，不必等满 staleMs | I5b | 同上 |
| T66 | withFileLock | 三写者并发且其中一个持锁超过 staleMs → 临界区不重叠、计数不丢写、无 `.lock` 残留 | I5 / I5b | 同上 |
| T67 | withFileLock | 锁被回收后，原持锁者的 finally **不会**删掉新主人的锁（nonce 校验） | I5b | 同上 |
| T68 | readPlaybookSnapshot | 只读快照：文件不存在时返回空条目且**不创建文件** | I5 | 同上 |
| T69 | detectConflicts | 目标条目在快照与最新手册中一致 → 无冲突（返回 `{conflicts:[], safe:[…]}`，`describeConflicts` 返回 null） | I5 / I5c | 同上 |
| T70 | detectConflicts | 目标条目在复盘期间被删除 / 被修改 / 新出现 → **逐条挑出**冲突项（带 reason），不再整批一票否决 | I5 / I5c | 同上 |
| T71 | withExclusiveLock / withLock | 同路径**嵌套**调用不死锁（withLock 重入保护）；不同路径仍并行；无 `.lock` 残留 | I5 | 同上 |
| T72 | restoreLock | 目标位置已被占住时**绝不覆盖**别人的锁（放弃放回） | I5b | 同上 |
| T73 | restoreLock | 跨卷（`link` 返回 ENOENT）也能把锁原样放回原位，源文件被清理 | I5b | 同上 |
| T74 | DEFAULT_PLAYBOOK_PATH / DEFAULT_MAX_ENTRIES | 核心默认值：`playbookPath` 默认空串（本机共享层）、`maxEntries` 默认 100 | — | tests/playbook-path.test.mjs |
| T75 | detectAddConflicts（缺陷 A） | add 与「快照之后新出现的条目」完全重复（normKey 口径）→ 判为冲突 | I5c | tests/playbook.test.mjs |
| T76 | detectAddConflicts（缺陷 A） | add 与「快照之后新出现的条目」**标题相同但正文不同** → 判为冲突（BM25 比率 0.281 拦不住，靠标题口径兜住） | I5c | 同上 |
| T77 | detectAddConflicts（缺陷 A） | 与「快照里本就存在的条目」重复 → **不拦**（留给 Curator 去重，不重复拦死正常流程） | I5c | 同上 |
| T78 | detectAddConflicts（缺陷 A） | 与新出现条目无关的 add → 不拦（不误伤） | I5c | 同上 |
| T79 | detectAllConflicts（缺陷 A / B） | 同一批里 2 条冲突 + 1 条安全 → 冲突项与安全项被分开（safe 里只剩那条安全的） | I5c | 同上 |
| T80 | commitOps（缺陷 B） | 同批里一条冲突 + 一条安全 → 安全的照常落盘、别人的版本没被覆盖，冲突以结构化形式回报 | I5c / I5d | 同上 |
| T81 | commitOps（缺陷 B） | 整批都是冲突项 → 一字不写盘，冲突原样回报（不再整批丢弃即沉默） | I5d | 同上 |
| T82 | applyOps（缺陷 C） | 删掉最高编号后再新增 → 新增用 ace-004，**不复用**被删的 ace-003 | I2 | 同上 |
| T83 | applyOps（缺陷 C） | 不传 highWater 时也把现存最大编号记成高水位 | I2 | 同上 |
| T84 | readIdHighWater / ensureIdHighWater（缺陷 C） | 高水位存在文档头的一行 HTML 注释里（旧手册没有也能读；幂等；变大则更新；标记只留一行） | I2 / I7 | 同上 |
| T85 | commitOps（缺陷 C） | 删掉最高编号条目后新增 → 新编号更大，且高水位写进文件（`ace:id-highwater: 3`） | I2 | 同上 |
| T86 | commitOps（缺陷 C） | 人手编辑插入 ace-042 后新增 → 下一个新增是 ace-043（大于人手工插入的最高编号） | I2 | 同上 |
| T87 | 真实子进程并发（缺陷 A） | 两进程同时 add 同名不同内容 → **不产生两条重复**（一条成功、一条报冲突，冲突理由可见） | I5c | tests/concurrency.test.mjs |
| T88 | 真实子进程并发（缺陷 B） | 两进程同时 update 同一条目 → 一条成功一条报冲突，且手册没写坏（只留一份做法） | I5c / I5d | 同上 |
| T89 | 真实子进程并发（缺陷 A） | 两进程同时 add **不同**条目 → 两条都在（不误伤），编号不重复 | I5c | 同上 |
| T90 | 真实子进程并发（缺陷 C） | 一进程删最高编号、另一进程新增 → 新增用 ace-003，**不复用**被删的 ace-002 | I2 | 同上 |
| T91 | createRecapState | 初始为空状态（mutCount/lastRecapTurn/currentTurn 归零，无待办） | I9 | tests/trigger.test.mjs |
| T92 | recordTurnEnd | 未达阈值 → 只更新回合号，不挂待办 | I9 | 同上 |
| T93 | recordTurnEnd | 命中条件 → 挂待办（记本回合号与本回合 mutating 次数），计数清零 | I9 | 同上 |
| T94 | recordTurnEnd | 冷却期内不重复触发（待办仍是上一回合挂的那个） | I9 | 同上 |
| T95 | takePendingRecap | 取出即出队并记一次尝试；队列空时返回 null | I9 | 同上 |
| T96 | requeuePendingRecap | 未到上限 → 放回队列（尝试次数保留） | I9 | 同上 |
| T97 | requeuePendingRecap | 达到上限 → 放弃并清空队列 | I9 | 同上 |
| T98 | isBusyError | 只认宿主「already has active work」文案，其它错误不算竞态 | I9 | 同上 |
| T99 | createRecapController | 回合结束只记账：phase 为 running 时**绝不调 runMaintenance**，只挂待办 | I9 | tests/recap.test.mjs |
| T100 | createRecapController | 空闲边沿才真正触发：回合内不执行，`agent/status` 报 idle 时执行一次 | I9 | 同上 |
| T101 | createRecapController | `agent/status` 不是 idle 时不触发，待办留在队列里 | I9 | 同上 |
| T102 | createRecapController | 没有待办时 idle 边沿不误触发 | I9 | 同上 |
| T103 | createRecapController | 没有新回合（无 mutating 调用）就不产生待办，idle 边沿不凭空复盘 | I9 | 同上 |
| T104 | createRecapController | 撞上 already has active work → 待办回到队列、尝试次数 +1，**不推用户提示**（只写日志） | I9 | 同上 |
| T105 | createRecapController | 竞态退避：最多尝试 3 次，用尽后放弃待办且**只提示一次** | I9 | 同上 |
| T106 | createRecapController | 待办回队后，下一个 idle 边沿会再试并成功 | I9 | 同上 |
| T107 | createRecapController | 真实失败（LLM/写盘失败）→ 给用户推一条提示 | I9 | 同上 |
| T108 | createRecapController | 执行前会 `await agent.whenIdle()` 等宿主空闲 | I9 | 同上 |
| T109 | createRecapController | 子代理、以及有子代理在跑时都不触发 | I9 | 同上 |
| T110 | detectAddConflicts（缺陷 1） | 近似层只比正文：《配置里缺少重试次数》与《配置里缺少超时时间》**不再判冲突**（旧实现单向比率 0.576 → 误拦） | I5c | tests/playbook.test.mjs |
| T111 | detectAddConflicts（缺陷 2） | 冲突理由里的相似度百分比**不超过 100%**（断言文案里不出现三位数百分比） | I5c | 同上 |
| T112 | commitOps（缺陷 3） | 并发改名 + 同标题新增 → 冲突被检出、冲突项不落盘、磁盘不留下两条同标题（走真实提交路径） | I5c | 同上 |
| T113 | commitOps（缺陷 4） | 高水位标记被挪进条目体内 → 写回后全文只剩一份标记、且在文档头；条目数正确、新编号大于标记里的高水位 | I2 | 同上 |
| T114 | commitOps（缺陷 5） | 人手同时删掉最高编号条目与标记 → 该编号被**复用一次**，随后标记被重写为当前最大编号（也就是刚被复用的那个号），因此只会复用这一次（当前行为钉住，见未验证清单 12） | I2 | 同上 |
| T115 | computeMergeSuggestions | 输出的 ratio 是对称比率且 **≤ 1**（不出现 >100% 的相似度） | I5c | tests/merge.test.mjs |
| T116 | computeMergeSuggestions | 标题相近但正文不同的两条经验**不产生**建议（标题不进 BM25 层） | I5c | 同上 |
| T117 | summarizePlaybook | 正常手册返回完整结构：entries 2、textChars 24、bytes 512、mtime `2026-10-05 08:30`、source.auto 1 of 2（autoRatio 0.5）、daily 固定 14 行、recent 按 updated 倒序 | I4 | tests/stats.test.mjs |
| T118 | summarizePlaybook | 窗口外（14 天前）的条目不计入 daily，但仍计入规模与来源 | I4 | 同上 |
| T119 | summarizePlaybook | recent 最多 5 条，同日按编号倒序 | I4 | 同上 |
| T120 | summarizePlaybook | 空串 → `ok:true` + reason `no-entries`，daily 14 行全零，不抛错 | I4 | 同上 |
| T121 | readPlaybookStats | 只有文档头、没有条目的文件也算 `no-entries` | I4 | 同上 |
| T122 | readPlaybookStats | 文件不存在 → `ok:true` + reason `missing`（不抛 ENOENT） | I4 | 同上 |
| T123 | collectPlaybookStats | 相对 playbookPath 在无会话上下文时 → `ok:true` + reason `needs-session`、pathKind `relative`，不抛错 | I4 | 同上 |
| T124 | collectPlaybookStats | 绝对 playbookPath 走真实读盘，统计结果可用 | I4 | 同上 |
| T125 | stats 工具函数 | formatStamp / dateKey / toDayKey / entryStamp / entryTextChars 的格式化与字数口径（title+condition+action+rationale，不含标记与元数据） | I4 | 同上 |
| T126 | emptyStats ↔ summarizePlaybook | 空态与正常态的**字段集合一致**，客户端不必特判 | I4 | 同上 |
| T127 | StatsBlock | 统计块渲染在 `.ace-set-sub` 之后、第一个 `.ace-set-row` 之前 | I4 | tests/client-stats.test.mjs |
| T128 | StatsBlock | 规模快照（`35 / 100`）、来源构成（0%）、14 天条形图内联宽度（100%/33%/0%）、最近 5 条都按返回渲染，且**文本不含 helpful/harmful** | I4 | 同上 |
| T129 | StatsBlock | `needs-session` 空态只多一行引导，路径仍回显、表单照常可用 | I4 | 同上 |
| T130 | StatsBlock | `reason: 'unreadable'`（读盘失败）只多一行引导：命中 `statsReasonUnreadable` 自己的文案、不串到其它 reason、带文案的灰字行恰好 1 条；规模格/路径/表单照常渲染、不抛错；并做源码级断言 zh 与 en 两个字典都有该词条（渲染断言用的是 DICT 代理，词条缺失看不出来） | I4 | 同上 |
| T131 | StatsBlock | `/stats` 404（宿主没重启）降级成一行灰字，不渲染规模格、不影响整页 | I4 | 同上 |
| T132 | AceSection | 打开页面拉 1 次；点「刷新」变 2 次；保存设置成功后变 3 次 | I4 | 同上 |
| T133 | collectEntries | 空手册 / 只有文档头 / 全文传空串 → `ok:true`、entries 空、total 0、maxEntries 透传，不抛错 | I4 | tests/entries.test.mjs |
| T134 | collectEntries | 正常手册返回全部条目（顺序与手册一致），`auto` 恒为布尔（无 auto=true 的条目是 false 而非 undefined） | I4 | 同上 |
| T135 | toEntry / collectEntries | 字段映射：正文取条目字段、created/updated/helpful/harmful 取 meta；每条 entry 的字段集合与**顺序**固定为 `id,title,condition,action,rationale,auto,created,updated,helpful,harmful`，且 id/正文/日期为 string、auto 为 boolean、helpful/harmful 为 number | I4 | 同上 |
| T136 | toEntry | 缺字段的条目给空串/0/false；`toEntry({})` 稳定；元数据里 helpful 写成非数字回落 0（与 parseMeta 的 `Number(v) \|\| 0` 同口径） | I4 | 同上 |
| T137 | readPlaybookEntries | 文件不存在 → `ok:true` + reason `missing`（不抛 ENOENT），entries 空、total 0 | I4 | 同上 |
| T138 | readPlaybookEntries | 路径是目录（读不成文件）→ reason `unreadable`，不抛错 | I4 | 同上 |
| T139 | collectPlaybookEntries | 相对 playbookPath 在无会话上下文时 → reason `needs-session`、pathKind `relative`、回显原路径，不抛错 | I4 | 同上 |
| T140 | collectPlaybookEntries | 绝对 playbookPath 走真实读盘：条目可用、成功路径不带 reason、pathKind `absolute` | I4 | 同上 |
| T141 | emptyEntries ↔ collectEntries | 降级体与成功体的字段集合一致（只多一个 reason），客户端不必特判 | I4 | 同上 |
| T142 | maxEntries 透传 | 42 / 0 / null / 缺省 / 非数字 / NaN 全部按「有限数原样、其余 null」处理；`collectPlaybookEntries` 与 `emptyEntries` 都透传 | I4 | 同上 |
| T143 | lib/entries.js 只读红线 | 剥掉注释后源码里**不出现** withLock / withExclusiveLock / withFileLock / writeFileAtomic / writeFile / writeFileSync / rename / appendFile / mkdir / commitOps；只 import playbook.js 与 playbook-path.js（不另写 Markdown 解析） | I4 | 同上 |
| T144 | GET /entries | 200 响应体形状正确：`ok:true`、entries 全量、total 与 entries 长度一致、maxEntries 透传、每条 entry 字段集合固定（经 JSON 往返后仍成立） | I4 | 同上 |
| T145 | GET /entries（源码级） | `lib/index.js` 的 /entries 分支：非 GET → `send(405, { error: 'method not allowed' })`；走 `collectPlaybookEntries(live.playbookPath, { …, maxEntries: live.maxEntries })` → `send(200, entries)`；catch 走 `emptyEntries(ENTRIES_REASONS.unreadable, …)`；分支里无 `send(500`、无 `throw`；`rejectionFor` 围栏排在分支之前；Content-Type 与 `cache-control: no-store` 与其它路由共用同一个 send | I4 | 同上 |
| T146 | GET /stats（源码级） | catch 兜底不再是残缺的 `{ ok:true, reason:'unreadable' }`，改为 `emptyStats(STATS_REASONS.unreadable, { maxEntries: live.maxEntries })`（scale / daily / recent / source / windowDays / generatedAt 全在） | I4 | 同上 |
| T147 | AceSection 设置 GET | 围栏 403 `{ error: 'forbidden' }`（或 HTTP 200 但 `ok !== true`）→ 一律 `failed` 文案，**不许**渲染成全默认值并在底栏声称「当前值来自插件行 Config」；正常返回照常渲染（回归：客户端不再把拒绝体喂给 adopt） | I4 | tests/client-stats.test.mjs |
| T148 | AceSection Switch / FieldRow | 开关的可访问名恒为字段名（`aria-label` 不随状态变化），状态只走 `aria-checked`；FieldRow 的 label 用 `htmlFor` 指向真实存在的控件 id（input / role=switch / 带 `aria-labelledby` 的下拉触发按钮） | I4 | 同上 |
| T149 | AceSection bounds | `maxEntries` / `autoRecapThreshold` / `autoRecapCooldownTurns` 的 input `min`/`max` 与文案里的数字都取自 `payload.bounds`，**默认值也取自 `payload.bounds.defaults.maxEntries`**（placeholder 与文案里的「默认」都由它填，客户端不留字面量）；bounds 缺失（老宿主）回退 1/1000 与默认 100 | I4 | 同上 |
| T150 | AceSection inbox | 「待合并已满」文案的条数读 `/inbox` 的 `cap`（缺失回退 20），不再写死「20 条」 | I4 | 同上 |
| T151 | EntriesPage reason 三分派 | `reason: 'missing'` → 「手册尚未创建，还没有任何记录」；`'needs-session'` → 「手册配置为相对路径，在无会话的 HTTP 面无法定位」；`'unreadable'` → 「手册文件读取失败」。三者互不相同，且 missing ≠ 空手册的 entriesEmpty 文案 | I4 | tests/client-entries.test.mjs |
| T152 | EntriesPage 排序 | `updated` 是纯空白串时与「缺失日期」同等处理：升序/降序都恒定排末尾（旧实现不 trim，纯空白串会跑到升序最前） | I4 | 同上 |
| T153 | AceSection tablist 键盘 | ArrowLeft / ArrowRight 循环切页、Home / End 跳首末，移动后焦点交给新选中的 tab；无关按键不切页（roving tabindex 必须有方向键，否则键盘用户只能停在当前 tab） | I4 | 同上 |
| T154 | GET /inbox（源码级） | 读盘失败的降级体带 `reason: 'unreadable'`，字段集合与成功路径一致（降级体 = 成功体 + reason），不再与「真的没有待合并条目」同形被静默吞掉 | I4 | tests/entries.test.mjs |
| T155 | GET /entries（源码级） | catch 降级体补 `pathKind: playbookPathKind(live.playbookPath)` 与 `playbookPath: live.playbookPath`，与成功体的 7 键同形 | I4 | 同上 |
| T156 | GET /catalog（源码级） | 包了 try/catch：readCatalog 抛错时回 `{ ok:false, error, providers: [] }`（照抄 lib/catalog.js 的失败体形状），绝不因 async handler 抛错而无人写响应让浏览器挂到超时；非 GET 仍 405、成功路径仍在 | I4 | 同上 |
| T157 | playbook applyOps `today()` | 写入的 created/updated 走**本地时区**口径（与 lib/stats.js 的 dateKey 一致）：把时钟钉在 `2026-03-04T23:30Z`、TZ=Asia/Tokyo 时 update/add 写入的都是 `2026-03-05`（UTC 口径会得 `2026-03-04`，落进前一天的统计桶） | I4 | tests/playbook.test.mjs |
| T158 | summarizePlaybook recent | 同日按编号**数值**倒序：`ace-1000` 排在 `ace-999` 之前（字符串序会反过来）；`recentIdNumber` 取尾号，非 `ace-N` 编号回退 -1 | I4 | tests/stats.test.mjs |
| T159 | 默认值唯一边界出处 | `describe()` 的 `bounds.defaults.maxEntries === DEFAULT_MAX_ENTRIES`（源码里不许写死数字），客户端不再有 `maxEntriesPlaceholder` 字面量与「默认 100 / default 100」文案；实测传 `bounds.defaults.maxEntries = 250`（再换 7）时渲染出的 placeholder 真的跟着变，字典 zh/en 两侧都用 `{d}` 占位 | I4 | tests/client-stats.test.mjs · tests/entries.test.mjs |

## 迁移矩阵

**结论：手册无迁移问题；设置文件有一处位置迁移（T44–T46 覆盖）。**

- **手册**：本身就是人可读的 Markdown，格式演化策略是「解析器向后兼容」（无法识别的行保真保留，见 T02/T03），不需要迁移脚本。**位置默认值从 `<workspace>/.ace/playbook.md` 改为本机共享层 `<DSH home>/ace/playbook.md`，不做任何文件搬迁**——旧位置的手册原样留在原处，想继续用它就把 `playbookPath` 填回 `.ace/playbook.md`（相对路径），或填它的绝对路径。
- **设置文件**：位置从 `$DSH_HOME/dsh-ace.json`（所有 profile 共用）改为 `<profileDir>/dsh-ace.json`（跟随 profile）。`apply()` 初始化时调一次 `migrateSettingsFile`：新位置不存在且旧位置存在且两者不同路径时，把旧内容原样复制过去（临时文件 + rename、`mode 0o600`），旧文件保留不删；新位置已存在绝不覆盖。迁移的内容不做字段转换——读侧 `normalizeSettings` 本来就会丢弃无效字段。真实触发需重启 DSH（见未验证清单 7）。

## 消费方契约测试

**结论：单测覆盖不到与宿主的接缝，以「真实范例对拍」为契约，装进 DSH 后人工验证（见未验证清单）。**

| 契约 | 依据（真实范例） | 验证方式 |
| --- | --- | --- |
| 入口导出 `name/inject/apply/Config`，`name` 与 cordis.patch.yml 行 id 一致 | dsh-tool-todo 入口同款三件套+Config | 静态对拍（已做） |
| 工具经 `defineTool` 构造后 `ctx.tools.register` 注册，参数为 per-property spec | dsh-tool-todo 的 todo_write | 静态对拍（已做）；真实注册装后验 |
| Config 为 schemastery schema（cordis 以 `~standard.vendor === 'schemastery'` 识别） | dsh-tool-todo 的 Config 声明 | 静态对拍（已做）；设置页渲染装后验 |
| `ctx.llm.stream` 用户消息 content 为文本块数组、收集 text-delta | dsh-llm 类型定义 | 静态对拍（已做）；真实调用装后验 |
| `peerDependencies` 由安装器链接宿主包 | dsh-raw-html-v2 同款声明 | 装后验 |

## 人工 review 项

**结论：以下各项静态检查无法证明，装入 DSH 后逐条确认。**

- [ ] `dsh plugin add` 后三个工具出现在模型工具列表且可调用；
- [ ] 首次 `ace_playbook` 自动创建本机共享手册 `<DSH home>/ace/playbook.md`（Windows 上 `C:\Users\<你>\.dsh\ace\playbook.md`）且带文档头，`ace` 子目录由写入自动创建；`playbookPath` 填 `.ace/playbook.md` 时改为在该工作区创建；
- [ ] `ace_reflect` 真实走通 LLM 并返回候选（跟随会话模型）；
- [ ] `ace_curate` add/update/remove 真实落盘，人工用编辑器同时打开手册观察原子替换；
- [ ] 系统提示段出现在会话系统提示中，`autoReflect: false` 时不出现；
- [ ] 设置页能渲染并修改配置字段；手册路径输入框留空时 placeholder 为「留空 = 本机共享手册；相对路径 = 该工作区私有」，容量输入框 placeholder 为 100；
- [ ] 设置页的两个模型下拉能展开、搜索、键盘上下+Enter 选中、Esc/点外部关闭、清空回「跟随会话模型」；
- [ ] 只填一项时橙色警告出现，两项都填或都空时消失；
- [ ] `GET /api/dsh-ace/catalog` 在真实宿主上返回 providers 与 models（需重启 DSH 后验证）；
- [ ] 重启后 `GET /api/dsh-ace/settings` 的 `file` 字段为 `<profileDir>/dsh-ace.json`（如 `C:\Users\adkun\.dsh\profiles\web\dsh-ace.json`），且旧文件 `$DSH_HOME/dsh-ace.json` 仍在、内容未变。

## 未验证清单（如实声明）

1. 真实工具注册与调用效果（需要运行中的 DSH 宿主，本任务环境不允许执行安装命令）；
2. `peerDependencies` 在 `dsh plugin add` 流程中的实际链接结果；
3. LLM 提示词的实测产出质量（Reflector/Curator 输出稳定性需真实会话观察）；
4. 官方架构文档（GitHub docs/）未抓取核对——全部 API 出处以本机 checkout 源码为准，出处清单见各源文件头注；
5. 设置页两个下拉的**真实浏览器交互**未点击验证：本机没有 react / react-dom（`require.resolve` 失败），测试改用 tests/client-picker.test.mjs 里自带的迷你 React（createElement/useState/useRef/useEffect + 假 document/fetch）加载 client.js 做逻辑级验证（T30–T36），**没有真实布局、样式与焦点行为**——CSS 观感、面板定位与 z-index 仍需在浏览器里目视一次；
6. `GET /api/dsh-ace/catalog` 的**真实宿主返回**未验证：改动在 `lib/index.js`，要重启 DSH 才生效，而本任务不允许重启（当前 GUI 就跑在该进程上）。
7. **设置文件迁移的真实一次运行未验证**（T37–T47 只覆盖纯逻辑）：`migrateSettingsFile` 的真实触发需要宿主进程里 `profileContext` 可用、且新旧两个位置同时存在——单测用注入的假 ctx 与临时目录模拟，**没有在真实 DSH profile 上跑过一次**。同理，T47 的文件权限断言在 Windows 上被 skip（NTFS 不体现 POSIX 权限位，`mode 0o600` 只对新建文件尽力而为），该口径在 Windows 上**未验证**；`resolveSettingsFile` 在真实宿主上取到的是否确为 `$DSH_HOME/profiles/<name>`，同样要重启 DSH 后看一次设置页的 `file` 字段才能确认。
8. **共享层手册在真实宿主上的首次创建未验证**（T48–T56、T74 只覆盖纯逻辑）：`resolvePlaybookFile` 的解析链用注入的 env/home 测过，但「首次读手册时 `<DSH home>/ace` 目录由 `writeFileAtomic` 的 mkdir 补出来、并在写锁内完成初始化」这条要在真实宿主上跑一次 `ace_playbook` 才能确认；同理 `profileContext.home` 在真实 profile 里是否真有值、是否等于 `C:\Users\<你>\.dsh`，也要装后看一次系统提示里打印的手册路径。
9. **跨进程文件锁**：T57–T73 是进程内用例；另做过手工验证（真实子进程，脚本放系统临时目录，验证后已删除）——① 三写者并发、其中一个持锁 800ms 超过 staleMs：`counter = 3`（不丢写）、临界区不重叠（日志顺序 ENTER A → RELEASED A → ENTER C → RELEASED C → ENTER B → RELEASED B）、目录里无 `.lock` 残留；② 活锁不被抢：A 持锁 3000ms、B 在 500ms 进入，B 一直等到 A 释放后才进入临界区，`counter = 2`；③ 持锁子进程被 `SIGKILL` 强杀后，下一个写者 **16–30ms** 内回收了陈旧锁（靠 `process.kill(pid,0)` 判活，不必等满 10s）。**仍未验证**：真实 DSH 多实例（两个 `dsh web` 进程）同时 curate；`LOCK_TIMEOUT_MS`（30s 放弃）在真实争用下的表现；「活锁者等满 30s 后超时失败」这条在真实宿主上的用户体验；`restoreLock` 在**真实跨卷**（C: → D:）下的放回路径——T73 只在同卷上验证了「link 失败也走兜底」这条分支，没有真的跨卷跑。
10. **会写手册的三条写入路径把冲突回报给用户的那句话，未在真实宿主上目视确认**：`ace_curate` 的 `conflicts` 字段与 render 文案、自动复盘与 `/ace` **默认复盘分支**共用的 `sendNotice`（首选 `agent.followup`，退回 `agent.inject`），代码路径与文案已定（见 lib/index.js 的 `renderConflictNotice`/`conflictMessage`/`sendNotice`），但「用户真的看到了这条提示」要装进 DSH 后触发一次并发 curate 才能确认。（`/ace review` 不在其中：它只读 merge-inbox 并把条目注入对话，既不写手册也不做冲突判定。）
11. **自动复盘在真实宿主上「真的落盘」仍未验证**：原实现的疑点已定位并修掉——`agent.runMaintenance` 只在 idle 相位合法（宿主 `~\@deepseek-ai\dsh-agent-loop\lib\index.js:823`），而 `agent/turn-stopping` 派发时 phase 是 running（同文件 `:939`），所以自动复盘此前必然以「already has active work」失败（共享手册里 `auto=true` 条目数为 0 与该推断一致）。现在触发点已迁到 `agent/status` 报 idle 的空闲边沿（见 DESIGN.md I9），T99–T109 只覆盖纯逻辑与模拟宿主：**真实宿主上跑一次自动复盘、确认手册里真的多出 `auto=true` 条目，仍需装进 DSH 后实测**（本任务环境不允许重启宿主）。同理，idle 边沿与新唤醒之间的竞态退避（`already has active work` → 放回队列 → 下一个 idle 边沿重试）在真实宿主上的实际发生频率也未观测。
12. **条目编号在「人同时删最高编号条目 + 删高水位标记」时会复用一次**（已知限制，不修）：历史最大值只存在于手册文档头的那行 `<!-- ace:id-highwater: N -->` 标记里，条目被删掉之后无法从文件本身恢复，因此这两种删除同时发生时该编号可能被复用一次（随后标记被重写成当前最大编号，也就是刚被复用的那个号，因此只会复用这一次）。T114 把这一当前行为钉住；README「已知限制」与 DESIGN.md 的 I2 都已按此措辞写明。**没有**实现「从别处猜回历史最大值」的机制——那需要额外持久化历史，会超出增量演化的边界。
13. **只读统计端点 `GET /api/dsh-ace/stats` 的真实宿主返回未做 HTTP 验证**：改动落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效（当前 GUI 就跑在这个进程上，本任务环境不允许重启宿主）。已做的替代验证是纯函数与客户端两侧的单测（T117–T132）：返回值形状、四种降级（needs-session / missing / no-entries / unreadable）、以及统计块在 404 时的降级都钉住了，但**端点本体的真实响应体、以及统计块在真实浏览器里的观感（CSS 布局、14 天条形的宽度与对齐）未目视**。等宿主重启后人工确认：打开设置页 → 「ACE 手册」，应看到条目数显示为 `N / 100`、路径为本机共享手册绝对路径、14 天条形图有非零行、auto 占比 0% 且旁边有「自动归档尚未落盘过」灰字。
14. **只读条目端点 `GET /api/dsh-ace/entries` 的真实宿主返回未做 HTTP 验证**：改动同样落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效。已做的替代验证是 T133–T145：纯函数与只读 IO 直接跑（分支本体只做「调它 + send」），分支的围栏顺序、405、错误体与 Content-Type 用源码级断言钉住；**端点本体的真实响应体、以及「记录列表详情页」在真实浏览器里的渲染未目视**。等宿主重启后人工确认：`GET /api/dsh-ace/entries` 应返回 `{ ok:true, entries:[…全量…], total:N, maxEntries:100, pathKind, playbookPath }`；手册路径为相对路径时应返回 `{ ok:true, reason:'needs-session', entries:[], total:0, maxEntries:100 }` 而不是 500。