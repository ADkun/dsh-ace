# AGENTS.md —— dsh-ace 仓库路由

本文件是 agent 进入本仓库的第一站：只做路由、命令与红线，细节一律下沉到对应文档。

## 这是什么

dsh-ace 是 DSH 原生插件（cordis bundle），实现 ACE 方法：把操作手册（playbook）当作可进化资产，经 `ace_reflect`（复盘）与 `ace_curate`（增量并入）演化，`ace_playbook` 供查阅。手册默认在本机共享层 `<DSH home>/ace/playbook.md`（跨工作区共用一本）；`playbookPath` 填相对路径则改为该工作区私有。

## 文件地图

| 要了解 | 去读 |
| --- | --- |
| 安装、配置字段、首次使用 | README.md |
| 架构、数据模型、不变量、红线依据 | DESIGN.md |
| 测试怎么跑、覆盖了什么、还差什么 | TESTING.md |

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：Config、三个工具注册、系统提示段 |
| `client.js` | 浏览器半边：在 DSH 设置面板注册「ACE 手册」配置页（settings.section slot，经 ctx.configForms 读写配置；固定 VCP 暗色 + JetBrains Maple Mono） |
| `lib/playbook.js` | 手册持久化：解析/序列化/增量操作/原子写/互斥锁（同进程 `withLock` + 跨进程 `withFileLock`，组合入口 `withExclusiveLock`；跨进程锁**不抢占活着的持锁者**，超时失败而非覆盖）；纯逻辑，可独立测试 |
| `lib/merge.js` | 相似度层：合并建议（BM25 比率）与 **add 的冲突判定**（`detectAddConflicts`/`detectAllConflicts`）；依赖方向单向：playbook.js ← merge.js ← commit.js ← index.js |
| `lib/commit.js` | 提交编排：锁内「读最新 → 逐条冲突判定 → 应用安全部分 → 原子写」（`commitOps`）；三条写入路径共用，也是并发用例跑的生产同款路径 |
| `lib/trigger.js` | 自动复盘触发判定的纯函数：mutating 工具集合、主代理判定、触发条件判定，以及调度用的状态机（`recordTurnEnd`/`takePendingRecap`/`requeuePendingRecap`/`abandonPendingRecap`/`restorePendingMutCount`/`isBusyError`）；纯逻辑，可独立测试。`recordTurnEnd` 挂待办时把**改之前**的回合号存进 `pending.prevLastRecapTurn`，并给待办打上**代次** `seq`（= `state.pendingSeq`，每挂一份新待办 +1）；挂新待办时若**队列里还压着一份没执行过的旧待办**（上一回合挂了、空闲边沿撞忙放回来、冷却又还没到），它是**合并**不是覆盖：新待办的 `mutCount` = 旧待办 `mutCount` + 本回合计数（谁都不吞谁，否则旧待办那一整轮经验静默蒸发），`prevLastRecapTurn` 取**旧待办的**（= 最老那一笔的原值，否则还把回到旧待办那一轮就会白吃中间那几回合的冷却），`attempts` 从 0 重新计（旧待办被撞忙浪费的那次不算到新待办头上）并写一条 info 留痕（`recordTurnEnd` 因此有可选 `logger` 参数）；旧待办 `seq` 被顶替后 `ownsPending` 天然拒掉迟到结算；`abandonPendingRecap` 用 `prevLastRecapTurn` 把「没材料跳过」吃掉的冷却与 mutating 计数原样还回去，`restorePendingMutCount` 在**真实失败**时只还 mutating 计数、不回滚冷却。两者共用内部私有判定 `ownsPending(st, pending)`：**只回滚自己取出的那一份**——按代次比对（`pending.seq === state.pendingSeq`），所以「`state.pending` 已换成新对象」和「新待办已被另一个空闲边沿取走、`state.pending` 又变回 null」两种情形都能拒绝，一个字段都不动并写 warn；没有 `seq` 的旧形状待办要过两档兜底：`state.pendingSeq > 0`（代次前进过，说明之后一定挂过更新的待办）时**一律不认**——否则队列恰好为空时迟到的旧回滚会把旧回合计数还回来、把冷却倒退；只有 `pendingSeq === 0` 的全新状态才退回「`state.pending` 压着别的对象就拒绝」的对象身份判定（生产路径 `recordTurnEnd` 必写 `seq`，这一档只由手工构造命中）。`requeuePendingRecap`（撞忙回队）同样复用 `ownsPending`：**放回不是结算**（不记进已结算账本、不改 `attempts`/`seq`，所以重试路径不会被误拒），但不归自己时一个字段都不动、返回 `rejected:true` 并写 warn——否则迟到的那份会把 await 窗口里新挂上的待办静默覆盖掉，两份待办的额度一起蒸发、而新待办那一轮的冷却已经白吃；耗尽分支同理，只清自己那一份。两条回滚路径还**共用同一本已结算账本**（`SETTLED_PENDINGS`，WeakSet 按对象身份记账）：同一份待办被任一路径结算过后，另一条路径再结算一律返回 false、不改任何字段并写 warn——否则交叉调用会把同一批 mutating 计数还两遍（实测 3→6→9）；`requeuePendingRecap` 不许记进这本账。第 7 轮（F1「在飞旧待办额度蒸发」）又补一层：`ownsPending` 判「不归我」时不再一律丢弃——**在飞**的旧待办（被 `takePendingRecap` 摘走、尚未结算）若计数没被 `recordTurnEnd` 合并进更新的待办，就由 `adoptOrphanPending` **过继**给当前状态（队列里那份新待办的 `mutCount` 上，且 `abandonPendingRecap` 这一路把 `prevLastRecapTurn` 退到两者**更早**者；队列已空则加回 `st.mutCount` 但**不动** `lastRecapTurn`，冷却留给那份在飞待办自己结算，避免退两遍），并写一条 warn 留痕。三本模块级 WeakSet 守幂等：`SETTLED_PENDINGS`（已结算，abandon/restore 共用）、`ABSORBED_PENDINGS`（已被合并吸收，**绝不许**再过继，否则同一批计数翻倍）、`ADOPTED_PENDINGS`（已过继一次，重复被拒不再搬）。`clampMutCount` 把负数/垃圾计数按 0 处理（H1）；`logInfo`/`logWarn` 用 `typeof` + try/catch 兜住畸形 logger（H2，这些日志全在竞态回滚路径上，日志炸掉会把「额度还没还回去」变成「整个空闲边沿抛异常」） |
| `lib/recap.js` | 自动复盘调度器（`createRecapController`）：回合内只记账挂待办，`agent/status` 报 idle 的空闲边沿才真正执行；撞上宿主忙碌则放回队列重试（上限 3 次）；`runRecap` 返回 `{skipped:true}`（没材料、未调 LLM）时把冷却与计数还回去、不推失败提示；撞忙回队被拒（队列里是更新的待办）时**不再静默**——写一条 warn 说清「这一轮没跑成、额度已按过继规则记账」，因为改动前那里直接 return，事后看日志会以为这轮复盘从没被触发过；纯逻辑，可独立测试。**只有 `isMainAgent` 一道门**——「有子代理在跑就不记账」那道门已删（子代理是 resident，settle 才注销，真实用法里几乎每轮都命中，见 DESIGN.md「自动复盘为什么改成喂真轨迹 + 为什么拆掉子代理门」） |
| `lib/trajectory.js` | 把宿主 `session.deriveMessages()` 的模型可见历史渲染成给复盘模型看的紧凑轨迹（`renderTrajectory` 纯渲染 + `collectTurnTrajectory` 取用 + `buildRecapSummary` 拼 summary）；`maxMessages` 只取尾部，`maxChars` 超了**首尾都保留**（开头 `min(maxHeadChars, maxChars/2)` 保证任务目标不丢 + 中间 `…（中间 N 字符已省略）` + 结尾吃剩余预算，总长 ≤ `maxChars`），tool 结果行带工具名（`结果(read): …`，靠同一次渲染内的 tool-call id 映射反查）；`maxChars` 小到放不下尾部时退化成「开头 + 省略标记」（标记里的 N 恒等于真实丢弃数，连标记都放不下时返回空串）；`buildRecapSummary` 保证**整条 summary**（含两行标题）也 ≤ `maxChars`（**唯一例外**：`maxChars` 小于计数行本身的长度时以保证计数行完整为准，返回整行、允许超出——生产路径不传 `maxChars`，线上不可达），畸形输入一律跳过不抛错。**零 import（连 node 内置都不 import）、不碰宿主包、不读盘**，可独立测试 |
| `lib/notice.js` | 通知消息构造（`textBlocks`/`noticeMessage`）：把文案包成宿主契约要求的 `ContentBlock[]`。**零 import、不读盘**（与 lib/trajectory.js 同一条红线）——宿主 `createUserMessage` 不校验 `content` 形状，裸字符串进了会话历史会让宿主 52 处 `.content.some` 抛 `TypeError`、整个会话永久坏死（I10；tests/notice.test.mjs 的 T226/T227/T228 守着） |
| `lib/prompts.js` | Reflector/Curator 提示词与 LLM JSON 提取 |
| `lib/llm.js` | 模型路由解析与单次 LLM 调用 |
| `lib/playbook-path.js` | 手册文件位置解析（绝对路径 / `~` 展开 / 相对工作目录 / 空串=本机共享层 `<DSH home>/ace/playbook.md`；纯逻辑，可独立测试） |
| `lib/settings-path.js` | 设置文件位置解析（profileContext → DSH_PROFILE_DIR → DSH_HOME → ~/.dsh）与旧文件一次性迁移（纯逻辑，可独立测试） |
| `lib/entries.js` | 手册条目清单（`GET /api/dsh-ace/entries` 的数据源）：复用 `parsePlaybook` 把解析结果摊平成固定形状的记录；**只读**，不写盘不加锁（纯逻辑 + 只读 IO，可独立测试） |
| `tests/playbook.test.mjs` | 持久化层单元测试（node --test） |
| `tests/concurrency.test.mjs` | 真实子进程并发用例（两个 node 子进程同时操作同一本手册，跑 lib/commit.js 的生产同款路径；脚本写在系统临时目录，用完即删） |
| `tests/playbook-path.test.mjs` | 手册路径解析链的单元测试（node --test） |
| `tests/settings-path.test.mjs` | 设置路径解析与迁移的单元测试（node --test） |
| `tests/entries.test.mjs` | 条目清单的单元测试 + `GET /api/dsh-ace/entries` 的 HTTP 面契约（行为面跑分支调用的函数，源码级钉住围栏/405/降级） |
| `tests/trajectory.test.mjs` | 轨迹渲染器的单元测试（渲染顺序/角色前缀、system·developer·reasoning 跳过、tool-call 与 [失败] 结果、image·file 占位、maxMessages 尾部截断、maxChars 首尾保留（含「任务目标仍在」与 maxChars=200 极端值）、tool 结果按 id 绑定工具名与跨调用不串味、退化分支的省略数等于真实丢弃数、整条 summary ≤ maxChars、畸形输入不抛错），外加源码级断言：零 import、`runRecap` 确实喂轨迹且轨迹为空不调 LLM（返回 `{skipped:true}`）、`listAgents`/`inject 'agents'` 无残留 |

## 命令

```
npm test        # node --test tests/
node --check lib/index.js   # 语法检查（其余 js 同法）
```

## 红线（改动前必读，完整依据见 DESIGN.md「非功能红线」）

1. 手册只能增量演化（增/改/删单条），不存在也不许加「整本重写」的代码路径或提示词；
2. 手册写入必须走 `withLock` + `writeFileAtomic`，不许绕开直接 `fs.writeFile` 手册文件；
3. LLM 输出必须经 `extractJsonObject` 结构化校验后才能落盘，原始文本不直接进手册；
4. 引用 DSH API 必须注明 checkout 出处（文件:行号），不许凭空捏造；
5. 不引入新的 npm 运行时依赖（宿主服务一律走 `inject` 声明；反过来说，**不再用到的服务必须从 `inject` 里删掉**——拆掉子代理门之后本插件不再读 `ctx.agents`，`'agents'` 已从 `inject` 移除）；
6. `lib/trajectory.js` 必须保持零 import（连 `node:fs` 都不许）：宿主包在 `node --test` 里加载不到，本仓库无 `node_modules`；纯函数、无副作用、不读盘。tests/trajectory.test.mjs 有源码级用例守着这条。**`lib/notice.js` 同受这条约束**（零 import、不读盘），由 tests/notice.test.mjs 的 T226 守着。