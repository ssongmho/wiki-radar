// renderer 격리·탐색 차단·권한 거부·아웃바운드 0. 계약: docs/stage1-contract.md §5, CLAUDE.md 3번, DESIGN.md §5.
import { app, session, type Session, type WebContents, type WebPreferences } from 'electron';
import { createRequestPolicy, type RequestPolicy } from './requestPolicy';

/** 두 창이 같이 쓰는 webPreferences. 여기서 정한 값을 창마다 덮어쓰지 않는다. */
export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    // 창의 맞춤법 검사만 끈다. 세션의 사전 내려받기는 disableSpellChecker() 가 막는다(둘 다 필요하다).
    spellcheck: false,
  };
}

/** 개발 서버 주소(개발 실행일 때만 값이 있다). 배포 빌드에서는 undefined 로 치환된다. */
function devServerUrl(): string | null {
  const url = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : '';
  return url || null;
}

function devServerOrigin(): string | null {
  const url = devServerUrl();
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 페이지가 스스로 다른 주소로 옮겨 가도 되는가. 개발 서버(새로고침·HMR)로의 이동만 허용한다. */
export function isAllowedNavigation(url: string): boolean {
  const origin = devServerOrigin();
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function guardWebContents(contents: WebContents): void {
  // 새 창(window.open, target=_blank)은 모두 거부한다.
  contents.setWindowOpenHandler(({ url }) => {
    console.warn(`[wiki-radar] 새 창 열기를 막음: ${url}`);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event) => {
    if (!isAllowedNavigation(event.url)) {
      console.warn(`[wiki-radar] 페이지 이동을 막음: ${event.url}`);
      event.preventDefault();
    }
  });

  contents.on('will-redirect', (event) => {
    if (!isAllowedNavigation(event.url)) {
      console.warn(`[wiki-radar] 리디렉션을 막음: ${event.url}`);
      event.preventDefault();
    }
  });

  // <webview> 는 쓰지 않는다(webviewTag:false 와 이중으로 막는다).
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

function denyAllPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn(`[wiki-radar] 권한 요청을 거부함: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

/**
 * 맞춤법 검사를 세션 수준에서 끈다. webPreferences.spellcheck:false 는 창의 검사만 끄고,
 * 세션은 그와 무관하게 시스템 언어(ko)의 hunspell 사전(11MB)을 Google CDN 에서 내려받는다.
 * 언어 목록을 비우는 것이 다운로드를 실제로 막는 호출이다(setSpellCheckerEnabled(false) 만으로는 막히지 않는다).
 */
function disableSpellChecker(ses: Session): void {
  try {
    ses.setSpellCheckerLanguages([]);
    ses.setSpellCheckerEnabled(false);
  } catch (err) {
    console.warn('[wiki-radar] 맞춤법 검사를 끄지 못함:', err);
  }
}

let requestPolicy: RequestPolicy | null = null;

/** 요청 검사기. 앱 폴더·개발 서버 주소는 처음 부를 때 한 번 정한다. */
function policy(): RequestPolicy {
  if (!requestPolicy) requestPolicy = createRequestPolicy({ appPath: app.getAppPath(), devServerUrl: devServerUrl() });
  return requestPolicy;
}

const LOGGED_BLOCKED = new Set<string>();

/**
 * 아웃바운드 0: 앱 폴더 안의 file: 과 브라우저 내부 스킴(data:·blob:·devtools: 등), 개발 서버만 허용하고
 * 나머지(네트워크 전부, 앱 밖의 file:)는 요청 단계에서 끊는다. CSP 다음의 두 번째 방어선이다 —
 * 배포 CSP 의 'self' 는 file: 문서에서 모든 file: URL 에 맞으므로 앱 폴더 밖의 파일은 여기서 막는다.
 */
function blockOutboundRequests(ses: Session): void {
  const p = policy();
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (p.isAllowed(details.url)) {
      callback({});
      return;
    }
    // 같은 URL 은 한 번만 로그(화면이 되풀이 요청해도 로그가 넘치지 않게)
    if (!LOGGED_BLOCKED.has(details.url)) {
      LOGGED_BLOCKED.add(details.url);
      console.warn(`[wiki-radar] 외부 요청을 막음(${details.resourceType}): ${details.url}`);
    }
    callback({ cancel: true });
  });
}

function secureSession(ses: Session): void {
  denyAllPermissions(ses);
  disableSpellChecker(ses);
  blockOutboundRequests(ses);
}

/**
 * app ready 전에 한 번 부른다. 샌드박스를 전역으로 켜고, 앞으로 만들어질 모든 webContents·session 에
 * 보호 장치를 건다.
 */
export function installSecurityGuards(): void {
  app.enableSandbox();
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
  app.on('session-created', (ses) => secureSession(ses));
}

/** app ready 뒤, 창을 만들기 전에 부른다. 기본 session 은 session-created 보다 먼저 생기므로 따로 건다. */
export function secureDefaultSession(): void {
  secureSession(session.defaultSession);
}
