import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyAttachmentFilter, AttachmentFilterMode } from '../src/webview/filter';

const rowArb = fc.record({
  hasImage: fc.boolean(),
  hasAttachment: fc.boolean(),
});
const modeArb: fc.Arbitrary<AttachmentFilterMode> = fc.constantFrom('all', 'image', 'attachment');

describe('AttachmentFilter properties', () => {
  // Feature: kiro-chat-search, Property 14: AttachmentFilter 过滤的幂等与子集性
  it('Property 14: 子序列 + 模式语义 + 幂等', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), modeArb, (rows, mode) => {
        const out = applyAttachmentFilter(rows, mode);

        // (a) 输出是输入的子序列（保序、不增项）：用引用包含 + 顺序单调推进验证
        let cursor = 0;
        for (const item of out) {
          let found = -1;
          for (let i = cursor; i < rows.length; i++) {
            if (rows[i] === item) {
              found = i;
              break;
            }
          }
          expect(found).toBeGreaterThanOrEqual(0);
          cursor = found + 1;
        }

        // (b) all 等于原数组
        if (mode === 'all') {
          expect(out).toEqual(rows);
        }
        // (c) image/attachment 恰为对应布尔为 true 的项
        if (mode === 'image') {
          expect(out).toEqual(rows.filter((r) => r.hasImage === true));
        }
        if (mode === 'attachment') {
          expect(out).toEqual(rows.filter((r) => r.hasAttachment === true));
        }

        // (d) 幂等
        const twice = applyAttachmentFilter(out, mode);
        expect(twice).toEqual(out);
      }),
      { numRuns: 100 }
    );
  });
});
