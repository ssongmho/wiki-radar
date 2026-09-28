// 2단계 e2e: 처리 결과 입력 → 위키 반영(docs/stage2-contract.md §1~§3).
// 테스트 사본(test/fixtures/wiki)의 임시 복사본(os.tmpdir)으로 빌드된 앱을 띄우고, 가짜 claude(test/fixtures/fake-claude.mjs)만 쓴다.
//   (a) 체크박스 '법인카드 지출결의서 작성' → 완료 + 두 줄 메모 + 반영 → 할 일 줄·메모 절·백업·목록·반영 대기 1
//   (b) 앵커 없는 큐레이션 '대륙물산 서버 교체 견적 방향 결정' → 내 일 아님, 담당 박담당 → 위임 로그 절
//   (d) 반영 대기 → [위키에 반영] → 확인 → 가짜 claude ok → 바뀐 파일, 대기열 비움, 사본 엔티티에 한 줄
//   (c) 되돌리기(open) → 위임 로그에서 회수, 목록에 다시 나온다 — 묶음 맨 뒤에 돌린다(아래 설명)
//   (e) 가짜 claude fail → 실패 표시, 대기열 유지(앱을 다시 띄워도 남는다)
// 저장 중 파일이 바뀌는 경합은 단위 시험(test/unit)이 맡는다.
// 원본 test/fixtures/wiki 는 시험 뒤에도 바이트 단위로 같아야 한다(treeDigest). 먼저 `npm run package`.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { QueueItem, ReflectRun, SaveResultOutput, TaskStatus } from '../../src/shared/types';
import {
  FIXTURE_WIKI,
  RESULTS_DIR,
  checkboxTaskId,
  closeApp,
  coreOf,
  curatedTaskId,
  launchSandboxApp,
  settle,
  treeDigest,
  watchLogs,
  windowByMode,
  windowVisibility,
  type AppLogs,
  type WikiSandbox,
} from './app';

const TODAY = '2026-09-23';

/**
 * 2단계 화면의 테스트 식별자(화면 담당 목록 — src/renderer). 이름이 바뀌면 여기만 고친다.
 * 처리 결과 입력은 상세(`detail`) 안에 있다.
 */
const TID = {
  /** 상태 라디오 input(대기·진행 중·완료·내 일 아님) */
  status: (s: TaskStatus) => `form-status-${s}`,
  /** 넘길 담당자 입력(내 일 아님일 때만 입력할 수 있다) */
  owner: 'form-owner',
  /** 처리 내용 */
  note: 'form-note',
  /** '위키 지식에도 반영' 체크박스 */
  reflect: 'form-reflect',
  /** [저장] */
  save: 'btn-save',
  /** 저장 결과 알림(고친 파일·백업 위치·경고), data-tone = ok|warn|error */
  saveNotice: 'save-notice',
  /** 풀스크린 내비 '할 일' */
  navTasks: 'nav-tasks',
  /** 풀스크린 내비 '반영 대기 N'(data-count) */
  navQueue: 'nav-queue',
  /** 사이드바 상태 줄 '반영 N'(data-count). 누르면 풀스크린 반영 대기 화면 */
  statusQueue: 'sidebar-queue',
  /** 반영 대기 화면의 항목 목록(data-count) */
  queueList: 'queue-list',
  /** 대기 항목 한 줄(data-queue-id) */
  queueItem: 'queue-item',
  /** [위키에 반영] */
  runReflect: 'btn-reflect',
  /** 확인 대화상자(열렸을 때만). 안의 [반영 시작]으로 실행한다 */
  reflectConfirm: 'reflect-confirm',
  /** 실행 중 진행 표시(data-state = running) */
  reflectStatus: 'reflect-status',
  /** 마지막 실행 결과(data-state = done|failed) */
  reflectResult: 'reflect-result',
} as const;

// ---- 테스트 사본의 원문 -------------------------------------------------------------

const TODO = '_private/mgmt/내 할 일.md';
const MEMO = '_private/mgmt/할 일 메모.md';
const ENTITY = 'wiki/entities/한결케미칼.md';
const BACKUP_ROOT = '_todo-sync/backup';
/** 테스트 사본에 원래 들어 있는 백업(백업 사본에만 있는 할 일) */
const FIXTURE_BACKUP = '20260901T000000';

const CARD_LINE = '- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]';
const CARD_DONE_LINE = `- [x] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23] [done:: ${TODAY}]`;
const CARD_TITLE = '법인카드 지출결의서 작성';
const CARD_ID = checkboxTaskId(TODO, CARD_LINE);
/** sync_todo 제목 = 메모 절 제목(핵심문구, 태그 포함 — 명세 §1-1·§5) */
const CARD_SYNC_TITLE = coreOf(CARD_LINE);
const CARD_NOTE = ['영수증 3건을 붙여 상신함', '결재는 연휴 뒤 팀장님 확인 예정'];

const SERVER_QUOTE = '대륙물산 서버 교체 견적 방향 결정';
const SERVER_QUOTE_ID = curatedTaskId(SERVER_QUOTE);
const SERVER_QUOTE_OWNER = '박담당';
/** 위임 로그 절의 기존 줄(새 줄은 이 다음에 붙는다) */
const DELEGATE_LAST = '- 2026-09-11 · 큐레이션 위임 항목 → 담당 **박담당** — 개발팀에 이관';
const SERVER_QUOTE_LOG = `- ${TODAY} · ${SERVER_QUOTE} → 담당 **${SERVER_QUOTE_OWNER}**`;

const WEEKLY_LINE = '- [ ] 주간 업무보고 작성 #내할일 [pri:: 2] [due:: 2026-09-25]';
const WEEKLY_ID = checkboxTaskId(TODO, WEEKLY_LINE);
const WEEKLY_WIP_LINE = `${WEEKLY_LINE} [wip:: ${TODAY}]`;
const WEEKLY_NOTE = '초안 절반 작성, 실적 수치 확인 중';

/** 확인 문구(명세 §3: Claude가 위키 문서를 고친다) */
const CONFIRM_RE = /Claude[^\n]{0,20}위키 문서[^\n]{0,20}고[친칩치쳐]/;

/** 이번 주 구간 수: 처음 4 */
const THIS_WEEK = 4;

// ---- 도우미 ------------------------------------------------------------------------

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const readFixture = (rel: string) => fs.readFileSync(path.join(FIXTURE_WIKI, ...rel.split('/')), 'utf8');
/** 앞 12줄 안의 첫 `updated:` 를 날짜로(sync_todo 와 같다) */
const withUpdated = (text: string, date: string) => {
  const lines = text.split('\n');
  const i = lines.slice(0, 12).findIndex((l) => l.startsWith('updated:'));
  if (i >= 0) lines[i] = `updated: ${date}`;
  return lines.join('\n');
};
/** 한 줄을 정확히 한 번 바꾼다(원문에 없으면 시험 자체가 잘못된 것이므로 멈춘다) */
const replaceLine = (text: string, from: string, to: string) => {
  const lines = text.split('\n');
  const i = lines.indexOf(from);
  if (i < 0 || lines.indexOf(from, i + 1) >= 0) throw new Error(`시험 준비 오류: 줄이 한 번만 있어야 한다: ${from}`);
  lines.splice(i, 1, ...(to === '' ? [] : to.split('\n')));
  return lines.join('\n');
};

/** 사본의 새 백업 폴더(테스트 사본에 원래 있던 것 제외), 이름순 */
function newBackups(sb: WikiSandbox): string[] {
  const dir = sb.file(BACKUP_ROOT);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n !== FIXTURE_BACKUP)
    .sort();
}
/** 새 백업들에 들어 있는 rel 파일의 내용(줄바꿈 정규화) */
function backedUp(sb: WikiSandbox, rel: string): string[] {
  return newBackups(sb)
    .map((stamp) => sb.file(`${BACKUP_ROOT}/${stamp}/${rel}`))
    .filter((p) => fs.existsSync(p))
    .map((p) => lf(fs.readFileSync(p, 'utf8')));
}

/** queue.json 의 항목(배열 또는 {items:[…]} 모두 받는다) */
function queueOnDisk(sb: WikiSandbox): QueueItem[] | undefined {
  const raw = sb.readData<QueueItem[] | { items?: QueueItem[] }>('queue.json');
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : (raw.items ?? []);
}
function historyOnDisk(sb: WikiSandbox): ReflectRun[] | undefined {
  const raw = sb.readData<ReflectRun[] | { runs?: ReflectRun[] }>('reflect-history.json');
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw : (raw.runs ?? []);
}

const rowById = (page: Page, id: string) => page.locator(`[data-testid="task-row"][data-task-id="${id}"]`);
const getQueue = (page: Page) => page.evaluate(() => window.radar.getQueue());
const getReflect = (page: Page) => page.evaluate(() => window.radar.getReflect());

/**
 * '반영 대기 N'·'반영 N' 의 N. data-count 가 있으면 그것, 없으면 글자에서 읽는다(숫자 없이 이름만 있으면 0).
 * 이름이 없으면 null.
 */
async function countIn(loc: Locator, label: string): Promise<number | null> {
  if ((await loc.count()) === 0) return null;
  const attr = await loc.first().getAttribute('data-count');
  if (attr !== null) return Number(attr);
  const text = ((await loc.first().textContent()) ?? '').replace(/\s+/g, ' ');
  if (!text.includes(label)) return null;
  const m = new RegExp(`${label}\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : 0;
}
async function expectQueueCount(full: Page, sidebar: Page | null, n: number): Promise<void> {
  await expect.poll(() => countIn(full.getByTestId(TID.navQueue), '반영 대기'), { message: `내비 '반영 대기 ${n}'` }).toBe(n);
  if (sidebar) {
    await expect.poll(() => countIn(sidebar.getByTestId(TID.statusQueue), '반영'), { message: `사이드바 '반영 ${n}'` }).toBe(n);
  }
}

/** 풀스크린 목록에서 항목을 골라 상세(처리 결과 입력 포함)가 그 항목으로 바뀔 때까지. 상세를 돌려준다 */
async function openInFull(full: Page, id: string): Promise<Locator> {
  const row = rowById(full, id);
  await expect(row, `풀스크린 목록에 ${id} 가 있어야 한다`).toHaveCount(1);
  await row.click();
  const detail = full.getByTestId('detail');
  await expect(detail).toHaveAttribute('data-task-id', id);
  await expect(detail.getByTestId(TID.save), '상세에 처리 결과 입력이 있어야 한다').toBeVisible();
  return detail;
}

interface ResultInput {
  status: TaskStatus;
  owner?: string;
  note?: string;
  reflect: boolean;
}
/** 처리 결과를 입력하고 [저장]. 저장 알림이 뜨면 그 글자를 곧바로 읽어 돌려준다(알림은 몇 초 뒤 사라진다) */
async function fillAndSave(full: Page, form: Locator, input: ResultInput): Promise<string> {
  await form.getByTestId(TID.status(input.status)).check();
  const owner = form.getByTestId(TID.owner);
  if (input.status === 'notmine') {
    await expect(owner, '내 일 아님이면 담당자를 입력할 수 있다').toBeEditable();
    await owner.fill(input.owner ?? '');
  } else {
    // 명세 §3: 담당자 입력은 내 일 아님일 때만 — 숨기거나 막아 둔다
    await expect
      .poll(async () => (await owner.count()) === 0 || !(await owner.isVisible()) || !(await owner.isEditable()), {
        message: '담당자 입력은 내 일 아님일 때만 쓸 수 있다',
      })
      .toBe(true);
  }
  await form.getByTestId(TID.note).fill(input.note ?? '');
  const reflect = form.getByTestId(TID.reflect);
  if (input.reflect) await reflect.check();
  else await reflect.uncheck();
  // 앞 저장의 알림이 남아 있을 수 있다(항목이 바뀌어도 남는다) — 새 알림이 뜰 때까지 기다린다
  const notice = full.getByTestId(TID.saveNotice);
  const textOf = async () =>
    (await notice.count()) === 0 ? null : ((await notice.first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
  const before = await textOf();
  await form.getByTestId(TID.save).click();
  await expect
    .poll(async () => {
      const now = await textOf();
      return now !== null && now !== '' && now !== before;
    }, { message: '저장 결과 알림이 새로 떠야 한다' })
    .toBe(true);
  await expect(notice).toBeVisible();
  return (await textOf()) ?? '';
}

/** 반영 대기 화면을 연다(내비 '반영 대기'). 목록을 돌려준다 */
async function openQueueView(full: Page): Promise<Locator> {
  await full.getByTestId(TID.navQueue).click();
  const list = full.getByTestId(TID.queueList);
  await expect(list, '반영 대기 화면이 떠야 한다').toBeVisible();
  return list;
}

/** [위키에 반영] → 확인 대화상자(확인 문구: Claude가 위키 문서를 고친다) → [반영 시작] */
async function runReflectWithConfirm(full: Page): Promise<void> {
  await full.getByTestId(TID.runReflect).click();
  const dialog = full.getByTestId(TID.reflectConfirm);
  await expect(dialog, '확인 대화상자가 떠야 한다').toBeVisible();
  await expect(dialog).toContainText(CONFIRM_RE);
  await dialog.getByRole('button', { name: /반영 시작/ }).click();
  await expect(dialog).toHaveCount(0);
}

async function attachLogs(logs: AppLogs | undefined, testInfo: TestInfo): Promise<void> {
  if (!logs || testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
  await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
}

// ---- (a)~(d): 저장 → 반영 성공 ---------------------------------------------------------

test.describe('처리 결과 저장과 위키 반영(가짜 claude ok)', () => {
  test.describe.configure({ mode: 'serial' });

  let fixtureBefore: Record<string, string>;
  let app: ElectronApplication;
  let sandbox: WikiSandbox;
  let logs: AppLogs;
  let sidebar: Page;
  let full: Page;

  // 원문과 단계별 기대값(줄바꿈 정규화)
  const todoOrig = lf(readFixture(TODO));
  const memoOrig = lf(readFixture(MEMO));
  const todoAfterA = replaceLine(todoOrig, CARD_LINE, CARD_DONE_LINE);
  const memoAfterA =
    withUpdated(memoOrig, TODAY).replace(/\s+$/, '') +
    `\n\n## ${CARD_SYNC_TITLE}\n출처 \`${TODO}\`\n\n- ${TODAY} · ${CARD_NOTE[0]}\n  ${CARD_NOTE[1]}\n`;
  const todoAfterB = replaceLine(withUpdated(todoAfterA, TODAY), DELEGATE_LAST, `${DELEGATE_LAST}\n${SERVER_QUOTE_LOG}`);
  const todoAfterC = replaceLine(todoAfterB, SERVER_QUOTE_LOG, '');

  test.beforeAll(async () => {
    fixtureBefore = treeDigest(FIXTURE_WIKI);
    ({ app, sandbox } = await launchSandboxApp({ today: TODAY, claudeMode: 'ok' }));
    logs = watchLogs(app);
    sidebar = await windowByMode(app, 'sidebar');
    full = await windowByMode(app, 'full');
  });

  test.afterEach(async ({}, testInfo) => attachLogs(logs, testInfo));

  test.afterAll(async () => {
    if (app) await closeApp(app);
    // 원본 테스트 사본은 그대로여야 한다(쓰기는 임시 사본에만)
    if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
  });

  test('(a) 체크박스 항목을 완료 + 두 줄 메모 + 반영으로 저장한다', async () => {
    // 시험 준비 확인: 사본이 원본과 같고, 기대값이 원문과 다르다
    expect(lf(sandbox.read(TODO))).toBe(todoOrig);
    expect(todoAfterA).not.toBe(todoOrig);
    await expect(sidebar.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(THIS_WEEK));

    // 사이드바에서 누르면 풀스크린에서 그 항목이 열린다
    const sideRow = rowById(sidebar, CARD_ID);
    await expect(sideRow).toHaveCount(1);
    await sideRow.click();
    await expect.poll(() => windowVisibility(app)).toEqual({ sidebar: false, full: true });
    await expect(full.getByTestId('detail')).toHaveAttribute('data-task-id', CARD_ID);
    await expect(full.getByTestId('detail-title')).toHaveText(CARD_TITLE);

    const form = await openInFull(full, CARD_ID);
    // 현재 상태(대기)가 골라져 있고, 반영은 꺼져 있다
    await expect(form.getByTestId(TID.status('open'))).toBeChecked();
    await expect(form.getByTestId(TID.reflect)).not.toBeChecked();
    const noticeText = await fillAndSave(full, form, {
      status: 'done',
      note: CARD_NOTE.join('\n'),
      reflect: true,
    });
    await expect(full.getByTestId(TID.saveNotice), '경고 없는 저장').toHaveAttribute('data-tone', 'ok');

    // 할 일 줄: - [x] … [done:: 오늘], 다른 필드(pri·due)와 다른 줄은 그대로
    await expect.poll(() => lf(sandbox.read(TODO)), { message: '내 할 일.md 의 줄이 완료로 바뀌어야 한다' }).toBe(todoAfterA);
    // 메모 절: '## <sync 제목>' + 출처 + 두 줄 메모(둘째 줄은 두 칸 들여쓰기), 머리 updated 는 오늘
    expect(lf(sandbox.read(MEMO))).toBe(memoAfterA);
    // 줄바꿈 유지(테스트 사본은 LF)
    expect(sandbox.read(TODO).includes('\r\n')).toBe(readFixture(TODO).includes('\r\n'));
    expect(sandbox.read(MEMO).includes('\r\n')).toBe(readFixture(MEMO).includes('\r\n'));

    // 백업: _todo-sync/backup/<YYYYMMDDTHHMMSS>/ 에 고치기 전 원본 두 파일
    const stamps = newBackups(sandbox);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatch(/^\d{8}T\d{6}$/);
    expect(backedUp(sandbox, TODO)).toEqual([todoOrig]);
    expect(backedUp(sandbox, MEMO)).toEqual([memoOrig]);
    // 다른 파일은 백업하지 않았다(쓴 파일만)
    const backupFiles = fs.readdirSync(sandbox.file(`${BACKUP_ROOT}/${stamps[0]}`), { recursive: true, withFileTypes: true });
    expect(backupFiles.filter((e) => e.isFile()).map((e) => e.name).sort()).toEqual(['내 할 일.md', '할 일 메모.md']);

    // 알림: 고친 파일과 백업 위치
    expect(noticeText).toContain('내 할 일.md');
    expect(noticeText).toContain(stamps[0]);

    // 완료한 항목은 두 창의 목록에서 빠진다
    await expect(rowById(full, CARD_ID)).toHaveCount(0);
    await expect(full.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(THIS_WEEK - 1));
    await expect(rowById(sidebar, CARD_ID)).toHaveCount(0);
    await expect(sidebar.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(THIS_WEEK - 1));

    // 반영 대기 1: 풀스크린 내비·사이드바 상태 줄·API·queue.json
    await expectQueueCount(full, sidebar, 1);
    const queue = await getQueue(full);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ kind: 'task', taskId: CARD_ID, status: 'done', note: CARD_NOTE.join('\n') });
    expect(queue[0].title).toContain(CARD_TITLE);
    await expect.poll(() => queueOnDisk(sandbox)?.map((q) => q.taskId)).toEqual([CARD_ID]);

    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'stage2-saved.png') });
  });

  test('(b) 앵커 없는 큐레이션을 내 일 아님(담당 박담당)으로 저장하면 위임 로그 절에 적힌다', async () => {
    const form = await openInFull(full, SERVER_QUOTE_ID);
    await expect(full.getByTestId('detail-title')).toHaveText(SERVER_QUOTE);
    const noticeText = await fillAndSave(full, form, { status: 'notmine', owner: SERVER_QUOTE_OWNER, reflect: false });
    await expect(full.getByTestId(TID.saveNotice), '경고 없는 저장').toHaveAttribute('data-tone', 'ok');
    expect(noticeText).toContain(SERVER_QUOTE);

    // 위임 로그 절 끝에 '- 오늘 · 제목 → 담당 **박담당**', 머리 updated 는 오늘. (a)의 완료 줄은 그대로
    await expect.poll(() => lf(sandbox.read(TODO)), { message: '위임 로그 절에 적혀야 한다' }).toBe(todoAfterB);
    // 메모를 비웠으므로 메모 파일은 (a) 그대로
    expect(lf(sandbox.read(MEMO))).toBe(memoAfterA);
    // 이번 저장 전의 내 할 일.md 가 백업돼 있다
    expect(backedUp(sandbox, TODO)).toContain(todoAfterA);

    // 목록에서 빠지고, 반영을 끄고 저장했으므로 대기열은 그대로 1
    await expect(rowById(full, SERVER_QUOTE_ID)).toHaveCount(0);
    await expect(full.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(THIS_WEEK - 2));
    await expectQueueCount(full, sidebar, 1);
    expect((await getQueue(full)).map((q) => q.taskId)).toEqual([CARD_ID]);
  });

  test('(d) 반영 대기 → [위키에 반영] → 가짜 claude ok → 바뀐 파일을 보이고 대기열을 비운다', async () => {
    const entityBefore = lf(sandbox.read(ENTITY));
    expect(entityBefore).toBe(lf(readFixture(ENTITY)));

    const list = await openQueueView(full);
    await expect(list).toHaveAttribute('data-count', '1');
    const items = full.getByTestId(TID.queueItem);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(CARD_TITLE);
    await expect(items.first()).toContainText(CARD_NOTE[0]);

    await runReflectWithConfirm(full);

    await expect
      .poll(async () => (await getReflect(full))?.state, { message: '실행이 끝나야 한다', timeout: 30_000 })
      .toBe('done');
    const run = (await getReflect(full)) as ReflectRun;
    expect(run.changed).toEqual([ENTITY]);
    expect(run.itemIds).toHaveLength(1);

    // 화면: 마지막 실행 결과에 바뀐 파일(누르면 Obsidian 에서 연다)
    const result = full.getByTestId(TID.reflectResult);
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-state', 'done');
    await expect(result).toContainText('바뀐 파일 1개');
    await expect(result.getByRole('button', { name: new RegExp(ENTITY) })).toBeVisible();
    await expect(full.getByTestId(TID.reflectStatus)).toHaveCount(0);

    // 대기열이 비었다(화면·내비·사이드바·API·queue.json), 실행 기록에 남았다
    await expect(items).toHaveCount(0);
    await expect(list).toHaveAttribute('data-count', '0');
    await expectQueueCount(full, sidebar, 0);
    expect(await getQueue(full)).toEqual([]);
    await expect.poll(() => queueOnDisk(sandbox) ?? [], { message: 'queue.json 이 비어야 한다' }).toEqual([]);
    await expect
      .poll(() => (historyOnDisk(sandbox) ?? []).map((r) => [r.id, r.state]), { message: 'reflect-history.json 에 남아야 한다' })
      .toEqual([[run.id, 'done']]);

    // 가짜 claude 가 사본(cwd = 위키 사본)의 엔티티 끝에 한 줄을 덧붙였다
    const entityAfter = lf(sandbox.read(ENTITY));
    expect(entityAfter.startsWith(entityBefore), '기존 내용은 그대로').toBe(true);
    const added = entityAfter.slice(entityBefore.length).trim();
    expect(added).not.toBe('');
    expect(added.split('\n')).toHaveLength(1);
    // 할 일 줄·메모 파일은 claude 가 건드리지 않았다
    expect(lf(sandbox.read(TODO))).toBe(todoAfterB);
    expect(lf(sandbox.read(MEMO))).toBe(memoAfterA);

    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'stage2-reflected.png') });
  });

  test('(a)~(d) 동안 renderer 콘솔 에러가 없다', async () => {
    expect(logs.rendererErrors).toEqual([]);
  });

  // (c)는 맨 뒤에 둔다: 직렬 묶음이라 앞 시험이 실패하면 뒤가 건너뛰어지는데, 되돌리기가 실패해도 반영(d)·콘솔 확인은 따로 되게 한다.
  test('(c) 되돌리기(open)로 위임 로그에서 회수하면 목록에 다시 나온다', async () => {
    // 내 일 아님으로 바꾼 항목은 목록에서 빠지고 화면에 되돌리기 버튼이 없으므로, 화면이 저장에 쓰는 것과 같은 API 로 되돌린다
    await full.getByTestId(TID.navTasks).click();
    const out: SaveResultOutput = await full.evaluate(
      (taskId) => window.radar.saveResult({ taskId, status: 'open', reflect: false }),
      SERVER_QUOTE_ID,
    );
    expect(out.unlogged).toEqual([SERVER_QUOTE]);
    expect(out.updated).toEqual([]);
    expect(out.loggedDelegated).toEqual([]);
    expect(out.files).toEqual([TODO]);
    expect(out.queued).toBeUndefined();

    expect(lf(sandbox.read(TODO))).toBe(todoAfterC);
    expect(lf(sandbox.read(MEMO))).toBe(memoAfterA);
    await expect(rowById(full, SERVER_QUOTE_ID)).toHaveCount(1);
    await expect(rowById(full, SERVER_QUOTE_ID)).toHaveAttribute('data-bucket', 'thisWeek');
    await expect(full.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', String(THIS_WEEK - 1));
    // (d)에서 대기열을 비웠고, 되돌리기는 반영을 끄고 저장했다
    expect(await getQueue(full)).toEqual([]);
    expect(logs.rendererErrors).toEqual([]);
  });

});

// ---- (e): 반영 실패 ---------------------------------------------------------------------

test.describe('반영 실패(가짜 claude fail)는 대기열을 그대로 둔다', () => {
  test.describe.configure({ mode: 'serial' });

  let fixtureBefore: Record<string, string>;
  let app: ElectronApplication | undefined;
  let sandbox: WikiSandbox | undefined;
  let logs: AppLogs | undefined;

  test.beforeAll(() => {
    fixtureBefore = treeDigest(FIXTURE_WIKI);
  });

  test.afterEach(async ({}, testInfo) => attachLogs(logs, testInfo));

  test.afterAll(async () => {
    if (app) await closeApp(app);
    sandbox?.dispose();
    if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
  });

  test('(e) 실패를 보이고 대기열을 남기며, 앱을 다시 띄워도 남아 있다', async () => {
    // 다시 띄울 것이므로 샌드박스는 이 describe 가 직접 지운다
    ({ app, sandbox } = await launchSandboxApp({ today: TODAY, claudeMode: 'fail', disposeOnClose: false }));
    logs = watchLogs(app);
    const sidebar = await windowByMode(app, 'sidebar');
    const full = await windowByMode(app, 'full');
    const entityBefore = sandbox.read(ENTITY);
    await expectQueueCount(full, sidebar, 0);

    // 사이드바에서 '주간 업무보고 작성'을 눌러 풀스크린에서 연다 → 진행 중 + 메모 + 반영
    await rowById(sidebar, WEEKLY_ID).click();
    await expect.poll(() => windowVisibility(app!)).toEqual({ sidebar: false, full: true });
    const form = await openInFull(full, WEEKLY_ID);
    await fillAndSave(full, form, { status: 'wip', note: WEEKLY_NOTE, reflect: true });
    await expectQueueCount(full, sidebar, 1);
    await expect
      .poll(() => lf(sandbox!.read(TODO)).split('\n').includes(WEEKLY_WIP_LINE), { message: '할 일 줄에 [wip:: 오늘]' })
      .toBe(true);
    // 진행 중은 목록에 남는다
    await expect(rowById(full, WEEKLY_ID)).toHaveCount(1);

    const list = await openQueueView(full);
    await expect(full.getByTestId(TID.queueItem)).toHaveCount(1);
    await runReflectWithConfirm(full);

    await expect
      .poll(async () => (await getReflect(full))?.state, { message: '실행이 실패로 끝나야 한다', timeout: 30_000 })
      .toBe('failed');
    const run = (await getReflect(full)) as ReflectRun;
    expect(run.error ?? '').not.toBe('');

    // 화면: 실패 표시, 대기 항목은 그대로
    const result = full.getByTestId(TID.reflectResult);
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-state', 'failed');
    await expect(result).toContainText('실패');
    await expect(result).toContainText(run.error as string);
    await expect(list).toHaveAttribute('data-count', '1');
    await expect(full.getByTestId(TID.queueItem)).toHaveCount(1);
    await expectQueueCount(full, sidebar, 1);
    const queue = await getQueue(full);
    expect(queue.map((q) => [q.taskId, q.status, q.note])).toEqual([[WEEKLY_ID, 'wip', WEEKLY_NOTE]]);
    expect(queueOnDisk(sandbox)?.map((q) => q.taskId)).toEqual([WEEKLY_ID]);
    // 가짜 claude(fail)는 위키를 고치지 않는다
    expect(sandbox.read(ENTITY)).toBe(entityBefore);
    expect(logs.rendererErrors).toEqual([]);

    // 앱을 다시 띄워도 대기열(queue.json)이 남는다
    await closeApp(app);
    app = undefined;
    ({ app } = await launchSandboxApp({ today: TODAY, claudeMode: 'fail', sandbox, disposeOnClose: false }));
    logs = watchLogs(app);
    const sidebar2 = await windowByMode(app, 'sidebar');
    const full2 = await windowByMode(app, 'full');
    await expectQueueCount(full2, sidebar2, 1);
    expect((await getQueue(sidebar2)).map((q) => q.taskId)).toEqual([WEEKLY_ID]);

    // 사이드바 상태 줄 '반영 1'을 누르면 풀스크린의 반영 대기 화면이 열린다
    await sidebar2.getByTestId(TID.statusQueue).click();
    await expect.poll(() => windowVisibility(app!)).toEqual({ sidebar: false, full: true });
    await expect(full2.getByTestId(TID.queueList)).toHaveAttribute('data-count', '1');
    await expect(full2.getByTestId(TID.queueItem)).toContainText('주간 업무보고 작성');
    await expect(full2.getByTestId(TID.queueItem)).toContainText(WEEKLY_NOTE);
    expect(logs.rendererErrors).toEqual([]);
  });
});
