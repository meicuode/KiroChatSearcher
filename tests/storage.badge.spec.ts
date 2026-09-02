import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getWebviewHtml } from '../src/webview';
import { sizeBadgeLabel, summaryLabel } from '../src/webview/size';
import { usageLabel } from '../src/webview/format';

/**
 * 任务 15.3 的示例测试：锁定 **ComputeSizeButton / SummaryBar / SizeBadge 的渲染
 * 契约**与**统计的消息时序**。
 *
 * 取证方式（vitest 是 node 环境、没有 DOM，webview 脚本无法真的执行）：
 *   1. 结构 / 顺序 / 属性 / tooltip → 对 `getWebviewHtml()` 产出的 HTML 串做断言
 *      （用出现位置的先后关系证明「⛁ 占用 在 Σ 左侧」「`.badge.size` 在 credit
 *      角标之前」这类顺序要求）；
 *   2. 文案与四态数值 → 直接调用被注入到同一段脚本里的纯函数
 *      `sizeBadgeLabel` / `summaryLabel`（webview 与测试共用同一实现）；
 *   3. 宿主侧的时序与「不弹通知」→ 对 `src/extension.ts` 的**代码文本**做断言
 *      （`SearchSession` 未导出且依赖 vscode 运行时，无法在 node 下实例化）。
 *
 * 随机输入空间上的标签输出由 tests/storage.badge.property.spec.ts（Property 10/11）
 * 覆盖，格式化边界由 tests/size.spec.ts 覆盖，这里只钉住具体结构与具体文案。
 *
 * Requirements: 4.3, 4.4, 4.5, 4.7, 4.8, 4.12, 5.1, 9.4, 9.5
 */

const NONCE = 'kcs-test-nonce-0001';
const CSP_SOURCE = 'vscode-webview://kcs-test';

const HTML = getWebviewHtml(
  { cspSource: CSP_SOURCE } as unknown as Parameters<typeof getWebviewHtml>[0],
  NONCE
);

/** 取 [start, end) 之间的片段（含 start 本身），标记缺失即失败并给出可读原因。 */
function sliceFrom(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `未找到起始标记：${start}`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `未找到结束标记：${end}`).toBeGreaterThan(i);
  return src.slice(i, j + end.length);
}

/** 断言 a 在 b 之前出现（两者都必须出现） */
function expectOrder(src: string, a: string, b: string): void {
  const ia = src.indexOf(a);
  const ib = src.indexOf(b);
  expect(ia, `未找到：${a}`).toBeGreaterThanOrEqual(0);
  expect(ib, `未找到：${b}`).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} 应出现在 ${b} 之前`).toBeLessThan(ib);
}

const STYLE = sliceFrom(HTML, '<style>', '</style>');
const FILTERS = sliceFrom(HTML, '<div class="filters">', '</div>');
const SCRIPT = sliceFrom(HTML, `<script nonce="${NONCE}">`, '</script>');

/** webview → 宿主的一条上行消息在脚本里出现的次数 */
function postCount(type: string): number {
  const needle = `vscode.postMessage({ type: '${type}'`;
  let n = 0;
  let i = SCRIPT.indexOf(needle);
  while (i >= 0) {
    n++;
    i = SCRIPT.indexOf(needle, i + needle.length);
  }
  return n;
}

const K = 1024;
const K2 = K * K;

/* ------------------------------------------------------------------ *
 * 1. ComputeSizeButton：位置、tooltip 与上行消息（Req 4.3、4.4、4.7）
 * ------------------------------------------------------------------ */

describe('ComputeSizeButton - 位置与 tooltip（Req 4.3）', () => {
  it('过滤标签行内的顺序为：过滤 chip → SummaryBar → ⛁ 占用 → Σ → 刷新', () => {
    expectOrder(FILTERS, 'data-mode="attachment"', 'id="summary"');
    expectOrder(FILTERS, 'id="summary"', 'id="computeSize"');
    // ⛁ 占用 恒在 Σ（#creditMode）左侧
    expectOrder(FILTERS, 'id="computeSize"', 'id="creditMode"');
    expectOrder(FILTERS, 'id="creditMode"', 'id="refresh"');
  });

  it('tooltip 文案固定为「左键统计当前项目占用 · 右键打开占用排行」', () => {
    const tag = /<span id="computeSize"[^>]*>/.exec(FILTERS)?.[0] ?? '';
    expect(tag).not.toBe('');
    const title = /title="([^"]*)"/.exec(tag)?.[1];
    expect(title).toBe('左键统计当前项目占用 · 右键打开占用排行');
  });

  it('是 filter-chip 样式的按钮，但不带 data-mode（不被附件过滤循环接管）', () => {
    const tag = /<span id="computeSize"[^>]*>/.exec(FILTERS)?.[0] ?? '';
    expect(tag).toContain('class="filter-chip"');
    expect(tag).toContain('role="button"');
    expect(tag).not.toContain('data-mode');
    // 过滤 chip 的选择器按 [data-mode] 收窄，故点击 ⛁ 占用 不会抢走 .active
    expect(SCRIPT).toContain(`querySelectorAll('.filter-chip[data-mode]')`);
  });

  it('左键 → computeSize；右键 → 先 preventDefault 再 openRanking，且不动 SummaryBar（Req 4.4、4.7）', () => {
    const click = sliceFrom(SCRIPT, `$computeSize.addEventListener('click'`, '\n  });');
    expect(click).toContain(`vscode.postMessage({ type: 'computeSize' })`);

    const ctx = sliceFrom(SCRIPT, `$computeSize.addEventListener('contextmenu'`, '\n  });');
    expectOrder(ctx, 'e.preventDefault()', `type: 'openRanking'`);
    // 右键只开排行页：既不改状态文案，也不触发统计
    expect(ctx).not.toContain('setSummary');
    expect(ctx).not.toContain(`type: 'computeSize'`);
  });

  it('computeSize / openRanking 各只有一处上行入口（不存在自动触发点）', () => {
    expect(postCount('computeSize')).toBe(1);
    expect(postCount('openRanking')).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 2. SizeBadge 与 credit 角标并列（Req 5.1）
 * ------------------------------------------------------------------ */

describe('SizeBadge - 与 credit 角标并列的 HTML 结构（Req 5.1）', () => {
  it('`.badge.size` 渲染在 row1 的 .time 容器内、credit 角标之前', () => {
    const row = sliceFrom(SCRIPT, 'li.innerHTML =', `'</div>';`);
    expectOrder(row, 'class="row1"', 'class="title"');
    expectOrder(row, 'class="title"', 'class="time"');

    // .time 容器的拼接顺序：sizeBadge → usageBadge（credit）→ 图片/附件 → 时间
    const timeCell = sliceFrom(SCRIPT, `'<div class="time">'`, `fmtTime(r.modified)`);
    expectOrder(timeCell, 'sizeBadge', 'usageBadge');
  });

  it('角标标签为 `badge size`，≥100MB 追加 warn，文本与 tooltip 均经 escapeHtml', () => {
    const badge = sliceFrom(SCRIPT, `sizeBadge =`, `'</span>';`);
    expect(badge).toContain(`'<span class="badge size'`);
    expect(badge).toContain(`(size.warn ? ' warn' : '')`);
    expect(badge).toContain('escapeHtml(size.title)');
    expect(badge).toContain('escapeHtml(size.value)');
    expect(STYLE).toContain('.badge.size {');
    expect(STYLE).toContain('.badge.size.warn {');
  });

  it('sizeBadgeLabel 返回 null 时省略该条角标（Req 5.4、9.6）', () => {
    expect(SCRIPT).toContain(`let sizeBadge = '';`);
    expect(SCRIPT).toMatch(/if \(size\) \{/);
    // 数值取不到 → null（该条省略），其余结果的角标照常产出
    expect(sizeBadgeLabel({ jsonBytes: undefined, archiveBytesSelf: K })).toBeNull();
    expect(sizeBadgeLabel({ jsonBytes: K, archiveBytesSelf: K })).not.toBeNull();
  });

  it('口径与 Σ 开关共用 creditMode，切换只重渲染、不重新取数（Req 5.2）', () => {
    const call = sliceFrom(SCRIPT, 'const size = sizeBadgeLabel({', '});');
    expect(call).toContain('scope: creditMode');
    expect(call).toContain('jsonBytes: r.sessionJsonBytes');
    expect(call).toContain('archiveBytesSelf: r.archiveBytesSelf');
    expect(call).toContain('archiveBytesLineage: r.archiveBytesLineage');
    expect(call).toContain('archivesFound: r.archivesFound');

    const toggle = sliceFrom(SCRIPT, `$creditMode.addEventListener('click'`, '\n  });');
    expect(toggle).toContain('renderList(currentResults, currentKeyword)');
    expect(toggle).not.toContain('postMessage');
  });

  it('同一条结果可同时产出 SizeBadge 与 credit 角标（两者并列而非互斥）', () => {
    const size = sizeBadgeLabel({ jsonBytes: 512 * K, archiveBytesSelf: 12 * K2 });
    const usage = usageLabel({ selfCredits: 1.5 });
    expect(size).not.toBeNull();
    expect(usage).not.toBeNull();
    expect(size!.value).toBe('12.5MB');
    expect(size!.title).toContain('会话 JSON');
    expect(size!.title).toContain('归因存档');
  });

  it('≥100MB 走警示配色，99MB 不走（Req 5.6）', () => {
    expect(sizeBadgeLabel({ jsonBytes: 100 * K2 })!.warn).toBe(true);
    expect(sizeBadgeLabel({ jsonBytes: 99 * K2 })!.warn).toBe(false);
  });

  it('注入顺序：formatSize 先于两个 label 函数（label 内部调用它）', () => {
    expectOrder(SCRIPT, 'function formatSize(bytes)', 'function sizeBadgeLabel(opts)');
    expectOrder(SCRIPT, 'function formatSize(bytes)', 'function summaryLabel(opts)');
  });
});

/* ------------------------------------------------------------------ *
 * 3. 消息时序与忙碌态（Req 4.4、4.5）
 * ------------------------------------------------------------------ */

describe('统计时序 - 先 loading 再 ok（Req 4.4、4.5）', () => {
  it('SummaryBar 初始停在 idle：只有提示文案、不含任何数值', () => {
    expect(SCRIPT).toContain(`setSummary('idle');`);
    const idle = summaryLabel({ state: 'idle' })!;
    expect(idle.text).toBe('点击 ⛁ 统计占用');
    expect(idle.text).not.toMatch(/\d/);
    expect(idle.title).toContain('右键打开占用排行');
  });

  it('loading 态展示「统计中…」且不含数值，随后的 ok 态给出三项数值', () => {
    const loading = summaryLabel({ state: 'loading' })!;
    expect(loading.text).toBe('统计中…');
    expect(loading.text).not.toMatch(/\d/);
    expect(loading.title).toContain('可继续输入关键词与浏览结果');

    const ok = summaryLabel({
      state: 'ok',
      totalBytes: 3 * K2,
      resultSetBytes: 2 * K2,
      orphanBytes: K2,
      sessionCount: 7,
      resultCount: 3,
      jsonBytes: K2,
      archiveBytes: 2 * K2,
    })!;
    expect(ok.text).toBe('项目 3.0MB · 结果 2.0MB · 孤儿 1.0MB');
    expect(ok.title).toContain('会话 JSON 1.0MB + 归因存档 2.0MB');
    expect(ok.title).toContain('参与统计的会话数 7 · 结果条数 3');
  });

  it('四态消息全部经 setSummary 渲染，文本与 tooltip 由 summaryLabel 产出', () => {
    const branch = sliceFrom(SCRIPT, `m.type === 'summary'`, '\n    }');
    expect(branch).toContain('setSummary(m.state, m.summary)');

    const setSummary = sliceFrom(SCRIPT, 'function setSummary(', '\n  }');
    expect(setSummary).toContain('summaryLabel(opts)');
    expect(setSummary).toContain('$summary.textContent = out.text');
    expect(setSummary).toContain('$summary.title = out.title');
  });

  it('统计失败态在 SummaryBar 内降级展示（Req 9.3）', () => {
    const bad = summaryLabel({ state: 'unavailable' })!;
    expect(bad.text).toBe('占用统计不可用');
    expect(bad.text).not.toMatch(/\d/);
    expect(bad.title).toContain('搜索与用量展示不受影响');
  });
});

describe('忙碌态 - 重复左键被忽略，搜索与浏览照常（Req 4.5）', () => {
  it('loading 时给 #computeSize 加 .busy，ok / unavailable 时移除', () => {
    const setSummary = sliceFrom(SCRIPT, 'function setSummary(', '\n  }');
    expect(setSummary).toContain(`$computeSize.classList.toggle('busy', state === 'loading')`);
  });

  it('.busy 的 pointer-events: none 挡住重复左键', () => {
    const rule = sliceFrom(STYLE, '.filter-chip.busy {', '}');
    expect(rule).toContain('pointer-events: none');
  });

  it('忙碌态只作用在 ComputeSizeButton 上（输入框、结果列表不被禁用）', () => {
    const targets = [...SCRIPT.matchAll(/(\$\w+)\.classList\.(?:toggle|add|remove)\('busy'/g)].map(
      (m) => m[1]
    );
    expect(targets).toEqual(['$computeSize']);
  });

  it('统计期间搜索照常：输入框仍无条件下发 search，打开结果不受忙碌态影响', () => {
    const input = sliceFrom(SCRIPT, `$q.addEventListener('input'`, '}, 120);');
    expect(input).toContain(`vscode.postMessage({ type: 'search', keyword: kw })`);
    expect(input).not.toContain('busy');

    const open = sliceFrom(SCRIPT, 'function open(i)', '\n  }');
    expect(open).toContain(`vscode.postMessage({ type: 'open', sessionId: r.sessionId })`);
    expect(open).not.toContain('busy');

    // 结果到货即渲染，不等统计
    const results = sliceFrom(SCRIPT, `m.type === 'results'`, '\n    }');
    expect(results).toContain('applyAndRender()');
    expect(results).not.toContain('busy');
  });
});

/* ------------------------------------------------------------------ *
 * 4. 既有刷新按钮不触发统计（Req 4.8）
 * ------------------------------------------------------------------ */

describe('既有刷新按钮 - 只重新取搜索结果（Req 4.8）', () => {
  it('刷新按钮的 click 只发 hardRefresh，不发 computeSize', () => {
    const refresh = sliceFrom(SCRIPT, `$refresh.addEventListener('click'`, '\n  });');
    expect(refresh).toContain(`vscode.postMessage({ type: 'hardRefresh' })`);
    expect(refresh).not.toContain('computeSize');
    expect(refresh).not.toContain('summary');
  });

  it('附件过滤 chip 也不触发统计（只 revalidate）', () => {
    const chips = sliceFrom(SCRIPT, '$filters.forEach((chip)', '\n  });');
    expect(chips).toContain(`vscode.postMessage({ type: 'revalidate' })`);
    expect(chips).not.toContain('computeSize');
  });
});

/* ------------------------------------------------------------------ *
 * 5. 清理完成后 SummaryBar 三项数值被刷新（Req 4.12）
 * ------------------------------------------------------------------ */

describe('清理后的刷新 - 重推 ok 负载即刷新三项数值（Req 4.12）', () => {
  const before = {
    state: 'ok' as const,
    totalBytes: 3 * K2,
    resultSetBytes: 2 * K2,
    orphanBytes: K2,
    sessionCount: 7,
    resultCount: 3,
  };

  it('删除 1MB 存档后的新负载产出新的三项数值', () => {
    const a = summaryLabel(before)!;
    const b = summaryLabel({ ...before, totalBytes: 2 * K2, resultSetBytes: K2, orphanBytes: 0 })!;
    expect(a.text).toBe('项目 3.0MB · 结果 2.0MB · 孤儿 1.0MB');
    expect(b.text).toBe('项目 2.0MB · 结果 1.0MB · 孤儿 0B');
    expect(b.text).not.toBe(a.text);
  });

  it('前端没有一次性渲染门闩：每条 summary 消息都重写文本与 tooltip', () => {
    const setSummary = sliceFrom(SCRIPT, 'function setSummary(', '\n  }');
    // 唯一的分支是「summaryLabel 是否给出结果」，不存在 rendered / once 之类的标志
    expect(setSummary).not.toMatch(/\b(rendered|once|inited|initialized)\b/);
    expect(setSummary).toContain('if (out) {');
  });
});

/* ------------------------------------------------------------------ *
 * 6. 宿主侧时序与通知策略（Req 4.5、4.8、9.4、9.5）
 *
 * SearchSession 未导出且依赖 vscode 运行时，node 环境下无法实例化，
 * 因此对 src/extension.ts 的代码文本做断言（先剥注释，避免命中文档说明）。
 * ------------------------------------------------------------------ */

describe('宿主侧 - 统计失败不弹通知，命令失败有固定文案（Req 9.4、9.5）', () => {
  const extPath = path.join(__dirname, '..', 'src', 'extension.ts');
  const extSource = fs.readFileSync(extPath, 'utf8');
  /** 只剥离注释行与块注释，保留字符串字面量（文案断言依赖它们） */
  const extCode = extSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

  it('computeSize 入口：忙碌期间直接忽略重复请求，先推 loading 再异步取数', () => {
    const body = sliceFrom(extCode, 'private computeSize()', '\n  }');
    expectOrder(body, 'if (this.summaryInflight) return;', `state: 'loading'`);
    expectOrder(body, `state: 'loading'`, 'this.runComputeSize()');
  });

  it('取数失败推 unavailable、清忙碌标志，且不弹任何通知（Req 9.4）', () => {
    const body = sliceFrom(extCode, 'private async runComputeSize()', '\n  }');
    expect(body).toContain(`state: 'unavailable'`);
    expect(body).toContain('this.summaryInflight = false;');
    expect(body).not.toMatch(/show(Error|Warning|Information)Message/);
  });

  it('hardRefresh 只重新取搜索结果，不触发统计（Req 4.8）', () => {
    const branch = sliceFrom(extCode, `case 'hardRefresh':`, `case 'open':`);
    expect(branch).toContain('this.runSearch(this.lastKeyword)');
    expect(branch).not.toContain('computeSize');
  });

  it('openRanking 只执行排行页命令，不改 SummaryBar 状态（Req 4.7）', () => {
    const branch = sliceFrom(extCode, `case 'openRanking':`, 'break;');
    expect(branch).toContain(`executeCommand('kiroChatSearch.storageRanking')`);
    expect(branch).not.toContain(`type: 'summary'`);
  });

  it('StorageReportCommand 失败文案为「存储占用分析失败：<message>」（Req 9.5）', () => {
    const body = sliceFrom(extCode, 'async function runStorageReport()', '\n}');
    expect(body).toMatch(
      /showErrorMessage\('存储占用分析失败：' \+ \(e\?\.message \?\? String\(e\)\)\)/
    );
    // 该文案只此一处，且统计路径（computeSize / runComputeSize / 变为可见的 refresh）
    // 全无通知调用——通知只出现在用户主动执行的命令里（Req 9.4 的例外）
    expect([...extCode.matchAll(/存储占用分析失败/g)].length).toBe(1);
    for (const marker of ['private computeSize()', 'private async runComputeSize()', '  refresh()']) {
      const seg = sliceFrom(extCode, marker, '\n  }');
      expect(seg, `${marker} 不应弹通知`).not.toMatch(
        /show(Error|Warning|Information)Message/
      );
    }
  });
});
