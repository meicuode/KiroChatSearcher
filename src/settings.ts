import { turnTimerStatusLabel } from './webview/turnTimer';
import type { TurnTimerActionResult, TurnTimerStatus } from './turnTimer';

// 仅类型导入：`import type` 编译期被完全擦除，不产生运行时 `require('vscode')`。
// 与 `storage/ranking.ts` 同一取舍——本文件的纯函数（`getSettingsHtml`）要能被 vitest
// 直接 import，而测试环境没有 `vscode` 模块；真正需要 vscode API 的只有面板创建，
// 改用惰性 `require`。
import type * as vscode from 'vscode';

/** 惰性取 vscode 运行时模块：只在扩展宿主里、真正创建面板时才求值。 */
function loadVscode(): typeof import('vscode') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vscode') as typeof import('vscode');
}

/** 设置页面板的 WebviewPanel viewType（与命令 id 对齐）。 */
export const SETTINGS_PANEL_VIEW_TYPE = 'kiroChatSearch.settings';

/** 面板标题栏文案。 */
const SETTINGS_PANEL_TITLE = 'Kiro Chat Search 设置';

/**
 * 把共享的纯函数序列化进内联脚本，保证 webview 运行时与单元测试用同一份实现。
 * 只有 `turnTimerStatusLabel` 一个——设置页的其余渲染都是直白的赋值。
 */
function injectedSettingsScript(): string {
  return turnTimerStatusLabel.toString();
}

/** webview → 宿主的入站消息（与 {@link getSettingsHtml} 内联脚本的 postMessage 对齐）。 */
export type SettingsInboundMessage =
  | { type: 'ready' }
  | { type: 'setEnabled'; enabled?: unknown }
  | { type: 'detect' }
  | { type: 'retry' }
  | { type: 'reloadWindow' };

/**
 * 设置页所需的宿主能力（注入而非直接调用），使面板逻辑可在无 vscode 的环境下测试。
 *
 * `enabled` 是**意图**、`detect()` 是**实况**，两者刻意分开由不同成员提供：
 * 用户勾了开关不等于补丁写成功了，设置页必须能同时呈现这两件事。
 */
export interface SettingsPanelDeps {
  /** 读磁盘得出补丁实况。 */
  detect(): TurnTimerStatus;
  /** 打补丁（幂等）。 */
  apply(): TurnTimerActionResult;
  /** 还原补丁（幂等）。 */
  revert(): TurnTimerActionResult;
  /** 读设置意图（持久化在 globalState）。 */
  getEnabled(): boolean;
  /** 写设置意图。 */
  setEnabled(enabled: boolean): void | Promise<void>;
  /** 本窗口启动后是否动过补丁文件（动过 → 当前面板加载的是旧版本）。 */
  isDirty(): boolean;
  /** 重载窗口（`workbench.action.reloadWindow`）。 */
  reloadWindow(): void | Promise<void>;
  /** 诊断输出；缺省则静默。 */
  log?(message: string): void;
}

/** 下发给 webview 的一条完整状态。 */
interface SettingsStatusMessage {
  type: 'status';
  enabled: boolean;
  dirty: boolean;
  state: TurnTimerStatus['state'];
  detail: string;
  distDir: string | null;
  entries: TurnTimerStatus['entries'];
  scriptInstalled: boolean;
  scriptUpToDate: boolean;
  /**
   * 本次探测读磁盘的时刻（epoch ms）。
   *
   * 存在的意义是**给「重新检测」一个可见的结果**：探测通常几毫秒就完成，且结论
   * 大多与上次相同，屏幕上一个像素都不变——用户会以为按钮没反应。有了这个时间戳，
   * 「确实又查了一遍」就变成可见事实，而不用靠转圈动画去暗示。
   */
  checkedAt: number;
  /** 上一次动作的错误（若有），与状态一起下发，避免两条消息的时序问题。 */
  error?: string;
}

/** 模块级单例：一个窗口最多一个设置页。 */
let currentSettingsPanel: SettingsPanel | undefined;

/**
 * 设置页面板：**窗口内单例**。
 *
 * 生命周期与 `RankingPanel` 同构（`showOrCreate` 命中已有实例只 `reveal()`，
 * `retainContextWhenHidden: true`，首次取数等 webview 发来 `ready` 再开始），
 * 但状态模型简单得多：只有「意图 + 实况」一对值，没有分页与排序。
 *
 * 所有动作都是同步的文件操作（写几个小文件），因此不需要 inflight 互斥——
 * 消息处理本身是串行的。UI 侧仍会在动作期间置忙碌，纯粹是为了让用户看到反馈。
 */
export class SettingsPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly deps: SettingsPanelDeps;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /** 上一次动作的错误，随下一次状态一起下发后清空（一次性提示）。 */
  private lastError: string | undefined;

  private constructor(panel: vscode.WebviewPanel, deps: SettingsPanelDeps) {
    this.panel = panel;
    this.deps = deps;

    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => void this.onMessage(raw as SettingsInboundMessage),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** 窗口内单例入口：已存在则 `reveal()` 并重新探测一次，否则创建新面板。 */
  static showOrCreate(context: vscode.ExtensionContext, deps: SettingsPanelDeps): void {
    if (currentSettingsPanel) {
      currentSettingsPanel.panel.reveal(undefined, false);
      // 复用已有面板时主动重探一次：用户可能在别处（或 Kiro 升级）改变了实况
      currentSettingsPanel.pushStatus();
      return;
    }

    const vscodeApi = loadVscode();
    const panel = vscodeApi.window.createWebviewPanel(
      SETTINGS_PANEL_VIEW_TYPE,
      SETTINGS_PANEL_TITLE,
      { viewColumn: vscodeApi.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscodeApi.Uri.joinPath(context.extensionUri, 'media')],
      }
    );

    panel.webview.html = getSettingsHtml(panel.webview.cspSource, settingsNonce());
    currentSettingsPanel = new SettingsPanel(panel, deps);
  }

  dispose(): void {
    if (currentSettingsPanel === this) currentSettingsPanel = undefined;
    this.disposed = true;
    while (this.disposables.length) {
      const d = this.disposables.pop();
      try {
        d?.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      this.panel.dispose();
    } catch {
      /* ignore */
    }
  }

  /** 入站消息路由。未知消息一律忽略（前后端可独立升级）。 */
  private async onMessage(msg: SettingsInboundMessage): Promise<void> {
    if (!msg || typeof msg.type !== 'string' || this.disposed) return;

    if (msg.type === 'ready' || msg.type === 'detect') {
      this.pushStatus();
      return;
    }

    if (msg.type === 'setEnabled') {
      // 只认布尔：其余取值忽略，不让前端决定宿主执行哪一侧动作
      if (typeof msg.enabled !== 'boolean') return;
      await this.applyIntent(msg.enabled);
      return;
    }

    if (msg.type === 'retry') {
      // 重试 = 按当前意图重跑一次，而不是「再打一次补丁」——
      // 意图为关时的残留同样需要一个修复入口
      await this.applyIntent(this.deps.getEnabled());
      return;
    }

    if (msg.type === 'reloadWindow') {
      try {
        await this.deps.reloadWindow();
      } catch (e: unknown) {
        this.lastError = messageOf(e);
        this.pushStatus();
      }
    }
  }

  /**
   * 落实一次意图：先持久化（即使随后写文件失败，用户的选择也不该丢），再动磁盘。
   *
   * 顺序刻意是「先存意图、后写文件」：写失败时状态会显示成「未生效」并给出重试入口，
   * 而下一次 `activate()` 也会按已存下的意图自动重试；反过来（先写后存）一旦写成功
   * 但存失败，就会出现「补丁在跑但设置显示关闭」的错位。
   */
  private async applyIntent(enabled: boolean): Promise<void> {
    this.postBusy(true);
    this.lastError = undefined;
    try {
      await this.deps.setEnabled(enabled);
    } catch (e: unknown) {
      this.lastError = '保存设置失败：' + messageOf(e);
    }

    try {
      const result = enabled ? this.deps.apply() : this.deps.revert();
      if (!result.ok) {
        this.lastError = [this.lastError, result.error].filter(Boolean).join('\n');
      }
      this.deps.log?.(
        `[设置] ${enabled ? '注入' : '移除'}对话耗时补丁：ok=${result.ok} changed=${result.changed}` +
          (result.error ? ' error=' + result.error : '')
      );
    } catch (e: unknown) {
      this.lastError = [this.lastError, messageOf(e)].filter(Boolean).join('\n');
    } finally {
      this.postBusy(false);
      this.pushStatus();
    }
  }

  /** 探测并下发一条完整状态。探测失败也要下发（否则设置页会一直停在骨架里）。 */
  private pushStatus(): void {
    if (this.disposed) return;
    let status: TurnTimerStatus;
    try {
      status = this.deps.detect();
    } catch (e: unknown) {
      this.lastError = messageOf(e);
      status = {
        state: 'unavailable',
        distDir: null,
        scriptInstalled: false,
        scriptUpToDate: false,
        entries: [],
        appliedAt: null,
        hostStartedAt: null,
        detail: '探测失败：' + messageOf(e),
      };
    }

    const message: SettingsStatusMessage = {
      type: 'status',
      enabled: safeBool(() => this.deps.getEnabled()),
      dirty: safeBool(() => this.deps.isDirty()),
      state: status.state,
      detail: status.detail,
      distDir: status.distDir,
      entries: status.entries,
      scriptInstalled: status.scriptInstalled,
      scriptUpToDate: status.scriptUpToDate,
      checkedAt: Date.now(),
    };
    if (this.lastError) message.error = this.lastError;
    this.lastError = undefined;

    void this.panel.webview.postMessage(message);
  }

  private postBusy(busy: boolean): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: 'busy', busy });
  }
}

function safeBool(read: () => boolean): boolean {
  try {
    return !!read();
  } catch {
    return false;
  }
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' ? m : String(e);
}

function settingsNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

/**
 * 设置页 HTML。纯函数（只吃 cspSource 与 nonce），可被单元测试直接执行内联脚本。
 *
 * CSP 与另外两个 webview 逐条一致：脚本只允许带 nonce 的那一段内联脚本，
 * 没有任何外部资源加载。
 *
 * 页面结构刻意平铺、没有路由：一个开关 + 一行结论 + 三个按钮 + 一段可展开的技术细节。
 * 「结论」与「技术细节」分层，是因为绝大多数时候用户只需要知道「生效了没有」，
 * 而排查时才需要知道 dist 路径与逐入口状态。
 */
export function getSettingsHtml(cspSource: string, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${SETTINGS_PANEL_TITLE}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-editor-background);
  }
  body {
    padding: 18px 22px;
    max-width: 760px;
    overflow-y: auto;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 600;
  }
  .subtitle {
    margin: 0 0 18px;
    font-size: 12px;
    opacity: .65;
  }
  .card {
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
    border-radius: 8px;
    padding: 14px 16px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .row + .row { margin-top: 14px; }
  .grow { flex: 1; min-width: 0; }
  .opt-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 3px;
  }
  .opt-desc {
    font-size: 12px;
    opacity: .7;
    line-height: 1.55;
  }
  /* 开关：一个隐形 checkbox + 一条可点的轨道，避免引入图标资源 */
  .switch {
    flex-shrink: 0;
    position: relative;
    display: inline-block;
    width: 38px;
    height: 20px;
    margin-top: 1px;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    cursor: pointer;
  }
  .track {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: var(--vscode-input-background, rgba(127,127,127,.35));
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(127,127,127,.45)));
    transition: background .14s ease, border-color .14s ease;
    pointer-events: none;
  }
  .track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--vscode-foreground);
    opacity: .55;
    transition: transform .14s ease, opacity .14s ease;
  }
  .switch input:checked + .track {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  .switch input:checked + .track::after {
    transform: translateX(18px);
    background: var(--vscode-button-foreground);
    opacity: 1;
  }
  .switch input:focus-visible + .track {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .switch.busy { pointer-events: none; opacity: .5; }
  .status {
    margin-top: 14px;
    padding-top: 13px;
    border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    font-size: 12px;
    display: flex;
    align-items: baseline;
    gap: 7px;
    line-height: 1.55;
  }
  .status .badge { flex-shrink: 0; }
  .status[data-tone="ok"] { color: var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
  .status[data-tone="warn"] { color: var(--vscode-editorWarning-foreground); }
  .status[data-tone="error"] { color: var(--vscode-errorForeground); }
  .status[data-tone="muted"] { opacity: .7; }
  .detail {
    margin-top: 6px;
    font-size: 12px;
    opacity: .72;
    line-height: 1.6;
    white-space: pre-wrap;
  }
  .error {
    margin-top: 8px;
    font-size: 12px;
    color: var(--vscode-errorForeground);
    white-space: pre-wrap;
    line-height: 1.55;
  }
  .actions {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    font-family: inherit;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    cursor: pointer;
  }
  button:hover:not([disabled]) { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.3)); }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover:not([disabled]) { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button[disabled] { opacity: .4; cursor: default; }
  button.hidden { display: none; }
  /* 「上次检测于 …」：探测太快、结论又常常不变，没有它按钮就像没反应 */
  .checked-at {
    align-self: center;
    font-size: 11px;
    opacity: .55;
    font-variant-numeric: tabular-nums;
  }
  details {
    margin-top: 16px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
    opacity: .7;
    user-select: none;
  }
  summary:hover { opacity: 1; }
  .tech {
    margin-top: 10px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    opacity: .75;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .note {
    margin-top: 16px;
    font-size: 11px;
    opacity: .6;
    line-height: 1.7;
  }
</style>
</head>
<body>
  <h1>对话面板</h1>
  <p class="subtitle">这里的开关会改动 Kiro 自带对话面板的前端产物，改动可随时还原。</p>

  <div class="card">
    <div class="row">
      <label class="switch" id="switchBox">
        <input type="checkbox" id="enabled" aria-describedby="statusLine" />
        <span class="track"></span>
      </label>
      <div class="grow">
        <div class="opt-title">在对话过程中显示耗时</div>
        <div class="opt-desc">
          Kiro 只在一轮结束后才显示 Elapsed time。开启后，AI 还在输出的过程中也会在消息流底部
          实时显示本轮已耗时，一轮结束即交回 Kiro 原生的那一行。
        </div>
      </div>
    </div>

    <div class="status" id="statusLine" data-tone="muted">
      <span class="badge" id="statusBadge">…</span>
      <span id="statusText">正在检测…</span>
    </div>
    <div class="detail" id="statusDetail"></div>
    <div class="error" id="statusError"></div>

    <div class="actions">
      <button id="reload" class="primary hidden" type="button">重载窗口</button>
      <button id="retry" class="hidden" type="button">重试</button>
      <button id="detect" type="button">重新检测</button>
      <span class="checked-at" id="checkedAt"></span>
    </div>
  </div>

  <details id="tech">
    <summary>技术细节</summary>
    <div class="tech" id="techBody"></div>
  </details>

  <p class="note">Kiro 升级会覆盖对话面板产物、抹掉这项改动。开关保持在「开」时，扩展会在下次启动时自动重新写入。</p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $enabled = document.getElementById('enabled');
  const $switchBox = document.getElementById('switchBox');
  const $statusLine = document.getElementById('statusLine');
  const $statusBadge = document.getElementById('statusBadge');
  const $statusText = document.getElementById('statusText');
  const $statusDetail = document.getElementById('statusDetail');
  const $statusError = document.getElementById('statusError');
  const $reload = document.getElementById('reload');
  const $retry = document.getElementById('retry');
  const $detect = document.getElementById('detect');
  const $techBody = document.getElementById('techBody');
  const $checkedAt = document.getElementById('checkedAt');

  ${injectedSettingsScript()}

  /**
   * 忙碌反馈的最短可见时长（毫秒）。
   *
   * 探测与打补丁都是同步的小文件读写，往返常常在 10ms 以内完成——不设下限的话
   * 「按下 → 置忙 → 恢复」在同一帧里走完，用户什么都看不到，会以为按钮没反应。
   * 这不是为了假装在忙，而是让一个真实发生过的动作变得可感知。
   */
  const MIN_BUSY_MS = 420;

  /** 忙碌起始时刻；不忙时为 0。 */
  let busySince = 0;
  /** 因未满最短时长而被推迟的渲染定时器。 */
  let pendingRender = 0;

  /** 忙碌期间锁住开关与按钮，避免连点产生交叉的文件动作。 */
  function setBusy(busy) {
    const on = !!busy;
    $switchBox.classList.toggle('busy', on);
    $enabled.disabled = on;
    $retry.disabled = on;
    $detect.disabled = on;
    $reload.disabled = on;
    // 文案本身就是进度提示：这一行没有图标资源可用，改字比转圈更直白
    $detect.textContent = on ? '检测中…' : '重新检测';
  }

  /** 由前端发起的动作：立刻进入忙碌态，不等宿主回消息（宿主可能比一帧还快）。 */
  function beginAction() {
    if (pendingRender) { clearTimeout(pendingRender); pendingRender = 0; }
    busySince = Date.now();
    setBusy(true);
  }

  /** 时刻 → HH:mm:ss，不走 toLocaleTimeString：各语言环境下宽度一致，不跳动。 */
  function clockText(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 逐入口状态 + dist 路径：只在展开「技术细节」时才有人看，故做成纯文本。 */
  function techText(m) {
    const lines = [];
    lines.push('对话面板目录：' + (m.distDir || '（未找到）'));
    lines.push('注入脚本：' + (m.scriptInstalled ? (m.scriptUpToDate ? '已安装（版本一致）' : '已安装（版本不一致）') : '未安装'));
    const entries = Array.isArray(m.entries) ? m.entries : [];
    if (!entries.length) {
      lines.push('入口：（未找到任何入口文件）');
    } else {
      entries.forEach(function (e) {
        const bits = [];
        bits.push(e.present ? '存在' : '不存在');
        if (e.present) bits.push(e.patched ? '已注入' : '未注入');
        if (e.backedUp) bits.push('有备份');
        lines.push('入口 ' + e.entry + '：' + bits.join(' · '));
      });
    }
    lines.push('状态判定：' + m.state);
    return lines.join('\\n');
  }

  function render(m) {
    $enabled.checked = !!m.enabled;

    const label = turnTimerStatusLabel({
      enabled: !!m.enabled,
      state: m.state,
      detail: m.detail,
      dirty: !!m.dirty,
    });

    $statusLine.dataset.tone = label.tone;
    $statusLine.setAttribute('data-tone', label.tone);
    $statusBadge.textContent = label.badge;
    $statusText.textContent = label.text;
    $statusLine.title = label.title;

    // detail 已经被 label.title 收进 tooltip，但它常常是唯一的行动指引，
    // 所以同时平铺出来——排查时不该依赖悬浮才能看到关键信息。
    $statusDetail.textContent = m.detail || '';
    $statusError.textContent = m.error || '';

    $retry.classList.toggle('hidden', !label.canRetry);
    $reload.classList.toggle('hidden', !label.canReload);
    $techBody.textContent = techText(m);
    $checkedAt.textContent = m.checkedAt ? '上次检测 ' + clockText(m.checkedAt) : '';
  }

  /**
   * 收到状态后落地：忙碌不足最短时长时推迟渲染，让「检测中…」至少闪现一下。
   * 首次加载（未经用户动作，busySince 为 0）不推迟，避免白等。
   */
  function settle(m) {
    const waited = busySince ? Date.now() - busySince : MIN_BUSY_MS;
    const rest = MIN_BUSY_MS - waited;
    const finish = () => {
      pendingRender = 0;
      busySince = 0;
      setBusy(false);
      render(m);
    };
    if (rest <= 0) { finish(); return; }
    if (pendingRender) clearTimeout(pendingRender);
    pendingRender = setTimeout(finish, rest);
  }

  $enabled.addEventListener('change', () => {
    beginAction();
    vscode.postMessage({ type: 'setEnabled', enabled: !!$enabled.checked });
  });
  $retry.addEventListener('click', () => {
    beginAction();
    vscode.postMessage({ type: 'retry' });
  });
  $detect.addEventListener('click', () => {
    beginAction();
    vscode.postMessage({ type: 'detect' });
  });
  $reload.addEventListener('click', () => {
    beginAction();
    vscode.postMessage({ type: 'reloadWindow' });
  });

  window.addEventListener('message', (e) => {
    const m = (e && e.data) || {};
    if (m.type === 'status') {
      settle(m);
    } else if (m.type === 'busy') {
      // 宿主侧的忙碌提示：只用来「进入」忙碌态，退出恒由状态消息经 settle 决定，
      // 否则宿主的 busy(false) 会抢在 settle 之前解锁按钮，最短时长就白设了。
      if (m.busy) { if (!busySince) beginAction(); }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
