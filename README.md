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

- 去掉所有 `=`
- 将 `+` 替换为 `-`
- 将 `/` 替换为 `_`

由于不同系统在盘符大小写（`C:\` vs `c:\`）与斜杠方向（`\` vs `/`）上存在差异，扩展会为同一路径生成多种变体（盘符大小写 × 正反斜杠的组合）并分别编码、去重，依次尝试匹配实际存在的目录，从而稳健地定位会话目录。

## 跳转实现

点击或回车打开结果时，按以下优先级调用 Kiro 内部命令（兼容 Vibe / Spec 会话）：

1. `kiroAgent.viewSpecSession`（优先，名字带 Spec 是历史原因，对 vibe 会话同样有效）
2. `kiroAgent.openChatSession`（当上一个不可用或调用失败时回退）

若两个命令都不可用，会弹出错误通知并同时列出这两个命令名，便于排查。跳转成功后搜索面板不会自动关闭，方便继续浏览。

## 错误场景与排查

| 错误提示 | 含义 | 排查方法 |
| --- | --- | --- |
| 未找到 Kiro 用户数据目录 | 未发现对应平台的 Kiro 用户数据目录 | 确认 Kiro 已安装，并存在上表中对应平台的目录 |
| 未找到 Kiro 对话存储目录 | 用户数据目录存在，但缺少 `workspace-sessions` 根目录 | 确认 Kiro 已运行过对话；检查 `User/globalStorage/kiro.kiroagent/workspace-sessions` 是否存在 |
| 当前没有打开任何工作区 | 未在 Kiro 中打开项目 | 先打开一个项目文件夹再使用搜索 |
| 当前项目还没有 Kiro 对话历史 | 当前工作区没有对应的会话子目录 | 核对面板显示的工作区路径；先在该项目中产生对话 |
| 搜索失败：&lt;原因&gt; | 搜索过程中出现未预期异常 | 查看提示中的原因；通常为文件系统权限问题 |
| 无法打开会话：未找到可用的 Kiro 跳转命令 | 跳转命令不可用 | 确认扩展运行在 Kiro 中而非纯 VSCode |

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
