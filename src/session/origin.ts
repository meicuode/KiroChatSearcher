import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import type { SessionOrigin } from '../storage/types';

/**
 * SessionOrigin 判定（Req 9.1–9.5、9.8、9.9）：一个会话是 1.x 里新建的、从 0.9x 迁移来的，
 * 还是**只**留在旧目录里没被搬走。
 *
 * 判定被刻意拆成两半：
 *
 * 1. **纯函数** {@link determineSessionOrigin}：只吃「这条会话读自哪一侧」「另一侧有没有
 *    同 sessionId」「旧目录里有没有指向它的 MigrationMarker」三个布尔事实，零 IO。
 *    因此同一磁盘状态下恒返回同一取值（Req 9.9），也让上层无论走同步还是异步 fs
 *    都能复用同一份规则——`search.ts`（同步）与 `storage/ranking.ts`（异步注入 fs）
 *    共用的正是它，两处不存在第二份判定逻辑。
 * 2. **事实采集**：{@link collectMigratedSessionIds} 用同步只读 fs 把旧目录里的
 *    `._migration-<uuid>.json` 读成一组 `v2SessionId`；异步调用方（ranking）用自己的
 *    注入 fs 读文件，再交给纯函数 {@link parseMigrationMarker} 解析。
 *
 * 本模块位于 **ReadOnlyPaths**：只从 `fs` 具名导入 `readdirSync` / `readFileSync`——
 * 写 API（`unlink` / `writeFile` / `rmdir` / `rm` / `rename` / `cp`）连导入都不存在，
 * 因此「来源判定零写入」是模块依赖图上可静态审查的事实（Req 12.1、12.2）。
 * 除类型外不 import 任何本仓模块，故可被 `search.ts`、`storage/ranking.ts`、
 * `storage/analyzer.ts`、`storage/cleaner.ts` 同时引用而不引入循环。
 */

/* ------------------------------------------------------------------ *
 * 1. sessionId 形态
 * ------------------------------------------------------------------ */

/**
 * 1.x 中**新建**会话的 sessionId 前缀（实测形如 `sess_1f0d2c3b-…`）。
 *
 * 迁移来的会话沿用 0.9x 的裸 uuid，因此「新目录里的会话是否带这个前缀」正是
 * 「1.x 新建」与「从 0.9x 迁移」的分界（Req 9.2、9.3）。
 */
export const NEW_SESSION_ID_PREFIX = 'sess_';

/** sessionId 是否为 1.x 新建形态（带 {@link NEW_SESSION_ID_PREFIX} 前缀）。 */
export function isNewSessionId(sessionId: string): boolean {
  return sessionId.startsWith(NEW_SESSION_ID_PREFIX);
}

/* ------------------------------------------------------------------ *
 * 2. MigrationMarker
 * ------------------------------------------------------------------ */

/**
 * 0.9x 会话目录里迁移标记的文件名前缀：`._migration-<uuid>.json`。
 *
 * 与 `layout.ts` 判定「旧目录里有没有会话文件」时排除的是同一批文件——那边只需要
 * 认出名字，这边还要读出内容，故两处各自持有这个前缀常量而不互相依赖：
 * 布局检测是路径层的下游，不该为了一个字符串反向依赖会话层。
 */
export const MIGRATION_MARKER_PREFIX = '._migration-';

/** 迁移标记的文件名后缀。 */
export const MIGRATION_MARKER_SUFFIX = '.json';

/** 文件名是否为迁移标记（`._migration-<uuid>.json`）。 */
export function isMigrationMarkerFileName(name: string): boolean {
  return name.startsWith(MIGRATION_MARKER_PREFIX) && name.endsWith(MIGRATION_MARKER_SUFFIX);
}

/**
 * 迁移标记的内容形状（实测 Kiro 1.0.337 写出的 `._migration-<uuid>.json`）。
 *
 * 只有 {@link v2SessionId} 是判定所需，其余字段仅供排查与审计。
 * 特别注意 `workspaceHash` 用的是**旧**算法 `sha256(原始路径).slice(0,16)`，
 * 与 1.x 新目录名 WsHash16（先归一化再摘要）不是一回事，**不能**拿它去定位新目录
 * （见 `paths.ts` 的同一告示与 `tests/paths.newlayout.spec.ts` 的回归用例）。
 */
export interface MigrationMarker {
  /** 迁移后在 1.x 里的 sessionId；这是判定「已迁移」的唯一依据（Req 9.5）。 */
  v2SessionId: string;
  migratedAt?: string;
  /** 旧算法哈希（`sha256(原始路径)` 前 16 位），**不等于** WsHash16。 */
  workspaceHash?: string;
  v1WorkspaceDirectory?: string;
  markerVersion?: number;
}

/**
 * 纯函数：把迁移标记文本解析为 {@link MigrationMarker}。
 *
 * 逐字段校验类型而不是直接断言：这是外部进程写的文件，`v2SessionId` 缺失或变型时
 * 必须判为「不可用」而不是把 `undefined` 当成一个 sessionId 塞进判定集合——那会让
 * 一整批会话被误判为已迁移，而「已迁移」正是旧残留清理敢删的前提（design D8）。
 *
 * @returns JSON 非法、顶层不是对象、或 `v2SessionId` 不是非空字符串时返回 `null`。
 */
export function parseMigrationMarker(raw: string): MigrationMarker | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const v2 = typeof o.v2SessionId === 'string' ? o.v2SessionId.trim() : '';
  if (!v2) return null;
  return {
    v2SessionId: v2,
    migratedAt: str(o.migratedAt),
    workspaceHash: str(o.workspaceHash),
    v1WorkspaceDirectory: str(o.v1WorkspaceDirectory),
    markerVersion: typeof o.markerVersion === 'number' ? o.markerVersion : undefined,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/* ------------------------------------------------------------------ *
 * 3. 判定规则（纯函数）
 * ------------------------------------------------------------------ */

/** {@link determineSessionOrigin} 的输入：三个可在同一磁盘状态下重复观测的事实。 */
export interface SessionOriginInput {
  /** 会话 id（1.x 取会话目录名，0.9x 取 `<sessionId>.json` 的文件名主干）。 */
  sessionId: string;
  /**
   * 这条会话记录**读自哪一侧**：`new` = 1.x NewSessionDir，`old` = 0.9x 单文件。
   *
   * 取「读自哪一侧」而不是「在不在新目录」这类布尔组合，是为了让「两侧都不存在」
   * 这种无意义输入在类型上就构造不出来——判定因此是全函数，无需为不可能的组合
   * 编一个兜底取值。
   */
  source: 'new' | 'old';
  /** 另一侧是否也有同 sessionId 的一份（`both` 布局下的重复份，Req 9.8）。 */
  presentInOtherSide?: boolean;
  /** 旧目录里是否存在 `v2SessionId` 指向该 sessionId 的 MigrationMarker（Req 9.5）。 */
  hasMigrationMarker?: boolean;
}

/**
 * 判定单个会话的 SessionOrigin（纯函数，同输入同输出）。
 *
 * 规则按下面的顺序，先命中者胜：
 *
 * | # | 条件 | 取值 | 依据 |
 * | --- | --- | --- | --- |
 * | 1 | 另一侧也有同 sessionId 的一份 | `migrated` | Req 9.8 |
 * | 2 | 旧目录里有指向它的 MigrationMarker | `migrated` | Req 9.5 |
 * | 3 | 读自新目录且 sessionId 带 `sess_` 前缀 | `new` | Req 9.2 |
 * | 4 | 读自新目录且 sessionId 是裸 uuid | `migrated` | Req 9.3 |
 * | 5 | 读自旧目录且以上均不成立 | `legacy-unmigrated` | Req 9.4 |
 *
 * 为什么规则 1、2 排在前缀规则**之前**：`both` 布局下同 sessionId 双份恒判为
 * `migrated`（Req 9.8 的原文，Property 9 要钉住），而标记文件本身就是「这条会话
 * 已经搬走了」的一手证据（Req 9.5 不限侧）。若先看前缀，一个带 `sess_` 前缀却确有
 * 标记/重复份的会话会被判成 `new`，与两条需求直接冲突。
 *
 * 规则 5 是**唯一**产出 `legacy-unmigrated` 的路径，且要求「读自旧目录」：这个取值
 * 意味着「该会话在 1.x 界面里看不见，删掉即永久丢失」（design D8 据此把它排除在旧残留
 * 清理集合之外），因此绝不能拿它当缺省兜底值。
 */
export function determineSessionOrigin(input: SessionOriginInput): SessionOrigin {
  const { sessionId, source, presentInOtherSide = false, hasMigrationMarker = false } = input;
  if (presentInOtherSide || hasMigrationMarker) return 'migrated';
  if (source === 'new') return isNewSessionId(sessionId) ? 'new' : 'migrated';
  return 'legacy-unmigrated';
}

/* ------------------------------------------------------------------ *
 * 4. 事实采集：旧目录里的迁移标记
 * ------------------------------------------------------------------ */

/** 可注入的**只读**同步 fs 依赖（形状对齐 `session/newFormat.ts` 的 `NewFormatFsDeps`）。 */
export interface OriginFsDeps {
  readdirSync?: (p: string) => string[];
  readFileSync?: (p: string, enc: 'utf8') => string;
}

/**
 * 迁移标记的解析缓存：键为标记文件绝对路径，值为 `v2SessionId`（不可解析为 `null`）。
 *
 * 缓存不带 `(mtimeMs, size)` 失效判据——与会话缓存的取舍不同，因为标记文件是
 * **一次写入后不再改动**的：文件名里带 uuid，内容记录的是那一次迁移的结果。
 * 因此同一路径重复解析恒得同一结果，缓存只需要「见过的不再读」。
 * 旧残留清理删掉标记后，对应键不会再出现在 `readdirSync` 的结果里，故读不到陈旧值；
 * 已消失的键在下一次扫同一目录时被摘除，避免长期运行后无界增长。
 */
const markerCache = new Map<string, string | null>();

/** 测试辅助：清空迁移标记缓存（对齐 `search.ts` 的 `__clearIndexCacheForTest`）。 */
export function __clearMigrationMarkerCacheForTest(): void {
  markerCache.clear();
}

/**
 * 枚举 0.9x 工作区会话目录里的全部 MigrationMarker，返回它们指向的 sessionId 集合
 * （Req 9.5）。
 *
 * 集合语义是「这些 sessionId 已经被官方迁移工具搬到 1.x 了」，供来源判定与旧残留
 * 划分共用。目录不可枚举、单个标记读失败或内容非法时都只跳过对应项并继续，
 * **全程不抛异常**：拿不到标记只会让判定退化为「按是否出现在新目录判断」，
 * 而抛异常会让整份搜索结果消失。
 *
 * @param oldWorkspaceSessionDir OldWorkspaceSessionDir 绝对路径。
 * @param deps 只读 fs 注入点，缺省用真实 `fs`。
 */
export function collectMigratedSessionIds(
  oldWorkspaceSessionDir: string,
  deps?: OriginFsDeps
): Set<string> {
  const readdir = deps?.readdirSync ?? ((p: string) => readdirSync(p));
  const readFile = deps?.readFileSync ?? ((p: string, enc: 'utf8') => readFileSync(p, enc));

  const ids = new Set<string>();
  let names: string[];
  try {
    names = readdir(oldWorkspaceSessionDir);
  } catch {
    // 目录不存在 / 不可读：没有可用标记，交由调用方按「无标记」处理
    return ids;
  }

  const seen = new Set<string>();
  for (const name of names) {
    if (!isMigrationMarkerFileName(name)) continue;
    const full = path.join(oldWorkspaceSessionDir, name);
    seen.add(full);

    let cached = markerCache.get(full);
    if (cached === undefined) {
      let raw: string;
      try {
        raw = readFile(full, 'utf8');
      } catch {
        // 读失败不写缓存：下次可能可读（权限恢复 / 写入完成）
        continue;
      }
      cached = parseMigrationMarker(raw)?.v2SessionId ?? null;
      markerCache.set(full, cached);
    }
    if (cached !== null) ids.add(cached);
  }

  evictMissingMarkers(oldWorkspaceSessionDir, seen);
  return ids;
}

/** 摘除缓存中已在该目录里消失的标记键（与 `search.ts` 的同类收尾同一写法）。 */
function evictMissingMarkers(dir: string, seenPaths: ReadonlySet<string>): void {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const key of markerCache.keys()) {
    if (key.startsWith(prefix) && !seenPaths.has(key)) markerCache.delete(key);
  }
}
