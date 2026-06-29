import { describe, it, expect } from 'vitest';
import { escapeHtml, highlight, fmtTime, usageLabel } from '../src/webview/format';

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

describe('usageLabel', () => {
  it('默认(self)显示自身消耗（<10 两位）', () => {
    const r = usageLabel({ selfCredits: 0.1234, lineageCredits: 5, contextPercentage: 80 });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('credit');
    expect(r!.value).toBe('0.12');
    expect(r!.title).toContain('0.1234');
  });

  it('self >= 10 保留一位', () => {
    expect(usageLabel({ selfCredits: 14.39 })!.value).toBe('14.4');
  });

  it('self=0 仍展示（区别于无数据）', () => {
    const r = usageLabel({ selfCredits: 0 })!;
    expect(r.kind).toBe('credit');
    expect(r.value).toBe('0.00');
  });

  it('self 模式下若有更大的整段累计，提示里补充', () => {
    const r = usageLabel({ mode: 'self', selfCredits: 11, lineageCredits: 801 })!;
    expect(r.value).toBe('11.0');
    expect(r.title).toContain('801');
  });

  it('lineage 模式显示整段累计，并在提示里补充本快照新增', () => {
    const r = usageLabel({ mode: 'lineage', selfCredits: 0, lineageCredits: 801.4 })!;
    expect(r.value).toBe('801.4');
    expect(r.title).toContain('整段对话累计');
    expect(r.title).toContain('本快照新增');
  });

  it('主口径无 credit 时回退上下文百分比（四舍五入）', () => {
    const r = usageLabel({ contextPercentage: 42.5 });
    expect(r!.kind).toBe('context');
    expect(r!.value).toBe('43%');
    expect(r!.title).toContain('42.5');
  });

  it('lineage 模式但只有 self 时回退（lineage 缺失）', () => {
    const r = usageLabel({ mode: 'lineage', selfCredits: 5, contextPercentage: 30 });
    // 主口径(lineage)缺失 → 回退上下文
    expect(r!.kind).toBe('context');
    expect(r!.value).toBe('30%');
  });

  it('都无返回 null', () => {
    expect(usageLabel({})).toBeNull();
  });
});
