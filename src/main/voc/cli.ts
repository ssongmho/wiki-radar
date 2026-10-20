// voc-cli 실행: 위치·인자·실행·오류 판정·직렬 큐·시험 가드. electron 을 import 하지 않는다.
// 계약: docs/stage2.6-contract.md §1·§9
//
// - 셸을 거치지 않는다(shell:false). voc-cli.bat 대신 java 에 bat 과 같은 인자를 직접 준다.
// - 한 번에 하나만 돌린다(직렬 큐). voc-cli 는 세션 파일(~/.voc-cli/session.json)에 잠금이 없고 refresh 토큰을
//   쓸 때마다 교체해, 두 프로세스가 같은 순간 갱신하면 세션이 지워진다. 기다리는 쓰기는 기다리는 읽기보다 먼저 돈다.
// - 앱은 세션 파일을 읽지도 쓰지도 않는다. 로그인은 앱의 로그인 창이 `login -u <아이디> --password`(값 없이 — picocli 가 콘솔이
//   없으면 표준입력 한 줄을 읽는다)를 부르고 비밀번호를 표준입력으로만 넘긴다(명세 §13). 표준입력 내용은 어떤 로그·오류 문장에도 넣지 않는다.
//   터미널 명령(VOC_LOGIN_COMMAND)도 안내한다.
// - 허용 목록(VOC_ALLOWED + 정확히 그 모양의 login) 밖의 명령은 실행하지 않는다.
// - 시험 중(VITEST·WIKI_RADAR_TEST_MODE=1)에는 가짜(.mjs)만 실행한다.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isVocLoginId } from '../../shared/voc';
import { childEnv, killTree } from '../reflect';
import { errCode, stripBom } from '../wiki/fsutil';

/** 제한 시간: 읽기 30초, 쓰기 90초(서버가 Slack·SMTP 를 동기로 기다린다) */
export const VOC_READ_TIMEOUT_MS = 30_000;
export const VOC_WRITE_TIMEOUT_MS = 90_000;
/** 로그인이 필요할 때 '터미널에서 하려면'으로 안내하는 명령(앱 안 로그인은 vocLoginArgs — 명세 §13) */
export const VOC_LOGIN_COMMAND = 'voc-cli login -u <아이디>';
/** 앱 안 로그인에서 부르는 명령 이름(허용 목록 판정 결과) */
export const VOC_LOGIN = 'login';
/** 표준입력으로 넘길 수 있는 글 한도(비밀번호 256자 + 줄바꿈이면 넉넉하다) */
const STDIN_LIMIT_CHARS = 4_096;

/**
 * 앱 안 로그인 인자(명세 §13): `login -u <아이디> --password`. `--password` 에 값을 주지 않는다 — voc-cli 의 대화형 옵션이라
 * 콘솔이 없으면 표준입력에서 한 줄을 읽는다. 비밀번호를 인자에 넣으면 프로세스 목록에 보인다. `--url` 은 주지 않는다(voc-cli 설정의 백엔드)
 */
export function vocLoginArgs(loginId: string): string[] {
  return [VOC_LOGIN, '-u', loginId, '--password'];
}

/** 허용하는 login 모양인가: 정확히 `login -u <아이디> --password`(인자 4개, 아이디는 명세 §13 규칙) */
export function isVocLoginArgs(args: readonly unknown[]): boolean {
  return args.length === 4 && args[0] === VOC_LOGIN && args[1] === '-u' && isVocLoginId(args[2]) && args[3] === '--password';
}

/**
 * 실행을 허용하는 명령(앞 한두 단어). 읽기 6개 + 쓰기 3개(2.6단계) + V4(명세 §14): 읽기 `worklog list`·`ticket email-logs`·
 * `file download`(VOC 운영 데이터는 바꾸지 않는다 — 앱 데이터 폴더 아래에만 쓴다, 모양은 isVocDownloadArgs), 쓰기 `worklog add`·
 * `worklog delete`·`ticket email`·`ticket resolve`·`ticket close`·`ticket reopen`
 */
export const VOC_ALLOWED: readonly string[] = [
  'ticket list',
  'ticket get',
  'user list',
  'code list',
  'customer list',
  'whoami',
  'ticket update',
  'ticket reply',
  'ticket create',
  'worklog list',
  'ticket email-logs',
  'file download',
  'worklog add',
  'worklog delete',
  'ticket email',
  'ticket resolve',
  'ticket close',
  'ticket reopen',
];
/** VOC 운영 데이터를 바꾸는 명령(제한 시간·큐 순서가 다르다). ticket email 은 고객에게 실제 메일이 나간다 */
export const VOC_WRITE_COMMANDS: readonly string[] = [
  'ticket update',
  'ticket reply',
  'ticket create',
  'worklog add',
  'worklog delete',
  'ticket email',
  'ticket resolve',
  'ticket close',
  'ticket reopen',
];

/** 첨부 내려받기 명령 이름(허용 목록 판정 결과) */
export const VOC_DOWNLOAD = 'file download';
/** 내려받기 제한 시간(큰 첨부 — 읽기지만 30초는 짧다) */
export const VOC_DOWNLOAD_TIMEOUT_MS = 120_000;
/** 내려받기 폴더 경로에 둘 수 없는 글자(java 런처의 와일드카드 펼치기·따옴표·제어 문자) */
const DOWNLOAD_DIR_BAD_RE = /[*?"<>|\u0000-\u001f\u007f]/;

/**
 * 첨부 내려받기 인자(명세 §14): `file download <fileId> --out=<폴더>\ --json`. 폴더는 끝을 구분자로 맺어 voc-cli 가 그 안에
 * 서버 파일명(voc-cli 가 거른 것)으로 저장하게 한다. 값은 `--긴이름=값` 한 인자(§12-1)
 */
export function vocDownloadArgs(fileId: number, dir: string): string[] {
  const d = /[\\/]$/.test(dir) ? dir : `${dir}${path.sep}`;
  return ['file', 'download', String(fileId), `--out=${d}`, '--json'];
}

/**
 * 내려받기 인자가 허용하는 모양인가(정확히 vocDownloadArgs 모양 + 폴더가 root 아래). 문제가 있으면 그 문장, 없으면 null.
 * root 가 없으면(앱이 정하지 않았으면) 내려받지 않는다
 */
export function vocDownloadProblem(args: readonly string[], root: string | undefined): string | null {
  if (!root) return '첨부를 받을 폴더가 정해지지 않았습니다';
  if (args.length !== 5 || args[0] !== 'file' || args[1] !== 'download' || args[4] !== '--json') return '내려받기 인자 모양이 맞지 않습니다';
  if (!/^[1-9][0-9]{0,15}$/.test(args[2])) return '첨부 id 형식이 아닙니다';
  if (!args[3].startsWith('--out=')) return '내려받기 인자 모양이 맞지 않습니다';
  const dir = args[3].slice('--out='.length);
  if (!/[\\/]$/.test(dir) || DOWNLOAD_DIR_BAD_RE.test(dir) || !path.isAbsolute(dir)) return '내려받기 폴더 경로가 올바르지 않습니다';
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return '내려받기 폴더가 앱 데이터 폴더(voc-files) 밖입니다';
  return null;
}

/** jar 기본 위치(voc-cli 저장소의 빌드 폴더). 이 안의 voc-cli-*.jar 중 이름순 마지막을 쓴다 */
export const DEFAULT_VOC_JAR_DIR = 'C:\\ij-work\\voc-platform\\voc-cli\\build\\libs';

// ---- 사람이 읽는 문장(명세 §1 표) ------------------------------------------------------------

export const VOC_NOT_CONFIGURED_MESSAGE = 'voc-cli jar 를 찾지 못했습니다 — 설정에서 위치를 지정하세요';
export const VOC_JAVA_NOT_FOUND_MESSAGE = 'java 를 찾지 못했습니다 — JAVA_HOME 또는 PATH 를 확인하세요';
const JAVA_ENOENT_MESSAGE = 'java 를 실행하지 못했습니다(ENOENT) — JAVA_HOME 또는 PATH 를 확인하세요';
export const VOC_LOGIN_MESSAGE = 'VOC 에 로그인이 필요합니다';
export const VOC_EXPIRED_MESSAGE = `${VOC_LOGIN_MESSAGE} — 세션이 만료되었습니다(주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다)`;
export const VOC_UNAVAILABLE_MESSAGE = 'VOC 서버에 연결하지 못했습니다';
export const VOC_USAGE_ERROR_MESSAGE = 'voc-cli 사용법 오류(앱 버그) — 로그 확인';
export const VOC_GUARD_MESSAGE = '시험 중에는 실제 voc-cli 를 부르지 않습니다';
/** 실행 중·대기 중에 앱이 끝나 멈춘 명령 */
export const VOC_STOPPED_MESSAGE = '앱을 끝내는 중이라 VOC 요청을 멈췄습니다';

/** 표준출력 상한(진행 중 티켓 2,000건 × 설명 1만 자에도 넉넉하다) */
const STDOUT_LIMIT_BYTES = 30 * 1024 * 1024;
/** 표준에러는 앞부분만 모은다(오류 판정은 첫 `오류:` 줄로 한다) */
const STDERR_LIMIT_CHARS = 256 * 1024;
/** 명령줄 전체 길이 상한(Windows CreateProcess 한도 32,767자 안쪽) */
const ARGS_LIMIT_CHARS = 30_000;
/** 프로세스가 끝났는데 출력 파이프가 닫히지 않을 때(손자 프로세스가 붙잡은 경우) 기다리는 시간 */
const CLOSE_GRACE_MS = 3_000;
/** 트리 종료를 보낸 뒤에도 끝나지 않을 때 포기하고 결과를 돌려주기까지 */
const KILL_GRACE_MS = 5_000;
/** 오류 문장 한 줄 최대 길이 */
const MESSAGE_MAX = 400;

// ---- 위치 ----------------------------------------------------------------------------------

export type VocCliLocation =
  | { ok: true; kind: 'jar' | 'fake'; command: string; baseArgs: string[] }
  | { ok: false; message: string };

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 따옴표·앞뒤 공백을 걷은 경로(비면 undefined) */
function cleanPath(p: string | undefined): string | undefined {
  const v = p?.trim().replace(/^"(.*)"$/, '$1').trim();
  return v ? v : undefined;
}

/** 이름 안의 숫자를 숫자로 비교한다(voc-cli-1.10.0 이 1.9.0 뒤) */
const jarNameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** 기본 폴더의 voc-cli-*.jar 중 이름순 마지막(-plain.jar 는 실행할 수 없는 jar 라 뺀다). 없으면 undefined */
export function pickDefaultJar(names: readonly string[]): string | undefined {
  const jars = names
    .filter((n) => /^voc-cli-.+\.jar$/i.test(n) && !/-plain\.jar$/i.test(n))
    .sort((a, b) => jarNameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  return jars.length > 0 ? jars[jars.length - 1] : undefined;
}

/** 환경변수에서 이름의 대소문자를 가리지 않고 값을 찾는다(넘겨받은 일반 객체는 가린다 — Path 로 올 수 있다) */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const upper = name.toUpperCase();
  return Object.entries(env).find(([k]) => k.toUpperCase() === upper)?.[1];
}

/** java 실행 파일: JAVA_HOME\bin\java.exe → PATH 의 java.exe. 없으면 undefined */
export function findJava(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = isFile): string | undefined {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const home = cleanPath(envValue(env, 'JAVA_HOME'));
  if (home && path.isAbsolute(home)) {
    const p = path.join(home, 'bin', exe);
    if (exists(p)) return path.resolve(p);
  }
  const pathVar = envValue(env, 'PATH') ?? '';
  for (const raw of pathVar.split(path.delimiter)) {
    const dir = cleanPath(raw);
    // 상대 경로 PATH 조각은 작업 폴더에 따라 달라지므로 보지 않는다
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, exe);
    if (exists(p)) return path.resolve(p);
  }
  return undefined;
}

/** 스크립트(.mjs)를 돌릴 node. Electron 안이면 PATH 의 node(패키징 앱은 RunAsNode 퓨즈가 꺼져 있다) — reflect.ts 와 같다 */
function nodeCommand(): string {
  return process.versions.electron ? 'node' : process.execPath;
}

/** java 인자(voc-cli.bat 과 같은 JVM 옵션 + 출력 UTF-8). jsa 는 파일이 있을 때만 */
export function javaArgs(jar: string, jsa: string | undefined): string[] {
  return [
    '-XX:TieredStopAtLevel=1',
    '-Xshare:auto',
    ...(jsa ? [`-XX:SharedArchiveFile=${jsa}`] : []),
    '-Xlog:cds=off',
    '-Xlog:class+path=off',
    '-Dspring.main.lazy-initialization=true',
    '-Dfile.encoding=UTF-8',
    '-jar',
    jar,
  ];
}

/**
 * voc-cli 를 어떻게 띄울지 정한다(명세 §1): WIKI_RADAR_VOC_CLI(jar 또는 시험용 .mjs) → 설정 jarPath →
 * 기본 폴더의 voc-cli-*.jar 이름순 마지막. 앞에서 준 경로에 파일이 없으면 뒤로 몰래 넘어가지 않고 알린다.
 * jar 면 java(JAVA_HOME → PATH)를 찾고, `%USERPROFILE%\.voc-cli\<jar 이름>.jsa` 가 있으면 CDS 인자를 더한다.
 */
export function locateVocCli(opts: {
  env: NodeJS.ProcessEnv;
  jarPath?: string;
  exists?: (p: string) => boolean;
  listDir?: (dir: string) => string[];
  homedir?: string;
}): VocCliLocation {
  const exists = opts.exists ?? isFile;
  const listDir = opts.listDir ?? listDirNames;

  let jar: string | undefined;
  const fromEnv = cleanPath(opts.env.WIKI_RADAR_VOC_CLI);
  if (fromEnv) {
    const p = path.resolve(fromEnv);
    const ext = path.extname(p).toLowerCase();
    if (ext === '.mjs') {
      if (!exists(p)) return { ok: false, message: `가짜 voc-cli 를 찾지 못했습니다: ${p} (WIKI_RADAR_VOC_CLI 확인)` };
      return { ok: true, kind: 'fake', command: nodeCommand(), baseArgs: [p] };
    }
    if (ext !== '.jar') return { ok: false, message: `WIKI_RADAR_VOC_CLI 는 .jar(또는 시험용 .mjs) 경로여야 합니다: ${p}` };
    if (!exists(p)) return { ok: false, message: `voc-cli jar 를 찾지 못했습니다: ${p} (WIKI_RADAR_VOC_CLI 확인)` };
    jar = p;
  } else {
    const fromSettings = cleanPath(opts.jarPath);
    if (fromSettings) {
      const p = path.resolve(fromSettings);
      if (!exists(p)) return { ok: false, message: `voc-cli jar 를 찾지 못했습니다: ${p} — 설정에서 위치를 확인하세요` };
      jar = p;
    } else {
      const name = pickDefaultJar(listDir(DEFAULT_VOC_JAR_DIR));
      const p = name ? path.join(DEFAULT_VOC_JAR_DIR, name) : undefined;
      if (!p || !exists(p)) return { ok: false, message: VOC_NOT_CONFIGURED_MESSAGE };
      jar = p;
    }
  }

  const java = findJava(opts.env, exists);
  if (!java) return { ok: false, message: VOC_JAVA_NOT_FOUND_MESSAGE };

  const home = opts.homedir ?? os.homedir();
  const jsaPath = path.join(home, '.voc-cli', `${path.basename(jar).replace(/\.jar$/i, '')}.jsa`);
  const jsa = exists(jsaPath) ? jsaPath : undefined;
  return { ok: true, kind: 'jar', command: java, baseArgs: javaArgs(jar, jsa) };
}

/** 시험 중인가: VITEST 가 있거나 WIKI_RADAR_TEST_MODE=1 (2.5단계 메일 가드와 같은 기준) */
export function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST !== undefined || env.WIKI_RADAR_TEST_MODE === '1';
}

/**
 * 시험 가드(명세 §9): 시험 중인데 띄울 것이 가짜(.mjs)가 아니면 그 문장, 아니면 null.
 * 위치를 정하지 못한 경우(ok:false)는 어차피 실행하지 않으므로 null.
 */
export function vocTestGuard(env: NodeJS.ProcessEnv, loc: VocCliLocation): string | null {
  if (!isTestEnv(env) || !loc.ok) return null;
  const script = loc.baseArgs[0] ?? '';
  return loc.kind === 'fake' && /\.mjs$/i.test(script) ? null : VOC_GUARD_MESSAGE;
}

/** args 앞 한두 단어 → 허용 목록의 명령 이름. 목록 밖이면 null. login 은 정확히 vocLoginArgs 모양일 때만 'login'(logout 은 없다) */
export function vocCommandOf(args: readonly string[]): string | null {
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== 'string') return null;
  if (args[0] === 'whoami') return 'whoami';
  if (args[0] === VOC_LOGIN) return isVocLoginArgs(args) ? VOC_LOGIN : null;
  if (typeof args[1] !== 'string') return null;
  const two = `${args[0]} ${args[1]}`;
  return VOC_ALLOWED.includes(two) ? two : null;
}

// ---- 오류 판정 -------------------------------------------------------------------------------

export interface VocRunResult {
  /** 종료 코드(신호로 끝났으면 -1) */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface VocFailure {
  state: 'login' | 'unavailable' | 'notConfigured' | 'api';
  message: string;
  /** API 오류(`오류: 400 — …`)의 HTTP 상태 */
  apiStatus?: number;
}

function clip(text: string, max = MESSAGE_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** 표준에러의 첫 `오류:` 줄(접두 뺀 것). 없으면 undefined */
function firstErrorLine(stderr: string): string | undefined {
  for (const raw of stripBom(stderr).split(/\r\n|\n|\r/)) {
    const m = /^\s*오류\s*:\s*(.*)$/.exec(raw);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** 표준에러의 마지막 비지 않은 줄 */
function lastLine(stderr: string): string | undefined {
  const lines = stripBom(stderr)
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.length ? lines[lines.length - 1] : undefined;
}

const NOT_CONFIGURED_PREFIXES: readonly string[] = [
  'voc-cli jar 를 찾지 못했습니다',
  'voc-cli 위치를 정하지 못했습니다',
  '가짜 voc-cli 를 찾지 못했습니다',
  'WIKI_RADAR_VOC_CLI',
  'java 를 찾지 못했습니다',
  'java 를 실행하지 못했습니다',
  'node 를 실행하지 못했습니다',
  VOC_GUARD_MESSAGE,
];

/** 실행하지 못한 이유(문장 또는 spawn 오류 문자열) → 판정 */
function classifySpawnError(text: string): VocFailure {
  const s = typeof text === 'string' ? text.trim() : String(text);
  if (NOT_CONFIGURED_PREFIXES.some((p) => s.startsWith(p))) return { state: 'notConfigured', message: s };
  if (/\bENOENT\b/.test(s)) return { state: 'notConfigured', message: JAVA_ENOENT_MESSAGE };
  if (s.startsWith(VOC_UNAVAILABLE_MESSAGE) || s.startsWith('voc-cli ') || s.startsWith(VOC_STOPPED_MESSAGE)) {
    return { state: 'unavailable', message: s };
  }
  return { state: 'unavailable', message: `voc-cli 를 실행하지 못했습니다 — ${clip(s)}` };
}

/**
 * 실행 결과 → 실패 판정(명세 §1 표). 표준에러의 첫 `오류:` 줄로 본다.
 * - `로그인이 필요합니다`·`세션이 만료되었습니다` → login
 * - `백엔드에 연결할 수 없습니다`·`요청 실패` → unavailable
 * - `jar not found`·java 가 jar 를 열지 못함·실행 실패(ENOENT) → notConfigured
 * - `<숫자> — <메시지>` → api(서버 문장 그대로 + apiStatus)
 * - 종료 코드 2(picocli 인자 오류) → unavailable(앱 버그)
 * - 그 밖의 `오류:` 줄(voc-cli 가 스스로 거부한 입력 등) → api(그 문장)
 * 성공(종료 코드 0, 시간 초과 아님)을 넘기면 출력을 읽지 못한 것으로 본다(unavailable).
 */
export function classifyVocFailure(r: VocRunResult | { spawnError: string }): VocFailure {
  if ('spawnError' in r) return classifySpawnError(r.spawnError);
  if (r.timedOut) {
    return { state: 'unavailable', message: `${VOC_UNAVAILABLE_MESSAGE} — VOC 요청이 제한 시간 안에 끝나지 않아 중단했습니다` };
  }
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  const line = firstErrorLine(stderr);
  if (line !== undefined) {
    if (line.includes('로그인이 필요합니다')) return { state: 'login', message: VOC_LOGIN_MESSAGE };
    if (line.includes('세션이 만료되었습니다')) return { state: 'login', message: VOC_EXPIRED_MESSAGE };
    if (line.includes('백엔드에 연결할 수 없습니다') || line.startsWith('요청 실패')) {
      return { state: 'unavailable', message: `${VOC_UNAVAILABLE_MESSAGE} — ${clip(line)}` };
    }
    if (/jar not found/i.test(line)) return { state: 'notConfigured', message: VOC_NOT_CONFIGURED_MESSAGE };
    const api = /^(\d{3})\s*[—–-]\s*([\s\S]*)$/.exec(line);
    if (api) {
      const status = Number(api[1]);
      const text = clip(api[2]) || `서버가 요청을 거부했습니다(${status})`;
      return { state: 'api', message: text, apiStatus: status };
    }
  }
  if (/jar not found|Unable to access jarfile/i.test(stderr)) return { state: 'notConfigured', message: VOC_NOT_CONFIGURED_MESSAGE };
  if (r.code === 2) return { state: 'unavailable', message: VOC_USAGE_ERROR_MESSAGE };
  if (line !== undefined && line !== '') return { state: 'api', message: clip(line) };
  if (r.code === 0) return { state: 'unavailable', message: 'VOC 응답을 읽지 못했습니다' };
  const tail = lastLine(stderr);
  return {
    state: 'unavailable',
    message: `voc-cli 가 오류로 끝났습니다(종료 코드 ${r.code})${tail ? `: ${clip(tail, 200)}` : ''}`,
  };
}

/** run 이 실행하지 못했을 때(위치·가드·허용 목록·spawn 실패·출력 초과·멈춤) 던지는 오류. failure 에 판정이 들어 있다 */
export class VocRunError extends Error {
  readonly failure: VocFailure;

  constructor(failure: VocFailure) {
    super(failure.message);
    this.name = 'VocRunError';
    this.failure = failure;
  }
}

// ---- 실행(직렬 큐) ---------------------------------------------------------------------------

interface Job {
  args: string[];
  write: boolean;
  timeoutMs: number;
  /** 표준입력으로 넘길 글(login 의 비밀번호). 자식에게 쓰자마자 지운다. 없으면 표준입력을 열지 않는다 */
  stdin?: string;
  resolve: (r: VocRunResult) => void;
  reject: (e: Error) => void;
}

interface ActiveRun {
  child: ChildProcess | null;
  /** 결과를 더 기다리지 않고 멈춘다(stopAll) */
  abort: (e: Error) => void;
}

/** 인자 검사. 문제가 있으면 그 문장(api.ts 의 VocApiRunner 도 같은 검사를 쓴다) */
export function argsProblem(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return 'voc-cli 인자가 없습니다';
  let total = 0;
  for (const a of args) {
    if (typeof a !== 'string') return 'voc-cli 인자는 문자열이어야 합니다';
    if (a.includes('\u0000')) return 'voc-cli 인자에 NUL 문자가 있습니다';
    total += a.length + 3;
  }
  if (total > ARGS_LIMIT_CHARS) return `voc-cli 인자가 너무 깁니다(${total}자)`;
  return null;
}

/**
 * voc-cli 실행기. 한 번에 하나만 띄우고 나머지는 기다리게 한다(쓰기가 기다리는 읽기보다 먼저).
 * run 은 프로세스가 끝나면 결과(종료 코드·출력)를 돌려준다 — 종료 코드가 0 이 아니어도 resolve 한다
 * (판정은 classifyVocFailure). 실행하지 못한 경우만 VocRunError 로 reject 한다.
 */
export class VocCliRunner {
  private readonly locate: () => VocCliLocation;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnImpl: typeof spawn;
  private readonly workDir: string | undefined;
  private readonly downloadRoot: string | undefined;
  private readonly queue: Job[] = [];
  private active: ActiveRun | null = null;
  private readonly onExit = (): void => {
    if (this.active?.child) killTree(this.active.child, true);
  };

  constructor(opts: {
    locate: () => VocCliLocation;
    env?: NodeJS.ProcessEnv;
    spawnImpl?: typeof import('node:child_process').spawn;
    /**
     * voc-cli 를 띄울 작업 폴더(앱 데이터 폴더 아래 빈 전용 폴더). Windows 의 java 런처는 따옴표 없는 인자의 `*`·`?` 를 작업 폴더의
     * 파일 이름으로 펼친다 — jar 폴더에서 띄우면 답변 `*` 가 jar 이름으로 바뀐다. 없으면 만들고, 만들지 못하면 jar(스크립트) 폴더
     */
    workDir?: string;
    /** 첨부 내려받기 폴더의 뿌리(앱 데이터 폴더의 voc-files). `file download` 의 --out 은 이 아래만 허용한다. 없으면 내려받지 않는다 */
    downloadRoot?: string;
  }) {
    this.locate = opts.locate;
    this.env = opts.env ?? process.env;
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.workDir = opts.workDir;
    this.downloadRoot = opts.downloadRoot;
  }

  /** 이번 실행의 작업 폴더: 전용 폴더(없으면 만든다) → 안 되면 jar·스크립트 폴더 */
  private cwdFor(script: string | undefined): string | undefined {
    if (this.workDir) {
      try {
        fs.mkdirSync(this.workDir, { recursive: true });
        if (fs.statSync(this.workDir).isDirectory()) return this.workDir;
      } catch {
        // 아래로
      }
    }
    return script ? path.dirname(script) : undefined;
  }

  /** 실행 중인 명령이 있는가 */
  get busy(): boolean {
    return this.active !== null;
  }

  /** 기다리는 명령 수(실행 중인 것 제외) */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * 큐에 넣고 차례가 오면 실행한다. args[0..1] 이 VOC_ALLOWED 밖이면(login 은 정확히 vocLoginArgs 모양이 아니면) 거부한다.
   * write 를 주지 않으면 명령으로 정한다(update·reply·create 가 쓰기). 제한 시간 기본값: 읽기 30초, 쓰기 90초 — 넘기면 프로세스
   * 트리째 끝내고 timedOut. stdin 을 주면(login 에만) 표준입력을 열어 그 글을 쓰고 닫는다 — 그 글은 어떤 오류 문장에도 넣지 않는다.
   */
  run(args: string[], opts: { write?: boolean; timeoutMs?: number; stdin?: string } = {}): Promise<VocRunResult> {
    const problem = argsProblem(args);
    if (problem) return Promise.reject(new VocRunError({ state: 'unavailable', message: `${problem} (앱 버그)` }));
    const command = vocCommandOf(args);
    if (!command) {
      return Promise.reject(
        new VocRunError({ state: 'unavailable', message: `허용하지 않는 voc-cli 명령입니다: ${clip(args.slice(0, 2).join(' '), 80)} (앱 버그)` }),
      );
    }
    if (command === VOC_DOWNLOAD) {
      const bad = vocDownloadProblem(args, this.downloadRoot);
      if (bad) return Promise.reject(new VocRunError({ state: 'unavailable', message: `${bad} (앱 버그)` }));
    }
    const stdin = opts.stdin;
    if (stdin !== undefined) {
      if (command !== VOC_LOGIN) {
        return Promise.reject(new VocRunError({ state: 'unavailable', message: '표준입력은 voc-cli login 에만 넘깁니다 (앱 버그)' }));
      }
      if (typeof stdin !== 'string' || stdin.length > STDIN_LIMIT_CHARS || stdin.includes('\u0000')) {
        return Promise.reject(new VocRunError({ state: 'unavailable', message: 'voc-cli 표준입력 형식이 맞지 않습니다 (앱 버그)' }));
      }
    }
    const write = opts.write ?? VOC_WRITE_COMMANDS.includes(command);
    const base = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : write ? VOC_WRITE_TIMEOUT_MS : VOC_READ_TIMEOUT_MS;
    // setTimeout 은 2^31-1ms 를 넘으면 곧바로 불리므로 그 안으로 자른다
    const timeoutMs = Math.min(base, 2_147_483_647);
    return new Promise<VocRunResult>((resolve, reject) => {
      const job: Job = { args: [...args], write, timeoutMs, resolve, reject };
      if (stdin !== undefined) job.stdin = stdin;
      this.queue.push(job);
      this.pump();
    });
  }

  /** 실행 중인 것은 트리째 끝내고, 기다리는 것은 모두 거부한다(앱 종료). 그 뒤에 들어온 run 은 평소대로 돈다 */
  stopAll(): void {
    const waiting = this.queue.splice(0);
    for (const job of waiting) {
      job.stdin = undefined;
      job.reject(new VocRunError({ state: 'unavailable', message: VOC_STOPPED_MESSAGE }));
    }
    const active = this.active;
    if (active) {
      if (active.child) killTree(active.child, true);
      active.abort(new VocRunError({ state: 'unavailable', message: VOC_STOPPED_MESSAGE }));
    }
  }

  /** 다음 작업: 기다리는 쓰기 중 가장 먼저 온 것, 없으면 가장 먼저 온 읽기 */
  private next(): Job | undefined {
    const i = this.queue.findIndex((j) => j.write);
    return this.queue.splice(i >= 0 ? i : 0, 1)[0];
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const job = this.next();
    if (!job) return;
    this.execute(job);
  }

  private execute(job: Job): void {
    let settled = false;
    const run: ActiveRun = { child: null, abort: () => {} };
    this.active = run;
    // 표준입력 글은 작업에서 떼어 두고 자식에게 쓰자마자 버린다(띄우지 못해도 남기지 않는다)
    let input = job.stdin;
    job.stdin = undefined;

    const done = (): void => {
      if (this.active === run) this.active = null;
      process.removeListener('exit', this.onExit);
      // 다음 작업은 이번 결과를 받은 쪽의 then 보다 늦게 시작해도 된다
      queueMicrotask(() => this.pump());
    };
    const fail = (failure: VocFailure | Error): void => {
      if (settled) return;
      settled = true;
      done();
      job.reject(failure instanceof Error ? failure : new VocRunError(failure));
    };
    const succeed = (r: VocRunResult): void => {
      if (settled) return;
      settled = true;
      done();
      job.resolve(r);
    };
    run.abort = (e) => fail(e);

    let loc: VocCliLocation;
    try {
      loc = this.locate();
    } catch (err) {
      fail({ state: 'notConfigured', message: `voc-cli 위치를 정하지 못했습니다 (${errCode(err)})` });
      return;
    }
    if (!loc.ok) {
      fail({ state: 'notConfigured', message: loc.message });
      return;
    }
    // 넘겨받은 환경과 이 프로세스 환경 어느 쪽이든 시험 중이면 가짜만
    const guard = vocTestGuard(this.env, loc) ?? vocTestGuard(process.env, loc);
    if (guard) {
      fail({ state: 'notConfigured', message: guard });
      return;
    }

    const script = loc.kind === 'fake' ? loc.baseArgs[0] : loc.baseArgs[loc.baseArgs.length - 1];
    let child: ChildProcess;
    try {
      child = this.spawnImpl(loc.command, [...loc.baseArgs, ...job.args], {
        cwd: this.cwdFor(script),
        env: childEnv(undefined, this.env),
        shell: false,
        windowsHide: true,
        // 표준입력은 넘길 글이 있을 때만 연다(login). 없으면 닫아 둔다 — voc-cli 가 입력을 기다리며 멈추지 않게
        stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // Windows 밖에서는 프로세스 그룹을 만들어 그룹째 끝낼 수 있게 한다
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      input = undefined;
      fail(this.spawnFailure(loc, err));
      return;
    }
    run.child = child;
    process.once('exit', this.onExit);
    if (input !== undefined) {
      const sink = child.stdin;
      // 자식이 읽기 전에 끝나면 EPIPE 가 난다 — 결과는 종료 코드·표준에러로 본다(오류에 글을 싣지 않는다)
      sink?.on('error', () => {});
      sink?.end(input, 'utf8');
      input = undefined;
    }

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let overflow = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: unknown = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      timeoutTimer = graceTimer = null;
    };

    const finish = (): void => {
      if (settled) {
        clearTimers();
        return;
      }
      clearTimers();
      child.stdout?.destroy();
      child.stderr?.destroy();
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (spawnError && exitCode === null && !timedOut) {
        fail(this.spawnFailure(loc, spawnError));
        return;
      }
      if (overflow) {
        fail({ state: 'unavailable', message: 'voc-cli 출력이 너무 커서(30MB 넘음) 읽지 않았습니다' });
        return;
      }
      succeed({
        code: exitCode ?? -1,
        stdout: stripBom(stdout),
        stderr: stripBom(stderr).slice(0, STDERR_LIMIT_CHARS),
        timedOut,
      });
    };

    const stopTree = (): void => {
      killTree(child);
      // 트리 종료가 통하지 않아도 결과는 돌려준다
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(finish, KILL_GRACE_MS);
    };

    child.on('error', (err) => {
      spawnError ??= err;
      // 띄우지 못했으면(ENOENT 등) close 가 오지 않을 수 있다
      if (child.pid === undefined) finish();
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // 손자 프로세스가 출력 파이프를 붙잡고 있으면 close 가 늦는다 — 조금만 기다린다
      if (!graceTimer) graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      if (exitCode === null && exitSignal === null) {
        exitCode = code;
        exitSignal = signal;
      }
      finish();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        overflow = true;
        stdout = '';
        stopTree();
        return;
      }
      stdout += outDecoder.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= STDERR_LIMIT_CHARS) return;
      stderr += errDecoder.write(chunk);
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stopTree();
    }, job.timeoutMs);
  }

  private spawnFailure(loc: Extract<VocCliLocation, { ok: true }>, err: unknown): VocFailure {
    const code = errCode(err);
    const who = loc.kind === 'fake' ? 'node' : 'java';
    if (code === 'ENOENT') {
      return {
        state: 'notConfigured',
        message: loc.kind === 'fake' ? 'node 를 실행하지 못했습니다(ENOENT) — PATH 를 확인하세요' : JAVA_ENOENT_MESSAGE,
      };
    }
    return { state: 'unavailable', message: `voc-cli 를 실행하지 못했습니다(${who}: ${clip(code, 120)})` };
  }
}
