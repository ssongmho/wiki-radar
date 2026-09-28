// 반영 대기열 저장소(<데이터 폴더>/queue.json). electron 을 import 하지 않는다. 계약: docs/stage2-contract.md §2·§7
//
// - 파일 형식: QueueItem 배열(JSON). 오래된 것부터.
// - 저장은 같은 폴더의 임시 파일에 쓰고 fsync 한 뒤 이름을 바꾼다(원자적 쓰기) — 쓰는 도중 앱이 죽어도
//   queue.json 은 이전 내용 아니면 새 내용이다.
// - 깨진 파일(JSON 아님·형식이 다름)은 `<파일>.broken-<시각>` 으로 옮기고 빈 상태로 시작하며 경고를 남긴다.
//   읽을 수 없는 파일(잠김 등)은 덮어쓰지 않도록 예외를 던진다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { QueueItem, TaskStatus } from '../shared/types';
import { errCode, readTextFile, sleepSync } from './wiki/fsutil';

export type NewQueueItem = Omit<QueueItem, 'id' | 'createdAt'> & { id?: string; createdAt?: string };

export const QUEUE_FILE = 'queue.json';

// ---- JSON 파일 저장 도우미(대기열과 실행 기록이 함께 쓴다) -------------------------------

/** 이름 바꾸기가 잠깐 막힐 때(백신·검색 색인이 새 파일을 붙잡은 순간) 다시 해 볼 간격 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 60, 150, 300];
const RENAME_TRANSIENT: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'UNKNOWN']);

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !RENAME_TRANSIENT.has(errCode(err))) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * 원자적 쓰기: 같은 폴더의 임시 파일에 쓰고 fsync → 이름 바꾸기. 실패하면 임시 파일을 지우고
 * 사람이 읽는 문장의 오류를 던진다(원래 파일은 그대로).
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `${base}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 임시 파일 정리 실패는 무시한다(다음 저장에 영향 없음)
    }
    throw new Error(`${base} 를 저장하지 못했습니다 (${errCode(err)})`, { cause: err });
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 로컬 시각 YYYYMMDDTHHMMSS (백업 폴더 이름과 같은 꼴) */
export function compactStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** `<파일>.broken-<시각>` 중 아직 없는 이름 */
function brokenPathFor(filePath: string): string {
  const base = `${filePath}.broken-${compactStamp()}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const p = `${base}-${i}`;
    if (!fs.existsSync(p)) return p;
  }
}

/** 깨진 파일을 옆으로 옮긴다(move) 또는 복사한다(copy). 옮긴 파일 경로(실패하면 null)를 돌려준다 */
function setAsideBroken(filePath: string, how: 'move' | 'copy'): string | null {
  const target = brokenPathFor(filePath);
  try {
    if (how === 'move') renameWithRetry(filePath, target);
    else fs.copyFileSync(filePath, target);
    return target;
  } catch {
    if (how === 'move') {
      // 옮기지 못하면 복사라도 해 둔다 — 다음 저장이 원래 파일을 덮어써도 내용이 남게
      try {
        fs.copyFileSync(filePath, target);
        return target;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface JsonStoreLoad<T> {
  items: T[];
  /** 형식이 맞지 않아 버린 원소 수 */
  dropped: number;
}

/**
 * JSON 배열 파일을 읽는다. 파일이 없으면 빈 배열. JSON 이 아니거나 배열이 아니면 `.broken-<시각>` 으로
 * 옮기고 경고 후 빈 배열. 일부 원소만 형식이 틀리면 원래 파일을 `.broken-<시각>` 으로 복사해 두고
 * 맞는 것만 돌려준다. 읽지 못하면(잠김 등) 덮어쓰지 않도록 예외를 던진다.
 */
export function loadJsonArray<T>(
  filePath: string,
  label: string,
  parseItem: (raw: unknown) => T | null,
  onWarn?: (message: string) => void,
): JsonStoreLoad<T> {
  const base = path.basename(filePath);
  let text: string;
  try {
    text = readTextFile(filePath);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { items: [], dropped: 0 };
    throw new Error(`${label}(${base})을 읽지 못했습니다 (${errCode(err)}) — 덮어쓰지 않도록 멈춥니다`, { cause: err });
  }

  let data: unknown;
  let reason: string | null = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    reason = text.trim() === '' ? '빈 파일' : `JSON 이 아님: ${errCode(err)}`;
  }
  if (reason === null) {
    // 손으로 고친 파일 등을 위해 { items: [...] } 도 받는다
    if (data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { items?: unknown }).items)) {
      data = (data as { items: unknown[] }).items;
    }
    if (!Array.isArray(data)) reason = '배열이 아님';
  }
  if (reason !== null) {
    const moved = setAsideBroken(filePath, 'move');
    onWarn?.(
      `${label}(${base})이 깨져 있어 빈 상태로 시작합니다. ` +
        (moved ? `원래 파일은 ${path.basename(moved)} 로 옮겼습니다` : '원래 파일을 옮기지 못했습니다') +
        ` (원인: ${reason})`,
    );
    return { items: [], dropped: 0 };
  }

  const items: T[] = [];
  let dropped = 0;
  for (const raw of data as unknown[]) {
    const item = parseItem(raw);
    if (item) items.push(item);
    else dropped++;
  }
  if (dropped > 0) {
    const copied = setAsideBroken(filePath, 'copy');
    onWarn?.(
      `${label}(${base})에서 형식이 맞지 않는 항목 ${dropped}건을 뺐습니다.` +
        (copied ? ` 원래 파일은 ${path.basename(copied)} 로 복사해 두었습니다` : ''),
    );
  }
  return { items, dropped };
}

// ---- 대기열 --------------------------------------------------------------------------------

const STATUSES: ReadonlySet<string> = new Set<TaskStatus>(['open', 'wip', 'done', 'notmine']);
const OPTIONAL_STRING_FIELDS = ['taskId', 'owner', 'company', 'file', 'mail', 'src', 'context'] as const;

/** 저장·읽기 공용 정규화. 알려진 필드만 남기고 빈 선택 필드는 뺀다. 형식이 틀리면 null */
function toQueueItem(raw: unknown): QueueItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  if (r.kind !== 'task' && r.kind !== 'decision') return null;
  if (typeof r.createdAt !== 'string' || r.createdAt === '') return null;
  if (typeof r.title !== 'string') return null;
  if (typeof r.note !== 'string') return null;
  const item: QueueItem = { id: r.id, kind: r.kind, createdAt: r.createdAt, title: r.title, note: r.note };
  if (r.status !== undefined && r.status !== null) {
    if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return null;
    item.status = r.status as TaskStatus;
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    const v = r[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return null;
    if (v !== '') item[key] = v;
  }
  return item;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** 오래된 것부터. 같은 시각이면 들어온 순서(안정 정렬) */
function sortOldestFirst(items: QueueItem[]): QueueItem[] {
  return items
    .map((item, i) => ({ item, i, t: timeOf(item.createdAt) }))
    .sort((a, b) => (a.t !== b.t ? a.t - b.t : a.i - b.i))
    .map((x) => x.item);
}

function copyItem(item: QueueItem): QueueItem {
  return { ...item };
}

export class QueueStore {
  private readonly file: string;
  private readonly onWarn?: (message: string) => void;
  /** 처음 쓸 때 읽는다. 읽지 못했으면(예외) null 로 남아 다음에 다시 읽는다 */
  private items: QueueItem[] | null = null;

  constructor(dataDir: string, onWarn?: (message: string) => void) {
    this.file = path.join(dataDir, QUEUE_FILE);
    this.onWarn = onWarn;
  }

  /** queue.json 절대경로 */
  get filePath(): string {
    return this.file;
  }

  private load(): QueueItem[] {
    if (this.items) return this.items;
    const { items } = loadJsonArray(this.file, '반영 대기열', toQueueItem, this.onWarn);
    // 같은 id 가 두 번 있으면 앞의 것만
    const seen = new Set<string>();
    const unique = items.filter((x) => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    });
    this.items = sortOldestFirst(unique);
    return this.items;
  }

  /** 디스크에 먼저 쓰고, 성공했을 때만 메모리에 반영한다(실패하면 예외, 상태는 그대로) */
  private commit(next: QueueItem[]): void {
    writeJsonAtomic(this.file, next);
    this.items = next;
  }

  /** 오래된 것부터 */
  list(): QueueItem[] {
    return this.load().map(copyItem);
  }

  /** 추가. 같은 taskId(kind 'task')가 있으면 새 것으로 교체한다 */
  add(item: NewQueueItem): QueueItem {
    const current = this.load();
    const entry = toQueueItem({
      ...item,
      id: item.id ?? crypto.randomUUID(),
      createdAt: item.createdAt ?? new Date().toISOString(),
    });
    if (!entry) throw new Error('대기열 항목 형식이 맞지 않습니다(kind·title·note·status 확인)');
    const replaces = (x: QueueItem): boolean =>
      x.id === entry.id ||
      (entry.kind === 'task' && entry.taskId !== undefined && x.kind === 'task' && x.taskId === entry.taskId);
    this.commit(sortOldestFirst([...current.filter((x) => !replaces(x)), entry]));
    return copyItem(entry);
  }

  remove(id: string): QueueItem[] {
    return this.removeMany([id]);
  }

  removeMany(ids: string[]): QueueItem[] {
    const current = this.load();
    const drop = new Set(ids);
    const next = current.filter((x) => !drop.has(x.id));
    if (next.length !== current.length) this.commit(next);
    return this.list();
  }
}
