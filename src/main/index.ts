// 앱 시작점: 한 번만 실행, 창 2종(사이드바·풀스크린), 전역 단축키, 위키·날짜 감시, 반영 대기열·claude 실행, 메일 회신,
// VOC 보드(voc-cli 폴링). 계약: docs/stage1-contract.md §5, docs/stage2-contract.md §2·§7, docs/stage2.5-contract.md,
// docs/stage2.6-contract.md, 팀 위키 동기화(docs/stage2.8-contract.md), 팀 위키 할 일·알림 N1(docs/stage2.9-contract.md),
// 알림 N2 — 트레이·작업 표시줄 오버레이·[나중에]·Windows 알림 단추·보류(docs/stage2.12-contract.md). 자동 시작은 4단계라 여기 없다.
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Notification,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  type Rectangle,
  type WebContents,
} from 'electron';
import { FOCUS_SETUP_VIEW, IPC, WIKI_PENDING_NONE } from '../shared/ipc';
import { FEATURES } from '../shared/edition';
import { DEFAULT_SHELL_SETTINGS, defaultNotifySettings } from '../shared/notify';
import type {
  AppInfo,
  FieldView,
  ChooseWikiResult,
  ClaudeStatusView,
  ConnectionTestResult,
  ConnectionTestStep,
  SettingsImportPreview,
  InboxState,
  NotifySettings,
  MeInfo,
  MeSettings,
  SaveTeamTaskInput,
  SaveTeamTaskOutput,
  SetupStatus,
  ShellSettings,
  Snapshot,
  SnoozeKind,
  TeamSyncInput,
  TeamSyncStatus,
  TeamTaskBoard,
  WindowMode,
} from '../shared/types';
import { meInfoOf, myNames } from '../shared/team';
import { AppSettingsStore, DEFAULT_TEAM_REMOTE, defaultTeamLocal, isDirectory, resolveWikiRoot, wikiPathProblem } from './appSettings';
import {
  DATE_CHECK_INTERVAL_MS,
  DEFAULT_WIKI_ROOT,
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
  localDateTimeString,
  resolveDataDir,
} from './config';
import { installSecurityGuards, secureDefaultSession, secureWebPreferences } from './security';
import { handleSquirrelEvent } from './squirrel';
import { DEFAULT_UPDATE_URL, checkForUpdateNow, installKind, startAutoUpdate } from './updater';
import {
  ReflectController,
  SnapshotService,
  broadcastInbox,
  broadcastMailbox,
  broadcastSnapshot,
  broadcastSnapshotGone,
  broadcastTeamSync,
  broadcastTeamTasks,
  broadcastVocBoard,
  broadcastWikiDocs,
  broadcastSettingsChanged,
  broadcastMailCollect,
  broadcastMailAnalysis,
  registerIpc,
  type WindowControl,
} from './ipc';
import { QueueStore } from './queue';
import { ReflectHistory } from './reflect';
import { containsSecret, knownSecrets, loadSmtpAccount, type AccountResult } from './mail/account';
import { installLogFile } from './logFile';
import { SecretStore } from './settings/secrets';
import { TEAM_DEFAULTS_CACHE_FILE, TEAM_SETTINGS_REL, TeamDefaultsHolder } from './settings/teamDefaults';
import { SETTINGS_SECTIONS, SettingsService } from './settings/service';
import { SETTINGS_IMPORT_MAX_BYTES, buildSettingsExport, exportFileName, parseSettingsImport } from './settings/export';
import { ImportTokens, buildDiagnostics } from './settings/info';
import { probeHttp } from './settings/tests';
import { MailSettingsStore, SentLog } from './mail/stores';
import { MailboxService } from './mail/mailbox';
import { MailCollector } from './mail/collector';
import { MailAnalyzer } from './ai/mailAnalysis';
import { cancelReplyDraft } from './replyDraft';
import { VOC_DEFAULT_API_URL, VocApiRunner, VocSessionStore, normalizeVocApiUrl } from './voc/api';
import { VocCliRunner, locateVocCli } from './voc/cli';
import { VocService } from './voc/service';
import { VocActionLog, VocSettingsStore } from './voc/settings';
import { TeamSyncService, isInside, teamSyncConfigProblem, type TeamSyncConfig } from './teamSync/service';
import { TeamTaskService } from './teamSync/tasks';
import { TEAM_BACKUP_DIR, applyTeamWriteback, pruneTeamBackups, requireTeamDocPath } from './wiki/teamWriteback';
import { createRetryBackoff, startDateWatcher, startWikiWatcher, type DateWatcher, type WikiWatcher } from './watcher';
import { EXCLUDED_DIRS } from './wiki/fsutil';
import { loadVocWikiPages, vocStaleNote, type VocWikiPages } from './wiki/merge';
import { NotifyService, emptyInbox, type ToastRequest } from './notify/service';
import { NotifyStore, appendNotifyLog } from './notify/store';
import { WikiDocsService } from './wiki/docService';

import { QUNS } from './notify/quiet';
import { createKoffiProbe, fixedProbe, type KoffiLike, type QunsProbe, type QunsRead } from './notify/qunsProbe';
import { problemList, shellViewOf, type ShellPort, type ShellView } from './shell/state';
import { createRecordingPort, createTrayPort, type RecordingPort, type TrayMenuLabel, type TrayPort } from './shell/tray';

/**
 * Windows 알림 단추([열기]·[1시간 뒤]) — 설치본 점검 M1~M4(2.12단계 §12-3)에서 안 되면 false 로: 본문 누르기(열기)만 남기고
 * [나중에]는 알림함에서만 한다. 시험 기록 파일은 이 값과 상관없이 단추 이름을 적는다
 */
const TOAST_ACTIONS = true;
/** Windows 알림 단추 이름 */
const TOAST_ACTION_LABELS = ['열기', '1시간 뒤'] as const;
/** 시험 모드의 보류 상태 이름 → QUNS 값(2.12단계 §8) */
const TEST_QUIET: Record<string, QunsRead> = {
  accepts: { available: true, quns: QUNS.ACCEPTS_NOTIFICATIONS },
  away: { available: true, quns: QUNS.NOT_PRESENT },
  fullscreen: { available: true, quns: QUNS.BUSY },
  presentation: { available: true, quns: QUNS.PRESENTATION_MODE },
  windowsQuiet: { available: true, quns: QUNS.QUIET_TIME },
  unavailable: { available: false, problem: '시험: 감지 없음' },
};

const LOG = '[wiki-radar]';
const config = loadConfig();

// 사용자 데이터 폴더는 한 번만 실행 잠금의 기준이라 잠금보다 먼저 정한다.
if (config.userDataDir) app.setPath('userData', config.userDataDir);

if (handleSquirrelEvent()) {
  // 설치·업데이트·제거 중 — 바로가기만 정리하고 끝난다(창을 띄우지 않음).
} else if (!app.requestSingleInstanceLock()) {
  // 이미 떠 있는 앱이 second-instance 를 받아 자기 창을 보여준다.
  app.quit();
} else {
  start();
}

function start(): void {
  for (const w of config.warnings) console.warn(`${LOG} ${w}`);

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
  /** 위키 검색·변경 피드(3a단계 — 팀 동기화·사본 감시가 먼저 만들어지므로 늦게 묶는다) */
  let wikiDocs: WikiDocsService | null = null;
  /** 트레이·작업 표시줄(2.12단계 §1-6). 창을 만든 뒤 만든다 */
  let shellPort: ShellPort | null = null;
  /** 시험 기록 포트(시험 모드만) */
  let recordingPort: RecordingPort | null = null;
  /** 실제 트레이 포트(시험 모드는 null) — 창을 보일 때 작업 표시줄 오버레이를 다시 건다 */
  let trayPort: TrayPort | null = null;
  /** 마지막으로 만든 스냅샷(트레이 「오늘」 수) */
  let lastSnapshot: Snapshot | null = null;

  const getToday = () => currentToday(config);

  // ---- 반영 대기열·claude 실행(2단계) -----------------------------------------
  // 데이터 폴더: WIKI_RADAR_DATA → WIKI_RADAR_USER_DATA → Electron 사용자 데이터 폴더(명세 §7).
  // 저장소는 처음 쓸 때 연다 — 데이터 폴더에 문제가 있어도 1단계 기능(할 일 보기)은 뜬다.
  const dataDir = resolveDataDir(config, app.getPath('userData'));
  const warnData = (message: string) => console.warn(`${LOG} ${message}`);
  // 위키 폴더: WIKI_RADAR_WIKI → 설정 › 점검에서 고른 폴더(app-settings.json) → 기본 위치(명세 2.7단계 §1).
  // 위키를 쓰는 것들이 모두 시작할 때 이 경로를 받으므로, 점검 화면에서 바꾸면 다시 시작해야 적용된다.
  const appSettings = new AppSettingsStore(dataDir, warnData);
  const testModeEnv = process.env.WIKI_RADAR_TEST_MODE === '1';

  // ---- 로그 파일(2.13단계 §C-6) — console 을 logs/radar-YYYY-MM-DD.log 에도. 줄마다 알려진 비밀을 가린다.
  // WIKI_RADAR_DATA·USER_DATA(시험 등)를 주면 데이터 폴더 안 logs/, 아니면 Electron 로그 폴더
  const logsDir = config.dataDir ? path.join(dataDir, 'logs') : app.getPath('logs');
  /** 설정 칸(아래에서 만든다 — 로그가 먼저 시작한다) */
  let settingsService: SettingsService | null = null;
  let secretsMemo: { at: number; values: string[] } | null = null;
  const logSecrets = (): string[] => {
    const now = Date.now();
    if (secretsMemo && now - secretsMemo.at < 5_000) return secretsMemo.values;
    let values: string[];
    try {
      values = settingsService && app.isReady() ? settingsService.knownSecrets() : knownSecrets(process.env, '');
    } catch {
      values = knownSecrets(process.env, '');
    }
    secretsMemo = { at: now, values };
    return values;
  };
  const logFile = installLogFile({ dir: logsDir, secrets: logSecrets, now: () => config.clock.now() });

  // 위키 폴더: WIKI_RADAR_WIKI → 설정 › 위키 「없음」(자리 표시 경로) → 고른 폴더 → 기본 위치(2.13단계 §C-1)
  const wikiLocation = resolveWikiRoot(process.env, appSettings.get(), DEFAULT_WIKI_ROOT, dataDir);
  config.wikiRoot = wikiLocation.path;
  if (wikiLocation.source === 'none' && fs.existsSync(wikiLocation.path)) {
    console.warn(`${LOG} 개인 위키 「없음」의 자리 표시 폴더가 있습니다(${wikiLocation.path}) — 개인 위키로 쓰지 않습니다(위키 쓰기는 거부)`);
  }

  // ---- 비밀(secrets.bin — 2.13단계 §A-2): safeStorage 로 암호화. 쓸 수 없으면 이번 실행 동안만 메모리에
  const secretStore = new SecretStore(
    dataDir,
    {
      encrypt: (text) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('암호화를 쓸 수 없음');
        return safeStorage.encryptString(text);
      },
      decrypt: (data) => safeStorage.decryptString(data),
    },
    {
      available: () => {
        try {
          return app.isReady() && safeStorage.isEncryptionAvailable();
        } catch {
          return false;
        }
      },
      warn: warnData,
    },
  );

  // ---- 팀 기본값(2.13단계 §B): 처음에는 캐시, 앱 준비 뒤 뒤에서 다시 읽는다
  const teamDefaults = new TeamDefaultsHolder(
    () => {
      const ts = appSettings.get().teamSync;
      return {
        env: process.env,
        teamSync: {
          enabled: ts?.enabled === true,
          remote: ts?.remote ?? DEFAULT_TEAM_REMOTE,
          local: ts?.local ?? defaultTeamLocal(app.getPath('home')),
          configured: !!ts,
        },
        defaultRemote: DEFAULT_TEAM_REMOTE,
        cacheFile: path.join(dataDir, TEAM_DEFAULTS_CACHE_FILE),
        now: () => config.clock.now(),
        testMode: testModeEnv,
        warn: warnData,
      };
    },
    (view) => {
      console.log(`${LOG} 팀 기본값: ${view.source}${view.path ? ` · ${view.path}` : ''}${view.problems.length ? ` · 문제 ${view.problems.join(' / ')}` : ''}`);
      onSettingsChanged('team');
    },
  );
  /** SMTP 계정(설정 › 메일 보내기 → 환경 변수 → .env). 부를 때마다 */
  const smtpAccountNow = (): AccountResult => (settingsService ? settingsService.smtpAccount() : loadSmtpAccount(process.env, config.wikiRoot));
  /** 점검 화면에서 골랐지만 아직 적용하지 않은(다시 시작 전) 위키 폴더 */
  let pendingWikiRoot: string | undefined;
  console.log(
    `${LOG} 위키: ${config.wikiRoot} (${wikiLocation.source})${config.fixedToday ? ` · 오늘 고정: ${config.fixedToday}` : ''}`,
  );
  const queueStore = lazy('반영 대기열', () => new QueueStore(dataDir, warnData));
  const reflectHistory = lazy('반영 실행 기록', () => new ReflectHistory(dataDir, warnData));
  // 메일 회신(2.5단계): 발송 기록(sent-mail.json·sent/)과 보내는 이름·서명(mail-settings.json)도 같은 데이터 폴더에.
  const sentLog = lazy('발송 기록', () => new SentLog(dataDir, warnData));
  const mailSettings = lazy('메일 설정', () => new MailSettingsStore(dataDir, warnData));
  const reflect = new ReflectController({
    wikiRoot: config.wikiRoot,
    queue: queueStore,
    history: reflectHistory,
    getClaudePath: () => findClaudePath(),
    // 2.14: mail 항목을 키로 찾고 반영됨을 적는다(메일함은 아래에서 만든다 — 실행할 때 부른다)
    mailbox: () => mailbox,
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
    // 개인 위키가 없어도 팀 동기화가 켜져 있으면 팀 것만으로 할 일을 만든다(2.9단계 §3). teamSyncConfig 는 아래에서 정의된다
    teamEnabled: () => teamSyncConfig().enabled,
    onCleared: (message) => broadcastSnapshotGone(message),
    onBuilt: (snapshot) => {
      // 어느 경로로 만들었든(화면이 처음 읽을 때 포함) 알림 판정에 넘긴다(2.9단계 §6-5)
      lastSnapshot = snapshot;
      notifyService?.setSnapshot(snapshot);
      recomputeShell();
      noteMailTasks(snapshot);
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
      if (!isDirectory(config.wikiRoot)) notifyService?.noteSnapshotMissing();
      return null;
    }
    publishSnapshot(snapshot);
    return snapshot;
  }

  /** 두 창에 보내고 알림 판정에 넘긴다 */
  function publishSnapshot(snapshot: Snapshot): void {
    lastSnapshot = snapshot;
    broadcastSnapshot(snapshot);
    notifyService?.setSnapshot(snapshot);
    noteMailTasks(snapshot);
    recomputeShell();
  }

  // ---- 메일함(2.10단계) --------------------------------------------------------------
  // raw/mail 을 읽기만 한다(색인 캐시 mail-index.json·상태 mail-state.json 은 데이터 폴더에). 연결(할 일·발송 기록)은
  // 스냅샷이 바뀔 때마다 다시 계산한다 — 색인은 다시 읽지 않는다.
  let mailTasks: Snapshot['tasks'] = [];
  function noteMailTasks(snapshot: Snapshot): void {
    if (snapshot.tasks === mailTasks) return;
    mailTasks = snapshot.tasks;
    mailbox?.relink();
  }
  let mailbox: MailboxService | null = null;

  /** 메일 분석기(2.16) — 아래에서 만든다. 목록 칩(회신 필요 추정)용 */
  let mailAnalyzerRef: MailAnalyzer | null = null;
  mailbox = new MailboxService({
    aiReplyKeys: () => mailAnalyzerRef?.store.replyKeys() ?? new Set(),
    wikiRoot: config.wikiRoot,
    dataDir,
    now: () => config.clock.now(),
    // 내 사본 판정: 2.5 SMTP 계정 주소(비밀번호는 쓰지 않는다). 못 읽으면 '보낸 편지함' 메일함만
    myAddress: () => {
      try {
        const account = smtpAccountNow();
        return account.ok ? account.account.user : undefined;
      } catch {
        return undefined;
      }
    },
    tasks: () => mailTasks,
    sent: () => sentLog().list(),
    onSummary: (summary) => {
      broadcastMailbox(summary);
      // 2.14 §3-4: 메일이 지워지거나 격리되면 반영 대기 화면의 「이번 반영에서 빠집니다」를 바로 고친다
      reflect.refreshBlocked();
    },
    // 2.14: 「위키 반영 대기」 표시(대기열에서 계산 — 저장하지 않는다)
    wikiPending: () => reflect.wikiPending(),
    log: (message) => console.log(`${LOG} ${message}`),
    warn: (message) => console.warn(`${LOG} ${message}`),
  });

  // ---- VOC 보드(2.6단계) -------------------------------------------------------
  // 설정(voc-settings.json)·처리 기록(voc-actions.json)도 같은 데이터 폴더에, 처음 쓸 때 연다.
  const vocSettings = lazy('VOC 설정', () => new VocSettingsStore(dataDir, warnData));
  const vocActions = lazy('VOC 처리 기록', () => new VocActionLog(dataDir, warnData));

  /** voc-cli 위치: WIKI_RADAR_VOC_CLI → 설정 jarPath → 기본 폴더(명세 §1). 설정을 못 읽으면 설정 없이 찾는다 */
  function locateVoc(): ReturnType<typeof locateVocCli> {
    let jarPath: string | undefined;
    try {
      jarPath = vocSettings().get().jarPath;
    } catch (err) {
      console.warn(`${LOG} VOC 설정을 읽지 못해 기본 위치에서 voc-cli 를 찾음:`, err instanceof Error ? err.message : err);
    }
    return locateVocCli({ env: process.env, ...(jarPath ? { jarPath } : {}) });
  }
  // 첨부는 데이터 폴더의 voc-files/<ticketId>/ 에만 받는다(명세 §14 — runner 가 file download 의 --out 을 이 아래로만 허용한다)
  const vocFilesDir = path.join(dataDir, 'voc-files');
  // 기본은 앱이 VOC API 를 직접 부른다(명세 §15 — java·jar 가 필요 없다). WIKI_RADAR_VOC_CLI(jar 또는 시험용 .mjs)를 주면
  // 예전처럼 voc-cli 를 띄운다 — 실행할 때마다 위치를 다시 찾고, 작업 폴더는 데이터 폴더 아래 빈 전용 폴더
  // (java 런처가 인자의 `*`·`?` 를 작업 폴더 파일 이름으로 펼치지 않게).
  const useVocCli = !!process.env.WIKI_RADAR_VOC_CLI?.trim();
  /** VOC 백엔드 주소: WIKI_RADAR_VOC_URL → 설정 apiUrl → 팀 기본값 voc.apiUrl(2.13단계 §C-5) → 기본 */
  const vocApiUrl = (): string => {
    const fromEnv = normalizeVocApiUrl(process.env.WIKI_RADAR_VOC_URL);
    if (fromEnv) return fromEnv;
    try {
      const fromSettings = normalizeVocApiUrl(vocSettings().get().apiUrl);
      if (fromSettings) return fromSettings;
    } catch {
      // 설정을 못 읽으면 팀·기본 주소
    }
    const fromTeam = normalizeVocApiUrl(teamDefaults.values().voc?.apiUrl);
    return fromTeam ?? VOC_DEFAULT_API_URL;
  };
  const vocRunner = useVocCli
    ? new VocCliRunner({ locate: locateVoc, workDir: path.join(dataDir, 'voc-cwd'), downloadRoot: vocFilesDir })
    : new VocApiRunner({
        apiUrl: vocApiUrl,
        // 토큰은 Windows 계정으로 암호화해 둔다. 암호화를 못 쓰면 파일에 쓰지 않는다(앱을 켜 둔 동안만)
        sessions: new VocSessionStore(path.join(dataDir, 'voc-session.bin'), {
          encrypt: (text) => {
            if (!safeStorage.isEncryptionAvailable()) throw new Error('암호화를 쓸 수 없음');
            return safeStorage.encryptString(text);
          },
          decrypt: (data) => safeStorage.decryptString(data),
        }),
        downloadRoot: vocFilesDir,
        appVersion: app.getVersion(),
      });

  /**
   * VOC 고객사·시스템 → 위키 문서 표(link_raw.py 매핑 + wiki/ 아래 문서 이름). 처음 쓸 때 만들고,
   * 위키가 바뀌면(감시) 버려 다음에 다시 만든다.
   */
  let vocWikiPages: VocWikiPages | null = null;
  const vocPageMaps = (): VocWikiPages => {
    vocWikiPages ??= loadVocWikiPages(config.wikiRoot, warnData);
    return vocWikiPages;
  };

  /** 나 찾기 보조: 2.5단계 SMTP 계정 주소(비밀번호는 쓰지 않는다). 못 읽으면 없음 */
  const vocFallbackEmail = (): string | undefined => {
    try {
      const account = smtpAccountNow();
      return account.ok ? account.account.user : undefined;
    } catch {
      return undefined;
    }
  };

  /** 마지막으로 본 VOC 로그인 이름(바뀌면 팀 할 일을 다시 가른다) */
  let lastVocName: string | null = null;
  /** 팀 위키 할 일(아래에서 만든다 — VOC 보드가 먼저 올 수 있어 늦게 묶는다) */
  let teamTasks: TeamTaskService | null = null;
  const vocService = new VocService({
    runner: vocRunner,
    terminalLogin: useVocCli,
    settings: vocSettings,
    actions: vocActions,
    today: getToday,
    holidays: config.holidays,
    pageMaps: vocPageMaps,
    fallbackEmail: vocFallbackEmail,
    filesDir: vocFilesDir,
    // 보드는 두 창에 방송하고, 내 담당 VOC 할 일은 파일을 다시 읽지 않고 스냅샷에 다시 합쳐 방송한다(명세 §5).
    // 새로 받지 못하는 동안 남겨 둔 할 일에는 "VOC 할 일은 10:32 기준" 경고를 붙인다.
    onBoard: (board, tasks) => {
      broadcastVocBoard(board);
      const merged = snapshots.setVocTasks(tasks, vocStaleNote(board, tasks.length, getToday()));
      if (merged) publishSnapshot(merged);
      // 알림(SLA·새 배정·아침 요약 숫자)
      notifyService?.setBoard(board);
      recomputeShell();
      // 설정 › 나의 이름이 비었으면 VOC 로그인 이름이 나의 이름이다 — 바뀌면 팀 할 일의 내 것을 다시 가른다(2.9단계 §3)
      const vocName = board.me?.name ?? null;
      if (vocName !== lastVocName) {
        lastVocName = vocName;
        teamTasks?.reload('VOC 로그인 이름');
      }
    },
  });
  if (useVocCli) {
    const loc = locateVoc();
    console.log(`${LOG} voc-cli: ${loc.ok ? `${loc.kind} · ${[loc.command, ...loc.baseArgs].join(' ')}` : loc.message}`);
  } else {
    console.log(`${LOG} VOC: API 직접 호출 · ${vocApiUrl()}`);
  }

  // ---- 알림 N1(2.9단계 §6~§8) ----------------------------------------------------
  // 시험 모드(WIKI_RADAR_TEST_MODE=1)에서는 Windows 알림 대신 <데이터 폴더>/notify-log.jsonl 에 쓰고, WIKI_RADAR_NOW 가 없으면
  // 서비스를 만들지 않는다 — 기존 e2e 가 실제 시각에 따라 달라지지 않게(§7-2). 서비스는 창을 만든 뒤(whenReady) 만든다.
  const testMode = process.env.WIKI_RADAR_TEST_MODE === '1';
  const notifyEnabled = !testMode || config.clock.fixed;
  let notifyService: NotifyService | null = null;
  /** 보낸 Windows 알림 — 누르기·닫기까지 참조를 들고 있는다(GC 로 클릭이 사라지지 않게) */
  const liveToasts = new Set<Notification>();
  /** toastId → 그 알림의 항목·대상(2.12단계 §3-5 — 최대 50, 오래된 것부터 놓는다) */
  const toastTable = new Map<string, { itemIds: string[]; target: string; snoozable: boolean }>();
  /** 이미 처리한 활성화(인스턴스 이벤트와 handleActivation 이 둘 다 와도 한 번만) */
  const handledToasts = new Set<string>();
  const TOAST_TABLE_MAX = 50;

  const notifySettings = (): NotifySettings => appSettings.get().notify ?? defaultNotifySettings();
  const shellSettings = (): ShellSettings => appSettings.get().shell ?? { ...DEFAULT_SHELL_SETTINGS };

  // ---- 보류 감지(2.12단계 §4) ----------------------------------------------------------
  // 시험 모드는 koffi 를 부르지 않는다 — 상태는 WIKI_RADAR_TEST_QUIET·__radarTest.setQuiet 로만(그 PC 의 전체 화면 여부에 흔들리지 않게)
  let testQuiet: QunsRead = (testMode && TEST_QUIET[process.env.WIKI_RADAR_TEST_QUIET ?? '']) || TEST_QUIET.accepts;
  const quietProbe: QunsProbe = testMode
    ? fixedProbe(() => testQuiet)
    : createKoffiProbe(loadKoffi, (message) => console.warn(`${LOG} ${message}`));

  /** koffi 로더: 설치본은 resources/koffi, 개발·`electron .` 은 node_modules(모듈 이름은 변수 — Vite 가 번들에 넣지 않게) */
  function loadKoffi(): KoffiLike {
    const req = createRequire(__filename);
    const name = 'koffi';
    const where = app.isPackaged ? path.join(process.resourcesPath, name) : name;
    return req(where) as KoffiLike;
  }

  function newToastId(): string {
    let id = '';
    while (id.length < 12) id += Math.random().toString(36).slice(2).replace(/[^A-Za-z0-9]/g, '');
    return 't_' + id.slice(0, 12);
  }

  function rememberToast(id: string, entry: { itemIds: string[]; target: string; snoozable: boolean }): void {
    toastTable.set(id, entry);
    while (toastTable.size > TOAST_TABLE_MAX) {
      const oldest = toastTable.keys().next().value;
      if (oldest === undefined) break;
      toastTable.delete(oldest);
    }
  }

  /**
   * Windows 알림 누르기·단추(2.12단계 §3-5). action: 'click' 본문 · 0 [열기] · 1 [1시간 뒤].
   * toastId 를 모르면(앱을 다시 켠 뒤 알림 센터에서 누름 등) 미루지 않고 알림함을 연다(안전한 쪽)
   */
  function handleToastAction(toastId: string | null, action: 'click' | 0 | 1): void {
    if (toastId && handledToasts.has(toastId)) return;
    const entry = toastId ? toastTable.get(toastId) : undefined;
    if (!entry || !toastId) {
      setMode('full', 'view:inbox');
      return;
    }
    handledToasts.add(toastId);
    while (handledToasts.size > TOAST_TABLE_MAX * 2) {
      const oldest = handledToasts.values().next().value;
      if (oldest === undefined) break;
      handledToasts.delete(oldest);
    }
    toastTable.delete(toastId);
    if (action === 1 && entry.snoozable) {
      notifyService?.snooze(entry.itemIds, '1h');
      return;
    }
    notifyService?.markRead(entry.itemIds);
    setMode('full', entry.target);
  }

  /** Windows 가 알림을 표시하지 못했다 — 오늘 실패로 적는다(점검 줄·트레이 문제). 메시지는 로그에만 */
  function handleToastFailed(toastId: string | null, message?: string): void {
    if (toastId) toastTable.delete(toastId);
    console.warn(`${LOG} Windows 알림을 표시하지 못함${message ? `: ${message}` : ''}`);
    notifyService?.noteToastFailure();
    recomputeShell();
  }

  function toastMode(): InboxState['toastMode'] {
    if (testMode) return 'log';
    try {
      return Notification.isSupported() ? 'toast' : 'unsupported';
    } catch {
      return 'unsupported';
    }
  }

  /** Windows 알림 한 장(시험 모드면 기록 파일 한 줄). 보냈으면 참 */
  function sendToast(req: ToastRequest): boolean {
    const toastId = newToastId();
    if (testMode) {
      rememberToast(toastId, { itemIds: req.itemIds, target: req.target, snoozable: req.snoozable });
      appendNotifyLog(dataDir, {
        at: localDateTimeString(config.clock.now()),
        title: req.title,
        body: req.body,
        kinds: req.kinds,
        keys: req.keys,
        target: req.target,
        toastId,
        actions: req.snoozable ? [...TOAST_ACTION_LABELS] : [],
        silent: req.silent,
      });
      return true;
    }
    if (!Notification.isSupported()) return false;
    rememberToast(toastId, { itemIds: req.itemIds, target: req.target, snoozable: req.snoozable });
    const buttons = TOAST_ACTIONS && req.snoozable;
    const n = new Notification({
      id: toastId,
      title: req.title,
      body: req.body,
      silent: req.silent,
      ...(buttons ? { actions: TOAST_ACTION_LABELS.map((text) => ({ type: 'button' as const, text })) } : {}),
    });
    const release = () => liveToasts.delete(n);
    n.on('click', () => {
      release();
      handleToastAction(toastId, 'click');
    });
    n.on('action', (details) => {
      release();
      handleToastAction(toastId, details.actionIndex === 1 ? 1 : 0);
    });
    n.on('close', release);
    n.on('failed', (_event, error) => {
      release();
      handleToastFailed(toastId, String(error));
    });
    liveToasts.add(n);
    // 닫기·누르기가 오지 않는 알림이 쌓이지 않게 오래된 것부터 놓는다
    if (liveToasts.size > 50) {
      const oldest = liveToasts.values().next().value;
      if (oldest) liveToasts.delete(oldest);
    }
    n.show();
    return true;
  }

  function saveNotifySettings(settings: NotifySettings): NotifySettings {
    appSettings.update({ notify: settings });
    const kinds = Object.entries(settings.kinds)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(
      `${LOG} 설정 › 알림 저장(${kinds} · 요약 ${settings.morningTime} · 업무 ${settings.workStart}~${settings.workEnd}` +
        `${settings.hideContent ? ' · 내용 숨김' : ''}` +
        `${settings.quietStart ? ` · 조용한 시간 ${settings.quietStart}~${settings.quietEnd}` : ''}` +
        ` · 보류 ${settings.quietHold ? '켬' : '끔'} · 소리 ${settings.sound ? '켬' : '끔'})`,
    );
    notifyService?.refresh();
    recomputeShell();
    return notifySettings();
  }

  function saveShellSettings(settings: ShellSettings): ShellSettings {
    appSettings.update({ shell: settings });
    console.log(`${LOG} 설정 › 창 닫기 저장(${settings.closeAction === 'quit' ? 'Radar 끝내기' : '트레이로 숨기기'})`);
    return shellSettings();
  }

  function inboxState(): InboxState {
    return notifyService ? notifyService.inbox() : emptyInbox(toastMode(), notifySettings().hideContent);
  }

  // ---- 바깥 주소 열기(3a단계 §7-3) ----------------------------------------------------
  // 시험 모드에서는 실제 브라우저·Obsidian 을 띄우지 않고 <데이터 폴더>/open-log.jsonl 에 한 줄 적는다(e2e 가 확인한다).
  /**
   * 원본 보기의 외부 그림(2.15) — 사람이 [외부 그림 보기]를 누를 때만. http/https · 5초 · 5MB · image/* 만.
   * 시험 모드에서는 이 PC(루프백) 밖으로 나가지 않는다.
   */
  async function fetchMailImage(url: string): Promise<{ contentType: string; data: Buffer } | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (testModeEnv && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return null;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > 5 * 1024 * 1024) return null;
    const data = Buffer.from(await res.arrayBuffer());
    return data.length <= 5 * 1024 * 1024 ? { contentType, data } : null;
  }

  async function openExternalUrl(url: string, kind: 'external' | 'obsidian'): Promise<void> {
    if (testMode) {
      const line = JSON.stringify({ at: localDateTimeString(config.clock.now()), kind, target: url });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'open-log.jsonl'), `${line}
`, 'utf8');
      console.log(`${LOG} 시험 모드: ${kind === 'external' ? '외부 링크' : 'Obsidian'} 열기를 기록함`);
      return;
    }
    await shell.openExternal(url);
  }

  /** 알림함을 두 창에 보내고 트레이를 다시 계산한다 */
  function onInbox(inbox: InboxState): void {
    broadcastInbox(inbox);
    recomputeShell(inbox);
  }

  // ---- 트레이·작업 표시줄(2.12단계 §1·§2) ----------------------------------------------

  function shellDark(): boolean {
    try {
      return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    } catch {
      return true;
    }
  }

  /** 알림함·스냅샷·문제 목록으로 트레이·오버레이를 다시 계산한다(같으면 포트가 아무것도 하지 않는다) */
  function recomputeShell(inbox?: InboxState): void {
    if (!shellPort) return;
    try {
      const now = config.clock.now();
      const team = teamSyncConfig().enabled ? teamSync.status() : null;
      const problems = problemList({
        board: vocService.board(),
        team,
        wikiOk: isDirectory(config.wikiRoot),
        toastFailedToday: !!notifyService?.lastToastFailure(),
        now,
      });
      const view: ShellView = shellViewOf({ inbox: inbox ?? inboxState(), snapshot: lastSnapshot, today: getToday(), problems });
      shellPort.update(view, shellDark());
    } catch (err) {
      console.warn(`${LOG} 트레이 상태를 계산하지 못함:`, err instanceof Error ? err.message : err);
    }
  }

  /** 트레이 왼쪽 클릭: 지금 모드의 창을 보이고 앞으로(토글하지 않는다 — §1-3) */
  function trayClick(): void {
    setMode(mode);
    const current = mode === 'sidebar' ? sidebar : full;
    if (alive(current)) current.focus();
  }

  function trayMenu(label: TrayMenuLabel): void {
    if (label === '사이드바') setMode('sidebar');
    else if (label === '풀스크린') setMode('full');
    else if (label === '알림함') setMode('full', 'view:inbox');
    else quitApp();
  }

  /**
   * 창을 보일 때 작업 표시줄 오버레이를 다시 건다(2.12단계 §2). 숨은 창에는 작업 표시줄 단추가 없어 그때 건 오버레이가 남지 않고,
   * 창을 숨겼다 보이면 단추가 새로 만들어진다. 단추가 만들어지는 때가 'show' 보다 늦을 수 있어 조금 뒤에 한 번 더 건다.
   */
  function reapplyOverlaySoon(): void {
    if (!trayPort) return;
    trayPort.reapplyOverlay();
    setTimeout(() => trayPort?.reapplyOverlay(), 300);
  }

  function startShell(): void {
    try {
      if (testMode) {
        recordingPort = createRecordingPort(dataDir, () => localDateTimeString(config.clock.now()), warnData);
        shellPort = recordingPort;
      } else {
        const port: TrayPort = createTrayPort({
          onClick: trayClick,
          onMenu: trayMenu,
          windows: () => [sidebar, full].filter(alive),
          warn: (message) => console.warn(`${LOG} ${message}`),
        });
        shellPort = port;
        trayPort = port;
        nativeTheme.on('updated', () => recomputeShell());
      }
      recomputeShell();
    } catch (err) {
      console.warn(`${LOG} 트레이를 시작하지 못함:`, err instanceof Error ? err.message : err);
    }
  }

  // ---- 처음 실행 점검(2.7단계) ------------------------------------------------------

  /** 위키 폴더·claude·메일 계정을 지금 다시 본다(부를 때마다 — 앱을 켠 뒤 설치한 경우) */
  function setupStatus(): SetupStatus {
    const claude = findClaudePath();
    let mail: SetupStatus['mail'];
    try {
      const account = smtpAccountNow();
      mail = account.ok ? { ok: true } : { ok: false, problem: account.problem };
    } catch (err) {
      mail = { ok: false, problem: `메일 계정을 확인하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
    }
    let lines: Partial<Pick<SetupStatus, 'mailIn' | 'ai' | 'team' | 'secrets'>> = {};
    try {
      if (settingsService) lines = settingsService.setupLines();
    } catch (err) {
      console.warn(`${LOG} 설정 점검 줄을 만들지 못함:`, err instanceof Error ? err.message : err);
    }
    return {
      ...lines,
      wiki: {
        ok: isDirectory(config.wikiRoot),
        path: config.wikiRoot,
        source: wikiLocation.source,
        ...(pendingWikiRoot === WIKI_PENDING_NONE ? { pendingNone: true as const } : pendingWikiRoot ? { pending: pendingWikiRoot } : {}),
      },
      claude: { ok: claude.exists, path: claude.path, source: claude.source },
      mail,
      seen: appSettings.get().setupSeen === true,
      notify: notifySetup(),
    };
  }

  /** 점검 「알림」 줄(2.9 §8-5 + 2.12 §6-2: 보류·감지·실패) */
  function notifySetup(): NonNullable<SetupStatus['notify']> {
    const inbox = notifyService ? notifyService.inbox() : null;
    const settings = notifySettings();
    let quiet: NonNullable<SetupStatus['notify']>['quiet'];
    if (inbox?.held) quiet = { state: 'held', label: inbox.held.label };
    else if (!settings.quietHold) quiet = { state: 'off' };
    else {
      let available = false;
      try {
        available = quietProbe.read().available;
      } catch {
        available = false;
      }
      quiet = { state: available ? 'ok' : 'unavailable' };
    }
    const failure = notifyService?.lastToastFailure() ?? null;
    return {
      supported: toastMode() !== 'unsupported',
      mode: testMode ? 'log' : 'toast',
      todayToasts: inbox ? inbox.todayToasts : 0,
      quiet,
      ...(failure ? { lastFailure: { at: failure } } : {}),
    };
  }

  const samePath = (a: string, b: string): boolean =>
    process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

  async function chooseWikiFolder(sender: WebContents): Promise<ChooseWikiResult> {
    if (wikiLocation.source === 'env') {
      throw new Error('위키 폴더를 환경 변수 WIKI_RADAR_WIKI 로 정해 두어 여기서 바꿀 수 없습니다');
    }
    const current = pendingWikiRoot && pendingWikiRoot !== WIKI_PENDING_NONE ? pendingWikiRoot : config.wikiRoot;
    const options: Electron.OpenDialogOptions = {
      title: '위키 폴더 고르기',
      buttonLabel: '이 폴더 사용',
      properties: ['openDirectory'],
      ...(isDirectory(current) ? { defaultPath: current } : {}),
    };
    const owner = BrowserWindow.fromWebContents(sender);
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const chosen = picked.canceled ? undefined : picked.filePaths[0];
    if (!chosen) return { changed: false, status: setupStatus() };
    const problem = wikiPathProblem(chosen);
    if (problem) throw new Error(problem);
    if (!isDirectory(chosen)) throw new Error(`폴더를 찾을 수 없습니다: ${chosen}`);
    {
      // 팀 위키 사본과 겹치는 폴더는 개인 위키로 쓰지 않는다(2.8단계 — 반대 방향 검사는 팀 동기화 켤 때 한다)
      const team = teamSyncConfig();
      if (team.enabled && team.local && (isInside(chosen, team.local) || isInside(team.local, chosen))) {
        throw new Error('팀 위키 사본 폴더(또는 그 상위·하위)는 개인 위키로 쓸 수 없습니다 — 다른 폴더를 고르세요');
      }
    }
    // 폴더를 고르면 「없음」도 푼다(resolveWikiRoot 는 wikiNone 을 wikiRoot 보다 먼저 본다). 비교는 saveWiki 와 같은 규칙
    appSettings.update({ wikiRoot: path.resolve(chosen), wikiNone: undefined });
    pendingWikiRoot = wikiLocation.source !== 'none' && samePath(chosen, config.wikiRoot) ? undefined : path.resolve(chosen);
    console.log(`${LOG} 위키 폴더를 고름(다시 시작하면 적용): ${chosen}`);
    return { changed: true, status: setupStatus() };
  }

  function markSetupSeen(): SetupStatus {
    appSettings.update({ setupSeen: true });
    return setupStatus();
  }

  /** 다시 시작. relaunch 는 이 프로세스가 끝난 뒤 새로 띄운다(한 번만 실행 잠금과 겹치지 않는다) */
  function restartApp(): void {
    console.log(`${LOG} 다시 시작함`);
    quitting = true;
    app.relaunch();
    app.quit();
  }

  // ---- 팀 위키 동기화(2.8단계) -----------------------------------------------
  // NAS 원본과 내 PC 사본을 양방향으로 맞춘다. 개인 위키(config.wikiRoot)는 사본으로 쓸 수 없다 — 그 안의 파일이
  // 통째로 팀 NAS 로 올라가는 사고를 막는다.
  const teamSyncConfig = (): TeamSyncConfig => {
    const ts = appSettings.get().teamSync;
    const cfg = SettingsService.teamSyncConfigOf(ts, teamDefaults.values().teamSync?.remote, defaultTeamLocal(app.getPath('home')));
    // 공개판은 팀 위키를 쓰지 않는다(src/shared/edition.ts) — 꺼져 있으면 동기화·팀 할 일·검색의 팀 위키가 모두 꺼진다
    return FEATURES.teamWiki ? cfg : { ...cfg, enabled: false };
  };
  const teamSync = new TeamSyncService({
    dataDir,
    config: teamSyncConfig,
    who: safeUserName(),
    onStatus: (status) => {
      broadcastTeamSync(status);
      recomputeShell();
    },
    forbidden: () => [config.wikiRoot],
    log: (message) => console.log(`${LOG} ${message}`),
    // 받음·올림·충돌·지움이 하나라도 있었으면 팀 할 일을 다시 읽는다(사본 감시를 기다리지 않고 — 2.9단계 §3).
    // 위키 문서 색인은 동기화가 끝날 때마다 — 받은 것을 색인하고 내가 올린 것을 읽음으로(3a단계 §5-3)
    onSynced: (changed, report) => {
      if (changed) teamTasks?.reload('동기화');
      // 받은 것 중에 팀 설정 파일이 있으면 다시 읽는다(§B-4)
      if (changed) void teamDefaults.refresh(true).catch(() => undefined);
      void wikiDocs?.onTeamSynced(report).catch((err: unknown) => console.warn(`${LOG} 위키 변경(팀) 처리 오류:`, err));
    },
    // 동기화가 사본을 훑기 직전 — 그 사이 내가 고친 것을 팀원 변경으로 보이지 않게(3a단계 §5-3)
    onSyncStart: () => wikiDocs?.noteTeamSyncStart(),
  });

  // ---- 팀 위키 할 일(2.9단계 §3·§5) --------------------------------------------
  // 나의 이름들: 설정 › 나의 이름(없으면 VOC 로그인 이름) + 다른 표기
  const myTeamNames = () => myNames(appSettings.get().me, vocService.board().me?.name);
  /** 팀 설정의 문제(동기화와 같은 검사 — 개인 위키와 겹침 등). 꺼져 있으면 null */
  const teamConfigProblem = (cfg: TeamSyncConfig): string | null =>
    cfg.enabled ? teamSyncConfigProblem(cfg, [config.wikiRoot]) : null;
  const teamTaskService = new TeamTaskService({
    config: () => {
      const cfg = teamSyncConfig();
      return { enabled: cfg.enabled, local: cfg.local, problem: teamConfigProblem(cfg) };
    },
    me: myTeamNames,
    today: getToday,
    holidays: config.holidays,
    log: (message) => console.log(`${LOG} ${message}`),
    // 사본이 바뀌면 위키 문서 색인도(같은 감시 — 3a단계 §3-1)
    onChanged: () => void wikiDocs?.refresh('team').catch(() => undefined),
    // 두 창에 보내고, 내 것만 개인 스냅샷에 합친다
    onBoard: (board: TeamTaskBoard) => {
      broadcastTeamTasks(board);
      const merged = snapshots.setTeamTasks({
        tasks: board.tasks.filter((t) => t.team?.mine === true),
        warnings: board.warnings,
        partial: board.partial,
      });
      if (merged) publishSnapshot(merged);
    },
  });
  teamTasks = teamTaskService;
  const teamBackupRoot = path.join(dataDir, TEAM_BACKUP_DIR);

  // ---- 설정 나머지 6칸(2.13단계) ---------------------------------------------------------
  settingsService = new SettingsService({
    env: process.env,
    dataDir,
    appSettings,
    secrets: secretStore,
    team: teamDefaults,
    mailSettings,
    wiki: {
      location: wikiLocation,
      defaultRoot: DEFAULT_WIKI_ROOT,
      pending: () => pendingWikiRoot,
      setPending: (p) => {
        pendingWikiRoot = p;
      },
    },
    teamSync: { config: teamSyncConfig, configured: () => !!appSettings.get().teamSync, set: (input) => setTeamSync(input) },
    today: getToday,
    now: () => config.clock.now(),
    testMode: testModeEnv,
    builtinUpdateUrl: DEFAULT_UPDATE_URL,
    claude: claudeStatus,
    vocTest: vocTestConnection,
    onChanged: onSettingsChanged,
    log: (message) => console.log(`${LOG} ${message}`),
  });
  const settings = settingsService;

  // ---- 메일 수집(2.15단계) — Radar 가 POP3 로 받아 앱 데이터의 메일 보관소에 쌓는다 ----------------------
  // 메일함·메일 읽기·회신 문맥은 「메일 기준 폴더」(보관소 또는 가져오기 전의 위키)를 읽는다. 서버의 메일은 지우지 않는다.
  const mailCollector = new MailCollector({
    dataDir,
    wikiRoot: () => (wikiLocation.source === 'none' ? null : config.wikiRoot),
    settings: () => settings.collectSettings(),
    account: () => settings.pop3Account(),
    env: process.env,
    now: () => config.clock.now(),
    today: getToday,
    contributor: () => myTeamNames().names[0],
    onNewMail: () =>
      void mailbox
        ?.refresh()
        .then(() => mailAnalyzer.enqueueRecent())
        .catch(() => undefined),
    // 숨은참조로 돌아온 내 사본: Radar 가 보내며 이미 남긴 메일(발송 기록의 Message-ID)이면 다시 쓰지 않는다
    isOwnSent: (messageId) => {
      try {
        return sentLog()
          .list()
          .some((r) => r.messageId.replace(/^<+|>+$/g, '').toLowerCase() === messageId);
      } catch {
        return false;
      }
    },
    onStatus: broadcastMailCollect,
    log: (message) => console.log(`${LOG} ${message}`),
    warn: (message) => console.warn(`${LOG} ${message}`),
  });
  // 새 메일(보관소) + 옛 메일(위키 raw/mail 또는 옮긴 보관함) — 옛 메일은 복사하지 않고 제자리에서 읽는다(2026-10-20 V3)
  mailbox?.setMailBases(mailCollector.mailBases());

  // ---- 로컬 LLM 메일 분석(2.16단계) — 설정 › AI 의 시험한 로컬 LLM 만. 결과는 앱 데이터 mail-analysis.json ------------
  const mailAnalyzer = new MailAnalyzer({
    dataDir,
    target: () => settings.llmTarget(),
    entries: () => mailbox?.allEntries() ?? [],
    message: (p) => mailbox?.message(p) ?? null,
    now: () => config.clock.now(),
    today: getToday,
    env: process.env,
    onChanged: (key) => {
      broadcastMailAnalysis(key);
      mailbox?.refreshView();
    },
    log: (message) => console.log(`${LOG} ${message}`),
    warn: (message) => console.warn(`${LOG} ${message}`),
  });
  mailAnalyzerRef = mailAnalyzer;

  const importTokens = new ImportTokens();
  /** 시험 훅 __radarTest.dialogPath — 다음 저장·열기 대화상자 대신 이 경로(시험 모드만) */
  let testDialogPath: string | null = null;
  const takeTestDialogPath = (): string | null => {
    const p = testDialogPath;
    testDialogPath = null;
    return p;
  };

  /** 설정이 바뀜: 화면에 알리고(값은 다시 읽게) 비밀 기억을 버린다. 가져오기·팀 기본값이면 알림·트레이도 */
  function onSettingsChanged(section: string): void {
    secretsMemo = null;
    broadcastSettingsChanged(section);
    if (section === 'mailIn' || section === 'import' || section === 'team') mailCollector.settingsChanged();
    if (section === 'import' || section === 'team') {
      notifyService?.refresh();
      recomputeShell();
    }
    if (section === 'import') teamTasks?.reload('설정 가져오기');
  }

  // ---- AI 칸: Claude Code 상태(로그인은 묻지 않는다 — 마지막 실행 결과로, §C-4) -----------------
  let lastClaudeRun: { at: string; ok: boolean; what: string; message?: string } | null = null;
  const claudeVersions = new Map<string, string>();
  const claudeVersionAsked = new Set<string>();
  function noteClaudeRun(what: string, ok: boolean, message?: string): void {
    lastClaudeRun = { at: new Date().toISOString(), ok, what, ...(message ? { message: message.slice(0, 200) } : {}) };
  }
  function claudeStatus(): ClaudeStatusView {
    const c = findClaudePath();
    const fake = /\.(mjs|cjs|js)$/i.test(c.path);
    const view: ClaudeStatusView = { path: c.path, source: c.source, exists: c.exists, ...(fake ? { fake: true } : {}) };
    const version = claudeVersions.get(c.path);
    if (version) view.version = version;
    else if (c.exists && !fake && !claudeVersionAsked.has(c.path)) {
      // 칸을 열 때 한 번(5초) — 다음 보기부터 보인다
      claudeVersionAsked.add(c.path);
      execFile(c.path, ['--version'], { timeout: 5_000, windowsHide: true }, (err, stdout) => {
        if (!err) claudeVersions.set(c.path, String(stdout).trim().split(/\r?\n/)[0].slice(0, 80));
      });
    }
    let last = lastClaudeRun;
    const run = reflect.current();
    if (run?.finishedAt && (!last || run.finishedAt > last.at)) {
      last = { at: run.finishedAt, ok: run.state === 'done', what: '위키 반영', ...(run.error ? { message: run.error.slice(0, 200) } : {}) };
    }
    if (last) view.lastRun = { ...last, at: localDateTimeString(new Date(last.at)) };
    return view;
  }

  // ---- VOC 칸 연결 시험(§C-5) -----------------------------------------------------------
  async function vocTestConnection(draftUrl: string | undefined): Promise<ConnectionTestResult> {
    const started = Date.now();
    const steps: ConnectionTestStep[] = [];
    const done = (): ConnectionTestResult => ({ ok: steps.length > 0 && steps.every((s) => s.ok), steps, ms: Date.now() - started });
    const current = vocApiUrl();
    // 환경 변수로 정한 주소는 화면에서 바꿀 수 없다 — 쓰지 않을 주소는 시험하지 않는다(§A-3)
    if (draftUrl && normalizeVocApiUrl(process.env.WIKI_RADAR_VOC_URL) && normalizeVocApiUrl(draftUrl) !== current) {
      steps.push({ label: '설정', ok: false, detail: 'VOC 서버 주소를 환경 변수 WIKI_RADAR_VOC_URL 로 정해 두어 다른 주소는 시험하지 않습니다' });
      return done();
    }
    const url = draftUrl ? normalizeVocApiUrl(draftUrl) : current;
    if (!url) {
      steps.push({ label: '설정', ok: false, detail: 'VOC 서버 주소 형식이 맞지 않습니다(https://호스트[:포트])' });
      return done();
    }
    if (url === current || useVocCli) {
      const who = await vocService.whoami();
      if (who.ok) {
        steps.push({ label: '연결', ok: true, detail: useVocCli ? 'voc-cli' : url });
        steps.push({ label: '로그인', ok: true, detail: `연결됨 · ${who.name ?? who.loginId ?? '이름 모름'}` });
        return done();
      }
      if (useVocCli) {
        steps.push({ label: '연결', ok: who.state === 'login', detail: who.message.slice(0, 200) });
        if (who.state === 'login') steps.push({ label: '로그인', ok: true, warn: true, detail: '로그인 필요' });
        return done();
      }
    }
    const p = await probeHttp(url, { testMode: testModeEnv });
    if (!p.ok) steps.push({ label: '연결', ok: false, detail: p.problem });
    else {
      steps.push({ label: '연결', ok: true, detail: `서버 응답(${p.status})` });
      steps.push({ label: '로그인', ok: true, warn: true, detail: '로그인 필요' });
    }
    return done();
  }

  // ---- 정보 칸(§C-6) ------------------------------------------------------------------
  function appInfo(): AppInfo {
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      install: installKind(),
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      dataDir,
      logsDir,
      update: settings.updateUrl(),
      testMode: testModeEnv,
      teamDefaults: teamDefaults.current(),
      teamDefaultsFile: TEAM_SETTINGS_REL,
      voc: { apiUrl: vocApiUrlView(), cli: useVocCli },
    };
  }

  /** VOC 서버 주소와 출처(설정 › VOC 칸 머리 — vocApiUrl 과 같은 순서) */
  function vocApiUrlView(): FieldView<string> {
    const fromEnv = normalizeVocApiUrl(process.env.WIKI_RADAR_VOC_URL);
    if (fromEnv) return { value: fromEnv, source: 'env', envName: 'WIKI_RADAR_VOC_URL' };
    let user: string | null = null;
    try {
      user = normalizeVocApiUrl(vocSettings().get().apiUrl);
    } catch {
      // 설정을 못 읽으면 팀·기본 주소
    }
    const team = normalizeVocApiUrl(teamDefaults.values().voc?.apiUrl);
    const out: FieldView<string> = user
      ? { value: user, source: 'user', userValue: user }
      : team
        ? { value: team, source: 'team' }
        : { value: VOC_DEFAULT_API_URL, source: 'builtin' };
    if (team) out.teamValue = team;
    out.builtinValue = VOC_DEFAULT_API_URL;
    return out;
  }

  function diagnostics(): string {
    const st = setupStatus();
    return buildDiagnostics({
      info: appInfo(),
      wiki: { path: config.wikiRoot, source: wikiLocation.source },
      sections: SETTINGS_SECTIONS.map((s) => settings.view(s)),
      setup: {
        wiki: { ok: st.wiki.ok },
        claude: { ok: st.claude.ok },
        mail: st.mail,
        mailIn: st.mailIn,
        ai: st.ai,
        team: st.team,
        secrets: st.secrets,
      },
      recentWarnings: logFile.recentWarnings(),
      secrets: settings.knownSecrets(),
    });
  }

  /** 시험 모드면 실제 탐색기를 띄우지 않고 open-log.jsonl 에 적는다 */
  async function openAppFolder(which: 'data' | 'logs'): Promise<void> {
    const target = which === 'data' ? dataDir : logsDir;
    if (testModeEnv) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'open-log.jsonl'), `${JSON.stringify({ at: localDateTimeString(config.clock.now()), kind: 'folder', target })}\n`, 'utf8');
      return;
    }
    fs.mkdirSync(target, { recursive: true });
    const failed = await shell.openPath(target);
    if (failed) throw new Error(`폴더를 열지 못했습니다: ${failed}`);
  }

  async function pickFolder(sender: WebContents, purpose: 'personalWiki' | 'teamLocal'): Promise<string | null> {
    let chosen: string | undefined;
    const hooked = takeTestDialogPath();
    if (hooked !== null) chosen = hooked;
    else if (testModeEnv) return null; // 시험은 실제 대화상자를 띄우지 않는다
    else {
      const options: Electron.OpenDialogOptions = {
        title: purpose === 'personalWiki' ? '개인 위키 폴더 고르기' : '내 PC 팀 위키 폴더 고르기',
        buttonLabel: '이 폴더 사용',
        properties: ['openDirectory', 'createDirectory'],
      };
      const owner = BrowserWindow.fromWebContents(sender);
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      chosen = picked.canceled ? undefined : picked.filePaths[0];
    }
    if (!chosen) return null;
    const problem = wikiPathProblem(chosen);
    if (problem) throw new Error(problem);
    return path.resolve(chosen);
  }

  async function exportSettingsFile(sender: WebContents): Promise<{ saved: boolean; path?: string }> {
    const safe = <T>(f: () => T): T | null => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    const payload = buildSettingsExport({
      app: appSettings.get(),
      mail: safe(() => mailSettings().get()),
      voc: safe(() => vocSettings().get()),
      appVersion: app.getVersion(),
      exportedAt: localDateTimeString(config.clock.now()),
    });
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (containsSecret(settings.knownSecrets(), [text])) throw new Error('내보낼 글에 비밀번호·키와 같은 글이 있어 쓰지 않았습니다');
    let target: string | undefined;
    const hooked = takeTestDialogPath();
    if (hooked !== null) target = hooked;
    else if (testModeEnv) return { saved: false };
    else {
      const options: Electron.SaveDialogOptions = {
        title: '설정 내보내기',
        defaultPath: path.join(app.getPath('documents'), exportFileName(getToday())),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const owner = BrowserWindow.fromWebContents(sender);
      const r = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      target = r.canceled ? undefined : r.filePath;
    }
    if (!target) return { saved: false };
    fs.writeFileSync(target, text, 'utf8');
    console.log(`${LOG} 설정 내보내기: ${target}`);
    return { saved: true, path: target };
  }

  async function previewSettingsImport(sender: WebContents): Promise<SettingsImportPreview | null> {
    let file: string | undefined;
    const hooked = takeTestDialogPath();
    if (hooked !== null) file = hooked;
    else if (testModeEnv) return null;
    else {
      const options: Electron.OpenDialogOptions = { title: '설정 가져오기', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
      const owner = BrowserWindow.fromWebContents(sender);
      const r = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      file = r.canceled ? undefined : r.filePaths[0];
    }
    if (!file) return null;
    if (!file.toLowerCase().endsWith('.json')) throw new Error('.json 파일만 가져올 수 있습니다');
    const st = fs.statSync(file);
    if (st.size > SETTINGS_IMPORT_MAX_BYTES) throw new Error('설정 파일이 너무 큽니다(256KB 넘음)');
    const parsed = parseSettingsImport(fs.readFileSync(file, 'utf8'));
    const safe = <T>(f: () => T): T | null => {
      try {
        return f();
      } catch {
        return null;
      }
    };
    const vocNow = safe(() => vocSettings().get());
    const sections = settings.previewImport(parsed, { mail: safe(() => mailSettings().get()), voc: vocNow ? { ...vocNow } : null });
    return { token: importTokens.put(parsed), sections };
  }

  function applySettingsImport(token: string, sections: string[]): { applied: string[] } {
    const parsed = importTokens.take(token);
    const applied = settings.applyImport(parsed, sections, (v) => {
      const cur = vocSettings().get();
      vocSettings().save({ ...cur, ...v });
      void vocService.refresh().catch(() => undefined);
    });
    return { applied };
  }

  async function vocLogout(): Promise<void> {
    if (useVocCli || !(vocRunner instanceof VocApiRunner)) throw new Error('voc-cli 를 쓰는 중이라 앱에서 로그아웃하지 않습니다');
    vocRunner.logout();
    console.log(`${LOG} VOC 로그아웃(세션 파일 지움)`);
    void vocService.refresh().catch(() => undefined);
  }

  // ---- 위키 검색·미리보기·변경 피드(3a단계) ------------------------------------------
  // 개인 위키 + 팀 위키 사본(동기화 켜짐)을 읽기만 한다. 색인 캐시(wiki-index.json)·읽음 기록(wiki-seen.json)·
  // 변경 기준 내용(wiki-change-base.json)은 데이터 폴더에. 감시기는 새로 열지 않는다 — 개인은 1단계 감시기, 팀은 2.9 사본 감시.
  wikiDocs = new WikiDocsService({
    dataDir,
    now: () => config.clock.now(),
    today: getToday,
    personalRoot: () => config.wikiRoot,
    team: () => {
      const cfg = teamSyncConfig();
      return { enabled: cfg.enabled, local: cfg.local, problem: teamConfigProblem(cfg) };
    },
    teamSync: () => {
      const st = teamSync.status();
      return { phase: st.phase, ...(st.lastOkAt ? { lastOkAt: st.lastOkAt } : {}) };
    },
    onSummary: broadcastWikiDocs,
    log: (message) => console.log(`${LOG} ${message}`),
    warn: (message) => console.warn(`${LOG} ${message}`),
  });

  /** 팀 할 일 저장(명세 §5). 저장 큐 안에서 부른다 */
  function saveTeamTask(input: SaveTeamTaskInput): SaveTeamTaskOutput {
    const cfg = teamSyncConfig();
    if (!cfg.enabled) throw new Error('팀 위키 동기화가 꺼져 있어 팀 할 일을 저장할 수 없습니다');
    // 동기화와 같은 검사: 팀 사본이 개인 위키와 겹치면 개인 위키 파일을 팀 규칙(백업·로그 없이)으로 고치게 된다
    const problem = teamConfigProblem(cfg);
    if (problem) throw new Error(`팀 위키 설정 때문에 저장하지 않음: ${problem}`);
    let task = teamTaskService.board().tasks.find((t) => t.id === input.taskId);
    // 감시가 아직 따라오지 못한 변경일 수 있다 — 한 번 다시 읽어 본다
    task ??= teamTaskService.reload('저장 전 확인').tasks.find((t) => t.id === input.taskId);
    if (!task || !task.team) {
      throw new Error('저장할 팀 할 일을 목록에서 찾지 못했습니다(그사이 팀 위키가 바뀌었을 수 있습니다). 목록을 확인한 뒤 다시 저장하세요');
    }
    const result = applyTeamWriteback({
      root: cfg.local,
      backupRoot: teamBackupRoot,
      today: getToday(),
      task: { id: task.id, file: task.team.file, ...(task.line !== undefined ? { line: task.line } : {}), rawLine: input.rawLine },
      change: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.owners !== undefined ? { owners: input.owners } : {}),
        ...(input.due !== undefined ? { due: input.due } : {}),
      },
    });
    console.log(
      `${LOG} 팀 할 일 저장: ${task.id} · ${result.file}${result.changed ? '' : ' · 바뀐 것 없음'}` +
        (result.backupDir ? ` · 백업 ${result.backupDir}` : ''),
    );
    const warnings = [...result.warnings];
    // 감시(800ms)를 기다리지 않고 바로 다시 읽는다 — 완료는 곧바로 목록에서 빠진다
    teamTaskService.reload('저장');
    const phase = teamSync.status().phase;
    if (result.changed && (phase === 'paused' || phase === 'error')) {
      warnings.push('팀 위키 동기화가 멈춰 있어 아직 NAS 에 올라가지 않았습니다 — 설정 › 점검을 보세요');
    }
    const out: SaveTeamTaskOutput = { file: result.file, changed: result.changed, warnings };
    if (result.backupDir) out.backupDir = path.relative(dataDir, result.backupDir).split(path.sep).join('/');
    return out;
  }

  async function openTeamDoc(rel: string): Promise<void> {
    const { local, enabled } = teamSyncConfig();
    if (!enabled) throw new Error('팀 위키 동기화가 꺼져 있습니다');
    const abs = requireTeamDocPath(local, rel);
    try {
      await openExternalUrl('obsidian://open?path=' + encodeURIComponent(abs), 'obsidian');
    } catch (err) {
      throw new Error(`Obsidian을 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function setTeamSync(input: TeamSyncInput): TeamSyncStatus {
    const cur = teamSyncConfig();
    const remote = (input.remote ?? cur.remote).trim();
    const local = (input.local ?? cur.local).trim();
    for (const [what, value] of [['NAS 팀 위키 경로', remote], ['내 PC 위키 폴더', local]] as const) {
      const problem = wikiPathProblem(value);
      if (problem) throw new Error(`${what}: ${problem.replace('위키 폴더를 고르세요', '경로를 적으세요')}`);
    }
    const next: TeamSyncConfig = { enabled: input.enabled, remote, local: path.resolve(local) };
    if (next.enabled) {
      const problem = teamSyncConfigProblem(next, [config.wikiRoot]);
      if (problem) throw new Error(problem);
    }
    appSettings.update({ teamSync: next });
    console.log(`${LOG} 팀 위키 동기화 ${next.enabled ? '켬' : '끔'}: ${next.remote} ↔ ${next.local}`);
    teamSync.reconfigure();
    teamTaskService.reconfigure();
    // 팀 출처를 켜고 끄거나 경로를 바꾸면 처음부터 다시 색인한다(다시 시작 없이 — 3a단계 §1-1)
    void wikiDocs?.reconfigure().catch(() => undefined);
    // 개인 위키가 없는 팀원은 켜고 끌 때 할 일 목록 자체가 생기거나 없어진다
    if (!isDirectory(config.wikiRoot)) refreshAndBroadcast();
    return teamSync.status();
  }

  // ---- 설정 › 나(2.9단계 §4-4) ------------------------------------------------
  // 내 이름이 비어 있으면 VOC 보드가 찾은 로그인 이름을 쓴다(메일 보내는 이름은 쓰지 않는다 — 명세 §3 결정).
  function meInfo(): MeInfo {
    return meInfoOf(appSettings.get().me, vocService.board().me?.name);
  }

  function saveMe(settings: MeSettings): MeInfo {
    appSettings.update({ me: settings });
    console.log(`${LOG} 설정 › 나 저장(이름 ${settings.name ? '있음' : '없음'} · 다른 표기 ${settings.aliases.length}개)`);
    // 저장하면 팀 할 일의 내 것을 바로 다시 가른다(다시 시작 없이 — 명세 §4-4)
    teamTaskService.reload('설정 › 나');
    return meInfo();
  }

  async function openTeamWiki(how: 'obsidian' | 'folder'): Promise<void> {
    const { local } = teamSyncConfig();
    if (!isDirectory(local)) throw new Error('내 PC 팀 위키 폴더가 아직 없습니다 — 먼저 동기화하세요');
    if (how === 'folder') {
      const failed = await shell.openPath(local);
      if (failed) throw new Error(`폴더를 열지 못했습니다: ${failed}`);
      return;
    }
    try {
      await shell.openExternal('obsidian://open?path=' + encodeURIComponent(local));
    } catch (err) {
      throw new Error(`Obsidian을 열지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** VOC 폴링을 멈추고 돌고 있는 voc-cli 를 프로세스 트리째 끝낸다. 여러 번 불러도 된다 */
  function stopVoc(): void {
    try {
      vocService.stop();
    } catch (err) {
      console.warn(`${LOG} VOC 폴링을 멈추지 못함:`, err);
    }
    try {
      vocRunner.stopAll();
    } catch (err) {
      console.warn(`${LOG} voc-cli 를 끝내지 못함:`, err);
    }
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
   * 돌고 있는 claude(위키 반영·회신 초안)를 프로세스 트리째 끝낸다. 기다리지 않는 호출만 하므로
   * process 'exit' 에서도 부른다. 여러 번 불러도 된다.
   */
  function stopClaudeRuns(): void {
    reflect.stopForQuit();
    try {
      if (cancelReplyDraft()) console.warn(`${LOG} 앱을 끝내 회신 초안 만들기를 중단함`);
    } catch (err) {
      console.warn(`${LOG} 회신 초안을 중단하지 못함:`, err);
    }
  }

  /**
   * Windows 로그오프·종료 때는 닫기를 막지 않는다. 이때는 before-quit·will-quit 이 오지 않으므로
   * 돌고 있는 claude 도 여기서 끝낸다.
   */
  function allowCloseOnSessionEnd(win: BrowserWindow): void {
    win.on('session-end', () => {
      quitting = true;
      stopClaudeRuns();
      stopVoc();
    });
  }

  const preloadPath = path.join(__dirname, 'preload.js');

  function createSidebar(): BrowserWindow {
    const win = new BrowserWindow({
      ...sidebarBounds(),
      title: 'Radar',
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
    win.on('show', reapplyOverlaySoon);

    // 창 닫기(Alt+F4): 기본은 숨기기(트레이·Ctrl+Alt+R·다시 실행으로 되살린다). 설정 › 알림 「창」이 'quit' 이면 앱 종료(2.12단계 §1-5)
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      let closeAction: ShellSettings['closeAction'] = 'tray';
      try {
        closeAction = shellSettings().closeAction;
      } catch {
        // 설정을 못 읽으면 숨긴다(지금 동작)
      }
      if (closeAction === 'quit') {
        console.log(`${LOG} 사이드바를 닫아 끝냄(설정: Radar 끝내기)`);
        quitApp();
        return;
      }
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
      title: 'Radar',
      autoHideMenuBar: true,
      // 흰 기본 제목 표시줄 대신 화면이 그린 막대(.titlebar)를 쓴다. 창 단추는 Windows 가 앱 색으로 그린다.
      ...(process.platform === 'win32'
        ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#101921', symbolColor: '#a3b4c4', height: 36 } }
        : {}),
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

    win.on('show', reapplyOverlaySoon);

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
    isShown(contents: WebContents): boolean {
      const win = [sidebar, full].find((w): w is BrowserWindow => alive(w) && w.webContents.id === contents.id);
      return !!win && win.isVisible() && !win.isMinimized();
    },
    setMode,
    togglePin,
    quit: quitApp,
  };

  // ---- 알림 서비스 시작 ------------------------------------------------------

  let notifyTimer: NodeJS.Timeout | null = null;

  function startNotify(): void {
    if (testMode) {
      // e2e 가 electronApp.evaluate 로 시계를 옮기고 판정을 돌린다(§7-2). 시험 모드가 아니면 이 객체는 없다
      (globalThis as { __radarTest?: unknown }).__radarTest = {
        setNow(text: string): string {
          if (!config.clock.set(String(text))) throw new Error(`시각 모양이 아닙니다: ${String(text)}`);
          console.log(`${LOG} 시험 시계: ${localDateTimeString(config.clock.now())}`);
          dateWatcher?.checkNow();
          notifyService?.tick();
          return localDateTimeString(config.clock.now());
        },
        tick(): void {
          notifyService?.tick();
        },
        // ---- 2.12단계 §8
        setQuiet(state: string): void {
          const next = TEST_QUIET[String(state)];
          if (!next) throw new Error(`보류 상태 이름이 아닙니다: ${String(state)}`);
          testQuiet = next;
          console.log(`${LOG} 시험 보류 상태: ${String(state)}`);
          notifyService?.tick();
          recomputeShell();
        },
        shell(): (ShellView & { closeAction: ShellSettings['closeAction'] }) | null {
          const last = recordingPort?.last();
          return last ? { ...last, closeAction: shellSettings().closeAction } : null;
        },
        trayClick(): void {
          trayClick();
        },
        trayMenu(label: string): void {
          if (!['사이드바', '풀스크린', '알림함', '종료'].includes(label)) throw new Error(`트레이 메뉴 이름이 아닙니다: ${label}`);
          trayMenu(label as TrayMenuLabel);
        },
        toastAction(toastId: string, action: 'click' | 0 | 1): void {
          if (action !== 'click' && action !== 0 && action !== 1) throw new Error('잘못된 단추');
          handleToastAction(String(toastId), action);
        },
        toastFailed(toastId: string): void {
          handleToastFailed(String(toastId), '시험');
        },
        // ---- 2.13단계 §F-6: 다음 저장·열기·폴더 대화상자 대신 이 경로
        dialogPath(p: string): void {
          if (typeof p !== 'string' || p.length === 0 || p.length > 1024) throw new Error('경로가 아닙니다');
          testDialogPath = p;
        },
        /** 팀 기본값을 지금 다시 읽는다 */
        refreshTeamDefaults(): Promise<unknown> {
          return teamDefaults.refresh(true);
        },
      };
    }
    if (!notifyEnabled) {
      console.log(`${LOG} 알림: 시험 모드라 끔(WIKI_RADAR_NOW 없음)`);
      return;
    }
    notifyService = new NotifyService({
      store: new NotifyStore(dataDir, warnData),
      now: () => config.clock.now(),
      settings: notifySettings,
      holidays: config.holidays,
      toastMode: toastMode(),
      toast: sendToast,
      isFullFocused: () => alive(full) && full.isVisible() && !full.isMinimized() && full.isFocused(),
      onInbox,
      log: (message) => console.warn(`${LOG} ${message}`),
      probe: quietProbe,
    });
    // 인스턴스 이벤트를 받지 못한 활성화(알림 센터에서 나중에 누름 등)도 받는다(2.12단계 §3-5). 시험 모드는 실제 알림이 없다
    if (!testMode && process.platform === 'win32') {
      try {
        Notification.handleActivation((details) => {
          const m = /t_[A-Za-z0-9]{12}/.exec(details.arguments ?? '');
          const action = details.type === 'action' ? (details.actionIndex === 1 ? 1 : 0) : 'click';
          handleToastAction(m ? m[0] : null, action);
        });
      } catch (err) {
        console.warn(`${LOG} Windows 알림 활성화 처리기를 등록하지 못함:`, err instanceof Error ? err.message : err);
      }
    }
    const mode = toastMode();
    console.log(`${LOG} 알림: ${mode === 'log' ? '시험 기록 파일' : mode === 'toast' ? 'Windows 알림' : 'Windows 알림 없음(알림함만)'}`);
    // 지금 입력으로 한 번(스냅샷이 아직 없으면 지금 만든다 — 화면이 읽을 것과 같은 캐시)
    try {
      notifyService.setSnapshot(snapshots.current());
    } catch {
      if (!isDirectory(config.wikiRoot)) notifyService.noteSnapshotMissing();
    }
    notifyService.setBoard(vocService.board());
    notifyTimer = setInterval(() => notifyService?.tick(), DATE_CHECK_INTERVAL_MS);
  }

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
    stopClaudeRuns();
    // voc-cli(java)도 같은 이유로 끝내고 폴링을 멈춘다.
    stopVoc();
  });
  // 어떤 경로로 끝나든(예외로 인한 종료 포함) 마지막으로 한 번 더. 동기 호출만 한다.
  process.once('exit', () => {
    stopClaudeRuns();
    stopVoc();
  });

  // 창이 모두 닫혀도 스스로 끝내지 않는다(종료는 quit() 으로만). 이 수신기가 있으면 기본 종료가 꺼진다.
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('will-quit', () => {
    stopClaudeRuns();
    stopVoc();
    globalShortcut.unregisterAll();
    partialRetry.stop();
    teamSync.stop();
    teamTaskService.stop();
    if (notifyTimer) clearInterval(notifyTimer);
    notifyTimer = null;
    // 유령 트레이 아이콘이 남지 않게
    shellPort?.destroy();
    shellPort = null;
    trayPort = null;
    dateWatcher?.stop();
    dateWatcher = null;
    void wikiWatcher?.close();
    wikiWatcher = null;
    mailbox?.stop();
    mailCollector.stop();
    mailAnalyzer.stop();
    wikiDocs?.stop();
  });

  app
    .whenReady()
    .then(() => {
      secureDefaultSession();
      startAutoUpdate({
        // 확인 직전마다(설정 › 정보에서 바꾸면 다음 확인부터 — 2.13단계 §D-2)
        // 환경 변수 값이 틀리면 내장 주소로 몰래 넘어가지 않고 끈다(§A-3 — 틀린 환경 변수는 다른 출처로 넘어가지 않는다)
        feed: () => {
          const f = settings.updateUrl();
          if (f.source === 'env' && f.value === null) {
            console.warn(`${LOG} 업데이트 서버 환경 변수가 틀려 자동 업데이트를 건너뜀: ${f.problem ?? ''}`);
            return 'off';
          }
          return f.value ?? DEFAULT_UPDATE_URL;
        },
        log: (message) => console.log(`${LOG} ${message}`),
        onBeforeQuitForUpdate: () => {
          quitting = true;
        },
      });

      registerIpc({
        wikiRoot: config.wikiRoot,
        snapshots,
        windows: windowControl,
        getToday,
        refreshSnapshot: refreshAndBroadcast,
        queue: queueStore,
        reflect,
        sentLog,
        mailSettings,
        getClaudePath: () => findClaudePath(),
        voc: vocService,
        vocSettings,
        setup: {
          status: setupStatus,
          chooseWiki: chooseWikiFolder,
          markSeen: markSetupSeen,
          restart: restartApp,
        },
        teamSync: {
          status: () => teamSync.status(),
          set: setTeamSync,
          run: (confirmLarge) => teamSync.runNow(confirmLarge),
          open: openTeamWiki,
        },
        me: {
          get: meInfo,
          save: saveMe,
        },
        teamTasks: {
          board: () => teamTaskService.board(),
          save: saveTeamTask,
          open: openTeamDoc,
        },
        notify: {
          settings: notifySettings,
          save: saveNotifySettings,
          inbox: inboxState,
          markRead: (ids) => (notifyService ? notifyService.markRead(ids) : inboxState()),
          open: (id) => {
            const target = notifyService?.open(id);
            if (target) setMode('full', target);
          },
          snooze: (ids: string[], until: SnoozeKind) => (notifyService ? notifyService.snooze(ids, until) : inboxState()),
          shell: { get: shellSettings, save: saveShellSettings },
        },
        // 내가 앱에서 나에게 배정한 티켓은 10분 동안 「새 배정」 알림에서 뺀다(§6-1)
        mailbox: mailbox ?? undefined,
        // 2.15단계: 메일 기준 폴더·수집기
        mailBaseOf: (rel) => mailbox?.baseOf(rel) ?? mailCollector.mailBases()[0],
        // 보낸 메일(본문·첨부)도 메일함 보관소 '보낸 편지함'에
        saveSentMail: (raw) => {
          mailCollector.saveSent(raw);
        },
        fetchMailImage: fetchMailImage,
        mailAnalyzer: { view: (key) => mailAnalyzer.view(key), analyze: (key, force) => mailAnalyzer.analyze(key, force) },
        collector: {
          status: () => mailCollector.status(),
          runNow: () => mailCollector.runNow(),
        },
        wikiDocs: wikiDocs ?? undefined,
        openExternal: openExternalUrl,
        // 2.13단계: 새 저장을 읽는 SMTP·비밀·초안 엔진·위키 「없음」·설정 칸
        smtpAccount: smtpAccountNow,
        knownSecrets: () => settings.knownSecrets(),
        draftAi: { engine: () => settings.draftEngine(), target: () => settings.llmTarget() },
        wikiNone: wikiLocation.source === 'none',
        onClaudeRun: noteClaudeRun,
        settings: {
          get: (section) => settings.view(section),
          save: (section, patch) => settings.save(section, patch),
          test: (section, draft) => settings.test(section, draft),
          importDotEnv: () => settings.importDotEnvAccount(),
          teamDefaults: async (refresh) => (refresh ? teamDefaults.refresh(false) : teamDefaults.current()),
          pickFolder,
          vocLogout,
          appInfo,
          checkForUpdate: () => checkForUpdateNow({ testMode: testModeEnv }),
          openFolder: openAppFolder,
          diagnostics,
          exportSettings: exportSettingsFile,
          previewImport: previewSettingsImport,
          applyImport: applySettingsImport,
        },
        beforeVocAction: (input) => {
          const meId = vocService.board().me?.id;
          if (input.kind === 'assign' && meId !== undefined && input.value === String(meId)) notifyService?.noteSelfAssign(input.ticketId);
        },
      });

      sidebar = createSidebar();
      full = createFull();
      // 처음 실행: 위키 폴더나 claude 가 없으면(환경 변수로 정한 경우는 빼고) 사이드바 대신 설정 › 점검 화면을 연다(명세 2.7단계 §3)
      try {
        const first = setupStatus();
        const wikiMissing = !first.wiki.ok && first.wiki.source !== 'env' && first.wiki.source !== 'none';
        const claudeMissing = !first.claude.ok && first.claude.source !== 'env';
        if (!first.seen && (wikiMissing || claudeMissing)) {
          console.log(`${LOG} 처음 실행 점검을 띄움(위키 ${first.wiki.ok ? '있음' : '없음'} · claude ${first.claude.ok ? '있음' : '없음'})`);
          setMode('full', FOCUS_SETUP_VIEW);
        }
      } catch (err) {
        console.warn(`${LOG} 처음 실행 점검을 하지 못함:`, err);
      }
      // 첫 받기는 5초 뒤, 그다음은 설정 주기마다(로그인 필요 상태면 멈춘다 — VocService)
      // 공개판은 VOC·로컬 LLM·팀 위키를 시작하지 않는다(src/shared/edition.ts)
      if (FEATURES.voc) vocService.start();
      // 메일함: 지난 색인 캐시로 바로 보이고 증분 색인·raw/mail 감시·10분마다 다시 확인을 시작한다
      void mailbox?.start();
      // 메일 수집(2.15): 30초 뒤 첫 회, 그다음 설정의 받는 주기마다
      mailCollector.start();
      // 메일 분석(2.16): 1분 뒤 최근 메일부터(로컬 LLM 이 설정·시험됐을 때만)
      if (FEATURES.localLlm) mailAnalyzer.start();
      // 위키 검색·변경: 지난 색인 캐시로 바로 검색되고 증분 색인·10분마다 다시 확인을 시작한다
      void wikiDocs?.start();
      // 팀 위키 동기화: 켜져 있으면 3초 뒤 첫 동기화, 그다음 5분마다·내 PC 에서 저장할 때마다
      teamSync.start();
      // 팀 기본값(§B-4): 뒤에서 읽는다(창 띄우기를 막지 않음 — NAS 는 5초 제한)
      if (FEATURES.teamWiki) void teamDefaults.refresh(true).catch((err: unknown) => console.warn(`${LOG} 팀 기본값을 읽지 못함:`, err));
      // 팀 위키 할 일: 지금 한 번 읽고 사본을 감시한다. 30일 지난 팀 위키 백업은 지운다(명세 §5)
      teamTaskService.start();
      try {
        const removed = pruneTeamBackups(teamBackupRoot);
        if (removed > 0) console.log(`${LOG} 30일 지난 팀 위키 백업 ${removed}개를 지움`);
      } catch (err) {
        console.warn(`${LOG} 팀 위키 백업 정리 실패:`, err);
      }

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
        onSettled: () => {
          // 문서가 생기거나 link_raw.py 가 바뀌었을 수 있다 — VOC 문서 연결 표는 다음에 쓸 때 다시 만든다
          vocWikiPages = null;
          refreshAndBroadcast();
          // 위키 문서 색인도 같은 감시로(제외 규칙이 같다 — 3a단계 §3-1)
          void wikiDocs?.refresh('personal').catch(() => undefined);
        },
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
          teamTaskService.reload('날짜');
          void mailbox?.refresh().catch(() => undefined);
          void wikiDocs?.refreshAll().catch(() => undefined);
        },
      });
      // 알림 N1: 60초마다 · 스냅샷·VOC 보드가 올 때 판정한다(§6-5)
      startNotify();
      // 트레이·작업 표시줄(2.12단계): 창과 알림 서비스를 만든 뒤
      startShell();
      // 절전에서 깨어나면 1분을 기다리지 않고 바로 날짜를 본다. VOC 도 한 번 새로 받는다(명세 §2-3). 알림도 한 번 판정한다
      powerMonitor.on('resume', () => {
        dateWatcher?.checkNow();
        notifyService?.tick();
        recomputeShell();
        if (FEATURES.voc) vocService.onResume();
        if (teamSyncConfig().enabled) void teamSync.runNow();
      });
    })
    .catch((err: unknown) => {
      console.error(`${LOG} 시작 실패:`, err);
      quitApp();
    });
}

/** 충돌 사본 이름에 넣을 이 PC 사용자 이름(못 읽으면 "이름없음") */
function safeUserName(): string {
  try {
    return os.userInfo().username || '이름없음';
  } catch {
    return '이름없음';
  }
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
