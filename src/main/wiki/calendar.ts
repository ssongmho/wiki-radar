// 날짜 문자열(YYYY-MM-DD) 연산과 영업일·주간 정보.
// 모든 계산은 Date.UTC 기반의 '일 번호'로 한다 — PC 시간대가 결과에 영향을 주지 않는다.
import type { Holiday, WeekDay, WeekInfo } from '../../shared/types';

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 'YYYY-MM-DD' → 1970-01-01 기준 일 번호. 형식이 아니거나 없는 날짜(2월 30일 등)면 null. */
export function ymdToDay(s: string): number | null {
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}

export function isValidYmd(s: unknown): s is string {
  return typeof s === 'string' && ymdToDay(s) !== null;
}

/** 일 번호 → 'YYYY-MM-DD' */
export function dayToYmd(day: number): string {
  const dt = new Date(day * DAY_MS);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function mustDay(s: string): number {
  const d = ymdToDay(s);
  if (d === null) throw new Error(`날짜 형식이 아님: ${s}`);
  return d;
}

export function addDays(ymd: string, n: number): string {
  return dayToYmd(mustDay(ymd) + n);
}

/** 0=일 … 6=토 */
export function weekdayOf(ymd: string): number {
  return new Date(mustDay(ymd) * DAY_MS).getUTCDay();
}

/** 그 날이 속한 주(월요일 시작)의 월요일 */
export function mondayOf(ymd: string): string {
  const wd = weekdayOf(ymd);
  const back = wd === 0 ? 6 : wd - 1;
  return addDays(ymd, -back);
}

/** 'M/D' (앞의 0 없음) */
export function monthDayLabel(ymd: string): string {
  const m = YMD_RE.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[2])}/${Number(m[3])}`;
}

export function weekdayKo(ymd: string): string {
  return WEEKDAY_KO[weekdayOf(ymd)];
}

/** 공휴일 표의 마지막 날짜(형식이 맞는 것 중). 비어 있으면 null. */
export function lastHolidayDate(holidays: readonly Holiday[]): string | null {
  let last: string | null = null;
  for (const h of holidays) {
    if (!h || !isValidYmd(h.date)) continue;
    if (last === null || h.date > last) last = h.date;
  }
  return last;
}

/** 표가 끝나기 전에 미리 알리는 여유(일). */
export const HOLIDAY_TABLE_LEAD_DAYS = 60;

/**
 * 공휴일 표가 곧 끝나면(오늘 + leadDays 가 표의 마지막 날짜를 넘으면) 사람이 읽을 경고 한 줄, 아니면 null.
 * 표 밖의 날은 전부 영업일로 계산되므로(경고·오류 없이) 표를 손으로 늘려야 한다는 것을 화면에 알린다.
 */
export function holidayTableWarning(holidays: readonly Holiday[], today: string, leadDays = HOLIDAY_TABLE_LEAD_DAYS): string | null {
  const last = lastHolidayDate(holidays);
  if (last === null) return '공휴일 표(config/holidays-kr.json)가 비어 있음 — 공휴일 없이 영업일을 계산함';
  const todayDay = ymdToDay(today);
  const lastDay = ymdToDay(last);
  if (todayDay === null || lastDay === null) return null;
  if (todayDay + leadDays <= lastDay) return null;
  return `공휴일 표(config/holidays-kr.json)가 ${last} 까지만 있음 — 그 뒤는 공휴일 없이 영업일을 계산하니 표를 늘려야 함`;
}

/** 공휴일 이름에서 ' 대체공휴일' 을 뗀다(예: '삼일절 대체공휴일' → '삼일절'). */
export function baseHolidayName(name: string): string {
  return name.replace(/\s*대체공휴일$/, '').trim();
}

/** 영업일 = 월~금 중 공휴일이 아닌 날. */
export class BusinessCalendar {
  private readonly names = new Map<string, string>();

  constructor(holidays: readonly Holiday[]) {
    for (const h of holidays) {
      if (!h || !isValidYmd(h.date)) continue;
      // 같은 날이 두 번 있으면 처음 것을 쓴다.
      if (!this.names.has(h.date)) this.names.set(h.date, typeof h.name === 'string' ? h.name : '');
    }
  }

  isHoliday(ymd: string): boolean {
    return this.names.has(ymd);
  }

  holidayName(ymd: string): string | undefined {
    return this.names.get(ymd);
  }

  isBusinessDay(ymd: string): boolean {
    const wd = weekdayOf(ymd);
    return wd >= 1 && wd <= 5 && !this.names.has(ymd);
  }

  /** from 다음날부터 to 까지(to 포함) 영업일 수. from >= to 면 0. */
  businessDaysAfter(from: string, to: string): number {
    const a = mustDay(from);
    const b = mustDay(to);
    let n = 0;
    for (let d = a + 1; d <= b; d++) {
      if (this.isBusinessDay(dayToYmd(d))) n++;
    }
    return n;
  }

  /** ymd 다음의 첫 영업일 */
  nextBusinessDay(ymd: string): string {
    const start = mustDay(ymd);
    // 공휴일 목록이 아무리 길어도 1년 안에는 영업일이 있다. 안전장치로 400일에서 멈춘다.
    for (let d = start + 1; d <= start + 400; d++) {
      const s = dayToYmd(d);
      if (this.isBusinessDay(s)) return s;
    }
    return dayToYmd(start + 1);
  }

  /** a 와 b 사이(양 끝 제외)의 공휴일 날짜들, 날짜순 */
  holidaysBetween(a: string, b: string): string[] {
    const from = mustDay(a);
    const to = mustDay(b);
    const out: string[] = [];
    for (let d = from + 1; d < to; d++) {
      const s = dayToYmd(d);
      if (this.names.has(s)) out.push(s);
    }
    return out;
  }
}

/** 주간 정보 계산에 필요한 할 일의 최소 모양 */
export interface DueLike {
  due?: string;
}

/**
 * 명세 §2 주간 정보. tasks 는 열린 할 일(open·wip)만 넘긴다.
 * dueCount 는 오늘 이후(오늘 포함) 날짜에만 센다 — 지난 날의 것은 overdueCount 로 간다.
 */
export function buildWeekInfo(
  today: string,
  cal: BusinessCalendar,
  tasks: readonly DueLike[],
  overdueCount: number,
): WeekInfo {
  const monday = mondayOf(today);
  const friday = addDays(monday, 4);
  const dueCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.due) dueCounts.set(t.due, (dueCounts.get(t.due) ?? 0) + 1);
  }
  const days: WeekDay[] = [];
  for (let i = 0; i < 5; i++) {
    const date = addDays(monday, i);
    const holidayName = cal.holidayName(date);
    const day: WeekDay = {
      date,
      label: monthDayLabel(date),
      weekday: weekdayKo(date),
      isToday: date === today,
      isPast: date < today,
      isHoliday: holidayName !== undefined,
      dueCount: date >= today ? (dueCounts.get(date) ?? 0) : 0,
    };
    if (holidayName !== undefined) day.holidayName = holidayName;
    days.push(day);
  }
  const nextBusinessDay = cal.nextBusinessDay(today);
  const between = cal.holidaysBetween(today, nextBusinessDay);
  const beforeHolidayBreak = cal.isBusinessDay(today) && between.length > 0;
  const info: WeekInfo = {
    today,
    monday,
    friday,
    days,
    overdueCount,
    nextBusinessDay,
    beforeHolidayBreak,
  };
  if (beforeHolidayBreak) info.breakName = baseHolidayName(cal.holidayName(between[0]) ?? '');
  return info;
}
