// 메일함 화면(2.10단계 명세 §8·§9) — 시각 표기·칩·내비/사이드바 표시·키보드 판정·선택 다시 잡기·응답 다듬기.
// React 를 모르는 순수 함수만 둔다. 메일 본문·제목은 데이터다 — 여기서는 글자로만 다루고 HTML 로 해석하지 않는다.
import { FEATURES } from '../../shared/edition';
import { MAIL_KEY_RE, MAIL_THREAD_ID_RE } from '../../shared/mailThread';
import { formatMailDate } from './date';
import type {
  MailFilter,
  MailMessage,
  MailThreadDetail,
  MailThreadMail,
  MailThreadPage,
  MailThreadRow,
  MailboxState,
  MailboxSummary,
  QueueItem,
} from '../../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ── 상수 ──

/** 한 번에 받는 목록 줄 수(main 한도와 같다 — §12) */
export const MAIL_PAGE_SIZE = 200;
/** 검색 입력 뒤 이만큼 멈추면 질의한다(§8-2) */
export const MAIL_SEARCH_DELAY_MS = 300;
/** 읽기 칸에 이만큼 넘게 머문 메일만 읽음(§3-2) */
export const MAIL_READ_DELAY_MS = 1000;

export const MAIL_FILTERS: readonly { key: MailFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'unread', label: '미확인' },
  { key: 'replyNeeded', label: '회신 필요' },
  { key: 'archived', label: '처리함' },
];

/** 분석 자리(범위 밖 — 가짜 결과를 보이지 않는다, §0·§8-2) */
export const MAIL_ANALYSIS_OFF = '분석은 로컬 LLM 연결 뒤';

/** 피싱 의심 띠(§6-2) */
export const MAIL_SUSPICIOUS_TEXT = '피싱 의심 — 링크·첨부를 열지 마세요';

/** 메일함 상태별 이유(main 이 보낸 problem 이 없을 때) */
const STATE_REASON: Record<Exclude<MailboxState, 'ready' | 'indexing'>, string> = {
  noWiki: '개인 위키가 없어 메일을 읽을 수 없습니다',
  noMailDir: '아직 받은 메일이 없습니다 — 설정 › 메일 받기에서 계정을 넣으면 Radar 가 메일을 받아 옵니다',
  error: '메일함 색인을 만들지 못했습니다',
};

// ── 시각 표기 ──

const ISO_HEAD_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/** 'YYYY-MM-DD' 하루 앞 */
export function prevYmd(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 메일 date(수집기가 적은 KST ISO — 적힌 벽시계 그대로 읽는다)의 날짜·시각 조각. 알아볼 수 없으면 null
 */
export function mailDateParts(iso: unknown): { ymd: string; month: number; day: number; hhmm?: string } | null {
  if (typeof iso !== 'string') return null;
  const m = ISO_HEAD_RE.exec(iso.trim());
  if (!m) return null;
  const out: { ymd: string; month: number; day: number; hhmm?: string } = {
    ymd: `${m[1]}-${m[2]}-${m[3]}`,
    month: Number(m[2]),
    day: Number(m[3]),
  };
  if (m[4] !== undefined) out.hhmm = `${m[4]}:${m[5]}`;
  return out;
}

/** 목록 시각: 오늘은 HH:MM, 어제는 '어제', 그 전은 M/D(§8-2). 모르면 '' */
export function mailTimeLabel(iso: unknown, today: string): string {
  const p = mailDateParts(iso);
  if (!p) return '';
  if (p.ymd === today) return p.hhmm ?? '오늘';
  if (p.ymd === prevYmd(today)) return '어제';
  const year = Number(p.ymd.slice(0, 4));
  const thisYear = Number(today.slice(0, 4));
  return year && thisYear && year !== thisYear ? `${year}/${p.month}/${p.day}` : `${p.month}/${p.day}`;
}

/** 읽기 칸·스레드 줄 날짜: '9월 22일 14:42'(해가 다르면 해 붙임) */
export function mailDateText(iso: unknown, today: string): string {
  const p = mailDateParts(iso);
  if (!p) return typeof iso === 'string' ? iso : '';
  const year = Number(p.ymd.slice(0, 4));
  const head = year !== Number(today.slice(0, 4)) ? `${year}년 ` : '';
  return `${head}${p.month}월 ${p.day}일${p.hhmm ? ` ${p.hhmm}` : ''}`;
}

/** 머리 줄 'HH:MM'(가장 최근 메일 시각 — 오늘이 아니면 M/D HH:MM) */
export function latestText(iso: unknown, today: string): string {
  const p = mailDateParts(iso);
  if (!p) return '';
  if (p.ymd === today) return p.hhmm ?? '오늘';
  return `${p.month}/${p.day}${p.hhmm ? ` ${p.hhmm}` : ''}`;
}

/** 바이트 → '1.2KB' 같은 짧은 표기 */
export function sizeText(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}MB`;
}

// ── 줄 표시 ──

/** 목록 줄의 보낸이: 참여자(나 제외) + 내가 있으면 '나, …' */
export function participantsText(row: Pick<MailThreadRow, 'participants' | 'includesMe'>): string {
  const names = row.participants.filter((n) => n.trim() !== '');
  if (row.includesMe) return names.length > 0 ? `나, ${names.join(', ')}` : '나';
  return names.length > 0 ? names.join(', ') : '(보낸이 없음)';
}

export type MailChipKind = 'reply' | 'task' | 'voc' | 'wiki' | 'replied' | 'attach' | 'suspicious' | 'ai-reply';

export interface MailChip {
  kind: MailChipKind;
  label: string;
  tone: 'amber' | 'coral' | 'cyan' | 'plain';
  /** 칩의 상태(data-state — 위키 반영 queued·done) */
  state?: string;
}

/** 줄 칩(§8-2): 회신 필요 · 할 일 · VOC-… · 회신함/회신 추정 · 첨부 · 피싱 의심 */
export function rowChips(row: MailThreadRow): MailChip[] {
  const chips: MailChip[] = [];
  if (row.suspicious) chips.push({ kind: 'suspicious', label: '피싱 의심', tone: 'coral' });
  if (row.replyNeeded && !row.archived) chips.push({ kind: 'reply', label: '회신 필요', tone: 'amber' });
  // 2.16: 로컬 LLM 추정 — 사람이 켠 표시와 구별(물음표·중립 색)
  else if (row.aiReply && !row.archived) chips.push({ kind: 'ai-reply', label: '회신 필요?', tone: 'plain' });
  if (row.links.tasks > 0) chips.push({ kind: 'task', label: '할 일', tone: 'plain' });
  if (row.links.voc) chips.push({ kind: 'voc', label: row.links.voc, tone: 'cyan' });
  // 2.14 §8-3: 위키 반영 대기(시안) · 위키 반영됨(중립)
  if (row.links.wiki === 'queued') chips.push({ kind: 'wiki', label: '위키 반영 대기', tone: 'cyan', state: 'queued' });
  else if (row.links.wiki === 'done') chips.push({ kind: 'wiki', label: '위키 반영됨', tone: 'plain', state: 'done' });
  if (row.links.replied === 'sent') chips.push({ kind: 'replied', label: '회신함', tone: 'plain' });
  else if (row.links.replied === 'guess') chips.push({ kind: 'replied', label: '회신 추정', tone: 'plain' });
  if (row.hasAttachments) chips.push({ kind: 'attach', label: '첨부', tone: 'plain' });
  return chips;
}

// ── 내비·사이드바 ──

export interface NavMailInfo {
  /** 미확인 스레드 수 */
  count: number;
  replyNeeded: number;
  /** 쓸 수 없는 이유(있으면 흐리게) */
  unavailable?: string;
  /** 수 자리에 수 대신 보일 글자(위키 없음·메일 없음·읽는 중) */
  note?: string;
}

/** 메일함 요약 → 내비 [메일] 표시(§8-1). 요약이 없으면(아직 못 받음) 0 */
export function navMailInfo(summary: MailboxSummary | null): NavMailInfo {
  if (!summary) return { count: 0, replyNeeded: 0 };
  const count = summary.unread;
  const replyNeeded = summary.replyNeeded;
  switch (summary.state) {
    case 'noWiki':
      return { count: 0, replyNeeded: 0, unavailable: summary.problem ?? STATE_REASON.noWiki, note: '위키 없음' };
    case 'noMailDir':
      return { count: 0, replyNeeded: 0, unavailable: summary.problem ?? STATE_REASON.noMailDir, note: '메일 없음' };
    case 'indexing':
      return { count: 0, replyNeeded: 0, note: '읽는 중' };
    default:
      return { count, replyNeeded };
  }
}

/** 메일함을 쓸 수 없는 상태인가(이유 문장) */
export function mailboxUnavailable(summary: MailboxSummary | null): string | null {
  if (!summary) return null;
  if (summary.state === 'noWiki') return summary.problem ?? STATE_REASON.noWiki;
  if (summary.state === 'noMailDir') return summary.problem ?? STATE_REASON.noMailDir;
  return null;
}

export interface SidebarMailRow {
  id: string;
  key: string;
  chip: '회신 필요' | '미확인';
  time: string;
  subject: string;
}

export interface SidebarMailInfo {
  /** 블록을 숨긴다(쓸 수 없음·색인 전) */
  hidden: boolean;
  unread: number;
  replyNeeded: number;
  /** 머리 '최근 HH:MM' */
  latest: string;
  rows: SidebarMailRow[];
  /** 둘 다 0 — '새 메일 없음' 한 줄로 접는다 */
  empty: boolean;
}

/** 사이드바 메일 블록(§9). 제목까지만 — 본문·주소는 넣지 않는다 */
export function sidebarMailInfo(summary: MailboxSummary | null, today: string): SidebarMailInfo {
  const hidden = !summary || (summary.state !== 'ready' && summary.state !== 'error');
  const unread = summary?.unread ?? 0;
  const replyNeeded = summary?.replyNeeded ?? 0;
  const rows: SidebarMailRow[] = (summary?.top ?? []).slice(0, 3).map((r) => ({
    id: r.id,
    key: r.latestKey,
    chip: r.replyNeeded ? '회신 필요' : '미확인',
    time: mailTimeLabel(r.latestDate, today),
    subject: r.subject,
  }));
  return {
    hidden,
    unread,
    replyNeeded,
    latest: latestText(summary?.latestDate, today),
    rows,
    empty: unread === 0 && replyNeeded === 0,
  };
}

// ── 바깥에서 여는 표시 ──

/** 'view:mail' → {}, 'view:mail:<키>' → {key}. 메일함 표시가 아니면 null */
export function parseMailFocus(id: unknown): { key?: string } | null {
  if (typeof id !== 'string') return null;
  if (id === 'view:mail') return {};
  const m = /^view:mail:(.+)$/.exec(id);
  if (!m) return null;
  return MAIL_KEY_RE.test(m[1]) ? { key: m[1] } : {};
}

// ── 선택 ──

/** 메일함 화면 선택(FullView 가 들고 있어 화면을 오가도 그대로 — §8-2) */
export interface MailSelection {
  filter: MailFilter;
  query: string;
  folder: string | null;
  includeMuted: boolean;
  /** 고른 스레드 id(목록이 새로 와도 메일 키로 다시 찾는다) */
  threadId: string | null;
  /** 고른 스레드의 메일 키들(id 가 바뀌어도 다시 찾는다) */
  threadKeys: string[];
  /** 읽기 칸에 보이는 메일 키(스레드 안) */
  mailKey: string | null;
  /** 목록에서 고른 자리(스레드가 빠지면 다음 줄) */
  index: number;
  /** 오른쪽이 읽기 칸인가, 메일함 안의 회신·VOC 등록 화면인가(§8-3) */
  sub: MailSubView;
  /**
   * 바깥(view:mail:<키>)에서 고른 스레드 — 새 질의의 목록이 와서 그 스레드를 찾을 때까지(필요하면 [더 보기]로 더 받아)
   * 「같은 자리」로 다른 스레드를 고르지 않는다
   */
  pin?: boolean;
  /**
   * 고른 스레드가 목록에서 빠져 같은 자리의 다음 스레드가 저절로 보이는 중(「미확인」 필터) — 사람이 고른 것이 아니므로
   * 읽음으로 바꾸지 않는다(1초 읽음이 줄줄이 번지지 않게 — §3-2). 사람이 줄·메일을 고르면 풀린다
   */
  readHold?: boolean;
}

export type MailSubView = 'read' | 'reply' | 'voc';

export const INITIAL_MAIL_SELECTION: MailSelection = {
  filter: 'all',
  query: '',
  folder: null,
  includeMuted: false,
  threadId: null,
  threadKeys: [],
  mailKey: null,
  index: 0,
  sub: 'read',
  pin: false,
  readHold: false,
};

/**
 * 새 목록에서 고른 스레드를 다시 찾는다(§8-2): 같은 id → 같은 메일 키(latestKey 가 고른 스레드의 메일 키 가운데 하나) →
 * 없어졌으면 같은 자리(다음 스레드). 목록이 비면 -1
 */
export function reselectIndex(rows: readonly MailThreadRow[], sel: Pick<MailSelection, 'threadId' | 'threadKeys' | 'index'>): number {
  if (rows.length === 0) return -1;
  if (sel.threadId) {
    const byId = rows.findIndex((r) => r.id === sel.threadId);
    if (byId >= 0) return byId;
  }
  if (sel.threadKeys.length > 0) {
    const keys = new Set(sel.threadKeys);
    const byKey = rows.findIndex((r) => keys.has(r.latestKey));
    if (byKey >= 0) return byKey;
  }
  // 아무것도 고르지 않았으면 고르지 않는다 — 메일함을 열 때 저절로 고르지 않음(소유자 결정 2026-10-19)
  if (!sel.threadId) return -1;
  return Math.min(Math.max(sel.index, 0), rows.length - 1);
}

/** 스레드 안 보일 메일: 고른 키가 있으면 그것, 없으면 가장 최근 받은 메일(내 사본 밖), 없으면 마지막 */
export function pickMail(detail: MailThreadDetail | null, key: string | null): MailThreadMail | null {
  if (!detail || detail.mails.length === 0) return null;
  if (key) {
    const hit = detail.mails.find((m) => m.key === key);
    if (hit) return hit;
  }
  for (let i = detail.mails.length - 1; i >= 0; i--) if (!detail.mails[i].mine) return detail.mails[i];
  return detail.mails[detail.mails.length - 1];
}

/** 스레드 안 이전·다음 메일 키(`[`/`]`) */
export function stepMail(detail: MailThreadDetail | null, key: string | null, delta: -1 | 1): string | null {
  if (!detail || detail.mails.length === 0) return null;
  const i = key ? detail.mails.findIndex((m) => m.key === key) : -1;
  const next = i < 0 ? (delta > 0 ? 0 : detail.mails.length - 1) : i + delta;
  if (next < 0 || next >= detail.mails.length) return null;
  return detail.mails[next].key;
}

// ── 키보드(§8-4) ──

export type MailKeyAction =
  | 'next'
  | 'prev'
  | 'enterReader'
  | 'toList'
  | 'search'
  | 'reply'
  | 'archive'
  | 'replyNeeded'
  | 'unread'
  | 'voc'
  | 'task'
  | 'wiki'
  | 'prevMail'
  | 'nextMail';

export interface MailKeyContext {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** 입력 칸(input·textarea·select·contenteditable) 안 */
  editable: boolean;
  /** 대화상자가 열려 있거나 대화상자 안 */
  inDialog: boolean;
  /** 초점이 목록 안 */
  inList: boolean;
}

/** 키 → 메일함 동작. 동작이 아니면 null */
export function mailKeyAction(ctx: MailKeyContext): MailKeyAction | null {
  if (ctx.inDialog || ctx.altKey || ctx.ctrlKey || ctx.metaKey) return null;
  if (ctx.key === 'Escape') return ctx.editable || ctx.inList ? null : 'toList';
  if (ctx.editable) return null;
  if (ctx.shiftKey && ctx.key.length > 1) return null;
  switch (ctx.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Enter':
    case 'ArrowRight':
      return ctx.inList ? 'enterReader' : null;
    case '/':
      return 'search';
    case '[':
      return 'prevMail';
    case ']':
      return 'nextMail';
  }
  switch (ctx.key.toLowerCase()) {
    case 'r':
      return 'reply';
    case 'e':
      return 'archive';
    case 'm':
      return 'replyNeeded';
    case 'u':
      return 'unread';
    case 'v':
      return FEATURES.voc ? 'voc' : null;
    case 't':
      return 'task';
    case 'w':
      return 'wiki';
  }
  return null;
}

// ── 할 일로(§7-3) ──

export const MAIL_TASK_TITLE_MAX = 200;

/** 제목 기본값 = RE/FW 걷은 메일 제목(대괄호·#·줄바꿈은 빼서 줄 형식을 깨지 않게) */
export function mailTaskTitle(subject: string): string {
  let s = subject;
  let prev: string | null = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/^\s*(?:re|fw|fwd|답장|전달|회신)\s*[:：]\s*/i, '');
  }
  return cleanTaskTitle(s).slice(0, MAIL_TASK_TITLE_MAX);
}

/** 넣을 수 없는 글자(`[`·`]`·`#`·줄바꿈·제어 문자)를 공백으로 바꾸고 공백을 합친다 */
export function cleanTaskTitle(text: string): string {
  return text
    .replace(/[[\]#\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** [할 일로] 입력 문제(없으면 null) — main 이 다시 검사한다 */
export function mailTaskProblem(input: { title: string; pri: string; due: string }): string | null {
  const title = input.title.trim();
  if (title === '') return '제목을 적어 주세요.';
  if (Array.from(title).length > MAIL_TASK_TITLE_MAX) return `제목은 ${MAIL_TASK_TITLE_MAX}자까지입니다.`;
  if (/[[\]#\r\n\u0000-\u001f\u007f]/.test(title)) return '제목에 [ ] # 와 줄바꿈은 넣을 수 없습니다.';
  if (input.pri !== '' && !/^[1-3]$/.test(input.pri)) return '우선순위는 1~3 중에서 고릅니다.';
  if (input.due !== '' && !isCalendarYmd(input.due)) return '기한은 YYYY-MM-DD 달력 날짜여야 합니다.';
  return null;
}

function isCalendarYmd(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// ── 대상(회신·VOC 등록을 할 일과 같은 보관소에서 — §8-3) ──

/** 회신·VOC 작성 칸의 메일 대상 열쇠(할 일 id 와 섞이지 않게 접두어) */
export const MAIL_TARGET_PREFIX = 'mail:';

export function mailTargetKey(path: string): string {
  return `${MAIL_TARGET_PREFIX}${path}`;
}

/** 'mail:<경로>' → 경로. 메일 대상이 아니면 null */
export function mailTargetPath(key: string): string | null {
  return key.startsWith(MAIL_TARGET_PREFIX) ? key.slice(MAIL_TARGET_PREFIX.length) : null;
}

// ── main 응답 다듬기(모양이 틀리면 버리거나 기본값) ──

function normalizeRow(raw: unknown): MailThreadRow | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !MAIL_THREAD_ID_RE.test(raw.id)) return null;
  const links = isRecord(raw.links) ? raw.links : {};
  const row: MailThreadRow = {
    id: raw.id,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    participants: strings(raw.participants),
    includesMe: raw.includesMe === true,
    latestMs: num(raw.latestMs),
    count: Math.max(1, num(raw.count, 1)),
    unread: raw.unread === true,
    replyNeeded: raw.replyNeeded === true,
    archived: raw.archived === true,
    hasAttachments: raw.hasAttachments === true,
    suspicious: raw.suspicious === true,
    muted: raw.muted === true,
    folders: strings(raw.folders),
    latestKey: typeof raw.latestKey === 'string' ? raw.latestKey : '',
    links: { tasks: Math.max(0, num(links.tasks)) },
  };
  const latestDate = str(raw.latestDate);
  if (latestDate) row.latestDate = latestDate;
  const voc = str(links.voc);
  if (voc) row.links.voc = voc;
  if (links.replied === 'sent' || links.replied === 'guess') row.links.replied = links.replied;
  if (links.wiki === 'queued' || links.wiki === 'done') row.links.wiki = links.wiki;
  if (raw.aiReply === true) row.aiReply = true;
  return row;
}

const STATES: readonly MailboxState[] = ['noWiki', 'noMailDir', 'indexing', 'ready', 'error'];

export function normalizeSummary(raw: unknown): MailboxSummary | null {
  if (!isRecord(raw) || !STATES.includes(raw.state as MailboxState)) return null;
  const out: MailboxSummary = {
    state: raw.state as MailboxState,
    total: Math.max(0, num(raw.total)),
    unread: Math.max(0, num(raw.unread)),
    replyNeeded: Math.max(0, num(raw.replyNeeded)),
    revision: num(raw.revision),
    top: Array.isArray(raw.top) ? raw.top.map(normalizeRow).filter((r): r is MailThreadRow => r !== null) : [],
  };
  const problem = str(raw.problem);
  if (problem) out.problem = problem;
  if (isRecord(raw.progress)) out.progress = { done: num(raw.progress.done), total: num(raw.progress.total) };
  const latest = str(raw.latestDate);
  if (latest) out.latestDate = latest;
  const indexed = str(raw.indexedAt);
  if (indexed) out.indexedAt = indexed;
  return out;
}

export function normalizePage(raw: unknown): MailThreadPage {
  const r = isRecord(raw) ? raw : {};
  const counts = isRecord(r.counts) ? r.counts : {};
  return {
    threads: Array.isArray(r.threads) ? r.threads.map(normalizeRow).filter((x): x is MailThreadRow => x !== null) : [],
    total: Math.max(0, num(r.total)),
    counts: {
      all: num(counts.all),
      unread: num(counts.unread),
      replyNeeded: num(counts.replyNeeded),
      archived: num(counts.archived),
    },
    folders: Array.isArray(r.folders)
      ? r.folders
          .filter(isRecord)
          .filter((f) => typeof f.name === 'string')
          .map((f) => ({ name: f.name as string, count: num(f.count), unread: num(f.unread) }))
      : [],
    revision: num(r.revision),
  };
}

/** 메일 한 통 응답(본문은 글자 그대로 둔다 — 화면은 텍스트 노드로만 그린다) */
export function normalizeMessage(raw: unknown): MailMessage | null {
  if (!isRecord(raw) || typeof raw.path !== 'string') return null;
  const msg: MailMessage = {
    path: raw.path,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    from: typeof raw.from === 'string' ? raw.from : '',
    to: strings(raw.to),
    cc: strings(raw.cc),
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    suspicion: strings(raw.suspicion),
    suspicious: raw.suspicious === true,
    body: typeof raw.body === 'string' ? raw.body : '',
    truncated: raw.truncated === true,
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.filter(isRecord).map((a) => {
          const item: MailMessage['attachments'][number] = { name: typeof a.name === 'string' ? a.name : '', blocked: a.blocked === true };
          if (typeof a.size === 'number') item.size = a.size;
          const ct = str(a.contentType);
          if (ct) item.contentType = ct;
          const rel = str(a.rel);
          if (rel && !item.blocked) item.rel = rel;
          return item;
        })
      : [],
    wikiLinks: strings(raw.wikiLinks),
  };
  const key = str(raw.key);
  if (key) msg.key = key;
  const replyTo = str(raw.replyTo);
  if (replyTo) msg.replyTo = replyTo;
  const date = str(raw.date);
  if (date) msg.date = date;
  const messageId = str(raw.messageId);
  if (messageId) msg.messageId = messageId;
  if (raw.hasOriginal === true) msg.hasOriginal = true;
  return msg;
}

/** 머리 줄 '받는이 · 참조 N명' 의 받는이(앞 2명 + 외 N명) */
export function recipientsShort(list: readonly string[]): string {
  const names = list.map((a) => a.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || a);
  if (names.length === 0) return '(받는이 없음)';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} 외 ${names.length - 2}명`;
}

/** 메일 상태 바꾸기 결과 알림 문장(되돌리기 알림 — §8-4 E) */
export function archiveNoticeText(archived: boolean, subject: string): string {
  const s = subject.length > 40 ? `${subject.slice(0, 40)}…` : subject;
  return archived ? `‘${s}’ 를 처리함으로 옮겼습니다.` : `‘${s}’ 를 받은편지함으로 되돌렸습니다.`;
}

// ── 동작 판정(읽기 칸 버튼 — §8-2) ──

/** [할 일로]를 막는 이유. 개인 위키 없음 · 이 메일(또는 스레드)에 이미 할 일이 있음 */
export function mailTaskBlock(args: {
  personalMissing: boolean;
  supported: boolean;
  detail: MailThreadDetail | null;
  mail: MailThreadMail | null;
}): string | null {
  if (!args.supported) return '이 앱 연결에는 [할 일로] 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';
  if (args.personalMissing) return '개인 위키가 없어 할 일을 만들 수 없습니다.';
  const { detail, mail } = args;
  if (!mail) return null;
  if (mail.taskFile) return `이미 할 일이 있습니다(${mail.taskFile} — 메일함에서 만듦).`;
  const linked = detail?.links.tasks ?? [];
  if (linked.length > 0) {
    const t = linked[0];
    return `이미 할 일이 있습니다(${t.title}${linked.length > 1 ? ` 외 ${linked.length - 1}건` : ''}).`;
  }
  return null;
}

/** 이 메일로 만든 VOC 번호(메일 상태 · 방금 만든 것). 없으면 undefined */
export function mailVocDone(mail: MailThreadMail | null, created?: string): string | undefined {
  return mail?.voc ?? created ?? undefined;
}

/** 스레드가 처리함인가(남이 보낸 메일이 모두 처리함 — 내 사본은 세지 않는다, §3-2. main `threadArchivedOf` 와 같게) */
export function threadArchived(detail: MailThreadDetail | null): boolean {
  if (!detail || detail.mails.length === 0) return false;
  const others = detail.mails.filter((m) => !m.mine);
  return (others.length > 0 ? others : detail.mails).every((m) => m.archived);
}

/** 스레드의 메일 키(처리함·읽음은 스레드 단위 — §3-3) */
export function threadKeys(detail: MailThreadDetail | null): string[] {
  return detail ? detail.mails.map((m) => m.key) : [];
}

/** 바깥에서 연 메일(view:mail:<키>)이 보일 필터: 처리함이면 처리함, 노이즈 추정이면 노이즈 포함 */
export function selectionForTarget(detail: MailThreadDetail, key: string): MailSelection {
  const muted = detail.mails.length > 0 && detail.mails.every((m) => m.muted);
  return {
    ...INITIAL_MAIL_SELECTION,
    filter: threadArchived(detail) ? 'archived' : 'all',
    includeMuted: muted,
    threadId: detail.id,
    threadKeys: threadKeys(detail),
    mailKey: detail.mails.some((m) => m.key === key) ? key : null,
    pin: true,
  };
}

/** 읽음으로 바꿀 키(스레드 단위 — §3-3): 그 스레드의 미확인 메일 모두. 보이는 메일이 미확인이 아니면 빈 배열 */
export function threadReadKeys(detail: MailThreadDetail | null, mail: MailThreadMail | null): string[] {
  if (!detail || !mail || !mail.unread) return [];
  const keys = detail.mails.filter((m) => m.unread).map((m) => m.key);
  return keys.includes(mail.key) ? keys : [mail.key, ...keys];
}

/** 목록 질의 열쇠(useMailList 가 받은 쪽이 지금 질의의 것인지 견준다) */
export function mailListKey(q: { filter: MailFilter; folder?: string | null; query?: string; includeMuted?: boolean }): string {
  return JSON.stringify([q.filter, q.folder ?? null, q.query ?? '', q.includeMuted === true]);
}

// ── 위키에 반영(2.14단계 §8) ──

export type MailWikiState = 'none' | 'queued' | 'running' | 'done' | 'skipped';

export const MAIL_WIKI_NOTE_MAX = 4_000;
export const MAIL_WIKI_HINT_MAX = 200;

/** 이 메일의 위키 반영 상태(버튼 data-wiki-state) */
export function mailWikiState(mail: Pick<MailThreadMail, 'wiki'> | null): MailWikiState {
  return mail?.wiki?.state ?? 'none';
}

/**
 * [위키에 반영]을 막는 이유(없으면 null). 옛 preload(기능 없음)는 버튼을 숨기므로 여기서 보지 않는다.
 * 피싱 의심 → 메일함 준비 안 됨 → 개인 위키 없음 순.
 */
export function mailWikiBlock(args: {
  personalMissing: boolean;
  mailboxReady: boolean;
  mail: Pick<MailThreadMail, 'suspicious'> | null;
  suspicious?: boolean;
}): string | null {
  if (args.mail && (args.mail.suspicious || args.suspicious)) return '피싱 의심 메일은 위키에 반영할 수 없습니다';
  if (!args.mailboxReady) return '메일함을 읽는 중입니다 — 끝난 뒤 다시 누르세요';
  if (args.personalMissing) return '개인 위키가 없어 위키에 반영할 수 없습니다';
  return null;
}

/** 버튼 글자: 대기 중이면 「반영 대기 중」, 반영 중이면 「반영 중」 */
export function mailWikiButtonLabel(state: MailWikiState): string {
  if (state === 'queued') return '반영 대기 중';
  if (state === 'running') return '반영 중';
  return '위키에 반영';
}

/** 스레드 안 메일 줄의 작은 글자: 반영 대기 · 반영 중 · 반영됨 M/D · 건너뜀 */
export function threadWikiText(wiki: MailThreadMail['wiki'] | undefined): string {
  if (!wiki) return '';
  if (wiki.state === 'queued') return '반영 대기';
  if (wiki.state === 'running') return '반영 중';
  if (wiki.state === 'skipped') return '건너뜀';
  // 앱이 적은 UTC 시각 → 이 PC 날짜
  const ms = wiki.at ? Date.parse(wiki.at) : Number.NaN;
  if (Number.isNaN(ms)) return '반영됨';
  const d = new Date(ms);
  return `반영됨 ${d.getMonth() + 1}/${d.getDate()}`;
}

/** 범위 안 피싱 의심(스레드에 의심 메일이 섞이면 「스레드 전체」를 막는다 — §8-2) */
export function threadHasSuspicious(detail: MailThreadDetail | null): boolean {
  return !!detail && detail.mails.some((m) => m.suspicious);
}

/**
 * 이 메일을 덮는 대기 중 mail 항목(폼을 열 때 이전 메모로 채운다 — §5): 이 메일 키의 항목,
 * 또는 같은 스레드 메일 키의 스레드 범위 항목. 없으면 undefined
 */
export function mailWikiExisting(items: readonly QueueItem[], detail: MailThreadDetail | null, mail: Pick<MailThreadMail, 'key'> | null): QueueItem | undefined {
  if (!mail) return undefined;
  const threadKeysSet = new Set((detail?.mails ?? []).map((m) => m.key));
  return items.find(
    (x) => x.kind === 'mail' && !!x.mailKey && (x.mailKey === mail.key || (x.scope === 'thread' && threadKeysSet.has(x.mailKey))),
  );
}

/** 앱이 적은 시각(넣은 시각·반영 시각 — UTC ISO)을 이 PC 시간대로 '9월 23일 오전 10:05' */
export function appTimeText(iso: string | undefined, today: string): string {
  return iso ? formatMailDate(iso, { refYear: Number(today.slice(0, 4)) }) : '';
}

/** 회사 밖 안내 한 줄(§8-2) */
export function mailWikiOutsideText(scope: 'mail' | 'thread', count: number): string {
  const what = scope === 'thread' ? `이 스레드 ${count}통의 본문·보낸이·첨부 이름` : '이 메일의 본문·보낸이·첨부 이름';
  return `[위키에 반영]을 누르면 ${what}이 Claude Code(Anthropic)로 보내집니다 — 회사 밖으로 나갑니다.`;
}

/** 중복 안내(§5) */
export function mailWikiDuplicateText(existing: QueueItem, today: string): string {
  const at = appTimeText(existing.createdAt, today);
  const scope = existing.scope === 'thread' ? '스레드' : '이 메일';
  const note = existing.note.trim();
  const memo = note ? `, 메모 '${note.length > 40 ? `${note.slice(0, 40)}…` : note}'` : '';
  return `이 메일은 이미 반영 대기에 있습니다(${at}, 범위 ${scope}${memo}). 새 내용으로 바꿀까요?`;
}

/** 앱 연결에 [위키에 반영]이 있는가 — 옛 preload 면 버튼을 숨긴다(§8-1) */
export function mailWikiSupported(api: { queueMailForWiki?: unknown } | null | undefined): boolean {
  return !!api && typeof api.queueMailForWiki === 'function';
}
