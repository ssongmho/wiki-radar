// 1단계 스모크: 테스트 사본 위키(today=2026-09-23)로 빌드된 앱을 띄워 명세 §3 정답표·§8 테스트 식별자로 확인한다.
// 먼저 `npm run package`(또는 `npm run e2e`). 결과 스크린샷은 test-results/sidebar.png·full.png.
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { Bucket } from '../../src/shared/types';
import {
  FIXTURE_WIKI,
  RESULTS_DIR,
  closeApp,
  curatedTaskId,
  launchApp,
  settle,
  treeDigest,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
} from './app';

const TODAY = '2026-09-23';

/** 명세 §3 counts + 2단계 명세 §4-1(정리 대상 규칙·테스트 사본 줄 3개 추가) */
const COUNTS: Record<Bucket, number> = { overdue: 5, thisWeek: 4, chased: 2, stale: 2, other: 10 };

/** 명세 §3 정답표의 지남·이번 주 순서(§2 정렬: due 오름차순 → 제목) */
const OVERDUE_TITLES = [
  'LDAR 견적서 회신',
  '한결케미칼 통영공장 사용량 미반영 회신',
  '서진화학 EHS 잔여 오류 목록 — 우선순위 회신',
  '계약관리 권한 오류 수정 (26년 이전 계약 조회)',
  '팀 회의록 공유, 사업부 채널에',
];
const THIS_WEEK_TITLES = [
  '누리소재 MSDS 개정차수 반영 — 완료 예정일 회신',
  '법인카드 지출결의서 작성',
  '대륙물산 서버 교체 견적 방향 결정',
  '주간 업무보고 작성',
];

const HANGYEOL = '한결케미칼 통영공장 사용량 미반영 회신';
const HANGYEOL_MAIL_SUBJECT = 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청';
/** 할 일 메모.md 의 마지막 메모(두 줄) */
const HANGYEOL_MEMO = [
  '배치 로그를 확인함. 8월 집계 누락은 마감일 경계 조건 때문으로 보임.',
  '재실행 일정은 연휴 전으로 잡음',
];

const rowsOf = (page: Page, bucket: Bucket) => page.locator(`[data-testid="task-row"][data-bucket="${bucket}"]`);
const dayOf = (page: Page, date: string) => page.locator(`[data-testid="week-day"][data-date="${date}"]`);

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let logs: AppLogs;
let sidebar: Page;
let failed = false;
/** 시작 전 테스트 사본의 해시. 이 시험은 사본을 직접 읽으므로(쓰지 않는다) 끝난 뒤 그대로인지 본다 */
let fixtureBefore: Record<string, string> | undefined;

test.beforeAll(async () => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
  app = await launchApp({ wiki: FIXTURE_WIKI, today: TODAY });
  logs = watchLogs(app);
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  sidebar = await windowByMode(app, 'sidebar');
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  failed = true;
  await testInfo.attach('renderer-console.txt', {
    body: logs.renderer.join('\n') || '(없음)',
    contentType: 'text/plain',
  });
  await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
});

test.afterAll(async () => {
  if (!app) return;
  await app
    .context()
    .tracing.stop(failed ? { path: path.join(RESULTS_DIR, 'trace.zip') } : undefined)
    .catch(() => undefined);
  await closeApp(app);
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
});

test('사이드바: 이번 주 트랙과 구간이 정답표와 같다', async () => {
  const root = sidebar.getByTestId('sidebar');
  await expect(root).toBeVisible();

  // 구간 수(사이드바 목록은 지남·이번 주·재촉 중)
  await expect(sidebar.getByTestId('bucket-overdue')).toHaveAttribute('data-count', String(COUNTS.overdue));
  await expect(sidebar.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(COUNTS.thisWeek));
  await expect(sidebar.getByTestId('bucket-chased')).toHaveAttribute('data-count', String(COUNTS.chased));
  await expect(sidebar.getByTestId('snapshot-error')).toHaveCount(0);

  // 주간 트랙: 지남 칸 + 월~금, 오늘 9/23, 9/24·9/25 추석
  const track = sidebar.getByTestId('week-track');
  await expect(track).toBeVisible();
  await expect(track.getByTestId('week-overdue')).toHaveAttribute('data-count', String(COUNTS.overdue));
  await expect(track.getByTestId('week-day')).toHaveCount(5);
  await expect(dayOf(sidebar, '2026-09-23')).toHaveAttribute('data-today', 'true');
  await expect(dayOf(sidebar, '2026-09-23')).toHaveAttribute('data-holiday', 'false');
  await expect(dayOf(sidebar, '2026-09-24')).toHaveAttribute('data-holiday', 'true');
  await expect(dayOf(sidebar, '2026-09-25')).toHaveAttribute('data-holiday', 'true');
  await expect(dayOf(sidebar, '2026-09-24')).toHaveAttribute('data-today', 'false');
  await expect(root).toContainText('연휴 전 마지막 영업일');
  // 2단계 §4: 오래 밀렸거나 15영업일 넘게 열린 것은 '정리 대상' 줄로 모인다
  await expect(root).toContainText(`정리 대상 ${COUNTS.stale}건`);

  // 지남·이번 주 행(구간마다 6개까지 보이므로 전부 보인다)과 순서
  const overdueRows = rowsOf(sidebar, 'overdue');
  await expect(overdueRows).toHaveCount(OVERDUE_TITLES.length);
  await expect(overdueRows.first()).toContainText('LDAR 견적서 회신');
  await expect(overdueRows.first()).toHaveAttribute('data-task-id', curatedTaskId('LDAR 견적서 회신'));
  await expect(overdueRows).toContainText(OVERDUE_TITLES);
  const thisWeekRows = rowsOf(sidebar, 'thisWeek');
  await expect(thisWeekRows).toHaveCount(THIS_WEEK_TITLES.length);
  await expect(thisWeekRows).toContainText(THIS_WEEK_TITLES);

  // 머리의 버튼 3개
  await expect(sidebar.getByTestId('btn-full')).toBeVisible();
  await expect(sidebar.getByTestId('btn-pin')).toBeVisible();
  await expect(sidebar.getByTestId('btn-quit')).toBeVisible();

  // 처음엔 사이드바만 보인다
  await expect.poll(() => windowVisibility(app)).toEqual({ sidebar: true, full: false });

  await settle(sidebar);
  await sidebar.screenshot({ path: path.join(RESULTS_DIR, 'sidebar.png') });
});

test('renderer 격리: Node 전역이 없고 window.radar 만 있다', async () => {
  const full = await windowByMode(app, 'full');
  for (const page of [sidebar, full]) {
    const probe = await page.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      getSnapshot: typeof window.radar?.getSnapshot,
    }));
    expect(probe, page.url()).toEqual({ require: 'undefined', process: 'undefined', getSnapshot: 'function' });
  }
});

test('할 일을 누르면 풀스크린에서 그 항목이 열린다', async () => {
  const id = curatedTaskId(HANGYEOL);
  const row = sidebar.getByTestId('task-row').filter({ hasText: HANGYEOL });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-task-id', id);
  await expect(row).toHaveAttribute('data-bucket', 'overdue');
  await row.click();

  await expect
    .poll(() => windowVisibility(app), { message: '풀스크린 창이 보이고 사이드바는 숨어야 한다' })
    .toEqual({ sidebar: false, full: true });

  const full = await windowByMode(app, 'full');
  await expect(full.getByTestId('full')).toBeVisible();
  const detail = full.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-task-id', id);
  await expect(full.getByTestId('detail-title')).toHaveText(HANGYEOL);
  await expect(full.getByTestId('mail-subject')).toHaveText(HANGYEOL_MAIL_SUBJECT);
  for (const line of HANGYEOL_MEMO) await expect(detail).toContainText(line);

  // 풀스크린 목록: 트랙 + 전 구간
  await expect(full.getByTestId('week-overdue')).toHaveAttribute('data-count', String(COUNTS.overdue));
  for (const [bucket, count] of Object.entries(COUNTS)) {
    await expect(full.getByTestId(`bucket-${bucket}`)).toHaveAttribute('data-count', String(count));
  }
  await expect(full.getByTestId('btn-sidebar')).toBeVisible();

  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'full.png') });
});

test('사이드바로 버튼을 누르면 사이드바로 돌아간다', async () => {
  const full = await windowByMode(app, 'full');
  await full.getByTestId('btn-sidebar').click();

  await expect
    .poll(() => windowVisibility(app), { message: '사이드바가 보이고 풀스크린은 숨어야 한다' })
    .toEqual({ sidebar: true, full: false });
  await expect(sidebar.getByTestId('sidebar')).toBeVisible();
  await expect(sidebar.getByTestId('bucket-overdue')).toHaveAttribute('data-count', String(COUNTS.overdue));
});

test('renderer 콘솔 에러가 없다', async () => {
  expect(logs.rendererErrors).toEqual([]);
});
