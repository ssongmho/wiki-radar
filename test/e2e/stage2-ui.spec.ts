// 2단계 화면 회귀 시험: 저장 알림 자리·초점 돌려놓기·일부만 저장·기타 구간 유지·마지막 반영 날짜.
// 테스트 사본(test/fixtures/wiki)의 임시 복사본으로 빌드된 앱을 띄우고 가짜 claude 만 쓴다. 먼저 `npm run package`.
//   - 알림은 폼 위에 겹치지 않는다([저장]·'위키 지식에도 반영'이 가려지지 않는다)
//   - 저장 실패·알림 닫기·취소·빼기·반영 시작·사이드바 '반영' 뒤 초점이 body 로 떨어지지 않는다
//   - 할 일 파일이 잠겨 뒤 파일만 막히면 '일부만 저장' 경고 — 메모·반영 요청은 남고, 항목이 목록에 남아 다시 저장된다
//   - 기타 구간 항목을 고른 채 반영 대기에 다녀와도 초점이 그 줄로 온다(Enter 로 선택이 바뀌지 않는다)
//   - 마지막 반영이 다른 날이면 날짜를 붙이고, 실패 문장은 그때 한 일로 말한다
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ReflectRun } from '../../src/shared/types';
import {
  FIXTURE_WIKI,
  checkboxTaskId,
  closeApp,
  createWikiSandbox,
  launchSandboxApp,
  treeDigest,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
  type WikiSandbox,
} from './app';

const TODAY = '2026-09-23';
const TODO = '_private/mgmt/내 할 일.md';
const MEMO = '_private/mgmt/할 일 메모.md';
const BACKUP_ROOT = '_todo-sync/backup';

const CARD_LINE = '- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]';
const CARD_ID = checkboxTaskId(TODO, CARD_LINE);
const WEEKLY_LINE = '- [ ] 주간 업무보고 작성 #내할일 [pri:: 2] [due:: 2026-09-25]';
const WEEKLY_ID = checkboxTaskId(TODO, WEEKLY_LINE);
/** 기타 구간 항목 */
const MONTHLY_LINE = '- [ ] **월간 리포트** 초안 작성 #내할일 [pri:: 2] [due:: 2026-09-30] [wip:: 2026-09-20]';
const MONTHLY_ID = checkboxTaskId(TODO, MONTHLY_LINE);

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const rowById = (page: Page, id: string) => page.locator(`[data-testid="task-row"][data-task-id="${id}"]`);

interface Focused {
  tag: string;
  testid: string | null;
  id: string;
  taskId: string | null;
  name: string | null;
  value: string | null;
  text: string;
}

/** 지금 초점이 있는 요소(body 면 tag 'BODY') */
async function focused(page: Page): Promise<Focused> {
  return page.evaluate(() => {
    const el = (document.activeElement ?? document.body) as HTMLElement;
    return {
      tag: el.tagName,
      testid: el.getAttribute('data-testid'),
      id: el.id,
      taskId: el.getAttribute('data-task-id'),
      name: el.getAttribute('name'),
      value: el instanceof HTMLInputElement ? el.value : null,
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  });
}

/** 요소 한가운데에서 맨 위에 있는 것이 그 요소(또는 그 안·그것을 감싼 label)인가 — 다른 것에 가려지지 않았는가 */
async function isTopmost(loc: Locator, within?: string): Promise<boolean> {
  await loc.scrollIntoViewIfNeeded();
  return loc.evaluate((el, sel) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) return false;
    const host = sel ? el.closest(sel) : el;
    return hit === el || el.contains(hit) || (!!host && (host === hit || host.contains(hit)));
  }, within ?? null);
}

async function openInFull(full: Page, id: string): Promise<Locator> {
  const row = rowById(full, id);
  await expect(row, `풀스크린 목록에 ${id} 가 있어야 한다`).toHaveCount(1);
  await row.click();
  const detail = full.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-task-id', id);
  await expect(detail.getByTestId('btn-save')).toBeVisible();
  return detail;
}

/** 저장 알림이 새로 뜰 때까지(앞 알림 글자와 다른 글자) 기다려 글자를 돌려준다 */
async function waitNewNotice(full: Page, before: string | null): Promise<string> {
  const notice = full.getByTestId('save-notice');
  const textOf = async () =>
    (await notice.count()) === 0 ? null : ((await notice.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  await expect
    .poll(async () => {
      const now = await textOf();
      return now !== null && now !== '' && now !== before;
    }, { message: '저장 결과 알림이 새로 떠야 한다', timeout: 20_000 })
    .toBe(true);
  return (await textOf()) ?? '';
}

async function noticeText(full: Page): Promise<string | null> {
  const notice = full.getByTestId('save-notice');
  return (await notice.count()) === 0 ? null : ((await notice.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

/** 다른 프로그램처럼 파일을 잡는다: 읽기·쓰기 공유는 하되 삭제 공유 없이(OneDrive·파이썬 쓰기와 같은 모양) — 이름 바꾸기가 막힌다 */
function holdWithoutDeleteShare(abs: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const p = abs.replace(/'/g, "''");
    const ps =
      `$fs=[System.IO.File]::Open('${p}','Open','ReadWrite','ReadWrite'); ` +
      "[Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); Start-Sleep -Seconds 120; $fs.Close()";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('파일을 잡는 PowerShell 이 시작하지 못했다')), 20_000);
    child.stdout?.on('data', (d) => {
      if (String(d).includes('LOCKED')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`파일을 잡는 PowerShell 이 끝남(${code})`));
    });
  });
}

async function release(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}

async function attachLogs(logs: AppLogs | undefined, testInfo: import('@playwright/test').TestInfo): Promise<void> {
  if (!logs || testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
  await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
}

// ---- 한 앱으로 차례로 -------------------------------------------------------------------

test.describe('2단계 화면 회귀(알림 자리·초점·일부만 저장·기타 구간)', () => {
  test.describe.configure({ mode: 'serial' });

  let fixtureBefore: Record<string, string>;
  let app: ElectronApplication;
  let sandbox: WikiSandbox;
  let logs: AppLogs;
  let sidebar: Page;
  let full: Page;
  let holder: ChildProcess | undefined;

  test.beforeAll(async () => {
    fixtureBefore = treeDigest(FIXTURE_WIKI);
    ({ app, sandbox } = await launchSandboxApp({ today: TODAY, claudeMode: 'ok' }));
    logs = watchLogs(app);
    sidebar = await windowByMode(app, 'sidebar');
    full = await windowByMode(app, 'full');
    await sidebar.evaluate(() => window.radar.setMode('full'));
    await expect.poll(() => windowVisibility(app)).toEqual({ sidebar: false, full: true });
  });

  test.afterEach(async ({}, testInfo) => {
    await release(holder);
    holder = undefined;
    try {
      fs.chmodSync(sandbox.file(TODO), 0o666);
    } catch {
      // 없으면 그대로
    }
    await attachLogs(logs, testInfo);
  });

  test.afterAll(async () => {
    await release(holder);
    if (app) await closeApp(app);
    if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
  });

  test('저장 알림은 폼 위에 겹치지 않는다 — [저장]·위키 지식에도 반영이 가려지지 않는다', async () => {
    const detail = await openInFull(full, WEEKLY_ID);
    await detail.getByTestId('form-status-wip').check();
    await detail.getByTestId('form-note').fill('초안 절반');
    const before = await noticeText(full);
    await detail.getByTestId('btn-save').click();
    await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toBeVisible();
    // 진행 중은 목록에 남고 폼도 그대로 — 새로 적어 [저장]을 다시 쓸 수 있게 한다
    await expect(detail).toHaveAttribute('data-task-id', WEEKLY_ID);
    await detail.getByTestId('form-note').fill('실적 수치 확인');
    await expect(detail.getByTestId('btn-save')).toBeEnabled();
    expect(await isTopmost(detail.getByTestId('btn-save')), '[저장]이 알림에 가려졌다').toBe(true);
    expect(await isTopmost(detail.getByTestId('form-reflect'), '.check-card'), "'위키 지식에도 반영'이 알림에 가려졌다").toBe(true);
    // 알림은 여전히 보인다
    await expect(full.getByTestId('save-notice')).toBeVisible();
    // 키보드: 처리 내용에서 Tab → 반영 체크 → [취소]를 지나 [저장] — 초점 받은 것이 가려지지 않는다
    await detail.getByTestId('form-note').focus();
    await full.keyboard.press('Tab');
    expect((await focused(full)).testid).toBe('form-reflect');
    expect(await isTopmost(detail.getByTestId('form-reflect'), '.check-card')).toBe(true);
    await full.keyboard.press('Tab');
    expect((await focused(full)).testid).toBe('btn-save');
    expect(await isTopmost(detail.getByTestId('btn-save'))).toBe(true);
    // 적은 것은 되돌려 둔다(다음 시험이 이 항목을 쓰지 않지만 초안을 남기지 않게)
    await detail.getByRole('button', { name: '취소' }).click();
  });

  test('저장 실패 뒤 초점은 [저장]으로, 알림을 닫으면 [저장]으로, [취소] 뒤에는 상태 라디오로', async () => {
    const todoBefore = sandbox.read(TODO);
    const memoBefore = sandbox.read(MEMO);
    const backupsBefore = fs.readdirSync(sandbox.file(BACKUP_ROOT)).sort();
    fs.chmodSync(sandbox.file(TODO), 0o444); // 읽기 전용 → 쓰기 확인에서 막힌다(아무것도 쓰지 않는다)

    const detail = await openInFull(full, CARD_ID);
    await detail.getByTestId('form-status-done').check();
    await detail.getByTestId('form-note').fill('영수증 붙여 상신');
    const before = await noticeText(full);
    await detail.getByTestId('btn-save').focus();
    await full.keyboard.press('Enter');
    const text = await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'error');
    expect(text).toContain('저장하지 못했습니다');
    expect(text).toContain('아무것도 쓰지 않았음');
    // 아무것도 쓰지 않았다(메모도, 백업도)
    expect(sandbox.read(TODO)).toBe(todoBefore);
    expect(sandbox.read(MEMO)).toBe(memoBefore);
    expect(fs.readdirSync(sandbox.file(BACKUP_ROOT)).sort()).toEqual(backupsBefore);
    await expect(rowById(full, CARD_ID)).toHaveCount(1);
    // 초점: 저장 중 비활성이던 [저장]으로 돌아온다
    await expect.poll(async () => (await focused(full)).testid, { message: '실패 뒤 초점은 [저장]' }).toBe('btn-save');

    // 알림 닫기(키보드) → 닫기 버튼이 사라져도 초점은 [저장]으로
    await full.getByRole('button', { name: '저장 결과 알림 닫기' }).focus();
    await full.keyboard.press('Enter');
    await expect(full.getByTestId('save-notice')).toHaveCount(0);
    await expect.poll(async () => (await focused(full)).testid, { message: '알림을 닫은 뒤 초점은 [저장]' }).toBe('btn-save');

    // [취소] → 되돌린 뒤 비활성이 되어도 초점은 되돌린 상태(대기) 라디오로
    const cancel = detail.getByRole('button', { name: '취소' });
    await expect(cancel).toBeEnabled();
    await cancel.focus();
    await full.keyboard.press('Enter');
    await expect(cancel).toBeDisabled();
    await expect
      .poll(async () => {
        const f = await focused(full);
        return `${f.name}:${f.value}`;
      }, { message: '취소 뒤 초점은 상태 라디오' })
      .toBe('result-status:open');
  });

  test('할 일 파일이 삭제 공유 없이 잡혀 있으면 일부만 저장 — 메모·반영 요청은 남고, 다시 저장하면 마저 된다', async () => {
    test.skip(process.platform !== 'win32', 'Windows 파일 공유 잠금 시험');
    const todoBefore = lf(sandbox.read(TODO));
    const note = '지출결의 올림 — 잠금 시험';
    const queueBefore = (await full.evaluate(() => window.radar.getQueue())).length;

    const detail = await openInFull(full, CARD_ID);
    await detail.getByTestId('form-status-done').check();
    await detail.getByTestId('form-note').fill(note);
    await detail.getByTestId('form-reflect').check();
    holder = await holdWithoutDeleteShare(sandbox.file(TODO));
    const before = await noticeText(full);
    await detail.getByTestId('btn-save').click();
    const text = await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'warn');
    expect(text).toContain('일부만 저장했습니다');
    expect(text).toContain('할 일 메모.md');
    expect(text).not.toContain('입력한 내용은 그대로');
    // 메모는 먼저 썼고, 할 일 줄은 그대로 → 항목이 목록에 남아 다시 저장할 수 있다
    expect(lf(sandbox.read(MEMO))).toContain(note);
    expect(lf(sandbox.read(TODO))).toBe(todoBefore);
    await expect(rowById(full, CARD_ID)).toHaveCount(1);
    await expect(detail).toHaveAttribute('data-task-id', CARD_ID);
    // '위키 지식에도 반영' 요청은 대기열에 남았다
    await expect
      .poll(async () => (await full.evaluate(() => window.radar.getQueue())).filter((q) => q.taskId === CARD_ID).length)
      .toBe(1);
    await expect(full.getByTestId('nav-queue')).toHaveAttribute('data-count', String(queueBefore + 1));
    // 초점은 [저장]으로(다시 누를 수 있다), 입력은 그대로
    await expect.poll(async () => (await focused(full)).testid).toBe('btn-save');
    await expect(detail.getByTestId('form-note')).toHaveValue(note);
    await expect(detail.getByTestId('form-status-done')).toBeChecked();

    // 잠금이 풀린 뒤 같은 내용으로 다시 저장 → 할 일 줄이 완료로, 메모는 한 번만
    await release(holder);
    holder = undefined;
    const before2 = await noticeText(full);
    await detail.getByTestId('btn-save').click();
    await waitNewNotice(full, before2);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'ok');
    await expect(rowById(full, CARD_ID)).toHaveCount(0);
    expect(lf(sandbox.read(TODO))).toContain(`- [x] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23] [done:: ${TODAY}]`);
    expect(lf(sandbox.read(MEMO)).split(note).length - 1).toBe(1);
    const queue = await full.evaluate(() => window.radar.getQueue());
    expect(queue.filter((q) => q.taskId === CARD_ID)).toHaveLength(1);
    expect(logs.rendererErrors).toEqual([]);
  });

  test('기타 구간 항목을 고른 채 반영 대기에 다녀와도 초점은 그 줄 — Enter 로 선택이 바뀌지 않는다', async () => {
    await full.getByTestId('nav-tasks').click();
    const toggle = full.getByTestId('bucket-other').locator('.bucket-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = rowById(full, MONTHLY_ID);
    await expect(row).toHaveAttribute('data-bucket', 'other');
    await row.click();
    await expect(full.getByTestId('detail')).toHaveAttribute('data-task-id', MONTHLY_ID);

    for (let i = 0; i < 2; i++) {
      await full.getByTestId('nav-queue').click();
      await expect(full.getByTestId('queue-list')).toBeVisible();
      await full.getByTestId('nav-tasks').focus();
      await full.keyboard.press('Enter');
      await expect(full.getByTestId('detail')).toHaveAttribute('data-task-id', MONTHLY_ID);
      await expect.poll(async () => (await focused(full)).taskId, { message: '돌아오면 초점은 고른 줄' }).toBe(MONTHLY_ID);
      await expect(toggle, '기타는 편 채로 남는다').toHaveAttribute('aria-expanded', 'true');
      await full.keyboard.press('Enter');
      await expect(full.getByTestId('detail')).toHaveAttribute('data-task-id', MONTHLY_ID);
    }
  });

  test('반영 대기: [빼기] 뒤 초점은 다음 [빼기], 비면 목록 제목 — [반영 시작] 뒤에는 진행·결과 제목', async () => {
    // 대기열 준비: 화면이 저장에 쓰는 것과 같은 API 로 두 항목(진행 중 + 반영)
    for (const [taskId, note] of [
      [WEEKLY_ID, '반영 시험 1'],
      [MONTHLY_ID, '반영 시험 2'],
    ] as const) {
      await full.evaluate(({ taskId, note }) => window.radar.saveResult({ taskId, status: 'wip', note, reflect: true }), { taskId, note });
    }
    await full.getByTestId('nav-queue').click();
    const list = full.getByTestId('queue-list');
    await expect(list).toBeVisible();
    const count = Number(await list.getAttribute('data-count'));
    expect(count).toBeGreaterThanOrEqual(3); // 앞 시험의 법인카드 + 둘

    // 첫 줄 [빼기] → 초점은 (새) 첫 줄의 [빼기]
    const items = full.getByTestId('queue-item');
    const firstId = await items.first().getAttribute('data-queue-id');
    const secondId = await items.nth(1).getAttribute('data-queue-id');
    await items.first().getByRole('button', { name: /빼기/ }).focus();
    await full.keyboard.press('Enter');
    await expect(list).toHaveAttribute('data-count', String(count - 1));
    await expect(full.locator(`[data-queue-id="${firstId}"]`)).toHaveCount(0);
    await expect
      .poll(async () =>
        full.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('[data-testid="queue-item"]')?.getAttribute('data-queue-id') ?? null),
      )
      .toBe(secondId);

    // [위키에 반영] → 확인 → [반영 시작](키보드) → 초점은 진행 표시(끝났으면 결과) 제목
    await full.getByTestId('btn-reflect').click();
    const dialog = full.getByTestId('reflect-confirm');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /반영 시작/ }).focus();
    await full.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => (await focused(full)).id, { message: '반영 시작 뒤 초점은 진행·결과 제목' })
      .toMatch(/^run-(status|result)-title$/);
    await expect.poll(async () => (await full.evaluate(() => window.radar.getReflect()))?.state, { timeout: 30_000 }).toBe('done');
    await expect(full.getByTestId('reflect-result')).toHaveAttribute('data-state', 'done');
    // 진행 표시가 결과로 바뀌어도 초점은 결과 제목에 남는다
    await expect.poll(async () => (await focused(full)).id, { message: '끝나면 초점은 결과 제목' }).toBe('run-result-title');

    // 대기열을 비운 뒤 새 한 항목을 넣고 빼면 초점은 목록 제목으로
    await full.evaluate((taskId) => window.radar.saveResult({ taskId, status: 'wip', note: '마지막 한 건', reflect: true }), WEEKLY_ID);
    await expect(list).toHaveAttribute('data-count', '1');
    await items.first().getByRole('button', { name: /빼기/ }).focus();
    await full.keyboard.press('Enter');
    await expect(list).toHaveAttribute('data-count', '0');
    await expect.poll(async () => (await focused(full)).id, { message: '다 빼면 초점은 목록 제목' }).toBe('qv-list-title');
    expect(logs.rendererErrors).toEqual([]);
  });
});

// ---- 마지막 반영 결과의 날짜 -------------------------------------------------------------

test.describe('마지막 반영 결과(앱을 다시 켠 뒤 며칠 전 기록)', () => {
  let app: ElectronApplication | undefined;
  let sandbox: WikiSandbox | undefined;
  let logs: AppLogs | undefined;

  test.afterEach(async ({}, testInfo) => attachLogs(logs, testInfo));

  test.afterAll(async () => {
    if (app) await closeApp(app);
    sandbox?.dispose();
  });

  test("사이드바 '반영 N' 으로 열면 초점은 화면 제목 · 다른 날 끝난 실행은 날짜를 붙이고 실패 문장은 그때 한 일로", async () => {
    sandbox = createWikiSandbox();
    // 5일 전(9월 18일) 낮에 끝난 실패 기록. 대기열은 비어 있다(그 뒤 사람이 뺐다)
    const finishedAt = new Date(2026, 8, 18, 13, 5).toISOString();
    const startedAt = new Date(2026, 8, 18, 13, 2).toISOString();
    const run: ReflectRun = {
      id: 'old-run',
      startedAt,
      finishedAt,
      state: 'failed',
      itemIds: ['q-old'],
      log: ['claude 실행을 시작함 — 항목 1건', '끝남(종료 코드 1)'],
      error: 'claude 가 종료 코드 1 로 끝남',
    };
    fs.writeFileSync(path.join(sandbox.data, 'reflect-history.json'), JSON.stringify([run], null, 2), 'utf8');
    ({ app } = await launchSandboxApp({ today: TODAY, claudeMode: 'fail', sandbox, disposeOnClose: false }));
    logs = watchLogs(app);
    const sidebar = await windowByMode(app, 'sidebar');
    const full = await windowByMode(app, 'full');
    await expect.poll(() => windowVisibility(app!)).toEqual({ sidebar: true, full: false });
    // 사이드바 상태 줄 '반영 0' → 풀스크린 반영 대기 화면. 창이 바뀌어 풀스크린 문서에는 초점이 없다 → 화면 제목으로
    await sidebar.getByTestId('sidebar-queue').click();
    await expect.poll(() => windowVisibility(app!)).toEqual({ sidebar: false, full: true });
    await expect(full.getByTestId('queue-list')).toHaveAttribute('data-count', '0');
    await expect.poll(async () => (await focused(full)).id, { message: '초점은 반영 대기 제목' }).toBe('qv-title');
    const result = full.getByTestId('reflect-result');
    await expect(result).toHaveAttribute('data-state', 'failed');
    await expect(result).toContainText('9월 18일 오후 1:05 끝남');
    await expect(result).toContainText('그때 보낸 항목은 대기열에 남겨 두었습니다');
    await expect(result).not.toContainText('대기열은 그대로 남아 있습니다');
    await expect(result).toContainText('실패 이유');
    expect(logs.rendererErrors).toEqual([]);
  });
});
