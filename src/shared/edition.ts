// 판(edition). 회사판은 모든 기능을, 공개판(GitHub)은 개인 위키·메일만 보인다.
// 공개판에서 VOC·팀 위키·로컬 LLM 은 코드는 그대로 두고 화면에서 가리고 main 에서 시작하지 않는다.
// scripts/export-public.mjs 가 공개판 사본에서 아래 EDITION 줄을 'public' 으로 바꾼다 — 줄 모양을 바꾸면 그 스크립트도 고친다.

export type Edition = 'company' | 'public';

export const EDITION: Edition = 'public';

export interface Features {
  /** VOC 보드·VOC 등록·VOC 설정 */
  voc: boolean;
  /** 팀 위키(동기화·팀 할 일·팀 기본값·검색/변경의 팀 위키) */
  teamWiki: boolean;
  /** 로컬 LLM(설정 › AI·회신 초안 엔진 고르기·메일 분석) */
  localLlm: boolean;
}

export function featuresOf(edition: Edition): Features {
  const company = edition === 'company';
  return { voc: company, teamWiki: company, localLlm: company };
}

export const FEATURES: Features = featuresOf(EDITION);
