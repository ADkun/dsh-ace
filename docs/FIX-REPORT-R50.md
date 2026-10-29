# dsh-ace 第 50 轮施工报告（后端纵切）

施工轮次：第 50 轮（复盘思考档位：默认自动降到该模型最低档 + 超时降档重试一次 + `GET /api/dsh-ace/efforts`） | 仓库：D:\dsh\plugins\dsh-ace | 范围：**只改后端**（lib/ + 测试 + 文档），`client.js` 一个字节没碰（前端由另一支子代理施工） | 基线：用户口述「第 49 轮刚测 701 / 700 / 1 skip」，本轮开工前在同一工作区实测 `node --test tests/` = **701 tests / 700 pass / 0 fail / 1 skip** | 本轮结果：**719 / 718 / 0 / 1 skip，EXIT 0，6.55s**（两次收尾实测 6552ms 与 6337ms）

> 宿主事实全部来自 checkout `~` = `C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai`，逐条在代码注释里注明 file:line（红线 4）。

---

## 0. 为什么要这一轮（核心事实）

| 事实 | 出处 |
| --- | --- |
| 会话默认档位的解析：`resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning)` | `~\dsh-llm-pi-ai\lib\index.js:1953` |
| 只要 profile 写了 `reasoningEffort`（本机 `C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml:12` 写着 `high`），它**盖过**模型的 `defaultEffort` | 同上 |
| ⇒ **「不传」不等于「最低档」，也不等于「模型默认档」**，而是「沿用 profile 的 high」⇒ 插件必须显式传 `GenerateOptions.reasoningEffort` | `~\dsh-llm\lib\types\types.d.ts:511` |
| `LlmResolvedModelInfo.reasoning.efforts` 由弱到强排列（注释原文「Supported efforts from least to greatest selectable reasoning effort」）⇒ `efforts[0].id` 即最低档 | `~\dsh-llm\lib\types\types.d.ts:367-375`；单条 `LlmReasoningEffortInfo={id,name,description?}` `:358-365` |
| 查档位入口 `ctx.llm.resolveModelInfo(provider, model, signal?)`，第三形参 signal 真透传 | `~\dsh-llm\lib\types\index.d.ts:377`；实现 `~\dsh-llm\lib\types\index.js:604-610` |
| 传了模型没声明的档位 → 宿主直接抛 `UNSUPPORTED_REASONING_EFFORT` | `~\dsh-llm-pi-ai\lib\index.js:1785-1789` |

**四条实测（用户按真实库跑出，本轮当基准用）**：`group/never-stuck`（当前会话模型）只声明 `high` → 只有一项；`auto/deepseek-v4.1-flash` → `[low,high,xhigh]`；`auto/glm-5.3-flash` → `[off,low,medium,high,xhigh]`；`auto/minimax-m3.1-flash:free` → `[low,medium,high,xhigh,max]`。所以「可用集只有一项」「压根没有 reasoning 字段」在这个生态里是**常态**，必须走不干预。

---

## A. 两个新配置键（五处全接，缺一处就是「存了不生效」）

| 落点 | file:line | 改前 | 改后 |
| --- | --- | --- | --- |
| Config schema | `lib/index.js:151-152` | （无） | `:151 reflectReasoningEffort: z.string()…default('')`、`:152 autoReasoningDowngrade: z.boolean()…default(true)` |
| 读盘归一 | `lib/index.js:388-394` | （无） | `:388 validReasoningEffort(raw.reflectReasoningEffort)`；`:390-392` 非法值丢弃 + warn『丢弃无效的 reflectReasoningEffort（需为 off/minimal/low/medium/high/xhigh/max 之一，或留空表示跟随自动降档）』；`:393-394 validFlag(raw.autoReasoningDowngrade)` |
| applyStored 白名单 | `lib/index.js:547` | 14 键数组 | **16 键**数组（末两项 `'reflectReasoningEffort', 'autoReasoningDowngrade'`） |
| describe() / bounds | `lib/index.js:2063` | （无） | `reasoningEfforts: REASONING_EFFORT_IDS`（设置页下拉的唯一清单） |
| POST 校验 | `lib/index.js:2403-2414` | （无） | `:2406` 非法档位 400『reflectReasoningEffort 必须是 off/minimal/low/medium/high/xhigh/max 之一，或留空表示跟随自动降档』；`:2412` 布尔非法 400『autoReasoningDowngrade 必须是 true 或 false』。空串 `''` 是**合法值**（= 未手动指定），`validReasoningEffort` 显式认它 |

测试同步（这两处归我改，**同名用例内扩断言，一条没删、没改名、没降级**）：`tests/config.test.mjs:107/110` 字段数 14 → **16**；`tests/wiring.test.mjs:404/405` 字段数 14 → 16 + 16 键字面量数组。**注意**：这两个文件的 diff 里还混着第 49 轮的门槛项改动（`FIVE`/`DEFAULTS`/`RANGES` 扩到 `injectMinScoreIdfRatio`/`injectMinRelativeToTop`），**不属于本轮 R50 后端**。

---

## B. 自动降为最低档（核心）

新文件 **`lib/reasoning.js`（234 行，未跟踪）**，零宿主 import、零新增依赖、不读盘（红线 5/6 同口径：宿主能力全部经参数注入）。

| 符号 | file:line | 职责 |
| --- | --- | --- |
| `REASONING_EFFORT_IDS` | `:29` | `['off','minimal','low','medium','high','xhigh','max']` —— POST 校验与设置页的唯一清单 |
| `EFFORT_QUERY_TIMEOUT_MS` | `:32` | `15000`（与 `lib/catalog.js` 的 `withTimeout` 同档，注释写明） |
| TTL / 上限 | `:34/36/38` | 成功 `10min`、失败 `60s`、`EFFORT_CACHE_LIMIT=128` 后整表清空 |
| `validReasoningEffort` | `:52` | 空串/空白串 → `''`；`' off '` → `'off'`；`'HIGH'`/数字 → `undefined` |
| `decodeModelEfforts` | `:80` | 解码宿主返回；`:101-104 note = noReasoning / noEfforts / singleEffort`；`:98-100 defaultEffort` 不在集里 → 回落末项 |
| `queryModelEfforts` | `:121` | **永不抛**；`AbortSignal.timeout(15000)` 透传（`:139-141`）+ `withinMs(timeoutMs+1000)` 硬计时兜底（`:144`）；失败只回 `{ok:false,error}`；`:134` `refresh:true` 绕缓存；**不落盘**（红线 9） |
| `planReasoningEffort` | `:177` | 判定顺序：手动值（`:192-201`，不在声明集则 `:197` warn『配置的思考档位 X 不在模型 p/m 声明的档位集里（…），已丢弃』并回落）→ 自动最低档（`:203-219`）→ 不干预 |
| `lowestEffortOf` | `:228` | 超时重试用：`efforts.length < 2` → `null`（降到「唯一那档」毫无意义） |

**四种不干预情形与各自的 warn（文案互不相同，线上能分清是哪一种）**：

| 情形 | 代码 | warn |
| --- | --- | --- |
| 档位集只有一项 | `:212-214` | `dsh-ace: 模型 p/m 只声明了一个思考档位（Y），不自动降档` |
| 没有 reasoning 字段 / efforts 为空 | `:208-210` | `dsh-ace: 模型 p/m 未提供思考档位信息，不自动降档` |
| 查询失败或超时 | `:204-207` | `dsh-ace: <原因>，本次不降档` |
| 自动降档关且无手动值 | `:221` | 不 warn（`effective.reason='ace: 自动降档已关闭'`） |

**接线（`lib/index.js`）**

| file:line | 改前 | 改后 |
| --- | --- | --- |
| `:28` | 无该 import | `import { EFFORT_QUERY_TIMEOUT_MS, lowestEffortOf, planReasoningEffort, queryModelEfforts, REASONING_EFFORT_IDS, validReasoningEffort } from './reasoning.js'` |
| `:1131-1172` | 无 | 档位注释块（含三类宿主出处）+ `:1140 observedSessionRoute` + `:1141-1150 warnEffortOnce`（同模型同句每进程一条，满 64 clear）+ `:1152-1156 autoDowngradeOn`（只有 `false`/`'false'` 算关）+ `:1157-1172 effortPlanFor` |
| `:1489-1502` | `reflectRound({ …, maxMs })` | 签名加 `reasoningEffort`，`:1501` 透传给 `oneShot` |
| `:1573-1579` | deps.reflectRound 无档位 | `:1575-1577` 重试传下来的档位优先、否则 `effortPlanFor(route)`；`:1578` 传 `reasoningEffort` |
| `:1583-1590` | 无 | `deps.downgradeEffort`：`refresh:true` 查一次 → `lowestEffortOf(info)`（失败/单档/无档 → `null` ⇒ 管线原样上抛） |
| `:1595-1608` | mergeAsk 无档位 | `:1598` effort、`:1606 reasoningEffort: effort`（同一份复盘的两次 LLM 调用档位一致） |
| `:1739-1748` | 手动 `ace_reflect` 无档位 | `:1741` effort、`:1747 reasoningEffort: effort` |

`lib/llm.js`：`:111` 签名加 `reasoningEffort`；`:120-123` 三行注释（`~\dsh-llm-pi-ai\lib\index.js:1953`、`:1785-1789`）；**`:124` 只在合法非空字符串时才写 `options.reasoningEffort`**（缺省/空串不写该键——把「不干预」表达成**键的缺席**）。**`resolveRoute` 一个字节没动**（`git diff -U0` 里 `resolveRoute` 零 hunk），`reflectProvider`/`reflectModel` 解析逻辑原样。

---

## C. 真超时兜底：回收（第 49 轮，未动）+ 降档重试一次（本轮）

| 事实 | file:line |
| --- | --- |
| 单次上限 `ONESHOT_TIMEOUT_MS=150000`（第 49 轮，**未动**） | `lib/llm.js:57-66` |
| 复盘总时限 `RECAP_TOTAL_DEADLINE_MS=300000`（第 49 轮，**未动**） | `lib/recap-queue.js:40` |
| 截断正文回收 `recoverCandidatesFromUnclosed`（第 49 轮，**未动**） | `lib/prompts.js`，接线在 `lib/index.js` 的 `reflectRound` 与 `ace_reflect` 两处 |
| 超时语义判据 | `lib/reflect.js:17 TIMEOUT_ERROR_PREFIX`、`:18 isTimeoutError`、`:20 return message.startsWith(...)` |

**本轮改动**

| file:line | 改前 | 改后 |
| --- | --- | --- |
| `lib/reflect.js:17/18` | 私有 `const` / `function` | 仅加 `export`（判据、行为、`:63` 的用法一字未改） |
| `lib/recap-pipeline.js:27-28` | 只 import `reflectRounds, REFLECT_MAX_ROUNDS` | 追加 `isTimeoutError` + 一行为什么只认超时的注释 |
| `lib/recap-pipeline.js:217` | `callRound: (round, priorCandidates) => {…}`（同步） | `callRound: async (round, priorCandidates) => {…}` |
| `lib/recap-pipeline.js:230-232` | 直接 `return deps.reflectRound({… maxMs})` | 抽出 `const callMaxMs = budget.enabled ? maxMs : undefined;` 后 `return await deps.reflectRound({…, maxMs: callMaxMs })` |
| `lib/recap-pipeline.js:233-250` | 无 catch（错误直接冒泡到 `reflectRounds`） | `:238 if (!isTimeoutError(error)) throw error;`（普通错误不重试）→ `:239` 无能力不重试 → `:240 downgradeEffort` → `:241` 拿不到更低档不重试 → `:245` warn『dsh-ace: 多轮复盘第 R 轮超时，已降到最低档 X 重试一次』→ `:249` 重试一次（带 `reasoningEffort: lower`）；重试仍抛则原样上抛（**绝不假成功**） |

**为什么落点在 `lib/recap-pipeline.js` 的 `callRound`，而不是 `lib/reflect.js` 的 `reflectRounds`**：`reflectRounds` 是**纯轮次编排**（收敛判据、第一轮抛错上抛、后续轮按已提炼候选收尾），它拿 `callRound` 依赖却**不该知道模型有哪些档位**——那是生产侧知识（要读活配置、要打宿主 `resolveModelInfo`）。把重试放在 `callRound` 外层，`reflectRounds` 的收敛/中断语义一个字节不变（`tests/reflect.test.mjs` 全绿），重试的「能不能降、降到哪」继续走 `deps.downgradeEffort` 注入，管线本身仍然零宿主 import。**最多一次**由结构保证：重试那一次是「已经降过档的那次」，它再超时就走 `:249` 直接上抛，没有第二层 catch，**不可能是两层嵌套**。

---

## D. `GET /api/dsh-ace/efforts`

| file:line | 内容 |
| --- | --- |
| `lib/index.js:1181-1189` | `agent/pre-step` 里记一笔「最近一次观察到的会话路由」（`:1187 observedSessionRoute = resolveRoute(live, { agent })`，try/catch 吞错、解析不出来保留上一次；**不新增事件订阅**） |
| `lib/index.js:2241-2290` | 路由本体：`:2250` 非 GET → 405 `{error:'method not allowed'}`；`:2253-2255` provider+model 都给就用、**都没给**才回落观察值；`:2257` 两者都没有 → `send(200,{ok:false,error:'ace: session model unknown'})`（**绝不 500**）；`:2260` 只解析问到的这一个 `provider+model`（绝不逐个 provider 全量解析）；`:2263-2266` 查询失败只 warn + `send(200,{ok:false,error:'ace: …'})`；`:2267-2285` 成功体；`:2286-2289` 兜底 catch 同样结构化 |
| `lib/index.js:2291` | 未知路由仍是既有 `send(404,{error:'not found'})` |

返回体（**与前端约定死，只许加字段不许改名**）：

```json
{ "ok": true, "provider": "...", "model": "...",
  "efforts": [{ "id": "off", "name": "档位off" }],
  "defaultEffort": "high",
  "effective": { "effort": "off", "source": "auto" } }
```

`effective.effort` 为 `null` 表示本插件不干预（沿用宿主默认档），此时 `source` 为 `'none'` 且带 `reason`。

---

## 用例（净增 11 条，全部真跑通过）

`tests/r50-reasoning.test.mjs`（新建，575 行，11 条）。脚手架：`:21` `DSH_HOME` 指向 `os.tmpdir()` 临时目录（红线 20 末段，不往用户真实 `~/.dsh` 灌夹具）、`:45-47` 真 import `lib/index.js`/`lib/reasoning.js`、`:49` 档位夹具、`:96 makeHost`、`:172 callRoute`。

| # | 用例名（逐字） | 行 | 结论 |
| --- | --- | --- | --- |
| 0 | `R50-0｜纯逻辑：档位名校验 / 宿主档位解码 / 最低档判定（不干预的三种情形都返回 null）` | `:211` | 通过 —— `validReasoningEffort` 空串合法、`'HIGH'`/数字非法；`decodeModelEfforts` 三种 note；`lowestEffortOf` 在 noReasoning/noEfforts/singleEffort 都返回 `null` |
| 1 | `R50-1｜默认自动降档：模型声明多档 → 发给宿主的 reasoningEffort 等于该模型最低档 efforts[0]` | `:240` | 通过 —— 假 provider 收到的 `options.reasoningEffort === 'off'`（`auto/glm-5.3-flash`） |
| 2 | `R50-2｜手动档位优先：配置 reflectReasoningEffort=high → 发出去的是 high，不被自动降档覆盖` | `:256` | 通过 —— 发出 `'high'`，自动最低档 `off` 未生效 |
| 3 | `R50-3｜手动档位该模型没声明 → 丢弃 + warn，回落自动降档（绝不硬发给宿主）` | `:271` | 通过 —— 手填 `max`、该模型无 `max` → warn 含「已丢弃」、实发 `'off'`，**没有发出 `max`** |
| 4 | `R50-4｜autoReasoningDowngrade=false 且无手动值 → options 里没有 reasoningEffort 这个键` | `:288` | 通过 —— `assert.ok(!('reasoningEffort' in options))`（断言是**键不存在**，不是值空）；字符串 `'false'` 同样算关 |
| 5 | `R50-5｜模型只声明一个思考档位 → 不干预（不发 reasoningEffort）并落一条 warn` | `:313` | 通过 —— `group/never-stuck` 情形，无该键 + warn 含「只声明了一个思考档位」 |
| 6 | `R50-6｜档位查询缺失/抛错/超时 → 不干预、复盘照常走完（只 warn，绝不抛）` | `:329` | 通过 —— 三段：(a) 无 `resolveModelInfo`；(b) 抛 `INVALID_MODEL_INFO`；(c) 挂死 provider + `timeoutMs:20` → `/timeout after/` 且 `signal.aborted === true`；**复盘不抛错** |
| 7 | `R50-7｜某一轮超时 → 降到最低档重试该轮一次（恰好两次调用，第二次带最低档）` | `:369` | 通过 —— 恰好 2 次调用：`[0]='high'`、`[1]='off'`；warn『第 1 轮超时，已降到最低档 off 重试一次』 |
| 8 | `R50-8｜重试仍失败：普通错误不重试并上抛；超时重试仍失败时候选照常落盘、不假成功` | `:391` | 通过 —— (a) 普通错误**只调用 1 次**并上抛；(b) 第 2 轮首发+重试都超时 → 共 3 次、`[2]='off'`、第 1 轮候选照常落盘 1 条、结果仍是真 success |
| 9 | `R50-9｜新键配置面：默认值 / bounds / POST 落盘读回 / 非法档位 400 / 读盘归一 / 白名单 16 键` | `:431` | 通过 —— 16 键、默认 `''`/true、`bounds.reasoningEfforts`、POST `{xhigh,false}` 落盘读回、`HIGH/ultra/mid/7` 全 400（文案含七个档位名）、空串 200、`'maybe'` → 400、手改坏文件归一 + warn、白名单 16、`configured` 仍为默认 |
| 10 | `R50-10｜GET /api/dsh-ace/efforts：显式参数 / 宿主抛错不 500 / 无会话路由 / 405 / 落到会话路由` | `:505` | 通过 —— (a) 显式参 `ok:true` 带 efforts + `defaultEffort:'high'` + `effective{effort:'off',source:'auto'}`，手填后 `{effort:'medium',source:'manual'}`；(b) 未知模型 → **200** `ok:false` + `/^ace: /`；(c) 无参无观察 → `{ok:false,error:'ace: session model unknown'}`；(d) POST → 405；(e) 走一次 `agent/pre-step` 后同一个 GET 变 `ok:true`，且**路由一次 LLM 都没发** |

单文件实测：`tests/r50-reasoning.test.mjs` → `tests 11 / pass 11 / fail 0`。

---

## 变异自证（每条真跑，跑完逐字复原并用 `Get-FileHash` 核对）

| 变异 | 结果 | 复原 |
| --- | --- | --- |
| `lib/recap-pipeline.js:238` `if (!isTimeoutError(error)) throw error;` 改成 `throw error;`（去掉超时判定 → 普通错误也重试） | r50 单文件 `pass 9 / fail 2`（R50-7、R50-8 转红） | 逐字复原，sha256 一致 |
| `lib/index.js:1575-1577` 的「重试传下来的档位优先」改成恒走 `effortPlanFor`（丢掉降档值） | `pass 9 / fail 2` | 逐字复原，sha256 一致 |
| `lib/llm.js:124` 改成无条件 `options.reasoningEffort = reasoningEffort;`（连「不干预」也写该键） | `pass 8 / fail 3`（R50-4/5/6 的「键不存在」断言转红） | 逐字复原，sha256 一致 |

工作区扫描 `MUTANT` 关键字：0 命中；备份文件已删除。

---

## 全量验收

```
D:\dsh\plugins\dsh-ace> node --test tests/
ℹ tests 719
ℹ suites 0
ℹ pass 718
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 6552.366
EXIT 0
```

- 基线 **701 / 700 / 0 / 1**（本轮开工前实测）→ 本轮 **719 / 718 / 0 / 1**，净增 18 = **本轮的 11 条**（tests/r50-reasoning.test.mjs）+ **7 条 `R50｜…``**（tests/client-picker.test.mjs，属前端那支，不计入后端基线）；
- **既有用例一条未删、未改名、断言语义一条未降级**（config/wiring 只在同名用例内扩到 16 键）；
- 唯一 skip 与本轮无关：`tests/settings-path.test.mjs` 的 `0o600` 用例在 Windows 上跳过；
- `node --check` 对 9 个改过的文件全部 OK：`lib/index.js`、`lib/llm.js`、`lib/reflect.js`、`lib/recap-pipeline.js`、`lib/reasoning.js`、`tests/r50-reasoning.test.mjs`、`tests/config.test.mjs`、`tests/wiring.test.mjs`、`tests/llm-budget.test.mjs`（`EXIT 0`）。

---

## 「仍失败留待下次」核查结论：**部分做到 ⇒ 只报告、零改动**

| 事实 | file:line |
| --- | --- |
| 真实失败（含 LLM 超时）分支：只 warn + 把 mutating 计数还回状态 + 推失败提示 | `lib/recap.js:287 logWarn('dsh-ace: 自动复盘失败（…）')`、`:288 restorePendingMutCount(st, pending, logger)`、`:289 notifyFailure?.(…)` |
| **冷却不回滚**是第 33 轮起的刻意行为（注释原文「失败说明确实尝试过」） | `lib/recap.js:285-286` |
| 放回队列**只用于「撞宿主忙碌」**，真实失败不走这条路 | `lib/recap.js:250 if (isBusyError(error))` → `:255 requeuePendingRecap(...)` → `:259` 耗尽 |
| 待办取出即摘掉、失败只还计数（不重新挂待办） | `lib/trigger.js:247 takePendingRecap`（`:251 st.pending = null`）、`:454 restorePendingMutCount`（`:475`、`:479 st.mutCount = clampMutCount(st.mutCount) + clampMutCount(pending.mutCount)`） |
| 队列侧：**每一次入队的项都恰好 settle 一次**，失败/超时都是 settle 而不是重排 | `lib/recap-queue.js:140-142`（注释）、`:215 settle({ok:false,timeout:true})`、`:222 settle({ok:false,reason:'复盘失败…'})`、`:227 settle({ok:true})` |

**结论**：现有机制**不会**把「这一份失败的待办」留到下次——它只把 mutating 计数还回 `state`（`lib/recap.js:288`），冷却不回滚；下一回合按 `autoRecapThreshold`（默认 1）**重新攒计数、挂一份新待办**。也就是说「下一回合仍会复盘」成立，但「同一份待办原地重试/保留」不成立。按用户口径（已做到就只报告不改）——这条属**部分做到**，因此**一个字没改**；若要真做到「保留同一份失败待办」，得在 `lib/recap.js:287-289` 之后加一条受控重排（还要处理 `attempts`、冷却与 `SETTLED_PENDINGS` 账本），属另一轮的决定。

---

## 取舍与未做到（如实）

1. **落点**：超时降档重试放 `lib/recap-pipeline.js` 的 `callRound`，不放 `lib/reflect.js`（理由见 C 段：`reflectRounds` 是纯轮次编排，不该知道模型档位；且它在 `lib/index.js` 与测试里被直接调用，改它会牵动收敛语义）。代价：`reflectRounds` 的调用方若自己实现 `callRound` 而不接 `deps.downgradeEffort`，就享受不到重试——但那正是「旧行为一字不变」的保证（缺能力 → 原样上抛）。
2. **查询失败缓存只有 60s**：比成功缓存（10min）短得多，避免一次网络抖动把降档关一小时；代价是持续故障时每 60 秒会再打一次 `resolveModelInfo`（一次复盘最多一次，因为同一次复盘的多轮共享一次查询结果之外的命中，且 warn 做了去重）。
3. **warn 去重**（`lib/index.js:1141-1150`）：同一 provider+model+句子每进程只落一条，满 64 条 clear。好处是一次复盘 3 轮不会刷 3 行；代价是长时间运行后同一模型可能再落一次（可接受，只影响日志条数不影响行为）。
4. **`efforts` 只有一项 / 没有 reasoning 字段时绝不发值**：技术上可以发「唯一那档」（对当前模型等于没改，但会把「沿用 profile」变成「显式指定」），本轮按用户口径选了**不干预**——语义更诚实，也避免「等于没改却声称改过」。
5. **`GET /efforts` 不带参数时依赖「最近一次观察到的会话路由」**：只在 `agent/pre-step` 记，进程重启即清空（与红线 9 一致：不落盘）。首屏在会话还没走过任何一步时会给 `{ok:false,error:'ace: session model unknown'}`，设置页据此显示「未知」，属预期。
6. **没能确认 / 只能线上观察的点**（不编）：
   - 真实 provider 对 `AbortSignal` 的实际响应速度：`queryModelEfforts` 有 `AbortSignal.timeout` + `withinMs` 双保险，但「adapter 是否理会 signal」只在桩里验证过（`R50-6(c)` 断言 `signal.aborted === true` 是桩侧观察）；
   - 各真实模型 `defaultEffort` 与线上实际生效档的一致性（本轮只用用户给的四条实测当基准，没有逐个模型再跑）；
   - 线上复盘「每轮都降到最低档」对候选质量的实际影响（本轮只有行为面用例，没有质量评估）；
   - 超时降档重试在真实 provider 上的收益（有多少次超时能在降档后救回）。
7. **不做的事**（遵守文件边界）：`client.js`、`lib/inject.js`、`lib/heat.js`、`lib/catalog.js`、`tests/inject.test.mjs`、`tests/inject-delivery.test.mjs`、`tests/heat*.test.mjs` **一个字节没碰**（工作区里别人未提交的改动原样保留）；`resolveRoute` / `reflectProvider` / `reflectModel` 解析逻辑零改动；第 49 轮的 `ONESHOT_TIMEOUT_MS=150000`、`RECAP_TOTAL_DEADLINE_MS=300000`、`recoverCandidatesFromUnclosed` 全未推翻；未新增 npm 依赖、未 import 宿主包；未写 `C:\Users\adkun\.dsh\ace\playbook.md` 与 `archive.md`；**未 git add / commit / push**（所有改动留在工作区）。

---

## 文档同步

| 文件 | 落点 |
| --- | --- |
| `AGENTS.md` | `:35` `lib/llm.js` 补第 50 轮一句；`:36` 新增 `lib/reasoning.js` 行；`:47` `lib/reflect.js` 补「只加导出、不改语义」；`:90` 红线 20 尾部追加第 50 轮基线段（719/718/1skip、净增 11 条、前端 7 条不计入、指向本文件） |
| `DESIGN.md` | `:402-415` 新节「思考档位与自动降档（第 50 轮）：为什么「不传」等于没改」——显式传的理由与出处、档位顺序的唯一出处、`UNSUPPORTED_REASONING_EFFORT`、四条实测、四种不干预情形与 warn 文案、超时与缓存 TTL、重试为何放管线、哪些调用共用、`/efforts` 契约、机检 11 条 |
| `README.md` | `:95` `reflectReasoningEffort`、`:96` `autoReasoningDowngrade`（照现有表格格式，写清留空语义、必须显式传、非法档位丢弃+warn、四种不干预） |
| `TESTING.md` | `:18` 基线行 → 719/718/1skip、43 个测试文件；`:119-125` 第 50 轮小节（11 条逐条说明、config/wiring 只扩断言、前端 7 条归属、基线演进 690→719、机检四数） |
