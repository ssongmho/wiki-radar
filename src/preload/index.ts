// contextBridge 로 window.radar(RadarAPI)만 노출한다. 계약: docs/stage1-contract.md §5, docs/stage2-contract.md
// sandbox 프리로드라 electron 말고 Node 모듈은 import 하지 않는다(공유 상수는 번들에 들어간다).
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type IpcReply } from '../shared/ipc';
import type {
  MailSummary,
  QueueItem,
  RadarAPI,
  ReflectRun,
  SaveResultInput,
  SaveResultOutput,
  Snapshot,
  WindowMode,
} from '../shared/types';

/**
 * main 이 (봉투 밖에서) 던진 오류는 "Error invoking remote method 'radar:…': Error: …" 모양으로 온다.
 * 화면에 그대로 보여줄 수 있게 앞머리를 뗀다.
 */
function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^[A-Za-z]*Error:\s*/, '');
}

function isReply(value: unknown): value is IpcReply<unknown> {
  return !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** main 의 IpcReply 봉투를 벗긴다. ok:false 는 Error 로 되살려 화면이 이전과 같은 오류를 받는다. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  let reply: unknown;
  try {
    reply = await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(cleanMessage(err));
  }
  if (!isReply(reply)) throw new Error(`앱 응답 형식이 잘못되었습니다(${channel})`);
  if (!reply.ok) throw new Error(typeof reply.message === 'string' && reply.message ? reply.message : '알 수 없는 오류');
  return reply.value as T;
}

function safeCall<A>(cb: (arg: A) => void, arg: A): void {
  try {
    cb(arg);
  } catch (err) {
    console.error('[wiki-radar] 구독 콜백 오류:', err);
  }
}

function requireCallback(cb: unknown): void {
  if (typeof cb !== 'function') throw new TypeError('콜백은 함수여야 합니다');
}

/**
 * main → 화면 이벤트 채널 하나의 구독 관리. 모양이 맞지 않는 값은 버린다.
 * 돌려주는 함수가 RadarAPI 의 onXxx 다(구독 해제 함수를 돌려준다).
 */
function eventChannel<T>(channel: string, accept: (value: unknown) => boolean): (cb: (value: T) => void) => () => void {
  const listeners = new Set<(value: T) => void>();
  ipcRenderer.on(channel, (_event, value: unknown) => {
    if (!accept(value)) return;
    for (const cb of [...listeners]) safeCall(cb, value as T);
  });
  return (cb) => {
    requireCallback(cb);
    const listener = (value: T) => cb(value);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
}

const isObject = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);

const onSnapshot = eventChannel<Snapshot>(IPC.snapshot, isObject);
const onQueue = eventChannel<QueueItem[]>(IPC.queue, Array.isArray);
const onReflect = eventChannel<ReflectRun>(IPC.reflect, isObject);

// ---- 항목 열기(focusTask) 구독 ---------------------------------------------
// 풀스크린 화면이 불러와진 직후에 온 요청은 React 가 구독하기 전일 수 있다.
// 구독자가 없을 때 온 마지막 ID 를 들고 있다가 첫 구독자에게 넘긴다.

const focusListeners = new Set<(taskId: string) => void>();
let pendingFocusTaskId: string | null = null;
ipcRenderer.on(IPC.focusTask, (_event, taskId: unknown) => {
  if (typeof taskId !== 'string' || taskId.length === 0) return;
  if (focusListeners.size === 0) {
    pendingFocusTaskId = taskId;
    return;
  }
  for (const cb of [...focusListeners]) safeCall(cb, taskId);
});

/** 들고 있던 ID 를 지금 구독자들에게 넘긴다. 구독자가 없으면 계속 들고 있는다. */
function flushPendingFocus(): void {
  if (pendingFocusTaskId === null || focusListeners.size === 0) return;
  const taskId = pendingFocusTaskId;
  pendingFocusTaskId = null;
  for (const cb of [...focusListeners]) safeCall(cb, taskId);
}

/**
 * 저장 입력에서 알려진 필드만 골라 보낸다(함수·DOM 객체 같은 복제할 수 없는 값이 섞여도 요청이 깨지지 않게).
 * 값의 검사는 main 이 한다.
 */
function pickSaveInput(input: SaveResultInput): unknown {
  // 객체가 아니면 그대로 보내 main 이 "객체가 아닙니다"로 거부하게 한다
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof SaveResultInput, unknown>>;
  return { taskId: i.taskId, status: i.status, owner: i.owner, note: i.note, reflect: i.reflect };
}

const api: RadarAPI = {
  getSnapshot: () => invoke<Snapshot>(IPC.getSnapshot),

  onSnapshot,

  getMail: (relPath) => invoke<MailSummary | null>(IPC.getMail, relPath),

  openInObsidian: (relPath) => invoke<void>(IPC.openInObsidian, relPath),

  setMode: (mode, focusTaskId) =>
    focusTaskId === undefined ? invoke<void>(IPC.setMode, mode) : invoke<void>(IPC.setMode, mode, focusTaskId),

  getMode: () => invoke<WindowMode>(IPC.getMode),

  onFocusTask(cb) {
    requireCallback(cb);
    const listener = (taskId: string) => cb(taskId);
    focusListeners.add(listener);
    // 구독 함수가 돌아간 뒤에 넘긴다. React StrictMode 처럼 구독→해제→재구독이 바로 이어져도
    // 그때 남아 있는 구독자가 받는다.
    if (pendingFocusTaskId !== null) setTimeout(flushPendingFocus, 0);
    return () => {
      focusListeners.delete(listener);
    };
  },

  togglePin: () => invoke<boolean>(IPC.togglePin),

  quit: () => invoke<void>(IPC.quit),

  // ---- 2단계
  saveResult: (input) => invoke<SaveResultOutput>(IPC.saveResult, pickSaveInput(input)),

  getQueue: () => invoke<QueueItem[]>(IPC.getQueue),

  removeQueueItem: (id) => invoke<QueueItem[]>(IPC.removeQueueItem, id),

  onQueue,

  runReflect: () => invoke<ReflectRun>(IPC.runReflect),

  getReflect: () => invoke<ReflectRun | null>(IPC.getReflect),

  onReflect,
};

contextBridge.exposeInMainWorld('radar', api);
