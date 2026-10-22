# AGENTS.md —— dsh-ace 仓库路由

本文件是 agent 进入本仓库的第一站：只做路由、命令与红线，细节一律下沉到对应文档。

## 这是什么

dsh-ace 是 DSH 原生插件（cordis bundle），实现 ACE 方法：把操作手册（playbook）当作可进化资产，经 `ace_reflect`（复盘）与 `ace_curate`（增量并入）演化，`ace_playbook` 供查阅。手册默认在本机共享层 `<DSH home>/ace/playbook.md`（跨工作区共用一本）；`playbookPath` 填相对路径则改为该工作区私有。

## 文件地图

| 要了解 | 去读 |
| --- | --- |
| 安装、配置字段、首次使用 | README.md |
| 架构、数据模型、不变量、红线依据 | DESIGN.md |
| 测试怎么跑、覆盖了什么、还差什么 | TESTING.md |

## 代码地图

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口：Config、三个工具注册、系统提示段 |
| `client.js` | 浏览器半边：在 DSH 设置面板注册「ACE 手册」配置页（settings.section slot，经 ctx.configForms 读写配置；固定 VCP 暗色 + JetBrains Maple Mono） |
| `lib/playbook.js` | 手册持久化：解析/序列化/增量操作/原子写/互斥锁（同进程 `withLock` + 跨进程 `withFileLock`，组合入口 `withExclusiveLock`；跨进程锁**不抢占活着的持锁者**，超时失败而非覆盖）；纯逻辑，可独立测试 |
| `lib/prompts.js` | Reflector/Curator 提示词与 LLM JSON 提取 |
| `lib/llm.js` | 模型路由解析与单次 LLM 调用 |
| `lib/playbook-path.js` | 手册文件位置解析（绝对路径 / `~` 展开 / 相对工作目录 / 空串=本机共享层 `<DSH home>/ace/playbook.md`；纯逻辑，可独立测试） |
| `lib/settings-path.js` | 设置文件位置解析（profileContext → DSH_PROFILE_DIR → DSH_HOME → ~/.dsh）与旧文件一次性迁移（纯逻辑，可独立测试） |
| `tests/playbook.test.mjs` | 持久化层单元测试（node --test） |
| `tests/playbook-path.test.mjs` | 手册路径解析链的单元测试（node --test） |
| `tests/settings-path.test.mjs` | 设置路径解析与迁移的单元测试（node --test） |

## 命令

```
npm test        # node --test tests/
node --check lib/index.js   # 语法检查（其余 js 同法）
```

## 红线（改动前必读，完整依据见 DESIGN.md「非功能红线」）

1. 手册只能增量演化（增/改/删单条），不存在也不许加「整本重写」的代码路径或提示词；
2. 手册写入必须走 `withLock` + `writeFileAtomic`，不许绕开直接 `fs.writeFile` 手册文件；
3. LLM 输出必须经 `extractJsonObject` 结构化校验后才能落盘，原始文本不直接进手册；
4. 引用 DSH API 必须注明 checkout 出处（文件:行号），不许凭空捏造；
5. 不引入新的 npm 运行时依赖（宿主服务一律走 `inject` 声明）。