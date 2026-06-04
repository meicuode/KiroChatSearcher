import { getSessionsRoot, resolveWorkspaceSessionDir, PathResolverDeps } from './paths';

export interface EnvCheck {
  ok: boolean;
  error?: string;
  hint?: string;
  userDataDir?: string;
  sessionsRoot?: string;
  workspaceDir?: string;
}

/**
 * 一个最小化的工作区抽象，避免在核心逻辑中硬依赖 vscode 类型，
 * 便于在单元测试中注入 mock。
 */
export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface EnvCheckerDeps {
  /** 当前工作区第一个文件夹；未打开工作区时为 null/undefined */
  workspaceFolder?: WorkspaceFolderLike | null;
  /** 透传给 PathResolver 的可注入依赖（platform/env/homedir/existsSync/statSync） */
  pathResolver?: PathResolverDeps;
}

function platformExpectedUserData(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return '请确认 Kiro 已安装，并存在目录 %APPDATA%\\Kiro';
    case 'darwin':
      return '请确认 Kiro 已安装，并存在目录 ~/Library/Application Support/Kiro';
    default:
      return '请确认 Kiro 已安装，并存在目录 ${XDG_CONFIG_HOME:-~/.config}/Kiro';
  }
}

/**
 * 校验运行环境，按以下优先级返回第一个错误：
 *   (1) UserDataDir 缺失 → (2) SessionsRoot 缺失 → (3) 未打开工作区 → (4) WorkspaceSessionDir 缺失
 * 全部就绪时返回 { ok: true, userDataDir, sessionsRoot, workspaceDir }。
 */
export function checkEnvironment(deps?: EnvCheckerDeps): EnvCheck {
  const pathDeps = deps?.pathResolver;
  const platform = pathDeps?.platform ?? process.platform;

  const { root, userDataDir } = getSessionsRoot(pathDeps);

  if (!userDataDir) {
    return {
      ok: false,
      error: '未找到 Kiro 用户数据目录',
      hint: platformExpectedUserData(platform),
    };
  }

  if (!root) {
    return {
      ok: false,
      error: '未找到 Kiro 对话存储目录',
      hint: `预期位置: ${userDataDir}/User/globalStorage/kiro.kiroagent/workspace-sessions`,
      userDataDir,
    };
  }

  const ws = deps?.workspaceFolder;
  if (!ws) {
    return {
      ok: false,
      error: '当前没有打开任何工作区',
      hint: '请先在 Kiro 中打开一个项目，再使用对话搜索',
      userDataDir,
      sessionsRoot: root,
    };
  }

  const wsDir = resolveWorkspaceSessionDir(root, ws.uri.fsPath, pathDeps);
  if (!wsDir) {
    return {
      ok: false,
      error: '当前项目还没有 Kiro 对话历史',
      hint: `工作区: ${ws.uri.fsPath}`,
      userDataDir,
      sessionsRoot: root,
    };
  }

  return { ok: true, userDataDir, sessionsRoot: root, workspaceDir: wsDir };
}
