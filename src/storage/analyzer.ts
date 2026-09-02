/**
 * StorageAnalyzer —— 存储占用统计的归因层。
 *
 * 只读约束（Req 7.4、9.7、11.8）：本模块属于 ReadOnlyPaths，只允许
 * `readdir` / `lstat` / `stat` / `readFile`，**不得**引入任何写文件系统 API
 * （`unlink` / `writeFile` / `rm` / `rmdir` / `rename` / `cp`）。存档字节数与
 * `chatSessionId` 一律取自 ArchiveIndex 的只读快照（`listArchiveEntries`），
 * 本模块不打开、不解析任何存档文件内容（Req 7.1）。
 *
 * 模块结构：
 *   1. 归因纯函数         —— computeSessionFootprint（0.9x 单文件会话）
 *   1b. 新布局归因纯函数  —— newSessionSizes / computeNewSessionFootprint /
 *                            buildNewRankingRow / newSessionOrigin（1.x 目录型会话）
 *   1c. 双布局合并纯函数  —— mergeRankingRows / projectSessionTotalFrom /
 *                            sumLegacyResidueSessions（`both` 下的去重、残留归属与聚合）
 *   1d. 聚合维度占位值    —— idleAggregateTotal / idleLegacyResidueTotal（未触发时的 `idle` 态）
 *   2. StorageAnalyzer 类 —— getSummary / getReportData / getRankingRows /
 *                            getNewRankingRows / getMergedRankingRows /
 *                            getProjectSessionTotal / getAllKiroSessionTotal /
 *                            getLegacyResidueTotal / invalidateForDeletedFiles /
 *                            clearCache 与 StorageCache
 * 第 1、1b、1c、1d 节全部为零 IO 纯函数，可独立测试；第 2 节才引入 PathResolver 与 SizeScanner。
 */

import * as path from 'path';
import { readdir, lstat, stat, readFile } from 'fs/promises';
import {
  encodeWorkspaceKeys,
  getHomeKiroDir,
  getKiroUserDataDir,
  getNewSessionsRoot,
  resolveNewWorkspaceSessionDir,
  type PathResolverDeps,
} from '../paths';
import {
  MESSAGES_FILENAME,
  NEW_SESSION_META_FILENAME,
  parseNewSessionMeta,
  type NewSessionMeta,
} from '../session/newFormat';
import {
  hash32,
  listArchiveEntries,
  workspaceIdCandidates,
  type ArchiveInfo,
} from '../credits';
import {
  buildClassifyRoots,
  buildNewClassifyRoots,
  classifyNewPath,
  CATEGORY_META,
  CATEGORY_ORDER,
  type ClassifyRoots,
  type NewClassifyRoots,
} from './classify';
import {
  scanTree,
  SubtreeCache,
  type CategoryTotals,
  type DirentLike,
  type ScanResult,
  type ScannerFsDeps,
  type StatLike,
} from './scanner';
import {
  collectLiveSessions,
  computeOrphans,
  MANIFEST_FILENAME,
  ORPHAN_NOTE,
  type LiveSessionsResult,
  type OrphanFsDeps,
} from './orphan';
import { collectRankingRows, type RankingFsDeps } from './ranking';
import {
  buildReportData,
  type ReportAggregates,
  type ReportSessionInput,
  type ReportWorkspaceInput,
  type StorageReportData,
} from './report';
import {
  determineSessionOrigin,
  isMigrationMarkerFileName,
  parseMigrationMarker,
  NEW_SESSION_ID_PREFIX as ORIGIN_NEW_SESSION_ID_PREFIX,
} from '../session/origin';
import {
  SIZE_NOTE,
  type AggregateTotal,
  type CategoryStat,
  type LegacyResidueTotal,
  type RankingRow,
  type SessionFootprint,
  type SessionOrigin,
  type StorageSummary,
} from './types';

/* ------------------------------------------------------------------ *
 * 1. 归因纯函数
 * ------------------------------------------------------------------ */

/** 只接受有限正数字节数，其余（NaN / 负数 / undefined）按 0 计，避免污染合计。 */
function safeBytes(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * `chatSessionId` / `sessionId` 是否可用于归因。缺失 / 空串 / 纯空白都视为无归因。
 * 与 `orphan.ts` 的 `hasOwner` 同一判据：那边判「这个存档不归任何会话」，
 * 这边判「这个存档能否归到本会话」，两处必须同口径，否则守恒性质（Req 2.3）会破。
 */
function hasOwner(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * 求归因集合。`self` 只含目标会话自身；`lineage` 额外把 `historyExecutionIds`
 * 经 `hash32` 反查存档、取其 `chatSessionId` 并入——与 `credits.ts` 的
 * `lineageClosure` **完全一致**：一层并入，不做 parentSessionIds 传递闭包
 * （避免反向 / 跨链过度连接而高估）。Property 4 会断言两者一致。
 */
function wantedSessionIds(
  sessionId: string,
  scope: 'self' | 'lineage',
  archives: readonly ArchiveInfo[],
  historyExecutionIds?: readonly string[]
): Set<string> {
  const out = new Set<string>();
  if (hasOwner(sessionId)) out.add(sessionId);
  if (scope !== 'lineage' || !historyExecutionIds || historyExecutionIds.length === 0) return out;

  // 文件名(hash32(executionId)) → 条目，供 history executionId 反查所属会话
  const byName = new Map<string, ArchiveInfo>();
  for (const a of archives) byName.set(a.name, a);

  for (const eid of historyExecutionIds) {
    if (!eid) continue;
    const ent = byName.get(hash32(eid));
    if (ent && hasOwner(ent.chatSessionId)) out.add(ent.chatSessionId as string);
  }
  return out;
}

/**
 * 纯函数（零 IO）：由会话 JSON 字节数 + ArchiveIndex 快照算出单会话占用。
 *
 * - 自身口径（`scope: 'self'`）：`jsonBytes` + 所有 `chatSessionId` 与 `sessionId`
 *   **区分大小写严格相等**的存档字节数之和（Req 2.1）。因为每个存档的
 *   `chatSessionId` 唯一，自身口径下一个存档最多归因到一个会话，
 *   「Σ 各会话自身口径存档部分 + 孤儿字节数 = 存档总字节数」由此成立（Req 2.3）。
 * - 累计口径（`scope: 'lineage'`）：归因集合按既有 credit lineage 判定，故
 *   同一存档可被计入多个会话，结果以 `additive: false` 标记不可跨会话求和（Req 2.2、2.4）。
 * - `additive` 与 `scope` 严格对应：`self` → `true`，`lineage` → `false`（Req 2.4、2.5）。
 * - 没有任何匹配存档时 `archiveBytes = 0`、`archivesFound: false`，占用等于
 *   `jsonBytes` 本身——不掺入清单、快照或任何其它组成部分（Req 2.8）。
 *
 * 同一输入恒返回同一结果（无副作用、不读盘），满足可重复性（Req 2.9）。
 */
export function computeSessionFootprint(
  input: {
    sessionId: string;
    jsonBytes: number;
    scope: 'self' | 'lineage';
    /** 该会话 history 引用的 executionId，用于 lineage 追溯（与 credit 一致） */
    historyExecutionIds?: readonly string[];
  },
  archives: readonly ArchiveInfo[]
): SessionFootprint {
  const { sessionId, scope } = input;
  const jsonBytes = safeBytes(input.jsonBytes);
  const wanted = wantedSessionIds(sessionId, scope, archives, input.historyExecutionIds);

  let archiveBytes = 0;
  let matched = 0;
  for (const a of archives) {
    if (!hasOwner(a.chatSessionId)) continue;
    if (!wanted.has(a.chatSessionId as string)) continue;
    archiveBytes += safeBytes(a.size);
    matched++;
  }

  return {
    sessionId,
    scope,
    additive: scope === 'self',
    jsonBytes,
    archiveBytes,
    totalBytes: jsonBytes + archiveBytes,
    // 以「是否命中过存档条目」为准而非字节数 > 0：0 字节的存档也算找到了存档数据，
    // 与 credit 侧 `found` 区分「确实是 0」与「数据不可用 / 已被 LRU 淘汰」同理。
    archivesFound: matched > 0,
  };
}

/* ------------------------------------------------------------------ *
 * 1b. 新布局（1.x 目录型会话）归因纯函数
 * ------------------------------------------------------------------ */

/**
 * 1.x 会话目录内的字节数**两分**拆解，直接对应排行页既有的两个字节列。
 *
 * 两类的定义就是 `classifyNewPath` 的分类在该会话目录内的限制：
 * - `sessionBytes`（会话本体）= 归入 `newSession` 的文件 = `session.json` +
 *   `messages.jsonl` + 会话目录下其余文件（`publish.cursor` / `publish-sub.cursor` 等，
 *   Requirement 6.2 明确把它们算作「新格式会话」）
 * - `attachmentBytes`（附件）= 归入 `newSnapshots` + `newSubExecutions` 的文件，
 *   即 1.x 里 0.9x「执行存档」的对应物（Requirement 6.6）
 *
 * 因为这两类之外的分类在会话目录内不可能出现（`classifyNewPath` 的规则 2~4 兜住
 * `<newSessionsRoot>` 之下的一切），**两者之和恒等于该目录内全部文件的字节数**
 * （Requirement 6.3），排行页「占用合计 = 两列之和」（Requirement 6.9）因此是构造性
 * 成立的，而不是另行累加出来的巧合。
 */
export interface NewSessionSizes {
  /** 会话本体字节数（`newSession` 分类） */
  sessionBytes: number;
  /** 附件字节数（`newSnapshots` + `newSubExecutions` 分类） */
  attachmentBytes: number;
  /** 附件文件数；决定 `archivesFound`（0 字节的快照文件同样算「找到了附件」） */
  attachmentFiles: number;
}

/**
 * 纯函数：把一次会话目录扫描的分类合计折成 {@link NewSessionSizes}。
 *
 * `sessionBytes` 取 `totalBytes − attachmentBytes` 而**不是**直接取
 * `totals.newSession.bytes`：正常情形下两者相等（分类的划分性质），但这么写让
 * 「`sessionBytes + attachmentBytes === totalBytes`」在**任何**输入下都成立——
 * 包括调用方误传了一个不在 `<newSessionsRoot>` 之下的目录（此时全部文件被判为
 * `otherFiles`）。否则那种情形下排行页的合计会凭空缩水，而不是如实反映磁盘。
 */
export function newSessionSizes(scan: Pick<ScanResult, 'totals' | 'totalBytes'>): NewSessionSizes {
  const snapshots = scan.totals.newSnapshots;
  const subExecutions = scan.totals.newSubExecutions;
  const attachmentBytes = safeBytes(snapshots.bytes) + safeBytes(subExecutions.bytes);
  const totalBytes = safeBytes(scan.totalBytes);
  return {
    sessionBytes: Math.max(0, totalBytes - attachmentBytes),
    attachmentBytes: Math.min(attachmentBytes, totalBytes),
    attachmentFiles: safeBytes(snapshots.files) + safeBytes(subExecutions.files),
  };
}

/** {@link computeNewSessionFootprint} 的入参。 */
export interface NewSessionFootprintInput extends Partial<NewSessionSizes> {
  /** 会话 id = NewSessionDir 的目录名 */
  sessionId: string;
  scope: 'self' | 'lineage';
}

/**
 * 纯函数（零 IO）：由 1.x 会话目录的两分拆解算出单会话占用。
 *
 * 与 0.9x 的 {@link computeSessionFootprint} 有两处**刻意**的不同，都源自
 * 「1.x 的快照按会话目录物理隔离」这一事实（Requirement 6.4、设计决策 D4）：
 *
 * - **`self` 与 `lineage` 取同一值**：0.9x 的执行存档存放在
 *   `<StoreRoot>/<WorkspaceId>/<bucket>/` 这个跨会话共享的位置，一个存档可以被
 *   多个 checkpoint 会话继承，故累计口径需要 lineage 追溯；1.x 的快照就在该会话
 *   自己的目录里，不存在跨会话归属，追溯无从发生也无必要。这里**不伪造** lineage
 *   关系（不去把别的会话目录并进来），两个口径返回同一数值。
 * - **`additive` 恒为 `true`**：既然一个文件只属于一个会话目录，各会话占用两两不重
 *   叠，跨会话求和有意义。因此 `lineage` 口径在 1.x 下同样可加——这与 0.9x 的
 *   `additive: scope === 'self'` 不同，是数据布局差异的结果，不是口径不一致。
 *
 * 同一输入恒返回同一结果（无副作用、不读盘），故同一磁盘状态下对同一 NewSessionDir
 * 重复统计恒得同一 SessionFootprint（Requirement 6.15）。
 */
export function computeNewSessionFootprint(input: NewSessionFootprintInput): SessionFootprint {
  const jsonBytes = safeBytes(input.sessionBytes ?? 0);
  const archiveBytes = safeBytes(input.attachmentBytes ?? 0);
  return {
    sessionId: input.sessionId,
    scope: input.scope,
    // 1.x：两个口径同值且均可加（见上方说明）
    additive: true,
    jsonBytes,
    archiveBytes,
    totalBytes: jsonBytes + archiveBytes,
    // 与 0.9x 同口径：以「是否命中过附件条目」为准而非字节数 > 0
    archivesFound: safeBytes(input.attachmentFiles ?? 0) > 0,
  };
}

/**
 * 1.x 中新建会话的 sessionId 前缀；迁移来的会话沿用 0.9x 的裸 uuid。
 *
 * 转发 `session/origin.ts` 的同名常量而不是另抄一份字面量：判定规则的单一实现在那边
 * （见 {@link newSessionOrigin}），这里只为既有导入方保留名字，两侧不存在第二个 `'sess_'`。
 */
export const NEW_SESSION_ID_PREFIX = ORIGIN_NEW_SESSION_ID_PREFIX;

/**
 * 新布局会话的 SessionOrigin（Requirement 9.2、9.3）：位于 NewSessionDir 且
 * sessionId 以 `sess_` 开头 → `new`（1.x 新建），否则 → `migrated`（由 0.9x 迁移而来）。
 *
 * 两个取值都意味着「该会话此刻存在于新布局」，因此都不是
 * `legacy-unmigrated`——那个取值含「1.x 界面里看不见、删掉即永久丢失」的强断言，
 * 只能由旧目录一侧的判定得出，本函数恒不返回它。
 *
 * 实现委托 `session/origin.ts` 的唯一判定实现（任务 7.3 的产出），故「新目录侧的判据」
 * 不存在第二份。这里只固定它的两个入参：`source: 'new'`（本函数只服务新布局取数）与
 * 省略 `presentInOtherSide` / `hasMigrationMarker` —— 单侧取数观测不到旧目录，
 * 「另一侧也有同 sessionId」由合并层补齐（见 {@link mergeRankingRows}）。
 */
export function newSessionOrigin(sessionId: string): SessionOrigin {
  return determineSessionOrigin({
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    source: 'new',
  });
}

/** {@link buildNewRankingRow} 的入参。 */
export interface NewRankingRowInput extends Partial<NewSessionSizes> {
  sessionId: string;
  /**
   * 会话标题，取 `session.json` 的 `title`。
   *
   * 空白标题**原样保留**（不在这里换成占位符），由 `renderRankingRowHtml` 统一渲染成
   * `(无标题)`——与 0.9x 的 `collectRankingRows` 同一分工：取数层不替渲染层兜文案，
   * 否则「无标题」既可能是真实标题也可能是占位符，渲染层无从区分。
   *
   * 注意这与 NewFormatReader 的 `Untitled`（Req 3.2）不冲突：那是搜索/最近列表的展示
   * 占位，走的是另一条渲染路径。
   */
  title: string;
  /** 最后修改时间（epoch ms），取 `lastModifiedAt`（Requirement 6.10） */
  mtimeMs: number;
  origin: SessionOrigin;
}

/**
 * 纯函数：把 1.x 会话映射成排行页的一行（Requirement 6.9、6.10）。
 *
 * 列映射（使排行页的列结构与排序规则**无需任何改动**）：
 * - `jsonBytes` ← 会话本体（`session.json` + `messages.jsonl` + 其余文件）
 * - `archiveBytesSelf` ← 附件（`snapshots/` + `sub-executions/`）
 * - `totalBytes` ← 两者之和，由 {@link computeNewSessionFootprint} 一处算出，
 *   故「合计 = 两列之和」构造性成立，不存在两处各累加一次后漂移的可能
 * - `mtimeMs` ← `lastModifiedAt`；展示格式沿用既有 `formatRankingTime` 的本地时区
 *   `YYYY-MM-DD HH:mm`，本函数只负责给出毫秒数
 */
export function buildNewRankingRow(input: NewRankingRowInput): RankingRow {
  const footprint = computeNewSessionFootprint({ ...input, scope: 'self' });
  return {
    title: typeof input.title === 'string' ? input.title : '',
    sessionId: input.sessionId,
    jsonBytes: footprint.jsonBytes,
    archiveBytesSelf: footprint.archiveBytes,
    totalBytes: footprint.totalBytes,
    mtimeMs: Number.isFinite(input.mtimeMs) ? input.mtimeMs : 0,
    origin: input.origin,
  };
}

/* ------------------------------------------------------------------ *
 * 1c. 双布局（1.x + 0.9x）合并归因纯函数
 * ------------------------------------------------------------------ */

/**
 * 合并时**新侧**（1.x）的取数结果。声明为 {@link NewRowsResult} 的结构化子集，
 * 因此 `getNewRankingRows()` 的返回值可原样传入，无需在调用处摘字段。
 *
 * 只声明合并真正读到的四项 + 行集合：合并层不需要 `footprints`
 * （行上已带三个字节列，且 `additive: true`，见 {@link computeNewSessionFootprint}），
 * 窄接口让「合并依赖新侧取数的内部形状」这条边尽量细。
 */
export interface MergeNewSide {
  rows: readonly RankingRow[];
  /** 新侧参与统计的文件数（扫描器精确给出） */
  files: number;
  partial: boolean;
  skippedCount: number;
  /** 被枚举的新侧根；空数组表示这一侧**未被观测**（根不可用） */
  roots: readonly string[];
}

/**
 * 合并时**旧侧**（0.9x）的取数结果。
 *
 * 比 {@link MergeNewSide} 多一个 `filesById`：新侧的文件数由扫描器按目录精确汇总，
 * 而旧侧一个会话是「一个 SessionFile + 归因到它的若干存档条目」，两者在物理上不相邻，
 * 只能按会话给出。合并要把「被新格式取代的那些旧会话」从计量里剔除（Req 6.7），
 * 剔除的同时也得把它们的文件数一并挪到 LegacyResidue，故文件数必须**按会话**可分。
 */
export interface MergeOldSide {
  rows: readonly RankingRow[];
  /** sessionId → 该会话计入的文件数（SessionFile 本体 1 个 + 归因存档条目数） */
  filesById: ReadonlyMap<string, number>;
  partial: boolean;
  skippedCount: number;
  /** 被枚举的旧侧根；空数组表示这一侧**未被观测**（目录不存在或不可用） */
  roots: readonly string[];
}

/** 旧侧一个会话在合并层观测到的占用（字节数与文件数同口径）。 */
export interface LegacyResidueSession {
  sessionId: string;
  /** = 该旧会话的 SessionFile 字节数 + 归因到它的存档字节数（self 口径） */
  bytes: number;
  /** = 1（SessionFile）+ 归因存档条目数 */
  files: number;
}

/**
 * 合并过程中观测到的旧数据归属 —— 任务 11.5（getLegacyResidueTotal）的消费接缝。
 *
 * 三个桶按**证据强度**划分，且默认值恒偏保守（`unmigrated`）：
 *
 * | 桶 | 证据 | 对 ProjectSessionTotal 的影响 | 可否进待删集合 |
 * | --- | --- | --- | --- |
 * | `superseded` | 新旧两侧都有同 sessionId（双侧直接观测） | **不计入**（旧份被剔除，Req 6.7） | 可（已迁移仅残留） |
 * | `markedMigrated` | 旧目录里有指向它的 MigrationMarker，但新侧未观测到同 sessionId | 计入（它是这个会话在磁盘上唯一被观测到的一份） | 可（已迁移仅残留） |
 * | `unmigrated` | 无任何迁移证据 | 计入（Req 7.4 的「仅存在于旧目录的未迁移会话」） | **否**（1.x 界面里看不见，删即永久丢失，design D8） |
 *
 * TODO(task 11.5): `getLegacyResidueTotal` 消费本结构时请注意三点 ——
 *   1. 「已迁移仅残留」= `superseded` ∪ `markedMigrated`，「未迁移」= `unmigrated`
 *      （正是 Req 8.6 的两分）。`bothSidesObserved` 为 false 时 `superseded` 不完整
 *      （新侧没看全，双侧证据无从建立），此时**只能**由 MigrationMarker 一侧的证据定案，
 *      不得把「没看到新份」当成「未迁移」的正面证据来扩大待删集合。
 *   2. 本结构的字节数/文件数是**合并层的观测值**（旧侧 SessionFile + 归因存档），
 *      不是 Req 8.1 定义的旧残留全量（那还包括 `<oldStoreRoot>/<workspaceId>` 下无归因的
 *      快照与清单）。11.5 自己扫目录得出权威数值，这里的数值只用于对账与 tooltip。
 *   3. `markedMigrated` 的会话同时出现在 ProjectSessionTotal 与「已迁移仅残留」里
 *      （见上表），这是刻意的：把它从 ProjectSessionTotal 里也剔掉，会让「标记在、
 *      新份没观测到」的会话在排行页与合计里同时消失，用户反而找不到这份占空间的数据。
 *      两个维度本就相互独立（Req 8.2、8.7），重叠需在文案里说明而不是靠丢数据回避。
 */
export interface LegacyResidueAttribution {
  /** 旧份被新格式取代、已从会话占用里剔除（Req 6.7 / design D7） */
  superseded: LegacyResidueSession[];
  /** 旧侧自带迁移证据（当前唯一来源是 MigrationMarker）但新侧未观测到同 sessionId */
  markedMigrated: LegacyResidueSession[];
  /** 无任何迁移证据 → 默认「未迁移」，恒不进待删集合 */
  unmigrated: LegacyResidueSession[];
  /**
   * 新旧两侧是否都被观测到。false 表示 `superseded` 的判定证据不全
   * （只可能漏判、不可能误判：漏判的后果是那份旧数据留在原处，不会被删）。
   */
  bothSidesObserved: boolean;
}

/**
 * 双布局合并后的排行取数结果（`both` / `new-only` / `old-only` 共用同一形状）。
 *
 * 三条恒等式由 {@link mergeRankingRows} 的**构造方式**保证，而非事后校验：
 *   - `sessionCount === rows.length`
 *   - `totalBytes === Σ rows[i].totalBytes`
 *   - `totalBytes === sessionBytes + attachmentBytes`
 */
export interface MergedRankingRows {
  /** 合并去重后的行（同 sessionId 只留新格式那份），未排序未分页 */
  rows: RankingRow[];
  /** Σ 各会话自身口径占用 = ProjectSessionTotal 的字节数 */
  totalBytes: number;
  /** 其中「会话本体」部分（Σ `jsonBytes`），供 tooltip 的字节数拆解（Req 7.11） */
  sessionBytes: number;
  /** 其中「快照 / 附件」部分（Σ `archiveBytesSelf`），同上 */
  attachmentBytes: number;
  /** 参与统计的文件数合计 */
  files: number;
  /** 参与统计的会话数（去重后） */
  sessionCount: number;
  /** 任一侧存在跳过条目或被取消时为 true，表示各数值为下限 */
  partial: boolean;
  skippedCount: number;
  /** 被统计的根路径（新侧在前），供 tooltip 说明数值来自何处 */
  roots: string[];
  /** 本次合并实际**观测到**的侧；两侧皆 false 即没有任何可用数据 */
  sides: { newLayout: boolean; oldLayout: boolean };
  /** 旧数据归属（任务 11.5 的接缝） */
  residue: LegacyResidueAttribution;
}

/**
 * 旧残留清理的**待删文件清单**（Requirement 11.2、11.3）。
 *
 * 与 {@link LegacyResidueTotal} 分开返回，而不是给那个类型加一个数组字段：那是个会被
 * 缓存、被渲染、被 tooltip 反复读取的聚合值，塞进几百条路径会让每次读取都拖着一份大对象；
 * 而清理入口只在用户真的要删时才需要清单。
 *
 * `files` **只含有正面迁移证据的旧会话文件**（新目录有同 sessionId 的会话目录，或旧目录
 * 有指向它的 MigrationMarker）。「未迁移或无法按会话归属」的部分恒不在这里，只以
 * `excluded*` 的形式给出数量——那部分在 1.x 界面里看不见，删了不可恢复（design D8），
 * 因此它连**进入清单**的机会都没有，而不是靠下游过滤掉。
 */
export interface LegacyResidueTargets {
  /** 待删文件及其字节数 / mtime 快照（供清理侧做 TOCTOU 复核） */
  files: Array<{ path: string; size: number; mtimeMs: number }>;
  /** `files` 的字节数合计 */
  bytes: number;
  /** 被排除的「未迁移或无法按会话归属」字节数（Req 11.3 要求单独列出） */
  excludedBytes: number;
  /** 被排除的文件数 */
  excludedFiles: number;
}

/** {@link LegacyResidueSession} 列表的字节数与文件数合计（纯函数）。 */
export function sumLegacyResidueSessions(
  sessions: readonly LegacyResidueSession[]
): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const s of sessions) {
    bytes += safeBytes(s.bytes);
    files += safeBytes(s.files);
  }
  return { bytes, files };
}

/**
 * 纯函数（零 IO）：把新旧两侧的排行取数合并成一份行集合与一份聚合数值
 * （Requirement 6.7、7.4，设计决策 D7）。
 *
 * **同 sessionId 双份时新格式是唯一来源**：新侧的行先进一个以 sessionId 为键的 Map，
 * 旧侧只在键未被占用时才进。因此
 *
 *   「每个会话在 ProjectSessionTotal 中恰好被计入一次」
 *
 * 是 Map 键唯一性的直接结果 —— 合计与会话数都由**同一个** Map 的单次遍历得出
 * （`sessionCount = map.size = rows.length`），不存在「两处各累加一次」或
 * 「先重复计入再去重」的可能，也不需要靠断言去事后保证。
 *
 * 被顶掉的旧份不是简单丢弃，而是记入 `residue.superseded`：那份数据仍在磁盘上占空间，
 * 只是它的字节数按 D7 归给 LegacyResidue 而不再计入该会话的 SessionFootprint。
 * 副作用是排行页显示的**单会话**占用小于该会话在磁盘上的实际总和。
 *
 * TODO(task 12.1): 上述副作用必须在 tooltip 里说清楚，否则用户会把「删了这个会话能省
 * 多少」算错。所需数据已在本结构里备齐：`residue.superseded` 给出被剔除的 sessionId
 * 与字节数（可按 sessionId 精确到某一行），`sides` 说明当前是不是 `both`（只有 `both`
 * 才可能出现被剔除的旧份），`sessionBytes` / `attachmentBytes` 给出两部分拆解。
 * 建议的说明口径：「该会话另有 N 字节旧格式残留未计入本行，可在旧残留维度查看与清理」。
 *
 * **SessionOrigin 在这一层补齐 `presentInOtherSide`**：旧侧取数
 * （`collectRankingRows`）只看得见一个旧目录、新侧取数只看得见一个新目录，
 * 「另一侧也有同 sessionId」这个事实只有合并层能观测到。故新侧留下的行在这里重判一次
 * （Req 9.8：`both` 下同 sessionId 恒为 `migrated`，Property 9 钉住）。
 * 留下的旧侧行**无需**重判：它们能留下正说明新侧没有同 sessionId，
 * `presentInOtherSide` 恒为 false，重判必然得到与旧侧取数相同的结论。
 *
 * 两侧的行都是 `self` 口径（新侧见 {@link computeNewSessionFootprint}，旧侧见
 * `collectRankingRows`），故跨侧相加有意义；且两侧的路径范围天然不相交
 * （不同根目录），不存在同一份文件被两侧各计一次的情形。
 */
export function mergeRankingRows(
  newSide: MergeNewSide,
  oldSide: MergeOldSide
): MergedRankingRows {
  // 唯一的行容器。键唯一 ⇒「每个会话恰好一行」，这是本函数全部计量的构造性基础
  const byId = new Map<string, RankingRow>();

  // 先备好另一侧的 sessionId 集合：新侧行的 SessionOrigin 要用它重判（Req 9.8）
  const oldIds = new Set<string>();
  for (const row of oldSide.rows) oldIds.add(row.sessionId);

  const newIds = new Set<string>();
  for (const row of newSide.rows) {
    if (newIds.has(row.sessionId)) continue; // 新侧内部同名（理论上不会：目录名唯一）只取首份
    newIds.add(row.sessionId);
    byId.set(row.sessionId, {
      ...row,
      origin: determineSessionOrigin({
        sessionId: row.sessionId,
        source: 'new',
        presentInOtherSide: oldIds.has(row.sessionId),
      }),
    });
  }

  const superseded: LegacyResidueSession[] = [];
  const markedMigrated: LegacyResidueSession[] = [];
  const unmigrated: LegacyResidueSession[] = [];
  const oldSeen = new Set<string>();
  let oldFiles = 0;

  for (const row of oldSide.rows) {
    // 文件数缺记录时按 1 计（至少有 SessionFile 本体这一个文件），不按 0 计：
    // 0 会让「文件数」在旧侧凭空缩水，而这个数字要参与 LegacyResidue 的对账
    const observed: LegacyResidueSession = {
      sessionId: row.sessionId,
      bytes: safeBytes(row.totalBytes),
      files: oldSide.filesById.get(row.sessionId) ?? 1,
    };

    // 判据取「新侧是否有这个 sessionId」而不是「byId 里已有这一行」：后者在旧侧自身带
    // 重复份时会把第二份误判成「被新格式取代」，从而让一份**未迁移**的数据落进
    // 「已迁移仅残留」——那正是旧残留清理敢删的桶（design D8），偏差方向不可接受
    if (newIds.has(row.sessionId)) {
      // 新格式已是该会话的唯一来源：旧份不出行、不计入占用，转记 LegacyResidue（D7）
      superseded.push(observed);
      continue;
    }
    // 旧侧内部的重复份（同一工作区的多个编码变体目录各有一份）只取首份成行。
    // 上游 `oldRowsSnapshot` 已按 sessionId 去过重，这里是纯函数被直接调用时的护栏：
    // 不成行、不计量、也不进任何残留桶（无证据的数据恒不进待删集合）
    if (oldSeen.has(row.sessionId)) continue;
    oldSeen.add(row.sessionId);

    // 旧侧取数把「有 MigrationMarker 指向它」判为 `migrated`（`collectRankingRows` 的
    // 注释给出了这条唯一路径）。这里据此分桶而不重新读盘：合并层没有 fs 依赖，
    // 也不该为了复核一个已被下游 11.5 权威重扫的结论再去枚举一次目录。
    (row.origin === 'migrated' ? markedMigrated : unmigrated).push(observed);

    byId.set(row.sessionId, row);
    oldFiles += observed.files;
  }

  // 单次遍历同时得出行集合与全部聚合数值：合计与会话数因此恒出自同一个容器
  const rows: RankingRow[] = [];
  let totalBytes = 0;
  let sessionBytes = 0;
  let attachmentBytes = 0;
  for (const row of byId.values()) {
    rows.push(row);
    sessionBytes += safeBytes(row.jsonBytes);
    attachmentBytes += safeBytes(row.archiveBytesSelf);
    totalBytes += safeBytes(row.totalBytes);
  }

  const sides = {
    newLayout: newSide.roots.length > 0,
    oldLayout: oldSide.roots.length > 0,
  };

  return {
    rows,
    totalBytes,
    sessionBytes,
    attachmentBytes,
    files: safeBytes(newSide.files) + oldFiles,
    sessionCount: rows.length,
    partial: newSide.partial || oldSide.partial,
    skippedCount: safeBytes(newSide.skippedCount) + safeBytes(oldSide.skippedCount),
    roots: dedupePaths([...newSide.roots, ...oldSide.roots]),
    sides,
    residue: {
      superseded,
      markedMigrated,
      unmigrated,
      bothSidesObserved: sides.newLayout && sides.oldLayout,
    },
  };
}

/** 按规范化路径去重并保持首次出现的顺序（新侧根在前）。 */
function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const key = path.normalize(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 纯函数（零 IO）：把一次合并结果聚合成 ProjectSessionTotal（Requirement 7.2、7.3、7.4）。
 *
 * **「不为该维度额外发起目录枚举」由类型保证**：本函数只吃
 * {@link MergedRankingRows}，没有 fs 依赖、没有 `this`，因此它在结构上就不可能枚举目录。
 * 排行页（任务 12.1）拿到一次 {@link StorageAnalyzer.getMergedRankingRows} 的结果后，
 * 把同一个对象喂进来即得该维度数值 —— 排行行与 ProjectSessionTotal 恒来自**同一次**枚举
 * （Req 7.3）。`StorageAnalyzer.getProjectSessionTotal` 只是它的便利封装。
 *
 * 字段口径：
 * - `bytes` / `sessionCount`：Req 7.2 要求的两个数值，由合并层的单一 Map 得出，
 *   每个会话恰好计入一次（Req 7.4）
 * - `workspaceCount`：单工作区维度，观测到任一侧即为 1；两侧都不可用时为 0
 *   （而不是 1 —— 那会让 tooltip 说「统计了 1 个工作区目录」却给不出任何根路径）
 * - `state`：`ok` / `unavailable` 二者之一。本维度**随排行数据一同下发**、无手动触发，
 *   故不会出现 `idle`；`loading` 是 UI 侧的过渡态，不由取数层给出
 * - `partial` / `skippedCount`：任一侧有跳过即为下限值，UI 据此加 `≥` 前缀（Req 7.12）
 */
export function projectSessionTotalFrom(merged: MergedRankingRows): AggregateTotal {
  const observed = merged.sides.newLayout || merged.sides.oldLayout;
  return {
    state: observed ? 'ok' : 'unavailable',
    bytes: merged.totalBytes,
    files: merged.files,
    sessionCount: merged.sessionCount,
    workspaceCount: observed ? 1 : 0,
    partial: merged.partial,
    skippedCount: merged.skippedCount,
    roots: [...merged.roots],
  };
}

/* ------------------------------------------------------------------ *
 * 1d. 聚合维度的空闲态占位值
 * ------------------------------------------------------------------ */

/**
 * 尚未被用户触发的聚合维度占位值（Requirement 7.8）。
 *
 * `state: 'idle'` 与各数值恒 0 是**成对**的约定：`idle` 意味着「一次枚举都还没发生」，
 * 此时 0 不是统计结论。渲染层据此展示未统计提示而不是「0 B」——后者会被读成
 * 「已统计且确实为空」。
 *
 * 之所以由取数层给出而不是让渲染层自己造一个零值对象：`AggregateTotal` 有 8 个字段，
 * 渲染层每处各造一份，早晚会出现某处漏写 `partial` 或把 `state` 写成 `'ok'`。
 */
export function idleAggregateTotal(): AggregateTotal {
  return {
    state: 'idle',
    bytes: 0,
    files: 0,
    sessionCount: 0,
    workspaceCount: 0,
    partial: false,
    skippedCount: 0,
    roots: [],
  };
}

/** 尚未被用户触发的旧残留维度占位值（Requirement 8.4）；语义同 {@link idleAggregateTotal}。 */
export function idleLegacyResidueTotal(): LegacyResidueTotal {
  return {
    ...idleAggregateTotal(),
    migratedResidueBytes: 0,
    migratedResidueFiles: 0,
    unmigratedBytes: 0,
    unmigratedFiles: 0,
  };
}

/* ------------------------------------------------------------------ *
 * 2. StorageAnalyzer 类
 * ------------------------------------------------------------------ */

/**
 * 可注入的只读文件系统依赖：`ScannerFsDeps`（readdir / lstat / yieldNow）与
 * `OrphanFsDeps` / `RankingFsDeps`（readdir / stat / readFile）的并集。
 *
 * 之所以在 analyzer 这一层收成**一个**对象再向下分发：三个下游模块各自的依赖形状
 * 不同，但一次统计里它们必须看到同一个文件系统视图。让调用方分别注入三份，
 * 就可能出现「scanner 走假 fs、orphan 走真 fs」的夹具，统计结果无从解释；
 * 同时也让 Property 14(a) 的调用面断言只需要盯住这一个注入点。
 *
 * 缺省退回 `fs/promises` 的四个读 API，生产路径无额外抽象开销。
 */
export interface AnalyzerFsDeps {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<DirentLike[]>;
  lstat: (p: string) => Promise<StatLike>;
  stat: (p: string) => Promise<StatLike>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
  /** 让出事件循环；测试注入计数器验证让出频率 */
  yieldNow?: () => Promise<void>;
}

/**
 * 1.x 布局下本次统计需要的两个目录。
 *
 * 字段是 `LayoutRoots`（`src/layout.ts`）的子集且同名，因此任务 15.2 可以把
 * `detectLayout()` 的返回值**原样**传进来（结构化类型匹配），无需在接线处摘字段。
 * 这里刻意只声明用得到的两项、也刻意不 `import type { LayoutRoots }`：占用统计不需要
 * 知道旧侧根与 `layout` 结论，窄接口让「analyzer 依赖 layout 模块」这条边不必存在。
 */
export interface NewLayoutDirs {
  /** `~/.kiro`：1.x 分类根由它派生（`buildNewClassifyRoots`） */
  homeKiroDir: string | null;
  /** `<newSessionsRoot>/<WsHash16>`：当前工作区在 1.x 下的会话目录 */
  newWorkspaceSessionDir: string | null;
  /**
   * `~/.kiro/sessions`：**全部**工作区会话目录的公共根，AllKiroSessionTotal 的扫描起点
   * （Requirement 7.6）。
   *
   * 可选，因此既有注入方（只给前两个字段）无需改动。省略时由 `homeKiroDir` 现派生
   * （`buildNewClassifyRoots`）；给出时优先，使 `detectLayout` 已做过存在性校验的那个根
   * 与统计使用的根恒为同一份 —— 派生值只是路径拼接，不含「它此刻确实存在」这个信息。
   */
  newSessionsRoot?: string | null;
}

export interface AnalyzerDeps {
  pathResolver?: PathResolverDeps;
  workspacePath?: string | null;
  /**
   * 1.x 布局根的注入点（LayoutDetector 的产出）。
   *
   * 省略时本类经 PathResolver 自行解析 `~/.kiro` 与 `<sessions>/<WsHash16>`，
   * 因此既有调用方无需改动即可获得新布局取数能力；任务 15.2 会把 `detectLayout()`
   * 的结果贯通进来，使一次会话里「布局检测看到的根」与「统计使用的根」恒为同一份。
   */
  newLayout?: NewLayoutDirs;
  /** 只读 fs 注入点；缺省退回 `fs/promises` */
  fsDeps?: AnalyzerFsDeps;
  /** 时钟注入点，供 StorageCache 的 60 秒有效期测试；缺省 `Date.now` */
  now?: () => number;
  /**
   * ArchiveIndex 快照来源；缺省 `listArchiveEntries`（含既有 4 秒节流）。
   * 注入点只为测试提供确定的存档集合，**不**改变节流策略：`force` 只绕过
   * StorageCache，绝不绕过 ArchiveIndex 的 4 秒窗口（Req 7.9、7.10）。
   */
  listArchives?: (storeRoot: string, opts: { workspacePath?: string }) => ArchiveInfo[];
}

export interface SummaryOptions {
  /** 忽略 StorageCache 的 60 秒有效期（Req 7.10：全部用户显式动作都传 true） */
  force?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (msg: string) => void;
}

/** StorageCache 有效期（Req 7.5）。 */
export const STORAGE_CACHE_TTL_MS = 60_000;

/** 祖先链失效的步数上限：防御性护栏，正常路径远达不到（Req 14.13）。 */
const MAX_ANCESTOR_STEPS = 64;

const realAnalyzerFs: AnalyzerFsDeps = {
  readdir: (p, o) => readdir(p, o) as unknown as Promise<DirentLike[]>,
  lstat: (p) => lstat(p) as unknown as Promise<StatLike>,
  stat: (p) => stat(p) as unknown as Promise<StatLike>,
  readFile: (p, enc) => readFile(p, enc),
};

/** 当前工作区在磁盘上的两处落点（已确认存在，可能各有多个编码变体）。 */
interface WorkspaceDirs {
  /** `<SessionsRoot>/<EncodedKey>` */
  sessionDirs: string[];
  /** `<StoreRoot>/<WorkspaceId>` */
  execDirs: string[];
}

/**
 * 一次统计的完整取数快照。StorageCache 缓存的是**它**而不只是 `summary`：
 * `getReportData` 需要 `live.byWorkspace` 与 `archives` 才能组装报告，
 * 若只缓存 summary，一次报告就会把目录枚举与清单解析重做一遍，
 * 「60 秒内不重新枚举目录」（Req 7.5）就只对 SummaryBar 成立。
 */
interface Snapshot {
  summary: StorageSummary;
  roots: ClassifyRoots | null;
  live: LiveSessionsResult | null;
  archives: readonly ArchiveInfo[];
  workspaceDirs: WorkspaceDirs;
  /** 被取消打断的快照不入 StorageCache（残缺值不该被当成 60 秒内的权威结果） */
  cancelled: boolean;
}

interface RowsResult {
  rows: RankingRow[];
  partial: boolean;
  skippedCount: number;
}

/**
 * 一次 0.9x 排行取数的**内部**快照：`RowsResult` 加上合并层需要的两项。
 *
 * 之所以让缓存持有它、而让 `getRankingRows()` 只回其中三个字段：`RowsResult` 是已上线的
 * 对外形状（`RankingPanelDeps` 与既有测试都按那三个字段用），扩展它会波及排行页接线；
 * 而 `both` 布局的合并需要「旧侧被枚举的根」（tooltip 要给出被统计路径、`sides` 要据此
 * 判断这一侧是否被观测到）与「每个会话的文件数」（被新格式取代的旧份要连文件数一起
 * 挪进 LegacyResidue）。两者都在取数时顺手可得，事后再补就得重新枚举一遍目录 ——
 * 而 Req 7.3 恰恰不允许为聚合维度额外发起枚举。
 */
interface OldRowsSnapshot {
  rows: RankingRow[];
  /** sessionId → 该会话计入的文件数（SessionFile 本体 1 个 + 归因存档条目数） */
  filesById: Map<string, number>;
  partial: boolean;
  skippedCount: number;
  /** 存在且被枚举的 `<SessionsRoot>/<EncodedKey>`（同一工作区可能有多个编码变体） */
  roots: string[];
  /** 被取消打断的快照不入 StorageCache（残缺值不该被当成 60 秒内的权威结果） */
  cancelled: boolean;
}

/**
 * 新布局（1.x）一次排行取数的结果。
 *
 * 除 `rows` 外还带 `footprints` 与聚合数字，是为了让「排行页取数」与
 * 「ProjectSessionTotal」共用**同一次**枚举（Requirement 7.3 明确要求该维度不额外
 * 发起目录枚举）：{@link mergeRankingRows} 直接消费这里的行与聚合数字，
 * {@link projectSessionTotalFrom} 再从合并结果聚合出该维度，全程不回磁盘。
 */
export interface NewRowsResult {
  /** 每个 NewSessionDir 一行（Requirement 6.8），未排序未分页 */
  rows: RankingRow[];
  /** 各会话的自身口径占用，顺序与 `rows` 一致；`additive: true` 故可相加 */
  footprints: SessionFootprint[];
  /** Σ 各会话 SessionFootprint 的合计，恒等于 Σ `rows[i].totalBytes` */
  totalBytes: number;
  /** 参与统计的文件数合计 */
  files: number;
  /** 参与统计的会话数，恒等于 `rows.length` */
  sessionCount: number;
  /** 存在跳过条目或被取消时为 true，表示各数值为下限 */
  partial: boolean;
  skippedCount: number;
  /** 被枚举的根（当前工作区的 NewWorkspaceSessionDir），供 tooltip 说明数值来自何处 */
  roots: string[];
}

/** 返回副本：缓存对象直接外泄会让调用方的就地改写污染后续 60 秒内的所有读取。 */
function cloneSummary(s: StorageSummary): StorageSummary {
  return {
    ...s,
    categories: s.categories.map((c) => ({ ...c })),
    orphan: { ...s.orphan },
  };
}

function cloneOldRows(r: OldRowsSnapshot): OldRowsSnapshot {
  return {
    ...r,
    rows: r.rows.map((row) => ({ ...row })),
    filesById: new Map(r.filesById),
    roots: [...r.roots],
  };
}

/** 空的 0.9x 取数快照（UserDataDir 不可用 / 无工作区 / 取数整体失败时返回）。 */
function emptyOldRows(): OldRowsSnapshot {
  return {
    rows: [],
    filesById: new Map(),
    partial: false, // 「目录不存在」不是跳过条目（与 `emptyNewRows` 同一取舍）
    skippedCount: 0,
    roots: [],
    cancelled: false,
  };
}

/**
 * 归因到各会话的存档**条目数**（`self` 口径的集合级伴生量，纯函数）。
 *
 * 与 {@link computeSessionFootprint} 的 `self` 口径共用同一判据：`hasOwner` 过滤 +
 * `chatSessionId` 区分大小写严格相等。因此对任一会话恒有
 * `count > 0 ⟺ footprint.archivesFound`，且每个存档条目最多被计入一个会话
 * （`chatSessionId` 唯一），跨会话求和不会重复。
 *
 * 单独成一个函数而不是让 `computeSessionFootprint` 多返回一个字段：那个返回值形状
 * （`SessionFootprint`）是已上线的对外契约，加字段会波及既有调用方与测试断言。
 */
function archiveFileCountsByOwner(archives: readonly ArchiveInfo[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of archives) {
    if (!hasOwner(a.chatSessionId)) continue;
    const id = a.chatSessionId as string;
    out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/** 返回副本：缓存对象直接外泄会让调用方就地改写 `roots` 污染后续所有读取。 */
function cloneAggregate(t: AggregateTotal): AggregateTotal {
  return { ...t, roots: [...t.roots] };
}

function cloneLegacyResidue(t: LegacyResidueTotal): LegacyResidueTotal {
  return { ...t, roots: [...t.roots] };
}

/**
 * `state: 'unavailable'` 的聚合维度值：对应根不存在 / 不可读 / 取数整体失败。
 *
 * 与 `idle` 的区别只在 `state`，数值同为 0——但两者对用户的含义完全不同
 * （「还没统计」vs「统计不了」），故渲染层必须按 `state` 分支而不是看数值是否为 0。
 */
function unavailableAggregate(): AggregateTotal {
  return { ...idleAggregateTotal(), state: 'unavailable' };
}

function unavailableLegacyResidue(): LegacyResidueTotal {
  return { ...idleLegacyResidueTotal(), state: 'unavailable' };
}

/** 空的待删清单：维度不可用时返回它，使调用方拿到的恒是「一个都不能删」而不是 `undefined`。 */
function emptyResidueTargets(): LegacyResidueTargets {
  return { files: [], bytes: 0, excludedBytes: 0, excludedFiles: 0 };
}

/** 返回副本：清单直接外泄会让调用方就地改写污染缓存，而它决定的是**删哪些文件**。 */
function cloneResidueTargets(t: LegacyResidueTargets): LegacyResidueTargets {
  return { ...t, files: t.files.map((f) => ({ ...f })) };
}

/**
 * 一次聚合维度扫描的累加器（内部形状）。
 *
 * `workspaceCount` 记的是**实际被枚举**的工作区目录数，而不是根下的条目数：
 * 不可枚举的目录只增 `skippedCount`，不算「参与了统计」，否则 tooltip 会说
 * 「统计了 7 个工作区目录」而其中一个的字节数根本没进来。
 */
interface AggregateAcc {
  bytes: number;
  files: number;
  sessionCount: number;
  workspaceCount: number;
  skippedCount: number;
  cancelled: boolean;
}

function emptyAcc(): AggregateAcc {
  return {
    bytes: 0,
    files: 0,
    sessionCount: 0,
    workspaceCount: 0,
    skippedCount: 0,
    cancelled: false,
  };
}

/** 把累加器折成对外的 {@link AggregateTotal}。 */
function accToAggregate(acc: AggregateAcc, roots: readonly string[]): AggregateTotal {
  return {
    state: 'ok',
    bytes: acc.bytes,
    files: acc.files,
    sessionCount: acc.sessionCount,
    workspaceCount: acc.workspaceCount,
    partial: acc.skippedCount > 0 || acc.cancelled,
    skippedCount: acc.skippedCount,
    roots: [...roots],
  };
}

/**
 * 0.9x 会话文件名判定：`.json` 结尾，且不是清单、不是迁移标记。
 *
 * 与 `layout.ts` 的 `isOldSessionFileName`、`ranking.ts` 枚举时的排除规则同一口径。
 * 三处各自持有一份十行判定而不提成公共 API：`layout.ts` 是路径层的下游、
 * `ranking.ts` 走注入的异步 fs、本处只需要「数会话个数」，把它们统一到一个模块
 * 反而会让 analyzer 反向依赖 layout。真正需要同口径的是「清单与标记不是会话」，
 * 这一点由三处的注释与同一份文件名格式约束住。
 */
function isOldSessionFileName(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  if (name === MANIFEST_FILENAME) return false;
  return !isMigrationMarkerFileName(name);
}

/** WorkspaceId 目录名形态（`hash32` 的输出）：sha256 十六进制前 32 位，小写。 */
const WORKSPACE_ID_DIR = /^[0-9a-f]{32}$/;

/** 一个被枚举到的文件：名字用于形态判定，绝对路径用于取字节数。 */
interface ListedFile {
  name: string;
  full: string;
}

/** {@link StorageAnalyzer.listDirEntries} 的返回形状。 */
interface ListedDir {
  /** 目录是否被成功枚举；`false` 时两个数组恒为空且 `skippedCount` 为 1 */
  readable: boolean;
  /** 子目录的绝对路径 */
  dirs: string[];
  /** 直接子文件 */
  files: ListedFile[];
  skippedCount: number;
}

/** 一次聚合维度取数的内部结果：`state` 与残缺标记与数值分开，便于决定是否入缓存。 */
interface AggregateOutcome<T extends AggregateTotal> {
  state: 'ok' | 'unavailable';
  total: T;
  cancelled: boolean;
}

function cloneNewRows(r: NewRowsResult): NewRowsResult {
  return {
    ...r,
    rows: r.rows.map((row) => ({ ...row })),
    footprints: r.footprints.map((fp) => ({ ...fp })),
    roots: [...r.roots],
  };
}

/**
 * 单个 NewSessionDir 的扫描产物。
 *
 * 判别联合而非「带 `cancelled` 标记的完整对象」：被取消打断的扫描没有可用的数值，
 * 编译器因此不允许调用方在未判 `cancelled` 前读 `row` / `footprint`，
 * 「偏低的部分数值被当成完整结果出行」这个错误在类型层就被堵住。
 */
type ScannedNewSession =
  | { cancelled: true }
  | {
      cancelled: false;
      row: RankingRow;
      footprint: SessionFootprint;
      files: number;
      skippedCount: number;
    };

/** 空的新布局取数结果（无新布局根 / 无工作区 / 取数整体失败时返回）。 */
function emptyNewRows(): NewRowsResult {
  return {
    rows: [],
    footprints: [],
    totalBytes: 0,
    files: 0,
    sessionCount: 0,
    // 「目录不存在」不是跳过条目：把它算成跳过会让空态凭空挂上 `skippedCount: 1`
    // 并给两个字节列加上 `≥`（与 `getRankingRows` 的同一取舍）
    partial: false,
    skippedCount: 0,
    roots: [],
  };
}

/** 按固定展示顺序把扫描合计摊成 `CategoryStat[]`（7 个分类恒齐全）。 */
function toCategories(totals: CategoryTotals): CategoryStat[] {
  return CATEGORY_ORDER.map((category) => {
    const meta = CATEGORY_META[category];
    const agg = totals[category];
    const stat: CategoryStat = {
      category,
      label: meta.label,
      pathHint: meta.pathHint,
      bytes: agg.bytes,
      files: agg.files,
    };
    if (meta.note) stat.note = meta.note;
    return stat;
  });
}

/**
 * `status: 'unavailable'` 的 StorageSummary（Req 1.2、9.3）。
 *
 * 数值一律为 0、`categories` 为空数组：没有任何一次枚举发生过，给出零填充的分类
 * 明细会让 tooltip 展示出「各分类均为 0」这种看起来像统计结论的东西。
 * 孤儿状态取 `pending`（待判定）而不是 `ok`——`ok` 会被读成「已判定且为 0」。
 */
function unavailableSummary(now: number, userDataDir: string | null): StorageSummary {
  return {
    status: 'unavailable',
    userDataDir,
    totalBytes: 0,
    totalFiles: 0,
    categories: [],
    currentWorkspaceBytes: 0,
    projectFootprintTotal: 0,
    orphan: { state: 'pending', bytes: 0, files: 0, note: ORPHAN_NOTE },
    partial: false,
    skippedCount: 0,
    sessionCount: 0,
    sizeNote: SIZE_NOTE,
    scannedAt: now,
  };
}

function unavailableSnapshot(now: number, userDataDir: string | null): Snapshot {
  return {
    summary: unavailableSummary(now, userDataDir),
    roots: null,
    live: null,
    archives: [],
    workspaceDirs: { sessionDirs: [], execDirs: [] },
    cancelled: false,
  };
}

/**
 * StorageAnalyzer：把 PathResolver、SizeScanner、LiveSessionIds 采集、ArchiveIndex
 * 快照与归因纯函数接成一次完整统计，并持有两级缓存。
 *
 * **两级缓存各管一件事**：
 * - StorageCache（本类持有的 `snapshotCache` / `rowsCache`）缓存**整次统计的结果**，
 *   TTL 60 秒；`force !== true` 且未过期即直接返回，不发生任何目录枚举（Req 7.5）。
 * - SubtreeCache（按扫描根各持一个实例）缓存**每个目录的子树聚合**，以
 *   `(mtimeMs, 直接子条目数)` 失效，使未变化的子树在重复统计中被复用（Req 7.6）。
 *
 * 为什么 SubtreeCache 是 `Map<root, SubtreeCache>` 而不是一个实例：`ScanOptions.cache`
 * 的不变式是「同一实例只服务同一组 `(root, maxDepth)`」。本类除了扫 UserDataDir，
 * 还要单独扫当前工作区的两处目录来算 `currentWorkspaceBytes`，同一个目录在两次扫描里
 * 落在不同深度上、剩余深度预算不同，共用一个实例会让深层子树的聚合被错误复用。
 *
 * `force` 的边界（Req 7.9、7.10）：它只绕过 StorageCache，**不**绕过 ArchiveIndex 的
 * 4 秒节流——存档索引的刷新策略仍归 `credits.ts` 所有，本类只消费其只读快照，
 * 因此连续两次 force 统计在 4 秒内看到的是同一份存档集合。
 *
 * 只读约束：本类的全部磁盘访问都经 `AnalyzerFsDeps` 的四个读 API 与 PathResolver 的
 * 存在性判断，模块内不存在任何写 API 的导入（Property 14(a)）。
 */
export class StorageAnalyzer {
  private readonly deps: AnalyzerDeps;
  private readonly fs: AnalyzerFsDeps;
  /** 按扫描根隔离的子树聚合缓存（见类注释关于不变式的说明） */
  private readonly subtreeCaches = new Map<string, SubtreeCache>();
  private snapshotCache: { snapshot: Snapshot; scannedAt: number } | null = null;
  private rowsCache: { value: OldRowsSnapshot; scannedAt: number } | null = null;
  private newRowsCache: { value: NewRowsResult; scannedAt: number } | null = null;
  /**
   * AllKiroSessionTotal / LegacyResidueTotal 的缓存。
   *
   * 与上面三个缓存的**关键差别：不带 60 秒 TTL**（Requirement 7.6、8.5 只要求
   * 「缓存以供后续复用」）。这两个维度是手动触发的重量级扫描——本机实测旧残留约
   * 3.6 GB / 7735 文件——给它们套 60 秒有效期等于「每次点开面板过一分钟再看就重扫一遍」，
   * 与「手动触发」的初衷相反。失效由 {@link invalidateForDeletedFiles}（一次清理之后，
   * Req 7.13、8.8）与 {@link clearCache} 负责，那才是数值真会变的时刻。
   */
  private allTotalCache: AggregateTotal | null = null;
  private legacyResidueCache: LegacyResidueTotal | null = null;
  /**
   * 与 `legacyResidueCache` **同一次扫描**产出的待删清单（Req 11.2、11.3）。
   *
   * 两者必须同源：清理确认提示上写的「将释放 X 字节」来自聚合值，而实际删的是这份清单。
   * 若清单来自另一次扫描，两个数字就可能对不上，用户看到的承诺与实际发生的事情不一致。
   * 因此它们由 {@link computeLegacyResidueTotal} 一次算出、一起入缓存、一起被
   * {@link invalidateForDeletedFiles} 打掉。
   */
  private legacyResidueTargetsCache: LegacyResidueTargets | null = null;

  constructor(deps: AnalyzerDeps = {}) {
    this.deps = deps;
    this.fs = deps.fsDeps ?? realAnalyzerFs;
  }

  /* ---------------- 公开 API ---------------- */

  /**
   * 汇总统计。命中 StorageCache（60 秒内且非 `force`）时直接返回缓存副本，
   * 不发生任何目录枚举；UserDataDir 为 `null` 或统计整体失败时返回
   * `status: 'unavailable'` 且**不抛异常**（Req 1.2、9.2、9.3）。
   */
  async getSummary(opts: SummaryOptions = {}): Promise<StorageSummary> {
    const snapshot = await this.snapshot(opts);
    return cloneSummary(snapshot.summary);
  }

  /**
   * 报告取数 + 薄封装：排序、截断与渲染全在 `report.ts` 的纯函数里
   * （见该文件头注释的分工说明），本方法只负责把 summary、各工作区明细与
   * 各会话的自身口径占用喂给 `buildReportData`。
   *
   * 报告覆盖**全部**工作区（Req 6.10），因此这里遍历 `live.byWorkspace`：
   * `sessionBytes` 已由采集阶段给出，`execBytes` 需按该工作区解码路径反查
   * `<StoreRoot>/<WorkspaceId>` 再扫一次（解码失败则记 0）。
   */
  async getReportData(opts: SummaryOptions = {}): Promise<StorageReportData> {
    const snapshot = await this.snapshot(opts);
    const summary = cloneSummary(snapshot.summary);
    const roots = snapshot.roots;
    const live = snapshot.live;
    // 聚合维度：ProjectSessionTotal 由排行合并结果聚合（报告是显式动作，允许这次枚举，
    // 且两侧各自的 StorageCache 会让它常常直接命中）；另两个维度只**窥视缓存**，
    // 绝不在报告路径上触发那两次重量级扫描（Req 8.4）
    const aggregates: ReportAggregates = this.peekAggregateTotals();
    try {
      aggregates.project = await this.getProjectSessionTotal(opts);
    } catch {
      // 该维度取不到只让它缺席，不影响报告其余部分
    }

    if (!roots || !live) {
      return buildReportData({ summary, workspaces: [], sessions: [], aggregates });
    }

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const workspaces: ReportWorkspaceInput[] = [];
    const sessions: ReportSessionInput[] = [];

    try {
      for (const info of live.byWorkspace) {
        if (isCancelled()) break;
        const execDirs = info.decodedPath
          ? await this.existingDirs(this.execDirCandidates(roots, info.decodedPath))
          : [];
        workspaces.push({
          dirName: info.dirName,
          decodedPath: info.decodedPath,
          sessionBytes: info.sessionBytes,
          execBytes: await this.sumDirBytes(execDirs, roots, isCancelled),
        });

        const titles = await this.loadManifestTitles(info.dirPath);
        for (const s of info.sessions) {
          const input: ReportSessionInput = {
            sessionId: s.sessionId,
            footprint: computeSessionFootprint(
              { sessionId: s.sessionId, jsonBytes: s.jsonBytes, scope: 'self' },
              snapshot.archives
            ),
          };
          const title = titles.get(s.sessionId);
          if (title !== undefined) input.title = title;
          sessions.push(input);
        }
      }
    } catch {
      // 报告取数是辅助信息：部分工作区取数失败时保留已聚合的部分，
      // 不向调用方抛异常（Req 9.2 的同一策略）
    }

    return buildReportData({ summary, workspaces, sessions, aggregates });
  }

  /**
   * 排行页取数：当前工作区 WorkspaceSessionDir 下的**全部**会话，恒 `self` 口径
   * （Req 13.2、13.4）。取数委托给 `collectRankingRows`，本方法只解析目录、
   * 取 ArchiveIndex 快照并做缓存与合并。
   *
   * 与 `getSummary` 同一套缓存语义：60 秒 TTL、`force: true` 强制重取
   * （排行页的打开与刷新都是显式动作，故恒传 `force: true`，Req 13.12）；
   * 翻页与换序由 `pageOf` / `compareRankingRows` 在已下发的全量数组上完成，
   * 不回到本方法，因此恒不产生目录枚举（Req 7.13）。
   *
   * 当前无工作区、UserDataDir 不可用、或该工作区尚无会话目录时返回空行集合且
   * `partial: false`——「目录不存在」不是跳过条目，把它算成跳过会让空态页脚
   * 挂上一个凭空的 `skippedCount: 1` 并给两列加上 `≥`。
   *
   * 实现委托给 {@link oldRowsSnapshot}（它多带「被枚举的根」与「每会话文件数」两项供
   * `both` 合并使用），本方法只把对外形状收回到 `RowsResult` 的三个字段：这两个字段
   * 是排行页接线与既有测试依赖的契约，不因内部多带信息而变化。
   */
  async getRankingRows(opts: SummaryOptions = {}): Promise<RowsResult> {
    const snapshot = await this.oldRowsSnapshot(opts);
    // `oldRowsSnapshot` 已返回副本，这里再逐字段摘取而不是 `{...snapshot}`：
    // 对外形状恒为这三个键，内部再加字段也不会顺着展开泄漏出去
    return { rows: snapshot.rows, partial: snapshot.partial, skippedCount: snapshot.skippedCount };
  }

  /**
   * 排行页取数（0.9x 旧布局）的内部实现与缓存。见 {@link getRankingRows} 的语义说明；
   * 本方法额外给出 `roots`（被枚举的会话目录）与 `filesById`（每会话文件数），
   * 供 `both` 布局的合并层使用（{@link getMergedRankingRows}）。
   */
  private async oldRowsSnapshot(opts: SummaryOptions): Promise<OldRowsSnapshot> {
    const now = this.clock();
    if (opts.force !== true && this.rowsCache && now - this.rowsCache.scannedAt < STORAGE_CACHE_TTL_MS) {
      return cloneOldRows(this.rowsCache.value);
    }

    const userDataDir = this.resolveUserDataDir();
    const workspacePath = this.workspacePath();
    if (!userDataDir || !workspacePath) return emptyOldRows();

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const progress = this.progressReporter(opts);

    try {
      const roots = buildClassifyRoots(userDataDir);
      const sessionDirs = await this.existingDirs(this.sessionDirCandidates(roots, workspacePath));
      progress('正在读取执行存档索引…');
      const archives = this.listArchives(roots.storeRoot);
      progress('正在统计会话占用…');
      // 存档条目数按归属预先分组：每行的文件数 = SessionFile 本体 1 个 + 归因存档条目数，
      // 与该行 `archiveBytesSelf` 的归因判据严格同口径（见 archiveFileCountsByOwner）
      const archiveFiles = archiveFileCountsByOwner(archives);

      const rows: RankingRow[] = [];
      const filesById = new Map<string, number>();
      let skippedCount = 0;
      let cancelled = false;

      for (const sessionDir of sessionDirs) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }
        const res = await collectRankingRows(
          { sessionDir, storeRoot: roots.storeRoot, workspacePath, archives },
          this.readDeps()
        );
        skippedCount += res.skippedCount;
        // 同一工作区路径的多个编码变体目录都存在时按先到先得去重：
        // 同一 sessionId 出现两次会让「各行可相加」的合计翻倍
        for (const row of res.rows) {
          if (filesById.has(row.sessionId)) continue;
          filesById.set(row.sessionId, 1 + (archiveFiles.get(row.sessionId) ?? 0));
          rows.push(row);
        }
      }

      const result: OldRowsSnapshot = {
        rows,
        filesById,
        partial: skippedCount > 0 || cancelled,
        skippedCount,
        roots: sessionDirs,
        cancelled,
      };
      if (!cancelled) this.rowsCache = { value: result, scannedAt: now };
      return cloneOldRows(result);
    } catch {
      // 取数整体失败：排行页按空列表渲染，面板保持可关闭与可刷新（Req 9.2）
      return emptyOldRows();
    }
  }

  /**
   * 排行页取数（1.x 新布局）：当前工作区 NewWorkspaceSessionDir 下的**每个**
   * NewSessionDir 一行（Requirement 6.8），恒 `self` 口径。
   *
   * 每个会话目录各扫一次（`scanTree` + 注入 `classifyNewPath`），把结果折成
   * 「会话本体 / 附件」两列（{@link newSessionSizes}），再由
   * {@link buildNewRankingRow} 映射成行——列结构、排序与分页规则因此与 0.9x 完全共用
   * （Requirement 6.9）。
   *
   * **行集合以目录为准**，不做条数截断，也**不**沿用 NewFormatReader 的「缺
   * `session.json` / `messages.jsonl` 即跳过该会话」（Req 3.9）：那条规则服务于搜索
   * （读不出内容的会话没什么可搜的），而占用统计要如实反映磁盘——残缺的会话目录
   * 照样占空间，把它从排行页藏起来只会让用户找不到该清理的东西。缺元数据的后果
   * 仅限于标题为空、`mtimeMs` 走回退来源。
   *
   * 与 `getRankingRows` 同一套缓存语义：60 秒 TTL，`force: true` 强制重取
   * （排行页的打开与刷新都是显式动作）。无新布局根、无工作区、或该工作区在 1.x 下
   * 尚无会话目录时返回空结果且 `partial: false`。取数整体失败时同样返回空结果而
   * **不抛异常**（Req 9.2）。
   *
   * 本方法**只看新布局**，返回值恒是「新布局那一侧的完整取数」；`both` 布局下的双布局
   * 合并与残留归属加在它之上（{@link getMergedRankingRows}），故排行页应调用那个入口
   * 而不是本方法 —— 只有需要单看新侧数值时才直接用它。
   */
  async getNewRankingRows(opts: SummaryOptions = {}): Promise<NewRowsResult> {
    const now = this.clock();
    if (
      opts.force !== true &&
      this.newRowsCache &&
      now - this.newRowsCache.scannedAt < STORAGE_CACHE_TTL_MS
    ) {
      return cloneNewRows(this.newRowsCache.value);
    }

    const dirs = this.resolveNewLayoutDirs();
    const workspaceSessionDir = dirs.newWorkspaceSessionDir;
    if (!dirs.homeKiroDir || !workspaceSessionDir) return emptyNewRows();

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const progress = this.progressReporter(opts);

    try {
      const newRoots = buildNewClassifyRoots(dirs.homeKiroDir);
      progress('正在枚举 1.x 会话目录…');
      const listed = await this.listNewSessionDirs(workspaceSessionDir);

      const rows: RankingRow[] = [];
      const footprints: SessionFootprint[] = [];
      let totalBytes = 0;
      let files = 0;
      let skippedCount = listed.skippedCount;
      let cancelled = false;

      progress('正在统计会话占用…');
      for (const sessionDir of listed.dirs) {
        if (isCancelled()) {
          cancelled = true;
          break;
        }
        const scanned = await this.scanNewSession(sessionDir, newRoots, isCancelled);
        // 扫描中途被取消的会话**不出行**：它的字节数只覆盖了目录的一部分，
        // 出一行偏低的数值比少一行更误导（整体 `partial` 已经说明结果不完整）
        if (scanned.cancelled) {
          cancelled = true;
          break;
        }
        skippedCount += scanned.skippedCount;
        files += scanned.files;
        totalBytes += scanned.footprint.totalBytes;
        footprints.push(scanned.footprint);
        rows.push(scanned.row);
      }

      const result: NewRowsResult = {
        rows,
        footprints,
        totalBytes,
        files,
        sessionCount: rows.length,
        partial: skippedCount > 0 || cancelled,
        skippedCount,
        roots: [workspaceSessionDir],
      };
      // 被取消的取数是残缺值，不入 StorageCache（与 `getRankingRows` 同一取舍）
      if (!cancelled) this.newRowsCache = { value: result, scannedAt: now };
      return cloneNewRows(result);
    } catch {
      return emptyNewRows();
    }
  }

  /**
   * 排行页取数（双布局合并）：`both` 下同时计量当前工作区在新旧两处的会话，
   * 同 sessionId 双份时以新格式为该会话 SessionFootprint 的唯一来源，旧份转记
   * LegacyResidue（Requirement 6.7、7.4，设计决策 D7）。
   *
   * 三种布局共用这一个入口，无需调用方分支：
   * - `both`：两侧都有行 → 合并去重
   * - `new-only`：旧侧根不存在 → 旧侧返回空快照（`roots: []`），结果等于新侧
   * - `old-only`：新布局根不可用 → 新侧返回空结果（`roots: []`），结果等于旧侧
   * `sides` 如实回报本次**观测到**的侧，因此调用方能分辨「那一侧没有数据」与
   * 「那一侧没被观测到」——前者 `roots` 非空而行为空，后者 `roots` 为空。
   *
   * 「每个会话恰好被计入一次」由 {@link mergeRankingRows} 的单一 Map 构造性保证
   * （见该函数注释），本方法只负责把两侧取数喂进去。
   *
   * 缓存：本方法**自身不持缓存**，两侧各自的 60 秒 StorageCache 已经覆盖
   * （`opts` 原样透传，故 `force: true` 会让两侧一起重取）。因此
   * `invalidateForDeletedFiles` 打掉那两个缓存后，下一次合并自动反映更新后的磁盘，
   * 不存在第三处需要单独失效的缓存（TODO(task 11.6) 只需处理另外两个聚合维度自己的缓存）。
   *
   * 任一侧取数失败都已在各自方法内降级为空结果而不抛异常（Req 9.2），故本方法同样
   * 不抛异常：`both` 里坏掉一侧只会让结果退化成另一侧。
   */
  async getMergedRankingRows(opts: SummaryOptions = {}): Promise<MergedRankingRows> {
    const newSide = await this.getNewRankingRows(opts);
    const oldSide = await this.oldRowsSnapshot(opts);
    return mergeRankingRows(newSide, oldSide);
  }

  /**
   * ProjectSessionTotal：当前工作区全部会话自身口径占用的合计与会话数
   * （Requirement 7.2、7.3、7.4）。
   *
   * **不为该维度额外发起目录枚举**（Req 7.3）：数值由排行页的同一次枚举结果聚合而来。
   * 本方法 = `getMergedRankingRows()` + 纯函数 {@link projectSessionTotalFrom}，
   * 而后者零 IO，故聚合本身在结构上不可能枚举目录。排行页（任务 12.1）已经拿到
   * 合并结果时应直接调用 {@link projectSessionTotalFrom}，连这一次
   * `getMergedRankingRows`（会命中两侧缓存）都省掉，两处数值恒同源。
   *
   * TODO(task 12.1): tooltip 还需要「会话本体 / 快照」两部分的字节数拆解（Req 7.11）
   * 与 `both` 下「单会话占用不含旧残留部分」的说明（Req 6.7）。`AggregateTotal` 不带
   * 这两项，请从同一个 {@link MergedRankingRows} 上取 `sessionBytes` /
   * `attachmentBytes` / `residue.superseded`，不要再回来加一个聚合维度专用的取数。
   */
  async getProjectSessionTotal(opts: SummaryOptions = {}): Promise<AggregateTotal> {
    return projectSessionTotalFrom(await this.getMergedRankingRows(opts));
  }

  /**
   * AllKiroSessionTotal：整个 Kiro 的会话总占用（Requirement 7.6、7.7、7.10）。
   *
   * 扫描 NewSessionsRoot 下**全部**工作区目录并求和，返回字节数、文件数、会话数与参与
   * 统计的工作区目录数。`old-only`（NewSessionsRoot 不存在或不可枚举）时**回退**扫描
   * OldSessionsRoot（Req 7.7、设计判断 D5）——回退的理由是「恒返回 0」会让未升级到 1.x
   * 的用户看到一个永远为零的维度，那比口径略有差异更糟。
   *
   * **口径只含会话数据**（Req 7.10）：新侧扫的是 `<newSessionsRoot>` 之下，1.x 的快照与
   * 子执行本就在各会话目录内，故它们计入本维度；LegacyResidue（旧目录）不在扫描范围内，
   * 主流程因此不承担那约 3.6 GB 的扫描成本，它是独立维度
   * （{@link getLegacyResidueTotal}）。回退到旧侧时同理只扫 OldSessionsRoot，
   * `<OldStoreRoot>/<WorkspaceId>` 下的执行存档不计入——那一侧的「附件」不在会话目录内，
   * 无法在不逐工作区解码路径的前提下归属，且 `old-only` 下旧残留维度本就隐藏（Req 8.3），
   * 不存在与它重复计量的问题。
   *
   * **惰性由结构保证**（Req 12.4–12.6）：本方法是唯一发起该扫描的入口，`getSummary` /
   * `getRankingRows` / `getNewRankingRows` / `getMergedRankingRows` 都不调用它，
   * 因此「未触发即不枚举其它工作区目录」不依赖调用方自律。未触发时的展示值由
   * {@link idleAggregateTotal} 给出。
   *
   * 缓存：结果**无 TTL** 地缓存（见 `allTotalCache` 的说明）；`force: true` 强制重扫。
   *
   * TODO(task 12.1): 手动触发控件在**常规触发**时不要传 `force: true`，否则缓存永不生效、
   * 每次点击都重扫全部工作区；只有独立的「重新统计」动作才传 `force: true`。
   * 「统计中…」与忽略重复触发（Req 7.9）由 UI 侧的单飞状态承担——本方法不持有 `loading`
   * 态，因为它是一次调用的返回值，天然表达不了「正在进行中」。
   *
   * 两侧根都不可用时返回 `state: 'unavailable'` 且**不抛异常**（Req 9.2）。
   */
  async getAllKiroSessionTotal(opts: SummaryOptions = {}): Promise<AggregateTotal> {
    if (opts.force !== true && this.allTotalCache) return cloneAggregate(this.allTotalCache);

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const progress = this.progressReporter(opts);

    try {
      const result = await this.computeAllKiroSessionTotal(isCancelled, progress);
      // 被取消的扫描是残缺值，不入缓存（与 `getRankingRows` 同一取舍）
      if (result.state === 'ok' && !result.cancelled) this.allTotalCache = result.total;
      return cloneAggregate(result.total);
    } catch {
      // 整体失败按「该维度不可用」处理：其余维度与排行表照常展示，且不弹窗（Req 8.8 的同一策略）
      return unavailableAggregate();
    }
  }

  /**
   * LegacyResidueTotal：旧目录里仍残留的 0.9x 数据（Requirement 8.1、8.5、8.6、8.8、8.10）。
   *
   * 扫描范围 = OldSessionsRoot 整棵子树 + `<OldStoreRoot>/<WorkspaceId>` 各棵子树
   * （WorkspaceId 目录按 `hex32` 形态识别，与 `classifyPath` 的规则 2~4 同一判据），
   * 返回字节数、文件数与涉及的工作区目录数。
   *
   * **两分（Req 8.6）的方向是刻意保守的**，因为「已迁移仅残留」正是旧残留清理敢删的桶
   * （design D8，删掉即永久丢失）：
   *
   * - `migratedResidue*` 只计入**有正面证据**的旧会话文件：新布局下存在同 sessionId 的
   *   会话目录，或旧目录内存在 `v2SessionId` 指向它的 MigrationMarker。
   * - `unmigrated*` 取**补集**（`bytes - migratedResidueBytes`），因此
   *   「`bytes` 恒等于两部分之和」是构造性成立的，不靠事后校验。补集里除了真正未迁移的
   *   会话，还含清单、迁移标记本身、以及 `<OldStoreRoot>/<WorkspaceId>` 下**无法按会话
   *   归属**的执行存档与源码快照——把它们算进「可清理」需要逐工作区解码路径再查存档索引，
   *   而缺证据时误判的代价是永久删除，故一律划到默认不清理的那一侧。
   *
   * TODO(task 12.1): 因此该部分的文案不能只写「未迁移」，需写成「未迁移或无法按会话归属
   * （默认不清理）」，否则用户会拿这个数字去反推「还有多少旧会话没迁移」。Req 8.7 要求的
   * 「未迁移部分在 1.x 界面中不可见」对其中的会话成立，对存档部分不适用。
   *
   * TODO(task 11.2 的接缝): 合并层的 {@link LegacyResidueAttribution} 是**同一事实的另一个
   * 观测口径**（只覆盖当前工作区、且带 `superseded` 这个双侧直接证据），可用于与本维度对账；
   * 本方法自己重扫目录得出权威数值，两者不共用中间结果。
   *
   * 惰性、缓存与不抛异常的语义同 {@link getAllKiroSessionTotal}。旧目录不存在或不可读时
   * 返回 `state: 'unavailable'` 并保持其余统计可用（Req 8.8）。
   */
  async getLegacyResidueTotal(opts: SummaryOptions = {}): Promise<LegacyResidueTotal> {
    if (opts.force !== true && this.legacyResidueCache) {
      return cloneLegacyResidue(this.legacyResidueCache);
    }

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const progress = this.progressReporter(opts);

    try {
      const result = await this.computeLegacyResidueTotal(isCancelled, progress);
      if (result.state === 'ok' && !result.cancelled) {
        // 聚合值与待删清单**成对**入缓存：确认提示上的数字与实际要删的文件必须同源
        this.legacyResidueCache = result.total;
        this.legacyResidueTargetsCache = result.targets;
      }
      return cloneLegacyResidue(result.total);
    } catch {
      return unavailableLegacyResidue();
    }
  }

  /**
   * 旧残留清理的待删清单（Requirement 11.1、11.2、11.3）。
   *
   * **只读缓存、零 IO**：清理入口只在「该维度已完成统计」之后才出现（Req 11.1），
   * 而那次统计已经把清单算出来了。这里不重扫的两个理由：
   *
   * - 重扫会让「确认提示上的数字」与「实际删除的文件」来自两次不同的观测，两者可能对不上；
   * - 旧残留是几 GB 级的扫描，点一下清理按钮再扫一遍是用户不会预期的停顿。
   *
   * 尚未统计过 → 返回空清单（`files: []`）。清理侧据此得到一个空计划并直接返回未执行状态
   * （Req 11.6），而不是去猜该删什么。
   */
  peekLegacyResidueTargets(): LegacyResidueTargets {
    return this.legacyResidueTargetsCache
      ? cloneResidueTargets(this.legacyResidueTargetsCache)
      : emptyResidueTargets();
  }

  /**
   * 清理后的缓存失效（Req 14.13）。
   *
   * 对每个被删文件，自其所在目录向上**逐级** `invalidate` 直至扫描根，并丢弃
   * StorageCache 的汇总结果与排行行集合。
   *
   * 为什么必须逐级：SubtreeCache 缓存的是**子树聚合**，祖先目录的聚合值里含被删
   * 文件的字节数，而祖先目录自身的 `mtimeMs` 与直接子条目数并不因孙辈文件被删而
   * 变化——失效判据抓不到，必须显式打掉。
   *
   * 为什么走到扫描根（UserDataDir）而不止于 StoreRoot：Requirement 14.13 要求的
   * 范围是「直至 StoreRoot」，而汇总统计的扫描根是 UserDataDir，`<UserDataDir>`、
   * `<UserDataDir>/User`、`…/globalStorage` 这几级的缓存聚合同样含被删字节。
   * 只失效到 StoreRoot 的话，下一次统计在 UserDataDir 这一级就直接命中陈旧聚合、
   * 根本不会往下走。因此这里取的是要求范围的**超集**，多打掉几个键的代价只是
   * 一次缓存未命中。
   */
  invalidateForDeletedFiles(paths: readonly string[]): void {
    this.snapshotCache = null;
    this.rowsCache = null;
    this.newRowsCache = null;
    // 两个手动触发维度的缓存同样打掉（Requirement 7.13、8.8、11.8）。
    // ProjectSessionTotal 不需要单独一条：它由 `rowsCache` + `newRowsCache` 派生
    // （`getMergedRankingRows` 自身不持缓存），上面两行已经覆盖。
    this.allTotalCache = null;
    this.legacyResidueCache = null;
    // 待删清单与聚合值成对失效：清理之后那份清单里的路径已有一部分不存在了，
    // 留着它会让下一次清理拿一份陈旧的清单去删（虽然段 5 的复核会拦住，但那是白跑）
    this.legacyResidueTargetsCache = null;
    if (!paths || paths.length === 0) return;

    const userDataDir = this.resolveUserDataDir();
    const stopRoot = userDataDir ? path.normalize(userDataDir) : null;

    for (const p of paths) {
      if (typeof p !== 'string' || p.length === 0) continue;
      let dir = path.dirname(path.normalize(p));
      for (let step = 0; step < MAX_ANCESTOR_STEPS; step++) {
        this.invalidateDir(dir);
        if (stopRoot !== null && dir === stopRoot) break;
        const parent = path.dirname(dir);
        if (parent === dir) break; // 到达文件系统根，`dirname` 已是不动点
        dir = parent;
      }
    }
  }

  /**
   * 只读窥视两个**手动触发**维度的缓存，**零 IO**（Requirement 8.4、12.4–12.6）。
   *
   * 存在的理由只有一个：报告命令想把「用户此前已经算过」的数值一并写进报告，但它**不是**
   * 那两个维度的触发器 —— 直接调 `getAllKiroSessionTotal()` / `getLegacyResidueTotal()`
   * 会让一次「存储占用分析」顺手扫掉本机约 3.6 GB 的旧残留，正是 Req 8.4 要排除的行为。
   *
   * 因此本方法只回缓存里已有的东西：没算过就是 `undefined`，由调用方渲染成「未统计」。
   * 返回副本，避免调用方就地改写污染缓存。
   */
  peekAggregateTotals(): { allKiro?: AggregateTotal; legacyResidue?: LegacyResidueTotal } {
    const out: { allKiro?: AggregateTotal; legacyResidue?: LegacyResidueTotal } = {};
    if (this.allTotalCache) out.allKiro = cloneAggregate(this.allTotalCache);
    if (this.legacyResidueCache) out.legacyResidue = cloneLegacyResidue(this.legacyResidueCache);
    return out;
  }

  /** 测试辅助：清空 StorageCache 与全部 SubtreeCache。 */
  clearCache(): void {
    this.snapshotCache = null;
    this.rowsCache = null;
    this.newRowsCache = null;
    this.allTotalCache = null;
    this.legacyResidueCache = null;
    this.legacyResidueTargetsCache = null;
    for (const cache of this.subtreeCaches.values()) cache.clear();
    this.subtreeCaches.clear();
  }

  /* ---------------- 内部实现 ---------------- */

  private clock(): number {
    const now = this.deps.now ?? Date.now;
    const t = now();
    return Number.isFinite(t) ? t : Date.now();
  }

  private workspacePath(): string | null {
    const ws = this.deps.workspacePath;
    return typeof ws === 'string' && ws.length > 0 ? ws : null;
  }

  /** PathResolver 取 UserDataDir；解析本身抛错也按「不可用」处理而不外抛（Req 1.1、1.2）。 */
  private resolveUserDataDir(): string | null {
    try {
      return getKiroUserDataDir(this.deps.pathResolver);
    } catch {
      return null;
    }
  }

  /** 进度回调包装：回调自身抛错不该让一次统计失败。 */
  private progressReporter(opts: SummaryOptions): (msg: string) => void {
    const onProgress = opts.onProgress;
    if (!onProgress) return (): void => undefined;
    return (msg: string): void => {
      try {
        onProgress(msg);
      } catch {
        // 进度展示是附属信息，回调失败不影响统计结果
      }
    };
  }

  private scannerDeps(): ScannerFsDeps {
    const deps: ScannerFsDeps = { readdir: this.fs.readdir, lstat: this.fs.lstat };
    if (this.fs.yieldNow) deps.yieldNow = this.fs.yieldNow;
    return deps;
  }

  /** `collectLiveSessions` 与 `collectRankingRows` 共用的三读 API 形状。 */
  private readDeps(): OrphanFsDeps & RankingFsDeps {
    return { readdir: this.fs.readdir, stat: this.fs.stat, readFile: this.fs.readFile };
  }

  private listArchives(storeRoot: string): readonly ArchiveInfo[] {
    const source = this.deps.listArchives ?? listArchiveEntries;
    const ws = this.workspacePath();
    try {
      return source(storeRoot, ws ? { workspacePath: ws } : {});
    } catch {
      // 存档索引不可用时按空集合继续：孤儿判定与归因退化为 0，不影响目录统计
      return [];
    }
  }

  /** 该扫描根专属的 SubtreeCache（见类注释关于 `(root, maxDepth)` 不变式的说明）。 */
  private cacheFor(root: string): SubtreeCache {
    const key = path.normalize(root);
    let cache = this.subtreeCaches.get(key);
    if (!cache) {
      cache = new SubtreeCache();
      this.subtreeCaches.set(key, cache);
    }
    return cache;
  }

  private invalidateDir(dir: string): void {
    for (const cache of this.subtreeCaches.values()) cache.invalidate(dir);
  }

  private sessionDirCandidates(roots: ClassifyRoots, workspacePath: string): string[] {
    return encodeWorkspaceKeys(workspacePath).map((key) => path.join(roots.sessionsRoot, key));
  }

  private execDirCandidates(roots: ClassifyRoots, workspacePath: string): string[] {
    return workspaceIdCandidates(workspacePath).map((id) => path.join(roots.storeRoot, id));
  }

  /**
   * 过滤出确实存在的目录。盘符大小写与斜杠方向的差异让同一工作区可能对应多个
   * 编码变体目录名，全部取用而不是只认第一个：两个变体目录若同时存在，它们都是
   * 这个工作区的数据，漏掉一个会让 `currentWorkspaceBytes` 偏低。
   */
  private async existingDirs(candidates: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const dir of candidates) {
      const key = path.normalize(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const st = await this.fs.stat(dir);
        if (st.isDirectory()) out.push(dir);
      } catch {
        // 不存在或不可 stat：该变体目录不参与统计，且不算跳过条目
      }
    }
    return out;
  }

  /**
   * 若干目录的字节数合计。
   *
   * 这些目录都是 UserDataDir 的子树，主扫描已经覆盖过它们，因此这里**刻意不把
   * `skippedCount` 并入汇总**：同一个不可读目录被计两次会让 `skippedCount` 虚高，
   * 而 `partial` 标记已由主扫描给出。
   */
  private async sumDirBytes(
    dirs: readonly string[],
    roots: ClassifyRoots,
    isCancelled: () => boolean
  ): Promise<number> {
    let bytes = 0;
    for (const dir of dirs) {
      const res = await scanTree(dir, {
        roots,
        cache: this.cacheFor(dir),
        isCancelled,
        fsDeps: this.scannerDeps(),
      });
      bytes += res.totalBytes;
    }
    return bytes;
  }

  /**
   * 读 SessionManifest 取 sessionId → 标题映射；任何失败都返回空 Map。
   *
   * 与 `ranking.ts` 的同名内部函数同一口径（顶层数组、只收非空白标题）。
   * 那个函数是 `collectRankingRows` 的私有实现细节且只服务单个会话目录，
   * 报告要覆盖全部工作区、且不需要 `RankingRow` 的其余字段，因此这里保留一份
   * 十几行的读取而不是把私有函数提成公共 API——真正需要同口径的是「标题从哪来」，
   * 这一点由两处的注释与同一份清单格式约束住。
   */
  private async loadManifestTitles(dirPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let raw: string;
    try {
      raw = await this.fs.readFile(path.join(dirPath, MANIFEST_FILENAME), 'utf8');
    } catch {
      return map; // 清单不存在或不可读：报告展示 `(无标题)`
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return map;
    }
    if (!Array.isArray(parsed)) return map;
    for (const item of parsed) {
      const id = (item as { sessionId?: unknown } | null)?.sessionId;
      const title = (item as { title?: unknown } | null)?.title;
      if (typeof id === 'string' && id && typeof title === 'string' && title.trim()) {
        map.set(id, title);
      }
    }
    return map;
  }

  /** StorageCache 的读写口：`force !== true` 且未过期即直接返回缓存（Req 7.5）。 */
  private async snapshot(opts: SummaryOptions): Promise<Snapshot> {
    const now = this.clock();
    if (
      opts.force !== true &&
      this.snapshotCache &&
      now - this.snapshotCache.scannedAt < STORAGE_CACHE_TTL_MS
    ) {
      return this.snapshotCache.snapshot;
    }

    const snapshot = await this.computeSnapshot(opts, now);
    // 不可用与被取消的快照都不入缓存：前者应在下次调用时重试解析 UserDataDir，
    // 后者是残缺值。取消时已完成的子树聚合仍留在 SubtreeCache 里供下次复用（Req 6.7）。
    if (snapshot.summary.status === 'ok' && !snapshot.cancelled) {
      this.snapshotCache = { snapshot, scannedAt: snapshot.summary.scannedAt };
    }
    return snapshot;
  }

  /**
   * 一次完整取数：目录扫描 → LiveSessionIds 采集 → ArchiveIndex 快照 → 归因与孤儿判定。
   *
   * 组装规则：
   * - `categories` / `totalBytes` / `totalFiles` 直接来自 `scanTree` 的分类合计（Req 1.3–1.9）
   * - `currentWorkspaceBytes` = WorkspaceSessionDir 字节数 + `<StoreRoot>/<WorkspaceId>`
   *   字节数（Req 1.10）
   * - `projectFootprintTotal` / `sessionCount` 由当前工作区全部会话的 SelfFootprint 合计
   *   得出；自身口径可相加，故该合计有意义（Req 2.1、2.3）。会话的 JSON 字节数取自
   *   采集阶段的 `byWorkspace` 明细，不再单独枚举一遍会话目录
   * - `skippedCount` = 扫描跳过 + 采集跳过；`> 0` 或被取消即 `partial: true`，
   *   表示各数值为下限且**不抛异常**（Req 9.2）
   */
  private async computeSnapshot(opts: SummaryOptions, now: number): Promise<Snapshot> {
    const userDataDir = this.resolveUserDataDir();
    if (!userDataDir) return unavailableSnapshot(now, null);

    const isCancelled = opts.isCancelled ?? ((): boolean => false);
    const progress = this.progressReporter(opts);

    try {
      const roots = buildClassifyRoots(userDataDir);

      progress('正在枚举用户数据目录…');
      const scan = await scanTree(userDataDir, {
        roots,
        cache: this.cacheFor(userDataDir),
        isCancelled,
        fsDeps: this.scannerDeps(),
      });

      progress('正在收集会话清单…');
      const live = await collectLiveSessions(roots.sessionsRoot, this.readDeps());

      progress('正在读取执行存档索引…');
      const archives = this.listArchives(roots.storeRoot);
      const orphan = computeOrphans(archives, live);

      progress('正在归因当前工作区会话占用…');
      const workspaceDirs = await this.resolveWorkspaceDirs(roots);
      const currentWorkspaceBytes = await this.sumDirBytes(
        [...workspaceDirs.sessionDirs, ...workspaceDirs.execDirs],
        roots,
        isCancelled
      );
      const project = this.projectFootprint(live, workspaceDirs.sessionDirs, archives);

      const skippedCount = scan.skippedCount + live.skippedCount;
      const summary: StorageSummary = {
        status: 'ok',
        userDataDir,
        totalBytes: scan.totalBytes,
        totalFiles: scan.totalFiles,
        categories: toCategories(scan.totals),
        currentWorkspaceBytes,
        projectFootprintTotal: project.totalBytes,
        orphan,
        partial: skippedCount > 0 || scan.cancelled,
        skippedCount,
        sessionCount: project.sessionCount,
        sizeNote: SIZE_NOTE,
        scannedAt: now,
      };

      return { summary, roots, live, archives, workspaceDirs, cancelled: scan.cancelled };
    } catch {
      // 汇总统计整体失败：返回 unavailable 而不外抛，搜索结果与既有 credit 角标
      // 照常展示（Req 9.2、9.3）
      return unavailableSnapshot(now, userDataDir);
    }
  }

  private async resolveWorkspaceDirs(roots: ClassifyRoots): Promise<WorkspaceDirs> {
    const ws = this.workspacePath();
    if (!ws) return { sessionDirs: [], execDirs: [] };
    return {
      sessionDirs: await this.existingDirs(this.sessionDirCandidates(roots, ws)),
      execDirs: await this.existingDirs(this.execDirCandidates(roots, ws)),
    };
  }

  /* ---------------- 新布局（1.x）内部实现 ---------------- */

  /**
   * 1.x 的两个目录：注入优先，否则经 PathResolver 现解析。
   *
   * 解析本身抛错也按「不可用」处理而不外抛（与 `resolveUserDataDir` 同一策略）：
   * 新布局根不可用只应让新布局那一侧的取数为空，不该让整次统计失败。
   */
  private resolveNewLayoutDirs(): NewLayoutDirs {
    const injected = this.deps.newLayout;
    if (injected) {
      return {
        homeKiroDir: injected.homeKiroDir ?? null,
        newWorkspaceSessionDir: injected.newWorkspaceSessionDir ?? null,
        newSessionsRoot: injected.newSessionsRoot ?? null,
      };
    }
    try {
      const resolver = this.deps.pathResolver;
      const homeKiroDir = getHomeKiroDir(resolver);
      const newSessionsRoot = getNewSessionsRoot(resolver);
      const ws = this.workspacePath();
      const newWorkspaceSessionDir =
        newSessionsRoot && ws ? resolveNewWorkspaceSessionDir(newSessionsRoot, ws, resolver) : null;
      return { homeKiroDir, newWorkspaceSessionDir, newSessionsRoot };
    } catch {
      return { homeKiroDir: null, newWorkspaceSessionDir: null, newSessionsRoot: null };
    }
  }

  /**
   * AllKiroSessionTotal 的扫描起点：注入的 `newSessionsRoot` 优先，否则由 `homeKiroDir` 派生。
   *
   * 派生值只是路径拼接、不含存在性信息，因此调用方**不能**据其非 `null` 断定该根可用；
   * 「可用」一律由后续 `readdir` 的成败给出（不可枚举 → 该侧未被观测）。
   */
  private newSessionsRootPath(dirs: NewLayoutDirs): string | null {
    if (dirs.newSessionsRoot) return dirs.newSessionsRoot;
    return dirs.homeKiroDir ? buildNewClassifyRoots(dirs.homeKiroDir).newSessionsRoot : null;
  }

  /**
   * 枚举 NewWorkspaceSessionDir 下的会话目录（1.x 一个会话就是一个子目录）。
   *
   * - 目录整体不可枚举 → 空列表 + `skippedCount: 1`（行集合不完整，调用方据此置 `partial`）
   * - 符号链接一律不跟随（避免循环链接与跨目录重复计数），但会让行集合不完整，故计入跳过
   * - 非目录条目（工作区目录下的散落文件）不是会话，跳过且**不**计入 `skippedCount`
   *   ——它们的字节数由汇总统计的分类计量覆盖，在排行页里没有对应的行
   */
  private async listNewSessionDirs(
    workspaceSessionDir: string
  ): Promise<{ dirs: string[]; skippedCount: number }> {
    const listed = await this.listDirEntries(workspaceSessionDir);
    return { dirs: listed.dirs, skippedCount: listed.skippedCount };
  }

  /**
   * 一次目录枚举的结果，按「子目录 / 文件」两分。
   *
   * 与直接调 `readdir` 的差别只在三处约定，而这三处在新旧布局的每一层枚举里都相同，
   * 故统一到这里而不是各处重写：
   *
   * - 目录整体不可枚举 → `readable: false` + `skippedCount: 1`。调用方据此区分
   *   「这个目录是空的」（`readable: true`、两个数组皆空）与「这个目录没读到」——
   *   前者该计入 `workspaceCount`，后者不该。
   * - 符号链接一律不跟随（避免循环链接与跨目录重复计数），但会让结果不完整，故计入跳过。
   * - 其余条目按 `isDirectory()` 分流；两者都不是的特殊条目（FIFO / 套接字等）被丢弃且
   *   不计入跳过——它们不占用户关心的字节数，也不是会话。
   */
  private async listDirEntries(dir: string): Promise<ListedDir> {
    let entries: DirentLike[];
    try {
      entries = await this.fs.readdir(dir, { withFileTypes: true });
    } catch {
      return { readable: false, dirs: [], files: [], skippedCount: 1 };
    }

    const dirs: string[] = [];
    const files: ListedFile[] = [];
    let skippedCount = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(full);
      else if (entry.isFile()) files.push({ name: entry.name, full });
    }
    return { readable: true, dirs, files, skippedCount };
  }

  /**
   * 扫描单个 NewSessionDir，产出该会话的 SessionFootprint 与排行行。
   *
   * 扫描以**会话目录自身**为根：这样 `snapshots/<hash>/<深层相对路径>` 得到完整的
   * 深度预算（若从 sessions 根起扫，`<WsHash16>/<sessionId>` 两级会先吃掉预算，
   * 深快照会被误计为超深跳过）。同一目录的子树聚合缓存按根隔离（`cacheFor(dir)`），
   * 满足 SubtreeCache「同一实例只服务同一组 (root, maxDepth)」的不变式。
   *
   * `roots` 传的是由 HomeKiroDir 派生的**占位值**：`ScanOptions.classify` 提供时优先
   * 于 `roots`，缺省分类器一次都不会被调用（design D5），故其内容不参与任何计量。
   * 之所以还得传，是因为该字段在既有类型契约里是必填的，改成可选会动到已上线的签名。
   */
  private async scanNewSession(
    sessionDir: string,
    newRoots: NewClassifyRoots,
    isCancelled: () => boolean
  ): Promise<ScannedNewSession> {
    const scan = await scanTree(sessionDir, {
      roots: buildClassifyRoots(newRoots.homeKiroDir),
      classify: (fullPath) => classifyNewPath(newRoots, fullPath),
      cache: this.cacheFor(sessionDir),
      isCancelled,
      fsDeps: this.scannerDeps(),
    });

    // 被取消打断的扫描只覆盖了目录的一部分：就此返回，连元数据都不再读
    // （取消之后不该再产生任何磁盘访问）
    if (scan.cancelled) return { cancelled: true };

    const sizes = newSessionSizes(scan);
    const sessionId = path.basename(sessionDir);
    const meta = await this.loadNewSessionMeta(sessionDir);

    const row = buildNewRankingRow({
      ...sizes,
      sessionId,
      title: meta?.title ?? '',
      mtimeMs: await this.resolveNewSessionMtime(sessionDir, meta),
      origin: newSessionOrigin(sessionId),
    });

    return {
      cancelled: false,
      row,
      footprint: computeNewSessionFootprint({ ...sizes, sessionId, scope: 'self' }),
      files: scan.totalFiles,
      skippedCount: scan.skippedCount,
    };
  }

  /**
   * 读 NewSessionMetaFile 取标题与 `lastModifiedAt`；任何失败都返回 `null`。
   *
   * 解析复用 NewFormatReader 的 {@link parseNewSessionMeta}（逐字段校验的那一份），
   * 不在这里另写一遍：`session.json` 是外部进程写的文件，两处各自校验早晚会漂移。
   * 只读这**一个**小文件，`messages.jsonl` 绝不打开——扫描侧只 stat 取字节数
   * （Requirement 6.12），标题与时间戳的来源仅限元数据文件。
   */
  private async loadNewSessionMeta(sessionDir: string): Promise<NewSessionMeta | null> {
    try {
      const raw = await this.fs.readFile(path.join(sessionDir, NEW_SESSION_META_FILENAME), 'utf8');
      return parseNewSessionMeta(raw);
    } catch {
      return null; // 缺元数据 / 不可读：标题留空，时间走回退来源
    }
  }

  /**
   * 「最后修改时间」列的取值（Requirement 6.10）：`lastModifiedAt` 优先，
   * 与 NewFormatReader 的 Req 3.10 同一回退口径——缺失或非法时取 MessagesFile 的 mtime。
   *
   * 再多一级回退到会话目录自身的 mtime：排行页要为**每个**会话目录出一行（Req 6.8），
   * 包含缺 `messages.jsonl` 的残缺目录，而 0（epoch）会把它们永久钉在时间排序的一端，
   * 目录 mtime 至少是「这个会话最后被动过」的真实近似。三级都取不到才落到 0。
   */
  private async resolveNewSessionMtime(
    sessionDir: string,
    meta: NewSessionMeta | null
  ): Promise<number> {
    const iso = meta?.lastModifiedAt;
    if (typeof iso === 'string' && iso.trim()) {
      const t = Date.parse(iso);
      if (Number.isFinite(t)) return t;
    }
    for (const p of [path.join(sessionDir, MESSAGES_FILENAME), sessionDir]) {
      try {
        const st = await this.fs.stat(p);
        if (Number.isFinite(st.mtimeMs)) return st.mtimeMs;
      } catch {
        // 该回退来源不可用，试下一个
      }
    }
    return 0;
  }

  /* ---------------- 聚合维度（AllKiroSessionTotal / LegacyResidueTotal）内部实现 ---------------- */

  /**
   * AllKiroSessionTotal 的取数：新侧优先、`old-only` 回退旧侧（Requirement 7.6、7.7）。
   *
   * 「新侧是否可用」的判据取 **NewSessionsRoot 能否被枚举**，而不是路径是否解析出来：
   * 派生路径永远非 `null`（只是字符串拼接），只有 `readdir` 成功才说明那个根真的在。
   * 因此 `~/.kiro` 不存在的机器会自然落到旧侧回退，无需上层先判布局。
   */
  private async computeAllKiroSessionTotal(
    isCancelled: () => boolean,
    progress: (msg: string) => void
  ): Promise<AggregateOutcome<AggregateTotal>> {
    const dirs = this.resolveNewLayoutDirs();
    const newSessionsRoot = this.newSessionsRootPath(dirs);

    if (newSessionsRoot) {
      const listed = await this.listDirEntries(newSessionsRoot);
      if (listed.readable) {
        progress('正在统计全部工作区的 1.x 会话占用…');
        // 分类器与排行页取数用同一份（`homeKiroDir` 未注入时由 sessions 根反推其父目录）：
        // 同一个会话目录在两条路径上共用 `cacheFor(sessionDir)` 这一个子树缓存，
        // 分类器若不一致，缓存里的 `totals` 就会随「哪条路径先扫」而变（Property 7）
        const homeKiroDir = dirs.homeKiroDir ?? path.dirname(newSessionsRoot);
        const newRoots = buildNewClassifyRoots(homeKiroDir);
        const acc = emptyAcc();
        acc.skippedCount += listed.skippedCount;

        for (const wsDir of listed.dirs) {
          if (isCancelled()) {
            acc.cancelled = true;
            break;
          }
          await this.accumulateNewWorkspaceDir(wsDir, newRoots, isCancelled, acc);
        }
        // sessions 根下的散落文件（`.migration-v3` 之类的标记）也占空间，如实计入
        if (!acc.cancelled) await this.accumulateLooseFiles(listed.files, acc);

        return {
          state: 'ok',
          total: accToAggregate(acc, [newSessionsRoot]),
          cancelled: acc.cancelled,
        };
      }
    }

    // ---- 回退：`old-only`（NewSessionsRoot 不存在或不可枚举），Req 7.7 / 设计判断 D5 ----
    const userDataDir = this.resolveUserDataDir();
    if (!userDataDir) return { state: 'unavailable', total: unavailableAggregate(), cancelled: false };

    const roots = buildClassifyRoots(userDataDir);
    const listedOld = await this.listDirEntries(roots.sessionsRoot);
    if (!listedOld.readable) {
      return { state: 'unavailable', total: unavailableAggregate(), cancelled: false };
    }

    progress('正在统计全部工作区的 0.9x 会话占用…');
    const acc = emptyAcc();
    acc.skippedCount += listedOld.skippedCount;
    for (const wsDir of listedOld.dirs) {
      if (isCancelled()) {
        acc.cancelled = true;
        break;
      }
      await this.accumulateOldWorkspaceDir(wsDir, roots, isCancelled, acc);
    }
    if (!acc.cancelled) await this.accumulateLooseFiles(listedOld.files, acc);

    return { state: 'ok', total: accToAggregate(acc, [roots.sessionsRoot]), cancelled: acc.cancelled };
  }

  /**
   * 累加一个 1.x 工作区目录（`<newSessionsRoot>/<WsHash16>`）。
   *
   * **按会话目录逐个 `scanTree`**，而不是对整个工作区目录扫一次：会话目录才是
   * `scanNewSession` 的扫描根，从这里起扫深度预算才与排行页一致
   * （从工作区目录起扫会先被 `<sessionId>` 吃掉一级，深快照会被误计为超深跳过），
   * 且 `cacheFor(sessionDir)` 的子树缓存能与排行页取数**互相复用**。
   */
  private async accumulateNewWorkspaceDir(
    wsDir: string,
    newRoots: NewClassifyRoots,
    isCancelled: () => boolean,
    acc: AggregateAcc
  ): Promise<void> {
    const listed = await this.listDirEntries(wsDir);
    acc.skippedCount += listed.skippedCount;
    // 不可枚举的工作区目录不算「参与了统计」：只记跳过，不增 workspaceCount
    if (!listed.readable) return;
    acc.workspaceCount += 1;

    for (const sessionDir of listed.dirs) {
      if (isCancelled()) {
        acc.cancelled = true;
        return;
      }
      const scan = await scanTree(sessionDir, {
        roots: buildClassifyRoots(newRoots.homeKiroDir),
        classify: (fullPath) => classifyNewPath(newRoots, fullPath),
        cache: this.cacheFor(sessionDir),
        isCancelled,
        fsDeps: this.scannerDeps(),
      });
      if (scan.cancelled) {
        acc.cancelled = true;
        return;
      }
      acc.bytes += safeBytes(scan.totalBytes);
      acc.files += safeBytes(scan.totalFiles);
      acc.skippedCount += scan.skippedCount;
      acc.sessionCount += 1;
    }
    await this.accumulateLooseFiles(listed.files, acc);
  }

  /**
   * 累加一个 0.9x 工作区会话目录（`<OldSessionsRoot>/<OldEncodedKey>`）。
   *
   * 旧布局是扁平的：一个目录下全是 `<sessionId>.json` 加一个 `sessions.json` 清单
   * （可能还有迁移标记）。字节数把目录下**全部**文件如实计入，而 `sessionCount` 只数
   * 真正的会话文件——清单与标记占的那点空间确实在磁盘上，但它们不是会话。
   */
  private async accumulateOldWorkspaceDir(
    wsDir: string,
    roots: ClassifyRoots,
    isCancelled: () => boolean,
    acc: AggregateAcc
  ): Promise<void> {
    const listed = await this.listDirEntries(wsDir);
    acc.skippedCount += listed.skippedCount;
    if (!listed.readable) return;
    acc.workspaceCount += 1;

    for (const file of listed.files) {
      try {
        const st = await this.fs.lstat(file.full);
        acc.bytes += safeBytes(st.size);
        acc.files += 1;
        if (isOldSessionFileName(file.name)) acc.sessionCount += 1;
      } catch {
        acc.skippedCount += 1;
      }
    }

    // 防御性：旧布局不该有子目录，出现了也如实计入字节数而不是静默漏掉
    for (const sub of listed.dirs) {
      if (isCancelled()) {
        acc.cancelled = true;
        return;
      }
      const scan = await scanTree(sub, {
        roots,
        cache: this.cacheFor(sub),
        isCancelled,
        fsDeps: this.scannerDeps(),
      });
      if (scan.cancelled) {
        acc.cancelled = true;
        return;
      }
      acc.bytes += safeBytes(scan.totalBytes);
      acc.files += safeBytes(scan.totalFiles);
      acc.skippedCount += scan.skippedCount;
    }
  }

  /** 累加若干直接子文件的字节数；单个文件 stat 失败只记跳过。 */
  private async accumulateLooseFiles(
    files: readonly ListedFile[],
    acc: AggregateAcc
  ): Promise<void> {
    for (const file of files) {
      try {
        const st = await this.fs.lstat(file.full);
        acc.bytes += safeBytes(st.size);
        acc.files += 1;
      } catch {
        acc.skippedCount += 1;
      }
    }
  }

  /**
   * LegacyResidueTotal 的取数（Requirement 8.1、8.5、8.6）。
   *
   * 两个范围合起来才是 Req 8.1 定义的旧残留全量：OldSessionsRoot 下各工作区的会话文件，
   * 加上 `<OldStoreRoot>/<hex32>` 下的执行数据（存档、索引与源码快照）。
   *
   * 「已迁移仅残留」只由**正面证据**产生（新侧有同 sessionId 的会话目录，或旧目录里有指向
   * 它的 MigrationMarker）；「未迁移」取补集，故 `bytes` 恒等于两者之和。补集偏大是刻意的
   * 偏差方向：它是默认**不**清理的那一侧（design D8）。
   */
  private async computeLegacyResidueTotal(
    isCancelled: () => boolean,
    progress: (msg: string) => void
  ): Promise<AggregateOutcome<LegacyResidueTotal> & { targets: LegacyResidueTargets }> {
    const userDataDir = this.resolveUserDataDir();
    if (!userDataDir) {
      return {
        state: 'unavailable',
        total: unavailableLegacyResidue(),
        cancelled: false,
        targets: emptyResidueTargets(),
      };
    }
    const roots = buildClassifyRoots(userDataDir);

    progress('正在收集 1.x 已迁移会话清单…');
    // 新侧证据：全部工作区目录下的 sessionId 集合。只 readdir、不 stat，
    // 故这一步的成本与会话数无关，即便新目录有几千个会话也只是几次目录枚举
    const newSideIds = await this.collectNewSideSessionIds();

    progress('正在统计旧目录残留…');
    const acc = emptyAcc();
    const targetFiles: LegacyResidueTargets['files'] = [];
    let migratedBytes = 0;
    let migratedFiles = 0;
    let observed = false;

    // ---- 范围 1：OldSessionsRoot 下各工作区的会话文件（可按会话归属，故可两分） ----
    const listedSessions = await this.listDirEntries(roots.sessionsRoot);
    if (listedSessions.readable) {
      observed = true;
      acc.skippedCount += listedSessions.skippedCount;
      for (const wsDir of listedSessions.dirs) {
        if (isCancelled()) {
          acc.cancelled = true;
          break;
        }
        const part = await this.accumulateLegacySessionDir(wsDir, newSideIds, acc, targetFiles);
        migratedBytes += part.bytes;
        migratedFiles += part.files;
      }
      if (!acc.cancelled) await this.accumulateLooseFiles(listedSessions.files, acc);
    }

    // ---- 范围 2：`<OldStoreRoot>/<hex32>` 下的执行数据（无法按会话归属，全入补集） ----
    if (!acc.cancelled) {
      const listedStore = await this.listDirEntries(roots.storeRoot);
      if (listedStore.readable) {
        observed = true;
        acc.skippedCount += listedStore.skippedCount;
        for (const dir of listedStore.dirs) {
          // 只认 WorkspaceId 形态的目录：`workspace-sessions` 是它的兄弟目录，
          // 已在范围 1 里逐工作区计过，落进这里会被整棵重复计一次
          if (!WORKSPACE_ID_DIR.test(path.basename(dir))) continue;
          if (isCancelled()) {
            acc.cancelled = true;
            break;
          }
          const scan = await scanTree(dir, {
            roots,
            cache: this.cacheFor(dir),
            isCancelled,
            fsDeps: this.scannerDeps(),
          });
          if (scan.cancelled) {
            acc.cancelled = true;
            break;
          }
          acc.bytes += safeBytes(scan.totalBytes);
          acc.files += safeBytes(scan.totalFiles);
          acc.skippedCount += scan.skippedCount;
        }
      }
    }

    if (!observed) {
      // 旧目录一侧都没读到：该维度不可用，其余统计不受影响且不弹窗（Req 8.8）
      return {
        state: 'unavailable',
        total: unavailableLegacyResidue(),
        cancelled: false,
        targets: emptyResidueTargets(),
      };
    }

    const base = accToAggregate(acc, [roots.sessionsRoot, roots.storeRoot]);
    const total: LegacyResidueTotal = {
      ...base,
      migratedResidueBytes: migratedBytes,
      migratedResidueFiles: migratedFiles,
      // 补集，故「总量 = 两部分之和」构造性成立；`max(0, …)` 只为挡住损坏的 stat 值
      unmigratedBytes: Math.max(0, base.bytes - migratedBytes),
      unmigratedFiles: Math.max(0, base.files - migratedFiles),
    };
    return {
      state: 'ok',
      total,
      cancelled: acc.cancelled,
      targets: {
        files: targetFiles,
        bytes: migratedBytes,
        excludedBytes: total.unmigratedBytes,
        excludedFiles: total.unmigratedFiles,
      },
    };
  }

  /**
   * 累加一个 0.9x 工作区会话目录的旧残留，并返回其中「已迁移仅残留」的部分。
   *
   * 迁移标记先读一遍再枚举会话（与 `collectRankingRows` 同一顺序）：标记给出的
   * `v2SessionId` 是「这条会话已经搬到 1.x 了」的一手证据（Req 8.6 的第二个条件）。
   */
  private async accumulateLegacySessionDir(
    wsDir: string,
    newSideIds: ReadonlySet<string>,
    acc: AggregateAcc,
    targets: LegacyResidueTargets['files']
  ): Promise<{ bytes: number; files: number }> {
    const listed = await this.listDirEntries(wsDir);
    acc.skippedCount += listed.skippedCount;
    if (!listed.readable) return { bytes: 0, files: 0 };
    acc.workspaceCount += 1;

    const markerIds = await this.collectMigrationMarkerIds(listed.files);
    let bytes = 0;
    let files = 0;

    for (const file of listed.files) {
      let size: number;
      let mtimeMs: number;
      try {
        const st = await this.fs.lstat(file.full);
        size = safeBytes(st.size);
        mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
      } catch {
        acc.skippedCount += 1;
        continue;
      }
      acc.bytes += size;
      acc.files += 1;
      if (!isOldSessionFileName(file.name)) continue;
      acc.sessionCount += 1;

      const sessionId = path.basename(file.name, '.json');
      if (newSideIds.has(sessionId) || markerIds.has(sessionId)) {
        bytes += size;
        files += 1;
        // 待删清单与「已迁移仅残留」的字节数由**同一个判据、同一轮循环**产出，
        // 因此「确认提示承诺释放多少」与「实际会删哪些文件」构造性一致（Req 11.3）
        targets.push({ path: file.full, size, mtimeMs });
      }
    }
    return { bytes, files };
  }

  /**
   * 读一批文件里的 MigrationMarker，返回它们指向的 sessionId 集合。
   *
   * 不复用 `session/origin.ts` 的 `collectMigratedSessionIds`——那份用同步 fs，而本类的
   * IO 面恒是注入的异步 {@link AnalyzerFsDeps}（Property 11 直接断言这个调用面）。
   * 复用的是它的纯函数 `parseMigrationMarker`：逐字段校验 `v2SessionId`，缺失或变型时
   * 判为不可用而不是把 `undefined` 当成 sessionId——那会让一整批会话被误判为已迁移，
   * 而「已迁移」正是旧残留清理敢删的前提（design D8）。
   *
   * 读失败或内容非法只跳过该标记，**不**计入 `skippedCount`：字节数与文件数仍然精确，
   * 只是那条会话的来源标注更保守（落进默认不清理的一侧）。
   */
  private async collectMigrationMarkerIds(files: readonly ListedFile[]): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const file of files) {
      if (!isMigrationMarkerFileName(file.name)) continue;
      let raw: string;
      try {
        raw = await this.fs.readFile(file.full, 'utf8');
      } catch {
        continue;
      }
      const marker = parseMigrationMarker(raw);
      if (marker) ids.add(marker.v2SessionId);
    }
    return ids;
  }

  /**
   * NewSessionsRoot 下**全部**工作区目录里的 sessionId 集合（Req 8.6 的第一个条件）。
   *
   * 为什么不只看当前工作区的那一个目录：迁移标记里的 `workspaceHash` 用的是**旧**算法
   * （`sha256(原始路径)` 前 16 位），与 1.x 的 WsHash16 不是一回事，因此无法从一条旧记录
   * 推出它迁移后落在哪个新工作区目录下。取全集是唯一不会漏判的做法，代价只是每个工作区
   * 目录一次 `readdir`（不 stat 任何文件）。
   *
   * 新侧不可用时返回空集：判定退化为「只认迁移标记」，偏差方向是少判几个「已迁移」，
   * 即少删而不是多删。
   */
  private async collectNewSideSessionIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const dirs = this.resolveNewLayoutDirs();
    const newSessionsRoot = this.newSessionsRootPath(dirs);
    if (!newSessionsRoot) return ids;

    const listed = await this.listDirEntries(newSessionsRoot);
    if (!listed.readable) return ids;
    for (const wsDir of listed.dirs) {
      const sessions = await this.listDirEntries(wsDir);
      for (const sessionDir of sessions.dirs) ids.add(path.basename(sessionDir));
    }
    return ids;
  }

  /**
   * 当前工作区全部会话的自身口径合计（ProjectFootprintTotal）与会话数。
   *
   * 只取 `byWorkspace` 中目录路径命中当前工作区编码变体的条目——`sessions.json`
   * 在采集阶段就已被排除在 `sessions` 之外，故清单字节数不会掺进任何会话占用
   * （Req 2.6）；`<StoreRoot>/<WorkspaceId>` 下的源码快照没有可归因到会话的标识，
   * 从来不进入归因集合（Req 2.7）。
   */
  private projectFootprint(
    live: LiveSessionsResult,
    sessionDirs: readonly string[],
    archives: readonly ArchiveInfo[]
  ): { totalBytes: number; sessionCount: number } {
    const wanted = new Set(sessionDirs.map((d) => path.normalize(d)));
    const seen = new Set<string>();
    let totalBytes = 0;
    let sessionCount = 0;

    for (const info of live.byWorkspace) {
      if (!wanted.has(path.normalize(info.dirPath))) continue;
      for (const s of info.sessions) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        const fp = computeSessionFootprint(
          { sessionId: s.sessionId, jsonBytes: s.jsonBytes, scope: 'self' },
          archives
        );
        totalBytes += fp.totalBytes;
        sessionCount += 1;
      }
    }
    return { totalBytes, sessionCount };
  }
}
