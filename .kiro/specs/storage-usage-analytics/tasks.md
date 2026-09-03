# Implementation Plan: storage-usage-analytics

## Overview

按设计的四条数据流分层实现：先做纯函数底座（格式化器、分类器），再做扫描与归因（SizeScanner、ArchiveIndex 快照与摘除、孤儿判定、StorageAnalyzer），随后是两个消费面——只读的报告与排行页取数（`report.ts` / `ranking.ts`），以及本特性唯一的写路径 SessionCleaner（`cleaner.ts`）。最后接线到 `search.ts`（结果角标）、`webview.ts`（ComputeSizeButton / 四态 SummaryBar / SizeBadge）与 `extension.ts`（`summary` 消息协议、StorageReportCommand、OpenRankingCommand）。

实现语言为 TypeScript（沿用既有 `src/` 结构与 `tests/` 的 vitest + fast-check 约定）。每条设计属性（Property 1–31，其中 Property 14 分 (a)(b) 两半）对应一个独立的属性测试子任务，测试文件划分与 design.md 的「测试文件划分」表一致。

写操作边界是本计划的硬约束：ReadOnlyPaths（`analyzer.ts` / `scanner.ts` / `classify.ts` / `orphan.ts` / `report.ts` / `ranking.ts`）只引入 `readdir` / `lstat` / `stat` / `readFile`，不引入任何写 API；`cleaner.ts` 是唯一可写模块，只引入单文件 `unlink` 与 SessionManifest 的 `readFile` / `writeFile`，不引入 `rm` / `rmdir` / `rename` / `cp`。

## Tasks

- [x] 1. 基础设施：测试夹具与共享数据模型
  - [x] 1.1 扩展 `tests/_helpers.ts` 的四个夹具构造器
    - 新增 `mkTree(root, spec)`：按声明式描述创建嵌套目录树，支持指定文件字节数、符号链接（指向文件与指向目录）、指定 mtime
    - 新增 `snapshotTree(root)`：递归快照为 `路径 → { size, mtimeMs }`，供只读性质前后对比
    - 新增 `recordingReadFs(base?)`：记录型只读 fs，返回 `{ deps: ScannerFsDeps, calls }`，记录每次调用的方法名与实参，供统计路径的调用面断言
    - 新增 `recordingCleanerFs(tree, faults?)`：在内存目录树上模拟 `unlink` / `stat` / `readFile` / `writeFile` 的记录型可写 fs，支持按路径注入可重试锁类失败（`EBUSY`/`EPERM`/`EACCES`）、不可重试失败，以及「确认后变更」（改 `size` 或 `mtimeMs`、或让文件消失）以测 TOCTOU
    - 保持既有 `mkTempDir` / `rmTempDir` / `writeSession` 不变
    - _Requirements: 11.1_

  - [x] 1.2 新建 `src/storage/types.ts` 定义共享数据模型
    - 定义 `CategoryStat`、`StorageSummary`、`SessionFootprint` 接口，字段与 design.md 的 Data Models 完全一致
    - `StorageSummary` 含 `status`、`totalBytes`、`totalFiles`、`categories`、`currentWorkspaceBytes`、`projectFootprintTotal`、`orphan`、`partial`、`skippedCount`、`sessionCount`、`sizeNote`、`scannedAt`
    - `projectFootprintTotal` 为当前工作区全部会话 SelfFootprint 合计（可相加口径），`sessionCount` 为参与统计的会话数，二者供 SummaryBar 的数值与 tooltip 使用
    - `sizeNote` 常量文案注明为 stat 逻辑字节数、不含簇对齐差异
    - _Requirements: 1.3, 4.1, 4.10, 8.4, 9.2_

- [x] 2. SizeFormatter 与渲染标签（`src/webview/size.ts`）
  - [x] 2.1 实现 `formatSize` / `parseSize`
    - 1024 进制，单位序列 `B`/`KB`/`MB`/`GB`/`TB`；`B` 取整，`KB`/`MB` 保留 1 位小数，`GB`/`TB` 保留 2 位小数
    - 负数、`NaN`、非有限数返回 `-`；`parseSize` 对 `-` 与不可识别文本返回 `NaN`
    - 纯函数，不依赖 DOM 与 vscode，便于随 `injectedFormatScript()` 注入 webview，同时被 `report.ts` 与 `ranking.ts` 复用
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.7, 10.8_

  - [x]* 2.2 编写属性测试：格式化形态与非法输入占位
    - **Property 20: 格式化形态与非法输入占位**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.7**
    - 文件 `tests/size.property.spec.ts`，`{ numRuns: 100 }`

  - [x]* 2.3 编写属性测试：格式化单调性
    - **Property 21: 格式化单调性**
    - **Validates: Requirements 10.5**
    - 生成器偏置到 1024 各次幂附近以覆盖单位切换边界

  - [x]* 2.4 编写属性测试：格式化近似往返
    - **Property 22: 格式化近似往返**
    - **Validates: Requirements 10.6**
    - 断言上界 `max(0.01 * n, halfStep(formatSize(n)))`，`halfStep` 按 1/2 位小数分别取 `0.05` / `0.005` × 单位因子

  - [x] 2.5 实现 `sizeBadgeLabel` 与四态 `summaryLabel`
    - `sizeBadgeLabel`：按 `scope` 取 `jsonBytes + archiveBytesSelf|archiveBytesLineage`；`archivesFound === false` 时只展示 `jsonBytes` 且 tooltip 说明存档不可用；tooltip 分行给出 JSON 与存档字节拆解；总占用 ≥ 100MB 时 `warn: true`；数值不可取得时返回 `null`
    - `summaryLabel` 改为四态签名 `state?: 'idle' | 'loading' | 'ok' | 'unavailable'`：`idle` → 「点击 ⛁ 统计占用」、`loading` → 「统计中…」、`unavailable` → 「占用统计不可用」，三者恒不输出任何占用数值
    - `ok` 态入参新增 `resultSetBytes`（ResultSetFootprintTotal）、`sessionCount`、`resultCount`、`categories`、`skippedCount`；`totalBytes` 语义为 ProjectFootprintTotal
    - `ok` 态输出 ProjectFootprintTotal、ResultSetFootprintTotal、孤儿存档三项数值；tooltip 给出会话 JSON 与归因存档字节数的拆解、参与统计的会话数与结果条数；`categories` 存在时在同一 tooltip 追加各分类标签、字节数与磁盘路径
    - `partial` 为 true 时数值前加 `≥` 前缀并在 tooltip 给出被跳过条目数
    - _Requirements: 4.1, 4.2, 4.5, 4.10, 4.11, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3_

  - [x]* 2.6 编写属性测试：SummaryBar 四态输出
    - **Property 10: SummaryBar 输出覆盖三项数值、四态文案与下限标记**
    - **Validates: Requirements 4.1, 4.2, 4.5, 4.10, 4.11, 9.3**
    - 文件 `tests/storage.badge.property.spec.ts`

  - [x]* 2.7 编写属性测试：SizeBadge 渲染与鲁棒性
    - **Property 11: SizeBadge 渲染与鲁棒性**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 9.6**

  - [x]* 2.8 编写示例测试 `tests/size.spec.ts`
    - `-` 占位、各单位边界具体值（1023 / 1024 / 1024³ 等）
    - 断言模块不引用 DOM 与 vscode API（纯函数可直接 Node 端调用）
    - _Requirements: 10.7, 10.8_

- [x] 3. 路径分类器（`src/storage/classify.ts`）
  - [x] 3.1 实现 `buildClassifyRoots` / `classifyPath` / `isUnder` / `CATEGORY_META`
    - `buildClassifyRoots` 由 UserDataDir 派生 storeRoot、sessionsRoot、savesBucket（`hash32('KIRO::EXECUTION::SAVES')`）、metadataBucket（`hash32('KIRO::EXECUTION::METADATA')`）、logsDir、workspaceStorageDir
    - `classifyPath` 按设计的 7 条有序规则返回唯一分类，先命中者胜
    - `isUnder` 用 `path.relative` 结果判断（不以 `..` 开头且非绝对路径），按路径段边界比较；桶名按小写十六进制区分大小写精确匹配
    - `isUnder` 同时被 `cleaner.ts` 的 `assertDeletable` 复用，使删除侧与统计侧对「这个文件是不是执行存档」给出同一答案
    - `CATEGORY_META` 给出各分类中文标签与磁盘路径模板，`unclassified.note` 标注「实测包含源码文件快照」
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 8.2, 8.3_

  - [x]* 3.2 编写属性测试：分类构成一个划分
    - **Property 1: 分类构成 UserDataDir 上的一个划分**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 8.2, 8.3**
    - 文件 `tests/storage.classify.property.spec.ts`；生成器覆盖同前缀兄弟目录（`logs` / `logs-old`）与桶名大写变体

  - [x]* 3.3 编写属性测试：统计根由 PathResolver 派生
    - **Property 17: 统计根恒由 PathResolver 派生**
    - **Validates: Requirements 8.1**
    - 注入平台 / 环境变量 / homedir 组合，断言 `ClassifyRoots` 每个成员以 UserDataDir 为前缀

- [x] 4. Checkpoint - 纯函数底座
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. SizeScanner（`src/storage/scanner.ts`）
  - [x] 5.1 实现 `scanTree` 与遍历预算
    - `ScannerFsDeps` 可注入 `readdir` / `lstat` / `yieldNow`，缺省退回 `fs.promises`
    - 只 `readdir(withFileTypes)` + `lstat`，不打开或读取被统计文件内容
    - 每处理 512 个条目让出一次事件循环；递归深度上限 8，超深子树计入 `skippedCount` 并置 `partial`
    - 符号链接不跟随，按链接自身条目字节数计入所在分类
    - 单个条目枚举 / stat 失败时跳过并累加 `skippedCount`，不向上抛异常
    - `isCancelled()` 在每个目录入口与每次让出后检查，取消时返回 `cancelled: true`
    - _Requirements: 7.3, 7.4, 7.8, 8.5, 9.1, 9.2, 6.7_

  - [x] 5.2 实现 `SubtreeCache`（含 `invalidate(dir)`）
    - 键为目录绝对路径，以 `(mtimeMs, 直接子条目数)` 作为失效判据
    - 命中时整棵子树复用聚合结果不再递归；条目只保存数字与分类标记，不保存文件列表或内容
    - 新增 `invalidate(dir)` 失效单个目录条目，供清理后自被删文件所在目录向上逐级失效使用（祖先目录的 mtime 与子条目数抓不到孙辈文件被删，必须显式打掉）
    - 取消时已完成的子树聚合仍写入缓存供下次复用
    - _Requirements: 7.6, 7.11, 6.7, 14.13_

  - [x]* 5.3 编写属性测试：目录聚合可加性
    - **Property 23: 目录聚合可加性**
    - **Validates: Requirements 11.4**
    - 文件 `tests/storage.scanner.property.spec.ts`

  - [x]* 5.4 编写属性测试：扫描预算
    - **Property 16: 扫描预算**
    - **Validates: Requirements 7.3, 7.8, 7.11**
    - 注入 `yieldNow` 计数器断言让出频率；断言超深子树计入 `skippedCount` 且 `partial === true`

  - [x]* 5.5 编写属性测试：符号链接不被跟随
    - **Property 18: 符号链接不被跟随**
    - **Validates: Requirements 8.5**
    - 含循环链接夹具，断言统计可终止且总量不随链接目标体积增加

  - [x]* 5.6 编写属性测试：异常降级为跳过计数
    - **Property 19: 异常降级为跳过计数**
    - **Validates: Requirements 9.1, 9.2**
    - 随机失败位置集合，断言 `skippedCount` 等于失败条目数、`partial` 与 `skippedCount > 0` 等价

  - [x]* 5.7 编写示例测试 `tests/storage.scanner.spec.ts`
    - SubtreeCache 失效判据：改 mtime、增删直接子项分别失效；未变化时命中
    - `invalidate(dir)` 只失效指定目录条目，不影响其它键
    - 取消后停止继续枚举，已完成子树保留在缓存中
    - _Requirements: 7.6, 6.7, 14.13_

- [x] 6. ArchiveIndex 只读快照与条目摘除（`src/credits.ts`）
  - [x] 6.1 导出 `ArchiveInfo`、`listArchiveEntries` 与 `dropArchiveEntries`
    - `listArchiveEntries` 返回既有 `archiveCache` 的只读快照，每项含 `path`、`name`（`hash32(executionId)`）、`size`、`chatSessionId`；支持 `opts.workspacePath` 把刷新范围限定到对应 workspaceId 目录
    - `dropArchiveEntries(paths)` 按绝对路径从 `archiveCache` 摘除条目并返回实际摘除数：只删 Map 键，不接受 sessionId、不做匹配、不触发扫描、不改节流状态，使文件被 SessionCleaner 删除后索引立即与磁盘一致
    - 内部仍走既有 `refreshIndex`（`SCAN_TTL_MS = 4000` 节流），不新增扫描策略、不读取存档内容；`archiveCache` / `scanState` / 解析逻辑保持原样
    - _Requirements: 7.1, 7.9, 7.10, 14.13_

  - [x]* 6.2 在 `tests/credits.spec.ts` 补充示例测试
    - 快照字段完整（`size` / `chatSessionId` / `name`）且不触发存档内容重复读取
    - 连续调用在 4 秒窗口内不重扫目录
    - `dropArchiveEntries` 只摘除给定路径的键、返回摘除数、且不触发扫描或改变节流状态
    - _Requirements: 7.1, 7.9, 7.10, 14.13_

- [x] 7. LiveSessionIds 与孤儿判定（`src/storage/orphan.ts`）
  - [x] 7.1 实现 `collectLiveSessions` 与 `decodeWorkspaceKey`
    - 枚举所有 WorkspaceSessionDir 下的 SessionFile 与解析各 `sessions.json` 清单，返回 sessionId 并集、`complete` 标记与 `skippedCount`
    - `sessions.json` 自身不作为会话记录计入
    - 返回 `byWorkspace` 明细（EncodedKey、目录路径、解码路径、会话字节数、各会话 JSON 字节数）供报告与排行页复用
    - `decodeWorkspaceKey` 为 `encodeWorkspaceKeys` 的逆向解码，失败返回 `null`
    - _Requirements: 3.1, 6.5_

  - [x] 7.2 实现 `computeOrphans` 状态机
    - 判定顺序：`complete === false` → `pending`（不判定任何存档）；`ids` 为空 → `unknown`（不把全部存档判为孤儿）；否则 → `ok`
    - `ok` 时把 `chatSessionId` 缺失或不在 `ids` 中的存档计入字节数与文件数合计
    - `note` 固定两段：LRU 索引只淘汰内存条目、磁盘文件残留的机制说明；以及限制理由——孤儿存档不归属 UsageRankingPage 上任一可展示的会话行，因此**只否定批量清理**入口，并引导单会话清理去排行页操作；不再出现「本版本仅统计不提供清理」这类会被误读为整个特性没有清理能力的表述
    - 模块不导出任何删除入口；FullCleanup 后残留存档在下一次统计中自然落入孤儿集合（判定规则的推论，无需额外代码）
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x]* 7.3 编写属性测试：LiveSessionIds 为两个来源的并集
    - **Property 8: LiveSessionIds 为两个来源的并集**
    - **Validates: Requirements 3.1**
    - 文件 `tests/storage.orphan.property.spec.ts`

  - [x]* 7.4 编写属性测试：孤儿判定的状态与集合
    - **Property 9: 孤儿判定的状态与集合**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5**

  - [x]* 7.5 编写示例测试 `tests/storage.orphan.spec.ts`
    - `chatSessionId` 指向已删除会话 → 计为孤儿；指向现存会话 → 不计为孤儿
    - `note` 文案包含 LRU 机制说明与「不提供批量清理」的理由，且不含整体否定清理能力的表述；模块无删除导出
    - _Requirements: 3.3, 3.6, 3.7, 11.6_

- [x] 8. Checkpoint - 扫描与孤儿判定
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. StorageAnalyzer（`src/storage/analyzer.ts`）
  - [x] 9.1 实现 `computeSessionFootprint`
    - 自身口径：`jsonBytes` + 所有 `chatSessionId === sessionId` 的存档字节数之和
    - 累计口径：lineage 集合按既有 credit lineage 判定（`historyExecutionIds` 经 `hash32` 反查存档取其 `chatSessionId` 并入）
    - `scope === 'self'` → `additive: true`；`scope === 'lineage'` → `additive: false`
    - 无匹配存档时 `archiveBytes = 0`、`archivesFound: false`，占用等于 `jsonBytes`
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.8_

  - [x]* 9.2 编写属性测试：自身口径归因公式
    - **Property 3: 自身口径归因公式**
    - **Validates: Requirements 2.1, 2.8**
    - 文件 `tests/storage.analyzer.property.spec.ts`

  - [x]* 9.3 编写属性测试：两种口径的关系与可加性标记
    - **Property 4: 两种口径的关系与可加性标记**
    - **Validates: Requirements 2.2, 2.4, 2.5**

  - [x] 9.4 实现 `getSummary` / `getRankingRows` / `invalidateForDeletedFiles` 与 StorageCache
    - 通过既有 PathResolver 取 UserDataDir；为 `null` 时返回 `status: 'unavailable'` 且不抛异常
    - 调用 `scanTree` 得到分类合计，组装 `categories`、`totalBytes`、`totalFiles`、`partial`、`skippedCount`、`sizeNote`
    - `currentWorkspaceBytes` = 当前工作区 WorkspaceSessionDir 字节数 + `<StoreRoot>/<WorkspaceId>` 字节数；`projectFootprintTotal` 与 `sessionCount` 由当前工作区全部会话的 SelfFootprint 合计得出
    - 结合 `collectLiveSessions` 与 `listArchiveEntries` 产出 `orphan`
    - 新增 `getRankingRows()`：为排行页取当前工作区全部会话的行数据（恒 `self` 口径），返回 `{ rows, partial, skippedCount }`
    - 新增 `invalidateForDeletedFiles(paths)`：对每个被删文件自其所在目录向上逐级 `SubtreeCache.invalidate` 直至 StoreRoot（含），并丢弃 StorageCache 的汇总结果
    - StorageCache TTL 60 秒；`force !== true` 且未过期直接返回缓存。全部显式动作（ComputeSizeButton 左键、排行页打开/刷新、StorageReportCommand、清理后刷新）统一传 `force: true`；`force` 只绕过 StorageCache，不绕过 ArchiveIndex 的 4 秒节流
    - 提供 `clearCache()` 测试辅助；透传 `isCancelled` / `onProgress`
    - _Requirements: 1.1, 1.2, 1.3, 1.9, 1.10, 4.4, 4.6, 7.5, 7.9, 7.10, 7.13, 9.2, 13.2, 13.4, 13.12, 14.13_

  - [x]* 9.5 编写属性测试：归因守恒
    - **Property 5: 归因守恒**
    - **Validates: Requirements 2.3**
    - 随机会话与存档夹具，断言 `Σ 各会话自身口径存档部分 + 孤儿字节数 === 执行存档分类总字节数`

  - [x]* 9.6 编写属性测试：当前工作区归属等于两处目录之和
    - **Property 2: 当前工作区归属等于两处目录之和**
    - **Validates: Requirements 1.10**

  - [x]* 9.7 编写属性测试：非会话数据被排除在会话占用之外
    - **Property 6: 非会话数据被排除在会话占用之外**
    - **Validates: Requirements 2.6, 2.7**
    - 向 `sessions.json` 与 UnclassifiedBucket 追加字节，断言会话占用不变且 manifest 增量计入 `对话 JSON` 分类

  - [x]* 9.8 编写属性测试：统计幂等且缓存透明
    - **Property 7: 统计幂等且缓存透明**
    - **Validates: Requirements 2.9, 7.6, 11.5**
    - 断言冷缓存与热缓存（SubtreeCache / StorageCache 复用）结果相等

  - [x]* 9.9 编写属性测试：统计路径只读与调用面约束
    - **Property 14(a): 两段式调用面约束——统计路径只读**
    - **Validates: Requirements 6.8, 7.1, 7.4, 9.7, 11.8, 13.14**
    - 文件 `tests/storage.analyzer.property.spec.ts`（原属 `storage.scanner.property.spec.ts`，按 design.md 测试文件划分表迁入）
    - 覆盖一次完整的 ReadOnlyPaths 执行：汇总统计 + 会话占用 + 报告生成 + UsageRankingPage 取数；用 `snapshotTree` 前后对比，并用 `recordingReadFs` 断言调用名集合 ⊆ `{ readdir, lstat, stat, readFile, readFileSync }`，出现任何写调用或对存档内容的读取即失败

  - [x]* 9.10 编写示例测试 `tests/storage.analyzer.spec.ts`
    - UserDataDir 为 `null` → `unavailable` 分支不抛异常
    - 60 秒缓存命中与 `force: true` 强制重算；`force` 不绕过 4 秒 ArchiveIndex 节流
    - 夹具含不可读目录 → `partial: true` 且不抛异常
    - `invalidateForDeletedFiles` 失效被删文件所在目录到 StoreRoot 的完整祖先链
    - _Requirements: 1.2, 4.6, 7.5, 7.10, 11.7, 14.13_

- [x] 10. 报告渲染（`src/storage/report.ts`）
  - [x] 10.1 实现 `getReportData` 与 `renderStorageReport`
    - `StorageAnalyzer.getReportData` 聚合 summary、按字节数降序的工作区列表与会话列表，`sessionLimit` 默认 50 并计算 `omittedSessions`
    - 会话排行固定使用自身口径（`additive: true`）
    - `renderStorageReport` 输出固定四区块（分类构成、按工作区排行、按会话排行、孤儿存档合计），会话数为 0 时仍保留全部区块与「省略 0 条」
    - 孤儿区块说明文案只否定「批量清理」并给出理由（孤儿不归属排行页任一会话行），同时引导单会话清理去「Kiro: 存储占用排行」页操作；不出现暗示本版本不提供任何清理能力的表述
    - 报告本身不提供任何清理入口，模块不导入 `cleaner.ts`
    - 工作区展示名用 `decodeWorkspaceKey` 解码，失败回退原始目录名
    - 头部注明逻辑字节数口径；`partial` 时数值加 `≥` 前缀
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.9, 6.10, 6.11, 8.4_

  - [x]* 10.2 编写属性测试：报告结构不变量
    - **Property 12: 报告结构不变量**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.9**
    - 文件 `tests/storage.report.property.spec.ts`

  - [x]* 10.3 编写属性测试：EncodedKey 解码往返与失败回退
    - **Property 13: EncodedKey 解码往返与失败回退**
    - **Validates: Requirements 6.5**

  - [x]* 10.4 编写示例测试 `tests/storage.report.spec.ts`
    - 报告不导入 `cleaner.ts`、渲染结果不含任何清理入口
    - 孤儿区块文案含「不提供批量清理」及其理由，且不含整体否定清理能力的表述
    - _Requirements: 6.10, 6.11_

- [x] 11. 排行页取数与纯函数（`src/storage/ranking.ts`）
  - [x] 11.1 实现 `collectRankingRows` 取数
    - 枚举当前工作区 WorkspaceSessionDir 的**全部** SessionFile（stat 取 `size` / `mtimeMs`），不受搜索结果条数截断影响
    - 用 `listArchiveEntries()` 按 `chatSessionId` 归因得到 `archiveBytesSelf`，恒 `self` 口径；`totalBytes = jsonBytes + archiveBytesSelf`
    - 标题取清单优先、回退单文件标题；`RankingRow` 不带 `archiveBytesLineage`（避免诱导「两列可相加」的误用）
    - 只读实现：只用 `readdir` / `stat` / `readFile`，返回 `{ rows, skippedCount }`
    - _Requirements: 13.2, 13.4, 13.14_

  - [x] 11.2 实现 `compareRankingRows` 比较函数
    - 主键 `totalBytes` 随 `order` 反转；tiebreak 恒定方向：`mtimeMs` 降序 → `sessionId` 字典序升序，不随 `order` 反转
    - 纯函数，全序（`sessionId` 在同一目录内唯一，故同一输入排序结果唯一）
    - _Requirements: 13.5_

  - [x]* 11.3 编写属性测试：排序比较函数为全序且 tiebreak 不随方向反转
    - **Property 26: 排序比较函数为全序且 tiebreak 不随方向反转**
    - **Validates: Requirements 13.5**
    - 文件 `tests/storage.ranking.property.spec.ts`

  - [x] 11.4 实现 `pageOf` 分页切片与 `RANKING_PAGE_SIZE`
    - `totalPages = max(1, ceil(K / 50))`（`K = 0` 时为 1），`page` 经 `clamp(1, totalPages)` 归一
    - 返回排序后序列的 `[(M-1)*50, M*50)` 切片与 `{ page, totalPages, total }`
    - 纯函数，不产生任何文件系统调用（翻页与换序在 webview 端对已下发的全量数组重排 + 切片）
    - _Requirements: 7.13, 13.6, 13.7_

  - [x]* 11.5 编写属性测试：分页恒为全量排序序列的切片
    - **Property 25: 分页恒为全量排序序列的切片**
    - **Validates: Requirements 7.13, 11.11, 13.6, 13.7, 13.8, 13.17**

  - [x] 11.6 实现 `getRankingHtml` 渲染
    - CSP 与搜索面板同一套：`default-src 'none'`、`style-src ${cspSource} 'unsafe-inline'`、`script-src 'nonce-${nonce}'`、`font-src`/`img-src` 同源
    - 六列表格（会话标题、sessionId、会话 JSON 字节数、归因存档字节数、占用合计、最后修改时间），时间按本地时区 `YYYY-MM-DD HH:mm`
    - 所有动态文本（标题、sessionId、路径）先过 `escapeHtml`；标题空白 → `(无标题)`，超 120 字符 → 前 120 字符 + 省略号且完整标题放同样转义的 `title` 属性
    - `partial` 为 true 时 `≥` 前缀只加在「归因存档字节数」与「占用合计」两列，页脚展示 `skippedCount`
    - 每行提供 AttachmentCleanup 与 FullCleanup 两个清理入口；数值格式化复用 `size.ts`
    - _Requirements: 13.3, 13.10, 13.11, 13.13_

  - [x]* 11.7 编写属性测试：排行页取数与行渲染
    - **Property 24: 排行页取数与行渲染**
    - **Validates: Requirements 13.2, 13.3, 13.10, 13.13**
    - 生成器覆盖空白标题、超长标题、含 `<` / `>` / `&` / 引号的标题与 sessionId

- [x] 12. SessionCleaner（`src/storage/cleaner.ts`，本特性唯一可写模块）
  - [x] 12.1 定义清理数据模型与实现 `plan()`
    - 定义 `CleanupMode`、`CleanupPlan`、`CleanupResult`、`CleanerFsDeps`、`CleanerDeps`，字段与 design.md 的清理数据模型一致
    - `plan()` 全程只读：按 mode 收集待删文件——`attachment` 为 `chatSessionId` 与目标 sessionId **区分大小写严格相等**的 ExecutionArchive；`full` 再并上当前工作区 WorkspaceSessionDir 下的该 SessionFile 并把清单条目移除列为 `manifestUpdate`
    - `chatSessionId` 缺失、空字符串或纯空白的存档一律排除在任何会话的计划之外；SessionManifest 恒不进入 `plan.files`
    - 每个条目记录 `path` / `size` / `mtimeMs` 快照供确认后的 TOCTOU 复核；`createdAt` 进审计
    - 默认把 ReferencedArchive（被目标会话之外任一现存会话 lineage 引用的存档）从 `files` 中排除，单独给出 `referenced` / `referencedBytes` / `referencedFiles`，两个集合恒不相交
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [x]* 12.2 编写属性测试：CleanupPlan 的集合定义与封闭性
    - **Property 27: CleanupPlan 的集合定义与封闭性**
    - **Validates: Requirements 11.9, 14.1, 14.2, 14.3, 14.4, 14.7, 14.8**
    - 文件 `tests/storage.cleaner.property.spec.ts`；用 `recordingCleanerFs` 断言 `unlink` 实参集合 ⊆ `plan.files` 路径集合、不含目录路径、不含确认后新出现的文件；生成器覆盖 `chatSessionId` 缺失/空/纯空白/大小写变体/相似 sessionId

  - [x] 12.3 实现 `assertDeletable` 路径边界校验
    - 纯函数，白名单式判定（默认拒绝、显式放行），判定顺序固定为五步：① 原始形式含 `..` 路径段 → 拒绝（**必须在 `path.resolve` 之前判断**，否则 `..` 已被消掉）；② 规范化后不满足 `isUnder(storeRoot, p)` → 拒绝；③ 等于 `<sessionDir>/sessions.json` → 拒绝（清单要改不要删）；④ 不匹配「当前工作区 ExecutionSavesBucket 下 basename 为 hex32 的存档」或「`dirname === sessionDir` 且 basename 形如 `<sessionId>.json`」之一 → 拒绝；⑤ 符号链接 → 拒绝
    - 复用 `classify.ts` 的 `isUnder`，与统计侧共用同一路径归属语义；返回 `null` 表示通过，否则返回拒绝原因字符串
    - _Requirements: 8.6, 14.19_

  - [x]* 12.4 编写属性测试：路径边界校验的拒绝集合
    - **Property 28: 路径边界校验的拒绝集合**
    - **Validates: Requirements 8.6, 14.19**
    - 生成器覆盖五类拒绝向量（含 `..` 段、越出 StoreRoot、指向 SessionManifest、位于其它桶或其它工作区目录、符号链接）与两类通过向量；断言被拒绝路径恒进 `failed[]` 且恒不被 `unlink`

  - [x] 12.5 实现 `removeManifestEntry` 清单读改写
    - `JSON.parse(raw)`；非数组 → 返回 `{ error }`
    - 探测原文缩进（`/\n([ \t]+)/` 首个捕获组，探测不到用两空格）与行尾（含 `\r\n` → `\r\n`，否则 `\n`），过滤目标 sessionId 后按同风格重新序列化，保持其余条目的原数组顺序、字段与字段顺序不动不增；原文以行尾结束则补尾行
    - 单次 `writeFile` 覆盖写回，不使用临时文件与 `rename`（越界于 WritableFsAllowlist）
    - _Requirements: 14.11, 14.12_

  - [x] 12.6 实现 `run()` 的 12 段流水线与 `CleanerFsDeps` 注入
    - 段 0 互斥占位：`inflight.add(sessionId)`，已存在则返回 `state: 'rejected'` 并提示「该会话的清理正在进行」
    - 段 1 `plan()`：生成失败上抛给调用方；空计划直接返回 `state: 'noop'` 且**不**弹确认
    - 段 2 审计写入 CleanupPlan（删除前先落痕，写失败仅吞掉并在最终明细注明）
    - 段 3 模态确认：给出模式名称、释放字节数、文件数、被保留的引用冲突文件数与字节数，明文说明不可撤销且不进回收站；「取消」为默认按钮；用户显式选择包含 ReferencedArchive 时按更新后的合计做二次确认并说明其它会话历史 credit 用量将无法回溯；取消/关闭 → `state: 'cancelled'`，文件与清单原样
    - 段 4 `assertDeletable` 校验：拒绝路径进 `failed[]`（带原因），继续处理其余
    - 段 5 逐文件 re-stat 复核：不存在 → 跳过（释放 0 字节）；`size` 或 `mtimeMs` 与快照不一致 → 不删并计入跳过；跳过项进 `skipped[]` 而非 `failed[]`
    - 段 6 单文件 `unlink`：`EBUSY`/`EPERM`/`EACCES`/`ELOCK` 类错误重试至多 3 次、间隔 200ms（走注入的 `delay`）；仍失败或其它原因失败 → 进 `failed[]`，绝不中止其余删除
    - 段 7 清单读改写（仅 `full`）：解析失败/非数组/写失败 → `manifestUpdated: 'failed'`，保留已完成的删除结果且不抛异常
    - 段 8 缓存失效：`invalidateForDeletedFiles` 逐级失效 + `dropArchiveEntries` 摘除索引条目；无论全部成功、部分成功还是全部失败都执行
    - 段 9 刷新 UI：排行页当前页与页码指示、SummaryBar 三项数值、受影响会话的 SizeBadge
    - 段 10 审计写入明细：逐条被删文件路径与字节数、逐条失败路径与原因、逐条跳过路径与原因、三类计数合计与 `manifestUpdated` 结果
    - 段 11 `finally` 中 `inflight.delete(sessionId)`
    - 任何一段失败都不回滚已完成的段（删除不可逆，回滚是假承诺），结果与审计如实记录；`CleanerFsDeps` 只暴露 `unlink` / `stat` / `readFile` / `writeFile`（+ 可注入 `delay`），缺省退回 `fs.promises`，模块不导入 `rm` / `rmdir` / `rename` / `cp`
    - _Requirements: 8.6, 9.8, 9.9, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.16, 14.17, 14.18, 14.19, 14.20_

  - [x]* 12.7 编写属性测试：TOCTOU 复核的三分支跳过语义
    - **Property 29: TOCTOU 复核的三分支跳过语义**
    - **Validates: Requirements 14.20**
    - 用 `recordingCleanerFs` 的「确认后变更」注入点覆盖不存在 / `size` 变 / `mtimeMs` 变 / 完全一致四种复核结果

  - [x]* 12.8 编写属性测试：部分成功语义与三类计数守恒
    - **Property 30: 部分成功语义与三类计数守恒**
    - **Validates: Requirements 11.10, 14.9, 14.10**
    - 生成器覆盖锁类可重试失败、不可重试失败、校验拒绝、复核跳过与全部成功；断言 `deletedFiles + failed.length + skipped.length === plan.totalFiles`、重试次数至多 3 次且等待参数恒为 200ms

  - [x]* 12.9 编写属性测试：清理后的缓存失效范围与索引摘除
    - **Property 31: 清理后的缓存失效范围与索引摘除**
    - **Validates: Requirements 14.13**
    - 断言被 `invalidate` 的目录集合含每个被删文件到 StoreRoot 的完整祖先链、被摘除的索引键集合等于被删存档路径集合、StorageCache 汇总被丢弃

  - [x]* 12.10 编写属性测试：删除路径的调用面白名单
    - **Property 14(b): 两段式调用面约束——删除路径白名单**
    - **Validates: Requirements 9.8, 11.8**
    - 断言 `run()` 期间的调用名集合 ⊆ `{ unlink, stat, readFile, writeFile }`、不含递归删除/目录删除/重命名/移动；`writeFile` 实参路径恒只有 SessionManifest 一个且仅在 `mode === 'full'` 时出现

  - [x]* 12.11 编写示例测试 `tests/storage.cleaner.spec.ts`
    - 模态确认内容与「取消」为默认按钮、ReferencedArchive 的二次确认文案（含 credit 无法回溯说明）
    - 引用冲突两分支：默认排除并计入 ReferencedArchive；用户显式包含时纳入删除
    - 清单读改写保真：给定含 4 空格缩进 + CRLF 的清单原文逐字节比对，目标条目被移除、其余条目与字段原样
    - 清单解析失败 / 非数组 / 写失败三条降级路径；同 sessionId 清理互斥；审计两次写入的时序与文案
    - FullCleanup 后残留存档在下一次统计中变为孤儿；整体失败时通知文案「会话清理失败：…」
    - _Requirements: 3.8, 9.9, 11.12, 11.13, 14.5, 14.6, 14.11, 14.12, 14.16, 14.17, 14.18_

- [x] 13. Checkpoint - 统计与清理内核
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. 结果角标数据流（`src/search.ts`）
  - [x] 14.1 扩展 `SearchHit` 并实现 `attachFootprints`
    - 新增可选字段 `sessionJsonBytes`、`archiveBytesSelf`、`archiveBytesLineage`、`archivesFound`
    - 会话 JSON 字节数复用既有 `SessionIndexEntry.size`；存档字节数来自 `listArchiveEntries()`，不做任何全量目录枚举
    - 只对截断后的结果集（最近 20 / 搜索 10）计算；单条失败时省略该条字段并继续处理其余结果
    - 在 `searchSessionsInDir` 与 `listRecentSessions` 中与既有 `attachCredits` 并列调用；FullCleanup 删除的会话在后续取数中被排除
    - _Requirements: 5.1, 7.2, 7.7, 9.6, 14.15_

  - [x]* 14.2 编写属性测试：非显式动作恒不触发全量枚举
    - **Property 15: 非显式动作恒不触发全量枚举**
    - **Validates: Requirements 4.2, 4.8, 7.2, 7.7, 7.12, 13.16**
    - 追加到 `tests/storage.analyzer.property.spec.ts`；动作序列覆盖视图变为可见 / 输入关键词 / 切换过滤 / 点击既有刷新按钮 / 无工作区下打开排行页，断言 `scanTree` 调用次数为 0 且访问路径不含其它工作区目录

- [x] 15. Webview 渲染（`src/webview.ts`）
  - [x] 15.1 渲染 ComputeSizeButton 与四态 SummaryBar
    - 在 `injectedFormatScript()` 中追加 `formatSize` / `parseSize` / `summaryLabel` / `sizeBadgeLabel` 的源码注入
    - ComputeSizeButton：`.filters` 行内、既有 `#creditMode`（`Σ`）**左侧**的 `<span id="computeSize" class="filter-chip" role="button">⛁ 占用</span>`；左键 → `postMessage({ type: 'computeSize' })`；`contextmenu` 监听器中先 `e.preventDefault()` 再 `postMessage({ type: 'openRanking' })`；tooltip 固定为「左键统计当前项目占用 · 右键打开占用排行」
    - 忙碌态：`summary.state === 'loading'` 时加 `.busy` 类（`pointer-events: none` + 降透明度），收到 `ok` / `unavailable` 时移除，重复左键因此被忽略
    - SummaryBar：过滤 chip 与 ComputeSizeButton 之间的 `<span id="summary" class="summary-bar">`，样式 `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`；初始 `state: 'idle'` 只展示提示文案且不触发任何枚举
    - 处理 `summary` 四态消息，文本与 tooltip 全部由 `summaryLabel()` 产出；既有刷新按钮不再触发统计
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 9.3_

  - [x] 15.2 渲染 SizeBadge 并与 `Σ` 开关联动
    - 在 `row1` 的 `.time` 容器内、credit 角标之前渲染 `.badge.size`，≥100MB 时加 `.badge.size.warn`
    - `sizeBadgeLabel` 返回 `null` 时省略该条角标，其余结果不受影响
    - `$creditMode` 的 click 处理里同时切换 SizeBadge 的 `scope`，一次重渲染更新两个角标，不重新取数
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.6_

  - [x]* 15.3 编写示例测试 `tests/storage.badge.spec.ts`
    - SizeBadge 与 credit 角标并列的 HTML 结构；ComputeSizeButton 位于 `Σ` 左侧与其 tooltip 文案
    - `computeSize` / `openRanking` 消息时序与忙碌态：先 `loading` 再 `ok`，统计期间搜索与浏览照常可用，重复左键被忽略
    - 既有刷新按钮不触发统计；清理完成后 SummaryBar 三项数值被刷新
    - 统计失败不弹通知；命令失败文案格式
    - _Requirements: 4.3, 4.4, 4.5, 4.7, 4.8, 4.12, 5.1, 9.4, 9.5_

- [x] 16. RankingPanel 与宿主接线（`package.json` / `src/storage/ranking.ts` / `src/extension.ts`）
  - [x] 16.1 在 `package.json` 注册命令
    - `kiroChatSearch.storageReport`，标题「Kiro: 存储占用分析」
    - `kiroChatSearch.storageRanking`，标题「Kiro: 存储占用排行」
    - _Requirements: 6.1, 13.1_

  - [x] 16.2 在 `SearchSession` 接入新的手动触发协议
    - 视图/面板变为可见时推 `{ type: 'summary', state: 'idle' }`，**不**触发任何统计与目录枚举
    - 新增上行消息 `computeSize`：先推 `loading`，再以 `getSummary({ force: true })` 与当前结果集的 ResultSetFootprintTotal 异步取数，完成推 `ok`、失败或 UserDataDir 为 `null` 推 `unavailable`；用 `summaryInflight` 标志忽略统计期间的重复请求
    - 新增上行消息 `openRanking`：执行 `kiroChatSearch.storageRanking`，不改 SummaryBar 当前状态
    - `hardRefresh` 语义收窄为只重新取搜索结果，不再触发统计；`revalidate` / `search` / `open` / `close` 保持不触发统计
    - 统计在独立异步任务中进行，`results` 推送不等它；统计失败不弹通知
    - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 7.7, 7.12, 9.3, 9.4_

  - [x] 16.3 实现 StorageReportCommand
    - 注册 `kiroChatSearch.storageReport`，用 `vscode.window.withProgress`（Notification + `cancellable: true`）展示进度并提供取消入口
    - 把 `token.isCancellationRequested` 透传为 `isCancelled`，取消后 1 秒内停止枚举且保留已完成聚合于缓存
    - 报告写入模块级复用的 `OutputChannel` 并 `show()`，全过程不创建任何文件
    - 整体失败时 `showErrorMessage('存储占用分析失败：' + message)`；取消不算失败不弹通知
    - _Requirements: 6.1, 6.6, 6.7, 6.8, 9.5, 9.7_

  - [x] 16.4 实现 `RankingPanel` 单例与五态状态机
    - 模块级 `current`，`showOrCreate` 命中已有实例时只 `reveal()` 并保持当前 `page` 与 `sortOrder`（状态存活在 webview 侧的 `RankingViewState`，`retainContextWhenHidden: true`）；`onDidDispose` 清掉 `current`，故关闭后重开回到第 1 页与默认 `desc`
    - 五态状态机与控件禁用：`loading`（「统计中…」，排序/翻页/刷新/清理全禁用、面板仍可关闭、`inflight` 忽略重复统计请求）、`ok`（当前页表格 + 「第 M / N 页 · 共 K 个会话」，M=1 禁上一页、M=N 禁下一页）、`empty`（「当前项目还没有可统计的会话」+「第 1 / 1 页 · 共 0 个会话」，表头与分页控件结构保留并禁用）、`no-workspace`（说明无法统计的文案，结构保留置灰，且不发生任何目录枚举）、`unavailable`（「占用统计不可用」，刷新保持可用）
    - 一次性下发全量 `RankingRow[]` 与 `RankingViewState`，翻页与换序在 webview 端 `sort` + `slice` 不回宿主；换序把页码重置为 1；刷新以 `force: true` 重取并保持 `sortOrder` 不变；清理使 K 减少后按 `min(M, N)` 重渲染
    - 恒 `self` 口径，不读也不写搜索面板的 `creditMode` 状态
    - 行内两个清理入口调用 `SessionCleaner.run(mode, sessionId, title)`，完成后走 `refresh()`
    - _Requirements: 13.1, 13.4, 13.9, 13.11, 13.12, 13.15, 13.16, 13.17, 7.13_

  - [x] 16.5 实现 OpenRankingCommand 与清理结果的 UI 接线
    - 注册 `kiroChatSearch.storageRanking` → `RankingPanel.showOrCreate(context, deps)`；打开失败时按同形态通知提示
    - 把 StorageReportCommand 的模块级 `OutputChannel` 复用为 CleanupAuditLog 的写入目标，使报告与删除记录落在同一处可回溯的文本流
    - 装配 `CleanerDeps`：`audit` 写该 OutputChannel、`confirm` 走 `showWarningMessage`（模态、「取消」为默认按钮）、`archives` 取 `listArchiveEntries()`、`invalidate` 串起 `analyzer.invalidateForDeletedFiles` 与 `dropArchiveEntries`
    - 清理结束后刷新排行页当前页、SummaryBar 三项数值与受影响会话的 SizeBadge
    - _Requirements: 4.12, 9.4, 9.9, 13.1, 14.14, 14.15, 14.16_

  - [x]* 16.6 编写示例测试 `tests/storage.ranking.spec.ts`
    - 面板单例与 `reveal` 保持页码/方向、关闭后重开重置为第 1 页与 `desc`
    - CSP 字符串比对；`empty` / `no-workspace` / `loading` 三态的控件禁用与文案
    - 恒 `self` 且不改搜索面板 `Σ` 状态；刷新保持排序方向；行内两个清理入口存在
    - _Requirements: 13.1, 13.4, 13.9, 13.11, 13.12, 13.13, 13.15, 13.16_

- [x] 19. SessionTitleLink：排行页标题超链接打开会话（Req 13.18–13.25）
  - [x] 19.1 `renderRankingRowHtml` 把标题渲染为链接元素
    - `<span class="t link" role="link" tabindex="0" data-open="1" aria-label="打开会话：<完整标题>">`；不用 `<a href>`，sessionId 不进任何可导航 URL（Req 13.25）
    - 保持既有 `(无标题)` 占位与 120 字符截断规则不变；`aria-label` 与 `title` 同样过 `escapeHtml`
    - CSS 走主题变量：`--vscode-textLink-foreground` / `--vscode-textLink-activeForeground`，`:focus-visible` 焦点环用 `--vscode-focusBorder`；`tbody.locked` 下退回普通文本样态
    - _Requirements: 13.3, 13.13, 13.18, 13.21, 13.25_

  - [x] 19.2 注入脚本：事件委托 + 键盘激活 + 非 ok 态门禁
    - 复用既有 tbody 事件委托：标题链接先判、命中即 return，与 `button.op` 分支互不误触；两者同受 `canInteract()` 门禁
    - `keydown` 支持 Enter / Space（与表头排序、刷新按钮同一手法）
    - `openFromRow` 只上报 `{ type: 'openSession', sessionId }`——标题与布局不回传（Req 13.20）
    - `syncControls` 用 `$rows.classList.toggle('locked', !interactive)` 同步可点样态（Req 13.21）
    - 翻页/换序后重渲染的行天然绑定正确 sessionId（委托 + `data-session-id`，Req 13.22）
    - _Requirements: 13.19, 13.20, 13.21, 13.22, 13.24, 13.25_

  - [x] 19.3 宿主接线：`RankingPanelDeps.openSession` 与 `lastRows` 反查
    - `RankingInboundMessage` 新增 `openSession`；`RankingPanelDeps.openSession?` 可选注入（不注入则只落日志、不跳转）
    - `RankingPanel.lastRows` 记录上一次下发给 webview 的全量行，按 sessionId 反查 `title` 与 `origin`；`origin → sessionLayout`：`legacy-unmigrated` → `'old'`，`new` / `migrated` → `'new'`（Req 13.20）
    - 进入 `no-workspace` / `unavailable` 时清空 `lastRows`，避免拿过期行跳转
    - `handleOpenSession` 恒不抛异常、不改面板状态，失败只写审计日志（Req 13.23）
    - `extension.ts` 抽出共用的 `openSessionByJump()`，搜索面板的 `openSession` 一并改为复用它，避免两处各自装配 jump deps 出现偏差；`layout` 在调用时现取
    - _Requirements: 13.19, 13.20, 13.23_

  - [x] 19.4 测试
    - `tests/storage.ranking.spec.ts` 新增一组示例测试：链接元素属性与非 `<a href>`、载荷只含 sessionId、与清理按钮互不误触且都受门禁、Enter/Space 键盘激活、非 ok 四态给 tbody 加 `locked`、主题变量与焦点环、CSP 未放宽且无内联事件处理器
    - `runSync` 的 tbody 替身补上 `classList` 并返回 `$rows`，使 `locked` 可被断言
    - Property 24 的标题断言随渲染结构更新，并追加"恒不出现 `<a ` 与 `href=`"
    - 上行消息集合断言追加 `openSession`（仍为精确等值集合，`sort`/`page` 恒不出现）
    - _Requirements: 13.18, 13.19, 13.20, 13.21, 13.22, 13.25_

- [x] 17. 文档
  - [x] 17.1 更新 `README.md`
    - 描述 ComputeSizeButton、SummaryBar、SizeBadge、UsageRankingPage 与 StorageReportCommand 的用途与触发方式，并注明占用统计仅在用户显式触发时执行
    - 说明自身口径与累计口径的差异，以及累计口径不可跨会话求和的原因
    - 说明孤儿执行存档的定义、来源机制，并注明孤儿存档本版本仅统计、不提供批量清理及其理由
    - 对照 `CATEGORY_META` 列出各分类对应的磁盘路径
    - 注明统计采用 stat 逻辑字节数，与资源管理器「占用空间」可能有差异
    - 说明 AttachmentCleanup 与 FullCleanup 各自删除的内容、操作不可撤销且不进回收站、以及被其它会话 lineage 引用的存档默认保留这一规则
    - 说明 UsageRankingPage 与 StorageReportCommand 并存的分工：前者覆盖当前项目并提供清理入口，后者覆盖全部工作区并输出可复制的纯文本报告
    - 说明清理操作的审计记录写入 Kiro 输出通道，供用户核对被删除的文件清单
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8_

- [x] 18. Final checkpoint - 全量验证
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 带 `*` 的子任务为可选测试任务，可为快速 MVP 跳过
- 每个任务标注对应的细化需求条款，便于追溯
- Property 1–31 与 design.md 的「Correctness Properties」一一对应，每条属性一个属性测试（Property 14 按 (a)(b) 拆为两个），`numRuns` 不低于 100
- 属性测试与示例测试的文件归属严格遵循 design.md 的「测试文件划分」表，避免重复覆盖输入空间
- 所有涉及文件系统的测试在临时目录构造夹具并在 `afterEach` 清理；清理相关的属性测试默认走注入的假 fs（`recordingCleanerFs`），只有少量示例测试真的在临时目录里删文件
- 清理是本特性唯一的破坏性能力，实现时必须守住五条：只删 CleanupPlan 已枚举并在确认中计入的具体文件、白名单式路径边界校验（先查 `..` 再规范化）、删除前逐文件 re-stat 复核、不提供撤销与回收站、审计在删除前后各写一次
- 设计中的 vscode 宿主 API 装配、CSS 省略号截断与 README 内容不写属性测试，由示例测试与人工检查覆盖

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1", "16.1"] },
    { "id": 1, "tasks": ["2.2", "2.5", "3.2", "5.1", "6.1"] },
    { "id": 2, "tasks": ["2.3", "2.6", "3.3", "5.2", "6.2", "7.1"] },
    { "id": 3, "tasks": ["2.4", "2.7", "2.8", "5.3", "7.2"] },
    { "id": 4, "tasks": ["5.4", "5.7", "7.3", "9.1"] },
    { "id": 5, "tasks": ["5.5", "9.2", "14.1"] },
    { "id": 6, "tasks": ["5.6", "7.4", "7.5", "9.3", "9.4"] },
    { "id": 7, "tasks": ["9.5", "10.1", "11.1", "15.1"] },
    { "id": 8, "tasks": ["9.6", "10.2", "11.2", "12.1", "15.2"] },
    { "id": 9, "tasks": ["9.7", "10.3", "11.3", "11.4", "12.2"] },
    { "id": 10, "tasks": ["9.8", "10.4", "11.5", "11.6", "12.3"] },
    { "id": 11, "tasks": ["9.9", "11.7", "12.4", "12.5", "15.3"] },
    { "id": 12, "tasks": ["12.6", "14.2", "16.2"] },
    { "id": 13, "tasks": ["12.7", "16.3", "16.4"] },
    { "id": 14, "tasks": ["9.10", "12.8", "16.5"] },
    { "id": 15, "tasks": ["12.9", "16.6", "17.1"] },
    { "id": 16, "tasks": ["12.10", "12.11"] }
  ]
}
```
