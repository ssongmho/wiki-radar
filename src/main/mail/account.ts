// 메일 계정·SMTP 설정 읽기(docs/stage2.5-contract.md §5-1). electron 을 import 하지 않는 순수 모듈이다.
//
// - 서버: WIKI_RADAR_SMTP_HOST(기본 smtps.mailhost.test)·PORT(기본 465)·SECURE(1/0, 기본: 포트가 465면 1).
//   SECURE 가 아니면 STARTTLS 필수(requireTLS) — 루프백(시험용 가짜 서버)만 예외.
// - 계정: WIKI_RADAR_SMTP_USER·PASS 둘 다 있으면 그것, 아니면 <위키>/_mail-ingest/.env 의 MAILHOST_MAIL_USER·PASS
//   (수집기 mailhost_mail.py load_credentials 와 같은 규칙). 부를 때마다 새로 읽는다(캐시 없음). .env 는 읽기만 한다.
// - 비밀번호는 돌려주는 계정 객체에만 담는다. 문제 문장·로그에 넣지 않는다.
import path from 'node:path';
import { errCode, readTextFile } from '../wiki/fsutil';

export interface SmtpAccount {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  /** 로그인 아이디 = 보내는 주소 */
  user: string;
  pass: string;
}

export type AccountResult = { ok: true; account: SmtpAccount } | { ok: false; problem: string };

export const DEFAULT_SMTP_HOST = 'smtps.mailhost.test';
export const DEFAULT_SMTP_PORT = 465;
/** 수집기 폴더 안의 계정 파일(볼트 기준) */
export const MAIL_ENV_FILE = '_mail-ingest/.env';

/** 계정이 없을 때(2.13단계 §C-3 — 설정 화면이 첫 문장, .env·환경 변수는 둘째) */
export const NO_ACCOUNT_PROBLEM =
  '메일 계정이 없습니다: 설정 › 메일 보내기에서 계정을 넣으세요(위키 _mail-ingest/.env 의 MAILHOST_MAIL_USER·MAILHOST_MAIL_PASS 나 ' +
  '환경 변수 WIKI_RADAR_SMTP_USER·WIKI_RADAR_SMTP_PASS 도 됩니다)';
export const TEST_MODE_PROBLEM = '시험 중에는 실제 메일 서버에 접속하지 않습니다';

/** 이보다 큰 .env 는 계정 파일로 보지 않는다 */
const MAX_ENV_BYTES = 64 * 1024;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** 127.0.0.1·localhost·::1([::1] 포함, 대소문자 무시) */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== 'string') return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return LOOPBACK_HOSTS.has(h);
}

/**
 * 시험 가드: VITEST 환경변수가 있거나 WIKI_RADAR_TEST_MODE=1 인데 호스트가 루프백이 아니면 그 문장.
 * 연결하기 전에 불러 실제 메일 서버에 나가지 않게 한다.
 */
export function testModeProblem(env: NodeJS.ProcessEnv, host: string): string | null {
  const testing = env.VITEST !== undefined || env.WIKI_RADAR_TEST_MODE === '1';
  return testing && !isLoopbackHost(host) ? TEST_MODE_PROBLEM : null;
}

/**
 * `.env` 글 → 키·값. mailhost_mail.py load_credentials 와 같은 규칙: 줄 앞뒤 공백을 걷고, 빈 줄·`#` 로 시작하는 줄·
 * `=` 없는 줄은 건너뛴다. 키는 앞뒤 공백, 값은 앞뒤 공백을 걷은 뒤 양끝의 따옴표(' ")를 벗긴다.
 * 같은 키가 여러 번 나오면 처음 것(수집기의 os.environ.setdefault 와 같다).
 */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]+|['"]+$/g, '');
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

type DotEnvRead = { ok: true; values: Map<string, string> } | { ok: false; problem: string };

/** 위키 `_mail-ingest/.env` 의 계정(2.13단계 §A-4 — 예비로만, 읽기만). 둘 중 하나라도 비면 user·pass 없음 */
export type DotEnvAccount = { ok: true; user?: string; pass?: string } | { ok: false; problem: string };

export function readDotEnvAccount(wikiRoot: string): DotEnvAccount {
  const dot = readDotEnv(wikiRoot);
  if (!dot.ok) return dot;
  const user = (dot.values.get('MAILHOST_MAIL_USER') ?? '').trim();
  const pass = dot.values.get('MAILHOST_MAIL_PASS') ?? '';
  return user !== '' && pass !== '' ? { ok: true, user, pass } : { ok: true };
}

function readDotEnv(wikiRoot: string): DotEnvRead {
  if (typeof wikiRoot !== 'string' || wikiRoot === '') return { ok: true, values: new Map() };
  const file = path.join(path.resolve(wikiRoot), ...MAIL_ENV_FILE.split('/'));
  let text: string;
  try {
    text = readTextFile(file);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, values: new Map() };
    return { ok: false, problem: `메일 계정 파일(${MAIL_ENV_FILE})을 읽지 못했습니다 (${code})` };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ENV_BYTES) {
    return { ok: false, problem: `메일 계정 파일(${MAIL_ENV_FILE})이 너무 큽니다` };
  }
  return { ok: true, values: parseDotEnv(text) };
}

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 호스트 이름·IPv4·[IPv6] 로 볼 수 있는 글자만 */
export const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)*\.?|\[?[0-9A-Fa-f:.]+\]?)$/;

/** 계정 아이디·비밀번호에 제어 문자가 있으면 SMTP 대화에 넣지 않는다 */
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * SMTP 계정(명세 §5-1). 계정이 없거나 설정 형식이 틀리면 problem 문장(무엇을 설정해야 하는지).
 * env 는 보통 process.env. wikiRoot 는 .env 를 찾을 위키 폴더.
 */
export function loadSmtpAccount(env: NodeJS.ProcessEnv, wikiRoot: string): AccountResult {
  const host = envValue(env, 'WIKI_RADAR_SMTP_HOST') || DEFAULT_SMTP_HOST;
  if (host.length > 253 || !HOST_RE.test(host)) {
    return { ok: false, problem: 'WIKI_RADAR_SMTP_HOST 형식이 맞지 않습니다(서버 이름 또는 IP)' };
  }

  const portText = envValue(env, 'WIKI_RADAR_SMTP_PORT');
  let port = DEFAULT_SMTP_PORT;
  if (portText !== '') {
    port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
    if (!(port >= 1 && port <= 65535)) {
      return { ok: false, problem: 'WIKI_RADAR_SMTP_PORT 는 1~65535 사이의 숫자여야 합니다' };
    }
  }

  const secureText = envValue(env, 'WIKI_RADAR_SMTP_SECURE');
  let secure: boolean;
  if (secureText === '') secure = port === 465;
  else if (secureText === '1') secure = true;
  else if (secureText === '0') secure = false;
  else return { ok: false, problem: 'WIKI_RADAR_SMTP_SECURE 는 1 또는 0 이어야 합니다' };
  // 처음부터 TLS 가 아니면 STARTTLS 를 반드시 거친다(비밀번호를 평문으로 보내지 않게). 루프백 가짜 서버만 예외
  const requireTLS = !secure && !isLoopbackHost(host);

  let user = envValue(env, 'WIKI_RADAR_SMTP_USER');
  let pass = typeof env.WIKI_RADAR_SMTP_PASS === 'string' ? env.WIKI_RADAR_SMTP_PASS : '';
  if (user === '' || pass === '') {
    const dot = readDotEnv(wikiRoot);
    if (!dot.ok) return { ok: false, problem: dot.problem };
    user = (dot.values.get('MAILHOST_MAIL_USER') ?? '').trim();
    pass = dot.values.get('MAILHOST_MAIL_PASS') ?? '';
  }
  if (user === '' || pass === '') return { ok: false, problem: NO_ACCOUNT_PROBLEM };
  if (CONTROL_RE.test(user) || /\s/.test(user) || user.length > 320 || CONTROL_RE.test(pass)) {
    return { ok: false, problem: '메일 계정 아이디나 비밀번호에 쓸 수 없는 글자가 있습니다' };
  }
  return { ok: true, account: { host, port, secure, requireTLS, user, pass } };
}

// ---- 비밀번호가 글에 섞였는지(이중 방어) -------------------------------------------------------

/** 이보다 짧은 비밀번호는 글 속 우연한 일치가 많아 검사하지 않는다(메일 서비스 메일 전용 비밀번호는 이보다 길다) */
export const SECRET_CHECK_MIN_LENGTH = 6;

/** 초안에 비밀번호가 들어 있을 때(초안을 버린다) */
export const SECRET_IN_DRAFT_PROBLEM =
  '초안에 메일 계정 비밀번호와 같은 글이 들어 있어 초안을 버렸습니다. 원본 메일에 계정 정보를 요구하는 글이 있는지 확인하세요';
/** 보낼 메일에 비밀번호가 들어 있을 때(보내지 않는다) */
export const SECRET_IN_MAIL_PROBLEM =
  '보낼 메일(제목·본문·서명·원문 인용)에 메일 계정 비밀번호와 같은 글이 있어 보내지 않았습니다. 확인해 고친 뒤 다시 보내세요';

/**
 * 이 앱이 아는 메일 비밀번호들: 환경변수 WIKI_RADAR_SMTP_PASS 와 `<위키>/_mail-ingest/.env` 의 MAILHOST_MAIL_PASS
 * (loadSmtpAccount 가 어느 쪽을 쓰든 둘 다 새면 안 된다). 못 읽으면 빼고, 빈 값은 뺀다. 돌려준 값은 비교에만 쓴다.
 */
export function knownMailSecrets(env: NodeJS.ProcessEnv, wikiRoot: string): string[] {
  const out: string[] = [];
  const envPass = typeof env.WIKI_RADAR_SMTP_PASS === 'string' ? env.WIKI_RADAR_SMTP_PASS : '';
  if (envPass !== '') out.push(envPass);
  const dot = readDotEnv(wikiRoot);
  const dotPass = dot.ok ? (dot.values.get('MAILHOST_MAIL_PASS') ?? '') : '';
  if (dotPass !== '' && !out.includes(dotPass)) out.push(dotPass);
  return out;
}

/**
 * texts 가운데 비밀번호(secrets 중 하나, 앞뒤 공백 걷은 것)가 그대로 들어 있는 글이 있는가.
 * SECRET_CHECK_MIN_LENGTH 보다 짧은 비밀번호는 보지 않는다. 초안·보낼 메일에 계정 비밀번호가 섞여 밖으로 나가지 않게
 * main 이 한 번 더 막는 데 쓴다(초안 실행은 계정 파일을 읽지 못하게 막혀 있다 — replyDraft.ts).
 */
export function containsSecret(secrets: readonly string[], texts: readonly (string | undefined)[]): boolean {
  const keys = secrets
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length >= SECRET_CHECK_MIN_LENGTH);
  if (keys.length === 0) return false;
  return texts.some((t) => typeof t === 'string' && keys.some((k) => t.includes(k)));
}

/**
 * 글 속의 비밀(길이 SECRET_CHECK_MIN_LENGTH 이상)을 ●●● 로 가린다(2.13단계 §A-5) — 연결 시험의 서버 응답·오류 문장·로그 줄.
 * 긴 비밀부터 바꾼다(짧은 것이 긴 것의 일부일 때)
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  if (typeof text !== 'string' || text === '') return typeof text === 'string' ? text : '';
  const keys = [...new Set(secrets.filter((s): s is string => typeof s === 'string').map((s) => s.trim()))]
    .filter((s) => s.length >= SECRET_CHECK_MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const k of keys) out = out.split(k).join('●●●');
  return out;
}

/**
 * 이 앱이 아는 비밀 전부(2.13단계 §A-5): 환경 변수 WIKI_RADAR_SMTP_PASS·WIKI_RADAR_POP3_PASS·SERVER_LLM_API_KEY,
 * 위키 .env 의 MAILHOST_MAIL_PASS, secrets.bin 의 값들(stored). 빈 값·중복은 뺀다. 비교·가리기에만 쓴다
 */
export function knownSecrets(env: NodeJS.ProcessEnv, wikiRoot: string, stored: readonly string[] = []): string[] {
  const out = knownMailSecrets(env, wikiRoot);
  for (const name of ['WIKI_RADAR_POP3_PASS', 'SERVER_LLM_API_KEY']) {
    const v = env[name];
    if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  }
  for (const v of stored) if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  return out;
}
