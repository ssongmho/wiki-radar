// 위키 검색·변경(3a단계 명세 §8·§10) 상태: 요약(내비 배지·사이드바 「변경 N」 — 창마다 한 번만 구독) · 검색 결과 · 최근 문서 ·
// 변경 목록 · log 최근 기록 · 문서 한 개. 목록·결과는 요약의 revision 이 바뀌면 다시 부른다(§3-2).
// 문서 본문은 데이터다 — 받은 글자를 들고 있고 미리보기는 wikiMarkdown(§7)으로만 그린다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  MarkWikiSeenInput,
  RadarAPI,
  WikiChangesPage,
  WikiDocInput,
  WikiDocRef,
  WikiDocSource,
  WikiDocsSummary,
  WikiLogEntry,
  WikiPage,
  WikiSearchPage,
  WikiSearchSource,
} from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { errorText } from '../lib/snapshot';
import { WIKI_RECENT_COUNT, normalizeWikiSummary } from '../lib/wiki';

export const NO_WIKI_DOCS_MESSAGE = '이 앱 연결에는 위키 검색 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

type WikiApi = Required<
  Pick<
    RadarAPI,
    | 'getWikiDocs'
    | 'onWikiDocs'
    | 'refreshWikiDocs'
    | 'searchWiki'
    | 'recentWikiDocs'
    | 'getWikiPage'
    | 'getWikiImage'
    | 'getWikiChanges'
    | 'getWikiLogRecent'
    | 'markWikiSeen'
    | 'undoWikiSeen'
    | 'openExternalLink'
  >
>;

/** 앱 연결에 위키 문서 기능이 있으면 그 함수들(옛 preload 면 null — 메뉴·상태 줄 칸을 숨긴다) */
export function wikiApi(): WikiApi | null {
  const api = getRadar();
  if (!api) return null;
  const names: (keyof WikiApi)[] = ['getWikiDocs', 'onWikiDocs', 'searchWiki', 'getWikiPage', 'getWikiChanges', 'markWikiSeen'];
  return names.every((n) => typeof api[n] === 'function') ? (api as unknown as WikiApi) : null;
}

function requireApi(): WikiApi {
  const api = wikiApi();
  if (!api) throw new Error(getRadar() ? NO_WIKI_DOCS_MESSAGE : NO_BRIDGE_MESSAGE);
  return api;
}

// ── 요약(창마다 한 번 구독) ──

let summary: WikiDocsSummary | null = null;
let started = false;
const listeners = new Set<() => void>();

function setSummary(raw: unknown): void {
  const next = normalizeWikiSummary(raw);
  if (!next) return;
  // 늦게 온 옛 요약이 새 것을 덮지 않게(revision 은 늘기만 한다)
  if (summary && next.revision < summary.revision) return;
  summary = next;
  for (const l of [...listeners]) l();
}

function startSummary(): void {
  if (started) return;
  const api = wikiApi();
  if (!api) return;
  started = true;
  try {
    api.onWikiDocs(setSummary);
  } catch {
    // 구독하지 못하면 처음 받은 요약만 쓴다
  }
  Promise.resolve()
    .then(() => api.getWikiDocs())
    .then(setSummary, () => undefined);
}

function subscribe(listener: () => void): () => void {
  startSummary();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSummary = (): WikiDocsSummary | null => summary;

export interface WikiSummaryHook {
  supported: boolean;
  summary: WikiDocsSummary | null;
}

export function useWikiSummary(): WikiSummaryHook {
  const value = useSyncExternalStore(subscribe, getSummary, getSummary);
  return { supported: wikiApi() !== null, summary: value };
}

/** 쓰기 결과로 받은 요약을 넣는다(이벤트보다 먼저 화면에 반영) */
export function acceptWikiSummary(raw: unknown): void {
  setSummary(raw);
}

/** 두 출처 증분 색인을 기다린다(화면을 열 때 오래됐으면) */
export async function refreshWikiDocs(): Promise<void> {
  const api = wikiApi();
  if (!api || typeof api.refreshWikiDocs !== 'function') return;
  setSummary(await api.refreshWikiDocs());
}

/** 읽음으로 바꾸기. 되돌리기 표(undoToken)를 돌려준다. 실패하면 던진다 */
export async function markWikiSeen(input: MarkWikiSeenInput): Promise<string | undefined> {
  const out = await requireApi().markWikiSeen(input);
  setSummary(out);
  return out && typeof out.undoToken === 'string' ? out.undoToken : undefined;
}

export async function undoWikiSeen(token: string): Promise<void> {
  const api = requireApi();
  if (typeof api.undoWikiSeen !== 'function') throw new Error(NO_WIKI_DOCS_MESSAGE);
  setSummary(await api.undoWikiSeen(token));
}

export async function fetchWikiPage(ref: WikiDocInput): Promise<WikiPage | null> {
  const page = await requireApi().getWikiPage({ source: ref.source, path: ref.path });
  return page && typeof page === 'object' && typeof page.body === 'string' ? page : null;
}

export async function fetchWikiImage(source: WikiDocSource, page: string, ref: string): Promise<{ dataUrl?: string; problem?: string }> {
  const api = requireApi();
  if (typeof api.getWikiImage !== 'function') return { problem: NO_WIKI_DOCS_MESSAGE };
  const out = await api.getWikiImage({ source, page, ref });
  if (out && typeof out === 'object' && 'dataUrl' in out && typeof out.dataUrl === 'string' && out.dataUrl.startsWith('data:image/')) {
    return { dataUrl: out.dataUrl };
  }
  return { problem: out && typeof out === 'object' && 'problem' in out && typeof out.problem === 'string' ? out.problem : '그림을 읽지 못함' };
}

export async function openExternalLink(url: string): Promise<void> {
  const api = requireApi();
  if (typeof api.openExternalLink !== 'function') throw new Error(NO_WIKI_DOCS_MESSAGE);
  await api.openExternalLink(url);
}

// ── 검색 ──

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WikiSearchHook {
  status: LoadStatus;
  page: WikiSearchPage | null;
  /** 받은 결과의 질의(지금 질의와 다르면 옛 결과) */
  query: string;
  message?: string;
}

const EMPTY_SEARCH: WikiSearchHook = { status: 'idle', page: null, query: '' };

export function useWikiSearch(query: string, source: WikiSearchSource, limit: number, revision: number, enabled: boolean): WikiSearchHook {
  const [state, setState] = useState<WikiSearchHook>(EMPTY_SEARCH);
  const q = query.trim();
  useEffect(() => {
    if (!enabled || !q) {
      setState(EMPTY_SEARCH);
      return;
    }
    let live = true;
    setState((s) => ({ ...s, status: s.page ? s.status : 'loading' }));
    requireApiAsync()
      .then((api) => api.searchWiki({ query: q.slice(0, 200), source, limit, offset: 0 }))
      .then(
        (page) => {
          if (live) setState({ status: 'ready', page, query: q });
        },
        (err: unknown) => {
          if (live) setState({ status: 'error', page: null, query: q, message: errorText(err) });
        },
      );
    return () => {
      live = false;
    };
  }, [q, source, limit, revision, enabled]);
  return state;
}

function requireApiAsync(): Promise<WikiApi> {
  try {
    return Promise.resolve(requireApi());
  } catch (err) {
    return Promise.reject(err);
  }
}

export function useRecentDocs(revision: number, enabled: boolean): WikiDocRef[] {
  const [docs, setDocs] = useState<WikiDocRef[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const api = wikiApi();
    if (!api || typeof api.recentWikiDocs !== 'function') return;
    api.recentWikiDocs({ source: 'all', limit: WIKI_RECENT_COUNT }).then(
      (out) => {
        if (live && Array.isArray(out)) setDocs(out);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [revision, enabled]);
  return docs;
}

// ── 변경 ──

export interface WikiChangesHook {
  status: LoadStatus;
  page: WikiChangesPage | null;
  /** 받은 목록의 출처 */
  source: WikiDocSource | null;
  message?: string;
  reload: () => void;
}

export function useWikiChanges(source: WikiDocSource, revision: number, enabled: boolean): WikiChangesHook {
  const [state, setState] = useState<Omit<WikiChangesHook, 'reload'>>({ status: 'idle', page: null, source: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState((s) => (s.source === source && s.page ? s : { status: 'loading', page: null, source }));
    requireApiAsync()
      .then((api) => api.getWikiChanges({ source, offset: 0, limit: 200 }))
      .then(
        (page) => {
          if (live) setState({ status: 'ready', page, source });
        },
        (err: unknown) => {
          if (live) setState({ status: 'error', page: null, source, message: errorText(err) });
        },
      );
    return () => {
      live = false;
    };
  }, [source, revision, enabled, tick]);
  return { ...state, reload };
}

export function useWikiLogRecent(revision: number, enabled: boolean): WikiLogEntry[] {
  const [entries, setEntries] = useState<WikiLogEntry[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const api = wikiApi();
    if (!api || typeof api.getWikiLogRecent !== 'function') return;
    let live = true;
    api.getWikiLogRecent().then(
      (out) => {
        if (live && Array.isArray(out)) setEntries(out);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [revision, enabled]);
  return entries;
}

/** 화면을 열 때 한 번: 마지막 색인이 오래됐으면 다시 확인 */
export function useRecheckOnOpen(check: () => boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (check()) void refreshWikiDocs().catch(() => undefined);
    // 열 때 한 번만
  }, []);
}
