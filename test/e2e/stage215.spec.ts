// 2.15단계 메일을 위키 밖으로 — 수집(가짜 POP3) → 앱 데이터 메일 보관소에 새 메일 → 메일함 → [할 일로] 메일 ID · 위키 raw/mail 은 읽지 않음
// (docs/stage2.15-contract.md §D). 가짜 POP3 는 127.0.0.1. 실제 위키·메일 서버는 부르지 않는다. 먼저 `npm run package`.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { MailCollectStatus } from '../../src/shared/types';
import {
  FAKE_SMTP_USER,
  FIXTURE_WIKI,
  PROJECT_ROOT,
  RESULTS_DIR,
  closeApp,
  createWikiSandbox,
  launchApp,
  treeDigest,
  watchLogs,
  windowByMode,
  type AppLogs,
  type WikiSandbox,
} from './app';

const NOW = '2026-10-19T10:00';
const POP3_PASS = 'pop3-e2e-215-secret';
const FIXTURE_MAILS = 12;
const FIXTURES = path.join(PROJECT_ROOT, 'test', 'fixtures');
const imp = <T>(name: string): Promise<T> => import(pathToFileURL(path.join(FIXTURES, name)).href) as Promise<T>;

interface FakePop3 {
  port: number;
  commands: string[];
  mails: { uid: string; raw: string }[];
  close(): Promise<void>;
}

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
let sandbox: WikiSandbox | null = null;
const closers: (() => Promise<unknown>)[] = [];
let fixtureBefore: Record<string, string> | undefined;

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
  while (closers.length) await (closers.pop() as () => Promise<unknown>)().catch(() => undefined);
  sandbox?.dispose();
  sandbox = null;
});

function rawMail(n: number, subject: string): string {
  return [
    'From: 박담당 <park@daeryuk.example>',
    `To: ${FAKE_SMTP_USER}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: Mon, 19 Oct 2026 0${n}:00:00 +0900`,
    `Message-ID: <e2e-215-${n}@daeryuk.example>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `새 메일 본문 ${n}`,
    '',
  ].join('\r\n');
}

async function fakePop3(): Promise<FakePop3> {
  const { startFakePop3 } = await imp<{ startFakePop3(o: unknown): Promise<FakePop3> }>('fake-pop3-server.mjs');
  const s = await startFakePop3({
    user: FAKE_SMTP_USER,
    pass: POP3_PASS,
    mails: [
      { uid: 'e2e-1', raw: rawMail(8, '[견적] 10월 자재 단가 문의') },
      { uid: 'e2e-2', raw: rawMail(9, '납기 일정 확인 부탁드립니다') },
    ],
  });
  closers.push(() => s.close());
  return s;
}

test('수집 → 보관소에 새 메일 → 메일함 → [할 일로] 메일 ID · 위키 raw/mail 은 읽지 않음 · DELE 없음', async () => {
  const pop = await fakePop3();
  sandbox = createWikiSandbox('wiki-radar-e2e-215-');
  // 위키 쪽 수집기 흔적(읽기만) — 분류 규칙 하나
  fs.mkdirSync(path.join(sandbox.wiki, '_mail-ingest'), { recursive: true });
  fs.writeFileSync(path.join(sandbox.wiki, '_mail-ingest', 'rules.txt'), 'from@ | daeryuk.example | 대륙물산\n');
  // 위키에 raw/mail 이 남아 있어도 Radar 는 읽지 않는다
  const stray = path.join(sandbox.wiki, 'raw', 'mail', '대륙물산', '2026');
  fs.mkdirSync(stray, { recursive: true });
  fs.copyFileSync(sandbox.file('raw/mail/대륙물산/2026/2026-09-21_1100_박담당_자재 단가 문의_d1d2d3.md'), path.join(stray, '2026-09-30_0900_박담당_위키에 남은 메일_aaaaaa.md'));
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const page: Page = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await page.evaluate(() => window.radar.getMailbox!())).total, { timeout: 20_000 }).toBe(FIXTURE_MAILS);

  const before: MailCollectStatus = await page.evaluate(() => window.radar.getMailCollect!());
  expect(before.state).toBe('noAccount');
  expect(before.store.newMail).toBe(path.join(sandbox.data, 'mail-store'));

  await test.step('계정 저장 → [지금 받기]: 새 메일 2통이 보관소에', async () => {
    const saved = await page.evaluate(
      ({ port, user, pass }) => window.radar.saveSettings!('mailIn', { host: '127.0.0.1', port, ssl: false, user, secret: { key: 'mailIn.pass', action: 'set', value: pass } } as never),
      { port: pop.port, user: FAKE_SMTP_USER, pass: POP3_PASS },
    );
    expect(saved.view.secrets['mailIn.pass']).toMatchObject({ saved: true });
    const st: MailCollectStatus = await page.evaluate(() => window.radar.collectMailNow!());
    expect(st.state).toBe('idle');
    expect(st.lastCount).toBe(2);
    expect(fs.readdirSync(sandbox!.file('raw/mail/대륙물산/2026')).filter((f) => f.startsWith('2026-10-19_'))).toHaveLength(2);
    expect(pop.commands.filter((c) => c.startsWith('RETR'))).toEqual(['RETR 1', 'RETR 2']);
    expect(pop.commands.some((c) => /^(DELE|RSET)/.test(c))).toBe(false);
  });

  let newPath = '';
  await test.step('메일함: 보관소의 옛 메일 + 새 메일(위키에 남은 메일은 안 보임), 새 메일 읽기', async () => {
    await expect
      .poll(async () => (await page.evaluate(() => window.radar.refreshMailbox!())).total, { timeout: 20_000 })
      .toBe(FIXTURE_MAILS + 2);
    const stray = await page.evaluate(() => window.radar.listMailThreads!({ filter: 'all', query: '위키에 남은', offset: 0, limit: 50 }));
    expect(stray.total).toBe(0);
    const list = await page.evaluate(() => window.radar.listMailThreads!({ filter: 'all', query: '자재 단가', offset: 0, limit: 50 }));
    const th = list.threads.find((t) => t.subject.includes('10월 자재 단가'))!;
    expect(th).toBeTruthy();
    const detail = await page.evaluate((id) => window.radar.getMailThread!(id), th.id);
    newPath = detail!.mails[detail!.mails.length - 1].path;
    expect(newPath).toMatch(/^raw\/mail\/대륙물산\/2026\/2026-10-19_0800_박담당_\[견적\] 10월 자재 단가 문의_[0-9a-f]{6}\.md$/);
    const msg = await page.evaluate((p) => window.radar.getMailMessage!(p), newPath);
    expect(msg?.body).toBe('새 메일 본문 8');
  });

  await test.step('[할 일로]: 줄에 [mail:: m:…] (파일 이름의 대괄호와 무관)', async () => {
    const out = await page.evaluate((p) => window.radar.createMailTask!({ path: p, title: '10월 단가 회신', pri: 2 }), newPath);
    expect(out.file).toBe('_private/mgmt/내 할 일.md');
    const text = sandbox!.read('_private/mgmt/내 할 일.md');
    expect(text).toMatch(/- \[ \] 10월 단가 회신 #내할일 \[pri:: 2\] \[mail:: m:[0-9a-f]{16}\] \[thread:: [^\]]+\] \[opened:: 2026-10-19\]/);
    await expect(page.evaluate((p) => window.radar.createMailTask!({ path: p, title: '또' }), newPath)).rejects.toThrow('이미 할 일이 있습니다');
  });

  await test.step('설정 › 메일 받기 칸: 상태 칩·보관소 줄, 옮기기 단추 없음', async () => {
    await page.evaluate(() => window.radar.setMode('full', 'view:settings:mailIn'));
    const full = await windowByMode(app!, 'full');
    await expect(full.getByTestId('settings-view')).toHaveAttribute('data-tab', 'mailIn', { timeout: 15_000 });
    await expect(full.getByTestId('sv-mailin-collect')).toContainText('마지막 받음');
    await expect(full.getByTestId('sv-mailin-store')).toContainText('메일 보관소');
    await expect(full.getByTestId('sv-mailin-archive')).toHaveCount(0);
  });
});

test('원본 보기: HTML 메일 — 본문 속 그림(cid)은 보이고 외부 그림은 막고, 스크립트는 없다', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const raw = [
    'From: 박담당 <park@daeryuk.example>',
    `To: ${FAKE_SMTP_USER}`,
    `Subject: =?UTF-8?B?${Buffer.from('이미지 테스트 메일').toString('base64')}?=`,
    'Date: Mon, 19 Oct 2026 09:30:00 +0900',
    'Message-ID: <e2e-html-1@daeryuk.example>',
    'Content-Type: multipart/related; boundary="REL"',
    '',
    '--REL',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>이미지 테스트</p><p>감사합니다</p><img id="logo" src="cid:logo@x"><img id="track" src="https://track.example/p.gif"><script>document.title="x"</script>',
    '--REL',
    'Content-Type: image/png',
    'Content-ID: <logo@x>',
    'Content-Transfer-Encoding: base64',
    '',
    png.toString('base64'),
    '--REL--',
    '',
  ].join('\r\n');
  const { startFakePop3 } = await imp<{ startFakePop3(o: unknown): Promise<FakePop3> }>('fake-pop3-server.mjs');
  const pop = await startFakePop3({ user: FAKE_SMTP_USER, pass: POP3_PASS, mails: [{ uid: 'html-1', raw }] });
  closers.push(() => pop.close());
  sandbox = createWikiSandbox('wiki-radar-e2e-215h-');
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW });
  logs = watchLogs(app);
  const page: Page = await windowByMode(app, 'sidebar');
  await page.evaluate(
    ({ port, user, pass }) => window.radar.saveSettings!('mailIn', { host: '127.0.0.1', port, ssl: false, user, secret: { key: 'mailIn.pass', action: 'set', value: pass } } as never),
    { port: pop.port, user: FAKE_SMTP_USER, pass: POP3_PASS },
  );
  expect((await page.evaluate(() => window.radar.collectMailNow!())).lastCount).toBe(1);
  await expect.poll(async () => (await page.evaluate(() => window.radar.refreshMailbox!())).total, { timeout: 20_000 }).toBe(FIXTURE_MAILS + 1);
  const list = await page.evaluate(() => window.radar.listMailThreads!({ filter: 'all', query: '이미지 테스트 메일', offset: 0, limit: 10 }));
  const detail = await page.evaluate((id) => window.radar.getMailThread!(id), list.threads[0].id);
  const m = detail!.mails[0];
  // 원본 .eml 이 보관소에 남는다
  expect(fs.readdirSync(path.join(sandbox.data, 'mail-store', 'raw', 'mail', '_original')).filter((f) => f.endsWith('.eml'))).toHaveLength(1);
  expect((await page.evaluate((p) => window.radar.getMailMessage!(p), m.path))?.hasOriginal).toBe(true);

  await page.evaluate((k) => window.radar.setMode('full', `view:mail:${k}`), m.key);
  const full = await windowByMode(app, 'full');
  const frame = full.getByTestId('mail-html-frame');
  await expect(frame).toBeVisible({ timeout: 15_000 });
  await expect(full.getByTestId('mail-html-blocked')).toContainText('외부 그림 1개');
  const inner = full.frameLocator('[data-testid="mail-html-frame"]');
  await expect(inner.locator('p').first()).toHaveText('이미지 테스트');
  await expect(inner.locator('#logo')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(inner.locator('#track')).toHaveAttribute('src', '');
  await expect(inner.locator('script')).toHaveCount(0);
  // 그림이 실제로 그려졌다(크기 1×1)
  expect(await inner.locator('#logo').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage215-mail-html.png') });
  // [글] 로 바꾸면 글 본문(HTML 에서 뽑은 글 — 줄바꿈 살림)
  await full.getByTestId('mail-view-text').click();
  await expect(full.getByTestId('mail-body')).toHaveText(/이미지 테스트\s+감사합니다/);
});
