import { defineConfig } from 'vitest/config';

// 缓存目录放在项目内，避免写入系统临时目录时的权限问题
export default defineConfig({
  cacheDir: 'node_modules/.vitest-cache',
  test: {
    include: ['test/**/*.test.ts'],
    // 并行收集会偶发写缓存失败（EPERM），改为串行收集保证结果稳定
    fileParallelism: false,
  },
});
