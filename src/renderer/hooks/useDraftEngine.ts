// 회신 초안 엔진(2.13단계 명세 §E): 설정 › AI 의 회신 초안 엔진(claude / local)과 로컬 LLM 이 준비됐는지.
// 처음 한 번 읽고, main 이 「설정 바뀜」을 보낼 때마다 다시 읽는다. 옛 main(설정 칸 없음)이면 claude.
import { useEffect, useState } from 'react';
import { normalizeSectionView } from '../lib/settings';
import { settingsApi } from './useSettingsSection';

export interface DraftEngineInfo {
  engine: 'claude' | 'local';
  /** 로컬 LLM 을 쓸 수 있는가(주소·모델이 있고 [연결 시험]에 성공한 호스트) */
  localReady: boolean;
  /** 주소·모델은 있는데 못 쓰는 이유(main 의 문장 — 연결 시험 전 등) */
  localProblem?: string;
}

/** 로컬 LLM 이 설정되지 않았는데 엔진이 local 일 때의 문장(Claude 로 몰래 넘어가지 않는다) */
export const LOCAL_LLM_MISSING = '설정 › AI 에서 로컬 LLM 을 넣으세요';

export function useDraftEngine(): DraftEngineInfo {
  const [info, setInfo] = useState<DraftEngineInfo>({ engine: 'claude', localReady: false });
  useEffect(() => {
    const api = settingsApi();
    if (!api) return;
    let alive = true;
    const load = (): void => {
      api.getSettings('ai').then(
        (raw) => {
          const v = normalizeSectionView(raw, 'ai');
          if (!alive || !v) return;
          setInfo({
            engine: v.fields.draftEngine?.value === 'local' ? 'local' : 'claude',
            localReady: !!v.fields.llmUrl?.value && !!v.fields.model?.value && !v.llmProblem,
            ...(v.llmProblem ? { localProblem: v.llmProblem } : {}),
          });
        },
        () => undefined,
      );
    };
    load();
    const off = typeof api.onSettingsChanged === 'function' ? api.onSettingsChanged(load) : undefined;
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, []);
  return info;
}

/** 초안을 만들 수 없는 이유(없으면 null): local 이면 로컬 LLM 준비 여부, claude 면 Claude Code 가 없는 이유 */
export function draftUnavailableOf(info: DraftEngineInfo, claudeMissing: string | null): string | null {
  if (info.engine === 'local') return info.localReady ? null : (info.localProblem ?? LOCAL_LLM_MISSING);
  return claudeMissing;
}
