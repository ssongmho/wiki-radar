// 앱 시작점: 한 번만 실행, 창 2종(사이드바·풀스크린), 전역 단축키, 위키·날짜 감시, 반영 대기열·claude 실행.
// 계약: docs/stage1-contract.md §5, docs/stage2-contract.md §2·§7. 트레이·자동 시작은 4단계라 여기 없다.
import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, globalShortcut, powerMonitor, screen, type Rectangle, type WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import type { Snapshot, WindowMode } from '../shared/types';
import {
  DATE_CHECK_INTERVAL_MS,
  FULL_HEIGHT,
  FULL_WIDTH,
  PARTIAL_RETRY_INITIAL_MS,
  PARTIAL_RETRY_MAX_MS,
  SIDEBAR_WIDTH,
  TOGGLE_SHORTCUT,
  WATCH_DEBOUNCE_MS,
  WATCH_RETRY_MS,
  WATCHED_SPECIAL_FILES,
  WINDOW_BACKGROUND,
  currentToday,
  findClaudePath,
  loadConfig,
  resolveDataDir,
} from './config';
import { installSecurityGuards, secureDefaultSession, secureWebPreferences } from './security';
import { ReflectController, SnapshotService, broadcastSnapshot, registerIpc, type WindowControl } from './ipc';
import { QueueStore } from './queue';
import { ReflectHistory } from './reflect';
import { createRetryBackoff, startDateWatcher, startWikiWatcher, type DateWatcher, type WikiWatcher } from './watcher';
import { EXCLUDED_DIRS } from './wiki/fsutil';

const LOG = '[wiki-radar]';
const config = loadConfig();

// 사용자 데이터 폴더는 한 번만 실행 잠금의 기준이라 잠금보다 먼저 정한다.
if (config.userDataDir) app.setPath('userData', config.userDataDir);

if (!app.requestSingleInstanceLock()) {
  // 이미 떠 있는 앱이 second-instance 를 받아 자기 창을 보여준다.
  app.quit();
} else {
  start();
}

function start(): void {
  for (const w of config.warnings) console.warn(`${LOG} ${w}`);
  console.log(`${LOG} 위키: ${config.wikiRoot}${config.fixedToday ? ` · 오늘 고정: ${config.fixedToday}` : ''}`);

  app.setAppUserModelId('wiki-radar');
  installSecurityGuards();

  let sidebar: BrowserWindow | null = null;
  let full: BrowserWindow | null = null;
  let mode: WindowMode = 'sidebar';
  /** quit() 으로 끝내는 중인가. 아니면 창 닫기는 숨기기로 바뀐다 */
  let quitting = false;
  /** 풀스크린 화면이 다 불러와졌는가(focusTask 를 보낼 수 있는가) */
  let fullLoaded = false;
  let pendingFocusTaskId: string | null = null;
  /** 마지막으로 사이드바를 제자리에 놓은 위치. 사용자가 옮기지 않았는지 알아보는 데 쓴다 */
  let sidebarPlacedAt: Rectangle | null = null;
  let wikiWatcher: WikiWatcher | null = null;
  let dateWatcher: DateWatcher | null = null;

  const getToday = () => currentToday(config);

  // ---- 반영 대기열·claude 실행(2단계) -----------------------------------------
  // 데이터 폴더: WIKI_RADAR_DATA → WIKI_RADAR_USER_DATA → Electron 사용자 데이터 폴더(명세 §7).
  // 저장소는 처음 쓸 때 연다 — 데이터 폴더에 문제가 있어도 1단계 기능(할 일 보기)은 뜬다.
  const dataDir = resolveDataDir(config, app.getPath('userData'));
  const warnData = (message: string) => console.warn(`${LOG} ${message}`);
  const queueStore = lazy('반영 대기열', () => new QueueStore(dataDir, warnData));
  const reflectHistory = lazy('반영 실행 기록', () => new ReflectHistory(dataDir, warnData));
  const reflect = new ReflectController({
    wikiRoot: config.wikiRoot,
    queue: queueStore,
    history: reflectHistory,
    getClaudePath: () => findClaudePath(),
  });
  {
    const claude = findClaudePath();
    console.log(
      `${LOG} 데이터 폴더: ${dataDir} · claude: ${claude.path} (${claude.source}${claude.exists ? '' : ', 파일 없음'})`,
    );
  }

  /** 부분 스냅샷(잠긴 파일 등)·재생성 실패는 2초 → 4초 → … → 1분 간격으로 다시 만들어 보낸다 */
  const partialRetry = createRetryBackoff({
    initialMs: PARTIAL_RETRY_INITIAL_MS,
    maxMs: PARTIAL_RETRY_MAX_MS,
    fn: () => refreshAndBroadcast(),
  });
  const snapshots = new SnapshotService({
    wikiRoot: config.wikiRoot,
    holidays: config.holidays,
    getToday,
    onBuilt: (snapshot) => {
      if (snapshot.partial) {
        console.warn(`${LOG} 읽지 못한 파일이 있어 목록이 불완전함 — ${partialRetry.nextDelayMs() / 1000}초 뒤 다시 읽음`);
        partialRetry.schedule();
      } else {
        partialRetry.reset();
      }
    },
  });

  /**
   * 스냅샷을 다시 만들어 두 창에 보낸다. 만들지 못하면(폴더가 사라진 경우 등) 백오프로 다시 시도한다.
   * 처리 결과 저장 직후에도 부른다(감시를 기다리지 않고 바로). 만든 스냅샷, 실패면 null.
   */
  function refreshAndBroadcast(): Snapshot | null {
    const snapshot = snapshots.refresh();
    if (!snapshot) {
      partialRetry.schedule();
      return null;
    }
    broadcastSnapshot(snapshot);
    return snapshot;
  }

  const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed();

  // ---- 배치 ---------------------------------------------------------------

  function sidebarBounds(): Rectangle {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - SIDEBAR_WIDTH, y: wa.y, width: SIDEBAR_WIDTH, height: wa.height };
  }

  function fullBounds(): Rectangle {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.min(FULL_WIDTH, wa.width);
    const height = Math.min(FULL_HEIGHT, wa.height);
    return {
      x: wa.x + Math.round((wa.width - width) / 2),
      y: wa.y + Math.round((wa.height - height) / 2),
      width,
      height,
    };
  }

  function sameRect(a: Rectangle, b: Rectangle): boolean {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  /** 창이 어느 화면의 작업 영역과도 겹치지 않으면(모니터를 뺀 경우 등) 거짓 */
  function onSomeDisplay(r: Rectangle): boolean {
    return screen.getAllDisplays().some(({ workArea: wa }) => {
      return r.x < wa.x + wa.width && r.x + r.width > wa.x && r.y < wa.y + wa.height && r.y + r.height > wa.y;
    });
  }

  function placeSidebar(): void {
    if (!alive(sidebar)) return;
    sidebar.setBounds(sidebarBounds());
    sidebarPlacedAt = sidebar.getBounds();
  }

  /** 화면 구성이 바뀌면 — 사용자가 옮기지 않은 사이드바, 화면 밖으로 밀려난 창을 제자리로 */
  function onDisplaysChanged(): void {
    if (alive(sidebar)) {
      const cur = sidebar.getBounds();
      const untouched = sidebarPlacedAt !== null && sameRect(cur, sidebarPlacedAt);
      if (untouched || !onSomeDisplay(cur)) placeSidebar();
    }
    if (alive(full) && !onSomeDisplay(full.getBounds())) full.setBounds(fullBounds());
  }

  // ---- 창 ----------------------------------------------------------------

  function loadRenderer(win: BrowserWindow, which: WindowMode): void {
    const devUrl = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : '';
    const loading = devUrl
      ? win.loadURL(`${devUrl}?mode=${which}`)
      : win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), {
          query: { mode: which },
        });
    loading.catch((err: unknown) => {
      console.error(`${LOG} 화면을 불러오지 못함(${which}):`, err);
    });
  }

  /** 화면 프로세스가 죽으면 다시 불러온다(연달아 죽으면 되풀이하지 않는다). */
  function reloadOnCrash(win: BrowserWindow, which: WindowMode): void {
    let lastReload = 0;
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`${LOG} 화면 프로세스 종료(${which}): ${details.reason}`);
      if (quitting || details.reason === 'clean-exit' || win.isDestroyed()) return;
      const now = Date.now();
      if (now - lastReload < 10_000) return;
      lastReload = now;
      loadRenderer(win, which);
    });
  }

  /**
   * Windows 로그오프·종료 때는 닫기를 막지 않는다. 이때는 before-quit·will-quit 이 오지 않으므로
   * 돌고 있는 claude 도 여기서 끝낸다.
   */
  function allowCloseOnSessionEnd(win: BrowserWindow): void {
    win.on('session-end', () => {
      quitting = true;
      reflect.stopForQuit();
    });
  }

  const preloadPath = path.join(__dirname, 'preload.js');

  function createSidebar(): BrowserWindow {
    const win = new BrowserWindow({
      ...sidebarBounds(),
      title: 'wiki-radar',
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: WINDOW_BACKGROUND,
      show: false,
      webPreferences: secureWebPreferences(preloadPath),
    });
    sidebarPlacedAt = win.getBounds();

    // 첫 화면이 그려지면 사이드바만 보인다. 화면이 늦거나 실패해도 창은 보이게 한다.
    let shown = false;
    const showOnce = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      if (mode === 'sidebar') win.show();
    };
    win.once('ready-to-show', showOnce);
    setTimeout(showOnce, 5_000);

    // 창 닫기(Alt+F4)는 종료가 아니다 — 숨기기만 하고 Ctrl+Alt+R·다시 실행으로 되살린다.
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
    });
    allowCloseOnSessionEnd(win);
    reloadOnCrash(win, 'sidebar');
    loadRenderer(win, 'sidebar');
    return win;
  }

  function createFull(): BrowserWindow {
    const win = new BrowserWindow({
      ...fullBounds(),
      title: 'wiki-radar',
      autoHideMenuBar: true,
      backgroundColor: WINDOW_BACKGROUND,
      show: false,
      webPreferences: secureWebPreferences(preloadPath),
    });

    win.webContents.on('did-start-loading', () => {
      fullLoaded = false;
    });
    win.webContents.on('did-finish-load', () => {
      fullLoaded = true;
      if (pendingFocusTaskId !== null) {
        const id = pendingFocusTaskId;
        pendingFocusTaskId = null;
        win.webContents.send(IPC.focusTask, id);
      }
    });

    // 풀스크린 닫기 → 종료가 아니라 사이드바로.
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      setMode('sidebar');
    });
    allowCloseOnSessionEnd(win);
    reloadOnCrash(win, 'full');
    loadRenderer(win, 'full');
    return win;
  }

  // ---- 모드 --------------------------------------------------------------

  function sendFocusTask(taskId: string): void {
    if (!alive(full)) return;
    if (!fullLoaded || full.webContents.isLoading()) {
      pendingFocusTaskId = taskId; // did-finish-load 뒤에 보낸다
      return;
    }
    full.webContents.send(IPC.focusTask, taskId);
  }

  function setMode(next: WindowMode, focusTaskId?: string): void {
    if (!alive(sidebar) || !alive(full)) return;
    mode = next;
    if (next === 'full') {
      if (!onSomeDisplay(full.getBounds())) full.setBounds(fullBounds());
      if (full.isMinimized()) full.restore();
      full.show();
      full.focus();
      sidebar.hide();
      if (focusTaskId) sendFocusTask(focusTaskId);
    } else {
      if (!onSomeDisplay(sidebar.getBounds())) placeSidebar();
      sidebar.show();
      full.hide();
    }
  }

  /** Ctrl+Alt+R: 보이는 창을 바꾼다. 지금 모드의 창이 숨어 있으면(닫기로 숨긴 경우) 그 창을 되살린다. */
  function toggleMode(): void {
    const current = mode === 'sidebar' ? sidebar : full;
    if (alive(current) && !current.isVisible()) {
      setMode(mode);
      return;
    }
    setMode(mode === 'sidebar' ? 'full' : 'sidebar');
  }

  function togglePin(): boolean {
    if (!alive(sidebar)) return false;
    const next = !sidebar.isAlwaysOnTop();
    sidebar.setAlwaysOnTop(next);
    return next;
  }

  function quitApp(): void {
    quitting = true;
    app.quit();
  }

  const windowControl: WindowControl = {
    isAppContents(contents: WebContents): boolean {
      return [sidebar, full].some((w) => alive(w) && w.webContents.id === contents.id);
    },
    modeOf(contents: WebContents): WindowMode {
      if (alive(full) && full.webContents.id === contents.id) return 'full';
      if (alive(sidebar) && sidebar.webContents.id === contents.id) return 'sidebar';
      return mode;
    },
    setMode,
    togglePin,
    quit: quitApp,
  };

  // ---- 수명 --------------------------------------------------------------

  app.on('second-instance', () => {
    // 두 번째 실행 → 지금 모드의 창을 앞으로.
    setMode(mode);
    const current = mode === 'sidebar' ? sidebar : full;
    if (alive(current)) current.focus();
  });

  app.on('before-quit', () => {
    quitting = true;
    // claude 가 돌고 있으면 끝낸다(Windows 는 부모가 끝나도 자식을 끝내지 않는다 — 앱을 끈 뒤에도 위키를 고치게 된다).
    reflect.stopForQuit();
  });
  // 어떤 경로로 끝나든(예외로 인한 종료 포함) 마지막으로 한 번 더. 동기 호출만 한다.
  process.once('exit', () => reflect.stopForQuit());

  // 창이 모두 닫혀도 스스로 끝내지 않는다(종료는 quit() 으로만). 이 수신기가 있으면 기본 종료가 꺼진다.
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('will-quit', () => {
    reflect.stopForQuit();
    globalShortcut.unregisterAll();
    partialRetry.stop();
    dateWatcher?.stop();
    dateWatcher = null;
    void wikiWatcher?.close();
    wikiWatcher = null;
  });

  app
    .whenReady()
    .then(() => {
      secureDefaultSession();

      registerIpc({
        wikiRoot: config.wikiRoot,
        snapshots,
        windows: windowControl,
        getToday,
        refreshSnapshot: refreshAndBroadcast,
        queue: queueStore,
        reflect,
      });

      sidebar = createSidebar();
      full = createFull();

      try {
        if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleMode)) {
          console.warn(`${LOG} 전역 단축키 ${TOGGLE_SHORTCUT} 를 등록하지 못함(다른 프로그램이 쓰는 중일 수 있음)`);
        }
      } catch (err) {
        console.warn(`${LOG} 전역 단축키 ${TOGGLE_SHORTCUT} 등록 오류:`, err);
      }

      screen.on('display-metrics-changed', onDisplaysChanged);
      screen.on('display-added', onDisplaysChanged);
      screen.on('display-removed', onDisplaysChanged);

      if (!fs.existsSync(config.wikiRoot)) {
        console.warn(`${LOG} 위키 폴더가 없습니다: ${config.wikiRoot} — ${WATCH_RETRY_MS / 1000}초마다 다시 확인함`);
      }
      // 루트가 없으면 감시기가 주기적으로 확인해 생기면 감시를 시작하고 onSettled 로 스냅샷을 만들어 보낸다.
      wikiWatcher = startWikiWatcher({
        wikiRoot: config.wikiRoot,
        excludedDirs: EXCLUDED_DIRS,
        specialFiles: WATCHED_SPECIAL_FILES,
        debounceMs: WATCH_DEBOUNCE_MS,
        retryMs: WATCH_RETRY_MS,
        onSettled: refreshAndBroadcast,
        onWatching: ({ late }) => {
          if (late) console.log(`${LOG} 위키 폴더 감시를 (다시) 시작함: ${config.wikiRoot}`);
        },
        onError: (err) => console.warn(`${LOG} 위키 감시 오류(다시 붙기를 시도함):`, err),
      });
      dateWatcher = startDateWatcher({
        intervalMs: DATE_CHECK_INTERVAL_MS,
        getToday,
        onChange: (today) => {
          console.log(`${LOG} 날짜가 바뀜: ${today}`);
          refreshAndBroadcast();
        },
      });
      // 절전에서 깨어나면 1분을 기다리지 않고 바로 날짜를 본다.
      powerMonitor.on('resume', () => dateWatcher?.checkNow());
    })
    .catch((err: unknown) => {
      console.error(`${LOG} 시작 실패:`, err);
      quitApp();
    });
}

/**
 * 처음 부를 때 만든다. 만들지 못하면 사람이 읽을 문장으로 던지고, 다음에 부를 때 다시 시도한다.
 * (데이터 폴더를 만들 수 없는 경우 등 — 그 기능만 실패하고 앱은 뜬다.)
 */
function lazy<T>(what: string, make: () => T): () => T {
  let value: T | undefined;
  let made = false;
  return () => {
    if (made) return value as T;
    try {
      value = make();
      made = true;
      return value;
    } catch (err) {
      throw new Error(`${what}을(를) 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
