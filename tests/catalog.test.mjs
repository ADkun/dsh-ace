// 模型目录组装逻辑（lib/catalog.js）的单元测试。
// 重点：单个 provider 失败 / 超时不能拖垮整个接口，且失败者要带上 error。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('P2-5｜超时不 abort 上游（宿主 listModels 没有 signal）：上游晚到的 reject 必须被吞掉，不许变成 unhandledRejection', async () => {
  // 宿主接口 LlmRuntime.listModels(provider) 没有 signal 形参，超时后拿不到取消句柄 ——
  // withTimeout 只能「不再等它」。这条用例钉住那个选择的副作用面：
  //   ① 超时立刻按 Error 收尾（不拖住设置页）；
  //   ② 上游在超时之后才 reject 时，不许冒出 unhandledRejection 把进程搞脏。
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectLate;
    const upstream = new Promise((_resolve, reject) => { rejectLate = reject; });
    await assert.rejects(() => withTimeout(upstream, 20), /timeout after 20ms/, '超时先收尾');

    // 上游「晚到」的失败（真实场景：宿主 HTTP 请求自己超时/断连后才 reject）
    rejectLate(new Error('上游晚到的失败'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, [], '晚到的 reject 已被 withTimeout 的 then 吞掉，不许变成 unhandledRejection');

    // 反向对照：同样的悬挂 promise 若没人接管，**在这台机器的这个 Node 上**确实会冒出
    // unhandledRejection —— 证明上面那条「空数组」断言不是永真。对照跑在子进程里：
    // node:test 会把本进程的 unhandledRejection 判成本用例失败，放在子进程既能看到现象、
    // 又不会把父测试搞红。
    const child = spawnSync(process.execPath, ['-e', [
      "process.on('unhandledRejection', (r) => { console.log('CAUGHT:' + (r && r.message)); });",
      "let rejectBare; const bare = new Promise((_res, rej) => { rejectBare = rej; });",
      'void bare;',
      "rejectBare(new Error('没人接管的失败'));",
      "setTimeout(() => console.log('DONE'), 40);",
    ].join('\n')], { encoding: 'utf8' });
    assert.match(child.stdout, /CAUGHT:没人接管的失败/, '对照组必须冒出来一条，否则本用例的判据是假的');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
