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
