import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as os from 'os';
import * as path from 'path';
import { hash32 } from '../src/credits';
import { getKiroUserDataDir, type PathResolverDeps } from '../src/paths';
import {
  buildClassifyRoots,
  classifyPath,
  CATEGORY_ORDER,
  SAVES_BUCKET_KEY,
  METADATA_BUCKET_KEY,
} from '../src/storage/classify';
import { emptyCategoryTotals, scanTree, type CategoryTotals } from '../src/storage/scanner';
import type { StorageCategory } from '../src/storage/types';
import { mkTempDir, mkTree, rmTempDir, type TreeSpec } from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享常量、独立判据（oracle）与生成器
 * 供本文件内 Property 1 及后续追加的属性测试共用
 * ------------------------------------------------------------------ */

/** `<UserDataDir>` 到 StoreRoot 的相对段（Requirement 1.5 的路径形态） */
const STORE_SEGS = ['User', 'globalStorage', 'kiro.kiroagent'] as const;

/** 桶目录名按 Requirement 1.5 的公式在测试内独立计算，不复用被测模块的派生值 */
const SAVES = hash32(SAVES_BUCKET_KEY);
const META = hash32(METADATA_BUCKET_KEY);
/** 桶名大写变体：不是 Kiro 生成的桶目录，用于验证区分大小写匹配（Requirement 8.3） */
const SAVES_UPPER = SAVES.toUpperCase();

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * 分类规则的**独立实现**：只按相对 UserDataDir 的路径段数组做前缀比较，
 * 不使用 `path.relative` / `isUnder`。它与 `classifyPath` 各自独立地表达
 * Requirement 1.4~1.8 的有序规则，因此两者一致即构成差分验证——
 * 尤其能抓住"裸字符串前缀比较"这类错误（`logs-old` 不应被判成 `logs`）。
 */
function expectedFromSegs(segs: readonly string[]): StorageCategory {
  const startsWith = (prefix: readonly string[]): boolean =>
    prefix.every((s, i) => segs[i] === s);

  // 规则 1：<SessionsRoot> 下
  if (startsWith([...STORE_SEGS, 'workspace-sessions'])) return 'sessionJson';

  // 规则 2~4：<StoreRoot>/<WorkspaceId> 下的三分
  if (startsWith(STORE_SEGS)) {
    const rest = segs.slice(STORE_SEGS.length);
    if (rest.length >= 1 && HEX32.test(rest[0])) {
      if (rest.length >= 2 && rest[1] === SAVES) return 'executionSaves';
      if (rest.length >= 2 && rest[1] === META) return 'executionMetadata';
      return 'unclassified';
    }
  }

  // 规则 5、6、7
  if (segs[0] === 'logs') return 'logs';
  if (startsWith(['User', 'workspaceStorage'])) return 'workspaceStorage';
  return 'otherFiles';
}

/**
 * 段名池：刻意混入同前缀兄弟（`logs` / `logs-old` / `logsx`、
 * `workspace-sessions` / `workspace-sessions-old`、
 * `workspaceStorage` / `workspaceStorageOld`）、桶名及其大写变体、
 * 合法与非法的 hex32 形态，以及以 `..` 开头但合法的目录名 `..bar`。
 *
 * 刻意**不**混入 `logs` / `User` 等前缀目录的大小写变体：`path.relative`
 * 在 win32 上按不区分大小写比较前缀，混入后断言会随平台漂移；而桶名与
 * WorkspaceId 是段内的严格字符串 / 正则比较，跨平台确定，故可放心覆盖。
 */
const NAME_POOL = [
  'a',
  'b',
  'logs',
  'logs-old',
  'logsx',
  'User',
  'globalStorage',
  'kiro.kiroagent',
  'workspace-sessions',
  'workspace-sessions-old',
  'workspaceStorage',
  'workspaceStorageOld',
  'Cache',
  '..bar',
  'sessions.json',
  SAVES,
  META,
  SAVES_UPPER,
  'a'.repeat(32),
  'A'.repeat(32),
  'zz' + 'a'.repeat(30),
] as const;

const segsArb = fc.array(fc.constantFrom(...NAME_POOL), { minLength: 0, maxLength: 7 });

const FAKE_ROOTS = [
  path.resolve('fixtures', 'kcs-fake', 'Kiro'),
  path.resolve('fixtures', 'kcs fake 2', 'Kiro Data'),
];

/* ------------------------------------------------------------------ *
 * 目录树夹具生成器（真实临时目录）
 * ------------------------------------------------------------------ */

type EntryKind =
  | 'sessionJson'
  | 'sessionsManifest'
  | 'saves'
  | 'savesNested'
  | 'metadata'
  | 'otherBucket'
  | 'upperSavesBucket'
  | 'storeDirectChild'
  | 'nonHexStoreChild'
  | 'logs'
  | 'logsOld'
  | 'workspaceStorage'
  | 'workspaceStorageOld'
  | 'cache'
  | 'rootFile';

const ENTRY_KINDS: readonly EntryKind[] = [
  'sessionJson',
  'sessionsManifest',
  'saves',
  'savesNested',
  'metadata',
  'otherBucket',
  'upperSavesBucket',
  'storeDirectChild',
  'nonHexStoreChild',
  'logs',
  'logsOld',
  'workspaceStorage',
  'workspaceStorageOld',
  'cache',
  'rootFile',
];

interface EntrySeed {
  kind: EntryKind;
  bytes: number;
  hex: string;
  leaf: string;
  sub: string;
}

const entryArb = fc.record<EntrySeed>({
  kind: fc.constantFrom(...ENTRY_KINDS),
  bytes: fc.integer({ min: 0, max: 96 }),
  hex: fc.hexaString({ minLength: 32, maxLength: 32 }),
  leaf: fc.constantFrom('a.json', 'b.bin', 'c'),
  sub: fc.constantFrom('s1', 's2'),
});

/**
 * 把第 i 个种子落成一条相对 UserDataDir 的路径段序列。
 *
 * 每条路径都带上索引前缀（叶子名与 WorkspaceId 的前 2 位），保证同一夹具内
 * 路径两两不同——否则在不区分大小写的文件系统上，`<hex>` 与 `<HEX>`、
 * 同名叶子会被合并成一个条目，使"文件数 = 条目数"的断言随平台漂移。
 */
function materialize(seed: EntrySeed, i: number): string[] {
  const tag = i.toString(16).padStart(2, '0');
  const wid = (tag + seed.hex).slice(0, 32);
  const leaf = `${tag}-${seed.leaf}`;
  const store = [...STORE_SEGS];
  switch (seed.kind) {
    case 'sessionJson':
      return [...store, 'workspace-sessions', `key${tag}`, leaf];
    case 'sessionsManifest':
      return [...store, 'workspace-sessions', `sessions-${tag}.json`];
    case 'saves':
      return [...store, wid, SAVES, leaf];
    case 'savesNested':
      return [...store, wid, SAVES, seed.sub, leaf];
    case 'metadata':
      return [...store, wid, META, leaf];
    case 'otherBucket':
      return [...store, wid, `bucket${tag}`, leaf];
    case 'upperSavesBucket':
      return [...store, wid, SAVES_UPPER, leaf];
    case 'storeDirectChild':
      return [...store, wid, leaf];
    case 'nonHexStoreChild':
      return [...store, `ws-${tag}`, leaf];
    case 'logs':
      return ['logs', leaf];
    case 'logsOld':
      return ['logs-old', leaf];
    case 'workspaceStorage':
      return ['User', 'workspaceStorage', `st${tag}`, leaf];
    case 'workspaceStorageOld':
      return ['User', 'workspaceStorageOld', leaf];
    case 'cache':
      return ['Cache', leaf];
    case 'rootFile':
      return [leaf];
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

/* ------------------------------------------------------------------ *
 * Property 1
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 1: 分类构成 UserDataDir 上的一个划分
// Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 8.2, 8.3
describe('Property 1: 分类构成 UserDataDir 上的一个划分', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 1（全域性 + 互斥性）: 任意路径恒被映射到唯一一个已知分类，且与按段边界的独立判据一致', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FAKE_ROOTS),
        fc.array(segsArb, { minLength: 1, maxLength: 8 }),
        (root, segsList) => {
          const roots = buildClassifyRoots(root);

          const inside = segsList.map((segs) => ({
            full: path.join(root, ...segs),
            expected: expectedFromSegs(segs),
          }));
          // 统计根之外的路径同样必须有归属（全域性），落入 otherFiles
          const outside = [
            { full: path.resolve(root, '..', 'OtherApp', 'x'), expected: 'otherFiles' as const },
            { full: path.resolve(root, '..'), expected: 'otherFiles' as const },
          ];
          const cases = [...inside, ...outside];

          for (const c of cases) {
            const got = classifyPath(roots, c.full);
            // 全域性：返回值恒为 7 个已知分类之一
            expect(CATEGORY_ORDER).toContain(got);
            // 确定性：同一路径重复分类结果相同
            expect(classifyPath(roots, c.full)).toBe(got);
            // 与独立判据一致（按路径段边界比较、桶名区分大小写）
            expect(got).toBe(c.expected);
          }

          // 互斥性：按分类装桶后，每个路径恰好属于一个桶，且各桶两两不相交、并集覆盖全部路径
          const buckets = new Map<StorageCategory, Set<string>>(
            CATEGORY_ORDER.map((c) => [c, new Set<string>()])
          );
          const all = new Set(cases.map((c) => c.full));
          for (const p of all) buckets.get(classifyPath(roots, p))!.add(p);

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
          expect(sizeSum).toBe(union.size);
          expect(union).toEqual(all);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 1（守恒）: 扫描结果满足 Σ categories[i].bytes === totalBytes 与 Σ files === totalFiles', async () => {
    base = mkTempDir('kcs-classify-prop-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(fc.array(entryArb, { minLength: 1, maxLength: 12 }), async (seeds) => {
        const root = path.join(fixtureBase, `r${runSeq++}`);
        const spec: TreeSpec = {};
        const expectedTotals: CategoryTotals = emptyCategoryTotals();

        seeds.forEach((seed, i) => {
          const segs = materialize(seed, i);
          addPath(spec, segs, seed.bytes);
          const agg = expectedTotals[expectedFromSegs(segs)];
          agg.bytes += seed.bytes;
          agg.files += 1;
        });
        mkTree(root, spec);

        const roots = buildClassifyRoots(root);
        const res = await scanTree(root, { roots });

        let sumBytes = 0;
        let sumFiles = 0;
        for (const c of CATEGORY_ORDER) {
          sumBytes += res.totals[c].bytes;
          sumFiles += res.totals[c].files;
        }
        // 守恒：各分类之和恒等于总量（Requirement 1.3、1.9）
        expect(sumBytes).toBe(res.totalBytes);
        expect(sumFiles).toBe(res.totalFiles);
        // 夹具深度与可读性均在预算内，故不应有跳过条目
        expect(res.skippedCount).toBe(0);
        expect(res.totalFiles).toBe(seeds.length);
        // 每个文件都落入独立判据预期的那一个分类
        expect(res.totals).toEqual(expectedTotals);
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 17
 * ------------------------------------------------------------------ */

/**
 * 与 tests/paths.spec.ts 的 `depsWith` 同一套约定：existsSync 恒为 true，
 * 使 PathResolver 一定选中首个候选，从而把「平台 × 环境变量 × homedir」三个
 * 注入维度与磁盘状态解耦。
 */
function depsWith(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): PathResolverDeps {
  return {
    platform,
    env,
    homedir: () => home,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

/**
 * 分隔符归一化：注入的路径可能是**非本平台形态**（在 Windows 上注入
 * `/home/u/...`），而 `path.join` 按**运行平台**的分隔符拼接，会把注入路径里的
 * `/` 改写成 `\`。裸 `startsWith` 因此会随运行平台漂移，故前缀与段比较全部
 * 在归一化后的字符串上进行。
 */
function norm(p: string): string {
  return p.replace(/[\\/]+/g, '/');
}

interface Injection {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

/**
 * 三平台各自的注入组合。home / env 取值刻意用 `kcs-` 前缀的虚构名，与真实
 * `os.homedir()` / `%APPDATA%` 不重叠，这样"结果里不含环境泄漏值"的断言才有意义。
 * darwin 一路同时给出 APPDATA 与 XDG_CONFIG_HOME，验证它们不会串台影响结果。
 */
const injectionArb: fc.Arbitrary<Injection> = fc.oneof(
  fc.record({
    platform: fc.constant<NodeJS.Platform>('win32'),
    home: fc.constantFrom('C:\\Users\\kcs-u1', 'D:\\home\\kcs u2'),
    env: fc.constantFrom<NodeJS.ProcessEnv>(
      {},
      { APPDATA: 'E:\\kcs-roaming' },
      { APPDATA: 'F:\\kcs roam 2', XDG_CONFIG_HOME: '/kcs-xdg' }
    ),
  }),
  fc.record({
    platform: fc.constant<NodeJS.Platform>('darwin'),
    home: fc.constantFrom('/Users/kcs-u1', '/Users/kcs u2'),
    env: fc.constantFrom<NodeJS.ProcessEnv>(
      {},
      { APPDATA: 'E:\\kcs-roaming', XDG_CONFIG_HOME: '/kcs-xdg' }
    ),
  }),
  fc.record({
    platform: fc.constant<NodeJS.Platform>('linux'),
    home: fc.constantFrom('/home/kcs-u1', '/home/kcs u2'),
    env: fc.constantFrom<NodeJS.ProcessEnv>(
      {},
      { XDG_CONFIG_HOME: '/kcs-xdg/cfg' },
      { XDG_CONFIG_HOME: '/kcs-xdg/cfg', APPDATA: 'E:\\kcs-roaming' }
    ),
  })
);

/** ClassifyRoots 中「路径型」成员相对 UserDataDir 的固定段序列（与平台无关） */
const ROOT_REL_SEGS = {
  storeRoot: [...STORE_SEGS],
  sessionsRoot: [...STORE_SEGS, 'workspace-sessions'],
  logsDir: ['logs'],
  workspaceStorageDir: ['User', 'workspaceStorage'],
} as const;

/** 运行环境的真实路径值：不得出现在任何由注入派生的根里 */
const AMBIENT_VALUES = [os.homedir(), process.env.APPDATA, process.env.XDG_CONFIG_HOME]
  .filter((v): v is string => typeof v === 'string' && v.length > 0)
  .map(norm);

// Feature: storage-usage-analytics, Property 17: 统计根恒由 PathResolver 派生
// Validates: Requirements 8.1
describe('Property 17: 统计根恒由 PathResolver 派生', () => {
  it('Property 17: 任意平台/环境变量/homedir 注入下，各统计根恒以 UserDataDir 为前缀且不含硬编码平台绝对路径', () => {
    fc.assert(
      fc.property(injectionArb, injectionArb, (a, b) => {
        const udA = getKiroUserDataDir(depsWith(a.platform, a.env, a.home));
        const udB = getKiroUserDataDir(depsWith(b.platform, b.env, b.home));
        expect(udA).not.toBeNull();
        expect(udB).not.toBeNull();

        const rootsA = buildClassifyRoots(udA!);
        const rootsB = buildClassifyRoots(udB!);

        // ClassifyRoots.userDataDir 必须原样回传 PathResolver 的结果，不做任何改写
        expect(rootsA.userDataDir).toBe(udA);
        expect(rootsB.userDataDir).toBe(udB);

        const baseA = norm(udA!);

        for (const [key, relSegs] of Object.entries(ROOT_REL_SEGS)) {
          const member = norm(rootsA[key as keyof typeof ROOT_REL_SEGS]);

          // (1) 以 UserDataDir 为前缀，且前缀止于路径段边界
          expect(member.startsWith(baseA)).toBe(true);
          const rest = member.slice(baseA.length);
          expect(rest.startsWith('/')).toBe(true);

          // (2) 剩余部分是与平台无关的固定段序列——即根 = UserDataDir + 常量后缀，
          //     不存在任何独立于注入的绝对路径成分
          expect(rest.split('/').filter((s) => s.length > 0)).toEqual([...relSegs]);

          // (3) 剩余部分不含盘符（`X:`）等平台专属绝对路径痕迹
          expect(/[A-Za-z]:/.test(rest)).toBe(false);

          // (4) 不含运行环境的真实 home / APPDATA / XDG 值（除非注入结果本就含它）
          for (const ambient of AMBIENT_VALUES) {
            if (!baseA.includes(ambient)) expect(member).not.toContain(ambient);
          }
        }

        // (5) 桶名只是目录名而非路径：恒为小写 hex32，不含分隔符与盘符
        for (const bucket of [rootsA.savesBucket, rootsA.metadataBucket]) {
          expect(HEX32.test(bucket)).toBe(true);
        }
        // 桶名与注入无关（由固定哈希输入串派生），两次注入必须一致
        expect(rootsA.savesBucket).toBe(rootsB.savesBucket);
        expect(rootsA.metadataBucket).toBe(rootsB.metadataBucket);

        // (6) 注入不同 ⇒ 各路径型根随之全部变化；不同注入的根互不落入对方的 UserDataDir
        if (norm(udA!) !== norm(udB!)) {
          const baseBNorm = norm(udB!);
          for (const key of Object.keys(ROOT_REL_SEGS) as (keyof typeof ROOT_REL_SEGS)[]) {
            const mA = norm(rootsA[key]);
            const mB = norm(rootsB[key]);
            expect(mA).not.toBe(mB);
            expect(mA.startsWith(baseBNorm)).toBe(false);
            expect(mB.startsWith(baseA)).toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
