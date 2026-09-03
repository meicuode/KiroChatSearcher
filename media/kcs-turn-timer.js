/*
 * kcs-turn-timer.js — 给 Kiro 对话面板补一个「本轮实时耗时」。
 *
 * 运行位置：Kiro 的 agent chat **webview 内部**（不是扩展宿主）。
 * 由 `dist/session-view/main.js` / `dist/standalone/main.js` 末尾追加的
 * `import "../kcs-turn-timer.js"` 拉起，因此本文件是 ES module，且在
 * 宿主 bundle 的模块体之前求值（import 会被提升）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * Kiro 自带的 PromptTurnFooter 已经会渲染 "Elapsed time: 1m 23s"，
 * 但那是**轮结束之后**才出现的（数据来自 messages.jsonl 里的
 * `usage_summary.elapsedTime`）。AI 还在输出时没有任何耗时显示。
 * 本脚本补的正是这段空窗：轮进行中每 200ms 刷新一次已耗时，
 * 轮一结束就把自己摘掉，让 Kiro 原生的 footer 接管。
 *
 * ── 怎么知道「一轮」的起止 ─────────────────────────────────────
 * 不去猜 DOM、不碰 React 内部状态，而是**监听 webview ↔ 扩展的 RPC**：
 *
 *   发出：{type:'request', id, key:'prompt',  params:[{sessionId, prompt}]}
 *   收到：{type:'response'|'error', id, key, value}
 *
 * `prompt` 这个 RPC 是长活的——扩展侧 `eD()` 直接 return ACP 的
 * `client.prompt(...)`，它在**整轮结束**（stopReason 产生）时才 resolve；
 * 宿主 bundle 自己也是 `setAgentActive(true)` → `await e("prompt", …)` →
 * `finally { setAgentActive(false) }` 这个结构。所以「请求发出」= 轮开始，
 * 「响应回来」= 轮结束，精度等同于 Kiro 自己的 agentActive 状态，
 * 且完全不依赖 minified 代码里的任何符号名。
 *
 * 中途 steer（`steerPrompt`）不算新的一轮，计时不重置——它就该被算进本轮。
 * 用户点停止（`cancelPrompt`）也无需特殊处理：`prompt` 依然会 resolve。
 *
 * ── 已知边界 ──────────────────────────────────────────────────
 * - 面板在轮进行中被重建（切会话回来 / reload window）时，那次 `prompt`
 *   的请求不是本 webview 发的，起始时间无从得知，此时不显示计时（不猜）。
 * - standalone 窗口里多个会话并行跑时，只显示最早开始的那一轮。
 */

(() => {
  'use strict';

  // 同一 webview 里重复注入（例如 main.js 被打了两次补丁）只生效一次。
  if (window.__kcsTurnTimerInstalled) return;
  window.__kcsTurnTimerInstalled = true;

  const MARK = 'kcs-live-turn';
  const TICK_MS = 200;

  /**
   * 对外可见的诊断快照，挂在 `window.__kcsTurnTimer` 上。
   *
   * 存在的意义：这段脚本跑在别人的 webview 里，出问题时**从扩展侧看不到任何东西**
   * （控制台不落盘、拿不到 DOM）。有了它，排查就是在 webview devtools 里敲一行
   * `__kcsTurnTimer`——立刻知道钩子挂上了没、跑过几轮、锚点是行内还是浮动兜底。
   */
  const diag = {
    version: 2,
    /** 消息钩子是否已装上（false 则实时耗时一定不会出现）。 */
    hooked: false,
    /** 钩子装不上的原因。 */
    hookError: '',
    /** 观测到的轮次数（每次 `prompt` 请求 +1）。 */
    turns: 0,
    /** 当前渲染位置：`inline`（消息流末尾）/ `floating`（右下角兜底）/ `none`。 */
    anchor: 'none',
    /** 正在跑的轮数。 */
    get running() {
      return inFlight.size;
    },
  };
  window.__kcsTurnTimer = diag;

  /** 在途 `prompt` RPC：requestId -> 开始时刻(ms)。非空即「本轮进行中」。 */
  const inFlight = new Map();

  let row = null; // 我们插入的那一行 DOM
  let label = null; // 行内的文字节点容器
  let ticker = null; // setInterval 句柄
  let reanchor = null; // MutationObserver：被 React 推到中间时重新贴到末尾
  let warnedFloating = false; // 兜底位置的告警只打一次，不刷控制台

  /* ------------------------------------------------------------------ *
   * 时长格式化：与 Kiro 自带 PromptTurnFooter 的 formatDuration 同规则
   * （"1h 2m 3s"，各段为 0 时省略，全为 0 时显示 "0s"），
   * 这样进行中和结束后的文字风格一致，不会有割裂感。
   * ------------------------------------------------------------------ */
  function formatDuration(ms) {
    const total = ms < 0 ? 0 : ms;
    const s = Math.floor(total / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m % 60 > 0) parts.push(`${m % 60}m`);
    if (s % 60 > 0 || parts.length === 0) parts.push(`${s % 60}s`);
    return parts.join(' ');
  }

  /** 本轮开始时刻 = 所有在途 prompt 里最早的那个。 */
  function turnStartedAt() {
    let earliest = Infinity;
    for (const t of inFlight.values()) if (t < earliest) earliest = t;
    return earliest;
  }

  /* ------------------------------------------------------------------ *
   * 样式：走 Kiro 自己的 CSS 变量与 footer 类名，只补一个「在跑」的呼吸动画。
   * webview 的 CSP 是 `style-src <cspSource> 'unsafe-inline'`，
   * 内联 <style> 是允许的，所以不必去改 dist/style.css（少改一个文件，
   * 卸载时也少一处要还原）。
   * ------------------------------------------------------------------ */
  function installStyle() {
    if (document.getElementById('kcs-turn-timer-style')) return;
    const style = document.createElement('style');
    style.id = 'kcs-turn-timer-style';
    style.textContent = `
      .${MARK} { animation: kcs-turn-pulse 1.6s ease-in-out infinite; }
      .${MARK} .kcs-dot {
        display: inline-block;
        width: 6px; height: 6px;
        margin-inline-end: 6px;
        border-radius: 50%;
        background: currentColor;
        vertical-align: baseline;
      }
      /* 兜底位置：找不到消息流容器时浮在右下角，宁可位置不理想也不要「看不见」 */
      .${MARK}.${MARK}--floating {
        position: fixed;
        right: 14px;
        bottom: 76px;
        z-index: 2147483000;
        padding: 3px 9px;
        border-radius: 999px;
        pointer-events: none;
        background: var(--vscode-editorWidget-background, rgba(30,30,30,.92));
        border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
        color: var(--vscode-descriptionForeground, inherit);
        font-size: 11px;
      }
      @keyframes kcs-turn-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
      @media (prefers-reduced-motion: reduce) {
        .${MARK} { animation: none; opacity: .8 }
      }
    `;
    (document.head ?? document.documentElement).appendChild(style);
  }

  /**
   * 找计时行该挂到哪：会话消息流的滚动容器 `.session-view-content`。
   *
   * 一个 webview 里可能同时挂着多个会话视图（侧边栏的 `session-manager` 会为每个
   * 打开的会话各挂一份），只有当前会话那个是可见的，用 `offsetParent` 过滤掉隐藏的；
   * 都不可见时退回最后一个。
   *
   * **已知取舍**：Kiro 的 DOM 里没有任何带 sessionId 的标记（既无 `data-session-*`
   * 也无 id），所以无法把容器与会话对应起来。多会话并行跑时，计时行会出现在**当前
   * 可见**的那个会话的消息流底部，而不一定是正在跑的那个。单会话（绝大多数情形）无此问题。
   *
   * @returns 命中的容器；一个都没找到时返回 `null`（此时走 body 兜底）。
   */
  function findHost() {
    const all = document.querySelectorAll('.session-view-content');
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].offsetParent !== null) return all[i];
    }
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /**
   * 保证计时行存在、且是 host 的最后一个子节点。
   *
   * 复用 Kiro footer 的类名 `kiro-turn-usage-summary` / `-left` / `-item`，
   * 所以间距、字号、颜色都跟原生那行一模一样，不引入新的视觉规范。
   */
  function ensureRow() {
    // 容器找不到就退到 body 上浮动显示：Kiro 改版换了类名时，症状应该是「位置怪」
    // 而不是「彻底消失」——后者会让人误以为补丁没生效，无从下手排查。
    const host = findHost() ?? document.body ?? null;
    if (!host) return null;
    const floating = host === document.body;
    if (floating && !warnedFloating) {
      warnedFloating = true;
      console.warn(
        '[kcs-turn-timer] 找不到 .session-view-content，计时行改为浮动显示。' +
          'Kiro 对话面板的 DOM 结构可能变了，锚点需要更新。'
      );
    }

    if (!row) {
      row = document.createElement('div');
      row.className = `kiro-turn-usage-summary ${MARK}`;
      row.dataset.kcsLiveTurn = '1';

      const left = document.createElement('div');
      left.className = 'kiro-turn-usage-summary-left';

      label = document.createElement('span');
      label.className = 'kiro-turn-usage-summary-item';

      const dot = document.createElement('span');
      dot.className = 'kcs-dot';
      label.appendChild(dot);
      label.appendChild(document.createTextNode(''));

      left.appendChild(label);
      row.appendChild(left);
    }

    // 浮动兜底与行内两种形态的样式不同；容器可能在同一轮里出现（面板刚挂载完），
    // 所以每次都同步一次这个类，而不是只在创建时定死。
    if (row.classList) row.classList.toggle(`${MARK}--floating`, floating);
    diag.anchor = floating ? 'floating' : 'inline';

    // React 只操作它自己创建的节点，不会删掉我们这个外来子节点；
    // 但它**可能**在我们后面再插入新节点，所以每次都重新贴到末尾。
    if (host.lastElementChild !== row) host.appendChild(row);

    if (!reanchor) {
      // 重锚也走 ensureRow：会话视图挂载完成后，浮动兜底要能自动升级成行内显示。
      reanchor = new MutationObserver(() => {
        if (inFlight.size === 0 || !row) return;
        ensureRow();
      });
      reanchor.observe(document.body, { childList: true, subtree: true });
    }
    return row;
  }

  function removeRow() {
    if (reanchor) {
      reanchor.disconnect();
      reanchor = null;
    }
    if (row && row.parentElement) row.parentElement.removeChild(row);
    diag.anchor = 'none';
  }

  function paint() {
    if (inFlight.size === 0) return;
    const startedAt = turnStartedAt();
    if (!Number.isFinite(startedAt)) return;
    const node = ensureRow();
    if (!node || !label) return;
    label.lastChild.nodeValue = `Elapsed time: ${formatDuration(Date.now() - startedAt)}`;
  }

  function startTicking() {
    installStyle();
    paint();
    if (ticker === null) ticker = window.setInterval(paint, TICK_MS);
  }

  function stopTicking() {
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
    removeRow();
  }

  /* ------------------------------------------------------------------ *
   * 出向：认出 `prompt` 请求 = 轮开始
   *
   * ── 为什么是「替换 window.vscode」而不是「包一层 postMessage」 ──────────
   *
   * `acquireVsCodeApi()` 返回的是 **`Object.freeze({postMessage,setState,getState})`**
   * （见 vscode 的 webview preload：`return Object.freeze({...})`）。所以
   * `window.vscode.postMessage = wrapper` 在严格模式下直接抛 TypeError、非严格模式下
   * 静默失败——两种都装不上钩子。这个坑很隐蔽：代码看着对、不报错、就是不工作。
   *
   * `window.vscode` 本身只是 HTML 内联脚本赋的一个普通全局属性（可写），因此改成
   * **整体替换成一个转发用的 shim**。三个入口的 bundle 都是
   * `n => window.vscode.postMessage(n)` ——**调用时**才读 `window.vscode`，
   * 而本模块作为 import 会在宿主 bundle 的模块体之前求值，所以它们看到的就是 shim。
   *
   * shim 逐个转发原对象的成员（`postMessage` / `setState` / `getState`），
   * 参数用 `...args` 原样透传（`postMessage(message, transfer)` 有第二个参数），
   * 观测代码整体包在 try 里——**绝不能因为统计耗时而影响真正的消息投递**。
   * ------------------------------------------------------------------ */

  /** 观测一条出向消息；只认 `prompt` 请求，其余一律放过。 */
  function observeOutgoing(message) {
    try {
      if (
        message &&
        typeof message === 'object' &&
        message.type === 'request' &&
        message.key === 'prompt' &&
        typeof message.id === 'string'
      ) {
        inFlight.set(message.id, Date.now());
        diag.turns += 1;
        startTicking();
      }
    } catch {
      // 观测失败绝不能影响真正的消息投递
    }
  }

  function installHook() {
    const original = window.vscode;
    if (!original || typeof original.postMessage !== 'function') {
      diag.hookError = 'window.vscode 尚不可用';
      return false;
    }
    if (original.__kcsShim) {
      diag.hooked = true;
      return true;
    }

    const shim = {};
    for (const key of Object.keys(original)) {
      const value = original[key];
      shim[key] = typeof value === 'function' ? value.bind(original) : value;
    }
    const forward = original.postMessage.bind(original);
    shim.postMessage = function (...args) {
      observeOutgoing(args[0]);
      return forward(...args);
    };
    shim.__kcsShim = true;

    try {
      window.vscode = shim;
    } catch (e) {
      diag.hookError = 'window.vscode 不可替换：' + (e && e.message ? e.message : String(e));
      return false;
    }
    if (window.vscode !== shim) {
      diag.hookError = 'window.vscode 替换后未生效（属性可能是只读的）';
      return false;
    }
    diag.hooked = true;
    diag.hookError = '';
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 入向：response / error 落到在途 id 上 = 轮结束
   * ------------------------------------------------------------------ */
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'response' && data.type !== 'error') return;
    if (typeof data.id !== 'string' || !inFlight.has(data.id)) return;
    inFlight.delete(data.id);
    if (inFlight.size === 0) stopTicking();
  });

  // `window.vscode` 由 HTML 里的内联脚本先建好（module script 是 defer 的，一定在其后
  // 执行），正常情况下这里一次就挂上；万一时序变了（宿主改成延迟创建），退化成短暂
  // 轮询，最多试 50 次（5 秒）。
  if (installHook()) {
    console.info('[kcs-turn-timer] 已就绪（对话进行中会显示本轮耗时）。诊断：window.__kcsTurnTimer');
  } else {
    let tries = 0;
    const retry = window.setInterval(() => {
      if (installHook()) {
        window.clearInterval(retry);
        console.info('[kcs-turn-timer] 已就绪（延迟挂载）。诊断：window.__kcsTurnTimer');
        return;
      }
      if (++tries > 50) {
        window.clearInterval(retry);
        // 挂不上就是彻底不工作，必须喊出来：否则症状是「什么都没发生」，无从排查
        console.error(
          '[kcs-turn-timer] 未能挂上消息钩子，实时耗时不会显示。原因：' + diag.hookError
        );
      }
    }, 100);
  }
})();
