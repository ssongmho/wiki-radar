import { defineConfig } from '@playwright/test';

// Electron 스모크 테스트 설정. 브라우저는 쓰지 않고 `_electron` 으로 빌드된 앱(.vite/build)을 띄운다.
// 그래서 `npx playwright install` 은 필요 없다. 먼저 `npm run package` 로 빌드한다(`npm run e2e` 는 함께 한다).
export default defineConfig({
  testDir: './test/e2e',
  outputDir: './test-results',
  // 앱은 한 번만 실행(single instance lock)되므로 동시에 여러 개를 띄우지 않는다.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
});
