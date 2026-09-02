/**
 * 示例测试（任务 12.6）：排行页在 1.x 布局下新增的两块 UI ——
 * **排行表之上的三个聚合维度**（任务 12.1）与**每行的 MigrationStatus**（任务 12.2）。
 *
 * 取证方式分三层，从强到弱：
 *
 *   1. **把整段内联脚本放进 DOM 替身里真正执行**，并捕获 `window` 的 message 监听器与
 *      各元素的 click 监听器，从而能像用户那样驱动状态机：下发 `aggregate` 消息、点击
 *      「统计」按钮、下发 `layout` 消息。断言到的是线上那一份分支逻辑，不是正则考古。
 *      （harness 与 `tests/webview.inline-script.spec.ts` 同一手法，这里额外记录监听器。）
 *   2. 文案与 tooltip 的**内容**直接调用导出的纯函数 `aggregateDisplay` /
 *      `migrationStatusCell` —— webview 侧跑的就是它们（`toString()` 注入），两侧同源。
 *   3. 骨架结构与 CSP 对 `getRankingHtml()` 的产出做字符串断言。
 *
 * 编译期重写泄漏（design D9 的那个坑）不在本文件重复覆盖：
 * `tests/webview.inline-script.spec.ts` 的 CJS 路径执行的是**整段**脚本，
 * 本次新增的 `aggregateDisplay` / `migrationStatusCell` 及其两个注入常量因此自动被它守住。
 *
 * _Requirements: 7.8, 7.9, 7.11, 7.12, 7.14, 8.2, 8.3, 8.6, 9.6_
 */
import { describe, it, expect } from 'vitest';

import {
  getRankingHtml,
  aggregateDisplay,
  migrationStatusCell,
  renderRankingRowHtml,
  aggregateViewOf,
  legacyResidueViewOf,
  projectSessionViewOf,
  type AggregateView,
  type RankingRow,
} from '../src/storage/ranking';
import { getWebviewHtml } from '../src/webview';

const CSP_SOURCE = 'vscode-webview://kcs-ranking-newlayout';
const NONCE = 'kcs-newlayout-nonce-0001';
const HTML = getRankingHtml(CSP_SOURCE, NONCE);

/* ------------------------------------------------------------------ *
 * 0. DOM 替身 + 监听器捕获
 * ------------------------------------------------------------------ */

type Handler = (arg?: unknown) => void;

interface StubEl {
  id: string;
  textContent: string;
  innerHTML: string;
  title: string;
  disabled: boolean;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: { length: number };
  classes: Set<string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    contains(c: string): boolean;
    toggle(c: string, on?: boolean): boolean;
  };
  handlers: Map<string, Handler[]>;
  addEventListener(type: string, h: Handler): void;
  querySelectorAll(): StubEl[];
  querySelector(): null;
  closest(): null;
}

function makeEl(id: string): StubEl {
  const classes = new Set<string>();
  const handlers = new Map<string, Handler[]>();
  return {
    id,
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    style: {},
    dataset: {},
    children: { length: 0 },
    classes,
    classList: {
      add: (c) => void classes.add(c),
      remove: (c) => void classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
    },
    handlers,
    addEventListener: (type, h) => {
      const list = handlers.get(type) ?? [];
      list.push(h);
      handlers.set(type, list);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
  };
}

interface Harness {
  el(id: string): StubEl;
  posted: Array<Record<string, unknown>>;
  /** 向 webview 投递一条宿主消息 */
  send(message: Record<string, unknown>): void;
  /** 点击某个元素（触发它注册的第一个 click 监听器） */
  click(id: string): void;
}

/** 取 `<script nonce>` 与 `</script>` 之间的脚本原文。 */
function extractScript(html: string, nonce: string): string {
  const open = `<script nonce="${nonce}">`;
  const i = html.indexOf(open);
  expect(i, '未找到带 nonce 的 script 开标签').toBeGreaterThanOrEqual(0);
  const j = html.indexOf('</script>', i + open.length);
  expect(j, '未找到 script 闭标签').toBeGreaterThan(i);
  return html.slice(i + open.length, j);
}

/** 在 DOM 替身里执行整段内联脚本，返回可驱动它的把手。 */
function boot(html: string = HTML, nonce: string = NONCE): Harness {
  const byId = new Map<string, StubEl>();
  const el = (id: string): StubEl => {
    let found = byId.get(id);
    if (!found) {
      found = makeEl(id);
      byId.set(id, found);
    }
    return found;
  };

  const posted: Array<Record<string, unknown>> = [];
  const windowHandlers = new Map<string, Handler[]>();

  const documentStub = {
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [] as StubEl[],
    createElement: (tag: string) => makeEl(tag),
    addEventListener: () => {},
  };
  const windowStub = {
    addEventListener: (type: string, h: Handler) => {
      const list = windowHandlers.get(type) ?? [];
      list.push(h);
      windowHandlers.set(type, list);
    },
  };
  const api = {
    postMessage: (m: Record<string, unknown>) => void posted.push(m),
    getState: () => undefined,
    setState: () => {},
  };

  const fn = new Function(
    'document',
    'window',
    'acquireVsCodeApi',
    'setTimeout',
    'clearTimeout',
    extractScript(html, nonce)
  );
  fn(
    documentStub,
    windowStub,
    () => api,
    () => 0,
    () => {}
  );

  return {
    el,
    posted,
    send: (message) => {
      const list = windowHandlers.get('message') ?? [];
      expect(list.length, '内联脚本未注册 message 监听器').toBeGreaterThan(0);
      for (const h of list) h({ data: message });
    },
    click: (id) => {
      const list = el(id).handlers.get('click') ?? [];
      expect(list.length, `元素 ${id} 未注册 click 监听器`).toBeGreaterThan(0);
      list[0]();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function okView(over: Partial<AggregateView> = {}): AggregateView {
  return {
    state: 'ok',
    bytes: 1024 * 1024 * 3,
    files: 120,
    sessionCount: 12,
    workspaceCount: 1,
    partial: false,
    skippedCount: 0,
    roots: ['/home/u/.kiro/sessions'],
    ...over,
  };
}

const ROW: RankingRow = {
  title: '一个会话',
  sessionId: 'sess_abc',
  jsonBytes: 2048,
  archiveBytesSelf: 3 * 1024 * 1024,
  totalBytes: 3 * 1024 * 1024 + 2048,
  mtimeMs: 1_700_000_000_000,
  origin: 'new',
};

/* ================================================================== *
 * 1. 骨架：三个维度 + 手动触发控件（Req 7.1、7.5、8.2）
 * ================================================================== */

describe('骨架 - 排行表之上的三个聚合维度（Req 7.1、7.5、8.2）', () => {
  it('三个维度各有容器与数值位，初始文案为「未统计」', () => {
    for (const id of ['aggProject', 'aggAllKiro', 'aggLegacy']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    for (const id of ['valProject', 'valAllKiro', 'valLegacy']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    // 骨架里的静态初值就是空闲态：脚本还没跑时页面也不该显示 0 B
    expect(HTML).toContain('<span class="agg-value muted" id="valProject">未统计</span>');
    expect(HTML).toContain('<span class="agg-value muted" id="valAllKiro">未统计</span>');
    expect(HTML).toContain('<span class="agg-value muted" id="valLegacy">未统计</span>');
    expect(HTML).toContain('当前项目会话');
    expect(HTML).toContain('整个 Kiro 会话');
    expect(HTML).toContain('旧格式残留');
  });

  it('只有两个重量级维度带手动触发按钮；当前项目维度没有按钮（它随排行数据一同下发）', () => {
    expect(HTML).toContain('id="btnAllKiro"');
    expect(HTML).toContain('id="btnLegacy"');
    expect(HTML).not.toContain('id="btnProject"');
  });

  it('CSP 与搜索面板逐字相同，且新增的聚合维度没有引入内联 on* 或外部资源（Req 7.14）', () => {
    const pick = (src: string) => {
      const start = '<meta http-equiv="Content-Security-Policy" content="';
      const i = src.indexOf(start);
      const j = src.indexOf('" />', i + start.length);
      return src.slice(i + start.length, j);
    };
    const expected = [
      `default-src 'none'`,
      `style-src ${CSP_SOURCE} 'unsafe-inline'`,
      `script-src 'nonce-${NONCE}'`,
      `font-src ${CSP_SOURCE}`,
      `img-src ${CSP_SOURCE} data:`,
    ].join('; ');
    const searchHtml = getWebviewHtml(
      { cspSource: CSP_SOURCE } as unknown as Parameters<typeof getWebviewHtml>[0],
      NONCE
    );

    expect(pick(HTML)).toBe(expected);
    expect(pick(HTML)).toBe(pick(searchHtml));
    expect([...HTML.matchAll(/<script/g)].length).toBe(1);
    expect(HTML).not.toMatch(/\son(click|load|error|keydown|mouse\w+)=/i);
  });
});

/* ================================================================== *
 * 2. 三态文案与控件禁用（Req 7.8、7.9）—— 在 DOM 替身里真正驱动
 * ================================================================== */

describe('三态 - 空闲 / 计算中 / 就绪（Req 7.8、7.9）', () => {
  it('启动后三个维度都停在空闲态，且一次触发消息都没发（未触发即不枚举）', () => {
    const h = boot();

    expect(h.el('valProject').textContent).toBe('未统计');
    expect(h.el('valAllKiro').textContent).toBe('未统计');
    expect(h.el('valLegacy').textContent).toBe('未统计');
    // 数值位是「弱化」样式：空闲态的 0 不该看起来像统计结论
    expect(h.el('valAllKiro').classList.contains('muted')).toBe(true);
    // Req 7.8 的关键：脚本启动只发 ready，绝不自己触发那两个重量级维度
    expect(h.posted.map((m) => m.type)).toEqual(['ready']);
    // 按钮初始可用，文案为「统计」
    expect(h.el('btnAllKiro').disabled).toBe(false);
    expect(h.el('btnAllKiro').textContent).toBe('统计');
  });

  it('点击触发 → 立刻进入计算中：文案「统计中…」、按钮禁用、并向宿主发 computeAggregate', () => {
    const h = boot();
    h.click('btnAllKiro');

    expect(h.el('valAllKiro').textContent).toBe('统计中…');
    expect(h.el('btnAllKiro').disabled).toBe(true);
    expect(h.posted).toContainEqual({ type: 'computeAggregate', kind: 'allKiro' });
    // 另外两个维度不受影响
    expect(h.el('valLegacy').textContent).toBe('未统计');
    expect(h.el('valProject').textContent).toBe('未统计');
  });

  it('计算中重复触发被忽略：只发出一条 computeAggregate（Req 7.9）', () => {
    const h = boot();
    h.click('btnAllKiro');
    h.click('btnAllKiro');
    h.click('btnAllKiro');

    const sent = h.posted.filter((m) => m.type === 'computeAggregate');
    expect(sent).toHaveLength(1);
  });

  it('数据到货 → 就绪态：数值位显示体积、按钮变「重新统计」并恢复可用', () => {
    const h = boot();
    h.click('btnAllKiro');
    h.send({ type: 'aggregate', kind: 'allKiro', view: okView() });

    expect(h.el('valAllKiro').textContent).toBe('3.0MB');
    expect(h.el('valAllKiro').classList.contains('muted')).toBe(false);
    expect(h.el('btnAllKiro').disabled).toBe(false);
    expect(h.el('btnAllKiro').textContent).toBe('重新统计');
    // tooltip 挂在容器上，含参与统计的数量
    expect(h.el('aggAllKiro').title).toContain('12 个会话');
  });

  it('取数失败 → 不可用态，且与「0 B 的就绪态」可区分', () => {
    const h = boot();
    h.send({ type: 'aggregate', kind: 'legacyResidue', view: okView({ state: 'unavailable', bytes: 0 }) });
    expect(h.el('valLegacy').textContent).toBe('不可用');

    const h2 = boot();
    h2.send({ type: 'aggregate', kind: 'legacyResidue', view: okView({ bytes: 0 }) });
    expect(h2.el('valLegacy').textContent).toBe('0B');
  });

  it('聚合维度统计期间表格照常可浏览：表格状态与分页控件不受影响（Req 7.9）', () => {
    const h = boot();
    h.send({ type: 'rows', rows: [ROW, { ...ROW, sessionId: 'b' }], partial: false, skippedCount: 0 });
    const pageInfoBefore = h.el('pageInfo').textContent;
    const prevBefore = h.el('prev').disabled;

    h.click('btnLegacy'); // 旧残留扫描可能持续数分钟

    expect(h.el('valLegacy').textContent).toBe('统计中…');
    // 表格侧一切照旧
    expect(h.el('pageInfo').textContent).toBe(pageInfoBefore);
    expect(h.el('prev').disabled).toBe(prevBefore);
    expect(h.el('rows').innerHTML).toContain('data-session-id="sess_abc"');
  });

  it('ProjectSessionTotal 随行数据一同到货（Req 7.3），不需要单独的消息', () => {
    const h = boot();
    h.send({
      type: 'rows',
      rows: [ROW],
      partial: false,
      skippedCount: 0,
      project: okView({ bytes: 4096, sessionCount: 1, roots: ['/ws/new', '/ws/old'] }),
    });

    expect(h.el('valProject').textContent).toBe('4.0KB');
    expect(h.el('aggProject').title).toContain('统计根：/ws/new');
    expect(h.el('aggProject').title).toContain('统计根：/ws/old');
  });

  it('表格进入 no-workspace / unavailable 时当前项目维度不再显示旧数值', () => {
    const h = boot();
    h.send({ type: 'rows', rows: [ROW], partial: false, skippedCount: 0, project: okView() });
    expect(h.el('valProject').textContent).toBe('3.0MB');

    h.send({ type: 'state', state: 'no-workspace' });
    expect(h.el('valProject').textContent).toBe('未统计');

    const h2 = boot();
    h2.send({ type: 'rows', rows: [ROW], partial: false, skippedCount: 0, project: okView() });
    h2.send({ type: 'state', state: 'unavailable' });
    expect(h2.el('valProject').textContent).toBe('不可用');
  });

  it('old-only 布局隐藏旧残留维度（Req 8.3），其余两个维度照常展示', () => {
    const h = boot();
    expect(h.el('aggLegacy').classList.contains('hidden')).toBe(false);

    h.send({ type: 'layout', layout: 'old-only' });
    expect(h.el('aggLegacy').classList.contains('hidden')).toBe(true);
    expect(h.el('aggAllKiro').classList.contains('hidden')).toBe(false);
    expect(h.el('aggProject').classList.contains('hidden')).toBe(false);

    // both / new-only 不隐藏
    h.send({ type: 'layout', layout: 'both' });
    expect(h.el('aggLegacy').classList.contains('hidden')).toBe(false);
  });

  it('未知 kind 的 aggregate 消息被忽略，不污染任何维度', () => {
    const h = boot();
    h.send({ type: 'aggregate', kind: 'nope', view: okView() });

    expect(h.el('valProject').textContent).toBe('未统计');
    expect(h.el('valAllKiro').textContent).toBe('未统计');
    expect(h.el('valLegacy').textContent).toBe('未统计');
  });
});

/* ================================================================== *
 * 3. tooltip 内容（Req 7.11、7.12、8.6、8.7）
 * ================================================================== */

describe('tooltip - 口径、拆解、根路径与下限标注（Req 7.11、7.12）', () => {
  it('就绪态给出会话数、工作区目录数、文件数与被统计根路径', () => {
    const d = aggregateDisplay('allKiro', okView({ workspaceCount: 7, files: 2856 }));
    expect(d.value).toBe('3.0MB');
    expect(d.title).toContain('整个 Kiro 会话总占用');
    expect(d.title).toContain('12 个会话');
    expect(d.title).toContain('7 个工作区目录');
    expect(d.title).toContain('2856 个文件');
    expect(d.title).toContain('统计根：/home/u/.kiro/sessions');
  });

  it('给出会话本体与快照两部分的字节数拆解（Req 7.11）', () => {
    const d = aggregateDisplay(
      'project',
      okView({ bytes: 3072, sessionBytes: 1024, attachmentBytes: 2048 })
    );
    expect(d.title).toContain('其中会话本体 1.0KB + 快照/附件 2.0KB');
  });

  it('partial 时数值加 ≥ 前缀并在 tooltip 给出 skippedCount（Req 7.12）', () => {
    const d = aggregateDisplay('allKiro', okView({ partial: true, skippedCount: 5 }));
    expect(d.value).toBe('≥3.0MB');
    expect(d.title).toContain('已跳过 5 个条目');
    expect(d.title).toContain('下限');
  });

  it('both 下当前项目维度说明「旧格式残留未计入本合计」（Req 6.7 / design D7）', () => {
    const d = aggregateDisplay('project', okView({ supersededBytes: 5000 }));
    expect(d.title).toContain('未计入本合计');
    expect(d.title).toContain('单个会话行显示的占用小于它在磁盘上的实际总和');

    // 没有被剔除的旧份时不出现这句，避免无谓的告警噪音
    expect(aggregateDisplay('project', okView({ supersededBytes: 0 })).title).not.toContain(
      '未计入本合计'
    );
  });

  it('旧残留维度给出两分与「独立于整个 Kiro」「1.x 界面不可见」两条说明（Req 8.6、8.7）', () => {
    const d = aggregateDisplay(
      'legacyResidue',
      okView({ migratedResidueBytes: 1024, unmigratedBytes: 2048 })
    );
    expect(d.title).toContain('已迁移仅残留 1.0KB（可清理）');
    expect(d.title).toContain('未迁移或无法按会话归属 2.0KB（默认不清理）');
    expect(d.title).toContain('相互独立');
    expect(d.title).toContain('默认不计入');
    expect(d.title).toContain('1.x 界面中不可见');
  });

  it('空闲态的 tooltip 也说清这个维度是什么、以及此刻不会枚举（Req 7.8）', () => {
    const d = aggregateDisplay('legacyResidue', { state: 'idle' });
    expect(d.value).toBe('未统计');
    expect(d.title).toContain('旧格式残留');
    expect(d.title).toContain('不会枚举对应目录');
  });

  it('坏输入不抛错：缺字段 / 非对象 / 未知 kind 都退化为可展示的文本', () => {
    expect(() => aggregateDisplay('project', undefined)).not.toThrow();
    expect(aggregateDisplay('project', undefined).value).toBe('未统计');
    expect(aggregateDisplay('nope', okView()).value).toBe('3.0MB');
    expect(aggregateDisplay(undefined, { state: 'ok', bytes: NaN }).value).toBe('0B');
  });
});

/* ================================================================== *
 * 4. 视图映射（宿主侧的三个适配器）
 * ================================================================== */

describe('视图映射 - AggregateTotal / LegacyResidueTotal / MergedRankingRows', () => {
  const base = {
    state: 'ok' as const,
    bytes: 100,
    files: 4,
    sessionCount: 2,
    workspaceCount: 3,
    partial: true,
    skippedCount: 1,
    roots: ['/a'],
  };

  it('aggregateViewOf 逐字段搬运，并对 roots 取副本', () => {
    const view = aggregateViewOf(base);
    expect(view).toEqual({ ...base, roots: ['/a'] });
    view.roots.push('/tampered');
    expect(base.roots).toEqual(['/a']);
  });

  it('legacyResidueViewOf 追加两分字段', () => {
    const view = legacyResidueViewOf({ ...base, migratedResidueBytes: 60, unmigratedBytes: 40 });
    expect(view.migratedResidueBytes).toBe(60);
    expect(view.unmigratedBytes).toBe(40);
  });

  it('projectSessionViewOf 汇总被剔除的旧份，并按观测到的侧决定 state', () => {
    const merged = {
      totalBytes: 300,
      sessionBytes: 200,
      attachmentBytes: 100,
      files: 9,
      sessionCount: 3,
      partial: false,
      skippedCount: 0,
      roots: ['/new', '/old'],
      sides: { newLayout: true, oldLayout: true },
      residue: { superseded: [{ bytes: 10 }, { bytes: 25 }, { bytes: Number.NaN }] },
    };

    const view = projectSessionViewOf(merged);
    expect(view.state).toBe('ok');
    expect(view.workspaceCount).toBe(1);
    expect(view.sessionBytes).toBe(200);
    expect(view.attachmentBytes).toBe(100);
    // NaN 按 0 计，不产生 NaN 合计
    expect(view.supersededBytes).toBe(35);

    const unobserved = projectSessionViewOf({
      ...merged,
      sides: { newLayout: false, oldLayout: false },
    });
    expect(unobserved.state).toBe('unavailable');
    expect(unobserved.workspaceCount).toBe(0);
  });
});

/* ================================================================== *
 * 5. MigrationStatus（Req 9.6）
 * ================================================================== */

describe('MigrationStatus - 三种取值的渲染（Req 9.6）', () => {
  it('三种取值各有标签，tooltip 说明含义与该会话数据所在根目录', () => {
    const n = migrationStatusCell('new');
    expect(n.key).toBe('new');
    expect(n.label).toBe('1.x 新建');
    expect(n.title).toContain('~/.kiro/sessions');

    const m = migrationStatusCell('migrated');
    expect(m.label).toBe('已迁移');
    expect(m.title).toContain('~/.kiro/sessions');
    // 已迁移必须点明「本行占用不含旧份」，否则用户会把可释放空间估少
    expect(m.title).toContain('不计入本行占用');

    const l = migrationStatusCell('legacy-unmigrated');
    expect(l.label).toBe('未迁移');
    expect(l.title).toContain('workspace-sessions');
    // 唯一带破坏性后果的取值：必须写明不可见与不可恢复
    expect(l.title).toContain('不可见');
    expect(l.title).toContain('不可恢复');
  });

  it('取值超出三者时给中性的「未知」，不抛错也不渲染成空白', () => {
    const u = migrationStatusCell('something-else');
    expect(u.key).toBe('unknown');
    expect(u.label).toBe('未知');
    expect(migrationStatusCell(undefined).key).toBe('unknown');
    expect(migrationStatusCell(42).key).toBe('unknown');
  });

  it('行渲染出来源单元格，class 与 origin 对应，且文本经转义', () => {
    const html = renderRankingRowHtml({ ...ROW, origin: 'legacy-unmigrated' }, false);
    expect(html).toContain('<td class="c-origin">');
    expect(html).toContain('class="mig mig-legacy-unmigrated"');
    expect(html).toContain('>未迁移</span>');

    // 三种取值各自的 class 都能出现
    expect(renderRankingRowHtml({ ...ROW, origin: 'new' }, false)).toContain('mig-new');
    expect(renderRankingRowHtml({ ...ROW, origin: 'migrated' }, false)).toContain('mig-migrated');

    // class 恒为受控 ASCII：宿主 JSON 里的任意字符串不会进 class 属性
    const bad = renderRankingRowHtml(
      { ...ROW, origin: '"><script>' as unknown as RankingRow['origin'] },
      false
    );
    expect(bad).toContain('mig-unknown');
    expect(bad).not.toContain('<script>');
  });

  it('来源列不参与排序：列结构变了而排序键仍只有 totalBytes / mtimeMs / sessionId', () => {
    // 同一批数据、只有 origin 不同 → 渲染出的排序相关单元格逐字相同
    const a = renderRankingRowHtml({ ...ROW, origin: 'new' }, false);
    const b = renderRankingRowHtml({ ...ROW, origin: 'migrated' }, false);
    const nums = (html: string) => [...html.matchAll(/<td class="c-(num|total|time)[^"]*">([^<]*)</g)].map((m) => m[2]);
    expect(nums(a)).toEqual(nums(b));
  });
});
