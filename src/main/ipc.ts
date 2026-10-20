// IPC 핸들러 — renderer 요청의 유일한 입구. 계약: docs/stage1-contract.md §5, docs/stage2-contract.md §1·§2,
// docs/stage2.5-contract.md(메일 회신), docs/stage2.6-contract.md(VOC 보드). 모든 인자는 타입·길이를 검사하고,
// 우리 창이 보낸 요청만 받는다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { FOCUS_DOC_PREFIX, IPC, PARTIAL_SAVE_PREFIX, TEAM_TASK_SAVE_REFUSED, type IpcReply } from '../shared/ipc';
import type {
  CreateMailTaskOutput,
  MailMessage,
  MailThreadDetail,
  MailThreadPage,
  MailVocCreateContext,
  MailboxSummary,
  MailCollectStatus,
  MailHtmlView,
  MailAnalysisView,
  SendMailReplyOutput,
  InboxState,
  NotifyKind,
  NotifySettings,
  ShellSettings,
  SnoozeKind,
  ChooseWikiResult,
  Holiday,
  MailSettings,
  MailSummary,
  MailKey,
  QueueItem,
  QueueMailResult,
  ReflectRun,
  ReplyContext,
  ReplyDraft,
  ReplyDraftInput,
  ReplySender,
  SaveResultInput,
  SaveResultOutput,
  SaveTeamTaskInput,
  SaveTeamTaskOutput,
  SendReplyOutput,
  SentMailRecord,
  MeInfo,
  MeSettings,
  SetupStatus,
  Snapshot,
  Task,
  TeamSyncInput,
  TeamSyncStatus,
  TeamTaskBoard,
  VocActionInput,
  VocActionResult,
  VocBoard,
  VocCreateContext,
  VocCreateResult,
  VocDirectory,
  VocEmailLog,
  VocFileResult,
  VocLoginResult,
  VocSettings,
  VocTicketDetail,
  VocWorkLog,
  VocWorkResult,
  WikiChangesPage,
  WikiDocRef,
  WikiDocsSummary,
  WikiImageResult,
  WikiLogEntry,
  WikiPage,
  WikiSearchPage,
  MarkWikiSeenOutput,
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
import { WIKI_NONE_REFUSED } from './appSettings';
import { requireSettingsPatch, SETTINGS_SECTIONS, TESTABLE_SECTIONS } from './settings/service';
import type { LlmTarget } from './settings/resolve';
import { LOCAL_DRAFT_NOT_CONFIGURED, buildLocalDraftMessages, runLocalDraft } from './replyDraftLocal';
import { checkMeSettings } from './appSettings';
import { NOTIFY_ITEM_ID_RE, NOTIFY_KINDS, checkNotifySettings, checkShellSettings, mergeNotifyInput } from '../shared/notify';
import { buildSnapshot } from './wiki/snapshot';
import { emptyPersonalSnapshot, mergeExtraTasks } from './wiki/merge';
import { readMailMessage, readMailSummary } from './wiki/mail';
import { MAIL_KEY_RE } from './wiki/checkbox';
import { buildMailHtml, type FetchImage } from './mail/mailHtml';
import { TEAM_DOC_PATH_MAX, requireSaveTeamTaskInput } from './wiki/teamWriteback';
import {
  PartialWriteError,
  applyLineField,
  applyWriteback,
  hasLineField,
  lineFieldValue,
  type WritebackResult,
} from './wiki/writeback';
import { VOC_LINE_FIELD_BROKEN } from '../shared/voc';
import type { NewQueueItem, QueueStore } from './queue';
import { isReflectRunning, runReflect, stopActiveReflect, type ReflectHistory } from './reflect';
import {
  MAX_NOTE_LENGTH,
  MAX_QUEUE_ID_LENGTH,
  MAX_REL_PATH_LENGTH,
  MAX_TASK_ID_LENGTH,
  type ClaudeLocation,
} from './config';
import {
  SECRET_IN_DRAFT_PROBLEM,
  containsSecret,
  knownMailSecrets,
  loadSmtpAccount,
  testModeProblem,
  type AccountResult,
} from './mail/account';
import { composeMessage } from './mail/compose';
import { buildReplyContext, readReplySource, type ReplySource } from './mail/replyContext';
import {
  createReplySaver,
  requireSaveInput,
  requireString,
  sendMailReplyFlow,
  sendReplyFlow,
  validateSendInput,
  type SendMailReplyDeps,
  type SendReplyDeps,
} from './mail/sendReply';
import { sendRawMessage } from './mail/smtp';
import { DEFAULT_MAIL_SETTINGS, type MailSettingsStore, type SentLog } from './mail/stores';
import { buildDraftPrompt, buildMailDraftPrompt, cancelReplyDraft, runReplyDraft } from './replyDraft';
import type { MailboxService, MailWikiPending } from './mail/mailbox';
import { heldLogLine, nothingToSendMessage, queueMailForWiki, resolveMailItems, wikiPendingOf, withBlocked } from './mail/mailWiki';
import {
  requireCreateMailTaskInput,
  requireMailDraftInput,
  requireMailKey,
  requireMailPath,
  requireMailThreadId,
  requireMailThreadQuery,
  requireMailVocCreateInput,
  requireQueueMailInput,
  requireRevealInput,
  requireSendMailReplyInput,
  requireSetMailStateInput,
} from './mail/mailboxInput';
import { MEMO_FOLDER } from './wiki/mailIndex';
import { MAIL_TASK_FILE, appendTaskLine } from './wiki/mailTask';
import { isValidYmd } from './wiki/calendar';
import { isInsideDir } from './wiki/fsutil';
import type { WikiDocsService } from './wiki/docService';
import {
  requireChangesInput,
  requireExternalUrl,
  requireImageInput,
  requireMarkSeenInput,
  requireRecentInput,
  requireSearchQuery,
  requireUndoToken,
  requireWikiDocInput,
} from './wiki/docInput';
import {
  VOC_CHECK_TEXT_MAX,
  checkVocWebUrl,
  requireVocActionInput,
  requireVocCreateInput,
  requireVocFileInput,
  requireVocFileOpenInput,
  requireVocId,
  requireVocLoginInput,
  requireVocText,
  requireVocWorkInput,
} from './voc/ipcInput';
import type { VocService } from './voc/service';
import type { VocSettingsStore } from './voc/settings';

const LOG = '[wiki-radar]';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// 스냅샷 캐시

export interface SnapshotServiceOptions {
  wikiRoot: string;
  holidays: Holiday[];
  /** 지금의 '오늘'(YYYY-MM-DD, 로컬) */
  getToday: () => string;
  /** 스냅샷을 새로 만들 때마다(어느 경로로든). index.ts 가 부분 스냅샷의 재시도를 여기서 건다 */
  onBuilt?: (snapshot: Snapshot) => void;
  /**
   * 팀 위키 동기화가 켜졌는가(2.9단계 §3). 켜졌으면 개인 위키가 없어도 빈 개인 스냅샷(personalMissing)에 팀 것을 합친다.
   * 없으면 꺼진 것으로 본다
   */
  teamEnabled?: () => boolean;
  /**
   * 개인 위키 없음 + 팀 켬으로 만든 스냅샷(personalMissing)을 팀 동기화를 꺼서 버렸을 때. 인자는 오류 문장.
   * index.ts 가 창에 알려 화면이 위키 없음 안내로 돌아가게 한다
   */
  onCleared?: (message: string) => void;
}

/** 개인 스냅샷에 합칠 팀 위키 할 일(내 것만)과 읽기 경고 */
export interface TeamTasksForSnapshot {
  tasks: readonly Task[];
  warnings: readonly string[];
  partial: boolean;
}

/**
 * 마지막으로 만든 스냅샷을 들고 있다. 날짜가 바뀌었으면 다시 만든다.
 * 내 담당 VOC 할 일(2.6단계 §5)도 들고 있다가 파일 스냅샷을 새로 만들 때마다 합친다. VOC 할 일이 바뀌면
 * 파일을 다시 읽지 않고 마지막 파일 스냅샷에 다시 합친다(setVocTasks).
 */
export class SnapshotService {
  /** 방송하는 스냅샷(VOC 할 일을 합친 것) */
  private cache: Snapshot | null = null;
  private cacheDay: string | null = null;
  /** 파일에서 만든 마지막 스냅샷(VOC 할 일을 합치기 전) */
  private base: Snapshot | null = null;
  private vocTasks: Task[] = [];
  /** VOC 를 새로 받지 못할 때 경고 한 줄("VOC 할 일은 10:32 기준") */
  private vocNote: string | undefined;
  /** 마지막으로 받은 VOC 할 일·경고의 모양 — 같은 것이 다시 오면 다시 방송하지 않는다 */
  private vocKey = JSON.stringify([[], null]);
  /** 팀 위키 내 것(2.9단계 §3)과 그 경고 */
  private team: TeamTasksForSnapshot = { tasks: [], warnings: [], partial: false };
  private teamKey = JSON.stringify({ tasks: [], warnings: [], partial: false });

  constructor(private readonly opts: SnapshotServiceOptions) {}

  /**
   * 팀 위키 할 일(내 것만)을 바꾼다(팀 할 일을 다시 읽을 때마다 index.ts 가 부른다). setVocTasks 와 같은 방식 —
   * 같은 것이 다시 오면 null, 바뀌었으면 합친 새 스냅샷(방송할 것). 아직 스냅샷이 없으면(개인 위키 없음 + 팀 켬) 지금 만든다.
   */
  setTeamTasks(input: TeamTasksForSnapshot): Snapshot | null {
    const team: TeamTasksForSnapshot = {
      tasks: Array.isArray(input?.tasks) ? [...input.tasks] : [],
      warnings: Array.isArray(input?.warnings) ? [...input.warnings] : [],
      partial: input?.partial === true,
    };
    const key = JSON.stringify(team);
    if (key === this.teamKey) return null;
    this.teamKey = key;
    this.team = team;
    if (!this.base) return this.opts.teamEnabled?.() ? this.refresh() : null;
    // 개인 위키 없이 팀 것만으로 만든 스냅샷인데 팀 동기화가 꺼졌다 — 빈 목록을 합쳐 보내지 않고 다시 만든다(실패하면 버림 → onCleared)
    if (this.base.personalMissing && !this.opts.teamEnabled?.()) return this.refresh();
    if (this.cacheDay !== this.opts.getToday()) return this.refresh();
    this.cache = this.withVoc(this.base);
    return this.cache;
  }

  /**
   * VOC 할 일을 바꾼다(보드가 바뀔 때마다 index.ts 가 부른다). 바뀐 것이 있으면 합친 새 스냅샷(방송할 것),
   * 바뀐 것이 없거나 아직 파일 스냅샷이 없으면 null(다음에 만들 때 합쳐진다).
   * 날짜가 지난 캐시면 파일부터 다시 만든다(current() 와 같다).
   */
  setVocTasks(tasks: readonly Task[], note?: string): Snapshot | null {
    const list = Array.isArray(tasks) ? [...tasks] : [];
    const key = JSON.stringify([list, note ?? null]);
    if (key === this.vocKey) return null;
    this.vocKey = key;
    this.vocTasks = list;
    this.vocNote = note || undefined;
    if (!this.base) return null;
    if (this.cacheDay !== this.opts.getToday()) return this.refresh();
    this.cache = this.withVoc(this.base);
    return this.cache;
  }

  /**
   * 파일 스냅샷에 VOC 할 일·팀 위키 내 것과 그 경고를 합친다(2.6단계 §5 · 2.9단계 §3). 팀 경고는 앞에 "팀 위키: ",
   * 팀 사본을 못 읽은 파일이 있으면 partial. 합치지 못하면(날짜 오류 등) 로그를 남기고 파일 스냅샷 그대로
   */
  private withVoc(base: Snapshot): Snapshot {
    const team = this.team;
    if (this.vocTasks.length === 0 && !this.vocNote && team.tasks.length === 0 && team.warnings.length === 0 && !team.partial) {
      return base;
    }
    try {
      const merged = mergeExtraTasks(base, { voc: this.vocTasks, team: team.tasks }, { today: base.week.today, holidays: this.opts.holidays });
      if (this.vocNote) merged.warnings.push(this.vocNote);
      for (const w of team.warnings) merged.warnings.push(`팀 위키: ${w}`);
      if (team.partial) merged.partial = true;
      return merged;
    } catch (err) {
      console.error(`${LOG} VOC·팀 할 일을 목록에 합치지 못함:`, describeError(err));
      return base;
    }
  }

  /**
   * 캐시된 스냅샷. 없거나 날짜가 지난 것이면 지금 만든다.
   * 만들지 못하면 — 이전 것이 있으면 그것을 주고, 없으면 사람이 읽을 문장으로 예외를 던진다.
   */
  current(): Snapshot {
    const today = this.opts.getToday();
    if (this.cache && this.cacheDay === today) return this.cache;
    try {
      return this.build(today);
    } catch (err) {
      if (this.cache) {
        console.error(`${LOG} 스냅샷을 새로 만들지 못해 이전 것을 씀:`, describeError(err));
        return this.cache;
      }
      throw err;
    }
  }

  /** 지금 다시 만든다. 실패하면 로그만 남기고 null(이전 캐시는 그대로 둔다). */
  refresh(): Snapshot | null {
    try {
      return this.build(this.opts.getToday());
    } catch (err) {
      console.error(`${LOG} 스냅샷 재생성 실패:`, describeError(err));
      return null;
    }
  }

  private build(today: string): Snapshot {
    const { wikiRoot, holidays } = this.opts;
    let base: Snapshot;
    if (!fs.existsSync(wikiRoot)) {
      // 개인 위키가 없는 팀원: 팀 동기화가 켜져 있으면 빈 개인 스냅샷에 팀 것(과 내 VOC)만 합친다(2.9단계 §3)
      if (!this.opts.teamEnabled?.()) {
        const message = `위키 폴더를 찾을 수 없습니다: ${wikiRoot} — 설정 › 점검에서 위키 폴더를 고르세요`;
        if (this.base?.personalMissing) {
          // 팀 것만으로 만든 스냅샷은 팀을 끄면 더 쓸 수 없다 — 그대로 두면 하루 내내 빈 목록 + "팀 위키 할 일만 봅니다"가 남는다(§3)
          this.base = null;
          this.cache = null;
          this.cacheDay = null;
          try {
            this.opts.onCleared?.(message);
          } catch (err) {
            console.warn(`${LOG} onCleared 오류:`, describeError(err));
          }
        }
        throw new Error(message);
      }
      base = emptyPersonalSnapshot({ today, holidays, wikiRoot });
    } else {
      try {
        base = buildSnapshot({ wikiRoot, today, holidays });
      } catch (err) {
        throw new Error(`위키에서 할 일을 읽지 못했습니다: ${describeError(err)}`);
      }
    }
    this.base = base;
    const snapshot = this.withVoc(base);
    this.cache = snapshot;
    this.cacheDay = today;
    try {
      this.opts.onBuilt?.(snapshot);
    } catch (err) {
      console.warn(`${LOG} onBuilt 오류:`, describeError(err));
    }
    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// 방송(main → 모든 창)

function broadcast(channel: string, payload: unknown, what: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      console.warn(`${LOG} ${what}을 창에 보내지 못함:`, describeError(err));
    }
  }
}

/** 열려 있는 모든 창에 새 스냅샷을 보낸다. */
export function broadcastSnapshot(snapshot: Snapshot): void {
  broadcast(IPC.snapshot, snapshot, '스냅샷');
}

/** 보이던 스냅샷이 없어졌음을 알린다(개인 위키 없음 + 팀 끔 — 2.9단계 §3). */
export function broadcastSnapshotGone(message: string): void {
  broadcast(IPC.snapshotGone, message, '스냅샷 없어짐');
}

/** 반영 대기열이 바뀌었음을 알린다(추가·삭제·반영 완료). */
export function broadcastQueue(queue: QueueItem[]): void {
  broadcast(IPC.queue, queue, '반영 대기열');
}

/** claude 실행의 진행 상황을 알린다. */
export function broadcastReflect(run: ReflectRun): void {
  broadcast(IPC.reflect, run, '반영 진행 상황');
}

/** VOC 보드가 바뀌었음을 알린다(폴링·새로고침·쓰기 뒤 — 2.6단계 §2-3). */
export function broadcastVocBoard(board: VocBoard): void {
  broadcast(IPC.vocBoard, board, 'VOC 보드');
}

/** 팀 위키 할 일을 다시 읽었음을 알린다(2.9단계 §3). */
export function broadcastTeamTasks(board: TeamTaskBoard): void {
  broadcast(IPC.teamTasks, board, '팀 위키 할 일');
}

/** 알림함이 바뀌었음을 알린다(2.9단계 §8-3). */
export function broadcastInbox(inbox: InboxState): void {
  broadcast(IPC.inbox, inbox, '알림함');
}

/** 메일함 요약이 바뀌었음을 알린다(2.10단계 §5-2). */
export function broadcastMailbox(summary: MailboxSummary): void {
  broadcast(IPC.mailbox, summary, '메일함 요약');
}

/** 팀 위키 동기화 상태가 바뀌었음을 알린다(2.8단계). */
/** view:doc:… 표시의 최대 길이(경로 1024자를 %-인코딩해도 들어가게 — 3a단계 §8-1) */
const FOCUS_DOC_ID_MAX = 12 + 1024 * 9;

/** 위키 문서 요약(3a단계 — 내비 배지·사이드바 「변경 N」) */
export function broadcastWikiDocs(summary: WikiDocsSummary): void {
  broadcast(IPC.wikiDocs, summary, '위키 문서 요약');
}

export function broadcastTeamSync(status: TeamSyncStatus): void {
  broadcast(IPC.teamSync, status, '팀 위키 동기화 상태');
}

/** 설정이 바뀜(저장·가져오기·팀 기본값 다시 읽음 — 2.13단계 §F-1). 값은 담지 않는다 — 화면이 getSettings 로 다시 읽는다 */
/** 메일 분석 결과가 바뀜(2.16) — 화면은 그 키를 다시 읽는다 */
export function broadcastMailAnalysis(key: string): void {
  broadcast(IPC.mailAnalysis, { key }, '메일 분석');
}

/** 메일 수집 상태(2.15단계 — 설정 › 메일 받기 칸) */
export function broadcastMailCollect(status: MailCollectStatus): void {
  broadcast(IPC.mailCollect, status, '메일 수집 상태');
}

export function broadcastSettingsChanged(section: string): void {
  broadcast(IPC.settingsChanged, { section }, '설정 바뀜');
}

// ---------------------------------------------------------------------------
// 인자 검사 — 문자열·저장 입력 검사(requireString·requireSaveInput)는 보내고 저장과 같이 쓰므로
// electron 없는 mail/sendReply.ts 에 있다.

function requireMode(value: unknown): WindowMode {
  if (value === 'sidebar' || value === 'full') return value;
  throw new Error('잘못된 요청입니다: mode 는 sidebar 또는 full 이어야 합니다');
}

/** 초안 추가 요청(hint) 길이 제한 */
const MAX_DRAFT_HINT_LENGTH = 500;

/** 여러 줄 글. 줄바꿈은 \n 으로 맞추고, 줄바꿈·탭 밖의 제어 문자는 거부한다. 없으면 '' */
function optionalText(value: unknown, what: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`잘못된 요청입니다: ${what} 값이 문자열이 아닙니다`);
  if (value.length > maxLength) throw new Error(`${what}은(는) ${maxLength}자까지 쓸 수 있습니다`);
  const text = value.replace(/\r\n?/g, '\n');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new Error(`${what}에 쓸 수 없는 제어 문자가 있습니다`);
  return text;
}

function requireDraftInput(value: unknown): ReplyDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('잘못된 요청입니다: 초안 입력이 객체가 아닙니다');
  }
  const v = value as Record<string, unknown>;
  const input: ReplyDraftInput = {
    taskId: requireString(v.taskId, 'taskId', MAX_TASK_ID_LENGTH),
    note: optionalText(v.note, '처리 내용', MAX_NOTE_LENGTH),
  };
  const hint = optionalText(v.hint, '추가 요청', MAX_DRAFT_HINT_LENGTH).trim();
  if (hint) input.hint = hint;
  return input;
}

/**
 * 볼트 기준 상대경로를 위키 안의 .md 절대경로로 바꾼다. 위키 밖이거나 .md 가 아니면 null.
 * Windows 경로는 대소문자를 가리지 않으므로 비교도 대소문자를 무시한다.
 */
export function resolveWikiMarkdown(wikiRoot: string, relPath: string): string | null {
  const root = path.resolve(wikiRoot);
  const abs = path.resolve(root, relPath);
  const rootKey = root.toLowerCase().replace(/[\\/]+$/, '');
  const absKey = abs.toLowerCase();
  if (!absKey.startsWith(rootKey + path.sep)) return null;
  if (!absKey.endsWith('.md')) return null;
  return abs;
}

/**
 * 열어도 되는 문서 파일인가. 없는 파일·폴더면 거짓(Obsidian 이 빈 문서를 만들지 않게).
 * OneDrive 자리표시자처럼 stat 이 다른 이유로 실패하면 있다고 보고 Obsidian 에 맡긴다.
 */
function markdownMayExist(abs: string): boolean {
  try {
    return !fs.statSync(abs).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** raw/mail/…md 모양인가(자세한 검사는 readMailSummary 가 한다). */
function looksLikeMailPath(relPath: string): boolean {
  return /^raw\/mail\/.+\.md$/i.test(relPath.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// 직렬 실행 — 처리 결과 저장은 한 번에 하나씩(같은 파일을 두 저장이 겹쳐 쓰지 않게)

function createSerialQueue(): <T>(job: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(job);
    tail = run.catch(() => undefined);
    return run;
  };
}

// ---------------------------------------------------------------------------
// 위키 반영(claude -p) 실행 관리

export interface ReflectControllerOptions {
  wikiRoot: string;
  queue: () => QueueStore;
  history: () => ReflectHistory;
  /** 누를 때마다 다시 찾는다(앱을 켠 뒤 claude 를 설치한 경우) */
  getClaudePath: () => ClaudeLocation;
  /** 시험용 제한 시간. 없으면 reflect.ts 기본(15분) */
  timeoutMs?: number;
  /** 2.14: 메일함(kind mail 항목을 키로 찾고 반영됨을 적는다). 없으면 mail 항목은 보내지 않고 남긴다 */
  mailbox?: () => MailboxService | null | undefined;
}

/** mail 항목의 blocked 모양(id·이유) — 바뀌었을 때만 다시 방송한다 */
function blockedSignature(items: readonly QueueItem[]): string {
  return JSON.stringify(items.filter((i) => i.kind === 'mail').map((i) => [i.id, i.blocked ?? '']));
}

/** 한 번에 하나만 실행한다. 진행 상황은 모든 창에 방송하고, 끝나면 대기열·실행 기록을 고친다. */
export class ReflectController {
  private running: ReflectRun | null = null;
  /** 지금 실행에 보낸 항목·mail 항목별 메일 키(2.14 — 성공하면 반영 표시) */
  private sentItems: QueueItem[] = [];
  private sentMailKeys = new Map<string, MailKey[]>();
  /** 마지막으로 방송한 mail 항목 blocked 모양(색인이 바뀔 때 다시 방송할지) */
  private blockedSig = '';
  /** 지금 실행의 표. 끝나거나 중단되면 null — 늦게 온 진행·결과를 버리는 데 쓴다 */
  private token: symbol | null = null;
  private last: ReflectRun | null = null;

  constructor(private readonly opts: ReflectControllerOptions) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  /** 실행 중인 것, 없으면 마지막으로 끝난 것(기록 파일의 최신), 없으면 null */
  current(): ReflectRun | null {
    if (this.running) return this.running;
    if (this.last) return this.last;
    try {
      return this.opts.history().list()[0] ?? null;
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 읽지 못함:`, describeError(err));
      return null;
    }
  }

  /** 실행을 시작하고 곧바로 running 상태를 돌려준다. 이미 실행 중이면 그 실행을 돌려준다. */
  start(): ReflectRun {
    if (this.running) return this.running;
    // 앱 종료 처리로 중단한 실행이 아직 정리되는 중
    if (isReflectRunning()) throw new Error('이전 위키 반영을 정리하는 중입니다 — 잠시 뒤 다시 누르세요');

    const queue = this.opts.queue();
    const all = queue.list();
    if (all.length === 0) throw new Error('반영할 항목이 없습니다(반영 대기열이 비어 있음)');
    if (!fs.existsSync(this.opts.wikiRoot)) throw new Error(`위키 폴더를 찾을 수 없습니다: ${this.opts.wikiRoot}`);
    const claude = this.opts.getClaudePath();
    if (!claude.exists) {
      throw new Error(`claude 실행 파일을 찾을 수 없습니다: ${claude.path} (환경 변수 WIKI_RADAR_CLAUDE 로 위치를 정할 수 있습니다)`);
    }
    // 2.14 §3-1: mail 항목은 키로 메일을 다시 찾아 본문을 <mails> 블록으로. 못 찾은 것·피싱 의심·분량 초과는 이번엔 뺀다(대기열에 남김)
    const resolved = resolveMailItems(all, this.mailbox());
    const items = resolved.send;
    if (items.length === 0) throw new Error(nothingToSendMessage(resolved.held));
    const notes = resolved.held.map(heldLogLine);
    for (const note of notes) console.warn(`${LOG} 위키 반영: ${note}`);
    // 반영이 성공하면 mail-state.json 에 「반영됨」을 적을 메일 키(항목별)
    const mailKeys = new Map(resolved.mails.map((b) => [b.ref, b.mails.map((m) => m.key)]));

    const token = Symbol('reflect');
    const runId = randomUUID();
    const initial: ReflectRun = {
      id: runId,
      startedAt: new Date().toISOString(),
      state: 'running',
      itemIds: items.map((i) => i.id),
      log: [`claude 실행을 시작함 — 항목 ${items.length}건`, ...notes],
    };
    // 실행 도중 같은 할 일이 다시 저장되면(대기열 항목 교체) 새 내용은 이번 실행에 들어가지 않았으므로 남긴다.
    const startedItems = new Map(items.map((i) => [i.id, i.createdAt]));

    this.token = token;
    this.running = initial;
    this.sentItems = items;
    this.sentMailKeys = mailKeys;
    console.log(`${LOG} 위키 반영 시작: 항목 ${items.length}건 · claude ${claude.path} (${claude.source})`);
    broadcastReflect(initial);
    // 메일함 「반영 중」 표시
    this.relinkMailbox();

    let done: Promise<ReflectRun>;
    try {
      done = runReflect({
        wikiRoot: this.opts.wikiRoot,
        claudePath: claude.path,
        items,
        mails: resolved.mails,
        notes,
        runId,
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
        onProgress: (run) => this.progress(token, run),
      });
    } catch (err) {
      done = Promise.reject(err);
    }
    done
      .then(
        (final) => this.finish(token, final, startedItems),
        (err: unknown) => {
          const base = this.running ?? initial;
          this.finish(token, { ...base, state: 'failed', error: `claude 를 실행하지 못했습니다: ${describeError(err)}` }, startedItems);
        },
      )
      .catch((err: unknown) => console.error(`${LOG} 반영 실행 마무리 오류:`, describeError(err)));
    return this.running ?? initial;
  }

  private progress(token: symbol, run: ReflectRun): void {
    if (this.token !== token) return;
    if (run.state === 'running') this.running = run;
    broadcastReflect(run);
  }

  private finish(token: symbol, final: ReflectRun, startedItems: Map<string, string>): void {
    if (this.token !== token) return; // 앱 종료로 이미 중단 처리했다
    this.token = null;
    this.running = null;
    const sentItems = this.sentItems;
    const sentMailKeys = this.sentMailKeys;
    this.sentItems = [];
    this.sentMailKeys = new Map();

    const run: ReflectRun = { ...final, finishedAt: final.finishedAt ?? new Date().toISOString() };
    if (run.state === 'running') {
      run.state = 'failed';
      run.error = run.error ?? '실행이 끝났지만 결과 상태를 알 수 없습니다';
    }
    this.last = run;

    // 성공이면 이번 실행에 넣은 항목을 뺀다(도중에 바뀐 것은 남긴다). 실패면 대기열을 그대로 둔다.
    let queueChanged = false;
    if (run.state === 'done') {
      try {
        const queue = this.opts.queue();
        const current = new Map(queue.list().map((i) => [i.id, i.createdAt]));
        const ids = run.itemIds.filter((id) => startedItems.has(id) && current.get(id) === startedItems.get(id));
        if (ids.length > 0) {
          queue.removeMany(ids);
          queueChanged = true;
        }
      } catch (err) {
        console.warn(`${LOG} 반영한 항목을 대기열에서 빼지 못함:`, describeError(err));
      }
      this.markMailsReflected(run, sentItems, sentMailKeys);
    }

    try {
      this.opts.history().append(run);
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 남기지 못함:`, describeError(err));
    }

    if (run.state === 'done') {
      console.log(`${LOG} 위키 반영 끝: 바뀐 파일 ${run.changed?.length ?? 0}개 · 건너뜀 ${run.skipped?.length ?? 0}건`);
    } else {
      console.warn(`${LOG} 위키 반영 실패: ${run.error ?? '(이유 없음)'}`);
    }
    broadcastReflect(run);
    if (queueChanged) this.publishQueue();
    else this.relinkMailbox();
  }

  /**
   * 2.14 §4-3: 성공한 실행의 mail 항목마다 보낸 메일 키 전부에 반영 표시(건너뜀 판정은 skippedItemIds).
   * 표시 쓰기 실패는 실행 결과를 바꾸지 않고 로그만
   */
  private markMailsReflected(run: ReflectRun, sentItems: readonly QueueItem[], sentMailKeys: ReadonlyMap<string, MailKey[]>): void {
    const mailbox = this.mailbox();
    if (!mailbox) return;
    const skippedIds = skippedItemIds(run.skipped ?? [], sentItems);
    for (const item of sentItems) {
      if (item.kind !== 'mail') continue;
      const keys = sentMailKeys.get(item.id) ?? [];
      if (keys.length === 0) continue;
      try {
        mailbox.markWiki(keys, { state: skippedIds.has(item.id) ? 'skipped' : 'done', runId: run.id });
      } catch (err) {
        console.warn(`${LOG} 메일 위키 반영 표시를 남기지 못함: ${item.title} · ${describeError(err)}`);
      }
    }
  }

  private mailbox(): MailboxService | null {
    try {
      return this.opts.mailbox?.() ?? null;
    } catch {
      return null;
    }
  }

  /** 메일함 「위키 반영 대기·반영 중」 표시를 다시 계산(대기열·실행이 바뀔 때) */
  private relinkMailbox(): void {
    try {
      this.mailbox()?.relink();
    } catch (err) {
      console.warn(`${LOG} 메일함 연결을 다시 계산하지 못함:`, describeError(err));
    }
  }

  /** 지금 실행에 들어간 항목 id */
  runningIds(): Set<string> {
    return new Set(this.running ? this.running.itemIds : []);
  }

  /** 화면으로 보낼 대기열(2.14 §3-4 — mail 항목에 blocked) */
  queueView(): QueueItem[] {
    return withBlocked(this.opts.queue().list(), this.mailbox());
  }

  /** 메일함 「위키 반영 대기」 재료(MailboxService deps.wikiPending) */
  wikiPending(): MailWikiPending[] {
    return wikiPendingOf(this.opts.queue().list(), this.runningIds());
  }

  /** 대기열이 바뀐 뒤: 모든 창에 방송(blocked 붙임)하고 메일함 표시를 다시 계산한다 */
  publishQueue(): void {
    try {
      const view = this.queueView();
      this.blockedSig = blockedSignature(view);
      broadcastQueue(view);
    } catch (err) {
      console.warn(`${LOG} 반영 대기열을 읽지 못함:`, describeError(err));
    }
    this.relinkMailbox();
  }

  /**
   * 메일함 색인이 바뀐 뒤(메일이 지워지거나 격리됨): mail 항목의 blocked 가 바뀌었을 때만 다시 방송한다(§3-4).
   * 메일함 연결은 다시 계산하지 않는다(요약 방송 → 이것 → 요약 방송으로 돌지 않게)
   */
  refreshBlocked(): void {
    try {
      const view = this.queueView();
      const sig = blockedSignature(view);
      if (sig === this.blockedSig) return;
      this.blockedSig = sig;
      broadcastQueue(view);
    } catch (err) {
      console.warn(`${LOG} 반영 대기열을 읽지 못함:`, describeError(err));
    }
  }

  /**
   * 앱을 끝낼 때: 실행 중이면 claude 프로세스 트리를 끝내고(reflect.ts 의 stopActiveReflect — Windows 는
   * 부모가 끝나도 자식을 끝내지 않는다) 실패로 기록한다. 대기열은 그대로 둔다.
   * 종료가 끝나기 전에 프로세스가 사라져도 reflect.ts 가 process 'exit' 에서 한 번 더 동기로 끝낸다.
   * 결과가 늦게 와도 버리도록 표를 먼저 지우고, 기록은 여기서 동기로 남긴다. 여러 번 불러도 된다.
   */
  stopForQuit(): void {
    const reason = '앱을 끝내 claude 실행을 중단함';
    const stopped = stopActiveReflect(reason);
    if (!this.running) return;
    const run: ReflectRun = {
      ...this.running,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: reason,
      log: [...this.running.log, reason].slice(-50),
    };
    this.token = null;
    this.running = null;
    this.sentItems = [];
    this.sentMailKeys = new Map();
    this.last = run;
    console.warn(`${LOG} ${reason}${stopped ? '' : '(실행 중인 프로세스는 없었음)'}`);
    try {
      this.opts.history().append(run);
    } catch (err) {
      console.warn(`${LOG} 반영 실행 기록을 남기지 못함:`, describeError(err));
    }
  }
}

// ---------------------------------------------------------------------------
// 등록

/** 창 쪽 동작. index.ts 가 구현해 넘긴다. */
export interface WindowControl {
  /** 이 webContents 가 우리 창(사이드바·풀스크린)의 것인가 */
  isAppContents(contents: WebContents): boolean;
  /** 요청을 보낸 창의 모드 */
  modeOf(contents: WebContents): WindowMode;
  /** 그 창이 지금 화면에 보이는가(숨긴·최소화한 창이면 거짓) */
  isShown(contents: WebContents): boolean;
  setMode(mode: WindowMode, focusTaskId?: string): void;
  /** 사이드바 '항상 위'를 뒤집고 바뀐 값을 돌려준다 */
  togglePin(): boolean;
  quit(): void;
}

export interface IpcDeps {
  wikiRoot: string;
  snapshots: SnapshotService;
  windows: WindowControl;
  // ---- 2단계
  /** 필드·로그·메모에 쓰는 오늘(YYYY-MM-DD) */
  getToday: () => string;
  /** 위키에 쓴 뒤 스냅샷을 곧바로 다시 만들어 두 창에 방송한다. 만든 스냅샷 또는 null(실패) */
  refreshSnapshot: () => Snapshot | null;
  queue: () => QueueStore;
  reflect: ReflectController;
  // ---- 2.5단계
  /** 발송 기록(sent-mail.json·sent/). 처음 쓸 때 연다 */
  sentLog: () => SentLog;
  /** 보내는 이름·서명(mail-settings.json). 처음 쓸 때 연다 */
  mailSettings: () => MailSettingsStore;
  /** 초안 만들기를 누를 때마다 다시 찾는다 */
  getClaudePath: () => ClaudeLocation;
  /** SMTP 계정·시험 가드를 읽을 환경 변수. 없으면 process.env */
  env?: NodeJS.ProcessEnv;
  // ---- 2.6단계
  /** VOC 보드·쓰기(voc-cli). 보드가 바뀌면 index.ts 가 방송하고 스냅샷의 VOC 할 일을 바꾼다 */
  voc: VocService;
  /** VOC 설정(voc-settings.json). 처음 쓸 때 연다 */
  vocSettings: () => VocSettingsStore;
  // ---- 2.7단계
  /** 처음 실행 점검(위키 폴더·claude·메일 계정). 없으면 그 채널은 등록하지 않는다(시험용) */
  setup?: SetupControl;
  // ---- 2.8단계
  /** 팀 위키 동기화. 없으면 그 채널은 등록하지 않는다(시험용) */
  teamSync?: TeamSyncControl;
  // ---- 2.9단계
  /** 설정 › 나(내 이름·다른 표기). 없으면 그 채널은 등록하지 않는다(시험용) */
  me?: MeControl;
  /** 팀 위키 할 일(읽기·쓰기·문서 열기). 없으면 그 채널은 등록하지 않는다(시험용) */
  teamTasks?: TeamTasksControl;
  /** 알림 N1(설정 › 알림·알림함). 없으면 그 채널은 등록하지 않는다(시험용) */
  notify?: NotifyControl;
  /**
   * VOC 처리를 실행하기 직전(검사한 입력) — 알림이 내가 나에게 배정한 티켓을 새 배정에서 뺀다(2.9단계 §6-1).
   * 처리 뒤 보드가 먼저 방송될 수 있어 실행 전에 부른다
   */
  beforeVocAction?: (input: VocActionInput) => void;
  // ---- 2.10단계
  /** 메일함(raw/mail 색인·상태). 없으면 그 채널은 등록하지 않는다(시험용) */
  mailbox?: MailboxService;
  // ---- 3a단계
  /** 위키 검색·미리보기·변경 피드. 없으면 그 채널은 등록하지 않는다(시험용) */
  wikiDocs?: WikiDocsService;
  /**
   * 바깥 주소 열기(기본 shell.openExternal). 시험 모드(index.ts)는 열지 않고 open-log.jsonl 에 적는다(3a단계 §7-3).
   * kind 는 기록용: external = 외부 링크 · obsidian = Obsidian 열기
   */
  openExternal?: (url: string, kind: 'external' | 'obsidian') => Promise<void>;
  // ---- 2.13단계
  /** SMTP 계정(설정 › 메일 보내기 + 환경 변수 + .env — 부를 때마다). 없으면 loadSmtpAccount(env, wikiRoot) */
  smtpAccount?: () => AccountResult;
  /** 이 앱이 아는 비밀 전부(초안·보낼 메일 검사). 없으면 knownMailSecrets(env, wikiRoot) */
  knownSecrets?: () => string[];
  /** 회신 초안 엔진(설정 › AI). 없으면 늘 Claude */
  draftAi?: { engine(): 'claude' | 'local'; target(): { ok: true; target: LlmTarget } | { ok: false; problem: string; untested?: true } };
  /** 개인 위키 「없음」(설정 › 위키) — 위키 쓰기 IPC 를 거부한다(이중 방어) */
  wikiNone?: boolean;
  /** Claude 실행 결과(AI 칸 「마지막 실행」) */
  onClaudeRun?: (what: string, ok: boolean, message?: string) => void;
  /** 설정 나머지 6칸. 없으면 그 채널은 등록하지 않는다(시험용) */
  settings?: SettingsControl;
  // ---- 2.15단계
  /** 그 메일 경로(raw/mail/…)가 있는 기준 폴더(앱 데이터 메일 보관소 또는 옛 메일 자리). 없으면 위키 루트 */
  mailBaseOf?: (rel: string) => string;
  /** 메일 수집기. 없으면 그 채널은 등록하지 않는다(시험용) */
  collector?: MailCollectorControl;
  /** 보낸 메일 원문을 메일함 보관소에 남긴다(2.15). 없으면 남기지 않는다 */
  saveSentMail?: (raw: Buffer) => void;
  /** 원본 보기의 외부 그림 받기(2.15). 없으면 외부 그림은 받지 못한 것으로 */
  fetchMailImage?: FetchImage;
  /** 로컬 LLM 메일 분석(2.16). 없으면 그 채널은 등록하지 않는다 */
  mailAnalyzer?: { view(key: string): MailAnalysisView; analyze(key: string, force: boolean): Promise<MailAnalysisView> };
}

/** 메일 수집기(index.ts 가 만든다 — collector.ts MailCollector). 명세 2.15단계 §C */
export interface MailCollectorControl {
  status(): MailCollectStatus;
  runNow(): Promise<MailCollectStatus>;
}

/** 설정 나머지 6칸(index.ts 가 만든다 — 대화상자·폴더 열기·업데이트는 electron 이 필요하다). 명세 2.13단계 §F-1 */
export interface SettingsControl {
  get(section: SettingsSection): SettingsSectionView;
  /** 검사한 patch(requireSettingsPatch) */
  save(section: SettingsSection, patch: SettingsPatch): SettingsSaveResult;
  test(section: TestableSection, draft: SettingsPatch): Promise<ConnectionTestResult>;
  importDotEnv(): SettingsSectionView;
  teamDefaults(refresh: boolean): Promise<TeamDefaultsView>;
  pickFolder(sender: WebContents, purpose: 'personalWiki' | 'teamLocal'): Promise<string | null>;
  vocLogout(): Promise<void>;
  appInfo(): AppInfo;
  checkForUpdate(): Promise<UpdateCheckResult>;
  openFolder(which: 'data' | 'logs'): Promise<void>;
  diagnostics(): string;
  exportSettings(sender: WebContents): Promise<{ saved: boolean; path?: string }>;
  previewImport(sender: WebContents): Promise<SettingsImportPreview | null>;
  applyImport(token: string, sections: string[]): { applied: string[] };
}

/** 칸 이름 검사 */
function requireSettingsSection(v: unknown): SettingsSection {
  if (typeof v === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(v)) return v as SettingsSection;
  throw new Error('잘못된 요청입니다: 설정 칸');
}

function requireTestableSection(v: unknown): TestableSection {
  if (typeof v === 'string' && (TESTABLE_SECTIONS as readonly string[]).includes(v)) return v as TestableSection;
  throw new Error('잘못된 요청입니다: 연결 시험 칸');
}

/** 연결 시험 초안: VOC 칸은 apiUrl 하나, 나머지는 저장과 같은 검사 */
export function requireTestDraft(section: TestableSection, raw: unknown): SettingsPatch {
  if (section === 'voc') {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('잘못된 요청입니다: 시험 값');
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== 'apiUrl') throw new Error(`잘못된 요청입니다: ${k.slice(0, 30)}`);
    if (r.apiUrl !== undefined && r.apiUrl !== null && (typeof r.apiUrl !== 'string' || r.apiUrl.length > 200)) throw new Error('잘못된 요청입니다: apiUrl');
    return typeof r.apiUrl === 'string' ? { apiUrl: r.apiUrl } : {};
  }
  return requireSettingsPatch(section, raw ?? {});
}

/** 가져오기 칸 목록(20개까지, 칸 이름 글) */
function requireImportSections(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 20) throw new Error('잘못된 요청입니다: 가져올 칸');
  return v.map((x) => {
    if (typeof x !== 'string' || !/^[A-Za-z]{1,20}$/.test(x)) throw new Error('잘못된 요청입니다: 가져올 칸');
    return x;
  });
}

/** 알림 N1(index.ts 가 만든다 — 앱 설정·알림 서비스·창 전환을 묶는다). 명세 2.9단계 §8·§10 */
export interface NotifyControl {
  settings(): NotifySettings;
  /** 검사한 설정 */
  save(settings: NotifySettings): NotifySettings;
  inbox(): InboxState;
  /** 검사한 id 목록 또는 'all' */
  markRead(ids: 'all' | string[]): InboxState;
  /** 검사한 id — 읽음으로 바꾸고 그 대상으로 간다 */
  open(id: string): void;
  /** 2.12단계: 검사한 id 목록을 미룬다. 없으면 그 채널은 등록하지 않는다 */
  snooze?(ids: string[], until: SnoozeKind): InboxState;
  /** 2.12단계: 창 닫기 설정. 없으면 그 채널은 등록하지 않는다 */
  shell?: { get(): ShellSettings; save(settings: ShellSettings): ShellSettings };
}

/** radar:snoozeInboxItems 입력 검사(§9): { ids: 1~500, until: '1h' | 'morning' } — 다른 키 없음 */
export function requireSnoozeInput(raw: unknown): { ids: string[]; until: SnoozeKind } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('잘못된 요청입니다: 미루기');
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== 'ids' && key !== 'until') throw new Error(`잘못된 요청입니다: ${key.slice(0, 20)}`);
  }
  if (r.until !== '1h' && r.until !== 'morning') throw new Error('잘못된 요청입니다: until');
  if (!Array.isArray(r.ids) || r.ids.length === 0 || r.ids.length > INBOX_IDS_MAX) throw new Error('잘못된 요청입니다: 알림 id 목록');
  return { ids: r.ids.map(requireInboxId), until: r.until };
}

/** 알림함 읽음 요청의 최대 id 수 */
const INBOX_IDS_MAX = 500;

function requireNotifyKind(value: unknown): NotifyKind {
  if (typeof value === 'string' && (NOTIFY_KINDS as readonly string[]).includes(value)) return value as NotifyKind;
  throw new Error('잘못된 요청입니다: 알림 종류');
}

function requireInboxId(value: unknown): string {
  if (typeof value === 'string' && NOTIFY_ITEM_ID_RE.test(value)) return value;
  throw new Error('잘못된 요청입니다: 알림 id');
}

/** 'all' 또는 id 배열(500개 이하, 각 n_ + 영숫자) */
export function requireInboxIds(value: unknown): 'all' | string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length > INBOX_IDS_MAX) throw new Error('잘못된 요청입니다: 알림 id 목록');
  return value.map(requireInboxId);
}

/** 팀 위키 할 일(index.ts 가 만든다 — 사본 경로·백업 폴더·동기화 상태를 묶는다). 명세 2.9단계 §3·§5 */
export interface TeamTasksControl {
  board(): TeamTaskBoard;
  /** 검사한 입력(requireSaveTeamTaskInput 을 거친 것). 저장 큐 안에서 부른다 */
  save(input: SaveTeamTaskInput): SaveTeamTaskOutput;
  /** 검사한 상대경로 */
  open(relPath: string): Promise<void>;
}

/** 설정 › 나(index.ts 가 만든다 — 앱 설정과 VOC 보드의 내 이름을 묶는다). 명세 2.9단계 §4-4 */
export interface MeControl {
  get(): MeInfo;
  /** 검사한 입력(checkMeSettings 를 거친 것) */
  save(settings: MeSettings): MeInfo;
}

/** 팀 위키 동기화(index.ts 가 만든다 — 폴더 열기는 electron 이 필요하다). 명세 2.8단계 */
export interface TeamSyncControl {
  status(): TeamSyncStatus;
  /** 검사한 입력. 경로가 틀리면 예외 */
  set(input: TeamSyncInput): TeamSyncStatus;
  run(confirmLarge: boolean): Promise<TeamSyncStatus>;
  open(how: 'obsidian' | 'folder'): Promise<void>;
}

/** 팀 위키 경로 입력의 최대 길이 */
const TEAM_PATH_MAX = 1024;

function requireTeamSyncInput(value: unknown): TeamSyncInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 요청입니다: 팀 위키 설정');
  const v = value as Record<string, unknown>;
  if (typeof v.enabled !== 'boolean') throw new Error('잘못된 요청입니다: enabled');
  const out: TeamSyncInput = { enabled: v.enabled };
  for (const key of ['remote', 'local'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'string' || (v[key] as string).length > TEAM_PATH_MAX) throw new Error(`잘못된 요청입니다: ${key}`);
    out[key] = v[key] as string;
  }
  return out;
}

/** 처음 실행 점검(index.ts 가 만든다 — 폴더 고르기 창·다시 시작은 electron 이 필요하다). 명세 2.7단계 */
export interface SetupControl {
  status(): SetupStatus;
  /** 폴더 고르기 창을 그 화면 위에 띄운다 */
  chooseWiki(sender: WebContents): Promise<ChooseWikiResult>;
  markSeen(): SetupStatus;
  restart(): void;
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** 되돌리기용으로 기억해 두는 저장 항목 수 */
const SAVED_TASKS_LIMIT = 200;

/** VOC 할 일에 처리 결과 저장이 오면(2.6단계 §5) */
export const VOC_TASK_SAVE_REFUSED = 'VOC 할 일은 VOC 처리로 저장합니다';

/** VOC 화면을 열 때 이보다 오래된 보드면 새로 받는다(2.6단계 §2-3 — 2분) */
const VOC_VIEW_MAX_AGE_MS = 120_000;

/** 설정 화면을 열 때 사람·코드 목록을 새로 받되, 이 간격 안에 또 오면 하루 캐시를 쓴다(voc-cli 4번 실행) */
const VOC_DIRECTORY_FORCE_MIN_MS = 60_000;

/** 같은 채널·같은 문장의 실패는 한 번만 로그한다(창 2개가 같은 요청을 되풀이해도 로그가 넘치지 않게). */
const loggedFailures = new Set<string>();
function logFailureOnce(channel: string, message: string): void {
  const key = `${channel}|${message}`;
  if (loggedFailures.has(key)) return;
  loggedFailures.add(key);
  console.warn(`${LOG} ${channel} 실패: ${message}`);
}

/** 저장에 덧붙는 것 — 보내고 저장이면 보낸 본문(반영 대기열 항목의 reply) */
interface SaveExtra {
  reply?: string;
}

/** 대기열 항목의 재료. 제목은 화면에 보이는 제목, 파일은 연결된 줄(없으면 첫 앵커)의 파일. */
function queueItemOf(task: Task, input: SaveResultInput, extra: SaveExtra = {}): NewQueueItem {
  const item: NewQueueItem = {
    kind: 'task',
    taskId: task.id,
    title: task.title,
    status: input.status,
    note: input.note?.trim() ?? '',
  };
  if (input.status === 'notmine') item.owner = input.owner ?? '타담당';
  if (task.company) item.company = task.company;
  const file = task.file ?? task.anchors?.[0]?.file;
  if (file) item.file = file;
  if (task.mail) item.mail = task.mail;
  if (task.src) item.src = task.src;
  if (extra.reply?.trim()) item.reply = extra.reply;
  return item;
}


/** IPC 핸들러를 모두 등록한다. 창을 만들기 전에 한 번 부른다. */
export function registerIpc(deps: IpcDeps): void {
  const { wikiRoot, snapshots, windows } = deps;
  /** 그 메일이 있는 기준 폴더(2.15 — 메일 보관소 또는 옛 메일 자리, 없으면 위키 루트) */
  const mailBaseOf = (rel: string): string => deps.mailBaseOf?.(rel) ?? wikiRoot;
  /** 할 일 줄의 [mail::] 값 → 메일 경로. 2.15 메일 ID(`m:…`)는 메일함 색인으로 푼다(모르면 null). 옛 꼴은 그대로 */
  const mailPathOf = (ref: string): string | null => (MAIL_KEY_RE.test(ref) ? deps.mailbox?.entryOfKey(ref)?.path ?? null : ref);
  /** mail 이 메일 ID 인 할 일은 경로로 푼 사본(회신·VOC·발송 흐름은 경로를 쓴다) */
  const withMailPath = (t: Task | undefined): Task | undefined => {
    if (!t?.mail || !MAIL_KEY_RE.test(t.mail)) return t;
    const p = mailPathOf(t.mail);
    return p ? { ...t, mail: p } : t;
  };
  const serialSave = createSerialQueue();
  const openExternal = deps.openExternal ?? ((url: string) => shell.openExternal(url));
  /** 이 앱이 개인 위키에 쓴 파일은 변경 피드에서 읽음으로(3a단계 §5-3) — 실패해도 저장은 그대로 */
  const noteOwnWrite = (files: readonly string[]): void => {
    if (!deps.wikiDocs || files.length === 0) return;
    void deps.wikiDocs.noteOwnWrite('personal', files).catch((err: unknown) => console.warn(`${LOG} 위키 변경 읽음 처리 실패:`, describeError(err)));
  };

  // 실패는 예외 대신 IpcReply 로 돌려준다(shared/ipc.ts 참고). preload 가 Error 로 되살린다.
  const handle = (channel: string, fn: Handler) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcReply<unknown>> => {
      if (!windows.isAppContents(event.sender)) {
        logFailureOnce(channel, '허용되지 않은 요청입니다');
        return { ok: false, message: '허용되지 않은 요청입니다' };
      }
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (err) {
        const message = describeError(err);
        logFailureOnce(channel, message);
        return { ok: false, message };
      }
    });
  };

  handle(IPC.getSnapshot, (): Snapshot => snapshots.current());

  handle(IPC.getMail, (_event, relPath): MailSummary | null => {
    const rel = mailPathOf(requireString(relPath, 'relPath', MAX_REL_PATH_LENGTH));
    if (rel === null || !looksLikeMailPath(rel)) return null;
    try {
      return readMailSummary(mailBaseOf(rel), rel);
    } catch (err) {
      throw new Error(`메일을 읽지 못했습니다: ${describeError(err)}`);
    }
  });

  handle(IPC.openInObsidian, async (_event, relPath): Promise<void> => {
    const rel = requireString(relPath, 'relPath', MAX_REL_PATH_LENGTH);
    const abs = resolveWikiMarkdown(wikiRoot, rel);
    if (!abs) throw new Error('위키 안의 .md 문서만 열 수 있습니다');
    if (!markdownMayExist(abs)) throw new Error(`문서를 찾을 수 없습니다: ${rel}`);
    try {
      await openExternal('obsidian://open?path=' + encodeURIComponent(abs), 'obsidian');
    } catch (err) {
      throw new Error(`Obsidian을 열지 못했습니다: ${describeError(err)}`);
    }
  });

  handle(IPC.setMode, (_event, mode, focusTaskId): void => {
    const m = requireMode(mode);
    // 문서 하나를 여는 표시(view:doc:<p|t>:<인코딩한 경로> — 3a단계 §8-1)는 경로가 길어 따로 한도를 둔다
    const max = typeof focusTaskId === 'string' && focusTaskId.startsWith(FOCUS_DOC_PREFIX) ? FOCUS_DOC_ID_MAX : MAX_TASK_ID_LENGTH;
    const id = focusTaskId === undefined || focusTaskId === null ? undefined : requireString(focusTaskId, 'focusTaskId', max);
    windows.setMode(m, id);
  });

  handle(IPC.getMode, (event): WindowMode => windows.modeOf(event.sender));

  handle(IPC.togglePin, (): boolean => windows.togglePin());

  handle(IPC.quit, (): void => {
    windows.quit();
  });

  /** 개인 위키 「없음」이면 위키 쓰기를 거부한다(2.13단계 §C-1 — 자리 표시 경로는 없지만 한 번 더) */
  const refuseIfWikiNone = (): void => {
    if (deps.wikiNone) throw new Error(WIKI_NONE_REFUSED);
  };

  // ---- 2.15단계: 메일 수집 ------------------------------------------------------
  const collectorCtl = deps.collector;
  if (collectorCtl) {
    handle(IPC.getMailCollect, (): MailCollectStatus => collectorCtl.status());
    handle(IPC.collectMailNow, (): Promise<MailCollectStatus> => collectorCtl.runNow());
  }

  // ---- 2.13단계: 설정 나머지 6칸 ------------------------------------------------
  const settingsCtl = deps.settings;
  if (settingsCtl) {
    handle(IPC.getSettings, (_event, section): SettingsSectionView => settingsCtl.get(requireSettingsSection(section)));
    handle(IPC.saveSettings, (_event, section, raw): SettingsSaveResult => {
      const s = requireSettingsSection(section);
      return settingsCtl.save(s, requireSettingsPatch(s, raw));
    });
    handle(IPC.testSettings, (_event, section, raw): Promise<ConnectionTestResult> => {
      const s = requireTestableSection(section);
      return settingsCtl.test(s, requireTestDraft(s, raw));
    });
    handle(IPC.importDotEnvAccount, (): SettingsSectionView => settingsCtl.importDotEnv());
    handle(IPC.getTeamDefaults, (_event, raw): Promise<TeamDefaultsView> => {
      if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('잘못된 요청입니다: 팀 기본값');
      const refresh = !!raw && (raw as { refresh?: unknown }).refresh === true;
      return settingsCtl.teamDefaults(refresh);
    });
    handle(IPC.pickFolder, (event, purpose): Promise<string | null> => {
      if (purpose !== 'personalWiki' && purpose !== 'teamLocal') throw new Error('잘못된 요청입니다: purpose');
      return settingsCtl.pickFolder(event.sender, purpose);
    });
    handle(IPC.vocLogout, (): Promise<void> => settingsCtl.vocLogout());
    handle(IPC.getAppInfo, (): AppInfo => settingsCtl.appInfo());
    let lastUpdateCheck = 0;
    handle(IPC.checkForUpdate, (): Promise<UpdateCheckResult> => {
      const now = Date.now();
      if (now - lastUpdateCheck < 30_000) throw new Error('업데이트 확인은 30초에 한 번만 됩니다');
      lastUpdateCheck = now;
      return settingsCtl.checkForUpdate();
    });
    handle(IPC.openAppFolder, (_event, which): Promise<void> => {
      if (which !== 'data' && which !== 'logs') throw new Error('잘못된 요청입니다: 폴더');
      return settingsCtl.openFolder(which);
    });
    handle(IPC.getDiagnostics, (): string => settingsCtl.diagnostics());
    handle(IPC.exportSettings, (event): Promise<{ saved: boolean; path?: string }> => settingsCtl.exportSettings(event.sender));
    handle(IPC.previewSettingsImport, (event): Promise<SettingsImportPreview | null> => settingsCtl.previewImport(event.sender));
    handle(IPC.applySettingsImport, (_event, token, sections): { applied: string[] } => {
      if (typeof token !== 'string' || token.length > 64) throw new Error('잘못된 요청입니다: 가져오기 토큰');
      return settingsCtl.applyImport(token, requireImportSections(sections));
    });
  }

  // ---- 2.7단계: 처음 실행 점검 ------------------------------------------------
  const { setup } = deps;
  if (setup) {
    handle(IPC.getSetup, (): SetupStatus => setup.status());
    handle(IPC.chooseWikiFolder, (event): Promise<ChooseWikiResult> => setup.chooseWiki(event.sender));
    handle(IPC.markSetupSeen, (): SetupStatus => setup.markSeen());
    handle(IPC.restartApp, (): void => setup.restart());
  }

  // ---- 2.8단계: 팀 위키 동기화 ------------------------------------------------
  const { teamSync } = deps;
  if (teamSync) {
    handle(IPC.getTeamSync, (): TeamSyncStatus => teamSync.status());
    handle(IPC.setTeamSync, (_event, input): TeamSyncStatus => teamSync.set(requireTeamSyncInput(input)));
    handle(IPC.runTeamSync, (_event, confirmLarge): Promise<TeamSyncStatus> => teamSync.run(confirmLarge === true));
    handle(IPC.openTeamWiki, (_event, how): Promise<void> => {
      if (how !== 'obsidian' && how !== 'folder') throw new Error('잘못된 요청입니다: how');
      return teamSync.open(how);
    });
  }

  // ---- 2.9단계: 설정 › 나 ----------------------------------------------------
  const { me } = deps;
  if (me) {
    handle(IPC.getMe, (): MeInfo => me.get());
    handle(IPC.saveMe, (_event, raw): MeInfo => me.save(checkMeSettings(raw)));
  }

  // ---- 2.9단계: 팀 위키 할 일 ------------------------------------------------
  const { teamTasks } = deps;
  if (teamTasks) {
    handle(IPC.getTeamTasks, (): TeamTaskBoard => teamTasks.board());
    // 개인 위키 저장과 같은 직렬 큐(한 번에 하나) — 경로·줄 검사는 teamWriteback 이 파일을 건드리기 전에 한다
    handle(IPC.saveTeamTask, (_event, raw): Promise<SaveTeamTaskOutput> => {
      const input = requireSaveTeamTaskInput(raw);
      return serialSave(() => teamTasks.save(input));
    });
    handle(IPC.openTeamDoc, (_event, rel): Promise<void> => {
      if (typeof rel !== 'string' || rel.length === 0 || rel.length > TEAM_DOC_PATH_MAX) throw new Error('잘못된 요청입니다: 문서 경로');
      return teamTasks.open(rel);
    });
  }

  // ---- 2.9단계: 알림 N1 --------------------------------------------------------
  const { notify } = deps;
  if (notify) {
    handle(IPC.getNotifySettings, (): NotifySettings => notify.settings());
    // 2.12단계 §6-1: 새 칸은 빠져도 된다 — 지금 저장값과 합친 뒤 엄격히 검사한다
    handle(IPC.saveNotifySettings, (_event, raw): NotifySettings => notify.save(checkNotifySettings(mergeNotifyInput(notify.settings(), raw))));
    handle(IPC.muteNotifyKind, (_event, raw): NotifySettings => {
      const kind = requireNotifyKind(raw);
      const cur = notify.settings();
      return notify.save({ ...cur, kinds: { ...cur.kinds, [kind]: 'off' } });
    });
    handle(IPC.getInbox, (): InboxState => notify.inbox());
    handle(IPC.markInboxRead, (_event, raw): InboxState => notify.markRead(requireInboxIds(raw)));
    handle(IPC.openInboxItem, (_event, raw): void => notify.open(requireInboxId(raw)));
    const { snooze, shell } = notify;
    if (snooze) {
      handle(IPC.snoozeInboxItems, (_event, raw): InboxState => {
        const input = requireSnoozeInput(raw);
        return snooze(input.ids, input.until);
      });
    }
    if (shell) {
      handle(IPC.getShellSettings, (): ShellSettings => shell.get());
      handle(IPC.saveShellSettings, (_event, raw): ShellSettings => shell.save(checkShellSettings(raw)));
    }
  }

  // ---- 2단계: 처리 결과 저장 ------------------------------------------------

  /**
   * 이번 실행 중에 저장한 항목(오래된 것부터, 최대 SAVED_TASKS_LIMIT 개). 스냅샷에는 열린 할 일(open·wip)만 있어
   * 완료·내 일 아님으로 바꾼 항목은 빠지므로, 그 항목을 되돌릴(open 등) 때 여기서 찾는다.
   * 앵커·핵심문구는 상태를 바꿔도 그대로라 저장 때의 항목으로 줄을 다시 찾을 수 있다(writeback 이 파일을 새로 읽는다).
   */
  const savedTasks = new Map<string, Task>();
  const rememberSaved = (task: Task): void => {
    savedTasks.delete(task.id);
    savedTasks.set(task.id, task);
    while (savedTasks.size > SAVED_TASKS_LIMIT) {
      const oldest = savedTasks.keys().next().value;
      if (oldest === undefined) break;
      savedTasks.delete(oldest);
    }
  };

  /** 할 일 찾기: 스냅샷 → 새로 읽기 → 이번 실행 중 저장한 항목. 저장·회신이 같은 방법을 쓴다 */
  function findTask(taskId: string): Task | undefined {
    let task = snapshots.current().tasks.find((t) => t.id === taskId);
    if (!task) {
      // 감시가 아직 따라오지 못한 변경일 수 있다 — 한 번 새로 읽어 본다.
      task = snapshots.refresh()?.tasks.find((t) => t.id === taskId);
    }
    // 목록에서 빠진(완료·내 일 아님) 항목의 되돌리기
    return withMailPath(task ?? savedTasks.get(taskId));
  }

  /**
   * 저장 한 건. serialSave 안에서만 부른다 — 항목 찾기부터 쓰기·스냅샷 재생성까지가 한 덩어리다.
   * extra.reply 는 보내고 저장(2.5단계)이 반영 대기열 항목에 더하는 보낸 본문.
   */
  function saveResult(input: SaveResultInput, extra: SaveExtra = {}): SaveResultOutput {
    const task = findTask(input.taskId);
    if (!task) {
      throw new Error('저장할 할 일을 목록에서 찾지 못했습니다(그사이 위키가 바뀌었을 수 있습니다). 목록을 확인한 뒤 다시 저장하세요');
    }
    // VOC 할 일은 위키에 줄이 없다 — 처리는 VOC 쪽(답변·상태)으로 하고, 반영 대기열에도 넣지 않는다(2.6단계 §5)
    if (task.source === 'voc') throw new Error(VOC_TASK_SAVE_REFUSED);
    // 팀 위키 할 일은 개인 쓰기 규칙(로그 절·메모·반영 대기)과 섞지 않는다(2.9단계 §5)
    if (task.source === 'team') throw new Error(TEAM_TASK_SAVE_REFUSED);

    // 쓰기 전에 기억한다 — 일부만 쓰고 실패해 목록에서 빠진 항목(완료 줄은 썼는데 다음 파일이 막힘 등)도 다시 저장할 수 있게
    rememberSaved(task);

    /** 위키 지식 반영 대기열에 넣는다. 실패하면 이유를 warnings 에 적고 undefined */
    const enqueue = (warnings: string[]): QueueItem | undefined => {
      if (!input.reflect) return undefined;
      try {
        const queue = deps.queue();
        const queued = queue.add(queueItemOf(task, input, extra));
        deps.reflect.publishQueue();
        return queued;
      } catch (err) {
        // 위키에는 이미 썼으므로 저장 자체를 실패로 돌리지 않는다.
        warnings.push(`위키 지식 반영 대기열에 넣지 못했습니다: ${describeError(err)}`);
        return undefined;
      }
    };

    let result: WritebackResult;
    try {
      result = applyWriteback({
        wikiRoot,
        today: deps.getToday(),
        task,
        status: input.status,
        ...(input.status === 'notmine' && input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
    } catch (err) {
      if (err instanceof PartialWriteError) {
        // 일부 파일은 이미 썼다 — 목록을 바로 다시 만들고, 반영 요청도 잃지 않게 대기열에 넣은 뒤 '일부만 저장'으로 알린다.
        console.warn(`${LOG} 처리 결과 일부만 저장: ${task.id} → ${input.status} · 쓴 파일 ${err.written.join(', ')}`);
        noteOwnWrite(err.written);
        const notes: string[] = [];
        if (!deps.refreshSnapshot()) notes.push('목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
        if (enqueue(notes)) notes.push('위키 지식 반영 대기열에는 넣었습니다');
        throw new Error(`${PARTIAL_SAVE_PREFIX}: ${err.message}${notes.map((n) => ` — ${n}`).join('')}`);
      }
      throw new Error(`위키에 저장하지 못했습니다: ${describeError(err)}`);
    }
    console.log(
      `${LOG} 처리 결과 저장: ${task.id} → ${input.status} · 쓴 파일 ${result.files.length}개` +
        (result.backupDir ? ` · 백업 ${result.backupDir}` : '') +
        (result.unmatched.length ? ` · 못 찾음 ${result.unmatched.length}건` : ''),
    );

    const warnings = [...result.warnings];
    noteOwnWrite(result.files);
    // 감시(800ms)를 기다리지 않고 바로 목록을 다시 만든다 — 완료·내 일 아님은 곧바로 목록에서 빠진다.
    if (!deps.refreshSnapshot()) {
      warnings.push('저장은 했지만 목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
    }

    const output: SaveResultOutput = { ...result, warnings };
    const queued = enqueue(warnings);
    if (queued) output.queued = queued;
    return output;
  }

  // 보낸 회신 본문(reply)을 반영 대기열까지 잇는다 — 보냈지만 저장이 실패한 뒤의 [저장]에도 본문이 따라간다(2.5단계 §9-3)
  const replySaver = createReplySaver((input, extra) => saveResult(input, extra));

  handle(IPC.saveResult, (_event, raw): Promise<SaveResultOutput> => {
    refuseIfWikiNone();
    const input = requireSaveInput(raw);
    if (input.taskId.startsWith('t:')) throw new Error(TEAM_TASK_SAVE_REFUSED);
    return serialSave(() => replySaver.save(input));
  });

  // ---- 2단계: 반영 대기열 ----------------------------------------------------

  // mail 항목에는 화면용 blocked 를 붙인다(2.14 §3-4 — 저장하지 않는다)
  handle(IPC.getQueue, (): QueueItem[] => deps.reflect.queueView());

  handle(IPC.removeQueueItem, (_event, id): QueueItem[] => {
    const itemId = requireString(id, 'id', MAX_QUEUE_ID_LENGTH);
    deps.queue().remove(itemId);
    deps.reflect.publishQueue();
    return deps.reflect.queueView();
  });

  // 이 버전이 모르는 kind 의 항목 수(2.14 §1-1 — 새 버전이 넣은 것, 그대로 둔다)
  handle(IPC.getQueueUnknownCount, (): number => deps.queue().unknownCount());

  // ---- 2단계: 위키에 반영(claude -p) — 사람이 버튼을 누를 때만 온다 ------------

  handle(IPC.runReflect, (): ReflectRun => {
    refuseIfWikiNone();
    return deps.reflect.start();
  });

  handle(IPC.getReflect, (): ReflectRun | null => deps.reflect.current());

  // ---- 2.5단계: 메일 회신(docs/stage2.5-contract.md) — 발송은 확인 대화상자의 [보내기]로만 온다 --------

  const env = deps.env ?? process.env;

  /** 원본 메일(raw/mail/…md). 메일 경로 모양이 아니거나 없으면 null(자세한 경로 검사는 readReplySource 가 한다) */
  function readSource(rel: string): ReplySource | null {
    if (!looksLikeMailPath(rel)) return null;
    const base = mailBaseOf(rel);
    const src = readReplySource(base, rel);
    if (src && path.resolve(base) !== path.resolve(wikiRoot)) src.base = path.resolve(base);
    return src;
  }

  /** SMTP 계정. 발송·문맥을 만들 때마다 새로 읽는다. 시험 중에 루프백이 아닌 서버를 가리키면 준비 안 됨으로 본다 */
  function loadAccount(): AccountResult {
    const result = deps.smtpAccount ? deps.smtpAccount() : loadSmtpAccount(env, wikiRoot);
    if (!result.ok) return result;
    const guard = testModeProblem(env, result.account.host);
    return guard ? { ok: false, problem: guard } : result;
  }

  /** 이 앱이 아는 비밀(초안 검사) */
  const secretsKnown = (): string[] => (deps.knownSecrets ? deps.knownSecrets() : knownMailSecrets(env, wikiRoot));

  /**
   * 회신 초안 엔진이 로컬 LLM 이면 그 대상, 아니면 null(Claude). 로컬인데 설정이 비었거나 [연결 시험] 전이면 던진다 —
   * Claude 로 몰래 넘어가지 않는다(§E). 시험 전이면 그 문장만(「넣으세요」를 붙이지 않는다)
   */
  function localDraftTarget(): LlmTarget | null {
    if (!deps.draftAi || deps.draftAi.engine() !== 'local') return null;
    const t = deps.draftAi.target();
    if (!t.ok) throw new Error(t.untested ? t.problem : `${LOCAL_DRAFT_NOT_CONFIGURED} (${t.problem})`);
    return t.target;
  }

  /** 보내는 쪽 준비 상태(비밀번호는 담지 않는다). 던지지 않는다 — 문제는 problem, 알릴 것은 notice 에 */
  function senderInfo(): ReplySender {
    // 설정을 못 읽으면(잠김 등 — 저장소가 던진다) 문맥에는 기본값을 쓰고 준비 안 됨으로 둔다(발송도 같은 이유로 거부된다)
    let settings: Readonly<MailSettings> = DEFAULT_MAIL_SETTINGS;
    let settingsError: string | undefined;
    let notice: string | null = null;
    try {
      const store = deps.mailSettings();
      settings = store.get();
      notice = store.notice;
    } catch (err) {
      settingsError = `보내는 사람·서명 설정을 읽지 못했습니다: ${describeError(err)}`;
    }
    let account: AccountResult;
    try {
      account = loadAccount();
    } catch (err) {
      account = { ok: false, problem: `메일 계정을 읽지 못했습니다: ${describeError(err)}` };
    }
    const sender: ReplySender = { ready: account.ok && settingsError === undefined, bccSelf: settings.bccSelf };
    if (account.ok) sender.address = account.account.user;
    if (settings.fromName) sender.name = settings.fromName;
    const problem = account.ok ? settingsError : account.problem;
    if (problem) sender.problem = problem;
    if (notice) sender.notice = notice;
    return sender;
  }

  /**
   * 이 할 일로 보낸 가장 최근 회신 — 같은 메일 경로로 메일함에서 보낸 기록도 본다(2.10단계 §7-1). 기록을 못 읽으면 없음(로그만)
   */
  function lastSentFor(taskId: string, mail?: string): SentMailRecord | undefined {
    try {
      return deps.sentLog().lastFor(taskId, mail ? [mail] : []);
    } catch (err) {
      console.warn(`${LOG} 발송 기록을 읽지 못함:`, describeError(err));
      return undefined;
    }
  }

  /** 메일 할 일과 그 원본. 초안 만들기용 — 없으면 사람 말로 던진다 */
  function requireMailTask(taskId: string): { task: Task; source: ReplySource } {
    const task = findTask(taskId);
    if (!task) throw new Error('회신할 할 일을 목록에서 찾지 못했습니다(그사이 위키가 바뀌었을 수 있습니다). 목록을 확인하세요');
    if (!task.mail) throw new Error('메일에서 온 할 일이 아니라 회신을 쓸 수 없습니다');
    let source: ReplySource | null;
    try {
      source = readSource(task.mail);
    } catch (err) {
      throw new Error(`원본 메일을 읽지 못했습니다: ${describeError(err)}`);
    }
    if (!source) throw new Error(`원본 메일을 찾지 못했습니다: ${task.mail}`);
    return { task, source };
  }

  handle(IPC.getReplyContext, (_event, rawId): ReplyContext | null => {
    const taskId = requireString(rawId, 'taskId', MAX_TASK_ID_LENGTH);
    const task = findTask(taskId);
    if (!task?.mail) return null;
    let source: ReplySource | null;
    try {
      source = readSource(task.mail);
    } catch (err) {
      throw new Error(`원본 메일을 읽지 못했습니다: ${describeError(err)}`);
    }
    if (!source) return null;
    const lastSent = lastSentFor(task.id, task.mail);
    return buildReplyContext({ taskId: task.id, source, sender: senderInfo(), ...(lastSent ? { lastSent } : {}) });
  });

  // 초안은 읽기 전용이라 저장 큐에 넣지 않는다(몇 분 걸려도 저장을 막지 않게). 한 번에 하나는 replyDraft.ts 가 지킨다.
  handle(IPC.draftReply, async (_event, raw): Promise<ReplyDraft> => {
    const input = requireDraftInput(raw);
    const { task, source } = requireMailTask(input.taskId);
    const local = localDraftTarget();
    if (local) {
      const { to } = buildReplyContext({ taskId: task.id, source, sender: senderInfo() });
      const messages = buildLocalDraftMessages({ kind: 'task', task, note: input.note, ...(input.hint !== undefined ? { hint: input.hint } : {}), source, to });
      console.log(`${LOG} 회신 초안 시작(로컬 LLM): ${task.id} · ${local.model}`);
      const draft = await runLocalDraft({ target: local, messages, env, secrets: secretsKnown() });
      if (containsSecret(secretsKnown(), [draft.body, draft.notes])) {
        console.warn(`${LOG} 회신 초안 버림: ${task.id} · 비밀번호·키와 같은 글이 들어 있음`);
        throw new Error(SECRET_IN_DRAFT_PROBLEM);
      }
      console.log(`${LOG} 회신 초안 끝(로컬 LLM): ${task.id} · ${Math.round(draft.durationMs / 1000)}초`);
      return draft;
    }
    if (!fs.existsSync(wikiRoot)) throw new Error(`위키 폴더를 찾을 수 없습니다: ${wikiRoot}`);
    const claude = deps.getClaudePath();
    if (!claude.exists) {
      throw new Error(`claude 실행 파일을 찾을 수 없습니다: ${claude.path} (환경 변수 WIKI_RADAR_CLAUDE 로 위치를 정할 수 있습니다)`);
    }
    // 받는사람(표시용)은 회신 문맥의 기본값 — Claude 가 정하지 않는다
    const { to } = buildReplyContext({ taskId: task.id, source, sender: senderInfo() });
    const prompt = buildDraftPrompt({
      task,
      note: input.note,
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      source,
      to,
    });
    console.log(`${LOG} 회신 초안 시작: ${task.id} · claude ${claude.path} (${claude.source})`);
    let draft: ReplyDraft;
    try {
      draft = await runReplyDraft({ wikiRoot, claudePath: claude.path, prompt, ...(source.base ? { extraDirs: [source.base] } : {}) });
      deps.onClaudeRun?.('회신 초안', true);
    } catch (err) {
      deps.onClaudeRun?.('회신 초안', false, describeError(err));
      throw err;
    }
    // 이중 방어: 초안 실행은 계정 파일을 읽지 못하게 막혀 있지만, 그래도 비밀번호가 섞여 오면 화면에 넘기지 않는다
    if (containsSecret(secretsKnown(), [draft.body, draft.notes])) {
      console.warn(`${LOG} 회신 초안 버림: ${task.id} · 계정 비밀번호와 같은 글이 들어 있음`);
      throw new Error(SECRET_IN_DRAFT_PROBLEM);
    }
    console.log(`${LOG} 회신 초안 끝: ${task.id} · ${Math.round(draft.durationMs / 1000)}초 · 참고 문서 ${draft.references.length}건`);
    return draft;
  });

  handle(IPC.cancelDraftReply, (): boolean => cancelReplyDraft());

  const replyDeps: SendReplyDeps = {
    findTask,
    readSource,
    loadAccount,
    settings: () => deps.mailSettings().get(),
    sentLog: () => deps.sentLog(),
    compose: composeMessage,
    send: (account, msg) => sendRawMessage(account, msg, env),
    save: (input, extra) => replySaver.afterSend(input, extra),
    now: () => new Date(),
    knownSecrets: secretsKnown,
    ...(deps.saveSentMail ? { saveSentMail: deps.saveSentMail } : {}),
  };

  // 저장과 같은 직렬 큐 안에서: 보낸다 → 발송 기록 → 처리 결과 저장(명세 §4-2)
  handle(IPC.sendReply, (_event, raw): Promise<SendReplyOutput> => {
    const input = validateSendInput(raw);
    return serialSave(async () => {
      const output = await sendReplyFlow(replyDeps, input);
      console.log(
        `${LOG} 회신 발송: ${input.taskId} · 받는사람 ${input.to.length}명 · 참조 ${input.cc.length}명 · ` +
          `숨은참조 ${output.sent.bcc.length}명` +
          (output.saveError ? ' · 처리 결과 저장 실패' : ''),
      );
      for (const w of output.warnings) console.warn(`${LOG} ${w}`);
      return output;
    });
  });

  handle(IPC.getMailSettings, (): MailSettings => deps.mailSettings().get());

  // 검사(길이·제어 문자)는 저장소의 validateMailSettings 가 한다
  handle(IPC.saveMailSettings, (_event, raw): MailSettings => deps.mailSettings().save(raw));

  // ---- 2.6단계: VOC 보드(docs/stage2.6-contract.md) — 쓰기는 확인 대화상자 뒤에만 온다 --------------------
  // voc-cli 는 VocService 가 직렬 큐로 한 번에 하나만 돌린다. 여기서는 인자 모양만 검사한다(동작별 뜻·CP949 는 VocService).

  const voc = deps.voc;

  /** 기다리지 않는 새로 받기. 실패는 보드 상태로 방송되므로 여기서는 로그만 */
  const refreshVocInBackground = (why: string): void => {
    voc.refresh().catch((err: unknown) => console.warn(`${LOG} VOC 새로 받기 실패(${why}):`, describeError(err)));
  };

  // VOC 화면이 열 때 부른다. 보이는 창에서 온 요청이고 2분 넘게 지났으면 뒤에서 새로 받는다(사이드바의 합계 읽기·
  // 숨은 풀스크린 창이 뜰 때 읽기로는 받지 않는다 — 첫 받기는 앱 시작 5초 뒤)
  handle(IPC.getVocBoard, (event): VocBoard => {
    if (windows.modeOf(event.sender) === 'full' && windows.isShown(event.sender)) {
      voc.refreshIfOlder(VOC_VIEW_MAX_AGE_MS);
    }
    return voc.board();
  });

  handle(IPC.refreshVoc, (): Promise<VocBoard> => voc.refresh());

  handle(IPC.getVocTicket, (_event, rawId): Promise<VocTicketDetail> => voc.ticketDetail(requireVocId(rawId, 'ticketId')));

  let directoryForcedAt = 0;
  handle(IPC.getVocDirectory, (): Promise<VocDirectory> => {
    const now = Date.now();
    const force = now - directoryForcedAt >= VOC_DIRECTORY_FORCE_MIN_MS;
    if (force) directoryForcedAt = now;
    return voc.directory(force);
  });

  handle(IPC.getVocSettings, (): VocSettings => deps.vocSettings().get());

  // 검사(팀원 수·주기·jar 경로)는 저장소의 validateVocSettings 가 한다. 팀·시스템이 바뀌었을 수 있으니 보드를 새로 받는다.
  // 기억한 로그인 아이디(loginId)는 로그인 대화상자만 바꾼다 — 설정 대화상자가 보낸 값은 버리고 지금 값을 지킨다(saveFromDialog)
  handle(IPC.saveVocSettings, (_event, raw): VocSettings => {
    const saved = deps.vocSettings().saveFromDialog(raw);
    refreshVocInBackground('설정 저장');
    return saved;
  });

  // 앱 안 로그인(명세 §13): 비밀번호는 VocService 가 voc-cli 표준입력으로만 넘긴다. 로그에는 아이디까지만 남긴다
  // (검사 오류 문장에도 입력 값을 넣지 않는다 — requireVocLoginInput)
  handle(IPC.vocLogin, async (_event, raw): Promise<VocLoginResult> => {
    const input = requireVocLoginInput(raw);
    const result = await voc.login(input);
    console.log(`${LOG} VOC 로그인: ${input.loginId} · ${result.ok ? '성공' : `실패 — ${result.message}`}`);
    return result;
  });

  handle(IPC.vocAction, async (_event, raw): Promise<VocActionResult> => {
    const input = requireVocActionInput(raw);
    try {
      deps.beforeVocAction?.(input);
    } catch (err) {
      console.warn(`${LOG} VOC 처리 전 알림 기록 실패:`, describeError(err));
    }
    const result = await voc.action(input);
    console.log(`${LOG} VOC 처리: ${input.kind} · 티켓 ${input.ticketId} · ${result.ok ? '성공' : `실패 — ${result.message}`}`);
    return result;
  });

  handle(IPC.checkVocText, (_event, raw): string[] => voc.checkText(requireVocText(raw, '글', VOC_CHECK_TEXT_MAX, true)));

  handle(IPC.getVocCreateContext, async (_event, rawId): Promise<VocCreateContext | null> => {
    const taskId = requireString(rawId, 'taskId', MAX_TASK_ID_LENGTH);
    const task = findTask(taskId);
    if (!task?.mail || task.source === 'voc') return null;
    let source: ReplySource | null;
    try {
      source = readSource(task.mail);
    } catch (err) {
      // 원본이 없어도 작성 칸은 연다(제목은 할 일 제목, 내용은 빈 칸 — VocService)
      console.warn(`${LOG} VOC 등록용 원본 메일을 읽지 못함: ${task.mail} · ${describeError(err)}`);
      source = null;
    }
    const existing = task.rawLine !== undefined ? lineFieldValue(task.rawLine, 'voc') : undefined;
    return voc.createContext(task, source, existing);
  });

  // 저장과 같은 직렬 큐 안에서: 티켓 만들기 → 할 일 줄에 [voc:: 번호] → 목록 새로 만들기(명세 §6)
  handle(IPC.createVocTicket, (_event, raw): Promise<VocCreateResult> => {
    const input = requireVocCreateInput(raw);
    return serialSave(async () => {
      const task = findTask(input.taskId);
      if (!task) throw new Error('등록할 할 일을 목록에서 찾지 못했습니다(그사이 위키가 바뀌었을 수 있습니다). 목록을 확인하세요');
      if (!task.mail || task.source === 'voc') throw new Error('메일에서 온 할 일만 VOC 로 등록할 수 있습니다');
      // 이미 등록한 줄에 두 번째 티켓을 만들지 않는다(줄 붙이기는 같은 키를 거부하지만 그때는 티켓이 이미 만들어진 뒤다).
      // 줄 붙이기와 같은 판정(hasLineField — 값이 빈 [voc::]·닫히지 않은 [voc:: 도 있는 것)으로 VocService 를 부르기 전에 막는다
      if (task.rawLine !== undefined && hasLineField(task.rawLine, 'voc')) {
        const existing = lineFieldValue(task.rawLine, 'voc');
        throw new Error(existing ? `이미 VOC 로 등록한 할 일입니다(${existing})` : VOC_LINE_FIELD_BROKEN);
      }

      const lineWarnings: string[] = [];
      const applyLine = (number: string): { ok: true } | { ok: false; error: string } => {
        try {
          refuseIfWikiNone();
          const r = applyLineField({ wikiRoot, today: deps.getToday(), task, key: 'voc', value: number });
          lineWarnings.push(...r.warnings);
          console.log(
            `${LOG} 할 일 줄에 VOC 번호를 붙임: ${task.id} · ${number} · 쓴 파일 ${r.files.length}개` +
              (r.backupDir ? ` · 백업 ${r.backupDir}` : ''),
          );
          return { ok: true };
        } catch (err) {
          return { ok: false, error: describeError(err) };
        }
      };

      const result = await voc.create(input, task, applyLine);
      const warnings = [...result.warnings, ...lineWarnings];
      // 메일함에도 남긴다(2.10단계 §7-2 — 「VOC-… 로 등록함」 배지·같은 스레드 표시)
      const mailEntry = deps.mailbox && result.number ? deps.mailbox.entryOfPath(task.mail) : undefined;
      if (mailEntry && deps.mailbox) {
        try {
          deps.mailbox.markVoc(mailEntry.key, { number: result.number, ticketId: result.ticketId });
        } catch (err) {
          warnings.push(`메일함 상태에 VOC 번호를 적지 못했습니다: ${describeError(err)}`);
        }
      }
      if (result.lineUpdated && !deps.refreshSnapshot()) {
        warnings.push('줄에는 붙였지만 목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
      }
      console.log(
        `${LOG} VOC 등록: ${task.id} → ${result.number} (티켓 ${result.ticketId})` +
          (result.lineError ? ` · 줄 붙이기 실패 — ${result.lineError}` : ''),
      );
      return { ...result, warnings };
    });
  });

  // ---- V4(명세 §14): 첨부·작업시간·해결·완료·재오픈·고객 메일 ----

  handle(IPC.getVocWorkLogs, (_event, rawId): Promise<VocWorkLog[]> => voc.workLogs(requireVocId(rawId, 'ticketId')));

  handle(IPC.getVocEmailLogs, (_event, rawId): Promise<VocEmailLog[]> => voc.emailLogs(requireVocId(rawId, 'ticketId')));

  // 작업시간 넣기는 확인 대화상자 없이(결과 알림 + 기록), 나머지는 확인 대화상자 뒤에만 온다. 메일 주소는 로그에 수만 남긴다
  handle(IPC.vocWork, async (_event, raw): Promise<VocWorkResult> => {
    const input = requireVocWorkInput(raw);
    const result = await voc.work(input);
    console.log(`${LOG} VOC 처리: ${input.kind} · 티켓 ${input.ticketId} · ${result.ok ? '성공' : `실패 — ${result.message}`}`);
    return result;
  });

  handle(IPC.vocFile, (_event, raw): Promise<VocFileResult> => voc.file(requireVocFileInput(raw)));

  // 경로는 renderer 에서 받지 않는다 — main 이 내려받아 확인한 파일만. 열기(기본 프로그램)는 허용 확장자만, 그 밖은 폴더에서 보기
  handle(IPC.openVocFile, async (_event, raw): Promise<void> => {
    const input = requireVocFileOpenInput(raw);
    const abs = voc.fileTarget(input);
    if (input.how === 'reveal') {
      shell.showItemInFolder(abs);
      return;
    }
    const error = await shell.openPath(abs);
    if (error) throw new Error(`첨부를 열지 못했습니다: ${error}`);
  });

  handle(IPC.openVocWeb, async (_event, rawId): Promise<void> => {
    const ticketId = requireVocId(rawId, 'ticketId');
    const raw = voc.webUrl(ticketId);
    if (!raw) throw new Error('VOC 웹 주소를 알 수 없습니다(voc-cli whoami 의 백엔드 줄을 읽지 못함)');
    const url = checkVocWebUrl(raw, ticketId, voc.board().webBase);
    if (!url) throw new Error('VOC 웹 주소가 올바르지 않아 열지 않았습니다');
    try {
      await shell.openExternal(url);
    } catch (err) {
      throw new Error(`VOC 웹을 열지 못했습니다: ${describeError(err)}`);
    }
  });

  // ---- 2.10단계: 메일함(docs/stage2.10-contract.md §11) — raw/ 는 읽기만, 상태는 앱 데이터에만 ----------------------------
  const { mailbox } = deps;
  if (mailbox) {
    handle(IPC.getMailbox, (): MailboxSummary => mailbox.summary());

    handle(IPC.refreshMailbox, (): Promise<MailboxSummary> => mailbox.refresh());

    // 목록은 메일함 화면이 부른다 — 보이는 풀스크린에서 첫 쪽을 부르면 마지막 확인이 60초보다 오래됐을 때 뒤에서 한 번 더 본다(§5-2)
    handle(IPC.listMailThreads, (event, raw): MailThreadPage => {
      const q = requireMailThreadQuery(raw);
      if (q.offset === 0 && windows.modeOf(event.sender) === 'full' && windows.isShown(event.sender)) mailbox.refreshIfOlder();
      return mailbox.list(q);
    });

    handle(IPC.getMailThread, (_event, raw): MailThreadDetail | null => mailbox.thread(requireMailThreadId(raw)));

    handle(IPC.findMailThread, (_event, raw): { threadId: string } | null => mailbox.findThread(requireMailKey(raw)));

    // 경로 검사: normalizeMailPath + _attachments 아님(requireMailPath), 실제 경로가 raw/mail 안·8MB 이하(readMailText)
    handle(IPC.getMailMessage, (_event, raw): MailMessage | null => mailbox.message(requireMailPath(raw)));

    // 로컬 LLM 메일 분석(2.16): 결과는 앱 데이터에만. 메일 키는 색인에 있는 것만
    const analyzer = deps.mailAnalyzer;
    if (analyzer) {
      handle(IPC.getMailAnalysis, (_event, raw): MailAnalysisView => analyzer.view(requireMailKey(raw)));
      handle(IPC.analyzeMail, (_event, raw): Promise<MailAnalysisView> => {
        if (!raw || typeof raw !== 'object') throw new Error('잘못된 요청입니다: 분석 입력이 객체가 아닙니다');
        const input = raw as { key?: unknown; force?: unknown };
        const key = requireMailKey(input.key);
        if (typeof input.force !== 'boolean') throw new Error('잘못된 요청입니다: force 는 참/거짓이어야 합니다');
        if (!mailbox.entryOfKey(key)) throw new Error('메일함 색인에 없는 메일입니다');
        return analyzer.analyze(key, input.force);
      });
    }

    // 원본 보기(2.15): 그 메일이 있는 기준 폴더의 원본 .eml 을 정리한 HTML 로. 외부 그림은 remote 일 때만 main 이 받는다
    handle(IPC.getMailHtml, (_event, raw): Promise<MailHtmlView | null> => {
      if (!raw || typeof raw !== 'object') throw new Error('잘못된 요청입니다: 원본 보기 입력이 객체가 아닙니다');
      const input = raw as { path?: unknown; remote?: unknown };
      const rel = requireMailPath(input.path);
      if (typeof input.remote !== 'boolean') throw new Error('잘못된 요청입니다: remote 는 참/거짓이어야 합니다');
      return buildMailHtml({ base: mailBaseOf(rel), rel, remote: input.remote, ...(deps.fetchMailImage ? { fetchImage: deps.fetchMailImage } : {}) });
    });

    // 위키를 쓰지 않지만 [보낸 뒤 처리함]과 순서가 꼬이지 않게 저장 큐 안에서
    handle(IPC.setMailState, (_event, raw): Promise<MailboxSummary> => {
      const input = requireSetMailStateInput(raw);
      return serialSave(() => {
        const out = mailbox.setState(input.keys, input.change);
        if (out.ignored) console.warn(`${LOG} 메일 상태: 색인에 없는 키 ${out.ignored}개는 무시함`);
        return out;
      });
    });

    // renderer 는 첨부 경로를 보내지 않는다 — 메일을 다시 읽어 index 번째 첨부의 경로를 얻고, 그 파일이 실제로
    // raw/mail/_attachments 안의 파일일 때만 탐색기에서 보인다(열지 않는다 — §6-3)
    handle(IPC.revealMailAttachment, (_event, raw): void => {
      const input = requireRevealInput(raw);
      const base = mailBaseOf(input.path);
      const msg = readMailMessage(base, input.path);
      if (!msg) throw new Error(`메일을 찾지 못했습니다: ${input.path}`);
      const att = msg.attachments[input.index];
      if (!att) throw new Error('그 첨부가 메일에 없습니다');
      if (att.blocked || !att.rel) throw new Error('저장하지 않은 첨부(실행형)라 파일이 없습니다');
      const root = path.resolve(base);
      const attRoot = path.join(root, 'raw', 'mail', '_attachments');
      const abs = path.resolve(root, ...att.rel.split('/'));
      if (!isInsideDir(attRoot, abs)) throw new Error('첨부 경로가 raw/mail/_attachments 밖입니다');
      let real: string;
      try {
        real = fs.realpathSync.native(abs);
        if (!isInsideDir(fs.realpathSync.native(attRoot), real)) throw new Error('outside');
        if (!fs.statSync(real).isFile()) throw new Error('not file');
      } catch {
        throw new Error(`첨부 파일을 찾지 못했습니다: ${att.name}`);
      }
      shell.showItemInFolder(real);
    });

    /** 원본 메일(회신 재료). 없으면 사람 말로 던진다 */
    const requireMailSource = (rel: string): ReplySource => {
      let source: ReplySource | null;
      try {
        source = readSource(rel);
      } catch (err) {
        throw new Error(`원본 메일을 읽지 못했습니다: ${describeError(err)}`);
      }
      if (!source) throw new Error(`원본 메일을 찾지 못했습니다: ${rel}`);
      return source;
    };

    /** 이 메일(또는 같은 스레드의 메일) 경로로 보낸 가장 최근 회신 */
    const lastSentForMail = (rel: string): SentMailRecord | undefined => {
      const entry = mailbox.entryOfPath(rel);
      const paths = entry ? mailbox.threadMailsOf(entry.key).map((e) => e.path) : [];
      if (!paths.includes(rel)) paths.push(rel);
      try {
        return deps.sentLog().lastForMail(paths);
      } catch (err) {
        console.warn(`${LOG} 발송 기록을 읽지 못함:`, describeError(err));
        return undefined;
      }
    };

    handle(IPC.getMailReplyContext, (_event, raw): ReplyContext | null => {
      const rel = requireMailPath(raw);
      let source: ReplySource | null;
      try {
        source = readSource(rel);
      } catch (err) {
        throw new Error(`원본 메일을 읽지 못했습니다: ${describeError(err)}`);
      }
      if (!source) return null;
      const lastSent = lastSentForMail(rel);
      return buildReplyContext({ taskId: '', source, sender: senderInfo(), ...(lastSent ? { lastSent } : {}) });
    });

    // 초안은 읽기 전용이라 저장 큐에 넣지 않는다. 한 번에 하나는 replyDraft.ts 가 지킨다(할 일 회신 초안과 같은 잠금)
    handle(IPC.draftMailReply, async (_event, raw): Promise<ReplyDraft> => {
      const input = requireMailDraftInput(raw);
      const source = requireMailSource(input.path);
      const local = localDraftTarget();
      if (local) {
        const { to } = buildReplyContext({ taskId: '', source, sender: senderInfo() });
        const messages = buildLocalDraftMessages({ kind: 'mail', note: input.note, ...(input.hint !== undefined ? { hint: input.hint } : {}), source, to });
        console.log(`${LOG} 메일함 회신 초안 시작(로컬 LLM): ${input.path} · ${local.model}`);
        const draft = await runLocalDraft({ target: local, messages, env, secrets: secretsKnown() });
        if (containsSecret(secretsKnown(), [draft.body, draft.notes])) {
          console.warn(`${LOG} 메일함 회신 초안 버림: ${input.path} · 비밀번호·키와 같은 글이 들어 있음`);
          throw new Error(SECRET_IN_DRAFT_PROBLEM);
        }
        console.log(`${LOG} 메일함 회신 초안 끝(로컬 LLM): ${Math.round(draft.durationMs / 1000)}초`);
        return draft;
      }
      if (!fs.existsSync(wikiRoot)) throw new Error(`위키 폴더를 찾을 수 없습니다: ${wikiRoot}`);
      const claude = deps.getClaudePath();
      if (!claude.exists) {
        throw new Error(`claude 실행 파일을 찾을 수 없습니다: ${claude.path} (환경 변수 WIKI_RADAR_CLAUDE 로 위치를 정할 수 있습니다)`);
      }
      const { to } = buildReplyContext({ taskId: '', source, sender: senderInfo() });
      const prompt = buildMailDraftPrompt({
        note: input.note,
        ...(input.hint !== undefined ? { hint: input.hint } : {}),
        source,
        to,
      });
      console.log(`${LOG} 메일함 회신 초안 시작: ${input.path} · claude ${claude.path} (${claude.source})`);
      let draft: ReplyDraft;
      try {
        draft = await runReplyDraft({ wikiRoot, claudePath: claude.path, prompt, ...(source.base ? { extraDirs: [source.base] } : {}) });
        deps.onClaudeRun?.('메일함 회신 초안', true);
      } catch (err) {
        deps.onClaudeRun?.('메일함 회신 초안', false, describeError(err));
        throw err;
      }
      if (containsSecret(secretsKnown(), [draft.body, draft.notes])) {
        console.warn(`${LOG} 메일함 회신 초안 버림: ${input.path} · 계정 비밀번호와 같은 글이 들어 있음`);
        throw new Error(SECRET_IN_DRAFT_PROBLEM);
      }
      console.log(`${LOG} 메일함 회신 초안 끝: ${Math.round(draft.durationMs / 1000)}초 · 참고 문서 ${draft.references.length}건`);
      return draft;
    });

    const mailReplyDeps: SendMailReplyDeps = {
      readSource,
      loadAccount,
      settings: () => deps.mailSettings().get(),
      sentLog: () => deps.sentLog(),
      compose: composeMessage,
      send: (account, msg) => sendRawMessage(account, msg, env),
      now: () => new Date(),
      knownSecrets: secretsKnown,
      ...(deps.saveSentMail ? { saveSentMail: deps.saveSentMail } : {}),
      // 보낸 뒤: 그 메일의 회신 필요를 지우고, 고르면 스레드를 처리함으로(§7-1)
      afterSend: (mail, archive) => {
        const entry = mailbox.entryOfPath(mail);
        if (!entry) throw new Error('메일함 색인에 없는 메일입니다');
        mailbox.setState([entry.key], { replyNeeded: false });
        if (archive) mailbox.setState(mailbox.threadMailsOf(entry.key).map((e) => e.key), { archived: true });
      },
    };

    // 저장과 같은 직렬 큐 안에서: 보낸다 → 발송 기록 → 메일 상태(위키에는 쓰지 않는다)
    handle(IPC.sendMailReply, (_event, raw): Promise<SendMailReplyOutput> => {
      const input = requireSendMailReplyInput(raw);
      return serialSave(async () => {
        const output = await sendMailReplyFlow(mailReplyDeps, input);
        console.log(
          `${LOG} 메일함 회신 발송: 받는사람 ${input.to.length}명 · 참조 ${input.cc.length}명 · 숨은참조 ${output.sent.bcc.length}명` +
            (input.archiveAfter ? ' · 처리함으로' : ''),
        );
        for (const w of output.warnings) console.warn(`${LOG} ${w}`);
        mailbox.relink();
        return output;
      });
    });

    /** 이 메일 경로를 task.mail 로 가진 열린 할 일(VOC·팀 할 일 제외) */
    const tasksForMail = (rel: string): Task[] => {
      let tasks: Task[];
      try {
        tasks = snapshots.current().tasks;
      } catch {
        return [];
      }
      const key = mailbox.entryOfPath(rel)?.key;
      return tasks.filter((t) => (t.mail === rel || (key !== undefined && t.mail === key)) && t.source !== 'voc' && t.source !== 'team');
    };

    /** 메일함 이름 → 고객사 기본값의 이름(`_`로 시작하는 메일함·내 메모는 비움 — §7-2) */
    const companyOfFolder = (folder: string | undefined): string | undefined =>
      folder && !folder.startsWith('_') && folder !== MEMO_FOLDER ? folder : undefined;

    handle(IPC.getMailVocCreateContext, async (_event, raw): Promise<MailVocCreateContext | null> => {
      const rel = requireMailPath(raw);
      let source: ReplySource | null;
      try {
        source = readSource(rel);
      } catch (err) {
        console.warn(`${LOG} VOC 등록용 원본 메일을 읽지 못함: ${rel} · ${describeError(err)}`);
        source = null;
      }
      if (!source) return null;
      const entry = mailbox.entryOfPath(rel);
      const threadVoc: string[] = [];
      if (entry) {
        for (const e of mailbox.threadMailsOf(entry.key)) {
          const n = e.key !== entry.key ? mailbox.markOf(e.key)?.voc?.number : undefined;
          if (n && !threadVoc.includes(n)) threadVoc.push(n);
        }
      }
      const linked = tasksForMail(rel);
      let out: MailVocCreateContext;
      if (linked.length === 1) {
        // 연결된 할 일 하나 — 기존 V3b(할 일 줄에 [voc:: 번호]). 화면은 createVocTicket 으로 보낸다
        const task = linked[0];
        const existing = task.rawLine !== undefined ? lineFieldValue(task.rawLine, 'voc') : undefined;
        const { taskId, ...ctx } = await voc.createContext(task, source, existing);
        out = { ...ctx, mail: rel, taskId };
      } else {
        const existing = entry ? mailbox.markOf(entry.key)?.voc?.number : undefined;
        const ctx = await voc.createContextForMail(source, companyOfFolder(entry?.folder ?? source.rel.split('/')[2]), existing);
        out = { ...ctx, mail: rel };
      }
      if (threadVoc.length > 0) out.threadVoc = threadVoc;
      return out;
    });

    // 저장과 같은 직렬 큐 안에서: 티켓 만들기 → 메일 상태(mark.voc). 위키에는 쓰지 않는다
    handle(IPC.createMailVocTicket, (_event, raw): Promise<VocCreateResult> => {
      const input = requireMailVocCreateInput(raw);
      return serialSave(async () => {
        const entry = mailbox.entryOfPath(input.path);
        if (!entry) throw new Error('메일함 색인에 없는 메일입니다 — 잠시 뒤 다시 하세요');
        const existing = mailbox.markOf(entry.key)?.voc?.number;
        if (existing) throw new Error(`이미 VOC 로 등록한 메일입니다(${existing})`);
        const linked = tasksForMail(input.path);
        if (linked.length === 1) {
          throw new Error('이 메일은 할 일 하나와 연결돼 있어 할 일 쪽 등록(할 일 줄에 [voc:: 번호])으로 합니다 — 화면을 다시 여세요');
        }
        const result = await voc.createForMail(input, (made) => {
          try {
            mailbox.markVoc(entry.key, made);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: describeError(err) };
          }
        });
        console.log(`${LOG} 메일 → VOC 등록: ${input.path} → ${result.number} (티켓 ${result.ticketId})`);
        return result;
      });
    });

    // 2.14: [위키에 반영] — 저장과 같은 직렬 큐 안에서 반영 대기열에 kind mail 항목 하나(위키에는 쓰지 않는다).
    // 경로는 받지 않는다 — 키로 찾는다. 피싱 의심은 여기서도 막는다. 오류 문장에 본문을 넣지 않는다
    handle(IPC.queueMailForWiki, (_event, raw): Promise<QueueMailResult> => {
      refuseIfWikiNone();
      const input = requireQueueMailInput(raw);
      return serialSave(() => {
        const out = queueMailForWiki(input, {
          mailbox,
          queue: deps.queue(),
          claudeAvailable: () => deps.getClaudePath().exists,
          runningIds: () => deps.reflect.runningIds(),
        });
        if (out.status === 'queued') {
          console.log(`${LOG} 메일 → 위키 반영 대기: ${out.item.mail ?? input.key} · 범위 ${input.scope}${input.replace ? ' · 바꿈' : ''}`);
          deps.reflect.publishQueue();
        } else {
          console.log(`${LOG} 메일 → 위키 반영 대기: 이미 대기 중(${out.existing.id})`);
        }
        return out;
      });
    });

    // 저장과 같은 직렬 큐 안에서: 내 할 일.md 「메일 회신 대기」 절 끝에 줄 하나 → mark.task → 목록 새로 만들기(§7-3)
    handle(IPC.createMailTask, (_event, raw): Promise<CreateMailTaskOutput> => {
      refuseIfWikiNone();
      const input = requireCreateMailTaskInput(raw);
      return serialSave(() => {
        if (!fs.existsSync(wikiRoot)) throw new Error('개인 위키가 없어 할 일을 넣을 수 없습니다');
        const entry = mailbox.entryOfPath(input.path);
        if (!entry) throw new Error('메일함 색인에 없는 메일입니다 — 잠시 뒤 다시 하세요');
        const day = entry.date?.slice(0, 10);
        const opened = day && isValidYmd(day) ? day : deps.getToday();
        let result: ReturnType<typeof appendTaskLine>;
        try {
          result = appendTaskLine({
            wikiRoot,
            title: input.title,
            ...(input.pri !== undefined ? { pri: input.pri } : {}),
            ...(input.due !== undefined ? { due: input.due } : {}),
            // 2.15: 메일 ID 로 잇는다(파일 이름의 대괄호로 필드가 잘리지 않게). 같은 메일 찾기는 옛 경로도 본다
            mail: entry.key,
            altMail: entry.path,
            thread: entry.threadKey,
            opened,
          });
        } catch (err) {
          throw new Error(describeError(err));
        }
        const file = result.files[0] ?? MAIL_TASK_FILE;
        noteOwnWrite(result.files.length > 0 ? result.files : [file]);
        console.log(`${LOG} 메일 → 할 일: ${entry.path} · ${file}` + (result.backupDir ? ` · 백업 ${result.backupDir}` : ''));
        const warnings = [...result.warnings];
        try {
          mailbox.markTask(entry.key, file);
        } catch (err) {
          warnings.push(`할 일은 넣었지만 메일 상태에 적지 못했습니다: ${describeError(err)}`);
        }
        if (!deps.refreshSnapshot()) warnings.push('할 일은 넣었지만 목록을 새로 만들지 못했습니다 — 잠시 뒤 다시 읽습니다');
        const out: CreateMailTaskOutput = { file, line: result.line, warnings };
        if (result.backupDir) out.backupDir = result.backupDir;
        return out;
      });
    });
  }

  // ---- 3a단계: 위키 검색·미리보기·변경 피드(docs/stage3a-contract.md §11) — 위키는 읽기만, 기록은 앱 데이터에만 ----------------
  const { wikiDocs } = deps;
  if (wikiDocs) {
    handle(IPC.getWikiDocs, (): WikiDocsSummary => wikiDocs.summary());

    handle(IPC.refreshWikiDocs, (): Promise<WikiDocsSummary> => wikiDocs.refreshAll());

    // 보이는 풀스크린에서 첫 쪽을 부르면 마지막 확인이 60초보다 오래됐을 때 뒤에서 한 번 더 본다(§3-1)
    handle(IPC.searchWiki, (event, raw): WikiSearchPage => {
      const q = requireSearchQuery(raw);
      if (q.offset === 0 && windows.modeOf(event.sender) === 'full' && windows.isShown(event.sender)) wikiDocs.refreshIfOlder();
      return wikiDocs.search(q);
    });

    handle(IPC.recentWikiDocs, (event, raw): WikiDocRef[] => {
      const q = requireRecentInput(raw);
      if (windows.modeOf(event.sender) === 'full' && windows.isShown(event.sender)) wikiDocs.refreshIfOlder();
      return wikiDocs.recent(q.source, q.limit);
    });

    handle(IPC.getWikiPage, (_event, raw): Promise<WikiPage | null> => {
      const input = requireWikiDocInput(raw);
      return wikiDocs.page(input.source, input.path);
    });

    handle(IPC.getWikiImage, (_event, raw): Promise<WikiImageResult> => {
      const input = requireImageInput(raw);
      return wikiDocs.image(input.source, input.page, input.ref);
    });

    handle(IPC.getWikiChanges, (event, raw): WikiChangesPage => {
      const q = requireChangesInput(raw);
      if (q.offset === 0 && windows.modeOf(event.sender) === 'full' && windows.isShown(event.sender)) wikiDocs.refreshIfOlder();
      return wikiDocs.changes(q);
    });

    handle(IPC.getWikiLogRecent, (): WikiLogEntry[] => wikiDocs.logRecent());

    handle(IPC.markWikiSeen, (_event, raw): MarkWikiSeenOutput => wikiDocs.markSeen(requireMarkSeenInput(raw)));

    handle(IPC.undoWikiSeen, (_event, raw): WikiDocsSummary => wikiDocs.undoSeen(requireUndoToken(raw)));
  }

  // 외부 링크(§7-3): 확인 대화상자 뒤에만 부른다. http·https 만, 사용자 정보·제어 문자·공백 없는 주소
  handle(IPC.openExternalLink, async (_event, raw): Promise<void> => {
    const url = requireExternalUrl(raw);
    try {
      await openExternal(url, 'external');
    } catch (err) {
      throw new Error(`브라우저를 열지 못했습니다: ${describeError(err)}`);
    }
  });
}

/**
 * Claude 가 건너뛰었다고 보고한 항목 id(2.14 — 같은 스레드의 mail 항목은 제목이 같을 수 있다).
 * 보고에 이번 실행 항목 id 가 있으면 id 로만 맞춘다. id 가 없거나 모르는 id 면 제목으로 맞추되,
 * 그 제목인 항목이 이번 실행에 하나뿐일 때만 — 여럿이면 어느 것인지 알 수 없어 건너뜀으로 보지 않는다.
 */
export function skippedItemIds(skipped: readonly { id?: string; title: string }[], sentItems: readonly Pick<QueueItem, 'id' | 'title'>[]): Set<string> {
  const sentIds = new Set(sentItems.map((i) => i.id));
  const byTitle = new Map<string, string[]>();
  for (const i of sentItems) byTitle.set(i.title, [...(byTitle.get(i.title) ?? []), i.id]);
  const out = new Set<string>();
  for (const s of skipped) {
    if (s.id !== undefined && sentIds.has(s.id)) {
      out.add(s.id);
      continue;
    }
    const ids = byTitle.get(s.title) ?? [];
    if (ids.length === 1) out.add(ids[0]!);
  }
  return out;
}
