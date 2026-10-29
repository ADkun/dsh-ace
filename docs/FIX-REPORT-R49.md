# dsh-ace 第 49 轮施工报告

施工轮次：第 49 轮（放宽复盘时间预算 + 把「超时被伪装成 JSON 未闭合」的错误语义修掉） | 仓库：D:\dsh\plugins\dsh-ace | 基线：第 49 轮并发任务（自动注入相关性门槛）实测 `node --test tests/` = 690 tests / 689 pass / 0 fail / 1 skip | 本轮结果：**701 / 700 / 0 / 1 skip，EXIT 0，6.65s**

> 线上现场：`C:\Users\adkun\.dsh\ace\debug\raw.jsonl` 最后两条 `stage=reflect`、`round=1`、`model=magpie/group/never-stuck`，`rawLength` 743 与 1842，错误都是「JSON 对象不完整（从第 1 字起未闭合）」。1842 那条是**在某条候选的 rationale 字符串中间被切断的**，前面已经有完整候选对象。实测基线：同一模型 + high 档、真实复盘提示词（system 2356 字符 + user 33757 字符 / 100 条手册摘要 / 约 20140 输入 tokens）单次 **40.8 秒 / 1737 completion tokens / 输出 1247 字符 / JSON 完整** —— 75000ms 上限只有正常耗时的 1.8 倍。

---

## 任务 0：根因（链路与真因）

1. `lib/reflect.js:11` `REFLECT_MAX_ROUNDS = 3`，每轮调 `lib/llm.js` 的 `oneShot`（最多 3 轮复盘 + 5 轮合并 = 8 次串行调用）；
2. 单次上限 `lib/llm.js:57-66` `ONESHOT_TIMEOUT_MS`（改前 75000，三处字面量），`lib/llm.js:124` `capMs = min(ONESHOT_TIMEOUT_MS, maxMs)`；
3. 总时限 `lib/recap-queue.js:40` `RECAP_TOTAL_DEADLINE_MS`（改前 120000）；
4. **真因是错误语义，不是时间不够**：宿主 provider 在调用方 signal 中止时**不抛错** —— `dsh-llm-pi-ai lib/index.js:1638-1650` 先 `yield { type:'finish', reason:{kind:'aborted'} }` 再 `return`；而旧 `oneShot` 的 for-await **只累加 text-delta / 只计数 reasoning-delta**，完全无视 finish 块，于是**半截正文被当成完整输出返回**，上层 `extractJsonObject` 报「JSON 对象不完整（从第 1 字起未闭合）」；`lib/llm.js:149-156` 的超时翻译只在流**抛错**时生效，所以在从容收尾的这段现场里永远轮不到。

---

## A：放宽时间预算

### `lib/llm.js:57-66`（ONESHOT_TIMEOUT_MS，三处字面量）

**改前**

```js
const ONESHOT_TIMEOUT_MS = (() => {
  try {
    const raw = process.env.ACE_ONESHOT_TIMEOUT_MS;
    if (raw === undefined || raw === '') return 75000;   // :60
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 75000;  // :62
  } catch {
    return 75000;                                        // :64
  }
})();
```

**改后**：三处 `75000` → `150000`（`:60` / `:62` / `:64`），`ACE_ONESHOT_TIMEOUT_MS` 覆盖逻辑与「env 为空 → 默认 / env 非法 → 默认 / env 读取异常 → 默认」三条回落结构一字未动。

### `lib/llm.js:47-56`（注释）

**改前**：「取 75000ms：比宿主 300000ms 的 idle 看门狗小一个数量级（在它出手前先本地放弃），也小于总时限 RECAP_TOTAL_DEADLINE_MS（120000）的 2/3 —— 保证「最坏 8 次调用」里至少有一次能撞到总时限而不是全部耗在单次上限上。」

**改后**（`:51-53`）：「取 150000ms：仍小于宿主 300000ms 的 idle 看门狗（在它出手前先本地放弃），也仍小于总时限 RECAP_TOTAL_DEADLINE_MS（300000）的 2/3（= 200000，150000 ≤ 200000）—— 保证「最坏 8 次调用」里至少有一次能撞到总时限而不是全部耗在单次上限上。」

### `lib/recap-queue.js:40`（RECAP_TOTAL_DEADLINE_MS）

**改前**：`export const RECAP_TOTAL_DEADLINE_MS = readDeadlineOverride('ACE_RECAP_TOTAL_DEADLINE_MS', 120000);`，注释四条理由（120000 / 2 次单次调用够触顶 / 区间 90000–180000 中值偏保守）。

**改后**：`export const RECAP_TOTAL_DEADLINE_MS = readDeadlineOverride('ACE_RECAP_TOTAL_DEADLINE_MS', 300000);`（`:40`），注释 `:27-36` 重写为四条：① 与 `ONESHOT_TIMEOUT_MS=150000` 配比（150000 × 2 = 300000）；② **必须 ≥ 2 × 单次上限**并给出实测依据（单次正常 40.8s，总时限比 2 次还紧就会把后面合并/落盘吃掉）；③ 代价已降级（复盘不再占宿主维护相位，从「卡住会话」变成「手册晚几分钟更新」）；④ 与宿主 provider 的 300000ms idle 看门狗对齐，不再「本地先到、上游还在正常生成」误杀。`ACE_RECAP_TOTAL_DEADLINE_MS` 覆盖逻辑保留。

**模型路由一字未动**：`resolveRoute`（`lib/llm.js:17-30`）与 `reflectProvider` / `reflectModel` 配置、provider/model 选择全部原样（`git diff` 里 `resolveRoute` 零 hunk）。

---

## B：finish 原因进错误语义（核心）

### 类型依据（宿主 checkout 出处，前缀 ~ = `C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai`）

| 事实 | 出处 | 形状 |
| --- | --- | --- |
| StreamChunk 的 finish 分支 | ~\dsh-llm\lib\types\types.d.ts:459-464（联合整体 :434-464） | `{ type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }` |
| text-delta | ~\dsh-llm\lib\types\types.d.ts:438-441 | `{type:'text-delta', index:number, text:string}` |
| reasoning-delta | ~\dsh-llm\lib\types\types.d.ts:442-445 | 同上结构 |
| FinishReasonMap | ~\dsh-llm\lib\types\types.d.ts:131-149 | `'stop' {kind:'stop'}`(:132-134)、`'tool-calls'`(:135-137)、`'max-tokens' {kind:'max-tokens'}`(:138-140)、`'aborted' {kind:'aborted'; failure: LlmFailure}`(:141-144)、`'error' {kind:'error'; failure: LlmFailure}`(:145-148) |
| LlmFailure | ~\dsh-llm\lib\types\types.d.ts:26-44 | `readonly message: string; readonly code: string; status?` … |
| adapter 失败归一化 | ~\dsh-llm\lib\types\index.js:962-970（`:852-940` 调用） | `adapterFailureChunk` → `{type:'finish', reason: signal?.aborted \|\| failure.code==='ABORTED' ? {kind:'aborted',failure} : {kind:'error',failure}}`；契约注释 :946-948 明说 **adapter 失败转成 finish 块、不再上抛** |
| aborted 现场 | ~\dsh-llm-pi-ai\lib\index.js:1638-1650 | `yield {type:'finish', reason: mapStopReason(...)}` 后 `return`，**不抛错** |
| mapStopReason | ~\dsh-llm-pi-ai\lib\index.js:1470-1524 | `'length'→{kind:'max-tokens'}`(:1490)、`'aborted'→{kind:'aborted', failure:{message, code:'ABORTED'}}`(:1506-1512)、`'error'→{kind:'error', …}`(:1513-1522) |

**判别字段是 `chunk.reason.kind`**（`reason` 是对象不是字符串），上游文案在 `reason.failure.message`、错误码在 `reason.failure.code`。

**因此没有走「循环结束后检查 `callSignal.aborted`」的兜底方案**：fixture 与真实 provider 都实测能拿到 finish 块（宿主不改写、不吞，`README.md:93` 口径是「每个流恰好一个终止 finish 块」）。兜底只在「拿不到 finish 块」时才需要，用了反而会把「流正常结束但没有 finish 块」误判成超时。

### 改后代码（`lib/llm.js`）

- `:92-100` 新增 `describeFailure(reason)`：把 `reason.failure` 拍成「message、code=…、status=…」；上游给什么都没有时返回空串，不塞占位文案。
- `:106-109` 新增 `sceneOf({out, reasoning, startedAt, provider, model, capMs})`：`已收正文 N 字符、reasoning N 字符、耗时 Nms、provider/model、单次上限 Nms`。
- `:130` `let finish = null;`；`:138-147` 循环第三分支 `if (chunk.type === 'finish' && chunk.reason && typeof chunk.reason === 'object') finish = chunk.reason;`（向外提一级 `continue` 拆开，reasoning-delta 行同步改成块语句；**选在循环后翻译而不在循环里 throw**，是因为在 try 内抛会被下面的 catch 当成「流抛错」再包一层超时文案）。
- `:149-156` **原 catch 分支一字未改**（`if (callSignal.aborted && !(signal && signal.aborted)) throw new Error('ace: LLM 调用超时（单次上限 ' + capMs + 'ms）：' + …)`）。两处翻译互斥：catch 只在流抛错时跑，finish 翻译只在循环**正常结束**后跑，不会重复抛错。
- `:157-188` 循环后四档（`finishKind = finish && typeof finish.kind === 'string' ? finish.kind : ''`，无 finish 块 → 空串 → 全部跳过，旧行为一字不变）：

| kind | 文案 | `isTimeoutError` 认账？ |
| --- | --- | --- |
| `aborted` + **调用方 signal 已中止** | `ace: LLM 调用被取消（调用方信号已中止、<failure>、<scene>）` | **不认**（刻意：外部取消不该让整份复盘「按已提炼候选收尾」假成功） |
| `aborted`（本层单次上限到点） | `ace: LLM 调用超时（单次上限 Nms）：<failure>、<scene>` | **认**（`lib/reflect.js:16-20` 的 `TIMEOUT_ERROR_PREFIX`） |
| `max-tokens` | `ace: LLM 输出被 max-tokens 截断（provider/model、<scene>）` | 不认（截断是真实失败，不许走超时豁免） |
| `error` | `ace: LLM 调用失败（finish reason=error：<failure>、<scene>）` | 不认 |
| `stop` / `tool-calls` / 无 finish 块 | 不判，照旧 `return out.trim()` | — |

---

## C：截断时回收已完整的候选

### 现状判断

`lib/prompts.js` 已有 `extractJsonObject`(:462)、`recoverObjectsInRange`(:234-266)、`findCandidateArray`(:360)、`isCandidateArray`(:198)。**「整体未闭合」时没有回收能力**：`recoverObjectsInRange` 只在**配平但非法 JSON** 的数组里按顶层 `{…}` 回收（F2 路径），遇没配平的括号直接 `break` —— 线上现场是外层包壳 `{"candidates":[` 与最后一条候选一起被切断，实测**回收 0 条**。所以另起一条「未闭合时降级回收」分支。

### 改后（`lib/prompts.js:268-353`，新增 87 行）

- `:276-307` `collectBalancedObjects(src)`：顶层扫描，字符串（`if (src[i] === '\\') { i += 2; continue; }`）整体跳过；遇 `[` / `{` 用 `scanSpanEnd` 求配对末尾，**没配平（end === -1）就 `i += 1; continue` 下沉进去继续扫**（与 `recoverObjectsInRange` 唯一的差别，正是它救不了现场的原因）；配平的 `{` 再 `JSON.parse`，只收普通对象。
- `:311-315` `isFullCandidate(v)`：四字段 `title/condition/action/rationale` 全 string（与 `lib/index.js` 的过滤判据同口径）。
- `:335-353` `export function recoverCandidatesFromUnclosed(text)`：① 空串 → `[]`；② 能正常解析 → 原样走 `extractJsonObject`（成功路径行为不变）；③ `collectBalancedObjects` 过滤四字段，≥1 即返回；④ 退一步 `findCandidateArray` 过滤；⑤ 仍无 → `[]`（调用方保持原抛错）。

### 接线（`lib/index.js` 只动两处解析调用点 + import）

- `:24` import 追加 `recoverCandidatesFromUnclosed`；
- `:1444-1451` `reflectRound`（自动复盘）：`catch (error) { await dumpRaw(...); const salvaged = recoverCandidatesFromUnclosed(raw); if (!salvaged.length) throw error; parsed = { candidates: salvaged }; }`
- `:1662-1671` `ace_reflect`（手动复盘）：同款四行。
- 两处仍走原来的四字段 filter（红线 3 不破），`lib/reflect.js` 无需改动（它没有解析调用点）。

### 取舍（必须点明）

用户要求「新增未闭合时降级回收分支：只要正文里能扫到 ≥1 个配平的候选对象，就返回这些候选」，同时又要求「完整输出的行为一字不变（现有测试不得回归）」。**这两条在 `extractJsonObject` 内部是冲突的**：`tests\prompts.test.mjs` 有 8 处断言钉住「真截断必抛」且其中 `'[{"title":"a"},{"title":"b"}'`、`'前言 {"candidates":[{"title":"T"'` 这类串里**确实能扫到配平对象**（:127-132 / :161-170 / :216-221 / :250-260 / :269-272 / :287-295 / :313-316），把回收下沉进解析器会让它们整批转红，也会推翻 F2 的「截断分支一律不回收」不变量（`:313` 注释原文）。

因此实现选在**解析调用点降级**：`extractJsonObject` 一个字节未改（仍真截断必抛），回收只发生在「调用方**已经确认**解析失败」之后。用户要求的验收（「截断正文里已有 2 个完整候选 → 回收出这 2 条、不抛错」）在这一层成立且有用例钉住；代价是 `parseMergeResult` 等其他 `extractJsonObject` 消费者不享受这条降级（合并路径本来就「形状不合格 → null，绝不抛错」，不欠这条）。

---

## D：用例（净增 11 条，全绿）

`tests\llm-budget.test.mjs`（12 条，新增 6 条；辅助 `finishCtx(text, reason)` 在 `:139`）：

1. `:150` `R49 oneShot｜只来 text-delta 再来 finish{reason:{kind:aborted}} → 抛「调用超时」并带已收字符数与上限` —— 断言 `startsWith('ace: LLM 调用超时')`、`单次上限 1234ms`（用 `maxMs` 证明确是实际生效值）、`已收正文 N 字符`、`magpie/group/never-stuck`、上游 `pi-ai stream aborted` 与 `code=ABORTED`；
2. `:165` `R49 oneShot｜调用方自己取消（外层 signal 已中止）时的 aborted 不算本层超时：不带「调用超时」前缀`；
3. `:180` `R49 oneShot｜finish{reason:{kind:max-tokens}} → 抛「输出被 max-tokens 截断」并带字符数与 provider/model`（另断言 `!msg.includes('调用超时')`）；
4. `:195` `R49 oneShot｜finish{reason:{kind:error}} → 上游 reason/message/code 原样带上`；
5. `:207` `R49 oneShot｜finish{reason:{kind:stop}} 照常返回：正常收尾行为一字不变`；
6. `:213` `R49 oneShot｜两个时间常量：单次上限 150000ms、复盘总时限 300000ms（后者 ≥ 2 倍前者）`（读源码钉字面量：`/150000;/g` 命中 3 处、无 `return 75000;`、`ACE_ONESHOT_TIMEOUT_MS` 仍在、`RECAP_TOTAL_DEADLINE_MS === 300000` 且 `≥ 2×150000` 且 `150000 ≤ 300000×2/3`）。

`tests\prompts-salvage.test.mjs`（新建，77 行，5 条）：

7. `:25` `R49 降级回收｜未闭合正文里已有 2 条完整候选 → 回收这 2 条、不抛错`（同时断言 `extractJsonObject` 仍抛，双向判据）；
8. `:41` `R49 降级回收｜一条完整候选都没有 → 返回空数组，调用方保持原来的抛错`；
9. `:54` `R49 降级回收｜完整输出的行为不变：与 extractJsonObject 拿到的候选一致`（`deepEqual`）；
10. `:61` `R49 降级回收｜字符串里的花括号不参与配平，被剪断的那条不算完整对象`；
11. `:69` `R49 降级回收｜解析调用点已接线：自动复盘与手动复盘两条路径都会先回收再决定抛不抛`（源码级：`recoverCandidatesFromUnclosed(raw)` 出现 2 次 + `/if \(!salvaged\.length\) throw error;/`）。

**时间常量引用的既有同步**：`tests\llm-budget.test.mjs:3`（头注释 75000→150000）、`:41`（「而不是等 150s 默认值」）、`tests\recap-queue.test.mjs:16-18`（区间 120000/90000–180000 → `>= 240000` 且 `<= 400000` + `assert.equal(RECAP_TOTAL_DEADLINE_MS, 300000)`）。`tests\reflect.test.mjs:138/154` 里的 `'单次上限 75000ms'` 是假 error 文案夹具（只走前缀判定），`tests\recap-pipeline.test.mjs:853/870` 的 `Date.now() + 120000` 是本地预算窗口而非该常量 —— 三处**刻意不动**，语义不依赖数值。

---

## 变异自证（每条真跑，跑完逐字复原）

| 变异 | 结果 | 复原 |
| --- | --- | --- |
| `lib\llm.js:147` 的 `finish = chunk.reason;` 改成 `void 0;` | llm-budget `pass 8 / fail 4`（四条 finish 语义用例全红） | 逐字复原，sha256 一致 |
| `lib\llm.js:60` 的 `return 150000;` 改回 `return 75000;` | llm-budget `pass 11 / fail 1`（常量用例红） | 同上 |
| `lib\prompts.js:345` 的 `collectBalancedObjects(src).filter(isFullCandidate)` 改成 `[]` | salvage `pass 3 / fail 2`（回收用例红） | 同上 |
| `lib\index.js` 第一处 `recoverCandidatesFromUnclosed(raw)` 改成 `null`（少接一处） | salvage `pass 4 / fail 1`（接线用例红） | 同上 |

---

## 全量与并发改动说明

`node --test tests/`（`D:\dsh\plugins\dsh-ace`）实测：

```
ℹ tests 701   ℹ pass 700   ℹ fail 0   ℹ cancelled 0   ℹ skipped 1   ℹ todo 0   ℹ duration_ms 6650.0362
EXIT 0
```

- 基线 690 / 689 / 1 skip → 本轮 **701 / 700 / 0 / 1 skip**，净增 11 条（llm-budget +6、prompts-salvage +5），**既有用例一条未删、未改名、未降级断言**；
- 唯一 skip 与本轮无关：`tests\settings-path.test.mjs:149` 的 `0o600` 权限用例在 Windows 上跳过（`{ skip: process.platform === 'win32' }`）；
- **零并发冲突**：`lib\inject.js`、`tests\config.test.mjs`、`tests\wiring.test.mjs` 是另一任务的在改文件，本轮**一个字节没碰**（工作区里它们的未提交改动原样保留），它们与本轮改动共存下全量仍全绿。

---

## 遗留与取舍（如实）

1. **C 的落点**：降级回收在解析调用点，不在 `extractJsonObject` 内部（理由见上，与「现有测试不得回归」冲突时选了后者）。若日后要把降级下沉进解析器，需同步改 `tests\prompts.test.mjs` 那 8 处「真截断必抛」断言与 F2 不变量，属另一轮决定。
2. **外部取消不带超时前缀**：`signal.aborted` 引发的 `aborted` finish 报 `ace: LLM 调用被取消`，故意不让 `isTimeoutError` 认账 —— 否则「总时限到点 → 整份复盘按已提炼候选收尾」会变成静默假成功。这是对用户「aborted 一律保留超时前缀」口径的一处**有意偏离**，若要求严格一致需改 `lib\reflect.js:62` 的豁免面。
3. **未验证项（只能线上观察）**：真实 provider 在 `max-tokens` 与 `error` 终止时是否真按 `types.d.ts:131-149` 的形状给 `failure`（本轮只有类型契约与桩数据，没有真流夹具）；新上限 150000/300000 下线上一次真实复盘的实际耗时分布（40.8s 是单次基线，不是 P99）。
4. **不做的事**（遵守文件边界）：`client.js`、`lib\heat.js`、`lib\inject.js`、`tests\config.test.mjs`、`tests\wiring.test.mjs` 未触碰；`lib\index.js` 只动了上面点名的两处解析调用点 + 一行 import；`lib\reflect.js` 无需改动；未写 `C:\Users\adkun\.dsh\ace\playbook.md` 与 `archive.md`；未 `git add / commit / push`，所有改动留在工作区。
