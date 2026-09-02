import * as path from 'path';
import { detectLayout } from './layout';
import type { LayoutFsDeps, LayoutRoots, StorageLayout } from './layout';

/**
 * 环境校验结果。
 *
 * **既有字段的语义保持不变**（0.9x 口径），使既有调用方（`src/extension.ts` 的
 * `checkEnv()` 消费处）无需改动即可继续工作：
 * - `sessionsRoot` 仍指 0.9x 的 OldSessionsRoot（`<UserDataDir>/.../workspace-sessions`）
 * - `workspaceDir` 仍指 0.9x 的 OldWorkspaceSessionDir
 *
 * 1.x 的信息走**新增字段** `newWorkspaceDir` 与 `layout`。因此纯 1.x 环境下
 * `ok` 为 true 而 `workspaceDir` 为 undefined —— 既有调用方本就写着
 * `if (!env.ok || !env.workspaceDir) return;`，此时行为与"旧目录里没有会话"一致，
 * 不会拿到错误的路径；新格式取数由 SearchEngine/StorageAnalyzer 经 `newWorkspaceDir` 接入。
 */
export interface EnvCheck {
  ok: boolean;
  error?: string;
  hint?: string;
  userDataDir?: string;
  /** 0.9x 的 OldSessionsRoot；1.x-only 环境下为 undefined。 */
  sessionsRoot?: string;
  /** 0.9x 的 OldWorkspaceSessionDir（既有语义，未变）。 */
  workspaceDir?: string;
  /** 1.x 的 NewWorkspaceSessionDir（`~/.kiro/sessions/<WsHash16>`）。 */
  newWorkspaceDir?: string;
  /** 本次检测判定的存储布局；未走到布局判定的早期错误分支上可能为 undefined。 */
  layout?: StorageLayout;
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
  /**
   * 透传给 LayoutDetector / PathResolver 的可注入依赖
   * （platform / env / homedir / existsSync / statSync / readdirSync）。
   *
   * 类型从 `PathResolverDeps` 放宽为 {@link LayoutFsDeps}（后者 extends 前者）：
   * 布局判定需要枚举目录才能分清"目录存在但为空"与"目录里真有会话"，
   * 该注入点必须能透传到 `detectLayout`。放宽是**协变**方向的，
   * 既有传 `PathResolverDeps` 字面量/变量的调用方与测试全部继续通过类型检查。
   */
  pathResolver?: LayoutFsDeps;
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

/** 0.9x 会话根的**预期**位置文案；UserDataDir 未解析出来时用占位符，避免拼出 "null/User/..."。 */
function expectedOldSessionsRoot(userDataDir: string | null): string {
  return path.join(
    userDataDir ?? '<UserDataDir>',
    'User',
    'globalStorage',
    'kiro.kiroagent',
    'workspace-sessions'
  );
}

/** 把 LayoutRoots 里的路径搬到 EnvCheck 的字段上（null → 省略该字段）。 */
function pathsOf(roots: LayoutRoots): Omit<EnvCheck, 'ok' | 'error' | 'hint'> {
  const out: Omit<EnvCheck, 'ok' | 'error' | 'hint'> = { layout: roots.layout };
  if (roots.userDataDir) out.userDataDir = roots.userDataDir;
  if (roots.oldSessionsRoot) out.sessionsRoot = roots.oldSessionsRoot;
  if (roots.oldWorkspaceSessionDir) out.workspaceDir = roots.oldWorkspaceSessionDir;
  if (roots.newWorkspaceSessionDir) out.newWorkspaceDir = roots.newWorkspaceSessionDir;
  return out;
}

/**
 * 校验运行环境。
 *
 * 判定顺序（错误优先级）：
 *   1. UserDataDir 与 HomeKiroDir **都**缺失 → 「未找到 Kiro 用户数据目录」（Kiro 未安装）
 *   2. NewSessionsRoot 与 OldSessionsRoot **都**不可用 → 「未找到 Kiro 对话存储目录」（Req 1.9）
 *   3. 未打开工作区 → 「当前没有打开任何工作区」（Req 1.10，与存储无关，优先级不变）
 *   4. StorageLayout 为 `none` → 「当前项目还没有 Kiro 对话历史」（Req 1.11）
 *
 * 关键变化：第 2 步是「**两根任一可用即继续**」，不再像以往那样一旦
 * `workspace-sessions` 缺失就短路报错 —— 纯 1.x 环境下那个目录可能根本不存在，
 * 旧实现会把用户完全挡在门外（D2）。因此 `new-only` 布局返回 `ok` 且带
 * `newWorkspaceDir`（Req 1.7），`old-only` 返回 `ok` 且带 `workspaceDir`（Req 1.8），
 * `both` 两者兼有（Req 1.4）。
 *
 * 全部根路径与布局结论都取自 `layout.ts` 的 `detectLayout`，本模块**不自己拼任何路径**
 * （除第 2 步纯文案用的"预期位置"），避免检测与校验两处口径漂移。
 * 本模块属 ReadOnlyPaths：不导入任何写文件系统 API（Req 12.2）。
 */
export function checkEnvironment(deps?: EnvCheckerDeps): EnvCheck {
  const pathDeps = deps?.pathResolver;
  const platform = pathDeps?.platform ?? process.platform;
  const ws = deps?.workspaceFolder;

  // 未打开工作区时传 null：detectLayout 此时不枚举任何目录，只解析各个根（Req 1.10）。
  const roots = detectLayout(ws ? ws.uri.fsPath : null, pathDeps);

  // (1) 两套安装痕迹都找不到 → Kiro 大概没装（或装在非常规位置）
  if (!roots.userDataDir && !roots.homeKiroDir) {
    return {
      ok: false,
      error: '未找到 Kiro 用户数据目录',
      hint: platformExpectedUserData(platform),
    };
  }

  // (2) 新旧两根均不可用（Req 1.9）：提示同时给出两个预期位置，
  //     否则 1.x 用户只会看到一条早已不再使用的旧路径。
  if (!roots.newSessionsRoot && !roots.oldSessionsRoot) {
    return {
      ok: false,
      error: '未找到 Kiro 对话存储目录',
      hint:
        `预期位置: ~/.kiro/sessions（Kiro 1.x）` +
        ` 或 ${expectedOldSessionsRoot(roots.userDataDir)}（Kiro 0.9x）`,
      ...pathsOf(roots),
    };
  }

  // (3) 未打开工作区（Req 1.10）：文案与提示沿用既有，优先级不变
  if (!ws) {
    return {
      ok: false,
      error: '当前没有打开任何工作区',
      hint: '请先在 Kiro 中打开一个项目，再使用对话搜索',
      ...pathsOf(roots),
    };
  }

  // (4) 存储根可用，但本工作区两侧都没有会话（Req 1.11）
  if (roots.layout === 'none') {
    return {
      ok: false,
      error: '当前项目还没有 Kiro 对话历史',
      hint: `工作区: ${ws.uri.fsPath}`,
      ...pathsOf(roots),
    };
  }

  return { ok: true, ...pathsOf(roots) };
}
