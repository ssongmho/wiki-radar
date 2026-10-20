// main ↔ preload ↔ renderer 가 공유하는 데이터 계약.
// 이 파일은 순수 타입만 둔다(런타임 코드 없음). 바꿀 때는 세 쪽을 함께 고친다.

/** 할 일 상태. 기존 `_todo-sync`(build_todo.py·sync_todo.py)와 같은 네 값이다. */
export type TaskStatus = 'open' | 'wip' | 'done' | 'notmine';

/**
 * 이번 주 보기의 구간. 앞에 있는 것이 우선한다(지남 > 이번 주 > 재촉 > 정리 대상 > 기타).
 * stale(정리 대상) = 기한 없이 15영업일 이상 열렸거나(openDays ≥ 15), 기한이 30영업일 넘게 지난 것(overdueDays > 30)(2단계 명세 §4).
 */
export type Bucket = 'overdue' | 'thisWeek' | 'chased' | 'stale' | 'other';

/** items.json 의 앵커: 파일(볼트 기준 상대경로, '/')과 그 파일 체크박스 줄 안의 고유 문구. */
export interface TaskAnchor {
  file: string;
  match: string;
}

export interface Task {
  /** 안정 ID. 큐레이션 항목 'i:'+sha1(제목) 앞 12자, 체크박스 'c:'+sha1(파일|핵심문구) 앞 12자, VOC 'v:'+티켓 내부 id. */
  id: string;
  /**
   * curated = _todo-sync/items.json 항목, checkbox = 위키 체크박스에서 새로 잡은 항목,
   * voc = 내가 담당인 진행 중 VOC 티켓(2.6단계 §5 — 위키에 줄이 없다. 처리 결과 저장·반영 대기열 대상이 아니다),
   * team = 동기화된 팀 위키 사본의 체크박스 줄(2.9단계 §3 — id 는 't:'. 처리 결과 저장·반영 대기열 대상이 아니다 — 팀 할 일 저장으로)
   */
  source: 'curated' | 'checkbox' | 'voc' | 'team';
  /** source 가 voc 일 때 티켓 정보 */
  voc?: TaskVocInfo;
  /** source 가 team 일 때 문서·담당(file·line·rawLine 은 팀 사본 기준) */
  team?: TaskTeamInfo;
  /** 표시 제목. 체크박스는 필드·태그·상태 표식(🔴 등)·링크 괄호를 걷어낸 문장 */
  title: string;
  status: TaskStatus;

  /** 연결된 체크박스 줄(있으면) */
  file?: string;
  /** 1부터 세는 줄 번호 */
  line?: number;
  rawLine?: string;
  anchors?: TaskAnchor[];

  owner?: string;
  due?: string; // YYYY-MM-DD
  pri?: number;
  /** raw/mail/... 볼트 기준 상대경로 */
  mail?: string;
  opened?: string; // YYYY-MM-DD
  /** [열림:: N영업일] 의 N */
  openDays?: number;
  /** [재촉:: N회] 의 N */
  chaseCount?: number;
  thread?: string;
  /** [st:: 값] — 줄에 적힌 진행 메모(진행·확인·협의…). '완료'면 done 으로 본다(2단계 명세 §4) */
  st?: string;
  /** 업체·조직 이름(엔티티 페이지명 또는 메일함 이름). 모르면 없음 */
  company?: string;

  // items.json 큐레이션 필드
  group?: string; // g: now|over|str|adm|aug|done|new
  kind?: string; // k: do|push|dec
  risk?: number;
  why?: string;
  who?: string;
  src?: string;

  /** 할 일 메모.md 의 이 항목 최신 메모 */
  memo?: string;

  bucket: Bucket;
  /** 기한이 지난 영업일 수(주말·공휴일 제외). 기한이 지난 항목에만 있다 — 지남 구간과, 30영업일 넘게 밀려 정리 대상으로 간 항목(2단계 명세 §4) */
  overdueDays?: number;
}

export interface Holiday {
  date: string; // YYYY-MM-DD
  name: string;
}

export interface WeekDay {
  date: string; // YYYY-MM-DD
  /** 'M/D' (예: 9/23) */
  label: string;
  /** '월'…'금' */
  weekday: string;
  isToday: boolean;
  isPast: boolean;
  isHoliday: boolean;
  holidayName?: string;
  /** 이 날이 기한인 열린 할 일 수(오늘 이후만. 지난 날의 것은 overdueCount 로 간다) */
  dueCount: number;
}

export interface WeekInfo {
  today: string;
  monday: string;
  friday: string;
  days: WeekDay[]; // 월~금 5개
  overdueCount: number;
  /** 오늘 다음의 첫 영업일 */
  nextBusinessDay: string;
  /** 오늘이 공휴일이 낀 휴무 직전 마지막 영업일인가 */
  beforeHolidayBreak: boolean;
  /** 그 휴무의 이름(예: 추석) */
  breakName?: string;
}

export interface Snapshot {
  generatedAt: string; // ISO
  wikiRoot: string;
  week: WeekInfo;
  /** 열린 할 일(open·wip). 구간 순서대로, 구간 안에서는 정렬 규칙대로 */
  tasks: Task[];
  counts: Record<Bucket, number>;
  /** 색인한 마크다운 문서 수 */
  pageCount: number;
  /** 사람이 알아야 할 파싱 문제(앵커 미발견, items.json 오류 등) */
  warnings: string[];
  /**
   * 읽지 못한 파일·폴더가 있어 목록이 불완전한가(잠긴 파일 등). main 은 이 값이 참이면 잠시 뒤 다시 만들어
   * 보내고, 화면은 불완전함을 알린다. 어떤 파일인지는 warnings 에 있다.
   */
  partial: boolean;
  /**
   * 개인 위키가 없어 빈 개인 스냅샷에 팀 위키 할 일(과 내 VOC)만 합친 것(2.9단계 §3 — 팀 동기화가 켜졌을 때만).
   * 화면은 목록 머리에 "개인 위키 없음 — 팀 위키 할 일만 봅니다" 한 줄을 보인다
   */
  personalMissing?: true;
}

/** 팀 위키 할 일(Task.source 'team')의 문서·담당 */
export interface TaskTeamInfo {
  /** 팀 사본 기준 상대경로('/') */
  file: string;
  /** 문서 이름(파일 이름에서 .md 뺀 것) */
  doc: string;
  /** 담당(`[owner:: a, b]` 를 나눈 것, 줄에 적힌 표기 그대로). 없으면 미배정 */
  owners: string[];
  /** 담당 중 하나가 나의 이름들 중 하나인가 */
  mine: boolean;
}

export interface MailSummary {
  path: string;
  subject?: string;
  from?: string;
  date?: string; // ISO
  folder?: string;
  /** 본문 앞부분(평문, 최대 400자) */
  excerpt?: string;
}

export type WindowMode = 'sidebar' | 'full';

// ---- 2단계: 처리 결과 입력 → 위키 반영 (docs/stage2-contract.md) ----------------

/** 처리 결과 저장 입력 */
export interface SaveResultInput {
  taskId: string;
  /** 저장할 새 상태. open = 되돌리기 */
  status: TaskStatus;
  /** notmine 일 때 넘길 담당자(비우면 '타담당') */
  owner?: string;
  /** 처리 내용. 비어 있으면 메모를 쓰지 않는다 */
  note?: string;
  /** 위키 지식에도 반영(반영 대기열에 넣기) */
  reflect: boolean;
}

/** 처리 결과 저장 결과 — sync_todo.py 의 반환값과 같은 뜻의 필드 + 레이더 추가분 */
export interface SaveResultOutput {
  date: string;
  /** 앵커 줄을 고친 항목 ('<제목> [상태]') */
  updated: string[];
  loggedDone: string[];
  loggedDelegated: string[];
  loggedWip: string[];
  /** 되돌리기로 로그 절에서 지운 항목 */
  unlogged: string[];
  /** 메모를 새로 썼는가(같은 메모가 이미 있으면 false) */
  memo: boolean;
  /** '<제목> — 파일 없음: …' / '<제목> — 문구 미발견: …' */
  unmatched: string[];
  /** 실제로 쓴 파일(볼트 기준 상대경로) */
  files: string[];
  /** 백업 폴더(볼트 기준 상대경로). 쓴 파일이 없으면 없음 */
  backupDir?: string;
  /** reflect 였으면 대기열에 넣은 항목 */
  queued?: QueueItem;
  warnings: string[];
}

/** 반영 대기열 항목 — Claude 가 위키 지식(업체·주제 페이지, log.md)에 녹일 재료 */
export interface QueueItem {
  id: string;
  /** task = 할 일 처리 결과, decision = 판단 대기함 결정(3단계), mail = 메일함에서 넣은 메일 지식화(2.14) */
  kind: 'task' | 'decision' | 'mail';
  createdAt: string; // ISO
  taskId?: string;
  title: string;
  status?: TaskStatus;
  owner?: string;
  note: string;
  company?: string;
  file?: string;
  mail?: string;
  src?: string;
  /** decision 일 때 log 항목 문맥(날짜·제목·원문 줄) */
  context?: string;
  /** 회신을 보내고 저장했을 때 보낸 본문(서명·인용 뺀 것, 4,000자까지). 2.5단계 명세 §4-2 */
  reply?: string;
  // ---- 2.14단계(kind mail) — docs/stage2.14-contract.md §1
  /** mail: 메일 키 — 실행 때 이것으로 메일을 찾는다(경로는 `mail` 에 넣을 때의 값 — 표시·예비용) */
  mailKey?: MailKey;
  /** mail: 'mail' = 그 메일 한 통 · 'thread' = 그 메일이 든 스레드 전체(실행 시점의 스레드) */
  scope?: 'mail' | 'thread';
  /** mail: 업체·주제 힌트(0~200자, 줄바꿈 없음) */
  hint?: string;
  /** mail: 표시용 보낸이('이름 <주소>' 그대로) — 넣을 때의 값 */
  from?: string;
  /** mail: 메일 date(ISO) — 넣을 때의 값 */
  mailDate?: string;
  /** 화면용 계산값(이번 반영에서 빠지는 이유) — main 이 getQueue·onQueue 때 붙인다. 저장하지 않는다 */
  blocked?: string;
}

/** [위키에 반영](2.14단계 §6) — 경로는 받지 않는다(main 이 키로 찾는다) */
export interface QueueMailInput {
  key: MailKey;
  scope: 'mail' | 'thread';
  /** 무엇을 남길지(0~4,000자) */
  note: string;
  /** 업체·주제 힌트(0~200자, 줄바꿈 없음) */
  hint?: string;
  /** 겹치는 대기 항목을 이것으로 바꾼다 */
  replace?: boolean;
}

export type QueueMailResult =
  | { status: 'queued'; item: QueueItem; warnings: string[] }
  /** 같은 메일을 덮는 항목이 이미 대기 중 — replace:true 로 다시 보내면 바꾼다 */
  | { status: 'duplicate'; existing: QueueItem };

/** 메일 한 통의 위키 반영 표시(2.14단계 §7-2) — 대기·반영 중이 반영됨보다 우선 */
export interface MailWikiMark {
  state: 'queued' | 'running' | 'done' | 'skipped';
  /** 넣은 시각(queued·running) 또는 반영한 시각(done·skipped) */
  at?: string;
}

/** 대기열 → claude -p 실행 한 번 */
export interface ReflectRun {
  id: string;
  startedAt: string; // ISO
  finishedAt?: string;
  state: 'running' | 'done' | 'failed';
  itemIds: string[];
  summary?: string;
  /** Claude 가 바꿨다고 보고한 파일(볼트 기준 상대경로) */
  changed?: string[];
  /** 건너뛴 항목 — id 는 Claude 가 items 의 id 를 적었을 때만(2.14 — 같은 제목 항목 구분) */
  skipped?: { id?: string; title: string; reason: string }[];
  error?: string;
  /** 진행 기록(최근 50줄, 사람이 읽는 문장) */
  log: string[];
}

// ---- 2.5단계: 메일 회신 (docs/stage2.5-contract.md) -------------------------------

/** 회신 문맥 — 원본 메일 머리말에서 채운 기본값(§1). 주소는 '이름 <addr@host>' 또는 'addr@host' 문자열 */
export interface ReplyContext {
  taskId: string;
  /** 원본 메일(볼트 기준 raw/mail/…md) */
  mail: string;
  original: {
    subject: string;
    from: string;
    to: string[];
    cc: string[];
    /** 원본 date(ISO, 있으면) */
    date?: string;
    messageId?: string;
  };
  /** 받는사람 기본값(reply_to → from) */
  to: string[];
  /** [전체 회신]이 참조에 채울 주소(원본 to+cc 에서 나·받는사람·중복 뺌) */
  ccAll: string[];
  /** 'RE: <접두 걷은 원본 제목>' */
  subject: string;
  /** 원문 인용 블록(-----Original Message----- …) */
  quote: string;
  /** 원본 frontmatter suspicion(피싱 의심 신호). 없으면 [] */
  suspicious: string[];
  sender: ReplySender;
  /** 이 할 일로 보낸 가장 최근 회신 */
  lastSent?: SentMailRecord;
}

/** 보내는 쪽 준비 상태. 비밀번호는 절대 담지 않는다 */
export interface ReplySender {
  ready: boolean;
  /** SMTP 계정 주소 */
  address?: string;
  /** 설정의 보내는 이름 */
  name?: string;
  /** ready 가 아닐 때 무엇을 설정해야 하는지 */
  problem?: string;
  /** 보낼 수는 있지만 알릴 것(깨진 설정 파일을 기본값으로 되돌렸다 등). 2.5단계 명세 §9-3 */
  notice?: string;
  /** 설정의 나에게 숨은참조 */
  bccSelf: boolean;
}

export interface ReplyDraftInput {
  taskId: string;
  /** 이번 처리 내용 — 초안이 전할 핵심 */
  note: string;
  /** 추가 요청(예: '더 짧게', '완료 예정일은 10/5') */
  hint?: string;
}

/** Claude 가 쓴 회신 본문 초안(§3). 서명·인용은 들어 있지 않다 */
export interface ReplyDraft {
  body: string;
  /** 참고한 위키 문서(볼트 기준 상대경로) */
  references: string[];
  /** 소유자가 확인할 점(없으면 '') */
  notes: string;
  durationMs: number;
  /** 초안을 만든 엔진(2.13단계 §E). 없으면(옛 main) Claude */
  engine?: 'claude' | 'local';
}

export interface SendReplyInput {
  /** 작성 칸마다 새로 만드는 UUID. 같은 값은 두 번 보내지 않는다 */
  sendId: string;
  taskId: string;
  to: string[];
  cc: string[];
  subject: string;
  /** 본문(서명·인용 전) */
  body: string;
  /** 원문 인용 붙이기 */
  quoteOriginal: boolean;
  /** 발송 뒤 2단계 저장 입력(save.taskId === taskId) */
  save: SaveResultInput;
}

/** 발송 기록 한 건(sent-mail.json) */
export interface SentMailRecord {
  /** sendId */
  id: string;
  at: string; // ISO
  taskId: string;
  taskTitle: string;
  /** 원본 메일 경로 */
  mail: string;
  to: string[];
  cc: string[];
  /** 숨은참조(봉투에만 넣은 주소) */
  bcc: string[];
  subject: string;
  /** 보낸 메시지의 Message-ID */
  messageId: string;
  /** SMTP 서버 응답 문장 */
  response?: string;
  /** 보낸 MIME 사본(데이터 폴더 기준 상대경로) */
  eml?: string;
  /**
   * 어디서 보냈나(2.10단계 §7-1). 'mailbox' = 메일함에서 할 일 없이 보낸 것(taskId·taskTitle 은 '').
   * 없으면 할 일 회신(2.5)
   */
  origin?: 'mailbox';
}

export interface SendReplyOutput {
  sent: SentMailRecord;
  /** 처리 결과 저장 결과(성공했을 때) */
  save?: SaveResultOutput;
  /** 메일은 보냈지만 저장이 실패했을 때 그 문장 */
  saveError?: string;
  warnings: string[];
}

/** 보내는 이름·서명(mail-settings.json) */
export interface MailSettings {
  fromName: string;
  signature: string;
  bccSelf: boolean;
}

// ---- 2.10단계: 메일함 (docs/stage2.10-contract.md) ---------------------------------------

/** 메일 상태 키 — m: Message-ID · u: uidl · p: 경로, 뒤는 sha1 앞 16자(`^[mup]:[0-9a-f]{16}$`) */
export type MailKey = string;

/** raw/mail 메일 한 통의 머리(색인 항목 — 본문은 들고 있지 않다). §2-1 */
export interface MailIndexEntry {
  key: MailKey;
  /** 볼트 기준 'raw/mail/…md' */
  path: string;
  /** 캐시 판정 */
  size: number;
  mtimeMs: number;
  /** frontmatter date 그대로(ISO) · 없으면 파일 이름의 YYYY-MM-DD_HHMM(KST) */
  date?: string;
  /** 정렬용(모르면 0) */
  dateMs: number;
  /** 없으면 첫 H1 → '(제목 없음)' */
  subject: string;
  /** '이름 <주소>' 그대로 */
  from: string;
  fromName: string;
  fromAddr?: string;
  to: string[];
  ccCount: number;
  /** frontmatter folder → 없으면 경로의 메일함 조각 */
  folder: string;
  /** 꺾쇠 없는 Message-ID(원래 대소문자) */
  messageId?: string;
  uidl?: string;
  /** 지금 수집기는 저장하지 않는다 — 있으면 스레드 묶기에 먼저 쓴다 */
  inReplyTo?: string;
  references?: string[];
  /** 저장한 첨부 수(frontmatter attachments). 0 이면 첨부 없음 */
  attachments: number;
  /** suspicion 목록이 비어 있지 않거나 메일함이 _격리 */
  suspicious: boolean;
  /** 메일함이 _노이즈-추정 */
  muted: boolean;
  /** 메일함이 '내 메모' 이거나 보낸이가 보내는 계정 주소 — 내가 보낸 사본 */
  mine: boolean;
  /** normThread(subject) */
  threadKey: string;
  /** frontmatter 없음·깨짐 등(목록에는 보이되 표시) */
  problem?: string;
  /** frontmatter ingested(YYYY-MM-DD) — 같은 메일 두 파일 중 하나를 고를 때 */
  ingested?: string;
}

/** 메일함을 쓸 수 있는가(§5-1) */
export type MailboxState = 'noWiki' | 'noMailDir' | 'indexing' | 'ready' | 'error';

/** 목록 필터(§5-3) */
export type MailFilter = 'all' | 'unread' | 'replyNeeded' | 'archived';

/** 메일·스레드의 연결 표시 요약(§4) */
export interface MailRowLinks {
  /** 연결된 할 일 수(열린 할 일 + 메일함에서 만든 줄) */
  tasks: number;
  /** VOC 번호(할 일 줄의 [voc::] 또는 메일함 등록) */
  voc?: string;
  /** sent = 이 앱에서 회신을 보냄 · guess = 내 메모에 늦은 사본이 있음(회신 추정) */
  replied?: 'sent' | 'guess';
  /** 2.14: 스레드에 위키 반영 대기·반영 중 메일이 있으면 queued, 아니면 반영된 메일이 있으면 done */
  wiki?: 'queued' | 'done';
}

/** 메일함 목록 한 줄 = 스레드 하나(§5-3) */
export interface MailThreadRow {
  id: string;
  /** 가장 최근 메일 제목 */
  subject: string;
  /** 보낸이 이름(나 제외, 최근 순 앞 3명) */
  participants: string[];
  /** 스레드에 내가 보낸 사본이 있는가(목록에 「나, …」) */
  includesMe: boolean;
  /** 가장 최근 메일 date(ISO) */
  latestDate?: string;
  latestMs: number;
  count: number;
  unread: boolean;
  replyNeeded: boolean;
  archived: boolean;
  hasAttachments: boolean;
  suspicious: boolean;
  /** 노이즈 추정 메일만으로 된 스레드 */
  muted: boolean;
  folders: string[];
  /** 가장 최근 메일 키(선택을 다시 잡을 때) */
  latestKey: MailKey;
  links: MailRowLinks;
  /** 로컬 LLM 이 회신 필요로 추정(2.16) — 사람이 아직 [회신 필요]·처리함·회신을 안 했을 때만 */
  aiReply?: boolean;
}

/** 목록 질의(§5-3). main 이 검사한다 */
export interface MailThreadQuery {
  filter: MailFilter;
  /** 메일함 이름 하나만 */
  folder?: string;
  /** 제목·보낸이(이름·주소)·메일함 이름 부분 일치 */
  query?: string;
  /** 노이즈 추정 포함(기본 끔) */
  includeMuted?: boolean;
  /**
   * 필터에 안 맞아도 목록에 남길 스레드 id(최대 5) — 「미확인」에서 지금 읽는 스레드가 읽음이 되자마자
   * 목록에서 빠지고 옆 줄로 넘어가지 않게(2.10 버그 고침, 2026-10-19)
   */
  keep?: string[];
  offset: number;
  limit: number;
}

export interface MailFolderCount {
  name: string;
  /** 메일 수 */
  count: number;
  /** 미확인 메일 수 */
  unread: number;
}

export interface MailThreadPage {
  threads: MailThreadRow[];
  /** 필터에 맞는 스레드 수(offset·limit 전) */
  total: number;
  /** 폴더·검색어·노이즈 체크를 적용한 필터별 스레드 수 */
  counts: Record<MailFilter, number>;
  folders: MailFolderCount[];
  revision: number;
}

/** 메일함 요약(내비 배지·사이드바 블록·radar:mailbox 이벤트). §11 */
export interface MailboxSummary {
  state: MailboxState;
  /** 쓸 수 없는 이유·색인 오류(사람이 읽을 문장) */
  problem?: string;
  /** 첫 색인 진행 수 */
  progress?: { done: number; total: number };
  /** 메일 수(같은 메일 두 파일은 하나로) */
  total: number;
  /** 미확인 스레드 수 */
  unread: number;
  /** 회신 필요 스레드 수 */
  replyNeeded: number;
  /** 가장 최근 메일 date(ISO) */
  latestDate?: string;
  /** 마지막 색인을 끝낸 시각(ISO) */
  indexedAt?: string;
  /** 색인·상태·연결이 바뀔 때마다 늘어난다(목록을 다시 부를지 비교) */
  revision: number;
  /** 사이드바 3줄 — 회신 필요 먼저, 그다음 미확인 최근 순 */
  top: MailThreadRow[];
}

/** 스레드 안 메일 한 통(§6-1) */
export interface MailThreadMail {
  key: MailKey;
  path: string;
  date?: string;
  from: string;
  fromName: string;
  to: string[];
  ccCount: number;
  subject: string;
  folder: string;
  attachments: number;
  suspicious: boolean;
  mine: boolean;
  muted: boolean;
  unread: boolean;
  replyNeeded: boolean;
  archived: boolean;
  /** 이 메일로 만든 VOC(메일함 등록) */
  voc?: string;
  /** 이 메일에서 [할 일로] 만든 줄의 파일 */
  taskFile?: string;
  problem?: string;
  /** 2.14: 위키 반영 대기·반영 중·반영됨·건너뜀 */
  wiki?: MailWikiMark;
}

/** 스레드 연결(§4·§6-1) */
export interface MailThreadLinks {
  /** 연결된 열린 할 일(task.mail 경로 또는 task.thread) */
  tasks: { taskId: string; title: string; status: TaskStatus; mail?: string }[];
  /** VOC 번호(할 일 줄의 [voc::] · 메일함 등록) */
  voc: string[];
  /** 이 앱에서 보낸 회신(스레드 메일 경로로) — 최근 것부터 */
  sent: { at: string; to: string[]; subject: string; mail: string; origin?: 'mailbox' }[];
  /** 회신 추정 — 가장 최근 받은 메일 뒤의 내 사본 date(ISO) */
  replyGuess?: string;
}

export interface MailThreadDetail {
  id: string;
  threadKey: string;
  subject: string;
  /** 날짜순(오래된 것부터) */
  mails: MailThreadMail[];
  links: MailThreadLinks;
}

/** 메일 첨부(§6-2) */
export interface MailAttachment {
  name: string;
  /** 바이트 수(모르면 없음) */
  size?: number;
  contentType?: string;
  /** 실행형이라 수집기가 저장하지 않음(파일 없음) */
  blocked: boolean;
  /** 볼트 기준 raw/mail/_attachments/… (blocked 면 없음) */
  rel?: string;
}

/** 메일 한 통 읽기(§6-2). 본문은 평문 — 화면은 글자(텍스트 노드)로만 그린다 */
export interface MailMessage {
  path: string;
  key?: MailKey;
  subject: string;
  from: string;
  replyTo?: string;
  to: string[];
  cc: string[];
  date?: string;
  folder: string;
  messageId?: string;
  /** 피싱 의심 신호(frontmatter suspicion) */
  suspicion: string[];
  /** suspicion 이 있거나 메일함이 _격리 */
  suspicious: boolean;
  body: string;
  /** 본문을 100,000자에서 잘랐는가 */
  truncated: boolean;
  attachments: MailAttachment[];
  /** <!-- links:auto --> 블록의 위키링크 이름(표시만) */
  wikiLinks: string[];
  /** 원본 .eml 이 있다 — [원본 보기](HTML)를 쓸 수 있다(2.15) */
  hasOriginal?: boolean;
}

// ---- 2.16단계(로컬 LLM 메일 분석 — docs/stage2.16-contract.md) ------------------------------------

export type MailAnalysisKind = 'request' | 'question' | 'info' | 'meeting' | 'ad' | 'other';

/** 로컬 LLM 이 뽑은 한 통의 정리(추정 — 사람이 정한 것과 섞지 않는다) */
export interface MailAnalysis {
  at: string;
  model: string;
  summary: string;
  kind: MailAnalysisKind;
  /** 회신이 필요해 보이는가(추정) */
  reply: boolean;
  replyReason?: string;
  /** 기한 단서 YYYY-MM-DD */
  due?: string;
  /** 할 일 후보 — [할 일로] 입력 칸을 채운다 */
  task?: { title: string; due?: string };
  /** VOC 후보 */
  voc?: { reason: string };
}

export interface MailAnalysisView {
  /** off 설정 안 됨 · none 아직 · queued 대기 · running 분석 중 · done · error */
  status: 'off' | 'none' | 'queued' | 'running' | 'done' | 'error';
  analysis?: MailAnalysis;
  problem?: string;
}

/** 메일 원본 보기(2.15): 정리한 HTML 문서 한 장 */
export interface MailHtmlView {
  /** iframe srcdoc 에 넣을 문서(스크립트·폼·외부 연결 없음, cid 그림은 data:) */
  html: string;
  /** 막은 외부 그림 수(remote=false 일 때) */
  blockedRemote: number;
  /** 받지 못한 외부 그림 수(remote=true 일 때) */
  failedRemote: number;
}

/** 메일 상태 바꾸기(§3-3) — 한 번에 하나 */
export type MailStateChange = { read: boolean } | { replyNeeded: boolean } | { archived: boolean };

export interface SetMailStateInput {
  keys: MailKey[];
  change: MailStateChange;
}

/** 메일함 회신 초안(§7-1) */
export interface MailReplyDraftInput {
  path: string;
  /** 이번에 전할 핵심(빈 칸이면 원본 메일에 답한다) */
  note: string;
  hint?: string;
}

/** 메일함 회신 보내기(§7-1). 처리 결과 저장은 없다 */
export interface SendMailReplyInput {
  sendId: string;
  /** 원본 메일(볼트 기준 raw/mail/…md) */
  path: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  quoteOriginal: boolean;
  /** 보낸 뒤 그 스레드를 처리함으로 */
  archiveAfter: boolean;
}

export interface SendMailReplyOutput {
  sent: SentMailRecord;
  warnings: string[];
}

/** 메일 → VOC 등록 작성 칸(§7-2). taskId 가 있으면 연결된 할 일 하나 — 화면은 기존 createVocTicket 으로 */
export type MailVocCreateContext = Omit<VocCreateContext, 'taskId'> & {
  mail: string;
  taskId?: string;
  /** 같은 스레드의 다른 메일로 만든 티켓 번호(사실 표시만) */
  threadVoc?: string[];
};

/** 메일만으로 VOC 등록(§7-2) — VocCreateInput 에서 taskId 대신 path */
export type MailVocCreateInput = Omit<VocCreateInput, 'taskId'> & { path: string };

/** [할 일로](§7-3) */
export interface CreateMailTaskInput {
  path: string;
  /** 1~200자, `[`·`]`·`#`·줄바꿈·제어 문자 없음 */
  title: string;
  pri?: number;
  due?: string;
}

export interface CreateMailTaskOutput {
  /** 쓴 파일(볼트 기준) */
  file: string;
  /** 넣은 줄 */
  line: string;
  /** 백업 폴더(볼트 기준) */
  backupDir?: string;
  warnings: string[];
}

// ---- 2.6단계: VOC 담당자별 보드 (docs/stage2.6-contract.md) -----------------------

/** VOC 할 일(Task.source 'voc')의 티켓 정보 */
export interface TaskVocInfo {
  /** 티켓 내부 id(모든 voc-cli 명령의 <id>) */
  id: number;
  /** VOC-2026-0001 */
  number: string;
  /** VOC 상태 원문(new·assigned·in_progress·pending …) */
  status: string;
  priority?: string;
  slaStatus?: VocSlaStatus;
  systemName?: string;
}

export type VocSlaStatus = 'normal' | 'warning' | 'exceeded';

/** 진행 중 VOC 티켓 한 건(TicketDto 를 앱 모양으로 — §2-1). 시각은 UTC ISO, 날짜는 KST YYYY-MM-DD */
export interface VocTicket {
  id: number;
  number: string;
  title: string;
  status: string;
  priority?: string;
  customerId?: number;
  customer?: string;
  /** 시스템 코드(SYS0048 등) */
  system?: string;
  systemName?: string;
  assigneeId?: number;
  assigneeName?: string;
  createdAt: string;
  updatedAt?: string;
  lastReplyAt?: string;
  /** 고객 완료희망일(KST 날짜) */
  customerDue?: string;
  /** ICT 예상완료일(KST 날짜) */
  ictDue?: string;
  slaStatus?: VocSlaStatus;
  /** 해결 목표(분) */
  slaResolutionTarget?: number;
  replyCount?: number;
  requesterName?: string;
  requestType?: string;
  /** 요청 내용(HTML 을 글자로 편 것, 4,000자까지) */
  text: string;
  /** 접수일(KST)부터 오늘까지 달력일 */
  ageDays: number;
  /** 접수일부터 오늘까지 영업일(주말·공휴일 제외) */
  ageBusinessDays: number;
  /** 고객사·시스템의 위키 문서(볼트 기준 경로, 있으면) */
  customerPage?: string;
  systemPage?: string;
}

export interface VocMember {
  id: number;
  name: string;
  email?: string;
  department?: string;
}

export interface VocLaneSummary {
  total: number;
  slaExceeded: number;
  slaWarning: number;
  p1: number;
  /** 가장 오래된 건의 경과 달력일(없으면 없음) */
  oldestDays?: number;
}

export interface VocLane {
  /** 'unassigned' 또는 'user:<id>' */
  key: string;
  label: string;
  /** 사람 칸이면 그 사람 */
  member?: VocMember;
  /** 나의 칸인가 */
  me?: boolean;
  tickets: VocTicket[];
  summary: VocLaneSummary;
}

/** loading 처음 · ok · stale 마지막 보드 + 새로 받기 실패 · login 로그인 필요 · unavailable 서버·실행 문제 · notConfigured jar·java 없음 */
export type VocBoardState = 'loading' | 'ok' | 'stale' | 'login' | 'unavailable' | 'notConfigured';

export interface VocBoard {
  state: VocBoardState;
  /** ok 가 아닐 때 사람이 읽는 문장 */
  message?: string;
  /** 마지막으로 목록을 받은 시각(ISO) */
  fetchedAt?: string;
  /** 미배정 칸이 맨 앞, 그다음 나, 팀원(설정 순서) */
  lanes: VocLane[];
  totals: { team: number; unassigned: number; slaExceeded: number; slaWarning: number };
  /** 나(찾았으면) */
  me?: VocMember;
  /**
   * 목록은 받았는데 나를 찾지 못했다(whoami 이메일·SMTP 주소가 user list 에 없고 설정에서도 고르지 않음) — 내 담당 VOC 할 일이 없고,
   * 팀원도 고르지 않았으면 팀·팀 시스템을 정하지 못해 칸이 비어 보인다. 화면은 설정에서 나를 고르라고 안내한다
   */
  meMissing?: boolean;
  /** VOC 웹 주소(https://<호스트>) — [VOC 에서 열기] 에 쓴다. 모르면 없음 */
  webBase?: string;
  /** state 가 login 일 때 안내할 명령 */
  loginCommand?: string;
  /** state 가 login 일 때 로그인 대화상자의 아이디 기본값(설정 loginId → 앞서 whoami 로 안 로그인 ID). 모르면 없음 */
  loginId?: string;
}

export interface VocReply {
  id: number;
  authorName?: string;
  /** internal · customer 등 */
  authorType?: string;
  createdAt: string;
  /** 글자로 편 내용 */
  text: string;
}

export interface VocTicketDetail {
  ticket: VocTicket;
  replies: VocReply[];
  /** 요청·답변 첨부(명세 §14 — ticket get 의 attachments[]·replies[].attachments[]) */
  attachments?: VocAttachment[];
  /** 고객 메일 받는 사람 기본값(customerEmails, 없으면 customerEmail) */
  customerEmails?: string[];
}

/** 첨부 한 개(AttachmentDto). fileName 은 서버 값 — 글자로만 보인다 */
export interface VocAttachment {
  id: number;
  fileName: string;
  /** 바이트(모르면 없음) */
  fileSize?: number;
  uploadedAt?: string;
  /** 요청(티켓) 첨부면 없음, 답변 첨부면 그 답변 */
  replyId?: number;
  replyAuthor?: string;
}

/** 작업시간 한 건(WorkLogDto) */
export interface VocWorkLog {
  id: number;
  userId?: number;
  userName?: string;
  /** YYYY-MM-DD */
  workDate: string;
  hours: number;
  note?: string;
  /** UTC(Z 없는 ISO 그대로) */
  createdAt?: string;
}

/** 고객 메일 발송 기록 한 건(TicketEmailLogDto) */
export interface VocEmailLog {
  id: number;
  sentByName?: string;
  to: string[];
  cc: string[];
  subject?: string;
  /** sent · failed */
  status?: string;
  /** resolved · progress · assignment … */
  emailType?: string;
  sentAt?: string;
}

/** V4 쓰기(명세 §14): 작업시간 넣기·지우기, 해결·완료·재오픈, 고객 메일 */
export type VocWorkKind = 'worklogAdd' | 'worklogDelete' | 'resolve' | 'close' | 'reopen' | 'email';

export interface VocWorkInput {
  /** 대화상자(입력)마다 새 UUID. 같은 값은 두 번 실행하지 않는다 */
  actionId: string;
  kind: VocWorkKind;
  ticketId: number;
  /** 확인 대화상자가 보인 지금 상태(해결·완료·재오픈·메일) — main 이 쓰기 직전 다시 읽어 다르면 실행하지 않는다 */
  expectedStatus?: string;
  /** worklogAdd, 또는 해결·완료에서 작업시간이 0건일 때 함께 넣을 것 */
  worklog?: { hours: number; date: string; note: string };
  /** worklogDelete */
  workLogId?: number;
  /** email, 또는 resolve 를 고객 메일(--resolve)로 할 때. 주소는 '이름 <주소>' 가 아닌 주소만 */
  email?: { to: string[]; cc: string[]; replyIds: number[] };
}

export interface VocWorkResult {
  ok: boolean;
  /** 사람이 읽는 결과 문장 */
  message: string;
  /** 바뀐 티켓(알면) */
  ticket?: VocTicket;
  /** 쓰기 뒤 새로 읽은 작업시간 */
  workLogs?: VocWorkLog[];
  /** 메일 뒤 새로 읽은 발송 기록 */
  emailLogs?: VocEmailLog[];
  /** 해결·완료되어 보드에서 빠졌다(화면은 [재오픈]을 알림에 둔다) */
  done?: boolean;
}

/** 첨부 받기: preview = 이미지 [보기], download = [내려받기] */
export interface VocFileInput {
  ticketId: number;
  fileId: number;
  mode: 'preview' | 'download';
}

export interface VocFileResult {
  fileId: number;
  /** voc-cli 가 거른 저장 이름 */
  fileName: string;
  size: number;
  /** 이미지 [보기]면 data:image/…;base64,… */
  dataUrl?: string;
  /** 내려받은 파일을 [열기]로 열 수 있는가(허용 확장자) */
  canOpen: boolean;
}

/** 내려받은 첨부 열기: open = 기본 프로그램(허용 확장자만), reveal = 폴더에서 보기 */
export interface VocFileOpenInput {
  ticketId: number;
  fileId: number;
  how: 'open' | 'reveal';
}

export interface VocCode {
  code: string;
  name: string;
  /** 시스템 선택지: 이 시스템이 나온 진행 중 티켓의 고객사 id(작성 칸이 고른 고객사의 시스템을 앞에 둔다) */
  customerIds?: number[];
}

export interface VocCustomer {
  id: number;
  name: string;
}

/** 설정·등록 화면의 선택지 */
export interface VocDirectory {
  users: VocMember[];
  systems: VocCode[];
  requestTypes: VocCode[];
  customers: VocCustomer[];
  me?: VocMember;
}

export interface VocSettings {
  /** 팀원 user id(비면 나와 같은 부서) */
  memberIds: number[];
  /** 나(비면 whoami 이메일로 찾음) */
  myId?: number;
  /** 팀 시스템 코드(비면 팀원 담당 티켓의 시스템) */
  systems: string[];
  /** 미배정 칸에 팀 시스템 밖 티켓도 보이기 */
  showAllUnassigned: boolean;
  /** 받는 주기(분, 5~60) */
  pollMinutes: number;
  /** VOC 백엔드 주소(`https://호스트:포트`, 비면 기본 https://voc.acme.test:11300 — 명세 §15) */
  apiUrl?: string;
  /** voc-cli jar 위치(절대경로). 앱이 VOC API 를 직접 부르므로 WIKI_RADAR_VOC_CLI 로 voc-cli 를 쓸 때만 본다(설정 화면에는 없다) */
  jarPath?: string;
  /** 로그인 대화상자의 '아이디 기억'(명세 §13). 비밀번호는 어디에도 저장하지 않는다. 설정 대화상자의 [저장]은 이 값을 바꾸지 않는다 */
  loginId?: string;
}

/** 앱 안 로그인(명세 §13) — main 은 voc-cli login 에 비밀번호를 표준입력으로만 넘기고 쓴 뒤 버린다 */
export interface VocLoginInput {
  loginId: string;
  password: string;
  /** 성공하면 아이디를 설정(loginId)에 기억한다. false 면 기억한 아이디를 지운다 */
  remember: boolean;
}

export interface VocLoginResult {
  ok: boolean;
  /** 사람이 읽는 결과 문장(비밀번호는 들어가지 않는다) */
  message: string;
}

export type VocActionKind = 'assign' | 'ictDue' | 'priority' | 'status' | 'reply';

/**
 * 확인 대화상자가 보여 준 그 티켓의 지금 값. main 은 쓰기 직전에 VOC 에서 티켓을 다시 읽어(ticket get) 이 값과 다르면 실행하지 않는다
 * (그사이 다른 사람이 VOC 웹에서 바꾼 것을 덮지 않게). 없는 키는 보드의 값과 비교한다. null = 없음(미배정·우선순위 없음·날짜 없음)
 */
export interface VocActionExpected {
  status?: string;
  assigneeId?: number | null;
  priority?: string | null;
  ictDue?: string | null;
}

export interface VocActionInput {
  /** 동작마다 새 UUID. 같은 값은 두 번 실행하지 않는다 */
  actionId: string;
  kind: VocActionKind;
  ticketId: number;
  /** assign: user id(문자열 숫자) · ictDue: YYYY-MM-DD 또는 ''(지우기) · priority: P1|P2|P3 · status: in_progress|pending · reply: 내용 */
  value: string;
  /** 확인 대화상자가 보인 지금 값(답변 밖 동작) */
  expected?: VocActionExpected;
}

export interface VocActionResult {
  ok: boolean;
  /** 사람이 읽는 결과 문장 */
  message: string;
  /** 바뀐 티켓(성공하고 결과를 받았으면) */
  ticket?: VocTicket;
}

/** 메일 할 일 → VOC 등록 작성 칸 기본값(§6) */
export interface VocCreateContext {
  taskId: string;
  /** 이미 등록했으면 그 번호(할 일 줄의 [voc:: ]) */
  existing?: string;
  title: string;
  description: string;
  customerId?: number;
  system?: string;
  requestType: string;
  priority: string;
  directory: VocDirectory;
}

export interface VocCreateInput {
  /** 작성 칸마다 새 UUID */
  createId: string;
  taskId: string;
  title: string;
  description: string;
  customerId: number;
  system: string;
  requestType: string;
  priority: string;
  assigneeId?: number;
}

export interface VocCreateResult {
  ticketId: number;
  number: string;
  /** 할 일 줄에 [voc:: ] 를 붙였는가 */
  lineUpdated: boolean;
  /** 붙이지 못했으면 그 이유(티켓은 만들어졌다) */
  lineError?: string;
  warnings: string[];
}

// ---- 2.7단계: 처음 실행 점검(docs/stage2.7-contract.md) ---------------------------------

/**
 * 위키 폴더를 어디서 정했나: 환경 변수 WIKI_RADAR_WIKI · 점검 화면에서 고른 폴더 · 기본 위치 ·
 * 설정 › 위키에서 「없음」을 고름(2.13단계 §C-1 — path 는 만들지 않는 자리 표시 경로)
 */
export type WikiSource = 'env' | 'settings' | 'default' | 'none';

/** 이 PC 에서 쓸 수 있는 기능 점검(main 이 부를 때마다 새로 본다). VOC 로그인은 renderer 가 VOC 보드로 본다 */
export interface SetupStatus {
  wiki: {
    /** 폴더가 있는가(없으면 할 일·반영 대기·메일 회신을 쓸 수 없다) */
    ok: boolean;
    /** 지금 쓰는 위키 폴더 */
    path: string;
    source: WikiSource;
    /** 점검 화면에서 다른 폴더를 골라 다시 시작해야 적용되는 경로. 없으면 없음 */
    pending?: string;
    /** 설정 › 위키에서 「없음」으로 바꿔 다시 시작해야 적용된다(pending 과 함께 오지 않는다) */
    pendingNone?: true;
  };
  claude: {
    /** claude 실행 파일이 있는가(없으면 위키 반영·회신 초안을 쓸 수 없다) */
    ok: boolean;
    path: string;
    source: 'env' | 'path' | 'default';
  };
  mail: {
    /** 메일 계정(SMTP)이 있는가(없으면 회신을 보낼 수 없다) */
    ok: boolean;
    /** 계정이 없거나 설정이 틀렸을 때 그 문장(비밀번호는 넣지 않는다) */
    problem?: string;
  };
  /** 처음 실행 점검을 [확인]으로 닫았는가 */
  seen: boolean;
  /**
   * Windows 알림(2.9단계 §8-5). supported 거짓이면 알림함에만 남는다 · mode log 는 시험 기록 파일(notify-log.jsonl).
   * 없으면(옛 main) 점검 줄을 그리지 않는다
   */
  notify?: {
    supported: boolean;
    mode: 'toast' | 'log';
    todayToasts: number;
    /**
     * 보류 감지(2.12단계 §6-2). ok 감지 중 · held 지금 보류 중(label 이유) · unavailable 감지를 쓸 수 없음(koffi 없음 등) · off 보류 꺼짐.
     * 없으면(옛 main) 2.9 그대로
     */
    quiet?: { state: 'ok' | 'held' | 'unavailable' | 'off'; label?: string };
    /** 오늘 Windows 가 알림을 표시하지 못한 마지막 시각(ISO). 없으면 없음 */
    lastFailure?: { at: string };
  };
  /** 2.13단계 §D-3 점검 줄. 없으면(옛 main) 그리지 않는다 */
  mailIn?: SetupLine;
  ai?: SetupLine;
  /** 팀 기본값 파일 */
  team?: SetupLine;
  /** 저장된 비밀(secrets.bin)을 풀지 못했을 때만 */
  secrets?: SetupLine;
}

/** 점검 한 줄(2.13단계 §D-3). quiet 는 눈에 띄지 않게(내장 기본값 등) */
export interface SetupLine {
  state: 'ok' | 'warn' | 'off';
  text: string;
  quiet?: boolean;
}

/** 위키 폴더 고르기 결과. 고르지 않았으면(취소) changed:false */
export interface ChooseWikiResult {
  changed: boolean;
  status: SetupStatus;
}

// ---- 2.8단계: 팀 위키 동기화(docs/stage2.8-contract.md)

/** 최근 동기화로 바뀐 문서 하나. in 받음 · out 올림 · conflict 충돌 사본 · deletedIn/Out 휴지통으로 */
export interface TeamSyncChange {
  rel: string;
  dir: 'in' | 'out' | 'conflict' | 'deletedIn' | 'deletedOut';
  at: string;
}

/** 팀 위키 동기화 상태(main 이 바뀔 때마다 보낸다) */
export interface TeamSyncStatus {
  enabled: boolean;
  /** NAS 팀 위키(원본) */
  remote: string;
  /** 내 PC 사본(Obsidian 으로 여는 곳) */
  local: string;
  /** off 꺼짐 · idle 대기 · running 동기화 중 · paused 확인 필요(많이 지우거나 덮어씀) · error 오류 */
  phase: 'off' | 'idle' | 'running' | 'paused' | 'error';
  lastRunAt?: string;
  lastOkAt?: string;
  message?: string;
  /** 마지막으로 끝난 동기화 */
  last?: {
    pulled: number;
    pushed: number;
    deleted: number;
    /** 만든 충돌 사본 */
    conflicts: string[];
    skipped: { rel: string; reason: string }[];
  };
  /** paused 일 때 — 확인하면 진행할 것 */
  pending?: { deletes: number; overwrites: number; sample: string[] };
  /** 최근 변경(새것부터) */
  recent: TeamSyncChange[];
}

/** 팀 위키 동기화 켜기·끄기·경로 바꾸기 */
export interface TeamSyncInput {
  enabled: boolean;
  remote?: string;
  local?: string;
}

// ---- 2.9단계: 설정 › 나(docs/stage2.9-contract.md §4-4·§9)

/** 설정 › 나: 팀 위키 담당과 비교할 내 이름과 다른 표기. 이름이 없으면 VOC 로그인 이름을 쓴다 */
export interface MeSettings {
  name?: string;
  aliases: string[];
}

/** 나의 첫 이름이 어디서 왔나: settings 설정 · voc VOC 로그인 이름 · none 없음 */
export type MeSource = 'settings' | 'voc' | 'none';

/** getMe·saveMe 결과 */
export interface MeInfo {
  settings: MeSettings;
  /** VOC 보드가 찾은 내 이름(로그인했을 때만) */
  vocName?: string;
  /** 지금 쓰는 나의 이름들(설정 이름 또는 VOC 이름 + 다른 표기, 같은 normName 은 하나로) */
  effective: string[];
  source: MeSource;
}

// ---- 2.9단계: 팀 위키 할 일(docs/stage2.9-contract.md §3·§5)

/** 팀 할 일 보드의 담당 칸. key: 'unassigned' · 'me' · 'owner:<normName>' */
export interface TeamLane {
  key: string;
  label: string;
  me?: boolean;
  taskIds: string[];
  overdue: number;
  thisWeek: number;
}

/** 팀 위키 할 일 전체(팀 전체 탭·설정 › 나 미리보기) */
export interface TeamTaskBoard {
  /** off 동기화 꺼짐 · missing 사본 폴더 없음(아직 동기화 전) · ok · error 읽기 실패 */
  state: 'off' | 'missing' | 'ok' | 'error';
  message?: string;
  /** 읽은 시각(ISO) */
  generatedAt?: string;
  me: { names: string[]; source: MeSource };
  /** 열린 팀 할 일 전부(source 'team'), 구간 순서 */
  tasks: Task[];
  /** 미배정 → 나 → 그 밖 담당(이름 가나다순) */
  lanes: TeamLane[];
  totals: { open: number; unassigned: number; mine: number; overdue: number; thisWeek: number };
  warnings: string[];
  partial: boolean;
}

/** 팀 할 일 줄에 쓸 상태(팀 위키에는 '내 일 아님'이 없다 — 담당은 owners 로) */
export type TeamTaskStatus = 'open' | 'wip' | 'done';

/** 팀 할 일 저장 입력. 바꿀 것이 하나 이상 있어야 한다 */
export interface SaveTeamTaskInput {
  taskId: string;
  /** 화면이 본 그 줄(그사이 바뀌었으면 ID 로 다시 찾는다) */
  rawLine: string;
  status?: TeamTaskStatus;
  /** 빈 배열이면 담당을 지운다 */
  owners?: string[];
  /** '' 이면 기한을 지운다 */
  due?: string;
}

export interface SaveTeamTaskOutput {
  /** 쓴 파일(팀 사본 기준) */
  file: string;
  /** 고치기 전 사본(데이터 폴더 기준 — team-backup/<시각>). 쓰지 않았으면 없음 */
  backupDir?: string;
  /** 줄이 바뀌었는가(같으면 쓰지 않았다) */
  changed: boolean;
  warnings: string[];
}

// ---- 2.9단계: 알림 N1(docs/stage2.9-contract.md §6~§8)

/** 알림 종류: 오늘 마감 할 일 · VOC SLA 임박·초과 · VOC 새 배정 · 아침 요약 */
export type NotifyKind = 'due' | 'vocSla' | 'vocAssign' | 'morning';
/** 어디로 보내나: Windows 알림 + 알림함 · 알림함만 · 끔(중복 제거 기록만) */
export type NotifyMode = 'toast' | 'inbox' | 'off';
/** 등급: urgent 긴급(코랄) · today 오늘(앰버) */
export type NotifyGrade = 'urgent' | 'today';

/** 설정 › 알림(app-settings.json 의 notify). 없으면 기본값 */
export interface NotifySettings {
  /** 종류마다 보낼 곳. 기본 전부 'toast' */
  kinds: Record<NotifyKind, NotifyMode>;
  /** 아침 요약 시각 'HH:MM'(기본 '08:50') */
  morningTime: string;
  /** 업무 시간(평일만·공휴일 제외) 'HH:MM', workStart < workEnd. 기본 '08:00'·'19:00' */
  workStart: string;
  workEnd: string;
  /** Windows 알림·사이드바 긴급 띠에 건수만 보인다(기본 false) */
  hideContent: boolean;
  /**
   * 조용한 시간(2.12단계 §6-1) 'HH:MM' — 둘 다 '' 이면 없음. 시작 < 끝(자정을 넘기지 않는다). 그동안 Windows 알림을 모았다가 끝나면 1건으로
   */
  quietStart: string;
  quietEnd: string;
  /** 전체 화면·발표 중·잠금 동안 모았다가 끝나면 1건으로(기본 true) */
  quietHold: boolean;
  /** Windows 알림 소리(기본 false) */
  sound: boolean;
}

/** [나중에] 종류(2.12단계 §3-1): 1시간 뒤 · 다음 업무일 아침 요약 때 */
export type SnoozeKind = '1h' | 'morning';

/**
 * Windows 알림을 모아 두는 이유(2.12단계 §4-1): 자리 비움(잠금) · 전체 화면 앱 · 발표 중 · Windows 조용한 시간 · 설정의 조용한 시간
 */
export type QuietReason = 'away' | 'fullscreen' | 'presentation' | 'windowsQuiet' | 'userQuiet';

/** 트레이 단계(2.12단계 §1-1): 긴급 > 문제 > 오늘 > 평소 */
export type TrayLevel = 'normal' | 'today' | 'urgent' | 'problem';

/** 창 닫기 동작(app-settings.json 의 shell — 2.12단계 §6-1b). 없으면 'tray' */
export interface ShellSettings {
  closeAction: 'tray' | 'quit';
}

/** 알림함 항목 한 건 */
export interface NotifyItem {
  /** 'n_' + 무작위 */
  id: string;
  /** 단계 키(voc:1004:sla-exceeded · task:<id>:due-today · morning:<날짜> …) */
  key: string;
  kind: NotifyKind;
  grade: NotifyGrade;
  title: string;
  body: string;
  /** 누르면 갈 곳(할 일 id · view:voc:<번호> · view:tasks …) */
  target: string;
  /** 만든 시각(ISO) */
  createdAt: string;
  /** 읽은 시각(ISO). 안 읽었으면 null */
  readAt: string | null;
  /** Windows 알림으로 보낸 시각(ISO). 알림함에만 넣었으면 null */
  toastAt: string | null;
  /** 업무 시간 밖이라 Windows 알림을 보류했다(다음 아침 요약의 「보류 N」) */
  deferred: boolean;
  /** [나중에]로 미룬 깰 시각(ISO). 미루지 않았으면 null(2.12단계 §3-1) */
  snoozeUntil: string | null;
  snooze: SnoozeKind | null;
  /** 미뤘다가 다시 알린 항목이고 아직 안 읽음(「다시 알림」 꼬리표) */
  reminded: boolean;
}

/** 알림함 상태(getInbox·radar:inbox) — 화면은 수를 스스로 세지 않고 이것만 쓴다 */
export interface InboxState {
  /** 새것부터 200건까지 */
  items: NotifyItem[];
  unread: number;
  /** 안 읽은 긴급 항목 중 오늘 생긴 것(사이드바 긴급 띠) */
  unreadUrgent: number;
  /** 오늘 보낸 긴급 Windows 알림 수(묶음 하나 = 1) */
  todayToasts: number;
  dailyLimit: number;
  /** toast Windows 알림 · log 시험 기록 파일 · unsupported 보낼 수 없음(알림함에만) */
  toastMode: 'toast' | 'log' | 'unsupported';
  /** 내용 숨김(띠는 건수만) */
  hideContent: boolean;
  /** 미룬 항목 수(알림함 머리 「나중에 N」 — 2.12단계 §7-2). 없으면(옛 main) 0 */
  snoozed?: number;
  /** 지금 Windows 알림을 모아 두는 중이면 그 이유와 건수(§5-2). 없으면 null */
  held?: { reason: QuietReason; label: string; count: number; since: string } | null;
  /** 지금 「내일 아침」을 누르면 깰 시각(ISO) */
  nextMorningAt?: string;
}

// ---- 3a단계(위키 검색·미리보기·변경 피드 — docs/stage3a-contract.md) ----------------------------------

/** 색인 출처: 개인 위키 · 팀 위키 사본(동기화 켜짐일 때). 명세의 `WikiSource` — 이름이 2.7단계 위키 위치 출처와 겹쳐 WikiDocSource 로 */
export type WikiDocSource = 'personal' | 'team';

/** 문서 종류(§1-3). 팀 문서는 모두 team */
export type WikiDocKind = 'entity' | 'topic' | 'analysis' | 'private' | 'meta' | 'other' | 'team';

/** 출처 상태(§1-1) */
export type WikiSourceState = 'noWiki' | 'off' | 'problem' | 'missing' | 'indexing' | 'ready' | 'error';

/** frontmatter 일부(§2-1) — 없으면 키 없음, 문자열은 200자에서 자름 */
export interface WikiDocFm {
  type?: string;
  domain?: string;
  updated?: string;
  tags?: string[];
  aliases?: string[];
  /** `공개범위`(2.11) — 없으면 옛 `access` */
  scope?: string;
}

export interface WikiSourceInfo {
  state: WikiSourceState;
  /** 쓸 수 없는 이유·색인 오류(사람이 읽을 문장) */
  problem?: string;
  /** 색인한 문서 수 */
  docs: number;
  /** 마지막 색인을 끝낸 시각(ISO) */
  indexedAt?: string;
  /** 캐시로 먼저 보이는 중(증분 색인 전) */
  stale?: boolean;
  /** 첫 색인 진행 수 */
  progress?: { done: number; total: number };
}

/** 요약(내비 배지·사이드바 「변경 N」·radar:wikiDocs 이벤트). §11 */
export interface WikiDocsSummary {
  sources: { personal: WikiSourceInfo; team: WikiSourceInfo };
  /** 안 읽은 변경 항목 수 */
  changes: { personal: number; team: number; total: number };
  /** 색인·읽음 기록이 바뀔 때마다 늘어난다(목록을 다시 부를지 비교) */
  revision: number;
}

export interface WikiDocRef {
  source: WikiDocSource;
  /** 출처 루트 기준 '/' 상대경로(NFC) */
  path: string;
  title: string;
  kind: WikiDocKind;
  private: boolean;
  mtimeMs: number;
}

/** 위키링크 해석 결과(§2-3) */
export interface WikiLinkTarget {
  source: WikiDocSource;
  path: string;
  heading?: string;
  block?: string;
  /** 지금 문서와 다른 출처의 문서 */
  crossSource?: boolean;
}

/** 검색 결과 한 줄(§4) */
export interface WikiSearchHit {
  source: WikiDocSource;
  path: string;
  title: string;
  kind: WikiDocKind;
  private: boolean;
  /** 본문 조각(앞뒤 40자, 잘린 쪽 …) */
  snippet: string;
  /** 조각 안 강조 범위 [시작, 끝)(UTF-16 위치) — 최대 10개 */
  hits: [number, number][];
  /** 낱말이 모두 제목·별칭·파일 이름 안에 있음 */
  matchedTitle: boolean;
  mtimeMs: number;
}

export type WikiSearchSource = 'all' | WikiDocSource;

/** 검색 질의(main 이 검사한다) */
export interface WikiSearchQuery {
  query: string;
  source: WikiSearchSource;
  limit: number;
  offset: number;
}

export interface WikiSearchPage {
  hits: WikiSearchHit[];
  /** 출처 필터 뒤 맞은 수(한도 전) */
  total: number;
  /** 출처별 맞은 수(필터 칩의 수) */
  counts: { personal: number; team: number };
  ms: number;
  revision: number;
}

/** log.md 이유(§5-5) */
export interface WikiLogReason {
  date: string;
  kind?: string;
  title: string;
  excerpt: string;
}

/** 변경 항목(§5-3) */
export interface WikiChangeItem extends WikiDocRef {
  change: 'new' | 'changed' | 'deleted';
  /** 처음 감지한 시각(ISO) */
  detectedAt: string;
  /** personal — log.md 항목 최근 순 최대 2 */
  reasons?: WikiLogReason[];
  /** 바뀐 줄 수(다중집합 차이). null = 모름 */
  lines?: { added: number; removed: number; sample: string[] } | null;
  /** new — 본문 첫 80자 */
  firstLine?: string;
}

export interface WikiChangesPage {
  state: WikiSourceState | 'waiting';
  /** 쓸 수 없는 이유 등(사람이 읽을 문장) */
  problem?: string;
  items: WikiChangeItem[];
  /** 계산한 항목 수(최대 2,000) */
  total: number;
  /** 2,000 을 넘은 수 */
  more: number;
  /** 한 번의 색인에서 300건 넘게 바뀌었을 때 그 수 */
  bulk?: number;
  /** 팀 동기화가 멈춰 있을 때 한 줄 */
  syncNote?: string;
  revision: number;
}

/** log.md 항목(최근 기록 — §5-5) */
export interface WikiLogEntry {
  date: string;
  kind?: string;
  title: string;
  excerpt: string;
  docs: WikiDocRef[];
}

/** 문서 읽기(§6) */
export interface WikiPage {
  source: WikiDocSource;
  path: string;
  title: string;
  kind: WikiDocKind;
  private: boolean;
  mtimeMs: number;
  hash: string;
  fm: WikiDocFm;
  /** frontmatter 뗀 마크다운 원문(300,000자에서 자름) */
  body: string;
  truncated: boolean;
  /** 본문 위키링크 키(wikiLinkKey) → 해석 결과(없는 문서 null) */
  links: Record<string, WikiLinkTarget | null>;
  /** 본문 그림 참조 → 보일 수 있나 */
  images: Record<string, { ok: boolean; reason?: string }>;
  /** 이 문서가 지금 변경 항목이면 */
  change?: WikiChangeItem;
}

export interface WikiDocInput {
  source: WikiDocSource;
  path: string;
}

/** 읽음으로 바꾸기(§5-7) */
export type MarkWikiSeenInput = { items: WikiDocInput[] } | { all: true; source: WikiDocSource };

/** markWikiSeen 결과 — undoToken 으로 12초 [되돌리기](undoWikiSeen)를 할 수 있다 */
export type MarkWikiSeenOutput = WikiDocsSummary & { undoToken?: string };

export type WikiImageResult = { dataUrl: string } | { problem: string };

// ---- 2.13단계: 설정 나머지 6칸(docs/stage2.13-contract.md) ----------------------------------

/** getSettings·saveSettings 의 칸. VOC 칸 값은 기존 getVocSettings·saveVocSettings 를 쓴다 */
export type SettingsSection = 'wiki' | 'mailIn' | 'mailOut' | 'ai' | 'info';
/** 연결 시험이 있는 칸 */
export type TestableSection = 'wiki' | 'mailIn' | 'mailOut' | 'ai' | 'voc';
/** 필드 값이 어디서 왔나(§A-3): 환경 변수 > 화면 값 > 팀 기본값 > 내장 기본값 > 위키 _mail-ingest/.env(계정만) */
export type FieldSource = 'env' | 'user' | 'team' | 'builtin' | 'dotenv' | 'none';

export interface FieldView<T = unknown> {
  /** 지금 적용되는 값(없으면 null) */
  value: T | null;
  source: FieldSource;
  /** source 가 env 면 그 환경 변수 이름(화면 잠금 글) */
  envName?: string;
  /** 사람이 저장한 값(없으면 없음 — [팀 기본값으로]의 대상) */
  userValue?: T;
  teamValue?: T;
  builtinValue?: T;
  /** 환경 변수 값이 검사에 걸렸을 때 그 문장 */
  problem?: string;
}

/** 비밀 칸 — 값은 어떤 응답에도 담지 않는다 */
export type SecretKey = 'mailIn.pass' | 'mailOut.pass' | 'ai.llmKey';
export interface SecretView {
  /** secrets.bin(또는 메모리)에 이 칸의 값이 저장돼 있나 */
  saved: boolean;
  /** 지금 쓰이는 비밀의 출처 */
  source: 'env' | 'user' | 'dotenv' | 'none';
  envName?: string;
  /** file = secrets.bin(암호화) · memory = 이번 실행 동안만(이 PC 에서 암호화를 쓸 수 없음) */
  storage?: 'file' | 'memory';
}

/** 팀 기본값(NAS 팀 위키 .radar/team-settings.json — §B). 비밀은 들어 있지 않다 */
export interface TeamDefaultValues {
  mailIn?: { host?: string; port?: number; ssl?: boolean; intervalMinutes?: number };
  mailOut?: { host?: string; port?: number; security?: 'ssl' | 'starttls' };
  // ai 는 없다 — AI(로컬 LLM)는 각자 설정 › AI 에서 넣고 [연결 시험]을 거친다(소유자 결정 2026-10-19)
  voc?: { apiUrl?: string };
  update?: { url?: string };
  teamSync?: { remote?: string };
}

export type TeamDefaultsSource = 'env' | 'local' | 'remote' | 'cache' | 'none';

export interface TeamDefaultsSummary {
  /** env = WIKI_RADAR_TEAM_SETTINGS · local = 내 PC 사본 · remote = NAS · cache = 마지막 값 · none = 없음(내장 기본값) */
  source: TeamDefaultsSource;
  /** 읽은 파일(캐시면 원래 파일) */
  path?: string;
  /** 읽은 시각(로컬 'YYYY-MM-DDTHH:mm:ss') */
  readAt?: string;
  fileMtime?: string;
  /** 파일 문제(형식·비밀 키·버린 필드) */
  problems: string[];
}

export interface TeamDefaultsView extends TeamDefaultsSummary {
  values: TeamDefaultValues;
}

/** 설정 칸 하나(§F-2). fields 의 키는 칸마다 다르다(명세 §C 표의 필드 이름 — main settings/service.ts 의 SECTION_FIELDS) */
export interface SettingsSectionView {
  section: SettingsSection;
  fields: Record<string, FieldView>;
  secrets: Partial<Record<SecretKey, SecretView>>;
  /** 칸 아래 안내(출처 설명 등) */
  notes: string[];
  team: TeamDefaultsSummary;
  /** 위키: 다시 시작해야 적용되는 개인 위키(폴더 경로 또는 '(없음)') */
  restartPending?: string;
  /** 메일 받기·보내기: 위키 _mail-ingest/.env 에 계정이 있나([이 계정을 설정으로 옮기기]) */
  dotenv?: { available: boolean; file: string };
  /** 메일 보내기: 「같은 계정」일 때 쓰는 아이디 */
  sameAccountUser?: string;
  /** AI: Claude Code 상태(§C-4) */
  claude?: ClaudeStatusView;
  /** AI: 로컬 LLM 주소·모델은 있는데 아직 쓰지 않는 이유(연결 시험 전 등 — main resolveLlm 의 문장) */
  llmProblem?: string;
  /** AI: 로컬 LLM 주소가 사설망·루프백 밖인가(회사 밖으로 나감) */
  llmOutside?: boolean;
  /** AI: 마지막 연결 시험(이번 실행 동안만) */
  lastTest?: { ok: boolean; at: string };
}

export interface ClaudeStatusView {
  path: string;
  source: 'env' | 'path' | 'default';
  exists: boolean;
  /** 시험용 가짜(.mjs 등)면 true — 버전을 묻지 않는다 */
  fake?: boolean;
  version?: string;
  /** 마지막 Claude 실행(반영·회신 초안) */
  lastRun?: { at: string; ok: boolean; what: string; message?: string };
  /** 없을 때 설치 명령 */
  installCommand?: string;
}

/** saveSettings·testSettings 의 patch: 필드 이름 → 값(null = 내 값을 지움) + 비밀 하나 */
export interface SettingsPatch {
  [field: string]: unknown;
  secret?: { key: SecretKey; action: 'keep' | 'set' | 'clear'; value?: string };
}

export interface SettingsSaveResult {
  view: SettingsSectionView;
  /** 환경 변수로 잠겨 무시한 필드 */
  ignored: string[];
  /** 개인 위키를 바꿔 다시 시작해야 적용됨 */
  restartNeeded?: boolean;
  /** 비밀을 저장했으면 어디에 */
  secretStorage?: 'file' | 'memory';
}

export interface ConnectionTestStep {
  label: string;
  ok: boolean;
  /** 경고(실패는 아님 — 모델이 목록에 없음 등) */
  warn?: boolean;
  detail?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  steps: ConnectionTestStep[];
  ms: number;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  /** installed = Setup.exe 설치본 · zip = 풀어 쓰는 패키지 · dev = 개발 실행 */
  install: 'installed' | 'zip' | 'dev';
  os: string;
  dataDir: string;
  logsDir: string;
  update: FieldView<string>;
  /** 시험 모드(업데이트 확인을 부르지 않음) */
  testMode: boolean;
  teamDefaults: TeamDefaultsView;
  /** 팀 기본값 파일 위치(팀 위키 기준) */
  teamDefaultsFile: string;
  /** VOC 칸 머리(§C-5): 서버 주소와 출처 · voc-cli(WIKI_RADAR_VOC_CLI)를 쓰는 중인가. 없으면(옛 main) 보이지 않는다 */
  voc?: { apiUrl: FieldView<string>; cli: boolean };
}

export interface UpdateCheckResult {
  state: 'latest' | 'downloading' | 'unavailable' | 'failed';
  message: string;
}

export interface SettingsImportPreview {
  token: string;
  sections: { key: string; label: string; changes: number; skipped: string[] }[];
}

/** preload 가 window.radar 로 노출하는 API. renderer 는 이것만 쓴다(파일 접근 없음). */
export interface RadarAPI {
  getSnapshot(): Promise<Snapshot>;
  /** 위키가 바뀌어 스냅샷이 새로 만들어질 때마다 호출. 반환값은 구독 해제 함수 */
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  /**
   * 보이던 스냅샷이 없어졌을 때(개인 위키가 없는데 팀 동기화를 끔 — 2.9단계 §3). 인자는 사람이 읽을 문장.
   * 화면은 오류(위키 없음 안내)로 돌아간다. 없으면(옛 preload) 구독하지 않는다
   */
  onSnapshotGone?(cb: (message: string) => void): () => void;
  getMail(relPath: string): Promise<MailSummary | null>;
  /** 볼트 기준 상대경로의 문서를 Obsidian 에서 연다 */
  openInObsidian(relPath: string): Promise<void>;
  /** 모드 전환. focusTaskId 를 주면 풀스크린에서 그 항목을 연다 */
  setMode(mode: WindowMode, focusTaskId?: string): Promise<void>;
  getMode(): Promise<WindowMode>;
  onFocusTask(cb: (taskId: string) => void): () => void;
  /** 사이드바 '항상 위' 토글. 바뀐 값을 돌려준다 */
  togglePin(): Promise<boolean>;
  quit(): Promise<void>;

  // ---- 2단계
  /** 처리 결과를 위키(할 일 줄·메모 파일)에 바로 쓴다. 저장 후 스냅샷을 새로 만들어 방송한다 */
  saveResult(input: SaveResultInput): Promise<SaveResultOutput>;
  getQueue(): Promise<QueueItem[]>;
  removeQueueItem(id: string): Promise<QueueItem[]>;
  /** 대기열이 바뀔 때마다(추가·삭제·반영 완료) */
  onQueue(cb: (queue: QueueItem[]) => void): () => void;
  /** claude -p 실행을 시작하고 곧바로 running 상태를 돌려준다. 이미 실행 중이면 그 실행을 돌려준다 */
  runReflect(): Promise<ReflectRun>;
  /** 실행 중이거나 마지막으로 끝난 실행(없으면 null) */
  getReflect(): Promise<ReflectRun | null>;
  onReflect(cb: (run: ReflectRun) => void): () => void;

  // ---- 2.5단계
  /** 메일 할 일의 회신 문맥. 메일 할 일이 아니거나 원본이 없으면 null */
  getReplyContext(taskId: string): Promise<ReplyContext | null>;
  /** 읽기 전용 claude 로 회신 본문 초안을 만든다(수십 초~몇 분). 이미 만드는 중이면 거부 */
  draftReply(input: ReplyDraftInput): Promise<ReplyDraft>;
  /** 만드는 중인 초안을 멈춘다. 멈춘 것이 있었으면 true */
  cancelDraftReply(): Promise<boolean>;
  /** 메일을 보내고 처리 결과를 저장한다. 발송 실패는 예외, 저장 실패는 saveError */
  sendReply(input: SendReplyInput): Promise<SendReplyOutput>;
  getMailSettings(): Promise<MailSettings>;
  saveMailSettings(settings: MailSettings): Promise<MailSettings>;

  // ---- 2.6단계
  getVocBoard(): Promise<VocBoard>;
  /** 보드가 바뀔 때마다(폴링·새로고침·쓰기 뒤) */
  onVocBoard(cb: (board: VocBoard) => void): () => void;
  /** 지금 목록을 새로 받는다(실행 중이면 그 결과를 기다린다) */
  refreshVoc(): Promise<VocBoard>;
  /** 티켓 상세 + 답변(ticket get --replies) */
  getVocTicket(ticketId: number): Promise<VocTicketDetail>;
  getVocDirectory(): Promise<VocDirectory>;
  getVocSettings(): Promise<VocSettings>;
  saveVocSettings(settings: VocSettings): Promise<VocSettings>;
  /** VOC 운영 데이터 쓰기(확인 대화상자 뒤에만 부른다) */
  vocAction(input: VocActionInput): Promise<VocActionResult>;
  /** voc-cli 로 보낼 수 없는 글자(CP949 밖) 목록. 없으면 [] */
  checkVocText(text: string): Promise<string[]>;
  getVocCreateContext(taskId: string): Promise<VocCreateContext | null>;
  createVocTicket(input: VocCreateInput): Promise<VocCreateResult>;
  /** 티켓을 VOC 웹에서 연다 */
  openVocWeb(ticketId: number): Promise<void>;
  /** 앱 안 로그인(voc-cli login — 비밀번호는 표준입력으로만). 실패도 ok:false 로 돌려준다 */
  vocLogin(input: VocLoginInput): Promise<VocLoginResult>;
  // V4(명세 §14)
  /** 작업시간 목록(worklog list) */
  getVocWorkLogs(ticketId: number): Promise<VocWorkLog[]>;
  /** 고객 메일 발송 기록(ticket email-logs) */
  getVocEmailLogs(ticketId: number): Promise<VocEmailLog[]>;
  /** 작업시간·해결·완료·재오픈·고객 메일(확인 대화상자 뒤에만 — 작업시간 넣기는 결과 알림만). 실패도 ok:false */
  vocWork(input: VocWorkInput): Promise<VocWorkResult>;
  /** 첨부 받기(앱 데이터 폴더 voc-files/<ticketId>/). 먼저 getVocTicket 으로 첨부 목록을 받아야 한다 */
  vocFile(input: VocFileInput): Promise<VocFileResult>;
  /** 내려받은 첨부 열기·폴더에서 보기 */
  openVocFile(input: VocFileOpenInput): Promise<void>;

  // ---- 2.7단계(처음 실행 점검)
  getSetup(): Promise<SetupStatus>;
  /** 폴더 고르기 창을 띄워 위키 폴더를 고른다(다시 시작해야 적용). 환경 변수로 정했으면 거부 */
  chooseWikiFolder(): Promise<ChooseWikiResult>;
  /** 점검 화면을 닫았다고 기록한다(다음 실행부터 저절로 뜨지 않는다) */
  markSetupSeen(): Promise<SetupStatus>;
  /** 앱을 다시 시작한다(고른 위키 폴더 적용) */
  restartApp(): Promise<void>;

  // ---- 2.8단계(팀 위키 동기화)
  getTeamSync(): Promise<TeamSyncStatus>;
  /** 켜기·끄기·경로 바꾸기. 경로가 틀리면 거부 */
  setTeamSync(input: TeamSyncInput): Promise<TeamSyncStatus>;
  /** 지금 동기화한다(끝날 때까지 기다린다). confirmLarge 는 「많이 지우거나 덮어쓰기」 확인 뒤에만 */
  runTeamSync(confirmLarge?: boolean): Promise<TeamSyncStatus>;
  /** 내 PC 팀 위키를 연다 — obsidian: Obsidian 볼트로 · folder: 탐색기로 */
  openTeamWiki(how: 'obsidian' | 'folder'): Promise<void>;
  /** 동기화 상태가 바뀔 때마다 */
  onTeamSync(cb: (status: TeamSyncStatus) => void): () => void;

  // ---- 2.9단계(설정 › 나)
  getMe(): Promise<MeInfo>;
  /** 이름·다른 표기를 저장한다(검사에 걸리면 거부). 다시 시작 없이 바로 적용 */
  saveMe(settings: MeSettings): Promise<MeInfo>;

  // ---- 2.9단계(팀 위키 할 일)
  getTeamTasks(): Promise<TeamTaskBoard>;
  /** 팀 할 일을 다시 읽을 때마다(동기화·사본 변경·설정 › 나 저장·쓰기 뒤) */
  onTeamTasks(cb: (board: TeamTaskBoard) => void): () => void;
  /** 팀 위키 사본의 그 줄에 상태·담당·기한을 쓴다. NAS 로 올리는 것은 동기화가 한다 */
  saveTeamTask(input: SaveTeamTaskInput): Promise<SaveTeamTaskOutput>;
  /** 팀 사본 기준 상대경로의 문서를 Obsidian 에서 연다 */
  openTeamDoc(relPath: string): Promise<void>;

  // ---- 2.9단계(알림 N1)
  getNotifySettings(): Promise<NotifySettings>;
  /** 설정 › 알림 저장(검사에 걸리면 거부). 다시 시작 없이 바로 적용 */
  saveNotifySettings(settings: NotifySettings): Promise<NotifySettings>;
  /** 그 종류를 바로 끈다(알림함의 [이런 알림 끄기]) */
  muteNotifyKind(kind: NotifyKind): Promise<NotifySettings>;
  getInbox(): Promise<InboxState>;
  /** 알림함이 바뀔 때마다 */
  onInbox(cb: (inbox: InboxState) => void): () => void;
  /** 'all' 이면 모두 읽음 */
  markInboxRead(ids: 'all' | string[]): Promise<InboxState>;
  /** 읽음으로 바꾸고 그 항목의 대상으로 간다(main 이 setMode) */
  openInboxItem(id: string): Promise<void>;

  // ---- 2.12단계(알림 N2) — 없으면(옛 preload) [나중에]·창 묶음을 숨긴다
  /** 긴급·안 읽은 항목을 미룬다(그 밖의 id 는 건너뛴다) */
  snoozeInboxItems?(input: { ids: string[]; until: SnoozeKind }): Promise<InboxState>;
  getShellSettings?(): Promise<ShellSettings>;
  saveShellSettings?(settings: ShellSettings): Promise<ShellSettings>;

  // ---- 2.10단계(메일함) — 없으면(옛 preload) 메뉴·사이드바 블록을 숨긴다
  getMailbox?(): Promise<MailboxSummary>;
  /** 색인·상태·연결이 바뀔 때마다(요약만 — 목록은 revision 을 보고 다시 부른다) */
  onMailbox?(cb: (summary: MailboxSummary) => void): () => void;
  /** 증분 색인을 기다린 뒤의 요약 */
  refreshMailbox?(): Promise<MailboxSummary>;
  listMailThreads?(query: MailThreadQuery): Promise<MailThreadPage>;
  getMailThread?(threadId: string): Promise<MailThreadDetail | null>;
  /** 메일 키 → 그 메일의 스레드(view:mail:<키> 열기용) */
  findMailThread?(key: MailKey): Promise<{ threadId: string } | null>;
  getMailMessage?(path: string): Promise<MailMessage | null>;
  /** 로컬 LLM 메일 분석(2.16) */
  getMailAnalysis?(key: MailKey): Promise<MailAnalysisView>;
  /** 분석(force 면 다시) — 끝난 뒤의 결과 */
  analyzeMail?(input: { key: MailKey; force: boolean }): Promise<MailAnalysisView>;
  onMailAnalysis?(cb: (e: { key: MailKey }) => void): () => void;
  /** 원본 보기(2.15) — remote 면 외부 그림도 main 이 받아 넣는다. 원본이 없으면 null */
  getMailHtml?(input: { path: string; remote: boolean }): Promise<MailHtmlView | null>;
  setMailState?(input: SetMailStateInput): Promise<MailboxSummary>;
  /** 첨부를 탐색기에서 보인다(열지 않는다) */
  revealMailAttachment?(input: { path: string; index: number }): Promise<void>;
  getMailReplyContext?(path: string): Promise<ReplyContext | null>;
  draftMailReply?(input: MailReplyDraftInput): Promise<ReplyDraft>;
  sendMailReply?(input: SendMailReplyInput): Promise<SendMailReplyOutput>;
  getMailVocCreateContext?(path: string): Promise<MailVocCreateContext | null>;
  createMailVocTicket?(input: MailVocCreateInput): Promise<VocCreateResult>;
  createMailTask?(input: CreateMailTaskInput): Promise<CreateMailTaskOutput>;
  /** 2.14: 메일(또는 스레드)을 위키 반영 대기열에 넣는다. 없으면(옛 preload) [위키에 반영] 버튼을 숨긴다 */
  queueMailForWiki?(input: QueueMailInput): Promise<QueueMailResult>;
  /** 2.14: 이 버전이 모르는 kind 의 대기 항목 수(새 버전이 넣은 것 — 그대로 보관한다) */
  getQueueUnknownCount?(): Promise<number>;

  // ---- 3a단계(위키 검색·미리보기·변경 피드) — 없으면(옛 preload) 메뉴·상태 줄 칸을 숨긴다
  getWikiDocs?(): Promise<WikiDocsSummary>;
  /** 색인·읽음 기록이 바뀔 때마다(요약만 — 목록·결과는 revision 을 보고 다시 부른다) */
  onWikiDocs?(cb: (summary: WikiDocsSummary) => void): () => void;
  /** 두 출처 증분 색인을 기다린 뒤의 요약 */
  refreshWikiDocs?(): Promise<WikiDocsSummary>;
  searchWiki?(query: WikiSearchQuery): Promise<WikiSearchPage>;
  /** 빈 질의 화면의 최근 바뀐 문서(mtime 순 — 읽음과 무관) */
  recentWikiDocs?(input: { source: WikiSearchSource; limit: number }): Promise<WikiDocRef[]>;
  getWikiPage?(input: WikiDocInput): Promise<WikiPage | null>;
  /** 문서 page 의 그림 참조 ref → data: URL(경로를 보내지 않는다) */
  getWikiImage?(input: { source: WikiDocSource; page: string; ref: string }): Promise<WikiImageResult>;
  getWikiChanges?(input: { source: WikiDocSource; offset: number; limit: number }): Promise<WikiChangesPage>;
  /** log.md 최근 14일(최대 50) */
  getWikiLogRecent?(): Promise<WikiLogEntry[]>;
  markWikiSeen?(input: MarkWikiSeenInput): Promise<MarkWikiSeenOutput>;
  /** markWikiSeen 의 undoToken 으로 되돌린다(60초 안) */
  undoWikiSeen?(token: string): Promise<WikiDocsSummary>;
  /** http(s) 주소를 기본 브라우저로(확인 대화상자 뒤에만 부른다) */
  openExternalLink?(url: string): Promise<void>;

  // ---- 2.13단계(설정 나머지 6칸) — 없으면(옛 preload) 그 칸을 숨긴다
  /** 칸 하나의 값·출처(비밀은 저장됨/없음만) */
  getSettings?(section: SettingsSection): Promise<SettingsSectionView>;
  /** 바뀐 필드만 보낸다(null = 내 값을 지움). 환경 변수로 잠긴 필드는 무시하고 ignored 로 알린다 */
  saveSettings?(section: SettingsSection, patch: SettingsPatch): Promise<SettingsSaveResult>;
  /** 저장 전 초안 값으로 연결 시험(비밀이 비면 저장된 것). 저장하지 않는다 */
  testSettings?(section: TestableSection, draft: SettingsPatch): Promise<ConnectionTestResult>;
  /** 위키 _mail-ingest/.env 계정을 설정으로 옮긴다(.env 는 그대로) */
  importDotEnvAccount?(): Promise<SettingsSectionView>;
  getTeamDefaults?(opts?: { refresh?: boolean }): Promise<TeamDefaultsView>;
  /** 폴더 고르기(경로만 돌려준다 — [저장]으로 확정). 취소면 null */
  pickFolder?(purpose: 'personalWiki' | 'teamLocal'): Promise<string | null>;
  /** VOC 로그아웃(세션 파일을 지운다) */
  vocLogout?(): Promise<void>;
  getAppInfo?(): Promise<AppInfo>;
  checkForUpdate?(): Promise<UpdateCheckResult>;
  openAppFolder?(which: 'data' | 'logs'): Promise<void>;
  /** 진단 정보 글(비밀·메일 본문 없음) */
  getDiagnostics?(): Promise<string>;
  /** 저장 대화상자(main) → 설정 내보내기 파일 */
  exportSettings?(): Promise<{ saved: boolean; path?: string }>;
  /** 열기 대화상자(main) → 미리보기. 취소면 null */
  previewSettingsImport?(): Promise<SettingsImportPreview | null>;
  applySettingsImport?(token: string, sections: string[]): Promise<{ applied: string[] }>;
  /** 설정이 바뀔 때마다(저장·가져오기·팀 기본값 다시 읽음) */
  onSettingsChanged?(cb: (e: { section: string }) => void): () => void;

  // ---- 2.15단계(메일을 위키 밖으로) — 없으면(옛 preload) 칸의 수집 줄을 숨긴다
  getMailCollect?(): Promise<MailCollectStatus>;
  /** 지금 받기(돌고 있으면 그 회차가 끝난 뒤의 상태) */
  collectMailNow?(): Promise<MailCollectStatus>;
  onMailCollect?(cb: (status: MailCollectStatus) => void): () => void;
}

// ---- 2.15단계(메일을 위키 밖으로 — docs/stage2.15-contract.md) -------------------------------------

/** 수집기 상태(설정 › 메일 받기 칸·방송) */
export interface MailCollectStatus {
  /** off 수집 꺼짐 · noAccount 계정 없음 · idle 쉬는 중 · collecting 받는 중 · error 마지막 회차 실패 */
  state: 'off' | 'noAccount' | 'idle' | 'collecting' | 'error';
  problem?: string;
  /** 받은 UIDL 수 */
  seen: number;
  lastRun?: string;
  lastOk?: string;
  /** 마지막 회차에 새로 저장한 통수 */
  lastCount?: number;
  lastError?: string;
  /** 다음 회차(ISO) */
  nextAt?: string;
  progress?: { done: number; total: number };
  store: {
    /** 메일을 쌓는 곳(앱 데이터 메일 보관소 기준 폴더 — 그 안에 raw/mail) */
    newMail: string;
  };
}


declare global {
  interface Window {
    radar: RadarAPI;
  }
}
