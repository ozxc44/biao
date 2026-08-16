import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['tests/setup-guard.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    // 所有测试共享同一 Redis，必须串行（文件级 + 测试级）
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
