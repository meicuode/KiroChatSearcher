import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  StorageAnalyzer,
  STORAGE_CACHE_TTL_MS,
  type AnalyzerFsDeps,
} from '../src/storage/analyzer';
import { buildClassifyRoots } from '../src/storage/classify';
import { encodeWorkspaceKeys, type PathResolverDeps } from '../src/paths';
import { workspaceIdCandidates } from '../src/credits';
import { mkTempDir, rmTempDir } from './_helpers';

/**
 * 示例测试（任务 9.10）：以确定的注入夹具钉住 StorageAnalyzer 的四条边界行为，
 * 与 `storage.analyzer.property.spec.ts` 的属性覆盖互补——那边覆盖归因公式与守恒的
 * 全输入空间，这边覆盖具体的降级 / 缓存 / 失效路径。
 *
 * 夹具约定（复用 property 测试的 `pathResolverFor`）：linux + XDG_CONFIG_HOME 指向
 * runDir，使 `getKiroUserDataDir` 返回 `<runDir>/Kiro`；存档索引一律注入，既避免读
 * 真实磁盘又保证确定性。所有磁盘访问改走注入的 `AnalyzerFsDeps`，因此「不可读目录」
 * 与「UserDataDir 为 null」都靠注入模拟，不需要真的改权限。
 */

/* ------------------------------------------------------------------ *
 * 注入夹具
 * ------------------------------------------------------------------ */

/** 注入的 PathResolver：使 UserDataDir = `<runDir>/Kiro`（existsSync 恒真）。 */
function pathResolverFor(runDir: string): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: runDir },
    homedir: () => runDir,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

/** 注入的 PathResolver：existsSync 恒假，使 `getKiroUserDataDir` 返回 null。 */
function nullPathResolver(): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: '/kcs-nonexistent-xdg' },
    homedir: () => '/kcs-nonexistent-home',
    existsSync: () => false,
    statSync: () => ({ isDirectory: () => false }),
  };
}

interface WrapOptions {
  /** 命中该目录的 readdir 抛 EACCES，模拟不可读目录（其余目录照常委托真实 fs） */
  unreadableDir?: string;
  /** 每次 readdir 的回调，用于统计目录枚举次数 */
  onReaddir?: (p: string) => void;
}

/** 基于真实 `fs.promises` 的只读注入 fs，可把指定目录标记为不可读。 */
function realReadFsDeps(opts: WrapOptions = {}): AnalyzerFsDeps {
  const blocked = opts.unreadableDir ? path.normalize(opts.unreadableDir) : null;
  return {
    readdir: async (p, o) => {
      opts.onReaddir?.(p);
      if (blocked !== null && path.normalize(p) === blocked) {
        const e = new Error(`EACCES: permission denied, scandir '${p}'`) as Error & {
          code: string;
        };
        e.code = 'EACCES';
        throw e;
      }
      return fs.promises.readdir(p, o) as unknown as ReturnType<AnalyzerFsDeps['readdir']>;
    },
    lstat: (p) => fs.promises.lstat(p) as unknown as ReturnType<AnalyzerFsDeps['lstat']>,
    stat: (p) => fs.promises.stat(p) as unknown as ReturnType<AnalyzerFsDeps['stat']>,
    readFile: (p, enc) => fs.promises.readFile(p, enc),
  };
}

/** 建出一个结构完整的 UserDataDir（含 SessionsRoot），返回常用根路径。 */
function makeUserData(runDir: string): {
  userDataDir: string;
  roots: ReturnType<typeof buildClassifyRoots>;
} {
  const userDataDir = path.join(runDir, 'Kiro');
  const roots = buildClassifyRoots(userDataDir);
  fs.mkdirSync(roots.sessionsRoot, { recursive: true });
  return { userDataDir, roots };
}

/* ------------------------------------------------------------------ *
 * 1. UserDataDir 不可用（Req 1.2）
 * ------------------------------------------------------------------ */

describe('9.10 StorageAnalyzer — UserDataDir 不可用', () => {
  it('UserDataDir 解析为 null 时 getSummary 返回 unavailable 且不抛异常', async () => {
    const analyzer = new StorageAnalyzer({
      pathResolver: nullPathResolver(),
      workspacePath: '/home/kcs/ws',
      listArchives: () => [],
    });

    const summary = await analyzer.getSummary();

    expect(summary.status).toBe('unavailable');
    expect(summary.userDataDir).toBeNull();
    expect(summary.totalBytes).toBe(0);
    expect(summary.totalFiles).toBe(0);
    // 不给零填充的分类明细，避免 tooltip 展示出「各分类均为 0」这种伪结论
    expect(summary.categories).toEqual([]);
    expect(summary.partial).toBe(false);
    expect(summary.currentWorkspaceBytes).toBe(0);
    expect(summary.sessionCount).toBe(0);
    // 孤儿态取 pending（待判定）而非 ok（已判定为 0）
    expect(summary.orphan.state).toBe('pending');
  });

  it('UserDataDir 为 null 时 getReportData / getRankingRows 同样不抛异常', async () => {
    const analyzer = new StorageAnalyzer({
      pathResolver: nullPathResolver(),
      workspacePath: '/home/kcs/ws',
      listArchives: () => [],
    });

    const report = await analyzer.getReportData({ force: true });
    expect(report.summary.status).toBe('unavailable');
    expect(report.workspaces).toEqual([]);
    expect(report.sessions).toEqual([]);

    const rows = await analyzer.getRankingRows({ force: true });
    expect(rows.rows).toEqual([]);
    expect(rows.partial).toBe(false);
    expect(rows.skippedCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 60 秒缓存命中与 force 强制重算（Req 4.6、7.5、7.10）
 * ------------------------------------------------------------------ */

describe('9.10 StorageAnalyzer — StorageCache 60 秒有效期与 force', () => {
  let base: string | null = null;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('60 秒内命中缓存不重新枚举目录；到期或 force 时重算；force 不向存档索引传递绕过节流的标记', async () => {
    base = mkTempDir('kcs-analyzer-cache-');
    const runDir = path.join(base, 'r0');
    const { roots } = makeUserData(runDir);

    const workspacePath = '/home/kcs/cache-ws';
    const sessionDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(workspacePath)[0]);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'a.json'), Buffer.alloc(1024, 0x61));

    // 可控时钟：驱动 StorageCache 的 60 秒判定
    let t = 1_000_000;
    // 记录每次 listArchives 的实参，既数调用次数又断言 force 未传绕过节流的标记
    const archiveCalls: Array<{ storeRoot: string; opts: unknown }> = [];
    let readdirCount = 0;

    const analyzer = new StorageAnalyzer({
      pathResolver: pathResolverFor(runDir),
      workspacePath,
      now: () => t,
      fsDeps: realReadFsDeps({ onReaddir: () => (readdirCount += 1) }),
      listArchives: (storeRoot, opts) => {
        archiveCalls.push({ storeRoot, opts });
        return [];
      },
    });

    // 首次统计：真正枚举目录
    const first = await analyzer.getSummary();
    expect(first.status).toBe('ok');
    expect(archiveCalls.length).toBe(1);
    const readdirAfterFirst = readdirCount;
    expect(readdirAfterFirst).toBeGreaterThan(0);
    const firstTotal = first.totalBytes;

    // TTL 内命中缓存：既不再取存档索引，也不再枚举任何目录
    t += 30_000;
    const cached = await analyzer.getSummary();
    expect(archiveCalls.length).toBe(1);
    expect(readdirCount).toBe(readdirAfterFirst);
    expect(cached.totalBytes).toBe(firstTotal);

    // 临界点前（59_999ms < 60_000ms）仍命中
    t += STORAGE_CACHE_TTL_MS - 30_000 - 1;
    await analyzer.getSummary();
    expect(archiveCalls.length).toBe(1);
    expect(readdirCount).toBe(readdirAfterFirst);

    // 达到 60_000ms 有效期：重新枚举
    t += 1;
    await analyzer.getSummary();
    expect(archiveCalls.length).toBe(2);
    expect(readdirCount).toBeGreaterThan(readdirAfterFirst);

    // force 恒重算，即便仍在 TTL 内
    const readdirBeforeForce = readdirCount;
    await analyzer.getSummary({ force: true });
    expect(archiveCalls.length).toBe(3);
    expect(readdirCount).toBeGreaterThan(readdirBeforeForce);

    // 连续两次 force 也各自重算一次（不会因刚算过而被跳过）
    await analyzer.getSummary({ force: true });
    expect(archiveCalls.length).toBe(4);

    // force 只绕过 StorageCache：每次取存档索引都只传 { workspacePath }，
    // 不含任何会绕过 ArchiveIndex 4 秒节流的标记（节流仍归 credits.ts 所有，Req 7.10）
    for (const call of archiveCalls) {
      expect(call.opts).toEqual({ workspacePath });
      expect(Object.keys(call.opts as object)).not.toContain('force');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 不可读目录 → partial 且不抛异常（Req 7.5 无关，Req 9.2 / 11.7）
 * ------------------------------------------------------------------ */

describe('9.10 StorageAnalyzer — 不可读目录降级', () => {
  let base: string | null = null;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('夹具含不可读目录时统计返回 partial: true 且不抛异常', async () => {
    base = mkTempDir('kcs-analyzer-partial-');
    const runDir = path.join(base, 'r0');
    const { roots } = makeUserData(runDir);

    // 运行日志目录放点内容，再把它标记为不可读
    fs.mkdirSync(roots.logsDir, { recursive: true });
    fs.writeFileSync(path.join(roots.logsDir, 'app.log'), Buffer.alloc(2048, 0x61));

    // 另建一个可正常统计的会话目录，确保并非整棵树不可读
    const workspacePath = '/home/kcs/partial-ws';
    const sessionDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(workspacePath)[0]);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'a.json'), Buffer.alloc(512, 0x61));

    const analyzer = new StorageAnalyzer({
      pathResolver: pathResolverFor(runDir),
      workspacePath,
      fsDeps: realReadFsDeps({ unreadableDir: roots.logsDir }),
      listArchives: () => [],
    });

    const summary = await analyzer.getSummary({ force: true });

    // 不可读目录被跳过而非抛出：statuss 仍为 ok，partial 置真，skippedCount > 0
    expect(summary.status).toBe('ok');
    expect(summary.partial).toBe(true);
    expect(summary.skippedCount).toBeGreaterThan(0);
    // 可读部分照常计入
    expect(summary.currentWorkspaceBytes).toBe(512);
  });
});

/* ------------------------------------------------------------------ *
 * 4. invalidateForDeletedFiles 失效完整祖先链（Req 14.13）
 * ------------------------------------------------------------------ */

describe('9.10 StorageAnalyzer — invalidateForDeletedFiles 祖先链失效', () => {
  let base: string | null = null;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('对被删文件逐级失效其所在目录直至 StoreRoot 之上的 UserDataDir，使后续强制统计读到最新字节', async () => {
    base = mkTempDir('kcs-analyzer-invalidate-');
    const runDir = path.join(base, 'r0');
    const { roots } = makeUserData(runDir);

    // 在 <StoreRoot>/<WorkspaceId>/<bucket>/sub/ 下埋一个深层文件（深度在 maxDepth 内）
    const workspacePath = '/home/kcs/invalidate-ws';
    const workspaceId = workspaceIdCandidates(workspacePath)[0];
    const deepDir = path.join(roots.storeRoot, workspaceId, 'bucket-x', 'sub');
    fs.mkdirSync(deepDir, { recursive: true });
    const deepFile = path.join(deepDir, 'deep.bin');
    fs.writeFileSync(deepFile, Buffer.alloc(1000, 0x61));

    const analyzer = new StorageAnalyzer({
      pathResolver: pathResolverFor(runDir),
      workspacePath,
      listArchives: () => [],
    });

    // 首次统计填充各级 SubtreeCache
    const first = await analyzer.getSummary({ force: true });
    expect(first.status).toBe('ok');
    const baseTotal = first.totalBytes;
    expect(baseTotal).toBeGreaterThanOrEqual(1000);

    // 就地追加字节：既不改父目录 mtime、也不改直接子条目数，SubtreeCache 的
    // (mtimeMs, childCount) 失效判据抓不到这种孙辈内容增长
    const appended = 4096;
    fs.appendFileSync(deepFile, Buffer.alloc(appended, 0x61));

    // force 只清 StorageCache、不动 SubtreeCache：祖先各级仍命中陈旧聚合，读不到增长
    const stale = await analyzer.getSummary({ force: true });
    expect(stale.totalBytes).toBe(baseTotal);

    // 显式失效被删/被改文件的整条祖先链后，强制统计应读到新字节
    analyzer.invalidateForDeletedFiles([deepFile]);
    const fresh = await analyzer.getSummary({ force: true });
    expect(fresh.totalBytes).toBe(baseTotal + appended);
  });

  it('invalidateForDeletedFiles 同时丢弃 StorageCache，使非 force 统计也重算', async () => {
    base = mkTempDir('kcs-analyzer-invalidate-cache-');
    const runDir = path.join(base, 'r0');
    const { roots } = makeUserData(runDir);

    const workspacePath = '/home/kcs/invalidate-ws2';
    const sessionDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(workspacePath)[0]);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'a.json'), Buffer.alloc(256, 0x61));

    let archiveCalls = 0;
    const analyzer = new StorageAnalyzer({
      pathResolver: pathResolverFor(runDir),
      workspacePath,
      listArchives: () => {
        archiveCalls += 1;
        return [];
      },
    });

    await analyzer.getSummary();
    expect(archiveCalls).toBe(1);
    // 命中 StorageCache：不重算
    await analyzer.getSummary();
    expect(archiveCalls).toBe(1);

    // 失效后即便不带 force，也应重新统计
    analyzer.invalidateForDeletedFiles([path.join(sessionDir, 'a.json')]);
    await analyzer.getSummary();
    expect(archiveCalls).toBe(2);
  });
});
