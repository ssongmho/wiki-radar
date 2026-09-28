// 반영 대기열·Claude 실행 구독 훅(2단계). 처음 한 번 읽고, 이후 main 이 보내는 이벤트로 갱신한다.
// 앱 연결(preload)에 2단계 함수가 없으면 supported:false 로 알리고 화면은 그 사실을 문장으로 보인다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueItem, RadarAPI, ReflectRun } from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { newerRun, normalizeQueue, normalizeRun } from '../lib/queue';
import { errorText } from '../lib/snapshot';

export const NO_QUEUE_MESSAGE = '이 앱 연결에는 반영 대기열 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

type QueueApi = Pick<RadarAPI, 'getQueue' | 'removeQueueItem' | 'onQueue'>;
type ReflectApi = Pick<RadarAPI, 'runReflect' | 'getReflect' | 'onReflect'>;

function queueApi(): QueueApi | null {
  const api = getRadar();
  return api && typeof api.getQueue === 'function' ? api : null;
}

function reflectApi(): ReflectApi | null {
  const api = getRadar();
  return api && typeof api.runReflect === 'function' && typeof api.getReflect === 'function' ? api : null;
}

function subscribe<T>(on: ((cb: (v: T) => void) => () => void) | undefined, cb: (v: T) => void): (() => void) | undefined {
  if (typeof on !== 'function') return undefined;
  try {
    const off = on(cb);
    return typeof off === 'function' ? off : undefined;
  } catch {
    return undefined; // 구독하지 못해도 처음 읽은 값과 다시 읽기는 쓸 수 있다
  }
}

export interface QueueHook {
  supported: boolean;
  items: QueueItem[];
  /** 한 번이라도 읽었는가(실패 포함) */
  loaded: boolean;
  error: string | null;
  refresh: () => void;
  /** 대기열에서 뺀다. 실패하면 이유를 돌려준다(성공이면 null) */
  remove: (id: string) => Promise<string | null>;
}

export function useQueue(): QueueHook {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = queueApi() !== null;
  // main 이 보낸 이벤트 수. 읽기 요청을 보낸 뒤 이벤트가 오면 그 요청의 (옛) 응답은 버린다.
  const pushed = useRef(0);
  const alive = useRef(true);

  const accept = useCallback((raw: unknown) => {
    if (!alive.current) return;
    setItems(normalizeQueue(raw));
    setLoaded(true);
    setError(null);
  }, []);

  const refresh = useCallback(() => {
    const api = queueApi();
    if (!api) {
      setError(getRadar() ? NO_QUEUE_MESSAGE : NO_BRIDGE_MESSAGE);
      setLoaded(true);
      return;
    }
    const at = pushed.current;
    Promise.resolve()
      .then(() => api.getQueue())
      .then(
        (raw) => {
          if (pushed.current === at) accept(raw);
        },
        (err: unknown) => {
          if (!alive.current) return;
          setError(errorText(err));
          setLoaded(true);
        },
      );
  }, [accept]);

  useEffect(() => {
    alive.current = true;
    const api = queueApi();
    const off = subscribe<QueueItem[]>(api?.onQueue?.bind(api), (raw) => {
      pushed.current += 1;
      accept(raw);
    });
    refresh();
    return () => {
      alive.current = false;
      off?.();
    };
  }, [accept, refresh]);

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const api = queueApi();
      if (!api || typeof api.removeQueueItem !== 'function') return getRadar() ? NO_QUEUE_MESSAGE : NO_BRIDGE_MESSAGE;
      try {
        const next = await api.removeQueueItem(id);
        pushed.current += 1;
        accept(next);
        return null;
      } catch (err) {
        return errorText(err);
      }
    },
    [accept],
  );

  return { supported, items, loaded, error, refresh, remove };
}

/** 실행 중이면 이 간격으로 다시 읽는다(진행 이벤트를 놓쳐도 화면이 멈추지 않게) */
const POLL_MS = 3000;

export interface ReflectHook {
  supported: boolean;
  /** 실행 중이거나 마지막으로 끝난 실행 */
  run: ReflectRun | null;
  loaded: boolean;
  error: string | null;
  /** [위키에 반영] — 실행을 시작한다. 실패하면 이유를 돌려준다(성공이면 null) */
  start: () => Promise<string | null>;
}

export function useReflect(): ReflectHook {
  const [run, setRun] = useState<ReflectRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = reflectApi() !== null;
  const alive = useRef(true);

  const accept = useCallback((raw: unknown) => {
    if (!alive.current) return;
    const next = normalizeRun(raw);
    setRun((prev) => newerRun(prev, next));
    setLoaded(true);
    setError(null);
  }, []);

  const read = useCallback(() => {
    const api = reflectApi();
    if (!api) {
      setError(getRadar() ? NO_QUEUE_MESSAGE : NO_BRIDGE_MESSAGE);
      setLoaded(true);
      return;
    }
    Promise.resolve()
      .then(() => api.getReflect())
      .then(accept, (err: unknown) => {
        if (!alive.current) return;
        setError(errorText(err));
        setLoaded(true);
      });
  }, [accept]);

  useEffect(() => {
    alive.current = true;
    const api = reflectApi();
    const off = subscribe<ReflectRun>(api?.onReflect?.bind(api), accept);
    read();
    return () => {
      alive.current = false;
      off?.();
    };
  }, [accept, read]);

  const running = run?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(read, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, read]);

  const start = useCallback(async (): Promise<string | null> => {
    const api = reflectApi();
    if (!api) return getRadar() ? NO_QUEUE_MESSAGE : NO_BRIDGE_MESSAGE;
    try {
      accept(await api.runReflect());
      return null;
    } catch (err) {
      return errorText(err);
    }
  }, [accept]);

  return { supported, run, loaded, error, start };
}
