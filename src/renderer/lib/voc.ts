// VOC 담당자별 보드(2.6단계 명세 §3·§4·§7) → 화면 표시값. React 를 모르는 순수 함수만 둔다(시험하기 쉽게).
// main 이 보낸 보드가 계약과 조금 달라도 화면이 깨지지 않게 다듬는다. 요청 내용·답변은 글자로만 다룬다(HTML 없음).
// 화면 문구는 사실(건수·경과일·SLA)만 쓴다 — 판단어·순위를 쓰지 않는다(명세 §0).
import type {
  VocActionExpected,
  VocActionKind,
  VocActionResult,
  VocBoard,
  VocBoardState,
  VocCode,
  VocCustomer,
  VocDirectory,
  VocLane,
  VocLaneSummary,
  VocMember,
  VocReply,
  VocSettings,
  VocSlaStatus,
  VocTicket,
  VocTicketDetail,
} from '../../shared/types';
import { isVocLoginId, vocLoginIdProblem, vocPasswordProblem } from '../../shared/voc';
import { FOCUS_VOC_LOGIN, FOCUS_VOC_VIEW } from '../api';
import { formatHourMinute, formatMailDate, formatMonthDay, formatSlash, localYmd, parseYmd, weekdayShort, yearOf } from './date';
import { asSentence, makeSendId, previewLines } from './reply';
import { numberOf, textOf } from './tasks';
import { normalizeAttachments, normalizeEmailList } from './vocWork';

/** main 이 명령을 보내지 않았을 때 '터미널에서 하려면'에 보이는 로그인 명령(앱 안 로그인은 [로그인] — 명세 §13) */
export const DEFAULT_LOGIN_COMMAND = 'voc-cli login -u <아이디>';

/** VOC 화면을 열 때 마지막으로 받은 지 이만큼 지났으면 새로 받는다(명세 §2-3) */
export const VOC_OPEN_REFRESH_MS = 2 * 60_000;

/** 요청 내용을 접는 줄 수(명세 §3-1). 줄이 적어도 글자가 이만큼 넘으면 접는다 */
export const TEXT_FOLD_LINES = 12;
export const TEXT_FOLD_CHARS = 1500;

/** 설정 한도(명세 §7 — main 도 따로 검사한다) */
export const VOC_SETTINGS_LIMITS = { members: 50, systems: 100, pollMin: 5, pollMax: 60 } as const;

/** 답변 내용 한도(명세 §5) */
export const VOC_REPLY_MAX = 5000;

export const VOC_PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type VocPriority = (typeof VOC_PRIORITIES)[number];

/** V3a 에서 앱이 바꿀 수 있는 상태(해결·완료는 VOC 웹에서 — 명세 §5) */
export const VOC_TASK_STATUSES = ['in_progress', 'pending'] as const;

// ── 이름표 ──

const STATUS_LABEL: Record<string, string> = {
  new: '신규',
  assigned: '배정됨',
  in_progress: '진행 중',
  pending: '보류',
  resolved: '해결',
  closed: '완료',
  withdrawn: '철회',
};

/** VOC 상태 → '진행 중'. 모르는 값은 받은 글자 그대로(비었으면 '상태 없음') */
export function vocStatusLabel(status: unknown): string {
  const raw = textOf(status);
  if (!raw) return '상태 없음';
  return STATUS_LABEL[raw] ?? raw;
}

/** '진행 중(in_progress)' — 확인 대화상자·상세처럼 원래 값도 알아야 하는 곳 */
export function vocStatusText(status: unknown): string {
  const raw = textOf(status);
  if (!raw) return '상태 없음';
  const label = STATUS_LABEL[raw];
  return label ? `${label}(${raw})` : raw;
}

const REQUEST_TYPE_LABEL: Record<string, string> = {
  inquiry: '문의',
  bug: '오류',
  enhancement: '개선',
  data_request: '데이터 요청',
  access: '권한',
  other: '기타',
  substance_registration: '물질 등록',
};

/** 요청유형 코드 → '문의'. 모르는 값(옛 시스템의 한글값 등)은 그대로 */
export function requestTypeLabel(code: unknown): string | undefined {
  const raw = textOf(code);
  if (!raw) return undefined;
  return REQUEST_TYPE_LABEL[raw] ?? raw;
}

export type VocTone = 'coral' | 'amber' | 'muted';

export interface VocMark {
  /** 줄에 보이는 짧은 글자 */
  text: string;
  tone?: VocTone;
  /** 읽기 도구·title 용 풀이 */
  label: string;
}

export function isVocPriority(value: unknown): value is VocPriority {
  return typeof value === 'string' && (VOC_PRIORITIES as readonly string[]).includes(value);
}

/** 우선순위 표식(목록 왼쪽 칸). P1 은 앰버, P3 는 흐리게. P1~P3 가 아니면(외부 API 의 medium 등) '—' */
export function priorityMark(priority: unknown): VocMark {
  const raw = textOf(priority);
  if (isVocPriority(raw)) {
    return { text: raw, tone: raw === 'P1' ? 'amber' : raw === 'P3' ? 'muted' : undefined, label: `우선순위 ${raw}` };
  }
  return { text: '—', tone: 'muted', label: raw ? `우선순위 ${raw}` : '우선순위 없음' };
}

export type VocSlaKey = VocSlaStatus | 'none';

export function slaKey(sla: unknown): VocSlaKey {
  return sla === 'exceeded' || sla === 'warning' || sla === 'normal' ? sla : 'none';
}

/** SLA 표식. 초과(코랄)·임박(앰버)만 목록에 보이고, 정상·미적용은 상세에만 글자로 */
export function slaMark(sla: unknown): VocMark | null {
  switch (slaKey(sla)) {
    case 'exceeded':
      return { text: 'SLA 초과', tone: 'coral', label: 'SLA 해결 목표 초과' };
    case 'warning':
      return { text: 'SLA 임박', tone: 'amber', label: 'SLA 해결 목표 80% 넘음' };
    case 'normal':
      return { text: 'SLA 정상', label: 'SLA 해결 목표 안' };
    default:
      return null;
  }
}

/** 해결 목표(분) → '목표 48시간' · '목표 1시간 30분' · '목표 45분'. 없으면 undefined */
export function slaTargetText(minutes: unknown): string | undefined {
  const n = numberOf(minutes);
  if (n === undefined || n <= 0) return undefined;
  const total = Math.round(n);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `목표 ${m}분`;
  return m === 0 ? `목표 ${h}시간` : `목표 ${h}시간 ${m}분`;
}

/** 경과 달력일 → '오늘 접수' · '3일째' */
export function ageText(days: unknown): string {
  const n = numberOf(days);
  if (n === undefined || n <= 0) return '오늘 접수';
  return `${Math.floor(n)}일째`;
}

/** 'YYYY-MM-DD' → '10월 5일(일)'(올해가 아니면 해도) */
export function dateText(ymd: string, today: string): string {
  if (!parseYmd(ymd)) return ymd;
  return `${formatMonthDay(ymd, yearOf(today))}(${weekdayShort(ymd)})`;
}

/** UTC ISO 시각 → KST 벽시계 '9월 21일 오후 3:04'(올해면 해 생략). 알아볼 수 없으면 빈 문자열 */
export function kstDateTimeText(iso: unknown, today: string): string {
  if (typeof iso !== 'string' || iso.trim() === '') return '';
  return formatMailDate(iso, { refYear: yearOf(today), offsetMinutes: 9 * 60 });
}

export interface VocDue {
  date: string;
  kind: 'ict' | 'customer';
  /** 목록 줄 '예상 10/5' · '희망 10/5' */
  short: string;
  /** 상세·읽기 도구 'ICT 예상완료일 10월 5일(일)' */
  long: string;
  /** 오늘보다 앞선 날이면 지남(코랄 + '지남' 글자) */
  overdue: boolean;
}

/** 표시할 기한: ICT 예상완료일 우선, 없으면 고객 희망일(명세 §3-1). 둘 다 없으면 null */
export function vocDue(ticket: Pick<VocTicket, 'ictDue' | 'customerDue'>, today: string): VocDue | null {
  const ict = parseYmd(ticket.ictDue) ? ticket.ictDue : undefined;
  const customer = parseYmd(ticket.customerDue) ? ticket.customerDue : undefined;
  const date = ict ?? customer;
  if (!date) return null;
  const kind = ict ? 'ict' : 'customer';
  const overdue = !!parseYmd(today) && date < today;
  return {
    date,
    kind,
    short: `${kind === 'ict' ? '예상' : '희망'} ${formatSlash(date)}${overdue ? ' 지남' : ''}`,
    long: `${kind === 'ict' ? 'ICT 예상완료일' : '고객 희망일'} ${dateText(date, today)}${overdue ? ' — 지남' : ''}`,
    overdue,
  };
}

// ── 조사(을/를, 으로/로) ──

type FinalSound = 'none' | 'rieul' | 'other' | 'unknown';

/** 숫자를 읽었을 때 끝소리(0 영·십, 1 일, 2 이, 3 삼, 4 사, 5 오, 6 육, 7 칠, 8 팔, 9 구) */
const DIGIT_FINAL: Record<string, FinalSound> = {
  '0': 'other',
  '1': 'rieul',
  '2': 'none',
  '3': 'other',
  '4': 'none',
  '5': 'none',
  '6': 'other',
  '7': 'rieul',
  '8': 'rieul',
  '9': 'none',
};

function finalSound(word: string): FinalSound {
  // 끝의 닫는 괄호 묶음('나(홍길동)' · '진행 중(in_progress)')은 앞 낱말로 읽는다
  const trimmed = word.trim().replace(/\([^()]*\)$/, '').trim();
  const ch = trimmed.slice(-1);
  if (!ch) return 'unknown';
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (jong === 0) return 'none';
    return jong === 8 ? 'rieul' : 'other';
  }
  return DIGIT_FINAL[ch] ?? 'unknown';
}

/** 목적격 조사: 'VOC-2026-0001' → '을', 'VOC-2026-0002' → '를'. 모르면 '을(를)' */
export function objectParticle(word: string): string {
  const f = finalSound(word);
  if (f === 'unknown') return '을(를)';
  return f === 'none' ? '를' : '을';
}

/** 방향 조사: '10/5' → '로', '10/3' → '으로', '10/1' → '로'(ㄹ 받침). 모르면 '(으)로' */
export function directionParticle(word: string): string {
  const f = finalSound(word);
  if (f === 'unknown') return '(으)로';
  return f === 'other' ? '으로' : '로';
}

/** 주격 조사: 'VOC-2026-0101' → '이'(일), 'VOC-2026-0102' → '가'(이). 모르면 '이(가)' */
export function subjectParticle(word: string): string {
  const f = finalSound(word);
  if (f === 'unknown') return '이(가)';
  return f === 'none' ? '가' : '이';
}

// ── 보드 다듬기(main 응답을 믿고 쓸 수 있게) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveInt(value: unknown): number | undefined {
  const n = numberOf(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = numberOf(value);
  return n !== undefined && n >= 0 ? n : undefined;
}

function isoOf(value: unknown): string | undefined {
  const t = textOf(value);
  return t && !Number.isNaN(Date.parse(t)) ? t : undefined;
}

function ymdOf(value: unknown): string | undefined {
  return typeof value === 'string' && parseYmd(value) ? value.trim() : undefined;
}

/** 위키 문서 경로: 볼트 기준 상대 .md 만(Obsidian 으로 연다 — main 이 한 번 더 검사한다) */
function pageOf(value: unknown): string | undefined {
  const t = textOf(value);
  if (!t) return undefined;
  const path = t.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.split('/').includes('..') || !/\.md$/i.test(path)) {
    return undefined;
  }
  return path;
}

const BOARD_STATES: readonly VocBoardState[] = ['loading', 'ok', 'stale', 'login', 'unavailable', 'notConfigured'];

function isBoardState(value: unknown): value is VocBoardState {
  return typeof value === 'string' && (BOARD_STATES as readonly string[]).includes(value);
}

export function normalizeMember(raw: unknown): VocMember | null {
  if (!isRecord(raw)) return null;
  const id = positiveInt(raw.id);
  if (id === undefined) return null;
  const member: VocMember = { id, name: textOf(raw.name) ?? `사용자 ${id}` };
  const email = textOf(raw.email);
  if (email) member.email = email;
  const department = textOf(raw.department);
  if (department) member.department = department;
  return member;
}

/** 티켓 한 건. 내부 id 가 없으면(모든 명령의 <id>) 버린다 */
export function normalizeVocTicket(raw: unknown): VocTicket | null {
  if (!isRecord(raw)) return null;
  const id = positiveInt(raw.id);
  if (id === undefined) return null;
  const ticket: VocTicket = {
    id,
    number: textOf(raw.number) ?? `#${id}`,
    title: textOf(raw.title) ?? '(제목 없음)',
    status: textOf(raw.status) ?? '',
    createdAt: textOf(raw.createdAt) ?? '',
    text: typeof raw.text === 'string' ? raw.text : '',
    ageDays: Math.floor(nonNegative(raw.ageDays) ?? 0),
    ageBusinessDays: Math.floor(nonNegative(raw.ageBusinessDays) ?? 0),
  };
  for (const key of ['priority', 'customer', 'system', 'systemName', 'assigneeName', 'requesterName', 'requestType'] as const) {
    const t = textOf(raw[key]);
    if (t) ticket[key] = t;
  }
  for (const key of ['updatedAt', 'lastReplyAt'] as const) {
    const t = isoOf(raw[key]);
    if (t) ticket[key] = t;
  }
  for (const key of ['customerId', 'assigneeId'] as const) {
    const n = positiveInt(raw[key]);
    if (n !== undefined) ticket[key] = n;
  }
  const target = nonNegative(raw.slaResolutionTarget);
  if (target !== undefined) ticket.slaResolutionTarget = target;
  const replies = nonNegative(raw.replyCount);
  if (replies !== undefined) ticket.replyCount = Math.floor(replies);
  for (const key of ['customerDue', 'ictDue'] as const) {
    const d = ymdOf(raw[key]);
    if (d) ticket[key] = d;
  }
  const sla = slaKey(raw.slaStatus);
  if (sla !== 'none') ticket.slaStatus = sla;
  for (const key of ['customerPage', 'systemPage'] as const) {
    const p = pageOf(raw[key]);
    if (p) ticket[key] = p;
  }
  return ticket;
}

/** 칸 요약(main 이 보내지 않았으면 티켓으로 센다) */
export function summarizeTickets(tickets: readonly VocTicket[]): VocLaneSummary {
  let oldest: number | undefined;
  let exceeded = 0;
  let warning = 0;
  let p1 = 0;
  for (const t of tickets) {
    if (t.slaStatus === 'exceeded') exceeded += 1;
    else if (t.slaStatus === 'warning') warning += 1;
    if (t.priority === 'P1') p1 += 1;
    oldest = oldest === undefined ? t.ageDays : Math.max(oldest, t.ageDays);
  }
  const summary: VocLaneSummary = { total: tickets.length, slaExceeded: exceeded, slaWarning: warning, p1 };
  if (oldest !== undefined) summary.oldestDays = oldest;
  return summary;
}

function normalizeSummary(raw: unknown, tickets: readonly VocTicket[]): VocLaneSummary {
  const counted = summarizeTickets(tickets);
  if (!isRecord(raw)) return counted;
  const pick = (key: 'total' | 'slaExceeded' | 'slaWarning' | 'p1'): number => {
    const n = nonNegative(raw[key]);
    return n !== undefined ? Math.floor(n) : counted[key];
  };
  const summary: VocLaneSummary = { total: pick('total'), slaExceeded: pick('slaExceeded'), slaWarning: pick('slaWarning'), p1: pick('p1') };
  const oldest = nonNegative(raw.oldestDays) ?? counted.oldestDays;
  if (oldest !== undefined) summary.oldestDays = Math.floor(oldest);
  return summary;
}

const LANE_KEY_RE = /^(unassigned|user:\d+)$/;

function normalizeLane(raw: unknown): VocLane | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !LANE_KEY_RE.test(raw.key)) return null;
  const seen = new Set<number>();
  const tickets: VocTicket[] = [];
  for (const t of Array.isArray(raw.tickets) ? raw.tickets : []) {
    const ticket = normalizeVocTicket(t);
    if (!ticket || seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    tickets.push(ticket);
  }
  const member = normalizeMember(raw.member) ?? undefined;
  const lane: VocLane = {
    key: raw.key,
    label: textOf(raw.label) ?? (raw.key === 'unassigned' ? '미배정' : (member?.name ?? raw.key)),
    tickets,
    summary: normalizeSummary(raw.summary, tickets),
  };
  if (member) lane.member = member;
  if (raw.me === true) lane.me = true;
  return lane;
}

function emptyTotals(): VocBoard['totals'] {
  return { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 };
}

/** 합계를 칸에서 센다(같은 티켓이 두 칸에 있어도 한 번) */
export function totalsOf(lanes: readonly VocLane[]): VocBoard['totals'] {
  const totals = emptyTotals();
  const seen = new Set<number>();
  for (const lane of lanes) {
    for (const t of lane.tickets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      totals.team += 1;
      if (lane.key === 'unassigned') totals.unassigned += 1;
      if (t.slaStatus === 'exceeded') totals.slaExceeded += 1;
      else if (t.slaStatus === 'warning') totals.slaWarning += 1;
    }
  }
  return totals;
}

/** main 이 보낸 보드. 모양이 틀리면 unavailable 로(화면은 이유를 보인다) */
export function normalizeVocBoard(raw: unknown): VocBoard {
  if (!isRecord(raw)) {
    return { state: 'unavailable', message: '받은 VOC 보드의 모양이 맞지 않습니다.', lanes: [], totals: emptyTotals() };
  }
  const seen = new Set<string>();
  const lanes: VocLane[] = [];
  for (const l of Array.isArray(raw.lanes) ? raw.lanes : []) {
    const lane = normalizeLane(l);
    if (!lane || seen.has(lane.key)) continue;
    seen.add(lane.key);
    lanes.push(lane);
  }
  const counted = totalsOf(lanes);
  const rawTotals = isRecord(raw.totals) ? raw.totals : {};
  const pick = (key: keyof VocBoard['totals']): number => {
    const n = nonNegative(rawTotals[key]);
    return n !== undefined ? Math.floor(n) : counted[key];
  };
  const board: VocBoard = {
    state: isBoardState(raw.state) ? raw.state : 'unavailable',
    lanes,
    totals: { team: pick('team'), unassigned: pick('unassigned'), slaExceeded: pick('slaExceeded'), slaWarning: pick('slaWarning') },
  };
  const message = textOf(raw.message);
  if (message) board.message = message;
  const fetchedAt = isoOf(raw.fetchedAt);
  if (fetchedAt) board.fetchedAt = fetchedAt;
  const me = normalizeMember(raw.me);
  if (me) board.me = me;
  else if (raw.meMissing === true) board.meMissing = true;
  const webBase = textOf(raw.webBase);
  if (webBase && /^https:\/\/[^/\s]+$/.test(webBase)) board.webBase = webBase;
  const loginCommand = textOf(raw.loginCommand);
  if (loginCommand && loginCommand.length <= 200) board.loginCommand = loginCommand;
  if (isVocLoginId(raw.loginId)) board.loginId = raw.loginId;
  return board;
}

function normalizeReply(raw: unknown): VocReply | null {
  if (!isRecord(raw)) return null;
  const id = positiveInt(raw.id);
  if (id === undefined) return null;
  const reply: VocReply = { id, createdAt: textOf(raw.createdAt) ?? '', text: typeof raw.text === 'string' ? raw.text : '' };
  const author = textOf(raw.authorName);
  if (author) reply.authorName = author;
  const type = textOf(raw.authorType);
  if (type) reply.authorType = type;
  return reply;
}

/** 티켓 상세 + 답변. 티켓 모양이 틀리면 오류 */
export function normalizeTicketDetail(raw: unknown): VocTicketDetail {
  const ticket = isRecord(raw) ? normalizeVocTicket(raw.ticket) : null;
  if (!ticket) throw new Error('받은 티켓 상세의 모양이 맞지 않습니다.');
  const replies = (isRecord(raw) && Array.isArray(raw.replies) ? raw.replies : [])
    .map(normalizeReply)
    .filter((r): r is VocReply => r !== null);
  const detail: VocTicketDetail = { ticket, replies };
  // V4(명세 §14): 요청·답변 첨부와 고객 메일 기본 받는 사람
  if (isRecord(raw) && Array.isArray(raw.attachments)) detail.attachments = normalizeAttachments(raw.attachments);
  if (isRecord(raw) && Array.isArray(raw.customerEmails)) detail.customerEmails = normalizeEmailList(raw.customerEmails);
  return detail;
}

/** 답변 작성자 종류 → '고객' · '내부' */
export function replyAuthorType(type: unknown): string | undefined {
  const t = textOf(type);
  if (!t) return undefined;
  if (t === 'customer') return '고객';
  if (t === 'internal') return '내부';
  return t;
}

/** 선택지 코드 한 개(시스템이면 그 시스템이 나온 고객사 id 도) */
export function normalizeCode(raw: unknown): VocCode | null {
  if (!isRecord(raw)) return null;
  const code = textOf(raw.code);
  if (!code) return null;
  const out: VocCode = { code, name: textOf(raw.name) ?? code };
  if (Array.isArray(raw.customerIds)) {
    const ids = [...new Set(raw.customerIds.map(positiveInt).filter((n): n is number => n !== undefined))];
    if (ids.length > 0) out.customerIds = ids;
  }
  return out;
}

function normalizeCustomer(raw: unknown): VocCustomer | null {
  if (!isRecord(raw)) return null;
  const id = positiveInt(raw.id);
  if (id === undefined) return null;
  return { id, name: textOf(raw.name) ?? `고객사 ${id}` };
}

function listOf<T>(value: unknown, fn: (v: unknown) => T | null, keyOf: (t: T) => string | number): T[] {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (const v of Array.isArray(value) ? value : []) {
    const item = fn(v);
    if (!item || seen.has(keyOf(item))) continue;
    seen.add(keyOf(item));
    out.push(item);
  }
  return out;
}

export function normalizeDirectory(raw: unknown): VocDirectory {
  const r = isRecord(raw) ? raw : {};
  const dir: VocDirectory = {
    users: listOf(r.users, normalizeMember, (m) => m.id),
    systems: listOf(r.systems, normalizeCode, (c) => c.code),
    requestTypes: listOf(r.requestTypes, normalizeCode, (c) => c.code),
    customers: listOf(r.customers, normalizeCustomer, (c) => c.id),
  };
  const me = normalizeMember(r.me);
  if (me) dir.me = me;
  return dir;
}

export const DEFAULT_VOC_SETTINGS_VIEW: VocSettings = { memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10 };

export function normalizeVocSettings(raw: unknown): VocSettings {
  if (!isRecord(raw)) return { ...DEFAULT_VOC_SETTINGS_VIEW, memberIds: [], systems: [] };
  const memberIds = Array.isArray(raw.memberIds)
    ? [...new Set(raw.memberIds.map(positiveInt).filter((n): n is number => n !== undefined))]
    : [];
  const systems = Array.isArray(raw.systems)
    ? [...new Set(raw.systems.map((s) => textOf(s)).filter((s): s is string => !!s))]
    : [];
  const poll = numberOf(raw.pollMinutes);
  const settings: VocSettings = {
    memberIds,
    systems,
    showAllUnassigned: raw.showAllUnassigned === true,
    pollMinutes: poll !== undefined ? poll : DEFAULT_VOC_SETTINGS_VIEW.pollMinutes,
  };
  const myId = positiveInt(raw.myId);
  if (myId !== undefined) settings.myId = myId;
  const apiUrl = textOf(raw.apiUrl);
  if (apiUrl) settings.apiUrl = apiUrl;
  const jar = textOf(raw.jarPath);
  if (jar) settings.jarPath = jar;
  if (isVocLoginId(raw.loginId)) settings.loginId = raw.loginId;
  return settings;
}

// ── 머리·띠·사이드바 문구 ──

/** 받은 시각 '오전 10:32 받음(3분 전)'. 오늘이 아니면 날짜도. 알아볼 수 없으면 빈 문자열 */
export function fetchedText(fetchedAt: unknown, nowMs: number, today: string): string {
  if (typeof fetchedAt !== 'string') return '';
  const ms = Date.parse(fetchedAt);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = localYmd(d);
  const clock = formatHourMinute(d.getHours(), d.getMinutes());
  const at = day === today ? clock : `${formatMonthDay(day, yearOf(today))} ${clock}`;
  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diff / 60_000);
  let rel: string;
  if (minutes < 1) rel = '방금';
  else if (minutes < 60) rel = `${minutes}분 전`;
  else if (minutes < 24 * 60) rel = `${Math.floor(minutes / 60)}시간 전`;
  else rel = `${Math.floor(minutes / (24 * 60))}일 전`;
  return `${at} 받음(${rel})`;
}

/** '오전 10:32' 처럼 받은 시각만(띠·경고 문장용). 오늘이 아니면 날짜도 */
export function fetchedClock(fetchedAt: unknown, today: string): string {
  if (typeof fetchedAt !== 'string') return '';
  const ms = Date.parse(fetchedAt);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = localYmd(d);
  const clock = formatHourMinute(d.getHours(), d.getMinutes());
  return day === today ? clock : `${formatMonthDay(day, yearOf(today))} ${clock}`;
}

export interface VocTextPart {
  key: string;
  text: string;
  tone?: VocTone;
}

/** 머리 요약 '진행 중 N · 미배정 N · SLA 초과 N · 임박 N' */
export function boardHeadParts(board: Pick<VocBoard, 'totals'>): VocTextPart[] {
  const { team, unassigned, slaExceeded, slaWarning } = board.totals;
  return [
    { key: 'team', text: `진행 중 ${team}` },
    { key: 'unassigned', text: `미배정 ${unassigned}`, tone: unassigned > 0 ? 'amber' : undefined },
    { key: 'exceeded', text: `SLA 초과 ${slaExceeded}`, tone: slaExceeded > 0 ? 'coral' : undefined },
    { key: 'warning', text: `임박 ${slaWarning}`, tone: slaWarning > 0 ? 'amber' : undefined },
  ];
}

export interface VocBannerInfo {
  state: VocBoardState;
  tone: VocTone;
  title: string;
  /** main 이 보낸 이유(제목과 같으면 없음) */
  detail?: string;
  /** 사람이 할 일 */
  hint?: string;
  /** 띠 안에 [로그인](앱 안 로그인 대화상자 — 명세 §13)을 둔다 */
  login?: boolean;
  /** 로그인 명령(복사 버튼) — '터미널에서 하려면' 아래에 접어 둔다 */
  command?: string;
  /** 터미널 명령 앞의 안내 */
  commandHint?: string;
  /** 띠 안에 [설정] 버튼을 둔다 */
  settings?: boolean;
  /** 받는 중(돌아가는 표시) */
  busy?: boolean;
}

export const NOT_CONFIGURED_TEXT = 'voc-cli jar 를 찾지 못했습니다 — 설정에서 위치를 지정하세요';

/** 세션 만료 안내(명세 §1 표 — 띠에 한 번만) */
const RELOGIN_NOTE = '주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다';

/** text 가 lead(제목)로 시작하면 그 뒤(이음표·쌍점과 공백을 걷은 것)만. 남는 것이 없으면 undefined, 제목으로 시작하지 않으면 그대로 */
function afterLead(text: string | undefined, lead: string): string | undefined {
  if (!text || !text.startsWith(lead)) return text;
  const rest = text
    .slice(lead.length)
    .replace(/^[\s—–:-]+/, '')
    .trim();
  return rest === '' || /^[.。]$/.test(rest) ? undefined : rest;
}

/** 상태 안내 띠(명세 §1 표). ok 면 null */
export function vocBanner(board: VocBoard, today: string): VocBannerInfo | null {
  const message = board.message ? asSentence(board.message) : undefined;
  const differs = (title: string): string | undefined =>
    message && message.replace(/[.。]$/, '') !== title.replace(/[.。]$/, '') ? message : undefined;
  switch (board.state) {
    case 'ok':
      return null;
    case 'loading':
      return { state: 'loading', tone: 'muted', title: 'VOC 목록을 받는 중입니다…', busy: true };
    case 'login': {
      const title = 'VOC 에 로그인이 필요합니다';
      // main 의 문장이 제목으로 시작하면(세션 만료: 'VOC 에 로그인이 필요합니다 — 세션이 만료되었습니다(주말처럼 …)') 제목 뒤만 보인다.
      // 주말 안내도 그 문장에 없을 때만 붙인다 — 띠(role=alert)가 같은 말을 두 번 하지 않게
      const detail = afterLead(differs(title), title);
      const hint = detail?.includes(RELOGIN_NOTE)
        ? '[로그인]을 눌러 VOC 아이디·비밀번호를 넣으세요.'
        : `[로그인]을 눌러 VOC 아이디·비밀번호를 넣으세요. ${RELOGIN_NOTE}.`;
      return {
        state: 'login',
        tone: 'amber',
        title,
        detail,
        hint,
        login: true,
        // 터미널 명령은 main 이 voc-cli 를 띄울 때만 보낸다(앱이 VOC API 를 직접 부르면 앱 안 로그인만 — 명세 §15)
        ...(board.loginCommand
          ? { command: board.loginCommand, commandHint: '터미널에서 아래 명령으로 로그인한 뒤 [다시 확인]을 누르세요.' }
          : {}),
      };
    }
    case 'unavailable': {
      const title = 'VOC 서버에 연결하지 못했습니다';
      return { state: 'unavailable', tone: 'coral', title, detail: differs(title) };
    }
    case 'stale': {
      const at = fetchedClock(board.fetchedAt, today);
      const title = at ? `VOC 목록을 새로 받지 못했습니다 — ${at}에 받은 목록입니다` : 'VOC 목록을 새로 받지 못했습니다';
      return { state: 'stale', tone: 'amber', title, detail: differs(title) };
    }
    case 'notConfigured': {
      const title = board.message ?? NOT_CONFIGURED_TEXT;
      return { state: 'notConfigured', tone: 'coral', title, settings: true };
    }
  }
}

/** 로그인 명령 [복사] 뒤 알림 — 명령에 '<아이디>' 자리가 있을 때만 바꾸라고 한다 */
export function loginCopiedText(command: string): string {
  return command.includes('<아이디>')
    ? '로그인 명령을 복사했습니다. 터미널에 붙여 넣고 <아이디>를 내 VOC 아이디로 바꿔 실행하세요.'
    : '로그인 명령을 복사했습니다. 터미널에 붙여 넣어 실행하세요.';
}

/**
 * 목록은 받았는데 나를 찾지 못했고 팀원도 고르지 않아 사람 칸이 하나도 없다 — 팀·팀 시스템을 정하지 못해 미배정 칸도 비어 보이므로
 * 합계(0건)를 사실처럼 보이지 않는다
 */
export function boardTeamUnknown(board: Pick<VocBoard, 'meMissing' | 'lanes'> | null | undefined): boolean {
  return !!board && board.meMissing === true && !board.lanes.some((l) => l.member);
}

export interface VocSetupBannerInfo {
  title: string;
  detail: string;
}

/** 설정 안내 띠(voc-setup-banner): 받은 목록은 있는데 나를 찾지 못했다(명세 §2-2 '그래도 없으면 설정에서 고른다'). 없으면 null */
export function vocSetupBanner(board: VocBoard | null | undefined): VocSetupBannerInfo | null {
  if (!board || board.meMissing !== true || !board.fetchedAt) return null;
  if (board.state === 'login' || board.state === 'notConfigured' || board.state === 'loading') return null;
  return {
    title: 'VOC 에서 나를 찾지 못했습니다 — 설정에서 나를 고르세요',
    detail: boardTeamUnknown(board)
      ? 'VOC 로그인 이메일(과 메일 계정 주소)이 VOC 사용자 목록에 없어 팀과 팀 시스템을 정하지 못했습니다. 그래서 칸이 비어 보입니다 — 미배정이 0건이라는 뜻이 아닙니다. 나(또는 팀원)를 고르면 담당자별 칸과 내 담당 VOC 할 일이 생깁니다.'
      : 'VOC 로그인 이메일(과 메일 계정 주소)이 VOC 사용자 목록에 없습니다. 나를 고르기 전까지 내 담당 VOC 할 일이 할 일 목록에 오지 않습니다.',
  };
}

/** 설정 대화상자가 사람·시스템 목록을 받지 못했을 때 덧붙이는 안내(보드 상태에 따라) */
export function directoryErrorHint(state: VocBoardState | undefined): string {
  switch (state) {
    case 'notConfigured':
      // 앱이 VOC API 를 직접 부르면 시험 보호(localhost 만)에 걸린 때, voc-cli 를 띄우면(WIKI_RADAR_VOC_CLI) jar·java 를 못 찾은 때다
      return 'VOC 를 부를 준비가 되지 않았습니다 — 위 안내대로 VOC 서버 주소(voc-cli 를 쓰는 중이면 jar·java 위치)를 확인하세요. 고친 뒤 다시 열면 팀원·시스템을 고를 수 있습니다.';
    case 'login':
      return '[로그인]으로 VOC 에 로그인한 뒤 다시 열면 팀원·시스템을 고를 수 있습니다.';
    case 'unavailable':
    case 'stale':
      return 'VOC 서버에 연결되면 다시 열어 팀원·시스템을 고를 수 있습니다.';
    default:
      return '잠시 뒤 다시 열면 팀원·시스템을 고를 수 있습니다.';
  }
}

export interface SidebarVocInfo {
  state: VocBoardState;
  /** data-count(팀 미배정) */
  count: number;
  exceeded: number;
  /** 'VOC 미배정' · 'VOC 로그인 필요' … */
  label: string;
  /** 수를 보이는가(ok·stale) */
  showCount: boolean;
  /** 흐리게(미배정 0, 받는 중, 설정 필요 등) */
  dim: boolean;
  /** 로그인 필요는 앰버 */
  attention: boolean;
  /** 읽기 도구 풀이(aria-description) */
  description: string;
  title: string;
}

/** 사이드바 상태 줄 'VOC 미배정 N · 초과 M'(명세 §3-2). 담당자별 내역은 넣지 않는다 */
export function sidebarVocInfo(board: VocBoard | null, today: string): SidebarVocInfo {
  const open = '누르면 풀스크린의 VOC 화면이 열립니다.';
  if (!board || board.state === 'loading') {
    return {
      state: 'loading',
      count: board?.totals.unassigned ?? 0,
      exceeded: 0,
      label: 'VOC 받는 중',
      showCount: false,
      dim: true,
      attention: false,
      description: `VOC 목록을 받는 중입니다. ${open}`,
      title: 'VOC 화면 열기',
    };
  }
  const { unassigned, slaExceeded } = board.totals;
  const base = { state: board.state, count: unassigned, exceeded: slaExceeded, title: 'VOC 화면 열기' };
  if (board.state === 'login') {
    return {
      ...base,
      label: 'VOC 로그인 필요',
      showCount: false,
      dim: false,
      attention: true,
      description: 'VOC 에 로그인이 필요합니다. 누르면 풀스크린의 VOC 화면과 로그인 창이 열립니다.',
      title: 'VOC 로그인 창 열기',
    };
  }
  if (board.state === 'notConfigured') {
    return { ...base, label: 'VOC 설정 필요', showCount: false, dim: true, attention: false, description: `${NOT_CONFIGURED_TEXT}. ${open}` };
  }
  if (board.state === 'unavailable' && !board.fetchedAt) {
    return { ...base, label: 'VOC 연결 안 됨', showCount: false, dim: true, attention: false, description: `VOC 서버에 연결하지 못했습니다. ${open}` };
  }
  if (boardTeamUnknown(board)) {
    return {
      ...base,
      label: 'VOC 설정 필요',
      showCount: false,
      dim: false,
      attention: true,
      description: `VOC 에서 나를 찾지 못해 팀을 정하지 못했습니다 — 풀스크린 VOC 화면의 설정에서 나를 고르세요. ${open}`,
    };
  }
  const at =board.state === 'stale' || board.state === 'unavailable' ? fetchedClock(board.fetchedAt, today) : '';
  const facts = `팀 미배정 ${unassigned}건${slaExceeded > 0 ? `, SLA 초과 ${slaExceeded}건` : ''}${at ? `(${at} 기준)` : ''}.`;
  return {
    ...base,
    label: 'VOC 미배정',
    showCount: true,
    dim: unassigned === 0,
    attention: false,
    description: `VOC ${facts} ${open}`,
    title: at ? `VOC 화면 열기 — ${at}에 받은 목록` : 'VOC 화면 열기',
  };
}

/** 풀스크린 내비 'VOC' 옆 수(팀 미배정 — data-count) */
export function navVocCount(board: VocBoard | null): number {
  return board ? board.totals.unassigned : 0;
}

export interface NavVocInfo {
  /** data-count(팀 미배정) */
  count: number;
  /** 수 대신 보일 짧은 글자(수가 사실이 아닐 때 — 받는 중·로그인 필요·설정 필요·연결 안 됨). 없으면 수를 보인다 */
  note?: string;
  /** aria-description */
  description: string;
}

/** 내비 'VOC' 옆 표시 — 사이드바(sidebarVocInfo)와 같은 판정: 받은 적 없는 보드의 0 을 '미배정 0건'으로 보이지 않는다 */
export function navVocInfo(board: VocBoard | null): NavVocInfo {
  const count = navVocCount(board);
  if (!board || board.state === 'loading') return { count, note: '받는 중', description: 'VOC 목록을 받는 중입니다.' };
  if (board.state === 'login') return { count, note: '로그인 필요', description: 'VOC 에 로그인이 필요합니다.' };
  if (board.state === 'notConfigured') return { count, note: '설정 필요', description: `${NOT_CONFIGURED_TEXT}.` };
  if (!board.fetchedAt) return { count, note: '연결 안 됨', description: 'VOC 서버에 연결하지 못해 아직 목록을 받지 못했습니다.' };
  if (boardTeamUnknown(board)) {
    return { count, note: '설정 필요', description: 'VOC 에서 나를 찾지 못해 팀을 정하지 못했습니다 — 설정에서 나를 고르세요.' };
  }
  return { count, description: `팀 미배정 ${count}건` };
}

/**
 * VOC 화면을 열 때 새로 받을까: 마지막으로 받은 지 2분 넘게 지났거나 한 번도 받지 못했으면(시작 5초 뒤 첫 받기 전 포함 —
 * main 은 실행 중인 받기가 있으면 그 결과를 돌려준다). 로그인 필요·설정 필요면 부르지 않는다
 * (세션 없는 호출을 되풀이하지 않는다 — 명세 §2-3, [다시 확인]만).
 */
export function shouldRefreshOnOpen(board: VocBoard | null, nowMs: number): boolean {
  if (!board) return false;
  if (board.state === 'login' || board.state === 'notConfigured') return false;
  if (!board.fetchedAt) return true;
  const ms = Date.parse(board.fetchedAt);
  return Number.isNaN(ms) || nowMs - ms > VOC_OPEN_REFRESH_MS;
}

/** 쓰기를 막는 이유(없으면 null). 로그인 필요·설정 필요면 VOC 로 보내 봐야 실패한다 */
export function writeBlockReason(board: VocBoard | null, supported: boolean): string | null {
  if (!supported) return '이 앱 연결에는 VOC 쓰기 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';
  if (!board) return 'VOC 목록을 받는 중입니다.';
  if (board.state === 'login') return 'VOC 에 로그인한 뒤 바꿀 수 있습니다.';
  if (board.state === 'notConfigured') return 'voc-cli 위치를 설정한 뒤 바꿀 수 있습니다.';
  return null;
}

// ── 칸·줄 ──

/** 칸 이름 옆 수 뒤의 요약 조각(있는 것만): 초과(코랄)·임박(앰버)·P1·가장 오래된 경과일 */
export function laneSummaryParts(summary: VocLaneSummary): VocTextPart[] {
  const parts: VocTextPart[] = [];
  if (summary.slaExceeded > 0) parts.push({ key: 'exceeded', text: `초과 ${summary.slaExceeded}`, tone: 'coral' });
  if (summary.slaWarning > 0) parts.push({ key: 'warning', text: `임박 ${summary.slaWarning}`, tone: 'amber' });
  if (summary.p1 > 0) parts.push({ key: 'p1', text: `P1 ${summary.p1}` });
  if (summary.total > 0 && summary.oldestDays !== undefined) parts.push({ key: 'oldest', text: `최장 ${summary.oldestDays}일` });
  return parts;
}

/** 칸 버튼의 읽기 도구 이름 '미배정 3건, SLA 초과 1건, 가장 오래된 건 12일째' */
export function laneAriaLabel(lane: Pick<VocLane, 'label' | 'summary'>): string {
  const s = lane.summary;
  const parts = [`${lane.label} ${s.total}건`];
  if (s.slaExceeded > 0) parts.push(`SLA 초과 ${s.slaExceeded}건`);
  if (s.slaWarning > 0) parts.push(`SLA 임박 ${s.slaWarning}건`);
  if (s.p1 > 0) parts.push(`P1 ${s.p1}건`);
  if (s.total > 0 && s.oldestDays !== undefined) parts.push(`가장 오래된 건 ${ageText(s.oldestDays)}`);
  return parts.join(', ');
}

/** 칸 이름 아래 작은 글자(나 칸이면 내 이름) */
export function laneSubLabel(lane: Pick<VocLane, 'label' | 'member' | 'me'>): string | undefined {
  if (lane.me && lane.member && lane.member.name !== lane.label) return lane.member.name;
  return undefined;
}

/** 처음 고를 칸: 미배정에 건이 있으면 미배정, 아니면 나, 아니면 건이 있는 첫 칸, 아니면 첫 칸 */
export function defaultLaneKey(lanes: readonly VocLane[]): string | null {
  if (lanes.length === 0) return null;
  const unassigned = lanes.find((l) => l.key === 'unassigned');
  if (unassigned && unassigned.tickets.length > 0) return unassigned.key;
  const me = lanes.find((l) => l.me);
  if (me && me.tickets.length > 0) return me.key;
  return (lanes.find((l) => l.tickets.length > 0) ?? lanes[0]).key;
}

/** 티켓 줄 메타 조각: 고객사 · 시스템, 경과, 기한(지났으면 코랄 + '지남') */
export function ticketMetaParts(ticket: VocTicket, today: string): VocTextPart[] {
  const parts: VocTextPart[] = [];
  const where = [ticket.customer, ticket.systemName ?? ticket.system].filter((v): v is string => !!v).join(' · ');
  if (where) parts.push({ key: 'where', text: where });
  parts.push({ key: 'age', text: ageText(ticket.ageDays) });
  const due = vocDue(ticket, today);
  if (due) parts.push({ key: 'due', text: due.short, tone: due.overdue ? 'coral' : undefined });
  return parts;
}

/** 줄 전체의 읽기 도구 풀이 */
export function ticketAriaLabel(ticket: VocTicket, today: string): string {
  const parts = [ticket.number, ticket.title, priorityMark(ticket.priority).label];
  const sla = slaMark(ticket.slaStatus);
  if (sla && ticket.slaStatus !== 'normal') parts.push(sla.text);
  const where = [ticket.customer, ticket.systemName ?? ticket.system].filter(Boolean).join(' · ');
  if (where) parts.push(where);
  parts.push(ageText(ticket.ageDays));
  const due = vocDue(ticket, today);
  if (due) parts.push(due.long);
  return parts.join(', ');
}

/** 요청 내용 접기: 12줄(또는 1,500자) 넘으면 앞부분만 */
export function foldText(
  text: string,
  maxLines = TEXT_FOLD_LINES,
  maxChars = TEXT_FOLD_CHARS,
): { text: string; folded: boolean; hiddenLines: number } {
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    const shown = lines.slice(0, maxLines).join('\n');
    const cut = shown.length > maxChars ? shown.slice(0, maxChars) : shown;
    return { text: cut, folded: true, hiddenLines: lines.length - maxLines };
  }
  if (text.length > maxChars) return { text: text.slice(0, maxChars), folded: true, hiddenLines: 0 };
  return { text, folded: false, hiddenLines: 0 };
}

// ── 선택 ──

/** VOC 화면의 선택(FullView 가 들고 있다 — 할 일 화면에 다녀와도 그대로) */
export interface VocSelection {
  lane: string | null;
  ticketId: number | null;
  /** 고른 티켓이 목록에서 빠지면 이 자리의 티켓을 고른다 */
  index: number;
  /** 바깥에서 고를 때마다 늘려 그 줄로 스크롤한다 */
  reveal: number;
}

export const INITIAL_VOC_SELECTION: VocSelection = { lane: null, ticketId: null, index: 0, reveal: 0 };

/** 번호(VOC-2026-0001, 대소문자 무시) 또는 내부 id(숫자 글자)로 티켓을 찾는다 */
export function findTicket(board: Pick<VocBoard, 'lanes'> | null, ref: string | number): { lane: string; ticket: VocTicket } | null {
  if (!board) return null;
  const text = String(ref).trim();
  if (!text) return null;
  const asId = /^\d+$/.test(text) ? Number(text) : undefined;
  const upper = text.toUpperCase();
  for (const lane of board.lanes) {
    const ticket = lane.tickets.find((t) => (asId !== undefined ? t.id === asId : t.number.toUpperCase() === upper));
    if (ticket) return { lane: lane.key, ticket };
  }
  return null;
}

/**
 * 풀스크린 초점 요청(setMode('full', …))이 VOC 화면인가: 'view:voc' → {}, 'view:voc:<번호 또는 id>' → {ref},
 * 'view:voc-login' → {login: true}(로그인 대화상자를 띄운다 — 명세 §13). 아니면 null(할 일 id 는 'i:'·'c:'·'v:' 로 시작한다).
 */
export function parseVocFocus(taskId: unknown): { ref?: string; login?: true } | null {
  if (typeof taskId !== 'string') return null;
  if (taskId === FOCUS_VOC_VIEW) return {};
  if (taskId === FOCUS_VOC_LOGIN) return { login: true };
  const prefix = `${FOCUS_VOC_VIEW}:`;
  if (!taskId.startsWith(prefix)) return null;
  const ref = taskId.slice(prefix.length).trim();
  return ref && ref.length <= 64 ? { ref } : {};
}

// ── 쓰기(명세 §4·§5) ──

export interface VocPendingAction {
  /** 확인 대화상자를 열 때 만든 UUID(같은 값은 main 이 두 번 실행하지 않는다) */
  actionId: string;
  kind: VocActionKind;
  ticket: VocTicket;
  value: string;
}

/** 새 actionId(UUID v4 — crypto.randomUUID) */
export function makeActionId(): string {
  return makeSendId();
}

/**
 * 확인 대화상자가 보인 그 티켓의 지금 값(vocAction 의 expected). main 은 쓰기 직전 VOC 에서 다시 읽어 이것과 다르면 실행하지 않는다
 * — 그사이 다른 사람이 VOC 웹에서 바꾼 담당·상태·우선순위·예상일을 덮지 않게. 답변은 덮어쓰는 값이 없어 없음
 */
export function expectedOf(ticket: Pick<VocTicket, 'status' | 'assigneeId' | 'priority' | 'ictDue'>, kind: VocActionKind): VocActionExpected | undefined {
  const status = textOf(ticket.status);
  switch (kind) {
    case 'assign':
      return status ? { assigneeId: ticket.assigneeId ?? null, status } : { assigneeId: ticket.assigneeId ?? null };
    case 'ictDue':
      return { ictDue: ticket.ictDue ?? null };
    case 'priority':
      return { priority: textOf(ticket.priority) ?? null };
    case 'status':
      return status ? { status } : undefined;
    case 'reply':
      return undefined;
  }
}

/** 바깥(배지·사이드바)에서 고른 티켓이 보드에 없을 때 알림 — 받지 못한 것과 보드 밖인 것을 가른다 */
export function targetMissingText(board: Pick<VocBoard, 'fetchedAt'>, ref: string): string {
  if (!board.fetchedAt) return `VOC 목록을 아직 받지 못해 ${ref}${objectParticle(ref)} 찾을 수 없습니다.`;
  return `보드에 ${ref}${subjectParticle(ref)} 없습니다. 진행 중이 아니거나, 팀 밖 사람이 담당이거나, 팀 시스템 밖의 미배정 티켓입니다.`;
}

export interface VocAssignOption {
  id: number;
  label: string;
}

/** 담당 지정 선택지: 보드의 나·팀원(칸 순서), 지금 담당은 뺀다 */
export function assignOptions(board: Pick<VocBoard, 'lanes' | 'me'> | null, ticket: Pick<VocTicket, 'assigneeId'>): VocAssignOption[] {
  if (!board) return [];
  const out: VocAssignOption[] = [];
  const seen = new Set<number>();
  for (const lane of board.lanes) {
    const m = lane.member;
    if (!m || seen.has(m.id) || m.id === ticket.assigneeId) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: lane.me || board.me?.id === m.id ? `나(${m.name})` : m.name });
  }
  return out;
}

/** 보드의 사람들(칸 순서) — 확인 대화상자가 이름을 찾는다 */
export function boardMembers(board: Pick<VocBoard, 'lanes' | 'me'> | null): VocMember[] {
  if (!board) return [];
  const out: VocMember[] = [];
  const seen = new Set<number>();
  for (const m of [...board.lanes.map((l) => l.member), board.me]) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export const ACTION_LABEL: Record<VocActionKind, string> = {
  assign: '담당 지정',
  ictDue: 'ICT 예상완료일 변경',
  priority: '우선순위 변경',
  status: '상태 변경',
  reply: '답변 등록',
};

export interface VocConfirmContext {
  members: readonly VocMember[];
  me?: VocMember;
  today: string;
}

export interface VocConfirmSummary {
  kind: VocActionKind;
  title: string;
  /** 'VOC-2026-0001 제목' */
  subject: string;
  /** 무엇을 하는지 한 문장(명세 §4 표의 문구) */
  lead: string;
  /** 덧붙여 알릴 것 */
  lines: string[];
  /** 답변 앞 몇 줄(reply) */
  preview?: { lines: string[]; more: number };
  confirmText: string;
}

function personName(id: number, ctx: VocConfirmContext): { full: string; short: string } {
  const m = ctx.members.find((x) => x.id === id);
  if (!m) return { full: `사용자 ${id}`, short: `사용자 ${id}` };
  if (ctx.me && ctx.me.id === m.id) return { full: `나(${m.name})`, short: m.name };
  return { full: m.name, short: m.name };
}

/** 확인 대화상자 문구(명세 §4 표·§5) */
export function vocConfirm(pending: VocPendingAction, ctx: VocConfirmContext): VocConfirmSummary {
  const { ticket, value, kind } = pending;
  const num = ticket.number;
  const subject = `${num} ${ticket.title}`;
  switch (kind) {
    case 'assign': {
      const who = personName(Number(value), ctx);
      const lines = [`${who.short}에게 VOC 배정 메일이 갑니다(본인 지정도).`];
      lines.push(ticket.status === 'new' ? '상태 new → assigned' : `상태는 그대로입니다(${vocStatusText(ticket.status)}).`);
      if (ticket.assigneeName) lines.push(`지금 담당: ${ticket.assigneeName}`);
      return {
        kind,
        title: '담당을 지정할까요?',
        subject,
        lead: `${num}${objectParticle(num)} ${who.full}에게 지정합니다.`,
        lines,
        confirmText: '지정',
      };
    }
    case 'ictDue': {
      const now = ticket.ictDue ? formatSlash(ticket.ictDue) : '없음';
      const lines = [`지금 ICT 예상완료일: ${now}`, ticket.customerDue ? `고객 희망일: ${formatSlash(ticket.customerDue)}` : '고객 희망일: 없음'];
      if (value === '') {
        return { kind, title: 'ICT 예상완료일을 지울까요?', subject, lead: 'ICT 예상완료일을 지웁니다(고객 희망일은 그대로).', lines, confirmText: '지우기' };
      }
      const md = formatSlash(value);
      return {
        kind,
        title: 'ICT 예상완료일을 바꿀까요?',
        subject,
        lead: `ICT 예상완료일을 ${md}${directionParticle(md)} 바꿉니다(고객 희망일은 그대로).`,
        lines,
        confirmText: '바꾸기',
      };
    }
    case 'priority': {
      const now = textOf(ticket.priority) ?? '없음';
      return {
        kind,
        title: '우선순위를 바꿀까요?',
        subject,
        lead: `우선순위 ${now} → ${value} — SLA 목표가 바뀝니다.`,
        lines: [],
        confirmText: '바꾸기',
      };
    }
    case 'status': {
      const next = vocStatusText(value);
      return {
        kind,
        title: 'VOC 상태를 바꿀까요?',
        subject,
        lead: `${num}의 상태를 ${next}${directionParticle(next)} 바꿉니다.`,
        lines: [`지금 상태: ${vocStatusText(ticket.status)}`, '해결·완료는 작업시간을 먼저 적어야 해서 VOC 웹에서 합니다.'],
        confirmText: '바꾸기',
      };
    }
    case 'reply':
      return {
        kind,
        title: 'VOC 에 답변을 등록할까요?',
        subject,
        lead: `${num}에 답변을 등록합니다. VOC 쪽 알림·메일은 나가지 않지만 고객 포털에서 보일 수 있습니다.`,
        lines: [],
        preview: previewLines(value),
        confirmText: '등록',
      };
  }
}

export interface VocActionNotice {
  id: number;
  tone: 'ok' | 'error';
  title: string;
  lines: string[];
  ticketId: number;
  kind: VocActionKind;
}

/** 쓰기 결과 알림. 실패는 서버 문장을 그대로 보인다(명세 §1 표) */
export function actionNotice(result: VocActionResult | null | undefined, pending: VocPendingAction, id: number): VocActionNotice {
  const base = { id, ticketId: pending.ticket.id, kind: pending.kind };
  const num = pending.ticket.number;
  const message = textOf(result?.message);
  if (result && result.ok === true) {
    return { ...base, tone: 'ok', title: message ?? `${num} ${ACTION_LABEL[pending.kind]}을 마쳤습니다.`, lines: [] };
  }
  return {
    ...base,
    tone: 'error',
    title: `${num} ${ACTION_LABEL[pending.kind]}에 실패했습니다.`,
    lines: [message ?? '이유가 전해지지 않았습니다. 잠시 뒤 다시 해 보세요.'],
  };
}

/** 호출 자체가 실패했을 때(앱 연결·입력 형식 오류 등) */
export function actionFailure(message: string, pending: VocPendingAction, id: number): VocActionNotice {
  return actionNotice({ ok: false, message }, pending, id);
}

// ── 설정(명세 §7) ──

/** 설정 대화상자의 입력 값(글자 칸은 글자로 들고 있다) */
export interface VocSettingsDraft {
  /** '' = whoami 이메일로 찾기 */
  myId: string;
  memberIds: number[];
  systems: string[];
  showAllUnassigned: boolean;
  pollMinutes: string;
  /** VOC 서버 주소('' = 기본 주소) */
  apiUrl: string;
  /** 화면에 칸은 없다 — 저장할 때 지우지 않게 들고만 있는다(voc-cli 를 쓸 때만 의미가 있다) */
  jarPath: string;
}

/** 설정 화면에 보여 줄 기본 VOC 서버 주소(main api.ts VOC_DEFAULT_API_URL 과 같다) */
export const DEFAULT_VOC_API_URL = 'https://voc.acme.test:11300';

export function settingsDraftOf(s: VocSettings): VocSettingsDraft {
  return {
    myId: s.myId !== undefined ? String(s.myId) : '',
    memberIds: [...s.memberIds],
    systems: [...s.systems],
    showAllUnassigned: s.showAllUnassigned,
    pollMinutes: String(s.pollMinutes),
    apiUrl: s.apiUrl ?? '',
    jarPath: s.jarPath ?? '',
  };
}

/** 입력 값 → 저장할 설정(검사는 vocSettingsProblem) */
export function settingsFromDraft(d: VocSettingsDraft): VocSettings {
  const s: VocSettings = {
    memberIds: [...d.memberIds],
    systems: [...d.systems],
    showAllUnassigned: d.showAllUnassigned,
    pollMinutes: Number(d.pollMinutes.trim()),
  };
  const myId = positiveInt(Number(d.myId));
  if (d.myId.trim() !== '' && myId !== undefined) s.myId = myId;
  // 기본 주소와 같으면 적지 않는다(기본이 바뀌면 따라가게). 모양이 틀린 값은 vocSettingsProblem 이 먼저 막는다 — 그래도 오면 main 이 거른다
  const rawApiUrl = d.apiUrl.trim();
  const apiUrl = rawApiUrl ? (vocApiUrlOf(rawApiUrl) ?? rawApiUrl.replace(/\/+$/, '')) : '';
  if (apiUrl && apiUrl !== DEFAULT_VOC_API_URL) s.apiUrl = apiUrl;
  const jar = d.jarPath.trim();
  if (jar) s.jarPath = jar;
  return s;
}

/**
 * VOC 서버 주소 모양: https://호스트[:포트] (경로·계정·쿼리 없이) — main api.ts normalizeVocApiUrl 과 같은 기준.
 * http 는 이 PC(localhost·127.0.0.1·[::1])에만 — 비밀번호·토큰이 평문으로 나가지 않게.
 * 맞으면 `프로토콜://호스트[:포트]`(끝 / 없이, 호스트 소문자, 기본 포트 생략), 아니면 null
 */
function vocApiUrlOf(v: string): string | null {
  const s = v.trim().replace(/\/+$/, '');
  if (s.length === 0 || s.length > 200) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') return null;
  return `${u.protocol}//${u.host}`;
}

/** Windows 절대경로(C:\… 또는 \\서버\…) */
function isAbsoluteWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

/** 설정 입력 문제(없으면 null) */
export function vocSettingsProblem(d: VocSettingsDraft): string | null {
  const { members, systems, pollMin, pollMax } = VOC_SETTINGS_LIMITS;
  if (d.memberIds.length > members) return `팀원은 ${members}명까지 고를 수 있습니다.`;
  if (d.systems.length > systems) return `팀 시스템은 ${systems}개까지 고를 수 있습니다.`;
  const poll = d.pollMinutes.trim();
  const n = Number(poll);
  if (!/^\d+$/.test(poll) || n < pollMin || n > pollMax) return `받는 주기는 ${pollMin}~${pollMax}분 사이의 정수로 적어 주세요.`;
  const apiUrl = d.apiUrl.trim();
  if (apiUrl && vocApiUrlOf(apiUrl) === null) return 'VOC 서버 주소는 https://호스트:포트 모양으로 적어 주세요(http 는 이 PC 주소만, 비워 두면 기본 주소).';
  const jar = d.jarPath.trim();
  if (jar && (!isAbsoluteWindowsPath(jar) || !/\.jar$/i.test(jar))) {
    return 'jar 위치는 .jar 로 끝나는 절대경로로 적어 주세요(비워 두면 기본 위치).';
  }
  return null;
}

export function sameDraft(a: VocSettingsDraft, b: VocSettingsDraft): boolean {
  return (
    a.myId === b.myId &&
    a.showAllUnassigned === b.showAllUnassigned &&
    a.pollMinutes.trim() === b.pollMinutes.trim() &&
    a.apiUrl.trim() === b.apiUrl.trim() &&
    a.jarPath.trim() === b.jarPath.trim() &&
    a.memberIds.length === b.memberIds.length &&
    a.memberIds.every((id, i) => b.memberIds[i] === id) &&
    a.systems.length === b.systems.length &&
    a.systems.every((c, i) => b.systems[i] === c)
  );
}

/** 목록에 넣거나 뺀다(넣으면 끝에 — 칸 순서가 고른 순서다) */
export function toggleIn<T>(list: readonly T[], item: T, on: boolean): T[] {
  const has = list.includes(item);
  if (on) return has ? [...list] : [...list, item];
  return list.filter((x) => x !== item);
}

export const NO_DEPARTMENT = '부서 없음';

export interface MemberGroup {
  department: string;
  members: VocMember[];
}

/** 팀원 체크 목록: 부서별로 묶는다(내 부서 먼저, 부서 없음은 맨 뒤, 안에서는 이름순) */
export function groupMembers(users: readonly VocMember[], myDepartment?: string): MemberGroup[] {
  const map = new Map<string, VocMember[]>();
  for (const u of users) {
    const dept = u.department ?? NO_DEPARTMENT;
    const list = map.get(dept);
    if (list) list.push(u);
    else map.set(dept, [u]);
  }
  const rank = (dept: string): number => (dept === myDepartment ? 0 : dept === NO_DEPARTMENT ? 2 : 1);
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, 'ko'))
    .map(([department, members]) => ({
      department,
      members: [...members].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id - b.id),
    }));
}

/** '나와 같은 부서' 사람들(나 맨 앞) — 팀원을 비워 두면 main 이 쓰는 기본값과 같은 모양 */
export function sameDepartmentIds(users: readonly VocMember[], me: VocMember | undefined): number[] {
  if (!me) return [];
  const dept = users.find((u) => u.id === me.id)?.department ?? me.department;
  if (!dept) return [me.id];
  const ids = users.filter((u) => u.department === dept && u.id !== me.id).map((u) => u.id);
  return [me.id, ...ids];
}

/** 시스템 체크 목록: 받은 코드 + (코드 목록에 없어도) 이미 고른 코드 */
export function systemChoices(codes: readonly VocCode[], selected: readonly string[]): VocCode[] {
  const out = [...codes];
  const known = new Set(codes.map((c) => c.code));
  for (const code of selected) if (!known.has(code)) out.push({ code, name: code });
  return out;
}

// ── 앱 안 로그인(명세 §13) ──

export interface VocLoginProblem {
  /** 고칠 칸(초점을 옮긴다) */
  field: 'id' | 'password';
  message: string;
}

/**
 * 로그인 대화상자에서 보내기 전 검사(main 도 같은 규칙으로 다시 본다). 아이디는 앞뒤 공백을 걷고 본다. 없으면 null.
 * 문장에는 입력한 값을 넣지 않는다
 */
export function vocLoginProblem(loginId: string, password: string): VocLoginProblem | null {
  const idProblem = vocLoginIdProblem(loginId.trim());
  if (idProblem) return { field: 'id', message: idProblem };
  const passwordProblem = vocPasswordProblem(password);
  if (passwordProblem) return { field: 'password', message: passwordProblem };
  return null;
}

/** 로그인이 필요한 보드인가(띠·설정·V3a·V3b 의 [로그인]을 보인다) */
export function needsVocLogin(board: Pick<VocBoard, 'state'> | null | undefined): boolean {
  return board?.state === 'login';
}

/** 찾기 칸: 이름·부서·이메일·코드에 글자가 들어 있는가(대소문자 무시) */
export function matchesFilter(filter: string, ...fields: Array<string | undefined>): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return fields.some((x) => !!x && x.toLowerCase().includes(f));
}
