// 模型目录（设置页两个下拉的数据源）：把 LlmRuntime 的 provider/model 目录
// 折叠成一处可直接 JSON 化的形状。纯逻辑、不碰 IO，可独立测试（tests/catalog.test.mjs）。
//
// API 出处（DSH checkout：C:\Users\adkun\AppData\Local\npm-cache\_npx\b86ed90107c62dab\node_modules\@deepseek-ai，下记 ~）：
// - LlmRuntime.listProviders(): LlmProviderInfo[]，同步 —— ~\dsh-llm\lib\types\index.d.ts:281；
//   LlmProviderInfo { id, name } —— ~\dsh-llm\lib\types\types.d.ts:205-210；
// - LlmRuntime.listModels(provider: string): Promise<LlmModelInfo[]>，异步 —— ~\dsh-llm\lib\types\index.d.ts:367；
//   LlmModelInfo { provider, id, name, description? } —— ~\dsh-llm\lib\types\types.d.ts:321-332。

/**
 * 给一次异步调用套上超时（某个 provider 的 listModels 卡住不能拖垮整个接口）。
 *
 * 超时后**不 abort 上游**（P2-5 的结论，不是疏忽）：
 * 宿主接口是 `LlmRuntime.listModels(provider: string): Promise<LlmModelInfo[]>`
 * （~dsh-llmlib	ypesindex.d.ts:367）——**没有 signal 形参**，AbortSignal 传不进去，
 * 也没有别的取消入口（provider 适配器那层同样只收 provider id，~dsh-llmlibindex.js:170）。
 * 所以这里唯一能做的就是「不再等它」，把控制权还给 buildCatalog：设置页照常渲染、
 * 那个 provider 记为 error。泄漏面是有界的 —— 每次请求最多一个 provider 一条悬挂 promise，
 * 上游请求自己超时或返回后即释放；拿不到取消句柄硬造一个（比如自己 new AbortController 却不给上游）
 * 只是假装取消了，反而更糟。
 *
 * 附带保证：上游晚到的 reject 会被这里的 then 吞掉（不会变成 unhandledRejection），
 * 因为外层 promise 早已 settle，第二次 reject 是空操作。tests/catalog.test.mjs 有钉子。
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after ' + ms + 'ms')), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 同一次 runtime（= 同一个 llm 实例）内的目录缓存 TTL（D1，保守 45s）。 */
const CATALOG_CACHE_TTL_MS = 45000;
/** 按 llm 实例隔离的缓存：{ at, result }。WeakMap → 实例被回收即释放，不跨会话堆积。 */
const catalogCache = new WeakMap();
/** 目录是纯 JSON，深拷贝返回，调用方改不动缓存里的那份。 */
function cloneCatalog(result) {
  return JSON.parse(JSON.stringify(result));
}

/**
 * 组装 GET /api/dsh-ace/catalog 的返回体：
 *   { ok: true, providers: [{ id, name, models: [{ id, name, description? }], error? }] }
 * 容错：逐个 provider 各自 try/catch + 超时；失败者的 models 为 [] 并带一条 error，
 * 整个接口不 500 —— 设置页其余字段照常可用。
 */
export async function buildCatalog(llm, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const logger = options.logger;
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: false, error: 'llm service unavailable', providers: [] };
  }
  // D1：同一 llm 实例内缓存成功结果，短 TTL（默认 45s，options.cacheTtlMs 可覆盖，0 = 关闭）。
  const ttl = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : CATALOG_CACHE_TTL_MS;
  const cacheable = ttl > 0 && (typeof llm === 'object' || typeof llm === 'function');
  if (cacheable) {
    const hit = catalogCache.get(llm);
    if (hit && Date.now() - hit.at < ttl) return cloneCatalog(hit.result);
  }
  let listed;
  try {
    listed = llm.listProviders();
  } catch (error) {
    return { ok: false, error: 'listProviders failed: ' + (error?.message ?? error), providers: [] };
  }
  const providers = [];
  for (const provider of Array.isArray(listed) ? listed : []) {
    const id = String(provider?.id ?? '');
    const entry = { id, name: String(provider?.name ?? id), models: [] };
    try {
      const models = await withTimeout(llm.listModels(id), timeoutMs);
      entry.models = (Array.isArray(models) ? models : []).map((model) => {
        const item = { id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') };
        if (typeof model?.description === 'string' && model.description !== '') item.description = model.description;
        return item;
      });
    } catch (error) {
      entry.error = String(error?.message ?? error);
      logger?.warn?.('dsh-ace: 模型目录读取 ' + id + ' 失败（' + entry.error + '）');
    }
    providers.push(entry);
  }
  const result = { ok: true, providers };
  // 只缓存「全成都读到了」的结果：任何 provider 带 error（失败/超时）都不缓存，下次重试。
  if (cacheable && result.providers.every((p) => !p.error)) catalogCache.set(llm, { at: Date.now(), result });
  return result;
}
