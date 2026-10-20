// 설정 › 점검(2.7단계, 2.9단계에서 「환경 점검」 → 「설정」) 훅: 처음 한 번 읽고, 창이 초점을 받을 때마다(그사이 claude 를 설치했을 수 있다) 다시 읽는다.
// 앱 연결에 점검 함수가 없으면 supported:false — 화면은 점검 없이 예전처럼 동작한다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarAPI, SetupStatus } from '../../shared/types';
import { getRadar } from '../api';
import { normalizeSetup } from '../lib/setup';
import { errorText } from '../lib/snapshot';

type SetupApi = Pick<RadarAPI, 'getSetup' | 'chooseWikiFolder' | 'markSetupSeen' | 'restartApp'>;

function setupApi(): SetupApi | null {
  const api = getRadar();
  return api && typeof api.getSetup === 'function' ? api : null;
}

export interface SetupHook {
  supported: boolean;
  /** 아직 읽지 못했으면 null */
  status: SetupStatus | null;
  error: string | null;
  reload: () => void;
  /** 폴더 고르기 창. 골랐으면 true, 취소면 false. 실패는 error */
  chooseWiki: () => Promise<boolean>;
  markSeen: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useSetup(): SetupHook {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = setupApi() !== null;
  const seq = useRef(0);

  /** 늦게 온 옛 응답이 새 응답을 덮지 않게 순번을 본다 */
  const accept = useCallback((id: number, raw: unknown) => {
    if (id !== seq.current) return;
    const next = normalizeSetup(raw);
    if (next) {
      setStatus(next);
      setError(null);
    } else {
      setError('설정 점검 응답 형식이 맞지 않습니다');
    }
  }, []);

  const reload = useCallback(() => {
    const api = setupApi();
    if (!api) return;
    const id = ++seq.current;
    api.getSetup().then(
      (raw) => accept(id, raw),
      (err: unknown) => {
        if (id === seq.current) setError(errorText(err));
      },
    );
  }, [accept]);

  useEffect(() => {
    reload();
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);

  const chooseWiki = useCallback(async (): Promise<boolean> => {
    const api = setupApi();
    if (!api) return false;
    const id = ++seq.current;
    try {
      const out = await api.chooseWikiFolder();
      accept(id, out?.status);
      return out?.changed === true;
    } catch (err) {
      if (id === seq.current) setError(errorText(err));
      return false;
    }
  }, [accept]);

  const markSeen = useCallback(async (): Promise<void> => {
    const api = setupApi();
    if (!api) return;
    const id = ++seq.current;
    try {
      accept(id, await api.markSetupSeen());
    } catch (err) {
      if (id === seq.current) setError(errorText(err));
    }
  }, [accept]);

  const restart = useCallback(async (): Promise<void> => {
    const api = setupApi();
    if (!api) return;
    try {
      await api.restartApp();
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  return { supported, status, error, reload, chooseWiki, markSeen, restart };
}
