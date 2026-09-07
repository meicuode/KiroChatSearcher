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
    get lastElementChild() {
      const c = el.children;
      return c.length ? c[c.length - 1] : null;
    },
  };
  return el;
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

function boot(opts: { sessions?: string[]; noSessionViews?: boolean } = {}): Harness {
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

  for (const name of names) {
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
    };
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
    expect(h.diag.version).toBe(4);
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

  it('React 在我们后面插了新节点 → 下一次刷新重新贴到末尾', () => {
    h.prompt('r1');
    h.views.A.showBar();
    h.advance(200);
    const bar = h.views.A.root.querySelector('.agent-interaction-panel-bottom-bar')!;
    const left = bar.firstElementChild!;
    const intruder = makeEl('span');
    left.appendChild(intruder);
    expect(left.lastElementChild).toBe(intruder);

    h.advance(200);
    expect(left.lastElementChild!.dataset.kcsLiveTurn).toBe('1');
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
