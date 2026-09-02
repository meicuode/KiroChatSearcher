import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildClassifyRoots,
  buildNewClassifyRoots,
  classifyNewPath,
  CATEGORY_ORDER,
} from '../src/storage/classify';
import { emptyCategoryTotals, scanTree, type CategoryTotals } from '../src/storage/scanner';
import type { StorageCategory } from '../src/storage/types';
import { mkTempDir, mkTree, rmTempDir, type TreeSpec } from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享常量、独立判据（oracle）与生成器
 *
 * 本文件只钉一条属性：**1.x 新布局的分类构成一个划分**。四个断言面各自独立：
 *   (1) 互斥      —— 返回值恒为单值，且恒等于独立重写的定义式
 *   (2) 完备+守恒 —— 真实临时目录树上各分类字节数/文件数之和恒等于总量
 *   (3) 不相交    —— 按分类分组后各组路径集合两两无交集、并集覆盖全部文件
 *   (4) 一致      —— 实现 == 定义式 == 静态陷阱期望表（三方互证）
 * ------------------------------------------------------------------ */

/** `<HomeKiroDir>` 下 1.x 两个统计根的目录名（Requirement 1.1 的路径形态） */
const SESSIONS_SEG = 'sessions';
const SESSION_INDEX_SEG = 'session-index';

/**
 * 会话目录内两个特殊子目录名，与 `<newSessionsRoot>` 的相对段下标。
 *
 * 布局为 `<sessionsRoot>/<WsHash16>/<sessionId>/snapshots/…`，故 `snapshots` /
 * `sub-executions` 只在**相对 sessions 根的第 3 段**（下标 2，即会话目录的直接子级）
 * 这一位置才被识别，且比较是**整段、区分大小写**的。判据取自 design 的规则表与
 * `classifyNewPath` 的 TSDoc，本文件据此独立重写定义式（见 `expectedFromSegs`）。
 */
const SNAPSHOTS_SEG = 'snapshots';
const SUB_EXECUTIONS_SEG = 'sub-executions';
const SESSION_DIR_DEPTH = 2;

/** 1.x 新增的 4 个分类；`otherFiles` 与旧布局共用，故单列。 */
const NEW_CATEGORIES: readonly StorageCategory[] = [
  'newSession',
  'newSnapshots',
  'newSubExecutions',
  'newSessionIndex',
];

/**
 * 只属于 0.9x 旧布局的分类：新布局夹具里恒不应出现。
 * 它们全为 0 即证明扫描走的是注入的 `classify` 而非缺省的 `classifyPath`。
 */
const OLD_ONLY_CATEGORIES: readonly StorageCategory[] = [
  'sessionJson',
  'executionSaves',
  'executionMetadata',
  'unclassified',
  'logs',
  'workspaceStorage',
];

/**
 * 分类规则的**独立实现**：只按「相对 HomeKiroDir 的路径段数组」做首段判断与
 * 下标取段，不使用 `path.relative`、不使用被测模块的 `isUnder` / 段切分函数。
 *
 * 它与 `classifyNewPath` 各自独立地表达 design「Components and Interfaces」的
 * 5 条有序规则 + 该函数 TSDoc 声明的层级判据，因此两者一致即构成差分验证——
 * 尤其能抓住两类错误：
 * - 把整段相等换成 `includes` / `startsWith`（`snapshots-old`、`my-snapshots-backup`
 *   会被误判成 `newSnapshots`）；
 * - 把「只认第 3 段」换成「任意段命中即可」（`<sessionId>/foo/snapshots/…` 会被
 *   误判成 `newSnapshots`）。
 *
 * @param segs 相对 HomeKiroDir 的路径段序列（空数组即 HomeKiroDir 自身）
 */
function expectedFromSegs(segs: readonly string[]): StorageCategory {
  // 规则 1：`<session-index>` 之下（含该目录自身）
  if (segs[0] === SESSION_INDEX_SEG) return 'newSessionIndex';

  // 规则 2~4：`<sessions>` 之下（含该目录自身）
  if (segs[0] === SESSIONS_SEG) {
    const rest = segs.slice(1); // 相对 sessions 根
    if (rest.length > SESSION_DIR_DEPTH) {
      // 只看会话目录的直接子级这一层，整段、区分大小写
      if (rest[SESSION_DIR_DEPTH] === SNAPSHOTS_SEG) return 'newSnapshots';
      if (rest[SESSION_DIR_DEPTH] === SUB_EXECUTIONS_SEG) return 'newSubExecutions';
    }
    // 规则 4 兜住 sessions 根下其余一切（session.json / messages.jsonl / publish*.cursor /
    // 各级目录条目本身）
    return 'newSession';
  }

  // 规则 5：其余（含 `~/.kiro` 下不在统计范围内的 `tasks/`、`extensions/` 等）
  return 'otherFiles';
}

/**
 * 段名池：刻意混入同前缀兄弟（`snapshots` / `snapshots-old` / `my-snapshots-backup`、
 * `sub-executions` / `sub-executions2` / `sub-executions-old`）、大小写变体
 * （`Snapshots` / `SUB-EXECUTIONS`）、真实索引标记名 `.migration-v3`、以 `..` 开头
 * 但合法的目录名 `..bar`，以及会话 id 里含 `snapshots` 字样的形态。
 *
 * 刻意**不**混入 `sessions` / `session-index` 这两个**根目录名**的大小写变体：
 * `path.relative` 在 win32 上按不区分大小写比较前缀，混入后断言会随平台漂移。
 * 而 `snapshots` / `sub-executions` 是段内的严格字符串比较，跨平台确定，故可放心覆盖。
 */
const NAME_POOL = [
  'a',
  'b',
  SESSIONS_SEG,
  SESSION_INDEX_SEG,
  'sessions-old',
  'session-index-old',
  SNAPSHOTS_SEG,
  'snapshots-old',
  'my-snapshots-backup',
  'Snapshots',
  SUB_EXECUTIONS_SEG,
  'sub-executions2',
  'sub-executions-old',
  'SUB-EXECUTIONS',
  'cc5023603866cd91',
  'sess_1f0d',
  'sess_snapshots_1f0d',
  'session.json',
  'messages.jsonl',
  'publish.cursor',
  'publish-sub.cursor',
  '.migration-v3',
  'cc5023603866cd91.jsonl',
  'tasks',
  'extensions',
  '..bar',
] as const;

const segsArb = fc.array(fc.constantFrom(...NAME_POOL), { minLength: 0, maxLength: 8 });

/** 虚构 HomeKiroDir（不落盘，仅供纯函数判定使用）；含空格一路覆盖路径拼接。 */
const FAKE_HOME_KIRO = [
  path.resolve('fixtures', 'kcs-fake-home', '.kiro'),
  path.resolve('fixtures', 'kcs fake home 2', '.kiro'),
];

/* ------------------------------------------------------------------ *
 * 目录树夹具生成器（真实临时目录）
 * ------------------------------------------------------------------ */

type EntryKind =
  // session-index 根下：`<WsHash16>.jsonl`、`.migration-v3` 这类非 jsonl 文件、更深层
  | 'indexJsonl'
  | 'indexMigrationMarker'
  | 'indexNested'
  // 会话目录本体文件
  | 'sessionJson'
  | 'messagesJsonl'
  | 'publishCursor'
  | 'publishSubCursor'
  // 快照 / 子执行
  | 'snapshotFile'
  | 'snapshotNestedSnapshots'
  | 'subExecFile'
  | 'subExecNested'
  // 同前缀兄弟目录陷阱（不该被判为 newSnapshots / newSubExecutions）
  | 'snapshotsOldSibling'
  | 'mySnapshotsBackupSibling'
  | 'subExecutions2Sibling'
  | 'upperSnapshotsDirName'
  // 层级陷阱
  | 'deepSnapshotsUnderFoo'
  | 'snapshotsAsSessionDirName'
  | 'snapshotsWordInSessionId'
  | 'snapshotsWordInSessionIdSnapshot'
  // sessions 根 / 工作区目录的直接子文件、非 hex 工作区目录名
  | 'sessionsRootFile'
  | 'workspaceDirFile'
  | 'nonHexWorkspaceDir'
  // `~/.kiro` 下不在统计范围内的其它位置
  | 'otherKiroTasks'
  | 'otherKiroExtensions'
  | 'homeKiroRootFile'
  | 'sessionsSiblingDir'
  | 'indexSiblingDir';

const ENTRY_KINDS: readonly EntryKind[] = [
  'indexJsonl',
  'indexMigrationMarker',
  'indexNested',
  'sessionJson',
  'messagesJsonl',
  'publishCursor',
  'publishSubCursor',
  'snapshotFile',
  'snapshotNestedSnapshots',
  'subExecFile',
  'subExecNested',
  'snapshotsOldSibling',
  'mySnapshotsBackupSibling',
  'subExecutions2Sibling',
  'upperSnapshotsDirName',
  'deepSnapshotsUnderFoo',
  'snapshotsAsSessionDirName',
  'snapshotsWordInSessionId',
  'snapshotsWordInSessionIdSnapshot',
  'sessionsRootFile',
  'workspaceDirFile',
  'nonHexWorkspaceDir',
  'otherKiroTasks',
  'otherKiroExtensions',
  'homeKiroRootFile',
  'sessionsSiblingDir',
  'indexSiblingDir',
];

/**
 * 每个形态的**期望分类**：与 `expectedFromSegs` 相互独立的第三份陈述（静态表）。
 *
 * 定义式是「按规则算」，这张表是「按人话说清每个陷阱该落哪」。三方（实现 /
 * 定义式 / 本表）同时一致，才排除掉「定义式抄错规则、恰好与实现同错」的可能。
 */
const KIND_EXPECTED: Record<EntryKind, StorageCategory> = {
  indexJsonl: 'newSessionIndex',
  // `.migration-v3` 不是 `.jsonl`，但同样位于索引根之下 → 仍是索引分类
  indexMigrationMarker: 'newSessionIndex',
  indexNested: 'newSessionIndex',
  sessionJson: 'newSession',
  messagesJsonl: 'newSession',
  // `publish*.cursor` 由规则 4 兜住（Requirement 6.2）
  publishCursor: 'newSession',
  publishSubCursor: 'newSession',
  snapshotFile: 'newSnapshots',
  // 快照内容里恰好有同名 `snapshots/` 目录：它确实是快照内容，仍随第 3 段归入 newSnapshots
  snapshotNestedSnapshots: 'newSnapshots',
  subExecFile: 'newSubExecutions',
  subExecNested: 'newSubExecutions',
  // 同前缀兄弟目录：整段比较，恒不误判
  snapshotsOldSibling: 'newSession',
  mySnapshotsBackupSibling: 'newSession',
  subExecutions2Sibling: 'newSession',
  // 大小写变体不是 Kiro 生成的目录（区分大小写匹配，Requirement 14.4）
  upperSnapshotsDirName: 'newSession',
  // 层级陷阱：不在会话目录直接子级 → 不是该会话的快照目录
  deepSnapshotsUnderFoo: 'newSession',
  // 会话目录本身叫 `snapshots`：其直接子文件仍是会话本体
  snapshotsAsSessionDirName: 'newSession',
  // 会话 id 里含 `snapshots` 字样：不影响判定
  snapshotsWordInSessionId: 'newSession',
  snapshotsWordInSessionIdSnapshot: 'newSnapshots',
  sessionsRootFile: 'newSession',
  workspaceDirFile: 'newSession',
  // `<WsHash16>` / `<sessionId>` 两段按位置认定、不做形态校验
  nonHexWorkspaceDir: 'newSession',
  otherKiroTasks: 'otherFiles',
  otherKiroExtensions: 'otherFiles',
  homeKiroRootFile: 'otherFiles',
  // 与两个统计根同前缀的兄弟目录：恒不被吸进统计范围
  sessionsSiblingDir: 'otherFiles',
  indexSiblingDir: 'otherFiles',
};

/** 生成器覆盖到的陷阱形态：覆盖度守卫逐项断言它们真的被采到。 */
const TRAP_KINDS: readonly EntryKind[] = [
  'snapshotsOldSibling',
  'mySnapshotsBackupSibling',
  'subExecutions2Sibling',
  'upperSnapshotsDirName',
  'deepSnapshotsUnderFoo',
  'snapshotsAsSessionDirName',
  'snapshotsWordInSessionId',
  'snapshotsWordInSessionIdSnapshot',
  'snapshotNestedSnapshots',
  'sessionsSiblingDir',
  'indexSiblingDir',
  'nonHexWorkspaceDir',
  'indexMigrationMarker',
];

interface EntrySeed {
  kind: EntryKind;
  bytes: number;
  /** WsHash16 形态的十六进制段（前 2 位会被索引 tag 覆写以保证同夹具内唯一） */
  hex: string;
  /** 会话 id 模板（迁移来的裸 uuid 与 1.x 新建的 `sess_` 前缀各占一半） */
  sid: 'uuid' | 'sess';
  leaf: string;
  /** 快照内容的多级相对路径深度（0~2 级子目录） */
  depth: 0 | 1 | 2;
}

const entryArb = fc.record<EntrySeed>({
  kind: fc.constantFrom(...ENTRY_KINDS),
  bytes: fc.integer({ min: 0, max: 96 }),
  hex: fc.hexaString({ minLength: 16, maxLength: 16 }),
  sid: fc.constantFrom('uuid', 'sess'),
  leaf: fc.constantFrom('a.json', 'b.bin', 'c'),
  depth: fc.constantFrom<0 | 1 | 2>(0, 1, 2),
});

/**
 * 把第 i 个种子落成一条相对 HomeKiroDir 的路径段序列。
 *
 * 每条路径都带索引 tag（工作区目录名前 2 位、会话 id、叶子名），保证同一夹具内
 * 路径两两不同——否则在不区分大小写的文件系统上，`snapshots` 与 `Snapshots`、
 * 同名叶子会被合并成一个条目，使「文件数 = 条目数」的断言随平台漂移。
 *
 * 最深形态为 8 段（`sessions/<ws>/<sid>/snapshots/<hash>/x/y/leaf`），即目录深度 7，
 * 仍在 scanner 默认 `maxDepth = 8` 之内，故夹具恒不产生跳过条目。
 */
function materialize(seed: EntrySeed, i: number): string[] {
  const tag = i.toString(16).padStart(2, '0');
  const ws = (tag + seed.hex).slice(0, 16);
  const sid = seed.sid === 'sess' ? `sess_${tag}f0d` : `${tag}9e1c4a-uuid`;
  const leaf = `${tag}-${seed.leaf}`;
  const snapHash = `h-${tag}`;
  // 快照/子执行内容的多级相对路径（0~2 级），最深处仍在深度预算内
  const rel = (['src', 'deep'] as const).slice(0, seed.depth);

  switch (seed.kind) {
    case 'indexJsonl':
      return [SESSION_INDEX_SEG, `${ws}.jsonl`];
    case 'indexMigrationMarker':
      // 真实文件名为 `.migration-v3`；此处加 tag 仅为夹具内路径唯一（分类不看文件名）
      return [SESSION_INDEX_SEG, `.migration-v3-${tag}`];
    case 'indexNested':
      return [SESSION_INDEX_SEG, `sub-${tag}`, leaf];

    case 'sessionJson':
      return [SESSIONS_SEG, ws, sid, 'session.json'];
    case 'messagesJsonl':
      return [SESSIONS_SEG, ws, sid, 'messages.jsonl'];
    case 'publishCursor':
      return [SESSIONS_SEG, ws, sid, 'publish.cursor'];
    case 'publishSubCursor':
      return [SESSIONS_SEG, ws, sid, 'publish-sub.cursor'];

    case 'snapshotFile':
      return [SESSIONS_SEG, ws, sid, SNAPSHOTS_SEG, snapHash, ...rel, leaf];
    case 'snapshotNestedSnapshots':
      // 快照内容里恰好出现同名目录（被检查点的工程自己有个 snapshots/ 目录）
      return [SESSIONS_SEG, ws, sid, SNAPSHOTS_SEG, snapHash, 'nested', SNAPSHOTS_SEG, leaf];
    case 'subExecFile':
      return [SESSIONS_SEG, ws, sid, SUB_EXECUTIONS_SEG, leaf];
    case 'subExecNested':
      return [SESSIONS_SEG, ws, sid, SUB_EXECUTIONS_SEG, `exec-${tag}`, ...rel, leaf];

    case 'snapshotsOldSibling':
      return [SESSIONS_SEG, ws, sid, 'snapshots-old', leaf];
    case 'mySnapshotsBackupSibling':
      return [SESSIONS_SEG, ws, sid, 'my-snapshots-backup', leaf];
    case 'subExecutions2Sibling':
      return [SESSIONS_SEG, ws, sid, 'sub-executions2', leaf];
    case 'upperSnapshotsDirName':
      return [SESSIONS_SEG, ws, sid, 'Snapshots', leaf];

    case 'deepSnapshotsUnderFoo':
      // 不在会话目录直接子级：`<sessionId>/foo/snapshots/…`
      return [SESSIONS_SEG, ws, sid, `foo-${tag}`, SNAPSHOTS_SEG, leaf];
    case 'snapshotsAsSessionDirName':
      // 会话目录自身叫 `snapshots`（第 2 段），其直接子文件仍是会话本体
      return [SESSIONS_SEG, ws, SNAPSHOTS_SEG, leaf];
    case 'snapshotsWordInSessionId':
      return [SESSIONS_SEG, ws, `sess_snapshots_${tag}`, 'messages.jsonl'];
    case 'snapshotsWordInSessionIdSnapshot':
      return [SESSIONS_SEG, ws, `sess_snapshots_${tag}`, SNAPSHOTS_SEG, snapHash, leaf];

    case 'sessionsRootFile':
      return [SESSIONS_SEG, leaf];
    case 'workspaceDirFile':
      return [SESSIONS_SEG, ws, leaf];
    case 'nonHexWorkspaceDir':
      return [SESSIONS_SEG, `ws-${tag}`, sid, 'session.json'];

    case 'otherKiroTasks':
      return ['tasks', `t-${tag}`, leaf];
    case 'otherKiroExtensions':
      return ['extensions', `pkg-${tag}`, leaf];
    case 'homeKiroRootFile':
      return [leaf];
    case 'sessionsSiblingDir':
      return ['sessions-old', `w-${tag}`, leaf];
    case 'indexSiblingDir':
      return ['session-index-old', leaf];
  }
}

/** 把一条路径段序列写入声明式 TreeSpec（数字叶子 = 字节数） */
function addPath(spec: TreeSpec, segs: string[], bytes: number): void {
  let cur = spec;
  for (const s of segs.slice(0, -1)) {
    if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {} as TreeSpec;
    cur = cur[s] as TreeSpec;
  }
  cur[segs[segs.length - 1]] = bytes;
}

/**
 * 递归列出目录树下的**文件**绝对路径（不含目录条目）。
 *
 * 与被测扫描器各自独立地枚举一遍：夹具的文件集合因此有第二个来源，
 * 「分组并集 = 全部文件」这条断言才不是拿扫描器自证。
 */
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

/* ------------------------------------------------------------------ *
 * Property 6
 * ------------------------------------------------------------------ */

// Feature: kiro-1x-storage-adaptation, Property 6: 新布局分类构成一个划分
// Validates: Requirements 6.1, 6.5
describe('Property 6: 新布局分类构成一个划分', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  // Feature: kiro-1x-storage-adaptation, Property 6: 新布局分类构成一个划分
  // Validates: Requirements 6.1, 6.5
  it('Property 6（互斥 + 与定义式一致）: 任意路径恒被映射到唯一一个已知分类，且恒等于独立重写的 5 条有序规则', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FAKE_HOME_KIRO),
        fc.array(segsArb, { minLength: 1, maxLength: 8 }),
        (home, segsList) => {
          const roots = buildNewClassifyRoots(home);

          const inside = segsList.map((segs) => ({
            full: path.join(home, ...segs),
            expected: expectedFromSegs(segs),
          }));
          // 统计根之外的路径同样必须有归属（全域性），落入 otherFiles
          const outside = [
            { full: path.resolve(home, '..', 'OtherApp', 'x'), expected: 'otherFiles' as const },
            { full: path.resolve(home, '..'), expected: 'otherFiles' as const },
            // HomeKiroDir 自身既不在 sessions 也不在 session-index 之下
            { full: home, expected: 'otherFiles' as const },
          ];
          const cases = [...inside, ...outside];

          for (const c of cases) {
            const got = classifyNewPath(roots, c.full);
            // 全域性：返回值恒为 11 个已知分类之一
            expect(CATEGORY_ORDER).toContain(got);
            // 互斥性：单值返回 ⇒ 一个路径不可能同时属于两类；再断言重复调用稳定
            expect(classifyNewPath(roots, c.full)).toBe(got);
            // 与独立判据一致（整段比较、只认第 3 段、区分大小写）
            expect(got).toBe(c.expected);
          }

          // 划分：按分类装桶后，每个路径恰好属于一个桶，各桶两两不相交且并集覆盖全部路径
          const buckets = new Map<StorageCategory, Set<string>>(
            CATEGORY_ORDER.map((c) => [c, new Set<string>()])
          );
          const all = new Set(cases.map((c) => c.full));
          for (const p of all) buckets.get(classifyNewPath(roots, p))!.add(p);

          let sizeSum = 0;
          const union = new Set<string>();
          for (const c of CATEGORY_ORDER) {
            const bucket = buckets.get(c)!;
            sizeSum += bucket.size;
            for (const p of bucket) union.add(p);
          }
          for (const p of all) {
            expect(CATEGORY_ORDER.filter((c) => buckets.get(c)!.has(p))).toHaveLength(1);
          }
          // 两两不相交 ⟺ 各桶大小之和等于并集大小
          expect(sizeSum).toBe(union.size);
          expect(union).toEqual(all);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 6: 新布局分类构成一个划分
  // Validates: Requirements 6.1, 6.5
  it('Property 6（完备 + 守恒 + 不相交）: 真实目录树上 Σ 各分类字节数 === totalBytes、Σ 文件数 === totalFiles，且各分类路径集合两两不相交', async () => {
    base = mkTempDir('kcs-newlayout-prop-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { minLength: 1, maxLength: 14 }), async (seeds) => {
        // `homeKiroDir` 的替身：其下建出 `sessions/`、`session-index/` 与若干不在统计
        // 范围内的兄弟目录，形态与实测 `~/.kiro` 一致
        const home = path.join(fixtureBase, `r${runSeq++}`);
        const spec: TreeSpec = {};
        const expectedTotals: CategoryTotals = emptyCategoryTotals();
        const placed: Array<{ full: string; kind: EntryKind; expected: StorageCategory }> = [];

        seeds.forEach((seed, i) => {
          const segs = materialize(seed, i);
          addPath(spec, segs, seed.bytes);
          const expected = expectedFromSegs(segs);
          // 三方互证之一：定义式的结论必须与静态陷阱期望表逐条吻合
          expect(expected).toBe(KIND_EXPECTED[seed.kind]);
          const agg = expectedTotals[expected];
          agg.bytes += seed.bytes;
          agg.files += 1;
          placed.push({ full: path.join(home, ...segs), kind: seed.kind, expected });
        });
        mkTree(home, spec);

        const roots = buildNewClassifyRoots(home);
        const classified: string[] = [];
        const res = await scanTree(home, {
          // `classify` 提供时优先于 `roots`，缺省分类器一次都不会被调用；
          // 这里给一个与夹具无关的旧根，若实现误用它，旧布局分类会立刻非零。
          roots: buildClassifyRoots(path.join(fixtureBase, '__unused-old-userdata__')),
          classify: (p) => {
            classified.push(p);
            return classifyNewPath(roots, p);
          },
        });

        // (1) 守恒：各分类之和恒等于总量（Requirement 6.5）
        let sumBytes = 0;
        let sumFiles = 0;
        for (const c of CATEGORY_ORDER) {
          sumBytes += res.totals[c].bytes;
          sumFiles += res.totals[c].files;
        }
        expect(sumBytes).toBe(res.totalBytes);
        expect(sumFiles).toBe(res.totalFiles);

        // (2) 完备：夹具深度与可读性均在预算内 ⇒ 无跳过条目，每个文件都被计入
        expect(res.skippedCount).toBe(0);
        expect(res.partial).toBe(false);
        expect(res.totalFiles).toBe(seeds.length);

        // (3) 每个文件都落入独立定义式预期的那一个分类（Requirement 6.1）
        expect(res.totals).toEqual(expectedTotals);

        // (4) 旧布局专属分类恒为 0：注入的 `classify` 确实优先于 `roots`
        for (const c of OLD_ONLY_CATEGORIES) {
          expect(res.totals[c]).toEqual({ bytes: 0, files: 0 });
        }

        // (5) 分类器恰好被每个文件各调用一次（目录条目不参与计量）
        const files = listFiles(home);
        expect(files).toHaveLength(seeds.length);
        expect([...classified].sort()).toEqual(files);

        // (6) 路径集合两两不相交、并集等于全部文件：对夹具里每个文件独立调用分类器后分组
        const groups = new Map<StorageCategory, Set<string>>(
          CATEGORY_ORDER.map((c) => [c, new Set<string>()])
        );
        for (const f of files) groups.get(classifyNewPath(roots, f))!.add(f);

        const union = new Set<string>();
        let groupSizeSum = 0;
        for (const a of CATEGORY_ORDER) {
          const ga = groups.get(a)!;
          groupSizeSum += ga.size;
          for (const f of ga) union.add(f);
          for (const b of CATEGORY_ORDER) {
            if (a === b) continue;
            const gb = groups.get(b)!;
            for (const f of ga) expect(gb.has(f)).toBe(false);
          }
        }
        expect(groupSizeSum).toBe(union.size);
        expect(union).toEqual(new Set(files));
        // 分组的文件数分布与扫描结果逐分类相等 ⇒ 扫描侧与分类侧对同一文件同一答案
        for (const c of CATEGORY_ORDER) {
          expect(groups.get(c)!.size).toBe(res.totals[c].files);
        }

        // (7) 三方互证之二：实现对每条夹具路径的结论 == 定义式 == 静态陷阱期望表
        for (const p of placed) {
          expect(classifyNewPath(roots, p.full)).toBe(p.expected);
          expect(classifyNewPath(roots, p.full)).toBe(KIND_EXPECTED[p.kind]);
        }
      }),
      // 真实临时目录夹具（每轮建一棵含 1~14 个文件的目录树 + 一次完整扫描）属 IO 密集：
      // 按 design 测试策略对真实 fs 夹具的放宽取 50 轮，并给出显式宽松超时。
      { numRuns: 50 }
    );
  }, 60_000);

  // Feature: kiro-1x-storage-adaptation, Property 6: 新布局分类构成一个划分
  // Validates: Requirements 6.1, 6.5
  it('Property 6: 生成器覆盖全部目录形态、4 个新分类与 otherFiles、以及全部陷阱形态（覆盖度守卫）', () => {
    const samples = fc.sample(entryArb, 400);

    // ① 全部形态都被采到（否则某个陷阱只是"没被反驳过"）
    const kinds = new Set(samples.map((s) => s.kind));
    for (const k of ENTRY_KINDS) expect([...kinds], `形态 ${k} 未被采到`).toContain(k);

    // ② 陷阱形态逐项在场
    for (const k of TRAP_KINDS) expect([...kinds], `陷阱形态 ${k} 未被采到`).toContain(k);

    // ③ 4 个新分类与 otherFiles 都被真实产出
    const produced = new Set(samples.map((s, i) => expectedFromSegs(materialize(s, i))));
    for (const c of [...NEW_CATEGORIES, 'otherFiles' as StorageCategory]) {
      expect([...produced], `分类 ${c} 未被产出`).toContain(c);
    }
    // 新布局夹具恒不产出旧布局专属分类
    for (const c of OLD_ONLY_CATEGORIES) expect([...produced]).not.toContain(c);

    // ④ 会话 id 的两种形态（迁移来的裸 uuid 与 1.x 新建的 `sess_` 前缀）都被采到
    expect(new Set(samples.map((s) => s.sid))).toEqual(new Set(['uuid', 'sess']));

    // ⑤ 快照内容的多级相对路径深度 0/1/2 都被采到（深层嵌套覆盖）
    expect(new Set(samples.map((s) => s.depth))).toEqual(new Set([0, 1, 2]));

    // ⑥ 纯函数一路的段名池覆盖同前缀兄弟与大小写变体
    const pooled = new Set(fc.sample(segsArb, 400).flat());
    for (const n of [
      SNAPSHOTS_SEG,
      'snapshots-old',
      'my-snapshots-backup',
      'Snapshots',
      SUB_EXECUTIONS_SEG,
      'sub-executions2',
      'SUB-EXECUTIONS',
      'sessions-old',
      'session-index-old',
      '.migration-v3',
      'sess_snapshots_1f0d',
      '..bar',
    ]) {
      expect([...pooled], `段名 ${n} 未被采到`).toContain(n);
    }
  });
});
