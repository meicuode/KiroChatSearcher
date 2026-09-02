/**
 * 示例测试（任务 14.11）：**1.x 目录型会话**的清理。
 *
 * 与 `storage.cleaner.spec.ts`（0.9x 回归）的分工：那份钉的是单文件会话的既有语义；
 * 本份钉的是本次新增的那一层 —— 目录型会话的两种模式待删集合、`rmdir` 收尾的成功与
 * 「目录非空则保留」两条路径、1.x 的路径围栏，以及审计里的会话格式字段。
 *
 * 全部走**注入的内存 fs**：清理是唯一带破坏性能力的模块，示例测试不该真的在磁盘上删东西。
 * 内存 fs 同时记录调用序列，因此「`unlink` 实参恒 ⊆ 计划枚举的文件」「`rmdir` 前必有一次
 * 对同一目录的 `readdir`」这类时序性质可以直接断言，而不是靠读代码。
 *
 * _Requirements: 10.3, 10.4, 10.5, 10.6, 10.8, 10.10, 10.13, 10.14, 10.18_
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';

import {
  SessionCleaner,
  assertDeletable,
  assertRemovableDir,
  DELETE_REJECT_REASONS,
  type CleanerDirent,
  type CleanerFsDeps,
  type CleanerRoots,
  type CleanupMode,
  type ConfirmPrompt,
} from '../src/storage/cleaner';

/* ------------------------------------------------------------------ *
 * 夹具：内存文件系统
 * ------------------------------------------------------------------ */

const HOME_KIRO = path.resolve('/home/u/.kiro');
const NEW_SESSIONS_ROOT = path.join(HOME_KIRO, 'sessions');
const WS_HASH = 'cc5023603866cd91';
const NEW_WS_DIR = path.join(NEW_SESSIONS_ROOT, WS_HASH);
const SESSION_ID = 'sess_target';
const SESSION_DIR = path.join(NEW_WS_DIR, SESSION_ID);
const TITLE = '一个 1.x 会话';

/** 0.9x 侧的根仍要给（同一个 cleaner 同时服务两种格式），但本文件的夹具里它是空的。 */
const STORE_ROOT = path.resolve('/appdata/Kiro/User/globalStorage/kiro.kiroagent');
const OLD_SESSION_DIR = path.join(STORE_ROOT, 'workspace-sessions', 'encoded-key');

function roots(over: Partial<CleanerRoots> = {}): CleanerRoots {
  return {
    storeRoot: STORE_ROOT,
    savesBucket: 'a'.repeat(32),
    workspaceId: 'b'.repeat(32),
    sessionDir: OLD_SESSION_DIR,
    newSessionsRoot: NEW_SESSIONS_ROOT,
    newWorkspaceSessionDir: NEW_WS_DIR,
    ...over,
  };
}

interface MemEntry {
  size: number;
  mtimeMs: number;
  symlink?: boolean;
}

interface MemFs {
  deps: CleanerFsDeps;
  /** 调用序列：`{ op, path }`，供时序断言 */
  calls: Array<{ op: string; path: string }>;
  files: Map<string, MemEntry>;
  dirs: Set<string>;
  ops(): string[];
  argsOf(op: string): string[];
  /** 让某个路径的 unlink 抛错 */
  failUnlink(p: string, code: string): void;
  /** 在 unlink 某个路径成功之后，往某目录里塞一个新文件（模拟 Kiro 又写了东西） */
  afterUnlink(p: string, action: () => void): void;
}

const norm = (p: string): string => path.resolve(p);

function memFs(spec: { files: Record<string, number>; symlinks?: string[] }): MemFs {
  const files = new Map<string, MemEntry>();
  const dirs = new Set<string>();
  const calls: Array<{ op: string; path: string }> = [];
  const unlinkFaults = new Map<string, string>();
  const unlinkHooks = new Map<string, () => void>();

  const addDirsFor = (p: string): void => {
    let dir = path.dirname(norm(p));
    for (let i = 0; i < 32; i++) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  };

  let mtime = 1_700_000_000_000;
  for (const [p, size] of Object.entries(spec.files)) {
    files.set(norm(p), { size, mtimeMs: mtime++ });
    addDirsFor(p);
  }
  for (const p of spec.symlinks ?? []) {
    files.set(norm(p), { size: 0, mtimeMs: 0, symlink: true });
    addDirsFor(p);
  }

  const enoent = (op: string, p: string): Error => {
    const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`) as Error & {
      code: string;
    };
    e.code = 'ENOENT';
    return e;
  };

  const deps: CleanerFsDeps = {
    async stat(p) {
      calls.push({ op: 'stat', path: norm(p) });
      const e = files.get(norm(p));
      if (!e) throw enoent('lstat', p);
      return { size: e.size, mtimeMs: e.mtimeMs, isSymbolicLink: () => e.symlink === true };
    },
    async unlink(p) {
      calls.push({ op: 'unlink', path: norm(p) });
      const key = norm(p);
      const code = unlinkFaults.get(key);
      if (code) {
        const e = new Error(`${code}: unlink '${p}'`) as Error & { code: string };
        e.code = code;
        throw e;
      }
      if (!files.has(key)) throw enoent('unlink', p);
      files.delete(key);
      unlinkHooks.get(key)?.();
    },
    async readFile(p) {
      calls.push({ op: 'readFile', path: norm(p) });
      throw enoent('open', p);
    },
    async writeFile(p) {
      calls.push({ op: 'writeFile', path: norm(p) });
    },
    async readdir(p): Promise<CleanerDirent[]> {
      const key = norm(p);
      calls.push({ op: 'readdir', path: key });
      if (!dirs.has(key)) throw enoent('scandir', p);
      const names = new Set<string>();
      const kinds = new Map<string, 'dir' | 'file' | 'link'>();
      for (const f of files.keys()) {
        if (!f.startsWith(key + path.sep)) continue;
        const rel = f.slice(key.length + 1);
        const first = rel.split(path.sep)[0];
        names.add(first);
        kinds.set(first, rel.includes(path.sep) ? 'dir' : files.get(f)?.symlink ? 'link' : 'file');
      }
      // 空的中间目录（文件已删但目录还在）也要列出来
      for (const d of dirs) {
        if (path.dirname(d) !== key) continue;
        names.add(path.basename(d));
        if (!kinds.has(path.basename(d))) kinds.set(path.basename(d), 'dir');
      }
      return [...names].sort().map((name) => {
        const kind = kinds.get(name) ?? 'file';
        return {
          name,
          isDirectory: () => kind === 'dir',
          isFile: () => kind === 'file',
          isSymbolicLink: () => kind === 'link',
        };
      });
    },
    async rmdir(p) {
      const key = norm(p);
      calls.push({ op: 'rmdir', path: key });
      if (!dirs.has(key)) throw enoent('rmdir', p);
      for (const f of files.keys()) {
        if (f.startsWith(key + path.sep)) {
          const e = new Error(`ENOTEMPTY: directory not empty, rmdir '${p}'`) as Error & {
            code: string;
          };
          e.code = 'ENOTEMPTY';
          throw e;
        }
      }
      dirs.delete(key);
    },
    delay: async () => {},
  };

  return {
    deps,
    calls,
    files,
    dirs,
    ops: () => calls.map((c) => c.op),
    argsOf: (op) => calls.filter((c) => c.op === op).map((c) => c.path),
    failUnlink: (p, code) => void unlinkFaults.set(norm(p), code),
    afterUnlink: (p, action) => void unlinkHooks.set(norm(p), action),
  };
}

/** 典型的 1.x 会话目录：本体两个文件 + 一层快照 + 一个子执行。 */
function standardSession(): Record<string, number> {
  return {
    [path.join(SESSION_DIR, 'session.json')]: 400,
    [path.join(SESSION_DIR, 'messages.jsonl')]: 8000,
    [path.join(SESSION_DIR, 'publish.cursor')]: 8,
    [path.join(SESSION_DIR, 'snapshots', 'h1', 'src', 'a.ts')]: 1200,
    [path.join(SESSION_DIR, 'snapshots', 'h1', 'src', 'b.ts')]: 300,
    [path.join(SESSION_DIR, 'sub-executions', 'e1.json')]: 640,
  };
}

interface Harness {
  cleaner: SessionCleaner;
  mem: MemFs;
  prompts: ConfirmPrompt[];
  audits: string[][];
  invalidated: string[][];
}

function harness(opts: {
  files?: Record<string, number>;
  symlinks?: string[];
  decision?: 'confirm' | 'cancel';
  roots?: Partial<CleanerRoots>;
  fsOverride?: (deps: CleanerFsDeps) => CleanerFsDeps;
}): Harness {
  const mem = memFs({ files: opts.files ?? standardSession(), symlinks: opts.symlinks });
  const prompts: ConfirmPrompt[] = [];
  const audits: string[][] = [];
  const invalidated: string[][] = [];

  const cleaner = new SessionCleaner({
    fs: opts.fsOverride ? opts.fsOverride(mem.deps) : mem.deps,
    audit: (lines) => void audits.push(lines),
    confirm: async (p) => {
      prompts.push(p);
      return opts.decision === 'cancel' ? 'cancel' : 'confirm';
    },
    archives: () => [],
    invalidate: (paths) => void invalidated.push([...paths]),
    roots: roots(opts.roots),
  });

  return { cleaner, mem, prompts, audits, invalidated };
}

const rel = (p: string): string => path.relative(SESSION_DIR, p).split(path.sep).join('/');

/* ================================================================== *
 * 1. 计划：两种模式的待删集合（Req 10.3、10.4）
 * ================================================================== */

describe('14.1 目录型会话的 CleanupPlan（Req 10.3、10.4、10.7）', () => {
  it('attachment：只含 snapshots/ 与 sub-executions/ 内的文件，本体两个文件被排除', async () => {
    const h = harness({});
    const plan = await h.cleaner.plan('attachment', SESSION_ID, TITLE);

    expect(plan.layout).toBe('new');
    expect(plan.newSessionDir).toBe(SESSION_DIR);
    expect(plan.files.map((f) => rel(f.path)).sort()).toEqual([
      'snapshots/h1/src/a.ts',
      'snapshots/h1/src/b.ts',
      'sub-executions/e1.json',
    ]);
    expect(plan.totalBytes).toBe(1200 + 300 + 640);
    // 附件清理之后会话仍然可用，故一个目录都不收
    expect(plan.dirs).toEqual([]);
    // 1.x 没有会话清单，也不存在跨会话共享的存档
    expect(plan.manifestUpdate).toBeNull();
    expect(plan.referenced).toEqual([]);
  });

  it('full：含目录下全部文件，且 dirs 自底向上、末项为会话目录本身', async () => {
    const h = harness({});
    const plan = await h.cleaner.plan('full', SESSION_ID, TITLE);

    expect(plan.files.map((f) => rel(f.path)).sort()).toEqual([
      'messages.jsonl',
      'publish.cursor',
      'session.json',
      'snapshots/h1/src/a.ts',
      'snapshots/h1/src/b.ts',
      'sub-executions/e1.json',
    ]);
    expect(plan.totalBytes).toBe(400 + 8000 + 8 + 1200 + 300 + 640);

    // 自底向上：每一项的父目录恒不早于它自己出现
    const idx = new Map(plan.dirs.map((d, i) => [norm(d), i]));
    for (const d of plan.dirs) {
      const parent = norm(path.dirname(d));
      if (idx.has(parent)) expect(idx.get(parent)!).toBeGreaterThan(idx.get(norm(d))!);
    }
    expect(plan.dirs[plan.dirs.length - 1]).toBe(SESSION_DIR);
    expect(plan.dirs.map((d) => rel(d)).sort()).toEqual([
      '',
      'snapshots',
      'snapshots/h1',
      'snapshots/h1/src',
      'sub-executions',
    ]);
  });

  it('计划阶段全程只读：只发生 readdir 与 stat，绝不 unlink / rmdir / writeFile', async () => {
    const h = harness({});
    await h.cleaner.plan('full', SESSION_ID, TITLE);

    expect(new Set(h.mem.ops())).toEqual(new Set(['readdir', 'stat']));
  });

  it('符号链接进计划但不被跟随（随后由段 4 拒绝）', async () => {
    const link = path.join(SESSION_DIR, 'snapshots', 'link-out');
    const h = harness({ symlinks: [link] });
    const plan = await h.cleaner.plan('attachment', SESSION_ID, TITLE);

    expect(plan.files.map((f) => norm(f.path))).toContain(norm(link));
    // 没有对链接目标做过枚举
    expect(h.mem.argsOf('readdir')).not.toContain(norm(link));
  });

  it('两个新根缺一 → 判为 0.9x，且一次文件系统调用都不发生', async () => {
    for (const over of [{ newSessionsRoot: null }, { newWorkspaceSessionDir: null }]) {
      const h = harness({ roots: over });
      const plan = await h.cleaner.plan('full', SESSION_ID, TITLE);

      expect(plan.layout).toBe('old');
      expect(plan.newSessionDir).toBeNull();
      // 0.9x 路径：本夹具没有任何存档，故连 stat 都不该发生
      expect(h.mem.argsOf('readdir')).toEqual([]);
    }
  });

  it('sessionId 含 .. 或指向围栏之外 → 判为 0.9x，不去枚举那个目录', async () => {
    for (const bad of ['..', path.join('..', 'other'), '.']) {
      const h = harness({});
      const plan = await h.cleaner.plan('full', bad, TITLE);
      expect(plan.layout).toBe('old');
      expect(h.mem.argsOf('readdir')).toEqual([]);
    }
  });
});

/* ================================================================== *
 * 2. 执行：rmdir 收尾的两条路径（Req 10.5、10.6）
 * ================================================================== */

describe('14.2 rmdir 收尾（Req 10.5、10.6、10.10）', () => {
  it('full 全部成功 → 自底向上收掉全部目录，会话目录本身也被移除', async () => {
    const h = harness({});
    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(res.state).toBe('done');
    expect(res.layout).toBe('new');
    expect(res.deletedFiles).toBe(6);
    expect(res.failed).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.removedDirs).toBe(5);
    // 会话目录确实不在了
    expect(h.mem.dirs.has(norm(SESSION_DIR))).toBe(false);

    // 每次 rmdir 之前必有一次对同一目录的 readdir（Req 10.5 的「重新枚举确认为空」）
    for (const dir of h.mem.argsOf('rmdir')) {
      const i = h.mem.calls.findIndex((c) => c.op === 'rmdir' && c.path === dir);
      const before = h.mem.calls.slice(0, i);
      expect(before.some((c) => c.op === 'readdir' && c.path === dir)).toBe(true);
    }
    // rmdir 实参恒落在会话目录之内（含它自身）
    for (const dir of h.mem.argsOf('rmdir')) {
      expect(dir === norm(SESSION_DIR) || dir.startsWith(norm(SESSION_DIR) + path.sep)).toBe(true);
    }
  });

  it('unlink 实参恒 ⊆ 计划枚举的文件集合（Req 10.7）', async () => {
    const h = harness({});
    const plan = await h.cleaner.plan('full', SESSION_ID, TITLE);
    const planned = new Set(plan.files.map((f) => norm(f.path)));

    const h2 = harness({});
    await h2.cleaner.run('full', SESSION_ID, TITLE);
    for (const p of h2.mem.argsOf('unlink')) expect(planned.has(p)).toBe(true);
  });

  it('确认之后新出现的文件不在删除范围内，且让目录非空 → 目录被保留并计入失败（Req 10.6、10.7）', async () => {
    const h = harness({});
    const intruder = path.join(SESSION_DIR, 'snapshots', 'h1', 'src', 'late.ts');
    // 删掉 a.ts 之后 Kiro 又往同一目录写了一个新文件
    h.mem.afterUnlink(path.join(SESSION_DIR, 'snapshots', 'h1', 'src', 'a.ts'), () => {
      h.mem.files.set(norm(intruder), { size: 10, mtimeMs: 1 });
    });

    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    // 新文件恒不被删除：它不在计划里
    expect(h.mem.argsOf('unlink')).not.toContain(norm(intruder));
    expect(h.mem.files.has(norm(intruder))).toBe(true);
    // 计划内的文件全删成功
    expect(res.deletedFiles).toBe(6);
    // 最深那一级非空 → 保留并计入失败，且就此停止（不再往上试）
    expect(res.removedDirs).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].path).toBe(path.join(SESSION_DIR, 'snapshots', 'h1', 'src'));
    expect(res.failed[0].reason).toContain('目录非空');
    // 会话目录仍在
    expect(h.mem.dirs.has(norm(SESSION_DIR))).toBe(true);
  });

  it('有文件删除失败时一个目录都不试，会话目录被保留', async () => {
    const h = harness({});
    h.mem.failUnlink(path.join(SESSION_DIR, 'messages.jsonl'), 'EIO');

    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(res.deletedFiles).toBe(5);
    expect(res.removedDirs).toBe(0);
    expect(h.mem.argsOf('rmdir')).toEqual([]);
    expect(res.failed.some((f) => f.reason.includes('已保留会话目录'))).toBe(true);
    expect(h.mem.dirs.has(norm(SESSION_DIR))).toBe(true);
  });

  it('attachment 模式恒不调用 rmdir（会话仍然存在）', async () => {
    const h = harness({});
    const res = await h.cleaner.run('attachment', SESSION_ID, TITLE);

    expect(res.deletedFiles).toBe(3);
    expect(res.removedDirs).toBe(0);
    expect(h.mem.argsOf('rmdir')).toEqual([]);
    // 本体两个文件仍在
    expect(h.mem.files.has(norm(path.join(SESSION_DIR, 'messages.jsonl')))).toBe(true);
    expect(h.mem.files.has(norm(path.join(SESSION_DIR, 'session.json')))).toBe(true);
  });

  it('未注入 rmdir 能力时一个目录都不动，并如实记为失败', async () => {
    const h = harness({
      fsOverride: (deps) => {
        const { rmdir: _omitted, ...rest } = deps;
        return rest as CleanerFsDeps;
      },
    });
    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(res.deletedFiles).toBe(6);
    expect(res.removedDirs).toBe(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].reason).toContain('未提供目录枚举/移除能力');
  });

  it('只剩空目录的残壳会话：不是空计划，full 仍把目录收掉（Req 10.14）', async () => {
    const h = harness({ files: {} });
    // 手工建出「只有空目录」的形态
    h.mem.dirs.add(norm(SESSION_DIR));
    h.mem.dirs.add(norm(path.join(SESSION_DIR, 'snapshots')));

    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(res.state).toBe('done');
    expect(res.deletedFiles).toBe(0);
    expect(res.removedDirs).toBe(2);
    expect(h.mem.dirs.has(norm(SESSION_DIR))).toBe(false);
  });

  it('取消确认 → 文件与目录一律原样，零写调用', async () => {
    const h = harness({ decision: 'cancel' });
    const res = await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(res.state).toBe('cancelled');
    expect(res.layout).toBe('new');
    expect(h.mem.argsOf('unlink')).toEqual([]);
    expect(h.mem.argsOf('rmdir')).toEqual([]);
    expect(h.mem.files.size).toBe(6);
  });
});

/* ================================================================== *
 * 3. 路径围栏（Req 10.8、10.10）
 * ================================================================== */

describe('14.2 1.x 路径围栏（Req 10.8、10.10）', () => {
  const R = roots();

  it('会话目录之内的文件放行；目录自身、目录之外、围栏之外一律拒绝', () => {
    const inside = path.join(SESSION_DIR, 'snapshots', 'h1', 'a.ts');
    expect(assertDeletable(R, inside, { isSymbolicLink: false, newSessionDir: SESSION_DIR })).toBeNull();

    // 会话目录自身不是可 unlink 的文件
    expect(
      assertDeletable(R, SESSION_DIR, { isSymbolicLink: false, newSessionDir: SESSION_DIR })
    ).toBe(DELETE_REJECT_REASONS.outsideNewSessionDir);

    // 兄弟会话目录（同前缀也不行）
    for (const outside of [
      path.join(NEW_WS_DIR, 'sess_other', 'session.json'),
      path.join(SESSION_DIR + '-backup', 'a.ts'),
      path.join(HOME_KIRO, 'tasks', 'x.json'),
    ]) {
      expect(
        assertDeletable(R, outside, { isSymbolicLink: false, newSessionDir: SESSION_DIR })
      ).toBe(DELETE_REJECT_REASONS.outsideNewSessionDir);
    }
  });

  it('含 .. 路径段恒先被拒（在规范化之前）', () => {
    // 刻意用字面分隔符拼**原始串**：`path.join` 会在传参前就把 `..` 消掉，
    // 那样测的就不是「规范化之前先查 .. 」这条顺序了
    const sneaky = [SESSION_DIR, 'snapshots', '..', '..', 'sess_other', 'a.ts'].join(path.sep);
    expect(assertDeletable(R, sneaky, { isSymbolicLink: false, newSessionDir: SESSION_DIR })).toBe(
      DELETE_REJECT_REASONS.dotDot
    );
    // 规范化后它确实落在别的会话目录里 —— 即「先查 .. 」拦住的正是一次真实越界
    expect(path.resolve(sneaky)).toBe(path.join(NEW_WS_DIR, 'sess_other', 'a.ts'));
  });

  it('符号链接一律拒绝', () => {
    const inside = path.join(SESSION_DIR, 'snapshots', 'link');
    expect(assertDeletable(R, inside, { isSymbolicLink: true, newSessionDir: SESSION_DIR })).toBe(
      DELETE_REJECT_REASONS.symlink
    );
  });

  it('拿不到 NewSessionsRoot 围栏时一律拒绝（「没有围栏」不等于「围栏无限大」）', () => {
    const noFence = roots({ newSessionsRoot: null });
    const inside = path.join(SESSION_DIR, 'a.ts');
    expect(
      assertDeletable(noFence, inside, { isSymbolicLink: false, newSessionDir: SESSION_DIR })
    ).toBe(DELETE_REJECT_REASONS.outsideNewSessionDir);
  });

  it('不传 newSessionDir 时行为与 0.9x 判定完全一致（1.x 分支不影响既有语义）', () => {
    const inside = path.join(SESSION_DIR, 'a.ts');
    // 1.x 路径落在 StoreRoot 之外，故按 0.9x 判定被 outsideStoreRoot 拒绝
    expect(assertDeletable(R, inside, { isSymbolicLink: false })).toBe(
      DELETE_REJECT_REASONS.outsideStoreRoot
    );
  });

  it('assertRemovableDir：会话目录及其子目录放行，其余拒绝', () => {
    expect(assertRemovableDir(R, SESSION_DIR, SESSION_DIR)).toBeNull();
    expect(assertRemovableDir(R, path.join(SESSION_DIR, 'snapshots'), SESSION_DIR)).toBeNull();

    for (const bad of [
      NEW_WS_DIR,
      NEW_SESSIONS_ROOT,
      path.join(NEW_WS_DIR, 'sess_other'),
      SESSION_DIR + '-backup',
    ]) {
      expect(assertRemovableDir(R, bad, SESSION_DIR)).toBe(
        DELETE_REJECT_REASONS.outsideNewSessionDir
      );
    }
    expect(
      assertRemovableDir(R, [SESSION_DIR, '..', 'sess_other'].join(path.sep), SESSION_DIR)
    ).toBe(DELETE_REJECT_REASONS.dotDot);
    expect(assertRemovableDir(roots({ newSessionsRoot: null }), SESSION_DIR, SESSION_DIR)).toBe(
      DELETE_REJECT_REASONS.outsideNewSessionDir
    );
  });
});

/* ================================================================== *
 * 4. 确认提示与审计（Req 10.13、10.18）
 * ================================================================== */

describe('14.4 确认提示与审计（Req 10.13、10.18）', () => {
  it('确认提示带会话格式与待移除目录数，使宿主能区分两种 full 的破坏面', async () => {
    const h = harness({});
    await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0].layout).toBe('new');
    expect(h.prompts[0].dirCount).toBe(5);
    expect(h.prompts[0].totalFiles).toBe(6);

    const h2 = harness({});
    await h2.cleaner.run('attachment', SESSION_ID, TITLE);
    // attachment 不收目录，故提示里不该出现「还会移除 N 个目录」
    expect(h2.prompts[0].dirCount).toBe(0);
  });

  it('审计两次写入都带「格式=1.x 目录型」，并列出待移除目录序列与已移除数', async () => {
    const h = harness({});
    await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(h.audits).toHaveLength(2);
    const planLines = h.audits[0];
    expect(planLines[0]).toContain('格式=1.x 目录型');
    expect(planLines).toContain(`  会话目录：${SESSION_DIR}`);
    expect(planLines.filter((l) => l.startsWith('  - 待移除空目录 '))).toHaveLength(5);
    // 审计里的目录顺序即执行顺序（自底向上），便于中断后定位停在哪一级
    expect(planLines[planLines.length - 1]).toBe(`  - 待移除空目录 ${SESSION_DIR}`);

    const detail = h.audits[1];
    expect(detail[0]).toContain('格式=1.x 目录型');
    expect(detail[1]).toContain('已移除空目录 5 个');
  });

  it('缓存失效拿到的路径含被删文件与被移除的目录（Req 10.19 的输入）', async () => {
    const h = harness({});
    await h.cleaner.run('full', SESSION_ID, TITLE);

    expect(h.invalidated).toHaveLength(1);
    const paths = h.invalidated[0].map(norm);
    expect(paths).toContain(norm(path.join(SESSION_DIR, 'messages.jsonl')));
    expect(paths).toContain(norm(SESSION_DIR));
  });

  it('同 sessionId 互斥：第二次请求被拒绝且不写审计（Req 10.21）', async () => {
    const h = harness({});
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new SessionCleaner({
      fs: h.mem.deps,
      audit: (lines) => void h.audits.push(lines),
      confirm: async (p) => {
        h.prompts.push(p);
        await gate;
        return 'confirm';
      },
      archives: () => [],
      invalidate: () => {},
      roots: roots(),
    });

    const first = slow.run('full', SESSION_ID, TITLE);
    const second = await slow.run('full', SESSION_ID, TITLE);
    expect(second.state).toBe('rejected');
    expect(second.failed[0].reason).toContain('正在进行');

    release!();
    const firstResult = await first;
    expect(firstResult.state).toBe('done');
  });
});

/* ================================================================== *
 * 5. 0.9x 回归：同一个 cleaner 同时服务两种格式
 * ================================================================== */

describe('14.11 0.9x 回归：给了 1.x 根也不影响单文件会话的判定', () => {
  it('目标目录不存在时落回 0.9x，且 layout 为 old', async () => {
    const h = harness({ files: {} });
    const plan = await h.cleaner.plan('full', 'legacy-uuid', TITLE);

    expect(plan.layout).toBe('old');
    expect(plan.dirs).toEqual([]);
    expect(plan.newSessionDir).toBeNull();
    // 0.9x 的清单条目移除仍被列为附加操作
    expect(plan.manifestUpdate).toEqual({
      path: path.join(OLD_SESSION_DIR, 'sessions.json'),
      sessionId: 'legacy-uuid',
    });
  });

  it('0.9x 空计划仍是 noop 且不弹确认（Req 10.14）', async () => {
    const h = harness({ files: {} });
    const res = await h.cleaner.run('attachment', 'legacy-uuid', TITLE);

    expect(res.state).toBe('noop');
    expect(res.layout).toBe('old');
    expect(h.prompts).toEqual([]);
    expect(h.audits).toEqual([]);
  });
});
