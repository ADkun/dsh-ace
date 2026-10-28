# dsh-ace 第 48 轮施工报告

施工轮次：第 48 轮（健壮性三缺口 B1 / 洞1 / B2 + 五轮返工 Gap 1–5 / S1·S2·S3·S5·S7 / T1 / F1–F5 / G1·G2） | 仓库：D:\dsh\plugins\dsh-ace | 基线：第 47 轮 `node --test tests/` = 648 tests / 647 pass / 0 fail / 1 skip | 结果：**685 / 684 / 0 / 1 skip，EXIT 0**

> 用户原话（事故现场）：「ACE 自动复盘未完成：复盘失败（ace: LLM 输出中未找到 JSON 对象）。本次沉淀的经验没有并入手册，可重试。」
> 这条通知只说了「没找到 JSON」，现场（模型到底吐了什么、走的是哪条通道、耗时多久、哪家模型）一个字节都没留下。本轮做三件事：把「空正文」变成一条说得清的错误（B1）、把解析器放宽并让报错带现场（洞1）、把失败现场落盘（B2）。之后五轮返工修的是这三件事自己带出来的新问题：返工 1 = Gap 1–5、返工 2 = S1/S2/S3/S5/S7、返工 3 = T1、返工 4 = 终验报告在规格外挖出的 F1–F5、返工 5 = 终验回执留下的两条低危 G1/G2（都还是「静默就算成功」与「现场丢失」这两类）。

---

## 任务 0：根因（先量化，后动手）

线上那次复盘的耗时是 **72 秒（单次上限 75000ms）**，说明是对方正常结束、不是超时。追到 `lib/llm.js` 的 `oneShot`：旧的 for-await 循环**只累加 `type === 'text-delta'` 的块**，模型那一趟把内容全写进了 reasoning 通道，`out` 一直是空串 —— 空串交给 `extractJsonObject`，`indexOf('{')` 返回 −1 就抛「未找到 JSON 对象」。

两处结构性缺陷：

1. **解析器过窄**：只认第一个 `{`、不认顶层数组、报错不带任何现场信息；
2. **失败现场被整个丢弃**：reasoning 字符数、耗时、原始返回全文都没有任何记录，只能靠源码考古去推断。

---

## B1：空正文变成一条说得清的错误（lib/llm.js:103-129）

**改前**：循环里只有 `if (chunk.type === 'text-delta' ...) out += chunk.text;`，循环外直接 `return out.trim();` —— 空串原样交给上层。

**改后**（`lib/llm.js:103-129`）：

```js
let reasoning = 0;                       // :104
const startedAt = Date.now();            // :105
for await (const chunk of ctx.llm.stream(options)) {           // :107
  if (!chunk) continue;                                        // :108
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { out += chunk.text; continue; }  // :109
  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text.length; // :111
}
const text = out.trim();                 // :121
if (!text) {                             // :122
  throw new Error('ace: LLM 本次正文为空（reasoning ' + reasoning + ' 字符、耗时 '       // :126
    + (Date.now() - startedAt) + 'ms、' + provider + '/' + model + '）');               // :127
}
return text;                             // :129
```

- **是普通错误，不是超时**：文案里没有「调用超时」四个字，所以 `lib/reflect.js:17` 的 `isTimeoutError` 认不出来 —— 这一轮按「真实失败」处理（该提示就提示、该记失败就记失败），不会被当成「超时豁免」静默收尾。超时豁免逻辑本身一行未改。
- **原有 try/catch 与 callSignal 处理原样保留**（`:113-120`）：本地超时分支 `'ace: LLM 调用超时（单次上限 ' + capMs + 'ms）'` 的文案与行为一个字没动。
- 文件头注释同步改（`:34-40`），不再说「只收 text-delta」。

**用例**（tests/llm-budget.test.mjs）：`:74` 只有 reasoning-delta → 抛「正文为空」且带 reasoning 字符数与耗时；`:105` 该错**不被** `isTimeoutError` 认成超时；`:118` 正常流（text-delta 照常累加、reasoning 不混进返回值）。

---

## 洞1：extractJsonObject 容错 + 报错带现场（lib/prompts.js:135-299）

**改前**：`indexOf('{')` → 找不到就抛「未找到 JSON 对象」（无现场）；找到就 `JSON.parse` 从 `{` 到最后一个 `}` 的整段（顶层数组完全不认）。

**改后**是四层结构：

| 部件 | 行号 | 作用 |
| --- | --- | --- |
| `scanJson(src, start, open, close)` | `:135-152` | 括号配对 + 字符串状态机（`inStr`/`esc`），配平那一格 `return JSON.parse(...)`，走到末尾仍未配平 `return undefined` |
| `scanRange(src, start, open, close)` | `:161-168` | 三态包装：`{kind:'truncated'}` / `{kind:'value', value}` / `{kind:'noise'}`。**把「没配平」和「配平但非法」分开**是后面 Gap 1 与 S1 能落地的前提 |
| `isCandidateArray(arr)` / `isEmptyArray(arr)` | `:183-186` / `:189-191` | 候选数组判据；空数组单独拎出来（S3 的弱候选） |
| `JSON_TEXT_CHARS` / `hasForeignCharBetween(src, from, to)` | `:194-195` / `:222-244` | `arrAt → objAt` 这一段里有没有外来字符 —— 用来把「数组结构内部被截断」与「散文之后的对象」分开（S1；T1 重写，见「返工 3」） |
| `extractJsonObject(text)` | `:264-299` | 主流程 |

主流程的行为（`:264-299`）：

```js
const src = String(text ?? '');
const objAt = src.indexOf('{');
const arrAt = src.indexOf('[');
const arrayFirst = arrAt !== -1 && (objAt === -1 || arrAt < objAt);
let emptyArray = false;
if (arrayFirst) {
  const scanned = scanRange(src, arrAt, '[', ']');
  if (scanned.kind === 'truncated') {
    const foreign = objAt === -1 ? false : hasForeignCharBetween(src, arrAt, objAt);  // :288
    if (!foreign) {
      throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (arrAt + 1) + ' 字起未闭合）');
    }
  } else if (scanned.kind === 'value') {
    if (isCandidateArray(scanned.value)) return { candidates: scanned.value };   // :281
    if (isEmptyArray(scanned.value)) emptyArray = true;                          // :283
  }
}
if (objAt !== -1) {
  const v = scanJson(src, objAt, '{', '}');                       // :301
  if (v === undefined) throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (objAt + 1) + ' 字起未闭合）');
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;  // :303 原样返回，不包壳
}
if (!arrayFirst && arrAt !== -1) { /* 再试一次数组，只认候选数组 */ }   // :305-308
if (emptyArray) return { candidates: [] };                        // :309 弱候选最后才用
throw new Error('ace: LLM 输出中未找到 JSON 对象（本次收到 ' + src.length + ' 字符，开头：'
  + JSON.stringify(src.slice(0, 60)) + '）');                     // :310-311
```

**既有成功路径的返回形状没变**：正常对象文本仍**原样返回解析出的对象、不包壳**（`:303`）。验证方式是这样三条既有用例全绿且**一行未改**：tests/prompts.test.mjs `:94`（`'{"pairs":[]}'` 必须原样返回）、`:102`（顶层数组才包成 `{candidates}`）、tests/merge.test.mjs `:196`（`parseMergeResult` 六种形状的判定口径）。另加一条独立的端到端线索：`parseMergeResult` 全部既有用例（tests/merge.test.mjs `:196/:212/:262`）在本轮后仍全绿 —— 它吃的正是 `extractJsonObject` 的返回值。

**中文报错前缀保留**：`'ace: LLM 输出中未找到 JSON 对象'` 与 `'ace: LLM 输出中的 JSON 对象不完整'` 仍是两条错误消息的前缀（grep 与既有断言都靠它们）。

---

## B2：失败现场落盘（lib/raw-log.js，135 行；两处接线）

**新模块 `lib/raw-log.js`**（只 import `node:fs` / `node:os` / `node:path`，零宿主包、零插件内 import）：

| 部件 | 行号 | 作用 |
| --- | --- | --- |
| `RAW_LOG_LIMIT = 20` / `RAW_SNIPPET_MAX = 4000` | `:22` / `:24` | 保留最近 20 条；单条原文只留前 4000 字符 |
| `rawLogDisabled(env)` | `:27` | 杀开关：`ACE_RAW_LOG` 为 `0`/`off`（不区分大小写）时**完全不写、连目录都不建** |
| `resolveRawLogFile(env = process.env)` | `:33` | `<DSH_HOME>/ace/debug/raw.jsonl`，`DSH_HOME` 缺省 `~/.dsh`；**每次调用现读 env** |
| `buildRecord(input)` | `:` 内部 | `{ at, stage, round?, provider?, model?, rawLength, raw, error }`；`rawLength` 记全文长度、`raw` 只留前 4000 |
| `dumpRaw(input)` | `:86` | async、**永不 reject**（内部全 catch）、写盘经 `writeChain` 串行化、超 20 条丢掉最旧那批重写 |
| `flushRawLog()` | `:118` | `await writeChain`，让「process 正常收尾前这条一定落盘」有确定答案；永不 reject |

**接线一：reflect 失败（lib/index.js:1389-1395）**

```js
let parsed;
try {
  parsed = extractJsonObject(raw);
} catch (error) {
  await dumpRaw({ stage: 'reflect', round, provider: route.provider, model: route.model, raw, error });
  throw error;                       // 原样上抛：复盘照旧失败，只是现场留下来了
}
```

**接线二：merge 解析失败（lib/merge-llm.js:132-150）**

```js
export function parseMergeResult(raw, meta) {
  let obj;
  try {
    obj = extractJsonObject(raw);
  } catch (error) {
    void dumpRaw({ stage: 'merge', provider: meta && meta.provider, model: meta && meta.model, raw, error });
    return null;                    // 原有的「形状不合格 → null，绝不抛错」语义一个字没变
  }
  ...
```

- `parseMergeResult` 是**同步导出**（生产与测试都按同步返回值用），所以这里**不 await**；`dumpRaw` 保证不 reject，fire-and-forget 不会变成未处理拒绝。要它落定就用 `flushRawLog()` —— 合并阶段收尾处**显式 await 一次**（见下）。
- `meta` 是新增的可选第二参，**只用于把现场写得更可查**，不参与任何判定。路由从 `lib/index.js:1469-1472` 的 `mergeRoute` 取：`lib/recap-pipeline.js:156-161` 在调 `planMerges` 之前取一次，经 `:170-171` 透传进 `planMerges`（`lib/merge-llm.js:239-240`），再进 `:276` 的 `parseMergeResult(raw, { provider, model })`。全程只是读路由、不发请求、不缓存、在锁外。
- **落盘确定性**：`lib/recap-pipeline.js:176-180` 的 `tryMerge` 在 `finally` 里 `await flushRawLog()` —— 合并阶段一收尾，那条 fire-and-forget 的现场就一定在盘上。

**红线 2 自查**：两个调用点都在 `withExclusiveLock` 之外（reflect 在 `lib/index.js` 的 Reflector 回调里、merge 在 `tryMerge` 里，`withExclusiveLock` 只在落盘与 inbox 那两处），锁区间内没有任何新增 IO。

---

## 返工 1：Gap 1–5

| Gap | 问题 | 修法与位置 | 用例 |
| --- | --- | --- | --- |
| 1 | `[{"title":"a"},{"title":"b"}`（缺右括号）本该报「不完整」，旧实现却回落到数组里第一个 `{` 解析成功 —— 把截断伪装成成功 | `lib/prompts.js:272-278`：数组先出现且扫描为 `truncated` 时**当场抛**，不回落到数组内部的 `{` | tests/prompts.test.mjs `:161` |
| 2 | `参考 [1,2] 然后 {"candidates":[{"title":"real"}]}`、`[1,2] {"title":"real"}` 里的真结果被 `{candidates:[1,2]}` 顶掉 | `lib/prompts.js:183-186`：`isCandidateArray` 要求**至少一个非 null 普通对象**，全标量的数组算噪声 → 回落对象路径 | tests/prompts.test.mjs `:173` |
| 3 | 触达 `dumpRaw` 的测试把夹具写进了用户真实 `C:\Users\adkun\.dsh\ace\debug\raw.jsonl` | tests/merge.test.mjs `:29-45`、tests/recap-pipeline.test.mjs `:27-42` 把 `process.env.DSH_HOME` 指到 `os.tmpdir()` 临时目录，`after()` 里还原并删目录；各带一条守护用例 | tests/merge.test.mjs `:442`、tests/recap-pipeline.test.mjs `:402` |
| 4 | `merge` 现场是 fire-and-forget，最易丢；且 merge 行缺 provider/model | `lib/recap-pipeline.js:176-180` 收尾 `await flushRawLog()`；`lib/index.js:1469-1472` 新增 `mergeRoute`，经 `recap-pipeline.js:156-171` → `merge-llm.js:239-240/276` 透传进现场 | tests/recap-pipeline.test.mjs `:352`、`:381`；tests/merge.test.mjs `:462` |
| 5 | AGENTS.md 红线 20 的验收基线停在上一轮 | `AGENTS.md:88` 补本轮实测基线、24 条新增用例分布、DSH_HOME 隔离纪律，并指向本文件 | 文档，无用例 |

**关于 Gap 4 选哪条路（写明理由）**：`parseMergeResult` 的同步契约**不改**（生产调用点 `lib/merge-llm.js:276` 与全部既有用例都按同步返回值用），所以选「调用链 async 侧在收尾 await `flushRawLog()`」。`lib/index.js` 的 `executeRecap` 不再另加 `try/finally`：reflect 路径的 `dumpRaw` 本来就是 `await`（自身落盘），merge 路径已由 `tryMerge` 收尾覆盖，再包一层只是重复。

---

## 返工 2：S1 / S2 / S3 / S5 / S7

**S1（`lib/prompts.js:222-244` + `:288-291`，第四轮 T1 起判据重写）**：Gap 1 的修法过宽 —— 只要「`[` 先出现」且扫不通就抛未闭合，于是散文里一个开了没关的方括号（`参考 [1,2`、`提示 [见下`、甚至引号里写的 `"["`）都会让本轮复盘整批失败，而真结果就在后面的对象里（改动前这三类都能拿到对象，属于回归）。修法是加一层「这段方括号像不像 JSON」的判定：按同一个字符串状态机扫，**在字符串之外**遇到一个不可能出现在 JSON 文本里的字符就判散文（继续走对象路径）；只有 JSON 语汇字符、只是没配平，才判截断并抛。真截断 `[{"title":"a"},{"title":"b"}` 与 `前言 [{"title":"a"},{"title":"b"}` 仍照旧抛。第四轮把这一层从 `looksLikeJsonPrefix` 重写成 `hasForeignCharBetween`，判据范围见下面「返工 3」。

**残留局限（如实写进 `:206-220` 的注释，不声称已消除）**：方括号之后恰好只有 JSON 语汇字符、实际却仍是散文前缀（例如后面只跟着 `true`/`false`/`null` 这类字母与数字）时，仍会被判成截断并报未闭合 —— 这种文本与真截断在离线状态下同形，无法区分。

**S2（`lib/prompts.js:302`）**：两条路径的「第几字」基数不一致（数组 `arrAt + 1` 是 1-based、对象 `objAt` 是 0-based，`前言 {"a":1` 会说「从第 3 字起」而 `{` 是第 4 个字符）。现在两处统一 **1-based**；既有断言只校验 `/从第 \d+ 字起未闭合/` 正则，不受影响。

**S3（`lib/prompts.js:296/309`）**：空数组原来无条件算候选数组，于是 `[] {"title":"real"}` 返回 `{candidates:[]}`，上层当「本轮收敛」→ **假成功、无日志、真经验丢光**。现在空数组降级成**弱候选**：先记下，等对象路径也拿不到东西时才返回；单独出现的 `[]` 仍是 `{candidates:[]}`（模型表达「本轮没有可沉淀的」这个合法信号，既有断言不许改）。

**S5（tests/merge.test.mjs `:51-69` 的 `fingerprintRawLog` + `:442` 的守护用例；tests/recap-pipeline.test.mjs `:50-65` 同款 + `:402` 的守护用例）**：Gap 3 的守护原来只比行数 —— 若某条路径把真实文件**整行改写**而不是追加，行数照样不变、守护照样绿。现在加厚成 **行数 + 字节数 + 全文件 sha256 + 末行原文** 四项一起比（`fingerprintRawLog`）。四类篡改的实测对照：

| 篡改方式 | 行数 | 字节数 | sha256 | 末行原文 |
| --- | --- | --- | --- | --- |
| 追加一行 | 抓到 | 抓到 | 抓到 | 抓到 |
| 同一行原地改写（等长） | 漏 | 漏 | **抓到** | 漏 |
| 删一行补一行（换内容） | 漏 | 抓到 | 抓到 | 漏 |
| 原样不动 | 一致 | 一致 | 一致 | 一致 |

**S7**：本文件。

---

## 返工 3：第四轮 T1 —— S1 判据的反向漏口

**改前（S1 的判据范围）**：`looksLikeJsonPrefix(src, arrAt)` 从 `arrAt` 一直扫到**字符串末尾**，只要末尾出现一个中文，整段方括号就被判成「散文」→ 不抛未闭合 → 回落到对象路径 → 而对象路径第一个 `{` 其实在**数组结构内部**，于是解析出的是数组的第一个元素。结果：**「输出被截断」又被伪装成一次成功**，正是 Gap 1 当初要防的那件事。

实测的两条漏口（S1 的用例没有覆盖这个方向）：

| 输入 | 改前结果 | 应当 |
| --- | --- | --- |
| `[{"title":"a"},{"title":"b" 然后一些中文` | 返回 `{"title":"a"}` | 抛「未闭合」 |
| `[{"title":"a"} 然后 {"title":"real"}` | 返回 `{"title":"a"}` | 抛「未闭合」（后面有真结果也不许拿半条顶替） |

**改后（`lib/prompts.js:222-244` + `:288-291`）**：判据只盯 `arrAt → objAt` 这一段，不扫末尾 —— 新增 `hasForeignCharBetween(src, from, to)`（同一套字符串状态机，只在字符串之外检查外来字符，复用 `JSON_TEXT_CHARS`）。接线变成三路：

```js
const foreign = objAt === -1 ? false : hasForeignCharBetween(src, arrAt, objAt);  // :288
if (!foreign) {
  throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (arrAt + 1) + ' 字起未闭合）');
}
```

- `objAt === -1`（没有对象可回落）⇒ `foreign = false` ⇒ **直接抛未闭合**（Gap 1 的原口径，保持）；
- `arrAt → objAt` 之间**没有**外来字符 ⇒ 那个 `{` 就在数组结构内部 ⇒ **抛未闭合**（T1 补的那条漏口）；
- `arrAt → objAt` 之间**有**外来字符 ⇒ 那段方括号是散文里开的符号 ⇒ **回落对象路径**（S1 的三例，保持）。

**两侧边界（写进注释，不声称已消除）**：能区分「`{` 在数组结构内部」（截断）与「`[` 是散文符号、`{` 在它之后」（噪声）；**不能**区分「散文前缀恰好只用了 JSON 语汇字符」这种形态（`[1,2` 后面才接真对象的那一类），只能按截断处理 —— 宁可报故障现场，也不静默拿半条结果。另有一条不可判定：若 `arrAt → objAt` 这一段在收尾处仍在字符串内部（引号没闭合、对象起点被半个字符串吞掉），视为噪声返回 true —— 这正是 `模型说 "[" 然后 {...}` 那一类能回落的原因。

**新增用例（tests/prompts.test.mjs）**：`:250` R48-T1、`:263` R48-T1 回归守护。

---

## 返工 4：终验报告遗留项（F1–F5）

终验代理判 Gap 1–5 / S1 / S2 / S3 / T1 达标后，在**规格外**又挖出 5 条「静默丢数据」——它们不是本轮改出来的回归（旧代码同样如此），但正好是本轮想消灭的那一类，所以一并修掉。

### F1：数组开头、字符串没闭合的截断被当成散文放行（lib/prompts.js:304-324 + :374-382）

**改前**：`hasForeignCharBetween` 收尾 `return inStr;` —— 停在没闭合的引号里就判「散文」（true），于是 `["abc {"title":"real"} def` 不抛未闭合、回落到数组内部的 `{"title":"real"}`，截断被伪装成成功。而 `scanJson` 收尾是 `return undefined`（判截断），两条路径给出相反结论。

**改后（与用户原提修法不同，理由在下）**：用户建议把尾部改成 `return false`（判截断）。实测这会**误杀 S1c 两条既有用例**——`模型说 "[" 然后 {"title":"real"}` 那个 `{` 也被吞进同一段没闭合的字符串里，尾部判截断就再也回不到对象路径。所以改在调用方加一条「输出以 `[` 开头 ⇒ 顶层就是数组」的判据：

```js
const leading = src.slice(0, arrAt).trim() === '';        // :376
const foreign = objAt === -1 ? false : hasForeignCharBetween(src, arrAt, objAt);  // :379
if (leading || !foreign) {                                 // :380（F1 新增 leading；原只有 !foreign）
  throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (arrAt + 1) + ' 字起未闭合）');
}
```

两条口径互补：`leading` 兜「数组就是全文开头」的截断（`["abc…`、`[提示 {…}` 两条都命中），`hasForeignCharBetween` 尾巴保持 `return inStr` 兜 S1c 的散文回落。注释 `:318-323` 如实写明「不能改成判截断，否则 S1c 被误杀」。

**新增用例**：tests/prompts.test.mjs `:287` R48-F1（含 S1c 反向守护）。

### F2：配平但非法 JSON 的数组被整段降级成噪声，只取第一个对象（lib/prompts.js:174-182 / :226-263 / :394-400）

**改前**：尾逗号 / 全角逗号 / 元素间混散文的数组走 `noise` → 回落对象路径 → 只解析出数组里第一个 `{…}`，第二条起全丢。

**改后**：`noise` 分支在 `arrAt → 配对右括号` 范围内按顶层 `{…}` 逐个 `scanJson` 回收（新函数 `recoverObjectsInRange(src, from, to)`，:226-263，只收普通对象、不收标量）：`const recovered = recoverObjectsInRange(src, arrAt, scanned.endAt); if (recovered.length > 0) return { candidates: recovered };`（:395-396）。**截断分支一律不回收**（Gap 1 / T1 的铁律：截断当场抛，绝不拿半条）。

**新增用例**：tests/prompts.test.mjs `:302` R48-F2（尾逗号 / 全角逗号 / 混散文三条都拿到 2 条 + 真截断仍抛）；merge 不变量回归 tests/merge.test.mjs `:485`（这两类回收后送 `parseMergeResult` 仍是 null、绝不抛错）。

### F3：ace_reflect 手动工具没接 dumpRaw（lib/index.js:1603-1612）

**改前**：`const parsed = extractJsonObject(raw);` 裸调用 —— 手动复盘失败时抛原生 SyntaxError、`raw.jsonl` 一个字节都不写，与自动复盘（:1389-1395）行为不一致。

**改后**：

```js
let parsed;
try {
  parsed = extractJsonObject(raw);
} catch (error) {
  await dumpRaw({ stage: 'reflect', provider: route.provider, model: route.model, raw, error });
  throw error;   // 工具的错误语义一个字不变
}
```

**新增用例**：tests/wiring.test.mjs `:1320` R48-F3（真打 `ace_reflect` 工具、断言抛错 + 临时 home 的 raw.jsonl 多一条 reflect 现场、带 provider/model）。

### F4：reflect 侧落盘接线零用例覆盖（lib/index.js:1389-1395 已有代码，只补用例）

**改前**：终验代理删掉 lib/index.js:1393 那行 `await dumpRaw(...)`，全量仍 **674/673/0/1 全绿** —— 接线没有任何用例咬住。

**改后**：不动代码，补一条真跑用例：把 LLM 桩换成只吐**纯散文**（不是空正文 —— 空正文在 `oneShot` 里就抛了、根本到不了 `extractJsonObject`），真打一次 `/ace` 命令让 `reflectRound` 解析失败，再从临时 DSH_HOME 的 raw.jsonl 里读回新增的那一行，断言 `stage==='reflect'` 且 `round/provider/model` 齐全、`rawLength > 0`；并比真实 `~/.dsh` 的 raw.jsonl 四项指纹（存在性 / 行数 / 字节数 / 末行原文）跑前跑后一致。

**新增用例**：tests/wiring.test.mjs `:1283` R48-F4。**自证**：删掉 :1393 那行 → 这条转红（见下方变异表）。

### F5：对象路径拿到「空壳对象」后不看后面的候选数组（lib/prompts.js:213-223 / :265-271 / :399-412）

**改前**：`{} [{"title":"a"},{"title":"b"}]` 返回 `{}`；`{"notes":"没有经验"} [{…}]` 返回那个空壳 —— 上层 filter 后 0 候选，复盘**假成功**（当成本轮收敛），真经验整批丢。`[1,2] [真候选数组]` 也只取第一个。

**改后**：
- 新增 `isContractObject(v)`（:213-223）：`candidates`/`pairs` 是数组，或四字段全 string ⇒ 契约对象，直接原样返回（`{"pairs":[]}` 因此仍原样返回，merge 不变量保住）；
- 空壳对象再回看候选数组：`if (isContractObject(v)) return v; const rescued = findCandidateArray(src, arrAt === -1 ? 0 : arrAt); if (rescued) return { candidates: rescued }; return v;`（:408-412，复用 `:265-271` 的 `findCandidateArray`，没有复制第二份）；
- 先出现的数组若是标量数组（非候选）、或 noise 回收不到对象，也先 `findCandidateArray(src, arrAt + 1)` 看一眼后面的真数组（:390、:398）—— `[1,2] [真候选数组]` 因此拿真数组。

**新增用例**：tests/prompts.test.mjs `:319` R48-F5（空壳 + 候选数组、带 notes 空壳、标量数组 + 候选数组，外加 `{"pairs":[]}` / 四字段对象 / `[]` 三条形状底线）。

---
## 返工 5：终验报告的两条低危（G1 / G2）

终验回执把 F1–F5 全部裁定达成（内含零用例被删 / 改名、HEAD 基线 648 自洽、真实 `raw.jsonl` 四次测量未变、`%TEMP%` 残留清零），另留两条低危。它们仍未跳出「静默假成功」与「现场丢失」这两类，故本轮一并修掉。

### G1：空 `candidates` 壳不许劫持后面的真候选数组（lib/prompts.js:220-227）

**改前**（F5 之后的 `isContractObject`）：

```js
if (Array.isArray(v.candidates) || Array.isArray(v.pairs)) return true;
```

`{"candidates":[]}` 因此被 `isContractObject`（:220-227）当成契约对象直接返回，于是「模型先给个空的、再给真的一批」的输出拿到 0 候选，上层贴上「本轮收敛」——**假成功、无日志、真经验全丢**，与 F5 同源。

**改后**：

```js
if (Array.isArray(v.pairs)) return true;                              // :222 merge 契约照旧
if (Array.isArray(v.candidates) && v.candidates.length > 0) return true; // :223 空 candidates 不算契约
```

空 `candidates` 壳不再短路，继续走 :429-430 的 `rescued` 回落：捞到后面的真候选数组就返回它，捞不到时 :431 仍原样返回那个空壳 —— 所以**单独出现**的 `{"candidates":[]}` 行为一个字节都没变。顶层 `[]` 走的是数组路径的 S3 弱候选，与这个判定无关，`tests/prompts.test.mjs:114` 的既有断言不受影响。

**新增用例**：`tests/prompts.test.mjs:347` R48-G1a（空壳 + 真数组必须拿真数组）、`:353` R48-G1b（空壳单独出现仍是空壳，并守住 `[]` / `[] {"title":"real"}` / 非空 candidates / `{"pairs":[]}` 四条形状底线 + 纯散文仍抛「未找到」）。

### G2：对象路径的非法 JSON 报错加 `ace:` 前缀与现场（lib/prompts.js:161-165 + :412-425）

**改前**：`scanJson` 自己 `JSON.parse`，对象路径 `const v = scanJson(src, objAt, '{', '}')` 遇到 `{"a":1，"b":2}` / `{'title':'a'}` / `{"title":"a","condition":"c",}` 抛**裸 SyntaxError** —— 没有 `ace:` 前缀、也没有「收到多少字符 / 开头是什么」的现场，日志里认不出是 ACE 哪一步出的问题。

**改后**：`scanJson` 只返回配对**原文**（:164 `return src.slice(start, end + 1);`，解析交给调用方），对象路径自己包一层：

```js
const segment = scanJson(src, objAt, '{', '}');                                  // :412
if (segment === undefined) throw new Error('ace: LLM 输出中的 JSON 对象不完整（从第 ' + (objAt + 1) + ' 字起未闭合）');
let v;
try { v = JSON.parse(segment); }
catch (parseError) {                                                             // :419-424
  throw new Error('ace: LLM 输出中的 JSON 对象无法解析（本次收到 ' + src.length + ' 字符，开头：'
    + JSON.stringify(src.slice(0, 60)) + '）：'
    + (parseError && parseError.message ? parseError.message : parseError));
}
```

三条前缀就此并列：「未找到」/「不完整」/「**无法解析**」。原始 SyntaxError 的 message（含 `at position N (line L column C)`）原样留在末尾，一个字符都没丢。文案不以「ace: LLM 调用超时」开头 ⇒ 不会被 `lib/reflect.js` 的 `isTimeoutError` 误判成超时；落盘侧 `dumpRaw` 早已接住 `error.message`，无需另改。

**新增用例**：`tests/prompts.test.mjs:375` R48-G2a（中文逗号）、`:379` R48-G2b（单引号）、`:383` R48-G2c（尾逗号）—— 三条共用 `assertJsonUnparseable`（:364-373），断言 `ace:` 起头 + 「收到 N 字符」+ 开头 60 字符现场 + `/：Expected .+in JSON at position \d+ \(line \d+ column \d+\)$/` 原始 message 在末尾 + 不含「调用超时」。

### 一个行为变化（如实点名）

`scanJson` 不再自己 parse，**唯一的行为变化**就是这条报错：同一份非法 JSON 由「裸 `SyntaxError`」变成「带 `ace:` 前缀与现场的 `Error`」。仓库里没有任何用例断言过 `SyntaxError`（`grep -R 'SyntaxError' tests/` 只命中 `tests/wiring.test.mjs` 的全局名字白名单，不是断言），所以本轮**没有改任何既有用例**。

---
## 用例：净增 37 条，全绿

| 文件 | 新增用例 | 行号 |
| --- | --- | --- |
| tests/llm-budget.test.mjs | R48 oneShot｜只有 reasoning-delta → 抛「正文为空」并带 reasoning 字符数、耗时、provider/model | `:74` |
| | R48 oneShot｜错误不是超时：`isTimeoutError` 认不出来 | `:105` |
| | R48 oneShot｜正常流不受影响：text-delta 照常累加、reasoning 不混进返回值 | `:118` |
| tests/prompts.test.mjs | extractJsonObject：既有的对象路径一字不改 —— 原样返回、不包壳 | `:94` |
| | extractJsonObject：顶层数组也认 —— 包成 `{ candidates: [...] }` | `:102` |
| | extractJsonObject：未闭合对象仍报「JSON 对象不完整」，文案带「未闭合」与起始位置 | `:127` |
| | extractJsonObject：空串 / 纯散文报错带现场 —— 收到多少字符 + 开头 60 字符 | `:135` |
| | R48-Gap1：顶层数组没配平当场报「未闭合」，绝不回落到第一个对象 | `:161` |
| | R48-Gap2：散文方括号 / 全是标量的数组都算噪声 —— 回落对象路径 | `:173` |
| | R48-S1：散文里开了没关的方括号是噪声，必须回落拿到真结果（含真截断两条仍抛） | `:207` |
| | R48-S2：未闭合位置一律 1-based —— 对象路径也一样 | `:224` |
| | R48-S3：空数组是弱候选 —— 后面有真结果时优先真结果，单独出现仍是收敛信号 | `:233` |
| tests/merge.test.mjs | R48 parseMergeResult｜顶层数组被包成 `{candidates}` 后仍是 null，绝不抛错 | `:212` |
| | R48-Gap3｜失败现场只落在临时 DSH_HOME：真实 `~/.dsh` 的 raw.jsonl 一行都不许多（四项指纹） | `:442` |
| | R48-Gap4｜planMerges 透传的 provider/model 真的进了 merge 失败现场 | `:462` |
| tests/raw-log.test.mjs（新文件） | 落点是 `<DSH_HOME>/ace/debug/raw.jsonl`，一行一个 JSON 且字段齐全 | `:37` |
| | 原文超过 4000 字符只留前 4000，但 `rawLength` 记全长 | `:67` |
| | 只保留最近 20 条：写 21 次后只剩 20 行，且丢的是最旧那条 | `:81` |
| | 杀开关 `ACE_RAW_LOG=0` / `off`：完全不写、连目录都不建 | `:100` |
| | 一切失败全吞：目录建不出来 / 畸形入参都不抛错 | `:124` |
| | 并发的多次写入不互相覆盖 | `:146` |
| tests/recap-pipeline.test.mjs | R48-Gap4｜合并失败现场在整链 return 时就已落盘，且带 provider/model（不靠额外 flush） | `:352` |
| | R48-Gap4｜没有 mergeRoute 时照旧合并（路由只影响现场、绝不影响判定） | `:381` |
| | R48-Gap3｜失败现场只落临时 DSH_HOME，真实 raw.jsonl 一行不多（四项指纹） | `:402` |
| tests/wiring.test.mjs | R48-F4｜自动复盘 reflectRound 解析失败时现场真落盘（带 round/provider/model），真实 home 不受影响 | `:1283` |
| | R48-F3｜手动工具 ace_reflect 解析失败也落盘（provider/model 齐全），错误照原样重抛 | `:1320` |
| tests/prompts.test.mjs | R48-F1：数组开头但字符串没闭合的截断必须报未闭合；S1c 散文方括号仍回落 | `:287` |
| | R48-F2：尾逗号 / 全角逗号 / 元素间混散文的数组按顶层对象回收，不许只拿第一条 | `:302` |
| | R48-F5：空壳对象后面还有真候选数组时必须拿数组；`{"pairs":[]}` / 四字段对象仍原样 | `:319` |
| | R48-G1a：空 candidates 壳后面跟着真候选数组时必须拿真数组（不许假成功） | `:347` |
| | R48-G1b：空壳单独出现时行为一个字节都不变，并守住 `[]` / `[] {…}` / `{"pairs":[]}` 四条形状底线 | `:353` |
| | R48-G2a：对象路径遇中文逗号，报错带 `ace:` 前缀 + 现场 + 原始 message | `:375` |
| | R48-G2b：对象路径遇单引号，同上 | `:379` |
| | R48-G2c：对象路径遇尾逗号，同上 | `:383` |
| tests/merge.test.mjs | R48-F2 回归：回收出来的数组送 parseMergeResult 仍是 null、绝不抛错 | `:485` |

**全量实测**：`cd D:\dsh\plugins\dsh-ace; node --test tests/` → **tests 685 / pass 684 / fail 0 / skipped 1 / duration ≈ 6.4–6.6s，EXIT 0**。基线演变：**648（第 47 轮）→ 669（B1/洞1/B2 + Gap 1–5）→ 672（S1/S2/S3 三条 + 其余为既有用例强度加厚，不增用例数）→ 674（T1 两条）→ 680（F1/F2/F5 + merge 回归 + F3/F4 六条）→ 685（G1 两条 + G2 三条）**。既有断言一条未改、新用例一条未 skip。

---

## 变异自证（每条真跑、跑完逐字复原，恢复后 sha256 与改前 IDENTICAL）

| 变异 | 结果 |
| --- | --- |
| 「没配平就报未闭合」的旧宽判（S1 修之前的状态） | tests/prompts.test.mjs **红 1**（R48-S1），EXIT=1 |
| 对象路径改回 0-based（`objAt` 而非 `objAt + 1`） | tests/prompts.test.mjs **红 1**（R48-S2），EXIT=1 |
| 空数组回到「无条件算候选数组」（删掉弱候选分支） | tests/prompts.test.mjs **红 1**（R48-S3），EXIT=1 |
| `hasForeignCharBetween` 恒 `false`（永远判截断，T1 判据的反向） | tests/prompts.test.mjs **红 2**（R48-S1、R48-T1 回归守护），EXIT=1 |
| `hasForeignCharBetween` 恒 `true`（永远判散文，退回 S1 的宽口径） | tests/prompts.test.mjs **红 4**（R48-Gap1、R48-S1、R48-T1、R48-T1 回归守护），EXIT=1 |
| M-F1：`if (leading || !foreign)` 去掉 `leading` → `if (!foreign)` | tests/prompts.test.mjs **红 1**（R48-F1），EXIT=1 |
| M-F2：`const recovered = [];`（不回收） | tests/prompts.test.mjs **红 1**（R48-F2），EXIT=1 |
| M-F5：对象路径拿到空壳后直接 `return v;`（不看后面的候选数组） | tests/prompts.test.mjs **红 1**（R48-F5），EXIT=1 |
| M-F3：删掉 lib/index.js:1610 的 `await dumpRaw(...)` | tests/wiring.test.mjs **红 1**（R48-F3），EXIT=1 |
| M-F4：删掉 lib/index.js:1393 的 `await dumpRaw(...)` | tests/wiring.test.mjs **红 1**（R48-F4），EXIT=1 |
| M-G1：`isContractObject` 改回「`candidates`/`pairs` 是数组就算契约」（空壳又重新劫持真数组） | tests/prompts.test.mjs **红 1**（R48-G1a），EXIT=1 |
| M-G2：对象路径直连 `JSON.parse`（去掉包壳） | tests/prompts.test.mjs **红 3**（R48-G2a / G2b / G2c），EXIT=1 |

每组变异各自只打红对应用例、其余用例全绿；恢复后 `node --test tests/prompts.test.mjs` 回到 26/26、`tests/wiring.test.mjs` 全绿（lib/prompts.js 的 sha256 回到 `1CC7B319BB4BD9195F0ABB940F1F85227F96AC1410973777167D003450FBD961`，与变异前 IDENTICAL）。

---

## 遗留与未验证（如实声明）

- **线上真实失败未复现**：本轮所有证据来自单测（假 provider / 假 Reflector / 临时手册整链）与真实文件只读探针。真实「模型把内容全写进 reasoning 通道」的那一趟没有在真机上重演 —— 要重启 DSH 后在真实会话里观察一次，才算闭环。
- **S1 的残留歧义**（已写进 `lib/prompts.js:206-220`）：方括号后恰好只跟 JSON 语汇字符、实际却是散文时仍判截断；T1 之后判据只看 `arrAt → objAt` 这一段，`objAt` 之前引号没闭合这种不可判定形态按噪声（回落对象路径）处理。反向的 `isCandidateArray` 歧义（模型先贴一段**装着对象的示例数组**再给真结果时，仍可能把示例当候选）同样未消除，取舍是「只收窄全标量这一端」—— 再严会误杀合法空壳候选，误杀好经验不可逆（红线 15 口径）。
- **真实 `C:\Users\adkun\.dsh\ace\debug\raw.jsonl` 现存 19 行历史上全是测试夹具**（stage 全 `merge`、时间 2026-10-28T07:48–08:01、`rawLength` 序列 7/0/7/7/0/7/19/…），不是线上真实事故留下的现场。本轮**不删它**（用户资产），隔离后实测行数、字节数、mtime 均未再变化（19 行 / 3958 字节 / 2026-10-28T08:01:40.252Z）。
- **保留上限会挤掉历史**：`dumpRaw` 只留最近 20 条，上面那 19 行历史夹具会在真实事故发生时被更早挤掉 —— 这是规格里的取舍（不写复杂索引），但意味着「第一次真事故」的现场要尽快看。
- **本轮明确不做（规格外、留档）**：① 数组里只有全角空格元素（如 `[\u3000]`）与 `[]` 行为不一致；② `raw.jsonl` 保留 20 条会挤掉现存 19 行历史夹具（见上一条）；③ `[[1,2],[3,4]]` 这类**全标量嵌套数组**报「未找到 JSON 对象」—— 这属**正确语义**（里面没有可沉淀的候选），不做特殊处理，也不许为了让这类输入「成功」而放宽候选判据。
- **四项只能线上观察、本轮无法验证**：① `dumpRaw` 的跨进程并发（多进程同时写同一个 `raw.jsonl`）是否仍不丢行 —— 单测里的串行化只覆盖同进程；② 进程被强杀（崩溃 / 任务管理器结束）时那一行是否已落盘；③ 真实 provider 上「内容全写进 reasoning 通道、正文为空」的那一趟是否会在 `oneShot` 抛出新文案（B1 只在假 provider 上验过）；④ 真实 GUI 会话里让 `ace_reflect` 手动失败一次、确认 `raw.jsonl` 多出一条 `stage:'reflect'` 的现场。四项都写进「未验证」，不当成已达成。
- **未做 git 操作**，未改动仓库之外的任何文件（除测试自己创建的 `os.tmpdir()` 临时目录，已在 `after()` 删除）。

---

## 收尾声明

**第 48 轮（R48）到此冻结。** 五个缺口（B1 / 洞1 / B2）与五轮返工（Gap 1–5、S1/S2/S3/S5/S7、T1、F1–F5、G1/G2）全部落地并自证，全量基线 **685 用例 / 684 过 / 1 skip，EXIT 0**。**除上面那四项只能线上观察的未验证项外，不再接受新的返工轮次**；日后若线上真的复现失败，以 `raw.jsonl` 里的现场为准重新开轮，而不是回到本轮的规格上继续打磨。
