// window.radar 접근. preload 가 없으면(브라우저로 그냥 열었을 때 등) null 이다.
import type { RadarAPI } from '../shared/types';

export function getRadar(): RadarAPI | null {
  const api = (window as { radar?: RadarAPI }).radar;
  return api && typeof api === 'object' ? api : null;
}

export const NO_BRIDGE_MESSAGE = '앱 연결(window.radar)을 찾지 못했습니다. wiki-radar 창 안에서 열어 주세요.';

/**
 * 풀스크린을 열 때 할 일 대신 "반영 대기" 화면을 보이라는 표시. setMode('full', FOCUS_QUEUE_VIEW) 로 보낸다.
 * main 은 focusTaskId 를 글자 그대로(길이만 검사해) 풀스크린에 넘기고, 할 일 ID 는 'i:'·'c:' 로 시작하므로 겹치지 않는다.
 */
export const FOCUS_QUEUE_VIEW = 'view:queue';
