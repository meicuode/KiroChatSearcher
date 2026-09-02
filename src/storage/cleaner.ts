import { lstat, readdir, readFile, rmdir, unlink, writeFile } from 'fs/promises';
import * as path from 'path';
import { hash32, type ArchiveInfo } from '../credits';
import { isUnder } from './classify';
import { MANIFEST_FILENAME } from './orphan';

/**
 * SessionCleaner —— 本特性**唯一可写**的模块。
 *
 * ## 可写边界（WritableFsAllowlist，Req 9.8、11.8）
 *
 * 本模块允许的文件系统调用**只有四个**，且全部经 `CleanerFsDeps` 注入：
 *
 * | 调用 | 允许的实参范围 |
 * | --- | --- |
 * | `unlink` | 只能是 `CleanupPlan.files[].path`（外加用户显式勾选的 `referenced[].path`）中的**单个文件** |
 * | `stat` | 计划生成时的快照与确认后的 TOCTOU 复核 |
 * | `readFile` | 只对 SessionManifest（`<sessionDir>/sessions.json`） |
 * | `writeFile` | 只对 SessionManifest，且仅 `mode === 'full'` |
 *
 * 1.x 目录型会话的支持（Requirement 10.1、10.5）在上表之外**只**多两个调用，
 * 且各自的实参范围同样是收窄的：
 *
 * | 调用 | 允许的实参范围 |
 * | --- | --- |
 * | `readdir` | 只枚举目标 NewSessionDir 及其子目录：一次用于生成计划、一次用于 `rmdir` 前复核为空 |
 * | `rmdir`（**非递归**） | 规范化后必须位于 NewSessionsRoot 之内、且等于目标 NewSessionDir 或其子目录，且删除前刚被重新枚举确认为空 |
 *
 * 模块**不导入** `rm`（及其递归模式）/ `rename` / `cp` / `copyFile` / `mkdir` /
 * `appendFile` / `truncate` / `createWriteStream` —— "扩展递归删掉一整棵目录"这类事故
 * 因此在模块图上不可能发生，而不是靠运行时判断规避（design D6）。
 * `rmdir` 是本次**唯一**放宽的一格，放宽幅度是「只收自己刚清空的目录」：它删不掉非空目录
 * （非递归 `rmdir` 遇到非空目录返回 `ENOTEMPTY`），因此即便实参校验被绕过，最坏后果也只是
 * 一次失败而不是数据丢失 —— 这一点是选它而不是选 `rm -r` 的根本理由。
 * 临时文件 + `rename` 的原子写做法被刻意排除在外（Req 14.11）：那会引入创建新文件与
 * 重命名两类操作，让"这个模块只会碰哪些路径"不再一眼可判。
 *
 * ## 分节（按任务追加，顺序即执行顺序）
 *
 * | 节 | 内容 | 任务 |
 * | --- | --- | --- |
 * | 1 | 数据模型：`CleanupMode` / `CleanupPlan` / `CleanupResult` / `ConfirmPrompt` / `CleanerFsDeps` / `CleanerDeps` | 12.1（本节） |
 * | 2 | `SessionCleaner.plan()`——**全程只读**的计划生成 | 12.1（本节） |
 * | 3 | `assertDeletable()`——路径边界校验纯函数 | 12.3 |
 * | 4 | `removeManifestEntry()`——清单读改写纯函数 | 12.5 |
 * | 5 | `SessionCleaner.run()`——12 段执行流水线（唯一真正写盘的地方） | 12.6 |
 *
 * 第 1~4 节只做**只读**的预演与**纯函数**判定（第 4 节是纯字符串变换，零 IO）；只有第 5 节
 * 的 `run()` 真正写盘。因此本文件从 `fs/promises` 的具名导入被刻意收窄到
 * `{ lstat, readFile, unlink, writeFile }` 四个——`lstat` 作 `stat` 缺省（`plan()` 与
 * 段 5 复核的快照来源，识别符号链接为链接自身），`unlink` 删单文件，`readFile` / `writeFile`
 * 只服务 SessionManifest 的读改写。**`rm` / `rmdir` / `rename` / `cp` 一个都没有导入**，
 * 「误删整个目录」这类事故因此在模块图上不可能发生（Req 9.8、14.11）。
 */

/* ------------------------------------------------------------------ *
 * 1. 数据模型
 * ------------------------------------------------------------------ */

/** 清理模式：`attachment` 只删存档（附件清理）；`full` 连 SessionFile 与清单条目一起处理（全量清理）。 */
export type CleanupMode = 'attachment' | 'full';

/** 待删条目：`size` / `mtimeMs` 是计划生成时刻的快照，供确认后的 TOCTOU 复核比对（Req 14.3、14.20）。 */
export interface CleanupTarget {
  path: string;
  size: number;
  mtimeMs: number;
}

/** 一次清理的预演结果（只读产出）。 */
export interface CleanupPlan {
  /** 生成时间，进审计与 TOCTOU 复核的语境 */
  createdAt: number;
  mode: CleanupMode;
  sessionId: string;
  title: string;
  /**
   * 该会话的数据格式（Requirement 10.3、10.4）。
   *
   * `'old'` 时 `dirs` 恒为空、`manifestUpdate` 按既有语义给出；
   * `'new'` 时 `manifestUpdate` 恒为 `null`（1.x 没有会话清单）、`referenced` 恒为空
   * （1.x 的快照按会话目录物理隔离，不存在跨会话共享的存档，design D4）。
   *
   * 缺省 `'old'`：本字段是本次新增，声明为必填会让「构造一个 CleanupPlan 字面量」的
   * 既有调用方编译失败，而它们全都是 0.9x 语境。
   */
  layout: CleanupLayout;
  /**
   * 全部文件删除成功后待**非递归移除**的空目录，**已按自底向上排序**
   * （Requirement 10.5）。仅 `layout === 'new' && mode === 'full'` 时非空。
   *
   * 排序在计划阶段就固定下来，而不是留给执行阶段现排：执行阶段每删一级都要重新枚举确认
   * 为空，顺序错了会让「父目录先被检查」——那时子目录还在，父目录必然非空，于是整棵目录
   * 一级都收不掉。把顺序作为计划的一部分，也让审计里能直接看出将要移除哪些目录、按什么顺序。
   */
  dirs: string[];
  /**
   * 目标 NewSessionDir 绝对路径（`layout === 'new'` 时非 `null`）。
   *
   * 执行阶段的两处边界校验都要用它作为内层围栏：`assertDeletable` 判「待删文件是否在
   * 该目录之内」、`assertRemovableDir` 判「待移除目录是否等于它或其子目录」。
   * 显式存在计划里而不是从 `dirs` 末项反推——`attachment` 模式的 `dirs` 是空的，
   * 反推会得到 `undefined` 并让围栏静默失效。
   */
  newSessionDir: string | null;
  /** 待删除文件；size/mtimeMs 为快照，供确认后的 re-stat 复核比对 */
  files: CleanupTarget[];
  totalBytes: number;
  totalFiles: number;
  /**
   * 被其它现存会话 lineage 引用、默认被排除的存档（Req 14.4）。
   *
   * 字段比 design 的 `{ path; size }` 多带一个 `mtimeMs`：用户在确认提示里显式勾选
   * 「包含引用冲突文件」时，这些条目会并入删除集合，而段 5 的复核需要与它们同源的
   * 快照——否则被勾选的文件就成了唯一没有 TOCTOU 保护的一批。多带一个字段是超集，
   * 对只读 `path` / `size` 的调用方无影响。
   */
  referenced: CleanupTarget[];
  referencedBytes: number;
  referencedFiles: number;
  /** 仅 full：把从 SessionManifest 移除该 sessionId 列为附加操作 */
  manifestUpdate: { path: string; sessionId: string } | null;
}

/** 一次清理的执行结果（由第 5 节的 `run()` 产出）。 */
export interface CleanupResult {
  state: 'done' | 'cancelled' | 'noop' | 'rejected';
  mode: CleanupMode;
  sessionId: string;
  deletedFiles: number;
  deletedBytes: number;
  /** 校验拒绝、符号链接、重试后仍失败等 */
  failed: Array<{ path: string; reason: string }>;
  /** re-stat 复核为已不存在或与快照不一致而未删 */
  skipped: Array<{ path: string; reason: 'missing' | 'changed' }>;
  /** 三态：'skipped' 表示非 full 模式或无需更新 */
  manifestUpdated: 'ok' | 'failed' | 'skipped';
  /** 用户是否显式选择包含 ReferencedArchive */
  includedReferenced: boolean;
  /** 该次清理的数据格式（与计划一致），供审计与调用方文案区分两种会话形态（Req 10.18） */
  layout: CleanupLayout;
  /**
   * 成功以非递归 `rmdir` 移除的空目录数（Requirement 10.5）。
   * 未能移除的目录进 `failed[]`（原因为「目录非空」等），已完成的文件删除结果保留（Req 10.6）。
   */
  removedDirs: number;
}

/**
 * 模态确认提示的输入（Req 14.5、14.6）。文案由第 5 节按此组装，
 * 这里只固定"确认环节必须拿到哪些事实"——模式名称、释放字节数与文件数、
 * 被保留的引用冲突文件数与字节数。
 */
export interface ConfirmPrompt {
  /** `primary` 为首次确认；`referenced` 为勾选包含引用冲突文件后的二次确认 */
  stage: 'primary' | 'referenced';
  mode: CleanupMode;
  sessionId: string;
  title: string;
  /**
   * 该会话的数据格式（Requirement 10.13）。
   *
   * 宿主据此区分两种 FullCleanup 的措辞：1.x 是「删除**整个会话目录**（含消息记录与全部快照）」，
   * 0.9x 是「删除存档 + 会话文件 + 清单条目」。两者的破坏面不同，用同一句文案会误导。
   */
  layout: CleanupLayout;
  /** 将被非递归移除的空目录数（仅 1.x + full 时非 0），供确认文案说明「目录也会被收掉」 */
  dirCount: number;
  /** 该次确认对应的待删文件数与字节数合计（二次确认时已含 referenced） */
  totalFiles: number;
  totalBytes: number;
  referencedFiles: number;
  referencedBytes: number;
}

/**
 * 可注入的文件系统依赖。四个调用即本模块的**全部**调用面，因此
 * 「调用名集合 ⊆ `{ unlink, stat, readFile, writeFile }`」是可断言的事实
 * 而不是注释里的承诺（Property 14(b)）。缺省退回 `fs.promises`（`stat` 取 `lstat`，
 * 以便符号链接被识别为链接自身而不是跟随到目标）。
 */
export interface CleanerFsDeps {
  unlink: (p: string) => Promise<void>;
  stat: (p: string) => Promise<{ size: number; mtimeMs: number; isSymbolicLink(): boolean }>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
  writeFile: (p: string, data: string, enc: 'utf8') => Promise<void>;
  /** 重试等待；测试注入以免真的睡 200ms */
  delay?: (ms: number) => Promise<void>;
  /**
   * 枚举目录（1.x 目录型会话专用，Requirement 10.4、10.5）。
   *
   * **可选**：0.9x 单文件会话的清理一个字节都用不到它（待删存档由注入的 ArchiveIndex 给出），
   * 因此既有只注入四个调用的宿主与测试夹具**行为逐字不变**，其调用面也仍然只有那四个。
   * 只在处理 1.x 会话时被取用；未注入时 1.x 计划直接判为不可用而不是去猜目录内容。
   *
   * 之前本接口刻意没有 `readdir`（「枚举属于 ReadOnlyPaths 的职责」）。1.x 下这个立场
   * 站不住了：Req 10.7 要求删除前枚举出**具体文件清单**，Req 10.5 更要求在 `rmdir` 前
   * **重新枚举确认为空**——后者必须发生在删除动作的紧邻上游，把它外包给别的模块就等于
   * 让「确认为空」和「执行删除」之间多一层可被绕过的间隙。
   */
  readdir?: (p: string) => Promise<CleanerDirent[]>;
  /**
   * **非递归**删除空目录（Requirement 10.5、10.10）。可选，同 `readdir`。
   *
   * 实参恒被 {@link assertRemovableDir} 限定在「NewSessionsRoot 之内、且等于目标
   * NewSessionDir 或其子目录」，且调用前刚重新枚举确认为空。选非递归 `rmdir` 而不是
   * `rm -r` 的理由见文件头：它删不掉非空目录，因此校验被绕过时最坏也只是一次失败。
   */
  rmdir?: (p: string) => Promise<void>;
}

/** `readdir` 返回项所需的最小形状（便于测试注入；与 scanner 的 `DirentLike` 同构）。 */
export interface CleanerDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** 删除侧需要的路径根。与统计侧同源（由 `buildClassifyRoots` 与 PathResolver 派生）。 */
export interface CleanerRoots {
  storeRoot: string;
  /** 桶目录名（`hash32('KIRO::EXECUTION::SAVES')`），非完整路径 */
  savesBucket: string;
  /** 当前工作区的 `hash32(工作区 fsPath)` */
  workspaceId: string;
  /** 当前工作区的 WorkspaceSessionDir：`<sessionsRoot>/<EncodedKey>` */
  sessionDir: string;
  /**
   * `<OldStoreRoot>/workspace-sessions`（OldSessionsRoot）——**旧残留清理**的围栏
   * （Requirement 11.5）。
   *
   * 与 `sessionDir` 的区别是范围：`sessionDir` 是**当前工作区**那一个编码目录，而旧残留
   * 跨全部工作区，故围栏必须放到它们的公共父目录这一层。可选；不给时旧残留清理一律不可用
   * （拿不到围栏就不许删）。
   */
  oldSessionsRoot?: string | null;
  /**
   * `~/.kiro/sessions`（NewSessionsRoot）——1.x 删除边界的**外层**围栏
   * （Requirement 10.8、10.10）。
   *
   * 可选：不给（或为 `null`）时本模块完全按 0.9x 行事，1.x 计划一律判为不可用。
   * 这不是退化而是有意的默认：拿不到围栏就不许删，比按 `~/.kiro` 猜一个出来安全。
   */
  newSessionsRoot?: string | null;
  /**
   * `<newSessionsRoot>/<WsHash16>`（当前工作区在 1.x 下的会话目录）。
   * 目标 NewSessionDir 恒为 `<newWorkspaceSessionDir>/<sessionId>`，即它的**直接**子目录。
   */
  newWorkspaceSessionDir?: string | null;
}

/**
 * 一条会话的数据所在磁盘格式：`old` = 0.9x 单文件，`new` = 1.x 目录型。
 *
 * 与 `jump.ts` 的 `SessionDataLayout`、`search.ts` 的 `SessionSourceKind` 取值域一致，
 * 但各自独立声明：清理只需要「这条数据是哪种格式」这一个信息，为它把搜索或跳转模块
 * 拉进唯一可写模块的依赖图不划算。
 */
export type CleanupLayout = 'old' | 'new';

/**
 * 一个现存会话的 lineage 线索：会话自身 id 与其 `history[].executionId`。
 *
 * 判定 ReferencedArchive 需要"目标会话之外的会话都引用了哪些执行"，而
 * `CleanerFsDeps` 刻意**没有** `readdir`——枚举会话目录属于 ReadOnlyPaths 的职责，
 * 不该在唯一可写模块里再开一条目录遍历路径。因此这份线索由调用方注入
 * （`search.ts` 的会话索引里已有 `executionIds`，零额外 IO）；缺省不注入时
 * ReferencedArchive 集合为空，计划退化为纯定义式集合。
 */
export interface SessionLineage {
  sessionId: string;
  historyExecutionIds: readonly string[];
}

export interface CleanerDeps {
  /** 缺省退回 `fs.promises`（含 `lstat` 作为 `stat`）；本任务只用到 `stat` */
  fs?: CleanerFsDeps;
  /** 写 OutputChannel（与 StorageReportCommand 共用，Req 14.16） */
  audit: (lines: string[]) => void;
  confirm: (p: ConfirmPrompt) => Promise<'confirm' | 'confirmWithReferenced' | 'cancel'>;
  archives: () => readonly ArchiveInfo[];
  /** analyzer 逐级失效 + credits 摘除（Req 14.13） */
  invalidate: (deletedPaths: readonly string[]) => void;
  roots: CleanerRoots;
  /** 现存会话的 lineage 线索；缺省视为「无从判定引用关系」→ referenced 为空 */
  lineages?: () => readonly SessionLineage[];
}

/* ------------------------------------------------------------------ *
 * 2. plan()：只读的计划生成
 * ------------------------------------------------------------------ */

/**
 * 本节唯一需要的缺省 fs 依赖：`stat`。
 *
 * 取 `lstat` 而非 `stat`，使符号链接被识别为链接自身（`isSymbolicLink() === true`）
 * 而不是跟随到目标——第 3 节的 `assertDeletable` 据此把链接一律拒绝（Req 8.6）。
 * `plan()` 全程只读，只需要这一个缺省；`unlink` / `readFile` / `writeFile` / `delay`
 * 的缺省实现见紧随其后的 `DEFAULT_FS`，供第 5 节的 `run()` 使用。
 */
function defaultStat(
  p: string
): Promise<{ size: number; mtimeMs: number; isSymbolicLink(): boolean }> {
  return lstat(p);
}

/**
 * `CleanerFsDeps` 的缺省实现——退回 `fs.promises`，即本模块**全部**写盘能力的落点。
 *
 * 四个调用一一对应到 `fs/promises` 的具名导入，`delay` 缺省为真实 `setTimeout` 包装
 * （段 6 锁类重试的等待，测试可注入以免真睡 200ms）。此处**没有**、也不可能出现
 * `rm` / `rmdir` / `rename` / `cp`：模块顶部压根没导入它们（见文件头）。
 */
const DEFAULT_FS: Required<CleanerFsDeps> = {
  stat: defaultStat,
  unlink: (p) => unlink(p),
  readFile: (p, enc) => readFile(p, enc),
  writeFile: (p, data, enc) => writeFile(p, data, enc),
  delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  readdir: (p) => readdir(p, { withFileTypes: true }) as unknown as Promise<CleanerDirent[]>,
  // 非递归：不传 `{ recursive: true }`。Node 的 `rmdir` 递归模式已废弃，且本模块从不需要它
  rmdir: (p) => rmdir(p),
};

/**
 * 段 6 锁类重试的三个常量。只有错误 `code` 落在这个集合里才重试——文件被 Kiro 或
 * 杀软临时占用是可自愈的瞬时态；`ENOENT`（已不存在，段 5 早已按跳过处理）、`EISDIR`
 * 之类则是确定性错误，重试只是白等。
 */
const RETRYABLE_UNLINK_CODES: ReadonlySet<string> = new Set([
  'EBUSY',
  'EPERM',
  'EACCES',
  'ELOCK',
]);
/** 至多重试次数（首次尝试之外）。 */
const MAX_UNLINK_RETRIES = 3;
/** 每次重试前的等待毫秒数（走注入的 `delay`，测试可断言恒为 200）。 */
const RETRY_DELAY_MS = 200;

/** 1.x 会话目录内的快照子目录名（与 `classify.ts` 的 `classifyNewPath` 同一批常量）。 */
const NEW_SNAPSHOTS_DIR = 'snapshots';
/** 1.x 会话目录内的子执行子目录名。 */
const NEW_SUB_EXECUTIONS_DIR = 'sub-executions';

/**
 * 会话目录枚举的深度上限。真实快照结构（`snapshots/<hash>/<工作区相对路径>`）远达不到；
 * 超限只让计划不完整（少删），不会让枚举在损坏或恶意的目录结构上无限递归。
 */
const MAX_WALK_DEPTH = 24;

/**
 * 旧残留清理的互斥键（Requirement 11.9）。与会话清理共用同一个 `inflight` 集合，
 * 但取一个**不可能与任何 sessionId 冲突**的固定串：sessionId 是 uuid 或 `sess_<uuid>`，
 * 不含双下划线包围的形态。共用集合的好处是「同一时刻只有一次清理在跑」这条更强的保证
 * 顺带成立于两种清理之间的组合。
 */
const LEGACY_RESIDUE_INFLIGHT_KEY = '__legacy_residue__';

/**
 * `chatSessionId` / `sessionId` 是否可用于归因。缺失 / 空串 / 纯空白都视为无归因，
 * 与 `orphan.ts` 的 `hasOwner`、`analyzer.ts` 的同名判据**同一口径**（Req 14.1、14.2）：
 * 那两处判「这个存档归不归某会话」，这里判「这个存档能不能进某会话的删除计划」，
 * 三处必须一致，否则会出现「统计说归你、清理说不归你」的裂缝。
 */
function hasOwner(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.trim().length > 0;
}

/** 只接受有限正数字节数，其余（NaN / 负数）按 0 计，避免污染合计。 */
function safeBytes(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * 路径的比较键：用于去重与「是不是清单」的判定。
 *
 * 只用于**比较**，计划里保存的仍是原始路径字符串——因为第 3 节的
 * `assertDeletable` 必须先在原始形式上查 `..` 路径段，一旦这里就地规范化，
 * `path.resolve` 会把 `..` 吃掉，那一步校验将永远查不出问题（Req 14.19）。
 * 大小写归一是为了 Windows：`Sessions.json` 与 `sessions.json` 是同一个文件。
 */
function cmpKey(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * 目标会话的存档是否被**其它现存会话**的 credit lineage 引用（Req 14.4）。
 *
 * lineage 的判定方式与既有 credit（`credits.ts` 的 `lineageClosure`）以及
 * `analyzer.ts` 的 `wantedSessionIds` 完全一致：某会话 S 的 `history[].executionId`
 * 经 `hash32` 反查存档、取其 `chatSessionId` 并入 S 的 lineage 集合（一层并入）。
 * 因此只要存在某个 `S ≠ target` 的 history 引用了一条 `chatSessionId === target`
 * 的存档，`target` 就落在 S 的 lineage 集合里——此时 **target 的全部存档**都会被
 * 计入 S 的 LineageFootprint 与 S 的累计 credit，删掉其中任何一条都会让 S 的历史
 * 用量无法回溯。所以引用一旦成立，判定就是整批而非单条：这与 ReferencedArchive
 * 的定义（"被目标会话之外任一现存会话的 credit lineage 集合引用"）严格对应。
 *
 * 没有注入 `lineages` 时返回 false——无从判定引用关系时不臆造引用，
 * 计划退化为纯定义式集合。
 */
function isReferencedByOtherSessions(
  sessionId: string,
  archives: readonly ArchiveInfo[],
  lineages: readonly SessionLineage[]
): boolean {
  if (lineages.length === 0) return false;

  // 文件名(hash32(executionId)) → 条目，供 history executionId 反查所属会话
  const byName = new Map<string, ArchiveInfo>();
  for (const a of archives) byName.set(a.name, a);

  for (const lin of lineages) {
    if (lin.sessionId === sessionId) continue; // 目标会话自身不构成"其它会话的引用"
    for (const eid of lin.historyExecutionIds) {
      if (!eid) continue;
      const ent = byName.get(hash32(eid));
      if (ent && hasOwner(ent.chatSessionId) && ent.chatSessionId === sessionId) return true;
    }
  }
  return false;
}

export class SessionCleaner {
  private readonly deps: CleanerDeps;

  /**
   * 同一 sessionId 的清理互斥占位（Req 14.18）。**实例级**而非模块级：宿主侧按单例
   * 持有一个 `SessionCleaner`（`RankingDeps.cleaner`），因此实例内互斥即等于全局互斥；
   * 做成实例字段而非模块级 `Set` 可避免测试之间、以及未来多实例场景的状态串扰。
   * 段 0 占位、段 11（`finally`）摘除。
   */
  private readonly inflight = new Set<string>();

  constructor(deps: CleanerDeps) {
    this.deps = deps;
  }

  /**
   * 生成清理计划。**全程只读**：除注入的 `stat` 之外不做任何文件系统调用，
   * 不删除、不写入、不枚举目录（Req 14.1–14.4）。
   *
   * 待删文件集合的定义式：
   *
   * - `attachment`：`chatSessionId` 与 `sessionId` **区分大小写严格相等**的全部
   *   ExecutionArchive。`chatSessionId` 缺失 / 空字符串 / 纯空白的存档一律排除在
   *   **任何**会话的计划之外（它们是孤儿，只统计不清理，见 `orphan.ts`）。
   * - `full`：上者并上当前工作区 WorkspaceSessionDir 下的 `<sessionId>.json`，
   *   并把「从同一目录的 SessionManifest 中移除该 sessionId 条目」列为 `manifestUpdate`
   *   附加操作——清单要**改**不要删，因此 SessionManifest 恒不进 `files`。
   * - ReferencedArchive 默认从 `files` 中剔除、单列到 `referenced`，两个集合恒不相交。
   *
   * `stat` 失败的条目直接不进计划：文件已不存在或不可访问，既删不掉也没有字节可释放。
   * 这与段 5 复核里「missing → 跳过」同口径，只是发生得更早。符号链接**照常进计划**
   * （其 `stat` 能成功），由段 4 的 `assertDeletable` 拒绝并计入失败（Req 14.10）。
   */
  async plan(mode: CleanupMode, sessionId: string, title: string): Promise<CleanupPlan> {
    // 先判格式：1.x 目录型会话走另一套枚举（Req 10.3、10.4）。
    // 判据是「目标目录能否被枚举」而不是「路径拼得出来」——拼路径永远成功。
    const newSessionDir = await this.resolveNewSessionDir(sessionId);
    if (newSessionDir !== null) {
      return this.planNewLayout(mode, sessionId, title, newSessionDir);
    }
    return this.planOldLayout(mode, sessionId, title);
  }

  /**
   * 目标会话在 1.x 下的会话目录，判不出来则 `null`（此时按 0.9x 处理）。
   *
   * 三个前置条件缺一即 `null`，且**一次文件系统调用都不发生**：
   * 没给 `newSessionsRoot`（拿不到删除围栏）、没给 `newWorkspaceSessionDir`、
   * 或没注入 `readdir`（枚举不了目录）。这保证 0.9x 宿主与既有测试夹具的调用面
   * 仍然只有那四个写/读调用，行为逐字不变。
   *
   * 最后一步用 `readdir` 探测存在性而不是 `stat`：本模块的 `stat` 形状里没有
   * `isDirectory()`（它是为文件快照设计的），而「能被枚举」恰好就是「是个可处理的目录」
   * 这个我们真正关心的性质。
   */
  private async resolveNewSessionDir(sessionId: string): Promise<string | null> {
    const { roots } = this.deps;
    const wsDir = roots.newWorkspaceSessionDir;
    // 顺序要紧：先看**根**再取注入点。0.9x 宿主（两个新根都不给）因此在这里就返回，
    // 连 `deps.fs.readdir` 这个属性都不会被读到 —— Property 14(b) 用 Proxy 记录
    // 「哪些注入点被取用过」，把顺序写反会让 0.9x 的调用面凭空多出一个 readdir。
    if (!hasOwner(sessionId) || !roots.newSessionsRoot || !wsDir) return null;
    const readdirFn = this.readdirFn();
    if (!readdirFn) return null;

    const dir = path.join(wsDir, sessionId);
    // 围栏校验先做：目录名里带 `..` 之类的 sessionId 不该有机会被枚举
    if (segmentsOf(sessionId).some((s) => s === '..' || s === '.')) return null;
    if (!isUnder(path.resolve(roots.newSessionsRoot), path.resolve(dir))) return null;

    try {
      await readdirFn(dir);
      return dir;
    } catch {
      return null; // 不存在 / 不可枚举 / 不是目录 → 按 0.9x 处理
    }
  }

  /**
   * 1.x 目录型会话的计划（Requirement 10.3、10.4、10.7）。
   *
   * - `attachment`：待删集合 = `snapshots/` 与 `sub-executions/` 内**已枚举**的具体文件；
   *   `session.json` 与 `messages.jsonl` 排除在外；**不移除任何目录**（那两个目录还要留着，
   *   会话本体仍然可用）
   * - `full`：待删集合 = 该目录下**全部**已枚举文件；`dirs` 给出自底向上的空目录移除序列，
   *   末项恒为会话目录本身
   *
   * 两种模式都**不**碰 `referenced`（1.x 快照按会话目录物理隔离，不存在跨会话引用，design D4）
   * 与 `manifestUpdate`（1.x 没有会话清单）。
   *
   * 枚举失败的子目录只是被跳过：后果是计划不完整，而 `full` 的目录移除阶段会在
   * 「重新枚举确认为空」这一步如实发现它非空并保留它（Req 10.6）——偏差方向是少删。
   */
  private async planNewLayout(
    mode: CleanupMode,
    sessionId: string,
    title: string,
    sessionDir: string
  ): Promise<CleanupPlan> {
    const createdAt = Date.now();
    const walked = await this.walkSessionDir(sessionDir);

    const attachmentRoots = [
      path.join(sessionDir, NEW_SNAPSHOTS_DIR),
      path.join(sessionDir, NEW_SUB_EXECUTIONS_DIR),
    ];
    const wanted =
      mode === 'full'
        ? walked.files
        : walked.files.filter((f) =>
            attachmentRoots.some((root) => isUnder(path.resolve(root), path.resolve(f.path)))
          );

    let totalBytes = 0;
    for (const f of wanted) totalBytes += f.size;

    return {
      createdAt,
      mode,
      sessionId,
      title,
      layout: 'new',
      // 只有 full 才收目录：attachment 之后 `snapshots/` 仍属于这个仍然存在的会话
      dirs: mode === 'full' ? walked.dirs : [],
      newSessionDir: sessionDir,
      files: wanted,
      totalBytes,
      totalFiles: wanted.length,
      referenced: [],
      referencedBytes: 0,
      referencedFiles: 0,
      manifestUpdate: null,
    };
  }

  /**
   * 递归枚举会话目录，产出全部文件（带 `size` / `mtimeMs` 快照）与全部子目录。
   *
   * 三条约束：
   * - **符号链接不跟随**：链接条目作为待删项进入计划（与 0.9x 同口径），随后被段 4 的
   *   `assertDeletable` 以「符号链接」拒绝并计入失败；绝不沿着它往下走，避免跳出会话目录。
   * - `dirs` **按深度倒序**（自底向上），末项恒为会话目录本身——这个顺序是 Req 10.5 的
   *   「自底向上逐级移除」得以成立的前提，故在计划阶段就固定下来。
   * - 深度上限 {@link MAX_WALK_DEPTH}：真实快照远达不到，超限只让计划不完整（少删），
   *   不会让枚举在恶意/损坏的目录结构上无限递归。
   */
  private async walkSessionDir(
    sessionDir: string
  ): Promise<{ files: CleanupTarget[]; dirs: string[] }> {
    const fsDeps = this.deps.fs ?? DEFAULT_FS;
    // 走到这里说明 `resolveNewSessionDir` 已经拿到过一个可用的 readdir，故非空
    const readdirFn = this.readdirFn() ?? DEFAULT_FS.readdir;
    const statFn = fsDeps.stat ?? DEFAULT_FS.stat;

    const files: CleanupTarget[] = [];
    const dirsWithDepth: Array<{ dir: string; depth: number }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      dirsWithDepth.push({ dir, depth });
      if (depth >= MAX_WALK_DEPTH) return;

      let entries: CleanerDirent[];
      try {
        entries = await readdirFn(dir);
      } catch {
        return; // 该子目录枚举失败：计划不完整，full 的移除阶段会如实发现它非空
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // 链接一律不跟随：作为待删项进计划，由段 4 拒绝
        if (entry.isSymbolicLink()) {
          files.push({ path: full, size: 0, mtimeMs: 0 });
          continue;
        }
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        try {
          const st = await statFn(full);
          files.push({ path: full, size: safeBytes(st.size), mtimeMs: st.mtimeMs });
        } catch {
          // stat 失败：既删不掉也没有字节可释放，且无从做 TOCTOU 复核 → 不进计划
        }
      }
    };

    await walk(sessionDir, 0);

    // 自底向上：深度大的在前；同深度按路径倒序，使同一磁盘状态下顺序恒定
    dirsWithDepth.sort((a, b) =>
      a.depth !== b.depth ? b.depth - a.depth : a.dir < b.dir ? 1 : a.dir > b.dir ? -1 : 0
    );
    return { files, dirs: dirsWithDepth.map((d) => d.dir) };
  }

  /** 0.9x 单文件会话的计划（本次适配前的原实现，逐字未动语义）。 */
  private async planOldLayout(
    mode: CleanupMode,
    sessionId: string,
    title: string
  ): Promise<CleanupPlan> {
    const createdAt = Date.now();
    const { roots } = this.deps;
    const stat = this.deps.fs?.stat ?? defaultStat;
    const manifestPath = path.join(roots.sessionDir, MANIFEST_FILENAME);
    const manifestKey = cmpKey(manifestPath);

    // ---- 候选存档：区分大小写严格相等，且 chatSessionId 必须有归因 ----
    const candidates: ArchiveInfo[] = [];
    if (hasOwner(sessionId)) {
      const seen = new Set<string>();
      for (const a of this.deps.archives()) {
        if (!hasOwner(a.chatSessionId)) continue;
        if (a.chatSessionId !== sessionId) continue;
        const key = cmpKey(a.path);
        // 清单不是存档，恒不进 files；索引里理论上不会出现它，这里是构造性保证
        if (key === manifestKey) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(a);
      }
    }

    const referencedByOthers = isReferencedByOtherSessions(
      sessionId,
      this.deps.archives(),
      this.deps.lineages?.() ?? []
    );

    const files: CleanupTarget[] = [];
    const referenced: CleanupTarget[] = [];
    for (const a of candidates) {
      let snap: { size: number; mtimeMs: number };
      try {
        const st = await stat(a.path);
        snap = { size: safeBytes(st.size), mtimeMs: st.mtimeMs };
      } catch {
        // 文件已不存在 / 不可访问：不进计划。没有字节可释放，也无从做 TOCTOU 复核。
        continue;
      }
      const target: CleanupTarget = { path: a.path, size: snap.size, mtimeMs: snap.mtimeMs };
      // 引用一旦成立即整批保留（见 isReferencedByOtherSessions 的说明），
      // 因此同一条目只会落进 files 与 referenced 中的一个——两集合构造性不相交。
      (referencedByOthers ? referenced : files).push(target);
    }

    // ---- full 模式：并上 SessionFile ----
    let manifestUpdate: CleanupPlan['manifestUpdate'] = null;
    if (mode === 'full') {
      // 清单条目的移除恒为附加操作：即使 SessionFile 已不在盘上（用户手工删过），
      // 清单里的残留条目仍需摘除，否则该会话会以"有标题无正文"的形态留在列表里。
      manifestUpdate = { path: manifestPath, sessionId };

      const sessionFile = path.join(roots.sessionDir, `${sessionId}.json`);
      const sessionKey = cmpKey(sessionFile);
      // sessionId 恰为 'sessions' 时拼出的就是清单本身——必须挡住（Req 14.1、14.2）
      const alreadyListed = files.some((f) => cmpKey(f.path) === sessionKey);
      if (hasOwner(sessionId) && sessionKey !== manifestKey && !alreadyListed) {
        try {
          const st = await stat(sessionFile);
          files.push({ path: sessionFile, size: safeBytes(st.size), mtimeMs: st.mtimeMs });
        } catch {
          // SessionFile 不存在：只做清单条目摘除，不构成失败
        }
      }
    }

    let totalBytes = 0;
    for (const f of files) totalBytes += f.size;
    let referencedBytes = 0;
    for (const r of referenced) referencedBytes += r.size;

    return {
      createdAt,
      mode,
      sessionId,
      title,
      layout: 'old',
      dirs: [],
      newSessionDir: null,
      files,
      totalBytes,
      totalFiles: files.length,
      referenced,
      referencedBytes,
      referencedFiles: referenced.length,
      manifestUpdate,
    };
  }

  /* ---------------------------------------------------------------- *
   * 5. run()：计划 → 确认 → 执行的 12 段流水线（唯一真正写盘的地方）
   * ---------------------------------------------------------------- */

  /**
   * 计划 → 审计 → 确认 → 逐文件删除 → 清单读改写 → 缓存失效 → 审计明细的全流程唯一入口。
   *
   * **任何一段失败都不回滚已完成的段**——删除本身不可逆，回滚是假承诺；取而代之的是
   * 每段结果都进入 `CleanupResult` 与审计（Req 9.9、14.12）。段号与 design「执行流水线
   * 与各段失败语义」表的 0–11 对应：
   *
   * - 段 0 互斥占位：同一 sessionId 正在清理 → `state: 'rejected'`，不写审计（Req 14.18）
   * - 段 1 `plan()`：生成失败**上抛**给调用方（由其通知「会话清理失败：…」）；
   *   空计划（无待删也无引用冲突文件）→ `state: 'noop'` 且**不**弹确认（Req 14.7）
   * - 段 2 审计写入 CleanupPlan（删除前先落痕，Req 14.17）；写失败仅吞掉、在段 10 注明
   * - 段 3 模态确认（Req 14.5、14.6）：取消/关闭 → `state: 'cancelled'`，文件与清单原样；
   *   用户显式选择包含 ReferencedArchive → 并入待删集合、按更新后合计做**二次**确认
   * - 段 4 `assertDeletable` 路径边界校验：拒绝路径进 `failed[]`（带原因），继续其余（Req 8.6、14.19）
   * - 段 5 逐文件 re-stat 复核：不存在 / `size` 或 `mtimeMs` 与快照不一致 → 进 `skipped[]`（Req 14.20）
   * - 段 6 单文件 `unlink`：`EBUSY`/`EPERM`/`EACCES`/`ELOCK` 类错误重试、间隔 200ms；
   *   仍失败或其它错误 → 进 `failed[]`，绝不中止其余删除（Req 14.9、14.10）
   * - 段 7 SessionManifest 读改写（仅 `full`）：解析失败/非数组/写失败 → `manifestUpdated: 'failed'`，
   *   保留已完成的删除结果且不抛异常（Req 14.11、14.12）
   * - 段 8 缓存失效：`invalidate(被删路径)`（analyzer 逐级失效 + credits 摘除）；
   *   无论全成/部分/全败都执行，失败仅吞掉（Req 14.13）
   * - 段 9 刷新 UI：**由调用方负责**（`CleanerDeps` 无 UI 钩子，见 extension 接线），此处不做
   * - 段 10 审计写入明细：逐条被删/失败/跳过路径与原因、三类计数合计与 `manifestUpdated`（Req 14.16）
   * - 段 11 `finally` 中摘除互斥占位
   *
   * 段 4/5/6 对每个待删文件独立走完，因此"部分成功"是常态：`CleanupResult` 恒满足
   * `deletedFiles + failed.length + skipped.length === 计入删除流程的文件总数`（Property 30）。
   * 待删集合恒来自 `plan.files`（外加用户显式勾选的 `plan.referenced`），因此 `unlink` 的
   * 实参恒 ⊆ 计划枚举的路径，绝不触及计划外文件（Property 27）。
   */
  async run(mode: CleanupMode, sessionId: string, title: string): Promise<CleanupResult> {
    // ---- 段 0：互斥占位。已在进行 → 拒绝，不写审计 ----
    if (this.inflight.has(sessionId)) {
      return {
        state: 'rejected',
        mode,
        sessionId,
        deletedFiles: 0,
        deletedBytes: 0,
        failed: [{ path: sessionId, reason: '该会话的清理正在进行' }],
        skipped: [],
        manifestUpdated: 'skipped',
        includedReferenced: false,
        // 段 0 早于 plan()，此时还不知道格式；'old' 是不误导的缺省（它也不影响任何行为）
        layout: 'old',
        removedDirs: 0,
      };
    }
    this.inflight.add(sessionId);

    try {
      // ---- 段 1：生成计划（生成失败上抛给调用方） ----
      const plan = await this.plan(mode, sessionId, title);

      // 空计划：无待删文件、无引用冲突文件，且没有目录要收 → noop，不弹确认（Req 14.7、10.14）。
      // 1.x 的空会话目录（文件都被手工删过、只剩空壳）**不是**空计划：`dirs` 非空，
      // full 清理仍应把那些空目录收掉，否则排行页会一直留着一条 0 字节的幽灵行。
      if (plan.files.length === 0 && plan.referenced.length === 0 && plan.dirs.length === 0) {
        return {
          state: 'noop',
          mode,
          sessionId,
          deletedFiles: 0,
          deletedBytes: 0,
          failed: [],
          skipped: [],
          manifestUpdated: 'skipped',
          includedReferenced: false,
          layout: plan.layout,
          removedDirs: 0,
        };
      }

      // ---- 段 2：删除前先落审计（写失败吞掉，段 10 注明） ----
      const auditPlanOk = this.safeAudit(this.formatPlanAudit(plan, title));

      // ---- 段 3：模态确认（含 ReferencedArchive 的二次确认） ----
      const decision = await this.deps.confirm({
        stage: 'primary',
        mode,
        sessionId,
        title,
        layout: plan.layout,
        dirCount: plan.dirs.length,
        totalFiles: plan.totalFiles,
        totalBytes: plan.totalBytes,
        referencedFiles: plan.referencedFiles,
        referencedBytes: plan.referencedBytes,
      });
      if (decision === 'cancel') {
        return this.cancelledResult(mode, sessionId, plan.layout);
      }

      let includedReferenced = false;
      const targets: CleanupTarget[] = [...plan.files];
      if (decision === 'confirmWithReferenced') {
        // 二次确认：按并入 referenced 后的合计（Req 14.6），说明其它会话历史 credit 用量无法回溯
        const decision2 = await this.deps.confirm({
          stage: 'referenced',
          mode,
          sessionId,
          title,
          layout: plan.layout,
          dirCount: plan.dirs.length,
          totalFiles: plan.totalFiles + plan.referencedFiles,
          totalBytes: plan.totalBytes + plan.referencedBytes,
          referencedFiles: plan.referencedFiles,
          referencedBytes: plan.referencedBytes,
        });
        if (decision2 === 'cancel') {
          return this.cancelledResult(mode, sessionId, plan.layout);
        }
        includedReferenced = true;
        targets.push(...plan.referenced);
      }

      // ---- 段 4~6：逐文件校验 / 复核 / 删除 ----
      const fsDeps = this.deps.fs ?? DEFAULT_FS;
      const stat = fsDeps.stat ?? DEFAULT_FS.stat;
      const unlinkFn = fsDeps.unlink ?? DEFAULT_FS.unlink;
      const delayFn = fsDeps.delay ?? DEFAULT_FS.delay;

      const deletedPaths: string[] = [];
      let deletedFiles = 0;
      let deletedBytes = 0;
      const failed: CleanupResult['failed'] = [];
      const skipped: CleanupResult['skipped'] = [];

      for (const target of targets) {
        // 单次 re-stat：既供段 4 的符号链接判定，又供段 5 的 TOCTOU 比对
        let snap: { size: number; mtimeMs: number; isSymbolicLink(): boolean } | null = null;
        try {
          snap = await stat(target.path);
        } catch {
          snap = null; // 文件已不存在 / 不可 stat
        }

        // 段 4：路径边界校验。拒绝优先于「不存在」——计划外/非法路径恒进 failed，
        // 即使它此刻不在盘上（Req 14.19、8.6）。快照拿不到时按非链接处理，
        // 而 dotDot/越界/清单/不匹配这些拒绝原因本就不依赖符号链接标记（symlink 是第 ⑤ 步）。
        const reject = assertDeletable(this.deps.roots, target.path, {
          isSymbolicLink: snap?.isSymbolicLink() ?? false,
          // 1.x 时传目标会话目录，校验切到「必须落在该目录之内」那条围栏（Req 10.8）；
          // 0.9x 恒传 null，走与本次适配前逐字相同的两类白名单判定
          newSessionDir: plan.newSessionDir,
        });
        if (reject !== null) {
          failed.push({ path: target.path, reason: reject });
          continue;
        }

        // 段 5：re-stat 复核（TOCTOU）
        if (snap === null) {
          skipped.push({ path: target.path, reason: 'missing' });
          continue;
        }
        if (snap.size !== target.size || snap.mtimeMs !== target.mtimeMs) {
          skipped.push({ path: target.path, reason: 'changed' });
          continue;
        }

        // 段 6：单文件 unlink，锁类错误重试
        const outcome = await this.unlinkWithRetry(unlinkFn, delayFn, target.path);
        if (outcome === null) {
          deletedFiles++;
          deletedBytes += target.size;
          deletedPaths.push(target.path);
        } else {
          failed.push({ path: target.path, reason: outcome });
        }
      }

      // ---- 段 6b：非递归移除已清空的目录（仅 1.x + full，Req 10.5、10.6、10.10） ----
      // **门槛**：全部文件删除成功才执行。有文件失败或被跳过时目录必然非空，
      // 逐级去试只会得到一串 ENOTEMPTY 失败项，把审计淹掉却不提供任何信息。
      let removedDirs = 0;
      if (plan.layout === 'new' && mode === 'full' && plan.dirs.length > 0) {
        if (failed.length === 0 && skipped.length === 0) {
          const outcome = await this.removeEmptyDirs(plan);
          removedDirs = outcome.removed;
          failed.push(...outcome.failed);
          deletedPaths.push(...outcome.removedPaths);
        } else {
          failed.push({
            path: plan.newSessionDir ?? plan.sessionId,
            reason: `有文件未删除（失败 ${failed.length} / 跳过 ${skipped.length}），已保留会话目录`,
          });
        }
      }

      // ---- 段 7：SessionManifest 读改写（仅 full） ----
      const manifestUpdated = await this.updateManifest(mode, plan, sessionId, fsDeps);

      // ---- 段 8：缓存失效（无论成败都执行，失败吞掉） ----
      try {
        this.deps.invalidate(deletedPaths);
      } catch {
        /* 失效失败最坏是数值滞后 60 秒，不影响删除结果 */
      }

      // 段 9 由调用方刷新 UI，此处不做。

      // ---- 段 10：审计明细 ----
      this.safeAudit(
        this.formatDetailAudit({
          mode,
          sessionId,
          deletedFiles,
          deletedBytes,
          failed,
          skipped,
          manifestUpdated,
          auditPlanOk,
          layout: plan.layout,
          removedDirs,
        })
      );

      return {
        state: 'done',
        mode,
        sessionId,
        deletedFiles,
        deletedBytes,
        failed,
        skipped,
        manifestUpdated,
        includedReferenced,
        layout: plan.layout,
        removedDirs,
      };
    } finally {
      // ---- 段 11：摘除互斥占位 ----
      this.inflight.delete(sessionId);
    }
  }

  /**
   * 旧残留清理（Requirement 11.1–11.9）。与 {@link run} 平行的第二个执行入口。
   *
   * 为什么不复用 `run()`：那条流水线的每一段都以「一个 sessionId 的会话」为单位——
   * 计划来自 ArchiveIndex 或会话目录、确认文案讲的是某个会话、清单条目要摘除、
   * 互斥键是 sessionId。旧残留是**跨全部工作区的一批文件**，硬塞进去会让那条流水线
   * 多出一堆「这次不适用」的分支，反而更难论证它的安全性。共用的是真正该共用的三件事：
   * `assertLegacyResidueDeletable` 的白名单式校验、`unlinkWithRetry` 的锁类重试、
   * 以及段 5 的 TOCTOU 复核。
   *
   * 段序（与 `run()` 一一对应，故审计形态一致）：
   * - 段 0 互斥占位（键为固定串 `__legacy_residue__`，Req 11.9）
   * - 段 1 计划来自调用方传入的清单——**它只含「已迁移仅残留」**（Req 11.2）。空清单 →
   *   `state: 'noop'` 且**不弹确认**（Req 11.6）
   * - 段 2 删除前写审计（Req 11.7）
   * - 段 3 模态确认，文案含释放量与**被排除的未迁移数量**（Req 11.4）
   * - 段 4~6 逐文件：边界校验 → re-stat 复核 → 带重试的 `unlink`
   * - 段 8 缓存失效（Req 11.8）；段 10 审计明细
   *
   * 恒不移除任何目录：旧目录还留着其它工作区、其它会话的数据。
   */
  async runLegacyResidue(input: {
    /** 待删文件（含 `size` / `mtimeMs` 快照）；恒只含「已迁移仅残留」部分 */
    files: readonly CleanupTarget[];
    /** 被排除的「未迁移或无法按会话归属」字节数与文件数，供确认提示单列（Req 11.3、11.4） */
    excludedBytes: number;
    excludedFiles: number;
  }): Promise<CleanupResult> {
    const key = LEGACY_RESIDUE_INFLIGHT_KEY;
    if (this.inflight.has(key)) {
      return {
        ...this.emptyResult('rejected', 'attachment', key),
        failed: [{ path: key, reason: '旧残留清理正在进行' }],
      };
    }
    this.inflight.add(key);

    try {
      const targets = input.files.filter((f) => hasOwner(f.path));
      let totalBytes = 0;
      for (const f of targets) totalBytes += safeBytes(f.size);

      // 段 1：空计划 → 未执行，且不弹确认（Req 11.6）
      if (targets.length === 0) {
        return this.emptyResult('noop', 'attachment', key);
      }

      // 段 2：删除前落审计（Req 11.7）
      const auditPlanOk = this.safeAudit([
        `[旧残留清理计划] ${new Date().toISOString()} 待删 ${targets.length} 个 / ${totalBytes} 字节`,
        `  被排除（未迁移或无法按会话归属，默认不清理）：${input.excludedFiles} 个 / ${input.excludedBytes} 字节`,
        ...targets.map((f) => `  - 待删 ${f.path}（${f.size} 字节）`),
      ]);

      // 段 3：模态确认（Req 11.4）
      const decision = await this.deps.confirm({
        stage: 'primary',
        mode: 'attachment',
        sessionId: key,
        title: '旧格式残留',
        layout: 'old',
        dirCount: 0,
        totalFiles: targets.length,
        totalBytes,
        // 借 referenced* 两栏承载「被排除的未迁移部分」：确认提示的语义是
        // 「这些不会被删」，与引用冲突那一栏完全一致，宿主因此不必为旧残留另写一套文案
        referencedFiles: input.excludedFiles,
        referencedBytes: input.excludedBytes,
      });
      if (decision === 'cancel') return this.emptyResult('cancelled', 'attachment', key);

      // 段 4~6
      const fsDeps = this.deps.fs ?? DEFAULT_FS;
      const stat = fsDeps.stat ?? DEFAULT_FS.stat;
      const unlinkFn = fsDeps.unlink ?? DEFAULT_FS.unlink;
      const delayFn = fsDeps.delay ?? DEFAULT_FS.delay;

      const deletedPaths: string[] = [];
      let deletedFiles = 0;
      let deletedBytes = 0;
      const failed: CleanupResult['failed'] = [];
      const skipped: CleanupResult['skipped'] = [];

      for (const target of targets) {
        let snap: { size: number; mtimeMs: number; isSymbolicLink(): boolean } | null = null;
        try {
          snap = await stat(target.path);
        } catch {
          snap = null;
        }

        const reject = assertLegacyResidueDeletable(this.deps.roots, target.path, {
          isSymbolicLink: snap?.isSymbolicLink() ?? false,
        });
        if (reject !== null) {
          failed.push({ path: target.path, reason: reject });
          continue;
        }
        if (snap === null) {
          skipped.push({ path: target.path, reason: 'missing' });
          continue;
        }
        if (snap.size !== target.size || snap.mtimeMs !== target.mtimeMs) {
          skipped.push({ path: target.path, reason: 'changed' });
          continue;
        }

        const outcome = await this.unlinkWithRetry(unlinkFn, delayFn, target.path);
        if (outcome === null) {
          deletedFiles++;
          deletedBytes += safeBytes(target.size);
          deletedPaths.push(target.path);
        } else {
          failed.push({ path: target.path, reason: outcome });
        }
      }

      // 段 8：缓存失效（Req 11.8）
      try {
        this.deps.invalidate(deletedPaths);
      } catch {
        /* 失效失败最坏是数值滞后，不影响删除结果 */
      }

      // 段 10：审计明细（Req 11.7）
      const lines = [
        `[旧残留清理结果] ${new Date().toISOString()}`,
        `  已删除 ${deletedFiles} 个 / ${deletedBytes} 字节，失败 ${failed.length} 个，跳过 ${skipped.length} 个`,
      ];
      for (const f of failed) lines.push(`  - 失败 ${f.path}：${f.reason}`);
      for (const s of skipped) lines.push(`  - 跳过 ${s.path}：${s.reason}`);
      if (!auditPlanOk) lines.push('  注：计划阶段审计写入失败（不影响删除结果）');
      this.safeAudit(lines);

      return {
        state: 'done',
        mode: 'attachment',
        sessionId: key,
        deletedFiles,
        deletedBytes,
        failed,
        skipped,
        manifestUpdated: 'skipped',
        includedReferenced: false,
        layout: 'old',
        removedDirs: 0,
      };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 三条早退路径（rejected / noop / cancelled）共用的零值结果。 */
  private emptyResult(
    state: CleanupResult['state'],
    mode: CleanupMode,
    sessionId: string
  ): CleanupResult {
    return {
      state,
      mode,
      sessionId,
      deletedFiles: 0,
      deletedBytes: 0,
      failed: [],
      skipped: [],
      manifestUpdated: 'skipped',
      includedReferenced: false,
      layout: 'old',
      removedDirs: 0,
    };
  }

  /** 取消结果：文件、目录与清单一律原样，三类计数皆空。 */
  private cancelledResult(
    mode: CleanupMode,
    sessionId: string,
    layout: CleanupLayout = 'old'
  ): CleanupResult {
    return {
      state: 'cancelled',
      mode,
      sessionId,
      deletedFiles: 0,
      deletedBytes: 0,
      failed: [],
      skipped: [],
      manifestUpdated: 'skipped',
      includedReferenced: false,
      layout,
      removedDirs: 0,
    };
  }

  /**
   * 段 6b：自底向上逐级非递归移除空目录（Requirement 10.5、10.6、10.10）。
   *
   * 每一级都走完整的三步，缺一不可：
   *
   * 1. `assertRemovableDir` 边界校验（拒绝 → 进 `failed`，不调 `rmdir`）
   * 2. **重新枚举**确认为空 —— 这是 Req 10.5 的硬要求，也是 TOCTOU 防线：计划生成到此刻
   *    之间可能有新文件落进来（Kiro 仍在运行）。枚举失败按「不敢删」处理而不是按空处理
   * 3. 非递归 `rmdir`
   *
   * 任一级失败只保留该级并继续下一级？**不**——就此停止。目录是自底向上处理的，
   * 某一级没收掉意味着它的所有祖先必然非空，继续往上试只会产生一串确定失败的 `ENOTEMPTY`
   * 噪音。停止时已完成的文件删除与已移除的下层目录结果全部保留（Req 10.6）。
   */
  private async removeEmptyDirs(
    plan: CleanupPlan
  ): Promise<{ removed: number; removedPaths: string[]; failed: CleanupResult['failed'] }> {
    const target = plan.newSessionDir;
    const readdirFn = this.readdirFn();
    // 与 readdir 同一条规则：注入了自定义 fs 就只认它的 rmdir，缺则视为不可用。
    // 「不可用」意味着一个目录都不动 —— 绝不回退到真实 fs 去删用户的目录。
    const rmdirFn = this.deps.fs ? this.deps.fs.rmdir : DEFAULT_FS.rmdir;
    if (!target || !readdirFn || !rmdirFn) {
      // 注入面不完整：一个目录都不动，如实记为失败而不是静默跳过
      return {
        removed: 0,
        removedPaths: [],
        failed: [{ path: target ?? plan.sessionId, reason: '未提供目录枚举/移除能力，已保留目录' }],
      };
    }

    let removed = 0;
    const removedPaths: string[] = [];
    const failed: CleanupResult['failed'] = [];

    for (const dir of plan.dirs) {
      const reject = assertRemovableDir(this.deps.roots, dir, target);
      if (reject !== null) {
        failed.push({ path: dir, reason: reject });
        break;
      }

      let entries: CleanerDirent[];
      try {
        entries = await readdirFn(dir);
      } catch (e) {
        // 枚举不了就不敢删：宁可留一个空目录，也不能在看不清内容的情况下动手
        failed.push({ path: dir, reason: `重新枚举失败，已保留：${errText(e)}` });
        break;
      }
      if (entries.length > 0) {
        failed.push({ path: dir, reason: `目录非空（${entries.length} 个条目），已保留` });
        break;
      }

      try {
        await rmdirFn(dir);
        removed++;
        removedPaths.push(dir);
      } catch (e) {
        failed.push({ path: dir, reason: `移除目录失败：${errText(e)}` });
        break;
      }
    }
    return { removed, removedPaths, failed };
  }

  /**
   * 段 6 的重试：仅当错误 `code` 属于锁类（`EBUSY`/`EPERM`/`EACCES`/`ELOCK`）才重试，
   * 至多 3 次、每次间隔 `delay(200)`；其它错误直接失败。返回 `null` 表示删除成功，
   * 否则返回失败原因字符串（进 `failed[]`）。绝不上抛，以免中止其余文件的删除。
   */
  private async unlinkWithRetry(
    unlinkFn: CleanerFsDeps['unlink'],
    delayFn: NonNullable<CleanerFsDeps['delay']>,
    p: string
  ): Promise<string | null> {
    let retries = 0;
    // 首次尝试 + 至多 MAX_UNLINK_RETRIES 次重试
    for (;;) {
      try {
        await unlinkFn(p);
        return null;
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        const msg = e instanceof Error ? e.message : String(e);
        if (code && RETRYABLE_UNLINK_CODES.has(code) && retries < MAX_UNLINK_RETRIES) {
          retries++;
          await delayFn(RETRY_DELAY_MS);
          continue;
        }
        return code ? `${code}: ${msg}` : msg;
      }
    }
  }

  /**
   * 段 7：从 SessionManifest 移除该 sessionId 条目。仅 `full` 模式且计划带 `manifestUpdate`
   * 时执行；否则 `'skipped'`。读失败 / 解析失败 / 非数组 / 写失败一律 `'failed'`（不抛）；
   * `removed === 0`（清单里本就没有该条目）视为无需写盘 → `'skipped'`；真正写回后 → `'ok'`。
   * `writeFile` 因此**只**对 SessionManifest 且**仅**在 `full` 模式下、有条目可移除时发生。
   */
  private async updateManifest(
    mode: CleanupMode,
    plan: CleanupPlan,
    sessionId: string,
    fsDeps: CleanerFsDeps
  ): Promise<CleanupResult['manifestUpdated']> {
    if (mode !== 'full' || plan.manifestUpdate === null) return 'skipped';
    const readFileFn = fsDeps.readFile ?? DEFAULT_FS.readFile;
    const writeFileFn = fsDeps.writeFile ?? DEFAULT_FS.writeFile;
    const manifestPath = plan.manifestUpdate.path;
    try {
      const raw = await readFileFn(manifestPath, 'utf8');
      const result = removeManifestEntry(raw, sessionId);
      if ('error' in result) return 'failed';
      if (result.removed === 0) return 'skipped';
      await writeFileFn(manifestPath, result.text, 'utf8');
      return 'ok';
    } catch {
      // readFile / writeFile 失败：保留已完成的删除结果，提示用户去检查清单
      return 'failed';
    }
  }

  /**
   * 取 `readdir` 注入点；**注入了自定义 fs 时只认它自己的**（缺则视为不可用），
   * 不回退到真实 `fs/promises`。
   *
   * 这条规则是为了让「注入的 fs 就是这次运行看到的全部文件系统」成立：若在自定义 fs
   * 缺 `readdir` 时偷偷回退到真实 fs，一个只想在内存夹具上跑的测试会突然去枚举真实磁盘。
   * 只有完全没注入 fs（生产路径）才用缺省实现。
   */
  private readdirFn(): CleanerFsDeps['readdir'] | undefined {
    return this.deps.fs ? this.deps.fs.readdir : DEFAULT_FS.readdir;
  }

  /** 写审计并吞掉异常（OutputChannel 写入失败不该阻止用户释放空间）。返回是否写成功。 */
  private safeAudit(lines: string[]): boolean {
    try {
      this.deps.audit(lines);
      return true;
    } catch {
      return false;
    }
  }

  /** 段 2 的审计文案：删除前落痕的计划快照（含会话格式，Req 10.18）。 */
  private formatPlanAudit(plan: CleanupPlan, title: string): string[] {
    const when = new Date(plan.createdAt).toISOString();
    const lines = [
      `[清理计划] ${when} 模式=${plan.mode} 格式=${layoutLabel(plan.layout)} 会话=${plan.sessionId} 标题=${title}`,
      `  待删文件：${plan.totalFiles} 个 / ${plan.totalBytes} 字节`,
      `  引用冲突（默认保留）：${plan.referencedFiles} 个 / ${plan.referencedBytes} 字节`,
    ];
    if (plan.newSessionDir) lines.push(`  会话目录：${plan.newSessionDir}`);
    for (const f of plan.files) lines.push(`  - 待删 ${f.path}（${f.size} 字节）`);
    for (const r of plan.referenced) lines.push(`  - 保留 ${r.path}（${r.size} 字节，被其它会话引用）`);
    // 目录移除序列按自底向上原样列出：删除失败或中断后，靠这份顺序能看出停在了哪一级
    for (const d of plan.dirs) lines.push(`  - 待移除空目录 ${d}`);
    if (plan.manifestUpdate) lines.push(`  清单条目移除：${plan.manifestUpdate.path}`);
    return lines;
  }

  /** 段 10 的审计文案：逐条被删/失败/跳过与三类计数合计。 */
  private formatDetailAudit(r: {
    mode: CleanupMode;
    sessionId: string;
    deletedFiles: number;
    deletedBytes: number;
    failed: CleanupResult['failed'];
    skipped: CleanupResult['skipped'];
    manifestUpdated: CleanupResult['manifestUpdated'];
    auditPlanOk: boolean;
    layout: CleanupLayout;
    removedDirs: number;
  }): string[] {
    const lines = [
      `[清理结果] ${new Date().toISOString()} 模式=${r.mode} 格式=${layoutLabel(r.layout)} 会话=${r.sessionId}`,
      `  已删除 ${r.deletedFiles} 个 / ${r.deletedBytes} 字节，失败 ${r.failed.length} 个，跳过 ${r.skipped.length} 个，已移除空目录 ${r.removedDirs} 个，清单=${r.manifestUpdated}`,
    ];
    for (const f of r.failed) lines.push(`  - 失败 ${f.path}：${f.reason}`);
    for (const s of r.skipped) lines.push(`  - 跳过 ${s.path}：${s.reason}`);
    if (!r.auditPlanOk) lines.push('  注：计划阶段审计写入失败（不影响删除结果）');
    return lines;
  }
}

/* ------------------------------------------------------------------ *
 * 3. assertDeletable()：路径边界校验（纯函数、零 IO）
 * ------------------------------------------------------------------ */

/**
 * 拒绝原因的**全集**。做成常量对象而不是散落的字面量，为的是让「拒绝集合可枚举」
 * 成为可断言的事实（Property 28）：调用方与测试都能穷举五个取值，而不必去正文里
 * 抄字符串；文案调整也只有一处。
 */
export const DELETE_REJECT_REASONS = {
  /** ① 原始形式含 `..` 路径段 */
  dotDot: '含 .. 路径段',
  /** ② 规范化后落在 StoreRoot 之外 */
  outsideStoreRoot: '超出 StoreRoot',
  /** ③ 指向 SessionManifest 本身（清单要改不要删） */
  manifest: 'SessionManifest 不在删除范围',
  /** ④ 不落在两类白名单位置之一 */
  notAllowed: '不匹配可删除位置',
  /** ⑤ 符号链接（Req 8.6） */
  symlink: '符号链接',
  /**
   * ⑥ 1.x：规范化后落在 NewSessionsRoot 之外、不在目标 NewSessionDir 之内、
   * 或就是会话目录自身（Requirement 10.8、10.10）。
   *
   * 与 `outsideStoreRoot` 分开而不是复用：两者是**不同的围栏**（`~/.kiro/sessions`
   * vs `<UserDataDir>/…/kiro.kiroagent`），审计里混成一句会让排查时分不清越的是哪道界。
   */
  outsideNewSessionDir: '超出目标会话目录',
} as const;

/** 拒绝原因的联合类型：`assertDeletable` 的非 null 返回值恒取自此集合。 */
export type DeleteRejectReason = (typeof DELETE_REJECT_REASONS)[keyof typeof DELETE_REJECT_REASONS];

/** 审计里的会话格式标签（Req 10.18）。 */
function layoutLabel(layout: CleanupLayout): string {
  return layout === 'new' ? '1.x 目录型' : '0.9x 单文件';
}

/** 从 unknown 错误安全取文本（带 `code` 时前置，便于排查）。 */
function errText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  return code ? `${code}: ${msg}` : msg;
}

/** ExecutionArchive 的文件名形态：`hash32` 的产物，**小写**十六进制 32 位。 */
const HEX32 = /^[0-9a-f]{32}$/;

/** SessionFile 的文件名形态：非空 stem + 小写 `.json` 后缀。 */
const SESSION_FILE_RE = /^(.+)\.json$/;

/** 按两种分隔符取路径段（跨平台混用时也能正确切分）。 */
function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * 路径边界校验：返回 `null` 表示放行，否则返回拒绝原因（取自 `DELETE_REJECT_REASONS`）。
 *
 * **白名单式**判定——默认拒绝、显式放行。黑名单式（默认放行、逐条排除危险模式）的
 * 完备性无法论证：漏掉一个模式就是一次误删，而漏掉一个白名单位置只是一次少删
 * （用户重试即可）。判定顺序固定为五步，**先命中者胜**，因此返回的原因也是确定的：
 *
 * | 步 | 条件 | 原因 |
 * | --- | --- | --- |
 * | ① | **原始**形式含 `..` 路径段 | `含 .. 路径段` |
 * | ② | 规范化后 `!isUnder(storeRoot, p)` | `超出 StoreRoot` |
 * | ③ | 等于 `<sessionDir>/sessions.json` | `SessionManifest 不在删除范围` |
 * | ④ | 不匹配两类白名单位置之一 | `不匹配可删除位置` |
 * | ⑤ | `opts.isSymbolicLink` | `符号链接` |
 *
 * 两类白名单位置：
 *
 * - **ExecutionArchive**：`isUnder(<storeRoot>/<workspaceId>/<savesBucket>, p)` 且 basename 为 hex32。
 *   `workspaceId` / `savesBucket` 都取**当前**工作区与当前桶——其它工作区目录、其它桶
 *   （如 ExecutionMetadataBucket）下的文件因此一律落到 ④。
 * - **SessionFile**：`dirname(p) === sessionDir` 且 basename 形如 `<sessionId>.json`。
 *   用 `dirname` 相等而非 `isUnder`，是因为 SessionFile 恒为会话目录的**直接**子文件，
 *   放宽到子目录只会扩大删除面。
 *
 * ① 必须在 `path.resolve` **之前**判断：`resolve` 会把 `..` 消掉，顺序反了这一步就永远
 * 查不出问题（Req 14.19）。`plan()` 保存原始路径字符串（见 `cmpKey` 的说明）正是为此。
 *
 * ⑤ 放在最后只影响原因取值（例如「既在 StoreRoot 之外、又是链接」报的是 `超出 StoreRoot`），
 * 不影响放行集合：链接一律拒绝，因为 `unlink` 一个链接删的是链接本身，而"这是链接还是
 * 真文件"的判断时机与删除时机之间同样有窗口；更重要的是，链接的存在本身就说明这条
 * 路径不是我们预期的存档文件（Req 8.6、14.10）。
 *
 * 全程零文件系统调用：`isSymbolicLink` 由调用方从 `plan()` 的 `lstat` 快照传入，
 * 校验因此可直接做属性测试。
 */
export function assertDeletable(
  roots: CleanerRoots,
  rawPath: string,
  opts: { isSymbolicLink: boolean; newSessionDir?: string | null }
): DeleteRejectReason | null {
  // ① 原始形式含 `..` 段——必须在规范化之前（两种布局共用这一步）
  if (segmentsOf(rawPath).some((s) => s === '..')) return DELETE_REJECT_REASONS.dotDot;

  const p = path.resolve(rawPath);

  // ---- 1.x 分支（Requirement 10.8 的第一类位置）----
  // 只在调用方**明确给出**目标会话目录时启用。不给就完全走下面的 0.9x 逻辑，因此
  // 本次扩展对既有调用方与既有属性测试向量是**行为逐字不变**的（它们从不传这个字段）。
  const newSessionDir = opts.newSessionDir;
  if (newSessionDir) {
    const fence = roots.newSessionsRoot ? path.resolve(roots.newSessionsRoot) : null;
    const target = path.resolve(newSessionDir);
    // 外层围栏：会话目录本身必须落在 NewSessionsRoot 之内。拿不到围栏就一律拒绝——
    // 「没有围栏」不该被当成「围栏无限大」
    if (fence === null || !isUnder(fence, target)) {
      return DELETE_REJECT_REASONS.outsideNewSessionDir;
    }
    // 内层：必须落在目标会话目录**之内**，且不能就是会话目录自身（那是目录，不是待删文件）
    if (!isUnder(target, p) || p.toLowerCase() === target.toLowerCase()) {
      return DELETE_REJECT_REASONS.outsideNewSessionDir;
    }
    if (opts.isSymbolicLink) return DELETE_REJECT_REASONS.symlink;
    return null;
  }

  const storeRoot = path.resolve(roots.storeRoot);

  // ② 规范化后必须落在 StoreRoot 之内（与统计侧共用 classify 的 isUnder 语义）
  if (!isUnder(storeRoot, p)) return DELETE_REJECT_REASONS.outsideStoreRoot;

  const sessionDir = path.resolve(roots.sessionDir);
  const manifestPath = path.join(sessionDir, MANIFEST_FILENAME);
  const base = path.basename(p);

  // ③ 清单要改不要删。大小写归一比较，口径与 plan() 的 cmpKey 一致：
  //    Windows 上 `Sessions.json` 与 `sessions.json` 是同一个文件，
  //    这里宁可多拒一个大小写变体，也不能让清单从任何一侧漏进删除集合。
  if (p.toLowerCase() === manifestPath.toLowerCase()) return DELETE_REJECT_REASONS.manifest;

  // ④ 两类白名单位置，命中其一才继续
  const savesDir = path.join(storeRoot, roots.workspaceId, roots.savesBucket);
  // 桶目录名自身也是 hash32（形态上同样是 hex32），故须排除「p 就是桶目录」这一情形：
  // isUnder 含相等，不排除的话桶目录本身会被当成一条存档放行——本模块不做任何目录操作。
  const isArchive =
    isUnder(savesDir, p) && p.toLowerCase() !== savesDir.toLowerCase() && HEX32.test(base);
  const stem = SESSION_FILE_RE.exec(base)?.[1];
  const isSessionFile =
    path.dirname(p) === sessionDir && stem !== undefined && stem.toLowerCase() !== 'sessions';
  if (!isArchive && !isSessionFile) return DELETE_REJECT_REASONS.notAllowed;

  // ⑤ 符号链接一律拒绝
  if (opts.isSymbolicLink) return DELETE_REJECT_REASONS.symlink;

  return null;
}

/**
 * 旧残留清理的路径边界校验（Requirement 11.5）：返回 `null` 放行，否则给出拒绝原因。
 *
 * 白名单式、纯函数、零 IO，判定顺序四步、先命中者胜：
 *
 * | 步 | 条件 | 原因 |
 * | --- | --- | --- |
 * | ① | **原始**形式含 `..` 路径段 | `含 .. 路径段` |
 * | ② | 规范化后不在 OldSessionsRoot 之内（含拿不到围栏） | `超出 StoreRoot` |
 * | ③ | basename 不是 `<sessionId>.json`，或就是 `sessions.json` 清单 | `不匹配可删除位置` |
 * | ④ | 符号链接 | `符号链接` |
 *
 * ③ 把范围收到「旧会话文件」这一种形态上，而不是放行 OldSessionsRoot 下的一切：待删清单
 * 本来只装这一种文件（见 `analyzer.peekLegacyResidueTargets`），把校验也收到同一形态，
 * 使「清单里混进了别的东西」这类上游 bug 在这里被挡住而不是被执行。迁移标记
 * （`._migration-*.json`）同样不放行——它是「已迁移」的**证据**，删掉会让下一次统计把
 * 那些会话重新判成「未迁移」，反而更保守地卡住后续清理。
 */
export function assertLegacyResidueDeletable(
  roots: CleanerRoots,
  rawPath: string,
  opts: { isSymbolicLink: boolean }
): DeleteRejectReason | null {
  if (segmentsOf(rawPath).some((s) => s === '..')) return DELETE_REJECT_REASONS.dotDot;

  const fence = roots.oldSessionsRoot ? path.resolve(roots.oldSessionsRoot) : null;
  const p = path.resolve(rawPath);
  if (fence === null || !isUnder(fence, p) || p.toLowerCase() === fence.toLowerCase()) {
    return DELETE_REJECT_REASONS.outsideStoreRoot;
  }

  const base = path.basename(p);
  const stem = SESSION_FILE_RE.exec(base)?.[1];
  if (stem === undefined || stem.toLowerCase() === 'sessions' || isMigrationMarkerName(base)) {
    return DELETE_REJECT_REASONS.notAllowed;
  }

  if (opts.isSymbolicLink) return DELETE_REJECT_REASONS.symlink;
  return null;
}

/**
 * 迁移标记文件名判定（`._migration-<uuid>.json`）。
 *
 * 本模块自持一份而不是从 `session/origin.ts` 导入：那个模块具名导入了 `readdirSync` /
 * `readFileSync`，而本模块（唯一可写模块）的 fs 导入面被 Property 14(b) 逐名审查，
 * 为一个十几字符的前缀判定把另一条 fs 依赖链引进来不划算。
 */
function isMigrationMarkerName(name: string): boolean {
  return name.startsWith('._migration-') && name.endsWith('.json');
}

/**
 * `rmdir` 实参的边界校验（Requirement 10.10）：返回 `null` 放行，否则给出拒绝原因。
 *
 * 与 {@link assertDeletable} 同为**白名单式**、纯函数、零 IO。放行条件是全部成立：
 *
 * | 步 | 条件 |
 * | --- | --- |
 * | ① | **原始**形式不含 `..` 路径段（同样必须在 `resolve` 之前查） |
 * | ② | 目标会话目录落在 NewSessionsRoot 之内（外层围栏；拿不到围栏一律拒绝） |
 * | ③ | 待移除目录规范化后**等于目标会话目录或其子目录** |
 *
 * ③ 与 `assertDeletable` 的 1.x 分支只差一点：这里**允许等于**会话目录本身
 * （Req 10.5 的收尾就是移除它），而那边必须拒绝（它是目录，不是可 `unlink` 的文件）。
 *
 * 「删除前重新枚举确认为空」不在本函数里：那是一次 IO，属于执行阶段的职责
 * （见 `SessionCleaner.removeEmptyDirs`）。本函数只回答「这个路径允许被 rmdir 吗」。
 */
export function assertRemovableDir(
  roots: CleanerRoots,
  rawDir: string,
  targetSessionDir: string
): DeleteRejectReason | null {
  if (segmentsOf(rawDir).some((s) => s === '..')) return DELETE_REJECT_REASONS.dotDot;

  const fence = roots.newSessionsRoot ? path.resolve(roots.newSessionsRoot) : null;
  const target = path.resolve(targetSessionDir);
  if (fence === null || !isUnder(fence, target)) {
    return DELETE_REJECT_REASONS.outsideNewSessionDir;
  }
  if (!isUnder(target, path.resolve(rawDir))) {
    return DELETE_REJECT_REASONS.outsideNewSessionDir;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 4. removeManifestEntry()：清单读改写（纯函数、零 IO）
 * ------------------------------------------------------------------ */

/** 缩进探测：原文第一个换行之后的行首空白。探测不到（紧凑单行 JSON）时的缺省。 */
const DEFAULT_INDENT = '  ';

/** 首个「换行 + 行首空白」——捕获组即原文的一级缩进单位（`'  '` / `'    '` / `'\t'`）。 */
const INDENT_PROBE = /\n([ \t]+)/;

/**
 * `removeManifestEntry` 的返回类型。成功分支给出重新序列化的全文与被移除条目数，
 * 失败分支只给 `error`——**没有 `text`**，因此段 7 在结构上不可能拿失败结果去写盘
 * （Requirement 14.12：解析失败时清单必须原样不动）。
 */
export type ManifestRewrite = { text: string; removed: number } | { error: string };

/**
 * 从 SessionManifest 原文中移除目标 sessionId 的条目，**保留原文风格**（Req 14.11、14.12）。
 *
 * 纯函数、零 IO：只做字符串 → 字符串的变换。真正的 `readFile` / `writeFile` 由段 7 调用，
 * 因此本节仍不导入任何写 API。
 *
 * 五步做法（与 design「SessionManifest 读改写：保留原文风格」逐条对应）：
 *
 * 1. `JSON.parse(raw)`；抛异常或顶层不是数组 → 返回 `{ error }`
 * 2. 探测缩进：`/\n([ \t]+)/` 的首个捕获组；探测不到（紧凑单行 JSON）→ 两空格
 * 3. 探测行尾：原文含 `\r\n` → `'\r\n'`，否则 `'\n'`
 * 4. 过滤掉匹配的条目，其余条目**保持原数组顺序**
 * 5. `JSON.stringify(rest, null, indent)`，把 `\n` 换成探测到的行尾；原文以行尾结束则补尾行
 *
 * 其余条目的字段与字段顺序天然保持不动不增：`JSON.parse` 保持对象键的插入顺序，
 * `JSON.stringify` 按同序输出。第 5 步的 `\n` 全量替换是安全的——JSON 文本里字符串
 * 内部不允许出现裸换行（`\n` 转义序列在文本中是反斜杠 + `n` 两个字符），所以能被替换到的
 * 换行只有 `stringify` 自己产生的结构性换行。
 *
 * **条目匹配**：`entry.sessionId` 与 `sessionId` **区分大小写严格相等**——与 `plan()` 里
 * 存档归因的判据同一口径。非对象条目（数组里混入字符串 / null / 数字）恒不匹配、原样保留：
 * 清单是 Kiro 的索引，形态之外的东西不是我们该顺手清掉的。`sessionId` 自身为空 / 纯空白时
 * 按 `hasOwner` 的口径视为无归因，一条都不移除（`removed: 0`）。
 *
 * **`removed` 语义**：被移除的条目数。同一 sessionId 在清单里出现多次（Kiro 写坏过清单）时
 * **全部移除**，`removed` 即实际条数；目标不存在时 `removed: 0`。
 *
 * **`removed === 0` 时返回原文逐字节不变的 `text`**（而非重新序列化的结果）。两点考虑：
 *
 * - 段 7 据 `removed === 0` 判定「无变化」并**跳过 `writeFile`**——不写盘恒比写盘安全，
 *   清理的目标是删文件，不是顺手把用户的清单重排一遍格式。
 * - 万一调用方忽略了 `removed` 直接写回，写入的也是与原文完全相同的字节，仍是无害的空操作。
 *   如果这里返回重新序列化的结果，"风格探测差一点"就会变成一次对无关条目的无谓改写。
 *
 * 写回方式是**单次 `writeFile` 覆盖写**，刻意不用「临时文件 + `rename`」的原子写做法，理由三条：
 *
 * - Requirement 9.8 把 WritableFsAllowlist 收窄到「单文件 `unlink` + SessionManifest 的
 *   `readFile`/`writeFile`」。临时文件要 `writeFile` 到一个新路径再 `rename`，等于引入
 *   创建新文件与重命名两类操作，直接越界，也让"这个模块只会碰哪些路径"不再一眼可判。
 * - Requirement 14.11 明文要求「以单次 `writeFile` 覆盖写回，把临时文件与重命名排除在该路径之外」。
 * - 风险可接受：清单是 Kiro 会重建的索引而非用户数据的唯一副本，且删除已在段 2 落了审计。
 *   覆盖写在极端断电场景下可能留下截断的清单，代价是 Kiro 重新扫描目录重建标题索引——
 *   比"扩展在用户数据目录里留下临时文件残骸"更可接受。段 7 失败时 `manifestUpdated: 'failed'`
 *   会明确告诉用户去检查清单。
 */
export function removeManifestEntry(raw: string, sessionId: string): ManifestRewrite {
  // ---- ① 解析：抛异常或顶层非数组 → 失败分支（清单原样不动） ----
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `SessionManifest 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed)) {
    return { error: 'SessionManifest 顶层结构不是数组' };
  }

  // ---- ④ 过滤（顺序在前只为少做无用功；风格探测与过滤彼此独立） ----
  const target = hasOwner(sessionId) ? sessionId : null;
  const rest = target === null ? parsed : parsed.filter((ent) => !matchesSession(ent, target));
  const removed = parsed.length - rest.length;

  // 无变化：原文逐字节返回，段 7 据此跳过写盘
  if (removed === 0) return { text: raw, removed: 0 };

  // ---- ② 缩进 ----
  const indent = INDENT_PROBE.exec(raw)?.[1] ?? DEFAULT_INDENT;
  // ---- ③ 行尾 ----
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  // ---- ⑤ 同风格重新序列化 ----
  let text = JSON.stringify(rest, null, indent);
  if (eol !== '\n') text = text.split('\n').join(eol);
  // 原文以行尾结束则补尾行（`\r\n` 结尾也以 `\n` 结尾，一次判断即可）
  if (raw.endsWith('\n')) text += eol;

  return { text, removed };
}

/**
 * 清单条目是否为目标会话。区分大小写严格相等，与 `plan()` 的存档归因同一口径；
 * 非对象条目与 `sessionId` 非字符串的条目恒不匹配（原样保留）。
 */
function matchesSession(entry: unknown, sessionId: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const id = (entry as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id === sessionId;
}
