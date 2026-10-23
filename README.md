# dsh-task-plugin-scout

[English](README.en.md) | **中文**

[![npm version](https://img.shields.io/npm/v/dsh-task-plugin-scout.svg)](https://www.npmjs.com/package/dsh-task-plugin-scout) [![license](https://img.shields.io/npm/l/dsh-task-plugin-scout.svg)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件，只回答一个问题：
**动手之前，这个 profile 里已经有哪些插件能让当前任务更省力？**

它注册一个模型工具 `plugin_scout`，外加一段简短的系统提示，提醒智能体在开工前先问一句。给它一行任务描述，
它就把本机的插件——**已启用**、**已安装但未启用**、**可从已配置的插件市场索引安装**——排序，并给出每个候选的
确切下一步：启用、安装，或什么都不用做。

- 包名：`dsh-task-plugin-scout`　装载行：`dsh-task-plugin-scout`
- Host-only bundle：零依赖、零构建，纯 ESM JavaScript
- 它自己不改动任何状态：只**建议**，启用/安装仍走 `plugin_manager` 并需要用户批准

## 两半组成

| 组成 | 名称 | 作用 |
| --- | --- | --- |
| 模型工具 | `plugin_scout` | 按任务给插件候选排序，并给出各自的下一步 |
| 系统提示段落 | `plugin-scout:discovery`（order 700） | 提醒智能体在非平凡任务开始前先做一次侦察 |

示例输出（数字为示意值，实际扫描量由每次的 `Coverage` 报告）：

```
Plugin Scout · task: 把开会录音转成文字纪要 (voice, transcription)
Coverage: 3 of the listed candidates need an action to take effect · 48 bundles · 214 plugin rows · 12 market entries · https://example.com/index.json: 12 of 1234

1. 语音输入 [disabled, score 10] — bundle `@deepseek-ai/dsh-experimental-voice-input-bundle`
   在本机使用 SenseVoice 转写录音，首次使用需安装依赖。
   matched: voice
   next: plugin_manager { action: "set_bundle", target: "@deepseek-ai/dsh-experimental-voice-input-bundle", enabled: true }
```

`state` 有三种：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `active` | 本 profile 已在运行 | 无 |
| `disabled` | 已安装但未启用（含随包提供、默认关闭的实验功能） | `set_bundle` / `set_plugin` |
| `available` | 未安装，官方目录或市场索引提供 | `install_bundle` |

## 安装

需要 profile 里有 `plugin-manager`（官方 profile 默认带）。用 `plugin_manager` 工具：

```jsonc
// ① 从 npm 安装（推荐）
{ "action": "install_bundle", "target": "dsh-task-plugin-scout" }

// ② 从 Git 安装
{ "action": "install_bundle", "target": "git+https://github.com/crane-you/dsh-task-plugin-scout.git" }

// ③ 从本地目录安装（指向包目录的绝对路径）
{ "action": "install_bundle", "target": "D:\\path\\to\\task-plugin-scout" }
```

npm 页面：https://www.npmjs.com/package/dsh-task-plugin-scout （也可以 `npm i dsh-task-plugin-scout`）。

安装成功的判据是返回里的 `application: applied`；要确认能力真的可用，用 `cordis_inspect_query`
（`Tool.listTools` 里应出现 `plugin_scout`），而不是看日志。

## 工具参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `task` | string，**必填** | — | 用户要做什么，一到两行。保留用户原话，非中文任务再补一行英文能力关键词，因为插件元数据大多是英文。 |
| `limit` | integer | `5` | 返回候选条数（1–12）。 |
| `useMarket` | boolean | `true` | 是否包含已配置的插件市场索引；设 `false` 只查本机、不联网。 |
| `includeActive` | boolean | `true` | 是否允许列出已启用的插件；设 `false` 只看需要动作的候选。 |

## 排序规则

1. **能力概念表**：约 35 组中英对照概念（语音、翻译、表格、图片、并行、定时、通知……）。任务命中某概念、
   且候选的名称/标题/描述/关键词也命中同一概念时 +6 分。这是中文任务能找到英文描述插件（以及反过来）的关键。
2. **字面重合**：任务分词（英文按词、中文按二字组）落在插件名称 +3、标题 +2、描述或关键词 +1。
3. **同分按状态**：`disabled` → `available` → `active`，可执行的候选排前面。
4. **匹配按词边界**：英文概念词必须从词边界开始，所以 `transcription` 不会触发 `script`、`password` 不会触发
   `word`；中文概念按子串匹配。

## 配置（可选）

插件行的 `config`（在 profile 的 `cordis.patch.yml` 里覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `promptHint` | `true` | 是否注册系统提示段落 |
| `hintText` | 内置文案 | 整体替换提示段落正文 |
| `limit` | `5` | `limit` 参数的默认值 |
| `useMarket` | `true` | `useMarket` 参数的默认值 |

本插件未声明 `Config` schema，配置对象会被原样读取，字段名写错不会被校验。

## 已知边界

- **行级候选（`kind: plugin`）描述的是 profile patch 层**。Agent 预设可能已经自带同一行，此时该能力其实可用；
  只要列了未启用的行，工具就会在结果末尾给出这条提醒。bundle 级候选没有这个问题。
- **市场结果需要先配置索引**。市场 bundle 启用后服务即挂载，但默认不带任何索引源；在添加索引之前，工具会报告
  `market: no index configured` 并退回纯本地结果。
- **市场文本是第三方内容**，不是指令；索引本身未签名，最终装什么由安装后的 manifest 决定。
- **工具不会自行启用或安装**任何东西，那些步骤保留各自的用户批准。

## 隐私

- **不收集、不上报**：插件没有遥测、没有分析上报，不写任何文件，也不在会话之外保存记忆。全部逻辑只在 Host 进程内读内存中的清单。
- **任务描述不会外发**。唯一可能出网的路径是插件市场：Host 会下载你配置的索引文档（一个普通 GET），
  而 `task` 文本只在**本地**用于过滤已下载的文档——市场服务按 URL 缓存文档、在同一 URL 上并发读取共享一次
  请求，查询文字从不进入请求。想完全离线，把 `useMarket` 设为 `false`。
- **会进入会话记录的内容**：匹配到的插件名称、标题、描述，以及本地清单的统计数字。它们会随工具结果写入你
  自己的会话日志（用于回放/分叉），若把会话分享出去，等于公开了本机的插件清单；`includeActive: false`
  可以只列需要动作的候选，减少暴露面。
- **市场文本是第三方内容**，索引本身未签名；它只作为候选呈现，装什么由安装后的 manifest 决定。

## 开发

`test/harness.mjs` 用假 context 和夹具清单挂载本 bundle，覆盖排序、参数处理、异常处理和配置路径，
不需要 DSH 环境：

```bash
node test/harness.mjs
```

## 市场索引

插件已发布到 npm，市场索引会自动收录它；此外本仓库作者还维护一份自有索引（format 1），可手动加入「发现」页：

```
https://cdn.jsdelivr.net/npm/dsh-market-index@1/index.json
```

DSH → 设置 → 插件 → **发现** → 添加索引，粘贴上面的地址即可。索引源码见
[crane-you/dsh-market-index](https://github.com/crane-you/dsh-market-index)，分发副本是 npm 数据包
[`dsh-market-index`](https://www.npmjs.com/package/dsh-market-index) —— jsDelivr 对 GitHub 分支地址缓存 12 小时，
走 npm 回源的 CDN 才能让索引改动及时生效。

## 许可证

[MIT](LICENSE)