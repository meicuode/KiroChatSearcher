import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatSize, parseSize } from '../src/webview/size';

const K = 1024;
const K2 = K * K;
const K3 = K2 * K;
const K4 = K3 * K;

/**
 * 有限非负字节数生成器。
 *
 * 上界取 1024^6（约 1.15e18）：磁盘字节数的现实取值都在此以内，而更大的量级会
 * 撞上 `Number.prototype.toFixed` 在 >= 1e21 时切换为指数记数法的行为，那属于
 * 数值展示的语言边界而非本特性的输入空间。
 * 除均匀取样外，额外偏置到 1024 各次幂附近，覆盖单位切换边界。
 */
const MAX_BYTES = K3 * K3;
const boundaryArb = fc
  .tuple(
    fc.constantFrom(1, K, K2, K3, K4, K4 * K, MAX_BYTES),
    fc.integer({ min: -2, max: 2 })
  )
  .map(([base, delta]) => Math.max(0, Math.min(MAX_BYTES, base + delta)));
const byteArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat({ max: 4096 }),
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }).map((n) => n % (MAX_BYTES + 1)),
  fc.double({ min: 0, max: MAX_BYTES, noNaN: true }),
  boundaryArb
);

/** 非法输入：负数（整数与小数）、NaN、±Infinity。 */
const invalidArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: -1 }),
  fc.double({ min: -MAX_BYTES, max: -Number.MIN_VALUE, noNaN: true }),
  fc.constantFrom(NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5)
);

describe('SizeFormatter properties', () => {
  // Feature: storage-usage-analytics, Property 20: 格式化形态与非法输入占位
  it('Property 20: 单位取自固定序列、小数位数按量级分档、非法输入返回占位', () => {
    fc.assert(
      fc.property(byteArb, (bytes) => {
        const out = formatSize(bytes);

        // (a) 单位恒取自 B/KB/MB/GB/TB，数值部分形如 123 或 123.45
        const m = /^([0-9]+)(?:\.([0-9]+))?(B|KB|MB|GB|TB)$/.exec(out);
        expect(m, `unexpected shape: ${out} for ${bytes}`).not.toBeNull();
        const decimals = m![2] === undefined ? 0 : m![2].length;
        const unit = m![3];

        // (b) 分档：小数位数与单位由量级唯一决定
        //     注意实现在单位切换边界取「低单位进位」（1024³-1 → 1024.0MB），
        //     故按字节量级分档断言，不假设数值部分恒 < 1024。
        if (bytes < K) {
          expect(decimals).toBe(0);
          expect(unit).toBe('B');
        } else if (bytes < K3) {
          expect(decimals).toBe(1);
          expect(unit).toBe(bytes < K2 ? 'KB' : 'MB');
        } else {
          expect(decimals).toBe(2);
          expect(unit).toBe(bytes < K4 ? 'GB' : 'TB');
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 20: 格式化形态与非法输入占位
  it('Property 20: 负数 / NaN / 非有限数恒返回 `-`', () => {
    fc.assert(
      fc.property(invalidArb, (bad) => {
        expect(formatSize(bad)).toBe('-');
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 21: 格式化单调性
  it('Property 21: a <= b 时 parseSize(formatSize(a)) <= parseSize(formatSize(b))', () => {
    // 两条来源：一般取值对（byteArb）与两端同时落在 1024 各次幂附近的对（boundaryArb），
    // 后者让「跨单位切换边界」这种最容易破坏单调性的组合有足够密度被取到。
    const pairArb = fc
      .oneof(fc.tuple(byteArb, byteArb), fc.tuple(boundaryArb, boundaryArb))
      .map(([x, y]) => (x <= y ? ([x, y] as const) : ([y, x] as const)));

    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        expect(a).toBeLessThanOrEqual(b);
        const pa = parseSize(formatSize(a));
        const pb = parseSize(formatSize(b));
        expect(Number.isFinite(pa)).toBe(true);
        expect(Number.isFinite(pb)).toBe(true);
        expect(pa, `${a} -> ${formatSize(a)} vs ${b} -> ${formatSize(b)}`).toBeLessThanOrEqual(pb);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 22: 格式化近似往返
  it('Property 22: |parseSize(formatSize(n)) - n| <= max(0.01 * n, halfStep)', () => {
    /**
     * halfStep = 展示精度的半个最小刻度，完全由 formatSize 的输出文本决定：
     * 从文本解析单位得到进制因子、由小数位数得到刻度，
     * 即 0.5 × 10^(-小数位数) × 单位因子（1 位小数 → 0.05×因子，2 位小数 → 0.005×因子）。
     * 不复用实现内部的常量，保证测试独立于实现的分档写法。
     */
    const halfStepOf = (text: string): number => {
      const m = /^([0-9]+)(?:\.([0-9]+))?(B|KB|MB|GB|TB)$/.exec(text);
      expect(m, `unexpected shape: ${text}`).not.toBeNull();
      const decimals = m![2] === undefined ? 0 : m![2].length;
      const unit = m![3];
      const factor =
        unit === 'B' ? 1 : unit === 'KB' ? K : unit === 'MB' ? K2 : unit === 'GB' ? K3 : K4;
      return 0.5 * Math.pow(10, -decimals) * factor;
    };

    fc.assert(
      fc.property(byteArb, (bytes) => {
        const text = formatSize(bytes);
        const back = parseSize(text);
        expect(Number.isFinite(back)).toBe(true);

        const bound = Math.max(0.01 * bytes, halfStepOf(text));
        // 容差上再留 1e-9 的相对余量：`toFixed` 舍入落在刻度正中时（例 1075.2B → 1.1KB），
        // 误差在数学上恰等于 halfStep，二进制浮点减法可能给出末位偏大的结果。
        const slack = bound * 1e-9;
        expect(
          Math.abs(back - bytes),
          `${bytes} -> ${text} -> ${back} (bound ${bound})`
        ).toBeLessThanOrEqual(bound + slack);
      }),
      { numRuns: 100 }
    );
  });
});
