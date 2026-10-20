// 2.7단계 e2e: 처음 실행 점검(docs/stage2.7-contract.md).
//   (a) 고른 위키 폴더(app-settings.json)가 없으면 처음 실행에 사이드바 대신 풀스크린 설정 › 점검이 뜬다 — 위키 없음·메일 없음은
//       '쓸 수 없음', claude(가짜)는 사용 가능. [확인] 뒤에는 VOC 화면으로 가고, 다시 띄우면 점검 없이 사이드바로 뜬다
//       (사이드바는 오류 대신 '위키 폴더가 없습니다' + [설정])
//   (b) 위키가 있으면 처음 실행에도 사이드바로 뜨고, 풀스크린 내비의 '설정'으로 볼 수 있다
// 폴더 고르기 창(dialog)은 시험하지 않는다 — 고른 결과는 app-settings.json 으로 대신 준다. 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication } from '@playwright/test';
import { FIXTURE_WIKI, closeApp, launchApp, treeDigest, watchLogs, windowByMode, windowVisibility, type AppLogs } from './app';

const TODAY = '2026-09-23';

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
let fixtureBefore: Record<string, string> | undefined;

test.beforeAll(() => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
});

test.afterAll(() => {
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
});

test.afterEach(async ({}, testInfo) => {
  if (app && logs && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
    await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (app) await closeApp(app);
  app = null;
  logs = null;
  while (temps.length) {
    try {
      fs.rmSync(temps.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 임시 폴더라 남아도 괜찮다
    }
  }
});

function readSettings(dataDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'app-settings.json'), 'utf8')) as Record<string, unknown>;
}

test('고른 위키 폴더가 없으면 처음 실행에 설정 › 점검이 뜨고, [확인] 뒤에는 다시 뜨지 않는다', async () => {
  test.setTimeout(120_000);
  const wiki = path.join(tempDir('wiki-radar-e2e-nowiki-'), 'none', 'WIKI');
  const dataDir = tempDir('wiki-radar-e2e-setup-data-');

  app = await launchApp({ wiki, today: TODAY, dataDir, wikiVia: 'settings' });
  logs = watchLogs(app);
  const full = await windowByMode(app, 'full');
  const view = full.getByTestId('setup-view');
  await expect(view).toBeVisible();
  await expect.poll(() => windowVisibility(app as ElectronApplication)).toEqual({ sidebar: false, full: true });

  await expect(full.getByTestId('setup-wiki')).toHaveAttribute('data-tone', 'off');
  await expect(full.getByTestId('setup-wiki')).toContainText(path.resolve(wiki));
  await expect(full.getByTestId('setup-wiki')).toContainText('할 일 · 반영 대기 · 메일 회신');
  await expect(full.getByTestId('setup-choose-wiki')).toBeVisible();
  await expect(full.getByTestId('setup-claude')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('setup-mail')).toHaveAttribute('data-tone', 'off');
  await expect(full.getByTestId('nav-setup')).toHaveAttribute('data-count', '2');
  await expect(full.getByTestId('nav-tasks-note')).toHaveText('위키 없음');

  await full.getByTestId('setup-done').click();
  await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'voc');
  await expect.poll(() => readSettings(dataDir)).toEqual({ wikiRoot: path.resolve(wiki), setupSeen: true });
  // 할 일 화면은 오류 대신 위키 없음 안내
  await full.getByTestId('nav-tasks').click();
  await expect(full.getByTestId('wiki-missing')).toBeVisible();
  expect(logs.rendererErrors).toEqual([]);

  await closeApp(app);
  app = null;

  // 다시 띄우면 점검 없이 사이드바로
  app = await launchApp({ wiki, today: TODAY, dataDir, wikiVia: 'settings' });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect(sidebar.getByTestId('wiki-missing')).toBeVisible();
  await expect(sidebar.getByTestId('sidebar-setup')).toBeVisible();
  await expect.poll(() => windowVisibility(app as ElectronApplication)).toEqual({ sidebar: true, full: false });

  // 사이드바 [설정] → 풀스크린 설정 › 점검
  await sidebar.getByTestId('sidebar-setup').click();
  const full2 = await windowByMode(app, 'full');
  await expect(full2.getByTestId('setup-view')).toBeVisible();
  await expect.poll(() => windowVisibility(app as ElectronApplication)).toEqual({ sidebar: false, full: true });
  expect(logs.rendererErrors).toEqual([]);
});

test('위키가 있으면 처음 실행에도 사이드바로 뜨고, 내비의 설정으로 볼 수 있다', async () => {
  const dataDir = tempDir('wiki-radar-e2e-setup-ok-');
  app = await launchApp({ wiki: FIXTURE_WIKI, today: TODAY, dataDir, wikiVia: 'settings' });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect(sidebar.getByTestId('week-track')).toBeVisible();
  await expect.poll(() => windowVisibility(app as ElectronApplication)).toEqual({ sidebar: true, full: false });

  await sidebar.getByTestId('btn-full').click();
  const full = await windowByMode(app, 'full');
  await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'tasks');
  // 메일 계정만 없다(테스트 사본에는 _mail-ingest/.env 가 없다)
  await expect(full.getByTestId('nav-setup')).toHaveAttribute('data-count', '1');
  await full.getByTestId('nav-setup').click();
  await expect(full.getByTestId('setup-view')).toBeVisible();
  await expect(full.getByTestId('setup-wiki')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('setup-wiki-state')).toHaveText('사용 가능');
  await expect(full.getByTestId('setup-wiki')).toContainText(path.resolve(FIXTURE_WIKI));
  expect(readSettings(dataDir)).toEqual({ wikiRoot: path.resolve(FIXTURE_WIKI) });
  expect(logs.rendererErrors).toEqual([]);
});
