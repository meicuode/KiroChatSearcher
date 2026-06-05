# Requirements Document

## Introduction

Kiro Chat Search 是一个运行在 Kiro（VSCode 衍生产品）中的扩展，用于在**当前打开的工作区**范围内按关键词搜索 Kiro 对话历史，并通过 Kiro 内部命令直接跳转到对应会话。扩展自动识别本机 Kiro 用户数据目录与对话存储根目录，提供活动栏入口与居中 Webview 搜索面板，支持关键词高亮、键盘导航、错误提示与跨平台路径解析。

当前仓库已存在脚手架（`package.json`、`src/extension.ts`、`src/paths.ts`、`src/search.ts`、`src/webview.ts`、`README.md`、`media/icon.svg`），本规格用于完整描述目标行为、约束与质量标准；后续设计与任务阶段需在此基础上补齐**单元测试**与**完善文档**。

## Glossary

- **Kiro**: VSCode 衍生的 AI 编辑器，本扩展宿主环境。
- **Extension**: 本扩展（Kiro Chat Search）整体。
- **PathResolver**: 负责跨平台路径解析的模块（对应 `src/paths.ts` 中的 `getKiroUserDataDir`、`getSessionsRoot`、`encodeWorkspaceKeys`、`resolveWorkspaceSessionDir`）。
- **SearchEngine**: 负责会话文件读取与关键词匹配的模块（对应 `src/search.ts` 中的 `searchSessionsInDir`）。
- **EnvChecker**: 校验运行环境（用户数据目录、sessions 根目录、工作区、当前工作区会话目录）的逻辑（对应 `src/extension.ts` 的 `checkEnvironment`）。
- **EntryView**: 左侧 Activity Bar 中的入口视图，提供"打开搜索"按钮与环境状态提示。
- **SearchPanel**: 居中的 Webview 搜索面板，承载搜索框与结果列表。
- **SessionFile**: 单个对话会话 JSON 文件，文件名为 `<sessionId>.json`。
- **SessionsRoot**: 会话存储根目录，路径为 `<UserData>/User/globalStorage/kiro.kiroagent/workspace-sessions`。
- **UserDataDir**: Kiro 用户数据目录（Windows/macOS/Linux 各不相同）。
- **WorkspacePath**: 当前在 Kiro 中打开的工作区根目录的绝对路径。
- **WorkspaceSessionDir**: 当前工作区对应的会话子目录，路径为 `<SessionsRoot>/<base64url(WorkspacePath)>`。
- **EncodedKey**: 工作区路径经过 `base64(workspacePath)` 后去掉 `=`，将 `+` 替换为 `-`、`/` 替换为 `_` 得到的目录名。
- **SearchHit**: 单条搜索结果，含 sessionId、title、modified、snippet、matchField。
- **JumpCommand**: 用于打开会话的 Kiro 内部命令，主用 `kiroAgent.viewSpecSession`，回退 `kiroAgent.openChatSession`。

## Requirements

### Requirement 1: 跨平台识别 Kiro 用户数据目录

**User Story:** 作为 Kiro 用户，我希望扩展自动识别我电脑上的 Kiro 用户数据目录，这样我无需手动配置就能直接使用搜索功能。

#### Acceptance Criteria

1. WHEN 在 Windows 平台启动 PathResolver，THE PathResolver SHALL 优先返回 `%APPDATA%\Kiro`，且 WHERE `APPDATA` 环境变量缺失，THE PathResolver SHALL 使用 `<homedir>\AppData\Roaming\Kiro` 作为候选。
2. WHEN 在 macOS 平台启动 PathResolver，THE PathResolver SHALL 返回 `<homedir>/Library/Application Support/Kiro`。
3. WHEN 在 Linux 平台启动 PathResolver，THE PathResolver SHALL 优先返回 `${XDG_CONFIG_HOME}/Kiro`，且 WHERE `XDG_CONFIG_HOME` 环境变量缺失，THE PathResolver SHALL 使用 `<homedir>/.config/Kiro` 作为候选。
4. IF 候选 UserDataDir 在文件系统中不存在,THEN THE PathResolver SHALL 返回 `null` 以表示未找到。
5. WHEN UserDataDir 已确定,THE PathResolver SHALL 将 SessionsRoot 解析为 `<UserDataDir>/User/globalStorage/kiro.kiroagent/workspace-sessions`。
6. IF SessionsRoot 在文件系统中不存在,THEN THE PathResolver SHALL 在返回结果中将 SessionsRoot 标记为 `null` 并保留已识别的 UserDataDir。

### Requirement 2: 工作区路径到目录名的编码

**User Story:** 作为开发者，我希望扩展能可靠地把 WorkspacePath 映射到 Kiro 实际使用的目录名，从而准确定位当前项目的会话目录。

#### Acceptance Criteria

1. WHEN PathResolver 对一个 WorkspacePath 进行编码，THE PathResolver SHALL 计算 `base64(utf8(WorkspacePath))` 后移除所有 `=`、将 `+` 替换为 `-`、将 `/` 替换为 `_`，得到 EncodedKey。
2. WHEN WorkspacePath 形如 `<盘符>:<路径>`，THE PathResolver SHALL 同时生成盘符大写与盘符小写两种路径变体作为编码候选。
3. WHEN WorkspacePath 含有反斜杠或正斜杠路径分隔符，THE PathResolver SHALL 同时生成"全反斜杠"与"全正斜杠"两种变体作为编码候选。
4. THE PathResolver SHALL 对所有候选路径变体分别计算 EncodedKey，并去重后输出 EncodedKey 列表。
5. WHEN 在 SessionsRoot 下解析 WorkspaceSessionDir，THE PathResolver SHALL 依次尝试每个 EncodedKey 对应的目录，并返回首个在文件系统中存在且为目录的路径。
6. IF 所有 EncodedKey 对应的目录均不存在,THEN THE PathResolver SHALL 返回 `null`。

### Requirement 3: 默认仅搜索当前工作区

**User Story:** 作为用户，我希望搜索只覆盖当前打开项目的对话历史，避免被其他项目的会话干扰。

#### Acceptance Criteria

1. WHEN 用户在 SearchPanel 输入关键词，THE Extension SHALL 仅在当前工作区对应的 WorkspaceSessionDir 内进行搜索。
2. THE Extension SHALL NOT 跨 WorkspaceSessionDir 聚合或合并搜索结果。
3. WHILE 当前未打开任何工作区，THE Extension SHALL 拒绝执行搜索并返回错误提示（参见 Requirement 7）。

### Requirement 4: 关键词匹配与结果限制

**User Story:** 作为用户，我希望关键词能同时命中会话标题和消息内容，并按时间顺序展示最近的 10 条结果，便于快速找到目标会话。

#### Acceptance Criteria

1. WHEN SearchEngine 收到非空关键词，THE SearchEngine SHALL 以不区分大小写的方式将关键词作为子串在每个 SessionFile 中匹配 `title` 字段与消息文本内容。
2. WHEN SessionFile 的 `title` 命中关键词，THE SearchEngine SHALL 将该 SearchHit 的 `matchField` 标记为 `title`，且 `snippet` 设为该标题文本。
3. WHEN SessionFile 的 `title` 未命中而消息文本命中关键词，THE SearchEngine SHALL 将 `matchField` 标记为 `message`，且 `snippet` 设为命中位置上下文窗口（默认上下各 80 字符）裁剪后的文本片段，并将连续空白折叠为单个空格。
4. THE SearchEngine SHALL 兼容以下消息结构：`obj.history[i].message.content` 为字符串、`obj.history[i].message.content[j].text`、`obj.messages[i].content`（字符串或对象数组）、`obj.messages[i].text`。
5. THE SearchEngine SHALL 按 SessionFile 的 `mtimeMs` 修改时间倒序排序所有 SearchHit。
6. THE SearchEngine SHALL 将返回结果数量截断到不超过 `limit`（默认 10）。
7. IF 关键词为空白字符串,THEN THE SearchEngine SHALL 不执行关键词匹配，且 SearchPanel SHALL 转而展示最近会话列表（见 Requirement 4.9）。
8. WHEN 用户在搜索框连续输入,THE SearchPanel SHALL 在最后一次按键 120 毫秒后才向扩展主进程发送一次搜索请求（输入防抖）。
9. WHEN 关键词为空（包括首次打开面板与用户清空输入），THE SearchEngine SHALL 通过 `listRecentSessions` 返回当前 WorkspaceSessionDir 下按 `mtimeMs` 倒序的最近会话列表，最多 20 条；每条 SearchHit 的 `matchField` 为 `'recent'`，`snippet` 取自首条用户消息文本（截断到 160 字符并折叠空白），缺少用户消息时为空串。

### Requirement 5: JSON 解析与文件读取容错

**User Story:** 作为用户，我希望即使部分会话文件损坏，搜索功能也能正常工作并返回其他有效结果。

#### Acceptance Criteria

1. IF 读取 WorkspaceSessionDir 列表时抛出异常,THEN THE SearchEngine SHALL 返回空数组且不抛出异常。
2. IF 读取或 `stat` 单个 SessionFile 失败,THEN THE SearchEngine SHALL 跳过该文件并继续处理其余文件。
3. IF 单个 SessionFile 的 JSON 解析失败,THEN THE SearchEngine SHALL 跳过该文件并继续处理其余文件。
4. WHEN SessionFile 缺少 `title` 与 `name` 字段,THE SearchEngine SHALL 将 SearchHit 的 `title` 字段设为 `Untitled`。
5. THE SearchEngine SHALL NOT 因任何单个 SessionFile 的异常而终止整个搜索过程。

### Requirement 6: Activity Bar 入口与居中搜索面板

**User Story:** 作为用户，我希望从左侧活动栏一键打开居中的搜索面板，界面简洁美观，便于专注搜索。

#### Acceptance Criteria

1. THE Extension SHALL 在 Kiro 左侧 Activity Bar 中注册一个 ID 为 `kiroChatSearch` 的视图容器，并使用 `media/icon.svg` 作为图标。
2. THE Extension SHALL 在该视图容器中注册一个 ID 为 `kiroChatSearch.entry` 的 Webview 视图作为入口，且 EntryView SHALL 提供"打开搜索"按钮以及当前环境校验状态摘要（UserDataDir、WorkspaceSessionDir 或错误提示）。
3. WHEN 用户在 EntryView 点击"打开搜索"按钮或执行命令 `kiroChatSearch.openSearch`，THE Extension SHALL 在编辑器活动列（`ViewColumn.Active`）打开一个 viewType 为 `kiroChatSearch.panel`、标题为"Kiro 对话搜索"的 SearchPanel。
4. WHILE SearchPanel 已存在,THE Extension SHALL 复用现有面板：将其聚焦并向 Webview 发送 `focus` 消息以激活搜索框。
5. THE SearchPanel SHALL 启用脚本（`enableScripts: true`），且在隐藏后保留上下文（`retainContextWhenHidden: true`）。
6. THE SearchPanel SHALL 应用包含 `default-src 'none'` 与脚本 nonce 的 Content-Security-Policy。
7. THE Extension SHALL 注册默认快捷键 `Ctrl+Alt+K`（Windows/Linux）与 `Cmd+Alt+K`（macOS）以触发 `kiroChatSearch.openSearch` 命令。

### Requirement 7: 友好的错误提示

**User Story:** 作为用户，当环境异常时我希望看到清晰的中文错误提示与排查指引，而不是空结果或崩溃。

#### Acceptance Criteria

1. IF EnvChecker 未识别到 UserDataDir,THEN THE EntryView 与 SearchPanel SHALL 显示错误"未找到 Kiro 用户数据目录"并附带平台对应的预期路径作为排查指引。
2. IF EnvChecker 已识别 UserDataDir 但 SessionsRoot 不存在,THEN THE EntryView 与 SearchPanel SHALL 显示错误"未找到 Kiro 对话存储目录"并提示预期完整路径。
3. IF 当前未打开工作区,THEN THE EntryView 与 SearchPanel SHALL 显示错误"当前没有打开任何工作区"并提示用户先在 Kiro 中打开一个项目。
4. IF 当前工作区无法解析到 WorkspaceSessionDir,THEN THE EntryView 与 SearchPanel SHALL 显示错误"当前项目还没有 Kiro 对话历史"并显示当前 WorkspacePath 以便用户核对。
5. WHEN 多个环境异常同时存在,THE EnvChecker SHALL 仅返回按以下优先级排序的第一个错误：(1) UserDataDir 缺失 → (2) SessionsRoot 缺失 → (3) 未打开工作区 → (4) WorkspaceSessionDir 缺失。
6. WHEN SearchEngine 在执行过程中抛出未预期异常,THE SearchPanel SHALL 显示形如"搜索失败：<异常 message>"的错误提示。
7. IF 单个 SessionFile JSON 解析失败,THEN THE SearchEngine SHALL 静默跳过该文件并按 Requirement 5 继续处理，且 SearchPanel SHALL NOT 因此显示错误提示。
8. IF 用户在 SearchPanel 选择打开会话时所有 JumpCommand 均不可用,THEN THE Extension SHALL 通过 Kiro 通知 API 显示错误提示，且错误文案 SHALL 同时列出 `kiroAgent.viewSpecSession` 与 `kiroAgent.openChatSession` 两个候选命令名以便用户排查。

### Requirement 8: 搜索结果交互（高亮、键盘导航、点击打开）

**User Story:** 作为用户，我希望关键词被高亮显示，可以用键盘上下选择并按 Enter 打开会话，按 Esc 关闭面板，使用流畅。

#### Acceptance Criteria

1. WHEN SearchPanel 渲染结果，THE SearchPanel SHALL 在每条 SearchHit 的标题与 snippet 中将关键词包裹为 `<mark>` 元素以实现高亮。
2. WHEN 用户在搜索框按下 `ArrowDown` 键，THE SearchPanel SHALL 将选中项下移一项并循环到列表头部。
3. WHEN 用户在搜索框按下 `ArrowUp` 键，THE SearchPanel SHALL 将选中项上移一项并循环到列表尾部。
4. WHEN 用户按下 `Enter` 键且当前存在选中项，THE SearchPanel SHALL 触发打开该 SearchHit 对应会话。
5. WHEN 用户按下 `Escape` 键，THE SearchPanel SHALL 关闭当前 Webview 面板。
6. WHEN 用户用鼠标点击任一结果项，THE SearchPanel SHALL 触发打开该 SearchHit 对应会话。
7. WHEN 选中项变化，THE SearchPanel SHALL 调用 `scrollIntoView({ block: 'nearest' })` 以保持选中项在可视区域内。
8. WHEN SearchEngine 返回非空结果，THE SearchPanel SHALL 默认将选中项设为列表第一项。
9. WHEN 渲染时间戳，THE SearchPanel SHALL 对当天会话使用 `今天 HH:mm` 格式，对当年其他日期使用 `MM-DD HH:mm` 格式，对跨年日期使用 `YYYY-MM-DD HH:mm` 格式。
10. THE SearchPanel SHALL 在状态栏显示形如"命中 N 个对话（最多展示 10 条）"的命中数量提示。

### Requirement 9: 跳转到 Kiro 会话的命令调用

**User Story:** 作为用户，我希望点击搜索结果能直接打开对应的 Kiro 会话，无论该会话来自 Vibe 还是 Spec 模式。

#### Acceptance Criteria

1. WHEN 用户触发打开 SearchHit，THE Extension SHALL 通过 Kiro 命令注册表查询当前可用命令列表。
2. WHILE `kiroAgent.viewSpecSession` 命令存在于可用命令列表中，THE Extension SHALL 优先以 `executeCommand('kiroAgent.viewSpecSession', sessionId)` 形式调用。
3. IF `kiroAgent.viewSpecSession` 不可用或调用抛出异常,THEN THE Extension SHALL 回退调用 `executeCommand('kiroAgent.openChatSession', sessionId)`。
4. IF 上述两个 JumpCommand 均不可用或均调用失败,THEN THE Extension SHALL 通过 Kiro 通知 API 显示错误提示并指出当前可能未运行在 Kiro 环境中。
5. WHEN 调用 JumpCommand 成功，THE Extension SHALL NOT 关闭 SearchPanel，以便用户继续浏览或搜索其他会话。

### Requirement 10: 单元测试覆盖核心逻辑

**User Story:** 作为维护者，我希望核心路径解析与搜索逻辑被单元测试覆盖，从而在重构和升级时保持可靠。

#### Acceptance Criteria

1. THE Extension SHALL 引入一个 Node 端的单元测试框架（例如 Mocha 或 Vitest），并在 `package.json` 中提供 `npm test` 脚本以便一次性运行所有测试。
2. THE 单元测试 SHALL 覆盖 `getKiroUserDataDir`：分别在被测代码中 mock Windows、macOS、Linux 平台与对应环境变量，断言返回路径符合 Requirement 1 的规则。
3. THE 单元测试 SHALL 覆盖 `encodeWorkspaceKeys`：对包含盘符与反斜杠的 Windows 路径，断言返回的 EncodedKey 列表至少包含盘符大小写与正反斜杠的全部组合并已去重。
4. THE 单元测试 SHALL 覆盖 `resolveWorkspaceSessionDir`：在临时目录中预先创建若干以不同 EncodedKey 命名的子目录，断言函数能在目录存在时返回正确路径，在目录不存在时返回 `null`。
5. THE 单元测试 SHALL 覆盖 `searchSessionsInDir` 的标题命中场景：构造若干 SessionFile，断言关键词命中标题的 SearchHit 具有 `matchField === 'title'` 且 `snippet` 等于该标题。
6. THE 单元测试 SHALL 覆盖 `searchSessionsInDir` 的消息命中场景：构造含 `obj.history[].message.content` 与 `obj.messages[].content` 等不同结构的 SessionFile，断言关键词命中消息时 `matchField === 'message'` 且 snippet 包含命中关键词。
7. THE 单元测试 SHALL 覆盖 `searchSessionsInDir` 的 JSON 损坏容错：在测试目录中放入一个非合法 JSON 的 `.json` 文件，断言函数不抛异常并仍能返回其他文件中的命中结果。
8. THE 单元测试 SHALL 覆盖 `searchSessionsInDir` 的排序与 limit：构造大于 10 个命中文件并设置不同 mtime，断言返回结果按 mtime 倒序排列且长度不超过 10。

### Requirement 11: 文档完善

**User Story:** 作为新接触本扩展的开发者，我希望 README 提供完整的使用说明、路径规则、错误排查与开发指引，以便快速上手或定制。

#### Acceptance Criteria

1. THE README SHALL 描述扩展功能、跨平台路径规则、激活方式（Activity Bar 入口与默认快捷键）、搜索规则（关键词覆盖标题与消息、最多 10 条、按 mtime 倒序）。
2. THE README SHALL 描述 JumpCommand 的优先级与回退顺序（`kiroAgent.viewSpecSession` 优先，回退 `kiroAgent.openChatSession`）。
3. THE README SHALL 列出全部错误场景（Requirement 7 列出的六类）及对应排查方法。
4. THE README SHALL 提供本地开发与打包步骤（`npm install`、`npm run compile`、`npm test`、`npx vsce package`）。
5. THE README SHALL 描述 WorkspacePath 编码规则（base64 去 `=`、`+` -> `-`、`/` -> `_`）以及盘符大小写与斜杠变体的处理策略。
