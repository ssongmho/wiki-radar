// POP3 클라이언트(2.13단계 명세 §C-2b). electron 을 import 하지 않는 순수 모듈이다(node:tls·node:net 만 — 네이티브 모듈 없음).
//
// - SSL(node:tls) 또는 평문 연결 + STLS 뒤 tls.connect({socket}). 인증서 검사는 끄지 않는다(rejectUnauthorized 기본).
//   SSL 이 꺼져 있으면 STLS 필수 — 이 PC(루프백) 시험 서버만 STLS 없이 평문을 허용한다(SMTP requireTLS 와 같은 규칙).
// - 보낼 수 있는 명령은 POP3_COMMANDS 뿐이다. 서버의 메일을 지우는 명령(DELE)과 지움 표시를 되돌리는 명령(RSET)은
//   목록에도 함수에도 없다 — 「서버의 메일은 지우지 않습니다」를 설정이 아니라 코드로 지킨다(단위 시험이 이 파일을 읽어 확인한다).
// - 줄 끝 CRLF, 한 줄 2048바이트 한도, 응답 대기 10초, 연결 시험 전체 15초. 아이디·비밀번호에 CR/LF 가 있으면 보내지 않는다.
// - 오류 문장은 서버의 -ERR 글을 redactSecrets 로 가리고 200자로 자른다. 비밀번호는 어떤 문장에도 넣지 않는다.
import net from 'node:net';
import tls from 'node:tls';
import type { ConnectionTestResult, ConnectionTestStep } from '../../shared/types';
import { isLoopbackHost, redactSecrets, testModeProblem } from './account';

/** 보낼 수 있는 명령(허용 목록). RETR 은 수집기(2.15 collector.ts)가 쓴다 */
export const POP3_COMMANDS = ['USER', 'PASS', 'STLS', 'CAPA', 'STAT', 'UIDL', 'QUIT', 'RETR', 'TOP'] as const;
export type Pop3Command = (typeof POP3_COMMANDS)[number];

export const POP3_LINE_MAX = 2048;
export const POP3_REPLY_TIMEOUT_MS = 10_000;
export const POP3_TEST_TOTAL_MS = 15_000;
/** RETR 중 한 줄 한도(수집기 poplib._MAXLINE 과 같다) */
export const RETR_LINE_MAX = 1 << 20;
const LF = Buffer.from([0x0a]);
/** 여러 줄 응답(UIDL·CAPA)의 줄 수 한도 */
const MULTI_LINE_MAX = 200_000;
const DETAIL_MAX = 200;

export class Pop3Error extends Error {
  constructor(
    message: string,
    readonly stage: 'connect' | 'security' | 'login' | 'command',
  ) {
    super(message);
    this.name = 'Pop3Error';
  }
}

/** 보안 계획: ssl = 처음부터 TLS · stls = STLS 필수 · plain = 이 PC 시험 서버(STLS 를 알리면 쓰고, 아니면 평문) */
export function pop3SecurityPlan(host: string, ssl: boolean): 'ssl' | 'stls' | 'plain-loopback' {
  if (ssl) return 'ssl';
  return isLoopbackHost(host) ? 'plain-loopback' : 'stls';
}

function clip(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}

export interface Pop3ConnectOptions {
  host: string;
  port: number;
  ssl: boolean;
  /** 응답 대기(기본 10초) */
  replyTimeoutMs?: number;
  /** 시험: TLS 옵션 더하기(가짜 서버 인증서 ca 등). 인증서 검사를 끄는 옵션은 받지 않는다 */
  tlsOptions?: Pick<tls.ConnectionOptions, 'ca' | 'servername'>;
  /** 오류 문장에서 가릴 비밀 */
  secrets?: readonly string[];
}

/** 한 연결. 명령마다 한 줄(+ 여러 줄) 응답을 기다린다 */
export class Pop3Connection {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];
  private lines: string[] = [];
  private closedError: Error | null = null;
  /** 한 줄 한도(RETR 중에는 RETR_LINE_MAX) */
  private lineMax = POP3_LINE_MAX;
  /** 보안 단계 결과(화면 글) */
  security = '';
  /** 인사 줄 */
  greeting = '';

  private constructor(private readonly opts: Pop3ConnectOptions) {}

  static async open(opts: Pop3ConnectOptions): Promise<Pop3Connection> {
    const c = new Pop3Connection(opts);
    await c.connect();
    return c;
  }

  private get secrets(): readonly string[] {
    return this.opts.secrets ?? [];
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err) => this.fail(new Pop3Error(`연결 오류: ${clip(err.message)}`, 'connect')));
    socket.on('close', () => this.fail(new Pop3Error('서버가 연결을 끊었습니다', 'connect')));
  }

  private detach(): void {
    this.socket?.removeAllListeners('data');
    this.socket?.removeAllListeners('error');
    this.socket?.removeAllListeners('close');
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx < 0) {
        if (this.buffer.length > this.lineMax) this.fail(new Pop3Error('서버 응답 한 줄이 너무 깁니다', 'command'));
        return;
      }
      if (idx > this.lineMax) {
        this.fail(new Pop3Error('서버 응답 한 줄이 너무 깁니다', 'command'));
        return;
      }
      const line = this.buffer.subarray(0, idx).toString('latin1');
      this.buffer = this.buffer.subarray(idx + 2);
      const w = this.waiters.shift();
      if (w) w.resolve(line);
      else this.lines.push(line);
    }
  }

  private fail(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
    this.socket?.destroy();
  }

  private readLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closedError) return Promise.reject(this.closedError);
    const timeoutMs = this.opts.replyTimeoutMs ?? POP3_REPLY_TIMEOUT_MS;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
        const err = new Pop3Error(`서버 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`, 'command');
        this.fail(err);
        reject(err);
      }, timeoutMs);
      const entry = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.waiters.push(entry);
    });
  }

  private async connect(): Promise<void> {
    const { host, port } = this.opts;
    const plan = pop3SecurityPlan(host, this.opts.ssl);
    const timeoutMs = this.opts.replyTimeoutMs ?? POP3_REPLY_TIMEOUT_MS;
    const raw = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      let settled = false;
      const done = (err: Error | null, s?: net.Socket | tls.TLSSocket) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(s as net.Socket);
      };
      const timer = setTimeout(() => {
        sock.destroy();
        done(new Pop3Error(`${Math.round(timeoutMs / 1000)}초 안에 연결하지 못했습니다`, 'connect'));
      }, timeoutMs);
      const sock: net.Socket | tls.TLSSocket =
        plan === 'ssl'
          ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...(this.opts.tlsOptions ?? {}) }, () => done(null, sock))
          : net.connect({ host, port }, () => done(null, sock));
      sock.once('error', (err) =>
        done(new Pop3Error(plan === 'ssl' && /certificate|self[- ]signed|SSL|TLS/i.test(err.message) ? `보안 연결(TLS)을 만들지 못했습니다: ${clip(err.message)}` : `연결하지 못했습니다: ${clip(err.message)}`, plan === 'ssl' && /certificate|SSL|TLS/i.test(err.message) ? 'security' : 'connect')),
      );
    });
    this.attach(raw);
    this.greeting = await this.expectOk(await this.readLine(), 'connect');
    if (plan === 'ssl') {
      this.security = `TLS(${(raw as tls.TLSSocket).getProtocol?.() ?? '알 수 없음'})`;
      return;
    }
    let useStls = plan === 'stls';
    if (!useStls) {
      // 이 PC 시험 서버: STLS 를 알리면 쓴다
      try {
        const caps = await this.multi('CAPA');
        useStls = caps.some((l) => l.trim().toUpperCase() === 'STLS');
      } catch {
        useStls = false;
      }
    }
    if (!useStls) {
      this.security = '이 PC 시험 서버라 평문';
      return;
    }
    const reply = await this.command('STLS');
    if (!reply.startsWith('+OK')) throw new Pop3Error(`서버가 STLS 를 받지 않았습니다: ${clip(redactSecrets(reply, this.secrets))}`, 'security');
    this.detach();
    const plain = raw as net.Socket;
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Pop3Error('보안 연결(STLS)이 제때 끝나지 않았습니다', 'security'));
      }, timeoutMs);
      const s = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, ...(this.opts.tlsOptions ?? {}) }, () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(new Pop3Error(`보안 연결(STLS)을 만들지 못했습니다: ${clip(err.message)}`, 'security'));
      });
    });
    this.attach(secured);
    this.security = `STLS → TLS(${secured.getProtocol() ?? '알 수 없음'})`;
  }

  private expectOk(line: string, stage: Pop3Error['stage']): string {
    if (line.startsWith('+OK')) return line;
    throw new Pop3Error(`서버 응답: ${clip(redactSecrets(line, this.secrets)) || '(빈 줄)'}`, stage);
  }

  /** 명령 한 줄을 보내고 첫 응답 줄을 돌려준다(허용 목록 밖·CR/LF 든 인자는 보내지 않는다) */
  async command(name: Pop3Command, arg?: string): Promise<string> {
    if (!(POP3_COMMANDS as readonly string[]).includes(name)) throw new Pop3Error('허용하지 않는 POP3 명령입니다(앱 버그)', 'command');
    if (arg !== undefined && /[\r\n\u0000]/.test(arg)) throw new Pop3Error('아이디나 비밀번호에 줄바꿈이 있어 보내지 않았습니다', 'login');
    if (!this.socket || this.closedError) throw this.closedError ?? new Pop3Error('연결이 없습니다', 'connect');
    const line = arg === undefined ? `${name}\r\n` : `${name} ${arg}\r\n`;
    if (Buffer.byteLength(line, 'utf8') > POP3_LINE_MAX) throw new Pop3Error('보낼 명령이 너무 깁니다', 'command');
    this.socket.write(line, 'utf8');
    return this.readLine();
  }

  /** 여러 줄 응답 명령(CAPA·UIDL) — '.' 줄까지. 점 겹침(..)은 벗긴다 */
  async multi(name: 'CAPA' | 'UIDL'): Promise<string[]> {
    const first = await this.command(name);
    this.expectOk(first, 'command');
    const out: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line === '.') return out;
      out.push(line.startsWith('..') ? line.slice(1) : line);
      if (out.length > MULTI_LINE_MAX) throw new Pop3Error('서버 응답이 너무 깁니다', 'command');
    }
  }

  async login(user: string, pass: string): Promise<void> {
    if (/[\r\n\u0000]/.test(user) || /[\r\n\u0000]/.test(pass)) throw new Pop3Error('아이디나 비밀번호에 줄바꿈이 있어 보내지 않았습니다', 'login');
    this.expectOk(await this.command('USER', user), 'login');
    const r = await this.command('PASS', pass);
    if (!r.startsWith('+OK')) throw new Pop3Error(`로그인 실패: ${clip(redactSecrets(r.replace(/^-ERR\s*/, ''), [...this.secrets, pass])) || '아이디 또는 비밀번호를 확인하세요'}`, 'login');
  }

  /** UIDL → [번호, uid] 목록(서버 순서) */
  async uidl(): Promise<{ num: number; uid: string }[]> {
    const out: { num: number; uid: string }[] = [];
    for (const line of await this.multi('UIDL')) {
      const m = /^(\d+)\s+(\S+)/.exec(line.trim());
      if (m) out.push({ num: Number(m[1]), uid: m[2] });
    }
    return out;
  }

  /**
   * RETR → 메일 원문 바이트(줄은 LF 로 잇는다 — 수집기의 LF join(server.retr(n)[1]) 과 같다). 점 겹침을 벗긴다.
   * maxBytes 를 넘으면 끝까지 읽어 버리고 Pop3Error(연결은 그대로 쓸 수 있다).
   */
  async retr(num: number, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(num) || num < 1) throw new Pop3Error('잘못된 메일 번호입니다(앱 버그)', 'command');
    const first = await this.command('RETR', String(num));
    this.expectOk(first, 'command');
    this.lineMax = RETR_LINE_MAX;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    try {
      for (;;) {
        const line = await this.readLine();
        if (line === '.') break;
        if (tooBig) continue;
        const buf = Buffer.from(line.startsWith('..') ? line.slice(1) : line, 'latin1');
        size += buf.length + 1;
        if (size > maxBytes) {
          tooBig = true;
          chunks.length = 0;
          continue;
        }
        chunks.push(buf);
      }
    } finally {
      this.lineMax = POP3_LINE_MAX;
    }
    if (tooBig) throw new Pop3Error(`메일이 너무 큽니다(${Math.round(maxBytes / 1024 / 1024)}MB 넘음)`, 'command');
    const out: Buffer[] = [];
    chunks.forEach((c, i) => {
      if (i > 0) out.push(LF);
      out.push(c);
    });
    return Buffer.concat(out);
  }

  /** STAT → 메일 수·크기 */
  async stat(): Promise<{ count: number; size: number }> {
    const r = this.expectOk(await this.command('STAT'), 'command');
    const m = /^\+OK\s+(\d+)\s+(\d+)/.exec(r);
    if (!m) throw new Pop3Error(`STAT 응답을 읽지 못했습니다: ${clip(r)}`, 'command');
    return { count: Number(m[1]), size: Number(m[2]) };
  }

  /** QUIT 하고 닫는다(실패해도 닫는다). 던지지 않는다 */
  async quit(): Promise<void> {
    try {
      if (this.socket && !this.closedError) await this.command('QUIT');
    } catch {
      // 닫는 중 실패는 무시
    } finally {
      this.closedError ??= new Pop3Error('닫음', 'connect');
      this.socket?.destroy();
    }
  }

  /** 그냥 닫는다 */
  destroy(): void {
    this.closedError ??= new Pop3Error('닫음', 'connect');
    this.socket?.destroy();
  }
}

export interface Pop3TestInput {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  pass: string;
  env: NodeJS.ProcessEnv;
  secrets?: readonly string[];
  replyTimeoutMs?: number;
  totalMs?: number;
  tlsOptions?: Pop3ConnectOptions['tlsOptions'];
  now?: () => number;
}

/** 연결 시험: 연결 · 보안 · 로그인 · 메일함(STAT) · QUIT. 던지지 않는다 */
export async function testPop3(input: Pop3TestInput): Promise<ConnectionTestResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const steps: ConnectionTestStep[] = [];
  const result = (): ConnectionTestResult => ({ ok: steps.length > 0 && steps.every((s) => s.ok), steps, ms: Math.max(0, now() - started) });
  const guard = testModeProblem(input.env, input.host);
  if (guard) {
    steps.push({ label: '연결', ok: false, detail: guard });
    return result();
  }
  const secrets = [...(input.secrets ?? []), input.pass];
  let conn: Pop3Connection | null = null;
  const totalMs = input.totalMs ?? POP3_TEST_TOTAL_MS;
  let totalTimer: NodeJS.Timeout | undefined;
  const run = async (): Promise<void> => {
    try {
      conn = await Pop3Connection.open({
        host: input.host,
        port: input.port,
        ssl: input.ssl,
        secrets,
        ...(input.replyTimeoutMs ? { replyTimeoutMs: input.replyTimeoutMs } : {}),
        ...(input.tlsOptions ? { tlsOptions: input.tlsOptions } : {}),
      });
    } catch (err) {
      const e = err instanceof Pop3Error ? err : new Pop3Error(String(err), 'connect');
      if (e.stage === 'security') {
        steps.push({ label: '연결', ok: true });
        steps.push({ label: '보안', ok: false, detail: redactSecrets(e.message, secrets) });
      } else steps.push({ label: '연결', ok: false, detail: redactSecrets(e.message, secrets) });
      return;
    }
    const c = conn as Pop3Connection;
    steps.push({ label: '연결', ok: true, detail: clip(redactSecrets(c.greeting, secrets)) });
    steps.push({ label: '보안', ok: true, detail: c.security });
    try {
      await c.login(input.user, input.pass);
      steps.push({ label: '로그인', ok: true });
    } catch (err) {
      steps.push({ label: '로그인', ok: false, detail: redactSecrets(err instanceof Error ? err.message : String(err), secrets) });
      return;
    }
    try {
      const st = await c.stat();
      steps.push({ label: '메일함', ok: true, detail: `${st.count}통` });
    } catch (err) {
      steps.push({ label: '메일함', ok: false, detail: redactSecrets(err instanceof Error ? err.message : String(err), secrets) });
    }
  };
  const timeout = new Promise<'timeout'>((resolve) => {
    totalTimer = setTimeout(() => resolve('timeout'), totalMs);
  });
  try {
    const outcome = await Promise.race([run().then(() => 'done' as const), timeout]);
    if (outcome === 'timeout') {
      steps.push({ label: steps.length === 0 ? '연결' : '응답', ok: false, detail: `${Math.round(totalMs / 1000)}초 안에 끝나지 않았습니다` });
      (conn as Pop3Connection | null)?.destroy();
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer);
    await (conn as Pop3Connection | null)?.quit();
  }
  return result();
}
