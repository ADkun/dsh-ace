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
  - **竞态退避**：idle 边沿之后宿主可能立刻被新的唤醒请求拉起新一轮（同文件 `:898`），所以执行前必须先等空闲；仍撞上「already has active work」则把待办**放回队列**，等下一个 idle 边沿再试，重试上限 3 次（`MAX_RECAP_ATTEMPTS`，lib/trigger.js）。这类预期内竞态**只写日志不推用户提示**（不刷屏）；其它真实失败（LLM 调用失败、手册写入失败等）才给用户推一条「ACE 自动复盘未完成」提示，并把本回合的 mutating 计数还回状态。
  - 判定、取出待办、竞态重试计数都是 lib/trigger.js 里的纯函数（`recordTurnEnd` / `takePendingRecap` / `requeuePendingRecap` / `isBusyError`），调度器在 lib/recap.js，状态显式挂在 `stateFor(agent)` 上、不藏闭包隐式变量，便于单测直接断言。

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