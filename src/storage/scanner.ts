import { readdir, lstat } from 'fs/promises';
import * as path from 'path';
import { classifyPath, type ClassifyRoots } from './classify';
import type { StorageCategory } from './types';

/**
 * SizeScanner：以只读方式遍历一棵目录树，把每个条目的 `lstat().size` 归入唯一分类。
 *
 * 本模块位于 ReadOnlyPaths，只从 `fs/promises` 具名导入 `readdir` 与 `lstat`
 * 两个读 API——写 API 连导入都不存在，因此「统计路径零写入」是模块图上可静态
 * 审查的事实，而不是注释里的承诺。
 *
 * 四条遍历预算全部落在同一处循环里：
 *
 * - 异步 API，每处理 `yieldEvery`（默认 512）个目录条目让出一次事件循环（Req 7.3）
 * - 只 `readdir(withFileTypes)` + `lstat`，绝不 `open` / `read` 被统计文件内容（Req 7.4）
 * - 递归深度上限 `maxDepth`（默认 8），超深子树计入 `skippedCount` 并置 `partial`（Req 7.8）
 * - 遇到符号链接不跟随，只按链接自身条目的字节数计入所在分类（Req 8.5）
 *
 * 单个条目的枚举或 stat 失败只累加 `skippedCount` 并继续，不向上抛异常（Req 9.1、9.2）；
 * `isCancelled()` 在每个目录入口与每次让出后检查，取消时立即带 `cancelled: true` 返回
 * 已完成的部分聚合（Req 6.7）。
 *
 * 传入 `ScanOptions.cache` 时，每个目录按 `(mtimeMs, 直接子条目数)` 查 `SubtreeCache`：
 * 命中则整棵子树复用聚合数字、不再递归（Req 7.6）；只有**完整遍历完**的目录才写入缓存，
 * 因此取消时已完成的子树留在缓存里可供下次复用，而被打断的那条链上的残缺聚合不会入缓存。
 *
 * **分类是唯一可替换的部分**（design D5）。Kiro 1.x 的新布局按
 * `snapshots/` / `sub-executions/` / 会话目录判定分类，规则与 0.9x 的
 * `classifyPath` 完全不同——但上面这套遍历、预算、让出频率、深度上限、
 * 符号链接不跟随、跳过计数与子树缓存**逐条相同**。因此这里选择注入
 * `ScanOptions.classify`，而**不是**再写一个新布局专用的扫描器：两份遍历实现
 * 会各自演化，任何一处预算或跳过语义的修改都得手工同步到另一份，
 * 而"忘了同步"在测试里表现为「一种布局的统计悄悄变慢或变得不完整」这类
 * 难以察觉的漂移。把差异收缩成一个 `(fullPath) => StorageCategory` 之后，
 * 遍历不变式只有一份实现、只被一套测试钉住。
 */

/** `readdir(withFileTypes)` 返回项所需的最小形状（便于测试注入）。 */
export interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

/** `lstat` 返回值所需的最小形状。 */
export interface StatLike {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * 可注入的文件系统依赖。只暴露两个读调用与一个让出钩子——调用面白名单因此
 * 可以被属性测试直接断言（Property 14(a)、16）。缺省退回 `fs/promises`，
 * 生产路径无额外抽象开销。
 */
export interface ScannerFsDeps {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<DirentLike[]>;
  lstat: (p: string) => Promise<StatLike>;
  /** 让出事件循环；测试注入计数器验证让出频率 */
  yieldNow?: () => Promise<void>;
}

/** 递归深度上限默认值（Req 7.8）。 */
export const DEFAULT_MAX_DEPTH = 8;
/** 让出事件循环的条目间隔默认值（Req 7.3）。 */
export const DEFAULT_YIELD_EVERY = 512;

export interface CategoryAgg {
  bytes: number;
  files: number;
}

export type CategoryTotals = Record<StorageCategory, CategoryAgg>;

export interface ScanResult {
  totals: CategoryTotals;
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
  cancelled: boolean;
  /** 恒等于 `skippedCount > 0`：存在跳过条目时各数值为下限（Req 9.2） */
  partial: boolean;
}

/**
 * 子树聚合缓存的结构化契约；`class SubtreeCache` 是其内置实现。
 *
 * 保留为独立接口而非直接依赖类：测试与 StorageAnalyzer 可以注入自己的实现
 * （例如统计命中率的探针），而 `scanTree` 只依赖这四个方法。
 */
export interface SubtreeCacheLike {
  get(dir: string, mtimeMs: number, childCount: number): ScanResult | undefined;
  set(dir: string, mtimeMs: number, childCount: number, agg: ScanResult): void;
  /** 失效单个目录条目（供清理后的逐级失效使用） */
  invalidate(dir: string): void;
  clear(): void;
}

export interface ScanOptions {
  /**
   * 0.9x 旧布局的分类根集合，供缺省分类器 `classifyPath(roots, p)` 使用。
   *
   * 保持**必填**：既有调用方全都在传它，改成可选会动到已上线的类型契约。
   * 只用新布局分类（即已传 `classify`）时它确实用不上，此时传
   * `buildClassifyRoots(userDataDir)` 的结果即可——缺省分类器不会被调用，
   * 其内容不参与任何计量。
   */
  roots: ClassifyRoots;
  /**
   * 自定义分类器；**提供时优先于 `roots`**（design D5）。
   *
   * 两者同时给出是合法且预期的用法：`classify` 决定每个条目的归类，`roots` 退居
   * 为"缺省分类器的参数"而不再被读取——`scanTree` 在传了 `classify` 的情况下
   * 一次都不会调用 `classifyPath`。
   *
   * 省略时退回 `classifyPath(roots, fullPath)`，行为与本字段引入之前**字节级一致**：
   * 缺省分类器在每次调用时才读 `opts.roots`，因此连"调用方在扫描途中改写
   * `opts.roots`"这种边角语义也保持原样。
   *
   * 实现约束：应为纯函数、不访问磁盘（扫描器位于 ReadOnlyPaths，且分类只依据
   * 路径字符串，Req 6.12）；对同一路径必须稳定返回同一分类，否则子树聚合缓存
   * 复用的结果与重新遍历的结果会不一致（Req 6.14、6.15）。
   */
  classify?: (fullPath: string) => StorageCategory;
  /** 默认 8 */
  maxDepth?: number;
  /** 默认 512 */
  yieldEvery?: number;
  isCancelled?: () => boolean;
  /**
   * 子树聚合缓存；省略即完全不缓存（`scanTree` 本身不持有跨调用状态，
   * 缓存实例的生命周期由 StorageAnalyzer 持有）。
   *
   * 同一个实例只应服务于同一组 `(root, maxDepth)`：缓存条目记的是"这棵子树在
   * 当前深度预算下的聚合"，若拿同一实例既扫 `<root>` 又扫其祖先目录，同一个目录
   * 会落在不同深度上，剩余预算不同却共用一条缓存。
   */
  cache?: SubtreeCacheLike;
  /** 便于测试注入；缺省退回 `fs/promises` 的 readdir / lstat */
  fsDeps?: ScannerFsDeps;
}

/**
 * 分类全集的**唯一**声明处，类型是 `Record<StorageCategory, true>`。
 *
 * 这样写是为了让「今后给 `StorageCategory` 加了新分类却漏改这里」变成**编译错误**
 * 而不是运行时的缺键：`Record` 要求键与联合类型逐一对应，少一个键 tsc 直接报
 * TS2739（缺属性）、多一个或拼错报 TS2322，两个方向都堵住。
 *
 * 换成 `readonly StorageCategory[]` 的数组字面量就没有这层保护——数组的元素类型
 * 只要求「每项都是某个分类」，不要求「每个分类都出现过」，漏项能编译通过，
 * 于是 `emptyCategoryTotals()` 少一个键、`mergeSubtree` 里 `dst.totals[c]` 取到
 * `undefined` 并在 `+=` 时抛错。本文件此前正是这个形态。
 */
const CATEGORY_KEYS: Record<StorageCategory, true> = {
  sessionJson: true,
  executionSaves: true,
  executionMetadata: true,
  unclassified: true,
  logs: true,
  workspaceStorage: true,
  otherFiles: true,
  newSession: true,
  newSnapshots: true,
  newSubExecutions: true,
  newSessionIndex: true,
};

/**
 * 全部分类，由 `CATEGORY_KEYS` 的键派生，故与 `StorageCategory` 恒同步——
 * 不存在「数组与联合类型两处各写一份」的漂移空间。
 * 顺序即上面对象字面量的书写顺序（本模块只用它做遍历，与展示顺序无关）。
 */
const ALL_CATEGORIES = Object.keys(CATEGORY_KEYS) as readonly StorageCategory[];

/** 全零的分类合计表（全部分类恒定齐全，调用方无需判空）。 */
export function emptyCategoryTotals(): CategoryTotals {
  const out = {} as CategoryTotals;
  for (const c of ALL_CATEGORIES) out[c] = { bytes: 0, files: 0 };
  return out;
}

/** 只保留数字的分类合计副本：即便调用方传进多余字段也不会进缓存（Req 7.11）。 */
function cloneTotals(src: CategoryTotals): CategoryTotals {
  const out = emptyCategoryTotals();
  for (const c of ALL_CATEGORIES) {
    const agg = src?.[c];
    out[c] = { bytes: safeCount(agg?.bytes), files: safeCount(agg?.files) };
  }
  return out;
}

/** 非有限值 / 负数一律归零，避免脏输入污染缓存里的合计。 */
function safeCount(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 目录键归一化：统一分隔符并去掉结尾分隔符，使 `set` / `get` / `invalidate`
 * 对同一目录的不同书写形态命中同一条目。刻意**不**做大小写折叠——大小写敏感的
 * 文件系统上折叠会把两个不同目录并成一条。
 */
function normalizeDirKey(dir: string): string {
  const normalized = path.normalize(dir);
  if (normalized.length <= 1) return normalized;
  const trimmed = normalized.replace(/[\\/]+$/, '');
  return trimmed.length > 0 ? trimmed : normalized;
}

/** 缓存条目：只有数字与固定的分类键（`ALL_CATEGORIES` 全集），没有文件列表、没有文件内容。 */
interface SubtreeCacheEntry {
  mtimeMs: number;
  childCount: number;
  totals: CategoryTotals;
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
}

/**
 * 目录子树聚合缓存：键为目录绝对路径，以 `(mtimeMs, 直接子条目数)` 作为失效判据
 * （Requirement 7.6）。
 *
 * 单看 `mtimeMs` 抓不到"改名 + 换回同一时间戳"这类同秒内的等价改动，单看子条目数
 * 抓不到"删一个加一个"，两者合用把常见变更都覆盖住，而代价仍是一次 `lstat`。
 *
 * 条目只存数字与分类标记，故常驻内存增量与被统计文件的字节数无关（Requirement 7.11）。
 * `get` 返回副本、`set` 存副本，调用方拿到结果后继续累加也不会回写缓存。
 *
 * 失效判据抓不到**孙辈**的删除：祖先目录的 `mtimeMs` 与直接子条目数都不因孙辈文件
 * 被删而变化，所以清理路径必须自被删文件所在目录向上逐级调用 `invalidate`
 * （Requirement 14.13），这也是 `invalidate(dir)` 存在的唯一理由。
 */
export class SubtreeCache implements SubtreeCacheLike {
  private readonly entries = new Map<string, SubtreeCacheEntry>();

  /** 当前条目数（诊断与测试用；不参与失效判据）。 */
  get size(): number {
    return this.entries.size;
  }

  get(dir: string, mtimeMs: number, childCount: number): ScanResult | undefined {
    const entry = this.entries.get(normalizeDirKey(dir));
    if (!entry) return undefined;
    if (entry.mtimeMs !== mtimeMs || entry.childCount !== childCount) return undefined;
    return {
      totals: cloneTotals(entry.totals),
      totalBytes: entry.totalBytes,
      totalFiles: entry.totalFiles,
      skippedCount: entry.skippedCount,
      // 缓存里只有"完整遍历完"的子树，复用时不携带取消状态，
      // 使冷缓存与热缓存的结果逐字段相等（Property 7）
      cancelled: false,
      partial: entry.skippedCount > 0,
    };
  }

  set(dir: string, mtimeMs: number, childCount: number, agg: ScanResult): void {
    // 被取消打断的聚合是残缺值，写进去会在下次统计里当成完整结果复用
    if (agg.cancelled) return;
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(childCount)) return;
    this.entries.set(normalizeDirKey(dir), {
      mtimeMs,
      childCount,
      totals: cloneTotals(agg.totals),
      totalBytes: safeCount(agg.totalBytes),
      totalFiles: safeCount(agg.totalFiles),
      skippedCount: safeCount(agg.skippedCount),
    });
  }

  /** 失效单个目录条目；不触及其父目录与子目录（逐级失效由调用方按链推进）。 */
  invalidate(dir: string): void {
    this.entries.delete(normalizeDirKey(dir));
  }

  clear(): void {
    this.entries.clear();
  }
}

const realFsDeps: ScannerFsDeps = {
  readdir: (p, o) => readdir(p, o) as unknown as Promise<DirentLike[]>,
  lstat: (p) => lstat(p) as unknown as Promise<StatLike>,
};

const defaultYieldNow = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function normalizeMaxDepth(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_DEPTH;
  return Math.max(0, Math.floor(v));
}

function normalizeYieldEvery(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_YIELD_EVERY;
  return Math.max(1, Math.floor(v));
}

/** 只接受有限正数字节数，其余（NaN / 负数 / undefined）按 0 计，避免污染合计。 */
function safeBytes(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/** 一棵子树（或一个目录内已处理部分）的聚合数字。 */
interface Subtree {
  totals: CategoryTotals;
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
}

function emptySubtree(): Subtree {
  return {
    totals: emptyCategoryTotals(),
    totalBytes: 0,
    totalFiles: 0,
    skippedCount: 0,
  };
}

/** 把 `src` 的聚合并入 `dst`（父目录聚合 = 各子项聚合之和，Property 23）。 */
function mergeSubtree(dst: Subtree, src: Subtree | ScanResult): void {
  for (const c of ALL_CATEGORIES) {
    dst.totals[c].bytes += src.totals[c].bytes;
    dst.totals[c].files += src.totals[c].files;
  }
  dst.totalBytes += src.totalBytes;
  dst.totalFiles += src.totalFiles;
  dst.skippedCount += src.skippedCount;
}

/**
 * 把一个条目（文件或符号链接）计入其分类。
 *
 * 取 `classify` 而不是 `ClassifyRoots`：分类规则是本模块唯一随布局变化的部分，
 * 由 `scanTree` 一次性解析成函数后传进来（见 `ScanOptions.classify`）。
 */
function addEntry(
  sub: Subtree,
  classify: (fullPath: string) => StorageCategory,
  fullPath: string,
  size: number,
): void {
  const bytes = safeBytes(size);
  const agg = sub.totals[classify(fullPath)];
  agg.bytes += bytes;
  agg.files += 1;
  sub.totalBytes += bytes;
  sub.totalFiles += 1;
}

/** 一次 `walk` 的产物：子树聚合 + 该子树是否**未被取消打断**（决定能否入缓存）。 */
interface WalkOutcome {
  sub: Subtree;
  complete: boolean;
}

/**
 * 遍历 `root` 及其子树，返回按分类聚合的字节数与文件数。
 *
 * 目录自身不计入 `totalBytes` / `totalFiles`（只有文件与符号链接条目计入），
 * 因此「父目录聚合 = 各子项聚合之和」构造性成立（Property 23）。
 */
export async function scanTree(root: string, opts: ScanOptions): Promise<ScanResult> {
  const deps = opts.fsDeps ?? realFsDeps;
  const yieldNow = deps.yieldNow ?? defaultYieldNow;
  const maxDepth = normalizeMaxDepth(opts.maxDepth);
  const yieldEvery = normalizeYieldEvery(opts.yieldEvery);
  const isCancelled = opts.isCancelled ?? ((): boolean => false);
  const cache = opts.cache;
  // 注入的分类器优先；缺省分类器仍在每次调用时读 opts.roots，
  // 使不传 classify 时的行为与本字段引入之前逐字节相同。
  const classify =
    opts.classify ?? ((fullPath: string): StorageCategory => classifyPath(opts.roots, fullPath));

  let cancelled = false;
  let processed = 0;

  /** 记一个已处理条目；到达让出间隔就让出事件循环，并在让出后复查取消。 */
  const tick = async (): Promise<void> => {
    processed += 1;
    if (processed % yieldEvery !== 0) return;
    await yieldNow();
    if (isCancelled()) cancelled = true;
  };

  /**
   * 尝试进入子目录并把其聚合并入 `into`：超深则计入跳过而不递归。
   * 返回该子目录是否完整遍历完（超深跳过也算"已定"，不影响父目录入缓存）。
   */
  const descend = async (full: string, depth: number, into: Subtree): Promise<boolean> => {
    if (depth + 1 > maxDepth) {
      into.skippedCount += 1;
      return true;
    }
    const outcome = await walk(full, depth + 1);
    mergeSubtree(into, outcome.sub);
    return outcome.complete;
  };

  const walk = async (dir: string, depth: number): Promise<WalkOutcome> => {
    const sub = emptySubtree();

    // 目录入口处检查取消（Req 6.7）
    if (cancelled) return { sub, complete: false };
    if (isCancelled()) {
      cancelled = true;
      return { sub, complete: false };
    }

    let entries: DirentLike[];
    try {
      entries = await deps.readdir(dir, { withFileTypes: true });
    } catch {
      // 不可读目录：跳过整棵子树并计数，不向上抛异常（Req 9.1）
      sub.skippedCount += 1;
      return { sub, complete: true };
    }

    // 先 readdir 拿到直接子条目数，再连同目录自身的 mtimeMs 查缓存（Req 7.6）。
    // 取不到 mtimeMs（目录刚被删 / 无权限 stat）时只是放弃缓存，不算跳过条目——
    // 枚举已经成功，条目该照常统计。
    let dirMtimeMs: number | undefined;
    if (cache) {
      try {
        const st = await deps.lstat(dir);
        if (Number.isFinite(st.mtimeMs)) dirMtimeMs = st.mtimeMs;
      } catch {
        dirMtimeMs = undefined;
      }
      if (dirMtimeMs !== undefined) {
        const hit = cache.get(dir, dirMtimeMs, entries.length);
        if (hit) {
          // 命中即整棵子树复用聚合结果，不再递归、不再 lstat 任何子项
          mergeSubtree(sub, hit);
          return { sub, complete: true };
        }
      }
    }

    let complete = true;

    /** 收尾：完整遍历完的子树写入缓存，供下次统计复用（取消时也照写，Req 6.7）。 */
    const finish = (): WalkOutcome => {
      if (cache && complete && dirMtimeMs !== undefined) {
        cache.set(dir, dirMtimeMs, entries.length, {
          totals: sub.totals,
          totalBytes: sub.totalBytes,
          totalFiles: sub.totalFiles,
          skippedCount: sub.skippedCount,
          cancelled: false,
          partial: sub.skippedCount > 0,
        });
      }
      return { sub, complete };
    };

    for (const entry of entries) {
      if (cancelled) {
        complete = false;
        return finish();
      }
      const full = path.join(dir, entry.name);
      await tick();
      if (cancelled) {
        complete = false;
        return finish();
      }

      // 符号链接一律不跟随：既不递归其目标目录，也不 stat 目标，
      // 只按链接自身条目的字节数计入所在分类（Req 8.5）
      if (entry.isSymbolicLink()) {
        let st: StatLike;
        try {
          st = await deps.lstat(full);
        } catch {
          sub.skippedCount += 1;
          continue;
        }
        addEntry(sub, classify, full, st.size);
        continue;
      }

      if (entry.isDirectory()) {
        if (!(await descend(full, depth, sub))) complete = false;
        continue;
      }

      let st: StatLike;
      try {
        st = await deps.lstat(full);
      } catch {
        sub.skippedCount += 1;
        continue;
      }

      // dirent 与 lstat 不一致（枚举与 stat 之间被替换）时以 lstat 为准：
      // 目录不计入字节数，链接不跟随。
      if (st.isSymbolicLink()) {
        addEntry(sub, classify, full, st.size);
        continue;
      }
      if (st.isDirectory()) {
        if (!(await descend(full, depth, sub))) complete = false;
        continue;
      }
      addEntry(sub, classify, full, st.size);
    }

    return finish();
  };

  const { sub } = await walk(root, 0);

  return {
    totals: sub.totals,
    totalBytes: sub.totalBytes,
    totalFiles: sub.totalFiles,
    skippedCount: sub.skippedCount,
    cancelled,
    partial: sub.skippedCount > 0,
  };
}
