/**
 * 存储占用统计的共享数据模型。
 *
 * 本模块是纯类型 + 常量文案，**不引入任何运行时依赖**（不 import fs / vscode），
 * 因此可被 ReadOnlyPaths（analyzer / scanner / classify / orphan / report / ranking）
 * 与唯一可写模块 cleaner 同时安全引用，而不会在模块图上引入循环。
 *
 * `StorageCategory` 与 `OrphanStat` 的**单一定义来源**在此处：
 * `classify.ts` 与 `orphan.ts` 从这里 import（如需要可再 re-export），
 * 避免两处各自声明后出现口径漂移。
 */

/**
 * 文件分类。每个被统计的文件恰好落入一个分类，
 * 因此「各分类字节数之和 = 总字节数」与「路径集合两两不相交」构造性成立。
 *
 * 前 7 项为 0.9x 旧布局（`<userDataDir>` 之下）的分类；
 * 后 4 项为 1.x 新布局（`~/.kiro/sessions` 与 `~/.kiro/session-index` 之下）的分类。
 * 两组分类的路径范围天然不相交，因为它们位于不同的根目录。
 */
export type StorageCategory =
  | 'sessionJson'
  | 'executionSaves'
  | 'executionMetadata'
  | 'unclassified'
  | 'logs'
  | 'workspaceStorage'
  | 'otherFiles'
  /** 1.x：`<newSessionsRoot>/<wsHash16>/<sessionId>/` 下的会话本体，含 `session.json`、`messages.jsonl` 与 `publish*.cursor` 等剩余文件 */
  | 'newSession'
  /** 1.x：`<sessionDir>/snapshots/` 下的文件快照，是 0.9x `executionSaves` 的对应物 */
  | 'newSnapshots'
  /** 1.x：`<sessionDir>/sub-executions/` 下的子执行数据 */
  | 'newSubExecutions'
  /** 1.x：`<newSessionIndexRoot>` 下的全局会话索引，不归属任何单个工作区 */
  | 'newSessionIndex';

/** 分类明细 */
export interface CategoryStat {
  category: StorageCategory;
  /** 中文标签，如 '执行存档' */
  label: string;
  /** 对应磁盘路径模板，供 tooltip / 报告展示 */
  pathHint: string;
  /** 补充说明，如 '实测包含源码文件快照' */
  note?: string;
  bytes: number;
  files: number;
}

/** 孤儿存档判定状态：ok 已判定 / pending 枚举未完成 / unknown 无可用现存会话集合 */
export type OrphanState = 'ok' | 'pending' | 'unknown';

/** 孤儿执行存档合计 */
export interface OrphanStat {
  state: OrphanState;
  bytes: number;
  files: number;
  /** 机制说明 + 限制理由（只否定批量清理入口） */
  note: string;
}

/**
 * 体积口径说明文案：统计取 stat 报告的逻辑字节数（`size`），
 * 不含文件系统簇对齐造成的实际占用差异，故可能与资源管理器的「占用空间」不同。
 */
export const SIZE_NOTE = '体积为 stat 报告的逻辑字节数，不含文件系统簇对齐造成的实际占用差异';

/** 一次汇总统计的结果 */
export interface StorageSummary {
  status: 'ok' | 'unavailable';
  userDataDir: string | null;
  totalBytes: number;
  totalFiles: number;
  categories: CategoryStat[];
  /** 当前工作区归属 = WorkspaceSessionDir + <StoreRoot>/<WorkspaceId> */
  currentWorkspaceBytes: number;
  /**
   * 当前工作区全部会话的 SelfFootprint 合计（ProjectFootprintTotal）。
   * 自身口径可相加，故该合计有意义；供 SummaryBar 的数值与 tooltip 使用。
   */
  projectFootprintTotal: number;
  orphan: OrphanStat;
  /** 存在跳过条目（不可读 / 超深）时为 true，表示各数值为下限 */
  partial: boolean;
  skippedCount: number;
  /** 参与统计的会话数，供 SummaryBar 的数值与 tooltip 展示 */
  sessionCount: number;
  /** 体积口径说明文案，固定注明为 stat 逻辑字节数（见 SIZE_NOTE） */
  sizeNote: string;
  scannedAt: number;
}

/**
 * 会话来源（迁移状态）。判定只依赖磁盘状态，故同一磁盘状态下对同一会话可重复。
 *
 * - `new`：位于 1.x NewSessionDir 且 sessionId 以 `sess_` 开头，即 1.x 中新建的会话。
 * - `migrated`：位于 1.x NewSessionDir 但 sessionId 不以 `sess_` 开头，或旧目录里存在
 *   `v2SessionId` 指向它的 MigrationMarker，即由 0.9x 迁移而来。`both` 布局下同一
 *   sessionId 新旧各有一份时恒判为此值，且只展示一次（以新格式目录为展示与计量来源）。
 * - `legacy-unmigrated`：仅存在于旧的 OldWorkspaceSessionDir、新目录下无同 sessionId 的
 *   会话目录。**这类会话在 1.x 界面中不可见**，故删除即永久丢失。
 */
export type SessionOrigin = 'new' | 'migrated' | 'legacy-unmigrated';

/** 排行页的排序方向；主键 totalBytes 随之反转，tiebreak 恒定不反转 */
export type RankingSortOrder = 'desc' | 'asc';

/**
 * 排行页的一行；恒为 self 口径，故不带 scope / additive 字段。
 *
 * 刻意不含 `archiveBytesLineage`：排行页恒 `self`，下发 lineage 数值
 * 只会诱导出「两列可以相加」的误用。
 */
export interface RankingRow {
  /** 会话标题（清单优先，回退单文件标题）；渲染前截断与转义 */
  title: string;
  sessionId: string;
  jsonBytes: number;
  /** 归因到该会话的存档字节数（self 口径） */
  archiveBytesSelf: number;
  /** jsonBytes + archiveBytesSelf，排序主键 */
  totalBytes: number;
  /** SessionFile 的 mtime，展示为 YYYY-MM-DD HH:mm，同时是 tiebreak 主键 */
  mtimeMs: number;
  /**
   * 会话来源，渲染为行上的 MigrationStatus 指示。
   * 只影响展示，不参与排序，故列结构与排序规则不变。
   */
  origin: SessionOrigin;
}

/** 单会话占用 */
export interface SessionFootprint {
  sessionId: string;
  scope: 'self' | 'lineage';
  /** self 可跨会话求和；lineage 不可 */
  additive: boolean;
  jsonBytes: number;
  archiveBytes: number;
  totalBytes: number;
  /** 是否找到任何归因到该会话的存档 */
  archivesFound: boolean;
}

/**
 * 一个「聚合维度」的统计结果，供排行表之上的 ProjectSessionTotal 与
 * AllKiroSessionTotal 复用同一形状。
 *
 * 口径：只计量**会话数据**（新布局 `<newSessionsRoot>` 或旧布局 `<oldSessionsRoot>`
 * 下的会话），不含 LegacyResidue —— 旧残留是独立维度（见 {@link LegacyResidueTotal}），
 * 默认不计入这里，以免主流程承担数 GB 级的扫描成本。
 *
 * `state` 是维度自身的生命周期而非错误码，因为 AllKiroSessionTotal 与
 * LegacyResidueTotal 都只在用户显式触发后才扫描：
 * - `idle`：尚未触发，此时各数值无意义（恒为 0），UI 展示未统计提示；
 * - `loading`：正在扫描，UI 展示「统计中…」并忽略重复触发；
 * - `ok`：已得到结果；
 * - `unavailable`：对应根目录不存在或不可读，其余维度不受影响且不弹窗。
 */
export interface AggregateTotal {
  state: 'idle' | 'loading' | 'ok' | 'unavailable';
  /** 字节数合计，取 stat 的逻辑字节数（见 SIZE_NOTE）；`partial` 为 true 时为下限 */
  bytes: number;
  /** 文件数合计；`partial` 为 true 时为下限 */
  files: number;
  /** 参与统计的会话数，供数值旁与 tooltip 展示 */
  sessionCount: number;
  /** 参与统计的工作区目录数；单工作区维度（ProjectSessionTotal）恒为 1 */
  workspaceCount: number;
  /** 存在跳过条目（不可读 / 超深）时为 true，表示各数值为下限，UI 加 `≥` 前缀 */
  partial: boolean;
  /** 被跳过的条目数，在 tooltip 中给出 */
  skippedCount: number;
  /** 被统计的根路径（绝对路径），供 tooltip 说明数值来自何处；渲染前需 HTML 转义 */
  roots: string[];
}

/**
 * 旧残留（LegacyResidue）统计结果：1.x 手动迁移未搬走、仍留在 0.9x 目录
 * （`<oldSessionsRoot>` 与 `<oldStoreRoot>/<workspaceId>`）里的数据。
 *
 * 与 AllKiroSessionTotal 相互独立，默认不计入后者；仅在用户显式触发时扫描。
 * 继承字段中的 `bytes` / `files` 为旧残留总量，
 * 恒等于「已迁移仅残留」与「未迁移」两部分之和。
 *
 * 划分依据：旧会话在 `<newSessionsRoot>` 下存在同 sessionId 的会话目录，
 * 或旧目录内存在指向该 sessionId 的 MigrationMarker（`._migration-<uuid>.json`）
 * → 「已迁移仅残留」；两个条件都不成立 → 「未迁移」。
 *
 * **未迁移部分默认排除在清理集合之外，因为那些会话在 1.x 界面中不可见，
 * 删除即永久丢失。** 故清理入口只消费 `migratedResidue*`，
 * 并把 `unmigrated*` 作为「被排除项」单独展示在计划与确认提示里。
 */
export interface LegacyResidueTotal extends AggregateTotal {
  /** 已迁移仅残留的字节数：新布局已有同一会话，故这部分可安全清理 */
  migratedResidueBytes: number;
  /** 已迁移仅残留的文件数 */
  migratedResidueFiles: number;
  /** 未迁移的字节数：新布局无对应会话，默认排除在清理集合之外 */
  unmigratedBytes: number;
  /** 未迁移的文件数 */
  unmigratedFiles: number;
}
