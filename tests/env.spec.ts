import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { checkEnvironment } from '../src/env';
import { encodeWorkspaceKeys } from '../src/paths';

/**
 * 搭建一套 PathResolver deps，使 existsSync 仅对给定的存在路径集合返回 true。
 */
function fsDeps(existing: Set<string>) {
  return {
    platform: 'linux' as NodeJS.Platform,
    env: { XDG_CONFIG_HOME: '/cfg' },
    homedir: () => '/home/u',
    existsSync: (p: string) => existing.has(p),
    statSync: () => ({ isDirectory: () => true }),
  };
}

const USER_DATA = path.join('/cfg', 'Kiro');
const SESSIONS_ROOT = path.join(
  USER_DATA,
  'User',
  'globalStorage',
  'kiro.kiroagent',
  'workspace-sessions'
);

describe('checkEnvironment - 错误优先级', () => {
  it('UserDataDir 缺失 → 第一类错误（即使同时没有工作区）', () => {
    const env = checkEnvironment({
      workspaceFolder: null,
      pathResolver: fsDeps(new Set()),
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe('未找到 Kiro 用户数据目录');
    expect(env.userDataDir).toBeUndefined();
  });

  it('UserDataDir 存在但 SessionsRoot 缺失 → 第二类错误并保留 userDataDir', () => {
    const env = checkEnvironment({
      workspaceFolder: null,
      pathResolver: fsDeps(new Set([USER_DATA])),
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe('未找到 Kiro 对话存储目录');
    expect(env.userDataDir).toBe(USER_DATA);
  });

  it('UserData/Sessions 都在但未打开工作区 → 第三类错误', () => {
    const env = checkEnvironment({
      workspaceFolder: null,
      pathResolver: fsDeps(new Set([USER_DATA, SESSIONS_ROOT])),
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe('当前没有打开任何工作区');
    expect(env.sessionsRoot).toBe(SESSIONS_ROOT);
  });

  it('工作区无对应会话目录 → 第四类错误并显示工作区路径', () => {
    const env = checkEnvironment({
      workspaceFolder: { uri: { fsPath: '/work/proj' } },
      pathResolver: fsDeps(new Set([USER_DATA, SESSIONS_ROOT])),
    });
    expect(env.ok).toBe(false);
    expect(env.error).toBe('当前项目还没有 Kiro 对话历史');
    expect(env.hint).toContain('/work/proj');
  });

  it('全部就绪 → ok 为 true 且包含三段路径', () => {
    const wsPath = '/work/proj';
    const keys = encodeWorkspaceKeys(wsPath);
    const wsDir = path.join(SESSIONS_ROOT, keys[0]);
    const existing = new Set([USER_DATA, SESSIONS_ROOT, wsDir]);

    const env = checkEnvironment({
      workspaceFolder: { uri: { fsPath: wsPath } },
      pathResolver: {
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/cfg' },
        homedir: () => '/home/u',
        existsSync: (p: string) => existing.has(p),
        statSync: () => ({ isDirectory: () => true }),
        // 表达「旧会话目录里确实有一条会话」。Req 1.3 的判据不再只看目录是否存在，
        // 而是要求「目录存在**且含至少一个 `<sessionId>.json`**」，因此 detectLayout 会
        // 枚举该目录。不注入 readdirSync 就会落到真实 fs 上、对这个虚构路径抛 ENOENT，
        // 被当成「旧侧不成立」→ layout 变 none → ok 为 false。
        readdirSync: () => ['0f0f.json'],
      },
    });

    expect(env.ok).toBe(true);
    expect(env.userDataDir).toBe(USER_DATA);
    expect(env.sessionsRoot).toBe(SESSIONS_ROOT);
    expect(env.workspaceDir).toBe(wsDir);
  });
});
