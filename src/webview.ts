import * as vscode from 'vscode';
import { escapeHtml, escapeRegExp, highlight, fmtTime, usageLabel } from './webview/format';
import { applyAttachmentFilter } from './webview/filter';

/**
 * 把共享的纯函数序列化为内联脚本源码，保证 webview 运行时与单元测试
 * 使用完全相同的实现。
 */
function injectedFormatScript(): string {
  return [
    escapeHtml.toString(),
    escapeRegExp.toString(),
    highlight.toString(),
    fmtTime.toString(),
    usageLabel.toString(),
    applyAttachmentFilter.toString(),
  ].join('\n');
}

export function getWebviewHtml(webview: vscode.Webview, nonce: string): string {
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kiro Chat Search</title>
<style>
  :root {
    --radius: 10px;
    --gap: 10px;
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  body {
    display: flex;
    flex-direction: column;
    padding: 12px 10px;
    gap: var(--gap);
    overflow: hidden;
  }
  .search-box {
    position: relative;
    display: flex;
    align-items: center;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--radius);
    padding: 0 12px;
    height: 38px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .search-box:focus-within {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
  }
  .search-box svg.icon {
    width: 16px;
    height: 16px;
    opacity: .7;
    margin-right: 8px;
    flex-shrink: 0;
  }
  #q {
    flex: 1;
    background: transparent;
    color: inherit;
    border: 0;
    outline: 0;
    font-size: 13px;
    height: 100%;
  }
  .clear-btn {
    flex-shrink: 0;
    display: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 6px;
    border-radius: 50%;
    cursor: pointer;
    opacity: .6;
    transition: opacity .12s ease, background .12s ease;
  }
  .clear-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.2));
  }
  .clear-btn svg { width: 12px; height: 12px; }
  .search-box.has-text .clear-btn { display: inline-flex; }
  .meta {
    font-size: 11px;
    opacity: .65;
    padding: 0 4px;
    line-height: 1.4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: default;
  }
  .meta.error { color: var(--vscode-errorForeground); opacity: 1; }
  .meta code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.1));
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
  }
  .filter-chip {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(127,127,127,.35)));
    background: transparent;
    color: var(--vscode-foreground);
    opacity: .7;
    cursor: pointer;
    user-select: none;
    transition: background .12s ease, opacity .12s ease, border-color .12s ease;
  }
  .filter-chip:hover { opacity: 1; }
  .filter-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
    opacity: 1;
  }
  .refresh-btn {
    margin-left: auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    cursor: pointer;
    opacity: .65;
    transition: opacity .12s ease, background .12s ease;
  }
  .refresh-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.2));
  }
  .refresh-btn svg { width: 15px; height: 15px; }
  .refresh-btn.spinning { opacity: 1; pointer-events: none; }
  .refresh-btn.spinning svg { animation: kcs-spin .7s linear infinite; }
  @keyframes kcs-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .results {
    flex: 1;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .results::-webkit-scrollbar { width: 8px; }
  .results::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }
  .results::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
  }
  .item {
    padding: 9px 11px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
    background: var(--vscode-list-inactiveSelectionBackground, transparent);
    transition: background .12s ease, border-color .12s ease;
  }
  .item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-color: var(--vscode-focusBorder);
  }
  .item .row1 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .title {
    font-weight: 600;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .time {
    font-size: 11px;
    opacity: .6;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
  }
  .badge {
    font-size: 11px;
    margin-right: 2px;
    opacity: .85;
  }
  .badge.usage {
    font-variant-numeric: tabular-nums;
    background: var(--vscode-badge-background, rgba(127,127,127,.18));
    color: var(--vscode-badge-foreground, inherit);
    border-radius: 6px;
    padding: 0 6px;
    height: 17px;
    margin-right: 6px;
    opacity: .9;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .badge.usage svg {
    width: 12px;
    height: 12px;
    display: block;
    flex-shrink: 0;
  }
  .badge.usage .usage-val {
    line-height: 1;
    display: block;
  }
  .snippet {
    font-size: 12px;
    opacity: .8;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  mark {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,.4));
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .empty {
    text-align: center;
    padding: 24px 8px;
    opacity: .6;
    font-size: 12px;
  }
  kbd {
    background: var(--vscode-keybindingLabel-background);
    color: var(--vscode-keybindingLabel-foreground);
    border: 1px solid var(--vscode-keybindingLabel-border, transparent);
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 0 4px;
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
  }
</style>
</head>
<body>
  <div class="search-box">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
    </svg>
    <input id="q" type="text" placeholder="搜索当前项目的 Kiro 对话…" autocomplete="off" spellcheck="false" />
    <span id="clear" class="clear-btn" title="清空（Esc）" role="button" aria-label="清空">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M5 5l14 14M19 5L5 19"/>
      </svg>
    </span>
  </div>
  <div id="status" class="meta">输入关键词开始搜索…</div>
  <div class="filters">
    <span class="filter-chip active" data-mode="all">全部</span>
    <span class="filter-chip" data-mode="image">🖼 含图片</span>
    <span class="filter-chip" data-mode="attachment">📎 含附件</span>
    <span id="refresh" class="refresh-btn" title="刷新（重新统计最新结果与积分消耗）" role="button" aria-label="刷新">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
      </svg>
    </span>
  </div>
  <ul id="results" class="results"></ul>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $q = document.getElementById('q');
  const $status = document.getElementById('status');
  const $results = document.getElementById('results');
  const $filters = document.querySelectorAll('.filter-chip');
  const $clear = document.getElementById('clear');
  const $refresh = document.getElementById('refresh');
  const $searchBox = document.querySelector('.search-box');
  let activeIndex = -1;
  let rawResults = [];        // Host 推送的原始结果（未过滤）
  let currentResults = [];    // 当前展示的结果（已应用 AttachmentFilter）
  let currentKeyword = '';
  let filterMode = 'all';
  let debounceTimer;

  ${injectedFormatScript()}

  /** 同步清空按钮显隐：输入框有内容时才显示 */
  function syncClearVisibility() {
    if ($q.value) $searchBox.classList.add('has-text');
    else $searchBox.classList.remove('has-text');
  }

  /** 清空输入框并立即回到“最近列表” */
  function clearInput() {
    $q.value = '';
    syncClearVisibility();
    clearTimeout(debounceTimer);
    vscode.postMessage({ type: 'search', keyword: '' });
    $q.focus();
  }

  /** 在原始结果上应用当前附件过滤，并刷新列表与状态条 */
  function applyAndRender() {
    const filtered = applyAttachmentFilter(rawResults, filterMode);
    renderList(filtered, currentKeyword);
    updateStatus();
  }

  function renderList(results, keyword) {
    // 重渲染前记住当前选中项的 sessionId，渲染后尽量保持选中（数据刷新/过滤时不跳回第一项）
    const prevId = (activeIndex >= 0 && currentResults[activeIndex])
      ? currentResults[activeIndex].sessionId
      : null;

    currentResults = results;
    $results.innerHTML = '';
    if (!results.length) {
      activeIndex = -1;
      updateActive();
      return;
    }
    // 还原选中位置：优先沿用之前选中的会话，找不到则回到第一项
    let restored = -1;
    if (prevId) {
      for (let i = 0; i < results.length; i++) {
        if (results[i].sessionId === prevId) { restored = i; break; }
      }
    }
    activeIndex = restored >= 0 ? restored : 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.index = i;
      const badges =
        (r.hasImage ? '<span class="badge" title="含图片">🖼 </span>' : '') +
        (r.hasAttachment ? '<span class="badge" title="含附件">📎 </span>' : '');
      const usage = usageLabel(r.credits, r.contextPercentage);
      let usageBadge = '';
      if (usage) {
        const icon = usage.kind === 'credit'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>';
        usageBadge =
          '<span class="badge usage" title="' + escapeHtml(usage.title) + '">' +
            icon + '<span class="usage-val">' + escapeHtml(usage.value) + '</span>' +
          '</span>';
      }
      li.innerHTML =
        '<div class="row1">' +
          '<div class="title">' + highlight(r.title || 'Untitled', keyword) + '</div>' +
          '<div class="time">' + usageBadge + badges + fmtTime(r.modified) + '</div>' +
        '</div>' +
        '<div class="snippet">' + highlight(r.snippet || '', keyword) + '</div>';
      li.addEventListener('click', () => { activeIndex = i; updateActive(); open(i); });
      $results.appendChild(li);
    }
    updateActive();
  }

  /** 根据关键词 / 过滤模式 / 结果数量给出状态条文案 */
  function updateStatus() {
    const n = currentResults.length;
    const filtering = filterMode !== 'all';
    if (currentKeyword) {
      if (n) {
        setStatus('命中 ' + n + ' 个对话' + (filtering ? '（已按附件过滤）' : '（最多展示 10 条）'), false, '');
      } else {
        setStatus(filtering ? '没有符合条件的对话' : '没有匹配的对话', false, '');
      }
    } else {
      if (n) {
        setStatus('最近 ' + n + ' 个对话' + (filtering ? '（已按附件过滤）' : ' · 输入关键词可搜索'), false, '');
      } else {
        setStatus(filtering ? '没有符合条件的对话' : '当前项目还没有对话历史', false, '');
      }
    }
  }

  function updateActive() {
    [...$results.children].forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex && el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function open(i) {
    const r = currentResults[i];
    if (!r) return;
    vscode.postMessage({ type: 'open', sessionId: r.sessionId });
  }

  function setStatus(text, isError, title) {
    $status.textContent = text;
    $status.classList.toggle('error', !!isError);
    if (typeof title === 'string') {
      if (title) $status.title = title; else $status.removeAttribute('title');
    }
  }

  $q.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    syncClearVisibility();
    const kw = $q.value;
    debounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'search', keyword: kw });
    }, 120);
  });

  $clear.addEventListener('click', clearInput);

  // 硬刷新：请求 host 按当前关键词重新取数（底层按 mtime/size 失效校验磁盘，
  // 已能反映最新对话与 credit 统计，无需清缓存）。
  $refresh.addEventListener('click', () => {
    $refresh.classList.add('spinning');
    vscode.postMessage({ type: 'hardRefresh' });
  });

  $q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentResults.length) {
        activeIndex = (activeIndex + 1) % currentResults.length;
        updateActive();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentResults.length) {
        activeIndex = (activeIndex - 1 + currentResults.length) % currentResults.length;
        updateActive();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) open(activeIndex);
    } else if (e.key === 'Escape') {
      // 有内容先清空（不关面板）；已为空再请求关闭
      if ($q.value) {
        e.preventDefault();
        clearInput();
      } else {
        vscode.postMessage({ type: 'close' });
      }
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'results') {
      rawResults = m.results || [];
      currentKeyword = m.keyword || '';
      applyAndRender();
      $refresh.classList.remove('spinning');
    } else if (m.type === 'status') {
      setStatus(m.text, m.error, m.title);
      if (m.error) {
        $results.innerHTML = '';
        rawResults = [];
        currentResults = [];
      }
      $refresh.classList.remove('spinning');
    } else if (m.type === 'focus') {
      $q.focus();
      $q.select();
    }
  });

  // 附件过滤 chip 切换：先即时在现有数据上过滤（即时反馈），
  // 同时请求 host 重新取最新数据（revalidate），到货后会再渲染一次，
  // 确保过滤作用在最新的会话列表上（含面板打开后新增的对话）。
  $filters.forEach((chip) => {
    chip.addEventListener('click', () => {
      const mode = chip.dataset.mode || 'all';
      if (mode === filterMode) return;
      filterMode = mode;
      $filters.forEach((c) => c.classList.toggle('active', c === chip));
      applyAndRender();
      vscode.postMessage({ type: 'revalidate' });
    });
  });

  // 初始焦点
  setTimeout(() => $q.focus(), 50);
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
