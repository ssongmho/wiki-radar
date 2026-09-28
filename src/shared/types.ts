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
  /** 안정 ID. 큐레이션 항목 'i:'+sha1(제목) 앞 12자, 체크박스 'c:'+sha1(파일|핵심문구) 앞 12자. */
  id: string;
  /** curated = _todo-sync/items.json 항목, checkbox = 위키 체크박스에서 새로 잡은 항목 */
  source: 'curated' | 'checkbox';
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
  /** task = 할 일 처리 결과, decision = 판단 대기함 결정(3단계) */
  kind: 'task' | 'decision';
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
  skipped?: { title: string; reason: string }[];
  error?: string;
  /** 진행 기록(최근 50줄, 사람이 읽는 문장) */
  log: string[];
}

/** preload 가 window.radar 로 노출하는 API. renderer 는 이것만 쓴다(파일 접근 없음). */
export interface RadarAPI {
  getSnapshot(): Promise<Snapshot>;
  /** 위키가 바뀌어 스냅샷이 새로 만들어질 때마다 호출. 반환값은 구독 해제 함수 */
  onSnapshot(cb: (s: Snapshot) => void): () => void;
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
}

declare global {
  interface Window {
    radar: RadarAPI;
  }
}
