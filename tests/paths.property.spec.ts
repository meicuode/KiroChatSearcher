import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeWorkspaceKeys } from '../src/paths';

/** 与 paths.ts 一致的 base64url 编码，用于属性断言 */
function encodeBase64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** 把 base64url 还原回原始字符串 */
function decodeBase64Url(encoded: string): string {
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('PathResolver properties', () => {
  // Feature: kiro-chat-search, Property 1: base64url 编码合法且可逆
  it('Property 1: base64url 编码仅含 [A-Za-z0-9_-] 且可逆', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const encoded = encodeBase64Url(s);
        expect(/^[A-Za-z0-9_-]*$/.test(encoded)).toBe(true);
        expect(decodeBase64Url(encoded)).toBe(s);
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
