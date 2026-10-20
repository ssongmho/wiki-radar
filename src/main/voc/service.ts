// VOC 서비스 — 받기(폴링)·보드 상태·캐시·쓰기 흐름(docs/stage2.6-contract.md §2-3·§4·§5·§6).
// electron 을 import 하지 않는 순수 모듈이다. voc-cli 는 주입받은 runner 로만 부른다(직렬 큐·허용 목록·가드·시간 초과는
// runner 가 한다). 보드·VOC 할 일·사람 목록은 메모리에만 두고, 쓰기 기록만 VocActionLog(앱 데이터 폴더)에 남긴다.
// 위키에는 쓰지 않는다 — 등록 뒤 할 일 줄의 [voc:: ] 는 부르는 쪽이 준 applyLine 이 쓴다.
import type {
  MailVocCreateInput,
  Holiday,
  Task,
  VocActionExpected,
  VocActionInput,
  VocActionKind,
  VocActionResult,
  VocAttachment,
  VocBoard,
  VocBoardState,
  VocCode,
  VocCreateContext,
  VocCreateInput,
  VocCreateResult,
  VocCustomer,
  VocDirectory,
  VocEmailLog,
  VocFileInput,
  VocFileOpenInput,
  VocFileResult,
  VocLoginInput,
  VocLoginResult,
  VocMember,
  VocSettings,
  VocTicket,
  VocTicketDetail,
  VocWorkInput,
  VocWorkKind,
  VocWorkLog,
  VocWorkResult,
} from '../../shared/types';
import { addressOf, isValidAddress, stripReplyPrefixes } from '../../shared/reply';
import {
  VOC_CREATE_ID_USED,
  VOC_LINE_FIELD_BROKEN,
  VOC_LOGIN_FAIL_LIMIT,
  VOC_LOGIN_LOCK_MS,
  VOC_LOGIN_LOCK_NOTE,
  VOC_LOGIN_TIMEOUT_MS,
  VOC_SERVER_LOGIN_FAIL_LIMIT,
  VOC_DOWNLOAD_MAX_BYTES,
  VOC_WORKLOG_NOTE_MAX,
  isVocLoginId,
  vocCanOpenFile,
  vocFileKind,
  vocHoursProblem,
  vocHoursText,
  vocLoginIdProblem,
  vocPasswordProblem,
} from '../../shared/voc';
import { VOC_REPLY_HTML_MAX, vocHtmlLength, vocTextToHtml } from '../../shared/vocHtml';
import type { ReplySource } from '../mail/replyContext';
import { isValidYmd } from '../wiki/calendar';
import { codePointLength, codePointSlice } from '../wiki/checkbox';
import { hasLineField, lineFieldValue } from '../wiki/writeback';
import { nonCp949Chars } from './charset';
import { parseVocExpected, requireVocWorkInput } from './ipcInput';
import {
  checkDownloaded,
  checkOpenable,
  imageDataUrl,
  markFromInternet,
  parseDownloadOutput,
  ticketFilesDir,
  type VocDownloadedFile,
} from './files';
import {
  VOC_DOWNLOAD_TIMEOUT_MS,
  VOC_LOGIN_COMMAND,
  VOC_READ_TIMEOUT_MS,
  VOC_UNAVAILABLE_MESSAGE,
  VOC_WRITE_TIMEOUT_MS,
  classifyVocFailure,
  vocDownloadArgs,
  vocLoginArgs,
  type VocCliRunner,
  type VocFailure,
  type VocRunResult,
} from './cli';
import {
  buildBoard,
  findMe,
  parseCodes,
  parseCustomers,
  parseEmailLogs,
  parseWorkLogs,
  parseTicketDetail,
  parseTicketList,
  parseUsers,
  parseWhoami,
  resolveTeam,
  systemsOf,
  toVocTicket,
  vocTasksOf,
  webBaseOf,
  type VocPageMaps,
} from './model';
import { DEFAULT_VOC_SETTINGS, type VocActionLog, type VocActionRecord, type VocSettingsStore } from './settings';

export interface VocServiceDeps {
  runner: Pick<VocCliRunner, 'run'>;
  /**
   * 로그인이 필요할 때 '터미널에서 하려면' voc-cli 명령도 안내하는가. voc-cli(jar·가짜)를 띄울 때만 true —
   * 앱이 VOC API 를 직접 부를 때(api.ts)는 앱 안 로그인만 있다(명세 §15). 기본 true
   */
  terminalLogin?: boolean;
  settings: () => VocSettingsStore;
  actions: () => VocActionLog;
  /** 오늘(로컬 YYYY-MM-DD) */
  today: () => string;
  holidays: readonly Holiday[];
  /** 고객사·시스템 이름 → 위키 페이지(받을 때마다 새로 부른다) */
  pageMaps: () => VocPageMaps;
  /** 나 찾기 보조(2.5단계 SMTP 계정 주소) */
  fallbackEmail?: () => string | undefined;
  now?: () => Date;
  /** 보드가 바뀔 때(방송 + 스냅샷의 VOC 할 일 교체) */
  onBoard: (board: VocBoard, tasks: Task[]) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** 첨부를 받을 폴더의 뿌리(앱 데이터 폴더의 voc-files — runner 의 downloadRoot 와 같다). 없으면 첨부를 받지 않는다(명세 §14) */
  filesDir?: string;
}

/** 앱 시작 뒤 첫 받기까지(명세 §2-3) */
export const VOC_START_DELAY_MS = 5_000;
/** 받는 주기 기본값·범위(분) — 설정이 틀려도 이 안으로 */
const POLL_DEFAULT_MINUTES = 10;
const POLL_MIN_MINUTES = 5;
const POLL_MAX_MINUTES = 60;
/** 진행 중 목록(명세 §2-1). 페이지는 --page N 으로 이어 받는다 */
export const VOC_LIST_ARGS: readonly string[] = ['ticket', 'list', '--hide-completed', '--size', '2000', '--json'];
/** 이어 받는 페이지 상한(2000건 × 20) — 서버가 이상한 totalPages 를 줘도 끝없이 부르지 않게 */
const LIST_MAX_PAGES = 20;
const USERS_ARGS: readonly string[] = ['user', 'list', '--role', 'staff,admin', '--json'];
// 시스템 선택지는 `code list SYSTEM` 으로 받지 않는다 — 운영 VOC 에서 그 그룹은 꺼져 늘 빈 배열이다(model.ts systemsOf).
// 받은 진행 중 티켓의 시스템 + 설정의 팀 시스템으로 만든다
const REQUEST_TYPE_CODES_ARGS: readonly string[] = ['code', 'list', 'REQUEST_TYPE', '--json'];
const CUSTOMERS_ARGS: readonly string[] = ['customer', 'list', '--json'];

/** 한도(명세 §5·§6) */
export const VOC_REPLY_MAX_CHARS = 5_000;
export const VOC_TITLE_MAX_CHARS = 500;
export const VOC_DESCRIPTION_MAX_CHARS = 10_000;
/** 등록 기본 내용에 넣는 원본 메일 본문 앞부분(글자) */
export const VOC_CREATE_MAIL_BODY_CHARS = 8_000;
/** 등록 기본값(명세 §6) */
export const VOC_DEFAULT_REQUEST_TYPE = 'inquiry';
export const VOC_DEFAULT_PRIORITY = 'P3';
/** 할 일 줄에 남기는 필드 이름(명세 §6) */
export const VOC_LINE_FIELD = 'voc';

/** actionId·createId: 영문·숫자·하이픈 8~64자(UUID) */
const OP_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const USER_ID_RE = /^[1-9][0-9]{0,15}$/;
const PRIORITIES: ReadonlySet<string> = new Set(['P1', 'P2', 'P3']);
const ACTION_KINDS: ReadonlySet<string> = new Set<VocActionKind>(['assign', 'ictDue', 'priority', 'status', 'reply']);
/** V3a 에서 바꿀 수 있는 상태(해결·완료는 VOC 웹에서 — 명세 §5) */
const STATUS_LABELS: Readonly<Record<string, string>> = { in_progress: '진행 중', pending: '보류' };
/** 결과 문장에 쓰는 지금 상태 이름(모르는 값은 원문) */
const STATUS_NAMES: Readonly<Record<string, string>> = {
  new: '신규',
  assigned: '배정됨',
  in_progress: '진행 중',
  pending: '보류',
  resolved: '해결',
  closed: '완료',
  withdrawn: '철회',
};
/** --hide-completed 가 빼는 상태 — 쓰기 결과가 이 상태면 보드에서 뺀다 */
const DONE_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed', 'withdrawn']);
/** 시스템·요청유형 코드. 영문·숫자로 시작(‘-’ 로 시작하면 voc-cli 가 옵션으로 읽는다) */
const CODE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** 할 일 줄에 적을 수 있는 번호 모양(VOC-2026-0012) */
const TICKET_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 줄바꿈·탭 밖의 제어 문자 */
const CONTROL_EXCEPT_LINES_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const CONTROL_EXCEPT_LINES_GLOBAL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** 모든 제어 문자(한 줄 값) */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 쓰기가 서버에 닿았는데 결과를 모를 때(시간 초과 등) 덧붙이는 말 */
const UNSURE_NOTE = '반영됐는지 VOC 에서 확인하세요';

type WhoamiInfo = ReturnType<typeof parseWhoami>;

/** 사람 목록(하루 캐시) — whoami + user list */
interface People {
  day: string;
  users: VocMember[];
  whoami: WhoamiInfo;
  webBase?: string;
}

/** 요청유형 코드·고객사(하루 캐시) */
interface Codes {
  day: string;
  requestTypes: VocCode[];
  customers: VocCustomer[];
}

/** 실패 판정을 싣고 던지는 오류(이 모듈 안에서만) */
class VocFailureError extends Error {
  readonly failure: VocFailure;

  constructor(failure: VocFailure) {
    super(failure.message);
    this.name = 'VocFailureError';
    this.failure = failure;
  }
}

/** 한 번 실행의 결과 */
type ExecResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      failure: VocFailure;
      /** voc-cli 가 떠서 요청이 서버에 닿았을 수 있는가(false = 실행 전 거부·로그인 필요·위치 없음) */
      reached: boolean;
      /** 서버에 닿았는데 결과를 모른다(시간 초과·요청 실패·5xx) */
      unsure: boolean;
    };

/** 쓰기 한 건의 계획 */
interface WritePlan {
  args: string[];
  /** 기록(voc-actions.json)의 detail */
  detail: string;
  /** 성공 문장 */
  done: string;
  /** --json 결과(TicketDto)로 그 티켓을 바로 고칠 수 있는가 */
  json: boolean;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function emptyTotals(): VocBoard['totals'] {
  return { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 };
}

function isPositiveId(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** 이름 비교용: 공백을 모두 빼고 소문자로 */
function nameKey(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 한 줄로 편다(제어 문자 → 공백, 공백 여럿 → 하나) */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 기록·문장에 넣을 짧은 표시 */
function shortText(s: string, max = 60): string {
  const flat = oneLine(s);
  return codePointLength(flat) > max ? `${codePointSlice(flat, max)}…` : flat;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 날짜 문자열 → 로컬 YYYY-MM-DD. 읽히지 않으면 적힌 그대로(한 줄) */
function localDateOf(date: string | undefined): string {
  if (!date) return '';
  const t = Date.parse(date);
  if (Number.isNaN(t)) return shortText(date, 40);
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 'M/D' */
function monthDay(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 쓰기 입력(vocAction) 모양 검사 — 틀리면 던진다(ipc 가 먼저 보지만 서비스도 다시 본다) */
function checkActionShape(input: unknown): VocActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('잘못된 요청입니다: VOC 처리 입력이 객체가 아닙니다');
  const r = input as Record<string, unknown>;
  if (typeof r.actionId !== 'string' || !OP_ID_RE.test(r.actionId)) {
    throw new Error('잘못된 요청입니다: actionId 는 영문·숫자·하이픈 8~64자여야 합니다');
  }
  if (typeof r.kind !== 'string' || !ACTION_KINDS.has(r.kind)) throw new Error(`잘못된 요청입니다: 알 수 없는 동작 ${String(r.kind)}`);
  if (!isPositiveId(r.ticketId)) throw new Error('잘못된 요청입니다: ticketId 는 양의 정수여야 합니다');
  if (typeof r.value !== 'string') throw new Error('잘못된 요청입니다: 값이 문자열이 아닙니다');
  const limit = r.kind === 'reply' ? VOC_REPLY_MAX_CHARS * 2 : 64;
  if (r.value.length > limit) throw new Error('잘못된 요청입니다: 값이 너무 깁니다');
  const out: VocActionInput = { actionId: r.actionId, kind: r.kind as VocActionKind, ticketId: r.ticketId, value: r.value };
  const expected = parseVocExpected(r.expected);
  if (expected) out.expected = expected;
  return out;
}

/** 쓰기 직전 VOC 에서 다시 읽은 값과 비교할 필드: 그 동작이 바꾸거나 확인 대화상자가 알린 것(답변은 덮어쓰는 값이 없다) */
const EXPECT_FIELDS: Readonly<Record<VocActionKind, readonly (keyof VocActionExpected)[]>> = {
  assign: ['assigneeId', 'status'],
  ictDue: ['ictDue'],
  priority: ['priority'],
  status: ['status'],
  reply: [],
};

/** 티켓의 비교 값(없으면 null) */
function fieldOf(t: VocTicket, key: keyof VocActionExpected): string | number | null {
  switch (key) {
    case 'status':
      return t.status !== '' ? t.status : null;
    case 'assigneeId':
      return t.assigneeId ?? null;
    case 'priority':
      return t.priority ?? null;
    case 'ictDue':
      return t.ictDue ?? null;
  }
}

/** 상태 이름(모르는 값은 원문, 없으면 '없음') */
function statusName(status: string | number | null): string {
  if (status === null || status === '') return '없음';
  const s = String(status);
  return Object.hasOwn(STATUS_NAMES, s) ? STATUS_NAMES[s] : s;
}

/**
 * VOC 보드·쓰기. main 이 하나 만들어 IPC 에 잇는다.
 * - 받기: start() 5초 뒤 첫 받기, 그 뒤 설정 pollMinutes 마다. 받기가 끝날 때마다(새로고침·쓰기 뒤 포함) 주기를 다시 잰다.
 *   로그인 필요(login)면 폴링을 멈추고 사람이 [다시 확인](refresh)할 때까지 부르지 않는다.
 * - 쓰기: 확인 대화상자 뒤에만 불린다. 같은 actionId·createId 는 두 번 실행하지 않고, 같은 티켓의 동작이 실행 중이면 막는다.
 */
export class VocService {
  private readonly deps: VocServiceDeps;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  private current: VocBoard = { state: 'loading', lanes: [], totals: emptyTotals() };
  /** 마지막으로 받은 진행 중 티켓 전부(팀 밖 포함 — 등록 기본값의 시스템 고르기에도 쓴다) */
  private tickets: VocTicket[] = [];
  /** 목록을 한 번이라도 받았는가 */
  private haveList = false;
  private fetchedAt: string | undefined;
  /** 마지막 보드의 내 담당 VOC 할 일 */
  private lastTasks: Task[] = [];

  private people: People | undefined;
  private peopleJob: Promise<People> | undefined;
  private codes: Codes | undefined;
  private codesJob: Promise<Codes> | undefined;
  /**
   * 하루 캐시(people·codes)의 세대. 로그인하면 올린다 — 다른 아이디·다른 VOC 서버(설정 주소를 바꿈)로 들어왔을 수 있어
   * 그 전에 시작한 받기가 끝나도 옛 서버의 사람·고객사·요청유형을 캐시에 넣지 않는다
   */
  private cacheGen = 0;

  private job: Promise<VocBoard> | undefined;
  /** 받는 중에 쓰기가 성공했다 — 끝나면 한 번 더 받는다(받는 중이던 목록은 쓰기 전 것일 수 있다) */
  private again = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 마지막 받기가 끝난 시각(ms) */
  private lastAttemptAt: number | undefined;

  /** 실행 중인 actionId·createId */
  private readonly running = new Set<string>();
  /** 동작이 실행 중인 티켓 */
  private readonly busyTickets = new Set<number>();
  /** VOC 등록이 실행 중인 할 일 */
  private readonly creatingTasks = new Set<string>();

  /** 앱 안 로그인(명세 §13): 실행 중인가 */
  private loginRunning = false;
  /**
   * 아이디별 연속 실패(서버 LoginAttemptService 처럼 아이디 글자 그대로 — 명세 §12-9). 성공하면 지운다. 없으면 0번
   * (이 실행 동안만 — 앱을 다시 띄우면 처음부터지만 서버 셈은 남아 있을 수 있다)
   */
  private readonly loginAttempts = new Map<string, LoginAttempts>();
  /** 이번 실행에서 '아이디 기억'을 끄고 로그인했다 — whoami 의 로그인 ID 도 로그인 창 기본값으로 쓰지 않는다 */
  private forgetLoginId = false;

  constructor(deps: VocServiceDeps) {
    this.deps = deps;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  // ---- 받기·상태 ------------------------------------------------------------------------------

  /** 폴링 시작: 5초 뒤 첫 받기 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm(VOC_START_DELAY_MS);
  }

  /** 폴링 멈춤(실행 중인 voc-cli 는 runner.stopAll 이 끝낸다) */
  stop(): void {
    this.started = false;
    this.disarm();
  }

  board(): VocBoard {
    return this.current;
  }

  /** 마지막 보드의 내 담당 VOC 할 일(받지 못한 동안은 마지막으로 받은 것) */
  tasks(): Task[] {
    return this.lastTasks;
  }

  /** 지금 목록을 새로 받는다. 받는 중이면 그 약속을 돌려준다. 실패는 보드 상태로 돌려준다(거부하지 않는다) */
  refresh(): Promise<VocBoard> {
    if (this.job) return this.job;
    const job = this.doRefresh().finally(() => {
      this.job = undefined;
      this.lastAttemptAt = this.nowMs();
      this.reschedule();
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    this.job = job;
    return job;
  }

  /** VOC 화면을 열 때: 마지막 받기가 maxAgeMs 보다 오래됐으면 받는다(로그인 필요 상태면 부르지 않는다) */
  refreshIfOlder(maxAgeMs: number): void {
    if (this.job || this.current.state === 'login') return;
    const last = this.lastAttemptAt;
    if (last !== undefined && this.nowMs() - last <= maxAgeMs) return;
    void this.refresh();
  }

  /** 컴퓨터가 잠들었다 깼을 때 한 번(폴링 중일 때만, 로그인 필요 상태면 부르지 않는다) */
  onResume(): void {
    if (!this.started || this.current.state === 'login') return;
    void this.refresh();
  }

  private nowDate(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private nowMs(): number {
    return this.nowDate().getTime();
  }

  private settingsNow(): VocSettings {
    try {
      return this.deps.settings().get();
    } catch {
      return DEFAULT_VOC_SETTINGS;
    }
  }

  private pageMapsNow(): VocPageMaps | undefined {
    try {
      return this.deps.pageMaps();
    } catch {
      return undefined;
    }
  }

  private pollMs(): number {
    const m = this.settingsNow().pollMinutes;
    const minutes = typeof m === 'number' && Number.isFinite(m) ? Math.min(POLL_MAX_MINUTES, Math.max(POLL_MIN_MINUTES, m)) : POLL_DEFAULT_MINUTES;
    return minutes * 60_000;
  }

  private arm(ms: number): void {
    this.disarm();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.refresh();
    }, ms);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /** 다음 받기를 주기 뒤로. 로그인 필요면 멈춘다 */
  private reschedule(): void {
    if (!this.started || this.current.state === 'login') {
      this.disarm();
      return;
    }
    this.arm(this.pollMs());
  }

  private emit(): void {
    try {
      this.deps.onBoard(this.current, this.lastTasks);
    } catch {
      // 방송 쪽 오류는 받기를 멈추지 않는다
    }
  }

  /** 쓰기 성공 뒤: 받는 중이면 끝난 뒤 한 번 더, 아니면 지금 */
  private refreshSoon(): void {
    if (this.job) this.again = true;
    else void this.refresh();
  }

  private async doRefresh(): Promise<VocBoard> {
    try {
      const today = this.deps.today();
      await this.loadPeople(false);
      const tickets = await this.fetchTickets(today);
      this.tickets = tickets;
      this.haveList = true;
      this.fetchedAt = this.nowDate().toISOString();
      this.rebuild('ok', today);
    } catch (err) {
      this.applyFailure(failureOf(err));
    }
    this.emit();
    return this.current;
  }

  /** 진행 중 목록 전부(페이지 이어 받기, 같은 id 는 한 번) */
  private async fetchTickets(today: string): Promise<VocTicket[]> {
    const maps = this.pageMapsNow();
    const first = await this.readParsed([...VOC_LIST_ARGS], parseTicketList, 'ticket list');
    const data: unknown[] = [...first.data];
    const lastPage = Math.min(Number.isFinite(first.totalPages) ? first.totalPages : 1, LIST_MAX_PAGES);
    for (let page = Math.max(1, first.page || 1) + 1; page <= lastPage; page++) {
      const next = await this.readParsed([...VOC_LIST_ARGS, '--page', String(page)], parseTicketList, 'ticket list');
      data.push(...next.data);
    }
    const seen = new Set<number>();
    const out: VocTicket[] = [];
    for (const dto of data) {
      const t = toVocTicket(dto, today, this.deps.holidays, maps);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }

  /** 나·팀을 다시 정하고 보드·VOC 할 일을 새로 만든다. state 가 없으면 지금 상태(문장 포함)를 그대로 둔다 */
  private rebuild(state: VocBoardState | undefined, today: string): void {
    const settings = this.settingsNow();
    const users = this.people?.users ?? [];
    const me = findMe(users, settings, this.people?.whoami.email, this.fallbackEmail());
    const team = resolveTeam(users, settings, me);
    const { lanes, totals } = buildBoard({ tickets: this.tickets, team, me, settings });
    this.lastTasks = vocTasksOf(this.tickets, me, today, this.deps.holidays);
    const prev = this.current;
    const board: VocBoard = { state: state ?? prev.state, lanes, totals };
    if (state === undefined) {
      if (prev.message !== undefined) board.message = prev.message;
      if (prev.loginCommand !== undefined) board.loginCommand = prev.loginCommand;
      if (prev.loginId !== undefined) board.loginId = prev.loginId;
    }
    if (this.fetchedAt) board.fetchedAt = this.fetchedAt;
    if (me) board.me = me;
    // 목록은 받았는데 나를 모른다 — 화면이 설정에서 나를 고르라고 알린다(0건이 사실처럼 보이지 않게)
    else if (this.haveList) board.meMissing = true;
    const webBase = this.people?.webBase;
    if (webBase) board.webBase = webBase;
    this.current = board;
  }

  /**
   * 받기 실패 → 상태. 마지막 보드(칸·합계·받은 시각)는 그대로 둔다 — 화면은 안내 띠와 함께 마지막 것을 보인다.
   * 로그인 필요·위치 없음은 그 상태, 그 밖(서버·실행 문제)은 받은 적이 있으면 stale, 없으면 unavailable.
   */
  private applyFailure(f: VocFailure): void {
    let state: VocBoardState;
    if (f.state === 'login') state = 'login';
    else if (f.state === 'notConfigured') state = 'notConfigured';
    else state = this.haveList ? 'stale' : 'unavailable';
    const { loginCommand: _drop, loginId: _dropId, ...prev } = this.current;
    const board: VocBoard = { ...prev, state, message: f.message };
    if (state === 'login') {
      const loginId = this.defaultLoginId();
      if (this.deps.terminalLogin !== false) board.loginCommand = loginCommandOf(loginId);
      if (loginId) board.loginId = loginId;
    }
    this.current = board;
  }

  /**
   * 로그인 창·안내 명령의 아이디 기본값: 설정 loginId('아이디 기억') → 앞서 whoami 로 안 로그인 ID(이번 실행에서 '아이디 기억'을 끄고
   * 로그인했으면 쓰지 않는다). 모르면 undefined
   */
  private defaultLoginId(): string | undefined {
    const saved = this.settingsNow().loginId;
    if (isVocLoginId(saved)) return saved;
    if (this.forgetLoginId) return undefined;
    const who = this.people?.whoami.loginId;
    return isVocLoginId(who) ? who : undefined;
  }

  /** 받기 밖(상세·목록·쓰기)에서 로그인 필요를 알았으면 보드도 그 상태로(폴링을 멈춘다) */
  private noteLogin(f: VocFailure): void {
    if (f.state !== 'login' || this.current.state === 'login') return;
    this.applyFailure(f);
    this.reschedule();
    this.emit();
  }

  private fallbackEmail(): string | undefined {
    try {
      return this.deps.fallbackEmail?.();
    } catch {
      return undefined;
    }
  }

  // ---- voc-cli 실행 ---------------------------------------------------------------------------

  /** 한 번 실행한다. 거부(예외)·실패 모두 판정으로 돌려준다 */
  private async exec(args: string[], write: boolean, timeoutMs?: number): Promise<ExecResult> {
    let r: VocRunResult;
    try {
      r = await this.deps.runner.run(args, { write, timeoutMs: timeoutMs ?? (write ? VOC_WRITE_TIMEOUT_MS : VOC_READ_TIMEOUT_MS) });
    } catch (err) {
      // 실행하지 못했다(위치·가드·허용 목록·멈춤) — 서버에 닿지 않았다
      return { ok: false, failure: runFailureOf(err), reached: false, unsure: false };
    }
    if (r.code === 0 && !r.timedOut) return { ok: true, stdout: r.stdout };
    const failure = classifyVocFailure(r);
    // 서버에 닿지 않은 것이 분명한 실패: 로그인 필요·위치 없음·연결 실패·인자 오류(종료 코드 2)
    const reached =
      failure.state !== 'login' &&
      failure.state !== 'notConfigured' &&
      !/백엔드에 연결할 수 없습니다/.test(r.stderr ?? '') &&
      !(failure.state === 'unavailable' && r.code === 2);
    const unsure =
      r.timedOut ||
      (failure.state === 'api' && (failure.apiStatus ?? 0) >= 500) ||
      (failure.state === 'unavailable' && /요청 실패/.test(r.stderr ?? ''));
    return { ok: false, failure, reached, unsure };
  }

  /** 읽기 명령 → 출력. 실패면 VocFailureError */
  private async read(args: string[]): Promise<string> {
    const r = await this.exec(args, false);
    if (!r.ok) throw new VocFailureError(r.failure);
    return r.stdout;
  }

  /**
   * 연결 시험(2.13단계 §C-5): whoami 한 번. 로그인 이름·아이디 또는 실패(상태·문장). 던지지 않는다.
   * 사람 목록 캐시는 건드리지 않는다
   */
  async whoami(): Promise<{ ok: true; name?: string; loginId?: string } | { ok: false; state: VocFailure['state']; message: string }> {
    const r = await this.exec(['whoami'], false);
    if (!r.ok) return { ok: false, state: r.failure.state, message: r.failure.message };
    try {
      const w = parseWhoami(r.stdout);
      return { ok: true, ...(w.name ? { name: w.name } : {}), ...(w.loginId ? { loginId: w.loginId } : {}) };
    } catch (err) {
      return { ok: false, state: 'unavailable', message: `VOC whoami 응답을 읽지 못했습니다 — ${shortText(errMessage(err), 120)}` };
    }
  }

  /** 읽기 + 해석. 해석하지 못하면 unavailable */
  private async readParsed<T>(args: string[], parse: (stdout: string) => T, what: string): Promise<T> {
    const stdout = await this.read(args);
    try {
      return parse(stdout);
    } catch (err) {
      throw new VocFailureError({ state: 'unavailable', message: `VOC ${what} 응답을 읽지 못했습니다 — ${shortText(errMessage(err), 120)}` });
    }
  }

  /** whoami + user list(하루 한 번, force 면 새로) */
  private loadPeople(force: boolean): Promise<People> {
    const day = this.deps.today();
    if (!force && this.people && this.people.day === day) return Promise.resolve(this.people);
    if (this.peopleJob) return this.peopleJob;
    const gen = this.cacheGen;
    const job: Promise<People> = (async (): Promise<People> => {
      const whoami = await this.readParsed(['whoami'], parseWhoami, 'whoami');
      const users = await this.readParsed([...USERS_ARGS], parseUsers, 'user list');
      const people: People = { day, users, whoami };
      const webBase = webBaseOf(whoami.backend);
      if (webBase) people.webBase = webBase;
      if (gen === this.cacheGen) this.people = people;
      return people;
    })().finally(() => {
      if (this.peopleJob === job) this.peopleJob = undefined;
    });
    this.peopleJob = job;
    return job;
  }

  /** 요청유형 코드 + 고객사(하루 한 번, force 면 새로) */
  private loadCodes(force: boolean): Promise<Codes> {
    const day = this.deps.today();
    if (!force && this.codes && this.codes.day === day) return Promise.resolve(this.codes);
    if (this.codesJob) return this.codesJob;
    const gen = this.cacheGen;
    const job: Promise<Codes> = (async (): Promise<Codes> => {
      const requestTypes = await this.readParsed([...REQUEST_TYPE_CODES_ARGS], parseCodes, 'code list REQUEST_TYPE');
      const customers = await this.readParsed([...CUSTOMERS_ARGS], parseCustomers, 'customer list');
      const codes: Codes = { day, requestTypes, customers };
      if (gen === this.cacheGen) this.codes = codes;
      return codes;
    })().finally(() => {
      if (this.codesJob === job) this.codesJob = undefined;
    });
    this.codesJob = job;
    return job;
  }

  // ---- 읽기(화면) -----------------------------------------------------------------------------

  /**
   * 설정·등록 화면의 선택지(사람·요청유형·고객사는 하루 캐시, force 면 새로 — 설정 화면을 열 때). 시스템은 받은 진행 중 티켓 +
   * 설정의 팀 시스템으로 그때그때 만든다(systemsOf) — 목록을 한 번도 받지 못했으면 먼저 받는다. 실패는 Error(사람이 읽는 문장)
   */
  async directory(force = false): Promise<VocDirectory> {
    try {
      if (!this.haveList && this.current.state !== 'login' && this.current.state !== 'notConfigured') await this.refresh();
      const people = await this.loadPeople(force);
      const codes = await this.loadCodes(force);
      const settings = this.settingsNow();
      const dir: VocDirectory = {
        users: people.users,
        systems: systemsOf(this.tickets, Array.isArray(settings.systems) ? settings.systems : []),
        requestTypes: codes.requestTypes,
        customers: codes.customers,
      };
      const me = findMe(people.users, settings, people.whoami.email, this.fallbackEmail());
      if (me) dir.me = me;
      return dir;
    } catch (err) {
      const f = failureOf(err);
      this.noteLogin(f);
      throw new Error(f.message);
    }
  }

  /** 티켓 상세 + 답변(ticket get <id> --replies --json 한 번) */
  async ticketDetail(ticketId: number): Promise<VocTicketDetail> {
    if (!isPositiveId(ticketId)) throw new Error('잘못된 요청입니다: ticketId 는 양의 정수여야 합니다');
    const r = await this.exec(['ticket', 'get', String(ticketId), '--replies', '--json'], false);
    if (!r.ok) {
      this.noteLogin(r.failure);
      throw new Error(r.failure.message);
    }
    let detail: VocTicketDetail | null;
    try {
      detail = parseTicketDetail(r.stdout, this.deps.today(), this.deps.holidays, this.pageMapsNow());
    } catch {
      detail = null;
    }
    if (!detail) throw new Error('VOC 티켓 상세를 읽지 못했습니다');
    // 첨부 받기(file)는 여기서 받은 목록에 있는 첨부만 받는다(명세 §14)
    this.rememberAttachments(ticketId, detail.attachments ?? []);
    return detail;
  }

  /** voc-cli 로 보낼 수 없는 글자(CP949 밖) */
  checkText(text: string): string[] {
    return typeof text === 'string' ? nonCp949Chars(text) : [];
  }

  /** [VOC 에서 열기] 주소: whoami 호스트의 https + /maintenance/tickets/<정수 id>. 모르거나 모양이 틀리면 null */
  webUrl(ticketId: number): string | null {
    if (!isPositiveId(ticketId)) return null;
    const base = this.people?.webBase ?? this.current.webBase;
    if (!base) return null;
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    return `${u.origin}/maintenance/tickets/${ticketId}`;
  }

  // ---- 앱 안 로그인(명세 §13) ------------------------------------------------------------------

  /**
   * `voc-cli login -u <아이디> --password` 에 비밀번호를 표준입력으로만 넘긴다. 쓰기와 같은 직렬 큐(쓰기 차례)에서 돈다 —
   * 다른 voc-cli 와 겹치지 않는다(세션 파일 경합). 입력 형이 틀리면 던지고, 그 밖의 실패(아이디·비밀번호 규칙, 실행 중, 연속 실패로
   * 막힘, 틀린 비밀번호, 연결 실패, 시간 초과)는 ok:false 로 돌려준다. 성공하면 '아이디 기억'에 따라 설정 loginId 를 저장하거나
   * 지우고, 사람 목록을 버린 뒤 보드를 새로 받는다(끝나면 폴링이 다시 걸린다).
   * 비밀번호는 저장·기록하지 않는다 — 돌려주는 문장·보드·설정·쓰기 기록(voc-actions.json) 어디에도 없고, 쓴 뒤 참조를 버린다.
   */
  async login(input: VocLoginInput): Promise<VocLoginResult> {
    const req = checkLoginShape(input);
    let password: string | undefined = req.password;
    req.password = '';
    const refuse = (message: string): VocLoginResult => ({ ok: false, message: withoutSecret(message, password) });
    try {
      const idProblem = vocLoginIdProblem(req.loginId);
      if (idProblem) return refuse(idProblem);
      const pwProblem = vocPasswordProblem(password);
      if (pwProblem) return refuse(pwProblem);
      if (this.loginRunning) return refuse(VOC_LOGIN_BUSY_MESSAGE);
      // 서버는 아이디 글자 그대로 센다(LoginAttemptService) — 같게 센다
      const key = req.loginId;
      const now = this.nowMs();
      const held = this.loginAttempts.get(key);
      if (held && held.lockedUntil > now) return refuse(loginBlockedMessage(held.failures, held.lockedUntil - now));
      if (held && held.lockedUntil !== 0) {
        // 막아 둔 10분이 지났다. 서버 셈은 시간으로 줄지 않으므로 셈은 그대로 둔다(한 번 더 틀리면 다시 막는다). 서버 한도에 닿은 셈만
        // 0 으로 — 서버 잠금(서버 한도에 닿은 때부터 10분)이 이 10분 안에 풀리며 서버 셈도 0 이 됐다
        if (held.failures >= VOC_SERVER_LOGIN_FAIL_LIMIT) this.loginAttempts.delete(key);
        else held.lockedUntil = 0;
      }

      this.loginRunning = true;
      try {
        let r: VocRunResult;
        try {
          // 줄바꿈으로 한 줄을 끝낸다 — voc-cli(picocli 대화형 옵션)는 콘솔이 없으면 표준입력 한 줄을 비밀번호로 읽는다
          r = await this.deps.runner.run(vocLoginArgs(req.loginId), { stdin: `${password}\n`, write: true, timeoutMs: VOC_LOGIN_TIMEOUT_MS });
        } catch (err) {
          // 실행하지 못했다(위치·가드·멈춤) — 서버에 닿지 않았다
          return refuse(runFailureOf(err).message);
        }
        const verdict = loginVerdict(r, this.deps.terminalLogin !== false);
        if (!verdict.ok) {
          if (!verdict.counts) return refuse(verdict.message);
          const attempts = this.loginAttempts.get(key) ?? { failures: 0, lockedUntil: 0 };
          attempts.failures += 1;
          this.loginAttempts.set(key, attempts);
          // 서버 한도(5번)보다 먼저 막는다. 첫 실패부터 서버 잠금을 알린다 — 잠긴 동안에는 맞는 비밀번호도 '확인하세요'로 나온다
          if (attempts.failures >= VOC_LOGIN_FAIL_LIMIT) attempts.lockedUntil = this.nowMs() + VOC_LOGIN_LOCK_MS;
          return refuse(loginFailedMessage(verdict.message, attempts.failures));
        }
        this.loginAttempts.delete(key);
        return { ok: true, message: withoutSecret(this.afterLogin(req, verdict.name), password) };
      } finally {
        this.loginRunning = false;
      }
    } finally {
      password = undefined;
    }
  }

  /** 로그인 성공 뒤: 아이디 기억·사람 목록 버림·보드 새로 받기. 결과 문장을 돌려준다 */
  private afterLogin(req: VocLoginInput, name: string | undefined): string {
    const warnings: string[] = [];
    try {
      this.deps.settings().setLoginId(req.remember ? req.loginId : undefined);
    } catch (err) {
      const what = req.remember ? '아이디를 기억하지 못했습니다' : '기억한 아이디를 지우지 못했습니다';
      warnings.push(`${what}(${shortText(errMessage(err), 80)})`);
    }
    this.forgetLoginId = !req.remember;
    // 다른 아이디·다른 VOC 서버(설정에서 주소를 바꿈)로 들어왔을 수 있다 — 나·팀·웹 주소는 whoami 부터, 고객사·요청유형 코드도
    // 새로 받는다(옛 서버의 고객사 id·요청유형으로 티켓을 만들지 않게). 이미 돌고 있던 받기의 결과도 버린다(세대)
    this.cacheGen += 1;
    this.people = undefined;
    this.peopleJob = undefined;
    this.codes = undefined;
    this.codesJob = undefined;
    if (this.current.state === 'login') {
      // 안내 띠가 곧 '받는 중'으로 바뀌게(마지막 칸은 그대로 둔다)
      const { loginCommand: _c, loginId: _i, message: _m, ...rest } = this.current;
      this.current = { ...rest, state: 'loading' };
      this.emit();
    }
    this.refreshSoon();
    const done = `VOC 에 로그인했습니다${name ? `(${name})` : ''}. 목록을 새로 받습니다`;
    return warnings.length > 0 ? `${done} — ${warnings.join(' · ')}` : done;
  }

  // ---- 쓰기 — V2·V3a ---------------------------------------------------------------------------

  /** 보드(마지막으로 받은 목록)의 티켓 */
  private findTicket(ticketId: number): VocTicket | undefined {
    return this.tickets.find((t) => t.id === ticketId);
  }

  private memberName(id: number | undefined): string | undefined {
    if (id === undefined) return undefined;
    return this.people?.users.find((u) => u.id === id)?.name;
  }

  /**
   * 이 id(actionId·createId)를 이미 실행했는가 — 이번 실행 중 실행한 것 + 기록(voc-actions.json).
   * 기록을 읽지 못하면 던진다(두 번 실행했는지 알 수 없으니 부르는 쪽이 막는다).
   */
  private executedBefore(id: string): boolean {
    return this.deps.actions().has(id);
  }

  /** 이미 쓴 createId 를 또 받았을 때의 문장 — 앞 시도가 실패였는지에 따라 */
  private createUsedMessage(createId: string): string {
    let prev: VocActionRecord | undefined;
    try {
      prev = this.deps.actions().list().find((r) => r.id === createId);
    } catch {
      prev = undefined;
    }
    // 끝의 표식(VOC_CREATE_ID_USED)을 보고 화면이 createId 를 새로 바꾼다 — 확인한 뒤 다시 누르면 새 티켓이다
    const again = '. VOC 에 티켓이 생겼는지 확인하고, 없으면 [등록]을 다시 누르세요(새로 만듭니다)';
    if (prev && !prev.ok) {
      return `이 작성 칸의 앞선 등록 시도가 VOC 에 닿은 뒤 결과를 알 수 없습니다(${shortText(prev.message ?? '', 80)}) — ${VOC_CREATE_ID_USED}${again}`;
    }
    return `이 작성 칸으로 이미 등록했습니다 — ${VOC_CREATE_ID_USED}${again}`;
  }

  /** 기록을 남긴다. 남기지 못하면 경고 문장(VocActionLog 는 이번 실행 동안 같은 id 를 기억한다) */
  private record(r: VocActionRecord): string | undefined {
    try {
      this.deps.actions().add(r);
      return undefined;
    } catch (err) {
      return `VOC 쓰기 기록을 남기지 못했습니다(${shortText(errMessage(err), 80)})`;
    }
  }

  /** 동작별 명령·문장. 값 형식이 틀리면 던지고, 할 수 없는 동작이면 문제 문장 */
  private planAction(kind: VocActionKind, rawValue: string, t: VocTicket): WritePlan | { problem: string } {
    const id = String(t.id);
    switch (kind) {
      case 'assign': {
        const value = rawValue.trim();
        if (!USER_ID_RE.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('잘못된 요청입니다: 담당자 id 형식이 아닙니다');
        const uid = Number(value);
        const name = this.memberName(uid);
        if (name === undefined) return { problem: 'VOC 사용자 목록에 없는 사람입니다 — 새로고침한 뒤 다시 고르세요' };
        if (t.assigneeId === uid) return { problem: `이미 ${name} 담당입니다` };
        const toAssigned = t.status === 'new';
        const args = ['ticket', 'update', id, '--assignee', value];
        if (toAssigned) args.push('--status', 'assigned');
        args.push('--json');
        const prevName = t.assigneeName ?? this.memberName(t.assigneeId) ?? '미배정';
        const statusNote = toAssigned ? ' · 상태 new → assigned' : '';
        return {
          args,
          detail: `담당 ${prevName} → ${name}(${uid})${statusNote}`,
          done: `담당 지정: ${t.number} → ${name}${statusNote}`,
          json: true,
        };
      }
      case 'ictDue': {
        const value = rawValue.trim();
        if (value !== '' && !isValidYmd(value)) throw new Error('잘못된 요청입니다: ICT 예상완료일은 YYYY-MM-DD 여야 합니다');
        if (value === '' && !t.ictDue) return { problem: 'ICT 예상완료일이 이미 비어 있습니다' };
        if (value !== '' && t.ictDue === value) return { problem: `ICT 예상완료일이 이미 ${monthDay(value)}입니다` };
        const prev = t.ictDue ? monthDay(t.ictDue) : '없음';
        const next = value === '' ? '없음' : monthDay(value);
        return {
          args: ['ticket', 'update', id, ...(value === '' ? ['--clear-ict-due'] : ['--ict-due', value]), '--json'],
          detail: `ICT 예상완료일 ${t.ictDue ?? '없음'} → ${value || '없음'}`,
          done: value === '' ? `ICT 예상완료일을 지웠습니다: ${t.number}` : `ICT 예상완료일: ${t.number} ${prev} → ${next}`,
          json: true,
        };
      }
      case 'priority': {
        const value = rawValue.trim();
        if (!PRIORITIES.has(value)) throw new Error('잘못된 요청입니다: 우선순위는 P1·P2·P3 중 하나여야 합니다');
        if (t.priority === value) return { problem: `우선순위가 이미 ${value}입니다` };
        return {
          args: ['ticket', 'update', id, '-p', value, '--json'],
          detail: `우선순위 ${t.priority ?? '없음'} → ${value}`,
          done: `우선순위: ${t.number} ${t.priority ?? '없음'} → ${value}`,
          json: true,
        };
      }
      case 'status': {
        const value = rawValue.trim();
        const label = Object.hasOwn(STATUS_LABELS, value) ? STATUS_LABELS[value] : undefined;
        if (label === undefined) throw new Error('잘못된 요청입니다: 상태는 in_progress·pending 중 하나여야 합니다');
        if (t.status === value) return { problem: `상태가 이미 ${label}입니다` };
        return {
          args: ['ticket', 'update', id, '-s', value, '--json'],
          detail: `상태 ${t.status} → ${value}`,
          done: `상태: ${t.number} ${Object.hasOwn(STATUS_NAMES, t.status) ? STATUS_NAMES[t.status] : t.status} → ${label}`,
          json: true,
        };
      }
      case 'reply': {
        const content = rawValue.replace(/\r\n?/g, '\n');
        if (content.trim() === '') return { problem: '답변 내용을 적어 주세요' };
        const len = codePointLength(content);
        if (len > VOC_REPLY_MAX_CHARS) {
          return { problem: `답변은 ${VOC_REPLY_MAX_CHARS.toLocaleString('en-US')}자까지입니다(지금 ${len.toLocaleString('en-US')}자)` };
        }
        if (CONTROL_EXCEPT_LINES_RE.test(content)) return { problem: '답변에 줄바꿈·탭 밖의 제어 문자가 있습니다' };
        const bad = nonCp949Chars(content);
        if (bad.length > 0) return { problem: charsetProblem(bad) };
        // VOC 는 답변을 HTML 로 저장하고 그린다 — 글자 그대로(이스케이프)·줄바꿈을 살려 보낸다.
        // 답변 5,000자는 앱 한도(서버 ReplyCreateRequest 는 @NotBlank 뿐)라 사람이 적은 글자 수로 센다(위)
        const html = vocTextToHtml(content);
        if (html.length > VOC_REPLY_HTML_MAX) return { problem: htmlTooLong('답변', VOC_REPLY_HTML_MAX, html.length) };
        return {
          args: ['ticket', 'reply', id, textOption('--content', html)],
          detail: `답변 ${len}자: ${shortText(content)}`,
          done: `${t.number} 에 답변을 등록했습니다`,
          json: false,
        };
      }
    }
  }

  /**
   * VOC 운영 데이터 쓰기(확인 대화상자 뒤에만). 명세 §4·§5.
   * 입력 모양이 틀리면 던지고, 그 밖의 실패(중복·실행 중·CP949·서버 거부)는 ok:false 로 돌려준다.
   * 성공하면 --json 결과로 그 티켓을 바로 고쳐 방송하고, 이어서 목록을 새로 받는다.
   */
  async action(input: VocActionInput): Promise<VocActionResult> {
    const { actionId, kind, ticketId, value, expected } = checkActionShape(input);
    const refuse = (message: string): VocActionResult => ({ ok: false, message });

    if (this.running.has(actionId)) return refuse('이 동작을 실행하는 중입니다(같은 입력)');
    try {
      if (this.executedBefore(actionId)) return refuse('이미 실행한 동작입니다(같은 입력) — 다시 하려면 동작을 새로 고르세요');
    } catch (err) {
      return refuse(`VOC 쓰기 기록을 읽지 못해 실행하지 않았습니다(${shortText(errMessage(err), 80)})`);
    }
    if (this.busyTickets.has(ticketId)) return refuse('이 티켓의 다른 동작을 실행하는 중입니다 — 끝난 뒤 다시 하세요');
    const ticket = this.findTicket(ticketId);
    if (!ticket) return refuse('보드에 없는 티켓입니다 — 새로고침한 뒤 다시 하세요');
    let plan = this.planAction(kind, value, ticket);
    if ('problem' in plan) return refuse(plan.problem);

    this.running.add(actionId);
    this.busyTickets.add(ticketId);
    try {
      // 보드는 폴링 주기(최대 60분)만큼 묵었을 수 있다 — 쓰기 직전 VOC 에서 다시 읽어, 확인 대화상자가 보인 값과 다르면
      // (그사이 다른 사람이 VOC 웹에서 담당·상태·우선순위·예상일을 바꿨으면) 덮지 않는다. `--status assigned` 도 지금 값으로 정한다
      if (EXPECT_FIELDS[kind].length > 0) {
        const fresh = await this.readFresh(ticketId);
        if (!fresh.ok) {
          this.noteLogin(fresh.failure);
          return refuse(`VOC 에서 지금 값을 다시 읽지 못해 실행하지 않았습니다 — ${fresh.failure.message}`);
        }
        const now = fresh.ticket;
        if (DONE_STATUSES.has(now.status)) {
          this.applyTicket(now, ticket);
          return refuse(`그사이 VOC 에서 ${statusName(now.status)} 처리되어 실행하지 않았습니다(${now.number})`);
        }
        const changes = this.changesSince(kind, expected, ticket, now);
        if (changes.length > 0) {
          this.applyTicket(now, ticket);
          return {
            ok: false,
            message: `그사이 VOC 에서 바뀌어 실행하지 않았습니다(${changes.join(' · ')}) — 바뀐 내용을 확인한 뒤 다시 하세요`,
            ticket: now,
          };
        }
        const again = this.planAction(kind, value, now);
        if ('problem' in again) return refuse(again.problem);
        plan = again;
      }

      const r = await this.exec(plan.args, true);
      const base = { id: actionId, at: this.nowDate().toISOString(), kind, ticketId, number: ticket.number, detail: plan.detail };
      if (!r.ok) {
        const message = r.unsure ? `${r.failure.message} — ${UNSURE_NOTE}` : r.failure.message;
        // 서버에 닿았을 수 있는 시도만 남긴다(= 같은 actionId 는 다시 실행하지 않는다). 실행 전 거부·로그인 필요는 남기지 않는다
        if (r.reached) this.record({ ...base, ok: false, message });
        this.noteLogin(r.failure);
        return { ok: false, message };
      }
      const warn = this.record({ ...base, ok: true });
      const result: VocActionResult = { ok: true, message: warn ? `${plan.done} (${warn})` : plan.done };
      if (plan.json) {
        const updated = this.patchTicket(r.stdout, ticket);
        if (updated) result.ticket = updated;
      }
      this.refreshSoon();
      return result;
    } finally {
      this.running.delete(actionId);
      this.busyTickets.delete(ticketId);
    }
  }

  /** 쓰기 결과(TicketDto JSON)로 보드의 그 티켓을 바로 고치고 방송한다. 읽지 못하면 그대로(이어지는 받기가 고친다) */
  private patchTicket(stdout: string, prev: VocTicket | undefined): VocTicket | undefined {
    let dto: unknown;
    try {
      dto = JSON.parse(stdout);
    } catch {
      return undefined;
    }
    const next = toVocTicket(dto, this.deps.today(), this.deps.holidays, this.pageMapsNow());
    if (!next) return undefined;
    return this.applyTicket(next, prev);
  }

  /** 새로 안 티켓 한 건으로 보드를 고치고 방송한다(끝난 상태면 뺀다). prev 는 보드에 있던 그 티켓 */
  private applyTicket(next: VocTicket, prev: VocTicket | undefined): VocTicket {
    // ticket get·update 결과에는 답변 수가 없다(목록에만 있다)
    if (next.replyCount === undefined && prev?.replyCount !== undefined) next.replyCount = prev.replyCount;
    const rest = this.tickets.filter((t) => t.id !== next.id);
    this.tickets = DONE_STATUSES.has(next.status) ? rest : prev ? this.tickets.map((t) => (t.id === next.id ? next : t)) : [next, ...rest];
    this.rebuild(undefined, this.deps.today());
    this.emit();
    return next;
  }

  /** 쓰기 직전 그 티켓을 VOC 에서 다시 읽는다(ticket get <id> --json — 읽기, 같은 직렬 큐) */
  private async readFresh(ticketId: number): Promise<{ ok: true; ticket: VocTicket } | { ok: false; failure: VocFailure }> {
    const r = await this.exec(['ticket', 'get', String(ticketId), '--json'], false);
    if (!r.ok) return { ok: false, failure: r.failure };
    let detail: VocTicketDetail | null;
    try {
      detail = parseTicketDetail(r.stdout, this.deps.today(), this.deps.holidays, this.pageMapsNow());
    } catch {
      detail = null;
    }
    if (!detail || detail.ticket.id !== ticketId) {
      return { ok: false, failure: { state: 'unavailable', message: 'VOC ticket get 응답을 읽지 못했습니다' } };
    }
    return { ok: true, ticket: detail.ticket };
  }

  /**
   * 확인 대화상자가 보인 값(expected — 없는 키는 보드의 값)과 방금 VOC 에서 읽은 값이 다른 것들의 설명. 같으면 [].
   * 비교하는 필드는 그 동작이 바꾸거나 대화상자가 알린 것(EXPECT_FIELDS)
   */
  private changesSince(kind: VocActionKind, expected: VocActionExpected | undefined, board: VocTicket, now: VocTicket): string[] {
    const out: string[] = [];
    for (const key of EXPECT_FIELDS[kind]) {
      const before = expected && expected[key] !== undefined ? (expected[key] as string | number | null) : fieldOf(board, key);
      const after = fieldOf(now, key);
      if (String(before ?? '') === String(after ?? '')) continue;
      switch (key) {
        case 'assigneeId': {
          const who = (id: string | number | null): string => {
            if (id === null || id === '') return '미배정';
            const n = Number(id);
            return this.memberName(n) ?? (now.assigneeId === n ? now.assigneeName : undefined) ?? `#${n}`;
          };
          out.push(`담당 ${who(before)} → ${who(after)}`);
          break;
        }
        case 'status':
          out.push(`상태 ${statusName(before)} → ${statusName(after)}`);
          break;
        case 'priority':
          out.push(`우선순위 ${before ?? '없음'} → ${after ?? '없음'}`);
          break;
        case 'ictDue': {
          const day = (d: string | number | null): string => (typeof d === 'string' && isValidYmd(d) ? monthDay(d) : '없음');
          out.push(`ICT 예상완료일 ${day(before)} → ${day(after)}`);
          break;
        }
      }
    }
    return out;
  }

  // ---- V4 — 첨부·작업시간·해결·고객 메일(명세 §14) ------------------------------------------------

  /** 티켓마다 마지막으로 받은 첨부 목록(ticketDetail). 받기(file)는 이 목록에 있는 것만 */
  private readonly attachmentsOf = new Map<number, VocAttachment[]>();
  /** 내려받은 첨부(`<ticketId>:<fileId>` → 확인을 마친 파일). 열기·폴더에서 보기는 여기 있는 것만 */
  private readonly downloads = new Map<string, VocDownloadedFile>();

  private rememberAttachments(ticketId: number, list: VocAttachment[]): void {
    this.attachmentsOf.set(ticketId, list);
    // 오래 띄워 두어도 끝없이 늘지 않게(최근 200 티켓)
    if (this.attachmentsOf.size > 200) {
      const first = this.attachmentsOf.keys().next().value;
      if (first !== undefined) this.attachmentsOf.delete(first);
    }
  }

  /** 작업시간 목록(worklog list <id> --json — 읽기) */
  async workLogs(ticketId: number): Promise<VocWorkLog[]> {
    if (!isPositiveId(ticketId)) throw new Error('잘못된 요청입니다: ticketId 는 양의 정수여야 합니다');
    const r = await this.readWorkLogs(ticketId);
    if (!r.ok) {
      this.noteLogin(r.failure);
      throw new Error(r.failure.message);
    }
    return r.logs;
  }

  private async readWorkLogs(ticketId: number): Promise<{ ok: true; logs: VocWorkLog[] } | { ok: false; failure: VocFailure }> {
    const r = await this.exec(['worklog', 'list', String(ticketId), '--json'], false);
    if (!r.ok) return { ok: false, failure: r.failure };
    try {
      return { ok: true, logs: parseWorkLogs(r.stdout) };
    } catch (err) {
      return { ok: false, failure: { state: 'unavailable', message: `VOC worklog list 응답을 읽지 못했습니다 — ${shortText(errMessage(err), 120)}` } };
    }
  }

  /** 고객 메일 발송 기록(ticket email-logs <id> --json — 읽기) */
  async emailLogs(ticketId: number): Promise<VocEmailLog[]> {
    if (!isPositiveId(ticketId)) throw new Error('잘못된 요청입니다: ticketId 는 양의 정수여야 합니다');
    const r = await this.exec(['ticket', 'email-logs', String(ticketId), '--json'], false);
    if (!r.ok) {
      this.noteLogin(r.failure);
      throw new Error(r.failure.message);
    }
    try {
      return parseEmailLogs(r.stdout);
    } catch (err) {
      throw new Error(`VOC ticket email-logs 응답을 읽지 못했습니다 — ${shortText(errMessage(err), 120)}`);
    }
  }

  /**
   * 첨부 받기(명세 §14): 앞서 받은 첨부 목록에 있는 것만 `<filesDir>/<ticketId>/` 에 받는다. 크기를 확인하고(맞지 않으면 지운다),
   * preview 면 이미지(10MB 이하·파일 머리가 이미지)를 data URL 로 돌려준다. 실패는 한국어 Error
   */
  async file(input: VocFileInput): Promise<VocFileResult> {
    const { ticketId, fileId, mode } = input;
    if (!isPositiveId(ticketId) || !isPositiveId(fileId)) throw new Error('잘못된 요청입니다: id 는 양의 정수여야 합니다');
    if (mode !== 'preview' && mode !== 'download') throw new Error('잘못된 요청입니다: mode');
    const root = this.deps.filesDir;
    if (!root) throw new Error('첨부를 받을 폴더가 정해지지 않았습니다');
    const att = this.attachmentsOf.get(ticketId)?.find((a) => a.id === fileId);
    if (!att) throw new Error('첨부 목록에 없는 파일입니다 — [첨부 보기]로 목록을 다시 받으세요');
    if (mode === 'preview' && vocFileKind(att.fileName, att.fileSize) !== 'image') {
      throw new Error('앱 안에서 보는 것은 10MB 이하 이미지(png·jpg·gif·webp·bmp)뿐입니다 — 내려받아 보세요');
    }
    if (att.fileSize !== undefined && att.fileSize > VOC_DOWNLOAD_MAX_BYTES) {
      throw new Error(`첨부가 너무 커서(${Math.round(att.fileSize / 1024 / 1024)}MB) 앱에서 받지 않습니다 — VOC 웹에서 받으세요`);
    }
    const key = `${ticketId}:${fileId}`;
    const runKey = `file:${key}`;
    if (this.running.has(runKey)) throw new Error('이 첨부를 받는 중입니다');
    this.running.add(runKey);
    try {
      const dir = ticketFilesDir(root, ticketId);
      const r = await this.exec(vocDownloadArgs(fileId, dir), false, VOC_DOWNLOAD_TIMEOUT_MS);
      if (!r.ok) {
        this.noteLogin(r.failure);
        throw new Error(r.failure.message);
      }
      const file = checkDownloaded(parseDownloadOutput(r.stdout), dir, att.fileSize);
      markFromInternet(file.path);
      this.downloads.set(key, file);
      const result: VocFileResult = { fileId, fileName: file.fileName, size: file.size, canOpen: vocCanOpenFile(file.fileName) };
      if (mode === 'preview') result.dataUrl = imageDataUrl(file);
      return result;
    } finally {
      this.running.delete(runKey);
    }
  }

  /** 내려받은 첨부의 절대경로(열기는 허용 확장자만 — files.ts checkOpenable). 받은 적이 없으면 한국어 Error */
  fileTarget(input: VocFileOpenInput): string {
    const root = this.deps.filesDir;
    if (!root) throw new Error('첨부를 받을 폴더가 정해지지 않았습니다');
    const file = this.downloads.get(`${input.ticketId}:${input.fileId}`);
    if (!file) throw new Error('먼저 [내려받기]로 받으세요');
    return checkOpenable(root, file, input.how);
  }

  /**
   * V4 쓰기(명세 §14). 작업시간 넣기·지우기, 해결·완료(작업시간이 0건이면 함께 넣는다 — 해결은 고객 메일 --resolve 로도), 재오픈,
   * 고객 메일. 입력 모양이 틀리면 던지고, 그 밖의 실패(중복·실행 중·값 규칙·그사이 바뀜·선행조건·서버 거부)는 ok:false.
   * 같은 actionId 는 두 번 실행하지 않고(기록 voc-actions.json), 같은 티켓의 동작이 실행 중이면 막는다. 해결·완료·재오픈·메일은
   * 쓰기 직전 VOC 에서 티켓을 다시 읽어(§12-4) 대화상자가 보인 상태와 다르면 실행하지 않는다
   */
  async work(raw: VocWorkInput): Promise<VocWorkResult> {
    const input = requireVocWorkInput(raw);
    const { actionId, kind, ticketId } = input;
    const refuse = (message: string, extra: Partial<VocWorkResult> = {}): VocWorkResult => ({ ...extra, ok: false, message });

    if (this.running.has(actionId)) return refuse('이 동작을 실행하는 중입니다(같은 입력)');
    try {
      if (this.executedBefore(actionId)) return refuse('이미 실행한 동작입니다(같은 입력) — 다시 하려면 대화상자를 새로 여세요');
    } catch (err) {
      return refuse(`VOC 쓰기 기록을 읽지 못해 실행하지 않았습니다(${shortText(errMessage(err), 80)})`);
    }
    if (this.busyTickets.has(ticketId)) return refuse('이 티켓의 다른 동작을 실행하는 중입니다 — 끝난 뒤 다시 하세요');
    const board = this.findTicket(ticketId);
    // 재오픈은 해결·완료된(보드에서 빠진) 티켓에 한다 — 쓰기 직전 다시 읽은 값으로 판정한다
    if (!board && kind !== 'reopen') return refuse('보드에 없는 티켓입니다 — 새로고침한 뒤 다시 하세요');

    const problem = this.workInputProblem(input);
    if (problem) return refuse(problem);

    this.running.add(actionId);
    this.busyTickets.add(ticketId);
    try {
      switch (kind) {
        case 'worklogAdd':
          return await this.workLogAdd(input, board as VocTicket);
        case 'worklogDelete':
          return await this.workLogDelete(input, board as VocTicket);
        default:
          return await this.statusWork(input, board);
      }
    } finally {
      this.running.delete(actionId);
      this.busyTickets.delete(ticketId);
    }
  }

  /** 값 규칙(voc-cli 를 부르기 전): 시간 단위·작업일·메모 글자, 주소·답변 id. 문제가 있으면 그 문장 */
  private workInputProblem(input: VocWorkInput): string | null {
    const w = input.worklog;
    if (w) {
      const hp = vocHoursProblem(w.hours);
      if (hp) return hp;
      if (!isValidYmd(w.date)) return '작업일이 올바른 날짜가 아닙니다';
      if (w.date > this.deps.today()) return '작업일은 오늘 이후로 적을 수 없습니다';
      if (CONTROL_RE.test(w.note)) return '작업 메모에 줄바꿈이나 제어 문자를 넣을 수 없습니다';
      if (codePointLength(w.note) > VOC_WORKLOG_NOTE_MAX) return `작업 메모는 ${VOC_WORKLOG_NOTE_MAX}자까지입니다`;
      const bad = nonCp949Chars(w.note);
      if (bad.length > 0) return charsetProblem(bad);
    }
    const e = input.email;
    if (e) {
      if (e.to.length === 0) return '받는 사람을 한 명 이상 적어 주세요';
      const seen = new Set<string>();
      for (const a of [...e.to, ...e.cc]) {
        // 주소만(‘이름 <주소>’ 아님) — voc-cli 는 쉼표로 나누고 서버가 메일을 만든다
        if (!isValidAddress(a) || addressOf(a) !== a) return `메일 주소 형식이 아닙니다: ${shortText(a, 80)}`;
        const k = a.toLowerCase();
        if (seen.has(k)) return `같은 주소가 두 번 있습니다: ${shortText(a, 80)}`;
        seen.add(k);
      }
      const bad = nonCp949Chars([...e.to, ...e.cc].join(','));
      if (bad.length > 0) return charsetProblem(bad);
      if (new Set(e.replyIds).size !== e.replyIds.length) return '같은 답변이 두 번 골라졌습니다';
    }
    return null;
  }

  /** 작업시간 넣기 인자(`--긴이름=값` — 메모는 사람이 쓴 글이다, §12-1) */
  private worklogAddArgs(ticketId: number, w: NonNullable<VocWorkInput['worklog']>): string[] {
    const args = ['worklog', 'add', String(ticketId), `--hours=${w.hours}`, `--date=${w.date}`];
    const note = w.note.trim();
    if (note !== '') args.push(textOption('--note', note));
    args.push('--json');
    return args;
  }

  /** 기록 한 건의 공통 값 */
  private recordBase(id: string, kind: VocWorkKind, ticketId: number, number: string, detail: string): VocActionRecord {
    return { id, at: this.nowDate().toISOString(), kind, ticketId, number, detail, ok: true };
  }

  /** 쓰기 실패 → 기록(서버에 닿았을 수 있을 때만)·로그인 상태·문장 */
  private writeFailed(r: Extract<ExecResult, { ok: false }>, base: VocActionRecord, lead?: string): string {
    const core = r.unsure ? `${r.failure.message} — ${UNSURE_NOTE}` : r.failure.message;
    const message = lead ? `${lead} — ${core}` : core;
    if (r.reached) this.record({ ...base, ok: false, message });
    this.noteLogin(r.failure);
    return message;
  }

  /** 쓰기 뒤 작업시간을 다시 읽는다(실패해도 결과는 그대로) */
  private async workLogsAfter(ticketId: number): Promise<VocWorkLog[] | undefined> {
    const r = await this.readWorkLogs(ticketId);
    return r.ok ? r.logs : undefined;
  }

  private async workLogAdd(input: VocWorkInput, ticket: VocTicket): Promise<VocWorkResult> {
    const w = input.worklog as NonNullable<VocWorkInput['worklog']>;
    const detail = `작업시간 ${vocHoursText(w.hours)} · ${w.date}${w.note.trim() ? ` · ${shortText(w.note)}` : ''}`;
    const base = this.recordBase(input.actionId, 'worklogAdd', ticket.id, ticket.number, detail);
    const r = await this.exec(this.worklogAddArgs(ticket.id, w), true);
    if (!r.ok) return { ok: false, message: this.writeFailed(r, base) };
    const warn = this.record(base);
    const done = `${ticket.number} 에 작업시간 ${vocHoursText(w.hours)}(${monthDay(w.date)})을 넣었습니다`;
    const result: VocWorkResult = { ok: true, message: warn ? `${done} (${warn})` : done };
    const logs = await this.workLogsAfter(ticket.id);
    if (logs) result.workLogs = logs;
    return result;
  }

  private async workLogDelete(input: VocWorkInput, ticket: VocTicket): Promise<VocWorkResult> {
    const id = input.workLogId as number;
    // 쓰기 직전 다시 읽기: 그 티켓의 작업시간이고 내가 넣은 것인지(voc-cli 는 없는 id 에도 '삭제했습니다'로 끝난다)
    const fresh = await this.readWorkLogs(ticket.id);
    if (!fresh.ok) {
      this.noteLogin(fresh.failure);
      return { ok: false, message: `VOC 에서 작업시간을 다시 읽지 못해 지우지 않았습니다 — ${fresh.failure.message}` };
    }
    const log = fresh.logs.find((l) => l.id === id);
    if (!log) return { ok: false, message: '그 작업시간이 이 티켓에 없습니다(이미 지워졌을 수 있습니다)', workLogs: fresh.logs };
    const me = this.current.me;
    if (!me || log.userId !== me.id) return { ok: false, message: '내가 넣은 작업시간만 지울 수 있습니다', workLogs: fresh.logs };
    const detail = `작업시간 삭제 #${id} · ${vocHoursText(log.hours)} · ${log.workDate}`;
    const base = this.recordBase(input.actionId, 'worklogDelete', ticket.id, ticket.number, detail);
    const r = await this.exec(['worklog', 'delete', String(id), '-y'], true);
    if (!r.ok) return { ok: false, message: this.writeFailed(r, base) };
    const warn = this.record(base);
    const done = `${ticket.number} 의 작업시간 ${vocHoursText(log.hours)}(${monthDay(log.workDate)})을 지웠습니다`;
    const result: VocWorkResult = { ok: true, message: warn ? `${done} (${warn})` : done };
    const logs = await this.workLogsAfter(ticket.id);
    if (logs) result.workLogs = logs;
    return result;
  }

  /** 쓰기 직전 다시 읽은 티켓(답변이 필요하면 --replies) */
  private async readFreshDetail(ticketId: number, replies: boolean): Promise<{ ok: true; detail: VocTicketDetail } | { ok: false; failure: VocFailure }> {
    const args = ['ticket', 'get', String(ticketId), ...(replies ? ['--replies'] : []), '--json'];
    const r = await this.exec(args, false);
    if (!r.ok) return { ok: false, failure: r.failure };
    let detail: VocTicketDetail | null;
    try {
      detail = parseTicketDetail(r.stdout, this.deps.today(), this.deps.holidays, this.pageMapsNow());
    } catch {
      detail = null;
    }
    if (!detail || detail.ticket.id !== ticketId) {
      return { ok: false, failure: { state: 'unavailable', message: 'VOC ticket get 응답을 읽지 못했습니다' } };
    }
    return { ok: true, detail };
  }

  /** 해결·완료·재오픈·고객 메일 */
  private async statusWork(input: VocWorkInput, board: VocTicket | undefined): Promise<VocWorkResult> {
    const { actionId, kind, ticketId } = input;
    const email = kind === 'email' || kind === 'resolve' ? input.email : undefined;
    const fresh = await this.readFreshDetail(ticketId, email !== undefined);
    if (!fresh.ok) {
      this.noteLogin(fresh.failure);
      return { ok: false, message: `VOC 에서 지금 값을 다시 읽지 못해 실행하지 않았습니다 — ${fresh.failure.message}` };
    }
    const now = fresh.detail.ticket;
    const number = now.number;
    const label = kind === 'reopen' ? '재오픈' : kind === 'close' ? '완료' : kind === 'resolve' ? '해결' : '메일 발송';

    if (input.expectedStatus !== undefined && now.status !== input.expectedStatus) {
      this.applyTicket(now, board);
      return {
        ok: false,
        message: `그사이 VOC 에서 바뀌어 ${label}하지 않았습니다(상태 ${statusName(input.expectedStatus)} → ${statusName(now.status)}) — 확인한 뒤 다시 하세요`,
        ticket: now,
      };
    }
    if (kind === 'reopen') {
      if (now.status !== 'resolved' && now.status !== 'closed') return { ok: false, message: `해결·완료된 티켓만 재오픈합니다(지금 ${statusName(now.status)})` };
    } else if (DONE_STATUSES.has(now.status)) {
      this.applyTicket(now, board);
      return { ok: false, message: `그사이 VOC 에서 ${statusName(now.status)} 처리되어 실행하지 않았습니다(${number})` };
    }
    const finishing = kind === 'resolve' || kind === 'close';
    if (finishing && now.assigneeId === undefined) {
      return { ok: false, message: `담당자가 없어 ${label} 처리할 수 없습니다 — 먼저 담당을 지정하세요` };
    }
    if (email) {
      const known = new Set(fresh.detail.replies.map((r) => r.id));
      const unknown = email.replyIds.filter((id) => !known.has(id));
      if (unknown.length > 0) return { ok: false, message: '고른 답변 가운데 이 티켓에 없는 것이 있습니다 — 대화상자를 다시 여세요' };
    }

    // 해결·완료의 선행조건: 작업시간 1건 이상(없으면 대화상자가 받은 시간을 먼저 넣는다)
    const notes: string[] = [];
    let workLogs: VocWorkLog[] | undefined;
    if (finishing) {
      const logs = await this.readWorkLogs(ticketId);
      if (!logs.ok) {
        this.noteLogin(logs.failure);
        return { ok: false, message: `VOC 에서 작업시간을 읽지 못해 ${label}하지 않았습니다 — ${logs.failure.message}` };
      }
      workLogs = logs.logs;
      if (logs.logs.length === 0) {
        const w = input.worklog;
        if (!w) return { ok: false, message: `작업시간이 없어 ${label} 처리할 수 없습니다 — 작업시간을 함께 적어 주세요`, workLogs: [] };
        const wDetail = `작업시간 ${vocHoursText(w.hours)} · ${w.date}${w.note.trim() ? ` · ${shortText(w.note)}` : ''} (${label} 전)`;
        const wBase = this.recordBase(`${actionId}:worklog`, 'worklogAdd', ticketId, number, wDetail);
        const added = await this.exec(this.worklogAddArgs(ticketId, w), true);
        if (!added.ok) return { ok: false, message: this.writeFailed(added, wBase, `작업시간을 넣지 못해 ${label} 처리하지 않았습니다`) };
        const warn = this.record(wBase);
        notes.push(`작업시간 ${vocHoursText(w.hours)}을 함께 넣었습니다${warn ? `(${warn})` : ''}`);
      } else if (input.worklog) {
        notes.push('그사이 작업시간이 생겨 적은 시간은 넣지 않았습니다');
      }
    }

    let args: string[];
    let detail: string;
    if (email) {
      args = ['ticket', 'email', String(ticketId), `--to=${email.to.join(',')}`];
      if (email.cc.length > 0) args.push(`--cc=${email.cc.join(',')}`);
      if (kind === 'resolve') args.push('--resolve');
      // 답변 id 를 늘 적어 보낸다 — 비우면 VOC 가 모든 답변(확인 뒤에 달린 것까지)을 넣는다
      if (email.replyIds.length > 0) args.push(`--reply-id=${email.replyIds.join(',')}`);
      args.push('--json');
      detail =
        `고객 메일${kind === 'resolve' ? '(해결 처리)' : ''} · 받는 사람 ${email.to.join(', ')}` +
        (email.cc.length > 0 ? ` · 참조 ${email.cc.join(', ')}` : '') +
        ` · 답변 ${email.replyIds.length}건`;
    } else {
      args = ['ticket', kind, String(ticketId)];
      detail = `상태 ${now.status} → ${kind === 'resolve' ? 'resolved' : kind === 'close' ? 'closed' : 'assigned'}`;
    }
    const base = this.recordBase(actionId, kind, ticketId, number, detail);
    const r = await this.exec(args, true);
    if (!r.ok) {
      const lead = notes.length > 0 ? `${label}하지 못했습니다(${notes.join(' · ')})` : undefined;
      return { ok: false, message: this.writeFailed(r, base, lead), ...(workLogs ? { workLogs } : {}) };
    }
    const warn = this.record(base);
    if (warn) notes.push(warn);

    const result: VocWorkResult = { ok: true, message: '' };
    let done: string;
    if (kind === 'email') {
      done = `${number} 고객 메일을 보냈습니다(받는 사람 ${email?.to.length ?? 0}명${email && email.cc.length > 0 ? ` · 참조 ${email.cc.length}명` : ''} · 답변 ${email?.replyIds.length ?? 0}건)`;
    } else {
      const status = kind === 'resolve' ? 'resolved' : kind === 'close' ? 'closed' : 'assigned';
      const next: VocTicket = { ...now, status };
      result.ticket = this.applyTicket(next, board);
      if (kind === 'reopen') done = `${number} 를 재오픈했습니다(상태 배정됨)`;
      else {
        result.done = true;
        done = `${number} 를 ${kind === 'resolve' ? '해결' : '완료(closed)'} 처리했습니다${email ? ` — 고객에게 해결 안내 메일을 보냈습니다(받는 사람 ${email.to.length}명)` : ''}`;
      }
    }
    result.message = notes.length > 0 ? `${done} (${notes.join(' · ')})` : done;
    if (email) {
      try {
        result.emailLogs = await this.emailLogs(ticketId);
      } catch {
        // 기록을 못 읽어도 보냈다
      }
    }
    this.refreshSoon();
    return result;
  }

  // ---- 쓰기 — V3b 메일 → VOC --------------------------------------------------------------------

  /**
   * 메일 할 일 → VOC 등록 작성 칸 기본값(명세 §6). source 는 main 이 읽은 원본 메일(없으면 null),
   * existing 은 할 일 줄의 [voc:: ] 값. 선택지(directory)를 받지 못하면 던진다.
   */
  async createContext(task: Task, source: ReplySource | null, existing?: string): Promise<VocCreateContext> {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string') throw new Error('잘못된 요청입니다: 할 일이 없습니다');
    const base = await this.createDefaults(source, task.company, task.title ?? '');
    const ctx: VocCreateContext = { taskId: task.id, ...base };
    const already = typeof existing === 'string' && existing.trim() !== '' ? existing.trim() : undefined;
    if (already) ctx.existing = already;
    return ctx;
  }

  /**
   * 메일만으로 VOC 등록(2.10단계 §7-2) 작성 칸 기본값. V3b 와 같고 고객사 기본값의 이름은 메일함 이름(companyName — 부르는 쪽이
   * `_`로 시작하는 메일함·내 메모는 비운다). existing 은 이 메일로 이미 만든 번호(mark.voc).
   */
  async createContextForMail(source: ReplySource | null, companyName: string | undefined, existing?: string): Promise<Omit<VocCreateContext, 'taskId'>> {
    const ctx = await this.createDefaults(source, companyName, source?.subject ?? '');
    const already = typeof existing === 'string' && existing.trim() !== '' ? existing.trim() : undefined;
    if (already) ctx.existing = already;
    return ctx;
  }

  /** 작성 칸 기본값(V3b): 제목 = RE/FW 걷은 메일 제목(없으면 fallbackTitle) · 내용 = 본문 앞부분 · 고객사·시스템 추정 */
  private async createDefaults(source: ReplySource | null, company: string | undefined, fallbackTitle: string): Promise<Omit<VocCreateContext, 'taskId'>> {
    const directory = await this.directory();

    const subject = source ? oneLine(stripReplyPrefixes(oneLine(vocSafeDefault(source.subject ?? '')))) : '';
    const title = codePointSlice(subject || oneLine(vocSafeDefault(fallbackTitle ?? '')), VOC_TITLE_MAX_CHARS);

    const customer = matchCustomer(directory.customers, company, this.pageMapsNow());
    let system = customer ? topSystem(this.tickets, customer) : undefined;
    // 코드 목록에 없는 시스템은 기본값으로 두지 않는다(목록이 비었으면 그대로)
    if (system !== undefined && directory.systems.length > 0 && !directory.systems.some((s) => s.code === system)) system = undefined;

    const ctx: Omit<VocCreateContext, 'taskId'> = {
      title,
      description: createDescription(source),
      requestType: VOC_DEFAULT_REQUEST_TYPE,
      priority: VOC_DEFAULT_PRIORITY,
      directory,
    };
    if (customer) ctx.customerId = customer.id;
    if (system) ctx.system = system;
    return ctx;
  }

  /**
   * 메일 할 일 → VOC 티켓 등록(명세 §6). 만들기 전의 실패(형식·중복 createId·CP949·서버 거부)는 던진다.
   * 만든 뒤에는 결과 번호로 applyLine(할 일 줄에 [voc:: 번호])을 부르고, 그것이 실패해도 lineError 로 돌려준다(티켓은 만들어졌다).
   */
  async create(
    input: VocCreateInput,
    task: Task,
    applyLine: (number: string) => { ok: true } | { ok: false; error: string },
  ): Promise<VocCreateResult> {
    const req = checkCreateShape(input);
    if (!task || typeof task !== 'object' || task.id !== req.taskId) throw new Error('잘못된 요청입니다: 할 일이 맞지 않습니다');
    if (task.source === 'voc') throw new Error('VOC 할 일은 VOC 로 다시 등록하지 않습니다');
    if (!task.mail) throw new Error('메일 할 일만 VOC 로 등록할 수 있습니다');
    // 줄 붙이기(applyLineField)가 거부할 줄(값이 빈 `[voc::]`·닫히지 않은 `[voc::` 포함)이면 티켓을 만들기 전에 막는다
    if (typeof task.rawLine === 'string' && hasLineField(task.rawLine, VOC_LINE_FIELD)) {
      const existing = lineFieldValue(task.rawLine, VOC_LINE_FIELD);
      throw new Error(existing ? `이미 ${existing} 로 등록한 할 일입니다` : VOC_LINE_FIELD_BROKEN);
    }
    return this.createTicket(req, task.id, `할 일 ${task.id}`, '이 할 일을 VOC 로 등록하는 중입니다', (made, result) => {
      if (!made.number || !TICKET_NUMBER_RE.test(made.number)) {
        result.lineError = 'VOC 티켓은 만들었지만 결과에서 번호를 읽지 못했습니다 — VOC 에서 번호를 확인해 할 일 줄에 [voc:: 번호] 를 적으세요';
        return;
      }
      try {
        const line = applyLine(made.number);
        if (line.ok) result.lineUpdated = true;
        else result.lineError = line.error;
      } catch (err) {
        result.lineError = errMessage(err);
      }
    });
  }

  /**
   * 메일만으로 VOC 등록(2.10단계 §7-2). 규칙(createId·CP949·선택지 확인·로그인 필요)은 create 와 같고, 만든 뒤에는 할 일 줄 대신
   * onCreated(메일 상태 mark.voc 쓰기)를 부른다 — 실패하면 warnings(티켓은 만들어졌다). lineUpdated 는 늘 false.
   */
  async createForMail(
    input: MailVocCreateInput,
    onCreated: (made: { number: string; ticketId: number }) => { ok: true } | { ok: false; error: string },
  ): Promise<VocCreateResult> {
    if (!input || typeof input !== 'object' || typeof (input as { path?: unknown }).path !== 'string' || input.path === '') {
      throw new Error('잘못된 요청입니다: 메일 경로가 없습니다');
    }
    const { taskId: _ignored, ...req } = checkCreateShape({ ...input, taskId: 'mail' });
    return this.createTicket(req, `mail:${input.path}`, `메일 ${input.path}`, '이 메일을 VOC 로 등록하는 중입니다', (made, result) => {
      if (!made.number || !TICKET_NUMBER_RE.test(made.number)) {
        result.warnings.push('VOC 티켓은 만들었지만 결과에서 번호를 읽지 못했습니다 — VOC 에서 번호를 확인하세요');
        return;
      }
      try {
        const r = onCreated({ number: made.number, ticketId: made.ticketId });
        if (!r.ok) result.warnings.push(`VOC 티켓은 만들었지만 메일 상태에 적지 못했습니다: ${r.error}`);
      } catch (err) {
        result.warnings.push(`VOC 티켓은 만들었지만 메일 상태에 적지 못했습니다: ${errMessage(err)}`);
      }
    });
  }

  /**
   * 티켓 만들기 공용(명세 §6). 만들기 전의 실패(중복 createId·CP949·선택지·서버 거부)는 던진다. lock 은 같은 대상(할 일·메일)의
   * 등록이 겹치지 않게 잡는 키, detailTail 은 기록 문장 끝. 만든 뒤 after 로 줄 붙이기·메일 상태 쓰기를 한다(던지지 않게).
   */
  private async createTicket(
    req: Omit<VocCreateInput, 'taskId'>,
    lock: string,
    detailTail: string,
    busyMessage: string,
    after: (made: { ticketId: number; number: string }, result: VocCreateResult) => void,
  ): Promise<VocCreateResult> {
    if (this.running.has(req.createId)) throw new Error('이 티켓을 등록하는 중입니다(같은 작성 칸)');
    let before: boolean;
    try {
      before = this.executedBefore(req.createId);
    } catch (err) {
      throw new Error(`VOC 쓰기 기록을 읽지 못해 등록하지 않았습니다(${shortText(errMessage(err), 80)})`);
    }
    if (before) throw new Error(this.createUsedMessage(req.createId));
    if (this.creatingTasks.has(lock)) throw new Error(busyMessage);

    const bad = nonCp949Chars(`${req.title}\n${req.description}`);
    if (bad.length > 0) throw new Error(charsetProblem(bad));
    // VOC 는 내용을 HTML 로 저장하고 그린다 — 글자 그대로(이스케이프)·줄바꿈을 살려 보낸다. 한도는 바꾼 뒤의 길이로
    const descriptionHtml = vocTextToHtml(req.description);
    if (descriptionHtml.length > VOC_DESCRIPTION_MAX_CHARS) {
      throw new Error(htmlTooLong('내용', VOC_DESCRIPTION_MAX_CHARS, descriptionHtml.length));
    }

    // 선택지를 기다리는 동안 같은 작성 칸·같은 대상의 등록이 또 들어오지 않게 먼저 표시한다
    this.running.add(req.createId);
    this.creatingTasks.add(lock);
    try {
      // 고객사·시스템·요청유형·담당이 실제로 있는지(선택지를 받지 못하면 던진다)
      const dir = await this.directory();
      const customer = dir.customers.find((c) => c.id === req.customerId);
      if (!customer) throw new Error('VOC 고객사 목록에 없는 고객사입니다 — 다시 고르세요');
      if (dir.systems.length > 0 && !dir.systems.some((s) => s.code === req.system)) throw new Error('VOC 시스템 목록에 없는 시스템입니다 — 다시 고르세요');
      if (dir.requestTypes.length > 0 && !dir.requestTypes.some((s) => s.code === req.requestType)) {
        throw new Error('VOC 요청유형 목록에 없는 값입니다 — 다시 고르세요');
      }
      const assignee = req.assigneeId !== undefined ? dir.users.find((u) => u.id === req.assigneeId) : undefined;
      if (req.assigneeId !== undefined && !assignee) throw new Error('VOC 사용자 목록에 없는 담당입니다 — 다시 고르세요');

      const args = ['ticket', 'create', textOption('--title', req.title)];
      if (descriptionHtml !== '') args.push(textOption('--desc', descriptionHtml));
      args.push('--customer-id', String(req.customerId), '--system', req.system, '--type', req.requestType, '-p', req.priority);
      if (req.assigneeId !== undefined) args.push('--assignee', String(req.assigneeId));
      args.push('--source', 'email', '--json');
      const detail =
        `등록 ${shortText(req.title)} · 고객사 ${customer.name}(${customer.id}) · 시스템 ${req.system} · ${req.requestType} · ${req.priority}` +
        (assignee ? ` · 담당 ${assignee.name}(${assignee.id})` : '') +
        ` · ${detailTail}`;

      const r = await this.exec(args, true);
      const at = this.nowDate().toISOString();
      if (!r.ok) {
        const message = r.unsure ? `${r.failure.message} — 티켓이 만들어졌는지 VOC 에서 확인하세요` : r.failure.message;
        // 서버가 분명히 거부한 것(4xx — 티켓이 만들어지지 않았다)은 같은 작성 칸을 고쳐 다시 보낼 수 있게 그 createId 를
        // 막지 않는다. 기록은 남기되 id 에 거부 표시를 붙인다(같은 createId 중복 검사에 걸리지 않게)
        const status = r.failure.apiStatus ?? 0;
        const rejected = r.failure.state === 'api' && !r.unsure && status >= 400 && status < 500;
        const recordId = rejected ? `${req.createId}:rejected:${Date.parse(at) || Date.now()}` : req.createId;
        if (r.reached) this.record({ id: recordId, at, kind: 'create', detail, ok: false, message });
        this.noteLogin(r.failure);
        throw new Error(message);
      }

      const warnings: string[] = [];
      const made = createdTicketOf(r.stdout);
      const rec: VocActionRecord = { id: req.createId, at, kind: 'create', detail, ok: true };
      if (made.ticketId > 0) rec.ticketId = made.ticketId;
      if (made.number) rec.number = made.number;
      const warn = this.record(rec);
      if (warn) warnings.push(warn);

      const result: VocCreateResult = { ticketId: made.ticketId, number: made.number, lineUpdated: false, warnings };
      try {
        after({ ticketId: made.ticketId, number: made.number }, result);
      } catch (err) {
        result.warnings.push(errMessage(err));
      }
      if (made.dto !== undefined) this.patchTicket(JSON.stringify(made.dto), undefined);
      this.refreshSoon();
      return result;
    } finally {
      this.running.delete(req.createId);
      this.creatingTasks.delete(lock);
    }
  }
}

// ---- 모듈 안 도움 함수 ------------------------------------------------------------------------------

function failureOf(err: unknown): VocFailure {
  if (err instanceof VocFailureError) return err.failure;
  return { state: 'unavailable', message: `VOC 목록을 만들지 못했습니다 — ${shortText(errMessage(err), 120)}` };
}

/** runner.run 이 거부한 이유(VocRunError 가 실은 판정, 없으면 문장으로 판정) */
function runFailureOf(err: unknown): VocFailure {
  const carried = (err as { failure?: unknown } | null)?.failure;
  return carried && typeof carried === 'object' && typeof (carried as VocFailure).message === 'string'
    ? (carried as VocFailure)
    : classifyVocFailure({ spawnError: errMessage(err) });
}

// ---- 앱 안 로그인(명세 §13) ----------------------------------------------------------------

/** 로그인이 실행 중일 때(명세 §13 — 동시 로그인 거부) */
export const VOC_LOGIN_BUSY_MESSAGE = '로그인하는 중입니다 — 끝난 뒤 다시 하세요';

/** 한 아이디의 연속 로그인 실패: 센 수 · 앱이 막아 둔 끝 시각(ms, 0 = 막지 않음) */
interface LoginAttempts {
  failures: number;
  lockedUntil: number;
}

/** 문장 끝에 마침표가 없으면 붙인다(뒤에 문장을 잇기 전에) */
function asSentenceEnd(text: string): string {
  const t = text.trimEnd();
  return /[.!?。…]$/.test(t) ? t : `${t}.`;
}

/** 남은 시간: 1분 넘으면 '분'(올림), 아니면 '초' */
function waitText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds >= 60 ? `${Math.ceil(seconds / 60)}분` : `${seconds}초`;
}

/**
 * 셈이 되는 로그인 실패(서버 거부·시간 초과)의 문장: voc-cli 문장 + 몇 번째인지(한도면 막는다는 것) + 서버 잠금 안내(명세 §12-9).
 * 비밀번호는 넣지 않는다
 */
export function loginFailedMessage(base: string, failures: number): string {
  const minutes = VOC_LOGIN_LOCK_MS / 60_000;
  const count =
    failures >= VOC_LOGIN_FAIL_LIMIT
      ? `연달아 ${failures}번 실패해 ${minutes}분 동안 로그인을 막습니다.`
      : `연달아 ${failures}번 실패했습니다(${VOC_LOGIN_FAIL_LIMIT}번이면 앱이 ${minutes}분 동안 로그인을 막습니다).`;
  return `${asSentenceEnd(base)} ${count} ${VOC_LOGIN_LOCK_NOTE}`;
}

/** 앱이 막아 둔 동안의 문장(voc-cli 를 부르지 않는다) */
export function loginBlockedMessage(failures: number, leftMs: number): string {
  return `로그인을 연달아 ${failures}번 실패해 막아 두었습니다 — 비밀번호를 확인하고 ${waitText(leftMs)} 뒤에 다시 하세요. ${VOC_LOGIN_LOCK_NOTE}`;
}
/** 로그인이 제한 시간을 넘겼을 때(runner 가 프로세스 트리째 끝냈다) */
export const VOC_LOGIN_TIMEOUT_MESSAGE = `로그인이 제한 시간(${VOC_LOGIN_TIMEOUT_MS / 1000}초)을 넘겼습니다 — 잠시 뒤 다시 하세요`;

/** vocLogin 입력의 형(규칙은 login 이 본다). 오류 문장에 입력 값을 넣지 않는다 */
function checkLoginShape(input: unknown): VocLoginInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('잘못된 요청입니다: VOC 로그인 입력이 객체가 아닙니다');
  const r = input as Record<string, unknown>;
  if (typeof r.loginId !== 'string') throw new Error('잘못된 요청입니다: 아이디 값이 문자열이 아닙니다');
  if (typeof r.password !== 'string') throw new Error('잘못된 요청입니다: 비밀번호 값이 문자열이 아닙니다');
  if (typeof r.remember !== 'boolean') throw new Error('잘못된 요청입니다: remember 는 true·false 여야 합니다');
  return { loginId: r.loginId, password: r.password, remember: r.remember };
}

/**
 * 문장에 비밀번호가 그대로 들어 있으면 가린다. voc-cli 가 비밀번호를 되비추는 일은 없지만(표준입력은 출력되지 않는다) 한 번 더 막는다.
 * 4자 미만이면 흔한 글자까지 가려 문장을 망가뜨리므로 두지 않는다(비밀번호 규칙은 1자부터다 — §12-9)
 */
function withoutSecret(message: string, secret: string | undefined): string {
  if (!secret || secret.length < 4 || !message.includes(secret)) return message;
  return message.split(secret).join('(가림)');
}

/** '로그인 성공: 홍길동 (staff) @ https://…' 의 이름(서버 값 — 한 줄로 펴고 40자에서 자른다). 없으면 undefined */
function loggedInName(rest: string): string | undefined {
  const text = oneLine(rest);
  const m = /^(.*?)\s*\([^()]*\)\s*@/.exec(text) ?? /^(.*?)\s*@\s/.exec(text);
  const name = shortText(m ? m[1] : '', 40);
  return name !== '' ? name : undefined;
}

type LoginVerdict = { ok: true; name?: string } | { ok: false; message: string; counts: boolean };

/**
 * login 실행 결과 → 판정(명세 §13): 종료 코드 0 + 표준출력 `로그인 성공` → 성공. 표준에러 `오류: 로그인 실패: …` → 그 문장.
 * 연결 실패 → "VOC 서버에 연결하지 못했습니다 — …". 시간 초과 → 제한 시간 문장. counts = 연속 실패 잠금에 세는가(서버가 거부했거나
 * 서버에 닿은 뒤 결과를 모름 — 연결 실패·실행 문제는 세지 않는다)
 */
function loginVerdict(r: VocRunResult, terminalLogin: boolean): LoginVerdict {
  if (r.timedOut) return { ok: false, message: VOC_LOGIN_TIMEOUT_MESSAGE, counts: true };
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  if (r.code === 0) {
    // picocli 가 입력 안내('Enter value for --password …: ')를 같은 줄 앞에 찍을 수 있어 줄 안 어디든 본다
    const m = /로그인 성공\s*[:：]\s*([^\r\n]*)/.exec(stdout);
    if (m) return { ok: true, name: loggedInName(m[1]) };
    // 터미널 안내는 voc-cli 를 띄울 때만 — 앱이 VOC API 를 직접 부를 때(명세 §15)는 voc-cli 도 터미널 로그인도 없다
    const message = terminalLogin
      ? 'voc-cli 로그인 결과를 읽지 못했습니다 — 터미널에서 voc-cli whoami 로 확인하세요'
      : 'VOC 로그인 결과를 읽지 못했습니다 — [다시 확인]으로 로그인 상태를 확인하세요';
    return { ok: false, message, counts: false };
  }
  if (/비밀번호를 입력할 콘솔이 없습니다/.test(stderr)) {
    return {
      ok: false,
      message: terminalLogin
        ? 'voc-cli 가 표준입력에서 비밀번호를 읽지 못했습니다(앱 버그) — 터미널에서 로그인하세요'
        : 'VOC 로그인에 비밀번호를 넘기지 못했습니다(앱 버그) — 앱을 다시 띄운 뒤 로그인하세요',
      counts: false,
    };
  }
  const f = classifyVocFailure(r);
  if (f.state === 'unavailable' && /백엔드에 연결할 수 없습니다|요청 실패/.test(stderr)) {
    return { ok: false, message: f.message.startsWith(VOC_UNAVAILABLE_MESSAGE) ? f.message : `${VOC_UNAVAILABLE_MESSAGE} — ${f.message}`, counts: false };
  }
  return { ok: false, message: f.message, counts: f.state === 'api' };
}

/** 로그인 안내 명령: 앞서 whoami 로 로그인 ID 를 알았으면 그것을 넣는다(모양이 이상하면 자리표시 그대로) */
function loginCommandOf(loginId: string | undefined): string {
  return typeof loginId === 'string' && /^[A-Za-z0-9._@-]{1,64}$/.test(loginId) ? VOC_LOGIN_COMMAND.replace('<아이디>', loginId) : VOC_LOGIN_COMMAND;
}

/**
 * 사람이 쓴 글(제목·내용·답변)을 받는 옵션 인자 — 늘 `--긴이름=값` 한 인자로 붙인다(voc-cli 소스의 긴 이름: --title·--desc·--content).
 * 떨어진 값(`-c <값>`)은 셋 다 탈이 난다: ① 값이 '-' 로 시작하면 picocli 가 옵션으로 읽는다(`-p로 바꿨습니다` → 종료 코드 2)
 * ② 값이 '@' 로 시작하면 picocli 가 그 경로의 파일 내용으로 바꾼다(@-file 펼치기가 켜져 있다 — `@@확인` 은 `@확인`)
 * ③ Windows java 런처가 따옴표 없는 인자의 `*`·`?` 를 파일 이름으로 펼친다. `--긴이름=` 으로 시작하면 셋 다 일어나지 않는다
 * (작업 폴더도 빈 전용 폴더다 — cli.ts workDir).
 */
export function textOption(long: string, value: string): string {
  return `${long}=${value}`;
}

/** 바꾼 HTML 이 한도를 넘을 때 */
function htmlTooLong(what: string, max: number, length: number): string {
  return `${what}은 VOC 에 보내는 모양(줄바꿈·꺾쇠 등을 HTML 로 바꾼 것)으로 ${max.toLocaleString('en-US')}자까지입니다(지금 ${length.toLocaleString('en-US')}자) — 줄여 주세요`;
}

/** CP949 로 보낼 수 없는 글자 안내(명세 §1) */
export function charsetProblem(chars: readonly string[]): string {
  return `VOC 로 보낼 수 없는 글자: ${chars.join(' ')}`;
}

/** 등록 입력 모양 검사(명세 §6) — 틀리면 던진다 */
function checkCreateShape(input: unknown): VocCreateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('잘못된 요청입니다: VOC 등록 입력이 객체가 아닙니다');
  const r = input as Record<string, unknown>;
  if (typeof r.createId !== 'string' || !OP_ID_RE.test(r.createId)) {
    throw new Error('잘못된 요청입니다: createId 는 영문·숫자·하이픈 8~64자여야 합니다');
  }
  if (typeof r.taskId !== 'string' || r.taskId === '') throw new Error('잘못된 요청입니다: taskId 가 없습니다');
  if (typeof r.title !== 'string') throw new Error('잘못된 요청입니다: 제목이 문자열이 아닙니다');
  if (CONTROL_RE.test(r.title)) throw new Error('제목에 줄바꿈이나 제어 문자를 넣을 수 없습니다');
  const title = r.title.trim();
  if (title === '') throw new Error('제목을 적어 주세요');
  if (codePointLength(title) > VOC_TITLE_MAX_CHARS) throw new Error(`제목은 ${VOC_TITLE_MAX_CHARS}자까지입니다`);
  if (typeof r.description !== 'string') throw new Error('잘못된 요청입니다: 내용이 문자열이 아닙니다');
  const description = r.description.replace(/\r\n?/g, '\n');
  if (CONTROL_EXCEPT_LINES_RE.test(description)) throw new Error('내용에 줄바꿈·탭 밖의 제어 문자가 있습니다');
  const descLen = codePointLength(description);
  if (descLen > VOC_DESCRIPTION_MAX_CHARS) {
    throw new Error(`내용은 ${VOC_DESCRIPTION_MAX_CHARS.toLocaleString('en-US')}자까지입니다(지금 ${descLen.toLocaleString('en-US')}자)`);
  }
  if (!isPositiveId(r.customerId)) throw new Error('고객사를 고르세요');
  if (typeof r.system !== 'string' || !CODE_RE.test(r.system)) throw new Error('시스템을 고르세요');
  if (typeof r.requestType !== 'string' || !CODE_RE.test(r.requestType)) throw new Error('요청유형을 고르세요');
  if (typeof r.priority !== 'string' || !PRIORITIES.has(r.priority)) throw new Error('잘못된 요청입니다: 우선순위는 P1·P2·P3 중 하나여야 합니다');
  const out: VocCreateInput = {
    createId: r.createId,
    taskId: r.taskId,
    title,
    description,
    customerId: r.customerId,
    system: r.system,
    requestType: r.requestType,
    priority: r.priority,
  };
  if (r.assigneeId !== undefined && r.assigneeId !== null) {
    if (!isPositiveId(r.assigneeId)) throw new Error('잘못된 요청입니다: 담당자 id 형식이 아닙니다');
    out.assigneeId = r.assigneeId;
  }
  return out;
}

/** ticket create --json 결과 → 만든 티켓(id·번호·원본 dto). 읽지 못하면 id 0·번호 '' */
function createdTicketOf(stdout: string): { ticketId: number; number: string; dto?: unknown } {
  let dto: unknown;
  try {
    dto = JSON.parse(stdout);
  } catch {
    return { ticketId: 0, number: '' };
  }
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) return { ticketId: 0, number: '' };
  const r = dto as Record<string, unknown>;
  const ticketId = isPositiveId(r.id) ? r.id : 0;
  const number = typeof r.ticketNumber === 'string' ? r.ticketNumber.trim() : '';
  return { ticketId, number, dto };
}

/**
 * 할 일 업체에 맞는 VOC 고객사: 이름이 같은 것(공백·대소문자 무시) → 없으면 CUST_PAGE 로 바꾼 이름이 같은 것.
 * 같은 이름이 여럿이면 고르지 않는다(사람이 고른다).
 */
function matchCustomer(customers: readonly VocCustomer[], company: string | undefined, maps: VocPageMaps | undefined): VocCustomer | undefined {
  const key = nameKey(company);
  if (key === '') return undefined;
  const direct = customers.filter((c) => nameKey(c.name) === key);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  if (!maps) return undefined;
  const mapped = customers.filter((c) => {
    const page = maps.custPage.get(c.name);
    return page !== undefined && nameKey(page) === key;
  });
  return mapped.length === 1 ? mapped[0] : undefined;
}

/** 그 고객사의 진행 중 티켓에서 가장 많이 나온 시스템 코드(같으면 목록에서 먼저 나온 것 — 최근 접수 순) */
function topSystem(tickets: readonly VocTicket[], customer: VocCustomer): string | undefined {
  const key = nameKey(customer.name);
  const counts = new Map<string, number>();
  for (const t of tickets) {
    const same = t.customerId !== undefined ? t.customerId === customer.id : nameKey(t.customer) === key;
    if (!same || !t.system) continue;
    counts.set(t.system, (counts.get(t.system) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [code, n] of counts) {
    if (n > bestCount) {
      best = code;
      bestCount = n;
    }
  }
  return best;
}

/** 글자 목록(코드 값) → 정규식 글자 모음(안 보이는 글자를 소스에 그대로 두지 않으려고 코드 값으로 만든다) */
function charClass(codes: readonly number[]): string {
  return codes.map((c) => String.fromCharCode(c)).join('');
}

/** 메일 본문에 흔한 안 보이는 공백(nbsp·좁은 공백 등 — CP949 에 없다) */
const INVISIBLE_SPACE_RE = new RegExp(`[${charClass([0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f])}]`, 'g');
/** 폭 없는 글자·BOM(CP949 에 없고 보이지 않는다) */
const ZERO_WIDTH_RE = new RegExp(`[${charClass([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])}]`, 'g');

/**
 * 등록 기본값(제목·내용)의 안 보이는 글자를 CP949 로 보낼 수 있게 고른다: 특수 공백 → 보통 공백, 폭 없는 글자 → 뺌.
 * 보이지 않아 사람이 찾아 지울 수 없는 글자로 [등록]이 막히지 않게(보이는 글자 — 대시·글머리표 등 — 는 그대로 두고 안내한다)
 */
export function vocSafeDefault(text: string): string {
  return text.replace(INVISIBLE_SPACE_RE, ' ').replace(ZERO_WIDTH_RE, '');
}

/**
 * 등록 기본 내용: 원본 메일 본문 앞 8,000자 + 빈 줄 + (메일 <보낸사람> · <날짜> 에서 등록).
 * VOC 에 보내는 모양(HTML — 줄마다 <br>, 꺾쇠는 &lt;)이 10,000자를 넘으면 본문을 더 줄여 기본값 그대로 보낼 수 있게 한다.
 */
function createDescription(source: ReplySource | null): string {
  if (!source) return '';
  const body = vocSafeDefault((source.body ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_LINES_GLOBAL_RE, ' ')).trim();
  const who = [shortText(source.from ?? '', 200), localDateOf(source.date)].filter((s) => s !== '').join(' · ');
  const footer = `(메일 ${who ? `${who} ` : ''}에서 등록)`;
  const length = codePointLength(body);
  const headOf = (n: number): string => {
    if (n >= length) return body;
    const kept = codePointSlice(body, n).trimEnd();
    return kept === '' ? '…(이하 생략)' : `${kept}\n…(이하 생략)`;
  };
  const compose = (n: number): string => {
    const head = headOf(n);
    return head === '' ? footer : `${head}\n\n${footer}`;
  };
  const fits = (n: number): boolean => vocHtmlLength(compose(n)) <= VOC_DESCRIPTION_MAX_CHARS;
  let n = Math.min(length, VOC_CREATE_MAIL_BODY_CHARS);
  if (!fits(n)) {
    // 본문 글자 수가 늘면 HTML 도 늘어난다 — 들어가는 가장 긴 앞부분을 찾는다
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    n = lo;
  }
  return compose(n);
}
