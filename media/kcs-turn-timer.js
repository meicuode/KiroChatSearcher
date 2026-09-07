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
 *
 * ── 点「停止」时那个 prompt 请求永远不会有响应 ─────────────────
 *
 * 这是本脚本 v2 的一个真实 bug（症状：中断后重新提问，新一轮跑完了计时还在涨）。
 * Kiro 的停止按钮做的是：
 *
 *     u.getState().cancelActivePrompt?.();   // 就地放弃自己那个 pending promise
 *     c("cancelPrompt", sessionId);          // 通知扩展去 cancel
 *     …随后（如果是「中断并重新提问」）await c("prompt", {…}) 开新一轮
 *
 * 关键在 `cancelActivePrompt()`：Kiro **不等**被取消的那次 `prompt` 回响应，
 * 而是本地把 promise 了结掉。于是那个 requestId 的 `response` / `error`
 * **永远不会到达 webview**。Kiro 自己不受影响，因为它的 `isAgentActive` 是个
 * 布尔量、由**最新**那一轮覆盖写；而 v2 用的是「所有在途请求都清空才收工」，
 * 一个永远收不到响应的请求就把计时永久钉死，还因为取「最早」的开始时刻，
 * 显示的是被取消那一轮的起点（可以涨到好几个小时）。
 *
 * v3 因此改成和 Kiro 同构的模型：
 *   1. **按 sessionId 记账，新的一轮顶掉旧的**——同一会话不可能有两轮并行，
 *      所以只要该会话又发了 `prompt`，先前那条无论结局如何都已作废。
 *   2. **`cancelPrompt` 当作该会话的轮结束**——这正是 Kiro 自己用的信号
 *      （紧跟着就是 `executionAborted` + `status:"aborted"`），也是唯一能
 *      在「响应永远不来」时正确收工的时机。
 *
 * ── 计时行显示在哪：一轮一行，且只在它自己的会话里 ─────────────
 *
 * v2/v3 是**全局一行**，挂在「当前可见」的那个 `.session-view-content` 末尾。
 * 侧边栏的 `session-manager` 会为每个打开的会话各挂一份会话视图（只有当前那个
 * 可见），于是出现了第二个 bug：会话 A 在跑，切到没有任何活动的会话 B，
 * A 的计时行会跟着显示在 B 的消息流底部（「串台」）。
 *
 * v4 改成**一轮一行**，每行只出现在它自己那个会话视图的子树里。会话归属在
 * **发出 `prompt` 的那一刻**确定：那一刻正在可见的会话视图，必然就是用户刚敲下
 * 回车的那个。此后这一行只认捕获到的那棵子树，不再跟着「当前可见」跑。
 * 于是没有活动的会话什么都不显示，并行跑的多个会话各显示自己的耗时。
 *
 * 位置优先级（同一轮内可以升级，但不会从 bar 退回消息流）：
 *   1. **`.agent-interaction-panel-bottom-bar`** —— 就是对话框上方那条
 *      "Working. … Cancel" 的横条。它是 Kiro 自己的 `AgentInteractionPanel`，
 *      `!children && !actions` 时整个组件返回 `null`，因此**它存在就等于这个会话
 *      有活动的轮**，天然一个会话一条，是最贴切的落点。
 *   2. 捕获到的那个 `.session-view-content` 末尾（Kiro 换了横条的类名时退到这里，
 *      仍然是**该会话自己的**消息流，不会串台）。
 *   3. 右下角浮动（连会话视图都没找到时的最后兜底，宁可位置怪也不要看不见）。
 *
 * ── 已知边界 ──────────────────────────────────────────────────
 * - 面板在轮进行中被重建（切会话回来 / reload window）时，那次 `prompt`
 *   的请求不是本 webview 发的，起始时间无从得知，此时不显示计时（不猜）。
 * - 捕获到的会话视图被卸载（关掉那个会话）后不再显示该轮的计时：宁可不显示，
 *   也不要退回「当前可见」——那正是串台的来源。
 */

(() => {
  'use strict';

  // 同一 webview 里重复注入（例如 main.js 被打了两次补丁）只生效一次。
  if (window.__kcsTurnTimerInstalled) return;
  window.__kcsTurnTimerInstalled = true;

  const MARK = 'kcs-live-turn';
  const TICK_MS = 200;

  /** Kiro 那条 "Working. … Cancel" 横条的容器类名。 */
  const BAR_SELECTOR = '.agent-interaction-panel-bottom-bar';
  /** 会话消息流（滚动容器）的类名。 */
  const CONTENT_SELECTOR = '.session-view-content';
  /** 会话视图输入区的类名，用来把消息流上溯到「会话视图根」。 */
  const INPUT_SELECTOR = '.session-view-input';

  /**
   * 等 Kiro 渲染出 "Working" 横条的宽限期（毫秒）。
   *
   * 我们观测到 `prompt` 的那一刻是**同步**发生在 React 重渲染之前的，横条还不存在。
   * 这段时间内先什么都不显示，而不是立刻落到消息流末尾——否则一行会先出现在消息流里，
   * 200ms 后又跳进横条，看着像闪了一下。等过了宽限期还没有横条，才认为这个 Kiro
   * 版本没有它，退到消息流末尾。
   */
  const BAR_GRACE_MS = 800;

  /**
   * 对外可见的诊断快照，挂在 `window.__kcsTurnTimer` 上。
   *
   * 存在的意义：这段脚本跑在别人的 webview 里，出问题时**从扩展侧看不到任何东西**
   * （控制台不落盘、拿不到 DOM）。有了它，排查就是在 webview devtools 里敲一行
   * `__kcsTurnTimer`——立刻知道钩子挂上了没、跑过几轮、每一行落在哪。
   */
  const diag = {
    version: 4,
    /** 消息钩子是否已装上（false 则实时耗时一定不会出现）。 */
    hooked: false,
    /** 钩子装不上的原因。 */
    hookError: '',
    /** 观测到的轮次数（每次 `prompt` 请求 +1）。 */
    turns: 0,
    /** 被「停止」结束掉的轮次数。 */
    cancels: 0,
    /** 因同一会话又开新一轮而被顶掉的在途记录数（正常应为 0 或很小）。 */
    superseded: 0,
    /** 当前各行的落点：`bar` / `inline` / `floating` / `waiting` / `detached`。 */
    anchors: [],
    /** 正在跑的轮数。 */
    get running() {
      return turns.size;
    },
    /** 正在跑的会话 id（排查「计时是哪个会话的」时看这个）。 */
    get sessions() {
      return [...turns.keys()];
    },
  };
  window.__kcsTurnTimer = diag;

  /**
   * 在途的轮：sessionId -> 轮记录。非空即「有轮在跑」。
   *
   * 每条记录：
   *   `id`        对应的 prompt requestId
   *   `startedAt` 开始时刻(ms)
   *   `content`   发起时可见的 `.session-view-content`（该会话的消息流）
   *   `root`      该会话的会话视图根（含输入区的那个祖先）
   *   `row/label` 这一轮自己的那行 DOM（按落点形态创建）
   *   `mode`      当前落点形态，用于形态变化时重建 DOM
   *
   * 按 **sessionId** 而不是 requestId 记账，是修 v2 那个 bug 的核心：同一会话不可能
   * 有两轮并行，所以「该会话又发了 prompt」本身就是「上一条已作废」的确证——
   * 不必依赖那条记录能否等到自己的响应（被取消的那条等不到，见文件头）。
   */
  const turns = new Map();

  /** requestId -> sessionId 反查表，响应回来时用它定位该清哪一条。 */
  const byRequest = new Map();

  let ticker = null; // setInterval 句柄
  let warnedFloating = false; // 兜底位置的告警只打一次，不刷控制台

  /* ------------------------------------------------------------------ *
   * 1. 轮次记账
   * ------------------------------------------------------------------ */

  /** 开一轮：同会话的旧记录直接顶掉（连带它的反查项与那行 DOM）。 */
  function startTurn(sessionKey, requestId) {
    const prev = turns.get(sessionKey);
    if (prev) {
      byRequest.delete(prev.id);
      detachRow(prev);
      diag.superseded += 1;
    }
    const spot = captureAnchor();
    turns.set(sessionKey, {
      id: requestId,
      startedAt: Date.now(),
      content: spot.content,
      root: spot.root,
      row: null,
      label: null,
      mode: 'waiting',
    });
    byRequest.set(requestId, sessionKey);
  }

  /** 结束一条轮记录（摘掉它那行 DOM 并清干净两张表）。 */
  function dropTurn(sessionKey) {
    const turn = turns.get(sessionKey);
    if (!turn) return false;
    byRequest.delete(turn.id);
    detachRow(turn);
    turns.delete(sessionKey);
    return true;
  }

  /** 按 requestId 结束一轮（正常收尾：响应/错误回来了）。 */
  function endTurnByRequest(requestId) {
    const sessionKey = byRequest.get(requestId);
    if (sessionKey === undefined) return false;
    return dropTurn(sessionKey);
  }

  /**
   * 只有一轮在跑时把它结束掉。
   *
   * 给 `cancelPrompt` 拿不到 sessionId 的情形兜底（参数形状被 Kiro 改过）：
   * 单会话是绝大多数情形，此时「唯一那一轮」必然就是被停止的那一轮。
   * 多轮并行时宁可不动——猜错会把别的会话的计时掐掉。
   */
  function endOnlyTurn() {
    if (turns.size !== 1) return false;
    return dropTurn([...turns.keys()][0]);
  }

  /**
   * 从 RPC 参数里取 sessionId。两种形状都要认：
   * - `prompt` → `params[0] = { sessionId, prompt }`
   * - `cancelPrompt` → `params[0] = sessionId`（裸字符串）
   */
  function sessionIdOf(params) {
    const first = Array.isArray(params) && params.length > 0 ? params[0] : undefined;
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && typeof first.sessionId === 'string') {
      return first.sessionId;
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 2. 会话归属：发出 prompt 的那一刻把会话视图记下来
   * ------------------------------------------------------------------ */

  /** 元素是否还挂在文档里（会话被关掉后它的子树会整棵摘走）。 */
  function isAttached(el) {
    let cur = el;
    while (cur) {
      if (cur === document.body || cur === document.documentElement) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /**
   * 当前可见的那个 `.session-view-content`。
   *
   * 一个 webview 里可能同时挂着多个会话视图（`session-manager` 为每个打开的会话各挂
   * 一份），只有当前会话那个是可见的，用 `offsetParent` 过滤掉隐藏的。
   * 都不可见时退回最后一个（比什么都不给要好）。
   */
  function visibleContent() {
    const all = document.querySelectorAll(CONTENT_SELECTOR);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].offsetParent !== null) return all[i];
    }
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /**
   * 从消息流上溯到「会话视图根」：最近的、**同时含有输入区**的那个祖先。
   *
   * 用「含有输入区」而不是写死层数，是因为层级是 minified 产物的实现细节；
   * 而「消息流和输入框属于同一个会话视图」这件事是结构性的，不会随改版轻易变。
   * 找到根之后，那条 "Working" 横条就在这棵子树里，与别的会话不会混。
   */
  function sessionRootOf(content) {
    let el = content ? content.parentElement : null;
    for (let i = 0; i < 6 && el; i++) {
      if (typeof el.querySelector === 'function' && el.querySelector(INPUT_SELECTOR)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** 发起时刻的会话归属快照。 */
  function captureAnchor() {
    const content = visibleContent();
    return { content: content || null, root: content ? sessionRootOf(content) : null };
  }

  /* ------------------------------------------------------------------ *
   * 3. 落点决策
   * ------------------------------------------------------------------ */

  /**
   * 这一轮的计时该放哪。
   *
   * 返回 `{ target, mode }`；`mode === 'waiting'` 表示这一刻先别显示
   * （还在等横条渲染出来）；返回 `null` 表示该轮的会话视图已经不在了，
   * **不显示**——退回「当前可见」就是串台的来源，所以这里宁可不显示。
   */
  function anchorFor(turn, now) {
    const root = turn.root && isAttached(turn.root) ? turn.root : null;
    const content = turn.content && isAttached(turn.content) ? turn.content : null;

    // 捕获过会话视图、但它已经不在文档里 ⇒ 那个会话被关掉了，这一轮不会再有落点。
    // 这一步必须在别的判断**之前**：否则「已经进了横条」那条会把它误报成 waiting，
    // 而 waiting 是「等一下就好」的意思，掩盖了「永远不会再显示」这个事实。
    if ((turn.root || turn.content) && !root && !content) return null;

    // 1. 该会话自己的 "Working …" 横条
    const bar = findBar(root);
    if (bar) return { target: bar.firstElementChild || bar, mode: 'bar' };

    // 已经进了横条又找不到它了 ⇒ 这一轮正在收尾，不要再跳回消息流闪一下
    if (turn.mode === 'bar') return { target: null, mode: 'waiting' };

    // 2. 还在宽限期内就等一等，避免「先落消息流、再跳进横条」的闪动
    if ((root || content) && now - turn.startedAt < BAR_GRACE_MS) {
      return { target: null, mode: 'waiting' };
    }

    // 3. 退到该会话自己的消息流末尾（注意用捕获到的那个，不是当前可见的那个）
    if (content) return { target: content, mode: 'inline' };

    // 4. 连会话视图都没捕获到：右下角浮动，宁可位置怪也不要看不见
    if (!turn.root && !turn.content && document.body) {
      if (!warnedFloating) {
        warnedFloating = true;
        console.warn(
          '[kcs-turn-timer] 找不到会话视图，计时改为右下角浮动显示。' +
            'Kiro 对话面板的 DOM 结构可能变了，锚点需要更新。'
        );
      }
      return { target: document.body, mode: 'floating' };
    }

    return null;
  }

  /**
   * 找 "Working …" 横条。
   *
   * 优先在该会话子树里找；上溯不到会话视图根时，**只有单轮在跑**才允许全文档找
   * ——此时全文档最多一条横条，不存在认错会话的风险。多轮并行又定不到根，就不猜。
   */
  function findBar(root) {
    if (root && typeof root.querySelector === 'function') {
      const scoped = root.querySelector(BAR_SELECTOR);
      if (scoped) return scoped;
      return null;
    }
    if (turns.size === 1 && typeof document.querySelector === 'function') {
      return document.querySelector(BAR_SELECTOR);
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 4. 渲染
   * ------------------------------------------------------------------ */

  /**
   * 样式：走 Kiro 自己的 CSS 变量与 footer 类名，只补一个「在跑」的呼吸动画。
   * webview 的 CSP 是 `style-src <cspSource> 'unsafe-inline'`，
   * 内联 <style> 是允许的，所以不必去改 dist/style.css（少改一个文件，
   * 卸载时也少一处要还原）。
   */
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
      /* 落在 "Working …" 横条里：跟着横条的字号与颜色，只与前文留一点间距 */
      .${MARK}.${MARK}--bar {
        margin-inline-start: 8px;
        font-variant-numeric: tabular-nums;
        opacity: .85;
      }
      /* 兜底位置：找不到会话视图时浮在右下角，宁可位置不理想也不要「看不见」 */
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
   * 造一行计时 DOM。形态决定标签结构：
   *
   * - `bar`：一个轻量 `<span>`，挂进横条里跟在 "Working." 后面，不带任何块级样式。
   * - 其余：复用 Kiro footer 的类名 `kiro-turn-usage-summary` / `-left` / `-item`，
   *   于是间距、字号、颜色都跟原生那行一模一样，不引入新的视觉规范。
   *
   * 两种形态都保证 `label` 的最后一个子节点是文本节点，刷新时只改 `nodeValue`。
   */
  function makeRow(mode) {
    const dot = document.createElement('span');
    dot.className = 'kcs-dot';

    if (mode === 'bar') {
      const span = document.createElement('span');
      span.className = `${MARK} ${MARK}--bar`;
      span.dataset.kcsLiveTurn = '1';
      span.appendChild(dot);
      span.appendChild(document.createTextNode(''));
      return { row: span, label: span };
    }

    const row = document.createElement('div');
    row.className =
      `kiro-turn-usage-summary ${MARK}` + (mode === 'floating' ? ` ${MARK}--floating` : '');
    row.dataset.kcsLiveTurn = '1';

    const left = document.createElement('div');
    left.className = 'kiro-turn-usage-summary-left';

    const label = document.createElement('span');
    label.className = 'kiro-turn-usage-summary-item';
    label.appendChild(dot);
    label.appendChild(document.createTextNode(''));

    left.appendChild(label);
    row.appendChild(left);
    return { row, label };
  }

  /** 摘掉某一轮的那行 DOM（幂等）。 */
  function detachRow(turn) {
    if (turn.row && turn.row.parentElement) turn.row.parentElement.removeChild(turn.row);
    turn.row = null;
    turn.label = null;
    turn.mode = 'waiting';
  }

  /**
   * 时长格式化：与 Kiro 自带 PromptTurnFooter 的 formatDuration 同规则
   * （"1h 2m 3s"，各段为 0 时省略，全为 0 时显示 "0s"），
   * 这样进行中和结束后的文字风格一致，不会有割裂感。
   */
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

  /**
   * 刷新所有在跑的轮。
   *
   * 每 200ms 跑一遍，顺带承担「重新贴到末尾」的职责：React 只操作它自己创建的节点，
   * 不会删掉我们这个外来子节点，但**可能**在我们后面再插入新节点。用定时刷新去重锚
   * （而不是 MutationObserver）少一个观察者、也避免「我们改 DOM → 观察者又被触发」
   * 这种自激循环；200ms 的滞后在视觉上察觉不到。
   */
  function paint() {
    if (turns.size === 0) return;
    const now = Date.now();
    const anchors = [];

    for (const turn of turns.values()) {
      const spot = anchorFor(turn, now);

      if (!spot) {
        // 会话视图没了：摘掉这一行，且不去猜别的位置
        detachRow(turn);
        anchors.push('detached');
        continue;
      }

      if (!spot.target) {
        // 还在等横条：先不显示，但别把已有的那行留在错的地方
        if (turn.mode !== spot.mode) detachRow(turn);
        anchors.push('waiting');
        continue;
      }

      // 形态变了要重建 DOM（bar 是轻量 span，其余是 footer 那套块级结构）
      if (turn.mode !== spot.mode || !turn.row) {
        detachRow(turn);
        const built = makeRow(spot.mode);
        turn.row = built.row;
        turn.label = built.label;
        turn.mode = spot.mode;
      }

      if (spot.target.lastElementChild !== turn.row) spot.target.appendChild(turn.row);

      const elapsed = formatDuration(now - turn.startedAt);
      // 横条里已经有 "Working." 在交代「在干什么」，不必再重复 "Elapsed time"
      turn.label.lastChild.nodeValue = spot.mode === 'bar' ? elapsed : `Elapsed time: ${elapsed}`;
      anchors.push(spot.mode);
    }

    diag.anchors = anchors;
  }

  function startTicking() {
    installStyle();
    // 刻意不在这里立刻 paint：此刻 React 还没渲染出 "Working" 横条，
    // 立刻画只会先落到消息流里、200ms 后再跳进横条（见 BAR_GRACE_MS）。
    if (ticker === null) ticker = window.setInterval(paint, TICK_MS);
  }

  function stopTicking() {
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
    diag.anchors = [];
  }

  /* ------------------------------------------------------------------ *
   * 5. 出向：认出 `prompt` 请求 = 轮开始
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

  /**
   * 观测一条出向消息；只认 `prompt`（轮开始）与 `cancelPrompt`（轮结束），
   * 其余一律放过——尤其 `steerPrompt` 必须被放过，它是本轮的一部分，不该重置计时。
   */
  function observeOutgoing(message) {
    try {
      if (!message || typeof message !== 'object') return;
      if (message.type !== 'request' || typeof message.id !== 'string') return;

      if (message.key === 'prompt') {
        // 拿不到 sessionId 时退化成按 requestId 记账：至少不比 v2 差
        const sid = sessionIdOf(message.params) || 'kcs-req:' + message.id;
        startTurn(sid, message.id);
        diag.turns += 1;
        startTicking();
        return;
      }

      if (message.key === 'cancelPrompt') {
        // 点停止 = 本轮就此结束。**必须**在这里收工：被取消的那个 prompt 请求
        // 永远不会有 response/error 回来（Kiro 自己 cancelActivePrompt() 就地
        // 放弃了它），等响应就是等一个不会发生的事件。
        const sid = sessionIdOf(message.params);
        const ended = sid ? dropTurn(sid) : endOnlyTurn();
        if (ended) {
          diag.cancels += 1;
          if (turns.size === 0) stopTicking();
        }
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
   * 6. 入向：response / error 落到在途 id 上 = 轮结束
   * ------------------------------------------------------------------ */
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'response' && data.type !== 'error') return;
    if (typeof data.id !== 'string') return;
    // 认不出的 id 一律忽略：可能是别的 RPC，也可能是那条已被 cancel / 顶掉的记录
    // 迟到的响应（如果它真的来了）——两种都不该影响当前在跑的那一轮。
    if (!endTurnByRequest(data.id)) return;
    if (turns.size === 0) stopTicking();
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
