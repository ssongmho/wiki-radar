// 이번 주 기한 트랙: [지남] 월 화 수 목 금. 점 하나 = 그날 기한인 열린 할 일 하나.
import type { ReactElement } from 'react';
import type { WeekDay, WeekInfo } from '../../shared/types';
import { cls } from '../lib/cls';
import { formatLongDate, formatTrackLabel, yearOf } from '../lib/date';

/** 점을 이 개수까지 그리고, 넘으면 점 하나 + 숫자로 줄인다(칸 폭이 45px 안팎이라). */
const MAX_DOTS = 3;

type DotTone = 'coral' | 'amber' | 'muted';

function Dots({ count, tone }: { count: number; tone: DotTone }): ReactElement | null {
  if (count <= 0) return null;
  if (count <= MAX_DOTS) {
    return (
      <span className="dots" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={`dot dot--${tone}`} />
        ))}
      </span>
    );
  }
  return (
    <span className="dots" aria-hidden="true">
      <span className={`dot dot--${tone}`} />
      <span className={`dots-num dots-num--${tone}`}>{count}</span>
    </span>
  );
}

/**
 * 칸(44px, 11px 글자)에는 한글 네 글자까지 들어간다. 그보다 긴 공식 이름은 널리 쓰이는 짧은 이름으로 바꾼다.
 * 전체 이름은 칸의 title 과 읽기 도구용 글에 남긴다.
 */
const SHORT_HOLIDAY_NAMES: Readonly<Record<string, string>> = {
  전국동시지방선거: '지방선거',
  부처님오신날: '석탄일',
  국회의원선거: '총선',
  대통령선거: '대선',
  임시공휴일: '임시휴일',
};

/** '추석 대체공휴일' → '추석', '전국동시지방선거' → '지방선거' (칸이 좁다) */
export function shortHolidayName(name: string | undefined): string {
  const t = (name ?? '').replace(/\s*대체\s*공휴일$/, '').trim();
  return SHORT_HOLIDAY_NAMES[t] ?? (t || '휴일');
}

function DayCell({ day, refYear }: { day: WeekDay; refYear?: number }): ReactElement {
  const spoken = [formatLongDate(day.date, refYear)];
  if (day.isToday) spoken.push('오늘');
  if (day.isHoliday) spoken.push(day.holidayName ?? '공휴일');
  spoken.push(day.dueCount > 0 ? `기한 ${day.dueCount}건` : '기한 없음');
  return (
    <div
      className={cls('track-cell', day.isToday && 'is-today', day.isPast && 'is-past', day.isHoliday && 'is-holiday')}
      data-testid="week-day"
      data-date={day.date}
      data-holiday={String(day.isHoliday)}
      data-today={String(day.isToday)}
      // 칸이 좁아 이름을 줄이거나 말줄임하므로 마우스로도 전체 이름을 볼 수 있게 한다(다른 축약 글과 같은 관례).
      title={day.isHoliday ? spoken.join(', ') : undefined}
    >
      {day.isHoliday && (
        <span className="track-holiday" aria-hidden="true">
          {shortHolidayName(day.holidayName)}
        </span>
      )}
      <Dots count={day.dueCount} tone={day.isPast ? 'muted' : 'amber'} />
      <span className="sr-only">{spoken.join(', ')}</span>
    </div>
  );
}

export interface WeekTrackProps {
  week: WeekInfo;
  variant: 'sidebar' | 'full';
}

export function WeekTrack({ week, variant }: WeekTrackProps): ReactElement {
  const refYear = yearOf(week.today);
  if (week.days.length === 0) {
    return (
      <p className={`track track--${variant} empty-note`} data-testid="week-track">
        이번 주 달력 정보가 없습니다.
      </p>
    );
  }
  return (
    <div className={`track track--${variant}`} data-testid="week-track" role="group" aria-label="이번 주 기한 분포">
      <div className="track-cells">
        <div
          className={cls('track-cell', 'track-cell--overdue', week.overdueCount === 0 && 'is-empty')}
          data-testid="week-overdue"
          data-count={week.overdueCount}
        >
          <Dots count={week.overdueCount} tone="coral" />
          <span className="sr-only">기한 지난 할 일 {week.overdueCount}건</span>
        </div>
        {week.days.map((day) => (
          <DayCell key={day.date} day={day} refYear={refYear} />
        ))}
      </div>
      <div className="track-labels" aria-hidden="true">
        <span className="track-label track-label--overdue">지남</span>
        {week.days.map((day) => (
          <span key={day.date} className={cls('track-label', day.isToday && 'is-today')}>
            {formatTrackLabel(day.date, `${day.weekday} ${day.label}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 트랙 위 오른쪽의 휴무 안내. 연휴 직전 영업일에만 보인다. */
export function BreakNote({ week }: { week: WeekInfo }): ReactElement | null {
  if (!week.beforeHolidayBreak) return null;
  const detail = [week.breakName ? `${week.breakName} 연휴` : '연휴'];
  if (week.nextBusinessDay) detail.push(`다음 영업일 ${formatLongDate(week.nextBusinessDay, yearOf(week.today))}`);
  // 보이는 글은 짧게 두고, 풀이는 옆의 읽기 도구용 글에 둔다(글자 비교 시험이 흔들리지 않게).
  return (
    <>
      <span className="break-note" title={detail.join(', ')}>
        연휴 전 마지막 영업일
      </span>
      <span className="sr-only">{detail.join(', ')}</span>
    </>
  );
}
