---
title: dsh-ace 测试指南
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-27
---

# 测试

## 运行方式

**结论：`npm test`（即 `node --test tests/`），无网络、无构建、秒级完成。**

```
npm test
```

当前 **744 条用例：743 通过 + 1 条在 Windows 上条件跳过（T47 文件权限位，见未验证清单 7）**，`duration_ms` 约 6.1–6.8s（第 55 轮实测 6.1215s / 6.7998s，`node --test tests/`，**45 个测试文件**，无网络无构建；第 45 轮起每轮施工后都要重跑全量并同步本行——红线 20，最新一轮明细见下方「第 55 轮」段落）。**第 33 轮「拆除正负评分 → 最少使用淘汰」净减 78 条**：整份删掉 tests/gate.test.mjs（19 条，三层可复用性闸门）与 tests/probation.test.mjs（13 条，考察位）；重写 tests/recap-usage.test.mjs（25 → 12 条，计分/结算/pendingIds 那一整层换成命中账本 + 回合边界落盘 + 毫秒时间戳）、tests/trigger.test.mjs（47 → 46 条，删 C2 三档信号整段）、tests/playbook.test.mjs（净分与归档区章节相关用例删掉）、tests/archive.test.mjs（40 → 21 条，三判据整层换成绩效判据 = 淘汰顺序 + 独立归档文件）、tests/inject.test.mjs（16 → 17 条，排序键换纯 BM25）、tests/injection-flow.test.mjs（9 → 8 条）、tests/recap-pipeline.test.mjs（20 → 12 条，候选过滤与合并/淘汰重写）、tests/e2e.test.mjs（7 → 8 条）；整份新增 tests/prompts.test.mjs（5 条），tests/merge.test.mjs 由 10 条扩到 17 条。
**本会话第三轮「3 条验收遗留项修复」再净增 4 条（T188–T191）**：tests/trajectory.test.mjs 由 23 条增至 25 条（+2：退化分支的省略数恒等于真实丢弃数、整条 summary ≤ maxChars）、tests/trigger.test.mjs +2（await 窗口内挂上新待办时旧 pending 回滚不吞新待办、同一份待办重复放弃只生效一次）。总数从 238 → 242（241 通过 + 1 skip）。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第四轮「3 条验收新缺陷修复」再净增 7 条（T192–T198）**：tests/trigger.test.mjs 由 23 条增至 27 条（+4：新待办已被另一个空闲边沿取走时迟到回滚被拒、`restorePendingMutCount` 正常路径只还计数不回滚冷却、`restorePendingMutCount` 遇到更新的待办时一个字段都不动、requeue 后再次 take 同一份待办再放弃仍生效）、tests/recap.test.mjs 由 13 条增至 15 条（+2：失败分支只在待办仍归我时才还计数、两个空闲边沿交错时迟到的 skipped 回滚被拒且不谎报已还回）、tests/trajectory.test.mjs 由 25 条增至 26 条（+1：`maxChars` 小于计数行长度时以保证计数行完整为准）。总数从 242 → 249（248 通过 + 1 skip）。同时既有 3 条用例按新事实改期望（`createRecapState` 初始状态多了 `pendingSeq: 0`；`recordTurnEnd` 挂的待办多了 `seq`，T90/T190 与 recap 的「空闲边沿才真正触发复盘」同步），只换期望值、未放宽也未删除任何断言。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第五轮「4 条自动复盘回滚缺陷修复」再净增 8 条（T199–T206）**：tests/trigger.test.mjs 由 27 条增至 33 条（+6：`requeuePendingRecap` 遇到更新的待办时明确拒绝放回、耗尽分支也不许抹掉队列里那份、`restorePendingMutCount` 幂等、两条回滚路径共用已结算账本、`requeuePendingRecap` 不算结算、`ownsPending` 旧形状兜底在代次已前进时一律不认），tests/recap.test.mjs 由 15 条增至 17 条（+2：撞忙回队时不覆盖更新待办且不谎报「已放回队列」、撞忙重试到上限时仍保留队列里那份更新的待办）。总数从 249 → 257（256 通过 + 1 skip）。**这一轮没有改动任何既有用例**：新增的所有权判定只拦「本就不归自己」的调用，既有手工构造旧形状待办的用例都走 `pendingSeq === 0` 那一档，全部照旧通过。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第六轮「记账覆盖未执行待办」再净增 7 条（T207–T213）**：tests/trigger.test.mjs 由 33 条增至 38 条（+5：队列里还压着没执行的待办时合并计数、合并后回滚还回最老那一笔的原值、覆盖合并必须留痕、`recordTurnEnd` 的 logger 可选、合并后迟到的 abandon/restore/requeue 一律被拒且一个字段都不动），tests/recap.test.mjs 由 17 条增至 19 条（+2：撞忙回队 + 冷却期内记账 → 下一轮触发合成一份待办、合并后的待办被放弃时冷却回最老原值且额度不白吃）。总数从 257 → 264（263 通过 + 1 skip）。**为什么**：`recordTurnEnd` 是唯一挂新待办的地方，它原来无条件 `st.pendingSeq += 1` + `st.pending = {…}`，而队列里完全可能还压着一份从没执行过的待办（上一回合挂了、空闲边沿撞忙又放回来、冷却还没到）——那一整轮的 mutating 计数就此静默蒸发，日志里一个字都没有。改成合并之后，除「计数相加」外还有两条容易被忽略的不变量被用例钉住：`prevLastRecapTurn` 必须取**旧**待办那份（最老那一笔推进之前的值），否则放弃时会把冷却还回到旧待办那一轮、白吃中间几回合；旧待办的 `seq` 被顶替之后必须再也结算不了，否则**已经并进新待办的那几次计数会被再还一遍**、额度凭空翻倍。**这一轮没有改动任何既有用例**（没有换期望值、没有放宽也没有删除断言）：合并只在「队列里真压着待办」时生效，既有 `recordTurnEnd` 用例的队列都是空的，走 `queued === null` 那条分支，行为与改动前逐字相同。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第七轮「在飞旧待办的额度蒸发（F1）+ 两条硬化」再净增 8 条（T214–T221）**：tests/trigger.test.mjs 由 38 条增至 44 条（+6：F1 过继给队列里那份新待办、F1 队列已空时还回状态但不动冷却、F1 同一份待办被三条路径连拒只过继一次、F1 已被合并吸收的旧待办不许再过继、H1 负数/垃圾 `mutCount` 一律按 0、H2 畸形 logger 各种形状都不抛），tests/recap.test.mjs 由 19 条增至 21 条（+2：F1 端到端 skipped 变体、F1 端到端 busy 变体且不许静默）。总数从 264 → 272（271 通过 + 1 skip）。

**本会话第八轮「通知消息 content 形状修复 + 两条 trigger 硬化」再净增 10 条（T222–T229 + T230/T231）**：新增 tests/notice.test.mjs 8 条（T222–T229，纯模块直测 + 对 lib/index.js 的源码级断言）、tests/trigger.test.mjs 由 44 条增至 46 条（+2：H3 过继搬移抛错时额度不蒸发、账本也没封；H4 负数 mutCount 不许把 st.mutCount 往回拽）。总数从 272 → 282（281 通过 + 1 skip）。**这一轮修的是一个会让整个会话永久坏死的缺陷**：自动复盘失败时注入的通知消息把 `content` 传成了裸字符串，宿主 `createUserMessage` 不校验形状（`~\@deepseek-ai\dsh-llm\lib\types\message.js:34-39` 的 `createMessage` 只 spread + `deepFreeze(structuredClone)`、`:53-58` 的 `createUserMessage` 只补一个 `role`），于是字符串原样进了会话历史；此后宿主里 52 处 `.content.some(...)` 拿它当数组调用抛 `TypeError: message.content.some is not a function`，而每一轮重建上下文都要遍历历史，这条毒消息让会话再也开不起来（用户再发「继续」照样失败）。三处注入点（`conflictMessage`、自动复盘失败通知 `notifyFailure`、`/ace review`）改为经新增的零 import 模块 lib/notice.js 的 `noticeMessage()` 构造 `ContentBlock[]`，**文案与 source 一字未改**——这是形状修复，不是文案改版（T229 守着文案，T227/T228 守着形状）。**T227 的定位要说准**：它是「防手滑把 content 写回裸字符串」的**绊线**，不是「证明形状正确」的**证明**——它不推理、不是类型检查器，已知至少 5 个刻意绕过时的漏点（`content: [text]` 数组里塞裸字符串、`content: textBlocks(t) + ''` 把返回值拼成字符串、`content: noticeMessage({text}).content.join('')` 取完又拼回去、别名调用 `const cum = createUserMessage; cum({...})` 计数 0 完全看不见、`createUserMessage(['just a string'])` 数组元素形状不管）；它的价值在「有人为了让自己过而放宽它」时提醒：放宽等于拆掉唯一的绊线（它取的是 `content:` 之后的**首个非空行**，所以 `createUserMessage(\n  noticeMessage({...}),\n)` 这类跨行合法写法不会被冤枉）。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。

**本阶段「第三阶段：接线 + 可观测 + 归档展示 + 端到端演练」净增 8 个测试文件 / 全量 439 条（438 通过 + 1 skip）**。前两阶段（C1–C5）新增 7 个纯模块测试文件：tests/archive.test.mjs（27）、tests/inject.test.mjs（16）、tests/injection-flow.test.mjs（7）、tests/ledger.test.mjs（5）、tests/prompt-section.test.mjs（14）、tests/recap-pipeline.test.mjs（14）、tests/reflect.test.mjs（13）；本阶段（C6）新增 tests/e2e.test.mjs（7）。同时扩了三个既有文件：tests/client-stats.test.mjs 由 16 增至 20（+4：运行统计六项渲染、归档按原因四值分列、runtime 缺失只留灰字、不复用既有类名）、tests/client-entries.test.mjs 由 19 增至 24（+5：默认活跃/切到已归档、展开显示原因与日期、archived 缺失按空处理、未知原因回显原串、21 键 zh/en 齐全）、tests/stats.test.mjs 与 tests/entries.test.mjs 补了 runtime / 归档分区的接口形状断言。**基线演进**：383/382/1（阶段 0）→ 393 → 400 → 420 → 427 → 428 → 439（本阶段收尾）。**本阶段唯一被改动的既有断言**是 tests/client-stats.test.mjs 的「归档原因恰好三个占位符」——P0-1 起 `op:'remove'` 也搬进归档区、归档原因变成四个值（多一个 `removed-by-request`），该断言随之放宽为「四个占位符都在」（这是加宽而非放松：新增的第四项同样被逐个 assert.match 钉住）；其余既有断言**一条未改、一条未放宽**。

**后续两轮「注入账本要跨回合结算（B1/B2）+ 四条并发口径（D1–D4）」再净增 1 个测试文件 / 11 条 / 全量 450 条（449 通过 + 1 skip）**：新增 tests/recap-usage.test.mjs 9 条（回合边界结算的九种情形，见下表）；tests/injection-flow.test.mjs 由 7 条增至 8 条（+1：**D4｜子代理注入照常渲染但绝不进命中账本**）；tests/recap-pipeline.test.mjs 由 14 条增至 15 条（+1：`P0-4｜0 候选回合也不碰账本（D4）`，同时把「流水线自己 take 账本」的旧用例改成 tripwire——`takeUsageIds` 一被调用就抛 `流水线不许自己取账本：注入 id 只能由回合边界取走（D4）`）。**基线演进接着上一段**：439 → 450（449 通过 + 1 skip），测试文件数 25 → 26。既有断言同样一条未放宽：被改的两条是「行为契约变了」（取走点从流水线搬到回合边界），新断言比旧的更严格。

**再后一轮「在飞结算与归档抢跑（P1）+ 三处硬化（P2）」净增 4 条 / 全量 454 条（453 通过 + 1 skip）**：tests/recap-usage.test.mjs 由 9 条增至 **11** 条（+2：两个空闲边沿重叠时第二个边沿**等同一份在飞结算**、归档扫描不许抢在计分落盘之前——造 net = 1 − 2×2 = −3 正好压 low-score 线，断言没有冲突通知也没有「条目已被删除」warn；同一重叠场景下结算抛错时第二个边沿先等它失败再往下走、错误被吞掉不炸空闲边沿）；tests/recap-pipeline.test.mjs 由 15 条增至 **16** 条（+1：实际计分 0 条时日志写实话，不许出现「命中计数 +1 共 0 条」）；tests/catalog.test.mjs 由 5 条增至 **6** 条（+1：超时不 abort 上游——宿主 `listModels` 没有 `signal`，上游晚到的 reject 必须被吞掉、不许变成 unhandledRejection）。tests/wiring.test.mjs 条数不变（11），但静态求差扫描器补了三处漏判（模板 `${}` 递归扫描、控制流括号不再被当成形参、去掉 `'?'` 跳过），四条假绿通道各有一条人造样本。**基线演进接着上一段**：450 → 454（453 通过 + 1 skip），测试文件数仍是 26（本轮没有新增文件）。

**第八轮「账本结算的前置不变量（D1′/D2′/D3′）+ 扫描器补两条通道（P2-b）+ 0 条日志中性归因（P2-c）」净增 4 条 / 全量 458 条（457 通过 + 1 skip）**：tests/recap-usage.test.mjs 由 11 条增至 **15** 条——新增 4 条**真跑流水线**用例（真 `runRecapPipeline` + 真 `scoreUsedIds` + 真 `commitArchives`，**没有任何 `runRecap` 桩**）：D1′ 结算窗口里又挂上一批注入（账本在窗口里重新长出来）、D2′ 结算窗口里跨过一个完整回合边界（**单个边沿就够**，不需要两个边沿并发）、D3′ 结算失败（锁超时 / 写盘失败）、D3′-上限（连续失败到上限、账本按 B1 的规则丢弃之后才允许跑复盘）；并**改写 1 条旧用例**（原 `P1｜结算失败：本空闲边沿不许「照常跑复盘」…` 原先只是把「失败后照常跑复盘」钉成期望，现在改成新语义，并把执行顺序断言加严为五事件逐字比对）。tests/recap-pipeline.test.mjs 仍是 16 条（P2-c 改的是 0 条那一支的日志措辞，用例未增减）；tests/wiring.test.mjs 仍是 11 条（P2-b 给静态求差扫描器补了两条假绿通道：正则字面量分支——含把 `//` 注释误当空正则吃掉的那处修正，以及逗号表达式间接调用 `sequenceRe`；新增人造样本 4 条，对真文件求差仍是空集）。**基线演进接着上一段**：454 → 458（457 通过 + 1 skip），测试文件数仍是 26。

**第九轮「归档必须读结算后的分数：从时序约定改成数据约束（路线 A）+ 编号复用缺陷」净增 12 条 / 全量 470 条（469 通过 + 1 skip）**：tests/recap-usage.test.mjs 由 15 条增至 **20** 条（+5：结算写盘前被归档扫描抢到锁——probe7-f，写盘前故意慢 40ms 再让第二个边沿扫、刚注入且本回合成功的条目不许被搬走；G——`reflectRound` 等 LLM 的窗口里挂上新一批注入；H——`whenIdle` 期间跨过一个完整回合边界；P2-f——没有 `settleUsage` 实现时守卫不生效但必须留痕、账本原样留着、复盘照常跑；P2-i——守卫日志按 agent 去重，同一份账本连来三个空闲边沿只打一条）；tests/recap-pipeline.test.mjs 由 16 条增至 **20** 条（+4：有候选分支、0 候选分支、满额腾位三条路径都只搬「没人碰过」的条目；P2-g / P2-h——结算撞上并发归档时误报的「已被删除」不进用户通知）；tests/archive.test.mjs 由 27 条增至 **30** 条（+3：`scanArchives` / `commitArchives` / `commitOps` 满额腾位三条路径收到 `pendingIds` 都跳过待结算条目）。**本轮没有改写任何既有用例**（只新增）。**基线演进接着上一段**：458 → 470（469 通过 + 1 skip），测试文件数仍是 26。

**第 28 轮「注入从改写系统提示改成追加式 user 消息（前缀缓存友好）」净增 13 条 / 全量 485 条（484 通过 + 1 skip）**：新增 tests/inject-delivery.test.mjs 13 条（六条行为契约 a–f + 边界，见下表），tests/prompt-section.test.mjs 由 14 条改为 **12** 条（删掉 4 条钉住旧行为的用例——注入块与原提示共存、injection 回调抛错退回、injection 返回畸形对象、logger 抛错——以及 1 条 C4.4 inboxCount 动态句用例，新增 3 条「section 文本与运行状态无关」的用例），tests/injection-flow.test.mjs 由 8 条增至 **9** 条（+1：take 之后没 note → 账本不留幽灵注入），tests/client-stats.test.mjs 仍 20 条（3 条改写 + 3 条新增断言）、tests/client-entries.test.mjs 只同步字典键、tests/stats.test.mjs 由 12 条增至 **13** 条（+1「统计⑥」：`runtime` 十一键**原样透传**非 0 值，钉住 `normalizeRuntime` 里 `injectedBatches`/`injectedAppended` 的取值映射——这条是变异自证 M14 逼出来的：键名拼错或把两个口径混同，原来 43 条用例一条都不红，因为夹具里没有非 0 值、`count()` 补 0 把映射错误伪装成「本来就是 0」）。**本轮改写既有用例逐条理由**（全部是「行为契约变了」，新断言一律更严格，没有一条改成永真、没有一条 equal 改 ok）：
- tests/prompt-section.test.mjs「注入块与原提示共存」：section 的入参契约里已经没有 `injection` 回调，旧断言钉的正是被删掉的行为；替换为「有注入 / 无注入两态逐字相同」。
- 同文件三条 injection 失败安全用例（抛错 / 返回 null·空 text·畸形对象 / logger 抛错）：注入不再经过 section，失败安全搬到 tests/inject-delivery.test.mjs 的 f/f2；旧断言的被测对象已不存在。
- 同文件「C4.4｜merge-inbox 降级为只读报告」：`inboxCount` 动态句同样是随状态变化的文本、同样改写缓存前缀，已从 section 删除；用例改为断言 section **不含**该句（tests/wiring.test.mjs 有一条同向断言钉住）。
- tests/wiring.test.mjs「onInboxCount 必须把数字送到系统提示段」：改为「必须落进 merge-inbox（HTTP /inbox 读得到），且系统提示段绝不许因此变化」——原断言反向，覆盖面不减。
- tests/wiring.test.mjs handlers 事件表：追加 'agent/pre-step'（新增的投递接缝）。
- tests/e2e.test.mjs injectFor：注入不再从 section 取文本，改为驱动真 `agent/pre-step` 处理器；场景 6 另加一条红线断言「section 文本不含【ACE 自动注入】」。
- tests/client-stats.test.mjs / tests/client-entries.test.mjs：注入口径从 1 个数拆成 injectedBatches / injectedAppended 两个数（旧 `injected` 删除，不许两套口径并存）。
语法自检：每个 `lib/*.js` 与 `client.js` 跑 `node --check`。

**第 29 轮「注入消息不进复盘轨迹（自污染防护）」净增 5 条 / 全量 490 条（489 通过 + 1 skip）**：tests/trajectory.test.mjs 由 26 条增至 **31** 条，五条全部**真跑** `renderTrajectory` / `collectTurnTrajectory`（不是源码正则）：
- 注入消息（`source:{kind:'dsh-ace', form:'injection'}`）整条不进轨迹：正文与条目 id 都不出现，且**不计入 `messageCount`**；
- 同一条消息**去掉 source** 后照常渲染（过滤只认 `source`，不认正文——防止「按正文关键词过滤」这种脆做法）；
- 过滤**不许过宽**：`{kind:'dsh-ace', form:'notice'}` / `{kind:'other-plugin', form:'injection'}` / 只有 kind / 只有 form / kind 大小写不同 —— 五种都照常渲染；
- `collectTurnTrajectory` 从真 `session.deriveMessages()` 取到的注入消息同样被跳过；
- 畸形 `source`（null / 字符串 / 数字 / 数组 / 数组包对象 / `{kind:42}`）不抛错、也不误伤。

**本轮没有改写任何既有用例**（只新增）。**基线演进接着上一段**：485 → 490（489 通过 + 1 skip），测试文件数仍是 27（本轮没有新增文件）。

**第 30 轮「考察位（probation）复出通道 + decayed 滞留区兜底」净增 21 条 / 全量 511 条（510 通过 + 1 skip）**：新增 tests/probation.test.mjs 13 条（常量契约 + a–k，全部**真跑** `selectInjection` / `rankInjection`，不是源码正则），tests/archive.test.mjs 由 32 条增至 **40** 条（+8 条 decayed 判据）。见下表两行。
- 考察位要解决的是**闭环缺口**：净分 −1/−2 的条目被 `INJECT_NET_FLOOR = -1` 挡在注入之外，分数就再也没有流入通道，`netScore` 会永久冻在 −1/−2，既不注入也不掉到 −3 被归档 —— 「净分 −1」与「净分 −100」的结局一模一样。考察位给它一条**受控复出通道**（每轮最多 1 条、相关度 ≥ 本轮最高分的 0.6、同一条距上次命中 ≥ 3 天、且只在常规位没挑满 5 条时占位），同进账本、照常加减分。
- 用例 b 与 b2 成对钉住冷却判据是 `>=` 而不是 `>`（2 天前进不去、恰好 3 天能进）；用例 d 钉住「常规位满 5 条时考察位不占位」（总数永不超过 5）；用例 h 走完 `−2 → −1 → 0 → 回常规位` 的完整闭环；用例 i 钉住考察失败 → `−4` → 下一轮 `low-score` 归档；用例 j 钉住考察位 id 必须进账本（否则复出也拿不到分数，闭环还是断的）；用例 k 钉住子代理不进考察位（沿用 `isMainAgent` 门）。
- decayed 兜底是**第二条腿**：考察位也可能一直轮不到（相关度够不上）或根本没人查，所以 `netScore <= -1` 且距上次命中满 `ARCHIVE_STALE_DAYS`（90 天）的条目必须能被 `decayed` 收走。边界用例成对：净分恰好 −1 归档、净分 0 即使 100 天没命中也不归档（净分 0 的条目还能正常注入、会自己挣分）；净分 −4 仍按 `low-score`（判据有优先级）；`lastHit` 缺失用 `created` 计龄兜底、两者都非法不归档（绝不误杀）；`pendingIds` 数据约束对 `decayed` 同样生效。
- 七次变异自证（每次改源码 → 跑 → 写回原文，全部已复原）：去掉冷却判据 → b 红；`>=` 改 `>` → b2 红；相关度门归零 → 常量契约 + c 红；满 5 条也占位 → d 红；删考察位整段 → a/b2/e/f/g/h/i/j/k 九条红；decayed 去掉时间判据 → 「距上次命中 89 天不归档」红；decayed 的净分门放宽到 0 → 8 条红（含 `stale`、`scanArchives`、满额腾位、高水位、`pendingIds`、两条盲区用例）。
- **本轮没有改写任何既有用例**（只新增）。**基线演进接着上一段**：490 → 511（510 通过 + 1 skip），测试文件数 27 → 28（新增 tests/probation.test.mjs）。

**第 31 轮「agent/error 降级为未观测 + 就地结算 + 三层可复用性闸门 + 重复检测中间档 + 提示词反例」净增 21 条 / 全量 532 条（531 通过 + 1 skip）**：新增 tests/gate.test.mjs 15 条（第一层六型、第二层一正一反、第三层降级与降级后空壳、批量只拒坏候选、中间档三档、闸门计数真跑流水线），tests/recap-usage.test.mjs 由 20 条增至 **25** 条（+5：a 成功回合注入 2 条各 +1 / b 紧接 agent/error 回合不计分但 hits+1 且 lastHit 写当天 / c 之后再来成功回合只给 c 回合的条目 +1 / 两回合之间没有空闲边沿也不许合并结算 / 连续两次 provider 抽风不把好条目打出局），tests/stats.test.mjs 由 11 条增至 **13** 条（+2：unobserved 与 gateRejected 原样透传、空态补 0），tests/client-stats.test.mjs 与 tests/client-entries.test.mjs 随文案与格子数同步。
- **本轮唯一被改写的既有用例**是 tests/trigger.test.mjs 的「强失败优先」一条与两条同族断言（classifyTurnOutcome({calls:10,errors:0,error:true}).tier 从 strong 改判 unobserved、outcome 从「失败」改判「未观测」），以及 tests/recap.test.mjs 里同步该判据的两条期望：它们钉的正是被本轮否掉的行为（把 agent/error 当失败证据），属「缺陷被钉成期望」的例外，逐条理由见报告第 31 节。同时**新增**一条「工具报错占比也超标时 weak 优先于未观测」钉住判据顺序。
- tests/e2e.test.mjs 的 runtime 键白名单（「E2E 场景7」那条用例）由 12 键同步为 14 键（任务五第 3 条必然要求；断言仍是键集合 deepEqual 全等，没有放宽）。
- **基线演进接着上一段**：511 → 532（531 通过 + 1 skip），测试文件数 28 → 29（新增 tests/gate.test.mjs）。

**第 32 轮「闸门三处误杀修正（只动 lib/gate.js 的判据）」净增 4 条 / 全量 536 条（535 通过 + 1 skip）**：tests/gate.test.mjs 由 15 条增至 **19** 条（+4：48 码点真实长标题必须放行 + 61 码点必须拒 + 刚好 60 码点放行 / 指代词只在括号里出现必须放行且落盘原文不变 + 半角括号同样剥 / 括号未闭合保守按原判据拒 / 路径整体替换含盘符碎片、相对路径、`文件:行号` 优先级不被抢、`ratio:0.4` 不误吃）。**判据数值只动了 `GATE_TITLE_MAX` 40 → 60**（真实手册最长 48，41–48 的 4 条全是好经验被误杀）；其余判据数值（`INJECT_NET_FLOOR`/`ARCHIVE_LOW_SCORE`/`ARCHIVE_STALE_DAYS`/`PROBATION_*`/`SUPPLEMENT_RATIO`/`BREVITY_MAX_SHRINK_RATIO`）一字未动。
- 既有用例只改了一处文字：原「标题过长（多于 40 码点）」的用例名与断言消息里的硬编码「40」改成按 `GATE_TITLE_MAX` 插值（用例逻辑本来就用常量构造，判定没变）。
- 真实手册只读回放（40 条活跃）：**改前 accept 35 / degrade 11 / 拦下 5（title-too-long 4 + pronoun-condition 1）→ 改后 accept 40 / degrade 13 / 拦下 0**。
- **基线演进接着上一段**：532 → 536（535 通过 + 1 skip），测试文件数 29 不变。

**第 33 轮「拆除正负评分 → 最少使用淘汰」净减 78 条 / 全量 458 条（457 通过 + 1 skip）**：把「正负评分 + 回合成败判定 + 计分时序结算 + 考察位/出局线 + 归档三判据 + 三层闸门」六层整段拆掉，换成「hits 命中计数 + 最少使用淘汰 + LLM 合并 + 归档独立文件 + 毫秒时间戳」。测试侧的动作是**删旧（用户 Q19 已授权）＋ 补等价强度的新用例**，没有一条被改成永真、没有一条标 skip：
- 整份删：tests/gate.test.mjs（19 条）、tests/probation.test.mjs（13 条）；
- 整份重写：tests/recap-usage.test.mjs → 12 条（命中账本 + 回合边界一次原子写盘 + 毫秒时间戳三组）；
- 整份新增：tests/prompts.test.mjs → 5 条（`REFLECTOR_SYSTEM` 四段式、BM25 召回段、输出契约不变）；
- 扩写：tests/merge.test.mjs 10 → 17 条（`MERGE_SYSTEM` 四段式与反例、`parseMergeResult` 七种输入、`survivingEntry`、`planMerges` 永不抛错、`findMergePairs`）。
- 新判据用例（下表标「第 33 轮」的那些）：a 注入投递 +1 且同一批不重复计数、b 只有带 query/id 的定向检索 +1（整本读取不计数）、c 满额先合并、d 合并失败跳过/全失败直接淘汰且落盘照常成功、e 淘汰顺序（hits → created → id）、f 淘汰进 archive.md 且腾位、g 手册里永不出现 `## 归档区`、h 整本读取不含归档条目、i 毫秒时间戳写入→读回→排序，j 空标题拒绝/非空放行，k 注入排序纯 BM25。
- **三条守护用例（用户点名）**：①「同 hits 时老条目先走」（tests/archive.test.mjs，`compareForEviction` 三级顺序）；②「LLM 合并失败绝不许阻塞落盘」（tests/recap-pipeline.test.mjs）；③「毫秒时间戳跨进程仍能正确排序」（tests/recap-usage.test.mjs，两个独立子进程各算一遍）。
- **变异自证十二条**（每条都真跑、跑完即复原）：M1 注入排序键加回 hits 优先 → k 红；M2 `compareForEviction` 删 created 判据 → 守护① + i + 守护③ 红；M2b 同 hits 改 id 降序 → e 红；M3 只拆外层 try/catch → 全绿（内层兜底），内外两层一起拆 → 守护② 红；M4 时间戳去掉毫秒 → 9 条红；M5 时间戳比较截到日 → i 与守护③ 红；M6 检索计数门改成恒真/恒假 → b 红；M7 手册与归档合成一次写 → 8 条红；M8 标题判据改成恒假 / 加回长度上限 → j 红；M9 `delivered` 去重失效 → a 三条红；M10 合并改成保留更晚那条 → c 等三条红；M11/M12 提示词删掉 BM25 段与反例 → prompts 两条红。

**第 45 轮「满额复盘 120s 必超时修复：tf 缓存 + 配对矩阵 + LLM 预算贯通」净增 15 条 / 全量 632 条（631 通过 + 1 skip，约 6.7s）**：新增 tests/llm-budget.test.mjs 3 条（假 provider 挂到 signal abort 再 throw：maxMs 生效且报错文案用实际 cap「单次上限 80ms」、maxMs=0 当没传 + 外层 signal 先断原样 rethrow、预算之内正常流照常返回）；tests/merge.test.mjs 17 → 22（+5：`computePairRatios`+`pairRatioAt` 与旧 bodyRatio 重抄锚 25 对逐位等——锚必须先 `projectBody` 再比；手工 stub 钉死「双向比率都超 1 必须钳到 1、子 1 比率原样透传」；findMergePairs 矩阵版与旧实现同配对（3+1 条目仍只成 a↔b 一对）；planMerges 预算闸三条：起点不足 asked=0+warn、首对成功后预算见底只合并这一对且 failed=0 部分结果照常返回（红线 12）、无 budget 时 ask 不带 maxMs 老调用方不变）；tests/recap-pipeline.test.mjs 21 → 26（+5：预算见底时**第一轮照旧发起且不派 maxMs**、第二轮闸抛「复盘剩余预算不足…第 2 轮不再发起」+ 按已有候选落盘；预算充足每次调用带 maxMs（第一轮 ≈112s = 120s−8s 落盘保底）；满额扣合并预留（maxMs ≈72s = 120s−40s−8s）；无 deadlineAt 行为与旧版一致）；tests/recap-queue.test.mjs 10 → 11（+1：run 收到第二参 `{deadlineAt}` ≈ startedAt+totalDeadlineMs）；tests/playbook.test.mjs 80 → 81（+1：tf 缓存同语料冷 → 热 → 被挤掉再冷打分逐位一致）；tests/trajectory.test.mjs 条数不变但 :510/:520 源码级断言同步为 `executeRecap({ agent, summary, signal, deadlineAt: budget?.deadlineAt })`（只加字段未放宽）。
- **这些用例对应的验收行为**（给读测试的人）：① 满额 100 条手册下配对是 O(N) 次全语料打分而不是 O(N²) 次（真实手册探针：findMergePairs(0.5) 78–110s → 53ms，配对完全一致、比率仅小数第三位 idf 微漂移且同侧过阈；computeMergeSuggestions(99+1) 966ms → 241ms）；② 预算见底时复盘「及时止损」——已有候选照常落盘、已合并的部分照常落盘，且**绝不空手假成功**（第一轮永不拦：预算再紧，一个候选都没有的复盘也必须真跑）；③ 单次 LLM 调用超时超的是**自己的 maxMs**（外层 signal 未断），报错前缀「ace: LLM 调用超时（单次上限 Nms）」不变，`lib/reflect.js` 的 `isTimeoutError` 仍认这个前缀按已提炼候选收尾。
- **变异自证 M1–M5**（每条真跑、跑完逐字复原、备份哈希核对 IDENTICAL）：M1 planMerges 预算闸条件改恒不触发 → merge 红 2；M2 oneShot 忽略 maxMs → llm-budget 红 3；M3 tf 缓存的 tf 恒写 1 → **playbook 红 1（第 38 轮朴素实现独立打分锚抓住）**——如实记：merge 的矩阵对照锚不红，因为锚与被测共用同一个生产 scoreEntries、同源漂移互相抵消，口径的牙齿在独立锚上；M4 pairRatioAt 去掉钳 1 → merge 红 1（stub 钳 1 断言；真实语料里双向超 1 几乎不会自然出现，牙齿必须是构造出来的）；M5 recap-queue 去掉第二参 deadlineAt → recap-queue 红 1。另有 M0（自然发现）：首版把第一轮复盘也纳入预算闸 → recap-hang 红 2，修成「第一轮永不拦」后全绿。
- 落钉文件：FIX-REPORT-R45.md（根因实测数字、性能表、已知边界：真实宿主端到端未验证、预算常量是推算值非真机统计、merge-inbox 陈旧建议未修）。

**第 46 轮「记录页手动归档单条（两段式确认）」净增 12 条 / 全量 644 条（643 通过 + 1 skip，约 6.5s）**：只加写路由与按钮，仓库里没有任何文件被改判据——淘汰判据、注入排序与预算、容量口径、四个归档原因、解析层全部一字未动。新增用例分两处：

- tests/wiring.test.mjs 12 → **18**（+4 第 46 轮 +2 第 47 轮，真 import `lib/index.js` 打真 `POST /api/dsh-ace/entries/archive`，每个用例自己的临时子目录，绝不读写真手册）：① 真落盘——活跃区少一条、`archive.md` 多一条且 `archive.reason === 'removed-by-request'`、正文（title/rationale）逐字不丢、返回体 `{ ok:true, archived:{ id, reason, date } }` 与盘上一致；② 归档后 ID 高水位仍算上归档侧——紧接着 `ace_curate` 新增拿到 `ace-003` 而不是复用刚归档的 `ace-002`；③ 记账与日志——`/stats` 的 `runtime.archived` 0→1、`runtime.archivedByReason['removed-by-request']` 0→1、七键集合不变，且有且只有一条 `dsh-ace: 手动归档 1 条（…）` 的 info 日志、数字与 `/stats` 对得上；④ 失败路径一律结构化非 2xx —— 不存在 → 404、非法形状（`ace-` / `ace-abc` / `001` / `ace-001x` / 空串 / 纯空格 / 数字 / null / 缺体）→ 400、`GET /entries/archive` → 405（`GET /entries` 仍 200，两条精确串不互相吃掉）、围栏（Host 非回环 / `sec-fetch-site: cross-site`）→ 403，且每一条都断言该条仍留在活跃区、盘没动。测试侧唯一改动是 `callRoute` 加了可选第四参 `{ body, headers }`（真发 `data` 事件喂 JSON）。
- tests/client-entries.test.mjs 26 → **36**（+8 第 46 轮 +2 第 47 轮，沿用文件自带的迷你 React 渲染夹具）：首点变红「确认」且**零写请求、零刷新**；二点才发一次 `POST`（请求体 `{ id }`），成功后 `reload()` 并清空 pending；失败（服务端 404 与 fetch 直接抛错两种）都在页面上留一行 `.ace-entries-note` 可见报错并退回初始态；点另一条 / 切分区 / 点页内别处 / 点刷新 四种「点别处」都把悬空确认态复位；样式表层面的颜色断言（`.ace-entries-archive-btn.is-confirm` 必须是独立规则、深红底 `#3b1418` + 亮红字 `#ff8b8b` + 红边 `#7f1d1d`、悬停态更深，并用相对亮度公式实算 WCAG 对比度 ≥ 4.5:1）；归档分区仍只读（不渲染归档按钮、按钮文案里也不出现「归档 / 确认」）。
- **变异自证 2 条**（真跑、跑完逐字复原、SHA256 核对 IDENTICAL；计数用 `--test-reporter=tap` 的 `not ok`）：M1 client.js 把「首点只置 pending」的分支改成恒假（等于首点直接发 POST）→ tests/client-entries.test.mjs 红 5；M2 lib/index.js 新路由的 `method !== 'POST'` 405 守卫改成恒假 → tests/wiring.test.mjs 红 1。
- 本轮的判断口径（写进 DESIGN.md「记录列表页：手动归档一条」小节）：原因复用既有 `removed-by-request`（不加第五种）、写入完整复用 `commitOps`（applyOps 的 remove 路径 + 先 `appendArchivedEntries` 再 `writeFileAtomic` + 高水位含归档侧），按钮放详情区而不是行内（行本身是 `role=button`，行内塞按钮要么 `stopPropagation` 要么键盘可达性出问题）。
- 落钉文件：tests/wiring.test.mjs、tests/client-entries.test.mjs（另 DESIGN.md 补了路由与不变量，未新增独立报告文件）。

**第 47 轮「归档功能的 4 处覆盖洞补测」净增 4 条 / 全量 648 条（647 通过 + 1 skip，约 6.6s）**：源码零改动（lib/index.js sha256 `54c1d52d…`、client.js `0fd5f923…` 前后一致），只补「删掉代码测试也不红」的 4 处——第 46 轮的独立验证者做过 13 次变异实验，这 4 处代码本身正确，但没有任何用例能证明它们有用。

- tests/wiring.test.mjs 16 → **18**（+2）：① **409 真并发窗口**——锁外快照读 + 外部写者占锁制造真实并发，两个 `POST /entries/archive` 同时归档同一条 `ace-002`，断言响应 `[200,409]` 各一、409 体为结构化 `{error}`、`archive.md` 恰 1 条、`runtime.archived === 1`、info / warn 日志各恰 1 行（**零多写**，不是打桩假装的失败）；② **路由顺序是防御纵深**——`GET /entries/archive` 恒 405（不许被 `/entries` 分支接走）、`GET /entries` 恒 200、三条子路径（`/entries/unknown-sub`、`/entriesX`、`/entries/foo/bar`）恒 404。
- tests/client-entries.test.mjs 34 → **36**（+2）：③ 确认态下**连点两下**（第二下不等第一发 fetch 落定），后端只收到 1 发 POST（`archiveBusy.current` 在飞闸）；④ **点确认按钮必须拦住冒泡**——冒泡点行内 span（对照）事件确实冒到行与容器，冒泡点确认按钮则停在自己、不收起详情、不复位确认态、不触发别的行。
- **夹具扩能（默认行为不变）**：tests/client-entries.test.mjs 的 `click(node, options)` 加了**可选** `options.bubbles`——从渲染树建 parent 映射、沿父链逐级调 onClick、共享同一事件对象并尊重 `stopPropagation`、返回实际执行了 handler 的节点数组。第 46 轮那 34 条既有用例断言零改动、全绿（此前夹具直调 `props.onClick`、**不冒泡**，所以「按钮点下去会不会被容器 `onClick` 顺手复位」这条真实通路一次都没被测过）。
- **变异自证 4 条**（每个都真改文件、跑红、逐字还原、SHA256 前=后）：M1 `lib/index.js:2015` 的 409 条件改 `if (false)` → wiring 红 1；M2 删 `client.js:1112` 的 `if (archiveBusy.current) return;` → client-entries 红 1；M3 删 `client.js:1287` 的 stopPropagation → client-entries 红 1；M4 `lib/index.js:2038` 的 `=== '/entries'` 改 `startsWith` → wiring 红 1（红的抓手是那三条子路径 404；405/200 仍绿是**预期**，因为新分支先截住——用例同时钉住两件事）。变异期间跑 2 次全量（变异前 648/647/0/1、收尾 648/647/0/1），临时探针目录在 `%TEMP%` 下且已删。
- 本轮新增的未验证项（并入下方清单第 22 条）：409 用例依赖真实并发时序（极端调度下第二请求快照读晚于第一请求写盘会对着断言响亮失败，不是静默绿；5 次完整运行均稳定出 `[200,409]`，未做高压统计）；冒泡夹具是「沿 parent 链直调 onClick」的最小实现，不含捕获阶段 / 合成事件 / 键盘焦点语义。
- 落钉文件：tests/wiring.test.mjs、tests/client-entries.test.mjs（源码与 locale 文件这一轮未动）。

**第 48 轮「复盘解析三缺口 + 五轮返工」净增 37 条 / 全量 685 条（684 通过 + 1 skip，约 6.6s）**：本轮改的三件事都在「一次失败之后什么都不剩」这条线上——**B1** `lib/llm.js` 的 `oneShot` 只在正文为空时抛一条带 reasoning 字符数、耗时、provider/model 的普通 Error，文案里没有「调用超时」四个字，所以 `lib/reflect.js` 的 `isTimeoutError` 认不出来、按真实失败处理（超时豁免逻辑一行未改）；**洞 1** `lib/prompts.js` 的 `extractJsonObject` 重写（`scanJson` / `scanRange` / `isCandidateArray` / `isEmptyArray` / `isContractObject` / `recoverObjectsInRange` / `findCandidateArray` / `hasForeignCharBetween`），认顶层数组包壳 `{candidates:[…]}`、真截断必抛且位置 1-based、散文方括号回落对象路径、非法数组回收对象、空壳对象让位，报错前缀分「未找到 / 不完整 / 无法解析」三族且都带现场前 60 字；**B2** 新增 `lib/raw-log.js` 把失败现场落进 `<DSH_HOME>/ace/debug/raw.jsonl`（保留最近 20 条），`lib/index.js` 的自动复盘与手动 `ace_reflect` 两条失败路径、`lib/merge-llm.js` 的 `catch` 都接 `dumpRaw`，`lib/recap-pipeline.js` 在 `finally` 里 `await flushRawLog()`。

- **用例分布在六处，删掉的既有用例 = 0**：tests/prompts.test.mjs 7 → **26**（+19：R48-Gap1 / Gap2 / S1 / S2 / S3 / T1 / T1 回归守护 / F1 / F2 / F5 / G1a / G1b / G2a / G2b / G2c 与四条容错基线）、tests/merge.test.mjs 22 → **26**（+4：顶层数组送 `parseMergeResult` 仍是 null、Gap3 临时 home 落点、Gap4 provider/model 进现场、F2 的 merge 不变量回归）、tests/recap-pipeline.test.mjs 26 → **29**（+3：Gap4 整链 flush 后现场已在盘上且带 provider/model、无 `mergeRoute` 时判定不变、真实 home 一行不多）、tests/wiring.test.mjs 18 → **20**（+2：R48-F4 自动复盘、R48-F3 手动 `ace_reflect`）、tests/llm-budget.test.mjs 3 → **6**（+3：只有 reasoning-delta 时抛「正文为空」并带 reasoning 字符数与耗时、该错不被 `isTimeoutError` 认成超时、正常流 reasoning 不混进返回值）、新增 tests/raw-log.test.mjs **6** 条。
- **五组变异自证**（每组只打红对应用例、其余全绿，改完逐字复原、`lib/prompts.js` 的 sha256 回到变异前 IDENTICAL）：① 判据方向两条——`hasForeignCharBetween` 恒 false → prompts 红 2（R48-S1、R48-T1 回归守护）、恒 true → prompts 红 4（Gap1 / S1 / T1 / T1 回归守护）；② 位置与弱候选——对象路径改回 0-based → 红 1（S2）、空数组回到「无条件算候选」→ 红 1（S3）；③ 返工 F 组——`leading` 判据去掉 → 红 1（F1）、数组不回收 → 红 1（F2）、空壳后直接 `return v` → 红 1（F5）；④ 现场接线——删 `lib/index.js:1610` 的 `await dumpRaw(...)` → wiring 红 1（F3）、删 `lib/index.js:1393` 的 → wiring 红 1（F4）；⑤ 终验 G 组——`isContractObject` 改回「数组即契约」→ 红 1（G1a）、对象路径直连 `JSON.parse` → 红 3（G2a/G2b/G2c）。
- **基线演进**：648（第 47 轮）→ 669（B1 / 洞 1 / B2 + Gap 1–5）→ 672（S1/S2/S3）→ 674（T1）→ 680（F1/F2/F5 + merge 回归 + F3/F4）→ **685**（G1 两条 + G2 三条）；测试文件数 40 → **41**（唯一新增 tests/raw-log.test.mjs）。既有断言一条未改、新用例一条未 skip。
- 逐条用例、根因（线上那次复盘 72s、`oneShot` 只累加 text-delta）、变异自证全表与残留歧义见 **FIX-REPORT-R48.md**；本轮不做的三处（`[\u3000]` 与 `[]` 不一致、保留 20 条会挤掉历史夹具、`[[1,2],[3,4]]` 报「未找到」属正确语义）与四项线上观察项的未验证声明也在该文件末尾，本轮已同步进红线 20。

**第 49 轮「自动注入相关性门槛」净增 5 条 / 全量 690 条（689 通过 + 1 skip，约 6.9s）**：注入候选层新增「绝对门槛 × 相对门槛」，让「手册里没有相关经验」的回合**注入 0 条**（整轮不注入是合法结果）。参数由实测决定、不许调：绝对门槛 = `4.0 × IDF_MAX`（`IDF_MAX = log((N-1+0.5)/(1+0.5)+1)`、`N` = 活跃条目数），每条的相对门槛 = `0.6 × topScore`，两者取高。**门槛作用在热度加权之前**——热度只能重排已过门槛的候选，不能把门槛以下的条目顶进来。

- tests/inject.test.mjs 18 → **23**（+5）：① C5.8 门槛算在活跃条目数上（`injectScoreFloor` 的 IDF_MAX 与 4.0 倍关系）；② **零任务意图的回合注入 0 条**（先证明同一批条目在门槛关闭时会注入 3 条，再断言默认档 0 条 —— 「0 条」不是因为夹具没分）；③ **热度顶不进门槛以下的条目**（同一次查询、同一份 heat：关门槛时高热度低相关那条排在第二位、默认档它直接不出现）；④ **同一条 query 在 N=100 与 N=150 上门槛不同**（N=100 时 18.434 ≥ floor 16.839 注入 1 条，N=150 时 17.088 < floor 18.447 注入 0 条，且两组在关门槛下都注入 1 条，证明差别来自 `IDF_MAX` 随 N 变而不是候选本身不存在）。
- **既有用例一条未删、断言语义一条未降级**：凡「测的不是门槛」的用例（纯 BM25 排序 / 5 条上限 / token 预算 / 投递 / 端到端链路 / 两个预算配置行为）一律显式传 `{injectMinScoreIdfRatio: 0, injectMinRelativeToTop: 0}`（0 = 关掉两边门槛，候选层退回历史语义 `score > 0`），并加一行注释指向 C5.8。涉及 tests/inject.test.mjs（GATE_OFF 常量 + 11 处调用）、tests/heat.test.mjs（14 条含 `computeHeat`）、tests/heat-wiring.test.mjs、tests/inject-delivery.test.mjs、tests/e2e.test.mjs（`makeHost` 的 `plugin.apply` 一处覆盖三个场景）、tests/tuning-behaviors.test.mjs（两条配置行为）。**C5.4「第一条无条件注入」按新语义重写为两条**：候选层已过门槛时预算再紧也注入第一条 / 门槛挡空时整轮 0 条。
- tests/config.test.mjs 9 → 9（同名用例内扩断言）：`injectMinScoreIdfRatio` / `injectMinRelativeToTop` 两个数值配置的端到端契约（GET 的 value/bounds/defaults、PUT 落盘**小数不许被取整**、非法值与越界 400 文案、`null`/空白串回落默认）；tests/wiring.test.mjs 的 Config 字段数 12 → **14**。
- **基线演进**：685（第 48 轮）→ **690**；测试文件数仍 41（没有新增文件）。
- 机检：`node --test tests/` → 690 / 689 通过 / 0 失败 / 1 skip。

**第 50 轮「复盘思考档位：默认自动降到最低档 + 超时降档重试一次 + `GET /api/dsh-ace/efforts`」净增 11 条 / 全量 719 条（718 通过 + 1 skip，实测 6.32s 与 6.88s）**：复盘的每一次 LLM 调用现在默认**显式**降到该模型声明的最低档（`reasoning.efforts[0]`），不再让 profile 里的 `reasoningEffort` 决定复盘的思考强度；降不了档的四种情形一律不干预（只 warn）；某一轮**超时**时用最低档再试一次、只试一次。

- 新建 tests/r50-reasoning.test.mjs **11 条**（R50-0…R50-10）：① R50-0 纯逻辑基线（档位名校验 / 宿主档位解码 / 最低档判定与三种「不干预」返回 null）；② R50-1 默认自动降档 —— 假 provider 收到的 `options.reasoningEffort` 等于该模型 `efforts[0]`（夹具 `auto/glm-5.3-flash`，最低档 `off`）；③ R50-2 手填 `high` 优先，不被自动降档覆盖；④ R50-3 手填 `max` 但该模型没声明 → **丢弃 + warn 含 "max" 与 "已丢弃"** → 回落自动最低档 `off`（断言发出去的不是 `max`）；⑤ R50-4 `autoReasoningDowngrade:false`（以及字符串 `'false'`）→ `'reasoningEffort' in options` 为 `false`（断言的是**键不存在**，不是值为空）；⑥ R50-5 只声明一档（`group/never-stuck`）→ 不干预 + warn 含「只声明了一个思考档位」与该档名；⑦ R50-6 查询能力缺失 / 抛错 / 真超时（`timeoutMs:20`）三种都 **不干预、复盘照常走完**（不抛错，warn 各命中一句，超时那条还断言 `signal.aborted === true`）；⑧ R50-7 第 1 轮超时 → **恰好两次调用**、第一次 `high`、第二次 `off`，warn 含「第 1 轮超时，已降到最低档 off 重试一次」；⑨ R50-8 普通错误不重试（**只调用一次**）与重试仍失败（第 2 轮两次都超时 → 共 3 次、第 3 次仍是 `off`、第 1 轮已提炼的候选照常落盘 1 条、结果仍是真的 success 而不是假成功）；⑩ R50-9 配置面（`Config.fields` 16、两键默认 `''`/true、`bounds.reasoningEfforts`、POST 落盘后 GET 读回、`HIGH`/`ultra`/`mid`/数字一律 400 且原值不动、空串 200、布尔非法值 400、手改坏值读盘归一回落默认并 warn、白名单 16 键 remount 后生效）；⑪ R50-10 `GET /api/dsh-ace/efforts` 五组断言（显式参 → `ok:true` 带 `efforts`/`defaultEffort`/`effective{effort,source}`；手动档 → `source:'manual'`；未知模型 → `ok:false` 且状态码仍 200、错误以 `ace: ` 开头；什么参数都没有 → `{ok:false,error:'ace: session model unknown'}`；POST → 405；以及「先 `ok:false`、走一次 `agent/pre-step` 后同一个 GET 变 `ok:true`」并断言**路由一次 LLM 都没发**）。
- tests/config.test.mjs 9 → 9（同名用例内扩断言）：`FIVE`/`DEFAULTS`/`RANGES` 常量扩到第 49 轮的两个门槛键，字段数断言 14 → **16**；tests/wiring.test.mjs 20 → 20：Config 字段数与 16 键字面量数组同步（既有两个断言只换数字与数组，用例名一条未改、断言强度一条未降）。
- **同批的 7 条 `R50｜…` 在 tests/client-picker.test.mjs 属前端那支（client.js），不计入本插件后端基线**；本文件顶部的 719 条已把它们的贡献排除在外，只算上表列出的后端增量。
- **基线演进**：690（第 49 轮）→ **719**；测试文件数 **42 → 43**（唯一新增 tests/r50-reasoning.test.mjs；上一段第 49 轮那句「测试文件数仍 41」是笔误——第 49 轮其实新建了 tests/prompts-salvage.test.mjs，以 `Get-ChildItem tests -Filter *.test.mjs` 实测的 43 个为准）。
- 机检：`node --test tests/` → **719 / 718 通过 / 0 失败 / 1 skip**，EXIT 0；改过的 `lib/*.js` 与测试文件逐个 `node --check` 全部 OK。

**第 51 轮「手动 `ace_reflect` 超时误报 + 非法手动档位静默丢弃 + 代码地图缺行」净增 4 条 / 全量 723 条（722 通过 + 1 skip，实测 `duration_ms` 6415.2989 ≈ 6.4s）**：三处缺陷各一条守护用例，另有一条把文档欠账变成可回归断言。生产改动三处：`lib/index.js:1748-1762` 手动 `ace_reflect` 把 `signal: exec && exec.signal` 透传给 `oneShot`（`signal` 归调用方所有，不透传时 `lib/llm.js:169` 的判据退化成「合并信号已 abort」⇒ 本层上限到点恒被误报成「调用被取消」，`lib/reflect.js` 的 `isTimeoutError` 认不出、超时豁免失效）；`lib/reasoning.js:194-198` 非法手动档位名补一条带原值与 `REASONING_EFFORT_IDS` 清单的中文 warn（原为静默丢弃）；`AGENTS.md` 代码地图补 `lib/heat.js` / `lib/injection-flow.js` / `lib/inbox.js` 三行（纯文档欠账，既有各行一字未改）。

- 新建 tests/r51-manual-reflect.test.mjs **4 条**（R51-D1a / D1b / D2 / D3；真 import `lib/index.js`、真调 `apply()` 与 `ace_reflect.execute`，宿主 LLM 用假 stream，`DSH_HOME` 指到临时目录）：① R51-D1a 把本层单次上限压到 60ms（`ACE_ONESHOT_TIMEOUT_MS='60'`），假 stream 等合并信号 abort 后吐 `finish{kind:'aborted'}` —— 必须报「ace: LLM 调用超时（单次上限 60ms）」且 `isTimeoutError` 为 true（改前真实报文是「ace: LLM 调用被取消…」）；② R51-D1b 调用方自己 abort 时仍必须报「调用被取消」且 `isTimeoutError` 为 false，进流那一刻读 `options.signal.aborted` 当「有没有透传」的探针（改前探针是 `false`，这条不依赖任何计时）；③ R51-D2 `planReasoningEffort` 手动档位名非法（`'HIGH!'`）必须落**一条**带原值的中文 warn，且 auto 照常回落最低档（改前 `warns.length === 0`）；④ R51-D3 读 `AGENTS.md`，对 `lib/inbox.js` / `lib/heat.js` / `lib/injection-flow.js` 各按行前缀判定「有且有一整行」（改前红在 `lib/inbox.js` 缺整行）。
- **既有用例一条未删、一条未改名**：本轮只新增 4 条，没有任何既有断言被放宽（三处生产改动由这四条新用例守着）。
- **基线演进**：719（第 50 轮）→ **723**；测试文件数 **43 → 44**（唯一新增 tests/r51-manual-reflect.test.mjs）。
- 机检：`node --test tests/` → **723 / 722 通过 / 0 失败 / 1 skip**，EXIT 0；变异自证见 FIX-REPORT-R51.md（撤 `exec.signal` 透传 → D1a/D1b 转红；撤 `note(...)` → D2 转红；删 inbox 行 → D3 转红；三处同时回退 → 四条全红；还原后 index.js / reasoning.js / AGENTS.md 三份文件 SHA-256 字节级一致）。

**第 52 轮「`defaultEffort` 不再回落最强档」净增 0 条 / 全量仍 723 条（722 通过 + 1 skip，文档改动前后各跑一次，`duration_ms` 6446.2813 / 6242.6402 ≈ 6.2–6.4s；本轮施工记录给的区间是 6.1–6.4s）**：只改一处生产语义 + 一行既有断言，**用例条数不变**。

- 改了什么：`lib/reasoning.js:96-102` 的 `decodeModelEfforts` 里 `defaultEffort` 的回落分支由「宿主没声明就回落 `efforts` 末项」改成**回落 `undefined`**，并加三行注释说明理由；返回值组装处仍是 `lib/reasoning.js:112` 的 `...(defaultEffort === undefined ? {} : { defaultEffort })`，所以没声明时 `GET /api/dsh-ace/efforts` 报文里该键整体缺席。
- 为什么：第 50 轮线上实测 `magpie` **全部 69 个模型都没声明 `defaultEffort`**，旧回落逻辑让 `/efforts` 报文凭空显示 `xhigh` —— 宿主从未声明过的档，等于插件以「宿主默认档」的名义造数。
- 既有断言只改期望值：`tests/r50-reasoning.test.mjs:226-227` 由 `'high'` 改为 `undefined`；同文件 :224 那条「宿主声明了 `defaultEffort` 且在声明集里 → 原样带出」仍断言 `'high'`、**仍绿**，本轮没有放宽任何断言。
- 变异自证（按本轮施工记录）：把回落改回 `efforts[末项]`，那条断言即转红，实测 `tests 11 / pass 10 / fail 1`；还原后复跑全量复绿。
- **基线演进**：723（第 51 轮）→ **723**（净增 0）；测试文件数仍 **44**（本轮无新增文件）。
- 机检：`node --test tests/` → **723 / 722 通过 / 0 失败 / 1 skip**，EXIT 0（`node --test --test-reporter=tap tests/` 输出 `# tests 723 / # pass 722 / # fail 0 / # skipped 1`）。
- **补测（验证报告指出的覆盖缺口）**：验证报告指出第 52 轮改的正是「回落 `undefined`」，但既有断言只钉住「值」（`defaultEffort === undefined`），没钉住「**键整体缺席**」这一半边——组装处一旦退化成 `defaultEffort: null`，值级断言照样全绿，而 `/efforts` 报文里就凭空多出一句 `null`。本轮只加断言、**不新建 test**、**生产代码零改动**：① `tests\r50-reasoning.test.mjs:228-234`（R50-0 用例内）断言 `decodeModelEfforts` 在宿主**没声明** `defaultEffort` 时返回对象**自身没有该键**——先 `assert.equal(noDefault.ok, true)`（免得 `hasOwnProperty` 在失败体上空过），再 `assert.equal(Object.prototype.hasOwnProperty.call(noDefault, 'defaultEffort'), false, '宿主没声明 defaultEffort 时该键必须整体缺席（缺键 ≠ null）')`；② 同文件 `:521-522` 新增夹具 `'auto/glm-5.3-flash-nodefault'`（只给 `['low', 'high']`、无 default 项）、`:536-542` 断言 `GET /api/dsh-ace/efforts` 报文里该键**整体缺席**（`hasOwnProperty === false`，缺键 ≠ null），并顺手断言 `efforts` 仍是 `['low', 'high']` 证明夹具本身有效。**既有用例一条未删、一条未改名、条数一位不动**。变异自证：把 `lib\reasoning.js:100-102` 的回落改回 `efforts` 末项 → **精确红两条**（R50-0 `not ok 472`、R50-10 `not ok 482`），`# pass 720 / # fail 2`；还原后 `lib\reasoning.js` SHA-256 = `7cca9f1853c5e2b33cccce11a6ff1743c8a10996da698a3375cd029438008372` 字节级一致，复跑复绿。**基线不变**：补测前后都 `# tests 723 / # pass 722 / # fail 0 / # skipped 1`、EXIT 0（只加断言、没新建 test，所以条数一位不动；第 18 行顶部摘要的 723 / 44 个测试文件因此仍然正确）；测试文件数仍 **44**。

**第 53 轮「已归档分区补分页」净增 6 条 / 全量 729 条（728 通过 + 1 skip，两次实测 `duration_ms` 6345.5788 / 6744.8043，约 6.3–6.7s）**：纯前端改动，只动 `client.js` 与 tests/client-entries.test.mjs，**`lib/` 下一个字节都没改、HTTP 契约不变**。

- 改了什么：`client.js` 里 `archivedView()`（第 1250-1334 行附近）新增归档分页三行计算（`archivedPageCount` / 钳位后的 `archivedCurrentPage` / `archivedRows = archivedAll.slice(...)`），行渲染由 `archivedAll.map` 改为 `archivedRows.map`；`archivedView()` 尾部新增 `archivedPager`（上一页 / 数字页码 / 「第 X / Y 页」/ 下一页），类名与文案**整份复用活跃分区那一套**（`.ace-entries-pager` / `.ace-entries-pager-btn` / `.ace-entries-pager-text` 与 `entriesPrev` / `entriesPage` / `entriesNext`，无新增字典键）；新增独立 state `const [archivedPage, setArchivedPage] = React.useState(1)`（`client.js:1055`），与活跃分区的 `page` **互不影响**；`scopeButton` 的 onClick（`client.js:1149`）在切分区时补 `setArchivedPage(1)` 并写一行注释说明理由（切走再回来停在上一次的第 N 页会让人以为条目丢了）。
- 显示条件与活跃分区一致：归档为空只给 `entriesArchivedEmpty` 空态、不渲染分页条；非空时连只有 1 页也渲染。归档只读红线未松动：分页条只放「上一页 / 下一页 / 数字页码」三种按钮，没有删除、还原、编辑、归档入口。
- 新建 6 条用例，全部追加在 tests/client-entries.test.mjs 末尾的「—— 11. 已归档分区分页（第 53 轮）——」组：① 45 条归档 → 每页 20 条、第 1/3 页、首页禁上页末页禁下页、点页码「1」回第 1 页；② 归档页码与活跃页码互相独立（活跃翻到第 2 页后切归档仍在第 1 页，归档翻页也不带动活跃分区，切走再回来复位）；③ 归档 ≤ 20 条时「第 1 / 1 页」、上下页都禁用、页码按钮只有 1 个；④ 归档为空时不渲染 `.ace-entries-pager`（长度 0）且仍显示空态；⑤ 钳位（先翻到最后一页，再刷新成 3 条 → 钳回第 1 页，不报错、不渲染越界行）；⑥ 翻页后只读红线仍在（子树无 input 控件、无归档/删除/还原按钮、分页按钮只可能是「上一页/下一页/数字」，`archiveCalls(host).length === 0`）。
- 既有用例一条未删、一条未改名、一条断言未放宽：活跃分区的搜索/排序/分页/归档按钮行为与类名全部原样。
- 变异自证（撤一处实现即转红，还原后 `client.js` SHA-256 字节级一致）：把 `archivedRows` 的 slice 改成全量 `slice(0)` → ①②转红；撤掉 `setArchivedPage(1)` → ②转红；把 `archivedPage` 换成活跃分区的 `page` → ①②⑤转红。
- **基线演进**：723（第 52 轮）→ **729**（净增 6）；测试文件数仍 **44**（本轮无新增文件）。
- 机检：`node --test tests/` → **729 / 728 通过 / 0 失败 / 1 skip**，EXIT 0；`node --check client.js` 与 `node --check tests/client-entries.test.mjs` 均 OK。
- 未验证项：只在迷你 React 渲染器里验证过，**没有在真实浏览器/GUI 里点过**——真实 CSS 级联下的分页条换行与对齐、真实鼠标连点、以及宿主刷新时期的滚动位置都不在覆盖范围内（与既有分页用例同一条口径）。


**第 54 轮「省 token 方案」净增 9 条 / 全量 738 条（737 通过 + 1 skip，`node --test tests/` 实测 `duration_ms` 6410.3257，约 6.4s）**：生产改动横跨 `lib/` 六处（摘要瘦身、注入预算 500、注入去依据 + 会话内去重、合并输入瘦身、复盘 2 轮、热度 / 目录缓存），**HTTP 契约一字未变、Config 字段数仍 16**（字段数到 17 是第 55 轮）。

- 改了什么（逐项 + file:line）：① `lib/playbook.js:482-483` 的 `digestEntries` 只输出 `[id] 标题｜条件：…`（去掉「做法」），满额 100 条手册摘要 25,942 → 10,370 token（`estimateTokens` 实测）；② `lib/inject.js:20` `INJECT_TOKEN_BUDGET` 默认 900 → **500**，一次注入块 1,331 → 985 token；③ `lib/inject.js:194-202` `renderEntry(item,index,withRationale)` / `:229` `renderInjection(picked,{withRationale=false,maxEntries})` / `:283-285` 仅显式 `options.withRationale===true` 才带「   - 依据：」行、超预算则**整体回落**（不截断）；④ `lib/inject.js:365-366` 新增 `createInjectedIds({ maxPerAgent = 1000 })`（`WeakMap` 按 agent 记录已注入 id，FIFO 上限 1000，随会话结束清理）；⑤ `lib/merge-llm.js:115` `mergePairInput` 不再喂 `rationale`，删「## 合并要求」四条、只留一条「只输出四字段 JSON 对象」；⑥ `lib/reflect.js:11` `REFLECT_MAX_ROUNDS` 3 → **2**；⑦ `lib/recap-pipeline.js:114` `MERGE_PHASE_RESERVE_MS = 40000` + `:209-213` 先 `findMergePairs(entries)` 预判、确有 ≥ 阈值配对才预留（C2）；⑧ `lib/heat.js:31-53` `computeHeat` 有界 LRU 记忆化（`HEAT_MEMO_MAX = 500`，导出 `clearHeatRankMemo` / `heatMemoSize`）；⑨ `lib/catalog.js:35-61` `buildCatalog` 缓存（`WeakMap` 按 llm 实例 + `CATALOG_CACHE_TTL_MS = 45000`，`options.cacheTtlMs` 覆盖、0 关闭，只缓存全成结果）；⑩ `lib/trajectory.js:321-332` A4 完全相同行只留首次（`seen` Set 去重）。
- 新增/改写的用例落点（**净增 9 条，测试文件数仍 44，本轮无新增文件**）：新增 tests/inject.test.mjs `B3｜createInjectedIds…`(:286) 与 `C5.4｜门槛挡空时「第一条无条件注入」不适用…`(:168)、tests/inject-delivery.test.mjs `B3｜投递成功后才把 ids 记进 injectedIds`(:272)、tests/catalog.test.mjs `D1｜buildCatalog 短 TTL 缓存`(:115) 与 `D1｜…失败不缓存`(:135)、tests/heat.test.mjs `D2｜computeHeat 记忆化`(:222)、tests/merge.test.mjs `C1｜mergePairInput 不喂 rationale…`(:498)、tests/prompts.test.mjs `A2｜reflectorUserInput…`(:387)、tests/trajectory.test.mjs `A4：完全相同的行只留首次出现…`(:541)；随契约**改名/重写**的既有用例：tests/inject.test.mjs `C5.3｜…（5/3/900）`→`（5/3/500）`(:42)、`C5.4｜900 token 预算`→`500 token 预算`(:132)、`C5.5｜依据按预算…`→`B1｜默认不带「依据」…`(:238)、tests/playbook.test.mjs `digestEntries…只含标题 + 条件（A3：不含做法）`(:190)、tests/reflect.test.mjs `C3｜上限是 3 轮`→`2 轮`(:7) 与 `跑满 3 轮`→`跑满默认 2 轮`(:30)、tests/e2e.test.mjs `E2E 场景2…第 3 轮`→`第 2 轮`(:386)、tests/recap-pipeline.test.mjs 把「满额扣 40000ms」一条拆成「有配对才预留(:877) / 无配对不预留(:861)」两条。
- 既有断言口径（**如实记录，不能写「一条未改名」**）：本轮契约确实变了，多条既有用例的 test 名随契约改写（C5.3 900→500、C5.4 900→500、C5.4「第一条无条件注入」口径重述为「预算再紧也注入第一条」、C5.5 依据→B1 默认不带依据、digestEntries 加「不含做法」、C3 3 轮→2 轮两条、E2E 场景2 第 3 轮→第 2 轮、热度接线→注入接线 B3、R45 满额预留→拆「有/无配对」两条），期望值只跟着新常量走、**无一处判据放宽**（计数仍是精确 `assert.equal`），且每条被删的旧名都有同主题新名承接、**无净删覆盖**。核对依据：`git diff acfbedd~1 acfbedd -- tests/` 共 −13 test( / +66 test(，但其中含第 49–53 轮一并入库的重命名（如「配置① 12→16」属第 50 轮字段扩张、「热度接线→注入接线 B3」），不能整体算作第 54 轮。
- **基线演进**：729（第 53 轮）→ **738**（净增 9）；测试文件数仍 **44**（本轮无新增文件）。
- 机检：`node --test tests/`（HEAD 快照）→ **738 / 737 通过 / 0 失败 / 1 skip**，EXIT 0（`--test-reporter=tap` 输出 `# tests 738 / # pass 737 / # fail 0 / # skipped 1 / # duration_ms 6410.3257`）。
- 未验证项：第 49–54 轮的代码与用例是攒在**同一次提交 acfbedd** 里入库的（提交信息明写「并把 lib/reasoning.js 与 r50-r51 用例入库」），所以 `git diff 56ceeae..acfbedd` 的 +53 条是这几轮合并口径、不是本轮单轮净增；本轮「净增 9 条」取自施工记录的第 53→54 轮基线差（729→738），无法用单一提交 diff 单独切出，属**记录型数据而非逐轮 git 实测**。

**第 55 轮「注入依据开关 injectRationale」净增 6 条 / 全量 744 条（743 通过 + 1 skip，两次实测 `duration_ms` 6121.4832 / 6799.8147，约 6.1–6.8s）**：只加一条布尔配置项 + 一处生产透传，**默认行为与第 54 轮完全一致（注入块仍不带「依据」行）**。

- 改了什么（逐项 + file:line）：① `lib/index.js:147` Config 新增 `injectRationale: z.boolean()`（默认 `false`，字段数 16 → 17）；② `lib/index.js:338-340` `function injectRationaleOf(value) { return validFlag(value) === true; }`；③ `lib/index.js:354-357` 读盘归一（非法值丢弃并 warn `dsh-ace: 丢弃无效的 injectRationale（需为 true 或 false）`）；④ `lib/index.js:561` 写盘白名单加 `injectRationale`；⑤ `lib/index.js:1084` 预检索读**生效值** `injectRationaleOf(live.injectRationale)` 作 `options.withRationale` 传给 `selectInjection`（热更新天然生效）；⑥ `lib/index.js:2416-2420` `POST /api/dsh-ace/settings` 接受该键、非法报 `injectRationale 必须是 true 或 false` 且不动当前值；⑦ `lib/index.js:2474` 保存日志、`:2493` 挂载日志各带一句「注入依据 开/关」；⑧ `client.js:2062-2067` 设置页新增「注入时附带依据」开关（字典键 `fieldInjectRationale` 中英双侧见 `client.js:90-91` / `:254-255`）。
- 新增用例：**整份新建 tests/r55-inject-rationale.test.mjs（第 45 个测试文件），6 条 R55-1…R55-6**，全部走真生产路径（真 import `lib/index.js`、真调 `apply()`、真发 `agent/inbox/inserted`、真跑 `agent/pre-step` 投递、真打 `POST /settings`；`DSH_HOME`/`DSH_PROFILE_DIR` 指 `mkdtemp` 临时目录、`registerHooks` 桩 3 个宿主包）：R55-1(:203) Config 默认关（boolean / false / 不进 `bounds.defaults` / GET 生效值 false）；R55-2(:218) 接线级默认关（注入块「依据」出现 0 次、依据正文不出现、条目照常注入）；R55-3(:231) 接线级打开（恰好多一行、`textOn.includes('   ' + '- 依据：' + LONG_RATIONALE)`、`estimateTokens(on) > off`、HTTP 文本与纯函数口径一致）；R55-4(:258) POST true/false 读回一致并真落盘；R55-5(:282) 非法值（`yes` / `1` / `null`）一律 400 + 文案且不动当前值；R55-6(:298) 热更新（保存后下一批立即带依据、关回去立即不带）。
- 既有断言口径（**如实记录：不是「一条未改名」**）：**一条用例未删**，只把 3 处「配置字段 / 白名单条数」的精确等值断言 16 → 17（tests/config.test.mjs:111、tests/wiring.test.mjs:405、tests/r50-reasoning.test.mjs 的用例名 :438 与注释 :445），并新增 2 条更严的正向断言（tests/config.test.mjs:112 `assert.ok(keys.includes('injectRationale'), …)`、:290-291 布尔键坏值 warn + 回落 false）。**有 2 条既有用例名随字段数改了名**：tests/config.test.mjs:107「配置①…（共 16 个）」→「（共 17 个）」、tests/r50-reasoning.test.mjs:438「白名单 16 键」→「17 键」。核对依据：`git diff acfbedd -- tests/` 只动 tests/config.test.mjs（assert +4 −1）、tests/r50-reasoning.test.mjs（assert +1 −1）、tests/wiring.test.mjs（assert +1 −1），被删的 3 行 assert 全是 `16`→`17` 精确等值替换，无判据放宽。
- **基线演进**：738（第 54 轮）→ **744**（净增 6）；测试文件数 **44 → 45**（唯一新增 tests/r55-inject-rationale.test.mjs）。
- 机检：`node --test tests/` → **744 / 743 通过 / 0 失败 / 1 skip**，EXIT 0（`--test-reporter=tap` 输出 `# tests 744 / # pass 743 / # fail 0 / # skipped 1`）。
- 未验证项：只在 node:test + `registerHooks` 桩的宿主环境里验证过，**没有在真实 GUI 设置页里手点过那个开关**——真实浏览器里开关的渲染 / 点击与保存后的 GET 回读一致性不在覆盖范围内（与第 53 轮前端分页用例同一条口径）。

## 桩宿主包真 import lib/index.js：为什么、桩哪几个、怎么驱动事件流

**结论：`lib/index.js` 是服务半边，顶层 import 宿主包，本仓库没有 `node_modules`，所以「真跑一遍接线」只能靠 `node:module` 的 `registerHooks` 把宿主包换成内存桩，再真调一次 `apply(ctx, config)`。**

为什么不能只写源码级断言：源码正则能钉住「某行调了某个函数」，钉不住「这个函数真的有定义」。P0-7 就是这么漏过去的——`noteArchived`/`noteWritten` 在 lib/index.js 里**只有引用、零定义**，`node --check` 查不出，420 条源码级用例全绿，而真实会话里每次复盘都在落盘之后抛 `ReferenceError: noteArchived is not defined`，导致计分与命中永不执行、`recapStats` 永不累加。要抓这一类缺陷，必须让模块**真的被加载、真的被调用**。

桩哪几个包（`tests/wiring.test.mjs` 与 `tests/e2e.test.mjs` 各自建桩，互不依赖）：

| 宿主包 | 桩的形态 | 为什么可以这么桩 |
| --- | --- | --- |
| `@deepseek-ai/schemastery` | `z.string()/boolean()/number()/object()` 各返回一个带 `description/default/optional` 的 builder | 插件只在 `Config` 声明处用它，运行期不再调用；桩只要能让 `Config` 建出来即可 |
| `@deepseek-ai/dsh-tools` | `defineTool(def)` 原样返回 `def`（wiring 版另做 name/execute 校验） | 插件拿到的是「工具定义对象」，真实宿主也只是注册它；桩返回原对象就能拿到 `.execute` 真调 |
| `@deepseek-ai/dsh-llm` | `createUserMessage(input)` 补成 `{role:'user', id, content:[...], source}`（wiring 版保留 `input.source`、e2e 版用 `{...input, role:'user', id}`） | 只影响通知消息与注入消息的构造，不影响被测逻辑；保留 `source` 是为了断言注入消息的 `{kind:'dsh-ace', form:'injection'}` 标记 |

桩用 `registerHooks({ resolve })` 拦 specifier：以 `@deepseek-ai/` 开头且桩目录里存在同名 `index.js` 时 `shortCircuit` 返回文件 URL，其余 specifier 原样交给 `nextResolve`。**桩必须在 `import(lib/index.js)` 之前装好**，且 `process.env.DSH_HOME` / `DSH_PROFILE_DIR` 也要在 import 之前指向临时目录——`apply()` 里的 `migrateSettingsFile` 会读这两个环境变量，晚一步就会去碰用户真实设置。

怎么驱动事件流（e2e 的做法，也是将来加接线用例的模板）：

1. 建假 ctx：`logger`（info/warn/error 收进数组）、`tools.register`、`systemPrompt.section`（把 spec 存下来，断言时直接调 `spec.text({ agent })`）、`on(event, handler)`（按事件名存表）、`commands.register`、`get(name)`（`profileContext` 给临时目录，其余 undefined）、`llm.stream`（async generator，按轮次吐预置 JSON）、`workingDirectory.ensure`、`inject(deps, cb)`（存下 cb 并立即以假 scoped 调它）；
2. `apply(ctx, config)` → 从 `record.handlers` 里按事件名取出真正的处理器；
3. 按宿主的真实顺序发事件：`tools/result`（`{name:'write', agent}` + `{isError:false}`）→ `agent/turn-stopping`（`{agent, turn}`）→ `agent/status`（`{agent, status:'idle'}`）；
4. **`agent/status` 之后必须 `await` 几个事件循环 tick**：lib/index.js 这里是 `void recapController.onStatus(payload)`（空闲边沿不能阻塞宿主），不 await，急着断言会读到执行到一半的状态；
5. 断言一律读**真实写出来的临时手册文件**（`readFileSync(path.join(dir,'playbook.md'))`），不读内存里的返回值——只有落盘结果能证明「整条链路真的跑到了 writeFileAtomic」。

假 agent 的最小表面：`session{ header:{origin:'cli'}, requestHeader:()=>({config:{provider,model}}), deriveMessages:()=>[...] }`、`options{provider,model}`、`runMaintenance(fn)`（idle 时 `await fn(signal)`，running 时抛 `already has active work`）、`whenIdle()`、`followup()`。**`deriveMessages()` 必须返回非空**，否则 `runRecap` 走「没有可用的轨迹」分支直接 `{skipped:true}`、根本不调 LLM。
**既有用例只换期望值、未放宽也未删除任何断言**（逐条理由统一：旧期望值钉的正是「额度蒸发」这个缺陷行为本身，`ownsPending` 判「不归我」之后的正确结果是过继而不是丢弃）：

- tests/trigger.test.mjs `:184` 起「abandonPendingRecap: await 窗口内挂上新待办时…」：`pending.mutCount` 1 → 3（过继 2 次）、`prevLastRecapTurn` 5 → 0（abandon 这一路把冷却一并过继并取更早者）；`st.mutCount === 0` 的断言保留（过继给的是队列里那份，不许同时再还回状态）。
- tests/trigger.test.mjs `:253` 起「新待办已被另一个空闲边沿取走时…」：情形一 `st.mutCount` 0 → 2、情形二 1 → 3，并新增一条「过继过一次」的 warn 断言（只加强，不减弱）。
- tests/trigger.test.mjs `:314` 起「restorePendingMutCount: await 窗口内挂上新待办时…」与 `:365` 起 / `:396` 起两条 requeue 用例：`pending.mutCount` 1 → 3；restore 那路的 `prevLastRecapTurn` 保持 5（失败分支只还计数、不过继冷却，第 4 轮刻意语义不变）。
- tests/recap.test.mjs `:246` 起 / `:335` 起 / `:378` 起：`mutCount` 1 → 3；`:335` 起那条另加 `calls.recap[1].mutCount === 3`（证明第二份待办执行时确实带着过继来的额度）。
- tests/recap.test.mjs `:283` 起：标题由「…迟到的回滚被拒」改为「…迟到的 skipped 回滚被拒但额度不蒸发，冷却不回退、不谎报已还回」，`st.mutCount` 1 → 3，`st.lastRecapTurn === 5` 保留。

反向自证（在 `adoptOrphanPending` 里、算出 `where` 之后临时插一句 `return false; // 直接拒绝、不过继`，跑完立刻删掉）：`node --test tests/trigger.test.mjs tests/recap.test.mjs` 由 67/67 绿变 `ℹ tests 67 / ℹ pass 50 / ℹ fail 17 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0`（EXIT=1），红的 17 条逐条如下（trigger 11 + recap 6）：trigger 侧——`restorePendingMutCount: await 窗口内挂上新待办时不碰队列、额度过继进新待办，并写一条 warn`、`requeuePendingRecap: await 窗口里已挂上更新的待办时，队列一个字段都不动、额度过继进新待办并明确拒绝`、`requeuePendingRecap: 耗尽分支也只清自己那一份，队列里更新的待办必须留着`、`abandonPendingRecap: await 窗口内挂上新待办时，旧 pending 回滚不吞新待办、不破坏计数`、`abandonPendingRecap: 新待办已被另一个空闲边沿取走时，迟到的回滚也必须被拒（代次判定）`、`F1：在飞的旧待办被拒时，额度过继给队列里那份更新的待办（不蒸发、不翻倍）`、`F1：队列已被另一个空闲边沿取空时，旧待办额度还回状态、但冷却不回退`、`F1：同一份旧待办被三条路径连拒，只过继一次（幂等，额度不翻倍）`、`H3：过继搬移抛错时额度不蒸发、账本也没封（冻结 / 只读 getter 两种构造）`、`ownsPending 旧形状兜底：pendingSeq 已前进过，无 seq 的旧待办一律不认`、`覆盖合并之后，迟到的 abandon/restore/requeue 作用在旧待办上一律被拒且一个字段都不动（D1）`；recap 侧——`失败分支只在待办仍归我时才还计数：await 窗口里挂上新待办时 mutCount 保持 0`、`两个空闲边沿交错：迟到的 skipped 回滚被拒但额度不蒸发，冷却不回退、不谎报已还回`、`撞忙回队时窗口里已挂上更新的待办：不许覆盖队列，也不许谎报「已放回队列」`、`撞忙重试到上限时窗口里挂上更新的待办：耗尽也不许抹掉队列里那份`、`F1 端到端（skipped 变体）：在飞的 p5 跳过时，3 次额度必须过继给队列里那份 p7`、`F1 端到端（busy 变体）：在飞的 p5 撞忙被拒时，3 次额度过继给 p7、且不静默`。H1/H2 在反向自证下照旧通过（它们断言的是与过继无关的行为：负数/垃圾计数按 0 处理、畸形 logger 不抛）；恢复后回到 67/67 全绿——说明这些断言真的钉住了 F1，而不是跟着实现随便改。

反向自证之二（临时把 lib/index.js 三处通知的 `content` 退回裸字符串：`conflictMessage` 的 `content: text`、`notifyFailure` 的 `content: 'ACE 自动复盘未完成：' + reason + …`、`/ace review` 的 `content: renderReviewText(items)`）：`node --test tests/` 由 282/281 全绿变 `ℹ tests 282 / ℹ pass 280 / ℹ fail 1 / ℹ cancelled 0 / ℹ skipped 1 / ℹ todo 0`（EXIT=1），唯一红的是 T227（单跑 `node --test tests/notice.test.mjs` 则是 `ℹ tests 8 / ℹ pass 7 / ℹ fail 1`）；T229 因为只钉文案与 source、不带形状前缀，照旧通过。失败原文照抄：`AssertionError [ERR_ASSERTION]: lib/index.js 第 1 处 createUserMessage 的 content 是「text,」，不是 ContentBlock[]。content 必须是 ContentBlock[]（MessageBase.content，~\@deepseek-ai\dsh-llm\lib\types\message.d.ts:128）：裸字符串会让宿主 .content.some 抛错、那条毒消息留在历史里会让整个会话永久坏死`。恢复三处修复后同一命令回到 `ℹ tests 282 / ℹ pass 281 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1 / ℹ todo 0` 全绿——形状断言真的钉住了这个缺陷，而不是跟着实现随便改。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。

反向自证之三（两条 trigger 硬化各自都被单独钉住）：把 `adoptOrphanPending` 改回「先记账、后搬移」（`ADOPTED_PENDINGS.add(pending)` 提到两处赋值之前）→ 全量 `node --test tests/` 恰有 1 条红：`H3：过继搬移抛错时额度不蒸发、账本也没封（冻结 / 只读 getter 两种构造）`；把两处结算改回 `const mutCount = Number(pending.mutCount); st.mutCount = (Number(st.mutCount) || 0) + (Number.isFinite(mutCount) ? mutCount : 0);` → 恰有 1 条红：`H4：负数 mutCount 不许把 st.mutCount 往回拽（失败回滚与跳过回滚两路同口径）`。两次都实测（EXIT=1），恢复后 282/281 全绿。**注意这个「恰有 1 条」只对文档自己写的那种退回式成立**：换别的退回写法可能连带红更多条——实测把两处结算退回更朴素的 `st.mutCount = Number(st.mutCount) + Number(pending.mutCount);` 会红 **3 条**（另两条是 tests/trigger.test.mjs 的 `abandonPendingRecap: 畸形输入不抛错` 与 `ownsPending 旧形状兜底：pendingSeq 已前进过，无 seq 的旧待办一律不认` 两条，它们也吃这两处结算）；所以「红了 3 条」不是文档写错了，而是退回式不同、连带面不同。

## 用例总表

**结论：覆盖持久化层（含归档独立文件）的解析、序列化、增量操作、并发与原子写，以及注入排序、候选判定、最少使用淘汰、LLM 合并与命中计数；LLM 真实产出与工具注册不在单测范围（见「未验证清单」）。**

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
| T29 | withTimeout | 正常值按时返回；超时与内部拒绝都以 Error 拒绝；**超时不 abort 上游**（宿主 `listModels` 没有 `signal`），上游晚到的 reject 被吞掉、不许变成 unhandledRejection | — | 同上 |
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
| T135 | toEntry / collectEntries | 字段映射：正文取条目字段、created/updated/hits/lastHit 取 meta；每条 entry 的字段集合与**顺序**固定为 `id,title,condition,action,rationale,auto,created,updated,hits,lastHit`，且 id/正文/三个时间字段为 string、auto 为 boolean、hits 为 number。**第 33 轮**：`helpful` / `harmful` 已从 meta 与接口里整层删除，不再出现在任何返回体里 | I4 | 同上 |
| T136 | toEntry | 缺字段的条目给空串/0/false；`toEntry({})` 稳定；元数据里 `hits` 写成非数字回落 0（与 `parseMeta` 的 `Number(v) || 0` 同口径）、三个时间字段缺失回落空串（旧手册只写日期的条目照常解析） | I4 | 同上 |
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
| T160 | trajectory 默认值 | `TRAJECTORY_DEFAULTS` 五项取值（maxMessages 60 / maxChars 12000 / maxTextChars 500 / maxArgChars 300 / maxToolResultChars 400），且 `renderTrajectory` 返回形状恰为 `{text, messageCount, truncated}` | — | tests/trajectory.test.mjs |
| T161 | renderTrajectory 顺序与前缀 | 多轮消息按原顺序渲染、角色前缀为 `用户: ` / `助手: ` / `结果(工具名): `，assistant 的 tool-call 紧跟在该条正文之后 | — | 同上 |
| T162 | renderTrajectory 跳过 system/developer | `system` 与 `developer` 整条跳过（系统提示与工具清单对复盘无意义且极长），且**不参与 messageCount** | — | 同上 |
| T163 | renderTrajectory 跳过 reasoning | 思维链块不占正文、不触发截断（最占体量的恰恰是它） | — | 同上 |
| T164 | tool-call 渲染 | 每个 tool-call 单独一行 `  → 工具名(参数)`，参数原文截断到 `maxArgChars` 并置 truncated | — | 同上 |
| T165 | tool 结果与失败前缀 | `isError === true` 时前缀 `[失败] `（有映射时为 `[失败] 结果(read): …`），正文截断到 `maxToolResultChars`；**没有对应 tool-call 时退回不带名字的 `结果: `** | — | 同上 |
| T166 | image / file / 未知块 | `image` → `[图片]`、`file` → `[文件]`，未知 type 直接忽略 | — | 同上 |
| T167 | maxTextChars | user/assistant 正文按上限截断并标记 truncated | — | 同上 |
| T168 | maxMessages 只取尾部 | 5 条消息、上限 2 时只渲染最后 2 条（真实会话可能几千条）；恰好等于上限时 truncated 为假 | — | 同上 |
| T169 | maxChars 首尾保留 | 超上限时**开头与结尾都保留**、中间插 `…（中间 N 字符已省略）`，N 恰为丢弃的字符数，且含标记在内的总长 ≤ maxChars | — | 同上 |
| T170 | 畸形输入不抛错 | `messages` 为 undefined/null/非数组/数字/对象、消息为 null、`content` 非数组、块不是对象或字段类型不对、未知 role —— 一律跳过而非抛错；非法 options 回落默认值 | — | 同上 |
| T171 | collectTurnTrajectory | 读 `agent.session.deriveMessages()`；缺失、非函数、抛错时返回 null 且只 `logger.warn`（宿主 API 变动不许把复盘搞崩） | I9 | 同上 |
| T172 | buildRecapSummary 有轨迹 | 首行计数 + 空行 + `## 本回合轨迹（最近 K 条消息）` + 正文，K 取 `messageCount` | I9 | 同上 |
| T173 | buildRecapSummary 无轨迹 | 轨迹缺失/为空时退化成只有计数那一行（「宁可信息少也不失败」） | I9 | 同上 |
| T174 | lib/trajectory.js 零 import | 源码级断言：文件里没有任何 `import`（含 node 内置）、没有 `require(`、不读盘 —— 宿主包在 `node --test` 里加载不到 | — | 同上 |
| T175 | lib/index.js runRecap 喂真轨迹 | 源码级切出 `runRecap` 函数体：必须调 `collectTurnTrajectory`、必须用 `buildRecapSummary({mutCount, trajectory})` 组 summary、`executeRecap` 签名不变；**不许**回退成只喂「本回合有 N 次 mutating 工具调用」这句计数 | I9 | 同上 |
| T176 | lib/index.js 空轨迹不调 LLM | 源码级：`if (!trajectory || !trajectory.text)` 守卫在调 LLM 之前，跳过路径写 `logger.info` 并 **`return {skipped:true}`**（不是裸 return——调度器靠它把冷却与计数还回去）、不跑 runMaintenance | I9 | 同上 |
| T177 | 拆门无残留 | 源码级：lib/index.js 里不再有 `listAgents` 装配，`inject` 不再声明 `'agents'` | I9 | 同上 |
| T178 | maxChars 超限后任务目标仍在 | 复刻验收者构造（1 条 user 目标 + 25×(assistant 480 字 + tool 结果 390 字) + 1 次 isError，全长 > 12000）：输出**以 `用户: 目标：修好 build 脚本` 开头**、含中间省略标记、总长 ≤ `TRAJECTORY_DEFAULTS.maxChars`，且拼进 `buildRecapSummary` 后目标仍可见（旧实现是硬截尾，目标整段消失） | I9 | 同上 |
| T179 | maxChars 极端值 | `maxChars: 200` 及 1/5/20/41/60 时都不抛错、总长 ≤ maxChars；`maxHeadChars` 被 `maxChars/2` 夹住时开头仍保留 | I9 | 同上 |
| T180 | 并行 tool-call 按 id 绑定 | 同一条 assistant 里两个不同 id、不同工具名的 tool-call + 两条结果 → 各自渲染成 `结果(read): …` / `结果(grep): …`；**结果乱序返回也按 id 绑定**，不靠位置猜 | I9 | 同上 |
| T181 | toolCallId 查不到时回退 | 未知 id 与根本没有 toolCallId 时退回不带工具名的 `结果: …` | I9 | 同上 |
| T182 | 映射每次调用新建 | 连续两次 `renderTrajectory`：第二次没有 tool-call 时同一个 id 不带出第一次的工具名（映射不跨调用串味） | I9 | 同上 |
| T183 | recordTurnEnd 记 prevLastRecapTurn | 挂待办时把**改之前**的 `lastRecapTurn` 存进 `pending.prevLastRecapTurn`（这里 5，而状态里已推进到 9）——顺序错了回滚就会拿到本回合 | I9 | tests/trigger.test.mjs |
| T184 | abandonPendingRecap 回滚 | 清空待办（不回队列）、把 `pending.mutCount` 加回 `state.mutCount`、`state.lastRecapTurn` 回滚成 `prevLastRecapTurn`；回滚后同一回合号下的下一回合**立刻能再次触发**（不被 cooldown 误挡），且还回来的计数不丢 | I9 | 同上 |
| T185 | abandonPendingRecap 畸形输入 | `state` 为 null/undefined、`pending` 为 null/字符串、`mutCount` 为 NaN、`prevLastRecapTurn` 非数字 —— 一律不抛错（非有限数按 0），入参缺失返回 false | I9 | 同上 |
| T186 | 空轨迹跳过回滚额度 | `runRecap` 返回 `{skipped:true}` 后：`pending` 为 null、`mutCount` 回到原值、`lastRecapTurn` 回到触发前的值、**`notifyFailure` 未被调用**、写一条 info；且下一个回合能立即再次触发（不被冷却误挡，计数一次都不吞） | I9 | tests/recap.test.mjs |
| T187 | 非 skipped 返回值不回滚 | `runRecap` 返回 `{added:[]}`（含 `undefined`）按「已执行」处理：`mutCount` 保持 0、`lastRecapTurn` 保持推进、不推提示 | I9 | 同上 |
| T188 | 退化分支省略数自洽 | 40 条消息（全文 > 8000 字符），`maxChars` 取 1/5/17/30/33/40/80（这些值下 `tailBudget <= 0`，走「开头 + 省略标记」退化分支）：要么 `text` 为空串，要么带**完整**省略标记（不许吐半截标记）；带标记时 `头长 + 尾长 + N === 全文长度`（N 恒等于真实丢弃数，旧算法会差 1~7 个） | I9 | tests/trajectory.test.mjs |
| T189 | 整条 summary ≤ maxChars | 轨迹本身贴着上限时，`buildRecapSummary` 拼上计数行与轨迹标题行后**整条仍 ≤ `maxChars`**（默认 12000；显式传 600 / 120 时也 ≤ 该值），且开头任务目标仍在（旧实现是直接拼，总长会到 12030） | I9 | 同上 |
| T190 | 旧 pending 回滚不吞新待办 | 复刻真实时序：turn5 挂待办 → `takePendingRecap` 摘走 → **await 窗口内** turn7 挂上新待办 → 用旧 pending 调 `abandonPendingRecap`：返回 false、`state.pending` 仍是新对象（对象身份不变、字段一字不改）、`mutCount` 不被旧计数污染也不吞掉 turn7 的 1 次、`lastRecapTurn` 不从 7 倒退，且留一条含「更新的待办」的 warn | I9 | tests/trigger.test.mjs |
| T191 | 重复放弃幂等 | 同一份 pending 连调两次：第一次 true、`mutCount` 加回一次；第二次返回 false，`mutCount` 不再累加（不变成 4）、`lastRecapTurn` 不再改 | I9 | 同上 |
| T192 | 新待办已被取走时迟到回滚被拒 | 复刻双 idle 边沿交错：turn5 挂 p5 → 取走 → 窗口内 turn7 挂 p7 → **p7 也被取走**（`state.pending === null`）→ 用 p5 调 `abandonPendingRecap` 必须返回 false，`mutCount`/`lastRecapTurn` 一字未改，warn 含「已被另一个空闲边沿取走」；随后 p7 走失败分支还回它自己的 1 次计数，p5 的迟到回滚仍被拒（`mutCount` 停在 1，不是 3） | I9 | tests/trigger.test.mjs |
| T193 | restorePendingMutCount 正常路径 | 单待办 → `takePendingRecap` → `restorePendingMutCount` 返回 true、`mutCount` 还回、`pending` 清空、**`lastRecapTurn` 不回滚**（失败=确实尝试过，冷却算已消耗）、不写 warn；`state` 为 null / `pending` 为 null 或字符串时返回 false 且不抛错 | I9 | 同上 |
| T194 | restorePendingMutCount 拒绝路径 | 复刻验收者实测：turn5 挂待办 (mutCount=2) → 取走 → await 窗口内 turn7 挂新待办 (mutCount=1) → 用旧 pending 调 `restorePendingMutCount`：返回 false、`mutCount` 仍是 0、新待办对象身份与字段一字未改、`lastRecapTurn` 仍是 7、warn 含「更新的待办」 | I9 | 同上 |
| T195 | requeue 后再次 take 再放弃仍生效 | `requeuePendingRecap` 放回的是同一份待办（对象身份不变、`seq` 与 `state.pendingSeq` 都不变）；再次 `takePendingRecap` 拿到的还是它（`attempts` 1→2），再 `abandonPendingRecap` 仍返回 true 且额度真还回、冷却回滚——代次判定不误拒重试路径 | I9 | 同上 |
| T196 | 失败分支只在归我时才还计数 | 端到端：turn5 挂待办 (mutCount=2) → idle 取走 → `runRecap` 抛错前的窗口里 turn7 挂新待办 (mutCount=1) → catch 后 `mutCount === 0`（旧实现是 2）、新待办对象一字未改、`lastRecapTurn` 仍是 7、写「自动复盘失败」与「更新的待办」两条 warn、`notifyFailure` 仍被调用一次 | I9 | tests/recap.test.mjs |
| T197 | 双 idle 边沿交错 | 端到端：边沿 A 取走 p5（`runRecap` 挂起）→ turn7 挂 p7 → 边沿 B 取走 p7 → B 报 `{skipped:true}` 合法回滚（写 info、`mutCount` 1、冷却 5）→ A 的 skipped 迟到：被拒，`mutCount` 仍 1（不是 3）、`lastRecapTurn` 不变，且**不写**含「回合 5 … 已还回」的 info，只写一条说明新待办已被取走的 warn | I9 | 同上 |
| T198 | maxChars 小于计数行长度 | 计数行 28 字符（N 为一位数）/29 字符（两位数）；用**有轨迹**的输入，`maxChars` 取 1..(计数行长度−1) 时返回值**恰等于完整计数行**且不含 `## 本回合轨迹`；`maxChars` 刚好等于计数行长度时仍是只有计数行；再多 40 字符就必须恢复「整条 ≤ maxChars」并带上轨迹标题 | I9 | tests/trajectory.test.mjs |
| T199 | requeue 遇更新待办时拒绝放回 | 复刻验收者实测：turn5 挂 p5(seq=1) → 取走 → 窗口内 turn7 挂 p7(seq=2) → `requeuePendingRecap(st, p5, 3, logger)` 返回 `{exhausted:false, pending:null, rejected:true}`，`state.pending` 仍是 p7（对象身份不变、字段一字未改）、`pendingSeq`/`lastRecapTurn`/`mutCount` 全不动，并留一条含「更新的待办」的 warn——旧实现无条件 `st.pending = pending`，p7 被静默丢弃且日志还谎报「已放回队列」 | I9 | tests/trigger.test.mjs |
| T200 | requeue 耗尽分支不抹新待办 | p5 试满 3 次、窗口内已挂 p7 → `requeuePendingRecap(st, p5, 3)` 返回 `exhausted:true` 且 `rejected:true`，但 `state.pending` 仍是 p7（旧实现 `if (st) st.pending = null` 会把它抹掉） | I9 | 同上 |
| T201 | restorePendingMutCount 幂等 | 同一份待办连调三次：第一次 true、`mutCount` 3；第二/三次返回 false、`mutCount` 仍 3（旧实现 3→6→9），`lastRecapTurn` 不被改动（失败分支仍不回滚冷却），每次被拒各写一条含「结算过」的 warn | I9 | 同上 |
| T202 | 两条回滚路径共用已结算账本 | 先 abandon 再 restore 同一对象：第二次返回 false、`mutCount` 停在 3（旧实现变 6）、冷却不被失败分支改；反过来先 restore 再 abandon 同样返回 false、`mutCount` 仍 3、冷却不被放弃路径回滚 | I9 | 同上 |
| T203 | requeue 不是结算 | `requeuePendingRecap` 放回后再次 `takePendingRecap` 拿到同一份，`restorePendingMutCount` 仍返回 true、额度真还回——若把放回也记进已结算账本，重试路径的下一次失败回滚会被误拒 | I9 | 同上 |
| T204 | 旧形状兜底：代次已前进即不认 | `pendingSeq = 5`、队列为空、传无 `seq` 的 `{turn:1, mutCount:2, attempts:1, prevLastRecapTurn:0}`：`abandonPendingRecap` 与 `restorePendingMutCount` 都返回 false，`mutCount` 不被还回 2 次、`lastRecapTurn` 不倒退（旧实现 0→2）；队列里压着新待办时同样不认；`pendingSeq === 0` 的全新状态仍放行手工构造的旧形状（既有用例走的就是这一档） | I9 | 同上 |
| T205 | 撞忙回队不覆盖更新待办（端到端） | turn5 挂 p5 → idle 边沿取走 → `runRecap` 里宿主跑完 turn7 挂 p7 后抛忙 → `state.pending` 仍是 p7（字段一字未改）、`pendingSeq`/`lastRecapTurn`/`mutCount` 不动、`notifyFailure` 不触发、写含「旧待办未放回队列」的 warn 且**不写**「待办已放回队列」；下一个空闲边沿执行的是 turn7 那一份 | I9 | tests/recap.test.mjs |
| T206 | 撞忙重试到上限仍保留更新待办（端到端） | `maxAttempts=1` 让第一轮就撞上限，窗口内已挂 p7：`state.pending` 仍是 p7（旧实现被抹成 null）、`notifyFailure` 仍调一次并说明「队列里那份更新的待办仍在」，之后那个空闲边沿照常执行 turn7 | I9 | 同上 |
| T207 | 记账时合并队列里没执行的旧待办 | 回合 5 挂 `p5{mutCount:3,seq:1}`、撞忙回队后 `attempts=1`、回合 6 冷却未到只记 2 次，回合 7 再触发：新待办 `mutCount = 5`（旧实现只剩本回合的 2，回合 5 那 3 次静默蒸发）、`attempts` 回到 0、`seq` 变 2 | I9 | tests/trigger.test.mjs |
| T208 | 合并后回滚还回最老那一笔的原值 | 合并待办里记的 `prevLastRecapTurn` 是旧待办那份（最老那一笔推进之前的值），`abandonPendingRecap` 后 `lastRecapTurn` 回到它、不是旧待办那一轮——否则中间那几回合的冷却被白吃（还回到 5 时回合 5 立刻能再触发会被 `5-5=0 < 2` 挡掉） | I9 | 同上 |
| T209 | 覆盖合并必须留痕 | 发生合并时 `recordTurnEnd` 写一条 info，写明「回合 5 的待办还没执行，已合并进回合 7 的待办（累计 5 次 mutating 调用）」——否则事后从日志里看不出旧待办的经验去哪了 | I9 | 同上 |
| T210 | `recordTurnEnd` 的 logger 可选 | 不传、传 `null`、传 `{}` 三种调用都不抛错、状态照常推进（`lib/recap.js` 之外的既有调用点不带 logger） | I9 | 同上 |
| T211 | 合并后旧待办不可能再被结算 | 覆盖合并之后，迟到的 `abandonPendingRecap` / `restorePendingMutCount` 对旧对象返回 `false`、`requeuePendingRecap` 返回 `rejected:true`，三者都不动 `st` 的任何字段（JSON 快照前后一致），各写一条 warn——`pendingSeq` 已被顶替，`ownsPending` 天然拒 | I9 | 同上 |
| T212 | 撞忙回队 + 冷却期内记账 → 合成一份（端到端） | 经 `createRecapController`（cooldown=2）走完回合 5 干 3 次 → 空闲边沿撞忙回队 → 回合 6 干 2 次 → 回合 7 触发：`state.pending.mutCount === 5`、`attempts === 0`、`prevLastRecapTurn === 0`，日志里有一条合并 info、`notifyFailure` 不触发；下一个空闲边沿执行的正是这一份 5 次 | I9 | tests/recap.test.mjs |
| T213 | 合并待办被放弃：冷却回原值、额度不白吃（端到端） | 合并后的待办走 `{skipped:true}` 回滚：`mutCount` 一次还回 5、`lastRecapTurn` 回到最老那一笔的原值 0（不是旧待办那一轮 5）；随后回合 5 立刻能再触发，且还回来的 5 次与新记的 1 次一起进新待办（`mutCount === 6`） | I9 | 同上 |
| T214 | 在飞旧待办被拒：额度过继给队列里那份新待办 | p5{mutCount:3,seq:1} 被空闲边沿 `takePendingRecap` 摘走 → 回合 6 冷却未到只记 2 次 → 回合 7 挂 p7{mutCount:2,seq:2} → p5 的 `{skipped:true}` 迟到：`abandonPendingRecap` 仍返回 false，但 p7 的 `mutCount` 变 5（旧实现那 3 次永久蒸发）、`prevLastRecapTurn` 退到 0（abandon 这一路把冷却一并过继，取两者更早者）、`st.mutCount` 仍是 0（不许既过继又还状态） | I9 | tests/trigger.test.mjs |
| T215 | 队列已被取空时还回状态、但冷却不回退 | 同上时序但 p7 也被另一个空闲边沿取走：`st.mutCount` 3、`lastRecapTurn` 保持 7（冷却由那份在飞待办自己结算，这里再倒退一次会重复退还）、warn 含「已被另一个空闲边沿取走」与「冷却不回退」；随后 `restorePendingMutCount(st, p7)` 返回 true 使 `mutCount` 5（再过继就翻倍） | I9 | 同上 |
| T216 | 同一份旧待办被三条路径连拒只过继一次 | p5 先 `abandon`（p7.mutCount 5）→ 再 `restore`（仍 5）→ 再 `requeue`（`rejected:true`、仍 5）：三条路径各写一条 warn，后两条含「过继过一次」——`ADOPTED_PENDINGS` 挡住重复过继，否则 3 次额度会被加三遍 | I9 | 同上 |
| T217 | 已被合并吸收的旧待办不许再过继 | 回合 6 记账把 p5 合并进 p7（`ABSORBED_PENDINGS` 记录）后，迟到的 abandon/restore/requeue 三路径全 false/rejected、`state` 的 JSON 快照前后一致、p7.mutCount 仍是 5（不是 8），warn 全含「已经合并进更新的待办」——第 6 轮不变量 2「不许重复计入」不被 F1 过继破坏 | I9 | 同上 |
| T218 | 合并时负数与垃圾 mutCount 一律按 0 | `queued.mutCount = -3` 合并后 `mutCount` 为 2（旧实现 `Number(-3) || 0` 原样接受负值，日志会写出「累计 -3 次 mutating 调用」）；`'不是数字'` → 只算本回合那 1 次；过继一份 `mutCount:-5` 的旧待办也不许把 p7 的计数往下拖（`clampMutCount`） | I9 | 同上 |
| T219 | 畸形 logger 各种形状都不抛 | `undefined / null / 0 / 5 / '' / true / {} / {info:5} / {warn:5} / {info:'x',warn:'y'} / {get info(){throw new Error('boom')}}` 逐个喂给 `recordTurnEnd` / `abandon` / `restore` / `requeue` / 已结算重复放弃，全部 `doesNotThrow`（旧实现 `logger?.info?.(…)` 传 `{info:5}` 会抛 `TypeError: logger?.info is not a function`，而这些日志全在竞态回滚路径上，日志炸掉会把「额度还没还回去」变成「整个空闲边沿抛异常」） | I9 | 同上 |
| T220 | F1 端到端（skipped 变体） | 经 `createRecapController` 走完 4 步时序（回合 5 干 3 次 → 空闲边沿取走 p5 并挂住 `runRecap` → 窗口里回合 6/7 挂 p7 → p5 返回 `{skipped:true}`）：p7.mutCount 5、prevLastRecapTurn 0、`st.mutCount` 0、`lastRecapTurn` 7，日志里没有「回合 5 … 还回状态」那条谎报、有含「过继给回合 7」的 warn；下一个空闲边沿执行的正是这份 5 次 | I9 | tests/recap.test.mjs |
| T221 | F1 端到端（busy 变体，不许静默） | 同上时序但 p5 抛 `already has active work`：`requeuePendingRecap` 拒绝放回（`state.pending` 仍是 p7）却仍把 3 次过继进 p7，warn 里既有「过继给回合 7」也有「这一轮没跑成」（改动前 `if (outcome.rejected) return;` 直接静默，事后从日志看会以为回合 5 那轮复盘没被触发过）、没有「待办已放回队列」、`notifyFailure` 不触发 | I9 | 同上 |
| T222 | `textBlocks`（lib/notice.js） | 恒返回长度 1 的 `[{type:'text', text}]`；空串也照样成块（不许「优化」成 `[]`，宿主 `.content.some` 要能在上面跑）；每次调用都是新数组、不是共享常量 | I10 | tests/notice.test.mjs |
| T223 | `textBlocks` 的非字符串兜底 | `undefined`/`null` → `''`、`0` → `'0'`、`new Error('boom')` → `'Error: boom'`、自定义 `toString` → 其结果，且返回块的 `text` 恒为 string——这三处注入点全在失败/竞态路径上，兜底不许再抛一个异常出来 | I10 | 同上 |
| T224 | `noticeMessage` 的返回形状 | `content` 是 `ContentBlock[]`、`source.kind === 'dsh-ace'`、`source.form === 'notice'`、`summary` 原样透传；顶层只有 `content`/`source` 两个键（不许自带 `id`/`role`，那两个由宿主的 `createUserMessage` 补） | I10 | 同上 |
| T225 | `noticeMessage` 参数缺失/畸形 | 无参调用 → `content` 为 `[{type:'text',text:''}]`、`summary` 为 `''`；`summary:5` → `'5'`；`kind:''` / `kind:7` → 回落 `'dsh-ace'`；`kind:'other'` 原样；全程不抛错 | I10 | 同上 |
| T226 | lib/notice.js 零依赖红线 | 源码里没有任何 `import`/`require`、不读盘——宿主包在 `node --test` 里加载不到（本仓库无 `node_modules`），这个模块一旦 import 宿主就没法被直接断言 | 红线 6 | 同上 |
| T227 | lib/index.js 里每个 `createUserMessage` 的 `content` 形状（源码级） | 全文每一个 `createUserMessage(...)` 的 `content` 必须是以 `[` 开头的数组字面量，或 `textBlocks(` / `noticeMessage(` 这类返回数组的调用；不许是字符串字面量、也不许是裸标识符。失败信息写明「content 必须是 ContentBlock[]，裸字符串会让宿主 `.content.some` 抛错、整个会话永久坏死」——这正是本次修掉的那个事故 | I10 | 同上 |
| T228 | T227 检查器自证 | 把 `content: 'ACE 自动复盘未完成：' + reason`、`content: text` 合成进假源码必须被当场抓住（含 `SHAPE_HINT` 那句失败信息）；缺 `content` 字段也要报；合法三形态（数组字面量 / `textBlocks(` / `noticeMessage(`）各算 1 处；`import` 行与 `//` 注释里的提及不算——没有这条，T227 可能是假绿 | I10 | 同上 |
| T229 | 三处通知的文案与 source 一字未改 | 失败通知正文 `'ACE 自动复盘未完成：' + reason + '。本次沉淀的经验没有并入手册，可重试。'`、摘要 `'ACE 自动复盘未完成，经验未并入手册'`、冲突摘要 `'ACE 手册有 ' + conflicts.length + ' 条改动因并发冲突未并入'` 原样保留；`/ace review` 仍注入 `renderReviewText(items)`——这一轮是形状修复，不是文案改版 | I10 | 同上 |
| T230 | 过继「先搬移、后记账」（H3） | 队列里那份待办的字段被 `Object.freeze`、或它的 `mutCount` 是只读 getter 时，搬移这一步会抛错：此时 `ADOPTED_PENDINGS` 不许已经记上（否则额度一次都没搬成、这份待办却被永久封账，额度永久蒸发）；换一份可写的同值待办之后，同一条路径必须仍能正常过继（额度确实搬进去、warn 里没有「过继过一次」） | I9 | tests/trigger.test.mjs |
| T231 | 结算夹取口径与过继/记账统一（H4） | `pending.mutCount = -4`、`st.mutCount = 10` 时，`restorePendingMutCount` 与 `abandonPendingRecap` 结算后 `st.mutCount` 仍是 10——改动前 `Number(...)` 只挡 `NaN`/`Infinity`，负数有限值会被原样收下，把状态往回拽成 6 | I9 | 同上 |

| T232 | 注入投递 → hits +1（第 33 轮，a） | 真跑 `agent/pre-step` 把注入消息追加进历史 → 回合边界 `takeHitIds` + `flushHits` 一次原子写盘；盘上这 2 条 `hits` 各 +1、`lastHit` 是毫秒戳、元数据行里**没有** `helpful` / `harmful` | I11 | tests/injection-flow.test.mjs |
| T233 | 同一批注入重复装配不重复计数（第 33 轮，a2） | 连跑三次 pre-step：只有第一次追加消息、`injectedAppended` 只 +1、账本里仍是同一批 id；再走一次回合边界，`hits` 只 +1 一次（`delivered` WeakMap 认领语义） | I11 | tests/inject-delivery.test.mjs / tests/injection-flow.test.mjs |
| T234 | 检索命中（第 33 轮，b） | `ace_playbook` 整本读取：`hits` 与 `retrievalHits` 都不动；带 `query` 定向查找：命中的条目 `hits` +1 且 `retrievalHits` 加同样的数；带 `id` 查找：再 +1；`lastHit` 是毫秒戳且日期部分等于当天 | I11 | tests/wiring.test.mjs |
| T235 | 满额先合并（第 33 轮，c） | `maxEntries` 已满时先走 `planMerges`：LLM 合成一条同构四字段条目、**保留 `created` 更早那条的 id**、另一条搬进 `archive.md` 且 `reason=merged`；合并后活跃条数 ≤ 上限、手册里没有 `## 归档区` | I12 | tests/recap-pipeline.test.mjs / tests/e2e.test.mjs（场景 5b） |
| T236 | 合并失败绝不许阻塞落盘（第 33 轮，d，守护②） | LLM 抛错 → 该对被摘掉换下一对；全部失败 → 跳过合并直接按 `planEvictions` 淘汰腾位，**这一批复盘照常成功**（候选一条不丢、`recapStats` 不记失败）；输出过不了 `extractJsonObject` 或四字段任一不合格同样按该对失败处理 | I12 | tests/recap-pipeline.test.mjs |
| T237 | 淘汰顺序（第 33 轮，e，守护①） | `compareForEviction` 三级判据：`hits` 升序 → `created` 更早先走（同 hits 时 5 条夹具的三条编号顺序与创建顺序故意相反，断言排序结果就是「老的先走」而不是按编号）→ 同 hits 且同 created 时按 `idNumber` 数字升序（不是字典序、不是随机） | I12 | tests/archive.test.mjs |
| T238 | 淘汰进独立归档文件并腾位（第 33 轮，f） | 满额（含 0 候选回合的 `commitCapacity` 路径）→ `hits` 最少的条目搬进 `archive.md` 且带 `- 归档：reason=evicted date=…`、活跃区腾位、新条目正常落盘；**先写归档文件再写手册**（顺序反过来一旦手册写失败就等于物理删除）；两个子进程同时带淘汰钩子写，被淘汰的条目在归档里一条不丢也不重复 | I12 | tests/archive.test.mjs / tests/concurrency.test.mjs / tests/recap-pipeline.test.mjs |
| T239 | 手册里永不出现 `## 归档区`（第 33 轮，g） | `parseEntryDocument` 不认这个章节、`serializePlaybook` 不写它：旧手册里残留的 `## 归档区` 在写回时被清掉、其下条目按普通块被识别；归档文件与手册同构（同款条目块 + 元数据行 + 一行归档说明），写入走 `withExclusiveLock` + `writeFileAtomic`、不留残渣 | I13 | tests/archive.test.mjs |
| T240 | 整本读取不含归档条目（第 33 轮，h） | `ace_playbook` 整本读取拿到的正文里没有归档条目、也没有 `## 归档区`，且一次都不计命中；归档条目只在 `GET /api/dsh-ace/entries` 的 `archived` 分区与 `archive.md` 里可见 | I13 | tests/e2e.test.mjs / tests/wiring.test.mjs |
| T241 | 毫秒时间戳（第 33 轮，i，守护③） | 写入 → 读回 → 排序正确（同 hits 下按毫秒戳排，同毫秒按 id 兜底）；旧格式（只有 `YYYY-MM-DD`）照常解析、不抛错、排在同样日期更早的位置；**跨进程**：两个完全独立的子进程各读同一本手册各算一遍排序，结论必须一致（守护③） | I14 | tests/recap-usage.test.mjs |
| T242 | 候选过滤只剩「标题非空」（第 33 轮，j） | 空标题（空串 / 纯空格 / 换行制表）拒绝且不落盘；非空一律放行——**不再有长度上限、不再有指代词规则、不再有文件名规则**（48 码点长标题、正文含 `C:\work\a.md`、condition 里带「本次」都照常落盘） | I15 | tests/recap-pipeline.test.mjs |
| T243 | 注入排序键 = 纯 BM25（第 33 轮，k） | `rankInjection` 只按相关度排、同分按 `idNumber` 数字升序、行里不再有净分项；**`hits` 高低不影响排序**：`hits=999` 的零字面交集条目不进注入、正文逐字相同的三条按 id 排而不是按 hits 排（防自增强棘轮） | I14 | tests/inject.test.mjs |
| T244 | `MERGE_SYSTEM` 与 `planMerges`（第 33 轮） | 提示词四段式（目标 / 只做什么 / 不做什么含反例 / 输出契约必须是 JSON）；`parseMergeResult` 七种输入（合法四字段 / 缺字段 / 空串 / 非 JSON / 数组 / 嵌套错位 / 代码围栏包裹）；`planMerges` 最多 5 轮、每轮一对、**永不抛错** | I12 | tests/merge.test.mjs |

**第 34 轮「审查 report33 的 5 条必修 + 6 条建议修」净增 13 条 / 全量 471 条（470 通过 + 1 skip）**：本轮**没有整份删文件**，改的是「同一批用例从假断言换成真行为断言」+ 补盲区。逐文件：tests/archive.test.mjs 21 → **29**（+7 行为用例：h1/h2/h4/h5/i1/i2 与 h3，外加既有 C4.3 那条假断言改写成真断言）、tests/recap-usage.test.mjs 12 → **14**（+2：退回账本的命中与下一批新命中合并成一次写盘、没有 `noteHitIds` 可退时明说已丢失）、tests/client-stats.test.mjs 20 → **21**（+1：统计块日期格对空值/垃圾值给「—」）、tests/client-entries.test.mjs 24 → **26**（+2：毫秒戳经 client 渲染成 10 字符日期、日期格兼容旧格式/空值/垃圾值）。
- **必修补的是零用例的盲区，不是行为**：归档写失败被吞掉（审查变异 M5/N11）在旧套件里**458 条全绿**，因为没有任何一条用例把 `archive.md` 造成不可写。现在 `archive.md` 用 `fs.mkdir` 造成目录，`appendArchivedEntries` 必抛 `EISDIR`，于是同时钉住三件事：①`commitOps` / `commitCapacity` 都**抛错**；②手册**字节完全未变**（`Buffer.equals`，不是只数条数）；③归档里**没有**新条目、被淘汰的条目**没有蒸发**。
- **锁内顺序（先归档、后手册）用可观测量钉住**：h3 的手册**故意不写 `<!-- ace:id-highwater: N -->` 标记行**（先断言 `readIdHighWater(snapshot) === 0`），归档不可写时手册必须**字节不变且高水位仍为 0**；两行对调后 `writeFileAtomic` 先写、手册会被写成高水位 4 再抛错 → 变红。**没有用源码正则**。
- **高水位补了「归档原文」这一路**：`maxArchivedIdNumber` 不再只遍历 `parseArchiveFile` 的结果，而是逐行扫归档原文，只对 `^\s*###` 标题行取 `/\[?ace-(\d+)\]?/`（正文里偶然出现的 `ace-999` 不算）。理由：`HEADING_RE`（lib/entry-format.js:23）要求标题非空，旧格式 `### ace-500` 与空标题 `### [ace-888]` 解析不出来，但编号确实被用掉了 —— 人工手写归档就能触发编号复用。h4 的归档里同时放了这两种形状 + 一个正文里出现的 `ace-999`，断言 `parseArchiveFile` 只认出 `['ace-778','ace-601']`、`maxArchivedIdNumber(原文) === 778`。
- **建议修 6 的兜底是确定性的**：`evictPlan` 抛错时按 `compareForEviction` 全序排序取前 N 条（i1 断言兜底结果与 `planEvictions` 逐条相同，不是随便挑）。i2 覆盖「返回不可用值」（`() => undefined`）这一支。
- **建议修 7 把假承诺改成真重试**：写盘失败时把这批 id 借 `noteHitIds`（= `lib/ledger.js` 的 `note`）退回账本，下个回合边界取走的是**退回的那批 + 本回合新命中**的合并结果，一次写盘。
- **三处假断言已改写（指名范围内）**：tests/archive.test.mjs 的「C4.3｜dayString 现在是毫秒时间戳」原来自己 `slice(0,10)` 再断言等于 `'2026-10-24'`（slice 是测试做的，client 从来没截过）；tests/client-stats.test.mjs 的「运行统计：归档按四种结构性原因分列…」那条原来只用源码正则断言「client.js 里出现 injectedSkipped/injectedFailed 两个字段名」（钉住的正是一格假 0）；tests/recap-usage.test.mjs 的两条「回合边界｜写盘失败只 warn 不抛」「没有 noteHitIds 可退时…」原来把「下个回合边界再记」这句没实现的承诺钉成契约。
- **变异自证十一条**（每条都真跑、跑完逐字复原）：MA 归档写被 try/catch 吞（commitOps）→ h1/h3 红（2 条）；MB 同源（commitCapacity）→ h2 红；MC 两行对调（先手册后归档）→ h1/h3 红（手册先被写坏）；MD 高水位去掉 `maxArchivedIdNumber` → h4 红；MF 高水位只留 `readIdHighWater + maxEntryIdNumber(baseEntries)` → f/h4/h5/i1/i2 红（5 条）；MG 删掉淘汰兜底 → i1/i2 红；M7 删掉「退回账本」→ 两条 recap-usage 用例红；M-D1/M-D2（界面日期截断改恒等 / 恒返回「—」）→ 分别红 4 条 / 6 条；必修 5 把两格假 0 加回去 → 红 1 条。**唯一全绿的是 ME**（把高水位计算挪到淘汰之前）：它是**等价变异**——四项输入一个没变（`baseEntries` 被移走的条目仍留在 `parsed.entries` 里，由 `maxEntryIdNumber(parsed.entries || [])` 兜住），所以输出必然相同；要钉住「淘汰后重算」必须削弱淘汰前的编号来源，也就是 MF。
- **基线演进接着上一段**：458 → 471（470 通过 + 1 skip），测试文件数 28 不变。语法自检：`lib` 下 29 个 `.js` + `client.js` 逐个 `node --check`，0 错。

**第 35 轮「设置页两个数字项的 0 语义」净增 6 条 / 全量 477 条（476 通过 + 1 skip）**：修的是「文案承诺 0 表示不冷却 / 每次都触发，代码却用 `Number(x) || 默认值` 把显式 0 兜成默认值」。
- **生产改动只有一处文件两行**：`lib/trigger.js` 新增私有函数 `numberOrDefault(value, fallback)`（:94-122），`shouldTriggerAutoRecap` 里的 `const threshold = Number(config.autoRecapThreshold) || 1;`（原 :104）与 `const cooldown = Number(config.autoRecapCooldownTurns) || 2;`（原 :108）改为 `numberOrDefault(config.autoRecapThreshold, 1)`（:135）与 `numberOrDefault(config.autoRecapCooldownTurns, 2)`（:140）。其余判据（`config.autoRecap === false` 直接 false、`mutCount < threshold`、`currentTurn - lastRecapTurn < cooldown` 的 `<` 边界）一字未动。
- **取值取舍（契约，已写进 `numberOrDefault` 的 JSDoc）**：`undefined` / 键不存在 → 回落默认值；**`null`、空串、纯空白串同样回落**——`Number(null)` 与 `Number('')` 都是 0，照收会把「设置页把输入框清空」读成「用户要求最激进配置」（cooldown 0 = 每回合都复盘、threshold 0 = 空回合也复盘），代价是整晚白跑模型调用；要 0 就显式写 0（数字 `0` 与字符串 `'0'` 都算显式）。数字字符串照常按数字收。`NaN` / `Infinity` / 非数字字符串回落。**负数不夹到 0**：设置页 bounds 是 0–1000（`lib/index.js:1242-1243`），负数只可能来自手改配置，负 cooldown 让 `currentTurn - lastRecapTurn < cooldown` 恒 false（等价不冷却）、负 threshold 同理恒过，与改动前语义一致；夹到 0 会在 `lastRecapTurn > currentTurn` 的反常状态下改变行为，为最小改动面保持原样。
- **tests/trigger.test.mjs 46 → 52（+6，T246–T251）**，全部真跑 `shouldTriggerAutoRecap` / `recordTurnEnd` 真对象、**没有一条源码正则**：cooldown 0 下 `lastRecapTurn === currentTurn`（差 0 轮）仍触发、`9 → 10` 仍触发、字符串 `'0'` 同样算显式；threshold 0 下 `mutCount: 0` 仍触发；缺键（含显式 `undefined`）仍按默认 2 / 1（`mutCount:0` 不触发、`9 → 10` 挡、`8 → 10` 放行）；`null` / `''` / `'   '` / `'\t'` / `NaN` / `Infinity` 逐个按「没配」回落；`recordTurnEnd` 在 cooldown 0 下同一回合号连记两次照挂第二份待办（`pendingSeq 2`、`prevLastRecapTurn 7`）、在 threshold 0 下 `mutCount` 保持 0 也挂待办。
- **tests/recap.test.mjs 只改注释、断言一条未动**：:178-180 原注释把「显式配 0 也等价于 2」当事实写（现在 0 真的不冷却，且本文件 `makeController` 默认就是 `autoRecapCooldownTurns: 0`）；:443-444 原注释说「cooldown 显式配 0，但实际等价 2」，而该用例的 `getConfig` 早就传的是 `autoRecapCooldownTurns: 2`，注释与代码不符，已改成「这里显式配 2（= 默认值），5 → 6 被挡、5 → 7 放行」。**改动前跑过一次全量：现有 471 条一条都没依赖 0 回退**，所以没有用例是靠旧回退才通过的。
- **变异自证**：把两处 `numberOrDefault(...)` 逐字改回 `Number(...) || 1` / `|| 2`（其余不动）→ `tests 477 / pass 472 / fail 4`，**精确红 4 条、没有连带红**，红的正是新增的四条 0 语义用例：`shouldTriggerAutoRecap: cooldown 显式配 0 = 不冷却（lastRecapTurn === currentTurn 也触发）`、`shouldTriggerAutoRecap: threshold 显式配 0 = 每次都触发（mutCount 0 也触发）`、`recordTurnEnd: cooldown 显式配 0 → 同一回合号再记一次也照样挂待办`、`recordTurnEnd: threshold 显式配 0 → 本回合一次都没动手也挂待办`。跑完立刻按字节写回原样（sha256 与变异前逐字相同）。另两条新增用例（缺键回落、null/'' 回落）在旧写法下**仍然通过**，这正是它们该有的表现——它们钉的是「缺失才回落」，旧写法在缺失时行为恰好相同。
- **语法自检**：`lib` 下 29 个 `.js` + `client.js` 共 30 个文件逐个 `node --check`，**bad = 0**。
- **基线演进**：471 → 477（476 通过 + 1 skip），测试文件数 28 不变。
- **生效时机**：`lib/trigger.js` 是服务半边，改动**要重启宿主才生效**；已在运行的会话里设置页仍按旧代码判定，重启后填 0 才真的表示「不冷却 / 每次都触发」。

**第 36 轮「话题热度 + 新条目保护期 + 三个预算配置项」净增 39 条 / 全量 516 条（515 通过 + 1 skip）**：生产面 = 新模块 `lib/heat.js` + `lib/inject.js` 排序键（0.9 × 归一化相关度 + 0.1 × 归一化话题热度）+ `lib/evict.js` 的 `protectDays` + `lib/index.js` 的接线与三个配置项（`evictProtectDays` 14 / `injectTokenBudget` 900 / `injectMaxEntries` 5）+ `client.js` 的三个 number 字段。
- **新增 5 个测试文件（39 条）**：tests/heat.test.mjs **14**、tests/heat-wiring.test.mjs **2**、tests/evict-protect.test.mjs **10**、tests/config.test.mjs **9**、tests/tuning-behaviors.test.mjs **4**（逐条覆盖见文末新增表）。**没有一条源码正则**，全部真跑生产函数（含真 HTTP 路由与真事件流）。
- **既有用例改了三处（契约变化，断言没有放宽）**：tests/wiring.test.mjs:391-394 的 Config 字段数 9 → 12；tests/entries.test.mjs 条目⑧ 改成 `/defaults: \{[\s\S]*?maxEntries: DEFAULT_MAX_ENTRIES/`（`bounds.defaults` 现在有四个键）并保留「不许写死数字」的反向断言；tests/e2e.test.mjs 场景 5 的 `makeHost` 加 `config: { evictProtectDays: 0 }`（该场景故意让条目只有 10 天龄，默认 14 天保护会把旧期望顶掉）。
- **顺手修掉一个真实缺陷**：`normalizeSettings` 读设置文件时对三个新键原用 `validInt`，而 `Number(null) === 0`、`Number('  ') === 0` —— 被手改坏 / 旧版本写下的 `evictProtectDays: null` 会被静默读成「0 = 不保护新条目」。新增 `validTunableInt`（null / 空白串 → undefined → 回落默认值），显式 0 仍保留。
- **设置写入只认 POST**（`lib/index.js` 的 `if (method !== 'POST') return send(405, { error: 'method not allowed' })`）：tests/config.test.mjs 按真实契约发 POST，没有为了让用例好写去改生产语义。
- **变异自证与语法自检**：变异表见 FIX-REPORT-R36.md（改了哪一行 → 哪条用例变红，无落空项）；`lib` 下每个 `.js` + `client.js` 逐个 `node --check`，bad = 0。
- **基线演进**：477 → 516（515 通过 + 1 skip），测试文件数 28 → 33。

**第 37 轮「不满额轻量合并 + 注入首行文案跟随配置 + 只读体检脚本」净增 30 条 / 全量 546 条（545 通过 + 1 skip）**：生产面 = `lib/merge-llm.js` 的两个新常量（`MERGE_EAGER_THRESHOLD_RATIO = 0.75` / `MERGE_EAGER_MAX_ROUNDS = 2`）+ `lib/recap-pipeline.js` 的 `else if (adds > 0)` 轻量合并分支 + `lib/inject.js` 的 `renderInjection(picked, { withRationale, maxEntries })` 与 `selectInjection` 三处透传 + 新脚本 `tools/diagnose.mjs`。
- **新增 1 个测试文件（24 条）**：tests/diagnose.test.mjs **24**（逐条覆盖见文末新增表）。**没有一条源码正则**钉行为——唯一例外是 A10 的反向接线检查，它钉的是「`lib/` 与 `client.js` 不许 import `tools/`」这条结构约束，属于本来就只能看源码的那一类。
- **既有用例改了三处（契约变化，断言只加不放宽）**：tests/inject.test.mjs 的 C5.5 补一条「首行回落 `INJECT_MAX_ENTRIES`」断言、新增 C5.6（17 → 18 条）；tests/recap-pipeline.test.mjs 新增 5 条 `e｜` 用例（12 → 17 条）；tests/tuning-behaviors.test.mjs 配置行为② 尾补 3 条端到端断言（`injectMaxEntries: 8` → 首行「最多 8 条」且绝不出现「最多 5 条」），文件条数不变。tests/e2e.test.mjs 场景 6 的 `/最多 5 条/` 断言**没有改**——它跑的是默认配置，5 就是真话。
- **变异自证与语法自检**：10 个变异（本文件每条任务至少 1 个）全部验证「改坏生产代码 → 只有对应用例变红 → 改回全绿」，明细见 FIX-REPORT-R37.md 的变异表；`lib` 下 30 个 `.js` + `client.js` + `tools/diagnose.mjs` 逐个 `node --check`，bad = 0。
- **一条重要教训（A3 变异）**：第一版「正文过短」用例用常量自适应构造样本（`'x'.repeat(SKELETON_BODY_CHARS - …)`），把常量改成 120 时用例**自己跟着变形**照样绿 —— 等于没钉住字面值。补写死长度 79 / 80 / 81 三条之后，同一个变异红 2 条。**凡是「阈值类」用例，样本长度必须写死，不许从被钉的常量推。**
- **基线演进**：516 → 546（545 通过 + 1 skip），测试文件数 33 → 34。

| T245 | `REFLECTOR_SYSTEM` 四段式（第 33 轮） | 目标段、只做什么段（条件写「当……时」触发式且要求含用户真会说出口的词）、不做什么段（**含反例**）、怎么写才能被召回段（讲清 BM25 吃哪些词面、不认语义）；输出契约 `candidateLine` 的 JSON 形状一字不变 | I15 | tests/prompts.test.mjs |
| T246 | cooldown 显式配 0 = 不冷却（第 35 轮） | `shouldTriggerAutoRecap` 真模块：`{autoRecapCooldownTurns:0}` + `lastRecapTurn === currentTurn`（差 0 轮）→ `true`；`9 → 10`（差 1 轮，旧实现被挡）→ `true`；字符串 `'0'` 同样算显式 0 → `true` | I9 | tests/trigger.test.mjs |
| T247 | threshold 显式配 0 = 每次都触发（第 35 轮） | `{autoRecapThreshold:0}` + `mutCount:0`（一次工具都没动）→ `true`；字符串 `'0'` 同样 → `true`。旧实现 `Number(x) || 1` 下两条都是 `false` | I9 | 同上 |
| T248 | 缺键才回落（第 35 轮） | 配置里**没有**这两个键（或显式 `undefined`）→ 仍按默认 2 / 1：`mutCount:0` 不触发、`9 → 10` 被挡、`8 → 10` 放行、`mutCount:1` 触发 | I9 | 同上 |
| T249 | null / 空串 / 空白 / 非有限数一律回落（第 35 轮，契约） | `null`、`''`、`'   '`、`'\t'`、`NaN`、`Infinity` 逐个喂进去 → 全部按「没配」回落默认 2 / 1（断言的就是回落后那几条边界行为）。取舍理由：`Number(null)` 与 `Number('')` 都是 0，照收会把「输入框被清空」读成「用户要求最激进配置」；要 0 就显式写 0 | I9 | 同上 |
| T250 | recordTurnEnd + cooldown 0（第 35 轮） | 同一回合号连记两次（`turn 7` 两遍，中间模拟待办被取走）：第二份待办照挂（`trigger:true`、`pending.turn 7`、`prevLastRecapTurn 7`、`pendingSeq 2`）。旧实现 `7-7=0 < 2` 会被挡下 | I9 | 同上 |
| T251 | recordTurnEnd + threshold 0（第 35 轮） | 本回合 `mutCount` 保持 0（一次都没动手）也挂待办：`trigger:true`、`pending.mutCount 0`、`pending.turn 5`、`lastRecapTurn 5`。旧实现 `0 < 1` 直接不触发 | I9 | 同上 |
| T252 | 不满额也配对：只有「真的很像」才动手（第 37 轮） | `runRecapPipeline` 真整链 + 真 `commitOps` + 真 `archive.md`：`maxEntries: 60`（远未满额）、两条正文逐字同的条目 → 仍跑一次轻量合并（`asks.length === 1`、`out.merged === 1`、保留 created 更早那条的 id、`hits` 相加、归档 `reason=merged` + `supersededBy`）。对照组：候选被丢弃使 `adds === 0` → `mergeAsk` **一次都不许调** | I11 | tests/recap-pipeline.test.mjs |
| T253 | 轻量阈值是 0.75 不是满额的 0.5（第 37 轮） | 造一对对称 BM25 正文比率 **0.505** 的中等相似条目：`findMergePairs` 在 `0.5` 下返回该对、在 `0.75` 下返回空；整链跑完它们**仍是两条**、`merged === 0`。把 `MERGE_EAGER_THRESHOLD_RATIO` 改回 `0.5` → **只有这一条**变红 | I11 | tests/recap-pipeline.test.mjs |
| T254 | 注入首行「最多 N 条」说真话（第 37 轮） | `selectInjection(entries, q, { maxEntries: 8 })` → `count === 8` 且首行 `最多 8 条`、不含 `最多 5 条`；`maxEntries: 3` 同验；不传回落 `INJECT_MAX_ENTRIES`；直接调 `renderInjection` 传 12 → `最多 12 条`，传 `0` / `'x'` → 回落默认。端到端：`makeHost({ config: { injectTokenBudget: 4000, injectMaxEntries: 8 } })` 真走 `agent/pre-step` 投递，首行必须是「最多 8 条」 | I12 | tests/inject.test.mjs、tests/tuning-behaviors.test.mjs |
| T255 | 体检脚本真的零写盘（第 37 轮） | 造临时手册 + 归档 + 设置文件，跑完整 `diagnose()` 前后逐文件比对字节与 mtime：**一个字节都不许变**、目录里也不许多出文件（锁文件、tmp 文件都不许留） | — | tests/diagnose.test.mjs |
| T256 | 体检脚本的阈值不是摆设（第 37 轮） | 「正文过短」用**写死长度** 79 / 80 / 81 三条钉住 `< 80` 这个字面阈值（不许从常量推长度）；「僵尸」用 hits=0 / 59 天 / 恰好 60 天 三条钉住 `>= 60`；「近 30 天」用 30 / 31 / 未来日期三条。把 `SKELETON_BODY_CHARS` 改成 120 → 红 2 条 | — | tests/diagnose.test.mjs |

## 新增测试文件清单与逐文件条数（45 个测试文件全量清单；本表记录第 55 轮时的逐文件分布，各行条数为该文件单独跑 `node --test tests/<文件>` 的「# tests」实测值，合计恰好 744）

| 文件 | 条数 | 覆盖点 |
| --- | --- | --- |
| tests/playbook.test.mjs | 81 | 持久化层：解析（文档头/markers/`extraLines` 保真）、序列化往返、增量操作三态（add/update/remove）、ID 高水位（含归档文件取最大）、容量判定、同进程锁与冲突判定、原子写。**第 33 轮**：`metaLine` 只写四字段 created → updated → hits → lastHit、`parseMeta` 静默丢弃旧的 `helpful` / `harmful`、`parseEntryDocument` 不认 `## 归档区`、毫秒戳往返 |
| tests/trigger.test.mjs | 52 | 触发判定纯函数 + 调度状态机（`recordTurnEnd` / `takePendingRecap` / `requeuePendingRecap` / `abandonPendingRecap` / `restorePendingMutCount` / `isBusyError` / `ownsPending` / `adoptOrphanPending` 与三本幂等账本）。**第 33 轮**：`classifyTurnOutcome` / `settleTurnOutcome` / `WEAK_FAILURE_*` / `UNOBSERVED_*` / `openBuckets` / `noteToolResult` / `noteAgentError` 与 C2 三档信号整段删除。**第 35 轮 +6（T246–T251）**：设置页文案承诺的「0」语义（cooldown 0 = 不冷却、threshold 0 = 每次都触发）、「只有缺键 / null / 空串 / 非有限数才回落默认 2 / 1」，以及 `recordTurnEnd` 在两种 0 配置下真挂待办 |
| tests/trajectory.test.mjs | 32 | 轨迹渲染器：渲染顺序与角色前缀、**注入消息整条跳过**（`source.kind==='dsh-ace' && form==='injection'`；去掉 source 后照常渲染、五种只命中一半条件的不误伤）、`maxMessages` 尾部截断、`maxChars` 首尾保留、tool 结果按 id 绑定工具名、退化分支省略数、整条 summary ≤ `maxChars`、畸形输入不抛错；另有源码级断言：零 import、`runRecap` 确实喂轨迹且轨迹为空不调 LLM |
| tests/archive.test.mjs | 40 | **第 33 轮重写 + 第 34 轮补盲区**：淘汰判据层（`compareForEviction` 三级顺序 = `hits` 升序 → `created` 更早先走 → `idNumber` 数字升序，**守护①**在此；`planEvictions` 产出 `{id, reason:'evicted', date}`）、满额淘汰落盘（f：hits 最少的搬进 `archive.md`、活跃区腾位、新条目正常落盘；`commitCapacity` 的 0 候选腾位路径）、**手册永不出现 `## 归档区`**（g）、`applyArchiveMoves` 只搬不删、`resolveSupersedes`、候选判定里只剩两条正文判据（`shrinksTooMuch` / `bodyLength`）、`decideCandidates` 三分支、归档文件与手册同构且写入不留残渣、并发下淘汰钩子与冲突同批。**第 34 轮新增 7 条（全是行为面，不是源码正则）**：h1/h2「归档不可写（`archive.md` 造成目录 → `EISDIR`）→ 抛错 + 手册字节完全未变 + 归档没有新条目 + 被淘汰条目不蒸发」（`commitOps` / `commitCapacity` 两条路径各一条）；h3「锁内先归档、后手册」的顺序钉子（手册故意不写高水位标记行，归档不可写时高水位必须仍是 0，两行对调就会先写成 4）；h4「归档里的更大编号必须进高水位」（新格式 `### [ace-778]` + 旧格式 `### ace-500` + 正文里出现的 `ace-999` 不算）；h5「满额淘汰 + 同批新增，新编号不得复用刚被淘汰的号」；i1/i2「淘汰计划抛错 / 返回不可用值 → 内置确定性兜底，候选照常落盘、被淘汰条目进归档 reason=evicted、日志含兜底提示」。**另**：C4.3 那条自称「界面展示仍取前 10 位」却自己 `slice(0,10)` 的假断言改写成真断言（毫秒戳本体匹配 `STAMP_RE`、`dayOf` 只到日、跨日 23:30 与次日 00:05 的 `dayOf` 不相等），并注明「界面只到日的真守护在 client 渲染侧」。**删掉的**：三判据 `archiveReasonFor`（low-score / decayed / stale）、`scanArchives`、`pendingIdSet` 及全部边界用例 |
| tests/inject.test.mjs | 24 | `estimateTokens` 按字符类别加权（非 ASCII 1.0 / ASCII 0.4）、**排序键就是纯 BM25 相关度**（k：分高的排前面、行里不再有净分项）、**`hits` 高低不影响排序**（k2：`hits=999` 也压不过相关度，正文逐字相同的三条按 `idNumber` 排）、0 分条目不进候选、条数上限 5、默认 token 预算 500 的截断（C5.4；900 / 600 仅作显式 `tokenBudget` 覆盖用例的参数，验预算可覆盖）、`renderInjection` 首末行文本（已改成「按检索相关度排序」）、`userTextOf` / `messageKeyOf` / `createInjectionCache`。**删掉的**：`INJECT_NET_FLOOR` 出局线、`WEIGHT_RELEVANCE` / `WEIGHT_NET` / `NET_SAT_DIVISOR` 加权键、`probation` 考察位 |
| tests/injection-flow.test.mjs | 8 | 命中账本接缝：`publish → take（认领）→ note（真追加进历史后才记账）→ 回合边界 take 走 → flushHits 一次原子写盘`；**a** 注入投递后这 2 条 `hits` 各 +1、`lastHit` 刷新；同一批只投递一次（连续 `take` 只有第一次拿到 id）、不同 agent 分账、无命中不记账、`peek` 只读、**子代理绝不进命中账本**。**删掉的**：成功回合 `helpful +1` / 失败回合 `harmful +1` 的分档计分 |
| tests/inject-delivery.test.mjs | 15 | 注入投递：真 import `inject-delivery.js` + `injection-flow.js` + `inject.js`，唯一假件是宿主的 `createUserMessage`（返回深冻结对象）。**a** 同一批连续 5 次 pre-step 只有第 1 次追加（`injectedAppended` 只 +1）；**a2** 换新消息 key 后照常交付；异常只 warn + `injectedFailed` +1 + 原样返回 decision；`startsRequestSeries` 等字段被 spread 保留 |
| tests/ledger.test.mjs | 5 | 命中账本 `note` / `peek` / `take` 语义、同 id 去重、按 agent 分账、只收非空字符串、`take` 返回副本 |
| tests/prompt-section.test.mjs | 12 | 【ACE 操作手册】提示逐字保留（autoRecap / autoReflect 两分支）、两个开关都关返回空串、**section 文本在「有注入 / 无注入」「inboxCount 0/1/3/20/999」五态逐字相同**、`{{…}}` 被 `defuseTemplateSyntax` 安全化、描述符 `name` / `order` / `interpolate:false`、回调绝不抛错 |
| tests/recap-pipeline.test.mjs | 30 | `runRecapPipeline` 真跑（真写临时手册）：**流水线不碰命中账本**（取走与落盘都归回合边界）、Reflector 抛错时账本完好、0 候选 + 超容量 → 按最少使用淘汰并落盘、**c 满额先合并**（保留 `created` 更早那条的 id、另一条 `reason=merged`）、**d 守护② 合并失败绝不许阻塞落盘**、满额不再整批拒绝、**j 候选过滤只剩「标题非空」**、merge-inbox 只读报告、检索命中不进账本。**删掉的**：`scoreUsedIds`、整条 `pendingIds` 排除链、`applyGate` 分支与 `gateRejected`。**第 48 轮 26 → 29（+3）**：R48-Gap4 合并失败现场在整链 `return` 时就已落盘且带 provider/model（不靠额外 flush，`finally` 的 `await flushRawLog()` 守着）、没有 `deps.mergeRoute()` 时判定与旧版完全一致（路由只影响现场）、R48-Gap3 本文件的现场只落临时 `DSH_HOME` |
| tests/recap-usage.test.mjs | 14 | 第 33 轮整份重写（原 25 条绑计分/结算/pendingIds，全删）：① 回合边界 `takeHitIds` + `flushHits` 一次原子写盘（hits +1、lastHit 毫秒戳、账本取空）；② 同一批只落一次盘；③ 冷却回合不挂待办但命中照写；④ 无命中不写盘（mtime 不变）；⑤ 写盘失败只 warn，下一批仍能落；⑥ 取账本抛错只 warn；⑦ 空闲边沿先等落盘再复盘（steps `['flush:start','flush:done','recap']`）；⑧ 两个空闲边沿重叠不抢同一份待办；⑨ 不传 `takeHitIds` / `flushHits` 什么都不做也不抛；**⑩ i 毫秒戳写入→读回→排序**；**⑪ 守护③ 毫秒戳跨进程排序**（两个独立子进程各算一遍）；⑫ 元数据行无 `helpful` / `harmful`。**第 34 轮改写 + 新增（12 → 14）**：⑤ 改写为「写盘失败只 warn 不抛，但**退回账本**，下个回合边界**真重试落盘**」——第一次 `flushHits` 抛错后账本里仍是 `['ace-001']`、warn 文案含「已退回账本」与「下个回合边界重试」（旧文案「下个回合边界再记」是没实现的承诺，不许再出现）；第二次回合**故意不 note 新命中**，落盘成功只能来自退回的那批（`hits` 变 1、账本变空、`flush` 被调 2 次）；+2「退回账本的命中与下一批新命中合并成一次写盘（不拆成两笔）」、「没有 `noteHitIds` 可退时 warn 明说已丢失」 |
| tests/recap.test.mjs | 21 | `createRecapController` 状态机真对象直测：回合边界记账与挂待办、空闲边沿复盘、`skipped` 时把冷却与计数还回去、撞忙放回重试（上限 3 次）、真实失败只还 mutating 计数、日志文案与 warn 兜底。**第 33 轮**：`noteTool` / `noteError` / `settlePendingUsage` / `hasPendingUsage` / `pendingUsageIds` 相关用例全部删除 |
| tests/reflect.test.mjs | 16 | `reflectRounds` 轮次编排：默认上限 2 轮（REFLECT_MAX_ROUNDS=2，第 54 轮由 3 降为 2）、第 1 轮空数组立刻收敛、第 2 轮空数组收敛且保留第 1 轮候选、每轮都有新候选则跑满 2 轮硬停；`maxRounds` 可显式调大（测试里用 3 轮验「每轮都拿到此前累积候选」的语义）、prior 是副本、第 1 轮抛错上抛 / 后续轮抛错按已提炼落盘、每轮一行日志、logger 畸形不炸 |
| tests/merge.test.mjs | 27 | 第 33 轮 10 → 17：`MERGE_SYSTEM` 四段式（含反例与输出契约）、`mergePairInput`、`parseMergeResult` 七种输入（合法四字段 / 缺字段 / 空串 / 非 JSON / 数组 / 嵌套错位 / 代码围栏包裹）、`survivingEntry`（保留 `created` 更早那条的 id）、`planMerges`（最多 5 轮、每轮一对、某对失败摘掉换下一对、**永不抛错**）、`findMergePairs`（BM25 对称比率 ≥ `MERGE_THRESHOLD_RATIO = 0.5`、互不重叠）、`computeMergeSuggestions` 阈值与排序。**第 48 轮 22 → 26（+4）**：顶层数组被 `extractJsonObject` 包成 `{candidates}` 后 `parseMergeResult` 仍是 null、绝不抛错；R48-Gap3 失败现场只落临时 `DSH_HOME`（真实 `~/.dsh` 的 raw.jsonl 一行都不许多）；R48-Gap4 `planMerges` 透传的 provider/model 真进了 merge 现场；R48-F2 回归——配平但非法 JSON 的回收数组送进来仍是 null |
| tests/prompts.test.mjs | 27 | **第 33 轮整份新增**：`REFLECTOR_SYSTEM` 四段式——目标段（从本回合轨迹提炼可复用经验）、只做什么段（标题 = 做什么 + 什么场景；条件写「当……时」触发式且要求含用户真会说出口的词；做法动词开头可照做）、不做什么段（**含反例**）、怎么写才能被召回段（讲清 BM25 吃哪些词面、不认语义）；四条断言各钉一段，另有一条钉输出契约 `candidateLine` 的 JSON 形状一字不变。**第 48 轮 5 → 26（+21，删 0）**：`extractJsonObject` 的容错与现场——顶层数组包成 `{candidates:[…]}`、未闭合报 1-based 位置、空串/纯散文报错带「收到 N 字符 + 开头 60 字」、散文方括号与全标量数组回落对象路径（Gap1 / Gap2 / S1 / S2 / S3 / T1 与 T1 回归守护）、非法 JSON 的数组按顶层对象回收（F2）、空壳对象与空 `candidates` 壳让位给真数组（F5 / G1a / G1b）、对象路径遇中文逗号·单引号·尾逗号一律 `ace:` 前缀 + 现场 + 原始 message（G2a / G2b / G2c） |
| tests/e2e.test.mjs | 8 | **端到端演练**：假 agent + 假 session + 假事件流驱动插件**真实的**事件处理器，只 mock LLM 调用与宿主事件，**不 mock** archive / inject / playbook / commit / evict / archive-file，断言全部读**真实写出来的临时手册与归档文件**。八个场景见下节 |
| tests/concurrency.test.mjs | 6 | 真实子进程并发：两个 node 子进程同时操作同一本手册（生产同款 `commitOps` 路径，脚本写在系统临时目录、用完即删）；**第 33 轮**：两个进程各带淘汰钩子同时写 → 被淘汰的搬进 `archive.md` 一条不丢也不重复、淘汰钩子 + 并发冲突同批一起走 |
| tests/wiring.test.mjs | 20 | 真 import `lib/index.js` 后真调 `apply(ctx, config)`：事件表（**`agent/error` 已随回合判定层删除**）、**b** `ace_playbook` 命中计数（只有带 `query` / `id` 的定向查找 +1、整本读取一次都不计）、**h** 整本读取不含归档条目、`runtimeSnapshot` 七键、`apply()` 真跑一次不抛、三个工具注册进 `ctx.tools`。**第 46 轮（12 → 16）**：4 条手动归档写路由用例——真发 `POST /api/dsh-ace/entries/archive` 并真落盘（活跃区少一条、`archive.md` 多一条且 `archive.reason === 'removed-by-request'`、正文逐字不丢、`/stats` 的 `runtime.archivedByReason['removed-by-request']` 变 1）、归档后 ID 高水位仍算上归档侧（新条目拿 `ace-003` 而不是复用 `ace-002`）、记账与 `dsh-ace: 手动归档 1 条` 日志和 `/stats` 对得上、失败路径一律结构化非 2xx（404 / 400 / GET 405 / 围栏 403 · 且一条都不许动盘）。`callRoute` 因此加了可选第四参 `{ body, headers }`（发 `data` 事件喂 JSON，并按需覆盖请求头）。**第 48 轮 18 → 20（+2）**：R48-F4 自动复盘 `reflectRound` 失败时真写一条 `stage:'reflect'` 现场（带 round/provider/model）、R48-F3 手动 `ace_reflect` 解析失败也留现场（与自动复盘对齐、错误语义不变）——两条都用「删掉那行 `dumpRaw` 就转红」各自自证过 |
| tests/client-stats.test.mjs | 21 | **第 33 轮**：运行统计**六格**（注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数）+ 归档按**四原因**分列（`superseded` / `removed-by-request` / `evicted` / `merged`）+ 注入明细行（批次/追加）+ 两行 note；旧的九格、`scored`、未观测、闸门拦下全部删除；`runtime` 缺失时只留灰字。**第 34 轮（20 → 21）**：注入明细行改成只给**两个数**（跳过/失败两格删掉——它们读的 `runtime.injectedSkipped` / `injectedFailed` 从来不在七键协议里，`num(undefined)` 兜成假 0），夹具里**故意塞进** `injectedSkipped: 999` / `injectedFailed: 888` 两个陷阱字段（加回去就会渲染出 999/888 而不是假 0）；统计块「最近更新」的日期格改成 29 字符毫秒戳夹具 + 经 client 渲染断言恰好 10 字符、不含时区偏移/时分秒；+1 条「日期格对空值/垃圾值给「—」，旧格式照常 10 字符」；原 :713 那条只用源码正则断言「client.js 里出现 injectedSkipped/injectedFailed 两个字段名」的假断言删掉换成行为面断言 |
| tests/client-entries.test.mjs | 42 | **第 33 轮**：记录页归档分区的四原因中文短语（被取代 / 显式移除 / 最少使用淘汰 / 合并进另一条）、归档条目只读且无删除入口、`toEntry` 十字段（含 `hits` / `lastHit`）、字典键 zh/en 两侧齐全（旧的 `entriesArchiveReasonLowScore` / `Stale` / `runtimeScored` 已删）。**第 34 轮（24 → 26）**：主行夹具的 `updated` 改成 29 字符毫秒戳（原来全是 `2026-09-xx`，永远测不出界面没截断）；+2「毫秒时间戳经 client 真实渲染成 10 字符日期（截断在 client 侧，测试不代劳）」「日期格兼容旧格式（只到日）、空值/垃圾值一律给「—」，绝不渲染 undefined」。**第 46 轮（26 → 34）**：8 条手动归档按钮用例——详情区才有按钮且收起时不渲染、首点变红「确认」**且零写请求 + 零刷新**、二点才发一次 `POST`（请求体 `{ id }`）成功后 `reload()` 并清空 pending、服务端 404 与网络异常两种失败都渲染出可见的 `.ace-entries-note` 并退回初始态、点另一条 / 切分区 / 点页内别处 / 刷新都复位悬空确认态、样式表里 `.ace-entries-archive-btn.is-confirm{...}` 是单独一条规则（深红底 `#3b1418` + 亮红字 `#ff8b8b` + 红边 `#7f1d1d`，WCAG 对比度实算 ≥ 4.5:1）、归档分区仍只读（不渲染归档按钮、按钮文案里也不出现「归档 / 确认」）。**第 53 轮（36 → 42）**：+6 条归档分区分页用例——45 条分 3 页（首页禁上页、末页禁下页、点页码回第 1 页）、归档页码与活跃页码互相独立且切分区复位、≤20 条时「第 1 / 1 页」且上下页都禁用、归档为空不渲染分页条、刷新后列表变短时页码被钳位、翻页仍是只读（无输入控件/无删除还原按钮/零写请求） |
| tests/client-picker.test.mjs | 14 | 设置页两个模型下拉：用文件自带的迷你 React（`createElement` / `useState` / `useRef` / `useEffect` + 假 `document` / `fetch`）加载 `client.js` 做逻辑级验证——展开/搜索/键盘上下 + Enter/Esc/点外部关闭/清空回「跟随会话模型」 |
| tests/entries.test.mjs | 18 | `collectEntries` 的活跃 / 归档两段：字段顺序固定为 `id,title,condition,action,rationale,auto,created,updated,hits,lastHit`、`toEntry({})` 稳定、旧手册缺字段回落、归档段读的是独立 `archive.md`、降级体与成功体同形，外加 `GET /api/dsh-ace/entries` 的 HTTP 面契约（围栏/405/Content-Type/降级） |
| tests/stats.test.mjs | 13 | `summarizePlaybook` / `collectPlaybookStats`：手册规模与来源、14 天分布、四种降级（needs-session / missing / no-entries / unreadable）、**`runtime` 恒七键且缺字段补 0**、`archivedByReason` 恒四原因、空态 |
| tests/catalog.test.mjs | 8 | `buildCatalog`：逐个 provider 各自 try/catch + `withTimeout` 15 s、坏掉的 provider 只让自己 `models: []` 并附 `error`、超时只放弃等待不 abort 上游、`payload.bounds.defaults`（`maxEntries` 默认值）读取 |
| tests/inbox.test.mjs | 10 | merge-inbox：`readInbox` / `writeInboxAtomic` / `addToInbox` / `inboxFull` 的容量上限 `INBOX_CAP`、原子写、坏文件降级空清单、只读报告不写手册 |
| tests/notice.test.mjs | 9 | `textBlocks` / `noticeMessage` 把文案包成宿主契约要求的 `ContentBlock[]`；裸字符串会让宿主 `.content.some` 抛 `TypeError` 整个会话永久坏死（T226–T228） |
| tests/playbook-path.test.mjs | 10 | 手册与归档文件位置解析链：绝对路径 / `~` 展开 / 相对工作目录 / 空串 = 本机共享层 `<DSH home>/ace/playbook.md`；**第 33 轮新增** `resolveSharedArchiveFile`（`<DSH home>/ace/archive.md`）与 `resolveArchiveFile`（与手册同目录） |
| tests/raw-log.test.mjs | 6 | **第 48 轮新增**：失败现场调试日志（`lib/raw-log.js`）。落点解析 `<DSH_HOME>/ace/debug/raw.jsonl`（`DSH_HOME` 缺失时回落 `~/.dsh`）；`raw` 正文只留前 4000 字、`rawLength` 仍记全长；保留最近 20 条（写 21 次后丢的是最旧那条）；`ACE_RAW_LOG=0` / `off` 完全不写、连目录都不建；`dumpRaw` 全吞不抛（目录建不出来、畸形入参都不炸复盘）；并发 10 次写串行化、不互相覆盖 |
| tests/llm-budget.test.mjs | 12 | `oneShot` 的单次预算与空正文（**第 45 轮 3 条 + 第 48 轮 3 条**）：`maxMs` 生效且报错文案用实际 cap「单次上限 80ms」、`maxMs=0` 当没传 + 外层 signal 先断原样 rethrow、预算之内正常流照常返回；**第 48 轮**：只有 reasoning-delta 时抛「正文为空」——正文为空但带 reasoning 字符数、耗时与 provider/model，该错不被 `isTimeoutError` 认成超时，正常流里 reasoning 不混进返回值 |
| tests/settings-path.test.mjs | 11 | 设置文件位置解析（profileContext → `DSH_PROFILE_DIR` → `DSH_HOME` → `~/.dsh`）与旧文件一次性迁移 `migrateSettingsFile`；其中 T47 的 `mode 0o600` 权限位断言在 Windows 上**条件跳过**（NTFS 不体现 POSIX 权限位，见未验证清单 7）——全量里唯一的 1 skip |
| tests/heat.test.mjs | 15 | 第 36 轮新增：话题热度的纯逻辑。窗口上限 30（第 31 条进来第 1 条被挤出）、按 agent 隔离、只收有正文的用户消息、`messagesOf` 返回副本；`computeHeat` 每条消息给前 `topPerMessage` 条各 +1、同一话题出现两次记 2 点；**把注入出去的条目 / 伪造的热度图喂回去，计数与顺序一字不变（反自增强）**；热度能改排序，但**0 相关度条目热度再高也不进候选**；候选最大热度为 0（空 Map / 空对象 / 陌生 id / null）时一律按 0 算、不出 NaN；`selectInjection` 透传 heat 且重复调用结果逐字相同 |
| tests/heat-wiring.test.mjs | 2 | 第 36 轮新增：真宿主桩（`plugin.apply` + 真 `agent/inbox/inserted` + 真 `agent/pre-step`）。agent A 先聊三轮回滚再注入种子 → 注入头一条是带「回滚」的 ace-002；agent B 窗口为空 → 按相关度给出 ace-001；B 自己聊三轮回滚后顺序同样翻转（窗口不跨 agent 串味）；另有一条钉「重启即清空」 |
| tests/evict-protect.test.mjs | 10 | 第 36 轮新增：`planEvictions` 的保护期。不受保护的够 `need` 时只取它们；不够时用受保护按「hits → created → id」全序补齐；**全在保护期也必须凑够**（不许死锁）；`need` 超过总数返回全部且无重复；`protectDays` 为 `0 / -1 / -365 / NaN / Infinity / undefined / null / ''` 时与旧版逐条等价；边界「恰好 N 天前不算受保护」；`created` 解析不出的一律算不受保护；字符串 `'14'` 等价 14、`3.9` → 3；输入数组不被就地排序、两次调用结果逐字相同 |
| tests/tuning-behaviors.test.mjs | 4 | 第 36 轮新增：**三个配置项的行为面**（验收 2f：改配置真的改变行为，不是只看值存不存在）。`injectTokenBudget` 4000 → 150 时真发 `agent/inbox/inserted` + 真跑 `agent/pre-step` 投递，注入条数从 5 条降到更少且只砍尾部；`injectMaxEntries` 5 → 2 时预算再宽也只注入 2 条（且与纯函数口径 `selectInjection` 一致）；`evictProtectDays` 0 → 14 时真调 `/ace` 命令走 recap-pipeline → commitOps：0 时淘汰 hits 最少的**新**条目，14 时改淘汰**老**条目、新条目一条不动且活跃条目数仍 ≤ `maxEntries`；`maxEntries` 100 → 3 时前者四条全留、后者恰好腾出 1 位并把 `reason=evicted` 写进 archive.md。**第 37 轮**：配置行为② 尾补一条端到端断言——`injectMaxEntries: 8` 时注入块首行必须写「最多 8 条」且绝不出现「最多 5 条」 |
| tests/config.test.mjs | 9 | 第 36 轮新增：三个配置项的端到端契约。Config 17 个字段（第 55 轮加 injectRationale 后由 16 变 17）与三个默认值；GET `/api/dsh-ace/settings` 的 `value` / `bounds` / `bounds.defaults`；POST 三个键各写一次 → `value` / `stored` / 落盘 JSON 都变；**`evictProtectDays: 0`（数字与字符串 `'0'`）原样保存、不被 `|| 14` 吞掉**；越界值 400 且文案带范围；边界值 min/max 放行；空 body → 400 `no settings provided`；非法值整批原子（合法键也不落盘）；手写设置文件里的 `null` / 空白串回落默认 14 / 500、越界值被丢弃并 warn |
| tests/diagnose.test.mjs | 24 | 第 37 轮新增：`tools/diagnose.mjs`（**只给调度者诊断用的只读脚本，不进插件运行时、不进设置页**）。全部真跑生产函数：判据常量与日期工具、`bodyChars`；近重复配对（**0.5~0.75 之间的那对也算——钉住阈值是 0.5 不是 0.75**）、对称性、与 `computeMergeSuggestions` 的交叉校验、空手册/只有一条；僵尸条目（`hits=0` 与 `>=60 天` 都抓、59 天放过、边界 60 天算、坏 `lastHit` 只按 `hits` 判）；正文过短（`<80` 才算，**恰好 80 放过**，并写死长度 79/80/81 三条钉住字面阈值）；近 30 天新增与归档（30 天算、31 天与未来不算、四原因分列）；容量读得到与三种读不到降级；**整链诊断跑完前后逐文件字节比对，证明确实零写盘**；渲染 top5 + 「另有 N 条」；手册不存在 / 空文件 / 路径是目录（EISDIR）/ `renderReport` 防御分支 / 归档读不到都不许崩栈；命令行解析（`--key=value` 与 `--key value` 两种写法、未知参数）与**子进程真跑一次**；`A10` 反向接线检查（`lib/` 与 `client.js` 一处都不 import 它）；`localDayString` |
| tests/inject-observability.test.mjs | 22 | 第 40 轮 R1（含第 41–43 轮补）：注入链路可观测性计数 `injectionStats` —— 预检索 handler 每道早退门各自进桶（noAgent / notUser / noQuery / cacheHit / flagsOff / noAgentPicked）、IIFE 抛错进 failures.preRecall 仍算 handled、投递接缝真追加进历史才记 deliveries、连续 N 次无产出 / 发布未投递各发一次性 notice、连续计数按稳定 id 分表并确定性丢零值账 |
| tests/prompts-salvage.test.mjs | 5 | 第 49 轮：未闭合输出的降级回收 `recoverCandidatesFromUnclosed` —— 已有完整候选就回收、一条完整候选都没有返回空数组由调用方保持原抛错、完整输出行为不变、字符串内花括号不参与配平、自动复盘与手动复盘两条路径都已接线「先回收再决定抛不抛」 |
| tests/r50-reasoning.test.mjs | 11 | 第 50 轮 R50-0…R50-10：思考档位判定顺序（手动值优先 / 自动降该模型最低档 / 四种不干预情形）、判定结果真进 `GenerateOptions.reasoningEffort`、某轮超时降一档只重试一次且重试仍失败不假成功、`GET /api/dsh-ace/efforts` 报文形状与配置面（默认 / bounds / POST 落盘读回 / 非法档位 400 / 白名单 17 键） |
| tests/r51-manual-reflect.test.mjs | 4 | 第 51 轮 R51-D1a/D1b/D2/D3：手动 `ace_reflect` 本层单次上限到点须报「ace: LLM 调用超时」且 `isTimeoutError` 为 true、调用方自己取消报「被取消」且不算超时、非法手动档位名落一条带原值的中文 warn、AGENTS.md 代码地图给 lib/inbox.js / lib/heat.js / lib/injection-flow.js 各留一行 |
| tests/r55-inject-rationale.test.mjs | 6 | 第 55 轮 R55-1…R55-6：`injectRationale` 默认关时注入块「依据」出现 0 次且条目照常注入、打开后同一条目恰多一行且依据原文一字不截、配置层 true/false 落盘读回一致、非法值（yes / 1 / null）400 且不动当前值、热更新保存即生效 |
| tests/recap-hang.test.mjs | 3 | 第 39 轮：自动复盘卡住时自我放弃（子进程压 `RECAP_TOTAL_DEADLINE_MS` / `ONESHOT_TIMEOUT_MS`）—— provider 静默时总时限内放弃并通知、单次调用超时只让那一轮收尾、复盘排队期间回合边界同步返回不阻塞用户消息 |
| tests/recap-manual.test.mjs | 4 | 第 40 轮缺陷 5/6：手动 `/ace` 改走插件自有队列后整段不占宿主维护相位、宿主真忙时如实回「正在忙」、队列已有待跑项时新回合合并进去、队列真满额时丢最旧一份并发 notice 告知经验丢失可下回合重试 |
| tests/recap-mutroll.test.mjs | 2 | 第 39 轮缺陷 2：队列内真失败回滚 mutating 计数（端到端真跑 `lib/index.js`）—— threshold=1 与 threshold=3 两种阈值下失败吞掉的计数都还回，故要重新攒满才再触发 |
| tests/recap-queue.test.mjs | 11 | 第 39 轮（含第 45 轮补 R45 一项）：复盘串行队列 `lib/recap-queue.js` —— 全局最大并发恒为 1、新回合并入已在排队的一份、超上限丢最旧、总时限到点 abort 上游并等它 settle 才放行、失败/放弃都通知调用方且不抛、`run` 第二参 `{deadlineAt}`、logger 畸形或缺失都不炸 |

### tests/e2e.test.mjs 的八个场景

| 场景 | 用例名 | 断言要点 |
| --- | --- | --- |
| 1 | `E2E 场景1｜mutating 工具结果 → turn-stopping → status idle 真的触发自动复盘并落盘` | 发真实事件序列后 LLM 真被调用、日志含「已挂自动复盘待办」、手册里真的多出落盘条目 |
| 2 | `E2E 场景2｜多轮复盘在第 2 轮空数组处收敛，候选总数 3 条` | 默认上限 2 轮；假 LLM 第 1 轮 3 条、第 2 轮回空数组，断言 `llmCalls.length === 2`、候选总数 3、日志含『第 2 轮无新增候选，判定收敛（已提炼 3 条）』 |
| 3 | `E2E 场景3｜候选落盘：新增 / 同标题原地更新 / 完全重复丢弃` | 一条全新 add、一条覆盖同标题旧条目（候选正文比旧条目短 → 走「原地更新」，id 不变）、一条 `normKey` 完全相同被丢弃；活跃条目数与 id 逐个核对 |
| 4 | `E2E 场景4｜注入 2 条 → 回合边界 hits +1、lastHit 毫秒戳、元数据无 helpful/harmful` | 走 `agent/inbox/inserted` 预检索 → **真调 `agent/pre-step` 处理器**把注入追加成一条 user 消息（断言 `role==='user'`、`source.kind==='dsh-ace'`、`source.form==='injection'`），回合边界 `takeHitIds` + `flushHits` 落盘后这 2 条 `hits` 各 +1、`lastHit` 匹配毫秒戳正则、盘上元数据行里**没有** `helpful` / `harmful` |
| 5 | `E2E 场景5｜满额淘汰：hits 最少的搬进 archive.md、活跃区腾位、手册无归档区章节` | `maxEntries=3`、三条条目 `hits` 分别 3/1/0 → 新候选落盘时淘汰 `hits` 最少的那条：它进 `archive.md` 且带 `- 归档：reason=evicted date=…`、活跃区不再有它、**手册文件里没有 `## 归档区`**、条目总数一条不少（永不物理删除） |
| 5b | `E2E 场景5b｜满额先合并：LLM 合成一条、保留 created 更早那条的 id、另一条 reason=merged` | `maxEntries=1` 且已有两条相近条目；第一次 LLM 返回 `[]` 逼出 0 候选分支、第二次返回四字段 JSON 作为合并结果 → 活跃区只剩 1 条且 id 是 `created` **更早**那条的、另一条进 `archive.md` 且 `reason=merged`、落盘照常成功 |
| 6 | `E2E 场景6｜注入块追加进历史、条数与 token 预算符合契约、纯 BM25 排序` | 注入正文以「【ACE 自动注入】」开头、条数 ≤ 5、tokens ≤ 500（INJECT_TOKEN_BUDGET）；正文逐字相同的三条按 `idNumber` 升序排、`hits=999` 但零字面交集的条目**不进**注入（`hits` 不影响排序）；**红线断言：`sectionText` 不含「【ACE 自动注入】」且仍以「【ACE 操作手册】」开头，`decision.kind==='enter'`、`decision.startsRequestSeries===true` 被保留**；日志含「注入批次已发布」与「注入已追加进历史」 |
| 7 | `E2E 场景7｜整条链路落盘 + 设置页统计 runtime 七键，整本读取不含归档条目` | 跑完整条链路后 `GET /api/dsh-ace/stats` 的 `runtime` **七键**（`injectedBatches` / `injectedAppended` / `retrievalHits` / `evicted` / `merged` / `archived` / `archivedByReason` 四原因，断言是键集合 deepEqual 全等）与真实日志数字一一对上；`ace_playbook` 整本读取的正文里**不含**归档条目、也不含 `## 归档区`，且这次读取不计命中；带 `query` 的定向检索才让 `retrievalHits` 增加；临时手册与归档文件内容可读回、测试结束清理临时目录 |

跑 e2e 的前提：桩掉 3 个宿主包（schemastery / dsh-tools / dsh-llm）后**真 import** lib/index.js 并真调 `apply()`；`DSH_HOME` / `DSH_PROFILE_DIR` 在 import 之前指向临时目录；手册路径是临时目录里的绝对路径，**绝不碰用户的真实手册**。见上节「桩宿主包真 import lib/index.js」。

**等待判据只等盘上状态，不等日志（曾 flaky，已修）**：e2e 里每一步都用 `diskHas(file, check)` 轮询**真实手册文件的内容**，不用 `logHas` 当 until 判据。理由是日志顺序会随实现变：第五轮把命中记账挪到回合边界之后，那条日志就跑到了候选落盘之前，场景 4 原先拿它当 until 判据 → 判据一满足就读盘、而写盘还没发生 → 间歇性失败，根因是**测试的等待判据**而不是生产缺陷。手册写入走 `writeFileAtomic`（临时文件 + rename），任何时候读盘都读到完整文件，所以「目标状态已在盘上」就等价于「前面几次写都已落盘」。修好之后连跑 `node --test` 二十次全绿。

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
- [ ] 设置页 → 「ACE 手册」→ 统计页里，「手册统计」块下方出现「ACE 运行统计」**六格**（注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数）与 **四行明细**（归档原因四值 · 注入批次/追加/跳过/失败 · 两个注入口径的差别 · 淘汰与合并的口径）；跑过一轮复盘后数字应随之变大，且与 `ctx.logger` 里的 `dsh-ace: 注入批次已发布…`、`dsh-ace: 注入已追加进历史…`、`dsh-ace: 命中落盘…`、`dsh-ace: 满额先合并…`、`dsh-ace: 满额淘汰…` 几行日志对得上（见未验证清单 13）；
- [ ] 记录页切到「已归档」能列出归档条目（编号 / 标题 / 归档日期 / 归档原因），展开能看到原因、日期、被哪条取代与正文，且**没有任何删除或还原按钮**；归档数据来自独立文件 `archive.md`，归档原因只有四种中文短语：被取代 / 显式移除 / 最少使用淘汰 / 合并进另一条（见未验证清单 14、16）；
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
12. **条目编号在「人同时删最高编号条目 + 删高水位标记」时会复用一次**（已知限制，不修）：历史最大值只存在于手册文档头的那行 `<!-- ace:id-highwater: N -->` 标记里，条目被删掉之后无法从文件本身恢复，因此这两种删除同时发生时该编号可能被复用一次（随后标记被重写成当前最大编号，也就是刚被复用的那个号，因此只会复用这一次）。T114 把这一当前行为钉住；README「已知限制」与 DESIGN.md 的 I2 都已按此措辞写明。**没有**实现「从别处猜回历史最大值」的机制——那需要额外持久化历史，会超出增量演化的边界。**第 33 轮把归档搬进独立文件之后，这条高水位的计算面变宽了**：`lib/commit.js` 的两条提交路径（`commitOps` / `commitCapacity`）现在取 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveEntries), maxEntryIdNumber(baseEntries))`——活跃区与归档文件两边的最大编号都算进去，且**必须在「满额淘汰」之后才算**（淘汰会把活跃条目搬进归档；先算的话，手写手册下新条目会复用刚被搬走的编号）。由 tests/archive.test.mjs 的「f｜满额淘汰：hits 最少的两条进 archive.md」与「f｜commitCapacity」两条用例守着。上面那条「人同时删条目与标记」的已知限制**仍然存在**，与本条无关。

13. **只读统计端点 `GET /api/dsh-ace/stats` 的真实宿主返回未做 HTTP 验证——尤其「打开设置页就能看到 ACE 运行统计」这条**：改动落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效（当前 GUI 就跑在这个进程上，本任务不允许重启宿主）。已做的替代验证分三层：①纯函数单测（tests/stats.test.mjs，13 条）：返回值形状、四种降级（needs-session / missing / no-entries / 坏 JSON）、`normalizeRuntime` 恒返回七键（`archivedByReason` 四键）；②`lib/index.js` 的接线用 `tests/wiring.test.mjs` 真跑 `runtimeSnapshot()` 之后逐键比对；③源码级断言钉住围栏顺序与 405。**仍未验证的是「用户在自己的宿主里打开设置页、看到的那一排数字」**：端点本体的真实响应体、以及两个统计块在真实浏览器里的观感（CSS 布局、14 天条形的宽度与对齐、运行统计块与手册统计块的相对位置）均未目视。等宿主重启后人工确认：打开设置页 → 「ACE 手册」，应看到条目数 `N / 100`、本机共享手册绝对路径、14 天条形图有非零行、**下方「ACE 运行统计」六格：注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数**，以及四行明细（归档原因四值 `superseded` / `removed` / `evicted` / `merged`、注入批次/追加/跳过/失败、两个注入口径的差别、「淘汰与合并的口径」）。注意运行统计是**进程内存态**：重启宿主后它会从 0 重新开始，那是预期行为，不是丢数据。
14. **只读条目端点 `GET /api/dsh-ace/entries` 的真实宿主返回未做 HTTP 验证，含归档分区**：改动同样落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效。已做的替代验证是 tests/entries.test.mjs 的 18 条 + tests/client-entries.test.mjs 的 42 条：纯函数与只读 IO 直接跑（分支本体只做「调它 + send」），分支的围栏顺序、405、错误体与 Content-Type 用源码级断言钉住；`collectEntries` 的 `archived` 一段现在读的是**独立归档文件 `archive.md`**（`lib/archive-file.js` 的 `readArchiveSnapshot`，ENOENT 时返回空归档、不造文件）。等宿主重启后人工确认：`/entries` 在手册文件缺失/损坏时返回 `{ entries: [], total:0, archivedTotal:0, maxEntries:100 }` 而不是 500；页面上切到「已归档」应看到原因（**被取代 / 显式移除 / 最少使用淘汰 / 合并进另一条**，共四种）与归档日期。
15. **「整条链路真的在跑」这条证据，本阶段用 tests/e2e.test.mjs 代替了真实会话自证，但它仍然不是真机证据**：e2e 用假 agent / 假 session / 假事件流驱动插件**真实的事件处理器**，只桩掉 3 个宿主包与 LLM 调用，archive / inject / eviction / merge / playbook / commit 全部是真代码、真读写临时手册与临时 `archive.md`——它能证明「接线没断、落盘结果对」，但**证不了宿主真实的事件时序**（例如 `agent/status` 报 idle 与 `runMaintenance` 的真实相位）。这些只能在重启后的真实会话里观察日志确认（第 28 轮起还要看 `dsh-ace: 注入批次已发布` 与 `dsh-ace: 注入已追加进历史` 两条日志是否一一对应，以及追加次数是否 ≈ 批次次数；第 33 轮起还要看 `dsh-ace: 命中落盘` 与 `dsh-ace: 满额淘汰` / `dsh-ace: 满额先合并` 是否按回合出现）。
16. **归档分区在真实浏览器里的观感未目视**：归档独立文件 `archive.md` 的解析/序列化、归档行的文本格式、归档条目只读、无删除入口都有单测与 e2e 取证（tests/archive.test.mjs 的「g｜归档文件格式与手册同构」与「g｜归档文件写入不留残渣」两条），但「切到已归档后那一屏长什么样」（行高、四列对齐、展开后的六个详情块、未知原因回显原串时的换行）没有在浏览器里看过。
17. **「命中账本在回合边界取走并原子落盘」的顺序在真实宿主上的时序未观测**：判据依赖两个真实事件的先后——`agent/turn-stopping` 必须先于同回合的空闲边沿 `agent/status`(idle) 到达，且 `onStatus` 里 `await` 上一次命中落盘的 Promise 链不插进复盘的 await 窗口。tests/recap-usage.test.mjs 用控制器真对象按受控时序逐条钉住了九种情形（冷却回合也取、同一批只落一次、写盘失败只 warn、两个空闲边沿重叠不抢同一份待办、`steps` 顺序），tests/recap-pipeline.test.mjs 用 tripwire 钉住「流水线不许自己取账本」；**真实宿主上的事件顺序没有观测过**。装进宿主后的判据是：`hits` 只在回合结束后增长、且 `lastHit` 落在该回合的时间窗内。
18. **`flushHits` 的写盘永远不返回时，下一个空闲边沿会一直挂着**（已知取舍，未观测）：`onStatus` 在复盘之前 `await` 上一次命中落盘的 Promise 链（`lib/recap.js` 的 `hitFlushes` WeakMap），这样命中不会丢；代价是如果那次写盘永远不返回（跨进程锁一直拿不到、盘卡死），该回合的复盘也就不执行。真实宿主上**未观测**到这种情形——写盘内部有 `LOCK_TIMEOUT_MS = 30000` 兜底（`lib/playbook.js:549`），正常路径会以失败收场并只 warn（`lib/recap.js` 的 `flushHitsNow`）。要确认得装进宿主后观察 `dsh-ace: 命中落盘失败…` 这行日志是否出现。
19. **毫秒时间戳的排序只在单进程与两个独立子进程里验证过，跨时区/跨机未验证**：`lib/timestamp.js` 的 `nowStamp` 写的是**本地时区**偏移（`+08:00`），`compareStamps` 是纯字符串比较——同机同偏移下字典序即时间序，但**跨时区混写**（两台机器不同偏移）时字符串比较会与真实时刻不一致。tests/recap-usage.test.mjs 的 i 与守护③ 只覆盖「同一台机器、两个完全独立的子进程各算一遍、结论必须一致」；旧格式 `YYYY-MM-DD` 条目照常解析、排在同样日期更早的位置，这条有用例。

20. **合并提示词在真实模型上的产出质量未实测**：tests/merge.test.mjs 的 17 条钉的是 `MERGE_SYSTEM` 的四段结构、`parseMergeResult` 的七种输入与 `planMerges` 永不抛错的确定性行为；tests/recap-pipeline.test.mjs 的守护② 钉的是「LLM 抛错或输出不合格 JSON 时不许阻塞落盘」。但「真实模型拿到两条经验之后能不能合成一条同构的四字段条目、会不会把两条的取舍关系写丢」只能靠真实会话观察——已做的替代验证是 e2e 场景 5b 用一个返回四字段 JSON 的桩把整条链路跑通。
21. **`hits` 作为唯一淘汰依据的长期分布未观测**：淘汰只在满额时发生，判据是 `hits` 升序 → `created` 更早 → `idNumber` 数字升序；但「手册长期跑下来 `hits` 会不会严重偏斜（少数条目吃掉全部命中、其余永远 0）」需要真实会话跑一段时间才能看出来。**这一轮没有实现任何再平衡机制**（那会引入新的权重面与新的误判面）。若真出现偏斜，处理办法是合并（把近似的 0 命中条目并成一条），而不是给 `hits` 加衰减。
22. **手动归档写路由的真实宿主调用未验证（第 46 轮）**：`POST /api/dsh-ace/entries/archive` 同样落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效。已做的替代验证是 tests/wiring.test.mjs 的 4 条真落盘用例（真临时手册 + 真 `archive.md`，覆盖成功、高水位、记账日志、404/400/405/403 五条失败路径）与 tests/client-entries.test.mjs 的 8 条渲染用例（首点零写、二点 POST、成功后 reload、失败可见报错、四种复位、样式与对比度、归档区只读）。**仍未验证**：①真实浏览器里点一次按钮到列表刷新之间的观感（按钮由暗色变红的那一下、报错那行的换行与行高）；②宿主 `connection` 服务真实存在时的围栏行为（测试走的是结构化回环分支，`connection.admit` 分支只有既有源码级断言）；③相对 `playbookPath` 配置下该路由的行为——HTTP 面没有 agent，`resolvePlaybookFile` 会抛 `RELATIVE_PATH_NEEDS_SESSION`，本路由把它转成 400 `{ error }`（没有任何用例覆盖这条 400，hot-path 用例只用了绝对路径）。等宿主重启后人工确认：记录页展开任一条 → 点「归档」应变红「确认」→ 再点一次该条从活跃区消失、切到「已归档」能看到它且原因是「显式移除」。 **第 47 轮补测后又添两条**：④ 第 47 轮那条 409 用例依赖真实并发时序（两个请求同发、外部写者占锁 150ms）——极端调度下第二请求若快照读晚于第一请求写盘，会对着断言**响亮失败**（不是静默绿），本会话 5 次完整运行均稳定出 `[200,409]`，但未做长时间高压统计；⑤ 冒泡夹具是「沿 parent 链逐级直调 onClick」的最小实现，只覆盖 `stopPropagation`（client.js 无 `preventDefault` 消费点），不含捕获阶段 / 合成事件 / 键盘焦点语义。

## 已知取舍与已知限制（第八轮判定，按原样记，不写成缺陷）

**结论：下面三条是修复方在第八轮审查里逐条判定为「不动」的取舍。它们不是待修的缺陷，写在这里是为了让后来者知道「代码为什么长这样」，而不是当成违章去改。**

- **P2-a｜命中落盘没有自己的超时，靠文件锁的 30 秒兜底**：`flushHits` 最终落到一次手册写盘（`writeFileAtomic` 在 `withExclusiveLock` 里），锁自身的 `LOCK_TIMEOUT_MS = 30000`（`lib/playbook.js:549`）就是真实上界——拿不到锁会在 30 秒后以失败收场，走「只 warn + 退回账本、下个回合边界重试」那条路（`lib/recap.js` 的 `flushHitsNow` catch 分支）。再叠一层独立超时只会让「到底该由谁放弃」出现两个口径，所以不加。**已知限制**：写盘跨过了回合边界仍在飞时，下一次写会排在它后面（`hitFlushes` 的 Promise 链），慢盘上会串行化。
- **P2-d｜每回合一次全量写盘（写放大），是设计取舍**：一次命中落盘 = 一次 `commitMeta`，每次都把整份手册序列化后原子写一遍；复盘那一步的 `commitOps` 也是整份写。手册当前规模（几十到上百条）下这不是瓶颈，而「命中只增不减、晚记不会算错任何东西」本来就是刻意换来的正确性——放进回合边界一次写，是为了不在一回合里写十几遍同一份文件。**要优化得先有实测的写放大证据**（手册多大、每回合几次写、耗时多少），本阶段没做这个测量。
- **P2-e｜`INJECT_MIN_ENTRIES = 3` 只有对外契约、没有实现**：`lib/inject.js:17` 导出它，`lib/inject.js` 的 `selectInjection` 只取 `INJECT_MAX_ENTRIES = 5` 与 `INJECT_TOKEN_BUDGET = 500` 两个上限；`lib/inject.js` 里 `selectInjection` 的文档注释写明「不足 3 条不硬凑——相关度不够就按实际条数注入（这个常量只用于对外契约与测试断言，逻辑上不做任何补足）」。也就是说「一次注入 3–5 条」里的那道**下限没有实现**：命中 1 条时就注入 1 条。这是有意的（硬凑会把不相关条目塞进注入消息，比少注入更伤），但如果需求方要的是真下限，得单独决定「不够 3 条时怎么办（补低相关条目 / 干脆不注入）」——本阶段不自行改设计。

## 已知取舍与已知限制（第 33 轮判定，按原样记）

**结论：下面四条是第 33 轮「把正负评分换成绩效淘汰」时判定为「按原样记、不写成缺陷」的取舍。它们都是设计换来的代价，不是待修项。**

- **P33-a｜`hits` 只数「被自动注入」与「被定向检索」，不数「被整本读过」**：整本读取（`ace_playbook` 不带参数）一次都不计数——整本读取没有「用上哪一条」的信号，把它记成命中会让「读一眼清单」等价于「真的用它」。代价是一条长期只被整本读取、从不被注入的经验会被当作 0 命中淘汰。**这是有意的**：宁可让「没人真的用到」的条目走，也不让「翻过目录」冒充使用。
- **P33-b｜合并是最慢的一步，且合并失败会退化成淘汰**：满额时先试 LLM 合并（最多 5 轮、每轮一对），这意味着满额那一回合要多花 1–5 次模型调用；全部失败就直接按 `hits` 淘汰腾位。**代价是有可能把两条本来能合成一条的经验拆着淘汰**，换来的是「绝不因为一次 LLM 抽风就把整批候选丢掉」。历史教训就是这般：一轮 LLM 抛错就把整晚的复盘全丢。
- **P33-c｜毫秒时间戳让元数据行变长，且同毫秒并列只能靠 id 兜底**：`created` / `updated` / `lastHit` 从 `YYYY-MM-DD`（10 字符）变成 `YYYY-MM-DDTHH:mm:ss.SSS+08:00`（29 字符），每条的元数据行固定多出约 57 字节（手册 100 条 ≈ +5.6 KB，人眼扫读也更吵）。同毫秒并列没有更细的时间源可用，只能由 `idNumber` 数字升序兜底——**排序仍然是确定的**，只是「谁更早」在这个精度上不可分辨。界面上仍只显示到日。
- **P33-d｜归档文件 `archive.md` 只增不减，长期会超过手册本身**：软归档永不物理删除（红线），淘汰与合并掉的经验全部堆在归档文件里，条目越多它越长（当前设计没有任何压缩或分卷）。这是**有意的**：人可以在设置页读它、也可以直接手改它，「删掉」这个动作永远留给人来做。代价是长期使用后这个文件会一直长，且它不参与任何检索（不进注入、不进复盘、不进整本读取）。

## 第 33 轮作废的旧结论（只记一笔，不重写）

**结论：下面这些第 8/9/10 轮记下的取舍与终审结论，绑的都是第 33 轮已整层删除的机制，因此不再成立。** 留着这节是为了让后来者知道「为什么那些段落消失了」，而不是去把它们找回来。

- **作废 A｜第九轮 R9-a…R9-d 与「路线 A 成立」的终审结论**：它们钉的是「归档判定必须读结算后的分数」，靠 `pendingIds` 排除链 + 归档扫描前先结算。第 33 轮删掉 `scoreUsedIds` / `scanArchives` / `pendingIdSet` / `settling` / `settlingIds` / `usages` 之后，**没有分数可读、也没有归档扫描**——腾位改由「满额 + 最少使用淘汰」确定性触发，不存在「读到未落盘的旧分数」这个窗口。
- **作废 B｜第十轮 R10-a…R10-d**：R10-a（唯一可归档条目恰在待结算集合里 → 整批被拒）不再发生，淘汰判据不看结算状态、也不整批拒绝；R10-b（`settlingIds` 挂死）随 `settlingIds` 删除而不存在；R10-c（`pendingIdSet` 异常兜底零用例）随该函数删除而不存在；R10-d（`commitArchives` 默认归档计划生产不可达）随该入口删除而不存在。
- **作废 C｜未验证清单第 17–21 条（旧版）与人工 review 的「九格 + 五行明细」**：旧 17 是「结算顺序未观测」、18 是「在飞结算挂死」、19 是「`pendingIdSet` 抛错降级」、20 是「三层闸门拦截率」、21 是「未观测回合就地结算」——全部绑在已删机制上，已按新版 17–21 条改写；人工 review 的九格与「已归档视图：净分过低 / 长期未命中 / 被新条目取代」也已按六格 + 四原因改写。
- **作废 D｜tests/gate.test.mjs 与 tests/probation.test.mjs 的全部用例**：19 + 13 条随 `lib/gate.js` 与 `PROBATION_*` 一起删除，**不是被标 skip、也不是断言被放宽**；等价强度的新判据在 T232–T245 与三条守护用例里。

## 已知取舍与已知限制（第十轮终审判定，第 33 轮已作废，原文保留）

**结论：下面四条是独立终审判定为「无阻断、按原样记」的 P2。它们不是待修缺陷，写在这里是为了让后来者知道边界在哪。** 其中 R10-a…R10-d 已于第 33 轮作废（见上一节「第 33 轮作废的旧结论」），原文保留作历史。

- **【第 33 轮已作废，仅作历史】** **R10-a｜满额那一轮若「唯一可归档的条目」恰在待结算集合里，本批候选会整批被拒**：`commitOps` 的满额腾位用同一份 `pendingIds` 排除待结算 id（`lib/commit.js:110-118`），腾不出位时 `applyOps` 按容量判据整批 `throw`（`lib/playbook.js:484-486`），复盘以失败收场并推一条提示（`lib/recap.js:471-473` 的 `notifyFailure`）。**这是有界的、非静默的、也不误归档**：终审探针连跑三个空闲边沿，实见回合 2 / 4 / 6 各拒一次（其中后两次属于设计内的「本来就没有该归档的条目，所以拒绝」），丢的是这一批候选，已有条目一条不少。代价是极端情况下那批候选要等人再触发一次复盘。
- **【第 33 轮已作废，仅作历史】** **R10-b｜`settlingIds` 要等 `task` 真正 settle 才清，结算挂死时新注入的 id 对归档判定不可见**：`settlingIds` 在 `clear()` 里随 `settling` 一起摘除（`lib/recap.js` 的 `clear`），而 `clear` 挂在 `task.then(clear, clear)` 上。若 `settleUsage` 永远不 resolve，这份集合就一直留在 WeakMap 里——新注入的 id 会被它挡住（归档判定看不见它们），同时 `onStatus` 也会一直等那份在飞结算。生产实现是本地锁内读写、外加 `LOCK_TIMEOUT_MS = 30000`（`lib/playbook.js:627`）兜底，与第八轮的 P2-a 是同一个面，见未验证清单 18。
- **【第 33 轮已作废，仅作历史】** **R10-c｜`pendingIdSet` 的异常兜底零用例覆盖**：求值抛错 → 返回空集、退回改动前的行为（`lib/archive.js:99-107`），这条降级路径**没有用例**。终审把这段故意改坏，196 条相关用例仍然全绿——也就是说「查询坏掉时不炸复盘」目前只有代码注释在保证，没有机检。见未验证清单 19。
- **【第 33 轮已作废，仅作历史】** **R10-d｜`commitArchives` 的默认归档计划在生产路径上不可达，它的 `pendingIds` 透传也没有覆盖**：不传 `archive` 选项时它自己调 `scanArchives`（`lib/commit.js:184-186`），但仓库里唯一的调用方（`lib/recap-pipeline.js:215-217`，0 候选分支）总是显式传钩子，所以那条默认分支只在测试里被走过（`tests/archive.test.mjs:161` / `:617`）。终审把它的 `pendingIds` 透传改坏，用例仍然全绿——属「生产不可达 + 无覆盖」，留着是因为它是 `commitArchives` 的对外契约（直接调它的人可能不传 `archive`）。
