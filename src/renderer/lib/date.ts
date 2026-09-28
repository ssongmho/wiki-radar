// 날짜 표기 유틸. 'YYYY-MM-DD' 는 시간대 영향 없이 산술로만 다룬다
// (Date 의 로컬·UTC 변환을 거치지 않는다). 모든 함수는 순수 함수다.

const WEEKDAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'] as const;

export interface Ymd {
  year: number;
  month: number; // 1~12
  day: number; // 1~31
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 'YYYY-MM-DD' 를 연·월·일로 나눈다. 형식이 틀리거나 없는 날짜(2월 30일 등)면 null. */
export function parseYmd(value: unknown): Ymd | null {
  if (typeof value !== 'string') return null;
  const m = YMD_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** 요일 번호(0=일 … 6=토). Sakamoto 공식이라 시간대와 무관하다. */
export function weekdayIndex({ year, month, day }: Ymd): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[month - 1] + day) % 7;
}

/** '수' 처럼 한 글자 요일. 날짜가 아니면 빈 문자열. */
export function weekdayShort(value: unknown): string {
  const ymd = parseYmd(value);
  return ymd ? WEEKDAY_SHORT[weekdayIndex(ymd)] : '';
}

function yearPrefix(ymd: Ymd, refYear?: number): string {
  return refYear !== undefined && refYear !== ymd.year ? `${ymd.year}년 ` : '';
}

/** '9월 23일'. refYear 와 해가 다르면 '2025년 9월 23일'. 날짜가 아니면 받은 글자 그대로. */
export function formatMonthDay(value: string, refYear?: number): string {
  const ymd = parseYmd(value);
  if (!ymd) return value;
  return `${yearPrefix(ymd, refYear)}${ymd.month}월 ${ymd.day}일`;
}

/** '9월 23일 수요일'. refYear 와 해가 다르면 해를 붙인다. */
export function formatLongDate(value: string, refYear?: number): string {
  const ymd = parseYmd(value);
  if (!ymd) return value;
  return `${yearPrefix(ymd, refYear)}${ymd.month}월 ${ymd.day}일 ${WEEKDAY_SHORT[weekdayIndex(ymd)]}요일`;
}

/** '9/24' */
export function formatSlash(value: string): string {
  const ymd = parseYmd(value);
  return ymd ? `${ymd.month}/${ymd.day}` : value;
}

/** 주간 트랙 아래 줄 라벨 '월 21'. 날짜가 아니면 fallback. */
export function formatTrackLabel(value: string, fallback = ''): string {
  const ymd = parseYmd(value);
  return ymd ? `${WEEKDAY_SHORT[weekdayIndex(ymd)]} ${ymd.day}` : fallback;
}

/** 해 부분만. 날짜가 아니면 undefined. */
export function yearOf(value: unknown): number | undefined {
  return parseYmd(value)?.year;
}

/** 로컬 달력 기준 오늘 'YYYY-MM-DD'. (스냅샷이 오기 전 머리글 표시에만 쓴다) */
export function localYmd(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** 24시간 시·분 → '오후 5:28' */
export function formatHourMinute(hour: number, minute: number): string {
  const period = hour < 12 ? '오전' : '오후';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${period} ${h12}:${String(minute).padStart(2, '0')}`;
}

/** 스냅샷 생성 시각 같은 ISO 시각 → 이 PC 시간대의 '오후 12:03'. 알아볼 수 없으면 빈 문자열. */
export function formatClock(iso: unknown): string {
  if (typeof iso !== 'string' || iso.trim() === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return formatHourMinute(d.getHours(), d.getMinutes());
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function zoneMinutes(zone: string): number {
  if (zone.toUpperCase() === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 60 + minutes);
}

export interface MailDateOptions {
  /** 이 해와 같으면 해를 생략한다 */
  refYear?: number;
  /**
   * 시간대가 적힌 값(Z, +09:00)을 옮길 대상 오프셋(분, 동쪽이 +).
   * 생략하면 그 시각의 이 PC 시간대를 쓴다. 시간대가 없는 값은 적힌 시각 그대로 보인다.
   */
  offsetMinutes?: number;
}

/**
 * 메일 날짜 → '9월 15일 오후 5:28'. 시각이 없으면 '9월 15일'.
 * 알아볼 수 없는 값이면 받은 글자 그대로 돌려준다(빈 값이면 빈 문자열).
 */
export function formatMailDate(value: unknown, opts: MailDateOptions = {}): string {
  let raw: string;
  if (typeof value === 'string') raw = value.trim();
  else if (value instanceof Date && !Number.isNaN(value.getTime())) raw = value.toISOString();
  else return '';
  const m = ISO_RE.exec(raw);
  if (!m) return raw;

  let year = Number(m[1]);
  let month = Number(m[2]);
  let day = Number(m[3]);
  if (parseYmd(`${m[1]}-${m[2]}-${m[3]}`) === null) return raw;
  const ymdText = (): string => `${yearPrefix({ year, month, day }, opts.refYear)}${month}월 ${day}일`;
  if (m[4] === undefined) return ymdText();

  let hour = Number(m[4]);
  let minute = Number(m[5]);
  if (hour > 23 || minute > 59) return raw;

  if (m[7] !== undefined) {
    // 시간대가 적힌 값: 절대 시각으로 바꾼 뒤 대상 오프셋의 벽시계로 읽는다.
    const instant = Date.UTC(year, month - 1, day, hour, minute, Number(m[6] ?? 0)) - zoneMinutes(m[7]) * 60_000;
    const target = opts.offsetMinutes ?? -new Date(instant).getTimezoneOffset();
    const wall = new Date(instant + target * 60_000);
    year = wall.getUTCFullYear();
    month = wall.getUTCMonth() + 1;
    day = wall.getUTCDate();
    hour = wall.getUTCHours();
    minute = wall.getUTCMinutes();
  }
  return `${ymdText()} ${formatHourMinute(hour, minute)}`;
}
