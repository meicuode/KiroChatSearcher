import * as crypto from 'crypto';
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

// ---------------------------------------------------------------------------
// Kiro 1.x（新布局）路径解析
//
// 1.x 把会话搬到了用户主目录下的 `~/.kiro`，且工作区目录名换了哈希算法。
// 本节只做「路径拼接 + 存在性判断」，属 ReadOnlyPaths：不引入任何写文件系统 API。
// 所有解析函数都经 PathResolverDeps 注入 homedir / existsSync / statSync，
// 使单元测试无需读写真实用户目录。
// ---------------------------------------------------------------------------

/**
 * 1.x 的用户级 Kiro 目录：`~/.kiro`。
 * 目录不存在（或 homedir 解析失败）时返回 `null`，不抛异常。
 */
export function getHomeKiroDir(deps?: PathResolverDeps): string | null {
  const d = resolveDeps(deps);
  try {
    const dir = path.join(d.homedir(), '.kiro');
    return d.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 1.x 会话根目录：`~/.kiro/sessions`。
 * 其下每个子目录是一个工作区（目录名为 WsHash16），再下一层每个子目录是一个会话。
 * 目录不存在返回 `null`，不抛异常。
 */
export function getNewSessionsRoot(deps?: PathResolverDeps): string | null {
  const d = resolveDeps(deps);
  const homeKiroDir = getHomeKiroDir(deps);
  if (!homeKiroDir) return null;
  try {
    const root = path.join(homeKiroDir, 'sessions');
    return d.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * 1.x 会话索引根目录：`~/.kiro/session-index`，其下为 `<WsHash16>.jsonl` 追加式索引。
 * 仅用于占用统计分类；**不作为会话枚举来源**（追加式日志可能含已删除会话的历史条目）。
 * 目录不存在返回 `null`，不抛异常。
 */
export function getNewSessionIndexRoot(deps?: PathResolverDeps): string | null {
  const d = resolveDeps(deps);
  const homeKiroDir = getHomeKiroDir(deps);
  if (!homeKiroDir) return null;
  try {
    const root = path.join(homeKiroDir, 'session-index');
    return d.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * 计算 1.x 的工作区目录名 WsHash16：
 *   `sha256( workspacePath.replace(/\\/g, '/').toLowerCase() )` 的十六进制**前 16 位**。
 *
 * 归一化顺序固定为「先把反斜杠替换为正斜杠、再转小写」，因此盘符大小写变体
 * （`D:\foo` / `d:\foo`）与斜杠方向变体（`d:\foo` / `d:/foo`）产出同一个哈希。
 *
 * **与 0.9x 的两套旧算法都不同，切勿互相替用**：
 * - `credits.ts` 的 `hash32(s)` = `sha256(原始字符串)` 前 **32** 位，**不做任何归一化**，
 *   用于 0.9x 的 WorkspaceId 与执行存档目录（`<workspaceId>/<bucket>/<hash32(executionId)>`）。
 * - `encodeWorkspaceKeys` 是 base64url 编码（非哈希），用于 0.9x 的 `workspace-sessions/<EncodedKey>`。
 * - 迁移标记 `._migration-*.json` 里的 `workspaceHash` 是 `sha256(原始路径)` 前 16 位
 *   （**未归一化**），同样不等于 WsHash16，不能拿它去定位新目录。
 *
 * 纯函数：不访问文件系统。
 */
export function computeWsHash16(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 解析当前工作区在 1.x 下的会话目录：`<newSessionsRoot>/<WsHash16>`。
 * 目录不存在（或文件系统异常）时返回 `null`，表示该工作区在 1.x 下暂无会话目录，
 * 由调用方决定后续行为，不抛异常。
 */
export function resolveNewWorkspaceSessionDir(
  newSessionsRoot: string,
  workspacePath: string,
  deps?: PathResolverDeps
): string | null {
  const d = resolveDeps(deps);
  const dir = path.join(newSessionsRoot, computeWsHash16(workspacePath));
  try {
    if (d.existsSync(dir) && d.statSync(dir).isDirectory()) {
      return dir;
    }
  } catch {
    // 文件系统异常视为不可用
  }
  return null;
}
