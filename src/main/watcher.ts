// 위키 변경 감시 + 날짜 변경 감시 + 재시도 백오프. 계약: docs/stage1-contract.md §5
// OneDrive 폴더라 폴링은 쓰지 않는다(파일마다 stat 을 되풀이하면 동기화 클라이언트가 바빠진다).
//
// 감시는 fs.watch(wikiRoot, { recursive: true }) 하나로 한다(Windows: ReadDirectoryChangesW 핸들 하나).
// chokidar 는 폴더마다 fs.watch 핸들을 여는데, 자식 폴더에 열린 디렉터리 핸들은 부모 폴더의 이름 바꾸기·옮기기를
// Windows 가 EPERM 으로 막게 한다 — 앱이 떠 있는 동안 Obsidian·탐색기에서 wiki/topics 같은 폴더를 정리할 수 없었다.
// 루트에 핸들 하나만 있으면 루트 안의 폴더 정리는 모두 된다.
import fs from 'node:fs';
import path from 'node:path';
import { errCode } from './wiki/fsutil';

export interface WikiWatcherOptions {
  /** 감시할 볼트 절대경로 */
  wikiRoot: string;
  /** 경로 조각이 이 이름이면 그 아래는 보지 않는다 */
  excludedDirs: Iterable<string>;
  /** 제외 폴더 안이지만 봐야 하는 파일(볼트 기준 상대경로, '/') */
  specialFiles: readonly string[];
  /** 마지막 변경 뒤 이만큼 조용하면 onSettled 를 부른다 */
  debounceMs: number;
  /** 변경이 가라앉았을 때. 예외를 던져도 감시는 계속된다 */
  onSettled: () => void;
  /** 감시 오류(로그용). 없으면 console.warn */
  onError?: (err: unknown) => void;
  /** 루트가 없거나 감시가 끊겼을 때 다시 붙기를 시도하는 주기(ms). 기본 10초 */
  retryMs?: number;
  /** 감시가 붙었을 때(처음 또는 다시). late 는 시작 시점이 아니라 나중에 붙었다는 뜻 */
  onWatching?: (info: { late: boolean }) => void;
}

export interface WikiWatcher {
  /** 지금 fs.watch 가 살아 있는가 */
  isWatching(): boolean;
  close(): Promise<void>;
}

export const DEFAULT_WATCH_RETRY_MS = 10_000;

/** 볼트 기준 상대경로 조각. 볼트 밖이면 null, 볼트 자신이면 빈 배열. */
function relSegments(wikiRoot: string, p: string): string[] | null {
  const rel = path.relative(wikiRoot, path.resolve(wikiRoot, p));
  if (rel === '') return [];
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(/[\\/]+/).filter(Boolean);
}

/** 감시 경로 판정기. 순수 함수라 시험하기 쉽게 따로 뺐다. */
export function createPathFilter(opts: Pick<WikiWatcherOptions, 'wikiRoot' | 'excludedDirs' | 'specialFiles'>) {
  const excluded = new Set(opts.excludedDirs);
  const specialKeys = new Set(opts.specialFiles.map((f) => f.split('/').filter(Boolean).join('/')));

  /** 스냅샷에 영향을 주는 파일인가(.md 또는 특별 파일. 제외 폴더 안은 특별 파일만) */
  function isRelevantFile(p: string): boolean {
    const segs = relSegments(opts.wikiRoot, p);
    if (!segs || segs.length === 0) return false;
    const key = segs.join('/');
    if (specialKeys.has(key)) return true;
    if (segs.some((s) => excluded.has(s))) return false;
    return key.toLowerCase().endsWith('.md');
  }

  /**
   * 폴더가 생기거나 없어지거나 이름이 바뀌었을 수 있는 이벤트인가(안의 문서 수가 바뀐다).
   * fs.watch 는 폴더 이벤트를 파일 이벤트와 구분해 주지 않으므로: 지금 폴더로 존재하면 폴더,
   * 사라졌고 마지막 조각에 점이 없으면(확장자 없음) 폴더였다고 본다. 제외 폴더는 보지 않는다.
   */
  function isRelevantDirEvent(p: string, exists: (abs: string) => boolean | null): boolean {
    const segs = relSegments(opts.wikiRoot, p);
    if (!segs || segs.length === 0) return false;
    if (segs.some((s) => excluded.has(s))) return false;
    const abs = path.resolve(opts.wikiRoot, p);
    const state = exists(abs);
    if (state === true) return true;
    if (state === false) return !segs[segs.length - 1].includes('.');
    return false;
  }

  return { isRelevantFile, isRelevantDirEvent };
}

/** 경로가 폴더로 존재하면 true, 없으면 false, 파일 등 그 밖이면 null */
function dirState(abs: string): boolean | null {
  try {
    return fs.statSync(abs).isDirectory() ? true : null;
  } catch (err) {
    const code = errCode(err);
    return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
  }
}

/**
 * 위키를 감시하다가 변경이 가라앉으면 onSettled 를 부른다. 시작 시 기존 파일은 알리지 않는다.
 * 루트가 없으면 retryMs 마다 확인해 생기면 감시를 시작하고 onSettled 를 부른다(시작 시 없던 폴더가 늦게 붙는 경우).
 * 감시가 끊기면(루트 삭제·이름 바꾸기 등 EPERM) 같은 주기로 다시 붙이고 onSettled 를 부른다.
 */
export function startWikiWatcher(opts: WikiWatcherOptions): WikiWatcher {
  const root = path.resolve(opts.wikiRoot);
  const { isRelevantFile, isRelevantDirEvent } = createPathFilter({ ...opts, wikiRoot: root });
  const retryMs = opts.retryMs ?? DEFAULT_WATCH_RETRY_MS;
  const reportError =
    opts.onError ??
    ((err: unknown) => {
      console.warn('[wiki-radar] 위키 감시 오류:', err);
    });

  let debounce: NodeJS.Timeout | null = null;
  let retry: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let closed = false;

  const fire = () => {
    debounce = null;
    if (closed) return;
    try {
      opts.onSettled();
    } catch (err) {
      reportError(err);
    }
  };

  const schedule = () => {
    if (closed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(fire, opts.debounceMs);
  };

  const onEvent = (eventType: string, filename: string | Buffer | null) => {
    if (closed) return;
    if (filename === null || filename === undefined) {
      // 이벤트 버퍼가 넘치면 이름 없이 온다 — 무엇이 바뀌었는지 모르니 다시 만든다.
      schedule();
      return;
    }
    const rel = typeof filename === 'string' ? filename : filename.toString('utf8');
    const abs = path.join(root, rel);
    if (isRelevantFile(abs)) {
      schedule();
      return;
    }
    // 폴더째 옮기거나 지우거나 만들면 안의 문서 수가 바뀐다.
    if (eventType === 'rename' && isRelevantDirEvent(abs, dirState)) schedule();
  };

  const detach = () => {
    if (!watcher) return;
    const w = watcher;
    watcher = null;
    try {
      w.close();
    } catch (err) {
      reportError(err);
    }
  };

  const scheduleRetry = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      attach(true);
    }, retryMs);
  };

  /** 감시를 붙인다. 못 붙이면 다음 주기에 다시 시도한다. late 면 붙은 뒤 onSettled 로 놓친 변경을 따라잡는다. */
  const attach = (late: boolean) => {
    if (closed || watcher) return;
    if (dirState(root) !== true) {
      // 루트 없음은 시작 시 index.ts 가 한 번 경고한다. 여기서는 조용히 기다린다.
      scheduleRetry();
      return;
    }
    try {
      const w = fs.watch(root, { recursive: true, persistent: true }, onEvent);
      w.on('error', (err) => {
        // 루트가 지워지거나 이름이 바뀌면 EPERM 이 온다. 핸들은 못 쓰게 되므로 닫고 다시 붙기를 기다린다.
        reportError(err);
        detach();
        schedule();
        scheduleRetry();
      });
      watcher = w;
    } catch (err) {
      reportError(err);
      scheduleRetry();
      return;
    }
    try {
      opts.onWatching?.({ late });
    } catch (err) {
      reportError(err);
    }
    if (late) fire();
  };

  attach(false);

  return {
    isWatching: () => watcher !== null,
    async close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      if (retry) clearTimeout(retry);
      retry = null;
      detach();
    },
  };
}

// ---------------------------------------------------------------------------
// 날짜 변경 감시

export interface DateWatcherOptions {
  intervalMs: number;
  /** 지금의 '오늘'(YYYY-MM-DD) */
  getToday: () => string;
  /** 날짜가 바뀌었을 때. 새 날짜를 받는다 */
  onChange: (today: string) => void;
}

export interface DateWatcher {
  /** 주기를 기다리지 않고 지금 확인한다(절전에서 깨어났을 때 등) */
  checkNow(): void;
  stop(): void;
}

/** 일정 주기로 날짜를 보고 바뀌면 onChange 를 부른다. */
export function startDateWatcher(opts: DateWatcherOptions): DateWatcher {
  let last = opts.getToday();
  const check = () => {
    try {
      const now = opts.getToday();
      if (now !== last) {
        last = now;
        opts.onChange(now);
      }
    } catch (err) {
      console.warn('[wiki-radar] 날짜 확인 오류:', err);
    }
  };
  const handle = setInterval(check, opts.intervalMs);
  return {
    checkNow: check,
    stop() {
      clearInterval(handle);
    },
  };
}

// ---------------------------------------------------------------------------
// 재시도 백오프

export interface RetryBackoffOptions {
  /** 첫 재시도까지의 간격(ms) */
  initialMs: number;
  /** 간격 상한(ms). 매번 두 배로 늘다가 여기서 멈춘다 */
  maxMs: number;
  /** 재시도할 일 */
  fn: () => void;
}

export interface RetryBackoff {
  /** 다음 재시도를 예약한다(이미 예약돼 있으면 그대로 둔다). 부를수록 간격이 늘어난다 */
  schedule(): void;
  /** 성공했을 때: 예약을 지우고 간격을 처음으로 되돌린다 */
  reset(): void;
  /** 지금 예약이 있는가 */
  isPending(): boolean;
  /** 다음 예약에 쓸 간격(ms) */
  nextDelayMs(): number;
  stop(): void;
}

/** 부분 스냅샷(읽지 못한 파일이 있는 것)처럼 곧 나을 수 있는 실패를 지수 백오프로 다시 시도한다. */
export function createRetryBackoff(opts: RetryBackoffOptions): RetryBackoff {
  let delay = opts.initialMs;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  return {
    schedule() {
      if (stopped || timer) return;
      const wait = delay;
      delay = Math.min(opts.maxMs, delay * 2);
      timer = setTimeout(() => {
        timer = null;
        try {
          opts.fn();
        } catch (err) {
          console.warn('[wiki-radar] 재시도 오류:', err);
        }
      }, wait);
    },
    reset() {
      if (timer) clearTimeout(timer);
      timer = null;
      delay = opts.initialMs;
    },
    isPending: () => timer !== null,
    nextDelayMs: () => delay,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
