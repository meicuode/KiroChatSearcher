import * as vscode from 'vscode';
import { escapeHtml, escapeRegExp, highlight, fmtTime } from './webview/format';

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
  .search-box svg {
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
    </svg>
    <input id="q" type="text" placeholder="搜索当前项目的 Kiro 对话…" autocomplete="off" spellcheck="false" />
  </div>
  <div id="status" class="meta">输入关键词开始搜索…</div>
  <ul id="results" class="results"></ul>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $q = document.getElementById('q');
  const $status = document.getElementById('status');
  const $results = document.getElementById('results');
  let activeIndex = -1;
  let currentResults = [];
  let currentKeyword = '';
  let debounceTimer;

  ${injectedFormatScript()}

  function render(results, keyword) {
    currentResults = results;
    currentKeyword = keyword;
    activeIndex = results.length ? 0 : -1;
    $results.innerHTML = '';
    if (!results.length) {
      if (keyword) {
        $results.innerHTML = '<li class="empty">没有匹配的对话</li>';
      }
      updateActive();
      return;
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const li = document.createElement('li');
      li.className = 'item';
      li.dataset.index = i;
      li.innerHTML =
        '<div class="row1">' +
          '<div class="title">' + highlight(r.title || 'Untitled', keyword) + '</div>' +
          '<div class="time">' + fmtTime(r.modified) + '</div>' +
        '</div>' +
        '<div class="snippet">' + highlight(r.snippet || '', keyword) + '</div>';
      li.addEventListener('click', () => open(i));
      $results.appendChild(li);
    }
    updateActive();
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
    const kw = $q.value;
    debounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'search', keyword: kw });
    }, 120);
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
      vscode.postMessage({ type: 'close' });
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'results') {
      render(m.results, m.keyword);
      if (m.results.length) {
        setStatus('命中 ' + m.results.length + ' 个对话（最多展示 10 条）', false, '');
      } else if (m.keyword) {
        setStatus('没有匹配的对话', false, '');
      } else {
        setStatus('输入关键词开始搜索…', false, '');
      }
    } else if (m.type === 'status') {
      setStatus(m.text, m.error, m.title);
      if (m.error) {
        $results.innerHTML = '';
        currentResults = [];
      }
    } else if (m.type === 'focus') {
      $q.focus();
      $q.select();
    }
  });

  // 初始焦点
  setTimeout(() => $q.focus(), 50);
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
