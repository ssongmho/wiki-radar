// 2.5단계 e2e: 메일 회신 — 초안 → 검토 → 발송 → 할 일 저장(docs/stage2.5-contract.md §6·§7).
// 테스트 사본(test/fixtures/wiki)의 임시 복사본 + 가짜 claude(초안 모드) + 로컬 가짜 SMTP 서버(app.ts startFakeSmtp)만 쓴다.
// 실제 메일 서버·실제 claude 는 부르지 않는다(하네스가 WIKI_RADAR_TEST_MODE=1 을 넣어 main 도 루프백 밖 연결을 막는다).
//   (a) 한결케미칼 메일 할 일 → 회신 켜기 → 받는사람·제목·전체 회신 → 보내는 사람·서명 → 초안(confirm) → [확인 필요] 거부(화면·main)
//       → 본문 고침 → 완료 → [보내고 저장] → 확인 → 가짜 서버가 받은 메시지(받는사람·In-Reply-To·제목·본문·숨은참조 봉투)
//       → 목록에서 빠짐 · 위키 사본의 줄 [x] · 메모에 발송 줄 · 발송 기록(sent-mail.json·.eml) → 같은 작성 칸 재발송 거부
//   (b) 계정 없음 → 회신 칸 data-ready=false, [보내고 저장] 막힘(화면·main). 초안(ok)은 되고 어떤 파일도 쓰지 않는다
//   (c) 서버가 받는 사람을 550 으로 거부 → error 알림, 입력 그대로, 위키·발송 기록 그대로. reply_to·피싱 의심 표시도 본다
//   (d) 진행 중으로 보내고 저장 실패(읽기 전용) → 같은 상세에서 회신 칸 닫힘·지난 발송 배지·발송 줄 → 다시 [저장](메모·대기열 reply)
//       → 다시 켜서 새 sendId 로 한 통 더. 확인 대화상자 안의 위/아래 키가 목록 선택을 바꾸지 않는지도 본다
//   (e) 초안 중 [취소]: 본문이 비면 초점은 상태 라디오, 본문이 있으면 되돌리기 확인과 초안 교체 확인이 겹치지 않는다
// 테스트마다 앱과 가짜 서버를 새로 띄우고 닫는다. 원본 테스트 사본은 바이트 단위로 그대로여야 한다. 먼저 `npm run package`.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { MailSettings, QueueItem, SendReplyInput, SentMailRecord, Task } from '../../src/shared/types';
import {
  FAKE_SMTP_USER,
  FIXTURE_WIKI,
  RESULTS_DIR,
  checkboxTaskId,
  closeApp,
  createWikiSandbox,
  launchSandboxApp,
  settle,
  startFakeSmtp,
  treeDigest,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
  type FakeSmtp,
  type WikiSandbox,
} from './app';

const TODAY = '2026-09-23';
const TODO = '_private/mgmt/내 할 일.md';
const MEMO = '_private/mgmt/할 일 메모.md';
/** 한결케미칼 원본 메일(테스트 사본에 있는 유일한 메일 파일) */
const MAIL_REL = 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md';
const ORIGINAL_SUBJECT = 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청';
/** 접두(RE:)를 걷고 'RE: ' 를 한 번 붙인 제목(명세 §1) */
const SUBJECT = 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청';
const FROM_NAME = '한결케미칼 EHS팀';
const FROM_ADDR = 'ehs@hangyeol.example';
/** 원본 to — [전체 회신]이 참조에 채운다(나 = FAKE_SMTP_USER 는 원본에 없다) */
const ORIGINAL_TO = 'owner@example.com';
const MESSAGE_ID = '<fixture-0001@hangyeol.example>';
/** 원본 본문의 한 줄(인용문에 들어간다) */
const ORIGINAL_BODY_LINE = '8월 사용량이 CMS 실적 화면에 반영되지 않고 있습니다. 월말 보고 전에 확인 부탁드립니다.';

const NOTE = '9/22 집계 배치 재실행으로 8월분 사용량 반영을 확인함';
/** 초안의 [확인 필요: …] 자리를 채울 말 */
const FILLED = '10월 2일(금)';
const SENDER_NAME = '레이더 시험';
const SIGNATURE = '송레이더 드림\n레이더팀 070-0000-0000';

/** 발송 줄(명세 §4-2 ⑦)의 정규식 조각 — 받는사람은 이름(없으면 주소), 참조가 없으니 '참조 N명'도 없다 */
const SENT_LINE = `메일 회신 발송 — 받는사람: (${esc(FROM_NAME)}|${esc(FROM_ADDR)}) · 제목: ${esc(SUBJECT)}`;

// ---- 도우미 ------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const readFixture = (rel: string) => lf(fs.readFileSync(path.join(FIXTURE_WIKI, ...rel.split('/')), 'utf8'));

/** 테스트 사본 내 할 일.md 에서 이 메일을 가리키는 체크박스 줄(큐레이션 앵커가 잡는 줄) */
function mailLine(todo: string): string {
  const hits = todo.split('\n').filter((l) => l.startsWith('- [ ] ') && l.includes(`[mail:: ${MAIL_REL}]`));
  if (hits.length !== 1) throw new Error(`시험 준비 오류: 메일 줄이 한 번만 있어야 한다(${hits.length})`);
  return hits[0];
}
/** apply_status(done): 맨 앞을 [x] 로, 끝에 [done:: 오늘] (원래 줄에는 done·wip·owner 필드가 없다) */
const doneLine = (line: string) => `${line.replace(/^- \[ \]/, '- [x]')} [done:: ${TODAY}]`;

const rowById = (page: Page, id: string) => page.locator(`[data-testid="task-row"][data-task-id="${id}"]`);

/** 스냅샷에서 이 메일이 달린 할 일(하나여야 한다) */
async function mailTask(page: Page): Promise<Task> {
  let tasks: Task[] = [];
  await expect
    .poll(
      async () => {
        const snap = await page.evaluate(() => window.radar.getSnapshot());
        tasks = snap.tasks.filter((t) => (t.mail ?? '').replace(/\\/g, '/') === MAIL_REL);
        return tasks.length;
      },
      { message: `스냅샷에 ${MAIL_REL} 메일 할 일이 하나 있어야 한다` },
    )
    .toBe(1);
  return tasks[0];
}

/** 풀스크린 목록에서 항목을 골라 상세(처리 결과 입력 포함)가 그 항목으로 바뀔 때까지. 상세를 돌려준다 */
async function openInFull(full: Page, id: string): Promise<Locator> {
  const row = rowById(full, id);
  await expect(row, `풀스크린 목록에 ${id} 가 있어야 한다`).toHaveCount(1);
  await row.click();
  const detail = full.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-task-id', id);
  await expect(detail.getByTestId('btn-save'), '상세에 처리 결과 입력이 있어야 한다').toBeVisible();
  return detail;
}

/** 회신 메일 보내기를 켜고 작성 칸을 돌려준다 */
async function openReply(detail: Locator): Promise<Locator> {
  const toggle = detail.getByTestId('reply-toggle');
  await expect(toggle, '메일 할 일에는 "회신 메일 보내기"가 있다').toHaveCount(1);
  await expect(toggle, '기본은 꺼짐').not.toBeChecked();
  await expect(detail.getByTestId('reply-panel')).toHaveCount(0);
  await toggle.check();
  const panel = detail.getByTestId('reply-panel');
  await expect(panel).toBeVisible();
  // 켜면 폼의 제출 버튼이 [보내고 저장]으로 바뀐다
  await expect(detail.getByTestId('btn-send')).toBeVisible();
  await expect(detail.getByTestId('btn-save')).toHaveCount(0);
  return panel;
}

/** 접이식 "보내는 사람·서명"을 편다(이미 펴져 있으면 그대로) */
async function openMailSettings(panel: Locator): Promise<void> {
  const name = panel.getByTestId('mail-settings-name');
  if (await name.isVisible()) return;
  const box = panel.getByTestId('mail-settings');
  const summary = box.locator('summary');
  const button = box.getByRole('button', { name: /보내는 사람/ });
  if (await summary.count()) await summary.first().click();
  else if (await button.count()) await button.first().click();
  else await box.click();
  await expect(name, '"보내는 사람·서명"을 펴면 이름 칸이 보인다').toBeVisible();
}

async function noticeText(full: Page): Promise<string | null> {
  const notice = full.getByTestId('save-notice');
  return (await notice.count()) === 0 ? null : ((await notice.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
/** 알림이 새로 뜰 때까지(앞 알림 글자와 다른 글자) 기다려 글자를 돌려준다 */
async function waitNewNotice(full: Page, before: string | null): Promise<string> {
  await expect
    .poll(async () => {
      const now = await noticeText(full);
      return now !== null && now !== '' && now !== before;
    }, { message: '결과 알림이 새로 떠야 한다', timeout: 30_000 })
    .toBe(true);
  return (await noticeText(full)) ?? '';
}

/** 초안을 만들고 끝날 때까지. 끝난 상태(done|failed)를 돌려준다 */
async function makeDraft(panel: Locator): Promise<string | null> {
  await panel.getByTestId('btn-draft').click();
  const status = panel.getByTestId('draft-status');
  await expect(status).toHaveAttribute('data-state', /^(done|failed)$/, { timeout: 30_000 });
  return status.getAttribute('data-state');
}

/** [보내고 저장] → 확인 대화상자(처음 초점은 [취소]). 대화상자를 돌려준다 */
async function openSendConfirm(full: Page, detail: Locator): Promise<Locator> {
  const send = detail.getByTestId('btn-send');
  await expect(send).toBeEnabled();
  await send.click();
  const dialog = full.getByTestId('reply-confirm');
  await expect(dialog, '확인 대화상자가 떠야 한다').toBeVisible();
  await expect
    .poll(
      () =>
        full.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el && el.closest('[data-testid="reply-confirm"]') ? (el.textContent ?? '').trim() : null;
        }),
      { message: '확인 대화상자의 처음 초점은 [취소]' },
    )
    .toBe('취소');
  return dialog;
}

/** 화면을 거치지 않고 main 에 바로 보낸다(화면의 검사를 건너뛰어도 main 이 막는지). 거부되면 그 문장, 보내졌으면 null */
async function sendDirect(page: Page, input: SendReplyInput): Promise<string | null> {
  return page.evaluate(async (arg) => {
    try {
      await window.radar.sendReply(arg);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, input);
}

function sentOnDisk(sb: WikiSandbox): SentMailRecord[] | undefined {
  const raw = sb.readData<SentMailRecord[] | { items?: SentMailRecord[] }>('sent-mail.json');
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}
function emlFiles(sb: WikiSandbox): string[] {
  const dir = path.join(sb.data, 'sent');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.eml')).sort() : [];
}

async function attachLogs(logs: AppLogs | undefined, smtp: FakeSmtp | undefined, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  if (logs) {
    await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
    await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (smtp) {
    const body = JSON.stringify({ auths: smtp.auths, messages: smtp.messages.map((m) => ({ envelope: m.envelope, raw: m.raw })) }, null, 2);
    await testInfo.attach('fake-smtp.json', { body, contentType: 'application/json' });
  }
}

// ---- 받은 MIME 읽기(가짜 서버가 받은 raw) ---------------------------------------------

interface ParsedMail {
  /** 머리말(이름 소문자) → 값들(접기 풀림, 인코딩 그대로) */
  headers: Map<string, string[]>;
  /** 머리말 하나(없으면 undefined, RFC 2047 인코딩을 푼 값) */
  header(name: string): string | undefined;
  /** 본문(전송 인코딩을 풀고 UTF-8 로, 줄바꿈 LF) */
  text: string;
}

/** RFC 2047 encoded-word 하나 → 바이트 */
function decodeWord(enc: string, data: string): Buffer {
  if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64');
  return decodeQuotedPrintable(data.replace(/_/g, ' '));
}

/** 머리말 값의 encoded-word 를 푼다. 이어진 낱말 사이 공백은 빼고, 바이트를 모아 한 번에 UTF-8 로(글자가 두 낱말에 걸칠 수 있다) */
function decodeHeader(value: string): string {
  const WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = '';
  let pending: Buffer[] = [];
  let last = 0;
  const flush = () => {
    if (pending.length) out += Buffer.concat(pending).toString('utf8');
    pending = [];
  };
  for (const m of value.matchAll(WORD)) {
    const gap = value.slice(last, m.index);
    if (!(pending.length && /^\s*$/.test(gap))) {
      flush();
      out += gap;
    }
    pending.push(decodeWord(m[2], m[3]));
    last = (m.index ?? 0) + m[0].length;
  }
  flush();
  return out + value.slice(last);
}

function decodeQuotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function parseRaw(raw: string): ParsedMail {
  const sep = raw.indexOf('\r\n\r\n');
  const head = sep < 0 ? raw : raw.slice(0, sep);
  const body = sep < 0 ? '' : raw.slice(sep + 4);
  const headers = new Map<string, string[]>();
  for (const line of head.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), line.slice(i + 1).trim()]);
  }
  const first = (name: string) => headers.get(name.toLowerCase())?.[0];
  const cte = (first('content-transfer-encoding') ?? '7bit').toLowerCase();
  const bytes =
    cte === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : cte === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'utf8');
  return {
    headers,
    header: (name) => {
      const v = first(name);
      return v === undefined ? undefined : decodeHeader(v);
    },
    text: lf(bytes.toString('utf8')),
  };
}

/** '<id>' 와 'id' 를 같게 본다 */
const bareId = (id: string | undefined) => (id ?? '').trim().replace(/^<|>$/g, '');

// ---- 원본 테스트 사본은 그대로 ----------------------------------------------------------

let fixtureBefore: Record<string, string>;
test.beforeAll(() => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
});
test.afterAll(() => {
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
});

// 테스트마다 앱·가짜 서버를 새로 띄우고 afterEach 가 닫는다
let app: ElectronApplication | undefined;
let smtp: FakeSmtp | undefined;
let logs: AppLogs | undefined;

test.afterEach(async ({}, testInfo) => {
  await attachLogs(logs, smtp, testInfo);
  if (app) await closeApp(app);
  if (smtp) await smtp.close();
  app = undefined;
  smtp = undefined;
  logs = undefined;
});

/** 풀스크린을 띄워 두고 창을 돌려준다 */
async function fullWindow(a: ElectronApplication): Promise<Page> {
  const sidebar = await windowByMode(a, 'sidebar');
  const full = await windowByMode(a, 'full');
  await sidebar.evaluate(() => window.radar.setMode('full'));
  await expect.poll(() => windowVisibility(a)).toEqual({ sidebar: false, full: true });
  return full;
}

// ---- (a) 초안 → [확인 필요] 거부 → 고쳐서 보내고 저장 ----------------------------------------

test('(a) 회신 켜기 → 초안(confirm) → [확인 필요] 거부 → 고쳐서 완료로 보내고 저장 → 가짜 서버·위키 사본·발송 기록', async () => {
  test.setTimeout(180_000);
  smtp = await startFakeSmtp();
  let sandbox: WikiSandbox;
  ({ app, sandbox } = await launchSandboxApp({ today: TODAY, draftMode: 'confirm', smtp: { port: smtp.port } }));
  logs = watchLogs(app);
  const full = await fullWindow(app);
  const fakeSmtp = smtp;

  const todoOrig = readFixture(TODO);
  const line = mailLine(todoOrig);
  const task = await mailTask(full);
  expect(task.id.startsWith('i:'), '앵커 있는 큐레이션 항목이 메일 줄을 잡는다').toBe(true);
  // 기한 9/18 이 지났다 — 지남 구간
  await expect(rowById(full, task.id)).toHaveAttribute('data-bucket', 'overdue');

  const detail = await openInFull(full, task.id);
  const panel = await openReply(detail);
  let drafted = '';
  let fixedBody = '';

  await test.step('받는사람·참조·제목은 원본 메일에서, [전체 회신]은 원본 받는사람을 참조에', async () => {
    await expect(panel).toHaveAttribute('data-ready', 'true');
    await expect(panel.getByTestId('reply-sender')).toContainText(FAKE_SMTP_USER);
    const to = panel.getByTestId('reply-to');
    await expect(to).toHaveValue(new RegExp(esc(FROM_ADDR)));
    await expect(to).not.toHaveValue(new RegExp(esc(FAKE_SMTP_USER)));
    await expect(panel.getByTestId('reply-cc')).toHaveValue('');
    await expect(panel.getByTestId('reply-subject')).toHaveValue(SUBJECT);
    await expect(panel.getByTestId('reply-quote'), '원문 인용은 기본 켬').toBeChecked();
    await expect(panel.getByTestId('reply-warning'), '의심 표시 없는 메일').toHaveCount(0);
    await expect(detail.getByTestId('reply-last-sent'), '아직 보낸 적 없다').toHaveCount(0);

    const replyAll = panel.getByTestId('btn-reply-all');
    await replyAll.click();
    await expect(panel.getByTestId('reply-cc')).toHaveValue(new RegExp(esc(ORIGINAL_TO)));
    await expect(panel.getByTestId('reply-cc')).not.toHaveValue(new RegExp(esc(FROM_ADDR)));
    await expect(replyAll).toContainText('참조 비우기');
    await replyAll.click();
    await expect(panel.getByTestId('reply-cc')).toHaveValue('');
  });

  await test.step('보내는 사람·서명을 저장한다(main 이 From 이름과 서명을 붙인다)', async () => {
    await openMailSettings(panel);
    await expect(panel.getByTestId('mail-settings-bcc'), '나에게 숨은참조는 기본 켬').toBeChecked();
    await panel.getByTestId('mail-settings-name').fill(SENDER_NAME);
    await panel.getByTestId('mail-settings-signature').fill(SIGNATURE);
    await panel.getByTestId('btn-mail-settings-save').click();
    await expect
      .poll(() => full.evaluate(() => window.radar.getMailSettings()), { message: '설정이 저장되어야 한다' })
      .toEqual({ fromName: SENDER_NAME, signature: SIGNATURE, bccSelf: true } satisfies MailSettings);
  });

  await test.step('[초안 만들기](가짜 confirm) → 본문에 [확인 필요 → 문제 문장, [보내고 저장] 막힘', async () => {
    await detail.getByTestId('form-note').fill(NOTE);
    const body = panel.getByTestId('reply-body');
    await expect(body, '초안 전 본문은 비어 있다').toHaveValue('');
    const wikiBefore = treeDigest(sandbox.wiki);
    expect(await makeDraft(panel)).toBe('done');
    drafted = await body.inputValue();
    expect(drafted).toContain('[확인 필요');
    // 초안 만들기는 어떤 파일도 쓰지 않고, 보내지도 않는다
    expect(treeDigest(sandbox.wiki)).toEqual(wikiBefore);
    expect(fakeSmtp.messages).toHaveLength(0);

    const problem = panel.getByTestId('reply-problem');
    await expect(problem).toBeVisible();
    await expect(problem).toContainText('[확인 필요');
    await expect(detail.getByTestId('btn-send')).toBeDisabled();
  });

  await test.step('화면을 건너뛰어도 main 이 [확인 필요]를 거부한다(아무것도 보내지 않음)', async () => {
    const rejected = await sendDirect(full, {
      sendId: randomUUID(),
      taskId: task.id,
      to: [`${FROM_NAME} <${FROM_ADDR}>`],
      cc: [],
      subject: SUBJECT,
      body: drafted,
      quoteOriginal: true,
      save: { taskId: task.id, status: 'done', reflect: false },
    });
    expect(rejected, 'main 이 거부해야 한다').not.toBeNull();
    expect(rejected).toContain('[확인 필요');
    expect(fakeSmtp.messages).toHaveLength(0);
    expect(lf(sandbox.read(TODO))).toBe(todoOrig);
    expect(sentOnDisk(sandbox) ?? []).toEqual([]);
  });

  await test.step('본문을 고치면 문제가 사라진다 → 완료 + 위키 지식에도 반영', async () => {
    fixedBody = drafted.replace(/\[확인 필요[^\]]*\]/g, FILLED);
    expect(fixedBody).not.toContain('[확인 필요');
    await panel.getByTestId('reply-body').fill(fixedBody);
    await expect(panel.getByTestId('reply-problem')).toHaveCount(0);
    await detail.getByTestId('form-status-done').check();
    await detail.getByTestId('form-reflect').check();
    await expect(detail.getByTestId('btn-send')).toBeEnabled();
  });

  let noticeAfter = '';
  await test.step('[보내고 저장] → 확인(받는사람·숨은참조·제목·완료) → [보내기]', async () => {
    const before = await noticeText(full);
    const dialog = await openSendConfirm(full, detail);
    await expect(dialog).toContainText(new RegExp(`${esc(FROM_ADDR)}|${esc(FROM_NAME)}`));
    await expect(dialog).toContainText(FAKE_SMTP_USER); // 숨은참조(나)
    await expect(dialog).toContainText(SUBJECT);
    await expect(dialog).toContainText('완료');
    await expect(dialog).not.toContainText('피싱 의심');
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'stage25-confirm.png') });
    await dialog.getByTestId('btn-send-confirm').click();
    await expect(dialog).toHaveCount(0);
    noticeAfter = await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'ok');
    expect(noticeAfter).toContain('회신을 보냈습니다');
  });

  let sent: SentMailRecord;
  await test.step('가짜 서버가 받은 메시지: 봉투(숨은참조)·머리말·본문(서명·인용 순서)', async () => {
    await expect.poll(() => fakeSmtp.messages.length, { message: '가짜 서버가 한 통 받아야 한다' }).toBe(1);
    expect(fakeSmtp.auths.filter((a) => a.ok).map((a) => a.user)).toContain(FAKE_SMTP_USER);
    const msg = fakeSmtp.messages[0];
    expect(msg.user).toBe(FAKE_SMTP_USER);
    expect(msg.envelope.from.toLowerCase()).toBe(FAKE_SMTP_USER);
    // 봉투 = 받는사람 + 나에게 숨은참조
    expect(msg.envelope.to.map((a) => a.toLowerCase()).sort()).toEqual([FROM_ADDR, FAKE_SMTP_USER].sort());

    const mail = parseRaw(msg.raw);
    expect(mail.header('to')).toContain(FROM_ADDR);
    expect(mail.header('to')).not.toContain(FAKE_SMTP_USER);
    expect(mail.headers.has('bcc'), '숨은참조는 머리말에 넣지 않는다').toBe(false);
    expect(mail.headers.has('cc'), '참조를 비웠다').toBe(false);
    expect(mail.header('subject')).toBe(SUBJECT);
    expect(mail.header('in-reply-to')).toBe(MESSAGE_ID);
    expect(mail.header('references')).toBe(MESSAGE_ID);
    const from = mail.header('from') ?? '';
    expect(from).toContain(SENDER_NAME);
    expect(from).toContain(`<${FAKE_SMTP_USER}>`);
    expect(mail.header('message-id')).toMatch(/^<[^<>@\s]+@example\.com>$/);
    expect(mail.header('date') ?? '').not.toBe('');
    expect((mail.header('content-type') ?? '').toLowerCase()).toMatch(/^text\/plain;.*charset="?utf-8"?/);

    // 본문 = 고친 본문 + 서명 + 원문 인용(명세 §2)
    const text = mail.text;
    expect(text.startsWith(`${fixedBody.trimEnd()}\n\n${SIGNATURE}\n\n-----Original Message-----\n`), `본문 조립 순서:\n${text}`).toBe(true);
    expect(text).toContain(`From: ${FROM_NAME} <${FROM_ADDR}>`);
    expect(text).toMatch(/\nSent: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n/);
    expect(text).toContain(`To: ${ORIGINAL_TO}`);
    expect(text).toContain(`Subject: ${ORIGINAL_SUBJECT}`);
    expect(text).toContain(ORIGINAL_BODY_LINE);
    expect(text).toContain(FILLED);
    expect(text).not.toContain('[확인 필요');

    // 발송 기록(sent-mail.json)과 .eml 사본 — 보낸 바이트 그대로(숨은참조 머리말 없음)
    const records = sentOnDisk(sandbox) ?? [];
    expect(records).toHaveLength(1);
    sent = records[0];
    expect(sent).toMatchObject({ taskId: task.id, mail: MAIL_REL, cc: [], subject: SUBJECT });
    expect(sent.to.join(', ')).toContain(FROM_ADDR);
    expect(sent.bcc.map((a) => a.toLowerCase()).join(', ')).toContain(FAKE_SMTP_USER);
    expect(bareId(sent.messageId)).toBe(bareId(mail.header('message-id')));
    expect(sent.eml ?? '').toMatch(/^sent\/\d{8}T\d{6}_[^/]{8}\.eml$/);
    expect((sent.eml ?? '').slice(-12, -4)).toBe(sent.id.slice(0, 8));
    expect(emlFiles(sandbox)).toEqual([path.basename(sent.eml ?? '')]);
    const eml = fs.readFileSync(path.join(sandbox.data, ...(sent.eml ?? '').split('/')));
    const trimEnd = (b: Buffer) => b.toString('latin1').replace(/(\r\n)+$/, '');
    expect(trimEnd(eml), '.eml 은 보낸 MIME 그대로').toBe(trimEnd(msg.bytes));
  });

  await test.step('위키 사본: 할 일 줄 [x]·[done:: 오늘], 메모에 처리 내용 + 발송 줄, 목록에서 빠짐, 회신 칸 닫힘', async () => {
    const todoAfter = lf(sandbox.read(TODO));
    const lines = todoAfter.split('\n');
    expect(lines).toContain(doneLine(line));
    expect(lines).not.toContain(line);
    // 다른 줄은 그대로
    expect(todoAfter).toBe(todoOrig.split(line).join(doneLine(line)));

    const memo = lf(sandbox.read(MEMO));
    const head = `## ${task.title}`;
    const start = memo.indexOf(`\n${head}\n`);
    expect(start, `메모 절 '${head}'`).toBeGreaterThanOrEqual(0);
    const next = memo.indexOf('\n## ', start + head.length + 1);
    const section = memo.slice(start, next < 0 ? undefined : next);
    const entry = section.split('\n');
    const at = entry.indexOf(`- ${TODAY} · ${NOTE}`);
    expect(at, `메모 절에 '- ${TODAY} · 처리 내용' 줄:\n${section}`).toBeGreaterThan(0);
    expect(entry[at + 1], '처리 내용 다음 줄(두 칸 들여쓰기)이 발송 줄').toMatch(new RegExp(`^  ${SENT_LINE}$`));
    expect(noticeAfter).toContain('완료');

    await expect(rowById(full, task.id), '완료한 항목은 목록에서 빠진다').toHaveCount(0);
    await expect(full.getByTestId('reply-panel'), '보낸 뒤 회신 칸은 닫힌다').toHaveCount(0);

    // 반영 대기열 항목에는 보낸 본문(서명·인용 뺀 것)이 reply 로 붙는다
    const queue: QueueItem[] = await full.evaluate(() => window.radar.getQueue());
    const item = queue.find((q) => q.taskId === task.id);
    expect(item, '위키 지식에도 반영 → 대기열 한 건').toBeDefined();
    expect(item?.reply ?? '').toContain(FILLED);
    expect(item?.reply ?? '').not.toContain('-----Original Message-----');
    expect(item?.reply ?? '').not.toContain(SIGNATURE);
    expect(item?.note ?? '').toMatch(new RegExp(`^${esc(NOTE)}
${SENT_LINE}$`));
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'stage25-sent.png') });
  });

  await test.step('같은 작성 칸(sendId)은 다시 보내지 않는다', async () => {
    const again = await sendDirect(full, {
      sendId: sent.id,
      taskId: task.id,
      to: [`${FROM_NAME} <${FROM_ADDR}>`],
      cc: [],
      subject: SUBJECT,
      body: fixedBody,
      quoteOriginal: true,
      save: { taskId: task.id, status: 'done', reflect: false },
    });
    expect(again, '같은 sendId 는 거부').not.toBeNull();
    expect(again).toContain('이미 보낸 메일');
    expect(fakeSmtp.messages).toHaveLength(1);
    expect(sentOnDisk(sandbox) ?? []).toHaveLength(1);
    expect(emlFiles(sandbox)).toHaveLength(1);
  });

  expect(logs.rendererErrors).toEqual([]);
});

// ---- (b) 계정 없음 ---------------------------------------------------------------------

test('(b) 메일 계정이 없으면 회신 칸 data-ready=false · [보내고 저장] 막힘 — 초안(ok)은 되고 파일을 쓰지 않는다', async () => {
  test.setTimeout(120_000);
  let sandbox: WikiSandbox;
  ({ app, sandbox } = await launchSandboxApp({ today: TODAY, draftMode: 'ok', smtp: 'none' }));
  logs = watchLogs(app);
  const full = await fullWindow(app);
  const todoOrig = readFixture(TODO);

  // 메일이 없는 할 일에는 회신 칸이 없다
  const card = await openInFull(full, checkboxTaskId(TODO, '- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]'));
  await expect(card.getByTestId('reply-toggle')).toHaveCount(0);
  await expect(card.getByTestId('btn-save')).toBeVisible();

  const task = await mailTask(full);
  const detail = await openInFull(full, task.id);
  const panel = await openReply(detail);
  await expect(panel).toHaveAttribute('data-ready', 'false');
  await expect(panel.getByTestId('reply-sender')).toContainText('메일 계정이 없습니다');
  // 계정이 없어도 받는사람·제목은 채운다
  await expect(panel.getByTestId('reply-to')).toHaveValue(new RegExp(esc(FROM_ADDR)));
  await expect(panel.getByTestId('reply-subject')).toHaveValue(SUBJECT);

  // 초안은 계정과 관계없이 된다(가짜 ok: 처리 내용을 담은 짧은 회신). 어떤 파일도 쓰지 않는다
  await detail.getByTestId('form-note').fill(NOTE);
  const wikiBefore = treeDigest(sandbox.wiki);
  expect(await makeDraft(panel)).toBe('done');
  const body = await panel.getByTestId('reply-body').inputValue();
  expect(body).toContain(NOTE);
  expect(body).not.toContain('[확인 필요');
  expect(treeDigest(sandbox.wiki)).toEqual(wikiBefore);

  // 상태를 완료로 골라도 [보내고 저장]은 막혀 있다
  await detail.getByTestId('form-status-done').check();
  await expect(detail.getByTestId('btn-send')).toBeDisabled();

  // 화면을 건너뛰어도 main 이 계정 없음으로 거부한다
  const rejected = await sendDirect(full, {
    sendId: randomUUID(),
    taskId: task.id,
    to: [`${FROM_NAME} <${FROM_ADDR}>`],
    cc: [],
    subject: SUBJECT,
    body,
    quoteOriginal: true,
    save: { taskId: task.id, status: 'done', reflect: false },
  });
  expect(rejected, 'main 이 거부해야 한다').not.toBeNull();
  expect(rejected).toContain('메일 계정');
  expect(treeDigest(sandbox.wiki)).toEqual(wikiBefore);
  expect(lf(sandbox.read(TODO))).toBe(todoOrig);
  expect(sentOnDisk(sandbox) ?? []).toEqual([]);
  expect(emlFiles(sandbox)).toEqual([]);
  await expect(rowById(full, task.id)).toHaveCount(1);
  expect(logs.rendererErrors).toEqual([]);
});

// ---- (c) 서버 거부(550) ------------------------------------------------------------------

test('(c) 서버가 550 으로 거부하면 error 알림 · 입력 그대로 · 위키와 발송 기록 그대로 (reply_to·피싱 의심 표시)', async () => {
  test.setTimeout(120_000);
  smtp = await startFakeSmtp({ rejectRcpt: true });
  const fakeSmtp = smtp;
  // 사본의 원본 메일에 reply_to 와 suspicion 을 더한다(수집기 write_message 형식). 원본 테스트 사본은 그대로 둔다
  const sandbox = createWikiSandbox();
  const REPLY_TO = 'reply@hangyeol.example';
  const mailAbs = sandbox.file(MAIL_REL);
  const mailText = fs.readFileSync(mailAbs, 'utf8');
  const eol = mailText.includes('\r\n') ? '\r\n' : '\n';
  const marker = `message_id: "fixture-0001@hangyeol.example"${eol}`;
  expect(mailText.includes(marker), '시험 준비: 원본 메일 frontmatter 의 message_id 줄').toBe(true);
  fs.writeFileSync(
    mailAbs,
    mailText.replace(
      marker,
      `${marker}reply_to: "EHS 회신 창구 <${REPLY_TO}>"${eol}suspicion:${eol}  - "보낸 주소와 회신 주소가 다름"${eol}`,
    ),
    'utf8',
  );
  try {
    // closeApp 이 이 샌드박스까지 지운다
    ({ app } = await launchSandboxApp({ today: TODAY, draftMode: 'ok', smtp: { port: smtp.port }, sandbox }));
  } catch (err) {
    sandbox.dispose();
    throw err;
  }
  logs = watchLogs(app);
  const full = await fullWindow(app);

  const task = await mailTask(full);
  const detail = await openInFull(full, task.id);
  const panel = await openReply(detail);
  await expect(panel).toHaveAttribute('data-ready', 'true');
  // reply_to 가 있으면 받는사람은 그것(명세 §1)
  const to = panel.getByTestId('reply-to');
  await expect(to).toHaveValue(new RegExp(esc(REPLY_TO)));
  await expect(to).not.toHaveValue(new RegExp(esc(FROM_ADDR)));
  // 피싱 의심 경고(발송을 막지는 않는다)
  await expect(detail.getByTestId('reply-warning')).toBeVisible();

  const BODY = '안녕하세요.\n\n8월분 사용량 반영을 확인했습니다.\n\n감사합니다.';
  await detail.getByTestId('form-note').fill(NOTE);
  await panel.getByTestId('reply-body').fill(BODY);
  await detail.getByTestId('form-status-done').check();
  await expect(panel.getByTestId('reply-problem')).toHaveCount(0);

  const wikiBefore = treeDigest(sandbox.wiki);
  const before = await noticeText(full);
  const dialog = await openSendConfirm(full, detail);
  await expect(dialog).toContainText('피싱 의심 메일에 회신합니다');
  await expect(dialog).toContainText(REPLY_TO);
  await dialog.getByTestId('btn-send-confirm').click();
  await expect(dialog).toHaveCount(0);
  const text = await waitNewNotice(full, before);
  await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'error');
  expect(text).toContain('550');

  // 앱은 인증까지 했고, 서버는 받는 사람에서 거부해 메시지를 받지 않았다
  expect(fakeSmtp.auths.some((a) => a.ok)).toBe(true);
  expect(fakeSmtp.messages).toHaveLength(0);
  // 위키·발송 기록 그대로
  expect(treeDigest(sandbox.wiki), '발송 실패면 위키를 쓰지 않는다').toEqual(wikiBefore);
  expect(sentOnDisk(sandbox) ?? []).toEqual([]);
  expect(emlFiles(sandbox)).toEqual([]);
  // 입력 그대로 — 회신 칸은 열려 있고 고친 것이 남는다. 항목도 목록에 남는다
  await expect(detail).toHaveAttribute('data-task-id', task.id);
  await expect(detail.getByTestId('reply-toggle')).toBeChecked();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('reply-body')).toHaveValue(BODY);
  await expect(detail.getByTestId('form-note')).toHaveValue(NOTE);
  await expect(detail.getByTestId('form-status-done')).toBeChecked();
  await expect(rowById(full, task.id)).toHaveCount(1);
  await expect(detail.getByTestId('btn-send'), '다시 보낼 수 있다(사람이 재시도)').toBeEnabled();
  expect(logs.rendererErrors).toEqual([]);
});

// ---- (d) 상태를 두고 보내기 · 저장 실패 뒤 화면 · 다시 저장 · 새 작성 칸으로 한 통 더 ---------------------

/** 지금 초점이 있는 요소의 data-testid(없으면 태그 이름) */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return el.getAttribute('data-testid') ?? el.tagName;
  });
}

/** 열려 있는 <dialog> 수 */
async function openDialogs(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('dialog[open]').length);
}

test('(d) 진행 중으로 보내고 저장 실패(읽기 전용) → 같은 상세에서 회신 칸 닫힘·지난 발송 배지·warn·발송 줄 → 다시 [저장]하면 메모·대기열 reply → 다시 켜서 새 sendId 로 한 통 더', async () => {
  test.setTimeout(180_000);
  smtp = await startFakeSmtp();
  let sandbox: WikiSandbox;
  ({ app, sandbox } = await launchSandboxApp({ today: TODAY, draftMode: 'ok', smtp: { port: smtp.port } }));
  logs = watchLogs(app);
  const full = await fullWindow(app);
  const fakeSmtp = smtp;

  const task = await mailTask(full);
  const detail = await openInFull(full, task.id);
  const panel = await openReply(detail);
  await expect(panel).toHaveAttribute('data-ready', 'true');

  const NOTE_WIP = '집계 배치 재실행을 요청함';
  const BODY1 = '안녕하세요.\n\n8월분 사용량 반영을 요청했습니다. 반영되면 다시 알려드리겠습니다.\n\n감사합니다.';
  await detail.getByTestId('form-note').fill(NOTE_WIP);
  await panel.getByTestId('reply-body').fill(BODY1);
  await detail.getByTestId('form-status-wip').check();
  await detail.getByTestId('form-reflect').check();

  await test.step('확인 대화상자 안의 위/아래 키는 뒤쪽 목록 선택을 바꾸지 않는다(대화상자·초점 그대로)', async () => {
    const dialog = await openSendConfirm(full, detail);
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown']) {
      await full.keyboard.press(key);
      await expect(dialog, `${key} 뒤에도 대화상자가 떠 있다`).toBeVisible();
      await expect(detail).toHaveAttribute('data-task-id', task.id);
    }
    expect(
      await full.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el && el.closest('[data-testid="reply-confirm"]') ? (el.textContent ?? '').trim() : null;
      }),
      '초점은 대화상자의 [취소]에 그대로',
    ).toBe('취소');
    await dialog.getByRole('button', { name: '취소' }).click();
    await expect(dialog).toHaveCount(0);
  });

  const todoBefore = sandbox.read(TODO);
  const memoBefore = sandbox.read(MEMO);
  await test.step('내 할 일.md 가 읽기 전용 → 메일은 나가고 저장만 실패: warn · 회신 칸 닫힘 · 처리 내용 끝에 발송 줄 · 지난 발송 배지', async () => {
    fs.chmodSync(sandbox.file(TODO), 0o444);
    const before = await noticeText(full);
    const dialog = await openSendConfirm(full, detail);
    await dialog.getByTestId('btn-send-confirm').click();
    await expect(dialog).toHaveCount(0);
    const text = await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'warn');
    expect(text).toContain('메일은 보냈습니다');
    await expect.poll(() => fakeSmtp.messages.length, { message: '가짜 서버가 한 통 받아야 한다' }).toBe(1);
    expect(sentOnDisk(sandbox) ?? []).toHaveLength(1);
    // 위키는 그대로(아무것도 쓰지 않았다), 대기열에도 없다(완전 실패)
    expect(sandbox.read(TODO)).toBe(todoBefore);
    expect(sandbox.read(MEMO)).toBe(memoBefore);
    const queue: QueueItem[] = await full.evaluate(() => window.radar.getQueue());
    expect(queue.find((q) => q.taskId === task.id)).toBeUndefined();

    // 같은 항목에 남고(진행 중·저장 실패), 회신 칸은 닫혔다 — 다시 [저장]해도 재발송되지 않는다
    await expect(detail).toHaveAttribute('data-task-id', task.id);
    await expect(rowById(full, task.id)).toHaveCount(1);
    await expect(detail.getByTestId('reply-toggle')).not.toBeChecked();
    await expect(detail.getByTestId('reply-panel')).toHaveCount(0);
    await expect(detail.getByTestId('btn-save')).toBeVisible();
    await expect(detail.getByTestId('btn-send')).toHaveCount(0);
    // 처리 결과 입력은 남고 처리 내용 끝에 발송 줄
    await expect(detail.getByTestId('form-status-wip')).toBeChecked();
    await expect(detail.getByTestId('form-reflect')).toBeChecked();
    await expect(detail.getByTestId('form-note')).toHaveValue(new RegExp(`^${esc(NOTE_WIP)}\\n${SENT_LINE}$`));
    // 지난 발송 배지
    const badge = detail.getByTestId('reply-last-sent');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('회신함');
    await expect(badge).toContainText(new RegExp(`${esc(FROM_NAME)}|${esc(FROM_ADDR)}`));
  });

  await test.step('다시 [저장]: 메모에 처리 내용 + 발송 줄, 대기열 항목에 보낸 본문(reply) — 메일은 다시 보내지 않는다', async () => {
    fs.chmodSync(sandbox.file(TODO), 0o666);
    const before = await noticeText(full);
    const save = detail.getByTestId('btn-save');
    await expect(save).toBeEnabled();
    await save.click();
    await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).not.toHaveAttribute('data-tone', 'error');
    const memo = lf(sandbox.read(MEMO));
    const entry = memo.split('\n');
    const at = entry.indexOf(`- ${TODAY} · ${NOTE_WIP}`);
    expect(at, `메모에 '- ${TODAY} · 처리 내용' 줄:\n${memo}`).toBeGreaterThan(0);
    expect(entry[at + 1]).toMatch(new RegExp(`^  ${SENT_LINE}$`));
    const queue: QueueItem[] = await full.evaluate(() => window.radar.getQueue());
    const item = queue.find((q) => q.taskId === task.id);
    expect(item, '위키 지식에도 반영 → 대기열 한 건').toBeDefined();
    expect(item?.reply, '보냈지만 저장 실패 뒤의 [저장]에도 보낸 본문이 따라간다').toBe(BODY1);
    expect(fakeSmtp.messages).toHaveLength(1);
  });

  await test.step('다시 켜면 새 작성 칸(새 sendId) — 상태를 그대로 두고 보내도 받아들인다(가짜 서버 두 통)', async () => {
    await expect(rowById(full, task.id), '진행 중은 목록에 남는다').toHaveCount(1);
    await expect(detail).toHaveAttribute('data-task-id', task.id);
    const again = await openReply(detail);
    await expect(again).toHaveAttribute('data-ready', 'true');
    await expect(again.getByTestId('reply-body'), '새 작성 칸은 비어 있다').toHaveValue('');
    const BODY2 = '안녕하세요.\n\n반영을 마쳤습니다. 확인 부탁드립니다.\n\n감사합니다.';
    await again.getByTestId('reply-body').fill(BODY2);
    const before = await noticeText(full);
    const dialog = await openSendConfirm(full, detail);
    await dialog.getByTestId('btn-send-confirm').click();
    await expect(dialog).toHaveCount(0);
    await waitNewNotice(full, before);
    await expect(full.getByTestId('save-notice')).toHaveAttribute('data-tone', 'ok');
    await expect.poll(() => fakeSmtp.messages.length, { message: '가짜 서버가 두 번째 메일을 받아야 한다' }).toBe(2);
    expect(parseRaw(fakeSmtp.messages[1].raw).text.startsWith(BODY2)).toBe(true);
    const records = sentOnDisk(sandbox) ?? [];
    expect(records).toHaveLength(2);
    expect(new Set(records.map((r) => r.id)).size, '두 발송의 sendId 는 다르다').toBe(2);
    await expect(detail.getByTestId('reply-panel')).toHaveCount(0);
    await expect(detail.getByTestId('reply-toggle')).not.toBeChecked();
    await expect(detail.getByTestId('reply-last-sent')).toBeVisible();
  });

  expect(logs.rendererErrors).toEqual([]);
});

// ---- (e) 초안을 만드는 중 [취소] ----------------------------------------------------------------

test('(e) 초안 중 [취소]: 본문이 비면 바로 되돌리고 초점은 상태 라디오 · 본문이 있으면 되돌리기 확인 중에 초안이 와도 대화상자를 겹치지 않는다', async () => {
  test.setTimeout(120_000);
  ({ app } = await launchSandboxApp({ today: TODAY, draftMode: 'slow', draftDelayMs: 2_500, smtp: 'none' }));
  logs = watchLogs(app);
  const full = await fullWindow(app);
  const task = await mailTask(full);
  const detail = await openInFull(full, task.id);
  const cancel = detail.locator('.result-actions').getByRole('button', { name: '취소' });

  await test.step('본문이 빈 채 초안 중 [취소] → 대화상자 없이 되돌리고 초점은 고른 상태 라디오(body 로 떨어지지 않는다)', async () => {
    const panel = await openReply(detail);
    await panel.getByTestId('btn-draft').click();
    await expect(panel.getByTestId('draft-status')).toHaveAttribute('data-state', 'running');
    await cancel.click();
    await expect(detail.getByTestId('reply-panel')).toHaveCount(0);
    await expect(detail.getByTestId('reply-toggle')).not.toBeChecked();
    expect(await openDialogs(full)).toBe(0);
    await expect.poll(() => focusedTestId(full), { message: '[취소] 뒤 초점은 상태 라디오' }).toBe(`form-status-${task.status}`);
    // 잠시 뒤에도 그대로(늦게 도는 초점 요청이 body 로 옮기지 않는다)
    await full.waitForTimeout(400);
    expect(await focusedTestId(full)).toBe(`form-status-${task.status}`);
  });

  await test.step('본문이 있을 때 초안 중 [취소] → 되돌리기 확인만 뜨고, 그사이 온 초안의 교체 확인은 [계속 쓰기] 뒤에 뜬다', async () => {
    const panel = await openReply(detail);
    // 앞 초안 프로세스가 끝나야 새 초안을 만들 수 있다(명세 §9-4)
    await expect(panel.getByTestId('btn-draft')).toBeEnabled({ timeout: 15_000 });
    const MINE = '제가 먼저 쓴 본문입니다.';
    await detail.getByTestId('form-note').fill(NOTE);
    await panel.getByTestId('reply-body').fill(MINE);
    await panel.getByTestId('btn-draft').click();
    await expect(panel.getByTestId('draft-status')).toHaveAttribute('data-state', 'running');
    await cancel.click();
    const discard = full.getByRole('dialog', { name: '입력을 되돌릴까요?' });
    await expect(discard).toBeVisible();
    // 초안이 온다(되돌리기 확인은 초안을 멈추지 않는다) — 교체 확인은 겹쳐 띄우지 않는다
    await expect(panel.getByTestId('draft-status')).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
    await full.waitForTimeout(300);
    expect(await openDialogs(full), '대화상자는 하나만').toBe(1);
    await expect(full.getByTestId('draft-replace-confirm')).toHaveCount(0);
    await expect(discard).toBeVisible();

    await discard.getByRole('button', { name: '계속 쓰기' }).click();
    const replace = full.getByTestId('draft-replace-confirm');
    await expect(replace, '되돌리기 확인이 닫힌 뒤 교체 확인이 뜬다').toBeVisible();
    expect(await openDialogs(full)).toBe(1);
    await replace.getByRole('button', { name: '초안으로 바꾸기' }).click();
    await expect(replace).toHaveCount(0);
    await full.waitForTimeout(300);
    expect(await openDialogs(full), '옛 되돌리기 확인이 다시 나타나지 않는다').toBe(0);
    const body = await panel.getByTestId('reply-body').inputValue();
    expect(body).toContain(NOTE);
    expect(body).not.toContain(MINE);
  });

  expect(logs.rendererErrors).toEqual([]);
});
