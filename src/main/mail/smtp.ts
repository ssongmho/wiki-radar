// SMTP 발송 한 번(docs/stage2.5-contract.md §4-2 ⑤·§5-1). electron 을 import 하지 않는 순수 모듈이다.
//
// - 만든 MIME 바이트(compose.ts)를 그대로 보낸다(raw + 봉투). 풀·재시도 없음 — 재시도는 사람이 한다(이중 발송 방지).
// - 연결 20초, 전체 60초. 전체 시간을 넘기면 연결을 끊고 오류.
// - 시험 가드(testModeProblem)를 연결 전에 본다 — 시험 중에는 루프백 밖으로 나가지 않는다.
// - 오류 문장은 사람 말로. 비밀번호는 문장에 넣지 않는다.
import nodemailer from 'nodemailer';
import type { ConnectionTestResult, ConnectionTestStep } from '../../shared/types';
import { isLoopbackHost, redactSecrets, testModeProblem, type SmtpAccount } from './account';
import type { ComposedMessage } from './compose';

export type SmtpErrorKind = 'guard' | 'auth' | 'connect' | 'rejected' | 'other';

export class SmtpSendError extends Error {
  kind: SmtpErrorKind;
  /** nodemailer 오류 코드(EAUTH 등) */
  code?: string;
  /** SMTP 응답 코드(550 등) */
  responseCode?: number;

  constructor(kind: SmtpErrorKind, message: string, extra: { code?: string; responseCode?: number; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'SmtpSendError';
    this.kind = kind;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.responseCode !== undefined) this.responseCode = extra.responseCode;
  }
}

export interface SmtpSendResult {
  /** 서버의 마지막 응답 문장(예: '250 OK: queued') */
  response: string;
  accepted: string[];
  rejected: string[];
}

/** 시간 한도(ms). 시험에서만 줄인다 */
export interface SmtpLimits {
  /** 연결·인사 대기(기본 20초) */
  connectionMs?: number;
  /** 한 명령의 응답 대기(기본 60초) */
  socketMs?: number;
  /** 발송 전체(기본 60초) */
  totalMs?: number;
}

export const SMTP_CONNECTION_TIMEOUT_MS = 20_000;
export const SMTP_TOTAL_TIMEOUT_MS = 60_000;

export const AUTH_FAILED_MESSAGE = '메일 계정 인증에 실패했습니다(메일 전용 비밀번호 확인)';
export const CONNECT_FAILED_MESSAGE = '메일 서버에 연결하지 못했습니다';

const CONNECT_CODES: Readonly<Record<string, string>> = {
  ECONNECTION: '연결이 끊겼습니다',
  ETIMEDOUT: '시간 초과',
  ECONNREFUSED: '서버가 연결을 거부했습니다',
  ECONNRESET: '연결이 끊겼습니다',
  ESOCKET: '연결 오류',
  EDNS: '서버 이름을 찾지 못했습니다',
  ENOTFOUND: '서버 이름을 찾지 못했습니다',
  EAI_AGAIN: '서버 이름을 찾지 못했습니다',
  EHOSTUNREACH: '서버에 닿지 못했습니다',
  ENETUNREACH: '네트워크에 닿지 못했습니다',
  ETLS: '보안 연결(TLS)을 만들지 못했습니다',
  EPROXY: '프록시 오류',
};

/** 서버 응답 문장을 한 줄로, 300자까지 */
function oneLine(s: unknown): string {
  const text = typeof s === 'string' ? s : Buffer.isBuffer(s) ? s.toString('utf8') : '';
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** nodemailer 오류 → 사람이 읽는 SmtpSendError */
export function classifySmtpError(err: unknown): SmtpSendError {
  if (err instanceof SmtpSendError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as {
    code?: unknown;
    responseCode?: unknown;
    response?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  const extra = { code, responseCode, cause: err };

  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534) {
    return new SmtpSendError('auth', AUTH_FAILED_MESSAGE, extra);
  }
  if (code !== undefined && code in CONNECT_CODES) {
    return new SmtpSendError('connect', `${CONNECT_FAILED_MESSAGE}(${CONNECT_CODES[code]})`, extra);
  }
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 600) {
    const said = oneLine(e.response);
    const text = said.startsWith(String(responseCode)) ? said : `${responseCode} ${said}`.trim();
    return new SmtpSendError('rejected', `메일 서버가 거부했습니다: ${text}`, extra);
  }
  const message = oneLine(e.message) || String(err);
  return new SmtpSendError('other', `메일을 보내지 못했습니다: ${message}`, extra);
}

/**
 * 만든 메시지를 그대로 보낸다. 실패는 SmtpSendError 로 reject(kind 로 가른다).
 * env 는 시험 가드용(기본 process.env). limits 는 시험에서 시간 한도를 줄일 때만.
 */
export async function sendRawMessage(
  account: SmtpAccount,
  msg: ComposedMessage,
  env: NodeJS.ProcessEnv = process.env,
  limits: SmtpLimits = {},
): Promise<SmtpSendResult> {
  const guard = testModeProblem(env, account.host);
  if (guard) throw new SmtpSendError('guard', guard);
  if (!msg || !Buffer.isBuffer(msg.raw) || !msg.envelope || msg.envelope.to.length === 0) {
    throw new SmtpSendError('other', '보낼 메시지나 받는 주소가 없습니다');
  }

  const connectionMs = limits.connectionMs ?? SMTP_CONNECTION_TIMEOUT_MS;
  const totalMs = limits.totalMs ?? SMTP_TOTAL_TIMEOUT_MS;
  const loopback = isLoopbackHost(account.host);
  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    requireTLS: account.requireTLS,
    auth: { user: account.user, pass: account.pass },
    connectionTimeout: connectionMs,
    greetingTimeout: connectionMs,
    socketTimeout: limits.socketMs ?? SMTP_TOTAL_TIMEOUT_MS,
    pool: false,
    // 시험용 가짜 서버(루프백)는 자체 서명 인증서라 검증하지 않는다. 실제 서버는 검증한다
    tls: loopback ? { rejectUnauthorized: false } : undefined,
    logger: false,
    debug: false,
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new SmtpSendError(
          'connect',
          `메일 서버 응답이 ${Math.round(totalMs / 1000)}초 안에 오지 않았습니다 — 메일이 나갔는지 확인한 뒤 다시 보내세요`,
          { code: 'ETIMEDOUT' },
        ),
      );
    }, totalMs);
  });
  try {
    const info = await Promise.race([
      transport.sendMail({ envelope: { from: msg.envelope.from, to: [...msg.envelope.to] }, raw: msg.raw }),
      timeout,
    ]);
    return {
      response: oneLine(info.response),
      accepted: (info.accepted ?? []).map(addressText),
      rejected: (info.rejected ?? []).map(addressText),
    };
  } catch (err) {
    throw classifySmtpError(err);
  } finally {
    if (timer) clearTimeout(timer);
    transport.close();
  }
}

function addressText(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && typeof (a as { address?: unknown }).address === 'string') {
    return (a as { address: string }).address;
  }
  return String(a);
}

/**
 * 연결 시험(2.13단계 §C-3): nodemailer transporter.verify() — 연결·EHLO·TLS·AUTH 까지, 메일은 보내지 않는다.
 * 단계: 연결 · 보안 · 로그인. 던지지 않는다. 오류 문장은 비밀(secrets + 계정 비밀번호)을 가린다
 */
export async function verifySmtp(
  account: SmtpAccount,
  env: NodeJS.ProcessEnv = process.env,
  opts: { secrets?: readonly string[]; limits?: SmtpLimits; now?: () => number } = {},
): Promise<ConnectionTestResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const steps: ConnectionTestStep[] = [];
  const done = (): ConnectionTestResult => ({ ok: steps.length > 0 && steps.every((s) => s.ok), steps, ms: Math.max(0, now() - started) });
  const secrets = [...(opts.secrets ?? []), account.pass];
  const guard = testModeProblem(env, account.host);
  if (guard) {
    steps.push({ label: '연결', ok: false, detail: guard });
    return done();
  }
  const limits = opts.limits ?? {};
  const connectionMs = limits.connectionMs ?? SMTP_CONNECTION_TIMEOUT_MS;
  const loopback = isLoopbackHost(account.host);
  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    requireTLS: account.requireTLS,
    auth: { user: account.user, pass: account.pass },
    connectionTimeout: connectionMs,
    greetingTimeout: connectionMs,
    socketTimeout: limits.socketMs ?? SMTP_TOTAL_TIMEOUT_MS,
    pool: false,
    tls: loopback ? { rejectUnauthorized: false } : undefined,
    logger: false,
    debug: false,
  });
  const security = account.secure ? 'SSL/TLS' : account.requireTLS ? 'STARTTLS' : '이 PC 시험 서버라 STARTTLS 선택';
  let timer: NodeJS.Timeout | undefined;
  const totalMs = limits.totalMs ?? SMTP_TOTAL_TIMEOUT_MS;
  try {
    await Promise.race([
      transport.verify(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmtpSendError('connect', `메일 서버 응답이 ${Math.round(totalMs / 1000)}초 안에 오지 않았습니다`, { code: 'ETIMEDOUT' })), totalMs);
      }),
    ]);
    steps.push({ label: '연결', ok: true, detail: `${account.host}:${account.port}` });
    steps.push({ label: '보안', ok: true, detail: security });
    steps.push({ label: '로그인', ok: true });
  } catch (err) {
    const e = classifySmtpError(err);
    const detail = redactSecrets(e.message, secrets);
    if (e.kind === 'auth') {
      steps.push({ label: '연결', ok: true, detail: `${account.host}:${account.port}` });
      steps.push({ label: '보안', ok: true, detail: security });
      steps.push({ label: '로그인', ok: false, detail });
    } else if (e.code === 'ETLS') {
      steps.push({ label: '연결', ok: true });
      steps.push({ label: '보안', ok: false, detail });
    } else {
      steps.push({ label: '연결', ok: false, detail });
    }
  } finally {
    if (timer) clearTimeout(timer);
    transport.close();
  }
  return done();
}
