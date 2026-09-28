// 구간 결정과 구간별 정렬 (1단계 명세 §2 + 2단계 명세 §4 보정).
import type { Bucket, Task } from '../../shared/types';
import type { BusinessCalendar } from './calendar';

export const BUCKET_ORDER: readonly Bucket[] = ['overdue', 'thisWeek', 'chased', 'stale', 'other'];

/** 기한 없는 할 일이 이 영업일 수 이상 열려 있으면 정리 대상 */
export const STALE_OPEN_DAYS = 15;
/** 기한이 이 영업일 수를 **넘게** 지나면 지남이 아니라 정리 대상(2단계 명세 §4) */
export const STALE_OVERDUE_DAYS = 30;

/** 구간 판단에 필요한 값만 */
export interface BucketInput {
  due?: string;
  chaseCount?: number;
  pri?: number;
  openDays?: number;
  /** 기한이 지난 영업일 수(due < today 일 때 호출하는 쪽이 계산해 넘긴다). 없으면 지남으로 본다 */
  overdueDays?: number;
}

/**
 * 앞이 우선: 지남 > 이번 주 > 재촉 > 정리 대상 > 기타.
 * 정리 대상(stale) = (기한 없음 && openDays >= 15) || (기한 있음 && overdueDays > 30) — 오래 밀린 옛 항목이
 * 지남 구간의 진짜 급한 것을 덮지 않게 한다(2단계 명세 §4). 기한이 앞으로 남은 것은 오래 열려 있어도 정리 대상이 아니다.
 */
export function bucketOf(t: BucketInput, today: string, friday: string): Bucket {
  if (t.due !== undefined) {
    if (t.due < today) return (t.overdueDays ?? 0) > STALE_OVERDUE_DAYS ? 'stale' : 'overdue';
    if (t.due <= friday) return 'thisWeek';
    return 'other';
  }
  if ((t.chaseCount ?? 0) >= 2 || t.pri === 1) return 'chased';
  if ((t.openDays ?? 0) >= STALE_OPEN_DAYS) return 'stale';
  return 'other';
}

/** 지남 구간의 영업일 수: due 다음날부터 오늘까지(오늘 포함) */
export function overdueDaysOf(due: string, today: string, cal: BusinessCalendar): number {
  return cal.businessDaysAfter(due, today);
}

const collator = new Intl.Collator('ko');

function byTitle(a: Task, b: Task): number {
  return collator.compare(a.title, b.title);
}

/** due 오름차순(기한 없는 것은 뒤) → 제목 */
function byDue(a: Task, b: Task): number {
  if (a.due !== b.due) {
    if (a.due === undefined) return 1;
    if (b.due === undefined) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return byTitle(a, b);
}

/** chaseCount 내림차순(없으면 0) → pri 오름차순(없으면 9) → 제목 */
function byChase(a: Task, b: Task): number {
  const ca = a.chaseCount ?? 0;
  const cb = b.chaseCount ?? 0;
  if (ca !== cb) return cb - ca;
  const pa = a.pri ?? 9;
  const pb = b.pri ?? 9;
  if (pa !== pb) return pa - pb;
  return byTitle(a, b);
}

/** 정리 대상: overdueDays 내림차순(없으면 0) → openDays 내림차순(없으면 0) → 제목 */
function byStale(a: Task, b: Task): number {
  const da = a.overdueDays ?? 0;
  const db = b.overdueDays ?? 0;
  if (da !== db) return db - da;
  const oa = a.openDays ?? 0;
  const ob = b.openDays ?? 0;
  if (oa !== ob) return ob - oa;
  return byTitle(a, b);
}

export function comparatorFor(bucket: Bucket): (a: Task, b: Task) => number {
  switch (bucket) {
    case 'chased':
      return byChase;
    case 'stale':
      return byStale;
    default:
      return byDue;
  }
}

/** 구간 순서대로, 구간 안에서는 정렬 규칙대로 이어 붙인다. */
export function orderTasks(tasks: readonly Task[]): { tasks: Task[]; counts: Record<Bucket, number> } {
  const groups: Record<Bucket, Task[]> = { overdue: [], thisWeek: [], chased: [], stale: [], other: [] };
  for (const t of tasks) groups[t.bucket].push(t);
  const out: Task[] = [];
  const counts = { overdue: 0, thisWeek: 0, chased: 0, stale: 0, other: 0 } as Record<Bucket, number>;
  for (const b of BUCKET_ORDER) {
    const list = groups[b].slice().sort(comparatorFor(b));
    counts[b] = list.length;
    out.push(...list);
  }
  return { tasks: out, counts };
}
