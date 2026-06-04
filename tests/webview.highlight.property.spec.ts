import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { escapeHtml, highlight } from '../src/webview/format';

/** 剥离所有 <mark>/</mark> 标签 */
function stripMarks(html: string): string {
  return html.replace(/<\/?mark>/g, '');
}

/** HTML 反转义（与 escapeHtml 互逆） */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// 文本与关键词限定为字母数字与空格，确保子串语义清晰、互逆可验证
const textArb = fc.stringMatching(/^[a-zA-Z0-9 ]{0,40}$/);
const kwArb = fc.stringMatching(/^[a-zA-Z0-9]{1,5}$/);

describe('highlight properties', () => {
  // Feature: kiro-chat-search, Property 8: 高亮包裹不变量
  it('Property 8: 剥离 <mark> 反转义后等于原文，且每个命中被精确包裹一次', () => {
    fc.assert(
      fc.property(textArb, kwArb, (text, kw) => {
        const html = highlight(text, kw);

        // (a) 剥离 <mark> 并反转义后应还原原文
        expect(unescapeHtml(stripMarks(html))).toBe(text);

        // (b) <mark> 数量应等于关键词在文本中（大小写无关）的出现次数
        const safe = escapeHtml(text);
        const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const expectedCount = (safe.match(re) || []).length;
        const markCount = (html.match(/<mark>/g) || []).length;
        expect(markCount).toBe(expectedCount);
        // 开闭标签成对
        expect((html.match(/<\/mark>/g) || []).length).toBe(markCount);
      }),
      { numRuns: 100 }
    );
  });
});
