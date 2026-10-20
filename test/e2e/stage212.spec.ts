// 2.12단계 e2e(docs/stage2.12-contract.md §12-2): 알림 N2 — 트레이·작업 표시줄 오버레이 · [나중에] · Windows 알림 단추 · 보류 · 설정 · 창 닫기 · v1 호환.
// 시험 모드는 실제 트레이·Windows 알림·koffi 를 쓰지 않는다: 트레이·오버레이는 <데이터 폴더>/shell-log.jsonl 과 __radarTest.shell(),
// Windows 알림은 notify-log.jsonl, 보류 상태는 WIKI_RADAR_TEST_QUIET·__radarTest.setQuiet 로 넣는다. today 2026-09-23(수), 9/24~26 추석, 다음 업무일 9/28(월).
// 위키는 test/fixtures/wiki 를 읽기만 하고(원본 해시 비교), VOC 는 가짜 voc-cli 만 부른다. 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { InboxState, TrayLevel, VocBoard } from '../../src/shared/types';
import {
  FIXTURE_WIKI,
  closeApp,
  launchApp,
  radarTest,
  readNotifyLog,
  readShellLog,
  setTestNow,
  treeDigest,
  vocStateDir,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
} from './app';

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

interface ShellState {
  level: TrayLevel;
  tooltip: string;
  menu: { inboxLabel: string };
  overlay: { count: number; description: string };
  closeAction: 'tray' | 'quit';
}

const shellOf = (target: ElectronApplication): Promise<ShellState | null> => radarTest<ShellState | null>(target, 'shell');
const inboxOf = (page: Page): Promise<InboxState> => page.evaluate(() => window.radar.getInbox());

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** 가짜 VOC 상태의 티켓 하나를 고친다(앱 밖에서 바뀐 것처럼) */
function patchTicket(target: ElectronApplication, id: number, patch: Record<string, unknown>): void {
  const file = path.join(vocStateDir(target), 'tickets.json');
  const tickets = readJson<Record<string, unknown>[]>(file);
  const t = tickets.find((x) => x.id === id);
  if (!t) throw new Error(`가짜 VOC 에 티켓 ${id} 가 없다`);
  Object.assign(t, patch);
  fs.writeFileSync(file, JSON.stringify(tickets, null, 2), 'utf8');
}

async function okBoard(page: Page): Promise<VocBoard> {
  let board: VocBoard | undefined;
  await expect
    .poll(
      async () => {
        board = await page.evaluate(() => window.radar.getVocBoard());
        return board.state;
      },
      { timeout: 30_000 },
    )
    .toBe('ok');
  return board as VocBoard;
}

/** 아침 요약 + SLA 묶음 두 줄이 나올 때까지(09:10 시작) */
async function startAt0910(dataDir: string, extra: { quiet?: string; settings?: Record<string, unknown> } = {}) {
  app = await launchApp({ wiki: FIXTURE_WIKI, dataDir, voc: { mode: 'ok' }, now: '2026-09-23T09:10', ...extra });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  const board = await okBoard(sidebar);
  return { app, sidebar, board };
}

const urgentOf = (inbox: InboxState) => inbox.items.filter((i) => i.grade === 'urgent');

async function openFull(target: ElectronApplication, sidebar: Page): Promise<Page> {
  await sidebar.getByTestId('btn-full').click();
  return windowByMode(target, 'full');
}

async function backToSidebar(target: ElectronApplication, full: Page): Promise<void> {
  await full.getByTestId('btn-sidebar').click();
  await expect.poll(async () => (await windowVisibility(target)).sidebar).toBe(true);
}

test('1. 트레이·오버레이: 긴급 → 모두 읽음 → 오늘 · 메뉴 · VOC 로그인 필요 → 문제 · 툴팁·기록에 제목 없음', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-1-');
  const { sidebar, board } = await startAt0910(dataDir);
  const a = app as ElectronApplication;
  await expect.poll(() => readNotifyLog(dataDir).length, { timeout: 30_000 }).toBe(2);
  const urgent = urgentOf(await inboxOf(sidebar)).length;
  expect(urgent).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await shellOf(a))?.level).toBe('urgent');
  const shell = (await shellOf(a)) as ShellState;
  expect(shell.tooltip).toContain(`긴급 ${urgent}`);
  expect(shell.overlay).toEqual({ count: urgent, description: `안 읽은 긴급 ${urgent}건` });
  expect(shell.closeAction).toBe('tray');
  expect(readShellLog(dataDir).length).toBeGreaterThan(0);
  expect(readShellLog(dataDir).at(-1)).toMatchObject({ level: 'urgent', overlay: urgent });

  // 모두 읽음 → 오늘(테스트 사본에 지난 할 일이 있다), 오버레이 0
  const full = await openFull(a, sidebar);
  await full.getByTestId('inbox-bell').click();
  await full.getByTestId('inbox-read-all').click();
  await expect.poll(async () => (await shellOf(a))?.level).toBe('today');
  expect((await shellOf(a))?.overlay.count).toBe(0);
  expect((await shellOf(a))?.menu.inboxLabel).toBe('알림함');

  // 메뉴: 사이드바 · 알림함(풀스크린 + 판) · 사이드바
  await radarTest(a, 'trayMenu', '사이드바');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);
  expect((await windowVisibility(a)).full).toBe(false);
  await radarTest(a, 'trayMenu', '알림함');
  await expect.poll(async () => (await windowVisibility(a)).full).toBe(true);
  await expect(full.getByTestId('inbox-panel')).toBeVisible();
  await radarTest(a, 'trayMenu', '사이드바');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);
  // 메뉴 풀스크린 · 풀스크린 모드에서 트레이 클릭은 풀스크린 그대로 · 다시 사이드바
  await radarTest(a, 'trayMenu', '풀스크린');
  await expect.poll(async () => (await windowVisibility(a)).full).toBe(true);
  expect((await windowVisibility(a)).sidebar).toBe(false);
  await radarTest(a, 'trayClick');
  expect(await windowVisibility(a)).toMatchObject({ sidebar: false, full: true });
  await radarTest(a, 'trayMenu', '사이드바');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);

  // 툴팁·기록 어디에도 티켓 제목이 없다
  const titles = board.lanes.flatMap((l) => l.tickets.map((t) => t.title)).filter((t) => t.length > 3);
  const recorded = fs.readFileSync(path.join(dataDir, 'shell-log.jsonl'), 'utf8');
  for (const t of titles) expect(recorded).not.toContain(t);
  expect(logs?.rendererErrors).toEqual([]);

  // 메뉴 종료 → 앱 프로세스가 끝난다
  const exited = new Promise<void>((resolve) => a.process().once('exit', () => resolve()));
  await radarTest(a, 'trayMenu', '종료').catch(() => undefined);
  await exited;

  // 가짜 VOC 가 로그인 필요인 앱 → 문제(느낌표), 툴팁에 「VOC 로그인 필요」
  await closeApp(a);
  const dir2 = tempDir('wiki-radar-e2e-s212-1b-');
  app = await launchApp({ wiki: FIXTURE_WIKI, dataDir: dir2, voc: { mode: 'login' }, now: '2026-09-23T09:10' });
  logs = watchLogs(app);
  const b = app;
  const side2 = await windowByMode(b, 'sidebar');
  await expect.poll(async () => (await side2.evaluate(() => window.radar.getVocBoard())).state, { timeout: 30_000 }).toBe('login');
  await expect.poll(async () => (await shellOf(b))?.level).toBe('problem');
  expect((await shellOf(b))?.tooltip).toContain('VOC 로그인 필요');
});

test('2. [나중에] 1시간 · 미룬 사이 나빠지면 다시 · 깨면 다시 알림 · 끝난 일은 조용히 읽음', async () => {
  test.setTimeout(180_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-2-');
  const { sidebar } = await startAt0910(dataDir);
  const a = app as ElectronApplication;
  await expect.poll(() => readNotifyLog(dataDir).length, { timeout: 30_000 }).toBe(2);
  const before = await inboxOf(sidebar);
  const urgentCount = urgentOf(before).length;

  // SLA 임박(1001) [나중에] › 1시간 뒤
  const full = await openFull(a, sidebar);
  const bell = full.getByTestId('inbox-bell');
  await bell.click();
  const panel = full.getByTestId('inbox-panel');
  const warn = panel.locator('[data-testid="inbox-item"][data-key="voc:1001:sla-warning"]');
  await warn.getByTestId('inbox-snooze').click();
  await expect(full.getByTestId('inbox-snooze-1h')).toContainText('1시간 뒤 · ');
  await full.getByTestId('inbox-snooze-1h').click();
  await expect(bell).toHaveAttribute('data-unread', String(before.unread - 1));
  await expect(full.getByTestId('inbox-snoozed-count')).toHaveText('나중에 1');
  await full.getByTestId('inbox-snoozed-toggle').click();
  await expect(panel.locator('[data-testid="inbox-item"][data-key="voc:1001:sla-warning"]')).toHaveAttribute('data-snoozed', 'true');
  await expect(panel.getByTestId('inbox-snoozed-tag')).toHaveText(/에 다시$/);
  await expect.poll(async () => (await shellOf(a))?.overlay.count).toBe(urgentCount - 1);
  await full.keyboard.press('Escape');
  await backToSidebar(a, full);

  await setTestNow(a, '2026-09-23T10:00');
  await sidebar.waitForTimeout(500);
  expect(readNotifyLog(dataDir)).toHaveLength(2);

  // 1001 이 초과로 → 미룬 시각(10:10) 전에 새 줄, 옛 임박 항목은 읽음
  patchTicket(a, 1001, { slaStatus: 'exceeded' });
  await setTestNow(a, '2026-09-23T10:05');
  await sidebar.evaluate(() => window.radar.refreshVoc());
  await expect.poll(() => readNotifyLog(dataDir).length).toBe(3);
  const worse = readNotifyLog(dataDir)[2];
  expect(worse.keys).toEqual(['voc:1001:sla-exceeded']);
  expect(worse.at < '2026-09-23T10:10').toBe(true);
  const afterWorse = await inboxOf(sidebar);
  const oldWarn = afterWorse.items.find((i) => i.key === 'voc:1001:sla-warning');
  expect(oldWarn?.readAt).not.toBeNull();
  expect(oldWarn?.snoozeUntil).toBeNull();

  // 1004 를 1시간 미루고 +61분 → 그 키의 줄이 다시(단추 둘), 「다시 알림」
  const i1004 = afterWorse.items.find((i) => i.key === 'voc:1004:sla-exceeded');
  await sidebar.evaluate((id) => window.radar.snoozeInboxItems?.({ ids: [id], until: '1h' }), i1004?.id as string);
  await setTestNow(a, '2026-09-23T11:06');
  await expect.poll(() => readNotifyLog(dataDir).length).toBe(4);
  expect(readNotifyLog(dataDir)[3]).toMatchObject({ keys: ['voc:1004:sla-exceeded'], actions: ['열기', '1시간 뒤'], silent: true });
  const full2 = await openFull(a, sidebar);
  await full2.getByTestId('inbox-bell').click();
  await expect(full2.locator('[data-testid="inbox-item"][data-key="voc:1004:sla-exceeded"]')).toHaveAttribute('data-reminded', 'true');
  await full2.keyboard.press('Escape');
  await backToSidebar(a, full2);

  // 다시 미루고 가짜 VOC 에서 1004 를 끝냄 → 깰 시각 뒤에도 줄 없음, 항목 읽음
  await sidebar.evaluate((id) => window.radar.snoozeInboxItems?.({ ids: [id], until: '1h' }), i1004?.id as string);
  patchTicket(a, 1004, { status: 'closed', slaStatus: 'normal' });
  await sidebar.evaluate(() => window.radar.refreshVoc());
  await setTestNow(a, '2026-09-23T12:07');
  await sidebar.waitForTimeout(500);
  expect(readNotifyLog(dataDir)).toHaveLength(4);
  const done = (await inboxOf(sidebar)).items.find((i) => i.id === i1004?.id);
  expect(done?.readAt).not.toBeNull();
  expect(done?.snoozeUntil).toBeNull();
  expect(logs?.rendererErrors).toEqual([]);
});

test('3. 내일 아침: 9/28(월) 08:50 · 그사이 줄 없음 · 다음 업무일 아침 요약에 「나중에 1」, 그 항목만의 줄 없음', async () => {
  test.setTimeout(180_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-3-');
  app = await launchApp({ wiki: FIXTURE_WIKI, dataDir, voc: { mode: 'ok' }, now: '2026-09-23T16:00' });
  logs = watchLogs(app);
  const a = app;
  const sidebar = await windowByMode(a, 'sidebar');
  await okBoard(sidebar);
  await expect.poll(async () => (await inboxOf(sidebar)).items.some((i) => i.kind === 'due'), { timeout: 30_000 }).toBe(true);
  // 5분 묶음이 남았으면 내보내고 줄 수를 고정한다
  await setTestNow(a, '2026-09-23T16:06');
  await sidebar.waitForTimeout(500);
  const n = readNotifyLog(dataDir).length;
  const due = (await inboxOf(sidebar)).items.find((i) => i.kind === 'due' && i.readAt === null);
  expect(due).toBeTruthy();

  const full = await openFull(a, sidebar);
  await full.getByTestId('inbox-bell').click();
  const row = full.locator(`[data-testid="inbox-item"][data-key="${due?.key}"]`);
  await row.getByTestId('inbox-snooze').click();
  await expect(full.getByTestId('inbox-snooze-morning')).toHaveText('내일 아침 · 9/28(월) 08:50');
  await full.getByTestId('inbox-snooze-morning').click();
  await expect.poll(async () => (await inboxOf(sidebar)).items.find((i) => i.id === due?.id)?.snooze).toBe('morning');
  await full.keyboard.press('Escape');
  await backToSidebar(a, full);

  await setTestNow(a, '2026-09-23T18:00');
  await setTestNow(a, '2026-09-24T09:00');
  await sidebar.waitForTimeout(500);
  expect(readNotifyLog(dataDir)).toHaveLength(n);

  await setTestNow(a, '2026-09-28T09:00');
  await expect.poll(() => readNotifyLog(dataDir).length).toBe(n + 1);
  const morning = readNotifyLog(dataDir)[n];
  expect(morning).toMatchObject({ title: '오늘 요약', kinds: ['morning'], actions: [] });
  expect(morning.body).toContain('나중에 1');
  await sidebar.waitForTimeout(500);
  expect(readNotifyLog(dataDir).some((l) => l.at >= '2026-09-28' && l.keys.includes(due?.key as string))).toBe(false);
  const woke = (await inboxOf(sidebar)).items.find((i) => i.id === due?.id);
  expect(woke).toMatchObject({ readAt: null, snoozeUntil: null, reminded: true });
  expect(logs?.rendererErrors).toEqual([]);
});

test('4. Windows 알림 단추: [1시간 뒤] → 그 알림의 항목 전부 미룸(창 그대로) · [열기] → 풀스크린 + 읽음 · 표시 실패 → 점검 warn·트레이 문제', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-4-');
  const { sidebar } = await startAt0910(dataDir);
  const a = app as ElectronApplication;
  await expect.poll(() => readNotifyLog(dataDir).length, { timeout: 30_000 }).toBe(2);
  const [morningLine, slaLine] = readNotifyLog(dataDir);
  expect(slaLine.toastId).toMatch(/^t_[A-Za-z0-9]{12}$/);
  expect(slaLine.actions).toEqual(['열기', '1시간 뒤']);
  expect(morningLine.actions).toEqual([]);

  await radarTest(a, 'toastAction', slaLine.toastId, 1);
  const inbox = await inboxOf(sidebar);
  const sla = inbox.items.filter((i) => slaLine.keys.includes(i.key));
  expect(sla.length).toBe(slaLine.keys.length);
  for (const i of sla) {
    expect(i.snooze).toBe('1h');
    // 시험 시계도 실제 시간만큼 흐른다 — 보낸 뒤 1시간(+ 몇 초)
    const gap = Date.parse(i.snoozeUntil as string) - Date.parse(i.toastAt as string);
    expect(gap).toBeGreaterThanOrEqual(60 * 60_000);
    expect(gap).toBeLessThan(61 * 60_000);
  }
  expect(await windowVisibility(a)).toMatchObject({ sidebar: true, full: false });
  // 같은 알림을 또 눌러도 한 번만 처리한다(알림함을 열지 않는다)
  await radarTest(a, 'toastAction', slaLine.toastId, 0);
  expect((await windowVisibility(a)).full).toBe(false);
  // 모르는 toastId(앱을 다시 켠 뒤 알림 센터에서 누름 등)의 [1시간 뒤] → 미루지 않고 알림함을 연다(§3-5 안전한 쪽)
  await radarTest(a, 'toastAction', 't_000000000000', 1);
  await expect.poll(async () => (await windowVisibility(a)).full).toBe(true);
  const fullUnknown = await windowByMode(a, 'full');
  await expect(fullUnknown.getByTestId('inbox-panel')).toBeVisible();
  expect((await inboxOf(sidebar)).items.filter((i) => i.snoozeUntil !== null).map((i) => i.key).sort()).toEqual([...slaLine.keys].sort());
  await radarTest(a, 'trayMenu', '사이드바');
  await expect.poll(async () => (await windowVisibility(a)).full).toBe(false);

  await radarTest(a, 'toastAction', morningLine.toastId, 0);
  await expect.poll(async () => (await windowVisibility(a)).full).toBe(true);
  const full = await windowByMode(a, 'full');
  await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'tasks');
  expect((await inboxOf(sidebar)).items.find((i) => i.kind === 'morning')?.readAt).not.toBeNull();

  // 표시 실패 → 트레이 문제(긴급은 모두 미룸) · 점검 「알림」 줄 warn
  await radarTest(a, 'toastFailed', morningLine.toastId);
  await expect.poll(async () => (await shellOf(a))?.level).toBe('problem');
  expect((await shellOf(a))?.tooltip).toContain('Windows 알림 실패');
  await full.getByTestId('nav-setup').click();
  await expect(full.getByTestId('setup-notify')).toHaveAttribute('data-tone', 'warn');
  await expect(full.getByTestId('setup-notify')).toContainText('표시하지 못했습니다');
  expect(logs?.rendererErrors).toEqual([]);
});

test('5. 보류: 전체 화면 중 켬 → 줄 0·held → 풀리면 「보류한 알림 N건」 1줄 · 발표 중 · 감지 없음 · 보류 중 업무 끝', async () => {
  test.setTimeout(200_000);
  // (a) 켤 때부터 전체 화면
  const dataDir = tempDir('wiki-radar-e2e-s212-5a-');
  const { sidebar } = await startAt0910(dataDir, { quiet: 'fullscreen' });
  const a = app as ElectronApplication;
  await expect.poll(async () => urgentOf(await inboxOf(sidebar)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await inboxOf(sidebar)).held?.count ?? 0).toBe(urgentOf(await inboxOf(sidebar)).length + 1);
  expect(readNotifyLog(dataDir)).toEqual([]);
  const urgent = urgentOf(await inboxOf(sidebar)).length;
  const full = await openFull(a, sidebar);
  await full.getByTestId('inbox-bell').click();
  await expect(full.getByTestId('inbox-held')).toHaveAttribute('data-reason', 'fullscreen');
  await expect(full.getByTestId('inbox-held')).toContainText(`보류 중 — 전체 화면 앱 사용 중 · ${urgent + 1}건`);
  await full.keyboard.press('Escape');
  await full.getByTestId('nav-setup').click();
  await expect(full.getByTestId('setup-notify')).toHaveAttribute('data-quiet', 'held');
  await expect(full.getByTestId('setup-notify')).toHaveAttribute('data-tone', 'warn');
  await expect(full.getByTestId('setup-notify')).toContainText('지금 보낼 수 없음');
  await backToSidebar(a, full);
  await radarTest(a, 'setQuiet', 'accepts');
  await expect.poll(() => readNotifyLog(dataDir).length).toBe(1);
  await sidebar.waitForTimeout(500);
  expect(readNotifyLog(dataDir)).toHaveLength(1);
  const [held] = readNotifyLog(dataDir);
  expect(held.title).toBe(`보류한 알림 ${urgent + 1}건`);
  expect(held.body.startsWith('오늘 요약 ·')).toBe(true);
  expect(held.actions).toEqual(['열기', '1시간 뒤']);
  await closeApp(a);

  // (b) 발표 중 16:00 오늘 마감 → 줄 없음 → 풀리면 1줄
  const dir2 = tempDir('wiki-radar-e2e-s212-5b-');
  const second = await startAt0910(dir2);
  const b = second.app;
  const side = second.sidebar;
  await expect.poll(() => readNotifyLog(dir2).length, { timeout: 30_000 }).toBe(2);
  await radarTest(b, 'setQuiet', 'presentation');
  await setTestNow(b, '2026-09-23T16:00');
  await expect.poll(async () => (await inboxOf(side)).held?.reason).toBe('presentation');
  expect(readNotifyLog(dir2)).toHaveLength(2);
  await radarTest(b, 'setQuiet', 'accepts');
  await expect.poll(() => readNotifyLog(dir2).length).toBe(3);
  expect(readNotifyLog(dir2)[2].kinds).toEqual(['due']);

  // (c) 감지를 쓸 수 없음 → 점검 줄, 다음 신호는 그대로 줄
  await radarTest(b, 'setQuiet', 'unavailable');
  const full2 = await openFull(b, side);
  await full2.getByTestId('nav-setup').click();
  await expect(full2.getByTestId('setup-notify')).toContainText('감지를 쓸 수 없습니다');
  await expect(full2.getByTestId('setup-notify')).toHaveAttribute('data-quiet', 'unavailable');
  await backToSidebar(b, full2);
  patchTicket(b, 1002, { slaStatus: 'exceeded' });
  await setTestNow(b, '2026-09-23T16:10');
  await side.evaluate(() => window.radar.refreshVoc());
  await expect.poll(() => readNotifyLog(dir2).length).toBe(4);
  expect(readNotifyLog(dir2)[3].keys).toEqual(['voc:1002:sla-exceeded']);

  // (d) 보류 중 업무 시간이 끝나면 풀어도 줄 없음, 항목 deferred
  await radarTest(b, 'setQuiet', 'fullscreen');
  patchTicket(b, 1006, { slaStatus: 'warning' });
  await setTestNow(b, '2026-09-23T18:00');
  await side.evaluate(() => window.radar.refreshVoc());
  await expect.poll(async () => (await inboxOf(side)).items.some((i) => i.key === 'voc:1006:sla-warning')).toBe(true);
  expect((await inboxOf(side)).held?.reason).toBe('fullscreen');
  await setTestNow(b, '2026-09-23T19:30');
  await radarTest(b, 'setQuiet', 'accepts');
  await side.waitForTimeout(500);
  expect(readNotifyLog(dir2)).toHaveLength(4);
  expect((await inboxOf(side)).items.find((i) => i.key === 'voc:1006:sla-warning')?.deferred).toBe(true);
  expect(logs?.rendererErrors).toEqual([]);
});

test('6. 설정 › 알림: 조용한 시간 12:00~13:00 · 소리 저장 → 12:10 신호는 보류(조용한 시간(설정)) → 13:00 1줄 silent:false · 시작 ≥ 끝은 저장 불가', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-6-');
  const { sidebar } = await startAt0910(dataDir);
  const a = app as ElectronApplication;
  await expect.poll(() => readNotifyLog(dataDir).length, { timeout: 30_000 }).toBe(2);
  const full = await openFull(a, sidebar);
  await full.getByTestId('nav-setup').click();
  await full.getByTestId('settings-tab-notify').click();
  await expect(full.getByTestId('notify-dnd-note')).toContainText('Windows 방해 금지는 알 수 없습니다');
  await expect(full.getByTestId('notify-quiet-hold')).toBeChecked();
  await expect(full.getByTestId('notify-sound')).not.toBeChecked();

  // 시작 ≥ 끝 → 문장·저장 꺼짐
  await full.getByTestId('notify-quiet-start').fill('13:00');
  await full.getByTestId('notify-quiet-end').fill('12:00');
  await expect(full.getByTestId('notify-problem')).toContainText('조용한 시간 끝이 시작보다 늦어야 합니다');
  await expect(full.getByTestId('notify-save')).toBeDisabled();
  await full.getByTestId('notify-quiet-clear').click();
  await expect(full.getByTestId('notify-problem')).toHaveCount(0);

  await full.getByTestId('notify-quiet-start').fill('12:00');
  await full.getByTestId('notify-quiet-end').fill('13:00');
  await full.getByTestId('notify-sound').check();
  await full.getByTestId('notify-save').click();
  await expect
    .poll(() => readJson<Record<string, unknown>>(path.join(dataDir, 'app-settings.json')).notify)
    .toMatchObject({ quietStart: '12:00', quietEnd: '13:00', sound: true, quietHold: true, hideContent: false });
  await backToSidebar(a, full);

  await setTestNow(a, '2026-09-23T12:10');
  patchTicket(a, 1002, { slaStatus: 'exceeded' });
  await sidebar.evaluate(() => window.radar.refreshVoc());
  await expect.poll(async () => (await inboxOf(sidebar)).held?.reason).toBe('userQuiet');
  expect(readNotifyLog(dataDir)).toHaveLength(2);
  const full2 = await openFull(a, sidebar);
  await full2.getByTestId('inbox-bell').click();
  await expect(full2.getByTestId('inbox-held')).toContainText('조용한 시간(설정)');
  await full2.keyboard.press('Escape');
  await backToSidebar(a, full2);

  await setTestNow(a, '2026-09-23T13:00');
  await expect.poll(() => readNotifyLog(dataDir).length).toBe(3);
  expect(readNotifyLog(dataDir)[2]).toMatchObject({ keys: ['voc:1002:sla-exceeded'], silent: false });
  expect(logs?.rendererErrors).toEqual([]);
});

/** 그 모드의 창에 close() 를 부른다(Alt+F4 와 같은 경로) */
async function closeWindow(target: ElectronApplication, which: 'sidebar' | 'full'): Promise<void> {
  await target.evaluate(({ BrowserWindow }, mode) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(`mode=${mode}`));
    win?.close();
  }, which);
}

test('7. 창 닫기: 기본은 숨김 → 트레이 클릭으로 다시 · 풀스크린 닫기 → 사이드바 · 「Radar 끝내기」 저장 → 사이드바 닫기로 앱 종료', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-7-');
  app = await launchApp({ wiki: FIXTURE_WIKI, dataDir });
  logs = watchLogs(app);
  const a = app;
  const sidebar = await windowByMode(a, 'sidebar');
  await expect(sidebar.getByTestId('week-track')).toBeVisible();

  await closeWindow(a, 'sidebar');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(false);
  await radarTest(a, 'trayClick');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);

  const full = await openFull(a, sidebar);
  await closeWindow(a, 'full');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);
  expect((await windowVisibility(a)).full).toBe(false);

  // 「Radar 끝내기」 저장
  await sidebar.getByTestId('btn-full').click();
  await full.getByTestId('nav-setup').click();
  await full.getByTestId('settings-tab-notify').click();
  await expect(full.getByTestId('shell-close-tray')).toHaveAttribute('aria-checked', 'true');
  await full.getByTestId('shell-close-quit').check();
  await expect(full.getByTestId('notify-save')).toBeEnabled();
  await full.getByTestId('notify-save').click();
  await expect.poll(() => readJson<Record<string, unknown>>(path.join(dataDir, 'app-settings.json')).shell).toEqual({ closeAction: 'quit' });
  expect(readJson<Record<string, unknown>>(path.join(dataDir, 'app-settings.json')).notify).toBeUndefined();
  expect((await shellOf(a))?.closeAction).toBe('quit');

  // 풀스크린 닫기는 여전히 사이드바로
  await closeWindow(a, 'full');
  await expect.poll(async () => (await windowVisibility(a)).sidebar).toBe(true);

  // 사이드바 닫기 → 앱 프로세스가 끝난다
  const exited = new Promise<void>((resolve) => a.process().once('exit', () => resolve()));
  await closeWindow(a, 'sidebar').catch(() => undefined);
  await exited;
  // 끝난 프로세스라도 closeApp 이 시험용 사용자 데이터 폴더를 지운다
  await closeApp(a);
  app = null;
});

test('8. 호환: 2.9 모양(v1) notifications.json 으로 켜도 같은 아침 요약·SLA 줄이 다시 나가지 않고, 저장은 version 2', async () => {
  test.setTimeout(150_000);
  const dataDir = tempDir('wiki-radar-e2e-s212-8-');
  const at = (hm: string) => new Date(2026, 8, 23, Number(hm.slice(0, 2)), Number(hm.slice(3))).toISOString();
  const item = (id: string, key: string, family: string, kind: string, grade: string, title: string) => ({
    id,
    key,
    family,
    kind,
    grade,
    title,
    body: '',
    target: 'view:inbox',
    createdAt: at('09:00'),
    readAt: null,
    toastAt: at('09:00'),
    deferred: false,
  });
  const v1 = {
    version: 1,
    items: [
      item('n_morning0001', 'morning:2026-09-23', 'morning:2026-09-23', 'morning', 'today', '오늘 요약'),
      item('n_sla00001', 'voc:1001:sla-warning', 'voc:1001:sla', 'vocSla', 'urgent', 'VOC SLA 임박'),
      item('n_sla00002', 'voc:1004:sla-exceeded', 'voc:1004:sla', 'vocSla', 'urgent', 'VOC SLA 초과'),
      item('n_sla00003', 'voc:1003:sla-exceeded', 'voc:1003:sla', 'vocSla', 'urgent', 'VOC SLA 초과'),
    ],
    families: {
      'morning:2026-09-23': { rank: 1, at: at('09:00') },
      'voc:1001:sla': { rank: 1, at: at('07:00') },
      'voc:1004:sla': { rank: 2, at: at('07:00') },
      'voc:1003:sla': { rank: 2, at: at('07:00') },
    },
    morning: '2026-09-23',
    toasts: [at('09:00')],
    lastToastAt: at('09:00'),
    pending: null,
    vocMine: null,
  };
  fs.writeFileSync(path.join(dataDir, 'notifications.json'), JSON.stringify(v1), 'utf8');
  const { sidebar } = await startAt0910(dataDir);
  const a = app as ElectronApplication;
  await expect.poll(async () => JSON.parse(fs.readFileSync(path.join(dataDir, 'notifications.json'), 'utf8')).version, { timeout: 30_000 }).toBe(2);
  await setTestNow(a, '2026-09-23T09:20');
  await sidebar.waitForTimeout(1_000);
  expect(readNotifyLog(dataDir)).toEqual([]);
  const inbox = await inboxOf(sidebar);
  for (const id of ['n_morning0001', 'n_sla00001', 'n_sla00002']) expect(inbox.items.some((i) => i.id === id)).toBe(true);
  expect(inbox.items.every((i) => i.snoozeUntil === null)).toBe(true);
  expect(logs?.rendererErrors).toEqual([]);
});
