// 2.13단계 설정 화면(docs/stage2.13-contract.md §F-4) — 왼쪽 세로 목록 9칸 · 팀 기본값 점선 · 메일 받기·보내기·AI·VOC·위키·정보 칸 ·
// 점검 [고치기] · 되돌리기·떠나기 확인 · 회신 작성 칸의 초안 엔진 표시. main 쪽 채널 시험은 stage213-api.spec.ts.
// 가짜 서버는 모두 127.0.0.1: 가짜 POP3(test/fixtures/fake-pop3-server.mjs)·가짜 SMTP·가짜 LLM(fake-llm-server.mjs)·가짜 VOC 서버.
// 실제 위키·NAS·메일·VOC·LLM 서버는 부르지 않는다. 먼저 `npm run package`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  FAKE_SMTP_USER,
  FIXTURE_VOC,
  FIXTURE_WIKI,
  PROJECT_ROOT,
  RESULTS_DIR,
  closeApp,
  createWikiSandbox,
  launchApp,
  radarTest,
  settle,
  startFakeSmtp,
  treeDigest,
  watchLogs,
  windowByMode,
  type AppLogs,
  type LaunchOptions,
  type WikiSandbox,
} from './app';

const NOW = '2026-09-23T10:00';
const DR = 'raw/mail/대륙물산/2026/2026-09-21_1100_박담당_자재 단가 문의_d1d2d3.md';
const POP3_PASS = 'pop3-ui-secret-4417';
const LLM_KEY = 'llm-ui-key-8813';

const FIXTURES = path.join(PROJECT_ROOT, 'test', 'fixtures');
const imp = <T>(name: string): Promise<T> => import(pathToFileURL(path.join(FIXTURES, name)).href) as Promise<T>;

interface FakePop3 {
  port: number;
  commands: string[];
  close(): Promise<void>;
}
interface FakeLlm {
  url: string;
  requests: { path: string; auth?: string; body?: { messages?: { role: string; content: string }[]; chat_template_kwargs?: { enable_thinking?: boolean } } }[];
  close(): Promise<void>;
}

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
let sandbox: WikiSandbox | null = null;
const closers: (() => Promise<unknown>)[] = [];
const temps: string[] = [];
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
    await testInfo.attach('renderer-errors.txt', { body: logs.rendererErrors.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (app) await closeApp(app);
  app = null;
  logs = null;
  while (closers.length) await (closers.pop() as () => Promise<unknown>)().catch(() => undefined);
  sandbox?.dispose();
  sandbox = null;
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

async function start(opts: Partial<LaunchOptions> = {}, keep?: WikiSandbox): Promise<Page> {
  sandbox = keep ?? createWikiSandbox('wiki-radar-e2e-213ui-');
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW, ...opts });
  logs = watchLogs(app);
  return windowByMode(app, 'sidebar');
}

/** 사이드바에서 풀스크린 설정의 그 칸을 연다(view:settings:<칸> — §C-0 포커스 표시) */
async function openSettings(sidebar: Page, tab: string): Promise<Page> {
  await sidebar.evaluate((id) => window.radar.setMode('full', id), `view:settings:${tab}`);
  const full = await windowByMode(app!, 'full');
  await expect(full.getByTestId('settings-view')).toHaveAttribute('data-tab', tab, { timeout: 15_000 });
  return full;
}

async function fakePop3(): Promise<FakePop3> {
  const { startFakePop3 } = await imp<{ startFakePop3(o: unknown): Promise<FakePop3> }>('fake-pop3-server.mjs');
  const s = await startFakePop3({ user: FAKE_SMTP_USER, pass: POP3_PASS });
  closers.push(() => s.close());
  return s;
}

async function fakeLlm(opts: Record<string, unknown> = {}): Promise<{ s: FakeLlm; model: string; body: string }> {
  const m = await imp<{ startFakeLlm(o: unknown): Promise<FakeLlm>; FAKE_LLM_MODEL: string; FAKE_LLM_DRAFT_BODY: string }>('fake-llm-server.mjs');
  const s = await m.startFakeLlm(opts);
  closers.push(() => s.close());
  return { s, model: m.FAKE_LLM_MODEL, body: m.FAKE_LLM_DRAFT_BODY };
}

/** 데이터 폴더(로그 포함)의 모든 파일 바이트에 needle 이 없다 */
function expectNoPlaintext(dir: string, needle: string): void {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) {
    expect(fs.readFileSync(f).includes(Buffer.from(needle, 'utf8')), `평문 비밀이 ${path.relative(dir, f)} 에 있음`).toBe(false);
  }
}

/** 비밀 칸에 새 값을 넣는다(저장 전 초안) */
async function typeSecret(full: Page, value: string): Promise<void> {
  await full.getByTestId('sv-secret-change').click();
  await full.getByTestId('sv-secret-input').fill(value);
}

test('칸 목록 9칸·키보드 · 팀 기본값 점선·칸 머리 · 점검 [고치기] → 칸·앰버 점 · 되돌리기·떠나기 확인', async () => {
  const sidebar = await start({
    teamSettings: { version: 1, mailIn: { host: '127.0.0.1', port: 1100, ssl: false }, mailOut: { host: '127.0.0.1', port: 2525, security: 'starttls' }, ai: { llmUrl: 'http://127.0.0.1:9/v1', model: 'team-model' } },
  });
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getTeamDefaults!({ refresh: true }))).source, { timeout: 15_000 }).toBe('env');

  // view:settings:ai 로 AI 칸이 열린다
  let full = await openSettings(sidebar, 'ai');
  await expect(full.getByTestId('settings-tab-ai')).toHaveAttribute('aria-selected', 'true');
  await expect(full.getByTestId('settings-ai')).toBeVisible();
  // AI 는 팀 기본값을 받지 않는다(소유자 결정 2026-10-19) — 팀 파일의 ai 는 버려지고 AI 칸엔 팀 줄·점선이 없다
  await expect(full.getByTestId('sv-field-model')).toHaveAttribute('data-source', 'none');
  await expect(full.getByTestId('sv-input-model')).toHaveValue('');
  await expect(full.getByTestId('settings-ai').getByTestId('sv-team')).toHaveCount(0);
  await expect(full.getByTestId('settings-ai').locator('.is-team')).toHaveCount(0);

  await test.step('칸 목록: 세로 9칸 순서 · 위·아래 키', async () => {
    const tabs = full.getByTestId('settings-tabs');
    await expect(tabs).toHaveAttribute('aria-orientation', 'vertical');
    await expect(tabs.getByRole('tab')).toHaveText(['점검', '나', '위키', '메일 받기', '메일 보내기', 'AI', 'VOC', '알림', '정보']);
    await full.getByTestId('settings-tab-ai').focus();
    await full.keyboard.press('ArrowDown');
    await expect(full.getByTestId('settings-tab-voc')).toHaveAttribute('aria-selected', 'true');
    await expect(full.getByTestId('settings-tab-voc')).toBeFocused();
    await full.keyboard.press('ArrowUp');
    await full.keyboard.press('ArrowUp');
    await expect(full.getByTestId('settings-tab-mailOut')).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('팀 기본값: 메일 받기 서버는 점선(data-source=team) · 칸 머리 출처', async () => {
    await full.getByTestId('settings-tab-mailIn').click();
    const host = full.getByTestId('sv-field-host');
    await expect(host).toHaveAttribute('data-source', 'team');
    await expect(host).toHaveClass(/is-team/);
    await expect(full.getByTestId('sv-input-host')).toHaveValue('127.0.0.1');
    await expect(full.getByTestId('sv-source-host')).toContainText('팀 기본값');
    await expect(full.getByTestId('sv-team')).toContainText('팀 기본값: 환경 변수 파일');
    await expect(full.getByTestId('sv-mailin-collect')).toHaveText('계정 없음'); // 2.15: 수집 상태 칩(팀 서버는 있으나 아이디·비밀번호 없음)
    await expect(full.getByTestId('sv-mailin-keep')).toHaveText('서버의 메일은 지우지 않습니다.');
    await settle(full);
    await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-mailin-team.png') });
  });

  await test.step('되돌리기 · 떠나기 확인', async () => {
    const input = full.getByTestId('sv-input-host');
    await input.fill('pop.example.com');
    await expect(full.getByTestId('sv-field-host')).toHaveAttribute('data-source', 'user');
    await expect(full.getByTestId('sv-save')).toBeEnabled();
    await full.getByTestId('sv-revert').click();
    await expect(input).toHaveValue('127.0.0.1');
    await expect(full.getByTestId('sv-save')).toBeDisabled();
    // 고친 채 다른 칸 → 확인 대화상자
    await input.fill('pop.example.com');
    await full.getByTestId('settings-tab-ai').click();
    const dialog = full.getByTestId('sv-leave-confirm');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('sv-leave-stay').click();
    await expect(full.getByTestId('settings-tab-mailIn')).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveValue('pop.example.com');
    await full.getByTestId('settings-tab-ai').click();
    await full.getByTestId('sv-leave-discard').click();
    await expect(full.getByTestId('settings-tab-ai')).toHaveAttribute('aria-selected', 'true');
    await full.getByTestId('settings-tab-mailIn').click();
    await expect(full.getByTestId('sv-input-host')).toHaveValue('127.0.0.1');
  });

  await test.step('점검: 메일 받기 줄 warn · [고치기] → 메일 받기 칸 · 칸 옆 앰버 점', async () => {
    await full.getByTestId('settings-tab-check').click();
    const line = full.getByTestId('setup-mailIn');
    await expect(line).toHaveAttribute('data-tone', 'warn');
    await expect(full.getByTestId('settings-dot-mailIn')).toBeVisible();
    // 팀 파일의 ai 는 버려지고 팀 기본값 줄에 문제로 남는다(소유자 결정 2026-10-19)
    await expect(full.getByTestId('setup-team')).toHaveAttribute('data-tone', 'warn');
    await expect(full.getByTestId('setup-team')).toContainText('AI 는 팀 기본값으로 정하지 않습니다');
    await full.getByTestId('setup-mailIn-fix').click();
    await expect(full.getByTestId('settings-tab-mailIn')).toHaveAttribute('aria-selected', 'true');
    await full.getByTestId('settings-tab-check').click();
    await full.getByTestId('setup-claude-fix').click();
    await expect(full.getByTestId('settings-tab-ai')).toHaveAttribute('aria-selected', 'true');
  });
  expect(logs!.rendererErrors).toEqual([]);
  await closeApp(app!);
  app = null;
  sandbox?.dispose();
  sandbox = null;

  // 비밀이 든 팀 파일 → 값을 쓰지 않고 점검 warn
  const sb2 = await start({ teamSettings: { version: 1, mailIn: { host: '127.0.0.1', password: 'nope-123456' } } });
  full = await openSettings(sb2, 'check');
  await expect(full.getByTestId('setup-team')).toHaveAttribute('data-tone', 'warn', { timeout: 15_000 });
  await expect(full.getByTestId('settings-dot-info')).toBeVisible();
  await full.getByTestId('setup-team-fix').click();
  await expect(full.getByTestId('settings-tab-info')).toHaveAttribute('aria-selected', 'true');
  await expect(full.getByTestId('sv-team-problem')).toContainText('비밀번호');
  await full.getByTestId('settings-tab-mailIn').click();
  await expect(full.getByTestId('sv-field-host')).toHaveAttribute('data-source', 'none');
});

test('메일 받기: 칸에서 연결 시험(3통) · 틀린 비밀번호 · [저장] → 저장됨, 평문 없음, DELE 없음 · 메일 보내기 같은 계정 → 발송 준비', async () => {
  const pop = await fakePop3();
  // 같은 계정 — 가짜 SMTP 도 메일 받기 칸의 아이디·비밀번호를 받는다
  const smtp = await startFakeSmtp({ user: FAKE_SMTP_USER, pass: POP3_PASS });
  closers.push(() => smtp.close());
  const sidebar = await start();
  const full = await openSettings(sidebar, 'mailIn');

  await full.getByTestId('sv-input-host').fill('127.0.0.1');
  await full.getByTestId('sv-input-port').fill(String(pop.port));
  await full.getByTestId('sv-input-ssl').uncheck();
  await full.getByTestId('sv-input-user').fill(FAKE_SMTP_USER);
  await typeSecret(full, 'wrong-ui-pass-31');
  await full.getByTestId('sv-test').click();
  const result = full.getByTestId('sv-test-result');
  await expect(result).toHaveAttribute('data-ok', 'false', { timeout: 20_000 });
  await expect(result).toContainText('로그인 실패');
  await expect(result).not.toContainText('wrong-ui-pass-31');

  await full.getByTestId('sv-secret-input').fill(POP3_PASS);
  await full.getByTestId('sv-test').click();
  await expect(result).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  await expect(result.getByTestId('sv-test-step')).toHaveCount(4);
  await expect(result).toContainText('3통');
  await expect(full.getByTestId('sv-status')).toContainText('[저장]을 눌러야 적용됩니다');
  expect(pop.commands.some((c) => /^(DELE|RSET)/i.test(c))).toBe(false);

  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('sv-secret-state')).toContainText('저장됨');
  await expect(full.getByTestId('sv-secret-input')).toHaveCount(0);
  await expect(full.getByTestId('sv-field-host')).toHaveAttribute('data-source', 'user');
  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-mailin.png') });
  expect(fs.readFileSync(path.join(sandbox!.data, 'app-settings.json'), 'utf8')).not.toContain(POP3_PASS);
  expectNoPlaintext(sandbox!.data, POP3_PASS);

  // 메일 보내기: 같은 계정(기본 켬) + 가짜 SMTP 서버 저장 → 다시 시작 없이 발송 준비
  await full.getByTestId('settings-tab-mailOut').click();
  await expect(full.getByTestId('sv-input-sameAccount')).toBeChecked();
  await expect(full.getByTestId('settings-mailOut')).toContainText(`메일 받기 칸의 계정을 씀(${FAKE_SMTP_USER})`);
  await expect(full.getByTestId('sv-input-user')).toHaveCount(0);
  await full.getByTestId('sv-input-host').fill('127.0.0.1');
  await full.getByTestId('sv-input-port').fill(String(smtp.port));
  await full.getByTestId('sv-input-security').selectOption('starttls');
  await full.getByTestId('sv-test').click();
  await expect(full.getByTestId('sv-test-result')).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  expect(smtp.messages).toHaveLength(0);
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  await expect.poll(async () => (await full.evaluate((p) => window.radar.getMailReplyContext!(p), DR))?.sender.ready, { timeout: 20_000 }).toBe(true);
  await full.getByTestId('settings-tab-check').click();
  await expect(full.getByTestId('setup-mailIn')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('setup-mail')).toHaveAttribute('data-tone', 'ok');
  expect(logs!.rendererErrors).toEqual([]);
});

test('환경 변수 잠금 · .env 계정 [옮기기]', async () => {
  const sb = createWikiSandbox('wiki-radar-e2e-213ui-env-');
  const envFile = sb.file('_mail-ingest/.env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, `MAILHOST_MAIL_USER=${FAKE_SMTP_USER}\nMAILHOST_MAIL_PASS=dotenv-ui-pass-552\n`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex');
  const sidebar = await start({ env: { WIKI_RADAR_SMTP_HOST: '127.0.0.1' } }, sb);

  let full = await openSettings(sidebar, 'mailOut');
  const host = full.getByTestId('sv-field-host');
  await expect(host).toHaveAttribute('data-locked', 'env');
  await expect(full.getByTestId('sv-input-host')).toBeDisabled();
  await expect(full.getByTestId('sv-source-host')).toHaveText('환경 변수 WIKI_RADAR_SMTP_HOST 로 정해짐');

  full = await openSettings(sidebar, 'mailIn');
  await expect(full.getByTestId('sv-field-user')).toHaveAttribute('data-source', 'dotenv');
  await expect(full.getByTestId('sv-secret')).toHaveAttribute('data-source', 'dotenv');
  await full.getByTestId('sv-import-dotenv').click();
  await expect(full.getByTestId('sv-field-user')).toHaveAttribute('data-source', 'user');
  await expect(full.getByTestId('sv-secret-state')).toContainText('저장됨');
  await expect(full.getByTestId('sv-dotenv')).toHaveCount(0);
  expect(crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex')).toBe(hash);
  expectNoPlaintext(sb.data, 'dotenv-ui-pass-552');
  expect(logs!.rendererErrors).toEqual([]);
});

test('AI: 칸에서 저장·연결 시험(enable_thinking:false)·틀린 키 · 용도 표 · 엔진 local → 회신 작성 칸 초안 「로컬 LLM」', async () => {
  test.setTimeout(120_000);
  const { s, model, body } = await fakeLlm({ key: LLM_KEY });
  const claudeLog = path.join(tempDir('wiki-radar-e2e-213ui-claude-'), 'claude.jsonl');
  const smtp = await startFakeSmtp();
  closers.push(() => smtp.close());
  const sidebar = await start({ env: { FAKE_CLAUDE_LOG: claudeLog }, smtp: { port: smtp.port } });
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  let full = await openSettings(sidebar, 'ai');

  await full.getByTestId('sv-input-llmUrl').fill(s.url);
  await full.getByTestId('sv-input-model').fill(model);
  await typeSecret(full, 'wrong-key-0000');
  await full.getByTestId('sv-test').click();
  const result = full.getByTestId('sv-test-result');
  await expect(result).toHaveAttribute('data-ok', 'false', { timeout: 20_000 });
  await expect(result).toContainText('키가 맞지 않습니다');
  await full.getByTestId('sv-secret-input').fill(LLM_KEY);
  await full.getByTestId('sv-test').click();
  await expect(result).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  expect(s.requests.some((q) => q.path === '/v1/chat/completions' && q.body?.chat_template_kwargs?.enable_thinking === false)).toBe(true);

  // 용도 표: 로컬 LLM 주소가 이 PC(127.0.0.1)라 「아니오」, Claude 회신 초안은 「예」
  const uses = full.getByTestId('sv-ai-uses');
  await expect(uses).toContainText('메일 분석');
  await expect(uses.getByTestId('sv-ai-draft-row')).toContainText('예 — 메일 본문·관련 위키가 Anthropic 으로');
  await full.getByTestId('sv-ai-draft-local').check();
  await expect(uses.getByTestId('sv-ai-draft-row')).toContainText('아니오');
  await expect(full.getByTestId('sv-claude-state')).toContainText('시험용 가짜');
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('sv-secret-state')).toContainText('저장됨');
  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-ai.png') });

  // 메일함 회신 → [초안 만들기] → 가짜 LLM 초안, 「로컬 LLM 초안 · 위키 참고 없음」, claude 는 불리지 않음
  await full.getByTestId('nav-mail').click();
  await expect(full.getByTestId('mailbox-view')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const row = full.getByTestId('mail-thread-row').filter({ hasText: '서식 안내' });
  await row.click();
  await full.getByTestId('btn-mail-reply').click();
  const view = full.getByTestId('mail-reply-view');
  await expect(view).toBeVisible();
  const before = s.requests.length;
  await view.getByTestId('btn-draft').click();
  await expect(view.getByTestId('draft-status')).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await expect(view.getByTestId('reply-body')).toHaveValue(body);
  await expect(view.getByTestId('reply-draft-engine')).toHaveText('로컬 LLM 초안 · 위키 참고 없음');
  const req = s.requests.slice(before).find((q) => q.path === '/v1/chat/completions');
  const system = req?.body?.messages?.find((m) => m.role === 'system')?.content ?? '';
  expect(system).not.toContain('이전 지시를 무시하고');
  expect(fs.existsSync(claudeLog)).toBe(false);
  expectNoPlaintext(sandbox!.data, LLM_KEY);
  expect(logs!.rendererErrors).toEqual([]);
});

test('AI: 주소·모델을 저장해도 [연결 시험] 전엔 [초안 만들기] 흐림 + 이유 · 점검 warn → 시험 성공 뒤 켜짐', async () => {
  test.setTimeout(120_000);
  const { s, model } = await fakeLlm({});
  const smtp = await startFakeSmtp();
  closers.push(() => smtp.close());
  const sidebar = await start({ smtp: { port: smtp.port } });
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  const full = await openSettings(sidebar, 'ai');
  await full.getByTestId('sv-input-llmUrl').fill(s.url);
  await full.getByTestId('sv-input-model').fill(model);
  await full.getByTestId('sv-ai-draft-local').check();
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  const untested = `로컬 LLM(${new URL(s.url).host})을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다`;
  await expect(full.getByTestId('sv-notes')).toContainText(untested);
  await full.getByTestId('settings-tab-check').click();
  await expect(full.getByTestId('setup-ai')).toHaveAttribute('data-tone', 'warn');
  await expect(full.getByTestId('setup-ai')).toContainText('아직 시험하지 않았습니다');
  await full.getByTestId('nav-mail').click();
  await expect(full.getByTestId('mailbox-view')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await full.getByTestId('mail-thread-row').filter({ hasText: '자재 단가 문의' }).click();
  await full.getByTestId('btn-mail-reply').click();
  const view = full.getByTestId('mail-reply-view');
  await expect(view.getByTestId('btn-draft')).toBeDisabled();
  await expect(view).toContainText(untested);
  expect(s.requests).toEqual([]);
  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-ai-untested.png') });

  // 설정 › AI 에서 [연결 시험] 성공 → 회신 칸의 버튼이 켜진다(다시 시작하지 않아도)
  await full.getByTestId('nav-setup').click();
  await full.getByTestId('settings-tab-ai').click();
  await full.getByTestId('sv-test').click();
  await expect(full.getByTestId('sv-test-result')).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  await expect(full.getByTestId('sv-notes')).toHaveCount(0);
  await full.getByTestId('settings-tab-check').click();
  await expect(full.getByTestId('setup-ai')).toHaveAttribute('data-tone', 'ok');
  await full.getByTestId('nav-mail').click();
  // 메일함으로 돌아오면 쓰던 회신 칸이 그대로 열려 있다
  await expect(full.getByTestId('mail-reply-view').getByTestId('btn-draft')).toBeEnabled({ timeout: 15_000 });
  expect(logs!.rendererErrors).toEqual([]);
});

test('AI: 엔진 local 인데 로컬 LLM 이 없으면 [초안 만들기] 흐림 + 이유', async () => {
  const smtp = await startFakeSmtp();
  closers.push(() => smtp.close());
  const sidebar = await start({ smtp: { port: smtp.port } });
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  const full = await openSettings(sidebar, 'ai');
  await full.getByTestId('sv-ai-draft-local').check();
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('sv-notes')).toContainText('설정 › AI 에서 로컬 LLM 을 넣으세요');
  await full.getByTestId('settings-tab-check').click();
  await expect(full.getByTestId('setup-ai')).toHaveAttribute('data-tone', 'off');
  await full.getByTestId('nav-mail').click();
  await expect(full.getByTestId('mailbox-view')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await full.getByTestId('mail-thread-row').filter({ hasText: '자재 단가 문의' }).click();
  await full.getByTestId('btn-mail-reply').click();
  const view = full.getByTestId('mail-reply-view');
  await expect(view.getByTestId('btn-draft')).toBeDisabled();
  await expect(view).toContainText('설정 › AI 에서 로컬 LLM 을 넣으세요');
  // 회신 칸 「보내는 사람·서명」의 [설정에서 보기] → 설정 › 메일 보내기
  await view.getByTestId('mail-settings').locator('summary').click();
  await view.getByTestId('mail-settings-open').click();
  await expect(full.getByTestId('settings-tab-mailOut')).toHaveAttribute('aria-selected', 'true');
  expect(logs!.rendererErrors).toEqual([]);
});

test('VOC 칸: 가짜 VOC 서버 — 로그인 상태 · [로그아웃] → 로그인 필요, 세션 파일 없음 · VOC 화면 [설정] → 이 칸', async () => {
  const state = tempDir('wiki-radar-e2e-213ui-voc-');
  fs.cpSync(FIXTURE_VOC, state, { recursive: true });
  const { startFakeVocServer } = await imp<{ startFakeVocServer(o: unknown): Promise<{ url: string; close(): Promise<void> }> }>('fake-voc-server.mjs');
  const server = await startFakeVocServer({ state });
  closers.push(() => server.close());
  const sidebar = await start({ env: { WIKI_RADAR_VOC_CLI: '', WIKI_RADAR_VOC_URL: server.url } });
  const login = await sidebar.evaluate(() => window.radar.vocLogin({ loginId: 'hong', password: 'secret', remember: false }));
  expect(login.ok).toBe(true);
  await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getVocBoard())).state, { timeout: 20_000 }).toBe('ok');

  const full = await openSettings(sidebar, 'voc');
  await expect(full.getByTestId('sv-voc-url')).toHaveAttribute('data-source', 'env');
  await expect(full.getByTestId('sv-voc-url')).toContainText(server.url.replace(/\/$/, ''));
  await expect(full.getByTestId('sv-voc-login-state')).toContainText('로그인됨');
  await expect(full.getByTestId('voc-settings')).toBeVisible();
  // 환경 변수로 정한 서버 주소는 입력을 잠근다(검토 반영)
  await expect(full.getByTestId('voc-settings-api-url')).toBeDisabled();
  await expect(full.getByTestId('voc-settings-api-url-env')).toContainText('WIKI_RADAR_VOC_URL');
  await full.getByTestId('voc-settings').getByTestId('sv-test').click();
  await expect(full.getByTestId('sv-test-result')).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
  await expect(full.getByTestId('sv-test-result')).toContainText('연결됨');
  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-voc.png') });

  await full.getByTestId('sv-voc-logout').click();
  await expect(full.getByTestId('sv-voc-login-state')).toHaveText('로그인 필요', { timeout: 20_000 });
  expect(fs.existsSync(path.join(sandbox!.data, 'voc-session.bin'))).toBe(false);
  await expect(full.getByTestId('sv-voc-login')).toBeVisible();

  // VOC 화면 [설정] → 설정 › VOC
  await full.getByTestId('nav-voc').click();
  await full.getByTestId('btn-voc-settings').click();
  await expect(full.getByTestId('settings-tab-voc')).toHaveAttribute('aria-selected', 'true');
  expect(logs!.rendererErrors).toEqual([]);
});

test('위키 칸: 「없음」 저장 → 다시 시작 안내 · 연결 시험', async () => {
  const sb = createWikiSandbox('wiki-radar-e2e-213ui-none-');
  const wikiBefore = treeDigest(sb.wiki);
  const sidebar = await start({ wikiVia: 'settings' }, sb);
  const full = await openSettings(sidebar, 'wiki');
  await expect(full.getByTestId('sv-wiki-mode')).toHaveAttribute('data-mode', 'folder');
  await full.getByTestId('sv-test').click();
  await expect(full.getByTestId('sv-test-result')).toContainText('개인 위키', { timeout: 15_000 });
  await full.getByTestId('sv-wiki-mode-none').check();
  await expect(full.getByTestId('sv-field-wikiRoot')).toHaveCount(0);
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-wiki-restart')).toBeVisible();
  await expect(full.getByTestId('sv-wiki-restart')).toContainText('개인 위키 없음');
  await full.getByTestId('settings-tab-check').click();
  await expect(full.getByTestId('setup-wiki')).toHaveAttribute('data-tone', 'warn');
  // 「없음」을 새 폴더 경로처럼 보이지 않는다
  await expect(full.getByTestId('setup-wiki')).toContainText('개인 위키를 쓰지 않도록 바꿨습니다');
  await expect(full.getByTestId('setup-wiki')).not.toContainText('((없음))');
  expect(treeDigest(sb.wiki)).toEqual(wikiBefore);
  expect(logs!.rendererErrors).toEqual([]);
});

test('정보 칸: 버전·업데이트(설치본에서만)·진단 복사(비밀 없음) · 내보내기 → 다른 데이터 폴더로 가져오기', async () => {
  const sidebar = await start({ settings: { me: { name: '홍길동', aliases: [] } } });
  await sidebar.evaluate(
    ({ user, pass }) => window.radar.saveSettings!('mailIn', { host: '127.0.0.1', port: 1100, ssl: false, user, secret: { key: 'mailIn.pass', action: 'set', value: pass } }),
    { user: FAKE_SMTP_USER, pass: POP3_PASS },
  );
  let full = await openSettings(sidebar, 'info');
  await expect(full.getByTestId('sv-info-version')).toContainText(/Radar \d+\.\d+\.\d+/);
  await expect(full.getByTestId('sv-update-check')).toBeDisabled();
  await expect(full.getByTestId('sv-update-note')).toHaveText('설치본에서만');
  await expect(full.getByTestId('sv-team-file')).toContainText('.radar/team-settings.json');

  // 업데이트 서버 off 저장(이 칸만 [저장])
  await full.getByTestId('sv-input-updateUrl').fill('off');
  await full.getByTestId('sv-save').click();
  await expect(full.getByTestId('sv-status')).toHaveAttribute('data-tone', 'ok');
  await expect(full.getByTestId('sv-field-updateUrl')).toHaveAttribute('data-source', 'user');

  // 진단 정보 복사 — 클립보드 글에 비밀번호 없음
  await full.getByTestId('sv-diagnostics').click();
  await expect(full.getByTestId('sv-info-line')).toContainText('복사했습니다');
  const clip = await full.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  const diag = clip ?? (await full.evaluate(() => window.radar.getDiagnostics!()));
  expect(diag).toContain('mailIn.pass: 저장됨');
  expect(diag).not.toContain(POP3_PASS);

  // [로그 폴더 열기] — 시험 모드는 열지 않고 기록만
  await full.getByTestId('sv-open-logs').click();
  await expect.poll(() => fs.existsSync(path.join(sandbox!.data, 'open-log.jsonl'))).toBe(true);

  // 내보내기(대화상자 대신 시험 훅의 경로)
  const exportPath = path.join(tempDir('wiki-radar-e2e-213ui-export-'), 'wiki-radar-settings.json');
  await radarTest(app!, 'dialogPath', exportPath);
  await full.getByTestId('sv-export').click();
  await expect(full.getByTestId('sv-info-line')).toContainText('내보냈습니다');
  const text = fs.readFileSync(exportPath, 'utf8');
  expect(text).not.toContain(POP3_PASS);
  for (const bad of ['loginId', 'myId', 'wikiRoot', 'setupSeen']) expect(text).not.toContain(bad);
  await settle(full);
  await full.screenshot({ path: path.join(RESULTS_DIR, 'stage213-info.png') });
  await closeApp(app!);
  app = null;
  sandbox?.dispose();
  sandbox = null;

  // 다른 데이터 폴더: [설정 가져오기] → 미리보기 → [가져오기] → 바로 적용, 비밀은 없음
  const sb2 = await start();
  full = await openSettings(sb2, 'info');
  await radarTest(app!, 'dialogPath', exportPath);
  await full.getByTestId('sv-import').click();
  const preview = full.getByTestId('sv-import-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-testid="sv-import-section"][data-key="mailIn"]')).toBeChecked();
  await full.getByTestId('sv-import-apply').click();
  await expect(full.getByTestId('sv-info-line')).toContainText('가져왔습니다');
  await expect(full.getByTestId('sv-input-updateUrl')).toHaveValue('off');
  await full.getByTestId('settings-tab-mailIn').click();
  await expect(full.getByTestId('sv-input-host')).toHaveValue('127.0.0.1');
  await expect(full.getByTestId('sv-field-host')).toHaveAttribute('data-source', 'user');
  await expect(full.getByTestId('sv-secret')).toHaveAttribute('data-saved', 'false');
  expect(logs!.rendererErrors).toEqual([]);
});
