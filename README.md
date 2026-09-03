# Kiro Chat Search

![Kiro Chat Search 效果图](./kiro_chat_search.png)

[![GitHub 仓库](https://img.shields.io/badge/GitHub-meicuode%2FKiroChatSearcher-181717?logo=github)](https://github.com/meicuode/KiroChatSearcher)
[![CI](https://github.com/meicuode/KiroChatSearcher/actions/workflows/build.yml/badge.svg)](https://github.com/meicuode/KiroChatSearcher/actions/workflows/build.yml)
[![最新 Release](https://img.shields.io/github/v/release/meicuode/KiroChatSearcher?sort=semver)](https://github.com/meicuode/KiroChatSearcher/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

作者 [@meicuode](https://github.com/meicuode)

在 Kiro（VSCode 衍生产品）中按关键词搜索**当前打开项目**的对话历史，点击结果直接跳转到对应会话。扩展自动识别本机 Kiro 用户数据目录与对话存储根目录，提供左侧活动栏入口与居中搜索面板，完全本地运行、零网络依赖。

## 功能概述

- 自动识别本机 Kiro 用户数据目录与对话存储根目录（Windows / macOS / Linux）
- 自动定位**当前工作区**对应的会话子目录，搜索默认只覆盖当前项目
- 左侧活动栏入口，点击即可在编辑器中央打开搜索面板
- 实时搜索（同时覆盖会话标题与消息内容），最多展示 10 条结果，按修改时间倒序
- 每条结果显示该对话的**真实 credit 消耗**（来自 Kiro 执行记录），查不到时回退展示上下文占用百分比
- 命中关键词高亮显示、上下键选择、Enter 跳转、Esc 关闭、120ms 输入防抖
- 存储占用统计：分类构成、单个会话占用、孤儿执行存档合计，全部**只在用户显式触发时**才扫描磁盘
- 占用排行页：按占用高低分页展示当前项目全部会话，标题可点击直接打开该对话，并提供逐会话的附件清理 / 全量清理入口
- 设置页（过滤条右下角齿轮）：开关「在对话过程中显示耗时」，并能检测该设置**实际是否生效**、一键重试与重载窗口
- 待确认提醒：Kiro 等你批准工具调用时，在**窗口标题**前加 🔴（任务栏/Alt+Tab 可见，标记可配）并在状态栏提示，多开时一眼看出是哪个窗口卡着
- 完成提醒：你离开期间任一会话跑完一轮，标题前加 ✅，聚焦该窗口后消失；与 🔴 可并存，两个 emoji 都可在设置里换
- 完整的环境校验和友好的中文错误提示
- 安全：Webview 使用 `default-src 'none'` + nonce 的 CSP，所有动态内容经 HTML 转义

## Kiro 1.x 存储适配（与 0.9x 双版本兼容）

Kiro 从 0.9x 升级到 1.x 后聊天历史的磁盘布局被整体重写。本扩展**同时支持两套布局**，
并在界面上标出每条会话的来源。以下内容均为本机实测（Kiro 1.0.337 / kiro-agent 1.0.653）。

### 两种目录结构

| | 0.9x | 1.x |
| --- | --- | --- |
| 会话根 | `<UserDataDir>/User/globalStorage/kiro.kiroagent/workspace-sessions` | `~/.kiro/sessions` |
| 工作区目录名 | `base64url(workspacePath)` 变体 | `WsHash16` |
| 单个会话 | 一个文件 `<sessionId>.json` | 一个**目录** `<sessionId>/` |
| 会话内容 | 该 JSON 文件 | `session.json` + `messages.jsonl` + `snapshots/` + `sub-executions/` + `publish*.cursor` |
| 会话清单 | `sessions.json` | 无（改为 `~/.kiro/session-index/<WsHash16>.jsonl`，仅计量、不作枚举来源） |
| 执行存档 | `<StoreRoot>/<WorkspaceId>/<bucket>/<hash32(executionId)>` | 就在会话目录内的 `snapshots/` |
| 用量数据 | 存档文件里的 `usageSummary` | `messages.jsonl` 的 `usage_summary` 事件 |

### 两种工作区哈希不通用

```
1.x：WsHash16   = sha256( workspacePath.replace(/\\/g,'/').toLowerCase() ) 的前 16 位十六进制
0.9x：WorkspaceId = sha256( 原始 workspacePath ) 的前 32 位十六进制（不做任何归一化）
```

两者**既换了摘要长度也换了归一化规则**，不可互相推导。实测基线：
`d:\Projects\KiroExt\KiroChatSearcher` → `cc5023603866cd91`，
`d:\SurErp\ERP-OMS-Workspaces` → `6082f0c94c5c4af8`。

> 迁移标记文件里的 `workspaceHash` 用的是**旧**算法（`sha256(原始路径)` 前 16 位），
> 与 1.x 的目录名不是一回事，**不能**拿它去定位新目录。

### 四种布局下的行为

扩展启动时判定当前工作区属于哪一种布局，依据是「1.x 工作区目录下是否含至少一个会话子目录」
与「0.9x 工作区目录下是否含至少一个 `<sessionId>.json`」两个条件的组合：

| 布局 | 含义 | 行为 |
| --- | --- | --- |
| `both` | 两侧都有会话 | 合并两侧、按 sessionId 去重（新格式优先）；占用统计同时计量两处 |
| `new-only` | 只有 1.x | 只读新目录；旧残留维度仍展示（可能有别的工作区的残留） |
| `old-only` | 只有 0.9x（通常是没升级） | 只读旧目录；跳转追加 0.9x 降级候选；**隐藏**旧残留维度（此时旧目录即主数据） |
| `none` | 两侧都没有 | 「当前项目还没有 Kiro 对话历史」，面板结构不变 |

状态条 tooltip 会直接显示当前布局与两侧目录，这是判断"扩展在读哪一版数据"最快的入口。

### 会话来源（SessionOrigin）

搜索结果与占用排行的每一行都带一个来源标记：

| 取值 | 标签 | 判定依据 |
| --- | --- | --- |
| `new` | 1.x | 位于 1.x 会话目录且 sessionId 以 `sess_` 开头 |
| `migrated` | 已迁移 | 位于 1.x 会话目录但 sessionId 是裸 uuid；或旧目录里存在 `v2SessionId` 指向它的迁移标记；或同一 sessionId 在新旧两处各有一份 |
| `legacy-unmigrated` | 未迁移 | 只存在于 0.9x 旧目录 |

> **「未迁移」的会话在 Kiro 1.x 界面中不可见**，点它可能打不开。1.x 的官方迁移是
> **用户手动触发**的（见 kiro.dev/changelog/ide/1-0-52），因此升级后旧会话不会自动搬走。
> 需要继续对话请先在 Kiro 内手动迁移；这类数据删除后无法恢复，所以旧残留清理默认把它排除在外。

### credit 用量

1.x 的用量已并入 `messages.jsonl`：逐行取 `payload.type === 'usage_summary'` 的事件，
累加其中 `unit` 不区分大小写等于 `credit` 的数值；工具使用记录等非 credit 单位项被排除。
0.9x 的 `hash32(executionId)` → 独立存档文件查表在 1.x 上**完全失效**，故那条路径的适用范围
已收窄到 0.9x 会话。

**1.x 会话的 `Σ` 开关不改变数值**，两种口径取同一值。原因是 1.x 的快照按会话目录物理隔离，
不存在跨会话继承，累计口径无从产生差异。角标 tooltip 会写明这一点，以免被理解成开关失效。
没有任何 `usage_summary` 事件时该条用量标记为不可用、角标被省略，其余结果不受影响。

### 占用分类（新增 4 类）

| 分类 | 对应磁盘位置 |
| --- | --- |
| 新格式会话 | `~/.kiro/sessions/<工作区哈希>/<会话 id>/`（含 `session.json`、`messages.jsonl`、`publish*.cursor`） |
| 新格式快照 | `~/.kiro/sessions/<工作区哈希>/<会话 id>/snapshots/` |
| 新格式子执行 | `~/.kiro/sessions/<工作区哈希>/<会话 id>/sub-executions/` |
| 新格式索引 | `~/.kiro/session-index/<工作区哈希>.jsonl` |

1.x 单个会话的占用 = 该会话目录内全部文件字节数之和。排行页的两个字节列被映射为
「会话本体」（`session.json` + `messages.jsonl` + 其余文件）与「快照/子执行」，合计恒等于两者之和。

### 排行表之上的三个维度

| 维度 | 口径 | 触发方式 |
| --- | --- | --- |
| 当前项目会话总占用 | 本工作区全部会话自身占用之和 | 随排行数据一同得出（**同一次枚举**，不额外扫描） |
| 整个 Kiro 会话总占用 | `~/.kiro/sessions` 下全部工作区目录 | **手动触发** + 缓存；`old-only` 时回退扫 `workspace-sessions` |
| 旧格式残留 | 0.9x 旧目录里仍在占盘的数据 | **手动触发** + 缓存；与上一项相互独立，默认**不**计入 |

旧残留之所以独立成一个维度：本机实测约 3.6 GB / 7735 文件 / 7 个工作区，把它并进
「整个 Kiro」会让每次统计都背上这份重量级扫描。**未触发前对应目录一次都不会被枚举。**

`≥` 前缀只在该维度自己存在被跳过条目时出现，表示数值为下限；tooltip 里给出跳过条目数。

### 点击标题打开对话

排行页每行的**会话标题是链接**：点击（或 Tab 聚焦后按 Enter / Space）即打开该会话，
走的是与搜索结果点击**完全相同**的跳转候选链，失败提示也一致。点开后排行页保持打开，
当前页码与排序方向不变，方便接着看下一条。

实现上刻意**不用** `<a href>`：本页不做任何导航，sessionId 不进入任何 URL，因此既没有
可被"复制链接地址"的面，也不需要放宽 CSP（仍是 `default-src 'none'` + nonce，无内联事件处理器）。
跳转参数里的标题与会话格式取自扩展**自己刚下发的那批行**，而非 webview 回传的值。

统计中 / 空态 / 未打开工作区 / 统计不可用这四种状态下，标题退回普通文本、不可点击。
跳转失败只写一行审计日志，不会把整页打成不可用。

> 「Kiro: 存储占用分析」输出的是**纯文本报告**（写入输出通道），输出通道不支持可点击的
> 命令链接，因此那份报告里的会话排行无法点击打开——需要点击就用排行页。

### 清理

| 模式 | 0.9x | 1.x |
| --- | --- | --- |
| 附件清理 | 删除按 `chatSessionId` 归因的执行存档 | 删除会话目录内 `snapshots/` 与 `sub-executions/` 的文件，**保留** `session.json` 与 `messages.jsonl` |
| 全量清理 | 存档 + `<sessionId>.json` + 从 `sessions.json` 移除条目 | 删除**整个会话目录**（含消息记录与全部快照），随后移除已清空的目录 |
| 旧残留清理 | — | 只删「已迁移仅残留」部分；**「未迁移」默认排除**（1.x 里看不见，删了不可恢复） |

**删除不可撤销，被删文件不进回收站。** 每次清理前弹模态确认（「取消」为默认按钮），
并在删除**前后各写一次**审计到「Kiro 存储占用」输出通道，内容含会话格式、每个被删文件的
绝对路径与字节数、每个失败/跳过项的原因，以及三类计数。

### 只读与可写边界

除 `src/storage/cleaner.ts` 外，**全部模块只读磁盘**（只做目录枚举、`stat`、读文件），
且在模块依赖图上连写 API 的 `import` 都不存在——这一点由属性测试静态审查源码来保证，
不是注释里的承诺。

`cleaner.ts` 的可写 API 白名单：

| API | 实参范围 |
| --- | --- |
| `unlink` | 恒 ⊆ 计划已枚举的具体文件 |
| `rmdir`（**非递归**） | 规范化后位于 `~/.kiro/sessions` 之内、等于目标会话目录或其子目录，且删除前**重新枚举确认为空** |
| `readFile` / `writeFile` | 只对 0.9x 的 `sessions.json` |
| `lstat` / `readdir` | 计划快照、TOCTOU 复核与 `rmdir` 前的复核 |

递归删除（`rm` / `rmSync` / `rmdirSync` / `rimraf`）、`rename`、`cp`、`copyFile`、`mkdir`
一个都没有导入。选非递归 `rmdir` 而非 `rm -r` 的关键理由：**它删不掉非空目录**，
所以即便实参校验被绕过，最坏后果也只是一次失败而不是数据丢失。

### 统计只在显式动作时执行

只有这些动作会触发全量枚举：左键点击占用统计按钮、打开/翻页/刷新占用排行页、
触发「整个 Kiro」或「旧格式残留」维度、执行「Kiro: 存储占用分析」命令、以及一次清理结束后的刷新。

面板变可见、输入关键词、切换附件过滤**都不会**触发占用枚举。

## 对话过程中显示耗时（TurnTimerPatch）

Kiro 自带的对话面板**只在一轮结束后**才显示 `Elapsed time`（数据来自 `messages.jsonl`
的 `usage_summary.elapsedTime`）。AI 还在输出时没有任何耗时显示。本扩展补上这段空窗：
开启后，消息流底部会实时显示本轮已耗时，一轮结束即消失、交回 Kiro 原生那一行。

入口：搜索面板过滤条**右下角的齿轮**，或命令 `Kiro: 对话搜索设置`（`kiroChatSearch.settings`）。

### 为什么需要打补丁

对话面板是 `kiro.kiro-agent` 扩展提供的 webview（`kiroAgent.chatView` /
`kiroAgent.standaloneChatView`），UI 是 Vite 打出来的 React 应用。VSCode 扩展 API
**没有**往别的扩展的 webview 里注入内容的口子，所以只能改它磁盘上的产物。

### 具体改了什么

```
<Kiro>/resources/app/extensions/kiro.kiro-agent/packages/kiro-ui-agent-chat/dist/
  kcs-turn-timer.js          # 新增：注入的 ES module（内容 = 本仓库 media/kcs-turn-timer.js）
  session-manager/main.js    # 末尾追加一行 import；追加前整份备份为 main.js.kcs-orig
  session-view/main.js       # 同上
  standalone/main.js         # 同上
```

三个入口对应三个界面，都要打：

| 入口 | 界面 | 视图 / 来源 |
| --- | --- | --- |
| `session-manager` | **侧边栏**对话面板（日常用得最多） | `kiroAgent.chatView` |
| `session-view` | 编辑器分栏里打开的单会话面板 | `buildEditorPanel` |
| `standalone` | 独立对话窗口 | `kiroAgent.standaloneChatView` |

这点很容易搞错：`AgentChatViewProvider` 的 `entryPoint` **默认值**是 `session-view`，
但侧边栏那个 provider 是显式用 `entryPoint:"session-manager"` 构造的。只打
`session-view` 的话，编辑器分栏和独立窗口有效、而侧边栏毫无反应。

入口文件是几百字节的 ESM loader，补丁只在末尾追加

```js
import "../kcs-turn-timer.js"; /* kcs-turn-timer */
```

其余字节一个都不动。样式走内联 `<style>`（面板 CSP 的 `style-src` 含 `'unsafe-inline'`），
所以 `dist/style.css` 完全没被碰过。

三个核对过的事实（Kiro 1.0.337）：

- **CSP 放行**：面板 `script-src` 是 `<webview.cspSource> 'nonce-…' 'wasm-unsafe-eval'`，
  cspSource 覆盖整个 webview 资源源，同目录 ESM import 无需 nonce
- **不触发「安装似已损坏」**：`product.json` 的 `checksums` 只覆盖 6 个核心 workbench
  文件，不含任何扩展 bundle
- **可还原**：优先拷回 `.kcs-orig` 备份（字节精确）；备份丢了则按标记摘掉那一行

### 显示位置与兜底

计时行插在消息流滚动容器 `.session-view-content` 的末尾，复用 Kiro 自己的
`kiro-turn-usage-summary` 类名，所以间距、字号、颜色与原生那行一致。

找不到该容器时（Kiro 改版换了类名，或面板尚未挂载完）**不会消失**，而是退化成右下角
的浮动小徽标，并在控制台打一条锚点告警；容器随后出现时会自动升级回行内显示。
这么做是为了让「锚点失效」的症状是「位置怪」而不是「彻底看不见」——后者会让人
误以为补丁没生效，无从下手排查。

已知限制：Kiro 的 DOM 里没有任何带 sessionId 的标记，因此多会话并行跑时，计时行会
出现在**当前可见**的那个会话的消息流底部，不一定是正在跑的那个。单会话无此问题。

### 怎么排查

注入脚本跑在 Kiro 自己的 webview 里，**从扩展侧看不到它的任何输出**（控制台不落盘、
也拿不到那边的 DOM）。所以它自带一个诊断快照：命令面板 →
`Developer: Open Webview Developer Tools`，在控制台敲

```js
__kcsTurnTimer
// { version: 2, hooked: true, hookError: '', turns: 3, anchor: 'inline', running: 0 }
```

- `hooked: false` → 钩子没装上，`hookError` 说明原因（实时耗时一定不会出现）
- `turns: 0` 而你已经发过消息 → RPC 形态变了，`prompt` 请求没被认出来
- `anchor: 'floating'` → 锚点类名失效，已退化成右下角浮动显示
- 脚本就绪 / 失败时也会各打一条 `console.info` / `console.error`

### 钩子为什么是「替换 window.vscode」而不是「包一层 postMessage」

`acquireVsCodeApi()` 返回的是 **`Object.freeze({postMessage, setState, getState})`**
（见 vscode 的 webview preload）。所以 `window.vscode.postMessage = wrapper`
在严格模式下抛 `TypeError: Cannot assign to read only property`、非严格模式下静默失败
——两种都装不上钩子。这个坑很隐蔽：代码看着对、不报错、就是不工作。

`window.vscode` 本身只是 HTML 内联脚本赋的普通全局属性（可写），因此改成**整体替换成
一个转发 shim**，逐个转发原对象的成员，参数用 `...args` 原样透传
（`postMessage(message, transfer)` 有第二个参数）。三个入口的 bundle 都是
`n => window.vscode.postMessage(n)` ——**调用时**才读 `window.vscode`，而注入模块作为
`import` 会在宿主 bundle 的模块体之前求值，所以它们看到的就是 shim。

### 怎么判断一轮的起止

不猜 DOM、不碰 React 内部状态，而是监听 webview ↔ 扩展的 RPC：

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| webview → 扩展 | `{type:'request', id, key:'prompt', …}` | 轮开始 |
| 扩展 → webview | `{type:'response'\|'error', id, …}` | 轮结束 |

`prompt` 是长活 RPC——扩展侧直接 `return client.prompt(...)`，要到整轮出 stopReason
才 resolve；面板自己也是 `setAgentActive(true)` → `await ("prompt", …)` →
`finally { setAgentActive(false) }`。所以这两个信号的精度等于 Kiro 自己的
agentActive，且不依赖 minified 代码里的任何符号名。中途 steer 不重置计时，
点停止也无需特殊处理。

### 「设置了」与「生效了」是两件事

对话面板是 webview，**只在创建时读一次**入口文件。所以写完补丁必须重载窗口才会跑起来。
设置页因此把两件事分开呈现：

- **意图**：开关状态，存在 `globalState`（键 `kiroChatSearch.turnTimer.enabled`，缺省为开）
- **实况**：每次都真读磁盘（不缓存——Kiro 可能在两次询问之间升级并抹掉补丁）

状态行的五种结论：`已生效` / `已写入，重载窗口后生效` / `只注入了一部分` /
`未生效：补丁不在了` / `已关闭`。需要时给出「重试」与「重载窗口」按钮。
「重试」= 按当前意图重跑一次，因此意图为「关」而磁盘上有残留时，它是清除入口。

### 自动写入的时机

扩展启动时（`onStartupFinished`）若「意图为开而实况没到位」就写一次。这同时覆盖
两种情形，无需维护版本号比对：

- 插件首次安装（意图缺省为开）
- Kiro 升级覆盖了 dist、抹掉了补丁

**首次真正写入**时会弹一条非模态提示（带「重载窗口」/「打开设置」/「不需要」），
之后若无改动则静默。写入失败按错误签名去重提示，只读安装目录不会变成每次启动的噪音。
在设置页关掉后 `globalState` 记为 `false`，后续启动不再自动写。

## 待确认提醒（PendingApproval）

Kiro 需要批准某个工具调用时会推一条 IDE 内通知，但那条通知会自动消失、也不告诉你是
**哪个**窗口在等。开着好几个 Kiro 时，经常一小时后才发现第一步都没做完。

开启后（默认开），只要 Kiro 在等你确认：

- **窗口标题**前加 🔴 → 出现在 Alt+Tab、任务栏悬停预览，以及任务栏按钮文字上
- **状态栏**左侧显示 `🔔 待确认`（警告底色），悬停看具体在问什么
- 确认后自动还原

另有一个**完成提醒**：你不在看的时候任一会话跑完一轮，标题前加 ✅；**聚焦该窗口后消失**。
两者可并存，此时 ✅ 在前：`✅ 🔴 我的项目 - Kiro`。语义不同——✅ 是「有结果了，回来看看」，
🔴 是「卡着等你点」。

配置：`kiroChatSearch.pendingApproval.enabled`（默认 `true`）、
`kiroChatSearch.pendingApproval.titleMark`（默认 `"🔴 "`）、
`kiroChatSearch.pendingApproval.doneMark`（默认 `"✅ "`）。

### 完成提醒的三个判定细节

1. **只在窗口无焦点时才亮。** 你正盯着屏幕看它跑完，不需要提醒（`window.state.focused`）。
2. **首次扫描只建立基线。** 否则一打开窗口，每个会话历史上的最后一轮都会被当成
   「刚刚跑完」，标题立刻挂一个假的 ✅。
3. **多会话按「任一完成就亮」。** 你关心的是有东西跑完了，而不是所有会话都停了；
   后者在多会话下几乎永远等不到。

「轮结束」的身份取 `turn_end` 事件的 **id**（退回时间戳）而不是计数：MessagesFile 只读
尾部 512KB，文件长大后窗口会往后滑动、窗口内的 `turn_end` 条数**可能减少**，拿计数比对
会误判。

### 标记为什么用 emoji、用哪个

实测 Windows 窗口标题按 UTF-16 **原样保留 emoji**——对 Kiro 主窗口做
`SetWindowTextW` → `GetWindowTextW` 往返，🔴 🔔 ✋ ❗ ⏳ ⚠️ 🟠 👉 八个候选写入读回
完全一致（含 `U+26A0 U+FE0F` 这种带变体选择符的组合）。

选择建议的依据是**尺寸**：任务栏按钮上的可视高度只有十几像素，此时纯色块比线条图形
好认得多，有内部结构的图形会糊成一团。

| 标记 | 说明 |
| --- | --- |
| `🔴 ` | 默认。实心红点，小尺寸下最醒目，语义就是「要你处理」 |
| `🟠 ` | 同样是纯色块，但不那么刺眼 |
| `❗ ` | 红色且窄，标题很长时省空间 |
| `🔔 ` | 语义最贴「通知」，但小尺寸下细节会糊 |
| `✋ ` `⏳ ` | 偏「等待」语气 |
| `⚠️ ` | 带变体选择符，个别字体下会渲染成单色 |
| `* ` | 纯文本，最保守 |

结尾没有空格会自动补一个（否则渲染成 `🔴Kiro …`，emoji 和文字黏在一起）；留空退回默认。
换标记时旧前缀可能还留在别的工作区配置里，因此清理残留时会把历史标记一并尝试摘除。

### 怎么知道 Kiro 在等确认

不与 kiro-agent 通信（两个扩展的 webview / 扩展实例之间没有通道），而是读它自己写的
`messages.jsonl`。里面有一对按 `toolCallId` 配对的事件：

```jsonc
{"payload":{"type":"pending_interaction","interactionType":"tool_approval",
            "toolCallId":"toolu_…","question":"Load skill: item","options":[…]}}
{"payload":{"type":"interaction_resolved","toolCallId":"toolu_…",
            "outcome":"selected","selectedOption":"always-accept"}}
```

判定「仍在等待」要两个条件同时成立：

1. 没有同 `toolCallId` 的 `interaction_resolved`
2. 该 `pending` 之后没有出现 `turn_end`

第 2 条是**防幻影**的关键：进程被杀、窗口被关、整轮被取消，都会留下永远等不到
`resolved` 的 `pending`。少了它，标记会永久挂在标题上摘不掉。

只读文件**尾部 512KB**：`resolved` 恒在其 `pending` 之后，所以尾窗口里出现的
`pending`，它的 `resolved`（若有）必然也在同一窗口或更靠后——截尾不会把「已处理」
误判成「在等」。实测最大 66MB 的会话文件也不会误报。

### 为什么是窗口标题

`window.title` 是唯一能触及 Windows 任务栏的合法手段。实测 Kiro 的操作系统窗口标题
就是该模板的渲染结果：

```
tasks.md (Working Tree) (tasks.md) - KiroChatSearcher - Kiro
```

扩展 API 里**没有**设置任务栏图标叠加（overlay icon）的口子——那是 Electron 的
`setOverlayIcon` / `setBadgeCount`，没有暴露给扩展。

`*` 是否直接显示在任务栏按钮上，取决于系统的「合并任务栏按钮」设置
（`HKCU:\…\Explorer\Advanced\TaskbarGlomLevel`）：`0`（总是合并）时只能悬停看到，
`1`/`2` 时任务栏有文字标签，`*` 直接可见。Alt+Tab 与悬停预览则始终可见。

### 作用域与还原

标记写 **Workspace** 作用域：写 Global 会让所有 Kiro 窗口一起变标记，恰好破坏了
「多开时分得清」这个目的。代价是等待期间 `.vscode/settings.json`（打开的是
`.code-workspace` 时则写进那个文件）会出现一处临时改动。

还原策略刻意**不依赖任何持久化的原值**：摘掉标记后，若结果与 global/default 层级
相同就**删除**工作区层级的键，让配置回到「我们没来过」的样子；否则写回摘标记后的值
（说明用户自己在工作区层设过标题）。因此即使进程被杀、globalState 丢失，也不会留下
一个凭空写出来的键。扩展启动时还会主动清理上次遗留的 `*` 前缀。

## 激活方式

- **活动栏入口**：左侧活动栏的 Kiro Chat Search 图标，点击后在入口面板按"🔍 打开搜索"
- **快捷键**：`Ctrl+Alt+K`（Windows / Linux）/ `Cmd+Alt+K`（macOS）打开居中搜索面板
- **折叠/展开**：`Ctrl+Alt+J`（Windows / Linux）/ `Cmd+Alt+J`（macOS）一键收起或聚焦侧边栏搜索视图，编辑代码时腾出空间
- **命令面板**：执行命令 `Kiro: 搜索对话历史`（`kiroChatSearch.openSearch`）或 `Kiro: 折叠/展开对话搜索`（`kiroChatSearch.toggleView`）
- **设置页**：过滤条右下角齿轮，或命令 `Kiro: 对话搜索设置`（`kiroChatSearch.settings`）

## 搜索规则

- **空关键词**：默认按修改时间倒序展示最近 **20 条**对话；每条预览取自首条用户消息（截断到 160 字符）。打开面板或清空输入时立即重新加载。
- **有关键词**：以**不区分大小写**的子串方式匹配；先匹配会话标题，标题未命中再扫描消息内容
  - 标题命中时片段为标题本身；消息命中时截取命中位置前后各约 80 字符的上下文，连续空白折叠为单个空格
  - 最多返回 **10** 条结果
- 结果按会话文件的修改时间（`mtimeMs`）**倒序**排列
- 搜索框输入有 120ms 防抖，停止输入后才触发一次请求
- 搜索框有内容时右侧显示清空（✕）按钮，点击或按 `Esc`（有内容时）即可清空并回到最近列表

## 按附件 / 图片过滤

搜索框下方有三个过滤标签：**全部** / **🖼 含图片** / **📎 含附件**。

- **含图片**：仅展示包含内嵌图片的对话（消息 content 中存在 `imageUrl` 或 `type` 含 `image` 的项）
- **含附件**：仅展示引用了文件上下文的对话（消息项的 `contextItems` 为非空数组，即 @ 进来的文件等）
- 结果项右上角会用 🖼 / 📎 角标标注该会话是否含图片 / 附件
- 切换过滤标签时会先在已加载结果上即时过滤，同时请求按当前关键词重新取数（确保过滤作用于**最新**会话数据，含面板打开后新增的对话）；切换关键词后会在新结果上沿用当前过滤条件
- 过滤后无结果时状态条提示"没有符合条件的对话"

过滤标签行右侧固定有一个**刷新按钮**：在不改关键词、不切换标签时，点击即按当前条件重新取数，用于查看最新的对话与对应的 credit 统计。它走与切换标签相同的 `(mtime, size)` 失效校验，因此能反映磁盘最新状态，但不会清空仍然有效的缓存。

> 图片检测只看标志字段、**不读取也不比对 base64 图片内容**，因此即便对话里嵌了大图也很快。

## 性能：会话索引缓存

为避免每次输入都把目录里所有会话重新读盘解析，扩展维护一个**进程内索引缓存**：

- 首次扫描后，每个会话只缓存匹配/展示所需的精简数据（标题、纯文本、是否含图片/附件），**内嵌的 base64 图片数据不会进入缓存或匹配范围**
- 后续搜索 / 过滤 / 最近列表只对 `mtime` 或文件大小 `size` 发生变化的文件重新解析，未变更的直接复用缓存（仍在增长的对话因 mtime 与 size 都会变化，能稳定刷新）
- 文件被删除时对应缓存条目自动清理；缓存仅存于内存，扩展停用即释放
- 缓存只影响性能，**不改变相同输入下的搜索结果**

## 对话 credit 消耗

每条搜索结果的右上角会显示该对话的用量角标：

- **`💳 70.31`**：该对话的**真实 credit 消耗**（hover 可见四位精度）。这是 Kiro 计费口径的权威值，由服务端返回，不是本地估算。
- **`◷ 24%`**：当真实 credit 不可用时的**回退**，展示会话的上下文窗口占用百分比（Kiro 本地估算，写在会话 JSON 顶层的 `contextUsagePercentage`）。
- 两者都拿不到时不显示角标。

### 两种 credit 口径（`Σ` 开关）

过滤标签行右侧的 **`Σ` 切换**控制 credit 角标的统计口径，状态会被记住：

- **`Σ 自身`（默认，方案 C）**：只统计该会话**自身**消耗（`chatSessionId == 本会话` 的执行）。每个 checkpoint 快照显示各自实际新增的 credit，互不重复，便于直观看清每段对话真正花了多少。
- **`Σ 累计`（方案 A）**：显示**整段对话的累计**消耗（含 checkpoint 祖先链）。打开任一 checkpoint 都能看到整条对话到该快照为止的总成本；hover 提示里同时给出"本快照新增"。

> 因为一条 spec 常被 checkpoint 切成多条会话记录：自身口径下它们各显增量（某些"只存档没干活"的快照可能为 0 → 回退显示上下文%）；累计口径下越靠后的快照数值越大，最后一个等于整条对话总消耗。

### credit 数据从哪来

Kiro **不会**把 credit 写进对话历史 JSON——会话文件只保留对 `executionId` 的引用。真正的用量存在一份**独立的执行存档**里，由 Kiro 扩展的 `ExecutionLogController` 通过 `WriteBackCache` 落盘：

```
<UserData>/User/globalStorage/kiro.kiroagent/<workspaceId>/[<hash("KIRO::EXECUTION::SAVES")>/]<hash(executionId)>
```

- 目录名与文件名都是 **`sha256(key)` 十六进制的前 32 位**。其中 **`workspaceId = sha256(工作区 fsPath)`**——据此可直接定位当前工作区的执行存储目录。
- 每个执行存档是一份 JSON，含 `chatSessionId`（该执行所属会话）与末尾的 `usageSummary` 数组，credit 项形如：

  ```json
  { "usage": 0.00972499529021559, "unit": "credit", "unitPlural": "credits" }
  ```

  数组里还会混入 `{ "usedTools": [...] }` 等非 credit 项，需按 `unit === "credit"` 过滤。
- 该存档是 **LRU 缓存（上限约 500 条执行）**，较老的执行会被淘汰，因此并非所有历史对话都还查得到 credit——这也是回退到上下文百分比的原因。

### 为什么按 `chatSessionId` 关联（而非 history 的 executionId）

普通对话里 `history[].executionId` 直接指向带 `usageSummary` 的执行，按它反查即可。但 **spec / checkpoint 会话**不同：创建检查点时 Kiro 会 `migrateExecutionToSession` 迁移执行，结果是 checkpoint 会话 `history` 引用的执行变成**没有 usageSummary 的迁移记录**，真正消耗 credit 的执行改以 `chatSessionId` 标记。因此扩展统一**按 `chatSessionId == 会话 sessionId` 汇总**，对普通对话与 spec/checkpoint 都成立。

### credit 计算算法

扩展按以下步骤汇总单个对话的 credit（实现见 `src/credits.ts`）：

1. **限定扫描范围**：由会话顶层的 `workspacePath` 算出 `workspaceId = sha256(路径)[:32]`（覆盖盘符大小写/斜杠变体），只扫描该工作区对应的存储目录，避免遍历其它工作区的大量大文件。
2. **解析执行存档**：遍历目录下 hex 命名的存档，提取每个的 `chatSessionId` 与 credit。利用"`chatSessionId` 在文件头、`usageSummary` 在文件尾"的规律**只读头部 + 尾部**，头部找不到 `chatSessionId`（或尾部数组被截断）时才整读兜底——避免读入多 MB 的 `operations`。
3. **切出用量数组**：用**字符串感知的括号配对**锚定真正的 `"usageSummary":[…]` 字段，并取**最后一个**匹配（真字段在 operations 之后、接近文件末尾），避免误取正文里出现的 “usageSummary” 词。
4. **求和**：累加 `unit === "credit"`（大小写不敏感）项的 `usage`，得到该执行的 credit。
5. **按会话汇总（两种口径）**：把所有 `chatSessionId` 命中目标会话的执行 credit 相加得到**自身消耗**；并顺会话 `history[].executionId` 反查这些执行所属的 `chatSessionId`，把 checkpoint 的**祖先会话**一并纳入得到**整段累计**。两个值都随结果下发，由 UI 的 `Σ` 开关选择展示（默认自身）。
6. **缓存**：单个执行存档的解析结果按 `(mtime, size)` 缓存；目录扫描带 4s 节流。

> 该汇总等同于把 Kiro 聊天界面里每一轮的 “Est. Credits Used” 相加。credit 只读不写，整个过程不联网。

### 刷新时机与缓存

credit 不单独刷新，而是**挂在每次搜索/列表请求上**：与会话搜索同源触发——输入关键词（120ms 防抖）、清空输入、切换附件过滤（`revalidate`）、面板重新可见或侧边栏切回（`refresh`）、点击刷新按钮时，都会为**当前展示的结果集**（搜索 ≤10 条、最近 ≤20 条）重算 credit，不做全量扫描。

缓存分两层，失效判据不同：

- **执行存档解析结果**：按文件的 `(mtime, size)` 判失效。文件变化（对话进行中 `usageSummary` 被追加，mtime/size 均变）→ 重新解析；未变 → 复用缓存值。
- **目录文件名索引**：带 **4 秒节流**，避免每次输入都重扫整个工作区存储目录。

> 与会话索引缓存一样，这些缓存仅存于扩展**进程内存**，扩展停用即释放；重新打开后首次搜索会重新扫描。

## 跨平台路径规则

| 平台 | Kiro 用户数据目录 |
| --- | --- |
| Windows | `%APPDATA%\Kiro`（缺失时回退 `<home>\AppData\Roaming\Kiro`）|
| macOS | `~/Library/Application Support/Kiro` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Kiro` |

会话存储根目录：

```
<UserData>/User/globalStorage/kiro.kiroagent/workspace-sessions/<base64url(workspacePath)>/<sessionId>.json
```

### WorkspacePath 编码规则

当前工作区的绝对路径被编码为目录名，规则为 `base64(utf8(workspacePath))` 后：

- 将 `+` 替换为 `-`
- 将 `/` 替换为 `_`
- 将 `=`（padding）也替换为 `_` —— 注意是**替换为 `_`，不是删除**

> 这是 Kiro 实际使用的 base64url 变体，与标准 RFC 4648 的"删除 padding"不同。
> 对于长度恰为 3 字节倍数的路径，二者结果相同（无 padding）；但当路径长度
> mod 3 ≠ 0 时（占绝大多数实际场景），错误地删除 padding 会导致 key 末尾
> 少 1～2 个 `_`，找不到磁盘上真实的会话目录。

由于不同系统在盘符大小写（`C:\` vs `c:\`）与斜杠方向（`\` vs `/`）上存在差异，扩展会为同一路径生成多种变体（盘符大小写 × 正反斜杠的组合）并分别编码、去重，依次尝试匹配实际存在的目录，从而稳健地定位会话目录。

## 跳转实现

候选命令按**当前工作区的存储布局**切换。

**Kiro 1.x（默认，实测 kiro-agent 1.0.653）**

1. **`kiroAgent.viewSession(sessionId, title?)`**（主方案）—— 内部走 `switchToSidebarSession`，无副作用，Kiro 自身到处在用。标题为空或纯空白时省略第二个参数。
2. `kiroAgent.sessions.switch(sessionId, undefined, 'local')`（降级）—— `windowId` 必须留空，传了会去 standalone 连接池找那个窗口的 client，找不到就静默返回。

**Kiro 0.9x（仅 `old-only` 布局，即本工作区在 `~/.kiro/sessions` 下没有任何会话目录时）**

在 1.x 两项之后追加既有三项作为降级候选：`kiroAgent.showExecutionInChatTab` → `kiroAgent.viewSpecSession` → `kiroAgent.loadSessionWithPrompt(sessionId, '')`。

**为什么 1.x 的候选里不含 `loadSessionWithPrompt`**：该命令在 1.x 上仍然注册着，但签名已变为 `(_sessionId, prompt)` —— **sessionId 被忽略**，且会把 prompt 当作一条新用户消息发给**当前**会话。拿它兜底不会打开目标会话，只会往用户正在聊的会话里插一条空消息并触发模型响应。另两个 0.9x 命令（`showExecutionInChatTab` / `viewSpecSession`）在 1.x 的产物里连字符串都搜不到，已被移除。

sessionId 全程**原样传递**：`sess_<uuid>`（1.x 新建）与裸 uuid（迁移而来）都不做前缀改写、补齐或截断。依次尝试，第一个成功的即生效；全部失败时弹出错误通知并列出已尝试的候选命令名。跳转成功后搜索面板不会自动关闭。

下一节是 0.9x 时代的原始研究记录，保留作为背景。

## 会话跳转方案（研究记录）

> 这一节记录"如何按 sessionId 打开历史对话"的完整探索与实测结论，作为后续维护与版本适配的依据。

### 背景与约束

Kiro 自带的历史对话面板搜索不支持中文、也不能搜正文，这是本扩展存在的根本原因。而"点击结果跳转到对应会话"是核心需求，因此必须先确认**能否通过 sessionId 程序化打开某个历史对话**——这一点不成立，后续一切优化都没有意义。

调研中确认了两条边界：

- **官方搜索弹窗无法挂载。** 官方 "Find in Chat"（命令 `kiroAgent.chat.openSearch`）只是向 Kiro 自带的、沙箱化的 React Webview 发送一条私有协议消息 `openChatSearch`，其搜索框、搜索逻辑、结果渲染全部跑在该 Webview 内部，通过私有的 `webviewProtocol` 通道通信。第三方扩展拿不到它的 DOM、监听不到它的事件、也无法注入结果。"挂官方搜索事件动态改结果"这条路在扩展 API 层面是封死的。
- **没有公开的"查询历史会话"扩展 API。** Kiro 未对外暴露任何读取会话内容的 API，历史数据只以 JSON 文件形式存在磁盘上。因此"自己扫目录 + 解析 JSON + 自行做中文子串匹配"不是绕路，而是唯一可行的方案。

### 实测过程

跳转命令无法靠静态分析定论——`kiro.kiro-agent` 扩展 bundle 的源码里能搜到的命令，运行时不一定注册。为此在扩展中临时加了一个诊断命令，对当前工作区的真实会话逐一调用候选命令并人工确认结果。关键实测数据：

| 候选 | 命令与参数 | 实测结果 | 结论 |
| --- | --- | --- | --- |
| A | `showExecutionInChatTab(sessionId)` | 完全符合预期，正确打开且无多余消息 | ✅ **采用为主方案** |
| B | `showExecutionInChatTab(sessionId, executionId)` | 能打开，但视图被强制滚动到对话**最开头** | ❌ 不传 executionId |
| C | 先 `acpChatView.focus` 再调 A | 与 A 表现一致 | A 已自带视图激活，focus 多余 |
| D | `loadSessionWithPrompt(sessionId, '')` | 能加载会话，但**发出一条空消息**并触发响应 | ⚠ 仅兜底 |
| E | `loadSessionWithPrompt(sessionId, undefined)` | 能加载，但因缺少 prompt 参数**报错** | ❌ |

> 早期版本曾把 `kiroAgent.viewSpecSession` 当作主命令，但在当前 Kiro 版本运行时实测直接返回 `command 'kiroAgent.viewSpecSession' not found`——它走的是旧的 `sessionPanelManager`，新版改用 `acpChatView`（ACP 架构）后已不注册。保留它仅作为旧版本的降级候选。

### 关键结论

- **主方案：`kiroAgent.showExecutionInChatTab(sessionId)`，且必须省略第二个 `executionId` 参数。** 一旦传入 executionId，前端会把视图强制定位到该执行记录（通常是最早一条），导致跳到对话开头。
- `loadSessionWithPrompt` 的前端处理会**无条件**把 `prompt` 当作一条新用户消息发送（对空 prompt 没有任何保护），因此只能作为最后兜底，且需要意识到它会污染历史。
- 会话文件名 `<sessionId>.json` 与文件内部的 `obj.sessionId` 一致，可直接用文件名作为传给跳转命令的 sessionId。
- 由于跳转命令名随 Kiro 版本变化，代码中以**带优先级的候选列表**依次尝试（见 `src/jump.ts` 的 `DEFAULT_CANDIDATES`），对未来版本变更具备一定韧性。

## 错误场景与排查

| 错误提示 | 含义 | 排查方法 |
| --- | --- | --- |
| 未找到 Kiro 用户数据目录 | 未发现对应平台的 Kiro 用户数据目录 | 确认 Kiro 已安装，并存在上表中对应平台的目录 |
| 未找到 Kiro 对话存储目录 | 用户数据目录存在，但缺少 `workspace-sessions` 根目录 | 确认 Kiro 已运行过对话；检查 `User/globalStorage/kiro.kiroagent/workspace-sessions` 是否存在 |
| 当前没有打开任何工作区 | 未在 Kiro 中打开项目 | 先打开一个项目文件夹再使用搜索 |
| 当前项目还没有 Kiro 对话历史 | 当前工作区没有对应的会话子目录 | 核对面板显示的工作区路径；先在该项目中产生对话 |
| 搜索失败：&lt;原因&gt; | 搜索过程中出现未预期异常 | 查看提示中的原因；通常为文件系统权限问题 |
| 无法打开会话：未找到可用的 Kiro 跳转命令 | 三个候选跳转命令都不可用 | 确认扩展运行在 Kiro 中而非纯 VSCode；Kiro 版本变更可能导致命令名变化 |

> 单个会话文件 JSON 损坏会被静默跳过，不影响其他结果，也不会弹出错误。

## 本地开发与打包

```bash
npm install        # 安装依赖
npm run compile    # tsc 编译到 out/
npm test           # 运行 vitest 单元测试与属性测试
npx vsce package   # 打包成 .vsix
```

调试：在 VSCode / Kiro 中按 `F5` 启动扩展开发宿主。打包生成的 `.vsix` 可直接拖入 Kiro 的扩展面板安装。

## 持续集成与自动发布（GitHub Actions）

仓库内置 `.github/workflows/build.yml`，自动完成编译、测试与打包。

**版本号唯一来源**：`package.json` 的 `version` 字段。`vsce` 打包时直接读取它，无需在别处另维护版本号。

**触发规则**：

| 触发事件 | 行为 | 产物 |
| --- | --- | --- |
| push 到 `main` / 发起 PR | `npm ci` → `compile` → `test` → `vsce package` | vsix 作为 **artifact** 上传（保留 30 天，可在 Actions 运行页面下载），**不创建 Release** |
| push 形如 `v*` 的 tag（如 `v0.2.0`） | 上述全部 + 校验 tag 与 `package.json` 版本一致后创建 **GitHub Release** | Release 附带 vsix，自动生成 release notes |

> tag 版本与 `package.json` 的 `version` 不一致时 CI 会**直接报错**，强制两者同步，避免发布出版本号对不上的安装包。

**发布新版本的流程**：

```bash
# 1. 升级版本号（编辑 package.json 的 version，例如 0.2.0 -> 0.3.0）
# 2. 提交并推送
git add package.json
git commit -m "chore: 版本号升至 0.3.0"
git push origin main
# 3. 打同名 tag 并推送 —— 触发自动打包 + 创建 Release
git tag v0.3.0
git push origin v0.3.0
```

**说明**：

- Release 用 `softprops/action-gh-release` 创建，依赖 GitHub 自动注入的 `GITHUB_TOKEN`（workflow 已声明 `permissions: contents: write`），**无需手动配置任何 secret**。
- 当前仅面向本地 / GitHub 分发，未发布到 VS Code Marketplace 或 Open VSX；若需发布到市场，需额外配置对应的发布 token。
- 平时若只想拿某次提交的安装包，无需打 tag：到仓库 **Actions** 页面对应运行记录的 **Artifacts** 区下载即可。

## 项目结构

```
src/
  extension.ts        # 激活入口：命令注册、活动栏视图、居中搜索面板
  paths.ts            # PathResolver：跨平台路径解析与工作区编码
  env.ts              # EnvChecker：环境校验与错误优先级
  search.ts           # SearchEngine：会话索引缓存、关键词匹配、附件/图片标记、credit 汇总
  credits.ts          # CreditResolver：按 executionId 反查执行存档、汇总真实 credit 用量
  jump.ts             # JumpCommandResolver：跳转命令解析与回退
  webview.ts          # 搜索面板 HTML/CSS/JS 模板
  webview/format.ts   # 与 webview 共享的纯函数（escapeHtml/highlight/fmtTime/usageLabel）
  webview/filter.ts   # 与 webview 共享的附件过滤纯函数（applyAttachmentFilter）
  webview/size.ts     # 占用角标 / 汇总条 / 来源角标的纯函数（sizeBadgeLabel/summaryLabel/originBadgeLabel）
  layout.ts           # LayoutDetector：判定 new-only / old-only / both / none 并解析新旧两套根
  session/newFormat.ts # NewFormatReader：读 1.x 的 session.json + messages.jsonl
  session/origin.ts   # SessionOrigin 判定与 MigrationMarker 解析
  storage/types.ts    # 占用统计的共享数据模型（纯类型 + 文案常量）
  storage/classify.ts # 路径分类器：0.9x 7 类 + 1.x 4 类，各文件恰好归入一类
  storage/scanner.ts  # SizeScanner：异步目录枚举 + stat，可注入分类器
  storage/analyzer.ts # StorageAnalyzer：归因、双布局合并、三个聚合维度、缓存
  storage/orphan.ts   # 孤儿存档判定（0.9x 特有概念）
  storage/ranking.ts  # 占用排行页：取数 + 纯函数 + HTML + 面板生命周期
  storage/report.ts   # 存储占用分析报告的聚合与文本渲染（纯函数）
  storage/cleaner.ts  # SessionCleaner：清理会话数据，可写磁盘
  turnTimer.ts        # TurnTimerPatch：探测 / 注入 / 还原对话面板补丁，唯一会写 Kiro 安装目录的模块
  settings.ts         # 设置页：HTML（纯函数）+ 面板生命周期，注入宿主能力便于测试
  attention.ts        # PendingApproval：解析待确认事件 + 窗口标题标记（不 import vscode）
  webview/turnTimer.ts # 设置页状态行文案的纯函数（turnTimerStatusLabel）
media/
  kcs-turn-timer.js   # 注入进 Kiro 对话面板 webview 的脚本（随扩展分发）
  telemetryTap.ts     # 只读诊断：进程边界与 OTel 全局注册表探查（取真实 token 的可行性）
tests/                # vitest 单元测试与 fast-check 属性测试
docs/
  token-usage-research.md  # 取真实 token / 缓存命中率的全部方案、依据与代价（研究记录）
```

## 测试

测试基于 [vitest](https://vitest.dev/) 与 [fast-check](https://fast-check.dev/)：

- 跨平台路径解析通过可注入的 `deps`（platform / env / homedir / existsSync / statSync）测试，不污染全局 `process.platform`，也不读写真实的用户目录
- 文件相关测试使用临时目录，测试结束自动清理
- 8 条 Correctness Properties 以属性测试形式覆盖编码可逆性、路径变体覆盖、去重、命中、snippet 截取、排序限流、损坏容错与高亮包裹不变量
- credit 解析单测覆盖：哈希值与真实 Kiro 安装核对一致、`usageSummary` 数组的字符串感知切取（含字符串内 `]` 不误截断）、按 `unit` 过滤求和、扁平/SAVES 子目录两种布局定位、LRU 淘汰后的回退（credit 缺失仍带上下文百分比）

## 仓库与作者

- **GitHub 仓库**：<https://github.com/meicuode/KiroChatSearcher>
- **作者**：[@meicuode](https://github.com/meicuode)
- **问题反馈 / 功能建议**：欢迎在 [Issues](https://github.com/meicuode/KiroChatSearcher/issues) 提交；Pull Request 同样欢迎。

## 许可

本项目以 [MIT License](./LICENSE) 开源。
