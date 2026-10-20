// 알림 N1 규칙(2.9단계 명세 §6): 업무 시간 판정, 단계·중복 제거(가족), 5분 묶음, 하루 한도, 알림 문구.
// N2(2.12단계 §3·§5): 「내일 아침」 깰 시각(nextMorning), 아침 요약의 「나중에 N」, 보류 요약 문구(heldText).
// electron 없음 — 시각은 언제나 인자로 받는다(가짜 시계로 시험).
import { BUNDLE_MINUTES, DAILY_TOAST_LIMIT } from '../../shared/notify';
import type { NotifyKind } from '../../shared/types';
import type { BusinessCalendar } from '../wiki/calendar';

export {
  BUNDLE_MINUTES,
  DAILY_TOAST_LIMIT,
  DEFAULT_NOTIFY_SETTINGS,
  DUE_ALERT_TIME,
  checkNotifySettings,
  defaultNotifySettings,
  parseNotifySettings,
} from '../../shared/notify';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 로컬 YYYY-MM-DD */
export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 로컬 HH:MM */
export function hmOf(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 분 단위 시각(묶음 5분 비교 — 60초 판정 주기와 맞춘다) */
export function minuteOf(d: Date): number {
  return Math.floor(d.getTime() / 60_000);
}

/** 업무 시간인가: 업무일(평일·공휴일 아님)이고 workStart ≤ 지금 < workEnd */
export function isWorkTime(now: Date, work: { workStart: string; workEnd: string }, cal: BusinessCalendar): boolean {
  if (!cal.isBusinessDay(ymdOf(now))) return false;
  const hm = hmOf(now);
  return hm >= work.workStart && hm < work.workEnd;
}

/** 긴급 신호 한 건(signals.ts 가 만든다) */
export interface UrgentSignal {
  kind: Exclude<NotifyKind, 'morning'>;
  /** 가족 키(task:<id>:due:<YYYY-MM-DD> · voc:<id>:sla · voc:<id>:assign) */
  family: string;
  /** 단계 키(task:<id>:due-today · voc:<id>:sla-warning …) */
  key: string;
  /** 단계 순위 — 높을수록 나쁘다 */
  rank: number;
  title: string;
  body: string;
  target: string;
  /** 묶음 문구의 갈래(SLA 초과 · SLA 임박 · 오늘 마감 · 새 배정) */
  label: BundleLabel;
}

export type BundleLabel = 'SLA 초과' | 'SLA 임박' | '오늘 마감' | '새 배정';
const BUNDLE_ORDER: readonly BundleLabel[] = ['SLA 초과', 'SLA 임박', '오늘 마감', '새 배정'];

/** 가족 기록: 보낸(또는 기록한) 가장 높은 순위와 마지막으로 본 시각 */
export interface FamilyRecord {
  rank: number;
  at: string;
}

/** 이 신호를 새로 알려야 하나 — 기억한 순위보다 높을 때만(임박 → 초과는 다시, 초과 → 임박은 아님) */
export function isWorse(families: Record<string, FamilyRecord>, signal: Pick<UrgentSignal, 'family' | 'rank'>): boolean {
  const prev = families[signal.family];
  return !prev || signal.rank > prev.rank;
}

/**
 * 오늘 마감 가족 키 `task:<id>:due:<YYYY-MM-DD>`. 날짜가 붙어 있어 기한을 하루 미뤄 다음 날 또 오늘 마감이 되면 새 가족이다
 * (날짜 없는 키는 앱을 마감 알림 시각 뒤에 켠 날 어제 가족에 걸려 알리지 않았다). 날짜 없는 옛 키도 due 로 읽어 지운다.
 */
const DUE_FAMILY_RE = /^task:.+:due(?::(\d{4}-\d{2}-\d{2}))?$/;

/** 오늘 마감 가족 키 */
export function dueFamily(taskId: string, today: string): string {
  return `task:${taskId}:due:${today}`;
}

/** 가족 키가 어느 종류의 것인가(사라진 가족을 지울 때 그 출처의 것만 본다) */
export function familyKind(family: string): Exclude<NotifyKind, 'morning'> | null {
  if (DUE_FAMILY_RE.test(family)) return 'due';
  if (family.startsWith('voc:') && family.endsWith(':sla')) return 'vocSla';
  if (family.startsWith('voc:') && family.endsWith(':assign')) return 'vocAssign';
  return null;
}

/**
 * 출처의 최신 입력에서 사라진 가족을 지운다(그 종류만). keepDueToday: 오늘 마감 가족은 하루 한 번이라 날짜가 바뀔 때까지 둔다
 * (팀 할 일이 늦게 합쳐지는 등 잠깐 빠졌다 돌아와도 다시 알리지 않게 — 명세 §14).
 */
export function dropVanished(
  families: Record<string, FamilyRecord>,
  kinds: ReadonlySet<Exclude<NotifyKind, 'morning'>>,
  present: ReadonlySet<string>,
  today: string,
): void {
  for (const [family, rec] of Object.entries(families)) {
    const kind = familyKind(family);
    if (!kind || !kinds.has(kind)) continue;
    if (kind === 'due') {
      // 날짜 붙은 키: 그날 것만 둔다(보여도 다른 날 것은 지운다). 옛 키: 전처럼 오늘 본 것·보이는 것은 둔다
      const day = DUE_FAMILY_RE.exec(family)?.[1];
      if (day !== undefined ? day === today : present.has(family) || ymdOf(new Date(rec.at)) === today) continue;
      delete families[family];
      continue;
    }
    if (present.has(family)) continue;
    delete families[family];
  }
}

/** 하루 한도에 닿았나(오늘 보낸 긴급 Windows 알림 수) */
export function todayToastCount(toasts: readonly string[], today: string, toLocalYmd: (iso: string) => string): number {
  return toasts.filter((t) => toLocalYmd(t) === today).length;
}

export function limitReached(count: number): boolean {
  return count >= DAILY_TOAST_LIMIT;
}

/** 마지막 긴급 Windows 알림 뒤 5분이 지났나(분 단위) — 없으면 참 */
export function bundleWindowPassed(lastToastAt: string | null, now: Date): boolean {
  if (!lastToastAt) return true;
  const last = new Date(lastToastAt);
  if (Number.isNaN(last.getTime())) return true;
  return minuteOf(now) - minuteOf(last) >= BUNDLE_MINUTES;
}

/** 묶음 Windows 알림 문구(§6-3). 내용 숨김이면 내용은 건수만. 고객 담당자 이름·메일 본문은 신호에 애초에 없다 */
export function bundleText(signals: readonly Pick<UrgentSignal, 'kind' | 'label' | 'title' | 'body'>[], hideContent: boolean): {
  title: string;
  body: string;
} {
  const n = signals.length;
  if (n === 0) return { title: '', body: '' };
  const kinds = new Set(signals.map((s) => s.kind));
  const labels = new Set(signals.map((s) => s.label));
  let title: string;
  let body: string;
  if (n === 1) {
    title = signals[0].title;
    body = signals[0].body;
  } else if (kinds.size === 1) {
    // 같은 종류 여러 건: 제목은 종류와 건수, 내용은 앞 두 건(할 일은 제목, VOC 는 번호)
    const kind = signals[0].kind;
    title =
      kind === 'due'
        ? `오늘 마감 할 일 ${n}건`
        : kind === 'vocAssign'
          ? `VOC 새 배정 ${n}건`
          : labels.size === 1
            ? `VOC ${signals[0].label} ${n}건`
            : `VOC SLA ${n}건`;
    const heads = signals.slice(0, 2).map((s) => (kind === 'due' ? s.body : s.body.split(' · ')[0]));
    body = heads.join(', ') + (n > 2 ? ` 외 ${n - 2}건` : '');
  } else {
    title = `긴급 ${n}건`;
    body = BUNDLE_ORDER.map((label) => [label, signals.filter((s) => s.label === label).length] as const)
      .filter(([, c]) => c > 0)
      .map(([label, c]) => `${label} ${c}`)
      .join(' · ');
  }
  if (hideContent) body = `${n}건`;
  return { title, body };
}

/** 아침 요약 숫자(§6-4) */
export interface MorningNumbers {
  dueToday: number;
  overdue: number;
  slaWarning: number;
  slaExceeded: number;
  deferred: number;
  /** 이번 요약에 넣은 「내일 아침」 깨움 수(2.12단계 §3-4). 없으면 0 */
  snoozed?: number;
}

/** 아침 요약 문구. 숫자가 모두 0 이면 quiet(Windows 알림 없이 알림함에만 "오늘 요약 — 급한 것 없음") */
export function morningText(n: MorningNumbers, hideContent: boolean): { title: string; body: string; quiet: boolean } {
  const parts: string[] = [];
  if (n.dueToday > 0) parts.push(`오늘 마감 ${n.dueToday}`);
  if (n.overdue > 0) parts.push(`지남 ${n.overdue}`);
  if (n.slaWarning > 0) parts.push(`SLA 임박 ${n.slaWarning}`);
  if (n.slaExceeded > 0) parts.push(`초과 ${n.slaExceeded}`);
  if (n.deferred > 0) parts.push(`보류 ${n.deferred}`);
  const snoozed = n.snoozed ?? 0;
  if (snoozed > 0) parts.push(`나중에 ${snoozed}`);
  if (parts.length === 0) return { title: '오늘 요약 — 급한 것 없음', body: '', quiet: true };
  const total = n.dueToday + n.overdue + n.slaWarning + n.slaExceeded + n.deferred + snoozed;
  return { title: '오늘 요약', body: hideContent ? `${total}건` : parts.join(' · '), quiet: false };
}

/**
 * 「내일 아침」 깰 시각(2.12단계 §3-1): 오늘 다음의 첫 업무일(주말·공휴일 건너뜀)의 아침 요약 시각(로컬).
 * 오늘 아침 요약 전에 눌러도 "내일" — 단추 이름이 「내일 아침」이므로
 */
export function nextMorning(now: Date, morningTime: string, cal: BusinessCalendar): Date {
  const [h, m] = /^\d{2}:\d{2}$/.test(morningTime) ? morningTime.split(':').map(Number) : [8, 50];
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
  for (let i = 0; i < 60 && !cal.isBusinessDay(ymdOf(d)); i++) d.setDate(d.getDate() + 1);
  return d;
}

/** 아침 요약 문구의 숫자 합(내용 숨김 문구 — 「오늘 마감 3 · 지남 2」 → 5) */
export function morningTotalOf(body: string): number {
  let total = 0;
  for (const m of body.matchAll(/(\d+)/g)) total += Number(m[1]);
  return total;
}

/**
 * 보류 요약 문구(2.12단계 §5-1): 아침 요약 + 긴급이 함께 모였을 때 한 장. 제목 「보류한 알림 N건」(긴급 수 + 1),
 * 내용 「오늘 요약 · SLA 초과 1 · 오늘 마감 2」(긴급 갈래는 bundleText 섞임 문구와 같은 순서, 0 은 뺀다). 내용 숨김이면 「N건」
 */
export function heldText(
  _morning: { title: string; body: string },
  urgent: readonly Pick<UrgentSignal, 'label'>[],
  hideContent: boolean,
): { title: string; body: string } {
  const n = urgent.length + 1;
  const title = `보류한 알림 ${n}건`;
  if (hideContent) return { title, body: `${n}건` };
  const parts = ['오늘 요약'];
  for (const label of BUNDLE_ORDER) {
    const c = urgent.filter((s) => s.label === label).length;
    if (c > 0) parts.push(`${label} ${c}`);
  }
  return { title, body: parts.join(' · ') };
}
