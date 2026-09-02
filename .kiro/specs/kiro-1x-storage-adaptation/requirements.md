# Requirements Document

## Introduction

Kiro 从 0.9x 升级到 1.x 后（本机实测 Kiro 1.0.337、内置 kiro-agent 1.0.653），聊天历史与执行数据的磁盘布局被整体重写：会话不再是单个 JSON 文件而是**每会话一个目录**，存储根从用户数据目录下的 `globalStorage` 移到用户主目录下的 `~/.kiro`，工作区目录哈希算法、跳转命令、credit 归因来源全部改变。现有 Kiro Chat Search 扩展（搜索/跳转 + 存储占用统计与清理两大既有特性）在 1.x 上已失效，可观察到的现象是：占用排行页显示 0 个会话、点击搜索结果无法跳转。

本特性把扩展适配到 Kiro 1.x，并**保留对 0.9x 旧格式数据的完整支持**。1.x 的官方迁移由用户手动触发（官方 changelog 1.0.52），本机 197 个旧会话仅 11 个已迁移，旧目录仍残留约 3.6 GB / 7735 文件 / 7 个工作区。因此扩展必须在 `new-only`、`old-only`、`both`、`none` 四种布局下都能正确浏览、搜索、统计与清理，并让用户看清每条会话的来源（1.x 新建 / 已迁移 / 仅存在于旧目录）。

本特性同时在占用排行表之上新增两个聚合维度：**当前项目会话总占用**（排行页本就枚举了当前工作区目录，可由同一次枚举聚合得出）与**整个 Kiro 会话总占用**（扫描 `~/.kiro/sessions` 下其它工作区目录，本机约 256 MB / 2856 文件，手动触发并缓存）。旧目录约 3.6 GB 的重量级残留是否计入「整个 Kiro」被拆为**独立可选维度**，默认不计入，以确保主流程不被其拖慢。

### 实地调研依据（本机实测，作为事实基线，无需再推导）

调研结论详见同目录 `research-notes.md`，以下为需求所依赖的部分：

**旧存储（0.9x，仍在磁盘、仍需兼容）**

- 会话目录：`<UserDataDir>/User/globalStorage/kiro.kiroagent/workspace-sessions/<OldEncodedKey>/`，`<OldEncodedKey>` 为工作区路径的 base64url 变体（`=` 替换为 `_`）。
- 每个会话是单个 `<sessionId>.json` 文件，会话清单为 `sessions.json`。
- 执行存档位于 `<OldStoreRoot>/<WorkspaceId>/<bucket>/<hash32(executionId)>`，`WorkspaceId = hash32(原始工作区路径)`，**不做路径规范化**。
- 旧目录内的迁移标记文件 `._migration-<uuid>.json`，含 `migratedAt`、`v2SessionId`、`workspaceHash`、`v1WorkspaceDirectory`、`markerVersion`；其中 `workspaceHash` 用的是**旧**算法 `sha256(原始路径).slice(0,16)`，与 1.x 的新目录名不是一回事，不能用它定位新目录。

**新存储（1.x）**

- 会话目录：`~/.kiro/sessions/<WsHash16>/<sessionId>/`，每个会话是一个**目录**。
- `WsHash16 = sha256( workspacePath.replace(/\\/g,'/').toLowerCase() )` 的十六进制前 16 位。已用两个样本验证：`d:\Projects\KiroExt\KiroChatSearcher` → `cc5023603866cd91`，`d:\SurErp\ERP-OMS-Workspaces` → `6082f0c94c5c4af8`。与旧算法（`sha256(原始路径).slice(0,32)`，不归一化）既换了摘要范围也换了归一化，不可复用。
- 会话目录内含：`session.json`（`schemaVersion`、`dataModelVersion`、`id`、`title`、`agentMode`、`workspacePaths[]`、`rootPaths[]`、`createdAt`、`lastModifiedAt`、`modelId`、`autopilot`、`effortLevel`、`status`）；`messages.jsonl`（每行一个事件 `{id,timestamp,payload:{type,...}}`）；`snapshots/<hash>/<相对路径>`（文件检查点，1.x 中执行存档/附件的对应物）；`sub-executions/`；`publish.cursor`、`publish-sub.cursor`。
- 实测 `payload.type` 取值：`user`、`assistant`、`tool_call`、`tool_result`、`usage_summary`、`session_metadata`、`turn_start`、`turn_end`、`sub_agent_start`、`sub_agent_complete`、`pending_interaction`、`interaction_resolved`、`session_event`、`tombstone`。
- `sessionId`：迁移来的会话沿用原 uuid；1.x 新建的形如 `sess_<uuid>`。
- 会话索引：`~/.kiro/session-index/<WsHash16>.jsonl`（追加式）与 `.migration-v3` 标记。
- credit/用量已并入 `messages.jsonl` 的 `usage_summary` 事件；旧的 `hash32(executionId)` → 独立存档文件查表在 1.x 上完全失效。
- 新目录合计约 256 MB / 2856 文件。

**跳转命令（对 kiro-agent 1.0.653 的 dist 实测）**

- `kiroAgent.showExecutionInChatTab`（原主命令）与 `kiroAgent.viewSpecSession`（原兼容命令）均**已移除**。
- `kiroAgent.loadSessionWithPrompt` 仍在，但签名变为 `(_sessionId, prompt)`，**sessionId 被忽略**，且会向当前会话发送消息。
- 正确替代：`kiroAgent.viewSession(sessionId, title?)`（内部走 `switchToSidebarSession`，无副作用，Kiro 自身到处在用）；备用 `kiroAgent.sessions.switch(sessionId, windowId, source)`。`kiroAgent.openChatSession()` 不接受参数（内部弹 QuickPick），不能用于定点跳转。

### 用户决策（硬性要求）

1. **双版本兼容**：1.x 为主；0.9x 也要继续可用——浏览/搜索、空间统计、清理在旧格式数据上均需正常工作。
2. **排行表之上的两个聚合维度**：（a）当前项目会话总占用，由排行页已有的枚举结果聚合，不新增枚举成本；（b）整个 Kiro 会话总占用，扫描 `~/.kiro/sessions` 下其它工作区目录，手动触发 + 缓存。「整个 Kiro」是否包含约 3.6 GB 旧残留**必须**作为独立可选维度处理，默认不计入，不得拖慢主流程。

### 范围与非目标

本次覆盖：布局/版本检测与环境提示适配；双版本路径解析；新格式的搜索、预览与 credit；跳转命令适配；新布局的占用扫描与分类；排行页在双布局下的会话列表与两个聚合维度；旧残留的独立统计与清理；逐会话迁移状态展示；目录型会话的清理安全边界；只读与可写边界、显式手动触发约束；跨平台一致性；测试与文档。

以下明确不在本次范围内：触发或代替 Kiro 官方的 0.9x → 1.x 迁移；把未迁移的旧会话转换成新格式；修改 Kiro 的存储位置；跨机器或云端聚合；后台定时扫描与常驻文件监视；删除操作的撤销与回收站；`~/.kiro` 下除 `sessions` 与 `session-index` 之外的其它子目录的分类统计。

## Glossary

- **Kiro**: VSCode 衍生的 AI 编辑器，本扩展的宿主环境。1.x 为当前主目标版本，0.9x 为需继续兼容的旧版本。
- **Extension**: 本扩展（Kiro Chat Search）整体。
- **hash32(s)**: `sha256(s)` 十六进制表示的前 32 位（既有 `src/credits.ts` 的同名函数）。
- **UserDataDir**: Kiro 用户数据目录。Windows 为 `%APPDATA%\Kiro`；macOS 为 `~/Library/Application Support/Kiro`；Linux 为 `${XDG_CONFIG_HOME:-~/.config}/Kiro`。由既有 PathResolver 解析。
- **PathResolver**: 既有的跨平台路径解析模块（`src/paths.ts`），本特性在其上扩展 1.x 布局解析。
- **EnvChecker**: 既有的环境校验模块（`src/env.ts`），按优先级返回第一个环境错误。
- **HomeKiroDir**: 1.x 新存储根 `~/.kiro`，由 `os.homedir()` 解析。
- **NewSessionsRoot**: `<HomeKiroDir>/sessions`，1.x 下全部工作区会话目录的公共根。
- **NewSessionIndexRoot**: `<HomeKiroDir>/session-index`，存放 `<WsHash16>.jsonl` 追加式索引与 `.migration-v3` 标记。
- **WsHash16**: 1.x 工作区目录名 = `sha256( workspacePath.replace(/\\/g,'/').toLowerCase() )` 的十六进制前 16 位。
- **NewWorkspaceSessionDir**: `<NewSessionsRoot>/<WsHash16>`，某工作区在 1.x 下的会话目录。
- **NewSessionDir**: `<NewWorkspaceSessionDir>/<sessionId>`，1.x 下单个会话的目录。
- **NewSessionMetaFile**: NewSessionDir 下的 `session.json`。
- **MessagesFile**: NewSessionDir 下的 `messages.jsonl`。
- **MessageEvent**: MessagesFile 中的一行，形如 `{id,timestamp,payload:{type,...}}`。
- **SnapshotsDir**: NewSessionDir 下的 `snapshots/`，1.x 的文件检查点，对应 0.9x 的执行存档/附件。
- **SubExecutionsDir**: NewSessionDir 下的 `sub-executions/`。
- **UsageSummaryEvent**: `payload.type === 'usage_summary'` 的 MessageEvent，1.x 的 credit/用量来源。
- **SessionIndexFile**: `<NewSessionIndexRoot>/<WsHash16>.jsonl`，追加式（append-only）会话索引，可能含已删除会话的历史条目。
- **OldStoreRoot**: 0.9x 公共根 `<UserDataDir>/User/globalStorage/kiro.kiroagent`。
- **OldSessionsRoot**: `<OldStoreRoot>/workspace-sessions`。
- **OldEncodedKey**: 工作区路径经既有 `encodeWorkspaceKeys` 规则得到的 base64url 目录名。
- **OldWorkspaceSessionDir**: `<OldSessionsRoot>/<OldEncodedKey>`。
- **OldSessionFile**: 0.9x 单个会话 JSON 文件 `<sessionId>.json`。
- **OldSessionManifest**: 0.9x 会话目录下的 `sessions.json` 清单。
- **WorkspaceId**: 0.9x 执行数据目录名 = `hash32(原始工作区路径)`，不做路径规范化。
- **ExecutionSavesBucket**: `hash32("KIRO::EXECUTION::SAVES")`，0.9x 执行存档所在的分桶目录名。
- **OldExecutionArchive**: `<OldStoreRoot>/<WorkspaceId>/<ExecutionSavesBucket>/` 下以 `hash32(executionId)` 命名的执行存档文件，内含 `chatSessionId` 与 `usageSummary`。
- **MigrationMarker**: 旧目录内的 `._migration-<uuid>.json` 文件，标记某旧会话已迁移，含 `v2SessionId`、`v1WorkspaceDirectory` 等字段。
- **LegacyResidue**（旧残留）: 在 NewSessionsRoot 存在的前提下，仍留在旧目录中的 0.9x 数据（OldSessionsRoot 下的会话文件与 `<OldStoreRoot>/<WorkspaceId>` 下的执行数据）。
- **StorageLayout**: 当前工作区的布局判定结果，取值 `new-only`、`old-only`、`both`、`none`。
- **LayoutDetector**: 本特性新增的布局检测模块，判定 StorageLayout 并给出新旧各自可用的根路径。
- **SessionOrigin**: 单个会话的来源分类，取值 `new`、`migrated`、`legacy-unmigrated`。
- **MigrationStatus**: 会话行/结果项上用于展示 SessionOrigin 的指示。
- **NewFormatReader**: 本特性新增的 1.x 会话读取模块，从 NewSessionMetaFile 与 MessagesFile 提取标题、匹配文本、`hasImage`、`hasAttachment` 与用量。
- **SearchEngine**: 既有会话搜索模块（`src/search.ts`），本特性使其在新旧两种格式上统一产出 SearchHit。
- **SearchHit**: 单条搜索结果，含 `sessionId`、`title`、`modified`、`snippet`、`matchField`、`hasImage`、`hasAttachment`，本特性新增 `origin`（SessionOrigin）与 `layout` 标记。
- **SearchPanel**: 既有的居中搜索面板 webview 与侧边栏搜索视图。
- **AttachmentFilter**: 既有的附件/图片过滤纯函数（`src/webview/filter.ts` 的 `applyAttachmentFilter`）及其 UI 标签（全部 / 含图片 / 含附件）。
- **CreditReader**: 既有 credit 归因模块（`src/credits.ts`），本特性使其在 1.x 从 UsageSummaryEvent 取数、在 0.9x 沿用既有存档查表。
- **CreditScope**: credit 展示口径，取值 `self`（自身）或 `lineage`（累计），与既有 `Σ` 开关共用同一状态。
- **JumpCommand**: 用于按 sessionId 打开 Kiro 会话的内部命令；1.x 主命令为 `kiroAgent.viewSession`，备用为 `kiroAgent.sessions.switch`。
- **StorageAnalyzer**: 既有存储占用统计模块（`src/storage/`），本特性使其覆盖 1.x 布局与目录型会话。
- **SizeScanner**: StorageAnalyzer 内的目录体积扫描器（`src/storage/scanner.ts`），只做目录枚举与 stat，不读文件内容。
- **StorageCategory**: 占用分类维度；本特性在既有分类之上新增 `新格式会话`、`新格式快照`、`新格式子执行`、`新格式索引`。
- **SessionFootprint**: 单个会话的占用；1.x 下为该 NewSessionDir 内全部文件字节数之和，0.9x 下沿用既有口径（OldSessionFile 字节数 + 按 `chatSessionId` 归因的 OldExecutionArchive 字节数）。
- **FootprintScope**: 会话占用的展示口径，取值 `self` 或 `lineage`（既有）。
- **ProjectSessionTotal**: 当前项目会话总占用 = 当前工作区全部会话的 SessionFootprint（自身口径）合计，排行表之上的聚合维度（a）。
- **AllKiroSessionTotal**: 整个 Kiro 会话总占用，排行表之上的聚合维度（b），手动触发并缓存。
- **LegacyResidueTotal**: LegacyResidue 的字节数与文件数合计，独立可选维度，默认不计入 AllKiroSessionTotal。
- **UsageRankingPage**: 既有占用排行页 webview（标题「Kiro 存储占用排行」），本特性在其表头之上加入两个聚合维度、为每行加入 MigrationStatus，并使其在 1.x 布局下正确列出会话。
- **RankingSortOrder**: UsageRankingPage 的排序方向（既有），取值 `desc`（默认）或 `asc`，含既有的等值稳定次序规则。
- **SummaryBar**: 搜索面板过滤标签行内的汇总展示区（既有）。
- **ComputeSizeButton**: 过滤标签行内的占用统计触发按钮（左键统计、右键打开 UsageRankingPage，既有）。
- **StorageReportCommand**: 既有命令 `kiroChatSearch.storageReport`（标题「Kiro: 存储占用分析」），输出全工作区文本报告到输出通道。
- **StorageOutputChannel**: 既有「Kiro 存储占用」输出通道，承载占用报告与清理审计记录。
- **SessionCleaner**: 既有清理模块（`src/storage/cleaner.ts`），本特性唯一允许写磁盘的模块。
- **CleanupPlan**: 一次清理的预演结果，含模式、目标标识、待删除文件的绝对路径列表与其字节数/mtime 快照、字节数合计与文件数合计。
- **CleanupResult**: 一次清理的执行结果，含成功、失败、跳过三类计数与各自明细。
- **AttachmentCleanup**: 附件清理模式；1.x 下删除 SnapshotsDir 与 SubExecutionsDir 内的文件，0.9x 下删除归因到该会话的 OldExecutionArchive。
- **FullCleanup**: 全量清理模式；1.x 下删除整个 NewSessionDir 内的文件并移除已清空的目录，0.9x 下沿用既有语义（存档 + OldSessionFile + OldSessionManifest 条目移除）。
- **ReadOnlyPaths**: 只允许读磁盘的代码路径集合，含 LayoutDetector、PathResolver、EnvChecker、NewFormatReader、SearchEngine、CreditReader、StorageAnalyzer、SizeScanner、报告渲染与 UsageRankingPage 取数。
- **WritableFsAllowlist**: 允许写磁盘的文件系统 API 白名单，仅由 SessionCleaner 使用。

## Requirements

### Requirement 1: 存储布局检测与环境提示适配

**User Story:** 作为用户，我希望扩展自动判断我的会话在新格式、旧格式还是两者并存，从而在任一布局下都能正常浏览、统计与清理，而不是被「未找到对话存储目录」挡住。

#### Acceptance Criteria

1. THE LayoutDetector SHALL 通过 `os.homedir()` 解析 HomeKiroDir，并把 NewSessionsRoot 解析为 `<HomeKiroDir>/sessions`、NewSessionIndexRoot 解析为 `<HomeKiroDir>/session-index`。
2. THE LayoutDetector SHALL 通过既有 PathResolver 解析 UserDataDir、OldStoreRoot 与 OldSessionsRoot。
3. WHEN LayoutDetector 针对当前工作区判定布局，THE LayoutDetector SHALL 依据「NewWorkspaceSessionDir 存在且含至少一个 NewSessionDir」与「OldWorkspaceSessionDir 存在且含至少一个 OldSessionFile」两个条件的组合，返回 StorageLayout 之一：两者均成立为 `both`、仅前者成立为 `new-only`、仅后者成立为 `old-only`、两者均不成立为 `none`。
4. WHERE StorageLayout 为 `both`，THE Extension SHALL 以 1.x 新格式为主并同时纳入旧格式数据用于浏览、搜索、统计与清理。
5. IF HomeKiroDir 或 NewSessionsRoot 不存在，THEN THE LayoutDetector SHALL 把新格式相关根返回为 `null`、保留已解析的旧格式根，并向调用方返回结果而不抛出异常。
6. IF OldStoreRoot 或 OldSessionsRoot 不存在，THEN THE LayoutDetector SHALL 把旧格式相关根返回为 `null`、保留已解析的新格式根，并向调用方返回结果而不抛出异常。
7. WHERE StorageLayout 为 `new-only`，THE EnvChecker SHALL 返回 `ok` 状态，且 THE EnvChecker SHALL 把 NewWorkspaceSessionDir 作为当前工作区的会话目录返回。
8. WHERE StorageLayout 为 `old-only`，THE EnvChecker SHALL 返回 `ok` 状态并沿用既有的 OldWorkspaceSessionDir 解析结果。
9. WHERE NewSessionsRoot 与 OldSessionsRoot 均不存在，THE EnvChecker SHALL 返回错误「未找到 Kiro 对话存储目录」，并在提示中同时给出 `~/.kiro/sessions` 与 `<UserDataDir>/User/globalStorage/kiro.kiroagent/workspace-sessions` 两个预期位置。
10. WHILE 当前未打开任何工作区，THE EnvChecker SHALL 返回既有的「当前没有打开任何工作区」错误，且 THE Extension SHALL 把目录枚举排除在该状态下的行为之外。
11. WHERE StorageLayout 为 `none` 且已打开工作区，THE Extension SHALL 展示「当前项目还没有 Kiro 对话历史」提示，并保持 SearchPanel 与 UsageRankingPage 的结构不变。
12. THE LayoutDetector SHALL 以只读方式完成检测，即仅执行路径拼接、存在性判断、目录枚举与 stat。
13. THE LayoutDetector SHALL 在同一磁盘状态下对同一工作区重复返回相同的 StorageLayout 与根路径集合。

### Requirement 2: 双版本工作区路径解析

**User Story:** 作为开发者，我希望扩展用 1.x 的哈希算法定位新会话目录，同时保留旧算法覆盖未迁移的历史，从而不遗漏任一格式的会话。

#### Acceptance Criteria

1. THE PathResolver SHALL 把 WsHash16 计算为 `sha256( workspacePath.replace(/\\/g,'/').toLowerCase() )` 的十六进制前 16 位，并据此把 NewWorkspaceSessionDir 解析为 `<NewSessionsRoot>/<WsHash16>`。
2. WHEN PathResolver 计算 WsHash16，THE PathResolver SHALL 先把路径中的反斜杠替换为正斜杠、再转为小写，最后计算摘要，以匹配 1.x 的规范化规则。
3. THE PathResolver SHALL 对同一逻辑工作区路径的盘符大小写变体与斜杠方向变体产出相同的 WsHash16。
4. THE PathResolver SHALL 对 `d:\Projects\KiroExt\KiroChatSearcher` 产出 WsHash16 `cc5023603866cd91`，对 `d:\SurErp\ERP-OMS-Workspaces` 产出 `6082f0c94c5c4af8`（实测基线）。
5. THE PathResolver SHALL 保留既有 `encodeWorkspaceKeys` 与 `resolveWorkspaceSessionDir` 用于解析 OldWorkspaceSessionDir，且 SHALL 对既有输入返回与本特性实施前相同的输出。
6. THE PathResolver SHALL 保留既有 WorkspaceId 算法（`hash32(原始工作区路径)`，不做规范化）用于定位 0.9x 执行数据目录。
7. IF NewWorkspaceSessionDir 在文件系统中不存在，THEN THE PathResolver SHALL 返回 `null` 表示当前工作区在 1.x 下暂无会话目录，并向调用方返回结果而不抛出异常。
8. THE PathResolver SHALL 分别独立返回 NewWorkspaceSessionDir 与 OldWorkspaceSessionDir 的解析结果，使调用方在 `both` 布局下能同时访问两者。
9. THE PathResolver SHALL 通过可注入依赖（platform / env / homedir / existsSync / statSync）完成新布局解析，使单元测试无需读写真实用户目录。

### Requirement 3: 新格式会话的读取、搜索与预览

**User Story:** 作为用户，我希望在 1.x 目录型会话上照常按关键词搜索标题与正文、看到预览文本与图片/附件角标，与旧格式体验一致。

#### Acceptance Criteria

1. WHEN SearchEngine 枚举 1.x 会话，THE SearchEngine SHALL 以 NewWorkspaceSessionDir 的目录枚举结果为会话来源，并把 SessionIndexFile 排除在会话来源之外，因为该索引为追加式且可能含已删除会话的历史条目。
2. WHEN NewFormatReader 读取一个 NewSessionDir，THE NewFormatReader SHALL 取 NewSessionMetaFile 的 `title` 作为会话标题；WHERE `title` 缺失、为空字符串或仅含空白字符，THE NewFormatReader SHALL 把标题取为 `Untitled`。
3. WHEN NewFormatReader 提取会话的匹配文本与预览文本，THE NewFormatReader SHALL 逐行解析 MessagesFile，并从 `payload.type` 为 `user` 或 `assistant` 的 MessageEvent 中提取文本内容。
4. THE NewFormatReader SHALL 把 `tool_call`、`tool_result`、`session_metadata`、`turn_start`、`turn_end`、`sub_agent_start`、`sub_agent_complete`、`pending_interaction`、`interaction_resolved`、`session_event`、`tombstone` 类型的 MessageEvent 排除在匹配文本之外。
5. WHEN SearchEngine 在 1.x 会话上执行关键词匹配，THE SearchEngine SHALL 以不区分大小写的子串方式先匹配标题、标题未命中再匹配消息文本，并按既有规则设置 `matchField`（`title` / `message` / `recent`）与 snippet 截取长度。
6. WHEN NewFormatReader 判定 `hasImage`，THE NewFormatReader SHALL 在 MessageEvent 的内容项中检测图片标志（内容项 `type` 含 `image`，或存在 `imageUrl` / `image` 字段），在发现首个图片标志后停止该会话的图片检测，并把内嵌 base64 图片数据的读取与比对排除在检测之外。
7. WHEN NewFormatReader 判定 `hasAttachment`，THE NewFormatReader SHALL 依据「MessageEvent 携带非空上下文引用（如 `contextItems`）」或「该会话 SnapshotsDir 存在且含至少一个文件」两个条件的任一成立作为判定依据。
8. IF MessagesFile 的某一行不是合法 JSON，THEN THE NewFormatReader SHALL 跳过该行并继续解析其余行。
9. IF 某个 NewSessionDir 缺少 NewSessionMetaFile 或 MessagesFile，THEN THE NewFormatReader SHALL 跳过该会话、继续处理其余会话，并向调用方返回已成功解析的结果而不抛出异常。
10. THE SearchEngine SHALL 把 1.x 会话的最后修改时间取为 NewSessionMetaFile 的 `lastModifiedAt`；IF `lastModifiedAt` 缺失或不是合法时间戳，THEN THE SearchEngine SHALL 取 MessagesFile 的 mtime 作为最后修改时间。
11. THE NewFormatReader SHALL 复用既有的按 `(mtimeMs, size)` 失效的进程内缓存策略缓存标题、匹配文本、`hasImage` 与 `hasAttachment`，使未变化的会话在重复搜索时复用缓存；1.x 会话的失效判据 SHALL 取 MessagesFile 与 NewSessionMetaFile 的 `(mtimeMs, size)` 组合。
12. THE NewFormatReader SHALL 把内嵌 base64 图片数据排除在缓存内容与匹配范围之外。
13. THE NewFormatReader SHALL 以只读方式访问 NewSessionDir，即仅执行目录枚举、stat 与文件读取。

### Requirement 4: 新格式的 credit 用量读取

**User Story:** 作为用户，我希望在 1.x 会话上仍能看到 credit 用量角标，因为用量数据已从独立执行存档移入消息事件。

#### Acceptance Criteria

1. WHEN CreditReader 读取一个 1.x 会话的用量，THE CreditReader SHALL 逐行解析该会话的 MessagesFile，取出全部 UsageSummaryEvent，并把其中单位标记为 credit（`unit` 值按不区分大小写等于 `credit`）的用量数值累加为该会话的 credit 合计。
2. THE CreditReader SHALL 把 UsageSummaryEvent 中不带 credit 单位标记的项（如工具使用记录）排除在求和之外。
3. WHERE 会话为 1.x 格式，THE CreditReader SHALL 把 `self` 与 `lineage` 两个 CreditScope 的 credit 数值取为同一值，即该会话 MessagesFile 内 UsageSummaryEvent 的合计，因为 1.x 的用量直接记录在会话自身的消息流中。
4. WHERE 会话为 1.x 格式，WHEN 用户悬停 credit 角标，THE SearchPanel SHALL 在 tooltip 中说明该数值来自会话消息流中的用量事件、且两种口径取同一值。
5. WHERE 会话为 0.9x 格式，THE CreditReader SHALL 沿用既有的执行存档查表方式（按 `chatSessionId` 汇总 OldExecutionArchive 的 `usageSummary`）并保留既有的 `self` / `lineage` 双口径语义。
6. THE CreditReader SHALL 把 `hash32(executionId)` → 独立存档文件的查表方式的适用范围限定为 0.9x 会话。
7. IF 某 1.x 会话的 MessagesFile 不含任何 UsageSummaryEvent、或全部 UsageSummaryEvent 均无 credit 单位项，THEN THE CreditReader SHALL 把该会话的 credit 标记为不可用，并向调用方返回结果而不抛出异常。
8. WHERE 某 1.x 会话的 credit 不可用且 NewSessionMetaFile 不含上下文占用百分比字段，THE SearchPanel SHALL 省略该结果项的用量角标，且其余结果项的角标 SHALL 正常展示。
9. THE CreditReader SHALL 依据会话所属格式选择新格式或旧格式取数路径，使同一 SearchHit 上的 credit 角标语义在两种格式下一致（均为该会话消耗的 credit 数）。
10. THE CreditReader SHALL 以只读方式读取 MessagesFile 与 OldExecutionArchive，即仅执行目录枚举、stat 与文件读取。
11. THE CreditReader SHALL 按 MessagesFile 的 `(mtimeMs, size)` 缓存 1.x 会话的 credit 解析结果，使未变化的会话在重复取数时复用缓存。

### Requirement 5: 跳转命令适配

**User Story:** 作为用户，我希望点击搜索结果能在 1.x 里正确打开对应会话，无论它是 1.x 新建的还是从 0.9x 迁移来的。

#### Acceptance Criteria

1. WHEN 用户点击搜索结果或按 Enter 打开会话，THE Extension SHALL 优先以 `executeCommand('kiroAgent.viewSession', sessionId, title)` 调用 JumpCommand。
2. IF `kiroAgent.viewSession` 调用抛出异常或命令不存在，THEN THE Extension SHALL 回退调用 `kiroAgent.sessions.switch(sessionId, windowId, source)`。
3. THE Extension SHALL 把 1.x 的 JumpCommand 候选列表限定为 `kiroAgent.viewSession` 与 `kiroAgent.sessions.switch` 两项，因为 `kiroAgent.showExecutionInChatTab` 与 `kiroAgent.viewSpecSession` 在 1.x 上已移除、`kiroAgent.loadSessionWithPrompt` 的新签名忽略 sessionId 且会向会话发送消息。
4. WHERE StorageLayout 为 `old-only`，THE Extension SHALL 保留既有的 0.9x 候选列表（`kiroAgent.showExecutionInChatTab` → `kiroAgent.viewSpecSession` → `kiroAgent.loadSessionWithPrompt`）作为 1.x 候选之后的降级候选，使旧版 Kiro 上的跳转行为保持不变。
5. WHEN 传入 sessionId，THE Extension SHALL 原样传递该 sessionId，无论其形如 `sess_<uuid>` 还是裸 uuid，且 SHALL 把前缀改写、补齐与截断排除在传参处理之外。
6. WHEN 调用 `kiroAgent.viewSession`，THE Extension SHALL 把该会话的标题作为第二个参数传入；WHERE 标题为空字符串或仅含空白字符，THE Extension SHALL 省略第二个参数。
7. IF 全部 JumpCommand 候选均调用失败，THEN THE Extension SHALL 通过 Kiro 通知展示错误提示，且提示文案 SHALL 列出已尝试的候选命令名以便排查。
8. WHEN JumpCommand 调用成功，THE Extension SHALL 保持 SearchPanel 打开，使用户可继续浏览结果。
9. THE Extension SHALL 依次尝试候选命令并在首个成功的候选处停止，且 SHALL 在结果中给出实际生效的命令名。

### Requirement 6: 新布局的占用扫描、分类与排行列表

**User Story:** 作为担心磁盘占用的用户，我希望占用统计在 1.x 布局下把会话目录、快照与索引正确分类计量并列出每个会话，而不是像现在这样显示 0 个会话。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 把 NewSessionsRoot 与 NewSessionIndexRoot 纳入统计范围，并按以下 StorageCategory 计量：NewSessionMetaFile 与 MessagesFile 计入 `新格式会话`、SnapshotsDir 计入 `新格式快照`、SubExecutionsDir 计入 `新格式子执行`、NewSessionIndexRoot 计入 `新格式索引`。
2. THE StorageAnalyzer SHALL 把 NewSessionDir 下不属于上述分类的文件（含 `publish.cursor`、`publish-sub.cursor`）计入 `新格式会话` 分类。
3. THE StorageAnalyzer SHALL 把 1.x 会话的 SessionFootprint 定义为该 NewSessionDir 内全部文件（含 NewSessionMetaFile、MessagesFile、SnapshotsDir、SubExecutionsDir 及其它文件）的字节数之和。
4. THE StorageAnalyzer SHALL 使 1.x 会话的 SessionFootprint 在 `self` 与 `lineage` 两个 FootprintScope 下取同一值，并以 `additive: true` 标记该数值可跨会话求和，因为 1.x 的快照按会话目录物理隔离。
5. THE StorageAnalyzer SHALL 使各 StorageCategory 的字节数之和等于所统计根范围的总字节数，且各分类覆盖的路径集合两两不相交。
6. THE StorageAnalyzer SHALL 在 1.x 会话占用计量中把 SnapshotsDir 与 SubExecutionsDir 视为 0.9x 执行存档的对应物，使两种格式的「会话本体 + 附件」占用口径在语义上一致。
7. WHERE StorageLayout 为 `both`，THE StorageAnalyzer SHALL 同时计量当前工作区的 NewWorkspaceSessionDir 与 OldWorkspaceSessionDir；WHERE 同一 sessionId 在两处各有一份数据，THE StorageAnalyzer SHALL 以新格式目录作为该会话 SessionFootprint 的来源，并把其旧目录部分计入 LegacyResidue 而不计入该会话的 SessionFootprint。
8. WHERE StorageLayout 为 `new-only` 或 `both`，THE UsageRankingPage SHALL 为当前 NewWorkspaceSessionDir 下的每个 NewSessionDir 渲染一个会话行，并按占用合计与既有 RankingSortOrder 规则排序分页。
9. WHERE 会话为 1.x 格式，THE UsageRankingPage SHALL 把既有的「会话 JSON 字节数」列映射为 NewSessionMetaFile 与 MessagesFile 的字节数之和、把「归因存档字节数」列映射为 SnapshotsDir 与 SubExecutionsDir 的字节数之和，并保持「占用合计」列等于两列之和。
10. WHERE 会话为 1.x 格式，THE UsageRankingPage SHALL 把「最后修改时间」列取为 NewSessionMetaFile 的 `lastModifiedAt`，并按既有的本地时区 `YYYY-MM-DD HH:mm` 格式展示。
11. THE SizeScanner SHALL 使用异步文件系统 API，并在每枚举 512 个目录条目后让出一次事件循环，以保持扩展宿主响应。
12. THE SizeScanner SHALL 只调用目录枚举与 stat 获取字节数，并把被统计文件内容的打开与读取排除在扫描之外。
13. IF 枚举某个目录或 stat 某个文件抛出异常，THEN THE SizeScanner SHALL 跳过该条目、累加 `skippedCount` 并继续统计其余条目，且 THE StorageAnalyzer SHALL 把 `partial` 置为 true 表示返回值为占用下限。
14. THE StorageAnalyzer SHALL 复用既有的按目录 `(mtimeMs, 直接子条目数)` 失效的子树聚合缓存，使未变化的子树在重复统计时被复用。
15. THE StorageAnalyzer SHALL 在同一磁盘状态下对同一 NewSessionDir 重复返回相同的 SessionFootprint。

### Requirement 7: 排行表之上的两个聚合维度

**User Story:** 作为用户，我想在排行表上方一眼看到当前项目的会话总占用与整个 Kiro 的会话总占用，从而判断问题规模。

#### Acceptance Criteria

1. THE UsageRankingPage SHALL 在排行表之上展示 ProjectSessionTotal 与 AllKiroSessionTotal 两个聚合维度。
2. THE UsageRankingPage SHALL 把 ProjectSessionTotal 定义为当前工作区全部会话 SessionFootprint（自身口径）的合计，并在数值旁给出参与统计的会话数。
3. WHEN UsageRankingPage 枚举当前工作区会话以渲染排行，THE Extension SHALL 由同一次枚举结果聚合出 ProjectSessionTotal，并把为该维度额外发起的目录枚举排除在实现之外。
4. WHERE StorageLayout 为 `both`，THE Extension SHALL 使 ProjectSessionTotal 覆盖新格式会话与仅存在于旧目录的未迁移会话，且 SHALL 使每个会话在该合计中恰好被计入一次。
5. THE UsageRankingPage SHALL 为 AllKiroSessionTotal 提供一个手动触发控件。
6. WHEN 用户触发 AllKiroSessionTotal 的计算，THE StorageAnalyzer SHALL 扫描 NewSessionsRoot 下全部工作区目录的会话占用并求和，把结果与参与统计的工作区目录数、会话数一并返回，并把结果缓存以供后续复用。
7. WHERE StorageLayout 为 `old-only`（NewSessionsRoot 不存在），WHEN 用户触发 AllKiroSessionTotal 的计算，THE StorageAnalyzer SHALL 改为扫描 OldSessionsRoot 下全部工作区目录的会话占用并求和，使该维度在未升级到 1.x 的环境下同样给出有意义的数值。
8. WHILE AllKiroSessionTotal 尚未被用户触发，THE UsageRankingPage SHALL 对该维度展示未统计的空闲态提示，且 THE Extension SHALL 把为该维度枚举其它工作区目录的行为排除在此状态之外。
9. WHILE AllKiroSessionTotal 正在计算，THE UsageRankingPage SHALL 展示「统计中…」文本、忽略重复触发并保持同时最多 1 次该维度的统计在执行，且 SHALL 保持排行表可浏览与面板可关闭。
10. THE AllKiroSessionTotal SHALL 仅统计会话数据（NewSessionsRoot 或 OldSessionsRoot 下的会话），并把 LegacyResidue 排除在默认统计范围之外，使主流程不承担约 3.6 GB 旧残留的扫描成本。
11. WHEN 用户悬停 ProjectSessionTotal 或 AllKiroSessionTotal，THE UsageRankingPage SHALL 通过 tooltip 给出参与统计的会话数、工作区目录数、被统计的根路径，以及会话本体与快照两部分的字节数拆解。
12. IF 某聚合维度的扫描存在被跳过的条目（`partial` 为 true），THEN THE UsageRankingPage SHALL 在该数值前展示 `≥` 前缀并在 tooltip 中给出 `skippedCount`，表示该数值为下限值。
13. WHEN 一次清理成功释放的字节数大于 0，THE Extension SHALL 使 ProjectSessionTotal 与 AllKiroSessionTotal 的缓存失效，并在刷新后展示更新后的数值。
14. THE UsageRankingPage SHALL 使用既有的 CSP（`default-src 'none'` 加 nonce）渲染两个聚合维度，并对其中的路径与数值文本执行 HTML 转义后再插入 DOM。

### Requirement 8: 旧残留统计（独立可选维度）

**User Story:** 作为已升级到 1.x 的用户，我想单独知道旧目录里还残留多少数据，但不希望这个重量级扫描拖慢日常统计。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 把 LegacyResidueTotal 定义为 OldSessionsRoot 与 `<OldStoreRoot>/<WorkspaceId>` 下 0.9x 数据的字节数合计与文件数合计。
2. WHERE NewSessionsRoot 存在，THE UsageRankingPage SHALL 把 LegacyResidueTotal 作为独立于 AllKiroSessionTotal 的可选维度展示，并为其提供单独的手动触发控件。
3. WHERE NewSessionsRoot 不存在（StorageLayout 为 `old-only`），THE UsageRankingPage SHALL 隐藏 LegacyResidueTotal 维度，因为此时旧目录数据即主数据且已计入 AllKiroSessionTotal。
4. WHILE LegacyResidueTotal 尚未被用户触发，THE Extension SHALL 把旧残留目录的枚举排除在默认流程之外，使默认流程不承担约 3.6 GB / 7735 文件的扫描成本。
5. WHEN 用户触发 LegacyResidueTotal 的计算，THE StorageAnalyzer SHALL 扫描旧残留目录并返回字节数、文件数与涉及的工作区目录数，并把结果缓存以供复用。
6. THE StorageAnalyzer SHALL 在 LegacyResidueTotal 中把旧数据区分为「已迁移仅残留」与「未迁移」两部分并分别给出字节数：WHERE 某旧会话在 NewSessionsRoot 下存在同 sessionId 的 NewSessionDir、或旧目录内存在指向该 sessionId 的 MigrationMarker，THE StorageAnalyzer SHALL 把该会话计入「已迁移仅残留」；WHERE 上述两个条件均不成立，THE StorageAnalyzer SHALL 把该会话计入「未迁移」。
7. WHEN 展示 LegacyResidueTotal，THE UsageRankingPage SHALL 附带说明文案，指出该数值来自 1.x 手动迁移未搬走的旧数据、与 AllKiroSessionTotal 相互独立、默认不计入后者，且「未迁移」部分的会话在 1.x 界面中不可见。
8. IF 旧目录不存在或不可读，THEN THE StorageAnalyzer SHALL 把 LegacyResidueTotal 标记为不可用并保持其余统计可用，且 THE Extension SHALL 把错误弹窗排除在该情形的处理之外。
9. WHILE LegacyResidueTotal 正在计算，THE UsageRankingPage SHALL 展示「统计中…」文本、忽略重复触发并保持同时最多 1 次该维度的统计在执行，且 SHALL 保持面板其余部分可交互。
10. THE StorageAnalyzer SHALL 以只读方式完成旧残留识别，即仅执行目录枚举、stat 与文件读取。

### Requirement 9: 迁移状态展示

**User Story:** 作为用户，我想在会话列表里区分哪些是 1.x 新建的、哪些是迁移来的、哪些还只存在于旧目录，从而理解每条会话的来源与可清理性。

#### Acceptance Criteria

1. THE Extension SHALL 为每个会话计算 SessionOrigin，取值 `new`、`migrated` 或 `legacy-unmigrated`。
2. WHERE 会话位于 NewSessionDir 且其 sessionId 以 `sess_` 开头，THE Extension SHALL 把该会话的 SessionOrigin 判定为 `new`。
3. WHERE 会话位于 NewSessionDir 且其 sessionId 不以 `sess_` 开头，THE Extension SHALL 把该会话的 SessionOrigin 判定为 `migrated`。
4. WHERE 会话仅存在于 OldWorkspaceSessionDir 且 NewWorkspaceSessionDir 下不存在同 sessionId 的 NewSessionDir，THE Extension SHALL 把该会话的 SessionOrigin 判定为 `legacy-unmigrated`。
5. WHERE 旧目录内存在 `v2SessionId` 指向某 sessionId 的 MigrationMarker，THE Extension SHALL 把该 sessionId 对应会话的 SessionOrigin 判定为 `migrated`。
6. THE UsageRankingPage SHALL 在每个会话行上以 MigrationStatus 指示展示该会话的 SessionOrigin，并通过 tooltip 说明该取值的含义与该会话数据所在的根目录。
7. THE SearchEngine SHALL 在每个 SearchHit 中携带该会话的 SessionOrigin，使 SearchPanel 能在结果项上区分来源。
8. WHERE StorageLayout 为 `both` 且同一 sessionId 在新旧目录各有一份，THE Extension SHALL 以新格式目录作为该会话的展示来源、把其 SessionOrigin 判定为 `migrated`，并在列表中只展示该会话一次。
9. THE Extension SHALL 使 SessionOrigin 的判定在同一磁盘状态下对同一会话重复返回相同取值。

### Requirement 10: 目录型会话的清理安全

**User Story:** 作为想释放空间的用户，我希望能清理 1.x 目录型会话，同时清楚知道会删哪些文件、绝不误删边界之外的东西，因为删除不可撤销。

#### Acceptance Criteria

1. THE SessionCleaner SHALL 是本特性唯一允许写磁盘的模块，且 SHALL 仅使用 WritableFsAllowlist 中的 API：针对单个文件的 `unlink`、针对已清空目录的非递归 `rmdir`、针对 OldSessionManifest 的 `readFile` 与 `writeFile`，以及用于快照与复核的 `lstat`。
2. THE SessionCleaner SHALL 把递归删除 API（如 `rm` 的递归模式）、`rename` 与 `cp` 排除在 WritableFsAllowlist 与模块导入之外。
3. WHERE 会话为 1.x 目录型且清理模式为 AttachmentCleanup，THE SessionCleaner SHALL 把待删除集合取为该 NewSessionDir 下 SnapshotsDir 与 SubExecutionsDir 内已枚举的具体文件，并把 NewSessionMetaFile 与 MessagesFile 排除在该集合之外。
4. WHERE 会话为 1.x 目录型且清理模式为 FullCleanup，THE SessionCleaner SHALL 把待删除集合取为该 NewSessionDir 下已枚举的全部文件，并把「移除已清空的目录」列为附加操作。
5. WHERE 清理模式为 FullCleanup 且全部文件删除成功，WHEN 执行附加操作，THE SessionCleaner SHALL 重新枚举 NewSessionDir 及其子目录确认其为空，并以自底向上的非递归 `rmdir` 逐级移除已确认为空的目录，直至移除 NewSessionDir 本身。
6. IF 重新枚举发现 NewSessionDir 或其子目录仍含文件，THEN THE SessionCleaner SHALL 保留该目录、把该目录与保留原因计入 CleanupResult 的失败列表，并保留已完成的文件删除结果。
7. THE SessionCleaner SHALL 在执行删除前枚举目标范围得到具体文件路径清单与每个文件的字节数、mtime 快照，且 SHALL 只删除该清单中已枚举并在确认提示中计入的文件，把清单生成之后新出现的文件排除在删除范围之外。
8. WHEN 执行删除之前，THE SessionCleaner SHALL 对每个目标路径执行规范化校验，并 SHALL 仅删除规范化后匹配以下三类位置之一的路径：目标 NewSessionDir 之内且位于 NewSessionsRoot 之内的文件、当前工作区 `<OldStoreRoot>/<WorkspaceId>/<ExecutionSavesBucket>` 下的 OldExecutionArchive、当前工作区 OldWorkspaceSessionDir 下的 OldSessionFile。
9. IF 某目标路径的原始形式含 `..` 路径段、规范化后落在上述三类位置之外、指向 OldSessionManifest 本身、或为符号链接，THEN THE SessionCleaner SHALL 拒绝删除该路径并把该路径与拒绝原因计入 CleanupResult 的失败列表。
10. THE SessionCleaner SHALL 把 `rmdir` 的实参范围限定为规范化后位于 NewSessionsRoot 之内、且等于目标 NewSessionDir 或其子目录的路径。
11. WHERE 会话为 0.9x 格式，THE SessionCleaner SHALL 沿用既有的清理语义与既有边界校验：AttachmentCleanup 删除按 `chatSessionId` 归因的 OldExecutionArchive，FullCleanup 追加删除 OldSessionFile 并以 `readFile` + `writeFile` 从 OldSessionManifest 中移除该 sessionId 对应条目。
12. WHEN 展示确认提示，THE SessionCleaner SHALL 以模态确认提示给出清理模式名称、目标会话标题与 sessionId、将释放的字节数、将删除的文件数、以及该操作不可撤销且被删除文件不进入回收站的说明，并 SHALL 把「取消」作为默认按钮。
13. WHERE 清理模式为 FullCleanup 且会话为 1.x 目录型，THE 确认提示 SHALL 说明该操作删除整个会话目录（含消息记录与全部快照），使该模式与 AttachmentCleanup 的差异对用户明确。
14. IF 用户未在确认提示中确认，或 CleanupPlan 的待删除文件数为 0 且无附加操作，THEN THE SessionCleaner SHALL 返回未执行状态并保持全部文件原样；WHERE CleanupPlan 为空计划，THE SessionCleaner SHALL 直接返回未执行状态而不展示确认提示。
15. WHEN 删除每个文件之前，THE SessionCleaner SHALL 对该文件重新执行 stat 复核；IF 该文件已不存在，THEN THE SessionCleaner SHALL 跳过该文件并按释放 0 字节计入跳过计数；IF 该文件的字节数或 mtime 与快照不一致，THEN THE SessionCleaner SHALL 保持该文件不删除并计入跳过计数。
16. IF 删除某个文件因文件锁或拒绝访问类错误失败，THEN THE SessionCleaner SHALL 按既有重试策略（最多 3 次、间隔 200 毫秒）重试；IF 重试后仍失败或删除因其它原因失败，THEN THE SessionCleaner SHALL 把该文件与失败原因计入失败列表并继续删除其余文件。
17. THE SessionCleaner SHALL 在执行删除之前把 CleanupPlan 写入 StorageOutputChannel，使被删除文件清单在删除失败或中断时仍可回溯。
18. WHEN 一次清理执行结束，THE SessionCleaner SHALL 把审计记录写入 StorageOutputChannel，内容 SHALL 包含操作时间、目标 sessionId 与标题、会话格式（1.x 目录型或 0.9x 单文件）、清理模式、每个被删除文件的绝对路径与字节数、每个失败项的路径与原因、每个跳过项的路径与原因，以及成功、失败与跳过三类计数。
19. WHEN 一次清理执行结束，THE Extension SHALL 使 StorageAnalyzer 中受影响的缓存失效（覆盖每个被删除文件自其所在目录向上至所属根的子树聚合缓存），并重新计算 UsageRankingPage 当前页、ProjectSessionTotal、SummaryBar 数值与受影响会话的角标。
20. WHERE 清理模式为 FullCleanup 且 NewSessionDir 已被移除，THE Extension SHALL 在刷新后的排行页、搜索结果与最近列表中把该会话排除在返回结果之外。
21. IF 针对某 sessionId 已有一次清理正在执行，THEN THE SessionCleaner SHALL 拒绝对该 sessionId 的新清理请求、提示该会话的清理正在进行，并保持同一 sessionId 同时最多 1 次清理在执行。

### Requirement 11: 旧残留的清理

**User Story:** 作为已升级到 1.x 的用户，我想在确认后清掉旧目录里那约 3.6 GB 的残留数据，从而真正释放空间。

#### Acceptance Criteria

1. WHERE LegacyResidueTotal 已完成统计，THE UsageRankingPage SHALL 提供针对 LegacyResidue 的清理入口。
2. THE SessionCleaner SHALL 把旧残留清理的待删除集合限定为 LegacyResidueTotal 统计中「已迁移仅残留」部分所枚举的具体文件路径，并把「未迁移」部分排除在待删除集合之外，因为该部分在 1.x 中无对应会话、删除后不可恢复。
3. WHEN 生成旧残留清理的 CleanupPlan，THE SessionCleaner SHALL 给出待删除文件的绝对路径列表、每个文件的字节数与 mtime 快照、字节数合计与文件数合计，并把被排除的「未迁移」文件数与字节数单独列出。
4. WHEN 展示确认提示，THE SessionCleaner SHALL 以模态确认提示给出将释放的字节数与文件数、被排除的「未迁移」文件数与字节数、以及该操作不可撤销且被删除文件不进入回收站的说明，并 SHALL 把「取消」作为默认按钮。
5. THE SessionCleaner SHALL 仅删除规范化后位于 OldSessionsRoot 或 `<OldStoreRoot>/<WorkspaceId>` 之内且已在 CleanupPlan 中枚举的具体文件，并把含 `..` 路径段的路径、越界路径与符号链接排除在删除之外并计入失败列表。
6. IF 旧残留清理的 CleanupPlan 待删除文件数为 0，THEN THE SessionCleaner SHALL 返回未执行状态而不展示确认提示。
7. WHEN 旧残留清理执行结束，THE SessionCleaner SHALL 把审计记录写入 StorageOutputChannel，内容包含每个被删除文件的路径与字节数、每个失败项的路径与原因、以及成功、失败与跳过三类计数。
8. WHEN 旧残留清理执行结束，THE Extension SHALL 使 LegacyResidueTotal 的缓存失效，并在下次展示该维度时反映更新后的数值。
9. IF 针对旧残留已有一次清理正在执行，THEN THE SessionCleaner SHALL 拒绝新的旧残留清理请求并提示清理正在进行。

### Requirement 12: 只读与可写边界、显式手动触发约束

**User Story:** 作为用户，我希望所有统计与读取严格只读、绝不改我的数据，且占用统计只在我主动要求时才跑，避免误改数据或无谓卡顿。

#### Acceptance Criteria

1. THE ReadOnlyPaths SHALL 仅以只读方式访问磁盘，即仅执行目录枚举、stat 与文件读取，并把创建、写入、重命名、移动与删除操作（含临时文件）排除在这些模块的实现之外。
2. THE ReadOnlyPaths 中的各模块 SHALL 把写文件系统 API（`unlink`、`writeFile`、`rmdir`、`rm`、`rename`、`cp`）的导入排除在模块之外，使只读约束在模块依赖图上可被静态审查。
3. THE SessionCleaner SHALL 是本特性唯一允许写磁盘的模块，且其可写调用面 SHALL 限定为 Requirement 10.1 列出的 API 集合。
4. WHEN SearchPanel 或侧边栏视图变为可见，THE Extension SHALL 把为占用统计而做的目录枚举排除在该事件的处理之外，并把 SummaryBar 置为空闲态。
5. WHEN 用户在搜索框输入关键词、清空关键词或切换 AttachmentFilter，THE Extension SHALL 仅执行搜索取数，并把占用的全量枚举排除在这些动作的处理之外。
6. THE Extension SHALL 仅在以下用户显式动作时执行占用的全量枚举：左键点击 ComputeSizeButton、打开或翻页或刷新 UsageRankingPage、触发 AllKiroSessionTotal、触发 LegacyResidueTotal、执行 StorageReportCommand、以及一次清理结束后的刷新。
7. THE StorageAnalyzer SHALL 复用既有的缓存与失效策略缓存统计结果，使未变化的子树与未变化的会话在重复统计时被复用。
8. WHEN 用户左键点击 ComputeSizeButton、打开或刷新 UsageRankingPage、或执行 StorageReportCommand，THE StorageAnalyzer SHALL 忽略既有 60 秒缓存有效期并重新统计。
9. THE Extension SHALL 把统计相关异常的错误通知限定为用户主动触发的动作（StorageReportCommand、打开 UsageRankingPage、触发聚合维度、一次清理操作）所产生的异常。
10. IF 汇总统计整体失败，THEN THE SummaryBar SHALL 展示「占用统计不可用」文本，且 THE Extension SHALL 保持搜索结果与用量角标正常展示。

### Requirement 13: 新旧统一的浏览与搜索视图

**User Story:** 作为用户，我希望在新旧并存时，搜索与最近列表把两种格式的会话统一展示，而不是只看到其中一种。

#### Acceptance Criteria

1. WHERE StorageLayout 为 `both`，THE SearchEngine SHALL 把当前工作区 NewWorkspaceSessionDir 与 OldWorkspaceSessionDir 的会话合并为统一的 SearchHit 列表。
2. WHERE StorageLayout 为 `new-only`，THE SearchEngine SHALL 仅从 NewWorkspaceSessionDir 取数；WHERE StorageLayout 为 `old-only`，THE SearchEngine SHALL 仅从 OldWorkspaceSessionDir 取数。
3. WHERE 同一 sessionId 在新旧目录各有一份，THE SearchEngine SHALL 只保留新格式的一份并把其 SessionOrigin 标记为 `migrated`。
4. THE SearchEngine SHALL 对合并后的 SearchHit 按最后修改时间倒序统一排序，并按既有条数上限截断（关键词搜索 10 条、最近列表 20 条）。
5. THE SearchEngine SHALL 使新旧格式的 SearchHit 具有相同的字段结构（`sessionId`、`title`、`modified`、`snippet`、`matchField`、`hasImage`、`hasAttachment`、`origin`、`layout`），使 SearchPanel 无需按来源分支即可渲染。
6. THE AttachmentFilter SHALL 在合并后的统一列表上按 `hasImage` 与 `hasAttachment` 过滤，并在新旧两种格式的会话上给出一致的过滤语义。
7. WHERE 过滤后结果为空，THE SearchPanel SHALL 展示既有的「没有符合条件的对话」提示。
8. WHEN 用户点击刷新按钮或面板重新变为可见，THE SearchEngine SHALL 按当前关键词与过滤条件重新取数，并对新旧两种格式均按 `(mtimeMs, size)` 校验缓存有效性。

### Requirement 14: 跨平台一致性

**User Story:** 作为在 Windows、macOS 或 Linux 上使用 Kiro 的用户，我希望新旧布局的解析、统计与清理在我的平台上同样正确。

#### Acceptance Criteria

1. THE Extension SHALL 通过 `os.homedir()` 与既有 PathResolver 解析新旧存储根，并把平台专属绝对路径的硬编码排除在实现之外。
2. THE Extension SHALL 使用平台路径分隔符拼接路径，并在判断某路径归属某分类或某清理边界时按路径段边界比较而非裸字符串前缀比较。
3. WHEN 计算 WsHash16，THE PathResolver SHALL 在所有平台上先把反斜杠替换为正斜杠再转为小写后再计算摘要，使同一工作区在各平台得到一致的哈希。
4. WHERE 目标平台的文件系统区分大小写，THE StorageAnalyzer SHALL 按区分大小写的方式匹配十六进制小写形式的目录名（WsHash16、WorkspaceId、ExecutionSavesBucket）。
5. IF 枚举过程中遇到符号链接，THEN THE SizeScanner SHALL 按链接自身条目的字节数计入所在分类，并把跟随链接解析其目标的行为排除在扫描之外，以避免循环与跨卷重复计数。
6. THE Extension SHALL 以 stat 报告的逻辑字节数作为体积口径，并在展示文案中注明该数值不含文件系统簇对齐造成的实际占用差异。

### Requirement 15: 测试覆盖

**User Story:** 作为维护者，我希望双版本解析、新格式读取、统计口径与目录型清理的安全规则被自动化测试锁定，避免适配后悄悄回归或误删文件。

#### Acceptance Criteria

1. THE 测试套件 SHALL 使用既有 vitest + fast-check 组合，且所有涉及文件系统的测试 SHALL 在临时目录中构造夹具并在结束后清理。
2. THE 测试套件 SHALL 以示例测试验证 WsHash16 算法：对 `d:\Projects\KiroExt\KiroChatSearcher` 断言结果为 `cc5023603866cd91`、对 `d:\SurErp\ERP-OMS-Workspaces` 断言结果为 `6082f0c94c5c4af8`，并断言盘符大小写与斜杠方向的变体得到同一哈希。
3. THE 测试套件 SHALL 以示例测试验证既有 0.9x 路径解析（`encodeWorkspaceKeys`、`resolveWorkspaceSessionDir`、WorkspaceId）在本特性实施后输出不变。
4. THE 测试套件 SHALL 以示例测试验证 LayoutDetector 在 `new-only`、`old-only`、`both`、`none` 四种夹具下返回对应的 StorageLayout，并验证 EnvChecker 在 `new-only` 与 `old-only` 夹具下均返回 `ok`。
5. THE 测试套件 SHALL 以示例测试验证 NewFormatReader 从 messages.jsonl 夹具提取标题、预览文本、`hasImage` 与 `hasAttachment`，并验证单行损坏时该行被跳过而其余行继续解析。
6. THE 测试套件 SHALL 以示例测试验证 CreditReader 在 1.x 夹具上按 credit 单位过滤并汇总 usage_summary 事件、在 0.9x 夹具上沿用既有存档查表，且 1.x 会话的 `self` 与 `lineage` 口径取同一值。
7. THE 测试套件 SHALL 以属性测试验证 1.x 会话占用的可加性：某 NewWorkspaceSessionDir 的统计字节数恒等于其下各 NewSessionDir 的 SessionFootprint 之和。
8. THE 测试套件 SHALL 以属性测试验证统计的幂等性：连续两次统计同一未变化夹具返回相同结果。
9. THE 测试套件 SHALL 以属性测试验证分类的完备与互斥：各 StorageCategory 字节数之和恒等于所统计根范围总字节数，且各分类路径集合两两不相交。
10. THE 测试套件 SHALL 以示例测试验证只读约束：一次完整统计（含排行页取数与两个聚合维度）前后夹具目录的文件列表、字节数与修改时间保持不变。
11. THE 测试套件 SHALL 以属性测试验证目录型清理的封闭性：`unlink` 实际接收的路径集合恒为 CleanupPlan 中已枚举文件集合的子集，且 `rmdir` 实际接收的路径恒位于目标 NewSessionDir 之内。
12. THE 测试套件 SHALL 以示例测试验证清理边界：含 `..` 路径段的路径、越界路径与符号链接被拒绝删除并计入失败列表。
13. THE 测试套件 SHALL 以示例测试验证 FullCleanup 的目录移除：全部文件删除成功后 NewSessionDir 被移除；目录内残留额外文件时该目录被保留并计入失败列表。
14. THE 测试套件 SHALL 以示例测试验证 0.9x 清理路径不变：AttachmentCleanup 与 FullCleanup 的待删除集合、OldSessionManifest 读改写结果与本特性实施前一致。
15. THE 测试套件 SHALL 以示例测试验证跳转适配：`kiroAgent.viewSession` 可用时优先调用并传入 sessionId 与标题、不可用时回退 `kiroAgent.sessions.switch`，且 1.x 候选列表中不含 `kiroAgent.loadSessionWithPrompt`。
16. THE 测试套件 SHALL 以示例测试验证合并去重：`both` 布局下同 sessionId 的迁移会话只返回一份且其 SessionOrigin 为 `migrated`。
17. THE 测试套件 SHALL 以示例测试验证 SessionOrigin 判定：`sess_` 前缀会话为 `new`、新目录中的裸 uuid 会话为 `migrated`、仅存在于旧目录的会话为 `legacy-unmigrated`。
18. THE 测试套件 SHALL 以示例测试验证聚合维度的手动触发约束：在未触发 AllKiroSessionTotal 与 LegacyResidueTotal 时，注入的枚举依赖未被调用于其它工作区目录与旧残留目录。

### Requirement 16: 文档更新

**User Story:** 作为使用者或后续维护者，我希望 README 说明新旧双布局的差异、迁移状态含义与两个聚合维度，避免误读数字或误删数据。

#### Acceptance Criteria

1. THE README SHALL 描述 1.x 新存储布局（`~/.kiro/sessions/<WsHash16>/<sessionId>/` 的目录结构、`session.json`、`messages.jsonl`、`snapshots/`、`sub-executions/`、`session-index/`）与 0.9x 旧布局的差异。
2. THE README SHALL 说明 WsHash16 算法及其与旧 WorkspaceId 算法的区别，并给出双版本路径解析在四种 StorageLayout 下的行为。
3. THE README SHALL 说明 1.x credit 用量来自 `messages.jsonl` 的 `usage_summary` 事件、旧的 `hash32(executionId)` 查表已失效，以及 1.x 会话上两种 `Σ` 口径取同一值的原因。
4. THE README SHALL 说明 1.x 跳转命令 `kiroAgent.viewSession` 与备用 `kiroAgent.sessions.switch`，并注明旧命令已移除、`loadSessionWithPrompt` 因忽略 sessionId 且有发送消息副作用而不再作为 1.x 候选。
5. THE README SHALL 说明 SessionOrigin 的三种取值（`new`、`migrated`、`legacy-unmigrated`）及其判定依据，并说明未迁移会话在 1.x 界面中不可见这一事实。
6. THE README SHALL 说明排行表之上的 ProjectSessionTotal 与 AllKiroSessionTotal 两个维度的口径与触发方式，以及 LegacyResidueTotal 作为独立可选维度、默认不计入 AllKiroSessionTotal 的原因。
7. THE README SHALL 列出新增 StorageCategory（`新格式会话`、`新格式快照`、`新格式子执行`、`新格式索引`）各自对应的磁盘路径，便于用户自行核对。
8. THE README SHALL 说明 1.x 目录型会话的 AttachmentCleanup 与 FullCleanup 各自删除的内容（含 FullCleanup 会移除已清空的会话目录）、删除不可撤销且不进回收站，以及旧残留清理默认排除「未迁移」数据的规则。
9. THE README SHALL 说明占用统计仅在用户显式触发时执行、ReadOnlyPaths 严格只读、SessionCleaner 为唯一可写模块及其 API 白名单，以及清理审计记录写入 StorageOutputChannel。
