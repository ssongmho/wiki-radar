// IPC 핸들러 — renderer 요청의 유일한 입구. 계약: docs/stage1-contract.md §5, docs/stage2-contract.md §1·§2
// 모든 인자는 타입·길이를 검사하고, 우리 창이 보낸 요청만 받는다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { IPC, PARTIAL_SAVE_PREFIX, type IpcReply } from '../shared/ipc';
import type {
  Holiday,
  MailSummary,
  QueueItem,
  ReflectRun,
  SaveResultInput,
  SaveResultOutput,
  Snapshot,
  Task,
  TaskStatus,
  WindowMode,
} from '../shared/types';
import { buildSnapshot } from './wiki/snapshot';
import { readMailSummary } from './wiki/mail';
import { PartialWriteError, applyWriteback, type WritebackResult } from './wiki/writeback';
import type { NewQueueItem, QueueStore } from './queue';
import { isReflectRunning, runReflect, stopActiveReflect, type ReflectHistory } from './reflect';
import {
  MAX_NOTE_LENGTH,
  MAX_OWNER_LENGTH,
  MAX_QUEUE_ID_LENGTH,
  MAX_REL_PATH_LENGTH,
  MAX_TASK_ID_LENGTH,
  type ClaudeLocation,
} from './config';

const LOG = '[wiki-radar]';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// 스냅샷 캐시

export interface SnapshotServiceOptions {
  wikiRoot: string;
  holidays: Holiday[];
  /** 지금의 '오늘'(YYYY-MM-DD, 로컬) */
  getToday: () => string;
  /** 스냅샷을 새로 만들 때마다(어느 경로로든). index.ts 가 부분 스냅샷의 재시도를 여기서 건다 */
  onBuilt?: (snapshot: Snapshot) => void;
}

/** 마지막으로 만든 스냅샷을 들고 있다. 날짜가 바뀌었으면 다시 만든다. */
export class SnapshotService {
  private cache: Snapshot | null = null;
  private cacheDay: string | null = null;

  constructor(private readonly opts: SnapshotServiceOptions) {}

  /**
   * 캐시된 스냅샷. 없거나 날짜가 지난 것이면 지금 만든다.
   * 만들지 못하면 — 이전 것이 있으면 그것을 주고, 없으면 사람이 읽을 문장으로 예외를 던진다.
   */
  current(): Snapshot {
    const today = this.opts.getToday();
    if (this.cache && this.cacheDay === today) return this.cache;
    try {
      return this.build(today);
    } catch (err) {
      if (this.cache) {
        console.error(`${LOG} 스냅샷을 새로 만들지 못해 이전 것을 씀:`, describeError(err));
        return this.cache;
      }
      throw err;
    }
  }

  /** 지금 다시 만든다. 실패하면 로그만 남기고 null(이전 캐시는 그대로 둔다). */
  refresh(): Snapshot | null {
    try {
      return this.build(this.opts.getToday());
    } catch (err) {
      console.error(`${LOG} 스냅샷 재생성 실패:`, describeError(err));
      return null;
    }
  }

  private build(today: string): Snapshot {
    const { wikiRoot, holidays } = this.opts;
    if (!fs.existsSync(wikiRoot)) {
      throw new Error(`위키 폴더를 찾을 수 없습니다: ${wikiRoot} (WIKI_RADAR_WIKI 설정을 확인하세요)`);
    }
    let snapshot: Snapshot;
    try {
      snapshot = buildSnapshot({ wikiRoot, today, holidays });
    } catch (err) {
      throw new Error(`위키에서 할 일을 읽지 못했습니다: ${describeError(err)}`);
    }
    this.cache = snapshot;
    this.cacheDay = today;
    try {
      this.opts.onBuilt?.(snapshot);
    } catch (err) {
      console.warn(`${LOG} onBuilt 오류:`, describeError(err));
    }
    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// 방송(main → 모든 창)

function broadcast(channel: string, payload: unknown, what: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      console.warn(`${LOG} ${what}을 창에 보내지 못함:`, describeError(err));
    }
  }
}

/** 열려 있는 모든 창에 새 스냅샷을 보낸다. */
export function broadcastSnapshot(snapshot: Snapshot): void {
  broadcast(IPC.snapshot, snapshot, '스냅샷');
}

/** 반영 대기열이 바뀌었음을 알린다(추가·삭제·반영 완료). */
export function broadcastQueue(queue: QueueItem[]): void {
  broadcast(IPC.queue, queue, '반영 대기열');
}

/** claude 실행의 진행 상황을 알린다. */
export function broadcastReflect(run: ReflectRun): void {
  broadcast(IPC.reflect, run, '반영 진행 상황');
}

// ---------------------------------------------------------------------------
// 인자 검사

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`잘못된 요청입니다: ${name} 값이 문자열이 아닙니다`);
  if (value.length === 0 || value.length > maxLength) {
    throw new Error(`잘못된 요청입니다: ${name} 길이는 1~${maxLength}자여야 합니다`);
  }
  // 제어 문자(NUL·줄바꿈 등)는 경로·ID 어디에도 들어갈 일이 없다.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`잘못된 요청입니다: ${name}에 제어 문자가 있습니다`);
  return value;
}

function requireMode(value: unknown): WindowMode {
  if (value === 'sidebar' || value === 'full') return value;
  throw new Error('잘못된 요청입니다: mode 는 sidebar 또는 full 이어야 합니다');
}

const TASK_STATUSES: readonly TaskStatus[] = ['open', 'wip', 'done', 'notmine'];

function requireStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error('잘못된 요청입니다: status 는 open·wip·done·notmine 중 하나여야 합니다');
}

/** 담당자(한 줄). 없거나 공백뿐이면 undefined — sync_todo 처럼 '타담당'으로 쓰인다. */
function optionalOwner(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('잘못된 요청입니다: owner 값이 문자열이 아닙니다');
  if (value.length > MAX_OWNER_LENGTH) throw new Error(`담당자는 ${MAX_OWNER_LENGTH}자까지 쓸 수 있습니다`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('담당자에는 줄바꿈·제어 문자를 쓸 수 없습니다');
  // 줄 끝의 [owner:: 값] 필드와 로그의 '담당 **값**'에 그대로 들어간다. 대괄호는 필드를 깨뜨린다.
  if (/[[\]]/.test(value)) throw new Error('담당자에는 대괄호([ ])를 쓸 수 없습니다');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 처리 내용(여러 줄). 줄바꿈은 \n 으로 맞춘다. 없거나 공백뿐이면 undefined — 메모를 쓰지 않는다. */
function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('잘못된 요청입니다: note 값이 문자열이 아닙니다');
  if (value.length > MAX_NOTE_LENGTH) throw new Error(`처리 내용은 ${MAX_NOTE_LENGTH}자까지 쓸 수 있습니다`);
  const note = value.replace(/\r\n?/g, '\n');
  // 줄바꿈·탭 말고 제어 문자(NUL 등)는 마크다운 파일에 들어갈 일이 없다.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(note)) throw new Error('처리 내용에 쓸 수 없는 제어 문자가 있습니다');
  return note.trim() === '' ? undefined : note;
}

function requireSaveInput(value: unknown): SaveResultInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('잘못된 요청입니다: 저장 입력이 객체가 아닙니다');
  }
  const v = value as Record<string, unknown>;
  const taskId = requireString(v.taskId, 'taskId', MAX_TASK_ID_LENGTH);
  const status = requireStatus(v.status);
  const owner = optionalOwner(v.owner);
  const note = optionalNote(v.note);
  if (typeof v.reflect !== 'boolean') throw new Error('잘못된 요청입니다: reflect 값이 참·거짓이 아닙니다');
  const input: SaveResultInput = { taskId, status, reflect: v.reflect };
  if (owner !== undefined) input.owner = owner;
  if (note !== undefined) input.note = note;
  return input;
}

/**
 * 볼트 기준 상대경로를 위키 안의 .md 절대경로로 바꾼다. 위키 밖이거나 .md 가 아니면 null.
 * Windows 경로는 대소문자를 가리지 않으므로 비교도 대소문자를 무시한다.
 */
export function resolveWikiMarkdown(wikiRoot: string, relPath: string): string | null {
  const root = path.resolve(wikiRoot);
  const abs = path.resolve(root, relPath);
  const rootKey = root.toLowerCase().replace(/[\\/]+$/, '');
  const absKey = abs.toLowerCase();
  if (!absKey.startsWith(rootKey + path.sep)) return null;
  if (!absKey.endsWith('.md')) return null;
  return abs;
}

/**
 * 열어도 되는 문서 파일인가. 없는 파일·폴더면 거짓(Obsidian 이 빈 문서를 만들지 않게).
 * OneDrive 자리표시자처럼 stat 이 다른 이유로 실패하면 있다고 보고 Obsidian 에 맡긴다.
 */
function markdownMayExist(abs: string): boolean {
  try {
    return !fs.statSync(abs).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** raw/mail/…md 모양인가(자세한 검사는 readMailSummary 가 한다). */
function looksLikeMailPath(relPath: string): boolean {
  return /^raw\/mail\/.+\.md$/i.test(relPath.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// 직렬 실행 — 처리 결과 저장은 한 번에 하나씩(같은 파일을 두 저장이 겹쳐 쓰지 않게)

function createSerialQueue(): <T>(job: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

// ---------------------------------------------------------------------------
// 위키 반영(claude -p) 실행 관리

export interface ReflectControllerOptions {
  wikiRoot: string;
  queue: () => QueueStore;
  history: () => ReflectHistory;
  /** 누를 때마다 다시 찾는다(앱을 켠 뒤 claude 를 설치한 경우) */
  getClaudePath: () => ClaudeLocation;
  /** 시험용 제한 시간. 없으면 reflect.ts 기본(15분) */
  timeoutMs?: number;
}

/** 한 번에 하나만 실행한다. 진행 상황은 모든 창에 방송하고, 끝나면 대기열·실행 기록을 고친다. */
export class ReflectController {
  private running: ReflectRun | null = null;
  /** 지금 실행의 표. 끝나거나 중단되면 null — 늦게 온 진행·결과를 버리는 데 쓴다 */
  private token: symbol | null = null;
  private last: ReflectRun | null = null;

  constructor(private readonly opts: ReflectControllerOptions) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  /** 실행 중인 것, 없으면 마지막으로 끝난 것(기록 파일의 최신), 없으면 null */
  current(): ReflectRun | null {
    if (this.running) return this.running;
    if (this.last) return this.last;
    try {
      return this.opts.history().list()[0] ?? null;
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 읽지 못함:`, describeError(err));
      return null;
    }
  }

  /** 실행을 시작하고 곧바로 running 상태를 돌려준다. 이미 실행 중이면 그 실행을 돌려준다. */
  start(): ReflectRun {
    if (this.running) return this.running;
    // 앱 종료 처리로 중단한 실행이 아직 정리되는 중
    if (isReflectRunning()) throw new Error('이전 위키 반영을 정리하는 중입니다 — 잠시 뒤 다시 누르세요');

    const queue = this.opts.queue();
    const items = queue.list();
    if (items.length === 0) throw new Error('반영할 항목이 없습니다(반영 대기열이 비어 있음)');
    if (!fs.existsSync(this.opts.wikiRoot)) throw new Error(`위키 폴더를 찾을 수 없습니다: ${this.opts.wikiRoot}`);
    const claude = this.opts.getClaudePath();
    if (!claude.exists) {
      throw new Error(`claude 실행 파일을 찾을 수 없습니다: ${claude.path} (환경 변수 WIKI_RADAR_CLAUDE 로 위치를 정할 수 있습니다)`);
    }

    const token = Symbol('reflect');
    const runId = randomUUID();
    const initial: ReflectRun = {
      id: runId,
      startedAt: new Date().toISOString(),
      state: 'running',
      itemIds: items.map((i) => i.id),
      log: [`claude 실행을 시작함 — 항목 ${items.length}건`],
    };
    // 실행 도중 같은 할 일이 다시 저장되면(대기열 항목 교체) 새 내용은 이번 실행에 들어가지 않았으므로 남긴다.
    const startedItems = new Map(items.map((i) => [i.id, i.createdAt]));

    this.token = token;
    this.running = initial;
    console.log(`${LOG} 위키 반영 시작: 항목 ${items.length}건 · claude ${claude.path} (${claude.source})`);
    broadcastReflect(initial);

    let done: Promise<ReflectRun>;
    try {
      done = runReflect({
        wikiRoot: this.opts.wikiRoot,
        claudePath: claude.path,
        items,
        runId,
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
        onProgress: (run) => this.progress(token, run),
      });
    } catch (err) {
      done = Promise.reject(err);
    }
    done
      .then(
        (final) => this.finish(token, final, startedItems),
        (err: unknown) => {
          const base = this.running ?? initial;
          this.finish(token, { ...base, state: 'failed', error: `claude 를 실행하지 못했습니다: ${describeError(err)}` }, startedItems);
        },
      )
      .catch((err: unknown) => console.error(`${LOG} 반영 실행 마무리 오류:`, describeError(err)));
    return this.running ?? initial;
  }

  private progress(token: symbol, run: ReflectRun): void {
    if (this.token !== token) return;
    if (run.state === 'running') this.running = run;
    broadcastReflect(run);
  }

  private finish(token: symbol, final: ReflectRun, startedItems: Map<string, string>): void {
    if (this.token !== token) return; // 앱 종료로 이미 중단 처리했다
    this.token = null;
    this.running = null;

    const run: ReflectRun = { ...final, finishedAt: final.finishedAt ?? new Date().toISOString() };
    if (run.state === 'running') {
      run.state = 'failed';
      run.error = run.error ?? '실행이 끝났지만 결과 상태를 알 수 없습니다';
    }
    this.last = run;

    // 성공이면 이번 실행에 넣은 항목을 뺀다(도중에 바뀐 것은 남긴다). 실패면 대기열을 그대로 둔다.
    let queueChanged = false;
    if (run.state === 'done') {
      try {
        const queue = this.opts.queue();
        const current = new Map(queue.list().map((i) => [i.id, i.createdAt]));
        const ids = run.itemIds.filter((id) => startedItems.has(id) && current.get(id) === startedItems.get(id));
        if (ids.length > 0) {
          queue.removeMany(ids);
          queueChanged = true;
        }
      } catch (err) {
        console.warn(`${LOG} 반영한 항목을 대기열에서 빼지 못함:`, describeError(err));
      }
    }

    try {
      this.opts.history().append(run);
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 남기지 못함:`, describeError(err));
    }

    if (run.state === 'done') {
      console.log(`${LOG} 위키 반영 끝: 바뀐 파일 ${run.changed?.length ?? 0}개 · 건너뜀 ${run.skipped?.length ?? 0}건`);
    } else {
      console.warn(`${LOG} 위키 반영 실패: ${run.error ?? '(이유 없음)'}`);
    }
    broadcastReflect(run);
    if (queueChanged) this.publishQueue();
  }

  private publishQueue(): void {
    try {
      broadcastQueue(this.opts.queue().list());
    } catch (err) {
      console.warn(`${LOG} 반영 대기열을 읽지 못함:`, describeError(err));
    }
  }

  /**
   * 앱을 끝낼 때: 실행 중이면 claude 프로세스 트리를 끝내고(reflect.ts 의 stopActiveReflect — Windows 는
   * 부모가 끝나도 자식을 끝내지 않는다) 실패로 기록한다. 대기열은 그대로 둔다.
   * 종료가 끝나기 전에 프로세스가 사라져도 reflect.ts 가 process 'exit' 에서 한 번 더 동기로 끝낸다.
   * 결과가 늦게 와도 버리도록 표를 먼저 지우고, 기록은 여기서 동기로 남긴다. 여러 번 불러도 된다.
   */
  stopForQuit(): void {
    const reason = '앱을 끝내 claude 실행을 중단함';
    const stopped = stopActiveReflect(reason);
    if (!this.running) return;
    const run: ReflectRun = {
      ...this.running,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: reason,
      log: [...this.running.log, reason].slice(-50),
    };
    this.token = null;
    this.running = null;
    this.last = run;
    console.warn(`${LOG} ${reason}${stopped ? '' : '(실행 중인 프로세스는 없었음)'}`);
    try {
      this.opts.history().append(run);
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 남기지 못함:`, describeError(err));
    }
  }
}

// ---------------------------------------------------------------------------
// 등록

/** 창 쪽 동작. index.ts 가 구현해 넘긴다. */
export interface WindowControl {
  /** 이 webContents 가 우리 창(사이드바·풀스크린)의 것인가 */
  isAppContents(contents: WebContents): boolean;
  /** 요청을 보낸 창의 모드 */
  modeOf(contents: WebContents): WindowMode;
  setMode(mode: WindowMode, focusTaskId?: string): void;
  /** 사이드바 '항상 위'를 뒤집고 바뀐 값을 돌려준다 */
  togglePin(): boolean;
  quit(): void;
}

export interface IpcDeps {
  wikiRoot: string;
  snapshots: SnapshotService;
  windows: WindowControl;
  // ---- 2단계
  /** 필드·로그·메모에 쓰는 오늘(YYYY-MM-DD) */
  getToday: () => string;
  /** 위키에 쓴 뒤 스냅샷을 곧바로 다시 만들어 두 창에 방송한다. 만든 스냅샷 또는 null(실패) */
  refreshSnapshot: () => Snapshot | null;
  queue: () => QueueStore;
  reflect: ReflectController;
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** 되돌리기용으로 기억해 두는 저장 항목 수 */
const SAVED_TASKS_LIMIT = 200;

/** 같은 채널·같은 문장의 실패는 한 번만 로그한다(창 2개가 같은 요청을 되풀이해도 로그가 넘치지 않게). */
const loggedFailures = new Set<string>();
function logFailureOnce(channel: string, message: string): void {
  const key = `${channel}|${message}`;
  if (loggedFailures.has(key)) return;
  loggedFailures.add(key);
  console.warn(`${LOG} ${channel} 실패: ${message}`);
}

/** 대기열 항목의 재료. 제목은 화면에 보이는 제목, 파일은 연결된 줄(없으면 첫 앵커)의 파일. */
function queueItemOf(task: Task, input: SaveResultInput): NewQueueItem {
  const item: NewQueueItem = {
    kind: 'task',
    taskId: task.id,
    title: task.title,
    status: input.status,
    note: input.note?.trim() ?? '',
  };
  if (input.status === 'notmine') item.owner = input.owner ?? '타담당';
  if (task.company) item.company = task.company;
  const file = task.file ?? task.anchors?.[0]?.file;
  if (file) item.file = file;
  if (task.mail) item.mail = task.mail;
  if (task.src) item.src = task.src;
  return item;
}

/** IPC 핸들러를 모두 등록한다. 창을 만들기 전에 한 번 부른다. */
export function registerIpc(deps: IpcDeps): void {
  const { wikiRoot, snapshots, windows } = deps;
  const serialSave = createSerialQueue();

  // 실패는 예외 대신 IpcReply 로 돌려준다(shared/ipc.ts 참고). preload 가 Error 로 되살린다.
  const handle = (channel: string, fn: Handler) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcReply<unknown>> => {
      if (!windows.isAppContents(event.sender)) {
        logFailureOnce(channel, '허용되지 않은 요청입니다');
        return { ok: false, message: '허용되지 않은 요청입니다' };
      }
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (err) {
        const message = describeError(err);
        logFailureOnce(channel, message);
        return { ok: false, message };
      }
    });
  };

  handle(IPC.getSnapshot, (): Snapshot => snapshots.current());

  handle(IPC.getMail, (_event, relPath): MailSummary | null => {
    const rel = requireString(relPath, 'relPath', MAX_REL_PATH_LENGTH);
    if (!looksLikeMailPath(rel)) return null;
    try {
      return readMailSummary(wikiRoot, rel);
    } catch (err) {
      throw new Error(`메일을 읽지 못했습니다: ${describeError(err)}`);
    }
  });

  handle(IPC.openInObsidian, async (_event, relPath): Promise<void> => {
    const rel = requireString(relPath, 'relPath', MAX_REL_PATH_LENGTH);
    const abs = resolveWikiMarkdown(wikiRoot, rel);
    if (!abs) throw new Error('위키 안의 .md 문서만 열 수 있습니다');
    if (!markdownMayExist(abs)) throw new Error(`문서를 찾을 수 없습니다: ${rel}`);
    try {
      await shell.openExternal('obsidian://open?path=' + encodeURIComponent(abs));
    } catch (err) {
      throw new Error(`Obsidian을 열지 못했습니다: ${describeError(err)}`);
    }
  });

  handle(IPC.setMode, (_event, mode, focusTaskId): void => {
    const m = requireMode(mode);
    const id =
      focusTaskId === undefined || focusTaskId === null
        ? undefined
        : requireString(focusTaskId, 'focusTaskId', MAX_TASK_ID_LENGTH);
    windows.setMode(m, id);
  });

  handle(IPC.getMode, (event): WindowMode => windows.modeOf(event.sender));

  handle(IPC.togglePin, (): boolean => windows.togglePin());

  handle(IPC.quit, (): void => {
    windows.quit();
  });

  // ---- 2단계: 처리 결과 저장 ------------------------------------------------

  /**
   * 이번 실행 중에 저장한 항목(오래된 것부터, 최대 SAVED_TASKS_LIMIT 개). 스냅샷에는 열린 할 일(open·wip)만 있어
   * 완료·내 일 아님으로 바꾼 항목은 빠지므로, 그 항목을 되돌릴(open 등) 때 여기서 찾는다.
   * 앵커·핵심문구는 상태를 바꿔도 그대로라 저장 때의 항목으로 줄을 다시 찾을 수 있다(writeback 이 파일을 새로 읽는다).
   */
  const savedTasks = new Map<string, Task>();
  const rememberSaved = (task: Task): void => {
    savedTasks.delete(task.id);
    savedTasks.set(task.id, task);
    while (savedTasks.size > SAVED_TASKS_LIMIT) {
      const oldest = savedTasks.keys().next().value;
      if (oldest === undefined) break;
      savedTasks.delete(oldest);
    }
  };

  /** 저장 한 건. serialSave 안에서만 부른다 — 항목 찾기부터 쓰기·스냅샷 재생성까지가 한 덩어리다. */
  function saveResult(input: SaveResultInput): SaveResultOutput {
    let task = snapshots.current().tasks.find((t) => t.id === input.taskId);
    if (!task) {
      // 감시가 아직 따라오지 못한 변경일 수 있다 — 한 번 새로 읽어 본다.
      task = snapshots.refresh()?.tasks.find((t) => t.id === input.taskId);
    }
    // 목록에서 빠진(완료·내 일 아님) 항목의 되돌리기
    if (!task) task = savedTasks.get(input.taskId);
    if (!task) {
      throw new Error('저장할 할 일을 목록에서 찾지 못했습니다(그사이 위키가 바뀌었을 수 있습니다). 목록을 확인한 뒤 다시 저장하세요');
    }

    // 쓰기 전에 기억한다 — 일부만 쓰고 실패해 목록에서 빠진 항목(완료 줄은 썼는데 다음 파일이 막힘 등)도 다시 저장할 수 있게
    rememberSaved(task);

    /** 위키 지식 반영 대기열에 넣는다. 실패하면 이유를 warnings 에 적고 undefined */
    const enqueue = (warnings: string[]): QueueItem | undefined => {
      if (!input.reflect) return undefined;
      try {
        const queue = deps.queue();
        const queued = queue.add(queueItemOf(task, input));
        broadcastQueue(queue.list());
        return queued;
      } catch (err) {
        // 위키에는 이미 썼으므로 저장 자체를 실패로 돌리지 않는다.
        warnings.push(`위키 지식 반영 대기열에 넣지 못했습니다: ${describeError(err)}`);
        return undefined;
      }
    };

    let result: WritebackResult;
    try {
      result = applyWriteback({
        wikiRoot,
        today: deps.getToday(),
        task,
        status: input.status,
        ...(input.status === 'notmine' && input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
    } catch (err) {
      if (err instanceof PartialWriteError) {
        // 일부 파일은 이미 썼다 — 목록을 바로 다시 만들고, 반영 요청도 잃지 않게 대기열에 넣은 뒤 '일부만 저장'으로 알린다.
        console.warn(`${LOG} 처리 결과 일부만 저장: ${task.id} → ${input.status} · 쓴 파일 ${err.written.join(', ')}`);
        const notes: string[] = [];
        if (!deps.refreshSnapshot()) notes.push('목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
        if (enqueue(notes)) notes.push('위키 지식 반영 대기열에는 넣었습니다');
        throw new Error(`${PARTIAL_SAVE_PREFIX}: ${err.message}${notes.map((n) => ` — ${n}`).join('')}`);
      }
      throw new Error(`위키에 저장하지 못했습니다: ${describeError(err)}`);
    }
    console.log(
      `${LOG} 처리 결과 저장: ${task.id} → ${input.status} · 쓴 파일 ${result.files.length}개` +
        (result.backupDir ? ` · 백업 ${result.backupDir}` : '') +
        (result.unmatched.length ? ` · 못 찾음 ${result.unmatched.length}건` : ''),
    );

    const warnings = [...result.warnings];
    // 감시(800ms)를 기다리지 않고 바로 목록을 다시 만든다 — 완료·내 일 아님은 곧바로 목록에서 빠진다.
    if (!deps.refreshSnapshot()) {
      warnings.push('저장은 했지만 목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
    }

    const output: SaveResultOutput = { ...result, warnings };
    const queued = enqueue(warnings);
    if (queued) output.queued = queued;
    return output;
  }

  handle(IPC.saveResult, (_event, raw): Promise<SaveResultOutput> => {
    const input = requireSaveInput(raw);
    return serialSave(() => saveResult(input));
  });

  // ---- 2단계: 반영 대기열 ----------------------------------------------------

  handle(IPC.getQueue, (): QueueItem[] => deps.queue().list());

  handle(IPC.removeQueueItem, (_event, id): QueueItem[] => {
    const itemId = requireString(id, 'id', MAX_QUEUE_ID_LENGTH);
    const queue = deps.queue();
    const list = queue.remove(itemId);
    broadcastQueue(list);
    return list;
  });

  // ---- 2단계: 위키에 반영(claude -p) — 사람이 버튼을 누를 때만 온다 ------------

  handle(IPC.runReflect, (): ReflectRun => deps.reflect.start());

  handle(IPC.getReflect, (): ReflectRun | null => deps.reflect.current());
}
