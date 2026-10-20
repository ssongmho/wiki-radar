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

/**
 * 풀스크린을 열 때 할 일 대신 "설정"의 점검 칸을 보이라는 표시(focusTask 로 보낸다). 처음 실행에 main 이,
 * 사이드바의 [설정]·팀위키 상태 칸이 보낸다. 명세 2.7단계(2.9단계에서 「환경 점검」 → 「설정 › 점검」)
 */
export const FOCUS_SETUP_VIEW = 'view:setup';

/** 풀스크린 "설정"의 나 칸·알림 칸을 열라는 표시(2.9단계 명세 §2) */
export const FOCUS_SETTINGS_ME = 'view:settings:me';
export const FOCUS_SETTINGS_NOTIFY = 'view:settings:notify';

/** 설정 칸을 여는 표시의 머리(2.13단계 §C-0) — 'view:settings:<칸>'. 위의 두 상수도 같은 꼴이다 */
export const FOCUS_SETTINGS_PREFIX = 'view:settings:';
/** 설정 화면의 칸(순서 = 화면 순서, DESIGN §12) */
/** 설정 › 위키에서 「없음」으로 바꿔 다시 시작을 기다릴 때 restartPending 값(폴더 경로가 아님 — 2.13단계 §C-1) */
export const WIKI_PENDING_NONE = '(없음)';

export const SETTINGS_TABS = ['check', 'me', 'wiki', 'mailIn', 'mailOut', 'ai', 'voc', 'notify', 'info'] as const;
export type SettingsTabKey = (typeof SETTINGS_TABS)[number];

/** 'view:settings:<칸>' → 칸. 모양이 틀리거나 모르는 칸이면 null */
export function parseSettingsFocus(id: string): SettingsTabKey | null {
  if (typeof id !== 'string' || !id.startsWith(FOCUS_SETTINGS_PREFIX)) return null;
  const key = id.slice(FOCUS_SETTINGS_PREFIX.length);
  return (SETTINGS_TABS as readonly string[]).includes(key) ? (key as SettingsTabKey) : null;
}

/** 풀스크린 할 일 화면의 「팀 전체」 탭을 열라는 표시(2.9단계 명세 §4-1). 할 일 id('i:'·'c:'·'v:'·'t:')와 겹치지 않는다 */
export const FOCUS_TEAM_VIEW = 'view:team';
/** 풀스크린 할 일 화면(내 할 일 탭)을 열라는 표시(2.9단계 명세 §7-3) */
export const FOCUS_TASKS_VIEW = 'view:tasks';

/** 풀스크린을 열고 알림함을 펼치라는 표시(2.9단계 명세 §7-3 — 여러 건 묶음 알림·사이드바 긴급 띠) */
export const FOCUS_INBOX_VIEW = 'view:inbox';

/**
 * 풀스크린 「메일」 화면을 열라는 표시(2.10단계 §8-1). `view:mail:<MailKey>` 는 그 메일의 스레드를 고른다(mailFocusId)
 */
export const FOCUS_MAIL_VIEW = 'view:mail';

/** 그 메일의 스레드를 메일함에서 열라는 표시 'view:mail:<MailKey>' */
export function mailFocusId(key: string): string {
  return `${FOCUS_MAIL_VIEW}:${key}`;
}

/** 풀스크린 「검색」·「변경」 화면을 열라는 표시(3a단계 §8-1) */
export const FOCUS_SEARCH_VIEW = 'view:search';
export const FOCUS_CHANGES_VIEW = 'view:changes';
/** 문서 하나를 미리보기로 여는 표시의 머리 — 'view:doc:<p|t>:<encodeURIComponent(경로)>' */
export const FOCUS_DOC_PREFIX = 'view:doc:';

/** 문서 하나를 여는 표시(사이드바·나중 알림용) */
export function docFocusId(source: 'personal' | 'team', path: string): string {
  return `${FOCUS_DOC_PREFIX}${source === 'team' ? 't' : 'p'}:${encodeURIComponent(path)}`;
}

/** docFocusId 를 되돌린다. 모양이 틀리면 null */
export function parseDocFocusId(id: string): { source: 'personal' | 'team'; path: string } | null {
  const m = /^view:doc:([pt]):(.+)$/.exec(id);
  if (!m) return null;
  try {
    return { source: m[1] === 't' ? 'team' : 'personal', path: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/** 개인 위키의 처리 결과 저장에 팀 할 일이 오면(2.9단계 §5) */
export const TEAM_TASK_SAVE_REFUSED = '팀 위키 할 일은 팀 할 일 저장으로 저장합니다';

export const IPC = {
  getSnapshot: 'radar:getSnapshot',
  snapshot: 'radar:snapshot', // main → renderer 이벤트
  snapshotGone: 'radar:snapshotGone', // main → renderer 이벤트(2.9단계 §3 — 개인 위키 없음 + 팀 끔으로 할 일 목록이 없어짐)
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
  // 2.5단계
  getReplyContext: 'radar:getReplyContext',
  draftReply: 'radar:draftReply',
  cancelDraftReply: 'radar:cancelDraftReply',
  sendReply: 'radar:sendReply',
  getMailSettings: 'radar:getMailSettings',
  saveMailSettings: 'radar:saveMailSettings',
  // 2.6단계
  getVocBoard: 'radar:getVocBoard',
  vocBoard: 'radar:vocBoard', // main → renderer 이벤트
  refreshVoc: 'radar:refreshVoc',
  getVocTicket: 'radar:getVocTicket',
  getVocDirectory: 'radar:getVocDirectory',
  getVocSettings: 'radar:getVocSettings',
  saveVocSettings: 'radar:saveVocSettings',
  vocAction: 'radar:vocAction',
  checkVocText: 'radar:checkVocText',
  getVocCreateContext: 'radar:getVocCreateContext',
  createVocTicket: 'radar:createVocTicket',
  openVocWeb: 'radar:openVocWeb',
  vocLogin: 'radar:vocLogin',
  // 2.6단계 V4(명세 §14)
  getVocWorkLogs: 'radar:getVocWorkLogs',
  getVocEmailLogs: 'radar:getVocEmailLogs',
  vocWork: 'radar:vocWork',
  vocFile: 'radar:vocFile',
  openVocFile: 'radar:openVocFile',
  // 2.7단계(처음 실행 점검)
  getSetup: 'radar:getSetup',
  chooseWikiFolder: 'radar:chooseWikiFolder',
  markSetupSeen: 'radar:markSetupSeen',
  restartApp: 'radar:restartApp',
  // 2.8단계(팀 위키 동기화)
  getTeamSync: 'radar:getTeamSync',
  setTeamSync: 'radar:setTeamSync',
  runTeamSync: 'radar:runTeamSync',
  openTeamWiki: 'radar:openTeamWiki',
  teamSync: 'radar:teamSync', // main → renderer 이벤트
  // 2.9단계(설정 › 나)
  getMe: 'radar:getMe',
  saveMe: 'radar:saveMe',
  // 2.9단계(팀 위키 할 일)
  getTeamTasks: 'radar:getTeamTasks',
  teamTasks: 'radar:teamTasks', // main → renderer 이벤트
  saveTeamTask: 'radar:saveTeamTask',
  openTeamDoc: 'radar:openTeamDoc',
  // 2.9단계(알림 N1)
  getNotifySettings: 'radar:getNotifySettings',
  saveNotifySettings: 'radar:saveNotifySettings',
  muteNotifyKind: 'radar:muteNotifyKind',
  getInbox: 'radar:getInbox',
  inbox: 'radar:inbox', // main → renderer 이벤트
  markInboxRead: 'radar:markInboxRead',
  openInboxItem: 'radar:openInboxItem',
  // 2.12단계(알림 N2)
  snoozeInboxItems: 'radar:snoozeInboxItems',
  getShellSettings: 'radar:getShellSettings',
  saveShellSettings: 'radar:saveShellSettings',
  // 2.10단계(메일함)
  getMailbox: 'radar:getMailbox',
  mailbox: 'radar:mailbox', // main → renderer 이벤트
  refreshMailbox: 'radar:refreshMailbox',
  listMailThreads: 'radar:listMailThreads',
  getMailThread: 'radar:getMailThread',
  findMailThread: 'radar:findMailThread',
  getMailMessage: 'radar:getMailMessage',
  getMailHtml: 'radar:getMailHtml', // 2.15 원본 보기
  // 2.16 로컬 LLM 메일 분석
  getMailAnalysis: 'radar:getMailAnalysis',
  analyzeMail: 'radar:analyzeMail',
  mailAnalysis: 'radar:mailAnalysis', // main → renderer 이벤트
  setMailState: 'radar:setMailState',
  revealMailAttachment: 'radar:revealMailAttachment',
  getMailReplyContext: 'radar:getMailReplyContext',
  draftMailReply: 'radar:draftMailReply',
  sendMailReply: 'radar:sendMailReply',
  getMailVocCreateContext: 'radar:getMailVocCreateContext',
  createMailVocTicket: 'radar:createMailVocTicket',
  createMailTask: 'radar:createMailTask',
  // 2.14단계(메일 → 위키 지식화)
  queueMailForWiki: 'radar:queueMailForWiki',
  getQueueUnknownCount: 'radar:getQueueUnknownCount',
  // 3a단계(위키 검색·미리보기·변경 피드)
  getWikiDocs: 'radar:getWikiDocs',
  wikiDocs: 'radar:wikiDocs', // main → renderer 이벤트
  refreshWikiDocs: 'radar:refreshWikiDocs',
  searchWiki: 'radar:searchWiki',
  recentWikiDocs: 'radar:recentWikiDocs',
  getWikiPage: 'radar:getWikiPage',
  getWikiImage: 'radar:getWikiImage',
  getWikiChanges: 'radar:getWikiChanges',
  getWikiLogRecent: 'radar:getWikiLogRecent',
  markWikiSeen: 'radar:markWikiSeen',
  undoWikiSeen: 'radar:undoWikiSeen',
  openExternalLink: 'radar:openExternalLink',
  // 2.13단계(설정 나머지 6칸)
  getSettings: 'radar:getSettings',
  saveSettings: 'radar:saveSettings',
  testSettings: 'radar:testSettings',
  importDotEnvAccount: 'radar:importDotEnvAccount',
  getTeamDefaults: 'radar:getTeamDefaults',
  pickFolder: 'radar:pickFolder',
  vocLogout: 'radar:vocLogout',
  getAppInfo: 'radar:getAppInfo',
  checkForUpdate: 'radar:checkForUpdate',
  openAppFolder: 'radar:openAppFolder',
  getDiagnostics: 'radar:getDiagnostics',
  exportSettings: 'radar:exportSettings',
  previewSettingsImport: 'radar:previewSettingsImport',
  applySettingsImport: 'radar:applySettingsImport',
  settingsChanged: 'radar:settingsChanged', // main → renderer 이벤트
  // 2.15단계(메일을 위키 밖으로)
  getMailCollect: 'radar:getMailCollect',
  collectMailNow: 'radar:collectMailNow',
  mailCollect: 'radar:mailCollect', // main → renderer 이벤트
} as const;
