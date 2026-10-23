---
title: dsh-ace 设计文档
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-21
---

# 设计

## 职责与边界

**结论：dsh-ace 只负责「手册的读、盘、并」三件事，不负责任务执行本身，也不做任何检索/向量化。**

- 管：手册文件生命周期（不存在则初始化）、条目结构与 id 分配、增量操作的事务校验、并发与原子写、Reflector/Curator 的 LLM 调用与提示词、agent 何时复盘的系统提示。
- 不管：手册内容的质量判断（交给 LLM 与人）、手册的自动调度（何时复盘由 agent 按系统提示自行判断）。
- 手册**位置**由配置决定（见下节「手册文件位置：默认本机共享层」）：默认一本手册跨工作区共用；填相对路径则退化为该工作区私有一本。
- 不管：**两层手册的自动合并读**（共享层 + 项目私有层同时读）。理由是硬约束而非偏好：`nextId` 是单本内「现存最大编号与历史高水位的较大者 +1」（lib/playbook.js 的 `nextId`/`maxEntryIdNumber`），合并视图里会撞号；`maxEntries` 容量会被两层一起吃满；curate 的落点是单值，刚写进共享层的条目下次合并读可能读不到。**任何时刻只有一本手册被读写。**

## 依赖关系

**结论：运行时只依赖宿主注入的服务与两个宿主包，零第三方运行时依赖。**

| 依赖 | 用途 | 来源 |
| --- | --- | --- |
| `ctx.tools` | 注册三个模型可见工具 | 宿主服务（inject 声明） |
| `ctx.systemPrompt` | 注册「何时复盘」提示段 | 宿主服务（inject 声明） |
| `ctx.llm` | Reflector/Curator 的单次 LLM 调用 | 宿主服务（inject 声明） |
| `ctx.workingDirectory` | 相对手册路径 → 会话工作目录（只有相对路径这一形态需要它；绝对路径与共享层不需要会话上下文） | 宿主服务（inject 声明） |
| `@deepseek-ai/schemastery` | Config schema（cordis 以 `~standard.vendor` 识别） | 宿主提供的 peer 依赖 |
| `@deepseek-ai/dsh-tools` | `defineTool` 构造工具定义 | 宿主提供的 peer 依赖 |

Node 内置模块仅 `node:fs`、`node:fs/promises`、`node:path`、`node:os`、`node:crypto`。与已验证模板 dsh-raw-html-v2 同构：`package.json` 以 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者一行 `insert` 把入口挂进 cordis 层（行 id 必须等于入口导出的 `name`）。

## 核心数据模型

**结论：一切围绕一个 Markdown 文件和三种纯数据形态；LLM 产出只在结构化校验后进入模型。**

| 形态 | 对象 | 说明 |
| --- | --- | --- |
| 生命周期型 | `PlaybookEntry` | 条目（id/title/condition/action/rationale/meta/extraLines），随 curate 演化 |
| 句柄型 | 手册文件路径 | 唯一持久化句柄；由 `playbookPath` 经 `lib/playbook-path.js` 解析：绝对路径（含 `~` 前缀）原样用、相对路径经会话工作目录 join（工作区私有）、空串/缺省 = `<DSH home>/ace/playbook.md`（本机共享） |
| 不可变值 | `ops`（curate 入参） | 操作批：进入 `applyOps` 后先整批校验再应用，校验期间不改副本 |
| 受控操作 | `withExclusiveLock` / `writeFileAtomic` | 手册文件只经这两个受控入口变更；`withExclusiveLock` = `withLock`（同进程 per-path 串行）→ `withFileLock`（跨进程 `<file>.lock`），锁覆盖整个「读-改-写」区间；`writeFileAtomic` 内部再进 `withFileLock` 时按重入处理（不重复加锁）；跨进程锁不抢占活着的持锁者（I5b） |

条目落盘格式与解析规则见 README「首次使用」；条目内人手写的无法识别行挂在 `extraLines` 原样保留。

### 不变量

- I1 不存在把手册整本替换为新文本的代码路径或提示词指令——演化只经 add/update/remove；
- I2 条目 id 在同一手册内唯一且**单调不复用**：新 id 恒为「现存最大编号与历史高水位的较大者 +1」。历史高水位记在手册文档头的一行 HTML 注释里（`<!-- ace:id-highwater: N -->`，`readIdHighWater`/`ensureIdHighWater`/`applyIdHighWater`，lib/playbook.js），因此**删掉最高编号的条目后再新增，编号不会重用那个号**（`applyOps` 接受 `highWater` 入参，分配后把新高水位写回文档头）。**唯一的例外**：人同时删掉最高编号的条目**和**文档头的高水位标记时，历史最大值无法从文件本身恢复，该编号可能被**复用一次**（随后标记被重写为当前最大编号，也就是刚被复用的那个号，因此只会复用这一次）——这是已知限制，不靠猜补。标记行写回前会被全文清干净、只在文档头的规范位置留一份（幂等，绝不出现两份）；解析时标记行即使被挪进条目正文也会被摘出来归位，不会被当作条目正文。人手编辑插入高编号条目后，下一个新增仍大于它（编号取现存条目的最大值）。**适用前提：一本手册一份编号空间**——共享层与工作区私有层并存时，各自独立编号，`ace-001` 在两层里可能指向不同条目（这也是不做两层合并读的原因之一，见「职责与边界」）；
- I3 `applyOps` 是事务式的：任一操作校验失败则整批拒绝，条目数组保持不变。**注意两类拒绝的粒度不同**：**校验类**（id 不存在 / op 非法 / 超出 `maxEntries`）是整批拒绝、抛错，安全项一起丢（既有语义，不改）；**并发冲突类**（`update`/`remove` 的目标被改被删、`add` 与自快照以来出现过的条目重复）才是**逐条**判定——只有冲突的那几条被拦下，同批安全改动照常落盘（见 I5c）；
- I4 手册条目数不得超过 `maxEntries`，违反即整批拒绝并在错误信息里给出可合并的旧条目；
- I5 同一路径上的手册「读-改-写」串行执行，**同进程与跨进程都成立**：`withExclusiveLock`（lib/playbook.js:695）= `withLock`（per-path Promise 链，进程内，不同路径互不阻塞）→ `withFileLock`（跨进程 `<file>.lock`，`O_EXCL` 创建、内含 pid + 时间戳 + nonce、抢不到带退避重试）。**两层锁都有重入保护**：`withLock` 与 `withFileLock` 各用一套 AsyncLocalStorage 记录「本次调用链已持有的锁」，同一路径上再取一次锁直接执行（否则嵌套 `withExclusiveLock(file)` 会自死锁）；不同路径仍各走各的链，互不阻塞。**锁的持有期覆盖整个读-改-写区间**（读手册 → 算新条目 → 落盘都在锁内）；区间内的 `writeFileAtomic` 靠 AsyncLocalStorage 识别为重入，不会自死锁；rename 的原子性仍保证文件不会写坏。**锁区间内只允许纯计算——任何 LLM/网络调用必须在锁外**（`ace_curate` 的 Curator 提案在锁外生成，锁内只重新读最新手册、查冲突、校验、落盘）。跨进程锁的回收语义见下一条 I5b：
- I5b 跨进程锁**永不抢占活着的持锁者**：`withFileLock`（lib/playbook.js:608）读到锁内容里的有效 pid 且该进程仍存活（`process.kill(pid, 0)` 不抛错）时一律等待，最多重等到 `LOCK_TIMEOUT_MS`（30s）后抛错——**失败而不是丢写**。可回收的只有两种锁：① 持锁进程已死（`ESRCH`）；② 锁内容读不出有效 pid（损坏/写到一半）且 mtime 已远超 `LOCK_STALE_MS`（10s）。回收权靠 `rename` 取得（`<file>.lock` → `<file>.lock.stale-<随机>`，拿到名字的那方才删），因此不会误删新主人的锁；`finally` 只删**自己那把**锁（核对 payload 里的 nonce，不符就不删）。误抢到活锁时靠 `restoreLock` 把它原样放回：优先 `link` + `unlink`，**任何 `link` 失败（含 Windows 跨卷的 ENOENT）都走「位置未被占住才放回」的兜底**（`open(lockPath, 'wx')` 独占创建，抢不到就说明位置已被新主人占住，绝不覆盖）。**这条取代了旧语义**（旧实现用「时间超期」判陈旧并直接 `rm`），旧语义在共享一本手册时必然丢写：慢 LLM 调用超过 10s 后活锁被抢，先落地的那份写被覆盖，且原持锁者退出时会把新主人的锁删掉，导致临界区重叠。**多实例共享同一本手册时仍可能出现「后写者覆盖先写者」**——I5 只保证「读-改-写区间不重叠」，跨实例的语义冲突由 `detectAllConflicts`（lib/merge.js，逐条判定，见 I5c）挑出并由调用方回报给用户解决，不靠抢锁解决；
- I5c **并发语义冲突按条判定，不整批一票否决**：锁内重读最新手册后，`detectAllConflicts`（lib/merge.js）把待写入的 ops 逐条判定，只有**真正冲突的那几条**被拦下，同批其余安全改动照常落盘（`commitOps`，lib/commit.js）。判据分两类：
  - `update`/`remove`：目标条目在快照之后被删 / 被改 / 是新出现的（`detectConflicts`，lib/playbook.js）；
  - `add`：与「自快照以来**新出现或被改名**的条目」构成重复 —— 完全重复用 `applyOps` 同一套 `normKey` 口径、同标题不同正文用 `normTitle`、近似重复用 `computeMergeSuggestions` 的 BM25 比率（`MERGE_THRESHOLD_RATIO=0.5`）。判定范围是「自快照以来出现过该标题/该正文的条目」：`latest` 里 id 不在快照中的（复盘期间新出现的），以及同一 id 在快照里存在但**标题被改过**的（并发改名 → 新标题自快照以来出现过，否则磁盘上会留下两条同标题）。**不回头拦「快照里一直存在且未被改名」的同标题条目**：那是 Curator 去重的既有职责（`applyOps` 的 seen 集合 + LLM 去重），不在冲突层重复拦，避免把正常流程拦死。
  - 近似重复的 BM25 层**只比正文**（`condition`/`action`/`rationale`，不含 `title`——同标题由上面那层负责）：标题进 BM25 会把「同领域不同经验」误判成重复（《配置里缺少超时时间》与《配置里缺少重试次数》就是这么被拦下的）。比率是**对称**的：`ratio = min(score(a→b)/selfScore(a), score(b→a)/selfScore(b))`，并钳到 1（单向比率 `score/selfScore` 没有上界，实测能到 1.627，渲染出来是「高度相似（163%）」——相似度百分比不可能大于 100%）。阈值仍是 0.5。`scoreEntries`（lib/playbook.js）本身不改：它同时是 `ace_playbook` 的检索打分，改了会影响检索语义；正文投影只发生在 merge.js 内。
  依赖方向是单向的：lib/playbook.js（基础层）← lib/merge.js（相似度层）← lib/commit.js（提交编排）← lib/index.js（宿主接入层），**playbook.js 不 import merge.js**（否则形成循环 import）。
- I5d **冲突必须让用户看见**：会写手册的三条写入路径（`ace_curate` 工具、自动复盘、`/ace` 命令的**默认复盘分支**）都把被拦下的条目以人话回报——`ace_curate` 落在工具输出的 `conflicts` 字段（每项 `{op,id,title,reason}`）并在 render 里点出「N 条没并入，重试即可」；自动复盘与 `/ace` 默认复盘分支都用 `sendNotice` 送出：`agent.followup` 优先（唤醒驱动，同文件 `:192`），宿主没有该方法时退回 `agent.inject`（排入下一轮上下文、不唤醒，同文件 `:209`）。**冲突不再只是 `logger.warn` 的一行日志**——只写日志等于本次沉淀的经验静默蒸发。
- I6 手册文件对读者原子可见：只可能是完整旧版或完整新版（临时文件 + rename），不存在半截状态；
- I7 人手编辑的批注行不因机器写入而丢失（extraLines 往返保真）；
- I8 LLM 原始输出不得直接写入手册：必须经 `extractJsonObject` 解析且字段类型校验通过；
- **I9 自动复盘的触发点必须在宿主允许维护任务的位置（idle 相位），不能在回合内。** 宿主的维护任务 API 有硬守卫：`agent.runMaintenance` 只在 `phase.kind === 'idle'` 时合法，否则**同步**抛「agent already has active work」（宿主出处：`~\@deepseek-ai\dsh-agent-loop\lib\index.js:823`；类型契约同款说明见 `~\dsh-agent\lib\types\runtime-types.d.ts:174`「turn-driving 或另一个维护任务占用时同步抛错」）。而 `agent/turn-stopping` 是在 `turn()` **内部**派发的，`turn()` 开头断言 phase 是 running（同文件 `:939`）——**回合内跑维护必然抛错**，这正是自动复盘此前从未落盘的原因（共享手册里 `auto=true` 条目数为 0 与该推断一致）。因此自动复盘拆成两段：
  - **回合内（`agent/turn-stopping`）只记账与判定**：更新该 agent 的 mutating 计数与当前回合号，按 `shouldTriggerAutoRecap`（lib/trigger.js）判定；命中则把复盘请求**挂成待办**（记下本回合号与本回合 mutating 次数），**不调 runMaintenance、不调 LLM**；
  - **空闲边沿（`agent/status` 报 idle）才真正执行**：取出待办，先 `await agent.whenIdle()`（契约 `~\dsh-agent\lib\types\runtime-types.d.ts:164`，实现 `~\@deepseek-ai\dsh-agent-loop\lib\index.js:870-875`）再调 `agent.runMaintenance(job)`。空闲边的由来：宿主 `kick()` 的 finally 把 phase 置回 idle（同文件 `:887-901`），`setPhase` 先写 `this.phase` 再 emit `agent/status`（同文件 `:794-799`），因此 idle 监听里宿主已是 idle 相位；`agent/status` 载荷为 `{agent, status}`（`~\dsh-agent\lib\types\runtime-types.d.ts:252-255`，agent 由 fused 注入 `~\dsh-agent\lib\types\dispatch.js:42`）。宿主里用 `agent/status` 做收尾工作的参考实现：`~\dsh-goal-round-driver\lib\index.js:223-242`、`~\dsh-compaction-basic\lib\index.js:853-855`；
  - **竞态退避**：idle 边沿之后宿主可能立刻被新的唤醒请求拉起新一轮（同文件 `:898`），所以执行前必须先等空闲；仍撞上「already has active work」则把待办**放回队列**，等下一个 idle 边沿再试，重试上限 3 次（`MAX_RECAP_ATTEMPTS`，lib/trigger.js）。这类预期内竞态**只写日志不推用户提示**（不刷屏）；其它真实失败（LLM 调用失败、手册写入失败等）才给用户推一条「ACE 自动复盘未完成」提示，并把本回合的 mutating 计数还回状态（**只还计数、不回滚冷却**：失败说明确实尝试过；且只还「仍属于这次的那一份」——这段 await 窗口里若已有更新的待办，旧额度不还回**状态**，而是过继给那份更新的待办，见下文「在飞待办与更新的待办相撞」段）。
  - 判定、取出待办、竞态重试计数、以及两条回滚路径（`abandonPendingRecap` / `restorePendingMutCount`）都是 lib/trigger.js 里的纯函数（另有 `recordTurnEnd` / `takePendingRecap` / `requeuePendingRecap` / `isBusyError`），调度器在 lib/recap.js，状态显式挂在 `stateFor(agent)` 上、不藏闭包隐式变量，便于单测直接断言。
  - **在飞待办与更新的待办相撞（第 7 轮 F1）**：`takePendingRecap`（lib/trigger.js）把 `state.pending` 摘成 `null` 之后，**状态里就没有任何地方还记得「有一份待办正在执行中」**。于是 `await agent.whenIdle()` / `await runRecap()` 的秒级窗口里宿主完全可能结束若干个回合并干出新的活，`recordTurnEnd` 看不到在飞的那份、挂出一份更新的待办并把 `pendingSeq` 推到下一代。等那份在飞的旧待办跑完（`{skipped:true}` 或撞忙），迟到的 `abandonPendingRecap` / `restorePendingMutCount` / `requeuePendingRecap` 会被 `ownsPending` 按代次判「不归我」——第 6 轮为保证「同一批计数不许算两遍」而定的规则，此时却把**旧待办那几轮确实干过的 mutating 计数永久蒸发掉**（既不进新待办、也不还回状态）。额度是下一轮判定该不该复盘的唯一依据，蒸发等于让后面明明干了活的回合被阈值挡下，经验顺延甚至吞掉。修法是**过继**（`adoptOrphanPending`）：
    - **为什么过继而不是「拒绝就算了」**：拒绝的初衷只是防重复计入，不是主张「这笔额度本来就不该存在」。要同时满足「不蒸发」与「不翻倍」，就必须先分清旧待办属于哪一类：已被 `recordTurnEnd` **合并吸收**的（计数此刻正躺在更新的待办里，记进模块级 `ABSORBED_PENDINGS`）一律不再过继，一个字段都不动；**在飞、未被吸收**的才搬，搬过一次就记进 `ADOPTED_PENDINGS`，同一份待办第二次被拒不再搬。两本 WeakSet 加上原本的 `SETTLED_PENDINGS`（已结算）共同构成幂等护栏——少了任何一本，实测额度会 5→8 凭空翻倍。**记账必须发生在搬移之后**（`ADOPTED_PENDINGS.add(pending)` 排在 `st.pending.mutCount = before + moved` 的后面，队列已空那一路同理）：搬移要写队列里那份待办的字段，它被冻结或 `mutCount` 是只读 getter 时会抛错，此时账本若已经记上，额度一次都没搬成、这份待办却被永久封账——既搬不动也再不重试，额度永久蒸发（H3，tests/trigger.test.mjs 的 T230 守着）。另外**结算与过继一律走 `clampMutCount`**（只收正有限值，其余按 0）：`Number(...)` 只挡 `NaN`/`Infinity`，`pending.mutCount = -4` 配 `st.mutCount = 10` 会被原样收下、把状态往回拽成 6（H4，T231 守着）。
    - **为什么冷却只过继给队列里那份**：`abandonPendingRecap` 这一路除了还计数，还要把 `pending.prevLastRecapTurn` 一并过继，取两者中**更早**的那个（`earlierTurn`）。理由与 `recordTurnEnd` 的合并不变量完全相同：两次推进都没执行，放弃时就该还回到最早那次推进之前，否则中间那几回合的冷却被白吃。但这条只对**队列里还没被取走的那份新待办**成立——它才是下一次真正要执行的一份，把冷却基准退在它身上才生效；早已被取走的那份的 `prevLastRecapTurn` 已经没人会读了。
    - **为什么 `state.pending` 为空时不动 `lastRecapTurn`**：队列空意味着更新的那份也被另一个空闲边沿取走了，它自己会按自己的 `prevLastRecapTurn` 结算冷却（成功就保留推进、skipped 就自己退回原值）。此时如果这条迟到的旧路径也去倒退 `lastRecapTurn`，同一笔冷却就被退了两次，冷却期被白白多让出一轮——那会让阈值判定提前触发，反过来把「该复盘」变成「刚复盘过」。所以这一路只把 `mutCount` 加回状态，`lastRecapTurn` 一个字都不动。
    - **为什么已被吸收的那份不许再过继**：`recordTurnEnd` 合并时已经把旧待办的 `mutCount` 加进了新待办，旧待办那笔账此刻就躺在 `state.pending.mutCount` 里。如果迟到的回滚只看「它不归我、计数没还回状态」就过继，同一批计数会被加第二遍（实测 3+3=6 之后再 6+3=9）。这是第 6 轮那条不变量（合并吸收后三路径一律被拒、一个字段都不动）的硬约束，第 7 轮的过继必须让路给它。

- I10 **送给宿主的每一条消息，`content` 必须是 `ContentBlock[]`**（契约 `MessageBase.content: readonly ContentBlock[]`，`~\@deepseek-ai\dsh-llm\lib\types\message.d.ts:128`；文本块形状 `{ type: 'text', text: string }`，同包 `lib/types/types.d.ts:46`）。宿主 `createUserMessage` **不做形状校验**——`~\@deepseek-ai\dsh-llm\lib\types\message.js:34-39` 的 `createMessage` 只做 `deepFreeze(structuredClone({...input, id}))`、`:53-58` 的 `createUserMessage` 只补一个 `role`，所以裸字符串会被原样收进会话历史。后果不是「这条消息显示得不对」，而是**整个会话永久坏死**：宿主里 52 处 `.content.some(...)` 拿它当数组调用会抛 `TypeError: message.content.some is not a function`，而每一轮重建上下文都要遍历历史，撞上这条毒消息就再也开不起来（用户再发「继续」照样失败）。本插件的三处通知注入点（`conflictMessage`、自动复盘失败通知 `notifyFailure`、`/ace review`）统一经 lib/notice.js 的 `textBlocks`/`noticeMessage` 构造数组；该模块**零 import、不读盘**（与 lib/trajectory.js 同一条红线），因为它必须能在没有 `node_modules` 的 `node --test` 里被直接 import 断言。回归防线是源码级的：tests/notice.test.mjs 的 T227 扫 lib/index.js 全文、T228 自证检查器本身不是假绿——将来谁再写回 `content: text` 这种裸字符串，测试当场红。

## 自动复盘为什么改成喂真轨迹 + 为什么拆掉子代理门

**结论：I9 只解决了「复盘在什么时机跑」，没解决「跑起来有没有料」和「跑不跑得起来」。两道门一起堵死了自动复盘，实测产出条目恒为 0。两处都已修，且两处都留了可机检的痕迹。**

### 门一：喂料只有一句计数，Reflector 必然返回 0 候选（决定性根因）

旧实现把这句话当作给复盘模型的**唯一**「轨迹」：

```js
summary: '自动复盘：本回合有 ' + pending.mutCount + ' 次 mutating 工具调用。'
```

它经 `executeRecap` 原样塞进 `reflectorUserInput({ summary, outcome: '', playbookDigest })`（lib/prompts.js 的 `reflectorUserInput`，user 文本只有「当前手册摘要 / 本次任务 / 摘要·轨迹要点」三段），于是模型看到的「轨迹」就是一串数字。

实测证据（同一套 Reflector、同一个提示词，只换输入）：喂「本回合有 12 次 mutating 工具调用」→ `candidates: []`，notes 原文是**「本回合轨迹只给出「12 次 mutating 工具调用」这一计数，没有任务目标、工具序列或错误细节，无法据此提炼可泛化经验，宁缺毋滥。」**；喂一个真实任务的完整轨迹 → 6 条候选。**也就是说，即使触发时机全对，这条路也必然 0 条**——不是模型不行，是输入里没有任何可提炼的东西。

修法（lib/trajectory.js + lib/index.js 的 `runRecap`）：

- 新增纯模块 `lib/trajectory.js`：把宿主的**模型可见历史**渲染成紧凑轨迹文本。数据源是 `agent.session.deriveMessages()`（宿主出处：`~\@deepseek-ai\dsh-session\lib\index.js:1655-1684` 返回一份新的消息快照、消息对象共享且深冻结；类型 `~\dsh-session\lib\types\index.d.ts:347`）。`Message` 联合与 `ContentBlock` 见 `~\dsh-llm\lib\types\message.d.ts:120-174` 与 `~\dsh-llm\lib\types\types.d.ts:45-126`。
- 渲染规则：`system`/`developer` 整条跳过（系统提示与工具清单对复盘无意义且极长）；`user` → `用户: …`；`assistant` → `助手: …` 且每个 `tool-call` 块单独一行 `  → 工具名(参数)`；`reasoning` 跳过（思维链不该进复盘输入，也最占体量）；`tool` → `结果(工具名): …`（`isError === true` 时前缀 `[失败] `，即 `[失败] 结果(read): …`）；`image`/`file` → `[图片]`/`[文件]` 占位；未知块类型直接忽略。
- **tool 结果行为什么要带工具名**：`tool` 消息自身只带 `toolCallId`（`~\dsh-llm\lib\types\message.d.ts:157`），没有工具名；只写 `结果: …` 的话，并行调用或多连调用时 Reflector 只能靠位置猜「哪条结果属于哪个工具」，一猜错，它提炼出的「某工具这样做会失败」就是错的。所以 `renderTrajectory` 在同一次渲染内维护一张 `tool-call id → 工具名` 映射（渲染 assistant 的 tool-call 时登记，渲染 tool 消息时反查），查不到（未知 id、没有 id）就退回 `结果: `。这张映射**每次调用各自新建**、绝不挂模块级变量——否则两次渲染之间会串味，把上一次的工具名安到这一次的结果上。
- 体量控制全部可覆盖且有默认值：`maxMessages` 60（**只取尾部**，真实会话可能几千条）、`maxChars` 12000、`maxHeadChars` 3000（超限时留给开头的预算）、`maxTextChars` 500、`maxArgChars` 300、`maxToolResultChars` 400。
- **超限时首尾都保留，不是只留尾部**：`text.length > maxChars` 时，开头保留 `min(maxHeadChars, floor(maxChars / 2))` 个字符，中间插一行 `…（中间 N 字符已省略）`（N = 总长 − 头长 − 尾长），结尾保留剩余预算（`maxChars` − 头长 − 40 个字符的标记预留量），最终长度 ≤ `maxChars`；切点落在代理对中间会前后挪一位，避免切出半个字符。`maxChars` 小到放不下尾部时退化成「开头 + 省略标记」，不抛错；这种退化形状里 N 同样恒等于**真实被丢弃的字符数**（先定最终开头长度、再拿它算 N——反过来先算 N 再削开头，标记就会谎报丢弃量），标记自己都放不下时返回空 `text`、让调用方按「没材料」处理，绝不吐半截标记或垃圾串。**为什么必须保开头**：任务目标写在第一条 `user` 消息里，而单块上限（`maxTextChars` 500 / `maxToolResultChars` 400）乘上条数很容易撑爆总上限——硬截尾等于把「这次到底要干什么」整段丢掉，而让 Reflector 看到任务目标正是这次修复的目的。实测反例：1 条 user 目标 + 25×(480 字 assistant + 390 字 tool 结果) + 1 次失败，渲染 12018 字符 > 12000，旧实现输出首行变成 `…（前面 11106 字符已省略）`，任务目标整段消失。
- 防御式到底：`messages` 非数组、消息为 `null`、`content` 非数组、块字段类型不对——一律跳过而不是抛错；`deriveMessages` 的取用包在 `typeof` 判定 + `try/catch` 里（宿主 API 变动不许把复盘搞崩），拿不到或抛错就退回原来那句计数文案。
- **轨迹为空就不调 LLM**：没有材料可提炼，调了必然 0 条，白花一次调用与 token。此时 `runRecap` 返回 `{skipped: true}` 并只写一条 `logger.info` 说明跳过。summary 形状：首行仍是那句计数，空行，然后 `## 本回合轨迹（最近 K 条消息）`，然后轨迹正文（K 用 `renderTrajectory` 返回的 `messageCount`）。**总长口径是「整条 summary ≤ `maxChars`（默认 12000）」**：轨迹本身已按 `maxChars` 渲染，再加这两行标题就会到 12030 这种越界长度，所以 `buildRecapSummary` 把标题行的长度从轨迹预算里扣掉、按剩余预算再把轨迹裁一次（同样是首尾都保留，开头任务目标照旧保住）；调用方要更紧的总预算可以显式传 `maxChars`。**唯一例外（口径写清，别再说成无条件成立）**：计数行本身就是 28 个字符（`自动复盘：本回合有 N 次 mutating 工具调用。`，N 为一位数时；两位数 29 个字符），当 `maxChars` 小于计数行长度时，返回值**恰为完整计数行**、长度会超过 `maxChars` —— 这时以保证计数行完整为准，因为截断后的 summary（半句「自动复盘：本回合有…」）对 Reflector 毫无意义，还不如明确告诉它「这一轮只给得出计数」。生产路径（lib/index.js 的 `runRecap`）不传 `maxChars`、走默认 12000，所以线上不会碰到这个例外；边界由 tests/trajectory.test.mjs 的 T198 钉住。`executeRecap` 与 `reflectorUserInput` 的签名都没动，只换喂进去的内容。
- **空轨迹跳过不吃冷却与计数**：`recordTurnEnd` 挂待办时就已经写了 `lastRecapTurn` 并清零 `mutCount`，`takePendingRecap` 也已经把待办摘走。若「没喂成料」就这么算了，这次跳过会白白吃掉一个冷却窗口与这一轮的 mutating 计数——下一轮明明干了活，却被 cooldown 挡下，经验被顺延甚至被下一轮吞掉。所以 `runRecap` 用返回值区分「跳过」与「已执行」（`{skipped:true}` vs 其它任何返回值含 `undefined`），调度器见到 `skipped` 就调 `lib/trigger.js` 的 `abandonPendingRecap(state, pending)`：清空待办、把 `pending.mutCount` 加回 `state.mutCount`、把 `state.lastRecapTurn` 回滚成待办里记着的 `prevLastRecapTurn`（挂待办**之前**的值）。这不是失败，所以**不走** `notifyFailure`，只写一条 `logger.info`。
  这条回滚路径**必须自己认得住「是不是我那份待办」并且幂等**：调用点与 `takePendingRecap` 之间隔着 `await agent.whenIdle()` 与 `await runRecap()`，这段窗口里宿主完全可能又结束一回合并挂上**新的**待办——此时若照旧 `state.pending = null`，就会把新待办连同它的 mutating 计数一起吞掉，还会把 `lastRecapTurn` 从新回合**倒退**回旧值（静默丢经验 + 冷却倒退）。所以只要这份待办已经不归自己就一律拒绝回滚（**队列里的字段一个都不动**，那份更新的待办对象身份不变），但这份在飞旧待办的 `mutCount` 不许跟着蒸发——它由 `adoptOrphanPending` **过继**给当前状态：队列里还压着更新的待办就并进那份（冷却基准同时退到更早那次推进之前），队列已被另一个空闲边沿取空就还回 `state.mutCount`（冷却不回退，交给那份在飞待办自己结算）。同时写一条 `logger.warn` 说明「本次跳过未回滚，因为有更新的待办」并报出额度去了哪里；同一份待办第二次放弃也不再累加计数、不再动冷却，返回 `false`（否则额度会被重复还回去，凭空多出经验额度）。
  **「归不归我」按代次判，不按对象身份判**：`state.pending` 里还压着另一个对象只是其中一种情形。两个空闲边沿交错时，新待办可能**已被另一个边沿取走**（`state.pending` 又变回 `null`）——此时「`state.pending && state.pending !== pending`」为假，只比对象身份的旧护栏会把迟到的旧回滚当成「仍归我」错误接受，结果是旧回合的计数被重复计入（实测 `mutCount` 变成 3 而期望 1）、`lastRecapTurn` 从 7 倒退到 0，info 还谎报「回合 5 … 已还回」。所以 `createRecapState()` 带一个 `pendingSeq` 代次，`recordTurnEnd` 每挂一份新待办就 +1 并写进那份待办（`pending.seq`），所有权判定是内部私有函数 `ownsPending(st, pending)`：`Number(pending.seq) === Number(st.pendingSeq)` 才算归我；没有 `seq` 的旧形状待办（测试里手工构造的 `{turn, mutCount}`）要走**两档**兜底：`state.pendingSeq > 0`（代次前进过，说明之后一定挂过更新的待办）时**一律不认**；只有 `pendingSeq === 0` 的全新状态才退回「`state.pending` 压着别的对象就拒绝」的对象身份判定。**为什么补这一档**：队列恰好为空时（新待办已被另一个边沿取走）对象身份判定为真，迟到的旧回滚会被错误接受——实测 `state.pendingSeq = 5`、队列为空、传入 `{turn:1, mutCount:2, attempts:1, prevLastRecapTurn:0}` 时 `abandonPendingRecap` 返回 `true` 并把 `mutCount` 从 0 还成 2。生产路径 `recordTurnEnd` 必写 `seq`，这一档只由手工构造命中，但它决定「代次」这条判据是否真的闭环。
  同一套判定也被**失败分支**复用（`restorePendingMutCount(state, pending, logger)`，lib/trigger.js）：LLM 调用失败、手册写入失败时要把这回合的 `mutCount` 还回状态（下一轮还有机会再判定），但同样得先确认「这份待办仍归我」——否则 turn5 挂的 2 次会在 turn7 已经挂上新待办之后被加回来，`mutCount` 变 2（应为 0），下一轮凭虚高计数误触发。失败分支**只**还 `mutCount`、**不**回滚 `lastRecapTurn`：失败说明确实尝试过，冷却算已消耗，这是改动前就有的刻意行为。
  **撞忙回队（`requeuePendingRecap`）同样要过所有权判定，而且「放回」不等于「结算」**：它原来无条件 `state.pending = pending`，于是迟到的旧待办会把 await 窗口里新挂上的那份**静默覆盖**掉——实测回合 5 挂 p5(seq=1) 取走、回合 7 挂 p7(seq=2)，回队 p5 后 `state.pending` 变回 p5 而 `pendingSeq` 仍是 2，p7 对象被丢弃；此后 p5 无论走放弃还是失败分支都被 `ownsPending` 判「不归我」，p5 的 2 次与 p7 的 1 次额度**一起蒸发**，而 p7 那一轮的 `lastRecapTurn` 已经推进到 7（冷却白吃），日志却只写「待办已放回队列（第 1 次）」。耗尽分支（`attempts >= maxAttempts`）有同样的毛病：无条件 `state.pending = null` 会抹掉队列里那份新待办。所以两个分支都先过 `ownsPending`，不归自己就**队列里一个字段都不动**（那份更新的待办不许被覆盖、也不许被清空）、返回 `rejected: true` 并写 warn 说清「旧待办未放回队列，因为已有更新的待办」，耗尽分支也只在仍归自己时才清空队列。**「一个字段都不动」只指队列**：这份旧待办的 `mutCount` 会由 `adoptOrphanPending` 过继给当前状态（队列里有更新的待办就并进它，队列已空就还回 `st.mutCount`），否则旧回合的额度就跟着蒸发了。**但 `requeuePendingRecap` 不许把待办记进已结算账本**——放回是为了重试，记进账本会让下一次真正的放弃/失败回滚被误拒，额度反而永远还不回来。
  **「记账」这一步自己也会撞上队列里的旧待办**（`recordTurnEnd`，lib/trigger.js）：它与回滚路径相反，是**唯一会挂新待办**的地方，于是也会撞上「队列里还压着一份从没执行过的待办」。典型时序（生产默认 cooldown=2）：回合 5 干 3 次活挂 `p5` → 空闲边沿撞忙把 `p5` 放回队列（`attempts=1`）→ 回合 6 冷却未到（`6-5=1 < 2`）只记账 2 次，`p5` 仍在队列里等着 → 回合 7 触发。旧实现在最后一步无条件 `st.pendingSeq += 1` 加 `st.pending = {…}`，`p5` 连同那 3 次调用**静默蒸发**，而日志里一个字都没提（实测只有「回合5 记账 / 撞忙放回第1次 / 回合7 记账」三行）。所以这里改成**合并**而不是覆盖，四条不变量：
  1. **不许丢经验**：新待办的 `mutCount` = 队列里那份的 `mutCount` + 本回合计数（实测 3+2=5，旧实现只剩 2）。两笔都还没被复盘过，谁吞掉谁都是丢经验。
  2. **冷却语义要对**：新待办的 `prevLastRecapTurn` 取**旧待办的** `prevLastRecapTurn`，即最老那一笔的原值。推导：`lastRecapTurn` 的含义是「冷却从哪一回合起算」，每挂一次待办就把它推进到该回合；现在回合 5 与回合 7 的活合成一笔且都还没执行，一旦这笔被放弃，就等于这两次推进**都不该发生**，必须还回到最早那次推进**之前**的值。若还回到旧待办那一轮（5），回合 5→7 之间的冷却窗口就被白白吃掉（那几回合什么都没复盘）。实测还回 5 时 `lastRecapTurn` 从 7 退到 5、回合 5 立刻能再触发时被 `5-5=0 < 2` 挡掉；还回 0 才对。
  3. **`attempts` 语义要对**：新待办是**新的一笔**，`attempts` 从 0 重新计（旧待办被撞忙浪费掉的那次尝试不该算到新待办头上）；但这次丢弃必须**留痕**——`recordTurnEnd` 因此新增可选 `logger` 参数（lib/recap.js 的 `onTurnStopping` 调用点已接上），发生合并时写一条 info「回合 5 的待办还没执行，已合并进回合 7 的待办（累计 5 次 mutating 调用）」。不传 `logger` 的既有调用照旧不炸。
  4. **旧待办从此不可能再被结算**：`pendingSeq` 已经 +1 顶替，`ownsPending` 天然会拒掉迟到的 `abandonPendingRecap` / `restorePendingMutCount` / `requeuePendingRecap`（一律 false 或 `rejected:true`；队列里的字段确实一个都不动，但旧待办的 `mutCount` 会先被 `adoptOrphanPending` 过继给当前状态——额度不蒸发，也正因为过继只做一次，额度才不会翻倍）。这条必须钉住，否则合并一旦漏改代次，旧待办就能把**已经并进新待办的那 3 次**再还一遍，额度凭空翻倍。

  **两条回滚路径共用同一本已结算账本**：`lib/trigger.js` 里的 `SETTLED_PENDINGS` 是一个 `WeakSet`，按**对象身份**（不是按 `seq`）记账，只登记「已经被回滚结算过的待办对象」。`abandonPendingRecap`（跳过，还 `mutCount` **且**回滚 `lastRecapTurn`）与 `restorePendingMutCount`（失败，**只**还 `mutCount`、不回滚冷却）在真正动状态之前都先 `SETTLED_PENDINGS.add(pending)`；任一路径结算过之后，另一条路径再结算一律返回 `false`、不改任何字段，并写 warn「这份待办已经结算过了」。
  **为什么两条路径必须共用同一本账**：各自幂等并不够，交叉调用仍会把同一批 mutating 计数还两遍（实测同一份待办连调三次 `restorePendingMutCount` 返回 true/true/true、`mutCount` 3→6→9；先放弃再失败回滚同一对象也各加一次、3→6）。真实 `onStatus` 路径下同一待办只会进其中一条分支一次，所以线上不可达，但作为 API 契约这是漏洞，且与 `abandonPendingRecap` 已有的幂等不对称。两条路径回滚的东西不同（一条连冷却一起还、一条只还计数），却都直接改 `st.mutCount`——共用一本账是唯一能同时挡住「还重了」的地方；分成两本账则每条路径只能看见自己那一半的结算记录，交叉调用照样漏。
  **为什么 `requeuePendingRecap` 不许记进这本账**：撞忙回队是「放回队列等下一个空闲边沿」，**不是结算**——它既不还 `mutCount` 也不动 `lastRecapTurn`。若把回队也记进账本，同一份待办下一次真失败时的 `restorePendingMutCount` 会被误判成「已经结算过」而拒掉，那批 mutating 额度就此永远还不回来（tests/trigger.test.mjs「requeuePendingRecap 不是结算」那条用例钉住）。账本登记的条件是「这次调用真的把额度或冷却还回去了」，回队不满足。
- 红线：`lib/trajectory.js` **只 import 标准 JS、零宿主 import**（宿主包在 `node --test` 里加载不到，本仓库无 `node_modules`）；纯函数、无副作用、不读盘。tests/trajectory.test.mjs 有一条源码级用例直接断言「文件里没有任何 import / require」。

### 门二：有子代理在跑就不记账，真实用法里几乎每轮都命中

旧 `onTurnStopping` 有三道门：`isMainAgent` → `hasNoRunningSubagents`（用 `ctx.agents.list()` 排除自身后要求为空）→ `recordTurnEnd`。第三道门的前提是错的：子代理在宿主里是 **resident**，只有 settle 之后才从 `ctx.agents` 注册表注销（宿主出处：`~\@deepseek-ai\dsh-subagent\lib\index.js:1978-2046` 的 `finishDisposal`，注销那一行在 `:2034` 的 `resident.delete(childId)`）。真实用法里主代理几乎每轮都在派子代理，于是「有子代理在跑」几乎恒真 → **连记账都不发生**，待办永远挂不上，后面的复盘自然一次都没跑过。

修法：删掉这道门（lib/recap.js 的 `onTurnStopping` 只剩 `isMainAgent`），连带删掉 lib/trigger.js 的 `hasNoRunningSubagents`、lib/index.js 里 `listAgents` 的装配、以及 `inject` 里的 `'agents'`（不再读 `ctx.agents` 就不许声明它——见「For Agents」最后一条）。**保留的是**：`isMainAgent`（子代理自己不记账）与 cooldown/threshold 判定，二者与「有没有别的 agent 在跑」无关。

### 这两条修完之后仍未验证的部分

单元测试能钉住「喂料形状」与「门已拆除」，但钉不住「真机上真的落盘」：lib/index.js 是**服务半边**，在插件加载时被 import，改动要**重启宿主**才生效。详见 TESTING.md「未验证清单」第 11 条。

## 对外接口

**结论：模型可见三个工具，人可见一个配置对象；此外无任何对外面。**

| 接口 | 形态 | 要点 |
| --- | --- | --- |
| `ace_playbook` | 工具 | `id` 精确过滤；`query` 以片段（空白/标点拆分，汉字块 2-gram）为 term 对当前条目做 BM25 排序（k1=1.2, b=0.75；idf=log((N-df+0.5)/(df+0.5)+1)；tf 在条目四字段拼接文本上计，实现在 `matchEntries`/`querySegments`，lib/playbook.js）；命中条目按得分降序（同分保持原序），无有效片段或全 0 分时整本兜底；只读，`isConcurrencySafe` 为真。**首读即建文件**（手册不存在时建出带文档头的空手册）这一小段在写锁内完成（`withExclusiveLock`），其余过滤计算在锁外 |
| `ace_reflect` | 工具 | `summary` 必填、`outcome` 可选；LLM 复盘返回候选数组；120s 协作超时。同样：首读建文件在锁内，LLM 在锁外 |
| `ace_curate` | 工具 | `ops` 批量增量；`dedupe` 默认对 add 做 LLM 去重（判 new/update/drop）；**两段式**：锁外读快照 + 跑 Curator 的 LLM → 锁内重读最新手册 + 逐条冲突检测 + 校验 + 原子写（LLM 不在锁区间内，见 I5）；输出含 `conflicts` 字段，被并发冲突拦下的条目逐条列出（见 I5c/I5d） |
| 自动复盘 | 内部路径（非工具） | 回合内只记账、空闲边沿才执行（见 I9）；复盘主体与 `/ace` 命令共用同一函数（`executeRecap`） |
| `/ace` 命令 | 命令 | 手动跑一次 Reflector + Curator（走 `executeRecap` → `commitOps`，**会写手册并把冲突回报给用户**，见 I5d）；撞上宿主忙碌时给一句人话提示（`ace: agent 正在忙，稍后重试。`），不把宿主英文错误甩给用户。子命令 `/ace review` 是另一回事：**只读** merge-inbox，把待合并条目注入对话，不写手册、不做冲突判定 |
| `Config` | 配置 | 字段与默认值见 README「配置」表（`playbookPath` 默认空串 = 本机共享手册，`maxEntries` 默认 100） |
| 系统提示段 `ace-playbook` | order 860 | `autoReflect` 为 false 时不注册 |

模型路由解析链：配置了 `reflectProvider`+`reflectModel` 则覆盖优先；否则 `session.requestHeader().config` → `agent.options`（与会话同模型）；解析不出则报错要求显式配置。

### 设置页：为什么是两个下拉 + 可清空

`reflectProvider` / `reflectModel` 是**成对生效**的：`resolveRoute`（lib/llm.js:17-30）只在两项都非空时才采用覆盖值，只填一项等于没填、静默回落到会话模型。所以设置页不做「一个输入框填 model 全名」的自由文本，而是：

- **分开两个下拉**——provider 与 model 是两个独立字段，语义一一对应，用户不必记住 provider 前缀，也不会把 model 名写错；
- **model 下拉按 provider 分组**，已选 provider 时只列该组，把「这个 model 属于哪个 provider」变成界面上可见的事实，而不是靠用户拼字符串；
- **两行都能清空**（面板底部「跟随会话模型（清空）」提交空串，宿主 `validString` 允许空串）——空值就是「跟随会话模型」，与配置默认值一致，不需要「恢复默认」才能回到该状态；
- **只填一项时显式警告**（model 行下方橙色 `#f0b429`）：两项恰好只有一个非空才出现，用来抵消 `&&` 语义造成的静默回落。

选中即提交（没有「保存」按钮）：选 provider → `POST {reflectProvider}`；选 model 且当前 provider 为空 → **一次 POST 同时提交两项** `{reflectProvider, reflectModel}`（宿主 POST 本来就支持多字段）；否则只提交 `{reflectModel}`。

**模型目录接口**（只读，不落盘、不缓存）：

```
GET /api/dsh-ace/catalog
{ ok: true, providers: [ { id, name, models: [ { id, name, description? } ], error? } ] }
```

数据来自 `ctx.llm.listProviders()`（同步）+ 逐个 `ctx.llm.listModels(id)`（异步），组装逻辑在 `lib/catalog.js`（`buildCatalog`，纯逻辑可测）。**逐个 provider 各自 try/catch 并带 15s 超时**：某个 provider 抛错或卡住，只让它自己的 `models` 为 `[]` 并附一条 `error` 字符串，接口整体仍 `ok: true` —— 设置页其余字段因此永远可用。围栏与 `/settings` 一致（先 `rejectionFor` 做回环同源校验），只认 GET，其他方法 405。宿主还没重启到带这个接口的版本时前端拿到 404，两个下拉面板里显示一行错误提示，不阻塞页面。

### 设置页顶部的只读统计：为什么是「观察者」

**结论：统计块是纯观察者，另开一条只读端点，聚合逻辑抽成纯函数；它不参与任何写入路径。**

| 决定 | 理由 |
| --- | --- |
| 新增 `GET /api/dsh-ace/stats`，不复用 `/settings` | `/settings` 的语义是「可写配置的读/写」，往里塞统计会让一条写路径的返回体长出只读字段；另开一条只读分支与 `/catalog`、`/inbox` 并列，围栏（`rejectionFor`）与 405 口径完全一致 |
| 聚合逻辑放 `lib/stats.js` 的纯函数 | `summarizePlaybook(text, opts)` 只吃字符串与注入的 `now`，单测可直接喂样例手册；`readPlaybookStats`/`collectPlaybookStats` 只 stat + readFile，**不写盘、不加锁**，因此不碰 `withLock`/`writeFileAtomic`/`commit.js`/`merge.js` 任何一条写路径（红线 ②不受影响） |
| 一律 `ok: true` + `reason` 降级，绝不 500 | 与 `/inbox` 同款静默降级：相对路径在 HTTP 面没有会话工作目录（`resolvePlaybookFile` 抛 `RELATIVE_PATH_NEEDS_SESSION`，lib/playbook-path.js:52-53）、文件不存在、文件为空、读盘失败，四种都返回结构相同的空态 + 一个 `reason`，设置页其余字段照常可用 |
| 正文字符数口径 = `title+condition+action+rationale` | `parsePlaybook` 已把 `- 条件：` 这类 Markdown 标记剥掉、元数据行单独收进 `meta`（lib/playbook.js:43-47、67-113），因此 `entryTextChars` 量的就是正文本身，不含标记与元数据 |
| 来源构成只显示 `auto=true` 占比 | `helpful`/`harmful` 目前没有任何写入方、恒为 0（lib/playbook.js:49-61 只解析不自增），展示它们等于展示噪声；`auto` 有真实语义（自动归档落盘的条目），且当前是 0 / 35，页面照常显示 0% 并附一句「自动归档尚未落盘过」 |
| 时间分布 = 纯 CSS 迷你条形图 | 不引图表库（红线 ⑤：不新增运行时依赖，浏览器半边保持只有 `React.createElement` + 本文件 CSS）；14 行日期 + 一根宽度按比例的内联 `style` 百分比条，**不动态注入 CSS 规则** |
| 打开页面拉一次 + 区块自带「刷新」+ 保存成功后重拉 | 统计是读操作，不需要实时；但改了 `playbookPath`/`maxEntries` 之后数字会立刻过期，所以保存成功后顺手重拉一次，避免用户以为没生效 |

接口形状（只读、不落盘、不缓存，围栏与 `/settings` 一致，只认 GET，其他方法 405）：

```
GET /api/dsh-ace/stats
{
  ok: true,
  reason: null | 'needs-session' | 'missing' | 'no-entries' | 'unreadable',
  generatedAt: 'YYYY-MM-DD HH:mm',
  pathKind: 'shared' | 'absolute' | 'relative' | null,
  playbookPath: string | null,          // 解析后的手册路径：成功时是绝对路径（空串配置即本机共享层，与 file 相同）；
                                        // 只有 needs-session 空态下才回显配置里的原值（如 'docs/playbook.md'）
  file: string | null,                  // 解析出的手册绝对路径（文件不存在时仍带着这个路径）；只有路径解析失败（needs-session）时为 null
  scale: { entries, maxEntries, textChars, bytes, mtime },  // mtime 在无文件/空态时为 null；maxEntries 仅纯函数调用未传时为 null，HTTP 面恒为配置值
  source: { auto, total, autoRatio },   // autoRatio ∈ [0,1]
  windowDays: 14,
  dailyMax: number,
  daily: [ { date: 'YYYY-MM-DD', count } ],   // 固定 14 行，最早在前
  recent: [ { id, title, updated } ]          // 最多 5 条，按 updated 倒序
}
```

### 三页标签：为什么是隐藏而不是卸载

**结论：三个页面始终都在 DOM 里，未选中的只挂 `[hidden]`；切页只切换可见性，不动组件树。**

| 决定 | 理由 |
| --- | --- |
| 三个 `.ace-page`（`ace-page-stats` / `ace-page-settings` / `ace-page-entries`）始终渲染，未选中的那一个挂 `hidden` | 卸载等于丢状态：设置页填了一半的 draft 会被重置成服务端值、记录页的搜索词/页码/展开行全部归零。保持挂载，切回来就是原样 |
| 标签栏放标题之下、内容之上，三个 `role="tab"` 按钮 + 三块 `role="tabpanel"` | 语义结构照 WAI-ARIA tabs 写（`aria-selected` / `aria-controls` / `aria-labelledby`），宿主与读屏器都不必猜 |
| 默认 `tabId = 'stats'`，刻意不写 `localStorage` | 刷新回到统计页是明确要求；记住上次的页会让「打开设置页」变成不可预期的落点 |
| 不引路由库、不加 URL hash 同步 | 红线 ⑤（不新增运行时依赖）：浏览器半边只有 `React.createElement` + 本文件 CSS；页面本来就只有三个、且不需要深链接 |
| `[hidden]` 由一条 `.ace-page[hidden]{display:none}` 兜底 | `hidden` 属性的默认样式可能被别的 `display` 规则盖掉（这里就有 `display:flex` 的页面块）；显式写一条 CSS，隐藏不依赖属性选择器的运气 |
| 标签栏上接 ←/→ 循环、Home/End 跳首末，配 roving tabindex | 只有选中的 tab 进 tab 序（`tabIndex=0`，其余 `-1`），所以切页必须靠 tablist 上的方向键——否则键盘用户停在原地出不去；`moveTab` 挪焦点前做节点存在性守卫，测试/SSR 无 DOM 时只不挪焦点、不抛错 |

### 记录列表页：为什么另开 `/entries` 而不扩 `/stats`

**结论：记录页要的是全量逐条清单，`/stats` 是聚合视图；另开一条同构的只读端点，围栏与降级口径照抄。**

| 决定 | 理由 |
| --- | --- |
| 新增 `GET /api/dsh-ace/entries`，不往 `/stats` 里塞条目数组 | `/stats` 是聚合视图（`scale`/`source`/`daily`/`recent` 全是汇总，`recent` 只给 5 条）；记录页要全量逐条 + 搜索 + 排序 + 分页，混进汇总体会让一条观察者端点的两种用途互相牵制 |
| 摊平逻辑放 `lib/entries.js` 的纯函数（`toEntry` / `collectEntries`） | `toEntry(raw)` 把 `parsePlaybook` 的一条摊平成固定 10 字段（缺字段给空串/0/false），`collectEntries` 只吃解析结果或全文；单测可直接喂样例手册。`readPlaybookEntries` 只 `stat` + `readFile`，**不写盘、不加锁**，不碰 `withLock`/`writeFileAtomic`/`commit.js`/`merge.js` 任何写路径（红线 ②） |
| 围栏与 405 口径照抄 `/catalog` / `/inbox` / `/stats` | 同一个 prefix handler 里先 `rejectionFor(req, ctx.get('connection'))` 做回环同源校验，再 `method !== 'GET'` 回 405；四条只读端点共用一套入口，不新增一套鉴权写法 |
| 失败一律 `ok: true` + `reason` 降级，绝不 500 | `missing`（文件还不存在）/ `needs-session`（相对路径在 HTTP 面无会话工作目录，`resolvePlaybookFile` 抛 `RELATIVE_PATH_NEEDS_SESSION`）/ `unreadable`（读盘失败），三种都是结构化空态；`reason` 三分派，页面按 reason 渲染不同文案，不把降级当崩溃 |
| 降级体与成功体**同形** | 成功体 6 键（`ok`/`entries`/`total`/`maxEntries`/`pathKind`/`playbookPath`），降级体只多一个 `reason`；旧版这里只发 5 键的 `emptyEntries`，客户端拿不到 `pathKind` 就只能猜 |
| 排序与搜索放客户端 | 数据量上限就是 `maxEntries`（默认 100、硬上限 1000），全量一次取回本地过滤 + 排序，比让服务端做 `?q=&sort=&page=` 参数简单得多，也省掉一套服务端分页语义 |
| 懒加载：第一次切到该页才发请求 | 记录页不是默认页，页面打开时不请求；`handled` ref 记已处理的 `reloadToken`，切走再回来 `active` 变真但 `reloadToken` 没变 → 不重复请求，点「刷新」才重拉 |

接口形状（只读、不落盘、不缓存，围栏与 `/stats` 一致，只认 GET，其他方法 405）：

```
GET /api/dsh-ace/entries
{
  ok: true,
  reason: null | 'missing' | 'needs-session' | 'unreadable',  // 只有降级体带这一键（成功体不带）
  entries: [ {                // 全量逐条，字段顺序即契约：正文缺失给空串、auto 恒为布尔、helpful/harmful 恒为数字
    id, title, condition, action, rationale,
    auto, created, updated, helpful, harmful
  } ],
  total: number,
  maxEntries: number | null,  // 配置值原样透传；非有限数才为 null，HTTP 面恒为配置值
  pathKind: 'shared' | 'absolute' | 'relative',  // 只看配置值的形态，不需要会话上下文
  playbookPath: string        // 解析后的手册绝对路径（空串配置即本机共享层）；只有 needs-session 空态下回显配置原值
}
```

页面侧固定 20 条/页，搜索对 `id`/`title`/`condition`/`action`/`rationale` 五字段做大小写不敏感子串匹配，编号列按数字比较（`ace-2` 在 `ace-10` 之前，不是字典序），更新日期列按 `YYYY-MM-DD` 字符串比较。

### 手册文件位置：默认本机共享层

**结论：手册默认只有一本、放在 `<DSH home>/ace/playbook.md`（本机即 `C:\Users\adkun\.dsh\ace\playbook.md`），跨工作区共用；填相对路径才退化成该工作区私有。**

解析由 `lib/playbook-path.js` 的 `resolvePlaybookFile(configured, { ctx, workingDirectory, env, home })` 完成（纯函数，env/home 注入可测）：

| 优先级 | `playbookPath` 形态 | 结果 | 典型用途 |
| --- | --- | --- | --- |
| ① | 绝对路径；`~` / `~/` / `~\` 前缀 | 原样使用（`~` 展开到 home） | 点名某一份手册 |
| ② | 相对路径（如 `.ace/playbook.md`） | 相对**会话工作目录** join | 该工作区私有，可随仓库进 git |
| ③ | 空串 / 缺省 | `<DSH home>/ace/playbook.md` | 本机共享（默认） |

`<DSH home>` 的解析链：`ctx.get('profileContext')?.home` → `$DSH_HOME` → `~/.dsh`（与 `lib/settings-path.js` 同范式；`~` 展开语义对齐 `@deepseek-ai/dsh-home-paths` `lib/index.js:70` 的 `expandHomePath`，home 解析对齐同文件 `:109` 的 `resolveDshHome`）。

只有 ② 需要会话上下文：HTTP 面（`/inbox`）没有会话工作目录，相对路径在那里解析不到文件，按「暂无可看待合并条目」返回空列表；①③ 在 HTTP 面照常解析——共享层的 merge-inbox 因此能被设置页读到。

父目录不存在的风险由 `writeFileAtomic` 内部的 `fs.mkdir(dir, { recursive: true })`（lib/playbook.js:703）兜住：共享层的 `<DSH home>/ace` 首次使用时并不存在，`readOrInitPlaybook`（lib/playbook.js:783）的 ENOENT 分支会立刻原子写，靠的就是这句 mkdir。

### 设置文件位置：为什么跟随 profile

**结论：设置文件属于「某个 profile 的用户选择」，不属于 DSH_HOME 层；解析链以 `profileContext.dir` 为首选，旧口径只作回落。**

旧实现是 `process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || ~/.dsh`，而 `DSH_PROFILE_DIR` 在宿主服务进程里恒为 `undefined`——它只由 `dsh-shell-env` 在每次 shell 工具调用时现塞进子进程（`dsh-shell-env\lib\index.js:90-93`），进程本身没有这个变量。结果所有 profile 共用 `$DSH_HOME/dsh-ace.json` 一份设置。

现在改为 `lib/settings-path.js` 的 `resolveSettingsFile(ctx, env, home)`（纯函数，env/home 注入可测），解析链：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| ① | `ctx.get('profileContext')?.dir` | 当前 profile 目录，官方惯例 `$DSH_HOME/profiles/<name>`（`dsh-app-boot\lib\index.js:488-497`）；类型定义 `dsh-app-boot\lib\types\profile-context.d.ts:10-25`，声明同文件 `:26-31`「Present only in a profile launched by dsh」 |
| ② | `DSH_PROFILE_DIR` | 旧口径回落（子进程场景下才有值） |
| ③ | `DSH_HOME` | 旧口径回落 |
| ④ | `~/.dsh` | 兜底 |

文件名恒为 `dsh-ace.json`。取值容错：`ctx` 缺失、`ctx.get` 抛错、`profileContext` 不存在、`dir` 为空串或纯空白，一律视为「没有这一级」并继续回落——非 profile 启动的宿主不会因此报错。

**一次性迁移**（`migrateSettingsFile`，`apply()` 初始化处调用一次）：仅当「新位置不存在 + 旧位置存在 + 两者不是同一路径」时，把旧文件内容**原样复制**到新位置，写入口径与 `writeStored` 一致（临时文件 + rename、`mode 0o600`），并记一条 `ctx.logger.info` 说明从哪到哪。**旧文件保留不删**（用户数据，删了不可恢复）；**新位置已存在则绝不覆盖**。迁移失败只 warn，不影响插件启动。

## 非功能红线

**结论：每条红线都能指到载体与依据，改动前逐条对照。**

- 手册只增量演化，无整本重写路径——来源：ACE 方法论（细节磨平问题）——载体：`lib/prompts.js` 两条 system 提示词 + `applyOps` 仅暴露三操作（机检：TESTING 用例）[评]
- 并发 curate 不写坏手册——来源：验收标准 3——载体：`withExclusiveLock`（`withLock` per-path Promise 链 + `withFileLock` 跨进程 `<file>.lock`，锁覆盖整个读-改-写区间；跨进程锁不抢占活着的持锁者，超时失败而非覆盖）（机检：withLock 三条、withFileLock 八条、withExclusiveLock 两条、writeFileAtomic 一条）[机检]
- 手册写入原子可见——来源：I6——载体：`writeFileAtomic`（tmp + rename）（机检：读写往返用例）[机检]
- LLM 输出结构化后才落盘——来源：I8——载体：`extractJsonObject` + 字段过滤（评）[评]
- 失败不产生半截状态：curate 任一步抛错则手册不变（锁内先校验后写）——载体：`applyOps` 事务校验（机检：事务式用例）[机检]
- 零第三方运行时依赖、无子进程、无 Python——来源：委派约束——载体：`package.json`（机检：无 dependencies 字段）[人]

## For Agents

- 改 `lib/playbook.js`（纯逻辑）时：保持函数纯度（`applyOps` 不碰 IO），新行为先在 `tests/playbook.test.mjs` 补用例；
- 改提示词时：守住 I1 措辞（「只输出增量」「禁止整本重写」必须原样保留）；
- 加工具时：参数/输出都用 per-property spec（type/required/description/enum/items/additionalProperties），照 `lib/index.js` 现有三工具写；每个新引用的 DSH API 在代码注释里注明 checkout 出处；
- 别动：`cordis.patch.yml` 的 id/name 配对；`inject` 数组只声明真正用到的服务。

## 测试与验证

用例总表、运行方式与未验证清单见 [TESTING.md](TESTING.md)。