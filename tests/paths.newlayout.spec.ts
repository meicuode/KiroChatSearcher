import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  computeWsHash16,
  getHomeKiroDir,
  getNewSessionsRoot,
  getNewSessionIndexRoot,
  resolveNewWorkspaceSessionDir,
  PathResolverDeps,
} from '../src/paths';
import { hash32 } from '../src/credits';

/**
 * Kiro 1.x（新布局）路径解析的示例测试。
 *
 * 全部用例都经 `PathResolverDeps` 注入 `homedir` / `existsSync` / `statSync`，
 * **不触碰真实的 `~/.kiro`**：`computeWsHash16` 是纯函数，其余解析函数只做
 * 路径拼接 + 存在性判断，注入假 fs 即可完整覆盖。
 *
 * _Requirements: 2.4, 2.7（另覆盖 2.1、2.2、2.3、2.9 的示例侧断言）_
 */

/** 假 home：与真实用户目录无关，仅用于拼接期望路径 */
const HOME = process.platform === 'win32' ? 'C:\\Users\\fake-u' : '/home/fake-u';
const HOME_KIRO = path.join(HOME, '.kiro');
const NEW_SESSIONS = path.join(HOME_KIRO, 'sessions');
const NEW_SESSION_INDEX = path.join(HOME_KIRO, 'session-index');

/**
 * 构造一组注入依赖：`existing` 里列出的路径视为存在的目录，其余一律不存在。
 * `statSync` 对 `existing` 中的路径返回 `isDirectory() === true`，对其余路径抛 ENOENT
 * （与真实 fs 行为一致，用于验证解析函数把异常吞掉而不上抛）。
 */
function depsWithExisting(existing: string[], home: string = HOME): PathResolverDeps {
  const set = new Set(existing);
  return {
    homedir: () => home,
    existsSync: (p) => set.has(p),
    statSync: (p) => {
      if (!set.has(p)) throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
      return { isDirectory: () => true };
    },
  };
}

describe('computeWsHash16 实测基线', () => {
  // 这两个值来自真实机器（Kiro 1.0.337）上的 `~/.kiro/sessions` 目录名实测，
  // 是整个 1.x 适配的锚点：算法一旦被改坏，这里立刻失败。
  it('d:\\Projects\\KiroExt\\KiroChatSearcher → cc5023603866cd91', () => {
    expect(computeWsHash16('d:\\Projects\\KiroExt\\KiroChatSearcher')).toBe('cc5023603866cd91');
  });

  it('d:\\SurErp\\ERP-OMS-Workspaces → 6082f0c94c5c4af8', () => {
    expect(computeWsHash16('d:\\SurErp\\ERP-OMS-Workspaces')).toBe('6082f0c94c5c4af8');
  });

  it('产出恒为 16 位小写十六进制', () => {
    const h = computeWsHash16('d:\\Projects\\KiroExt\\KiroChatSearcher');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('computeWsHash16 归一化', () => {
  // 归一化规则：先把反斜杠替换为正斜杠、再转小写。故盘符大小写与斜杠方向的
  // 四个变体必须落到同一个目录名（属性测试覆盖任意组合，这里钉住具体取值）。
  const variants = [
    'd:\\Projects\\KiroExt\\KiroChatSearcher',
    'D:\\Projects\\KiroExt\\KiroChatSearcher',
    'd:/Projects/KiroExt/KiroChatSearcher',
    'D:/Projects/KiroExt/KiroChatSearcher',
  ];

  it('盘符大小写与斜杠方向的四个变体产出同一哈希', () => {
    const hashes = variants.map(computeWsHash16);
    expect(hashes).toEqual([
      'cc5023603866cd91',
      'cc5023603866cd91',
      'cc5023603866cd91',
      'cc5023603866cd91',
    ]);
    expect(new Set(hashes).size).toBe(1);
  });

  it('归一化是整串小写：路径段大小写不影响哈希，路径本身不同才改变哈希', () => {
    // toLowerCase 作用于整串，因此 `projects` 与 `Projects` 归一化后相同 ——
    // 真正会改变哈希的是路径本身不同（多/少一段）。
    expect(computeWsHash16('d:/projects/kiroext/kirochatsearcher')).toBe('cc5023603866cd91');
    expect(computeWsHash16('d:\\Projects\\KiroExt')).not.toBe('cc5023603866cd91');
  });
});

describe('新布局根目录解析', () => {
  it('~/.kiro 与 sessions / session-index 都存在时返回各自路径', () => {
    const deps = depsWithExisting([HOME_KIRO, NEW_SESSIONS, NEW_SESSION_INDEX]);
    expect(getHomeKiroDir(deps)).toBe(HOME_KIRO);
    expect(getNewSessionsRoot(deps)).toBe(NEW_SESSIONS);
    expect(getNewSessionIndexRoot(deps)).toBe(NEW_SESSION_INDEX);
  });

  it('~/.kiro 存在但子目录缺失时子目录解析为 null 且 ~/.kiro 仍可用', () => {
    const deps = depsWithExisting([HOME_KIRO]);
    expect(getHomeKiroDir(deps)).toBe(HOME_KIRO);
    expect(getNewSessionsRoot(deps)).toBeNull();
    expect(getNewSessionIndexRoot(deps)).toBeNull();
  });

  it('~/.kiro 本身缺失时三个解析函数全部返回 null', () => {
    const deps = depsWithExisting([]);
    expect(getHomeKiroDir(deps)).toBeNull();
    expect(getNewSessionsRoot(deps)).toBeNull();
    expect(getNewSessionIndexRoot(deps)).toBeNull();
  });

  it('三种情形下均不抛异常', () => {
    const cases = [
      depsWithExisting([HOME_KIRO, NEW_SESSIONS, NEW_SESSION_INDEX]),
      depsWithExisting([HOME_KIRO]),
      depsWithExisting([]),
    ];
    for (const deps of cases) {
      expect(() => getHomeKiroDir(deps)).not.toThrow();
      expect(() => getNewSessionsRoot(deps)).not.toThrow();
      expect(() => getNewSessionIndexRoot(deps)).not.toThrow();
    }
  });

  it('homedir() 抛异常时返回 null 而不上抛', () => {
    const deps: PathResolverDeps = {
      homedir: () => {
        throw new Error('EIO: homedir unavailable');
      },
      existsSync: () => true,
      statSync: () => ({ isDirectory: () => true }),
    };
    expect(() => getHomeKiroDir(deps)).not.toThrow();
    expect(() => getNewSessionsRoot(deps)).not.toThrow();
    expect(() => getNewSessionIndexRoot(deps)).not.toThrow();
    expect(getHomeKiroDir(deps)).toBeNull();
    expect(getNewSessionsRoot(deps)).toBeNull();
    expect(getNewSessionIndexRoot(deps)).toBeNull();
  });

  it('existsSync 抛异常时返回 null 而不上抛', () => {
    const deps: PathResolverDeps = {
      homedir: () => HOME,
      existsSync: () => {
        throw new Error('EACCES: permission denied');
      },
      statSync: () => ({ isDirectory: () => true }),
    };
    expect(() => getHomeKiroDir(deps)).not.toThrow();
    expect(getHomeKiroDir(deps)).toBeNull();
    expect(getNewSessionsRoot(deps)).toBeNull();
    expect(getNewSessionIndexRoot(deps)).toBeNull();
  });
});

describe('resolveNewWorkspaceSessionDir', () => {
  const WS = 'd:\\Projects\\KiroExt\\KiroChatSearcher';
  const WS_DIR = path.join(NEW_SESSIONS, 'cc5023603866cd91');

  it('目录存在时返回 <sessionsRoot>/<WsHash16>', () => {
    const deps = depsWithExisting([HOME_KIRO, NEW_SESSIONS, WS_DIR]);
    expect(resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).toBe(WS_DIR);
  });

  it('盘符大小写/斜杠方向变体解析到同一目录', () => {
    const deps = depsWithExisting([HOME_KIRO, NEW_SESSIONS, WS_DIR]);
    expect(resolveNewWorkspaceSessionDir(NEW_SESSIONS, 'D:/Projects/KiroExt/KiroChatSearcher', deps))
      .toBe(WS_DIR);
  });

  it('目录不存在时返回 null（该工作区在 1.x 下暂无会话目录）', () => {
    const deps = depsWithExisting([HOME_KIRO, NEW_SESSIONS]);
    expect(() => resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).not.toThrow();
    expect(resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).toBeNull();
  });

  it('同名路径是文件而非目录时返回 null', () => {
    const deps: PathResolverDeps = {
      homedir: () => HOME,
      existsSync: (p) => p === WS_DIR,
      statSync: () => ({ isDirectory: () => false }),
    };
    expect(resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).toBeNull();
  });

  it('statSync 抛异常时返回 null 而不上抛', () => {
    const deps: PathResolverDeps = {
      homedir: () => HOME,
      existsSync: () => true,
      statSync: () => {
        throw new Error('EPERM: operation not permitted');
      },
    };
    expect(() => resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).not.toThrow();
    expect(resolveNewWorkspaceSessionDir(NEW_SESSIONS, WS, deps)).toBeNull();
  });
});

describe('新旧哈希算法的区分度', () => {
  const WS = 'd:\\Projects\\KiroExt\\KiroChatSearcher';

  it('computeWsHash16 与 hash32 对同一输入产出不同结果且长度不同', () => {
    const wsHash16 = computeWsHash16(WS);
    const old32 = hash32(WS);
    expect(wsHash16).toHaveLength(16);
    expect(old32).toHaveLength(32);
    expect(wsHash16).not.toBe(old32);
  });

  it('迁移标记里的 workspaceHash（旧算法前 16 位）不能用来定位新目录', () => {
    // 坑（research-notes 第 2 节实测）：旧目录里 `._migration-*.json` 的
    // `workspaceHash` = sha256(**原始**路径).slice(0,16)，即 hash32 的前 16 位；
    // 新目录名 WsHash16 = sha256(**归一化后**路径).slice(0,16)。
    // 两者摘要输入不同（是否归一化），因此值不同 —— 拿标记里的值去
    // `<NewSessionsRoot>/<hash>` 查目录必然落空。
    const markerWorkspaceHash = hash32(WS).slice(0, 16);
    expect(markerWorkspaceHash).toHaveLength(16);
    expect(markerWorkspaceHash).not.toBe(computeWsHash16(WS));
  });

  it('hash32 不做归一化：盘符大小写变体产出不同结果（与 WsHash16 相反）', () => {
    expect(hash32('d:\\Projects\\KiroExt\\KiroChatSearcher')).not.toBe(
      hash32('D:\\Projects\\KiroExt\\KiroChatSearcher')
    );
    expect(computeWsHash16('d:\\Projects\\KiroExt\\KiroChatSearcher')).toBe(
      computeWsHash16('D:\\Projects\\KiroExt\\KiroChatSearcher')
    );
  });
});
