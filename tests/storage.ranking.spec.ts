import { describe, it, expect, afterEach } from 'vitest';
import { Module as NodeModule } from 'module';
import { getWebviewHtml } from '../src/webview';
import {
  getRankingHtml,
  renderRankingRowHtml,
  RANKING_PAGE_SIZE,
  RANKING_PANEL_VIEW_TYPE,
  RankingPanel,
  pageOf,
  type RankingRow,
  type RankingPanelDeps,
  type RankingCleanupMode,
} from '../src/storage/ranking';

/**
 * 任务 16.6 的示例测试：锁定 **UsageRankingPage 的面板生命周期、CSP、三态控件禁用与
 * 行内清理入口**。
 *
 * 取证方式（vitest 是 node 环境：没有 DOM、也没有 `vscode` 模块）：
 *
 *   1. CSP / 骨架结构 / 默认文案 → 对 `getRankingHtml(cspSource, nonce)` 产出的
 *      HTML 串做断言（并与搜索面板 `getWebviewHtml()` 的 CSP 逐字比对，证明"同一套"）；
 *   2. 状态机的控件禁用 → 把内联脚本里的 `canInteract` / `canRefresh` / `syncControls`
 *      三个函数的**源码原文**摘出来，注入极简元素替身后**真正执行**。这三个函数写在
 *      HTML 模板里（不是 `toString()` 注入的宿主纯函数），不引用任何模块作用域符号，
 *      因此可以脱离 DOM 跑，断言到的是真实分支而不是正则考古；
 *   3. 行渲染与清理入口 → 直接调用导出的纯函数 `renderRankingRowHtml`；
 *   4. 面板单例 / reveal 保持状态 / 关闭后重开 / 五态取数时序 → `RankingPanel` 通过
 *      惰性 `require('vscode')` 取运行时 API，故本文件在调用前用 `Module._load` 钩子
 *      供给一个 vscode 替身（`window.createWebviewPanel` / `ViewColumn` / `Uri.joinPath`），
 *      调用后立即恢复。这样就不必给 vitest 配 `vscode` 别名（配置文件不在本任务范围内），
 *      也不必退化成对源码文本的考古。
 *
 * 随机输入空间上的取数、行渲染、分页切片与比较函数全序性由
 * tests/storage.ranking.property.spec.ts（Property 24/25/26）覆盖，这里只钉具体结构、
 * 具体文案与具体时序。
 *
 * Requirements: 13.1, 13.4, 13.9, 13.11, 13.12, 13.13, 13.15, 13.16
 */

const CSP_SOURCE = 'vscode-webview://kcs-ranking-test';
const NONCE = 'kcs-test-nonce-ranking-0001';
const HTML = getRankingHtml(CSP_SOURCE, NONCE);

/** 取 (start, end) 之间的内容（不含两端标记本身） */
function inner(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `未找到起始标记：${start}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `未找到结束标记：${end}`).toBeGreaterThan(i);
  return src.slice(i + start.length, j);
}

/** 摘出内联脚本里某个函数声明的完整源码（花括号配平，跳过字符串字面量） */
function fnSrc(src: string, name: string): string {
  const head = `function ${name}(`;
  const i = src.indexOf(head);
  expect(i, `未找到函数 ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let started = false;
  let quote: string | null = null;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (quote) {
      if (c === '\\') { k++; continue; }
      if (c === quote) { quote = null; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') { depth++; started = true; continue; }
    if (c === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号未闭合`);
}

const SCRIPT = inner(HTML, `<script nonce="${NONCE}">`, '</script>');
const CAN_INTERACT_SRC = fnSrc(SCRIPT, 'canInteract');
const CAN_REFRESH_SRC = fnSrc(SCRIPT, 'canRefresh');
const SYNC_SRC = fnSrc(SCRIPT, 'syncControls');

/** 五态文案表：直接取内联脚本里的对象字面量求值，避免测试里另抄一份文案 */
const STATE_TEXT = new Function(
  'return {' + inner(SCRIPT, 'const STATE_TEXT = {', '};') + '}'
)() as Record<string, string>;

/* ------------------------------------------------------------------ *
 * 1. CSP：与搜索面板逐字同一套（Req 13.13）
 * ------------------------------------------------------------------ */

describe('CSP - 与搜索面板同一套（Req 13.13）', () => {
  const expected = [
    `default-src 'none'`,
    `style-src ${CSP_SOURCE} 'unsafe-inline'`,
    `script-src 'nonce-${NONCE}'`,
    `font-src ${CSP_SOURCE}`,
    `img-src ${CSP_SOURCE} data:`,
  ].join('; ');

  it('meta 的 CSP 恒为固定的五条指令', () => {
    expect(HTML).toContain(`<meta http-equiv="Content-Security-Policy" content="${expected}" />`);
  });

  it('与 getWebviewHtml 在同一 cspSource / nonce 下产出完全相同的 CSP 串', () => {
    const searchHtml = getWebviewHtml(
      { cspSource: CSP_SOURCE } as unknown as Parameters<typeof getWebviewHtml>[0],
      NONCE
    );
    const pick = (src: string) =>
      inner(src, '<meta http-equiv="Content-Security-Policy" content="', '" />');
    expect(pick(HTML)).toBe(pick(searchHtml));
    expect(pick(HTML)).toBe(expected);
  });

  it('唯一的 script 带 nonce，且页面无外部资源、无 eval、无内联 on* 属性', () => {
    expect([...HTML.matchAll(/<script/g)].length).toBe(1);
    expect(HTML).toContain(`<script nonce="${NONCE}">`);
    expect(HTML).not.toMatch(/<script[^>]+src=/);
    expect(HTML).not.toMatch(/\bsrc=["']https?:/);
    expect(HTML).not.toMatch(/\beval\s*\(/);
    expect(HTML).not.toMatch(/\son(click|load|error|keydown|mouse\w+)=/i);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 骨架结构、默认态与行内清理入口（Req 13.3、13.9、13.11）
 * ------------------------------------------------------------------ */

describe('骨架 - 表头 + 分页控件 + 刷新（Req 13.3、13.9、9.6）', () => {
  // 任务 12.2 在「会话标题」之后插入了 MigrationStatus 的「来源」列（Req 9.6）。
  // 断言仍是精确等值的列名序列，只是多了一项——没有放宽成 `toContain` 之类。
  it('表头各列 + 操作列按顺序出现，占用合计列可点击排序', () => {
    const thead = inner(HTML, '<thead>', '</thead>');
    const cols = [...thead.matchAll(/<th[^>]*>([^<]*)/g)].map((m) => m[1].trim());
    expect(cols).toEqual([
      '会话标题',
      '来源',
      'sessionId',
      '会话 JSON',
      '归因存档',
      '占用合计',
      '最后修改',
      '操作',
    ]);
    expect(thead).toContain('id="thTotal" class="c-num sortable"');
  });

  it('初始渲染即为 loading：页码指示为「第 1 / 1 页 · 共 0 个会话」，上下页禁用', () => {
    expect(HTML).toContain('<div id="status" class="status">统计中…</div>');
    expect(HTML).toContain('<div id="empty" class="empty">统计中…</div>');
    expect(HTML).toContain(
      '<span id="pageInfo" class="page-info">第 1 / 1 页 · 共 0 个会话</span>'
    );
    expect(HTML).toContain('<button id="prev" class="page-btn" type="button" disabled>上一页</button>');
    expect(HTML).toContain('<button id="next" class="page-btn" type="button" disabled>下一页</button>');
    expect(HTML).toContain('id="refresh"');
    // 表头与分页控件的结构与状态无关：空态/无工作区态只置灰，不重建
    expect(SCRIPT).not.toMatch(/\$(thTotal|prev|next|pageInfo)\.remove\(/);
  });

  it('实例内的展示状态初值为第 1 页 + desc（关闭后重开即回到此处，Req 13.1）', () => {
    expect(SCRIPT).toContain(`let sortOrder = 'desc';`);
    expect(SCRIPT).toContain('let page = 1;');
    expect(RANKING_PAGE_SIZE).toBe(50);
  });
});

describe('行内清理入口 - 每行两个（Req 13.11）', () => {
  const row: RankingRow = {
    title: 'A & <b>标题</b>',
    sessionId: 'sess-1',
    jsonBytes: 2048,
    archiveBytesSelf: 3 * 1024 * 1024,
    totalBytes: 3 * 1024 * 1024 + 2048,
    mtimeMs: Date.UTC(2024, 4, 6, 3, 4),
  };

  it('渲染出 attachment / full 两个按钮，且按钮不带内联 on* 处理器', () => {
    const html = renderRankingRowHtml(row, false);
    const modes = [...html.matchAll(/<button class="op[^"]*"[^>]*data-mode="([a-z]+)"/g)].map(
      (m) => m[1]
    );
    expect(modes).toEqual(['attachment', 'full']);
    expect(html).toContain('清理存档');
    expect(html).toContain('删除会话');
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it('点击按钮只上报 cleanup 消息（mode/sessionId/title），删除动作全在宿主侧', () => {
    const handler = inner(SCRIPT, `$rows.addEventListener('click'`, '});');
    expect(handler).toContain(`type: 'cleanup'`);
    expect(handler).toContain(`mode: btn.dataset.mode === 'full' ? 'full' : 'attachment'`);
    expect(handler).toContain('tr.dataset.sessionId');
    expect(handler).toContain('tr.dataset.title');
    // 禁用态与非 ok 态下不上报（Req 13.15）
    expect(handler).toContain('if (!btn || btn.disabled || !canInteract()) return;');
  });

  it('标题与 sessionId 经转义后插入 DOM（Req 13.13）', () => {
    const html = renderRankingRowHtml({ ...row, sessionId: 'a"><script>' }, false);
    expect(html).toContain('A &amp; &lt;b&gt;标题&lt;/b&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('partial 时 ≥ 只加在归因存档与占用合计两列（Req 13.10）', () => {
    const cells = (html: string) => [...html.matchAll(/<td class="c-num[^"]*">([^<]*)</g)].map((m) => m[1]);
    expect(cells(renderRankingRowHtml(row, false))).toEqual(['2.0KB', '3.0MB', '3.0MB']);
    expect(cells(renderRankingRowHtml(row, true))).toEqual(['2.0KB', '≥3.0MB', '≥3.0MB']);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 三态的控件禁用与文案（Req 13.9、13.15、13.16）
 *
 * 把内联脚本里的 canInteract / canRefresh / syncControls 原文摘出来真跑一遍：
 * 三者只依赖 state / view / STATE_TEXT 与几个元素替身，不需要真实 DOM。
 * ------------------------------------------------------------------ */

function fakeEl() {
  const cls = new Set<string>();
  return {
    textContent: '',
    disabled: false,
    style: {} as Record<string, string>,
    classList: {
      toggle(name: string, on?: boolean) {
        const next = on === undefined ? !cls.has(name) : on;
        if (next) { cls.add(name); } else { cls.delete(name); }
        return next;
      },
      contains: (name: string) => cls.has(name),
    },
    has: (name: string) => cls.has(name),
  };
}

/** 以给定状态执行一次 syncControls，返回各控件替身的终态 */
function runSync(
  state: string,
  view: { page: number; totalPages: number; total: number },
  renderedRowCount: number
) {
  const $status = fakeEl();
  const $empty = fakeEl();
  const $prev = fakeEl();
  const $next = fakeEl();
  const $thTotal = fakeEl();
  const $refresh = fakeEl();
  // 每行两个清理按钮（清理存档 / 删除会话）
  const ops = Array.from({ length: renderedRowCount * 2 }, () => ({ disabled: false }));
  const $rows = {
    children: { length: renderedRowCount },
    querySelectorAll: (sel: string) => (sel === 'button.op' ? ops : []),
  };

  const run = new Function(
    'state',
    'view',
    'STATE_TEXT',
    '$status',
    '$empty',
    '$prev',
    '$next',
    '$thTotal',
    '$refresh',
    '$rows',
    [CAN_INTERACT_SRC, CAN_REFRESH_SRC, SYNC_SRC, 'syncControls();'].join('\n')
  );
  run(state, view, STATE_TEXT, $status, $empty, $prev, $next, $thTotal, $refresh, $rows);

  return { $status, $empty, $prev, $next, $thTotal, $refresh, ops };
}

const VIEW_EMPTY = { page: 1, totalPages: 1, total: 0 };

describe('状态机文案 - 三态各自的固定文案（Req 13.9、13.15、13.16）', () => {
  it('STATE_TEXT 恒含 loading / empty / no-workspace / unavailable 四条文案', () => {
    expect(STATE_TEXT).toEqual({
      loading: '统计中…',
      empty: '当前项目还没有可统计的会话',
      'no-workspace': '未打开工作区，无法统计会话占用',
      unavailable: '占用统计不可用',
    });
    // 'ok' 不在表内：它的文案按行数动态拼，且恒由数据到货那一刻进入
    expect(STATE_TEXT.ok).toBeUndefined();
    expect(SCRIPT).toContain(`state = allRows.length > 0 ? 'ok' : 'empty';`);
  });
});

describe('loading 态 - 排序/翻页/刷新/清理全禁用，保留已渲染的行（Req 13.15）', () => {
  it('已有行时只置灰：不清表、不显示占位文案，刷新图标转圈', () => {
    const r = runSync('loading', { page: 2, totalPages: 3, total: 120 }, 3);
    expect(r.$status.textContent).toBe('统计中…');
    expect(r.$prev.disabled).toBe(true);
    expect(r.$next.disabled).toBe(true);
    expect(r.$thTotal.has('disabled')).toBe(true);
    expect(r.$refresh.has('disabled')).toBe(true);
    expect(r.$refresh.has('spinning')).toBe(true);
    expect(r.ops.every((b) => b.disabled)).toBe(true);
    expect(r.$empty.style.display).toBe('none');
  });

  it('尚无行时展示「统计中…」占位', () => {
    const r = runSync('loading', VIEW_EMPTY, 0);
    expect(r.$empty.textContent).toBe('统计中…');
    expect(r.$empty.style.display).toBe('block');
  });

  it('面板始终可关闭：脚本里没有任何阻断关闭的钩子', () => {
    expect(SCRIPT).not.toMatch(/beforeunload|preventDefault\(\)\s*;?\s*\/\/\s*close/);
  });
});

describe('empty 态 - 空态文案 + 结构保留，刷新仍可用（Req 13.9）', () => {
  it('展示空态文案、禁用排序与翻页，刷新保持可用', () => {
    const r = runSync('empty', VIEW_EMPTY, 0);
    expect(r.$status.textContent).toBe('当前项目还没有可统计的会话');
    expect(r.$empty.textContent).toBe('当前项目还没有可统计的会话');
    expect(r.$empty.style.display).toBe('block');
    expect(r.$prev.disabled).toBe(true);
    expect(r.$next.disabled).toBe(true);
    expect(r.$thTotal.has('disabled')).toBe(true);
    expect(r.$refresh.has('disabled')).toBe(false);
    expect(r.$refresh.has('spinning')).toBe(false);
  });

  it('K = 0 时页码指示仍为「第 1 / 1 页 · 共 0 个会话」', () => {
    const p = pageOf([], 'desc', 1);
    expect([p.page, p.totalPages, p.total]).toEqual([1, 1, 0]);
    expect(SCRIPT).toContain(
      `'第 ' + p.page + ' / ' + p.totalPages + ' 页 · 共 ' + p.total + ' 个会话'`
    );
  });
});

describe('no-workspace 态 - 结构保留置灰，连刷新都禁用（Req 13.16）', () => {
  it('展示无工作区文案，排序/翻页/刷新/清理全禁用', () => {
    const r = runSync('no-workspace', VIEW_EMPTY, 0);
    expect(r.$status.textContent).toBe('未打开工作区，无法统计会话占用');
    expect(r.$empty.textContent).toBe('未打开工作区，无法统计会话占用');
    expect(r.$prev.disabled).toBe(true);
    expect(r.$next.disabled).toBe(true);
    expect(r.$thTotal.has('disabled')).toBe(true);
    expect(r.$refresh.has('disabled')).toBe(true);
  });

  it('canRefresh 只在 loading / no-workspace 两态为假；canInteract 只在 ok 为真', () => {
    const call = (name: string, state: string) =>
      new Function('state', `${CAN_INTERACT_SRC}\n${CAN_REFRESH_SRC}\nreturn ${name}();`)(state);
    for (const s of ['ok', 'empty', 'unavailable']) {
      expect(call('canRefresh', s), `${s} 应可刷新`).toBe(true);
    }
    for (const s of ['loading', 'no-workspace']) {
      expect(call('canRefresh', s), `${s} 应禁用刷新`).toBe(false);
    }
    expect(call('canInteract', 'ok')).toBe(true);
    for (const s of ['loading', 'empty', 'no-workspace', 'unavailable']) {
      expect(call('canInteract', s), `${s} 不应可交互`).toBe(false);
    }
  });
});

describe('ok 态 - 分页边界按 M / N 禁用（Req 13.7）', () => {
  it('M = 1 禁上一页；M = N 禁下一页；中间页两侧都可用', () => {
    const first = runSync('ok', { page: 1, totalPages: 3, total: 120 }, 50);
    expect([first.$prev.disabled, first.$next.disabled]).toEqual([true, false]);

    const mid = runSync('ok', { page: 2, totalPages: 3, total: 120 }, 50);
    expect([mid.$prev.disabled, mid.$next.disabled]).toEqual([false, false]);

    const last = runSync('ok', { page: 3, totalPages: 3, total: 120 }, 20);
    expect([last.$prev.disabled, last.$next.disabled]).toEqual([false, true]);

    expect(last.$thTotal.has('disabled')).toBe(false);
    expect(last.ops.every((b) => b.disabled)).toBe(false);
    expect(last.$empty.style.display).toBe('none');
  });

  it('unavailable 态走错误配色且刷新可用（Req 9.3）', () => {
    const r = runSync('unavailable', VIEW_EMPTY, 0);
    expect(r.$status.textContent).toBe('占用统计不可用');
    expect(r.$status.has('error')).toBe(true);
    expect(r.$refresh.has('disabled')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 恒 self 口径，且与搜索面板 Σ(creditMode) 状态互不相干（Req 13.4）
 * ------------------------------------------------------------------ */

describe('口径 - 恒 self，不读写搜索面板的 Σ 状态（Req 13.4）', () => {
  it('页面文案自述"自身口径可相加"，且不含任何口径切换控件', () => {
    expect(SCRIPT).toContain(`'共 ' + view.total + ' 个会话 · 自身口径，各行数值可相加'`);
    expect(HTML).not.toContain('creditMode');
    expect(HTML).not.toContain('Σ');
    expect(HTML).not.toContain('lineage');
    expect(HTML).not.toContain('累计口径');
  });

  it('webview 的 setState 只存 page / sortOrder，不碰 creditMode', () => {
    const save = fnSrc(SCRIPT, 'saveState');
    expect(save).toContain('vscode.setState && vscode.setState({ page: page, sortOrder: sortOrder })');
    expect(save).not.toContain('creditMode');
    // 只看还原逻辑读了 vscode.getState() 的哪些字段（`\b` 避开 classList.toggle 这类巧合）
    const restored = [...SCRIPT.matchAll(/\bst\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(restored)].sort()).toEqual(['page', 'sortOrder']);
  });

  // 任务 12.1 与 14.3 各新增一种上行消息：`computeAggregate`（两个重量级聚合维度的手动
  // 触发，Req 7.5、8.2）与 `cleanupLegacyResidue`（旧残留清理入口，Req 11.1）。
  // 断言仍是精确等值的集合，本条要钉的性质没变：**排序与页码不回宿主**——上行集合里恒
  // 不出现 sort / page 之类的消息类型，翻页与换序全在 webview 侧完成。
  it('上行消息恒为 ready / refresh / cleanup / computeAggregate / cleanupLegacyResidue（排序与页码不回宿主，Req 7.13）', () => {
    const types = [...SCRIPT.matchAll(/vscode\.postMessage\(\{\s*type:\s*'([\w-]+)'/g)].map(
      (m) => m[1]
    );
    expect([...new Set(types)].sort()).toEqual([
      'cleanup',
      'cleanupLegacyResidue',
      'computeAggregate',
      'ready',
      'refresh',
    ]);
    // 排序 / 页码类消息恒不存在（本条的真正性质）
    for (const t of types) expect(t).not.toMatch(/sort|page/i);
  });

  it('行数据不含累计口径字段，避免"两列可相加"的误用', () => {
    const html = renderRankingRowHtml(
      {
        title: 't',
        sessionId: 's',
        jsonBytes: 1,
        archiveBytesSelf: 2,
        totalBytes: 3,
        mtimeMs: 0,
      },
      false
    );
    expect(html).not.toContain('lineage');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 换序与翻页只在 webview 侧完成（Req 13.8、13.12、7.13）
 * ------------------------------------------------------------------ */

describe('换序与刷新 - 换序回到第 1 页，刷新保持方向（Req 13.8、13.12）', () => {
  it('toggleSort 只翻转 sortOrder 并把 page 置 1，不发消息回宿主', () => {
    const toggle = fnSrc(SCRIPT, 'toggleSort');
    expect(toggle).toContain(`sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';`);
    expect(toggle).toContain('page = 1;');
    expect(toggle).toContain('if (!canInteract()) return;');
    expect(toggle).not.toContain('postMessage');
  });

  it('rows 消息不携带 sortOrder / page：刷新因此不会改变当前排序方向', () => {
    const branch = inner(SCRIPT, `if (m.type === 'rows')`, `} else if (m.type === 'state')`);
    expect(branch).toContain('allRows = Array.isArray(m.rows) ? m.rows : [];');
    expect(branch).toContain('partial = m.partial === true;');
    expect(branch).not.toContain('sortOrder =');
    expect(branch).not.toContain('page = 1');
  });

  it('state 消息只在 no-workspace / unavailable 清空并回到第 1 页，loading 不清', () => {
    const branch = inner(SCRIPT, `} else if (m.type === 'state')`, '});');
    expect(branch).toContain('if (!STATE_TEXT[m.state]) return;');
    expect(branch).toContain(`if (state === 'no-workspace' || state === 'unavailable')`);
    const guarded = inner(branch, `state === 'unavailable') {`, '}');
    expect(guarded).toContain('allRows = [];');
    expect(guarded).toContain('page = 1;');
  });
});

/* ------------------------------------------------------------------ *
 * 6. RankingPanel：单例、reveal 保持状态、关闭后重开、五态取数时序
 *
 * `ranking.ts` 用惰性 require('vscode') 取运行时 API，因此这里用 Module._load
 * 钩子供一个替身，调用结束立刻恢复（不污染其它测试文件）。
 * ------------------------------------------------------------------ */

type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };

function installVscodeStub(stub: unknown): () => void {
  const loader = NodeModule as unknown as Loader;
  const original = loader._load;
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') return stub;
    return original.call(this, request, parent, isMain);
  };
  return () => {
    loader._load = original;
  };
}

interface PanelStub {
  viewType: string;
  title: string;
  showOptions: unknown;
  options: Record<string, unknown>;
  htmlWrites: string[];
  messages: Record<string, unknown>[];
  reveals: { viewColumn: unknown; preserveFocus: unknown }[];
  disposeCalls: number;
  fireMessage(msg: unknown): void;
  fireDispose(): void;
  webview: Record<string, unknown>;
  reveal(viewColumn?: unknown, preserveFocus?: unknown): void;
  dispose(): void;
  onDidDispose(cb: () => void, thisArg?: unknown, disposables?: { dispose(): void }[]): unknown;
}

function makeEnv() {
  const created: PanelStub[] = [];

  const makePanel = (
    viewType: string,
    title: string,
    showOptions: unknown,
    options: Record<string, unknown>
  ): PanelStub => {
    let msgCb: ((raw: unknown) => void) | null = null;
    let disposeCb: (() => void) | null = null;
    const htmlWrites: string[] = [];
    const panel: PanelStub = {
      viewType,
      title,
      showOptions,
      options,
      htmlWrites,
      messages: [],
      reveals: [],
      disposeCalls: 0,
      webview: {
        cspSource: CSP_SOURCE,
        postMessage: (m: Record<string, unknown>) => {
          panel.messages.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage(
          cb: (raw: unknown) => void,
          _thisArg?: unknown,
          disposables?: { dispose(): void }[]
        ) {
          msgCb = cb;
          const d = { dispose() {} };
          disposables?.push(d);
          return d;
        },
      },
      onDidDispose(cb: () => void, _thisArg?: unknown, disposables?: { dispose(): void }[]) {
        disposeCb = cb;
        const d = { dispose() {} };
        disposables?.push(d);
        return d;
      },
      reveal(viewColumn?: unknown, preserveFocus?: unknown) {
        panel.reveals.push({ viewColumn, preserveFocus });
      },
      dispose() {
        panel.disposeCalls += 1;
      },
      fireMessage(msg: unknown) {
        msgCb?.(msg);
      },
      fireDispose() {
        disposeCb?.();
      },
    };
    Object.defineProperty(panel.webview, 'html', {
      get: () => htmlWrites[htmlWrites.length - 1] ?? '',
      set: (v: string) => {
        htmlWrites.push(v);
      },
    });
    return panel;
  };

  const vscodeStub = {
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base: unknown, ...parts: string[]) => ({ base, parts }) },
    window: {
      createWebviewPanel: (
        viewType: string,
        title: string,
        showOptions: unknown,
        options: Record<string, unknown>
      ) => {
        const p = makePanel(viewType, title, showOptions, options);
        created.push(p);
        return p;
      },
    },
  };

  const context = { extensionUri: { scheme: 'file', path: '/ext' } } as never;
  return { created, vscodeStub, context };
}

/** 可控的 analyzer 替身：记录调用参数，逐次手动兑付 */
function makeDeps(workspacePath: string | null = 'd:/ws') {
  const calls: { force: unknown; keys: string[] }[] = [];
  const pending: {
    resolve: (v: { rows: RankingRow[]; partial: boolean; skippedCount: number }) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const cleanupCalls: { mode: RankingCleanupMode; sessionId: string; title: string }[] = [];
  const logs: string[] = [];

  const deps: RankingPanelDeps = {
    analyzer: {
      getRankingRows(opts) {
        calls.push({ force: opts.force, keys: Object.keys(opts) });
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
    cleaner: {
      run(mode, sessionId, title) {
        cleanupCalls.push({ mode, sessionId, title });
        return Promise.resolve(undefined);
      },
    },
    workspacePath,
    log: (m) => logs.push(m),
  };
  return { deps, calls, pending, cleanupCalls, logs };
}

/** 让出若干轮微任务，等 compute 的 await 链跑完 */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const rows = (n: number): RankingRow[] =>
  Array.from({ length: n }, (_, i) => ({
    title: 'S' + i,
    sessionId: 'sid-' + i,
    jsonBytes: 1024,
    archiveBytesSelf: (i + 1) * 1024,
    totalBytes: 1024 + (i + 1) * 1024,
    mtimeMs: 1_700_000_000_000 + i,
  }));

/** 每个用例结束都拆掉模块级单例，避免测试间互相看见对方的面板 */
let activeCleanup: (() => void) | null = null;
afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
});

/** 打开一个面板并返回全部把手；返回的 close 会同时清掉单例与 vscode 钩子 */
function open(workspacePath: string | null = 'd:/ws') {
  const env = makeEnv();
  const d = makeDeps(workspacePath);
  const restore = installVscodeStub(env.vscodeStub);
  try {
    RankingPanel.showOrCreate(env.context, d.deps);
  } finally {
    restore();
  }
  const panel = env.created[0];
  activeCleanup = () => {
    panel?.fireDispose();
  };
  /** 再次调用 showOrCreate（命中单例分支），期间同样只临时挂 vscode 替身 */
  const reopen = () => {
    const undo = installVscodeStub(env.vscodeStub);
    try {
      RankingPanel.showOrCreate(env.context, d.deps);
    } finally {
      undo();
    }
  };
  return { env, ...d, panel, reopen };
}

describe('RankingPanel - 窗口内单例与 reveal（Req 13.1）', () => {
  it('首次打开创建面板：viewType / 标题 / retainContextWhenHidden / CSP 就位', () => {
    const { env, panel } = open();
    expect(env.created.length).toBe(1);
    expect(panel.viewType).toBe(RANKING_PANEL_VIEW_TYPE);
    expect(RANKING_PANEL_VIEW_TYPE).toBe('kiroChatSearch.storageRanking');
    expect(panel.title).toBe('存储占用排行');
    expect(panel.options.enableScripts).toBe(true);
    expect(panel.options.retainContextWhenHidden).toBe(true);
    expect(panel.htmlWrites.length).toBe(1);
    expect(panel.htmlWrites[0]).toContain(`default-src 'none'`);
    expect(panel.htmlWrites[0]).toContain(`style-src ${CSP_SOURCE} 'unsafe-inline'`);
    expect(panel.htmlWrites[0]).toMatch(/script-src 'nonce-[A-Za-z0-9]{32}'/);
  });

  it('已存在实例时只 reveal：不新建面板、不重写 html，页码与方向因此原样保留', () => {
    const { env, panel, reopen } = open();

    // 页码与排序方向存活在 webview 侧、不回宿主，因此「保持」的判据是：
    // reveal 不重建 webview（html 不被重写）、也不下发任何重置消息
    const before = panel.messages.length;
    reopen();

    expect(env.created.length).toBe(1);
    expect(panel.reveals).toEqual([{ viewColumn: undefined, preserveFocus: false }]);
    expect(panel.htmlWrites.length).toBe(1);
    expect(panel.messages.length).toBe(before);
    for (const m of panel.messages) {
      expect(Object.keys(m)).not.toContain('page');
      expect(Object.keys(m)).not.toContain('sortOrder');
    }
  });

  it('关闭后重开是全新 webview：html 重新生成，回到第 1 页与 desc', () => {
    const first = open();
    first.panel.fireDispose();
    expect(first.panel.disposeCalls).toBeGreaterThanOrEqual(1);

    const second = open();
    expect(second.env.created.length).toBe(1); // 新的 env → 新面板
    const html = second.panel.htmlWrites[0];
    expect(html).toContain(`let sortOrder = 'desc';`);
    expect(html).toContain('let page = 1;');
    expect(html).toContain('第 1 / 1 页 · 共 0 个会话');
  });
});

describe('RankingPanel - 取数时序与五态（Req 13.12、13.15、13.16）', () => {
  it('ready 触发强制取数：先 loading 再 rows，且取数入参恒只有 force', async () => {
    const { panel, calls, pending } = open();
    panel.fireMessage({ type: 'ready' });
    await settle();

    expect(calls).toEqual([{ force: true, keys: ['force'] }]);
    expect(panel.messages[0]).toEqual({ type: 'state', state: 'loading' });

    pending[0].resolve({ rows: rows(3), partial: false, skippedCount: 0 });
    await settle();

    const last = panel.messages[panel.messages.length - 1] as Record<string, unknown>;
    expect(last.type).toBe('rows');
    expect((last.rows as RankingRow[]).length).toBe(3);
    expect(last.partial).toBe(false);
    expect(last.skippedCount).toBe(0);
    // 排行页恒 self：入参里没有 scope / creditMode 之类的口径开关（Req 13.4）
    expect(calls[0].keys).toEqual(['force']);
  });

  it('统计进行中忽略重复请求：同时最多 1 次统计、只推 1 次 loading（Req 13.15）', async () => {
    const { panel, calls, pending } = open();
    panel.fireMessage({ type: 'ready' });
    panel.fireMessage({ type: 'refresh' });
    panel.fireMessage({ type: 'refresh' });
    await settle();

    expect(calls.length).toBe(1);
    expect(panel.messages.filter((m) => m.state === 'loading').length).toBe(1);

    pending[0].resolve({ rows: [], partial: false, skippedCount: 0 });
    await settle();

    // 上一次结束后新的刷新可以再次进入
    panel.fireMessage({ type: 'refresh' });
    await settle();
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({ force: true, keys: ['force'] });
  });

  it('K = 0 走 rows 空数组（webview 侧落 empty），不是 state 消息', async () => {
    const { panel, pending } = open();
    panel.fireMessage({ type: 'ready' });
    await settle();
    pending[0].resolve({ rows: [], partial: true, skippedCount: 7 });
    await settle();

    const last = panel.messages[panel.messages.length - 1] as Record<string, unknown>;
    expect(last).toEqual({ type: 'rows', rows: [], partial: true, skippedCount: 7 });
    expect(panel.messages.some((m) => m.state === 'empty')).toBe(false);
  });

  it('无工作区：直接推 no-workspace，绝不调用 analyzer（Req 13.16）', async () => {
    const { panel, calls } = open(null);
    panel.fireMessage({ type: 'ready' });
    panel.fireMessage({ type: 'refresh' });
    await settle();

    expect(calls.length).toBe(0);
    expect(panel.messages).toEqual([
      { type: 'state', state: 'no-workspace' },
      { type: 'state', state: 'no-workspace' },
    ]);
  });

  it('取数抛错落 unavailable 并记日志，不抛给调用方（Req 9.3、9.4）', async () => {
    const { panel, pending, logs } = open();
    panel.fireMessage({ type: 'ready' });
    await settle();
    pending[0].reject(new Error('boom'));
    await settle();

    expect(panel.messages[panel.messages.length - 1]).toEqual({
      type: 'state',
      state: 'unavailable',
    });
    expect(logs.some((l) => l.includes('排行页取数失败：boom'))).toBe(true);
  });

  it('refresh() 恒 force 且不下发排序方向：刷新保持刷新前的方向（Req 13.12）', async () => {
    const { panel, calls, pending } = open();
    panel.fireMessage({ type: 'ready' });
    await settle();
    pending[0].resolve({ rows: rows(2), partial: false, skippedCount: 0 });
    await settle();

    panel.fireMessage({ type: 'refresh' });
    await settle();
    expect(calls.map((c) => c.force)).toEqual([true, true]);
    pending[1].resolve({ rows: rows(1), partial: false, skippedCount: 0 });
    await settle();

    for (const m of panel.messages) {
      expect(Object.keys(m)).not.toContain('sortOrder');
      expect(Object.keys(m)).not.toContain('page');
    }
  });
});

describe('RankingPanel - 行内清理入口接线（Req 13.11、13.17）', () => {
  it('cleanup 消息委托 cleaner.run，完成后强制重取（页码由 pageOf 归一）', async () => {
    const { panel, cleanupCalls, calls, pending } = open();
    panel.fireMessage({ type: 'ready' });
    await settle();
    pending[0].resolve({ rows: rows(3), partial: false, skippedCount: 0 });
    await settle();

    panel.fireMessage({ type: 'cleanup', mode: 'full', sessionId: 'sid-1', title: '长标题' });
    await settle();

    expect(cleanupCalls).toEqual([{ mode: 'full', sessionId: 'sid-1', title: '长标题' }]);
    expect(calls.length).toBe(2);
    expect(calls[1].force).toBe(true);
  });

  it('未知 mode 退回 attachment；sessionId 为空的消息被丢弃', async () => {
    const { panel, cleanupCalls } = open();
    panel.fireMessage({ type: 'cleanup', mode: 'wat', sessionId: 'sid-9', title: '' });
    panel.fireMessage({ type: 'cleanup', mode: 'full', sessionId: '', title: 'x' });
    panel.fireMessage({ type: 'cleanup', mode: 'full' });
    await settle();

    expect(cleanupCalls).toEqual([{ mode: 'attachment', sessionId: 'sid-9', title: '' }]);
  });

  it('清理后行数减少时页码落到 min(M, N)（Req 13.17 的算术部分）', () => {
    // 原本第 3 页；清理后只剩 1 页 → clamp 到 1，无需宿主自己算
    const after = pageOf(rows(10), 'desc', 3);
    expect([after.page, after.totalPages, after.rows.length]).toEqual([1, 1, 10]);
  });
});
/* ------------------------------------------------------------------ *
 * 8. 取数：0.9x 行的 SessionOrigin 与迁移标记（Req 9.4、9.5）
 * ------------------------------------------------------------------ */

import * as path from 'path';
import { collectRankingRows } from '../src/storage/ranking';

/**
 * 补充示例测试：`collectRankingRows` 的行来源标注。
 *
 * 钉两件事：
 *   1. `origin` 由 `session/origin.ts` 的判定得出，而不是所有 0.9x 行统一贴
 *      「已迁移」——旧目录里有指向该 sessionId 的 MigrationMarker 才是 `migrated`，
 *      没有则是 `legacy-unmigrated`（该会话在 1.x 界面里看不见）；
 *   2. `._migration-<uuid>.json` 本身不是会话，不成行、也不计入 `skippedCount`。
 *
 * 随机输入空间上的行集合/数值性质由 tests/storage.ranking.property.spec.ts
 * （Property 24(fetch)）覆盖，这里只钉这两条具体规则。
 */

const ORIGIN_DIR = path.join('/mem', 'oldWs');

/** 极简内存目录 → 只读 RankingFsDeps（按 basename 定位，缺 content 的文件读则抛错） */
function originDeps(files: { name: string; content?: string }[]) {
  const byName = new Map(files.map((f) => [f.name, f]));
  return {
    readdir: async () =>
      files.map((f) => ({
        name: f.name,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
      })),
    stat: async () => ({
      size: 100,
      mtimeMs: 1_700_000_000_000,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }),
    readFile: async (p: string) => {
      const f = byName.get(path.basename(p));
      if (!f || f.content === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return f.content;
    },
  };
}

const fetchOrigins = async (files: { name: string; content?: string }[]) => {
  const res = await collectRankingRows(
    { sessionDir: ORIGIN_DIR, storeRoot: '', workspacePath: '', archives: [] },
    originDeps(files)
  );
  return { res, byId: new Map(res.rows.map((r) => [r.sessionId, r.origin])) };
};

describe('collectRankingRows - 0.9x 行的 SessionOrigin（Req 9.4、9.5）', () => {
  it('有 MigrationMarker 指向的会话为 migrated，其余为 legacy-unmigrated（不再一律 migrated）', async () => {
    const { res, byId } = await fetchOrigins([
      { name: 'moved.json', content: '{"title":"已搬走"}' },
      { name: 'stayed.json', content: '{"title":"还在旧目录"}' },
      {
        name: '._migration-1a2b3c4d.json',
        content: JSON.stringify({ v2SessionId: 'moved', migratedAt: '2025-01-01T00:00:00.000Z' }),
      },
    ]);

    expect(byId.get('moved')).toBe('migrated');
    expect(byId.get('stayed')).toBe('legacy-unmigrated');
    // 标记本身不是会话：不成行，也不算「被跳过的条目」（数值仍精确）
    expect(res.rows.map((r) => r.sessionId).sort()).toEqual(['moved', 'stayed']);
    expect(res.skippedCount).toBe(0);
  });

  it('标记内容非法或缺 v2SessionId 时不误判为已迁移（保守一侧）', async () => {
    const { byId } = await fetchOrigins([
      { name: 'a.json', content: '{}' },
      { name: 'b.json', content: '{}' },
      { name: '._migration-broken.json', content: '{ not json' },
      { name: '._migration-nofield.json', content: JSON.stringify({ migratedAt: 'x' }) },
      // 读不出内容的标记（权限/竞态）同样只当作「没有这条证据」
      { name: '._migration-unreadable.json' },
    ]);

    expect([...byId.values()]).toEqual(['legacy-unmigrated', 'legacy-unmigrated']);
  });
});
