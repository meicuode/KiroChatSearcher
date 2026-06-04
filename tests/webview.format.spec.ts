import { describe, it, expect } from 'vitest';
import { escapeHtml, highlight, fmtTime } from '../src/webview/format';

describe('escapeHtml', () => {
  it.each([
    ['a & b', 'a &amp; b'],
    ['<tag>', '&lt;tag&gt;'],
    ['"quote"', '&quot;quote&quot;'],
    ["it's", 'it&#39;s'],
  ])('转义 %s', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });
});

describe('fmtTime', () => {
  const now = new Date(2026, 5, 4, 12, 0, 0); // 2026-06-04 12:00

  it('当天 → 今天 HH:mm', () => {
    const ms = new Date(2026, 5, 4, 9, 5).getTime();
    expect(fmtTime(ms, now)).toBe('今天 09:05');
  });

  it('同年其他日期 → MM-DD HH:mm', () => {
    const ms = new Date(2026, 2, 1, 18, 30).getTime();
    expect(fmtTime(ms, now)).toBe('03-01 18:30');
  });

  it('跨年 → YYYY-MM-DD HH:mm', () => {
    const ms = new Date(2024, 10, 9, 7, 8).getTime();
    expect(fmtTime(ms, now)).toBe('2024-11-09 07:08');
  });
});

describe('highlight - 基础', () => {
  it('关键词为空时仅转义', () => {
    expect(highlight('<b>', '')).toBe('&lt;b&gt;');
  });

  it('包裹命中片段为 <mark>', () => {
    expect(highlight('hello world', 'world')).toBe('hello <mark>world</mark>');
  });

  it('对原始文本中的 HTML 进行转义后再高亮，避免注入', () => {
    const out = highlight('<script>x</script>', 'script');
    expect(out).not.toContain('<script>');
    expect(out).toContain('<mark>script</mark>');
  });
});
