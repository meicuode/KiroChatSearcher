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
 * Kiro 的停止按钮做的是：
 *
 *     u.getState().cancelActivePrompt?.();   // 就地放弃自己那个 pending promise
 *     c("cancelPrompt", sessionId);          // 通知扩展去 cancel
 *     …随后（如果是「中断并重新提问」）await c("prompt", {…}) 开新一轮
 *
 * 关键在 `cancelActivePrompt()`：Kiro **不等**被取消的那次 `prompt` 回响应，
 * 而是本地把 promise 了结掉。于是那个 requestId 的 `response` / `error`
 * **永远不会到达 webview**。Kiro 自己不受影响，因为它的 `isAgentActive` 是个
 * 布尔量、由**最新**那一轮覆盖写；而「所有在途请求都清空才收工」这种写法会被
 * 一条永远收不到响应的记录永久钉死（曾经的真实 bug：中断后重新提问，新一轮跑完了
 * 计时还在涨，且显示的是被取消那一轮的起点，能涨到好几个小时）。
 *
 * 所以记账与 Kiro 同构：
 *   1. **按 sessionId 记账，新的一轮顶掉旧的**——同一会话不可能有两轮并行，
 *      所以只要该会话又发了 `prompt`，先前那条无论结局如何都已作废。
 *   2. **`cancelPrompt` 当作该会话的轮结束**——这正是 Kiro 自己用的信号
 *      （紧跟着就是 `executionAborted` + `status:"aborted"`），也是唯一能
 *      在「响应永远不来」时正确收工的时机。
 *
 * ── 计时显示在哪：每轮一行，落在该会话自己的 "Working" 横条里 ──
 *
 * 落点是 Kiro 的 `AgentInteractionPanel` 底部横条
 * （`.agent-interaction-panel-bottom-bar`，就是对话框上方那条 "Working. … Cancel"）。
 * 选它的理由不是位置好看：该组件在 `!children && !actions` 时**整个返回 `null`**，
 * 所以**横条存在就等于这个会话有活动的轮**，天然一个会话一条。这也是翻遍产物后
 * 唯一能把 DOM 与「哪个会话在跑」对应起来的信号——`.session-view-content` 上没有
 * 任何 `data-session-*`，`data-active` / `data-incomplete` 都是弹出菜单和 markdown
 * 流式渲染在用，与会话无关。
 *
 * 横条的 CSS 是 `display:flex; flex-wrap:wrap; justify-content:space-between`，
 * 两个格子分别是「Working」和 `.agent-interaction-panel-actions`（Cancel）。
 * 计时行要作为**横条自己的 flex 项**插在 actions 之前 ——
 * 曾经插进左边那个格子里，而里面的 "Working" 是块级元素，于是计时被挤到了下一行。
 *
 * ── 横条要每次现查，不能记住那个元素 ──────────────────────────
 *
 * 曾经的做法是在发出 `prompt` 的那一刻把会话视图的 DOM 记下来，之后只认这棵子树。
 * 这在**切走再切回**时会崩：`session-manager` 切换会话会把会话视图整棵重建
 * （`SessionView` 渲染的是 `.session-view-root` > `.session-view-container`，
 * 切换后是全新的元素），于是记住的那些节点全部失效，计时就再也不显示了。
 *
 * 现在改成**每次刷新都重新在文档里找横条**，再问每条横条「你属于哪个会话」。
 *
 * ── 横条属于哪个会话：走 React fiber 精确认人 ────────────────────
 *
 * Kiro 的 DOM 上没有任何会话标记，但它是 React 应用，而 React 把内部指针挂成 DOM
 * 节点的自有属性（`"__reactFiber$" + Math.random().toString(36).slice(2)`）。
 * 会话身份在组件树里是显式传递的——每个会话一个自己的 store
 * （`t => ly((e,n) => ({ sessionId: t, session: [], … }))`），外面还包着一个以
 * `sessionId` 为 prop 的 provider。
 *
 * 于是：从横条的 fiber 沿 `return` 往上走，找第一个能取出 `sessionId` 的祖先。
 * 这个配对是**精确**的，与同时跑几个会话无关。全程只读、包在 try 里。
 *
 * 解析不出来（React 换了大版本）时**不猜**：只有在完全无歧义（没配上的轮恰好一个、
 * 身份不明的横条也恰好一条）时才配；否则放弃横条这个落点。宁可不显示，
 * 也不显示一个可能配反的数字——显示错的比不显示更糟，因为你没法判断它对不对。
 *
 * 落点优先级：
 *   1. 本会话的横条（fiber 精确配对，或无歧义时的兜底配对）；
 *   2. 一条横条都没有、而捕获到的会话视图还活着 → 退到该会话自己的消息流末尾
 *      （Kiro 换了横条类名时的兜底，仍然不会串到别的会话去）；
 *   3. 连会话视图都没捕获到 → 右下角浮动（最后兜底，宁可位置怪也不要看不见）。
 *
 * 配上横条后会顺手把捕获的会话视图元素刷新成当前这一棵，所以第 2 条在会话视图被
 * 重建之后依然可用。两种挂载模型也都成立：隐藏的会话视图**留在 DOM 里**时它的横条
 * 也还在、计时留在那条（不可见）横条上，切回来就看得见；被**整棵卸载**时文档里根本
 * 没有它的横条，于是什么都不显示。两种情况下空闲会话都不会莫名出现别人的计时。
 *
 * ── 已知边界 ──────────────────────────────────────────────────
 * - 面板在轮进行中被重建（reload window）时，那次 `prompt` 的请求不是本 webview
 *   发的，起始时间无从得知，此时不显示计时（不猜）。
 * - 横条解析出的会话不在本 webview 的轮记录里（例如同一会话同时开在侧边栏和编辑器
 *   分栏、而那一轮是另一边发起的），这条横条就不用——不是我们的，不往里写。
 */

(() => {
  'use strict';

  // 同一 webview 里重复注入（例如 main.js 被打了两次补丁）只生效一次。
  if (window.__kcsTurnTimerInstalled) return;
  window.__kcsTurnTimerInstalled = true;

  const MARK = 'kcs-live-turn';
  const TICK_MS = 200;

  /** Kiro 那条 "Working. … Cancel" 横条。 */
  const BAR_SELECTOR = '.agent-interaction-panel-bottom-bar';
  /** 横条右侧的按钮组（Cancel 在里面）；计时插在它**之前**。 */
  const ACTIONS_SELECTOR = '.agent-interaction-panel-actions';
  /** 会话消息流（滚动容器）。 */
  const CONTENT_SELECTOR = '.session-view-content';
  /** 会话视图输入区，用来把任意节点上溯到「会话视图根」。 */
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
    version: 6,
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
    /** 会话视图被重建后重新认领横条的次数（切走再切回会 +1）。 */
    reacquired: 0,
    /** 靠 React fiber 精确认出横条属于哪个会话的次数。 */
    fiberHits: 0,
    /** fiber 取不到身份、但局面无歧义因而仍然配上的次数。 */
    fallbackPairs: 0,
    /** fiber 取不到身份且局面有歧义、因而**放弃显示**的次数（宁可不显示也不显示错的）。 */
    ambiguous: 0,
    /** 当前各行的落点：`bar` / `inline` / `floating` / `waiting` / `detached`。 */
    anchors: [],
    /** 文档里当前有几条 "Working" 横条。 */
    get bars() {
      return collectBars().length;
    },
    /** 当前每条横条解析出的 sessionId（`''` = 没解析出来）。排查配对时看这个。 */
    get barSessions() {
      return collectBars().map((b) => barSessionId(b));
    },
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
   *   `content`   该会话的消息流（发起时捕获，视图重建后会被刷新）
   *   `root`      该会话的会话视图根（含输入区的那个祖先，同样会被刷新）
   *   `row/label` 这一轮自己的那行 DOM（按落点形态创建）
   *   `mode`      当前落点形态，用于形态变化时重建 DOM
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
    const content = visibleContent();
    turns.set(sessionKey, {
      id: requestId,
      startedAt: Date.now(),
      content: content,
      root: content ? sessionRootOf(content) : null,
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
   * 2. DOM 定位
   * ------------------------------------------------------------------ */

  /** 元素是否还挂在文档里（会话视图被重建/关闭后旧子树会整棵摘走）。 */
  function isAttached(el) {
    let cur = el;
    while (cur) {
      if (cur === document.body || cur === document.documentElement) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** 元素此刻是否可见（隐藏的会话视图里 `offsetParent` 为 null）。 */
  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  /** 文档里所有 "Working" 横条。 */
  function collectBars() {
    if (typeof document.querySelectorAll !== 'function') return [];
    return [...document.querySelectorAll(BAR_SELECTOR)];
  }

  /**
   * 当前可见的那个 `.session-view-content`。
   * 都不可见时退回最后一个（比什么都不给要好）。
   */
  function visibleContent() {
    if (typeof document.querySelectorAll !== 'function') return null;
    const all = [...document.querySelectorAll(CONTENT_SELECTOR)];
    for (let i = all.length - 1; i >= 0; i--) if (isVisible(all[i])) return all[i];
    return all.length > 0 ? all[all.length - 1] : null;
  }

  /**
   * 从任意节点上溯到「会话视图根」：最近的、**同时含有输入区**的那个祖先。
   *
   * 用「含有输入区」而不是写死层数，是因为层级是 minified 产物的实现细节；
   * 而「消息流和输入框属于同一个会话视图」这件事是结构性的，不会随改版轻易变。
   */
  function sessionRootOf(el) {
    let cur = el ? el.parentElement : null;
    for (let i = 0; i < 8 && cur; i++) {
      if (typeof cur.querySelector === 'function' && cur.querySelector(INPUT_SELECTOR)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /* ---------------- 横条 → sessionId：走 React fiber 精确认人 ---------------- */

  /**
   * 已解析过的横条 → sessionId 缓存。
   *
   * 一条横条在它的生命周期里只属于一个会话，所以按元素缓存是安全的；
   * 而 fiber 上溯每 200ms 做一遍就太浪费了。会话视图重建后是新元素，自然重新解析。
   */
  const barSessionCache = new WeakMap();

  /**
   * 取 DOM 节点上的 React fiber。
   *
   * React 把内部指针挂成节点的**自有属性**，属性名带一个进程内随机后缀：
   *
   *     var me = Math.random().toString(36).slice(2),
   *         At = "__reactFiber$" + me,
   *         Bt = "__reactProps$" + me;
   *
   * 所以只能扫属性名前缀，不能写死。
   */
  function fiberOf(el) {
    for (const key of Object.keys(el)) {
      if (key.indexOf('__reactFiber$') === 0) return el[key];
    }
    return null;
  }

  /** 从一个 fiber 的 props / context value 里尽力取出 sessionId。 */
  function sessionIdFromProps(props) {
    if (!props || typeof props !== 'object') return '';
    if (typeof props.sessionId === 'string' && props.sessionId) return props.sessionId;
    // context provider：value 可能直接带 sessionId，也可能是该会话专属的 store
    const value = props.value;
    if (value && typeof value === 'object') {
      if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId;
      if (typeof value.getState === 'function') {
        const state = value.getState();
        if (state && typeof state.sessionId === 'string' && state.sessionId) return state.sessionId;
      }
    }
    return '';
  }

  /**
   * 这条横条属于哪个会话。
   *
   * Kiro 的会话身份在组件树里是显式传下来的——每个会话有一个自己的 store
   * （`t => ly((e,n) => ({ sessionId: t, session: [], … }))`），外面还包着一个以
   * `sessionId` 为 prop 的 provider。所以从横条的 fiber 沿 `return` 往上走，
   * 找第一个能取出 sessionId 的祖先即可。**这是精确的**，与并行几个会话无关。
   *
   * 全程只读、包在 try 里：这是 React 内部结构，换了大版本可能失效，
   * 失效时返回 `''` 交给上层的「无歧义才配、否则不显示」兜底，而不是猜。
   */
  function barSessionId(bar) {
    if (barSessionCache.has(bar)) return barSessionCache.get(bar);
    let sid = '';
    try {
      let cur = fiberOf(bar);
      for (let i = 0; i < 80 && cur; i++) {
        sid = sessionIdFromProps(cur.memoizedProps);
        if (sid) break;
        cur = cur.return;
      }
    } catch {
      sid = '';
    }
    barSessionCache.set(bar, sid);
    if (sid) diag.fiberHits += 1;
    return sid;
  }

  /**
   * 给每一轮配一条横条。
   *
   * 1. **精确**：每条横条走 React fiber 问出自己的 sessionId，直接对上同 id 的那一轮。
   *    解析出来但不在我们跟踪的会话里（例如那一轮是另一个 webview 发起的），
   *    这条横条就**不用**——不是我们的，别往里写。
   * 2. **兜底**：fiber 取不到身份时，只有在**完全无歧义**（没配上的轮恰好一个、
   *    身份不明的横条也恰好一条）时才配；否则宁可不显示，也不显示一个可能配反的数字。
   *
   * 配上之后顺手把捕获的会话视图元素刷新成当前这一棵，让「没有横条时退到消息流」
   * 那条兜底在会话视图被重建后依然可用。
   */
  function resolveBars() {
    const map = new Map();
    if (turns.size === 0) return map;
    const bars = collectBars();
    if (bars.length === 0) return map;

    const unresolved = [];
    for (const bar of bars) {
      const sid = barSessionId(bar);
      if (!sid) {
        unresolved.push(bar);
        continue;
      }
      const turn = turns.get(sid);
      if (turn && !map.has(turn)) map.set(turn, bar);
    }

    if (unresolved.length > 0) {
      const rest = [...turns.values()].filter((t) => !map.has(t));
      if (unresolved.length === 1 && rest.length === 1) {
        map.set(rest[0], unresolved[0]);
        diag.fallbackPairs += 1;
      } else if (rest.length > 0) {
        // 有歧义：放弃这些轮的横条落点（上层会退到各自的消息流，或什么都不显示）
        diag.ambiguous += 1;
      }
    }

    for (const [turn, bar] of map) refreshCapture(turn, bar);
    return map;
  }

  /** 把捕获的会话视图元素换成横条所在的这一棵（会话视图重建后靠这个自愈）。 */
  function refreshCapture(turn, bar) {
    const root = sessionRootOf(bar);
    if (!root || root === turn.root) return;
    turn.root = root;
    if (typeof root.querySelector === 'function') {
      const content = root.querySelector(CONTENT_SELECTOR);
      if (content) turn.content = content;
    }
    diag.reacquired += 1;
  }

  /**
   * 这一轮的计时该放哪。
   *
   * 返回 `{ target, before, mode }`；`mode === 'waiting'` 表示这一刻先别显示；
   * 返回 `null` 表示这一轮已经无处可放（会话被关掉了），**不显示**——
   * 退回「当前可见的那个会话」就是串台的来源。
   */
  function anchorFor(turn, bar, now) {
    if (bar) {
      // 插在 Cancel 那组按钮之前，作为横条自己的 flex 项（不能塞进左边格子里，
      // 那里的 "Working" 是块级元素，会把计时挤到下一行）
      const actions = typeof bar.querySelector === 'function' ? bar.querySelector(ACTIONS_SELECTOR) : null;
      return { target: bar, before: actions && actions.parentElement === bar ? actions : null, mode: 'bar' };
    }

    const rootAlive = !!(turn.root && isAttached(turn.root));
    const contentAlive = !!(turn.content && isAttached(turn.content));

    // 已经进过横条、视图还活着而横条没了 ⇒ 这一轮正在收尾，别跳回消息流闪一下
    if (turn.mode === 'bar' && (rootAlive || contentAlive)) {
      return { target: null, before: null, mode: 'waiting' };
    }

    // 捕获过会话视图，但它整棵都不在了、也没配到横条 ⇒ 那个会话被关掉了
    if ((turn.root || turn.content) && !rootAlive && !contentAlive) return null;

    // 还在宽限期内就等一等，避免「先落消息流、再跳进横条」的闪动
    if ((rootAlive || contentAlive) && now - turn.startedAt < BAR_GRACE_MS) {
      return { target: null, before: null, mode: 'waiting' };
    }

    // 退到该会话自己的消息流末尾（用捕获到的那个，不是当前可见的那个）
    if (contentAlive) return { target: turn.content, before: null, mode: 'inline' };

    // 连会话视图都没捕获到：右下角浮动
    if (!turn.root && !turn.content && document.body) {
      if (!warnedFloating) {
        warnedFloating = true;
        console.warn(
          '[kcs-turn-timer] 找不到会话视图，计时改为右下角浮动显示。' +
            'Kiro 对话面板的 DOM 结构可能变了，锚点需要更新。'
        );
      }
      return { target: document.body, before: null, mode: 'floating' };
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   * 3. 渲染
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
      /* 横条里：作为它自己的 flex 项，不参与拉伸也不换行（横条本身有 gap，不用外边距） */
      .${MARK}.${MARK}--bar {
        flex: 0 0 auto;
        white-space: nowrap;
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
   * 造一行计时 DOM。形态决定结构：
   *
   * - `bar`：一个轻量 `<span>`，作为横条的 flex 项插在 Cancel 之前。
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
   * 把行放到位（幂等）：位置已经对就什么都不做。
   *
   * 幂等很要紧——每 200ms 都会调一次，每次都动 DOM 会让 React 白忙，
   * 也会在横条里造成不必要的重排。
   */
  function place(row, target, before) {
    if (before) {
      if (row.parentElement !== target || row.nextElementSibling !== before) {
        target.insertBefore(row, before);
      }
      return;
    }
    if (target.lastElementChild !== row) target.appendChild(row);
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
   * 每 200ms 跑一遍，顺带承担两件事：**重新找横条**（会话视图被重建后靠这个恢复）
   * 与**重新贴到位**（React 可能在我们后面又插了节点）。用定时刷新而不是
   * MutationObserver：少一个观察者，也避免「我们改 DOM → 观察者又被触发」这种
   * 自激循环；200ms 的滞后在视觉上察觉不到。
   */
  function paint() {
    if (turns.size === 0) return;
    const now = Date.now();
    const bars = resolveBars();
    const anchors = [];

    for (const turn of turns.values()) {
      const spot = anchorFor(turn, bars.get(turn), now);

      if (!spot) {
        detachRow(turn);
        anchors.push('detached');
        continue;
      }

      if (!spot.target) {
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

      place(turn.row, spot.target, spot.before);

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
   * 4. 出向：认出 `prompt` 请求 = 轮开始
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
        // 拿不到 sessionId 时退化成按 requestId 记账
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
   * 5. 入向：response / error 落到在途 id 上 = 轮结束
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
