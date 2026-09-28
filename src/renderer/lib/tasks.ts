// 할 일 → 화면 표시용 값. React 를 모르는 순수 함수만 둔다(시험하기 쉽게).
import type { Bucket, Task } from '../../shared/types';
import { formatLongDate, formatMonthDay, formatSlash, parseYmd, weekdayShort, yearOf } from './date';

/** 정리 대상 구간의 풀이(사이드바 줄·목록 머리에 쓴다) */
export const STALE_HINT = '오래 밀렸거나 15영업일 넘게 열린 할 일';

/** 구간 순서(스냅샷 tasks 배열 순서와 같다) */
export const BUCKETS: readonly Bucket[] = ['overdue', 'thisWeek', 'chased', 'stale', 'other'];

/** 사이드바에서 구간마다 보여 줄 최대 줄 수 */
export const SIDEBAR_BUCKET_LIMIT = 6;

export type Tone = 'coral' | 'amber' | 'muted';

export interface BucketInfo {
  label: string;
  tone: Tone;
}

export const BUCKET_INFO: Record<Bucket, BucketInfo> = {
  overdue: { label: '지남', tone: 'coral' },
  thisWeek: { label: '이번 주', tone: 'amber' },
  chased: { label: '재촉 중', tone: 'muted' },
  // 2단계 명세 §4: 오래 밀렸거나(기한 30영업일 넘게 지남) 15영업일 넘게 열린 것
  stale: { label: '정리 대상', tone: 'muted' },
  other: { label: '기타', tone: 'muted' },
};

/** 화면에서 쓰는 아이콘 이름(Icons.tsx 의 ICONS 와 짝) */
export type IconName =
  | 'clock'
  | 'calendar'
  | 'bell'
  | 'archive'
  | 'list'
  | 'building'
  | 'chase'
  | 'hourglass'
  | 'progress'
  | 'user'
  | 'flag'
  | 'mail'
  | 'memo';

export const BUCKET_ICON: Record<Bucket, IconName> = {
  overdue: 'clock',
  thisWeek: 'calendar',
  chased: 'bell',
  stale: 'archive',
  other: 'list',
};

// ── 값 꺼내기(스냅샷의 선택 필드는 없거나 비어 있을 수 있다) ──

export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t === '' ? undefined : t;
}

/** 형식이 맞는 기한만 돌려준다 */
export function dueOf(task: Task): string | undefined {
  return parseYmd(task.due) ? task.due : undefined;
}

function positive(value: unknown): number | undefined {
  const n = numberOf(value);
  return n !== undefined && n > 0 ? n : undefined;
}

/** 표시 제목. 비어 있으면 '(제목 없음)' */
export function taskTitle(task: Task): string {
  return textOf(task.title) ?? '(제목 없음)';
}

export function bucketOf(task: Task): Bucket {
  return (BUCKETS as readonly string[]).includes(task.bucket) ? task.bucket : 'other';
}

/** 구간별로 나눈다. 구간 안의 순서는 받은 그대로(스냅샷이 이미 정렬해 둔다). */
export function groupByBucket(tasks: readonly Task[]): Record<Bucket, Task[]> {
  const groups: Record<Bucket, Task[]> = { overdue: [], thisWeek: [], chased: [], stale: [], other: [] };
  for (const task of tasks) groups[bucketOf(task)].push(task);
  return groups;
}

// ── 할 일 줄 왼쪽 칸 ──

export type StripTone = 'overdue' | 'today' | 'day' | 'count' | 'none';

export interface StripCell {
  top: string;
  sub: string;
  tone: StripTone;
  /** 읽기 도구용 풀이 */
  label: string;
}

/**
 * 왼쪽 40px 칸. 지남 "+N/영업일", 오늘 기한 "오늘/마감", 이번 주 다른 날 "목/9/24",
 * 오래 열림 "N/영업일", 그 밖의 기한 "9/30/수", 재촉 "N회/재촉", 우선순위 "P1/우선".
 */
export function stripCell(task: Task, today: string): StripCell {
  const bucket = bucketOf(task);
  const due = dueOf(task);
  if (bucket === 'overdue') {
    const days = numberOf(task.overdueDays);
    return days !== undefined
      ? { top: `+${days}`, sub: '영업일', tone: 'overdue', label: `기한 ${days}영업일 지남` }
      : { top: '지남', sub: '기한', tone: 'overdue', label: '기한 지남' };
  }
  if (due && due === today) return { top: '오늘', sub: '마감', tone: 'today', label: '오늘 마감' };
  if (due && bucket === 'thisWeek') {
    return { top: weekdayShort(due), sub: formatSlash(due), tone: 'day', label: `${formatLongDate(due)} 마감` };
  }
  const openDays = numberOf(task.openDays);
  // 정리 대상: 기한이 오래 지난 것은 지난 영업일 수를, 기한 없는 것은 열린 영업일 수를 보인다.
  // 지남 구간과 달리 코랄로 칠하지 않는다(급한 것을 덮지 않게 한 구간이다).
  const staleOverdue = bucket === 'stale' ? positive(task.overdueDays) : undefined;
  if (staleOverdue !== undefined) {
    return { top: `+${staleOverdue}`, sub: '영업일', tone: 'count', label: `기한 ${staleOverdue}영업일 지남` };
  }
  if (bucket === 'stale' && openDays !== undefined) {
    return { top: String(openDays), sub: '영업일', tone: 'count', label: `${openDays}영업일째 열림` };
  }
  const chase = positive(task.chaseCount);
  const pri = numberOf(task.pri);
  // 재촉 구간에는 들어온 까닭을 보인다: 재촉 2회 이상이면 횟수, 아니면(P1 로 들어옴) 우선순위.
  if (bucket === 'chased' && chase !== undefined && (chase >= 2 || pri !== 1)) {
    return { top: `${chase}회`, sub: '재촉', tone: 'count', label: `재촉 ${chase}회` };
  }
  if (bucket === 'chased' && pri === 1) return { top: 'P1', sub: '우선', tone: 'count', label: '우선순위 1' };
  if (due) return { top: formatSlash(due), sub: weekdayShort(due), tone: 'day', label: `${formatLongDate(due)} 마감` };
  if (chase !== undefined) return { top: `${chase}회`, sub: '재촉', tone: 'count', label: `재촉 ${chase}회` };
  if (pri !== undefined) return { top: `P${pri}`, sub: '우선', tone: 'count', label: `우선순위 ${pri}` };
  return { top: '기한', sub: '없음', tone: 'none', label: '기한 없음' };
}

// ── 할 일 줄 메타(업체 · 재촉 · 진행 중) ──

export interface MetaItem {
  key: string;
  text: string;
  tone?: 'coral' | 'amber';
  icon?: IconName;
}

export function rowMeta(task: Task): MetaItem[] {
  const items: MetaItem[] = [];
  const bucket = bucketOf(task);
  const company = textOf(task.company);
  if (company) items.push({ key: 'company', text: company });

  const chase = positive(task.chaseCount);
  // 재촉 구간은 왼쪽 칸이 이미 재촉·우선을 보여 주므로 열린 기간을 대신 적는다(시안과 같다).
  if (bucket === 'chased') {
    // 왼쪽 칸이 P1 을 보일 때(재촉 1회)는 재촉 횟수를 메타에 남긴다.
    if (chase !== undefined && chase < 2 && numberOf(task.pri) === 1) {
      items.push({ key: 'chase', text: `재촉 ${chase}`, tone: 'coral', icon: 'chase' });
    }
    const openDays = numberOf(task.openDays);
    if (openDays !== undefined) items.push({ key: 'open', text: `열린 지 ${openDays}영업일` });
  } else if (chase !== undefined) {
    items.push({ key: 'chase', text: `재촉 ${chase}`, tone: 'coral', icon: 'chase' });
  }
  if (task.status === 'wip') items.push({ key: 'wip', text: '진행 중', tone: 'amber' });
  return items;
}

// ── 상세 칩 ──

export interface Chip {
  key: string;
  text: string;
  icon: IconName;
  tone?: 'coral' | 'amber';
}

export function detailChips(task: Task, today: string): Chip[] {
  const chips: Chip[] = [];
  const refYear = yearOf(today);
  const bucket = bucketOf(task);
  const company = textOf(task.company);
  if (company) chips.push({ key: 'company', text: company, icon: 'building' });

  const due = dueOf(task);
  if (due) {
    if (bucket !== 'overdue' && due < today) {
      // 정리 대상으로 간 오래 밀린 항목(2단계 §4). 사실은 그대로 적되 지남 구간처럼 코랄로 칠하지는 않는다.
      const days = numberOf(task.overdueDays);
      const tail = days !== undefined ? `, ${days}영업일 지남` : ' 지남';
      chips.push({ key: 'due', text: `기한 ${formatMonthDay(due, refYear)}${tail}`, icon: 'clock' });
    } else if (bucket === 'overdue') {
      const days = numberOf(task.overdueDays);
      const tail = days !== undefined ? `, ${days}영업일 지남` : ' 지남';
      chips.push({ key: 'due', text: `기한 ${formatMonthDay(due, refYear)}${tail}`, icon: 'clock', tone: 'coral' });
    } else if (due === today) {
      chips.push({ key: 'due', text: `기한 오늘, ${formatMonthDay(due, refYear)}`, icon: 'calendar', tone: 'amber' });
    } else {
      chips.push({
        key: 'due',
        text: `기한 ${formatLongDate(due, refYear)}`,
        icon: 'calendar',
        tone: bucket === 'thisWeek' ? 'amber' : undefined,
      });
    }
  }

  const chase = positive(task.chaseCount);
  if (chase !== undefined) chips.push({ key: 'chase', text: `재촉 ${chase}회`, icon: 'chase' });
  const openDays = numberOf(task.openDays);
  if (openDays !== undefined) chips.push({ key: 'open', text: `열림 ${openDays}영업일`, icon: 'hourglass' });
  if (task.status === 'wip') chips.push({ key: 'wip', text: '진행 중', icon: 'progress', tone: 'amber' });
  // [st:: 값] — 줄에 적힌 진행 메모(진행·확인·협의…). 상태에는 영향이 없다(2단계 §4).
  const st = textOf(task.st);
  if (st) chips.push({ key: 'st', text: `메모 상태: ${st}`, icon: 'memo' });
  const owner = textOf(task.owner);
  if (owner) chips.push({ key: 'owner', text: `담당 ${owner}`, icon: 'user' });
  const pri = numberOf(task.pri);
  if (pri !== undefined) chips.push({ key: 'pri', text: `우선 P${pri}`, icon: 'flag' });
  const opened = parseYmd(task.opened) ? task.opened : undefined;
  if (opened && textOf(task.mail)) {
    chips.push({ key: 'mail', text: `${formatMonthDay(opened, refYear)} 메일에서 등록`, icon: 'mail' });
  }
  return chips;
}

// ── 출처(src) ──

export interface SourceRef {
  key: string;
  /** 문서 이름(경로 끝 조각, .md 뗌) */
  name: string;
  /** 폴더 경로(없으면 undefined) */
  folder?: string;
  /** .md 경로면 Obsidian 으로 열 볼트 기준 경로 */
  openPath?: string;
}

/** 'a.md · b · c.md' 처럼 ' · '로 나뉜 출처를 조각낸다. .md 로 끝나는 조각만 열 수 있다. */
export function splitSources(src: unknown): SourceRef[] {
  const text = textOf(src);
  if (!text) return [];
  return text
    .split(' · ')
    .map((part) => part.trim().replace(/^`+|`+$/g, '').trim())
    .filter((part) => part !== '')
    .map((part, index) => {
      const norm = part.replace(/\\/g, '/');
      const isMd = /\.md$/i.test(norm);
      const cut = norm.lastIndexOf('/');
      const base = cut >= 0 ? norm.slice(cut + 1) : norm;
      return {
        key: `${index}:${norm}`,
        name: isMd ? base.replace(/\.md$/i, '') : base,
        folder: cut > 0 ? norm.slice(0, cut) : undefined,
        openPath: isMd ? norm : undefined,
      };
    });
}

// ── 메일 보낸 사람 ──

/** '한결케미칼 EHS팀 <ehs@x>' → '한결케미칼 EHS팀'. 이름이 없으면 주소. */
export function senderName(from: unknown): string | undefined {
  const text = textOf(from);
  if (!text) return undefined;
  const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(text);
  if (!m) return text;
  return m[1].trim() || m[2].trim();
}

/** 볼트 경로의 파일 이름(.md 뗌) */
export function fileLabel(path: string): string {
  const norm = path.replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
