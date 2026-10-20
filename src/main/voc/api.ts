// VOC API 직접 호출 — voc-cli(java) 대신. electron 을 import 하지 않는다.
// 계약: docs/stage2.6-contract.md §15
//
// voc-cli 와 **같은 인자**를 받아 **같은 표준출력·표준에러(`오류: …`)·종료 코드**를 돌려준다(VocCliRunner 와 같은 run 모양).
// 그래서 위쪽(service.ts·model.ts·files.ts)의 해석은 그대로 쓴다. 앱이 실제로 만드는 인자 모양만 받고, 그 밖의 옵션은
// voc-cli 의 사용법 오류처럼 종료 코드 2 로 돌려준다(앱 버그).
//
// - 백엔드: `<주소>/api/v2`. 로그인은 지금 설정된 주소로 하고, 세션에 그 주소를 남긴다. 설정 주소가 바뀌면 세션을 버린다(다시 로그인).
// - 세션(토큰)은 앱 데이터 폴더의 voc-session.bin 에 Windows 계정으로 암호화해 둔다(codec — main 이 safeStorage 를 넘긴다).
//   암호화를 쓸 수 없으면 파일에 쓰지 않고 앱을 켜 둔 동안만 기억한다. voc-cli 의 ~/.voc-cli/session.json 은 읽지도 쓰지도 않는다.
// - 401 이면 refresh 토큰으로 한 번 갱신하고 다시 부른다. 갱신 실패면 세션을 지우고 '세션이 만료되었습니다'.
// - 한 번에 하나만 부른다(직렬 큐, 쓰기 먼저) — refresh 토큰을 쓸 때마다 바꾸므로 동시에 갱신하면 세션이 깨진다.
// - 호출마다 voc-cli 와 같은 사용량 기록(~/.voc-cli/usage.jsonl, 시범 과금 원장)에 한 줄 남긴다. 기록 실패는 무시한다.
// - 비밀번호(login 의 표준입력)는 어떤 로그·오류 문장에도 넣지 않고 요청을 보낸 뒤 버린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VOC_DOWNLOAD,
  VOC_LOGIN,
  VOC_READ_TIMEOUT_MS,
  VOC_STOPPED_MESSAGE,
  VOC_WRITE_COMMANDS,
  VOC_WRITE_TIMEOUT_MS,
  VocRunError,
  argsProblem,
  isTestEnv,
  vocCommandOf,
  vocDownloadProblem,
  type VocRunResult,
} from './cli';

/** 기본 VOC 백엔드(voc-cli 의 application.yml api-url 과 같다) */
export const VOC_DEFAULT_API_URL = 'https://voc.acme.test:11300';
const API_PREFIX = '/api/v2';
/** 백엔드에 보내는 클라이언트 이름(voc-cli 는 'voc-cli') */
export const VOC_CLIENT_ID = 'wiki-radar';
/** 오류 본문을 오류 문장에 옮길 때 최대 길이(voc-cli 와 같다) */
const ERROR_BODY_MAX = 300;
/** 첨부 한 개 최대 크기 */
const DOWNLOAD_LIMIT_BYTES = 200 * 1024 * 1024;
/** 첨부가 아닌 응답(JSON·오류 본문) 최대 크기 — 목록 한 쪽(티켓 수백 건)도 이보다 훨씬 작다 */
const JSON_LIMIT_BYTES = 20 * 1024 * 1024;
/** 토큰 갱신(/auth/refresh) 제한 시간 — 명령의 시간 초과·멈춤과 따로 센다(받은 새 토큰을 잃지 않게) */
const REFRESH_TIMEOUT_MS = 30_000;

export const VOC_API_GUARD_MESSAGE = '시험 중에는 실제 VOC 서버를 부르지 않습니다(WIKI_RADAR_VOC_URL 을 localhost 가짜 서버로)';

/** 이 PC(루프백) 주소인가 */
function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

/**
 * 백엔드 주소가 쓸 만한가: https://호스트[:포트] 만(경로·쿼리 없음, 끝 / 는 뗀다). 아니면 null.
 * http 는 이 PC(localhost·127.0.0.1·[::1] — 시험용 가짜 서버)에만 허용한다 — 비밀번호·토큰이 평문으로 나가지 않게
 */
export function normalizeVocApiUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\/+$/, '');
  if (s.length === 0 || s.length > 200) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol === 'http:' && !isLocalUrl(u.href)) return null;
  return `${u.protocol}//${u.host}`;
}

// ---- 세션 --------------------------------------------------------------------------------------

export interface VocSession {
  apiUrl: string;
  accessToken: string;
  refreshToken: string | null;
  loginId: string;
  userName: string;
  role: string;
}

/** 세션 파일 암호화(main 이 Electron safeStorage 로 만든다). 없으면 파일에 쓰지 않는다 */
export interface VocSessionCodec {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

function isSession(v: unknown): v is VocSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.apiUrl === 'string' &&
    typeof s.accessToken === 'string' &&
    s.accessToken !== '' &&
    (s.refreshToken === null || typeof s.refreshToken === 'string') &&
    typeof s.loginId === 'string' &&
    typeof s.userName === 'string' &&
    typeof s.role === 'string'
  );
}

/** 세션 저장소: 암호화 파일 하나 + 메모리. 읽지 못하는 파일은 없는 것으로 본다(다시 로그인) */
export class VocSessionStore {
  private memory: VocSession | null = null;
  private loaded = false;
  /** 마지막 저장이 파일까지 갔는가(실패하면 메모리에만 있다) */
  private persisted = true;

  constructor(
    private readonly file: string,
    private readonly codec: VocSessionCodec | null,
  ) {}

  /** 저장 위치(로그인 성공 문장에 쓴다) — 마지막 저장이 실제로 파일에 갔을 때만 파일 경로 */
  get location(): string {
    if (!this.codec) return '앱을 켜 둔 동안만(암호화를 쓸 수 없어 파일에 저장하지 않음)';
    return this.persisted ? this.file : '앱을 켜 둔 동안만(세션 파일에 저장하지 못함)';
  }

  load(): VocSession | null {
    if (this.loaded) return this.memory;
    this.loaded = true;
    if (!this.codec) return null;
    try {
      const parsed: unknown = JSON.parse(this.codec.decrypt(fs.readFileSync(this.file)));
      this.memory = isSession(parsed) ? parsed : null;
    } catch {
      this.memory = null;
    }
    return this.memory;
  }

  save(s: VocSession): void {
    this.memory = { ...s };
    this.loaded = true;
    if (!this.codec) return;
    const tmp = `${this.file}.tmp`;
    let data: Buffer;
    try {
      data = this.codec.encrypt(JSON.stringify(s));
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, data);
    } catch {
      this.dropStaleFile(tmp);
      return;
    }
    try {
      fs.renameSync(tmp, this.file);
      this.persisted = true;
      return;
    } catch {
      // Windows 에서 백신·색인이 파일을 잡고 있으면 바꿔치기(rename)가 EPERM·EBUSY 로 실패한다 — 제자리에 한 번 더 써 본다
    }
    try {
      fs.writeFileSync(this.file, data);
      fs.rmSync(tmp, { force: true });
      this.persisted = true;
    } catch {
      this.dropStaleFile(tmp);
    }
  }

  /**
   * 새 세션을 파일에 남기지 못했다 — 이번 실행 동안은 메모리 세션으로 쓰되, 옛 파일은 지운다.
   * 남겨 두면 다음 실행에서 앞사람(다른 아이디)의 세션이나 이미 폐기된(갱신 때 바뀐) refresh 토큰이 되살아난다
   */
  private dropStaleFile(tmp: string): void {
    this.persisted = false;
    for (const f of [tmp, this.file]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // 지우지도 못하면 다음 실행에서 토큰이 거부되어 다시 로그인한다
      }
    }
  }

  clear(): void {
    this.memory = null;
    this.loaded = true;
    this.persisted = true;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      // 지우지 못하면 다음 읽기에서 토큰이 거부되어 다시 지운다
    }
  }
}

// ---- 사용량 기록(voc-cli 시범 과금 원장과 같은 줄 모양) ----------------------------------------

/** 원장의 command 값: 앞 인자 중 '-' 로 시작하기 전까지 최대 3개(voc-cli CliRunner 와 같다) */
export function usageLabel(args: readonly string[]): string {
  const words: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') || words.length >= 3) break;
    words.push(a);
  }
  return words.join(' ');
}

export const DEFAULT_USAGE_FILE = path.join(os.homedir(), '.voc-cli', 'usage.jsonl');

function appendUsage(file: string | null, row: Record<string, unknown>): void {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}${os.EOL}`);
  } catch {
    // 계측이 기능을 깨면 안 된다
  }
}

// ---- 오류 ------------------------------------------------------------------------------------

/** voc-cli 가 `오류: <message>` 로 찍고 종료 코드 1(사용법 오류는 2)로 끝나는 경우 */
class CliFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** 오류 응답 본문 → 문장: message → detail → error, 없으면 본문 앞 300자, 비면 '(응답 본문 없음)' */
export function extractApiError(body: string): string {
  const text = body ?? '';
  if (text.trim() === '') return '(응답 본문 없음)';
  try {
    const node: unknown = JSON.parse(text);
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const key of ['message', 'detail', 'error']) {
        const v = (node as Record<string, unknown>)[key];
        if (v === undefined || v === null) continue;
        return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
      }
    }
  } catch {
    // 아래로
  }
  return text.length > ERROR_BODY_MAX ? `${text.slice(0, ERROR_BODY_MAX)}…` : text;
}

/** 연결 자체가 안 된 경우(voc-cli 의 ConnectException 에 해당하는 것) */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function networkFailure(err: unknown, baseUrl: string): CliFailure {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (CONNECT_CODES.has(code)) return new CliFailure(`백엔드에 연결할 수 없습니다: ${baseUrl} — 서버가 실행 중인지 확인하세요.`);
  const msg = typeof cause?.message === 'string' && cause.message ? cause.message : err instanceof Error ? err.message : String(err);
  return new CliFailure(`요청 실패: ${code ? `${code} ` : ''}${msg}`.trim());
}

// ---- 인자 ------------------------------------------------------------------------------------

/** 값 없이 쓰는 옵션 */
const FLAGS = new Set(['--json', '--replies', '--hide-completed', '--clear-ict-due', '--resolve', '-y', '--password']);

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

/** 명령 이름 뒤 인자 → 위치 인자·옵션(`--a b`·`--a=b`)·플래그. 같은 옵션이 두 번이면 사용법 오류 */
function parseArgs(rest: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], options: new Map(), flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('-') || a === '-') {
      out.positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 && a.startsWith('--') ? a.slice(0, eq) : a;
    if (FLAGS.has(name)) {
      if (eq > 0) throw new CliFailure(`옵션 ${name} 에는 값을 줄 수 없습니다`, 2);
      out.flags.add(name);
      continue;
    }
    let value: string;
    if (eq > 0 && a.startsWith('--')) value = a.slice(eq + 1);
    else {
      if (i + 1 >= rest.length) throw new CliFailure(`옵션 ${name} 에 값이 없습니다`, 2);
      value = rest[++i];
    }
    if (out.options.has(name)) throw new CliFailure(`옵션 ${name} 이 두 번 있습니다`, 2);
    out.options.set(name, value);
  }
  return out;
}

/** 받는 옵션·플래그·위치 인자 수가 맞는지(그 밖이면 사용법 오류) */
function expect(p: ParsedArgs, spec: { positional: number; options?: readonly string[]; flags?: readonly string[] }): void {
  if (p.positional.length !== spec.positional) throw new CliFailure(`위치 인자는 ${spec.positional}개여야 합니다`, 2);
  for (const k of p.options.keys()) if (!spec.options?.includes(k)) throw new CliFailure(`알 수 없는 옵션: ${k}`, 2);
  for (const f of p.flags) if (!spec.flags?.includes(f)) throw new CliFailure(`알 수 없는 옵션: ${f}`, 2);
}

function idArg(v: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(v)) throw new CliFailure(`id 는 양의 정수여야 합니다: ${v}`, 2);
  return Number(v);
}

/** YYYY-MM-DD(실제 있는 날짜). 앞뒤 공백은 뗀다. 문장은 voc-cli Dates.toDate·toDateTime 과 같다 */
function dateArg(raw: string): string {
  const v = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new CliFailure(`날짜 형식이 올바르지 않습니다: ${v} (YYYY-MM-DD)`);
  }
  return v;
}

const TICKET_STATUSES = ['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'withdrawn'];
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+$/;

function emailList(v: string | undefined, option: string): string[] {
  const list = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const a of list) if (!EMAIL_RE.test(a)) throw new CliFailure(`이메일 형식이 올바르지 않습니다: ${a} (${option})`);
  return list;
}

function pretty(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}

/** 서버 값 → 요약 줄 값(voc-cli 의 Tickets.str — 없거나 null 이면 빈 글자) */
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? '' : String(v);
}

/** 서버 값 → whoami 줄 값(voc-cli 의 asText("-")) */
function asText(v: unknown): string {
  if (v === undefined || v === null) return '-';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ---- 첨부 파일 이름(voc-cli FileDownloadCommand 와 같은 규칙) ------------------------------------

/** java 문자 집합 이름 중 WHATWG(TextDecoder) 이름표와 다른 흔한 것 → TextDecoder 이름표 */
const JAVA_CHARSET_ALIASES: Readonly<Record<string, string>> = {
  // MS949(CP949) → euc-kr. KS X 1001 글자는 같게 읽지만, Node(ICU)의 euc-kr 은 CP949 확장 영역(예: 0x8C63 '똠')을 읽지 못해
  // 그 글자는 java 와 달라진다(드물다 — 실제 백엔드는 늘 UTF-8)
  'x-windows-949': 'euc-kr',
  ms949: 'euc-kr',
  cp949: 'euc-kr',
  'windows-949': 'euc-kr',
  'utf-16': 'utf-16be', // java UTF-16 은 BOM 이 없으면 big-endian(BOM 이 있으면 TextDecoder 가 뗀다)
  'x-utf-16le-bom': 'utf-16le',
};

/** 바이트 → 글자(그 문자 집합으로). 모르는 이름이면 UTF-8 — voc-cli 가 Charset.forName 실패 때 UTF-8 로 읽는 것과 같다 */
function decodeBytes(bytes: Buffer, charset: string): string {
  const cs = charset.trim().toLowerCase();
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'us-ascii') return bytes.toString('latin1');
  try {
    // fatal:false — 잘못된 바이트는 U+FFFD(java 디코더의 REPLACE 와 같다)
    return new TextDecoder(JAVA_CHARSET_ALIASES[cs] ?? cs, { fatal: false }).decode(bytes);
  } catch {
    // 모르는 이름표(RangeError)
    return bytes.toString('utf8');
  }
}

/**
 * RFC 5987 값 풀기(voc-cli 의 URLDecoder.decode(encoded, Charset.forName(charset)) 와 같게): 이어진 %XX 를 바이트로 모아
 * 그 문자 집합으로 읽는다 — ISO-8859-1(latin1)·US-ASCII 는 그대로, UTF-8·EUC-KR(MS949)·Shift_JIS·UTF-16 등 TextDecoder 가
 * 아는 것은 그 문자 집합으로, 모르는 이름은 UTF-8(잘못된 바이트는 U+FFFD). java 와 TextDecoder 의 이름표가 모두 같지는 않아
 * 드문 이름은 다를 수 있다. '%' 뒤가 16진 두 자리가 아니면 voc-cli 는 명령이 실패하지만 여기서는 원문을 이름으로 쓴다
 * (어차피 sanitizeFilename 을 거친다)
 */
function percentDecode(encoded: string, charset: string): string {
  if (/%(?![0-9A-Fa-f]{2})/.test(encoded)) return encoded;
  // URLDecoder 처럼: 이어진 %XX 묶음만 바이트로 모아 그 문자 집합으로 읽고, 그 밖의 글자는 그대로 둔다
  return encoded.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => decodeBytes(Buffer.from(run.replace(/%/g, ''), 'hex'), charset));
}

/** Content-Disposition → 파일 이름(filename* 우선). 없으면 null */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  let plain: string | null = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (key === 'filename*') {
      const q = value.indexOf("''");
      const charset = q > 0 ? value.slice(0, q) : 'UTF-8';
      const encoded = (q >= 0 ? value.slice(q + 2) : value).replace(/\+/g, '%2B');
      return percentDecode(encoded, charset);
    }
    // filename= 이 여러 개면 마지막 것(voc-cli 와 같다). filename* 가 있으면 그것이 먼저다
    if (key === 'filename') {
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      plain = value;
    }
  }
  return plain;
}

const RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** 저장할 수 있는 파일 이름으로(경로 떼기·금지 글자 _·앞뒤 점/공백·예약 이름·200자) */
export function sanitizeFilename(raw: string | null, fileId: number): string {
  const fallback = `file-${fileId}`;
  let name = raw ?? fallback;
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
  // java 정규식의 \s 는 ASCII 공백(빈칸·\t\n\v\f\r)만이다 — JS 의 \s 처럼 nbsp·전각 공백까지 떼면 voc-cli 와 이름이 달라진다
  name = name.replace(/^[.\t\n\v\f\r ]+/, '').replace(/[.\t\n\v\f\r ]+$/, '');
  if (name === '') name = fallback;
  const dot = name.indexOf('.');
  if (RESERVED_RE.test(dot >= 0 ? name.slice(0, dot) : name)) name = `_${name}`;
  if (name.length > 200) {
    const last = name.lastIndexOf('.');
    const ext = last > 0 && name.length - last <= 20 ? name.slice(last) : '';
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

// ---- 실행기 ------------------------------------------------------------------------------------

interface Job {
  args: string[];
  write: boolean;
  timeoutMs: number;
  stdin?: string;
  resolve: (r: VocRunResult) => void;
  reject: (e: Error) => void;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface VocApiRunnerOptions {
  /** 지금 설정된 백엔드 주소(normalizeVocApiUrl 을 거친 것) */
  apiUrl: () => string;
  sessions: VocSessionStore;
  /** 첨부 내려받기 폴더의 뿌리(voc-files). 없으면 내려받지 않는다 */
  downloadRoot?: string;
  /** 사용량 기록 파일(null 이면 남기지 않는다) */
  usageFile?: string | null;
  /** 앱 버전(User-Agent) */
  appVersion?: string;
  fetchImpl?: typeof fetch;
  /** 토큰 갱신 제한 시간(시험용, 기본 30초) */
  refreshTimeoutMs?: number;
}

/** VocCliRunner 와 같은 모양의 실행기 — java 대신 HTTP 로 부른다 */
export class VocApiRunner {
  private readonly opts: VocApiRunnerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly queue: Job[] = [];
  private active: { abort: (e: Error) => void; controller: AbortController } | null = null;
  /**
   * 끝나지 않은 토큰 갱신. 명령이 시간 초과·멈춤으로 끝나도 갱신은 끝까지 기다려 새 토큰을 저장한다(서버는 옛 refresh 토큰을
   * 이미 폐기했을 수 있다). 그동안 다음 명령은 시작하지 않는다 — 옛 토큰으로 갱신을 겨루지 않게
   */
  private refreshing: Promise<unknown> | null = null;

  constructor(opts: VocApiRunnerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get busy(): boolean {
    return this.active !== null || this.refreshing !== null;
  }

  get pending(): number {
    return this.queue.length;
  }

  run(args: string[], opts: { write?: boolean; timeoutMs?: number; stdin?: string } = {}): Promise<VocRunResult> {
    const problem = argsProblem(args);
    if (problem) return Promise.reject(new VocRunError({ state: 'unavailable', message: `${problem} (앱 버그)` }));
    const command = vocCommandOf(args);
    if (!command) {
      return Promise.reject(
        new VocRunError({ state: 'unavailable', message: `허용하지 않는 VOC 명령입니다: ${args.slice(0, 2).join(' ').slice(0, 80)} (앱 버그)` }),
      );
    }
    if (command === VOC_DOWNLOAD) {
      const bad = vocDownloadProblem(args, this.opts.downloadRoot);
      if (bad) return Promise.reject(new VocRunError({ state: 'unavailable', message: `${bad} (앱 버그)` }));
    }
    if (opts.stdin !== undefined && command !== VOC_LOGIN) {
      return Promise.reject(new VocRunError({ state: 'unavailable', message: '표준입력은 login 에만 넘깁니다 (앱 버그)' }));
    }
    // 시험 중에는 이 PC 의 가짜 서버(localhost)에만 보낸다(명세 §9 의 가드와 같은 기준)
    if (isTestEnv(process.env) && !isLocalUrl(this.opts.apiUrl())) {
      return Promise.reject(new VocRunError({ state: 'notConfigured', message: VOC_API_GUARD_MESSAGE }));
    }
    const write = opts.write ?? VOC_WRITE_COMMANDS.includes(command);
    const base = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : write ? VOC_WRITE_TIMEOUT_MS : VOC_READ_TIMEOUT_MS;
    const timeoutMs = Math.min(base, 2_147_483_647);
    return new Promise<VocRunResult>((resolve, reject) => {
      const job: Job = { args: [...args], write, timeoutMs, resolve, reject };
      if (opts.stdin !== undefined) job.stdin = opts.stdin;
      this.queue.push(job);
      this.pump();
    });
  }

  stopAll(): void {
    for (const job of this.queue.splice(0)) {
      job.stdin = undefined;
      job.reject(new VocRunError({ state: 'unavailable', message: VOC_STOPPED_MESSAGE }));
    }
    this.active?.abort(new VocRunError({ state: 'unavailable', message: VOC_STOPPED_MESSAGE }));
  }

  private pump(): void {
    if (this.active || this.refreshing || this.queue.length === 0) return;
    const i = this.queue.findIndex((j) => j.write);
    const job = this.queue.splice(i >= 0 ? i : 0, 1)[0];
    if (job) void this.execute(job);
  }

  private async execute(job: Job): Promise<void> {
    const controller = new AbortController();
    let settled = false;
    let timedOut = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (this.active === run) this.active = null;
      fn();
      queueMicrotask(() => this.pump());
    };
    const run = {
      controller,
      abort: (e: Error) => {
        controller.abort();
        finish(() => job.reject(e));
      },
    };
    this.active = run;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      finish(() => job.resolve({ code: -1, stdout: '', stderr: '', timedOut: true }));
    }, job.timeoutMs);

    const stdin = job.stdin;
    job.stdin = undefined;
    let result: VocRunResult;
    try {
      const stdout = await this.dispatch(job.args, stdin, controller.signal);
      result = { code: 0, stdout, stderr: '', timedOut: false };
    } catch (err) {
      if (timedOut || controller.signal.aborted) return; // 이미 끝냈다(시간 초과·멈춤)
      if (err instanceof VocRunError) {
        // 보내기 직전의 가드(시험 중 localhost 밖 주소) — 서버에 닿지 않았다
        finish(() => job.reject(err));
        return;
      }
      if (err instanceof CliFailure) result = { code: err.exitCode, stdout: '', stderr: `오류: ${err.message}\n`, timedOut: false };
      else result = { code: 1, stdout: '', stderr: `오류: 요청 실패: ${err instanceof Error ? err.message : String(err)}\n`, timedOut: false };
    }
    finish(() => job.resolve(result));
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async send(
    baseUrl: string,
    method: string,
    apiPath: string,
    o: { bearer?: string; body?: unknown; accept?: string; signal: AbortSignal; maxBytes?: number },
  ): Promise<HttpResult> {
    // 시험 중에는 이 PC 의 가짜 서버에만 — run() 의 검사는 줄 세울 때라, 기다리는 사이 설정 주소가 바뀌어도 여기서 막는다
    if (isTestEnv(process.env) && !isLocalUrl(baseUrl)) throw new VocRunError({ state: 'notConfigured', message: VOC_API_GUARD_MESSAGE });
    const headers: Record<string, string> = {
      Accept: o.accept ?? 'application/json',
      'User-Agent': `wiki-radar/${this.opts.appVersion ?? '0'}`,
      'X-Client': VOC_CLIENT_ID,
    };
    if (o.bearer) headers.Authorization = `Bearer ${o.bearer}`;
    let body: string | undefined;
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}${API_PREFIX}${apiPath}`, { method, headers, body, redirect: 'manual', signal: o.signal });
    } catch (err) {
      if (o.signal.aborted) throw err;
      throw networkFailure(err, baseUrl);
    }
    const data = await readLimited(res, o.maxBytes ?? JSON_LIMIT_BYTES).catch((err: unknown) => {
      if (err instanceof CliFailure || o.signal.aborted) throw err;
      throw networkFailure(err, baseUrl);
    });
    return { status: res.status, headers: res.headers, body: data };
  }

  /** 로그인한 세션으로 부른다. 401 이면 한 번 갱신하고 다시. 사용량 한 줄. 2xx 가 아니면 `<상태> — <문장>` */
  private async authorized(
    label: string,
    method: string,
    apiPath: string,
    signal: AbortSignal,
    o: { body?: unknown; accept?: string; maxBytes?: number } = {},
  ): Promise<HttpResult> {
    const session = this.requireSession();
    const start = Date.now();
    let res = await this.send(session.apiUrl, method, apiPath, { ...o, bearer: session.accessToken, signal });
    if (res.status === 401) {
      const refreshed = await this.refresh(session);
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      res = await this.send(refreshed.apiUrl, method, apiPath, { ...o, bearer: refreshed.accessToken, signal });
    }
    appendUsage(this.opts.usageFile === undefined ? DEFAULT_USAGE_FILE : this.opts.usageFile, {
      ts: new Date().toISOString(),
      command: label,
      method,
      path: apiPath.replace(/\?.*$/, ''),
      status: res.status,
      ms: Date.now() - start,
    });
    if (res.status < 200 || res.status > 299) throw new CliFailure(`${res.status} — ${extractApiError(res.body.toString('utf8'))}`);
    return res;
  }

  private requireSession(): VocSession {
    const s = this.opts.sessions.load();
    if (!s) throw new CliFailure('로그인이 필요합니다. VOC 화면에서 로그인하세요.');
    if (s.apiUrl !== this.opts.apiUrl()) {
      // 백엔드 주소를 바꿨다 — 다른 서버의 토큰은 쓰지 않는다
      this.opts.sessions.clear();
      throw new CliFailure('로그인이 필요합니다. VOC 서버 주소가 바뀌어 다시 로그인해야 합니다.');
    }
    return s;
  }

  /**
   * refresh 토큰으로 새 토큰을 받아 저장한다. 서버는 쓴 refresh 토큰을 바로 폐기하므로(rotation), 명령의 시간 초과·멈춤(job 의
   * AbortSignal)에 묶지 않고 자기 제한 시간으로 끝까지 돌려 받은 토큰을 저장한다. 끝날 때까지 큐는 다음 명령을 시작하지 않는다
   */
  private refresh(session: VocSession): Promise<VocSession> {
    const job = this.refreshNow(session);
    const settled = job.then(
      () => undefined,
      () => undefined,
    );
    this.refreshing = settled;
    void settled.then(() => {
      if (this.refreshing === settled) this.refreshing = null;
      queueMicrotask(() => this.pump());
    });
    return job;
  }

  private async refreshNow(session: VocSession): Promise<VocSession> {
    const expired = new CliFailure('세션이 만료되었습니다. VOC 화면에서 다시 로그인하세요.');
    if (!session.refreshToken) {
      this.opts.sessions.clear();
      throw expired;
    }
    const signal = AbortSignal.timeout(this.opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS);
    let res: HttpResult;
    try {
      res = await this.send(session.apiUrl, 'POST', '/auth/refresh', { body: { refreshToken: session.refreshToken }, signal });
    } catch (err) {
      // 갱신 자체의 시간 초과 — 결과를 모른다(세션은 지우지 않는다. 토큰이 이미 폐기됐다면 다음 갱신이 만료로 끝난다)
      if (signal.aborted && !(err instanceof CliFailure) && !(err instanceof VocRunError)) {
        throw new CliFailure('요청 실패: 토큰 갱신이 제한 시간 안에 끝나지 않았습니다');
      }
      throw err;
    }
    if (res.status !== 200) {
      this.opts.sessions.clear();
      throw expired;
    }
    const root = jsonObject(res.body);
    const accessToken = typeof root.accessToken === 'string' ? root.accessToken : '';
    if (!accessToken) {
      this.opts.sessions.clear();
      throw expired;
    }
    const next: VocSession = {
      ...session,
      accessToken,
      refreshToken: typeof root.refreshToken === 'string' && root.refreshToken ? root.refreshToken : session.refreshToken,
    };
    this.opts.sessions.save(next);
    return next;
  }

  // ---- 명령 ----------------------------------------------------------------------------------

  private async dispatch(args: string[], stdin: string | undefined, signal: AbortSignal): Promise<string> {
    const label = usageLabel(args);
    const command = vocCommandOf(args) ?? '';
    const p = parseArgs(command === 'whoami' ? args.slice(1) : command === VOC_LOGIN ? args.slice(1) : args.slice(2));
    const get = async (apiPath: string) => jsonOf((await this.authorized(label, 'GET', apiPath, signal)).body);

    switch (command) {
      case 'ticket list': {
        expect(p, { positional: 0, options: ['--size', '--page'], flags: ['--hide-completed', '--json'] });
        const q = new URLSearchParams();
        if (p.flags.has('--hide-completed')) q.set('showCompleted', 'false');
        q.set('page', String(intOption(p, '--page', 1)));
        q.set('size', String(intOption(p, '--size', 20)));
        return pretty(await get(`/tickets?${q}`));
      }
      case 'ticket get': {
        expect(p, { positional: 1, flags: ['--replies', '--json'] });
        const id = idArg(p.positional[0]);
        const ticket = await get(`/tickets/${id}`);
        if (p.flags.has('--replies') && ticket && typeof ticket === 'object' && !Array.isArray(ticket)) {
          (ticket as Record<string, unknown>).replies = await get(`/tickets/${id}/replies`);
        }
        return pretty(ticket);
      }
      case 'user list': {
        expect(p, { positional: 0, options: ['--role'], flags: ['--json'] });
        const role = p.options.get('--role');
        return pretty(await get(`/users${role ? `?${new URLSearchParams({ role })}` : ''}`));
      }
      case 'code list': {
        expect(p, { positional: 1, flags: ['--json'] });
        return pretty(await get(`/admin/codes?${new URLSearchParams({ groupCode: p.positional[0] })}`));
      }
      case 'customer list': {
        expect(p, { positional: 0, flags: ['--json'] });
        return pretty(await get('/admin/customers'));
      }
      case 'whoami': {
        expect(p, { positional: 0 });
        const session = this.requireSession();
        const me = jsonObject((await this.authorized(label, 'GET', '/auth/me', signal)).body);
        const lines = [
          `로그인 ID   : ${asText(me.loginId)}`,
          `이름        : ${asText(me.name)}`,
          `이메일      : ${asText(me.email)}`,
          `권한(role)  : ${asText(me.role)}`,
          `부서        : ${asText(me.department)}`,
        ];
        if (me.customerName !== undefined && me.customerName !== null) lines.push(`고객사      : ${asText(me.customerName)}`);
        lines.push(`백엔드      : ${session.apiUrl}`);
        return `${lines.join('\n')}\n`;
      }
      case 'ticket update': {
        expect(p, { positional: 1, options: ['-s', '--status', '-p', '--assignee', '--ict-due'], flags: ['--clear-ict-due', '--json'] });
        const id = idArg(p.positional[0]);
        const body: Record<string, unknown> = {};
        const status = p.options.get('-s') ?? p.options.get('--status');
        if (p.options.has('-s') && p.options.has('--status')) throw new CliFailure('상태 옵션이 두 번 있습니다', 2);
        if (status !== undefined) {
          if (!TICKET_STATUSES.includes(status)) throw new CliFailure(`상태는 [${TICKET_STATUSES.join(', ')}] 중 하나여야 합니다: ${status}`);
          body.status = status;
        }
        const priority = p.options.get('-p');
        if (priority !== undefined) {
          if (!/^P[123]$/.test(priority)) throw new CliFailure(`우선순위는 P1/P2/P3 중 하나여야 합니다: ${priority}`);
          body.priority = priority;
        }
        const assignee = p.options.get('--assignee');
        if (assignee !== undefined) body.internalAssigneeId = idArg(assignee);
        const ictDue = p.options.get('--ict-due');
        if (ictDue !== undefined) body.ictDueDate = `${dateArg(ictDue)}T00:00:00`;
        if (p.flags.has('--clear-ict-due')) body.clearIctDueDate = true;
        if (Object.keys(body).length === 0) throw new CliFailure('변경할 필드를 하나 이상 지정하세요. (예: --status resolved)');
        return pretty(jsonOf((await this.authorized(label, 'PUT', `/tickets/${id}`, signal, { body })).body));
      }
      case 'ticket reply': {
        expect(p, { positional: 1, options: ['--content'] });
        const id = idArg(p.positional[0]);
        const content = p.options.get('--content') ?? '';
        if (content.trim() === '') throw new CliFailure('답변 내용을 입력하세요. (--content)');
        const created = jsonObject((await this.authorized(label, 'POST', `/tickets/${id}/replies`, signal, { body: { content } })).body);
        return `답변이 등록되었습니다. (답변 id=${str(created.id)})\n`;
      }
      case 'ticket create': {
        expect(p, {
          positional: 0,
          options: ['--title', '--desc', '--customer-id', '--system', '--type', '-p', '--assignee', '--source'],
          flags: ['--json'],
        });
        const title = p.options.get('--title') ?? '';
        if (title.trim() === '') throw new CliFailure('제목을 입력하세요. (--title)');
        const body: Record<string, unknown> = { title };
        const put = (key: string, v: string | undefined) => {
          if (v !== undefined && v.trim() !== '') body[key] = v;
        };
        put('description', p.options.get('--desc'));
        const priority = p.options.get('-p');
        if (priority !== undefined && !/^P[123]$/.test(priority)) throw new CliFailure(`우선순위는 P1/P2/P3 중 하나여야 합니다: ${priority}`);
        put('priority', priority);
        const customerId = p.options.get('--customer-id');
        if (customerId !== undefined) body.customerId = idArg(customerId);
        put('system', p.options.get('--system'));
        put('requestType', p.options.get('--type'));
        const assignee = p.options.get('--assignee');
        if (assignee !== undefined) body.internalAssigneeId = idArg(assignee);
        put('source', p.options.get('--source'));
        return pretty(jsonOf((await this.authorized(label, 'POST', '/tickets', signal, { body })).body));
      }
      case 'worklog list': {
        expect(p, { positional: 1, flags: ['--json'] });
        const id = idArg(p.positional[0]);
        return pretty(await get(`/work-logs?${new URLSearchParams({ entityType: 'ticket', entityId: String(id) })}`));
      }
      case 'ticket email-logs': {
        expect(p, { positional: 1, flags: ['--json'] });
        return pretty(await get(`/tickets/${idArg(p.positional[0])}/email-logs`));
      }
      case 'worklog add': {
        expect(p, { positional: 1, options: ['--hours', '--date', '--note'], flags: ['--json'] });
        const id = idArg(p.positional[0]);
        const hoursText = p.options.get('--hours');
        if (hoursText === undefined) throw new CliFailure("Missing required option: '--hours=<hours>'", 2);
        // picocli 는 double 로 읽는다 — 숫자가 아니면 인자 오류(종료 코드 2), 범위 밖이면 voc-cli 문장(값은 java double 표기)
        const hours = JAVA_DOUBLE_RE.test(hoursText) ? Number(hoursText.trim()) : null;
        if (hours === null) throw new CliFailure(`Invalid value for option '--hours': '${hoursText}' is not a double`, 2);
        if (!(hours > 0 && hours <= 24)) {
          throw new CliFailure(`작업 시간은 0보다 크고 24 이하여야 합니다: ${javaDouble(hours)} (--hours)`);
        }
        const date = p.options.get('--date');
        if (date === undefined) throw new CliFailure('날짜를 지정하세요. (--date)', 2);
        const note = p.options.get('--note');
        const body = {
          entityType: 'ticket',
          entityId: id,
          workDate: dateArg(date),
          hours,
          note: note !== undefined && note.trim() !== '' ? note : null,
        };
        return pretty(jsonOf((await this.authorized(label, 'POST', '/work-logs', signal, { body })).body));
      }
      case 'worklog delete': {
        expect(p, { positional: 1, flags: ['-y'] });
        const id = idArg(p.positional[0]);
        if (!p.flags.has('-y')) throw new CliFailure('확인 입력을 받을 콘솔이 없습니다. 삭제하려면 --yes 를 붙이세요.');
        await this.authorized(label, 'POST', `/work-logs/${id}/delete`, signal, { body: {} });
        return `삭제했습니다: 작업 로그 id=${id}\n`;
      }
      case 'ticket email': {
        expect(p, { positional: 1, options: ['--to', '--cc', '--reply-id'], flags: ['--resolve', '--json'] });
        const id = idArg(p.positional[0]);
        const to = emailList(p.options.get('--to'), '--to');
        if (to.length === 0) throw new CliFailure('받는 사람 이메일을 입력하세요. (--to)');
        const cc = emailList(p.options.get('--cc'), '--cc');
        const rawReplyIds = p.options.get('--reply-id');
        let replyIds: number[] | null =
          rawReplyIds === undefined
            ? null
            : rawReplyIds
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '')
                .map(idArg);
        // 고른 답변이 없으면 null(서버 기본: 전체 답변) — voc-cli 와 같다
        if (replyIds !== null && replyIds.length === 0) replyIds = null;
        const changeStatus = p.flags.has('--resolve');
        await this.authorized(label, 'POST', `/tickets/${id}/email`, signal, {
          body: { toAddresses: to, ccAddresses: cc, changeStatus, replyIds },
        });
        return pretty({ ticketId: id, sent: true, toAddresses: to, ccAddresses: cc, changeStatus, replyIds });
      }
      case 'ticket resolve':
      case 'ticket close':
      case 'ticket reopen': {
        expect(p, { positional: 1 });
        const id = idArg(p.positional[0]);
        const status = command === 'ticket resolve' ? 'resolved' : command === 'ticket close' ? 'closed' : 'assigned';
        const t = jsonObject((await this.authorized(label, 'PUT', `/tickets/${id}`, signal, { body: { status } })).body);
        const head =
          status === 'resolved' ? '해결(resolved) 처리했습니다.' : status === 'closed' ? '완료(closed) 처리했습니다.' : '재오픈(assigned)했습니다.';
        const lines = [
          head,
          `  번호    : ${str(t.ticketNumber)}  (id=${str(t.id)})`,
          `  제목    : ${str(t.title)}`,
          `  상태    : ${str(t.status)}   우선순위: ${str(t.priority)}`,
        ];
        if (typeof t.internalAssigneeName === 'string' && t.internalAssigneeName.trim() !== '') lines.push(`  담당자  : ${t.internalAssigneeName}`);
        return `${lines.join('\n')}\n`;
      }
      case VOC_DOWNLOAD: {
        expect(p, { positional: 1, options: ['--out'], flags: ['--json'] });
        const fileId = idArg(p.positional[0]);
        const dir = path.resolve(p.options.get('--out') ?? '');
        const res = await this.authorized(label, 'GET', `/files/${fileId}/download`, signal, { accept: '*/*', maxBytes: DOWNLOAD_LIMIT_BYTES });
        const filename = sanitizeFilename(filenameFromDisposition(res.headers.get('content-disposition')), fileId);
        const target = path.normalize(path.join(dir, filename));
        if (path.dirname(target) !== path.normalize(dir)) throw new CliFailure(`안전하지 않은 파일명입니다: ${filename}`);
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, res.body);
        } catch (err) {
          throw new CliFailure(`파일 저장 실패: ${target} — ${err instanceof Error ? err.message : String(err)}`);
        }
        return pretty({
          path: target,
          filename,
          size: res.body.length,
          contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        });
      }
      case VOC_LOGIN: {
        // 모양은 vocCommandOf 가 이미 확인했다: login -u <아이디> --password
        const loginId = p.options.get('-u') ?? '';
        const password = (stdin ?? '').split(/\r?\n/)[0] ?? '';
        // 표준입력이 비었다 — voc-cli LoginCommand 와 같은 문장(service 의 loginVerdict 가 이 문장으로 '앱 버그'를 알아보고 잠금 셈에 넣지 않는다)
        if (password === '') throw new CliFailure('비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.');
        const baseUrl = this.opts.apiUrl();
        const res = await this.send(baseUrl, 'POST', '/auth/login', { body: { loginId, password }, signal });
        if (res.status === 401) throw new CliFailure('로그인 실패: 아이디 또는 비밀번호를 확인하세요.');
        if (res.status < 200 || res.status > 299) throw new CliFailure(`${res.status} — ${extractApiError(res.body.toString('utf8'))}`);
        const root = jsonObject(res.body);
        const user = root.user && typeof root.user === 'object' ? (root.user as Record<string, unknown>) : {};
        const accessToken = typeof root.accessToken === 'string' ? root.accessToken : '';
        if (!accessToken) throw new CliFailure('응답 파싱 실패: accessToken 이 없습니다');
        const session: VocSession = {
          apiUrl: baseUrl,
          accessToken,
          refreshToken: typeof root.refreshToken === 'string' && root.refreshToken ? root.refreshToken : null,
          loginId: typeof user.loginId === 'string' && user.loginId ? user.loginId : loginId,
          userName: typeof user.name === 'string' ? user.name : '',
          role: typeof user.role === 'string' ? user.role : '',
        };
        this.opts.sessions.save(session);
        return `로그인 성공: ${session.userName} (${session.role}) @ ${baseUrl}\n세션 저장 위치: ${this.opts.sessions.location}\n`;
      }
      default:
        throw new CliFailure(`지원하지 않는 명령입니다: ${command}`, 2);
    }
  }

  /** 로그아웃(세션 지우기) — 설정 화면 등에서 쓴다 */
  logout(): void {
    this.opts.sessions.clear();
  }
}

/** java Double.parseDouble 이 읽는 흔한 모양(10진수·지수·NaN·Infinity, 앞뒤 공백) */
const JAVA_DOUBLE_RE = /^\s*[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|NaN|Infinity)\s*$/;

/** java Double.toString 표기(흔한 범위): 정수면 '.0' 을 붙인다 — 2 → '2.0', 0 → '0.0' */
function javaDouble(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (Object.is(v, -0)) return '-0.0';
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return `${v}.0`;
  return String(v);
}

function intOption(p: ParsedArgs, name: string, fallback: number): number {
  const v = p.options.get(name);
  if (v === undefined) return fallback;
  if (!/^[1-9][0-9]{0,6}$/.test(v)) throw new CliFailure(`${name} 는 양의 정수여야 합니다: ${v}`, 2);
  return Number(v);
}

/**
 * 응답 본문을 최대 maxBytes 까지만 읽는다 — Content-Length 가 넘으면 읽지 않고, 길이를 모르면(chunked) 흘려 읽으며 세다가
 * 넘는 순간 끊는다. 다 읽은 뒤에 재면 main 프로세스가 이미 그만큼 메모리를 쓴 뒤다
 */
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const tooBig = (): CliFailure => new CliFailure(`응답이 너무 큽니다(${Math.round(maxBytes / (1024 * 1024))}MB 넘음)`);
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** 2xx 본문 → JSON(빈 본문은 {}). JSON 이 아니면 '응답 파싱 실패' */
function jsonOf(body: Buffer): unknown {
  const text = body.toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliFailure(`응답 파싱 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function jsonObject(body: Buffer): Record<string, unknown> {
  const v = jsonOf(body);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
