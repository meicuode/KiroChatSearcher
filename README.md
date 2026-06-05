# Kiro Chat Search

在 Kiro（VSCode 衍生产品）中按关键词搜索**当前打开项目**的对话历史，点击结果直接跳转到对应会话。扩展自动识别本机 Kiro 用户数据目录与对话存储根目录，提供左侧活动栏入口与居中搜索面板，完全本地运行、零网络依赖。

## 功能概述

- 自动识别本机 Kiro 用户数据目录与对话存储根目录（Windows / macOS / Linux）
- 自动定位**当前工作区**对应的会话子目录，搜索默认只覆盖当前项目
- 左侧活动栏入口，点击即可在编辑器中央打开搜索面板
- 实时搜索（同时覆盖会话标题与消息内容），最多展示 10 条结果，按修改时间倒序
- 命中关键词高亮显示、上下键选择、Enter 跳转、Esc 关闭、120ms 输入防抖
- 完整的环境校验和友好的中文错误提示
- 安全：Webview 使用 `default-src 'none'` + nonce 的 CSP，所有动态内容经 HTML 转义

## 激活方式

- **活动栏入口**：左侧活动栏的 Kiro Chat Search 图标，点击后在入口面板按"🔍 打开搜索"
- **快捷键**：`Ctrl+Alt+K`（Windows / Linux）/ `Cmd+Alt+K`（macOS）
- **命令面板**：执行命令 `Kiro: 搜索对话历史`（`kiroChatSearch.openSearch`）

## 搜索规则

- 关键词以**不区分大小写**的子串方式匹配；先匹配会话标题，标题未命中再扫描消息内容
- 标题命中时片段为标题本身；消息命中时截取命中位置前后各约 80 字符的上下文，连续空白折叠为单个空格
- 结果按会话文件的修改时间（`mtimeMs`）**倒序**排列
- 最多返回 **10** 条结果
- 搜索框输入有 120ms 防抖，停止输入后才触发一次搜索

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

点击或回车打开结果时，按以下优先级调用 Kiro 内部命令（兼容 Vibe / Spec 会话）：

1. **`kiroAgent.showExecutionInChatTab(sessionId)`**（主方案）—— 仅加载会话、定位到当前位置，**不发送任何消息**，无副作用。
2. `kiroAgent.viewSpecSession(sessionId)`（旧版兼容降级）—— 较老的 Kiro 版本使用，新版可能未注册。
3. `kiroAgent.loadSessionWithPrompt(sessionId, '')`（最后兜底）—— ⚠ 会向会话发送一条空消息，可能污染历史，仅在前两者全不可用时使用。

依次尝试，第一个调用成功的即生效；全部失败时弹出错误通知并列出候选命令名，便于排查。跳转成功后搜索面板不会自动关闭，方便继续浏览。

具体每个命令的实测过程与取舍见下一节。

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

## 项目结构

```
src/
  extension.ts        # 激活入口：命令注册、活动栏视图、居中搜索面板
  paths.ts            # PathResolver：跨平台路径解析与工作区编码
  env.ts              # EnvChecker：环境校验与错误优先级
  search.ts           # SearchEngine：会话文件读取与关键词匹配
  jump.ts             # JumpCommandResolver：跳转命令解析与回退
  webview.ts          # 搜索面板 HTML/CSS/JS 模板
  webview/format.ts   # 与 webview 共享的纯函数（escapeHtml/highlight/fmtTime）
tests/                # vitest 单元测试与 fast-check 属性测试
```

## 测试

测试基于 [vitest](https://vitest.dev/) 与 [fast-check](https://fast-check.dev/)：

- 跨平台路径解析通过可注入的 `deps`（platform / env / homedir / existsSync / statSync）测试，不污染全局 `process.platform`，也不读写真实的用户目录
- 文件相关测试使用临时目录，测试结束自动清理
- 8 条 Correctness Properties 以属性测试形式覆盖编码可逆性、路径变体覆盖、去重、命中、snippet 截取、排序限流、损坏容错与高亮包裹不变量
