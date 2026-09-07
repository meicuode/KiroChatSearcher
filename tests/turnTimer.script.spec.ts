import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * `media/kcs-turn-timer.js` —— 轮次记账与「计时行落在哪个会话里」。
 *
 * 这个文件跑在 **Kiro 自己的对话面板 webview** 里，是整个扩展唯一在别人进程的
 * 别人页面里执行的代码：出问题时从扩展侧看不到任何东西（拿不到 DOM、控制台不落盘），
 * 而它又只能靠观测 minified 产物的 RPC 行为与 DOM 类名工作。于是这里把**真实发布的
 * 那份文件**放进一个 DOM 替身里执行，用 postMessage 序列驱动它，断言「什么时候、
 * 在哪里、显示什么」。
 *
 * 钉住的是两个真实线上 bug：
 *
 * 1. **中断后重新提问，计时永远停不下来。** Kiro 的停止按钮走
 *    `cancelActivePrompt()` —— 它就地放弃自己那个 pending promise，被取消的那次
 *    `prompt` 的 `response`/`error` **永远不会到达 webview**。旧版「所有在途请求
 *    都收到响应才停」于是被永久钉死，且因为取最早的开始时刻，显示的是被取消那一轮
 *    的起点（能涨到好几个小时）。
 *
 * 2. **计时串台。** 旧版只有全局一行，挂在「当前可见」的消息流末尾。侧边栏会为每个
 *    打开的会话各挂一份会话视图，于是会话 A 在跑、切到空闲的会话 B，A 的计时会跟着
 *    显示在 B 的消息流里。
 *
 * 现在的模型：一轮一行，会话归属在发出 `prompt` 的那一刻确定，优先落在该会话自己的
 * "Working … Cancel" 横条（`.agent-interaction-panel-bottom-bar`）里。
 */

/** 允许指向别的副本（用于验证这些断言真的能抓住旧版本）。 */
const SCRIPT_PATH =
  process.env.KCS_TURN_TIMER_SCRIPT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../media/kcs-turn-timer.js');

/* ------------------------------------------------------------------ *
 * DOM 替身：只实现脚本真正用到的那一小部分
 * ------------------------------------------------------------------ */

interface Nd {
  nodeType: number;
  nodeValue?: string;
  parentElement: El | null;
}

interface El extends Nd {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  childNodes: Nd[];
  classList: { toggle(c: string, on?: boolean): void; contains(c: string): boolean };
  offsetParent: El | null;
  appendChild(c: Nd): Nd;
  insertBefore(c: Nd, ref: Nd | null): Nd;
  removeChild(c: Nd): Nd;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
  readonly children: El[];
  readonly lastChild: Nd | null;
  readonly firstElementChild: El | null;
  readonly lastElementChild: El | null;
  readonly nextElementSibling: El | null;
}

/** 只支持 `.class` 选择器——脚本用到的就这一种。 */
function matches(el: El, sel: string): boolean {
  if (!sel.startsWith('.')) return false;
  const want = sel.slice(1);
  return el.className.split(/\s+/).includes(want);
}

function descendants(el: El, out: El[] = []): El[] {
  for (const n of el.childNodes) {
    if (n.nodeType !== 1) continue;
    out.push(n as El);
    descendants(n as El, out);
  }
  return out;
}

function makeEl(tagName: string, onRegister?: (el: El) => void): El {
  const extraClasses = new Set<string>();
  const el: El = {
    nodeType: 1,
    tagName,
    id: '',
    className: '',
    textContent: '',
    dataset: {},
    childNodes: [],
    parentElement: null,
    offsetParent: null,
    classList: {
      toggle(c, on) {
        const next = on === undefined ? !extraClasses.has(c) : !!on;
        if (next) extraClasses.add(c);
        else extraClasses.delete(c);
      },
      contains: (c) => extraClasses.has(c) || el.className.split(/\s+/).includes(c),
    },
    appendChild(c) {
      if (c.parentElement) c.parentElement.removeChild(c);
      el.childNodes.push(c);
      c.parentElement = el;
      if (c.nodeType === 1) onRegister?.(c as El);
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentElement) c.parentElement.removeChild(c);
      const i = ref ? el.childNodes.indexOf(ref) : -1;
      if (i < 0) el.childNodes.push(c);
      else el.childNodes.splice(i, 0, c);
      c.parentElement = el;
      if (c.nodeType === 1) onRegister?.(c as El);
      return c;
    },
    removeChild(c) {
      const i = el.childNodes.indexOf(c);
      if (i >= 0) el.childNodes.splice(i, 1);
      c.parentElement = null;
      return c;
    },
    querySelector: (sel) => descendants(el).find((d) => matches(d, sel)) ?? null,
    querySelectorAll: (sel) => descendants(el).filter((d) => matches(d, sel)),
    get children() {
      return el.childNodes.filter((n) => n.nodeType === 1) as El[];
    },
    get lastChild() {
      return el.childNodes.length ? el.childNodes[el.childNodes.length - 1] : null;
    },
    get firstElementChild() {
      const c = el.children;
      return c.length ? c[0] : null;
    },
    get nextElementSibling() {
      const p = el.parentElement;
      if (!p) return null;
      const sibs = p.children;
      const i = sibs.indexOf(el);
      return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
    },
    get lastElementChild() {
      const c = el.children;
      return c.length ? c[c.length - 1] : null;
    },
  };
  return el;
}

/**
 * 给元素挂上 React fiber 替身。
 *
 * 照抄 React 的真实形态：属性名是 `"__reactFiber$" + 随机后缀`（脚本只能扫前缀），
 * fiber 用 `return` 串成链，会话身份放在某个祖先的 `memoizedProps.sessionId` 上
 * ——Kiro 的组件树里就是这样：每个会话一个自己的 store，外面包一个带 sessionId 的
 * provider。这里刻意在链上多垫几层无关 fiber，确保脚本真的会往上走。
 */
function attachFiber(el: El, sessionId: string, kind: 'prop' | 'store' = 'prop'): void {
  const provider =
    kind === 'prop'
      ? { memoizedProps: { sessionId }, return: null }
      : { memoizedProps: { value: { getState: () => ({ sessionId }) } }, return: null };
  const mid2 = { memoizedProps: { className: 'whatever' }, return: provider };
  const mid1 = { memoizedProps: {}, return: mid2 };
  (el as unknown as Record<string, unknown>)['__reactFiber$' + 'kcs9z1'] = {
    memoizedProps: {},
    return: mid1,
  };
}

/** 一个会话视图（结构照抄 Kiro 的产物）。 */
interface View {
  root: El;
  content: El;
  input: El;
  /** 显示 "Working … Cancel" 横条（= 该会话有活动的轮）。 */
  showBar(): void;
  /** 撤掉横条（= 轮结束，Kiro 的 AgentInteractionPanel 返回 null）。 */
  hideBar(): void;
  /** 设为可见 / 隐藏（`session-manager` 里多个会话视图只有一个可见）。 */
  setVisible(on: boolean): void;
  /** 该会话子树里我们插入的那行计时的文字；没有则为 `null`。 */
  timerText(): string | null;
  /** 该行是否落在横条里。 */
  timerInBar(): boolean;
  /** 该会话当前的横条元素。 */
  bar(): El | null;
}

interface Harness {
  diag: {
    version: number;
    hooked: boolean;
    hookError: string;
    turns: number;
    cancels: number;
    superseded: number;
    anchors: string[];
    running: number;
    sessions: string[];
  };
  views: Record<string, View>;
  body: El;
  /**
   * 模拟 Kiro 切换会话：把该会话视图整棵拆掉、再建一棵**全新的**。
   *
   * `SessionView` 渲染的是 `.session-view-root` > `.session-view-container`，
   * 切换会话时这棵子树会被重建，元素身份全部改变——这正是「切走再切回后计时没了」
   * 那个 bug 的成因。
   */
  remount(name: string, opts?: { withBar?: boolean }): void;
  /** 浮动兜底那行（挂在 body 上）的文字。 */
  floatingText(): string | null;
  ticking(): boolean;
  advance(ms: number): void;
  send(message: unknown): void;
  receive(data: unknown): void;
  prompt(id: string, sessionId?: string): void;
  cancel(sessionId?: string): void;
}

function findTimer(scope: El): El | null {
  return descendants(scope).find((d) => d.dataset && d.dataset.kcsLiveTurn === '1') ?? null;
}

function timerTextOf(scope: El): string | null {
  const row = findTimer(scope);
  if (!row) return null;
  // bar 形态：row 自身就是 label；其余：row > div > span
  const label = row.className.includes('--bar') ? row : row.children[0]?.children[0];
  const last = label?.lastChild;
  return last && typeof last.nodeValue === 'string' ? last.nodeValue : null;
}

function boot(
  opts: {
    sessions?: string[];
    noSessionViews?: boolean;
    /** 会话名 → sessionId（横条的 fiber 会报这个 id）。 */
    ids?: Record<string, string>;
    /** true = 横条上不挂 fiber，模拟 React 换了内部实现、身份解析失败。 */
    noFiber?: boolean;
    /** fiber 里 sessionId 的藏法：prop 或 per-session store。 */
    fiberKind?: 'prop' | 'store';
  } = {}
): Harness {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const byId = new Map<string, El>();
  const register = (el: El) => {
    if (el.id) byId.set(el.id, el);
  };
  const el = (tag: string) => makeEl(tag, register);

  const documentElement = el('html');
  const head = el('head');
  const body = el('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const names = opts.noSessionViews ? [] : (opts.sessions ?? ['A']);
  const views: Record<string, View> = {};

  /** 会话名 → sessionId：单会话用例用 's1'，多会话用 'sA' / 'sB'（与测试里的 prompt 对齐）。 */
  const idOf = (n: string) => (opts.ids ?? {})[n] ?? (names.length === 1 ? 's1' : 's' + n);

  function buildView(name: string): View {
    const root = el('div');
    root.className = 'session-view-root';
    const timeline = el('div');
    timeline.className = 'session-view-timeline';
    const content = el('div');
    content.className = 'session-view-content';
    timeline.appendChild(content);
    const input = el('div');
    input.className = 'session-view-input';
    root.appendChild(timeline);
    root.appendChild(input);
    body.appendChild(root);

    let panel: El | null = null;
    const view: View = {
      root,
      content,
      input,
      showBar() {
        if (panel) return;
        panel = el('div');
        panel.className = 'agent-interaction-panel';
        const bar = el('div');
        bar.className = 'agent-interaction-panel-bottom-bar';
        // 真实产物里横条的 fiber 能上溯到带 sessionId 的祖先
        if (!opts.noFiber) attachFiber(bar, idOf(name), opts.fiberKind ?? 'prop');
        const left = el('div');
        const working = el('span');
        working.textContent = 'Working.';
        left.appendChild(working);
        const actions = el('div');
        actions.className = 'agent-interaction-panel-actions';
        bar.appendChild(left);
        bar.appendChild(actions);
        panel.appendChild(bar);
        root.insertBefore(panel, input);
      },
      hideBar() {
        if (panel && panel.parentElement) panel.parentElement.removeChild(panel);
        panel = null;
      },
      setVisible: (on) => void (content.offsetParent = on ? body : null),
      timerText: () => timerTextOf(root),
      timerInBar: () => {
        const bar = root.querySelector('.agent-interaction-panel-bottom-bar');
        return bar ? findTimer(bar) !== null : false;
      },
      bar: () => root.querySelector('.agent-interaction-panel-bottom-bar'),
    };
    return view;
  }

  for (const name of names) {
    const view = buildView(name);
    // 默认第一个可见，其余隐藏（对应侧边栏的多会话形态）
    view.setVisible(name === names[0]);
    views[name] = view;
  }

  const document = {
    head,
    body,
    documentElement,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => el(tag),
    createTextNode: (v: string): Nd => ({ nodeType: 3, nodeValue: v, parentElement: null }),
    querySelector: (sel: string) => descendants(documentElement).find((d) => matches(d, sel)) ?? null,
    querySelectorAll: (sel: string) => descendants(documentElement).filter((d) => matches(d, sel)),
    addEventListener: () => {},
  };

  let now = 1_000_000;
  const FakeDate = { now: () => now };
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  const messageHandlers: Array<(e: { data: unknown }) => void> = [];

  const win: Record<string, unknown> = {
    setInterval: (fn: () => void) => {
      const id = nextTimer++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id: number) => void intervals.delete(id),
    addEventListener: (type: string, fn: (e: { data: unknown }) => void) => {
      if (type === 'message') messageHandlers.push(fn);
    },
    vscode: { postMessage: () => {}, setState: () => {}, getState: () => undefined },
  };

  const MutationObserverDouble = class {
    observe() {}
    disconnect() {}
  };

  const fn = new Function('window', 'document', 'MutationObserver', 'console', 'Date', source);
  fn(
    win,
    document,
    MutationObserverDouble,
    { info: () => {}, warn: () => {}, error: () => {} },
    FakeDate
  );

  const post = (m: unknown) => (win.vscode as { postMessage(m: unknown): void }).postMessage(m);

  return {
    diag: win.__kcsTurnTimer as Harness['diag'],
    views,
    body,
    remount: (name, o = {}) => {
      const old = views[name];
      const wasVisible = old ? old.content.offsetParent !== null : true;
      if (old && old.root.parentElement) old.root.parentElement.removeChild(old.root);
      const fresh = buildView(name);
      fresh.setVisible(wasVisible);
      if (o.withBar) fresh.showBar();
      views[name] = fresh;
    },
    floatingText: () => {
      const row = body.children.find((c) => c.dataset && c.dataset.kcsLiveTurn === '1');
      return row ? timerTextOf(row.parentElement as El) : null;
    },
    ticking: () => intervals.size > 0,
    advance: (ms: number) => {
      now += ms;
      for (const f of [...intervals.values()]) f();
    },
    send: post,
    receive: (data: unknown) => {
      for (const h of [...messageHandlers]) h({ data });
    },
    prompt: (id: string, sessionId = 's1') =>
      post({
        type: 'request',
        id,
        key: 'prompt',
        params: [{ sessionId, prompt: [{ type: 'text', text: 'hi' }] }],
      }),
    cancel: (sessionId = 's1') =>
      post({ type: 'request', id: 'c-' + sessionId, key: 'cancelPrompt', params: [sessionId] }),
  };
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

let h: Harness;
beforeEach(() => {
  h = boot();
});

describe('挂钩', () => {
  it('替换 window.vscode 成功，诊断对象就绪', () => {
    expect(h.diag.hooked).toBe(true);
    expect(h.diag.hookError).toBe('');
    expect(h.diag.version).toBe(6);
    expect(h.diag.running).toBe(0);
  });

  it('没有任何一轮在跑时什么都不显示', () => {
    h.advance(1000);
    expect(h.views.A.timerText()).toBeNull();
    expect(h.ticking()).toBe(false);
  });
});

describe('落在 "Working …" 横条里', () => {
  it('横条出现后，计时跟在它后面显示（只有时长，不重复 Elapsed time）', () => {
    h.prompt('r1');
    h.views.A.showBar(); // Kiro 渲染出 Working/Cancel
    h.advance(200);
    expect(h.views.A.timerInBar()).toBe(true);
    expect(h.views.A.timerText()).toBe('0s');
    h.advance(66_000);
    expect(h.views.A.timerText()).toBe('1m 6s');
  });

  it('横条还没渲染出来的那一小会儿先不显示，避免先落消息流再跳进横条', () => {
    h.prompt('r1');
    h.advance(200); // 宽限期内，横条还没出现
    expect(h.views.A.timerText()).toBeNull();
    expect(h.diag.anchors).toEqual(['waiting']);

    h.views.A.showBar();
    h.advance(200);
    expect(h.views.A.timerInBar()).toBe(true);
  });

  it('过了宽限期仍没有横条 → 退到该会话自己的消息流末尾', () => {
    h.prompt('r1');
    h.advance(1000); // > BAR_GRACE_MS
    expect(h.views.A.timerInBar()).toBe(false);
    expect(h.views.A.timerText()).toBe('Elapsed time: 1s');
    expect(findTimer(h.views.A.content)).not.toBeNull();
    expect(h.diag.anchors).toEqual(['inline']);
  });

  it('横条消失（轮在收尾）时不跳回消息流闪一下', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);
    expect(h.views.A.timerInBar()).toBe(true);

    h.views.A.hideBar();
    h.advance(200);
    expect(h.views.A.timerText()).toBeNull();
    expect(h.diag.anchors).toEqual(['waiting']);
  });

  it('计时是横条自己的 flex 项、插在 Cancel 之前，不会被挤到下一行', () => {
    // 回归钉子：曾经插进左边那个格子里，而里面的 "Working" 是块级元素，
    // 于是计时被换行显示。横条本身是 flex 容器，必须作为它的直接子项。
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);

    const bar = h.views.A.bar()!;
    const row = findTimer(bar)!;
    const actions = bar.querySelector('.agent-interaction-panel-actions')!;
    expect(row.parentElement).toBe(bar); // 直接子项，不在左边格子里
    expect(row.nextElementSibling).toBe(actions); // 紧贴 Cancel 之前
    expect(findTimer(bar.firstElementChild!)).toBeNull(); // 确实没塞进 "Working" 那格
  });

  it('React 在我们后面插了新节点 → 下一次刷新重新贴回 Cancel 之前', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);
    const bar = h.views.A.bar()!;
    const actions = bar.querySelector('.agent-interaction-panel-actions')!;
    bar.appendChild(makeEl('span')); // React 又插了个节点在最后
    h.advance(200);
    expect(findTimer(bar)!.nextElementSibling).toBe(actions);
  });

  it('位置已经对时不重复搬动 DOM（每 200ms 都动会让 React 白忙）', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);
    const row = findTimer(h.views.A.bar()!)!;
    h.advance(200);
    h.advance(200);
    expect(findTimer(h.views.A.bar()!)).toBe(row); // 还是同一个节点，没被重建
  });
});

describe('不串台（线上 bug 的回归钉子）', () => {
  it('A 在跑、切到空闲的 B：B 里什么都不显示，A 里照常显示', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(200);
    expect(two.views.A.timerInBar()).toBe(true);

    // 用户切到会话 B（B 没有任何活动，Kiro 不会给它渲染横条）
    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.advance(5_000);

    expect(two.views.B.timerText()).toBeNull();
    expect(findTimer(two.views.B.content)).toBeNull();
    // A 仍在跑，它的计时留在 A 自己的子树里（虽然此刻不可见）
    expect(two.views.A.timerInBar()).toBe(true);
    expect(two.views.A.timerText()).toBe('5s');
  });

  it('退到消息流兜底时也不串台：用的是捕获到的那个会话，不是当前可见的', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA'); // 捕获 A（此刻 A 可见）
    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.advance(1000); // 没有横条 → 退到消息流

    expect(findTimer(two.views.A.content)).not.toBeNull();
    expect(findTimer(two.views.B.content)).toBeNull();
  });

  it('两个会话并行跑 → 各自显示自己的耗时，互不影响', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(30_000);

    // 切到 B 并在 B 里也发起一轮
    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.prompt('r2', 'sB');
    two.views.B.showBar();
    two.advance(4_000);

    expect(two.diag.running).toBe(2);
    expect(two.views.A.timerText()).toBe('34s'); // A 自己的起点
    expect(two.views.B.timerText()).toBe('4s'); // B 自己的起点
    expect(two.views.A.timerInBar()).toBe(true);
    expect(two.views.B.timerInBar()).toBe(true);

    // A 结束后只剩 B，B 的数字不受影响
    two.receive({ type: 'response', id: 'r1', key: 'prompt', value: {} });
    two.advance(1_000);
    expect(two.views.A.timerText()).toBeNull();
    expect(two.views.B.timerText()).toBe('5s');
  });

  it('切走再切回（会话视图被整棵重建）后，计时重新出现在新横条里', () => {
    // 这是「切到 B 再切回 A，A 的横条上不显示计时了」那个 bug 的回归钉子：
    // 切换会话会重建 .session-view-root 整棵子树，发起时记下的元素全部失效，
    // 所以横条必须每次刷新都现查，而不能记住那个元素。
    h.prompt('r1', 's1');
    h.views.A.showBar();
    h.advance(30_000);
    expect(h.views.A.timerInBar()).toBe(true);

    // 切到别的会话再切回来 → A 的会话视图是全新的元素（轮还在跑，横条也回来了）
    h.remount('A', { withBar: true });
    expect(h.views.A.timerInBar()).toBe(false); // 新子树里当然还没有我们的行

    h.advance(200);
    expect(h.views.A.timerInBar()).toBe(true);
    expect(h.views.A.timerText()).toBe('30s'); // 起点没丢，仍是本轮的
    expect(h.diag.reacquired).toBeGreaterThanOrEqual(1);
  });

  it('重建后把捕获的会话视图刷新成新那一棵（消息流兜底在重建后依然可用）', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(1_000);

    two.remount('A', { withBar: true });
    two.advance(200);
    const after = two.diag.reacquired;
    expect(after).toBeGreaterThanOrEqual(1);

    // 再刷新几次不应继续重新认领——说明捕获的元素已经换成新那一棵了
    two.advance(200);
    two.advance(200);
    expect(two.diag.reacquired).toBe(after);
    expect(two.views.A.timerInBar()).toBe(true);

    // 横条没了也能退回**自己**的消息流（而不是当前可见的那个）
    two.views.A.hideBar();
    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.advance(200);
    two.advance(200);
    expect(findTimer(two.views.B.content)).toBeNull();
  });

  it('切走时那个会话仍在跑、但视图还挂着（只是隐藏）→ 计时留在它自己的横条上', () => {
    // 另一种挂载模型：隐藏的会话视图留在 DOM 里。此时它的横条也还在，
    // 计时留在那条不可见的横条上，切回来立刻看得见，且绝不出现在 B 里。
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(200);

    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.advance(10_000);

    expect(two.views.A.timerInBar()).toBe(true);
    expect(two.views.A.timerText()).toBe('10s');
    expect(two.views.B.timerText()).toBeNull();

    // 切回 A：同一条横条，数字接着走
    two.views.B.setVisible(false);
    two.views.A.setVisible(true);
    two.advance(1_000);
    expect(two.views.A.timerText()).toBe('11s');
  });

  it('两个会话并行 + 视图都被重建：靠 fiber 精确认人，数字绝不配反', () => {
    // 这一条是「宁可不显示也不显示错的」那个决定的正面版本：身份能精确解析时，
    // 即使两棵视图都重建过、可见的那个不是先开始的那个，也必须各归各位。
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(300_000); // A 已经跑了 5 分钟

    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.prompt('r2', 'sB');
    two.views.B.showBar();
    two.advance(7_000); // B 才跑了 7 秒

    // 两棵都重建（切换会话）——旧的启发式在这里会按「可见优先+最新优先」配，
    // 于是可见的 B 会被配上最新的那一轮…看着对，但换个顺序就会配反。
    two.remount('A', { withBar: true });
    two.remount('B', { withBar: true });
    two.advance(200);

    expect(two.diag.running).toBe(2);
    expect(two.diag.ambiguous).toBe(0);
    expect(two.views.A.timerText()).toBe('5m 7s');
    expect(two.views.B.timerText()).toBe('7s');
  });

  it('sessionId 藏在 per-session store 里也能认出来', () => {
    const two = boot({ sessions: ['A', 'B'], fiberKind: 'store' });
    two.prompt('r1', 'sA');
    two.prompt('r2', 'sB');
    two.views.A.showBar();
    two.views.B.showBar();
    two.advance(9_000);
    expect(two.diag.ambiguous).toBe(0);
    expect(two.views.A.timerText()).toBe('9s');
    expect(two.views.B.timerText()).toBe('9s');
  });

  it('解析出的会话不在我们的轮记录里 → 这条横条不用（不是我们的，不往里写）', () => {
    // 同一会话同时开在侧边栏和编辑器分栏、那一轮是另一边发起的：本 webview 看得到
    // 它的横条，但没有它的轮记录。此时不能把别的轮的时间填进去。
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA'); // 只有 A 这一轮是我们的
    two.views.B.showBar(); // B 的横条由别处驱动
    two.advance(1_000);

    expect(two.views.B.timerText()).toBeNull();
    // A 没有横条 → 退到 A 自己的消息流，而不是跑到 B 的横条里
    expect(findTimer(two.views.A.content)).not.toBeNull();
  });

  it('会话视图被卸载（关掉那个会话）后不再显示，也不改挂到别处', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.advance(200);
    expect(two.views.A.timerInBar()).toBe(true);

    two.body.removeChild(two.views.A.root); // 关掉会话 A 的视图
    two.views.B.setVisible(true);
    two.advance(200);

    expect(two.diag.anchors).toEqual(['detached']);
    expect(two.views.B.timerText()).toBeNull();
    expect(two.floatingText()).toBeNull();
  });
});

describe('轮的起止', () => {
  it('response 回来 → 停止计时并摘掉那一行', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(3_000);
    h.receive({ type: 'response', id: 'r1', key: 'prompt', value: {} });
    expect(h.diag.running).toBe(0);
    expect(h.ticking()).toBe(false);
    expect(h.views.A.timerText()).toBeNull();
  });

  it('error 回来同样收工', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);
    h.receive({ type: 'error', id: 'r1', key: 'prompt', value: 'boom' });
    expect(h.diag.running).toBe(0);
    expect(h.views.A.timerText()).toBeNull();
  });

  it('steerPrompt 不算新一轮、也不结束本轮（它是本轮的一部分）', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(10_000);
    h.send({
      type: 'request',
      id: 'r2',
      key: 'steerPrompt',
      params: [{ sessionId: 's1', prompt: [], messageId: 'steer-1' }],
    });
    h.advance(0);
    expect(h.diag.running).toBe(1);
    expect(h.diag.turns).toBe(1);
    expect(h.views.A.timerText()).toBe('10s'); // 没被重置
  });

  it('别的 RPC 与认不出的响应 id 一律不影响计时', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.send({ type: 'request', id: 'x1', key: 'getContextItems', params: [{}] });
    h.receive({ type: 'response', id: 'unknown', key: 'whatever', value: 1 });
    h.advance(200);
    expect(h.diag.running).toBe(1);
    expect(h.views.A.timerInBar()).toBe(true);
  });

  it('时长格式与 Kiro 原生 formatDuration 同规则', () => {
    h.prompt('r1');
    h.advance(1000); // 落到消息流，带 Elapsed time 前缀
    expect(h.views.A.timerText()).toBe('Elapsed time: 1s');
    h.advance(59_000);
    expect(h.views.A.timerText()).toBe('Elapsed time: 1m');
    h.advance(3_600_000);
    expect(h.views.A.timerText()).toBe('Elapsed time: 1h 1m');
  });
});

describe('点停止', () => {
  it('cancelPrompt 立即结束本轮——那次 prompt 的响应永远不会来', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(30_000);
    h.cancel('s1');
    expect(h.diag.running).toBe(0);
    expect(h.diag.cancels).toBe(1);
    expect(h.ticking()).toBe(false);
    expect(h.views.A.timerText()).toBeNull();
  });

  it('取消后迟到的响应（若真的来了）不会让计时复活', () => {
    h.prompt('r1');
    h.cancel('s1');
    h.receive({ type: 'response', id: 'r1', key: 'prompt', value: {} });
    h.advance(1000);
    expect(h.diag.running).toBe(0);
    expect(h.views.A.timerText()).toBeNull();
  });

  it('cancelPrompt 拿不到 sessionId 时，只有一轮在跑就按它算', () => {
    h.prompt('r1');
    h.send({ type: 'request', id: 'c1', key: 'cancelPrompt', params: [] });
    expect(h.diag.running).toBe(0);
  });

  it('多轮并行且拿不到 sessionId 时不猜（不掐掉别的会话）', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.prompt('r2', 'sB');
    two.send({ type: 'request', id: 'c1', key: 'cancelPrompt', params: [] });
    expect(two.diag.running).toBe(2);
  });

  it('取消的是另一个会话时，本会话的计时不受影响', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.prompt('r2', 'sB');
    two.cancel('sB');
    two.advance(200);
    expect(two.diag.running).toBe(1);
    expect(two.diag.sessions).toEqual(['sA']);
    expect(two.views.A.timerInBar()).toBe(true);
  });
});

describe('中断后重新提问（线上 bug 的回归钉子）', () => {
  it('新一轮跑完后计时必须停下来，不能被那条永远收不到响应的记录钉住', () => {
    // 第一轮跑了两分钟，用户点停止
    h.prompt('r1', 's1');
    h.views.A.showBar();
    h.advance(120_000);
    h.cancel('s1');
    h.views.A.hideBar();
    expect(h.views.A.timerText()).toBeNull();

    // 半分钟后重新提问，跑了 71 秒结束
    h.advance(30_000);
    h.prompt('r2', 's1');
    h.views.A.showBar();
    h.advance(200);
    expect(h.views.A.timerText()).toBe('0s'); // 从新一轮的起点重新算
    h.advance(71_000);
    expect(h.views.A.timerText()).toBe('1m 11s');

    h.receive({ type: 'response', id: 'r2', key: 'prompt', value: {} });
    expect(h.diag.running).toBe(0);
    expect(h.ticking()).toBe(false);
    expect(h.views.A.timerText()).toBeNull();
  });

  it('即使完全没看到 cancelPrompt，同会话的新一轮也会顶掉旧记录', () => {
    // 覆盖「响应永远不来、又没观测到取消」这条路（例如扩展宿主中途重启）
    h.prompt('r1', 's1');
    h.views.A.showBar();
    h.advance(120_000);
    h.prompt('r2', 's1');
    h.advance(200);
    expect(h.diag.running).toBe(1);
    expect(h.diag.superseded).toBe(1);
    expect(h.views.A.timerText()).toBe('0s');

    h.receive({ type: 'response', id: 'r2', key: 'prompt', value: {} });
    expect(h.diag.running).toBe(0);
    expect(h.views.A.timerText()).toBeNull();
  });
});

describe('身份解析失败时的兜底：宁可不显示，也不显示可能配反的数字', () => {
  it('无歧义（一轮 + 一条横条）→ 照常显示', () => {
    const one = boot({ noFiber: true });
    one.prompt('r1');
    one.views.A.showBar();
    one.advance(200);
    expect(one.views.A.timerInBar()).toBe(true);
    expect(one.diag.fallbackPairs).toBeGreaterThanOrEqual(1);
    expect(one.diag.fiberHits).toBe(0);
  });

  it('有歧义（两轮 + 两条身份不明的横条）→ 横条里一个都不写', () => {
    const two = boot({ sessions: ['A', 'B'], noFiber: true });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.prompt('r2', 'sB');
    two.views.B.showBar();
    two.advance(200);

    expect(two.diag.ambiguous).toBeGreaterThanOrEqual(1);
    expect(two.views.A.timerInBar()).toBe(false);
    expect(two.views.B.timerInBar()).toBe(false);
  });

  it('有歧义时退到各自的消息流（仍然精确，因为那是发起时捕获的自己那棵）', () => {
    const two = boot({ sessions: ['A', 'B'], noFiber: true });
    two.prompt('r1', 'sA');
    two.views.A.showBar();
    two.views.A.setVisible(false);
    two.views.B.setVisible(true);
    two.prompt('r2', 'sB');
    two.views.B.showBar();
    two.advance(1_000); // 过了宽限期

    // 每一行都在自己那棵视图里，没有互串
    expect(findTimer(two.views.A.content)).not.toBeNull();
    expect(findTimer(two.views.B.content)).not.toBeNull();
    expect(two.views.A.timerText()).toBe('Elapsed time: 1s');
  });

  it('部分能解析：能认的精确配，剩下**恰好一条**才兜底配', () => {
    const two = boot({ sessions: ['A', 'B'] });
    two.prompt('r1', 'sA');
    two.prompt('r2', 'sB');
    two.views.A.showBar();
    two.views.B.showBar();
    // 把 B 的横条 fiber 摘掉，模拟只有一条认不出来
    const barB = two.views.B.bar()!;
    for (const k of Object.keys(barB)) {
      if (k.indexOf('__reactFiber$') === 0) delete (barB as unknown as Record<string, unknown>)[k];
    }
    two.advance(3_000);

    expect(two.views.A.timerText()).toBe('3s'); // fiber 精确
    expect(two.views.B.timerText()).toBe('3s'); // 剩一轮剩一条 → 兜底也是唯一解
    expect(two.diag.fallbackPairs).toBeGreaterThanOrEqual(1);
  });
});

describe('锚点兜底', () => {
  it('连会话视图都找不到时浮动显示，而不是彻底消失', () => {
    const none = boot({ noSessionViews: true });
    none.prompt('r1');
    none.advance(200);
    expect(none.diag.anchors).toEqual(['floating']);
    expect(none.floatingText()).toBe('Elapsed time: 0s');
  });

  it('上溯不到会话视图根、但只有一轮在跑时，仍然认全文档里那条横条', () => {
    // 模拟 Kiro 改了会话视图的结构（消息流上面没有输入区可供上溯）
    const stray = boot({ noSessionViews: true });
    const bar = makeEl('div');
    bar.className = 'agent-interaction-panel-bottom-bar';
    const left = makeEl('div');
    bar.appendChild(left);
    stray.body.appendChild(bar);

    stray.prompt('r1');
    stray.advance(200);
    expect(stray.diag.anchors).toEqual(['bar']);
    expect(findTimer(bar)).not.toBeNull();
  });
});
