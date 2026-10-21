---
title: dsh-ace 使用手册
owner: dsh-ace 维护者
status: current
last_reviewed: 2026-10-21
---

# dsh-ace —— ACE 操作手册插件

**结论：装上即得一套「可进化的操作手册」——agent 完成任务后自动复盘沉淀经验，下次任务前翻手册照做；手册是纯 Markdown，人随时可以翻看和直接编辑。**

dsh-ace 把 ACE（Agentic Context Engineering, arXiv 2510.04618）的方法做成 DSH 原生插件：不训练模型、不改权重，纯靠提示词与一个 Markdown 文件（playbook）。核心循环：

1. **读**：任务开始前，agent 用 `ace_playbook` 查手册里有没有命中经验；
2. **盘**：完成一个有实质工作量的任务后，agent 调 `ace_reflect`，由 LLM 复盘轨迹、提炼候选经验（条件/做法/依据）；
3. **并**：`ace_curate` 把候选经验增量并入手册——增/改/删单条，LLM 去重，绝不整本重写（防止旧经验细节被磨平）。

## 安装

**结论：一条命令安装，无需 Python、无需构建、无第三方 npm 依赖。**

在终端（DSH 可用环境中）执行：

```
dsh plugin add github:ADkun/dsh-ace
```

也可以写完整地址：`dsh plugin add https://github.com/ADkun/dsh-ace.git`

安装后重启会话即可生效（插件注册三个工具和一段系统提示）。卸载：`dsh plugin remove dsh-ace`。

## 首次使用

**结论：什么都不用配置——第一次调用会自动在工作区创建 `.ace/playbook.md`。**

1. 正常给 agent 派活；完成一个像样的任务后，agent 会（被系统提示提醒）调用 `ace_reflect` 复盘，再把有价值的候选经验用 `ace_curate` 并入手册；
2. 想人工沉淀经验，直接告诉 agent「把这条经验加进手册」，或自己编辑 `.ace/playbook.md`（条目格式见下）；
3. 下次遇到同类任务，agent 开始前会先查手册。

手册条目格式（人可直接编辑，机器序列化同款）：

```markdown
### [ace-001] 编辑前先读目标文件
- 条件：要对既有文件做任何修改之前
- 做法：先用 read 完整读一遍，确认结构后再动手
- 依据：盲改导致过两次返工
- 元数据：created=2026-02-07 updated=2026-02-07 helpful=0 harmful=0
```

## 配置

**结论：全部字段有默认值，零配置可用；想覆盖复盘用哪个模型、改手册位置时才需要动。**

**改配置有两条路：**

1. **设置页（推荐）**：DSH 网页端 → 侧边栏底部 Settings → 导航里的「ACE 手册」。页面是固定暗色卡片、JetBrains Maple Mono 等宽字体，改动即保存（写入宿主配置，重启会话生效）；
   - 其中 **复盘 provider / model 两个覆盖字段是可搜索的分组下拉**（不再是自由文本）：点开即可搜索（对 name / id / description 做大小写不敏感子串匹配），↑/↓ 移动高亮、Enter 选中、Esc 或点面板外部关闭；model 下拉按 provider 分组，已选 provider 时只列该组；
   - 两行各自都能**清空**（面板底部「跟随会话模型（清空）」），清空即回到跟随会话模型；
   - **provider 与 model 必须两项都填才生效**：只填一项时页面会在 model 行下方给出橙色警告，`resolveRoute` 也会静默回落到会话模型；
   - 下拉的数据来自宿主的 `GET /api/dsh-ace/catalog`；宿主还没重启到带这个接口的版本时，下拉里只显示一行「模型目录读取失败」，其余字段照常可用；
2. **补丁层**：直接在 profile 的 `cordis.patch.yml` 里 override `dsh-ace` 条目的 config 字段。

| 字段 | 类型 / 默认值 | 说明 |
| --- | --- | --- |
| `playbookPath` | string / `.ace/playbook.md` | 手册文件路径；相对路径相对会话工作目录解析 |
| `autoReflect` | boolean / `true` | 是否在系统提示里提醒 agent 任务完成后主动复盘 |
| `reflectProvider` | string / 空 | 复盘与策展 LLM 的 provider 覆盖（设置页为可搜索下拉，可清空）；留空跟随会话模型 |
| `reflectModel` | string / 空 | 复盘与策展 LLM 的 model 覆盖（设置页为按 provider 分组的可搜索下拉，可清空）；留空跟随会话模型。**必须与 `reflectProvider` 同时非空才生效** |
| `maxEntries` | number / `60` | 手册最大条目数；超出后 `ace_curate` 整批拒绝并提示先合并旧条目 |

### 设置文件存在哪（跟随 profile）

**结论：设置文件落在当前 profile 目录下——`<profileDir>/dsh-ace.json`，每个 profile 各自一份；首次升级会自动从旧的 `$DSH_HOME/dsh-ace.json` 复制过来。**

设置页保存的值（不是插件行 Config）存在这个 JSON 文件里。解析链按优先级从高到低：

1. `ctx.get('profileContext').dir` —— 当前 profile 的目录（`$DSH_HOME/profiles/<name>`，官方惯例；API 出处 `dsh-app-boot\lib\types\profile-context.d.ts:10-25`）；
2. `DSH_PROFILE_DIR` 环境变量；
3. `DSH_HOME` 环境变量；
4. `~/.dsh`。

前一级缺失或为空串才落到下一级。**升级说明**：旧版本把设置写在 `$DSH_HOME/dsh-ace.json`（所有 profile 共用一份）。新版本第一次启动时，若新位置还没有文件而旧文件存在，会把旧内容**复制**到新位置并记一条日志；**旧文件原样保留，不会删除**。新位置已有文件时绝不覆盖——你在新位置写过的设置才是权威。因此升级后各 profile 会先继承旧设置一次，之后各写各的。

## 工具一览

**结论：三个模型可见工具，全部围绕手册一个文件，互不越界。**

| 工具 | 作用 | 改手册？ |
| --- | --- | --- |
| `ace_playbook` | 读手册（整本 / 按条目 id / 按短关键词过滤——query 传 1-3 个短关键词，命中任一片段即返回、按相关度（BM25）排序；matched=0 时改用整本读取） | 否 |
| `ace_reflect` | 复盘任务轨迹，产出结构化候选经验 | 否（只产出候选） |
| `ace_curate` | 候选经验增量并入（add/update/remove + LLM 去重 + 容量护栏） | 是（仅增量） |

## 深入阅读

- 架构与不变量：[DESIGN.md](DESIGN.md)
- 测试与验证：[TESTING.md](TESTING.md)
- 面向 agent 的约定：[AGENTS.md](AGENTS.md)