// e2e 공용 도구: 빌드된 앱(.vite/build) 띄우기, 모드별 창 찾기, 창 가시성, 로그 모으기, 안전한 종료,
// 2단계 쓰기 시험용 임시 위키 사본(샌드박스)과 테스트 사본 해시, 2.5단계 회신 시험용 로컬 가짜 SMTP 서버,
// 2.6단계 VOC 시험용 가짜 voc-cli(자료 임시 복사본·호출 기록).
// 패키징된 exe 는 fuse(RunAsNode·inspect 인자 꺼짐) 때문에 Playwright 가 붙지 못하므로 `electron .` 으로 띄운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { SMTPServer } from 'smtp-server';
import type { WindowMode } from '../../src/shared/types';

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURE_WIKI = path.join(PROJECT_ROOT, 'test', 'fixtures', 'wiki');
export const BUILD_MAIN = path.join(PROJECT_ROOT, '.vite', 'build', 'main.js');
export const RESULTS_DIR = path.join(PROJECT_ROOT, 'test-results');
/** 시험용 가짜 claude(명세 2단계 §6). e2e 는 진짜 claude.exe 를 절대 부르지 않는다 */
export const FAKE_CLAUDE = path.join(PROJECT_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
/** 실제 위키(마스터 볼트). e2e 는 이 안을 앱에 주지 않는다 */
export const REAL_WIKI = path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI');
/** 시험용 가짜 voc-cli(2.6단계 명세 §9). e2e 는 실제 voc-cli(jar)·운영 VOC 를 절대 부르지 않는다 */
export const FAKE_VOC_CLI = path.join(PROJECT_ROOT, 'test', 'fixtures', 'fake-voc-cli.mjs');
/** 가짜 voc-cli 의 자료(tickets.json·users.json…). launchApp 은 임시 폴더에 복사해 준다 — 원본은 읽기만 한다 */
export const FIXTURE_VOC = path.join(PROJECT_ROOT, 'test', 'fixtures', 'voc');
/** 팀 위키 시험 사본(2.9단계 명세 §12-1, 가상 데이터). launchApp 의 team 은 이것을 임시 NAS 폴더에 복사해 준다 — 원본은 읽기만 한다 */
export const FIXTURE_TEAM_WIKI = path.join(PROJECT_ROOT, 'test', 'fixtures', 'team-wiki');

/** 가짜 claude 의 동작(FAKE_CLAUDE_MODE) */
export type FakeClaudeMode = 'ok' | 'fail' | 'timeout' | 'nojson' | 'slow';
/** 가짜 claude 의 회신 초안 동작(FAKE_CLAUDE_DRAFT_MODE, 2.5단계 명세 §6). confirm = 본문에 [확인 필요: 완료 예정일] */
export type FakeDraftMode = 'ok' | 'fail' | 'nojson' | 'slow' | 'confirm';

/** 가짜 SMTP 서버가 받아 주는 계정(명세 2.5단계 §6). 사용자 이름은 주소 모양 — 앱은 이것을 보내는 주소로 쓴다 */
export const FAKE_SMTP_USER = 'radar@example.com';
export const FAKE_SMTP_PASS = 'secret';

/** 가짜 voc-cli 의 동작(FAKE_VOC_MODE, 2.6단계 명세 §9). fail-write = 읽기는 되고 쓰기만 `오류: 400 — …` */
export type FakeVocMode = 'ok' | 'login' | 'expired' | 'offline' | 'slow' | 'fail-write';

/** launchApp 의 가짜 voc-cli 설정 */
export interface VocLaunch {
  /** 없으면 'ok' */
  mode?: FakeVocMode;
  /** 자료 복사본(FAKE_VOC_STATE)에서 바꿔 둘 파일(이름 → 내용). 원본 test/fixtures/voc 는 그대로다 */
  files?: Record<string, string>;
  /** 가짜 voc-cli login 이 받는 비밀번호(FAKE_VOC_PASSWORD, 명세 §13 — 가짜 값). 없으면 가짜의 기본값 */
  password?: string;
}

/** launchApp 이 가짜 SMTP 서버를 가리키게 할 때(WIKI_RADAR_SMTP_*). user·pass 가 없으면 FAKE_SMTP_USER·PASS */
export interface SmtpLaunch {
  port: number;
  user?: string;
  pass?: string;
}

export interface LaunchOptions {
  /** 앱이 읽을 위키 절대경로(WIKI_RADAR_WIKI) */
  wiki: string;
  /** 오늘로 칠 날짜 YYYY-MM-DD(WIKI_RADAR_TODAY). 없으면 실제 오늘 */
  today?: string;
  /** 반영 대기열·실행 기록 폴더(WIKI_RADAR_DATA). 없으면 launchApp 이 만든 임시 사용자 데이터 폴더 */
  dataDir?: string;
  /** 가짜 claude 동작. 없으면 'fail' — 시험이 실수로 [위키에 반영]을 눌러도 위키를 고치지 않는다 */
  claudeMode?: FakeClaudeMode;
  /** 가짜 claude 의 초안 동작. 없으면 'ok'(초안은 어떤 파일도 쓰지 않는다) */
  draftMode?: FakeDraftMode;
  /** 초안 slow 모드의 대기 시간(FAKE_CLAUDE_DRAFT_DELAY_MS). 없으면 가짜의 기본값(30초) */
  draftDelayMs?: number;
  /**
   * 메일 계정. {port} 면 127.0.0.1:<port> 의 가짜 SMTP 서버(startFakeSmtp)를 가리킨다.
   * 없거나 'none' 이면 SMTP 변수를 넣지 않는다 — 테스트 사본에는 `_mail-ingest/.env` 가 없으니 계정 없음이 된다.
   */
  smtp?: SmtpLaunch | 'none';
  /**
   * 가짜 voc-cli(2.6단계). 앱은 언제나 가짜만 부른다(WIKI_RADAR_VOC_CLI 를 덮어쓴다). {mode} 를 주면 그 동작(기본 ok),
   * 없으면 'offline' — VOC 를 보지 않는 시험의 할 일 목록·구간 수·주간 트랙에 내 담당 VOC 할 일이 섞이지 않는다
   * (VOC 는 '서버에 연결하지 못함' 상태로만 보이고, 한 번도 받지 못했으니 VOC 할 일은 없다).
   */
  voc?: VocLaunch;
  /**
   * 위키 위치를 앱에 알리는 방법(2.7단계). 없거나 'env' 면 WIKI_RADAR_WIKI, 'settings' 면 데이터 폴더의 app-settings.json
   * (점검 화면에서 고른 것처럼 — 처음 실행 점검이 저절로 뜨는지 볼 때)
   */
  wikiVia?: 'env' | 'settings';
  /**
   * 팀 위키 동기화(2.9단계 §12-3). remote 는 임시 NAS 폴더 — 없으면 FIXTURE_TEAM_WIKI 를 복사해 만든다. local 은 내 PC 사본(없는 폴더).
   * app-settings.json 에 teamSync 를 켜서 준다. 실제 NAS 는 쓰지 않는다
   */
  team?: { remote: string; local: string };
  /** app-settings.json 에 더할 값(me 등 — 사람이 저장한 것처럼) */
  settings?: Record<string, unknown>;
  /**
   * 시험 시계 WIKI_RADAR_NOW('YYYY-MM-DDTHH:mm', 2.9단계 §7-2). 주면 알림 서비스가 켜지고 Windows 알림 대신 <데이터 폴더>/notify-log.jsonl 에 쓴다.
   * 없으면 알림 서비스가 꺼진다(기존 e2e 가 실제 시각에 따라 달라지지 않게)
   */
  now?: string;
  /**
   * 시험 보류 상태(2.12단계 §8 — WIKI_RADAR_TEST_QUIET): accepts · away · fullscreen · presentation · windowsQuiet · unavailable.
   * 앱을 켤 때부터 보류인 시나리오용. 없으면 accepts(koffi 는 시험에서 부르지 않는다)
   */
  quiet?: string;
  /**
   * 2.13단계 §F-4: 마지막에 덮어쓸 환경 변수(개발 PC 의 WIKI_RADAR_POP3_*·LLM_*·SERVER_LLM_API_KEY·TEAM_SETTINGS·UPDATE_URL 은 먼저 지운다).
   * 값 '' 은 「없음」(예: WIKI_RADAR_VOC_CLI: '' 면 앱이 VOC API 를 직접 부른다 — 가짜 VOC 서버와 함께)
   */
  env?: Record<string, string>;
  /** 2.13단계 §B: 팀 기본값 파일 내용 — 임시 파일로 써서 WIKI_RADAR_TEAM_SETTINGS 로 준다 */
  teamSettings?: unknown;
}

/** launchApp 이 만든 임시 사용자 데이터 폴더. closeApp 이 지운다 */
const userDataDirs = new WeakMap<ElectronApplication, string>();
/** launchSandboxApp 이 만든 샌드박스. closeApp 이 지운다 */
const sandboxes = new WeakMap<ElectronApplication, WikiSandbox>();
/** launchApp 이 만든 가짜 voc-cli 자료·기록 폴더. closeApp 이 지운다 */
const vocFakes = new WeakMap<ElectronApplication, FakeVocFiles>();

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

export async function launchApp({
  wiki,
  today,
  dataDir,
  claudeMode,
  draftMode,
  draftDelayMs,
  smtp,
  voc,
  wikiVia,
  team,
  settings,
  now,
  quiet,
  env: extraEnv,
  teamSettings,
}: LaunchOptions): Promise<ElectronApplication> {
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
  if (now) env.WIKI_RADAR_NOW = now;
  else delete env.WIKI_RADAR_NOW;
  if (quiet) env.WIKI_RADAR_TEST_QUIET = quiet;
  else delete env.WIKI_RADAR_TEST_QUIET;
  // 사용자 데이터 폴더는 한 번만 실행 잠금의 기준이다. 임시 폴더를 주면 떠 있는 실제 앱과 부딪히지 않고
  // 실제 사용자 데이터(%APPDATA%\wiki-radar)도 건드리지 않는다.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-e2e-'));
  env.WIKI_RADAR_USER_DATA = userDataDir;
  // 대기열(queue.json)·실행 기록도 임시 폴더에. 셸에서 물려받은 WIKI_RADAR_DATA 가 실제 폴더를 가리켜도 덮어쓴다.
  env.WIKI_RADAR_DATA = dataDir ?? userDataDir;
  if (wikiVia === 'settings') {
    // 환경 변수 대신 점검 화면에서 고른 폴더로(app-settings.json). 파일은 여기서 쓰므로 형식이 늘 맞다
    delete env.WIKI_RADAR_WIKI;
    const settingsFile = path.join(env.WIKI_RADAR_DATA, 'app-settings.json');
    // 같은 데이터 폴더로 다시 띄우면 앱이 남긴 값(setupSeen 등)은 그대로 둔다
    const prev: Record<string, unknown> = fs.existsSync(settingsFile)
      ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
      : {};
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...prev, wikiRoot: path.resolve(wiki) }), 'utf8');
  }
  if (team || settings) {
    const settingsFile = path.join(env.WIKI_RADAR_DATA, 'app-settings.json');
    const prev: Record<string, unknown> = fs.existsSync(settingsFile)
      ? (JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>)
      : {};
    const next: Record<string, unknown> = { ...prev, ...(settings ?? {}) };
    if (team) {
      // 시험 사본·실제 위키·저장소 안을 NAS·사본으로 쓰지 않는다
      for (const p of [team.remote, team.local]) {
        if (isInside(PROJECT_ROOT, p) || isInside(REAL_WIKI, p) || !isInside(os.tmpdir(), p)) {
          throw new Error(`e2e 의 팀 위키는 임시 폴더만 쓴다: ${p}`);
        }
      }
      if (!fs.existsSync(team.remote)) fs.cpSync(FIXTURE_TEAM_WIKI, team.remote, { recursive: true });
      next.teamSync = { enabled: true, remote: path.resolve(team.remote), local: path.resolve(team.local) };
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next), 'utf8');
  }
  // claude 는 언제나 가짜. 물려받은 WIKI_RADAR_CLAUDE 나 PATH 의 진짜 claude 로 가지 않게 덮어쓴다.
  env.WIKI_RADAR_CLAUDE = FAKE_CLAUDE;
  env.FAKE_CLAUDE_MODE = claudeMode ?? 'fail';
  env.FAKE_CLAUDE_DRAFT_MODE = draftMode ?? 'ok';
  if (draftDelayMs !== undefined) env.FAKE_CLAUDE_DRAFT_DELAY_MS = String(draftDelayMs);
  else delete env.FAKE_CLAUDE_DRAFT_DELAY_MS;
  // 메일: 셸에서 물려받은 SMTP 설정·계정은 지운다(실제 계정·서버가 시험으로 새지 않게). Windows 는 이름의 대소문자를 가리지 않는다.
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_SMTP_|MAILHOST_MAIL_)/i.test(key)) delete env[key];
  }
  // 시험 가드(명세 2.5단계 §5-1): main 이 루프백이 아닌 메일 서버에는 연결 전에 거부한다
  env.WIKI_RADAR_TEST_MODE = '1';
  if (smtp && smtp !== 'none') {
    env.WIKI_RADAR_SMTP_HOST = '127.0.0.1';
    env.WIKI_RADAR_SMTP_PORT = String(smtp.port);
    env.WIKI_RADAR_SMTP_SECURE = '0';
    env.WIKI_RADAR_SMTP_USER = smtp.user ?? FAKE_SMTP_USER;
    env.WIKI_RADAR_SMTP_PASS = smtp.pass ?? FAKE_SMTP_PASS;
  }
  // 2.6단계 VOC: voc-cli 는 언제나 가짜(.mjs). 물려받은 WIKI_RADAR_VOC_*·FAKE_VOC_* 는 지운다 — 실제 jar 로 새지 않게.
  // JAVA_HOME 은 그대로 둔다(가짜는 node 로 돈다. 시험 가드가 .mjs 가 아닌 voc-cli 는 실행하지 않는다 — 명세 §9).
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_VOC_|FAKE_VOC_)/i.test(key)) delete env[key];
  }
  const vocFiles = prepareFakeVoc(voc?.files);
  env.WIKI_RADAR_VOC_CLI = FAKE_VOC_CLI;
  env.FAKE_VOC_STATE = vocFiles.state;
  env.FAKE_VOC_LOG = vocFiles.log;
  env.FAKE_VOC_MODE = voc ? (voc.mode ?? 'ok') : 'offline';
  if (voc?.password !== undefined) env.FAKE_VOC_PASSWORD = voc.password;
  // 2.13단계: 개발 PC 의 POP3·로컬 LLM·키·팀 설정·업데이트 서버 변수가 시험에 섞이지 않게 지운 뒤, 시험이 준 것만 넣는다
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_POP3_|WIKI_RADAR_LLM_|WIKI_RADAR_TEAM_SETTINGS$|WIKI_RADAR_UPDATE_URL$|SERVER_LLM_API_KEY$)/i.test(key)) delete env[key];
  }
  if (teamSettings !== undefined) {
    const f = path.join(userDataDir, 'team-settings-e2e.json');
    fs.writeFileSync(f, typeof teamSettings === 'string' ? teamSettings : JSON.stringify(teamSettings), 'utf8');
    env.WIKI_RADAR_TEAM_SETTINGS = f;
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) env[key] = value;
  // 이 변수가 남아 있으면 electron 이 node 처럼 돌아 창이 뜨지 않는다(VS Code 터미널 등에서 물려받는 경우).
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const app = await electron.launch({ args: ['.'], cwd: PROJECT_ROOT, env, timeout: 30_000 });
    userDataDirs.set(app, userDataDir);
    vocFakes.set(app, vocFiles);
    return app;
  } catch (err) {
    removeDir(userDataDir);
    removeDir(vocFiles.root);
    throw err;
  }
}

// ---- 2.9단계: 알림 시험 기록·시험 시계 ------------------------------------------------

/** 시험 모드의 Windows 알림 대신 쓴 한 줄(<데이터 폴더>/notify-log.jsonl — 2.9단계 §7-3) */
export interface NotifyLogEntry {
  at: string;
  title: string;
  body: string;
  kinds: string[];
  keys: string[];
  target: string;
  /** 2.12단계 §8 */
  toastId?: string;
  actions?: string[];
  silent?: boolean;
}

/** 데이터 폴더의 notify-log.jsonl(없으면 []) */
export function readNotifyLog(dataDir: string): NotifyLogEntry[] {
  const p = path.join(dataDir, 'notify-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as NotifyLogEntry);
}

/** main 의 시험 시계를 옮기고(날짜 감시·알림 판정을 바로 돌린다) 옮긴 시각을 돌려준다(시험 모드에서만 있다) */
export async function setTestNow(app: ElectronApplication, text: string): Promise<string> {
  return app.evaluate(
    (_electron, t) => (globalThis as unknown as { __radarTest: { setNow(t: string): string } }).__radarTest.setNow(t),
    text,
  );
}

/** 2.12단계 §1-6: 시험 모드의 트레이·오버레이 기록(<데이터 폴더>/shell-log.jsonl) 한 줄 */
export interface ShellLogEntry {
  at: string;
  level: 'normal' | 'today' | 'urgent' | 'problem';
  tooltip: string;
  overlay: number;
  inbox: string;
}

/** 데이터 폴더의 shell-log.jsonl(없으면 []) */
export function readShellLog(dataDir: string): ShellLogEntry[] {
  const p = path.join(dataDir, 'shell-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ShellLogEntry);
}

/** main 의 시험 훅(globalThis.__radarTest)을 부른다 — setQuiet·shell·trayClick·trayMenu·toastAction·toastFailed(2.12단계 §8) */
export async function radarTest<T = unknown>(app: ElectronApplication, name: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    (_electron, [n, a]) => {
      const hooks = (globalThis as unknown as { __radarTest: Record<string, (...x: unknown[]) => unknown> }).__radarTest;
      return hooks[n as string](...(a as unknown[])) as never;
    },
    [name, args] as const,
  ) as Promise<T>;
}

/** 알림 판정을 한 번 돌린다 */
export async function notifyTick(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as unknown as { __radarTest: { tick(): void } }).__radarTest.tick());
}

// ---- 2.6단계: 가짜 voc-cli 자료·호출 기록 ------------------------------------------------

/** 가짜 voc-cli 한 벌의 임시 폴더 */
export interface FakeVocFiles {
  /** 임시 최상위 폴더(os.tmpdir 아래) */
  root: string;
  /** test/fixtures/voc 의 복사본(FAKE_VOC_STATE). 쓰기 명령이 여기 tickets.json 을 고친다 */
  state: string;
  /** 부른 인자 기록(FAKE_VOC_LOG, JSONL) */
  log: string;
}

/**
 * test/fixtures/voc 를 임시 폴더에 복사하고 빈 기록 파일 자리를 만든다. 자료가 아직 없으면 빈 폴더(앱은 그래도 가짜만 부른다).
 * files 를 주면 복사본의 그 파일을 바꿔 둔다(원본은 그대로)
 */
function prepareFakeVoc(files?: Record<string, string>): FakeVocFiles {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-e2e-voc-'));
  const state = path.join(root, 'state');
  if (fs.existsSync(FIXTURE_VOC)) fs.cpSync(FIXTURE_VOC, state, { recursive: true });
  else fs.mkdirSync(state, { recursive: true });
  for (const [name, text] of Object.entries(files ?? {})) {
    const p = path.join(state, ...name.split('/'));
    if (!p.startsWith(state + path.sep)) throw new Error(`가짜 voc-cli 자료 밖 경로: ${name}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  }
  return { root, state, log: path.join(root, 'calls.jsonl') };
}

function vocFilesOf(app: ElectronApplication): FakeVocFiles {
  const files = vocFakes.get(app);
  if (!files) throw new Error('launchApp 으로 띄운 앱이 아닙니다(가짜 voc-cli 폴더를 모름)');
  return files;
}

/** 가짜 voc-cli 상태 폴더(FAKE_VOC_STATE — 자료 복사본, 쓰기 명령이 고친 tickets.json 이 여기 있다) */
export function vocStateDir(app: ElectronApplication): string {
  return vocFilesOf(app).state;
}

/** 가짜 voc-cli 임시 최상위 폴더(상태 폴더 + 호출 기록 calls.jsonl) */
export function vocFakeRoot(app: ElectronApplication): string {
  return vocFilesOf(app).root;
}

/** launchApp 이 만든 임시 사용자 데이터 폴더(WIKI_RADAR_USER_DATA — Chromium 저장소가 여기 생긴다). 모르면 undefined */
export function userDataDirOf(app: ElectronApplication): string | undefined {
  return userDataDirs.get(app);
}

/** 가짜 voc-cli 상태 폴더의 JSON 파일(없으면 undefined) */
export function readVocState<T = unknown>(app: ElectronApplication, name: string): T | undefined {
  const p = path.join(vocFilesOf(app).state, name);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : undefined;
}

/** 가짜 voc-cli 호출 한 번 */
export interface VocLogEntry {
  /** voc-cli 에 넘어간 인자(명령부터, 예: ['ticket', 'list', '--hide-completed', …]) */
  args: string[];
  /** 기록 줄 그대로(가짜가 더 적은 것 — 모드·시각 등) */
  raw: unknown;
}

/** 기록 줄 하나에서 인자 배열. 줄이 배열이면 그것, 객체면 args(또는 argv) */
function argsOfLogLine(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? ((value as { args?: unknown; argv?: unknown }).args ?? (value as { argv?: unknown }).argv)
      : undefined;
  return Array.isArray(list) ? list.map((a) => String(a)) : undefined;
}

/** 가짜 voc-cli 가 지금까지 받은 호출(부른 차례). 기록이 없으면 [] */
export function readVocLog(app: ElectronApplication): VocLogEntry[] {
  const p = vocFilesOf(app).log;
  if (!fs.existsSync(p)) return [];
  const out: VocLogEntry[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 쓰는 중인 마지막 줄 등 — 다음에 다시 읽으면 온전하다
      continue;
    }
    const args = argsOfLogLine(raw);
    if (args) out.push({ args, raw });
  }
  return out;
}

/** 기록 중 명령(예: 'ticket update')으로 시작하는 호출의 인자들 */
export function vocCalls(app: ElectronApplication, command: string): string[][] {
  const words = command.split(' ');
  return readVocLog(app)
    .map((e) => e.args)
    .filter((args) => words.every((w, i) => args[i] === w));
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
  // 메일은 위키가 아니라 앱 데이터 메일 보관소에 있다(2.15 — 실제로도 2026-10-20 에 옮겼다). 시험 사본도 같은 모양으로:
  // 위키 사본의 raw/mail → <데이터>/mail-store/raw/mail. file('raw/mail/…') 은 보관소 쪽 경로다.
  const store = path.join(data, 'mail-store');
  fs.mkdirSync(path.join(store, 'raw'), { recursive: true });
  fs.renameSync(path.join(wiki, 'raw', 'mail'), path.join(store, 'raw', 'mail'));
  const file = (rel: string) => (rel === 'raw/mail' || rel.startsWith('raw/mail/') ? path.join(store, ...rel.split('/')) : path.join(wiki, ...rel.split('/')));
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
  draftMode?: FakeDraftMode;
  /** 초안 slow 모드의 대기 시간(LaunchOptions.draftDelayMs) */
  draftDelayMs?: number;
  /** 메일 계정(LaunchOptions.smtp 와 같다). 없으면 계정 없음 */
  smtp?: SmtpLaunch | 'none';
  /** 가짜 voc-cli(LaunchOptions.voc 와 같다). 없으면 offline */
  voc?: VocLaunch;
  /** 이미 있는 샌드박스를 다시 쓸 때(앱을 다시 띄워 대기열이 남는지 볼 때 등). 없으면 새로 만든다 */
  sandbox?: WikiSandbox;
  /** closeApp 이 샌드박스를 지우는가(기본 true). 다시 띄울 샌드박스면 false */
  disposeOnClose?: boolean;
}

/**
 * 테스트 사본의 임시 복사본을 만들어 앱을 띄운다: WIKI_RADAR_WIKI = 사본, WIKI_RADAR_DATA = 임시 폴더,
 * WIKI_RADAR_CLAUDE = 가짜 claude, FAKE_CLAUDE_MODE = claudeMode, FAKE_CLAUDE_DRAFT_MODE = draftMode,
 * smtp 가 있으면 가짜 SMTP 계정, voc 는 가짜 voc-cli 동작(없으면 offline). closeApp 이 샌드박스까지 지운다(가짜 SMTP 서버는 부른 쪽이 닫는다).
 */
export async function launchSandboxApp(
  opts: SandboxLaunchOptions = {},
): Promise<{ app: ElectronApplication; sandbox: WikiSandbox }> {
  if (!fs.existsSync(FAKE_CLAUDE)) {
    throw new Error(`가짜 claude 가 없습니다: ${FAKE_CLAUDE} (2단계 명세 §6)`);
  }
  const sandbox = opts.sandbox ?? createWikiSandbox();
  try {
    const app = await launchApp({
      wiki: sandbox.wiki,
      today: opts.today,
      dataDir: sandbox.data,
      claudeMode: opts.claudeMode,
      draftMode: opts.draftMode,
      draftDelayMs: opts.draftDelayMs,
      smtp: opts.smtp,
      voc: opts.voc,
    });
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

// ---- 2.5단계: 회신 시험용 가짜 SMTP 서버 ----------------------------------------------

/** 가짜 SMTP 서버가 받은 메시지 한 통 */
export interface FakeSmtpMessage {
  /** 봉투(MAIL FROM·RCPT TO). 숨은참조는 여기에만 있다 */
  envelope: { from: string; to: string[] };
  /** DATA 로 받은 MIME 그대로(점 풀기 뒤, CRLF) */
  raw: string;
  /** raw 의 바이트(.eml 사본과 비교할 때) */
  bytes: Buffer;
  /** 인증한 사용자 이름 */
  user?: string;
}

export interface FakeSmtp {
  port: number;
  /** 받은 메시지(받은 차례) */
  messages: FakeSmtpMessage[];
  /** 인증 시도(성공·실패 모두) */
  auths: { user: string; ok: boolean }[];
  /** 서버를 닫는다(여러 번 불러도 된다) */
  close(): Promise<void>;
}

export interface FakeSmtpOptions {
  /** 받는 사람(RCPT TO)을 모두 550 으로 거부한다 — 발송 실패 시험 */
  rejectRcpt?: boolean;
  /** 받아 줄 계정. 없으면 FAKE_SMTP_USER·FAKE_SMTP_PASS */
  user?: string;
  pass?: string;
}

/** 응답 코드를 붙인 SMTP 오류(smtp-server 는 err.responseCode 로 답한다) */
function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

/**
 * 127.0.0.1 의 빈 포트에 가짜 SMTP 서버를 띄운다(명세 2.5단계 §6). TLS 없음(STARTTLS 끔),
 * 인증은 PLAIN·LOGIN 으로 한 계정만 받고, 받은 메시지를 모은다. 네트워크 밖으로는 아무것도 보내지 않는다.
 */
export async function startFakeSmtp(opts: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const user = opts.user ?? FAKE_SMTP_USER;
  const pass = opts.pass ?? FAKE_SMTP_PASS;
  const messages: FakeSmtpMessage[] = [];
  const auths: { user: string; ok: boolean }[] = [];
  const server = new SMTPServer({
    secure: false,
    // STARTTLS 를 끄면 평문 인증을 받는다(앱은 루프백 서버에는 TLS 를 요구하지 않는다 — 명세 §5-1)
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    disableReverseLookup: true,
    logger: false,
    size: 25 * 1024 * 1024,
    // 앱은 풀을 쓰지 않고 보낼 때마다 QUIT 한다. 남은 연결이 있어도 닫기를 오래 끌지 않는다
    closeTimeout: 2_000,
    onAuth(auth, _session, callback) {
      const ok = auth.username === user && auth.password === pass;
      auths.push({ user: auth.username ?? '', ok });
      if (!ok) return callback(smtpError('인증 실패(가짜 SMTP)', 535));
      callback(null, { user: auth.username });
    },
    onRcptTo(address, _session, callback) {
      if (opts.rejectRcpt) return callback(smtpError(`<${address.address}> 받는 사람을 거부함(가짜 SMTP)`, 550));
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', (err) => callback(err));
      stream.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const from = session.envelope.mailFrom;
        messages.push({
          envelope: { from: from ? from.address : '', to: session.envelope.rcptTo.map((r) => r.address) },
          raw: bytes.toString('utf8'),
          bytes,
          user: session.user,
        });
        callback();
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    const listener = server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = listener.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('가짜 SMTP 서버의 포트를 알 수 없습니다'));
    });
  });
  // 듣기 시작한 뒤의 오류(연결 끊김 등)는 시험을 멈추지 않게 삼킨다
  server.on('error', () => undefined);
  let closing: Promise<void> | undefined;
  return {
    port,
    messages,
    auths,
    close: () => (closing ??= new Promise<void>((resolve) => server.close(() => resolve()))),
  };
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

/** closeApp 이 이미 닫은 앱(두 번 불러도 한 번만 닫고 지운다) */
const closedApps = new WeakSet<ElectronApplication>();

/**
 * 앱을 끝낸다. 풀스크린 창 닫기를 가로채는 앱이라 app.close() 가 멈출 수 있으므로
 * 제한 시간이 지나면 프로세스를 강제로 끝낸다. beforeRemove 를 주면 프로세스가 끝난 뒤, 임시 폴더(사용자 데이터·가짜 voc-cli·샌드박스)를
 * 지우기 전에 부른다 — 앱이 끝나며 쓴 것(Chromium 이 모아 두었다 끝낼 때 쓰는 DOM 저장소 등)까지 훑을 때. 그 안에서 실패해도 폴더는 지운다.
 * 이미 닫은 앱이면 아무것도 하지 않는다(afterEach 가 한 번 더 불러도 된다)
 */
export async function closeApp(
  app: ElectronApplication,
  timeoutMs = 10_000,
  beforeRemove?: () => void | Promise<void>,
): Promise<void> {
  if (closedApps.has(app)) return;
  closedApps.add(app);
  // 앱이 스스로 끝난 뒤(종료 메뉴·「Radar 끝내기」)에는 process() 가 던진다 — 그때는 끝난 것으로 보고 폴더만 지운다
  let proc: ReturnType<ElectronApplication['process']> | null = null;
  try {
    proc = app.process();
  } catch {
    proc = null;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([app.close().catch(() => undefined), timedOut]);
  if (timer) clearTimeout(timer);
  const live = proc;
  if (live && live.exitCode === null && live.signalCode === null) {
    // 강제로 끝낸 뒤 프로세스가 정말 사라질 때까지(최대 5초) 기다려야 사본·데이터 폴더의 잠금이 풀린다
    const exited = new Promise<void>((resolve) => live.once('exit', () => resolve()));
    live.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]);
  }
  try {
    if (beforeRemove) await beforeRemove();
  } finally {
    const userDataDir = userDataDirs.get(app);
    if (userDataDir) removeDir(userDataDir);
    const vocFiles = vocFakes.get(app);
    if (vocFiles) removeDir(vocFiles.root);
    sandboxes.get(app)?.dispose();
  }
}
