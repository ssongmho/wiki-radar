// 할 일 상세의 VOC 쪽 상태(2.6단계 명세 §5 V3a 'VOC 처리' · §6 V3b '메일 → VOC 등록').
// FullView 를 거치지 않고 상세(TaskDetail) 안에서 쓴다 — taskId 별 입력(답변·고른 상태·등록 작성 칸)과 진행 중 표시·결과 알림을
// 모듈 수준 Map 에 들고 있어, 다른 할 일·화면(반영 대기·VOC)을 다녀와도 남는다(메모리에만). 쓰기 흐름도 여기 있다 —
// 항목을 옮겨 상세가 다시 그려져도 끝난 결과가 그 할 일의 칸에 들어간다.
// 보드(getVocBoard·onVocBoard)는 한 번만 구독해 나눠 쓴다(티켓 요약·담당 선택지·웹 주소).
// 메일함 VOC 등록(2.10단계 §7-2)도 같은 보관소를 쓴다 — 열쇠가 'mail:<경로>'(mailTargetKey)면 메일이 대상이다:
// 문맥은 getMailVocCreateContext, 연결된 할 일이 하나면(문맥의 taskId) 기존 createVocTicket(할 일 줄에 [voc::]), 아니면 createMailVocTicket.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { RadarAPI, VocActionInput, VocBoard } from '../../shared/types';
import { VOC_CREATE_ID_USED } from '../../shared/voc';
import { FOCUS_VOC_LOGIN, NO_BRIDGE_MESSAGE, getRadar, vocFocusId } from '../api';
import { mailTargetPath } from '../lib/mailbox';
import { makeSendId } from '../lib/reply';
import type { SaveNotice } from '../lib/result';
import { errorText } from '../lib/snapshot';
import {
  IDLE_CREATE_CONTEXT,
  actionFailure,
  actionNotice,
  buildCreateInput,
  cleanVocText,
  createContextOf,
  createFailure,
  createNotice,
  initialCreateDraft,
  mailCreateNotice,
  normalizeActionResult,
  normalizeCharset,
  normalizeCreateContext,
  normalizeCreateResult,
  prefillCreateDraft,
  remainingChars,
  type CreateContextEntry,
  type VocActionInfo,
  type VocCreateDraft,
} from '../lib/vocTask';

export const NO_VOC_MESSAGE = '이 앱 연결에는 VOC 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

type VocApi = Pick<
  RadarAPI,
  | 'getVocBoard'
  | 'onVocBoard'
  | 'vocAction'
  | 'checkVocText'
  | 'getVocCreateContext'
  | 'createVocTicket'
  | 'openVocWeb'
  | 'setMode'
  | 'getMailVocCreateContext'
  | 'createMailVocTicket'
>;

function vocApi(): Partial<VocApi> | null {
  return getRadar();
}

function missingText(): string {
  return getRadar() ? NO_VOC_MESSAGE : NO_BRIDGE_MESSAGE;
}

/** 앱 연결에 VOC 쓰기(V3a) 기능이 있는가 */
export function vocActionSupported(): boolean {
  return typeof vocApi()?.vocAction === 'function';
}

/** 앱 연결에 VOC 등록(V3b) 기능이 있는가. mail 이면 메일함 등록(2.10단계)까지 */
export function vocCreateSupported(mail = false): boolean {
  const api = vocApi();
  const base = typeof api?.getVocCreateContext === 'function' && typeof api?.createVocTicket === 'function';
  if (!mail) return base;
  return base && typeof api?.getMailVocCreateContext === 'function' && typeof api?.createMailVocTicket === 'function';
}

// ── taskId 별 보관소 ──

class TaskStore<T> {
  private readonly map = new Map<string, T>();
  private readonly listeners = new Set<() => void>();

  /** empty 는 아직 만들지 않은 칸 — 늘 같은 객체라야 useSyncExternalStore 가 다시 그리기를 되풀이하지 않는다 */
  constructor(private readonly empty: T) {}

  get(taskId: string): T {
    return this.map.get(taskId) ?? this.empty;
  }

  /** 만든 칸의 taskId 들 */
  keys(): string[] {
    return [...this.map.keys()];
  }

  update(taskId: string, fn: (current: T) => T): void {
    const current = this.get(taskId);
    const next = fn(current);
    if (next === current) return;
    this.map.set(taskId, next);
    for (const l of [...this.listeners]) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

function useEntry<T>(store: TaskStore<T>, taskId: string): T {
  const get = useCallback(() => store.get(taskId), [store, taskId]);
  return useSyncExternalStore(store.subscribe, get, get);
}

let noticeSeq = 0;

// ── 보드(한 번만 구독) ──

let board: VocBoard | null = null;
let boardStarted = false;
const boardListeners = new Set<() => void>();
/** 받은 보드가 로그인 필요였고 아직 로그인한 보드(받는 중·설정 필요 밖)가 오지 않았다 */
let awaitingLogin = false;

function setBoard(next: unknown): void {
  if (!next || typeof next !== 'object' || !Array.isArray((next as VocBoard).lanes)) return;
  board = next as VocBoard;
  const state = board.state;
  let loggedIn = false;
  if (state === 'login') awaitingLogin = true;
  else if (awaitingLogin && state !== 'loading' && state !== 'notConfigured') {
    awaitingLogin = false;
    loggedIn = true;
  }
  for (const l of [...boardListeners]) l();
  // 로그인한 뒤(로그인 창·터미널 + [다시 확인]) 보드가 오면, 로그인이 필요해 등록 문맥을 읽지 못한 칸을 다시 읽는다 —
  // 그러지 않으면 '로그인이 필요합니다' 오류가 남아 [등록]이 막힌 채다(사람이 [다시 시도]를 눌러야 했다)
  if (loggedIn) reloadFailedContexts();
}

function startBoard(): void {
  if (boardStarted) return;
  const api = vocApi();
  if (!api || typeof api.getVocBoard !== 'function') return;
  boardStarted = true;
  try {
    api.onVocBoard?.(setBoard);
  } catch {
    // 구독하지 못하면 처음 받은 보드만 쓴다
  }
  Promise.resolve()
    .then(() => api.getVocBoard?.())
    .then(setBoard, () => undefined);
}

function listenBoard(listener: () => void): () => void {
  boardListeners.add(listener);
  return () => boardListeners.delete(listener);
}

function subscribeBoard(listener: () => void): () => void {
  startBoard();
  return listenBoard(listener);
}

const getBoard = (): VocBoard | null => board;

/**
 * 마지막으로 받은 VOC 보드(아직 없으면 null). active 면 (처음 한 번) 보드를 받고 바뀔 때마다 다시 그린다.
 * active 가 아니면 받지는 않고, 다른 곳이 받아 둔 보드만 본다(메일 할 일마다 보드를 부르지 않게).
 */
export function useSharedVocBoard(active = true): VocBoard | null {
  return useSyncExternalStore(active ? subscribeBoard : listenBoard, getBoard, getBoard);
}

// ── CP949 검사(명세 §1 — 쓰기 전에 main 의 iconv-lite 로) ──

const CHARSET_CACHE_MAX = 50;
const charsetCache = new Map<string, string[]>();
const CHARSET_DELAY_MS = 250;

function remember(text: string, chars: string[]): void {
  charsetCache.delete(text);
  charsetCache.set(text, chars);
  while (charsetCache.size > CHARSET_CACHE_MAX) {
    const oldest = charsetCache.keys().next().value;
    if (oldest === undefined) break;
    charsetCache.delete(oldest);
  }
}

/**
 * 보낼 수 없는 글자를 지금 확인한다(결과는 기억해 둔다). 앱 연결에 검사가 없거나 실패하면 [] — main 이 쓰기 전에 다시 검사한다.
 */
export async function checkCharsetNow(text: string): Promise<string[]> {
  if (text.trim() === '') return [];
  const cached = charsetCache.get(text);
  if (cached) return cached;
  const api = vocApi();
  if (!api || typeof api.checkVocText !== 'function') return [];
  try {
    const chars = normalizeCharset(await api.checkVocText(text));
    remember(text, chars);
    return chars;
  } catch {
    return [];
  }
}

export interface CharsetState {
  /** 보낼 수 없는 글자(확인하는 동안은 앞서 찾은 것 가운데 아직 남은 것) */
  chars: string[];
  /** 지금 글을 아직 확인하지 않았다 */
  pending: boolean;
}

/** 입력 중 CP949 검사: 멈춘 뒤 잠시 있다가 main 에 묻는다(같은 글은 다시 묻지 않는다) */
export function useVocCharset(text: string, active = true): CharsetState {
  const [result, setResult] = useState<{ text: string; chars: string[] } | null>(null);
  useEffect(() => {
    if (!active || text.trim() === '' || charsetCache.has(text)) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void checkCharsetNow(text).then((chars) => {
        if (alive) setResult({ text, chars });
      });
    }, CHARSET_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [text, active]);
  if (!active || text.trim() === '') return { chars: [], pending: false };
  const known = result?.text === text ? result.chars : charsetCache.get(text);
  if (known) return { chars: known, pending: false };
  return { chars: remainingChars(result?.chars ?? [], text), pending: true };
}

// ── V3a VOC 처리(답변·상태) ──

export interface VocTaskEntry {
  /** 적는 중인 답변 */
  reply: string;
  /** 고른 새 상태('' = 기본값 — 지금 상태의 반대) */
  status: string;
  /** VOC 에 쓰는 중인 동작(같은 티켓의 다른 동작을 막는다) */
  busy: 'reply' | 'status' | null;
  notice: SaveNotice | null;
}

const EMPTY_TASK_ENTRY: VocTaskEntry = { reply: '', status: '', busy: null, notice: null };
const taskStore = new TaskStore<VocTaskEntry>(EMPTY_TASK_ENTRY);

export function useVocTaskEntry(taskId: string): VocTaskEntry {
  return useEntry(taskStore, taskId);
}

/** 지금 값(그리기 밖 — 흐름·시험이 쓴다) */
export function peekVocTask(taskId: string): VocTaskEntry {
  return taskStore.get(taskId);
}

export function updateVocTask(taskId: string, patch: Partial<VocTaskEntry>): void {
  taskStore.update(taskId, (e) => ({ ...e, ...patch }));
}

/**
 * VOC 쓰기 한 번(확인 대화상자의 [실행] 뒤). actionId 는 부른 쪽이 대화상자를 열 때 새로 만든다.
 * 실패(ok:false·예외)는 알림으로 보이고 입력은 남긴다. 성공한 답변은 칸을 비운다. 끝났으면 true(성공 여부와 무관)
 */
export async function runVocAction(taskId: string, input: VocActionInput, info: VocActionInfo): Promise<boolean> {
  if (taskStore.get(taskId).busy) return false;
  taskStore.update(taskId, (e) => ({ ...e, busy: info.kind }));
  const id = ++noticeSeq;
  try {
    const api = vocApi();
    if (!api || typeof api.vocAction !== 'function') throw new Error(missingText());
    const result = normalizeActionResult(await api.vocAction(input));
    taskStore.update(taskId, (e) => ({
      ...e,
      notice: actionNotice(info, result, id),
      // 성공한 답변만 비운다(쓰는 동안 더 고쳤으면 그 입력은 남긴다)
      ...(result.ok && info.kind === 'reply' && cleanVocText(e.reply) === info.value ? { reply: '' } : {}),
      ...(result.ok && info.kind === 'status' ? { status: '' } : {}),
    }));
  } catch (err) {
    taskStore.update(taskId, (e) => ({ ...e, notice: actionFailure(info, errorText(err), id) }));
  } finally {
    taskStore.update(taskId, (e) => ({ ...e, busy: null }));
  }
  return true;
}

/** [VOC 에서 열기]. 실패하면 그 할 일의 알림으로 */
export async function openVocWeb(taskId: string, ticketId: number, number: string): Promise<void> {
  try {
    const api = vocApi();
    if (!api || typeof api.openVocWeb !== 'function') throw new Error(missingText());
    await api.openVocWeb(ticketId);
  } catch (err) {
    const id = ++noticeSeq;
    taskStore.update(taskId, (e) => ({
      ...e,
      notice: { id, tone: 'error', title: `${number}을(를) VOC 웹에서 열지 못했습니다.`, lines: [{ text: errorText(err), warn: true }] },
    }));
  }
}

/**
 * 풀스크린 VOC 화면에서 그 티켓을 연다(ref = 번호 또는 내부 id — 보드에 없으면 화면만 연다).
 * 풀스크린 창 안에서 불러도 main 이 그 창에 초점 요청(view:voc:<ref>)을 보낸다.
 */
export function showVocTicket(ref: string | number): void {
  const api = vocApi();
  if (!api || typeof api.setMode !== 'function') return;
  Promise.resolve()
    .then(() => api.setMode?.('full', vocFocusId(ref)))
    .catch(() => undefined);
}

/**
 * 풀스크린 VOC 화면을 열고 로그인 대화상자를 띄운다(명세 §13 — V3a·V3b 의 '로그인 필요' 안내의 [로그인]).
 * 풀스크린 창 안에서 불러도 main 이 그 창에 초점 요청(view:voc-login)을 보낸다
 */
export function openVocLogin(): void {
  const api = vocApi();
  if (!api || typeof api.setMode !== 'function') return;
  Promise.resolve()
    .then(() => api.setMode?.('full', FOCUS_VOC_LOGIN))
    .catch(() => undefined);
}

// ── V3b 메일 → VOC 등록 ──

export interface VocCreateEntry {
  /** 작성 칸을 폈는가 */
  open: boolean;
  draft: VocCreateDraft;
  context: CreateContextEntry;
  /** 만드는 중 */
  busy: boolean;
  /** 이번에 만든 티켓(할 일 줄이 새로 읽히기 전에도 배지를 보인다) */
  created?: { number: string; ticketId: number };
  notice: SaveNotice | null;
  /** 메일 대상(2.10단계 §7-2): 연결된 할 일이 하나면 그 taskId(기존 V3b 로 등록) · 같은 스레드로 만든 티켓 번호 */
  mailLink?: { taskId?: string; threadVoc: string[] };
}

/** 아직 만들지 않은 칸(createId 는 펼 때 만든다) */
const EMPTY_CREATE_ENTRY: VocCreateEntry = {
  open: false,
  draft: initialCreateDraft(''),
  context: IDLE_CREATE_CONTEXT,
  busy: false,
  notice: null,
};
const createStore = new TaskStore<VocCreateEntry>(EMPTY_CREATE_ENTRY);
/** 할 일마다 문맥 읽기 요청 번호 — 늦게 온 옛 응답이 새 응답을 덮지 않게 */
const contextSeq = new Map<string, number>();

export function useVocCreateEntry(taskId: string): VocCreateEntry {
  return useEntry(createStore, taskId);
}

/** 지금 값(그리기 밖 — 흐름·시험이 쓴다) */
export function peekVocCreate(taskId: string): VocCreateEntry {
  return createStore.get(taskId);
}

export function updateVocCreateDraft(taskId: string, patch: Partial<VocCreateDraft>): void {
  createStore.update(taskId, (e) => ({ ...e, draft: { ...e.draft, ...patch } }));
}

export function closeVocCreateNotice(taskId: string): void {
  createStore.update(taskId, (e) => (e.notice ? { ...e, notice: null } : e));
}

export function closeVocTaskNotice(taskId: string): void {
  taskStore.update(taskId, (e) => (e.notice ? { ...e, notice: null } : e));
}

/** 등록 문맥(작성 칸 기본값·선택지)을 읽는다. 읽으면 기본값을 (한 번) 채운다 */
export function loadCreateContext(taskId: string): void {
  const api = vocApi();
  const mailPath = mailTargetPath(taskId);
  if (!api || (mailPath === null ? typeof api.getVocCreateContext !== 'function' : typeof api.getMailVocCreateContext !== 'function')) {
    createStore.update(taskId, (e) => ({ ...e, context: { status: 'error', message: missingText() } }));
    return;
  }
  const seq = (contextSeq.get(taskId) ?? 0) + 1;
  contextSeq.set(taskId, seq);
  createStore.update(taskId, (e) => ({ ...e, context: { status: 'loading', ctx: createContextOf(e.context) } }));
  Promise.resolve()
    .then((): Promise<unknown> | undefined => (mailPath === null ? api.getVocCreateContext?.(taskId) : api.getMailVocCreateContext?.(mailPath)))
    .then(
      (raw) => {
        if (contextSeq.get(taskId) !== seq) return;
        const ctx = normalizeCreateContext(raw);
        const link = mailPath !== null && ctx ? mailLinkOf(raw) : undefined;
        createStore.update(taskId, (e) => ({
          ...e,
          context: ctx ? { status: 'ready', ctx } : { status: 'missing' },
          draft: ctx ? prefillCreateDraft(e.draft, ctx) : e.draft,
          ...(link ? { mailLink: link } : {}),
        }));
      },
      (err: unknown) => {
        if (contextSeq.get(taskId) !== seq) return;
        createStore.update(taskId, (e) => ({
          ...e,
          context: { status: 'error', message: errorText(err), ctx: createContextOf(e.context) },
        }));
      },
    );
}

/** 메일 등록 문맥의 연결 정보(taskId·같은 스레드 티켓) */
function mailLinkOf(raw: unknown): { taskId?: string; threadVoc: string[] } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const link: { taskId?: string; threadVoc: string[] } = {
    threadVoc: Array.isArray(r.threadVoc) ? r.threadVoc.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [],
  };
  if (typeof r.taskId === 'string' && r.taskId.trim() !== '') link.taskId = r.taskId;
  return link;
}

/** 펴 둔 작성 칸 가운데 문맥 읽기가 실패한 것을 다시 읽는다(로그인한 뒤 — setBoard). 접은 칸은 펼 때 openVocCreate 가 읽는다 */
function reloadFailedContexts(): void {
  for (const taskId of createStore.keys()) {
    const e = createStore.get(taskId);
    if (e.open && e.context.status === 'error') loadCreateContext(taskId);
  }
}

/** [VOC 로 등록] — 작성 칸을 펴고(처음이면 새 createId) 문맥을 읽는다. 이미 읽었으면 다시 읽지 않는다 */
export function openVocCreate(taskId: string): void {
  createStore.update(taskId, (e) => ({
    ...e,
    open: true,
    draft: e.draft.createId ? e.draft : { ...e.draft, createId: makeSendId() },
  }));
  const status = createStore.get(taskId).context.status;
  if (status === 'idle' || status === 'error' || status === 'missing') loadCreateContext(taskId);
  startBoard(); // 담당 선택지(팀원)
}

/** [접기] — 적은 내용은 남긴다(다시 펴면 그대로) */
export function collapseVocCreate(taskId: string): void {
  createStore.update(taskId, (e) => (e.open ? { ...e, open: false } : e));
}

/** 적은 내용을 버리고 등록 문맥의 기본값으로 다시 채운다(createId 는 그대로 — 아직 보내지 않았다) */
export function resetVocCreate(taskId: string): void {
  createStore.update(taskId, (e) => {
    const ctx = createContextOf(e.context);
    const blank = initialCreateDraft(e.draft.createId || makeSendId());
    return { ...e, draft: ctx ? prefillCreateDraft(blank, ctx) : blank };
  });
}

/**
 * 티켓 만들기(확인 대화상자의 [실행] 뒤). 성공하면 배지·알림을 남기고 작성 칸을 닫고 새 createId 로 바꾼다.
 * 실패하면 입력과 createId 를 그대로 둔다(같은 createId 는 main 이 두 번 만들지 않는다 — 서버가 분명히 거부한 것은
 * 같은 createId 로 고쳐 다시 보낼 수 있다). main 이 "이미 쓴 createId"(VOC_CREATE_ID_USED — 결과를 모르는 앞선 시도)로
 * 거부하면 createId 만 새로 바꾼다: 사람이 VOC 에서 확인한 뒤 다시 누르면 새 티켓이다. 끝났으면 true
 */
export async function submitVocCreate(taskId: string): Promise<boolean> {
  const entry = createStore.get(taskId);
  if (entry.busy) return false;
  const mailPath = mailTargetPath(taskId);
  // 메일 대상: 연결된 할 일이 하나면 그 할 일로(기존 V3b — 줄에 [voc::]), 아니면 메일만으로
  const linkedTask = mailPath !== null ? entry.mailLink?.taskId : taskId;
  const input = buildCreateInput(entry.draft, linkedTask ?? '');
  if (!input) return false;
  createStore.update(taskId, (e) => ({ ...e, busy: true }));
  const id = ++noticeSeq;
  try {
    const api = vocApi();
    let raw: unknown;
    if (linkedTask) {
      if (!api || typeof api.createVocTicket !== 'function') throw new Error(missingText());
      raw = await api.createVocTicket(input);
    } else {
      if (!api || typeof api.createMailVocTicket !== 'function' || mailPath === null) throw new Error(missingText());
      const { taskId: _omit, ...rest } = input;
      raw = await api.createMailVocTicket({ ...rest, path: mailPath });
    }
    const result = normalizeCreateResult(raw);
    if (!result) throw new Error('VOC 등록 결과를 알아볼 수 없습니다. VOC 화면에서 티켓이 만들어졌는지 확인해 주세요.');
    createStore.update(taskId, (e) => ({
      ...e,
      open: mailPath !== null ? e.open : false,
      created: { number: result.number, ticketId: result.ticketId },
      notice: linkedTask ? createNotice(result, id) : mailCreateNotice(result, id),
      draft: initialCreateDraft(makeSendId()),
    }));
  } catch (err) {
    const message = errorText(err);
    const used = message.includes(VOC_CREATE_ID_USED);
    createStore.update(taskId, (e) => ({
      ...e,
      notice: createFailure(message, id),
      draft: used ? { ...e.draft, createId: makeSendId() } : e.draft,
    }));
  } finally {
    createStore.update(taskId, (e) => ({ ...e, busy: false }));
  }
  return true;
}

