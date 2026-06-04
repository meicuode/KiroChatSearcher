import * as vscode from 'vscode';
import { checkEnvironment, EnvCheck } from './env';
import { searchSessionsInDir } from './search';
import { resolveAndExecuteJumpCommand } from './jump';
import { getWebviewHtml } from './webview';
import { escapeHtml } from './webview/format';

const PANEL_VIEW_TYPE = 'kiroChatSearch.panel';

/** 取当前工作区第一个文件夹（供 EnvChecker 注入） */
function currentWorkspaceFolder(): { uri: { fsPath: string } } | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

function checkEnv(): EnvCheck {
  return checkEnvironment({ workspaceFolder: currentWorkspaceFolder() });
}

/**
 * 打开/聚焦居中的搜索面板。
 */
class SearchPanel {
  private static current: SearchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static showOrCreate(context: vscode.ExtensionContext) {
    if (SearchPanel.current) {
      SearchPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      SearchPanel.current.panel.webview.postMessage({ type: 'focus' });
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

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private handleMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
        this.pushEnvironmentStatus();
        break;
      case 'search':
        this.runSearch(String(msg.keyword || ''));
        break;
      case 'open':
        this.openSession(String(msg.sessionId || ''));
        break;
      case 'close':
        this.panel.dispose();
        break;
    }
  }

  private pushEnvironmentStatus() {
    const env = checkEnv();
    if (!env.ok) {
      this.panel.webview.postMessage({
        type: 'status',
        text: `${env.error}${env.hint ? ' · ' + env.hint : ''}`,
        error: true,
      });
    } else {
      this.panel.webview.postMessage({
        type: 'status',
        text: '输入关键词开始搜索 · 仅搜索当前项目的对话历史',
        error: false,
      });
    }
  }

  private runSearch(keyword: string) {
    const trimmed = keyword.trim();
    if (!trimmed) {
      this.panel.webview.postMessage({ type: 'results', results: [], keyword: '' });
      return;
    }
    const env = checkEnv();
    if (!env.ok || !env.workspaceDir) {
      this.pushEnvironmentStatus();
      return;
    }
    try {
      const results = searchSessionsInDir(env.workspaceDir, trimmed, 10);
      this.panel.webview.postMessage({
        type: 'results',
        results,
        keyword: trimmed,
      });
    } catch (e: any) {
      this.panel.webview.postMessage({
        type: 'status',
        text: '搜索失败：' + (e?.message || String(e)),
        error: true,
      });
    }
  }

  private async openSession(sessionId: string) {
    await resolveAndExecuteJumpCommand(sessionId, {
      getCommands: (filterInternal) => Promise.resolve(vscode.commands.getCommands(filterInternal)),
      executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
      showError: (message) => vscode.window.showErrorMessage(message),
    });
  }

  private dispose() {
    SearchPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try { d?.dispose(); } catch { /* ignore */ }
    }
  }
}

/**
 * 左侧 ActivityBar 的入口视图：放一个引导按钮，点击后打开居中面板。
 */
class EntryViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const env = checkEnv();
    const status = env.ok
      ? `<div class="ok">已就绪</div>
         <div class="meta">用户数据: <code>${escapeHtml(env.userDataDir!)}</code></div>
         <div class="meta">会话目录: <code>${escapeHtml(env.workspaceDir!)}</code></div>`
      : `<div class="err">${escapeHtml(env.error || '不可用')}</div>
         <div class="meta">${escapeHtml(env.hint || '')}</div>`;

    view.webview.html = /* html */ `<!DOCTYPE html><html><head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
  button {
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
    font-size: 13px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .meta { font-size: 11px; opacity: .7; margin-top: 6px; word-break: break-all; }
  .ok  { color: var(--vscode-testing-iconPassed, #3fb950); margin-top: 12px; font-weight: 600; }
  .err { color: var(--vscode-errorForeground); margin-top: 12px; font-weight: 600; }
  code {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.1));
    padding: 1px 4px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
  }
</style></head><body>
  <button id="open">🔍 打开搜索</button>
  ${status}
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('open').addEventListener('click', () => {
    vscode.postMessage({ type: 'open' });
  });
</script>
</body></html>`;

    view.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'open') {
        vscode.commands.executeCommand('kiroChatSearch.openSearch');
      }
    });
  }
}

function generateNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'kiroChatSearch.entry',
      new EntryViewProvider(context.extensionUri)
    )
  );
}

export function deactivate() {}
