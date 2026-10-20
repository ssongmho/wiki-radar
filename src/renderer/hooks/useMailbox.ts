// 메일함(2.10단계 명세 §8·§9) 상태: 요약(내비 배지·사이드바 블록 — 창마다 한 번만 구독) · 목록 쪽 · 스레드 · 메일 한 통.
// 목록은 main 이 거르고 200줄씩 보낸다 — 화면은 요약의 revision 이 바뀌면 다시 부른다(§5-2). 메일 본문은 데이터다:
// 받은 글자를 그대로 들고 있고 화면은 텍스트 노드로만 그린다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  MailMessage,
  MailStateChange,
  MailThreadDetail,
  MailThreadPage,
  MailThreadQuery,
  MailboxSummary,
  RadarAPI,
} from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { MAIL_PAGE_SIZE, MAIL_SEARCH_DELAY_MS, mailListKey, normalizeMessage, normalizePage, normalizeSummary } from '../lib/mailbox';
import { errorText } from '../lib/snapshot';

export const NO_MAILBOX_MESSAGE = '이 앱 연결에는 메일함 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

type MailboxApi = Required<
  Pick<
    RadarAPI,
    | 'getMailbox'
    | 'onMailbox'
    | 'refreshMailbox'
    | 'listMailThreads'
    | 'getMailThread'
    | 'findMailThread'
    | 'getMailMessage'
    | 'setMailState'
    | 'revealMailAttachment'
  >
>;

/** 앱 연결에 메일함 기능이 있으면 그 함수들(옛 preload 면 null — 메뉴·사이드바 블록을 숨긴다) */
export function mailboxApi(): MailboxApi | null {
  const api = getRadar();
  if (!api) return null;
  const names: (keyof MailboxApi)[] = [
    'getMailbox',
    'onMailbox',
    'listMailThreads',
    'getMailThread',
    'getMailMessage',
    'setMailState',
  ];
  return names.every((n) => typeof api[n] === 'function') ? (api as unknown as MailboxApi) : null;
}

function missingText(): string {
  return getRadar() ? NO_MAILBOX_MESSAGE : NO_BRIDGE_MESSAGE;
}

// ── 요약(창마다 한 번 구독) ──

let summary: MailboxSummary | null = null;
let started = false;
const listeners = new Set<() => void>();

function setSummary(raw: unknown): void {
  const next = normalizeSummary(raw);
  if (!next) return;
  // 늦게 온 옛 요약이 새 것을 덮지 않게(revision 은 늘기만 한다 — 같으면 상태만 바뀐 것일 수 있어 받는다)
  if (summary && next.revision < summary.revision && next.state === summary.state) return;
  summary = next;
  for (const l of [...listeners]) l();
}

function startSummary(): void {
  if (started) return;
  const api = mailboxApi();
  if (!api) return;
  started = true;
  try {
    api.onMailbox(setSummary);
  } catch {
    // 구독하지 못하면 처음 받은 요약만 쓴다
  }
  Promise.resolve()
    .then(() => api.getMailbox())
    .then(setSummary, () => undefined);
}

function subscribe(listener: () => void): () => void {
  startSummary();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSummary = (): MailboxSummary | null => summary;

export interface MailboxSummaryHook {
  /** 앱 연결에 메일함이 있는가 */
  supported: boolean;
  summary: MailboxSummary | null;
}

export function useMailboxSummary(): MailboxSummaryHook {
  const value = useSyncExternalStore(subscribe, getSummary, getSummary);
  return { supported: mailboxApi() !== null, summary: value };
}

/** 쓰기 결과로 받은 요약을 넣는다(이벤트보다 먼저 화면에 반영) */
export function acceptSummary(raw: unknown): void {
  setSummary(raw);
}

/** 메일 상태 바꾸기(§3-3). 실패하면 던진다 */
export async function changeMailState(keys: string[], change: MailStateChange): Promise<MailboxSummary | null> {
  const api = mailboxApi();
  if (!api) throw new Error(missingText());
  if (keys.length === 0) return summary;
  const out = await api.setMailState({ keys: keys.slice(0, 500), change });
  setSummary(out);
  return normalizeSummary(out);
}

/** 메일함 다시 확인(증분 색인을 기다린다) */
export async function refreshMailbox(): Promise<void> {
  const api = mailboxApi();
  if (!api || typeof api.refreshMailbox !== 'function') return;
  setSummary(await api.refreshMailbox());
}

// ── 목록 ──

export interface MailListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  page: MailThreadPage;
  message?: string;
  /** 더 보기 받는 중 */
  loadingMore: boolean;
  /** 지금 page 를 받은 질의 열쇠(`mailListKey`) — 질의를 바꾼 직후에는 옛 질의의 쪽이 잠시 남아 있다 */
  queryKey?: string;
}

const EMPTY_PAGE: MailThreadPage = {
  threads: [],
  total: 0,
  counts: { all: 0, unread: 0, replyNeeded: 0, archived: 0 },
  folders: [],
  revision: 0,
};

/** 입력이 멈춘 뒤의 값(검색 300ms) */
export function useDebounced<T>(value: T, ms = MAIL_SEARCH_DELAY_MS): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    if (Object.is(out, value)) return;
    const t = window.setTimeout(() => setOut(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms, out]);
  return out;
}

export interface MailListHook extends MailListState {
  loadMore: () => void;
  reload: () => void;
}

/**
 * 목록 질의(필터·폴더·검색어·노이즈). revision 이 바뀌면(새 메일·상태 바꿈) 받은 만큼 다시 부른다. active 가 아니면 부르지 않는다
 */
/**
 * keep: 필터에 안 맞아도 목록에 남길 스레드 id(지금 읽는 것). 질의 키에 넣지 않는다 — 고를 때마다 다시 받지 않고,
 * 다음에 받을 때(새 revision — 읽음으로 바뀜 등) 그 값을 실어 보낸다
 */
export function useMailList(
  query: Omit<MailThreadQuery, 'offset' | 'limit' | 'keep'>,
  revision: number,
  active: boolean,
  keep: string | null = null,
): MailListHook {
  const keepRef = useRef(keep);
  keepRef.current = keep;
  const [state, setState] = useState<MailListState>({ status: 'idle', page: EMPTY_PAGE, loadingMore: false });
  const seq = useRef(0);
  const loadedRef = useRef(MAIL_PAGE_SIZE);
  const [nonce, setNonce] = useState(0);
  const key = mailListKey(query);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const api = mailboxApi();
    if (!api) {
      setState({ status: 'error', page: EMPTY_PAGE, message: missingText(), loadingMore: false });
      return;
    }
    // 질의가 바뀌면 첫 쪽부터, 같은 질의의 새 revision 이면 받은 만큼
    if (lastKey.current !== key) loadedRef.current = MAIL_PAGE_SIZE;
    lastKey.current = key;
    const my = ++seq.current;
    const want = Math.max(MAIL_PAGE_SIZE, loadedRef.current);
    setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading' }));
    void (async () => {
      try {
        const base: MailThreadQuery = { ...queryOfKey(key), offset: 0, limit: MAIL_PAGE_SIZE };
        if (keepRef.current) base.keep = [keepRef.current];
        let page = normalizePage(await api.listMailThreads(base));
        while (page.threads.length < Math.min(want, page.total)) {
          const more = normalizePage(await api.listMailThreads({ ...base, offset: page.threads.length }));
          if (more.threads.length === 0) break;
          page = { ...more, threads: [...page.threads, ...more.threads] };
        }
        if (seq.current !== my) return;
        setState({ status: 'ready', page, loadingMore: false, queryKey: key });
      } catch (err) {
        if (seq.current !== my) return;
        setState((s) => ({ ...s, status: 'error', message: errorText(err), loadingMore: false }));
      }
    })();
    // query 는 key 로 비교한다
  }, [key, revision, active, nonce]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const loadMore = useCallback(() => {
    const api = mailboxApi();
    const s = stateRef.current;
    if (!api || s.loadingMore || s.page.threads.length >= s.page.total) return;
    // 진행 중인 다시 부르기(revision)를 버리지 않는다 — 그쪽이 나중에 오면 늘려 둔 몫까지 받은 것으로 바꾼다
    const my = seq.current;
    const offset = s.page.threads.length;
    // 받는 동안 새 메일(revision)로 다시 부르면 그쪽이 이 몫까지 받게 먼저 늘려 둔다(더 받은 줄이 사라지지 않게)
    loadedRef.current = Math.max(loadedRef.current, offset + MAIL_PAGE_SIZE);
    setState((cur) => ({ ...cur, loadingMore: true }));
    Promise.resolve()
      .then(() => api.listMailThreads({ ...queryOfKey(key), ...(keepRef.current ? { keep: [keepRef.current] } : {}), offset, limit: MAIL_PAGE_SIZE }))
      .then(
        (raw) => {
          if (seq.current !== my) return;
          const more = normalizePage(raw);
          setState((cur) => {
            const seen = new Set(cur.page.threads.map((c) => c.id));
            const threads = [...cur.page.threads, ...more.threads.filter((t) => !seen.has(t.id))];
            loadedRef.current = threads.length;
            return { status: 'ready', page: { ...more, threads }, loadingMore: false, queryKey: key };
          });
        },
        (err: unknown) => {
          if (seq.current !== my) return;
          setState((cur) => ({ ...cur, loadingMore: false, message: errorText(err) }));
        },
      );
  }, [key]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, loadMore, reload };
}

/** 목록 질의 key(JSON) → 질의(더 보기에서 지금 질의를 다시 쓴다) */
function queryOfKey(key: string): Omit<MailThreadQuery, 'offset' | 'limit'> {
  const [filter, folder, query, includeMuted] = JSON.parse(key) as [MailThreadQuery['filter'], string | null, string, boolean];
  const q: Omit<MailThreadQuery, 'offset' | 'limit'> = { filter, includeMuted };
  if (folder) q.folder = folder;
  if (query) q.query = query;
  return q;
}

// ── 스레드 ──

export interface ThreadEntry {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  detail: MailThreadDetail | null;
  message?: string;
}

/** 스레드 상세. revision 이 바뀌면 다시 읽는다. 없어졌으면(missing) onMissing 이 메일 키로 새 id 를 찾을 수 있다 */
export function useMailThread(threadId: string | null, revision: number): ThreadEntry {
  const [entry, setEntry] = useState<ThreadEntry>({ status: 'idle', detail: null });
  const seq = useRef(0);
  useEffect(() => {
    if (!threadId) {
      setEntry({ status: 'idle', detail: null });
      return;
    }
    const api = mailboxApi();
    if (!api) {
      setEntry({ status: 'error', detail: null, message: missingText() });
      return;
    }
    const my = ++seq.current;
    setEntry((e) => ({ status: e.detail?.id === threadId ? 'ready' : 'loading', detail: e.detail?.id === threadId ? e.detail : null }));
    Promise.resolve()
      .then(() => api.getMailThread(threadId))
      .then(
        (raw) => {
          if (seq.current !== my) return;
          const detail = raw && typeof raw === 'object' && Array.isArray((raw as MailThreadDetail).mails) ? (raw as MailThreadDetail) : null;
          setEntry(detail ? { status: 'ready', detail } : { status: 'missing', detail: null });
        },
        (err: unknown) => {
          if (seq.current !== my) return;
          setEntry({ status: 'error', detail: null, message: errorText(err) });
        },
      );
  }, [threadId, revision]);
  return entry;
}

/** 메일 키 → 그 메일의 스레드 id(view:mail:<키> 열기·스레드 id 가 바뀌었을 때). 없으면 null */
export async function findThreadOf(key: string): Promise<string | null> {
  const api = mailboxApi();
  if (!api || typeof api.findMailThread !== 'function') return null;
  try {
    const out = await api.findMailThread(key);
    return out && typeof out.threadId === 'string' ? out.threadId : null;
  } catch {
    return null;
  }
}

// ── 메일 한 통 ──

export interface MessageEntry {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  message: MailMessage | null;
  error?: string;
}

/** 메일 한 통(본문). 경로가 바뀔 때만 읽는다 */
export function useMailMessage(path: string | null): MessageEntry {
  const [entry, setEntry] = useState<MessageEntry>({ status: 'idle', message: null });
  const seq = useRef(0);
  useEffect(() => {
    if (!path) {
      setEntry({ status: 'idle', message: null });
      return;
    }
    const api = mailboxApi();
    if (!api) {
      setEntry({ status: 'error', message: null, error: missingText() });
      return;
    }
    const my = ++seq.current;
    setEntry({ status: 'loading', message: null });
    Promise.resolve()
      .then(() => api.getMailMessage(path))
      .then(
        (raw) => {
          if (seq.current !== my) return;
          const msg = normalizeMessage(raw);
          setEntry(msg ? { status: 'ready', message: msg } : { status: 'missing', message: null });
        },
        (err: unknown) => {
          if (seq.current !== my) return;
          setEntry({ status: 'error', message: null, error: errorText(err) });
        },
      );
  }, [path]);
  return entry;
}

/** 첨부를 탐색기에서 보인다(열지 않는다 — §6-3). 실패하면 던진다 */
export async function revealAttachment(path: string, index: number): Promise<void> {
  const api = mailboxApi();
  if (!api || typeof api.revealMailAttachment !== 'function') throw new Error(missingText());
  await api.revealMailAttachment({ path, index });
}
