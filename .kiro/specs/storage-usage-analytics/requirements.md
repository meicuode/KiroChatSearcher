# Requirements Document

## Introduction

Kiro 把聊天历史与执行数据强制写在系统盘的用户数据目录（Windows 为 `%APPDATA%\Kiro`），且未提供改位置的设置项。长期使用后该目录会膨胀到数 GB，用户无从得知"到底是什么占的盘、哪次对话最重"。

本特性在现有 Kiro Chat Search 扩展（v0.4.3）中新增**存储占用统计与会话清理**能力：统计 Kiro 用户数据目录的总占用与分类构成、统计每个会话的占用、单独识别出不被任何现存会话引用的"孤儿执行存档"占用量，并允许用户在占用排行页上对指定会话执行附件清理或全量清理以释放空间。

### 实地调研依据（本机实测，Kiro 用户数据目录共 4.5 GB）

| 组成部分 | 磁盘位置 | 体积 | 文件数 |
| --- | --- | --- | --- |
| 执行存档 | `<workspaceId>/<hash32("KIRO::EXECUTION::SAVES")>/<hash32(executionId)>` | **2.89 GB（85%）** | 1280 |
| 源码文件快照 | `<workspaceId>/74a08cf8…/<hash>/<相对源码路径>` | 371 MB | 4849 |
| 运行日志 | `logs/` | 183 MB | — |
| 对话 JSON | `workspace-sessions/<EncodedKey>/<sessionId>.json` | **仅 27.6 MB** | 188 个会话 |

结论直接决定了本特性的统计口径：**吃盘的是执行存档，不是对话 JSON**。若"每个对话的占用"只统计会话 JSON，会把 GB 级问题误报成 MB 级。因此会话占用必须等于「会话 JSON 大小 + 按 `chatSessionId` 归因到它的执行存档大小」。扩展的 `src/credits.ts` 已具备这套归因能力（含 checkpoint lineage 追溯），本特性复用同一套归因逻辑与缓存策略，仅额外记录文件字节大小。

### 统计的触发方式：显式手动触发

按会话遍历统计磁盘占用是 IO 密集操作（数千个文件的枚举与 stat），因此本特性**不在视图可见时自动统计**。所有全量取数都由用户显式动作触发：过滤标签行新增的 ComputeSizeButton（左键统计、右键打开排行页）、UsageRankingPage 的打开与翻页、StorageReportCommand。未触发前 SummaryBar 处于空闲态，扩展不进行任何为统计而做的目录枚举。

### 排行页与报告命令并存的结论

本特性同时保留 UsageRankingPage（webview）与既有 StorageReportCommand（输出通道报告），两者不互相取代，理由：

- **定位不同**：UsageRankingPage 只覆盖**当前项目**的会话，提供分页、排序与逐行清理入口，是交互式操作面；StorageReportCommand 覆盖**全部工作区**并给出分类构成与孤儿合计，是一次性诊断快照。
- **输出形态不同**：报告为纯文本，可整段复制并粘贴到 issue 或工单；排行页无法承担这一用途。
- **审计复用**：清理操作的审计记录写入与报告相同的输出通道，保留该通道使"报告 + 删除记录"位于同一处可回溯的文本流中。

### 范围与非目标

本次实现覆盖：只读统计（汇总、会话归因、孤儿识别）、占用排行页、指定会话的附件清理与全量清理。

以下内容明确不在本次范围内：

- **孤儿存档的批量清理**：不提供入口，仅统计与展示。理由见 Requirement 3.7——孤儿存档无法归因到排行页上的任一会话行，无法满足"只删除已枚举并展示给用户的具体文件"这一安全前提。
- **本次不做**：递归删除目录或删除目录本身；修改 Kiro 存储位置；统计结果的持久化落盘；跨机器/云端聚合；后台定时扫描或常驻监视；删除操作的撤销与回收站。

## Glossary

- **Kiro**: VSCode 衍生的 AI 编辑器，本扩展宿主环境。
- **Extension**: 本扩展（Kiro Chat Search）整体。
- **UserDataDir**: Kiro 用户数据目录。Windows 为 `%APPDATA%\Kiro`；macOS 为 `~/Library/Application Support/Kiro`；Linux 为 `${XDG_CONFIG_HOME:-~/.config}/Kiro`。由既有 `PathResolver` 解析。
- **PathResolver**: 既有的跨平台路径解析模块（`src/paths.ts`）。
- **StoreRoot**: 执行数据与会话数据的公共根目录 `<UserDataDir>/User/globalStorage/kiro.kiroagent`。
- **SessionsRoot**: `<StoreRoot>/workspace-sessions`。
- **EncodedKey**: 工作区绝对路径经 base64url 变体编码后的目录名（既有 `encodeWorkspaceKeys` 规则）。
- **WorkspaceSessionDir**: `<SessionsRoot>/<EncodedKey>`，某个工作区的会话目录。
- **SessionFile**: 单个会话 JSON 文件 `<sessionId>.json`。
- **SessionManifest**: 会话目录下的 `sessions.json` 清单文件，非会话记录；顶层为数组，每项含 `sessionId`、`title` 等字段。
- **WorkspaceId**: `hash32(工作区 fsPath)`，即 sha256 十六进制前 32 位；`<StoreRoot>/<WorkspaceId>` 为该工作区的执行数据目录。
- **BucketDir**: `<StoreRoot>/<WorkspaceId>/<hash32(常量)>` 形式的分桶目录。已知桶为 **ExecutionSavesBucket**（`hash32("KIRO::EXECUTION::SAVES")`）与 **ExecutionMetadataBucket**（`hash32("KIRO::EXECUTION::METADATA")`）；其余桶为 **UnclassifiedBucket**（实测包含源码文件快照）。
- **ExecutionArchive**: ExecutionSavesBucket 下以 `hash32(executionId)` 命名的执行存档文件，内含 `chatSessionId`、`operations`、`usageSummary`。也称"会话附件"。
- **StorageAnalyzer**: 本特性新增的统计模块，负责分类统计、会话归因统计与孤儿统计。
- **SizeScanner**: StorageAnalyzer 内的目录体积扫描器，只做目录枚举与 stat，不读取文件内容。
- **ArchiveIndex**: 既有 `src/credits.ts` 的执行存档进程内索引（键为存档绝对路径，按 `(mtimeMs, size)` 失效），本特性在其条目上复用已有的 `size` 与 `chatSessionId`。
- **SelfFootprint**: 会话的**自身口径**占用 = 该 SessionFile 字节数 + 所有 `chatSessionId` 等于该 sessionId 的 ExecutionArchive 字节数之和。
- **LineageFootprint**: 会话的**累计口径**占用 = 该 SessionFile 字节数 + 所有 `chatSessionId` 属于该会话 lineage 集合（含 checkpoint 祖先会话，判定方式与既有 credit lineage 一致）的 ExecutionArchive 字节数之和。
- **FootprintScope**: 会话占用的展示口径，取值 `self` 或 `lineage`，与既有 `Σ` 开关共用同一状态。
- **LiveSessionIds**: 所有 WorkspaceSessionDir 下现存 SessionFile 的 sessionId 与各 SessionManifest 中出现的 sessionId 的并集。
- **OrphanArchive**: `chatSessionId` 缺失、或 `chatSessionId` 不属于 LiveSessionIds 的 ExecutionArchive。
- **StorageCategory**: 总占用的分类维度，取值为 `对话 JSON`、`执行存档`、`执行索引`、`其他/未分类`、`运行日志`、`工作区存储`、`其他文件`。
- **StorageSummary**: 一次统计的结果对象，含 UserDataDir 总字节数、各 StorageCategory 字节数与文件数、当前工作区字节数、孤儿存档字节数与文件数、`partial` 标记与 `skippedCount`。
- **ProjectFootprintTotal**: 当前工作区全部会话的 SelfFootprint 合计（可相加口径）。
- **ResultSetFootprintTotal**: 当前搜索结果列表中已展示会话的 SelfFootprint 合计。
- **SummaryBar**: 搜索面板顶部（过滤标签行内）的汇总展示区。
- **ComputeSizeButton**（计算占用按钮）: 过滤标签行内新增的按钮，位于既有 `Σ`（credit 口径切换）按钮**左侧**；左键点击触发一次占用统计，右键点击打开 UsageRankingPage。
- **IdleState**（空闲态）: SummaryBar 在用户尚未点击 ComputeSizeButton 时的初始状态，展示提示文案而非数值，且此时不发生任何为统计而做的目录枚举。
- **SizeBadge**: 每条搜索结果上新增的占用角标（如 `12.3MB`）。
- **UsageRankingPage**（占用排行页）: 新增的独立 webview 面板，标题「Kiro 存储占用排行」，分页展示当前项目全部会话的占用并提供逐行清理入口。
- **RankingPageSize**: UsageRankingPage 每页展示的会话条数，固定为 50。
- **RankingSortOrder**: UsageRankingPage 的排序方向，取值 `desc`（默认，占用由高到低）或 `asc`。
- **StorageReportCommand**: 既有命令 `kiroChatSearch.storageReport`（标题「Kiro: 存储占用分析」），输出按工作区与会话的占用排行。
- **OpenRankingCommand**: 新增命令 `kiroChatSearch.storageRanking`（标题「Kiro: 存储占用排行」），打开 UsageRankingPage。
- **SessionCleaner**: 本特性新增的清理模块，负责生成 CleanupPlan、执行删除、更新 SessionManifest 与输出审计记录。
- **AttachmentCleanup**（附件清理，模式 A）: 只删除归因到目标会话的 ExecutionArchive 文件，保留 SessionFile 与 SessionManifest 条目。
- **FullCleanup**（全量清理，模式 B）: 删除归因到目标会话的 ExecutionArchive 文件与该会话的 SessionFile，并从 SessionManifest 中移除该 sessionId 对应条目。
- **CleanupPlan**: 一次清理的预演结果，含模式、目标 sessionId、待删除文件的绝对路径列表、字节数合计、文件数合计、以及被保留的引用冲突文件列表。
- **ReferencedArchive**: CleanupPlan 中被目标会话之外的任一现存会话的 credit lineage 集合引用的 ExecutionArchive。
- **CleanupResult**: 一次清理的执行结果，含成功删除的文件数与字节数、失败的文件数与失败原因、SessionManifest 是否更新成功。
- **CleanupAuditLog**: 清理操作写入 Kiro 输出通道的审计记录，与 StorageReportCommand 复用同一输出通道。
- **ReadOnlyPaths**（只读路径）: 本特性中只允许读磁盘的代码路径集合，含 StorageAnalyzer、SizeScanner、报告渲染与 UsageRankingPage 取数。
- **WritableFsAllowlist**: 清理路径允许使用的写文件系统 API 白名单，仅含针对单个文件的 `unlink`（或其 Promise 形式）与针对 SessionManifest 的读改写（`readFile` + `writeFile`）。
- **SizeFormatter**: 字节数到可读文本的纯函数格式化器。
- **StorageCache**: StorageAnalyzer 的进程内统计缓存，含目录聚合结果与其失效判据。

## Requirements

### Requirement 1: 定位统计范围与分类构成

**User Story:** 作为担心 C 盘被占满的用户，我想知道 Kiro 到底占了多少空间、是什么在占，这样我能判断问题严重程度与后续该清理什么。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 通过既有 PathResolver 获取 UserDataDir，并以 UserDataDir 为统计根范围。
2. IF PathResolver 返回的 UserDataDir 为 `null`，THEN THE StorageAnalyzer SHALL 返回 `unavailable` 状态的 StorageSummary，且 SHALL 不抛出异常。
3. THE StorageAnalyzer SHALL 在 StorageSummary 中给出 UserDataDir 的总字节数与总文件数。
4. THE StorageAnalyzer SHALL 把 `<SessionsRoot>` 下的字节数计入 `对话 JSON` 分类。
5. THE StorageAnalyzer SHALL 通过 `hash32("KIRO::EXECUTION::SAVES")` 与 `hash32("KIRO::EXECUTION::METADATA")` 计算已知 BucketDir 名称，并分别把其字节数计入 `执行存档` 与 `执行索引` 分类。
6. THE StorageAnalyzer SHALL 把 `<StoreRoot>/<WorkspaceId>` 下不匹配任一已知 BucketDir 名称的目录字节数计入 `其他/未分类` 分类，并在 StorageSummary 中标注该分类实测包含源码文件快照。
7. THE StorageAnalyzer SHALL 把 `<UserDataDir>/logs` 的字节数计入 `运行日志` 分类，把 `<UserDataDir>/User/workspaceStorage` 的字节数计入 `工作区存储` 分类。
8. THE StorageAnalyzer SHALL 把 UserDataDir 下不属于上述任一分类的字节数计入 `其他文件` 分类。
9. THE StorageAnalyzer SHALL 使各 StorageCategory 的字节数之和等于 UserDataDir 总字节数，且各分类覆盖的路径集合两两不相交。
10. THE StorageAnalyzer SHALL 在 StorageSummary 中给出当前工作区归属的字节数，其值为当前工作区的 WorkspaceSessionDir 字节数与 `<StoreRoot>/<WorkspaceId>` 字节数之和。

### Requirement 2: 单个会话的占用口径与归因

**User Story:** 作为用户，我想看到每条对话各自占多少空间，且这个数字要包含真正吃盘的执行存档，这样我能找出该优先处理的对话。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 把会话的 SelfFootprint 定义为该 SessionFile 字节数与所有 `chatSessionId` 等于该 sessionId 的 ExecutionArchive 字节数之和。
2. THE StorageAnalyzer SHALL 把会话的 LineageFootprint 定义为该 SessionFile 字节数与所有 `chatSessionId` 属于该会话 lineage 集合的 ExecutionArchive 字节数之和，其 lineage 集合的判定方式与既有 credit lineage（顺 `history[].executionId` 反查所属会话）完全一致。
3. THE StorageAnalyzer SHALL 在自身口径下使每个 ExecutionArchive 最多归因到一个会话，因此 `所有 LiveSessionIds 的自身口径存档部分之和 + 孤儿存档字节数 = 执行存档分类总字节数`（守恒性质）。
4. WHERE FootprintScope 为 `lineage`，THE StorageAnalyzer SHALL 允许同一 ExecutionArchive 被计入多个会话的 LineageFootprint，且 SHALL 在返回结果中以 `additive: false` 标记该口径不可跨会话求和。
5. WHERE FootprintScope 为 `self`，THE StorageAnalyzer SHALL 在返回结果中以 `additive: true` 标记该口径可跨会话求和。
6. THE StorageAnalyzer SHALL 把 SessionManifest 的字节数排除在任何会话的占用之外，并单独作为会话目录的共享开销计入 `对话 JSON` 分类。
7. THE StorageAnalyzer SHALL 把 UnclassifiedBucket 下的源码文件快照排除在会话占用之外，理由为其目录名不含可归因到会话的标识。
8. IF 某会话在 ArchiveIndex 中没有任何 `chatSessionId` 匹配的 ExecutionArchive，THEN THE StorageAnalyzer SHALL 把该会话占用取为其 SessionFile 字节数本身（不纳入清单、快照或其它任何组成部分），并以 `archivesFound: false` 标记存档部分缺失。
9. THE StorageAnalyzer SHALL 在同一输入下对同一会话返回相同的占用数值（统计过程无副作用且可重复）。

### Requirement 3: 孤儿执行存档统计

**User Story:** 作为用户，我想知道有多少空间被"已经没有任何对话引用"的残留存档占着，这样我能判断后续清理能释放多少。

#### Acceptance Criteria

1. WHEN 对所有 WorkspaceSessionDir 的 SessionFile 枚举与 SessionManifest 解析全部完成，THE StorageAnalyzer SHALL 由两者的 `sessionId` 并集构建 LiveSessionIds 集合。
2. WHILE 上述枚举与解析尚未完成，THE StorageAnalyzer SHALL 把孤儿统计标记为 `pending`，且 SHALL 不基于不完整的 LiveSessionIds 判定任何 OrphanArchive。
3. THE StorageAnalyzer SHALL 把 `chatSessionId` 缺失、或 `chatSessionId` 不属于 LiveSessionIds 的 ExecutionArchive 判定为 OrphanArchive。
4. THE StorageAnalyzer SHALL 在 StorageSummary 中给出 OrphanArchive 的字节数合计与文件数合计。
5. IF LiveSessionIds 集合为空（会话目录不存在、全部不可读、或目录存在但有效会话数为 0），THEN THE StorageAnalyzer SHALL 把孤儿统计标记为 `unknown` 而不是把全部存档判为孤儿。
6. THE StorageAnalyzer SHALL 在展示孤儿统计时附带说明文案，指出该数值来源于 Kiro 执行存档的 LRU 索引只淘汰内存条目、磁盘文件残留这一机制。
7. THE StorageAnalyzer SHALL 以只读方式完成孤儿识别，且 SHALL 不提供孤儿存档的批量清理入口；THE StorageAnalyzer SHALL 在孤儿统计的说明文案中给出该限制的理由，即孤儿存档不归属于 UsageRankingPage 上任一可展示的会话行，无法满足 Requirement 14.8 的"只删除已枚举并展示给用户的具体文件"约束。
8. WHERE 某 ExecutionArchive 因 FullCleanup 删除了其对应的 SessionFile 与 SessionManifest 条目而失去引用，THE StorageAnalyzer SHALL 在下一次统计中把该存档判定为 OrphanArchive。

### Requirement 4: 面板汇总展示与手动触发

**User Story:** 作为用户，我希望占用统计只在我主动要求时才跑，因为它要遍历上千个文件；同时我要能一眼看到当前项目占了多少、当前这批搜索结果占了多少。

#### Acceptance Criteria

1. THE SummaryBar SHALL 展示三项数值：ProjectFootprintTotal（当前项目全部会话占用）、ResultSetFootprintTotal（当前结果列表展示会话的占用合计）、孤儿存档占用。
2. WHEN 搜索面板或侧边栏视图变为可见，THE Extension SHALL 把 SummaryBar 置为 IdleState 并展示提示用户点击 ComputeSizeButton 的文案，且 SHALL 不触发任何为统计而做的目录枚举。
3. THE ComputeSizeButton SHALL 展示在既有 `Σ` 按钮的左侧，且 SHALL 通过 tooltip 说明左键统计当前项目占用、右键打开 UsageRankingPage。
4. WHEN 用户左键点击 ComputeSizeButton，THE Extension SHALL 触发一次占用统计，统计范围为当前工作区的全部会话与当前结果列表展示的会话，并在完成后把 SummaryBar 的三项数值替换为统计结果。
5. WHILE 该统计尚未完成，THE SummaryBar SHALL 展示「统计中…」文本、THE ComputeSizeButton SHALL 展示忙碌态并忽略重复的左键点击，且 THE Extension SHALL 允许用户正常输入关键词与浏览搜索结果。
6. WHEN 用户在统计完成后再次左键点击 ComputeSizeButton，THE Extension SHALL 强制重新执行一次统计，忽略 StorageCache 的 60 秒有效期。
7. WHEN 用户右键点击 ComputeSizeButton，THE Extension SHALL 打开 UsageRankingPage，且 SHALL 不改变 SummaryBar 的当前状态。
8. WHEN 用户点击面板既有的刷新按钮，THE Extension SHALL 仅重新取搜索结果，且 SHALL 不触发占用统计。
9. THE SummaryBar SHALL 展示在既有过滤标签行同一区域内，并在容器宽度不足时以省略号截断，保持既有过滤标签、ComputeSizeButton、`Σ` 按钮与刷新按钮可点击。
10. WHEN 用户悬停 SummaryBar 的任一数值，THE SummaryBar SHALL 通过 tooltip 给出会话 JSON 字节数与归因存档字节数的拆解、参与统计的会话数与结果条数；WHERE StorageCache 中已存在全量分类统计结果，THE SummaryBar SHALL 在同一 tooltip 中附加各 StorageCategory 的明细字节数与对应磁盘路径。
11. IF StorageSummary 的 `partial` 为 true，THEN THE SummaryBar SHALL 在数值前展示 `≥` 前缀并在 tooltip 中给出被跳过的条目数，表示该数值为下限值。
12. WHEN 一次 CleanupResult 返回成功删除的字节数大于 0，THE Extension SHALL 重新计算并刷新 SummaryBar 的三项数值。

### Requirement 5: 结果角标展示会话占用

**User Story:** 作为用户，我希望在每条搜索结果上直接看到它占多少空间，方便与 credit 消耗一起横向比较。

#### Acceptance Criteria

1. THE SizeBadge SHALL 在每条搜索结果的角标区展示该会话的占用文本，与既有 credit 角标并列展示。
2. WHEN 用户切换既有 `Σ` 开关，THE SizeBadge SHALL 同步把 FootprintScope 切换为对应口径（`self` 或 `lineage`）并重新渲染数值。
3. WHERE 会话占用的存档部分缺失（`archivesFound: false`），THE SizeBadge SHALL 展示会话 JSON 的字节数，并在 tooltip 中说明存档数据不可用或已被淘汰。
4. IF 某会话的占用数值无法取得，THEN THE SizeBadge SHALL 对该条结果省略角标，且其余结果的角标 SHALL 正常展示。
5. WHEN 渲染 SizeBadge 的 tooltip，THE SizeBadge SHALL 分行给出会话 JSON 字节数与归因存档字节数的拆解。
6. WHERE 会话占用大于或等于 100 MB，THE SizeBadge SHALL 采用警示配色以提示该会话为主要占用来源。

### Requirement 6: 存储占用分析命令

**User Story:** 作为用户，我想要一份完整的占用排行，跨工作区看清哪个项目、哪次对话最重。

#### Acceptance Criteria

1. THE Extension SHALL 注册命令 `kiroChatSearch.storageReport`，命令标题为「Kiro: 存储占用分析」。
2. WHEN 用户执行 StorageReportCommand，THE Extension SHALL 输出包含四个区块的报告：分类构成、按工作区排行、按会话排行、孤儿存档合计。
3. THE StorageReportCommand SHALL 按占用字节数降序排列工作区与会话，且会话排行 SHALL 默认展示前 50 条并给出被省略的条目数。
4. WHERE 可统计的会话数为 0，THE StorageReportCommand SHALL 展示空的排行区块与「省略 0 条」，且 SHALL 保持四个区块的结构不变（不以提示文案替换排行区块）。
5. THE StorageReportCommand SHALL 把 WorkspaceSessionDir 的 EncodedKey 解码回工作区绝对路径用于展示；IF 解码失败或解码结果非合法路径，THEN THE StorageReportCommand SHALL 展示原始目录名。
6. WHILE StorageReportCommand 正在执行，THE Extension SHALL 通过 Kiro 进度提示展示当前进度并提供取消入口。
7. WHEN 用户取消 StorageReportCommand，THE Extension SHALL 在 1 秒内停止继续枚举目录，且 SHALL 保留已完成的部分统计结果于 StorageCache 中供下次复用。
8. THE StorageReportCommand SHALL 把报告写入 Kiro 输出通道以支持滚动浏览与复制，且 SHALL 在执行全过程中不创建、写入、重命名、移动或删除任何磁盘文件（含临时文件与随后被清理的文件）。
9. THE StorageReportCommand SHALL 在会话排行中使用自身口径（`self`）以保证各行数值可相加。
10. THE StorageReportCommand SHALL 与 UsageRankingPage 并存：THE StorageReportCommand SHALL 覆盖全部工作区并输出可整段复制的纯文本，THE UsageRankingPage SHALL 只覆盖当前工作区并提供清理入口；THE StorageReportCommand SHALL 不提供任何清理入口。
11. THE StorageReportCommand SHALL 在孤儿存档区块的说明文案中注明孤儿存档不提供批量清理，且 SHALL 不使用暗示"本版本不提供任何清理能力"的表述。

### Requirement 7: 性能、缓存与扫描预算

**User Story:** 作为用户，我不接受为了算体积就把几 GB 目录全量遍历一遍导致编辑器卡顿，统计必须是可承受的。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 复用 ArchiveIndex 已记录的 `size` 与 `chatSessionId` 计算会话占用，且 SHALL 不出于任何目的（含计算、校验或修复）读取 ExecutionArchive 的文件内容；存档内容的读取 SHALL 仅由既有 credit 索引模块承担。
2. THE StorageAnalyzer SHALL 仅对当前展示的结果集（最近列表默认 20 条、关键词搜索默认 10 条）计算 SizeBadge 所需的会话占用，且 SHALL 不为渲染结果而枚举其它工作区的目录。
3. THE SizeScanner SHALL 使用异步文件系统 API，且 SHALL 在每处理 512 个目录条目后让出一次事件循环，以保持扩展宿主响应。
4. THE SizeScanner SHALL 只调用目录枚举与 stat 获取字节数，且 SHALL 不打开或读取被统计文件的内容。
5. THE StorageAnalyzer SHALL 把汇总统计结果缓存在 StorageCache 中，缓存有效期为 60 秒；WHILE 缓存在有效期内且未被强制刷新，THE StorageAnalyzer SHALL 直接返回缓存结果而不重新枚举目录。
6. THE StorageAnalyzer SHALL 按目录路径缓存子树聚合结果，并以该目录的 `(mtimeMs, 直接子条目数)` 作为失效判据，使未变化的子树在重复统计时被复用。
7. WHEN 用户在搜索框输入关键词，THE Extension SHALL 不触发全量目录枚举，仅按 Requirement 7.2 计算展示结果集的占用。
8. THE SizeScanner SHALL 把单次全量枚举的递归深度限制为不超过 8 层，超出深度的子树 SHALL 被计为跳过条目并使 StorageSummary 的 `partial` 置为 true。
9. THE StorageAnalyzer SHALL 复用既有 4 秒目录扫描节流策略刷新 ArchiveIndex，且 SHALL 不新增独立的后台定时扫描。
10. WHEN 用户左键点击 ComputeSizeButton、打开或刷新 UsageRankingPage、或执行 StorageReportCommand，THE StorageAnalyzer SHALL 忽略 StorageCache 的 60 秒有效期并重新统计，且 SHALL 仍然遵守 4 秒 ArchiveIndex 节流窗口。
11. THE StorageAnalyzer SHALL 使统计过程的常驻内存增量与被统计文件的字节数无关，即 SHALL 只保存每个条目的路径、字节数与分类标记。
12. THE StorageAnalyzer SHALL 仅在用户显式动作（左键点击 ComputeSizeButton、打开或翻页 UsageRankingPage、执行 StorageReportCommand、清理完成后的刷新）触发时执行全量枚举，且 SHALL 不因视图可见、结果渲染或关键词输入而执行全量枚举。
13. THE UsageRankingPage SHALL 复用 StorageCache 与 ArchiveIndex 取数；WHEN 用户在 UsageRankingPage 内翻页或切换 RankingSortOrder，THE Extension SHALL 不重新枚举目录。

### Requirement 8: 跨平台一致性

**User Story:** 作为在 Windows、macOS 或 Linux 上使用 Kiro 的用户，我希望统计功能在我的平台上同样可用。

#### Acceptance Criteria

1. THE StorageAnalyzer SHALL 在 Windows、macOS、Linux 三个平台上复用既有 PathResolver 的 UserDataDir 解析结果，且 SHALL 不硬编码平台专属绝对路径。
2. THE StorageAnalyzer SHALL 使用平台路径分隔符拼接与比较路径，且在判断某路径是否属于某分类时 SHALL 按路径段边界比较而非裸字符串前缀比较。
3. WHERE 目标平台的文件系统区分大小写，THE StorageAnalyzer SHALL 按区分大小写的方式匹配 BucketDir 名称的十六进制小写形式。
4. THE StorageAnalyzer SHALL 以 stat 报告的逻辑字节数（`size`）作为体积口径，且 SHALL 在展示文案中注明该数值不含文件系统簇对齐造成的实际占用差异。
5. IF 枚举过程中遇到符号链接（含指向文件的链接与指向目录的链接），THEN THE SizeScanner SHALL 不跟随该链接解析其目标，仅按链接自身的条目字节数计入所在分类，以避免循环与跨卷重复计数。
6. THE SessionCleaner SHALL 使用平台路径分隔符拼接待删除文件的绝对路径，且 IF CleanupPlan 中某条目为符号链接，THEN THE SessionCleaner SHALL 跳过该条目并将其计入失败计数，以避免删除链接目标。

### Requirement 9: 错误处理与静默降级

**User Story:** 作为用户，即使某些目录读不了或统计出错，我也希望搜索功能照常可用，不被弹窗打断。

#### Acceptance Criteria

1. IF 枚举某个目录或 stat 某个文件抛出异常，THEN THE SizeScanner SHALL 跳过该条目、累加 `skippedCount` 并继续统计其余条目。
2. WHEN StorageSummary 的 `skippedCount` 大于 0，THE StorageAnalyzer SHALL 把 `partial` 置为 true 并正常返回结果，表示返回值为占用下限；WHILE 存在不可读目录或不可 stat 的文件，THE StorageAnalyzer SHALL 仅设置该标记而不向调用方抛出异常。
3. IF 汇总统计整体失败，THEN THE SummaryBar SHALL 展示「占用统计不可用」文本，且 THE Extension SHALL 保持搜索结果与既有 credit 角标正常展示。
4. THE Extension SHALL 不因任何统计相关异常弹出错误通知，除非该异常来自用户主动执行的 StorageReportCommand、打开 UsageRankingPage 或一次清理操作。
5. IF 用户主动执行的 StorageReportCommand 整体失败，THEN THE Extension SHALL 通过通知展示形如「存储占用分析失败：<异常 message>」的提示。
6. IF 会话占用计算对某条结果失败，THEN THE Extension SHALL 省略该条结果的 SizeBadge 并继续渲染其余结果。
7. THE ReadOnlyPaths SHALL 仅以只读方式访问磁盘，即仅执行目录枚举、stat 与文件读取，且 SHALL 不执行创建、写入、重命名、移动或删除操作。
8. THE SessionCleaner SHALL 是本特性唯一允许写磁盘的模块，且 SHALL 仅使用 WritableFsAllowlist 中的 API：针对单个文件的 `unlink`，以及针对 SessionManifest 的 `readFile` 与 `writeFile`；THE SessionCleaner SHALL 不使用递归删除、目录删除、重命名或移动 API。
9. IF 一次清理操作整体失败（CleanupPlan 生成失败或全部删除均失败），THEN THE Extension SHALL 通过通知展示形如「会话清理失败：<异常 message>」的提示，并保持 UsageRankingPage 的当前列表可用。

### Requirement 10: 数值格式化

**User Story:** 作为用户，我希望体积数字一眼能读懂，单位与精度稳定，不出现 `12345678 B` 这样的读数。

#### Acceptance Criteria

1. THE SizeFormatter SHALL 以 1024 为进制换算单位，单位序列为 `B`、`KB`、`MB`、`GB`、`TB`。
2. WHERE 字节数小于 1024，THE SizeFormatter SHALL 输出整数加单位 `B`。
3. WHERE 字节数大于或等于 1024 且小于 1024³，THE SizeFormatter SHALL 输出保留 1 位小数的数值与对应单位（`KB` 或 `MB`）。
4. WHERE 字节数大于或等于 1024³，THE SizeFormatter SHALL 输出保留 2 位小数的数值与对应单位（`GB` 或 `TB`）。
5. THE SizeFormatter SHALL 对任意两个字节数 `a <= b` 保证格式化后解析回的数值满足 `parse(format(a)) <= parse(format(b))`（单调性）。
6. THE SizeFormatter SHALL 使 `parse(format(n))` 与 `n` 的相对误差不超过 1%（受展示精度限制的近似往返性质）。
7. IF 输入为负数、`NaN` 或非有限数，THEN THE SizeFormatter SHALL 返回 `-` 占位文本。
8. THE SizeFormatter SHALL 输出为不依赖 DOM 与 vscode API 的纯函数结果，以便在扩展宿主与 Webview 中共用同一实现。

### Requirement 11: 测试覆盖

**User Story:** 作为维护者，我希望统计口径、性能约束与删除安全规则被自动化测试锁定，避免后续改动悄悄改变数值含义或误删文件。

#### Acceptance Criteria

1. THE 测试套件 SHALL 使用既有 vitest + fast-check 组合，且所有涉及文件系统的测试 SHALL 在临时目录中构造夹具并在结束后清理。
2. THE 测试套件 SHALL 以属性测试验证 SizeFormatter 的单调性与近似往返性质（对应 Requirement 10.5、10.6）。
3. THE 测试套件 SHALL 以属性测试验证归因守恒性质：对随机生成的会话与存档夹具，各会话自身口径存档部分之和加孤儿字节数等于存档总字节数（对应 Requirement 2.3）。
4. THE 测试套件 SHALL 以属性测试验证目录聚合的可加性：任一目录的统计字节数等于其直接子条目统计字节数之和。
5. THE 测试套件 SHALL 以属性测试验证统计的幂等性：连续两次统计同一未变化的夹具返回相同的 StorageSummary。
6. THE 测试套件 SHALL 以示例测试验证孤儿判定：存档的 `chatSessionId` 指向已删除会话时被计为孤儿，指向现存会话时不被计为孤儿。
7. THE 测试套件 SHALL 以示例测试验证降级行为：夹具中存在不可读目录时统计返回 `partial: true` 且不抛出异常。
8. THE 测试套件 SHALL 以示例测试验证统计路径的只读约束：一次完整统计（含汇总、会话占用、报告生成与 UsageRankingPage 取数）前后夹具目录的文件列表、字节数与修改时间保持不变。
9. THE 测试套件 SHALL 以属性测试验证 CleanupPlan 的封闭性：删除操作实际访问的路径集合恒为 CleanupPlan 中列出的文件路径集合的子集，且恒不含目录路径。
10. THE 测试套件 SHALL 以属性测试验证清理的部分成功语义：对随机的失败位置集合，CleanupResult 的成功字节数恒等于成功删除文件的字节数之和、失败计数恒等于失败条目数，且删除过程恒不因单条失败而中止。
11. THE 测试套件 SHALL 以属性测试验证 UsageRankingPage 的分页与排序：任一页的条目恒为全量排序序列的对应切片，页内条目数恒不超过 RankingPageSize，且各页条目的并集恒等于全量集合且两两不相交。
12. THE 测试套件 SHALL 以示例测试验证引用冲突规则：存档被其它现存会话的 lineage 引用时默认被排除在删除之外并计入 ReferencedArchive，用户显式选择包含时才纳入删除。
13. THE 测试套件 SHALL 以示例测试验证 FullCleanup 的 SessionManifest 读改写：目标 sessionId 的条目被移除，其余条目与其字段保持原样。

### Requirement 12: 文档更新

**User Story:** 作为使用者或后续维护者，我希望 README 说明统计口径的含义与局限、以及清理操作的破坏性，避免误读数字或误删数据。

#### Acceptance Criteria

1. THE README SHALL 描述新增的 ComputeSizeButton、SummaryBar、SizeBadge、UsageRankingPage 与 StorageReportCommand 的用途与触发方式，并注明占用统计仅在用户显式触发时执行。
2. THE README SHALL 说明会话占用的口径定义，包括自身口径与累计口径的差异，以及累计口径不可跨会话求和的原因。
3. THE README SHALL 说明孤儿执行存档的定义与其来源机制，并注明孤儿存档本版本仅统计、不提供批量清理及其理由。
4. THE README SHALL 列出各 StorageCategory 对应的磁盘路径，便于用户自行核对。
5. THE README SHALL 注明统计采用 stat 报告的逻辑字节数，与资源管理器显示的"占用空间"可能存在差异。
6. THE README SHALL 说明 AttachmentCleanup 与 FullCleanup 两种模式各自删除的内容、不可撤销、以及被其它会话 lineage 引用的存档默认被保留这一规则。
7. THE README SHALL 说明 UsageRankingPage 与 StorageReportCommand 并存的分工，即前者覆盖当前项目并提供清理入口、后者覆盖全部工作区并输出可复制的纯文本报告。
8. THE README SHALL 说明清理操作的审计记录写入 Kiro 输出通道，供用户核对被删除的文件清单。

### Requirement 13: 会话占用排行页

**User Story:** 作为用户，我想在一个页面里按占用高低看到当前项目的所有对话，这样我能快速定位该清理哪几个。

#### Acceptance Criteria

1. THE Extension SHALL 注册命令 `kiroChatSearch.storageRanking`（标题「Kiro: 存储占用排行」）以打开 UsageRankingPage，且 THE Extension SHALL 在同一 Kiro 窗口内最多维持 1 个 UsageRankingPage 实例；WHEN 用户执行 OpenRankingCommand 或右键点击 ComputeSizeButton 且该窗口已存在 UsageRankingPage 实例，THE Extension SHALL 激活该已有实例并保持其当前页码 M 与 RankingSortOrder 不变；WHEN UsageRankingPage 实例被关闭后再次打开，THE Extension SHALL 以第 1 页与默认 RankingSortOrder（`desc`）渲染，即页码 M 与 RankingSortOrder 仅在实例存续期内保持。
2. WHEN UsageRankingPage 被打开，THE Extension SHALL 统计当前工作区 WorkspaceSessionDir 下的**全部**会话的占用，而不限于搜索结果列表中的会话。
3. THE UsageRankingPage SHALL 为每个会话行展示六列：会话标题、sessionId、会话 JSON 字节数、归因存档字节数、占用合计、最后修改时间；THE UsageRankingPage SHALL 取该会话 SessionFile 的 mtime 作为最后修改时间，并按本地时区以 `YYYY-MM-DD HH:mm` 格式展示；WHERE 会话标题为空字符串或仅含空白字符，THE UsageRankingPage SHALL 在标题列展示 `(无标题)`；WHERE 会话标题长度大于 120 个字符，THE UsageRankingPage SHALL 在标题列展示前 120 个字符并追加省略号，且 SHALL 通过该行标题的 tooltip 展示完整标题。
4. THE UsageRankingPage SHALL 恒使用自身口径（`self`）计算并展示每行占用，以保证各行数值可相加；THE UsageRankingPage 的口径 SHALL 固定为 `self` 而与搜索面板 `Σ` 开关的状态无关；WHEN 用户打开 UsageRankingPage 或在其中排序、翻页、刷新、执行清理，THE Extension SHALL 保持搜索面板 `Σ` 开关的状态不变。
5. THE UsageRankingPage SHALL 按占用合计排序，默认 RankingSortOrder 为 `desc`；WHEN 用户点击占用列表头，THE UsageRankingPage SHALL 在 `desc` 与 `asc` 之间切换 RankingSortOrder 并按新方向重新渲染；WHERE 两个会话行的占用合计相等，THE UsageRankingPage SHALL 以「最后修改时间降序，其后 sessionId 字典序升序」作为稳定次序（tiebreak），且该稳定次序 SHALL 在 `desc` 与 `asc` 两个方向下保持同一方向而不随 RankingSortOrder 反转，使同一输入的排序结果唯一。
6. THE UsageRankingPage SHALL 对排序后的全量会话序列按 RankingPageSize（50 条）分页，总页数 N SHALL 取 `ceil(K / RankingPageSize)`（K 为当前工作区可统计会话数）；WHERE K 等于 0，THE UsageRankingPage SHALL 取 N 为 1；THE UsageRankingPage SHALL 使当前页码 M 恒满足 `1 ≤ M ≤ N`，且 SHALL 只渲染当前页对应的会话行。
7. THE UsageRankingPage SHALL 提供「上一页」与「下一页」控件以及形如「第 M / N 页 · 共 K 个会话」的页码指示；WHILE M 等于 1，THE UsageRankingPage SHALL 禁用「上一页」控件；WHILE M 等于 N，THE UsageRankingPage SHALL 禁用「下一页」控件。
8. WHEN 用户切换 RankingSortOrder，THE UsageRankingPage SHALL 把当前页重置为第一页。
9. WHERE 当前工作区的可统计会话数 K 等于 0，THE UsageRankingPage SHALL 展示「当前项目还没有可统计的会话」空态文案、SHALL 把页码指示展示为「第 1 / 1 页 · 共 0 个会话」、SHALL 同时禁用「上一页」与「下一页」控件，并 SHALL 保持表头与分页控件的结构不变。
10. IF StorageSummary 的 `partial` 为 true，THEN THE UsageRankingPage SHALL 仅在「归因存档字节数」与「占用合计」两列的数值前展示 `≥` 前缀以表示该两列数值为下限值，并 SHALL 在页脚展示被跳过的条目数 `skippedCount`。
11. THE UsageRankingPage SHALL 在每个会话行上提供两个清理入口，分别对应 AttachmentCleanup 与 FullCleanup（行为见 Requirement 14）。
12. WHEN 用户点击 UsageRankingPage 的刷新控件，THE Extension SHALL 强制重新统计当前工作区的全部会话占用并忽略 StorageCache 的 60 秒有效期，且 SHALL 保持刷新前的 RankingSortOrder 不变。
13. THE UsageRankingPage SHALL 使用与既有搜索面板一致的 CSP（`default-src 'none'` 加 nonce），且 SHALL 对所有会话标题、sessionId 与路径文本执行 HTML 转义后再插入 DOM。
14. THE UsageRankingPage 的取数路径 SHALL 仅以只读方式访问磁盘，即仅执行目录枚举、stat 与文件读取；THE UsageRankingPage 的取数路径 SHALL 把创建、写入、重命名、移动与删除操作（含临时文件）排除在外。
15. WHILE UsageRankingPage 的占用统计正在进行，THE UsageRankingPage SHALL 展示「统计中…」文本、SHALL 禁用排序、翻页、刷新与清理控件、SHALL 忽略重复的统计请求并保持同时最多 1 次统计在执行，且 SHALL 保持面板可被用户关闭。
16. WHILE 当前未打开任何工作区，THE UsageRankingPage SHALL 展示说明当前无法统计会话占用的文案、SHALL 保持表头与分页控件的结构不变并将其置为禁用态，且 THE Extension SHALL 把目录枚举排除在该状态下的行为之外。
17. WHEN 一次清理使当前工作区可统计会话数 K 减少，THE UsageRankingPage SHALL 按更新后的 K 重新计算 N、把当前页码取为 `min(M, N)`，并按当前 RankingSortOrder 重新渲染该页与页码指示。

### Requirement 14: 会话清理

**User Story:** 作为想释放磁盘空间的用户，我希望能删掉某个大对话的执行存档、必要时连对话本身一起删掉，同时清楚知道会删哪些文件、能释放多少，且不会误删别的东西。

#### Acceptance Criteria

1. WHEN 用户在 UsageRankingPage 的某个会话行上触发 AttachmentCleanup，THE SessionCleaner SHALL 生成 CleanupPlan，其待删除文件集合为 `chatSessionId` 与该 sessionId 按区分大小写严格相等匹配的全部 ExecutionArchive 文件；THE SessionCleaner SHALL 把 `chatSessionId` 字段缺失、为空字符串或仅含空白字符的 ExecutionArchive 排除在任何会话的清理集合之外；THE CleanupPlan SHALL 把该会话的 SessionFile 与 SessionManifest 排除在待删除文件集合之外。
2. WHEN 用户在 UsageRankingPage 的某个会话行上触发 FullCleanup，THE SessionCleaner SHALL 生成 CleanupPlan，其待删除文件集合为 `chatSessionId` 与该 sessionId 按区分大小写严格相等匹配的全部 ExecutionArchive 文件与该会话位于当前工作区 WorkspaceSessionDir 下的 SessionFile，并 SHALL 把从同一 WorkspaceSessionDir 下的 SessionManifest 中移除该 sessionId 对应条目列为附加操作；THE SessionCleaner SHALL 把 `chatSessionId` 字段缺失、为空字符串或仅含空白字符的 ExecutionArchive 排除在该集合之外。
3. THE SessionCleaner SHALL 在 CleanupPlan 中给出生成时间、待删除文件的绝对路径列表、每个待删除文件的字节数与 mtime 快照、字节数合计与文件数合计，其中字节数与 mtime 快照 SHALL 供确认后的复核使用。
4. THE SessionCleaner SHALL 默认把 ReferencedArchive 从 CleanupPlan 的待删除文件集合中排除，并在 CleanupPlan 中单独给出被保留的 ReferencedArchive 文件数与字节数合计。
5. WHEN 展示确认提示，THE SessionCleaner SHALL 以模态确认提示给出清理模式名称、将释放的字节数、将删除的文件数、因被其它会话引用而保留的文件数与字节数，以及该操作不可撤销且被删除文件不进入回收站的说明；THE 确认提示 SHALL 提供「确认清理」与「取消」两个显式选项，并 SHALL 把「取消」作为默认按钮，使确认项处于非默认位置。
6. WHERE 用户在确认提示中显式选择包含 ReferencedArchive，THE SessionCleaner SHALL 把 ReferencedArchive 纳入待删除文件集合、SHALL 按更新后的待删除文件数与字节数合计展示一次二次确认提示，并 SHALL 在确认提示与 CleanupAuditLog 中说明删除后其它会话的历史 credit 用量将无法回溯。
7. IF 用户未在确认提示或二次确认提示中确认（取消或关闭提示）、或 CleanupPlan 为空计划（待删除文件数为 0 且无附加操作），THEN THE SessionCleaner SHALL 返回未执行状态并保持全部文件与 SessionManifest 内容原样；WHERE CleanupPlan 为空计划，THE SessionCleaner SHALL 直接返回未执行状态而不展示确认提示。
8. THE SessionCleaner SHALL 只删除 CleanupPlan 中已枚举并在确认提示中计入的具体文件路径，且 SHALL 把目录、递归删除以及 CleanupPlan 生成之后新出现的文件排除在删除范围之外。
9. IF 删除某个文件因文件锁或拒绝访问类错误失败，THEN THE SessionCleaner SHALL 对该文件最多重试 3 次、每次重试间隔 200 毫秒；IF 重试后仍失败或删除因其它原因失败，THEN THE SessionCleaner SHALL 把该文件与失败原因计入 CleanupResult 的失败列表并继续删除其余文件。
10. THE SessionCleaner SHALL 在 CleanupResult 中给出成功删除的文件数与字节数合计、失败的文件数以及跳过的文件数（跳过计数指按 Requirement 14.20 复核为已不存在或与快照不一致而未执行删除的文件数）；WHERE 失败文件数与跳过文件数之和大于 0，THE Extension SHALL 以部分成功的提示文案同时给出成功、失败与跳过三类计数；WHERE CleanupPlan 中某条目为符号链接，THE SessionCleaner SHALL 按 Requirement 8.6 把该条目计入失败计数。
11. WHERE 清理模式为 FullCleanup，THE SessionCleaner SHALL 以 `readFile` 读取 SessionManifest、移除目标 sessionId 对应条目，并以单次 `writeFile` 覆盖写回其余条目，保留其余条目的字段、字段顺序、缩进风格与行尾风格；THE SessionCleaner SHALL 以覆盖写回完成该更新，并把临时文件与重命名排除在该路径之外。
12. IF SessionManifest 解析失败或其顶层结构不是数组，THEN THE SessionCleaner SHALL 保持 SessionManifest 内容原样而不写入任何内容、保留已完成的文件删除结果、把清单更新标记为失败并计入 CleanupResult，且 SHALL 不抛出异常给调用方；IF 覆盖写回本身失败，THEN THE SessionCleaner SHALL 保留已完成的文件删除结果、把清单更新标记为失败并计入 CleanupResult，且 SHALL 不抛出异常给调用方。
13. WHEN 一次清理执行结束且结果为全部成功、部分成功或全部失败中的任一种，THE SessionCleaner SHALL 使 StorageCache 中受影响的统计结果失效，失效范围 SHALL 覆盖每个被删除文件的各级父目录（自其所在目录向上直至 StoreRoot）的子树聚合缓存，并 SHALL 移除 ArchiveIndex 中被删除存档对应的条目。
14. WHEN 一次清理执行结束，THE Extension SHALL 重新计算并刷新 UsageRankingPage 的当前页与页码指示、SummaryBar 的三项数值，以及搜索结果列表中受影响会话的 SizeBadge。
15. WHERE 清理模式为 FullCleanup 且 SessionFile 删除成功，THE UsageRankingPage SHALL 在刷新后不再展示该会话行，且 THE Extension SHALL 在后续搜索结果与最近列表的取数中把该会话排除在返回结果之外。
16. THE SessionCleaner SHALL 把审计记录写入与 StorageReportCommand 相同的 Kiro 输出通道，记录内容 SHALL 包含操作时间、目标 sessionId 与标题、清理模式、每个被删除文件的绝对路径与字节数、每个失败文件的路径与失败原因、每个被跳过文件的路径与跳过原因、以及成功、失败与跳过三类计数的合计。
17. THE SessionCleaner SHALL 在执行删除之前把 CleanupPlan 写入同一输出通道，使被删除文件清单在删除失败或中断时仍可回溯。
18. IF 针对某 sessionId 已有一次清理正在执行，THEN THE SessionCleaner SHALL 拒绝针对该 sessionId 的新清理请求、向用户提示该会话的清理正在进行，并 SHALL 保持同一 sessionId 同时最多 1 次清理在执行。
19. WHEN 执行删除之前，THE SessionCleaner SHALL 对每个目标路径执行规范化校验，并 SHALL 仅删除规范化后位于 StoreRoot 之内且匹配以下两类位置之一的路径：当前工作区 ExecutionSavesBucket 下的 ExecutionArchive、当前工作区 WorkspaceSessionDir 下的 SessionFile；IF 某目标路径的原始形式含 `..` 路径段、规范化后落在 StoreRoot 之外、不匹配上述两类位置之一、或指向 SessionManifest 本身，THEN THE SessionCleaner SHALL 拒绝删除该路径并把该路径与拒绝原因计入 CleanupResult 的失败列表。
20. WHEN 用户确认后删除每个文件之前，THE SessionCleaner SHALL 对该文件重新执行 stat 复核；IF 该文件已被外部删除，THEN THE SessionCleaner SHALL 跳过该文件并按释放 0 字节计入跳过计数；IF 该文件的字节数或 mtime 与 CleanupPlan 中的快照不一致，THEN THE SessionCleaner SHALL 保持该文件不删除并计入跳过计数。
