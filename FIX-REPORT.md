# FIX-REPORT —— 第 34 轮：审查 report33 的 5 条必修 + 6 条建议修

审查来源：`C:\Users\adkun\AppData\Local\Temp\dsh-ace-align\review33\report.md`（454 行，§4 逐条必修、§6 建议修）。
施工范围：只改 `D:\dsh\plugins\dsh-ace`。基线 `node --test tests/` = tests 458 / pass 457 / fail 0 / skip 1（skip = tests/settings-path.test.mjs 的 win32 权限位用例）。

本文件按「每条必修 / 建议修 → 改了什么（文件:行号）→ 补了哪几条用例 → 变异自证结果」记录，每完成一条即追加。

---

## 必修 4｜界面仍只到日（实现 + 用例 + 变异）

### 改了什么
- `client.js:708-722` 新增纯函数 `displayDay(value)`：`String(value ?? '').trim()` 后用 `/^(\d{4})-(\d{2})-(\d{2})/` 取日期部分，认不出（空值 / 垃圾值）一律返回 `'—'`。注释写明「时间戳是 29 字符毫秒戳、列宽只有 84px、兼容旧格式与空值、所有渲染路径都必须走这里」。
- 三处渲染改为走它：`client.js:810` 统计页最近更新（`.ace-stats-recent-date`）、`client.js:1140` 归档行（`.ace-archived-date`）、`client.js:1185` 记录页行（`.ace-entries-row-date`）。原先三处都是 `String(x.updated ?? '')` 直出。
- `lib/timestamp.js:56-60` 的 `dayOf` 注释改掉「界面展示仍只到日」这句没兑现的承诺，改成「排序用全精度；界面只到日由 `client.js` 的 `displayDay` 兑现，本函数只给服务端统计落桶用」。
- `client.js:413` 的 `.ace-entries-row-date{flex:0 0 84px}` 未改动（列宽不变，靠截断适配）。

### 补了哪几条用例
- `tests/client-entries.test.mjs:562-601`「记录页：毫秒时间戳渲染成 10 字符日期（截断在 client 侧，测试不代劳）」——夹具用两条 29 字符毫秒戳，**经 client 真实渲染**取 `.ace-entries-row-date` 的文本，断言恰好 10 字符、形如 `YYYY-MM-DD`、整行不含原始毫秒戳 / 时分秒 / 时区偏移。
- `tests/client-entries.test.mjs:603-621`「记录页：日期格兼容旧格式（只到日）、空值/垃圾值一律给「—」，绝不渲染 undefined」——旧格式照常 10 字符、空串 / 缺失 / 垃圾值三条都是 `—`、任何一格都不渲染 `undefined|null|NaN`。
- `tests/client-stats.test.mjs:368-384`（并入既有「统计块：规模快照…」用例）新增 `.ace-stats-recent-date` 的 10 字符断言 + 不含时区偏移 / 时分秒。
- `tests/client-stats.test.mjs` 新增「统计块：最近更新的日期格对空值 / 垃圾值给「—」，绝不渲染 undefined」（四条：空串 / 缺失 / 垃圾值 → `—`，旧格式 → `2026-09-05`）。
- 夹具改造（原来永远测不出问题）：`tests/client-entries.test.mjs:516` 主行夹具 `updated` 改成 `'2026-09-21T06:12:33.412+08:00'`；`tests/client-stats.test.mjs:151-156` 的 `recent` 第一条改成同形状毫秒戳。
- `tests/archive.test.mjs` 原「C4.3｜dayString 现在是毫秒时间戳」那条假断言（自己 `slice(0,10)` 再断言等于 `'2026-10-24'`，注释还写「界面展示仍取前 10 位」）已改成：断言毫秒戳本体匹配 `STAMP_RE`、`dayOf(s)` 等于日期、跨日 23:30 / 次日 00:05 的 `dayOf` 不相等，并留注释指向「界面只到日的真守护在 client 渲染侧」；另加「C4.3b｜dayOf 对毫秒戳 / 旧日期 / 空值 / 垃圾值的口径」。

### 变异自证（每条都真跑）
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| M-D1 截断函数改成恒等（不截） | `client.js` `displayDay` 改成 `return text === '' ? '—' : text;` | **变红 4 条**：记录页毫秒戳用例、记录页旧格式/空值用例、统计块渲染用例、统计块日期格用例（`ℹ fail 4`） |
| M-D2 截断函数恒返回 `'—'` | `client.js` `displayDay` 改成 `return m ? '—' : '—';` | **变红 6 条**：上面 4 条 + 「记录页：行 = 编号 · 标题 · 更新日期 · 来源标签…」+ 「已归档分区：默认活跃分区…」 |

两次变异后均已还原，`node --test tests/client-entries.test.mjs tests/client-stats.test.mjs` 回到 **tests 47 / pass 47 / fail 0**。

---

## 必修 5｜设置页「跳过 / 失败」恒显示假 0

### 改了什么
- `client.js:106`（zh 字典）`runtimeInjectDetail` 从四占位符改成两占位符：`'注入：批次 {batches} · 追加 {appended}'`；`client.js:237`（en 同款）改成 `'Injections: batches {batches} · appended {appended}'`。两处上方都加了注释说明「这两个数从设置页删掉了，不是漏写」。
- `client.js:859-866` 的 `fmt(...)` 只留 `batches: num(runtime.injectedBatches), appended: num(runtime.injectedAppended)`，删掉 `skipped: num(runtime.injectedSkipped), failed: num(runtime.injectedFailed)`。
- 计数器本体未动（`lib/index.js` 的 `skipped += 1` / `failed += 1` 继续 +1 并继续进 `ctx.logger` 日志）；`lib/stats.js` 的 `normalizeRuntime` 与 `lib/index.js` 的 `runtimeSnapshot` 仍只返回精确七键（没有加键）。

### 补了哪几条用例
- `tests/client-stats.test.mjs` 的 `runtimePayload()` 里插入**陷阱字段** `injectedSkipped: 999, injectedFailed: 888`（真协议里没有这两个键）：这样一来「加回去」会渲染出 999/888 而不是假 0，两头都钉死。
- 原 :711-713 那条只用源码正则（`clientSource` + `fmt(t('runtimeInjectDetail')…)`）钉「四个数字取自 runtime」的假断言删掉，换成行为面断言：注入明细行必须匹配 `runtimeInjectDetail`、不含 `跳过` / `失败`、不含 `999|888`；另加 4 条 `assert.equal` 断言 zh/en 字典都不含 `{skipped}` / `{failed}` 占位符。
- 用例名同步改成「…注入明细只给 批次/追加 两数（跳过/失败已删）…」。

### 变异自证
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| 把两格加回去 | `client.js:106` 字典恢复四占位符 + `client.js:866` 的 `fmt` 加回 `skipped: num(runtime.injectedSkipped), failed: num(runtime.injectedFailed)` | **变红 1 条**：「运行统计：归档按四种结构性原因分列、注入明细只给 批次/追加 两数（跳过/失败已删）+ 两句人话解释」（`ℹ fail 1`） |

还原后 `node --test tests/client-stats.test.mjs` = **tests 21 / pass 21 / fail 0**。

---

## 必修 1｜归档不可写 → 手册一字不写（commitOps 与 commitCapacity 两条路径）

### 改了什么（生产代码**没改** —— 生产行为本来就是对的，缺的是用例）
- `D:\dsh\plugins\dsh-ace\lib\commit.js:244`（commitOps）仍是先 `await appendArchivedEntries(archiveFile, toArchive, { highWater })`，`:246` 才是 `await writeFileAtomic(file, serializePlaybook(...))`；`D:\dsh\plugins\dsh-ace\lib\commit.js:330-331`（commitCapacity）同源两行。**这两行一个字都没动**，本轮只加了守护用例。
- 顺带把 `D:\dsh\plugins\dsh-ace\lib\commit.js:152-154` 的不实注释改成真实保证：读归档失败只是把 `archiveText` 清空，**真正的保证在写盘那一步**——`appendArchivedEntries` 会再读一次并抛错，于是手册一个字都不写（原注释把「整批不腾位」当成保证，那是没实现的承诺）。

### 补了哪几条用例（`D:\dsh\plugins\dsh-ace\tests\archive.test.mjs`，追加在文件末尾）
- **h1**「commitOps：归档文件不可写（EISDIR）时手册一个字节都不许变」：`await fs.mkdir(archiveFile)` 把 `archive.md` 造成**目录**（读/写必抛 `EISDIR`）→ `commitOps(file, {entries}, [add], 2, {archiveFile, evict: planEvictions, today: EVICT_STAMP})`，断言五件事：①抛错且 `String(threw.code || threw.message)` 匹配 `/EISDIR/`；②`after.equals(before)` —— 手册文件**字节完全未变**（不是只比条数）；③条目仍是 ace-001/002/003（**被淘汰的没有蒸发**）、候选没落盘；④归档仍是目录、`fs.readdir(archiveFile)` 为空（**没有新条目**）；⑤目录里只剩 `['archive.md','playbook.md']`（无 `.tmp` / `.lock` 残渣）。
- **h2**「commitCapacity：同源两行同样钉死」：同款目录冒充 + `commitCapacity(file, {archiveFile, maxEntries: 2, evict: planEvictions, today: EVICT_STAMP})`，断言同上（手册字节未变、条目未蒸发、归档为空）。
- **h3** 同时服务于必修 2（见下一节），也断言 h1 的核心三件事。

### 变异自证（真跑，跑完逐字写回原文）
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| **MA**（对应审查 M5） | `lib/commit.js:243-245` 的 `if (archiveFile && toArchive.length) { await appendArchivedEntries(...); }` 整段包成 `try { … } catch (e) {}` | **变红 2 条**：h1、h3（`node --test tests/archive.test.mjs` → tests 29 / pass 27 / fail 2） |
| **MB**（对应审查 N11） | `lib/commit.js:330` 的 `if (archiveFile) await appendArchivedEntries(archiveFile, toArchive, { highWater });` 同样吞掉 | **变红 1 条**：h2（fail 1） |

还原后 `node --test tests/archive.test.mjs` = **tests 29 / pass 29 / fail 0**。

---

## 必修 2｜锁内「先归档、后手册」的顺序（不失入源码正则）

### 怎么钉的
- **h3**「顺序钉子：归档写不进去时手册必须完全未变（先归档后手册）」：手写一本**故意不写 `<!-- ace:id-highwater: N -->` 标记行**的手册（先断言 `readIdHighWater(snapshot) === 0`），再把归档造成目录 → `commitOps` 抛错 → 断言 ①手册 `Buffer.equals` 字节完全未变 ②`readIdHighWater(still) === 0`（**两行对调的话手册会先被写成高水位 4 再抛错**）③条目没变 ④手册文本里不含 `ace-004`。
- 这条**不读源码、不做正则断言**：钉的是「可观测的写入顺序」，实现怎么组织都行，只要手册在归档失败时是干净的。

### 变异自证
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| **MC** | `lib/commit.js` 里 commitOps 结尾的「`appendArchivedEntries` 行 + `writeFileAtomic` 行 + `return`」整段改成「`writeFileAtomic` 行 + `appendArchivedEntries` 行 + `return`」（两行对调） | **变红 2 条**：h1、h3（手册先被写坏 → 字节比对与高水位比对同时失败；fail 2） |

还原后 archive.test.mjs 回到 29 / 29 / 0。

---

## 必修 3｜高水位必须并归档最大编号（修实现 + 补用例）

### 改了什么
- `D:\dsh\plugins\dsh-ace\lib\archive-file.js:134-136` 新增两个正则：`const HEADING_ID_RE = /\[?ace-(\d+)\]?/;` 与 `const HEADING_LINE_RE = /^\s*###/;`。
- `D:\dsh\plugins\dsh-ace\lib\archive-file.js:150` 的 `maxArchivedIdNumber(source)` 改成**先吃字符串**：`source` 是字符串时逐行扫归档**原文**，只对 `^\s*###` 开头的**标题行**取编号，取最大值；数组分支保留旧的 `/^ace-(\d+)$/` 匹配 `e.id`。**边界**（写在 `lib/archive-file.js:141` 的注释里）：只扫标题行，正文里偶然出现的 `ace-999` **不算**——理由是旧格式 `### ace-500`、空标题 `### [ace-888]` 过不了 `lib/entry-format.js:23` 的 `HEADING_RE`（`/^### \[ace-(\d+)\]\s*(.+?)\s*$/` 要求标题非空），`parseArchiveFile` 看不见它们，但编号确实被用掉了。
- `D:\dsh\plugins\dsh-ace\lib\archive-file.js` 的 `readArchiveSnapshot` 返回值新增原文 `text`（ENOENT 分支 `text: ''`，非 ENOENT 照旧抛出），`lib/commit.js:161` / `:287` 把它接进 `archiveText`。
- `D:\dsh\plugins\dsh-ace\lib\commit.js:215`（commitOps）、`:309`（commitCapacity 的 `mergedOps`）、`:328`（commitCapacity 最终写盘）三处高水位统一成四项 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries))`，且都落在**满额淘汰之后**（`lib/commit.js:196-209` / `:313-319` 的淘汰段在前）。

### 补了哪几条用例
- **h4**「高水位必须并归档最大编号（无标记行手册 + 归档里的更大编号）」：手写无标记行手册（只有 ace-001）；归档手写三条：`### [ace-778] 新格式归档条目`、`### ace-500 旧格式条目（标题行不带方括号，解析不出来）`、`### [ace-601] 正文里提到 ace-999 但那是依据、不是标题`。先断言 `parseArchiveFile` 只认出 `['ace-778','ace-601']`（旧格式确实看不见），再断言 `maxArchivedIdNumber(原文) === 778`（**正文里的 ace-999 不算**）→ commitOps 新增后新编号的数字 **> 778 且 < 1000**。
- **h5**「满额淘汰 + 同批新增：新编号不得复用刚被淘汰的号」：手写无标记行手册三条（hits 9 / 0 / 2），上限 2 再加 1 条 → 归档正好是 `['ace-002','ace-003']`、**`newId === 'ace-004'`**（不是复用 002/003）、`readIdHighWater(parsed) === 4`、归档两条 `reason=evicted`。

### 变异自证
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| **MD**（去掉归档原文这一路） | `lib/commit.js:215` 的 `Math.max(...)` 去掉 `maxArchivedIdNumber(archiveText)` 这一项 | **变红 1 条**：h4（新编号退回到 ace-002，与归档里的 ace-500 撞号空间） |
| **MF**（削弱淘汰前的编号来源） | highWater 改成 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(baseEntries))`（同时去掉 `maxEntryIdNumber(parsed.entries || [])` 与归档原文两项） | **变红 5 条**：f｜满额淘汰、h4、h5、i1、i2 |
| **ME**（把 highWater 整体挪到淘汰**之前**算） | `const highWater = …` 整行移到 `lib/commit.js:196-209` 淘汰段之前 | **全绿 —— 但这是等价变异**：四项输入一个都没变（被淘汰的条目只是从 `baseEntries` 移出，仍留在 `parsed.entries` 里，由 `maxEntryIdNumber(parsed.entries || [])` 兜住），输出必然相同。**要真正钉住「淘汰后重算」必须削弱淘汰前的编号来源**（即 MF），MF 已打红 h5（含 `newId === 'ace-004'` 这条硬断言）。如实记：这条变异不构成盲区，是等价变换。 |

还原后 archive.test.mjs 回到 29 / 29 / 0。
---

## 建议修 6｜淘汰计划失败不许整批拒绝（用户原话「任何一步失败都不许整批拒绝」）

### 改了什么
- `D:\dsh\plugins\dsh-ace\lib\commit.js:93-114` 新增私有函数 `planEvictionMoves(evictPlan, entries, protectedIds, need, today, logger)`：`pool` 先滤掉 `protectedIds`，`want = Math.floor(need)`；`fallback()` = `pool.slice().sort(compareForEviction).slice(0, Math.min(want, pool.length)).map(e => ({ id: e.id, reason: 'evicted', date: today }))`；先 `try { moves = evictPlan(...) } catch { moves = null }`，再 `if (!Array.isArray(moves)) { moves = fallback(); logger?.warn?.('dsh-ace: 淘汰计划失败，已改用内置兜底（按 compareForEviction 全序排序取前 N 条，顺序仍确定不随机），本批候选照常落盘') }`。**兜底本身也抛错才允许向上冒。**
- `D:\dsh\plugins\dsh-ace\lib\commit.js:36` 的 import 从 `planEvictions` 改成 `compareForEviction`（不再直接依赖 `lib/evict.js` 的计划函数，兜底用的是**同一套判据**）。
- 调用点：`D:\dsh\plugins\dsh-ace\lib\commit.js:202`（commitOps）与 `:318`（commitCapacity）都由 `const moves = planEvictionMoves(...)` 取代原来的 try/catch + `moves = null`。
- `D:\dsh\plugins\dsh-ace\lib\commit.js:152-154` 与 `:265-267` 的注释改掉「整批拒绝」这个假退路，写成「淘汰计划算不出来就走内置兜底（planEvictionMoves，同一判据当场排一遍）。任何一步都不整批拒绝。」

### 补了哪几条用例
- **i1**「淘汰计划抛错 → 内置兜底照常腾位，候选落盘、被淘汰条目进 archive.md、日志写明兜底」：`evict: () => { throw new Error('evict boomed') }` + 收集型 logger → 断言 ①候选落盘 `['ace-001','ace-004']`；②归档是 `['ace-002','ace-003']` 且都带 `reason=evicted`；③**兜底结果与 `planEvictions(snapshot.entries, 2, {date: EVICT_STAMP}).map(m => m.id)` 逐条相同**（证明走的是同一判据、全序确定，不是随便挑）；④日志含「淘汰计划失败」且含「兜底」。
- **i2**「淘汰计划返回不可用结果（不是数组）→ 同样走兜底，候选照常落盘」：`evict: () => undefined` → 同上断言（覆盖 `!Array.isArray(moves)` 这一支，不是只有 throw 才兜底）。

### 变异自证
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| **MG** | `lib/commit.js:107` 的 `if (!Array.isArray(moves)) { moves = fallback(); … }` 改成 `if (false) { … }`（删掉兜底，退回 `moves = null` 不腾位） | **变红 2 条**：i1、i2（`lib/playbook.js:423` 的容量校验重新抛「整批拒绝」，候选一条都没落盘） |

还原后 archive.test.mjs 回到 29 / 29 / 0。

---

## 建议修 7｜命中落盘失败的承诺是假的 → 真做重试

### 改了什么
- `D:\dsh\plugins\dsh-ace\lib\recap.js:63-65` 的 deps 文档 + `:75` 形参新增可选 `noteHitIds(agent, ids)`；`:116-117` 的注释写清「账本在取走时已清空，失败时必须把这批 id 原样写回账本」。
- `D:\dsh\plugins\dsh-ace\lib\recap.js:130-131` 的 `flushHitsNow` catch 分支：有 `noteHitIds` 就 `noteHitIds(agent, ids.slice())`，warn 改成 `'dsh-ace: 命中落盘失败（' + reason + '），这批命中已退回账本，下个回合边界重试'`；没有则 warn `'…没有账本可退回，这批命中已丢失'`；退回本身抛错再 warn `'…退回账本也失败（…），这批命中已丢失'`。**复用的是既有写入通道 `lib/ledger.js` 的 `note`，没有新造状态机。**
- `D:\dsh\plugins\dsh-ace\lib\index.js:599-607` 接线：新增 `noteHitIds: (agent, ids) => ledger.note(agent, ids)`，`flushHits` 改调 `recordHits(hitAgent, file, snapshot, ids, { throwOnError: true })`；`D:\dsh\plugins\dsh-ace\lib\index.js:736` 的 `recordHits(agent, file, snapshot, hitIds, options = {})` 在 catch 里先 info 记日志、再 `if (options && options.throwOnError) throw error;`（`ace_playbook` 的检索路径 :883 不传 options，照旧吞错、不炸工具）。
- 文档同步：`D:\dsh\plugins\dsh-ace\AGENTS.md:28`、`D:\dsh\plugins\dsh-ace\TESTING.md:491`、`D:\dsh\plugins\dsh-ace\DESIGN.md:363` 三处「下个回合边界再记」改成「退回账本 → 下个回合边界**重试**」。

### 补了哪几条用例（`D:\dsh\plugins\dsh-ace\tests\recap-usage.test.mjs`）
- harness 的 `calls` 增 `note: []`，新增 `noteHitIds: (a, ids) => { calls.note.push({ agent: a, ids: ids.slice() }); ledger.note(a, ids); }`（`:148`）。
- **改写**原 :234-253「写盘失败只 warn，下一批仍能落」→「回合边界｜写盘失败只 warn 不抛：这批命中退回账本，下个回合边界**真重试落盘**」（`:236`）：断言 ①warn 含「命中落盘失败」「已退回账本」「下个回合边界重试」；②失败后 `peek === ['ace-001']`（**账本没被清空**）；③第二次回合**故意不 note 新命中**，落盘成功只能来自退回的那批 → `hits` 变 1、`peek` 变 `[]`、`calls.flush.length === 2`、`calls.flush[1].ids === ['ace-001']`。（原来那条把「下个回合边界再记」这句没实现的承诺钉成契约，已改。）
- **新增**「回合边界｜退回账本的命中与下一批新命中合并成一次写盘（不拆成两笔）」（`:263`）：`calls.flush[1].ids === ['ace-001','ace-002']`，两条 `hits` 各 1。
- **新增**「回合边界｜没有 noteHitIds 可退时，warn 明说这批命中已丢失（不许再说「下个回合边界再记」）」（`:290`）：手工 `createRecapController`（不传 `noteHitIds`）→ warn 含「没有账本可退回」+「已丢失」，且**不含**「下个回合边界再记」。

### 变异自证
| 变异 | 改了哪行 | 结果 |
| --- | --- | --- |
| **M7** | `lib/recap.js:131` 的 `noteHitIds(agent, ids.slice());` 删掉（不再退回账本） | **变红 2 条**：「回合边界｜写盘失败只 warn 不抛：这批命中退回账本，下个回合边界真重试落盘」、「回合边界｜退回账本的命中与下一批新命中合并成一次写盘（不拆成两笔）」（`node --test tests/recap-usage.test.mjs` → tests 14 / pass 12 / fail 2） |

还原后 `node --test tests/recap-usage.test.mjs` = **tests 14 / pass 14 / fail 0**。

---

## 建议修 8｜删死代码 / 修不实注释（等价重构，零用例变红）

### 改了什么
- **删 `archiveReadable` 死变量**：`D:\dsh\plugins\dsh-ace\lib\commit.js:156` 只剩 `let archiveText = '';`（`archiveReadable` 在 :116 与 :121 的两处读写全部消失，全文件再无读取）；`:152-154` 的注释改成**真实**保证：「读归档失败只清空 `archiveText`，真正的保证在写盘那一步——`appendArchivedEntries` 会再读一次并抛错，于是手册一个字都不写」（原来是「整批不腾位」这种没实现的承诺）。
- **删 `normalizeArchiveReason` 死函数**：`D:\dsh\plugins\dsh-ace\lib\archive-file.js:139-142`（两分支返回值相同、零调用点）早已删除，本轮把 `D:\dsh\plugins\dsh-ace\AGENTS.md:38` 的清单提及一并清掉；`grep normalizeArchiveReason|archiveReadable` 在 `lib/` 与 `client.js` 现在**零命中**。
- **统一高水位口径**：`D:\dsh\plugins\dsh-ace\lib\commit.js:309`（commitCapacity 的 `mergedOps`）与 `:328`（commitCapacity 最终写盘）都补上缺的项，与 `:215`（commitOps）一致，三处均为四项 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries || []), maxArchivedIdNumber(archiveText), maxEntryIdNumber(baseEntries))`。`lib/commit.js:73` 的 `commitMeta` 仍只有两项（该路径不分配编号，注释已说明，属正当）。
- **修不实注释**：`D:\dsh\plugins\dsh-ace\lib\stats.js:13-19` 头注整段重写（不再写「计分变动」，改成把七个键逐一列名 + 「随评分层整层删除，不许加回来；runtime 恒为七键」）；`lib/commit.js:152-153` 与 `:265-267` 的「整批拒绝当正常退路」按建议修 6 改掉。

### 用例影响
**零改动、零变红**——等价重构。改完 `node --test tests/` 全量 471 条仍 0 fail。

---

## 总收尾｜数字汇总

### 验收 1｜全量测试

`node --test tests/`（`D:\dsh\plugins\dsh-ace`）：

| 指标 | 基线（第 33 轮结束时） | 现在 | 差值 |
| --- | --- | --- | --- |
| tests | 458 | **471** | **+13**（只增不减） |
| pass | 457 | **470** | +13 |
| fail | 0 | **0** | 0 |
| skip | 1 | **1** | 0（`tests/settings-path.test.mjs` 的 win32 权限位用例，Windows 上条件跳过） |
| cancelled / todo | 0 / 0 | 0 / 0 | 0 |

逐文件（真跑单文件，本轮改动过的四个文件）：

| 文件 | 以前 | 现在 |
| --- | --- | --- |
| `tests/archive.test.mjs` | 21 | **29**（h1–h5、i1–i2 七条新增 + C4.3 假断言改写成 C4.3/C4.3b） |
| `tests/recap-usage.test.mjs` | 12 | **14**（退回账本用例改写 + 合并一次写盘 + 无账本明说丢失） |
| `tests/client-stats.test.mjs` | 20 | **21**（假 0 源码正则断言换成行为面断言 + 新增日期格用例） |
| `tests/client-entries.test.mjs` | 24 | **26**（displayDay 两条经客户端渲染的用例） |

### 验收 2｜变异自证总表

共做 **11 个变异**，**10 个变红**，**1 个全绿**（ME，属等价变异，理由见下）。

| # | 变异 | 改了哪行 | 结果 | 打红的用例 |
| --- | --- | --- | --- | --- |
| MA | 必修1 commitOps 路径吞掉归档写失败 | `lib/commit.js:243-245` 的 `if (archiveFile && toArchive.length) { await appendArchivedEntries(...) }` 包成 `try { … } catch (e) {}` | **红 2** | h1「归档不可写 → commitOps 抛错且手册字节完全未变」、h3「锁内先归档后手册（手册没被写坏）」 |
| MB | 必修1 commitCapacity 同源吞掉 | `lib/commit.js:330` 的 `if (archiveFile) await appendArchivedEntries(...)` 包成 `try { … } catch (e) {}` | **红 1** | h2「归档不可写 → commitCapacity 同样抛错且手册字节完全未变」 |
| MC | 必修2 锁内顺序反了 | `lib/commit.js:243-246` 两行对调（先 `writeFileAtomic` 后 `appendArchivedEntries`） | **红 2** | h1、h3（可观测量：手册字节被改坏 / `readIdHighWater` 从 0 变成 4） |
| MD | 必修3 高水位不含归档原文编号 | `lib/commit.js:215` 去掉 `maxArchivedIdNumber(archiveText)` 一项，只剩 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(parsed.entries \|\| []), maxEntryIdNumber(baseEntries))` | **红 1** | h4「归档更大的编号（新格式 \`### [ace-778]\` 与旧格式 \`### ace-500\`）必须进高水位」——新条目会退化成 `ace-003`，与归档里的 ace-778 编号空间重叠 |
| ME | 必修3 高水位挪到淘汰**之前**算 | 把 `:215` 整段移到 `:199` 淘汰块之前 | **全绿（等价变异）** | 无 —— 见下方说明 |
| MF | 必修3 高水位削弱（淘汰前编号来源被抽掉：不用 parsed.entries / 不用归档原文） | `lib/commit.js:215` 削成 `Math.max(readIdHighWater(parsed), maxEntryIdNumber(baseEntries))` | **红 5** | f｜满额淘汰（`tests/archive.test.mjs` 里既有的满额用例）、h4、h5、i1、i2 —— **h5 硬断言 `newId === 'ace-004'`**，即「新编号不得复用刚被淘汰的号」 |
| MG | 建议修6 删掉确定性兜底 | `lib/commit.js:106` 的 `if (!Array.isArray(moves)) { moves = fallback(); … }` 改成 `if (false)`（退回 `moves = null` 不腾位） | **红 2** | i1「淘汰计划抛错 → 内置兜底照常腾位」、i2「淘汰计划返回 undefined → 同样走兜底」 |
| M7 | 建议修7 不退回账本 | 删掉 `lib/recap.js:131` 的 `noteHitIds(agent, ids.slice())`（账本已在取走时清空 → 真丢） | **红 2** | 「回合边界｜写盘失败只 warn 不抛：这批命中退回账本，下个回合边界真重试落盘」、「回合边界｜退回账本的命中与下一批新命中合并成一次写盘（不拆成两笔）」（`node --test tests/recap-usage.test.mjs` → tests 14 / pass 12 / fail 2） |
| M-D1 | 必修4 日期不截断 | `client.js:720-721` 的 `displayDay` 改成恒等（`return text;`） | **红 4** | ①记录页：毫秒时间戳渲染成 10 字符日期（截断在 client 侧，测试不代劳）②记录页：日期格兼容旧格式（只到日）、空值/垃圾值一律给「—」，绝不渲染 undefined ③统计块：规模快照、来源构成、14 天条形图、最近更新都按返回渲染 ④统计块：最近更新的日期格对空值 / 垃圾值给「—」，绝不渲染 undefined |
| M-D2 | 必修4 日期恒返 '—' | `client.js:720-721` 的 `displayDay` 恒返回 `'—'` | **红 6** | M-D1 那 4 条 +「记录页：行 = 编号 · 标题 · 更新日期 · 来源标签；点整行展开全文，可同时展开多条」+「已归档分区：默认活跃分区，切换后只展示归档条目（含归档原因与日期）」 |
| M5' | 必修5 把假 0 两格加回去 | `client.js:873` 之后重新塞一行 `fmt('跳过 {skipped} · 失败 {failed}', { skipped: num(runtime.injectedSkipped), failed: num(runtime.injectedFailed) })` | **红 1** | 「运行统计：归档按四种结构性原因分列、注入明细只给 批次/追加 两数（跳过/失败已删）+ 两句人话解释」（`tests/client-stats.test.mjs:724`；夹具里塞了 `injectedSkipped:999` / `injectedFailed:888` 的陷阱值，加回去必然渲染出 999/888） |

**ME 为什么全绿、为什么它不算盲区**：淘汰段做的是 `baseEntries = applied.entries`（把条目从**活跃副本**里移走），被移走的那几条**仍然留在 `parsed.entries` 里**；而高水位四项中的 `maxEntryIdNumber(parsed.entries || [])` 正好兜住了它们的编号。所以把 `:215` 整段挪到淘汰之前，四项输入一模一样，输出必然相同 —— 这是**等价变异**，不是盲区。要真正钉住「必须在满额淘汰**之后**重算」，必须让「淘汰前的编号来源」失效，即 MF 那种削弱；MF 已经打红 h5（含硬断言 `newId === 'ace-004'`，新编号不得复用刚被淘汰的号）。这条结论同时写进了 `DESIGN.md`「第 34 轮」整节。

### 验收 3｜语法自检

`node --check` 逐个跑 `lib/*.js`（29 个）+ `client.js`：**checked = 30，bad = 0**。

### 验收 4｜文档

- `D:\dsh\plugins\dsh-ace\TESTING.md`：头行条数改成 471（470 通过 + 1 条件跳过）；新增「第 34 轮」段落（净增 13 条、逐文件条数与理由、三处假断言改写、变异自证十一条、基线演进 458 → 471）；逐文件条数表四行整行重写。
- `D:\dsh\plugins\dsh-ace\DESIGN.md`：`:287` 补「这个顺序现在有可观测量钉住」；`:570` 高水位改成四项口径 + `maxArchivedIdNumber` 只扫标题行的边界说明；`:575` 命中账本补「落盘失败必须真重试」；`:586` 可观测补「页面只许渲染协议里真有的键」；`:587` 时间戳补 `displayDay` 承载；新增整节「第 34 轮：审查 report33 的修复（只增不删）」。
- `D:\dsh\plugins\dsh-ace\AGENTS.md`：`:28` 命中落盘改成「退回账本 → 下个回合边界重试」；`:38` 删 `normalizeArchiveReason`、补 `maxArchivedIdNumber` 三种标题形状。
- 全部改动都是 `edit` 定点替换或 append，**没有一次 read 全文 + write 整份覆盖**。

### 红线自查

| 红线 | 状态 |
| --- | --- |
| ① 手册只许增量演化 | 未新增整本重写路径 |
| ② `withExclusiveLock` + `writeFileAtomic`，锁内**先归档后手册** | 保持；由 h1/h2/h3 用可观测量钉住（MC 变异打红） |
| ③ 归档永不物理删除 | 未改动搬移语义 |
| ④ 高水位含**活跃 + 归档**两文件最大编号、淘汰**之后**重算 | `lib/commit.js:215 / :309 / :328` 三处四项统一；h4/h5 守着 |
| ⑤ 注入只许追加进历史 | 未涉及 |
| ⑥ 可观测只走内存 + 一行日志，runtime 精确**七键** | 未加键；只是删掉页面上两个**协议里并不存在**的格子（计数器本体仍在、仍进日志） |
| ⑦ 淘汰顺序不许随机 | 兜底走 `compareForEviction` 同一判据，i1 逐条比对 `planEvictions` 的输出 |
| ⑧ 合并失败绝不阻塞落盘 | 建议修6 把「淘汰计划失败」也从「整批拒绝」改成「内置兜底照常落盘」 |
| ⑨ 零新增 npm 依赖 | `package.json` 无 dependencies 变化 |
| ⑩ 毫秒本地 ISO + 界面只到日 | 时间戳仍 29 字符；界面经 `displayDay` 截成 `YYYY-MM-DD` |
