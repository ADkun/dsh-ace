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

当前 105 条用例：104 通过 + 1 条在 Windows 上条件跳过（T47 文件权限位，见未验证清单 7）。其中手册路径解析链 9 条（T48–T56）、跨进程文件锁 4 条（T57–T60）、跨进程锁覆盖整个读-改-写区间 3 条（T61–T63）为「手册默认本机共享层」改造新增；跨进程锁语义返工又新增 4 条（T64–T67，见下表）；并发冲突检测（快照 + 冲突报错）再新增 3 条（T68–T70，见下表）；锁的重入与回收兜底 3 条（T71–T73）与核心默认值 1 条（T74）见下表。语法自检：对每个 `lib/*.js` 跑 `node --check`；`package.json` 以 `JSON.parse` 校验。

## 用例总表

**结论：覆盖持久化层的解析、序列化、增量操作、并发与原子写；LLM 相关与工具注册不在单测范围（见「未验证清单」）。**

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
| T69 | detectConflicts | 目标条目在快照与最新手册中一致 → 无冲突（返回 null） | I5 | 同上 |
| T70 | detectConflicts | 目标条目在复盘期间被删除 / 被修改 / 新出现 → 明确报错「手册在本次复盘期间被其他进程改动，请重试」 | I5 | 同上 |
| T71 | withExclusiveLock / withLock | 同路径**嵌套**调用不死锁（withLock 重入保护）；不同路径仍并行；无 `.lock` 残留 | I5 | 同上 |
| T72 | restoreLock | 目标位置已被占住时**绝不覆盖**别人的锁（放弃放回） | I5b | 同上 |
| T73 | restoreLock | 跨卷（`link` 返回 ENOENT）也能把锁原样放回原位，源文件被清理 | I5b | 同上 |
| T74 | DEFAULT_PLAYBOOK_PATH / DEFAULT_MAX_ENTRIES | 核心默认值：`playbookPath` 默认空串（本机共享层）、`maxEntries` 默认 100 | — | tests/playbook-path.test.mjs |

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