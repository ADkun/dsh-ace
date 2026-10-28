---
title: dsh-ace 设计文档
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-24
---

# 设计

## 职责与边界

**结论：dsh-ace 只负责「手册的读、盘、并」三件事，不负责任务执行本身，也不做任何检索/向量化。**

- 管：手册文件生命周期（不存在则初始化）、条目结构与 id 分配、增量操作的事务校验、并发与原子写、Reflector 的 LLM 调用与提示词、**候选并入的确定性判定与归档**、自动注入的预检索与排序（**注入只追加进历史，绝不改写系统提示**，见「为什么注入必须追加进历史」）、agent 何时复盘的系统提示、设置页可见的运行统计。**Curator 的 LLM 调用已删除**——候选是新增还是覆盖、覆盖哪一条，由 `lib/archive.js` 的确定性规则判（见「候选并入为什么不再调 LLM」）。
- 不管：手册内容的质量判断（交给 LLM 与人）、手册的自动调度（何时复盘由 agent 按系统提示自行判断）。
- 手册**位置**由配置决定（见下节「手册文件位置：默认本机共享层」）：默认一本手册跨工作区共用；填相对路径则退化为该工作区私有一本。
- 不管：**两层手册的自动合并读**（共享层 + 项目私有层同时读）。理由是硬约束而非偏好：`nextId` 是单本内「现存最大编号与历史高水位的较大者 +1」（lib/playbook.js 的 `nextId`/`maxEntryIdNumber`），合并视图里会撞号；`maxEntries` 容量会被两层一起吃满；curate 的落点是单值，刚写进共享层的条目下次合并读可能读不到。**任何时刻只有一本手册被读写。**

## 依赖关系

**结论：运行时只依赖宿主注入的服务与两个宿主包，零第三方运行时依赖。**

| 依赖 | 用途 | 来源 |
| --- | --- | --- |
| `ctx.tools` | 注册三个模型可见工具 | 宿主服务（inject 声明） |
| `ctx.systemPrompt` | 注册「何时复盘」提示段 | 宿主服务（inject 声明） |
| `ctx.llm` | Reflector 的单次 LLM 调用（复盘用）；**Curator 调用已删除** | 宿主服务（inject 声明） |
| `ctx.workingDirectory` | 相对手册路径 → 会话工作目录（只有相对路径这一形态需要它；绝对路径与共享层不需要会话上下文） | 宿主服务（inject 声明） |
| `@deepseek-ai/schemastery` | Config schema（cordis 以 `~standard.vendor` 识别） | 宿主提供的 peer 依赖 |
| `@deepseek-ai/dsh-tools` | `defineTool` 构造工具定义 | 宿主提供的 peer 依赖 |
| `@deepseek-ai/dsh-llm` | `createUserMessage`：把冲突/失败通知包成宿主契约的消息对象（`content` 为 `ContentBlock[]`，配合 lib/notice.js，见 I10） | 宿主提供的 peer 依赖 |

Node 内置模块仅 `node:fs`、`node:fs/promises`、`node:path`、`node:os`、`node:crypto`。与已验证模板 dsh-raw-html-v2 同构：`package.json` 以 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者一行 `insert` 把入口挂进 cordis 层（行 id 必须等于入口导出的 `name`）。

## 核心数据模型

**结论：一切围绕一个 Markdown 文件和三种纯数据形态；LLM 产出只在结构化校验后进入模型。**

| 形态 | 对象 | 说明 |
| --- | --- | --- |
| 生命周期型 | `PlaybookEntry` | 条目（id/title/condition/action/rationale/meta/extraLines），随复盘/curate 演化；`meta` 是**四字段固定顺序** `created → updated → hits → lastHit`，可选 `auto=true` 恒排最后；三个时间字段都是毫秒精度的本地 ISO（lib/timestamp.js），`hits` 是可累加整数、**唯一的淘汰依据**。改前的 `helpful` / `harmful` 与 `netScore` 已整层删除 |
| 归档型 | 独立归档文件里的条目 | 被归档的条目（结构同 `PlaybookEntry`，额外带 `archive:{reason,date,supersededBy?}`），写在**与手册同目录的 `archive.md`**里（lib/archive-file.js），**只读、不参与检索/合并/注入**，永不物理删除。改前它写在手册末尾的 `## 归档区` 章节下，第 33 轮搬走，手册文件里不再出现该章节 |
| 句柄型 | 手册文件路径 | 唯一持久化句柄；由 `playbookPath` 经 `lib/playbook-path.js` 解析：绝对路径（含 `~` 前缀）原样用、相对路径经会话工作目录 join（工作区私有）、空串/缺省 = `<DSH home>/ace/playbook.md`（本机共享） |
| 不可变值 | `ops`（curate 入参） | 操作批：进入 `applyOps` 后先整批校验再应用，校验期间不改副本 |
| 受控操作 | `withExclusiveLock` / `writeFileAtomic` | 手册文件只经这两个受控入口变更；`withExclusiveLock` = `withLock`（同进程 per-path 串行）→ `withFileLock`（跨进程 `<file>.lock`），锁覆盖整个「读-改-写」区间；`writeFileAtomic` 内部再进 `withFileLock` 时按重入处理（不重复加锁）；跨进程锁不抢占活着的持锁者（I5b） |

条目落盘格式与解析规则见 README「首次使用」；条目内人手写的无法识别行挂在 `extraLines` 原样保留。

### 不变量

- I1 不存在把手册整本替换为新文本的代码路径或提示词指令——演化只经 add/update/remove；
- I2 条目 id 在同一手册内唯一且**单调不复用**：新 id 恒为「现存最大编号与历史高水位的较大者 +1」。历史高水位记在手册文档头的一行 HTML 注释里（`<!-- ace:id-highwater: N -->`，`readIdHighWater`/`ensureIdHighWater`/`applyIdHighWater`，lib/playbook.js），因此**删掉最高编号的条目后再新增，编号不会重用那个号**（`applyOps` 接受 `highWater` 入参，分配后把新高水位写回文档头）。**唯一的例外**：人同时删掉最高编号的条目**和**文档头的高水位标记时，历史最大值无法从文件本身恢复，该编号可能被**复用一次**（随后标记被重写为当前最大编号，也就是刚被复用的那个号，因此只会复用这一次）——这是已知限制，不靠猜补。标记行写回前会被全文清干净、只在文档头的规范位置留一份（幂等，绝不出现两份）；解析时标记行即使被挪进条目正文也会被摘出来归位，不会被当作条目正文。人手编辑插入高编号条目后，下一个新增仍大于它（编号取现存条目的最大值）。**适用前提：一本手册一份编号空间**——共享层与工作区私有层并存时，各自独立编号，`ace-001` 在两层里可能指向不同条目（这也是不做两层合并读的原因之一，见「职责与边界」）；
- I3 `applyOps` 是事务式的：任一操作校验失败则整批拒绝，条目数组保持不变。**注意两类拒绝的粒度不同**：**校验类**（id 不存在 / op 非法 / 超出 `maxEntries`）是整批拒绝、抛错，安全项一起丢（既有语义，不改）；**并发冲突类**（`update`/`remove` 的目标被改被删、`add` 与自快照以来出现过的条目重复）才是**逐条**判定——只有冲突的那几条被拦下，同批安全改动照常落盘（见 I5c）；
- I4 手册条目数不得超过 `maxEntries`，违反即整批拒绝并在错误信息里给出可合并的旧条目；
- I5 同一路径上的手册「读-改-写」串行执行，**同进程与跨进程都成立**：`withExclusiveLock`（lib/playbook.js）= `withLock`（per-path Promise 链，进程内，不同路径互不阻塞）→ `withFileLock`（跨进程 `<file>.lock`，`O_EXCL` 创建、内含 pid + 时间戳 + nonce、抢不到带退避重试）。**两层锁都有重入保护**：`withLock` 与 `withFileLock` 各用一套 AsyncLocalStorage 记录「本次调用链已持有的锁」，同一路径上再取一次锁直接执行（否则嵌套 `withExclusiveLock(file)` 会自死锁）；不同路径仍各走各的链，互不阻塞。**锁的持有期覆盖整个读-改-写区间**（读手册 → 算新条目 → 落盘都在锁内）；区间内的 `writeFileAtomic` 靠 AsyncLocalStorage 识别为重入，不会自死锁；rename 的原子性仍保证文件不会写坏。**锁区间内只允许纯计算——任何 LLM/网络调用必须在锁外**（复盘时 Reflector 的多轮 LLM 调用在锁外跑完，锁内只重新读最新手册、查冲突、判定候选、归档与落盘）。跨进程锁的回收语义见下一条 I5b：
- I5b 跨进程锁**永不抢占活着的持锁者**：`withFileLock`（lib/playbook.js）读到锁内容里的有效 pid 且该进程仍存活（`process.kill(pid, 0)` 不抛错）时一律等待，最多重等到 `LOCK_TIMEOUT_MS`（30s）后抛错——**失败而不是丢写**。可回收的只有两种锁：① 持锁进程已死（`ESRCH`）；② 锁内容读不出有效 pid（损坏/写到一半）且 mtime 已远超 `LOCK_STALE_MS`（10s）。回收权靠 `rename` 取得（`<file>.lock` → `<file>.lock.stale-<随机>`，拿到名字的那方才删），因此不会误删新主人的锁；`finally` 只删**自己那把**锁（核对 payload 里的 nonce，不符就不删）。误抢到活锁时靠 `restoreLock` 把它原样放回：优先 `link` + `unlink`，**任何 `link` 失败（含 Windows 跨卷的 ENOENT）都走「位置未被占住才放回」的兜底**（`open(lockPath, 'wx')` 独占创建，抢不到就说明位置已被新主人占住，绝不覆盖）。**这条取代了旧语义**（旧实现用「时间超期」判陈旧并直接 `rm`），旧语义在共享一本手册时必然丢写：慢 LLM 调用超过 10s 后活锁被抢，先落地的那份写被覆盖，且原持锁者退出时会把新主人的锁删掉，导致临界区重叠。**多实例共享同一本手册时仍可能出现「后写者覆盖先写者」**——I5 只保证「读-改-写区间不重叠」，跨实例的语义冲突由 `detectAllConflicts`（lib/merge.js，逐条判定，见 I5c）挑出并由调用方回报给用户解决，不靠抢锁解决；
- I5c **并发语义冲突按条判定，不整批一票否决**：锁内重读最新手册后，`detectAllConflicts`（lib/merge.js）把待写入的 ops 逐条判定，只有**真正冲突的那几条**被拦下，同批其余安全改动照常落盘（`commitOps`，lib/commit.js）。判据分两类：
  - `update`/`remove`：目标条目在快照之后被删 / 被改 / 是新出现的（`detectConflicts`，lib/playbook.js）；
  - `add`：与「自快照以来**新出现或被改名**的条目」构成重复 —— 完全重复用 `applyOps` 同一套 `normKey` 口径、同标题不同正文用 `normTitle`、近似重复用 `computeMergeSuggestions` 的 BM25 比率（`MERGE_THRESHOLD_RATIO=0.5`）。判定范围是「自快照以来出现过该标题/该正文的条目」：`latest` 里 id 不在快照中的（复盘期间新出现的），以及同一 id 在快照里存在但**标题被改过**的（并发改名 → 新标题自快照以来出现过，否则磁盘上会留下两条同标题）。**不回头拦「快照里一直存在且未被改名」的同标题条目**：那是候选判定层的既有职责（`applyOps` 的 seen 集合 + `decideCandidates` 的完全重复丢弃 / 同标题优先匹配），不在冲突层重复拦，避免把正常流程拦死。
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

- **I11 只有「真的很像」才许在不满额时动手合并；满额的合并口径不许被它带偏。** 复盘落盘前两条合并路径共用 `planMerges`（lib/merge-llm.js），但取值不是一套：**满额**（`projected > maxEntries`）是「非合不可」，用 `MERGE_THRESHOLD_RATIO = 0.5` + `MERGE_MAX_ROUNDS = 5`（第 33 轮定下的口径，**第 37 轮一字未动**）；**不满额**（`projected <= maxEntries` 且本轮 `adds > 0`）是「顺手清理」，用 `MERGE_EAGER_THRESHOLD_RATIO = 0.75` + `MERGE_EAGER_MAX_ROUNDS = 2`。为什么阈值必须更高、轮数必须更少：合并提示词要求把两段正文合成**一条同构条目**，一旦硬并，被并掉的那条只躺在 `archive.md` 里、再也不会被注入——这是不可逆的语义损失。满额时不合并就写不进去，损失是「拒绝候选」；不满额时合并只是优化，收益远小于误合并的代价，所以宁可放过一堆 0.5~0.75 的「有点像」，也不许把它们硬并。**本轮 `adds === 0` 时一次都不许调 LLM**（没新增就没有清理的理由）；**0 候选分支保持原样**（「0 候选就不合并」是既有语义，第 37 轮没有给它加轻量路径）。两条路径的 ops/moves **走同一条落盘通道**（`commitOps` 的 `merged` + `ops`），归档原因恒为 `merged`，顺序硬约束不变：**先写 `archive.md`、再写手册**；轻量合并失败（LLM 抛错/输出不合格）**只 warn、绝不阻塞落盘**（守护②）。机检：tests/recap-pipeline.test.mjs 的 5 条 `e｜` 用例。

- **I12 注入块首行写的「最多 N 条」，N 必须是本回合真的生效的那个条数。** 条数上限来自配置 `injectMaxEntries`（lib/index.js 的 `injectMaxEntriesOf`，默认 5），经 `selectInjection` 的 `options.maxEntries` 透传给 `renderInjection(picked, { withRationale, maxEntries })`；未传 / `0` / 非法值才回落模块常量 `INJECT_MAX_ENTRIES`。**这条只约束文案，不约束取几条**：取几条由 `selectInjection` 的既有逻辑（条数上限 ∩ token 预算）决定，第 37 轮一行都没改。为什么值得单列一条不变量：文案是给人看的唯一凭证，用户配了 8 却看到「最多 5 条」时会按 5 条去理解注入行为——说假话的文案比不说更糟，而且这种偏差不会触发任何异常、只会静默误导。宁可说「最多 5 条」（真实的默认值）也不许说「最多 0 条」这类由非法入参猜出来的数字。机检：tests/inject.test.mjs 的 `C5.6`、tests/tuning-behaviors.test.mjs 的配置行为② 端到端断言。

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

## 复盘、候选判定、归档与注入（C1–C6 的行为契约）

**结论：从「回合结束」到「条目落盘 / 归档 / 注入 / 计数」这条链上，只有复盘与满额合并两步调 LLM；判定、淘汰、归档、排序、命中计数全是确定性代码。** 注入这一环（第 28 轮起）也全是确定性的，且**只往历史尾部追加一条 user 消息**，不碰系统提示（见「为什么注入必须追加进历史、不能改写系统提示」）。

### 元数据四字段与毫秒时间戳

每条条目的 `- 元数据：` 行**固定四字段、顺序不变**：`created → updated → hits → lastHit`，可选 `auto=true` **恒排最后**（`metaLine`，lib/entry-format.js；解析在 `parseMeta`，缺字段按 `''` 兜底）。改前的 `helpful` / `harmful` 已**整层删除**：`parseMeta` 遇到旧文件里的这两个字段静默丢弃（不报错、不留痕迹），`metaLine` 永不写出。

改前：`created=2026-10-25 updated=2026-10-25 helpful=0 harmful=0 hits=3 lastHit=2026-10-25`

改后：`created=2026-10-25T06:12:33.412+08:00 updated=2026-10-25T06:12:33.412+08:00 hits=3 lastHit=2026-10-25T12:03:01.008+08:00`

- **三个时间字段都是毫秒精度本地时区 ISO**（`nowStamp`，lib/timestamp.js，**零 import**）。选这个形状的三个理由：① **字典序即时间序**，`compareStamps` 是纯字符串比较，跨进程、跨机器稳定（不解析成 `Date`，不受本地时区与夏令时影响）；② 带偏移（`+08:00`），同一份文件换机器读不会错位；③ 界面仍只显示到日（`dayOf` 取前 10 位），显示精度与排序精度解耦。
- **旧格式照常解析**：只有 `YYYY-MM-DD` 的条目是合法前缀，比较时自然排在同一天的毫秒戳之前；空串最小。解析绝不因为格式旧而抛错——真实手册里全是旧格式，硬升级等于让第一次复盘炸掉。
- **同毫秒并列由 id 数字兜底**（`idNumber`，`ace-2` 在 `ace-10` 之前，不是字典序）。
- **唯一写入口**：命中只能经 `commitMeta(file, snapshot, spec)`（lib/commit.js）——锁内重读最新手册、冲突检测、再原子写；不存在「拿旧快照直接改数字」的路径。

### 命中计数：`hits` 是唯一的淘汰依据

**结论：条目被「用到」一次就 `hits += 1`，`hits` 与 `lastHit` 是评分层删除之后**唯一**的量化信号，也是最少使用淘汰挑人的唯一依据。**

两个来源，别的一概不记：

| 来源 | 什么时候 +1 | 代码 |
| --- | --- | --- |
| 自动注入 | 注入消息**真的被追加进会话历史**的那一刻（同一批只记一次） | `lib/injection-flow.js` 的 `take` / `note` 接缝；`delivered` WeakMap 保证同一批的第二次调用返回 `null`，同一回合后续每一步都不重复追加 |
| `ace_playbook` 定向检索 | **只有带 `query` 或 `id` 的查找**才按命中条数 +1 | `lib/index.js` 的 `if (args.id || args.query)` 分支 |

- **整本读取一次都不计数。** 通读全书不是「用到某条」；计进去的话一次通读就能把命中数刷到条目总数，`hits` 立刻失去区分度，最少使用淘汰也就没法挑人了（tests/wiring.test.mjs 的「b｜ace_playbook 命中计数」钉住这条）。
- **同一批只记一次**（`delivered` WeakMap）：`agent/pre-step` 每一步都会跑，不按批次去重的话一次注入会被记成十几次命中。
- **hits 不进注入排序键**：否则「命中多 → 排得更前 → 更容易再命中」形成自增强棘轮，而淘汰恰好按 `hits` 挑人——两者一叠加，新条目永远等不到第一次命中就被淘汰（见「自动注入」一节与 tests/inject.test.mjs 的「k｜hits 高低不影响注入排序」）。

**落盘时机：投递与检索时只记内存，回合边界一次原子写盘**——四段接缝见「命中账本：注入 → 回合边界一次原子写盘」。**别在这里就地写盘**，理由：

① 注入在 `agent/pre-step` 里跑，那是宿主最热的路径，一次注入一次锁 + 一次 rename 会把回合拖慢，还会跟复盘的写盘互相抢锁；② 一次回合里可能注入好几批，逐批写等于把同一份文件反复重写；③ 命中是**批量事实**（这一回合用到过哪几条），它在回合结束时才完整。

### 为什么不再判「这一回合成不成」（第 33 轮拆除的整层）

计分那套机制的前提是「能判出这一回合成不成」，但宿主不直接给这个信号，只能从工具轨迹里猜。第 33 轮把这整层拔掉了，连同它的因果链一起：

| 被删的符号 | 原判据 | 为什么删 |
| --- | --- | --- |
| `classifyTurnOutcome` / `settleTurnOutcome`（原 lib/trigger.js 的同名函数，已删） | `weak`（工具调用 ≥ 3 且出错占比 ≥ 50%）/ `unobserved`（本回合出现过 `agent/error`）/ `ok`（其余） | 三档全是代理信号。`weak` 把「命令反复失败」当成经验有害，可失败常常是环境、权限、缺依赖；`ok` 是默认乐观填的坑 |
| `WEAK_FAILURE_MIN_CALLS = 3` / `WEAK_FAILURE_ERROR_RATIO = 0.5` / `UNOBSERVED_TIER` / `UNOBSERVED_OUTCOME` | 阈值与档位字面量 | 判据删除后无消费者 |
| `openBuckets` / `noteToolResult` / `noteAgentError`（原 lib/trigger.js 的同名函数，已删） | 两次 `agent/turn-stopping` 之间按回合开桶、记 `errorTurn` 归属 | 「把错误归到哪个回合」只在计分时才有意义 |
| `ctx.on('agent/error')`（原 `agent/error` 订阅，已删） | 宿主报错就当失败证据 | 见下节 |
| `noteError` / `unobservedTurns` / `orphanUsages` / `adoptUnobservedUsage` / `settleOrphanUsages`（原 lib/recap.js） | 「未观测回合就地结算、不许顺延」的整套补偿机制 | 这些补偿只为「别把分记错」而存在；分没了，约束失去理由 |

**根因一句话：成败判分归因不可靠。** 一次回合走完与否由外部因素主导——provider 429/超时/上下文超长、写盘失败、相位断言、工具缺失、权限被拒——这些与手册里写的经验对不对没有因果关系。用一个受外部因素主导的量去给经验加减分，等于给噪声记分；而分数又决定「这条经验还能不能被注入、会不会被归档」，误判不可逆（条目被软归档后不再被注入，也就再也没有翻身机会）。真实手册里 `harmful > 0` 的条目**长期为 0 条**——这条惩罚通道从来没有真正命中过，它不是在惩罚坏经验，只是在赌 provider 别出故障。

**替代方案：使用频次。** 现在唯一的量化信号是 `hits`（这条经验被真注入进历史的次数、以及被 `ace_playbook` 定向检索到的次数）与 `lastHit`。它同样不完美（被注入 ≠ 有用），但它可观测、可解释、不会被外部故障污染，而且**不进注入排序键**（见「自动注入」一节），所以不会形成自增强棘轮。

### 为什么 `agent/error` 从来就不是失败信号（第 31 轮的结论，第 33 轮连同监听一起删）

改动前强失败档是 `if (raw && raw.error) return { tier: 'strong', outcome: '失败' }`，两处都错：

1. **它衡量的不是经验对不对。** `agent/error` 是「链路有没有走完」：模型侧 429/超时/上下文超长、写盘失败、相位断言失败，全是外部因素。同一批经验在 provider 不抽风时明明有用，抽一次风就被记一次 harmful。
2. **它破坏了账本的时间归属。** 宿主发 `agent/error` 的路径**跳过** `agent/turn-stopping`（派发在 `dsh-agent-loop/lib/index.js:1001`，错误路径从 :1010 `catch` 直接 `throwError`），于是「T 回合的注入记到 T+1 的结果上」成了结构性缺陷，只能靠一整套 orphan 补偿机制去追。

第 31 轮先把 `agent/error` 降级成中性态 `unobserved`（不计分、只记命中），再补「就地结算、不许顺延」的补偿链；第 33 轮把计分整层删掉之后，**监听本身也删了**——没有分数要保护，也就不需要这条补偿链。**留下的教训写进红线**：任何「按外部事件给经验打标记」的机制都会把 provider 的抖动记到手册上，不许以任何形式加回来。

### 候选过滤：只剩一条「标题字符数 > 0」（第 33 轮）

第 31 轮曾有一整套三层闸门（`lib/gate.js`，231 行）：形状（标题码点数 6–60、condition/action 非空、括号外指代词、本机绝对路径）、可判断性（白名单）、专有度降级（把 `ace-NNN`、日期、文件名挤进 rationale），第 32 轮还按真实手册回放校准过阈值。**第 33 轮整层删除**，连同 `tests/gate.test.mjs` 一起删。

删除理由：

- 它当初的真实动因是**计分与归档都靠「这条经验有没有被注入过」**：条件写坏了 → 永不注入 → 永不证伪 → 永不归档，成了永久占位。现在占位的代价改由**最少使用淘汰**确定性收走（`hits` 少就先走），闸门不再是唯一出口；
- 判据全是启发式，误杀的代价远高于漏放：闸门只拒候选、不拒整批，可被拦下的那条好经验**直接消失**，没有任何兜底；
- 维护成本与收益不成比例：第 32 轮为了少误杀 4 条好条目标题，把上限从 40 调到 60——阈值本身就在跟真实数据打架。

**现在的唯一判据**（`lib/recap-pipeline.js` 的候选过滤）：`if (!title.trim())` → 拒绝并写一条 `dsh-ace: …` 日志。空标题没有检索价值，也无法让人在列表页认出来；非空一律放行——**没有长度上限、没有指代词规则、没有文件名规则、没有降级重写**。召回质量的责任改由 `REFLECTOR_SYSTEM` 承担（条件必须写成「当……时」触发式、且含用户真会说出口的词面，见 `lib/prompts.js`）。

### 重复检测的三档（第 31 轮）

`decideCandidates` 的近似重复判定原来只有两档：≥ 0.5 走覆盖/取代，< 0.5 走新增。实测发现同一件事被两个回合各总结一遍时，比率常落在 0.4–0.5（ace-154 ↔ ace-161 ratio=0.4249、ace-159 ↔ ace-162 ratio=0.3936），两档都接不住：要么白占两个 900 token 名额，要么把候选里真正的新细节丢掉。现在三档：

| 档 | 判据 | 动作 |
| --- | --- | --- |
| 丢弃 | `normKey` 完全相同 | `dropped`，不产生 op（不变） |
| 覆盖 / 取代 | 同标题，或对称 BM25 比率 ≥ `MERGE_THRESHOLD_RATIO`(0.5) | 见下节「候选并入」的两条分支：只剩「正文缩没缩水」两条判据，不再看任何分数 |
| **增量补充** | 0.4 ≤ 比率 < 0.5（`SUPPLEMENT_RATIO` = 0.4） | 不新增、不覆盖旧正文，把候选里旧条目**还没有**的那部分（`missingText` 按句读切分后逐句判）追加进旧条目的 rationale；不占新名额、不写 superseded。候选没带来任何新细节则 `dropped reason='supplement-redundant'` |

`SUPPLEMENT_RATIO` 的注释里写明：**这不是把合并阈值降到 0.4** —— 0.5 以上走覆盖/取代，0.4–0.5 走增量补充，两者的处置完全不同。

### 多轮复盘：什么时候算「提炼完了」

`reflectRounds({ callRound, maxRounds, logger })`（lib/reflect.js 的同名导出）跑最多 `REFLECT_MAX_ROUNDS = 3` 轮（:11），每轮把「此前已提炼的候选」一并喂回去，让模型接着往下想而不是重复第一轮：

- **空数组即收敛**：某一轮返回 `[]` → `converged: true`，停止，保留已提炼的候选；
- **第 1 轮抛错就上抛**：一条都没提炼到，等于这次复盘没跑成，交给上层按失败处理；
- **后续轮抛错按已提炼落盘**：`aborted: true`，把已经拿到的候选交给落盘，不因为第 2 轮的网络抖动丢掉第 1 轮的成果；
- **跑满 3 轮**：`converged: false`，按已有候选落盘（不无限追问）。

每轮都写一条 `dsh-ace: 多轮复盘第 N 轮产出 K 条候选（累计 M 条）`，收敛时写 `dsh-ace: 多轮复盘第 N 轮无新增候选，判定收敛（已提炼 M 条）`，中断时写 `dsh-ace: 多轮复盘第 N 轮中断（…），按已提炼的 M 条候选落盘`——日志能还原「这次为什么停在第几轮」。

### 最少使用淘汰（第 33 轮，替代原来的正负评分）

**结论：满额时先合并、合并后仍超就按「用得最少的先走」淘汰，被淘汰的搬进归档文件，任何一步失败都不许整批拒绝。**

顺序（`lib/commit.js` 的 `options.evict` + `lib/evict.js` 的 `planEvictions`，全部在锁内）：

1. **先试合并**（只在上限被突破时）：`lib/merge-llm.js` 的 `planMerges` 最多 5 轮、每轮只喂一对，把两条相近的合成一条，见下节「LLM 合并」；
2. **合并后仍超 M 条 → 按 `hits` 升序取前 M 条淘汰**；
3. **被淘汰的搬进 `archive.md`，原因 `evicted`**；
4. **任何一步失败都不许整批拒绝**：合并失败就跳过合并直接淘汰；淘汰本身失败就照原样报错（此时确实没有可腾的位），但**绝不把候选丢掉、绝不让复盘失败**。

淘汰排序（`compareForEviction`，lib/evict.js，纯函数、零 IO）只有三级：

| 级 | 判据 | 理由 |
| --- | --- | --- |
| ① | `hits` 升序 | 「最少使用」的字面定义；用得少说明这类场景很少遇到，或者它写得没被认出来 |
| ② | 同 `hits` 时 `created` 的毫秒戳更早的先走（`compareStamps`） | 同样的使用次数下，老条目已经有足够长的机会证明自己；让新条目先活一轮，是给「刚写出来还没被检索到」留时间窗 |
| ③ | 同 `hits` 同 `created` 时 `idNumber` 数字升序 | 排序必须**确定**：同一份输入两次跑必须给出同一个结果，否则复盘不可复现、用例也无从断言 |

**为什么不用成败判分**：详见「为什么不再判这一回合成不成」。一句话——外部因素主导、归因不可靠、误判不可逆；而使用频次可观测、可解释、不会被 provider 抖动污染。

**代价（如实记）**：`hits` 只反映「被注入 / 被检索」的次数，不反映「有没有帮上忙」。一条经常被注入但每次都不适用的经验会活得很久，一条冷门但极其关键的经验可能被淘汰。**兜底是「永不物理删除」**——它只是从活跃区搬进 `archive.md`，人随时能看、能改、能手工搬回来；而且合并会把相近经验收成一条，活跃区的平均质量靠去重维持，不靠打分维持。

**不做什么**：不引入任何分数、权重、衰减因子；不按「上次命中距今多久」判生死（`lastHit` 只用于展示，不参与淘汰）；淘汰顺序不许改成随机、不许只按时间——三级判据的先后次序本身就是契约（tests/archive.test.mjs 的守护用例①钉住「同 hits 时老条目先走」）。

### 新条目保护期（第 36 轮）：只改先淘汰谁，绝不许死锁

**结论：`created` 距今不足 `protectDays` 天的条目先进「受保护组」，淘汰优先从不受保护的那组取；不够 `need` 时再用受保护组按既有全序补齐——保护期只调整「谁先走」，要腾出的位数一位不减。**

- **判据**（`lib/evict.js` 的 `planEvictions(entries, need, { date, protectDays })`）：`dayOf(date) − dayOf(created) < protectDays` 即受保护；`created` 缺失或解析不出的**一律算不受保护**（旧条目，先走）。
- **为什么全在保护期时必须允许兜底淘汰**：满额淘汰的语义是「必须腾出 N 个位子，才能把这批候选落盘」。若把保护期理解成「受保护的绝对不动」，那么当**全部条目都在保护期**（刚导入一本手册、或 `maxEntries` 被调小）时容量永远降不下去，本回合候选会被整批拒绝——等于把复盘结果静默丢掉，正是第 33 轮反复钉住的「任何一步失败都不许整批拒绝」那类事故。所以受保护组只在「不受保护的够用」时被跳过，缺口一律由受保护组按 `hits` 升序 → `created` 更早 → `idNumber` 兜底补齐。
- **`protectDays <= 0` 或非有限数 = 不保护**：与旧版逐字等价（既有调用点只传 `{ date }`，行为不变；tests/evict-protect.test.mjs 用 `0 / -1 / NaN / Infinity / undefined / null / ''` 逐个与旧行为比对）。
- **配置面**：`evictProtectDays` 默认 14、可填 0–365，`0` 是**有效值**（不保护）；读设置文件时用 `validTunableInt` —— `Number(null) === 0`、`Number('  ') === 0`，照收会把「被手改坏的 null / 空输入框」静默读成「不保护新条目」，所以要显式写 0 才算 0。

### LLM 合并（第 33 轮，唯一允许的正文增长点）

**结论：满额时先让模型把两条相近的经验合成一条，而不是直接淘汰。** 找配对是**确定性**的（`computeMergeSuggestions`，对称 BM25 比率 ≥ `MERGE_THRESHOLD_RATIO = 0.5`，`lib/merge.js`），合成正文才调 LLM（`lib/merge-llm.js`）：

- **只把这一对的正文 + 合并要求喂给模型**，不给全手册——既省钱，也避免模型顺手改别的条目；
- 输出必须是一条**同构的四字段条目**（`title`/`condition`/`action`/`rationale`），必须过 `lib/prompts.js` 的 `extractJsonObject` 校验，四字段任一不是非空字符串即判**该对失败**（不是整批失败）；
- **保留 `created` 更早那条的 id**（`survivingEntry`），另一条归档，原因 `merged`——高水位与外部引用（人写在别处的 `ace-NNN`）都还指着存活的那一条；
- **最多 5 轮**（`MERGE_MAX_ROUNDS`），每轮处理一对；某对失败就摘掉换下一对；**永不抛错**（`planMerges` 内部 try/catch）；
- **绝不阻塞复盘落盘**：全部失败就直接淘汰腾位，落盘照常成功（tests/recap-pipeline.test.mjs 的守护用例②钉住）；
- 走 `lib/llm.js` 与 Reflector **同一条**模型路径，零新增依赖。

`MERGE_SYSTEM` 是四段式提示词（目标 / 只做什么 / 不做什么含反例 / 输出契约必须是 JSON），写在 `lib/merge-llm.js` 而不是 `lib/prompts.js`——它只服务这一条路径，放一起会让人误以为它跟 Reflector 共用输入。

### 轻量合并（第 37 轮）：不满额也配对，但只有「真的很像」才动手

**结论：满额路径一个字不动（阈值 0.5、最多 5 对）；新增一条「不满额顺手清理」路径，阈值 0.75、最多 2 对，且只在 `adds > 0` 时跑。**

改前的语义是「只有 `projected > maxEntries` 才去合并」——手册一旦没满，两条几乎重复的经验就能一直并存到下次爆额，期间每次注入都在花双份 token 讲同一件事。但不满额时合并**不是必需的**（不合也不会丢任何东西），所以判据必须比满额严：

- **阈值更高（0.75 vs 满额 0.5）**：满额是「非合不可」（不合就得淘汰，丢的是经验），可以放宽到 0.5 去尽量多合；不满额是「顺手清理」，放宽阈值的代价是把不相干的经验硬并成一条 —— 合并提示词是「两段正文 → 一条同构条目」，硬并就等于**语义污染**，且被并掉的那条从此只躺在 `archive.md` 里、再也不会被注入，**不可逆**。
- **轮数更少（2 vs 满额 5）**：一回合理顺两对是整理，理顺五对就是在为一轮复盘烧五次 LLM 调用。
- **只在 `adds > 0` 时跑**：本轮没新增候选就说明手册没在长，为一次纯属「整理」的合并花 LLM 调用不划算。0 候选分支（`lib/recap-pipeline.js` 里 `!candidates.length` 那一支）因此**保持原样**，没给它加轻量合并。
- **落盘通道与满额路径完全相同**：轻量分支产出的 `ops` / `moves` 填进同一对 `mergeOps` / `mergeMoves`，最终走同一个 `ops = mergeOps.concat(finalOps)` → `commitOps(..., { merged: mergeMoves, ... })`。归档原因仍是 `merged`，「先写 `archive.md` 再写手册」的顺序仍由 `commitOps` 保证 —— 没有第二条落盘通道。
- **失败只 warn**：`planMerges` 本身永不抛错，`tryMerge` 外层还有 catch；轻量分支把失败聚合记成 `dsh-ace: 轻量合并失败 N 对（a↔b:reason），跳过它们继续（绝不让复盘落盘失败）`，成功记 `dsh-ace: 轻量合并（不满额）成功 N 对（archivedId→keptId）`。**合并失败绝不许阻塞落盘**这条红线在两条路径上同一口径。

接线细节：`tryMerge(deps, { ..., thresholdRatio, maxRounds })` 多了两个可选入参（`lib/recap-pipeline.js`），**不传就是老行为**；常量 `MERGE_EAGER_THRESHOLD_RATIO = 0.75` / `MERGE_EAGER_MAX_ROUNDS = 2` 与 `MERGE_MAX_ROUNDS = 5` 一起放在 `lib/merge-llm.js`（理由注释也在那里）。机检：tests/recap-pipeline.test.mjs 的 5 条 `e｜…` 用例（不满额真合并 + 归档 reason=merged、`adds===0` 时 `mergeAsk` 零调用、比率 0.505 的中等相似对不许被吃掉、合并抛错不阻塞落盘、最多 2 对）。

### 归档独立文件（第 33 轮）

**结论：归档条目从手册里搬出去，落到与手册同目录的 `archive.md`。**

改前归档写在手册末尾的 `## 归档区` 章节下。搬走的理由：

- **手册是注入与检索的输入**，每读一次都要把整本解析一遍；归档条目只增不减，章节只会越来越长，而它对注入毫无贡献；
- **归档只给人看**：注入不读它、`ace_playbook` 整本读取**不再附归档区**（改前是附的）。这条同时消掉两种事故：模型把归档条目当成「现在还有效的经验」照用；以及人误以为手册里有用的部分被裁掉了；
- 手册文件因此**永远不再出现 `## 归档区` 章节**（`lib/entry-format.js` 的 `parseEntryDocument` 不认它、`serializePlaybook` 不写它）。老手册里的残留章节按普通正文行处理（挂进 `extraLines`，不丢内容、不报错）。

文件位置由 `lib/playbook-path.js` 解析，**不写死绝对路径**：`resolveArchiveFile(configured, options)` = `path.dirname(resolvePlaybookFile(...))` + `'archive.md'`（与手册永远同目录，工作区私有手册就配工作区私有的归档）；`resolveSharedArchiveFile` = `<DSH home>/ace/archive.md`（本机共享，默认态）。

格式与手册**同构**（同样的条目块 + 元数据行 + 一行归档标记），人可以直接读、直接手改：

~~~
### [ace-003] 旧标题
- 条件：…
- 做法：…
- 依据：…
- 元数据：created=2026-01-02T09:10:11.200+08:00 updated=2026-02-01T18:20:31.400+08:00 hits=3 lastHit=2026-01-20T08:00:00.000+08:00
- 归档：reason=evicted date=2026-10-25T06:12:33.412+08:00
~~~

归档标记**紧跟 `- 元数据：` 之后**，由 `formatArchiveLine` / `parseArchiveLine`（lib/entry-format.js）产出与解析，被取代的多一段 ` supersededBy=ace-012`。**写入同样走 `withExclusiveLock` + `writeFileAtomic`**（`appendArchivedEntries`，lib/archive-file.js），且**先写归档文件、再写手册**——反过来一旦手册写失败，被淘汰/合并的条目会从两边一起消失，等于物理删除。同 id 的条目保留先到的（幂等，重复搬移不会写两份）。归档文件不存在时 `readArchiveSnapshot` 返回空归档且**不造文件**。

**这个顺序现在有可观测量钉住，不再只是注释里的承诺**（第 34 轮）：把 `archive.md` 造成一个目录，`appendArchivedEntries` 必然抛 `EISDIR` —— 此时手册必须**字节完全未变**（不是「条数相同」，是 `Buffer.equals`）、被淘汰的条目一条都不许蒸发、归档里不许出现新条目；`commitOps` 与 `commitCapacity` 两条写入路径各有一条这样的用例（tests/archive.test.mjs 的 h1 / h2），另一条 h3 用手册**故意不写高水位标记行**把「先归档、后手册」的顺序单独钉死——两行对调之后手册会先被写成高水位 4 再抛错，h3 立刻变红。**为什么非要有这一组**：审查变异 M5/N11 把这两行包进 try/catch 吞掉之后，活跃条目静默蒸发、归档一个字都没写、进程不报错，而旧套件 458 条**全绿**——生产行为当时是对的，但没有任何用例能发现它变坏。

### 归档的四个原因

`ARCHIVE_REASONS`（lib/entry-format.js）定死四个值，设置页按这四个分列：

| 原因 | 判据 | 载体 |
| --- | --- | --- |
| `superseded` | 同标题 / 近似的旧条目被更完整的候选取代 | `resolveSupersedes`（lib/archive.js） |
| `removed-by-request` | 调用方显式 `op:'remove'` | `applyOps` 产 `removedEntries`，`commitOps` 并进归档 |
| `evicted` | 满额且合并后仍超限，按 `compareForEviction` 挑出来的 | `planEvictions`（lib/evict.js） |
| `merged` | 满额合并成功后被并入存活条目的那一条 | `planMerges`（lib/merge-llm.js） |

改前的 `low-score` / `decayed` / `stale` 三个原因随三判据一起删除（没有净分就没有出局线，也就不需要低分与滞留兜底）。

**归档永不物理删除**：`applyArchiveMoves` 只做「从活跃数组挪到归档数组」，两个文件里的条目总数只增不减。归档条目**不参与检索与合并**（`matchEntries` / `markHits` / `computeMergeSuggestions` 都只吃 `parsed.entries`），`maxEntries` 也只数活跃条目；但 **ID 高水位必须把归档编号算进去**（`Math.max(readIdHighWater(parsed), maxEntryIdNumber(entries), maxArchivedIdNumber(archives))`，lib/commit.js），否则归档掉的最高号会被下一次新增重用；而且这个 `Math.max` 必须落在**满额淘汰之后**。

### 候选并入：三分支判定表（C4.2，**判定不调 LLM**）

**Curator 的 LLM 调用已删除**（`CURATOR_SYSTEM` 从 lib/prompts.js 移除）。理由是这条判定本来就不需要模型：候选与既有条目的关系只有三种，全部能用写死的规则判，而让模型挑「覆盖哪一条」会引入「挑错 id → 覆盖掉不相关的条目」这一类静默损坏。判定表在 `decideCandidates(entries, candidates)`（lib/archive.js）：

| 分支 | 条件 | 动作 | 理由 |
| --- | --- | --- | --- |
| ① 完全重复 → 丢弃 | 候选与某条既有条目的 `normKey`（title+condition+action 归一化）完全相同 | `dropped.push({index,title,reason:'duplicate'})`，不产生 op | 一模一样的内容再写一遍只是噪声 |
| ② 命中既有条目 → 原地更新或新增并归档旧的 | 先找**同标题**（`normTitle`）的条目；没有同标题再用 `computeMergeSuggestions` 的 BM25 对称比率（`MERGE_THRESHOLD_RATIO = 0.5`）取最相近的一条 | 见下两行 | 同标题优先于相似度：标题是人写的语义标签，比 BM25 更准；相似度只在「换了个标题说同一件事」时兜底 |
| ②-a 缩水到一半以下 | `shrinksTooMuch`（`BREVITY_MAX_SHRINK_RATIO = 0.5`） | `op:'add'`（`auto:true`）+ `supersedes.push({oldId, candidateIndex, key})` | 把正文砍到不足一半不是「更新」，是换了一条新经验；旧条目按 `superseded` 归档 |
| ②-b 其余 | 候选正文不比旧条目短 | `op:'update'` + `id: match.id`，**id 不变、原地改** | 只加不减的改动就该留在原 id 上，命中史与高水位都不用动 |
| ③ 没命中 → 新增 | 既无同标题、也无 BM25 达标条目 | `op:'add'`，`auto:true` | 唯一会让手册自动变长的分支（另一处是满额合并留下的那一条，见「LLM 合并」） |

**改前的 `netScore(match.meta) > 0` 分支已删除**：现在只有「正文缩没缩水」两条判据，不看任何分数。落盘仍走 `commitOps`，`options.archive` 是锁内钩子：`applyOps` 之后、写盘之前算出要搬走的条目（`makeArchivePlan`，lib/recap-pipeline.js —— 先 `resolveSupersedes` 处理「被取代」，再并上满额淘汰/合并产生的 `moves`），然后**先写归档文件、再写手册**。所以不存在「正文写成功、归档没写」的中间态（反过来「归档写了、手册没写」时条目仍在活跃区，等于多了一份归档副本，可接受）。

### 为什么注入必须追加进历史、不能改写系统提示（第 28 轮）

**结论：注入只能以「追加一条 user 消息」的形式进入上下文，绝不许出现在系统提示段里。** 这不是风格问题，是前缀缓存的经济性问题。

**根因。** 系统提示在请求的最前面。本插件跑的那条路由（`magpie/group/never-stuck`）没有声明 `systemPromptUpdate:'in-history'` 能力，宿主于是只能把 section 的渲染文本**原地重写**进首个系统节点——它没有别的办法把「变了的一段文字」表达成「历史里追加了一个节点」。改前 `lib/prompt-section.js` 的 `text` 回调里调 `injection()`（该接线已在第 41 轮删除），每换一批经验，从注入点（**系统提示 25.0% 处**）往后整段缓存前缀全部作废。

**实测代价**（真实 provider 缓存账本，改前的数据）：

| 指标 | 改前 |
| --- | --- |
| 切换请求的 `cached` | 恒为 **8,320 tok**（正好是注入点之前那段前缀，注入点之后全重算） |
| 单笔重付 | **87.1K / 88.4K / 73.4K / 97.8K** token |
| 切换次数 | **73** 次 |
| 累计重付 | **926.0K** token |

**为什么追加就没事。** `agent/pre-step` 返回的 `messages` 是本步请求的消息批次；往**末尾**插一条消息只往历史尾部加节点，前面所有 token 的字节完全不变，缓存前缀照常命中。所以第 28 轮把注入搬到 `lib/inject-delivery.js`：`await next()` 拿到 decision → 只有主代理且存在未投递批次时才 `decision.messages.toSpliced(len, 0, message)` → spread 保留 `startsRequestSeries` 等其它字段。

**代价（诚实的部分）**：系统提示段因此变成**逐字常量**（`lib/prompt-section.js`，只剩三行/五行的机制说明），原先挂在段里的「手册里有 N 条疑似重复条目」动态句一并删除——它同样是随状态变化的文本，同样会改写前缀。那条信息现在的出口是 HTTP `GET /api/dsh-ace/inbox` 与 `/ace review` 命令。

**注入消息不进复盘轨迹（避免 Reflector 复述自产内容）。** 追加进历史的注入是一条普通的 `role:'user'` 消息，`session.deriveMessages()` 会把它算进模型可见历史。若照常喂给 Reflector，会自污染两层：① 每次复盘白白多送几百到上千 token 的自产内容；② 更实质的是，Reflector 会把「手册里已有的经验条目」当成「本轮用户说过的话 / 出现过的事实」再提炼一遍，产出与既有条目高度相似的候选，撞进 `decideCandidates` 的近似重复分支——候选比旧条目短就走「新增 + 把旧条目按 `superseded` 归档」，不短就用一段被复述过的文本原地覆盖真实条目（第 33 轮起只剩这两条正文判据，不再看分数）。所以 `lib/trajectory.js` 的 `isAceInjectionMessage`（:139）在 `renderMessage` 入口整条跳过 `source.kind === 'dsh-ace' && source.form === 'injection'` 的消息。**过滤条件只认这两个字段**，不是「所有非用户手打的消息都跳过」：`form:'notice'` 等其它插件自产消息照旧渲染；这两个字符串字面量必须与 `lib/inject-delivery.js` 的 `INJECTION_SOURCE_KIND` / `INJECTION_SOURCE_FORM` 一致（trajectory.js 零 import，不能 import 那两个常量，改动任一处要同步另一处）。

**机检**：tests/e2e.test.mjs 场景 6 断言注入正文出现在 `agent/pre-step` 追加的消息里、且 `sectionText` **不含** `【ACE 自动注入】`；tests/prompt-section.test.mjs 断言 section 文本在「有注入 / 无注入」「inboxCount 0 / 3」两态下逐字相同；tests/trajectory.test.mjs 的五条「第28轮｜…」用例断言注入消息不进轨迹、去掉 source 后照常进、`form:'notice'` 等五种「只命中一半条件」的消息照常进、畸形 source 不抛错。

### 自动注入：排序键、预算、token 估算

用户消息进会话时（`agent/inbox/inserted`）先做一次预检索，把「本回合最相关的几条经验」算好缓存；然后在**下一步进入时**（`agent/pre-step` waterfall，lib/inject-delivery.js）取走这一批，渲染成 `【ACE 自动注入】…` 块，**作为一条新的 user 消息追加到本步消息批次的末尾**——不改写系统提示（为什么必须这样，见下节）。

- **排序键**（`rankInjection`，lib/inject.js）：第 33 轮起是**纯 BM25 相关度**，第 36 轮改回加权但只加「话题热度」这一项：`0.9 × 归一化相关度 + 0.1 × 归一化话题热度`（同分仍按 `idNumber` 数字升序兜底）。更早的 `0.85 × 归一化相关度 + 0.15 × 净分饱和` 已在第 33 轮随净分一起删掉。三条理由：① 净分已经不存在；② 权重是拍出来的，没有可验证的依据；③ 更要紧的是**自增强陷阱**——任何让「命中多的条目排得更前」的排序键都会把手册锁死在少数几条上（排前 → 更常被注入 → 更常命中 → 更排前），而最少使用淘汰恰好按 `hits` 排序，两者一叠加，新条目永远等不到第一次命中就被淘汰。所以 `hits` **绝不许进排序键**（tests/inject.test.mjs 的「k｜hits 高低不影响注入排序」钉住）。
- **0 分条目不进候选**：本批最高分 ≤ 0 时整批丢弃（与当前任务零字面交集的经验不值得占 900 token），此时返回空注入、`injectedSkipped + 1`。
- **预算**：条数与 token 预算都已提成配置项（第 36 轮）——`injectMaxEntries`（默认 5、可填 1–20）与 `injectTokenBudget`（默认 900、可填 100–8000），常量 `INJECT_MAX_ENTRIES = 5` / `INJECT_TOKEN_BUDGET = 900` 仍作兜底默认值（配置缺失/非法时回落）。第一条无条件取（否则相关度低一点就一条都注不进去），之后每加一条先试算整块 token，超预算就停；`rationale`（依据行）如果撑爆预算则整体关掉。
- **token 估算**（`estimateTokens`）：不引 tokenizer，按字符类别加权——ASCII 字符 × 0.4、非 ASCII（含汉字）× 1.0，求和后先按 1e-6 精度取整再向上取整。0.4 是经验值（英文约 2.5 字符/token），1.0 是保守值（汉字约 1 字/token）。**这是估算不是计量**，所以预算留了余量（900 而不是贴着模型上限）。
- **注入块形态**（`renderInjection`）：首行里的「最多 N 条」**必须说真话**——N 由生效配置 `injectMaxEntries` 经 `selectInjection` 的 `options.maxEntries` 透传进来（第 37 轮修：此前硬编码常量 5，配置成 8 时首行在说谎）；未传/传 0/传非法值一律回落 `INJECT_MAX_ENTRIES`（宁可说「最多 5 条」，也不说「最多 0 条」）。首行 `【ACE 自动注入】与本回合最相关的 N 条经验（按检索相关度排序，最多 N 条）：`，每条 `N. [id] 标题` + `   - 何时适用：…` + `   - 怎么做：…`（可选 `   - 依据：…`），末行提示可用 `ace_playbook` 查全量手册。**末行不再提归档**——归档条目不在任何会话里（第 33 轮）。
- **绝不抛错**：投递（认领批次 → 造消息 → 追加）整段包在 try/catch 里（`createInjectionDelivery().onPreStep`），失败只写一条 warn、`injectedFailed + 1`、原样返回下游 decision——**pre-step 监听器抛错会打哑整回合**（与 section 回调抛错同一类事故模式），插件不能把宿主搞挂。系统提示段（lib/prompt-section.js）现在只有逐字常量，已经不需要任何 try/catch。

### 话题热度（第 36 轮）：只由用户消息驱动，且不许绕过相关度

**结论：注入排序键改成 `0.9 × 归一化相关度 + 0.1 × 归一化话题热度`；热度只由「用户说过的话」产生，注入结果绝不回灌进热度；入候选的门槛仍然是「有字面交集」。**

- **怎么算**（`lib/heat.js`）：每个 agent 一个 30 条的环形窗口（`HEAT_WINDOW_MESSAGES = 30`；`createHeatWindow()` 的 `note(agent, text)` 超 30 条丢最老的，`messagesOf(agent)` 返回副本，WeakMap 按 agent 隔离，`clear(agent)` 只清一个 agent）；`computeHeat(entries, messages)` 对窗口里每条消息各跑一次 `rankInjection(entries, text)`，取 `score > 0` 的前 `HEAT_TOP_PER_MESSAGE = 3` 条各 +1。
- **为什么只由用户消息驱动**：窗口里只进 `userTextOf(message)`，**不是**注入块文本。若把注入出去的条目再喂进 `computeHeat`，同一条经验就会「被注入 → 涨热度 → 排得更前 → 更常被注入」自我放大——这正是第 33 轮拆掉净分项要躲开的自增强棘轮，换个名字（热度）照样锁死手册。所以 `computeHeat` 内部调 `rankInjection` 时**从不传 heat**：热度是纯观测，绝不参与自己的产生过程（tests/heat.test.mjs 有一条例把伪造的热度图反复喂回去，断言 id 顺序与计数一字不变）。
- **为什么 0 相关度不许靠热度进入**：热度只能在**本来就有字面交集（`score > 0`）**的候选之间重排。若热度能把 0 分条目顶进候选，最热的那条经验在任何话题下都会被注进去，注入就退化成「always-on 的固定前缀」——既白花 token，也把「本回合相关」这个前提作废。`rankInjection` 因此先按 `score > 0` 过滤、再算 composite（tests/heat.test.mjs 的「热度 9999 也进不去」钉住）。
- **归一化与确定性**：`heat[id] / 本轮候选里的最大 heat`；候选最大值为 0（或 heat 为空、缺键）时全部按 0 算，不出 NaN；`composite` 相同仍按 `idNumber` 升序，同一份输入两次跑必然给出同一个顺序。`options.heat` 传 Map 或普通对象都认。
- **接线**（`lib/index.js`）：`agent/inbox/inserted` 里 `heatWindow.note(agent, query)` 是**同步**的（顺序 = 消息到达顺序），预检索再 `computeHeat(snapshot.entries, heatWindow.messagesOf(agent))` 传进 `selectInjection`。窗口是进程内状态，宿主重启即清空。

### 命中账本：注入 → 回合边界一次原子写盘

「这一轮注入过哪几条」必须传到落盘那一步，才能给它们 `hits += 1`。四段接缝（lib/ledger.js + lib/injection-flow.js + lib/recap.js）：

1. `publish(agent, key, picked)`：预检索结果按「用户消息 key」缓存，同一消息的每个 step 不重复检索；
2. `take(agent)` + `note(agent, ids)`（lib/injection-flow.js）：`agent/pre-step` 里 `take` 只**认领**「已发布但尚未投递」的那一批（`delivered` WeakMap 记住上一条交付过的 key，同一批第二次调用返回 `null` —— 同一回合后续每一步都不会重复追加，一次注入只记一次命中）；消息**真的造出来并追加进 `decision.messages` 之后**才 `note` 把 `ids` 记进账本。拆开的理由：造消息/追加抛错时若已记账，就会留下「账本里有、历史里没有」的幽灵命中。**账本只给主代理记**（`isMainAgent` 门）：子代理连投递都不做，也不进账本；
3. `takeHitIds(agent)`：**唯一的取走点**是回合边界 `agent/turn-stopping` → `onTurnStopping`（lib/recap.js），取走即清空，然后立刻 `flushHitsNow` 一次原子写盘；冷却回合 / 阈值未到的回合**同样取并写**——否则那些 id 会留到下一回合被误记成下一回合的命中；
4. `flushHits(agent, ids)`：回调到 `recordHits`（lib/index.js）→ `commitMeta` + `markHits`，锁内重读最新手册、只改 `hits` / `lastHit`、原子写。同 agent 的多次落盘串在一条 Promise 链上（`hitFlushes`），空闲边沿跑复盘前**先 await 这条链**，避免复盘读到的 `hits` 是上一批落盘前的旧值。

**流水线自己不碰账本**：`runRecapPipeline` 既不取账本也不写 `hits`，只做「读快照 → 复盘 → 判定 → 合并/淘汰 → 落盘」。于是「同一批 id 只记一次」是结构性的，不靠调用顺序自觉。

**写盘失败不阻塞，但绝不真丢**（第 34 轮修正）：`flushHitsNow` 失败只写一条 warn（`dsh-ace: 命中落盘失败（…），这批命中已退回账本，下个回合边界重试`），**并把这一批 id 原样写回账本**（`lib/recap.js` 的 `noteHitIds` → `lib/ledger.js` 的 `note`，复用既有写入通道，不另造状态机）。账本在回合边界取走时就清空了，所以「只 warn 不退回」等于把这批命中物理丢掉——旧实现正是如此，warn 文案「下个回合边界再记」是一句**没有实现的承诺**（`tests/recap-usage.test.mjs` 的用例当时还把这句话钉成了契约）。现在下个回合边界取走的是「退回的那批 + 本回合新命中」的合并结果，一次写盘，账本随之清空。回合结束这条链路照旧绝不抛错；生产接线让 `recordHits(..., { throwOnError: true })` 把失败抛给调度器，只有 `ace_playbook` 检索那条路径继续吞错（那里有「检索结果照常返回」可保）。没有 `noteHitIds` 可退的调用方退化为「丢弃 + 明说已丢失」。

**计分时代的时序机制已整层删除**：`settling` / `settlingIds` / `usages` / `pendingUsageIds` / `settlePendingUsage` / `hasPendingUsage` / 归档扫描的 `pendingIds` 排除链，全都只为「别把分记错」而存在。没有分数就没有「先结算再归档」的时序要求，这些约束失去存在理由，不许以任何理由加回来。**跨进程锁与原子写一条都没动。**

### 可观测：内存计数器 + 一行日志

设置页「ACE 运行统计」块的数全部是**进程内存态**（宿主重启即归零），**不新增任何落盘文件**：每次累加都同时写一行 `dsh-ace: …` 日志，页面上的数与进程日志能一一对上。第 33 轮把六个数字换血（改前的复盘次数 / 候选数 / 落盘数 / 计分变动 / 考察位 / 未观测 / 闸门拦下全部删除）：

| 数 | 名字（页面） | 来源 | 日志 |
| --- | --- | --- | --- |
| 注入批次 | 注入批次 | `injectionStats.batches`（预检索命中并发布一批 +1；量级 ≈ 用户消息数） | `dsh-ace: 注入批次已发布（N 条经验：ids，约 T token；累计批次 K）` |
| 注入追加 | 注入追加 | `injectionStats.appended`（这一批**真的**追加进历史 +1；同一批只 +1，所以恒 ≤ 批次） | `dsh-ace: 注入已追加进历史（…）`；失败 `dsh-ace: 注入追加进历史失败，本步不注入（…）`；预检索失败 `dsh-ace: 注入的预检索失败，本回合不注入（…）` |
| 检索命中 | 检索命中 | `retrievalStats.hits`（`ace_playbook` 带 query 或 id 的定向查找命中条数；**整本读取不计数**） | 每次定向检索一行 `dsh-ace: ace_playbook 定向检索命中 N 条…` |
| 淘汰数 | 淘汰数 | `archiveStats.byReason.evicted`（满额且合并后仍超限，按 `compareForEviction` 搬进归档的条数） | 每次腾位一行 `dsh-ace: 满额淘汰 N 条…` |
| 合并数 | 合并数 | `archiveStats.byReason.merged`（满额合并成功的对数，每对一条被并入归档） | 每对一行 `dsh-ace: 合并成功 ace-XXX ← ace-YYY…` |
| 归档数 | 归档数（含按原因分列） | `archiveStats.archived` 与 `byReason{superseded,removed-by-request,evicted,merged}` | 未知原因会 warn `dsh-ace: 未知归档原因 …，已计入总数但未分列` |

**为什么注入要拆成两个数**：改前的单个 `injected` 数的是「系统提示段被重新渲染了几次」，而 section 每一步都会求值一次 —— 于是它约等于**步数**，被误读成「检索频率」（页面上的数虚高，看着像每条消息挑了很多次经验）。现在的口径是：`injectedBatches` = 每次预检索命中并发布一批（量级 ≈ 用户消息数）；`injectedAppended` = 这一批真的追加进历史（同一批只 +1）。两个数一起看才有意义：`appended` 明显小于 `batches` 说明投递在某处失败（看 warn 日志），`batches` 远小于用户消息数说明检索经常无命中。设置页在明细行下面配了一句人话解释（`runtimeInjectHint`），不让用户自己去猜两个数的差别。**不许再新增 `injectedRenders` 之类的第三个口径**——两套口径并存必然对不上账。

**「检索命中」与「注入批次 / 注入追加」正交**：它数的是**人在 `ace_playbook` 里点名找过某条经验**的次数，而不是插件自动挑出来的次数。整本读取不计——通读全书不是「用到某条」，计进去会让这个数彻底失真（一次通读就能把命中数刷到条目总数）。这个数同时是 `hits` 的另一半来源，所以它与「淘汰数」是同一条因果链的两端：`hits` 由前三个数喂大，淘汰由它挑人。

聚合与归一化在 `lib/stats.js` 的 `normalizeRuntime`——恒返回 **7 个键**（`injectedBatches` / `injectedAppended` / `retrievalHits` / `evicted` / `merged` / `archived` / `archivedByReason`）、缺字段补 0，所以空态与成功态的字段集合完全一致（客户端不必判 undefined）。缺字段补 0 的代价是「老宿主上显示一排 0」，所以客户端对「整个 `runtime` 不存在」的情况单独显示一行灰字（见「设置页顶部的只读统计」）。改前的 `recaps` / `candidates` / `written` / `helpful` / `harmful` / `unobserved` / `gateRejected` / `injectedProbation` 全部删除，**不许两套口径并存**（tests/wiring.test.mjs 的字段断言钉住）。

## 对外接口

**结论：模型可见三个工具，人可见一个配置对象；此外无任何对外面。**

| 接口 | 形态 | 要点 |
| --- | --- | --- |
| `ace_playbook` | 工具 | `id` 精确过滤；`query` 以片段（空白/标点拆分，汉字块 2-gram）为 term 对当前条目做 BM25 排序（k1=1.2, b=0.75；idf=log((N-df+0.5)/(df+0.5)+1)；tf 在条目四字段拼接文本上计，实现在 `matchEntries`/`querySegments`，lib/playbook.js）；命中条目按得分降序（同分保持原序），无有效片段或全 0 分时整本兜底；只读，`isConcurrencySafe` 为真。**首读即建文件**（手册不存在时建出带文档头的空手册）这一小段在写锁内完成（`withExclusiveLock`），其余过滤计算在锁外 |
| `ace_reflect` | 工具 | `summary` 必填、`outcome` 可选（**只作为提示词里的上下文，不参与判定**——回合成败判定已整层删除）；LLM 复盘返回候选数组（**只产候选、不落盘**，落盘走 `ace_curate`）；120s 协作超时。同样：首读建文件在锁内，LLM 在锁外 |
| `ace_curate` | 工具 | `ops` 批量增量；`dedupe` 默认对 add 做**确定性**去重（`decideCandidates`：完全重复丢弃 / 候选缩水到一半以下则新增并归档旧的 / 否则原地更新），**不调 LLM**；候选过滤只剩「标题非空」。**两段式**：锁外读快照 + 纯代码判定 → 锁内重读最新手册 + 逐条冲突检测 + 校验 + 归档 + 原子写（见 I5）；输出含 `conflicts` 字段，被并发冲突拦下的条目逐条列出（见 I5c/I5d） |
| 自动复盘 | 内部路径（非工具） | 回合内只记账、空闲边沿才执行（见 I9）；复盘主体与 `/ace` 命令共用同一函数（`executeRecap`） |
| `/ace` 命令 | 命令 | 手动跑一次复盘（Reflector 多轮 + 确定性判定，走 `executeRecap` → `commitOps`，**会写手册并把冲突回报给用户**，见 I5d）；撞上宿主忙碌时给一句人话提示（`ace: agent 正在忙，稍后重试。`），不把宿主英文错误甩给用户。子命令 `/ace review` 是另一回事：**只读** merge-inbox，把待合并条目注入对话，不写手册、不做冲突判定 |
| `Config` | 配置 | 字段与默认值见 README「配置」表（`playbookPath` 默认空串 = 本机共享手册，`maxEntries` 默认 100） |
| 系统提示段 `ace-playbook` | order 860 | **恒注册**（`playbookSectionSpec`），但两个开关都关时 `text()` 返回空串；文本只有逐字常量，注入块与 inbox 计数句都不在这里（见「为什么注入必须追加进历史」） |

模型路由解析链：配置了 `reflectProvider`+`reflectModel` 则覆盖优先；否则 `session.requestHeader().config` → `agent.options`（与会话同模型）；解析不出则报错要求显式配置。

### 设置页：为什么是两个下拉 + 可清空

`reflectProvider` / `reflectModel` 是**成对生效**的：`resolveRoute`（lib/llm.js）只在两项都非空时才采用覆盖值，只填一项等于没填、静默回落到会话模型。所以设置页不做「一个输入框填 model 全名」的自由文本，而是：

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

数据来自 `ctx.llm.listProviders()`（同步）+ 逐个 `ctx.llm.listModels(id)`（异步），组装逻辑在 `lib/catalog.js`（`buildCatalog`，纯逻辑可测）。**逐个 provider 各自 try/catch 并带 15s 超时**：某个 provider 抛错或卡住，只让它自己的 `models` 为 `[]` 并附一条 `error` 字符串，接口整体仍 `ok: true` —— 设置页其余字段因此永远可用。**超时只放弃等待、不 abort 上游**：宿主的 `LlmRuntime.listModels(provider)` 没有 `signal` 形参，provider 适配器那层同样只收 provider id，没有可中止的把手（见 `lib/catalog.js` 的注释）；泄漏面有界（一次请求最多一个 provider 一条悬挂 promise），上游晚到的 reject 会被吞掉、不会变成 unhandledRejection。围栏与 `/settings` 一致（先 `rejectionFor` 做回环同源校验），只认 GET，其他方法 405。宿主还没重启到带这个接口的版本时前端拿到 404，两个下拉面板里显示一行错误提示，不阻塞页面。

### 设置页顶部的只读统计：为什么是「观察者」

**结论：统计块是纯观察者，另开一条只读端点，聚合逻辑抽成纯函数；它不参与任何写入路径。**

| 决定 | 理由 |
| --- | --- |
| 新增 `GET /api/dsh-ace/stats`，不复用 `/settings` | `/settings` 的语义是「可写配置的读/写」，往里塞统计会让一条写路径的返回体长出只读字段；另开一条只读分支与 `/catalog`、`/inbox` 并列，围栏（`rejectionFor`）与 405 口径完全一致 |
| 聚合逻辑放 `lib/stats.js` 的纯函数 | `summarizePlaybook(text, opts)` 只吃字符串与注入的 `now`，单测可直接喂样例手册；`readPlaybookStats`/`collectPlaybookStats` 只 stat + readFile，**不写盘、不加锁**，因此不碰 `withLock`/`writeFileAtomic`/`commit.js`/`merge.js` 任何一条写路径（红线 ②不受影响） |
| 一律 `ok: true` + `reason` 降级，绝不 500 | 与 `/inbox` 同款静默降级：相对路径在 HTTP 面没有会话工作目录（`resolvePlaybookFile` 抛 `RELATIVE_PATH_NEEDS_SESSION`，lib/playbook-path.js）、文件不存在、文件为空、读盘失败，四种都返回结构相同的空态 + 一个 `reason`，设置页其余字段照常可用 |
| 正文字符数口径 = `title+condition+action+rationale` | `parsePlaybook` 已把 `- 条件：` 这类 Markdown 标记剥掉、元数据行单独收进 `meta`（lib/playbook.js 的 `parsePlaybook`），因此 `entryTextChars` 量的就是正文本身，不含标记与元数据 |
| 规模快照只显示条目数/正文字符/文件字节/最后写入，不在这里逐条摊开 `hits`/`lastHit` | `hits` 是逐条数据，塞进聚合快照会把「一本书有多大」和「每条被用过几次」两种粒度混在一起。逐条命中在记录列表页看；**汇总口径**（淘汰数 / 合并数 / 检索命中）放在下面的「ACE 运行统计」块里。改前这里还争过 `helpful`/`harmful` 该不该进快照，那两个字段已随评分层删除。`auto` 有真实语义（复盘/curate 自动落盘的条目），仍以占比展示 |
| 时间分布 = 纯 CSS 迷你条形图 | 不引图表库（红线 ⑤：不新增运行时依赖，浏览器半边保持只有 `React.createElement` + 本文件 CSS）；14 行日期 + 一根宽度按比例的内联 `style` 百分比条，**不动态注入 CSS 规则** |
| 打开页面拉一次 + 区块自带「刷新」+ 保存成功后重拉 | 统计是读操作，不需要实时；但改了 `playbookPath`/`maxEntries` 之后数字会立刻过期，所以保存成功后顺手重拉一次，避免用户以为没生效 |
| 「ACE 运行统计」与「手册统计」是两个块、两套类名（`.ace-runtime-*` vs `.ace-stats-*`），不复用同一套 | 两者的生命周期完全不同：手册统计随文件变化（换一本手册数字就全变），运行统计随**进程**变化（重启归零、与手册无关）。放在同一个网格里会让人以为「刷新页面就能改」，而它们各自的刷新条件不同（前者看文件、后者看进程）；类名分开还让既有用例里「统计块内恰好 N 个格子」这类精确计数断言保持有效 |
| 运行统计缺失时只显示一行灰字，不显示 0 | 老宿主（`/stats` 还不返回 `runtime` 的版本）上，把「没有这个字段」渲染成一排 `0` 是假数据——用户会以为本会话真的零复盘。缺字段就明说「本次会话的运行统计不可用」 |

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
  recent: [ { id, title, updated } ],         // 最多 5 条，按 updated 倒序
  runtime: {                                  // 本次会话的运行统计（内存态，重启归零；空态与成功态同形）
    injectedBatches,                         // 注入批次：预检索命中并发布一批
    injectedAppended,                        // 注入追加：这批真的追加进历史（同一批只 +1）
    retrievalHits,                           // 检索命中：ace_playbook 带 query/id 的定向查找命中条数（整本读取不计数）
    evicted, merged,                         // 淘汰数 / 合并数（满额时先合并，合并后仍超限才淘汰）
    archived,                                // 归档总数
    archivedByReason: { superseded, 'removed-by-request', evicted, merged }   // 按原因分列，四键恒在
  }
  }
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
| 归档分区**只读**，没有删除/还原按钮 | 归档条目不参与检索/合并/注入，它们的价值是「历史还在文件里可查」；给它们做删除入口等于把「永不物理删除」这条红线交到一次误点击手上。要清理归档文件只能手工编辑 `archive.md` |
| 手动归档另开一条**写**路由 `POST /api/dsh-ace/entries/archive`，不塞进 `/entries` 的 POST | `/entries` 的语义是「只读观察者」，往里塞写会让一条观察者端点长出副作用；写路由与 `/settings` 并列、走同一条围栏，语义边界干净。详见下一小节 |

接口形状（只读、不落盘、不缓存，围栏与 `/stats` 一致，只认 GET，其他方法 405）：

```
GET /api/dsh-ace/entries
{
  ok: true,
  reason: null | 'missing' | 'needs-session' | 'unreadable',  // 只有降级体带这一键（成功体不带）
  entries: [ {                // 活跃区全量逐条，字段顺序即契约：正文缺失给空串、auto 恒为布尔、hits 恒为数字
    id, title, condition, action, rationale,
    auto, created, updated, hits, lastHit
  } ],
  archived: [ {               // 已归档条目，结构同 entries，多一个 archive 字段（读独立归档文件，只读展示，无删除入口）
    id, title, condition, action, rationale,
    auto, created, updated, hits, lastHit,
    archive: { reason, date, supersededBy }   // reason ∈ superseded | removed-by-request | evicted | merged（未知值原样透传）；supersededBy 缺省为空串
  } ],
  total: number,               // 只数活跃
  archivedTotal: number,       // 只数归档；两个计数互不混算
  maxEntries: number | null,  // 配置值原样透传；非有限数才为 null，HTTP 面恒为配置值
  pathKind: 'shared' | 'absolute' | 'relative',  // 只看配置值的形态，不需要会话上下文
  playbookPath: string        // 解析后的手册绝对路径（空串配置即本机共享层）；只有 needs-session 空态下回显配置原值
}
```

页面侧固定 20 条/页，搜索对 `id`/`title`/`condition`/`action`/`rationale` 五字段做大小写不敏感子串匹配，编号列按数字比较（`ace-2` 在 `ace-10` 之前，不是字典序），更新日期列按毫秒时间戳比较（第 33 轮起 `updated` 是毫秒精度，界面仍只显示到日）。

### 记录列表页：手动归档一条（HTTP 面上唯一的写路由）

**结论：给活跃条目加一个「两段式确认」的手动归档动作；后端只新增一条写路由 `POST /api/dsh-ace/entries/archive`，写入通道整套复用 `commitOps` 的 `remove` 路径。**

| 决定 | 理由 |
| --- | --- |
| 归档原因用既有的 `removed-by-request`，不新增第五种 | `ARCHIVE_REASONS` 的四原因（`superseded` / `removed-by-request` / `evicted` / `merged`）是归档文件的格式契约，`lib/entry-format.js` 的 `parseArchiveLine` 与设置页的四条原因文案都按它对齐。手动归档的语义就是「调用方显式移除」，与 `remove` op 的既有原因完全一致，没有新语义可表达 |
| 写盘只走 `commitOps`，不另开通道 | `commitOps` 的 `remove` 路径已经做全了四件事：锁内重读最新 + 冲突判定、`applyOps` 把归档原因写死成 `removed-by-request`、高水位取「活跃 + 归档两侧」最大值、**先 `appendArchivedEntries` 写 `archive.md` 再 `writeFileAtomic` 写手册**（红线 ②）。自己写一条通道等于把这四条约束抄一遍，抄错任何一条都是物理删除或编号复用 |
| 路由必须先于 `/entries` 判定吗？不必——但**必须用精确串比较** | `routePath` 是去掉 `/api/dsh-ace` 前缀后的**精确串**（`lib/index.js` 的 `url.pathname.slice(ROUTE_PATH.length)`），`'/entries/archive'` 与 `'/entries'` 是两个不同的值，写成 `startsWith('/entries')` 才会把两个混掉。本分支自带「非 POST → 405」，因此 `GET /entries/archive` 仍然 405，`/entries` 的 GET 语义一字不动 |
| 失败一律结构化非 2xx，只有真异常才 500 | id 形状非法 → 400；**不在活跃区**（含「已经在归档里」）→ 404；提交期间被并发改动、`applyOps` 没动这一条 → 409；读盘/写盘的意外异常 → 500 但带 `{ error }` 结构体。客户端对这四种一视同仁：把 `error` 渲染成页面上一行 `.ace-entries-note`，绝不静默 |
| 记账 / 日志 | 成功路径走既有的 `noteArchived`（`archiveStats.archived + 1`、`byReason['removed-by-request'] + 1`），再加一条 `dsh-ace: 手动归档 1 条（…）` 的 info 日志；`runtimeSnapshot()` 的七键协议不变（红线 ⑨：日志数字与 `GET /stats` 的 `runtime` 必须对得上） |
| 按钮放**详情区**而不是行内 | 整行本身是 `role="button"`（点行 = 展开/收起）。行内塞按钮要么得 `stopPropagation` 抢掉行的点击，要么键盘可达性出错（同一行两个可聚焦语义）。放详情区最干净：按钮是详情区里唯一可聚焦元素，行的键盘语义不受影响 |
| 两段式确认全在客户端本地，首点零写 | 首点只 `setPendingArchive(id)`；二点才 POST。pending 按 id 存、同一时刻只认一条：点另一条 = 换成那条；切分区 / 刷新 / 点页内别处一律清空。这样「误点一次」在任何情况下都不会落到盘上 |
| 归档分区仍然只读 | 归档条目只增不减（红线 ⑦）。手动归档只把条目从活跃区搬进 `archive.md`，归档区本身没有任何删除/还原/再归档入口 |

接口形状（写路由，围栏与 `/settings` 一致；只认 POST，其他方法 405）：

```
POST /api/dsh-ace/entries/archive
请求体：{ "id": "ace-NNN" }                  // 首尾空白先 trim；非 ace-<数字> → 400
成功：200 { ok: true, archived: { id, reason: 'removed-by-request', date } }
失败：400 { error }   // id 形状非法 / 手册路径解析失败（相对路径在 HTTP 面无会话工作目录）
      404 { error }   // 该 id 不在活跃区（不存在，或已经在归档文件里）
      409 { error }   // 提交期间被并发改动，applyOps 没动这一条（刷新后重试）
      500 { error }   // 读盘 / 写盘的意外异常
```


### 手册文件位置：默认本机共享层

**结论：手册默认只有一本、放在 `<DSH home>/ace/playbook.md`（本机即 `C:\Users\adkun\.dsh\ace\playbook.md`），跨工作区共用；填相对路径才退化成该工作区私有。**

解析由 `lib/playbook-path.js` 的 `resolvePlaybookFile(configured, { ctx, workingDirectory, env, home })` 完成（纯函数，env/home 注入可测）：

| 优先级 | `playbookPath` 形态 | 结果 | 典型用途 |
| --- | --- | --- | --- |
| ① | 绝对路径；`~` / `~/` / `~\` 前缀 | 原样使用（`~` 展开到 home） | 点名某一份手册 |
| ② | 相对路径（如 `.ace/playbook.md`） | 相对**会话工作目录** join | 该工作区私有，可随仓库进 git |
| ③ | 空串 / 缺省 | `<DSH home>/ace/playbook.md` | 本机共享（默认） |

`<DSH home>` 的解析链：`ctx.get('profileContext')?.home` → `$DSH_HOME` → `~/.dsh`（与 `lib/settings-path.js` 同范式；`~` 展开语义对齐 `@deepseek-ai/dsh-home-paths` `expandHomePath`，home 解析对齐同包的 `resolveDshHome`）。

只有 ② 需要会话上下文：HTTP 面（`/inbox`）没有会话工作目录，相对路径在那里解析不到文件，按「暂无可看待合并条目」返回空列表；①③ 在 HTTP 面照常解析——共享层的 merge-inbox 因此能被设置页读到。

父目录不存在的风险由 `writeFileAtomic` 内部的 `fs.mkdir(dir, { recursive: true })`（lib/playbook.js 的 `writeFileAtomic`）兜住：共享层的 `<DSH home>/ace` 首次使用时并不存在，`readOrInitPlaybook`（lib/playbook.js 的 `readOrInitPlaybook`）的 ENOENT 分支会立刻原子写，靠的就是这句 mkdir。

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

- 手册只增量演化，无整本重写路径——来源：ACE 方法论（细节磨平问题）——载体：`lib/prompts.js` 的 Reflector 提示词 + `applyOps` 仅暴露三操作 + `decideCandidates` 只产 add/update（机检：TESTING 用例）[评]
- 并发 curate 不写坏手册——来源：验收标准 3——载体：`withExclusiveLock`（`withLock` per-path Promise 链 + `withFileLock` 跨进程 `<file>.lock`，锁覆盖整个读-改-写区间；跨进程锁不抢占活着的持锁者，超时失败而非覆盖）（机检：withLock 三条、withFileLock 八条、withExclusiveLock 两条、writeFileAtomic 一条）[机检]
- 手册写入原子可见——来源：I6——载体：`writeFileAtomic`（tmp + rename）（机检：读写往返用例）[机检]
- LLM 输出结构化后才落盘——来源：I8——载体：`extractJsonObject` + 字段过滤（评）[评]
- 失败不产生半截状态：curate 任一步抛错则手册不变（锁内先校验后写）——载体：`applyOps` 事务校验（机检：事务式用例）[机检]
- 零第三方运行时依赖、无子进程、无 Python——来源：委派约束——载体：`package.json`（机检：无 dependencies 字段）[人]
- **归档条目永不物理删除**——来源：用户要求（历史可查、可回溯）——载体：`applyArchiveMoves`（lib/archive.js）只搬不删、`applyOps` 的 `remove` 只产 `removedEntries`（lib/playbook.js）、`commitOps` 把它们并进**独立归档文件**（`appendArchivedEntries`，lib/archive-file.js）。第 33 轮多出两个搬移入口：满额淘汰（`planEvictions` → `moves reason='evicted'`）与满额合并（`planMerges` → `moves reason='merged'`），两者同样只搬不删（机检：tests/archive.test.mjs、tests/e2e.test.mjs 场景 5 / 5b）[机检]
- **归档条目不参与检索/合并/注入，maxEntries 只数活跃，ID 高水位含归档**——来源：I2 + I4——载体：`matchEntries`/`markHits`/`computeMergeSuggestions` 只吃 `parsed.entries`；**四项** `Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries))`（lib/commit.js，`commitOps` / `commitCapacity` 的 `mergedOps` / `commitCapacity` 最终写盘三处口径一致），且这个 `Math.max` 必须落在**满额淘汰之后**；`maxArchivedIdNumber` **吃的是归档原文**、只扫 `^\s*###` 标题行取 `/\[?ace-(\d+)\]?/`（第 34 轮——`parseArchiveFile` 认不出旧格式 `### ace-500` 与空标题 `### [ace-888]`，但这两个形状确实占掉了编号，人工手写归档就能触发复用；正文里偶然出现的 `ace-999` 不算）；归档不进任何会话（注入不读它、`ace_playbook` 整本读取不附归档）（机检：tests/playbook.test.mjs、tests/entries.test.mjs、tests/wiring.test.mjs 的「h｜整本读取不含归档」）[机检]
- **系统提示 section 回调绝不抛错，且文本不随运行状态变化**——来源：宿主对 section 抛错的处理是静默终止整回合 + 前缀缓存（见「为什么注入必须追加进历史」）——载体：`playbookSectionText`（lib/prompt-section.js）现在只有逐字常量拼接与 `defuseTemplateSyntax`，**没有任何 try/catch 需求**（改前那段注入块 try/catch 已随注入搬走）；注入侧的失败安全搬到 `createInjectionDelivery().onPreStep` 的 try/catch（lib/inject-delivery.js 的 `createInjectionDelivery().onPreStep`，任何异常只 warn + `injectedFailed + 1` + 原样返回 decision）+ 预检索的 catch（lib/index.js，日志 `dsh-ace: 注入的预检索失败，本回合不注入（…）`）（机检：tests/prompt-section.test.mjs 的「有注入/无注入两态逐字相同」、tests/inject-delivery.test.mjs 的 f/f2 两条抛错用例）[机检]
- **注入只许追加进历史，绝不许改写系统提示**——来源：真实 provider 缓存账本（cached 恒 8,320 tok、73 次切换累计重付 926.0K token）——载体：`createInjectionDelivery`（lib/inject-delivery.js）在 `agent/pre-step` 把注入块 `toSpliced` 到 `decision.messages` 末尾，`playbookSectionText` 不接收任何注入回调（机检：tests/inject-delivery.test.mjs 的 a/a2/c/d 四条、tests/e2e.test.mjs 场景 6 的「section 不含注入标记」断言）[机检]
- **可观测零成本：只在内存计数 + 一行日志，不新增落盘文件**——来源：用户要求——载体：`injectionStats`/`retrievalStats`/`archiveStats`（lib/index.js）+ `runtimeSnapshot()` + `normalizeRuntime`（lib/stats.js）——六个数字：注入批次 / 注入追加 / 检索命中 / 淘汰数 / 合并数 / 归档数（四原因分列）；改前的计分、复盘次数、考察位、未观测、闸门拦下全部删除（机检：tests/wiring.test.mjs 的 `/stats` 字段断言、tests/client-stats.test.mjs 的渲染用例、tests/e2e.test.mjs 场景 7 的 runtime 七键）[机检]
- **LLM 输出必须经 `extractJsonObject`，且落盘前字段类型逐个校验**——来源：I8——载体：`reflectRound`（lib/index.js）过滤四字段均为 string 的候选（机检：tests/prompts.test.mjs、tests/wiring.test.mjs）[机检]
- **不满额时的合并只在「真的很像」时动手，且绝不许借用满额口径**——来源：合并不可逆（被并掉的那条只躺在 archive.md 里、再也进不了注入）——载体：`MERGE_EAGER_THRESHOLD_RATIO = 0.75` / `MERGE_EAGER_MAX_ROUNDS = 2`（lib/merge-llm.js 的 `MERGE_EAGER_THRESHOLD_RATIO` / `MERGE_EAGER_MAX_ROUNDS`）与 `runRecapPipeline` 的 `else if (adds > 0)` 分支（lib/recap-pipeline.js），满额口径 `0.5 / 5` 一字未动；落盘走同一条 `commitOps`（`merged` + `ops`，先 archive.md 再手册），失败只 warn（机检：tests/recap-pipeline.test.mjs 5 条 `e｜` 用例）[机检]
- **注入块首行「最多 N 条」必须说真话**——来源：文案是给人看的唯一凭证，静默误导无异常可查——载体：`renderInjection` 的 `maxEntries` 入参 + `selectInjection` 三处透传（lib/inject.js 的 `renderInjection` + `selectInjection` 三处透传）（机检：tests/inject.test.mjs `C5.6`、tests/tuning-behaviors.test.mjs 配置行为②）[机检]
- **命中账本的取走点唯一 = 回合边界**——来源：B1/B2 实测缺陷——载体：`onTurnStopping`（lib/recap.js）**无条件** `takeHitIds` + `flushHits`（取走即一次原子写盘，冷却回合、阈值未到的回合也取）；`runRecapPipeline` 既不取账本也不写 `hits`；第 33 轮把「先结算再复盘」的时序机制（`settling` / `settlingIds` / `pendingUsageIds` / `pendingIds` 排除链）整层删除——没有分数就没有时序要求，不许以任何理由加回来；**跨进程锁与原子写一条都没动**；第 34 轮补上「落盘失败必须真重试」：失败的这批 id 借 `noteHitIds`（= `lib/ledger.js` 的 `note`）退回账本，下个回合边界取走的是「退回的那批 + 本回合新命中」的合并结果、一次写盘（机检：tests/recap-usage.test.mjs 14 条，含「同一批只落一次盘」「回合边界 hits+1」「写盘失败退回账本 → 下个回合边界真重试落盘」「退回的命中与新命中合并成一次写盘」「没有 `noteHitIds` 可退时明说已丢失」与守护③跨进程排序）[机检]

## 第 37 轮：不满额轻量合并、注入文案跟随配置、只读体检脚本

### 轻量合并（不满额也配对）
见上文「### 轻量合并（第 37 轮）：不满额也配对，但只有『真的很像』才动手」。一句话：满额路径（`projected > maxEntries`，阈值 0.5 / 5 对）**一字未动**；`projected <= maxEntries && adds > 0` 时另跑一次阈值 0.75 / 最多 2 对的轻量合并；两条路径共用同一套 `commitOps(merged + ops)` 落盘通道与同一条「先 `archive.md` 再手册」顺序；失败只 warn。

### 注入块首行文案跟随运行时配置
`renderInjection(picked, { withRationale, maxEntries })` 的第 2 个参数多了 `maxEntries`，`selectInjection` 把它（含带 rationale 的预算试算那一支）三处全部透传；未传回落 `INJECT_MAX_ENTRIES`。改前硬编码常量，配置 `injectMaxEntries = 8` 时首行仍写「最多 5 条」= 文案在说谎。**只改文案，不改取几条**：`selectInjection` 的取条逻辑一个字没动。

### 只读体检脚本 `tools/diagnose.mjs`
**结论：诊断能力只给调度者（写这份报告的 agent），不进插件运行时、不进设置页、不进任何 lib/ 的 import 图。**

- **形态**：一个独立的 `node` 脚本（`node tools/diagnose.mjs [--file <playbook.md>] [--today YYYY-MM-DD] [--settings <json>] [--archive <archive.md>]`），**零 LLM、零写盘、只读**。默认读真实手册 `C:/Users/adkun/.dsh/ace/playbook.md`（只读打开）。
- **只 import 纯函数**：`lib/playbook.js`（`parsePlaybook` / `scoreEntries`）、`lib/merge.js`（`computeMergeSuggestions` / `MERGE_THRESHOLD_RATIO`）、`lib/inject.js`（`estimateTokens`）、`lib/archive-file.js`（`parseArchiveFile` / `ARCHIVE_REASONS`）、`lib/settings-path.js`（`resolveSettingsFile`）、`lib/playbook-path.js`（路径常量）。**绝不 import `lib/index.js`** —— 那条链会拉 `@deepseek-ai/*` 宿主包，脚本就跑不起来了。反向也检查：没有任何 `lib/*.js` 或 `client.js` import 这个脚本（tests/diagnose.test.mjs 的 `A10` 钉住两个方向）。
- **五组判据**（每条都是「一句人话 + 数字」）：① 近重复配对（活跃条目两两的对称 BM25 正文比率 ≥ 0.5 的对数 + top 5，**0.5~0.75 之间的也算** —— 阈值刻意取 0.5 而不是合并阈值 0.75，因为「值得看一眼」的门槛比「该动手合并」低）；② 僵尸条目（`hits === 0` 或 `lastHit` 距今 ≥ 60 天，top 5）；③ 正文过短（`condition + action + rationale` 合计 < 80 字符的条数）；④ 近 30 天新增条数 + `archive.md` 里近 30 天归档条数（按四个原因分列）；⑤ 容量（活跃条数 / `maxEntries`，从设置文件读，读不到就明说「读不到，按默认 100 显示」并打上设置文件的绝对路径）。
- **为什么不复用 `computeMergeSuggestions` 做全量配对**：`lib/merge.js` 的 `if (!best || best.ratio < threshold) continue;` 让每条新增**只返回最相似的那一条**，全量配对里第二、第三相似的对会被静默漏掉。脚本因此自己写 `symmetricRatios(entries)` 做全量配对（口径与 `lib/merge.js` 的 `bodyRatio` 逐字一致：`min(fwd, rev)` 再钳到 1），另用 `computeMergeSuggestions` 跑一遍 `bestMatchPairs` 做**交叉校验**，两个数字对得上才可信。
- **降级一律不崩**：手册不存在 / 空文件 / 路径是目录 / 解析抛错 / 归档读不到 / 设置文件 JSON 坏 —— 每种都只打一行带路径的人话，脚本 exit 0，不吐栈。
- **零写盘是机检项而非承诺**：tests/diagnose.test.mjs 的 `A6` 真跑一遍完整诊断，然后逐字节比对「诊断前后目录内每个文件」，并检查源码里没有任何 `writeFile` / `appendFile` / `mkdir` / `rename` / `unlink` / `rm(` / `writeFileAtomic` / `withExclusiveLock`。

## 第 38 轮：打分加「文档侧索引」缓存、召回段升级成硬要求

### scoreEntries 的文档侧索引缓存（纯性能，零语义变化）
**为什么**：`scoreEntries`（lib/playbook.js）原实现每个 term 都把全库重扫一遍算 df，并且每次调用都把全部条目的四个字段重新 `querySegments` 一遍。注入路径每条用户消息跑一次、`computeHeat`（lib/heat.js）还会对最近 N 条历史各跑一次同一检索，实测 N=100 每次 5.621ms、N=500 45.452ms（中位，200 次轮换 query）——这是真实可感卡顿的源头。

**改了哪**：只加缓存，打分公式一个字没动（querySegments 重叠 2-gram、K1=1.2、b=0.75、`idf = log((N-df+0.5)/(df+0.5)+1)`、非重叠子串 tf、排序 `b.score-a.score || a.i-b.i`、`score>0` 过滤全部原样）。缓存三件套：①**语料索引**（doc 文本 / 文档长度 / N / avgdl）②**term→df 映射**（懒加载，按 term 现算现存）③**排序与过滤口径**仍在 `scoreEntries` 里现算，不进缓存。

**三条硬约束（任一破了都是返工）**：
- **key 是内容摘要，不是数组身份**：`readPlaybookSnapshot` 每次 parse 都返回新数组，按身份缓存永不命中（实测 200/200 不命中）；摘要用 FNV-1a 扫一遍拼接文本（`Math.imul` 32 位，无 `crypto.createHash`），摘要之外再用 `sameDocs` 逐条比对挡住哈希碰撞。按摘要实测命中。
- **容量有界**：语料索引只留最近一份（`INDEX_CACHE_LIMIT = 1`，满了 `clear()`），df 映射封顶 `DF_CACHE_LIMIT = 2048`（满了 `clear()`）。不做无界 Map。
- **摘要开销必须小于它省下的开销**：FNV-1a 一遍扫描是 O(总字符数)，而它省下的是「每 term 全库重扫 + 每次调用全库分词」，量级差在 term 数上。

**怎么机检**：
- `tests/playbook.test.mjs` 的 5 条 `R38｜` 用例：缓存命中返回等价结果（换数组身份、内容不变）/ 语料内容变化后失效 / 容量恒为 1 且打 200 份不同语料也不涨 / 与「关掉缓存」的朴素实现逐条比分（4 组语料 × 9 条 query）/ `matchEntries` 的 `score>0` 过滤与整本兜底口径不变。
- **等价性对照台**（仓库外，`%TEMP%\dsh-ace-retrieval-probe\probe-eq.mjs`）：参照实现 = 原文 `scoreEntries` 逐字复刻，100 条真实手册 × 38 条 query 逐 query 比顺序 + 下标 + 分数 → **同序 324/324（含 matchEntries 48/48 与 6 组语料变体），最大分数偏差 0.000e+0**。
- **性能对照台**（同目录 `bench-time.mjs`，200 次轮换 query 取中位）：N=100 **5.621ms → 0.512ms**（p95 8.941 → 0.794）；N=500 **45.452ms → 2.535ms**（p95 109.647 → 3.828）。冷索引对照 N=500 为 61.3ms（首调一次性建索引，比改前的 45.452ms 慢，但只在语料真的变了之后发生一次）。

**边界**：缓存是纯同步内存操作——无 await、无定时器、无后台任务、无文件句柄，不存在新增的阻塞事件循环的路径；进程退出即丢弃，不落盘、不进任何可观测计数（`bm25IndexStats()` 只给测试用，不进 `/stats`）。

### 复盘提示词：召回那一节从软建议升级成硬要求
**为什么**：`REFLECTOR_SYSTEM`（lib/prompts.js）原第 3 条只说「尽量用用户最可能说的那个词」「必要时把同义词也带一句」，是软建议，复盘模型经常挑最省事的那条妥协，条目于是在用户提问时永远召不回。BM25 只认词面，召回质量完全由 condition/action 里写了多少「用户真会打的字」决定。

**改了哪**：`## 怎么写才能被召回` 一节改成硬性门槛——**每条候选的 condition 或 action 至少带 2 个「用户真会打出来的说法」**，三类：①日常叫法（不是内部术语）②症状词（报错原文片段 / 「不显示」「对不上」「重复」「超时」）③动作词（「排查」「重跑」「对比」「清理」）；凑不够就重写，不许提交。另加「**同一个东西有几种叫法就写几种**」+ 正例（症状词 + 动作词）/ 反例（通篇只有 `rankInjection`、`normalizeScore` 这类内部术语）对照。原两条约束原样保留：不写只出现一次的名字（会稀释词频）、不写「本次 / 这一轮」这类永不触发的条件词。

**没动的**：输出契约（`{candidates:[{title,condition,action,rationale}],notes}`）一字未改，段落顺序与其余段落结构未动，不新增 LLM 调用。

**怎么机检**：`tests/prompts.test.mjs` 原有 5 条 test 一条没删（`/BM25[^\n]*不认语义/`、`/复现的词面/`、`/同义词/` 三条钉子照旧），另新增 2 条钉住硬要求的数量门槛与正例/反例。

## 第 34 轮：审查 report33 的修复（只增不删）

**任何一步失败都不许整批拒绝候选**（建议修 6）：`commitOps` 里 `evictPlan` 抛错或返回非数组时，不再 `moves = null` 然后让容量校验把整批候选拒掉（旧行为：`lib/commit.js` 的 `evictPlan` 分支只吞错、不腾位，`lib/playbook.js` 的 `overflowsCapacity` 于是抛「整批拒绝」，本回合候选一条都没落盘）。现在走内置确定性兜底 `planEvictionMoves`（`lib/commit.js`）：把不受保护的条目按 `compareForEviction` **全序**排序取前 N 条（N = 需要腾出的位数），**顺序仍然确定、不随机**，并写一条 `dsh-ace: 淘汰计划失败，已改用内置兜底（按 compareForEviction 全序排序取前 N 条，顺序仍确定不随机），本批候选照常落盘`。兜底本身也失败才允许抛错。用例：tests/archive.test.mjs 的 i1（`evict` 必抛）与 i2（`evict` 返回 `undefined`）——两条都断言候选照常落盘、被淘汰的条目进了 `archive.md` 且 `reason=evicted`、兜底结果与 `planEvictions` **逐条相同**（证明是同一判据，不是随便挑）、日志含兜底提示。变异：把兜底分支改成 `if (false)` → i1/i2 变红。

**命中落盘失败不许是假承诺**（建议修 7）：`flushHitsNow` 的 catch 不再只 warn —— 账本在回合边界取走时就已清空，只 warn 等于把这批命中物理丢掉。现在借 `noteHitIds`（生产接线 = `lib/ledger.js` 的 `note`，复用既有写入通道、不另造状态机）把这批 id 原样退回账本，warn 文案改成 `dsh-ace: 命中落盘失败（…），这批命中已退回账本，下个回合边界重试`；没有 `noteHitIds` 可退的调用方退化为「丢弃 + 明说已丢失」。生产侧靠 `recordHits(..., {throwOnError:true})` 把失败抛给调度器（`ace_playbook` 的检索路径照旧吞错，不炸工具）。用例：tests/recap-usage.test.mjs 的两条（第一次 flush 抛错 → 账本里仍是同一批 → 第二次回合边界真把它落盘，`hits` 变 1；退回的那批与下一批新命中合并成一次写盘）。变异：删掉 `noteHitIds(agent, ids.slice());` → 两条变红。

**可观测的「六个数字」不许有第七、第八个影子**（必修 5）：设置页的「跳过 / 失败」两格删掉——`runtime` 精确七键里从来没有 `injectedSkipped` / `injectedFailed`，页面读它们只会渲染假 0。计数器留着并继续进日志。用例侧的夹具**故意塞进** `injectedSkipped: 999` / `injectedFailed: 888` 两个陷阱值：加回去就会渲染出 999/888 而不是假 0（tests/client-stats.test.mjs）。

**已知的等价变异（如实记一笔）**：把高水位计算整体挪到「满额淘汰」之前，套件**全绿**——因为萌芽条只是从 `baseEntries` 里移出，仍留在 `parsed.entries` 里，四项输入一个没变，输出必然相同。这是**等价变异**，不构成盲区；真正要钉住「淘汰后重算」必须削弱淘汰前的编号来源（去掉 `maxEntryIdNumber(parsed.entries || [])` 那一项），那条变异会打红 5 条（tests/archive.test.mjs 的 f / h4 / h5 / i1 / i2），其中 h5 把「新编号不得复用刚被淘汰的号」写死成 `newId === 'ace-004'`。
## For Agents

- 改 `lib/playbook.js`（纯逻辑）时：保持函数纯度（`applyOps` 不碰 IO），新行为先在 `tests/playbook.test.mjs` 补用例；
- 改提示词时：守住 I1 措辞（「只输出增量」「禁止整本重写」必须原样保留）；`REFLECTOR_SYSTEM` 是四段式（目标 / 只做什么 / 不做什么含反例 / 怎么写才能被召回），召回质量的责任在「条件写成『当……时』触发式且含用户真会说的词面」这一条上——改它之前先想清楚 BM25 吃的是**词面**，不是语义；
- 加工具时：参数/输出都用 per-property spec（type/required/description/enum/items/additionalProperties），照 `lib/index.js` 现有三工具写；每个新引用的 DSH API 在代码注释里注明 checkout 出处；
- 改候选判定/归档时：只动 `lib/archive.js` 的纯函数（`decideCandidates`/`resolveSupersedes`/`applyArchiveMoves`）与 `lib/evict.js` 的 `compareForEviction`/`planEvictions`，阈值都导出成常量；**不许在判定路径上加 LLM 调用**（唯一的例外是满额合并，见 `lib/merge-llm.js`），也不许让任何一条路径变成物理删除；候选过滤只剩「标题非空」，**不许重建三层闸门**；
- 改淘汰顺序时：三级判据（`hits` 升序 → `created` 更早 → `idNumber`）是契约，**不许改成随机的、不许只按时间、不许引入任何分数或权重**；同分同秒必须由 id 兜底（tests/archive.test.mjs 守护用例①）；第 36 轮加的新条目保护期（`protectDays`）只许改「先取哪一组」，**绝不许让要腾出的 N 位变小**，也不许在「全都在保护期」时死锁——缺口一律用受保护组按同一全序补齐（tests/evict-protect.test.mjs 钉住）；
- 改合并时：`planMerges` 必须**永不抛错**，调用方仍要保留自己的 try/catch；某对失败就换下一对，全部失败就直接淘汰腾位——**合并失败绝不许阻塞落盘**（tests/recap-pipeline.test.mjs 守护用例②）；第 37 轮起多一条：**adds > 0 且不满额时还会跑一次轻量合并**（阈值 0.75、最多 2 对，见 `MERGE_EAGER_*` 常量与 I11），它同样永不抛错、只 warn；改动时两套阈值与轮数都别动；
- 改注入时：`lib/inject.js` 的排序键（**0.9 × 归一化相关度 + 0.1 × 归一化话题热度，同分按 id 数字升序**）与预算（`injectTokenBudget` 默认 900、`injectMaxEntries` 默认 5，常量仍作兜底默认）是契约；`hits` 绝不许进排序键；token 估算是**估算**，别把它当成精确计量去卡边界；**注入只许追加进历史（`agent/pre-step` 往 `decision.messages` 末尾插一条 user 消息），绝不许改写系统提示**——改前把注入渲染进 `ace-playbook` section，宿主原地重写首个系统节点，实测 cached 恒 8,320 tok、73 次切换累计重付 926.0K token；**注入块首行「最多 N 条」的 N 必须跟着生效配置走**（第 37 轮：经 `selectInjection` 的 `options.maxEntries` 透传给 `renderInjection`，未传/0/非法才回落常量），只改文案、不改取几条（I12）；
- 改可观测时：只加内存计数器 + 一行 `dsh-ace: …` 日志，**不许为统计新增落盘文件**；新计数器要同时出现在 `runtimeSnapshot()` 与 `normalizeRuntime`（lib/stats.js）里，否则页面会显示 undefined；**页面只许渲染协议里真有的键**——第 34 轮删掉了设置页的「跳过 / 失败」两格：它们读的 `runtime.injectedSkipped` / `injectedFailed` 从来不在七键协议里，`num(undefined)` 兜成假 0，等于常年显示「一个数都没有」；计数器本体（`lib/index.js` 的 `skipped += 1` / `failed += 1`）保留、继续进日志，**但不许为了显示它们而给 runtime 加键**（七键是红线）；旧的计分计数器不许以任何形式加回来；**第 40 轮起多一条例外口径**：注入链路的诊断计数（`handled` / `earlyReturn` / `deliveries` / `failures` / `stall`）**不进 runtime 七键**，而是走 `injectionSnapshot()` 挂在 `/stats` 响应里一个**并列顶层键 `injection`** 上——它只给诊断用，页面不渲染它；要把它塞进七键就得同时改 `normalizeRuntime` 与页面，那是改协议、不是加计数；
- 改时间戳时：`created`/`updated`/`lastHit` 一律走 `lib/timestamp.js` 的 `nowStamp`（毫秒精度本地 ISO），**排序用毫秒精度、界面只显示到日**——界面这一半由 `client.js` 的纯函数 `displayDay(value)` 兑现（`/^(\d{4})-(\d{2})-(\d{2})/` 取日期部分，认不出/空值一律 `'—'`），**设置页的所有渲染路径都必须走它**，不许再出现 `String(x.updated ?? '')` 直出（第 34 轮：29 字符毫秒戳塞进 84px 的日期列，且 `dayOf` 只给服务端统计落桶用）；旧日期格式必须照常解析，不许抛错；
- 别动：`cordis.patch.yml` 的 id/name 配对；`inject` 数组只声明真正用到的服务。

## 测试与验证

用例总表、运行方式与未验证清单见 [TESTING.md](TESTING.md)。

## 第 39 轮：自动复盘加总时限与单次 LLM 超时（复盘不占宿主维护相位）

用户症状：DSH 启动后从第二条消息起完全无响应，必须任务管理器结束 node.exe。根因链：
宿主 `runMaintenance(job)` 在 job 返回前一直保持 `phase.kind === 'maintenance'`，而 `wakeDriver` 在非
idle 相位只置 `wakeRequested` 就 return —— 复盘不结束，之后到达的用户消息永远排队。
dsh-ace 的自动复盘最长 8 次串行 LLM 调用（3 轮复盘 + 5 轮满额合并），provider 静默时可达小时级。

本轮改动（全部增量，未删既有代码）：

- **复盘不占宿主维护相位**：`lib/index.js` 的 `runRecap` 不再调 `agent.runMaintenance`，改为入队
  插件自己的串行队列后同步返回 `{ queued: true }`。宿主相位始终 idle，用户消息不再被复盘挡住。
  （手动 `/ace` 复盘当时**仍**走 `runMaintenance`：用户显式触发、显式等待，不涉及消息到达 ——
  **第 40 轮起此说不再成立**，手动 `/ace` 也改走同一条插件队列，见第 40 轮「缺陷 5」一节。）
- **新增 `lib/recap-queue.js`（零 import）**：全局唯一复盘串行队列。
  `RECAP_TOTAL_DEADLINE_MS = 120000`（90000–180000 的中值偏保守侧，与单次上限 75000 配比，
  2 次单次调用即触顶）、`MAX_QUEUED_RECAPS = 2`。`enqueue(item, merge)` 支持把新回合并进
  已在排队的那一份；`drain()` 用 `Promise.race([run(), deadline])`，到点**只放弃等待、不 abort 上游**
  （宿主的 `abortedCancelCause` 对没有 `kind` 字段的 abort reason 会走 `assertNever` 抛错，
  详见修复报告 5.1），并走 `onGiveUp` 通知用户「可重试」。
- **单次 LLM 调用上限**：`lib/llm.js` 新增 `ONESHOT_TIMEOUT_MS = 75000`（比宿主 300000ms
  stream idle 看门狗小一个数量级），`mergeSignals` 与调用方 signal 合并后透传给 `ctx.llm.stream`；
  本地超时抛 `'ace: LLM 调用超时（单次上限 ...ms）'`。
- **超时只放弃那一轮**：`lib/reflect.js` 的 `reflectRounds` catch 改为「只吞带
  `ace: LLM 调用超时` 前缀的错误（第 1 轮也吞，按已提炼候选返回 aborted:true），普通错误仍原样上抛」。
- **锁外 abort 检查点 ×3**：`lib/recap-pipeline.js` 在读快照前、合并 LLM 前、`commitOps` 前各一处
  `signal?.throwIfAborted?.()`。**检查点绝不放进 `withExclusiveLock` / `commitOps` 内部**，
  否则会破坏 `lib/commit.js` 的「先写 archive 再写手册」顺序。
- **可观测**：复盘开始/结束/放弃/失败各一行 `dsh-ace: …` 日志（带 agent id、耗时、队列剩余）；
  少一条配对日志即可一眼定罪卡死。
- **测试**：`tests/recap-queue.test.mjs`（9 条，含最大并发恒为 1）、`tests/recap-hang.test.mjs`
  （3 条，子进程驱动真 `lib/index.js`，假 provider 永不返回）、`tests/reflect.test.mjs` +3、
  `tests/recap-pipeline.test.mjs` +3。这两个数字是**当时快照**：写下这条时全量 554/553/1skip → 570/569/1skip（第 39 轮收尾实测，
  从未提交）。**提交后的实测**：父提交 `e1bd392` = 554 / pass 553 / fail 0 / skipped 1，
  `d6496a1` = 613 / pass 612 / fail 0 / skipped 1。
- 测试可用 `ACE_RECAP_TOTAL_DEADLINE_MS` / `ACE_ONESHOT_TIMEOUT_MS` 覆盖两个常量
  （模块级常量、import 时求值，故 e2e 类用例用子进程）。

改这一层时的红线：**绝不 abort 宿主的任何 signal**（无 `kind` 的 reason 会让宿主 finally 抛
`assertNever`，把 `whenIdle()` 永久挂死）；**锁内绝不抛中断**；**不引入 npm 依赖**；
**不新增定时器之外的后台任务**（队列的 `setTimeout` 一律 `unref()`）。

## 第 40 轮：注入链路的可观测性、接缝顺序、手动复盘并入队列与队列丢弃通知

背景：dsh-ace 的经验注入自 2026-10-26T14:03:02.375Z 之后全库一次都没再发生过（1563 个会话里真注入只有 57 次，
最后一次就是那一刻）。已排查确认检索/选型/去重/投递四层纯函数与装配面都正常，失效只剩三种可能：
**handler 根本没被调用 / handler 被门槛早退 / IIFE 抛错进了 catch**。改前没有任何计数能区分这三种。

### R1：把「没被调用」「被早退」「抛错」拆成可区分的计数

`lib/index.js` 的 `injectionStats` 在原有 `{batches, appended, skipped, failed}` 之上增加三层：

| 层 | 键 | 语义 |
| --- | --- | --- |
| 进入 | `handled` / `preSteps` | inbox 预检索 handler 进入次数（**在任何早退之前 +1**）/ pre-step 投递订阅进入次数 |
| 早退 | `earlyReturn.by.{noAgent, notUser, flagsOff, cacheHit, noQuery}`（预检索侧）与 `{notEnter, noAgent, subAgent, noAgentPicked, noText}`（投递侧），第 41 轮再加 `downstreamThrew` | 每个早退分支各自一桶，别的分支不会替它计数 |
| 失败 | `failures.{prerecall, empty, deliver}` + `deliveries`，第 41 轮再加 `failures.next` | 三处静默失败点（预检索 IIFE catch / 选不出候选 / 投递 catch）各自 +1；`deliveries` 是 pre-step 真把经验追加进历史的次数；`failures.next` 是「接缝到了、但下游 pre-step 监听器在 `next()` 里抛错」（错误照旧原样上抛，不吞） |

第 41 轮补的两条读法：`preSteps === 0` ⇒ **投递接缝根本没被宿主调用过**（删掉这一行增长点曾
没有任何测试会变红）；`failures.next > 0` ⇒ 接缝到了但下游炸了。另加两个内存时间戳
`lastPublishAt` / `lastDeliveryAt`（毫秒本地 ISO，空串 = 本进程还没有过）——
只有累计数时答不出「注入是从哪一刻停的」，而这正是当初排查停发最缺的信息。

**判定口径（写进 `lib/index.js` 的注释，也是这一层存在的理由）**：
`handled > 0 && batches === 0` ⇒ handler 被调用了但没产出（往 earlyReturn 分桶里看是哪道门）；
`handled === 0` ⇒ 事件根本没到 handler（装配/宿主侧问题，不是插件逻辑问题）；
`deliveries === 0 && batches > 0` ⇒ 检索发出了批次但投递层一次没成功。
第 43 轮改口径表述（**表达式一字未动**，第 42 轮那句「`stalled` 与 R5 的 `noProduce` 同口径」
是**过度承诺**，已删）：`stalled` 的准确语义只有一个 —— **「本进程里注入 handler 被调用过，
但自进程启动以来从未成功产出过任何批次」**，即「注入链路从启动起就完全没工作」这条判据。
`batches` 是**进程累计**，一旦成功发过一批就再也回不到 0，所以这一位答的是「链路有没有工作过」，
**答不了**「某个 agent 最近是不是连续失败」—— 后者归 R5 的 `stall.noProduce` + notice 管。
两者口径不同，**可以、也允许不同向**（第 43 轮用例钉死：同一个 agent 先成功发布过一批、
随后连续 5 次无产出 ⇒ `stalled === false` 而 `stall.noProduce === 5`）。**这是刻意的分工，
不是自相矛盾**：一位回答「链路活着吗」，另一位回答「这个 agent 卡住了吗」。

唯一保留的口径微调（第 42 轮中-1）：当
`earlyReturn.by.flagsOff === handled`（每一条都在 flagsOff 早退，即用户在设置里关了自动复盘/自动反思）
时**不算 stalled**：那种情形「没产出」是「没开」，不是「链路失效」。旧口径下用户一关开关 `stalled`
就为真，而同份统计里的 `stall.noProduce` 是 0，那种组合才是真的自相矛盾。

**读法**：`GET /api/dsh-ace/stats` 的响应里多一个**并列顶层键 `injection`**（`injectionSnapshot()`，
含机器可读的 `stalled` / `undelivered` 两个布尔 —— `stalled` = 「链路自启动起从未成功产出过任何批次」
（**不是**「某 agent 连续失败」，那归 R5），`flagsOff` 全占时不报 stalled）。
**不进 `runtime` 七键** —— 七键是红线，
lib/stats.js 的 `normalizeRuntime` 与 client.js 的渲染都按精确七键钉死。
全部只在内存，**没有新增任何落盘文件**（红线 9）。

### R2：两条注入接缝上移到最前，并打一次性开机日志

两条注入订阅（`agent/inbox/inserted` 预检索、`agent/pre-step` 投递）原本挂在 `recapController` 装配之后；
现在上移到 `ctx.systemPrompt.section(...)` 之后、自动复盘段之前，**保证「section 在 ⇒ 注入 handler 也在」**
——若哪天再出现「section 在渲染、注入却一次没发生」，可以直接排除「handler 没挂上」这一种。
apply 尾部另打一行一次性开机日志：
`dsh-ace: 注入接缝已挂载（inbox handler + pre-step delivery）；autoRecap=开/关 autoReflect=开/关`。
事件注册顺序由 tests/wiring.test.mjs 的顺序断言钉住。

### R5：连续无产出自检

两个**连续**计数器 `noProduce` / `deliverySilent`（第 41 轮起**按 agent 分表**，见下）：
预检索「**挑不出候选 / IIFE 抛错**」发生 `noProduce += 1`，发布成功就清零；
投递失败 `deliverySilent += 1`，投递成功就清零。
在 `agent/turn-stopping` 里由 `checkInjectionStall` 检查，达到 `INJECT_STALL_THRESHOLD = 5`（唯一常量）时
**先清零再发**一条 `form==='notice'` 的通知（「ACE 注入链路可能已失效：连续 N 次**预检索**……」），
并配一行 `dsh-ace: 注入链路自检——……已发一次性通知` 的 warn。整体 try/catch 吞错：
通知发不出去也绝不许影响回合边界。

第 41 轮修正三处口径（审计风险 2 / 3，三条都曾无测试可钉）：

- **按 agent 分表**：`stallByAgent: Map<agentKey, {noProduce, deliverySilent}>`。旧口径是进程级全局，
  A 的失败账记到 B 头上（PROBE-D 实测 A 错 3 + B 错 2 ⇒ A 收到「连续 5 次」）。/stats 的
  `injection.stall` 报**最接近门槛**那个 agent 的数并附 `agents` 入表数；用 Map 而非 WeakMap 正是
  因为这个数要算得出来。
  **第 42 轮修正两处**：① 键优先取 `'id:' + agent.id`（宿主的稳定会话标识，见
  `@deepseek-ai/dsh-agent/lib/types/types.d.ts` 的 `readonly id: SessionId`），没有 id 才退回对象
  身份 —— 原来一律用对象身份，等于依赖「宿主两个事件传同一个对象引用」这条**未声明契约**
  （审计 PB4：换成按事件新建的包装对象后 `agents = 2 / notices = 0`，R5 静默失效）；
  ② `STALL_AGENT_CAP = 200` 超限时按**连续计数升序**挑受害者（**第 43 轮改写**；第 42 轮那版
  「优先丢计数值全是 0 的条目、真找不到才丢最早入表者」**已作废**）：计分 = `noProduce + deliverySilent`，
  先丢计分最小的那本；**计分相同时丢最早入表者**（Map 插入序 ⇒ 确定，**绝不随机**，红线 11）。
  零值账（计分 0）因此最先被回收（丢空账、静默、无可损失）。但**不保证「绝不动正在连错的账」**：
  全表 200 本计分都非零时，丢的是**全表计分最小**的那本，它完全可能已经连错了几次、只差一两次到
  门槛 —— 第 44 轮审计 probe-cap 就是这个反例（全表 200 本计分都 = 4、谁都没到门槛 5，最早入表且
  最该继续数的那本照样被丢）。这种情况**必留一行 warn 点名**（说清丢了哪个 agent、它当时的计数、
  后果是「之后的连续失败要重新数到 5 次才会报警」）；计分为 0 才静默。措辞一律以「审计能不能用反例
  证伪」为准绳 —— 这里能被证伪的只有「绝不动正在连错的账」这类绝对话，已删。
  **为什么第 42 轮那版不够**（第 43 轮审计实测）：表里一条零值账都没有时，最早入表且已连错 4 次的
  那本照样被丢，该 agent 新账从 0 重新数、第 5 次失败 `notices = 0` —— 与 PB3b 终态完全一致，
  只是触发条件从「装满 200 本账」收窄成「装满 200 本非零账」。改成全表最小计分之后，被丢的恒是
  「最不接近门槛的那本」。用例：tests/inject-observability.test.mjs 的 R5 四条（全非零账时连错最多者
  不被丢 / 有零值账先丢零值 / 同分丢最早入表者 / 被丢的非零账确实留了点名 warn）。
- **门槛早退不计 `noProduce`**：`noAgent / notUser / flagsOff / cacheHit / noQuery` 只进 earlyReturn 分桶。
  用户在设置里关掉自动功能时六次全命中 `flagsOff`，旧口径下必然误报「链路可能已失效」（PROBE-1）。
- **文案与实现相符**：说「连续 N 次**预检索**」而不是「N 次用户消息」（计数单位是预检索次数，
  一个回合可能走好几次）；并加一句「若你在设置里关掉了注入 / 自动复盘，这条属于正常，可忽略」。

### 缺陷 5：手动 `/ace` 复盘不再占宿主维护相位

宿主 `runMaintenance(job)` 在 job 返回前一直保持 `phase.kind === 'maintenance'`，而 `wakeDriver` 在非 idle 相位
只把新消息 latch 成 `wakeRequested` 就 return —— 这就是「发消息没反应」。第 39 轮只把**自动**复盘改出了这个相位，
**手动** `/ace` 与 `ace_curate` 仍在里面。第 40 轮把手动路径也改走 `lib/recap-queue.js` 同一条串行队列：
`enqueue(...)` → `drain()` → 靠 `onSettled` 拿回 outcome 再答复。四条返回值语义不变，判据换成队列：
完成 / `agent 正在忙`（`recapQueue.busy`，**不再**用宿主的 `isBusyError`）/ 复盘失败 / 没有可用的 agent。
手动路径**刻意不挂** `onGiveUp`/`onFailed`：用户就站在命令前面等结果，自动复盘那两条通知在这里只是噪音。

### 缺陷 6：队列满额不再静默丢经验

`lib/recap-queue.js` 的 `enqueue(item, merge)` 一直支持合并，但生产里的调用**没传 merge 回调**，
合并分支是死代码 ⇒ 队列涨到 `MAX_QUEUED_RECAPS = 2` 就 `shift()` 掉最旧的一份，且**没有任何人被告知**。
修法两条：① `lib/index.js` 真传 `mergeRecapItems`（label 记成「回合 2+3」、`run` 换成两份摘要一起喂同一条流水线、
两份摘要各分半份 `TRAJECTORY_DEFAULTS.maxChars` 预算、`onGiveUp`/`onFailed` 两份都调）；
② 丢弃分支走 `item.onDrop` → 复用 `form==='notice'` 通道发一次性通知，文案说真话：
「ACE 自动复盘已丢弃一轮经验：<原因>。这份经验这次没有并入手册，下一次回合结束时会重新判定、重新攒，可照常继续工作。」

**`mergedOnce` 上限（一份待跑项最多吸收一个回合）**：没有它的话，只要队列里还排着一项，后来的每一份都会并进去
⇒ `queue.length >= maxQueued` 永远不可达 ⇒ 上面那条丢弃通知在生产里**永远发不出来**，且摘要链式拼接会越裁越碎
直到顶爆喂料上限。上限 1 之后：合并仍是常态（不排长队、不丢经验），只有连续多份挤在同一窗口才真排队，
排满了才丢最旧并通知 —— 那时文案说的才是真发生的事。
队列的收尾契约同时收紧为「**每一次入队的项都恰好 settle 一次**」（成功 / 超时放弃 / 真失败 / 被丢弃 / 被合并件带着两方回调一起）。

### 缺陷 4：归档成功、手册没写成功 —— 改对账自愈，锁内顺序一字未动

`lib/commit.js` 写盘顺序是硬红线：**先 `appendArchivedEntries` 写 archive.md，再 `writeFileAtomic` 写手册**。
反过来的话，一旦手册写失败，条目会从两边一起消失＝物理删除。但顺序正确的代价是：**归档写成功、手册写失败**时，
手册活跃区里还列着那条已经归档的条目，下一轮复盘会把它再归档一次（重复归档）。

修法**不是**「写失败后回写活跃区」（在写盘已经 EPERM 之后再做第二次写盘，只会连环失败且无法回报），
而是**下一次提交在锁内对账自愈**：依据红线 13 的单向契约「归档条目只存在于 archive.md，手册活跃区里永远不出现它」，
把「归档里已有、活跃区还列着」的条目从活跃区摘掉，并打一行 `dsh-ace:` warn 说明错位来源。
条目正文仍在 archive.md ⇒ 不违反红线 7（归档永不物理删除），同一条 id 也不会再被归档一次。
`commitOps` 与 `commitCapacity` 两条提交路径同口径；归档文件读不出来时既不摘也不写（与改前一致）。
第 43 轮起读失败的那行 warn **按路径去重**（`lib/commit.js` 的 `warnArchiveReadFailure` + 模块级
`ARCHIVE_READ_WARNED`）：归档长期不可读时每次提交都打同一句话只会刷屏，现在同一路径只 warn 一次。
去重表是**纯内存**（进程重启即清空），**没有新增任何落盘文件**（红线 9）；清空 archiveEntries /
archiveText、不阻断提交这些控制流一字未动。
**已知边界（第 44 轮审计 probe-e4 实测，如实记下、不改行为）**：去重表是模块级的、**永不清空**，
所以同一个归档路径走完「读失败 → 恢复可读 → 再次失败」之后**不会再告警**（实测该路径的 warns 恒为 1），
第二次坏掉时只有提交静默跳过对账。取舍理由：清空表的时机只能是「读成功一次」，那会让「时好时坏的盘」
每次都重新刷屏；而放宽到「按失败次数阈值」又要新增内存状态与阈值口径，收益不抵复杂度。进程重启即恢复告警。
**死代码披露**：`warnArchiveReadFailure` 里的 `keyed = … : null` 这条 null 分支在**现有两个调用点不可达** —— 
两处传入的 `archiveFile` 都已被 `commitOps` / `commitCapacity` 开头的归一化折成「非空字符串或空串」，而空串时根本走不进读归档的
try 块（`if (archiveFile)` 先挡掉了），所以 `keyed` 永远是非空字符串。保留它是为了万一将来有第三个调用点
传进 `null`/`URL` 对象时不会静默丢去重或抛错（那是「每次 warn」的退化，不是崩溃）。

**已知取舍：空行差异不算差异，代价是活跃区独有的空行可能被静默丢（第 43 轮写明，第 42 轮审计低-2 实测）**：
对账比对 `extraLines` 时**只看非空行**（`lib/commit.js` 的 `sameBody`，两侧都 `.filter((l) => String(l).trim() !== '')`）。
代价：两侧 `extraLines` **只在空行上有差异**时会被判「一致」，活跃区那条独有的空行被静默丢掉、无 warn，
走的是「正文完全一致」的自愈路径。这是**刻意付的代价** —— 解析器把条目块之间的空行、文件末尾的空行
也当成「无法识别的行」塞进 `extraLines`（`lib/entry-format.js` 的 `cur.extraLines.push(line)` 兜底分支，
序列化时又逐行原样写回），而手写手册里那些空行**永远不会**在插件序列化出来的归档文件里同时出现，
所以**裸比（按换行连接后逐字比）会让既有的 j1 / j3 / j7 / j8 四条真错位用例全红**
（tests/archive.test.mjs 的 j1 / j3 / j7 / j8；第 42 轮审计 mut-njoin 实测 pass 34 / fail 4）——
「归档写成功、手册写失败」这条自愈路径会被废掉，同一批错位永久留盘。空行不承载任何人手批注
（批注必有非空文本），舍它换「真错位能自愈」是划算的。**判定逻辑一行未改**（`git diff lib/commit.js` 的
`sameBody` 空白处理与第 42 轮完全一致，本轮只动了文件头注释。**第 44 轮审计再次双证：树内 `sameBody` 与第 42 轮副本逐字相同（IDENTICAL=true），本条取舍未动逻辑。**）

### 这轮的测试与未验证

新增 `tests/inject-observability.test.mjs`（22 条）与 `tests/recap-manual.test.mjs`
（4 条：缺陷 5 两条 + 缺陷 6 两条），`tests/archive.test.mjs` 加 j1–j10 共 10 条（缺陷 4 及后续轮次）。
全量 613 / pass 612 / fail 0 / skipped 1（父提交 `e1bd392` 实测 554 / pass 553 / fail 0 / skipped 1）。

**未验证**：没有在真实 DSH 宿主上端到端跑过任何一条；`injection.handled` 在真机上是否为 0（即失效根因到底是哪一种）
需要真实实例读 `/api/dsh-ace/stats` 才能坐实，本轮没做（不许重启 DSH）；缺陷 4 的 EPERM 没有真复现成「跨两次提交」的因果链；
`mergedOnce` 上限对真实复盘节奏的影响、`/ace` 新文案在真实交互里的呈现、notice 在真宿主里会不会被用户看到，都没测。

## 第 45 轮：满额复盘 120s 必超时的结构性死因——配对 O(N²) 全语料重扫 + LLM 无预算贯通

用户症状：手册攒满 100 条（`maxEntries=100`）之后，**每一次**自动复盘都触发「复盘超过总时限 120000ms」，
且合并从未成功过。根因有两层，本轮一并修：

- **纯 CPU 层（致命）**：`findMergePairs`（lib/merge-llm.js）对每条条目 a 调
  `computeMergeSuggestions(others,[a])`，后者内部对 99 条各做一次 `bodyRatio`、每个 `bodyRatio`
  又打 2 次 `scoreEntries`（100 文档语料）——满额一轮就是 **≈19,900 次全语料 BM25 打分**。真实 100 条
  手册实测 **78–110s**，纯同步 CPU 阻塞事件循环；而总时限只有 120s（`RECAP_TOTAL_DEADLINE_MS`，
  第 39 轮定的）。也就是说合并的 LLM 调用**从未开跑**，配对就已经吃满了预算 → 队列 abort → 检查点③
  抛错 → 什么都不落盘 → 手册还是满的 → 下一回合再来一遍。这条死循环用只读探针在真实手册上实测坐实
  （本轮不写手册内容进文档，数字见 FIX-REPORT-R45.md）。
- **LLM 层（次生）**：即使配对瞬时完成，3 轮复盘 + 5 轮合并的理论最坏 8 次串行调用（单次上限 75s）
  也没有任何一环知道自己还剩多少预算——复盘轮可以把合并的口粮吃光，合并轮可以把落盘的保底吃光。

### R3：scoreEntries 加 tf 缓存（lib/playbook.js，纯缓存，打分口径一字未改）

第 38 轮缓存了「term→df」与分词，tf 仍是每查询现算——对注入（每回合 1 个 query）够用，对配对矩阵
（同一语料打 N 次分）是重复劳动的大头。本轮把 df 缓存升级成 **tf 子缓存**：`TF_CACHE_TOTAL = 2_000_000`
按语料大小摊上限（`tfLimit = max(1024, ⌊2e6/N⌋)`），超限**整块 clear**（沿用第 38 轮的整块淘汰模式，
没有无界 Map，不新增落盘文件）。`termFreqsOf(idx, term)` 一次扫全语料同时得出 df 与每个文档的 tf，
`countOccurrences(>0)` 与旧 df 判据 `d.includes(term)` 数学恒等；BM25 公式、非重叠 tf、同分排序**一字未动**，
第 38 轮的朴素实现对照用例（独立打分锚）原样守着口径——变异自证实测：把缓存里的 tf 恒写成 1，
只有那把独立锚会红，同源的矩阵对照锚不红（两侧共用生产打分，同源漂移互相抵消）。

### R4：配对矩阵原语 computePairRatios / pairRatioAt（lib/merge.js）

一次 `computePairRatios(entries)` 建好全量投影语料，对每条有正文的条目用**它自己的正文当 query** 打一次
`scoreEntries` → 得到「每条的正文在全语料上的得分行」（`rows[i]`，空正文为 `null`）与 `selfs[i]`。
`pairRatioAt(ratios,i,j) = min(rows[i][j]/selfs[i], rows[j][i]/selfs[j])`，空正文/零自分 → 0、钳到 1——
与 `bodyRatio` 判据**逐位一致**（测试用旧算法重抄的锚逐格比对 25 对全等；钳 1 用手工 stub 钉死，
真实语料里「双向比率都超 1」几乎不会自然出现，牙齿必须是构造出来的）。
**与旧实现唯一的语义差别**：旧 `findMergePairs` 每选出一对就把两条摘出候选集，后续配对语料随之缩小
（idf/N/avgdl 微变）；矩阵版固定全量语料。第一对之前逐位一致，之后有 ±0.001 级 idf 微漂移——真实手册
实测三对配对完全一致、比率在小数第三位漂移且同侧过阈。要「逐位复刻旧漂移」等于回到 O(N²)，不采纳。
`findMergePairs`（lib/merge-llm.js）改为矩阵版贪心：一次建矩阵，i 升序取最优配偶（跳过已用、严格 `>`
取首个最大、`>= thresholdRatio` 才成对），贪心次序与旧实现逐字同构。实测 100 条手册
**78–110s → 53ms（≈1600×）**，`computeMergeSuggestions(99+1)` 966ms → 241ms。

### 缺陷 7：合并与反思的 LLM 调用没有预算约束（预算贯通链）

新增预算管道，每一跳都可核算剩余时间，全部向后兼容（老调用方拿不到第二参时行为不变）：

- `lib/recap-queue.js`：`drain()` 给上游第二参 `{ deadlineAt: startedAt + totalDeadlineMs }`
  （绝对截止时刻，第二参是新增、可忽略）。
- `lib/recap-pipeline.js`：`makeRecapBudget(deadlineAt)` → `{ enabled, remaining(), sliceFor(reserveMs) }`；
  满额时给合并阶段预留 `MERGE_PHASE_RESERVE_MS = 40_000`，落盘保底 `MERGE_COMMIT_RESERVE_MS = 8_000`。
  **反思轮的预算闸**：轮前算 `maxMs = sliceFor(合并预留 + 落盘保底)`，低于 `MERGE_MIN_CALL_MS = 10_000`
  就抛「ace: LLM 调用超时（复盘剩余预算不足 Nms，要留给合并与落盘），第 R 轮不再发起」——
  `lib/reflect.js` 的 `isTimeoutError` 认这个前缀，按**已提炼候选**收尾（本轮已产出的候选照常落盘，
  不是空手）。
- `lib/merge-llm.js`：`planMerges` 每轮开头看 `remaining() - 8s`，不足 10s 就 warn
  「合并剩余预算不足（还剩 Nms），停止发起新的合并对，已合并 M 对照常落盘」+ break——
  **只停、不抛、不吞部分结果**（红线 12 原样）；预算够时把本次调用的上限 `maxMs` 交给 LLM 层。
- `lib/llm.js`：`oneShot` 加 `maxMs` 参数，`capMs = min(ONESHOT_TIMEOUT_MS, maxMs)`，超时报错文案
  用实际 cap（前缀「ace: LLM 调用超时（单次上限 Nms）」不变）。

**「第一轮永不拦、不派 maxMs」是本轮最重要的行为决策**：首版把第一轮也纳入预算闸，recap-hang 用例
立刻红 2——第一轮被拦后挂死 provider 不再被挂、单次上限没机会触发，而且「预算紧就空手假成功」是绝对
不可接受的（复盘连一个候选都没提炼就静默结束）。修成：第一轮（无 priorCandidates）永远真实发起、
不带 maxMs；后续轮才受闸。变异自证 M1–M5（预算闸失效 / maxMs 失效 / tf 口径劣化 / 去钳 / 去第二参）
全部红后复原，备份哈希逐文件核对 IDENTICAL。

### 缺陷 8：满额路径的三处 computeMergeSuggestions 各自全量重打分（未单列修，并入 R3/R4）

`decideCandidates` 每候选最多 2 次 + merge-inbox 1 次的 `computeMergeSuggestions(≈100+1)` 从 966ms
降到 241ms（同一语料索引缓存 + tf 缓存全命中）；merge-inbox 语义不动（陈旧建议不在本轮范围）。

### 这轮的测试与未验证

净增 15 条：tests/merge.test.mjs（17→22，矩阵等价 + stub 钳 1 + 同配对 + 预算闸三条）、
tests/recap-pipeline.test.mjs（21→26，第一轮不拦 + 第二轮闸抛按已有候选落盘 + maxMs 配比 + 无预算不变）、
tests/recap-queue.test.mjs（10→11，第二参 deadlineAt）、tests/playbook.test.mjs（80→81，tf 冷热挤逐位一致）、
新文件 tests/llm-budget.test.mjs（3 条，maxMs 生效/零值/正常流）。tests/trajectory.test.mjs 的源码级断言
同步为 `executeRecap({ agent, summary, signal, deadlineAt: budget?.deadlineAt })`（:510/:520）。
全量 **632 / 631 / 0 / 1 skip**（基线 c6791ab = 617 / 616 / 0 / 1）。落钉文件：FIX-REPORT-R45.md。

**已知边界与未验证（如实声明）**：①真实宿主端到端未验证——全部证据来自单测（含真临时手册的整链用例
与子进程 hang 用例）和真实手册只读探针；修复要重启 DSH 后观察一次满额复盘日志才算闭环，本环境不许
重启宿主。②预算常量（40s/10s/8s）是按单次上限 75s 与真实手册规模推的保守值，不是真实 provider 时延
的统计；若真实模型普遍单次 >72s，合并会因预算不足停发——那是「及时止损、已合并部分落盘」的正确行为，
但合并成功率要在真机复核。③merge-inbox 的 2 条陈旧建议（指向已 superseded 条目）未修，超本轮范围。
