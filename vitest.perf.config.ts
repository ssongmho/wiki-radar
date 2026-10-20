import { defineConfig } from 'vitest/config';

// 성능 시험(§12)은 다른 시험과 함께 돌면 서로 느려지므로 따로, 파일 하나씩 돌린다(npm run test 끝에).
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
