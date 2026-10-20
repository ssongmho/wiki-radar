// 팀 위키 할 일 서비스(2.9단계 명세 §3) — 언제 다시 읽을지와 마지막 보드 보관. electron 을 import 하지 않는다.
//
// 다시 읽는 때: 시작 · 팀 동기화가 받음·올림·충돌·지움을 끝냈을 때(index.ts) · 사본 폴더 감시(800ms 조용하면) ·
// 날짜가 바뀔 때 · 설정 › 나 저장 · VOC 보드의 내 이름이 바뀔 때 · 팀 할 일을 쓴 직후. 바뀔 때마다 onBoard 로 넘긴다
// (index.ts 가 두 창에 방송하고 내 것만 개인 스냅샷에 합친다).
import type { Holiday, MeSource, Task, TeamTaskBoard } from '../../shared/types';
import { buildTeamBoard, emptyTeamBoard, readTeamTasks, TEAM_TEMPLATES_FILE } from '../wiki/teamTasks';
import { startWikiWatcher, type WikiWatcher } from '../watcher';
import { isDirectory } from '../appSettings';

export interface TeamTaskConfig {
  enabled: boolean;
  /** 팀 위키 사본(teamSync.local) */
  local: string;
  /**
   * 켜져 있어도 쓸 수 없는 설정의 이유(2.8단계 teamSyncConfigProblem — 개인 위키와 겹침 등). 있으면 읽지도 감시하지도 않고
   * error 보드(그 문장)로 둔다 — 개인 위키 안의 파일을 팀 위키 규칙으로 고치지 않게
   */
  problem?: string | null;
}

export interface TeamTaskServiceDeps {
  config: () => TeamTaskConfig;
  /** 나의 이름들(설정 이름 또는 VOC 이름 + 다른 표기) */
  me: () => { names: string[]; source: MeSource };
  today: () => string;
  holidays: readonly Holiday[];
  /** 보드가 바뀔 때마다(같은 내용이면 부르지 않는다) */
  onBoard: (board: TeamTaskBoard) => void;
  log?: (message: string) => void;
  now?: () => Date;
  /** 사본 감시(기본 켬). 시험은 끈다 */
  watch?: boolean;
  /** 감시: 마지막 변경 뒤 조용한 시간(기본 800ms) */
  debounceMs?: number;
  /** 감시: 폴더가 없을 때 다시 붙기를 시도하는 주기(기본 10초) */
  retryMs?: number;
  /** 못 읽은 파일이 있을 때 다시 읽는 간격(기본 5초) */
  partialRetryMs?: number;
  /** 사본 감시가 가라앉을 때마다(3a단계 §3-1 — 위키 문서 색인이 같은 감시를 쓴다) */
  onChanged?: () => void;
}

/** 감시에서 빼는 폴더 이름(읽기의 isTeamSkippedDir 와 같은 뜻 — 감시는 이름 목록만 받는다. 그 밖의 점 폴더 변경은 다시 읽어도 결과가 같다) */
const WATCH_EXCLUDED = ['.휴지통', '.trash', '.git', '#recycle', '@eaDir', '#snapshot', '.obsidian'];

/** 보드 비교용(읽은 시각은 빼고) */
function boardKey(board: TeamTaskBoard): string {
  const { generatedAt: _ignored, ...rest } = board;
  return JSON.stringify(rest);
}

export class TeamTaskService {
  private current: TeamTaskBoard;
  private key = '';
  private watcher: WikiWatcher | null = null;
  private watchedLocal: string | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly deps: TeamTaskServiceDeps) {
    this.current = emptyTeamBoard('off', deps.me());
  }

  /** 마지막 보드 */
  board(): TeamTaskBoard {
    return this.current;
  }

  /** 내 것만(개인 스냅샷에 합칠 것) */
  mine(): Task[] {
    return this.current.tasks.filter((t) => t.team?.mine === true);
  }

  start(): void {
    this.stopped = false;
    this.reconfigure();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.unwatch();
  }

  /** 설정이 바뀌었을 때(켜기·끄기·경로) — 감시를 다시 걸고 다시 읽는다 */
  reconfigure(): void {
    if (this.stopped) return;
    const cfg = this.deps.config();
    if (!cfg.enabled || cfg.problem) this.unwatch();
    else this.watch(cfg.local);
    this.reload('설정');
  }

  /** 지금 다시 읽는다. 바뀌었으면 onBoard. 새 보드 */
  reload(why = ''): TeamTaskBoard {
    const cfg = this.deps.config();
    const me = this.deps.me();
    let board: TeamTaskBoard;
    if (!cfg.enabled) {
      board = emptyTeamBoard('off', me);
    } else if (cfg.problem) {
      board = emptyTeamBoard('error', me, `팀 위키 설정을 쓸 수 없습니다: ${cfg.problem} — 설정 › 점검에서 고치세요`);
    } else if (!isDirectory(cfg.local)) {
      board = emptyTeamBoard('missing', me, '팀 위키 사본이 아직 없습니다 — 설정 › 점검에서 지금 동기화하세요');
    } else {
      try {
        const read = readTeamTasks({ root: cfg.local, today: this.deps.today(), holidays: this.deps.holidays, names: me.names });
        board = buildTeamBoard(read, me, (this.deps.now?.() ?? new Date()).toISOString());
      } catch (err) {
        board = emptyTeamBoard('error', me, `팀 위키 할 일을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const key = boardKey(board);
    this.scheduleRetry(board);
    if (key === this.key) return this.current;
    this.key = key;
    this.current = board;
    if (board.state === 'ok' || why) {
      this.deps.log?.(
        `팀 위키 할 일 ${board.state === 'ok' ? `${board.totals.open}건(내 것 ${board.totals.mine})` : board.state}${why ? ` · ${why}` : ''}`,
      );
    }
    try {
      this.deps.onBoard(board);
    } catch (err) {
      this.deps.log?.(`팀 할 일 보드 전달 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
    return board;
  }

  private scheduleRetry(board: TeamTaskBoard): void {
    if (!board.partial || this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.reload('못 읽은 파일 다시 읽기');
    }, this.deps.partialRetryMs ?? 5_000);
    this.retry.unref?.();
  }

  private watch(local: string): void {
    if (this.deps.watch === false) return;
    if (this.watcher && this.watchedLocal === local) return;
    this.unwatch();
    this.watchedLocal = local;
    this.watcher = startWikiWatcher({
      wikiRoot: local,
      excludedDirs: WATCH_EXCLUDED,
      specialFiles: [TEAM_TEMPLATES_FILE],
      debounceMs: this.deps.debounceMs ?? 800,
      retryMs: this.deps.retryMs ?? 10_000,
      onSettled: () => {
        if (this.stopped) return;
        this.reload();
        try {
          this.deps.onChanged?.();
        } catch (err) {
          this.deps.log?.(`팀 위키 사본 변경 처리 오류: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      onError: (err) => this.deps.log?.(`팀 위키 사본 감시 오류(다시 붙기를 시도함): ${err instanceof Error ? err.message : String(err)}`),
    });
  }

  private unwatch(): void {
    const w = this.watcher;
    this.watcher = null;
    this.watchedLocal = null;
    if (w) void w.close();
  }
}

