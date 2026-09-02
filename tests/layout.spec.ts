/**
 * Kiro 1.x 存储适配 —— 布局检测与环境放行的**示例测试**。
 *
 * 与 `tests/layout.property.spec.ts`（Property 3）的分工：属性测试用随机组合覆盖
 * 「四态完备且互斥」「幂等」「单侧缺失不连带」「异常被吞掉」这些**全域性质**；
 * 本文件只钉四个**具体夹具**下的具体取值，外加属性测试完全没有触及的一层——
 * `checkEnvironment` 的放行与错误文案。本次适配要解决的首要症状之一正是
 * 「纯 1.x 环境被『未找到 Kiro 对话存储目录』挡在门外」，那道回归线只能在这里钉住。
 *
 * 四个夹具刻意取**真实机器上会出现的根配置**，而不是「所有根都存在」的实验室状态：
 *
 * - `new-only`：升级后旧根整体不在（`workspace-sessions` 缺失）——旧实现在这里短路报错；
 * - `old-only`：尚未升级，`~/.kiro` 根本不存在；
 * - `both`：两侧根与两侧会话都在；
 * - `none`：两侧根与两侧**工作区目录**都在，但一条会话都没有（空壳目录）。
 *
 * 全部经注入的 `LayoutFsDeps`（`platform` / `env` / `homedir` / `existsSync` /
 * `statSync` / `readdirSync`）在内存里构造：**不落盘、不触碰真实 `~/.kiro` 与真实用户
 * 数据目录**。注入 `platform: 'linux'` + `env: {}` 让 UserDataDir 走
 * 「XDG_CONFIG_HOME 缺省 → `<home>/.config/Kiro`」这一条确定分支，
 * 使结果不随宿主平台或宿主环境变量漂移。
 *
 * _Requirements: 1.3, 1.7, 1.8, 1.9, 1.11_
 */
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { checkEnvironment } from '../src/env';
import { detectLayout } from '../src/layout';
import type { LayoutFsDeps, LayoutRoots } from '../src/layout';
import { computeWsHash16, encodeWorkspaceKeys } from '../src/paths';

/* ------------------------------------------------------------------ *
 * 假文件系统的固定路径
 * ------------------------------------------------------------------ */

const FS_ROOT = path.sep === '\\' ? 'C:\\' : '/';
const HOME = path.join(FS_ROOT, 'home', 'fake-kiro-user');

const HOME_KIRO = path.join(HOME, '.kiro');
const NEW_SESSIONS = path.join(HOME_KIRO, 'sessions');
const NEW_SESSION_INDEX = path.join(HOME_KIRO, 'session-index');

const USER_DATA = path.join(HOME, '.config', 'Kiro');
const OLD_STORE_ROOT = path.join(USER_DATA, 'User', 'globalStorage', 'kiro.kiroagent');
const OLD_SESSIONS = path.join(OLD_STORE_ROOT, 'workspace-sessions');

/** 当前工作区：取实测基线那一个，使夹具目录名与真机上的目录名一致。 */
const WS = 'd:\\Projects\\KiroExt\\KiroChatSearcher';

/**
 * 两个工作区级目录名由生产实现自己算（`computeWsHash16` / `encodeWorkspaceKeys`），
 * 它们是**夹具的构造输入**而非本文件的判据来源——各自的正确性由
 * `tests/paths.newlayout*.spec.ts` 锁定。下面的 `new-only` 用例会额外把
 * `newWorkspaceSessionDir` 与写死的实测基线目录名比一次，把两者对上。
 */
const NEW_WS_DIR = path.join(NEW_SESSIONS, computeWsHash16(WS));
const OLD_WS_DIR = path.join(OLD_SESSIONS, encodeWorkspaceKeys(WS)[0]);

/* ------------------------------------------------------------------ *
 * 夹具内容物
 * ------------------------------------------------------------------ */

/** 1.x 新建的会话目录（`sess_` 前缀）。 */
const SESSION_DIR_NEW = 'sess_9f1c2d3e4a5b6c7d';
/** 从 0.9x 迁移过来的会话目录（沿用原 uuid，无前缀）。 */
const SESSION_DIR_MIGRATED = '0f0f1111-2222-4333-8444-555566667777';
/** 0.9x 的单文件会话 `<sessionId>.json`。 */
const OLD_SESSION_FILE = '7a3b4c5d-1111-4222-8333-444455556666.json';
/** 0.9x 的会话清单（顶层是数组，**不是**一条会话）。 */
const OLD_MANIFEST = 'sessions.json';
/** 0.9x 目录里的迁移标记（说明对应会话**已搬到** 1.x，本身不是会话）。 */
const MIGRATION_MARKER = '._migration-1a2b3c4d5e6f7a8b.json';

/* ------------------------------------------------------------------ *
 * 虚拟文件系统
 * ------------------------------------------------------------------ */

interface DirEntry {
  name: string;
  kind: 'dir' | 'file';
}

interface FixtureSpec {
  /** 各级根的存在性，缺省为存在。 */
  homeKiro?: boolean;
  newSessions?: boolean;
  newSessionIndex?: boolean;
  userData?: boolean;
  oldSessions?: boolean;
  /** 新工作区目录内的条目；**省略表示该目录本身不存在**。 */
  newWs?: DirEntry[];
  /** 旧工作区目录内的文件名；**省略表示该目录本身不存在**。 */
  oldWs?: string[];
}

interface Vfs {
  deps: LayoutFsDeps;
  /** 依赖调用留痕，用于断言某些状态下压根没发生目录枚举。 */
  readdirCalls: string[];
}

/**
 * 按夹具描述搭一套注入依赖。
 *
 * 子目录的存在性对父目录取合取（父不存在则子也不存在），使虚拟 fs 自洽：
 * 真实磁盘上不会出现「`~/.kiro` 不存在却有 `~/.kiro/sessions/<hash>`」这种状态。
 */
function buildVfs(spec: FixtureSpec): Vfs {
  const {
    homeKiro = true,
    newSessions = true,
    newSessionIndex = true,
    userData = true,
    oldSessions = true,
  } = spec;

  const dirs = new Set<string>();
  const files = new Set<string>();
  const entries = new Map<string, string[]>();

  // ---- 新侧 ----
  if (homeKiro) dirs.add(HOME_KIRO);
  const newSessionsPresent = homeKiro && newSessions;
  if (newSessionsPresent) dirs.add(NEW_SESSIONS);
  if (homeKiro && newSessionIndex) dirs.add(NEW_SESSION_INDEX);
  if (newSessionsPresent && spec.newWs !== undefined) {
    dirs.add(NEW_WS_DIR);
    entries.set(
      NEW_WS_DIR,
      spec.newWs.map((e) => e.name)
    );
    for (const e of spec.newWs) {
      (e.kind === 'dir' ? dirs : files).add(path.join(NEW_WS_DIR, e.name));
    }
  }

  // ---- 旧侧 ----
  if (userData) dirs.add(USER_DATA);
  const oldSessionsPresent = userData && oldSessions;
  if (oldSessionsPresent) dirs.add(OLD_SESSIONS);
  if (oldSessionsPresent && spec.oldWs !== undefined) {
    dirs.add(OLD_WS_DIR);
    entries.set(OLD_WS_DIR, [...spec.oldWs]);
    for (const n of spec.oldWs) files.add(path.join(OLD_WS_DIR, n));
  }

  const readdirCalls: string[] = [];

  const deps: LayoutFsDeps = {
    platform: 'linux',
    env: {},
    homedir: () => HOME,
    existsSync: (p) => dirs.has(p) || files.has(p),
    statSync: (p) => {
      if (dirs.has(p)) return { isDirectory: () => true };
      if (files.has(p)) return { isDirectory: () => false };
      throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
    },
    readdirSync: (p) => {
      readdirCalls.push(p);
      const names = entries.get(p);
      if (names !== undefined) return [...names];
      if (dirs.has(p)) return [];
      throw new Error(`ENOENT: no such file or directory, scandir '${p}'`);
    },
  };

  return { deps, readdirCalls };
}

/** 打开了工作区的 EnvChecker 入参。 */
function envDepsWith(spec: FixtureSpec) {
  return { workspaceFolder: { uri: { fsPath: WS } }, pathResolver: buildVfs(spec).deps };
}

/* ------------------------------------------------------------------ *
 * 四种布局的具体夹具
 * ------------------------------------------------------------------ */

/** 纯 1.x 机器：`~/.kiro/sessions` 下有本工作区的会话目录，旧根 `workspace-sessions` 整体不在。 */
const NEW_ONLY: FixtureSpec = {
  oldSessions: false,
  newWs: [
    { name: SESSION_DIR_NEW, kind: 'dir' },
    { name: SESSION_DIR_MIGRATED, kind: 'dir' },
  ],
};

/** 尚未升级的机器：`~/.kiro` 根本不存在，会话还在 0.9x 的 `<sessionId>.json` 里。 */
const OLD_ONLY: FixtureSpec = {
  homeKiro: false,
  oldWs: [OLD_MANIFEST, OLD_SESSION_FILE],
};

/** 已升级但只手动迁移了一部分：两侧根与两侧会话都在。 */
const BOTH: FixtureSpec = {
  newWs: [
    { name: SESSION_DIR_NEW, kind: 'dir' },
    { name: SESSION_DIR_MIGRATED, kind: 'dir' },
  ],
  oldWs: [OLD_MANIFEST, MIGRATION_MARKER, OLD_SESSION_FILE],
};

/**
 * 两侧根与两侧**工作区目录**都在，但一条会话都没有：新目录里只有游标文件（无子目录），
 * 旧目录里只剩清单与迁移标记（无 `<sessionId>.json`）。
 * 这是「当前项目还没有 Kiro 对话历史」最容易被误判成 `both` 的形态。
 */
const NONE_HOLLOW: FixtureSpec = {
  newWs: [{ name: 'publish.cursor', kind: 'file' }],
  oldWs: [OLD_MANIFEST, MIGRATION_MARKER],
};

/** 两侧根都在，但本工作区在两侧都还没有目录（全新项目）。 */
const NONE_NO_WS_DIR: FixtureSpec = {};

/* ------------------------------------------------------------------ *
 * 1. 四种布局夹具下的 detectLayout
 * ------------------------------------------------------------------ */

describe('detectLayout - 四种布局夹具', () => {
  it('new-only：新侧四字段齐备，旧侧仅 userDataDir 保留（旧根缺失不连带清空新侧）', () => {
    const roots = detectLayout(WS, buildVfs(NEW_ONLY).deps);

    expect(roots).toEqual<LayoutRoots>({
      layout: 'new-only',
      homeKiroDir: HOME_KIRO,
      newSessionsRoot: NEW_SESSIONS,
      newSessionIndexRoot: NEW_SESSION_INDEX,
      newWorkspaceSessionDir: NEW_WS_DIR,
      // Kiro 装着，所以 UserDataDir 在；但它下面的 workspace-sessions 不在，
      // 故 oldStoreRoot / oldSessionsRoot / oldWorkspaceSessionDir 一并为 null（Req 1.6）
      userDataDir: USER_DATA,
      oldStoreRoot: null,
      oldSessionsRoot: null,
      oldWorkspaceSessionDir: null,
    });

    // 夹具目录名与真机实测基线对齐（`cc5023603866cd91` 来自 Kiro 1.0.337 上的 ~/.kiro/sessions）
    expect(roots.newWorkspaceSessionDir).toBe(path.join(NEW_SESSIONS, 'cc5023603866cd91'));
  });

  it('old-only：旧侧四字段齐备，新侧四字段全为 null（~/.kiro 不存在）', () => {
    const roots = detectLayout(WS, buildVfs(OLD_ONLY).deps);

    expect(roots).toEqual<LayoutRoots>({
      layout: 'old-only',
      homeKiroDir: null,
      newSessionsRoot: null,
      newSessionIndexRoot: null,
      newWorkspaceSessionDir: null,
      userDataDir: USER_DATA,
      oldStoreRoot: OLD_STORE_ROOT,
      oldSessionsRoot: OLD_SESSIONS,
      oldWorkspaceSessionDir: OLD_WS_DIR,
    });
  });

  it('both：新旧八个根字段全部有值', () => {
    const roots = detectLayout(WS, buildVfs(BOTH).deps);

    expect(roots).toEqual<LayoutRoots>({
      layout: 'both',
      homeKiroDir: HOME_KIRO,
      newSessionsRoot: NEW_SESSIONS,
      newSessionIndexRoot: NEW_SESSION_INDEX,
      newWorkspaceSessionDir: NEW_WS_DIR,
      userDataDir: USER_DATA,
      oldStoreRoot: OLD_STORE_ROOT,
      oldSessionsRoot: OLD_SESSIONS,
      oldWorkspaceSessionDir: OLD_WS_DIR,
    });
  });

  it('none：两侧工作区目录都在但都没有会话，八个根字段照常有值', () => {
    const roots = detectLayout(WS, buildVfs(NONE_HOLLOW).deps);

    expect(roots).toEqual<LayoutRoots>({
      layout: 'none',
      homeKiroDir: HOME_KIRO,
      newSessionsRoot: NEW_SESSIONS,
      newSessionIndexRoot: NEW_SESSION_INDEX,
      // 两个工作区目录**确实存在**，只是里面没有会话 —— 「没有会话」不等于「根不可用」
      newWorkspaceSessionDir: NEW_WS_DIR,
      userDataDir: USER_DATA,
      oldStoreRoot: OLD_STORE_ROOT,
      oldSessionsRoot: OLD_SESSIONS,
      oldWorkspaceSessionDir: OLD_WS_DIR,
    });
  });

  it('none：本工作区在两侧都还没有目录时，两个工作区级字段为 null', () => {
    const roots = detectLayout(WS, buildVfs(NONE_NO_WS_DIR).deps);

    expect(roots.layout).toBe('none');
    expect(roots.newWorkspaceSessionDir).toBeNull();
    expect(roots.oldWorkspaceSessionDir).toBeNull();
    // 各级根仍照常解析
    expect(roots.newSessionsRoot).toBe(NEW_SESSIONS);
    expect(roots.oldSessionsRoot).toBe(OLD_SESSIONS);
  });
});

/* ------------------------------------------------------------------ *
 * 2. EnvChecker 放行回归：两根任一可用即 ok
 * ------------------------------------------------------------------ */

describe('checkEnvironment - 两根任一可用即放行', () => {
  // 本次适配的首要症状之一：旧实现一旦发现 `workspace-sessions` 缺失就短路报
  // 「未找到 Kiro 对话存储目录」，把纯 1.x 用户完全挡在门外。这条用例钉住它不再发生。
  it('new-only → ok 为 true，newWorkspaceDir 有值而 workspaceDir 为 undefined（Req 1.7）', () => {
    const env = checkEnvironment(envDepsWith(NEW_ONLY));

    expect(env.ok).toBe(true);
    expect(env.error).toBeUndefined();
    expect(env.layout).toBe('new-only');
    expect(env.newWorkspaceDir).toBe(NEW_WS_DIR);
    // 既有字段语义未变：`workspaceDir` 恒指 0.9x 目录，纯 1.x 环境下自然缺席。
    // 既有调用方写的是 `if (!env.ok || !env.workspaceDir) return;`，
    // 因此它们在这里的行为与「旧目录里没有会话」一致，不会拿到错误的路径。
    expect(env.workspaceDir).toBeUndefined();
    expect(env.sessionsRoot).toBeUndefined();
    expect(env.userDataDir).toBe(USER_DATA);
  });

  it('old-only → ok 为 true 且 workspaceDir 有值（Req 1.8）', () => {
    const env = checkEnvironment(envDepsWith(OLD_ONLY));

    expect(env.ok).toBe(true);
    expect(env.error).toBeUndefined();
    expect(env.layout).toBe('old-only');
    expect(env.workspaceDir).toBe(OLD_WS_DIR);
    expect(env.sessionsRoot).toBe(OLD_SESSIONS);
    expect(env.userDataDir).toBe(USER_DATA);
    // 新侧不可用时该字段缺席，既有调用方不受影响
    expect(env.newWorkspaceDir).toBeUndefined();
  });

  it('both → ok 为 true 且两个工作区目录字段都有值（Req 1.4）', () => {
    const env = checkEnvironment(envDepsWith(BOTH));

    expect(env.ok).toBe(true);
    expect(env.layout).toBe('both');
    expect(env.newWorkspaceDir).toBe(NEW_WS_DIR);
    expect(env.workspaceDir).toBe(OLD_WS_DIR);
    expect(env.sessionsRoot).toBe(OLD_SESSIONS);
    expect(env.userDataDir).toBe(USER_DATA);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 两根均缺失（Req 1.9）
 * ------------------------------------------------------------------ */

describe('checkEnvironment - 两根均缺失', () => {
  /** `~/.kiro` 不在、`workspace-sessions` 也不在，但 UserDataDir 在（Kiro 装着，只是没有对话数据）。 */
  const NO_STORE: FixtureSpec = { homeKiro: false, oldSessions: false };

  it('报「未找到 Kiro 对话存储目录」，且 hint 同时给出新旧两个预期位置', () => {
    const env = checkEnvironment(envDepsWith(NO_STORE));

    expect(env.ok).toBe(false);
    expect(env.error).toBe('未找到 Kiro 对话存储目录');
    // 两个预期位置必须**同时**出现：只列旧路径的话，1.x 用户拿到的是一条早已不再使用的路径
    expect(env.hint).toContain('~/.kiro/sessions');
    expect(env.hint).toContain(OLD_SESSIONS);
    // UserDataDir 已解析出来，故旧路径提示是实际路径而非 `<UserDataDir>` 占位符
    expect(env.hint).not.toContain('<UserDataDir>');
    expect(env.userDataDir).toBe(USER_DATA);
  });

  it('UserDataDir 也解析不出来时，旧路径提示退化为占位符而不是拼出 "null/User/..."', () => {
    const env = checkEnvironment({
      workspaceFolder: { uri: { fsPath: WS } },
      pathResolver: buildVfs({ homeKiro: true, newSessions: false, userData: false }).deps,
    });

    expect(env.ok).toBe(false);
    expect(env.error).toBe('未找到 Kiro 对话存储目录');
    expect(env.hint).toContain('~/.kiro/sessions');
    expect(env.hint).toContain('<UserDataDir>');
    expect(env.hint).not.toContain('null');
  });
});

/* ------------------------------------------------------------------ *
 * 4. layout 为 none 且已打开工作区（Req 1.11）
 * ------------------------------------------------------------------ */

describe('checkEnvironment - layout 为 none 且已打开工作区', () => {
  it('两侧目录都在但都没有会话 → 「当前项目还没有 Kiro 对话历史」且 hint 含工作区路径', () => {
    const env = checkEnvironment(envDepsWith(NONE_HOLLOW));

    expect(env.ok).toBe(false);
    expect(env.error).toBe('当前项目还没有 Kiro 对话历史');
    expect(env.hint).toContain(WS);
    // 这是「本项目没有对话」而不是「存储不可用」：各个根仍随结果返回，供面板照常渲染骨架
    expect(env.layout).toBe('none');
    expect(env.sessionsRoot).toBe(OLD_SESSIONS);
    expect(env.userDataDir).toBe(USER_DATA);
  });

  it('本工作区在两侧都没有目录 → 同一条提示', () => {
    const env = checkEnvironment(envDepsWith(NONE_NO_WS_DIR));

    expect(env.ok).toBe(false);
    expect(env.error).toBe('当前项目还没有 Kiro 对话历史');
    expect(env.hint).toContain(WS);
    expect(env.newWorkspaceDir).toBeUndefined();
    expect(env.workspaceDir).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 5. 空壳旧目录的具体形态（Req 1.3）
 * ------------------------------------------------------------------ */

describe('detectLayout - 空壳旧目录不算「仍有旧会话」', () => {
  const productiveNewWs: DirEntry[] = [{ name: SESSION_DIR_NEW, kind: 'dir' }];

  it('旧目录只剩 sessions.json → 判为 new-only 而非 both', () => {
    const roots = detectLayout(
      WS,
      buildVfs({ newWs: productiveNewWs, oldWs: [OLD_MANIFEST] }).deps
    );

    // 非空话前提：旧目录确实存在、确实有一个 `.json` 条目，只是那是清单不是会话
    expect(roots.oldWorkspaceSessionDir).toBe(OLD_WS_DIR);
    expect(roots.layout).toBe('new-only');
  });

  it('旧目录只剩 ._migration-<uuid>.json → 判为 new-only（标记说明会话已搬到 1.x）', () => {
    const roots = detectLayout(
      WS,
      buildVfs({ newWs: productiveNewWs, oldWs: [MIGRATION_MARKER] }).deps
    );

    expect(roots.oldWorkspaceSessionDir).toBe(OLD_WS_DIR);
    expect(roots.layout).toBe('new-only');
  });

  it('清单与迁移标记之外再多一个 <sessionId>.json → 立刻变回 both', () => {
    // 对照组：上面两条不是「旧目录一律不算」，而是「清单/标记不算、会话文件算」。
    // 排除判据还必须扫过前面的噪声条目，不能看首个条目就收工。
    const roots = detectLayout(
      WS,
      buildVfs({
        newWs: productiveNewWs,
        oldWs: [OLD_MANIFEST, MIGRATION_MARKER, OLD_SESSION_FILE],
      }).deps
    );

    expect(roots.layout).toBe('both');
  });

  it('新目录只有文件没有子目录、旧目录只剩空壳 → none', () => {
    const roots = detectLayout(
      WS,
      buildVfs({
        newWs: [{ name: 'session.json', kind: 'file' }],
        oldWs: [OLD_MANIFEST, MIGRATION_MARKER],
      }).deps
    );

    expect(roots.newWorkspaceSessionDir).toBe(NEW_WS_DIR);
    expect(roots.oldWorkspaceSessionDir).toBe(OLD_WS_DIR);
    expect(roots.layout).toBe('none');
  });
});

/* ------------------------------------------------------------------ *
 * 6. 未打开工作区（Req 1.10）
 * ------------------------------------------------------------------ */

describe('checkEnvironment - 未打开工作区', () => {
  it('存储根可用但未打开工作区 → 「当前没有打开任何工作区」，而不是 none 的提示', () => {
    const env = checkEnvironment({
      workspaceFolder: null,
      pathResolver: buildVfs(BOTH).deps,
    });

    expect(env.ok).toBe(false);
    expect(env.error).toBe('当前没有打开任何工作区');
    expect(env.hint).toBe('请先在 Kiro 中打开一个项目，再使用对话搜索');
    // 未打开工作区时 layout 恒为 none，但报的**不是**「当前项目还没有 Kiro 对话历史」——
    // 工作区判定排在布局判定之前
    expect(env.layout).toBe('none');
  });

  it('两根均缺失且未打开工作区 → 存储错误优先于工作区错误', () => {
    // env.ts 的实际顺序：存储根判定(2) → 未打开工作区(3) → 布局 none(4)
    const env = checkEnvironment({
      workspaceFolder: null,
      pathResolver: buildVfs({ homeKiro: false, oldSessions: false }).deps,
    });

    expect(env.ok).toBe(false);
    expect(env.error).toBe('未找到 Kiro 对话存储目录');
  });

  it('未打开工作区时不发生任何目录枚举', () => {
    // 属性测试已覆盖 `detectLayout(null, ...)` 本身不枚举；这里验证的是另一层：
    // `checkEnvironment` 确实把 null 透传下去，而不是拿别的路径去探目录。
    const vfs = buildVfs(BOTH);
    checkEnvironment({ workspaceFolder: null, pathResolver: vfs.deps });

    expect(vfs.readdirCalls).toEqual([]);
  });
});
