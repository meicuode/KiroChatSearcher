/**
 * 示例测试（任务 11.11）：排行表之上两个聚合维度与旧残留维度的**口径**。
 *
 * 与 `storage.merge.spec.ts`（任务 11.2/11.3）的分工：那份钉的是「当前工作区」这一层
 * ——双布局合并去重与 ProjectSessionTotal；本份钉的是跨工作区的两个维度：
 * AllKiroSessionTotal（含 `old-only` 回退）与 LegacyResidueTotal（含两分划分），
 * 以及一次清理之后的缓存失效。
 *
 * 夹具约定沿用既有 analyzer 测试：真实临时目录 + 注入 PathResolver（linux +
 * XDG_CONFIG_HOME 指向 runDir，使 UserDataDir = `<base>/Kiro`）+ 基于真实
 * `fs.promises` 的只读注入 fs。期望值一律**由夹具目录树现算**而不是写死常量，
 * 避免「改了夹具忘了改数字」时测试仍然通过。
 *
 * _Requirements: 7.6, 7.7, 7.10, 7.13, 8.1, 8.5, 8.6, 8.8, 12.4, 12.5, 12.6_
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  StorageAnalyzer,
  idleAggregateTotal,
  idleLegacyResidueTotal,
  type AnalyzerFsDeps,
} from '../src/storage/analyzer';
import { buildClassifyRoots } from '../src/storage/classify';
import { encodeWorkspaceKeys, type PathResolverDeps } from '../src/paths';
import { workspaceIdCandidates } from '../src/credits';
import {
  mkNewSessionTree,
  mkMigrationMarker,
  mkTempDir,
  rmTempDir,
  writeRaw,
  writeSession,
} from './_helpers';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 实测基线：`d:\Projects\KiroExt\KiroChatSearcher` 的 WsHash16。 */
const WS_HASH = 'cc5023603866cd91';
const WORKSPACE = 'd:\\Projects\\KiroExt\\KiroChatSearcher';
/** 另一个工作区（实测基线 `d:\SurErp\ERP-OMS-Workspaces`）。 */
const OTHER_WS_HASH = '6082f0c94c5c4af8';
const OTHER_WORKSPACE = 'd:\\SurErp\\ERP-OMS-Workspaces';

let base = '';
let homeKiroDir = '';
let newSessionsRoot = '';
let newWsDir = '';
let newOtherWsDir = '';
let roots: ReturnType<typeof buildClassifyRoots>;
let oldWsDir = '';
let oldOtherWsDir = '';
let oldExecDir = '';

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

/** 基于真实 `fs.promises` 的只读注入 fs；`onReaddir` 用于断言枚举范围与缓存命中。 */
function readFsDeps(onReaddir?: (p: string) => void): AnalyzerFsDeps {
  return {
    readdir: async (p, o) => {
      onReaddir?.(p);
      return fs.promises.readdir(p, o) as unknown as ReturnType<AnalyzerFsDeps['readdir']>;
    },
    lstat: (p) => fs.promises.lstat(p) as unknown as ReturnType<AnalyzerFsDeps['lstat']>,
    stat: (p) => fs.promises.stat(p) as unknown as ReturnType<AnalyzerFsDeps['stat']>,
    readFile: (p, enc) => fs.promises.readFile(p, enc),
  };
}

interface AnalyzerOverrides {
  pathResolver?: PathResolverDeps;
  workspacePath?: string | null;
  newLayout?: {
    homeKiroDir: string | null;
    newWorkspaceSessionDir: string | null;
    newSessionsRoot?: string | null;
  };
  fsDeps?: AnalyzerFsDeps;
}

function analyzerFor(extra: AnalyzerOverrides = {}): StorageAnalyzer {
  return new StorageAnalyzer({
    pathResolver: pathResolverFor(base),
    workspacePath: WORKSPACE,
    newLayout: { homeKiroDir, newWorkspaceSessionDir: newWsDir },
    fsDeps: readFsDeps(),
    listArchives: () => [],
    ...extra,
  });
}

/** 递归列出目录树下的**文件**绝对路径；目录不存在时返回空数组。 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    return [];
  }
  return out.sort();
}

function bytesOf(files: readonly string[]): number {
  return files.reduce((n, f) => n + fs.statSync(f).size, 0);
}

/**
 * 新侧（1.x）夹具：两个工作区目录，共 3 个会话。
 * - `<WS_HASH>`：`dup-uuid`（与旧侧同名，即已迁移但旧份未清）、`sess_new1`
 * - `<OTHER_WS_HASH>`：`sess_other`
 * 另在 sessions 根下放一个散落文件，验证它也如实计入字节数。
 */
function makeNewSide(): void {
  mkNewSessionTree(newSessionsRoot, {
    wsHash16: WS_HASH,
    sessionId: 'dup-uuid',
    session: { title: '已迁移的会话' },
    events: [{ payload: { type: 'user', content: 'hi' } }],
    snapshots: { 'h1/a.ts': 120 },
  });
  mkNewSessionTree(newSessionsRoot, {
    wsHash16: WS_HASH,
    sessionId: 'sess_new1',
    session: { title: '1.x 新建' },
    events: [{ payload: { type: 'user', content: 'x' } }],
    extra: { 'publish.cursor': 8 },
  });
  mkNewSessionTree(newSessionsRoot, {
    wsHash16: OTHER_WS_HASH,
    sessionId: 'sess_other',
    session: { title: '另一个工作区' },
    events: [{ payload: { type: 'user', content: 'y' } }],
    subExecutions: { 'sub/1.json': 64 },
  });
  writeRaw(newSessionsRoot, '.migration-v3', 'ok');
}

/**
 * 旧侧（0.9x）夹具：两个工作区会话目录 + 一个执行数据目录。
 *
 * `<EncodedKey(WORKSPACE)>`：
 * - `dup-uuid.json`   —— 新侧有同 sessionId 的目录 → 已迁移仅残留（证据一）
 * - `old-marked.json` —— 有 MigrationMarker 指向它 → 已迁移仅残留（证据二）
 * - `old-plain.json`  —— 无任何迁移证据 → 未迁移
 * - `sessions.json`   —— 清单，不是会话
 * - 两个 `._migration-*.json` 标记
 *
 * `<EncodedKey(OTHER_WORKSPACE)>`：`other-plain.json`（无证据）
 * `<storeRoot>/<WorkspaceId>`：执行存档一枚（无法按会话归属）
 */
function makeOldSide(): void {
  writeSession(oldWsDir, 'dup-uuid', { title: '旧份', history: [] });
  writeSession(oldWsDir, 'old-marked', { title: '标记已迁移', history: [] });
  writeSession(oldWsDir, 'old-plain', { title: '未迁移', history: [] });
  writeSession(oldWsDir, 'sessions', [{ sessionId: 'dup-uuid', title: '旧份' }]);
  mkMigrationMarker(oldWsDir, 'dup-uuid', WORKSPACE, { uuid: 'marker-1' });
  mkMigrationMarker(oldWsDir, 'old-marked', WORKSPACE, { uuid: 'marker-2' });

  writeSession(oldOtherWsDir, 'other-plain', { title: '另一个工作区的旧会话', history: [] });

  fs.mkdirSync(path.join(oldExecDir, 'bucket'), { recursive: true });
  writeRaw(path.join(oldExecDir, 'bucket'), 'archive-1', 'x'.repeat(200));
}

beforeEach(() => {
  base = mkTempDir('kcs-aggregate-');

  homeKiroDir = path.join(base, '.kiro');
  newSessionsRoot = path.join(homeKiroDir, 'sessions');
  newWsDir = path.join(newSessionsRoot, WS_HASH);
  newOtherWsDir = path.join(newSessionsRoot, OTHER_WS_HASH);

  roots = buildClassifyRoots(path.join(base, 'Kiro'));
  oldWsDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(WORKSPACE)[0]);
  oldOtherWsDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(OTHER_WORKSPACE)[0]);
  oldExecDir = path.join(roots.storeRoot, workspaceIdCandidates(WORKSPACE)[0]);

  fs.mkdirSync(oldWsDir, { recursive: true });
  fs.mkdirSync(oldOtherWsDir, { recursive: true });
});

afterEach(() => {
  rmTempDir(base);
  base = '';
});

/* ------------------------------------------------------------------ *
 * 1. 空闲态占位值
 * ------------------------------------------------------------------ */

describe('11.11 聚合维度的空闲态（Req 7.8、8.4）', () => {
  it('idle 占位值的 state 为 idle 且各数值恒 0', () => {
    expect(idleAggregateTotal()).toEqual({
      state: 'idle',
      bytes: 0,
      files: 0,
      sessionCount: 0,
      workspaceCount: 0,
      partial: false,
      skippedCount: 0,
      roots: [],
    });
    const residue = idleLegacyResidueTotal();
    expect(residue.state).toBe('idle');
    expect(residue.migratedResidueBytes).toBe(0);
    expect(residue.unmigratedBytes).toBe(0);
    // 两部分之和恒等于总量，空闲态下也成立
    expect(residue.migratedResidueBytes + residue.unmigratedBytes).toBe(residue.bytes);
  });
});

/* ------------------------------------------------------------------ *
 * 2. AllKiroSessionTotal（Req 7.6、7.10）
 * ------------------------------------------------------------------ */

describe('11.4 getAllKiroSessionTotal —— 新侧（Req 7.6、7.10）', () => {
  it('求和覆盖 NewSessionsRoot 下全部工作区目录，并给出工作区数与会话数', async () => {
    makeNewSide();
    makeOldSide();

    const total = await analyzerFor().getAllKiroSessionTotal();

    const expected = listFiles(newSessionsRoot);
    expect(total.state).toBe('ok');
    // 口径 = sessions 根下的全部文件（含各会话目录内的快照与子执行、以及根下散落文件）
    expect(total.bytes).toBe(bytesOf(expected));
    expect(total.files).toBe(expected.length);
    expect(total.workspaceCount).toBe(2);
    expect(total.sessionCount).toBe(3);
    expect(total.partial).toBe(false);
    expect(total.skippedCount).toBe(0);
    expect(total.roots).toEqual([newSessionsRoot]);
  });

  it('LegacyResidue 排除在默认范围之外：旧目录的字节数一个都不掺入', async () => {
    makeNewSide();
    makeOldSide();

    const total = await analyzerFor().getAllKiroSessionTotal();

    // 旧侧确实有数据（否则这条断言是空的）
    const oldBytes = bytesOf([...listFiles(roots.sessionsRoot), ...listFiles(oldExecDir)]);
    expect(oldBytes).toBeGreaterThan(0);
    expect(total.bytes).toBe(bytesOf(listFiles(newSessionsRoot)));
    // 被统计根里也不出现任何旧路径
    expect(total.roots.some((r) => r.includes('kiro.kiroagent'))).toBe(false);
  });

  it('注入 newSessionsRoot 时优先使用它，与由 homeKiroDir 派生的结果一致', async () => {
    makeNewSide();

    const derived = await analyzerFor().getAllKiroSessionTotal();
    const injected = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: newWsDir, newSessionsRoot },
    }).getAllKiroSessionTotal();

    expect(injected).toEqual(derived);
  });

  it('结果被缓存：第二次调用不再枚举目录；force 时重新枚举', async () => {
    makeNewSide();
    const seen: string[] = [];
    const analyzer = analyzerFor({ fsDeps: readFsDeps((p) => seen.push(p)) });

    const first = await analyzer.getAllKiroSessionTotal();
    const firstCalls = seen.length;
    expect(firstCalls).toBeGreaterThan(0);

    const second = await analyzer.getAllKiroSessionTotal();
    expect(second).toEqual(first);
    // 缓存无 TTL：手动触发维度重复读取恒不再枚举（Req 7.6「缓存以供后续复用」）
    expect(seen.length).toBe(firstCalls);

    await analyzer.getAllKiroSessionTotal({ force: true });
    expect(seen.length).toBeGreaterThan(firstCalls);
  });

  it('返回副本：调用方就地改写 roots 不污染缓存', async () => {
    makeNewSide();
    const analyzer = analyzerFor();

    const first = await analyzer.getAllKiroSessionTotal();
    first.roots.push('/tampered');

    expect((await analyzer.getAllKiroSessionTotal()).roots).toEqual([newSessionsRoot]);
  });
});

describe('11.4 getAllKiroSessionTotal —— old-only 回退（Req 7.7）', () => {
  it('NewSessionsRoot 不可用时改扫 OldSessionsRoot，而不是恒返回 0', async () => {
    makeOldSide();

    const total = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getAllKiroSessionTotal();

    const expected = listFiles(roots.sessionsRoot);
    expect(total.state).toBe('ok');
    expect(total.bytes).toBe(bytesOf(expected));
    expect(total.files).toBe(expected.length);
    expect(total.workspaceCount).toBe(2);
    // 会话数只数 `<sessionId>.json`：清单与两个迁移标记不是会话
    // （dup-uuid / old-marked / old-plain + 另一工作区的 other-plain）
    expect(total.sessionCount).toBe(4);
    expect(total.roots).toEqual([roots.sessionsRoot]);
  });

  it('回退口径不含 `<OldStoreRoot>/<WorkspaceId>` 的执行数据', async () => {
    makeOldSide();

    const total = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getAllKiroSessionTotal();

    expect(bytesOf(listFiles(oldExecDir))).toBeGreaterThan(0);
    expect(total.bytes).toBe(bytesOf(listFiles(roots.sessionsRoot)));
  });

  it('两侧根都不可用 → state 为 unavailable 且不抛异常', async () => {
    const total = await analyzerFor({
      pathResolver: nullPathResolver(),
      workspacePath: null,
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getAllKiroSessionTotal();

    expect(total.state).toBe('unavailable');
    expect(total.bytes).toBe(0);
    expect(total.sessionCount).toBe(0);
    expect(total.workspaceCount).toBe(0);
    expect(total.roots).toEqual([]);
  });

  it('UserDataDir 可解析但旧根尚未建出时同样是 unavailable，而不是 0 的 ok', async () => {
    // 本用例刻意不建任何目录：新根与旧根都 readdir 失败
    const total = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
      pathResolver: pathResolverFor(path.join(base, 'empty')),
    }).getAllKiroSessionTotal();

    expect(total.state).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------ *
 * 3. LegacyResidueTotal（Req 8.1、8.5、8.6）
 * ------------------------------------------------------------------ */

describe('11.5 getLegacyResidueTotal —— 总量与两分（Req 8.1、8.5、8.6）', () => {
  it('总量覆盖 OldSessionsRoot 与 <OldStoreRoot>/<WorkspaceId> 两个范围', async () => {
    makeNewSide();
    makeOldSide();

    const residue = await analyzerFor().getLegacyResidueTotal();

    const expected = [...listFiles(roots.sessionsRoot), ...listFiles(oldExecDir)];
    expect(residue.state).toBe('ok');
    expect(residue.bytes).toBe(bytesOf(expected));
    expect(residue.files).toBe(expected.length);
    // 工作区目录数取旧会话目录数（执行数据目录按另一套哈希命名，计两次会重复）
    expect(residue.workspaceCount).toBe(2);
    expect(residue.sessionCount).toBe(4);
    expect(residue.roots).toEqual([roots.sessionsRoot, roots.storeRoot]);
  });

  it('「已迁移仅残留」只含有正面证据的旧会话：新侧同名 + MigrationMarker 指向', async () => {
    makeNewSide();
    makeOldSide();

    const residue = await analyzerFor().getLegacyResidueTotal();

    const dup = fs.statSync(path.join(oldWsDir, 'dup-uuid.json')).size;
    const marked = fs.statSync(path.join(oldWsDir, 'old-marked.json')).size;
    expect(residue.migratedResidueBytes).toBe(dup + marked);
    expect(residue.migratedResidueFiles).toBe(2);
  });

  it('「未迁移」取补集，故总量恒等于两部分之和', async () => {
    makeNewSide();
    makeOldSide();

    const residue = await analyzerFor().getLegacyResidueTotal();

    expect(residue.migratedResidueBytes + residue.unmigratedBytes).toBe(residue.bytes);
    expect(residue.migratedResidueFiles + residue.unmigratedFiles).toBe(residue.files);
    // 补集里含真正未迁移的会话、清单、标记本身，以及无法按会话归属的执行数据
    expect(residue.unmigratedBytes).toBeGreaterThan(0);
  });

  it('新侧不可观测时只认 MigrationMarker：偏差方向是少判「已迁移」而非多判', async () => {
    makeOldSide(); // 刻意不建新侧

    const residue = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getLegacyResidueTotal();

    const dup = fs.statSync(path.join(oldWsDir, 'dup-uuid.json')).size;
    const marked = fs.statSync(path.join(oldWsDir, 'old-marked.json')).size;
    // dup-uuid 仍被判为已迁移——因为旧目录里有指向它的标记；若两个证据都没有就该落进补集
    expect(residue.migratedResidueBytes).toBe(dup + marked);
  });

  it('MigrationMarker 内容非法时不误判为已迁移', async () => {
    makeOldSide();
    writeRaw(oldWsDir, '._migration-broken.json', '{ not json');
    writeRaw(oldWsDir, '._migration-nofield.json', JSON.stringify({ migratedAt: 'x' }));
    writeSession(oldWsDir, 'broken-target', { title: '标记坏了', history: [] });

    const residue = await analyzerFor({
      newLayout: { homeKiroDir: null, newWorkspaceSessionDir: null },
    }).getLegacyResidueTotal();

    const dup = fs.statSync(path.join(oldWsDir, 'dup-uuid.json')).size;
    const marked = fs.statSync(path.join(oldWsDir, 'old-marked.json')).size;
    expect(residue.migratedResidueBytes).toBe(dup + marked);
    // 坏标记不计入 skippedCount：字节数与文件数仍然精确
    expect(residue.skippedCount).toBe(0);
    expect(residue.partial).toBe(false);
  });

  it('旧目录不存在或不可读 → 标记不可用且不抛异常（Req 8.8）', async () => {
    makeNewSide(); // 新侧照常可用

    const residue = await analyzerFor({
      pathResolver: pathResolverFor(path.join(base, 'empty')),
    }).getLegacyResidueTotal();

    expect(residue.state).toBe('unavailable');
    expect(residue.bytes).toBe(0);
    expect(residue.migratedResidueBytes).toBe(0);
    expect(residue.unmigratedBytes).toBe(0);
  });

  it('结果被缓存；force 时重新枚举', async () => {
    makeNewSide();
    makeOldSide();
    const seen: string[] = [];
    const analyzer = analyzerFor({ fsDeps: readFsDeps((p) => seen.push(p)) });

    const first = await analyzer.getLegacyResidueTotal();
    const firstCalls = seen.length;

    expect(await analyzer.getLegacyResidueTotal()).toEqual(first);
    expect(seen.length).toBe(firstCalls);

    await analyzer.getLegacyResidueTotal({ force: true });
    expect(seen.length).toBeGreaterThan(firstCalls);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 清理后的缓存失效（Req 7.13、8.8、11.8）
 * ------------------------------------------------------------------ */

describe('11.6 清理后聚合维度的缓存失效（Req 7.13、8.8）', () => {
  it('invalidateForDeletedFiles 之后两个维度都反映更新后的数值', async () => {
    makeNewSide();
    makeOldSide();
    const analyzer = analyzerFor();

    const beforeAll = await analyzer.getAllKiroSessionTotal();
    const beforeResidue = await analyzer.getLegacyResidueTotal();

    // 删掉新侧的一个快照文件与旧侧的一个未迁移会话文件
    const snapshot = path.join(newWsDir, 'dup-uuid', 'snapshots', 'h1', 'a.ts');
    const oldPlain = path.join(oldWsDir, 'old-plain.json');
    const snapshotBytes = fs.statSync(snapshot).size;
    const oldPlainBytes = fs.statSync(oldPlain).size;
    fs.rmSync(snapshot);
    fs.rmSync(oldPlain);

    analyzer.invalidateForDeletedFiles([snapshot, oldPlain]);

    // 不传 force 也必须重算：缓存已被失效
    const afterAll = await analyzer.getAllKiroSessionTotal();
    const afterResidue = await analyzer.getLegacyResidueTotal();

    expect(afterAll.bytes).toBe(beforeAll.bytes - snapshotBytes);
    expect(afterAll.files).toBe(beforeAll.files - 1);
    expect(afterResidue.bytes).toBe(beforeResidue.bytes - oldPlainBytes);
    expect(afterResidue.sessionCount).toBe(beforeResidue.sessionCount - 1);
    // 被删的是「未迁移」那一份，故可清理部分不变、补集减少
    expect(afterResidue.migratedResidueBytes).toBe(beforeResidue.migratedResidueBytes);
    expect(afterResidue.unmigratedBytes).toBe(beforeResidue.unmigratedBytes - oldPlainBytes);
  });

  it('clearCache 同样清掉两个维度的缓存', async () => {
    makeNewSide();
    const seen: string[] = [];
    const analyzer = analyzerFor({ fsDeps: readFsDeps((p) => seen.push(p)) });

    await analyzer.getAllKiroSessionTotal();
    const firstCalls = seen.length;
    await analyzer.getAllKiroSessionTotal();
    expect(seen.length).toBe(firstCalls);

    analyzer.clearCache();
    await analyzer.getAllKiroSessionTotal();
    expect(seen.length).toBeGreaterThan(firstCalls);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 惰性：未触发时恒不枚举（Req 12.4、12.5、12.6）
 * ------------------------------------------------------------------ */

describe('11.4/11.5 惰性（Req 12.4、12.5、12.6）', () => {
  it('排行页取数不枚举其它工作区目录，也不枚举旧残留的执行数据目录', async () => {
    makeNewSide();
    makeOldSide();
    const seen: string[] = [];
    const analyzer = analyzerFor({ fsDeps: readFsDeps((p) => seen.push(p)) });

    await analyzer.getMergedRankingRows({ force: true });

    const touched = seen.map((p) => path.normalize(p));
    // 另一个工作区在新旧两处的目录都没被碰过
    expect(touched).not.toContain(path.normalize(newOtherWsDir));
    expect(touched).not.toContain(path.normalize(oldOtherWsDir));
    // `<OldStoreRoot>/<WorkspaceId>` 也没被枚举（那是旧残留维度的范围）
    expect(touched.some((p) => p.startsWith(path.normalize(oldExecDir)))).toBe(false);
    // 当前工作区那两处确实被枚举了（否则上面三条是空断言）
    expect(touched).toContain(path.normalize(newWsDir));
    expect(touched).toContain(path.normalize(oldWsDir));
  });

  it('两个维度各自独立：取 AllKiroSessionTotal 不枚举旧残留目录', async () => {
    makeNewSide();
    makeOldSide();
    const seen: string[] = [];
    const analyzer = analyzerFor({ fsDeps: readFsDeps((p) => seen.push(p)) });

    await analyzer.getAllKiroSessionTotal();

    const touched = seen.map((p) => path.normalize(p));
    expect(touched.some((p) => p.startsWith(path.normalize(oldExecDir)))).toBe(false);
    expect(touched).not.toContain(path.normalize(roots.sessionsRoot));
  });
});
