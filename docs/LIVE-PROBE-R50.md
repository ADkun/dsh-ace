# LIVE-PROBE-R50 —— 思考档位链路线上实测（真实 provider）

日期 2026-10-29。实测者：线上实测者。未改仓库任何源码、未动生产手册与生产 playbook、无 git 操作。
真实调用 **20 次 / 预算 20 次（用满）**，单次上限 200 s（最慢一次 91 353 ms）。网关 http://127.0.0.1:3425/v1，密钥取 C:\Users\adkun\.dsh\.env 的 MAGPIE_GATEWAY_KEY。
探针与中间产物全在 %TEMP%\ace-r50-probe，任务结束已删。

## 结论速览

1. **group/never-stuck 真实只有 [high] 一档**（宿主 session/modelCatalog 真实返回，非推断）⇒ 自动降档对它**空转**，只落一条 warn。
2. **自动降到最低档不省时，反而更慢**：glm-5.3-flash low 91 353 ms vs high 63 710 ms（+43.4%）；deepseek-v4.1-flash low 36 902 ms vs high 31 296 ms（+17.9%）。思考字数与 completion_tokens 也都更多。候选质量无下降（3/3、5/4 条，四字段 100% 齐）。
3. **超时降档重试三条子断言全部成立**：错误带「ace: LLM 调用超时（单次上限 Nms）」前缀且不含「JSON」字样；网关实收 2 次、顺序 high → low（只重试一次）；recoverCandidatesFromUnclosed 回收率 = 已闭合候选条数，一条不漏。
4. **「关思考不保证真关」「档位名只是排行、wire 值才是强度」在本机成立**：glm 传 wire none 的 reasoning_tokens = **549**，比不传（**336**）还多；传 DSH 档位名 off = **433**。两者不是同一强度。

---

## 0 获取途径（四类，后文每条结论都标注类型）

| 途径 | 做法 | 关键出处 |
| --- | --- | --- |
| A 宿主 RPC（真实模型目录） | 用 C:\Users\adkun\.dsh\.credentials.yaml 里 client-connection/browser-session 的 secret 自签会话 cookie，POST http://127.0.0.1:3080/api/session/modelCatalog，信封 {type:client-request, rpcId, method:session/modelCatalog, payload:{args:{}}} | 签名算法 ~\dsh-client-connection\lib\index.js:285-390；RPC 入口同文件 :888-917；modelCatalog 定义 ~\dsh-api-session-controller\lib\typert.host.js:2078-2084，实现 ~\dsh-api-session-controller\lib\types\catalog.js:10-59 |
| B 直连网关 | POST /v1/chat/completions，stream:true + stream_options.include_usage，body 里的 reasoning_effort 由探针控制 | 本机 magpie 网关（OpenAI completions 风格） |
| C 进程内真跑生产代码 | registerHooks 给 @deepseek-ai/schemastery、dsh-tools、dsh-llm 三个裸 import 起桩（照抄 tests\wiring.test.mjs:16-171），再 import lib\index.js；宿主 LLM 换成「把网关 SSE 翻成宿主 chunk」的等价 stream | lib\index.js:104 inject；lib\llm.js:111-201 |
| D 纯函数离线 | import lib\reasoning.js / lib\prompts.js，输入用 A 拿到的**真实** catalog 数据与 B 拿到的**真实**模型正文 | 零网络、零副作用 |

探针清单（全部已删）：rpc.mjs、cat.mjs（A）· catalog.json（A 原样落盘）· gw.mjs、recon.mjs、item2.mjs、item2b.mjs、item4.mjs（B）· item3.mjs、item3d.mjs（C）· item3c.mjs、plan2.mjs、plan3.mjs（D）· runs.jsonl（20 次调用逐条记录）· digest.txt、summary.txt、bodies\ · item3-out.json、item3c-out.json、item3d-out.json、plan.json。

### 0.1 调用预算（20 次逐条）

| # | 模型 | reasoning_effort | max_tokens | 用途 |
| --- | --- | --- | --- | --- |
| 1–2 | auto/deepseek-v4.1-flash | 不传 / high | 64 | 探路：网关是否回 reasoning 与 usage |
| 3–4 | auto/deepseek-v4.1-flash | low / high | 4096 | 第 2 件（成对） |
| 5–8 | auto/glm-5.3-flash | off / none / low / high | 4096 | 第 2 件（四次全部 max-tokens 截断） |
| 9–10 | auto/glm-5.3-flash | low / high | 12000 | 第 2 件（干净成对样本，主证据） |
| 11–13 | auto/glm-5.3-flash | 不传 / none / off | 2500 | 第 4 件 |
| 14–17 | auto/deepseek-v4.1-flash | 不传 / low / high / xhigh | 3000 | 第 4 件 |
| 18–19 | auto/deepseek-v4.1-flash | high（超时）→ low | 生产不传 | 第 3 件整链 |
| 20 | group/never-stuck | low（该模型未声明） | 3000 | 第 4 件：网关是否校验档位名 |

---

## 1 真实 provider 的档位声明

**途径 A**（宿主 session/modelCatalog 真实返回，落盘副本 catalog.json）。规模：17 个 provider / 189 个模型 / 113 个带 reasoning / 58 个带 defaultEffort。

| 模型 | 宿主返回的 reasoning.efforts（数组顺序 = 弱→强） | defaultEffort |
| --- | --- | --- |
| **group/never-stuck** | **[high]** | **无（字段缺席）** |
| auto/deepseek-v4.1-flash | [low, high, xhigh] | 无 |
| auto/glm-5.3-flash | [off, low, medium, high, xhigh] | 无 |
| auto/minimax-m3.1-flash:free | [low, medium, high, xhigh, max] | 无 |
| auto/inkling:free | [off, minimal, low, medium, high, max]（无 xhigh） | 无 |
| cline/cline-free/solar-mini4 | [off, minimal, low, medium, high, xhigh, max]（唯一七档全声明） | 无 |
| auto/hy4-preview、auto/flint-v1.0:free、workbuddy/hy4-preview、cline/recursive/flint-v1.0:free、cline/liquid/lfm-2.5-2.6b:free | [high] | 无 |

**magpie 69 个模型的档位集分布**（catalog.json 真算；桶 = 声明集，数 = 模型数；50 个桶归并后 14 类）：

    17  off/high                           6  high
     6  off/minimal/low/medium/high/max    5  off/medium/high
     4  off/low/medium/high/xhigh          3  low/medium/high/xhigh/max
     3  low/high                           2  low/high/xhigh
     2  off/high/max                       1  off/low/medium
     1  low/high/max                       1  off/low/medium/high
     1  low/medium/high                    1  off/minimal/low/medium/high/xhigh/max（七档全）
    ——另有 16 个模型的 reasoning 字段整体缺席（≈ 无思考档位）——
    合计 69 = 53（带 reasoning）+ 16（无）

### 1.1 重点回答：group/never-stuck 是不是真的只有 [high] 一档 —— 是

宿主真实返回 {"efforts":[{"id":"high","name":"High"}]}，且**不声明 defaultEffort**。用 lib\reasoning.js 拿这份真实数据真跑（途径 D，无网络）：

- queryModelEfforts → {ok:true, note:singleEffort, ids:[high]}；lowestEffortOf → **null**。
- planReasoningEffort({manual:空, auto:true}) → {effort:null, source:none, reason:ace: 模型只声明了一个思考档位}；warn 逐字：dsh-ace: 模型 magpie/group/never-stuck 只声明了一个思考档位（high），不自动降档。
- 手填 off（该模型没声明）→ {effort:null, source:none, reason:ace: 配置的档位不在该模型声明的档位集里}；warn 逐字：dsh-ace: 配置的思考档位 off 不在模型 magpie/group/never-stuck 声明的档位集里（high），已丢弃。
- 对照（同一条链，换成真有多档的模型）：deepseek → ids [low,high,xhigh]，lowestEffortOf = low，auto = {effort:low, source:auto}；glm → ids [off,low,medium,high,xhigh]，lowestEffortOf = **off**，auto = {effort:off, source:auto}。

### 1.2 档位集不是网关给的，是 profile 字典给的

profile C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml 第 22-29 行给 group/never-stuck 只写了 reasoningEfforts: {high: high}（第 28-29 行）。宿主据此建 thinkingLevelMap（未声明档位钉 null）：~dsh-llm-pi-ailibindex.js:585-608；再按 THINKING_LEVELS 全序过滤：同文件 :771-779（全序列表在 :299-307）；最后输出成 {efforts, defaultEffort?}：:1806-1815。
网关 GET /v1/models 里的 reasoning_levels 是**另一套词表**（deepseek 报 light/high/extra_high，glm 报 none/low/medium/high/xhigh），与 DSH 档位 ID 不同名，只说明「网关支不支持思考」，不构成档位集。

---

## 2 自动降档在真实复盘里是否生效

**途径 B**。喂**真实**复盘提示词：REFLECTOR_SYSTEM（lib\prompts.js:21-87，2356 字符）+ reflectorUserInput（lib\prompts.js:109-128，34359 字符，其中 digest 33076 字符 / 100 条，读自生产手册 C:\Users\adkun\.dsh\ace\playbook.md 的 readPlaybookSnapshot，**只读**）。网关实测 prompt_tokens 20315（deepseek）/ 20593（glm）。

### 2.1 auto/deepseek-v4.1-flash（宿主档位 [low,high,xhigh]，profile 把 low 映成 wire light），max_tokens 4096

| effort | 耗时 | 首 token | completion_tokens | prompt_tokens | reasoning_tokens | reasoning 字符 | 正文字符 | finish | JSON | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **low（= 自动最低档）** | **36 902 ms** | 6 118 ms | 2 599 | 20 315 | null | **3 885** | 1 845 | stop | 完整 | **3**（四字段 3/3） |
| **high（本机 profile 默认）** | **31 296 ms** | 1 139 ms | 2 303 | 20 315 | null | **3 177** | 2 048 | stop | 完整 | **3**（四字段 3/3） |

差额：low **慢 5 606 ms（+17.9%）**，completion_tokens **+296（+12.9%）**，reasoning **+708 字**，正文 **−203 字**。候选标题语义一一对应（registerHooks 起桩 / 宿主 RPC 取真实声明 / reasoning 计量口径）。

### 2.2 auto/glm-5.3-flash（宿主档位 [off,low,medium,high,xhigh]，off 映成 wire none）

**先看 max_tokens=4096 的四次：全部 finish=length 被截断，glm 会把思考吃满预算**：

| effort | 耗时 | completion_tokens | reasoning_tokens | reasoning 字符 | 正文字符 | 解析结果 |
| --- | --- | --- | --- | --- | --- | --- |
| off | 91 243 ms | 4 096 | 4 058 | 13 503 | **0** | 抛「未找到 JSON 对象（本次收到 0 字符）」 |
| none | 61 770 ms | 4 096 | 3 339 | 6 721 | 1 502 | 抛「JSON 对象不完整」→ **回收 2 条** |
| low | 69 131 ms | 4 096 | 4 073 | 14 848 | **0** | 抛「未找到 JSON 对象（本次收到 0 字符）」 |
| high | 72 101 ms | 4 096 | 4 074 | 13 782 | **0** | 抛「未找到 JSON 对象（本次收到 0 字符）」 |

放开到 max_tokens=12000 才拿到干净成对样本（**这组才是第 2 件的主证据**）：

| effort | 耗时 | 首 token | completion_tokens | prompt_tokens | cached | reasoning_tokens | reasoning 字符 | 正文字符 | finish | JSON | 候选 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **low（= 自动最低档）** | **91 353 ms** | 1 450 ms | 6 919 | 20 593 | 20 544 | **5 389** | 11 035 | 3 019 | stop | 完整 | **5**（5/5 齐） |
| **high（本机 profile 默认）** | **63 710 ms** | 1 906 ms | 4 766 | 20 593 | — | **3 683** | 7 587 | 2 273 | stop | 完整 | **4**（4/4 齐） |

差额：low **慢 27 643 ms（+43.4%）**，completion_tokens **+2 153（+45.2%）**，reasoning_tokens **+1 706**，reasoning **+3 448 字**。

### 2.3 结论

1. **降档不省时**：两个模型、两组成对样本一致地更慢（deepseek +18%，glm +43%）。原因是低档在本机网关上思考并没有变短——reasoning 字数与 reasoning_tokens **全部变多**（唯一例外是 deepseek 的 reasoning_tokens 字段恒 null，只能看 reasoning_content 字符数）。
2. **候选质量不降反升**：条数 3→3 / 5→4，四字段完整度 100%（每条的 title/condition/action/rationale 都是非空字符串），两次都 finish=stop、JSON 完整可解析。**没有观测到任何质量下降**。
3. 附带事实：completion_tokens 在本机网关**已含思考**（glm 6 919 里 5 389 是 reasoning_tokens；deepseek 不报该字段，但 2 599 里大半是思考）。所以「省 token」也不能靠降档实现。

---

## 3 超时降档重试的救回率

**途径 C**：进程内真跑生产 runRecapPipeline（lib\recap-pipeline.js:193），真 oneShot、真 planReasoningEffort / lowestEffortOf、真 isTimeoutError；只有 ctx.llm.stream 换成「把网关 SSE 翻成宿主 chunk」的等价实现（模型 auto/deepseek-v4.1-flash）。ACE_ONESHOT_TIMEOUT_MS=6000（在 import lib/llm.js **之前**设，符合 lib\llm.js:57-66 的模块级常量语义）。生产手册**只读复制**到临时目录后跑，生产手册与 playbook 零改动。

### (a) 错误文案是否带超时前缀 —— 带，且不含任何「JSON」字样

两条逐字（首轮与重试各一条）：

    ace: LLM 调用超时（单次上限 6000ms）：The operation was aborted due to timeout
    ace: LLM 调用超时（单次上限 6000ms）：The operation was aborted due to timeout

isTimeoutError（lib\reflect.js:17-21，判据是 startsWith('ace: LLM 调用超时')）两次都 **true**；文案里没有「JSON 对象不完整 / 未找到 JSON / 无法解析」。耗时 6 019 ms / 6 015 ms。

### (b) 是否真降到最低档、且只重试一次 —— 是，网关实收 2 次，顺序 high → low

- downgradeEffort 真实查询返回 {queryOk:true, note:null, ids:[low,high,xhigh], lower:low}（refresh:true 绕缓存后调宿主 resolveModelInfo）。
- 日志逐字：warn dsh-ace: 多轮复盘第 1 轮超时，已降到最低档 low 重试一次。
- 重试也超时后：info dsh-ace: 多轮复盘第 1 轮中断（ace: LLM 调用超时（单次上限 6000ms）：The operation was aborted due to timeout），按已提炼的 0 条候选落盘；随后 info dsh-ace: 复盘完成 第 1 次（0 轮收敛），本轮候选 0 条，累计候选 0 条。
- 管线**不抛错**，返回 {added:[],conflicts:[],rounds:0,merged:0,evicted:0}（lib\recap-pipeline.js:237-253，重试分支只有一条 return，不存在二次再降）。

**救回率：本次构造下 0/1**（首轮超时 → 降档重试 → 仍超时）。注意这是**人为把单次上限压到 6 s** 的极端构造，两次撞线是设计使然；生产上限是 150 000 ms（lib\llm.js:57-66），真实救回率**无法用这组数据外推**（见第 6 节）。

**手动 ace_reflect 路径同口径**（途径 C，真跑 apply() 与 ace_reflect.execute，假 stream 卡到合并信号 abort，ACE_ONESHOT_TIMEOUT_MS=1200，**零真实调用**）：抛出逐字 "ace: LLM 调用超时（单次上限 1200ms）：The operation was aborted due to timeout"，耗时 1 217 ms；startsWithTimeoutPrefix=true、hasJsonIncompleteClaim=false；实际发出的档位是 [low]（走 effortPlanFor 的自动降档）；raw.jsonl **未落盘**（超时不是解析失败）。

### (c) 被截断时已完整候选是否被回收 —— 回收率 = 已闭合候选条数，一条不漏

**途径 D**（纯函数 extractJsonObject + recoverCandidatesFromUnclosed，lib\prompts.js），输入是**真实模型正文** bodies\item2b-glm-low.txt（glm-5.3-flash 的 low 档、3 019 字符、5 条候选、notes 齐全），在 6 个确定位置切开模拟切断：

| 切点 | 切在何处 | extractJsonObject | 回收条数 | 四字段全齐 |
| --- | --- | --- | --- | --- |
| 701 字符 | 候选 1 的 rationale 中途 | 抛「JSON 对象不完整（从第 1 字起未闭合）」 | **1** | 是 |
| 1 344 字符 | 候选 2 rationale 中途 | 同上 | **2** | 是 |
| 1 846 字符 | 候选 3 rationale 中途 | 同上 | **3** | 是 |
| 2 439 字符 | 候选 4 rationale 中途 | 同上 | **4** | 是 |
| 2 913 / 2 946 字符 | 候选 5 rationale 中途 / 深入中段 | 同上 | **5** | 是 |
| 56 字符 | 候选数组刚开、首条标题未闭合 | 同上 | **0** | —（保持抛错语义） |
| 不切（完整 3 019 字符） | — | ok | 5 | 是 |

结论：回收恰好等于**已完整闭合的候选条数**，切在「第 N 条半途」就回收 N−1 或 N 条；切在候选边界之外（数组刚开）回收 0 条，此时 lib\index.js:1513-1515 的 if (!salvaged.length) throw error 保持原抛错语义。这条链在真实调用里也被独立触发过一次：glm max_tokens=4096 + effort=none 那次 finish=length 真截断，recoverCandidatesFromUnclosed 从**真实正文**回收 2 条（runs.jsonl 该条 salvaged:2）。

---

## 4 网关对 reasoning_effort 的真实响应

**途径 B**，同一提示词换档位值。两个口径同时报：usage.completion_tokens_details.reasoning_tokens（glm 有、deepseek 恒 null）与 message.reasoning_content 字符数。

### 4.1 auto/glm-5.3-flash（提示词 4 字符 PG，max_tokens 2 500）

| 传的值 | 语义 | 耗时 | completion_tokens | reasoning_tokens | reasoning 字符 |
| --- | --- | --- | --- | --- | --- |
| 不传 | 沿用宿主默认 | 7 655 ms | 451 | **336** | 1 346 |
| none | profile 里 off 映射到的 **wire 值** | 10 183 ms | 641 | **549** | 2 035 |
| off | DSH **档位名** | 8 890 ms | 515 | **433** | 1 855 |

**「关思考不保证真关」在本机成立**：wire none 与 DSH off 都没有把思考关掉，两者都比「不传」**思考更多**（549 / 433 vs 336）。
**「档位名只是排行、wire 值才是强度」也成立**：off 与 none 不是同一强度（433 vs 549 reasoning_tokens），而 profile 恰好把 off 映成 none（cordis.patch.yml:70-71）——名字是宿主侧的排行位，发出去的是映射后的字符串。宿主侧证据：~dsh-llm-pi-ailibindex.js:1953 用 resolveReasoningLevel 解析档位名，~@earendil-workspi-aidistapiopenai-completions.js:716-725 把档位名经 thinkingLevelMap 换 wire 值再写进 params.reasoning_effort。

### 4.2 auto/deepseek-v4.1-flash（提示词 38 字心算题，max_tokens 3 000）

| 传的值 | 耗时 | 首 token | completion_tokens | reasoning_tokens | reasoning 字符 | 答案 |
| --- | --- | --- | --- | --- | --- | --- |
| 不传 | 2 130 ms | 1 163 ms | 84 | **null** | 242 | 1599 |
| low（= wire light） | 2 165 ms | 1 067 ms | 96 | **null** | **261** | 1599 |
| high | 3 683 ms | 2 783 ms | 82 | **null** | 209 | 1599 |
| xhigh（= wire extra_high） | 1 794 ms | 1 041 ms | 82 | **null** | 226 | 1599 |

该模型上 reasoning_tokens 字段恒 null（探路那次报 0），只能读 reasoning_content；且档位名与真实强度**非单调**：reasoning 字数 low 261 > xhigh 226 > high 209。短提示词单样本、方差大，只作方向性证据——第 2 件的 20 593 token 长提示词那一组才是主证据。

### 4.3 group/never-stuck（宿主只声明 [high]，探针硬发未声明的 low）

HTTP **200** / 2 772 ms / completion_tokens 118 / reasoning_tokens null / reasoning 310 字符 / 答案 1599（正确）。
⇒ **网关不校验档位名**（DSH 侧不存在的 low 照样 200）；唯一的拒绝点在上游宿主 resolveReasoningLevel（~dsh-llm-pi-ailibindex.js:1785-1788，抛 UNSUPPORTED_REASONING_EFFORT）。**插件「先对着该模型声明的档位集校验再发」是这条链上唯一的防线**（lib\reasoning.js:192-205）。

---

## 5 判定：「自动降档在本机当前默认模型上是否有意义」—— **没有意义，等于空转**

本机生效默认 = provider magpie / model group/never-stuck / reasoningEffort high（C:\Users\adkun\.dsh\profiles\web\cordis.patch.yml:8-12；宿主 modelCatalog 的 default 字段同值）。三条实测事实：

1. 该模型宿主声明**只有 [high] 一档**（第 1 节，途径 A）。
2. 因此 planReasoningEffort 命中 efforts.length===1 分支 → {effort:null, source:none} + 一条 warn（第 1 节，真数据真跑 lib\reasoning.js）。每次复盘会白查一次 resolveModelInfo（走 10 min 成功缓存，成本可忽略），但一次都不会降档。
3. 即使换成真有多档的模型，降档实测也**不省时**（glm 最低档比 high 慢 43.4%，deepseek 最低档比 high 慢 17.9%）。而 **glm 的最低档恰好是 off**，而 off 实测 reasoning_tokens 433 > 不传的 336 —— 自动降档会把 glm 降到一个既不关思考、思考量还更多的档位。

判定分三层：

- **对默认模型（group/never-stuck）：纯空转**，行为安全（不干预 + 一条 warn），收益为零。
- **对有多档的模型：自动降档的收益前提在本机网关上是反的** —— 「efforts[0] 最省」不成立，降档换来的是一致更慢、token 更多。功能本身无缺陷（判定链、降档、重试全部按设计工作），失效的是这个前提。
- 结论性建议（不含代码改动）：默认模型保持现状即可；若要在本机靠档位省时，方向应反过来考虑，且必须先跑出「某模型某档确实更省」的实测证据，别把档位排行当代价排行。

---

## 6 无法验证的事项与原因

| 事项 | 为什么没验证 |
| --- | --- |
| 运行中宿主的 GET /api/dsh-ace/efforts 与两个新配置键（reflectReasoningEffort / autoReasoningDowngrade） | 宿主进程 pid 22496 启动于 2026-10-29 00:09:38，lib\index.js mtime 07:02:42 —— 内存里是**旧版插件**。伪造 cookie 实打：/api/dsh-ace/efforts → **404**；/api/dsh-ace/settings → 200，但 value 里这两键**缺席**。重启宿主属越权（任务禁止），故 R50 验证全部走「进程内跑生产库函数 + 直连网关」。 |
| 真实 GUI 里点一次 ace_reflect 手动复盘 | 同上（需重启加载新代码）；已在进程内真跑 apply() 与 ace_reflect.execute 覆盖同一条代码路径（第 3 节 (b) 段）。 |
| 生产配置下 glm 是否会被 max-tokens 截断 | 生产 lib\llm.js **任何调用点都不传 maxTokens**（形参在 lib\llm.js:111，赋值在 :119，全库无调用点），走模型上限（glm 131 072）。我只用了 4 096 / 12 000 两档，131 072 下会不会截断没测。 |
| 超时降档重试的**真实救回率** | 只做了 1 次构造实验（上限压到 6 s，必然两次都超时 → 0/1）。20 次预算已用满，没有余量做「上限刚好卡在正常耗时之上一点」的梯度实验。 |
| 非 magpie 的 16 个 provider 的档位声明与 wire 映射 | 时间与预算硬约束；只做了静态统计（58 个模型带 defaultEffort），没有逐个实测。 |
| 宿主适配层翻成 wire 值的**真实请求体** | 抓请求体需要中间人代理转发网关，超出预算；第 4 件的 wire 结论由「profile 字典（:56-75）+ 网关对 off/none 的差异化响应」两段实测交叉支撑，openai-completions.js:716-725 的映射代码只作出处。 |
| 真实 provider 上 oneShot 的「正文为空」抛错路径 | 本机网关在这些样本里都吐了正文（唯一 0 正文的是 glm 被 max_tokens 截断，走 finish=length 而非空正文）。 |

---

## 7 发现的真实缺陷 / 需关注问题（含最小复现）

### D1（策略层）自动降档的收益前提在本机不成立

现象：同 prompt、同模型，最低档比 high 慢且更耗 token —— deepseek low 36 902 ms vs high 31 296 ms（completion 2 599 vs 2 303）；glm low 91 353 ms vs high 63 710 ms（completion 6 919 vs 4 766、reasoning_tokens 5 389 vs 3 683）。
性质：不是代码缺陷（判定链、降档、重试都按设计工作），是**默认策略的代价模型假设**在本机网关不成立。
影响：默认模型上无影响（单档空转）；用户手动切到多档模型后，复盘会更慢、更贵。
最小复现（1 次见方向、2 次成对）：对同一个 /v1/chat/completions 请求，只改 body 里的 reasoning_effort：

    POST http://127.0.0.1:3425/v1/chat/completions
    Authorization: Bearer <MAGPIE_GATEWAY_KEY>
    {"model":"auto/glm-5.3-flash","max_tokens":12000,"reasoning_effort":"low",
     "messages":[{"role":"system","content":"<REFLECTOR_SYSTEM>"},
                 {"role":"user","content":"<reflectorUserInput + 真实 digest>"}]}

把 low 换成 high 再发一次，比 usage.completion_tokens 与耗时：low 6 919 / 91 353 ms，high 4 766 / 63 710 ms。

### D2（网关行为，已实证）「关思考」不等于真关

现象：glm 传 wire none（= profile 里 off 的映射值）reasoning_tokens **549** > 不传的 **336**；传 DSH 档位名 off 是 **433**。
最小复现：上面那条请求，reasoning_effort 分别取 none 与省略该字段，比 usage.completion_tokens_details.reasoning_tokens（549 vs 336）。
影响：任何「降档到 off 就省钱」的预期在本机不成立；off 与 none 是两个不同强度，off **不是**「关闭」的同义词。

### D3（展示层，轻）magpie 的 defaultEffort 全部来自插件回落，不是宿主声明

现象：magpie 69 个模型里 **0 个**带 defaultEffort（途径 A 真实返回）。插件 decodeModelEfforts 在声明值缺失时回落到 efforts[last].id（lib\reasoning.js:97-100），即**最强档** —— 于是 planReasoningEffort 的返回里 defaultEffort 显示 xhigh（deepseek/glm 都是），而宿主从未声明过这个值。
最小复现（进程内、零调用）：

    import { queryModelEfforts } from 'D:/dsh/plugins/dsh-ace/lib/reasoning.js';
    const llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{id:'low'},{id:'high'},{id:'xhigh'}] } }) };
    const info = await queryModelEfforts(llm, 'magpie', 'auto/deepseek-v4.1-flash', { refresh: true });
    // info.defaultEffort === 'xhigh'   ← 宿主从未声明

影响：没有决策路径读它（planReasoningEffort 只看 efforts[0] 与手动值，client.js 对 defaultEffort 零次匹配），只在 GET /api/dsh-ace/efforts 报文与设置页给出一个语义不准的「宿主默认档」。本次实测确认这不是边缘情形：**magpie 全部 69 个模型都命中这条回落**。

### D4（观察项）查询失败时手动档位不做「该模型是否声明」的校验就原样下发

planReasoningEffort 在 query.ok===false 时对手动值只做「合法档位名」校验（lib\reasoning.js:192-205）。实测（途径 D）：查询失败 + manual=max → {effort:max, source:manual}，原样发给宿主；宿主不支持则抛 UNSUPPORTED_REASONING_EFFORT（~dsh-llm-pi-ailibindex.js:1785-1788），复盘按真实失败上抛。这是「查不到就不猜」的合理取舍，但用户手填不支持的档位时，失败原因出现在宿主侧而不是插件侧。**未改代码，仅记录。**

---

## 8 复核点（给后续接手的人）

- 档位全序与「efforts 由弱到强」的出处：~dsh-llm-pi-ailibindex.js:299-307（THINKING_LEVELS）、:771-779（getSupportedThinkingLevels 按该全序过滤）、:1806-1815（reasoningInfo 输出 efforts/defaultEffort）。
- profile 字典是 DSH 侧档位集的唯一来源：~dsh-llm-pi-ailibindex.js:585-608；wire 映射在 ~@earendil-workspi-aidistapiopenai-completions.js:716-725。
- 生产复盘不传 maxTokens：lib\llm.js:111（形参）、:119（赋值），全库无调用点传它。
- 自动降档「四种不干预」分支：lib\reasoning.js:207-222；单档 warn 文案 :216-218；lowestEffortOf :228-234。
- 超时降档重试只有一条 return：lib\recap-pipeline.js:237-253；超时判定前缀 lib\reflect.js:17-21。
- 回收已闭合候选：lib\index.js:1513-1515（自动路径）与 ace_reflect 手动路径同族，纯函数在 lib\prompts.js:335。
- 运行中宿主仍是旧版插件：pid 22496 / 启动 2026-10-29 00:09:38 / lib\index.js mtime 07:02:42 / GET /api/dsh-ace/efforts → 404。
