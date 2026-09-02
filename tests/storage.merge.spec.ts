import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  mergeRankingRows,
  projectSessionTotalFrom,
  StorageAnalyzer,
  sumLegacyResidueSessions,
  type AnalyzerFsDeps,
  type MergedRankingRows,
  type MergeNewSide,
  type MergeOldSide,
} from '../src/storage/analyzer';
import { buildClassifyRoots } from '../src/storage/classify';
import { encodeWorkspaceKeys, type PathResolverDeps } from '../src/paths';
import type { ArchiveInfo } from '../src/credits';
import type { RankingRow, SessionOrigin } from '../src/storage/types';
import {
  mkMigrationMarker,
  mkNewSessionTree,
  mkTempDir,
  recordingReadFs,
  rmTempDir,
  snapshotTree,
  writeSession,
} from './_helpers';

/**
 * 示例测试（任务 11.2、11.3）：`both` 布局下的双布局合并 / 残留归属，以及由**同一次**
 * 枚举结果聚合出的 ProjectSessionTotal。
 *
 * 覆盖 Requirement 6.7、7.2、7.3、7.4 与设计决策 D7。
 *
 * 文件归属说明：design 的「Testing Strategy」把 `tests/storage.aggregate.spec.ts` 留给
 * 任务 11.11（两个**手动触发**维度 AllKiroSessionTotal / LegacyResidueTotal 的口径、
 * 触发与缓存失效）。合并与 ProjectSessionTotal 是随排行数据一同下发的维度、且由
 * 11.2/11.3 引入，故单独成文件，避免与那个任务（可能并行进行）抢同一个文件。
 *
 * 前半为纯函数（零 IO）断言，后半用真实临时目录夹具跑通 StorageAnalyzer 的合并入口。
 */

/* ------------------------------------------------------------------ *
 * 0. 纯函数夹具
 * ------------------------------------------------------------------ */

/** 构造一行；字节数默认满足「合计 = 两列之和」，需要脏输入时可显式覆盖。 */
function mkRow(
  sessionId: string,
  jsonBytes: number,
  archiveBytesSelf: number,
  origin: SessionOrigin,
  extra: Partial<RankingRow> = {}
): RankingRow {
  return {
    title: `t-${sessionId}`,
    sessionId,
    jsonBytes,
    archiveBytesSelf,
    totalBytes: jsonBytes + archiveBytesSelf,
    mtimeMs: 1_700_000_000_000,
    origin,
    ...extra,
  };
}

function newSideOf(rows: RankingRow[], extra: Partial<MergeNewSide> = {}): MergeNewSide {
  return {
    rows,
    files: rows.length,
    partial: false,
    skippedCount: 0,
    roots: ['/new/ws'],
    ...extra,
  };
}

function oldSideOf(rows: RankingRow[], extra: Partial<MergeOldSide> = {}): MergeOldSide {
  return {
    rows,
    filesById: new Map(rows.map((r) => [r.sessionId, 1])),
    partial: false,
    skippedCount: 0,
    roots: ['/old/ws'],
    ...extra,
  };
}

function idsOf(rows: readonly RankingRow[]): string[] {
  return rows.map((r) => r.sessionId).sort();
}

function residueIds(sessions: readonly { sessionId: string }[]): string[] {
  return sessions.map((s) => s.sessionId).sort();
}

/* ------------------------------------------------------------------ *
 * 1. mergeRankingRows：同 sessionId 双份以新格式为唯一来源（Req 6.7、D7）
 * ------------------------------------------------------------------ */

describe('11.2 mergeRankingRows —— 双份归属（Req 6.7、设计决策 D7）', () => {
  it('同 sessionId 双份时只出一行、取新格式数值，旧份转记 residue.superseded 且不计入该会话占用', () => {
    const merged = mergeRankingRows(
      newSideOf([mkRow('dup', 100, 20, 'migrated')], { files: 3 }),
      oldSideOf([mkRow('dup', 10, 5, 'legacy-unmigrated')], {
        filesById: new Map([['dup', 2]]),
      })
    );

    // 列表只出现一次，且数值来自新格式那份（100 + 20），旧份的 15 字节不掺入
    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].jsonBytes).toBe(100);
    expect(merged.rows[0].archiveBytesSelf).toBe(20);
    expect(merged.rows[0].totalBytes).toBe(120);
    expect(merged.totalBytes).toBe(120);
    expect(merged.sessionCount).toBe(1);
    // 文件数同理只计新侧（旧份的 2 个文件挪进残留）
    expect(merged.files).toBe(3);

    // 旧份没有消失，而是转记 LegacyResidue —— 它仍在磁盘上占空间（D7）
    expect(merged.residue.superseded).toEqual([{ sessionId: 'dup', bytes: 15, files: 2 }]);
    expect(merged.residue.markedMigrated).toEqual([]);
    expect(merged.residue.unmigrated).toEqual([]);
    expect(merged.residue.bothSidesObserved).toBe(true);
    // 被剔除的旧份字节数可精确到某一行，供任务 12.1 的 tooltip 说明「本行不含旧残留」
    expect(sumLegacyResidueSessions(merged.residue.superseded)).toEqual({ bytes: 15, files: 2 });
  });

  it('每个会话恰好计入一次：sessionCount = 行数 = 去重后的 id 数，且合计恒等于各行之和', () => {
    const merged = mergeRankingRows(
      newSideOf([mkRow('sess_a', 10, 1, 'new'), mkRow('dup', 200, 30, 'migrated')], { files: 9 }),
      oldSideOf([
        mkRow('dup', 7, 3, 'migrated'),
        mkRow('old_b', 20, 5, 'legacy-unmigrated'),
        mkRow('old_c', 40, 0, 'migrated'),
      ])
    );

    expect(idsOf(merged.rows)).toEqual(['dup', 'old_b', 'old_c', 'sess_a']);
    expect(merged.sessionCount).toBe(merged.rows.length);
    expect(new Set(merged.rows.map((r) => r.sessionId)).size).toBe(merged.rows.length);
    // 恒等式 1：合计 = 各行之和（同一个 Map 单次遍历得出，不存在两处各累加一次）
    expect(merged.totalBytes).toBe(merged.rows.reduce((n, r) => n + r.totalBytes, 0));
    // 恒等式 2：会话本体 + 附件 = 合计（供 tooltip 的字节数拆解，Req 7.11）
    expect(merged.sessionBytes).toBe(10 + 200 + 20 + 40);
    expect(merged.attachmentBytes).toBe(1 + 30 + 5 + 0);
    expect(merged.sessionBytes + merged.attachmentBytes).toBe(merged.totalBytes);
    // 被顶掉的旧 dup（7 + 3）恒不在合计里
    expect(merged.totalBytes).toBe(11 + 230 + 25 + 40);
    // 文件数：新侧 9 个 + 留下的两个旧会话各 1 个（旧 dup 的文件数进残留）
    expect(merged.files).toBe(11);
  });

  it('旧侧独有会话按迁移证据分桶，两桶都仍计入占用（Req 7.4：覆盖仅存在于旧目录的会话）', () => {
    const merged = mergeRankingRows(
      newSideOf([], { roots: ['/new/ws'], files: 0 }),
      oldSideOf([
        mkRow('marked', 30, 0, 'migrated'), // 旧目录里有 MigrationMarker 指向它
        mkRow('plain', 50, 0, 'legacy-unmigrated'), // 无任何迁移证据
      ])
    );

    expect(residueIds(merged.residue.markedMigrated)).toEqual(['marked']);
    expect(residueIds(merged.residue.unmigrated)).toEqual(['plain']);
    expect(merged.residue.superseded).toEqual([]);
    // 两者都是该会话在磁盘上唯一被观测到的一份，故都出行、都计入合计
    expect(idsOf(merged.rows)).toEqual(['marked', 'plain']);
    expect(merged.totalBytes).toBe(80);
  });

  it('旧侧内部重复份只取首份成行，且恒不进任何残留桶（无证据的数据不进待删集合）', () => {
    const merged = mergeRankingRows(
      newSideOf([], { roots: [], files: 0 }),
      oldSideOf([
        mkRow('same', 10, 0, 'legacy-unmigrated'),
        mkRow('same', 999, 0, 'legacy-unmigrated'),
      ])
    );

    expect(merged.rows).toHaveLength(1);
    expect(merged.rows[0].jsonBytes).toBe(10);
    expect(merged.totalBytes).toBe(10);
    // 关键：第二份**不**被当成「被新格式取代」——那会让未迁移数据落进可清理的桶
    expect(merged.residue.superseded).toEqual([]);
    expect(residueIds(merged.residue.unmigrated)).toEqual(['same']);
    expect(merged.residue.unmigrated).toHaveLength(1);
  });

  it('SessionOrigin 在合并层补齐 presentInOtherSide：双份恒为 migrated，单侧回落前缀规则（Req 9.8）', () => {
    const both = mergeRankingRows(
      // 刻意给一个带 `sess_` 前缀（本该是 `new`）却在旧目录也有一份的会话
      newSideOf([mkRow('sess_dup', 10, 0, 'new'), mkRow('sess_only', 10, 0, 'new')]),
      oldSideOf([mkRow('sess_dup', 5, 0, 'legacy-unmigrated')])
    );
    const byId = new Map(both.rows.map((r) => [r.sessionId, r.origin]));

    // Req 9.8：`both` 下同 sessionId 双份恒判为 migrated（Property 9 钉住）
    expect(byId.get('sess_dup')).toBe('migrated');
    // 只在新侧的会话不受影响，仍按前缀规则判定
    expect(byId.get('sess_only')).toBe('new');

    // 旧侧留下的行无需重判：它们能留下正说明新侧没有同 sessionId
    const oldOnly = mergeRankingRows(
      newSideOf([], { roots: [], files: 0 }),
      oldSideOf([mkRow('m', 1, 0, 'migrated'), mkRow('u', 1, 0, 'legacy-unmigrated')])
    );
    expect(new Map(oldOnly.rows.map((r) => [r.sessionId, r.origin]))).toEqual(
      new Map([
        ['m', 'migrated'],
        ['u', 'legacy-unmigrated'],
      ])
    );
  });

  it('sides 区分「这一侧没有数据」与「这一侧没被观测到」；roots 新侧在前并按规范化去重', () => {
    // 新侧根存在但还没有任何会话：roots 非空、行为空 → 已观测到
    const observedEmpty = mergeRankingRows(
      newSideOf([], { roots: ['/new/ws'], files: 0 }),
      oldSideOf([mkRow('a', 1, 0, 'legacy-unmigrated')])
    );
    expect(observedEmpty.sides).toEqual({ newLayout: true, oldLayout: true });

    // 新布局根不可用：roots 为空 → 未被观测（`old-only`）
    const oldOnly = mergeRankingRows(
      newSideOf([], { roots: [], files: 0 }),
      oldSideOf([mkRow('a', 1, 0, 'legacy-unmigrated')])
    );
    expect(oldOnly.sides).toEqual({ newLayout: false, oldLayout: true });
    expect(oldOnly.residue.bothSidesObserved).toBe(false);
    expect(oldOnly.roots).toEqual(['/old/ws']);

    // 旧侧不可用：`new-only`
    const newOnly = mergeRankingRows(
      newSideOf([mkRow('sess_a', 1, 0, 'new')]),
      oldSideOf([], { roots: [] })
    );
    expect(newOnly.sides).toEqual({ newLayout: true, oldLayout: false });
    expect(newOnly.roots).toEqual(['/new/ws']);

    // roots：新侧在前，两侧给出同一路径时只保留一次（同 `path.normalize` 口径）
    const dupRoots = mergeRankingRows(
      newSideOf([], { roots: ['/a/new'] }),
      oldSideOf([], { roots: ['/a/old', '/a/new', ''] })
    );
    expect(dupRoots.roots).toEqual(['/a/new', '/a/old']);
  });

  it('partial / skippedCount 取两侧之并；脏数值不污染合计', () => {
    const merged = mergeRankingRows(
      newSideOf([], { partial: true, skippedCount: 2, files: Number.NaN }),
      oldSideOf([mkRow('a', -5, Number.NaN, 'legacy-unmigrated', { totalBytes: Number.NaN })], {
        skippedCount: 3,
      })
    );

    expect(merged.partial).toBe(true);
    expect(merged.skippedCount).toBe(5);
    // NaN / 负数按 0 计（与 safeBytes 同口径），不产生 NaN 合计
    expect(merged.totalBytes).toBe(0);
    expect(merged.sessionBytes).toBe(0);
    expect(merged.attachmentBytes).toBe(0);
    expect(merged.files).toBe(1);
    expect(merged.residue.unmigrated).toEqual([{ sessionId: 'a', bytes: 0, files: 1 }]);
  });

  it('两侧都为空且都未被观测时返回全零结果，不抛异常', () => {
    const merged = mergeRankingRows(
      newSideOf([], { roots: [], files: 0 }),
      oldSideOf([], { roots: [] })
    );

    expect(merged.rows).toEqual([]);
    expect(merged.totalBytes).toBe(0);
    expect(merged.files).toBe(0);
    expect(merged.sessionCount).toBe(0);
    expect(merged.partial).toBe(false);
    expect(merged.roots).toEqual([]);
    expect(merged.sides).toEqual({ newLayout: false, oldLayout: false });
    expect(merged.residue).toEqual({
      superseded: [],
      markedMigrated: [],
      unmigrated: [],
      bothSidesObserved: false,
    });
  });

  it('sumLegacyResidueSessions：空列表为 0，脏数值按 0 计', () => {
    expect(sumLegacyResidueSessions([])).toEqual({ bytes: 0, files: 0 });
    expect(
      sumLegacyResidueSessions([
        { sessionId: 'a', bytes: 10, files: 2 },
        { sessionId: 'b', bytes: Number.NaN, files: -1 },
        { sessionId: 'c', bytes: 5, files: 1 },
      ])
    ).toEqual({ bytes: 15, files: 3 });
  });
});

/* ------------------------------------------------------------------ *
 * 2. projectSessionTotalFrom（Req 7.2、7.3、7.4）
 * ------------------------------------------------------------------ */

describe('11.3 projectSessionTotalFrom —— 由合并结果聚合（Req 7.2、7.3）', () => {
  it('给出字节数与会话数，workspaceCount 恒为 1，roots 为被统计根', () => {
    const merged = mergeRankingRows(
      newSideOf([mkRow('sess_a', 100, 20, 'new')], { files: 4 }),
      oldSideOf([mkRow('old_b', 30, 0, 'legacy-unmigrated')])
    );

    expect(projectSessionTotalFrom(merged)).toEqual({
      state: 'ok',
      bytes: 150,
      files: 5,
      sessionCount: 2,
      // 单工作区维度恒为 1
      workspaceCount: 1,
      partial: false,
      skippedCount: 0,
      roots: ['/new/ws', '/old/ws'],
    });
  });

  it('两侧都未被观测时 state 为 unavailable、workspaceCount 为 0（tooltip 不会声称统计过 1 个目录）', () => {
    const total = projectSessionTotalFrom(
      mergeRankingRows(newSideOf([], { roots: [], files: 0 }), oldSideOf([], { roots: [] }))
    );

    expect(total.state).toBe('unavailable');
    expect(total.workspaceCount).toBe(0);
    expect(total.bytes).toBe(0);
    expect(total.sessionCount).toBe(0);
    expect(total.roots).toEqual([]);
  });

  it('目录存在但还没有会话时 state 仍为 ok（已统计，结果确实是 0）', () => {
    const total = projectSessionTotalFrom(
      mergeRankingRows(newSideOf([], { roots: ['/new/ws'], files: 0 }), oldSideOf([], { roots: [] }))
    );

    expect(total.state).toBe('ok');
    expect(total.workspaceCount).toBe(1);
    expect(total.sessionCount).toBe(0);
    expect(total.roots).toEqual(['/new/ws']);
  });

  it('partial 与 skippedCount 透传，供 UI 加 ≥ 前缀（Req 7.12）', () => {
    const total = projectSessionTotalFrom(
      mergeRankingRows(
        newSideOf([mkRow('sess_a', 1, 0, 'new')], { partial: true, skippedCount: 2 }),
        oldSideOf([], { skippedCount: 1 })
      )
    );

    expect(total.partial).toBe(true);
    expect(total.skippedCount).toBe(3);
  });

  it('返回副本：改写返回值的 roots 不影响合并结果', () => {
    const merged = mergeRankingRows(newSideOf([mkRow('sess_a', 1, 0, 'new')]), oldSideOf([]));
    const total = projectSessionTotalFrom(merged);
    total.roots.push('/injected');

    expect(merged.roots).toEqual(['/new/ws', '/old/ws']);
    expect(projectSessionTotalFrom(merged).roots).toEqual(['/new/ws', '/old/ws']);
  });
});

/* ------------------------------------------------------------------ *
 * 3. StorageAnalyzer 入口（真实临时目录夹具）
 * ------------------------------------------------------------------ */

/** 实测基线：`d:\Projects\KiroExt\KiroChatSearcher` 的 WsHash16。 */
const WS_HASH = 'cc5023603866cd91';
const WORKSPACE = 'd:\\Projects\\KiroExt\\KiroChatSearcher';

let base = '';
let homeKiroDir = '';
let newSessionsRoot = '';
let newWsDir = '';
let oldWsDir = '';
let archives: ArchiveInfo[] = [];

/** 注入的 PathResolver：使 UserDataDir = `<base>/Kiro`（与既有 analyzer 测试同一夹具）。 */
function pathResolverFor(runDir: string): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: runDir },
    homedir: () => runDir,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

function nullPathResolver(): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: '/kcs-nonexistent-xdg' },
    homedir: () => '/kcs-nonexistent-home',
    existsSync: () => false,
    statSync: () => ({ isDirectory: () => false }),
  };
}

function analyzerFor(extra: Record<string, unknown> = {}): StorageAnalyzer {
  return new StorageAnalyzer({
    pathResolver: pathResolverFor(base),
    workspacePath: WORKSPACE,
    newLayout: { homeKiroDir, newWorkspaceSessionDir: newWsDir },
    listArchives: () => archives,
    ...extra,
  });
}

/** 递归列出目录树下的**文件**绝对路径。 */
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

beforeEach(() => {
  base = mkTempDir('kcs-merge-');
  // 旧侧（0.9x）：<base>/Kiro/User/globalStorage/kiro.kiroagent/workspace-sessions/<EncodedKey>
  const roots = buildClassifyRoots(path.join(base, 'Kiro'));
  oldWsDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(WORKSPACE)[0]);
  fs.mkdirSync(oldWsDir, { recursive: true });
  // 新侧（1.x）：<base>/.kiro/sessions/<WsHash16>
  homeKiroDir = path.join(base, '.kiro');
  newSessionsRoot = path.join(homeKiroDir, 'sessions');
  newWsDir = path.join(newSessionsRoot, WS_HASH);
  fs.mkdirSync(newWsDir, { recursive: true });
  archives = [];
});

afterEach(() => {
  rmTempDir(base);
  base = '';
});

/**
 * `both` 夹具：
 * - `dup-uuid`：新旧两处各有一份（已迁移但旧份未清），旧目录里另有指向它的 MigrationMarker
 * - `sess_new1`：仅新格式
 * - `old-marked`：仅旧目录，但有 MigrationMarker 指向它
 * - `old-plain`：仅旧目录、无任何迁移证据，且有一个归因到它的执行存档
 */
function makeBothFixture(): { newDirs: string[]; oldFiles: Record<string, string> } {
  const dupNew = mkNewSessionTree(newSessionsRoot, {
    wsHash16: WS_HASH,
    sessionId: 'dup-uuid',
    session: { title: '已迁移的会话', lastModifiedAt: '2026-09-01T05:07:55.425Z' },
    events: [{ payload: { type: 'user', content: 'hi' } }],
    snapshots: { 'h1/a.ts': 120 },
  });
  const newOnly = mkNewSessionTree(newSessionsRoot, {
    wsHash16: WS_HASH,
    sessionId: 'sess_new1',
    session: { title: '1.x 新建', lastModifiedAt: '2026-09-02T00:00:00.000Z' },
    events: [{ payload: { type: 'user', content: 'x' } }],
  });

  const oldFiles: Record<string, string> = {
    'dup-uuid': writeSession(oldWsDir, 'dup-uuid', { title: '旧份', history: [] }),
    'old-marked': writeSession(oldWsDir, 'old-marked', { title: '标记已迁移', history: [] }),
    'old-plain': writeSession(oldWsDir, 'old-plain', { title: '未迁移', history: [] }),
  };
  mkMigrationMarker(oldWsDir, 'dup-uuid', WORKSPACE, { uuid: 'marker-1' });
  mkMigrationMarker(oldWsDir, 'old-marked', WORKSPACE, { uuid: 'marker-2' });

  archives = [
    { path: path.join(base, 'arch-1'), name: 'arch-1', size: 40, chatSessionId: 'old-plain' },
  ];

  return { newDirs: [dupNew.sessionDir, newOnly.sessionDir], oldFiles };
}

describe('11.2 StorageAnalyzer.getMergedRankingRows —— both 布局（Req 6.7、7.4）', () => {
  it('同 sessionId 双份时新格式为唯一来源，旧份进 residue 且每个会话恰好出现一次', async () => {
    const { newDirs, oldFiles } = makeBothFixture();

    const merged = await analyzerFor().getMergedRankingRows({ force: true });
    const byId = new Map(merged.rows.map((r) => [r.sessionId, r]));

    // 四个会话各一行：新格式 2 个（其中 1 个与旧份重名）+ 仅旧目录 2 个
    expect(idsOf(merged.rows)).toEqual(['dup-uuid', 'old-marked', 'old-plain', 'sess_new1']);
    expect(merged.sessionCount).toBe(4);
    expect(merged.sides).toEqual({ newLayout: true, oldLayout: true });
    expect(merged.roots).toEqual([newWsDir, oldWsDir]);

    // dup-uuid 的数值全部来自**新**目录（含快照），旧那份 JSON 一个字节都不掺入
    const dupNewBytes = bytesOf(listFiles(newDirs[0]));
    expect(byId.get('dup-uuid')!.totalBytes).toBe(dupNewBytes);
    expect(byId.get('dup-uuid')!.title).toBe('已迁移的会话');
    // Req 9.8：双份恒判为 migrated
    expect(byId.get('dup-uuid')!.origin).toBe('migrated');

    // 旧份转记 LegacyResidue：字节数 = 该 SessionFile 大小（无归因存档），文件数 1
    expect(merged.residue.superseded).toEqual([
      { sessionId: 'dup-uuid', bytes: fs.statSync(oldFiles['dup-uuid']).size, files: 1 },
    ]);
    expect(merged.residue.bothSidesObserved).toBe(true);

    // 仅旧目录的两个会话按迁移证据分桶
    expect(residueIds(merged.residue.markedMigrated)).toEqual(['old-marked']);
    expect(residueIds(merged.residue.unmigrated)).toEqual(['old-plain']);
    // old-plain 带一个 40 字节的归因存档：字节数与文件数同口径（1 个 JSON + 1 个存档）
    expect(merged.residue.unmigrated[0].bytes).toBe(
      fs.statSync(oldFiles['old-plain']).size + 40
    );
    expect(merged.residue.unmigrated[0].files).toBe(2);
    expect(byId.get('old-plain')!.archiveBytesSelf).toBe(40);

    // 合计恒等于各行之和，且不含被剔除的旧份
    expect(merged.totalBytes).toBe(merged.rows.reduce((n, r) => n + r.totalBytes, 0));
    expect(merged.sessionBytes + merged.attachmentBytes).toBe(merged.totalBytes);
    expect(merged.partial).toBe(false);
    expect(merged.skippedCount).toBe(0);

    // 文件数：新侧目录内全部文件 + 旧侧（old-marked 1 个、old-plain 1 个 JSON + 1 个存档）
    const newFiles = newDirs.reduce((n, d) => n + listFiles(d).length, 0);
    expect(merged.files).toBe(newFiles + 1 + 2);
  });

  it('迁移标记与会话清单都不成行（它们不是会话）', async () => {
    makeBothFixture();
    writeSession(oldWsDir, 'sessions', [{ sessionId: 'old-plain', title: '清单里的标题' }]);

    const merged = await analyzerFor().getMergedRankingRows({ force: true });

    expect(merged.rows.some((r) => r.sessionId.startsWith('._migration-'))).toBe(false);
    expect(merged.rows.some((r) => r.sessionId === 'sessions')).toBe(false);
    // 清单是标题的权威来源，故该行标题取清单里的值
    expect(merged.rows.find((r) => r.sessionId === 'old-plain')!.title).toBe('清单里的标题');
  });

  it('new-only：旧侧不可用时结果等于新侧，且旧数据归属为空', async () => {
    makeBothFixture();

    const merged = await analyzerFor({
      pathResolver: nullPathResolver(),
    }).getMergedRankingRows({ force: true });

    expect(idsOf(merged.rows)).toEqual(['dup-uuid', 'sess_new1']);
    expect(merged.sides).toEqual({ newLayout: true, oldLayout: false });
    expect(merged.roots).toEqual([newWsDir]);
    expect(merged.residue.superseded).toEqual([]);
    expect(merged.residue.markedMigrated).toEqual([]);
    expect(merged.residue.unmigrated).toEqual([]);
    expect(merged.residue.bothSidesObserved).toBe(false);
    // 旧侧没被观测到，故 dup-uuid 回落前缀规则（裸 uuid → migrated）
    expect(merged.rows.find((r) => r.sessionId === 'dup-uuid')!.origin).toBe('migrated');
  });

  it('old-only：新布局根不可用时结果等于旧侧，未迁移会话照常计入（Req 7.4）', async () => {
    makeBothFixture();

    const merged = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getMergedRankingRows({ force: true });

    expect(idsOf(merged.rows)).toEqual(['dup-uuid', 'old-marked', 'old-plain']);
    expect(merged.sides).toEqual({ newLayout: false, oldLayout: true });
    expect(merged.roots).toEqual([oldWsDir]);
    // 新侧未被观测：dup-uuid 只能靠 MigrationMarker 判为已迁移，不进 superseded
    expect(merged.residue.superseded).toEqual([]);
    expect(residueIds(merged.residue.markedMigrated)).toEqual(['dup-uuid', 'old-marked']);
    expect(residueIds(merged.residue.unmigrated)).toEqual(['old-plain']);
    expect(merged.residue.bothSidesObserved).toBe(false);
  });

  it('getRankingRows 的对外形状不因内部多带信息而变化（既有契约回归）', async () => {
    makeBothFixture();

    const rows = await analyzerFor().getRankingRows({ force: true });

    expect(Object.keys(rows).sort()).toEqual(['partial', 'rows', 'skippedCount']);
    expect(idsOf(rows.rows)).toEqual(['dup-uuid', 'old-marked', 'old-plain']);
    expect(rows.partial).toBe(false);
    expect(rows.skippedCount).toBe(0);
  });
});

describe('11.3 StorageAnalyzer.getProjectSessionTotal —— 同一次枚举结果（Req 7.2、7.3）', () => {
  it('数值与排行取数同源，且聚合本身不发起任何文件系统调用', async () => {
    makeBothFixture();

    const { deps, calls } = recordingReadFs();
    const analyzer = analyzerFor({ fsDeps: deps as unknown as AnalyzerFsDeps });

    const merged = await analyzer.getMergedRankingRows({ force: true });
    const afterMerge = calls.length;
    expect(afterMerge).toBeGreaterThan(0);

    // (1) 纯函数聚合：零 IO —— 调用记录一条不增
    const fromMerged = projectSessionTotalFrom(merged);
    expect(calls.length).toBe(afterMerge);

    // (2) 便利封装：命中两侧的 60 秒缓存，同样不再枚举任何目录（Req 7.3）
    const viaAnalyzer = await analyzer.getProjectSessionTotal();
    expect(calls.length).toBe(afterMerge);
    expect(viaAnalyzer).toEqual(fromMerged);

    // 数值口径：Σ 各行占用 + 会话数（每个会话恰好一次）
    expect(viaAnalyzer.state).toBe('ok');
    expect(viaAnalyzer.bytes).toBe(merged.rows.reduce((n, r) => n + r.totalBytes, 0));
    expect(viaAnalyzer.sessionCount).toBe(4);
    expect(viaAnalyzer.workspaceCount).toBe(1);
    expect(viaAnalyzer.roots).toEqual([newWsDir, oldWsDir]);
  });

  it('两侧都不可用时返回 unavailable 而不抛异常', async () => {
    const analyzer = new StorageAnalyzer({
      pathResolver: nullPathResolver(),
      workspacePath: null,
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
      listArchives: () => [],
    });

    const total = await analyzer.getProjectSessionTotal({ force: true });

    expect(total.state).toBe('unavailable');
    expect(total.bytes).toBe(0);
    expect(total.sessionCount).toBe(0);
    expect(total.workspaceCount).toBe(0);
    expect(total.roots).toEqual([]);
  });

  it('清理后缓存失效：下一次聚合反映更新后的磁盘', async () => {
    const { newDirs } = makeBothFixture();
    const analyzer = analyzerFor();

    const before = await analyzer.getProjectSessionTotal({ force: true });
    const snapshotFile = path.join(newDirs[0], 'snapshots', 'h1', 'a.ts');
    expect(fs.statSync(snapshotFile).size).toBe(120);

    fs.unlinkSync(snapshotFile);
    analyzer.invalidateForDeletedFiles([snapshotFile]);

    // 不传 force：合并层自身不持缓存，两侧缓存已被打掉，故数值自动更新
    const after = await analyzer.getProjectSessionTotal();
    expect(after.bytes).toBe(before.bytes - 120);
    expect(after.sessionCount).toBe(before.sessionCount);
  });

  it('一次合并 + 聚合全程只读：夹具目录树前后逐字节相等，调用面 ⊆ 只读白名单', async () => {
    makeBothFixture();
    const { deps, calls } = recordingReadFs();
    const treeBefore = snapshotTree(base);

    const analyzer = analyzerFor({ fsDeps: deps as unknown as AnalyzerFsDeps });
    const merged: MergedRankingRows = await analyzer.getMergedRankingRows({ force: true });
    projectSessionTotalFrom(merged);

    expect(merged.rows).toHaveLength(4);
    expect(snapshotTree(base)).toEqual(treeBefore);
    const allowed = new Set(['readdir', 'lstat', 'stat', 'readFile', 'yieldNow']);
    for (const c of calls) expect(allowed).toContain(c.op);
  });
});
