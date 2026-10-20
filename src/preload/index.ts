// contextBridge 로 window.radar(RadarAPI)만 노출한다. 계약: docs/stage1-contract.md §5, docs/stage2-contract.md,
// docs/stage2.5-contract.md, docs/stage2.6-contract.md, docs/stage2.7-contract.md, docs/stage2.8-contract.md,
// docs/stage2.9-contract.md
// sandbox 프리로드라 electron 말고 Node 모듈은 import 하지 않는다(공유 상수는 번들에 들어간다).
import { contextBridge, ipcRenderer } from 'electron';
import { FEATURES } from '../shared/edition';
import { IPC, type IpcReply } from '../shared/ipc';
import type {
  CreateMailTaskInput,
  QueueMailInput,
  QueueMailResult,
  CreateMailTaskOutput,
  MailMessage,
  MailReplyDraftInput,
  MailThreadDetail,
  MailThreadPage,
  MailThreadQuery,
  MailVocCreateContext,
  MailVocCreateInput,
  MailboxSummary,
  MailCollectStatus,
  MailHtmlView,
  MailAnalysisView,
  SendMailReplyInput,
  SendMailReplyOutput,
  SetMailStateInput,
  ChooseWikiResult,
  InboxState,
  NotifyKind,
  NotifySettings,
  ShellSettings,
  SnoozeKind,
  MailSettings,
  MailSummary,
  MeInfo,
  MeSettings,
  QueueItem,
  RadarAPI,
  ReflectRun,
  ReplyContext,
  ReplyDraft,
  ReplyDraftInput,
  SaveResultInput,
  SaveResultOutput,
  SaveTeamTaskInput,
  SaveTeamTaskOutput,
  SendReplyInput,
  SendReplyOutput,
  SetupStatus,
  Snapshot,
  TeamSyncInput,
  TeamSyncStatus,
  TeamTaskBoard,
  VocActionInput,
  VocActionResult,
  VocBoard,
  VocCreateContext,
  VocCreateInput,
  VocCreateResult,
  VocDirectory,
  VocEmailLog,
  VocFileResult,
  VocLoginInput,
  VocLoginResult,
  VocSettings,
  VocTicketDetail,
  VocWorkInput,
  VocWorkLog,
  MarkWikiSeenInput,
  MarkWikiSeenOutput,
  WikiChangesPage,
  WikiDocInput,
  WikiDocRef,
  WikiDocsSummary,
  WikiImageResult,
  WikiLogEntry,
  WikiPage,
  WikiSearchPage,
  WikiSearchQuery,
  WikiSearchSource,
  WikiDocSource,
  VocWorkResult,
  WindowMode,
  AppInfo,
  ConnectionTestResult,
  SettingsImportPreview,
  SettingsPatch,
  SettingsSaveResult,
  SettingsSection,
  SettingsSectionView,
  TeamDefaultsView,
  TestableSection,
  UpdateCheckResult,
} from '../shared/types';

/**
 * main 이 (봉투 밖에서) 던진 오류는 "Error invoking remote method 'radar:…': Error: …" 모양으로 온다.
 * 화면에 그대로 보여줄 수 있게 앞머리를 뗀다.
 */
function cleanMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^[A-Za-z]*Error:\s*/, '');
}

function isReply(value: unknown): value is IpcReply<unknown> {
  return !!value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** main 의 IpcReply 봉투를 벗긴다. ok:false 는 Error 로 되살려 화면이 이전과 같은 오류를 받는다. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  let reply: unknown;
  try {
    reply = await ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    throw new Error(cleanMessage(err));
  }
  if (!isReply(reply)) throw new Error(`앱 응답 형식이 잘못되었습니다(${channel})`);
  if (!reply.ok) throw new Error(typeof reply.message === 'string' && reply.message ? reply.message : '알 수 없는 오류');
  return reply.value as T;
}

function safeCall<A>(cb: (arg: A) => void, arg: A): void {
  try {
    cb(arg);
  } catch (err) {
    console.error('[wiki-radar] 구독 콜백 오류:', err);
  }
}

function requireCallback(cb: unknown): void {
  if (typeof cb !== 'function') throw new TypeError('콜백은 함수여야 합니다');
}

/**
 * main → 화면 이벤트 채널 하나의 구독 관리. 모양이 맞지 않는 값은 버린다.
 * 돌려주는 함수가 RadarAPI 의 onXxx 다(구독 해제 함수를 돌려준다).
 */
function eventChannel<T>(channel: string, accept: (value: unknown) => boolean): (cb: (value: T) => void) => () => void {
  const listeners = new Set<(value: T) => void>();
  ipcRenderer.on(channel, (_event, value: unknown) => {
    if (!accept(value)) return;
    for (const cb of [...listeners]) safeCall(cb, value as T);
  });
  return (cb) => {
    requireCallback(cb);
    const listener = (value: T) => cb(value);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
}

const isObject = (value: unknown): boolean => !!value && typeof value === 'object' && !Array.isArray(value);

const onSnapshot = eventChannel<Snapshot>(IPC.snapshot, isObject);
const onSnapshotGone = eventChannel<string>(IPC.snapshotGone, (v) => typeof v === 'string' && v.length <= 2000);
const onQueue = eventChannel<QueueItem[]>(IPC.queue, Array.isArray);
const onReflect = eventChannel<ReflectRun>(IPC.reflect, isObject);
const onVocBoard = eventChannel<VocBoard>(IPC.vocBoard, isObject);
const onTeamSync = eventChannel<TeamSyncStatus>(IPC.teamSync, isObject);
const onTeamTasks = eventChannel<TeamTaskBoard>(IPC.teamTasks, isObject);
const onInbox = eventChannel<InboxState>(IPC.inbox, isObject);
const onMailbox = eventChannel<MailboxSummary>(IPC.mailbox, isObject);
const onWikiDocs = eventChannel<WikiDocsSummary>(IPC.wikiDocs, isObject);
const onMailCollect = eventChannel<MailCollectStatus>(IPC.mailCollect, isObject);
const onMailAnalysis = eventChannel<{ key: string }>(IPC.mailAnalysis, (v) => isObject(v) && typeof (v as { key?: unknown }).key === 'string');
const onSettingsChanged = eventChannel<{ section: string }>(
  IPC.settingsChanged,
  (v) => isObject(v) && typeof (v as { section?: unknown }).section === 'string',
);

/**
 * 설정 patch 를 복제할 수 있는 값으로(값 검사는 main 의 requireSettingsPatch). 글·숫자·참거짓·null 만 남기고, 비밀은 key·action·value 만
 */
function pickSettingsPatch(patch: SettingsPatch): unknown {
  if (!patch || typeof patch !== 'object') return patch;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === 'secret') {
      if (v && typeof v === 'object') out.secret = pickFields(v, ['key', 'action', 'value']);
      continue;
    }
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

/** 읽음 요청에서 알려진 필드만(항목은 출처·경로만) */
function pickMarkSeen(input: MarkWikiSeenInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const r = input as Record<string, unknown>;
  if (r.all === true) return { all: true, source: r.source };
  return { items: Array.isArray(r.items) ? r.items.map((it) => pickFields(it, ['source', 'path'])) : r.items };
}

// ---- 항목 열기(focusTask) 구독 ---------------------------------------------
// 풀스크린 화면이 불러와진 직후에 온 요청은 React 가 구독하기 전일 수 있다.
// 구독자가 없을 때 온 마지막 ID 를 들고 있다가 첫 구독자에게 넘긴다.

const focusListeners = new Set<(taskId: string) => void>();
let pendingFocusTaskId: string | null = null;
ipcRenderer.on(IPC.focusTask, (_event, taskId: unknown) => {
  if (typeof taskId !== 'string' || taskId.length === 0) return;
  if (focusListeners.size === 0) {
    pendingFocusTaskId = taskId;
    return;
  }
  for (const cb of [...focusListeners]) safeCall(cb, taskId);
});

/** 들고 있던 ID 를 지금 구독자들에게 넘긴다. 구독자가 없으면 계속 들고 있는다. */
function flushPendingFocus(): void {
  if (pendingFocusTaskId === null || focusListeners.size === 0) return;
  const taskId = pendingFocusTaskId;
  pendingFocusTaskId = null;
  for (const cb of [...focusListeners]) safeCall(cb, taskId);
}

/**
 * 저장 입력에서 알려진 필드만 골라 보낸다(함수·DOM 객체 같은 복제할 수 없는 값이 섞여도 요청이 깨지지 않게).
 * 값의 검사는 main 이 한다.
 */
function pickSaveInput(input: SaveResultInput): unknown {
  // 객체가 아니면 그대로 보내 main 이 "객체가 아닙니다"로 거부하게 한다
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof SaveResultInput, unknown>>;
  return { taskId: i.taskId, status: i.status, owner: i.owner, note: i.note, reflect: i.reflect };
}

/** 목록은 얕게 복사해 보낸다(원소 검사는 main 이 한다) */
function pickList(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

/** 초안 입력에서 알려진 필드만(pickSaveInput 과 같은 이유) */
function pickDraftInput(input: ReplyDraftInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof ReplyDraftInput, unknown>>;
  return { taskId: i.taskId, note: i.note, hint: i.hint };
}

/** 회신 입력에서 알려진 필드만. 안의 저장 입력도 같은 방법으로 고른다 */
function pickSendInput(input: SendReplyInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof SendReplyInput, unknown>>;
  return {
    sendId: i.sendId,
    taskId: i.taskId,
    to: pickList(i.to),
    cc: pickList(i.cc),
    subject: i.subject,
    body: i.body,
    quoteOriginal: i.quoteOriginal,
    save: pickSaveInput(i.save as SaveResultInput),
  };
}

/** 메일 설정에서 알려진 필드만 */
function pickMailSettings(settings: MailSettings): unknown {
  if (!settings || typeof settings !== 'object') return settings;
  const s = settings as Partial<Record<keyof MailSettings, unknown>>;
  return { fromName: s.fromName, signature: s.signature, bccSelf: s.bccSelf };
}

/** 값이 undefined 인 선택 필드는 뺀다(main 의 검사가 '없음'과 '잘못된 값'을 가르게) */
function withOptional(out: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (value !== undefined) out[key] = value;
  return out;
}

/**
 * VOC 설정에서 알려진 필드만(목록은 얕게 복사). loginId 는 보내지 않는다 — 기억한 아이디는 로그인 대화상자만 바꾼다
 * (main 도 설정 대화상자의 저장에서는 지금 값을 지킨다)
 */
function pickVocSettings(settings: VocSettings): unknown {
  if (!settings || typeof settings !== 'object') return settings;
  const s = settings as Partial<Record<keyof VocSettings, unknown>>;
  const out: Record<string, unknown> = {
    memberIds: pickList(s.memberIds),
    systems: pickList(s.systems),
    showAllUnassigned: s.showAllUnassigned,
    pollMinutes: s.pollMinutes,
  };
  withOptional(out, 'myId', s.myId);
  withOptional(out, 'apiUrl', s.apiUrl);
  return withOptional(out, 'jarPath', s.jarPath);
}

/**
 * VOC 처리 입력에서 알려진 필드만. expected(확인 대화상자가 보인 지금 값 — main 이 쓰기 직전 다시 읽은 값과 비교한다)는
 * 알려진 키만 얕게 골라 보낸다(값 검사는 main 의 parseVocExpected)
 */
function pickVocAction(input: VocActionInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof VocActionInput, unknown>>;
  const out: Record<string, unknown> = { actionId: i.actionId, kind: i.kind, ticketId: i.ticketId, value: i.value };
  const e = i.expected;
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    const x = e as Record<string, unknown>;
    const expected: Record<string, unknown> = {};
    for (const key of ['status', 'assigneeId', 'priority', 'ictDue']) withOptional(expected, key, x[key]);
    out.expected = expected;
  } else {
    withOptional(out, 'expected', e);
  }
  return out;
}

/** VOC 로그인 입력에서 알려진 필드만(비밀번호는 main 으로 한 번 넘기고 여기서는 들고 있지 않는다) */
function pickVocLogin(input: VocLoginInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof VocLoginInput, unknown>>;
  return { loginId: i.loginId, password: i.password, remember: i.remember };
}

/** VOC 등록 입력에서 알려진 필드만 */
function pickVocCreate(input: VocCreateInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof VocCreateInput, unknown>>;
  const out: Record<string, unknown> = {
    createId: i.createId,
    taskId: i.taskId,
    title: i.title,
    description: i.description,
    customerId: i.customerId,
    system: i.system,
    requestType: i.requestType,
    priority: i.priority,
  };
  return withOptional(out, 'assigneeId', i.assigneeId);
}

/** 객체에서 이 키들만 얕게(값 검사는 main) */
function pickFields(input: unknown, keys: readonly string[]): unknown {
  if (!input || typeof input !== 'object') return input;
  const r = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) withOptional(out, key, r[key]);
  return out;
}

/** 알림 설정에서 알려진 필드만(종류 표는 얕게 복사) */
function pickNotify(input: NotifySettings): unknown {
  if (!input || typeof input !== 'object') return input;
  const out = pickFields(input, ['morningTime', 'workStart', 'workEnd', 'hideContent', 'quietStart', 'quietEnd', 'quietHold', 'sound']) as Record<
    string,
    unknown
  >;
  const kinds = (input as { kinds?: unknown }).kinds;
  out.kinds = kinds && typeof kinds === 'object' ? pickFields(kinds, ['due', 'vocSla', 'vocAssign', 'morning']) : kinds;
  return out;
}

/** 미루기 입력에서 알려진 필드만(id 목록은 얕게 복사) */
function pickSnooze(input: { ids: string[]; until: SnoozeKind }): unknown {
  if (!input || typeof input !== 'object') return input;
  const out = pickFields(input, ['until']) as Record<string, unknown>;
  out.ids = Array.isArray(input.ids) ? [...input.ids] : input.ids;
  return out;
}

/** 나 설정에서 알려진 필드만(다른 표기 목록은 얕게 복사) */
function pickMe(input: MeSettings): unknown {
  if (!input || typeof input !== 'object') return input;
  const out = pickFields(input, ['name']) as Record<string, unknown>;
  const aliases = (input as { aliases?: unknown }).aliases;
  out.aliases = Array.isArray(aliases) ? [...aliases] : aliases;
  return out;
}

/** 팀 할 일 저장 입력에서 알려진 필드만(담당 목록은 얕게 복사 — 값 검사는 main 의 requireSaveTeamTaskInput) */
function pickTeamSave(input: SaveTeamTaskInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const out = pickFields(input, ['taskId', 'rawLine', 'status', 'due']) as Record<string, unknown>;
  const owners = (input as { owners?: unknown }).owners;
  if (owners !== undefined) out.owners = Array.isArray(owners) ? [...owners] : owners;
  return out;
}

/** V4 쓰기 입력에서 알려진 필드만(worklog·email 은 알려진 키만, 목록은 얕게 복사 — 값 검사는 main 의 requireVocWorkInput) */
function pickVocWork(input: VocWorkInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof VocWorkInput, unknown>>;
  const out = pickFields(i, ['actionId', 'kind', 'ticketId', 'expectedStatus', 'workLogId']) as Record<string, unknown>;
  if (i.worklog !== undefined) out.worklog = pickFields(i.worklog, ['hours', 'date', 'note']);
  if (i.email && typeof i.email === 'object') {
    const e = i.email as Record<string, unknown>;
    out.email = { to: pickList(e.to), cc: pickList(e.cc), replyIds: pickList(e.replyIds) };
  } else if (i.email !== undefined) {
    out.email = i.email;
  }
  return out;
}

/** 메일 상태 바꾸기 입력에서 알려진 필드만(키 목록은 얕게 복사, change 는 알려진 키만 — 값 검사는 main 의 requireSetMailStateInput) */
function pickMailState(input: SetMailStateInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof SetMailStateInput, unknown>>;
  const c = i.change;
  return {
    keys: pickList(i.keys),
    change: c && typeof c === 'object' && !Array.isArray(c) ? pickFields(c, ['read', 'replyNeeded', 'archived']) : c,
  };
}

/** 메일함 회신 보내기 입력에서 알려진 필드만 */
function pickSendMail(input: SendMailReplyInput): unknown {
  if (!input || typeof input !== 'object') return input;
  const i = input as Partial<Record<keyof SendMailReplyInput, unknown>>;
  return {
    sendId: i.sendId,
    path: i.path,
    to: pickList(i.to),
    cc: pickList(i.cc),
    subject: i.subject,
    body: i.body,
    quoteOriginal: i.quoteOriginal,
    archiveAfter: i.archiveAfter,
  };
}

/** 메일만 VOC 등록 입력에서 알려진 필드만 */
function pickMailVocCreate(input: MailVocCreateInput): unknown {
  if (!input || typeof input !== 'object') return input;
  return pickFields(input, ['createId', 'path', 'title', 'description', 'customerId', 'system', 'requestType', 'priority', 'assigneeId']);
}

const api: RadarAPI = {
  getSnapshot: () => invoke<Snapshot>(IPC.getSnapshot),

  onSnapshot,
  onSnapshotGone,

  getMail: (relPath) => invoke<MailSummary | null>(IPC.getMail, relPath),

  openInObsidian: (relPath) => invoke<void>(IPC.openInObsidian, relPath),

  setMode: (mode, focusTaskId) =>
    focusTaskId === undefined ? invoke<void>(IPC.setMode, mode) : invoke<void>(IPC.setMode, mode, focusTaskId),

  getMode: () => invoke<WindowMode>(IPC.getMode),

  onFocusTask(cb) {
    requireCallback(cb);
    const listener = (taskId: string) => cb(taskId);
    focusListeners.add(listener);
    // 구독 함수가 돌아간 뒤에 넘긴다. React StrictMode 처럼 구독→해제→재구독이 바로 이어져도
    // 그때 남아 있는 구독자가 받는다.
    if (pendingFocusTaskId !== null) setTimeout(flushPendingFocus, 0);
    return () => {
      focusListeners.delete(listener);
    };
  },

  togglePin: () => invoke<boolean>(IPC.togglePin),

  quit: () => invoke<void>(IPC.quit),

  // ---- 2단계
  saveResult: (input) => invoke<SaveResultOutput>(IPC.saveResult, pickSaveInput(input)),

  getQueue: () => invoke<QueueItem[]>(IPC.getQueue),

  removeQueueItem: (id) => invoke<QueueItem[]>(IPC.removeQueueItem, id),

  onQueue,

  runReflect: () => invoke<ReflectRun>(IPC.runReflect),

  getReflect: () => invoke<ReflectRun | null>(IPC.getReflect),

  onReflect,

  // ---- 2.5단계
  getReplyContext: (taskId) => invoke<ReplyContext | null>(IPC.getReplyContext, taskId),

  draftReply: (input) => invoke<ReplyDraft>(IPC.draftReply, pickDraftInput(input)),

  cancelDraftReply: () => invoke<boolean>(IPC.cancelDraftReply),

  sendReply: (input) => invoke<SendReplyOutput>(IPC.sendReply, pickSendInput(input)),

  getMailSettings: () => invoke<MailSettings>(IPC.getMailSettings),

  saveMailSettings: (settings) => invoke<MailSettings>(IPC.saveMailSettings, pickMailSettings(settings)),

  // ---- 2.6단계
  getVocBoard: () => invoke<VocBoard>(IPC.getVocBoard),

  onVocBoard,

  refreshVoc: () => invoke<VocBoard>(IPC.refreshVoc),

  getVocTicket: (ticketId) => invoke<VocTicketDetail>(IPC.getVocTicket, ticketId),

  getVocDirectory: () => invoke<VocDirectory>(IPC.getVocDirectory),

  getVocSettings: () => invoke<VocSettings>(IPC.getVocSettings),

  saveVocSettings: (settings) => invoke<VocSettings>(IPC.saveVocSettings, pickVocSettings(settings)),

  vocAction: (input) => invoke<VocActionResult>(IPC.vocAction, pickVocAction(input)),

  checkVocText: (text) => invoke<string[]>(IPC.checkVocText, text),

  getVocCreateContext: (taskId) => invoke<VocCreateContext | null>(IPC.getVocCreateContext, taskId),

  createVocTicket: (input) => invoke<VocCreateResult>(IPC.createVocTicket, pickVocCreate(input)),

  openVocWeb: (ticketId) => invoke<void>(IPC.openVocWeb, ticketId),

  vocLogin: (input) => invoke<VocLoginResult>(IPC.vocLogin, pickVocLogin(input)),

  // ---- 2.6단계 V4(명세 §14)
  getVocWorkLogs: (ticketId) => invoke<VocWorkLog[]>(IPC.getVocWorkLogs, ticketId),

  getVocEmailLogs: (ticketId) => invoke<VocEmailLog[]>(IPC.getVocEmailLogs, ticketId),

  vocWork: (input) => invoke<VocWorkResult>(IPC.vocWork, pickVocWork(input)),

  vocFile: (input) => invoke<VocFileResult>(IPC.vocFile, pickFields(input, ['ticketId', 'fileId', 'mode'])),

  openVocFile: (input) => invoke<void>(IPC.openVocFile, pickFields(input, ['ticketId', 'fileId', 'how'])),

  // 2.7단계(처음 실행 점검)
  getSetup: () => invoke<SetupStatus>(IPC.getSetup),
  chooseWikiFolder: () => invoke<ChooseWikiResult>(IPC.chooseWikiFolder),
  markSetupSeen: () => invoke<SetupStatus>(IPC.markSetupSeen),
  restartApp: () => invoke<void>(IPC.restartApp),

  // 2.8단계(팀 위키 동기화)
  getTeamSync: () => invoke<TeamSyncStatus>(IPC.getTeamSync),
  setTeamSync: (input: TeamSyncInput) => invoke<TeamSyncStatus>(IPC.setTeamSync, pickFields(input, ['enabled', 'remote', 'local'])),
  runTeamSync: (confirmLarge?: boolean) => invoke<TeamSyncStatus>(IPC.runTeamSync, confirmLarge === true),
  openTeamWiki: (how) => invoke<void>(IPC.openTeamWiki, how),
  onTeamSync,

  // 2.9단계(설정 › 나) — 값 검사는 main 의 checkMeSettings
  getMe: () => invoke<MeInfo>(IPC.getMe),
  saveMe: (settings: MeSettings) => invoke<MeInfo>(IPC.saveMe, pickMe(settings)),

  // 2.9단계(팀 위키 할 일)
  getTeamTasks: () => invoke<TeamTaskBoard>(IPC.getTeamTasks),
  onTeamTasks,
  saveTeamTask: (input: SaveTeamTaskInput) => invoke<SaveTeamTaskOutput>(IPC.saveTeamTask, pickTeamSave(input)),
  openTeamDoc: (relPath: string) => invoke<void>(IPC.openTeamDoc, relPath),

  // 2.9단계(알림 N1) — 값 검사는 main 의 checkNotifySettings
  getNotifySettings: () => invoke<NotifySettings>(IPC.getNotifySettings),
  saveNotifySettings: (settings: NotifySettings) => invoke<NotifySettings>(IPC.saveNotifySettings, pickNotify(settings)),
  muteNotifyKind: (kind: NotifyKind) => invoke<NotifySettings>(IPC.muteNotifyKind, kind),
  getInbox: () => invoke<InboxState>(IPC.getInbox),
  onInbox,
  markInboxRead: (ids: 'all' | string[]) => invoke<InboxState>(IPC.markInboxRead, ids === 'all' ? 'all' : Array.isArray(ids) ? [...ids] : ids),
  openInboxItem: (id: string) => invoke<void>(IPC.openInboxItem, id),
  // 2.12단계(알림 N2) — 값 검사는 main(requireSnoozeInput·checkShellSettings)
  snoozeInboxItems: (input: { ids: string[]; until: SnoozeKind }) =>
    invoke<InboxState>(IPC.snoozeInboxItems, pickSnooze(input)),
  getShellSettings: () => invoke<ShellSettings>(IPC.getShellSettings),
  saveShellSettings: (settings: ShellSettings) => invoke<ShellSettings>(IPC.saveShellSettings, pickFields(settings, ['closeAction'])),

  // 2.10단계(메일함)
  getMailbox: () => invoke<MailboxSummary>(IPC.getMailbox),
  // 2.15단계(메일을 위키 밖으로)
  getMailCollect: () => invoke<MailCollectStatus>(IPC.getMailCollect),
  collectMailNow: () => invoke<MailCollectStatus>(IPC.collectMailNow),
  onMailCollect,
  onMailbox,
  refreshMailbox: () => invoke<MailboxSummary>(IPC.refreshMailbox),
  listMailThreads: (query: MailThreadQuery) =>
    invoke<MailThreadPage>(IPC.listMailThreads, pickFields(query, ['filter', 'folder', 'query', 'includeMuted', 'keep', 'offset', 'limit'])),
  getMailThread: (threadId: string) => invoke<MailThreadDetail | null>(IPC.getMailThread, threadId),
  findMailThread: (key: string) => invoke<{ threadId: string } | null>(IPC.findMailThread, key),
  getMailMessage: (path: string) => invoke<MailMessage | null>(IPC.getMailMessage, path),
  getMailHtml: (input: { path: string; remote: boolean }) => invoke<MailHtmlView | null>(IPC.getMailHtml, pickFields(input, ['path', 'remote'])),
  getMailAnalysis: (key: string) => invoke<MailAnalysisView>(IPC.getMailAnalysis, key),
  analyzeMail: (input: { key: string; force: boolean }) => invoke<MailAnalysisView>(IPC.analyzeMail, pickFields(input, ['key', 'force'])),
  onMailAnalysis,
  setMailState: (input: SetMailStateInput) => invoke<MailboxSummary>(IPC.setMailState, pickMailState(input)),
  revealMailAttachment: (input: { path: string; index: number }) => invoke<void>(IPC.revealMailAttachment, pickFields(input, ['path', 'index'])),
  getMailReplyContext: (path: string) => invoke<ReplyContext | null>(IPC.getMailReplyContext, path),
  draftMailReply: (input: MailReplyDraftInput) => invoke<ReplyDraft>(IPC.draftMailReply, pickFields(input, ['path', 'note', 'hint'])),
  sendMailReply: (input: SendMailReplyInput) => invoke<SendMailReplyOutput>(IPC.sendMailReply, pickSendMail(input)),
  getMailVocCreateContext: (path: string) => invoke<MailVocCreateContext | null>(IPC.getMailVocCreateContext, path),
  createMailVocTicket: (input: MailVocCreateInput) => invoke<VocCreateResult>(IPC.createMailVocTicket, pickMailVocCreate(input)),
  createMailTask: (input: CreateMailTaskInput) =>
    invoke<CreateMailTaskOutput>(IPC.createMailTask, pickFields(input, ['path', 'title', 'pri', 'due'])),
  // 2.14단계 — 경로는 보내지 않는다(main 이 키로 찾는다)
  queueMailForWiki: (input: QueueMailInput) =>
    invoke<QueueMailResult>(IPC.queueMailForWiki, pickFields(input, ['key', 'scope', 'note', 'hint', 'replace'])),
  getQueueUnknownCount: () => invoke<number>(IPC.getQueueUnknownCount),

  // 3a단계(위키 검색·미리보기·변경 피드) — 값 검사는 main 의 docInput
  getWikiDocs: () => invoke<WikiDocsSummary>(IPC.getWikiDocs),
  onWikiDocs,
  refreshWikiDocs: () => invoke<WikiDocsSummary>(IPC.refreshWikiDocs),
  searchWiki: (query: WikiSearchQuery) => invoke<WikiSearchPage>(IPC.searchWiki, pickFields(query, ['query', 'source', 'limit', 'offset'])),
  recentWikiDocs: (input: { source: WikiSearchSource; limit: number }) => invoke<WikiDocRef[]>(IPC.recentWikiDocs, pickFields(input, ['source', 'limit'])),
  getWikiPage: (input: WikiDocInput) => invoke<WikiPage | null>(IPC.getWikiPage, pickFields(input, ['source', 'path'])),
  getWikiImage: (input: { source: WikiDocSource; page: string; ref: string }) =>
    invoke<WikiImageResult>(IPC.getWikiImage, pickFields(input, ['source', 'page', 'ref'])),
  getWikiChanges: (input: { source: WikiDocSource; offset: number; limit: number }) =>
    invoke<WikiChangesPage>(IPC.getWikiChanges, pickFields(input, ['source', 'offset', 'limit'])),
  getWikiLogRecent: () => invoke<WikiLogEntry[]>(IPC.getWikiLogRecent),
  markWikiSeen: (input: MarkWikiSeenInput) => invoke<MarkWikiSeenOutput>(IPC.markWikiSeen, pickMarkSeen(input)),
  undoWikiSeen: (token: string) => invoke<WikiDocsSummary>(IPC.undoWikiSeen, token),
  openExternalLink: (url: string) => invoke<void>(IPC.openExternalLink, url),

  // 2.13단계(설정 나머지 6칸) — 값 검사는 main(requireSettingsPatch 등)
  getSettings: (section: SettingsSection) => invoke<SettingsSectionView>(IPC.getSettings, section),
  saveSettings: (section: SettingsSection, patch: SettingsPatch) => invoke<SettingsSaveResult>(IPC.saveSettings, section, pickSettingsPatch(patch)),
  testSettings: (section: TestableSection, draft: SettingsPatch) => invoke<ConnectionTestResult>(IPC.testSettings, section, pickSettingsPatch(draft)),
  importDotEnvAccount: () => invoke<SettingsSectionView>(IPC.importDotEnvAccount),
  getTeamDefaults: (opts?: { refresh?: boolean }) => invoke<TeamDefaultsView>(IPC.getTeamDefaults, { refresh: opts?.refresh === true }),
  pickFolder: (purpose: 'personalWiki' | 'teamLocal') => invoke<string | null>(IPC.pickFolder, purpose),
  vocLogout: () => invoke<void>(IPC.vocLogout),
  getAppInfo: () => invoke<AppInfo>(IPC.getAppInfo),
  checkForUpdate: () => invoke<UpdateCheckResult>(IPC.checkForUpdate),
  openAppFolder: (which: 'data' | 'logs') => invoke<void>(IPC.openAppFolder, which),
  getDiagnostics: () => invoke<string>(IPC.getDiagnostics),
  exportSettings: () => invoke<{ saved: boolean; path?: string }>(IPC.exportSettings),
  previewSettingsImport: () => invoke<SettingsImportPreview | null>(IPC.previewSettingsImport),
  applySettingsImport: (token: string, sections: string[]) =>
    invoke<{ applied: string[] }>(IPC.applySettingsImport, token, Array.isArray(sections) ? [...sections] : sections),
  onSettingsChanged,
};

/**
 * 공개판(src/shared/edition.ts)에서 가린 기능의 함수. 내보내지 않으면 화면의 「앱 연결에 이 기능이 있는가」 검사가 그 화면을 숨긴다.
 * 「나」(담당 이름)는 팀 할 일·VOC 에만 쓴다.
 */
const HIDDEN_API: ReadonlyArray<readonly [boolean, readonly (keyof RadarAPI)[]]> = [
  [
    FEATURES.voc,
    [
      'getVocBoard', 'onVocBoard', 'refreshVoc', 'getVocTicket', 'getVocDirectory', 'getVocSettings', 'saveVocSettings', 'vocAction',
      'checkVocText', 'getVocCreateContext', 'createVocTicket', 'openVocWeb', 'vocLogin', 'getVocWorkLogs', 'getVocEmailLogs', 'vocWork',
      'vocFile', 'openVocFile', 'getMailVocCreateContext', 'createMailVocTicket', 'vocLogout',
    ],
  ],
  [FEATURES.teamWiki, ['getTeamSync', 'setTeamSync', 'runTeamSync', 'openTeamWiki', 'onTeamSync', 'getTeamTasks', 'onTeamTasks', 'saveTeamTask', 'openTeamDoc', 'getTeamDefaults']],
  [FEATURES.voc || FEATURES.teamWiki, ['getMe', 'saveMe']],
  [FEATURES.localLlm, ['getMailAnalysis', 'analyzeMail', 'onMailAnalysis']],
];

const exposed: Record<string, unknown> = { ...api };
for (const [on, keys] of HIDDEN_API) if (!on) for (const k of keys) delete exposed[k];

contextBridge.exposeInMainWorld('radar', exposed);
