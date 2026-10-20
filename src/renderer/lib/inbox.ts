// 알림함(2.9단계 명세 §8): main 이 준 InboxState 검사, 시각 표기, 종 배지, 사이드바 긴급 띠 문구, 설정 › 알림 입력. 순수 함수만.
// 화면은 수를 스스로 세지 않는다 — unread·unreadUrgent 는 main 이 센 것(§8-3).
import {
  DEFAULT_NOTIFY_SETTINGS,
  NOTIFY_KINDS,
  NOTIFY_KIND_LABEL,
  NOTIFY_MODES,
  QUIET_REASONS,
  QUIET_REASON_LABEL,
  notifySettingsProblem,
  type NotifyProblemField,
} from '../../shared/notify';
import type { InboxState, NotifyItem, NotifyKind, NotifyMode, NotifySettings, QuietReason, SnoozeKind } from '../../shared/types';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const KINDS = new Set<string>(NOTIFY_KINDS);
const TOAST_MODES = new Set(['toast', 'log', 'unsupported']);

function itemOf(raw: unknown): NotifyItem | null {
  if (!isObject(raw)) return null;
  const r = raw;
  if (typeof r.id !== 'string' || typeof r.key !== 'string' || typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
  if (r.grade !== 'urgent' && r.grade !== 'today') return null;
  if (typeof r.title !== 'string' || typeof r.body !== 'string' || typeof r.target !== 'string' || typeof r.createdAt !== 'string') return null;
  return {
    id: r.id,
    key: r.key,
    kind: r.kind as NotifyKind,
    grade: r.grade,
    title: r.title,
    body: r.body,
    target: r.target,
    createdAt: r.createdAt,
    readAt: typeof r.readAt === 'string' ? r.readAt : null,
    toastAt: typeof r.toastAt === 'string' ? r.toastAt : null,
    deferred: r.deferred === true,
    ...snoozeOf(r),
    reminded: r.reminded === true,
  };
}

function snoozeOf(r: Record<string, unknown>): { snoozeUntil: string | null; snooze: SnoozeKind | null } {
  if ((r.snooze === '1h' || r.snooze === 'morning') && typeof r.snoozeUntil === 'string') return { snoozeUntil: r.snoozeUntil, snooze: r.snooze };
  return { snoozeUntil: null, snooze: null };
}

const QUIET_SET = new Set<string>(QUIET_REASONS);

function heldOf(raw: unknown): InboxState['held'] {
  if (!isObject(raw) || typeof raw.reason !== 'string' || !QUIET_SET.has(raw.reason)) return null;
  const reason = raw.reason as QuietReason;
  return {
    reason,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : QUIET_REASON_LABEL[reason],
    count: count(raw.count),
    since: typeof raw.since === 'string' ? raw.since : '',
  };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** main 응답 검사. 모양이 틀리면 null(틀린 항목만 버린다) */
export function normalizeInbox(raw: unknown): InboxState | null {
  if (!isObject(raw) || !Array.isArray(raw.items)) return null;
  const items = raw.items.map(itemOf).filter((i): i is NotifyItem => i !== null);
  return {
    items,
    unread: count(raw.unread),
    unreadUrgent: count(raw.unreadUrgent),
    todayToasts: count(raw.todayToasts),
    dailyLimit: count(raw.dailyLimit) || 6,
    toastMode: typeof raw.toastMode === 'string' && TOAST_MODES.has(raw.toastMode) ? (raw.toastMode as InboxState['toastMode']) : 'toast',
    hideContent: raw.hideContent === true,
    snoozed: count(raw.snoozed),
    held: heldOf(raw.held),
    ...(typeof raw.nextMorningAt === 'string' && raw.nextMorningAt !== '' ? { nextMorningAt: raw.nextMorningAt } : {}),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO 시각의 로컬 YYYY-MM-DD(시각이 아니면 '') */
export function localYmdOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 항목 시각: 오늘이면 "14:02", 아니면 "9/22 14:02"(로컬). 시각이 아니면 '' */
export function formatInboxTime(iso: string, today: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ymd = localYmdOf(iso);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return ymd === today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 안 읽음으로 보이는 항목인가(미룬 것은 빼고 — 2.12단계 §3-1) */
export function isShownUnread(i: NotifyItem): boolean {
  return i.readAt === null && i.snoozeUntil === null;
}

/** 미룬(아직 안 읽은) 항목인가 */
export function isSnoozed(i: NotifyItem): boolean {
  return i.readAt === null && i.snoozeUntil !== null;
}

/** 종 배지: 안 읽은 긴급이 있으면 urgent(코랄), 안 읽은 것만 있으면 neutral, 없으면 null(배지 없음) */
export function badgeTone(inbox: InboxState | null): 'urgent' | 'neutral' | null {
  if (!inbox || inbox.unread === 0) return null;
  return inbox.items.some((i) => isShownUnread(i) && i.grade === 'urgent') ? 'urgent' : 'neutral';
}

/** 종 단추의 읽는 이름 */
export function bellLabel(inbox: InboxState | null): string {
  const n = inbox?.unread ?? 0;
  return n > 0 ? `알림 ${n}건 안 읽음` : '알림';
}

/**
 * 사이드바 긴급 띠(§8-2): 안 읽은 긴급(오늘 생겼거나 다시 알린 것)이 있으면 "긴급 2 · VOC SLA 초과 VOC-2026-0104"(가장 새 항목 제목 + 내용 머리),
 * 내용 숨김이면 "긴급 2". 없으면 null
 */
export function urgentBand(inbox: InboxState | null, today: string): { count: number; text: string } | null {
  if (!inbox || inbox.unreadUrgent <= 0) return null;
  const n = inbox.unreadUrgent;
  if (inbox.hideContent) return { count: n, text: `긴급 ${n}` };
  // 오늘 생긴 것 또는 다시 알린 것(unreadUrgent 가 오늘 다시 알린 것도 센다 — 여기선 꼬리표 reminded 로 본다)
  const latest = inbox.items.find(
    (i) => isShownUnread(i) && i.grade === 'urgent' && (localYmdOf(i.createdAt) === today || i.reminded),
  );
  if (!latest) return { count: n, text: `긴급 ${n}` };
  const head = latest.body.split(' · ')[0].trim();
  return { count: n, text: `긴급 ${n} · ${latest.title}${head ? ` ${head}` : ''}` };
}

/** 알림함 머리의 Windows 알림 수 문구 */
export function toastCountText(inbox: InboxState): string {
  if (inbox.toastMode === 'unsupported') return 'Windows 알림을 보낼 수 없어 알림함에만 남습니다';
  const base = `Windows 알림 오늘 ${inbox.todayToasts}/${inbox.dailyLimit}`;
  return inbox.todayToasts >= inbox.dailyLimit ? `${base} — 나머지는 알림함에만` : base;
}

/** [이런 알림 끄기] 뒤 알림 띠 문구 */
export function muteNoticeText(kind: NotifyKind): string {
  return `${kind === 'vocSla' ? 'VOC SLA' : NOTIFY_KIND_LABEL[kind]} 알림을 껐습니다`;
}

// ---- 설정 › 알림 입력 -------------------------------------------------------

export const NOTIFY_MODE_LABEL: Record<NotifyMode, string> = {
  toast: 'Windows 알림',
  inbox: '알림함만',
  off: '끔',
};

/** 설정 줄 이름(§8-4) */
export const NOTIFY_ROW_LABEL: Record<NotifyKind, string> = {
  due: '오늘 마감 할 일',
  vocSla: 'VOC SLA 임박·초과',
  vocAssign: 'VOC 새 배정',
  morning: '아침 요약',
};

export { NOTIFY_KINDS, NOTIFY_MODES };

/** 입력 칸 아래 문장(틀린 칸과 문장). 없으면 null */
export function notifyDraftProblem(draft: NotifySettings): { field: NotifyProblemField; message: string } | null {
  return notifySettingsProblem(draft);
}

/** main 응답 검사(설정). 모양이 틀리면 null */
export function normalizeNotifySettings(raw: unknown): NotifySettings | null {
  if (!isObject(raw) || !isObject(raw.kinds)) return null;
  const kinds = {} as Record<NotifyKind, NotifyMode>;
  for (const k of NOTIFY_KINDS) {
    const m = raw.kinds[k];
    if (typeof m !== 'string' || !(NOTIFY_MODES as readonly string[]).includes(m)) return null;
    kinds[k] = m as NotifyMode;
  }
  if (typeof raw.morningTime !== 'string' || typeof raw.workStart !== 'string' || typeof raw.workEnd !== 'string') return null;
  if (typeof raw.hideContent !== 'boolean') return null;
  // 2.12단계 칸은 옛 main 이면 없다 — 기본값으로
  const d = DEFAULT_NOTIFY_SETTINGS;
  return {
    kinds,
    morningTime: raw.morningTime,
    workStart: raw.workStart,
    workEnd: raw.workEnd,
    hideContent: raw.hideContent,
    quietStart: typeof raw.quietStart === 'string' ? raw.quietStart : d.quietStart,
    quietEnd: typeof raw.quietEnd === 'string' ? raw.quietEnd : d.quietEnd,
    quietHold: typeof raw.quietHold === 'boolean' ? raw.quietHold : d.quietHold,
    sound: typeof raw.sound === 'boolean' ? raw.sound : d.sound,
  };
}

// ---- 2.12단계: [나중에]·보류 표기 ---------------------------------------------

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function hmText(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 「9/28(월) 08:50」(시각이 아니면 '') */
export function formatDayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]}) ${hmText(d)}`;
}

/** 미룬 항목 꼬리표: 오늘이면 「15:10에 다시」, 다른 날이면 「9/28 08:50에 다시」 */
export function snoozeTagText(iso: string, today: string): string {
  const t = formatInboxTime(iso, today);
  return t ? `${t}에 다시` : '나중에 다시';
}

/** [나중에] 선택 글자: 「1시간 뒤 · 15:10」 · 「내일 아침 · 9/28(월) 08:50」 */
export function snoozeOptionText(kind: SnoozeKind, at: string | null): string {
  const label = kind === '1h' ? '1시간 뒤' : '내일 아침';
  if (!at) return label;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return label;
  return `${label} · ${kind === '1h' ? hmText(d) : formatDayTime(at)}`;
}

/** [나중에]를 보이는가: 긴급 · 안 읽음 · 미루지 않음(아침 요약은 미루지 않는다) */
export function canSnooze(i: NotifyItem): boolean {
  return i.grade === 'urgent' && i.kind !== 'morning' && isShownUnread(i);
}

/** 알림함 머리의 보류 문구: 「보류 중 — 발표 중 · 3건 (끝나면 1건으로 보냅니다)」. 보류가 아니면 null */
export function heldBannerText(inbox: InboxState | null): string | null {
  const h = inbox?.held;
  if (!h) return null;
  return `보류 중 — ${h.label} · ${h.count}건 (끝나면 1건으로 보냅니다)`;
}
