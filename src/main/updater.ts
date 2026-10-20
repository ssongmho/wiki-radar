// 자동 업데이트(Squirrel.Windows). 배포 서버(deploy/dist-server)의 RELEASES 를 보고 새 버전을 뒤에서 받아 두고,
// 다 받으면 다시 시작할지 묻는다. "나중에"를 고르면 다음에 앱을 켤 때 적용된다.
// 2.13단계 §C-6·§D-2: 서버 주소는 feed() 로 확인 직전마다 읽는다(설정 › 정보에서 바꾸면 다음 확인부터 — 'off' 면 건너뜀).
// [업데이트 확인]은 checkForUpdateNow(). 시험 모드는 부르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { app, autoUpdater, dialog } from 'electron';
import type { UpdateCheckResult } from '../shared/types';

/** 배포 서버 주소. WIKI_RADAR_UPDATE_URL 로 바꾸고, off 면 끈다 */
export const DEFAULT_UPDATE_URL = 'off';
const FIRST_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** [업데이트 확인] 결과를 기다리는 시간 */
const MANUAL_CHECK_TIMEOUT_MS = 30_000;

export interface UpdaterOptions {
  log: (message: string) => void;
  /** quitAndInstall 은 창을 먼저 닫고 나서 before-quit 을 보낸다 — 닫기를 숨기기로 바꾸는 처리를 그 전에 꺼야 한다 */
  onBeforeQuitForUpdate: () => void;
  /** 확인 직전마다 부르는 서버 주소(환경 변수 > 설정 > 팀 기본값 > 내장). 없으면 WIKI_RADAR_UPDATE_URL → 내장 */
  feed?: () => string;
}

/** 설치본(Setup.exe 로 설치 — Update.exe 가 있음) · zip(풀어 쓰는 패키지) · dev(개발 실행) */
export function installKind(): 'installed' | 'zip' | 'dev' {
  if (!app.isPackaged) return 'dev';
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  return process.platform === 'win32' && fs.existsSync(updateExe) ? 'installed' : 'zip';
}

let started = false;
let downloaded = false;
let downloading = false;
let feedOf: () => string = () => (process.env.WIKI_RADAR_UPDATE_URL ?? DEFAULT_UPDATE_URL).trim();
let lastFeed = '';
let logFn: (message: string) => void = () => {};

/** 확인 직전: 주소를 다시 읽어 바뀌었으면 setFeedURL. off·빈 값이면 false(건너뜀) */
function prepareFeed(): boolean {
  let feed = '';
  try {
    feed = feedOf().trim();
  } catch {
    feed = '';
  }
  if (!feed || feed.toLowerCase() === 'off') {
    if (lastFeed !== 'off') logFn('자동 업데이트 꺼짐(업데이트 서버 off)');
    lastFeed = 'off';
    return false;
  }
  if (feed !== lastFeed) {
    autoUpdater.setFeedURL({ url: feed });
    if (lastFeed) logFn(`자동 업데이트 서버를 바꿈: ${feed}`);
    lastFeed = feed;
  }
  return true;
}

export function startAutoUpdate({ log, onBeforeQuitForUpdate, feed }: UpdaterOptions): void {
  if (feed) feedOf = feed;
  logFn = log;
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // Setup.exe 로 설치한 앱에만 Update.exe 가 있다. zip 을 풀어 쓰거나 out/ 에서 띄운 앱은 건너뛴다.
  if (installKind() !== 'installed') return;

  started = true;
  // 사내망 밖이거나 서버가 꺼져 있으면 여기로 온다 — 기록만 하고 다음 확인 때 다시 본다
  autoUpdater.on('error', (err) => {
    downloading = false;
    log(`업데이트 확인 실패: ${err.message}`);
  });
  autoUpdater.on('update-available', () => {
    downloading = true;
    log('새 버전 받는 중');
  });
  autoUpdater.on('before-quit-for-update', onBeforeQuitForUpdate);
  autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
    downloaded = true;
    downloading = false;
    log(`새 버전 받음${releaseName ? `: ${releaseName}` : ''}`);
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Radar 업데이트',
        message: `새 버전${releaseName ? ` ${releaseName}` : ''}을 받았습니다.`,
        detail: `지금 버전: ${app.getVersion()}\n다시 시작하면 적용됩니다. "나중에"를 고르면 다음에 앱을 켤 때 적용됩니다.`,
        buttons: ['지금 다시 시작', '나중에'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  const check = () => {
    if (downloaded || downloading) return;
    if (!prepareFeed()) return;
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      log(`업데이트 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  log(`자동 업데이트: ${feedOf()} (지금 버전 ${app.getVersion()})`);
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.();
  setInterval(check, CHECK_INTERVAL_MS).unref?.();
}

/** [업데이트 확인](설정 › 정보). 설치본에서만 — 개발 실행·zip·시험 모드는 부르지 않는다 */
export function checkForUpdateNow(opts: { testMode: boolean }): Promise<UpdateCheckResult> {
  if (opts.testMode) return Promise.resolve({ state: 'unavailable', message: '시험 중이라 업데이트를 확인하지 않습니다' });
  if (!started || installKind() !== 'installed') return Promise.resolve({ state: 'unavailable', message: '설치본에서만 업데이트를 확인합니다' });
  if (downloaded) return Promise.resolve({ state: 'downloading', message: '새 버전을 받았습니다 — 다시 시작하면 적용됩니다' });
  if (downloading) return Promise.resolve({ state: 'downloading', message: '새 버전 받는 중' });
  if (!prepareFeed()) return Promise.resolve({ state: 'unavailable', message: '업데이트 서버가 꺼져 있습니다(off)' });
  return new Promise<UpdateCheckResult>((resolve) => {
    let done = false;
    const finish = (r: UpdateCheckResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onAvailable);
      autoUpdater.removeListener('update-not-available', onNone);
      autoUpdater.removeListener('error', onError);
      resolve(r);
    };
    const onAvailable = () => finish({ state: 'downloading', message: '새 버전 받는 중' });
    const onNone = () => finish({ state: 'latest', message: `최신입니다(${app.getVersion()})` });
    const onError = (err: Error) => finish({ state: 'failed', message: `확인 실패: ${err.message.slice(0, 200)}` });
    const timer = setTimeout(() => finish({ state: 'failed', message: '확인 실패: 서버 응답이 없습니다' }), MANUAL_CHECK_TIMEOUT_MS);
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNone);
    autoUpdater.on('error', onError);
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      finish({ state: 'failed', message: `확인 실패: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
