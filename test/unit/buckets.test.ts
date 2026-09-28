// 구간 결정·정렬 (1단계 명세 §2 + 2단계 명세 §4 보정)
import { describe, expect, it } from 'vitest';
import type { Bucket, Task } from '../../src/shared/types';
import { bucketOf, orderTasks } from '../../src/main/wiki/buckets';

const TODAY = '2026-09-23';
const FRIDAY = '2026-09-25';

describe('구간', () => {
  it.each<[string, Parameters<typeof bucketOf>[0], Bucket]>([
    ['기한 지남', { due: '2026-09-22' }, 'overdue'],
    ['지남이 재촉보다 앞선다', { due: '2026-09-01', chaseCount: 5, pri: 1, openDays: 30 }, 'overdue'],
    ['오늘 기한', { due: '2026-09-23' }, 'thisWeek'],
    ['금요일 기한', { due: '2026-09-25' }, 'thisWeek'],
    ['다음 주 기한', { due: '2026-09-28' }, 'other'],
    ['기한 있으면 재촉이 아니다', { due: '2026-09-28', chaseCount: 3 }, 'other'],
    // 2단계 §4: 정리 대상 = (기한 없음 && openDays >= 15) || (기한 있음 && overdueDays > 30)
    ['기한이 남았으면 오래 열려도 정리 대상이 아니다', { due: '2026-10-30', openDays: 20 }, 'other'],
    ['이번 주 기한은 오래 열려도 이번 주', { due: '2026-09-24', openDays: 40 }, 'thisWeek'],
    ['30영업일 지남은 지남', { due: '2026-08-11', overdueDays: 30 }, 'overdue'],
    ['30영업일 넘게 지나면 정리 대상', { due: '2026-08-10', overdueDays: 31 }, 'stale'],
    ['오래 밀린 것은 재촉·우선이어도 정리 대상', { due: '2026-07-15', overdueDays: 49, chaseCount: 3, pri: 1 }, 'stale'],
    ['지난 영업일 수를 모르면 지남', { due: '2026-07-15' }, 'overdue'],
    ['기한 없음 15영업일 이상은 정리 대상', { openDays: 38, pri: 3 }, 'stale'],
    ['재촉 2회', { chaseCount: 2 }, 'chased'],
    ['재촉 1회', { chaseCount: 1 }, 'other'],
    ['pri 1', { pri: 1 }, 'chased'],
    ['pri 2', { pri: 2 }, 'other'],
    ['재촉이 오래 열림보다 앞선다', { chaseCount: 3, openDays: 26 }, 'chased'],
    ['15영업일', { openDays: 15 }, 'stale'],
    ['14영업일', { openDays: 14 }, 'other'],
    ['아무것도 없음', {}, 'other'],
  ])('%s', (_name, input, expected) => {
    expect(bucketOf(input, TODAY, FRIDAY)).toBe(expected);
  });
});

function t(title: string, bucket: Bucket, extra: Partial<Task> = {}): Task {
  return { id: title, source: 'checkbox', title, status: 'open', bucket, ...extra };
}

describe('정렬', () => {
  it('구간 순서대로 이어 붙이고 counts 를 센다', () => {
    const { tasks, counts } = orderTasks([
      t('기타', 'other'),
      t('오래', 'stale', { openDays: 20 }),
      t('재촉', 'chased', { chaseCount: 2 }),
      t('이번', 'thisWeek', { due: '2026-09-24' }),
      t('지남', 'overdue', { due: '2026-09-01' }),
    ]);
    expect(tasks.map((x) => x.title)).toEqual(['지남', '이번', '재촉', '오래', '기타']);
    expect(counts).toEqual({ overdue: 1, thisWeek: 1, chased: 1, stale: 1, other: 1 });
  });

  it('기한 오름차순, 기한 없는 것은 뒤, 같으면 제목(ko)', () => {
    const { tasks } = orderTasks([
      t('하', 'other'),
      t('다', 'other', { due: '2026-10-01' }),
      t('나', 'other', { due: '2026-09-30' }),
      t('가', 'other', { due: '2026-10-01' }),
      t('마', 'other'),
      t('라', 'other'),
    ]);
    expect(tasks.map((x) => x.title)).toEqual(['나', '가', '다', '라', '마', '하']);
  });

  it('재촉: 재촉 수 내림차순 → pri 오름차순(없으면 9) → 제목', () => {
    const { tasks } = orderTasks([
      t('다', 'chased', { pri: 1 }),
      t('가', 'chased', { chaseCount: 2, pri: 3 }),
      t('나', 'chased', { chaseCount: 2 }),
      t('라', 'chased', { chaseCount: 4 }),
      t('마', 'chased', { chaseCount: 2, pri: 2 }),
      t('바', 'chased', { pri: 1 }),
    ]);
    expect(tasks.map((x) => x.title)).toEqual(['라', '마', '가', '나', '다', '바']);
  });

  it('정리 대상: 열린 날 내림차순 → 제목', () => {
    const { tasks } = orderTasks([
      t('나', 'stale', { openDays: 20 }),
      t('가', 'stale', { openDays: 20 }),
      t('다', 'stale', { openDays: 38 }),
    ]);
    expect(tasks.map((x) => x.title)).toEqual(['다', '가', '나']);
  });

  it('정리 대상: 지난 영업일 내림차순(없으면 0) → 열린 날 내림차순 → 제목 (2단계 §4)', () => {
    const { tasks } = orderTasks([
      t('명함', 'stale', { openDays: 38 }),
      t('견적', 'stale', { due: '2026-07-15', overdueDays: 49 }),
      t('계약', 'stale', { due: '2026-08-01', overdueDays: 37, openDays: 5 }),
      t('보고', 'stale', { due: '2026-08-01', overdueDays: 37, openDays: 40 }),
      t('나', 'stale', { openDays: 15 }),
      t('가', 'stale', { openDays: 15 }),
    ]);
    expect(tasks.map((x) => x.title)).toEqual(['견적', '보고', '계약', '명함', '가', '나']);
  });
});
