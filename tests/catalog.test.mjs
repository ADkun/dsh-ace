// 模型目录组装逻辑（lib/catalog.js）的单元测试。
// 重点：单个 provider 失败 / 超时不能拖垮整个接口，且失败者要带上 error。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, withTimeout } from '../lib/catalog.js';

const providers = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'broken', name: 'Broken' },
  { id: 'slow', name: 'Slow' },
];

function fakeLlm(overrides = {}) {
  return {
    listProviders: () => providers,
    async listModels(id) {
      if (id === 'deepseek') return [
        { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
        { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ];
      if (id === 'broken') throw new Error('adapter exploded');
      return new Promise(() => {}); // slow：永不 settle，靠超时兜底
    },
    ...overrides,
  };
}

test('buildCatalog：正常 provider 折叠成 {id,name,models[{id,name,description?}]}', async () => {
  const catalog = await buildCatalog(fakeLlm(), { timeoutMs: 50 });
  assert.equal(catalog.ok, true);
  const deepseek = catalog.providers.find((p) => p.id === 'deepseek');
  assert.deepEqual(deepseek, {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  });
});

test('buildCatalog：单个 provider 抛错只让它自己 models=[] 并带 error，接口仍 ok', async () => {
  const catalog = await buildCatalog(fakeLlm(), { timeoutMs: 50 });
  assert.equal(catalog.ok, true);
  const broken = catalog.providers.find((p) => p.id === 'broken');
  assert.deepEqual(broken.models, []);
  assert.match(broken.error, /adapter exploded/);
  // 其余 provider 不受影响
  assert.equal(catalog.providers.find((p) => p.id === 'deepseek').models.length, 2);
});

test('buildCatalog：listModels 卡住时按超时收尾，不拖垮接口', async () => {
  const started = Date.now();
  const catalog = await buildCatalog(fakeLlm(), { timeoutMs: 30 });
  assert.equal(catalog.ok, true);
  const slow = catalog.providers.find((p) => p.id === 'slow');
  assert.deepEqual(slow.models, []);
  assert.match(slow.error, /timeout/);
  assert.ok(Date.now() - started < 2000, '超时应当很快收尾');
});

test('buildCatalog：listProviders 抛错或服务缺失时返回 ok=false 而不是抛异常', async () => {
  const throwing = await buildCatalog(fakeLlm({ listProviders: () => { throw new Error('no registry'); } }), {});
  assert.equal(throwing.ok, false);
  assert.match(throwing.error, /no registry/);
  assert.deepEqual(throwing.providers, []);

  const missing = await buildCatalog(undefined, {});
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.providers, []);
});

test('withTimeout：按时收尾成功值，超时则以 Error 拒绝', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 100), 7);
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /timeout after 20ms/);
  await assert.rejects(() => withTimeout(Promise.reject(new Error('boom')), 100), /boom/);
});
