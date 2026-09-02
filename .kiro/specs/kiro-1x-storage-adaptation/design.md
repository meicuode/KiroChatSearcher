# Design Document: kiro-1x-storage-adaptation

## Overview

本设计把扩展适配到 Kiro 1.x 的新存储布局，同时保留 0.9x 旧格式的完整支持。核心思路是
**在"路径与读取"这一层做双版本分叉，让上层的搜索、统计、排行、清理保持单一代码路径**：
新增一个 LayoutDetector 判定布局，新增一个 NewFormatReader 把 1.x 的目录型会话读成与
0.9x 单文件会话同构的记录，其余既有模块只需扩展而无需重写。

四条数据流：

1. **布局与路径**：LayoutDetector → 新旧两套根路径 → EnvChecker 放行判定
2. **浏览与搜索**：双源枚举 → NewFormatReader / 既有旧格式读取 → 合并去重 → SearchHit
3. **占用统计**：SizeScanner（注入分类器）→ 新旧分类合计 → SessionFootprint → 排行页 + 两个聚合维度 + 旧残留
4. **清理**（唯一写路径）：CleanupPlan → 模态确认 → 逐文件 unlink → 非递归 rmdir 收尾 → 审计

设计的两条硬约束贯穿全文：**ReadOnlyPaths 严格只读**（模块图上连写 API 的 import 都不存在），
**占用统计只在用户显式动作时执行**。

## 模块处置总表

| 模块 | 处置 | 本次改动要点 |
| --- | --- | --- |
| `src/paths.ts` | **扩展** | 新增 `getHomeKiroDir` / `computeWsHash16` / `getNewSessionsRoot` / `resolveNewWorkspaceSessionDir`；既有 `encodeWorkspaceKeys` / `resolveWorkspaceSessionDir` / `getSessionsRoot` **签名与输出一字不改**（回归护栏见 P2） |
| `src/layout.ts` | **新增** | LayoutDetector：判定 `new-only`/`old-only`/`both`/`none`，返回新旧各自可用的根 |
| `src/env.ts` | **扩展** | `checkEnvironment` 改为「两根任一可用即 ok」；返回值新增 `newWorkspaceDir` / `layout`，既有字段语义不变 |
| `src/session/newFormat.ts` | **新增** | NewFormatReader：读 `session.json` + 逐行解析 `messages.jsonl`，产出标题/匹配文本/hasImage/hasAttachment/用量 |
| `src/search.ts` | **内部重构** | 抽出「枚举 → 读取 → 索引缓存」为可注入的 SessionSource；新增双源合并去重；`SearchHit` 加 `origin` / `layout` |
| `src/credits.ts` | **扩展** | 新增 `getCreditsFromMessages`；既有 `hash32` / `listArchiveEntries` / `dropArchiveEntries` / 存档查表**原样保留**，适用范围收窄到 0.9x |
| `src/jump.ts` | **扩展** | 候选列表按布局切换；1.x 候选 = `viewSession` → `sessions.switch` |
| `src/storage/types.ts` | **扩展** | `StorageCategory` 新增 4 项；`RankingRow` 加 `origin`；新增聚合维度与旧残留类型 |
| `src/storage/classify.ts` | **扩展** | 新增 `NewClassifyRoots` / `buildNewClassifyRoots` / `classifyNewPath`；`isUnder` 与既有旧分类原样复用 |
| `src/storage/scanner.ts` | **内部重构** | `ScanOptions` 新增可选 `classify` 注入；不传时行为与现在完全一致 |
| `src/storage/orphan.ts` | **原样复用** | 孤儿存档是 0.9x 特有概念；1.x 布局下不参与判定 |
| `src/storage/analyzer.ts` | **扩展** | 新增新布局扫描、双布局合并、`getProjectSessionTotal` / `getAllKiroSessionTotal` / `getLegacyResidueTotal` |
| `src/storage/report.ts` | **扩展** | 报告加入新分类区块与聚合维度 |
| `src/storage/ranking.ts` | **扩展** | 表头之上加两个聚合维度 + 旧残留维度；每行加 MigrationStatus 列 |
| `src/storage/cleaner.ts` | **扩展** | 目录型清理两模式、非递归 `rmdir` 收尾、旧残留清理；既有 0.9x 语义与边界校验不变 |
| `src/webview.ts` | **扩展** | 结果项加来源角标；SummaryBar 文案适配 |
| `src/webview/size.ts` | **扩展** | 新增聚合维度标签的纯函数 |
| `src/extension.ts` | **扩展** | 接线新命令参数、聚合维度触发、清理入口 |

## Architecture

```
                    ┌──────────────────┐
                    │  LayoutDetector  │  ← PathResolver（新旧两套根）
                    └────────┬─────────┘
                             │ StorageLayout + roots
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐        ┌─────▼──────┐      ┌──────▼──────┐
   │EnvChecker│        │SearchEngine│      │StorageAnalyzer│
   └──────────┘        └─────┬──────┘      └──────┬──────┘
                             │                    │
                    ┌────────▼────────┐    ┌──────▼───────┐
                    │ NewFormatReader │    │ SizeScanner  │
                    │  （1.x 目录型） │    │（注入分类器）│
                    └─────────────────┘    └──────┬───────┘
                    ┌─────────────────┐           │
                    │ 既有旧格式读取  │    ┌──────▼───────┐
                    │  （0.9x 单文件）│    │ SessionCleaner│ ← 唯一可写
                    └─────────────────┘    └──────────────┘
```

## 关键设计决策

### D1 双版本分叉点放在"读取"层，而非上层

分叉只发生在两处：SessionSource（枚举 + 读取一条会话）与 SessionFootprint（算一条会话占用）。
搜索的关键词匹配、排序、截断、过滤，排行的排序分页渲染，清理的确认/复核/重试/审计，
全部只有一份实现。这样双版本兼容的成本被限制在两个可注入的小接口上，
而不是让 `if (layout === 'new')` 散布全代码库。

### D2 EnvChecker 从"串行短路"改为"两根任一可用"

现有实现按 UserDataDir → SessionsRoot → 工作区 → WorkspaceSessionDir 顺序短路，
`workspace-sessions` 缺失就直接报错。纯 1.x 环境下该目录可能根本不存在，用户会被挡在门外。

改为：先解析两套根，**任一可用即继续**；两者都不可用才报「未找到 Kiro 对话存储目录」，
且提示同时给出 `~/.kiro/sessions` 与旧路径两个预期位置。「未打开工作区」的优先级保持不变
（它与存储无关）。`EnvCheck` 新增 `newWorkspaceDir` 与 `layout`，既有 `workspaceDir`
仍指旧格式目录，使既有调用方不受影响。

### D3 会话枚举以目录为准，不用 session-index

`session-index/<WsHash16>.jsonl` 是追加式 op 日志，可能含已删除会话的历史 `add` 条目，
拿它当会话来源会列出不存在的会话。改为直接枚举 `NewWorkspaceSessionDir` 的子目录。
代价是失去索引的"新增顺序"信息，但排序本来就按 `lastModifiedAt`，不依赖它。

### D4 1.x 的 lineage 口径退化为同值

0.9x 的 credit 需要 lineage 追溯，是因为 checkpoint 会话的用量记在被继承的执行存档里。
1.x 的 `usage_summary` 事件直接落在会话自己的 `messages.jsonl` 中，不存在跨会话归属问题。
因此 1.x 会话的 `self` 与 `lineage` 取同一值，`additive: true`。

UI 保留 `Σ` 开关（旧会话仍需要它），但对 1.x 会话不改变数值，并在 tooltip 中说明原因，
否则用户会以为开关失效。

### D5 SizeScanner 注入分类器，而非新增第二个扫描器

现有 `ScanOptions.roots: ClassifyRoots` 内部调 `classifyPath(roots, p)`。新布局的分类规则
完全不同（按 `snapshots/` / `sub-executions/` / 会话目录判定），但**遍历、预算、让出、
深度上限、跳过计数、子树缓存这些逻辑一模一样**。因此给 `ScanOptions` 增加可选
`classify?: (fullPath: string) => StorageCategory`，提供时优先于 `roots`。不传时行为与现在
字节级一致，既有测试全部继续有效。

### D6 目录型会话的清理：文件级删除 + 非递归 rmdir 收尾

1.x 会话是目录，FullCleanup 删完文件会剩一堆空目录。**不引入递归删除**，而是：

1. 先枚举出全部具体文件路径（含字节数/mtime 快照）
2. 逐文件 `unlink`（沿用既有的 TOCTOU 复核 + 锁类重试）
3. 全部成功后，**自底向上**逐级 `rmdir`，每级删除前**重新枚举确认为空**
4. 任一级仍含文件 → 保留该目录并计入失败，已完成的文件删除结果保留

`rmdir` 的实参被限定为「规范化后位于 NewSessionsRoot 之内，且等于目标 NewSessionDir
或其子目录」。递归删除 API 仍然排除在模块导入之外 —— 这是本次唯一放宽的安全边界，
放宽幅度是"只收自己刚清空的目录"。

### D7 both 布局下同 sessionId 的归属：新格式优先，旧份计入残留

同一 sessionId 在新旧目录各有一份时（已迁移但旧份未清），若两份都计入该会话占用，
同一份数据会被算两次。设计取"新格式为该会话 SessionFootprint 的唯一来源，旧份计入
LegacyResidue"。副作用是排行页显示的单会话占用**小于**该会话在磁盘上的实际总和，
因此 tooltip 必须说明这一点。

### D8 旧残留清理默认排除"未迁移"

「未迁移」会话在 1.x 界面里不可见，删掉即永久丢失。CleanupPlan 只纳入「已迁移仅残留」
（新目录存在同 sessionId 目录，或旧目录内存在指向它的 MigrationMarker），
并把被排除的未迁移文件数与字节数单独列在确认提示里，引导用户先在 Kiro 内手动迁移。

### D9 注入 webview 的纯函数：禁止引用导出常量与跨模块导入（已踩过的坑）

`fn.toString()` 注入的是 **tsc CommonJS 输出**的函数体。tsc 会把
「被 `export` 的 const」引用重写成 `exports.X`、把「跨模块 import 的绑定」重写成 `mod_1.X`，
这两者在 webview 里都不存在，注入的函数一执行就抛 ReferenceError。

排行页真实踩过：`pageOf` 引用 `exports.RANKING_PAGE_SIZE`，脚本收尾的 `render()` 抛错，
紧随其后的 `postMessage({type:'ready'})` 永不发出，页面永远停在骨架里的静态「统计中…」。

**约束**：被注入的函数体只允许引用「模块内未导出的绑定」与「同批注入的其它函数名」；
需要的常量由 `getXxxHtml` 从宿主实际值生成 `const` 声明一并注入。
本次新增的任何注入函数都必须遵守，并由 P18 的守卫钉住。

## Data Models

```ts
// src/layout.ts
export type StorageLayout = 'new-only' | 'old-only' | 'both' | 'none';

export interface LayoutRoots {
  layout: StorageLayout;
  homeKiroDir: string | null;
  newSessionsRoot: string | null;
  newSessionIndexRoot: string | null;
  newWorkspaceSessionDir: string | null;   // <newSessionsRoot>/<WsHash16>
  userDataDir: string | null;
  oldStoreRoot: string | null;
  oldSessionsRoot: string | null;
  oldWorkspaceSessionDir: string | null;
}

// 会话来源
export type SessionOrigin = 'new' | 'migrated' | 'legacy-unmigrated';

// src/session/newFormat.ts
export interface NewSessionMeta {
  schemaVersion?: string;
  dataModelVersion?: number;
  id: string;
  title?: string;
  agentMode?: string;
  workspacePaths?: string[];
  createdAt?: string;
  lastModifiedAt?: string;
  modelId?: string;
  status?: string;
}

export interface NewSessionRecord {
  sessionId: string;        // = NewSessionDir 目录名（跳转与统计都按它走，非 session.json 的 id）
  dir: string;
  title: string;            // 空白 → 'Untitled'
  modified: number;         // lastModifiedAt，缺失/非法时回退 messages.jsonl 的 mtime
  text: string;             // 仅 user/assistant 的文本，供关键词匹配（已剔除 base64）
  firstUserText: string;    // 首条 user 文本，供「最近列表」预览（与 0.9x 的 matchField:'recent' 对齐）
  hasImage: boolean;
  hasAttachment: boolean;
  /**
   * usage_summary 中 unit==='credit' 的合计。三态刻意分开，避免把「还没算」
   * 当成「算过但没有」—— UI 是按「不可用」决定省略角标的：
   *   undefined = 尚未解析（NewFormatReader 不填此字段）
   *   null      = 已解析但不可用（Req 4.7）
   *   number    = 合计值（由 CreditReader 填充）
   */
  credits?: number | null;
}

// src/storage/types.ts 扩展
export type StorageCategory =
  | 'sessionJson' | 'executionSaves' | 'executionMetadata'
  | 'unclassified' | 'logs' | 'workspaceStorage' | 'otherFiles'
  | 'newSession' | 'newSnapshots' | 'newSubExecutions' | 'newSessionIndex';

export interface AggregateTotal {
  state: 'idle' | 'loading' | 'ok' | 'unavailable';
  bytes: number;
  files: number;
  sessionCount: number;
  workspaceCount: number;
  partial: boolean;
  skippedCount: number;
  roots: string[];
}

export interface LegacyResidueTotal extends AggregateTotal {
  migratedResidueBytes: number;    // 已迁移仅残留（可清理）
  migratedResidueFiles: number;
  unmigratedBytes: number;         // 未迁移（默认排除）
  unmigratedFiles: number;
}
```

`RankingRow` 新增 `origin: SessionOrigin`；1.x 会话的 `jsonBytes` 映射为
`session.json + messages.jsonl`，`archiveBytesSelf` 映射为 `snapshots/ + sub-executions/`，
保持「合计 = 两列之和」不变，故排行页的列结构与排序规则无需改动。

## Components and Interfaces

`classifyNewPath` 按有序规则先命中者胜：

| # | 条件 | 分类 |
| --- | --- | --- |
| 1 | 位于 `newSessionIndexRoot` 之下 | `newSessionIndex` |
| 2 | 位于某 `<sessionDir>/snapshots` 之下 | `newSnapshots` |
| 3 | 位于某 `<sessionDir>/sub-executions` 之下 | `newSubExecutions` |
| 4 | 位于 `newSessionsRoot` 之下（含 `session.json`/`messages.jsonl`/`publish*.cursor`） | `newSession` |
| 5 | 其余 | `otherFiles` |

划分性质（P6）由"规则有序 + 规则 4 兜住 sessions 根下全部剩余文件"构造性成立。

## Error Handling

| 情形 | 处理 |
| --- | --- |
| `~/.kiro` 或 `sessions` 不存在 | 新根置 null，保留旧根，不抛异常 |
| 旧根不存在 | 旧根置 null，保留新根，不抛异常 |
| 两根都不存在 | EnvChecker 报错并给出两个预期位置 |
| `messages.jsonl` 某行非法 JSON | 跳过该行，继续解析其余行 |
| 会话目录缺 `session.json` 或 `messages.jsonl` | 跳过该会话，继续其余，不抛异常 |
| `lastModifiedAt` 缺失/非法 | 回退 `messages.jsonl` 的 mtime |
| 枚举/stat 异常 | 累加 `skippedCount`、置 `partial`，继续统计 |
| 无 `usage_summary` 或无 credit 单位项 | credit 标记不可用，省略该条角标 |
| 旧残留目录不可读 | 该维度标记 unavailable，其余统计不受影响，不弹窗 |
| 清理中文件被占用 | 锁类错误重试 3 次 × 200ms，仍失败进 `failed[]`，不中止其余 |
| rmdir 时目录非空 | 保留目录，计入 `failed[]`，已删文件结果保留 |

## Correctness Properties

每条属性对应一个独立的属性测试，`numRuns` 不低于 100（真实临时目录夹具可放宽到 50 并给显式超时）。

### Property 1: WsHash16 归一化不变性
盘符大小写与斜杠方向的任意变体恒得同一 WsHash16；`d:\Projects\KiroExt\KiroChatSearcher` 恒为 `cc5023603866cd91`、`d:\SurErp\ERP-OMS-Workspaces` 恒为 `6082f0c94c5c4af8`。
**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 14.3**

### Property 2: 旧路径解析回归不变
`encodeWorkspaceKeys` / `resolveWorkspaceSessionDir` / WorkspaceId 对任意既有输入的输出与本特性实施前逐字节相同。
**Validates: Requirements 2.5, 2.6**

### Property 3: 布局判定完备且互斥
LayoutDetector 对任意新旧目录存在性组合恒返回四态之一且与定义式一致；同一磁盘状态下重复调用结果相同。
**Validates: Requirements 1.3, 1.13**

### Property 4: 消息解析的容错性
在 messages.jsonl 任意位置插入任意非法 JSON 行，其余合法行的解析结果恒不变。
**Validates: Requirements 3.8**

### Property 5: 新格式占用可加性
某工作区目录的统计字节数恒等于其下各会话 SessionFootprint 之和。
**Validates: Requirements 6.3, 7.2**

### Property 6: 新布局分类构成一个划分
各 StorageCategory 字节数之和恒等于所统计根范围总字节数，且各分类覆盖的路径集合两两不相交。
**Validates: Requirements 6.1, 6.5**

### Property 7: 统计幂等且缓存透明
冷缓存与热缓存对同一未变化夹具的统计结果恒相等。
**Validates: Requirements 6.14, 6.15, 12.7**

### Property 8: 用量求和口径
credit 合计恒只累加 `unit === 'credit'` 的项；1.x 会话的 self 口径恒等于 lineage 口径。
**Validates: Requirements 4.1, 4.2, 4.3**

### Property 9: 双源合并去重
`both` 布局下同一 sessionId 恒只出现一次，且其 SessionOrigin 恒为 `migrated`。
**Validates: Requirements 9.8, 13.3**

### Property 10: 来源判定确定且完备
SessionOrigin 恒取三值之一、覆盖全部被枚举会话，且同一磁盘状态下可重复。
**Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.9**

### Property 11: 统计路径只读
一次完整统计（汇总 + 排行取数 + 两个聚合维度 + 旧残留）前后夹具目录树快照逐字节相等，且调用名集合恒 ⊆ `{ readdir, lstat, stat, readFile, readFileSync }`。
**Validates: Requirements 12.1, 12.2**

### Property 12: 目录型清理的封闭性
`unlink` 实参集合恒 ⊆ CleanupPlan 已枚举的文件路径集合；`rmdir` 实参恒位于目标 NewSessionDir 之内，且恒不含确认后新出现的文件。
**Validates: Requirements 10.7, 10.10, 15.11**

### Property 13: 清理路径边界的拒绝集合
原始形式含 `..` 段、规范化后越界、指向 OldSessionManifest、或为符号链接的路径恒被拒绝并进入 `failed[]`，且恒不被 `unlink`。
**Validates: Requirements 10.8, 10.9**

### Property 14: 三类计数守恒
`deletedFiles + failed.length + skipped.length` 恒等于 CleanupPlan 的文件数；锁类失败重试至多 3 次且等待参数恒为 200ms。
**Validates: Requirements 10.16**

### Property 15: TOCTOU 复核的三分支跳过语义
确认后文件消失 / 字节数变化 / mtime 变化三种情形恒进入 `skipped[]` 而非 `failed[]`，且恒不被 `unlink`；完全一致者恒被删除。
**Validates: Requirements 10.15**

### Property 16: 旧残留清理集合的封闭性
旧残留清理的待删集合恒 ⊆ 「已迁移仅残留」文件集合，恒不含任何「未迁移」文件。
**Validates: Requirements 11.2, 11.5**

### Property 17: 非显式动作恒不触发全量枚举
对任意「视图可见 / 输入关键词 / 切换过滤 / 点击刷新」动作序列，注入的枚举依赖恒未被调用于其它工作区目录与旧残留目录；两个聚合维度未被触发时恒不枚举其对应范围。
**Validates: Requirements 12.4, 12.5, 12.6, 15.18**

### Property 18: 注入脚本可启动且无编译期重写泄漏
两个 webview 的整段内联脚本在 DOM 替身中恒能执行完毕并发出 `{ type: 'ready' }`，且脚本文本恒不含 `exports.` 与 `mod_1.` 形态的自由变量。
**Validates: Requirements 6.8, 7.1, 7.14**（该守卫是排行页与聚合维度能够渲染的前提；设计约束 D9）

### Property 19: 排序与分页的既有性质在扩展后仍成立
比较函数恒为全序且 tiebreak 不随方向反转；第 M 页恒为全量排序序列的对应切片。
**Validates: Requirements 6.8**

### Property 20: 归属判断按路径段边界
同前缀兄弟目录恒不被误判为子项（如 `logs-old` 不属于 `logs`）。
**Validates: Requirements 14.2**
## Testing Strategy

| 文件 | 覆盖 |
| --- | --- |
| `tests/paths.newlayout.spec.ts` | WsHash16 实测基线、旧解析回归不变（P1、P2 的示例部分） |
| `tests/paths.newlayout.property.spec.ts` | P1、P2、P20 |
| `tests/layout.spec.ts` | P3；四种夹具下 EnvChecker 均正确放行 |
| `tests/session.newformat.spec.ts` | 标题/预览/hasImage/hasAttachment 提取、坏行跳过、缺文件跳过 |
| `tests/session.newformat.property.spec.ts` | P4 |
| `tests/search.dual.spec.ts` | 双源合并、去重、排序截断、过滤语义一致 |
| `tests/search.dual.property.spec.ts` | P9、P10 |
| `tests/credits.newformat.spec.ts` | P8 的示例部分；0.9x 查表回归不变 |
| `tests/jump.newlayout.spec.ts` | 候选优先级、回退、1.x 候选不含 `loadSessionWithPrompt` |
| `tests/storage.newlayout.property.spec.ts` | P5、P6、P7、P11 |
| `tests/storage.aggregate.spec.ts` | 两个聚合维度的口径、手动触发、缓存失效 |
| `tests/storage.aggregate.property.spec.ts` | P17 |
| `tests/storage.cleaner.newlayout.spec.ts` | 目录型两模式的确认文案、rmdir 收尾、非空保留 |
| `tests/storage.cleaner.newlayout.property.spec.ts` | P12、P13、P14、P15 |
| `tests/storage.legacy-residue.spec.ts` | 已迁移/未迁移划分、P16 |
| `tests/webview.inline-script.spec.ts`（已存在，扩展） | P18 |

所有涉及文件系统的测试在临时目录构造夹具并在 `afterEach` 清理；清理相关的属性测试走注入的
假 fs，只有少量示例测试真的在临时目录删文件。

## ReadOnlyPaths 与写边界

**ReadOnlyPaths**（只允许 `readdir` / `lstat` / `stat` / `readFile` / `readFileSync`，
模块图上不得出现任何写 API 的 import）：
`layout.ts`、`paths.ts`、`env.ts`、`session/newFormat.ts`、`search.ts`、`credits.ts`、
`storage/{classify,scanner,orphan,analyzer,report,ranking}.ts`。

**唯一可写模块** `storage/cleaner.ts`，API 白名单：

| API | 用途 | 约束 |
| --- | --- | --- |
| `unlink` | 删除单个文件 | 实参恒 ⊆ CleanupPlan 已枚举的文件路径 |
| `rmdir`（非递归） | 收掉已清空的会话目录 | 实参恒位于 NewSessionsRoot 之内、等于目标 NewSessionDir 或其子目录，且删除前重新枚举确认为空 |
| `readFile` | 读 OldSessionManifest | 仅 0.9x FullCleanup |
| `writeFile` | 覆盖写回 OldSessionManifest | 实参恒只有 manifest 一个路径 |
| `lstat` | 计划快照与 TOCTOU 复核 | — |

明确排除在模块导入之外：`rm`（及其递归模式）、`rmdir` 的递归形式、`rename`、`cp`、
`copyFile`、`mkdir`、`appendFile`、`truncate`、`createWriteStream`。

## 不做的事

- 不触发或代替 Kiro 官方的 0.9x → 1.x 迁移，不把未迁移会话转换成新格式
- 不修改 Kiro 的存储位置，不做后台定时扫描与文件监视
- 不提供删除的撤销与回收站
- 不统计 `~/.kiro` 下除 `sessions` 与 `session-index` 之外的子目录
- 不读取被统计文件的内容用于计量（只 stat 取字节数）；`messages.jsonl` 的读取仅用于
  搜索匹配与用量提取，且受 `(mtimeMs, size)` 缓存约束



