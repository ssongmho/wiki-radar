// main 이 보낸 스냅샷을 화면이 믿고 쓸 수 있게 다듬는다.
// 타입 계약상 채워져 있어야 할 값이 비어 와도 화면이 깨지지 않게 기본값을 넣는다.
import type { Bucket, Snapshot, Task, WeekDay, WeekInfo } from '../../shared/types';
import { localYmd, parseYmd } from './date';
import { BUCKETS, groupByBucket, numberOf, textOf } from './tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTask(value: unknown): value is Task {
  return isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string';
}

function normalizeDay(value: unknown): WeekDay | null {
  if (!isRecord(value) || !parseYmd(value.date)) return null;
  const day = value as unknown as WeekDay;
  return {
    date: day.date,
    label: textOf(day.label) ?? day.date,
    weekday: textOf(day.weekday) ?? '',
    isToday: day.isToday === true,
    isPast: day.isPast === true,
    isHoliday: day.isHoliday === true,
    holidayName: textOf(day.holidayName),
    dueCount: Math.max(0, numberOf(day.dueCount) ?? 0),
  };
}

function normalizeWeek(value: unknown, fallbackToday: string): WeekInfo {
  const week = isRecord(value) ? (value as Partial<WeekInfo>) : {};
  const days = Array.isArray(week.days) ? week.days.map(normalizeDay).filter((d): d is WeekDay => d !== null) : [];
  const today = parseYmd(week.today) ? (week.today as string) : fallbackToday;
  return {
    today,
    monday: textOf(week.monday) ?? days[0]?.date ?? today,
    friday: textOf(week.friday) ?? days[days.length - 1]?.date ?? today,
    days,
    overdueCount: Math.max(0, numberOf(week.overdueCount) ?? 0),
    nextBusinessDay: textOf(week.nextBusinessDay) ?? '',
    beforeHolidayBreak: week.beforeHolidayBreak === true,
    breakName: textOf(week.breakName),
  };
}

/** 받은 값이 스냅샷 꼴이 아니면 오류를 던진다. 부분적으로 빈 값은 기본값으로 채운다. */
export function normalizeSnapshot(raw: unknown, now: Date = new Date()): Snapshot {
  if (!isRecord(raw)) throw new Error('스냅샷이 비어 있습니다.');
  if (!Array.isArray(raw.tasks)) throw new Error('스냅샷에 할 일 목록이 없습니다.');
  const tasks = raw.tasks.filter(isTask);
  const groups = groupByBucket(tasks);
  const rawCounts = isRecord(raw.counts) ? raw.counts : {};
  const counts = Object.fromEntries(
    BUCKETS.map((b) => [b, numberOf(rawCounts[b]) ?? groups[b].length]),
  ) as Record<Bucket, number>;
  const out: Snapshot = {
    generatedAt: textOf(raw.generatedAt) ?? '',
    wikiRoot: textOf(raw.wikiRoot) ?? '',
    week: normalizeWeek(raw.week, localYmd(now)),
    tasks,
    counts,
    pageCount: numberOf(raw.pageCount) ?? 0,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [],
    partial: raw.partial === true,
  };
  // 개인 위키 없이 팀 위키 할 일만으로 만든 것(2.9단계 §3)
  if (raw.personalMissing === true) out.personalMissing = true;
  return out;
}

/** 두 스냅샷 중 더 새로 만든 것. 만든 시각을 모르면 나중에 받은 것을 쓴다. */
export function newerSnapshot(current: Snapshot | null, incoming: Snapshot): Snapshot {
  if (!current) return incoming;
  if (current.generatedAt && incoming.generatedAt && incoming.generatedAt < current.generatedAt) return current;
  return incoming;
}

/** IPC 오류의 앞머리("Error invoking remote method '…': Error: ")를 걷어 읽기 쉽게 한다. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(Error|TypeError|RangeError):\s*/i, '')
    .trim();
  return cleaned || '알 수 없는 오류';
}
