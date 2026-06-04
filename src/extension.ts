import * as vscode from 'vscode';
import * as path from 'path';
import { checkEnvironment, EnvCheck } from './env';
import { searchSessionsInDir } from './search';
import { resolveAndExecuteJumpCommand } from './jump';
import { getWebviewHtml } from './webview';

const PANEL_VIEW_TYPE = 'kiroChatSearch.panel';

/** 取当前工作区第一个文件夹（供 EnvChecker 注入） */
function currentWorkspaceFolder(): { uri: { fsPath: string } } | null {
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

function checkEnv(): EnvCheck {
  return checkEnvironment({ workspaceFolder: currentWorkspaceFolder() });
}

/**
 * 把 Webview 与扩展宿主之间的搜索/打开/状态协议封装成一个会话对象，
 * 供 EntryView（侧边栏视图）与 SearchPanel（居中面板）共用。
 */
class SearchSession {
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly webview: vscode.Webview) {
    this.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  dispose() {
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
      // 'close' 由调用方（SearchPanel）单独监听并 dispose 面板
    }
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
      env.workspaceDir ? `会话目录: ${env.workspaceDir}` : null,
    ].filter(Boolean);
    this.webview.postMessage({
      type: 'status',
      text: `已就绪 · ${wsName}`,
      title: tooltipLines.join('\n'),
      error: false,
    });
  }

  private runSearch(keyword: string) {
    const trimmed = keyword.trim();
    if (!trimmed) {
      this.webview.postMessage({ type: 'results', results: [], keyword: '' });
      return;
    }
    const env = checkEnv();
    if (!env.ok || !env.workspaceDir) {
      this.pushEnvironmentStatus();
      return;
    }
    try {
      const results = searchSessionsInDir(env.workspaceDir, trimmed, 10);
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

  private async openSession(sessionId: string) {
    await resolveAndExecuteJumpCommand(sessionId, {
      getCommands: (filterInternal) =>
        Promise.resolve(vscode.commands.getCommands(filterInternal)),
      executeCommand: (command, ...args) =>
        vscode.commands.executeCommand(command, ...args),
      showError: (message) => vscode.window.showErrorMessage(message),
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'kiroChatSearch.entry',
      new EntryViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
