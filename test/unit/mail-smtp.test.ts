// SMTP 발송(명세 §4-2 ⑤·§5-1) — 로컬 smtp-server(127.0.0.1 임의 포트)와 실제 SMTP 대화를 한다.
// 성공·인증 실패·연결 거부·서버 거부 550·시간 초과·시험 가드. 실제 메일 서버에는 접속하지 않는다.
import net from 'node:net';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_MODE_PROBLEM, type SmtpAccount } from '../../src/main/mail/account';
import { composeMessage, type ComposeInput, type ComposedMessage } from '../../src/main/mail/compose';
import { AUTH_FAILED_MESSAGE, SmtpSendError, sendRawMessage, verifySmtp } from '../../src/main/mail/smtp';

interface Received {
  from: string;
  rcpt: string[];
  user?: string;
  raw: Buffer;
}

interface FakeServer {
  port: number;
  received: Received[];
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 인증 radar/secret 만 받는 가짜 SMTP 서버(TLS 없음). 받은 메시지를 모은다 */
async function startServer(opts: { rejectRcpt?: (address: string) => boolean; hangOnData?: boolean } = {}): Promise<FakeServer> {
  const received: Received[] = [];
  const server = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    closeTimeout: 200,
    onAuth(auth, _session, callback) {
      if (auth.username === 'radar' && auth.password === 'secret') callback(null, { user: 'radar' });
      else callback(new Error('Invalid username or password'));
    },
    onRcptTo(address, _session, callback) {
      if (opts.rejectRcpt?.(address.address)) {
        const err = new Error('5.1.1 No such user here') as Error & { responseCode: number };
        err.responseCode = 550;
        callback(err);
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          rcpt: session.envelope.rcptTo.map((r) => r.address),
          user: typeof session.user === 'string' ? session.user : undefined,
          raw: Buffer.concat(chunks),
        });
        if (!opts.hangOnData) callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.server.address() as net.AddressInfo).port;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  cleanups.push(close);
  return { port, received, close };
}

/** 열려 있지 않은 포트 하나 */
async function closedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** 연결은 받지만 인사를 하지 않는 서버 */
async function silentServer(): Promise<number> {
  const sockets: net.Socket[] = [];
  const s = net.createServer((sock) => sockets.push(sock));
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const sock of sockets) sock.destroy();
        s.close(() => resolve());
      }),
  );
  return (s.address() as net.AddressInfo).port;
}

function account(port: number, extra: Partial<SmtpAccount> = {}): SmtpAccount {
  return { host: '127.0.0.1', port, secure: false, requireTLS: false, user: 'radar', pass: 'secret', ...extra };
}

const INPUT: ComposeInput = {
  from: { name: '홍길동', address: 'owner@example.com' },
  to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
  cc: ['cc@x.example'],
  bcc: ['owner@example.com'],
  subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
  text: '안녕하세요.\n\n확인했습니다.\n감사합니다.',
  inReplyTo: 'fixture-0001@hangyeol.example',
  references: 'fixture-0001@hangyeol.example',
};

async function message(extra: Partial<ComposeInput> = {}): Promise<ComposedMessage> {
  return composeMessage({ ...INPUT, ...extra });
}

async function sendError(p: Promise<unknown>): Promise<SmtpSendError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SmtpSendError);
    return err as SmtpSendError;
  }
  throw new Error('실패해야 하는데 성공했습니다');
}

describe('sendRawMessage — 로컬 SMTP 대화', () => {
  it('보낸 바이트 그대로 받는다: In-Reply-To·Subject, 봉투 RCPT 에 숨은참조, 머리말에 Bcc 없음', async () => {
    const server = await startServer();
    const msg = await message();
    const result = await sendRawMessage(account(server.port), msg);

    expect(result.response).toMatch(/^250\b/);
    expect(result.accepted).toEqual(['ehs@hangyeol.example', 'cc@x.example', 'owner@example.com']);
    expect(result.rejected).toEqual([]);

    expect(server.received).toHaveLength(1);
    const got = server.received[0];
    expect(got.user).toBe('radar');
    expect(got.from).toBe('owner@example.com');
    expect(got.rcpt).toEqual(['ehs@hangyeol.example', 'cc@x.example', 'owner@example.com']);
    const text = got.raw.toString('latin1');
    expect(text).toContain('In-Reply-To: <fixture-0001@hangyeol.example>\r\n');
    expect(text).toContain('References: <fixture-0001@hangyeol.example>\r\n');
    expect(text).toContain('Subject: =?UTF-8?');
    expect(text).toContain(`Message-ID: ${msg.messageId}\r\n`);
    expect(text).not.toMatch(/^bcc:/im);
    // 머리말을 덧붙이지 않고 만든 바이트 그대로(끝 줄바꿈만 다를 수 있다)
    expect(got.raw.toString('latin1').replace(/\r\n$/, '')).toBe(msg.raw.toString('latin1').replace(/\r\n$/, ''));
  });

  it('인증 실패 → auth', async () => {
    const server = await startServer();
    const err = await sendError(sendRawMessage(account(server.port, { pass: 'wrong' }), await message()));
    expect(err.kind).toBe('auth');
    expect(err.message).toBe(AUTH_FAILED_MESSAGE);
    expect(err.message).not.toContain('wrong');
    expect(server.received).toHaveLength(0);
  });

  it('닫힌 포트 → connect', async () => {
    const port = await closedPort();
    const err = await sendError(sendRawMessage(account(port), await message()));
    expect(err.kind).toBe('connect');
    expect(err.message).toMatch(/^메일 서버에 연결하지 못했습니다/);
  });

  it('받는사람을 모두 550 으로 거부 → rejected(응답 코드와 문장)', async () => {
    const server = await startServer({ rejectRcpt: () => true });
    const err = await sendError(sendRawMessage(account(server.port), await message()));
    expect(err.kind).toBe('rejected');
    expect(err.responseCode).toBe(550);
    expect(err.message).toMatch(/^메일 서버가 거부했습니다: 550/);
    expect(err.message).toContain('No such user');
    expect(server.received).toHaveLength(0);
  });

  it('일부만 거부하면 보내고 거부된 주소를 돌려준다', async () => {
    const server = await startServer({ rejectRcpt: (a) => a === 'cc@x.example' });
    const result = await sendRawMessage(account(server.port), await message());
    expect(result.accepted).toEqual(['ehs@hangyeol.example', 'owner@example.com']);
    expect(result.rejected).toEqual(['cc@x.example']);
    expect(server.received[0].rcpt).toEqual(['ehs@hangyeol.example', 'owner@example.com']);
  });

  it('인사가 오지 않으면 연결 제한 시간에 끊는다 → connect(시간 초과)', async () => {
    const port = await silentServer();
    const started = Date.now();
    const err = await sendError(sendRawMessage(account(port), await message(), process.env, { connectionMs: 300 }));
    expect(err.kind).toBe('connect');
    expect(err.message).toContain('시간 초과');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('전체 제한 시간을 넘기면 connect — 나갔는지 확인하라고 알린다', async () => {
    const server = await startServer({ hangOnData: true });
    const err = await sendError(
      sendRawMessage(account(server.port), await message(), process.env, { totalMs: 500, socketMs: 1500 }),
    );
    expect(err.kind).toBe('connect');
    expect(err.message).toContain('초 안에 오지 않았습니다');
    expect(err.message).toContain('확인');
  });
});

describe('sendRawMessage — 시험 가드·입력', () => {
  it.each([['smtps.mailhost.test'], ['smtp.example.com'], ['10.0.0.1']])(
    '시험 중 루프백이 아닌 호스트(%s)는 연결 전에 거부한다',
    async (host) => {
      const spy = vi.spyOn(nodemailer, 'createTransport');
      const err = await sendError(sendRawMessage(account(465, { host, secure: true }), await message()));
      expect(err.kind).toBe('guard');
      expect(err.message).toBe(TEST_MODE_PROBLEM);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('WIKI_RADAR_TEST_MODE=1 만 있어도 막는다(e2e)', async () => {
    const spy = vi.spyOn(nodemailer, 'createTransport');
    const err = await sendError(
      sendRawMessage(account(465, { host: 'smtps.mailhost.test' }), await message(), { WIKI_RADAR_TEST_MODE: '1' }),
    );
    expect(err.kind).toBe('guard');
    expect(spy).not.toHaveBeenCalled();
  });

  it('받는 주소가 없는 메시지는 보내지 않는다', async () => {
    const server = await startServer();
    const msg = await message();
    const err = await sendError(sendRawMessage(account(server.port), { ...msg, envelope: { from: msg.envelope.from, to: [] } }));
    expect(err.kind).toBe('other');
    expect(server.received).toHaveLength(0);
  });
});

describe('verifySmtp (2.13단계 §C-3 연결 시험 — 메일은 보내지 않는다)', () => {
  it('연결 · 보안 · 로그인 ok, 받은 메일 없음', async () => {
    const server = await startServer();
    const r = await verifySmtp(account(server.port), { VITEST: 'true' });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.label)).toEqual(['연결', '보안', '로그인']);
    expect(server.received).toHaveLength(0);
  });

  it('틀린 비밀번호 → 로그인 실패, 문장에 비밀번호 없음', async () => {
    const server = await startServer();
    const r = await verifySmtp({ ...account(server.port), pass: 'wrong-secret-99' }, { VITEST: 'true' });
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.label === '로그인')).toMatchObject({ ok: false, detail: AUTH_FAILED_MESSAGE });
    expect(JSON.stringify(r)).not.toContain('wrong-secret-99');
  });

  it('시험 가드: 루프백 밖은 연결 전에 막는다', async () => {
    const r = await verifySmtp({ ...account(465), host: 'smtps.example.com' }, { VITEST: 'true' });
    expect(r.ok).toBe(false);
    expect(r.steps[0].detail).toBe(TEST_MODE_PROBLEM);
  });
});
