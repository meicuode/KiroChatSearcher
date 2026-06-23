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
 * 用量标签：优先展示真实 credit 消耗（来自 Kiro 执行记录的 usageSummary 汇总），
 * credit 不可用时回退到上下文占用百分比（Kiro 本地估算）。两者都没有时返回 null。
 * 返回 { kind, value, title }：图标由渲染层按 kind 选择 SVG，避免 emoji 字形
 * 在不同平台下垂直对齐不稳定的问题。value/title 由调用方负责 HTML 转义。
 */
export function usageLabel(
  credits?: number,
  contextPercentage?: number
): { kind: 'credit' | 'context'; value: string; title: string } | null {
  if (typeof credits === 'number' && isFinite(credits)) {
    const v = credits >= 10 ? credits.toFixed(1) : credits.toFixed(2);
    return {
      kind: 'credit',
      value: v,
      title: '该对话实际消耗 ' + credits.toFixed(4) + ' credits（来自 Kiro 执行记录）',
    };
  }
  if (typeof contextPercentage === 'number' && isFinite(contextPercentage)) {
    return {
      kind: 'context',
      value: Math.round(contextPercentage) + '%',
      title:
        '上下文窗口占用 ' +
        contextPercentage.toFixed(1) +
        '%（credit 数据不可用时的回退，Kiro 本地估算）',
    };
  }
  return null;
}
