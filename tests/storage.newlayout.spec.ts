import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildNewRankingRow,
  computeNewSessionFootprint,
  newSessionOrigin,
  newSessionSizes,
  StorageAnalyzer,
  type AnalyzerDeps,
  type AnalyzerFsDeps,
} from '../src/storage/analyzer';
import {
  buildClassifyRoots,
  buildNewClassifyRoots,
  classifyNewPath,
} from '../src/storage/classify';
import { emptyCategoryTotals, scanTree } from '../src/storage/scanner';
import { formatRankingTime } from '../src/storage/ranking';
import {
  mkNewSessionTree,
  mkTempDir,
  recordingReadFs,
  rmTempDir,
  snapshotTree,
} from './_helpers';

/**
 * 示例测试（任务 11.1）：1.x 新布局的 SessionFootprint 与排行取数。
 *
 * 覆盖 Requirement 6.3、6.4、6.6、6.8、6.9、6.10、6.15，与
 * `storage.newlayout.property.spec.ts`（Property 6，分类划分）互补——那边钉住
 * 「每个文件落到哪个分类」，这边钉住「一个会话目录被折成哪两列、合计是什么、
 * 时间取自哪里、重复统计是否稳定」。
 *
 * 夹具一律真实临时目录（`mkNewSessionTree`），字节数期望值取自 `fs.statSync`
 * 而不是硬编码：`session.json` / `messages.jsonl` 的长度由夹具内容决定，写死数字
 * 只会让夹具一改就红，测不到真正的行为。
 */

/** 实测基线：`d:\Projects\KiroExt\KiroChatSearcher` 的 WsHash16（见 research-notes 第 2 节）。 */
const WS_HASH = 'cc5023603866cd91';

/** 有效的 `lastModifiedAt`（1.x 实测形态）。 */
const LAST_MODIFIED_AT = '2026-09-01T05:07:55.425Z';

/* ------------------------------------------------------------------ *
 * 夹具与工具
 * ------------------------------------------------------------------ */

let base = '';
let homeKiroDir = '';
let sessionsRoot = '';
let workspaceSessionDir = '';

beforeEach(() => {
  base = mkTempDir('kcs-newlayout-rows-');
  homeKiroDir = path.join(base, '.kiro');
  sessionsRoot = path.join(homeKiroDir, 'sessions');
  workspaceSessionDir = path.join(sessionsRoot, WS_HASH);
  fs.mkdirSync(workspaceSessionDir, { recursive: true });
});

afterEach(() => {
  rmTempDir(base);
  base = '';
});

/**
 * 注入 LayoutRoots 子集的 analyzer：不经 PathResolver，故不读真实用户目录。
 * `listArchives` 恒为空——1.x 的占用与 0.9x 的 ArchiveIndex 无关，注入空集合可确保
 * 一旦实现误走旧布局归因，数值立刻对不上。
 */
function analyzerFor(extra: Partial<AnalyzerDeps> = {}): StorageAnalyzer {
  return new StorageAnalyzer({
    newLayout: { homeKiroDir, newWorkspaceSessionDir: workspaceSessionDir },
    workspacePath: 'd:\\Projects\\KiroExt\\KiroChatSearcher',
    listArchives: () => [],
    ...extra,
  });
}

/** 递归列出目录树下的**文件**绝对路径（与被测扫描器各自独立地枚举一遍）。 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function bytesOf(files: readonly string[]): number {
  return files.reduce((n, f) => n + fs.statSync(f).size, 0);
}

function sizeOf(p: string): number {
  return fs.statSync(p).size;
}

/** 本地时区的 `YYYY-MM-DD HH:mm`，由测试独立拼出（不复用被测的格式化实现）。 */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/* ------------------------------------------------------------------ *
 * 1. SessionFootprint：目录内全部文件之和、两个口径同值、可加（Req 6.3、6.4、6.6）
 * ------------------------------------------------------------------ */

describe('11.1 新布局 SessionFootprint（Req 6.3、6.4、6.6）', () => {
  it('会话占用等于该会话目录内全部文件字节数之和，含 publish*.cursor', async () => {
    const t = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_full',
      session: { title: 'Spec: 占用统计', lastModifiedAt: LAST_MODIFIED_AT },
      events: [{ payload: { type: 'user', content: 'hi' } }],
      snapshots: { 'h1/src/a.ts': 120, 'h1/src/deep/b.ts': 33 },
      subExecutions: { 'exec-1/c.bin': 44 },
      extra: { 'publish.cursor': 8, 'publish-sub.cursor': 5 },
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });

    expect(res.rows).toHaveLength(1);
    expect(res.sessionCount).toBe(1);
    expect(res.roots).toEqual([workspaceSessionDir]);

    const files = listFiles(t.sessionDir);
    const fp = res.footprints[0];
    // Req 6.3：占用 = 目录内全部文件字节数之和（含快照、子执行与 publish*.cursor）
    expect(fp.totalBytes).toBe(bytesOf(files));
    expect(res.totalBytes).toBe(fp.totalBytes);
    expect(res.files).toBe(files.length);
    // 「目录不存在」之外的一切都被读到了：无跳过条目、非下限值
    expect(res.skippedCount).toBe(0);
    expect(res.partial).toBe(false);

    // Req 6.4：`additive: true`，可跨会话求和（1.x 快照按会话目录物理隔离）
    expect(fp).toEqual({
      sessionId: 'sess_full',
      scope: 'self',
      additive: true,
      jsonBytes: sizeOf(t.sessionJson!) + sizeOf(t.messagesJsonl!) + 8 + 5,
      archiveBytes: 120 + 33 + 44,
      totalBytes: bytesOf(files),
      archivesFound: true,
    });
  });

  it('self 与 lineage 取同一值且均可加（Req 6.4：1.x 无 lineage 概念，不伪造归属）', () => {
    const sizes = { sessionBytes: 1200, attachmentBytes: 3400, attachmentFiles: 7 };
    const self = computeNewSessionFootprint({ ...sizes, sessionId: 'sess_a', scope: 'self' });
    const lineage = computeNewSessionFootprint({ ...sizes, sessionId: 'sess_a', scope: 'lineage' });

    expect(self.totalBytes).toBe(4600);
    expect(lineage.totalBytes).toBe(self.totalBytes);
    expect(lineage.jsonBytes).toBe(self.jsonBytes);
    expect(lineage.archiveBytes).toBe(self.archiveBytes);
    // 与 0.9x 的 `additive: scope === 'self'` 不同：1.x 两个口径都可加
    expect(self.additive).toBe(true);
    expect(lineage.additive).toBe(true);
    // scope 字段仍如实回传，调用方能分辨自己问的是哪个口径
    expect([self.scope, lineage.scope]).toEqual(['self', 'lineage']);
  });

  it('无快照与子执行时附件部分为 0 且 archivesFound 为 false；0 字节快照仍算「找到附件」', async () => {
    mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_bare',
      events: [{ payload: { type: 'user', content: 'x' } }],
    });
    mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_zero_snapshot',
      events: [{ payload: { type: 'user', content: 'x' } }],
      snapshots: { 'h1/empty.ts': 0 },
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const byId = new Map(res.footprints.map((fp) => [fp.sessionId, fp]));

    expect(byId.get('sess_bare')!.archiveBytes).toBe(0);
    expect(byId.get('sess_bare')!.archivesFound).toBe(false);
    // 0 字节的快照文件同样是「有附件」——与 0.9x 的 archivesFound 同口径
    expect(byId.get('sess_zero_snapshot')!.archiveBytes).toBe(0);
    expect(byId.get('sess_zero_snapshot')!.archivesFound).toBe(true);
  });

  it('newSessionSizes：两分之和恒等于总字节数，未预期的分类一并归入会话本体', () => {
    const totals = emptyCategoryTotals();
    totals.newSession = { bytes: 100, files: 2 };
    totals.newSnapshots = { bytes: 30, files: 1 };
    totals.newSubExecutions = { bytes: 20, files: 3 };
    // 目录被误传成不在 `<newSessionsRoot>` 之下时，文件会落入 otherFiles
    totals.otherFiles = { bytes: 7, files: 1 };

    const sizes = newSessionSizes({ totals, totalBytes: 157 });

    expect(sizes.attachmentBytes).toBe(50);
    expect(sizes.attachmentFiles).toBe(4);
    // 恒等式优先于「按分类直接取」：107 = 100（会话本体）+ 7（未预期分类）
    expect(sizes.sessionBytes).toBe(107);
    expect(sizes.sessionBytes + sizes.attachmentBytes).toBe(157);
  });
});

/* ------------------------------------------------------------------ *
 * 2. RankingRow 映射与恒等式（Req 6.8、6.9）
 * ------------------------------------------------------------------ */

describe('11.1 新布局 RankingRow 映射（Req 6.8、6.9）', () => {
  it('jsonBytes = 会话本体、archiveBytesSelf = snapshots + sub-executions、合计 = 两者之和', async () => {
    const t = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_cols',
      session: { title: '列映射', lastModifiedAt: LAST_MODIFIED_AT },
      events: [
        { payload: { type: 'user', content: 'hello' } },
        { payload: { type: 'assistant', content: 'hi' } },
      ],
      snapshots: { 'h1/a.ts': 200, 'h2/nested/b.ts': 50 },
      subExecutions: { 'exec-1/x.json': 60, 'exec-1/deep/y.json': 40 },
      extra: { 'publish.cursor': 8 },
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const row = res.rows[0];

    const metaBytes = sizeOf(t.sessionJson!);
    const msgBytes = sizeOf(t.messagesJsonl!);
    // Req 6.9 的「会话 JSON」列 = 会话本体：session.json + messages.jsonl +
    // 会话目录下其余文件（Req 6.2 明确把 publish*.cursor 算作「新格式会话」）。
    // 把 8 字节的 cursor 排除在外会让「合计 = 两列之和」与「合计 = 目录内全部文件」
    // 二者不能同时成立，届时排行页显示的占用会小于磁盘实际值。
    expect(row.jsonBytes).toBe(metaBytes + msgBytes + 8);
    expect(row.archiveBytesSelf).toBe(200 + 50 + 60 + 40);
    expect(row.totalBytes).toBe(row.jsonBytes + row.archiveBytesSelf);
    expect(row.totalBytes).toBe(bytesOf(listFiles(t.sessionDir)));
    // 行与 footprint 出自同一次计算，不存在两处各累加一次后漂移的可能
    expect(row.totalBytes).toBe(res.footprints[0].totalBytes);
  });

  it('buildNewRankingRow：合计恒等于两列之和（纯函数，含脏输入）', () => {
    const row = buildNewRankingRow({
      sessionId: 'sess_pure',
      title: 't',
      mtimeMs: Number.NaN,
      origin: 'new',
      sessionBytes: -5,
      attachmentBytes: Number.NaN,
      attachmentFiles: 0,
    });

    // 非有限值 / 负数按 0 计，避免污染合计
    expect(row.jsonBytes).toBe(0);
    expect(row.archiveBytesSelf).toBe(0);
    expect(row.totalBytes).toBe(0);
    expect(row.mtimeMs).toBe(0);
  });

  it('为每个会话目录出一行；工作区目录下的散落文件不产生行', async () => {
    for (const sessionId of ['sess_a', 'sess_b', '9f8fb2af-uuid']) {
      mkNewSessionTree(sessionsRoot, {
        wsHash16: WS_HASH,
        sessionId,
        events: [{ payload: { type: 'user', content: sessionId } }],
      });
    }
    fs.writeFileSync(path.join(workspaceSessionDir, 'stray.txt'), 'xxxxx', 'utf8');

    const res = await analyzerFor().getNewRankingRows({ force: true });

    expect(res.rows.map((r) => r.sessionId).sort()).toEqual(['9f8fb2af-uuid', 'sess_a', 'sess_b']);
    expect(res.sessionCount).toBe(3);
    // 散落文件不是会话，故不出行、不计入跳过（它的字节数由汇总统计的分类计量覆盖）
    expect(res.skippedCount).toBe(0);
    expect(res.partial).toBe(false);

    // Σ 各会话 SessionFootprint + 散落文件 = 该工作区目录的统计字节数
    const newRoots = buildNewClassifyRoots(homeKiroDir);
    const scan = await scanTree(workspaceSessionDir, {
      // `classify` 提供时优先于 `roots`，故这里的旧布局根恒不被读取
      roots: buildClassifyRoots(homeKiroDir),
      classify: (p) => classifyNewPath(newRoots, p),
    });
    expect(res.totalBytes + 5).toBe(scan.totalBytes);
    expect(res.totalBytes).toBe(res.rows.reduce((n, r) => n + r.totalBytes, 0));
  });

  it('缺 session.json / messages.jsonl 的残缺会话目录仍出行并计入占用', async () => {
    const noMeta = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_no_meta',
      session: null,
      events: [{ payload: { type: 'user', content: 'x' } }],
      snapshots: { 'h1/a.ts': 70 },
    });
    const onlySnapshots = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_only_snapshots',
      session: null,
      events: null,
      snapshots: { 'h1/b.ts': 90 },
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const byId = new Map(res.rows.map((r) => [r.sessionId, r]));

    // 占用统计如实反映磁盘：残缺目录照样占空间，不沿用 NewFormatReader 的跳过规则
    expect(byId.get('sess_no_meta')!.totalBytes).toBe(bytesOf(listFiles(noMeta.sessionDir)));
    expect(byId.get('sess_only_snapshots')!.totalBytes).toBe(
      bytesOf(listFiles(onlySnapshots.sessionDir))
    );
    // 标题空白原样保留，由渲染层统一出 `(无标题)`
    expect(byId.get('sess_no_meta')!.title).toBe('');
    expect(byId.get('sess_only_snapshots')!.title).toBe('');
  });

  it('SessionOrigin：`sess_` 前缀为 new，裸 uuid 为 migrated（恒不为 legacy-unmigrated）', async () => {
    for (const sessionId of ['sess_1f0d', '9f8fb2af-2b6c-4a1e-8c3d-000000000001']) {
      mkNewSessionTree(sessionsRoot, {
        wsHash16: WS_HASH,
        sessionId,
        events: [{ payload: { type: 'user', content: 'x' } }],
      });
    }

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const byId = new Map(res.rows.map((r) => [r.sessionId, r.origin]));

    expect(byId.get('sess_1f0d')).toBe('new');
    expect(byId.get('9f8fb2af-2b6c-4a1e-8c3d-000000000001')).toBe('migrated');
    expect(res.rows.map((r) => r.origin)).not.toContain('legacy-unmigrated');

    expect(newSessionOrigin('sess_x')).toBe('new');
    expect(newSessionOrigin('9f8fb2af')).toBe('migrated');
    // 大小写敏感：`Sess_` 不是 1.x 的新建前缀
    expect(newSessionOrigin('Sess_x')).toBe('migrated');
  });
});

/* ------------------------------------------------------------------ *
 * 3. 最后修改时间（Req 6.10）
 * ------------------------------------------------------------------ */

describe('11.1 最后修改时间取 lastModifiedAt（Req 6.10）', () => {
  it('取 session.json 的 lastModifiedAt，并按既有本地时区 YYYY-MM-DD HH:mm 展示', async () => {
    mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_time',
      session: { lastModifiedAt: LAST_MODIFIED_AT },
      events: [{ payload: { type: 'user', content: 'x' } }],
      // 刻意让文件 mtime 与 lastModifiedAt 相差数年：取错来源立刻可见
      messagesMtimeMs: Date.parse('2020-01-02T03:04:05.000Z'),
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const row = res.rows[0];

    expect(row.mtimeMs).toBe(Date.parse(LAST_MODIFIED_AT));
    expect(formatRankingTime(row.mtimeMs)).toBe(localStamp(Date.parse(LAST_MODIFIED_AT)));
    expect(formatRankingTime(row.mtimeMs)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('lastModifiedAt 缺失或非法时回退 messages.jsonl 的 mtime；两者都没有时回退目录 mtime', async () => {
    const mtimeMs = Date.parse('2026-07-01T00:00:00.000Z');
    const bad = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_bad_iso',
      session: { lastModifiedAt: 'not-a-date' },
      events: [{ payload: { type: 'user', content: 'x' } }],
      messagesMtimeMs: mtimeMs,
    });
    const missing = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_missing_iso',
      session: { lastModifiedAt: undefined },
      events: [{ payload: { type: 'user', content: 'x' } }],
      messagesMtimeMs: mtimeMs,
    });
    const noFiles = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_no_files',
      session: null,
      events: null,
      snapshots: { 'h1/a.ts': 10 },
    });

    const res = await analyzerFor().getNewRankingRows({ force: true });
    const byId = new Map(res.rows.map((r) => [r.sessionId, r.mtimeMs]));

    expect(byId.get('sess_bad_iso')).toBe(fs.statSync(bad.messagesJsonl!).mtimeMs);
    expect(byId.get('sess_missing_iso')).toBe(fs.statSync(missing.messagesJsonl!).mtimeMs);
    // 连 messages.jsonl 都没有：回退会话目录自身的 mtime，而不是 0（epoch）
    expect(byId.get('sess_no_files')).toBe(fs.statSync(noFiles.sessionDir).mtimeMs);
    expect(byId.get('sess_no_files')).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 重复统计稳定、缓存透明与返回副本（Req 6.15、6.14）
 * ------------------------------------------------------------------ */

describe('11.1 重复统计稳定且缓存透明（Req 6.14、6.15）', () => {
  it('同一磁盘状态下冷缓存、热子树缓存与 StorageCache 命中三者结果相等', async () => {
    mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_stable',
      session: { lastModifiedAt: LAST_MODIFIED_AT },
      events: [{ payload: { type: 'user', content: 'x' } }],
      snapshots: { 'h1/a.ts': 128 },
      subExecutions: { 'exec/b.bin': 64 },
    });

    const analyzer = analyzerFor();
    const cold = await analyzer.getNewRankingRows({ force: true });
    const warm = await analyzer.getNewRankingRows({ force: true }); // 子树聚合缓存已热
    const cached = await analyzer.getNewRankingRows(); // 命中 60 秒 StorageCache

    expect(warm).toEqual(cold);
    expect(cached).toEqual(cold);

    // 返回副本：调用方就地改写不污染后续读取
    cached.rows[0].totalBytes = -1;
    cached.footprints[0].jsonBytes = -1;
    cached.roots.push('/tmp/injected');
    expect(await analyzer.getNewRankingRows()).toEqual(cold);
  });

  it('清理后的缓存失效使下一次取数重新反映磁盘', async () => {
    const t = mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_invalidate',
      events: [{ payload: { type: 'user', content: 'x' } }],
      snapshots: { 'h1/a.ts': 500 },
    });

    const analyzer = analyzerFor();
    const before = await analyzer.getNewRankingRows({ force: true });
    expect(before.rows[0].archiveBytesSelf).toBe(500);

    const snapshotFile = path.join(t.snapshotsDir!, 'h1', 'a.ts');
    fs.unlinkSync(snapshotFile);
    analyzer.invalidateForDeletedFiles([snapshotFile]);

    const after = await analyzer.getNewRankingRows();
    expect(after.rows[0].archiveBytesSelf).toBe(0);
    expect(after.rows[0].totalBytes).toBe(before.rows[0].totalBytes - 500);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 只读、降级与 partial
 * ------------------------------------------------------------------ */

describe('11.1 取数只读且失败可降级', () => {
  it('一次取数只调用读 API，且夹具目录树前后逐字节相等', async () => {
    mkNewSessionTree(sessionsRoot, {
      wsHash16: WS_HASH,
      sessionId: 'sess_readonly',
      session: { lastModifiedAt: LAST_MODIFIED_AT },
      events: [{ payload: { type: 'user', content: 'x' } }],
      snapshots: { 'h1/a.ts': 32 },
      extra: { 'publish.cursor': 8 },
    });

    const { deps, calls } = recordingReadFs();
    const before = snapshotTree(base);

    const res = await analyzerFor({ fsDeps: deps as unknown as AnalyzerFsDeps }).getNewRankingRows({
      force: true,
    });

    expect(res.rows).toHaveLength(1);
    expect(snapshotTree(base)).toEqual(before);
    const allowed = new Set(['readdir', 'lstat', 'stat', 'readFile', 'yieldNow']);
    for (const c of calls) expect(allowed).toContain(c.op);
    // messages.jsonl 的内容恒不被打开（扫描只 stat 取字节数，Req 6.12）
    for (const c of calls) {
      if (c.op !== 'readFile') continue;
      expect(String(c.args[0])).toMatch(/session\.json$/);
    }
  });

  it('新布局根不可用或无工作区会话目录时返回空结果且 partial 为 false', async () => {
    const analyzer = new StorageAnalyzer({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
      listArchives: () => [],
    });

    expect(await analyzer.getNewRankingRows({ force: true })).toEqual({
      rows: [],
      footprints: [],
      totalBytes: 0,
      files: 0,
      sessionCount: 0,
      partial: false,
      skippedCount: 0,
      roots: [],
    });

    // 目录存在但还没有任何会话：空行集合，但根路径仍如实给出（供 tooltip 说明来源）
    const empty = await analyzerFor().getNewRankingRows({ force: true });
    expect(empty.rows).toEqual([]);
    expect(empty.partial).toBe(false);
    expect(empty.roots).toEqual([workspaceSessionDir]);
  });

  it('工作区会话目录不可枚举时计入跳过并置 partial，不抛异常', async () => {
    const deps: AnalyzerFsDeps = {
      readdir: async (p, o) => {
        if (path.normalize(p) === path.normalize(workspaceSessionDir)) {
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

    const res = await analyzerFor({ fsDeps: deps }).getNewRankingRows({ force: true });

    expect(res.rows).toEqual([]);
    expect(res.skippedCount).toBe(1);
    expect(res.partial).toBe(true);
  });

  it('取消时返回已完成的部分结果并标记 partial，且不写入缓存', async () => {
    for (const sessionId of ['sess_1', 'sess_2', 'sess_3']) {
      mkNewSessionTree(sessionsRoot, {
        wsHash16: WS_HASH,
        sessionId,
        events: [{ payload: { type: 'user', content: sessionId } }],
      });
    }

    const analyzer = analyzerFor();
    let seen = 0;
    const partialRes = await analyzer.getNewRankingRows({
      force: true,
      isCancelled: () => ++seen > 2,
    });

    expect(partialRes.rows.length).toBeLessThan(3);
    expect(partialRes.partial).toBe(true);

    // 残缺值不入 StorageCache：不传 force 的下一次调用重新取数并给出完整结果
    const full = await analyzer.getNewRankingRows();
    expect(full.rows).toHaveLength(3);
    expect(full.partial).toBe(false);
  });
});
