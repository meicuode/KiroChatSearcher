/**
 * Webview 与单元测试共用的纯函数。
 * 这些函数不依赖 DOM / vscode，可直接在 Node 端用 vitest 测试，
 * 同时它们的源码会被注入到 webview HTML 的内联脚本中以保证运行时一致。
 */

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 先对文本做 HTML 转义，再把与 keyword 大小写无关匹配的片段用 <mark> 包裹。
 * 关键词为空时仅返回转义后的文本。
 */
export function highlight(text: string, keyword: string): string {
  const safe = escapeHtml(text);
  if (!keyword) return safe;
  const re = new RegExp(escapeRegExp(keyword), 'gi');
  return safe.replace(re, (m) => '<mark>' + m + '</mark>');
}

/**
 * 时间格式化：
 *   今天    → "今天 HH:mm"
 *   同年    → "MM-DD HH:mm"
 *   跨年    → "YYYY-MM-DD HH:mm"
 * now 参数用于测试注入基准时间，缺省取当前时间。
 */
export function fmtTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());

  if (d.toDateString() === now.toDateString()) {
    return '今天 ' + hm;
  }
  const md = pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  if (d.getFullYear() === now.getFullYear()) {
    return md + ' ' + hm;
  }
  return d.getFullYear() + '-' + md + ' ' + hm;
}

/**
 * 用量标签：根据展示口径(mode)给出角标文本与提示。
 * - mode='self'（默认，方案 C）：显示会话自身消耗；存在更大的整段累计时在提示里补充。
 * - mode='lineage'（方案 A）：显示整段对话累计（含 checkpoint 继承）；提示里补充本快照自身新增。
 * 主口径无 credit 时回退到上下文占用百分比；都没有则返回 null。
 * 返回 { kind, value, title }：图标由渲染层按 kind 选择 SVG，避免 emoji 字形
 * 在不同平台下垂直对齐不稳定的问题。value/title 由调用方负责 HTML 转义。
 */
export function usageLabel(opts: {
  mode?: 'self' | 'lineage';
  selfCredits?: number;
  lineageCredits?: number;
  contextPercentage?: number;
}): { kind: 'credit' | 'context'; value: string; title: string } | null {
  const mode = opts.mode === 'lineage' ? 'lineage' : 'self';
  const fmt = (n: number) => (n >= 10 ? n.toFixed(1) : n.toFixed(2));
  const has = (n: unknown): n is number => typeof n === 'number' && isFinite(n);

  const primary = mode === 'lineage' ? opts.lineageCredits : opts.selfCredits;
  if (has(primary)) {
    let title: string;
    if (mode === 'lineage') {
      title = '整段对话累计 ' + primary.toFixed(4) + ' credits（含 checkpoint 继承）';
      if (has(opts.selfCredits)) title += '；本快照新增 ' + opts.selfCredits.toFixed(4);
    } else {
      title = '本对话消耗 ' + primary.toFixed(4) + ' credits';
      if (has(opts.lineageCredits) && opts.lineageCredits > primary + 1e-9) {
        title += '；含 checkpoint 继承共 ' + opts.lineageCredits.toFixed(4);
      }
    }
    return { kind: 'credit', value: fmt(primary), title };
  }

  if (has(opts.contextPercentage)) {
    return {
      kind: 'context',
      value: Math.round(opts.contextPercentage) + '%',
      title:
        '上下文窗口占用 ' +
        opts.contextPercentage.toFixed(1) +
        '%（credit 数据不可用时的回退，Kiro 本地估算）',
    };
  }
  return null;
}
