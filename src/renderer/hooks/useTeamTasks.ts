// 팀 위키 할 일(2.9단계 §3·§4) 훅: 처음 한 번 읽고 main 이 보내는 보드를 구독한다. 저장(팀 할 일 입력)도 여기서.
// 앱 연결에 팀 할 일 함수가 없으면 supported:false — 화면은 탭·팀 할 일 입력을 그리지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadarAPI, SaveTeamTaskInput, SaveTeamTaskOutput, TeamTaskBoard } from '../../shared/types';
import { getRadar } from '../api';
import { errorText } from '../lib/snapshot';
import { normalizeTeamBoard } from '../lib/teamTasks';

type TeamTasksApi = Pick<RadarAPI, 'getTeamTasks' | 'onTeamTasks' | 'saveTeamTask' | 'openTeamDoc'>;

function teamTasksApi(): TeamTasksApi | null {
  const api = getRadar();
  return api && typeof api.getTeamTasks === 'function' && typeof api.onTeamTasks === 'function' && typeof api.saveTeamTask === 'function'
    ? api
    : null;
}

export interface TeamTasksHook {
  supported: boolean;
  board: TeamTaskBoard | null;
  error: string | null;
  /** 저장. 실패는 던진다(화면이 알림 띠로 보인다) */
  save: (input: SaveTeamTaskInput) => Promise<SaveTeamTaskOutput>;
  /** 팀 사본 문서를 Obsidian 에서 연다. 실패는 던진다 */
  openDoc: (relPath: string) => Promise<void>;
}

export function useTeamTasks(): TeamTasksHook {
  const [board, setBoard] = useState<TeamTaskBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = teamTasksApi() !== null;
  const seq = useRef(0);

  const accept = useCallback((raw: unknown) => {
    const next = normalizeTeamBoard(raw);
    if (next) setBoard(next);
  }, []);

  useEffect(() => {
    const api = teamTasksApi();
    if (!api) return;
    const id = ++seq.current;
    api.getTeamTasks().then(
      (raw) => {
        if (id === seq.current) accept(raw);
      },
      (err: unknown) => setError(errorText(err)),
    );
    return api.onTeamTasks((raw) => {
      seq.current++;
      accept(raw);
    });
  }, [accept]);

  const save = useCallback(async (input: SaveTeamTaskInput): Promise<SaveTeamTaskOutput> => {
    const api = teamTasksApi();
    if (!api) throw new Error('이 앱 연결에는 팀 할 일 저장 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.');
    return api.saveTeamTask(input);
  }, []);

  const openDoc = useCallback(async (relPath: string): Promise<void> => {
    const api = teamTasksApi();
    if (!api || typeof api.openTeamDoc !== 'function') throw new Error('이 앱 연결에는 팀 문서 열기 기능이 없습니다.');
    await api.openTeamDoc(relPath);
  }, []);

  return { supported, board, error, save, openDoc };
}
