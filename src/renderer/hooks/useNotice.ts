// 잠깐 떴다 사라지는 안내 문구(예: Obsidian 으로 열지 못함).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarAPI } from '../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { errorText } from '../lib/snapshot';

const NOTICE_MS = 5000;

export interface NoticeHook {
  notice: string | null;
  notify: (message: string) => void;
  /** window.radar 호출을 감싼다. 실패하면 failText 와 이유를 안내한다. */
  run: <T>(call: (api: RadarAPI) => Promise<T> | T, failText: string) => Promise<T | undefined>;
}

export function useNotice(): NoticeHook {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback(
    async <T,>(call: (api: RadarAPI) => Promise<T> | T, failText: string): Promise<T | undefined> => {
      const api = getRadar();
      if (!api) {
        notify(`${failText} ${NO_BRIDGE_MESSAGE}`);
        return undefined;
      }
      try {
        return await call(api);
      } catch (error) {
        notify(`${failText} (${errorText(error)})`);
        return undefined;
      }
    },
    [notify],
  );

  return { notice, notify, run };
}
