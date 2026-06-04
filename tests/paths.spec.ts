import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  getKiroUserDataDir,
  getSessionsRoot,
  encodeWorkspaceKeys,
  resolveWorkspaceSessionDir,
  PathResolverDeps,
} from '../src/paths';
import { mkTempDir, rmTempDir } from './_helpers';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

/** 构造一个 existsSync 永远为 true 的 deps，便于断言候选路径选择 */
function depsWith(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home = '/home/u'
): PathResolverDeps {
  return {
    platform,
    env,
    homedir: () => home,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

describe('getKiroUserDataDir', () => {
  it('Windows 使用 %APPDATA%\\Kiro', () => {
    const dir = getKiroUserDataDir(depsWith('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }));
    expect(dir).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'Kiro'));
  });

  it('Windows 缺少 APPDATA 时回退到 homedir/AppData/Roaming', () => {
    const dir = getKiroUserDataDir(depsWith('win32', {}, 'C:\\Users\\u'));
    expect(dir).toBe(path.join('C:\\Users\\u', 'AppData', 'Roaming', 'Kiro'));
  });

  it('macOS 使用 ~/Library/Application Support/Kiro', () => {
    const dir = getKiroUserDataDir(depsWith('darwin', {}, '/Users/u'));
    expect(dir).toBe(path.join('/Users/u', 'Library', 'Application Support', 'Kiro'));
  });

  it('Linux 使用 $XDG_CONFIG_HOME/Kiro', () => {
    const dir = getKiroUserDataDir(depsWith('linux', { XDG_CONFIG_HOME: '/home/u/.cfg' }));
    expect(dir).toBe(path.join('/home/u/.cfg', 'Kiro'));
  });

  it('Linux 缺少 XDG_CONFIG_HOME 时回退到 ~/.config/Kiro', () => {
    const dir = getKiroUserDataDir(depsWith('linux', {}, '/home/u'));
    expect(dir).toBe(path.join('/home/u', '.config', 'Kiro'));
  });

  it('候选目录不存在时返回 null', () => {
    const dir = getKiroUserDataDir({
      platform: 'linux',
      env: {},
      homedir: () => '/home/u',
      existsSync: () => false,
    });
    expect(dir).toBeNull();
  });
});

describe('getSessionsRoot', () => {
  it('UserData 存在但 sessions root 不存在时 root 为 null 并保留 userDataDir', () => {
    const userData = path.join('/home/u', '.config', 'Kiro');
    const sessionsRoot = path.join(
      userData,
      'User',
      'globalStorage',
      'kiro.kiroagent',
      'workspace-sessions'
    );
    const deps: PathResolverDeps = {
      platform: 'linux',
      env: {},
      homedir: () => '/home/u',
      existsSync: (p) => p === userData, // sessions root 不存在
    };
    const res = getSessionsRoot(deps);
    expect(res.userDataDir).toBe(userData);
    expect(res.root).toBeNull();
    expect(sessionsRoot).toContain('workspace-sessions');
  });

  it('UserData 与 sessions root 都存在时返回完整路径', () => {
    const res = getSessionsRoot(depsWith('linux', {}, '/home/u'));
    expect(res.userDataDir).not.toBeNull();
    expect(res.root).toContain('workspace-sessions');
  });
});

describe('resolveWorkspaceSessionDir', () => {
  it('命中已存在的 EncodedKey 目录时返回该路径', () => {
    const root = mkTempDir();
    tmpDirs.push(root);
    const wsPath = 'C:\\Projects\\Demo';
    const keys = encodeWorkspaceKeys(wsPath);
    // 只创建其中一个候选目录（取列表中靠后的一个，验证会被找到）
    const target = path.join(root, keys[keys.length - 1]);
    fs.mkdirSync(target);

    const found = resolveWorkspaceSessionDir(root, wsPath);
    expect(found).toBe(target);
  });

  it('没有任何候选目录时返回 null', () => {
    const root = mkTempDir();
    tmpDirs.push(root);
    const found = resolveWorkspaceSessionDir(root, '/no/such/workspace');
    expect(found).toBeNull();
  });
});
