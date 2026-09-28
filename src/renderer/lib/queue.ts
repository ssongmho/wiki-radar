// 반영 대기열·Claude 실행(2단계 명세 §2·§3) → 화면 표시값. React 를 모르는 순수 함수만 둔다.
// main 이 보낸 값이 계약과 조금 달라도 화면이 깨지지 않게 다듬는다.
import type { QueueItem, ReflectRun, TaskStatus } from '../../shared/types';
import { formatHourMinute, formatMailDate, formatMonthDay, localYmd, yearOf } from './date';
import { isTaskStatus, statusLabel } from './result';
import { textOf } from './tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

function normalizeItem(value: unknown): QueueItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;
  const item: QueueItem = {
    id: value.id,
    kind: value.kind === 'decision' ? 'decision' : 'task',
    createdAt: textOf(value.createdAt) ?? '',
    title: textOf(value.title) ?? '(제목 없음)',
    note: typeof value.note === 'string' ? value.note : '',
  };
  const status = value.status;
  if (isTaskStatus(status)) item.status = status;
  for (const key of ['taskId', 'owner', 'company', 'file', 'mail', 'src', 'context'] as const) {
    const text = textOf(value[key]);
    if (text) item[key] = text;
  }
  return item;
}

/** 대기열 응답 → 항목 배열(모양이 틀린 항목은 버린다, 같은 id 는 하나만) */
export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: QueueItem[] = [];
  for (const v of raw) {
    const item = normalizeItem(v);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 실행 기록 응답 → ReflectRun. 모양이 틀리면 null */
export function normalizeRun(raw: unknown): ReflectRun | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return null;
  const state = raw.state === 'running' || raw.state === 'done' || raw.state === 'failed' ? raw.state : 'failed';
  const run: ReflectRun = {
    id: raw.id,
    startedAt: textOf(raw.startedAt) ?? '',
    state,
    itemIds: strings(raw.itemIds),
    log: strings(raw.log),
  };
  const finishedAt = textOf(raw.finishedAt);
  if (finishedAt) run.finishedAt = finishedAt;
  const summary = textOf(raw.summary);
  if (summary) run.summary = summary;
  if (Array.isArray(raw.changed)) run.changed = strings(raw.changed);
  if (Array.isArray(raw.skipped)) {
    run.skipped = raw.skipped
      .filter(isRecord)
      .map((s) => ({ title: textOf(s.title) ?? '(제목 없음)', reason: textOf(s.reason) ?? '이유가 적혀 있지 않습니다.' }));
  }
  const error = textOf(raw.error);
  if (error) run.error = error;
  return run;
}

/**
 * 두 실행 기록 중 화면에 둘 것. 같은 실행이면 끝난 쪽이 이긴다(늦게 온 running 이 done 을 덮지 않게).
 * 다른 실행이면 나중에 시작한 것.
 */
export function newerRun(current: ReflectRun | null, incoming: ReflectRun | null): ReflectRun | null {
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.id === incoming.id) {
    if (current.state !== 'running' && incoming.state === 'running') return current;
    return incoming;
  }
  if (current.startedAt && incoming.startedAt && incoming.startedAt < current.startedAt) return current;
  return incoming;
}

/** 경과 시간 '35초' · '1분 20초' · '1시간 2분' */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return s > 0 ? `${m}분 ${s}초` : `${m}분`;
  return `${s}초`;
}

/** 실행이 걸린(또는 지금까지 걸린) 시간. 시각을 모르면 null */
export function runElapsed(run: ReflectRun, nowMs: number): number | null {
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return null;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** 대기열 항목의 상태 풀이: '완료', '내 일 아님 → 김담당', 판단 결정은 '판단 결정' */
export function queueStatusText(item: QueueItem): string {
  if (item.kind === 'decision') return '판단 결정';
  if (!item.status) return '상태 없음';
  const label = statusLabel(item.status as TaskStatus);
  return item.status === 'notmine' && item.owner ? `${label} → ${item.owner}` : label;
}

/** 대기열에 넣은 시각 '9월 23일 오후 5:28'(올해면 해 생략) */
export function queueTimeText(createdAt: string, today: string): string {
  return formatMailDate(createdAt, { refYear: yearOf(today) });
}

export interface ChangedFile {
  path: string;
  /** Obsidian 으로 열 수 있는 볼트 기준 .md 경로(아니면 없음 — 글자로만 보인다) */
  openPath?: string;
}

/** Claude 가 보고한 바뀐 파일. '\'를 '/'로 맞추고, 볼트 안 상대 .md 경로만 열 수 있게 한다 */
export function changedFiles(changed: readonly string[] | undefined): ChangedFile[] {
  const out: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const raw of changed ?? []) {
    const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const relative = !/^[a-zA-Z]:/.test(path) && !path.startsWith('/') && !path.split('/').includes('..');
    out.push(relative && /\.md$/i.test(path) ? { path, openPath: path } : { path });
  }
  return out;
}

/**
 * 실행 결과 머리 문장. 마지막 실행 기록은 며칠 뒤에도 보이고 그사이 대기열이 바뀔 수 있으므로(빼기·다시 저장),
 * 실패는 지금 대기열 상태가 아니라 그 실행 때 한 일로 말한다.
 */
export function runHeadline(run: ReflectRun): string {
  if (run.state === 'running') return 'Claude가 위키에 반영하는 중입니다.';
  if (run.state === 'failed') return '반영하지 못했습니다. 그때 보낸 항목은 대기열에 남겨 두었습니다.';
  return '반영을 마쳤습니다.';
}

/**
 * 실행 시각(시작·끝남): 오늘이면 '오전 9:33', 다른 날이면 '9월 18일 오전 9:33'(해가 다르면 해도) — 이 PC 시간대.
 * 앱을 다시 켜면 며칠 전 실행이 '마지막 반영'으로 보이므로 날짜 없이 시각만 적으면 오늘 일로 읽힌다.
 * 알아볼 수 없는 값이면 빈 문자열.
 */
export function runTimeText(iso: unknown, today: string): string {
  if (typeof iso !== 'string' || iso.trim() === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const clock = formatHourMinute(d.getHours(), d.getMinutes());
  const day = localYmd(d);
  return day === today ? clock : `${formatMonthDay(day, yearOf(today))} ${clock}`;
}
