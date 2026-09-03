import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    globals: false,
    // 部分属性测试（storage.orphan / classify / scanner / analyzer）会在真实临时目录上做
    // 大量文件 IO，并行负载下单个用例耗时会超过 vitest 默认的 5s，导致间歇性
    // "Test timed out in 5000ms"。这些用例是 IO 密集而非死循环，放宽到 30s 既能消除
    // 抖动，也仍能及时暴露真正的挂起。
    //
    // 注意：**光靠调大这个全局值治不了本**。真正吃掉时间的是「真实 fs 夹具 × 高轮数」，
    // 30s 之后仍在 CI 与本地高负载下偶发超时（实测：单文件耗时从 11s 飙到 114s）。
    // 治本的做法是给那些用例单独降轮数并加显式超时——见
    // `tests/storage.scanner.property.spec.ts` 与 `tests/storage.analyzer.property.spec.ts`
    // 里对真实 fs 用例的 `numRuns` 说明。组合覆盖交给同组的内存 fs 用例承担。
    testTimeout: 30000,
  },
});
