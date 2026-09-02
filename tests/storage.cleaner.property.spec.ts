import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import {
  dropArchiveEntries,
  hash32,
  listArchiveEntries,
  workspaceIdCandidates,
  __clearCreditCacheForTest,
  type ArchiveInfo,
} from '../src/credits';
import { buildClassifyRoots, METADATA_BUCKET_KEY, SAVES_BUCKET_KEY } from '../src/storage/classify';
import { StorageAnalyzer, type AnalyzerFsDeps } from '../src/storage/analyzer';
import { encodeWorkspaceKeys, type PathResolverDeps } from '../src/paths';
import { MANIFEST_FILENAME } from '../src/storage/orphan';
import {
  assertDeletable,
  DELETE_REJECT_REASONS,
  SessionCleaner,
  type CleanerDeps,
  type CleanerRoots,
  type CleanupMode,
  type DeleteRejectReason,
  type SessionLineage,
} from '../src/storage/cleaner';
import {
  mkTempDir,
  recordingCleanerFs,
  rmTempDir,
  type FaultInjection,
  type MemTree,
} from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享夹具与生成器
 *
 * 本文件是清理侧属性测试的承载文件（design 的测试文件划分：Property 14(b)、
 * 27、28、29、30、31）。因此路径夹具、路径向量生成器与 `ArchiveInfo` 生成器
 * 一律 export，供后续任务（12.2 / 12.7 / 12.8 / 12.9 / 12.10）直接复用——
 * 那些属性要断言的「unlink 实参 ⊆ plan.files」「调用面白名单」等都需要与
 * `assertDeletable` **同一套**路径根，否则两侧对「什么算合法存档」的口径会漂移。
 * ------------------------------------------------------------------ */

/**
 * 夹具根。用 `path.resolve(path.sep + …)` 而非硬编码盘符：Windows 上得到
 * 当前盘的绝对路径、POSIX 上得到 `/kcs-cleaner-fixture`，两个平台都是绝对路径，
 * 于是 `path.resolve` 不会掺入 cwd 前缀（那会让「越出 StoreRoot」的向量在
 * 某些 cwd 下意外落回 StoreRoot 之内）。全程只做字符串与路径计算，不落盘。
 */
const FIXTURE_BASE = path.resolve(path.sep + 'kcs-cleaner-fixture');

/** 当前工作区与另一个工作区的 fsPath：只作 `hash32` 的输入，不需要真实存在。 */
const WORKSPACE_PATH = 'D:\\Projects\\Demo';
const OTHER_WORKSPACE_PATH = 'D:\\Projects\\Other';

function buildFixture() {
  const userDataDir = FIXTURE_BASE;
  const storeRoot = path.join(userDataDir, 'User', 'globalStorage', 'kiro.kiroagent');
  const sessionsRoot = path.join(storeRoot, 'workspace-sessions');
  const savesBucket = hash32(SAVES_BUCKET_KEY);
  const metadataBucket = hash32(METADATA_BUCKET_KEY);
  const workspaceId = hash32(WORKSPACE_PATH);
  const otherWorkspaceId = hash32(OTHER_WORKSPACE_PATH);
  // EncodedKey 的具体形态与路径校验无关，取两个固定的 base64url 串即可
  const sessionDir = path.join(sessionsRoot, 'RDpcUHJvamVjdHNcRGVtbw__');
  const otherSessionDir = path.join(sessionsRoot, 'RDpcUHJvamVjdHNcT3RoZXI_');
  return {
    userDataDir,
    storeRoot,
    sessionsRoot,
    savesBucket,
    metadataBucket,
    workspaceId,
    otherWorkspaceId,
    sessionDir,
    otherSessionDir,
    /** 当前工作区的 ExecutionSavesBucket 目录 */
    savesDir: path.join(storeRoot, workspaceId, savesBucket),
    /** 当前工作区的 ExecutionMetadataBucket 目录（另一个桶，恒不可删） */
    metadataDir: path.join(storeRoot, workspaceId, metadataBucket),
    /** 另一个工作区的同名桶（恒不可删） */
    otherSavesDir: path.join(storeRoot, otherWorkspaceId, savesBucket),
    manifestPath: path.join(sessionsRoot, 'RDpcUHJvamVjdHNcRGVtbw__', MANIFEST_FILENAME),
  };
}

export const CLEANER_FIXTURE = buildFixture();

/** 传给 `assertDeletable` / `SessionCleaner` 的四个路径根。 */
export const CLEANER_ROOTS: CleanerRoots = {
  storeRoot: CLEANER_FIXTURE.storeRoot,
  savesBucket: CLEANER_FIXTURE.savesBucket,
  workspaceId: CLEANER_FIXTURE.workspaceId,
  sessionDir: CLEANER_FIXTURE.sessionDir,
};

/** 当前工作区 ExecutionSavesBucket 下的存档路径。 */
export function archivePath(name: string): string {
  return path.join(CLEANER_FIXTURE.savesDir, name);
}

/** 当前工作区 WorkspaceSessionDir 下的 SessionFile 路径。 */
export function sessionFilePath(sessionId: string): string {
  return path.join(CLEANER_FIXTURE.sessionDir, `${sessionId}.json`);
}

/** 拒绝原因的五个取值：非 null 返回值恒取自这里。 */
export const REJECT_REASON_VALUES: readonly DeleteRejectReason[] = Object.values(
  DELETE_REJECT_REASONS
);

/**
 * 0.9x 判定（即不传 `newSessionDir` 的 `assertDeletable`）可能产出的拒绝原因。
 *
 * 与 `REJECT_REASON_VALUES` 的差是 `outsideNewSessionDir` —— 那是任务 14.2 为 1.x
 * 目录型会话新增的围栏，只由 1.x 分支与 `assertRemovableDir` 产出。分开列出使
 * 「0.9x 判定的产出集合」仍然是一个可精确比对的闭集合。
 */
export const LEGACY_REJECT_REASON_VALUES: readonly DeleteRejectReason[] = [
  DELETE_REJECT_REASONS.dotDot,
  DELETE_REJECT_REASONS.outsideStoreRoot,
  DELETE_REJECT_REASONS.manifest,
  DELETE_REJECT_REASONS.notAllowed,
  DELETE_REJECT_REASONS.symlink,
];

/* ---------------------------- 基础生成器 ---------------------------- */

const HEX_CHARS = '0123456789abcdef'.split('');

/** `hash32` 的产物形态：小写十六进制 32 位。 */
export const hex32Arb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...HEX_CHARS), { minLength: 32, maxLength: 32 })
  .map((cs) => cs.join(''));

/**
 * **不**是小写 hex32 的 basename：大写变体、31 位、33 位、含非十六进制字符。
 * 大写变体尤其重要——`hash32` 只产出小写，大写同形串不是 Kiro 生成的存档名。
 */
export const nonHex32NameArb: fc.Arbitrary<string> = fc.oneof(
  hex32Arb.map((h) => h.toUpperCase()),
  hex32Arb.map((h) => h.slice(0, 31)),
  hex32Arb.map((h) => `${h}a`),
  fc
    .tuple(hex32Arb, fc.integer({ min: 0, max: 31 }), fc.constantFrom('g', 'z', 'G', '_', '-'))
    .map(([h, i, c]) => h.slice(0, i) + c + h.slice(i + 1))
);

/**
 * sessionId 池。含 `sessions-old` 与 `a.b`：前者的 stem 只是「以 sessions 开头」
 * 而非等于 `sessions`，必须放行；后者验证 stem 里带点也照样是合法 SessionFile。
 * 恒不含 `sessions` 及其大小写变体——那类路径由清单向量单独覆盖。
 */
export const sessionIdArb: fc.Arbitrary<string> = fc.constantFrom(
  's1',
  'abc-123',
  '9f8e7d6c',
  'session-01',
  'sessions-old',
  'a.b',
  '会话1'
);

/** 同一路径的分隔符变体：`/` 在两个平台都是合法分隔符，规范化后应等价。 */
function sepVariants(arb: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return arb.chain((p) => fc.constantFrom(p, p.split(path.sep).join('/')));
}

/* ---------------------------- 路径向量 ---------------------------- */

/** 通过向量一：ExecutionSavesBucket 下 basename 为小写 hex32 的存档（含子目录形态）。 */
export const passArchivePathArb: fc.Arbitrary<string> = sepVariants(
  fc.oneof(
    { weight: 4, arbitrary: hex32Arb.map(archivePath) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.constantFrom('sub', 'a'), hex32Arb)
        .map(([d, n]) => path.join(CLEANER_FIXTURE.savesDir, d, n)),
    }
  )
);

/** 通过向量二：WorkspaceSessionDir 下的 `<sessionId>.json`。 */
export const passSessionFilePathArb: fc.Arbitrary<string> = sepVariants(
  sessionIdArb.map(sessionFilePath)
);

export const passPathArb: fc.Arbitrary<string> = fc.oneof(
  passArchivePathArb,
  passSessionFilePathArb
);

const S = path.sep;

/**
 * 拒绝向量一：原始形式含 `..` 路径段。
 *
 * 刻意用字符串拼接而非 `path.join`——后者会当场把 `..` 消掉，拼出来的就不再是
 * 待校验的原始形式了。前两条的 `..` 在**中间**且抵消后仍落在 StoreRoot 之内
 * （第一条抵消后恰是一条合法存档），因此它们只可能被第 ① 步挡住：这正是
 * 「① 必须在 `path.resolve` 之前」的可观测证据（Req 14.19）。
 */
export const dotDotPathArb: fc.Arbitrary<string> = fc.oneof(
  hex32Arb.map((n) => [CLEANER_FIXTURE.savesDir, 'sub', '..', n].join(S)),
  sessionIdArb.map((id) => [CLEANER_FIXTURE.sessionDir, 'nested', '..', `${id}.json`].join(S)),
  hex32Arb.map((n) => [CLEANER_FIXTURE.savesDir, '..', '..', '..', '..', 'evil', n].join(S)),
  hex32Arb.map((n) => ['..', n].join(S))
);

/** 拒绝向量二：规范化后落在 StoreRoot 之外（含裸前缀相同的兄弟目录）。 */
export const outsideStoreRootPathArb: fc.Arbitrary<string> = fc.oneof(
  hex32Arb.map((n) => path.join(CLEANER_FIXTURE.userDataDir, 'logs', n)),
  hex32Arb.map((n) =>
    path.join(
      path.dirname(CLEANER_FIXTURE.storeRoot),
      'kiro.kiroagent-old',
      CLEANER_FIXTURE.workspaceId,
      CLEANER_FIXTURE.savesBucket,
      n
    )
  ),
  hex32Arb.map((n) => path.join(path.resolve(S), 'tmp', n)),
  sessionIdArb.map((id) =>
    path.join(CLEANER_FIXTURE.userDataDir, 'User', 'workspaceStorage', `${id}.json`)
  )
);

/** 拒绝向量三：指向 SessionManifest 本身（含大小写变体——Windows 上是同一个文件）。 */
export const manifestPathArb: fc.Arbitrary<string> = fc
  .constantFrom('sessions.json', 'Sessions.json', 'SESSIONS.JSON', 'sessions.JSON', 'SeSsIoNs.jSoN')
  .map((n) => path.join(CLEANER_FIXTURE.sessionDir, n));

/** 拒绝向量四：在 StoreRoot 之内但不匹配两类白名单位置。 */
export const notAllowedPathArb: fc.Arbitrary<string> = fc.oneof(
  // 其它桶（ExecutionMetadataBucket）
  hex32Arb.map((n) => path.join(CLEANER_FIXTURE.metadataDir, n)),
  // 其它工作区目录下的同名桶
  hex32Arb.map((n) => path.join(CLEANER_FIXTURE.otherSavesDir, n)),
  // 桶目录自身：本模块不做任何目录操作
  fc.constant(CLEANER_FIXTURE.savesDir),
  // basename 不是小写 hex32
  nonHex32NameArb.map(archivePath),
  // WorkspaceSessionDir 的**子目录**：SessionFile 判定用 dirname 相等，子目录恒被拒
  fc
    .tuple(fc.constantFrom('nested', 'backup'), sessionIdArb)
    .map(([d, id]) => path.join(CLEANER_FIXTURE.sessionDir, d, `${id}.json`)),
  // 会话目录下的非 .json 文件
  sessionIdArb.map((id) => path.join(CLEANER_FIXTURE.sessionDir, `${id}.txt`)),
  // 其它工作区的 WorkspaceSessionDir
  sessionIdArb.map((id) => path.join(CLEANER_FIXTURE.otherSessionDir, `${id}.json`)),
  // StoreRoot / SessionsRoot 的直接子文件
  sessionIdArb.map((id) => path.join(CLEANER_FIXTURE.storeRoot, `${id}.json`)),
  sessionIdArb.map((id) => path.join(CLEANER_FIXTURE.sessionsRoot, `${id}.json`))
);

/** 全部路径形态：iff 断言在这上面跑（符号链接标记单独随机）。 */
export const anyPathArb: fc.Arbitrary<string> = fc.oneof(
  passArchivePathArb,
  passSessionFilePathArb,
  dotDotPathArb,
  outsideStoreRootPathArb,
  manifestPathArb,
  notAllowedPathArb
);

export type VectorKind =
  | 'pass-archive'
  | 'pass-session-file'
  | 'reject-dot-dot'
  | 'reject-outside-store-root'
  | 'reject-manifest'
  | 'reject-not-allowed'
  | 'reject-symlink';

export interface DeletableVector {
  path: string;
  isSymbolicLink: boolean;
  kind: VectorKind;
  /** 期望的判定结果：`null` 表示放行，否则为期望的拒绝原因 */
  expected: DeleteRejectReason | null;
}

const vec =
  (kind: VectorKind, expected: DeleteRejectReason | null, isSymbolicLink = false) =>
  (p: string): DeletableVector => ({ path: p, isSymbolicLink, kind, expected });

/**
 * 带标签的向量：两类通过 + 五类拒绝。
 *
 * 每一类的期望**原因**是确定的（判定五步先命中者胜），因此各类向量都刻意构造成
 * 只触发自己那一步：例如「其它桶」向量恒不含 `..`、恒落在 StoreRoot 之内，
 * 「符号链接」向量则取一条本来会放行的路径再置上链接标记。
 */
export const deletableVectorArb: fc.Arbitrary<DeletableVector> = fc.oneof(
  passArchivePathArb.map(vec('pass-archive', null)),
  passSessionFilePathArb.map(vec('pass-session-file', null)),
  dotDotPathArb.map(vec('reject-dot-dot', DELETE_REJECT_REASONS.dotDot)),
  outsideStoreRootPathArb.map(
    vec('reject-outside-store-root', DELETE_REJECT_REASONS.outsideStoreRoot)
  ),
  manifestPathArb.map(vec('reject-manifest', DELETE_REJECT_REASONS.manifest)),
  notAllowedPathArb.map(vec('reject-not-allowed', DELETE_REJECT_REASONS.notAllowed)),
  passPathArb.map(vec('reject-symlink', DELETE_REJECT_REASONS.symlink, true))
);

/* ------------------- ArchiveInfo 生成器（供 12.2 等复用） ------------------- */

/** 属性测试里作为「目标会话」的 sessionId。 */
export const TARGET_SESSION_ID = 's1';

/**
 * `chatSessionId` 生成器：正常值 / 大小写变体 / 相似 id / `null` / 空串 / 纯空白。
 * 后三类属于无归因，恒不进任何会话的清理计划；大小写变体与相似 id 用来钉住
 * 「区分大小写严格相等」这一条。
 */
export const chatSessionIdArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 5, arbitrary: fc.constant(TARGET_SESSION_ID) },
  { weight: 3, arbitrary: fc.constantFrom('S1', 's10', 's1x', ' s1', 's2') },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 1, arbitrary: fc.constantFrom(' ', '\t', ' \n\t ') }
);

/** `size` 生成器：正常值 / 0 / NaN / 负数（后两类按 0 计但仍算一个文件）。 */
export const archiveSizeArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 1_000_000 }) },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(Number.NaN) },
  { weight: 1, arbitrary: fc.integer({ min: -1_000_000, max: -1 }) }
);

/** 单条存档：路径恒在当前工作区 ExecutionSavesBucket 下，`name` 为 hex32。 */
export const archiveInfoArb: fc.Arbitrary<ArchiveInfo> = fc
  .record({ name: hex32Arb, size: archiveSizeArb, chatSessionId: chatSessionIdArb })
  .map(({ name, size, chatSessionId }) => ({
    path: archivePath(name),
    name,
    size,
    chatSessionId,
  }));

/** 存档集合：按 `name` 去重（同一目录下文件名唯一）。 */
export const archivesArb: fc.Arbitrary<ArchiveInfo[]> = fc.uniqueArray(archiveInfoArb, {
  selector: (a) => a.name,
  maxLength: 8,
});

/* ------------------------------------------------------------------ *
 * 测试侧独立判据
 * ------------------------------------------------------------------ */

/** 原始形式是否含 `..` 路径段（两种分隔符都算分隔符，与 Req 8.2 的按段比较一致）。 */
function hasDotDotSegment(raw: string): boolean {
  return raw.split(/[\\/]+/).includes('..');
}

/** 按**路径段**边界判断归属（含相等）：裸字符串前缀比较会把 `x-old` 误判为 `x` 的子项。 */
function withinSegmentBoundary(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(/[\\/]+/).filter((s) => s.length > 0)[0] !== '..';
}

const TEST_HEX32 = /^[0-9a-f]{32}$/;
const eqNoCase = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * 五个条件的合取，**独立**按验收标准原文重写（不复用 `cleaner.ts` / `classify.ts`
 * 的内部函数），否则实现与断言会一起犯同一个错。
 *
 * 条件顺序在这里无关紧要——这是个合取式，只判「通不通过」；原因取值的确定性
 * 由带标签的向量单独断言。
 */
export function isDeletableByCriteria(
  roots: CleanerRoots,
  raw: string,
  isSymbolicLink: boolean
): boolean {
  // ① 原始形式不含 `..` 路径段
  if (hasDotDotSegment(raw)) return false;

  const p = path.resolve(raw);
  const storeRoot = path.resolve(roots.storeRoot);
  // ② 规范化后位于 StoreRoot 之内
  if (!withinSegmentBoundary(storeRoot, p)) return false;

  const sessionDir = path.resolve(roots.sessionDir);
  // ③ 不等于 SessionManifest（大小写归一：Windows 上 Sessions.json 是同一个文件）
  if (eqNoCase(p, path.join(sessionDir, MANIFEST_FILENAME))) return false;

  // ④ 匹配两类白名单位置之一
  const savesDir = path.join(storeRoot, roots.workspaceId, roots.savesBucket);
  const base = path.basename(p);
  const asArchive =
    withinSegmentBoundary(savesDir, p) && !eqNoCase(p, savesDir) && TEST_HEX32.test(base);
  const stem = /^(.+)\.json$/.exec(base)?.[1];
  const asSessionFile =
    path.dirname(p) === sessionDir && stem !== undefined && stem.toLowerCase() !== 'sessions';
  if (!asArchive && !asSessionFile) return false;

  // ⑤ 不是符号链接
  return !isSymbolicLink;
}

/* ------------------------------------------------------------------ *
 * Property 28
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 28: 路径边界校验的拒绝集合
// Validates: Requirements 8.6, 14.19
//
// 本任务只覆盖属性的前半——`assertDeletable` 的放行集合恒等于五条件的合取，
// 且拒绝原因恒取自可枚举的五个取值。后半「被拒绝路径恒进 CleanupResult.failed[]
// 且恒不被 unlink」依赖 `run()`（任务 12.6），由 Property 27（任务 12.2，unlink
// 实参集合的封闭性）与 Property 30（任务 12.8，三类计数守恒）在 `run()` 就绪后覆盖。
describe('Property 28: 路径边界校验的拒绝集合', () => {
  it('Property 28: 放行当且仅当五个条件同时满足，且拒绝原因恒取自五个取值', () => {
    fc.assert(
      fc.property(anyPathArb, fc.boolean(), (raw, isSymbolicLink) => {
        const actual = assertDeletable(CLEANER_ROOTS, raw, { isSymbolicLink });

        // 当且仅当：两侧独立判据恒等价
        expect(actual === null).toBe(isDeletableByCriteria(CLEANER_ROOTS, raw, isSymbolicLink));

        // 拒绝集合可枚举：非 null 返回值恒是五个取值之一
        if (actual !== null) expect(REJECT_REASON_VALUES).toContain(actual);

        // 纯函数：同输入恒同输出
        expect(assertDeletable(CLEANER_ROOTS, raw, { isSymbolicLink })).toBe(actual);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 28: 五类拒绝向量各自给出确定的原因，两类通过向量恒放行', () => {
    fc.assert(
      fc.property(deletableVectorArb, (v) => {
        expect(assertDeletable(CLEANER_ROOTS, v.path, { isSymbolicLink: v.isSymbolicLink })).toBe(
          v.expected
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 28: 生成器覆盖两类通过向量与五类拒绝向量（覆盖度守卫）', () => {
    const kinds = new Set(fc.sample(deletableVectorArb, 400).map((v) => v.kind));
    const expected: VectorKind[] = [
      'pass-archive',
      'pass-session-file',
      'reject-dot-dot',
      'reject-outside-store-root',
      'reject-manifest',
      'reject-not-allowed',
      'reject-symlink',
    ];
    for (const k of expected) expect([...kinds]).toContain(k);
    // 五个拒绝原因也必须都被实际触发过一次，否则「拒绝集合可枚举」是空话
    const reasons = new Set(
      fc
        .sample(deletableVectorArb, 400)
        .map((v) => assertDeletable(CLEANER_ROOTS, v.path, { isSymbolicLink: v.isSymbolicLink }))
        .filter((r): r is DeleteRejectReason => r !== null)
    );
    // 比对的是**0.9x 判定可能产出的**原因集合，而不是 `DELATE_REJECT_REASONS` 的全部取值：
    // 任务 14.2 为 1.x 目录型会话新增了 `outsideNewSessionDir`，它只可能由
    // `assertDeletable` 的 1.x 分支（调用方显式传 `newSessionDir`）与 `assertRemovableDir`
    // 产出。本组向量全部不传该字段，故那个取值在这里恒不出现——这正是「1.x 分支对既有
    // 0.9x 判定零影响」的另一种表述，因此这条断言仍然是精确等值而非放宽。
    expect([...reasons].sort()).toEqual([...LEGACY_REJECT_REASON_VALUES].sort());
    // 全集与 0.9x 子集的差恰好是那一个新取值（把「新增了几个」也钉住）
    expect(
      REJECT_REASON_VALUES.filter((r) => !LEGACY_REJECT_REASON_VALUES.includes(r))
    ).toEqual([DELETE_REJECT_REASONS.outsideNewSessionDir]);
  });
});

/* ------------------------------------------------------------------ *
 * Property 27
 *
 * 复用文件头的共享夹具与生成器（`CLEANER_ROOTS` / `CLEANER_FIXTURE` /
 * `archivePath` / `sessionFilePath` / `archivesArb` / `hex32Arb` /
 * `archiveSizeArb` / `TARGET_SESSION_ID`），因此计划侧与 `assertDeletable`
 * （Property 28）共用**同一套**路径根——两侧对「什么算合法存档位置」的口径不漂移。
 * ------------------------------------------------------------------ */

/** SessionManifest 的绝对路径（= `<sessionDir>/sessions.json`）。 */
const MANIFEST_PATH = CLEANER_FIXTURE.manifestPath;

/** 目标会话在当前工作区 WorkspaceSessionDir 下的 SessionFile 路径。 */
const TARGET_SESSION_FILE = sessionFilePath(TARGET_SESSION_ID);

/** 比较键：与 cleaner.ts 的 `cmpKey` 同口径（resolve + 小写），跨平台稳定。 */
const keyOf = (p: string): string => path.resolve(p).toLowerCase();

/** `hasOwner` 的测试侧独立复现：非空且非纯空白。 */
const owns = (id: string | null | undefined): boolean =>
  typeof id === 'string' && id.trim().length > 0;

/** 缺省自动确认（不含 ReferencedArchive），供计划侧与关闭性主用例复用。 */
const autoConfirm: CleanerDeps['confirm'] = async () => 'confirm';

/**
 * 组装一个 `SessionCleaner`。`archives` / `lineages` 由生成器给出，`fs` 注入
 * 记录型可写内存 fs（`recordingCleanerFs`），`confirm` 缺省自动放行。审计与失效
 * 均为空操作——本属性只关心计划集合与 `unlink` 调用面。
 */
function makeCleaner(
  rec: ReturnType<typeof recordingCleanerFs>,
  archives: readonly ArchiveInfo[],
  lineages: readonly SessionLineage[],
  confirm: CleanerDeps['confirm'] = autoConfirm
): SessionCleaner {
  const deps: CleanerDeps = {
    fs: rec.deps,
    audit: () => {},
    confirm,
    archives: () => archives,
    invalidate: () => {},
    roots: CLEANER_ROOTS,
    lineages: () => lineages,
  };
  return new SessionCleaner(deps);
}

/**
 * 由存档集合构造内存树：每条存档路径都落一个文件（`stat` 才会成功、条目才进计划），
 * 外加空数组的 SessionManifest 与目标会话的 SessionFile（供 full 模式并入 files）。
 */
function buildTree(archives: readonly ArchiveInfo[]): MemTree {
  const tree: MemTree = {};
  for (const a of archives) tree[a.path] = { size: a.size };
  tree[MANIFEST_PATH] = '[]';
  tree[TARGET_SESSION_FILE] = 'session-body';
  return tree;
}

/**
 * 「被其它现存会话引用」的测试侧独立复现——按 design 的定义原文重写，不复用
 * `cleaner.ts` 的内部函数：某个 `S ≠ target` 的 history executionId 经 `hash32`
 * 反查到一条 `chatSessionId === target` 的存档时成立，此时 target 的**全部**存档整批
 * 计入 referenced。
 */
function isReferencedByOthers(
  sessionId: string,
  archives: readonly ArchiveInfo[],
  lineages: readonly SessionLineage[]
): boolean {
  if (lineages.length === 0) return false;
  const byName = new Map<string, ArchiveInfo>();
  for (const a of archives) byName.set(a.name, a);
  for (const lin of lineages) {
    if (lin.sessionId === sessionId) continue;
    for (const eid of lin.historyExecutionIds) {
      if (!eid) continue;
      const ent = byName.get(hash32(eid));
      if (ent && owns(ent.chatSessionId) && ent.chatSessionId === sessionId) return true;
    }
  }
  return false;
}

interface PlanScenario {
  archives: ArchiveInfo[];
  mode: CleanupMode;
  lineages: SessionLineage[];
}

/**
 * 计划侧场景生成器：一组存档 + 模式 + 可选的「其它会话引用」。
 *
 * `refEid !== null` 时追加一条 `chatSessionId === 目标` 且 `name === hash32(refEid)`
 * 的存档，并给出一条 `other-session` 的 lineage 引用该 executionId——于是
 * `isReferencedByOthers` 成立、目标存档整批进 referenced，`files` 与 `referenced`
 * 的不相交断言才有真正的非空两侧可比。
 */
const planScenarioArb: fc.Arbitrary<PlanScenario> = fc
  .record({
    archives: archivesArb,
    mode: fc.constantFrom<CleanupMode>('attachment', 'full'),
    refEid: fc.option(
      fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
      { nil: null }
    ),
  })
  .map(({ archives, mode, refEid }) => {
    let all = archives;
    let lineages: SessionLineage[] = [];
    if (refEid !== null) {
      const refName = hash32(refEid);
      if (!all.some((a) => a.name === refName)) {
        all = [
          ...all,
          {
            path: archivePath(refName),
            name: refName,
            size: 4096,
            chatSessionId: TARGET_SESSION_ID,
          },
        ];
      }
      lineages = [{ sessionId: 'other-session', historyExecutionIds: [refEid] }];
    }
    return { archives: all, mode, lineages };
  });

/** 定义式集合：files 与 referenced 的期望路径键集合，独立于 `plan()` 计算。 */
function expectedSets(sc: PlanScenario): { fileKeys: Set<string>; refKeys: Set<string> } {
  const targetOwned = sc.archives.filter(
    (a) => owns(a.chatSessionId) && a.chatSessionId === TARGET_SESSION_ID
  );
  const referenced = isReferencedByOthers(TARGET_SESSION_ID, sc.archives, sc.lineages);
  const archiveFiles = referenced ? [] : targetOwned;
  const referencedFiles = referenced ? targetOwned : [];
  const fileKeys = new Set(archiveFiles.map((a) => keyOf(a.path)));
  if (sc.mode === 'full') fileKeys.add(keyOf(TARGET_SESSION_FILE));
  return { fileKeys, refKeys: new Set(referencedFiles.map((a) => keyOf(a.path))) };
}

/** 非目标归因的 chatSessionId：孤儿（缺失/空/纯空白）或不同/相似 sessionId，恒不等于目标。 */
const nonTargetChatSessionIdArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant<string | null>(null),
  fc.constant(''),
  fc.constantFrom(' ', '\t', ' \n '),
  fc.constantFrom('S1', 's2', 's10', ' s1', 's1x')
);

/** 无任何目标归因存档的场景（用于空计划断言）。 */
const emptyScenarioArb: fc.Arbitrary<ArchiveInfo[]> = fc.uniqueArray(
  fc
    .record({ name: hex32Arb, size: archiveSizeArb, chatSessionId: nonTargetChatSessionIdArb })
    .map(({ name, size, chatSessionId }) => ({ path: archivePath(name), name, size, chatSessionId })),
  { selector: (a) => a.name, maxLength: 6 }
);

/** 关闭性场景：保证至少一条目标存档（计划非空），并给每条目标存档随机失败分布。 */
const GUARANTEED_TARGET_NAME = 'a'.repeat(32);
const NEW_AFTER_CONFIRM_NAME = 'f'.repeat(32);

interface RunScenario {
  archives: ArchiveInfo[];
  mode: CleanupMode;
  faultKinds: Array<'ok' | 'lock' | 'fatal'>;
}

const runScenarioArb: fc.Arbitrary<RunScenario> = fc
  .record({
    archives: archivesArb,
    mode: fc.constantFrom<CleanupMode>('attachment', 'full'),
    faultKinds: fc.array(fc.constantFrom<'ok' | 'lock' | 'fatal'>('ok', 'lock', 'fatal'), {
      maxLength: 10,
    }),
  })
  .map(({ archives, mode, faultKinds }) => {
    let all = archives;
    if (!all.some((a) => a.name === GUARANTEED_TARGET_NAME)) {
      all = [
        {
          path: archivePath(GUARANTEED_TARGET_NAME),
          name: GUARANTEED_TARGET_NAME,
          size: 512,
          chatSessionId: TARGET_SESSION_ID,
        },
        ...all,
      ];
    }
    return { archives: all, mode, faultKinds };
  });

// Feature: storage-usage-analytics, Property 27: CleanupPlan 的集合定义与封闭性
// Validates: Requirements 11.9, 14.1, 14.2, 14.3, 14.4, 14.7, 14.8
describe('Property 27: CleanupPlan 的集合定义与封闭性', () => {
  it('Property 27: plan.files 恒等于定义式集合，孤儿与清单恒被排除，两集合恒不相交', async () => {
    await fc.assert(
      fc.asyncProperty(planScenarioArb, async (sc) => {
        const rec = recordingCleanerFs(buildTree(sc.archives));
        const cleaner = makeCleaner(rec, sc.archives, sc.lineages);
        const plan = await cleaner.plan(sc.mode, TARGET_SESSION_ID, '标题');

        const { fileKeys, refKeys } = expectedSets(sc);
        const planFileKeys = new Set(plan.files.map((f) => keyOf(f.path)));
        const planRefKeys = new Set(plan.referenced.map((r) => keyOf(r.path)));

        // (a1) files / referenced 恒等于定义式集合（区分大小写严格相等 + full 并 SessionFile）
        expect(planFileKeys).toEqual(fileKeys);
        expect(planRefKeys).toEqual(refKeys);

        // (a2) 孤儿（chatSessionId 缺失/空/纯空白）恒不进任何集合
        const orphanKeys = new Set(
          sc.archives.filter((a) => !owns(a.chatSessionId)).map((a) => keyOf(a.path))
        );
        for (const t of [...plan.files, ...plan.referenced]) {
          expect(orphanKeys.has(keyOf(t.path))).toBe(false);
        }

        // (a3) SessionManifest 恒不进 files / referenced
        const manifestKey = keyOf(MANIFEST_PATH);
        for (const t of [...plan.files, ...plan.referenced]) {
          expect(keyOf(t.path)).not.toBe(manifestKey);
        }

        // (a4) files 与 referenced 恒不相交
        for (const k of planRefKeys) expect(planFileKeys.has(k)).toBe(false);

        // (a5) full 模式 manifestUpdate 恒非 null 且指向清单；attachment 恒为 null
        if (sc.mode === 'full') {
          expect(plan.manifestUpdate).not.toBeNull();
          expect(keyOf(plan.manifestUpdate!.path)).toBe(manifestKey);
          expect(plan.manifestUpdate!.sessionId).toBe(TARGET_SESSION_ID);
        } else {
          expect(plan.manifestUpdate).toBeNull();
        }

        // (a6) 每个条目恒含 path/size/mtimeMs，且合计与集合自洽
        for (const t of [...plan.files, ...plan.referenced]) {
          expect(typeof t.path).toBe('string');
          expect(typeof t.size).toBe('number');
          expect(typeof t.mtimeMs).toBe('number');
        }
        expect(plan.totalFiles).toBe(plan.files.length);
        expect(plan.totalBytes).toBe(plan.files.reduce((s, f) => s + f.size, 0));
        expect(plan.referencedFiles).toBe(plan.referenced.length);
        expect(plan.referencedBytes).toBe(plan.referenced.reduce((s, r) => s + r.size, 0));
      }),
      { numRuns: 100 }
    );
  });

  it('Property 27: run() 的 unlink 实参恒 ⊆ plan.files，不含目录，也不含确认后新增文件', async () => {
    await fc.assert(
      fc.asyncProperty(runScenarioArb, async (sc) => {
        // 由随机失败分布给目标存档路径打上锁类/致命错误标记（不影响「哪些路径被 unlink」）
        const targetPaths = sc.archives
          .filter((a) => owns(a.chatSessionId) && a.chatSessionId === TARGET_SESSION_ID)
          .map((a) => a.path);
        const lock: Record<string, FaultInjection> = {};
        const fatal: Record<string, FaultInjection> = {};
        targetPaths.forEach((p, i) => {
          const kind = sc.faultKinds.length ? sc.faultKinds[i % sc.faultKinds.length] : 'ok';
          // 只对 unlink 注入失败：stat 仍须成功，否则计划会提前把文件排除
          if (kind === 'lock') lock[p] = { code: 'EBUSY', op: 'unlink' };
          else if (kind === 'fatal') fatal[p] = { code: 'EIO', op: 'unlink' };
        });

        const rec = recordingCleanerFs(buildTree(sc.archives), { lock, fatal });
        const newFile = archivePath(NEW_AFTER_CONFIRM_NAME);
        // 确认之后才在夹具中出现的新文件——它是一条合法存档位置，但不在计划内
        const confirmThenAddFile: CleanerDeps['confirm'] = async () => {
          rec.setFile(newFile, 256);
          return 'confirm';
        };

        const cleaner = makeCleaner(rec, sc.archives, [], confirmThenAddFile);
        // 计划在确认之前生成，故其路径集合恒不含 newFile
        const plan = await cleaner.plan(sc.mode, TARGET_SESSION_ID, '标题');
        const planKeys = new Set(plan.files.map((f) => keyOf(f.path)));

        const result = await cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');
        expect(result.state).toBe('done');

        const unlinkKeys = rec.calls
          .filter((c) => c.op === 'unlink')
          .map((c) => keyOf(c.args[0] as string));

        // (b1) unlink 实参恒 ⊆ plan.files 的路径集合
        for (const k of unlinkKeys) expect(planKeys.has(k)).toBe(true);

        // (b2) 恒不含任何目录路径
        const dirKeys = new Set([
          keyOf(CLEANER_FIXTURE.storeRoot),
          keyOf(CLEANER_FIXTURE.sessionsRoot),
          keyOf(CLEANER_FIXTURE.sessionDir),
          keyOf(CLEANER_FIXTURE.savesDir),
          keyOf(CLEANER_FIXTURE.metadataDir),
          keyOf(CLEANER_FIXTURE.otherSavesDir),
        ]);
        for (const k of unlinkKeys) expect(dirKeys.has(k)).toBe(false);

        // (b3) 确认后新增文件恒不被删（Req 14.8）
        expect(unlinkKeys).not.toContain(keyOf(newFile));
        expect(rec.exists(newFile)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 27: 用户取消确认时 unlink 恒不被调用且目录树快照恒不变', async () => {
    await fc.assert(
      fc.asyncProperty(runScenarioArb, async (sc) => {
        const rec = recordingCleanerFs(buildTree(sc.archives));
        const before = rec.snapshot();
        const cancel: CleanerDeps['confirm'] = async () => 'cancel';
        const cleaner = makeCleaner(rec, sc.archives, [], cancel);

        const result = await cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');

        expect(result.state).toBe('cancelled');
        expect(rec.calls.some((c) => c.op === 'unlink')).toBe(false);
        expect(rec.calls.some((c) => c.op === 'writeFile')).toBe(false);
        expect(rec.snapshot()).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 27: 空计划恒不弹确认并返回 noop（不删除任何文件）', async () => {
    await fc.assert(
      fc.asyncProperty(emptyScenarioArb, async (archives) => {
        const rec = recordingCleanerFs(buildTree(archives));
        let confirmCalled = false;
        const confirm: CleanerDeps['confirm'] = async () => {
          confirmCalled = true;
          return 'confirm';
        };
        const cleaner = makeCleaner(rec, archives, [], confirm);

        // attachment 模式：无目标存档 → files 空、无 manifestUpdate → 空计划
        const result = await cleaner.run('attachment', TARGET_SESSION_ID, '标题');

        expect(result.state).toBe('noop');
        expect(confirmCalled).toBe(false);
        expect(rec.calls.some((c) => c.op === 'unlink')).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 29
 *
 * 复用文件头的共享夹具与生成器，以及 Property 27 处的 `makeCleaner` / `keyOf` /
 * `archivePath`——因此计划快照与段 5 复核共用**同一套**路径根与比较键，两侧对
 * 「什么算未变化」的口径不漂移。
 * ------------------------------------------------------------------ */

/**
 * 四个待删存档的固定 hex32 文件名，覆盖段 5 re-stat 复核的四种结局：
 * 未变化（删）/ 已消失（跳过 missing）/ 尺寸变化（跳过 changed）/ mtime 变化（跳过 changed）。
 * 刻意避开模块内已有的 `GUARANTEED_TARGET_NAME`（'a'×32）与 `NEW_AFTER_CONFIRM_NAME`（'f'×32）。
 */
const P29_UNCHANGED_NAME = '0'.repeat(32);
const P29_MISSING_NAME = '1'.repeat(32);
const P29_SIZE_CHANGED_NAME = '2'.repeat(32);
const P29_MTIME_CHANGED_NAME = '3'.repeat(32);

/** 一次 TOCTOU 场景：四个文件各自的计划快照值 + 确认后注入的变更量。 */
interface ToctouScenario {
  unchangedSize: number;
  missingSize: number;
  sizeChangedOrig: number;
  /** 确认后把尺寸变化文件改成的新尺寸增量（恒 ≥ 1，保证与快照不等） */
  sizeDelta: number;
  mtimeChangedSize: number;
  /** 计划快照时刻四个文件统一使用的 mtimeMs */
  baseMtime: number;
  /** 确认后把 mtime 变化文件的 mtimeMs 偏移量（恒 ≥ 1，保证与快照不等） */
  mtimeDelta: number;
}

const toctouScenarioArb: fc.Arbitrary<ToctouScenario> = fc.record({
  unchangedSize: fc.integer({ min: 1, max: 1_000_000 }),
  missingSize: fc.integer({ min: 1, max: 1_000_000 }),
  sizeChangedOrig: fc.integer({ min: 1, max: 1_000_000 }),
  sizeDelta: fc.integer({ min: 1, max: 100_000 }),
  mtimeChangedSize: fc.integer({ min: 1, max: 1_000_000 }),
  baseMtime: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  mtimeDelta: fc.integer({ min: 1, max: 1_000_000 }),
});

/** 目标会话名下的一条存档（路径恒在当前工作区 ExecutionSavesBucket 下）。 */
function targetArchive(name: string, size: number): ArchiveInfo {
  return { path: archivePath(name), name, size, chatSessionId: TARGET_SESSION_ID };
}

// Feature: storage-usage-analytics, Property 29: TOCTOU 复核的三分支跳过语义
// Validates: Requirement 14.20
//
// 段 5 的 re-stat 复核有三条跳过分支 + 一条放行分支。用 recordingCleanerFs 在 confirm
// 回调里注入「确认之后、复核之前」的变更（removeFile / setFile 改 size 或 mtimeMs），
// 一次场景同时覆盖四种结局：
//   (1) 文件已消失      → skipped[reason='missing']，不 unlink，释放 0 字节
//   (2) size 与快照不符 → skipped[reason='changed']，不 unlink
//   (3) mtimeMs 与快照不符 → skipped[reason='changed']，不 unlink
//   (4) 完全一致        → 被 unlink，其快照字节数计入 deletedBytes
// 且跳过项恒不落入 failed[]、失败项恒不落入 skipped[]（本场景无失败，故 failed 恒为空）。
describe('Property 29: TOCTOU 复核的三分支跳过语义', () => {
  it('Property 29: 四种复核结局各自跳过/删除正确，跳过项永不 unlink 亦不入 failed[]', async () => {
    await fc.assert(
      fc.asyncProperty(toctouScenarioArb, async (sc) => {
        const unchangedPath = archivePath(P29_UNCHANGED_NAME);
        const missingPath = archivePath(P29_MISSING_NAME);
        const sizeChangedPath = archivePath(P29_SIZE_CHANGED_NAME);
        const mtimeChangedPath = archivePath(P29_MTIME_CHANGED_NAME);

        // 计划快照时刻：四个文件都存在、都用同一个 baseMtime，size 为各自快照值
        const tree: MemTree = {
          [unchangedPath]: { size: sc.unchangedSize, mtimeMs: sc.baseMtime },
          [missingPath]: { size: sc.missingSize, mtimeMs: sc.baseMtime },
          [sizeChangedPath]: { size: sc.sizeChangedOrig, mtimeMs: sc.baseMtime },
          [mtimeChangedPath]: { size: sc.mtimeChangedSize, mtimeMs: sc.baseMtime },
        };
        const rec = recordingCleanerFs(tree);

        const archives: ArchiveInfo[] = [
          targetArchive(P29_UNCHANGED_NAME, sc.unchangedSize),
          targetArchive(P29_MISSING_NAME, sc.missingSize),
          targetArchive(P29_SIZE_CHANGED_NAME, sc.sizeChangedOrig),
          targetArchive(P29_MTIME_CHANGED_NAME, sc.mtimeChangedSize),
        ];

        // 确认之后、复核之前注入 TOCTOU 变更——正是段 5 复核要防的窗口
        const confirmThenMutate: CleanerDeps['confirm'] = async () => {
          rec.removeFile(missingPath); // (1) 外部删除 → 复核为 missing
          rec.setFile(sizeChangedPath, {
            size: sc.sizeChangedOrig + sc.sizeDelta, // (2) 尺寸变化，mtime 保持
            mtimeMs: sc.baseMtime,
          });
          rec.setFile(mtimeChangedPath, {
            size: sc.mtimeChangedSize, // (3) mtime 变化，尺寸保持
            mtimeMs: sc.baseMtime + sc.mtimeDelta,
          });
          return 'confirm';
        };

        const cleaner = makeCleaner(rec, archives, [], confirmThenMutate);
        // attachment 模式：计划集合恰为四条目标存档，不牵涉 SessionFile / 清单
        const result = await cleaner.run('attachment', TARGET_SESSION_ID, '标题');

        expect(result.state).toBe('done');

        // ---- unlink 调用面：有且仅有「未变化」文件被删 ----
        const unlinkKeys = rec.calls
          .filter((c) => c.op === 'unlink')
          .map((c) => keyOf(c.args[0] as string));
        expect(unlinkKeys).toEqual([keyOf(unchangedPath)]);

        // ---- (4) 未变化 → 被删、字节计入 deletedBytes、盘上已消失 ----
        expect(result.deletedFiles).toBe(1);
        expect(result.deletedBytes).toBe(sc.unchangedSize);
        expect(rec.exists(unchangedPath)).toBe(false);

        // ---- (1)(2)(3) 三条跳过分支：均在 skipped[]，reason 正确 ----
        const skippedByKey = new Map(result.skipped.map((s) => [keyOf(s.path), s.reason]));
        expect(skippedByKey.get(keyOf(missingPath))).toBe('missing');
        expect(skippedByKey.get(keyOf(sizeChangedPath))).toBe('changed');
        expect(skippedByKey.get(keyOf(mtimeChangedPath))).toBe('changed');
        // 恰好三条跳过，别无其它
        expect(result.skipped.length).toBe(3);
        expect(new Set(skippedByKey.keys())).toEqual(
          new Set([keyOf(missingPath), keyOf(sizeChangedPath), keyOf(mtimeChangedPath)])
        );

        // ---- 跳过项恒不被 unlink（释放 0 字节：不计入 deletedBytes/Files） ----
        for (const k of skippedByKey.keys()) expect(unlinkKeys).not.toContain(k);
        // 尺寸/ mtime 变化的文件未被删除，仍在盘上；missing 因外部删除而不在
        expect(rec.exists(sizeChangedPath)).toBe(true);
        expect(rec.exists(mtimeChangedPath)).toBe(true);
        expect(rec.exists(missingPath)).toBe(false);

        // ---- 本场景无失败：failed 恒空，且跳过项与失败项两集合恒不相交 ----
        expect(result.failed).toEqual([]);
        const failedKeys = new Set(result.failed.map((f) => keyOf(f.path)));
        for (const k of skippedByKey.keys()) expect(failedKeys.has(k)).toBe(false);
        for (const k of failedKeys) expect(skippedByKey.has(k)).toBe(false);

        // ---- 三类计数守恒（与 Property 30 同口径的一致性自检） ----
        expect(result.deletedFiles + result.failed.length + result.skipped.length).toBe(
          archives.length
        );
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 30
 *
 * 复用文件头的共享夹具与生成器（`CLEANER_FIXTURE` / `CLEANER_ROOTS` /
 * `archivePath` / `sessionFilePath` / `TARGET_SESSION_ID`）以及 Property 27/29 处的
 * `makeCleaner` / `buildTree` / `keyOf` / `targetArchive`——因此三类计数与
 * `assertDeletable`（Property 28）、TOCTOU 复核（Property 29）共用**同一套**路径根
 * 与比较键，「哪些条目算失败、哪些算跳过」的口径在三个属性之间不漂移。
 * ------------------------------------------------------------------ */

/** 锁类可重试错误码（与 cleaner.ts 的 `RETRYABLE_UNLINK_CODES` 同集合）。 */
const P30_LOCK_CODES = ['EBUSY', 'EPERM', 'EACCES', 'ELOCK'] as const;
/** 不可重试错误码：不在锁类集合里，故恒不触发重试、不产生任何等待。 */
const P30_FATAL_CODES = ['EIO', 'EISDIR', 'EROFS', 'EXDEV'] as const;

/** 首次尝试之外的重试上限与每次重试的等待毫秒数（Req 14.9 的两个数字）。 */
const P30_MAX_RETRIES = 3;
const P30_RETRY_DELAY_MS = 200;

/**
 * 一个待删条目在段 4~6 的八种结局，覆盖任务要求的五类失败分布：
 *
 * | kind | 结局 | 落点 |
 * | --- | --- | --- |
 * | `ok` | 一次 unlink 成功 | deleted |
 * | `lock-retry-ok` | 锁类失败 `retryTimes`(1~3) 次后成功 | deleted（重试后成功恒算成功） |
 * | `lock-fail` | 锁类失败恒不自愈 → 重试满 3 次仍失败 | failed |
 * | `fatal` | 非锁类错误 → 不重试 | failed |
 * | `reject-symlink` | 段 4 校验拒绝（符号链接） | failed（恒不 unlink） |
 * | `reject-not-allowed` | 段 4 校验拒绝（其它桶，不匹配白名单位置） | failed（恒不 unlink） |
 * | `skip-missing` | 确认后被外部删除 → 段 5 复核 missing | skipped（恒不 unlink） |
 * | `skip-changed` | 确认后尺寸变化 → 段 5 复核 changed | skipped（恒不 unlink） |
 */
type P30Kind =
  | 'ok'
  | 'lock-retry-ok'
  | 'lock-fail'
  | 'fatal'
  | 'reject-symlink'
  | 'reject-not-allowed'
  | 'skip-missing'
  | 'skip-changed';

const P30_KINDS: readonly P30Kind[] = [
  'ok',
  'lock-retry-ok',
  'lock-fail',
  'fatal',
  'reject-symlink',
  'reject-not-allowed',
  'skip-missing',
  'skip-changed',
];

interface P30Entry {
  kind: P30Kind;
  /** 快照字节数：恒为有限正数，故 `plan` 里的 size 恒等于该值（`safeBytes` 不会归零） */
  size: number;
  mtimeMs: number;
  /** `lock-retry-ok` 的失败次数（1~3），即重试次数 */
  retryTimes: number;
  /** `skip-changed` 确认后的尺寸增量（恒 ≥ 1，保证与快照不等） */
  delta: number;
  lockCode: (typeof P30_LOCK_CODES)[number];
  fatalCode: (typeof P30_FATAL_CODES)[number];
}

const p30EntryArb: fc.Arbitrary<P30Entry> = fc.record({
  kind: fc.constantFrom(...P30_KINDS),
  size: fc.integer({ min: 1, max: 1_000_000 }),
  mtimeMs: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  retryTimes: fc.integer({ min: 1, max: P30_MAX_RETRIES }),
  delta: fc.integer({ min: 1, max: 100_000 }),
  lockCode: fc.constantFrom(...P30_LOCK_CODES),
  fatalCode: fc.constantFrom(...P30_FATAL_CODES),
});

interface P30Target extends P30Entry {
  name: string;
  path: string;
}

interface P30Scenario {
  mode: CleanupMode;
  targets: P30Target[];
}

/**
 * 条目文件名：`'e' + 序号`，全小写 hex32。刻意避开模块内已用的
 * `'a'×32` / `'f'×32`（Property 27）与 `'0'`~`'3'×32`（Property 29）。
 */
const p30Name = (i: number): string => 'e' + i.toString(16).padStart(31, '0');

/**
 * 条目路径：除 `reject-not-allowed` 落在 ExecutionMetadataBucket（StoreRoot 之内、
 * 但不匹配任何白名单位置）之外，其余都落在当前工作区 ExecutionSavesBucket 下。
 * 两者都能被 `plan()` 纳入计划（`stat` 成功即可），差别只在段 4 的校验结果——
 * 这正是「校验拒绝也要参与计数守恒」所需的构造。
 */
function p30Path(kind: P30Kind, name: string): string {
  return kind === 'reject-not-allowed'
    ? path.join(CLEANER_FIXTURE.metadataDir, name)
    : archivePath(name);
}

const materializeP30 = (mode: CleanupMode, entries: readonly P30Entry[]): P30Scenario => ({
  mode,
  targets: entries.map((e, i) => {
    const name = p30Name(i);
    return { ...e, name, path: p30Path(e.kind, name) };
  }),
});

/**
 * 混合分布场景（含随机顺序）+ **全部成功**场景。后者单列一支而不是靠随机撞出来：
 * 「一条不失败」是部分成功语义的边界，必须被稳定覆盖（否则 `failed`/`skipped` 恒空
 * 这条路径可能从未跑到）。顺序随机保证「失败条目在前」也不会中止其后的删除。
 */
const p30ScenarioArb: fc.Arbitrary<P30Scenario> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc
      .tuple(
        fc.constantFrom<CleanupMode>('attachment', 'full'),
        fc.array(p30EntryArb, { minLength: 1, maxLength: 8 })
      )
      .map(([mode, entries]) => materializeP30(mode, entries)),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom<CleanupMode>('attachment', 'full'),
        fc.array(
          p30EntryArb.map((e) => ({ ...e, kind: 'ok' as const })),
          { minLength: 1, maxLength: 6 }
        )
      )
      .map(([mode, entries]) => materializeP30(mode, entries)),
  }
);

/** 由场景组装 `ArchiveInfo[]`：全部归属目标会话，故恒进 `plan.files`。 */
function p30Archives(sc: P30Scenario): ArchiveInfo[] {
  return sc.targets.map((t) =>
    t.kind === 'reject-not-allowed'
      ? { path: t.path, name: t.name, size: t.size, chatSessionId: TARGET_SESSION_ID }
      : { ...targetArchive(t.name, t.size), path: t.path }
  );
}

/**
 * 由场景组装内存树与故障注入表。
 *
 * 故障**只**注入 `unlink`：`stat` 必须成功，否则条目在 `plan()` 阶段就被排除、
 * 压根不进计划，也就无从检验「失败条目仍参与计数守恒」。
 */
function p30Fs(sc: P30Scenario): ReturnType<typeof recordingCleanerFs> {
  const tree = buildTree(p30Archives(sc));
  for (const t of sc.targets) {
    tree[t.path] = { size: t.size, mtimeMs: t.mtimeMs, symlink: t.kind === 'reject-symlink' };
  }
  const lock: Record<string, FaultInjection> = {};
  const fatal: Record<string, FaultInjection> = {};
  for (const t of sc.targets) {
    if (t.kind === 'lock-retry-ok') {
      // times 用完后自动放行 → 第 retryTimes+1 次尝试成功
      lock[t.path] = { code: t.lockCode, op: 'unlink', times: t.retryTimes };
    } else if (t.kind === 'lock-fail') {
      lock[t.path] = { code: t.lockCode, op: 'unlink' }; // times 缺省 → 恒失败
    } else if (t.kind === 'fatal') {
      fatal[t.path] = { code: t.fatalCode, op: 'unlink' };
    }
  }
  return recordingCleanerFs(tree, { lock, fatal });
}

/** 每种结局期望的 unlink 尝试次数（首次 + 重试）。 */
function expectedAttempts(t: P30Entry): number {
  switch (t.kind) {
    case 'ok':
      return 1;
    case 'lock-retry-ok':
      return t.retryTimes + 1;
    case 'lock-fail':
      return P30_MAX_RETRIES + 1;
    case 'fatal':
      return 1;
    default:
      // 校验拒绝与复核跳过恒不发生 unlink
      return 0;
  }
}

/** 每种结局期望的重试等待次数（= 尝试次数 - 1，仅锁类才有）。 */
function expectedWaits(t: P30Entry): number {
  if (t.kind === 'lock-retry-ok') return t.retryTimes;
  if (t.kind === 'lock-fail') return P30_MAX_RETRIES;
  return 0;
}

// Feature: storage-usage-analytics, Property 30: 部分成功语义与三类计数守恒
// Validates: Requirements 11.10, 14.9, 14.10
//
// 生成器覆盖五类失败分布：锁类可重试失败（重试后成功 / 重试满仍失败）、不可重试失败、
// 校验拒绝（符号链接 / 不匹配白名单位置）、复核跳过（missing / changed）与全部成功。
// 在此之上钉住三件事：
//   (a) `deletedFiles + failed.length + skipped.length === plan.totalFiles`，且
//       `deletedBytes` 恒等于成功删除条目的**快照**字节数之和；
//   (b) 删除恒不因单条失败而中止——每个未被跳过且未被校验拒绝的条目恒至少尝试一次 unlink；
//   (c) 锁类失败恒被重试至多 3 次、每次等待参数恒为 200ms，重试后成功恒计入成功而非失败。
describe('Property 30: 部分成功语义与三类计数守恒', () => {
  it('Property 30: 三类计数恒守恒、字节数恒等于成功条目快照之和，单条失败恒不中止其余删除', async () => {
    await fc.assert(
      fc.asyncProperty(p30ScenarioArb, async (sc) => {
        const rec = p30Fs(sc);
        const archives = p30Archives(sc);

        // 确认之后、复核之前注入 TOCTOU 变更（段 5 的两条跳过分支）
        const confirmThenMutate: CleanerDeps['confirm'] = async () => {
          for (const t of sc.targets) {
            if (t.kind === 'skip-missing') rec.removeFile(t.path);
            else if (t.kind === 'skip-changed') {
              rec.setFile(t.path, { size: t.size + t.delta, mtimeMs: t.mtimeMs });
            }
          }
          return 'confirm';
        };

        const cleaner = makeCleaner(rec, archives, [], confirmThenMutate);
        // 计划在确认之前生成，故其快照恒为变更前的 size/mtimeMs
        const plan = await cleaner.plan(sc.mode, TARGET_SESSION_ID, '标题');
        const result = await cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');

        expect(result.state).toBe('done');

        // 计划集合 = 全部条目（+ full 模式的 SessionFile）；每条都进入了删除流程
        const byKey = new Map(sc.targets.map((t) => [keyOf(t.path), t]));
        expect(plan.totalFiles).toBe(sc.targets.length + (sc.mode === 'full' ? 1 : 0));

        /** 计划内条目的期望归类：SessionFile（不在 byKey 里）按 `ok` 处理。 */
        const kindOf = (p: string): P30Kind => byKey.get(keyOf(p))?.kind ?? 'ok';
        const isDeleted = (k: P30Kind) => k === 'ok' || k === 'lock-retry-ok';
        const isFailed = (k: P30Kind) =>
          k === 'lock-fail' || k === 'fatal' || k === 'reject-symlink' || k === 'reject-not-allowed';

        const expDeleted = plan.files.filter((f) => isDeleted(kindOf(f.path)));
        const expFailed = plan.files.filter((f) => isFailed(kindOf(f.path)));
        const expSkipped = plan.files.filter((f) => kindOf(f.path).startsWith('skip-'));

        // ---- (a1) 三类计数守恒：成功 + 失败 + 跳过 恒等于计划文件数 ----
        expect(result.deletedFiles + result.failed.length + result.skipped.length).toBe(
          plan.totalFiles
        );

        // ---- (a2) 三类集合恒等于期望集合，且两两不相交（无条目被重复计数或漏计） ----
        const deletedKeys = new Set(
          plan.files.map((f) => keyOf(f.path)).filter((k) => !byKey.has(k) || isDeleted(byKey.get(k)!.kind))
        );
        const failedKeys = new Set(result.failed.map((f) => keyOf(f.path)));
        const skippedKeys = new Set(result.skipped.map((s) => keyOf(s.path)));
        expect(result.deletedFiles).toBe(expDeleted.length);
        expect(failedKeys).toEqual(new Set(expFailed.map((f) => keyOf(f.path))));
        expect(skippedKeys).toEqual(new Set(expSkipped.map((f) => keyOf(f.path))));
        expect(result.failed.length).toBe(expFailed.length);
        for (const k of failedKeys) {
          expect(skippedKeys.has(k)).toBe(false);
          expect(deletedKeys.has(k)).toBe(false);
        }
        for (const k of skippedKeys) expect(deletedKeys.has(k)).toBe(false);

        // ---- (a3) deletedBytes 恒等于成功条目的**快照**字节数之和 ----
        expect(result.deletedBytes).toBe(expDeleted.reduce((s, f) => s + f.size, 0));
        // 成功条目确实已从盘上消失；失败/跳过（除 missing）的条目仍在
        for (const f of expDeleted) expect(rec.exists(f.path)).toBe(false);
        for (const t of sc.targets) {
          if (isFailed(t.kind) || t.kind === 'skip-changed') expect(rec.exists(t.path)).toBe(true);
        }

        // ---- 失败原因可判读：校验拒绝给出确定原因，删除失败带错误码 ----
        const reasonByKey = new Map(result.failed.map((f) => [keyOf(f.path), f.reason]));
        for (const t of sc.targets) {
          const reason = reasonByKey.get(keyOf(t.path));
          if (t.kind === 'reject-symlink') expect(reason).toBe(DELETE_REJECT_REASONS.symlink);
          else if (t.kind === 'reject-not-allowed')
            expect(reason).toBe(DELETE_REJECT_REASONS.notAllowed);
          else if (t.kind === 'lock-fail') expect(reason).toContain(t.lockCode);
          else if (t.kind === 'fatal') expect(reason).toContain(t.fatalCode);
        }
        // 跳过原因恒为两个取值之一，且与注入的变更对应
        const skipReasonByKey = new Map(result.skipped.map((s) => [keyOf(s.path), s.reason]));
        for (const t of sc.targets) {
          if (t.kind === 'skip-missing') expect(skipReasonByKey.get(keyOf(t.path))).toBe('missing');
          if (t.kind === 'skip-changed') expect(skipReasonByKey.get(keyOf(t.path))).toBe('changed');
        }

        // ---- (b) 恒不因单条失败而中止：未跳过且未被校验拒绝的条目恒至少尝试一次 unlink ----
        const attempts = new Map<string, number>();
        for (const c of rec.calls) {
          if (c.op !== 'unlink') continue;
          const k = keyOf(c.args[0] as string);
          attempts.set(k, (attempts.get(k) ?? 0) + 1);
        }
        for (const f of plan.files) {
          const k = kindOf(f.path);
          const n = attempts.get(keyOf(f.path)) ?? 0;
          if (k.startsWith('reject-') || k.startsWith('skip-')) expect(n).toBe(0);
          else expect(n).toBeGreaterThanOrEqual(1);
        }
        // full 模式下清单读改写仍照常发生（部分失败不阻断后续段）
        if (sc.mode === 'full') {
          expect(rec.calls.some((c) => c.op === 'readFile')).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property 30: 锁类失败恒重试至多 3 次、等待参数恒为 200ms，重试后成功恒计入成功', async () => {
    await fc.assert(
      fc.asyncProperty(p30ScenarioArb, async (sc) => {
        const rec = p30Fs(sc);
        const archives = p30Archives(sc);
        const confirmThenMutate: CleanerDeps['confirm'] = async () => {
          for (const t of sc.targets) {
            if (t.kind === 'skip-missing') rec.removeFile(t.path);
            else if (t.kind === 'skip-changed') {
              rec.setFile(t.path, { size: t.size + t.delta, mtimeMs: t.mtimeMs });
            }
          }
          return 'confirm';
        };
        const cleaner = makeCleaner(rec, archives, [], confirmThenMutate);
        const result = await cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');

        const attempts = new Map<string, number>();
        for (const c of rec.calls) {
          if (c.op !== 'unlink') continue;
          const k = keyOf(c.args[0] as string);
          attempts.set(k, (attempts.get(k) ?? 0) + 1);
        }

        // ---- (c1) 任一路径的尝试次数恒 ≤ 1 + 3（首次尝试 + 至多 3 次重试） ----
        for (const n of attempts.values()) expect(n).toBeLessThanOrEqual(P30_MAX_RETRIES + 1);

        // ---- (c2) 每种结局的尝试次数恒等于期望值（锁类重试到自愈即止，非锁类恒不重试） ----
        for (const t of sc.targets) {
          expect(attempts.get(keyOf(t.path)) ?? 0).toBe(expectedAttempts(t));
        }

        // ---- (c3) 等待次数恒等于重试次数，且每次等待参数恒为 200ms ----
        const expWaits = sc.targets.reduce((s, t) => s + expectedWaits(t), 0);
        expect(rec.delays.length).toBe(expWaits);
        for (const ms of rec.delays) expect(ms).toBe(P30_RETRY_DELAY_MS);
        // 等待只可能来自重试：无锁类条目时恒零等待
        if (expWaits === 0) expect(rec.delays).toEqual([]);
        // 记录序列里的 delay 实参与 delays 一致（不存在绕过注入 delay 的真实睡眠）
        expect(rec.calls.filter((c) => c.op === 'delay').map((c) => c.args[0])).toEqual(rec.delays);

        // ---- (c4) 重试后成功的条目恒计入成功而非失败 ----
        const failedKeys = new Set(result.failed.map((f) => keyOf(f.path)));
        const retriedThenOk = sc.targets.filter((t) => t.kind === 'lock-retry-ok');
        for (const t of retriedThenOk) {
          expect(failedKeys.has(keyOf(t.path))).toBe(false);
          expect(rec.exists(t.path)).toBe(false);
        }
        // 重试满仍失败的条目恒在 failed[] 且文件仍在盘上
        for (const t of sc.targets.filter((x) => x.kind === 'lock-fail')) {
          expect(failedKeys.has(keyOf(t.path))).toBe(true);
          expect(rec.exists(t.path)).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property 30: 全部成功场景下 failed/skipped 恒空、计数与字节数恒等于计划合计', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.constantFrom<CleanupMode>('attachment', 'full'),
          fc.array(
            p30EntryArb.map((e) => ({ ...e, kind: 'ok' as const })),
            { minLength: 1, maxLength: 6 }
          )
        ),
        async ([mode, entries]) => {
          const sc = materializeP30(mode, entries);
          const rec = p30Fs(sc);
          const archives = p30Archives(sc);
          const cleaner = makeCleaner(rec, archives, []);
          const plan = await cleaner.plan(mode, TARGET_SESSION_ID, '标题');
          const result = await cleaner.run(mode, TARGET_SESSION_ID, '标题');

          expect(result.state).toBe('done');
          expect(result.failed).toEqual([]);
          expect(result.skipped).toEqual([]);
          expect(result.deletedFiles).toBe(plan.totalFiles);
          expect(result.deletedBytes).toBe(plan.totalBytes);
          // 守恒式在全成功这一端退化为「成功数 = 计划数」
          expect(result.deletedFiles + result.failed.length + result.skipped.length).toBe(
            plan.totalFiles
          );
          // 无失败即无重试：恒零等待，且每条恰一次 unlink
          expect(rec.delays).toEqual([]);
          const unlinkKeys = rec.calls
            .filter((c) => c.op === 'unlink')
            .map((c) => keyOf(c.args[0] as string));
          expect(unlinkKeys.length).toBe(plan.totalFiles);
          expect(new Set(unlinkKeys)).toEqual(new Set(plan.files.map((f) => keyOf(f.path))));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 30: 生成器覆盖锁类可重试失败、不可重试失败、校验拒绝、复核跳过与全部成功（覆盖度守卫）', () => {
    const samples = fc.sample(p30ScenarioArb, 400);
    const kinds = new Set<P30Kind>();
    for (const sc of samples) for (const t of sc.targets) kinds.add(t.kind);
    for (const k of P30_KINDS) expect([...kinds]).toContain(k);
    // 全部成功场景（无一条失败/跳过）必须被稳定采到
    expect(samples.some((sc) => sc.targets.every((t) => t.kind === 'ok'))).toBe(true);
    // 混合场景（同一次运行里同时出现成功、失败与跳过）也必须被采到
    expect(
      samples.some(
        (sc) =>
          sc.targets.some((t) => t.kind === 'ok' || t.kind === 'lock-retry-ok') &&
          sc.targets.some((t) => t.kind === 'lock-fail' || t.kind === 'fatal') &&
          sc.targets.some((t) => t.kind.startsWith('skip-'))
      )
    ).toBe(true);
    // 重试次数生成器恒落在 [1, 3]（「至多 3 次」的前提）
    for (const sc of samples) {
      for (const t of sc.targets) {
        expect(t.retryTimes).toBeGreaterThanOrEqual(1);
        expect(t.retryTimes).toBeLessThanOrEqual(P30_MAX_RETRIES);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Property 31
 *
 * 复用文件头的共享夹具与生成器（`CLEANER_FIXTURE` / `CLEANER_ROOTS` / `archivePath` /
 * `sessionFilePath` / `hex32Arb` / `archiveSizeArb` / `TARGET_SESSION_ID`）以及
 * Property 27/29/30 处的 `buildTree` / `keyOf` / `targetArchive` / `autoConfirm` 与整套
 * p30 场景机制（`p30EntryArb` / `materializeP30` / `p30Fs` / `p30Archives`）——于是
 * 「哪些条目算成功删除」在 Property 30 与本属性之间是同一套判据，失效范围的断言不会
 * 因为两处对「成功」的口径不同而漂移。
 *
 * 三段链路各自在**自己的注入边界**上断言，因为它们分属三个模块：
 *
 * | 段 | 被断言的契约 | 观测点 |
 * | --- | --- | --- |
 * | cleaner 段 8 | 传给 `CleanerDeps.invalidate` 的路径恒等于成功删除的路径集合，且三种结局都调用 | 记录型 `invalidate` 钩子 |
 * | analyzer | `invalidateForDeletedFiles` 打掉自被删文件所在目录到 StoreRoot（及扫描根）的完整祖先链，并丢弃 StorageCache 汇总 | 真实实现 + 内存 fs 的**再扫描**行为 |
 * | credits | `dropArchiveEntries` 摘除的索引键集合恒等于被删存档路径集合 | 真实 ArchiveIndex |
 *
 * 把三者接起来的是 `extension.ts` 的 `invalidateStorageCaches`（宿主接线），它需要
 * vscode 宿主才能实例化，故不在本属性的观测范围内——本属性钉住的是每个边界的契约，
 * 接线本身由宿主侧接线任务负责。
 * ------------------------------------------------------------------ */

/**
 * 记录型 `invalidate` 版本的 cleaner 组装器。
 *
 * 刻意**不**改模块内已有的 `makeCleaner`（它注入 `invalidate: () => {}`）：Property
 * 27/29/30 的用例都挂在那个组装器上，动它等于把三个已通过的属性一起搅进本次改动。
 */
function makeCleanerRecordingInvalidate(
  rec: ReturnType<typeof recordingCleanerFs>,
  archives: readonly ArchiveInfo[],
  lineages: readonly SessionLineage[] = [],
  confirm: CleanerDeps['confirm'] = autoConfirm
): { cleaner: SessionCleaner; invalidateCalls: string[][] } {
  const invalidateCalls: string[][] = [];
  const deps: CleanerDeps = {
    fs: rec.deps,
    audit: () => {},
    confirm,
    archives: () => archives,
    // 段 8 的实参快照：复制一份，避免调用方后续改写数组影响断言
    invalidate: (deletedPaths) => {
      invalidateCalls.push([...deletedPaths]);
    },
    roots: CLEANER_ROOTS,
    lineages: () => lineages,
  };
  return { cleaner: new SessionCleaner(deps), invalidateCalls };
}

/** 四类恒失败结局（两类删除失败 + 两类校验拒绝），用于构造「全部失败」场景。 */
const P31_FAIL_KINDS = ['lock-fail', 'fatal', 'reject-symlink', 'reject-not-allowed'] as const;

/**
 * 场景生成器：混合分布 + **全部成功** + **全部失败**三支。
 *
 * 后两支单列而不是靠随机撞出来——Req 14.13 明文要求「全部成功 / 部分成功 / 全部失败
 * 任一种」都要失效，这三种结局必须各自被稳定采到，否则「无论成败都调用」是空话。
 * 全部失败一支恒取 `attachment` 模式：`full` 会并入 SessionFile（它恒删除成功），
 * 那就不再是「一条都没删成」的场景了。
 */
const p31ScenarioArb: fc.Arbitrary<P30Scenario> = fc.oneof(
  { weight: 4, arbitrary: p30ScenarioArb },
  {
    weight: 1,
    arbitrary: fc
      .array(
        p30EntryArb.map((e) => ({ ...e, kind: 'ok' as const })),
        { minLength: 1, maxLength: 5 }
      )
      .map((entries) => materializeP30('attachment', entries)),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(fc.tuple(p30EntryArb, fc.constantFrom(...P31_FAIL_KINDS)), {
        minLength: 1,
        maxLength: 5,
      })
      .map((pairs) =>
        materializeP30(
          'attachment',
          pairs.map(([e, kind]) => ({ ...e, kind }))
        )
      ),
  }
);

/** 成功删除的两种结局（与 Property 30 的 `isDeleted` 同一判据）。 */
const p31IsDeletedKind = (k: P30Kind): boolean => k === 'ok' || k === 'lock-retry-ok';

/* ------------------- analyzer 段：内存 fs 与路径夹具 ------------------- */

/** analyzer 段的运行根：与 cleaner 夹具分开，避免两套根互相干扰。 */
const P31_RUN_DIR = path.resolve(path.sep + 'kcs-p31-analyzer');
/** 当前工作区 fsPath：只作 `hash32` / `encodeWorkspaceKeys` 的输入，不需要真实存在。 */
const P31_WORKSPACE = '/home/kcs/p31-ws';
/** 固定时钟：StorageCache 的 60 秒判定因此恒不会自行过期，缓存命中与否只由失效决定。 */
const P31_FIXED_NOW = 1_700_000_000_000;
/** 目录与文件的 mtimeMs 恒为常量——「孙辈内容变化不改祖先 mtime」正是要模拟的前提。 */
const P31_NODE_MTIME = 1_700_000_000_000;

/** 注入的 PathResolver：linux + XDG_CONFIG_HOME → UserDataDir = `<P31_RUN_DIR>/Kiro`。 */
function p31PathResolver(): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: P31_RUN_DIR },
    homedir: () => P31_RUN_DIR,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

interface P31TreeSpec {
  /** 祖先补全的顶端（含它自身） */
  root: string;
  /** 绝对路径 → 字节数 */
  files: Record<string, number>;
  /** 绝对路径 → `readFile` 返回的内容（只有 SessionManifest 需要） */
  contents?: Record<string, string>;
}

interface P31MemFs {
  deps: AnalyzerFsDeps;
  /** 每次 `readdir` 的实参（已规范化），供「哪些目录被重新枚举」的断言使用 */
  readdirs: string[];
  resetRecords(): void;
  /** 只改文件字节数：所在目录的 mtimeMs 与直接子条目数都不变 */
  setSize(p: string, size: number): void;
}

function p31Enoent(op: string, p: string): Error {
  const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`) as Error & {
    code: string;
  };
  e.code = 'ENOENT';
  return e;
}

/**
 * 纯内存的只读 `AnalyzerFsDeps`。
 *
 * 用内存树而不是临时目录，是为了让「就地改一个深层文件的字节数、同时**不**触动任何
 * 祖先目录的 `(mtimeMs, 直接子条目数)`」成为可精确构造的前提——真实文件系统上写文件
 * 会顺手改动它自身的 mtime，而目录 mtime 的粒度还随平台而异。SubtreeCache 的失效判据
 * 抓不到这种孙辈内容增长，正是 Requirement 14.13 要求逐级显式失效的原因。
 */
function p31MemFs(spec: P31TreeSpec): P31MemFs {
  const norm = (p: string): string => path.normalize(p);
  const files = new Map<string, number>();
  const dirs = new Map<string, Set<string>>();
  const contents = new Map<string, string>();
  const readdirs: string[] = [];

  const ensureDir = (d: string): Set<string> => {
    const key = norm(d);
    let set = dirs.get(key);
    if (!set) {
      set = new Set<string>();
      dirs.set(key, set);
    }
    return set;
  };

  const rootKey = norm(spec.root);
  ensureDir(rootKey);

  /** 自 child 向上补全父目录并登记子项名，直至 root（含）或文件系统根。 */
  const link = (child: string): void => {
    let cur = norm(child);
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      ensureDir(parent).add(path.basename(cur));
      if (parent === rootKey) break;
      cur = parent;
    }
  };

  for (const [p, size] of Object.entries(spec.files)) {
    files.set(norm(p), size);
    link(p);
  }
  for (const [p, c] of Object.entries(spec.contents ?? {})) contents.set(norm(p), c);

  const statOf = (
    p: string,
    op: string
  ): { size: number; mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean } => {
    const key = norm(p);
    const size = files.get(key);
    if (size !== undefined) {
      return {
        size,
        mtimeMs: P31_NODE_MTIME,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    }
    if (dirs.has(key)) {
      return {
        size: 0,
        mtimeMs: P31_NODE_MTIME,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    }
    throw p31Enoent(op, p);
  };

  const deps: AnalyzerFsDeps = {
    readdir: async (p) => {
      const key = norm(p);
      const children = dirs.get(key);
      if (!children) throw p31Enoent('scandir', p);
      readdirs.push(key);
      return [...children].sort().map((name) => {
        const childKey = norm(path.join(key, name));
        const isDir = dirs.has(childKey);
        return {
          name,
          isDirectory: () => isDir,
          isFile: () => !isDir,
          isSymbolicLink: () => false,
        };
      });
    },
    lstat: async (p) => statOf(p, 'lstat'),
    stat: async (p) => statOf(p, 'stat'),
    readFile: async (p) => {
      const c = contents.get(norm(p));
      if (c === undefined) throw p31Enoent('open', p);
      return c;
    },
    yieldNow: () => Promise.resolve(),
  };

  return {
    deps,
    readdirs,
    resetRecords() {
      readdirs.length = 0;
    },
    setSize(p, size) {
      const key = norm(p);
      if (!files.has(key)) throw p31Enoent('stat', p);
      files.set(key, size);
    },
  };
}

/** 一次 analyzer 失效场景：嵌套深度、被删文件的快照字节数与就地增量。 */
interface P31CacheScenario {
  /** ExecutionSavesBucket 之下的额外嵌套层数（0~2，恒落在 maxDepth=8 之内） */
  extraDepth: number;
  archiveName: string;
  archiveSize: number;
  /** 就地增量，恒 ≥ 1，保证与快照不等 */
  delta: number;
  siblingSize: number;
  sessionSize: number;
}

const p31CacheScenarioArb: fc.Arbitrary<P31CacheScenario> = fc.record({
  extraDepth: fc.integer({ min: 0, max: 2 }),
  archiveName: hex32Arb,
  archiveSize: fc.integer({ min: 1, max: 1_000_000 }),
  delta: fc.integer({ min: 1, max: 100_000 }),
  siblingSize: fc.integer({ min: 1, max: 100_000 }),
  sessionSize: fc.integer({ min: 1, max: 100_000 }),
});

interface P31Layout {
  userDataDir: string;
  storeRoot: string;
  bucketDir: string;
  deepDir: string;
  deepFile: string;
  /** 与被删文件同级之外的旁支：其**子**目录恒不该被重新枚举 */
  siblingDir: string;
  siblingParent: string;
  siblingFile: string;
  sessionDir: string;
  manifestPath: string;
  sessionFile: string;
  /** 被删文件所在目录到 UserDataDir 的完整祖先链（含两端） */
  ancestors: string[];
}

/** 由场景算出全部路径（纯字符串计算，不落盘）。 */
function p31Layout(sc: P31CacheScenario): P31Layout {
  const userDataDir = path.join(P31_RUN_DIR, 'Kiro');
  const roots = buildClassifyRoots(userDataDir);
  const workspaceId = workspaceIdCandidates(P31_WORKSPACE)[0];
  const bucketDir = path.join(roots.storeRoot, workspaceId, roots.savesBucket);
  const subs = Array.from({ length: sc.extraDepth }, (_, i) => `sub${i}`);
  const deepDir = subs.length ? path.join(bucketDir, ...subs) : bucketDir;
  const deepFile = path.join(deepDir, sc.archiveName);
  const siblingParent = path.join(bucketDir, 'other');
  const siblingDir = path.join(siblingParent, 'nested');
  const sessionDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(P31_WORKSPACE)[0]);

  const ancestors: string[] = [];
  let cur = path.normalize(deepDir);
  const stop = path.normalize(userDataDir);
  for (let i = 0; i < 64; i++) {
    ancestors.push(cur);
    if (cur === stop) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return {
    userDataDir,
    storeRoot: roots.storeRoot,
    bucketDir,
    deepDir,
    deepFile,
    siblingDir,
    siblingParent,
    siblingFile: path.join(siblingDir, 'b'.repeat(32)),
    sessionDir,
    manifestPath: path.join(sessionDir, MANIFEST_FILENAME),
    sessionFile: path.join(sessionDir, `${TARGET_SESSION_ID}.json`),
    ancestors,
  };
}

/** SessionManifest 的内容与字节数：空数组，2 字节。 */
const P31_MANIFEST_TEXT = '[]';
const P31_MANIFEST_BYTES = 2;

/* ------------------- credits 段：真实 ArchiveIndex 夹具 ------------------- */

/** credits 段的工作区 fsPath（只用于算 workspaceId 目录名）。 */
const P31_CREDITS_WORKSPACE = 'D:\\Projects\\P31Credits';
/**
 * 落盘的存档文件名（全小写 hex32，`refreshIndex` 只认这个形态）。
 * 取字母而非数字：数字没有大小写，用数字名的话「大小写变体恒不命中索引键」这条
 * 未登记路径向量会退化成与原路径逐字节相同的串，那就不再是未登记路径了。
 */
const P31_INDEXED_NAMES = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(32));

// Feature: storage-usage-analytics, Property 31: 清理后的缓存失效范围与索引摘除
// Validates: Requirement 14.13
//
// 三段分别断言：
//   (a) cleaner 段 8：`CleanerDeps.invalidate` 的实参恒等于**成功删除**的路径集合
//       （失败与跳过的路径恒不在其中），且全部成功 / 部分成功 / 全部失败三种结局下
//       恒被调用**恰一次**；取消与空计划（未进入删除流程）恒不调用。
//   (b) analyzer：`invalidateForDeletedFiles` 打掉自被删文件所在目录向上到 StoreRoot
//       （直至扫描根 UserDataDir）的完整祖先链，并丢弃 StorageCache 汇总——用真实实现
//       配注入的 PathResolver / 只读 fs，靠**再扫描**行为观测：失效前 force 统计仍命中
//       陈旧聚合、根本不重新枚举深层目录；失效后连不带 force 的统计都会重新枚举整条
//       祖先链并读到新字节，而旁支子树的缓存不受影响（证明这是逐级失效而非整表清空）。
//   (c) credits：`dropArchiveEntries` 摘除的索引键集合恒等于被删存档路径集合，
//       返回值恒为实际摘除条目数（未登记路径恒计 0、恒不误删其它键）。
describe('Property 31: 清理后的缓存失效范围与索引摘除', () => {
  it('Property 31: invalidate 的实参恒等于成功删除的路径集合，且全成/部分/全败恒各调用一次', async () => {
    await fc.assert(
      fc.asyncProperty(p31ScenarioArb, async (sc) => {
        const rec = p30Fs(sc);
        const archives = p30Archives(sc);

        // 确认之后、复核之前注入 TOCTOU 变更（段 5 的两条跳过分支）
        const confirmThenMutate: CleanerDeps['confirm'] = async () => {
          for (const t of sc.targets) {
            if (t.kind === 'skip-missing') rec.removeFile(t.path);
            else if (t.kind === 'skip-changed') {
              rec.setFile(t.path, { size: t.size + t.delta, mtimeMs: t.mtimeMs });
            }
          }
          return 'confirm';
        };

        const { cleaner, invalidateCalls } = makeCleanerRecordingInvalidate(
          rec,
          archives,
          [],
          confirmThenMutate
        );
        // 计划在确认之前生成，故其路径集合与快照恒为变更前的形态
        const plan = await cleaner.plan(sc.mode, TARGET_SESSION_ID, '标题');
        const result = await cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');

        expect(result.state).toBe('done');

        const byKey = new Map(sc.targets.map((t) => [keyOf(t.path), t]));
        /** 计划内条目的期望归类：SessionFile（不在 byKey 里）按 `ok` 处理。 */
        const kindOf = (p: string): P30Kind => byKey.get(keyOf(p))?.kind ?? 'ok';
        const expectedDeletedKeys = new Set(
          plan.files.filter((f) => p31IsDeletedKind(kindOf(f.path))).map((f) => keyOf(f.path))
        );

        // ---- (a1) 段 8 恒执行且恒只执行一次——全部成功 / 部分成功 / 全部失败皆然 ----
        // 「全部失败」时 deletedPaths 为空数组，钩子照样被调用（空集失效是无害的空操作，
        // 但「结束就失效」这条不变式必须成立，否则失败分支会静默跳过失效）
        expect(invalidateCalls.length).toBe(1);
        const passed = invalidateCalls[0];
        const passedKeys = new Set(passed.map(keyOf));

        // ---- (a2) 实参集合恒等于成功删除的路径集合 ----
        expect(passedKeys).toEqual(expectedDeletedKeys);
        expect(passed.length).toBe(result.deletedFiles);
        expect(passedKeys.size).toBe(passed.length); // 无重复路径

        // ---- (a3) 实参恒 ⊆ plan.files，且恒不含失败 / 跳过的路径 ----
        const planKeys = new Set(plan.files.map((f) => keyOf(f.path)));
        for (const k of passedKeys) expect(planKeys.has(k)).toBe(true);
        for (const f of result.failed) expect(passedKeys.has(keyOf(f.path))).toBe(false);
        for (const s of result.skipped) expect(passedKeys.has(keyOf(s.path))).toBe(false);

        // ---- (a4) 被传入失效的路径确实已从盘上消失（失效范围与磁盘事实一致） ----
        for (const p of passed) expect(rec.exists(p)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 31: 取消确认与空计划恒不触发失效（未进入删除流程）', async () => {
    await fc.assert(
      fc.asyncProperty(p31ScenarioArb, async (sc) => {
        // 取消：段 3 直接返回，段 8 恒不执行
        const recCancel = p30Fs(sc);
        const cancel: CleanerDeps['confirm'] = async () => 'cancel';
        const cancelled = makeCleanerRecordingInvalidate(
          recCancel,
          p30Archives(sc),
          [],
          cancel
        );
        const cancelResult = await cancelled.cleaner.run(sc.mode, TARGET_SESSION_ID, '标题');
        expect(cancelResult.state).toBe('cancelled');
        expect(cancelled.invalidateCalls).toEqual([]);

        // 空计划：attachment 模式下无任何目标归因存档 → noop，段 8 同样不执行
        const recEmpty = recordingCleanerFs(buildTree([]));
        const empty = makeCleanerRecordingInvalidate(recEmpty, []);
        const emptyResult = await empty.cleaner.run('attachment', TARGET_SESSION_ID, '标题');
        expect(emptyResult.state).toBe('noop');
        expect(empty.invalidateCalls).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 31: invalidateForDeletedFiles 打掉整条祖先链并丢弃 StorageCache，旁支子树缓存不受影响', async () => {
    await fc.assert(
      fc.asyncProperty(p31CacheScenarioArb, async (sc) => {
        const L = p31Layout(sc);
        const mem = p31MemFs({
          root: L.userDataDir,
          files: {
            [L.deepFile]: sc.archiveSize,
            [L.siblingFile]: sc.siblingSize,
            [L.sessionFile]: sc.sessionSize,
            [L.manifestPath]: P31_MANIFEST_BYTES,
          },
          contents: { [L.manifestPath]: P31_MANIFEST_TEXT },
        });

        let archiveCalls = 0;
        const analyzer = new StorageAnalyzer({
          pathResolver: p31PathResolver(),
          workspacePath: P31_WORKSPACE,
          now: () => P31_FIXED_NOW,
          fsDeps: mem.deps,
          // 存档索引注入为空集并计数：本属性只关心目录聚合缓存与 StorageCache 的失效，
          // 调用次数即「这一次统计有没有真正重算」的可观测信号
          listArchives: () => {
            archiveCalls += 1;
            return [];
          },
        });

        // ---- 首次统计：填充各级 SubtreeCache 与 StorageCache ----
        const first = await analyzer.getSummary({ force: true });
        expect(first.status).toBe('ok');
        const baseTotal = sc.archiveSize + sc.siblingSize + sc.sessionSize + P31_MANIFEST_BYTES;
        expect(first.totalBytes).toBe(baseTotal);
        expect(archiveCalls).toBe(1);

        // 60 秒内不带 force：命中 StorageCache，不重算
        await analyzer.getSummary();
        expect(archiveCalls).toBe(1);

        // ---- 就地改字节数：祖先目录的 mtimeMs 与直接子条目数都没变 ----
        mem.setSize(L.deepFile, sc.archiveSize + sc.delta);
        mem.resetRecords();

        // force 只清 StorageCache、不动 SubtreeCache：顶层即命中陈旧聚合，读不到增长，
        // 也根本不会枚举到被改文件所在目录
        const stale = await analyzer.getSummary({ force: true });
        expect(archiveCalls).toBe(2);
        expect(stale.totalBytes).toBe(baseTotal);
        const staleSeen = new Set(mem.readdirs);
        expect(staleSeen.has(path.normalize(L.userDataDir))).toBe(true);
        expect(staleSeen.has(path.normalize(L.deepDir))).toBe(false);

        // ---- 显式失效被删文件的整条祖先链 ----
        analyzer.invalidateForDeletedFiles([L.deepFile]);
        mem.resetRecords();

        // 不带 force 也重算 → StorageCache 汇总恒被丢弃
        const fresh = await analyzer.getSummary();
        expect(archiveCalls).toBe(3);
        // 读到新字节 → 自被删文件所在目录到扫描根的每一级缓存都被打掉了：
        // 任何一级残留都会在那一级命中陈旧聚合、不再往下递归
        expect(fresh.totalBytes).toBe(baseTotal + sc.delta);

        const freshSeen = new Set(mem.readdirs);
        // 完整祖先链（含被删文件所在目录、StoreRoot 与扫描根）恒被重新枚举
        for (const dir of L.ancestors) expect(freshSeen.has(dir)).toBe(true);
        expect(L.ancestors).toContain(path.normalize(L.storeRoot));
        expect(L.ancestors).toContain(path.normalize(L.userDataDir));
        expect(L.ancestors).toContain(path.normalize(L.bucketDir));

        // 旁支：其父目录因祖先链失效而被重新枚举，但它自身的子树缓存仍命中，
        // 故 `nested` 恒不被重新枚举——失效是逐级的，不是把整张缓存表清空
        expect(freshSeen.has(path.normalize(L.siblingParent))).toBe(true);
        expect(freshSeen.has(path.normalize(L.siblingDir))).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 31: dropArchiveEntries 摘除的索引键集合恒等于被删存档路径集合', () => {
    // ArchiveIndex 是 credits.ts 的模块内 Map，只能由 `listArchiveEntries` 的目录扫描
    // 填充（没有注入点），因此这一段必须落一次真实临时目录——这是本属性里唯一无法用
    // 内存夹具观测的部分。确定性靠三件事保证：固定的文件名与内容、固定的 `Date.now`
    // （4 秒扫描节流窗口因此恒不过期，摘除后的再次读取恒不重扫），以及每轮开头显式
    // `__clearCreditCacheForTest()` 重建索引。
    const base = mkTempDir('kcs-p31-credits-');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(P31_FIXED_NOW);
    try {
      const storeRoot = path.join(base, 'User', 'globalStorage', 'kiro.kiroagent');
      const bucketDir = path.join(
        storeRoot,
        hash32(P31_CREDITS_WORKSPACE),
        hash32(SAVES_BUCKET_KEY)
      );
      fs.mkdirSync(bucketDir, { recursive: true });
      const indexed = P31_INDEXED_NAMES.map((name) => {
        const full = path.join(bucketDir, name);
        fs.writeFileSync(
          full,
          JSON.stringify({ chatSessionId: TARGET_SESSION_ID, usageSummary: [] }),
          'utf8'
        );
        return full;
      });

      /** 未登记路径：形态上不是存档（非 hex32）、或压根不在盘上、或大小写变体。 */
      const notIndexedArb: fc.Arbitrary<string> = fc.oneof(
        fc.constant(path.join(bucketDir, 'not-an-archive.json')),
        fc.constant(path.join(bucketDir, 'f'.repeat(32))),
        fc.constant(path.join(storeRoot, 'workspace-sessions', 's1.json')),
        // 大小写变体：索引键是 readdir 给出的原始小写串，故它恒不该命中任何条目
        fc.constant(path.join(bucketDir, P31_INDEXED_NAMES[0].toUpperCase()))
      );

      fc.assert(
        fc.property(
          fc.subarray(indexed),
          fc.array(notIndexedArb, { maxLength: 3 }),
          (deleted, extras) => {
            __clearCreditCacheForTest();
            const before = listArchiveEntries(storeRoot).map((e) => e.path);
            // 夹具自检：五条存档全部进索引，否则下面的集合等式无从谈起
            expect(new Set(before)).toEqual(new Set(indexed));

            // 混合输入：被删存档路径 + 未登记路径（顺序随机，含空集）
            const input = [...deleted, ...extras];
            const dropped = dropArchiveEntries(input);

            // 返回值恒为**实际**摘除条目数：未登记路径恒计 0
            expect(dropped).toBe(new Set(deleted).size);

            // 节流窗口内不重扫，故这次读到的就是摘除后的索引本身
            const after = listArchiveEntries(storeRoot).map((e) => e.path);
            const deletedSet = new Set(deleted);
            const removedKeys = new Set(before.filter((p) => !after.includes(p)));

            // 被摘除的索引键集合恒等于被删存档路径集合
            expect(removedKeys).toEqual(deletedSet);
            // 其余条目恒原样保留（未登记路径既不摘除自己、也不牵连别人）
            expect(new Set(after)).toEqual(new Set(indexed.filter((p) => !deletedSet.has(p))));
            // 磁盘文件仍在：摘除只动进程内索引，不做任何文件系统写入
            for (const p of indexed) expect(fs.existsSync(p)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    } finally {
      clock.mockRestore();
      __clearCreditCacheForTest();
      rmTempDir(base);
    }
  });

  it('Property 31: 生成器覆盖全部成功、部分成功与全部失败三种结局（覆盖度守卫）', () => {
    const samples = fc.sample(p31ScenarioArb, 400);
    const isFail = (k: P30Kind): boolean =>
      k === 'lock-fail' || k === 'fatal' || k === 'reject-symlink' || k === 'reject-not-allowed';

    // 全部成功：一条都不失败、不跳过
    expect(samples.some((sc) => sc.targets.every((t) => p31IsDeletedKind(t.kind)))).toBe(true);
    // 全部失败：attachment 模式且每条都失败（full 会并入恒成功的 SessionFile）
    expect(
      samples.some((sc) => sc.mode === 'attachment' && sc.targets.every((t) => isFail(t.kind)))
    ).toBe(true);
    // 部分成功：同一次运行里既有成功又有失败或跳过
    expect(
      samples.some(
        (sc) =>
          sc.targets.some((t) => p31IsDeletedKind(t.kind)) &&
          sc.targets.some((t) => isFail(t.kind) || t.kind.startsWith('skip-'))
      )
    ).toBe(true);
    // 嵌套深度覆盖 0~2 层（祖先链长度因此不是常量）
    const depths = new Set(fc.sample(p31CacheScenarioArb, 200).map((s) => s.extraDepth));
    expect([...depths].sort()).toEqual([0, 1, 2]);
  });
});

/* ------------------------------------------------------------------ *
 * Property 14(b)
 *
 * 复用文件头的共享夹具与生成器（`CLEANER_FIXTURE` / `CLEANER_ROOTS` / `archivePath` /
 * `sessionFilePath` / `TARGET_SESSION_ID`）以及 Property 27/29/30 处的 `buildTree` /
 * `keyOf` / `autoConfirm` / 整套 p30 场景机制（`p30EntryArb` / `p30ScenarioArb` /
 * `materializeP30` / `p30Fs` / `p30Archives`）——于是「调用面白名单」与「三类计数守恒」
 * （Property 30）跑在**同一批**场景上：全成 / 部分失败（锁类、致命）/ 校验拒绝 /
 * TOCTOU 跳过都覆盖到，而不是另造一套只走happy path的夹具。
 *
 * 本属性钉的是**两段式调用面**的可写一半（Req 9.8、11.8）：统计侧的只读一半由
 * `tests/storage.analyzer.property.spec.ts` 的 Property 14(a) 覆盖（调用名集合
 * ⊆ `{ readdir, lstat, stat, readFile, readFileSync }`）。两侧的断言形态刻意一致——
 * 运行期记录 + 静态模块图审查，因为二者各有盲区：
 *
 * | 观测手段 | 抓得住 | 抓不住 |
 * | --- | --- | --- |
 * | 运行期记录（注入的假 fs） | 实际发生的调用名与实参路径 | 走 `fs/promises` 直连、绕过注入点的调用 |
 * | 静态源码审查 | 模块图里根本不存在的 API（`rm` / `rmdir` / `rename` / `cp`） | 运行期才决定的实参 |
 *
 * 因此两者都做：前者断言「实际调了什么」，后者断言「压根拿不到什么」。
 * ------------------------------------------------------------------ */

import type { CleanerFsDeps } from '../src/storage/cleaner';

/**
 * WritableFsAllowlist 的四个调用（Req 9.8 原文：针对单个文件的 `unlink`，以及针对
 * SessionManifest 的 `readFile` 与 `writeFile`；`stat` 为计划快照与 TOCTOU 复核所需）。
 */
const P14B_ALLOWED_FS_OPS: readonly string[] = ['unlink', 'stat', 'readFile', 'writeFile'];

/**
 * `delay` 单列说明：它是段 6 锁类重试的**等待钩子**（缺省为 `setTimeout` 包装），
 * 不做任何文件系统访问，故不属于 WritableFsAllowlist，也不该被算作一次 fs 调用。
 * 它出现在 `CleanerFsDeps` 里纯粹是为了让测试免于真睡 200ms（等待次数与参数由
 * Property 30 断言）。因此白名单断言分两层：注入点键集合允许它，fs 调用面不允许。
 */
const P14B_DELAY_OP = 'delay';

/**
 * 1.x 目录型会话专用、且**仅**为它放宽的两格（Requirement 10.1、10.5，design D6）。
 *
 * - `readdir`：生成计划时枚举会话目录一次；`rmdir` 前重新枚举确认为空一次。
 *   Req 10.5 要求「重新枚举确认为空」紧邻删除动作，把它外包出去就等于在
 *   「确认为空」与「执行删除」之间留一层可被绕过的间隙。
 * - `rmdir`：**非递归**。选它而不是 `rm -r` 的根本理由是它删不掉非空目录
 *   （返回 `ENOTEMPTY`），因此即便实参校验被绕过，最坏后果也只是一次失败而非数据丢失。
 *
 * 两者在 **0.9x 流程里恒不被取用**，下面 P14B(a) 的运行期断言仍按四个调用比对
 * ——本组属性跑的全是 0.9x 夹具（`CLEANER_ROOTS` 不含两个新根），
 * 因此「放宽了注入面」与「0.9x 的实际调用面没变」两件事同时成立。
 */
const P14B_NEW_LAYOUT_OPS: readonly string[] = ['readdir', 'rmdir'];

/** 注入点**允许存在**的全部键 = 四个 fs 调用 + 等待钩子 + 1.x 专用两格。 */
const P14B_ALLOWED_DEP_KEYS: readonly string[] = [
  ...P14B_ALLOWED_FS_OPS,
  P14B_DELAY_OP,
  ...P14B_NEW_LAYOUT_OPS,
];

/**
 * 显式黑名单：递归删除 / 目录删除 / 重命名 / 移动 / 复制 / 目录创建 / 目录枚举，
 * 以及「单文件覆盖写」之外的其它写入形态（追加、截断、流式写、句柄写、同步变体）。
 *
 * 白名单断言（⊆ 四个调用）逻辑上已经蕴含「黑名单一个都不出现」，但仍显式逐个断言：
 * 白名单一旦被后续改动放宽，`toContain` 会跟着放宽，而这份黑名单不会——它是对
 * Req 9.8 后半句「SHALL 不使用递归删除、目录删除、重命名或移动 API」的直接编码。
 */
const P14B_FORBIDDEN_OPS: readonly string[] = [
  // 递归删除（`rmdir` 的**非递归**形态是本次唯一放宽的一格，见下方 P14B_NEW_LAYOUT_OPS）
  'rm',
  'rmSync',
  'rmdirSync',
  'rimraf',
  // 重命名 / 移动
  'rename',
  'renameSync',
  'mv',
  'move',
  // 复制
  'cp',
  'cpSync',
  'copyFile',
  'copyFileSync',
  // 目录创建；以及目录枚举的同步/句柄形态（异步 `readdir` 是 1.x 计划与 rmdir 前
  // 「重新枚举确认为空」所必需的一格，见 P14B_NEW_LAYOUT_OPS）
  'mkdir',
  'mkdirSync',
  'readdirSync',
  'opendir',
  // 单文件覆盖写之外的写入形态
  'unlinkSync',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'truncate',
  'ftruncate',
  'open',
  'openSync',
  'createWriteStream',
  'createReadStream',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync',
  'chmod',
  'chown',
  'utimes',
];

/** 夹具里的目录路径：`unlink` / `writeFile` 的实参恒不该是它们中的任何一个。 */
const P14B_DIR_KEYS: ReadonlySet<string> = new Set(
  [
    CLEANER_FIXTURE.userDataDir,
    CLEANER_FIXTURE.storeRoot,
    CLEANER_FIXTURE.sessionsRoot,
    CLEANER_FIXTURE.sessionDir,
    CLEANER_FIXTURE.otherSessionDir,
    CLEANER_FIXTURE.savesDir,
    CLEANER_FIXTURE.metadataDir,
    CLEANER_FIXTURE.otherSavesDir,
  ].map(keyOf)
);

/** SessionManifest 的比较键：`writeFile` / `readFile` 的实参恒只有它。 */
const P14B_MANIFEST_KEY = keyOf(MANIFEST_PATH);

/**
 * 组装一个 cleaner，并把注入的 fs **包一层 Proxy**记录被访问过的属性名。
 *
 * 为什么不只看 `rec.calls`：那只记录「被调用到的四个方法」，而 Proxy 记录的是
 * 「模块**尝试取用**过哪些键」。若某天有人写下 `fsDeps.rm?.(dir)`，调用记录里不会
 * 出现任何东西（`rm` 是 undefined，可选调用静默跳过），但属性访问会被抓到。
 *
 * 刻意不改模块内已有的 `makeCleaner` / `makeCleanerRecordingInvalidate`：Property
 * 27/29/30/31 的用例都挂在它们上面。
 */
function makeCleanerWatchingFs(
  rec: ReturnType<typeof recordingCleanerFs>,
  archives: readonly ArchiveInfo[],
  confirm: CleanerDeps['confirm'] = autoConfirm
): { cleaner: SessionCleaner; accessedFsKeys: string[] } {
  const accessedFsKeys: string[] = [];
  const watched = new Proxy(rec.deps as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') accessedFsKeys.push(prop);
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as CleanerFsDeps;

  const deps: CleanerDeps = {
    fs: watched,
    audit: () => {},
    confirm,
    archives: () => archives,
    invalidate: () => {},
    roots: CLEANER_ROOTS,
    lineages: () => [],
  };
  return { cleaner: new SessionCleaner(deps), accessedFsKeys };
}

/** 四类 SessionManifest 原文形态，决定段 7 的三态结果与「有没有 writeFile」。 */
type P14bManifestKind = 'with-target' | 'without-target' | 'invalid-json' | 'not-array';

interface P14bManifest {
  kind: P14bManifestKind;
  text: string;
}

/**
 * 清单原文生成器。`with-target` 是唯一会真正触发 `writeFile` 的形态
 * （`removed > 0` → 单次覆盖写回）；`without-target` 的 `removed === 0` 走
 * 「无需写盘」分支、`invalid-json` / `not-array` 走解析失败分支——三者恒零次
 * `writeFile`。四类都覆盖，才能让「writeFile 只在该出现时出现」不是空话。
 */
const p14bManifestArb: fc.Arbitrary<P14bManifest> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.array(fc.constantFrom('other-1', 'other-2', 'S1', 's10'), { maxLength: 3 }),
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom<number | string>(2, 4, '\t')
      )
      .map(([others, at, indent]) => {
        const entries: unknown[] = others.map((id) => ({ sessionId: id, title: `标题-${id}` }));
        const idx = Math.min(at, entries.length);
        entries.splice(idx, 0, { sessionId: TARGET_SESSION_ID, title: '目标会话' });
        return { kind: 'with-target' as const, text: JSON.stringify(entries, null, indent) };
      }),
  },
  {
    weight: 2,
    arbitrary: fc
      .array(fc.constantFrom('other-1', 'other-2', 'S1', 's10', ' s1'), { maxLength: 4 })
      .map((others) => ({
        kind: 'without-target' as const,
        text: JSON.stringify(
          others.map((id) => ({ sessionId: id, title: `标题-${id}` })),
          null,
          2
        ),
      })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('{不是 JSON', '[{"sessionId":', '', 'null-ish,,')
      .map((text) => ({ kind: 'invalid-json' as const, text })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('{"sessions":[]}', '"just a string"', '42', 'null')
      .map((text) => ({ kind: 'not-array' as const, text })),
  }
);

interface P14bScenario {
  run: P30Scenario;
  manifest: P14bManifest;
}

const p14bScenarioArb: fc.Arbitrary<P14bScenario> = fc.record({
  run: p30ScenarioArb,
  manifest: p14bManifestArb,
});

/** 由场景组装记录型 fs：p30 的内存树 + 指定形态的 SessionManifest 原文。 */
function p14bFs(sc: P14bScenario): ReturnType<typeof recordingCleanerFs> {
  const rec = p30Fs(sc.run);
  rec.setFile(MANIFEST_PATH, sc.manifest.text);
  return rec;
}

/** 段 7 的期望三态：仅 `full` 且清单里确有目标条目时才写盘。 */
function expectedManifestState(sc: P14bScenario): 'ok' | 'skipped' | 'failed' {
  if (sc.run.mode !== 'full') return 'skipped';
  switch (sc.manifest.kind) {
    case 'with-target':
      return 'ok';
    case 'without-target':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** 一次 `run()` 之后对调用记录做的白名单/黑名单断言（三条早退路径也复用）。 */
function assertCallSurface(
  rec: ReturnType<typeof recordingCleanerFs>,
  accessedFsKeys: readonly string[]
): void {
  const ops = new Set(rec.calls.map((c) => c.op));

  // (a1) 记录到的调用名恒 ⊆ 四个 fs 调用 + delay 等待钩子
  for (const op of ops) expect(P14B_ALLOWED_DEP_KEYS).toContain(op);
  // (a2) 去掉 delay 之后，fs 调用面恒 ⊆ { unlink, stat, readFile, writeFile }
  for (const op of [...ops].filter((o) => o !== P14B_DELAY_OP)) {
    expect(P14B_ALLOWED_FS_OPS).toContain(op);
  }
  // (a3) 黑名单逐个断言：递归删除 / 目录删除 / 重命名 / 移动 / 复制 / 目录枚举 /
  //      其它写入形态恒不出现——既没被调用，也没被**取用**过
  for (const bad of P14B_FORBIDDEN_OPS) {
    expect(ops.has(bad)).toBe(false);
    expect(accessedFsKeys).not.toContain(bad);
  }
  // (a4) 被取用过的注入点键恒 ⊆ 白名单（连尝试都没有过）
  for (const k of new Set(accessedFsKeys)) expect(P14B_ALLOWED_DEP_KEYS).toContain(k);

  // (a5) 每次调用的首个实参恒是字符串路径（delay 除外，它的实参是毫秒数）
  for (const c of rec.calls) {
    if (c.op === P14B_DELAY_OP) expect(typeof c.args[0]).toBe('number');
    else expect(typeof c.args[0]).toBe('string');
  }
  // (a6) 写类调用（unlink / writeFile）的实参恒不是任何一个目录
  for (const c of rec.calls) {
    if (c.op !== 'unlink' && c.op !== 'writeFile') continue;
    expect(P14B_DIR_KEYS.has(keyOf(c.args[0] as string))).toBe(false);
  }
}

// Feature: storage-usage-analytics, Property 14(b): 两段式调用面约束——删除路径白名单
// Validates: Requirements 9.8, 11.8
//
// 四组断言：
//   (a) `run()` 期间记录到的调用名集合恒 ⊆ `{ unlink, stat, readFile, writeFile }`
//       （`delay` 是注入的等待钩子、非 fs 调用，单列在注入点键白名单里），且对一组
//       递归删除 / 目录删除 / 重命名 / 移动 / 复制 / 目录枚举 / 其它写入形态的黑名单
//       调用名恒不出现——不仅没被调用，连属性都没被取用过（Proxy 记录）。
//   (b) `writeFile` 的实参路径恒只有 SessionManifest 一个、至多一次，且仅在
//       `mode === 'full'` 且清单里确有目标条目时出现；`attachment` 模式恒零次
//       `writeFile`、零次 `readFile`（清单读改写是 full 独有的附加操作）。
//   (c) 取消确认 / 空计划 / 同 sessionId 互斥拒绝三条早退路径恒不产生任何写调用。
//   (d) 注入点自身的形状：`CleanerFsDeps` 的键恒 ⊆ 白名单，模块图里对 `fs/promises`
//       恒只具名导入 `{ lstat, readFile, unlink, writeFile }`，且源码里恒不出现
//       `rm` / `rmdir` / `rename` / `cp` 等 API 名——「误删整个目录」在模块图上不可能发生。
describe('Property 14(b): 两段式调用面约束——删除路径白名单', () => {
  it('Property 14(b): run() 的调用名集合恒 ⊆ { unlink, stat, readFile, writeFile }，恒不含递归删除/目录删除/重命名/移动', async () => {
    await fc.assert(
      fc.asyncProperty(p14bScenarioArb, async (sc) => {
        const rec = p14bFs(sc);
        // 确认之后、复核之前注入 TOCTOU 变更（段 5 的两条跳过分支）
        const confirmThenMutate: CleanerDeps['confirm'] = async () => {
          for (const t of sc.run.targets) {
            if (t.kind === 'skip-missing') rec.removeFile(t.path);
            else if (t.kind === 'skip-changed') {
              rec.setFile(t.path, { size: t.size + t.delta, mtimeMs: t.mtimeMs });
            }
          }
          return 'confirm';
        };

        const { cleaner, accessedFsKeys } = makeCleanerWatchingFs(
          rec,
          p30Archives(sc.run),
          confirmThenMutate
        );
        const result = await cleaner.run(sc.run.mode, TARGET_SESSION_ID, '标题');
        expect(result.state).toBe('done');

        assertCallSurface(rec, accessedFsKeys);

        // 非空验证：白名单断言不是因为一次调用都没发生
        const ops = new Set(rec.calls.map((c) => c.op));
        expect(ops.has('stat')).toBe(true);
        // 目标存档恒 ≥ 1 条，其中至少一条会走到 unlink 或被拒绝/跳过；
        // 计划非空即意味着段 4~6 确实跑过（三类计数守恒见 Property 30）
        expect(result.deletedFiles + result.failed.length + result.skipped.length).toBeGreaterThan(
          0
        );

        // SessionManifest 恒不被 unlink（清单要改不要删）
        const unlinkKeys = rec.calls
          .filter((c) => c.op === 'unlink')
          .map((c) => keyOf(c.args[0] as string));
        expect(unlinkKeys).not.toContain(P14B_MANIFEST_KEY);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 14(b): writeFile 实参路径恒只有 SessionManifest 一个，且仅 full 模式出现（attachment 恒零次）', async () => {
    await fc.assert(
      fc.asyncProperty(p14bScenarioArb, async (sc) => {
        const rec = p14bFs(sc);
        const { cleaner, accessedFsKeys } = makeCleanerWatchingFs(rec, p30Archives(sc.run));
        const result = await cleaner.run(sc.run.mode, TARGET_SESSION_ID, '标题');
        expect(result.state).toBe('done');

        assertCallSurface(rec, accessedFsKeys);

        const writeCalls = rec.calls.filter((c) => c.op === 'writeFile');
        const readCalls = rec.calls.filter((c) => c.op === 'readFile');

        // (b1) writeFile 的实参路径集合恒 ⊆ { SessionManifest }，且至多一次
        expect(new Set(writeCalls.map((c) => keyOf(c.args[0] as string)))).toEqual(
          new Set(writeCalls.length ? [P14B_MANIFEST_KEY] : [])
        );
        expect(writeCalls.length).toBeLessThanOrEqual(1);
        // 单次覆盖写：第二实参是字符串全文、第三实参恒为 'utf8'（无临时文件、无 rename）
        for (const c of writeCalls) {
          expect(typeof c.args[1]).toBe('string');
          expect(c.args[2]).toBe('utf8');
        }

        // (b2) readFile 同样恒只对 SessionManifest
        expect(new Set(readCalls.map((c) => keyOf(c.args[0] as string)))).toEqual(
          new Set(readCalls.length ? [P14B_MANIFEST_KEY] : [])
        );

        // (b3) attachment 模式恒零次 writeFile、零次 readFile（清单读改写是 full 独有）
        if (sc.run.mode !== 'full') {
          expect(writeCalls.length).toBe(0);
          expect(readCalls.length).toBe(0);
          expect(result.manifestUpdated).toBe('skipped');
        } else {
          // full 模式恒读一次清单；写盘只发生在「确有目标条目可移除」时
          expect(readCalls.length).toBe(1);
          expect(writeCalls.length).toBe(sc.manifest.kind === 'with-target' ? 1 : 0);
        }

        // (b4) 段 7 三态与清单形态一一对应（writeFile 出现 ⟺ manifestUpdated === 'ok'）
        expect(result.manifestUpdated).toBe(expectedManifestState(sc));
        expect(writeCalls.length === 1).toBe(result.manifestUpdated === 'ok');

        // (b5) 写回内容恒是移除目标条目后的清单，且恒不含目标 sessionId 条目
        if (writeCalls.length === 1) {
          const written = JSON.parse(writeCalls[0].args[1] as string) as Array<{
            sessionId?: unknown;
          }>;
          expect(Array.isArray(written)).toBe(true);
          expect(written.some((e) => e?.sessionId === TARGET_SESSION_ID)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property 14(b): 取消确认 / 空计划 / 互斥拒绝三条早退路径恒不产生任何写调用', async () => {
    await fc.assert(
      fc.asyncProperty(p14bScenarioArb, async (sc) => {
        // ---- 取消：段 3 直接返回，调用面恒只剩计划阶段的 stat ----
        const recCancel = p14bFs(sc);
        const cancelled = makeCleanerWatchingFs(
          recCancel,
          p30Archives(sc.run),
          async () => 'cancel'
        );
        const cancelResult = await cancelled.cleaner.run(sc.run.mode, TARGET_SESSION_ID, '标题');
        expect(cancelResult.state).toBe('cancelled');
        assertCallSurface(recCancel, cancelled.accessedFsKeys);
        expect(new Set(recCancel.calls.map((c) => c.op))).toEqual(new Set(['stat']));

        // ---- 空计划：连 stat 都没有（无候选存档、attachment 不牵涉 SessionFile） ----
        const recEmpty = recordingCleanerFs(buildTree([]));
        const empty = makeCleanerWatchingFs(recEmpty, []);
        const emptyResult = await empty.cleaner.run('attachment', TARGET_SESSION_ID, '标题');
        expect(emptyResult.state).toBe('noop');
        assertCallSurface(recEmpty, empty.accessedFsKeys);
        expect(recEmpty.calls.filter((c) => c.op === 'unlink' || c.op === 'writeFile')).toEqual([]);

        // ---- 互斥拒绝：段 0 就返回，恒零新增调用 ----
        const recBusy = p14bFs(sc);
        let openGate: () => void = () => {};
        const gate = new Promise<void>((r) => (openGate = r));
        let atConfirm: () => void = () => {};
        const reachedConfirm = new Promise<void>((r) => (atConfirm = r));
        const busy = makeCleanerWatchingFs(recBusy, p30Archives(sc.run), async () => {
          atConfirm();
          await gate;
          return 'confirm';
        });
        const first = busy.cleaner.run(sc.run.mode, TARGET_SESSION_ID, '标题');
        await reachedConfirm; // 第一次运行已占位并停在确认处
        const callsBefore = recBusy.calls.length;
        const rejected = await busy.cleaner.run(sc.run.mode, TARGET_SESSION_ID, '标题');
        expect(rejected.state).toBe('rejected');
        expect(rejected.deletedFiles).toBe(0);
        expect(rejected.manifestUpdated).toBe('skipped');
        // 被拒绝的那次恒不产生任何文件系统调用
        expect(recBusy.calls.length).toBe(callsBefore);
        openGate();
        await first;
        assertCallSurface(recBusy, busy.accessedFsKeys);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * 静态审查补齐运行期记录的盲区：注入点只约束「经 `CleanerFsDeps` 发生的调用」，
   * 而模块完全可以绕过注入点直连 `fs/promises`——那种调用在 `rec.calls` 里看不见。
   * 写入的唯一入口是 fs 的写 API，因此「模块图里连 `rm` / `rmdir` / `rename` / `cp`
   * 的 import 都不存在」是比运行期计数更强的事实（design 的 WritableFsAllowlist 约束）。
   * 形态与 Property 14(a) 的同类审查一致（见 `tests/storage.analyzer.property.spec.ts`）。
   */
  it('Property 14(b): CleanerFsDeps 的键恒 ⊆ 白名单，模块图恒只具名导入 { lstat, readFile, unlink, writeFile }', () => {
    /**
     * 允许出现在 `fs/promises` 具名导入里的 API：三个写/删单文件 + `lstat` 作 `stat` 缺省，
     * 外加 1.x 目录型会话所需的两格 —— `readdir`（枚举计划 + rmdir 前复核为空）与
     * **非递归** `rmdir`（收掉自己刚清空的目录）。
     *
     * 这是本次适配里**唯一**放宽的安全边界（Req 10.1、design D6）。放宽幅度的三条约束：
     * ① `rmdir` 是非递归的，删不掉非空目录；② 实参恒经 `assertRemovableDir` 限定在
     * 「NewSessionsRoot 之内、等于目标会话目录或其子目录」；③ 每一级删除前都重新枚举确认为空。
     * 递归删除（`rm` / `rmSync` / `rmdirSync` / `rimraf`）与 `rename` / `cp` / `mkdir`
     * 一个都没有放进来，仍由下面的 (d3) 逐个断言其在源码里不出现。
     */
    const WRITABLE_ALLOWLIST_IMPORTS = new Set([
      'lstat',
      'readFile',
      'unlink',
      'writeFile',
      'readdir',
      'rmdir',
    ]);

    const raw = fs.readFileSync(path.resolve(process.cwd(), 'src/storage/cleaner.ts'), 'utf8');
    // 去掉注释：可写边界的说明文字里正列着 `rm` / `rmdir` / `rename` / `cp` 等词
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // (d1) 没有 require('fs')：命名空间式取用会把整个写 API 面一起带进来
    expect(code).not.toMatch(/require\(\s*'(fs|fs\/promises|node:fs[^']*)'\s*\)/);

    // (d2) 对 fs 的导入恒是具名导入，且每个名字都在允许集合里
    const fsImports = [
      ...code.matchAll(/import\s+([^;]+?)\s+from\s+'(fs|fs\/promises|node:fs[^']*)'/g),
    ];
    // 非空验证：确实存在一条 fs 导入（否则下面的循环是空转）
    expect(fsImports.length).toBeGreaterThan(0);
    for (const [, clause] of fsImports) {
      expect(clause).not.toMatch(/\*\s+as/);
      expect(clause.trim().startsWith('{')).toBe(true);
      for (const rawName of clause.replace(/[{}]/g, '').split(',')) {
        const name = rawName.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        expect(WRITABLE_ALLOWLIST_IMPORTS.has(name)).toBe(true);
      }
    }

    // (d3) 源码里恒不出现递归删除 / 目录删除 / 重命名 / 移动 / 复制 / 目录枚举 API 名。
    //      `symlink` 类名字例外——`DELETE_REJECT_REASONS.symlink` 是拒绝原因的键名
    //      （Req 8.6 的第 ⑤ 步），与 fs 的 `symlink` API 无关。
    const forbiddenIdents = P14B_FORBIDDEN_OPS.filter(
      (n) => n !== 'symlink' && n !== 'symlinkSync'
    );
    for (const name of forbiddenIdents) {
      expect(code).not.toMatch(new RegExp(`\\b${name}\\b`));
    }

    // (d4) `CleanerFsDeps` 的成员名恒 ⊆ 白名单（模块连递归删除 API 都拿不到——
    //      注入点根本没有那一档键，调用方即使想传也传不进来）
    const body = /export interface CleanerFsDeps\s*\{([\s\S]*?)\n\}/.exec(code)?.[1];
    expect(body).toBeDefined();
    const members = [...body!.matchAll(/^\s*(\w+)\??\s*:/gm)].map((m) => m[1]);
    expect(new Set(members)).toEqual(new Set(P14B_ALLOWED_DEP_KEYS));
    for (const bad of P14B_FORBIDDEN_OPS) expect(members).not.toContain(bad);
  });

  it('Property 14(b): 生成器覆盖两种模式与四类清单形态（覆盖度守卫）', () => {
    const samples = fc.sample(p14bScenarioArb, 400);

    // 两种模式都被采到
    expect(new Set(samples.map((s) => s.run.mode))).toEqual(
      new Set<CleanupMode>(['attachment', 'full'])
    );
    // 四类清单形态都被采到（其中只有 with-target 会触发 writeFile）
    expect(new Set(samples.map((s) => s.manifest.kind))).toEqual(
      new Set<P14bManifestKind>(['with-target', 'without-target', 'invalid-json', 'not-array'])
    );
    // full + with-target（唯一写盘组合）必须被稳定采到，否则 (b) 的写盘一侧是空话
    expect(
      samples.some((s) => s.run.mode === 'full' && s.manifest.kind === 'with-target')
    ).toBe(true);
    // 删除结局仍覆盖 p30 的八档（本属性与 Property 30 跑同一批场景）
    const kinds = new Set<P30Kind>();
    for (const s of samples) for (const t of s.run.targets) kinds.add(t.kind);
    for (const k of P30_KINDS) expect([...kinds]).toContain(k);
  });
});
