# VERIFY-REPORT-R51R52 —— 第 51、52 轮生产改动独立验收

验收对象：D:\dsh\plugins\dsh-ace（纯 ESM cordis 插件，分支 `main`，HEAD `56ceeae`，全部改动未提交在工作树）。
范围：仅第 51 轮三处（R51-D1 / D2 / D3）+ 第 52 轮一处（defaultEffort 语义）。第 49/50 轮已另有 `VERIFY-REPORT-R50.md`（编号 824abc41），不在本次范围。
验收时间：2026/10/29 约 9:11–9:20。验收者未提交任何 git 写操作，未连任何真实 LLM / magpie 网关。

---

## 一、结论表

| 编号 | 内容 | 判定 | 一句话依据 |
| --- | --- | --- | --- |
| **A** | R51/D1：手动 `ace_reflect` 透传 `exec.signal`，超时不再误报成取消 | **通过** | `lib\index.js:1762` 确为 `signal: exec && exec.signal,`；判据链变量是「调用方 signal 自身是否已中止」（`lib\llm.js:169`），删掉该行 D1a/D1b 精确转红 |
| **B** | R51/D2：非法手动档位不再静默丢弃 | **通过** | `lib\reasoning.js:200` 中文 warn 在「丢弃后干什么」(`:209-227`) 之前；丢弃后回落 `efforts[0]`（`:222`），非法值绝不进 `effort` |
| **C** | R51/D3：`AGENTS.md` 代码地图补三行 | **通过（附口径说明）** | 三行落在**唯一一个纯增 hunk** `@@ -50,0 +52,3 @@`（`AGENTS.md:52/53/54`），既存行未被改；但 `AGENTS.md` **文件级** diff 不是纯增（另含第 49/50/51/52 轮前序改动，逐 hunk 归属见 §4） |
| **D** | R52：`defaultEffort` 不回落最强档 | **通过** | `lib\reasoning.js:100-102` 回落分支已为 `: undefined`；全仓无任何**决策路径**依赖旧语义（仅报文透传）；外科式变异精确转红 `tests/r50-reasoning.test.mjs:227` 一条 |
| **机检 1** | 全量套件 | **通过** | `# tests 723 / # pass 722 / # fail 0 / # skipped 1`，EXIT=0，与基线完全一致 |
| **机检 2** | 变异自证 | **通过** | 6 次变异，5 次精确转红、1 次记录连带面；6 次全部逐字节还原，还原后 SHA-256 与改动前一致，全量回到 723/722/0/1 |

**总体结论：四条全部通过，无阻塞缺陷。** 三条口径提示写进 §5「未验证与口径提示」。

---

## 二、A —— R51/D1 手动 `ace_reflect` 超时误报

**判定：通过。**

### A-1 代码确实透传了 signal

`lib\index.js:1734` `async execute(args, exec) {` … `lib\index.js:1742` `const raw = await oneShot(ctx, {` … 末行
```
1762|         signal: exec && exec.signal,
1763|       });
```
`:1747` 是 `reasoningEffort: effort,`（第 50 轮），`:1748-1761` 是第 51 轮新增的 14 行注释（逐字说明为什么必须传、以及 `exec && exec.signal` 的防御范围）。透传存在。

对照另外两处 `oneShot` 调用点（同一文件）：
- `lib\index.js:1492` `          signal,`（自动复盘 `reflectRound`，本就有）
- `lib\index.js:1599` `              signal: sig,`（合并，本就有）
- `lib\index.js:1762` `        signal: exec && exec.signal,` ← **只有手动工具这一支是本轮新补的**

宿主契约（`exec.signal` 的来源与必要性）：
`C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai\dsh-tools\lib\types\index.d.ts`
```
216| export interface ToolExecutionInput {
240|     /** Required caller-owned cancellation for this invocation. */
241|     readonly signal: AbortSignal;
```
即 `signal` 是**必填**字段（注释原文 Required），`exec && exec.signal` 的 `exec &&` 只对老宿主 / 测试直调（`execute(args, {agent})`）有意义，生产宿主上恒为真。

### A-2 判据链成立：区分「本层超时」与「调用方取消」靠的是哪个变量

**靠「调用方自己的 signal 是否已中止」**，两处判定：

1. 流内抛错分支 `lib\llm.js:157`：
   ```
   if (callSignal.aborted && !(signal && signal.aborted)) {
     throw new Error('ace: LLM 调用超时（单次上限 ' + capMs + 'ms）：' + ...);
   ```
2. aborted finish 分支 `lib\llm.js:169`（D1a 走的就是这一支）：
   ```
   if (finishKind === 'aborted' && (signal ? signal.aborted : callSignal.aborted)) {
     throw new Error('ace: LLM 调用被取消（调用方信号已中止、' + ... + '）');
   }
   ```

`callSignal` 由 `lib\llm.js:130` `const callSignal = mergeSignals(signal, capMs);` 得到，`mergeSignals`（`lib\llm.js:72-85`）是 `AbortSignal.any([signal, timeout])`。

**传了 signal 时**：`signal.aborted === false` ⇒ `:169` 条件为假 ⇒ 落到 `:176` `if (finishKind === 'aborted')` ⇒ 抛 `'ace: LLM 调用超时（单次上限 Nms）：…'` ⇒ `lib\reflect.js:18` `isTimeoutError` 命中 `TIMEOUT_ERROR_PREFIX = 'ace: LLM 调用超时'`（`lib\reflect.js:17`）⇒ **true**，`lib\reflect.js:63` / `lib\recap-pipeline.js:238` 的超时豁免与降档重试重新生效。

**不传 signal 时**（变异实测）：`:169` 退化成 `callSignal.aborted`，而 cap 到点必然让合并信号 abort ⇒ 条件恒真 ⇒ 抛 `'ace: LLM 调用被取消…'` ⇒ `isTimeoutError` **false**，豁免失效。这正是 D1 缺陷本体，实测报文见 §6 变异 1。

### A-3 用例覆盖（D1a / D1b 各测什么）

`tests\r51-manual-reflect.test.mjs`（204 行，真 import `lib/index.js` + `apply()` + 调 `ace_reflect.execute`，宿主 LLM 用假 stream，`process.env.ACE_ONESHOT_TIMEOUT_MS = '60'`（`:31`）、`DSH_HOME` 指临时目录（`:29`））：

- **D1a（`:118-144`，本层超时不被误报）**：调用方**不** abort，假 stream 吐半截正文后 `await waitForAbort(options.signal)`（`:105-114`）再吐 `{type:'finish', reason:{kind:'aborted', failure:{…code:'ABORTED'}}}`（`:116`）。断言：`llmCalls.length === 1`（`:137`）、message **以 `TIMEOUT_ERROR_PREFIX` 开头**（`:139`）、`isTimeoutError === true`（`:140`）、含 `'单次上限 60ms'`（`:141`）、含 `'已收正文'`（`:142`）、含 `'r51-provider/r51-model'`（`:143`）。
- **D1b（`:146-172`，调用方取消原样透传）**：`:148` 先 `caller.abort()` 再调 `execute`；`:155` `seen.abortedAtEntry = options.signal ? options.signal.aborted : 'no-signal';` —— 这是**「有没有透传」的直接探针，不依赖计时**。断言 `abortedAtEntry === true`（`:167`）、`isTimeoutError === false`（`:169`）、前缀 `'ace: LLM 调用被取消'`（`:170`）、含 `'调用方信号已中止'`（`:171`）。

两条恰好互补：D1a 证明「超时仍报超时」，D1b 证明「取消仍报取消且信号真的到达宿主」，只满足一边都会漏掉 D1 的任一方向。

---

## 三、B —— R51/D2 非法手动档位静默丢弃

**判定：通过。**

`lib\reasoning.js:179` `export function planReasoningEffort({ manual, auto, info, warn }) {`；`:184` 是容错 logger `const note = (text) => { try { if (typeof warn === 'function') warn(text); } catch { /* warn 抛错不影响判定 */ } };`

```
194|   if (typeof manual === 'string' && manual.trim() !== '') {
195|     if (want === undefined) {
199|       droppedManual = 'ace: 配置的思考档位不在合法档位集里';
200|       note('dsh-ace: 配置的思考档位 ' + manual.trim() + ' 不在合法档位集里（' + REASONING_EFFORT_IDS.join('/') + '），已丢弃');
201|     } else if (query.ok && !ids.includes(want)) {
202|       droppedManual = 'ace: 配置的档位不在该模型声明的档位集里';
203|       note('dsh-ace: 配置的思考档位 ' + want + ' 不在模型 ' + label + ' 声明的档位集里（' + effortIdsOf(efforts) + '），已丢弃');
204|     } else {
205|       return { ...base, effort: want, source: 'manual' };
206|     }
207|   }
```

三条判据：

1. **确有中文 warn 且带原值与合法清单**：`:200`，文案 `dsh-ace: 配置的思考档位 <原值> 不在合法档位集里（off/minimal/low/medium/high/xhigh/max），已丢弃`。合法清单取自 `REASONING_EFFORT_IDS`（**不手写第二份**），前缀 `dsh-ace: ` 与 §红线 9 的口径一致。
2. **warn 在「丢弃后干什么」之前**：非法分支在 `:195-200`，而「丢弃后干什么」（自动降档 `:209-227`）在其后；warn 不是事后补记，是在判定当步落。
3. **丢弃后回落自动降档，非法值绝不发出去**：`:222` `if (low) return { ...base, effort: low, source: 'auto', ...(droppedManual ? { reason: droppedManual } : {}) };`，`low` = `efforts[0].id`（`:190`，最低档）。全函数唯一的 `effort` 写出点只有 `:205`（合法手动值）、`:212/:216/:220/:222/:224/:227`（auto / none），**非法原值不进任何 `effort` 字段** —— `want === undefined` 时直接掉到 auto 分支。

用例 `tests\r51-manual-reflect.test.mjs:174-190`（R51-D2）：手动 `'HIGH!'` + `info{ok:true, efforts:[low,high]}` + warn 收集器，断言 `warns.length === 1`、`startsWith('dsh-ace: ')`、含 `'HIGH!'`、含 `REASONING_EFFORT_IDS.join('/')`、含 `'已丢弃'`、`plan.effort === 'low'`、`plan.source === 'auto'`、`plan.reason === 'ace: 配置的思考档位不在合法档位集里'`。删掉 `:200` 后该条精确转红（§6 变异 2）。

---

## 四、C —— R51/D3 代码地图补行

**判定：通过**（「纯增 hunk」成立；文件级不是纯增，须如实说明）。

`AGENTS.md` 当前三行位置：`:52` `| \`lib/heat.js\` |`、`:53` `| \`lib/injection-flow.js\` |`、`:54` `| \`lib/inbox.js\` |`（`Select-String` 定位，见 §6 命令）。

`git diff --numstat AGENTS.md` = `14 insertions(+), 5 deletions(-)`，逐 hunk 归属：

| hunk | add/del | 内容 | 归属 |
| --- | --- | --- | --- |
| `@@ -30 +30 @@` | 1/1 | `lib/recap-queue.js` 行 120000→300000 | 第 49 轮（前序） |
| `@@ -35 +35,2 @@` | 2/1 | `lib/llm.js` 行 75000→150000 + 新增 `lib/reasoning.js` 行 | 第 49 / 50 轮（前序） |
| `@@ -46,2 +47,2 @@` | 2/2 | `lib/reflect.js`、`lib/inject.js` 两行改写 | 第 49 / 50 轮（前序） |
| **`@@ -50,0 +52,3 @@`** | **3/0** | **`lib/heat.js` / `lib/injection-flow.js` / `lib/inbox.js` 三行** | **第 51 轮 D3（本轮）** |
| `@@ -59,0 +64 @@` | 1/0 | 新增 `tests/r51-manual-reflect.test.mjs` 行 | 第 51 轮（本轮） |
| `@@ -89 +94,5 @@` | 3/1 | 红线 20 段落改写 + 第 51 轮段落 + 第 52 轮段落（含 2 空行） | 第 51 / 52 轮（本轮） |

**D3 三行所在的 hunk 是 `add=3 del=0`**：既有行一个字节未动，纯增成立。
但**文件级** `AGENTS.md` 不是「纯增 hunk」（另有第 49/50 轮前序的 4 处改行）——这一点如实记录，不计为本轮缺陷。
`git show HEAD:AGENTS.md` 中三个文件名**全部缺失** ⇒ 三行确为本次新增，非既存行。

用例 `tests\r51-manual-reflect.test.mjs:192-200`（R51-D3）读 `AGENTS.md`，对三个文件名各断言 `rows.some(line => line.startsWith('| ' + TICK + name + ' |'))`。删掉任一行即转红（§6 变异 5 用 `lib/heat.js` 行验证）。

---

## 五、D —— R52 `defaultEffort` 语义

**判定：通过。**

### D-1 代码已是 `: undefined`

```
reasoning.js:96|   // defaultEffort 只是给设置页显示「宿主自己会选哪档」：声明了、且在声明集里，才原样带出。
reasoning.js:97|   // 没声明就是 undefined —— 绝不回落 efforts 末项：efforts 由弱到强，末项是最强档，
reasoning.js:98|   // 而这个值会以「宿主默认档」的名义出现在 GET /api/dsh-ace/efforts 报文里，等于插件凭空造一句宿主没说过的话。
reasoning.js:99|   const declaredDefault = validReasoningEffort(reasoning && reasoning.defaultEffort);
reasoning.js:100|   const defaultEffort = declaredDefault && efforts.some((e) => e.id === declaredDefault)
reasoning.js:101|     ? declaredDefault
reasoning.js:102|     : undefined;
reasoning.js:112|     ...(defaultEffort === undefined ? {} : { defaultEffort }),
```
`:102` 为 `: undefined`；`:112` 在 undefined 时**整个键缺席**，不是填 `null`。

### D-2 全仓 grep：没有任何决策路径依赖「回落最强档」的旧语义

对 `lib/` 全量 `grep defaultEffort`，非注释代码中出现的位置**只有 5 处**：

| 位置 | 作用 | 是否依赖旧语义 |
| --- | --- | --- |
| `lib\reasoning.js:99` | 读宿主声明的值 | 否（读宿主原文） |
| `lib\reasoning.js:100-102` | 回落判定（本轮改的就是这里） | 否（现为 `undefined`） |
| `lib\reasoning.js:112` | 返回值组装（undefined 时键缺席） | 否 |
| `lib\reasoning.js:187` | `planReasoningEffort` 的 `base` **原样带出** | 否（纯透传，不参与判定） |
| `lib\index.js:2293` | `GET /api/dsh-ace/efforts` 报文组装 | 否（undefined 时键缺席） |

其余命中（`lib\index.js:1571`、`lib\index.js:2258`、`lib\llm.js:121`、`lib\reasoning.js:8/21/76/176`）**全是注释或 JSDoc**，无运行语义。

**两条被点名要查的路径，逐行确认不读 `defaultEffort`：**
- `GET /api/dsh-ace/efforts` 报文（`lib\index.js:2288-2300`）：`efforts: info.efforts`（`:2292`）、`...(info.defaultEffort === undefined ? {} : { defaultEffort: info.defaultEffort })`（`:2293`）、`effective: { effort: plan.effort === undefined ? null : plan.effort, source: plan.source, … }`（`:2295-2299`）。默认档只做**展示透传**，`effective` 完全由 `plan.effort` 决定。
- `planReasoningEffort` 决策路径（`lib\reasoning.js:179-228`）：只读 `manual`（`:191-207`）、`auto` / `query.ok` / `query.note` / `efforts`（`:209-227`），最低档取 `efforts[0].id`（`:190`）。**不读 `defaultEffort`**，`:187` 只是把它塞进返回对象的 `base`。

`client.js` 中 `defaultEffort`：**NO MATCH**（亲自 grep 确认，前端零依赖）。

**探针实测**（`probe-default.mjs`，真 `import lib/reasoning.js`，无任何 mock）：
- 宿主未声明 `defaultEffort` ⇒ 返回对象 `hasOwnProperty('defaultEffort') === false`（键不存在，不是 `null`）
- 声明 `'high'` 且在声明集内 ⇒ `defaultEffort: 'high'`
- 声明 `'max'` 但不在声明集内 ⇒ 键缺席
- `planReasoningEffort({manual:'', auto:true, info: 已声明high})` ⇒ `effort 'low' / source 'auto' / defaultEffort 'high'`（原样带出，且自动降档不受它影响）
- 未声明时 ⇒ `plan` 同样键缺席、`effort` 仍 `'low'`

### D-3 用例断言已改，且「声明了、在集合里 → 原样带出」仍绿

`tests\r50-reasoning.test.mjs`：
- `:226-227` 注释「defaultEffort 不在声明集里 → undefined，不回落最强档」+ `assert.equal(decodeModelEfforts(modelInfoOf(['low','high'], 'max'), 'p', 'm').defaultEffort, undefined)`
- `:221-224`（R50-0 内）`assert.equal(decoded.defaultEffort, 'high')` —— **「声明了且在集合里 → 原样带出」的那条断言，仍绿**
- `:526`（R50-10）`assert.equal(res.body.defaultEffort, 'high', '声明了 defaultEffort 就带出来给设置页显示')` —— 仍绿

全 `tests/` 目录 grep `defaultEffort` 共 6 处（`:65`、`:69`、`:224`、`:226`、`:227`、`:526`），**没有任何用例断言「未声明时回落最强档」**，也没有断言「键必须缺席」——见 §7 未验证项 5。

---

## 六、机检 1 —— 全量套件

命令（workdir `D:\dsh\plugins\dsh-ace`）：
```
node --test --test-reporter=tap tests/
```
收尾态（全部变异还原后）输出：
```
# tests 723
# suites 0
# pass 722
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 6988.2719
EXIT=0
```
`not ok` 计数 = **0**。与基线 **723 / 722 / 0 / 1** 完全一致。

唯一 skip 用例全名：
```
ok 600 - migrateSettingsFile：迁移后的文件权限为 0o600（与 writeStored 同口径） # SKIP
```
即 Windows 上文件权限位（既有条件跳过，与用户描述的 T47 同源，非本轮引入）。

稳定性抽查：`node --test --test-reporter=tap tests/r51-manual-reflect.test.mjs` **连跑 5 次，5 次均 EXIT=0 / # pass 4 / # fail 0**（D1a 依赖 60ms 上限计时，未观察到抖动）。

---

## 七、机检 2 —— 变异自证清单

方法：临时脚本放系统临时目录（`%LOCALAPPDATA%\Temp\ace-verify-r51r52\mut2.mjs` / `mut3.mjs`），用**精确字符串锚点**做全文替换（命中次数 `!== 1` 直接 `ANCHOR-FAIL exit 3`，防误伤）；写文件走 `fs.writeFileSync(p, text, 'utf8')`（无 BOM，未用 `Set-Content -Encoding utf8`）；`restore` 从 `.bak` `copyFile` 逐字节还原并比对 SHA-256，三份全 `SAME` 才 exit 0。**每次变异后立刻还原，再做下一次。**

改动前三份生产文件 SHA-256：

| 文件 | SHA-256（改动前 = 还原后，逐字节一致） |
| --- | --- |
| `lib\index.js` | `157e4fecd5aa6efd9717a32d0ee1af37e5ed488fbc2f4576864bdbb26985b126` |
| `lib\reasoning.js` | `7cca9f1853c5e2b33cccce11a6ff1743c8a10996da698a3375cd029438008372` |
| `AGENTS.md` | `ce03437c95c9fa9309b37bd8bdc10c9cf043de6b91fa9ca0a81c724dfb9dd8b5` |

### 变异 1 —— 删 `lib\index.js:1762` 的 signal 透传（用户指定）

- 改动：删掉 `        signal: exec && exec.signal,` 整行 ⇒ 改后 SHA-256 `ff5233823bfe65ffe61e86f1f0ad9e18e1343ff412985ec5637b0cc45cf01e77`
- 跑：`node --test --test-reporter=tap tests/r51-manual-reflect.test.mjs`
- 结果：`not ok 1 - R51-D1a`、`not ok 2 - R51-D1b`、`ok 3 - R51-D2`、`ok 4 - R51-D3`；`# tests 4 / # pass 2 / # fail 2`，EXIT=1
- 精确性：**只红 D1 两条，D2/D3 不受牵连**
- 失败原文（D1a）：`D1：本层上限到点必须带「ace: LLM 调用超时」前缀（改前是「调用被取消」）：ace: LLM 调用被取消（调用方信号已中止、pi-ai stream aborted、code=ABORTED、已收正文 15 字符、reasoning 0 字符、耗时 75ms、r51-provider/r51-model、单次上限 60ms）`，expected true / actual false —— **这正是 D1 缺陷的可复现形态**
- 失败原文（D1b）：`D1：调用方已中止必须原样透传给宿主（改前不透传 ⇒ 这里是 false）`，expected true / actual false
- 还原：`RESTORED {"index":"SAME","reasoning":"SAME","agents":"SAME"}`，EXIT=0

### 变异 2 —— 删 `lib\reasoning.js:200` 的 warn 行（用户指定）

- 改动：删除 `      note('dsh-ace: 配置的思考档位 ' + manual.trim() + ' 不在合法档位集里（' + REASONING_EFFORT_IDS.join('/') + '），已丢弃');` ⇒ 改后 SHA-256 `343901ffce9dbb9745b93748bfc9593ccf7766985c96a1b9d743c35fe44f1bbe`
- 跑：同上文件
- 结果：`ok 1 - D1a`、`ok 2 - D1b`、`not ok 3 - R51-D2`、`ok 4 - D3`；`# tests 4 / # pass 3 / # fail 1`，EXIT=1
- 精确性：**只红 D2 一条**
- 失败原文：`D2：非法档位名必须落一条 warn（改前是 0 条、静默丢弃）：[]`
- 还原：三份全 `SAME`，EXIT=0

### 变异 3 —— 按用户字面写法把回落改回末项（整段三元替换，用户指定）

- 改动：把 `:100-102` 整段三元换成 `  const defaultEffort = (efforts.length ? efforts[efforts.length - 1].id : undefined); // [MUTATED]` ⇒ 改后 SHA-256 `fcb8ed8688bfc1956a89fb0f0de8fa84a862cd30ba067f99d668b63e6edfdf68`
- 跑：`node --test --test-reporter=tap tests/r50-reasoning.test.mjs`
- 结果：`not ok 1 - R50-0`、`ok 2…10（R50-1…R50-9）`、`not ok 11 - R50-10`；`# tests 11 / # pass 9 / # fail 2`，EXIT=1
- R50-0 诊断：`Expected values to be strictly equal: + 'high' - undefined`，stack 指向 `tests/r50-reasoning.test.mjs:227:10`
- R50-10 红在 `:526` `声明了 defaultEffort 就带出来给设置页显示`
- **口径说明**：这种「整段替换」写法顺带删掉了 `declaredDefault` 的声明集校验，所以「宿主声明了 'high' 也在集合内」那条也被打到（R50-10 连带红）。**这是照用户字面指令改的结果，不是被测代码的缺陷**。为分离这一混淆，追加变异 4b（外科式）。
- 还原：三份全 `SAME`，EXIT=0

### 变异 4b —— 外科式：**只**改回落分支，保留声明集校验（补充自证）

- 改动：保留 `const declaredDefault = …` 与 `? declaredDefault`，只把 else 分支改为 `: (efforts.length ? efforts[efforts.length - 1].id : undefined); // [MUTATED]` ⇒ 改后 SHA-256 `f5f2def767f3ca58e4b423ce05d5cbc4d59a4a9795e4129264c62e9a0ebc1ec8`
- 跑（单文件）：`# tests 11 / # pass 10 / # fail 1`，**只 `not ok 1 - R50-0`**，EXIT=1
- 跑（**全量**）：`not ok 472 - R50-0` 唯一一条；`# tests 723 / # pass 721 / # fail 1 / # skipped 1`，EXIT=1
- 精确性：**只红一条断言、R50-10 不连带** ⇒ 证明「不回落最强档」这个语义**恰好只被 `tests/r50-reasoning.test.mjs:227` 钉住**，与「声明了要原样带出」的语义完全解耦
- 还原：三份全 `SAME`，EXIT=0

### 变异 5 —— 删 `AGENTS.md` 的 `lib/heat.js` 行（D3）

- 改动：删掉以 `| \`lib/heat.js\` |` 开头的整行 ⇒ 改后 SHA-256 `342cb4e3d54b83d14b9138dadc31bb6cdcb8b3cd61f01da3c22c70e40c8c2f28`
- 跑：`tests/r51-manual-reflect.test.mjs` ⇒ `ok 1 D1a`、`ok 2 D1b`、`ok 3 D2`、`not ok 4 - R51-D3`；`# tests 4 / # pass 3 / # fail 1`，EXIT=1
- 交叉复核：同时 `git diff --unified=0 AGENTS.md` 确认 `lib/heat.js` 行从 diff 中消失，`git diff --stat AGENTS.md` 由 `14 insertions(+), 5 deletions(-)` 变为 `13 insertions(+), 5 deletions(-)` ⇒ 「纯增」这一性质可被用例与实际 diff **双向复核**
- 还原：三份全 `SAME`，EXIT=0

### 变异 4a —— `efforts` 置空（连带面观察，非本轮判据）

- 改动：`lib\reasoning.js:181` `const efforts = query.ok && Array.isArray(query.efforts) ? query.efforts : [];` → `const efforts = []; // [MUTATED]` ⇒ 改后 SHA-256 `90885ab29b6b1024bb9471743d7074b19f98e000398eb25ad4795e158014a31b`
- 跑（全量）：`not ok 473 R50-1`、`474 R50-2`、`475 R50-3`、`477 R50-5`、`479 R50-7`、`482 R50-10`、`485 R51-D2`；`# tests 723 / # pass 715 / # fail 7 / # skipped 1`，EXIT=1
- 记录用途：证明 `efforts` 是整条档位链的承重变量（连带 7 条）。**这不是本轮判据**，仅作「变异会不会乱红」的连带面观察，不作为任何判定依据。
- 还原：三份全 `SAME`，EXIT=0

### 还原完整性复核（最终态）

- 三份生产文件 SHA-256 = `157e4fec…` / `7cca9f18…` / `ce03437c…`，与**改动前完全一致**
- `[MUTATED]` 标记在 `lib\*.js` 与 `AGENTS.md` 中：**NONE**
- `lib\*.js` 中残留 `efforts[efforts.length`：**NONE**
- `git status --short` 条数 = **35**，与开工时一致（`AGENTS.md` M、`lib/index.js` M、`lib/reasoning.js` ??，均为验收开始前的既存状态）
- 全量复跑：`# tests 723 / # pass 722 / # fail 0 / # skipped 1`，**EXIT=0** ⇒ 红线达成

---

## 八、未验证清单（拿不到证据的，逐条说明原因）

| # | 未验证项 | 原因 |
| --- | --- | --- |
| 1 | **真实宿主的 `exec.signal` 线上行为** | 只核对了类型契约（`dsh-tools lib/types/index.d.ts:216-241`，标注 Required）与 `tools/pre-execute` 文档（同文件 `:47-56`：wrapper 只许改 `exec.signal`、registry 会 re-fuse 原始 caller signal）。用例用假 stream 模拟，未在真实宿主回合里触发真实传输层断连 |
| 2 | **真实 provider 上 60ms 上限的时序稳定性** | D1a 依赖 `ACE_ONESHOT_TIMEOUT_MS='60'` 的计时。本机连跑 5 次全绿，但真实 provider 的建连/首字节延迟数量级不同，未测 |
| 3 | **magpie 线上 69 个模型均未声明 `defaultEffort`** | 该事实来自 `LIVE-PROBE-R50.md` 的转述。本次明令禁止连真实网关，未发请求复测。R52 的**动机**依赖它，R52 的**正确性**不依赖它（语义已由代码 + 探针 + 变异自证） |
| 4 | **`AGENTS.md` 在验收窗口内被外部进程改动** | 验收期间（9:11:53）另一进程向 `AGENTS.md` 追加了「第 52 轮」段落（+2 行）。本报告记录的 `ce03437c…` 是 9:16 我快照时的状态；该两行不属于本轮改动，我用 `git diff --no-index` 与旧备份逐行比对确认差异**仅** `@@ -96,0 +97,2 @@` 这两行 |
| 5 | **「未声明时 `/efforts` 报文里 `defaultEffort` 键缺席」缺少测试钉住** | 代码（`:112`、`index.js:2293`）与探针（`hasOwnProperty === false`）都证明行为正确，但 `tests/` 里**没有任何用例**断言这一点。属**测试覆盖缺口**，非实现缺陷；本次范围不含补测，如实记录 |
| 6 | **`AGENTS.md` 文件级 diff 非纯增** | D3 三行本身是纯增 hunk（`@@ -50,0 +52,3 @@`），但文件同时含第 49/50 轮前序改行。逐 hunk 归属已在 §4 列全，未逐条向第 49/50 轮报告交叉核对归属正确性（不在本次范围） |
| 7 | **`VERIFY-REPORT-R50.md` 编号 824abc41 的原始缺陷描述** | 用户已转述 D1–D4，本次未打开该报告逐字比对，判定基于本轮实际代码与用例 |

---

## 九、验收者操作合规声明

- **未**修改任何生产文件的最终状态；6 次变异全部「改 → 跑 → 立刻逐字节还原」，还原后 SHA-256 与改动前一致（§7 已有哈希为证）
- **未**改动 `C:\Users\adkun\.dsh\ace\playbook.md`
- **未**执行任何写型 git 操作（仅 `git diff` / `git status` / `git show` / `git diff --no-index` 只读命令）；未 commit / add / checkout / stash
- **未**连接任何真实 LLM 或 magpie 网关
- **未**触碰 `lib\inject.js` 的门槛、BM25、`client.js` 前端逻辑
- 临时脚本只写在 `%LOCALAPPDATA%\Temp` 下，用 `fs.writeFileSync(p, text, 'utf8')` 写入（无 BOM），跑完已删除
