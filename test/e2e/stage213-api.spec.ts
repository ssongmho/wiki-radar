// 2.13단계 main 쪽(저장 구조·비밀·우선순위·팀 기본값·연결 시험·새 저장으로 발송·로컬 LLM 초안·정보 칸) 연결 시험 —
// 화면 없이 window.radar 로 설정 채널을 부른다(docs/stage2.13-contract.md §F). 화면 시나리오(stage213.spec.ts)는 칸 화면을 만든 뒤.
// 가짜 서버는 모두 127.0.0.1: 가짜 POP3(test/fixtures/fake-pop3-server.mjs)·가짜 SMTP·가짜 LLM(fake-llm-server.mjs)·가짜 VOC 서버.
// 실제 위키·NAS·메일·VOC·LLM 서버는 부르지 않는다. 먼저 `npm run package`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { SettingsSectionView } from '../../src/shared/types';
import {
  FAKE_SMTP_PASS,
  FAKE_SMTP_USER,
  FIXTURE_VOC,
  FIXTURE_WIKI,
  PROJECT_ROOT,
  closeApp,
  createWikiSandbox,
  launchApp,
  radarTest,
  startFakeSmtp,
  treeDigest,
  watchLogs,
  windowByMode,
  type AppLogs,
  type FakeSmtp,
  type LaunchOptions,
  type WikiSandbox,
} from './app';

const NOW = '2026-09-23T10:00';
const DR = 'raw/mail/대륙물산/2026/2026-09-21_1100_박담당_자재 단가 문의_d1d2d3.md';
const HTML = 'raw/mail/_미분류/2026/2026-09-22_0815_알림_서식 안내_e1e2e3.md';
const POP3_PASS = 'pop3-e2e-secret-71';
const LLM_KEY = 'llm-e2e-key-5521';

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
  sandbox = keep ?? createWikiSandbox('wiki-radar-e2e-213-');
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW, ...opts });
  logs = watchLogs(app);
  return windowByMode(app, 'sidebar');
}

async function fakePop3(opts: Record<string, unknown> = {}): Promise<FakePop3> {
  const { startFakePop3 } = await imp<{ startFakePop3(o: unknown): Promise<FakePop3> }>('fake-pop3-server.mjs');
  const s = await startFakePop3({ user: FAKE_SMTP_USER, pass: POP3_PASS, ...opts });
  closers.push(() => s.close());
  return s;
}

async function fakeLlm(opts: Record<string, unknown> = {}): Promise<{ s: FakeLlm; model: string; body: string }> {
  const m = await imp<{ startFakeLlm(o: unknown): Promise<FakeLlm>; FAKE_LLM_MODEL: string; FAKE_LLM_DRAFT_BODY: string }>('fake-llm-server.mjs');
  const s = await m.startFakeLlm(opts);
  closers.push(() => s.close());
  return { s, model: m.FAKE_LLM_MODEL, body: m.FAKE_LLM_DRAFT_BODY };
}

async function smtpServer(): Promise<FakeSmtp> {
  const s = await startFakeSmtp();
  closers.push(() => s.close());
  return s;
}

/** 데이터 폴더(로그 포함)의 모든 파일 글에 needle 이 없다(secrets.bin 은 암호화돼 있어야 한다) */
function expectNoPlaintext(dir: string, needle: string): void {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) {
    const bytes = fs.readFileSync(f);
    expect(bytes.includes(Buffer.from(needle, 'utf8')), `평문 비밀이 ${path.relative(dir, f)} 에 있음`).toBe(false);
  }
}

test('팀 기본값: 칸에 team 출처 · ai 는 버리고 문제로 · 비밀이 든 팀 파일은 쓰지 않고 점검 warn', async () => {
  let page = await start({ teamSettings: { version: 1, mailIn: { host: '127.0.0.1', port: 1100, ssl: false }, mailOut: { host: '127.0.0.1', port: 2525, security: 'starttls' }, ai: { llmUrl: 'http://127.0.0.1:9/v1', model: 'team-model' } } });
  await expect.poll(async () => (await page.evaluate(() => window.radar.getTeamDefaults!({ refresh: true }))).source, { timeout: 15_000 }).toBe('env');
  const mailIn: SettingsSectionView = await page.evaluate(() => window.radar.getSettings!('mailIn'));
  expect(mailIn.fields.host).toMatchObject({ value: '127.0.0.1', source: 'team' });
  expect(mailIn.team.source).toBe('env');
  // AI 는 팀 기본값으로 받지 않는다(소유자 결정 2026-10-19) — 칸은 비고 팀 파일 문제로 남는다
  const ai = await page.evaluate(() => window.radar.getSettings!('ai'));
  expect(ai.fields.model).toMatchObject({ source: 'none' });
  expect(ai.fields.llmUrl).toMatchObject({ source: 'none' });
  expect(ai.fields.llmUrl.teamValue).toBeUndefined();
  expect(ai.llmOutside).toBeUndefined();
  expect(ai.team.problems.join(' ')).toContain('AI 는 팀 기본값으로 정하지 않습니다');
  const setup = await page.evaluate(() => window.radar.getSetup());
  expect(setup.team?.state).toBe('warn');
  expect(setup.team?.text).toContain('AI 는 팀 기본값으로 정하지 않습니다');
  expect(setup.mailIn?.state).toBe('warn');
  await closeApp(app!);
  app = null;
  sandbox?.dispose();
  sandbox = null;

  page = await start({ teamSettings: { version: 1, mailIn: { host: '127.0.0.1', password: 'nope-123456' } } });
  await expect.poll(async () => (await page.evaluate(() => window.radar.getSetup())).team?.state, { timeout: 15_000 }).toBe('warn');
  expect((await page.evaluate(() => window.radar.getSettings!('mailIn'))).fields.host.source).toBe('none');
});

test('메일 받기: 연결 시험(초안) · 틀린 비밀번호 · 저장 → 비밀 칸 저장됨, 평문 파일 없음, DELE 없음', async () => {
  const pop = await fakePop3();
  const page = await start();
  const draft = { host: '127.0.0.1', port: pop.port, ssl: false, user: FAKE_SMTP_USER, secret: { key: 'mailIn.pass', action: 'set', value: POP3_PASS } };
  const ok = await page.evaluate((d) => window.radar.testSettings!('mailIn', d as never), draft);
  expect(ok.ok).toBe(true);
  expect(ok.steps.map((s) => s.label)).toEqual(['연결', '보안', '로그인', '메일함']);
  expect(ok.steps[3].detail).toBe('3통');
  const bad = await page.evaluate((d) => window.radar.testSettings!('mailIn', { ...d, secret: { key: 'mailIn.pass', action: 'set', value: 'wrong-e2e-pass-9' } } as never), draft);
  expect(bad.ok).toBe(false);
  expect(bad.steps.find((s) => s.label === '로그인')?.detail).toMatch(/로그인 실패/);
  expect(JSON.stringify(bad)).not.toContain('wrong-e2e-pass-9');
  expect(pop.commands.some((c) => /^(DELE|RSET)/i.test(c))).toBe(false);

  const saved = await page.evaluate((d) => window.radar.saveSettings!('mailIn', d as never), draft);
  expect(saved.ignored).toEqual([]);
  expect(saved.view.secrets['mailIn.pass']).toMatchObject({ saved: true, source: 'user' });
  expect(['file', 'memory']).toContain(saved.secretStorage);
  expect(JSON.stringify(saved)).not.toContain(POP3_PASS);
  if (saved.secretStorage === 'file') expect(fs.existsSync(path.join(sandbox!.data, 'secrets.bin'))).toBe(true);
  // 진단 정보에도 비밀번호가 없다
  const diag = await page.evaluate(() => window.radar.getDiagnostics!());
  expect(diag).toContain('mailIn.pass: 저장됨');
  expect(diag).not.toContain(POP3_PASS);
  // 저장 뒤 시험(비밀 칸 비움 → 저장된 비밀)
  const again = await page.evaluate(() => window.radar.testSettings!('mailIn', {}));
  expect(again.ok).toBe(true);
  expect((await page.evaluate(() => window.radar.getSetup())).mailIn?.state).toBe('ok');
  expectNoPlaintext(sandbox!.data, POP3_PASS);
});

test('메일 보내기 = 새 저장으로 발송(SMTP 환경 변수 없이, 다시 시작 없음)', async () => {
  const smtp = await smtpServer();
  const page = await start();
  await expect.poll(async () => (await page.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  const before = await page.evaluate((p) => window.radar.getMailReplyContext!(p), DR);
  expect(before?.sender.ready).toBe(false);
  await page.evaluate(
    ({ user, pass }) => window.radar.saveSettings!('mailIn', { user, secret: { key: 'mailIn.pass', action: 'set', value: pass } }),
    { user: FAKE_SMTP_USER, pass: FAKE_SMTP_PASS },
  );
  await page.evaluate((port) => window.radar.saveSettings!('mailOut', { sameAccount: true, host: '127.0.0.1', port, security: 'starttls' }), smtp.port);
  const view = await page.evaluate(() => window.radar.getSettings!('mailOut'));
  expect(view.sameAccountUser).toBe(FAKE_SMTP_USER);
  const verify = await page.evaluate(() => window.radar.testSettings!('mailOut', {}));
  expect(verify.ok).toBe(true);
  expect(smtp.messages).toHaveLength(0);
  const ctx = await page.evaluate((p) => window.radar.getMailReplyContext!(p), DR);
  expect(ctx?.sender).toMatchObject({ ready: true, address: FAKE_SMTP_USER });
  const out = await page.evaluate(
    ({ p, to, subject, id }) => window.radar.sendMailReply!({ sendId: id, path: p, to, cc: [], subject, body: '안녕하세요.\n확인했습니다.\n\n감사합니다.', quoteOriginal: false, archiveAfter: false }),
    { p: DR, to: ctx!.to, subject: ctx!.subject, id: crypto.randomUUID() },
  );
  expect(out.sent.mail).toBe(DR);
  expect(smtp.messages).toHaveLength(1);
  expect(smtp.auths.at(-1)).toEqual({ user: FAKE_SMTP_USER, ok: true });
});

test('환경 변수 잠금: WIKI_RADAR_SMTP_HOST 로 정한 서버 칸은 env 출처, 저장은 ignored', async () => {
  const page = await start({ env: { WIKI_RADAR_SMTP_HOST: '127.0.0.1' } });
  const v = await page.evaluate(() => window.radar.getSettings!('mailOut'));
  expect(v.fields.host).toMatchObject({ source: 'env', envName: 'WIKI_RADAR_SMTP_HOST', value: '127.0.0.1' });
  const r = await page.evaluate(() => window.radar.saveSettings!('mailOut', { host: 'smtp.example.com', port: 2526 }));
  expect(r.ignored).toEqual(['host']);
  expect(r.view.fields.port).toMatchObject({ value: 2526, source: 'user' });
  await expect(page.evaluate(() => window.radar.saveSettings!('mailOut', { nope: 1 } as never))).rejects.toThrow(/잘못된 요청/);
});

test('.env 예비·옮기기: 출처 .env → [옮기기] 뒤 user, .env 내용은 그대로', async () => {
  const sb = createWikiSandbox('wiki-radar-e2e-213-env-');
  const envFile = sb.file('_mail-ingest/.env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, `MAILHOST_MAIL_USER=${FAKE_SMTP_USER}\nMAILHOST_MAIL_PASS=dotenv-pass-881\n`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex');
  const page = await start({}, sb);
  const v = await page.evaluate(() => window.radar.getSettings!('mailIn'));
  expect(v.fields.user).toMatchObject({ source: 'dotenv', value: FAKE_SMTP_USER });
  expect(v.dotenv?.available).toBe(true);
  const after = await page.evaluate(() => window.radar.importDotEnvAccount!());
  expect(after.fields.user.source).toBe('user');
  expect(after.secrets['mailIn.pass']).toMatchObject({ saved: true, source: 'user' });
  expect(crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex')).toBe(hash);
  expectNoPlaintext(sb.data, 'dotenv-pass-881');
});

test('AI: 저장·연결 시험(enable_thinking:false)·틀린 키 · 회신 초안 엔진 local → 가짜 LLM 초안, Claude 는 부르지 않음', async () => {
  const { s, model, body } = await fakeLlm({ key: LLM_KEY });
  const claudeLog = path.join(tempDir('wiki-radar-e2e-213-claude-'), 'claude.jsonl');
  const page = await start({ env: { FAKE_CLAUDE_LOG: claudeLog } });
  await expect.poll(async () => (await page.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  const r = await page.evaluate(
    ({ url, model, key }) => window.radar.saveSettings!('ai', { llmUrl: url, model, secret: { key: 'ai.llmKey', action: 'set', value: key } }),
    { url: s.url, model, key: LLM_KEY },
  );
  expect(r.view.secrets['ai.llmKey']?.saved).toBe(true);
  // [연결 시험] 전엔 키가 있어도 쓰지 않는다 — 점검 warn, 로컬 엔진 초안은 그 이유로 거부(Claude 로 넘어가지 않음)
  expect(r.view.llmProblem).toMatch(/아직 시험하지 않았습니다/);
  expect((await page.evaluate(() => window.radar.getSetup())).ai?.text).toMatch(/아직 시험하지 않았습니다/);
  await page.evaluate(() => window.radar.saveSettings!('ai', { draftEngine: 'local' }));
  await expect(page.evaluate((p) => window.radar.draftMailReply!({ path: p, note: '' }), HTML)).rejects.toThrow(/아직 시험하지 않았습니다 — 설정 › AI 에서 \[연결 시험\]/);
  expect(s.requests).toEqual([]);
  expect(fs.existsSync(claudeLog)).toBe(false);
  const t = await page.evaluate(() => window.radar.testSettings!('ai', {}));
  expect(t.ok).toBe(true);
  expect(s.requests.some((q) => q.path === '/v1/chat/completions' && q.body?.chat_template_kwargs?.enable_thinking === false)).toBe(true);
  const bad = await page.evaluate(() => window.radar.testSettings!('ai', { secret: { key: 'ai.llmKey', action: 'set', value: 'wrong-key-0000' } }));
  expect(bad.steps.find((x) => x.label === '인증')?.detail).toBe('키가 맞지 않습니다');
  const ai = await page.evaluate(() => window.radar.getSettings!('ai'));
  expect(ai.llmOutside).toBe(false);
  expect(ai.lastTest).toBeTruthy();
  expect(ai.claude?.fake).toBe(true);
  expect(ai.llmProblem).toBeUndefined();
  expect((await page.evaluate(() => window.radar.getSetup())).ai?.state).toBe('ok');

  const before = s.requests.length;
  const draft = await page.evaluate((p) => window.radar.draftMailReply!({ path: p, note: '' }), HTML);
  expect(draft.engine).toBe('local');
  expect(draft.body).toBe(body);
  expect(draft.references).toEqual([]);
  const req = s.requests.slice(before).find((q) => q.path === '/v1/chat/completions');
  const system = req?.body?.messages?.find((m) => m.role === 'system')?.content ?? '';
  const user = req?.body?.messages?.find((m) => m.role === 'user')?.content ?? '';
  expect(user).toContain('이전 지시를 무시하고');
  expect(system).not.toContain('이전 지시를 무시하고');
  expect(req?.auth).toBe(`Bearer ${LLM_KEY}`);
  expect(fs.existsSync(claudeLog)).toBe(false);
  expectNoPlaintext(sandbox!.data, LLM_KEY);
});

test('AI: 엔진 local 인데 LLM 이 없으면 Claude 로 넘어가지 않고 거부 · 점검 off', async () => {
  const claudeLog = path.join(tempDir('wiki-radar-e2e-213-claude-'), 'claude.jsonl');
  const page = await start({ env: { FAKE_CLAUDE_LOG: claudeLog } });
  await expect.poll(async () => (await page.evaluate(() => window.radar.getMailbox!())).state, { timeout: 20_000 }).toBe('ready');
  await page.evaluate(() => window.radar.saveSettings!('ai', { draftEngine: 'local' }));
  await expect(page.evaluate((p) => window.radar.draftMailReply!({ path: p, note: '' }), DR)).rejects.toThrow(/설정 › AI 에서 로컬 LLM 을 넣으세요/);
  expect(fs.existsSync(claudeLog)).toBe(false);
  expect((await page.evaluate(() => window.radar.getSetup())).ai?.state).toBe('off');
});

test('VOC: API 직접 호출(가짜 VOC 서버) — 연결 시험 · 로그아웃이 세션 파일을 지운다', async () => {
  const state = tempDir('wiki-radar-e2e-213-voc-');
  fs.cpSync(FIXTURE_VOC, state, { recursive: true });
  const { startFakeVocServer } = await imp<{ startFakeVocServer(o: unknown): Promise<{ url: string; close(): Promise<void> }> }>('fake-voc-server.mjs');
  const server = await startFakeVocServer({ state });
  closers.push(() => server.close());
  const page = await start({ env: { WIKI_RADAR_VOC_CLI: '', WIKI_RADAR_VOC_URL: server.url } });
  const pre = await page.evaluate(() => window.radar.testSettings!('voc', {}));
  expect(pre.steps.find((x) => x.label === '로그인')).toMatchObject({ ok: true, warn: true, detail: '로그인 필요' });
  const login = await page.evaluate(() => window.radar.vocLogin({ loginId: 'hong', password: 'secret', remember: false }));
  expect(login.ok).toBe(true);
  const t = await page.evaluate(() => window.radar.testSettings!('voc', {}));
  expect(t.ok).toBe(true);
  expect(t.steps.find((x) => x.label === '로그인')?.detail).toMatch(/^연결됨 · /);
  await page.evaluate(() => window.radar.vocLogout!());
  expect(fs.existsSync(path.join(sandbox!.data, 'voc-session.bin'))).toBe(false);
  const after = await page.evaluate(() => window.radar.testSettings!('voc', {}));
  expect(after.steps.find((x) => x.label === '로그인')?.detail).toBe('로그인 필요');
  // 주소를 환경 변수로 정했으면 다른 주소는 시험하지 않는다(쓰지 않을 주소 — 검토 반영). 이 PC 밖 주소도 부르지 않는다
  const outside = await page.evaluate(() => window.radar.testSettings!('voc', { apiUrl: 'https://voc.example.com:11300' }));
  expect(outside.ok).toBe(false);
  expect(outside.steps[0].detail).toMatch(/환경 변수 WIKI_RADAR_VOC_URL/);
});

test('위키 「없음」: 저장 → 다시 시작 안내 → 다시 띄우면 source none, 위키 쓰기 거부', async () => {
  const sb = createWikiSandbox('wiki-radar-e2e-213-none-');
  const wikiBefore = treeDigest(sb.wiki);
  let page = await start({ wikiVia: 'settings' }, sb);
  const w = await page.evaluate(() => window.radar.getSettings!('wiki'));
  expect(w.fields.wikiMode).toMatchObject({ value: 'folder', source: 'user' });
  const t = await page.evaluate(() => window.radar.testSettings!('wiki', {}));
  expect(t.steps[0]).toMatchObject({ label: '개인 위키', ok: true });
  const r = await page.evaluate(() => window.radar.saveSettings!('wiki', { wikiMode: 'none' }));
  expect(r.restartNeeded).toBe(true);
  expect(r.view.restartPending).toBe('(없음)');
  await closeApp(app!);
  app = null;
  page = await start({ wikiVia: 'settings' }, sb);
  sandbox = sb;
  const setup = await page.evaluate(() => window.radar.getSetup());
  expect(setup.wiki.source).toBe('none');
  expect(setup.wiki.ok).toBe(false);
  await expect(page.evaluate(() => window.radar.createMailTask!({ path: 'raw/mail/x.md', title: 't' }))).rejects.toThrow(/개인 위키를 쓰지 않도록/);
  await expect(page.evaluate(() => window.radar.runReflect())).rejects.toThrow(/개인 위키를 쓰지 않도록/);
  // 「폴더」로 돌리면 남겨 둔 경로
  const back = await page.evaluate(() => window.radar.saveSettings!('wiki', { wikiMode: 'folder' }));
  expect(back.restartNeeded).toBe(true);
  expect(treeDigest(sb.wiki)).toEqual(wikiBefore);
});

test('정보: 버전·업데이트(시험 중)·진단·폴더 열기 기록 · 내보내기(비밀·loginId 없음) → 다른 데이터 폴더로 가져오기', async () => {
  const pop = await fakePop3();
  let page = await start({ settings: { me: { name: '홍길동', aliases: [] } } });
  const info = await page.evaluate(() => window.radar.getAppInfo!());
  expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(info.testMode).toBe(true);
  expect(info.teamDefaultsFile).toBe('.radar/team-settings.json');
  const upd = await page.evaluate(() => window.radar.checkForUpdate!());
  expect(upd.state).toBe('unavailable');
  expect(upd.message).toMatch(/시험 중/);
  await page.evaluate(() => window.radar.openAppFolder!('logs'));
  const openLog = fs.readFileSync(path.join(sandbox!.data, 'open-log.jsonl'), 'utf8');
  expect(openLog).toContain('"kind":"folder"');
  // 로그 파일이 생긴다(비밀은 가린다)
  expect(fs.readdirSync(path.join(sandbox!.data, 'logs')).some((n) => /^radar-\d{4}-\d{2}-\d{2}\.log$/.test(n))).toBe(true);

  await page.evaluate(
    ({ port, pass }) =>
      window.radar.saveSettings!('mailIn', { host: '127.0.0.1', port, ssl: false, user: 'radar@example.com', secret: { key: 'mailIn.pass', action: 'set', value: pass } }),
    { port: pop.port, pass: POP3_PASS },
  );
  await page.evaluate(() => window.radar.saveSettings!('info', { updateUrl: 'off' }));
  await page.evaluate(() => window.radar.saveMailSettings({ fromName: '홍길동', signature: '서명 줄', bccSelf: false }));
  const exportPath = path.join(tempDir('wiki-radar-e2e-213-export-'), 'wiki-radar-settings.json');
  await radarTest(app!, 'dialogPath', exportPath);
  const ex = await page.evaluate(() => window.radar.exportSettings!());
  expect(ex).toEqual({ saved: true, path: exportPath });
  const text = fs.readFileSync(exportPath, 'utf8');
  expect(text).not.toContain(POP3_PASS);
  for (const bad of ['loginId', 'myId', 'wikiRoot', 'setupSeen']) expect(text).not.toContain(bad);
  expect(JSON.parse(text)).toMatchObject({ kind: 'wiki-radar-settings', app: { mailIn: { host: '127.0.0.1', user: 'radar@example.com' }, update: { url: 'off' } }, mail: { fromName: '홍길동' } });
  await closeApp(app!);
  app = null;
  sandbox?.dispose();
  sandbox = null;

  // 다른 데이터 폴더로 가져오기
  page = await start();
  await radarTest(app!, 'dialogPath', exportPath);
  const preview = await page.evaluate(() => window.radar.previewSettingsImport!());
  expect(preview?.token).toMatch(/^imp_/);
  const keys = preview!.sections.map((s) => s.key);
  expect(keys).toEqual(expect.arrayContaining(['me', 'mailIn', 'update', 'mail']));
  expect(preview!.sections.find((s) => s.key === 'mailIn')?.changes).toBeGreaterThan(0);
  const applied = await page.evaluate((tok) => window.radar.applySettingsImport!(tok, ['mailIn', 'update', 'mail', 'me']), preview!.token);
  expect(applied.applied).toEqual(expect.arrayContaining(['mailIn', 'update', 'mail', 'me']));
  const v = await page.evaluate(() => window.radar.getSettings!('mailIn'));
  expect(v.fields.host).toMatchObject({ value: '127.0.0.1', source: 'user' });
  // 비밀은 가져오지 않는다
  expect(v.secrets['mailIn.pass']?.saved).toBe(false);
  expect((await page.evaluate(() => window.radar.getSettings!('info'))).fields.updateUrl).toMatchObject({ value: 'off', source: 'user' });
  expect((await page.evaluate(() => window.radar.getMailSettings())).fromName).toBe('홍길동');
  await expect(page.evaluate((tok) => window.radar.applySettingsImport!(tok, ['me']), preview!.token)).rejects.toThrow(/만료/);
});
