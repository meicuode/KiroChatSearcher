import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import { hash32 } from '../src/credits';
import {
  buildClassifyRoots,
  classifyPath,
  CATEGORY_ORDER,
  SAVES_BUCKET_KEY,
  METADATA_BUCKET_KEY,
  type ClassifyRoots,
} from '../src/storage/classify';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_YIELD_EVERY,
  SubtreeCache,
  emptyCategoryTotals,
  scanTree,
  type ScanResult,
  type ScannerFsDeps,
  type SubtreeCacheLike,
} from '../src/storage/scanner';
import {
  canSymlink,
  mkTempDir,
  mkTree,
  recordingReadFs,
  rmTempDir,
  type TreeSpec,
} from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享生成器与工具
 * 供本文件内 Property 23 及后续追加的属性测试（16 / 18 / 19）共用
 * ------------------------------------------------------------------ */

/** 桶目录名按 Requirement 1.5 的公式在测试内独立计算 */
const SAVES = hash32(SAVES_BUCKET_KEY);
const META = hash32(METADATA_BUCKET_KEY);

/**
 * 目录名池：混入 StoreRoot / SessionsRoot / logs / workspaceStorage 的路径段与
 * 两个桶名，使随机树能真正落到多个分类上（可加性必须逐分类成立，而不只是总量成立）。
 *
 * 刻意不混入仅大小写不同的同名目录：不区分大小写的文件系统上它们会被合并成一个条目。
 */
const DIR_NAMES = [
  'User',
  'globalStorage',
  'kiro.kiroagent',
  'workspace-sessions',
  'workspaceStorage',
  'logs',
  'd1',
  'd2',
  SAVES,
  META,
  'a'.repeat(32),
] as const;

const FILE_NAMES = ['f1.json', 'f2.bin', 'sessions.json', 'g'] as const;

const fileEntryArb = fc.tuple(fc.constantFrom(...FILE_NAMES), fc.integer({ min: 0, max: 64 }));

/**
 * 随机目录树描述：每层最多 3 个文件与 3 个子目录，嵌套深度不超过 `depth`。
 * 同层同名键在 TreeSpec 里自然合并，故无需额外去重。
 */
function treeSpecArb(depth: number): fc.Arbitrary<TreeSpec> {
  const filesArb = fc.array(fileEntryArb, { maxLength: 3 });
  if (depth <= 0) {
    return filesArb.map((files) => Object.fromEntries(files) as TreeSpec);
  }
  return fc
    .tuple(
      filesArb,
      fc.array(fc.tuple(fc.constantFrom(...DIR_NAMES), treeSpecArb(depth - 1)), { maxLength: 3 })
    )
    .map(([files, dirs]) => {
      const spec: TreeSpec = Object.fromEntries(files) as TreeSpec;
      for (const [name, child] of dirs) spec[name] = child;
      return spec;
    });
}

/** 一棵子树的聚合数字（与 ScanResult 的数值字段同形） */
interface Agg {
  totals: ReturnType<typeof emptyCategoryTotals>;
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
}

function emptyAgg(): Agg {
  return {
    totals: emptyCategoryTotals(),
    totalBytes: 0,
    totalFiles: 0,
    skippedCount: 0,
  };
}

/** 把 `src` 并入 `dst`（测试侧独立实现的求和，不复用 scanner 的 mergeSubtree） */
function addInto(dst: Agg, src: Agg | ScanResult): void {
  for (const c of CATEGORY_ORDER) {
    dst.totals[c].bytes += src.totals[c].bytes;
    dst.totals[c].files += src.totals[c].files;
  }
  dst.totalBytes += src.totalBytes;
  dst.totalFiles += src.totalFiles;
  dst.skippedCount += src.skippedCount;
}

/* ------------------------------------------------------------------ *
 * Property 23
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 23: 目录聚合可加性
// Validates: Requirements 11.4
describe('Property 23: 目录聚合可加性', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  /**
   * 递归验证 `dir` 的聚合等于其直接子条目聚合之和，并对每个子目录继续验证，
   * 因此断言覆盖夹具中的**每一个**目录，而不只是根。
   *
   * `budget` 是该次扫描的 `maxDepth`：子目录用 `budget - 1` 扫描，剩余深度预算
   * 与它在父扫描中所处的位置一致，故深度上限即使真的生效，两侧也按同样方式
   * 把超深子树计入 `skippedCount`。每次扫描都不传 cache（同一实例跨不同 root
   * 会让同一目录落在不同深度上，见 `ScanOptions.cache` 的不变式说明）。
   */
  async function checkAdditive(
    roots: ClassifyRoots,
    dir: string,
    budget: number
  ): Promise<ScanResult> {
    const res = await scanTree(dir, { roots, maxDepth: budget });

    const expected = emptyAgg();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (budget - 1 < 0) {
          // 超出深度预算：父扫描把整棵子树记作一个跳过条目而不递归
          expected.skippedCount += 1;
          continue;
        }
        addInto(expected, await checkAdditive(roots, full, budget - 1));
        continue;
      }
      // 目录自身不计入字节数与文件数，只有文件条目计入所在分类
      const st = fs.lstatSync(full);
      const agg = expected.totals[classifyPath(roots, full)];
      agg.bytes += st.size;
      agg.files += 1;
      expected.totalBytes += st.size;
      expected.totalFiles += 1;
    }

    // 逐分类可加：任一目录的每个分类字节数 / 文件数都等于其直接子条目之和
    expect(res.totals).toEqual(expected.totals);
    // 总量可加
    expect(res.totalBytes).toBe(expected.totalBytes);
    expect(res.totalFiles).toBe(expected.totalFiles);
    expect(res.skippedCount).toBe(expected.skippedCount);
    expect(res.cancelled).toBe(false);
    expect(res.partial).toBe(res.skippedCount > 0);

    return res;
  }

  it('Property 23: 任一目录的统计字节数与文件数恒等于其直接子条目之和', async () => {
    base = mkTempDir('kcs-scanner-prop-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        // 深度预算取到 0 与 1 这类边界：可加性在深度上限生效时同样必须成立
        fc.integer({ min: 0, max: 5 }),
        async (spec, maxDepth) => {
          const root = path.join(fixtureBase, `r${runSeq++}`);
          mkTree(root, spec);
          const roots = buildClassifyRoots(root);
          await checkAdditive(roots, root, maxDepth);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 16 的内存文件系统与独立预算算术
 *
 * 让出频率与深度预算都是「遍历了多少条目」的函数，与介质无关，因此这部分用
 * 注入的内存 fs 跑：既能把条目数推到默认 512 阈值以上、把链推到默认 8 层以上，
 * 又不必真的在磁盘上造出上千个文件（Property 23 已在真实 fs 上覆盖聚合语义）。
 * ------------------------------------------------------------------ */

/** 只含「字节数 / 嵌套目录」的目录树（treeSpecArb 生成的形态恰是此子集） */
type MemSpec = { [name: string]: number | MemSpec };

const MEM_ROOT = path.resolve(path.sep + 'kcs-mem-root');
const MEM_MTIME = 1_700_000_000_000;
/** 注入 fs 里符号链接条目自身的字节数（真实 fs 上是目标路径串长度，此处取常量） */
const MEM_LINK_SIZE = 12;

function toMemSpec(spec: TreeSpec): MemSpec {
  const out: MemSpec = {};
  for (const [name, node] of Object.entries(spec)) {
    if (typeof node === 'number') {
      out[name] = node;
      continue;
    }
    if (typeof node === 'object' && node !== null && !('kind' in node)) {
      out[name] = toMemSpec(node as TreeSpec);
      continue;
    }
    throw new Error(`treeSpecArb 生成了非预期节点：${name}`);
  }
  return out;
}

interface MemFs {
  deps: ScannerFsDeps;
  /** yieldNow / readdir / lstat 各自的调用次数 */
  counts: { yields: number; readdir: number; lstat: number };
}

/**
 * 失败注入（Property 19）：按**相对路径**（'/' 分隔，`''` 表示 root）指定哪些
 * 路径上的 `readdir` / `lstat` 抛异常。抛出的 `code` 可指定——扫描器对错误码
 * 一律 `catch`，随机化 code 正是为了断言这一点。
 */
interface MemFails {
  readdir?: ReadonlySet<string>;
  lstat?: ReadonlySet<string>;
  code?: string;
}

/**
 * 由 MemSpec 造一份 ScannerFsDeps。`scale` 把每个文件的字节数放大若干倍，
 * 用于「缓存体积与被统计字节数无关」那一条：目录结构与条目数完全不变，
 * 只有 `size` 数值变大。
 *
 * `links` 为「链接自身的相对路径 → 目标相对路径（`''` 表示 root）」，供 Property 18
 * 造循环链接：`spec` 里为链接名放一个占位文件（字节数任意，链接自身按
 * `MEM_LINK_SIZE` 计），`links` 把该条目改成符号链接。链接条目刻意**同时**自称
 * 目录（`isDirectory()` 与 `isSymbolicLink()` 皆为真，比真实 dirent 更敌意），
 * 且其"内容"解析到目标处的节点——实现一旦跟随链接就会沿目标继续枚举下去。
 *
 * `fails` 注入枚举 / stat 失败（Property 19）：命中的路径上对应调用直接抛错，
 * 其余路径照常返回，因此失败位置可以由属性随机取遍整棵树。
 */
function memFs(
  spec: MemSpec,
  scale = 1,
  links: Record<string, string> = {},
  fails: MemFails = {}
): MemFs {
  const counts = { yields: 0, readdir: 0, lstat: 0 };

  const toSegs = (p: string): string[] =>
    path
      .relative(MEM_ROOT, p)
      .split(/[\\/]+/)
      .filter((s) => s.length > 0);

  /**
   * 逐段下钻，遇到链接段就跳到其目标的规范路径继续。返回命中的节点与其规范
   * 相对路径（用于判断更深一层的条目是否也是链接）。`links` 为空时等价于直接下钻。
   */
  const resolve = (
    segs: string[],
    hops = 0
  ): { node: number | MemSpec | undefined; canonical: string } => {
    let canonical = '';
    let cur: number | MemSpec | undefined = spec;
    for (const seg of segs) {
      if (typeof cur !== 'object') return { node: undefined, canonical };
      const childRel = canonical ? `${canonical}/${seg}` : seg;
      const target = links[childRel];
      if (target !== undefined) {
        // 链接：其"内容"即目标处的节点（若被跟随，循环链接会在此处不断绕回）
        if (hops > 64) return { node: undefined, canonical: childRel };
        const r = resolve(
          target.split(/[\\/]+/).filter((s) => s.length > 0),
          hops + 1
        );
        cur = r.node;
        canonical = r.canonical;
        continue;
      }
      const child: number | MemSpec | undefined = cur[seg];
      if (child === undefined) return { node: undefined, canonical: childRel };
      cur = child;
      canonical = childRel;
    }
    return { node: cur, canonical };
  };

  /** p 自身是否为链接（解析其父目录的规范路径后查表） */
  const linkAt = (p: string): string | undefined => {
    const segs = toSegs(p);
    if (segs.length === 0) return undefined;
    const parent = resolve(segs.slice(0, -1));
    const name = segs[segs.length - 1];
    return links[parent.canonical ? `${parent.canonical}/${name}` : name];
  };

  const enoent = (p: string): Error => {
    const e = new Error(`ENOENT: ${p}`);
    (e as Error & { code: string }).code = 'ENOENT';
    return e;
  };

  /** 注入失败用的相对路径键（与 `fails` 的键同形；root 为 `''`） */
  const relKey = (p: string): string => toSegs(p).join('/');

  const injected = (op: 'readdir' | 'lstat', p: string): Error | undefined => {
    if (!fails[op]?.has(relKey(p))) return undefined;
    const e = new Error(`${fails.code ?? 'EACCES'}: ${op} ${p}`);
    (e as Error & { code: string }).code = fails.code ?? 'EACCES';
    return e;
  };

  const deps: ScannerFsDeps = {
    readdir: async (p) => {
      counts.readdir += 1;
      const fail = injected('readdir', p);
      if (fail) throw fail;
      const { node, canonical } = resolve(toSegs(p));
      if (typeof node !== 'object') throw enoent(p);
      return Object.entries(node).map(([name, child]) => {
        const isLink = links[canonical ? `${canonical}/${name}` : name] !== undefined;
        return {
          name,
          isDirectory: () => isLink || typeof child === 'object',
          isSymbolicLink: () => isLink,
          isFile: () => !isLink && typeof child === 'number',
        };
      });
    },
    lstat: async (p) => {
      counts.lstat += 1;
      const fail = injected('lstat', p);
      if (fail) throw fail;
      if (linkAt(p) !== undefined) {
        return {
          size: MEM_LINK_SIZE,
          mtimeMs: MEM_MTIME,
          isDirectory: () => true,
          isSymbolicLink: () => true,
        };
      }
      const { node } = resolve(toSegs(p));
      if (node === undefined) throw enoent(p);
      const isDir = typeof node === 'object';
      return {
        size: isDir ? 0 : node * scale,
        mtimeMs: MEM_MTIME,
        isDirectory: () => isDir,
        isSymbolicLink: () => false,
      };
    },
    yieldNow: async () => {
      counts.yields += 1;
    },
  };

  return { deps, counts };
}

/**
 * 独立算出扫描器会「处理」的条目数：各被枚举目录的直接条目数之和。
 * 超出深度预算的子目录其自身条目照样计入（父目录枚举时已处理过它），
 * 只是不再进入其内部。
 */
function countEntries(spec: MemSpec, depth: number, maxDepth: number): number {
  let n = Object.keys(spec).length;
  for (const child of Object.values(spec)) {
    if (typeof child === 'number') continue;
    if (depth + 1 > maxDepth) continue;
    n += countEntries(child, depth + 1, maxDepth);
  }
  return n;
}

/** 独立算出「因深度预算被跳过的子目录数」 */
function countDepthSkips(spec: MemSpec, depth: number, maxDepth: number): number {
  let skips = 0;
  for (const child of Object.values(spec)) {
    if (typeof child === 'number') continue;
    if (depth + 1 > maxDepth) {
      skips += 1;
      continue;
    }
    skips += countDepthSkips(child, depth + 1, maxDepth);
  }
  return skips;
}

/** 独立算出预算内可见的字节数与文件数 */
function sumWithin(
  spec: MemSpec,
  depth: number,
  maxDepth: number,
  scale: number
): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const child of Object.values(spec)) {
    if (typeof child === 'number') {
      bytes += child * scale;
      files += 1;
      continue;
    }
    if (depth + 1 > maxDepth) continue;
    const s = sumWithin(child, depth + 1, maxDepth, scale);
    bytes += s.bytes;
    files += s.files;
  }
  return { bytes, files };
}

/** 目录嵌套深度（root 的直接子目录记为 1） */
function specDepth(spec: MemSpec): number {
  let max = 0;
  for (const child of Object.values(spec)) {
    if (typeof child === 'number') continue;
    max = Math.max(max, 1 + specDepth(child));
  }
  return max;
}

/** 目录数（不含 root） */
function countDirs(spec: MemSpec): number {
  let n = 0;
  for (const child of Object.values(spec)) {
    if (typeof child === 'number') continue;
    n += 1 + countDirs(child);
  }
  return n;
}

/** 深度为 depth 的目录链，链底挂一棵浅子树，便于把树推过默认 8 层预算 */
function chainSpec(depth: number, leaf: MemSpec): MemSpec {
  if (depth <= 0) return { 'f1.json': 10, ...leaf };
  return { 'f1.json': 10, d1: chainSpec(depth - 1, leaf) };
}

/* ------------------------------------------------------------------ *
 * Property 16
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 16: 扫描预算
// Validates: Requirements 7.3, 7.8, 7.11
describe('Property 16: 扫描预算', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 16: 处理 n 个条目时让出次数恒不少于 floor(n / yieldEvery)（真实 fs，注入小间隔）', async () => {
    base = mkTempDir('kcs-scanner-budget-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        // 注入较小的让出间隔，使小夹具上也能观察到多次让出
        fc.integer({ min: 1, max: 6 }),
        async (spec, yieldEvery) => {
          const root = path.join(fixtureBase, `y${runSeq++}`);
          mkTree(root, spec);
          // recordingReadFs 保留真实 readdir / lstat，只额外记录调用
          const { deps, calls } = recordingReadFs();
          const res = await scanTree(root, {
            roots: buildClassifyRoots(root),
            yieldEvery,
            fsDeps: deps as ScannerFsDeps,
          });

          const n = countEntries(toMemSpec(spec), 0, DEFAULT_MAX_DEPTH);
          const yields = calls.filter((c) => c.op === 'yieldNow').length;

          expect(yields).toBeGreaterThanOrEqual(Math.floor(n / yieldEvery));
          // 实现是确定的：恰好每 yieldEvery 个条目让出一次
          expect(yields).toBe(Math.floor(n / yieldEvery));
          expect(res.cancelled).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 16: 缺省让出间隔恒为 512，让出次数恒为 floor(n / 512)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 1600 }), async (n) => {
        const spec: MemSpec = {};
        for (let i = 0; i < n; i++) spec[`f${i}.json`] = 1;
        const mem = memFs(spec);

        const res = await scanTree(MEM_ROOT, {
          roots: buildClassifyRoots(MEM_ROOT),
          fsDeps: mem.deps,
        });

        expect(DEFAULT_YIELD_EVERY).toBe(512);
        expect(mem.counts.yields).toBeGreaterThanOrEqual(Math.floor(n / DEFAULT_YIELD_EVERY));
        expect(mem.counts.yields).toBe(Math.floor(n / DEFAULT_YIELD_EVERY));
        expect(res.totalFiles).toBe(n);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 16: 超出深度预算的子树恒计入 skippedCount 且 partial 为真，未超出时恒不因深度跳过', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 链深最多 12，可跨过缺省的 8 层预算
        fc.integer({ min: 0, max: 12 }),
        treeSpecArb(1),
        // undefined 覆盖缺省 maxDepth = 8 的语义
        fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
        async (depth, leaf, maxDepth) => {
          const spec = chainSpec(depth, toMemSpec(leaf));
          const mem = memFs(spec);

          const res = await scanTree(MEM_ROOT, {
            roots: buildClassifyRoots(MEM_ROOT),
            maxDepth,
            fsDeps: mem.deps,
          });

          const effective = maxDepth ?? DEFAULT_MAX_DEPTH;
          expect(DEFAULT_MAX_DEPTH).toBe(8);

          const expectedSkips = countDepthSkips(spec, 0, effective);
          expect(res.skippedCount).toBe(expectedSkips);
          expect(res.partial).toBe(expectedSkips > 0);

          if (specDepth(spec) > effective) {
            // 存在超深子树：恒被计入跳过并使结果标记为部分统计
            expect(res.skippedCount).toBeGreaterThan(0);
            expect(res.partial).toBe(true);
          } else {
            // 深度未超预算：恒不因深度产生跳过
            expect(res.skippedCount).toBe(0);
            expect(res.partial).toBe(false);
          }

          // 超深子树内的字节数与文件数一并被排除在合计之外
          const within = sumWithin(spec, 0, effective, 1);
          expect(res.totalBytes).toBe(within.bytes);
          expect(res.totalFiles).toBe(within.files);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 16: SubtreeCache 条目恒只含数字与固定分类字段，缓存体积恒与文件字节数无关', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        // 同一棵树，文件字节数放大若干倍
        fc.constantFrom(1_000, 1_000_000, 1_000_000_000),
        async (treeSpec, scale) => {
          const spec = toMemSpec(treeSpec);

          const small = await scanWithCache(spec, 1);
          const large = await scanWithCache(spec, scale);

          // 每个缓存条目：键 ⊆ 固定字段集，分类表恰为 7 个分类，叶子恒为数字/布尔
          for (const entry of Object.values(large.recorded)) {
            expect(Object.keys(entry).sort()).toEqual([...ENTRY_KEYS].sort());
            expect(Object.keys(entry.totals).sort()).toEqual([...CATEGORY_ORDER].sort());
            assertScalarLeaves(entry, 'entry');
          }

          // 条目数只随目录数变化，与文件字节数无关
          const expectedDirs = countDirs(spec) + 1;
          expect(small.size).toBe(expectedDirs);
          expect(large.size).toBe(expectedDirs);

          // 去掉数值大小后的序列化形状逐字节相同 ⇒ 缓存结构不随被统计字节数增长
          const smallShape = JSON.stringify(shapeOf(small.recorded));
          const largeShape = JSON.stringify(shapeOf(large.recorded));
          expect(largeShape).toBe(smallShape);
          expect(largeShape.length).toBe(smallShape.length);

          // 放大确实生效了（否则上面的"无关"是空断言）
          if (small.totalBytes > 0) {
            expect(large.totalBytes).toBe(small.totalBytes * scale);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/** 缓存条目允许出现的字段（scanTree 交给 cache.set 的聚合形状） */
const ENTRY_KEYS = [
  'mtimeMs',
  'childCount',
  'totals',
  'totalBytes',
  'totalFiles',
  'skippedCount',
  'cancelled',
  'partial',
] as const;

interface RecordedEntry {
  totals: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * 用真实 SubtreeCache 扫一遍，同时旁录每次 `set` 的入参：
 * 旁录的是**扫描器交给缓存的东西**，因此「缓存里没有文件内容、没有文件列表」
 * 是对被测代码的断言，而不是对测试替身的断言。
 */
async function scanWithCache(
  spec: MemSpec,
  scale: number
): Promise<{ recorded: Record<string, RecordedEntry>; size: number; totalBytes: number }> {
  const inner = new SubtreeCache();
  const recorded: Record<string, RecordedEntry> = {};
  const cache: SubtreeCacheLike = {
    get: (dir, mtimeMs, childCount) => inner.get(dir, mtimeMs, childCount),
    set: (dir, mtimeMs, childCount, agg) => {
      recorded[path.relative(MEM_ROOT, dir) || '.'] = {
        mtimeMs,
        childCount,
        ...agg,
      } as RecordedEntry;
      inner.set(dir, mtimeMs, childCount, agg);
    },
    invalidate: (dir) => inner.invalidate(dir),
    clear: () => inner.clear(),
  };

  const mem = memFs(spec, scale);
  const res = await scanTree(MEM_ROOT, {
    roots: buildClassifyRoots(MEM_ROOT),
    cache,
    fsDeps: mem.deps,
  });
  return { recorded, size: inner.size, totalBytes: res.totalBytes };
}

/** 断言递归结构里除对象外只有数字与布尔——没有字符串（路径 / 内容）也没有数组（文件列表） */
function assertScalarLeaves(v: unknown, at: string): void {
  if (typeof v === 'number' || typeof v === 'boolean') return;
  expect(Array.isArray(v), `${at} 不应是数组（文件列表）`).toBe(false);
  expect(typeof v, `${at} 只允许数字 / 布尔 / 对象`).toBe('object');
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    assertScalarLeaves(child, `${at}.${k}`);
  }
}

/** 把所有数值归零后的结构形状：只保留键与嵌套形态，抹掉数值本身的十进制位数 */
function shapeOf(v: unknown): unknown {
  if (typeof v === 'number') return 0;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(shapeOf);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = shapeOf((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/* ------------------------------------------------------------------ *
 * Property 18 的夹具工具
 * ------------------------------------------------------------------ */

/** 收集 TreeSpec 中所有目录的相对路径（不含 root 自身，root 以 `''` 表示） */
function dirPathsOf(spec: TreeSpec, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, node] of Object.entries(spec)) {
    if (typeof node !== 'object' || node === null || 'kind' in node) continue;
    const rel = prefix ? path.join(prefix, name) : name;
    out.push(rel);
    out.push(...dirPathsOf(node as TreeSpec, rel));
  }
  return out;
}

/** 收集 MemSpec 中所有目录的相对路径（'/' 分隔，不含 root 自身） */
function memDirPaths(spec: MemSpec, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, child] of Object.entries(spec)) {
    if (typeof child === 'number') continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    out.push(rel);
    out.push(...memDirPaths(child, rel));
  }
  return out;
}

/** 按相对路径取出 MemSpec 里的目录节点（`''` 为 root） */
function memDirAt(spec: MemSpec, rel: string): MemSpec {
  let cur = spec;
  for (const seg of rel.split('/').filter((s) => s.length > 0)) {
    const next = cur[seg];
    if (typeof next !== 'object') throw new Error(`不是目录：${rel}`);
    cur = next;
  }
  return cur;
}

/**
 * 尝试建符号链接；无权限时返回 false 由调用方跳过该次运行。
 * Windows 上目录链接走 junction（无需管理员），文件链接在无权限时抛 EPERM。
 */
function tryLink(parentDir: string, name: string, target: string, type: 'file' | 'dir'): boolean {
  try {
    mkTree(parentDir, { [name]: { kind: 'link', target, type } });
    return true;
  } catch {
    return false;
  }
}

const LINK_NAME = 'lnk';

/* ------------------------------------------------------------------ *
 * Property 18
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 18: 符号链接不被跟随
// Validates: Requirements 8.5
describe('Property 18: 符号链接不被跟随', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 18: 链接目标体积增大后统计结果恒逐字段不变', async () => {
    base = mkTempDir('kcs-scanner-link-');
    const fixtureBase = base;
    // 文件链接需要权限，目录链接（junction）通常总可用，故只按需跳过文件链接那一半
    const fileLinkOk = canSymlink(fixtureBase);

    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(2),
        // 链接指向目录还是文件：Requirement 8.5 两种都要覆盖
        fc.boolean(),
        fc.nat(),
        fc.integer({ min: 1, max: 64 }),
        // 目标体积的放大倍数
        fc.constantFrom(100, 1_000, 10_000),
        async (spec, toDir, parentPick, bytes, factor) => {
          if (!toDir && !fileLinkOk) return; // 无符号链接权限时跳过文件链接

          const n = runSeq++;
          const root = path.join(fixtureBase, `r${n}`);
          // 目标刻意放在被扫描根之外：目标自身的字节数不该以任何方式进入统计
          const outside = path.join(fixtureBase, `t${n}`);
          mkTree(root, spec);
          mkTree(outside, toDir ? { payload: { 'big.bin': bytes } } : { 'big.bin': bytes });

          const dirs = dirPathsOf(spec);
          const parentRel = dirs.length > 0 ? dirs[parentPick % dirs.length] : '';
          const parentDir = parentRel ? path.join(root, parentRel) : root;
          const target = toDir ? path.join(outside, 'payload') : path.join(outside, 'big.bin');
          if (!tryLink(parentDir, LINK_NAME, target, toDir ? 'dir' : 'file')) return;

          const linkFull = path.join(parentDir, LINK_NAME);
          const linkSize = fs.lstatSync(linkFull).size;

          const roots = buildClassifyRoots(root);
          const before = await scanTree(root, { roots });

          // 只改链接目标的体积：链接自身的路径与 lstat().size 均不变
          const payload = toDir ? path.join(outside, 'payload', 'big.bin') : target;
          const grown = bytes * factor;
          fs.writeFileSync(payload, Buffer.alloc(grown, 0x62));
          if (toDir) {
            // 目标目录同时多出一个子项：其 mtime 与子条目数也一并变化
            fs.writeFileSync(path.join(outside, 'payload', 'extra.bin'), Buffer.alloc(grown, 0x63));
          }

          // 放大确实生效（否则下面的"不变"是空断言）
          expect(fs.statSync(payload).size).toBe(grown);
          expect(grown).toBeGreaterThan(bytes);
          // 链接条目自身的字节数未变
          expect(fs.lstatSync(linkFull).size).toBe(linkSize);

          const after = await scanTree(root, { roots });

          // 总量与逐分类数字恒不随目标体积增加而变化
          expect(after).toEqual(before);
          expect(after.totalBytes).toBe(before.totalBytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 18: 链接自身恒按其所在路径的分类计入恰好一个条目', async () => {
    base = mkTempDir('kcs-scanner-link-cat-');
    const fixtureBase = base;
    const fileLinkOk = canSymlink(fixtureBase);

    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(2),
        fc.boolean(),
        fc.nat(),
        async (spec, toDir, parentPick) => {
          if (!toDir && !fileLinkOk) return;

          const n = runSeq++;
          const root = path.join(fixtureBase, `c${n}`);
          const outside = path.join(fixtureBase, `ct${n}`);
          mkTree(root, spec);
          // 目标体积刻意远大于任何链接条目自身的字节数
          mkTree(outside, toDir ? { payload: { 'big.bin': 100_000 } } : { 'big.bin': 100_000 });

          const roots = buildClassifyRoots(root);
          const before = await scanTree(root, { roots });

          const dirs = dirPathsOf(spec);
          const parentRel = dirs.length > 0 ? dirs[parentPick % dirs.length] : '';
          const parentDir = parentRel ? path.join(root, parentRel) : root;
          const target = toDir ? path.join(outside, 'payload') : path.join(outside, 'big.bin');
          if (!tryLink(parentDir, LINK_NAME, target, toDir ? 'dir' : 'file')) return;

          const linkFull = path.join(parentDir, LINK_NAME);
          const linkStat = fs.lstatSync(linkFull);
          expect(linkStat.isSymbolicLink()).toBe(true);

          const after = await scanTree(root, { roots });
          const linkCategory = classifyPath(roots, linkFull);

          // 恰好多出一个条目，落在链接所在路径的分类上，字节数恰为链接自身的 size
          expect(after.totalFiles).toBe(before.totalFiles + 1);
          expect(after.totalBytes).toBe(before.totalBytes + linkStat.size);
          for (const c of CATEGORY_ORDER) {
            const expectedFiles = before.totals[c].files + (c === linkCategory ? 1 : 0);
            const expectedBytes = before.totals[c].bytes + (c === linkCategory ? linkStat.size : 0);
            expect(after.totals[c].files).toBe(expectedFiles);
            expect(after.totals[c].bytes).toBe(expectedBytes);
          }
          // 不跟随不等于跳过：链接不产生跳过计数
          expect(after.skippedCount).toBe(before.skippedCount);
          expect(after.cancelled).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 18: 循环链接（目录链接指回祖先）夹具下统计恒终止且恒不枚举链接内部', async () => {
    base = mkTempDir('kcs-scanner-link-cycle-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(treeSpecArb(2), fc.nat(), async (spec, parentPick) => {
        const n = runSeq++;
        const root = path.join(fixtureBase, `y${n}`);
        mkTree(root, spec);

        const dirs = dirPathsOf(spec);
        const parentRel = dirs.length > 0 ? dirs[parentPick % dirs.length] : '';
        const parentDir = parentRel ? path.join(root, parentRel) : root;
        // 指回被扫描根：链接目标是链接自身的祖先，跟随即成环
        if (!tryLink(parentDir, LINK_NAME, root, 'dir')) return;

        const linkFull = path.join(parentDir, LINK_NAME);
        const { deps, calls } = recordingReadFs();
        const res = await scanTree(root, {
          roots: buildClassifyRoots(root),
          fsDeps: deps as ScannerFsDeps,
        });

        // 每个目录恰被枚举一次、链接内部一次都没有 ⇒ 遍历必然终止
        const inside = calls.filter((c) =>
          String(c.args[0]).startsWith(linkFull + path.sep)
        );
        expect(inside).toEqual([]);
        expect(calls.filter((c) => c.op === 'readdir').length).toBe(dirs.length + 1);
        expect(res.cancelled).toBe(false);
        expect(res.totalFiles).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 18: 链接项自称目录且指回祖先时恒不递归其目标（注入 fs，与介质无关）', async () => {
    await fc.assert(
      fc.asyncProperty(treeSpecArb(3), fc.nat(), fc.nat(), async (treeSpec, parentPick, targetPick) => {
        const spec = toMemSpec(treeSpec);
        const dirs = memDirPaths(spec);
        const parentRel = dirs.length > 0 ? dirs[parentPick % dirs.length] : '';
        // 链接名在 spec 里先放一个 0 字节占位项，links 再把它变成符号链接
        memDirAt(spec, parentRel)[LINK_NAME] = 0;

        // 目标取链接自身的某个祖先（含 root），跟随即成环
        const ancestors = [''];
        let acc = '';
        for (const seg of parentRel.split('/').filter((s) => s.length > 0)) {
          acc = acc ? `${acc}/${seg}` : seg;
          ancestors.push(acc);
        }
        const linkRel = parentRel ? `${parentRel}/${LINK_NAME}` : LINK_NAME;
        const links = { [linkRel]: ancestors[targetPick % ancestors.length] };

        const mem = memFs(spec, 1, links);
        const { deps, calls } = recordingReadFs({
          readdir: mem.deps.readdir,
          lstat: mem.deps.lstat,
          yieldNow: mem.deps.yieldNow,
        });
        const res = await scanTree(MEM_ROOT, {
          roots: buildClassifyRoots(MEM_ROOT),
          fsDeps: deps as ScannerFsDeps,
        });

        const linkFull = path.join(MEM_ROOT, ...linkRel.split('/'));
        // 链接内部一次都没有被枚举或 stat：终止性与目标是什么无关
        expect(calls.filter((c) => String(c.args[0]).startsWith(linkFull + path.sep))).toEqual([]);
        // 目录数是有限的且每个只枚举一次 ⇒ 不存在因环导致的重复下钻
        expect(calls.filter((c) => c.op === 'readdir').length).toBe(countDirs(spec) + 1);

        // 链接按自身条目计入恰好一个条目（占位项在 sumWithin 里正是 1 个 0 字节文件）
        const within = sumWithin(spec, 0, DEFAULT_MAX_DEPTH, 1);
        expect(res.totalFiles).toBe(within.files);
        expect(res.totalBytes).toBe(within.bytes + MEM_LINK_SIZE);
        expect(res.skippedCount).toBe(0);
        expect(res.cancelled).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 19 的失败位置工具与独立算术
 *
 * 失败注入走内存 fs：真实 fs 上很难在 Windows / CI 上稳定造出「这个目录不可读、
 * 那个文件不可 stat」的组合，而降级口径本身与介质无关。期望值在测试侧**独立**
 * 按下面三条口径重算，不复用 scanner 的任何累加逻辑：
 *
 * - `readdir` 失败 ⇒ 整棵子树跳过、只记 1 次（其内部条目既不计字节数也不再产生跳过）
 * - 单条目 `lstat` 失败 ⇒ 该条目跳过、记 1 次
 * - 深度超限 ⇒ 该子目录记 1 次（与异常跳过共用同一计数器）
 * ------------------------------------------------------------------ */

/** 收集 MemSpec 中所有文件的相对路径（'/' 分隔） */
function memFilePaths(spec: MemSpec, prefix = ''): string[] {
  const out: string[] = [];
  for (const [name, child] of Object.entries(spec)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (typeof child === 'number') {
      out.push(rel);
      continue;
    }
    out.push(...memFilePaths(child, rel));
  }
  return out;
}

/** 失败注入下的期望聚合：异常跳过与深度跳过分开记，便于分别断言 */
interface FailExpect {
  totals: ReturnType<typeof emptyCategoryTotals>;
  totalBytes: number;
  totalFiles: number;
  /** 因枚举 / stat 抛异常被跳过的条目数 */
  failSkips: number;
  /** 因深度预算被跳过的子目录数 */
  depthSkips: number;
}

function emptyFailExpect(): FailExpect {
  return { totals: emptyCategoryTotals(), totalBytes: 0, totalFiles: 0, failSkips: 0, depthSkips: 0 };
}

/**
 * 独立重算：在给定失败位置集合下，扫描器应当得到的逐分类字节数 / 文件数与两类跳过计数。
 *
 * 注意目录条目**不**经 `lstat`（dirent 已自称目录，实现直接下钻），因此目录路径上的
 * `lstat` 失败不影响此处的算术——那条口径由「传 cache 时目录 lstat 失败不计跳过」单独覆盖。
 */
function expectFailScan(
  spec: MemSpec,
  rel: string,
  depth: number,
  maxDepth: number,
  roots: ClassifyRoots,
  fails: { readdir: ReadonlySet<string>; lstat: ReadonlySet<string> },
  out: FailExpect
): void {
  if (fails.readdir.has(rel)) {
    // 目录不可枚举：整棵子树被放弃，只记一个跳过条目
    out.failSkips += 1;
    return;
  }
  for (const [name, child] of Object.entries(spec)) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (typeof child === 'object') {
      if (depth + 1 > maxDepth) {
        out.depthSkips += 1;
        continue;
      }
      expectFailScan(child, childRel, depth + 1, maxDepth, roots, fails, out);
      continue;
    }
    if (fails.lstat.has(childRel)) {
      out.failSkips += 1;
      continue;
    }
    const full = path.join(MEM_ROOT, ...childRel.split('/'));
    const agg = out.totals[classifyPath(roots, full)];
    agg.bytes += child;
    agg.files += 1;
    out.totalBytes += child;
    out.totalFiles += 1;
  }
}

/** 由挑选序号取出一组互不相同的路径（picks 为空即不注入失败） */
function pickPaths(candidates: readonly string[], picks: readonly number[]): Set<string> {
  if (candidates.length === 0) return new Set();
  return new Set(picks.map((i) => candidates[i % candidates.length]));
}

/** 失败错误码：扫描器一律 catch，随机化 code 用于断言"与错误种类无关" */
const FAIL_CODES = ['EACCES', 'EPERM', 'EIO', 'ENOENT', 'EMFILE'] as const;

/* ------------------------------------------------------------------ *
 * Property 19
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 19: 异常降级为跳过计数
// Validates: Requirements 9.1, 9.2
describe('Property 19: 异常降级为跳过计数', () => {
  it('Property 19: 随机失败位置下恒不抛异常，skippedCount 恒等于失败条目数，未失败条目字节数恒被完整计入', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        // 不可枚举的目录（含 root 自身）与不可 stat 的文件，各取任意个
        fc.array(fc.nat(), { maxLength: 3 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        fc.constantFrom(...FAIL_CODES),
        async (treeSpec, dirPicks, filePicks, code) => {
          const spec = toMemSpec(treeSpec);
          // root 以 '' 参与挑选：整棵树不可枚举也必须降级而不是抛异常
          const readdirFails = pickPaths(['', ...memDirPaths(spec)], dirPicks);
          const lstatFails = pickPaths(memFilePaths(spec), filePicks);

          const mem = memFs(spec, 1, {}, { readdir: readdirFails, lstat: lstatFails, code });
          const roots = buildClassifyRoots(MEM_ROOT);

          // 恒不 reject：先断言 resolves，再取值继续断言数值口径（同一次扫描）
          const promise = scanTree(MEM_ROOT, { roots, fsDeps: mem.deps });
          await expect(promise).resolves.toBeDefined();
          const res = await promise;

          const expected = emptyFailExpect();
          expectFailScan(spec, '', 0, DEFAULT_MAX_DEPTH, roots, {
            readdir: readdirFails,
            lstat: lstatFails,
          }, expected);

          // treeSpecArb(3) 的深度恒在缺省预算内 ⇒ 跳过计数只来自异常
          expect(expected.depthSkips).toBe(0);
          expect(res.skippedCount).toBe(expected.failSkips);
          // 跳过数恒不超过注入的失败位置数（子树内的失败位置不会被重复计入）
          expect(res.skippedCount).toBeLessThanOrEqual(readdirFails.size + lstatFails.size);
          // partial 与"存在跳过"恒等价
          expect(res.partial).toBe(res.skippedCount > 0);
          expect(res.partial).toBe(expected.failSkips > 0);

          // 未失败条目的字节数与文件数恒被完整计入，且逐分类成立
          expect(res.totals).toEqual(expected.totals);
          expect(res.totalBytes).toBe(expected.totalBytes);
          expect(res.totalFiles).toBe(expected.totalFiles);
          expect(res.cancelled).toBe(false);

          // 无注入失败时恒不产生跳过（否则上面的等式可能是"恒为 0"的空断言）
          if (readdirFails.size === 0 && lstatFails.size === 0) {
            expect(res.skippedCount).toBe(0);
            expect(res.partial).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 19: 失败位置与深度超限并存时 skippedCount 恒等于两类跳过之和', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        fc.array(fc.nat(), { maxLength: 3 }),
        fc.array(fc.nat(), { maxLength: 4 }),
        // 深度预算取到 0 这类边界，使深度跳过与异常跳过在同一次扫描里共存
        fc.integer({ min: 0, max: 3 }),
        async (treeSpec, dirPicks, filePicks, maxDepth) => {
          const spec = toMemSpec(treeSpec);
          const readdirFails = pickPaths(['', ...memDirPaths(spec)], dirPicks);
          const lstatFails = pickPaths(memFilePaths(spec), filePicks);

          const mem = memFs(spec, 1, {}, { readdir: readdirFails, lstat: lstatFails });
          const roots = buildClassifyRoots(MEM_ROOT);

          const promise = scanTree(MEM_ROOT, { roots, maxDepth, fsDeps: mem.deps });
          await expect(promise).resolves.toBeDefined();
          const res = await promise;

          const expected = emptyFailExpect();
          expectFailScan(spec, '', 0, maxDepth, roots, {
            readdir: readdirFails,
            lstat: lstatFails,
          }, expected);

          // 两类跳过共用同一计数器：合计恒相等
          expect(res.skippedCount).toBe(expected.failSkips + expected.depthSkips);
          expect(res.partial).toBe(res.skippedCount > 0);
          expect(res.totals).toEqual(expected.totals);
          expect(res.totalBytes).toBe(expected.totalBytes);
          expect(res.totalFiles).toBe(expected.totalFiles);
          expect(res.cancelled).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 19: 传 cache 时目录自身 lstat 失败恒不计入 skippedCount（枚举已成功）', async () => {
    await fc.assert(
      fc.asyncProperty(
        treeSpecArb(3),
        fc.array(fc.nat(), { maxLength: 4 }),
        fc.constantFrom(...FAIL_CODES),
        async (treeSpec, dirPicks, code) => {
          const spec = toMemSpec(treeSpec);
          const roots = buildClassifyRoots(MEM_ROOT);
          // 只让目录自身的 lstat 失败：readdir 与文件 lstat 全部正常
          const dirLstatFails = pickPaths(['', ...memDirPaths(spec)], dirPicks);

          const clean = memFs(spec);
          const baseline = await scanTree(MEM_ROOT, { roots, fsDeps: clean.deps });

          const mem = memFs(spec, 1, {}, { lstat: dirLstatFails, code });
          const promise = scanTree(MEM_ROOT, {
            roots,
            cache: new SubtreeCache(),
            fsDeps: mem.deps,
          });
          await expect(promise).resolves.toBeDefined();
          const res = await promise;

          // 放弃缓存不是跳过条目：计数恒为 0，结果与无失败的扫描逐字段相同
          expect(res.skippedCount).toBe(0);
          expect(res.partial).toBe(false);
          expect(res).toEqual(baseline);
        }
      ),
      { numRuns: 100 }
    );
  });
});
