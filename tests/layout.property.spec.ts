/**
 * Kiro 1.x 存储适配 —— 布局检测的属性：
 *
 * - Property 3 布局判定完备且互斥
 *
 * 全部夹具都经注入的 `LayoutFsDeps`（`homedir` / `existsSync` / `statSync` / `readdirSync`）
 * 在内存里构造，**不落盘、不触碰真实 `~/.kiro` 与真实用户数据目录**：布局检测只做
 * 路径拼接、存在性判断、目录枚举与 stat，注入这四个点即可完整覆盖，连临时目录都不需要。
 *
 * 判定式在测试侧**独立重写**（{@link expectedSides}）：刻意不复用 `src/layout.ts` 的
 * `hasSessionSubdir` / `hasOldSessionFile` / `isOldSessionFileName`——复用被测实现的
 * 内部函数会让断言与实现一起犯同一个错，属性就退化成同义反复。测试侧的判据直接来自
 * 需求原文：
 *
 * - 新侧成立 = 新工作区目录存在 **且含至少一个子目录**；
 * - 旧侧成立 = 旧工作区目录存在 **且含至少一个 `<sessionId>.json`**
 *   （`sessions.json` 是清单、`._migration-*.json` 是迁移标记，两者都不算会话）。
 *
 * 夹具路径由 `computeWsHash16` / `encodeWorkspaceKeys` 拼出——它们是**夹具的构造输入**
 * （其自身正确性由 Property 1 / Property 2 在 `paths.newlayout.property.spec.ts` 里锁定），
 * 不是本属性的判据来源。
 */
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { detectLayout } from '../src/layout';
import type { LayoutFsDeps, LayoutRoots, StorageLayout } from '../src/layout';
import { computeWsHash16, encodeWorkspaceKeys } from '../src/paths';

/* ------------------------------------------------------------------ *
 * 假文件系统的固定路径
 *
 * 一律用 `path.join` 拼接，故在 Windows 与 POSIX 宿主上都自洽；注入
 * `platform: 'linux'` + `env: {}` 让 UserDataDir 走「XDG_CONFIG_HOME 缺省 →
 * `<home>/.config/Kiro`」这一条确定分支，避免测试结果随宿主平台或宿主环境变量漂移。
 * ------------------------------------------------------------------ */

const FS_ROOT = path.sep === '\\' ? 'C:\\' : '/';
const HOME = path.join(FS_ROOT, 'home', 'fake-kiro-user');

const HOME_KIRO = path.join(HOME, '.kiro');
const NEW_SESSIONS = path.join(HOME_KIRO, 'sessions');
const NEW_SESSION_INDEX = path.join(HOME_KIRO, 'session-index');

const USER_DATA = path.join(HOME, '.config', 'Kiro');
const OLD_STORE_ROOT = path.join(USER_DATA, 'User', 'globalStorage', 'kiro.kiroagent');
const OLD_SESSIONS = path.join(OLD_STORE_ROOT, 'workspace-sessions');

const LAYOUT_VALUES: readonly StorageLayout[] = ['new-only', 'old-only', 'both', 'none'];

type RootKey = Exclude<keyof LayoutRoots, 'layout'>;

/** 新侧四个字段：`~/.kiro` 缺失时它们整条链置 null，且恒不连带旧侧（Req 1.5）。 */
const NEW_SIDE_KEYS: readonly RootKey[] = [
  'homeKiroDir',
  'newSessionsRoot',
  'newSessionIndexRoot',
  'newWorkspaceSessionDir',
];

/** 旧侧四个字段：UserDataDir / OldSessionsRoot 缺失时整条链置 null，恒不连带新侧（Req 1.6）。 */
const OLD_SIDE_KEYS: readonly RootKey[] = [
  'userDataDir',
  'oldStoreRoot',
  'oldSessionsRoot',
  'oldWorkspaceSessionDir',
];

const ROOT_KEYS: readonly RootKey[] = [...NEW_SIDE_KEYS, ...OLD_SIDE_KEYS];

/** 两个「工作区级」字段：未打开工作区时它们为 null，其余根仍保留（Req 1.10）。 */
const WORKSPACE_LEVEL_KEYS: readonly RootKey[] = [
  'newWorkspaceSessionDir',
  'oldWorkspaceSessionDir',
];

/** 除工作区级字段外的各个根：未打开工作区时恒保留。 */
const ROOT_LEVEL_KEYS: readonly RootKey[] = ROOT_KEYS.filter(
  (k) => !WORKSPACE_LEVEL_KEYS.includes(k)
);

/* ------------------------------------------------------------------ *
 * 夹具形态
 * ------------------------------------------------------------------ */

/**
 * 新工作区目录的形态。`filesAndSubdirs` 刻意把文件排在子目录**之前**：
 * 「含至少一个子目录」要求扫过前面的文件继续找，只看首个条目的实现会在这里翻车。
 */
type NewDirShape = 'missing' | 'empty' | 'filesOnly' | 'sessionSubdirs' | 'filesAndSubdirs';

const NEW_DIR_SHAPES: readonly NewDirShape[] = [
  'missing',
  'empty',
  'filesOnly',
  'sessionSubdirs',
  'filesAndSubdirs',
];

/**
 * 旧工作区目录的形态。其中三种是「空壳旧目录」的关键边界——目录里有 `.json`，
 * 但一条旧会话都没有：
 *
 * - `manifestOnly`：只剩会话清单 `sessions.json`；
 * - `markersOnly`：只剩迁移标记 `._migration-<uuid>.json`（说明会话已搬到 1.x）；
 * - `nonJsonOnly`：只有近似但不匹配的文件名（`sessions.jsonl` / `session.json.bak` …）。
 *
 * 它们被误判为「仍有旧会话」时，`new-only` 会被误报成 `both`，进而让旧残留维度、
 * 双源合并与清理边界全部跑偏，故必须稳定覆盖。
 */
type OldDirShape =
  | 'missing'
  | 'empty'
  | 'manifestOnly'
  | 'markersOnly'
  | 'nonJsonOnly'
  | 'sessionFiles'
  | 'sessionFilesAfterNoise';

const OLD_DIR_SHAPES: readonly OldDirShape[] = [
  'missing',
  'empty',
  'manifestOnly',
  'markersOnly',
  'nonJsonOnly',
  'sessionFiles',
  'sessionFilesAfterNoise',
];

interface NewEntry {
  name: string;
  kind: 'dir' | 'file';
}

interface NewSide {
  shape: NewDirShape;
  entries: NewEntry[];
}

interface OldSide {
  shape: OldDirShape;
  names: string[];
}

interface Fixture {
  /** 当前工作区绝对路径（各夹具路径由它派生）。 */
  workspacePath: string;
  /** 旧目录名取 `encodeWorkspaceKeys` 的第几个候选（覆盖盘符/斜杠变体命中）。 */
  oldKeyIndex: number;
  homeKiroExists: boolean;
  newSessionsExists: boolean;
  newSessionIndexExists: boolean;
  userDataExists: boolean;
  oldSessionsExists: boolean;
  newSide: NewSide;
  oldSide: OldSide;
}

/* ------------------------------------------------------------------ *
 * 生成器
 * ------------------------------------------------------------------ */

const HEX_CHARS = '0123456789abcdef'.split('');

const hexArb = (len: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...HEX_CHARS), { minLength: len, maxLength: len })
    .map((cs) => cs.join(''));

/** 1.x 的会话目录名：新建会话为 `sess_<hex>`，迁移过来的是裸 uuid。 */
const sessionIdArb: fc.Arbitrary<string> = fc.oneof(
  hexArb(8).map((h) => `sess_${h}`),
  hexArb(8).map((h) => `${h}-1111-4222-8333-444455556666`)
);

/** 会话目录内的文件名（它们**不是**子目录，故不满足新侧条件）。 */
const newFileNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('session.json', 'messages.jsonl', '.DS_Store'),
  hexArb(4).map((h) => `publish-${h}.cursor`)
);

/**
 * 0.9x 的会话文件名。除常规 `<sessionId>.json` 外掺入两类**近似样本**：
 * `<x>-sessions.json`（以 `sessions.json` 结尾但不等于它）与 `migration-<x>.json`
 * （含 migration 但没有 `._` 前缀）——它们都仍是会话文件，把排除判据写成
 * `endsWith('sessions.json')` 或 `includes('migration')` 会在这里暴露。
 */
const oldSessionFileNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: sessionIdArb.map((id) => `${id}.json`) },
  { weight: 1, arbitrary: hexArb(4).map((h) => `${h}-sessions.json`) },
  { weight: 1, arbitrary: hexArb(4).map((h) => `migration-${h}.json`) }
);

const migrationMarkerNameArb: fc.Arbitrary<string> = hexArb(8).map(
  (h) => `._migration-${h}.json`
);

/** 后缀近似但不是 `.json` 的文件名（`.jsonl` / `.json.bak` 都不算旧会话）。 */
const nonJsonNameArb: fc.Arbitrary<string> = fc.constantFrom(
  'sessions.jsonl',
  'session.json.bak',
  'notes.txt',
  'index.md'
);

const toFile = (name: string): NewEntry => ({ name, kind: 'file' });
const toDir = (name: string): NewEntry => ({ name, kind: 'dir' });

const newMissingArb = fc.constant<NewSide>({ shape: 'missing', entries: [] });
const newEmptyArb = fc.constant<NewSide>({ shape: 'empty', entries: [] });

const newFilesOnlyArb: fc.Arbitrary<NewSide> = fc
  .uniqueArray(newFileNameArb, { minLength: 1, maxLength: 3 })
  .map((ns) => ({ shape: 'filesOnly', entries: ns.map(toFile) }));

const newSessionSubdirsArb: fc.Arbitrary<NewSide> = fc
  .uniqueArray(sessionIdArb, { minLength: 1, maxLength: 3 })
  .map((ns) => ({ shape: 'sessionSubdirs', entries: ns.map(toDir) }));

const newFilesAndSubdirsArb: fc.Arbitrary<NewSide> = fc
  .tuple(
    fc.uniqueArray(newFileNameArb, { minLength: 1, maxLength: 2 }),
    fc.uniqueArray(sessionIdArb, { minLength: 1, maxLength: 2 })
  )
  .map(([files, dirs]) => ({
    shape: 'filesAndSubdirs',
    entries: [...files.map(toFile), ...dirs.map(toDir)],
  }));

const oldMissingArb = fc.constant<OldSide>({ shape: 'missing', names: [] });
const oldEmptyArb = fc.constant<OldSide>({ shape: 'empty', names: [] });
const oldManifestOnlyArb = fc.constant<OldSide>({
  shape: 'manifestOnly',
  names: ['sessions.json'],
});

const oldMarkersOnlyArb: fc.Arbitrary<OldSide> = fc
  .uniqueArray(migrationMarkerNameArb, { minLength: 1, maxLength: 3 })
  .map((names) => ({ shape: 'markersOnly', names }));

const oldNonJsonOnlyArb: fc.Arbitrary<OldSide> = fc
  .uniqueArray(nonJsonNameArb, { minLength: 1, maxLength: 3 })
  .map((names) => ({ shape: 'nonJsonOnly', names }));

const oldSessionFilesArb: fc.Arbitrary<OldSide> = fc
  .uniqueArray(oldSessionFileNameArb, { minLength: 1, maxLength: 3 })
  .map((names) => ({ shape: 'sessionFiles', names }));

/** 清单与迁移标记排在会话文件**之前**：排除逻辑必须继续往后扫，而不是看首个条目就收工。 */
const oldSessionFilesAfterNoiseArb: fc.Arbitrary<OldSide> = fc
  .tuple(
    fc.uniqueArray(migrationMarkerNameArb, { minLength: 1, maxLength: 2 }),
    fc.uniqueArray(oldSessionFileNameArb, { minLength: 1, maxLength: 2 })
  )
  .map(([markers, sessions]) => ({
    shape: 'sessionFilesAfterNoise',
    names: ['sessions.json', ...markers, ...sessions],
  }));

/**
 * 任意新侧形态。给「含子目录」的两种形态更高权重，使 `new-only` / `both` 在
 * 100 次运行内被稳定采到（覆盖度守卫会验证这一点）。
 */
const anyNewSideArb: fc.Arbitrary<NewSide> = fc.oneof(
  { weight: 1, arbitrary: newMissingArb },
  { weight: 1, arbitrary: newEmptyArb },
  { weight: 1, arbitrary: newFilesOnlyArb },
  { weight: 3, arbitrary: newSessionSubdirsArb },
  { weight: 2, arbitrary: newFilesAndSubdirsArb }
);

const anyOldSideArb: fc.Arbitrary<OldSide> = fc.oneof(
  { weight: 1, arbitrary: oldMissingArb },
  { weight: 1, arbitrary: oldEmptyArb },
  { weight: 1, arbitrary: oldManifestOnlyArb },
  { weight: 1, arbitrary: oldMarkersOnlyArb },
  { weight: 1, arbitrary: oldNonJsonOnlyArb },
  { weight: 3, arbitrary: oldSessionFilesArb },
  { weight: 2, arbitrary: oldSessionFilesAfterNoiseArb }
);

/** 「空壳旧目录」：有文件甚至有 `.json`，但一条旧会话都没有。 */
const hollowOldSideArb: fc.Arbitrary<OldSide> = fc.oneof(
  oldEmptyArb,
  oldManifestOnlyArb,
  oldMarkersOnlyArb,
  oldNonJsonOnlyArb
);

/** 「新侧成立」的两种形态。 */
const productiveNewSideArb: fc.Arbitrary<NewSide> = fc.oneof(
  newSessionSubdirsArb,
  newFilesAndSubdirsArb
);

/** 「新侧不成立」的三种形态（目录缺失 / 为空 / 只有文件）。 */
const barrenNewSideArb: fc.Arbitrary<NewSide> = fc.oneof(
  newMissingArb,
  newEmptyArb,
  newFilesOnlyArb
);

/** 「旧侧成立」的两种形态。 */
const productiveOldSideArb: fc.Arbitrary<OldSide> = fc.oneof(
  oldSessionFilesArb,
  oldSessionFilesAfterNoiseArb
);

/** 各级根的存在性：多数为真（否则布局判定还没走到目录枚举就短路了），但两侧都要采到缺失。 */
const mostlyPresentArb: fc.Arbitrary<boolean> = fc.oneof(
  { weight: 6, arbitrary: fc.constant(true) },
  { weight: 1, arbitrary: fc.constant(false) }
);

/**
 * 工作区路径池：Windows 盘符两种大小写 / 两种斜杠方向、POSIX 路径、含空格与中文的路径。
 * WsHash16 的归一化不变性由 Property 1 单独覆盖，这里只要求路径本身有变化。
 */
const workspacePathArb: fc.Arbitrary<string> = fc.constantFrom(
  'd:\\Projects\\KiroExt\\KiroChatSearcher',
  'D:/SurErp/ERP-OMS-Workspaces',
  '/home/dev/my proj',
  'c:\\ws\\项目 A',
  '/var/lib/ws'
);

function fixtureArbOf(opts: {
  newSide: fc.Arbitrary<NewSide>;
  oldSide: fc.Arbitrary<OldSide>;
  rootsAlwaysPresent?: boolean;
}): fc.Arbitrary<Fixture> {
  const flag = opts.rootsAlwaysPresent === true ? fc.constant(true) : mostlyPresentArb;
  return fc.record<Fixture>({
    workspacePath: workspacePathArb,
    oldKeyIndex: fc.nat({ max: 7 }),
    homeKiroExists: flag,
    newSessionsExists: flag,
    newSessionIndexExists: flag,
    userDataExists: flag,
    oldSessionsExists: flag,
    newSide: opts.newSide,
    oldSide: opts.oldSide,
  });
}

/** 全形态夹具：各级根存在性 × 新旧目录形态的任意组合。 */
const fixtureArb = fixtureArbOf({ newSide: anyNewSideArb, oldSide: anyOldSideArb });

/** 各级根均存在的夹具：用于「单侧缺失不连带」与异常注入，避免断言退化成空话。 */
const rootsPresentFixtureArb = fixtureArbOf({
  newSide: anyNewSideArb,
  oldSide: anyOldSideArb,
  rootsAlwaysPresent: true,
});

/* ------------------------------------------------------------------ *
 * 虚拟文件系统
 * ------------------------------------------------------------------ */

interface FailureInjection {
  /** 命中即让 `readdirSync` 抛异常（模拟权限不足 / 枚举中途被删）。 */
  readdirThrowsOn?: (p: string) => boolean;
  /** 命中即让 `statSync` 抛异常。 */
  statThrowsOn?: (p: string) => boolean;
}

interface Vfs {
  deps: LayoutFsDeps;
  /** 依赖调用留痕：用于断言「未打开工作区时恒不枚举任何目录」。 */
  readdirCalls: string[];
  statCalls: string[];
}

function newWorkspaceDirOf(workspacePath: string): string {
  return path.join(NEW_SESSIONS, computeWsHash16(workspacePath));
}

function oldWorkspaceDirOf(workspacePath: string, keyIndex: number): string {
  const keys = encodeWorkspaceKeys(workspacePath);
  return path.join(OLD_SESSIONS, keys[keyIndex % keys.length]);
}

/**
 * 按夹具描述构造一套注入依赖。
 *
 * 子目录的存在性对父目录**取合取**（父不存在则子也不存在），使虚拟文件系统自洽：
 * 否则会出现「`~/.kiro` 不存在但 `~/.kiro/sessions/<hash>` 存在」这种真实磁盘上
 * 不可能的状态，断言据此得出的结论也就没有意义。
 */
function buildVfs(f: Fixture, fail: FailureInjection = {}): Vfs {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const entries = new Map<string, string[]>();

  // ---- 新侧 ----
  if (f.homeKiroExists) dirs.add(HOME_KIRO);
  const newSessionsPresent = f.homeKiroExists && f.newSessionsExists;
  if (newSessionsPresent) dirs.add(NEW_SESSIONS);
  if (f.homeKiroExists && f.newSessionIndexExists) dirs.add(NEW_SESSION_INDEX);

  if (newSessionsPresent && f.newSide.shape !== 'missing') {
    const newWsDir = newWorkspaceDirOf(f.workspacePath);
    dirs.add(newWsDir);
    entries.set(
      newWsDir,
      f.newSide.entries.map((e) => e.name)
    );
    for (const e of f.newSide.entries) {
      (e.kind === 'dir' ? dirs : files).add(path.join(newWsDir, e.name));
    }
  }

  // ---- 旧侧 ----
  if (f.userDataExists) dirs.add(USER_DATA);
  const oldSessionsPresent = f.userDataExists && f.oldSessionsExists;
  if (oldSessionsPresent) dirs.add(OLD_SESSIONS);

  if (oldSessionsPresent && f.oldSide.shape !== 'missing') {
    const oldWsDir = oldWorkspaceDirOf(f.workspacePath, f.oldKeyIndex);
    dirs.add(oldWsDir);
    entries.set(oldWsDir, [...f.oldSide.names]);
    for (const n of f.oldSide.names) files.add(path.join(oldWsDir, n));
  }

  const readdirCalls: string[] = [];
  const statCalls: string[] = [];

  const deps: LayoutFsDeps = {
    platform: 'linux',
    env: {},
    homedir: () => HOME,
    existsSync: (p) => dirs.has(p) || files.has(p),
    statSync: (p) => {
      statCalls.push(p);
      if (fail.statThrowsOn?.(p) === true) throw new Error(`EACCES: stat '${p}'`);
      if (dirs.has(p)) return { isDirectory: () => true };
      if (files.has(p)) return { isDirectory: () => false };
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    },
    readdirSync: (p) => {
      readdirCalls.push(p);
      if (fail.readdirThrowsOn?.(p) === true) throw new Error(`EACCES: scandir '${p}'`);
      const names = entries.get(p);
      if (names !== undefined) return [...names];
      if (dirs.has(p)) return [];
      throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    },
  };

  return { deps, readdirCalls, statCalls };
}

/* ------------------------------------------------------------------ *
 * 测试侧独立重写的判定式
 * ------------------------------------------------------------------ */

/** 旧会话文件名：`.json` 结尾，且既不是会话清单、也不是迁移标记（需求原文的直译）。 */
function isOldSessionFileNameDef(name: string): boolean {
  return name.endsWith('.json') && name !== 'sessions.json' && !name.startsWith('._migration-');
}

/** 四态映射写成穷举表，而不是嵌套三元——四个分支的完备与互斥在字面上就能核对。 */
function layoutOf(hasNew: boolean, hasOld: boolean): StorageLayout {
  if (hasNew && hasOld) return 'both';
  if (hasNew && !hasOld) return 'new-only';
  if (!hasNew && hasOld) return 'old-only';
  return 'none';
}

/** 从夹具描述直接推出两个条件的真假（不查虚拟 fs、不碰被测实现的内部函数）。 */
function expectedSides(f: Fixture, workspaceGiven: boolean): { hasNew: boolean; hasOld: boolean } {
  const newSessionsUsable = f.homeKiroExists && f.newSessionsExists;
  const oldSessionsUsable = f.userDataExists && f.oldSessionsExists;

  const newDirExists = workspaceGiven && newSessionsUsable && f.newSide.shape !== 'missing';
  const oldDirExists = workspaceGiven && oldSessionsUsable && f.oldSide.shape !== 'missing';

  return {
    hasNew: newDirExists && f.newSide.entries.some((e) => e.kind === 'dir'),
    hasOld: oldDirExists && f.oldSide.names.some(isOldSessionFileNameDef),
  };
}

/** 从夹具描述推出整份 LayoutRoots 期望值。 */
function expectedRoots(f: Fixture, workspaceGiven: boolean): LayoutRoots {
  const homeKiroDir = f.homeKiroExists ? HOME_KIRO : null;
  const newSessionsRoot = f.homeKiroExists && f.newSessionsExists ? NEW_SESSIONS : null;
  const newSessionIndexRoot =
    f.homeKiroExists && f.newSessionIndexExists ? NEW_SESSION_INDEX : null;
  const userDataDir = f.userDataExists ? USER_DATA : null;
  const oldSessionsRoot = f.userDataExists && f.oldSessionsExists ? OLD_SESSIONS : null;

  const { hasNew, hasOld } = expectedSides(f, workspaceGiven);

  return {
    layout: layoutOf(hasNew, hasOld),
    homeKiroDir,
    newSessionsRoot,
    newSessionIndexRoot,
    newWorkspaceSessionDir:
      workspaceGiven && newSessionsRoot !== null && f.newSide.shape !== 'missing'
        ? newWorkspaceDirOf(f.workspacePath)
        : null,
    userDataDir,
    oldStoreRoot: oldSessionsRoot !== null ? OLD_STORE_ROOT : null,
    oldSessionsRoot,
    oldWorkspaceSessionDir:
      workspaceGiven && oldSessionsRoot !== null && f.oldSide.shape !== 'missing'
        ? oldWorkspaceDirOf(f.workspacePath, f.oldKeyIndex)
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * Property 3
 * ------------------------------------------------------------------ */

// Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
// Validates: Requirements 1.3, 1.13
describe('Property 3: 布局判定完备且互斥', () => {
  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3
  it('Property 3: layout 恒取四态之一，且返回结构恒含全部根字段', () => {
    fc.assert(
      fc.property(fixtureArb, (f) => {
        const actual = detectLayout(f.workspacePath, buildVfs(f).deps);

        expect(LAYOUT_VALUES).toContain(actual.layout);
        // 结构完备：不多不少恰好 layout + 8 个根字段，且每个字段恒为 string | null
        expect(Object.keys(actual).sort()).toEqual([...ROOT_KEYS, 'layout'].sort());
        for (const k of ROOT_KEYS) {
          const v = actual[k];
          expect(v === null || typeof v === 'string').toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3
  it('Property 3: layout 恒等于独立重写的判定式，且四个分支恒恰有一个成立', () => {
    fc.assert(
      fc.property(fixtureArb, (f) => {
        const actual = detectLayout(f.workspacePath, buildVfs(f).deps);
        const { hasNew, hasOld } = expectedSides(f, true);

        // 互斥 + 完备：四个分支条件里恒恰好一个为真
        const branches: Array<[StorageLayout, boolean]> = [
          ['both', hasNew && hasOld],
          ['new-only', hasNew && !hasOld],
          ['old-only', !hasNew && hasOld],
          ['none', !hasNew && !hasOld],
        ];
        const hit = branches.filter(([, holds]) => holds);
        expect(hit).toHaveLength(1);

        // 与定义式一致
        expect(actual.layout).toBe(hit[0][0]);
        expect(actual.layout).toBe(layoutOf(hasNew, hasOld));
        // 各个根同样逐字段等于定义式的结果
        expect(actual).toEqual(expectedRoots(f, true));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.13
  it('Property 3: 同一注入状态下连续两次调用，layout 与全部根字段恒逐一相等', () => {
    fc.assert(
      fc.property(fixtureArb, (f) => {
        const vfs = buildVfs(f);
        const first = detectLayout(f.workspacePath, vfs.deps);
        const second = detectLayout(f.workspacePath, vfs.deps);

        expect(second.layout).toBe(first.layout);
        for (const k of ROOT_KEYS) expect(second[k]).toBe(first[k]);

        // 换一套等价的注入实例（同一磁盘状态的另一次观察）结果同样不变
        const third = detectLayout(f.workspacePath, buildVfs(f).deps);
        expect(third).toEqual(first);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3, 1.13
  it('Property 3: 空壳旧目录（为空/只剩清单/只剩迁移标记/只有近似文件名）恒不把 new-only 抬成 both', () => {
    fc.assert(
      fc.property(
        fixtureArbOf({
          newSide: productiveNewSideArb,
          oldSide: hollowOldSideArb,
          rootsAlwaysPresent: true,
        }),
        (f) => {
          const actual = detectLayout(f.workspacePath, buildVfs(f).deps);

          // 非空话前提：旧目录确实存在且确实有条目（`empty` 除外），只是没有一条旧会话
          expect(actual.oldWorkspaceSessionDir).not.toBeNull();
          expect(actual.newWorkspaceSessionDir).not.toBeNull();
          expect(f.oldSide.names.some(isOldSessionFileNameDef)).toBe(false);

          expect(actual.layout).toBe('new-only');
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3
  it('Property 3: 新目录为空或只含文件时恒判为 old-only（子目录才算 1.x 会话）', () => {
    fc.assert(
      fc.property(
        fixtureArbOf({
          newSide: barrenNewSideArb,
          oldSide: productiveOldSideArb,
          rootsAlwaysPresent: true,
        }),
        (f) => {
          const actual = detectLayout(f.workspacePath, buildVfs(f).deps);

          expect(f.newSide.entries.some((e) => e.kind === 'dir')).toBe(false);
          expect(actual.layout).toBe('old-only');
          // 新侧的各个根仍然可用——「没有会话」不等于「根不可用」
          expect(actual.newSessionsRoot).toBe(NEW_SESSIONS);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3, 1.5, 1.6
  it('Property 3: 单侧根缺失恒只清空该侧字段，另一侧恒逐字段保留', () => {
    fc.assert(
      fc.property(rootsPresentFixtureArb, (f) => {
        const baseline = detectLayout(f.workspacePath, buildVfs(f).deps);
        // 非空话前提：两侧根在基线里都确实可用
        expect(baseline.newSessionsRoot).not.toBeNull();
        expect(baseline.oldSessionsRoot).not.toBeNull();

        // 新侧缺失（`~/.kiro` 不存在）：新侧四字段全 null，旧侧四字段与基线逐一相同
        const noNew = detectLayout(f.workspacePath, buildVfs({ ...f, homeKiroExists: false }).deps);
        for (const k of NEW_SIDE_KEYS) expect(noNew[k]).toBeNull();
        for (const k of OLD_SIDE_KEYS) expect(noNew[k]).toBe(baseline[k]);
        expect(noNew.layout).toBe(layoutOf(false, expectedSides(f, true).hasOld));

        // 旧侧缺失（UserDataDir 不存在）：旧侧四字段全 null，新侧四字段与基线逐一相同
        const noOld = detectLayout(f.workspacePath, buildVfs({ ...f, userDataExists: false }).deps);
        for (const k of OLD_SIDE_KEYS) expect(noOld[k]).toBeNull();
        for (const k of NEW_SIDE_KEYS) expect(noOld[k]).toBe(baseline[k]);
        expect(noOld.layout).toBe(layoutOf(expectedSides(f, true).hasNew, false));

        // 仅 workspace-sessions 缺失（UserDataDir 仍在）：userDataDir 恒保留，其余旧侧字段置 null
        const noOldSessions = detectLayout(
          f.workspacePath,
          buildVfs({ ...f, oldSessionsExists: false }).deps
        );
        expect(noOldSessions.userDataDir).toBe(USER_DATA);
        expect(noOldSessions.oldSessionsRoot).toBeNull();
        expect(noOldSessions.oldStoreRoot).toBeNull();
        expect(noOldSessions.oldWorkspaceSessionDir).toBeNull();
        for (const k of NEW_SIDE_KEYS) expect(noOldSessions[k]).toBe(baseline[k]);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3, 1.13
  it('Property 3: workspacePath 为 null 时恒为 none、工作区级字段为 null、各根保留，且恒不枚举目录', () => {
    fc.assert(
      fc.property(fixtureArb, (f) => {
        const withWs = detectLayout(f.workspacePath, buildVfs(f).deps);

        const vfs = buildVfs(f);
        const noWs = detectLayout(null, vfs.deps);

        expect(noWs.layout).toBe('none');
        for (const k of WORKSPACE_LEVEL_KEYS) expect(noWs[k]).toBeNull();
        // 已解析的各个根恒保留（EnvChecker 要靠它们生成提示、StorageAnalyzer 要靠它们做全局统计）
        for (const k of ROOT_LEVEL_KEYS) expect(noWs[k]).toBe(withWs[k]);
        expect(noWs).toEqual(expectedRoots(f, false));

        // 恒不发生任何目录枚举，连一次 stat 都不该有（Req 1.10）
        expect(vfs.readdirCalls).toEqual([]);
        expect(vfs.statCalls).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 3: 布局判定完备且互斥
  // Validates: Requirements 1.3, 1.12
  it('Property 3: readdir / stat 抛异常恒被吞掉，该侧恒判为不成立，各根恒不受影响', () => {
    type FailMode = 'readdir-new' | 'readdir-old' | 'readdir-any' | 'stat-new-entries' | 'stat-any';
    const failModes: readonly FailMode[] = [
      'readdir-new',
      'readdir-old',
      'readdir-any',
      'stat-new-entries',
      'stat-any',
    ];

    fc.assert(
      fc.property(rootsPresentFixtureArb, fc.constantFrom(...failModes), (f, mode) => {
        const newWsDir = newWorkspaceDirOf(f.workspacePath);
        const oldWsDir = oldWorkspaceDirOf(f.workspacePath, f.oldKeyIndex);

        const fail: FailureInjection =
          mode === 'readdir-new'
            ? { readdirThrowsOn: (p) => p === newWsDir }
            : mode === 'readdir-old'
              ? { readdirThrowsOn: (p) => p === oldWsDir }
              : mode === 'readdir-any'
                ? { readdirThrowsOn: () => true }
                : mode === 'stat-new-entries'
                  ? { statThrowsOn: (p) => path.dirname(p) === newWsDir }
                  : { statThrowsOn: () => true };

        const vfs = buildVfs(f, fail);
        let actual: LayoutRoots | undefined;
        expect(() => {
          actual = detectLayout(f.workspacePath, vfs.deps);
        }).not.toThrow();
        const got = actual as LayoutRoots;

        const { hasNew, hasOld } = expectedSides(f, true);
        // 被注入异常的那一侧恒判为不成立；另一侧不受牵连
        const newKilled = mode !== 'readdir-old';
        const oldKilled = mode === 'readdir-old' || mode === 'readdir-any' || mode === 'stat-any';
        expect(got.layout).toBe(layoutOf(newKilled ? false : hasNew, oldKilled ? false : hasOld));

        // 各级根仍照常解析（它们只依赖 existsSync，与枚举/stat 异常无关）
        const base = expectedRoots(f, true);
        for (const k of ROOT_LEVEL_KEYS) expect(got[k]).toBe(base[k]);
        // stat 全线抛异常时两个工作区目录无法确认为目录，故置 null；其余模式下恒保留
        if (mode === 'stat-any') {
          for (const k of WORKSPACE_LEVEL_KEYS) expect(got[k]).toBeNull();
        } else {
          for (const k of WORKSPACE_LEVEL_KEYS) expect(got[k]).toBe(base[k]);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('Property 3: 生成器覆盖全部夹具形态、各根缺失与四种 layout 取值（覆盖度守卫）', () => {
    const samples = fc.sample(fixtureArb, 600);

    // ① 新旧目录的全部形态都被采到——尤其「只含 sessions.json」与「只含 ._migration-*.json」
    const newShapes = new Set(samples.map((f) => f.newSide.shape));
    const oldShapes = new Set(samples.map((f) => f.oldSide.shape));
    for (const s of NEW_DIR_SHAPES) expect([...newShapes]).toContain(s);
    for (const s of OLD_DIR_SHAPES) expect([...oldShapes]).toContain(s);

    // ② 各级根的存在与缺失都被采到
    const flags: Array<[string, (f: Fixture) => boolean]> = [
      ['homeKiroExists', (f) => f.homeKiroExists],
      ['newSessionsExists', (f) => f.newSessionsExists],
      ['newSessionIndexExists', (f) => f.newSessionIndexExists],
      ['userDataExists', (f) => f.userDataExists],
      ['oldSessionsExists', (f) => f.oldSessionsExists],
    ];
    for (const [name, read] of flags) {
      const seen = new Set(samples.map(read));
      expect([...seen].sort(), `${name} 应同时采到 true 与 false`).toEqual([false, true]);
    }

    // ③ 四种 layout 取值都被真实产出（否则「四态完备」只是没被反驳过）
    const layouts = new Set(
      samples.map((f) => {
        const { hasNew, hasOld } = expectedSides(f, true);
        return layoutOf(hasNew, hasOld);
      })
    );
    expect([...layouts].sort()).toEqual([...LAYOUT_VALUES].sort());

    // ④ 空壳旧目录的三种形态确实产出「旧侧不成立但目录非空」的样本
    const hollowNonEmpty = samples.filter(
      (f) =>
        f.oldSide.names.length > 0 &&
        !f.oldSide.names.some(isOldSessionFileNameDef) &&
        f.oldSide.shape !== 'missing'
    );
    expect(hollowNonEmpty.length).toBeGreaterThan(0);
    expect(new Set(hollowNonEmpty.map((f) => f.oldSide.shape))).toEqual(
      new Set<OldDirShape>(['manifestOnly', 'markersOnly', 'nonJsonOnly'])
    );

    // ⑤ 新目录「只含文件、无子目录」的样本确实存在（新侧条件的关键反例）
    expect(
      samples.filter(
        (f) => f.newSide.entries.length > 0 && !f.newSide.entries.some((e) => e.kind === 'dir')
      ).length
    ).toBeGreaterThan(0);
  });
});
