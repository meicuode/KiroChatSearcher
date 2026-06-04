export interface JumpDeps {
  /** 返回当前可用命令列表（对应 vscode.commands.getCommands） */
  getCommands?: (filterInternal?: boolean) => Promise<string[]>;
  /** 执行命令（对应 vscode.commands.executeCommand） */
  executeCommand?: <T = unknown>(command: string, ...args: unknown[]) => Promise<T> | Thenable<T>;
  /** 显示错误提示（对应 vscode.window.showErrorMessage） */
  showError?: (message: string) => void;
  /** 候选跳转命令，按优先级排列 */
  candidates?: string[];
}

export interface JumpResult {
  invoked: boolean;
  commandUsed?: string;
  error?: unknown;
}

const DEFAULT_CANDIDATES = ['kiroAgent.viewSpecSession', 'kiroAgent.openChatSession'];

/**
 * 解析并执行用于打开 Kiro 会话的跳转命令。
 * 优先调用 kiroAgent.viewSpecSession，不可用或抛错时回退 kiroAgent.openChatSession。
 * 全部失败时通过 showError 给出同时列出两个候选命令名的中文提示。
 */
export async function resolveAndExecuteJumpCommand(
  sessionId: string,
  deps?: JumpDeps
): Promise<JumpResult> {
  if (!sessionId) {
    return { invoked: false };
  }

  const candidates = deps?.candidates ?? DEFAULT_CANDIDATES;
  const getCommands = deps?.getCommands;
  const executeCommand = deps?.executeCommand;
  const showError = deps?.showError;

  let available: string[] = [];
  if (getCommands) {
    try {
      available = await getCommands(true);
    } catch {
      available = [];
    }
  }

  let lastError: unknown;
  for (const cmd of candidates) {
    if (available.length && !available.includes(cmd)) {
      continue;
    }
    if (!executeCommand) {
      continue;
    }
    try {
      await executeCommand(cmd, sessionId);
      return { invoked: true, commandUsed: cmd };
    } catch (e) {
      lastError = e;
      // 尝试下一个候选
    }
  }

  if (showError) {
    showError(
      `无法打开会话：未找到可用的 Kiro 跳转命令（${candidates.join(' / ')}）。请确认插件运行在 Kiro 中。`
    );
  }
  return { invoked: false, error: lastError };
}
