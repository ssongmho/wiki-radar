// window.radar 접근. preload 가 없으면(브라우저로 그냥 열었을 때 등) null 이다.
import type { RadarAPI } from '../shared/types';

export {
  FOCUS_CHANGES_VIEW,
  FOCUS_SEARCH_VIEW,
  docFocusId,
  parseDocFocusId,
  FOCUS_INBOX_VIEW,
  FOCUS_MAIL_VIEW,
  FOCUS_SETTINGS_ME,
  FOCUS_SETTINGS_NOTIFY,
  FOCUS_SETUP_VIEW,
  FOCUS_TASKS_VIEW,
  FOCUS_TEAM_VIEW,
  mailFocusId,
} from '../shared/ipc';

export function getRadar(): RadarAPI | null {
  const api = (window as { radar?: RadarAPI }).radar;
  return api && typeof api === 'object' ? api : null;
}

export const NO_BRIDGE_MESSAGE = '앱 연결(window.radar)을 찾지 못했습니다. Radar 창 안에서 열어 주세요.';

/**
 * 풀스크린을 열 때 할 일 대신 "반영 대기" 화면을 보이라는 표시. setMode('full', FOCUS_QUEUE_VIEW) 로 보낸다.
 * main 은 focusTaskId 를 글자 그대로(길이만 검사해) 풀스크린에 넘기고, 할 일 ID 는 'i:'·'c:'·'v:' 로 시작하므로 겹치지 않는다.
 */
export const FOCUS_QUEUE_VIEW = 'view:queue';

/** 풀스크린을 열 때 "VOC" 화면을 보이라는 표시(사이드바 상태 줄의 VOC — 2.6단계 명세 §3-2) */
export const FOCUS_VOC_VIEW = 'view:voc';

/**
 * 풀스크린 "VOC" 화면을 열고 로그인 대화상자를 띄우라는 표시(2.6단계 명세 §13 — 사이드바 'VOC 로그인 필요'·할 일 상세의 [로그인]).
 * 'view:voc:' 로 시작하지 않아 티켓 고르기(vocFocusId)와 겹치지 않는다
 */
export const FOCUS_VOC_LOGIN = 'view:voc-login';

/**
 * VOC 화면에서 그 티켓을 고르라는 표시 'view:voc:<번호 또는 내부 id>'. setMode('full', vocFocusId('VOC-2026-0001')) 로 보낸다
 * (풀스크린 창 안에서 불러도 된다 — main 이 그 창에 초점 요청을 보낸다). 보드에 없는 티켓이면 화면만 연다.
 */
export function vocFocusId(ref: string | number): string {
  return `${FOCUS_VOC_VIEW}:${String(ref).trim()}`;
}
