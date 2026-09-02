/**
 * 示例测试（任务 15.3）：搜索结果项的**来源角标**与 1.x 会话的 `Σ` 行为。
 *
 * 三层取证：
 *   1. 纯函数 `originBadgeLabel` / `sizeBadgeLabel` 的取值与 tooltip —— webview 侧跑的就是
 *      它们（`toString()` 注入），两侧同源；
 *   2. 真实 HTML：从 `getWebviewHtml()` 的内联脚本里取出结果项渲染那一段，确认角标被拼进
 *      标题行、且动态文本经过转义；
 *   3. `Σ` 切换：对同一条 1.x 结果分别以 `self` / `lineage` 求值，断言数值恒相同、
 *      且 tooltip 说清了原因（Req 4.4）。
 *
 * _Requirements: 4.4, 9.7_
 */
import { describe, it, expect } from 'vitest';

import { originBadgeLabel, sizeBadgeLabel } from '../src/webview/size';
import { getWebviewHtml } from '../src/webview';

const NONCE = 'kcs-badge-newlayout-nonce';
const HTML = getWebviewHtml(
  { cspSource: 'vscode-webview://kcs' } as unknown as Parameters<typeof getWebviewHtml>[0],
  NONCE
);
const SCRIPT = (() => {
  const open = `<script nonce="${NONCE}">`;
  const i = HTML.indexOf(open);
  const j = HTML.indexOf('</script>', i + open.length);
  return HTML.slice(i + open.length, j);
})();

/* ================================================================== *
 * 1. 来源角标（Req 9.7）
 * ================================================================== */

describe('15.1 结果项来源角标（Req 9.7）', () => {
  it('三种 SessionOrigin 各有短标签，且只有「未迁移」带警示', () => {
    const n = originBadgeLabel('new')!;
    expect(n.value).toBe('1.x');
    expect(n.warn).toBe(false);

    const m = originBadgeLabel('migrated')!;
    expect(m.value).toBe('已迁移');
    expect(m.warn).toBe(false);
    // 已迁移必须点明「旧残留不计入本条占用」，否则用户会把可释放空间估少
    expect(m.title).toContain('不计入本条占用');
    expect(m.title).toContain('旧格式残留');

    const l = originBadgeLabel('legacy-unmigrated')!;
    expect(l.value).toBe('未迁移');
    // 唯一带破坏性后果的取值：既要说不可见，也要说点击可能打不开、删了不可恢复
    expect(l.warn).toBe(true);
    expect(l.title).toContain('不可见');
    expect(l.title).toContain('无法打开');
    expect(l.title).toContain('不可恢复');
  });

  it('取值不可识别时返回 null（渲染层省略角标，不显示含义不明的标记）', () => {
    for (const bad of [undefined, null, '', 'NEW', 'unknown', 42, {}]) {
      expect(originBadgeLabel(bad)).toBeNull();
    }
  });

  it('内联脚本把来源角标拼进标题行，且 value / title 都过 escapeHtml', () => {
    // 角标由纯函数产出后在标题行的时间列前拼接
    expect(SCRIPT).toContain('originBadgeLabel(r.origin)');
    expect(SCRIPT).toContain("'<span class=\"badge origin'");
    expect(SCRIPT).toContain('escapeHtml(origin.title)');
    expect(SCRIPT).toContain('escapeHtml(origin.value)');
    expect(SCRIPT).toContain("'<div class=\"time\">' + originBadge");
    // 注入清单里确实带上了这个函数，否则 webview 运行时会 ReferenceError
    expect(SCRIPT).toContain('function originBadgeLabel');
  });

  it('未迁移角标有独立的警示配色类，且样式表里确有该规则', () => {
    expect(HTML).toContain('.badge.origin.warn');
    expect(HTML).toContain('.badge.origin {');
  });
});

/* ================================================================== *
 * 2. 1.x 会话的 Σ 口径（Req 4.4、design D4）
 * ================================================================== */

describe('15.1 1.x 会话的 Σ 开关（Req 4.4）', () => {
  const newHit = {
    layout: 'new' as const,
    jsonBytes: 8400,
    archiveBytesSelf: 1500,
    // 1.x 下两个口径同值，故宿主对两栏下发同一个数（analyzer 的 additive: true）
    archiveBytesLineage: 1500,
    archivesFound: true,
  };

  it('切换 Σ 数值恒不变，且 tooltip 说明「取同一值」与原因', () => {
    const self = sizeBadgeLabel({ ...newHit, scope: 'self' })!;
    const lineage = sizeBadgeLabel({ ...newHit, scope: 'lineage' })!;

    expect(self.value).toBe(lineage.value);
    expect(self.value).toBe(sizeBadgeLabel({ ...newHit, scope: 'self' })!.value);
    for (const badge of [self, lineage]) {
      expect(badge.title).toContain('自身口径与累计口径取同一值');
      expect(badge.title).toContain('快照按会话目录物理隔离');
    }
    // 1.x 的两列口径名也换成了新格式的说法，不再叫「归因存档」
    expect(self.title).toContain('会话本体 ');
    expect(self.title).toContain('快照与子执行 ');
    expect(self.title).not.toContain('归因存档');
  });

  it('0.9x 会话的口径文案与既有行为完全一致（未被新分支影响）', () => {
    const oldSelf = sizeBadgeLabel({
      layout: 'old',
      scope: 'self',
      jsonBytes: 1024,
      archiveBytesSelf: 2048,
      archiveBytesLineage: 8192,
      archivesFound: true,
    })!;
    const oldLineage = sizeBadgeLabel({
      layout: 'old',
      scope: 'lineage',
      jsonBytes: 1024,
      archiveBytesSelf: 2048,
      archiveBytesLineage: 8192,
      archivesFound: true,
    })!;

    expect(oldSelf.title).toContain('会话 JSON ');
    expect(oldSelf.title).toContain('归因存档（自身口径）');
    expect(oldLineage.title).toContain('归因存档（累计口径，含 checkpoint 继承）');
    expect(oldLineage.title).toContain('不可跨会话相加');
    // 0.9x 两个口径**应当**不同（这正是 Σ 存在的理由）
    expect(oldSelf.value).not.toBe(oldLineage.value);
    // 不传 layout 时的行为与 layout:'old' 逐字相同（既有调用方不受影响）
    const noLayout = sizeBadgeLabel({
      scope: 'lineage',
      jsonBytes: 1024,
      archiveBytesSelf: 2048,
      archiveBytesLineage: 8192,
      archivesFound: true,
    })!;
    expect(noLayout).toEqual(oldLineage);
  });

  it('1.x 快照数据不可用时用新格式的措辞，且仍只展示会话本体占用', () => {
    const badge = sizeBadgeLabel({ layout: 'new', scope: 'self', jsonBytes: 8400, archivesFound: false })!;
    expect(badge.value).toBe(sizeBadgeLabel({ layout: 'new', jsonBytes: 8400, archivesFound: false })!.value);
    expect(badge.title).toContain('快照数据不可用');
    expect(badge.title).not.toContain('LRU');
  });

  it('会话本体字节数取不到时整条角标被省略（与既有语义一致）', () => {
    expect(sizeBadgeLabel({ layout: 'new', scope: 'self' })).toBeNull();
  });

  it('渲染时把该条的 layout 传给 sizeBadgeLabel（否则 1.x 会拿到 0.9x 的文案）', () => {
    expect(SCRIPT).toContain('layout: r.layout');
  });
});
