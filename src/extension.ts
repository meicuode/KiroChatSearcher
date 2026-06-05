import * as vscode from 'vscode';
import * as path from 'path';
import { checkEnvironment, EnvCheck } from './env';
import { searchSessionsInDir, listRecentSessions } from './search';
import { resolveAndExecuteJumpCommand } from './jump';
import { getWebviewHtml } from './webview';

const PANEL_VIEW_TYPE = 'kiroChatSearch.panel';

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
 * 把 Webview 与扩展宿主之间的搜索/打开/状态协议封装成一个会话对象，
 * 供 EntryView（侧边栏视图）与 SearchPanel（居中面板）共用。
 */
class SearchSession {
  private disposables: vscode.Disposable[] = [];
  /** 记录当前关键词，供 revalidate（切换过滤/重新可见）时按相同条件重新取数 */
  private lastKeyword = '';

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

  /**
   * 重新按当前关键词取数并推送（不改变环境状态条）。
   * 用于：面板重新可见、前端切换附件过滤时——确保过滤作用在最新数据上，
   * 而非面板打开时的旧快照。底层有 mtime/size 缓存，重读开销很小。
   */
  refresh() {
    this.runSearch(this.lastKeyword);
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

    // 默认展示最近 N 条，方便用户不输入也能直接选
    this.pushRecent();
  }

  private pushRecent() {
    const env = checkEnv();
    if (!env.ok || !env.workspaceDir) return;
    try {
      const results = listRecentSessions(env.workspaceDir, RECENT_DEFAULT_LIMIT);
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
    if (!env.ok || !env.workspaceDir) {
      this.pushEnvironmentStatus();
      return;
    }
    // 空关键词 → 切回"最近 N 条"
    if (!trimmed) {
      this.pushRecent();
      return;
    }
    try {
      const results = searchSessionsInDir(env.workspaceDir, trimmed, SEARCH_RESULT_LIMIT);
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'kiroChatSearch.entry',
      new EntryViewProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
