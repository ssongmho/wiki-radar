// 스냅샷 구독 훅: 처음 한 번 getSnapshot, 이후 onSnapshot 으로 새 스냅샷을 받는다.
import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { errorText, newerSnapshot, normalizeSnapshot } from '../lib/snapshot';

export type SnapshotState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: Snapshot };

export interface SnapshotHook {
  state: SnapshotState;
  /** 불러오기를 다시 시도한다(오류 화면의 '다시 시도') */
  reload: () => void;
}

export function useSnapshot(): SnapshotHook {
  const [state, setState] = useState<SnapshotState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const api = getRadar();
    if (!api) {
      setState({ status: 'error', message: NO_BRIDGE_MESSAGE });
      return;
    }
    let alive = true;
    // 이미 화면에 스냅샷이 있으면 오류로 덮지 않는다(다음 갱신을 기다린다).
    const fail = (error: unknown): void => {
      if (!alive) return;
      setState((prev) => (prev.status === 'ready' ? prev : { status: 'error', message: errorText(error) }));
    };
    const accept = (raw: unknown): void => {
      if (!alive) return;
      let next: Snapshot;
      try {
        next = normalizeSnapshot(raw);
      } catch (error) {
        fail(error);
        return;
      }
      setState((prev) => ({
        status: 'ready',
        snapshot: newerSnapshot(prev.status === 'ready' ? prev.snapshot : null, next),
      }));
    };

    let unsubscribe: (() => void) | undefined;
    let unsubscribeGone: (() => void) | undefined;
    try {
      unsubscribe = api.onSnapshot(accept);
    } catch {
      // 구독에 실패해도 첫 요청 결과는 보여 준다.
    }
    try {
      // 보이던 목록이 없어짐(개인 위키 없음 + 팀 동기화 끔 — 2.9단계 §3): 이때만 ready 를 오류로 덮는다
      if (typeof api.onSnapshotGone === 'function') {
        unsubscribeGone = api.onSnapshotGone((message) => {
          if (alive) setState({ status: 'error', message: errorText(new Error(message)) });
        });
      }
    } catch {
      // 옛 preload — 구독 없이
    }
    Promise.resolve()
      .then(() => api.getSnapshot())
      .then(accept, fail);

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof unsubscribeGone === 'function') unsubscribeGone();
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    setAttempt((n) => n + 1);
  }, []);

  return { state, reload };
}
