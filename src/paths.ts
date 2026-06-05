import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 可注入依赖，便于在单元测试中 mock 平台 / 环境变量 / 文件系统，
 * 而无需污染全局 process.platform 或真实磁盘。
 * 所有字段可选，缺省时退回真实的 process.* / os.* / fs.*。
 */
export interface PathResolverDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  existsSync?: (p: string) => boolean;
  statSync?: (p: string) => { isDirectory(): boolean };
}

interface ResolvedDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isDirectory(): boolean };
}

function resolveDeps(deps?: PathResolverDeps): ResolvedDeps {
  return {
    platform: deps?.platform ?? process.platform,
    env: deps?.env ?? process.env,
    homedir: deps?.homedir ?? os.homedir,
    existsSync: deps?.existsSync ?? fs.existsSync,
    statSync: deps?.statSync ?? (fs.statSync as (p: string) => fs.Stats),
  };
}

/**
 * 跨平台获取 Kiro 用户数据目录（与 VSCode 相同的 user-data 结构）。
 * Windows: %APPDATA%\Kiro
 * macOS:   ~/Library/Application Support/Kiro
 * Linux:   ${XDG_CONFIG_HOME:-~/.config}/Kiro
 */
export function getKiroUserDataDir(deps?: PathResolverDeps): string | null {
  const d = resolveDeps(deps);
  const candidates: string[] = [];
  switch (d.platform) {
    case 'win32': {
      const appData = d.env.APPDATA || path.join(d.homedir(), 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'Kiro'));
      break;
    }
    case 'darwin':
      candidates.push(path.join(d.homedir(), 'Library', 'Application Support', 'Kiro'));
      break;
    default: {
      const xdg = d.env.XDG_CONFIG_HOME || path.join(d.homedir(), '.config');
      candidates.push(path.join(xdg, 'Kiro'));
      break;
    }
  }
  for (const c of candidates) {
    if (d.existsSync(c)) return c;
  }
  return null;
}

/**
 * 对话存储根目录： <UserData>/User/globalStorage/kiro.kiroagent/workspace-sessions
 */
export function getSessionsRoot(
  deps?: PathResolverDeps
): { root: string | null; userDataDir: string | null } {
  const d = resolveDeps(deps);
  const userDataDir = getKiroUserDataDir(deps);
  if (!userDataDir) return { root: null, userDataDir: null };
  const root = path.join(
    userDataDir,
    'User',
    'globalStorage',
    'kiro.kiroagent',
    'workspace-sessions'
  );
  return { root: d.existsSync(root) ? root : null, userDataDir };
}

/**
 * 把工作区绝对路径编码为 Kiro 使用的 base64url 目录名。
 * 编码规则：base64(workspacePath)，去掉 '='，'+' -> '-'，'/' -> '_'。
 * 不同 OS 的盘符大小写与斜杠方向有差异，因此返回多个候选键。
 * 原始 workspacePath 对应的 EncodedKey 始终排在列表首位。
 */
export function encodeWorkspaceKeys(workspacePath: string): string[] {
  const variants = new Set<string>();
  const raw = workspacePath;
  variants.add(raw);

  // Windows 盘符大小写差异：C:\foo vs c:\foo
  if (/^[a-zA-Z]:/.test(raw)) {
    variants.add(raw[0].toUpperCase() + raw.slice(1));
    variants.add(raw[0].toLowerCase() + raw.slice(1));
  }

  // 正反斜杠差异：\ <-> /
  for (const v of [...variants]) {
    variants.add(v.replace(/\\/g, '/'));
    variants.add(v.replace(/\//g, '\\'));
  }

  const keys = [...variants].map(encodeBase64Url);
  // 去重，保留首次出现顺序（raw 在最前）
  return [...new Set(keys)];
}

/**
 * Kiro 实际使用的 base64url 变体：
 *   base64(utf8(s))，把 '+' 替换为 '-'，把 '/' 替换为 '_'，
 *   并把 '=' padding **保留**（替换为 '_'）。
 *
 * 之前实现把 '=' 直接删掉，对长度恰为 3 字节倍数的路径恰好等价（无 padding），
 * 但路径长度 mod 3 != 0 时会少 1~2 个尾部下划线，导致目录匹配失败。
 */
function encodeBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '_');
}

/**
 * 在 sessions root 下找到与当前工作区匹配的目录。
 * 先按编码键精确匹配；若都不存在，返回 null。
 */
export function resolveWorkspaceSessionDir(
  sessionsRoot: string,
  workspacePath: string,
  deps?: PathResolverDeps
): string | null {
  const d = resolveDeps(deps);
  const keys = encodeWorkspaceKeys(workspacePath);
  for (const key of keys) {
    const dir = path.join(sessionsRoot, key);
    try {
      if (d.existsSync(dir) && d.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch {
      // 文件系统异常视为不匹配，继续尝试下一个候选
    }
  }
  return null;
}
