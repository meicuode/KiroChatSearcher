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
    testTimeout: 30000,
  },
});
