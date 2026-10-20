// VOC API 직접 호출(명세 §15 — src/main/voc/api.ts VocApiRunner) 단위·통합 시험.
// 네트워크에 나가지 않는다: 요청 모양은 주입한 가짜 fetch(기록만)로, 흐름은 이 PC 의 가짜 VOC 백엔드(test/fixtures/fake-voc-server.mjs —
// 127.0.0.1, 자료·업무 규칙은 가짜 voc-cli 와 같다)로 본다. 실제 VOC 서버(voc.acme.test)에 닿지 않는다.
// 사람·고객사·주소·비밀번호는 가짜다. 사용량 기록은 임시 파일(또는 null)에만 쓴다 — ~/.voc-cli 를 건드리지 않는다.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, VocBoard, VocWorkInput } from '../../src/shared/types';
import {
  VOC_API_GUARD_MESSAGE,
  VOC_CLIENT_ID,
  VOC_DEFAULT_API_URL,
  VocApiRunner,
  VocSessionStore,
  extractApiError,
  filenameFromDisposition,
  normalizeVocApiUrl,
  sanitizeFilename,
  usageLabel,
  type VocApiRunnerOptions,
  type VocSession,
  type VocSessionCodec,
} from '../../src/main/voc/api';
import {
  VOC_EXPIRED_MESSAGE,
  VOC_LOGIN_MESSAGE,
  VOC_STOPPED_MESSAGE,
  VOC_UNAVAILABLE_MESSAGE,
  VOC_USAGE_ERROR_MESSAGE,
  VocCliRunner,
  VocRunError,
  classifyVocFailure,
  vocDownloadArgs,
  vocLoginArgs,
  type VocRunResult,
} from '../../src/main/voc/cli';
import { parseDownloadOutput } from '../../src/main/voc/files';
import {
  parseCodes,
  parseCustomers,
  parseEmailLogs,
  parseTicketDetail,
  parseTicketList,
  parseUsers,
  parseWhoami,
  parseWorkLogs,
} from '../../src/main/voc/model';
import { VOC_LIST_ARGS, VocService } from '../../src/main/voc/service';
import { VocActionLog, VocSettingsStore } from '../../src/main/voc/settings';

const FAKE_CLI = path.resolve(__dirname, '../fixtures/fake-voc-cli.mjs');
const FAKE_SERVER = pathToFileURL(path.resolve(__dirname, '../fixtures/fake-voc-server.mjs')).href;
const FIXTURE = path.resolve(__dirname, '../fixtures/voc');
const TODAY = '2026-09-23';
const FAKE_NOW = '2026-09-23T01:00:00Z';
const NOW = new Date(FAKE_NOW);
/** 가짜 fetch 시험의 백엔드 주소 — 시험 가드(localhost 만)를 지나도록. 가짜 fetch 라 실제로 열지 않는다 */
const API = 'http://127.0.0.1:18080';
const PASSWORD = 'secret';

const temps: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-vocapi-'));
  temps.push(dir);
  return dir;
}

const fixture = <T = unknown>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURE, name), 'utf8')) as T;

// ---- 가짜 fetch(요청 기록 + 응답 주입) ------------------------------------------------------------

interface Rec {
  method: string;
  url: URL;
  /** 앱이 보낸 머리글(이름 그대로) */
  headers: Record<string, string>;
  /** JSON 본문(없으면 undefined) */
  body: unknown;
}

type Responder = (r: Rec, signal: AbortSignal) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function recordingFetch(respond: Responder): { calls: Rec[]; fetchImpl: typeof fetch } {
  const calls: Rec[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const rawBody = init?.body;
    const rec: Rec = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers,
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    };
    calls.push(rec);
    return respond(rec, init?.signal as AbortSignal);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** 응답하지 않다가 멈추면(abort) 거부하는 요청 */
function hang(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

const TICKETS = fixture<Record<string, unknown>[]>('tickets.json');
const ticketOf = (id: number): Record<string, unknown> => ({ ...(TICKETS.find((t) => t.id === id) ?? TICKETS[0]), replyCount: null });
const PNG = fs.readFileSync(path.join(FIXTURE, 'files', '7001', 'screen.png'));

/** 가짜 fetch 용 작은 백엔드 — 고정 자료(test/fixtures/voc)로 답한다 */
const backend: Responder = (r) => {
  const p = r.url.pathname.replace(/^\/api\/v2/, '');
  const q = r.url.searchParams;
  const body = (r.body ?? {}) as Record<string, unknown>;
  let m: RegExpExecArray | null;
  if (r.method === 'POST' && p === '/auth/login') {
    if (body.password !== PASSWORD) return json(401, { message: '아이디 또는 비밀번호가 올바르지 않습니다' });
    return json(200, { accessToken: 'tok-new', refreshToken: 'ref-new', user: { loginId: body.loginId, name: '홍길동', role: 'staff' } });
  }
  if (r.method === 'GET' && p === '/tickets') {
    return json(200, { data: TICKETS.slice(0, 3), total: 3, page: Number(q.get('page')), pageSize: Number(q.get('size')), totalPages: 1 });
  }
  if ((m = /^\/tickets\/(\d+)$/.exec(p))) {
    const t = ticketOf(Number(m[1]));
    return json(200, r.method === 'PUT' ? { ...t, ...body } : t);
  }
  if ((m = /^\/tickets\/(\d+)\/replies$/.exec(p))) {
    if (r.method === 'POST') return json(201, { id: 5009, ticketId: Number(m[1]), content: body.content });
    return json(200, fixture('replies/1004.json'));
  }
  if (r.method === 'POST' && p === '/tickets') return json(201, { ...ticketOf(1001), id: 1100, ticketNumber: 'VOC-2026-0100', title: body.title });
  if (p === '/users') return json(200, fixture('users.json'));
  if (p === '/admin/codes') return json(200, fixture('codes-request-type.json'));
  if (p === '/admin/customers') return json(200, fixture('customers.json'));
  if (p === '/auth/me') return json(200, { loginId: 'hong', name: '홍길동', email: 'owner@example.com', role: 'staff', department: '샘플팀', customerName: null });
  if (r.method === 'GET' && p === '/work-logs') {
    return json(200, fixture<{ entityId: number }[]>('worklogs.json').filter((w) => w.entityId === Number(q.get('entityId'))));
  }
  if (r.method === 'POST' && p === '/work-logs') {
    return json(201, { id: 8100, ...body, minutes: Number(body.hours) * 60, userId: 101, userName: '홍길동' });
  }
  if (r.method === 'POST' && /^\/work-logs\/\d+\/delete$/.test(p)) return new Response(null, { status: 204 });
  if (/^\/tickets\/\d+\/email-logs$/.test(p)) return json(200, fixture('email-logs.json'));
  if (r.method === 'POST' && /^\/tickets\/\d+\/email$/.test(p)) return new Response(null, { status: 200 });
  if ((m = /^\/files\/(\d+)\/download$/.exec(p))) {
    return new Response(PNG, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('screen.png')}` },
    });
  }
  return json(404, { message: `없는 경로: ${r.method} ${p}` });
};

const SESSION: VocSession = { apiUrl: API, accessToken: 'tok-a1', refreshToken: 'ref-1', loginId: 'hong', userName: '홍길동', role: 'staff' };

interface Kit {
  runner: VocApiRunner;
  calls: Rec[];
  store: VocSessionStore;
  sessionFile: string;
  usageFile: string;
  filesDir: string;
  /** 바꿀 수 있는 지금 설정 주소 */
  url: { value: string };
}

/** 가짜 fetch 로 도는 실행기. session 을 주면 메모리 세션으로 미리 넣는다(codec 없음) */
function kit(
  o: { respond?: Responder; session?: VocSession | null; codec?: VocSessionCodec | null; apiUrl?: string; usageFile?: string | null; refreshTimeoutMs?: number } = {},
): Kit {
  const dir = tempDir();
  const sessionFile = path.join(dir, 'voc-session.bin');
  const usageFile = path.join(dir, 'usage', 'usage.jsonl');
  const filesDir = path.join(dir, 'voc-files');
  const store = new VocSessionStore(sessionFile, o.codec ?? null);
  const session = o.session === undefined ? SESSION : o.session;
  if (session) store.save(session);
  const url = { value: o.apiUrl ?? API };
  const { calls, fetchImpl } = recordingFetch(o.respond ?? backend);
  const opts: VocApiRunnerOptions = {
    apiUrl: () => url.value,
    sessions: store,
    downloadRoot: filesDir,
    usageFile: o.usageFile === undefined ? usageFile : o.usageFile,
    appVersion: '9.9.9',
    fetchImpl,
  };
  if (o.refreshTimeoutMs !== undefined) opts.refreshTimeoutMs = o.refreshTimeoutMs;
  return { runner: new VocApiRunner(opts), calls, store, sessionFile, usageFile, filesDir, url };
}

/** 사용량 기록 줄 */
function usageRows(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 되돌릴 수 있는 가짜 암호화(바이트 뒤집기 + XOR) — 파일에 토큰이 평문으로 남지 않는지 본다 */
const fakeCodec: VocSessionCodec = {
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a).reverse()),
  decrypt: (data) => Buffer.from(Buffer.from(data).reverse().map((b) => b ^ 0x5a)).toString('utf8'),
};

const ok = (r: VocRunResult): void => {
  expect(r.stderr).toBe('');
  expect(r).toMatchObject({ code: 0, timedOut: false });
};

/** 비어 있는 localhost 포트(열었다 닫는다) — 연결 거부 시험용 */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

// ---- 1. 순수 함수 --------------------------------------------------------------------------------

describe('normalizeVocApiUrl', () => {
  it('http(s)://호스트[:포트] 만 — 끝 / 와 앞뒤 공백은 떼고 기본 포트·대문자는 URL 규칙대로', () => {
    expect(normalizeVocApiUrl('https://voc.example.test:11300/')).toBe('https://voc.example.test:11300');
    expect(normalizeVocApiUrl('  http://127.0.0.1:8080//  ')).toBe('http://127.0.0.1:8080');
    expect(normalizeVocApiUrl('HTTPS://Voc.Example.Test')).toBe('https://voc.example.test');
    expect(normalizeVocApiUrl('https://voc.example.test:443')).toBe('https://voc.example.test');
    expect(normalizeVocApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeVocApiUrl('http://[::1]:9000')).toBe('http://[::1]:9000');
    expect(normalizeVocApiUrl(VOC_DEFAULT_API_URL)).toBe(VOC_DEFAULT_API_URL);
  });

  it('평문 http 는 이 PC(루프백)에만 — 그 밖의 호스트는 https 만(비밀번호·토큰이 평문으로 나가지 않게)', () => {
    for (const bad of ['http://voc.acme.test:11300', 'http://voc.example.test', 'http://10.0.0.5:8080', 'http://127.0.0.1.example.test', 'http://localhost.example.test']) {
      expect(normalizeVocApiUrl(bad), bad).toBeNull();
    }
    expect(normalizeVocApiUrl('https://10.0.0.5:8080')).toBe('https://10.0.0.5:8080');
    expect(normalizeVocApiUrl('HTTP://LOCALHOST:3000')).toBe('http://localhost:3000');
  });

  it('경로·쿼리·조각·계정·다른 프로토콜·빈 값·너무 긴 값·문자열 아님은 null', () => {
    for (const bad of [
      'https://voc.example.test/api',
      'https://voc.example.test/api/v2',
      'https://voc.example.test?x=1',
      'https://voc.example.test#a',
      'https://user:pw@voc.example.test',
      'https://user@voc.example.test',
      'ftp://voc.example.test',
      'file:///C:/x',
      'javascript:alert(1)',
      'voc.example.test:11300',
      '',
      '   ',
      `https://${'a'.repeat(200)}.test`,
      undefined,
      null,
      42,
      {},
    ]) {
      expect(normalizeVocApiUrl(bad)).toBeNull();
    }
  });
});

describe('extractApiError(voc-cli VocApiClient.extractError 와 같게)', () => {
  it('message → detail → error 순서, null 은 건너뛰고 숫자·참거짓은 글자로', () => {
    expect(extractApiError('{"message":"담당자가 없습니다","detail":"d","error":"e"}')).toBe('담당자가 없습니다');
    expect(extractApiError('{"detail":"자세히","error":"e"}')).toBe('자세히');
    expect(extractApiError('{"error":"Bad Request"}')).toBe('Bad Request');
    expect(extractApiError('{"message":null,"error":"Forbidden"}')).toBe('Forbidden');
    expect(extractApiError('{"message":404}')).toBe('404');
    expect(extractApiError('{"message":false}')).toBe('false');
    // 객체·배열 값은 jackson asText() 처럼 빈 글자
    expect(extractApiError('{"message":{"a":1}}')).toBe('');
  });

  it('JSON 이 아니거나 해당 키가 없으면 본문(300자 넘으면 300자 + …), 비면 (응답 본문 없음)', () => {
    expect(extractApiError('<html>Bad Gateway</html>')).toBe('<html>Bad Gateway</html>');
    expect(extractApiError('{"status":500}')).toBe('{"status":500}');
    expect(extractApiError('[1,2]')).toBe('[1,2]');
    const long = 'x'.repeat(301);
    expect(extractApiError(long)).toBe(`${'x'.repeat(300)}…`);
    expect(extractApiError('y'.repeat(300))).toBe('y'.repeat(300));
    expect(extractApiError('')).toBe('(응답 본문 없음)');
    expect(extractApiError('  \n ')).toBe('(응답 본문 없음)');
  });
});

describe('filenameFromDisposition(voc-cli VocApiClient 와 같게)', () => {
  it('filename* (RFC 5987) 가 먼저 — 순서와 무관, + 는 공백이 아니라 +', () => {
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''${encodeURIComponent('화면 캡처.png')}`)).toBe('화면 캡처.png');
    expect(filenameFromDisposition(`attachment; filename="fallback.png"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf`)).toBe('보고서.pdf');
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''a+b.txt; filename="x.txt"`)).toBe('a+b.txt');
    // 문자 집합 표시(ISO-8859-1)는 그 문자 집합으로 읽는다
    expect(filenameFromDisposition(`attachment; filename*=ISO-8859-1''caf%E9.txt`)).toBe('café.txt');
    // 문자 집합 없이 '' 만 있어도 UTF-8
    expect(filenameFromDisposition(`attachment; filename*=''%ED%8C%8C%EC%9D%BC.txt`)).toBe('파일.txt');
    // 잘못된 % 는 원문 그대로(이어서 sanitizeFilename 을 거친다)
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''bad%zz.txt`)).toBe('bad%zz.txt');
  });

  it('UTF-8 밖 문자 집합도 그 문자 집합으로 읽는다(voc-cli 의 Charset.forName) — 모르는 이름만 UTF-8', () => {
    // '계약서' 의 EUC-KR(=MS949) 바이트
    const euckr = '%B0%E8%BE%E0%BC%AD';
    expect(filenameFromDisposition(`attachment; filename*=EUC-KR''${euckr}.pdf`)).toBe('계약서.pdf');
    expect(filenameFromDisposition(`attachment; filename*=euc-kr''${euckr}.pdf`)).toBe('계약서.pdf');
    // java 이름(x-windows-949·MS949)도 euc-kr 디코더로(KS X 1001 글자)
    expect(filenameFromDisposition(`attachment; filename*=x-windows-949''${euckr}.pdf`)).toBe('계약서.pdf');
    expect(filenameFromDisposition(`attachment; filename*=MS949''${euckr}.pdf`)).toBe('계약서.pdf');
    // '日本' 의 Shift_JIS, '가' 의 UTF-16(BOM 없으면 big-endian)
    expect(filenameFromDisposition(`attachment; filename*=Shift_JIS''%93%FA%96%7B.txt`)).toBe('日本.txt');
    expect(filenameFromDisposition(`attachment; filename*=UTF-16''%AC%00.txt`)).toBe('가.txt');
    expect(filenameFromDisposition(`attachment; filename*=UTF-16LE''%00%AC.txt`)).toBe('가.txt');
    // 모르는 이름은 UTF-8, US-ASCII 는 latin1 그대로
    expect(filenameFromDisposition(`attachment; filename*=x-unknown-cs''%ED%8C%8C%EC%9D%BC.txt`)).toBe('파일.txt');
    expect(filenameFromDisposition(`attachment; filename*=US-ASCII''a%41.txt`)).toBe('aA.txt');
    // UTF-8 로 읽었다면 깨졌을 바이트가 U+FFFD 로 남지 않는다
    expect(filenameFromDisposition(`attachment; filename*=EUC-KR''${euckr}.pdf`)).not.toContain('\uFFFD');
  });

  it('filename= 은 따옴표를 떼고, 여러 개면 마지막 것, 키는 대소문자 무관. 없으면 null', () => {
    expect(filenameFromDisposition('attachment; filename="report 1.pdf"')).toBe('report 1.pdf');
    expect(filenameFromDisposition('attachment; filename=plain.txt')).toBe('plain.txt');
    expect(filenameFromDisposition('attachment; FileName="Upper.TXT"')).toBe('Upper.TXT');
    expect(filenameFromDisposition('attachment; filename="a.txt"; filename="b.txt"')).toBe('b.txt');
    expect(filenameFromDisposition('attachment; filename="')).toBe('"');
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition('')).toBeNull();
    expect(filenameFromDisposition('   ')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

describe('sanitizeFilename(voc-cli FileDownloadCommand.sanitizeFilename 과 같게)', () => {
  it('없으면 file-<id>, 경로는 마지막 조각만', () => {
    expect(sanitizeFilename(null, 7001)).toBe('file-7001');
    expect(sanitizeFilename('../../evil.exe', 1)).toBe('evil.exe');
    expect(sanitizeFilename('C:\\Windows\\System32\\x.dll', 1)).toBe('x.dll');
    expect(sanitizeFilename('a/b\\c/d.txt', 1)).toBe('d.txt');
    expect(sanitizeFilename('folder/', 9)).toBe('file-9');
  });

  it('제어 문자·DEL·Windows 금지 글자(<>:"/\\|?*)는 _ 로', () => {
    expect(sanitizeFilename('a<b>:c"d|e?f*g.txt', 1)).toBe('a_b__c_d_e_f_g.txt');
    expect(sanitizeFilename('tab\there\u0000x\u007f.log', 1)).toBe('tab_here_x_.log');
    expect(sanitizeFilename('줄\n바꿈.txt', 1)).toBe('줄_바꿈.txt');
  });

  it('앞의 점·공백, 끝의 점·공백은 뗀다 — 남는 것이 없으면 file-<id>. ASCII 공백만(java \\s) — nbsp·전각 공백은 그대로', () => {
    expect(sanitizeFilename('...hidden. . ', 3)).toBe('hidden');
    expect(sanitizeFilename(' .env', 3)).toBe('env');
    expect(sanitizeFilename(' . ', 3)).toBe('file-3');
    expect(sanitizeFilename('..', 3)).toBe('file-3');
    expect(sanitizeFilename('\u00a0a.txt\u3000', 3)).toBe('\u00a0a.txt\u3000');
    // 제어 문자는 먼저 _ 가 되므로 앞뒤에서 떼지 않는다(java 와 같은 순서)
    expect(sanitizeFilename('\tname.txt\r', 3)).toBe('_name.txt_');
  });

  it('예약 장치 이름(첫 점 앞이 CON·PRN·AUX·NUL·COM0-9·LPT0-9, 대소문자 무관)은 앞에 _', () => {
    expect(sanitizeFilename('CON.txt', 1)).toBe('_CON.txt');
    expect(sanitizeFilename('nul', 1)).toBe('_nul');
    expect(sanitizeFilename('com1.tar.gz', 1)).toBe('_com1.tar.gz');
    expect(sanitizeFilename('Lpt9', 1)).toBe('_Lpt9');
    expect(sanitizeFilename('CONSOLE.txt', 1)).toBe('CONSOLE.txt');
    expect(sanitizeFilename('com10.txt', 1)).toBe('com10.txt');
    expect(sanitizeFilename('my.con', 1)).toBe('my.con');
  });

  it('200자 넘으면 자른다 — 확장자(마지막 점부터 20자 이하)는 살린다', () => {
    const long = `${'가'.repeat(250)}.pdf`;
    const cut = sanitizeFilename(long, 1);
    expect(cut).toHaveLength(200);
    expect(cut.endsWith('.pdf')).toBe(true);
    const longExt = `${'b'.repeat(190)}.${'e'.repeat(25)}`;
    expect(sanitizeFilename(longExt, 1)).toBe(longExt.slice(0, 200));
    const exactly = 'c'.repeat(200);
    expect(sanitizeFilename(exactly, 1)).toBe(exactly);
  });
});

describe('usageLabel(voc-cli CliRunner 의 계측 라벨)', () => {
  it("'-' 로 시작하는 인자 전까지 최대 3개", () => {
    expect(usageLabel(['ticket', 'get', '1001', '--json'])).toBe('ticket get 1001');
    expect(usageLabel(['ticket', 'update', '1001', '--assignee', '12', '--json'])).toBe('ticket update 1001');
    expect(usageLabel([...VOC_LIST_ARGS])).toBe('ticket list');
    expect(usageLabel(['whoami'])).toBe('whoami');
    expect(usageLabel(['code', 'list', 'REQUEST_TYPE', '--json'])).toBe('code list REQUEST_TYPE');
    expect(usageLabel(['a', 'b', 'c', 'd', 'e'])).toBe('a b c');
    expect(usageLabel(vocDownloadArgs(7001, path.join(os.tmpdir(), 'voc-files', '1004')))).toBe('file download 7001');
    expect(usageLabel(['--json'])).toBe('');
    expect(usageLabel([])).toBe('');
  });
});

// ---- 2. 요청 모양(가짜 fetch) ---------------------------------------------------------------------

interface Shape {
  name: string;
  args: string[];
  /** 기대 요청(차례대로) */
  requests: { method: string; path: string; query?: Record<string, string>; body?: unknown }[];
  /** 표준출력 검사 */
  stdout: (out: string, k: Kit) => void;
}

const DL_DIR = (k: Kit): string => path.join(k.filesDir, '1004');

const SHAPES: Shape[] = [
  {
    name: '진행 중 목록(VOC_LIST_ARGS)',
    args: [...VOC_LIST_ARGS],
    requests: [{ method: 'GET', path: '/api/v2/tickets', query: { showCompleted: 'false', page: '1', size: '2000' } }],
    stdout: (out) => {
      const list = parseTicketList(out);
      expect(list).toMatchObject({ total: 3, page: 1, totalPages: 1 });
      expect(list.data).toHaveLength(3);
    },
  },
  {
    name: '목록 다음 쪽(--page 2)',
    args: [...VOC_LIST_ARGS, '--page', '2'],
    requests: [{ method: 'GET', path: '/api/v2/tickets', query: { showCompleted: 'false', page: '2', size: '2000' } }],
    stdout: (out) => expect(parseTicketList(out).page).toBe(2),
  },
  {
    name: '사용자 목록',
    args: ['user', 'list', '--role', 'staff,admin', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/users', query: { role: 'staff,admin' } }],
    stdout: (out) => expect(parseUsers(out).map((u) => u.id)).toContain(101),
  },
  {
    name: '요청유형 코드',
    args: ['code', 'list', 'REQUEST_TYPE', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/admin/codes', query: { groupCode: 'REQUEST_TYPE' } }],
    stdout: (out) => expect(parseCodes(out).map((c) => c.code)).toContain('inquiry'),
  },
  {
    name: '고객사 목록',
    args: ['customer', 'list', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/admin/customers', query: {} }],
    stdout: (out) => expect(parseCustomers(out).map((c) => c.id)).toContain(11),
  },
  {
    name: 'whoami(글 출력 — parseWhoami, 백엔드 줄은 세션 주소)',
    args: ['whoami'],
    requests: [{ method: 'GET', path: '/api/v2/auth/me', query: {} }],
    stdout: (out) => {
      expect(out).toBe(
        [
          '로그인 ID   : hong',
          '이름        : 홍길동',
          '이메일      : owner@example.com',
          '권한(role)  : staff',
          '부서        : 샘플팀',
          `백엔드      : ${API}`,
          '',
        ].join('\n'),
      );
      expect(parseWhoami(out)).toEqual({ loginId: 'hong', name: '홍길동', email: 'owner@example.com', department: '샘플팀', backend: API });
    },
  },
  {
    name: '티켓 상세 + 답변(두 번 부른다)',
    args: ['ticket', 'get', '1004', '--replies', '--json'],
    requests: [
      { method: 'GET', path: '/api/v2/tickets/1004', query: {} },
      { method: 'GET', path: '/api/v2/tickets/1004/replies', query: {} },
    ],
    stdout: (out) => {
      const d = parseTicketDetail(out, TODAY, []);
      expect(d?.ticket.id).toBe(1004);
      expect(d?.replies?.length).toBeGreaterThan(0);
      expect(d?.attachments?.map((a) => a.id)).toEqual([7001, 7002, 7003]);
    },
  },
  {
    name: '티켓 상세(답변 없이)',
    args: ['ticket', 'get', '1006', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/tickets/1006', query: {} }],
    stdout: (out) => {
      const t = JSON.parse(out) as Record<string, unknown>;
      expect(t.id).toBe(1006);
      expect(t).not.toHaveProperty('replies');
    },
  },
  {
    name: '담당 지정 + new → assigned',
    args: ['ticket', 'update', '1001', '--assignee', '102', '--status', 'assigned', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1001', body: { status: 'assigned', internalAssigneeId: 102 } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 1001, status: 'assigned', internalAssigneeId: 102 }),
  },
  {
    name: '담당 지정만',
    args: ['ticket', 'update', '1003', '--assignee', '103', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1003', body: { internalAssigneeId: 103 } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 1003 }),
  },
  {
    name: 'ICT 예상완료일(YYYY-MM-DDT00:00:00 — voc-cli Dates.toDateTime)',
    args: ['ticket', 'update', '1004', '--ict-due', '2026-10-05', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1004', body: { ictDueDate: '2026-10-05T00:00:00' } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ ictDueDate: '2026-10-05T00:00:00' }),
  },
  {
    name: 'ICT 예상완료일 지우기',
    args: ['ticket', 'update', '1006', '--clear-ict-due', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1006', body: { clearIctDueDate: true } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 1006 }),
  },
  {
    name: '우선순위',
    args: ['ticket', 'update', '1003', '-p', 'P1', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1003', body: { priority: 'P1' } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ priority: 'P1' }),
  },
  {
    name: '상태(-s)',
    args: ['ticket', 'update', '1006', '-s', 'pending', '--json'],
    requests: [{ method: 'PUT', path: '/api/v2/tickets/1006', body: { status: 'pending' } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ status: 'pending' }),
  },
  {
    name: '답변(글 출력 — 답변 id)',
    args: ['ticket', 'reply', '1002', '--content=<p>-p @확인 * 했습니다.</p>'],
    requests: [{ method: 'POST', path: '/api/v2/tickets/1002/replies', body: { content: '<p>-p @확인 * 했습니다.</p>' } }],
    stdout: (out) => expect(out).toBe('답변이 등록되었습니다. (답변 id=5009)\n'),
  },
  {
    name: '티켓 등록(메일 → VOC)',
    args: [
      'ticket', 'create',
      '--title=-통영공장 인벤토리 확인 요청',
      '--desc=<p>8월 사용량이 보이지 않습니다.</p>',
      '--customer-id', '11',
      '--system', 'SYS0101',
      '--type', 'inquiry',
      '-p', 'P3',
      '--assignee', '102',
      '--source', 'email',
      '--json',
    ],
    requests: [
      {
        method: 'POST',
        path: '/api/v2/tickets',
        body: {
          title: '-통영공장 인벤토리 확인 요청',
          description: '<p>8월 사용량이 보이지 않습니다.</p>',
          priority: 'P3',
          customerId: 11,
          system: 'SYS0101',
          requestType: 'inquiry',
          internalAssigneeId: 102,
          source: 'email',
        },
      },
    ],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 1100, ticketNumber: 'VOC-2026-0100' }),
  },
  {
    name: '티켓 등록(내용·담당 없이)',
    args: ['ticket', 'create', '--title=제목만', '--customer-id', '12', '--system', 'SYS0102', '--type', 'bug', '-p', 'P2', '--source', 'email', '--json'],
    requests: [
      {
        method: 'POST',
        path: '/api/v2/tickets',
        body: { title: '제목만', priority: 'P2', customerId: 12, system: 'SYS0102', requestType: 'bug', source: 'email' },
      },
    ],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 1100 }),
  },
  {
    name: '작업시간 목록',
    args: ['worklog', 'list', '1005', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/work-logs', query: { entityType: 'ticket', entityId: '1005' } }],
    stdout: (out) => expect(parseWorkLogs(out).map((w) => w.id)).toEqual([8001, 8002]),
  },
  {
    name: '메일 발송 기록',
    args: ['ticket', 'email-logs', '1004', '--json'],
    requests: [{ method: 'GET', path: '/api/v2/tickets/1004/email-logs', query: {} }],
    stdout: (out) => expect(parseEmailLogs(out).map((x) => x.id)).toEqual([9501]),
  },
  {
    name: '작업시간 넣기(메모)',
    args: ['worklog', 'add', '1004', '--hours=1.5', `--date=${TODAY}`, '--note=-p @원인 확인 *', '--json'],
    requests: [
      { method: 'POST', path: '/api/v2/work-logs', body: { entityType: 'ticket', entityId: 1004, workDate: TODAY, hours: 1.5, note: '-p @원인 확인 *' } },
    ],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ id: 8100, hours: 1.5, workDate: TODAY }),
  },
  {
    name: '작업시간 넣기(메모 없음 → note null)',
    args: ['worklog', 'add', '1006', '--hours=2', `--date=${TODAY}`, '--json'],
    requests: [{ method: 'POST', path: '/api/v2/work-logs', body: { entityType: 'ticket', entityId: 1006, workDate: TODAY, hours: 2, note: null } }],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ note: null }),
  },
  {
    name: '작업시간 지우기(글 출력, 본문 {})',
    args: ['worklog', 'delete', '8001', '-y'],
    requests: [{ method: 'POST', path: '/api/v2/work-logs/8001/delete', body: {} }],
    stdout: (out) => expect(out).toBe('삭제했습니다: 작업 로그 id=8001\n'),
  },
  {
    name: '고객 메일(참조·답변 id)',
    args: ['ticket', 'email', '1004', '--to=ops@haeon.example', '--cc=kim@example.com', '--reply-id=5001,5003', '--json'],
    requests: [
      {
        method: 'POST',
        path: '/api/v2/tickets/1004/email',
        body: { toAddresses: ['ops@haeon.example'], ccAddresses: ['kim@example.com'], changeStatus: false, replyIds: [5001, 5003] },
      },
    ],
    stdout: (out) =>
      expect(JSON.parse(out)).toEqual({
        ticketId: 1004,
        sent: true,
        toAddresses: ['ops@haeon.example'],
        ccAddresses: ['kim@example.com'],
        changeStatus: false,
        replyIds: [5001, 5003],
      }),
  },
  {
    name: '고객 메일 + 해결(--resolve, 참조·답변 없음 → 빈 배열·null)',
    args: ['ticket', 'email', '1004', '--to=ops@haeon.example,lead@haeon.example', '--resolve', '--json'],
    requests: [
      {
        method: 'POST',
        path: '/api/v2/tickets/1004/email',
        body: { toAddresses: ['ops@haeon.example', 'lead@haeon.example'], ccAddresses: [], changeStatus: true, replyIds: null },
      },
    ],
    stdout: (out) => expect(JSON.parse(out)).toMatchObject({ changeStatus: true, replyIds: null }),
  },
  ...(
    [
      ['resolve', 'resolved', '해결(resolved) 처리했습니다.'],
      ['close', 'closed', '완료(closed) 처리했습니다.'],
      ['reopen', 'assigned', '재오픈(assigned)했습니다.'],
    ] as const
  ).map(
    ([cmd, status, head]): Shape => ({
      name: `ticket ${cmd}(글 출력 — voc-cli Tickets.changeStatus)`,
      args: ['ticket', cmd, '1006'],
      requests: [{ method: 'PUT', path: '/api/v2/tickets/1006', body: { status } }],
      stdout: (out) => {
        const t = ticketOf(1006);
        expect(out).toBe(
          [
            head,
            `  번호    : ${t.ticketNumber}  (id=1006)`,
            `  제목    : ${t.title}`,
            `  상태    : ${status}   우선순위: ${t.priority}`,
            `  담당자  : ${t.internalAssigneeName}`,
            '',
          ].join('\n'),
        );
      },
    }),
  ),
  {
    name: '첨부 내려받기(Accept */*, 서버 파일명으로 폴더 안에)',
    args: [],
    requests: [{ method: 'GET', path: '/api/v2/files/7001/download', query: {} }],
    stdout: (out, k) => {
      const parsed = parseDownloadOutput(out);
      expect(parsed).toEqual({ path: path.join(DL_DIR(k), 'screen.png'), filename: 'screen.png', size: PNG.length });
      expect(JSON.parse(out).contentType).toBe('image/png');
      expect(fs.readFileSync(parsed.path).equals(PNG)).toBe(true);
    },
  },
];

describe('요청 모양 — 앱이 만드는 모든 인자(가짜 fetch, 네트워크 없음)', () => {
  for (const s of SHAPES) {
    it(s.name, async () => {
      const k = kit();
      const args = s.args.length > 0 ? s.args : vocDownloadArgs(7001, DL_DIR(k));
      const r = await k.runner.run(args);
      ok(r);
      expect(k.calls.map((c) => ({ method: c.method, path: c.url.pathname }))).toEqual(s.requests.map((q) => ({ method: q.method, path: q.path })));
      s.requests.forEach((q, i) => {
        const c = k.calls[i];
        expect(c.url.origin).toBe(API);
        if (q.query) expect(Object.fromEntries(c.url.searchParams)).toEqual(q.query);
        if (q.body !== undefined) expect(c.body).toEqual(q.body);
        else expect(c.body).toBeUndefined();
        // 머리글: Bearer·클라이언트 이름·User-Agent, 본문이 있을 때만 Content-Type
        expect(c.headers.Authorization).toBe('Bearer tok-a1');
        expect(c.headers['X-Client']).toBe(VOC_CLIENT_ID);
        expect(c.headers['X-Client']).toBe('wiki-radar');
        expect(c.headers['User-Agent']).toBe('wiki-radar/9.9.9');
        expect(c.headers.Accept).toBe(q.path.endsWith('/download') ? '*/*' : 'application/json');
        if (q.body !== undefined) expect(c.headers['Content-Type']).toBe('application/json');
        else expect(c.headers).not.toHaveProperty('Content-Type');
      });
      s.stdout(r.stdout, k);
    });
  }

  it('JSON 출력은 들여쓴 JSON 한 덩이 + 줄바꿈(voc-cli 처럼)', async () => {
    const k = kit();
    const r = await k.runner.run(['customer', 'list', '--json']);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout).toBe(`${JSON.stringify(fixture('customers.json'), null, 2)}\n`);
  });

  it('whoami: 서버 값이 없거나 null 이면 -, 고객사는 있을 때만', async () => {
    const k = kit({
      respond: () => json(200, { loginId: 'cust1', name: null, role: 'customer', customerName: '해온정밀' }),
    });
    const r = await k.runner.run(['whoami']);
    ok(r);
    expect(r.stdout).toBe(
      ['로그인 ID   : cust1', '이름        : -', '이메일      : -', '권한(role)  : customer', '부서        : -', '고객사      : 해온정밀', `백엔드      : ${API}`, ''].join(
        '\n',
      ),
    );
    expect(parseWhoami(r.stdout)).toEqual({ loginId: 'cust1', backend: API });
  });

  it('답변·상태 요약: 응답에 값이 없으면 빈 글자(voc-cli Tickets.str), 담당자가 비면 줄 없음', async () => {
    const k = kit({ respond: (r) => (r.method === 'POST' ? json(201, {}) : json(200, { id: 1006, status: 'resolved', internalAssigneeName: '  ' })) });
    expect((await k.runner.run(['ticket', 'reply', '1006', '--content=확인'])).stdout).toBe('답변이 등록되었습니다. (답변 id=)\n');
    expect((await k.runner.run(['ticket', 'resolve', '1006'])).stdout).toBe(
      ['해결(resolved) 처리했습니다.', '  번호    :   (id=1006)', '  제목    : ', '  상태    : resolved   우선순위: ', ''].join('\n'),
    );
  });

  it('로그인: POST /auth/login {loginId, password} — Bearer 없음, 성공 문장은 service 가 읽는 모양, 비밀번호는 출력에 없다', async () => {
    const k = kit({ session: null });
    const r = await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n`, write: true });
    ok(r);
    expect(k.calls).toHaveLength(1);
    const c = k.calls[0];
    expect([c.method, c.url.href]).toEqual(['POST', `${API}/api/v2/auth/login`]);
    expect(c.body).toEqual({ loginId: 'hong', password: PASSWORD });
    expect(c.headers).not.toHaveProperty('Authorization');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(r.stdout).toBe(`로그인 성공: 홍길동 (staff) @ ${API}\n세션 저장 위치: ${k.store.location}\n`);
    // service 의 loginVerdict 가 보는 줄
    expect(/로그인 성공\s*[:：]\s*([^\r\n]*)/.exec(r.stdout)?.[1]).toBe(`홍길동 (staff) @ ${API}`);
    expect(`${r.stdout}${r.stderr}`).not.toContain(PASSWORD);
    expect(k.store.load()).toEqual({ apiUrl: API, accessToken: 'tok-new', refreshToken: 'ref-new', loginId: 'hong', userName: '홍길동', role: 'staff' });
  });
});

describe('인자 오류(종료 코드 2)·입력 검사(오류: … 종료 코드 1, voc-cli 문장)', () => {
  it('앱이 만들지 않는 모양은 사용법 오류(2) — 서버를 부르지 않고 classify 는 앱 버그', async () => {
    const k = kit();
    for (const args of [
      ['ticket', 'list', '--bogus'],
      ['ticket', 'list', '--json=1'],
      ['ticket', 'list', '--size'],
      ['ticket', 'list', '--size', '0', '--json'],
      ['ticket', 'list', '--page', 'x', '--json'],
      ['ticket', 'get', 'abc', '--json'],
      ['ticket', 'get', '0', '--json'],
      ['ticket', 'get', '1', '2', '--json'],
      ['ticket', 'get', '--json'],
      ['ticket', 'update', '1', '--assignee', 'kim', '--json'],
      ['ticket', 'update', '1', '-p', 'P1', '-p', 'P2', '--json'],
      ['ticket', 'update', '1', '-s', 'new', '--status', 'new', '--json'],
      ['ticket', 'update', '1', '--title=x', '--json'],
      ['worklog', 'add', '1', '--hours=abc', `--date=${TODAY}`, '--json'],
      ['worklog', 'add', '1', '--hours=', `--date=${TODAY}`, '--json'],
      ['worklog', 'add', '1', `--date=${TODAY}`, '--json'],
      ['worklog', 'add', '1', '--hours=1', '--json'],
      ['ticket', 'email', '1', '--to=a@b.example', '--reply-id=x', '--json'],
      ['code', 'list', '--json'],
      ['whoami', 'extra'],
      ['ticket', 'resolve', '1', '--json'],
    ]) {
      const r = await k.runner.run(args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.stderr).toMatch(/^오류: /);
      expect(classifyVocFailure(r)).toEqual({ state: 'unavailable', message: VOC_USAGE_ERROR_MESSAGE });
    }
    expect(k.calls).toEqual([]);
  });

  it('값 검사는 voc-cli 와 같은 문장으로 종료 코드 1 — classify 는 api(그 문장)', async () => {
    const k = kit();
    const cases: [string[], string][] = [
      [['ticket', 'update', '1', '--json'], '변경할 필드를 하나 이상 지정하세요. (예: --status resolved)'],
      [['ticket', 'update', '1', '-p', 'P9', '--json'], '우선순위는 P1/P2/P3 중 하나여야 합니다: P9'],
      [['ticket', 'update', '1', '--ict-due', '2026-02-30', '--json'], '날짜 형식이 올바르지 않습니다: 2026-02-30 (YYYY-MM-DD)'],
      [['ticket', 'update', '1', '--ict-due', '2026/10/05', '--json'], '날짜 형식이 올바르지 않습니다: 2026/10/05 (YYYY-MM-DD)'],
      [['ticket', 'reply', '1', '--content=  '], '답변 내용을 입력하세요. (--content)'],
      [['ticket', 'create', '--title=t', '-p', 'P0', '--json'], '우선순위는 P1/P2/P3 중 하나여야 합니다: P0'],
      [['worklog', 'add', '1', '--hours=0', `--date=${TODAY}`, '--json'], '작업 시간은 0보다 크고 24 이하여야 합니다: 0.0 (--hours)'],
      [['worklog', 'add', '1', '--hours=25', `--date=${TODAY}`, '--json'], '작업 시간은 0보다 크고 24 이하여야 합니다: 25.0 (--hours)'],
      [['worklog', 'add', '1', '--hours=-1.5', `--date=${TODAY}`, '--json'], '작업 시간은 0보다 크고 24 이하여야 합니다: -1.5 (--hours)'],
      [['worklog', 'add', '1', '--hours=NaN', `--date=${TODAY}`, '--json'], '작업 시간은 0보다 크고 24 이하여야 합니다: NaN (--hours)'],
      [['worklog', 'add', '1', '--hours=1', '--date=2026-13-01', '--json'], '날짜 형식이 올바르지 않습니다: 2026-13-01 (YYYY-MM-DD)'],
      [['worklog', 'delete', '8001'], '확인 입력을 받을 콘솔이 없습니다. 삭제하려면 --yes 를 붙이세요.'],
      [['ticket', 'email', '1', '--to=담당 <ops@haeon.example>', '--json'], '이메일 형식이 올바르지 않습니다: 담당 <ops@haeon.example> (--to)'],
      [['ticket', 'email', '1', '--to=ops@haeon.example', '--cc=kim', '--json'], '이메일 형식이 올바르지 않습니다: kim (--cc)'],
      [['ticket', 'email', '1', '--to= , ', '--json'], '받는 사람 이메일을 입력하세요. (--to)'],
    ];
    for (const [args, message] of cases) {
      const r = await k.runner.run(args);
      expect({ args, code: r.code, stderr: r.stderr }).toEqual({ args, code: 1, stderr: `오류: ${message}\n` });
      expect(classifyVocFailure(r)).toEqual({ state: 'api', message });
    }
    // 상태 목록 문장(voc-cli 는 Set 이라 순서가 정해지지 않는다 — 앞뒤 모양만)
    const bad = await k.runner.run(['ticket', 'update', '1', '-s', 'done', '--json']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^오류: 상태는 \[[a-z_, ]+\] 중 하나여야 합니다: done\n$/);
    expect(k.calls).toEqual([]);
  });

  it('작업시간 1.5·24·앞뒤 공백·지수 표기는 받는다(java double)', async () => {
    const k = kit();
    for (const [text, hours] of [['24', 24], [' 1.5 ', 1.5], ['5e-1', 0.5], ['.5', 0.5]] as const) {
      ok(await k.runner.run(['worklog', 'add', '1004', `--hours=${text}`, `--date=${TODAY}`, '--json']));
      expect((k.calls.at(-1)?.body as { hours: number }).hours).toBe(hours);
    }
  });

  it('허용 목록 밖·표준입력을 login 밖에·폴더가 틀린 내려받기는 실행하지 않는다(VocRunError — 앱 버그)', async () => {
    const k = kit();
    const rejects = async (p: Promise<unknown>, re: RegExp) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(VocRunError);
      expect((err as VocRunError).failure.state).toBe('unavailable');
      expect((err as VocRunError).message).toMatch(re);
    };
    await rejects(k.runner.run(['ticket', 'delete', '1']), /허용하지 않는/);
    await rejects(k.runner.run(['logout']), /허용하지 않는/);
    await rejects(k.runner.run(['login', '-u', 'hong', `--password=${PASSWORD}`]), /허용하지 않는/);
    await rejects(k.runner.run(['ticket', 'list', '--json'], { stdin: 'x\n' }), /표준입력/);
    await rejects(k.runner.run(vocDownloadArgs(7001, os.tmpdir())), /밖/);
    await rejects(k.runner.run([]), /인자가 없습니다/);
    await rejects(k.runner.run(['ticket', 'get', '1\u0000', '--json']), /NUL/);
    const noRoot = new VocApiRunner({ apiUrl: () => API, sessions: k.store, usageFile: null, fetchImpl: recordingFetch(backend).fetchImpl });
    await rejects(noRoot.run(vocDownloadArgs(7001, path.join(k.filesDir, '1004'))), /폴더가 정해지지/);
    expect(k.calls).toEqual([]);
  });
});

// ---- 3. 인증 ---------------------------------------------------------------------------------------

describe('인증(세션·갱신·로그인)', () => {
  it('세션이 없으면 서버를 부르지 않고 "로그인이 필요합니다" → login', async () => {
    const k = kit({ session: null });
    const r = await k.runner.run([...VOC_LIST_ARGS]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('로그인이 필요합니다');
    expect(classifyVocFailure(r)).toEqual({ state: 'login', message: VOC_LOGIN_MESSAGE });
    expect(k.calls).toEqual([]);
  });

  it('401 이면 refresh 토큰으로 한 번 갱신하고 다시 부른다 — 토큰을 바꿔 저장, 사용량은 한 줄', async () => {
    let issued = 1;
    const k = kit({
      respond: (r) => {
        const p = r.url.pathname;
        if (p.endsWith('/auth/refresh')) {
          if ((r.body as { refreshToken?: string }).refreshToken !== `ref-${issued}`) return json(401, { message: 'invalid' });
          issued += 1;
          return json(200, { accessToken: `tok-a${issued}`, refreshToken: `ref-${issued}` });
        }
        if (r.headers.Authorization !== `Bearer tok-a${issued}` || issued === 1) return json(401, { message: '인증이 필요합니다' });
        return backend(r, new AbortController().signal);
      },
    });
    const r = await k.runner.run(['customer', 'list', '--json']);
    ok(r);
    expect(k.calls.map((c) => [c.method, c.url.pathname, c.headers.Authorization ?? null, c.body ?? null])).toEqual([
      ['GET', '/api/v2/admin/customers', 'Bearer tok-a1', null],
      ['POST', '/api/v2/auth/refresh', null, { refreshToken: 'ref-1' }],
      ['GET', '/api/v2/admin/customers', 'Bearer tok-a2', null],
    ]);
    expect(k.store.load()).toEqual({ ...SESSION, accessToken: 'tok-a2', refreshToken: 'ref-2' });
    expect(usageRows(k.usageFile).map((u) => [u.command, u.path, u.status])).toEqual([['customer list', '/admin/customers', 200]]);
    // 다음 호출은 새 토큰으로 바로
    ok(await k.runner.run(['customer', 'list', '--json']));
    expect(k.calls.at(-1)?.headers.Authorization).toBe('Bearer tok-a2');
    expect(k.calls).toHaveLength(4);
  });

  it('갱신 응답에 refresh 토큰이 없으면 있던 것을 그대로 쓴다', async () => {
    let refreshed = false;
    const k = kit({
      respond: (r) => {
        if (r.url.pathname.endsWith('/auth/refresh')) {
          refreshed = true;
          return json(200, { accessToken: 'tok-only' });
        }
        return refreshed ? backend(r, new AbortController().signal) : json(401, {});
      },
    });
    ok(await k.runner.run(['customer', 'list', '--json']));
    expect(k.store.load()).toMatchObject({ accessToken: 'tok-only', refreshToken: 'ref-1' });
  });

  it('갱신도 실패하면 세션을 지우고 "세션이 만료되었습니다" → login(만료 문장), 사용량은 남기지 않는다', async () => {
    for (const refreshAnswer of [json(401, { message: 'expired' }), json(500, {}), json(200, { refreshToken: 'x' })]) {
      const k = kit({ codec: fakeCodec, respond: (r) => (r.url.pathname.endsWith('/auth/refresh') ? refreshAnswer.clone() : json(401, {})) });
      expect(fs.existsSync(k.sessionFile)).toBe(true);
      const r = await k.runner.run([...VOC_LIST_ARGS]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('세션이 만료되었습니다');
      expect(classifyVocFailure(r)).toEqual({ state: 'login', message: VOC_EXPIRED_MESSAGE });
      expect(k.store.load()).toBeNull();
      expect(fs.existsSync(k.sessionFile)).toBe(false);
      expect(usageRows(k.usageFile)).toEqual([]);
      // 지운 뒤에는 서버를 부르지 않고 로그인 필요
      const n = k.calls.length;
      expect(classifyVocFailure(await k.runner.run([...VOC_LIST_ARGS])).message).toBe(VOC_LOGIN_MESSAGE);
      expect(k.calls).toHaveLength(n);
    }
  });

  it('refresh 토큰이 없는 세션은 401 에 바로 만료', async () => {
    const k = kit({ session: { ...SESSION, refreshToken: null }, respond: () => json(401, {}) });
    const r = await k.runner.run([...VOC_LIST_ARGS]);
    expect(classifyVocFailure(r)).toEqual({ state: 'login', message: VOC_EXPIRED_MESSAGE });
    expect(k.calls.map((c) => c.url.pathname)).toEqual(['/api/v2/tickets']);
    expect(k.store.load()).toBeNull();
  });

  it('설정 주소가 바뀌면 그 세션(다른 서버의 토큰)은 버리고 다시 로그인', async () => {
    const k = kit({ codec: fakeCodec });
    k.url.value = 'http://localhost:18081';
    const r = await k.runner.run([...VOC_LIST_ARGS]);
    expect(r.stderr).toContain('로그인이 필요합니다');
    expect(r.stderr).toContain('주소가 바뀌어');
    expect(classifyVocFailure(r).state).toBe('login');
    expect(k.calls).toEqual([]);
    expect(k.store.load()).toBeNull();
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    // 새 주소로 로그인하면 그 주소로 부른다
    ok(await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` }));
    ok(await k.runner.run(['customer', 'list', '--json']));
    expect(k.calls.map((c) => c.url.origin)).toEqual(['http://localhost:18081', 'http://localhost:18081']);
  });

  it('비밀번호가 틀리면 "로그인 실패: 아이디 또는 비밀번호를 확인하세요." — 세션 그대로, 비밀번호는 출력에 없다', async () => {
    const k = kit({ session: null, codec: fakeCodec });
    const r = await k.runner.run(vocLoginArgs('hong'), { stdin: 'wrong-pass-1\n' });
    expect(r).toEqual({ code: 1, stdout: '', stderr: '오류: 로그인 실패: 아이디 또는 비밀번호를 확인하세요.\n', timedOut: false });
    expect(classifyVocFailure(r)).toEqual({ state: 'api', message: '로그인 실패: 아이디 또는 비밀번호를 확인하세요.' });
    expect(k.store.load()).toBeNull();
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    expect(usageRows(k.usageFile)).toEqual([]);
  });

  it('로그인 서버 오류는 "<상태> — 문장", 빈 비밀번호는 voc-cli 의 콘솔 문장(서버를 부르지 않는다), 토큰 없는 응답은 파싱 실패', async () => {
    const k500 = kit({ session: null, respond: () => json(503, { message: '점검 중입니다' }) });
    const r = await k500.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    expect(r.stderr).toBe('오류: 503 — 점검 중입니다\n');
    expect(classifyVocFailure(r)).toEqual({ state: 'api', message: '점검 중입니다', apiStatus: 503 });

    const kEmpty = kit({ session: null });
    for (const stdin of ['\n', '', '\r\nsecret\n']) {
      const e = await kEmpty.runner.run(vocLoginArgs('hong'), { stdin });
      expect(e.stderr).toBe('오류: 비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.\n');
    }
    expect(kEmpty.calls).toEqual([]);

    const kNoToken = kit({ session: null, respond: () => json(200, { user: { name: '홍길동' } }) });
    const n = await kNoToken.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    expect(n.stderr).toMatch(/^오류: 응답 파싱 실패/);
    expect(kNoToken.store.load()).toBeNull();
  });

  it('로그인 성공: 세션은 codec 으로 암호화해 파일에 — 평문 토큰이 없고, 같은 codec 의 새 저장소가 읽는다', async () => {
    const k = kit({ session: null, codec: fakeCodec });
    const r = await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\r\n` });
    ok(r);
    expect(r.stdout).toContain(`세션 저장 위치: ${k.sessionFile}`);
    const raw = fs.readFileSync(k.sessionFile);
    for (const plain of ['tok-new', 'ref-new', 'accessToken', 'hong', PASSWORD]) expect(raw.includes(Buffer.from(plain))).toBe(false);
    expect(raw.toString('latin1')).not.toContain(PASSWORD);
    const again = new VocSessionStore(k.sessionFile, fakeCodec);
    expect(again.load()).toEqual({ apiUrl: API, accessToken: 'tok-new', refreshToken: 'ref-new', loginId: 'hong', userName: '홍길동', role: 'staff' });
    // 다른 키(복호화 실패)·깨진 파일은 없는 것으로 — 다시 로그인
    expect(new VocSessionStore(k.sessionFile, { encrypt: fakeCodec.encrypt, decrypt: () => '{"broken"' }).load()).toBeNull();
    expect(
      new VocSessionStore(k.sessionFile, {
        encrypt: fakeCodec.encrypt,
        decrypt: () => {
          throw new Error('다른 계정');
        },
      }).load(),
    ).toBeNull();
    expect(new VocSessionStore(k.sessionFile, { encrypt: fakeCodec.encrypt, decrypt: () => JSON.stringify({ apiUrl: API, accessToken: '' }) }).load()).toBeNull();
    // 로그아웃은 파일까지 지운다
    k.runner.logout();
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    expect(k.store.load()).toBeNull();
  });

  it('codec 이 없으면(암호화를 못 씀) 파일에 쓰지 않고 앱을 켜 둔 동안만 기억한다', async () => {
    const k = kit({ session: null, codec: null });
    const r = await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    ok(r);
    expect(r.stdout).toContain('세션 저장 위치: 앱을 켜 둔 동안만');
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    expect(fs.readdirSync(path.dirname(k.sessionFile)).filter((n) => n.startsWith('voc-session'))).toEqual([]);
    ok(await k.runner.run(['customer', 'list', '--json']));
    expect(k.calls.at(-1)?.headers.Authorization).toBe('Bearer tok-new');
    // 새 저장소(앱을 다시 띄움)는 모른다
    expect(new VocSessionStore(k.sessionFile, null).load()).toBeNull();
  });

  it('암호화가 실패해도(encrypt 가 던짐) 로그인은 되고 이번 실행 동안은 메모리 세션', async () => {
    const k = kit({
      session: null,
      codec: {
        encrypt: () => {
          throw new Error('암호화를 쓸 수 없음');
        },
        decrypt: fakeCodec.decrypt,
      },
    });
    ok(await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` }));
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    ok(await k.runner.run(['customer', 'list', '--json']));
  });

  it('새 세션을 파일에 남기지 못하면 옛 세션 파일을 지운다 — 다음 실행에 앞사람 세션이 되살아나지 않고, 저장 위치도 메모리라고 말한다', async () => {
    let broken = false;
    const codec: VocSessionCodec = {
      encrypt: (text) => {
        if (broken) throw new Error('암호화를 쓸 수 없음');
        return fakeCodec.encrypt(text);
      },
      decrypt: fakeCodec.decrypt,
    };
    // 앞사람(A)의 세션이 파일에 있다
    const k = kit({ session: { ...SESSION, loginId: 'prev-user', accessToken: 'tok-prev' }, codec });
    expect(new VocSessionStore(k.sessionFile, codec).load()?.loginId).toBe('prev-user');
    // B 가 로그인 — 이번에는 암호화가 안 된다
    broken = true;
    const r = await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    ok(r);
    expect(r.stdout).toContain('세션 저장 위치: 앱을 켜 둔 동안만(세션 파일에 저장하지 못함)');
    expect(r.stdout).not.toContain(k.sessionFile);
    expect(fs.existsSync(k.sessionFile)).toBe(false);
    expect(fs.existsSync(`${k.sessionFile}.tmp`)).toBe(false);
    // 이번 실행은 B 의 메모리 세션, 다시 띄우면(새 저장소) 세션 없음 — A 로 돌아가지 않는다
    expect(k.store.load()?.accessToken).toBe('tok-new');
    expect(new VocSessionStore(k.sessionFile, codec).load()).toBeNull();
    // 다음 저장이 되면 다시 파일 경로
    broken = false;
    ok(await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` }));
    expect(k.store.location).toBe(k.sessionFile);
    expect(new VocSessionStore(k.sessionFile, codec).load()?.accessToken).toBe('tok-new');
  });

  it('바꿔치기(rename)가 EPERM 이면 제자리에 쓰고, 그마저 안 되면 옛 파일(폐기된 refresh 토큰)을 지운다', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'voc-session.bin');
    const store = new VocSessionStore(file, fakeCodec);
    store.save({ ...SESSION, refreshToken: 'ref-1' });
    const eperm = (): never => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    };
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(eperm);
    try {
      // 1) rename 만 실패 — 제자리 쓰기로 저장된다
      store.save({ ...SESSION, refreshToken: 'ref-2' });
      expect(store.location).toBe(file);
      expect(new VocSessionStore(file, fakeCodec).load()?.refreshToken).toBe('ref-2');
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
      // 2) 제자리 쓰기도 실패(백신이 잡고 있음) — 옛 파일을 지운다
      const realWrite = fs.writeFileSync.bind(fs);
      const write = vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, opt) => {
        if (p === file) eperm();
        realWrite(p, data, opt);
      });
      try {
        store.save({ ...SESSION, refreshToken: 'ref-3' });
      } finally {
        write.mockRestore();
      }
      expect(store.load()?.refreshToken).toBe('ref-3');
      expect(store.location).toContain('저장하지 못함');
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
      expect(new VocSessionStore(file, fakeCodec).load()).toBeNull();
    } finally {
      rename.mockRestore();
    }
  });

  it('갱신(refresh)은 명령의 시간 초과에 묶이지 않는다 — 늦게 온 새 토큰도 저장하고, 그동안 다음 명령은 기다렸다 새 토큰으로', async () => {
    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((r) => {
      releaseRefresh = r;
    });
    let refreshDone = false;
    const k = kit({
      codec: fakeCodec,
      respond: async (r) => {
        if (r.url.pathname.endsWith('/auth/refresh')) {
          // 서버는 이미 ref-1 을 폐기하고 새 토큰을 냈다 — 응답이 늦게 온다(명령 제한 시간 뒤)
          await refreshGate;
          refreshDone = true;
          return json(200, { accessToken: 'tok-a2', refreshToken: 'ref-2' });
        }
        if (r.headers.Authorization !== 'Bearer tok-a2') return json(401, { message: '인증이 필요합니다' });
        return backend(r, new AbortController().signal);
      },
    });
    const slow = k.runner.run(['customer', 'list', '--json'], { timeoutMs: 40 });
    const next = k.runner.run(['user', 'list', '--role', 'staff,admin', '--json']);
    expect(await slow).toEqual({ code: -1, stdout: '', stderr: '', timedOut: true });
    // 갱신이 끝나기 전에는 다음 명령을 시작하지 않는다(옛 토큰으로 갱신을 겨루지 않게)
    await new Promise((r) => setTimeout(r, 30));
    expect(k.runner.busy).toBe(true);
    expect(k.calls.map((c) => c.url.pathname)).toEqual(['/api/v2/admin/customers', '/api/v2/auth/refresh']);
    releaseRefresh();
    ok(await next);
    expect(refreshDone).toBe(true);
    // 새 토큰이 메모리와 파일 모두에
    expect(k.store.load()).toMatchObject({ accessToken: 'tok-a2', refreshToken: 'ref-2' });
    expect(new VocSessionStore(k.sessionFile, fakeCodec).load()).toMatchObject({ accessToken: 'tok-a2', refreshToken: 'ref-2' });
    expect(k.calls.map((c) => [c.url.pathname, c.headers.Authorization ?? null])).toEqual([
      ['/api/v2/admin/customers', 'Bearer tok-a1'],
      ['/api/v2/auth/refresh', null],
      ['/api/v2/users', 'Bearer tok-a2'],
    ]);
  });

  it('갱신 중 stopAll(앱 끝냄)도 갱신은 끝까지 — 새 토큰을 저장한다', async () => {
    let releaseRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((r) => {
      releaseRefresh = r;
    });
    const k = kit({
      codec: fakeCodec,
      respond: async (r) => {
        if (r.url.pathname.endsWith('/auth/refresh')) {
          await refreshGate;
          return json(200, { accessToken: 'tok-a2', refreshToken: 'ref-2' });
        }
        return json(401, {});
      },
    });
    const active = k.runner.run([...VOC_LIST_ARGS]);
    await new Promise((r) => setTimeout(r, 10));
    k.runner.stopAll();
    const err = await active.then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as VocRunError).failure).toEqual({ state: 'unavailable', message: VOC_STOPPED_MESSAGE });
    releaseRefresh();
    await vi.waitFor(() => expect(k.runner.busy).toBe(false));
    expect(new VocSessionStore(k.sessionFile, fakeCodec).load()).toMatchObject({ accessToken: 'tok-a2', refreshToken: 'ref-2' });
    // 멈춘 명령은 새 토큰으로 다시 부르지 않았다
    expect(k.calls.map((c) => c.url.pathname)).toEqual(['/api/v2/tickets', '/api/v2/auth/refresh']);
  });

  it('갱신 자체가 제한 시간을 넘기면 "요청 실패"(결과를 모름) — 세션은 지우지 않는다', async () => {
    const k = kit({
      refreshTimeoutMs: 40,
      respond: (r, signal) => (r.url.pathname.endsWith('/auth/refresh') ? hang(signal) : json(401, {})),
    });
    const r = await k.runner.run(['customer', 'list', '--json']);
    expect(r).toEqual({ code: 1, stdout: '', stderr: '오류: 요청 실패: 토큰 갱신이 제한 시간 안에 끝나지 않았습니다\n', timedOut: false });
    expect(classifyVocFailure(r).state).toBe('unavailable');
    expect(k.store.load()).toMatchObject({ accessToken: 'tok-a1', refreshToken: 'ref-1' });
    expect(k.runner.busy).toBe(false);
  });
});

// ---- 4. 네트워크·큐 ---------------------------------------------------------------------------------

describe('네트워크 실패·시간 초과·큐', () => {
  it('연결 거부(닫힌 localhost 포트) → "백엔드에 연결할 수 없습니다" → unavailable', async () => {
    const port = await closedPort();
    const url = `http://127.0.0.1:${port}`;
    const k = kit({ apiUrl: url, session: { ...SESSION, apiUrl: url } });
    // 진짜 fetch 로(이 PC 의 닫힌 포트 — 밖으로 나가지 않는다)
    const runner = new VocApiRunner({ apiUrl: () => url, sessions: k.store, usageFile: k.usageFile });
    const r = await runner.run([...VOC_LIST_ARGS]);
    expect(r).toEqual({ code: 1, stdout: '', stderr: `오류: 백엔드에 연결할 수 없습니다: ${url} — 서버가 실행 중인지 확인하세요.\n`, timedOut: false });
    const f = classifyVocFailure(r);
    expect(f.state).toBe('unavailable');
    expect(f.message.startsWith(VOC_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(usageRows(k.usageFile)).toEqual([]);
    // 로그인도 같은 문장(service 는 연결 실패를 잠금 셈에 넣지 않는다)
    const login = await runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    expect(login.stderr).toContain('백엔드에 연결할 수 없습니다');
  });

  it('보낸 뒤 끊김(ECONNRESET 등)은 "요청 실패" → unavailable(쓰기면 결과를 모름)', async () => {
    const k = kit({
      respond: () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      },
    });
    const r = await k.runner.run(['ticket', 'reply', '1002', '--content=확인']);
    expect(r.stderr).toBe('오류: 요청 실패: ECONNRESET socket hang up\n');
    expect(classifyVocFailure(r).state).toBe('unavailable');
    const k2 = kit({
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await k2.runner.run([...VOC_LIST_ARGS])).stderr).toBe('오류: 요청 실패: fetch failed\n');
  });

  it('2xx 가 아니면 "<상태> — <서버 문장>" → api + apiStatus, 사용량에 그 상태', async () => {
    const answers: Response[] = [
      json(400, { message: '담당자가 지정되지 않은 티켓은 해결할 수 없습니다.' }),
      new Response('<html>Bad Gateway</html>', { status: 502 }),
      new Response(null, { status: 404 }),
      json(403, { detail: '권한이 없습니다' }),
    ];
    const k = kit({ respond: () => answers.shift() as Response });
    const expectFail = async (args: string[], line: string, status: number, message: string) => {
      const r = await k.runner.run(args);
      expect(r).toEqual({ code: 1, stdout: '', stderr: `오류: ${line}\n`, timedOut: false });
      expect(classifyVocFailure(r)).toEqual({ state: 'api', message, apiStatus: status });
    };
    await expectFail(['ticket', 'resolve', '1001'], '400 — 담당자가 지정되지 않은 티켓은 해결할 수 없습니다.', 400, '담당자가 지정되지 않은 티켓은 해결할 수 없습니다.');
    await expectFail(['ticket', 'get', '9', '--json'], '502 — <html>Bad Gateway</html>', 502, '<html>Bad Gateway</html>');
    await expectFail(['ticket', 'get', '9', '--json'], '404 — (응답 본문 없음)', 404, '(응답 본문 없음)');
    await expectFail(['worklog', 'delete', '8002', '-y'], '403 — 권한이 없습니다', 403, '권한이 없습니다');
    expect(usageRows(k.usageFile).map((u) => [u.command, u.method, u.path, u.status])).toEqual([
      ['ticket resolve 1001', 'PUT', '/tickets/1001', 400],
      ['ticket get 9', 'GET', '/tickets/9', 502],
      ['ticket get 9', 'GET', '/tickets/9', 404],
      ['worklog delete 8002', 'POST', '/work-logs/8002/delete', 403],
    ]);
  });

  it('2xx 인데 JSON 이 아니면 "응답 파싱 실패", 빈 본문은 {}', async () => {
    const k = kit({ respond: (r) => (r.url.pathname.endsWith('/tickets/1') ? new Response('not json', { status: 200 }) : new Response('', { status: 200 })) });
    const r = await k.runner.run(['ticket', 'get', '1', '--json']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^오류: 응답 파싱 실패: /);
    const empty = await k.runner.run(['customer', 'list', '--json']);
    ok(empty);
    expect(empty.stdout).toBe('{}\n');
  });

  it('시간 초과 → timedOut(결과를 모름), 다음 명령은 이어서 돈다', async () => {
    const k = kit({ respond: (r, signal) => (r.url.pathname.endsWith('/tickets/1') ? hang(signal) : backend(r, signal)) });
    const slow = k.runner.run(['ticket', 'get', '1', '--json'], { timeoutMs: 60 });
    const next = k.runner.run(['customer', 'list', '--json']);
    expect(k.runner.busy).toBe(true);
    const r = await slow;
    expect(r).toEqual({ code: -1, stdout: '', stderr: '', timedOut: true });
    expect(classifyVocFailure(r).state).toBe('unavailable');
    ok(await next);
    expect(k.runner.busy).toBe(false);
  });

  it('쓰기 기본 제한 시간은 90초, 읽기는 30초(VocCliRunner 와 같다)', async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const k = kit();
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 1e9);
    }) as typeof setTimeout;
    try {
      ok(await k.runner.run(['customer', 'list', '--json']));
      ok(await k.runner.run(['ticket', 'reply', '1', '--content=x']));
      ok(await k.runner.run(['customer', 'list', '--json'], { timeoutMs: 1234 }));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(delays.filter((d) => d >= 1000)).toEqual([30_000, 90_000, 1234]);
  });

  it('stopAll: 기다리는 것과 도는 것 모두 VOC_STOPPED_MESSAGE 로 거부', async () => {
    const k = kit({ respond: (_r, signal) => hang(signal) });
    const active = k.runner.run([...VOC_LIST_ARGS]);
    const queued = k.runner.run(['ticket', 'reply', '1', '--content=x']);
    const queued2 = k.runner.run(['customer', 'list', '--json']);
    await new Promise((r) => setImmediate(r));
    expect(k.runner.busy).toBe(true);
    expect(k.runner.pending).toBe(2);
    k.runner.stopAll();
    for (const p of [active, queued, queued2]) {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(VocRunError);
      expect((err as VocRunError).failure).toEqual({ state: 'unavailable', message: VOC_STOPPED_MESSAGE });
    }
    expect(k.runner.busy).toBe(false);
    expect(k.runner.pending).toBe(0);
    expect(k.calls).toHaveLength(1);
  });

  it('한 번에 하나만 — 기다리는 쓰기가 기다리는 읽기보다 먼저', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const k = kit({
      respond: async (r, signal) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (r.url.pathname.endsWith('/tickets/1')) await gate;
          return await backend(r, signal);
        } finally {
          inFlight -= 1;
        }
      },
    });
    const order: string[] = [];
    const track = (name: string, p: Promise<VocRunResult>) => p.then((x) => (order.push(name), x));
    const first = track('read-first', k.runner.run(['ticket', 'get', '1', '--json']));
    const readA = track('read-a', k.runner.run(['customer', 'list', '--json']));
    const write = track('write', k.runner.run(['ticket', 'reply', '2', '--content=x']));
    const readB = track('read-b', k.runner.run(['user', 'list', '--role', 'staff,admin', '--json']));
    const write2 = track('write-2', k.runner.run(['worklog', 'delete', '8001', '-y']));
    await new Promise((r) => setImmediate(r));
    expect(k.runner.pending).toBe(4);
    release();
    for (const r of await Promise.all([first, readA, write, readB, write2])) ok(r);
    expect(order).toEqual(['read-first', 'write', 'write-2', 'read-a', 'read-b']);
    expect(k.calls.map((c) => c.url.pathname)).toEqual([
      '/api/v2/tickets/1',
      '/api/v2/tickets/2/replies',
      '/api/v2/work-logs/8001/delete',
      '/api/v2/admin/customers',
      '/api/v2/users',
    ]);
    expect(maxInFlight).toBe(1);
  });

  it('응답 크기 제한은 다 읽기 전에: Content-Length 가 넘으면 본문을 읽지 않는다(JSON 20MB·첨부 200MB)', async () => {
    let pulled = 0;
    let cancelled = 0;
    const big = (contentLength: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            pulled += 1;
            c.enqueue(new Uint8Array(1024));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        { status: 200, headers: { 'Content-Length': String(contentLength), 'Content-Type': 'application/octet-stream' } },
      );
    const k = kit({ respond: (r) => (r.url.pathname.includes('/files/') ? big(201 * 1024 * 1024) : big(21 * 1024 * 1024)) });
    const list = await k.runner.run(['customer', 'list', '--json']);
    expect(list).toEqual({ code: 1, stdout: '', stderr: '오류: 응답이 너무 큽니다(20MB 넘음)\n', timedOut: false });
    const dir = path.join(k.filesDir, '1004', '7001');
    const file = await k.runner.run(vocDownloadArgs(7001, dir));
    expect(file.stderr).toBe('오류: 응답이 너무 큽니다(200MB 넘음)\n');
    expect(cancelled).toBe(2);
    // 스트림이 처음 채우는 조각만 — 본문을 읽지 않았다
    expect(pulled).toBeLessThanOrEqual(4);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('길이를 모르는 본문(chunked)은 흘려 읽으며 세다 제한을 넘는 순간 끊는다 — 끝없는 본문도 메모리에 다 올리지 않는다', async () => {
    const MB = 1024 * 1024;
    let pulled = 0;
    let cancelled = false;
    const k = kit({
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(c) {
              pulled += 1;
              c.enqueue(new Uint8Array(MB)); // 끝나지 않는 본문
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });
    const r = await k.runner.run(['customer', 'list', '--json']);
    expect(r.stderr).toBe('오류: 응답이 너무 큽니다(20MB 넘음)\n');
    expect(classifyVocFailure(r).state).toBe('api');
    expect(cancelled).toBe(true);
    expect(pulled).toBeGreaterThan(20);
    expect(pulled).toBeLessThanOrEqual(24);
    // 제한 안의 첨부는 그대로 받는다
    const k2 = kit();
    const dir = path.join(k2.filesDir, '1004', '7001');
    ok(await k2.runner.run(vocDownloadArgs(7001, dir)));
    expect(fs.readFileSync(path.join(dir, 'screen.png')).equals(PNG)).toBe(true);
  });

  it('시험 가드는 보내는 자리에서도 — 줄 서 있는 사이 설정 주소가 localhost 밖으로 바뀌면 보내지 않는다(로그인 비밀번호 포함)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const k = kit({
      session: null,
      respond: async (r, signal) => {
        if (r.url.pathname.endsWith('/auth/login') && r.url.hostname === '127.0.0.1') await gate;
        return backend(r, signal);
      },
    });
    // 첫 로그인(127.0.0.1)이 도는 동안 둘째 로그인이 줄을 선다 — 줄 설 때는 주소가 localhost 라 run() 의 가드를 지난다
    const first = k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` });
    const queued = k.runner.run(vocLoginArgs('kim'), { stdin: `${PASSWORD}\n` });
    await new Promise((r) => setImmediate(r));
    k.url.value = 'https://voc.example.test:11300';
    release();
    ok(await first);
    const err = await queued.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VocRunError);
    expect((err as VocRunError).failure).toEqual({ state: 'notConfigured', message: VOC_API_GUARD_MESSAGE });
    expect(k.calls.map((c) => c.url.origin)).toEqual([API]);
    expect(k.runner.busy).toBe(false);

    // 앞 실행이 남긴 세션이 localhost 밖 주소이고, 줄 서 있는 사이 설정도 그 주소로 바뀐 경우 — 인증 호출도 보내지 않는다
    const remote = 'https://voc.example.test:11300';
    let release2: () => void = () => {};
    const gate2 = new Promise<void>((r) => {
      release2 = r;
    });
    const k2 = kit({
      session: { ...SESSION, apiUrl: remote },
      respond: async (r, signal) => {
        if (r.url.pathname.endsWith('/auth/login')) await gate2;
        return backend(r, signal);
      },
    });
    // 막아 두는 앞 명령: 틀린 비밀번호 로그인(127.0.0.1 — 세션은 그대로 둔다)
    const hold = k2.runner.run(vocLoginArgs('hong'), { stdin: 'wrong-pass\n' });
    const waiting = k2.runner.run(['customer', 'list', '--json']);
    await new Promise((r) => setImmediate(r));
    k2.url.value = remote;
    release2();
    expect((await hold).stderr).toContain('로그인 실패');
    // 세션 주소 = 설정 주소(둘 다 원격)라 requireSession 은 지나지만, 보내는 자리에서 막는다
    const e1 = await waiting.then(
      () => null,
      (e: unknown) => e,
    );
    expect(e1).toBeInstanceOf(VocRunError);
    expect((e1 as VocRunError).failure).toEqual({ state: 'notConfigured', message: VOC_API_GUARD_MESSAGE });
    expect(k2.calls.map((c) => c.url.origin)).toEqual([API]);
    expect(k2.runner.busy).toBe(false);
  });

  it('시험 중(VITEST)에는 localhost 밖 주소를 부르지 않는다 → notConfigured', async () => {
    expect(process.env.VITEST).toBeDefined();
    for (const url of [VOC_DEFAULT_API_URL, 'https://voc.example.test:11300', 'http://10.0.0.5:8080', 'http://127.0.0.1.example.test']) {
      const k = kit({ apiUrl: url, session: { ...SESSION, apiUrl: url } });
      for (const run of [() => k.runner.run([...VOC_LIST_ARGS]), () => k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` })]) {
        const err = await run().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(VocRunError);
        expect((err as VocRunError).failure).toEqual({ state: 'notConfigured', message: VOC_API_GUARD_MESSAGE });
      }
      expect(k.calls).toEqual([]);
    }
    // localhost·127.0.0.1·[::1] 은 된다
    for (const url of ['http://localhost:18080', 'http://[::1]:18080']) {
      const k = kit({ apiUrl: url, session: { ...SESSION, apiUrl: url } });
      ok(await k.runner.run(['customer', 'list', '--json']));
    }
  });
});

// ---- 5. 사용량 기록 -----------------------------------------------------------------------------------

describe('사용량 기록(voc-cli 시범 과금 원장과 같은 줄)', () => {
  it('부를 때마다 {ts, command, method, path(쿼리 없음), status, ms} 한 줄 — 로그인·갱신은 남기지 않는다', async () => {
    const k = kit({ session: null });
    ok(await k.runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n` }));
    ok(await k.runner.run([...VOC_LIST_ARGS]));
    ok(await k.runner.run(['ticket', 'get', '1004', '--replies', '--json']));
    ok(await k.runner.run(['ticket', 'update', '1001', '--assignee', '102', '--status', 'assigned', '--json']));
    ok(await k.runner.run(['worklog', 'list', '1005', '--json']));
    ok(await k.runner.run(['worklog', 'delete', '8001', '-y']));
    ok(await k.runner.run(vocDownloadArgs(7001, path.join(k.filesDir, '1004'))));
    const rows = usageRows(k.usageFile);
    expect(rows.map((u) => [u.command, u.method, u.path, u.status])).toEqual([
      ['ticket list', 'GET', '/tickets', 200],
      ['ticket get 1004', 'GET', '/tickets/1004', 200],
      ['ticket get 1004', 'GET', '/tickets/1004/replies', 200],
      ['ticket update 1001', 'PUT', '/tickets/1001', 200],
      ['worklog list 1005', 'GET', '/work-logs', 200],
      ['worklog delete 8001', 'POST', '/work-logs/8001/delete', 204],
      ['file download 7001', 'GET', '/files/7001/download', 200],
    ]);
    for (const u of rows) {
      expect(Object.keys(u)).toEqual(['ts', 'command', 'method', 'path', 'status', 'ms']);
      expect(new Date(u.ts as string).toISOString()).toBe(u.ts);
      expect(typeof u.ms).toBe('number');
      expect(u.ms as number).toBeGreaterThanOrEqual(0);
    }
    // 줄 끝은 OS 줄바꿈(voc-cli 의 System.lineSeparator)
    expect(fs.readFileSync(k.usageFile, 'utf8').endsWith(os.EOL)).toBe(true);
    expect(fs.readFileSync(k.usageFile, 'utf8')).not.toContain(PASSWORD);
  });

  it('usageFile 이 null 이면 아무것도 쓰지 않는다, 기록 실패는 명령을 깨지 않는다', async () => {
    const k = kit({ usageFile: null });
    ok(await k.runner.run([...VOC_LIST_ARGS]));
    expect(fs.existsSync(k.usageFile)).toBe(false);
    expect(fs.existsSync(path.dirname(k.usageFile))).toBe(false);
    // 기록 위치가 폴더라 쓸 수 없음
    const dir = tempDir();
    const k2 = kit({ usageFile: dir });
    ok(await k2.runner.run([...VOC_LIST_ARGS]));
  });
});

// ---- 6. 통합: 가짜 VOC 백엔드 + VocService -------------------------------------------------------------

interface FakeVocServer {
  url: string;
  requests: { method: string; path: string; query: Record<string, string>; body: unknown; auth: string; client?: string; contentType?: string }[];
  expireAccess(): void;
  expireAll(): void;
  forceStatus(status: number | null): void;
  close(): Promise<void>;
}

async function startServer(opts: { state: string; now?: string; mode?: 'ok' | 'fail-write'; password?: string }): Promise<FakeVocServer> {
  const mod = (await import(/* @vite-ignore */ FAKE_SERVER)) as { startFakeVocServer: (o: typeof opts) => Promise<FakeVocServer> };
  const server = await mod.startFakeVocServer(opts);
  cleanups.push(() => server.close());
  return server;
}

interface Harness {
  service: VocService;
  state: string;
  dataDir: string;
  filesDir: string;
  actions: VocActionLog;
}

interface ApiHarness extends Harness {
  runner: VocApiRunner;
  server: FakeVocServer;
  store: VocSessionStore;
  usageFile: string;
}

function serviceOf(runner: Pick<VocCliRunner, 'run'>, dataDir: string, filesDir: string, terminalLogin: boolean): { service: VocService; actions: VocActionLog } {
  const settings = new VocSettingsStore(dataDir);
  const actions = new VocActionLog(dataDir);
  const service = new VocService({
    runner,
    terminalLogin,
    settings: () => settings,
    actions: () => actions,
    today: () => TODAY,
    holidays: [],
    now: () => NOW,
    pageMaps: () => ({ custPage: new Map(), systemPage: new Map(), pageIndex: new Map() }),
    onBoard: () => {},
    filesDir,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  });
  // 쓰기 뒤 뒤에서 도는 새로 받기를 기다린 뒤 서버를 닫고 폴더를 지운다(Windows EPERM 방지)
  cleanups.push(() => service.refresh());
  return { service, actions };
}

function dirs(): { root: string; state: string; dataDir: string; filesDir: string } {
  const root = tempDir();
  const state = path.join(root, 'state');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(state);
  fs.mkdirSync(dataDir);
  return { root, state, dataDir, filesDir: path.join(dataDir, 'voc-files') };
}

/** API 경로: 가짜 백엔드 + VocApiRunner. login 이 true 면 runner 로 먼저 로그인 */
async function apiHarness(o: { login?: boolean; mode?: 'ok' | 'fail-write'; codec?: VocSessionCodec | null } = {}): Promise<ApiHarness> {
  const d = dirs();
  const server = await startServer({ state: d.state, now: FAKE_NOW, mode: o.mode ?? 'ok', password: PASSWORD });
  const store = new VocSessionStore(path.join(d.dataDir, 'voc-session.bin'), o.codec === undefined ? fakeCodec : o.codec);
  const usageFile = path.join(d.root, 'usage.jsonl');
  const runner = new VocApiRunner({ apiUrl: () => server.url, sessions: store, downloadRoot: d.filesDir, usageFile, appVersion: '0.0.0-test' });
  cleanups.push(async () => runner.stopAll());
  if (o.login !== false) ok(await runner.run(vocLoginArgs('hong'), { stdin: `${PASSWORD}\n`, write: true }));
  const { service, actions } = serviceOf(runner, d.dataDir, d.filesDir, false);
  return { service, actions, runner, server, store, usageFile, ...d };
}

/** voc-cli 경로: 가짜 voc-cli 프로세스 + VocCliRunner(voc-work.test.ts 와 같은 설정) */
function cliHarness(mode: 'ok' | 'fail-write' = 'ok'): Harness {
  const d = dirs();
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_VOC_STATE: d.state, FAKE_VOC_MODE: mode, FAKE_VOC_NOW: FAKE_NOW };
  const runner = new VocCliRunner({
    locate: () => ({ ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE_CLI] }),
    env,
    workDir: path.join(d.dataDir, 'voc-cwd'),
    downloadRoot: d.filesDir,
  });
  const { service, actions } = serviceOf(runner, d.dataDir, d.filesDir, true);
  return { service, actions, ...d };
}

/** 보드 비교용: 웹 주소(백엔드 호스트가 다르다)는 따로 본다 */
function comparable(board: VocBoard): Omit<VocBoard, 'webBase'> {
  const { webBase: _w, ...rest } = board;
  return rest;
}

/** 가짜 voc-cli 상태 폴더의 자료(쓰기 결과) */
function stateFiles(h: Harness): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string, rel: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith('.json')) out[r] = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(h.state, '');
  return out;
}

let seq = 0;
const aid = (): string => `act-${Date.now().toString(16)}-${(++seq).toString(16).padStart(4, '0')}`;
const onBoard = (h: Harness, id: number): boolean => h.service.board().lanes.some((l) => l.tickets.some((t) => t.id === id));

function mailTask(): Task {
  return {
    id: 'c:abc123def456',
    source: 'checkbox',
    title: '한결케미칼 통영공장 인벤토리 사용량 미반영 — 검토·회신',
    status: 'open',
    file: '_private/mgmt/내 할 일.md',
    line: 20,
    rawLine: '- [ ] 한결케미칼 통영공장 인벤토리 사용량 미반영 — 검토·회신 #내할일 [mail:: raw/mail/한결케미칼/2026/a.md]',
    mail: 'raw/mail/한결케미칼/2026/a.md',
    company: '한결케미칼',
    bucket: 'other',
  } as Task;
}

describe('통합 — 가짜 VOC 백엔드(HTTP) + VocService', () => {
  it('차이 시험: 같은 자료로 받은 보드·VOC 할 일·선택지가 voc-cli 경로와 똑같다', { timeout: 60_000 }, async () => {
    const api = await apiHarness();
    const cli = cliHarness();
    const a = await api.service.refresh();
    const c = await cli.service.refresh();
    expect(a.state).toBe('ok');
    expect(c.state).toBe('ok');
    expect(a.lanes.length).toBeGreaterThan(0);
    expect(comparable(a)).toEqual(comparable(c));
    expect(a.fetchedAt).toBe(NOW.toISOString());
    expect(api.service.tasks()).toEqual(cli.service.tasks());
    // 웹 주소는 각 백엔드 호스트의 https
    expect(c.webBase).toBe('https://voc.example.test');
    expect(a.webBase).toBe('https://127.0.0.1');
    expect(a.me).toMatchObject({ id: 101, email: 'owner@example.com' });
    expect(await api.service.directory()).toEqual(await cli.service.directory());
    expect(await api.service.ticketDetail(1004)).toEqual(await cli.service.ticketDetail(1004));
    expect(await api.service.workLogs(1005)).toEqual(await cli.service.workLogs(1005));
    expect(await api.service.emailLogs(1004)).toEqual(await cli.service.emailLogs(1004));

    // 서버가 받은 요청: 모두 Bearer·wiki-radar, 로그인 본문의 비밀번호는 기록에서도 가려져 있다
    const reqs = api.server.requests;
    expect(reqs[0]).toMatchObject({ method: 'POST', path: '/api/v2/auth/login', body: { loginId: 'hong', password: '***' }, auth: '' });
    for (const r of reqs.slice(1)) {
      expect(r.auth).toMatch(/^Bearer access-\d+$/);
      expect(r.client).toBe('wiki-radar');
    }
    expect(reqs.slice(1, 4).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v2/auth/me', 'GET /api/v2/users', 'GET /api/v2/tickets']);
    expect(reqs[3].query).toEqual({ showCompleted: 'false', page: '1', size: '2000' });
    // 사용량 기록이 남는다(로그인은 빼고)
    expect(usageRows(api.usageFile).slice(0, 3).map((u) => u.command)).toEqual(['whoami', 'user list', 'ticket list']);
  });

  it('차이 시험: 같은 쓰기 순서의 결과 문장·보드·VOC 쪽 자료가 voc-cli 경로와 똑같다', { timeout: 120_000 }, async () => {
    const api = await apiHarness();
    const cli = cliHarness();
    const both = [api as Harness, cli];
    for (const h of both) expect((await h.service.refresh()).state).toBe('ok');

    const steps: { name: string; run: (h: Harness) => Promise<unknown> }[] = [
      { name: '담당 지정(new → assigned)', run: (h) => h.service.action({ actionId: aid(), kind: 'assign', ticketId: 1001, value: '102' }) },
      { name: '담당 지정만', run: (h) => h.service.action({ actionId: aid(), kind: 'assign', ticketId: 1008, value: '103' }) },
      { name: 'ICT 예상완료일', run: (h) => h.service.action({ actionId: aid(), kind: 'ictDue', ticketId: 1003, value: '2026-10-05' }) },
      { name: 'ICT 예상완료일 지우기', run: (h) => h.service.action({ actionId: aid(), kind: 'ictDue', ticketId: 1006, value: '' }) },
      { name: '우선순위', run: (h) => h.service.action({ actionId: aid(), kind: 'priority', ticketId: 1003, value: 'P1' }) },
      { name: '상태', run: (h) => h.service.action({ actionId: aid(), kind: 'status', ticketId: 1006, value: 'pending' }) },
      { name: '답변', run: (h) => h.service.action({ actionId: aid(), kind: 'reply', ticketId: 1005, value: '확인했습니다.\n-p @월요일 * 반영' }) },
      {
        name: '작업시간 넣기',
        run: (h) => h.service.work({ actionId: aid(), kind: 'worklogAdd', ticketId: 1004, worklog: { hours: 1.5, date: TODAY, note: '-p @원인 확인 *' } }),
      },
      { name: '작업시간 지우기(내 것)', run: (h) => h.service.work({ actionId: aid(), kind: 'worklogDelete', ticketId: 1005, workLogId: 8001 }) },
      { name: '작업시간 지우기(남의 것 — 막음)', run: (h) => h.service.work({ actionId: aid(), kind: 'worklogDelete', ticketId: 1005, workLogId: 8002 }) },
      { name: '해결(작업시간 없음 — 막음)', run: (h) => h.service.work({ actionId: aid(), kind: 'resolve', ticketId: 1006, expectedStatus: 'pending' }) },
      {
        name: '해결(작업시간과 함께)',
        run: (h) =>
          h.service.work({ actionId: aid(), kind: 'resolve', ticketId: 1006, expectedStatus: 'pending', worklog: { hours: 2, date: TODAY, note: '데이터 추출' } }),
      },
      { name: '해결(담당자 없음 — 막음)', run: (h) => h.service.work({ actionId: aid(), kind: 'resolve', ticketId: 1002, expectedStatus: 'new', worklog: { hours: 1, date: TODAY, note: '' } }) },
      {
        name: '고객 메일',
        run: (h) =>
          h.service.work({
            actionId: aid(),
            kind: 'email',
            ticketId: 1004,
            expectedStatus: 'in_progress',
            email: { to: ['ops@haeon.example'], cc: ['kim@example.com'], replyIds: [5001, 5003] },
          }),
      },
      {
        name: '해결 + 고객 메일(--resolve)',
        run: (h) =>
          h.service.work({
            actionId: aid(),
            kind: 'resolve',
            ticketId: 1005,
            expectedStatus: 'pending',
            email: { to: ['ops@haeon.example'], cc: [], replyIds: [] },
          }),
      },
      { name: '재오픈', run: (h) => h.service.work({ actionId: aid(), kind: 'reopen', ticketId: 1006, expectedStatus: 'resolved' }) },
      { name: '완료', run: (h) => h.service.work({ actionId: aid(), kind: 'close', ticketId: 1009, expectedStatus: 'pending', worklog: { hours: 0.5, date: TODAY, note: '' } }) },
      { name: '메일 기록', run: (h) => h.service.emailLogs(1004) },
      { name: '작업시간 목록', run: (h) => h.service.workLogs(1004) },
      {
        name: '메일 → VOC 등록',
        run: (h) =>
          h.service.create(
            {
              createId: '00000000-0000-4000-8000-0000000000c1',
              taskId: 'c:abc123def456',
              title: '통영공장 인벤토리 확인 요청',
              description: '8월 사용량이 실적 화면에 보이지 않습니다.\n확인 부탁드립니다.',
              customerId: 11,
              system: 'SYS0101',
              requestType: 'inquiry',
              priority: 'P3',
              assigneeId: 102,
            },
            mailTask(),
            () => ({ ok: true }),
          ),
      },
      { name: '첨부 미리보기(이미지)', run: (h) => h.service.file({ ticketId: 1004, fileId: 7001, mode: 'preview' }) },
      { name: '첨부 받기(pdf)', run: (h) => h.service.file({ ticketId: 1004, fileId: 7002, mode: 'download' }) },
    ];

    for (const step of steps) {
      const results: unknown[] = [];
      for (const h of both) {
        // 상세를 먼저 읽어야 첨부를 받는다(첨부 목록 확인)
        if (step.name.startsWith('첨부')) await h.service.ticketDetail(1004);
        const res = await step.run(h).catch((e: unknown) => ({ thrown: e instanceof Error ? e.message : String(e) }));
        await h.service.refresh();
        results.push(JSON.parse(JSON.stringify(res, (_k, v: unknown) => (typeof v === 'string' ? v.split(h.filesDir).join('<files>') : v))));
      }
      expect({ step: step.name, result: results[0] }).toEqual({ step: step.name, result: results[1] });
      // 같기만 한 것이 아니라 뜻한 대로 됐는지(막는 단계는 ok:false, 나머지는 성공·값)
      const res = results[0] as { ok?: boolean; thrown?: string } | unknown[];
      expect({ step: step.name, thrown: (res as { thrown?: string }).thrown }).toEqual({ step: step.name, thrown: undefined });
      if (!Array.isArray(res) && typeof res.ok === 'boolean') expect({ step: step.name, ok: res.ok }).toEqual({ step: step.name, ok: !step.name.includes('막음') });
    }

    // 결과가 맞는 쪽으로 갔는지(둘 다 같으니 한쪽만): 해결·완료된 것은 보드에 없고 재오픈한 것은 있다
    expect(onBoard(api, 1005)).toBe(false);
    expect(onBoard(api, 1009)).toBe(false);
    expect(onBoard(api, 1006)).toBe(true);
    const created = (stateFiles(api)['tickets.json'] as { id: number; title: string; source?: string }[]).find((t) => t.title === '통영공장 인벤토리 확인 요청');
    expect(created).toMatchObject({ source: 'email' });
    expect(onBoard(api, created?.id ?? 0)).toBe(true);
    expect(comparable(api.service.board())).toEqual(comparable(cli.service.board()));
    expect(api.service.tasks()).toEqual(cli.service.tasks());
    // VOC 쪽 자료(가짜 voc-cli 상태 폴더 — tickets·worklogs·replies·email-logs)가 같다
    const sa = stateFiles(api);
    const sc = stateFiles(cli);
    delete sa['login.json'];
    delete sc['login.json'];
    expect(Object.keys(sa).sort()).toEqual(Object.keys(sc).sort());
    expect(sa).toEqual(sc);
    // 쓰기 기록도 같은 모양(id·시각 빼고)
    const strip = (h: Harness) => h.actions.list().map(({ id: _i, at: _a, ...rest }) => rest);
    expect(strip(api)).toEqual(strip(cli));
    // 받은 첨부 파일
    for (const h of both) {
      expect(fs.readFileSync(path.join(h.filesDir, '1004', 'screen.png')).equals(PNG)).toBe(true);
      expect(fs.statSync(path.join(h.filesDir, '1004', 'report.pdf')).size).toBe(fs.statSync(path.join(FIXTURE, 'files', '7002', 'report.pdf')).size);
    }
  });

  it('로그인 전: 보드는 login(터미널 명령 안내 없음) — 앱 안 로그인 뒤 ok, 세션은 암호화 파일', { timeout: 60_000 }, async () => {
    const h = await apiHarness({ login: false });
    const before = await h.service.refresh();
    expect(before).toMatchObject({ state: 'login', message: VOC_LOGIN_MESSAGE });
    expect(before.loginCommand).toBeUndefined();
    expect(h.server.requests).toEqual([]);

    const bad = await h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('로그인 실패: 아이디 또는 비밀번호를 확인하세요.');
    expect(h.store.load()).toBeNull();

    const res = await h.service.login({ loginId: 'hong', password: PASSWORD, remember: true });
    expect(res).toEqual({ ok: true, message: 'VOC 에 로그인했습니다(홍길동). 목록을 새로 받습니다' });
    const board = await h.service.refresh();
    expect(board.state).toBe('ok');
    expect(board.me).toMatchObject({ id: 101 });
    const file = path.join(h.dataDir, 'voc-session.bin');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from('access-'))).toBe(false);
    expect(raw.includes(Buffer.from(PASSWORD))).toBe(false);
    // 데이터 폴더 어디에도 비밀번호가 없다
    const all = (dir: string): string =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), 'latin1')))
        .join('\n');
    expect(all(h.dataDir)).not.toContain(PASSWORD);
    expect(fs.readFileSync(h.usageFile, 'utf8')).not.toContain(PASSWORD);
  });

  it('access 토큰 만료는 자동 갱신(보드 ok, 세션 파일 교체), refresh 까지 만료면 login(만료 문장)·세션 삭제', { timeout: 60_000 }, async () => {
    const h = await apiHarness();
    expect((await h.service.refresh()).state).toBe('ok');
    const before = h.store.load();
    h.server.expireAccess();
    const n = h.server.requests.length;
    expect((await h.service.refresh()).state).toBe('ok');
    const after = new VocSessionStore(path.join(h.dataDir, 'voc-session.bin'), fakeCodec).load();
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
    const paths = h.server.requests.slice(n).map((r) => `${r.method} ${r.path}`);
    expect(paths.filter((p) => p === 'POST /api/v2/auth/refresh')).toHaveLength(1);

    h.server.expireAll();
    const expired = await h.service.refresh();
    expect(expired).toMatchObject({ state: 'login', message: VOC_EXPIRED_MESSAGE });
    expect(expired.loginCommand).toBeUndefined();
    expect(expired.lanes.length).toBeGreaterThan(0); // 마지막 칸은 그대로
    expect(fs.existsSync(path.join(h.dataDir, 'voc-session.bin'))).toBe(false);
    // 다시 로그인하면 돌아온다
    expect((await h.service.login({ loginId: 'hong', password: PASSWORD, remember: false })).ok).toBe(true);
    expect((await h.service.refresh()).state).toBe('ok');
  });

  it('서버가 5xx 면 쓰기는 "결과를 모름"(반영됐는지 확인), 받기는 stale', { timeout: 60_000 }, async () => {
    const h = await apiHarness();
    expect((await h.service.refresh()).state).toBe('ok');
    h.server.forceStatus(500);
    const reply = await h.service.action({ actionId: aid(), kind: 'reply', ticketId: 1004, value: '확인했습니다' });
    expect(reply).toEqual({ ok: false, message: '가짜 서버 오류 — 반영됐는지 VOC 에서 확인하세요' });
    const stale = await h.service.refresh();
    expect(stale).toMatchObject({ state: 'stale', message: '가짜 서버 오류' });
    h.server.forceStatus(null);
    expect((await h.service.refresh()).state).toBe('ok');
  });

  it('업무 규칙 거부(fail-write: 400)는 서버 문장 그대로, 기록 ok:false', { timeout: 60_000 }, async () => {
    const h = await apiHarness({ mode: 'fail-write' });
    expect((await h.service.refresh()).state).toBe('ok');
    const input: VocWorkInput = { actionId: aid(), kind: 'worklogAdd', ticketId: 1004, worklog: { hours: 1, date: TODAY, note: '' } };
    const r = await h.service.work(input);
    expect(r).toEqual({ ok: false, message: '요청을 처리하지 못했습니다(가짜 쓰기 실패).' });
    expect(h.actions.list()[0]).toMatchObject({ id: input.actionId, ok: false });
    expect(usageRows(h.usageFile).at(-1)).toMatchObject({ command: 'worklog add 1004', method: 'POST', path: '/work-logs', status: 400 });
  });

  it('서버를 띄우지 않았으면(연결 거부) 처음 받기는 unavailable — 서버에 닿지 않은 쓰기는 기록하지 않는다', { timeout: 60_000 }, async () => {
    const port = await closedPort();
    const d = dirs();
    const url = `http://127.0.0.1:${port}`;
    const store = new VocSessionStore(path.join(d.dataDir, 'voc-session.bin'), null);
    store.save({ ...SESSION, apiUrl: url });
    const runner = new VocApiRunner({ apiUrl: () => url, sessions: store, downloadRoot: d.filesDir, usageFile: null });
    const { service, actions } = serviceOf(runner, d.dataDir, d.filesDir, false);
    const board = await service.refresh();
    expect(board.state).toBe('unavailable');
    expect(board.message).toContain('백엔드에 연결할 수 없습니다');
    const login = await service.login({ loginId: 'hong', password: PASSWORD, remember: false });
    expect(login.ok).toBe(false);
    expect(login.message.startsWith(VOC_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(actions.list()).toEqual([]);
  });

  it('첨부: 받은 크기가 첨부 목록과 다르면 지우고 실패(API 경로도 files.ts 검사를 거친다)', { timeout: 60_000 }, async () => {
    const h = await apiHarness();
    await h.service.refresh();
    await h.service.ticketDetail(1004);
    fs.mkdirSync(path.join(h.state, 'files', '7002'), { recursive: true });
    fs.writeFileSync(path.join(h.state, 'files', '7002', 'report.pdf'), '%PDF-short');
    await expect(h.service.file({ ticketId: 1004, fileId: 7002, mode: 'download' })).rejects.toThrow(/크기가 맞지 않아/);
    expect(fs.existsSync(path.join(h.filesDir, '1004', 'report.pdf'))).toBe(false);
    // exe 는 받되 열기 없음
    const exe = await h.service.file({ ticketId: 1004, fileId: 7003, mode: 'download' });
    expect(exe).toMatchObject({ fileName: 'setup.exe', canOpen: false });
    expect(h.server.requests.filter((r) => r.path.endsWith('/download')).map((r) => r.path)).toEqual([
      '/api/v2/files/7002/download',
      '/api/v2/files/7003/download',
    ]);
  });

  it('whoami 로 나를 찾는다(이메일 → 사용자 목록) — 서버의 /auth/me 를 그대로 옮긴 글을 parseWhoami 가 읽는다', { timeout: 60_000 }, async () => {
    const h = await apiHarness();
    const r = await h.runner.run(['whoami']);
    ok(r);
    expect(parseWhoami(r.stdout)).toEqual({ loginId: 'hong', name: '홍길동', email: 'owner@example.com', department: '샘플팀', backend: h.server.url });
    const board = await h.service.refresh();
    expect(board.me).toMatchObject({ id: 101, name: '홍길동' });
    expect(board.meMissing).toBeUndefined();
    expect(h.service.webUrl(1004)).toBe('https://127.0.0.1/maintenance/tickets/1004');
  });
});
