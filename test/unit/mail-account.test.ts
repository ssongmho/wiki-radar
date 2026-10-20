// 메일 계정 읽기(명세 §5-1) — 환경변수 우선·.env 규칙(수집기 load_credentials 와 같게)·없음·서버 설정·시험 가드.
// .env 는 임시 폴더의 가짜 위키에만 만든다(실제 위키의 .env 를 읽지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NO_ACCOUNT_PROBLEM,
  SECRET_CHECK_MIN_LENGTH,
  TEST_MODE_PROBLEM,
  containsSecret,
  isLoopbackHost,
  knownMailSecrets,
  loadSmtpAccount,
  parseDotEnv,
  testModeProblem,
} from '../../src/main/mail/account';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** 가짜 위키. envText 가 있으면 _mail-ingest/.env 를 만든다 */
function fakeWiki(envText?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-account-'));
  temps.push(root);
  if (envText !== undefined) {
    fs.mkdirSync(path.join(root, '_mail-ingest'), { recursive: true });
    fs.writeFileSync(path.join(root, '_mail-ingest', '.env'), envText, 'utf8');
  }
  return root;
}

function ok(result: ReturnType<typeof loadSmtpAccount>) {
  if (!result.ok) throw new Error(`계정이 없음: ${result.problem}`);
  return result.account;
}

describe('parseDotEnv — load_credentials 와 같은 규칙', () => {
  it('KEY=VALUE, # 주석, 빈 줄·= 없는 줄 건너뜀, 앞뒤 공백, 양끝 따옴표 벗김', () => {
    const map = parseDotEnv(
      [
        '# 메일 전용 비밀번호',
        '',
        '  MAILHOST_MAIL_USER = owner@example.com  ',
        'MAILHOST_MAIL_PASS="p@ss=word#1"',
        'SINGLE=\'작은따옴표\'',
        'MIXED="\'섞인 따옴표\'"',
        'INNER=a "b" c',
        'EMPTY=',
        '그냥 줄',
        '   # 들여쓴 주석=무시',
      ].join('\r\n'),
    );
    expect(map.get('MAILHOST_MAIL_USER')).toBe('owner@example.com');
    expect(map.get('MAILHOST_MAIL_PASS')).toBe('p@ss=word#1');
    expect(map.get('SINGLE')).toBe('작은따옴표');
    expect(map.get('MIXED')).toBe('섞인 따옴표');
    expect(map.get('INNER')).toBe('a "b" c');
    expect(map.get('EMPTY')).toBe('');
    expect(map.has('그냥 줄')).toBe(false);
    expect(map.has('# 들여쓴 주석')).toBe(false);
  });

  it('같은 키가 여러 번이면 처음 것(os.environ.setdefault 와 같다)', () => {
    expect(parseDotEnv('K=first\nK=second').get('K')).toBe('first');
  });
});

describe('loadSmtpAccount — 계정', () => {
  it('.env 의 MAILHOST_MAIL_USER·PASS 를 읽는다(기본 서버 smtps.mailhost.test:465 TLS)', () => {
    const wiki = fakeWiki('MAILHOST_MAIL_USER=owner@example.com\nMAILHOST_MAIL_PASS=\'secret pw\'\n');
    expect(ok(loadSmtpAccount({}, wiki))).toEqual({
      host: 'smtps.mailhost.test',
      port: 465,
      secure: true,
      requireTLS: false,
      user: 'owner@example.com',
      pass: 'secret pw',
    });
  });

  it('WIKI_RADAR_SMTP_USER·PASS 가 .env 보다 먼저', () => {
    const wiki = fakeWiki('MAILHOST_MAIL_USER=dot@example.com\nMAILHOST_MAIL_PASS=dotpass\n');
    const a = ok(loadSmtpAccount({ WIKI_RADAR_SMTP_USER: 'env@example.com', WIKI_RADAR_SMTP_PASS: 'envpass' }, wiki));
    expect(a.user).toBe('env@example.com');
    expect(a.pass).toBe('envpass');
  });

  it('환경변수가 하나만 있으면 .env 의 짝을 쓴다(섞지 않는다)', () => {
    const wiki = fakeWiki('MAILHOST_MAIL_USER=dot@example.com\nMAILHOST_MAIL_PASS=dotpass\n');
    const a = ok(loadSmtpAccount({ WIKI_RADAR_SMTP_USER: 'env@example.com' }, wiki));
    expect([a.user, a.pass]).toEqual(['dot@example.com', 'dotpass']);
  });

  it('프로세스 환경의 MAILHOST_MAIL_* 는 보지 않는다(.env 파일만)', () => {
    const wiki = fakeWiki();
    const r = loadSmtpAccount({ MAILHOST_MAIL_USER: 'x@example.com', MAILHOST_MAIL_PASS: 'y' }, wiki);
    expect(r).toEqual({ ok: false, problem: NO_ACCOUNT_PROBLEM });
  });

  it.each([
    ['.env 없음', undefined],
    ['빈 .env', ''],
    ['비밀번호 없음', 'MAILHOST_MAIL_USER=owner@example.com\n'],
    ['빈 비밀번호', 'MAILHOST_MAIL_USER=owner@example.com\nMAILHOST_MAIL_PASS=""\n'],
    ['주석 처리', '# MAILHOST_MAIL_USER=owner@example.com\n# MAILHOST_MAIL_PASS=x\n'],
  ])('계정이 없으면 설정 안내 문장: %s', (_label, envText) => {
    const r = loadSmtpAccount({}, fakeWiki(envText));
    expect(r).toEqual({ ok: false, problem: NO_ACCOUNT_PROBLEM });
    expect(NO_ACCOUNT_PROBLEM).toContain('_mail-ingest/.env');
    expect(NO_ACCOUNT_PROBLEM).toContain('WIKI_RADAR_SMTP_USER·WIKI_RADAR_SMTP_PASS');
  });

  it('위키 경로가 비어도 환경변수 계정은 쓴다', () => {
    expect(ok(loadSmtpAccount({ WIKI_RADAR_SMTP_USER: 'a@b.co', WIKI_RADAR_SMTP_PASS: 'p' }, '')).user).toBe('a@b.co');
    expect(loadSmtpAccount({}, '')).toEqual({ ok: false, problem: NO_ACCOUNT_PROBLEM });
  });

  it('.env 가 폴더라 읽지 못하면 그 문장(비밀번호는 담지 않는다)', () => {
    const wiki = fakeWiki();
    fs.mkdirSync(path.join(wiki, '_mail-ingest', '.env'), { recursive: true });
    const r = loadSmtpAccount({}, wiki);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/^메일 계정 파일\(_mail-ingest\/\.env\)을 읽지 못했습니다/);
  });

  it('아이디·비밀번호에 제어 문자가 있으면 거부', () => {
    const r = loadSmtpAccount({ WIKI_RADAR_SMTP_USER: 'a@b.co', WIKI_RADAR_SMTP_PASS: 'p\r\nAUTH' }, '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toContain('쓸 수 없는 글자');
      expect(r.problem).not.toContain('AUTH');
    }
  });

  it('부를 때마다 새로 읽는다(캐시 없음)', () => {
    const wiki = fakeWiki('MAILHOST_MAIL_USER=a@b.co\nMAILHOST_MAIL_PASS=one\n');
    expect(ok(loadSmtpAccount({}, wiki)).pass).toBe('one');
    fs.writeFileSync(path.join(wiki, '_mail-ingest', '.env'), 'MAILHOST_MAIL_USER=a@b.co\nMAILHOST_MAIL_PASS=two\n');
    expect(ok(loadSmtpAccount({}, wiki)).pass).toBe('two');
  });
});

describe('loadSmtpAccount — 서버 설정', () => {
  const creds = { WIKI_RADAR_SMTP_USER: 'radar', WIKI_RADAR_SMTP_PASS: 'secret' };

  it('시험용 가짜 서버: 127.0.0.1, SECURE=0 → TLS 요구 없음', () => {
    const a = ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_HOST: '127.0.0.1', WIKI_RADAR_SMTP_PORT: '2525', WIKI_RADAR_SMTP_SECURE: '0' }, ''));
    expect(a).toMatchObject({ host: '127.0.0.1', port: 2525, secure: false, requireTLS: false, user: 'radar' });
  });

  it('루프백이 아니고 TLS 가 아니면 STARTTLS 필수', () => {
    const a = ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_HOST: 'smtp.example.com', WIKI_RADAR_SMTP_PORT: '587' }, ''));
    expect(a).toMatchObject({ port: 587, secure: false, requireTLS: true });
    const b = ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_SECURE: '0' }, ''));
    expect(b).toMatchObject({ host: 'smtps.mailhost.test', port: 465, secure: false, requireTLS: true });
  });

  it('SECURE 기본값은 포트가 465 일 때만 켬, 1 이면 켬', () => {
    expect(ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_PORT: '465' }, '')).secure).toBe(true);
    expect(ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_PORT: '25' }, '')).secure).toBe(false);
    expect(ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_PORT: '2465', WIKI_RADAR_SMTP_SECURE: '1' }, ''))).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it('localhost·::1 도 루프백', () => {
    expect(ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_HOST: 'LocalHost', WIKI_RADAR_SMTP_PORT: '25' }, '')).requireTLS).toBe(false);
    expect(ok(loadSmtpAccount({ ...creds, WIKI_RADAR_SMTP_HOST: '::1', WIKI_RADAR_SMTP_PORT: '25' }, '')).requireTLS).toBe(false);
  });

  it.each([
    [{ WIKI_RADAR_SMTP_PORT: 'abc' }, 'WIKI_RADAR_SMTP_PORT'],
    [{ WIKI_RADAR_SMTP_PORT: '0' }, 'WIKI_RADAR_SMTP_PORT'],
    [{ WIKI_RADAR_SMTP_PORT: '70000' }, 'WIKI_RADAR_SMTP_PORT'],
    [{ WIKI_RADAR_SMTP_PORT: '46.5' }, 'WIKI_RADAR_SMTP_PORT'],
    [{ WIKI_RADAR_SMTP_SECURE: 'true' }, 'WIKI_RADAR_SMTP_SECURE'],
    [{ WIKI_RADAR_SMTP_SECURE: 'yes' }, 'WIKI_RADAR_SMTP_SECURE'],
    [{ WIKI_RADAR_SMTP_HOST: 'smtp example.com' }, 'WIKI_RADAR_SMTP_HOST'],
    [{ WIKI_RADAR_SMTP_HOST: 'smtp.example.com\r\nX' }, 'WIKI_RADAR_SMTP_HOST'],
    [{ WIKI_RADAR_SMTP_HOST: 'user@smtp.example.com' }, 'WIKI_RADAR_SMTP_HOST'],
  ])('형식이 틀리면 그 설정 이름을 담은 문장: %j', (env, name) => {
    const r = loadSmtpAccount({ ...creds, ...env }, '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain(name);
  });
});

describe('isLoopbackHost · testModeProblem', () => {
  it('루프백은 127.0.0.1·localhost·::1 만', () => {
    for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['smtps.mailhost.test', '127.0.0.2', '10.0.0.1', 'localhost.example.com', '0.0.0.0', '']) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('VITEST 가 있거나 WIKI_RADAR_TEST_MODE=1 이면 루프백 밖을 막는다', () => {
    expect(testModeProblem({ VITEST: 'true' }, 'smtps.mailhost.test')).toBe(TEST_MODE_PROBLEM);
    expect(testModeProblem({ WIKI_RADAR_TEST_MODE: '1' }, 'smtp.example.com')).toBe('시험 중에는 실제 메일 서버에 접속하지 않습니다');
    expect(testModeProblem({ VITEST: 'true' }, '127.0.0.1')).toBeNull();
    expect(testModeProblem({ WIKI_RADAR_TEST_MODE: '1' }, 'localhost')).toBeNull();
  });

  it('시험이 아니면 막지 않는다', () => {
    expect(testModeProblem({}, 'smtps.mailhost.test')).toBeNull();
    expect(testModeProblem({ WIKI_RADAR_TEST_MODE: '0' }, 'smtps.mailhost.test')).toBeNull();
  });

  it('지금 이 시험 프로세스에서는 가드가 켜져 있다', () => {
    expect(testModeProblem(process.env, 'smtps.mailhost.test')).toBe(TEST_MODE_PROBLEM);
  });
});

describe('knownMailSecrets · containsSecret — 초안·보낼 메일에 비밀번호가 섞였는지(이중 방어)', () => {
  it('환경변수와 .env 의 비밀번호를 둘 다 안다(어느 쪽을 쓰든 새면 안 된다). 없으면 빈 목록', () => {
    const wiki = fakeWiki('MAILHOST_MAIL_USER=owner@example.com\nMAILHOST_MAIL_PASS=dot-env-pass\n');
    expect(knownMailSecrets({ WIKI_RADAR_SMTP_PASS: 'env-pass-123' }, wiki)).toEqual(['env-pass-123', 'dot-env-pass']);
    expect(knownMailSecrets({}, wiki)).toEqual(['dot-env-pass']);
    expect(knownMailSecrets({ WIKI_RADAR_SMTP_PASS: 'dot-env-pass' }, wiki)).toEqual(['dot-env-pass']);
    expect(knownMailSecrets({}, fakeWiki())).toEqual([]);
    expect(knownMailSecrets({}, '')).toEqual([]);
  });

  it('글 가운데 비밀번호가 그대로 있으면 참. 짧은 비밀번호·빈 값은 보지 않는다', () => {
    const secret = 'Hiw0rks-Pa55';
    expect(containsSecret([secret], ['안녕하세요.\n참조번호 Hiw0rks-Pa55 입니다.'])).toBe(true);
    expect(containsSecret(['other-secret', secret], [undefined, '제목', `끝에 ${secret}`])).toBe(true);
    expect(containsSecret([` ${secret} `], [`…${secret}…`]), '앞뒤 공백은 걷고 비교').toBe(true);
    expect(containsSecret([secret], ['안녕하세요. 확인했습니다.'])).toBe(false);
    expect(containsSecret([secret], [])).toBe(false);
    const short = 'x'.repeat(SECRET_CHECK_MIN_LENGTH - 1);
    expect(containsSecret([short], [`${short} 가 들어 있다`]), '너무 짧은 비밀번호는 보지 않는다').toBe(false);
    expect(containsSecret(['', '   '], ['아무 글'])).toBe(false);
  });
});
