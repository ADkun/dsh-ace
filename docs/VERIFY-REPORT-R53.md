# VERIFY-REPORT-R53 —— 第 53 轮「已归档分区补分页」独立验收

验收对象：`D:\dsh\plugins\dsh-ace`（纯 ESM cordis 插件，无 `node_modules`，HEAD `56ceeae`，R49–R53 全部改动尚未提交、共存于同一工作树）。
验收范围：仅第 53 轮「已归档分区补分页」——`client.js` 归档分页、`tests/client-entries.test.mjs` 新增第 11 组、`DESIGN.md` / `TESTING.md` / `AGENTS.md` 的对应说明。R49–R52 的既有未提交改动不在本次判定范围（只在需要区分归属时作时间线证据）。
验收时间：2026/10/29 约 10:40–11:15。验收者未提交任何 git 写操作、未连真实 LLM/网关、未改生产代码；唯一触碰 `client.js` 的是第 3 节变异实验，逐次字节级还原。

---

## 一、结论

**达标（通过）。** 归档分区确实补上了与活跃分区同语义的分页，页码钳位、双分区独立、空态、只读红线均成立，6 条新用例被实现变异精确钉住，全量 `729 / 728 过 / 0 失败 / 1 skip`，既有断言一条未删、一条未放宽。
无阻塞缺陷。附 **4 条文档陈旧/口径提示**（均非代码缺陷，不影响验收，见第六节「建议修」）。

| # | 验收点 | 判定 | 一句话依据 |
| --- | --- | --- | --- |
| 1 | 全量测试 + 断言未放宽 | **通过** | `# tests 729 / # pass 728 / # fail 0 / # skipped 1`，EXIT 0；`tests/client-entries.test.mjs` diff 163 增 / **0 删**，旧 36 条 test 名 0 缺失/改名 |
| 2 | 源码语义（a–g） | **通过** | 见第三节逐条；钳位/独立/空态/只读/无新依赖/配色字体未动全部成立 |
| 3 | 变异自证 | **通过** | 6 处实现变异各自精确转红对应用例，8 次改动后 `client.js` SHA-256 全部还原为 `F7FB3388…038D0D` |
| 4 | 文档对账 | **通过（附 4 条陈旧）** | 729/728/1skip/净增 6/44 文件等数字与实测一致；有 4 处旧数/旧行号未同步 |
| 5 | 缺陷分档 | **无必修** | 必须修 0 条；建议修均为文档陈旧；不算问题若干 |

---

## 二、实测数字

命令（在 `D:\dsh\plugins\dsh-ace` 下）：

```
node --test --test-reporter=tap tests/
```

多次实测（原样抄回 TAP 汇总行）：

| 次序 | # tests | # pass | # fail | # skipped | duration_ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 729 | 728 | 0 | 1 | 6516.3449 |
| 2 | 729 | 728 | 0 | 1 | 6284.8946 |
| 3 | 729 | 728 | 0 | 1 | 6923.3761 |
| 4 | 729 | 728 | 0 | 1 | 6641.0610 |
| 5 | 729 | 728 | 0 | 1 | 6406.9749 |

EXIT 0。skip 1 条为既有的 Windows 文件权限位用例（T47，与 R53 无关）。测试文件数 44（本轮无新增文件）。

单文件 `node --test tests/client-entries.test.mjs`：42 条全绿（42 pass / 0 fail）。

**没有用例被删/改名/放宽**：`git diff --numstat -- tests/client-entries.test.mjs` = `163 0`（163 行纯新增、**0 删除**）；文件内 `test(` 计数 HEAD 时 36 → 现 42；逐名比对旧 36 条 test 标题，0 条缺失、0 条改名。因 diff 删除行数为 0，不存在「为将就实现而放宽既有断言」的空间。`node --check client.js` / `node --check tests/client-entries.test.mjs` 均 OK。

---

## 三、逐条源码审查（a–g）

对照基准：活跃分区 `ENTRIES_PAGE_SIZE = 20`（client.js:987）、`pageCount` :1196 / `currentPage` :1197 / `rows` :1198、`pageButtons` :1389-1398、`pager` :1400-1414、显示条件 `filtered.length === 0 ? null : pager` :1446。

### a. 页码钳位是否真的成立 —— **成立，无越界/空页**

- `client.js:1253` `const archivedPageCount = Math.max(1, Math.ceil(archivedAll.length / ENTRIES_PAGE_SIZE));`
- `client.js:1255` `const archivedCurrentPage = Math.min(Math.max(archivedPage, 1), archivedPageCount);`
- `client.js:1256-1259` `const archivedRows = archivedAll.slice((archivedCurrentPage - 1) * ENTRIES_PAGE_SIZE, archivedCurrentPage * ENTRIES_PAGE_SIZE,);`
- `client.js:1264` 行渲染用 `archivedRows.map(...)`（原 `archivedAll.map`）

分析：页码只在**渲染期**钳位，state 不回写（越界只影响本帧，符合注释意图）。当两次渲染之间 `archivedAll` 变短（如刷新后归档从 45 条变 3 条，`archivedPage` 仍停在 3），`archivedPageCount` 变 1，`archivedCurrentPage` 被钳回 1，`slice(0,20)` 取到真实行，不会渲染越界行。空页只可能出现在 `archivedAll.length === 0` 时，而此时走的是空态分支（见 b），不进入分页条。用例⑤（tests/client-entries.test.mjs:1519「刷新后归档变少时页码被钳位」）直接钉住此路径，且变异 M5（撤掉钳位）→ 仅 ⑤ 转红。

### b. 空归档时分页条不渲染、空态文案仍在 —— **成立**

- `client.js:1334` `archivedAll.length === 0 ? null : archivedPager` —— 空时返回 `null`，不渲染 `.ace-entries-pager`（不是空条）。
- `client.js:1261-1262` 空态仍渲染 `h('div', { className: 'ace-archived-note' }, t('entriesArchivedEmpty'))`。

用例④（:1508）断言分页条长度 0 且空态文案在；变异 M6（分页条恒渲染）→ 仅 ④ 转红。

### c. 两个分区页码真的独立 —— **成立，无共用、无副作用复位**

- `client.js:1055` 归档页码是独立 state：`const [archivedPage, setArchivedPage] = React.useState(1);`，与活跃分区的 `page` 是两个 `useState`。
- `client.js:1149` 切分区的 onClick：`{ setScope(id); setPendingArchive(null); setArchivedPage(1); }` —— **只复位 `archivedPage`，不碰活跃 `page`**；切回活跃时活跃页码保留。

用例②（:1465，活跃翻到第 2 页后切归档仍在第 1 页、归档翻页不带动活跃、切走再回来复位）钉住；变异 M3（`archivedPage` 换成共用 `page`）与 M8（撤掉 `setArchivedPage(1)`）→ 均转红 ②。

### d. 归档行展开态 `archivedOpen` 按 id 存，翻页不丢/不串 —— **成立**

- `client.js:1266/1268` 归档行 key 与展开态均以条目 `id` 为键（`archivedOpen[id]`，key `'archived:' + id`），与行在数组中的位置无关。翻页改变的是 `archivedRows` 切片，展开态仍按 id 命中，不丢、不串。

（此点无独立用例，属源码推证；展开态本身沿用第 33 轮既有实现，本轮未改。）

### e. 分页条按钮只有「上一页/下一页/数字页码」三种，无 input、无写请求 —— **成立**

- 数字页码：`client.js:1300-1309` `archivedPageButtons` 循环（key `'archived-page:' + i`、`is-active`、`aria-current`）。
- 上一页/下一页：`client.js:1311-1326` `archivedPager`（上一页 `disabled = archivedCurrentPage <= 1`、下一页 `disabled = archivedCurrentPage >= archivedPageCount`）。
- 归档视图无 `input` 控件；归档/删除/还原动作 `archiveOne` 只挂在活跃分区详情区（`client.js:1375-1385`），归档分区不出现。

用例⑥（:1546「翻页仍是只读 —— 没有输入控件、没有删除/还原按钮，翻页不发写请求」）断言子树无 input、无归档/删除/还原按钮、且 `archiveCalls(host).length === 0`。

### f. 无新 npm 依赖、未改 lib/ —— **成立**

- `package.json` 未改（无新依赖）。
- `git diff lib/ | Select-String 'archived|pager|PAGE_SIZE'` = **0 命中**，说明 R53 分页改动没有落进 `lib/`。
- **归属判断（重要，如实交代）**：工作树里 `lib/*.js` 与多个 `tests/*.mjs` 确有未提交改动，但都是**此前轮次遗留**，不是本轮。判据是文件修改时间：本轮窗口（10:20 之后）被写过的文件只有 `tests/client-entries.test.mjs`(10:20)、`DESIGN.md`(10:23)、`TESTING.md`(10:23)、`AGENTS.md`(10:23)、`client.js`(10:33，我变异还原时又写了一次，mtime 现为 11:11)；而 `lib/index.js`(08:23)、`lib/reasoning.js`(09:34) 等全部早于 10:20；`README.md`(06:49) 属 R49/R50。**局限**：工作树未提交，git 无法按轮精确归属，上述结论基于时间线 + 关键词双重判据，非 `git` 层面证明。

### g. VCP 暗色与字体是否被动 —— **未被动**

- 字体常量 `client.js:363` `.ace-set{font-family:'JetBrains Maple Mono','Maple Mono',...}` 未改。
- 分页条样式 `.ace-entries-pager / -btn / -text / .is-active` 在 `client.js:490-495` 未改；新代码整份复用既有类名与 `entriesPrev/entriesPage/entriesNext` 文案，无新增 CSS、无新配色、无新字体。

---

## 四、变异自证（落实 6 处，全部字节级还原）

基线：`client.js` SHA-256 = `F7FB3388C3C5A4DC0F108C3834A4535192795ABF5DBE692E5C329D4A6D038D0D`。每次变异后都还原并重算，均与该值一致（字节级）。测试编号：37=①45 条分 3 页、38=②双分区独立、39=③≤20 单页、40=④空归档、41=⑤钳位、42=⑥只读。

| 变异 | 改动 | 转红用例 |
| --- | --- | --- |
| M1 | `archivedRows = archivedAll.slice(0)`（全量渲染） | not ok 37、38 |
| M2 | `archivedPage = page; setArchivedPage = setPage`（共用活跃页码） | not ok 38 |
| M3 | `archivedCurrentPage` 改读 `page`（错用活跃页码参与钳位） | not ok 37、38、41 |
| M4 | 撤掉钳位（`archivedCurrentPage = archivedPage`） | not ok 41 |
| M5 | 分页条恒渲染（去掉 `archivedAll.length === 0 ? null :`） | not ok 40 |
| M6 | 撤掉 scopeButton 的 `setArchivedPage(1)` | not ok 38 |

结论：6 条新用例都被至少一处实现变异精确钉住，不是摆设。还原后全量复跑 `729 / 728 / 0 / 1`（6.4s），`client.js` SHA-256 仍为基线值。

---

## 五、文档对账

**与实测一致的**：
- `TESTING.md:18`（顶部摘要）与 `:144`、`:152`：729 条 / 728 通过 / 1 skip / 净增 6 / 44 文件、EXIT 0 —— 与第二节实测完全一致。
- `AGENTS.md:98` 追加的第 53 轮基线：729 / 728 过 / 1 skip（两次 6.35s / 6.74s）、净增 6 条全在 `tests/client-entries.test.mjs`、`lib/` 与 HTTP 契约一字未动 —— 与实测一致。
- `DESIGN.md:574 / 575 / 604`：客户端分页、归档页码独立 state、两分区都 20 条/页、切分区复位归档页码 —— 与实现一致。
- `TESTING.md:153` 未验证项如实写明「只在迷你 React 渲染器里验证过，没有在真实浏览器/GUI 里点过」—— 未把未验证写成已验证，态度正确（我现场 `GET http://127.0.0.1:3080/api/dsh-ace/entries` 返回 401 Unauthorized，回环围栏，也印证真实宿主未验证）。

**陈旧/偏差（见第六节建议修）**：
- `TESTING.md:146`：写 state「第 1056 行附近」（实际 `client.js:1055`）、scopeButton「`client.js:1144` 附近」（实际 `client.js:1149`），小偏差 1 / 5 行。
- `TESTING.md:520` 表格行 `| tests/client-entries.test.mjs | 34 |` 与 `:606` 第 14 条「tests/client-entries.test.mjs 的 36 条」均为旧数（现应 42）。`:520` 自第 47 轮（26→36）起就已陈旧，非本轮引入；本轮把它顺带改成 42 更完整。
- `DESIGN.md:573`「成功体 6 键（ok/entries/total/maxEntries/pathKind/playbookPath）」与同页 `:584-601` 接口块（已含 `archived` / `archivedTotal`）不一致 —— 既有漂移（归档分区在更早轮次加入），非本轮引入。
- `README.md:76` 记录页描述只写「每页 20 条，带页码」，未提归档分区也分页；本轮未更新 README。

---

## 六、缺陷分档

### 必须修

**无。**

### 建议修（全部为文档陈旧，非代码缺陷）

1. `TESTING.md:520` 表格计数 `34` → `42`；`TESTING.md:606` 第 14 条「的 36 条」→ `42`。复现：打开 TESTING.md 对应行即见与实测 42 不符。（第 520 行自第 47 轮起陈旧。）
2. `TESTING.md:146` 行号 `1056`/`1144` → `1055`/`1149`。复现：按文中行号去 client.js 找 state/scopeButton，各偏 1 / 5 行。
3. `DESIGN.md:573`「成功体 6 键」与 `:584-601` 接口块（含 archived/archivedTotal）自相矛盾，建议改为实际键集（8 键 + 可选 reason）。
4. `README.md:76` 记录页条目建议补一句「已归档分区同样 20 条/页」。

### 不算问题（已核实无风险）

- a 钳位、b 空态、c 双分区独立、d 展开态按 id、e 按钮种类/无 input/无写请求、f 无新依赖未改 lib、g 配色字体未动：逐条成立（证据见第三节）。
- 两分区复位行为的小不对称：点「已归档」在已处归档页时会复位到第 1 页，点「活跃」不复位活跃页码。这是设计口径（DESIGN.md:604「切分区把归档页码复位到第 1 页」），不是缺陷。
- `makeHost` 里新增的 `/api/dsh-ace/efforts` 假返回（tests/client-entries.test.mjs:232 附近）是 R50 遗留的夹具增强，与本轮归档分页无关。

---

## 七、我没能验证到的

1. **真实浏览器 / GUI 目视**：分页条在真实 CSS 级联下的换行与对齐、真实鼠标连点、宿主刷新时的滚动位置，均未在浏览器里看过（与 `TESTING.md:153` 口径一致）。用例跑在文件自带的迷你 React 渲染器里，只证逻辑不证观感。
2. **真实宿主 HTTP 返回**：`GET http://127.0.0.1:3080/api/dsh-ace/entries` 现场返回 **401 Unauthorized**（回环围栏），需重启 DSH 才能验证，本轮未重启。
3. **按轮精确归属**：工作树未提交（`git status` 显示 26 个 modified 文件 + 若干新增报告/测试），`git` 无法把 `lib/*.js` 改动按轮切分；我依据「修改时间 + `git diff lib/` 关键词 0 命中」判定 `lib/` 非本轮所改，这是间接证据，非 `git` 直接证明。

---

## 八、无遗留改动声明

除第 3 节变异实验（已逐次字节级还原，`client.js` SHA-256 复原为基线 `F7FB3388…038D0D`）外，验收者未改任何文件。收尾证据：

- `git status --porcelain`：仅显示 R49–R53 原有的 modified 文件与我未触碰的既有未跟踪报告，无我新增/修改的条目。
- `git diff --numstat` 中 `client.js` 仍为 `278 / 7`（= R49–R53 累计值，非我改出）；`tests/client-entries.test.mjs` 为 `163 / 0`。
- 我创建的临时文件 `tests-run.log`（被 `.gitignore` 的 `*.log` 覆盖）与 `$env:TEMP` 下的 `cj.diff / ce.diff / old-ce.mjs / d-DESIGN.md.txt / d-TESTING.md.txt / d-AGENTS.md.txt` 均已删除。
- 说明：`client.js` 的 mtime 现为 11:11（我变异还原时的写入），内容与基线字节一致，非内容改动。
