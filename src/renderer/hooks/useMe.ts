// 설정 › 나(2.9단계 §4-4) 훅: 처음 한 번 읽고, VOC 로그인 이름이 바뀌면(로그인·다른 계정) 다시 읽는다.
// 앱 연결에 getMe 가 없으면 supported:false — 화면은 「나」 칸에 그 사실만 적는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MeInfo, MeSettings, RadarAPI } from '../../shared/types';
import { getRadar } from '../api';
import { normalizeMe } from '../lib/me';
import { errorText } from '../lib/snapshot';

type MeApi = Pick<RadarAPI, 'getMe' | 'saveMe'>;

function meApi(): MeApi | null {
  const api = getRadar();
  return api && typeof api.getMe === 'function' && typeof api.saveMe === 'function' ? api : null;
}

export interface MeHook {
  supported: boolean;
  /** 아직 읽지 못했으면 null */
  info: MeInfo | null;
  error: string | null;
  /** 저장. 성공하면 true(실패는 error) */
  save: (settings: MeSettings) => Promise<boolean>;
}

/** vocKey: VOC 보드의 내 이름(바뀌면 다시 읽는다 — 이름이 비었을 때의 기본값) */
export function useMe(vocKey: string | undefined): MeHook {
  const [info, setInfo] = useState<MeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = meApi() !== null;
  const seq = useRef(0);

  const accept = useCallback((id: number, raw: unknown): boolean => {
    if (id !== seq.current) return false;
    const next = normalizeMe(raw);
    if (!next) {
      setError('설정 › 나 응답 형식이 맞지 않습니다');
      return false;
    }
    setInfo(next);
    setError(null);
    return true;
  }, []);

  useEffect(() => {
    const api = meApi();
    if (!api) return;
    const id = ++seq.current;
    api.getMe().then(
      (raw) => accept(id, raw),
      (err: unknown) => {
        if (id === seq.current) setError(errorText(err));
      },
    );
  }, [accept, vocKey]);

  const save = useCallback(
    async (settings: MeSettings): Promise<boolean> => {
      const api = meApi();
      if (!api) return false;
      const id = ++seq.current;
      try {
        return accept(id, await api.saveMe(settings));
      } catch (err) {
        if (id === seq.current) setError(errorText(err));
        return false;
      }
    },
    [accept],
  );

  return { supported, info, error, save };
}
