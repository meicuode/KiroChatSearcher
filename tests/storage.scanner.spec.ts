import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildClassifyRoots } from '../src/storage/classify';
import {
  SubtreeCache,
  emptyCategoryTotals,
  scanTree,
  type ScanResult,
  type ScannerFsDeps,
  type SubtreeCacheLike,
} from '../src/storage/scanner';
import {
  mkTempDir,
  mkTree,
  recordingReadFs,
  rmTempDir,
  type CallRecord,
  type TreeSpec,
} from './_helpers';

/**
 * `src/storage/scanner.ts` 的示例测试（Req 7.6、6.7、14.13）。
 *
 * 与 `storage.scanner.property.spec.ts` 的分工：预算（Property 16）、链接不跟随
 * （Property 18）、异常降级（Property 19）与聚合可加性（Property 23）已在随机输入
 * 空间上被锁定，本文件只钉**具体场景**：
 *
 * 1. 冷 / 热缓存：同一未变化夹具连续两次扫描逐字段相等，且第二次几乎不再枚举
 * 2. 失效判据 `(mtimeMs, 直接子条目数)`：改 mtime / 增删直接子项分别失效，未变化时命中
 * 3. `invalidate(dir)` 只打掉指定键，其余键仍被复用
 * 4. 取消：`cancelled: true`、停止继续枚举，已完成子树留在缓存中而被打断的目录不入缓存
 */

/** 两条平行子树，各带一层嵌套目录：可分辨"哪半边被重新递归了" */
const TREE: TreeSpec = {
  'root.json': 10,
  a: { 'a1.json': 20, deep: { 'x.bin': 30 } },
  b: { 'b1.json': 40, deep: { 'y.bin': 50 } },
};

/** TREE 的目录数（不含根）：a、a/deep、b、b/deep */
const TREE_DIRS = 4;

/** 取本次扫描实际枚举过的目录路径（按调用顺序，含重复） */
function readdirPaths(calls: readonly CallRecord[]): string[] {
  return calls.filter((c) => c.op === 'readdir').map((c) => String(c.args[0]));
}

function countOp(calls: readonly CallRecord[], op: string): number {
  return calls.filter((c) => c.op === op).length;
}

/** 目录当前的失效判据实参：`(mtimeMs, 直接子条目数)`，用于在测试侧直接查缓存 */
function criterion(dir: string): { mtimeMs: number; childCount: number } {
  return { mtimeMs: fs.lstatSync(dir).mtimeMs, childCount: fs.readdirSync(dir).length };
}

/** 带缓存扫一次，并返回本次的调用记录 */
async function scanWith(
  root: string,
  cache: SubtreeCacheLike,
  extra: { isCancelled?: () => boolean; yieldEvery?: number } = {}
): Promise<{ res: ScanResult; calls: CallRecord[] }> {
  const { deps, calls } = recordingReadFs();
  const res = await scanTree(root, {
    roots: buildClassifyRoots(root),
    cache,
    fsDeps: deps as ScannerFsDeps,
    ...extra,
  });
  return { res, calls };
}

describe('SubtreeCache：失效判据与 invalidate（Req 7.6、14.13）', () => {
  let base: string | null = null;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('未变化时命中：两次扫描结果逐字段相等，第二次不再递归子树', async () => {
    base = mkTempDir('kcs-scanner-cache-');
    const root = base;
    mkTree(root, TREE);
    const cache = new SubtreeCache();

    const cold = await scanWith(root, cache);
    // 冷扫描枚举根 + 每个子目录，并对每个目录额外 lstat 一次取 mtime
    expect(readdirPaths(cold.calls)).toHaveLength(TREE_DIRS + 1);
    expect(cache.size).toBe(TREE_DIRS + 1);
    expect(cold.res.totalFiles).toBe(5);
    expect(cold.res.totalBytes).toBe(10 + 20 + 30 + 40 + 50);
    expect(cold.res.cancelled).toBe(false);
    expect(cold.res.partial).toBe(false);

    const hot = await scanWith(root, cache);

    // 热扫描仍要枚举根目录并 lstat 根目录才能查缓存，命中后整棵子树不再展开
    expect(readdirPaths(hot.calls)).toEqual([root]);
    expect(countOp(hot.calls, 'lstat')).toBe(1);
    expect(countOp(cold.calls, 'lstat')).toBe(TREE_DIRS + 1 + 5);
    // 结果逐字段相等：复用缓存不改变任何数值，也不把 cancelled / partial 弄脏
    expect(hot.res).toEqual(cold.res);
  });

  it('改 mtime 后失效：仅该目录重新递归，未变化的子树仍被复用', async () => {
    base = mkTempDir('kcs-scanner-cache-mtime-');
    const root = base;
    mkTree(root, TREE);
    const cache = new SubtreeCache();

    const cold = await scanWith(root, cache);

    // 只改根目录的 mtime：直接子条目数不变，仅凭 mtime 一项就必须失效
    const past = 1_600_000_000;
    fs.utimesSync(root, past, past);

    const again = await scanWith(root, cache);

    const paths = readdirPaths(again.calls);
    // 根失效 ⇒ 重新枚举根与两个直接子目录；a / b 命中缓存 ⇒ 其内层 deep 不再被枚举
    expect(paths.sort()).toEqual([root, path.join(root, 'a'), path.join(root, 'b')].sort());
    expect(paths).not.toContain(path.join(root, 'a', 'deep'));
    // 数值不因失效重算而变化
    expect(again.res).toEqual(cold.res);
  });

  it('增加一个直接子项后失效：新文件被计入', async () => {
    base = mkTempDir('kcs-scanner-cache-add-');
    const root = base;
    mkTree(root, TREE);
    const cache = new SubtreeCache();

    const cold = await scanWith(root, cache);
    mkTree(root, { 'added.bin': 7 });

    const again = await scanWith(root, cache);

    expect(readdirPaths(again.calls)).toContain(root);
    expect(readdirPaths(again.calls).length).toBeGreaterThan(1);
    expect(again.res.totalFiles).toBe(cold.res.totalFiles + 1);
    expect(again.res.totalBytes).toBe(cold.res.totalBytes + 7);
  });

  it('删除一个直接子项后失效：该文件不再被计入', async () => {
    base = mkTempDir('kcs-scanner-cache-del-');
    const root = base;
    mkTree(root, TREE);
    const cache = new SubtreeCache();

    const cold = await scanWith(root, cache);
    fs.rmSync(path.join(root, 'root.json'));

    const again = await scanWith(root, cache);

    expect(readdirPaths(again.calls).length).toBeGreaterThan(1);
    expect(again.res.totalFiles).toBe(cold.res.totalFiles - 1);
    expect(again.res.totalBytes).toBe(cold.res.totalBytes - 10);
  });

  it('失效判据是 (mtimeMs, 直接子条目数) 双相等：任一项不同即不命中', () => {
    const dir = path.resolve(path.sep + 'store' + path.sep + 'ws');
    const cache = new SubtreeCache();
    const agg: ScanResult = {
      totals: emptyCategoryTotals(),
      totalBytes: 100,
      totalFiles: 2,
      skippedCount: 0,
      cancelled: false,
      partial: false,
    };
    agg.totals.executionSaves = { bytes: 100, files: 2 };

    cache.set(dir, 1_000, 3, agg);

    // 两项都相等才命中
    expect(cache.get(dir, 1_000, 3)?.totalBytes).toBe(100);
    // 改 mtime（子条目数不变）
    expect(cache.get(dir, 1_001, 3)).toBeUndefined();
    // 增加一个直接子项（mtime 恰好同刻）
    expect(cache.get(dir, 1_000, 4)).toBeUndefined();
    // 删除一个直接子项
    expect(cache.get(dir, 1_000, 2)).toBeUndefined();
    // 不命中不等于被逐出：条目仍在，原判据下继续命中
    expect(cache.size).toBe(1);
    expect(cache.get(dir, 1_000, 3)).toBeDefined();

    // 键按目录路径归一化：尾分隔符形态命中同一条目
    expect(cache.get(dir + path.sep, 1_000, 3)).toBeDefined();

    // get 返回深拷贝：调用方继续累加不会回写缓存
    const hit = cache.get(dir, 1_000, 3)!;
    hit.totals.executionSaves.bytes += 999;
    hit.totalBytes += 999;
    expect(cache.get(dir, 1_000, 3)?.totals.executionSaves.bytes).toBe(100);
    expect(cache.get(dir, 1_000, 3)?.totalBytes).toBe(100);

    // 被取消打断的残缺聚合不入缓存
    cache.set(path.join(dir, 'partial'), 1_000, 1, { ...agg, cancelled: true });
    expect(cache.size).toBe(1);
  });

  it('invalidate(dir) 只失效指定键，不影响其它键', () => {
    const root = path.resolve(path.sep + 'store');
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    const cache = new SubtreeCache();
    const agg: ScanResult = {
      totals: emptyCategoryTotals(),
      totalBytes: 1,
      totalFiles: 1,
      skippedCount: 0,
      cancelled: false,
      partial: false,
    };

    for (const dir of [root, a, b]) cache.set(dir, 500, 2, agg);
    expect(cache.size).toBe(3);

    // 非归一化形态（带尾分隔符）也应打到同一条目
    cache.invalidate(a + path.sep);

    expect(cache.size).toBe(2);
    expect(cache.get(a, 500, 2)).toBeUndefined();
    // 父目录与兄弟目录的条目原样保留
    expect(cache.get(root, 500, 2)).toBeDefined();
    expect(cache.get(b, 500, 2)).toBeDefined();

    // 失效不存在的键是幂等的无操作
    cache.invalidate(path.join(root, 'missing'));
    expect(cache.size).toBe(2);
  });

  it('清理后逐级失效：只有被 invalidate 的那条链重新递归，兄弟子树整棵复用', async () => {
    base = mkTempDir('kcs-scanner-cache-inv-');
    const root = base;
    mkTree(root, TREE);
    const cache = new SubtreeCache();

    const cold = await scanWith(root, cache);
    expect(cache.size).toBe(TREE_DIRS + 1);

    // 模拟 Req 14.13：自被删文件所在目录（a）向上逐级失效直至扫描根
    cache.invalidate(path.join(root, 'a'));
    cache.invalidate(root);
    expect(cache.size).toBe(TREE_DIRS + 1 - 2);
    // a/deep 与 b 分支的条目未被波及
    expect(cache.get(path.join(root, 'a', 'deep'), ...critArgs(path.join(root, 'a', 'deep')))).toBeDefined();
    expect(cache.get(path.join(root, 'b'), ...critArgs(path.join(root, 'b')))).toBeDefined();

    const again = await scanWith(root, cache);

    const paths = readdirPaths(again.calls);
    // a 失效 ⇒ 需重新枚举 a 并进入其子项（a/deep 在缓存命中前也要先 readdir 拿子条目数）；
    // b 在根的循环里直接命中缓存 ⇒ b/deep 一次都不被枚举
    expect(paths.sort()).toEqual(
      [root, path.join(root, 'a'), path.join(root, 'a', 'deep'), path.join(root, 'b')].sort()
    );
    expect(paths).not.toContain(path.join(root, 'b', 'deep'));
    expect(again.res).toEqual(cold.res);
  });
});

/** `criterion` 的位置参数形态，便于直接展开给 `cache.get` */
function critArgs(dir: string): [number, number] {
  const c = criterion(dir);
  return [c.mtimeMs, c.childCount];
}

/** 四条平行子树 + 一个根文件：取消发生在第一棵子树完成之后，与枚举顺序无关 */
const CANCEL_TREE: TreeSpec = {
  'z.json': 10,
  d1: { deep: { 'f.bin': 11 } },
  d2: { deep: { 'f.bin': 12 } },
  d3: { deep: { 'f.bin': 13 } },
  d4: { deep: { 'f.bin': 14 } },
};

/** CANCEL_TREE 的目录数（不含根）：d1..d4 + 各自的 deep */
const CANCEL_TREE_DIRS = 8;

describe('取消：停止继续枚举且保留已完成子树（Req 6.7）', () => {
  let base: string | null = null;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('取消后停止继续枚举，已完成子树留在缓存中，被打断的目录不入缓存', async () => {
    base = mkTempDir('kcs-scanner-cancel-');
    const root = base;
    mkTree(root, CANCEL_TREE);

    // 参照口径：不带缓存、不取消的完整扫描
    const full = await scanTree(root, { roots: buildClassifyRoots(root) });
    expect(full.cancelled).toBe(false);
    expect(full.totalFiles).toBe(5);

    const inner = new SubtreeCache();
    const setDirs: string[] = [];
    let cancel = false;
    /**
     * 在"第一棵直接子树写入缓存"的瞬间请求取消：触发时机由被测代码自己的
     * `cache.set` 决定，因此与目录枚举顺序无关，也不依赖具体条目计数。
     */
    const cache: SubtreeCacheLike = {
      get: (dir, mtimeMs, childCount) => inner.get(dir, mtimeMs, childCount),
      set: (dir, mtimeMs, childCount, agg) => {
        setDirs.push(dir);
        inner.set(dir, mtimeMs, childCount, agg);
        if (!cancel && path.dirname(dir) === root) cancel = true;
      },
      invalidate: (dir) => inner.invalidate(dir),
      clear: () => inner.clear(),
    };

    // yieldEvery = 1 使取消在下一个条目就被观察到
    const cancelled = await scanWith(root, cache, { isCancelled: () => cancel, yieldEvery: 1 });

    expect(cancel).toBe(true);
    expect(cancelled.res.cancelled).toBe(true);

    const doneDir = setDirs.find((d) => path.dirname(d) === root);
    expect(doneDir).toBeDefined();

    // 停止继续枚举：只枚举了根 + 那一棵已完成子树（根 / d_i / d_i/deep），远少于完整扫描的 9 次
    const paths = readdirPaths(cancelled.calls);
    expect(paths.sort()).toEqual([root, doneDir!, path.join(doneDir!, 'deep')].sort());
    expect(paths.length).toBeLessThan(CANCEL_TREE_DIRS + 1);
    // 部分统计：已完成部分的数字为下限
    expect(cancelled.res.totalFiles).toBeLessThan(full.totalFiles);
    expect(cancelled.res.totalBytes).toBeLessThan(full.totalBytes);

    // 已完成的子树留在缓存中；被取消打断的根目录未入缓存
    expect(setDirs).not.toContain(root);
    expect(inner.get(root, ...critArgs(root))).toBeUndefined();
    expect(inner.get(doneDir!, ...critArgs(doneDir!))).toBeDefined();
    expect(inner.get(path.join(doneDir!, 'deep'), ...critArgs(path.join(doneDir!, 'deep')))).toBeDefined();

    // 下次统计复用已完成子树：该子树不再被展开，且结果与完整扫描逐字段相等
    const resumed = await scanWith(root, inner);
    const resumedPaths = readdirPaths(resumed.calls);
    expect(resumedPaths).not.toContain(path.join(doneDir!, 'deep'));
    expect(resumedPaths.length).toBeLessThan(CANCEL_TREE_DIRS + 1);
    expect(resumed.res).toEqual(full);
  });
});
