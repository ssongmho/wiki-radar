// 2.13단계 설정 칸 main 쪽(SettingsService) — 저장·잠금(ignored)·비밀이 응답에 없음·.env 옮기기·연결 시험(가짜 POP3·LLM)·위키 「없음」·점검 줄.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppSettingsStore, resolveWikiRoot } from '../../src/main/appSettings';
import { MailSettingsStore } from '../../src/main/mail/stores';
import { SecretStore, type SecretCodec } from '../../src/main/settings/secrets';
import { TeamDefaultsHolder } from '../../src/main/settings/teamDefaults';
import { SettingsService, requireSettingsPatch } from '../../src/main/settings/service';
import { requireTestDraft } from '../../src/main/ipc';
// @ts-expect-error — 시험용 .mjs(타입 없음)
import { startFakePop3 } from '../fixtures/fake-pop3-server.mjs';
// @ts-expect-error — 시험용 .mjs(타입 없음)
import { FAKE_LLM_MODEL, startFakeLlm } from '../fixtures/fake-llm-server.mjs';
import { FEATURES } from '../../src/shared/edition';

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-settings-svc-'));
  dirs.push(d);
  return d;
}

const codec: SecretCodec = {
  encrypt: (t) => Buffer.from(Buffer.from(t, 'utf8').map((b) => b ^ 0x33)),
  decrypt: (d) => Buffer.from(d.map((b) => b ^ 0x33)).toString('utf8'),
};

function setup(o: { env?: NodeJS.ProcessEnv; dotenv?: string; teamFile?: unknown } = {}) {
  const root = tempDir();
  const data = path.join(root, 'data');
  const wiki = path.join(root, 'wiki');
  fs.mkdirSync(path.join(wiki, 'wiki'), { recursive: true });
  if (o.dotenv) {
    fs.mkdirSync(path.join(wiki, '_mail-ingest'), { recursive: true });
    fs.writeFileSync(path.join(wiki, '_mail-ingest', '.env'), o.dotenv);
  }
  const env: NodeJS.ProcessEnv = { VITEST: 'true', ...(o.env ?? {}) };
  if (o.teamFile) {
    const f = path.join(root, 'team.json');
    fs.writeFileSync(f, JSON.stringify(o.teamFile));
    env.WIKI_RADAR_TEAM_SETTINGS = f;
  }
  const appSettings = new AppSettingsStore(data);
  appSettings.update({ wikiRoot: wiki });
  const secrets = new SecretStore(data, codec);
  const team = new TeamDefaultsHolder(() => ({
    env,
    teamSync: { enabled: false, remote: path.join(root, 'nas'), local: path.join(root, 'local'), configured: false },
    defaultRemote: path.join(root, 'nas'),
    cacheFile: path.join(data, 'team-defaults-cache.json'),
    now: () => new Date(2026, 9, 19, 9, 0, 0),
    testMode: true,
  }));
  let pending: string | undefined;
  const changed: string[] = [];
  let teamSet: unknown = null;
  const location = resolveWikiRoot(env, appSettings.get(), wiki, data);
  const svc = new SettingsService({
    env,
    dataDir: data,
    appSettings,
    secrets,
    team,
    mailSettings: () => new MailSettingsStore(data),
    wiki: { location, defaultRoot: wiki, pending: () => pending, setPending: (p) => (pending = p) },
    teamSync: {
      config: () => ({ enabled: false, remote: path.join(root, 'nas'), local: path.join(root, 'local') }),
      configured: () => false,
      set: (input) => {
        teamSet = input;
      },
    },
    today: () => '2026-10-19',
    now: () => new Date(2026, 9, 19, 9, 0, 0),
    testMode: true,
    builtinUpdateUrl: 'http://builtin.example/',
    onChanged: (s) => changed.push(s),
  });
  return { root, data, wiki, env, svc, appSettings, secrets, team, changed, pending: () => pending, teamSet: () => teamSet };
}

const PASS = 'pop3-secret-1';

describe('저장·보기', () => {
  it('바뀐 필드만 저장, null 은 내 값을 지움, 비밀은 응답에 없다', () => {
    const t = setup();
    const r = t.svc.save('mailIn', requireSettingsPatch('mailIn', { host: '127.0.0.1', port: 1100, ssl: false, user: 'radar@example.com', secret: { key: 'mailIn.pass', action: 'set', value: PASS } }));
    expect(r.ignored).toEqual([]);
    expect(r.secretStorage).toBe('file');
    expect(r.view.fields.host).toMatchObject({ value: '127.0.0.1', source: 'user' });
    expect(r.view.secrets['mailIn.pass']).toMatchObject({ saved: true, source: 'user', storage: 'file' });
    expect(JSON.stringify(r)).not.toContain(PASS);
    expect(fs.readFileSync(path.join(t.data, 'app-settings.json'), 'utf8')).not.toContain(PASS);
    expect(t.changed).toContain('mailIn');
    const r2 = t.svc.save('mailIn', { port: null });
    expect(r2.view.fields.port).toMatchObject({ value: 110, source: 'builtin' });
  });

  it('환경 변수로 잠긴 필드는 무시하고 ignored 로 알린다(다른 필드는 저장)', () => {
    const t = setup({ env: { WIKI_RADAR_SMTP_HOST: '127.0.0.1', WIKI_RADAR_SMTP_USER: 'e@x.y', WIKI_RADAR_SMTP_PASS: 'env-pass-12' } });
    const r = t.svc.save('mailOut', { host: 'smtp.example.com', port: 2525, user: 'u@x.y', secret: { key: 'mailOut.pass', action: 'set', value: 'xx-pass-12' } });
    expect(r.ignored).toEqual(expect.arrayContaining(['host', 'user', 'secret']));
    expect(r.view.fields.host).toMatchObject({ source: 'env', envName: 'WIKI_RADAR_SMTP_HOST' });
    expect(r.view.fields.port).toMatchObject({ value: 2525, source: 'user' });
    expect(t.secrets.has('mailOut.pass')).toBe(false);
  });

  it('검사에 걸리면 아무것도 쓰지 않는다 · 모르는 필드는 IPC 검사에서 거부', () => {
    const t = setup();
    expect(() => t.svc.save('mailIn', { host: 'bad host', port: 995 })).toThrow(/서버 이름/);
    expect(t.appSettings.get().mailIn).toBeUndefined();
    expect(() => requireSettingsPatch('mailIn', { nope: 1 })).toThrow(/잘못된 요청/);
    expect(() => requireSettingsPatch('mailIn', { host: { deep: 1 } })).toThrow(/잘못된 요청/);
    expect(() => requireSettingsPatch('ai', { secret: { key: 'mailIn.pass', action: 'set', value: 'x' } })).toThrow(/secret/);
    expect(() => requireTestDraft('voc', { apiUrl: 'https://x', other: 1 })).toThrow(/잘못된 요청/);
  });

  it('메일 보내기 칸의 보내는 이름·서명은 mail-settings.json 에', () => {
    const t = setup();
    t.svc.save('mailOut', { fromName: '홍길동', signature: '서명' });
    const mail = JSON.parse(fs.readFileSync(path.join(t.data, 'mail-settings.json'), 'utf8'));
    expect(mail).toMatchObject({ fromName: '홍길동', signature: '서명', bccSelf: true });
    expect(t.appSettings.get().mailOut).toBeUndefined();
  });

  it('정보 칸: 업데이트 서버 off', () => {
    const t = setup();
    expect(t.svc.view('info').fields.updateUrl).toMatchObject({ value: 'http://builtin.example/', source: 'builtin' });
    t.svc.save('info', { updateUrl: 'off' });
    expect(t.svc.updateUrl()).toMatchObject({ value: 'off', source: 'user' });
  });
});

describe('.env 예비·옮기기', () => {
  it('출처 dotenv → 옮기면 user, .env 는 그대로', () => {
    const DOT = 'MAILHOST_MAIL_USER=dot@example.com\nMAILHOST_MAIL_PASS=dot-pass-1234\n';
    const t = setup({ dotenv: DOT });
    const before = t.svc.view('mailIn');
    expect(before.fields.user).toMatchObject({ value: 'dot@example.com', source: 'dotenv' });
    expect(before.dotenv).toEqual({ available: true, file: '_mail-ingest/.env' });
    expect(t.svc.smtpAccount()).toMatchObject({ ok: true, account: { user: 'dot@example.com', host: 'smtps.mailhost.test' } });
    const after = t.svc.importDotEnvAccount();
    expect(after.fields.user).toMatchObject({ value: 'dot@example.com', source: 'user' });
    expect(after.secrets['mailIn.pass']).toMatchObject({ saved: true, source: 'user' });
    expect(fs.readFileSync(path.join(t.wiki, '_mail-ingest', '.env'), 'utf8')).toBe(DOT);
    expect(t.svc.knownSecrets()).toContain('dot-pass-1234');
  });
});

describe('연결 시험(초안 값으로, 저장하지 않음)', () => {
  it('메일 받기: 가짜 POP3 — 저장 전 초안의 비밀번호로, 틀리면 로그인 실패(비밀번호 글 없음)', async () => {
    const s = (await startFakePop3({ pass: PASS })) as { port: number; commands: string[]; close(): Promise<void> };
    closers.push(() => s.close());
    const t = setup();
    const draft = { host: '127.0.0.1', port: s.port, ssl: false, user: 'radar@example.com', secret: { key: 'mailIn.pass' as const, action: 'set' as const, value: PASS } };
    const ok = await t.svc.test('mailIn', draft);
    expect(ok.ok).toBe(true);
    expect(ok.steps.find((x) => x.label === '메일함')?.detail).toBe('3통');
    expect(t.appSettings.get().mailIn).toBeUndefined();
    const bad = await t.svc.test('mailIn', { ...draft, secret: { key: 'mailIn.pass', action: 'set', value: 'wrong-pass-77' } });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('wrong-pass-77');
    expect(s.commands.some((c) => /^DELE/.test(c))).toBe(false);
  });

  it('AI: 가짜 LLM — 키 비교·enable_thinking:false·마지막 시험 기록', async () => {
    const s = (await startFakeLlm({ key: 'key-abcdef' })) as { url: string; requests: { body?: Record<string, unknown> }[]; close(): Promise<void> };
    closers.push(() => s.close());
    const t = setup();
    const r = await t.svc.test('ai', { llmUrl: s.url, model: FAKE_LLM_MODEL, secret: { key: 'ai.llmKey', action: 'set', value: 'key-abcdef' } });
    expect(r.ok).toBe(true);
    expect(s.requests.some((q) => (q.body as { chat_template_kwargs?: { enable_thinking?: boolean } } | undefined)?.chat_template_kwargs?.enable_thinking === false)).toBe(true);
    expect(t.svc.view('ai').lastTest?.ok).toBe(true);
    const bad = await t.svc.test('ai', { llmUrl: s.url, model: FAKE_LLM_MODEL, secret: { key: 'ai.llmKey', action: 'set', value: 'wrong-key-1' } });
    expect(bad.steps.find((x) => x.label === '인증')?.detail).toBe('키가 맞지 않습니다');
  });

  it('같은 칸 시험이 돌고 있으면 거부', async () => {
    const s = (await startFakePop3({ mode: 'hang' })) as { port: number; close(): Promise<void> };
    closers.push(() => s.close());
    const t = setup();
    const draft = { host: '127.0.0.1', port: s.port, ssl: false, user: 'a@b.c', secret: { key: 'mailIn.pass' as const, action: 'set' as const, value: PASS } };
    const first = t.svc.test('mailIn', draft);
    await expect(t.svc.test('mailIn', draft)).rejects.toThrow(/이미 돌고/);
    await first;
  }, 30_000);

  it('위키: 폴더·위키 모양', async () => {
    const t = setup();
    const r = await t.svc.test('wiki', {});
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({ label: '개인 위키', ok: true, detail: '읽힘 · 위키 모양' });
  });
});

describe('위키 「없음」·팀 기본값·점검 줄', () => {
  it('「없음」 저장 → 다시 시작 안내, 「폴더」로 돌리면 안내 없음', () => {
    const t = setup();
    const r = t.svc.save('wiki', { wikiMode: 'none' });
    expect(r.restartNeeded).toBe(true);
    expect(t.pending()).toBe('(없음)');
    expect(t.appSettings.get().wikiNone).toBe(true);
    expect(t.appSettings.get().wikiRoot).toBe(t.wiki);
    const back = t.svc.save('wiki', { wikiMode: 'folder' });
    expect(back.restartNeeded).toBeUndefined();
    expect(t.pending()).toBeUndefined();
  });

  it('팀 동기화 필드는 setTeamSync 로', () => {
    const t = setup();
    t.svc.save('wiki', { teamEnabled: true, teamRemote: path.join(t.root, 'nas2') });
    expect(t.teamSet()).toMatchObject({ enabled: true, remote: path.join(t.root, 'nas2') });
  });

  it('팀 기본값 파일 값이 칸에 team 출처로, 점검 줄 — ai 는 버리고 문제로 남긴다', async () => {
    const t = setup({ teamFile: { version: 1, mailIn: { host: '127.0.0.1', port: 1100, ssl: false }, ai: { llmUrl: 'http://127.0.0.1:9/v1', model: 'm' } } });
    await t.team.refresh(true);
    expect(t.svc.view('mailIn').fields.host).toMatchObject({ value: '127.0.0.1', source: 'team' });
    const ai = t.svc.view('ai');
    expect(ai.fields.llmUrl).toMatchObject({ source: 'none' });
    expect(ai.fields.llmUrl.teamValue).toBeUndefined();
    expect(ai.fields.model.teamValue).toBeUndefined();
    expect(ai.team.problems).toEqual([expect.stringMatching(/^팀 설정 ai 를 버림: AI 는 팀 기본값으로 정하지 않습니다/)]);
    const lines = t.svc.setupLines();
    expect(lines.team.state).toBe('warn');
    expect(lines.team.text).toMatch(/환경 변수 파일.*AI 는 팀 기본값으로 정하지 않습니다/);
    expect(lines.mailIn.state).toBe('warn');
    expect(lines.ai).toMatchObject({ state: 'warn', text: '로컬 LLM 이 설정되지 않았습니다(회신 초안은 Claude)' });
    expect(t.svc.llmTarget().ok).toBe(false);
  });

  it('비밀 키가 든 팀 파일 → 값 안 씀 + 점검 warn', async () => {
    const t = setup({ teamFile: { version: 1, mailIn: { host: '127.0.0.1', pass: 'x' } } });
    await t.team.refresh(true);
    expect(t.svc.view('mailIn').fields.host.source).toBe('none');
    expect(t.svc.setupLines().team.state).toBe('warn');
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.localLlm)('로컬 LLM: 키 유무와 상관없이 [연결 시험] 성공 전엔 쓰지 않고 점검 warn — 성공하면 그 호스트를 적고, 다른 호스트로 바꾸면 다시 시험', async () => {
    const llm = (await startFakeLlm()) as { url: string; port: number; close(): Promise<void> };
    closers.push(() => llm.close());
    const t = setup();
    t.svc.save('ai', { llmUrl: llm.url, model: FAKE_LLM_MODEL });
    const host = `127.0.0.1:${llm.port}`;
    const untested = `로컬 LLM(${host})을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다`;
    expect(t.svc.llmTarget()).toEqual({ ok: false, untested: true, problem: untested }); // 키가 없어도
    expect(t.svc.setupLines().ai).toEqual({ state: 'warn', text: untested });
    expect(t.svc.view('ai')).toMatchObject({ llmProblem: untested, notes: [untested] });
    // 키를 저장해도 확인되지 않는다(이제 keyHost 는 시험 성공만 적는다)
    t.svc.save('ai', { secret: { key: 'ai.llmKey', action: 'set', value: 'k-123456' } });
    expect(t.appSettings.get().ai?.keyHost).toBeUndefined();
    expect(t.svc.llmTarget().ok).toBe(false);
    // 키를 지우고 시험 — 성공하면 키 없이도 호스트를 적는다
    t.svc.save('ai', { secret: { key: 'ai.llmKey', action: 'clear' } });
    const r = await t.svc.test('ai', {});
    expect(r.ok).toBe(true);
    expect(t.appSettings.get().ai?.keyHost).toBe(host);
    expect(t.svc.llmTarget()).toEqual({ ok: true, target: { url: llm.url, model: FAKE_LLM_MODEL } });
    expect(t.svc.setupLines().ai.state).toBe('ok');
    expect(t.svc.view('ai').llmProblem).toBeUndefined();
    expect(t.changed).toContain('ai');
    // 다른 호스트로 바꾸면 다시 막힌다
    t.svc.save('ai', { llmUrl: 'http://127.0.0.2:9/v1' });
    expect(t.svc.llmTarget()).toEqual({ ok: false, untested: true, problem: '로컬 LLM(127.0.0.2:9)을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다' });
    expect(t.svc.setupLines().ai.state).toBe('warn');
  });

  it('로컬 LLM: 실패한 [연결 시험]은 호스트를 적지 않는다', async () => {
    const llm = (await startFakeLlm({ key: 'key-abcdef' })) as { url: string; port: number; close(): Promise<void> };
    closers.push(() => llm.close());
    const t = setup();
    t.svc.save('ai', { llmUrl: llm.url, model: FAKE_LLM_MODEL });
    const bad = await t.svc.test('ai', { secret: { key: 'ai.llmKey', action: 'set', value: 'wrong-key-1' } });
    expect(bad.ok).toBe(false);
    expect(t.appSettings.get().ai?.keyHost).toBeUndefined();
    expect(t.svc.llmTarget().ok).toBe(false);
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.localLlm)('로컬 LLM: 환경 변수 주소·키도 [연결 시험] 성공 전엔 쓰지 않는다', async () => {
    const llm = (await startFakeLlm({ key: 'key-abcdef' })) as { url: string; port: number; close(): Promise<void> };
    closers.push(() => llm.close());
    const t = setup({ env: { WIKI_RADAR_LLM_URL: llm.url, WIKI_RADAR_LLM_MODEL: FAKE_LLM_MODEL, SERVER_LLM_API_KEY: 'key-abcdef' } });
    const before = t.svc.llmTarget();
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.problem).toMatch(/아직 시험하지 않았습니다/);
    expect((await t.svc.test('ai', {})).ok).toBe(true);
    expect(t.appSettings.get().ai?.keyHost).toBe(`127.0.0.1:${llm.port}`);
    expect(t.svc.llmTarget()).toEqual({ ok: true, target: { url: llm.url, model: FAKE_LLM_MODEL, key: 'key-abcdef' } });
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.localLlm)('로컬 엔진인데 LLM 이 없으면 AI 점검 off', () => {
    const t = setup();
    t.svc.save('ai', { draftEngine: 'local' });
    expect(t.svc.setupLines().ai.state).toBe('off');
    expect(t.svc.llmTarget().ok).toBe(false);
    expect(t.svc.draftEngine()).toBe('local');
  });
});
