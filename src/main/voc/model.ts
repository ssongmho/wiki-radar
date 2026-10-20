// VOC 데이터 모양 바꾸기: voc-cli 출력 → 앱 타입, 보드(칸·정렬·합계), 내 담당 VOC → 할 일. electron 을 import 하지 않는다.
// 계약: docs/stage2.6-contract.md §2·§5
//
// - TicketDto 필드 이름은 voc-cli 가 백엔드 응답을 그대로 내는 것(internalAssigneeId/Name, customerDueDate, ictDueDate,
//   slaStatus, slaResolutionTarget, replyCount, lastReplyAt …)이다. 시각은 UTC ISO(`Z`) 그대로 두고, 날짜만 KST 로 바꾼다.
// - 요청 내용(description)은 TipTap HTML 이다. 화면에 HTML 을 그리지 않도록 여기서 글자로 편다.
// - 진행 현황은 저장하지 않는다(메모리에만). 이 모듈은 파일을 읽지도 쓰지도 않는다.
import type {
  Holiday,
  Task,
  TaskStatus,
  VocAttachment,
  VocBoard,
  VocEmailLog,
  VocWorkLog,
  VocCode,
  VocCustomer,
  VocLane,
  VocLaneSummary,
  VocMember,
  VocReply,
  VocSettings,
  VocSlaStatus,
  VocTicket,
  VocTicketDetail,
} from '../../shared/types';
import { BusinessCalendar, dayToYmd, ymdToDay } from '../wiki/calendar';
import { compareCodeUnits, stripBom } from '../wiki/fsutil';

/** 요청 내용을 글자로 편 뒤 남기는 최대 글자 수 */
export const VOC_TEXT_MAX = 4_000;

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

/** 진행 중이 아닌 VOC 상태(목록은 --hide-completed 로 받지만 쓰기 결과로 바뀔 수 있다) */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed', 'withdrawn']);
const SLA_STATUSES: ReadonlySet<string> = new Set<VocSlaStatus>(['normal', 'warning', 'exceeded']);

// ---- 작은 도우미 -------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** 이름 정렬(한국어) */
const koCollator = new Intl.Collator('ko');

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 비어 있지 않은 문자열(공백뿐이면 없음) */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 유한한 숫자(숫자 문자열도 받는다) */
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

/** 양의 정수 id */
function idOf(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function nonNegInt(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

const calendars = new WeakMap<readonly Holiday[], BusinessCalendar>();

/** 같은 공휴일 표면 달력을 다시 만들지 않는다 */
function calendarOf(holidays: readonly Holiday[]): BusinessCalendar {
  const list = Array.isArray(holidays) ? holidays : [];
  let cal = calendars.get(list);
  if (!cal) {
    cal = new BusinessCalendar(list);
    calendars.set(list, cal);
  }
  return cal;
}

/** from(포함하지 않음)부터 to 까지 영업일. 날짜가 틀리거나 from >= to 면 0 */
function businessDaysBetween(cal: BusinessCalendar, from: string, to: string): number {
  if (ymdToDay(from) === null || ymdToDay(to) === null || from >= to) return 0;
  return cal.businessDaysAfter(from, to);
}

/** from 부터 to 까지 달력일(음수면 0) */
function calendarDaysBetween(from: string, to: string): number {
  const a = ymdToDay(from);
  const b = ymdToDay(to);
  return a === null || b === null ? 0 : Math.max(0, b - a);
}

/** 'wiki/entities/한결케미칼.md' → '한결케미칼' */
function pageNameOf(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.md$/i, '');
}

/** P1 → 1, P2 → 2, P3 → 3, 그 밖은 없음 */
function priorityNumber(priority: string | undefined): number | undefined {
  const m = /^P([123])$/i.exec(priority?.trim() ?? '');
  return m ? Number(m[1]) : undefined;
}

// ---- HTML → 글자 -------------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(0xa0),
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  middot: '·',
  bull: '•',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  micro: 'µ',
  para: '¶',
  sect: '§',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  le: '≤',
  ge: '≥',
  ne: '≠',
};

/** HTML 엔티티를 한 번만 푼다(`&amp;lt;` → `&lt;`). 모르는 이름·잘못된 번호는 그대로 둔다 */
function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** 줄바꿈 태그 — 하나마다 줄바꿈 하나 */
const BR_TAG_RE = /<br\b[^<>]*>/gi;
/**
 * 줄을 나누는 블록 태그(명세의 p·li·h1-6·div·tr + 목록·표·인용 등 블록 요소). 여는·닫는 태그가 이어지면
 * (`</p><p>`, `</li><li>`) 줄바꿈 하나로 본다 — 목록 항목 사이에 빈 줄이 생기지 않게.
 */
const BLOCK_TAG_RE = /<\/?(?:p|li|h[1-6]|div|tr|ul|ol|dl|dt|dd|blockquote|pre|table|thead|tbody|tfoot|hr|section|article|header|footer)\b[^<>]*>/gi;
/** 블록 경계 표시(태그를 지우는 동안만 쓰고 줄바꿈 하나로 바꾼다) */
const BLOCK_MARK = '\u000b';
const BLOCK_RUN_RE = /[^\S\n]*\u000b[^\S\n]*/g;
/** 표 칸은 공백으로(칸 글자가 붙지 않게) */
const CELL_TAG_RE = /<\/?(?:td|th)\b[^<>]*>/gi;
/** 그 밖의 태그(글자처럼 쓰인 `a < b` 는 태그가 아니다) */
const OTHER_TAG_RE = /<\/?[a-zA-Z][^<>]*>|<![^<>]*>/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;

/**
 * 요청 내용 HTML → 글자(명세 §2-1). 블록 태그는 줄바꿈(이어진 블록 경계는 하나로), `<br>` 은 하나마다 줄바꿈,
 * 나머지 태그는 지우고, 엔티티를 풀고, 줄마다 공백을 정리하고 빈 줄은 한 줄까지만 남긴다.
 * max(기본 4,000)자를 넘으면 자르고 '…'를 붙인다(결과는 max 자 이하).
 * 태그가 하나도 없으면 평문으로 보고 원래 줄바꿈을 살린다(HTML 이면 원문 줄바꿈은 공백이다).
 */
export function htmlToText(html: string | null | undefined, max: number = VOC_TEXT_MAX): string {
  if (typeof html !== 'string' || html === '') return '';
  let s = html.replace(/\r\n?/g, '\n');
  if (/<\/?[a-zA-Z][^<>]*>|<!--/.test(s)) {
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<(script|style)\b[^<>]*>[\s\S]*?<\/\1\s*>/gi, '');
    s = s.replace(/[\n\u000b]/g, ' ');
    s = s.replace(CELL_TAG_RE, ' ');
    s = s.replace(BR_TAG_RE, '\n');
    s = s.replace(BLOCK_TAG_RE, BLOCK_MARK);
    s = s.replace(OTHER_TAG_RE, '');
    s = s.replace(BLOCK_RUN_RE, '\n');
  }
  s = decodeEntities(s).replace(CONTROL_RE, '');
  s = s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : VOC_TEXT_MAX;
  if (s.length > limit) {
    let cut = Math.max(0, limit - 1);
    // 서러게이트 쌍 가운데서 자르지 않는다
    const code = s.charCodeAt(cut - 1);
    if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut--;
    s = `${s.slice(0, cut).trimEnd()}…`;
  }
  return s;
}

// ---- 시각 → KST 날짜 --------------------------------------------------------------------------

/**
 * UTC 시각(ISO) → KST(+9시간) 날짜 YYYY-MM-DD. 시간대 표시가 없는 시각은 UTC 로 본다(서버는 UTC 로 저장한다).
 * 날짜만 있으면(YYYY-MM-DD) 그대로. 읽지 못하면 undefined.
 */
export function utcToKstDate(iso: string | null | undefined): string | undefined {
  if (typeof iso !== 'string') return undefined;
  let s = iso.trim();
  if (s === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ymdToDay(s) === null ? undefined : s;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return undefined;
  // Java Instant 는 소수초를 9자리까지 낸다 — 3자리로 자른다
  s = s.replace(/(\.\d{3})\d+/, '$1');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s = `${s}Z`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return dayToYmd(Math.floor((t + KST_OFFSET_MS) / DAY_MS));
}

// ---- 페이지 매핑 --------------------------------------------------------------------------------

/**
 * 고객사·시스템 이름 → 위키 문서 경로를 찾는 표. custPage·systemPage 는 link_raw.py 의 CUST_PAGE·SYSTEM_PAGE
 * (mappings.ts), pageIndex 는 페이지명(파일 이름에서 .md 뺀 것) → 볼트 기준 경로(wiki/ 아래 전부).
 */
export interface VocPageMaps {
  custPage: ReadonlyMap<string, string>;
  systemPage: ReadonlyMap<string, string>;
  pageIndex: ReadonlyMap<string, string>;
}

/** 페이지 색인에서 같은 이름이 여러 곳에 있을 때 앞선다: entities → topics → 그 밖 */
function pageRank(rel: string): number {
  if (rel.startsWith('wiki/entities/')) return 0;
  if (rel.startsWith('wiki/topics/')) return 1;
  return 2;
}

/**
 * 볼트의 마크다운 목록(볼트 기준 '/' 경로, walkMarkdown 결과) → pageIndex. wiki/ 아래 .md 만 본다.
 * 같은 페이지명이 여러 곳에 있으면 entities → topics → 그 밖, 같은 곳끼리는 경로 순서가 앞선 것.
 */
export function pageIndexOf(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();
  const sorted = files
    .filter((f) => typeof f === 'string' && f.startsWith('wiki/') && /\.md$/i.test(f))
    .slice()
    .sort((a, b) => pageRank(a) - pageRank(b) || compareCodeUnits(a, b));
  for (const f of sorted) {
    const name = pageNameOf(f);
    if (name !== '' && !index.has(name)) index.set(name, f);
  }
  return index;
}

/** 이름 → (매핑 표로 바꾼) 페이지명 → 위키 문서 경로. 없으면 undefined */
function pageFor(name: string | undefined, table: ReadonlyMap<string, string>, index: ReadonlyMap<string, string>): string | undefined {
  if (!name) return undefined;
  for (const key of [name, name.trim()]) {
    const found = index.get(table.get(key) ?? key);
    if (found) return found;
  }
  return undefined;
}

// ---- TicketDto → VocTicket --------------------------------------------------------------------

/**
 * voc-cli TicketDto(JSON 객체) → VocTicket(명세 §2-1). id 가 없거나 틀리면 null.
 * 날짜(customerDueDate·ictDueDate)는 KST 날짜, 경과일은 접수일(KST)부터 today 까지(달력일·영업일).
 */
export function toVocTicket(dto: unknown, today: string, holidays: readonly Holiday[], maps?: VocPageMaps): VocTicket | null {
  if (!isObj(dto)) return null;
  const id = idOf(dto.id);
  if (id === undefined) return null;

  const createdAt = str(dto.createdAt) ?? '';
  const createdDate = utcToKstDate(createdAt);
  const ticket: VocTicket = {
    id,
    number: str(dto.ticketNumber)?.trim() ?? `#${id}`,
    title: typeof dto.title === 'string' ? dto.title : '',
    status: str(dto.status)?.trim() ?? '',
    createdAt,
    text: htmlToText(typeof dto.description === 'string' ? dto.description : ''),
    ageDays: createdDate ? calendarDaysBetween(createdDate, today) : 0,
    ageBusinessDays: createdDate ? businessDaysBetween(calendarOf(holidays), createdDate, today) : 0,
  };

  const priority = str(dto.priority)?.trim();
  if (priority) ticket.priority = priority;
  const customerId = idOf(dto.customerId);
  if (customerId !== undefined) ticket.customerId = customerId;
  const customer = str(dto.customer);
  if (customer) ticket.customer = customer;
  const system = str(dto.system)?.trim();
  if (system) ticket.system = system;
  const systemName = str(dto.systemName);
  if (systemName) ticket.systemName = systemName;
  const assigneeId = idOf(dto.internalAssigneeId);
  if (assigneeId !== undefined) {
    ticket.assigneeId = assigneeId;
    const assigneeName = str(dto.internalAssigneeName);
    if (assigneeName) ticket.assigneeName = assigneeName;
  }
  const updatedAt = str(dto.updatedAt);
  if (updatedAt) ticket.updatedAt = updatedAt;
  const lastReplyAt = str(dto.lastReplyAt);
  if (lastReplyAt) ticket.lastReplyAt = lastReplyAt;
  const customerDue = utcToKstDate(str(dto.customerDueDate));
  if (customerDue) ticket.customerDue = customerDue;
  const ictDue = utcToKstDate(str(dto.ictDueDate));
  if (ictDue) ticket.ictDue = ictDue;
  if (typeof dto.slaStatus === 'string' && SLA_STATUSES.has(dto.slaStatus)) ticket.slaStatus = dto.slaStatus as VocSlaStatus;
  const target = nonNegInt(dto.slaResolutionTarget);
  if (target !== undefined) ticket.slaResolutionTarget = target;
  const replyCount = nonNegInt(dto.replyCount);
  if (replyCount !== undefined) ticket.replyCount = replyCount;
  const requesterName = str(dto.requesterName);
  if (requesterName) ticket.requesterName = requesterName;
  const requestType = str(dto.requestType);
  if (requestType) ticket.requestType = requestType;

  if (maps) {
    const customerPage = pageFor(ticket.customer, maps.custPage, maps.pageIndex);
    if (customerPage) ticket.customerPage = customerPage;
    const systemPage = pageFor(ticket.systemName, maps.systemPage, maps.pageIndex);
    if (systemPage) ticket.systemPage = systemPage;
  }
  return ticket;
}

// ---- voc-cli 출력 읽기 ------------------------------------------------------------------------

/**
 * `--json` 표준출력 → 값. 보통 통째로 JSON 이지만, 앞뒤에 경고 줄(JVM·로그)이 섞이면 줄 맨 앞이 `{`·`[` 인 곳부터
 * 끝(또는 마지막 `}`·`]` 줄)까지를 본다. 읽지 못하면 한국어 Error.
 */
function parseJsonOutput(stdout: string): unknown {
  const text = stripBom(typeof stdout === 'string' ? stdout : '').trim();
  if (text === '') throw new Error('VOC 응답이 비어 있습니다');
  try {
    return JSON.parse(text);
  } catch {
    // 아래에서 경고 줄을 건너뛰고 다시 본다
  }
  const lines = text.split(/\r\n|\n|\r/);
  let lastClose = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    const t = lines[j].trimEnd();
    if (t.endsWith('}') || t.endsWith(']')) {
      lastClose = j;
      break;
    }
  }
  let tried = 0;
  for (let i = 0; i < lines.length && tried < 3; i++) {
    const t = lines[i].trimStart();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    tried++;
    for (const end of [lines.length - 1, lastClose]) {
      if (end < i) continue;
      try {
        return JSON.parse(lines.slice(i, end + 1).join('\n'));
      } catch {
        // 다음 후보
      }
    }
  }
  throw new Error('VOC 응답을 JSON 으로 읽지 못했습니다');
}

/** 배열이거나 {data: 배열} 이면 그 배열 */
function arrayOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v.data)) return v.data;
  return null;
}

/**
 * `ticket list --json` → {data, total, page, totalPages}(명세 §2-1). 응답은 `{data, total, page, pageSize, totalPages}`
 * (hasNext 없음 — page < totalPages 면 다음 쪽이 있다). 배열만 와도 한 쪽으로 받는다. 형식이 틀리면 한국어 Error.
 */
export function parseTicketList(stdout: string): { data: unknown[]; total: number; page: number; totalPages: number } {
  const v = parseJsonOutput(stdout);
  if (Array.isArray(v)) return { data: v, total: v.length, page: 1, totalPages: 1 };
  if (isObj(v) && Array.isArray(v.data)) {
    const data = v.data as unknown[];
    const page = idOf(v.page) ?? 1;
    return {
      data,
      total: nonNegInt(v.total) ?? data.length,
      page,
      totalPages: nonNegInt(v.totalPages) ?? page,
    };
  }
  throw new Error('VOC 티켓 목록 형식이 맞지 않습니다(data 배열이 없음)');
}

/** `user list --role staff,admin --json` → VocMember[](id 없는 항목·겹친 id 는 뺀다). 형식이 틀리면 한국어 Error */
export function parseUsers(stdout: string): VocMember[] {
  const arr = arrayOf(parseJsonOutput(stdout));
  if (!arr) throw new Error('VOC 사용자 목록 형식이 맞지 않습니다');
  const out: VocMember[] = [];
  const seen = new Set<number>();
  for (const raw of arr) {
    if (!isObj(raw)) continue;
    const id = idOf(raw.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const email = str(raw.email)?.trim();
    const member: VocMember = { id, name: (str(raw.name) ?? email ?? `#${id}`).trim() };
    if (email) member.email = email;
    const department = (str(raw.department) ?? str(raw.departmentName))?.trim();
    if (department) member.department = department;
    out.push(member);
  }
  return out;
}

/** sortOrder 가 있으면 그 순서(없는 것은 뒤), 같으면 받은 순서 */
function bySortOrder<T>(items: { item: T; order?: number; i: number }[]): T[] {
  return items
    .sort((a, b) => {
      const oa = a.order ?? Number.POSITIVE_INFINITY;
      const ob = b.order ?? Number.POSITIVE_INFINITY;
      return oa !== ob ? (oa < ob ? -1 : 1) : a.i - b.i;
    })
    .map((x) => x.item);
}

/** `code list <그룹> --json` → VocCode[](비활성 코드·겹친 코드는 뺀다). 형식이 틀리면 한국어 Error */
export function parseCodes(stdout: string): VocCode[] {
  const arr = arrayOf(parseJsonOutput(stdout));
  if (!arr) throw new Error('VOC 코드 목록 형식이 맞지 않습니다');
  const rows: { item: VocCode; order?: number; i: number }[] = [];
  const seen = new Set<string>();
  arr.forEach((raw, i) => {
    if (!isObj(raw) || raw.enabled === false) return;
    const code = str(raw.code)?.trim();
    if (!code || seen.has(code)) return;
    seen.add(code);
    rows.push({ item: { code, name: (str(raw.name) ?? code).trim() }, order: num(raw.sortOrder), i });
  });
  return bySortOrder(rows);
}

/** `customer list --json` → VocCustomer[](비활성·id 없는 항목은 뺀다, 이름순). 형식이 틀리면 한국어 Error */
export function parseCustomers(stdout: string): VocCustomer[] {
  const arr = arrayOf(parseJsonOutput(stdout));
  if (!arr) throw new Error('VOC 고객사 목록 형식이 맞지 않습니다');
  const out: VocCustomer[] = [];
  const seen = new Set<number>();
  for (const raw of arr) {
    if (!isObj(raw) || raw.enabled === false) continue;
    const id = idOf(raw.id);
    const name = (str(raw.customerName) ?? str(raw.name))?.trim();
    if (id === undefined || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out.sort((a, b) => koCollator.compare(a.name, b.name) || a.id - b.id);
}

/** whoami 에서 알아보는 줄 이름 → 필드 */
const WHOAMI_KEYS: Readonly<Record<string, 'email' | 'name' | 'department' | 'backend' | 'loginId'>> = {
  이메일: 'email',
  이름: 'name',
  부서: 'department',
  백엔드: 'backend',
  '로그인 ID': 'loginId',
};

/**
 * `whoami` 텍스트(--json 이 없다) → 필드. 줄 모양은 `이메일      : a@b.c`(WhoamiCommand — 이름 뒤 공백으로 줄을 맞춘다).
 * 값이 `-`(서버가 주지 않음)이면 없음. 알아보는 줄: 로그인 ID·이름·이메일·부서·백엔드.
 * voc-cli 는 서버(/auth/me)의 값(로그인 ID·이름·이메일·권한·부서·고객사)을 거르지 않고 먼저 찍고, 로컬 세션의 백엔드 주소를
 * 맨 끝에 찍는다. 서버 값에 줄바꿈이 들어 있으면 가짜 줄이 생길 수 있으므로: 백엔드는 **마지막** 줄(로컬 값)을 쓰고,
 * 그 밖의 필드는 같은 줄이 두 번 이상 나오면 이상한 출력으로 보고 버린다(나 찾기는 SMTP 주소·설정으로 넘어간다).
 */
export function parseWhoami(stdout: string): { email?: string; name?: string; department?: string; backend?: string; loginId?: string } {
  const out: { email?: string; name?: string; department?: string; backend?: string; loginId?: string } = {};
  const seen = new Map<string, string[]>();
  const text = stripBom(typeof stdout === 'string' ? stdout : '');
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const m = /^\s*([^:：]+?)\s*[:：]\s?(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1].replace(/\s+/g, ' ').trim();
    const field = Object.hasOwn(WHOAMI_KEYS, key) ? WHOAMI_KEYS[key] : undefined;
    if (!field) continue;
    const list = seen.get(field) ?? [];
    list.push(m[2].trim());
    seen.set(field, list);
  }
  for (const [field, values] of seen) {
    if (field !== 'backend' && values.length !== 1) continue;
    const value = values[values.length - 1];
    if (value === '' || value === '-') continue;
    out[field as keyof typeof out] = value;
  }
  return out;
}

/**
 * whoami 의 백엔드 주소(`https://<호스트>:<포트>`) → VOC 웹 주소(같은 호스트의 https 기본 포트 `https://<호스트>`).
 * http·https 주소가 아니면 undefined.
 */
export function webBaseOf(backend: string | undefined): string | undefined {
  if (typeof backend !== 'string' || backend.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(backend.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') return undefined;
  return `https://${url.hostname}`;
}

/** `ticket get <id> --replies --json` → 티켓 + 답변(작성 순서 그대로). 형식이 틀리면 null */
export function parseTicketDetail(
  stdout: string,
  today: string,
  holidays: readonly Holiday[],
  maps?: VocPageMaps,
): VocTicketDetail | null {
  let v: unknown;
  try {
    v = parseJsonOutput(stdout);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const ticket = toVocTicket(v, today, holidays, maps);
  if (!ticket) return null;
  const replies: VocReply[] = [];
  const attachments: VocAttachment[] = [];
  const seenFiles = new Set<number>();
  const addAttachments = (list: unknown, reply?: VocReply): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const a = toAttachment(raw);
      if (!a || seenFiles.has(a.id)) continue;
      seenFiles.add(a.id);
      if (reply) {
        a.replyId = reply.id;
        if (reply.authorName) a.replyAuthor = reply.authorName;
      }
      attachments.push(a);
    }
  };
  addAttachments(v.attachments);
  if (Array.isArray(v.replies)) {
    for (const raw of v.replies) {
      if (!isObj(raw)) continue;
      const id = idOf(raw.id);
      if (id === undefined) continue;
      const reply: VocReply = { id, createdAt: str(raw.createdAt) ?? '', text: htmlToText(typeof raw.content === 'string' ? raw.content : '') };
      const authorName = str(raw.authorName);
      if (authorName) reply.authorName = authorName;
      const authorType = str(raw.authorType)?.trim();
      if (authorType) reply.authorType = authorType;
      replies.push(reply);
      addAttachments(raw.attachments, reply);
    }
  }
  const detail: VocTicketDetail = { ticket, replies, attachments };
  const emails = customerEmailsOf(v.customerEmails, v.customerEmail);
  if (emails.length > 0) detail.customerEmails = emails;
  return detail;
}

/** 첨부 이름 한도(화면·기록에 넣는 글자) */
const FILE_NAME_MAX = 255;

/** AttachmentDto → VocAttachment. id·이름이 없으면 null. 이름은 한 줄로 펴고 255자에서 자른다(서버 값 — 글자로만 쓴다) */
function toAttachment(raw: unknown): VocAttachment | null {
  if (!isObj(raw)) return null;
  const id = idOf(raw.id);
  // 제어 문자·방향 바꾸기 글자('invoice<RLO>gpj.exe' 가 .jpg 처럼 보이는 것)는 화면에 넣지 않는다 — 처리 방식은 실제 확장자로 정한다
  const name = str(raw.fileName)
    ?.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .trim();
  if (id === undefined || !name) return null;
  const a: VocAttachment = { id, fileName: name.length > FILE_NAME_MAX ? name.slice(0, FILE_NAME_MAX) : name };
  const size = nonNegInt(raw.fileSize);
  if (size !== undefined) a.fileSize = size;
  const at = str(raw.uploadedAt);
  if (at) a.uploadedAt = at;
  return a;
}

/** 고객 메일 기본 받는 사람: customerEmails(배열 또는 쉼표·세미콜론 글) → 없으면 customerEmail. 겹친 주소(대소문자 무시)는 한 번 */
function customerEmailsOf(list: unknown, single: unknown): string[] {
  const parts: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return;
    for (const p of v.split(/[,;\s]+/)) if (p.trim() !== '') parts.push(p.trim());
  };
  if (Array.isArray(list)) list.forEach(push);
  else push(list);
  if (parts.length === 0) push(single);
  const seen = new Set<string>();
  return parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k) || p.length > 254) return false;
    seen.add(k);
    return true;
  });
}

/**
 * `worklog list <ticketId> --json` → VocWorkLog[](서버 순서 — 최근 작업일 순). hours 가 없으면 minutes/60. id·날짜가 없는 항목은 뺀다.
 * 형식이 틀리면 한국어 Error
 */
export function parseWorkLogs(stdout: string): VocWorkLog[] {
  const arr = arrayOf(parseJsonOutput(stdout));
  if (!arr) throw new Error('VOC 작업시간 목록 형식이 맞지 않습니다');
  const out: VocWorkLog[] = [];
  for (const raw of arr) {
    const w = toWorkLog(raw);
    if (w) out.push(w);
  }
  return out;
}

/** WorkLogDto 한 개 → VocWorkLog(틀리면 null) */
export function toWorkLog(raw: unknown): VocWorkLog | null {
  if (!isObj(raw)) return null;
  const id = idOf(raw.id);
  const workDate = str(raw.workDate)?.trim().slice(0, 10);
  if (id === undefined || !workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) return null;
  let hours = num(raw.hours);
  if (hours === undefined) {
    const minutes = num(raw.minutes);
    if (minutes !== undefined) hours = minutes / 60;
  }
  if (hours === undefined || hours < 0) return null;
  const w: VocWorkLog = { id, workDate, hours: Math.round(hours * 100) / 100 };
  const userId = idOf(raw.userId) ?? idOf(raw.createdBy);
  if (userId !== undefined) w.userId = userId;
  const userName = str(raw.userName);
  if (userName) w.userName = userName.trim();
  const note = str(raw.note);
  if (note) w.note = note;
  const createdAt = str(raw.createdAt);
  if (createdAt) w.createdAt = createdAt;
  return w;
}

/** `ticket email-logs <ticketId> --json` → VocEmailLog[](서버 순서 — 최근 순). 형식이 틀리면 한국어 Error */
export function parseEmailLogs(stdout: string): VocEmailLog[] {
  const arr = arrayOf(parseJsonOutput(stdout));
  if (!arr) throw new Error('VOC 메일 발송 기록 형식이 맞지 않습니다');
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
  const out: VocEmailLog[] = [];
  for (const raw of arr) {
    if (!isObj(raw)) continue;
    const id = idOf(raw.id);
    if (id === undefined) continue;
    const log: VocEmailLog = { id, to: strings(raw.toAddresses), cc: strings(raw.ccAddresses) };
    for (const key of ['sentByName', 'subject', 'status', 'emailType', 'sentAt'] as const) {
      const value = str(raw[key]);
      if (value) log[key] = value.trim();
    }
    out.push(log);
  }
  return out;
}

// ---- 나·팀 ---------------------------------------------------------------------------------------

/** 비교용 이메일(꺾쇠 안 주소, 소문자). 없으면 undefined */
function normEmail(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const angle = /<([^<>]+)>/.exec(v);
  const e = (angle ? angle[1] : v).trim().toLowerCase();
  return e.includes('@') ? e : undefined;
}

/**
 * 나 찾기(명세 §2-2): 설정 myId → whoami 이메일 → 보조 이메일(2.5단계 SMTP 계정) 순으로 user list 에서 찾는다
 * (이메일은 대소문자 무시). 못 찾으면 undefined — 설정에서 고르게 한다.
 */
export function findMe(users: VocMember[], settings: VocSettings, whoamiEmail?: string, fallbackEmail?: string): VocMember | undefined {
  const list = Array.isArray(users) ? users : [];
  if (settings?.myId !== undefined) {
    const byId = list.find((u) => u.id === settings.myId);
    if (byId) return byId;
  }
  for (const email of [whoamiEmail, fallbackEmail]) {
    const e = normEmail(email);
    if (!e) continue;
    // 같은 이메일 계정이 여럿이면(운영 VOC 에 관리자용·업무용 계정이 같은 주소로 있다 — 2026-09-29 실제) 부서가 있는
    // 계정을 고른다. 부서 없는 쪽을 고르면 '나와 같은 부서' 팀을 정하지 못한다.
    const matches = list.filter((u) => normEmail(u.email) === e);
    const found = matches.find((u) => typeof u.department === 'string' && u.department.trim() !== '') ?? matches[0];
    if (found) return found;
  }
  return undefined;
}

/**
 * 팀(명세 §2-2): 나를 맨 앞에 두고, 설정 memberIds 가 있으면 그 순서(목록에 없는 id 는 뺀다), 없으면 나와 같은
 * 부서 사람들(이름순). 나를 모르고 설정도 비었으면 빈 목록.
 */
export function resolveTeam(users: VocMember[], settings: VocSettings, me?: VocMember): VocMember[] {
  const list = Array.isArray(users) ? users : [];
  const byId = new Map(list.map((u) => [u.id, u] as const));
  const team: VocMember[] = [];
  const add = (m: VocMember | undefined): void => {
    if (m && !team.some((x) => x.id === m.id)) team.push(m);
  };
  if (me) add(byId.get(me.id) ?? me);
  const memberIds = Array.isArray(settings?.memberIds) ? settings.memberIds : [];
  if (memberIds.length > 0) {
    for (const id of memberIds) add(byId.get(id));
    return team;
  }
  const dept = me?.department?.trim();
  if (!me || !dept) return team;
  list
    .filter((u) => u.id !== me.id && u.department?.trim() === dept)
    .sort((a, b) => koCollator.compare(a.name, b.name) || a.id - b.id)
    .forEach(add);
  return team;
}

/** 팀 시스템(명세 §2-2): 설정 systems 가 있으면 그것, 없으면 팀원이 담당인 진행 중 티켓에 나오는 시스템 코드 전부 */
export function teamSystems(tickets: VocTicket[], team: VocMember[], settings: VocSettings): Set<string> {
  if (Array.isArray(settings?.systems) && settings.systems.length > 0) return new Set(settings.systems);
  const ids = new Set(team.map((m) => m.id));
  const out = new Set<string>();
  for (const t of tickets) {
    if (t.assigneeId !== undefined && ids.has(t.assigneeId) && t.system) out.add(t.system);
  }
  return out;
}

/**
 * 시스템 선택지(설정의 팀 시스템·V3b 등록): 받은 진행 중 티켓 전부의 (system, systemName) + 따로 준 코드(설정에 저장한 팀 시스템).
 * 운영 VOC 에서 `code list SYSTEM` 은 빈 배열이다 — 백엔드 V36 이 시스템을 voc_sys_programs 로 옮기고 V39 가 SYSTEM 코드 그룹을
 * 껐다(티켓의 system 값은 voc_sys_programs.code). voc-cli 에는 sys-programs 를 읽는 명령이 없어서 티켓에서 모은다.
 * 이름은 처음 나온 비어 있지 않은 systemName(없으면 코드). customerIds 는 그 시스템이 나온 고객사(작성 칸이 그 고객사 것을 앞에 둔다).
 * 이름순(같으면 코드순).
 */
export function systemsOf(tickets: readonly VocTicket[], extraCodes: readonly string[] = []): VocCode[] {
  const byCode = new Map<string, { code: string; name?: string; customers: Set<number> }>();
  const entry = (code: string) => {
    let e = byCode.get(code);
    if (!e) {
      e = { code, customers: new Set() };
      byCode.set(code, e);
    }
    return e;
  };
  for (const t of Array.isArray(tickets) ? tickets : []) {
    const code = t.system?.trim();
    if (!code) continue;
    const e = entry(code);
    if (!e.name && t.systemName?.trim()) e.name = t.systemName.trim();
    if (t.customerId !== undefined) e.customers.add(t.customerId);
  }
  for (const raw of Array.isArray(extraCodes) ? extraCodes : []) {
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (code) entry(code);
  }
  return [...byCode.values()]
    .map((e) => {
      const c: VocCode = { code: e.code, name: e.name ?? e.code };
      if (e.customers.size > 0) c.customerIds = [...e.customers].sort((a, b) => a - b);
      return c;
    })
    .sort((a, b) => koCollator.compare(a.name, b.name) || compareCodeUnits(a.code, b.code));
}

// ---- 보드 ---------------------------------------------------------------------------------------

function slaRank(t: VocTicket): number {
  return t.slaStatus === 'exceeded' ? 0 : t.slaStatus === 'warning' ? 1 : 2;
}

function createdMs(t: VocTicket): number {
  const ms = Date.parse(t.createdAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * 칸 안 정렬(명세 §2-3): SLA exceeded → warning → 그 밖, 우선순위 P1 → P2 → P3·없음, 접수 오래된 순, id 순.
 * 새 배열을 돌려준다.
 */
export function sortTickets(tickets: VocTicket[]): VocTicket[] {
  return tickets.slice().sort((a, b) => {
    const sa = slaRank(a);
    const sb = slaRank(b);
    if (sa !== sb) return sa - sb;
    const pa = priorityNumber(a.priority) ?? 3;
    const pb = priorityNumber(b.priority) ?? 3;
    if (pa !== pb) return pa - pb;
    const ca = createdMs(a);
    const cb = createdMs(b);
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id - b.id;
  });
}

function summarize(tickets: readonly VocTicket[]): VocLaneSummary {
  const summary: VocLaneSummary = { total: tickets.length, slaExceeded: 0, slaWarning: 0, p1: 0 };
  let oldest: number | undefined;
  for (const t of tickets) {
    if (t.slaStatus === 'exceeded') summary.slaExceeded++;
    else if (t.slaStatus === 'warning') summary.slaWarning++;
    if (priorityNumber(t.priority) === 1) summary.p1++;
    if (oldest === undefined || t.ageDays > oldest) oldest = t.ageDays;
  }
  if (oldest !== undefined) summary.oldestDays = oldest;
  return summary;
}

/**
 * 보드 칸과 합계(명세 §2-3). 칸: ① 미배정 = 담당자 없음 && (showAllUnassigned || 시스템 ∈ 팀 시스템)
 * ② 사람마다 한 칸 — 나(label '나')가 맨 앞, 그다음 team 순서. 팀 밖 사람이 담당인 티켓은 어느 칸에도 없다.
 * 합계는 보이는 칸 전부(팀 전체·미배정·SLA 초과·임박).
 */
export function buildBoard(args: {
  tickets: VocTicket[];
  team: VocMember[];
  me?: VocMember;
  settings: VocSettings;
}): { lanes: VocLane[]; totals: VocBoard['totals'] } {
  const tickets = Array.isArray(args.tickets) ? args.tickets : [];
  const me = args.me;
  const members: VocMember[] = [];
  if (me) members.push(args.team.find((m) => m.id === me.id) ?? me);
  for (const m of args.team) if (!members.some((x) => x.id === m.id)) members.push(m);

  const systems = teamSystems(tickets, members, args.settings);
  const showAll = args.settings?.showAllUnassigned === true;
  const unassigned = tickets.filter(
    (t) => t.assigneeId === undefined && (showAll || (t.system !== undefined && systems.has(t.system))),
  );

  const lane = (key: string, label: string, list: VocTicket[]): VocLane => {
    const sorted = sortTickets(list);
    return { key, label, tickets: sorted, summary: summarize(sorted) };
  };
  const lanes: VocLane[] = [lane('unassigned', '미배정', unassigned)];
  for (const m of members) {
    const isMe = me !== undefined && m.id === me.id;
    const l = lane(`user:${m.id}`, isMe ? '나' : m.name, tickets.filter((t) => t.assigneeId === m.id));
    l.member = m;
    if (isMe) l.me = true;
    lanes.push(l);
  }

  const totals: VocBoard['totals'] = { team: 0, unassigned: lanes[0].summary.total, slaExceeded: 0, slaWarning: 0 };
  for (const l of lanes) {
    totals.team += l.summary.total;
    totals.slaExceeded += l.summary.slaExceeded;
    totals.slaWarning += l.summary.slaWarning;
  }
  return { lanes, totals };
}

// ---- 내 담당 VOC → 할 일 ------------------------------------------------------------------------

/**
 * 내가 담당인 진행 중 티켓 → Task(명세 §5). id 'v:'+티켓 id, source 'voc', 상태 in_progress·pending → wip 그 밖 → open,
 * due = ICT 예상일 ?? 고객 희망일, opened = 접수일(KST), openDays = 접수일부터 today 까지 영업일,
 * company = 고객사 위키 페이지명 ?? 고객사, pri = P1·P2·P3 → 1·2·3. bucket 은 'other' 로 두고 합치는 쪽이 다시 매긴다.
 * 순서는 sortTickets 와 같다.
 */
export function vocTasksOf(tickets: VocTicket[], me: VocMember | undefined, today: string, holidays: readonly Holiday[]): Task[] {
  if (!me || !Array.isArray(tickets)) return [];
  const cal = calendarOf(holidays);
  const mine = sortTickets(tickets.filter((t) => t.assigneeId === me.id && !CLOSED_STATUSES.has(t.status)));
  return mine.map((t) => {
    const status: TaskStatus = t.status === 'in_progress' || t.status === 'pending' ? 'wip' : 'open';
    const voc: NonNullable<Task['voc']> = { id: t.id, number: t.number, status: t.status };
    if (t.priority) voc.priority = t.priority;
    if (t.slaStatus) voc.slaStatus = t.slaStatus;
    if (t.systemName) voc.systemName = t.systemName;
    const task: Task = {
      id: `v:${t.id}`,
      source: 'voc',
      voc,
      title: t.title.trim() || t.number,
      status,
      bucket: 'other',
    };
    const due = t.ictDue ?? t.customerDue;
    if (due) task.due = due;
    const opened = utcToKstDate(t.createdAt);
    if (opened) {
      task.opened = opened;
      task.openDays = businessDaysBetween(cal, opened, today);
    }
    const company = t.customerPage ? pageNameOf(t.customerPage) : t.customer?.trim();
    if (company) task.company = company;
    const pri = priorityNumber(t.priority);
    if (pri !== undefined) task.pri = pri;
    return task;
  });
}
