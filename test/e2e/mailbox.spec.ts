// 2.10단계 B(메일함 화면) 시험 — docs/stage2.10-contract.md §14-3 (a)~(k).
// 테스트 사본(test/fixtures/wiki — 가상 업체·사람·*.example 주소만)의 임시 복사본 + 로컬 가짜 SMTP + 가짜 voc-cli + 가짜 claude 만 쓴다.
// 실제 위키·메일 서버·VOC 서버는 부르지 않는다. raw/ 는 시나리오 전후로 해시가 같아야 한다(새 메일을 복사해 넣는 (i) 의 그 파일만 빼고).
// 먼저 `npm run package`.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  FIXTURE_WIKI,
  RESULTS_DIR,
  closeApp,
  createWikiSandbox,
  launchApp,
  settle,
  startFakeSmtp,
  treeDigest,
  vocCalls,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
  type FakeSmtp,
  type WikiSandbox,
} from './app';

/** 대륙물산 메일(dr-1@daeryuk.example)의 메일 ID — 2.15 부터 [할 일로] 는 [mail:: m:<sha1(Message-ID) 앞 16자>] 를 쓴다 */
const DR_KEY = 'm:bf8c93c59bfbee0e';
const NOW = '2026-09-23T10:00';
const TODO = '_private/mgmt/내 할 일.md';
const DR = 'raw/mail/대륙물산/2026/2026-09-21_1100_박담당_자재 단가 문의_d1d2d3.md';
const HG_EXISTING = 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md';
/** 테스트 사본의 미확인 스레드(기준선 9/20 10:00 — 격리 · 서식 안내 · 대륙물산 · 한결 9/22) */
const FIXTURE_UNREAD = 4;
/** 「전체」 스레드 수(노이즈 추정 2개 빠짐) */
const FIXTURE_THREADS = 7;
/** 가짜 voc-cli 가 ticket create 에 주는 번호 */
const CREATED_PREFIX = 'VOC-2026-';

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
let sandbox: WikiSandbox | null = null;
let smtp: FakeSmtp | null = null;
let fixtureBefore: Record<string, string> | undefined;
/** (k) raw/ 불변: 띄우기 전 사본의 raw/ 해시 — 시험마다 끝에(위키에 쓰는 (f)(g)(h) 뒤에도) 견준다. ignore 는 시험이 일부러 넣은 새 메일 */
let rawCheck: { before: Record<string, string>; ignore: Set<string> } | null = null;

function rawDigest(): Record<string, string> {
  return treeDigest(path.join(sandbox!.wiki, 'raw'));
}

/** 시험이 일부러 raw/mail 에 넣는 새 메일(띄운 뒤) — (k) 비교에서 뺀다 */
function addMail(rel: string, text: string): void {
  rawCheck?.ignore.add(rel.replace(/^raw\//, ''));
  fs.writeFileSync(sandbox!.file(rel), text, 'utf8');
}

test.beforeAll(() => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
});
test.afterAll(() => {
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
});
test.afterEach(async ({}, testInfo) => {
  if (app && logs && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (app) await closeApp(app);
  app = null;
  logs = null;
  await smtp?.close();
  smtp = null;
  const check = rawCheck;
  rawCheck = null;
  try {
    if (sandbox && check && testInfo.status === testInfo.expectedStatus) {
      const after = Object.fromEntries(Object.entries(rawDigest()).filter(([k]) => !check.ignore.has(k)));
      expect(after, '(k) raw/ 는 읽기만 한다 — 시나리오 전체 전후 해시가 같다').toEqual(check.before);
    }
  } finally {
    sandbox?.dispose();
    sandbox = null;
  }
});

async function start(opts: { smtp?: boolean; voc?: boolean } = {}): Promise<{ sidebar: Page; full: Page }> {
  sandbox = createWikiSandbox('wiki-radar-e2e-mailbox-');
  rawCheck = { before: rawDigest(), ignore: new Set() };
  if (opts.smtp) smtp = await startFakeSmtp();
  app = await launchApp({
    wiki: sandbox.wiki,
    dataDir: sandbox.data,
    now: NOW,
    ...(smtp ? { smtp: { port: smtp.port } } : {}),
    ...(opts.voc ? { voc: { mode: 'ok' } } : {}),
  });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  return { sidebar, full: await openMailbox(sidebar) };
}

/** 사이드바 [메일함 열기]로 풀스크린 메일함을 연다 */
async function openMailbox(sidebar: Page): Promise<Page> {
  await sidebar.getByTestId('btn-sidebar-mailbox').click();
  await waitForMode(app!, 'full');
  const full = await windowByMode(app!, 'full');
  await expect(full.getByTestId('mailbox-view')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(full.getByTestId('mail-thread-row').first()).toBeVisible();
  return full;
}

function rowWith(full: Page, text: string): Locator {
  return full.getByTestId('mail-thread-row').filter({ hasText: text });
}

async function pick(full: Page, text: string): Promise<Locator> {
  const row = rowWith(full, text);
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(full.getByTestId('mail-body')).toBeVisible();
  return row;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** 그 창이 보일 때까지 */
async function waitForMode(a: ElectronApplication, mode: 'full' | 'sidebar'): Promise<void> {
  await expect.poll(async () => (await windowVisibility(a))[mode] === true, { timeout: 15_000 }).toBe(true);
}

test('(a)(b)(c)(d)(e)(i)(k) 내비·사이드바 · 목록·안전한 본문·읽음 · 회신 필요 · 처리함·키보드 · 검색·폴더·노이즈 · 새 메일 · raw 불변', async () => {
  test.setTimeout(150_000);
  sandbox = createWikiSandbox('wiki-radar-e2e-mailbox-');
  const rawBefore = rawDigest();
  rawCheck = { before: rawBefore, ignore: new Set() };
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');

  await test.step('(a) 사이드바 메일 블록: 미확인 4 · 회신 필요 0 · 3줄 · 제목까지만', async () => {
    const block = sidebar.getByTestId('sidebar-mail');
    await expect(block).toHaveAttribute('data-unread', String(FIXTURE_UNREAD));
    await expect(block).toHaveAttribute('data-reply-needed', '0');
    await expect(block.getByTestId('sidebar-mail-row')).toHaveCount(3);
    await expect(block).not.toContainText('@');
  });

  // 메일함을 열기 전부터 풀스크린 창의 요청을 지켜본다(원격 이미지·추적 픽셀이 없어야 한다)
  const external: string[] = [];
  const fullEarly = await windowByMode(app, 'full');
  fullEarly.on('request', (req) => {
    const url = req.url();
    if (!/^(file:|devtools:|data:|blob:|chrome-extension:)/.test(url)) external.push(url);
  });
  const full = await openMailbox(sidebar);
  expect(full).toBe(fullEarly);

  await test.step('(a) 내비: 「들어오는 것」 안 [메일]이 [VOC] 위, 수 = 미확인 스레드', async () => {
    const group = full.locator('ul[aria-labelledby="nav-group-incoming"] > li button');
    await expect(group.nth(0)).toHaveAttribute('data-testid', 'nav-mail');
    await expect(group.nth(1)).toHaveAttribute('data-testid', 'nav-voc');
    await expect(full.getByTestId('nav-mail')).toHaveAttribute('aria-current', 'page');
    await expect(full.locator('.titlebar-page')).toHaveText('메일');
    await expect(full.getByTestId('mail-filter-all')).toHaveAttribute('data-count', String(FIXTURE_THREADS));
  });

  await test.step('(b) 열 때는 아무것도 고르지 않는다 — 1초 넘게 두어도 읽음 그대로', async () => {
    await expect(full.getByTestId('mail-reader')).toContainText('고른 메일이 없습니다.');
    await expect(full.locator('[data-testid="mail-thread-row"][aria-current="true"]')).toHaveCount(0);
    await full.waitForTimeout(1_500);
    await expect(full.getByTestId('nav-mail')).toHaveAttribute('data-count', String(FIXTURE_UNREAD));
  });

  await test.step('(b) 첫 스레드(가장 최근 — 피싱 의심)를 골라 1초 넘게 보면 읽음 → 배지 1 줄어듦 · 피싱 의심 띠 · 실행형 첨부', async () => {
    const first = full.getByTestId('mail-thread-row').first();
    await expect(first).toContainText('[긴급] 메일 계정 확인 필요');
    await first.click();
    await expect(full.getByTestId('mail-suspicious')).toContainText('피싱 의심 — 링크·첨부를 열지 마세요');
    await expect(full.getByTestId('mail-suspicious')).toContainText('실행형 첨부');
    const att = full.getByTestId('mail-attachment');
    await expect(att).toHaveAttribute('data-blocked', 'true');
    await expect(full.getByTestId('btn-mail-attachment-reveal')).toHaveCount(0);
    await expect(full.getByTestId('nav-mail')).toHaveAttribute('data-count', String(FIXTURE_UNREAD - 1), { timeout: 5_000 });
    await expect(first).toHaveAttribute('data-unread', 'false');
    await expect(sidebar.getByTestId('sidebar-mail')).toHaveAttribute('data-unread', String(FIXTURE_UNREAD - 1));
  });

  await test.step('(b) 한결케미칼 스레드 한 줄: 4통 · 첨부 · 할 일 칩, 분석 자리는 한 줄', async () => {
    const hg = rowWith(full, '통영공장 CMS 인벤토리');
    await expect(hg).toHaveCount(1);
    await expect(hg).toHaveAttribute('data-count', '4');
    await expect(hg.getByTestId('mail-chip-attach')).toBeVisible();
    await expect(hg.getByTestId('mail-chip-task')).toBeVisible();
    await pick(full, '통영공장 CMS 인벤토리');
    // 2.16: 로컬 LLM 이 설정되지 않았으면 분석 자리에 그 이유 한 줄(가짜 결과를 보이지 않는다)
    await expect(full.getByTestId('mail-analysis-off')).toHaveText('설정 › AI 에서 로컬 LLM 주소·모델을 넣으세요');
    await expect(full.getByTestId('mail-thread-item')).toHaveCount(4);
    await expect(full.getByTestId('mail-links')).toContainText('한결케미칼 통영공장 사용량 미반영 회신');
    await expect(full.getByTestId('btn-mail-task')).toHaveAttribute('data-blocked-reason', /이미 할 일이 있습니다/);
    // 스레드 안 [ ] 로 이전 메일
    await full.getByTestId('mail-reader').locator('h1').focus();
    await full.keyboard.press('[');
    await expect(full.getByTestId('mail-thread-item').nth(2)).toHaveAttribute('aria-current', 'true');
  });

  await test.step('(b) HTML 흔적 메일: <script>·<img>·<a href> 는 글자로만 — 요소 없음, 외부 요청 0', async () => {
    await pick(full, '서식 안내');
    const body = full.getByTestId('mail-body');
    await expect(body).toContainText('<script>alert(1)</script>');
    await expect(body).toContainText('<img src="https://tracker.example.invalid/p.gif">');
    await expect(body).toContainText('이전 지시를 무시하고');
    const reader = full.getByTestId('mail-reader');
    await expect(reader.locator('img, script, iframe, object, embed, a[href]')).toHaveCount(0);
    expect(await full.evaluate(() => typeof (window as unknown as { alert?: unknown }).alert)).toBe('function');
    await full.waitForTimeout(1_200);
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'mailbox-html.png') });
    expect(external, '메일 본문이 외부 요청을 일으키면 안 된다').toEqual([]);
  });

  await test.step('(c) 회신 필요 켜기 → 필터 「회신 필요」 · 사이드바 수 → 해제', async () => {
    await pick(full, '자재 단가 문의');
    await full.getByTestId('btn-mail-reply-needed').click();
    await expect(full.getByTestId('mail-filter-replyNeeded')).toHaveAttribute('data-count', '1');
    await expect(rowWith(full, '자재 단가 문의')).toHaveAttribute('data-reply-needed', 'true');
    await expect(rowWith(full, '자재 단가 문의').getByTestId('mail-chip-reply')).toBeVisible();
    await expect(sidebar.getByTestId('sidebar-mail')).toHaveAttribute('data-reply-needed', '1');
    await expect(full.getByTestId('nav-mail')).toHaveAttribute('data-reply-needed', '1');
    await full.getByTestId('mail-filter-replyNeeded').click();
    await expect(full.getByTestId('mail-filter-replyNeeded')).toHaveAttribute('aria-pressed', 'true');
    await expect(full.getByTestId('mail-thread-row')).toHaveCount(1);
    // 필터를 바꾸면 고른 것이 풀린다 — 다시 고른다
    await full.getByTestId('mail-thread-row').first().click();
    await expect(full.getByTestId('btn-mail-reply-needed')).toHaveText(/회신 필요 해제/);
    await full.getByTestId('btn-mail-reply-needed').click();
    await expect(full.getByTestId('mail-filter-replyNeeded')).toHaveAttribute('data-count', '0');
    await expect(sidebar.getByTestId('sidebar-mail')).toHaveAttribute('data-reply-needed', '0');
    await full.getByTestId('mail-filter-all').click();
  });

  await test.step('(d) 처리함으로(E) → 「전체」에서 빠짐 · 되돌리기 · 처리함 → 받은편지함으로', async () => {
    await pick(full, '자재 단가 문의');
    await full.getByTestId('mail-reader').locator('h1').focus();
    await full.keyboard.press('e');
    await expect(rowWith(full, '자재 단가 문의')).toHaveCount(0);
    await expect(full.getByTestId('mail-filter-all')).toHaveAttribute('data-count', String(FIXTURE_THREADS - 1));
    await expect(full.getByTestId('mail-filter-archived')).toHaveAttribute('data-count', '1');
    // 되돌리기
    await full.getByTestId('btn-mail-undo').click();
    await expect(rowWith(full, '자재 단가 문의')).toHaveCount(1);
    // 다시 처리함으로(버튼) → 처리함 필터 → 받은편지함으로
    await pick(full, '자재 단가 문의');
    await full.getByTestId('btn-mail-archive').click();
    await expect(rowWith(full, '자재 단가 문의')).toHaveCount(0);
    await full.getByTestId('mail-filter-archived').click();
    const archived = rowWith(full, '자재 단가 문의');
    await expect(archived).toHaveAttribute('data-archived', 'true');
    await archived.click();
    await expect(full.getByTestId('btn-mail-archive')).toHaveText(/받은편지함으로/);
    await full.getByTestId('btn-mail-archive').click();
    await expect(full.getByTestId('mail-filter-archived')).toHaveAttribute('data-count', '0');
    await full.getByTestId('mail-filter-all').click();
    await expect(full.getByTestId('mail-filter-all')).toHaveAttribute('data-count', String(FIXTURE_THREADS));
  });

  await test.step('(d) 키보드: ↓/↑ 다음·이전 스레드, / 검색 칸', async () => {
    const rows = full.getByTestId('mail-thread-row');
    await rows.nth(1).click();
    await rows.nth(1).focus();
    await full.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(2)).toBeFocused();
    await full.keyboard.press('ArrowUp');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await full.keyboard.press('/');
    await expect(full.getByTestId('mail-search')).toBeFocused();
    // 입력 칸 안에서는 글자 단축키가 동작하지 않는다
    await full.keyboard.type('e');
    await expect(full.getByTestId('mail-filter-archived')).toHaveAttribute('data-count', '0');
    await full.getByTestId('mail-search').fill('');
  });

  await test.step('(e) 검색(보낸이·제목·메일함 이름) · 폴더 목록 · 노이즈 추정 포함', async () => {
    const search = full.getByTestId('mail-search');
    const rows = full.getByTestId('mail-thread-row');
    await search.fill('박담당');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('자재 단가 문의');
    await search.fill('인벤토리');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('통영공장');
    await search.fill('대륙물산');
    await expect(rows).toHaveCount(1);
    await search.fill('');
    await expect(rows).toHaveCount(FIXTURE_THREADS);
    const folder = full.locator('[data-testid="mail-folder"][data-folder="한결케미칼"]');
    await folder.click();
    await expect(folder).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);
    await folder.click();
    await expect(rows).toHaveCount(FIXTURE_THREADS);
    await full.getByTestId('mail-include-muted').check();
    await expect(rows).toHaveCount(FIXTURE_THREADS + 2);
    await expect(rowWith(full, '주간 소식')).toBeVisible();
    await full.getByTestId('mail-include-muted').uncheck();
    await expect(rows).toHaveCount(FIXTURE_THREADS);
  });

  await test.step('(b) 「미확인」 필터: 1초 읽음이 다음 줄로 줄줄이 번지지 않는다(저절로 보인 줄은 고를 때까지 미확인)', async () => {
    // 두 스레드를 미확인으로 되돌린다(U)
    for (const subject of ['자재 단가 문의', '서식 안내']) {
      await pick(full, subject);
      await full.getByTestId('mail-reader').locator('h1').focus();
      await full.keyboard.press('u');
      await expect(rowWith(full, subject)).toHaveAttribute('data-unread', 'true');
    }
    // [미확인으로] 직후의 「다시 읽음 막기」를 풀려고 이미 읽은 스레드로 옮긴다
    await pick(full, '통영공장 CMS 인벤토리');
    const unreadBefore = Number(await full.getByTestId('mail-filter-unread').getAttribute('data-count'));
    expect(unreadBefore).toBeGreaterThanOrEqual(2);
    await full.getByTestId('mail-filter-unread').click();
    // 필터를 바꾸면 아무것도 고르지 않는다 — 첫 줄을 고른다
    await full.getByTestId('mail-thread-row').first().click();
    // 첫 줄은 1초 뒤 읽음 → 수는 줄지만 그 줄은 목록·읽기 칸에 그대로 남는다(옆 줄로 넘어가지 않음 — 2026-10-19 버그 고침)
    const firstId = await full.getByTestId('mail-thread-row').first().getAttribute('data-thread-id');
    await expect(full.getByTestId('mail-filter-unread')).toHaveAttribute('data-count', String(unreadBefore - 1), { timeout: 5_000 });
    await full.waitForTimeout(3_000);
    await expect(full.getByTestId('mail-filter-unread')).toHaveAttribute('data-count', String(unreadBefore - 1));
    await expect(full.getByTestId('mail-thread-row')).toHaveCount(unreadBefore);
    const kept = full.getByTestId('mail-thread-row').first();
    await expect(kept).toHaveAttribute('data-thread-id', firstId ?? '');
    await expect(kept).toHaveAttribute('aria-current', 'true');
    await expect(kept).toHaveAttribute('data-unread', 'false');
    // 다음 줄을 고르면 그 줄이 읽음이 되고, 앞서 읽은 줄은 그때 빠진다
    await full.getByTestId('mail-thread-row').nth(1).click();
    await expect(full.getByTestId('mail-filter-unread')).toHaveAttribute('data-count', String(unreadBefore - 2), { timeout: 5_000 });
    await expect(full.getByTestId('mail-thread-row')).toHaveCount(unreadBefore - 1, { timeout: 5_000 });
    await full.getByTestId('mail-filter-all').click();
  });

  await test.step('(k) raw/ 는 읽기만 — 해시가 같다 · 상태는 데이터 폴더에만', async () => {
    expect(treeDigest(path.join(sandbox!.wiki, 'raw')), 'raw/ 는 읽기만 한다').toEqual(rawBefore);
    expect(fs.existsSync(path.join(sandbox!.data, 'mail-state.json'))).toBe(true);
  });

  await test.step('(i) 새 메일: 실행 중 raw/mail/대륙물산/2026 에 한 통 복사 → 5초 안에 목록·배지·사이드바 갱신', async () => {
    // 고른 스레드가 1초 뒤 읽음이 되며 수가 바뀌지 않게, 이미 읽은 스레드를 고르고 기다린 뒤 센다
    await pick(full, '통영공장 CMS 인벤토리');
    await full.waitForTimeout(1_500);
    const before = Number(await full.getByTestId('nav-mail').getAttribute('data-count'));
    const src = sandbox!.read(DR);
    const rel = 'raw/mail/대륙물산/2026/2026-09-23_0930_박담당_추가 견적 요청_d4d5d6.md';
    addMail(
      rel,
      src
        .replace('dr-1@daeryuk.example', 'dr-2@daeryuk.example')
        .replace('uidl-dr-1', 'uidl-dr-2')
        .replace(/자재 단가 문의 드립니다/g, '추가 견적 요청드립니다')
        .replace('2026-09-21T11:00:40+09:00', '2026-09-23T09:30:00+09:00'),
    );
    await expect(rowWith(full, '추가 견적 요청드립니다')).toHaveCount(1, { timeout: 5_000 });
    await expect(full.getByTestId('nav-mail')).toHaveAttribute('data-count', String(before + 1));
    await expect(sidebar.getByTestId('sidebar-mail')).toHaveAttribute('data-unread', String(before + 1));
    await expect(sidebar.getByTestId('sidebar-mail-row').first()).toContainText('추가 견적 요청드립니다');
  });
});

test('(f)(h) 메일함 회신(가짜 SMTP — 위키 그대로, 보낸 뒤 처리함) · 할 일로(내 할 일 「메일 회신 대기」 절 끝에 골든 줄)', async () => {
  test.setTimeout(150_000);
  const { full } = await start({ smtp: true });
  const wikiBefore = treeDigest(sandbox!.wiki);
  const todoBefore = lf(sandbox!.read(TODO));

  await test.step('(f) [회신] → 받는사람 = reply_to → 핵심 → [초안 만들기](가짜) → 고침 → [보내기…] → 확인 → 가짜 SMTP', async () => {
    await pick(full, '자재 단가 문의');
    await full.getByTestId('btn-mail-reply').click();
    const view = full.getByTestId('mail-reply-view');
    await expect(view).toBeVisible();
    await expect(view.getByTestId('reply-panel')).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });
    await expect(view.getByTestId('reply-to')).toHaveValue('구매팀 <buy@daeryuk.example>');
    await expect(view.getByTestId('reply-subject')).toHaveValue('RE: 자재 단가 문의 드립니다');
    await view.getByTestId('mail-reply-note').fill('단가표는 다음 주 화요일에 보내 드린다');
    await view.getByTestId('btn-draft').click();
    await expect(view.getByTestId('draft-status')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
    const body = view.getByTestId('reply-body');
    await expect(body).toHaveValue(/단가표는 다음 주 화요일에 보내 드린다/);
    await body.fill('안녕하세요.\n단가표는 다음 주 화요일에 보내 드리겠습니다.\n\n감사합니다.');
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'mailbox-reply.png') });
    await view.getByTestId('btn-send').click();
    const dialog = full.getByTestId('reply-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('위키에는 아무것도 쓰지 않습니다');
    await expect(dialog.getByTestId('mail-reply-archive-after')).toBeChecked();
    expect(smtp!.messages, '확인 전에는 보내지 않는다').toHaveLength(0);
    await dialog.getByTestId('btn-send-confirm').click();
    await expect(full.getByTestId('mail-reply-view')).toHaveCount(0);
    await expect(full.getByTestId('save-notice')).toContainText('회신을 보냈습니다');
    await expect.poll(() => smtp!.messages.length).toBe(1);
    const raw = smtp!.messages[0].raw;
    expect(raw).toMatch(/In-Reply-To: <dr-1@daeryuk\.example>/);
    expect(raw).toMatch(/buy@daeryuk\.example/);
    expect(smtp!.messages[0].envelope.to).toContain('buy@daeryuk.example');
  });

  await test.step('(f) 발송 기록 taskId:"" · origin:mailbox, 그 스레드는 처리함으로(회신함 칩), 위키는 그대로', async () => {
    const sent = sandbox!.readData<{ taskId: string; origin?: string; mail?: string }[]>('sent-mail.json');
    expect(sent?.[0]).toMatchObject({ taskId: '', origin: 'mailbox', mail: DR });
    await expect(rowWith(full, '자재 단가 문의')).toHaveCount(0);
    await full.getByTestId('mail-filter-archived').click();
    const row = rowWith(full, '자재 단가 문의');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('mail-chip-replied')).toHaveText('회신함');
    expect(treeDigest(sandbox!.wiki), '메일함 회신은 위키에 쓰지 않는다').toEqual(wikiBefore);
  });

  await test.step('(h) [할 일로] → 골든 줄 · 할 일 목록 · 「할 일」 칩 · 다시는 막힘', async () => {
    await pick(full, '자재 단가 문의');
    await full.getByTestId('btn-mail-task').click();
    const form = full.getByTestId('mail-task-form');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('mail-task-title')).toHaveValue('자재 단가 문의 드립니다');
    await form.getByTestId('mail-task-title').fill('자재 단가 회신');
    await form.getByTestId('mail-task-pri').selectOption('2');
    await form.getByTestId('btn-mail-task-create').click();
    await expect(full.getByTestId('save-notice')).toContainText('‘자재 단가 회신’ 를 내 할 일에 넣었습니다');
    const golden = `- [ ] 자재 단가 회신 #내할일 [pri:: 2] [mail:: ${DR_KEY}] [thread:: 자재 단가 문의 드립니다] [opened:: 2026-09-21]`;
    const todoAfter = lf(sandbox!.read(TODO));
    expect(todoAfter.replace(`${golden}\n`, ''), '줄 하나만 더해졌다').toBe(todoBefore);
    const section = todoAfter.split('\n## ').find((s) => s.startsWith('메일 회신 대기'))!;
    expect(section.trimEnd().split('\n').at(-1), '「메일 회신 대기」 절 끝').toBe(golden);
    await expect(rowWith(full, '자재 단가 문의').getByTestId('mail-chip-task')).toBeVisible({ timeout: 10_000 });
    await expect(full.getByTestId('btn-mail-task')).toHaveAttribute('data-blocked-reason', /이미 할 일이 있습니다/);
    await expect(full.getByTestId('btn-mail-task')).toBeDisabled();
    // 할 일 목록에 나타난다
    await full.getByTestId('btn-mail-task-show').click();
    await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'tasks');
    // (기한 없는 새 줄은 접힌 「기타」 구간에 들어간다 — 스냅샷으로 본다)
    await expect
      .poll(async () => (await full.evaluate(() => window.radar.getSnapshot())).tasks.filter((t) => t.title === '자재 단가 회신').length, {
        timeout: 10_000,
      })
      .toBe(1);
    // main 도 다시 넣지 않는다
    await expect(full.evaluate((p) => window.radar.createMailTask!({ path: p, title: '또' }), DR)).rejects.toThrow('이미 할 일이 있습니다');
  });
});

test('(g) VOC 등록: 할 일 없는 메일은 메일만으로(위키 그대로) · 할 일과 연결된 메일은 기존 V3b(할 일 줄에 [voc::])', async () => {
  test.setTimeout(150_000);
  const { full } = await start({ voc: true });
  const wikiBefore = treeDigest(sandbox!.wiki);

  await test.step('대륙물산(할 일 없음) → mail-voc-view → 확인 → ticket create … --source email → 「VOC-…」 배지', async () => {
    await pick(full, '자재 단가 문의');
    await full.getByTestId('btn-mail-voc').click();
    const view = full.getByTestId('mail-voc-view');
    await expect(view).toBeVisible();
    await expect(view).toContainText('위키에는 쓰지 않습니다', { timeout: 15_000 });
    const panel = view.getByTestId('voc-create-panel');
    await expect(panel.getByTestId('voc-create-title')).toHaveValue('자재 단가 문의 드립니다', { timeout: 15_000 });
    for (const id of ['voc-create-customer', 'voc-create-system']) {
      const sel = panel.getByTestId(id);
      if (!(await sel.inputValue())) {
        const first = await sel.evaluate((el) => [...(el as HTMLSelectElement).options].find((o) => o.value !== '' && !o.disabled)?.value ?? '');
        await sel.selectOption(first);
      }
    }
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'mailbox-voc.png') });
    await panel.getByTestId('btn-voc-create-submit').click();
    const dialog = full.getByTestId('voc-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('메일 상태');
    expect(vocCalls(app!, 'ticket create'), '확인 전에는 만들지 않는다').toEqual([]);
    await dialog.getByTestId('btn-voc-confirm').click();
    await expect(view.getByTestId('mail-voc-done')).toContainText(CREATED_PREFIX, { timeout: 30_000 });
    const creates = vocCalls(app!, 'ticket create');
    expect(creates).toHaveLength(1);
    expect(creates[0].join(' ')).toMatch(/--source email/);
    expect(treeDigest(sandbox!.wiki), '메일만 등록은 위키에 쓰지 않는다').toEqual(wikiBefore);
    await view.getByTestId('btn-mail-back').click();
    await expect(full.getByTestId('btn-mail-voc')).toHaveAttribute('data-done', new RegExp(CREATED_PREFIX));
    await expect(rowWith(full, '자재 단가 문의').getByTestId('mail-chip-voc')).toBeVisible();
    // main 도 두 번 등록하지 않는다
    const again = await full.evaluate((p) => window.radar.getMailVocCreateContext!(p), DR);
    expect(again?.existing).toMatch(new RegExp(CREATED_PREFIX));
  });

  await test.step('한결케미칼 9/15 메일(할 일 하나와 연결) → 기존 V3b → 할 일 줄 끝에 [voc:: …]', async () => {
    await pick(full, '통영공장 CMS 인벤토리');
    await full.getByTestId('mail-thread-item').filter({ hasText: '9월 15일' }).click();
    await expect(full.getByTestId('mail-reader')).toHaveAttribute('data-mail-key', /^[mup]:/);
    await full.getByTestId('btn-mail-voc').click();
    const view = full.getByTestId('mail-voc-view');
    await expect(view).toContainText('할 일 줄 끝에', { timeout: 15_000 });
    const panel = view.getByTestId('voc-create-panel');
    const desc = panel.getByTestId('voc-create-desc');
    await expect(desc).not.toHaveValue('', { timeout: 15_000 });
    // 원본 본문의 — 는 CP949 밖이다(2.6 시험과 같다)
    await desc.fill((await desc.inputValue()).replace(/[—–]/g, '-'));
    for (const id of ['voc-create-customer', 'voc-create-system']) {
      const sel = panel.getByTestId(id);
      if (!(await sel.inputValue())) {
        const first = await sel.evaluate((el) => [...(el as HTMLSelectElement).options].find((o) => o.value !== '' && !o.disabled)?.value ?? '');
        await sel.selectOption(first);
      }
    }
    await expect(panel.getByTestId('btn-voc-create-submit')).toBeEnabled();
    await panel.getByTestId('btn-voc-create-submit').click();
    await full.getByTestId('voc-confirm').getByTestId('btn-voc-confirm').click();
    await expect(view.getByTestId('mail-voc-done')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => lf(sandbox!.read(TODO)).split('\n').find((l) => l.includes(`[mail:: ${HG_EXISTING}]`)) ?? '')
      .toMatch(/\[voc:: VOC-2026-\d+\]/);
    expect(vocCalls(app!, 'ticket create')).toHaveLength(2);
  });
});

test('(j) 쓸 수 없음: raw/mail 없음 → 「메일 없음」·이유·사이드바 블록 없음 / 개인 위키 없음 → 역시 「메일 없음」(2.15 메일은 위키 밖)', async () => {
  test.setTimeout(120_000);
  sandbox = createWikiSandbox('wiki-radar-e2e-mailbox-');
  fs.rmSync(sandbox.file('raw/mail'), { recursive: true, force: true });
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('noMailDir');
  await expect(sidebar.getByTestId('sidebar-mail')).toHaveCount(0);
  await sidebar.evaluate(() => window.radar.setMode('full', 'view:mail'));
  await waitForMode(app, 'full');
  const full = await windowByMode(app, 'full');
  const nav = full.getByTestId('nav-mail');
  await expect(nav).toHaveAttribute('data-unavailable', 'true');
  await expect(nav).toHaveAttribute('aria-description', /아직 받은 메일이 없습니다/);
  await expect(full.getByTestId('nav-mail-note')).toHaveText('메일 없음');
  await expect(full.getByTestId('mailbox-view')).toHaveAttribute('data-state', 'noMailDir');
  await expect(full.getByTestId('mailbox-unavailable')).toContainText('아직 받은 메일이 없습니다');
  await closeApp(app);

  const missing = path.join(sandbox.root, 'none', 'WIKI');
  app = await launchApp({ wiki: missing, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const full2 = await windowByMode(app, 'full').catch(async () => {
    const sb = await windowByMode(app!, 'sidebar');
    await sb.evaluate(() => window.radar.setMode('full', 'view:mail'));
    return windowByMode(app!, 'full');
  });
  // 2.15: 메일은 위키 밖(앱 데이터 메일 보관소)이라 개인 위키가 없어도 메일함은 「위키 없음」이 아니라 「메일 없음」(아직 받은 메일 없음)
  await expect(full2.getByTestId('nav-mail-note')).toHaveText('메일 없음', { timeout: 20_000 });
  await expect(full2.getByTestId('nav-mail')).toHaveAttribute('data-unavailable', 'true');
  await full2.getByTestId('nav-mail').click();
  await expect(full2.getByTestId('mailbox-unavailable')).toContainText('아직 받은 메일이 없습니다');
});

test('(l) [더 보기]: 200줄씩 받기 · 더 받은 뒤 새 메일이 와도 받은 줄이 그대로 · 바깥에서 200줄 밖 메일 열기', async () => {
  test.setTimeout(150_000);
  sandbox = createWikiSandbox('wiki-radar-e2e-mailbox-');
  // 가상 업체 메일 205통(서로 다른 제목 — 스레드 205개). 9/1~9/10 이라 기준선(9/20) 이전 → 미확인 아님
  const bulk = (i: number) => {
    const day = String((i % 10) + 1).padStart(2, '0');
    const min = String(i % 60).padStart(2, '0');
    const hex = (0xa00000 + i).toString(16);
    return {
      rel: `raw/mail/가상대량/2026/2026-09-${day}_10${min}_대량담당_대량 문의 ${i}_${hex}.md`,
      text: sandbox!
        .read(DR)
        .replace('dr-1@daeryuk.example', `bulk-${i}@bulk.example`)
        .replace('uidl-dr-1', `uidl-bulk-${i}`)
        .replace(/자재 단가 문의 드립니다/g, `대량 문의 ${i}번 건`)
        .replace(/folder: .*/, 'folder: 가상대량')
        .replace('2026-09-21T11:00:40+09:00', `2026-09-${day}T10:${min}:00+09:00`),
    };
  };
  fs.mkdirSync(sandbox.file('raw/mail/가상대량/2026'), { recursive: true });
  for (let i = 0; i < 205; i++) {
    const m = bulk(i);
    fs.writeFileSync(sandbox.file(m.rel), m.text, 'utf8');
  }
  rawCheck = { before: rawDigest(), ignore: new Set() };
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 30_000 }).toBe('ready');
  const full = await openMailbox(sidebar);
  const rows = full.getByTestId('mail-thread-row');
  const total = FIXTURE_THREADS + 205;
  await expect(full.getByTestId('mail-filter-all')).toHaveAttribute('data-count', String(total));
  await expect(rows).toHaveCount(200);
  const more = full.getByTestId('btn-mail-more');
  await expect(more).toContainText(`${total - 200}개 더`);
  await more.click();
  await expect(rows).toHaveCount(total);
  await expect(more).toHaveCount(0);

  // 더 받은 뒤 새 메일 → 받은 만큼(+1) 그대로
  addMail(
    'raw/mail/대륙물산/2026/2026-09-23_0930_박담당_추가 견적 요청_d4d5d6.md',
    sandbox
      .read(DR)
      .replace('dr-1@daeryuk.example', 'dr-2@daeryuk.example')
      .replace('uidl-dr-1', 'uidl-dr-2')
      .replace(/자재 단가 문의 드립니다/g, '추가 견적 요청드립니다')
      .replace('2026-09-21T11:00:40+09:00', '2026-09-23T09:30:00+09:00'),
  );
  await expect(rowWith(full, '추가 견적 요청드립니다')).toHaveCount(1, { timeout: 5_000 });
  await expect(rows).toHaveCount(total + 1);

  // 다시 띄운 것처럼 처음 200줄만 받은 상태에서(필터 바꿨다 돌아오기) 200줄 밖(가장 오래된) 메일을 바깥에서 연다
  await full.getByTestId('mail-filter-archived').click();
  await full.getByTestId('mail-filter-all').click();
  await expect(rows).toHaveCount(200);
  // 9/1 10:00 — 목록 맨 끝 쪽(200줄 밖)
  const key = await full.evaluate(() =>
    window.radar.listMailThreads!({ filter: 'all', query: '대량 문의 0번 건', offset: 0, limit: 5 }).then((p) => p.threads[0].latestKey),
  );
  await sidebar.evaluate((k) => window.radar.setMode('full', `view:mail:${k}`), key);
  const picked = full.locator('[data-testid="mail-thread-row"][aria-current="true"]');
  await expect(picked).toHaveCount(1, { timeout: 10_000 });
  await expect(picked).toContainText('대량 문의 0번 건');
  await expect(full.getByTestId('mail-reader').locator('h1')).toContainText('대량 문의 0번 건');
});
