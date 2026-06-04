export interface JumpDeps {
  /** 返回当前可用命令列表（对应 vscode.commands.getCommands） */
  getCommands?: (filterInternal?: boolean) => Promise<string[]>;
  /** 执行命令（对应 vscode.commands.executeCommand） */
  executeCommand?: <T = unknown>(command: string, ...args: unknown[]) => Promise<T> | Thenable<T>;
  /** 显示错误提示（对应 vscode.window.showErrorMessage） */
  showError?: (message: string) => void;
  /** 候选跳转命令，按优先级排列；缺省使用 DEFAULT_CANDIDATES */
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
 * 跳转命令候选列表，按优先级排列。
 *
 * 经对 Kiro 自带 `kiro.kiro-agent` 扩展的运行时实测（见 README“会话跳转方案”一节）：
 *
 *  1. `kiroAgent.showExecutionInChatTab(sessionId)` —— 主方案。
 *     前端仅调用“加载会话”逻辑，定位到会话当前位置，**不发送任何消息**，
 *     无副作用。注意：第二个参数 executionId 必须省略——一旦传入会强制
 *     把视图滚动定位到该执行记录（通常是最早一条），导致跳到对话开头。
 *
 *  2. `kiroAgent.viewSpecSession(sessionId)` —— 兼容降级。
 *     旧版 Kiro（基于 sessionPanelManager）使用，新版可能未注册。
 *
 *  3. `kiroAgent.loadSessionWithPrompt(sessionId, '')` —— 最后兜底。
 *     ⚠ 会加载会话，但前端会无条件把 prompt 当作一条新用户消息发送，
 *     传空串会向目标会话发出一条空消息并触发模型响应，**可能污染历史**。
 *     仅当上述方案全部不可用时才退到这里。
 */
const DEFAULT_CANDIDATES: JumpCandidate[] = [
  { command: 'kiroAgent.showExecutionInChatTab', buildArgs: (id) => [id] },
  { command: 'kiroAgent.viewSpecSession', buildArgs: (id) => [id] },
  { command: 'kiroAgent.loadSessionWithPrompt', buildArgs: (id) => [id, ''] },
];

/**
 * 解析并执行用于打开 Kiro 会话的跳转命令。
 *
 * 关键点：不把 getCommands 的列表当作硬性门槛——Kiro 的 kiroAgent.* 命令
 * 可能可执行但并不出现在 getCommands() 返回的列表中。因此这里直接按优先级
 * 依次尝试调用候选命令，靠 try/catch 处理“命令不存在/调用失败”的情形。
 *
 * 全部失败时通过 showError 给出列出候选命令名的中文提示。
 */
export async function resolveAndExecuteJumpCommand(
  sessionId: string,
  deps?: JumpDeps
): Promise<JumpResult> {
  if (!sessionId) {
    return { invoked: false };
  }

  const candidates = deps?.candidates ?? DEFAULT_CANDIDATES;
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
