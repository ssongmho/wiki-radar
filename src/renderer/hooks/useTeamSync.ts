// 팀 위키 동기화(2.8단계) 훅: 처음 한 번 읽고 main 이 보내는 상태를 구독한다.
// 앱 연결에 동기화 함수가 없으면 supported:false — 화면은 그 칸을 그리지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarAPI, TeamSyncInput, TeamSyncStatus } from '../../shared/types';
import { getRadar } from '../api';
import { errorText } from '../lib/snapshot';
import { normalizeTeamSync } from '../lib/teamSync';

type TeamSyncApi = Pick<RadarAPI, 'getTeamSync' | 'setTeamSync' | 'runTeamSync' | 'openTeamWiki' | 'onTeamSync'>;

function teamSyncApi(): TeamSyncApi | null {
  const api = getRadar();
  return api && typeof api.getTeamSync === 'function' && typeof api.onTeamSync === 'function' ? api : null;
}

export interface TeamSyncHook {
  supported: boolean;
  status: TeamSyncStatus | null;
  error: string | null;
  /** 켜기·끄기·경로. 성공하면 true */
  save: (input: TeamSyncInput) => Promise<boolean>;
  /** 지금 동기화(끝날 때까지). confirmLarge 는 확인 뒤에만 */
  run: (confirmLarge?: boolean) => Promise<void>;
  open: (how: 'obsidian' | 'folder') => Promise<void>;
}

export function useTeamSync(): TeamSyncHook {
  const [status, setStatus] = useState<TeamSyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = teamSyncApi() !== null;
  const seq = useRef(0);

  const accept = useCallback((raw: unknown) => {
    const next = normalizeTeamSync(raw);
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    const api = teamSyncApi();
    if (!api) return;
    const id = ++seq.current;
    api.getTeamSync().then(
      (raw) => {
        if (id === seq.current) accept(raw);
      },
      (err: unknown) => setError(errorText(err)),
    );
    return api.onTeamSync((raw) => accept(raw));
  }, [accept]);

  const save = useCallback(
    async (input: TeamSyncInput): Promise<boolean> => {
      const api = teamSyncApi();
      if (!api) return false;
      try {
        accept(await api.setTeamSync(input));
        setError(null);
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      }
    },
    [accept],
  );

  const run = useCallback(
    async (confirmLarge = false): Promise<void> => {
      const api = teamSyncApi();
      if (!api) return;
      try {
        accept(await api.runTeamSync(confirmLarge));
        setError(null);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [accept],
  );

  const open = useCallback(async (how: 'obsidian' | 'folder'): Promise<void> => {
    const api = teamSyncApi();
    if (!api) return;
    try {
      await api.openTeamWiki(how);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  return { supported, status, error, save, run, open };
}
