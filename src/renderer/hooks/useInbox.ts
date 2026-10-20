// 알림함(2.9단계 §8) 훅: 처음 한 번 읽고 main 이 보내는 알림함(radar:inbox)을 구독한다. 읽음·열기·이런 알림 끄기도 여기서.
// 앱 연결에 알림 함수가 없으면(옛 preload) supported:false — 화면은 종·긴급 띠를 그리지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxState, NotifyKind, NotifySettings, RadarAPI, SnoozeKind } from '../../shared/types';
import { getRadar } from '../api';
import { normalizeInbox } from '../lib/inbox';
import { errorText } from '../lib/snapshot';

type InboxApi = Pick<
  RadarAPI,
  'getInbox' | 'onInbox' | 'markInboxRead' | 'openInboxItem' | 'muteNotifyKind' | 'saveNotifySettings' | 'getNotifySettings' | 'snoozeInboxItems'
>;

function inboxApi(): InboxApi | null {
  const api = getRadar();
  return api &&
    typeof api.getInbox === 'function' &&
    typeof api.onInbox === 'function' &&
    typeof api.markInboxRead === 'function' &&
    typeof api.openInboxItem === 'function'
    ? api
    : null;
}

export interface InboxHook {
  supported: boolean;
  inbox: InboxState | null;
  error: string | null;
  markAllRead: () => Promise<void>;
  /** 읽음으로 바꾸고 그 대상으로 간다(main 이 창을 바꾼다) */
  open: (id: string) => Promise<void>;
  /** 그 종류를 끈다. 되돌리기용으로 끄기 전 설정을 돌려준다(실패하면 null) */
  mute: (kind: NotifyKind) => Promise<NotifySettings | null>;
  /** 끄기 전 설정을 다시 저장한다 */
  restore: (settings: NotifySettings) => Promise<boolean>;
  /** [나중에]를 쓸 수 있는가(옛 preload 면 거짓 — 단추를 숨긴다) */
  snoozeSupported: boolean;
  /** 미룬다(2.12단계 §3-1). 실패는 error */
  snooze: (ids: string[], until: SnoozeKind) => Promise<void>;
}

export function useInbox(): InboxHook {
  const [inbox, setInbox] = useState<InboxState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = inboxApi() !== null;
  const seq = useRef(0);

  const accept = useCallback((raw: unknown) => {
    const next = normalizeInbox(raw);
    if (next) setInbox(next);
  }, []);

  useEffect(() => {
    const api = inboxApi();
    if (!api) return;
    const id = ++seq.current;
    api.getInbox().then(
      (raw) => {
        if (id === seq.current) accept(raw);
      },
      (err: unknown) => setError(errorText(err)),
    );
    return api.onInbox((raw) => {
      seq.current++;
      accept(raw);
    });
  }, [accept]);

  const markAllRead = useCallback(async (): Promise<void> => {
    const api = inboxApi();
    if (!api) return;
    try {
      seq.current++;
      accept(await api.markInboxRead('all'));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [accept]);

  const open = useCallback(async (id: string): Promise<void> => {
    const api = inboxApi();
    if (!api) return;
    try {
      await api.openInboxItem(id);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const mute = useCallback(async (kind: NotifyKind): Promise<NotifySettings | null> => {
    const api = inboxApi();
    if (!api || typeof api.muteNotifyKind !== 'function' || typeof api.getNotifySettings !== 'function') return null;
    try {
      const before = await api.getNotifySettings();
      await api.muteNotifyKind(kind);
      setError(null);
      return before;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  }, []);

  const restore = useCallback(async (settings: NotifySettings): Promise<boolean> => {
    const api = inboxApi();
    if (!api || typeof api.saveNotifySettings !== 'function') return false;
    try {
      await api.saveNotifySettings(settings);
      setError(null);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  }, []);

  const snoozeSupported = typeof inboxApi()?.snoozeInboxItems === 'function';
  const snooze = useCallback(
    async (ids: string[], until: SnoozeKind): Promise<void> => {
      const api = inboxApi();
      if (!api || typeof api.snoozeInboxItems !== 'function') return;
      try {
        seq.current++;
        accept(await api.snoozeInboxItems({ ids, until }));
        setError(null);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [accept],
  );

  return { supported, inbox, error, markAllRead, open, mute, restore, snoozeSupported, snooze };
}
