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

当前 282 条用例：281 通过 + 1 条在 Windows 上条件跳过（T47 文件权限位，见未验证清单 7）。**上一轮「自动复盘喂料修复（喂真轨迹）」净增 15 条**：新增 tests/trajectory.test.mjs 18 条（T160–T177），同时删掉 tests/trigger.test.mjs 里 3 条 `hasNoRunningSubagents` 用例（该函数已随子代理门一起删除）。**本会话第二轮「3 条遗留缺陷修复」净增 10 条（T178–T187）**：tests/trajectory.test.mjs 由 18 条增至 23 条（+5：长回合超限后任务目标仍在、maxChars 极端值不抛错、并行 tool-call 按 id 绑定、toolCallId 查不到时回退、映射不跨调用串味）、tests/trigger.test.mjs +3（`prevLastRecapTurn` 记旧值、`abandonPendingRecap` 回滚后立刻可再触发、畸形输入不抛错）、tests/recap.test.mjs +2（`{skipped:true}` 回滚额度且不推提示、非 skipped 返回值不回滚）。同时既有 6 条用例按新事实改写期望（T161/T165/T169/T176 的格式升级与 `return {skipped:true}` 等），只换期望值、未放宽也未删除任何断言。其中「记录列表详情页」的只读条目清单新增 14 条（T133–T146，tests/entries.test.mjs）：空手册 / 正常手册（auto 与非 auto）/ 字段映射 / 四种降级（missing、unreadable、needs-session）/ maxEntries 透传 / 只读红线 / `GET /api/dsh-ace/entries` 的 200 体形状与源码级契约，以及 `/stats` catch 兜底改成同形零值 payload 的断言。其中只读统计 16 条（T117–T132）为「设置页只读手册统计」新增：纯函数与读盘降级 10 条（tests/stats.test.mjs）、统计块渲染 / 四种 reason 降级 / 刷新时机 6 条（tests/client-stats.test.mjs）。其中手册路径解析链 9 条（T48–T56）、跨进程文件锁 4 条（T57–T60）、跨进程锁覆盖整个读-改-写区间 3 条（T61–T63）为「手册默认本机共享层」改造新增；跨进程锁语义返工又新增 4 条（T64–T67，见下表）；并发冲突检测（快照 + 冲突报错）再新增 3 条（T68–T70，见下表）；锁的重入与回收兜底 3 条（T71–T73）与核心默认值 1 条（T74）见下表。**逐条冲突判定 + add 参与冲突检测 + 编号不复用**这轮改造新增 16 条：单元 12 条（T75–T86，见下表）与真实子进程并发 4 条（T87–T90，见下表，测试文件 tests/concurrency.test.mjs，脚本写在系统临时目录、用完即删，仓库里不留脚本）。**自动复盘触发时机迁到空闲边沿**这轮新增 19 条：纯状态机 8 条（T91–T98，tests/trigger.test.mjs）与调度器行为 11 条（T99–T109，tests/recap.test.mjs，见下表）。**独立对抗性验收发现的 8 个缺陷修复**这轮新增 7 条（T110–T116）：近似层只比正文、同领域不同经验不判冲突、相似度百分比封顶 100%、并发改名 + 同标题新增被检出、高水位标记归位且全文只留一份、无标记时编号复用一次的行为钉住（见下表）。语法自检：对每个 `lib/*.js` 跑 `node --check`；`package.json` 以 `JSON.parse` 校验。
**本会话第三轮「3 条验收遗留项修复」再净增 4 条（T188–T191）**：tests/trajectory.test.mjs 由 23 条增至 25 条（+2：退化分支的省略数恒等于真实丢弃数、整条 summary ≤ maxChars）、tests/trigger.test.mjs +2（await 窗口内挂上新待办时旧 pending 回滚不吞新待办、同一份待办重复放弃只生效一次）。总数从 238 → 242（241 通过 + 1 skip）。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第四轮「3 条验收新缺陷修复」再净增 7 条（T192–T198）**：tests/trigger.test.mjs 由 23 条增至 27 条（+4：新待办已被另一个空闲边沿取走时迟到回滚被拒、`restorePendingMutCount` 正常路径只还计数不回滚冷却、`restorePendingMutCount` 遇到更新的待办时一个字段都不动、requeue 后再次 take 同一份待办再放弃仍生效）、tests/recap.test.mjs 由 13 条增至 15 条（+2：失败分支只在待办仍归我时才还计数、两个空闲边沿交错时迟到的 skipped 回滚被拒且不谎报已还回）、tests/trajectory.test.mjs 由 25 条增至 26 条（+1：`maxChars` 小于计数行长度时以保证计数行完整为准）。总数从 242 → 249（248 通过 + 1 skip）。同时既有 3 条用例按新事实改期望（`createRecapState` 初始状态多了 `pendingSeq: 0`；`recordTurnEnd` 挂的待办多了 `seq`，T90/T190 与 recap 的「空闲边沿才真正触发复盘」同步），只换期望值、未放宽也未删除任何断言。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第五轮「4 条自动复盘回滚缺陷修复」再净增 8 条（T199–T206）**：tests/trigger.test.mjs 由 27 条增至 33 条（+6：`requeuePendingRecap` 遇到更新的待办时明确拒绝放回、耗尽分支也不许抹掉队列里那份、`restorePendingMutCount` 幂等、两条回滚路径共用已结算账本、`requeuePendingRecap` 不算结算、`ownsPending` 旧形状兜底在代次已前进时一律不认），tests/recap.test.mjs 由 15 条增至 17 条（+2：撞忙回队时不覆盖更新待办且不谎报「已放回队列」、撞忙重试到上限时仍保留队列里那份更新的待办）。总数从 249 → 257（256 通过 + 1 skip）。**这一轮没有改动任何既有用例**：新增的所有权判定只拦「本就不归自己」的调用，既有手工构造旧形状待办的用例都走 `pendingSeq === 0` 那一档，全部照旧通过。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第六轮「记账覆盖未执行待办」再净增 7 条（T207–T213）**：tests/trigger.test.mjs 由 33 条增至 38 条（+5：队列里还压着没执行的待办时合并计数、合并后回滚还回最老那一笔的原值、覆盖合并必须留痕、`recordTurnEnd` 的 logger 可选、合并后迟到的 abandon/restore/requeue 一律被拒且一个字段都不动），tests/recap.test.mjs 由 17 条增至 19 条（+2：撞忙回队 + 冷却期内记账 → 下一轮触发合成一份待办、合并后的待办被放弃时冷却回最老原值且额度不白吃）。总数从 257 → 264（263 通过 + 1 skip）。**为什么**：`recordTurnEnd` 是唯一挂新待办的地方，它原来无条件 `st.pendingSeq += 1` + `st.pending = {…}`，而队列里完全可能还压着一份从没执行过的待办（上一回合挂了、空闲边沿撞忙又放回来、冷却还没到）——那一整轮的 mutating 计数就此静默蒸发，日志里一个字都没有。改成合并之后，除「计数相加」外还有两条容易被忽略的不变量被用例钉住：`prevLastRecapTurn` 必须取**旧**待办那份（最老那一笔推进之前的值），否则放弃时会把冷却还回到旧待办那一轮、白吃中间几回合；旧待办的 `seq` 被顶替之后必须再也结算不了，否则**已经并进新待办的那几次计数会被再还一遍**、额度凭空翻倍。**这一轮没有改动任何既有用例**（没有换期望值、没有放宽也没有删除断言）：合并只在「队列里真压着待办」时生效，既有 `recordTurnEnd` 用例的队列都是空的，走 `queued === null` 那条分支，行为与改动前逐字相同。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。
**本会话第七轮「在飞旧待办的额度蒸发（F1）+ 两条硬化」再净增 8 条（T214–T221）**：tests/trigger.test.mjs 由 38 条增至 44 条（+6：F1 过继给队列里那份新待办、F1 队列已空时还回状态但不动冷却、F1 同一份待办被三条路径连拒只过继一次、F1 已被合并吸收的旧待办不许再过继、H1 负数/垃圾 `mutCount` 一律按 0、H2 畸形 logger 各种形状都不抛），tests/recap.test.mjs 由 19 条增至 21 条（+2：F1 端到端 skipped 变体、F1 端到端 busy 变体且不许静默）。总数从 264 → 272（271 通过 + 1 skip）。

**本会话第八轮「通知消息 content 形状修复 + 两条 trigger 硬化」再净增 10 条（T222–T229 + T230/T231）**：新增 tests/notice.test.mjs 8 条（T222–T229，纯模块直测 + 对 lib/index.js 的源码级断言）、tests/trigger.test.mjs 由 44 条增至 46 条（+2：H3 过继搬移抛错时额度不蒸发、账本也没封；H4 负数 mutCount 不许把 st.mutCount 往回拽）。总数从 272 → 282（281 通过 + 1 skip）。**这一轮修的是一个会让整个会话永久坏死的缺陷**：自动复盘失败时注入的通知消息把 `content` 传成了裸字符串，宿主 `createUserMessage` 不校验形状（`~\@deepseek-ai\dsh-llm\lib\types\message.js:34-39` 的 `createMessage` 只 spread + `deepFreeze(structuredClone)`、`:53-58` 的 `createUserMessage` 只补一个 `role`），于是字符串原样进了会话历史；此后宿主里 52 处 `.content.some(...)` 拿它当数组调用抛 `TypeError: message.content.some is not a function`，而每一轮重建上下文都要遍历历史，这条毒消息让会话再也开不起来（用户再发「继续」照样失败）。三处注入点（`conflictMessage`、自动复盘失败通知 `notifyFailure`、`/ace review`）改为经新增的零 import 模块 lib/notice.js 的 `noticeMessage()` 构造 `ContentBlock[]`，**文案与 source 一字未改**——这是形状修复，不是文案改版（T229 守着文案，T227/T228 守着形状）。**T227 的定位要说准**：它是「防手滑把 content 写回裸字符串」的**绊线**，不是「证明形状正确」的**证明**——它不推理、不是类型检查器，已知至少 5 个刻意绕过时的漏点（`content: [text]` 数组里塞裸字符串、`content: textBlocks(t) + ''` 把返回值拼成字符串、`content: noticeMessage({text}).content.join('')` 取完又拼回去、别名调用 `const cum = createUserMessage; cum({...})` 计数 0 完全看不见、`createUserMessage(['just a string'])` 数组元素形状不管）；它的价值在「有人为了让自己过而放宽它」时提醒：放宽等于拆掉唯一的绊线（它取的是 `content:` 之后的**首个非空行**，所以 `createUserMessage(\n  noticeMessage({...}),\n)` 这类跨行合法写法不会被冤枉）。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。

**既有用例只换期望值、未放宽也未删除任何断言**（逐条理由统一：旧期望值钉的正是「额度蒸发」这个缺陷行为本身，`ownsPending` 判「不归我」之后的正确结果是过继而不是丢弃）：

- tests/trigger.test.mjs `:184` 起「abandonPendingRecap: await 窗口内挂上新待办时…」：`pending.mutCount` 1 → 3（过继 2 次）、`prevLastRecapTurn` 5 → 0（abandon 这一路把冷却一并过继并取更早者）；`st.mutCount === 0` 的断言保留（过继给的是队列里那份，不许同时再还回状态）。
- tests/trigger.test.mjs `:253` 起「新待办已被另一个空闲边沿取走时…」：情形一 `st.mutCount` 0 → 2、情形二 1 → 3，并新增一条「过继过一次」的 warn 断言（只加强，不减弱）。
- tests/trigger.test.mjs `:314` 起「restorePendingMutCount: await 窗口内挂上新待办时…」与 `:365` 起 / `:396` 起两条 requeue 用例：`pending.mutCount` 1 → 3；restore 那路的 `prevLastRecapTurn` 保持 5（失败分支只还计数、不过继冷却，第 4 轮刻意语义不变）。
- tests/recap.test.mjs `:246` 起 / `:335` 起 / `:378` 起：`mutCount` 1 → 3；`:335` 起那条另加 `calls.recap[1].mutCount === 3`（证明第二份待办执行时确实带着过继来的额度）。
- tests/recap.test.mjs `:283` 起：标题由「…迟到的回滚被拒」改为「…迟到的 skipped 回滚被拒但额度不蒸发，冷却不回退、不谎报已还回」，`st.mutCount` 1 → 3，`st.lastRecapTurn === 5` 保留。

反向自证（在 `adoptOrphanPending` 里、算出 `where` 之后临时插一句 `return false; // 直接拒绝、不过继`，跑完立刻删掉）：`node --test tests/trigger.test.mjs tests/recap.test.mjs` 由 67/67 绿变 `ℹ tests 67 / ℹ pass 50 / ℹ fail 17 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0`（EXIT=1），红的 17 条逐条如下（trigger 11 + recap 6）：trigger 侧——`restorePendingMutCount: await 窗口内挂上新待办时不碰队列、额度过继进新待办，并写一条 warn`、`requeuePendingRecap: await 窗口里已挂上更新的待办时，队列一个字段都不动、额度过继进新待办并明确拒绝`、`requeuePendingRecap: 耗尽分支也只清自己那一份，队列里更新的待办必须留着`、`abandonPendingRecap: await 窗口内挂上新待办时，旧 pending 回滚不吞新待办、不破坏计数`、`abandonPendingRecap: 新待办已被另一个空闲边沿取走时，迟到的回滚也必须被拒（代次判定）`、`F1：在飞的旧待办被拒时，额度过继给队列里那份更新的待办（不蒸发、不翻倍）`、`F1：队列已被另一个空闲边沿取空时，旧待办额度还回状态、但冷却不回退`、`F1：同一份旧待办被三条路径连拒，只过继一次（幂等，额度不翻倍）`、`H3：过继搬移抛错时额度不蒸发、账本也没封（冻结 / 只读 getter 两种构造）`、`ownsPending 旧形状兜底：pendingSeq 已前进过，无 seq 的旧待办一律不认`、`覆盖合并之后，迟到的 abandon/restore/requeue 作用在旧待办上一律被拒且一个字段都不动（D1）`；recap 侧——`失败分支只在待办仍归我时才还计数：await 窗口里挂上新待办时 mutCount 保持 0`、`两个空闲边沿交错：迟到的 skipped 回滚被拒但额度不蒸发，冷却不回退、不谎报已还回`、`撞忙回队时窗口里已挂上更新的待办：不许覆盖队列，也不许谎报「已放回队列」`、`撞忙重试到上限时窗口里挂上更新的待办：耗尽也不许抹掉队列里那份`、`F1 端到端（skipped 变体）：在飞的 p5 跳过时，3 次额度必须过继给队列里那份 p7`、`F1 端到端（busy 变体）：在飞的 p5 撞忙被拒时，3 次额度过继给 p7、且不静默`。H1/H2 在反向自证下照旧通过（它们断言的是与过继无关的行为：负数/垃圾计数按 0 处理、畸形 logger 不抛）；恢复后回到 67/67 全绿——说明这些断言真的钉住了 F1，而不是跟着实现随便改。

反向自证之二（临时把 lib/index.js 三处通知的 `content` 退回裸字符串：`conflictMessage` 的 `content: text`、`notifyFailure` 的 `content: 'ACE 自动复盘未完成：' + reason + …`、`/ace review` 的 `content: renderReviewText(items)`）：`node --test tests/` 由 282/281 全绿变 `ℹ tests 282 / ℹ pass 280 / ℹ fail 1 / ℹ cancelled 0 / ℹ skipped 1 / ℹ todo 0`（EXIT=1），唯一红的是 T227（单跑 `node --test tests/notice.test.mjs` 则是 `ℹ tests 8 / ℹ pass 7 / ℹ fail 1`）；T229 因为只钉文案与 source、不带形状前缀，照旧通过。失败原文照抄：`AssertionError [ERR_ASSERTION]: lib/index.js 第 1 处 createUserMessage 的 content 是「text,」，不是 ContentBlock[]。content 必须是 ContentBlock[]（MessageBase.content，~\@deepseek-ai\dsh-llm\lib\types\message.d.ts:128）：裸字符串会让宿主 .content.some 抛错、那条毒消息留在历史里会让整个会话永久坏死`。恢复三处修复后同一命令回到 `ℹ tests 282 / ℹ pass 281 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 1 / ℹ todo 0` 全绿——形状断言真的钉住了这个缺陷，而不是跟着实现随便改。语法自检同前：每个 `lib/*.js` 跑 `node --check`，`package.json` 以 `JSON.parse` 校验。

反向自证之三（两条 trigger 硬化各自都被单独钉住）：把 `adoptOrphanPending` 改回「先记账、后搬移」（`ADOPTED_PENDINGS.add(pending)` 提到两处赋值之前）→ 全量 `node --test tests/` 恰有 1 条红：`H3：过继搬移抛错时额度不蒸发、账本也没封（冻结 / 只读 getter 两种构造）`；把两处结算改回 `const mutCount = Number(pending.mutCount); st.mutCount = (Number(st.mutCount) || 0) + (Number.isFinite(mutCount) ? mutCount : 0);` → 恰有 1 条红：`H4：负数 mutCount 不许把 st.mutCount 往回拽（失败回滚与跳过回滚两路同口径）`。两次都实测（EXIT=1），恢复后 282/281 全绿。**注意这个「恰有 1 条」只对文档自己写的那种退回式成立**：换别的退回写法可能连带红更多条——实测把两处结算退回更朴素的 `st.mutCount = Number(st.mutCount) + Number(pending.mutCount);` 会红 **3 条**（另两条是 tests/trigger.test.mjs:155 的 `abandonPendingRecap: 畸形输入不抛错` 与 tests/trigger.test.mjs:487 的 `ownsPending 旧形状兜底：pendingSeq 已前进过，无 seq 的旧待办一律不认`，它们也吃这两处结算）；所以「红了 3 条」不是文档写错了，而是退回式不同、连带面不同。

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
11. **自动复盘在真实宿主上「真的落盘」仍未验证——但两道门都已修掉**：原实现的疑点逐个定位并修掉。①**时机**：`agent.runMaintenance` 只在 idle 相位合法（宿主 `~\@deepseek-ai\dsh-agent-loop\lib\index.js:823`），而 `agent/turn-stopping` 派发时 phase 是 running（同文件 `:939`），所以自动复盘此前必然以「already has active work」失败；触发点已迁到 `agent/status` 报 idle 的空闲边沿（见 DESIGN.md I9），T99–T109 覆盖纯逻辑与模拟宿主。②**喂料**：原来只喂「本回合有 N 次 mutating 工具调用」这句计数，实测同一套 Reflector 喂计数返回 `candidates: []`、喂真实轨迹返回 6 条候选——现在 `runRecap` 改喂 `agent.session.deriveMessages()` 渲染出的真实轨迹（lib/trajectory.js，T160–T176 覆盖渲染与喂料形状，含「轨迹为空不调 LLM」）。③**触发窗口**：「有子代理在跑就不记账」那道门已删（子代理是 resident，settle 才注销，真实用法里几乎每轮都命中），T177 与 tests/recap.test.mjs 的改后用例守着。④**喂料截断**：原 `maxChars` 是硬截尾，长回合里开头的任务目标会被整段切掉（实测 51 条消息渲染 12018 字符，输出首行变成「…（前面 11106 字符已省略）」，`目标：修好 build 脚本` 消失），现在改成**首尾都保留**（`maxHeadChars` 3000 保开头 + 中间省略标记 + 结尾吃剩余预算），T169/T178/T179 守着。⑤**结果与工具绑定**：tool 结果行现在带工具名（`结果(read): …`），靠同一次渲染内的 tool-call id 映射反查，T161/T165/T180–T182 守着。⑥**空轨迹跳过不吃额度**：`runRecap` 返回 `{skipped:true}` 时调度器把冷却与 mutating 计数原样还回去（`abandonPendingRecap`），T183–T187 守着；这条回滚路径本身认得「只回滚自己那份待办」且幂等（T190/T191），所以 await 窗口里新挂上的待办不会被吞、额度不会被重复还回去。⑦**退化截断的省略数是自洽的**：`maxChars` 小到放不下尾部时，标记里的 N 恒等于真实丢弃数、标记放不下就返回空串（T188），调用方的「没材料」分支因此能自然生效；整条 summary（含两行标题）也 ≤ `maxChars`（T189）——但这两条都是纯逻辑证据，真实模型收到的 prompt 总长是否确实落在上限内，仍要装后取一次实际 prompt 才能确认。**仍未验证的**：这三条修完之后，真实宿主上跑一次自动复盘、确认手册里真的多出 `auto=true` 条目，仍需**重启 DSH** 才能验证——lib/index.js 是服务半边、在插件加载时被 import，不重启就跑的还是旧代码（本任务环境不允许重启宿主）。同理，idle 边沿与新唤醒之间的竞态退避（`already has active work` → 放回队列 → 下一个 idle 边沿重试）在真实宿主上的实际发生频率也未观测；喂真轨迹后 Reflector 的实际产出质量（候选条数、是否真的并入手册）同样只能在真机上观察；同理，**「空轨迹跳过已经把冷却与 mutating 计数还回去」这条只有纯逻辑证据**（T183–T187 用注入的假 controller 跑），真实宿主里「空轨迹」这一情形会不会真的发生（例如 `deriveMessages()` 返回空、或渲染后 `text` 为空）以及回滚后的下一个回合是否照预期立刻再触发，也要装后观察日志里的那条 `dsh-ace: 回合 N 没有可用的轨迹（没材料）…` 才能确认。
12. **条目编号在「人同时删最高编号条目 + 删高水位标记」时会复用一次**（已知限制，不修）：历史最大值只存在于手册文档头的那行 `<!-- ace:id-highwater: N -->` 标记里，条目被删掉之后无法从文件本身恢复，因此这两种删除同时发生时该编号可能被复用一次（随后标记被重写成当前最大编号，也就是刚被复用的那个号，因此只会复用这一次）。T114 把这一当前行为钉住；README「已知限制」与 DESIGN.md 的 I2 都已按此措辞写明。**没有**实现「从别处猜回历史最大值」的机制——那需要额外持久化历史，会超出增量演化的边界。
13. **只读统计端点 `GET /api/dsh-ace/stats` 的真实宿主返回未做 HTTP 验证**：改动落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效（当前 GUI 就跑在这个进程上，本任务环境不允许重启宿主）。已做的替代验证是纯函数与客户端两侧的单测（T117–T132）：返回值形状、四种降级（needs-session / missing / no-entries / unreadable）、以及统计块在 404 时的降级都钉住了，但**端点本体的真实响应体、以及统计块在真实浏览器里的观感（CSS 布局、14 天条形的宽度与对齐）未目视**。等宿主重启后人工确认：打开设置页 → 「ACE 手册」，应看到条目数显示为 `N / 100`、路径为本机共享手册绝对路径、14 天条形图有非零行、auto 占比 0% 且旁边有「自动归档尚未落盘过」灰字。
14. **只读条目端点 `GET /api/dsh-ace/entries` 的真实宿主返回未做 HTTP 验证**：改动同样落在 `lib/index.js` 的 webServer 前缀路由里，必须重启 DSH 才生效。已做的替代验证是 T133–T145：纯函数与只读 IO 直接跑（分支本体只做「调它 + send」），分支的围栏顺序、405、错误体与 Content-Type 用源码级断言钉住；**端点本体的真实响应体、以及「记录列表详情页」在真实浏览器里的渲染未目视**。等宿主重启后人工确认：`GET /api/dsh-ace/entries` 应返回 `{ ok:true, entries:[…全量…], total:N, maxEntries:100, pathKind, playbookPath }`；手册路径为相对路径时应返回 `{ ok:true, reason:'needs-session', entries:[], total:0, maxEntries:100 }` 而不是 500。