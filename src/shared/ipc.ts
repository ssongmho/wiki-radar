// IPC 채널 이름과 응답 봉투. main(ipc.ts)과 preload 가 같은 상수·타입을 쓴다(오류 문장 머리는 renderer 도 쓴다).

/**
 * invoke 채널의 응답. main 은 실패를 예외로 던지지 않고 ok:false 로 돌려준다 —
 * ipcMain.handle 이 거부된 약속마다 "Error occurred in handler" 스택을 main 로그에 찍는 것을 피하고,
 * preload 가 message 를 Error 로 되살려 화면에는 같은 오류로 보인다.
 */
export type IpcReply<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 처리 결과 저장이 파일 일부만 쓰고 실패했을 때 오류 문장의 머리. main 이 붙이고, 화면은 이것으로
 * '저장하지 못함'(아무것도 쓰지 않음)과 '일부만 저장함'(다시 저장하면 나머지가 반영됨)을 가른다.
 */
export const PARTIAL_SAVE_PREFIX = '위키에 일부만 저장했습니다';

export const IPC = {
  getSnapshot: 'radar:getSnapshot',
  snapshot: 'radar:snapshot', // main → renderer 이벤트
  getMail: 'radar:getMail',
  openInObsidian: 'radar:openInObsidian',
  setMode: 'radar:setMode',
  getMode: 'radar:getMode',
  focusTask: 'radar:focusTask', // main → renderer 이벤트
  togglePin: 'radar:togglePin',
  quit: 'radar:quit',
  // 2단계
  saveResult: 'radar:saveResult',
  getQueue: 'radar:getQueue',
  removeQueueItem: 'radar:removeQueueItem',
  queue: 'radar:queue', // main → renderer 이벤트
  runReflect: 'radar:runReflect',
  getReflect: 'radar:getReflect',
  reflect: 'radar:reflect', // main → renderer 이벤트
} as const;
