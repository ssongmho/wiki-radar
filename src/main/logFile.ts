// main 로그 파일(2.13단계 명세 §C-6 [로그 폴더 열기]). electron 을 import 하지 않는다.
//
// - console.log/warn/error 를 그대로 두고 `<로그 폴더>/radar-YYYY-MM-DD.log` 에도 한 줄씩 덧붙인다.
// - 하루 5MB 넘으면 그날은 더 쓰지 않는다(한 줄 알림). 7일 지난 파일은 시작할 때 지운다.
// - 줄마다 redactSecrets(알려진 비밀)를 거친다 — 비밀번호·키가 로그 파일에 남지 않게(이중 방어).
// - 최근 경고 줄(warn·error) 50개를 메모리에 둔다(진단 정보).
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { localDateString, localDateTimeString } from './config';
import { redactSecrets } from './mail/account';

export const LOG_FILE_PREFIX = 'radar-';
export const LOG_DAY_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_DAYS = 7;
const RECENT_WARN_MAX = 50;
const LINE_MAX = 4000;

export interface LogFileOptions {
  dir: string;
  /** 지금 아는 비밀(부를 때마다 — 저장하면 바뀐다) */
  secrets: () => readonly string[];
  now?: () => Date;
}

export interface LogFile {
  dir: string;
  /** 최근 경고·오류 줄(가린 것, 오래된 것부터) */
  recentWarnings(): string[];
  /** 한 줄 쓰기(console 을 거치지 않고) */
  write(level: 'log' | 'warn' | 'error', text: string): void;
  restore(): void;
}

/** 7일 지난 radar-YYYY-MM-DD.log 를 지운다. 지운 수 */
export function pruneLogs(dir: string, today: string, keepDays = LOG_KEEP_DAYS): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const [y, m, d] = today.split('-').map(Number);
  const cutoff = localDateString(new Date(y, m - 1, d - keepDays));
  let removed = 0;
  for (const name of names) {
    const mm = /^radar-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (!mm || mm[1] >= cutoff) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch {
      // 지우지 못하면 다음에
    }
  }
  return removed;
}

/** console 을 감싼다. 쓰기 실패는 조용히 넘어간다(로그 때문에 앱이 멈추지 않게) */
export function installLogFile(opts: LogFileOptions): LogFile {
  const now = opts.now ?? (() => new Date());
  const recent: string[] = [];
  let day = '';
  let bytes = 0;
  let full = false;
  let broken = false;
  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    pruneLogs(opts.dir, localDateString(now()));
  } catch {
    broken = true;
  }

  const write = (level: 'log' | 'warn' | 'error', text: string): void => {
    let line: string;
    try {
      line = redactSecrets(text, opts.secrets()).replace(/\r?\n/g, ' ⏎ ');
    } catch {
      line = text;
    }
    if (line.length > LINE_MAX) line = `${line.slice(0, LINE_MAX)}…`;
    if (level !== 'log') {
      recent.push(`${localDateTimeString(now())} ${line}`);
      if (recent.length > RECENT_WARN_MAX) recent.shift();
    }
    if (broken) return;
    const d = now();
    const today = localDateString(d);
    const file = path.join(opts.dir, `${LOG_FILE_PREFIX}${today}.log`);
    if (today !== day) {
      day = today;
      full = false;
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
    }
    if (full) return;
    let out = `${localDateTimeString(d)} ${level === 'log' ? 'INFO' : level === 'warn' ? 'WARN' : 'ERROR'} ${line}\n`;
    if (bytes + Buffer.byteLength(out, 'utf8') > LOG_DAY_MAX_BYTES) {
      full = true;
      out = `${localDateTimeString(d)} WARN 오늘 로그가 ${LOG_DAY_MAX_BYTES / 1024 / 1024}MB 를 넘어 내일까지 더 쓰지 않습니다\n`;
    }
    try {
      fs.appendFileSync(file, out, 'utf8');
      bytes += Buffer.byteLength(out, 'utf8');
    } catch {
      // 다음 줄에서 다시 해 본다
    }
  };

  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      original[level](...args);
      try {
        write(level, format(...args));
      } catch {
        // 로그 파일 실패는 무시
      }
    };
  }
  return {
    dir: opts.dir,
    recentWarnings: () => [...recent],
    write,
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}
