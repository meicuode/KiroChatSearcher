import { readdirSync, statSync } from 'fs';
import * as path from 'path';
import {
  getHomeKiroDir,
  getNewSessionIndexRoot,
  getNewSessionsRoot,
  getSessionsRoot,
  resolveNewWorkspaceSessionDir,
  resolveWorkspaceSessionDir,
} from './paths';
import type { PathResolverDeps } from './paths';

/**
 * LayoutDetector：判定当前工作区的会话数据落在 1.x 新布局、0.9x 旧布局，还是两者并存，
 * 并把新旧两套根路径一次性解析出来交给上层（Req 1.1、1.2、1.3）。
 *
 * 本模块位于 ReadOnlyPaths：只从 `fs` 具名导入 `readdirSync` / `statSync` 两个读 API——写 API
 * （`unlink` / `writeFile` / `rmdir` / `rm` / `rename` / `cp`）连导入都不存在，
 * 因此「布局检测零写入」是模块依赖图上可静态审查的事实，而非注释里的承诺（Req 1.12、12.2）。
 * 各个根的解析与存在性判断一律委托 `./paths`，路径拼接**只有那一份实现**：
 * 本模块不重复拼 `~/.kiro/sessions`、`WsHash16` 或 `workspace-sessions`，
 * 避免两处口径漂移后「检测说有、读取说没有」。本模块自己只多做一件事——
 * 枚举那两个工作区目录、判断里面到底有没有会话，这是既有路径层不做的部分。
 *
 * 检测无内部可变状态、无缓存，全部结论现算现取，因此同一磁盘状态下重复调用
 * 恒返回相同结果（Req 1.13）。
 *
 * 下游消费方（design.md 的 Architecture 图，LayoutDetector 是四条数据流的共同上游）：
 *
 * - **EnvChecker**（`src/env.ts`）：`layout !== 'none'` 即放行，不再因 `workspace-sessions`
 *   缺失把纯 1.x 用户挡在门外；`new-only` 取 `newWorkspaceSessionDir` 作为会话目录，
 *   `old-only` 沿用 `oldWorkspaceSessionDir`；两侧根全无时才报「未找到 Kiro 对话存储目录」。
 * - **SearchEngine**（`src/search.ts`）：按 `layout` 决定启用哪几个会话源——`both` 合并双源
 *   并按 sessionId 去重（新格式优先），`new-only` / `old-only` 只走对应一侧。
 * - **StorageAnalyzer**（`src/storage/`）：用 `newSessionsRoot` / `newSessionIndexRoot` 建新分类根，
 *   用 `oldStoreRoot` 定位 `<OldStoreRoot>/<WorkspaceId>` 下的 0.9x 执行数据；
 *   `newSessionsRoot` 存在与否决定 LegacyResidueTotal 维度是否展示。
 * - **SessionCleaner**（`src/storage/cleaner.ts`）：把 `newSessionsRoot`、`oldSessionsRoot`、
 *   `oldStoreRoot` 作为删除边界校验的根——规范化后落在这些根之外的路径一律拒删。
 */

/**
 * 当前工作区的布局判定结果。四种取值互斥且完备（Property 3）：
 *
 * - `new-only`：只有 1.x 目录型会话可用。典型为全新安装，或旧数据已被清理。
 * - `old-only`：只有 0.9x 单文件会话可用。典型为尚未升级到 Kiro 1.x 的环境；
 *   此时旧目录即主数据，LegacyResidueTotal 维度无意义（Req 8.3）。
 * - `both`：两侧都有会话。以 1.x 为主，同时纳入旧格式用于浏览/搜索/统计/清理（Req 1.4）；
 *   同 sessionId 在两处各有一份时，新格式为该会话占用的唯一来源，旧份计入 LegacyResidue（D7）。
 * - `none`：两侧都没有本工作区的会话。已打开工作区时对应「当前项目还没有 Kiro 对话历史」，
 *   面板结构保持不变（Req 1.11）。
 */
export type StorageLayout = 'new-only' | 'old-only' | 'both' | 'none';

/**
 * 一次检测产出的全部根路径 + 布局结论。
 *
 * 每个路径字段的语义都是「该目录此刻确实存在」；不可用的一侧为 `null`，
 * 且**不影响另一侧**——`~/.kiro` 缺失不会连带清空旧根，`workspace-sessions`
 * 缺失也不会连带清空新根（Req 1.5、1.6）。调用方据此单独判断每个根的可用性，
 * 无需再自己 `existsSync`。
 */
export interface LayoutRoots {
  /** 布局结论，取值语义见 {@link StorageLayout}。 */
  layout: StorageLayout;
  /** `~/.kiro`（HomeKiroDir）；不存在为 `null`。 */
  homeKiroDir: string | null;
  /** `~/.kiro/sessions`（NewSessionsRoot），1.x 下全部工作区会话目录的公共根。 */
  newSessionsRoot: string | null;
  /**
   * `~/.kiro/session-index`（NewSessionIndexRoot）。
   * 仅供占用分类计量；**不作为会话枚举来源**（追加式索引含已删除会话的历史条目，见 D3）。
   */
  newSessionIndexRoot: string | null;
  /** `<newSessionsRoot>/<WsHash16>`，本工作区在 1.x 下的会话目录。 */
  newWorkspaceSessionDir: string | null;
  /** Kiro 用户数据目录（UserDataDir）；旧侧根全部由它派生。 */
  userDataDir: string | null;
  /** `<UserDataDir>/User/globalStorage/kiro.kiroagent`（OldStoreRoot），0.9x 公共根。 */
  oldStoreRoot: string | null;
  /** `<oldStoreRoot>/workspace-sessions`（OldSessionsRoot）。 */
  oldSessionsRoot: string | null;
  /** `<oldSessionsRoot>/<OldEncodedKey>`，本工作区在 0.9x 下的会话目录。 */
  oldWorkspaceSessionDir: string | null;
}

/**
 * LayoutDetector 的可注入依赖。
 *
 * 在既有 {@link PathResolverDeps}（platform / env / homedir / existsSync / statSync）之上
 * **只**补一个同步读目录注入点。刻意不去改 `PathResolverDeps` 本体：那个接口被
 * `paths.ts` / `env.ts` 与既有测试大量复用，而「读目录」是本模块独有的需求
 * （路径解析层只做拼接与存在性判断，从不枚举目录），加进去等于让所有既有调用方
 * 承担一个用不上的契约。因此这里用「窄接口继承」的方式扩展，既不动既有契约、
 * 也让 `detectLayout` 依然能直接接收现成的 `PathResolverDeps` 实参。
 */
export interface LayoutFsDeps extends PathResolverDeps {
  /**
   * 同步列出目录内的条目名（不含 `.` / `..`）。缺省退回 `fs.readdirSync`。
   *
   * 必须是**同步**的：布局判定的两个条件都要求「该目录下**含至少一个**会话」，
   * 只靠 `existsSync` 分不出「目录存在但为空」与「目录里真有会话」——而
   * `detectLayout` 是同步函数（EnvChecker 与各 webview 取数路径都同步调用它），
   * 不能引入异步枚举。注入点的存在使单元测试可以在不落盘的前提下构造
   * 「目录存在但为空」「只有 `sessions.json`」「只有迁移标记」这类夹具。
   *
   * 只注入「列名字」这一步；「某个条目是目录还是文件」仍走既有的 `statSync`，
   * 使注入路径与生产路径对同一棵目录树给出同一个判据（刻意不用
   * `readdirSync(dir, { withFileTypes: true })`，否则注入实现还得伪造 Dirent）。
   */
  readdirSync?: (p: string) => string[];
}

/** 0.9x 会话目录下的会话清单文件：顶层是数组，不是一条会话（与 `search.ts` 口径一致）。 */
const OLD_MANIFEST_FILENAME = 'sessions.json';

/** 0.9x 会话目录里的迁移标记 `._migration-<uuid>.json`：是标记而非会话。 */
const MIGRATION_MARKER_PREFIX = '._migration-';

/**
 * 判定当前工作区的存储布局，并返回新旧两侧此刻可用的全部根路径。
 *
 * 判定依据两个条件的组合（Req 1.3）：
 * 「NewWorkspaceSessionDir 存在且含至少一个会话子目录」与
 * 「OldWorkspaceSessionDir 存在且含至少一个 `<sessionId>.json`」。
 * 均成立 → `both`，仅前者 → `new-only`，仅后者 → `old-only`，均不成立 → `none`。
 *
 * 全程不抛异常：目录枚举与 `stat` 的任何异常（权限不足、枚举中途被删、路径过长等）
 * 一律吞掉并视为「该侧不成立」，让调用方总能拿到一份可用的结论。
 *
 * @param workspacePath 当前工作区绝对路径；未打开工作区时传 `null`——此时仍返回
 *   已解析的各个根（供 EnvChecker 生成提示与 StorageAnalyzer 做全局统计），
 *   但两个工作区级字段为 `null`、`layout` 为 `none`，且不枚举任何目录（Req 1.10）。
 * @param deps 可注入依赖，见 {@link LayoutFsDeps}；缺省走真实 `os` / `fs`。
 */
export function detectLayout(workspacePath: string | null, deps?: LayoutFsDeps): LayoutRoots {
  const readdir = deps?.readdirSync ?? readdirSync;
  const stat: (p: string) => { isDirectory(): boolean } = deps?.statSync ?? ((p) => statSync(p));

  // ---- 新侧根（Req 1.1）：任一层缺失即整条链置 null，不影响旧侧（Req 1.5） ----
  const homeKiroDir = getHomeKiroDir(deps);
  const newSessionsRoot = getNewSessionsRoot(deps);
  const newSessionIndexRoot = getNewSessionIndexRoot(deps);
  const newWorkspaceSessionDir =
    workspacePath !== null && newSessionsRoot !== null
      ? resolveNewWorkspaceSessionDir(newSessionsRoot, workspacePath, deps)
      : null;

  // ---- 旧侧根（Req 1.2）：全部经既有 PathResolver 解析，不另拼一份 ----
  // OldStoreRoot 取 OldSessionsRoot 的父目录，而不是在这里重拼一次
  // `User/globalStorage/kiro.kiroagent`：由 `getSessionsRoot` 独占那份拼接，
  // 两处各拼一次早晚会漂移。Req 1.6 要求「OldStoreRoot 或 OldSessionsRoot 缺失
  // → 旧侧相关根全部为 null」，与「父目录随子目录一同可用」恰好等价。
  const { root: oldSessionsRoot, userDataDir } = getSessionsRoot(deps);
  const oldStoreRoot = oldSessionsRoot !== null ? path.dirname(oldSessionsRoot) : null;
  const oldWorkspaceSessionDir =
    workspacePath !== null && oldSessionsRoot !== null
      ? resolveWorkspaceSessionDir(oldSessionsRoot, workspacePath, deps)
      : null;

  // ---- 两个条件（Req 1.3） ----
  const hasNew =
    newWorkspaceSessionDir !== null && hasSessionSubdir(newWorkspaceSessionDir, readdir, stat);
  const hasOld =
    oldWorkspaceSessionDir !== null && hasOldSessionFile(oldWorkspaceSessionDir, readdir);

  const layout: StorageLayout = hasNew
    ? hasOld
      ? 'both'
      : 'new-only'
    : hasOld
      ? 'old-only'
      : 'none';

  return {
    layout,
    homeKiroDir,
    newSessionsRoot,
    newSessionIndexRoot,
    newWorkspaceSessionDir,
    userDataDir,
    oldStoreRoot,
    oldSessionsRoot,
    oldWorkspaceSessionDir,
  };
}

/**
 * 新侧条件：`dir` 下是否含至少一个 NewSessionDir（1.x 每个会话是一个子目录）。
 *
 * 只判断「是子目录」，不要求其中已有 `session.json` / `messages.jsonl`——残缺会话
 * 由 NewFormatReader 在读取阶段跳过（Req 3.9），布局检测不替它下结论，否则
 * 「目录里明明有会话数据却报 none」会把用户挡在门外。
 *
 * 命中首个子目录即返回，不遍历完整目录：会话多的工作区下这能省掉成百次 `stat`。
 */
function hasSessionSubdir(
  dir: string,
  readdir: (p: string) => string[],
  stat: (p: string) => { isDirectory(): boolean }
): boolean {
  let names: string[];
  try {
    names = readdir(dir);
  } catch {
    // 枚举失败（权限不足 / 枚举期间被删）视为该侧不成立
    return false;
  }

  for (const name of names) {
    try {
      if (stat(path.join(dir, name)).isDirectory()) return true;
    } catch {
      // 单个条目 stat 失败只跳过它，其余条目照常判断
    }
  }
  return false;
}

/**
 * 旧侧条件：`dir` 下是否含至少一个 OldSessionFile（0.9x 每个会话是一个 `<sessionId>.json`）。
 *
 * 两类同后缀文件必须排除，否则「只剩清单」或「只剩迁移标记」的空壳目录会被误判为
 * 仍有旧会话，进而把 `new-only` 误报成 `both`：
 *
 * - `sessions.json` 是会话清单（顶层数组），不是会话记录；
 * - `._migration-<uuid>.json` 是迁移标记，说明对应会话**已搬到** 1.x（Req 9.5）。
 *
 * 只看文件名不再 `stat`：判据是「目录下有没有会话文件」，而名为 `x.json` 的目录
 * 属于 Kiro 不会产出的形态，为它多花一轮 `stat` 不划算。命中首个即返回。
 */
function hasOldSessionFile(dir: string, readdir: (p: string) => string[]): boolean {
  let names: string[];
  try {
    names = readdir(dir);
  } catch {
    return false;
  }
  return names.some(isOldSessionFileName);
}

/** `<sessionId>.json` 文件名判定：`.json` 结尾，且不是清单、不是迁移标记。 */
function isOldSessionFileName(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  if (name === OLD_MANIFEST_FILENAME) return false;
  if (name.startsWith(MIGRATION_MARKER_PREFIX)) return false;
  return true;
}
