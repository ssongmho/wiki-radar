// e2e 공용 도구: 빌드된 앱(.vite/build) 띄우기, 모드별 창 찾기, 창 가시성, 로그 모으기, 안전한 종료,
// 2단계 쓰기 시험용 임시 위키 사본(샌드박스)과 테스트 사본 해시.
// 패키징된 exe 는 fuse(RunAsNode·inspect 인자 꺼짐) 때문에 Playwright 가 붙지 못하므로 `electron .` 으로 띄운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { WindowMode } from '../../src/shared/types';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURE_WIKI = path.join(PROJECT_ROOT, 'test', 'fixtures', 'wiki');
export const BUILD_MAIN = path.join(PROJECT_ROOT, '.vite', 'build', 'main.js');
export const RESULTS_DIR = path.join(PROJECT_ROOT, 'test-results');
/** 시험용 가짜 claude(명세 2단계 §6). e2e 는 진짜 claude.exe 를 절대 부르지 않는다 */
export const FAKE_CLAUDE = path.join(PROJECT_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
/** 실제 위키(마스터 볼트). e2e 는 이 안을 앱에 주지 않는다 */
export const REAL_WIKI = path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI');

/** 가짜 claude 의 동작(FAKE_CLAUDE_MODE) */
export type FakeClaudeMode = 'ok' | 'fail' | 'timeout' | 'nojson' | 'slow';

export interface LaunchOptions {
  /** 앱이 읽을 위키 절대경로(WIKI_RADAR_WIKI) */
  wiki: string;
  /** 오늘로 칠 날짜 YYYY-MM-DD(WIKI_RADAR_TODAY). 없으면 실제 오늘 */
  today?: string;
  /** 반영 대기열·실행 기록 폴더(WIKI_RADAR_DATA). 없으면 launchApp 이 만든 임시 사용자 데이터 폴더 */
  dataDir?: string;
  /** 가짜 claude 동작. 없으면 'fail' — 시험이 실수로 [위키에 반영]을 눌러도 위키를 고치지 않는다 */
  claudeMode?: FakeClaudeMode;
}

/** launchApp 이 만든 임시 사용자 데이터 폴더. closeApp 이 지운다 */
const userDataDirs = new WeakMap<ElectronApplication, string>();
/** launchSandboxApp 이 만든 샌드박스. closeApp 이 지운다 */
const sandboxes = new WeakMap<ElectronApplication, WikiSandbox>();

/**
 * `npm start` 는 `.vite/build/main.js` 를 개발 빌드(개발 서버 주소 http://localhost:<포트> 가 박힌 것)로 덮어쓴다.
 * 그 빌드를 `electron .` 로 띄우면 개발 서버가 없으니 그 주소에서 도는 다른 앱이 창에 뜬다(이 PC 에 실제로 있다).
 * 배포 빌드에는 그 주소가 없으므로 이것으로 가린다.
 */
export function devBuildProblem(mainJs: string): string | null {
  const m = /["'`](http:\/\/localhost:\d+)["'`]/.exec(mainJs);
  return m
    ? `빌드 산출물이 개발 빌드입니다(${m[1]} 를 띄움 — \`npm start\` 가 덮어쓴 것). 먼저 \`npm run package\` 로 다시 빌드하세요.`
    : null;
}

/** child 가 parent 자신이거나 그 안에 있는가(Windows 는 대소문자 무시) */
export function isInside(parent: string, child: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function launchApp({ wiki, today, dataDir, claudeMode }: LaunchOptions): Promise<ElectronApplication> {
  if (!fs.existsSync(BUILD_MAIN)) {
    throw new Error(`빌드 산출물이 없습니다: ${BUILD_MAIN}\n먼저 \`npm run package\` 를 실행하세요.`);
  }
  const devProblem = devBuildProblem(fs.readFileSync(BUILD_MAIN, 'utf8'));
  if (devProblem) throw new Error(devProblem);
  // 2단계부터 앱은 위키에 쓴다. e2e 가 실제 위키를 가리키는 일은 어떤 경우에도 없어야 한다.
  if (isInside(REAL_WIKI, wiki)) throw new Error(`e2e 는 실제 위키를 쓰지 않는다: ${wiki}`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.WIKI_RADAR_WIKI = wiki;
  if (today) env.WIKI_RADAR_TODAY = today;
  else delete env.WIKI_RADAR_TODAY;
  // 사용자 데이터 폴더는 한 번만 실행 잠금의 기준이다. 임시 폴더를 주면 떠 있는 실제 앱과 부딪히지 않고
  // 실제 사용자 데이터(%APPDATA%\wiki-radar)도 건드리지 않는다.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-e2e-'));
  env.WIKI_RADAR_USER_DATA = userDataDir;
  // 대기열(queue.json)·실행 기록도 임시 폴더에. 셸에서 물려받은 WIKI_RADAR_DATA 가 실제 폴더를 가리켜도 덮어쓴다.
  env.WIKI_RADAR_DATA = dataDir ?? userDataDir;
  // claude 는 언제나 가짜. 물려받은 WIKI_RADAR_CLAUDE 나 PATH 의 진짜 claude 로 가지 않게 덮어쓴다.
  env.WIKI_RADAR_CLAUDE = FAKE_CLAUDE;
  env.FAKE_CLAUDE_MODE = claudeMode ?? 'fail';
  // 이 변수가 남아 있으면 electron 이 node 처럼 돌아 창이 뜨지 않는다(VS Code 터미널 등에서 물려받는 경우).
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const app = await electron.launch({ args: ['.'], cwd: PROJECT_ROOT, env, timeout: 30_000 });
    userDataDirs.set(app, userDataDir);
    return app;
  } catch (err) {
    removeDir(userDataDir);
    throw err;
  }
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 끝난 직후 Chromium 이 잠금을 늦게 풀면 남을 수 있다. 임시 폴더라 그냥 둔다.
  }
}

/** 창 URL 의 `mode=` 값. 모르는 창이면 undefined */
export function modeOfUrl(url: string): WindowMode | undefined {
  const m = /[?&#]mode=(sidebar|full)\b/.exec(url);
  return m ? (m[1] as WindowMode) : undefined;
}

/** URL 에 mode=<mode> 가 붙은 창(Page)을 기다려 돌려준다. 숨은 창도 찾는다. */
export async function windowByMode(
  app: ElectronApplication,
  mode: WindowMode,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = app.windows().find((p) => modeOfUrl(p.url()) === mode);
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    if (app.process().exitCode !== null) {
      throw new Error(
        `앱이 ${mode} 창을 띄우기 전에 끝났습니다(exit ${app.process().exitCode}). ` +
          '시작 로그(main 콘솔)를 확인하세요 — 빌드가 깨졌거나 main 에서 예외가 났을 수 있습니다.',
      );
    }
    if (Date.now() > deadline) {
      const urls = app.windows().map((p) => p.url());
      throw new Error(`mode=${mode} 창을 ${timeoutMs}ms 안에 찾지 못했습니다. 열린 창: ${JSON.stringify(urls)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** main 프로세스에서 본 창 가시성. 예: { sidebar: true, full: false } */
export async function windowVisibility(app: ElectronApplication): Promise<Partial<Record<WindowMode, boolean>>> {
  return app.evaluate(({ BrowserWindow }) => {
    const out: Record<string, boolean> = {};
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const m = /[?&#]mode=(sidebar|full)\b/.exec(w.webContents.getURL());
      if (m) out[m[1]] = w.isVisible();
    }
    return out;
  });
}

/** 큐레이션 항목 ID: 'i:' + sha1(제목) 앞 12자 (명세 §1-2) */
export function curatedTaskId(title: string): string {
  return 'i:' + createHash('sha1').update(title, 'utf8').digest('hex').slice(0, 12);
}

/** 파이썬 `\s`·strip() 의 공백(str.isspace()). JS `\s` 와 달리 \x1c-\x1f·\x85 를 넣고 U+FEFF 를 뺀다 */
const PY_WS = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

/**
 * 체크박스 핵심문구: 줄에서 `- [ ] ` 와 `[키:: 값]` 필드를 뗀 것(build_todo `core_of`, 공백은 파이썬 규칙). 태그는 남는다.
 * 2단계 sync_todo 제목(70자 넘으면 앞 70자 + '…')과 메모 절 제목도 이것이다(2단계 명세 §1-1·§5).
 */
export function coreOf(line: string): string {
  return line
    .replace(new RegExp(`^- \\[[ xX]\\]${PY_WS}*`), '')
    .replace(new RegExp(`${PY_WS}*\\[[\\p{L}\\p{N}_]+::[^\\]]*\\]`, 'gu'), '')
    .replace(new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'g'), '');
}

/** 체크박스 항목 ID: 'c:' + sha1(파일 + '|' + 핵심문구) 앞 12자 (명세 §1-2) */
export function checkboxTaskId(file: string, line: string): string {
  return 'c:' + createHash('sha1').update(`${file}|${coreOf(line)}`, 'utf8').digest('hex').slice(0, 12);
}

// ---- 2단계: 쓰기 시험용 샌드박스 --------------------------------------------------

/** 테스트 사본의 임시 복사본과 데이터 폴더. 앱은 이 사본에만 쓴다 */
export interface WikiSandbox {
  /** 임시 최상위 폴더(os.tmpdir 아래) */
  root: string;
  /** 테스트 사본의 복사본(WIKI_RADAR_WIKI) */
  wiki: string;
  /** 대기열·실행 기록 폴더(WIKI_RADAR_DATA) */
  data: string;
  /** 볼트 기준 상대경로('/') → 사본 안 절대경로 */
  file(rel: string): string;
  /** 사본 안 파일 내용(UTF-8) */
  read(rel: string): string;
  /** 데이터 폴더의 JSON 파일(없으면 undefined) */
  readData<T = unknown>(name: string): T | undefined;
  /** 폴더를 지운다(여러 번 불러도 된다) */
  dispose(): void;
}

/** 테스트 사본(test/fixtures/wiki)을 os.tmpdir 아래에 복사한다. 원본은 읽기만 한다. */
export function createWikiSandbox(prefix = 'wiki-radar-e2e-s2-'): WikiSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wiki = path.join(root, 'wiki');
  const data = path.join(root, 'data');
  fs.cpSync(FIXTURE_WIKI, wiki, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const file = (rel: string) => path.join(wiki, ...rel.split('/'));
  return {
    root,
    wiki,
    data,
    file,
    read: (rel) => fs.readFileSync(file(rel), 'utf8'),
    readData: <T>(name: string) => {
      const p = path.join(data, name);
      return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : undefined;
    },
    dispose: () => removeDir(root),
  };
}

export interface SandboxLaunchOptions {
  today?: string;
  claudeMode?: FakeClaudeMode;
  /** 이미 있는 샌드박스를 다시 쓸 때(앱을 다시 띄워 대기열이 남는지 볼 때 등). 없으면 새로 만든다 */
  sandbox?: WikiSandbox;
  /** closeApp 이 샌드박스를 지우는가(기본 true). 다시 띄울 샌드박스면 false */
  disposeOnClose?: boolean;
}

/**
 * 테스트 사본의 임시 복사본을 만들어 앱을 띄운다: WIKI_RADAR_WIKI = 사본, WIKI_RADAR_DATA = 임시 폴더,
 * WIKI_RADAR_CLAUDE = 가짜 claude, FAKE_CLAUDE_MODE = claudeMode. closeApp 이 샌드박스까지 지운다.
 */
export async function launchSandboxApp(
  opts: SandboxLaunchOptions = {},
): Promise<{ app: ElectronApplication; sandbox: WikiSandbox }> {
  if (!fs.existsSync(FAKE_CLAUDE)) {
    throw new Error(`가짜 claude 가 없습니다: ${FAKE_CLAUDE} (2단계 명세 §6)`);
  }
  const sandbox = opts.sandbox ?? createWikiSandbox();
  try {
    const app = await launchApp({ wiki: sandbox.wiki, today: opts.today, dataDir: sandbox.data, claudeMode: opts.claudeMode });
    if (opts.disposeOnClose !== false) sandboxes.set(app, sandbox);
    return { app, sandbox };
  } catch (err) {
    if (!opts.sandbox) sandbox.dispose();
    throw err;
  }
}

/**
 * 폴더 안 모든 파일의 {상대경로: sha1}. 테스트 사본이 시험 뒤에도 그대로인지 볼 때 쓴다 —
 * toEqual 이 실패하면 바뀐·생긴·없어진 파일이 차이로 보인다.
 */
export function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${r}/`] = 'dir';
        walk(a, r);
      } else {
        out[r] = createHash('sha1').update(fs.readFileSync(a)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface AppLogs {
  /** renderer 콘솔 에러·잡히지 않은 예외 */
  rendererErrors: string[];
  /** renderer 콘솔 전부(실패 시 첨부용) */
  renderer: string[];
  /** main 프로세스 콘솔(실패 시 첨부용) */
  main: string[];
}

/** 지금 있는 창과 앞으로 생길 창의 콘솔을 모은다. launch 직후 부른다. */
export function watchLogs(app: ElectronApplication): AppLogs {
  const logs: AppLogs = { rendererErrors: [], renderer: [], main: [] };
  const seen = new WeakSet<Page>();
  const attach = (page: Page) => {
    if (seen.has(page)) return;
    seen.add(page);
    const tag = () => modeOfUrl(page.url()) ?? page.url();
    page.on('console', (msg) => {
      const line = `[${tag()}] ${msg.type()}: ${msg.text()}`;
      logs.renderer.push(line);
      if (msg.type() === 'error') logs.rendererErrors.push(line);
    });
    page.on('pageerror', (err) => {
      const line = `[${tag()}] pageerror: ${err.message}`;
      logs.renderer.push(line);
      logs.rendererErrors.push(line);
    });
  };
  app.windows().forEach(attach);
  app.on('window', attach);
  app.on('console', (msg) => logs.main.push(`${msg.type()}: ${msg.text()}`));
  return logs;
}

/** 글꼴이 다 불러와지고 한 박자 쉰 뒤(스크린샷 전). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
}

/**
 * 앱을 끝낸다. 풀스크린 창 닫기를 가로채는 앱이라 app.close() 가 멈출 수 있으므로
 * 제한 시간이 지나면 프로세스를 강제로 끝낸다.
 */
export async function closeApp(app: ElectronApplication, timeoutMs = 10_000): Promise<void> {
  const proc = app.process();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([app.close().catch(() => undefined), timedOut]);
  if (timer) clearTimeout(timer);
  if (proc.exitCode === null && proc.signalCode === null) {
    // 강제로 끝낸 뒤 프로세스가 정말 사라질 때까지(최대 5초) 기다려야 사본·데이터 폴더의 잠금이 풀린다
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]);
  }
  const userDataDir = userDataDirs.get(app);
  if (userDataDir) removeDir(userDataDir);
  sandboxes.get(app)?.dispose();
}
