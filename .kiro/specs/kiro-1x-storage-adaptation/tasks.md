# Implementation Plan: kiro-1x-storage-adaptation

## Overview

按设计的四条数据流分层实现：先做**路径与布局底座**（WsHash16、LayoutDetector、EnvChecker 放行），
再做**新格式读取**（NewFormatReader、用量），随后接入**浏览与搜索**（双源合并、来源判定、跳转），
接着是**占用统计**（分类器注入、新布局占用、两个聚合维度、旧残留），最后是**清理**（目录型两模式、
非递归 rmdir 收尾、旧残留清理）与接线、文档。

实现语言为 TypeScript（沿用既有 `src/` 结构与 `tests/` 的 vitest + fast-check 约定）。
每条设计属性（Property 1–20）对应一个独立的属性测试子任务，测试文件划分与 design.md 的
「Testing Strategy」表一致。

**两处需要格外小心的内部重构**（它们动到已上线且有 391 个测试覆盖的代码）：
`search.ts` 抽出 SessionSource、`scanner.ts` 加可注入分类器。两者都拆成「先纯重构、
既有测试全绿」与「再接入新能力」两步，任务里显式要求先建立基线。

三条硬约束贯穿全部任务：
ReadOnlyPaths 严格只读（模块图上不得出现写 API 的 import）；
占用统计只在用户显式动作时执行；
注入 webview 的函数体不得引用被导出的 const 或跨模块导入的绑定（design D9，已真实踩坑）。

## Tasks

- [x] 1. 基础设施：夹具与共享数据模型
  - [x] 1.1 扩展 `tests/_helpers.ts` 的新格式夹具构造器
    - 新增 `mkNewSessionTree(root, spec)`：在临时目录构造 `<wsHash16>/<sessionId>/` 目录型会话，支持指定 `session.json` 字段、`messages.jsonl` 事件序列、`snapshots/` 与 `sub-executions/` 文件
    - 新增 `mkMessagesJsonl(events)`：按 `{id,timestamp,payload}` 生成 JSONL 文本，支持插入非法行以测容错
    - 新增 `mkMigrationMarker(dir, v2SessionId, v1WorkspaceDirectory)`：构造旧目录里的 `._migration-<uuid>.json`
    - 复用既有 `mkTempDir` / `rmTempDir` / `mkTree` / `snapshotTree` / `recordingReadFs` / `recordingCleanerFs`，不改其行为
    - _Requirements: 15.1_

  - [x] 1.2 扩展 `src/storage/types.ts` 的共享数据模型
    - `StorageCategory` 新增 `newSession` / `newSnapshots` / `newSubExecutions` / `newSessionIndex`
    - `RankingRow` 新增 `origin: SessionOrigin`
    - 新增 `AggregateTotal`（含 `state` / `bytes` / `files` / `sessionCount` / `workspaceCount` / `partial` / `skippedCount` / `roots`）
    - 新增 `LegacyResidueTotal extends AggregateTotal`（含 `migratedResidueBytes/Files` 与 `unmigratedBytes/Files`）
    - 本模块保持纯类型 + 常量，不引入任何运行时依赖
    - _Requirements: 6.1, 7.1, 8.1, 8.6, 9.1_

- [x] 2. 路径层：双版本解析（`src/paths.ts` 扩展）
  - [x] 2.1 实现 1.x 根路径与 WsHash16
    - 新增 `getHomeKiroDir(deps?)`：经 `os.homedir()` 解析 `~/.kiro`，不存在返回 `null`
    - 新增 `getNewSessionsRoot(deps?)` / `getNewSessionIndexRoot(deps?)`
    - 新增 `computeWsHash16(workspacePath)`：先把反斜杠替换为正斜杠、再转小写，取 `sha256` 十六进制前 16 位
    - 新增 `resolveNewWorkspaceSessionDir(newSessionsRoot, workspacePath, deps?)`：目录不存在返回 `null`
    - 既有 `getKiroUserDataDir` / `getSessionsRoot` / `encodeWorkspaceKeys` / `resolveWorkspaceSessionDir` **签名与行为一字不改**
    - 全部经既有 `PathResolverDeps` 注入，测试无需读写真实用户目录
    - _Requirements: 2.1, 2.2, 2.7, 2.8, 2.9, 14.1, 14.3_

  - [x]* 2.2 编写属性测试：WsHash16 归一化不变性
    - **Property 1: WsHash16 归一化不变性**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 14.3**
    - 文件 `tests/paths.newlayout.property.spec.ts`，`{ numRuns: 100 }`；生成器覆盖盘符大小写与斜杠方向的全部组合

  - [x]* 2.3 编写属性测试：旧路径解析回归不变
    - **Property 2: 旧路径解析回归不变**
    - **Validates: Requirements 2.5, 2.6**
    - 纯护栏：确保本次适配不改动 0.9x 的解析输出

  - [x]* 2.4 编写属性测试：归属判断按路径段边界
    - **Property 20: 归属判断按路径段边界**
    - **Validates: Requirements 14.2**
    - 生成器覆盖同前缀兄弟目录（`sessions` / `sessions-old`）

  - [x] 2.5 编写示例测试 `tests/paths.newlayout.spec.ts`
    - 实测基线：`d:\Projects\KiroExt\KiroChatSearcher` → `cc5023603866cd91`、`d:\SurErp\ERP-OMS-Workspaces` → `6082f0c94c5c4af8`
    - 新根缺失时各解析函数返回 `null` 且不抛异常
    - _Requirements: 2.4, 2.7_

- [x] 3. 布局检测与环境放行
  - [x] 3.1 新建 `src/layout.ts` 实现 LayoutDetector
    - 实现 `detectLayout(workspacePath, deps?)`：返回 `LayoutRoots`（含 `layout` 与新旧各自的根，不可用者为 `null`）
    - 判定依据：「NewWorkspaceSessionDir 存在且含至少一个会话子目录」与「OldWorkspaceSessionDir 存在且含至少一个 `<sessionId>.json`」两条件的组合
    - 任一侧根缺失时置 `null` 并保留另一侧，不抛异常
    - 只读实现：仅路径拼接、存在性判断、目录枚举与 stat
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.12, 1.13_

  - [x] 3.2 改造 `src/env.ts` 为「两根任一可用即 ok」
    - 解析顺序调整为：UserDataDir/HomeKiroDir → 两根可用性 → 未打开工作区 → 工作区会话目录
    - 两根均不可用时报「未找到 Kiro 对话存储目录」，提示同时给出 `~/.kiro/sessions` 与旧路径两个预期位置
    - `EnvCheck` 新增 `newWorkspaceDir` 与 `layout`；既有 `workspaceDir` 仍指旧格式目录，既有调用方不受影响
    - `none` 且已打开工作区时保持「当前项目还没有 Kiro 对话历史」提示
    - _Requirements: 1.4, 1.7, 1.8, 1.9, 1.10, 1.11_

  - [x]* 3.3 编写属性测试：布局判定完备且互斥
    - **Property 3: 布局判定完备且互斥**
    - **Validates: Requirements 1.3, 1.13**
    - 生成器覆盖新旧目录存在性与「目录存在但为空」的全部组合

  - [x] 3.4 编写示例测试 `tests/layout.spec.ts`
    - 四种夹具下 `detectLayout` 返回对应 StorageLayout
    - `new-only` 与 `old-only` 夹具下 `checkEnvironment` 均返回 `ok`（这是纯 1.x 环境能用的关键回归点）
    - 两根均缺失时的错误文案含两个预期位置
    - _Requirements: 1.7, 1.8, 1.9_

- [x] 4. Checkpoint - 路径与布局底座
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 新格式会话读取（`src/session/newFormat.ts`）
  - [x] 5.1 实现 `readNewSessionMeta` 与会话枚举
    - 枚举 NewWorkspaceSessionDir 的子目录作为会话来源，**不使用**追加式的 `session-index/*.jsonl`
    - 解析 `session.json` 得 `NewSessionMeta`；`title` 缺失/空/纯空白 → `Untitled`
    - `modified` 取 `lastModifiedAt`，缺失或非法时回退 `messages.jsonl` 的 mtime
    - 缺 `session.json` 或 `messages.jsonl` 的会话跳过并继续其余，不抛异常
    - _Requirements: 3.1, 3.2, 3.9, 3.10_

  - [x] 5.2 实现 `messages.jsonl` 逐行解析
    - 只从 `payload.type` 为 `user` / `assistant` 的事件提取文本作为匹配与预览来源
    - 其余 11 种事件类型排除在匹配文本之外
    - `hasImage`：检测内容项 `type` 含 `image` 或存在 `imageUrl` / `image` 字段，命中首个即停止；内嵌 base64 图片数据不读入不比对
    - `hasAttachment`：事件携带非空 `contextItems`，或该会话 `snapshots/` 存在且含至少一个文件
    - 单行非法 JSON → 跳过该行继续解析其余行
    - _Requirements: 3.3, 3.4, 3.6, 3.7, 3.8, 3.12, 3.13_

  - [x] 5.3 实现 `(mtimeMs, size)` 失效缓存
    - 以 `messages.jsonl` 与 `session.json` 的 `(mtimeMs, size)` 组合为失效判据
    - 缓存标题、匹配文本、`hasImage`、`hasAttachment`；内嵌 base64 图片数据排除在缓存内容之外
    - 复用既有 `search.ts` 的缓存风格，提供测试用清空辅助
    - _Requirements: 3.11, 3.12_

  - [x]* 5.4 编写属性测试：消息解析的容错性
    - **Property 4: 消息解析的容错性**
    - **Validates: Requirements 3.8**
    - 文件 `tests/session.newformat.property.spec.ts`；在任意位置插入任意非法行，断言其余行解析结果不变

  - [x] 5.5 编写示例测试 `tests/session.newformat.spec.ts`
    - 标题/预览/`hasImage`/`hasAttachment` 提取；空白标题占位
    - 缺文件的会话被跳过而其余会话照常返回
    - `lastModifiedAt` 非法时回退 mtime
    - _Requirements: 3.2, 3.9, 3.10_

- [x] 6. 新格式用量读取（`src/credits.ts` 扩展）
  - [x] 6.1 实现 `getCreditsFromMessages`
    - 逐行取出 `payload.type === 'usage_summary'` 事件，累加 `unit` 按不区分大小写等于 `credit` 的用量数值
    - 不带 credit 单位标记的项（如工具使用记录）排除在求和之外
    - 无 `usage_summary` 或无 credit 项 → 标记不可用，不抛异常
    - 按 `messages.jsonl` 的 `(mtimeMs, size)` 缓存解析结果
    - 既有 `hash32` / `listArchiveEntries` / `dropArchiveEntries` / 存档查表**原样保留**，适用范围收窄到 0.9x
    - _Requirements: 4.1, 4.2, 4.6, 4.7, 4.10, 4.11_

  - [x] 6.2 实现按格式选择取数路径
    - 1.x 会话：`self` 与 `lineage` 取同一值（用量记在会话自身消息流中）
    - 0.9x 会话：沿用既有存档查表与既有双口径语义
    - 同一 SearchHit 上 credit 角标语义在两种格式下一致
    - _Requirements: 4.3, 4.5, 4.9_

  - [x]* 6.3 编写属性测试：用量求和口径
    - **Property 8: 用量求和口径**
    - **Validates: Requirements 4.1, 4.2, 4.3**
    - 生成器覆盖混入非 credit 单位项、缺失 `unit`、数值为 NaN/负数等边界

  - [x] 6.4 编写示例测试 `tests/credits.newformat.spec.ts`
    - 1.x 夹具上按 credit 单位过滤并汇总；1.x 会话 `self === lineage`
    - 0.9x 存档查表回归不变
    - credit 不可用时该条角标被省略而其余结果不受影响
    - _Requirements: 4.5, 4.7, 4.8_

- [x] 7. 浏览与搜索：双源统一（`src/search.ts` 内部重构）
  - [x] 7.1 抽出 SessionSource 接口（纯重构，行为不变）
    - **先跑通既有全部测试建立基线**，本子任务结束时既有测试必须仍然全绿且断言未被修改
    - 把「枚举目录 → 读取一条会话 → 索引缓存」抽为可注入的 SessionSource，把 0.9x 现有实现搬为其默认实现
    - `searchSessionsInDir` / `listRecentSessions` 的对外签名与返回值保持不变
    - _Requirements: 13.2_

  - [x] 7.2 接入新格式源并实现双源合并去重
    - 按 LayoutRoots 选择源：`both` 合并双源、`new-only` 仅新源、`old-only` 仅旧源
    - 同 sessionId 在双源各有一份时只保留新格式那份
    - 合并后按最后修改时间倒序统一排序，按既有条数上限截断（搜索 10 条、最近 20 条）
    - `SearchHit` 新增 `origin` 与 `layout`，字段结构在两种格式下一致
    - 关键词匹配、`matchField`、snippet 截取沿用既有规则，不因来源分支
    - _Requirements: 3.5, 13.1, 13.2, 13.3, 13.4, 13.5, 13.8_

  - [x] 7.3 实现 SessionOrigin 判定
    - 新目录内 `sess_` 前缀 → `new`；新目录内裸 uuid → `migrated`；仅旧目录存在 → `legacy-unmigrated`
    - 旧目录内存在 `v2SessionId` 指向该 sessionId 的 MigrationMarker → `migrated`
    - `both` 下同 sessionId 双份 → 以新格式为展示来源、判为 `migrated`、列表只出现一次
    - 判定在同一磁盘状态下可重复
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 9.9_

  - [x]* 7.4 编写属性测试：双源合并去重
    - **Property 9: 双源合并去重**
    - **Validates: Requirements 9.8, 13.3**
    - 文件 `tests/search.dual.property.spec.ts`

  - [x]* 7.5 编写属性测试：来源判定确定且完备
    - **Property 10: 来源判定确定且完备**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.9**

  - [x] 7.6 编写示例测试 `tests/search.dual.spec.ts`
    - 三种布局下的取数范围；同 sessionId 去重后只返回一份且 `origin` 为 `migrated`
    - AttachmentFilter 在合并列表上对两种格式给出一致的过滤语义
    - 过滤后为空时保持既有「没有符合条件的对话」提示
    - _Requirements: 13.1, 13.2, 13.6, 13.7_

- [x] 8. 跳转适配（`src/jump.ts` 扩展）
  - [x] 8.1 按布局切换候选列表
    - 1.x 候选：`kiroAgent.viewSession(sessionId, title?)` → `kiroAgent.sessions.switch(sessionId, windowId, source)`
    - 标题为空或纯空白时省略第二个参数
    - sessionId 原样传递，不改写前缀、不补齐、不截断
    - `old-only` 布局下把既有 0.9x 候选作为 1.x 候选之后的降级候选，使旧版 Kiro 行为不变
    - 1.x 候选中**不含** `kiroAgent.loadSessionWithPrompt`（新签名忽略 sessionId 且会向会话发消息）
    - 全部失败时通知列出已尝试的候选命令名；成功时保持面板打开并返回实际生效的命令名
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 8.2 编写示例测试 `tests/jump.newlayout.spec.ts`
    - `viewSession` 可用时优先调用并传入 sessionId 与标题；不可用时回退 `sessions.switch`
    - 1.x 候选列表不含 `loadSessionWithPrompt`
    - `sess_<uuid>` 与裸 uuid 均原样传参
    - _Requirements: 5.3, 5.5, 15.15_

- [x] 9. Checkpoint - 浏览、搜索与跳转
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. 分类与扫描（`src/storage/classify.ts` 扩展、`scanner.ts` 内部重构）
  - [x] 10.1 实现新布局分类
    - 新增 `NewClassifyRoots` / `buildNewClassifyRoots(homeKiroDir)`
    - 实现 `classifyNewPath` 的 5 条有序规则：索引 → `snapshots/` → `sub-executions/` → sessions 根下其余（含 `publish*.cursor`）→ `otherFiles`
    - 复用既有 `isUnder` 做路径段边界判断，与旧分类共用同一归属语义
    - `CATEGORY_META` 补齐 4 个新分类的中文标签与磁盘路径模板
    - _Requirements: 6.1, 6.2, 14.2, 14.4_

  - [x] 10.2 给 `scanner.ts` 增加可注入分类器（重构，默认行为不变）
    - **先跑通既有全部测试建立基线**；`ScanOptions` 新增可选 `classify?: (fullPath) => StorageCategory`，提供时优先于 `roots`
    - 不传 `classify` 时行为与本子任务实施前字节级一致，既有 scanner 测试断言不得修改
    - 遍历预算、让出频率、深度上限、符号链接不跟随、跳过计数、子树缓存一概不动
    - _Requirements: 6.11, 6.12, 6.13, 6.14, 14.5_

  - [x]* 10.3 编写属性测试：新布局分类构成一个划分
    - **Property 6: 新布局分类构成一个划分**
    - **Validates: Requirements 6.1, 6.5**
    - 文件 `tests/storage.newlayout.property.spec.ts`；生成器覆盖同前缀兄弟目录与深层嵌套

- [x] 11. 占用统计扩展（`src/storage/analyzer.ts`）
  - [x] 11.1 实现新布局的 SessionFootprint 与排行取数
    - 1.x 会话占用 = 该会话目录内全部文件字节数之和；`self` 与 `lineage` 同值且 `additive: true`
    - `RankingRow` 映射：`jsonBytes` = `session.json` + `messages.jsonl`，`archiveBytesSelf` = `snapshots/` + `sub-executions/`，合计恒等于两者之和
    - `mtimeMs` 取 `lastModifiedAt`，按既有本地时区格式展示
    - _Requirements: 6.3, 6.4, 6.6, 6.8, 6.9, 6.10, 6.15_

  - [x] 11.2 实现双布局合并与残留归属
    - `both` 下同时计量新旧两处；同 sessionId 双份时以新格式为该会话 SessionFootprint 的唯一来源，旧份计入 LegacyResidue 而不计入该会话占用
    - 每个会话在 ProjectSessionTotal 中恰好被计入一次
    - _Requirements: 6.7, 7.4_

  - [x] 11.3 实现 `getProjectSessionTotal`
    - 由排行页同一次枚举结果聚合得出，不为该维度额外发起目录枚举
    - 返回字节数与参与统计的会话数
    - _Requirements: 7.2, 7.3, 7.4_

  - [x] 11.4 实现 `getAllKiroSessionTotal`
    - 扫描 NewSessionsRoot 下全部工作区目录求和，返回工作区目录数与会话数并缓存
    - `old-only`（NewSessionsRoot 不存在）时回退扫描 OldSessionsRoot
    - 只统计会话数据，LegacyResidue 排除在默认范围之外
    - _Requirements: 7.6, 7.7, 7.10_

  - [x] 11.5 实现 `getLegacyResidueTotal`
    - 扫描旧残留目录，返回字节数、文件数与涉及的工作区目录数并缓存
    - 把旧数据划分为「已迁移仅残留」（新目录存在同 sessionId 目录，或旧目录存在指向它的 MigrationMarker）与「未迁移」两部分并分别给出字节数
    - 旧目录不存在或不可读时标记不可用，其余统计不受影响，不弹窗
    - 只读实现
    - _Requirements: 8.1, 8.5, 8.6, 8.8, 8.10_

  - [x] 11.6 实现聚合维度的缓存失效
    - 一次清理成功释放字节数大于 0 时，使 ProjectSessionTotal / AllKiroSessionTotal / LegacyResidueTotal 的缓存失效
    - 复用既有子树聚合缓存与祖先链失效机制
    - _Requirements: 7.13, 8.8, 11.8_

  - [ ]* 11.7 编写属性测试：新格式占用可加性
    - **Property 5: 新格式占用可加性**
    - **Validates: Requirements 6.3, 7.2**

  - [ ]* 11.8 编写属性测试：统计幂等且缓存透明
    - **Property 7: 统计幂等且缓存透明**
    - **Validates: Requirements 6.14, 6.15, 12.7**

  - [ ]* 11.9 编写属性测试：统计路径只读
    - **Property 11: 统计路径只读**
    - **Validates: Requirements 12.1, 12.2**
    - 覆盖一次完整统计（汇总 + 排行取数 + 两个聚合维度 + 旧残留）；`snapshotTree` 前后对比 + `recordingReadFs` 断言调用名集合；并静态审查新增模块无写 API 导入

  - [ ]* 11.10 编写属性测试：非显式动作恒不触发全量枚举
    - **Property 17: 非显式动作恒不触发全量枚举**
    - **Validates: Requirements 12.4, 12.5, 12.6, 15.18**
    - 文件 `tests/storage.aggregate.property.spec.ts`；断言两个聚合维度未触发时恒不枚举其它工作区目录与旧残留目录

  - [x] 11.11 编写示例测试 `tests/storage.aggregate.spec.ts`
    - 两个聚合维度的口径与手动触发；`old-only` 下 AllKiroSessionTotal 回退扫旧目录
    - 「已迁移仅残留」与「未迁移」的划分
    - 清理后缓存失效并反映更新后的数值
    - _Requirements: 7.6, 7.7, 8.6, 7.13_

- [ ] 12. 排行页与报告（`src/storage/ranking.ts`、`report.ts`）
  - [x] 12.1 在排行表之上渲染两个聚合维度与旧残留维度
    - ProjectSessionTotal 随排行数据一同下发；AllKiroSessionTotal 与 LegacyResidueTotal 各有独立的手动触发控件
    - 未触发时展示空闲态提示且不发生对应枚举；计算中展示「统计中…」、忽略重复触发、保持表格可浏览与面板可关闭
    - `partial` 时数值加 `≥` 前缀并在 tooltip 给出 `skippedCount`
    - tooltip 给出参与统计的会话数、工作区目录数、被统计根路径、会话本体与快照的字节数拆解；`both` 下需说明单会话占用不含旧残留部分
    - `old-only` 下隐藏 LegacyResidueTotal 维度
    - **遵守 design D9**：新增的注入函数体不得引用被导出的 const 或跨模块导入的绑定；需要的常量由宿主实际值生成 `const` 声明一并注入
    - _Requirements: 7.1, 7.5, 7.8, 7.9, 7.11, 7.12, 7.14, 8.2, 8.3, 8.4, 8.7, 8.9, 6.7_

  - [x] 12.2 每行渲染 MigrationStatus 与新布局会话行
    - 为 `new-only` / `both` 布局下每个会话目录渲染一行，沿用既有排序分页规则
    - 每行以 MigrationStatus 指示展示 SessionOrigin，tooltip 说明取值含义与该会话数据所在根目录
    - 所有动态文本先过 `escapeHtml`
    - _Requirements: 6.8, 9.6, 7.14_

  - [x] 12.3 扩展报告渲染（`report.ts`）
    - 报告加入 4 个新分类区块与两个聚合维度、旧残留维度
    - 头部注明逻辑字节数口径；`partial` 时数值加 `≥` 前缀
    - 报告本身不提供任何清理入口，模块不导入 `cleaner.ts`
    - _Requirements: 6.1, 7.1, 8.1, 14.6_

  - [ ]* 12.4 扩展注入脚本启动守卫
    - **Property 18: 注入脚本可启动且无编译期重写泄漏**
    - **Validates: Requirements 6.8, 7.1, 7.14**
    - 扩展既有 `tests/webview.inline-script.spec.ts`：覆盖本次新增的注入函数，保持 CJS 路径执行 + `exports.` / `mod_1.` 文本扫描两档

  - [ ]* 12.5 编写属性测试：排序与分页的既有性质在扩展后仍成立
    - **Property 19: 排序与分页的既有性质在扩展后仍成立**
    - **Validates: Requirements 6.8**

  - [x] 12.6 编写示例测试 `tests/storage.ranking.newlayout.spec.ts`
    - 三个维度的空闲/计算中/就绪三态文案与控件禁用
    - MigrationStatus 三种取值的渲染；CSP 字符串比对
    - _Requirements: 7.8, 7.9, 9.6_

- [x] 13. Checkpoint - 统计、排行与报告
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. 清理扩展（`src/storage/cleaner.ts`，本特性唯一可写模块）
  - [x] 14.1 实现目录型会话的 CleanupPlan
    - AttachmentCleanup：待删集合 = 该会话目录下 `snapshots/` 与 `sub-executions/` 内已枚举的具体文件，`session.json` 与 `messages.jsonl` 排除在外
    - FullCleanup：待删集合 = 该会话目录下已枚举的全部文件，并把「移除已清空的目录」列为附加操作
    - 每个条目记录 `path` / `size` / `mtimeMs` 快照供确认后的 TOCTOU 复核
    - 计划生成之后新出现的文件排除在删除范围之外
    - 0.9x 会话沿用既有语义与既有边界校验，输出不变
    - _Requirements: 10.3, 10.4, 10.7, 10.11_

  - [x] 14.2 扩展路径边界校验与非递归 `rmdir` 收尾
    - `assertDeletable` 的放行位置扩为三类：目标会话目录之内且位于 NewSessionsRoot 之内的文件、当前工作区 0.9x 存档、当前工作区 0.9x 会话文件
    - 含 `..` 原始路径段、越界、指向 OldSessionManifest、符号链接一律拒绝并进 `failed[]`
    - FullCleanup 全部文件删除成功后，重新枚举确认为空，自底向上逐级非递归 `rmdir` 直至移除会话目录本身
    - `rmdir` 实参限定为规范化后位于 NewSessionsRoot 之内、等于目标会话目录或其子目录
    - 重新枚举发现仍含文件 → 保留该目录并计入 `failed[]`，已完成的文件删除结果保留
    - 模块**不导入** `rm` / 递归删除 / `rename` / `cp` / `copyFile` / `mkdir` / `appendFile` / `truncate` / `createWriteStream`
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 10.8, 10.9, 10.10_

  - [x] 14.3 实现旧残留清理
    - 待删集合限定为「已迁移仅残留」部分已枚举的具体文件，「未迁移」部分排除在外
    - CleanupPlan 给出待删文件路径/字节数/mtime 快照与合计，并把被排除的「未迁移」文件数与字节数单独列出
    - 只删除规范化后位于 OldSessionsRoot 或 `<OldStoreRoot>/<WorkspaceId>` 之内且已枚举的文件
    - 空计划直接返回未执行状态且不弹确认
    - 同一目标已有清理在执行时拒绝新请求
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6, 11.9_

  - [x] 14.4 扩展确认提示与审计
    - 目录型确认提示给出模式名称、会话标题与 sessionId、释放字节数、文件数、不可撤销且不进回收站说明；「取消」为默认按钮
    - FullCleanup 的提示需说明将删除整个会话目录（含消息记录与全部快照）
    - 旧残留清理的提示给出释放字节数/文件数与被排除的「未迁移」数量
    - 审计记录新增「会话格式」（1.x 目录型 / 0.9x 单文件）字段，删除前后各写一次
    - _Requirements: 10.12, 10.13, 10.14, 10.17, 10.18, 11.4, 11.7_

  - [x] 14.5 实现清理后的缓存失效与 UI 刷新
    - 使受影响的子树聚合缓存与三个聚合维度缓存失效
    - 重新计算排行页当前页、ProjectSessionTotal、SummaryBar 与受影响会话的角标
    - FullCleanup 且会话目录已移除时，该会话在刷新后的排行页、搜索结果与最近列表中被排除
    - _Requirements: 10.19, 10.20, 10.21, 11.8_

  - [ ]* 14.6 编写属性测试：目录型清理的封闭性
    - **Property 12: 目录型清理的封闭性**
    - **Validates: Requirements 10.7, 10.10, 15.11**
    - 文件 `tests/storage.cleaner.newlayout.property.spec.ts`；用 `recordingCleanerFs` 断言 `unlink` 与 `rmdir` 实参集合

  - [ ]* 14.7 编写属性测试：清理路径边界的拒绝集合
    - **Property 13: 清理路径边界的拒绝集合**
    - **Validates: Requirements 10.8, 10.9**

  - [ ]* 14.8 编写属性测试：三类计数守恒
    - **Property 14: 三类计数守恒**
    - **Validates: Requirements 10.16**

  - [ ]* 14.9 编写属性测试：TOCTOU 复核的三分支跳过语义
    - **Property 15: TOCTOU 复核的三分支跳过语义**
    - **Validates: Requirements 10.15**

  - [ ]* 14.10 编写属性测试：旧残留清理集合的封闭性
    - **Property 16: 旧残留清理集合的封闭性**
    - **Validates: Requirements 11.2, 11.5**
    - 文件 `tests/storage.legacy-residue.property.spec.ts`

  - [x] 14.11 编写示例测试 `tests/storage.cleaner.newlayout.spec.ts`
    - 目录型两模式的确认文案与待删集合；`rmdir` 收尾成功与目录非空时保留并计失败两条路径
    - 0.9x 清理路径回归不变（待删集合与清单读改写结果与实施前一致）
    - 同 sessionId 清理互斥；审计两次写入的时序与「会话格式」字段
    - _Requirements: 10.13, 10.14, 11.4, 15.13, 15.14_

- [x] 15. Webview 与宿主接线
  - [x] 15.1 结果项来源角标与 SummaryBar 文案（`src/webview.ts`、`src/webview/size.ts`）
    - 结果项按 `origin` 渲染来源角标；1.x 会话的 `Σ` tooltip 说明两种口径取同值的原因
    - `size.ts` 新增聚合维度标签纯函数；**遵守 design D9** 的注入约束
    - _Requirements: 4.4, 9.7_

  - [x] 15.2 宿主接线（`src/extension.ts`）
    - 把 LayoutRoots 贯通到 SearchSession、StorageAnalyzer、RankingPanel 与 SessionCleaner 的依赖装配
    - 接入两个聚合维度与旧残留维度的手动触发消息、旧残留清理入口
    - 统计相关异常的错误通知限定为用户主动触发的动作；汇总失败时 SummaryBar 展示「占用统计不可用」而搜索与角标不受影响
    - _Requirements: 12.6, 12.8, 12.9, 12.10_

  - [x] 15.3 编写示例测试 `tests/storage.badge.newlayout.spec.ts`
    - 来源角标的 HTML 结构；1.x 会话 `Σ` 切换不改变数值且 tooltip 含说明
    - 三个维度的触发消息时序
    - _Requirements: 4.4, 7.5, 7.9_

- [x] 16. 文档
  - [x] 16.1 更新 `README.md`
    - 新旧两种布局的目录结构差异；WsHash16 算法及其与旧 WorkspaceId 算法的区别；四种布局下的行为
    - 1.x credit 来自 `usage_summary`、旧查表已失效、1.x 两种 `Σ` 口径同值的原因
    - 1.x 跳转命令与旧命令移除情况，以及 `loadSessionWithPrompt` 不再作为候选的理由
    - SessionOrigin 三种取值及判定依据，并注明未迁移会话在 1.x 界面中不可见
    - 两个聚合维度的口径与触发方式，以及旧残留作为独立可选维度、默认不计入的原因
    - 4 个新分类各自对应的磁盘路径
    - 目录型会话两种清理模式各自删除的内容（含 FullCleanup 会移除已清空目录）、不可撤销不进回收站、旧残留清理默认排除「未迁移」的规则
    - 统计仅在显式触发时执行、ReadOnlyPaths 严格只读、SessionCleaner 为唯一可写模块及其 API 白名单、审计写入输出通道
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9_

- [x] 17. Final checkpoint - 全量验证
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 带 `*` 的子任务为可选测试任务，可为快速 MVP 跳过
- **执行决策（用户已确认）：跳过全部剩余的 `*` 可选属性测试** —— 即 11.7、11.8、11.9、11.10、
  12.4、12.5、14.6、14.7、14.8、14.9、14.10 共 11 项。理由是 fast-check 生成器 + 突变验证的
  成本占了整个特性的一大半，而核心功能不依赖它们；正确性由既有全量套件与每个任务自带的示例
  测试承担。这些条目**刻意留作未勾选**，以后想补随时能补。
  已在此决策之前完成的 `*` 任务（2.2–2.4、3.3、5.4、6.3、7.4、7.5、10.3）不受影响，仍为已完成。
- Property 1–20 与 design.md 的「Correctness Properties」一一对应，每条属性一个属性测试，`numRuns` 不低于 100（真实临时目录夹具可放宽到 50 并给显式超时）
- 属性测试与示例测试的文件归属严格遵循 design.md 的「Testing Strategy」表
- 所有涉及文件系统的测试在临时目录构造夹具并在 `afterEach` 清理；清理相关的属性测试默认走注入的假 fs，只有少量示例测试真的删文件
- **任务 7.1 与 10.2 是对已上线代码的纯重构**：必须先跑通既有测试建立基线，重构后既有测试断言不得修改且必须全绿，再在后续任务里接入新能力
- **任务 12.1、12.2、15.1 涉及 webview 注入**：注入的函数体只允许引用模块内未导出的绑定与同批注入的函数名，需要的常量由宿主实际值生成 `const` 声明一并注入（design D9）
- 清理是本特性唯一的破坏性能力，实现时必须守住六条：只删 CleanupPlan 已枚举并在确认中计入的具体文件、白名单式路径边界校验（先查 `..` 再规范化）、删除前逐文件 re-stat 复核、`rmdir` 前重新枚举确认为空、不提供撤销与回收站、审计在删除前后各写一次
- 旧残留清理默认排除「未迁移」数据：那些会话在 1.x 界面中不可见，删除即永久丢失

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.1"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4"] },
    { "id": 3, "tasks": ["5.1", "10.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "10.2"] },
    { "id": 5, "tasks": ["5.4", "5.5", "6.1", "10.3"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "11.1"] },
    { "id": 8, "tasks": ["7.4", "7.5", "7.6", "8.1", "11.2"] },
    { "id": 9, "tasks": ["8.2", "11.3", "11.4", "11.5"] },
    { "id": 10, "tasks": ["11.6", "11.7", "11.8", "12.1"] },
    { "id": 11, "tasks": ["11.9", "11.10", "11.11", "12.2"] },
    { "id": 12, "tasks": ["12.3", "12.4", "12.5", "12.6"] },
    { "id": 13, "tasks": ["14.1", "14.2"] },
    { "id": 14, "tasks": ["14.3", "14.4", "14.5"] },
    { "id": 15, "tasks": ["14.6", "14.7", "14.8", "14.9", "14.10"] },
    { "id": 16, "tasks": ["14.11", "15.1", "15.2"] },
    { "id": 17, "tasks": ["15.3", "16.1"] }
  ]
}
```
