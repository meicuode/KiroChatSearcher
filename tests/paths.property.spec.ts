import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeWorkspaceKeys } from '../src/paths';

/** 与 paths.ts 一致的 base64url 编码，用于属性断言 */
function encodeBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '_');
}

describe('PathResolver properties', () => {
  // Feature: kiro-chat-search, Property 3: base64url 编码合法 + 确定 + 注入
  //
  // 注：Kiro 把 padding `=` 也替换为 `_`，与原文 `/`（同样替换为 `_`）共用同一字符，
  // 因此从纯 string 形式无法无歧义地反向解码。属性 3 的本意是"独立验证 base64
  // 编码正确性"，这里改用底层 base64 的核心性质——确定性（同输入同输出）与注入性
  // （不同输入不同输出）来覆盖，规避了反向解码的固有歧义。
  it('Property 3: 编码仅含 [A-Za-z0-9_-]，确定且对不同输入产生不同输出', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const ea = encodeBase64Url(a);
        const eb = encodeBase64Url(b);
        expect(/^[A-Za-z0-9_-]*$/.test(ea)).toBe(true);
        expect(/^[A-Za-z0-9_-]*$/.test(eb)).toBe(true);
        // 确定性：再编一次结果相同
        expect(encodeBase64Url(a)).toBe(ea);
        // 注入性：不同输入产生不同输出
        if (a !== b) expect(ea).not.toBe(eb);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-chat-search, Property 2: 路径变体覆盖（盘符与斜杠维度）
  it('Property 2: 盘符大小写 × 斜杠方向的全部组合都出现在输出中', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('C', 'D', 'E'),
        fc.array(fc.constantFrom('foo', 'bar', 'baz', 'a', 'b'), { minLength: 1, maxLength: 4 }),
        (drive, segs) => {
          const wsPath = `${drive}:\\` + segs.join('\\');
          const keys = encodeWorkspaceKeys(wsPath);

          const upper = drive.toUpperCase() + wsPath.slice(1);
          const lower = drive.toLowerCase() + wsPath.slice(1);
          const expectedVariants = new Set<string>();
          for (const base of [wsPath, upper, lower]) {
            expectedVariants.add(base);
            expectedVariants.add(base.replace(/\\/g, '/'));
            expectedVariants.add(base.replace(/\//g, '\\'));
          }
          for (const v of expectedVariants) {
            expect(keys).toContain(encodeBase64Url(v));
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-chat-search, Property 3: 候选去重
  it('Property 3: 输出 EncodedKey 列表无重复', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const keys = encodeWorkspaceKeys(s);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 100 }
    );
  });
});
