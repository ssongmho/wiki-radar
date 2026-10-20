// VOC 보드 구독·쓰기·답변 읽기 훅(2.6단계 명세 §3·§4). 처음 한 번 getVocBoard, 이후 main 이 보내는 onVocBoard 로 갱신한다.
// 앱 연결(preload)에 2.6단계 함수가 없으면 supported:false 로 알리고 화면은 그 사실을 문장으로 보인다.
// 쓰기(vocAction)는 확인 대화상자 뒤에만 부른다 — 이 훅은 부르기·중복 막기·결과 알림만 맡는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarAPI, VocActionInput, VocActionKind, VocActionResult, VocBoard, VocTicketDetail } from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { errorText } from '../lib/snapshot';
import {
  actionFailure,
  actionNotice,
  expectedOf,
  normalizeTicketDetail,
  normalizeVocBoard,
  type VocActionNotice,
  type VocPendingAction,
} from '../lib/voc';

export const NO_VOC_MESSAGE = '이 앱 연결에는 VOC 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

type BoardApi = Pick<RadarAPI, 'getVocBoard' | 'onVocBoard' | 'refreshVoc'>;

function boardApi(): BoardApi | null {
  const api = getRadar();
  return api && typeof api.getVocBoard === 'function' ? api : null;
}

function missingText(): string {
  return getRadar() ? NO_VOC_MESSAGE : NO_BRIDGE_MESSAGE;
}

export interface VocBoardHook {
  /** 앱 연결에 VOC 기능이 있는가 */
  supported: boolean;
  /** 마지막으로 받은 보드(아직 없으면 null) */
  board: VocBoard | null;
  /** 보드를 읽지 못한 이유(앱 연결 문제 등). VOC 쪽 문제는 board.state·message 로 온다 */
  error: string | null;
  /** [새로고침]을 눌러 기다리는 중 */
  refreshing: boolean;
  /** 지금 새로 받는다. 부르지 못했으면 그 이유, 아니면 null */
  refresh: () => Promise<string | null>;
}

export function useVocBoard(): VocBoardHook {
  const [board, setBoard] = useState<VocBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const supported = boardApi() !== null;
  // main 이 보낸 이벤트 수. 읽기 요청을 보낸 뒤 이벤트가 오면 그 요청의 (옛) 응답은 버린다.
  const pushed = useRef(0);
  const alive = useRef(true);

  const accept = useCallback((raw: unknown) => {
    if (!alive.current) return;
    setBoard(normalizeVocBoard(raw));
    setError(null);
  }, []);

  useEffect(() => {
    alive.current = true;
    const api = boardApi();
    if (!api) {
      setError(missingText());
      return () => {
        alive.current = false;
      };
    }
    let off: (() => void) | undefined;
    if (typeof api.onVocBoard === 'function') {
      try {
        const o = api.onVocBoard((raw) => {
          pushed.current += 1;
          accept(raw);
        });
        off = typeof o === 'function' ? o : undefined;
      } catch {
        // 구독하지 못해도 처음 읽은 값과 [새로고침]은 쓸 수 있다
      }
    }
    const at = pushed.current;
    Promise.resolve()
      .then(() => api.getVocBoard())
      .then(
        (raw) => {
          if (pushed.current === at) accept(raw);
        },
        (err: unknown) => {
          if (alive.current) setError(errorText(err));
        },
      );
    return () => {
      alive.current = false;
      off?.();
    };
  }, [accept]);

  // 받는 중에 또 부르면 같은 약속(끝날 때 함께 풀린다 — 끝난 뒤의 보드로 판정하려는 쪽이 기다릴 수 있게)
  const inflight = useRef<Promise<string | null> | null>(null);
  const refresh = useCallback((): Promise<string | null> => {
    const api = boardApi();
    if (!api || typeof api.refreshVoc !== 'function') return Promise.resolve(missingText());
    if (inflight.current) return inflight.current;
    setRefreshing(true);
    const job = (async (): Promise<string | null> => {
      try {
        // then 안에서 부른다 — 곧바로 던져도 finally 가 inflight 를 맡긴 뒤에 돈다
        const raw = await Promise.resolve().then(() => api.refreshVoc());
        pushed.current += 1;
        accept(raw);
        return null;
      } catch (err) {
        return errorText(err);
      } finally {
        inflight.current = null;
        if (alive.current) setRefreshing(false);
      }
    })();
    inflight.current = job;
    return job;
  }, [accept]);

  return { supported, board, error, refreshing, refresh };
}

export interface VocActionsHook {
  supported: boolean;
  /** 동작이 실행 중인 티켓(내부 id → 동작). 실행 중에는 같은 티켓의 다른 동작을 막는다(명세 §4) */
  busy: ReadonlyMap<number, VocActionKind>;
  notice: VocActionNotice | null;
  closeNotice: () => void;
  /** 확인 대화상자의 [실행] 뒤에 부른다. 결과(실패 포함) 또는 부르지 못했으면 null */
  run: (pending: VocPendingAction) => Promise<VocActionResult | null>;
}

export function useVocActions(): VocActionsHook {
  const [busy, setBusy] = useState<ReadonlyMap<number, VocActionKind>>(() => new Map());
  // 두 번 누르기 방지: 상태 갱신은 다음 그리기에 반영되므로 ref 로 바로 막는다
  const busyRef = useRef(new Set<number>());
  const done = useRef(new Set<string>());
  const [notice, setNotice] = useState<VocActionNotice | null>(null);
  const seq = useRef(0);
  const api = getRadar();
  const supported = !!api && typeof api.vocAction === 'function';

  const closeNotice = useCallback(() => setNotice(null), []);

  const run = useCallback(async (pending: VocPendingAction): Promise<VocActionResult | null> => {
    const ticketId = pending.ticket.id;
    if (busyRef.current.has(ticketId) || done.current.has(pending.actionId)) return null;
    const id = ++seq.current;
    const api = getRadar();
    if (!api || typeof api.vocAction !== 'function') {
      setNotice(actionFailure(missingText(), pending, id));
      return null;
    }
    busyRef.current.add(ticketId);
    done.current.add(pending.actionId);
    setBusy((prev) => new Map(prev).set(ticketId, pending.kind));
    try {
      // 대화상자가 보인 값(pending.ticket — 물을 때의 사본)을 함께 보낸다. main 은 쓰기 직전 VOC 에서 다시 읽어 다르면 실행하지 않는다
      const input: VocActionInput = { actionId: pending.actionId, kind: pending.kind, ticketId, value: pending.value };
      const expected = expectedOf(pending.ticket, pending.kind);
      if (expected) input.expected = expected;
      const result = await api.vocAction(input);
      setNotice(actionNotice(result, pending, id));
      return result;
    } catch (err) {
      setNotice(actionFailure(errorText(err), pending, id));
      return null;
    } finally {
      busyRef.current.delete(ticketId);
      setBusy((prev) => {
        const next = new Map(prev);
        next.delete(ticketId);
        return next;
      });
    }
  }, []);

  return { supported, busy, notice, closeNotice, run };
}

export type VocRepliesEntry =
  | { status: 'loading'; detail?: VocTicketDetail }
  | { status: 'ready'; detail: VocTicketDetail }
  | { status: 'error'; message: string; detail?: VocTicketDetail };

export interface VocRepliesHook {
  entryOf: (ticketId: number) => VocRepliesEntry | undefined;
  /** ticket get <id> --replies 한 번(누를 때마다 새로) */
  load: (ticketId: number) => void;
}

/** [답변 보기] — 티켓마다 마지막으로 받은 답변 목록(메모리에만) */
export function useVocReplies(): VocRepliesHook {
  const [entries, setEntries] = useState<ReadonlyMap<number, VocRepliesEntry>>(() => new Map());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const seqs = useRef(new Map<number, number>());

  const entryOf = useCallback((ticketId: number) => entries.get(ticketId), [entries]);

  const load = useCallback((ticketId: number) => {
    const set = (entry: VocRepliesEntry): void => setEntries((prev) => new Map(prev).set(ticketId, entry));
    const api = getRadar();
    if (!api || typeof api.getVocTicket !== 'function') {
      set({ status: 'error', message: missingText() });
      return;
    }
    const seq = (seqs.current.get(ticketId) ?? 0) + 1;
    seqs.current.set(ticketId, seq);
    const previous = entriesRef.current.get(ticketId)?.detail;
    set({ status: 'loading', detail: previous });
    Promise.resolve()
      .then(() => api.getVocTicket(ticketId))
      .then(
        (raw) => {
          if (seqs.current.get(ticketId) !== seq) return;
          try {
            set({ status: 'ready', detail: normalizeTicketDetail(raw) });
          } catch (err) {
            set({ status: 'error', message: errorText(err), detail: previous });
          }
        },
        (err: unknown) => {
          if (seqs.current.get(ticketId) === seq) set({ status: 'error', message: errorText(err), detail: previous });
        },
      );
  }, []);

  return { entryOf, load };
}

/** intervalMs 마다 바뀌는 지금 시각(ms) — '3분 전' 같은 글자를 새로 그린다 */
export function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
