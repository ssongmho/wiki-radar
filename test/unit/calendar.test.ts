// 날짜 연산·영업일·주간 정보 (명세 §2)
import { describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import {
  BusinessCalendar,
  HOLIDAY_TABLE_LEAD_DAYS,
  addDays,
  baseHolidayName,
  buildWeekInfo,
  dayToYmd,
  holidayTableWarning,
  isValidYmd,
  lastHolidayDate,
  mondayOf,
  monthDayLabel,
  weekdayKo,
  weekdayOf,
  ymdToDay,
} from '../../src/main/wiki/calendar';

const cal = new BusinessCalendar(holidaysJson.holidays);

describe('날짜 문자열', () => {
  it.each([
    ['2026-09-23', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-9-23', false],
    ['2026-09-23T00:00', false],
    ['', false],
  ])('%s 유효 = %s', (s, ok) => {
    expect(isValidYmd(s)).toBe(ok);
  });

  it('문자열이 아닌 값은 유효하지 않다', () => {
    expect(isValidYmd(20260923)).toBe(false);
    expect(isValidYmd(null)).toBe(false);
  });

  it('일 번호 왕복(2026~2027 전부)', () => {
    const start = ymdToDay('2026-01-01') as number;
    for (let d = start; d < start + 730; d++) {
      expect(ymdToDay(dayToYmd(d))).toBe(d);
    }
  });

  it('addDays: 월·연도·윤년 경계', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-09-23', 0)).toBe('2026-09-23');
  });

  it('요일·월요일', () => {
    expect(weekdayOf('2026-09-23')).toBe(3);
    expect(weekdayKo('2026-09-23')).toBe('수');
    expect(weekdayOf('2026-09-27')).toBe(0);
    expect(mondayOf('2026-09-21')).toBe('2026-09-21');
    expect(mondayOf('2026-09-23')).toBe('2026-09-21');
    expect(mondayOf('2026-09-26')).toBe('2026-09-21'); // 토
    expect(mondayOf('2026-09-27')).toBe('2026-09-21'); // 일
    expect(mondayOf('2027-01-01')).toBe('2026-12-28'); // 연도 경계
  });

  it('M/D 표기', () => {
    expect(monthDayLabel('2026-09-03')).toBe('9/3');
    expect(monthDayLabel('2026-10-12')).toBe('10/12');
  });

  it('대체공휴일 이름', () => {
    expect(baseHolidayName('삼일절 대체공휴일')).toBe('삼일절');
    expect(baseHolidayName('추석')).toBe('추석');
  });
});

describe('영업일', () => {
  it('주말·공휴일은 영업일이 아니다', () => {
    expect(cal.isBusinessDay('2026-09-23')).toBe(true);
    expect(cal.isBusinessDay('2026-09-24')).toBe(false); // 추석(목)
    expect(cal.isBusinessDay('2026-09-26')).toBe(false); // 토·추석
    expect(cal.isBusinessDay('2026-09-27')).toBe(false); // 일
    expect(cal.isBusinessDay('2026-10-05')).toBe(false); // 개천절 대체공휴일(월)
    expect(cal.isHoliday('2026-10-05')).toBe(true);
    expect(cal.holidayName('2026-10-05')).toBe('개천절 대체공휴일');
  });

  it.each([
    // [due, today, 영업일 수] — due 다음날부터 오늘까지(오늘 포함)
    ['2026-09-10', '2026-09-23', 9],
    ['2026-09-18', '2026-09-23', 3], // 금 → 주말 건너뜀
    ['2026-09-21', '2026-09-23', 2],
    ['2026-09-22', '2026-09-23', 1],
    ['2026-09-23', '2026-09-23', 0], // 오늘이 기한이면 0
    ['2026-09-30', '2026-09-23', 0], // 미래
    ['2026-09-18', '2026-09-21', 1], // 금 → 월
    ['2026-09-19', '2026-09-20', 0], // 토 → 일
    ['2026-09-23', '2026-09-28', 1], // 추석 연휴(목·금·토)·일요일을 건너뛰고 월요일만
    ['2026-09-23', '2026-09-26', 0], // 오늘이 공휴일이면 세지 않는다
    ['2026-12-30', '2027-01-04', 2], // 연도 경계: 12/31(목), 1/4(월) — 1/1 신정 제외
    ['2026-10-02', '2026-10-06', 1], // 개천절(토)·대체공휴일(월)
  ])('%s → %s = %i', (due, today, n) => {
    expect(cal.businessDaysAfter(due, today)).toBe(n);
  });

  it.each([
    ['2026-09-23', '2026-09-28'], // 추석 연휴
    ['2026-09-21', '2026-09-22'],
    ['2026-09-11', '2026-09-14'], // 금 → 월
    ['2026-10-02', '2026-10-06'], // 개천절 대체공휴일
    ['2026-10-08', '2026-10-12'], // 한글날(금)
    ['2026-12-31', '2027-01-04'], // 신정·주말
    ['2026-09-26', '2026-09-28'], // 토요일에서
  ])('%s 다음 영업일 = %s', (d, next) => {
    expect(cal.nextBusinessDay(d)).toBe(next);
  });

  it('공휴일 목록이 비어도 동작한다', () => {
    const plain = new BusinessCalendar([]);
    expect(plain.nextBusinessDay('2026-09-23')).toBe('2026-09-24');
    expect(plain.businessDaysAfter('2026-09-18', '2026-09-23')).toBe(3);
  });

  it('잘못된 공휴일 항목은 건너뛴다', () => {
    const c = new BusinessCalendar([
      { date: '2026-09-99', name: '없는 날' },
      { date: '2026-09-23', name: '처음' },
      { date: '2026-09-23', name: '두 번째' },
    ]);
    expect(c.holidayName('2026-09-23')).toBe('처음');
    expect(c.isHoliday('2026-09-99')).toBe(false);
  });
});

describe('주간 정보', () => {
  it('월요일: 오늘이 첫 칸, 지난 날 없음, 휴무 직전 아님', () => {
    const w = buildWeekInfo('2026-09-21', cal, [{ due: '2026-09-21' }, { due: '2026-09-23' }, { due: '2026-09-23' }], 0);
    expect(w.monday).toBe('2026-09-21');
    expect(w.friday).toBe('2026-09-25');
    expect(w.days.map((d) => [d.label, d.weekday, d.isToday, d.isPast, d.dueCount])).toEqual([
      ['9/21', '월', true, false, 1],
      ['9/22', '화', false, false, 0],
      ['9/23', '수', false, false, 2],
      ['9/24', '목', false, false, 0],
      ['9/25', '금', false, false, 0],
    ]);
    expect(w.nextBusinessDay).toBe('2026-09-22');
    expect(w.beforeHolidayBreak).toBe(false);
    expect(w.breakName).toBeUndefined();
  });

  it('지난 날의 기한은 dueCount 에 넣지 않는다(overdueCount 로 간다)', () => {
    const w = buildWeekInfo('2026-09-23', cal, [{ due: '2026-09-21' }, { due: '2026-09-22' }, { due: '2026-09-23' }], 2);
    expect(w.days.map((d) => d.dueCount)).toEqual([0, 0, 1, 0, 0]);
    expect(w.overdueCount).toBe(2);
  });

  it('보통 금요일: 주말만 쉬면 휴무 직전이 아니다', () => {
    const w = buildWeekInfo('2026-09-11', cal, [], 0);
    expect(w.nextBusinessDay).toBe('2026-09-14');
    expect(w.beforeHolidayBreak).toBe(false);
    expect(w.days.every((d) => d.isPast === (d.date < '2026-09-11'))).toBe(true);
    expect(w.days[4].isToday).toBe(true);
  });

  it('추석 전 수요일: 연휴 직전 마지막 영업일', () => {
    const w = buildWeekInfo('2026-09-23', cal, [], 0);
    expect(w.nextBusinessDay).toBe('2026-09-28');
    expect(w.beforeHolidayBreak).toBe(true);
    expect(w.breakName).toBe('추석');
    expect(w.days.map((d) => d.isHoliday)).toEqual([false, false, false, true, true]);
    expect(w.days[3].holidayName).toBe('추석');
    expect(w.days[0].holidayName).toBeUndefined();
  });

  it('개천절(토)·대체공휴일(월) 앞 금요일', () => {
    const w = buildWeekInfo('2026-10-02', cal, [], 0);
    expect(w.nextBusinessDay).toBe('2026-10-06');
    expect(w.beforeHolidayBreak).toBe(true);
    expect(w.breakName).toBe('개천절');
  });

  it('휴무의 첫 공휴일이 대체공휴일이면 이름에서 떼어 낸다', () => {
    const c = new BusinessCalendar([{ date: '2026-09-28', name: '가상절 대체공휴일' }]);
    const w = buildWeekInfo('2026-09-25', c, [], 0);
    expect(w.nextBusinessDay).toBe('2026-09-29');
    expect(w.beforeHolidayBreak).toBe(true);
    expect(w.breakName).toBe('가상절');
  });

  it('오늘이 공휴일이면 휴무 직전이 아니다', () => {
    const w = buildWeekInfo('2026-09-24', cal, [], 0);
    expect(w.beforeHolidayBreak).toBe(false);
    expect(w.nextBusinessDay).toBe('2026-09-28');
    expect(w.days[3].isToday).toBe(true);
  });

  it('토요일: 그 주 월~금은 모두 지난 날', () => {
    const w = buildWeekInfo('2026-09-26', cal, [{ due: '2026-09-25' }], 1);
    expect(w.monday).toBe('2026-09-21');
    expect(w.days.every((d) => d.isPast && !d.isToday && d.dueCount === 0)).toBe(true);
    expect(w.beforeHolidayBreak).toBe(false);
  });

  it('월·연도 경계 주', () => {
    expect(buildWeekInfo('2026-09-30', cal, [], 0).days.map((d) => d.label)).toEqual(['9/28', '9/29', '9/30', '10/1', '10/2']);
    const w = buildWeekInfo('2026-12-31', cal, [], 0);
    expect(w.days.map((d) => d.date)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
    expect(w.days[4]).toMatchObject({ isHoliday: true, holidayName: '신정', weekday: '금' });
    expect(w.nextBusinessDay).toBe('2027-01-04');
    expect(w.beforeHolidayBreak).toBe(true);
    expect(w.breakName).toBe('신정');
  });
});

describe('공휴일 표 범위', () => {
  const holidays = holidaysJson.holidays;
  const last = lastHolidayDate(holidays) as string;

  it('표의 마지막 날짜', () => {
    expect(last).toBe(holidays.map((h) => h.date).sort().at(-1));
    expect(lastHolidayDate([])).toBeNull();
    expect(lastHolidayDate([{ date: '2026-99-99', name: 'x' }, { date: '2026-03-01', name: '삼일절' }])).toBe('2026-03-01');
  });

  it('여유(60일)가 남아 있으면 경고하지 않는다', () => {
    expect(holidayTableWarning(holidays, '2026-09-23')).toBeNull();
    expect(holidayTableWarning(holidays, addDays(last, -HOLIDAY_TABLE_LEAD_DAYS))).toBeNull();
  });

  it('표가 60일 안에 끝나거나 이미 끝났으면 마지막 날짜를 든 경고 한 줄', () => {
    const soon = holidayTableWarning(holidays, addDays(last, -HOLIDAY_TABLE_LEAD_DAYS + 1));
    expect(soon).toContain(last);
    expect(soon).toMatch(/공휴일 표.*까지만 있음/);
    // 표 밖(2027-03-02): 삼일절이 영업일로 계산되는 상태 — 경고가 그 사실을 알린다
    expect(holidayTableWarning(holidays, '2027-03-02')).toContain(last);
    expect(holidayTableWarning([], '2026-09-23')).toMatch(/비어 있음/);
  });
});
