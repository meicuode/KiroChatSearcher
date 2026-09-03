import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { checkEnvironment, EnvCheck } from './env';
import {
  searchSessionsInLayout,
  listRecentSessionsInLayout,
  type LayoutSessionDirs,
  type SearchHit,
} from './search';
import { detectLayout, type StorageLayout } from './layout';
import { resolveAndExecuteJumpCommand, type JumpTarget } from './jump';
import { getWebviewHtml } from './webview';
import { StorageAnalyzer } from './storage/analyzer';
import { renderStorageReport } from './storage/report';
import type { StorageSummary } from './storage/types';
import {
  RankingPanel,
  aggregateViewOf,
  legacyResidueViewOf,
  projectSessionViewOf,
  type RankingPanelDeps,
} from './storage/ranking';
import {
  SessionCleaner,
  type CleanerRoots,
  type CleanupMode,
  type CleanupResult,
  type ConfirmPrompt,
} from './storage/cleaner';
import { buildClassifyRoots } from './storage/classify';
import { SettingsPanel, type SettingsPanelDeps } from './settings';
import {
  applyTurnTimer,
  detectTurnTimer,
  hostStartedAt,
  revertTurnTimer,
  type TurnTimerActionResult,
  type TurnTimerOptions,
  type TurnTimerStatus,
} from './turnTimer';
import { encodeWorkspaceKeys, getKiroUserDataDir } from './paths';
import { dropArchiveEntries, listArchiveEntries, workspaceIdCandidates } from './credits';
import { formatSize } from './webview/size';

const PANEL_VIEW_TYPE = 'kiroChatSearch.panel';

/**
 * 模块级复用的 OutputChannel。存储占用分析报告与后续的清理审计日志（任务 16.5）
 * 都写入这同一处文本流，使「报告 + 删除记录」落在同一处可回溯之处（Req 6.6、14.16）。
 * 惰性创建：只有真正触发过一次存储占用相关命令时才占用一个输出通道。
 */
let storageOutputChannel: vscode.OutputChannel | undefined;

/**
 * 取得（首次调用时惰性创建）供存储占用报告与清理审计共用的 OutputChannel。
 * 任务 16.5 的清理审计应调用本 getter 复用同一实例，而不是另建通道。
 */
function getStorageOutputChannel(): vscode.OutputChannel {
  if (!storageOutputChannel) {
    storageOutputChannel = vscode.window.createOutputChannel('Kiro 存储占用');
  }
  return storageOutputChannel;
}

/**
 * CleanupAuditLog 的写入目标：与 StorageReportCommand **同一个** OutputChannel，
 * 使「报告 + 删除记录」落在同一处可回溯的文本流里（Req 14.16）。
 *
 * 刻意**不** `show()`：审计在 `SessionCleaner.run()` 的段 2（删除前）与段 10（删除后）
 * 各写一次，删除中途抢焦点会打断用户在排行页上的操作。取而代之的是清理结束的通知里
 * 带一个「查看审计记录」按钮，由用户决定何时展开通道。
 *
 * 注意 `runStorageReport()` 会 `channel.clear()` 后再写报告——报告是一次性快照，
 * 而审计是追加式流水。用户若在清理后再跑一次报告，之前的审计会被清掉，因此审计的
 * 权威留存仍以「用户自行复制」为前提（与 Req 12.8 的表述一致）。
 */
function appendStorageAudit(lines: readonly string[]): void {
  const channel = getStorageOutputChannel();
  for (const line of lines) channel.appendLine(line);
}

// ---------------------------------------------------------------------------
// 对话耗时补丁（TurnTimerPatch）的宿主侧生命周期
//
// 这一节是本扩展唯一会**写 Kiro 安装目录**的代码路径：把
// `media/kcs-turn-timer.js` 覆盖到 Kiro 对话面板的产物目录，并在两个入口文件末尾
// 追加一行 import。原理、安全性与还原方式见 `src/turnTimer.ts` 的模块注释。
//
// 三个设计取舍：
//
// 1. **意图与实况分开存放。** 意图（开/关）在 `globalState`；实况每次都真读磁盘。
//    Kiro 升级会静默抹掉补丁，任何缓存下来的「已生效」都会变成谎言。
// 2. **`activate()` 里按意图自动补齐。** 这同时覆盖了「插件首次安装」与
//    「Kiro 升级后补丁被抹掉」两种情形，而不需要维护版本号比对。默认值为 `true`，
//    所以首次安装即自动写入一次；用户在设置页关掉后 `globalState` 记下 `false`，
//    后续启动不再自动写。
// 3. **首次真正写入时给一次非模态提示。** 悄悄改另一个应用的安装文件不合适；
//    而且补丁要重载窗口才生效，这个提示同时充当重载入口。之后的启动若无改动则静默。
// ---------------------------------------------------------------------------

/** `globalState` 里存「对话过程中显示耗时」意图的键。 */
const TURN_TIMER_ENABLED_KEY = 'kiroChatSearch.turnTimer.enabled';

/** 已就该失败原因提示过用户的签名，避免每次启动都弹同一条警告。 */
const TURN_TIMER_NOTIFIED_KEY = 'kiroChatSearch.turnTimer.notified';

/**
 * 本窗口扩展宿主的启动时刻。**在模块加载期求值**（早于 `activate()`）：
 * `activate()` 可能被「视图首次展开」推迟很久，那时取的时刻会晚于对话面板 webview
 * 的创建时刻，于是「补丁晚于窗口启动」的判断会假阳性、把已生效的补丁报成需重载。
 */
const EXTENSION_HOST_STARTED_AT = hostStartedAt();

/**
 * 本窗口启动后是否动过补丁文件。
 *
 * 动过就意味着当前这个 Kiro 窗口的对话面板加载的是**旧**产物——webview 只在创建时
 * 读一次入口文件。开与关都成立（刚关掉时，正在跑的那个面板里计时器还在），
 * 所以这是个单向标志，只有重载窗口（整个扩展宿主重启、本标志随之归零）才会清掉。
 */
let turnTimerDirty = false;

/** 本扩展自己的 OutputChannel（与「Kiro 存储占用」分开，避免报告 `clear()` 冲掉审计）。 */
let extensionOutputChannel: vscode.OutputChannel | undefined;

function getExtensionOutputChannel(): vscode.OutputChannel {
  if (!extensionOutputChannel) {
    extensionOutputChannel = vscode.window.createOutputChannel('Kiro Chat Search');
  }
  return extensionOutputChannel;
}

function logTurnTimer(message: string): void {
  try {
    getExtensionOutputChannel().appendLine(new Date().toISOString() + ' ' + message);
  } catch {
    /* 记不了日志不影响功能 */
  }
}

/**
 * 组装 `turnTimer.ts` 需要的入参。
 *
 * `vscode.env.appRoot` 就是 `<KiroRoot>/resources/app`，比从 PATH 或常见安装位置去猜
 * 可靠得多——扩展本来就跑在目标 Kiro 进程里，问它自己的安装位置不会错。
 */
function turnTimerOptions(context: vscode.ExtensionContext): TurnTimerOptions {
  return {
    appRoot: vscode.env.appRoot,
    assetPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'kcs-turn-timer.js').fsPath,
    hostStartedAt: EXTENSION_HOST_STARTED_AT,
  };
}

/** 读意图。缺省 `true`：首次安装即自动写入一次。 */
function isTurnTimerEnabled(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(TURN_TIMER_ENABLED_KEY, true) !== false;
}

async function setTurnTimerEnabled(
  context: vscode.ExtensionContext,
  enabled: boolean
): Promise<void> {
  await context.globalState.update(TURN_TIMER_ENABLED_KEY, enabled);
}

/**
 * 执行一次补丁动作，并把「本窗口已过期」标志推到位。
 *
 * 所有写 Kiro 安装目录的调用都必须经这里，否则 `turnTimerDirty` 会漏置，
 * 设置页就会把「文件已改但面板还是旧的」误报成「已生效」。
 */
function runTurnTimerAction(
  context: vscode.ExtensionContext,
  kind: 'apply' | 'revert'
): TurnTimerActionResult {
  const opts = turnTimerOptions(context);
  const result = kind === 'apply' ? applyTurnTimer(opts) : revertTurnTimer(opts);
  if (result.changed) turnTimerDirty = true;
  logTurnTimer(
    `[turnTimer] ${kind} ok=${result.ok} changed=${result.changed} state=${result.status.state}` +
      (result.error ? '\n  ' + result.error.split('\n').join('\n  ') : '')
  );
  return result;
}

/**
 * `activate()` 里的自动补齐：意图为开而实况没到位时写一次。
 *
 * 什么都不做的情形（都是正常的，不提示、不记账）：
 * - 意图为关
 * - 环境不支持（不在 Kiro 里、或版本布局变了 → `unavailable`）
 * - 已经到位（`on`）或已写好只等重载（`pending-reload`）
 *
 * 失败时按「错误签名」去重提示：只读安装目录会让每次启动都失败，弹同一条警告
 * 只会变成噪音，所以同一签名只提示一次，之后靠设置页呈现。
 */
async function syncTurnTimerOnActivate(context: vscode.ExtensionContext): Promise<void> {
  if (!isTurnTimerEnabled(context)) return;

  let state: TurnTimerStatus['state'];
  try {
    state = detectTurnTimer(turnTimerOptions(context)).state;
  } catch {
    return;
  }
  if (state === 'unavailable' || state === 'on' || state === 'pending-reload') return;

  const result = runTurnTimerAction(context, 'apply');

  if (!result.ok) {
    const signature = 'fail:' + (result.error ?? '').slice(0, 200);
    if (context.globalState.get<string>(TURN_TIMER_NOTIFIED_KEY) === signature) return;
    await context.globalState.update(TURN_TIMER_NOTIFIED_KEY, signature);
    const pick = await vscode.window.showWarningMessage(
      '未能为 Kiro 对话面板启用「对话过程中显示耗时」。',
      '打开设置',
      '查看日志'
    );
    if (pick === '打开设置') openSettingsPanel(context);
    else if (pick === '查看日志') getExtensionOutputChannel().show(true);
    return;
  }

  if (!result.changed) return;

  // 真正写入了：这一次值得说一句——既因为我们改了 Kiro 的安装文件，
  // 也因为补丁要重载窗口才会生效。
  await context.globalState.update(TURN_TIMER_NOTIFIED_KEY, 'ok');
  const pick = await vscode.window.showInformationMessage(
    'Kiro Chat Search 已为对话面板启用「对话过程中显示耗时」，重载窗口后生效。',
    '重载窗口',
    '打开设置',
    '不需要'
  );
  if (pick === '重载窗口') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else if (pick === '打开设置') {
    openSettingsPanel(context);
  } else if (pick === '不需要') {
    await setTurnTimerEnabled(context, false);
    runTurnTimerAction(context, 'revert');
  }
}

/** 设置页命令与齿轮入口的落点：装配宿主能力后打开单例面板。 */
function openSettingsPanel(context: vscode.ExtensionContext): void {
  const deps: SettingsPanelDeps = {
    detect: () => detectTurnTimer(turnTimerOptions(context)),
    apply: () => runTurnTimerAction(context, 'apply'),
    revert: () => runTurnTimerAction(context, 'revert'),
    getEnabled: () => isTurnTimerEnabled(context),
    setEnabled: (enabled: boolean) => setTurnTimerEnabled(context, enabled),
    isDirty: () => turnTimerDirty,
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    log: (message: string) => logTurnTimer(message),
  };
  SettingsPanel.showOrCreate(context, deps);
}

/**
 * `kiroChatSearch.storageReport` 命令实现：以可取消的通知进度跑一次全量占用统计，
 * 把渲染后的报告写入复用的 OutputChannel 并展示（Req 6.1、6.6、6.8）。
 *
 * - 用 `withProgress`（Notification + cancellable）提供进度与取消入口；
 *   `token.isCancellationRequested` 透传为 analyzer 的 `isCancelled`，取消后
 *   枚举会在 1 秒内停止、已完成的子树聚合保留在缓存中（Req 6.7、9.7）。
 * - 取消不算失败：静默返回，不写报告也不弹任何通知。
 * - 统计整体抛错时弹 `showErrorMessage('存储占用分析失败：' + message)`（Req 9.5）。
 * - 全程不创建任何文件，仅写内存中的 OutputChannel（Req 6.8、9.7）。
 */
async function runStorageReport(): Promise<void> {
  const ws = currentWorkspaceFolder()?.uri.fsPath ?? null;
  const analyzer = new StorageAnalyzer({
    workspacePath: ws,
    newLayout: newLayoutForAnalyzer(ws),
  });
  try {
    let cancelled = false;
    const data = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Kiro 存储占用分析',
        cancellable: true,
      },
      async (progress, token) => {
        const result = await analyzer.getReportData({
          force: true,
          isCancelled: () => token.isCancellationRequested,
          onProgress: (msg) => progress.report({ message: msg }),
        });
        cancelled = token.isCancellationRequested;
        return result;
      }
    );
    // 取消：不算失败，静默返回；已完成的聚合已保留在 analyzer 的缓存里（Req 6.7）
    if (cancelled) return;
    const channel = getStorageOutputChannel();
    channel.clear();
    channel.appendLine(renderStorageReport(data));
    channel.show(true);
  } catch (e: any) {
    vscode.window.showErrorMessage('存储占用分析失败：' + (e?.message ?? String(e)));
  }
}

/* ------------------------------------------------------------------ *
 * OpenRankingCommand 与清理接线（任务 16.5）
 *
 * 本节把三样东西装配起来，它们各自都不认识 vscode：
 *   - `RankingPanel`（排行页，只知道 `RankingPanelDeps`）
 *   - `StorageAnalyzer`（取数与缓存失效）
 *   - `SessionCleaner`（本特性唯一可写模块，只知道 `CleanerDeps`）
 * 所有 vscode 绑定——OutputChannel、模态确认、通知、命令注册——都收在这里，
 * 使那三者可脱离宿主被单测。
 * ------------------------------------------------------------------ */

/**
 * 宿主侧共享的 StorageAnalyzer：排行页取数与清理后的缓存失效走**同一个实例**。
 *
 * 为什么必须同一个：`invalidateForDeletedFiles` 打掉的是**该实例**持有的
 * StorageCache 与 SubtreeCache。若排行页取数用 A、失效打 B，删完文件后排行页仍会
 * 在 60 秒内返回含已删字节的陈旧行。工作区路径变化时重建（缓存按工作区取数）。
 */
let hostAnalyzer: StorageAnalyzer | null = null;
let hostAnalyzerWorkspacePath: string | null = null;

function getHostAnalyzer(): StorageAnalyzer {
  const ws = currentWorkspaceFolder()?.uri.fsPath ?? null;
  if (!hostAnalyzer || hostAnalyzerWorkspacePath !== ws) {
    hostAnalyzer = new StorageAnalyzer({ workspacePath: ws, newLayout: newLayoutForAnalyzer(ws) });
    hostAnalyzerWorkspacePath = ws;
  }
  return hostAnalyzer;
}

/**
 * 存活中的 SearchSession 注册表（侧边栏视图 + 居中面板可同时存在多个）。
 *
 * 清理完成后要刷新 SummaryBar 三项数值与受影响会话的 SizeBadge（Req 4.12、14.14、14.15），
 * 但 `SessionCleaner` 与 `RankingPanel` 都拿不到这些实例的句柄。用一个模块级
 * 弱耦合注册表（构造时登记、dispose 时摘除）比给 cleaner 加 UI 钩子更小、更自洽：
 * cleaner 的段 9「刷新 UI」按 design 本就归调用方负责。
 */
const activeSearchSessions = new Set<SearchSession>();

/** 首个存在的目录；都不存在时返回 null（供 `resolveCleanerRoots` 在多个编码变体里挑真身）。 */
function firstExistingDir(candidates: readonly string[]): string | null {
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // 不存在或不可 stat：换下一个变体
    }
  }
  return null;
}

/**
 * 派生 `CleanerRoots`：删除侧的路径白名单基准，与统计侧**同源**
 * （PathResolver → `buildClassifyRoots` → `encodeWorkspaceKeys` / `workspaceIdCandidates`），
 * 这样「这个文件是不是执行存档」在两侧恒得同一答案（见 design 的 `isUnder` 复用说明）。
 *
 * 盘符大小写与斜杠方向让同一工作区可能对应多个编码变体目录，因此：
 *   - `sessionDir` 取首个**实际存在**的 `<SessionsRoot>/<EncodedKey>`，回退首个候选
 *   - `workspaceId` 优先取其 `<id>/<savesBucket>` 存在的候选（那才是存档真正落盘的
 *     那个变体），其次取存在的目录，最后回退首个候选
 *
 * 挑错变体的后果不是误删而是**删不掉**：`assertDeletable` 会把不在白名单位置的存档
 * 判为「不匹配可删除位置」并计入失败（Req 14.19）。宁可如此，也不放宽校验。
 *
 * UserDataDir 不可用时返回 `null`——此时无从界定删除边界，清理必须整体不可用。
 */
function resolveCleanerRoots(workspacePath: string): CleanerRoots | null {
  let userDataDir: string | null;
  try {
    userDataDir = getKiroUserDataDir();
  } catch {
    userDataDir = null;
  }
  if (!userDataDir) return null;

  const roots = buildClassifyRoots(userDataDir);

  const sessionDirCandidates = encodeWorkspaceKeys(workspacePath).map((key) =>
    path.join(roots.sessionsRoot, key)
  );
  const sessionDir = firstExistingDir(sessionDirCandidates) ?? sessionDirCandidates[0];
  if (!sessionDir) return null;

  const idCandidates = workspaceIdCandidates(workspacePath);
  const withBucket = idCandidates.filter((id) =>
    firstExistingDir([path.join(roots.storeRoot, id, roots.savesBucket)]) !== null
  );
  const execDir =
    firstExistingDir(withBucket.map((id) => path.join(roots.storeRoot, id))) ??
    firstExistingDir(idCandidates.map((id) => path.join(roots.storeRoot, id)));
  const workspaceId = execDir ? path.basename(execDir) : idCandidates[0];
  if (!workspaceId) return null;

  // 1.x 的两个根（Req 10.8、10.10 的删除围栏）。取 `detectLayout` 的产出而不是自己拼：
  // 它已经做过存在性校验，而「围栏必须真实存在」正是这两个字段的语义。
  // 任一为 null 时 SessionCleaner 完全按 0.9x 行事、1.x 计划一律判为不可用 —— 拿不到围栏
  // 就不许删，比按 `~/.kiro` 猜一个出来安全。
  const newLayout = newLayoutForAnalyzer(workspacePath);

  const out: CleanerRoots = {
    storeRoot: roots.storeRoot,
    savesBucket: roots.savesBucket,
    workspaceId,
    sessionDir,
  };
  // 旧残留清理的围栏：跨全部工作区，故取它们的公共父目录 workspace-sessions（Req 11.5）
  out.oldSessionsRoot = roots.sessionsRoot;
  if (newLayout.newSessionsRoot) out.newSessionsRoot = newLayout.newSessionsRoot;
  if (newLayout.newWorkspaceSessionDir) {
    out.newWorkspaceSessionDir = newLayout.newWorkspaceSessionDir;
  }
  return out;
}

/**
 * 清理后的缓存失效（`CleanerDeps.invalidate`，Req 14.13）：
 * 串起 analyzer 侧的逐级子树失效与 ArchiveIndex 的条目摘除。
 *
 * 三处都要打：宿主共享 analyzer（排行页取数用它）、每个存活 SearchSession 自己的
 * analyzer（SummaryBar 用它们，各自持有独立的 SubtreeCache），以及 `credits.ts` 的
 * ArchiveIndex（否则 4 秒节流窗口内仍会用已删存档的陈旧条目算占用）。
 * 任一处抛错都不该阻断其余两处，故逐个 try。
 */
function invalidateStorageCaches(paths: readonly string[]): void {
  try {
    getHostAnalyzer().invalidateForDeletedFiles(paths);
  } catch {
    /* 失效失败最坏是数值滞后一个 TTL，不影响删除结果 */
  }
  for (const session of activeSearchSessions) session.invalidateStorageCaches(paths);
  try {
    dropArchiveEntries(paths);
  } catch {
    /* 同上 */
  }
}

const CLEANUP_MODE_LABEL: Record<CleanupMode, string> = {
  attachment: '清理附件：只删除归因到该会话的执行存档，保留对话本体',
  full: '全量清理：删除该会话的执行存档与对话本体，并从会话清单中移除该条目',
};

/**
 * 1.x 目录型会话的两种模式文案（Requirement 10.13）。
 *
 * 与 0.9x 分开写，因为破坏面确实不同：`full` 删的是**整个会话目录**（消息记录与全部快照
 * 一起消失、目录本身也会被移除），而 0.9x 的 `full` 是「存档 + 会话文件 + 清单条目」。
 * 用同一句话覆盖两者，会让 1.x 用户以为「对话本体」之外还有别的东西留着。
 */
const NEW_LAYOUT_MODE_LABEL: Record<CleanupMode, string> = {
  attachment:
    '附件清理：删除该会话目录下 snapshots/ 与 sub-executions/ 内的文件，保留 session.json 与 messages.jsonl（对话本体仍可继续查看）',
  full: '全量清理：删除整个会话目录，含消息记录（messages.jsonl）与全部快照；删完后会移除已清空的目录',
};

/** 通知里的「打开输出通道」按钮文案（审计记录就在那里）。 */
const VIEW_AUDIT_ACTION = '查看审计记录';

/**
 * 模态确认（`CleanerDeps.confirm`，Req 14.5、14.6）。
 *
 * - 模态（`{ modal: true }`）：确认清理是不可撤销的破坏性操作，不能用可被忽略的
 *   角落通知承载
 * - 「取消」以 `isCloseAffordance: true` 声明，因此它既是 Esc / 关闭的落点、也是
 *   对话框的默认按钮，确认项处于非默认位置（Req 14.5）；不用它的话 vscode 会**额外**
 *   补一个自己的 Cancel，导致对话框上出现两个取消
 * - 文案给出：模式名称、释放字节数、待删文件数、因被其它会话引用而保留的文件数与
 *   字节数、以及「不可撤销且不进回收站」的明文说明
 * - `stage: 'referenced'` 的二次确认按并入引用冲突文件后的合计展示，并说明其它会话的
 *   历史 credit 用量将无法回溯（Req 14.6）
 * - 未选择（Esc / 关闭）与选「取消」同解为 `'cancel'`：`run()` 据此返回
 *   `state: 'cancelled'`，文件与清单原样（Req 14.7）
 */
async function confirmCleanup(
  p: ConfirmPrompt
): Promise<'confirm' | 'confirmWithReferenced' | 'cancel'> {
  const title = p.title.trim() || '(无标题)';
  const lines: string[] = [];
  if (p.stage === 'referenced') {
    lines.push('二次确认：将一并删除被其它会话引用的执行存档');
  } else {
    // 1.x 目录型会话的破坏面与 0.9x 不同（删的是整个会话目录，含消息记录与全部快照），
    // 两者用同一句会误导用户 —— Req 10.13 要求把这个差异写明
    lines.push(
      p.layout === 'new' ? NEW_LAYOUT_MODE_LABEL[p.mode] : CLEANUP_MODE_LABEL[p.mode]
    );
  }
  lines.push(`会话：${title}（${p.sessionId}）`);
  lines.push(`将删除 ${p.totalFiles} 个文件，释放约 ${formatSize(p.totalBytes)}`);
  if (p.stage === 'referenced') {
    lines.push(
      `其中 ${p.referencedFiles} 个文件（${formatSize(p.referencedBytes)}）被其它会话的 credit lineage 引用；` +
        '删除后那些会话的历史 credit 用量将无法回溯。'
    );
  } else {
    lines.push(
      p.referencedFiles > 0
        ? `因被其它会话引用而保留：${p.referencedFiles} 个文件（${formatSize(p.referencedBytes)}）`
        : '没有因被其它会话引用而保留的文件。'
    );
  }
  if (p.dirCount > 0) {
    lines.push(
      `删除完成后还会移除 ${p.dirCount} 个已清空的目录（含会话目录本身）；目录非空时会被保留。`
    );
  }
  lines.push('该操作不可撤销，被删除的文件不进入回收站。');

  const confirmItem: vscode.MessageItem = { title: '确认清理' };
  const includeItem: vscode.MessageItem = { title: '一并删除被引用文件' };
  const cancelItem: vscode.MessageItem = { title: '取消', isCloseAffordance: true };
  const items: vscode.MessageItem[] =
    p.stage === 'primary' && p.referencedFiles > 0
      ? [confirmItem, includeItem, cancelItem]
      : [confirmItem, cancelItem];

  const picked = await vscode.window.showWarningMessage(
    lines.join('\n'),
    { modal: true },
    ...items
  );
  if (!picked || picked === cancelItem) return 'cancel';
  if (picked === includeItem) return 'confirmWithReferenced';
  return 'confirm';
}

/**
 * 宿主侧共享的 SessionCleaner（按工作区路径惰性构造并缓存）。
 *
 * 缓存而非每次新建的关键理由：`inflight` 互斥集合是**实例字段**，同一 sessionId 的
 * 并发清理互斥（Req 14.18）依赖于宿主只有一个实例。工作区变化时重建。
 *
 * `lineages` 不注入：现存会话的 `history[].executionId` 只存在于 `search.ts` 的
 * 内部会话索引里，尚无导出入口（本任务只改 extension.ts）。缺省下 ReferencedArchive
 * 集合为空，计划退化为纯定义式集合——即「不臆造引用关系」，见 cleaner 中该字段的说明。
 */
let sessionCleaner: SessionCleaner | null = null;
let sessionCleanerWorkspacePath: string | null = null;

function getSessionCleaner(): SessionCleaner | null {
  const ws = currentWorkspaceFolder()?.uri.fsPath ?? null;
  if (ws === null) return null;
  if (sessionCleaner && sessionCleanerWorkspacePath === ws) return sessionCleaner;

  const roots = resolveCleanerRoots(ws);
  if (!roots) return null;

  sessionCleaner = new SessionCleaner({
    audit: appendStorageAudit,
    confirm: confirmCleanup,
    // 每次调用都取一次只读快照：内部走既有 4 秒节流，不新增扫描策略（Req 7.9）
    archives: () => listArchiveEntries(roots.storeRoot, { workspacePath: ws }),
    invalidate: invalidateStorageCaches,
    roots,
  });
  sessionCleanerWorkspacePath = ws;
  return sessionCleaner;
}

/**
 * 一次清理的结果通知。
 *
 * - `rejected`：同一会话已有清理在执行（Req 14.18）
 * - `cancelled`：用户取消，保持安静（没有任何变化，弹通知只是噪音）
 * - `noop`：空计划，明确告诉用户「没有可删的东西」而不是假装做了一次清理
 * - `done`：失败 + 跳过之和大于 0 时以部分成功文案**同时**给出成功、失败与跳过三类
 *   计数（Req 14.10）；清单更新失败时附注提示去检查 `sessions.json`（Req 14.12）
 */
function reportCleanupResult(result: CleanupResult): void {
  const openAudit = (picked: string | undefined): void => {
    if (picked === VIEW_AUDIT_ACTION) getStorageOutputChannel().show(true);
  };

  if (result.state === 'rejected') {
    void vscode.window.showWarningMessage('该会话的清理正在进行，请等待其完成后再试。');
    return;
  }
  if (result.state === 'cancelled') return;
  if (result.state === 'noop') {
    void vscode.window.showInformationMessage(
      '没有可清理的文件：该会话没有归因到它的执行存档。'
    );
    return;
  }

  const manifestNote =
    result.manifestUpdated === 'failed'
      ? '；会话清单更新失败，请手工检查 sessions.json'
      : '';
  const problems = result.failed.length + result.skipped.length;
  if (problems > 0) {
    void vscode.window
      .showWarningMessage(
        `会话清理部分完成：成功 ${result.deletedFiles} 个（${formatSize(result.deletedBytes)}）、` +
          `失败 ${result.failed.length} 个、跳过 ${result.skipped.length} 个${manifestNote}`,
        VIEW_AUDIT_ACTION
      )
      .then(openAudit);
    return;
  }
  void vscode.window
    .showInformationMessage(
      `会话清理完成：已删除 ${result.deletedFiles} 个文件，释放 ${formatSize(result.deletedBytes)}${manifestNote}`,
      VIEW_AUDIT_ACTION
    )
    .then(openAudit);
}

/**
 * 清理结束后的 UI 刷新（cleaner 的段 9，由调用方负责，Req 14.14）。
 *
 * 排行页的当前页与页码指示由 `RankingPanel` 自己在 `cleaner.run()` 返回后 `refresh()`
 * ——行数减少时 `pageOf` 的 clamp 自动落到 `min(M, N)`（Req 13.17）。这里补的是排行页
 * 拿不到的另外两处：
 *   - 每个存活 SearchSession 重新取搜索结果 → SizeBadge 随之更新，且 FullCleanup 删掉的
 *     会话不再出现在结果与最近列表里（Req 14.15）
 *   - 真正删掉了字节时，重新计算 SummaryBar 的三项数值（Req 4.12）
 *
 * SummaryBar 停在 IdleState（用户从未点过 ComputeSizeButton）的会话**不**触发重算：
 * 那里没有数值可刷新，凭空跑一次全量枚举违背「统计只在显式动作时发生」的前提（Req 7.12）。
 */
function refreshUiAfterCleanup(result: CleanupResult): void {
  const recompute = result.deletedBytes > 0;
  for (const session of activeSearchSessions) session.onStorageChanged(recompute);
}

/**
 * 排行页行内清理入口的实际执行体（注入 `RankingPanelDeps.cleaner.run`）。
 *
 * 在 `SessionCleaner.run()` 外面包一层，是为了把三件**属于宿主**的事收在一处：
 * 整体失败的通知（Req 9.9）、结果通知（Req 14.10）、清理后的 UI 刷新（Req 14.14）。
 * 异常在通知后**继续上抛**：`RankingPanel` 据此写审计日志并照常 `refresh()`，
 * 当前列表保持可用（Req 9.9）。
 */
async function runSessionCleanup(
  mode: CleanupMode,
  sessionId: string,
  title: string
): Promise<CleanupResult> {
  const cleaner = getSessionCleaner();
  if (!cleaner) {
    const message = '未打开工作区或 Kiro 用户数据目录不可用，无法执行清理。';
    vscode.window.showErrorMessage('会话清理失败：' + message);
    throw new Error(message);
  }
  let result: CleanupResult;
  try {
    result = await cleaner.run(mode, sessionId, title);
  } catch (e: any) {
    vscode.window.showErrorMessage('会话清理失败：' + (e?.message ?? String(e)));
    throw e;
  }
  reportCleanupResult(result);
  refreshUiAfterCleanup(result);
  return result;
}

/**
 * 旧残留清理的宿主执行体（注入 `RankingPanelDeps.cleanupLegacyResidue`，Req 11.1–11.8）。
 *
 * 待删清单取**上一次统计的产物**（`analyzer.peekLegacyResidueTargets()`，零 IO）而不是
 * 重新扫描：确认提示上写的字节数来自那次统计，清单若来自另一次观测，承诺与实际就会不一致。
 * 清单为空（还没统计过、或没有可清理部分）时 `SessionCleaner` 直接返回未执行状态且不弹确认。
 */
async function runLegacyResidueCleanup(): Promise<CleanupResult | null> {
  const cleaner = getSessionCleaner();
  if (!cleaner) {
    vscode.window.showErrorMessage('旧残留清理不可用：未能定位 Kiro 用户数据目录，无从界定删除边界。');
    return null;
  }
  const targets = getHostAnalyzer().peekLegacyResidueTargets();
  try {
    const result = await cleaner.runLegacyResidue({
      files: targets.files,
      excludedBytes: targets.excludedBytes,
      excludedFiles: targets.excludedFiles,
    });
    // 与会话清理走**同一对**收尾函数：结果通知 + UI 刷新。旧残留删的是别的工作区的
    // 旧会话文件，本工作区的搜索结果通常不变，但 SummaryBar 的总占用会变，故照样刷新
    reportCleanupResult(result);
    refreshUiAfterCleanup(result);
    return result;
  } catch (e: any) {
    vscode.window.showErrorMessage('旧残留清理失败：' + (e?.message ?? String(e)));
    throw e;
  }
}

/**
 * 按 sessionId 打开一条会话：搜索面板与排行页 SessionTitleLink 的**共用**跳转入口。
 *
 * 收在一处的理由：候选链的选择（1.x 两项，`old-only` 时追加 0.9x 三项）、命令全不可用时的
 * 中文提示都归 `jump.ts`，两个消费方只需给出「哪条会话 + 已知的标题与数据格式」。
 * 各自再写一遍 deps 装配，迟早会出现一边传了 `layout`、另一边忘传而退回 0.9x 候选链的偏差。
 *
 * `layout` 在**调用时**现取：面板可能已经开着很久，其间用户可能完成了迁移，候选链应按
 * 当前布局判定，而不是面板创建那一刻的结论。
 *
 * 恒不抛异常：失败的用户可见提示由 `showError` 在 jump 内部给出，调用方据返回值留痕即可。
 */
async function openSessionByJump(target: {
  sessionId: string;
  title?: string;
  sessionLayout?: 'old' | 'new';
}): Promise<{ invoked: boolean }> {
  const jumpTarget: JumpTarget = { sessionId: target.sessionId, layout: checkEnv().layout };
  if (typeof target.title === 'string' && target.title.trim() !== '') {
    jumpTarget.title = target.title;
  }
  if (target.sessionLayout === 'old' || target.sessionLayout === 'new') {
    jumpTarget.sessionLayout = target.sessionLayout;
  }
  const res = await resolveAndExecuteJumpCommand(jumpTarget, {
    getCommands: (filterInternal) =>
      Promise.resolve(vscode.commands.getCommands(filterInternal)),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    showError: (message) => vscode.window.showErrorMessage(message),
  });
  return { invoked: res.invoked === true };
}

/** `RankingPanel` 的宿主侧依赖装配（取数 / 清理 / 跳转 / 工作区 / 日志）。 */
function buildRankingDeps(): RankingPanelDeps {
  const analyzer = getHostAnalyzer();
  return {
    /**
     * 取数走**双布局合并**入口而不是 `analyzer.getRankingRows`（后者只看 0.9x 单文件会话，
     * 这正是排行页在 1.x 上显示「0 个会话」的原因）。
     *
     * 用薄适配器而不是改 `RankingPanelDeps.analyzer` 的契约：面板只需要
     * `{ rows, partial, skippedCount }` 三项，而 `MergedRankingRows` 还带着聚合维度要用的
     * 字节数拆解与残留归属——整个对象塞给面板会让它多依赖一堆此刻用不上的字段。
     *
     * TODO(task 12.1): 聚合维度接线时改成「一次 `getMergedRankingRows` 的结果同时喂给行渲染
     * 与 `projectSessionTotalFrom`」，使排行行与 ProjectSessionTotal 恒来自同一次枚举
     * （Req 7.3）。现在多调一次不会重复枚举（两侧各自的 StorageCache 会命中），但那样才谈得上同源。
     */
    analyzer: {
      getRankingRows: async (opts) => {
        const merged = await analyzer.getMergedRankingRows(opts);
        return {
          rows: merged.rows,
          partial: merged.partial,
          skippedCount: merged.skippedCount,
          // ProjectSessionTotal 由**这一次**合并结果聚合出来，不另发起枚举（Req 7.3）
          project: projectSessionViewOf(merged),
        };
      },
      // 两个重量级维度：只有 webview 的手动触发消息会走到这里（Req 7.8、8.4）
      getAllKiroSessionTotal: async (opts) =>
        aggregateViewOf(await analyzer.getAllKiroSessionTotal(opts)),
      getLegacyResidueTotal: async (opts) =>
        legacyResidueViewOf(await analyzer.getLegacyResidueTotal(opts)),
    },
    cleanupLegacyResidue: () => runLegacyResidueCleanup(),
    // `old-only` 下隐藏旧残留维度（Req 8.3）
    layout: checkEnv().layout,
    cleaner: { run: (mode, sessionId, title) => runSessionCleanup(mode, sessionId, title) },
    // SessionTitleLink：点击排行页的会话标题打开该对话。
    // 与搜索面板的 `open` 走**同一个** jump 入口与同一套 deps（候选链、失败提示都在 jump 一侧），
    // 排行页因此不需要自己认识任何 kiroAgent.* 命令。
    // `layout` 现取（而不是复用上面那次 checkEnv）：面板可能开着很久，跳转时应按当前布局判候选链。
    openSession: (target) => openSessionByJump(target),
    workspacePath: currentWorkspaceFolder()?.uri.fsPath ?? null,
    // 排行页的诊断信息写进与报告、审计同一处文本流
    log: (message) => appendStorageAudit([message]),
  };
}

/**
 * `kiroChatSearch.storageRanking` 命令实现（Req 13.1）：打开（或激活已有的）UsageRankingPage。
 *
 * `showOrCreate` 命中已有实例时只 `reveal()`，页码与排序方向原样保留（状态存活在
 * webview 侧）。打开失败时按与 StorageReportCommand **同一形态**的通知提示
 * （`'<动作>失败：' + message`，Req 9.4）——这是用户主动执行的命令，失败必须可见。
 */
function openStorageRanking(context: vscode.ExtensionContext): void {
  try {
    RankingPanel.showOrCreate(context, buildRankingDeps());
  } catch (e: any) {
    vscode.window.showErrorMessage('存储占用排行打开失败：' + (e?.message ?? String(e)));
  }
}

/** 无搜索关键词时默认展示最近 N 条 */
const RECENT_DEFAULT_LIMIT = 20;
/** 有关键词时返回的最大命中条数 */
const SEARCH_RESULT_LIMIT = 10;

/** 取当前工作区第一个文件夹（供 EnvChecker 注入） */
function currentWorkspaceFolder(): { uri: { fsPath: string } } | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

function checkEnv(): EnvCheck {
  return checkEnvironment({ workspaceFolder: currentWorkspaceFolder() });
}

/**
 * 把一次 `checkEnv()` 的结论折成双源取数所需的三项（Req 13.1、13.2）。
 *
 * 刻意复用**同一次**环境校验的结果而不再调一次 `detectLayout`：两次检测之间磁盘可能
 * 变化，那会让「状态条说就绪」与「取数说没有目录」出现互相矛盾的一瞬。
 *
 * `layout` 缺省取 `none`：`EnvCheck.layout` 只在走到布局判定之前的早期错误分支上才
 * 为 `undefined`（如 Kiro 未安装），此时两个目录也必然为空，`none` 正是它该有的含义。
 */
/** StorageLayout 的中文标签（仅用于状态条 tooltip）。 */
const LAYOUT_LABELS: Record<StorageLayout, string> = {
  'new-only': '仅 1.x 新格式',
  'old-only': '仅 0.9x 旧格式',
  both: '1.x 与 0.9x 并存',
  none: '本工作区暂无对话历史',
};

function layoutDirsFrom(env: EnvCheck): LayoutSessionDirs {
  return {
    layout: env.layout ?? 'none',
    newWorkspaceSessionDir: env.newWorkspaceDir ?? null,
    oldWorkspaceSessionDir: env.workspaceDir ?? null,
  };
}

/**
 * 构造 StorageAnalyzer 的 1.x 布局注入值。
 *
 * 只在构造 analyzer 时调用（每个工作区一次，随后被实例缓存复用），故这里多做一次
 * `detectLayout` 的成本可以忽略；换来的是 analyzer 拿到**已做过存在性校验**的
 * `homeKiroDir` / `newSessionsRoot`——`EnvCheck` 不带这两项（它对外只暴露工作区级目录），
 * 而 analyzer 少了它们就只能自己按 `~/.kiro` 猜，那在注入了 pathResolver 的环境里会错。
 */
function newLayoutForAnalyzer(workspacePath: string | null): {
  homeKiroDir: string | null;
  newWorkspaceSessionDir: string | null;
  newSessionsRoot: string | null;
} {
  try {
    const roots = detectLayout(workspacePath);
    return {
      homeKiroDir: roots.homeKiroDir,
      newWorkspaceSessionDir: roots.newWorkspaceSessionDir,
      newSessionsRoot: roots.newSessionsRoot,
    };
  } catch {
    // 布局检测本身失败只该让新布局那一侧的统计为空，不该让 analyzer 构造不出来
    return { homeKiroDir: null, newWorkspaceSessionDir: null, newSessionsRoot: null };
  }
}

/**
 * 把 Webview 与扩展宿主之间的搜索/打开/状态协议封装成一个会话对象，
 * 供 EntryView（侧边栏视图）与 SearchPanel（居中面板）共用。
 */
class SearchSession {
  private disposables: vscode.Disposable[] = [];
  /** 记录当前关键词，供 revalidate（切换过滤/重新可见）时按相同条件重新取数 */
  private lastKeyword = '';
  /**
   * 记录当前已下发的结果集，供 computeSize 计算 ResultSetFootprintTotal
   * （当前结果列表展示会话的自身口径占用合计，可相加口径）。
   */
  private lastResults: any[] = [];
  /**
   * 统计进行中标志：ComputeSizeButton 左键触发的占用统计是 IO 密集的异步任务，
   * 统计期间忽略重复的 computeSize 请求（前端也置忙碌态，双重保险，Req 4.5）。
   */
  private summaryInflight = false;
  /**
   * 是否已经至少成功推过一次 `ok` 态汇总。清理完成后只对**正在展示数值**的会话重算
   * SummaryBar（Req 4.12）；停在 IdleState 的会话没有数值可刷新，凭空重算等于在用户
   * 没要求的时候跑一次全量枚举（Req 7.12）。`refresh()` 把 SummaryBar 置回 idle 时复位。
   */
  private summaryComputed = false;
  /**
   * 惰性构造的占用统计器（按当前工作区路径注入）。持有它而非每次 computeSize 新建，
   * 是为了跨多次统计复用 SubtreeCache（`force: true` 只绕过 60 秒 StorageCache，
   * 不绕过子树聚合缓存，Req 4.6、7.5、7.6）。工作区路径变化时重建。
   */
  private analyzer: StorageAnalyzer | null = null;
  private analyzerWorkspacePath: string | null = null;

  constructor(private readonly webview: vscode.Webview) {
    this.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
    // 登记到模块级注册表：清理完成后据此刷新 SizeBadge 与 SummaryBar（Req 14.14）
    activeSearchSessions.add(this);
  }

  dispose() {
    activeSearchSessions.delete(this);
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  /** 让 Webview 聚焦搜索框（仅居中面板复用时使用） */
  focus() {
    this.webview.postMessage({ type: 'focus' });
  }

  /**
   * 重新按当前关键词取数并推送（不改变环境状态条）。
   * 用于：面板重新可见、前端切换附件过滤时——确保过滤作用在最新数据上，
   * 而非面板打开时的旧快照。底层有 mtime/size 缓存，重读开销很小。
   */
  refresh() {
    // 视图/面板变为可见时把 SummaryBar 置回 IdleState，不触发任何为统计而做的
    // 目录枚举（Req 4.2）；随后按当前关键词重新取搜索结果。
    this.webview.postMessage({ type: 'summary', state: 'idle' });
    this.summaryComputed = false;
    this.runSearch(this.lastKeyword);
  }

  /**
   * 清理完成后的刷新（由 `refreshUiAfterCleanup` 调用，Req 14.14、14.15、4.12）。
   *
   * - 恒重新取搜索结果：SizeBadge 的数值随之更新（存档索引已被摘除对应条目），
   *   且 FullCleanup 删掉的会话不再出现在结果与最近列表里（Req 14.15）
   * - `recompute` 为真（确实删掉了字节）且此前已展示过数值时，重算 SummaryBar 三项
   */
  onStorageChanged(recompute: boolean) {
    this.runSearch(this.lastKeyword);
    if (recompute && this.summaryComputed) this.computeSize();
  }

  /**
   * 打掉本会话 analyzer 的缓存（由 `invalidateStorageCaches` 调用，Req 14.13）。
   * 每个 SearchSession 持有自己的 StorageAnalyzer（各带独立 SubtreeCache），
   * 不逐个失效的话下一次统计会在祖先目录这一级直接命中含已删字节的陈旧聚合。
   */
  invalidateStorageCaches(paths: readonly string[]) {
    try {
      this.analyzer?.invalidateForDeletedFiles(paths);
    } catch {
      /* 失效失败最坏是数值滞后一个 TTL */
    }
  }

  private handleMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
        this.pushEnvironmentStatus();
        break;
      case 'search':
        this.runSearch(String(msg.keyword || ''));
        break;
      case 'revalidate':
        // 前端切换过滤 tab 前请求刷新数据源
        this.runSearch(this.lastKeyword);
        break;
      case 'hardRefresh':
        // 前端点击刷新按钮：按当前关键词重新取数。
        // 底层按 (mtime, size) 失效 + 未命中重扫目录，已能拿到磁盘最新状态与
        // 最新 credit 统计，无需清空仍然有效的缓存。
        this.runSearch(this.lastKeyword);
        break;
      case 'open':
        this.openSession(String(msg.sessionId || ''));
        break;
      case 'computeSize':
        // ComputeSizeButton 左键：触发一次占用统计（IO 密集）。统计在独立异步任务里
        // 进行，不阻塞 results 推送；统计期间忽略重复的 computeSize（Req 4.4、4.5、4.6）。
        this.computeSize();
        break;
      case 'openRanking':
        // ComputeSizeButton 右键：打开占用排行页，不改变 SummaryBar 当前状态（Req 4.7）。
        vscode.commands.executeCommand('kiroChatSearch.storageRanking');
        break;
      case 'openSettings':
        // 过滤条右下角的齿轮：打开设置页（对话耗时显示等）。与 openRanking 同一手法。
        vscode.commands.executeCommand('kiroChatSearch.settings');
        break;
      // 'close' 由调用方（SearchPanel）单独监听并 dispose 面板
    }
  }

  /**
   * 惰性取得（或按工作区路径变化重建）StorageAnalyzer。生产路径不注入 pathResolver /
   * fsDeps，退回真实 `fs/promises` 与 PathResolver 默认实现。
   */
  private getAnalyzer(): StorageAnalyzer {
    const ws = currentWorkspaceFolder()?.uri.fsPath ?? null;
    if (!this.analyzer || this.analyzerWorkspacePath !== ws) {
      this.analyzer = new StorageAnalyzer({
        workspacePath: ws,
        newLayout: newLayoutForAnalyzer(ws),
      });
      this.analyzerWorkspacePath = ws;
    }
    return this.analyzer;
  }

  /**
   * ComputeSizeButton 左键的入口：置忙碌标志、推 `loading`，随后在**独立异步任务**里
   * 取数（不阻塞消息处理与 results 推送）。忙碌期间的重复请求直接忽略（Req 4.5）。
   */
  private computeSize() {
    if (this.summaryInflight) return;
    this.summaryInflight = true;
    this.webview.postMessage({ type: 'summary', state: 'loading' });
    void this.runComputeSize();
  }

  /**
   * 实际取数：`getSummary({ force: true })` 忽略 60 秒 StorageCache（Req 4.6、7.10）。
   * status 为 'ok' 时推 `ok` 及负载；'unavailable' / UserDataDir 为 null / 任何抛错都
   * 推 `unavailable`。统计失败**不弹任何 vscode 通知**（Req 9.3、9.4）。始终清忙碌标志。
   */
  private async runComputeSize() {
    try {
      const summary = await this.getAnalyzer().getSummary({ force: true });
      if (summary.status !== 'ok' || summary.userDataDir === null) {
        this.webview.postMessage({ type: 'summary', state: 'unavailable' });
        return;
      }
      this.webview.postMessage({
        type: 'summary',
        state: 'ok',
        summary: this.buildSummaryPayload(summary),
      });
      this.summaryComputed = true;
    } catch {
      // 统计整体失败：置为不可用态，搜索与用量展示不受影响，且不弹通知
      this.webview.postMessage({ type: 'summary', state: 'unavailable' });
    } finally {
      this.summaryInflight = false;
    }
  }

  /**
   * 组装 SummaryBar 的 `ok` 负载，字段与 `webview/size.ts` 的 `summaryLabel` ok 态入参一一对应。
   *
   * - `totalBytes` = ProjectFootprintTotal（当前工作区全部会话的自身口径合计）
   * - `resultSetBytes` = ResultSetFootprintTotal：当前结果集每条会话自身口径占用之和
   *   （`sessionJsonBytes + archiveBytesSelf`，都是可相加口径），缺失字段按 0 计
   * - `categories` 映射为 `{ key, label, bytes, pathHint }`，供 tooltip 展开分类明细，
   *   并作为 `summaryLabel` 里 ProjectFootprintTotal 拆解（sessionJson / executionSaves）的回退来源
   */
  private buildSummaryPayload(summary: StorageSummary) {
    const num = (n: unknown): number =>
      typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0;
    const resultSetBytes = this.lastResults.reduce(
      (sum, hit) => sum + num(hit?.sessionJsonBytes) + num(hit?.archiveBytesSelf),
      0
    );
    return {
      totalBytes: summary.projectFootprintTotal,
      resultSetBytes,
      orphanBytes: summary.orphan.bytes,
      orphanState: summary.orphan.state,
      sessionCount: summary.sessionCount,
      resultCount: this.lastResults.length,
      categories: summary.categories.map((c) => ({
        key: c.category,
        label: c.label,
        bytes: c.bytes,
        pathHint: c.pathHint,
      })),
      partial: summary.partial,
      skippedCount: summary.skippedCount,
    };
  }

  private pushEnvironmentStatus() {
    const env = checkEnv();
    if (!env.ok) {
      this.webview.postMessage({
        type: 'status',
        text: `${env.error}${env.hint ? ' · ' + env.hint : ''}`,
        title: env.hint || '',
        error: true,
      });
      return;
    }
    const ws = currentWorkspaceFolder();
    const wsName = ws ? path.basename(ws.uri.fsPath) || ws.uri.fsPath : '当前项目';
    const tooltipLines = [
      ws ? `工作区: ${ws.uri.fsPath}` : null,
      env.userDataDir ? `用户数据: ${env.userDataDir}` : null,
      // 布局与两侧目录都列出来：这是用户判断"扩展到底在读哪一版数据"的唯一入口，
      // 也是 1.x/0.9x 混用时排查"某条会话为什么没出现"的第一现场
      env.layout ? `存储布局: ${LAYOUT_LABELS[env.layout]}` : null,
      env.newWorkspaceDir ? `1.x 会话目录: ${env.newWorkspaceDir}` : null,
      env.workspaceDir ? `0.9x 会话目录: ${env.workspaceDir}` : null,
    ].filter(Boolean);
    this.webview.postMessage({
      type: 'status',
      text: `已就绪 · ${wsName}`,
      title: tooltipLines.join('\n'),
      error: false,
    });

    // 默认展示最近 N 条，方便用户不输入也能直接选
    this.pushRecent();
  }

  private pushRecent() {
    const env = checkEnv();
    // 门槛只看 `env.ok`：`workspace-sessions` 在纯 1.x 环境下可能根本不存在，
    // 再要求 `env.workspaceDir` 就等于把 1.x 用户挡在最近列表之外（design D2）
    if (!env.ok) return;
    try {
      const results = listRecentSessionsInLayout(layoutDirsFrom(env), RECENT_DEFAULT_LIMIT);
      // 记录当前下发的结果集，供 computeSize 计算 ResultSetFootprintTotal（Req 4.4）
      this.lastResults = results;
      this.webview.postMessage({
        type: 'results',
        results,
        keyword: '',
      });
    } catch {
      // 静默：环境状态条已经表明就绪，最近列表失败不必弹错误
    }
  }

  private runSearch(keyword: string) {
    const trimmed = keyword.trim();
    this.lastKeyword = trimmed;
    const env = checkEnv();
    if (!env.ok) {
      this.pushEnvironmentStatus();
      return;
    }
    // 空关键词 → 切回"最近 N 条"
    if (!trimmed) {
      this.pushRecent();
      return;
    }
    try {
      const results = searchSessionsInLayout(layoutDirsFrom(env), trimmed, SEARCH_RESULT_LIMIT);
      // 记录当前下发的结果集，供 computeSize 计算 ResultSetFootprintTotal（Req 4.4）
      this.lastResults = results;
      this.webview.postMessage({
        type: 'results',
        results,
        keyword: trimmed,
      });
    } catch (e: any) {
      this.webview.postMessage({
        type: 'status',
        text: '搜索失败：' + (e?.message || String(e)),
        title: '',
        error: true,
      });
    }
  }

  /**
   * 打开一条会话（Req 5.1–5.9）。
   *
   * 传 {@link JumpTarget} 而**不是** sessionId 字符串：`jump.ts` 的字符串形态为兼容既有
   * 调用方而恒用 0.9x 候选链（那三个命令在 1.x 上已全部失效或有副作用），只有带布局信息的
   * 对象形态才会走 `kiroAgent.viewSession` → `kiroAgent.sessions.switch`。这正是"点击搜索
   * 结果在 1.x 里打不开会话"的成因。
   *
   * `title` 与 `sessionLayout` 从**已下发给前端的那一批结果**里按 sessionId 反查，而不是
   * 让 webview 把它们回传：前端只需要继续 `postMessage({type:'open', sessionId})`，
   * 协议不变；且宿主用的恒是自己刚算出的值，前端改不动它。查不到时退化为只传 sessionId
   * ——候选链仍是 1.x 的两项，只是省掉标题参数（Req 5.6 允许）。
   */
  private async openSession(sessionId: string) {
    const hit = (this.lastResults as SearchHit[]).find((r) => r?.sessionId === sessionId);
    // 候选链推导与失败提示都在 openSessionByJump / jump.ts 一侧，与排行页的
    // SessionTitleLink 共用同一入口，避免两处各自装配 deps 后出现偏差
    await openSessionByJump({
      sessionId,
      title: typeof hit?.title === 'string' ? hit.title : undefined,
      sessionLayout: hit?.layout === 'old' || hit?.layout === 'new' ? hit.layout : undefined,
    });
  }
}

/**
 * 居中的搜索面板（命令 / 快捷键打开）。
 */
class SearchPanel {
  private static current: SearchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly session: SearchSession;
  private disposables: vscode.Disposable[] = [];

  static showOrCreate(context: vscode.ExtensionContext) {
    if (SearchPanel.current) {
      SearchPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      SearchPanel.current.session.focus();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Kiro 对话搜索',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    SearchPanel.current = new SearchPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    const nonce = generateNonce();
    panel.webview.html = getWebviewHtml(panel.webview, nonce);

    this.session = new SearchSession(panel.webview);

    // 居中面板独有：按 Esc 关闭整个面板
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'close') panel.dispose();
      },
      null,
      this.disposables
    );
    // 面板重新变为可见时刷新数据，避免展示打开时的旧快照
    panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) this.session.refresh();
      },
      null,
      this.disposables
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose() {
    SearchPanel.current = undefined;
    this.session.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 左侧 Activity Bar 的搜索视图：直接呈现完整搜索 UI，无需中转按钮。
 * 使用与居中面板完全相同的 Webview HTML 与消息协议。
 */
class EntryViewProvider implements vscode.WebviewViewProvider {
  /** 记录视图当前是否可见，供 toggle 命令决定“聚焦”还是“收起” */
  static visible = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = generateNonce();
    view.webview.html = getWebviewHtml(view.webview, nonce);

    const session = new SearchSession(view.webview);
    view.onDidDispose(() => session.dispose());
    EntryViewProvider.visible = view.visible;
    // 视图重新可见时刷新数据（侧边栏切走再切回 / 折叠展开）
    view.onDidChangeVisibility(() => {
      EntryViewProvider.visible = view.visible;
      if (view.visible) session.refresh();
    });
  }
}

function generateNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroChatSearch.openSearch', () => {
      SearchPanel.showOrCreate(context);
    })
  );

  // 折叠/展开：视图可见时收起侧边栏腾出编辑空间；不可见时聚焦本视图。
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroChatSearch.toggleView', async () => {
      if (EntryViewProvider.visible) {
        await vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
      } else {
        await vscode.commands.executeCommand('kiroChatSearch.entry.focus');
      }
    })
  );

  // 存储占用分析命令（package.json 已注册标题「Kiro: 存储占用分析」，Req 6.1）
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroChatSearch.storageReport', () => runStorageReport())
  );

  // 存储占用排行命令（package.json 已注册标题「Kiro: 存储占用排行」，Req 13.1）。
  // 也是搜索面板 ComputeSizeButton 右键的落点（`openRanking` 消息执行的就是本命令）。
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroChatSearch.storageRanking', () =>
      openStorageRanking(context)
    )
  );

  // 设置页命令（package.json 已注册标题「Kiro: 设置」）。
  // 也是搜索面板过滤条右下角齿轮的落点（`openSettings` 消息执行的就是本命令）。
  context.subscriptions.push(
    vscode.commands.registerCommand('kiroChatSearch.settings', () => openSettingsPanel(context))
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'kiroChatSearch.entry',
      new EntryViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 对话耗时补丁的自动补齐放在最后：命令已注册，通知里的「打开设置」按钮才一定可用。
  // 不 await——它只做几次小文件读写，但没有理由让它挡住 activate 的返回。
  void syncTurnTimerOnActivate(context);
}

export function deactivate() {}
