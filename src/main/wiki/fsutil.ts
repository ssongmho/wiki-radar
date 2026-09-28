// 파일 시스템 도우미. electron 을 import 하지 않는 순수 모듈이다.
// 경로는 내부에서 '/' 로 정규화한 볼트 기준 상대경로로 다룬다.
import fs from 'node:fs';
import path from 'node:path';

/** 어디에 있든 경로 조각이 이 이름이면 건너뛰는 폴더(명세 §1-2). */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'raw',
  '_todo-sync',
  '_mail-ingest',
  '_voc-ingest',
  '_raw-link',
  '_wiki-share',
  '.obsidian',
  '.trash',
  '.git',
  'backup',
  'node_modules',
]);

/** 역슬래시를 '/' 로 바꾼다. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 상대경로의 조각 중 하나라도 제외 폴더 이름이면 true (마지막 조각=파일 이름은 보지 않는다). */
export function isInExcludedDir(relPath: string): boolean {
  const segs = toPosix(relPath).split('/');
  segs.pop();
  return segs.some((s) => EXCLUDED_DIRS.has(s));
}

export interface WalkResult {
  /** 볼트 기준 상대경로('/'), 이름순 정렬 */
  files: string[];
  /** 읽지 못한 폴더 등 사람이 알아야 할 문제 */
  errors: string[];
}

/**
 * 볼트 안의 `.md` 파일을 모은다. 제외 폴더는 **내려가기 전에** 잘라낸다
 * (실제 위키는 raw/ 아래에 수천 개가 있다). 진짜 심볼릭 링크·정션은 따라가지 않는다.
 */
export function walkMarkdown(root: string): WalkResult {
  const files: string[] = [];
  const errors: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === '' ? root : path.join(root, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      errors.push(`폴더를 읽지 못함: ${relDir || '.'} (${errCode(err)})`);
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (!isDir && !isFile) {
        // 재분석 지점(OneDrive 자리표시자 등)은 Dirent 에서 링크로 보일 수 있다 → lstat 으로 다시 본다.
        try {
          const st = fs.lstatSync(path.join(absDir, name));
          if (st.isSymbolicLink()) continue;
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!EXCLUDED_DIRS.has(name)) stack.push(rel);
      } else if (isFile && name.toLowerCase().endsWith('.md')) {
        files.push(rel);
      }
    }
  }
  files.sort(compareCodeUnits);
  return { files, errors };
}

/** 로캘과 무관한 결정적 비교(정렬 결과가 PC 설정에 따라 바뀌지 않게). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 잠깐 뒤 다시 읽으면 될 수 있는 오류(다른 프로세스의 배타 잠금·일시적 권한 오류 등) */
export const TRANSIENT_READ_ERRORS: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'ETIMEDOUT', 'EMFILE', 'ENFILE', 'UNKNOWN']);

/** 재시도 사이 대기(ms). 세 번까지, 합쳐 0.5초 */
export const READ_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300];

/**
 * 한 스냅샷을 만드는 동안 재시도에 쓸 수 있는 대기 시간의 총량. 잠긴 파일이 많아도 main 프로세스가
 * 오래 멈추지 않게 한다(파일마다 0.5초씩 기다리면 100개면 50초다).
 */
export class RetryBudget {
  private remainingMs: number;

  constructor(totalMs: number) {
    this.remainingMs = totalMs;
  }

  /** ms 만큼 쓸 수 있으면 차감하고 true */
  take(ms: number): boolean {
    if (ms > this.remainingMs) return false;
    this.remainingMs -= ms;
    return true;
  }

  get remaining(): number {
    return this.remainingMs;
  }
}

/** 동기 대기. main 의 스냅샷 생성이 동기라 setTimeout 을 쓸 수 없다. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface ReadTextOptions {
  /** 재시도 대기 예산. 없으면 파일마다 READ_RETRY_DELAYS_MS 를 다 쓴다 */
  budget?: RetryBudget;
  /** 시험용: 대기 함수 바꿔 끼우기 */
  sleep?: (ms: number) => void;
  delays?: readonly number[];
}

/**
 * UTF-8 로 읽고 BOM 을 뗀다. EBUSY 같은 일시적 오류는 잠깐 기다려 다시 읽는다(OneDrive 동기화·백신·
 * 배타 잠금으로 여는 프로그램과 겹치는 순간). 그래도 실패하면 예외를 그대로 던진다.
 */
export function readTextFile(absPath: string, opts: ReadTextOptions = {}): string {
  const delays = opts.delays ?? READ_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      return stripBom(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
      if (attempt >= delays.length || !TRANSIENT_READ_ERRORS.has(errCode(err))) throw err;
      const wait = delays[attempt];
      if (opts.budget && !opts.budget.take(wait)) throw err;
      sleep(wait);
    }
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** \r\n · \n · \r 모두 줄바꿈으로 본다. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** 오류 객체에서 짧은 코드(ENOENT 등)나 메시지를 뽑는다. */
export function errCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(err);
}

const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * 볼트 기준 상대경로가 안전한지(볼트 밖으로 나가지 않는지) 보고, '/' 로 정규화해 돌려준다.
 * 절대경로·드라이브·`..`·빈 조각은 거부(null).
 */
export function safeVaultRelative(relPath: string): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) return null;
  // 제어 문자(NUL 포함)는 거부
  if (/[\u0000-\u001f]/.test(relPath)) return null;
  let p = toPosix(relPath);
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/') || p.includes(':')) return null;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return null;
    // Windows 는 조각 끝의 점·공백을 지운다('.. ' → '..'). 애매한 조각은 받지 않는다.
    if (/[. ]$/.test(s) || /^\s/.test(s)) return null;
    // Windows 장치 이름(CON.md 등)은 파일이 아니다
    if (WINDOWS_DEVICE_RE.test(s)) return null;
  }
  return p;
}

/** child 가 parent 폴더 안(같은 경로 제외)에 있는가. Windows 에서는 대소문자를 가리지 않는다. */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '' || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../');
}
