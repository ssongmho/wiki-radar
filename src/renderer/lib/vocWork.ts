// V4(2.6단계 명세 §14) 화면 값: 첨부·작업시간·메일 기록 다듬기, 해결·메일 대화상자 검사·확인 문구. React 를 모르는 순수 함수만.
// 첨부 이름·메일 제목 등은 서버 값(데이터)이다 — 글자로만 보이고 링크·HTML 로 해석하지 않는다.
import type { VocAttachment, VocEmailLog, VocReply, VocWorkKind, VocWorkLog, VocWorkResult } from '../../shared/types';
import { addressOf, isValidAddress, splitAddressList } from '../../shared/reply';
import { VOC_EMAIL_RECIPIENTS_MAX, VOC_WORKLOG_NOTE_MAX, vocFileKind, vocHoursProblem, vocHoursText, type VocFileKindName } from '../../shared/voc';
import { numberOf, textOf } from './tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  const n = numberOf(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

// ── 다듬기(main 이 보낸 값이 조금 달라도 화면이 깨지지 않게) ──

export function normalizeAttachment(raw: unknown): VocAttachment | null {
  if (!isRecord(raw)) return null;
  const id = positiveInt(raw.id);
  const fileName = textOf(raw.fileName);
  if (id === undefined || !fileName) return null;
  const a: VocAttachment = { id, fileName };
  const size = numberOf(raw.fileSize);
  if (size !== undefined && size >= 0) a.fileSize = size;
  const at = textOf(raw.uploadedAt);
  if (at) a.uploadedAt = at;
  const replyId = positiveInt(raw.replyId);
  if (replyId !== undefined) a.replyId = replyId;
  const author = textOf(raw.replyAuthor);
  if (author) a.replyAuthor = author;
  return a;
}

export function normalizeAttachments(raw: unknown): VocAttachment[] {
  return (Array.isArray(raw) ? raw : []).map(normalizeAttachment).filter((a): a is VocAttachment => a !== null);
}

export function normalizeEmailList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).map((x) => textOf(x)).filter((x): x is string => !!x);
}

export function normalizeWorkLogs(raw: unknown): VocWorkLog[] {
  const out: VocWorkLog[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const id = positiveInt(item.id);
    const workDate = textOf(item.workDate);
    const hours = numberOf(item.hours);
    if (id === undefined || !workDate || hours === undefined) continue;
    const w: VocWorkLog = { id, workDate, hours };
    const userId = positiveInt(item.userId);
    if (userId !== undefined) w.userId = userId;
    const userName = textOf(item.userName);
    if (userName) w.userName = userName;
    const note = textOf(item.note);
    if (note) w.note = note;
    const createdAt = textOf(item.createdAt);
    if (createdAt) w.createdAt = createdAt;
    out.push(w);
  }
  return out;
}

export function normalizeEmailLogs(raw: unknown): VocEmailLog[] {
  const out: VocEmailLog[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item)) continue;
    const id = positiveInt(item.id);
    if (id === undefined) continue;
    const log: VocEmailLog = { id, to: normalizeEmailList(item.to), cc: normalizeEmailList(item.cc) };
    for (const key of ['sentByName', 'subject', 'status', 'emailType', 'sentAt'] as const) {
      const v = textOf(item[key]);
      if (v) log[key] = v;
    }
    out.push(log);
  }
  return out;
}

export function normalizeWorkResult(raw: unknown): VocWorkResult {
  if (!isRecord(raw)) return { ok: false, message: '결과 모양이 맞지 않습니다.' };
  const result: VocWorkResult = { ok: raw.ok === true, message: textOf(raw.message) ?? '' };
  if (Array.isArray(raw.workLogs)) result.workLogs = normalizeWorkLogs(raw.workLogs);
  if (Array.isArray(raw.emailLogs)) result.emailLogs = normalizeEmailLogs(raw.emailLogs);
  if (raw.done === true) result.done = true;
  return result;
}

// ── 표시 ──

/** 바이트 → '1.2MB'·'34KB'·'512B' */
export function fileSizeText(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '크기 모름';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 첨부 처리 방식(shared 판정 그대로 — main 도 같은 규칙으로 다시 본다) */
export function attachmentKind(a: Pick<VocAttachment, 'fileName' | 'fileSize'>): VocFileKindName {
  return vocFileKind(a.fileName, a.fileSize);
}

/** 첨부 출처 '요청' · '답변 · 작성자' */
export function attachmentSource(a: Pick<VocAttachment, 'replyId' | 'replyAuthor'>): string {
  if (a.replyId === undefined) return '요청';
  return a.replyAuthor ? `답변 · ${a.replyAuthor}` : '답변';
}

/** 작업시간 합계(시간, 소수 둘째 자리까지) */
export function workTotal(logs: readonly VocWorkLog[]): number {
  return Math.round(logs.reduce((s, w) => s + (Number.isFinite(w.hours) ? w.hours : 0), 0) * 100) / 100;
}

export { vocHoursText };

/** 메일 기록 종류 이름 */
export function emailTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'resolved':
      return '해결 안내';
    case 'progress':
      return '진행 안내';
    case 'assignment':
      return '배정 안내';
    default:
      return type ?? '메일';
  }
}

// ── 입력 검사 ──

export interface WorklogDraft {
  /** select 값('' = 고르지 않음) */
  hours: string;
  date: string;
  note: string;
}

/** 작업시간 입력 검사. 문제가 있으면 그 문장(CP949 는 main 이 한 번 더 본다) */
export function worklogDraftProblem(d: WorklogDraft, today: string): string | null {
  if (d.hours === '') return '작업시간을 고르세요.';
  const hp = vocHoursProblem(Number(d.hours));
  if (hp) return hp;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return '작업일을 고르세요.';
  if (d.date > today) return '작업일은 오늘 이후로 적을 수 없습니다.';
  if (/[\u0000-\u001f\u007f]/.test(d.note)) return '메모는 한 줄로 적어 주세요.';
  if ([...d.note].length > VOC_WORKLOG_NOTE_MAX) return `메모는 ${VOC_WORKLOG_NOTE_MAX}자까지입니다.`;
  return null;
}

/** 입력 → main 으로 보낼 값 */
export function worklogOf(d: WorklogDraft): { hours: number; date: string; note: string } {
  return { hours: Number(d.hours), date: d.date, note: d.note.trim() };
}

/**
 * 받는 사람·참조 칸(쉼표·세미콜론·줄바꿈으로 나눔) → 주소 목록. '이름 <주소>' 는 주소만 남긴다.
 * 형식이 틀린 것이 있으면 problem
 */
export function parseRecipients(text: string, what: string): { list: string[]; problem: string | null } {
  const list: string[] = [];
  for (const item of splitAddressList(text)) {
    const addr = addressOf(item);
    if (!addr || !isValidAddress(addr)) return { list, problem: `${what}의 주소 형식이 아닙니다: ${item}` };
    list.push(addr);
  }
  if (list.length > VOC_EMAIL_RECIPIENTS_MAX) return { list, problem: `${what}은 ${VOC_EMAIL_RECIPIENTS_MAX}명까지입니다.` };
  return { list, problem: null };
}

export interface EmailDraftCheck {
  to: string[];
  cc: string[];
  problem: string | null;
}

/** 고객 메일 입력 검사: 받는 사람 1명 이상·형식·겹침, 답변이 있으면 하나 이상 골라야 한다(비우면 VOC 가 모든 답변을 넣는다) */
export function emailDraftCheck(toText: string, ccText: string, replyCount: number, chosen: number): EmailDraftCheck {
  const to = parseRecipients(toText, '받는 사람');
  if (to.problem) return { to: to.list, cc: [], problem: to.problem };
  if (to.list.length === 0) return { to: [], cc: [], problem: '받는 사람을 적어 주세요.' };
  const cc = parseRecipients(ccText, '참조');
  if (cc.problem) return { to: to.list, cc: cc.list, problem: cc.problem };
  const seen = new Set<string>();
  for (const a of [...to.list, ...cc.list]) {
    const k = a.toLowerCase();
    if (seen.has(k)) return { to: to.list, cc: cc.list, problem: `같은 주소가 두 번 있습니다: ${a}` };
    seen.add(k);
  }
  if (replyCount > 0 && chosen === 0) return { to: to.list, cc: cc.list, problem: '메일에 담을 답변을 하나 이상 고르세요.' };
  return { to: to.list, cc: cc.list, problem: null };
}

/** 메일에 담을 답변(작성 순) — 고른 id 만 */
export function chosenReplies(replies: readonly VocReply[], chosen: ReadonlySet<number>): VocReply[] {
  return replies.filter((r) => chosen.has(r.id));
}

// ── 결과 알림 ──

export interface VocWorkNotice {
  id: number;
  tone: 'ok' | 'error';
  title: string;
  lines: string[];
  ticketId: number;
  kind: VocWorkKind;
  /** 해결·완료 뒤 [재오픈] — 그 티켓은 보드에서 빠졌다 */
  reopen?: { ticketId: number; number: string; status: 'resolved' | 'closed' };
}

export const WORK_LABEL: Record<VocWorkKind, string> = {
  worklogAdd: '작업시간 입력',
  worklogDelete: '작업시간 삭제',
  resolve: '해결 처리',
  close: '완료 처리',
  reopen: '재오픈',
  email: '고객 메일',
};

/** 결과 → 알림. 실패는 서버 문장을 그대로 */
export function workNotice(result: VocWorkResult | null, kind: VocWorkKind, ticket: { id: number; number: string }, id: number): VocWorkNotice {
  const base = { id, ticketId: ticket.id, kind };
  if (result && result.ok) {
    const notice: VocWorkNotice = { ...base, tone: 'ok', title: result.message || `${ticket.number} ${WORK_LABEL[kind]}을 마쳤습니다.`, lines: [] };
    if (result.done && (kind === 'resolve' || kind === 'close')) {
      notice.reopen = { ticketId: ticket.id, number: ticket.number, status: kind === 'resolve' ? 'resolved' : 'closed' };
      notice.lines.push('보드에서 빠졌습니다. 잘못 처리했으면 [재오픈]으로 되돌릴 수 있습니다.');
    }
    return notice;
  }
  return {
    ...base,
    tone: 'error',
    title: `${ticket.number} ${WORK_LABEL[kind]}에 실패했습니다.`,
    lines: [result?.message || '이유가 전해지지 않았습니다. 잠시 뒤 다시 해 보세요.'],
  };
}
