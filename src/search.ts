import * as fs from 'fs';
import * as path from 'path';
import {
  getCreditsForSessions,
  getSessionCreditScopes,
  listArchiveEntries,
  storeRootFromSessionDir,
  type ArchiveInfo,
} from './credits';
import { computeSessionFootprint } from './storage/analyzer';
import {
  evictMissingNewSessions,
  listNewSessionDirs,
  readNewSession,
  type NewSessionRecord,
} from './session/newFormat';
import {
  collectMigratedSessionIds,
  determineSessionOrigin,
  isMigrationMarkerFileName,
} from './session/origin';
import type { StorageLayout } from './layout';
import type { SessionOrigin } from './storage/types';

/**
 * SearchEngine：会话浏览与搜索。
 *
 * 模块分三层，**双版本分叉只发生在最上面那层**（design D1）：
 *
 * 1. {@link SessionSource}：枚举目录 → 读一条会话 → 索引缓存。每种磁盘格式一个实现。
 * 2. 0.9x 默认实现（{@link oldSessionSource}）：单文件会话 `<dir>/<sessionId>.json`
 *    + `sessions.json` 标题清单 + 执行存档归因。
 * 3. 1.x 实现（{@link newSessionSource}）：目录型会话 `<dir>/<sessionId>/`，
 *    读取全部委托 `session/newFormat.ts`，用量委托 `credits.ts`。
 * 4. 与格式无关的匹配流水线（{@link searchSessionsInDir} / {@link listRecentSessions}
 *    与双源的 {@link searchSessionsInLayout} / {@link listRecentSessionsInLayout}）：
 *    关键词匹配、`matchField`、snippet 截取、来源判定、按修改时间倒序、按 limit 截断。
 *    这一层**只认 {@link SessionRecord}**，两种格式共用同一份实现——`layout === 'both'`
 *    时它同时驱动两个来源，合并去重也发生在这里，而不是散在两份取数代码里（design D1）。
 *
 * 本模块位于 **ReadOnlyPaths**：只读目录枚举、stat 与文件读取，无任何写 API。
 */

export interface SearchHit {
  sessionId: string;
  title: string;
  modified: number;
  snippet: string;
  /** 命中字段；'recent' 表示无关键词的"最近列表"项，snippet 为首条消息预览 */
  matchField: 'title' | 'message' | 'recent';
  /** 会话是否含内嵌图片（content[].type~image 或 imageUrl/image 字段） */
  hasImage: boolean;
  /** 会话是否含非空 contextItems 附件 */
  hasAttachment: boolean;
  /**
   * 该会话的来源 / 迁移状态（Req 9.7）：`new` = 1.x 新建、`migrated` = 从 0.9x 迁移而来、
   * `legacy-unmigrated` = 只存在于旧目录（在 1.x 界面里看不见）。
   * 判定规则见 `session/origin.ts` 的 `determineSessionOrigin`，只影响展示。
   */
  origin: SessionOrigin;
  /**
   * 该会话**数据所在的磁盘格式**：`new` = 1.x 目录型，`old` = 0.9x 单文件（Req 13.5）。
   *
   * 刻意不是工作区级的 StorageLayout（`both` / `new-only` / …）：那个值对一次查询里的
   * 全部结果恒相同，且 `EnvCheck.layout` 已经给出，逐条重复没有信息量。渲染层真正
   * 需要区分的是**这一条**读自哪一侧——`Σ` 开关对 1.x 会话不改变数值（design D4）、
   * 占用角标的两列口径映射不同（Req 6.9），都得按条判断。
   *
   * 与 `origin` 不可互相推导：迁移标记存在但新目录那份已被删掉时，`origin` 为
   * `migrated` 而数据仍读自旧目录。
   */
  layout: SessionSourceKind;
  /**
   * 该会话**自身**的真实 credit 消耗（只统计 chatSessionId==本会话的执行，不含 checkpoint 继承）。
   * 查不到带用量的执行时为 undefined。默认展示口径（方案 C）。
   */
  credits?: number;
  /**
   * 整段对话的累计 credit（含 checkpoint 祖先链）。可选展示口径（方案 A）。
   * 查不到时为 undefined。
   */
  creditsLineage?: number;
  /**
   * 会话上下文窗口占用百分比（Kiro 本地估算，写在会话 JSON 顶层）。
   * 作为 credit 不可用时的回退展示。
   */
  contextPercentage?: number;
  /**
   * 会话 JSON 自身字节数（SessionFile 的 stat.size，不含清单与存档）。
   * 取不到时为 undefined，渲染层据此省略占用角标。
   */
  sessionJsonBytes?: number;
  /** 自身口径（`chatSessionId === sessionId`）归因到该会话的存档字节数。 */
  archiveBytesSelf?: number;
  /** 累计口径（含 checkpoint 祖先链）归因到该会话的存档字节数。 */
  archiveBytesLineage?: number;
  /** 是否找到归因存档；false 表示存档数据不可用或已被 LRU 淘汰，只展示 JSON 部分。 */
  archivesFound?: boolean;
}

/* ================================================================== *
 * 一、SessionSource：唯一的双版本分叉点
 * ================================================================== */

/**
 * 会话来源的磁盘格式标记。
 *
 * `old` = 0.9x 单文件会话（本模块的 {@link oldSessionSource}）；
 * `new` = 1.x 目录型会话（本模块的 {@link newSessionSource}）。
 *
 * 同时是 {@link SearchHit.layout} 的取值域：一条结果的 `layout` 恒等于产出它的来源的 `kind`。
 */
export type SessionSourceKind = 'old' | 'new';

/**
 * 枚举阶段产出的一个候选会话条目：**只有身份与位置，不含内容**。
 *
 * 把「枚举」与「读取」分成两步而不是一次读完，是为了让索引缓存的失效判据
 * （`stat` 出来的 `(mtimeMs, size)`）留在读取那一步：命中缓存的会话不会被
 * `readFile` / `JSON.parse` 碰到（Req 3.11 对 1.x 也是同一要求）。
 */
export interface SessionEntry {
  /** 会话 id（0.9x：文件名去掉 `.json`；1.x：会话子目录名）。 */
  sessionId: string;
  /**
   * 该会话数据的绝对路径：0.9x 为会话 JSON 文件，1.x 为会话目录。
   * 同时是索引缓存的键，也是 {@link SessionSource.evictMissing} 的比对依据。
   */
  path: string;
  /**
   * 枚举阶段就已知的权威标题（0.9x 取自目录下的 `sessions.json` 清单）。
   * 1.x 没有这层清单，标题由读取阶段从 `session.json` 取，此处留空。
   */
  title?: string;
}

/**
 * 与磁盘格式无关的会话记录：{@link SessionSource} 的产出，也是匹配流水线
 * **唯一消费的形状**。
 *
 * 字段刻意取 0.9x 的 `ResolvedSession` 与 1.x 的 `NewSessionRecord`
 * （`src/session/newFormat.ts`）的公共子集，因此 `NewSessionRecord` 无需转换即
 * 结构性满足本接口；两种格式各自的额外字段（0.9x 的存档归因输入、1.x 的会话目录）
 * 由各自的实现在子类型里带，只被自己的 {@link SessionSource.decorateHits} 用到。
 */
export interface SessionRecord {
  sessionId: string;
  /** 最后修改时间（epoch ms）。排序与 `SearchHit.modified` 都取它。 */
  modified: number;
  /** 最终展示标题（已完成清单覆盖与 `Untitled` 兜底）。 */
  title: string;
  /** 关键词匹配用的纯文本（已剔除 base64 图片数据）。 */
  text: string;
  /** 最近列表的预览来源（首条用户消息）。 */
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  /** 会话上下文占用百分比（0.9x 写在会话 JSON 顶层；1.x 无此字段）。 */
  contextPercentage?: number;
}

/**
 * 一种磁盘格式的取数实现：**枚举目录 → 读一条会话 → 索引缓存**。
 *
 * 三个必需/可选成员与 1.x 的 `listNewSessions` 的三段内部结构一一对应
 * （readdir + 目录判定 → `readNewSession` → 缓存收尾），因此 7.2 接入新格式时
 * 是把已有实现挂到这三个位置上，不需要重写读取逻辑。
 *
 * 关键词匹配、`matchField`、snippet、排序与截断**不在本接口内**——它们与格式无关，
 * 只有一份实现（design D1）。
 */
export interface SessionSource<R extends SessionRecord = SessionRecord> {
  /** 该来源对应的磁盘格式。 */
  readonly kind: SessionSourceKind;

  /**
   * 列出该目录下的会话条目（只枚举，不读内容）。
   *
   * @returns 条目列表；**目录整体不可枚举时返回 `null`**。`null` 与 `[]` 语义不同：
   *   `[]` 表示「目录可读但没有会话」，此时缓存里该目录下的残留键会被清掉；
   *   `null` 表示「这次没看到目录」，缓存原样保留（目录临时不可读不该清空缓存）。
   */
  listEntries(dir: string): SessionEntry[] | null;

  /**
   * 读一条会话的可匹配内容，按 `(mtimeMs, size)` 复用索引缓存。
   *
   * @returns 记录；该会话不可读（stat 失败、内容非法、必需文件缺失）时返回 `null`
   *   表示跳过它。**不抛异常。**
   */
  readSession(entry: SessionEntry): R | null;

  /**
   * 缓存收尾：摘除缓存中已在目录里消失的会话（键在 `dir` 下但不在 `seenPaths` 中）。
   * 无进程内缓存的实现可省略。
   */
  evictMissing?(dir: string, seenPaths: ReadonlySet<string>): void;

  /**
   * 为**已截断**的结果集补充该来源特有的字段（credit 用量、占用字节数）。
   *
   * 只对最终下发的十几条结果调用，因此可以做按会话的归因而不担心成本。
   * 单条失败只省略该条字段、不影响其余结果。无额外字段的实现可省略。
   */
  decorateHits?(dir: string, hits: SearchHit[], records: readonly R[]): void;
}

/**
 * 用给定来源取出一个目录下的全部会话记录。
 *
 * 顺序与枚举顺序一致（排序交给调用方）。`seenPaths` 在**读取之前**登记：
 * 读失败的会话仍算「目录里存在」，不会被 {@link SessionSource.evictMissing} 摘掉，
 * 避免坏文件在每次搜索时被反复重读。
 */
function collectSessions<R extends SessionRecord>(
  source: SessionSource<R>,
  dir: string
): R[] {
  const entries = source.listEntries(dir);
  if (!entries) return [];

  const seenPaths = new Set<string>();
  const out: R[] = [];
  for (const entry of entries) {
    seenPaths.add(entry.path);
    const rec = source.readSession(entry);
    if (rec) out.push(rec);
  }

  source.evictMissing?.(dir, seenPaths);
  return out;
}

/* ================================================================== *
 * 二、0.9x 默认实现：单文件会话 + sessions.json 清单 + 执行存档归因
 * ================================================================== */

/**
 * 进程内会话索引缓存条目。仅保留匹配/展示所需的精简数据，
 * 不保留原始 JSON，避免把 base64 图片等大体积内容常驻内存。
 */
interface SessionIndexEntry {
  mtimeMs: number;
  /** 文件字节大小，与 mtimeMs 共同作为失效判据 */
  size: number;
  /** 单个会话文件里的原始标题（往往是泛化的 "Agent"），作为清单缺失时的回退 */
  rawTitle: string;
  /** 用于关键词匹配的纯文本（已剔除 base64 图片数据） */
  text: string;
  /** 最近列表的预览来源（首条用户消息） */
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  /** 会话顶层的上下文占用百分比（Kiro 本地估算），无则 undefined */
  contextPercentage?: number;
  /** 会话顶层的工作区 fsPath，用于把 credit 扫描限定到对应存储目录 */
  workspacePath?: string;
  /** 会话 history 引用的 executionId（用于 checkpoint lineage 追溯祖先会话） */
  executionIds: string[];
}

/**
 * 会话索引缓存：键为 SessionFile 绝对路径，值为解析后的精简条目。
 * 进程内内存缓存，不持久化；扩展停用随进程释放。
 */
const indexCache = new Map<string, SessionIndexEntry>();

/** 测试辅助：清空缓存（不影响生产逻辑） */
export function __clearIndexCacheForTest(): void {
  indexCache.clear();
}

/**
 * 把一个会话对象解析为精简索引条目所需的字段。
 * 一次遍历同时算出：可匹配纯文本、首条用户消息预览、hasImage、hasAttachment。
 * - 文本构建跳过内嵌 base64 图片（imageUrl/image/data: URL）。
 * - 图片检测见到标志即短路，不读取 base64 内容。
 */
function parseSessionContent(obj: any): {
  text: string;
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  executionIds: string[];
} {
  const items: any[] = [];
  if (Array.isArray(obj?.history)) items.push(...obj.history);
  if (Array.isArray(obj?.messages)) items.push(...obj.messages);

  const textParts: string[] = [];
  let firstUserText = '';
  let hasImage = false;
  let hasAttachment = false;
  const executionIds: string[] = [];
  const seenExec = new Set<string>();

  for (const item of items) {
    // 收集 executionId（用于 checkpoint lineage：这些执行常属于祖先会话）
    const eid = item?.executionId;
    if (typeof eid === 'string' && eid && !seenExec.has(eid)) {
      seenExec.add(eid);
      executionIds.push(eid);
    }

    // 附件：任一消息项的 contextItems 为非空数组
    if (!hasAttachment && Array.isArray(item?.contextItems) && item.contextItems.length > 0) {
      hasAttachment = true;
    }

    const msg = item?.message ?? item;
    const role = msg?.role;
    const content = msg?.content;

    if (typeof content === 'string') {
      if (content) textParts.push(content);
      if (!firstUserText && (!role || role === 'user') && content.trim()) {
        firstUserText = content.trim();
      }
    } else if (Array.isArray(content)) {
      for (const c of content) {
        // 图片检测：标志命中即短路，不碰 base64 内容
        if (!hasImage && isImagePart(c)) {
          hasImage = true;
          continue; // 不把图片项纳入文本
        }
        const text = typeof c === 'string' ? c : c?.text;
        if (typeof text === 'string' && text) {
          textParts.push(text);
          if (!firstUserText && (!role || role === 'user') && text.trim()) {
            firstUserText = text.trim();
          }
        }
      }
    } else if (typeof msg?.text === 'string') {
      if (msg.text) textParts.push(msg.text);
      if (!firstUserText && (!role || role === 'user') && msg.text.trim()) {
        firstUserText = msg.text.trim();
      }
    }
  }

  return {
    text: textParts.join('\n'),
    firstUserText,
    hasImage,
    hasAttachment,
    executionIds,
  };
}

/** 判断 content 数组项是否为图片（不读取 base64 内容） */
function isImagePart(c: any): boolean {
  if (!c || typeof c !== 'object') return false;
  const t = typeof c.type === 'string' ? c.type.toLowerCase() : '';
  return t.includes('image') || c.imageUrl != null || c.image != null;
}

/**
 * Kiro 在会话目录下维护一个 `sessions.json` 清单文件，顶层是数组，
 * 每项形如 { sessionId, title, dateCreated, workspaceDirectory }。
 * 它是会话**标题的权威来源**（单个会话文件里的 title 往往只是泛化的 "Agent"）。
 * 该文件本身不是会话记录，必须从会话列表中排除。
 */
const MANIFEST_FILENAME = 'sessions.json';

/** 读取 sessions.json 清单，返回 sessionId → 官方标题 的映射；失败则返回空 Map。 */
function loadTitleMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const id = it?.sessionId;
        const title = it?.title;
        if (typeof id === 'string' && typeof title === 'string' && title.trim()) {
          map.set(id, title);
        }
      }
    }
  } catch {
    // 清单不存在或损坏：回退到单文件标题
  }
  return map;
}

/**
 * 0.9x 的会话记录：在 {@link SessionRecord} 之上带着存档归因所需的输入
 * （会话 JSON 字节数、工作区 fsPath、history 的 executionId）。
 * 这三项只被 {@link oldSessionSource} 自己的 `decorateHits` 消费。
 */
interface OldSessionRecord extends SessionRecord {
  /** 会话 JSON 字节数，复用索引缓存里已有的 stat.size（占用角标的 JSON 部分） */
  size: number;
  workspacePath?: string;
  executionIds: string[];
}

/**
 * 0.9x 默认来源：一个会话 = 会话目录下的一个 `<sessionId>.json`。
 *
 * 三段职责与接口一一对应：
 * - `listEntries`：`readdir` 出 `*.json`，剔除 `sessions.json` 清单，并把清单里的
 *   官方标题就近挂到条目上（清单只读一次）
 * - `readSession`：按 `(mtimeMs, size)` 命中缓存则直接复用，否则读文件并解析
 * - `evictMissing`：摘除本目录下已消失的缓存键
 * - `decorateHits`：credit 用量与占用字节数（只对已截断的结果集）
 */
export const oldSessionSource: SessionSource<OldSessionRecord> = {
  kind: 'old',

  listEntries(dir: string): SessionEntry[] | null {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      // 目录不可枚举：不动缓存，交由调用方按空结果处理
      return null;
    }

    const titleMap = loadTitleMap(dir);
    const out: SessionEntry[] = [];
    for (const f of files) {
      // 跳过会话清单文件——它不是会话记录（顶层是数组），点击会导致跳转报错
      if (f === MANIFEST_FILENAME) continue;
      // 跳过迁移标记 `._migration-<uuid>.json`——它同样不是会话记录，而是「这条会话
      // 已经搬到 1.x」的标记（Req 9.5）。不排除的话，`both` 布局的旧目录里每个标记都会
      // 变成一条无标题、无内容、点进去必然跳转失败的结果；它的真实用途是判定
      // SessionOrigin，由 `collectMigratedSessionIds` 单独读取。
      if (isMigrationMarkerFileName(f)) continue;
      const sessionId = path.basename(f, '.json');
      out.push({
        sessionId,
        path: path.join(dir, f),
        title: titleMap.get(sessionId),
      });
    }
    return out;
  },

  readSession(entry: SessionEntry): OldSessionRecord | null {
    const full = entry.path;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return null;
    }

    let cached = indexCache.get(full);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      let obj: any;
      try {
        obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        // 解析失败：跳过且不写入缓存；若之前有旧条目则移除
        indexCache.delete(full);
        return null;
      }
      const parsed = parseSessionContent(obj);
      const ctxPct =
        typeof obj?.contextUsagePercentage === 'number'
          ? obj.contextUsagePercentage
          : undefined;
      const wsPath =
        typeof obj?.workspacePath === 'string'
          ? obj.workspacePath
          : typeof obj?.workspaceDirectory === 'string'
          ? obj.workspaceDirectory
          : undefined;
      cached = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        rawTitle: obj?.title || obj?.name || '',
        text: parsed.text,
        firstUserText: parsed.firstUserText,
        hasImage: parsed.hasImage,
        hasAttachment: parsed.hasAttachment,
        contextPercentage: ctxPct,
        workspacePath: wsPath,
        executionIds: parsed.executionIds,
      };
      indexCache.set(full, cached);
    }

    // 最终标题：清单官方标题优先，其次单文件标题，最后 Untitled
    return {
      sessionId: entry.sessionId,
      modified: cached.mtimeMs,
      size: cached.size,
      title: entry.title || cached.rawTitle || 'Untitled',
      text: cached.text,
      firstUserText: cached.firstUserText,
      hasImage: cached.hasImage,
      hasAttachment: cached.hasAttachment,
      contextPercentage: cached.contextPercentage,
      workspacePath: cached.workspacePath,
      executionIds: cached.executionIds,
    };
  },

  evictMissing(dir: string, seenPaths: ReadonlySet<string>): void {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    for (const key of indexCache.keys()) {
      if (key.startsWith(prefix) && !seenPaths.has(key)) {
        indexCache.delete(key);
      }
    }
  },

  decorateHits(dir: string, hits: SearchHit[], records: readonly OldSessionRecord[]): void {
    const ws = workspacePathOf(records);
    const execIds = execIdsOf(records);
    attachCredits(dir, hits, ws, execIds);
    attachFootprints(dir, hits, ws, jsonBytesOf(records), execIds);
  },
};

/** 取一组会话里的工作区 fsPath（同一目录下的会话共享同一工作区）。 */
function workspacePathOf(entries: readonly OldSessionRecord[]): string | undefined {
  for (const e of entries) {
    if (e.workspacePath) return e.workspacePath;
  }
  return undefined;
}

/** 建立 sessionId → 会话 JSON 字节数 的映射（取自索引缓存的 stat.size，零额外 IO）。 */
function jsonBytesOf(entries: readonly OldSessionRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.sessionId, e.size);
  return m;
}

/** 建立 sessionId → 其 history executionId 列表 的映射（供 lineage 追溯）。 */
function execIdsOf(entries: readonly OldSessionRecord[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of entries) m.set(e.sessionId, e.executionIds);
  return m;
}

/**
 * 为最终返回的结果集补充 credit 用量（只对有限的结果集做汇总，避免无谓开销）。
 * credit 按执行存档的 chatSessionId 与会话 sessionId 匹配汇总，并顺 history executionId
 * 追溯 checkpoint 祖先会话一并合计（见 credits.ts 说明）；查不到带用量的执行则保持
 * undefined，由上层回退展示 contextPercentage。异常一律吞掉，不影响搜索结果本身。
 */
function attachCredits(
  dir: string,
  hits: SearchHit[],
  workspacePath: string | undefined,
  execIdsById: Map<string, string[]>
): void {
  if (!hits.length) return;
  let storeRoot: string;
  try {
    storeRoot = storeRootFromSessionDir(dir);
  } catch {
    return;
  }
  for (const hit of hits) {
    try {
      const ids = execIdsById.get(hit.sessionId);
      // C：会话自身消耗（不含 checkpoint 继承）
      const self = getCreditsForSessions(storeRoot, [hit.sessionId], {
        workspacePath,
        includeLineage: false,
      });
      if (self.found) hit.credits = self.credits;
      // A：整段对话累计（含 checkpoint 祖先链）
      const lineage = getCreditsForSessions(storeRoot, [hit.sessionId], {
        workspacePath,
        historyExecutionIds: ids,
      });
      if (lineage.found) hit.creditsLineage = lineage.credits;
    } catch {
      // 汇总失败不影响结果展示
    }
  }
}

/**
 * 为最终返回的结果集补充存储占用字段（流水线 A：唯一随结果渲染自动发生的取数）。
 *
 * 零额外目录枚举（Req 7.2、7.7）：
 * - 会话 JSON 字节数复用 `SessionIndexEntry.size`——读取阶段早已 stat 过每个会话文件，
 *   这里只是把它带出来，不再碰盘。
 * - 存档字节数取自 `listArchiveEntries()`：ArchiveIndex 的只读快照，内部 4 秒节流且用
 *   `workspacePath` 把刷新限定到当前工作区的 workspaceId 目录，因此恒不触碰其它工作区，
 *   也不走 SizeScanner 的 `scanTree`（Property 15）。
 * - 归因一律走 `computeSessionFootprint`，与摘要 / 排行 / 孤儿判定同一口径，不另写匹配逻辑。
 *
 * 只对**已截断**的结果集（最近 20 / 搜索 10）调用，与 `attachCredits` 并列。单条会话
 * 失败（拿不到 size 或归因抛错）时省略该条字段并继续处理其余结果（Req 5.4、9.6）；
 * 只下发 JSON 与两个口径的存档字节数，不下发任何"总量"——展示值由前端相加，保证
 * tooltip 的拆解行与角标数值同源。
 *
 * FullCleanup 删除的会话在后续取数中自然被排除（Req 14.15）：每次取数都重新
 * `readdirSync`，消失的文件既不进 `records` 也会被从 `indexCache` 摘除；其残留存档由
 * `dropArchiveEntries` 在删除时同步摘出 ArchiveIndex，故不需要额外的失效入口。
 */
function attachFootprints(
  dir: string,
  hits: SearchHit[],
  workspacePath: string | undefined,
  jsonBytesById: Map<string, number>,
  execIdsById: Map<string, string[]>
): void {
  if (!hits.length) return;
  let archives: readonly ArchiveInfo[];
  try {
    archives = listArchiveEntries(storeRootFromSessionDir(dir), { workspacePath });
  } catch {
    // 存档索引整体不可用：全部省略占用字段，不影响搜索结果本身
    return;
  }

  for (const hit of hits) {
    try {
      const jsonBytes = jsonBytesById.get(hit.sessionId);
      if (jsonBytes === undefined) continue;
      const historyExecutionIds = execIdsById.get(hit.sessionId);
      const self = computeSessionFootprint(
        { sessionId: hit.sessionId, jsonBytes, scope: 'self' },
        archives
      );
      const lineage = computeSessionFootprint(
        { sessionId: hit.sessionId, jsonBytes, scope: 'lineage', historyExecutionIds },
        archives
      );
      // 两个口径都算完才写回，避免单条异常留下半套字段
      hit.sessionJsonBytes = self.jsonBytes;
      hit.archiveBytesSelf = self.archiveBytes;
      hit.archiveBytesLineage = lineage.archiveBytes;
      hit.archivesFound = self.archivesFound || lineage.archivesFound;
    } catch {
      // 单条归因失败：省略该条字段，其余结果照常
    }
  }
}

/* ================================================================== *
 * 三、1.x 实现：目录型会话（读取委托 session/newFormat.ts）
 * ================================================================== */

/**
 * 1.x 新格式来源：一个会话 = NewWorkspaceSessionDir 下的一个 `<sessionId>/` **目录**。
 *
 * 四段职责与 {@link SessionSource} 一一对应，且**没有一行读取逻辑写在这里**——
 * 枚举、读取、缓存收尾全部委托 `session/newFormat.ts`，用量委托 `credits.ts`：
 *
 * - `listEntries`：`listNewSessionDirs`（只枚举子目录，不读内容）
 * - `readSession`：`readNewSession`（按 `session.json` + `messages.jsonl` 的
 *   `(mtimeMs, size)` 命中缓存，未变化的会话不重读，Req 3.11）
 * - `evictMissing`：`evictMissingNewSessions`（缓存归 newFormat 所有，收尾也在那边）
 * - `decorateHits`：`getSessionCreditScopes({ format: 'new' })`（Req 4.3、4.9）
 *
 * 刻意不填 {@link SessionEntry.title}：1.x 没有 `sessions.json` 那层标题清单，
 * 标题由读取阶段从 `session.json` 取并做 `Untitled` 兜底（Req 3.2）。
 *
 * 占用字节数（`sessionJsonBytes` / `archiveBytesSelf` …）此处**不填**：1.x 的口径是
 * 「会话本体 = `session.json` + `messages.jsonl`，附件 = `snapshots/` + `sub-executions/`」
 * （Req 6.9），需要枚举会话目录才能得出，属 StorageAnalyzer 的新布局取数（任务 11.1）。
 * 未填时渲染层按既有规则省略占用角标，不会显示 0。
 */
export const newSessionSource: SessionSource<NewSessionRecord> = {
  kind: 'new',

  listEntries(dir: string): SessionEntry[] | null {
    const dirs = listNewSessionDirs(dir);
    // null 原样透传：目录不可枚举 ≠ 目录里没有会话（见 SessionSource.listEntries）
    if (!dirs) return null;
    return dirs.map((sessionDir) => ({
      sessionId: path.basename(sessionDir),
      path: sessionDir,
    }));
  },

  readSession(entry: SessionEntry): NewSessionRecord | null {
    return readNewSession(entry.path);
  },

  evictMissing(dir: string, seenPaths: ReadonlySet<string>): void {
    evictMissingNewSessions(dir, seenPaths);
  },

  decorateHits(_dir: string, hits: SearchHit[], records: readonly NewSessionRecord[]): void {
    if (!hits.length) return;
    const dirById = new Map<string, string>();
    for (const r of records) dirById.set(r.sessionId, r.dir);

    for (const hit of hits) {
      const sessionDir = dirById.get(hit.sessionId);
      if (!sessionDir) continue;
      try {
        // 1.x 的 self 与 lineage 取同一值（用量记在会话自身消息流里，design D4）；
        // 不可用时保持字段缺席，由渲染层省略角标（Req 4.7、4.8）
        const scopes = getSessionCreditScopes({ format: 'new', sessionDir });
        if (scopes.self !== null) hit.credits = scopes.self;
        if (scopes.lineage !== null) hit.creditsLineage = scopes.lineage;
      } catch {
        // 单条用量解析失败：省略该条角标，其余结果照常（Req 4.8）
      }
    }
  },
};

/* ================================================================== *
 * 四、与格式无关的匹配流水线（单源与双源共用同一份实现）
 * ================================================================== */

/**
 * 已绑定目录的来源：把「哪个来源 + 哪个目录 + 它枚举出的记录」封进闭包，
 * 对外只剩两个与格式无关的动作（{@link collect} / {@link decorate}），
 * 使流水线能同时持有新旧两个来源而不必把记录类型退化成 `any`。
 */
interface BoundSource {
  readonly kind: SessionSourceKind;
  readonly dir: string;
  /** 枚举 + 读取该来源的全部记录，并记住它们供 {@link decorate} 使用。 */
  collect(): SessionRecord[];
  /** 把该来源特有的字段（用量 / 占用）补到**属于它**的那部分结果上。 */
  decorate(hits: SearchHit[]): void;
}

/**
 * 把一个来源绑定到一个目录。
 *
 * 入参刻意取**格式无关**的 `SessionSource`（即 `SessionSource<SessionRecord>`）而不是
 * 泛型 `SessionSource<R>`：绑定层不需要知道具体记录类型——`collect()` 的产出只被匹配
 * 流水线按 {@link SessionRecord} 消费，`decorate()` 又把同一批记录原样递还给**产出它们
 * 的那个来源**，R 在本函数里没有任何用处。泛型化反而有害：`sources?.newSource ??
 * newSessionSource` 这类注入点是个联合类型（注入的格式无关来源 | 本模块的新格式来源），
 * R 只能被推断成其中一支，另一支必然不兼容。
 *
 * 为什么 `SessionSource<NewSessionRecord>`（及 `SessionSource<OldSessionRecord>`）能当
 * `SessionSource<SessionRecord>` 用——两层理由：
 *
 * - **类型上**：R 主要出现在 `readSession` 的**返回**位置（协变，子类型记录当父类型用
 *   恒安全）；唯一出现在参数位置的是 `decorateHits(dir, hits, records)`，而 TS 对
 *   **方法**形参按双变处理，故赋值成立。
 * - **运行时上**：安全性不靠双变这条规则，而靠本函数的闭包——`records` 只可能由
 *   `collect()` 写入、且写入的恒是**同一个 source** 自己 `readSession` 的产出，
 *   闭包外无人能替换它。因此 `newSessionSource.decorateHits` 收到的元素恒是
 *   `NewSessionRecord`，`oldSessionSource` 收到的恒是 `OldSessionRecord`；
 *   「把 A 源的记录喂给 B 源的 decorateHits」在这里没有入口可以做到。
 */
function bindSource(source: SessionSource, dir: string): BoundSource {
  let records: readonly SessionRecord[] = [];
  return {
    kind: source.kind,
    dir,
    collect() {
      const collected = collectSessions(source, dir);
      records = collected;
      return collected;
    },
    decorate(hits: SearchHit[]) {
      if (!hits.length) return;
      // records 是该源枚举到的**全部**记录（含被去重丢弃的那些）：它们只被用来建
      // sessionId → 归因输入的映射，多几条不会产生多余结果，也省掉一次过滤
      source.decorateHits?.(dir, hits, records);
    },
  };
}

/** 一条带来源与迁移状态的记录（流水线内部形状）。 */
interface SourcedRecord {
  record: SessionRecord;
  kind: SessionSourceKind;
  origin: SessionOrigin;
}

/** 命中结果的两个可变部分；由 {@link Matcher} 产出，其余字段一律来自记录本身。 */
interface MatchResult {
  snippet: string;
  matchField: 'title' | 'message' | 'recent';
}

/** 匹配规则：返回 `null` 表示该会话不进结果集。与来源无关，故两种格式共用（Req 3.5）。 */
type Matcher = (record: SessionRecord) => MatchResult | null;

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/**
 * 多源枚举 + 合并去重 + 来源判定（Req 13.1–13.3、9.1–9.5、9.8）。
 *
 * 三件事必须按这个顺序做，顺序本身是需求：
 *
 * 1. **各源分别枚举读取**，先把两侧的 sessionId 集合都拿到；
 * 2. **去重**：同一 sessionId 在双源各有一份时丢掉**旧格式**那份（Req 13.3）。
 *    去重发生在匹配**之前**而不是之后——被丢弃的旧份连关键词匹配都不参与，
 *    因此「新格式是该会话的唯一展示来源」不依赖两份内容是否恰好都命中；
 * 3. **来源判定**：用去重**之前**的两侧集合（否则「另一侧也有一份」永远为假，
 *    Req 9.8 的 `migrated` 就判不出来）+ 旧目录里的 MigrationMarker（Req 9.5）。
 *
 * 迁移标记只在 0.9x 会话目录里出现，故只对 `kind === 'old'` 的源采集；
 * `new-only` 布局下没有旧目录可读，标记集合为空，判定退化为「按 `sess_` 前缀分」，
 * 与 Req 9.2、9.3 一致。
 */
function collectAcross(bounds: readonly BoundSource[]): SourcedRecord[] {
  const collected = bounds.map((bound) => ({ bound, records: bound.collect() }));

  // 各侧的 sessionId 集合（去重前的快照，来源判定要用它）
  const idsByKind = new Map<SessionSourceKind, Set<string>>();
  for (const { bound, records } of collected) {
    let ids = idsByKind.get(bound.kind);
    if (!ids) {
      ids = new Set<string>();
      idsByKind.set(bound.kind, ids);
    }
    for (const r of records) ids.add(r.sessionId);
  }
  const newIds = idsByKind.get('new') ?? EMPTY_IDS;
  const oldIds = idsByKind.get('old') ?? EMPTY_IDS;

  // 旧目录里的迁移标记（`._migration-<uuid>.json` 的 v2SessionId）
  const migratedIds = new Set<string>();
  for (const { bound } of collected) {
    if (bound.kind !== 'old') continue;
    for (const id of collectMigratedSessionIds(bound.dir)) migratedIds.add(id);
  }

  const out: SourcedRecord[] = [];
  const emitted = new Set<string>();
  for (const { bound, records } of collected) {
    const kind = bound.kind;
    for (const record of records) {
      const id = record.sessionId;
      // 同 sessionId 双份：只保留新格式那份（Req 13.3、9.8）
      if (kind === 'old' && newIds.has(id)) continue;
      // 兜住「同一 kind 挂了多个目录」这种非常规装配，保证一个 sessionId 只出现一次
      if (emitted.has(id)) continue;
      emitted.add(id);

      out.push({
        record,
        kind,
        origin: determineSessionOrigin({
          sessionId: id,
          source: kind,
          presentInOtherSide: kind === 'new' ? oldIds.has(id) : newIds.has(id),
          hasMigrationMarker: migratedIds.has(id),
        }),
      });
    }
  }
  return out;
}

/** 记录 + 匹配结果 → SearchHit。两种格式共用，故字段结构恒一致（Req 13.5）。 */
function toHit(sourced: SourcedRecord, match: MatchResult): SearchHit {
  const e = sourced.record;
  return {
    sessionId: e.sessionId,
    title: e.title || 'Untitled',
    modified: e.modified,
    snippet: match.snippet,
    matchField: match.matchField,
    hasImage: e.hasImage,
    hasAttachment: e.hasAttachment,
    contextPercentage: e.contextPercentage,
    origin: sourced.origin,
    layout: sourced.kind,
  };
}

/**
 * 流水线本体：枚举 → 匹配 → 排序 → 截断 → 按来源补字段。
 *
 * 排序恒按最后修改时间**倒序**，截断恒在排序之后（Req 13.4）。`Array.prototype.sort`
 * 是稳定排序，而 {@link boundsFor} 把新格式源排在前面，因此修改时间完全相同的两条
 * 结果里新格式那条恒在前——不是巧合，是刻意让「以 1.x 为主」在等值时也成立。
 *
 * `decorateHits` 只对**截断后**的结果调用，且只收到属于自己那一侧的结果：
 * 旧格式的存档归因不会被喂进 1.x 会话，1.x 的消息流用量也不会被喂进旧会话。
 */
function runPipeline(bounds: readonly BoundSource[], limit: number, match: Matcher): SearchHit[] {
  if (!bounds.length) return [];

  const out: SearchHit[] = [];
  for (const sourced of collectAcross(bounds)) {
    const m = match(sourced.record);
    if (m) out.push(toHit(sourced, m));
  }

  out.sort((a, b) => b.modified - a.modified);
  const limited = out.slice(0, limit);

  for (const bound of bounds) {
    bound.decorate(limited.filter((hit) => hit.layout === bound.kind));
  }
  return limited;
}

/** 关键词匹配：先标题、标题未命中再消息文本，不区分大小写（既有规则，Req 3.5）。 */
function keywordMatcher(keyword: string): Matcher {
  const re = new RegExp(escapeRegExp(keyword), 'i');
  return (e) => {
    if (re.test(e.title)) return { snippet: e.title, matchField: 'title' };
    const m = re.exec(e.text);
    if (!m) return null;
    return { snippet: makeSnippet(e.text, m.index), matchField: 'message' };
  };
}

/** 「最近列表」：全部会话都进结果集，snippet 取首条用户消息预览（既有规则）。 */
const recentMatcher: Matcher = (e) => ({
  snippet: e.firstUserText ? e.firstUserText.slice(0, 160).replace(/\s+/g, ' ').trim() : '',
  matchField: 'recent',
});

/**
 * 在指定的会话目录中按关键词全文搜索。
 * 返回结果按修改时间倒序，并截断到 limit 条。
 *
 * `source` 是双版本的注入点，缺省为 0.9x 的 {@link oldSessionSource}；
 * 前三个参数与返回值的语义不随注入改变。**双源合并请用
 * {@link searchSessionsInLayout}**——本函数恒只取一个目录。
 */
export function searchSessionsInDir(
  dir: string,
  keyword: string,
  limit = 10,
  source: SessionSource = oldSessionSource
): SearchHit[] {
  if (!keyword.trim()) return [];
  return runPipeline([bindSource(source, dir)], limit, keywordMatcher(keyword));
}

export function makeSnippet(text: string, idx: number, span = 80): string {
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

/**
 * 列出指定会话目录下**最近 limit 条**会话（按 mtime 倒序）。
 * 用于无搜索关键词时的默认展示，snippet 取自会话首条用户消息预览。
 * 任何文件级异常都被静默跳过，与 searchSessionsInDir 一致。
 *
 * `source` 同样是双版本的注入点，缺省为 0.9x 的 {@link oldSessionSource}；
 * 双源合并请用 {@link listRecentSessionsInLayout}。
 */
export function listRecentSessions(
  dir: string,
  limit = 20,
  source: SessionSource = oldSessionSource
): SearchHit[] {
  return runPipeline([bindSource(source, dir)], limit, recentMatcher);
}

/* ------------------------------------------------------------------ *
 * 双源入口：按 StorageLayout 选择来源
 * ------------------------------------------------------------------ */

/**
 * 双源取数所需的最小输入：布局结论 + 两侧的工作区会话目录。
 *
 * 声明成结构类型而不是直接吃 `LayoutRoots`，是为了让 `detectLayout` 的产出与
 * `EnvCheck` 派生出的对象都能原样传进来（前者字段更多，多出的属性不影响赋值）。
 */
export interface LayoutSessionDirs {
  /** 布局结论；决定启用哪几个来源（Req 13.1、13.2）。 */
  layout: StorageLayout;
  /** `<NewSessionsRoot>/<WsHash16>`；不可用为 `null`。 */
  newWorkspaceSessionDir: string | null;
  /** `<OldSessionsRoot>/<OldEncodedKey>`；不可用为 `null`。 */
  oldWorkspaceSessionDir: string | null;
}

/** 来源注入点（测试用）；缺省为本模块的两个默认实现。 */
export interface LayoutSources {
  newSource?: SessionSource;
  oldSource?: SessionSource;
}

/**
 * 按布局选择来源（Req 13.1、13.2）：
 * `both` → 新 + 旧，`new-only` → 只新，`old-only` → 只旧，`none` → 无。
 *
 * 布局说要用某一侧、但那一侧的目录为 `null` 时只跳过它：`detectLayout` 与本次取数
 * 之间目录可能刚被删掉，少一侧结果也比整份列表为空好。新格式源恒排在前，
 * 使等值排序与去重都以 1.x 为主（见 {@link runPipeline}）。
 */
function boundsFor(dirs: LayoutSessionDirs, sources?: LayoutSources): BoundSource[] {
  const useNew = dirs.layout === 'both' || dirs.layout === 'new-only';
  const useOld = dirs.layout === 'both' || dirs.layout === 'old-only';

  const out: BoundSource[] = [];
  if (useNew && dirs.newWorkspaceSessionDir) {
    out.push(bindSource(sources?.newSource ?? newSessionSource, dirs.newWorkspaceSessionDir));
  }
  if (useOld && dirs.oldWorkspaceSessionDir) {
    out.push(bindSource(sources?.oldSource ?? oldSessionSource, dirs.oldWorkspaceSessionDir));
  }
  return out;
}

/**
 * 按关键词搜索当前工作区的会话，**跨新旧两种布局**合并去重（Req 13.1–13.5、3.5）。
 *
 * 与 {@link searchSessionsInDir} 的差别只在取数范围：匹配规则、`matchField`、snippet
 * 截取、排序与截断（默认 10 条）全部是同一份实现，不因来源分支。
 */
export function searchSessionsInLayout(
  dirs: LayoutSessionDirs,
  keyword: string,
  limit = 10,
  sources?: LayoutSources
): SearchHit[] {
  if (!keyword.trim()) return [];
  return runPipeline(boundsFor(dirs, sources), limit, keywordMatcher(keyword));
}

/**
 * 列出当前工作区**最近 limit 条**会话（默认 20 条），跨新旧两种布局合并去重
 * （Req 13.1–13.5）。无关键词时的默认展示。
 */
export function listRecentSessionsInLayout(
  dirs: LayoutSessionDirs,
  limit = 20,
  sources?: LayoutSources
): SearchHit[] {
  return runPipeline(boundsFor(dirs, sources), limit, recentMatcher);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
