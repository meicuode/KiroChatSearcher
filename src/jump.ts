import type { StorageLayout } from './layout';

export interface JumpDeps {
  /** 返回当前可用命令列表（对应 vscode.commands.getCommands） */
  getCommands?: (filterInternal?: boolean) => Promise<string[]>;
  /** 执行命令（对应 vscode.commands.executeCommand） */
  executeCommand?: <T = unknown>(command: string, ...args: unknown[]) => Promise<T> | Thenable<T>;
  /** 显示错误提示（对应 vscode.window.showErrorMessage） */
  showError?: (message: string) => void;
  /**
   * 候选跳转命令，按优先级排列。
   * 显式给出时**完全覆盖**按布局推导的候选链（诊断命令与测试用）；
   * 缺省时由 {@link buildJumpCandidates} 按跳转目标推导。
   */
  candidates?: JumpCandidate[];
}

export interface JumpCandidate {
  /** 命令名 */
  command: string;
  /**
   * 由 sessionId 构造该命令的参数数组。
   * 不同 Kiro 版本的命令签名不同，这里显式约定每个候选的传参方式。
   */
  buildArgs: (sessionId: string) => unknown[];
}

export interface JumpResult {
  invoked: boolean;
  commandUsed?: string;
  error?: unknown;
}

/**
 * 一条会话的**数据所在磁盘格式**：`new` = 1.x 目录型，`old` = 0.9x 单文件。
 *
 * 与 `search.ts` 的 `SessionSourceKind` / `SearchHit.layout` 取值域一致（两者结构相同、可直接互传）。
 * 这里刻意不从 `search.ts` 导入：跳转只需要「这条数据是哪种格式」这一个信息，
 * 为它把整个搜索模块拉进依赖图不划算，且会让 `jump.ts` 随搜索模块的重构一起晃动。
 */
export type SessionDataLayout = 'old' | 'new';

/**
 * 一次跳转的目标描述。
 *
 * `sessionLayout` 与 `layout` 都是**可选**的：候选链按「知道多少就用多少」推导，
 * 两者都不给时退回纯 1.x 候选（见 {@link buildJumpCandidates}）。
 */
export interface JumpTarget {
  /**
   * 会话 id，**原样传递**给命令：形如 `sess_<uuid>`（1.x 新建）还是裸 uuid（0.9x 迁移而来）
   * 都不做前缀改写、补齐或截断（Req 5.5）。1.x 的 sessionPanelManager 用它直接查表，
   * 任何「规整」都会把能打开的会话变成打不开。
   */
  sessionId: string;
  /**
   * 会话标题，作为 `kiroAgent.viewSession` 的第二个参数（Req 5.6）。
   * 空串或纯空白时该参数被**省略**——1.x 的实现是
   * `typeof title === "string" ? title : void 0`，传空白串会让侧边栏标题变成空白。
   */
  title?: string;
  /** 该条目数据所在格式，通常直接取 `SearchHit.layout`。 */
  sessionLayout?: SessionDataLayout;
  /** 当前工作区的布局结论，取自 `detectLayout().layout`。 */
  layout?: StorageLayout;
}

const VIEW_SESSION = 'kiroAgent.viewSession';
const SESSIONS_SWITCH = 'kiroAgent.sessions.switch';
const SHOW_EXECUTION_IN_CHAT_TAB = 'kiroAgent.showExecutionInChatTab';
const VIEW_SPEC_SESSION = 'kiroAgent.viewSpecSession';
const LOAD_SESSION_WITH_PROMPT = 'kiroAgent.loadSessionWithPrompt';

/**
 * 1.x 候选命令名，按优先级排列（Req 5.3）。
 *
 * 只有这两项。对 kiro-agent 1.0.653 的 `dist/extension.js` 实测：
 *
 *  1. `kiroAgent.viewSession(sessionId, title?)` —— 主方案。
 *     实现即 `sessionPanelManager.switchToSidebarSession(sessionId, safeTitle)`，
 *     无副作用，Kiro 自身（spec 调用、hook、powers、CodeLens）到处在用。
 *
 *  2. `kiroAgent.sessions.switch(sessionId, windowId, source)` —— 降级方案。
 *     `windowId === undefined` 走「当前窗口」分支：清掉 activeWindowId、
 *     把会话来源置为 `local`，再 `switchToSidebarSession(sessionId)`。
 *     传 `windowId` 会去 standalone 连接池里找那个窗口的 client，找不到直接返回，
 *     因此定点跳转必须留空；`source` 传 `'remote'` 会切到远端来源，故取 `'local'`。
 *
 * **不含** `kiroAgent.loadSessionWithPrompt`：1.x 的签名已变为 `(_sessionId, prompt)`，
 * sessionId 被忽略，且会把 prompt 当作一条新用户消息发给**当前**会话——
 * 拿它兜底不会打开目标会话，只会往用户正在聊的会话里插一条空消息并触发模型响应。
 * 另两个 0.9x 候选（`showExecutionInChatTab` / `viewSpecSession`）在 1.x 上已被移除
 * （在 1.0.653 的产物里连字符串都搜不到）。
 */
export const NEW_JUMP_COMMANDS: readonly string[] = [VIEW_SESSION, SESSIONS_SWITCH];

/**
 * 0.9x 候选命令名，按既有优先级排列。
 *
 * 经对旧版 Kiro 自带 `kiro.kiro-agent` 扩展的运行时实测（见 README“会话跳转方案”一节）：
 *
 *  1. `kiroAgent.showExecutionInChatTab(sessionId)` —— 0.9x 主方案。
 *     前端仅调用“加载会话”逻辑，定位到会话当前位置，**不发送任何消息**，
 *     无副作用。注意：第二个参数 executionId 必须省略——一旦传入会强制
 *     把视图滚动定位到该执行记录（通常是最早一条），导致跳到对话开头。
 *
 *  2. `kiroAgent.viewSpecSession(sessionId)` —— 更旧版本的兼容降级。
 *
 *  3. `kiroAgent.loadSessionWithPrompt(sessionId, '')` —— 0.9x 最后兜底。
 *     ⚠ 会加载会话，但前端会无条件把 prompt 当作一条新用户消息发送，
 *     传空串会向目标会话发出一条空消息并触发模型响应，**可能污染历史**。
 *     仅当上述方案全部不可用时才退到这里。
 */
export const LEGACY_JUMP_COMMANDS: readonly string[] = [
  SHOW_EXECUTION_IN_CHAT_TAB,
  VIEW_SPEC_SESSION,
  LOAD_SESSION_WITH_PROMPT,
];

/** 0.9x 候选链（含传参方式），本次适配前的 `DEFAULT_CANDIDATES` 原样保留。 */
const LEGACY_CANDIDATES: JumpCandidate[] = [
  { command: SHOW_EXECUTION_IN_CHAT_TAB, buildArgs: (id) => [id] },
  { command: VIEW_SPEC_SESSION, buildArgs: (id) => [id] },
  { command: LOAD_SESSION_WITH_PROMPT, buildArgs: (id) => [id, ''] },
];

/** 1.x 候选链（含传参方式）；`title` 为空或纯空白时 `viewSession` 只传 sessionId（Req 5.6）。 */
function newJumpCandidates(title?: string): JumpCandidate[] {
  const withTitle = typeof title === 'string' && title.trim() !== '';
  return [
    { command: VIEW_SESSION, buildArgs: (id) => (withTitle ? [id, title] : [id]) },
    // windowId 恒为 undefined（当前窗口），source 恒为 'local'，理由见 NEW_JUMP_COMMANDS
    { command: SESSIONS_SWITCH, buildArgs: (id) => [id, undefined, 'local'] },
  ];
}

/**
 * 是否把 0.9x 候选链追加到 1.x 候选之后（Req 5.4）。
 *
 * 判据按「条目 → 工作区」两级，条目级优先，而不是只看工作区布局一刀切：
 *
 * - 条目是 1.x 目录型会话（`sessionLayout === 'new'`）→ 恒不追加。
 *   0.9x 命令对目录型会话不可能有意义，追加只会白试。
 * - 否则看工作区布局：仅 `old-only` 追加。`old-only` 意味着本工作区在 `~/.kiro/sessions`
 *   下没有任何会话目录，宿主大概率仍是 0.9x 版 Kiro，此时 1.x 的两个候选必然全部失败，
 *   必须能退到既有候选链，旧版上的跳转行为才与本次适配前一致。
 *
 * `both` / `new-only` 下**绝不**追加：这两种布局说明宿主是 1.x，而 0.9x 链末尾的
 * `loadSessionWithPrompt` 在 1.x 上仍注册着且会向**当前**会话发消息——
 * 对 `both` 里那些未迁移的旧会话追加它，等于用「污染用户正在聊的会话」换一次
 * 注定打不开目标的尝试。这类会话在 1.x 界面里本就不可见，跳不过去是事实，不该拿副作用去掩盖。
 * `layout` 未给出时同样不追加：未知宿主按 1.x 处理，宁可失败也不触发副作用。
 */
function shouldAppendLegacy(target: JumpTarget): boolean {
  if (target.sessionLayout === 'new') return false;
  return target.layout === 'old-only';
}

/**
 * 按跳转目标推导候选命令链：1.x 两项在前，必要时把 0.9x 三项作为降级候选追加在后。
 *
 * 纯函数、无 I/O，供宿主与测试直接检查候选顺序与传参方式。
 */
export function buildJumpCandidates(target: JumpTarget): JumpCandidate[] {
  const candidates = newJumpCandidates(target.title);
  return shouldAppendLegacy(target) ? [...candidates, ...LEGACY_CANDIDATES] : candidates;
}

/**
 * 解析并执行用于打开 Kiro 会话的跳转命令。
 *
 * 关键点：不把 getCommands 的列表当作硬性门槛——Kiro 的 kiroAgent.* 命令
 * 可能可执行但并不出现在 getCommands() 返回的列表中。因此这里直接按优先级
 * 依次尝试调用候选命令，靠 try/catch 处理“命令不存在/调用失败”的情形，
 * 并在首个成功的候选处停止（Req 5.9）。
 *
 * 两种调用形态：
 *
 * - 传 {@link JumpTarget}（新代码用）：候选链由 {@link buildJumpCandidates} 按布局推导，
 *   1.x 优先、`old-only` 时追加 0.9x 降级候选。
 * - 传 sessionId 字符串（0.9x 时代的既有调用形态）：候选链恒为既有的 0.9x 三项，
 *   传参与顺序与本次适配前逐字一致。没有布局信息就不擅自改变既有调用方的行为；
 *   要用 1.x 候选，传 `{ sessionId, title, layout }` 即可。
 *
 * 本函数只负责调命令，不碰面板：调用成功后 SearchPanel 自然保持打开（Req 5.8）。
 * 全部失败时通过 showError 给出列出**已尝试**候选命令名的中文提示（Req 5.7）。
 */
export async function resolveAndExecuteJumpCommand(
  target: JumpTarget,
  deps?: JumpDeps
): Promise<JumpResult>;
export async function resolveAndExecuteJumpCommand(
  sessionId: string,
  deps?: JumpDeps
): Promise<JumpResult>;
export async function resolveAndExecuteJumpCommand(
  sessionIdOrTarget: string | JumpTarget,
  deps?: JumpDeps
): Promise<JumpResult> {
  const isLegacyForm = typeof sessionIdOrTarget === 'string';
  const target: JumpTarget = isLegacyForm ? { sessionId: sessionIdOrTarget } : sessionIdOrTarget;
  const sessionId = target.sessionId;
  if (!sessionId) {
    return { invoked: false };
  }

  const candidates =
    deps?.candidates ?? (isLegacyForm ? LEGACY_CANDIDATES : buildJumpCandidates(target));
  const executeCommand = deps?.executeCommand;
  const showError = deps?.showError;

  let lastError: unknown;
  if (executeCommand) {
    for (const cand of candidates) {
      try {
        await executeCommand(cand.command, ...cand.buildArgs(sessionId));
        return { invoked: true, commandUsed: cand.command };
      } catch (e) {
        lastError = e;
        // 命令不存在或调用失败，尝试下一个候选
      }
    }
  }

  if (showError) {
    showError(
      `无法打开会话：未找到可用的 Kiro 跳转命令（${candidates
        .map((c) => c.command)
        .join(' / ')}）。请确认插件运行在 Kiro 中，或执行命令 “Kiro Chat Search: 验证 sessionId 跳转（诊断）” 排查当前可用命令。`
    );
  }
  return { invoked: false, error: lastError };
}
