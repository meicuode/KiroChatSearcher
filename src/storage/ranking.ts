/**
 * UsageRankingPage（存储占用排行页）：取数 + 纯函数 + 渲染 + 面板生命周期。
 *
 * 只读约束：本模块属于 ReadOnlyPaths，只允许引入 `readdir` / `stat` / `readFile`，
 * **不得**引入任何写 API（`unlink` / `writeFile` / `rm` / `rename` / `cp`）。
 * 本特性唯一的可写模块是 `cleaner.ts`；排行页的行内清理入口只调用 `SessionCleaner.run()`，
 * 删除动作全部发生在那一侧。
 *
 * 文件分节（按依赖顺序追加，便于后续任务接续；同一分节内保持纯函数在前）：
 *   1. 类型 re-export —— 共享类型定义在 `types.ts`，此处按需 re-export
 *   2. 常量           —— `RANKING_PAGE_SIZE`（任务 11.4）
 *   3. 纯函数         —— `compareRankingRows`（本节）、`pageOf`（任务 11.4）
 *   4. 取数（只读）   —— `collectRankingRows`（任务 11.1）
 *   5. HTML 渲染      —— `getRankingHtml`（任务 11.6）
 *   6. 面板生命周期   —— `RankingPanel`（任务 16.4，唯一接触 vscode API 的分节）
 *
 * 分节 3 的函数恒为纯函数：零 IO、无隐含状态，因此翻页与换序可在 webview 端
 * 对已下发的全量数组直接重排 + 切片，不回宿主、不产生任何文件系统调用。
 */

// ---------------------------------------------------------------------------
// 1. 类型 re-export
// ---------------------------------------------------------------------------

// `RankingRow` / `RankingSortOrder` 的单一定义来源是 `types.ts`（与 `StorageCategory`
// `OrphanStat` 同处），此处只 re-export：排行页的行数据同时被 `analyzer.getRankingRows()`
// 与 webview 侧消费，放在 types.ts 才不会出现两处各自声明后的口径漂移。
export type { RankingRow, RankingSortOrder } from './types';

import type { RankingRow, RankingSortOrder, SessionOrigin } from './types';

// ---------------------------------------------------------------------------
// 2. 常量
// ---------------------------------------------------------------------------

/**
 * RankingPageSize：排行页每页展示的会话条数，固定 50（Requirement 13.6）。
 *
 * 为什么是「模块内 `PAGE_SIZE` + 对外 `RANKING_PAGE_SIZE` 转发」这两层：
 * 被 `toString()` 注入 webview 的 `pageOf` 会引用这个常量，而 tsc 的 CommonJS 输出会把
 * **被导出**的 `const` 引用重写成 `exports.RANKING_PAGE_SIZE`；webview 里没有 `exports`
 * 对象，注入的函数一执行就抛 `ReferenceError: exports is not defined`。
 * 未导出的模块级绑定不会被重写（编译后仍是裸标识符 `PAGE_SIZE`），因此**注入的函数体
 * 只允许引用模块内私有常量**，对外的导出名只作转发，供既有导入方与测试继续使用。
 */
const PAGE_SIZE = 50;

/**
 * 对外常量名（供 analyzer / 测试 / 文档引用）。值恒等于模块内的 `PAGE_SIZE`，
 * 两侧不存在第二个 `50`。注入 webview 的函数体**不得**引用本名（见上方注释）。
 */
export const RANKING_PAGE_SIZE = PAGE_SIZE;

// ---------------------------------------------------------------------------
// 3. 纯函数
// ---------------------------------------------------------------------------

/**
 * 排行页的排序比较函数（纯函数，全序）。
 *
 * 主键 `totalBytes` 随 `order` 反转；tiebreak 方向恒定：
 * `mtimeMs` 降序 → `sessionId` 字典序升序，**不**随 `order` 反转。
 *
 * 为什么 tiebreak 不反转：用户点表头在 `desc` / `asc` 之间来回切换时，
 * 占用合计相等的两行应保持同一相对次序，否则它们会莫名互换位置。
 *
 * 为什么是全序：`sessionId` 在同一目录内唯一，作为最后一级比较键使
 * 「三字段全等 ⟺ 返回 0」成立，因此同一输入的排序结果唯一。
 */
export function compareRankingRows(
  a: RankingRow,
  b: RankingRow,
  order: RankingSortOrder
): number {
  if (a.totalBytes !== b.totalBytes) {
    return order === 'desc' ? b.totalBytes - a.totalBytes : a.totalBytes - b.totalBytes;
  }
  // tiebreak 恒定方向：mtime 降序 → sessionId 字典序升序，不随 order 反转
  if (a.mtimeMs !== b.mtimeMs) { return b.mtimeMs - a.mtimeMs; }
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}
/** `pageOf` 的返回值：当前页的行 + 归一后的页码信息。 */
export interface RankingPage {
  /** 第 `page` 页对应的行（全量排序序列的 `[(page-1)*50, page*50)` 切片） */
  rows: RankingRow[];
  /** 归一后的 1-based 当前页码，恒满足 `1 ≤ page ≤ totalPages` */
  page: number;
  /** N = max(1, ceil(total / RANKING_PAGE_SIZE))，`total = 0` 时为 1 */
  totalPages: number;
  /** K：参与分页的全量行数 */
  total: number;
}

/**
 * 分页切片（纯函数，零 IO）：返回第 `page` 页（1-based）的行与页码信息。
 *
 * 算术定义（Requirement 13.6、13.7）：
 *   - `total = rows.length`（记为 K）
 *   - `totalPages = max(1, ceil(K / RANKING_PAGE_SIZE))`，故 K = 0 时为 1
 *     （空态仍要展示「第 1 / 1 页 · 共 0 个会话」，页码指示与分页控件结构不变）
 *   - 返回的 `page` = `clamp(1, totalPages)` 归一后的页码
 *   - `rows` = 全量按 `compareRankingRows(order)` 排序后的 `[(page-1)*50, page*50)` 切片
 *
 * `page` 入参的归一规则（对越界与脏值给出可预期结果，而不是抛错或返回空页）：
 *   - 非有限值（`NaN` / `±Infinity`）→ 视作 1
 *   - 非整数 → 先 `Math.floor` 取整（`1.9` → 1、`-0.5` → -1），再 clamp
 *   - `≤ 0` → 1；`> totalPages` → `totalPages`
 * 因此「清理后行数减少」（Requirement 13.17）只需把原页码原样传入，
 * clamp 自然给出 `min(M, N)`，调用方不必自己算。
 *
 * 排序在函数内部完成且作用于输入的**副本**：入参声明为 `readonly`，
 * 就不能用 `rows.sort()` 原地改调用方的数组——翻页是纯查询，不该有可观察副作用。
 */
export function pageOf(
  rows: readonly RankingRow[],
  order: RankingSortOrder,
  page: number
): RankingPage {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const requested = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(requested, 1), totalPages);

  const sorted = [...rows].sort((a, b) => compareRankingRows(a, b, order));
  const start = (current - 1) * PAGE_SIZE;

  return {
    rows: sorted.slice(start, start + PAGE_SIZE),
    page: current,
    totalPages,
    total,
  };
}

// ---------------------------------------------------------------------------
// 4. 取数（只读）
// ---------------------------------------------------------------------------

// 只从 `fs/promises` 具名导入三个读 API。写 API（`unlink` / `writeFile` / `rm` /
// `rename` / `cp`）连导入都不存在，因此 Requirement 13.14「取数路径仅只读访问磁盘」
// 是模块图上可静态审查的事实，而不是注释里的承诺。
import { readdir, stat, readFile } from 'fs/promises';
import * as path from 'path';
import type { ArchiveInfo } from '../credits';
import {
  determineSessionOrigin,
  isMigrationMarkerFileName,
  parseMigrationMarker,
} from '../session/origin';
import { computeSessionFootprint } from './analyzer';
import { MANIFEST_FILENAME } from './orphan';
import type { DirentLike, StatLike } from './scanner';

/**
 * 可注入的只读文件系统依赖，形状与 `OrphanFsDeps` 一致（同为 ReadOnlyPaths 成员）。
 * 只暴露 `readdir` / `stat` / `readFile`，调用面白名单因此可被属性测试直接断言；
 * 缺省退回 `fs/promises`，生产路径无额外抽象开销。
 */
export interface RankingFsDeps {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<DirentLike[]>;
  stat: (p: string) => Promise<StatLike>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
}

const realRankingFs: RankingFsDeps = {
  readdir: (p, o) => readdir(p, o) as unknown as Promise<DirentLike[]>,
  stat: (p) => stat(p) as unknown as Promise<StatLike>,
  readFile: (p, enc) => readFile(p, enc),
};

/**
 * `collectRankingRows` 的入参（签名固定自 design 的 UsageRankingPage 一节）。
 *
 * `archives` 是 ArchiveIndex 的**只读快照**，由调用方（`StorageAnalyzer`）用
 * `listArchiveEntries(storeRoot, { workspacePath })` 取得后传入——本函数刻意不自己
 * 调那个函数：存档索引带 4 秒节流与进程内缓存，若取数层各自触发刷新，同一次统计里
 * 「排行页看到的存档集合」与「摘要 / 孤儿判定看到的集合」就可能来自两个时刻的磁盘状态，
 * 守恒性质（Req 2.3）会在时间维度上被破坏。
 *
 * `storeRoot` 与 `workspacePath` 因此在本函数体内不被读取，保留在入参里的原因有两条：
 * 一是固定 design 给出的调用契约，二是它们标明了 `archives` 的取值范围（哪个
 * kiroagent 根、哪个工作区），审计一行取数调用时不必回溯到调用方去确认口径。
 */
export interface CollectRankingRowsInput {
  /** 当前工作区的 WorkspaceSessionDir 绝对路径 */
  sessionDir: string;
  /** kiroagent 目录；`archives` 的取值范围标注，本函数不据此枚举磁盘 */
  storeRoot: string;
  /** 当前工作区 fsPath；同上，仅为口径标注 */
  workspacePath: string;
  /** ArchiveIndex 只读快照（`listArchiveEntries` 的产出） */
  archives: readonly ArchiveInfo[];
}

export interface RankingRowsResult {
  rows: RankingRow[];
  /**
   * 未能计入的条目数（目录不可枚举、条目 stat 失败、符号链接）。
   * `> 0` 表示字节数为下限值，调用方据此置 `partial` 并在两个字节列加 `≥` 前缀（Req 13.10）。
   *
   * 标题来源的失败（清单损坏、单文件读不出）**不**计入：那只会让某行标题回退或为空，
   * 字节数与 mtime 仍然精确，把它算成跳过会让「≥」出现在完全准确的数值上。
   */
  skippedCount: number;
}

/** 只接受有限正数字节数，其余（NaN / 负数）按 0 计，避免污染合计。 */
function safeSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * 读取 SessionManifest，返回 sessionId → 官方标题 的映射；任何失败都返回空 Map。
 *
 * 与 `search.ts` 的 `loadTitleMap` 同一口径（顶层数组、逐项取 `sessionId` / `title`、
 * 只收非空白标题），只是改用异步只读 API。清单是标题的权威来源：单个会话文件里的
 * `title` 往往只是泛化的 "Agent"。
 *
 * 清单本身不是会话记录，其字节数不计入任何会话行（`sessions.json` 在枚举时被跳过）。
 */
async function loadManifestTitles(
  deps: RankingFsDeps,
  sessionDir: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = await deps.readFile(path.join(sessionDir, MANIFEST_FILENAME), 'utf8');
  } catch {
    return map; // 清单不存在或不可读：回退到单文件标题
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

/**
 * 采集本目录里 MigrationMarker（`._migration-<uuid>.json`）指向的 sessionId 集合
 * （Req 9.5）。集合语义：「这些会话已被官方迁移工具搬到 1.x 了」。
 *
 * 不复用 `session/origin.ts` 的 {@link collectMigratedSessionIds}——那份用同步 fs，
 * 本模块的 IO 面恒是注入的异步 `RankingFsDeps`（属性测试直接断言这个调用面）。
 * 复用的是它的**纯函数** {@link parseMigrationMarker}：逐字段校验 `v2SessionId`，
 * 因此判定规则只有一份，这里只负责把文件内容喂进去（origin.ts 模块注释的分工）。
 *
 * 单个标记读失败或内容非法都只跳过它：少一条证据只会让对应会话退化为
 * 「无标记」判定（结论偏保守的 `legacy-unmigrated`），而把 `undefined` 或半解析的值
 * 塞进集合会让一整批会话被误判为**已迁移**——那是旧残留清理敢删的前提。
 * 因此也**不**计入 `skippedCount`：字节数与 mtime 仍然精确，只是来源标注更保守。
 */
async function collectMigratedIds(
  deps: RankingFsDeps,
  sessionDir: string,
  entries: readonly DirentLike[]
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.isDirectory()) continue;
    if (!isMigrationMarkerFileName(entry.name)) continue;
    let raw: string;
    try {
      raw = await deps.readFile(path.join(sessionDir, entry.name), 'utf8');
    } catch {
      continue;
    }
    const marker = parseMigrationMarker(raw);
    if (marker) ids.add(marker.v2SessionId);
  }
  return ids;
}

/**
 * 回退标题：读该 SessionFile 自身的 `title`，再回退 `name`，都没有则空串
 * （与 `search.ts` 的 `rawTitle: obj?.title || obj?.name || ''` 同口径，含空串按缺失处理）。
 *
 * 取舍：这是**唯一**会打开会话文件内容的地方，且只在清单里查不到该 sessionId 时才发生
 * ——清单覆盖绝大多数会话，所以常态下取数完全不读会话内容，成本与会话体积无关。
 * 这里没有做「只读文件头」的优化：只读路径的白名单里只有 `readFile`（不含 fd 级
 * `open` / `read`），要截断读取就得引入新的 IO 面，为一条罕见回退路径不值得；
 * 解析失败一律当作无标题，不抛错、不计入 `skippedCount`。
 */
async function readSelfTitle(deps: RankingFsDeps, filePath: string): Promise<string> {
  let raw: string;
  try {
    raw = await deps.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return '';
  }
  const rec = obj as { title?: unknown; name?: unknown } | null;
  if (typeof rec?.title === 'string' && rec.title) return rec.title;
  if (typeof rec?.name === 'string' && rec.name) return rec.name;
  return '';
}

/**
 * 排行页取数（只读）：枚举当前工作区 WorkspaceSessionDir 下的**全部** SessionFile，
 * 恒以自身口径（`self`）算出每行占用（Req 13.2、13.4、13.14）。
 *
 * - 枚举**不做任何条数截断**：行集合由目录内容决定，与搜索面板的结果列表上限无关，
 *   因此返回行的 sessionId 集合恒等于该目录下全部 SessionFile 的 sessionId 集合
 * - `jsonBytes` / `mtimeMs` 恒取自该 SessionFile 自身的 `stat`（不含清单、不含存档）
 * - `archiveBytesSelf` 复用 `computeSessionFootprint({ scope: 'self' })` 归因，
 *   **不另写一套匹配逻辑**——否则排行页与摘要 / 孤儿判定会出现两套口径，
 *   「Σ 各会话自身口径存档部分 + 孤儿 = 存档总字节数」就不再成立
 * - `totalBytes = jsonBytes + archiveBytesSelf`，构造性成立而非另行累加
 * - 返回的 `RankingRow` 不带 lineage 数值：排行页恒 `self`，下发累计口径只会诱导出
 *   「两列可以相加」的误用
 * - `sessions.json` 清单与 `._migration-<uuid>.json` 迁移标记都**不是会话**，不成行；
 *   后者被单独读出来判定每行的 SessionOrigin（`migrated` / `legacy-unmigrated`，
 *   见循环末尾的注释）
 *
 * 单个条目的失败只累加 `skippedCount` 并继续，不向上抛异常（Req 9.1）：
 * 目录整体不可枚举 → `rows: []` + `skippedCount: 1`；某条目 stat 失败或是符号链接
 * → 跳过该条目（符号链接一律不跟随，见 Req 8.5）。
 *
 * 排序与分页不在这里做——`compareRankingRows` / `pageOf` 是纯函数，作用于本函数
 * 返回的全量数组，翻页与换序因此不产生任何文件系统调用（Req 7.13）。
 */
export async function collectRankingRows(
  input: CollectRankingRowsInput,
  deps: RankingFsDeps = realRankingFs
): Promise<RankingRowsResult> {
  const { sessionDir, archives } = input;
  const rows: RankingRow[] = [];
  let skippedCount = 0;

  let entries: DirentLike[];
  try {
    entries = await deps.readdir(sessionDir, { withFileTypes: true });
  } catch {
    // 会话目录不存在或不可读：没有可展示的行，且数值为下限（调用方据此置 partial）
    return { rows, skippedCount: 1 };
  }

  const titles = await loadManifestTitles(deps, sessionDir);
  // 迁移标记先于会话枚举读一遍：每行的 SessionOrigin 要用它（见循环末尾）
  const migratedIds = await collectMigratedIds(deps, sessionDir, entries);

  for (const entry of entries) {
    // 符号链接不跟随（避免循环链接与跨目录重复计数），但会让行集合不完整，故计入跳过
    if (entry.isSymbolicLink()) {
      skippedCount += 1;
      continue;
    }
    if (entry.isDirectory()) continue;
    // 清单不是会话记录，其字节数不计入任何会话行
    if (entry.name === MANIFEST_FILENAME) continue;
    // 迁移标记同样不是会话（名字也是 `.json`）：它记录「某会话已搬到 1.x」，
    // 计成一行会得到一条 sessionId 为 `._migration-<uuid>`、点进去必然跳转失败的
    // 幽灵行。与 `layout.ts` 的旧会话文件判定、`search.ts` 的 `listEntries` 同一口径；
    // 它的真实用途是上面的 `collectMigratedIds`。不计入 skippedCount：它本就不该成行。
    if (isMigrationMarkerFileName(entry.name)) continue;
    if (!entry.name.endsWith('.json')) continue;

    const sessionId = path.basename(entry.name, '.json');
    if (!sessionId) continue;

    const full = path.join(sessionDir, entry.name);
    let st: StatLike;
    try {
      st = await deps.stat(full);
    } catch {
      skippedCount += 1;
      continue;
    }
    if (st.isDirectory()) continue;

    // 标题：清单优先，回退该 SessionFile 自身的 title/name。空白标题原样保留，
    // 由 `getRankingHtml` 统一渲染成 `(无标题)`（Req 13.3）——取数层不替调用方兜文案，
    // 否则「无标题」既可能是真实标题也可能是占位符，渲染层无从区分。
    const title = titles.get(sessionId) ?? (await readSelfTitle(deps, full));

    const footprint = computeSessionFootprint(
      { sessionId, jsonBytes: safeSize(st.size), scope: 'self' },
      archives
    );

    rows.push({
      title,
      sessionId,
      jsonBytes: footprint.jsonBytes,
      archiveBytesSelf: footprint.archiveBytes,
      totalBytes: footprint.totalBytes,
      mtimeMs: Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0,
      // SessionOrigin 走 `session/origin.ts` 的唯一判定实现（Req 9.4、9.5）：
      // 本函数只枚举 0.9x 单文件布局，故 `source` 恒为 `'old'`，两种可能结论是
      // 「旧目录里有指向它的 MigrationMarker」→ `migrated`，否则 → `legacy-unmigrated`。
      //
      // `presentInOtherSide`（新目录里有同 sessionId 的会话目录，Req 9.8）此处**观测不到**
      // ——入参只有一个旧目录。省略它的偏差方向是刻意选的：一条确已迁移、但标记文件缺失
      // 的会话会被标成 `legacy-unmigrated`（「1.x 里看不见」），而反过来把未迁移会话标成
      // `migrated` 会让它落进旧残留清理的待删集合，删掉即永久丢失（design D8）。
      // 保守一侧只是展示偏保守，激进一侧会丢数据，所以宁可少判一个 `migrated`。
      // `both` 布局下把新旧两侧的行合并时（任务 12.2）由那一层用双侧集合再判一次。
      origin: determineSessionOrigin({
        sessionId,
        source: 'old',
        hasMigrationMarker: migratedIds.has(sessionId),
      }),
    });
  }

  return { rows, skippedCount };
}
// ---------------------------------------------------------------------------
// 5. HTML 渲染
// ---------------------------------------------------------------------------

// 与搜索面板唯一共用的东西：`escapeHtml`（转义口径必须逐字一致，两个 webview 各写一份
// 就会出现「一边转义了 `'` 一边没转」这类不对称）与 `size.ts` 的 `formatSize`
// （数值格式化恒同一进制与小数位）。DOM 结构、CSS、消息协议、状态机一律各自独立，
// 因此本文件**不**引用 `webview.ts` 的任何模板函数（见 design「为什么单独成文件」）。
// 别名导入 + 模块内同名局部绑定：tsc 的 CommonJS 输出会把**跨模块导入**的引用重写成
// `format_1.escapeHtml` / `size_1.formatSize`，而这两个命名空间对象在 webview 里不存在
// （与 `exports` 同一失败模式，注入的函数一执行就抛 ReferenceError）。改成先别名导入、
// 再赋给同名的模块内局部 `const`：重写只发生在这两行模块顶层，注入的函数体里恒是裸的
// `escapeHtml` / `formatSize`——正是 `injectedRankingScript()` 注入进去的函数声明名。
import { escapeHtml as escapeHtmlShared } from '../webview/format';
import { formatSize as formatSizeShared } from '../webview/size';

const escapeHtml = escapeHtmlShared;
const formatSize = formatSizeShared;

/**
 * 标题列展示上限（字符数），超出截断加省略号并把完整标题放 `title` 属性（Req 13.3）。
 * 同 `PAGE_SIZE`：模块内私有常量供注入的 `rankingTitleCell` 引用，导出名只作转发。
 */
const TITLE_MAX_CHARS = 120;

/** 空白标题的占位文案（Req 13.3）；与 `report.ts` 的排行占位文案一致。 */
const TITLE_PLACEHOLDER = '(无标题)';

/** 对外常量名（值恒等于 `TITLE_MAX_CHARS`）；注入 webview 的函数体不得引用本名。 */
export const RANKING_TITLE_MAX_CHARS = TITLE_MAX_CHARS;

/** 对外常量名（值恒等于 `TITLE_PLACEHOLDER`）；注入 webview 的函数体不得引用本名。 */
export const RANKING_TITLE_PLACEHOLDER = TITLE_PLACEHOLDER;

/**
 * MigrationStatus 的展示映射（Requirement 9.6）：每个 SessionOrigin 对应一个短标签
 * 与一条 tooltip，tooltip 同时说明**取值含义**与**该会话数据所在的根目录**。
 *
 * 声明为 `Record<SessionOrigin, …>`，故 `SessionOrigin` 将来新增取值时这里会编译报错，
 * 不会静默漏掉一个渲染分支。
 *
 * 同 `PAGE_SIZE` / `TITLE_MAX_CHARS`：这是**模块内私有**常量，供注入 webview 的
 * `migrationStatusCell` 引用；导出名只作转发（design D9）。
 *
 * 三条 tooltip 的措辞各有其必须说清的一点：
 * - `new`：数据只在 1.x 目录里，没有旧份要操心
 * - `migrated`：新旧可能各有一份，而本行占用**只**含新份（设计决策 D7）——不说清楚，
 *   用户会按这个数字估「删了能省多少」而估少
 * - `legacy-unmigrated`：该会话在 1.x 界面里**看不见**，删了不可恢复（design D8）。
 *   这是三者里唯一带破坏性后果的取值，必须写在用户手能碰到的地方
 */
const MIGRATION_META: Record<SessionOrigin, { label: string; title: string }> = {
  new: {
    label: '1.x 新建',
    title: 'Kiro 1.x 中新建的会话（sessionId 带 sess_ 前缀）。\n数据位于 ~/.kiro/sessions/<工作区哈希>/<会话 id>/',
  },
  migrated: {
    label: '已迁移',
    title:
      '由 0.9x 迁移而来的会话。\n数据以 ~/.kiro/sessions/<工作区哈希>/<会话 id>/ 下的新格式目录为准。\n若旧目录仍有同一会话的残留，那部分不计入本行占用，可在「旧残留」维度查看与清理。',
  },
  'legacy-unmigrated': {
    label: '未迁移',
    title:
      '仅存在于 0.9x 旧目录、尚未迁移到 1.x 的会话。\n数据位于 <UserDataDir>/User/globalStorage/kiro.kiroagent/workspace-sessions/<编码键>/。\n该会话在 Kiro 1.x 界面中不可见；如需继续对话请先在 Kiro 内手动迁移，删除后不可恢复。',
  },
};

/** 对外转发名（供测试与文档引用）；注入 webview 的函数体不得引用本名。 */
export const RANKING_MIGRATION_META = MIGRATION_META;

/**
 * MigrationStatus 单元格的展示内容（纯函数，**未转义**——转义由调用方统一做）。
 *
 * `origin` 取 `unknown` 而不是 `SessionOrigin`：这个值来自宿主下发的 JSON，在 webview 侧
 * 没有类型保护；取值超出三者时给一个中性的「未知」而不是抛错或渲染成空白单元格——
 * 空白会被读成「这一行没来源信息」，而实际是「解析不出来」。
 *
 * `key` 用于 CSS class（`mig-new` / `mig-migrated` / …），故恒为受控的 ASCII 标识符，
 * 不会把宿主 JSON 里的任意字符串带进 class 属性。
 */
export function migrationStatusCell(origin: unknown): {
  key: string;
  label: string;
  title: string;
} {
  const table = MIGRATION_META as Record<string, { label: string; title: string }>;
  const meta = typeof origin === 'string' ? table[origin] : undefined;
  if (meta) return { key: String(origin), label: meta.label, title: meta.title };
  return {
    key: 'unknown',
    label: '未知',
    title: '未能判定该会话的来源（取值不在 new / migrated / legacy-unmigrated 之内）',
  };
}

/* ---------------- 排行表之上的三个聚合维度（Req 7.1、7.11、8.2） ---------------- */

/** 三个聚合维度的标识。 */
export type AggregateKind = 'project' | 'allKiro' | 'legacyResidue';

/**
 * 一个聚合维度下发给 webview 的**展示视图**。
 *
 * 刻意不直接下发 `AggregateTotal` / `LegacyResidueTotal`，而是一个「并集 + 全部可选」的
 * 扁平结构：三个维度的 tooltip 需要的信息不同（旧残留要两分、当前项目要「被剔除的旧份」、
 * 整个 Kiro 两者都不要），下发并集让**一个**渲染函数覆盖三种维度，webview 侧不必按 kind 分支
 * 取字段；而字段全部可选，使某维度暂时给不出某项时自然省略那一行 tooltip，而不是显示 0
 * ——0 会被读成「确实是零」。
 */
export interface AggregateView {
  state: 'idle' | 'loading' | 'ok' | 'unavailable';
  bytes: number;
  files: number;
  sessionCount: number;
  workspaceCount: number;
  partial: boolean;
  skippedCount: number;
  roots: string[];
  /** 会话本体字节数（Req 7.11 的拆解之一） */
  sessionBytes?: number;
  /** 快照 / 附件字节数（Req 7.11 的拆解之二） */
  attachmentBytes?: number;
  /** `both` 下被新格式取代、未计入本合计的旧份字节数（Req 6.7 / design D7） */
  supersededBytes?: number;
  /** 旧残留维度：已迁移仅残留（可清理）字节数（Req 8.6） */
  migratedResidueBytes?: number;
  /** 旧残留维度：未迁移或无法按会话归属（默认不清理）字节数（Req 8.6） */
  unmigratedBytes?: number;
}

/**
 * 三个维度的标签、口径说明与固定注记。
 *
 * 同 `PAGE_SIZE`：**模块内私有**常量，供注入 webview 的 `aggregateDisplay` 引用（design D9）。
 */
const AGGREGATE_META: Record<AggregateKind, { label: string; scope: string; notes: string[] }> = {
  project: {
    label: '当前项目会话总占用',
    scope: '口径：本工作区全部会话的自身占用合计（各会话两两不重叠，可相加）',
    notes: ['随排行数据一同得出，与表格来自同一次枚举'],
  },
  allKiro: {
    label: '整个 Kiro 会话总占用',
    scope: '口径：~/.kiro/sessions 下全部工作区目录的会话占用合计',
    notes: [
      '只统计会话数据；0.9x 旧格式残留不计入本维度，见「旧格式残留」',
      '手动触发并缓存；清理之后自动失效并在下次统计时反映新值',
    ],
  },
  legacyResidue: {
    label: '旧格式残留',
    scope: '口径：0.9x 旧目录（workspace-sessions 与各工作区执行数据目录）里仍在占盘的数据',
    notes: [
      '与「整个 Kiro 会话总占用」相互独立，默认不计入后者，以免主流程承担这份重量级扫描',
      '「未迁移」部分的会话在 Kiro 1.x 界面中不可见，删除后不可恢复，故默认排除在清理之外',
    ],
  },
};

/** 非 `ok` 三态的数值位文案；同为模块内私有常量（供注入函数引用）。 */
const AGGREGATE_STATE_TEXT: Record<string, string> = {
  idle: '未统计',
  loading: '统计中…',
  unavailable: '不可用',
};

/**
 * 一个聚合维度的数值文本与 tooltip（纯函数，**未转义**——由调用方 `textContent` /
 * `title` 赋值，不拼 HTML）。
 *
 * 与 `renderRankingRowHtml` 同一手法：webview 侧运行的就是这个函数（`toString()` 注入），
 * Node 侧测试调用的也是它，两侧同源。
 *
 * `kind` / `view` 取 `unknown`：它们来自宿主下发的 JSON，webview 侧没有类型保护。
 * 任何字段缺失或变型都退化为省略对应那一行，绝不抛错——一个维度的坏数据不该让整段脚本
 * 停住（那会连带表格一起白屏，正是 design D9 记录过的那类事故）。
 *
 * `partial` 为真时数值加 `≥` 前缀并在 tooltip 给出 `skippedCount`（Req 7.12）。
 */
export function aggregateDisplay(kind: unknown, view: unknown): { value: string; title: string } {
  const metaTable = AGGREGATE_META as Record<
    string,
    { label: string; scope: string; notes: string[] }
  >;
  const meta = typeof kind === 'string' && metaTable[kind] ? metaTable[kind] : null;
  const v = (view && typeof view === 'object' ? view : {}) as Record<string, unknown>;
  const num = (x: unknown): number =>
    typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0;
  const has = (x: unknown): boolean => typeof x === 'number' && isFinite(x);

  const state = typeof v.state === 'string' ? v.state : 'idle';
  const lines: string[] = [];
  if (meta) {
    lines.push(meta.label);
    lines.push(meta.scope);
  }

  // 非 ok 三态：数值位放状态文案，tooltip 仍给出口径与固定注记，
  // 使用户在「还没统计」时也能先看懂这个维度是什么
  if (state !== 'ok') {
    const stateText = AGGREGATE_STATE_TEXT[state] || AGGREGATE_STATE_TEXT.idle;
    if (state === 'unavailable') {
      lines.push('对应目录不存在或不可读；其余维度与表格不受影响');
    } else if (state === 'idle') {
      lines.push('尚未统计：点击右侧按钮开始（在此之前不会枚举对应目录）');
    } else {
      lines.push('正在统计…');
    }
    if (meta) for (const n of meta.notes) lines.push(n);
    return { value: stateText, title: lines.join('\n') };
  }

  const partial = v.partial === true;
  lines.push(
    '参与统计：' +
      num(v.sessionCount) +
      ' 个会话 · ' +
      num(v.workspaceCount) +
      ' 个工作区目录 · ' +
      num(v.files) +
      ' 个文件'
  );
  if (has(v.sessionBytes) || has(v.attachmentBytes)) {
    lines.push(
      '其中会话本体 ' +
        formatSize(num(v.sessionBytes)) +
        ' + 快照/附件 ' +
        formatSize(num(v.attachmentBytes))
    );
  }
  if (has(v.migratedResidueBytes) || has(v.unmigratedBytes)) {
    lines.push(
      '已迁移仅残留 ' +
        formatSize(num(v.migratedResidueBytes)) +
        '（可清理） · 未迁移或无法按会话归属 ' +
        formatSize(num(v.unmigratedBytes)) +
        '（默认不清理）'
    );
  }
  if (num(v.supersededBytes) > 0) {
    lines.push(
      '另有 ' +
        formatSize(num(v.supersededBytes)) +
        ' 同名会话的旧格式残留未计入本合计（该会话已迁移、旧份未清），' +
        '因此单个会话行显示的占用小于它在磁盘上的实际总和；那部分见「旧格式残留」维度'
    );
  }
  if (partial) {
    lines.push('统计不完整：已跳过 ' + num(v.skippedCount) + ' 个条目，数值为下限（故带 ≥ 前缀）');
  }
  const roots = Array.isArray(v.roots) ? v.roots : [];
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    if (typeof r === 'string' && r) lines.push('统计根：' + r);
  }
  if (meta) for (const n of meta.notes) lines.push(n);

  return { value: (partial ? '≥' : '') + formatSize(num(v.bytes)), title: lines.join('\n') };
}

/** 把 `AggregateTotal` 折成展示视图（AllKiroSessionTotal 用）。 */
export function aggregateViewOf(total: {
  state: AggregateView['state'];
  bytes: number;
  files: number;
  sessionCount: number;
  workspaceCount: number;
  partial: boolean;
  skippedCount: number;
  roots: readonly string[];
}): AggregateView {
  return {
    state: total.state,
    bytes: total.bytes,
    files: total.files,
    sessionCount: total.sessionCount,
    workspaceCount: total.workspaceCount,
    partial: total.partial,
    skippedCount: total.skippedCount,
    roots: [...total.roots],
  };
}

/** 把 `LegacyResidueTotal` 折成展示视图（追加 Req 8.6 的两分）。 */
export function legacyResidueViewOf(
  total: Parameters<typeof aggregateViewOf>[0] & {
    migratedResidueBytes: number;
    unmigratedBytes: number;
  }
): AggregateView {
  return {
    ...aggregateViewOf(total),
    migratedResidueBytes: total.migratedResidueBytes,
    unmigratedBytes: total.unmigratedBytes,
  };
}

/**
 * 把一次双布局合并结果折成 ProjectSessionTotal 的展示视图（Req 7.2、7.3、7.11）。
 *
 * 入参声明为结构类型而不是 `import type { MergedRankingRows }`：本模块只需要这五项，
 * 窄接口让「排行页依赖 analyzer 的内部形状」这条边尽量细；`analyzer.getMergedRankingRows()`
 * 的返回值可原样传入（多出的属性不影响赋值）。
 *
 * `supersededBytes` 由 `residue.superseded` 现算：那是 `both` 布局下被新格式顶掉、
 * 因而**未**计入本合计的旧份字节数（design D7），tooltip 必须点明，否则用户按这个数字
 * 估「删了能省多少」会估少。
 */
export function projectSessionViewOf(merged: {
  totalBytes: number;
  sessionBytes: number;
  attachmentBytes: number;
  files: number;
  sessionCount: number;
  partial: boolean;
  skippedCount: number;
  roots: readonly string[];
  sides: { newLayout: boolean; oldLayout: boolean };
  residue: { superseded: readonly { bytes: number }[] };
}): AggregateView {
  const observed = merged.sides.newLayout || merged.sides.oldLayout;
  let supersededBytes = 0;
  for (const s of merged.residue.superseded) {
    const b = s && typeof s.bytes === 'number' && isFinite(s.bytes) && s.bytes > 0 ? s.bytes : 0;
    supersededBytes += b;
  }
  return {
    state: observed ? 'ok' : 'unavailable',
    bytes: merged.totalBytes,
    files: merged.files,
    sessionCount: merged.sessionCount,
    // 单工作区维度：观测到任一侧即为 1（与 `projectSessionTotalFrom` 同口径）
    workspaceCount: observed ? 1 : 0,
    partial: merged.partial,
    skippedCount: merged.skippedCount,
    roots: [...merged.roots],
    sessionBytes: merged.sessionBytes,
    attachmentBytes: merged.attachmentBytes,
    supersededBytes,
  };
}

/**
 * 最后修改时间的展示格式化：本地时区的 `YYYY-MM-DD HH:mm`（Req 13.3）。
 *
 * 与搜索面板的 `fmtTime`（今天 / 同年 / 跨年 三档相对格式）**刻意不同**：排行页是
 * 用于横向比较与清理决策的表格，相对格式会让「今天 09:12」与「05-01 09:12」出现在
 * 同一列里无法对齐，也无法按字符串直接比较先后。
 *
 * 入参归一：非数值 / 非有限值按 0（epoch）计，并把毫秒钳制在
 * `[0, 253402300799999]`（即 1970-01-01 ~ 9999-12-31）。这样年份恒为 4 位、
 * 输出恒严格匹配 `YYYY-MM-DD HH:mm`（Property 24），不会因越界毫秒退化成
 * `Invalid Date`、六位年份或负数年份。真实 `stat` 的 mtime 落不到钳制区间外，
 * 因此这层归一只对损坏值与测试极值生效。
 */
export function formatRankingTime(ms: number): string {
  const raw = typeof ms === 'number' && isFinite(ms) ? ms : 0;
  const clamped = raw < 0 ? 0 : raw > 253402300799999 ? 253402300799999 : raw;
  const d = new Date(clamped);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    String(d.getFullYear()).padStart(4, '0') +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

/**
 * 标题列的展示文本与 tooltip 文本（纯函数，**未转义**——转义由调用方统一做）。
 *
 * 规则（Req 13.3）：
 *   - 空字符串或仅含空白 → `text` = `full` = `(无标题)`
 *   - 长度 > 120 → `text` = 前 120 个字符 + `…`，`full` = 完整标题，`truncated: true`
 *   - 其余 → 原样
 *
 * 为什么先截断再转义（调用方顺序）：反过来会把 `&amp;` 这类实体从中间切断，
 * 得到 `&am` 这种既非文本也非实体的残片。
 *
 * 为什么按原始长度判断而**不**先折叠空白（`report.ts` 的 `flat` 做法）：
 * 折叠会让一个 150 字符、含大量空格的标题缩到 120 以内从而不再截断，
 * 「超 120 字符恒截断」就不成立了。HTML 本身会把连续空白折叠显示，
 * 表格列另有 CSS 省略号兜底，所以不折叠不影响观感。
 *
 * 长度按 UTF-16 码元计（与 Req 的「个字符」和 `report.ts` 同口径）。在 120 处切断
 * 理论上可能劈开一个代理对，留下孤立代理——它经 `escapeHtml` 后仍是安全文本，
 * 最坏只是末字符显示为替换符，不构成注入面。
 */
export function rankingTitleCell(title: string): {
  text: string;
  full: string;
  truncated: boolean;
} {
  const raw = typeof title === 'string' ? title : '';
  if (raw.trim() === '') {
    return { text: TITLE_PLACEHOLDER, full: TITLE_PLACEHOLDER, truncated: false };
  }
  if (raw.length > TITLE_MAX_CHARS) {
    return { text: raw.slice(0, TITLE_MAX_CHARS) + '…', full: raw, truncated: true };
  }
  return { text: raw, full: raw, truncated: false };
}

/**
 * 渲染单个会话行（`<tr>`）。**纯函数**，可在 Node 端直接调用。
 *
 * 为什么把行渲染做成导出的纯函数、而不是写在注入脚本的闭包里：Property 24 要断言
 * 行渲染的六列内容、标题占位与截断、时间格式与转义完整性。若渲染逻辑只以字符串形式
 * 存在于 `getRankingHtml` 的 `<script>` 里，测试就只能对整页 HTML 做正则考古，或者
 * 起一个 DOM 环境执行注入脚本——前者测不到真实行为，后者引入 jsdom 依赖。
 * 现在的做法是：webview 侧运行的**就是这个函数**（经 `toString()` 注入，见
 * `injectedRankingScript`），Node 侧测试调用的也是它，两侧实现同源，不存在漂移。
 *
 * 六列 + 一列操作（Req 13.3、13.11）：会话标题、sessionId、会话 JSON 字节数、
 * 归因存档字节数、占用合计、最后修改时间、清理入口。
 *
 * `partial` 为 true 时 `≥` 前缀**只**加在「归因存档字节数」与「占用合计」两列
 * （Req 13.10）：会话 JSON 字节数来自对单个文件的 `stat`，跳过其它条目不影响它的
 * 精确性，加 `≥` 反而误导。
 *
 * 所有动态文本（标题、sessionId、`data-*` 属性值）一律先过 `escapeHtml`（Req 13.13）；
 * 数值与时间由格式化函数产出，字符集恒为 `[0-9.:\-A-Z ≥]`，不含可构成标签的字符。
 */
export function renderRankingRowHtml(row: RankingRow, partial: boolean): string {
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
  const cell = rankingTitleCell(row && typeof row.title === 'string' ? row.title : '');
  const titleText = escapeHtml(cell.text);
  const titleFull = escapeHtml(cell.full);
  const id = escapeHtml(row && typeof row.sessionId === 'string' ? row.sessionId : '');
  // MigrationStatus（Req 9.6）：只影响展示，不参与排序，故列结构变了而排序规则没变
  const mig = migrationStatusCell(row && row.origin);
  // `≥` 只作用于后两个字节列
  const pfx = partial === true ? '≥' : '';
  return (
    '<tr class="rank-row" data-session-id="' +
    id +
    '" data-title="' +
    titleFull +
    '">' +
    '<td class="c-title" title="' +
    titleFull +
    '"><span class="t">' +
    titleText +
    '</span></td>' +
    '<td class="c-origin"><span class="mig mig-' +
    escapeHtml(mig.key) +
    '" title="' +
    escapeHtml(mig.title) +
    '">' +
    escapeHtml(mig.label) +
    '</span></td>' +
    '<td class="c-id"><code>' +
    id +
    '</code></td>' +
    '<td class="c-num">' +
    formatSize(num(row && row.jsonBytes)) +
    '</td>' +
    '<td class="c-num">' +
    pfx +
    formatSize(num(row && row.archiveBytesSelf)) +
    '</td>' +
    '<td class="c-num c-total">' +
    pfx +
    formatSize(num(row && row.totalBytes)) +
    '</td>' +
    '<td class="c-time">' +
    formatRankingTime(row && row.mtimeMs) +
    '</td>' +
    '<td class="c-ops">' +
    '<button class="op" type="button" data-mode="attachment" title="清理存档：删除归因到该会话的执行存档，保留对话本体">清理存档</button>' +
    '<button class="op danger" type="button" data-mode="full" title="删除会话：删除该会话的执行存档与对话本体，并从会话清单中移除该条目">删除会话</button>' +
    '</td>' +
    '</tr>'
  );
}

/**
 * 把宿主侧的纯函数序列化进内联脚本，保证 webview 运行时与单元测试跑的是同一实现
 * （与 `webview.ts` 的 `injectedFormatScript()` 同一手法）。
 *
 * 常量以字面量形式先声明：`pageOf` 引用 `PAGE_SIZE`、`rankingTitleCell` 引用
 * `TITLE_MAX_CHARS` / `TITLE_PLACEHOLDER`，函数被 `toString()` 摘出模块作用域后
 * 这些自由变量必须在注入现场补齐。声明**由宿主常量的实际值生成**（而不是另抄一份
 * 字面量），因此两侧不存在第二个 `50` / `120` / 占位文案，也不可能漂移。
 *
 * 名字必须与函数体里出现的名字逐字一致，而函数体里出现什么名字由 tsc 决定：
 * 被导出的 `const` 会被重写成 `exports.X`、跨模块导入会被重写成 `mod_1.X`，两者在
 * webview 里都不存在。所以模块内的私有绑定（`PAGE_SIZE` / `TITLE_MAX_CHARS` /
 * `TITLE_PLACEHOLDER` / 同名局部 `escapeHtml` / `formatSize`）才是注入函数唯一
 * 可以引用的东西——`tests/storage.ranking.spec.ts` 里的 `exports.` / `mod_1.` 扫描
 * 守卫会在编译产物上钉住这条约束。
 *
 * 注入顺序无关（函数声明提升），但常量声明必须在最前：它们是 `const`，
 * 运行时求值早于任何函数调用即可。
 */
function injectedRankingScript(): string {
  return [
    'const PAGE_SIZE = ' + JSON.stringify(PAGE_SIZE) + ';',
    'const TITLE_MAX_CHARS = ' + JSON.stringify(TITLE_MAX_CHARS) + ';',
    'const TITLE_PLACEHOLDER = ' + JSON.stringify(TITLE_PLACEHOLDER) + ';',
    'const MIGRATION_META = ' + JSON.stringify(MIGRATION_META) + ';',
    'const AGGREGATE_META = ' + JSON.stringify(AGGREGATE_META) + ';',
    'const AGGREGATE_STATE_TEXT = ' + JSON.stringify(AGGREGATE_STATE_TEXT) + ';',
    escapeHtml.toString(),
    formatSize.toString(),
    formatRankingTime.toString(),
    rankingTitleCell.toString(),
    migrationStatusCell.toString(),
    aggregateDisplay.toString(),
    renderRankingRowHtml.toString(),
    compareRankingRows.toString(),
    pageOf.toString(),
  ].join('\n');
}

/**
 * 排行页 HTML（纯函数：除 `cspSource` / `nonce` 两个入参外不碰 vscode API，
 * 因此可在 Node 端直接生成并做字符串断言）。
 *
 * CSP 与搜索面板逐条相同（Req 13.13）：`default-src 'none'`、
 * `style-src ${cspSource} 'unsafe-inline'`、`script-src 'nonce-${nonce}'`、
 * `font-src` / `img-src` 同源。页面无外部资源、无 `eval`、无内联 `on*` 属性，
 * 全部交互都在带 nonce 的单个 `<script>` 里用 `addEventListener` 绑定。
 *
 * 静态骨架 + 注入脚本的分工：宿主只下发**数据**（`RankingRow[]`），排序 / 分页 /
 * 行渲染全部在 webview 侧用注入的纯函数完成，因此换序与翻页恒不回宿主、
 * 不产生任何文件系统调用（Req 7.13、13.6~13.8）。
 *
 * ── 消息协议（供任务 16.4 `RankingPanel` 接线）────────────────────────────────
 *
 * 宿主 → webview：
 *   - `{ type: 'state', state: 'loading' | 'empty' | 'no-workspace' | 'unavailable' }`
 *       切换状态机。`loading` 保留当前已渲染的行（只置灰控件、显示「统计中…」，
 *       面板始终可关闭，Req 13.15）；`no-workspace` / `unavailable` 清空行集合。
 *       `ok` 不由本消息进入——它恒由 `rows` 消息携带数据后进入，
 *       避免出现「状态是 ok 但没有数据」的中间态。
 *   - `{ type: 'rows', rows: RankingRow[], partial: boolean, skippedCount: number, project? }`
 *       下发**全量**行（不是当前页）。`rows.length > 0` → `ok`，`=== 0` → `empty`。
 *       当前页码不重置，交给 `pageOf` 的 clamp 归一为 `min(M, N)`
 *       ——清理后行数减少时正是 Req 13.17 要的行为，宿主不必自己算页码。
 *       `project` 是 ProjectSessionTotal 的展示视图，搭这条消息下发以保证它与表格
 *       来自**同一次**枚举（Req 7.3）。
 *   - `{ type: 'aggregate', kind: 'allKiro' | 'legacyResidue' | 'project', view }`
 *       单个聚合维度到货。只重绘该维度，表格与另外两个维度不受影响——
 *       Req 7.9 要求聚合统计期间排行表保持可浏览，解耦是它的实现方式。
 *   - `{ type: 'layout', layout: StorageLayout }`
 *       布局结论；`old-only` 时 webview 隐藏旧残留维度（Req 8.3）。
 *
 * webview → 宿主：
 *   - `{ type: 'ready' }`                     webview 脚本就绪，宿主可开始首次取数
 *   - `{ type: 'refresh' }`                   点击刷新控件（宿主强制重取、忽略 60s 缓存，Req 13.12）
 *   - `{ type: 'computeAggregate', kind: 'allKiro' | 'legacyResidue' }`
 *                                             手动触发一个重量级聚合维度（Req 7.5、8.2）。
 *                                             **这是那两个维度唯一的启动入口**：在它到达之前，
 *                                             其它工作区目录与旧残留目录一次都不会被枚举
 *                                             （Req 7.8、8.4）
 *   - `{ type: 'cleanup', mode: 'attachment' | 'full', sessionId, title }`
 *                                             行内清理入口（Req 13.11）；`title` 为完整
 *                                             未截断标题，供确认提示与审计文案使用
 *
 * 排序方向与页码**不**上报宿主：它们是纯展示状态，存活在 webview 侧
 * （`vscode.setState` 备份，配合 `retainContextWhenHidden` 使隐藏不丢），
 * 面板关闭后自然回到 `page: 1` / `sortOrder: 'desc'`（Req 13.1）。
 */
export function getRankingHtml(cspSource: string, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>存储占用排行</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-editor-background);
  }
  body {
    display: flex;
    flex-direction: column;
    padding: 12px 14px;
    gap: 10px;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .status {
    font-size: 12px;
    opacity: .75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .status.error { color: var(--vscode-errorForeground); opacity: 1; }
  .spacer { flex: 1; }
  .refresh-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    cursor: pointer;
    opacity: .7;
    transition: opacity .12s ease, background .12s ease;
  }
  .refresh-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.2)); }
  .refresh-btn svg { width: 15px; height: 15px; }
  .refresh-btn.spinning svg { animation: kcs-spin .7s linear infinite; }
  .refresh-btn.disabled { opacity: .35; pointer-events: none; }
  @keyframes kcs-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  /* 排行表之上的三个聚合维度（Req 7.1、8.2） */
  .agg-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    flex-shrink: 0;
  }
  .agg {
    display: inline-flex;
    align-items: baseline;
    gap: 7px;
    padding: 6px 10px;
    border-radius: 7px;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    background: var(--vscode-editorWidget-background, rgba(127,127,127,.07));
    cursor: help;
  }
  .agg.hidden { display: none; }
  .agg-label { font-size: 11px; opacity: .8; white-space: nowrap; }
  .agg-value {
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .agg-value.muted { font-weight: 400; opacity: .6; }
  .agg-btn {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18));
    color: var(--vscode-button-secondaryForeground, inherit);
    cursor: pointer;
  }
  .agg-btn:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
  .agg-btn:disabled { opacity: .4; cursor: default; }
  .agg-btn.danger { color: var(--vscode-errorForeground); }
  .agg-btn[hidden] { display: none; }
  .table-wrap {
    flex: 1;
    overflow: auto;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    border-radius: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    text-align: left;
    font-weight: 600;
    padding: 7px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    white-space: nowrap;
  }
  tbody td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.12));
    vertical-align: middle;
  }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  th.c-num, td.c-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.c-total { font-weight: 600; }
  th.c-time, td.c-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
  th.c-title { width: 40%; }
  td.c-title { max-width: 0; }
  td.c-title .t {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  td.c-id code {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    opacity: .8;
  }
  th.c-origin, td.c-origin { white-space: nowrap; }
  .mig {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    line-height: 15px;
    cursor: help;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.3));
    background: var(--vscode-badge-background, rgba(127,127,127,.18));
    color: var(--vscode-badge-foreground, inherit);
  }
  /* 未迁移是唯一带破坏性后果的取值（1.x 里看不见、删了不可恢复），用警示色标出来 */
  .mig-legacy-unmigrated {
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
    background: transparent;
  }
  .mig-new { opacity: .85; }
  .mig-unknown { opacity: .6; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--vscode-textLink-foreground); }
  th.sortable.disabled { cursor: default; opacity: .5; }
  th.sortable .arrow { font-size: 9px; opacity: .8; }
  td.c-ops { white-space: nowrap; text-align: right; }
  button.op {
    font-size: 11px;
    padding: 2px 8px;
    margin-left: 6px;
    border-radius: 5px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18));
    color: var(--vscode-button-secondaryForeground, inherit);
    cursor: pointer;
  }
  button.op:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
  button.op.danger { color: var(--vscode-errorForeground); }
  button.op:disabled { opacity: .4; cursor: default; }
  .empty {
    padding: 22px 8px;
    text-align: center;
    font-size: 12px;
    opacity: .65;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    font-size: 11px;
  }
  .page-info { opacity: .8; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .partial-note { opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button.page-btn {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 5px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.18));
    color: var(--vscode-button-secondaryForeground, inherit);
    cursor: pointer;
  }
  button.page-btn:hover:enabled { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
  button.page-btn:disabled { opacity: .4; cursor: default; }
</style>
</head>
<body>
  <div class="toolbar">
    <div id="status" class="status">统计中…</div>
    <div class="spacer"></div>
    <span id="refresh" class="refresh-btn" role="button" tabindex="0" title="刷新（强制重新统计，忽略缓存有效期）" aria-label="刷新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
      </svg>
    </span>
  </div>
  <div class="agg-bar">
    <div class="agg" id="aggProject" title="">
      <span class="agg-label">当前项目会话</span>
      <span class="agg-value muted" id="valProject">未统计</span>
    </div>
    <div class="agg" id="aggAllKiro" title="">
      <span class="agg-label">整个 Kiro 会话</span>
      <span class="agg-value muted" id="valAllKiro">未统计</span>
      <button class="agg-btn" id="btnAllKiro" type="button" title="统计 ~/.kiro/sessions 下全部工作区目录的会话占用（手动触发，结果会被缓存）">统计</button>
    </div>
    <div class="agg" id="aggLegacy" title="">
      <span class="agg-label">旧格式残留</span>
      <span class="agg-value muted" id="valLegacy">未统计</span>
      <button class="agg-btn" id="btnLegacy" type="button" title="统计 0.9x 旧目录里仍在占盘的数据（手动触发，扫描量可能很大）">统计</button>
      <button class="agg-btn danger" id="btnLegacyClean" type="button" title="清理旧残留：只删除「已迁移仅残留」部分，未迁移的会话默认排除在外" hidden>清理</button>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th class="c-title">会话标题</th>
          <th class="c-origin">来源</th>
          <th class="c-id">sessionId</th>
          <th class="c-num">会话 JSON</th>
          <th class="c-num">归因存档</th>
          <th id="thTotal" class="c-num sortable" role="button" tabindex="0" title="点击切换占用合计的升序 / 降序">占用合计 <span id="sortArrow" class="arrow">▼</span></th>
          <th class="c-time">最后修改</th>
          <th class="c-ops">操作</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" class="empty">统计中…</div>
  </div>
  <div class="footer">
    <span id="pageInfo" class="page-info">第 1 / 1 页 · 共 0 个会话</span>
    <span id="partialNote" class="partial-note"></span>
    <span class="spacer"></span>
    <button id="prev" class="page-btn" type="button" disabled>上一页</button>
    <button id="next" class="page-btn" type="button" disabled>下一页</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $status = document.getElementById('status');
  const $refresh = document.getElementById('refresh');
  const $rows = document.getElementById('rows');
  const $empty = document.getElementById('empty');
  const $pageInfo = document.getElementById('pageInfo');
  const $partialNote = document.getElementById('partialNote');
  const $prev = document.getElementById('prev');
  const $next = document.getElementById('next');
  const $thTotal = document.getElementById('thTotal');
  const $sortArrow = document.getElementById('sortArrow');
  // 三个聚合维度：容器（tooltip 挂这里）、数值位、手动触发按钮（当前项目维度没有按钮）
  const AGG_EL = {
    project: { box: document.getElementById('aggProject'), val: document.getElementById('valProject'), btn: null },
    allKiro: { box: document.getElementById('aggAllKiro'), val: document.getElementById('valAllKiro'), btn: document.getElementById('btnAllKiro') },
    legacyResidue: { box: document.getElementById('aggLegacy'), val: document.getElementById('valLegacy'), btn: document.getElementById('btnLegacy') }
  };
  // 旧残留的清理入口：只在该维度**已完成统计**且确有可清理部分时才出现（Req 11.1）。
  // 「统计之后才给清理」不是 UI 洁癖：待删清单正是那次统计的产物，没统计就没有清单，
  // 此时给出按钮只能得到一个空计划。
  const $legacyClean = document.getElementById('btnLegacyClean');

  ${injectedRankingScript()}

  // 宿主下发的全量行（RankingRow[]，恒 self 口径）；排序与分页只作用于它，不回宿主
  let allRows = [];
  let partial = false;
  let skippedCount = 0;
  // RankingViewState：仅在本实例存续期内有效（Req 13.1）
  let sortOrder = 'desc';
  let page = 1;
  let state = 'loading';
  let view = { page: 1, totalPages: 1, total: 0 };
  /**
   * 三个聚合维度各自的视图（Req 7.1、8.2）。与表格的状态机完全解耦：
   * 某个维度在统计中不会置灰表格，表格在统计中也不影响这三块 —— Req 7.9 要求
   * 「聚合维度统计期间保持排行表可浏览与面板可关闭」，解耦是它的实现方式。
   */
  let aggViews = {
    project: { state: 'idle' },
    allKiro: { state: 'idle' },
    legacyResidue: { state: 'idle' }
  };

  // 五态文案（Req 13.9、13.15、13.16）；'ok' 的文案按行数动态拼，不在表内
  const STATE_TEXT = {
    loading: '统计中…',
    empty: '当前项目还没有可统计的会话',
    'no-workspace': '未打开工作区，无法统计会话占用',
    unavailable: '占用统计不可用'
  };

  // 恢复上次的排序方向与页码（retainContextWhenHidden 下隐藏不销毁，这里只兜重载）
  try {
    const st = vscode.getState && vscode.getState();
    if (st) {
      if (st.sortOrder === 'asc' || st.sortOrder === 'desc') sortOrder = st.sortOrder;
      if (typeof st.page === 'number' && isFinite(st.page)) page = st.page;
    }
  } catch (e) {}

  function saveState() {
    try { vscode.setState && vscode.setState({ page: page, sortOrder: sortOrder }); } catch (e) {}
  }

  function canRefresh() { return state !== 'loading' && state !== 'no-workspace'; }
  function canInteract() { return state === 'ok'; }

  /**
   * 重绘一个聚合维度：数值位与 tooltip 都由注入的 aggregateDisplay 算出，
   * 用 textContent / title 赋值而不拼 HTML，故路径与数值文本天然不进 DOM 解析
   * （Req 7.14 的转义要求在这里由 API 选择保证，比事后转义更难写错）。
   */
  function renderAggregate(kind) {
    const el = AGG_EL[kind];
    if (!el || !el.box || !el.val) return;
    const v = aggViews[kind] || { state: 'idle' };
    const d = aggregateDisplay(kind, v);
    el.val.textContent = d.value;
    el.val.classList.toggle('muted', v.state !== 'ok');
    el.box.title = d.title;
    if (el.btn) {
      // 统计中禁用 → 重复触发在前端就被吞掉（宿主侧另有单飞守卫，双重保险，Req 7.9）
      el.btn.disabled = v.state === 'loading';
      el.btn.textContent = v.state === 'ok' || v.state === 'unavailable' ? '重新统计' : '统计';
    }
    if (kind === 'legacyResidue' && $legacyClean) {
      // 有可清理字节才给入口：为 0 时按钮点下去只会得到「无可清理内容」
      const canClean = v.state === 'ok' && typeof v.migratedResidueBytes === 'number' && v.migratedResidueBytes > 0;
      $legacyClean.hidden = !canClean;
      $legacyClean.disabled = !canClean;
    }
  }

  function renderAllAggregates() {
    renderAggregate('project');
    renderAggregate('allKiro');
    renderAggregate('legacyResidue');
  }

  function requestAggregate(kind) {
    const v = aggViews[kind];
    if (v && v.state === 'loading') return;
    aggViews[kind] = { state: 'loading' };
    renderAggregate(kind);
    vscode.postMessage({ type: 'computeAggregate', kind: kind });
  }

  if (AGG_EL.allKiro.btn) {
    AGG_EL.allKiro.btn.addEventListener('click', () => requestAggregate('allKiro'));
  }
  if (AGG_EL.legacyResidue.btn) {
    AGG_EL.legacyResidue.btn.addEventListener('click', () => requestAggregate('legacyResidue'));
  }
  if ($legacyClean) {
    $legacyClean.addEventListener('click', () => {
      if ($legacyClean.disabled) return;
      // 计划 / 模态确认 / 删除 / 审计全部发生在宿主的 SessionCleaner 一侧；
      // webview 只发出这一条意图，且立刻置灰按钮避免连点
      $legacyClean.disabled = true;
      vscode.postMessage({ type: 'cleanupLegacyResidue' });
    });
  }

  /** 按状态同步全部控件的启用/禁用与文案（design 的控件禁用表） */
  function syncControls() {
    const interactive = canInteract();
    $status.textContent = interactive
      ? '共 ' + view.total + ' 个会话 · 自身口径，各行数值可相加'
      : (STATE_TEXT[state] || '');
    $status.classList.toggle('error', state === 'unavailable');

    // 占位文案：仅在没有可展示行时出现（loading 期间保留旧行，只置灰）
    const hasRows = $rows.children.length > 0;
    $empty.textContent = interactive ? '' : (STATE_TEXT[state] || '');
    $empty.style.display = interactive || hasRows ? 'none' : 'block';

    $prev.disabled = !interactive || view.page <= 1;
    $next.disabled = !interactive || view.page >= view.totalPages;
    $thTotal.classList.toggle('disabled', !interactive);
    $refresh.classList.toggle('disabled', !canRefresh());
    $refresh.classList.toggle('spinning', state === 'loading');

    const ops = $rows.querySelectorAll('button.op');
    for (let i = 0; i < ops.length; i++) ops[i].disabled = !interactive;
  }

  /**
   * 重渲染当前页：排序 + 切片 + 逐行渲染全在本地完成（Req 7.13）。
   * 页码由 pageOf 归一，因此清理后行数减少时自动落到 min(M, N)（Req 13.17）。
   */
  function render() {
    const p = pageOf(allRows, sortOrder, page);
    page = p.page;
    view = p;

    let html = '';
    for (let i = 0; i < p.rows.length; i++) html += renderRankingRowHtml(p.rows[i], partial);
    $rows.innerHTML = html;

    $pageInfo.textContent = '第 ' + p.page + ' / ' + p.totalPages + ' 页 · 共 ' + p.total + ' 个会话';
    $partialNote.textContent = partial
      ? '统计不完整，已跳过 ' + skippedCount + ' 个条目，标注 ≥ 的两列为下限值'
      : '';
    $sortArrow.textContent = sortOrder === 'desc' ? '▼' : '▲';

    syncControls();
    saveState();
  }

  // 表头切换排序方向：换序把页码重置为第一页（Req 13.8）
  function toggleSort() {
    if (!canInteract()) return;
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    page = 1;
    render();
  }
  $thTotal.addEventListener('click', toggleSort);
  $thTotal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(); }
  });

  $prev.addEventListener('click', () => {
    if (!canInteract()) return;
    page = view.page - 1;
    render();
  });
  $next.addEventListener('click', () => {
    if (!canInteract()) return;
    page = view.page + 1;
    render();
  });

  function requestRefresh() {
    if (!canRefresh()) return;
    vscode.postMessage({ type: 'refresh' });
  }
  $refresh.addEventListener('click', requestRefresh);
  $refresh.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); requestRefresh(); }
  });

  // 行内清理入口：事件委托到 tbody，避免每次重渲染重新绑定 100 个监听器。
  // sessionId 与完整标题从 tr 的 data-* 读回（写入时已转义，dataset 读出的是原文）。
  $rows.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button.op') : null;
    if (!btn || btn.disabled || !canInteract()) return;
    const tr = btn.closest('tr');
    if (!tr) return;
    vscode.postMessage({
      type: 'cleanup',
      mode: btn.dataset.mode === 'full' ? 'full' : 'attachment',
      sessionId: tr.dataset.sessionId || '',
      title: tr.dataset.title || ''
    });
  });

  window.addEventListener('message', (e) => {
    const m = (e && e.data) || {};
    if (m.type === 'rows') {
      allRows = Array.isArray(m.rows) ? m.rows : [];
      partial = m.partial === true;
      skippedCount = typeof m.skippedCount === 'number' && isFinite(m.skippedCount) ? m.skippedCount : 0;
      // 'ok' 恒由数据到货这一刻进入，K = 0 则落到空态（Req 13.9）
      state = allRows.length > 0 ? 'ok' : 'empty';
      // ProjectSessionTotal 随行数据一同到货（Req 7.3：与表格来自同一次枚举）
      if (m.project && typeof m.project === 'object') {
        aggViews.project = m.project;
        renderAggregate('project');
      }
      render();
    } else if (m.type === 'state') {
      if (!STATE_TEXT[m.state]) return;
      state = m.state;
      if (state === 'no-workspace' || state === 'unavailable') {
        allRows = [];
        partial = false;
        skippedCount = 0;
        page = 1;
        // 表格没有数据可言时，随排行一同下发的当前项目维度也不该继续显示旧数值
        aggViews.project = { state: state === 'no-workspace' ? 'idle' : 'unavailable' };
        renderAggregate('project');
      }
      render();
    } else if (m.type === 'aggregate') {
      // 单个维度到货：只重绘它自己，表格与另外两个维度不受影响
      if (!AGG_EL[m.kind]) return;
      aggViews[m.kind] = m.view && typeof m.view === 'object' ? m.view : { state: 'unavailable' };
      renderAggregate(m.kind);
    } else if (m.type === 'layout') {
      // old-only 下旧目录即主数据、已计入「整个 Kiro」，故隐藏旧残留维度（Req 8.3）
      const hide = m.layout === 'old-only';
      if (AGG_EL.legacyResidue.box) AGG_EL.legacyResidue.box.classList.toggle('hidden', hide);
    }
  });

  render();
  renderAllAggregates();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 6. 面板生命周期 —— RankingPanel（本文件唯一接触 vscode API 的分节）
// ---------------------------------------------------------------------------

// 仅类型导入：`import type` 在编译期被完全擦除，不产生运行时 `require('vscode')`。
// 这一点至关重要——本文件的纯函数（`compareRankingRows` / `pageOf` /
// `renderRankingRowHtml` / `getRankingHtml`）会被 vitest 直接 import 做单元测试，
// 而测试环境没有 `vscode` 模块。运行时真正需要 vscode API 的地方（只有本分节的
// `showOrCreate` / 面板创建）改用惰性 `require('vscode')`，因此 import 本模块取用
// 纯函数时绝不会触碰 vscode，测试可无依赖地加载整个文件。
import type * as vscode from 'vscode';

/** 惰性取 vscode 运行时模块：只在扩展宿主里、真正创建面板时才求值。 */
function loadVscode(): typeof import('vscode') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode') as typeof import('vscode');
}

/** 排行页面板的 WebviewPanel viewType（与命令 id 对齐，供任务 16.5 注册命令时引用）。 */
export const RANKING_PANEL_VIEW_TYPE = 'kiroChatSearch.storageRanking';

/** 面板标题栏文案。 */
const RANKING_PANEL_TITLE = '存储占用排行';

/** 行内清理的两种模式（与 `SessionCleaner` 的 `CleanupMode` 同口径）。 */
export type RankingCleanupMode = 'attachment' | 'full';

/**
 * `analyzer.getRankingRows({ force })` 的返回形状（结构上等同 analyzer 内部的
 * `RowsResult`，此处独立声明是为了让 `RankingPanelDeps` 不必从 analyzer 反向导出
 * 私有类型；两者字段一致，赋值天然兼容）。
 *
 * - `rows`：**全量** RankingRow（不是当前页），恒 self 口径；排序/分页在 webview 侧完成
 * - `partial`：有条目被跳过（数值为下限），行渲染据此加 `≥` 前缀
 * - `skippedCount`：被跳过的条目数，页脚展示
 */
export interface RankingRowsPayload {
  rows: RankingRow[];
  partial: boolean;
  skippedCount: number;
  /**
   * ProjectSessionTotal 的展示视图（Req 7.2、7.3）。
   *
   * 跟着行数据一起回来、而不是让面板另调一次取数：Req 7.3 明确要求这个维度**由渲染排行的
   * 同一次枚举结果聚合得出**，多一次调用即便命中缓存也谈不上同源。省略时该维度停在
   * 空闲态——既有只返回三个字段的调用方与测试因此不受影响。
   */
  project?: AggregateView;
}

/**
 * `RankingPanel` 的全部宿主侧依赖（取数 / 清理 / 工作区 / 日志）以结构化接口注入，
 * 使本分节不直接 `new StorageAnalyzer()` / `new SessionCleaner()`——那些构造涉及
 * PathResolver、OutputChannel、确认弹窗等一大票 vscode 绑定，留给任务 16.5 的
 * extension.ts 接线时装配后传入，本模块因此可脱离 vscode 宿主被单测（16.6）。
 *
 * 刻意**不**包含任何 `Σ`/creditMode 入口：排行页恒 self 口径，既不读也不写搜索面板的
 * creditMode（两者是彼此不可见的独立 webview，各自 getState/setState，见 Req 13.4）。
 */
export interface RankingPanelDeps {
  /**
   * 取数：当前工作区全部会话，恒 self 口径。排行页的打开与刷新都是显式动作，
   * 故恒以 `{ force: true }` 调用（忽略 60s 缓存，Req 13.12）。
   */
  analyzer: {
    getRankingRows(opts: { force: boolean }): Promise<RankingRowsPayload>;
    /**
     * AllKiroSessionTotal 的取数（Req 7.6）。**可选**：不提供时该维度的按钮点下去只会
     * 得到 `unavailable`，既有只注入 `getRankingRows` 的调用方与测试不受影响。
     *
     * 恒在用户点击手动触发控件时才被调用（Req 7.8：未触发即不枚举其它工作区目录）。
     * `force` 为 false 表示允许命中该维度自己的缓存——它是重量级扫描，常规触发不该重扫。
     */
    getAllKiroSessionTotal?(opts: { force: boolean }): Promise<AggregateView>;
    /** LegacyResidueTotal 的取数（Req 8.5）；同上，可选且仅手动触发。 */
    getLegacyResidueTotal?(opts: { force: boolean }): Promise<AggregateView>;
  };
  /**
   * 旧残留清理入口（Requirement 11.1）。**可选**：不提供时 webview 侧的清理按钮点下去
   * 只会得到一次日志，不发生任何删除。
   *
   * 计划、模态确认、删除与审计全部发生在宿主的 `SessionCleaner` 一侧；本面板只在其返回后
   * 重新统计该维度（Req 11.8：清理后该维度缓存失效，下次展示反映新值）。
   */
  cleanupLegacyResidue?(): Promise<unknown>;
  /**
   * 行内清理执行器：委托 `SessionCleaner.run(mode, sessionId, title)`，
   * 计划 / 确认 / 删除 / 审计全部发生在 cleaner 一侧，本面板只在其返回后 `refresh()`。
   */
  cleaner: {
    run(mode: RankingCleanupMode, sessionId: string, title: string): Promise<unknown>;
  };
  /** 当前工作区 fsPath；`null` 表示未打开工作区（进入 no-workspace 态，绝不枚举目录）。 */
  workspacePath: string | null;
  /**
   * 当前工作区的 StorageLayout（`detectLayout().layout`）。
   *
   * 只用于一件事：`old-only` 时隐藏旧残留维度（Req 8.3——那时旧目录即主数据、
   * 已计入「整个 Kiro」，单列一个「残留」会让用户以为那是可以清掉的多余数据）。
   * 可选，省略时三个维度全部展示。
   */
  layout?: string;
  /** 诊断/审计输出（复用报告与清理的 OutputChannel）；缺省则静默。 */
  log?: (message: string) => void;
}

/** webview → 宿主的入站消息（与 `getRankingHtml` 内联脚本的 postMessage 对齐）。 */
type RankingInboundMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'computeAggregate'; kind?: unknown }
  | { type: 'cleanupLegacyResidue' }
  | { type: 'cleanup'; mode?: unknown; sessionId?: unknown; title?: unknown };

/**
 * 排行页面板：**窗口内单例**（模块级 `currentRankingPanel`）。
 *
 * 生命周期与状态保持（Req 13.1）：`showOrCreate` 命中已有实例时只 `reveal()`，
 * **不**重置 `page` / `sortOrder`——那两个是纯展示状态，存活在 webview 侧的
 * RankingViewState 里，`retainContextWhenHidden: true` 保证面板隐藏时 webview 不被
 * 销毁、状态不丢。`onDidDispose` 清掉模块级单例，因此关闭后重开是全新 webview，
 * 自然回到 `page: 1` / `sortOrder: 'desc'`，无需额外的持久化或重置代码。
 *
 * 五态状态机由宿主 → webview 的消息驱动（见 `getRankingHtml` 的协议注释）：
 *   - `loading`      ：post `{type:'state',state:'loading'}`；webview 保留已渲染的行、
 *                      只置灰控件并显示「统计中…」，面板始终可关闭；重复取数被
 *                      `inflight` 标志忽略，保证同时最多 1 次统计在执行（Req 13.15）
 *   - `ok`           ：post `{type:'rows',...}` 且 `rows.length > 0`；当前页表格 +
 *                      「第 M / N 页 · 共 K 个会话」，M=1 禁上一页、M=N 禁下一页
 *   - `empty`        ：post `{type:'rows',...}` 且 `rows.length === 0`；
 *                      「当前项目还没有可统计的会话」+「第 1 / 1 页 · 共 0 个会话」，
 *                      表头与分页控件结构保留并禁用（Req 13.9）
 *   - `no-workspace` ：post `{type:'state',state:'no-workspace'}`；结构保留并置灰，
 *                      **不发生任何目录枚举**（Req 13.16）
 *   - `unavailable`  ：post `{type:'state',state:'unavailable'}`；「占用统计不可用」，
 *                      刷新仍可用
 *
 * `ok` / `empty` 恒由 `rows` 消息（携带数据那一刻）进入，不由 `state` 消息进入——
 * 避免出现「状态已是 ok 但还没有数据」的中间态。翻页与换序（含换序后 `page` 归 1、
 * 清理后行数减少落到 `min(M, N)`）全部在 webview 侧对已下发的全量数组 sort+slice 完成，
 * 不回宿主、不产生任何文件系统调用（Req 7.13、13.17）。
 */
export class RankingPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly deps: RankingPanelDeps;
  private readonly disposables: vscode.Disposable[] = [];
  /** 取数互斥：为 true 时忽略新的取数请求，保证同时最多一次统计在执行（Req 13.15）。 */
  private inflight = false;
  /**
   * 两个手动触发维度**各自**的单飞标志（Req 7.9、8.9）。
   *
   * 与表格的 `inflight` 分开：三者互不阻塞——用户在旧残留扫描（可能几分钟）进行中
   * 仍应能刷新表格、触发另一个维度、关闭面板。前端也会在统计中禁用按钮，
   * 这里是第二道保险，因为消息可以由任何来源投递。
   */
  private aggregateInflight: Record<string, boolean> = {};
  /** 面板已销毁：异步取数回来后据此丢弃迟到的 postMessage，避免向死 webview 发消息。 */
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, deps: RankingPanelDeps) {
    this.panel = panel;
    this.deps = deps;

    // webview → 宿主的消息路由：ready 触发首次取数、refresh 强制重取、cleanup 行内清理
    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => this.onMessage(raw as RankingInboundMessage),
      null,
      this.disposables
    );

    // 关闭即清空模块级单例：下次打开是全新 webview，状态回到 page:1 / desc（Req 13.1）
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * 窗口内单例入口：已存在则 `reveal()`（保留 page/sortOrder），否则创建新面板。
   * 首次取数不在这里触发——等 webview 脚本就绪发来 `ready` 再开始，
   * 确保下发的行不会先于 webview 的消息监听器到达而丢失。
   */
  static showOrCreate(context: vscode.ExtensionContext, deps: RankingPanelDeps): void {
    if (currentRankingPanel) {
      // retainContextWhenHidden 保证隐藏期间 webview 未销毁，reveal 后 page/sortOrder 原样保留
      currentRankingPanel.panel.reveal(undefined, false);
      return;
    }

    const vscodeApi = loadVscode();
    const panel = vscodeApi.window.createWebviewPanel(
      RANKING_PANEL_VIEW_TYPE,
      RANKING_PANEL_TITLE,
      { viewColumn: vscodeApi.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        // 隐藏不销毁：page/sortOrder 存活在 webview 侧，切走再切回不丢（Req 13.1）
        retainContextWhenHidden: true,
        localResourceRoots: [vscodeApi.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    const nonce = rankingNonce();
    panel.webview.html = getRankingHtml(panel.webview.cspSource, nonce);

    currentRankingPanel = new RankingPanel(panel, deps);
  }

  /**
   * 重新取数并下发（清理后由本类内部触发，或供 16.5 在外部事件后调用）。
   * 恒 `force: true`：打开与刷新都是显式动作，忽略 60s 缓存（Req 13.12）。
   * sortOrder 存活在 webview 侧、不随取数变化，故刷新自动保持当前排序方向。
   */
  async refresh(opts?: { force?: boolean }): Promise<void> {
    await this.compute(opts?.force ?? true);
  }

  dispose(): void {
    if (currentRankingPanel === this) currentRankingPanel = undefined;
    this.disposed = true;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      this.panel.dispose();
    } catch {
      /* ignore */
    }
  }

  /** 入站消息路由。 */
  private onMessage(msg: RankingInboundMessage): void {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready' || msg.type === 'refresh') {
      // 两者都触发一次强制取数；重复请求由 compute 的 inflight 短路
      if (msg.type === 'ready') this.postLayout();
      void this.compute(true);
      return;
    }
    if (msg.type === 'computeAggregate') {
      // 只有这条消息会让两个重量级维度动起来 —— 在此之前它们对应的目录一次都不会被枚举
      // （Req 7.8、8.4）。取值以外的 kind 一律忽略，不让前端决定宿主调哪个方法。
      const kind = msg.kind;
      if (kind === 'allKiro' || kind === 'legacyResidue') void this.computeAggregate(kind);
      return;
    }
    if (msg.type === 'cleanupLegacyResidue') {
      void this.handleLegacyResidueCleanup();
      return;
    }
    if (msg.type === 'cleanup') {
      const mode: RankingCleanupMode = msg.mode === 'full' ? 'full' : 'attachment';
      const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
      const title = typeof msg.title === 'string' ? msg.title : '';
      if (!sessionId) return;
      void this.handleCleanup(mode, sessionId, title);
    }
  }

  /**
   * 五态取数核心。
   *
   * - 无工作区：**直接**进入 no-workspace，绝不调用 analyzer、绝不枚举目录（Req 13.16）
   * - 取数进行中（inflight）：忽略新的请求（Req 13.15）
   * - 否则：先置 loading（保留旧行、只置灰），取数成功按 K 落 ok/empty（经 `rows` 消息），
   *   取数抛异常落 unavailable（刷新仍可用，Req 13.9）
   */
  private async compute(force: boolean): Promise<void> {
    if (this.disposed) return;

    // no-workspace：不触发任何枚举，也不占用 inflight（它本就没在统计）
    if (this.deps.workspacePath === null) {
      this.post({ type: 'state', state: 'no-workspace' });
      return;
    }

    if (this.inflight) return; // 同时最多一次统计
    this.inflight = true;
    this.post({ type: 'state', state: 'loading' });

    try {
      const res = await this.deps.analyzer.getRankingRows({ force });
      if (this.disposed) return;
      // ok / empty 恒由数据到货这一刻进入：rows.length>0 → ok，===0 → empty（Req 13.9）
      const payload: RankingOutboundMessage = {
        type: 'rows',
        rows: res.rows,
        partial: res.partial === true,
        skippedCount: typeof res.skippedCount === 'number' ? res.skippedCount : 0,
      };
      // ProjectSessionTotal 与行数据同源（Req 7.3），故搭同一条消息下发
      if (res.project) payload.project = res.project;
      this.post(payload);
    } catch (err) {
      if (this.disposed) return;
      this.log('排行页取数失败：' + errMessage(err));
      this.post({ type: 'state', state: 'unavailable' });
    } finally {
      this.inflight = false;
    }
  }

  /**
   * 一个手动触发维度的取数（Req 7.6、7.9、8.5、8.9）。
   *
   * - 该维度正在统计中 → 忽略本次请求（前端已禁用按钮，这里是第二道保险）
   * - 对应的取数方法未注入 → 直接回 `unavailable`，不静默吞掉（否则按钮点下去毫无反应）
   * - 取数抛异常 → 同样回 `unavailable` 并记日志；**不弹窗**（Req 8.8），
   *   表格与另一个维度不受影响
   *
   * `force: false`：这两个维度是重量级扫描且自带无 TTL 缓存，常规触发应命中缓存；
   * 需要重扫时由清理后的缓存失效（Req 7.13）负责，而不是每次点击都重扫。
   */
  private async computeAggregate(
    kind: 'allKiro' | 'legacyResidue',
    force = false
  ): Promise<void> {
    if (this.disposed) return;
    if (this.aggregateInflight[kind]) return;

    const fetch =
      kind === 'allKiro'
        ? this.deps.analyzer.getAllKiroSessionTotal
        : this.deps.analyzer.getLegacyResidueTotal;
    if (!fetch) {
      this.post({ type: 'aggregate', kind, view: unavailableAggregateView() });
      return;
    }

    this.aggregateInflight[kind] = true;
    try {
      const view = await fetch.call(this.deps.analyzer, { force });
      if (this.disposed) return;
      this.post({ type: 'aggregate', kind, view });
    } catch (err) {
      if (this.disposed) return;
      this.log('聚合维度取数失败（' + kind + '）：' + errMessage(err));
      this.post({ type: 'aggregate', kind, view: unavailableAggregateView() });
    } finally {
      this.aggregateInflight[kind] = false;
    }
  }

  /**
   * 旧残留清理（Requirement 11.1、11.8）。
   *
   * 无论成功、取消还是失败，都随后**重新统计**该维度并下发：清理成功时数值必须变小，
   * 取消时也应把 webview 侧那个被点击后置灰的按钮恢复回来 —— 后者是靠「重新下发一份
   * 视图」实现的，因此不需要为「取消」单独设计一条恢复消息。
   */
  private async handleLegacyResidueCleanup(): Promise<void> {
    const run = this.deps.cleanupLegacyResidue;
    if (!run) {
      this.log('旧残留清理入口未接线：本次请求被忽略');
      // 仍要重发一次视图，否则按钮会一直停在被点击后的禁用态
      void this.computeAggregate('legacyResidue');
      return;
    }
    try {
      await run();
    } catch (err) {
      this.log('旧残留清理失败：' + errMessage(err));
    }
    // 清理已使该维度缓存失效（Req 11.8），故这里必须强制重取而不是命中缓存
    if (this.disposed) return;
    this.aggregateInflight.legacyResidue = false;
    await this.computeAggregate('legacyResidue', true);
  }

  /** 下发布局结论，供 webview 在 `old-only` 下隐藏旧残留维度（Req 8.3）。 */
  private postLayout(): void {
    if (this.deps.layout) this.post({ type: 'layout', layout: this.deps.layout });
  }

  /**
   * 行内清理入口：委托 `SessionCleaner.run`（计划/确认/删除/审计都在那侧），
   * 无论成功、取消还是失败都随后 `refresh()`——刷新后 K 变小时由 `pageOf` 的 clamp
   * 自动落到 `min(M, N)`（Req 13.17），当前列表始终保持可用（Req 9.9）。
   */
  private async handleCleanup(
    mode: RankingCleanupMode,
    sessionId: string,
    title: string
  ): Promise<void> {
    try {
      await this.deps.cleaner.run(mode, sessionId, title);
    } catch (err) {
      this.log('会话清理失败：' + errMessage(err));
    }
    await this.refresh({ force: true });
  }

  /** 向 webview 投递消息；面板已销毁时静默丢弃。 */
  private post(message: RankingOutboundMessage): void {
    if (this.disposed) return;
    try {
      void this.panel.webview.postMessage(message);
    } catch {
      /* webview 已不可达：忽略 */
    }
  }

  private log(message: string): void {
    try {
      this.deps.log?.(message);
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }
}

/** 宿主 → webview 的出站消息（与 `getRankingHtml` 内联脚本的 message 监听对齐）。 */
type RankingOutboundMessage =
  | { type: 'state'; state: 'loading' | 'empty' | 'no-workspace' | 'unavailable' }
  | {
      type: 'rows';
      rows: RankingRow[];
      partial: boolean;
      skippedCount: number;
      project?: AggregateView;
    }
  | { type: 'aggregate'; kind: AggregateKind; view: AggregateView }
  | { type: 'layout'; layout: string };

/** 模块级单例：窗口内至多一个排行页面板存活（Req 13.1）。 */
let currentRankingPanel: RankingPanel | undefined;

/** 从 unknown 错误安全取消息文本。 */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `state: 'unavailable'` 的聚合维度视图：取数方法未注入、或取数抛异常时下发。
 *
 * 与「数值为 0 的 ok」严格区分：前者让 webview 显示「不可用」，后者显示「0 B」。
 * 把取数失败显示成 0 B 会让用户以为那个目录是空的。
 */
function unavailableAggregateView(): AggregateView {
  return {
    state: 'unavailable',
    bytes: 0,
    files: 0,
    sessionCount: 0,
    workspaceCount: 0,
    partial: false,
    skippedCount: 0,
    roots: [],
  };
}

/**
 * 生成 CSP nonce（与搜索面板的 `generateNonce` 同口径：32 位字母数字）。
 * 每次创建面板独立生成，配合 `script-src 'nonce-...'` 收紧脚本执行面。
 */
function rankingNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
