// 앱 설정. 환경 변수와 config/holidays-kr.json 을 읽어 한 곳에 모은다.
// 계약: docs/stage1-contract.md §5, docs/stage2-contract.md §2·§6·§7
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import holidaysFile from '../../config/holidays-kr.json';
import type { Holiday } from '../shared/types';

/** 실제 위키(마스터 볼트) 기본 위치. 테스트는 WIKI_RADAR_WIKI 로 사본을 가리킨다. */
export const DEFAULT_WIKI_ROOT = path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI');

// 감시에서 뺄 폴더 목록은 스냅샷과 같아야 하므로 src/main/wiki/fsutil.ts 의 EXCLUDED_DIRS 를 그대로 쓴다.

/** 제외 폴더 안에 있지만 스냅샷 원천이라 감시해야 하는 파일(볼트 기준 상대경로). */
export const WATCHED_SPECIAL_FILES: readonly string[] = ['_todo-sync/items.json', '_raw-link/link_raw.py'];

/** 파일이 바뀐 뒤 이만큼 조용하면 스냅샷을 다시 만든다. */
export const WATCH_DEBOUNCE_MS = 800;
/** 위키 폴더가 없거나 감시가 끊겼을 때 다시 붙기를 시도하는 주기. */
export const WATCH_RETRY_MS = 10_000;
/** 부분 스냅샷(잠긴 파일 등)·재생성 실패를 다시 시도하는 첫 간격과 상한(지수 백오프). */
export const PARTIAL_RETRY_INITIAL_MS = 2_000;
export const PARTIAL_RETRY_MAX_MS = 60_000;
/** 날짜가 바뀌었는지 보는 주기. */
export const DATE_CHECK_INTERVAL_MS = 60_000;

/** 모드 전환 전역 단축키(Electron accelerator 표기). */
export const TOGGLE_SHORTCUT = 'Control+Alt+R';

export const SIDEBAR_WIDTH = 320;
export const FULL_WIDTH = 1440;
export const FULL_HEIGHT = 900;
/** 창 바탕색. 불러오는 동안 흰 화면이 번쩍이지 않게 renderer 바탕과 맞춘다. */
export const WINDOW_BACKGROUND = '#14202B';

/** IPC 인자 길이 제한. */
export const MAX_REL_PATH_LENGTH = 1024;
export const MAX_TASK_ID_LENGTH = 128;
/** 반영 대기열 항목 ID 길이 제한 */
export const MAX_QUEUE_ID_LENGTH = 128;
/** 처리 결과 저장: 담당자·처리 내용(메모) 길이 제한 */
export const MAX_OWNER_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 8000;

/** claude 실행 파일 기본 위치(WIKI_RADAR_CLAUDE 도 PATH 에도 없을 때). */
export const DEFAULT_CLAUDE_PATH = path.join(os.homedir(), '.local', 'bin', 'claude.exe');

export interface AppConfig {
  /** 마스터 볼트 절대경로 */
  wikiRoot: string;
  /** WIKI_RADAR_TODAY 로 고정한 날짜(테스트용). 없으면 null → 로컬 오늘 */
  fixedToday: string | null;
  holidays: Holiday[];
  /** WIKI_RADAR_USER_DATA 로 바꾼 사용자 데이터 폴더(테스트를 실제 실행과 분리할 때). 없으면 null */
  userDataDir: string | null;
  /**
   * queue.json·reflect-history.json 을 둘 데이터 폴더. WIKI_RADAR_DATA → WIKI_RADAR_USER_DATA 순.
   * 둘 다 없으면 null → app.getPath('userData')(resolveDataDir 가 채운다). 2단계 명세 §7
   */
  dataDir: string | null;
  /** 설정을 읽다 생긴 문제(무시한 값 등). 시작할 때 로그로 남긴다 */
  warnings: string[];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 로컬 시간대 기준 YYYY-MM-DD. toISOString(UTC)을 쓰면 새벽 9시 전에 하루 밀리므로 쓰지 않는다. */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 달력에 실제로 있는 YYYY-MM-DD 인가(2026-02-30 같은 값은 거짓). */
export function isValidDateString(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === day;
}

function readHolidays(warnings: string[]): Holiday[] {
  const list: unknown = (holidaysFile as { holidays?: unknown }).holidays;
  if (!Array.isArray(list)) {
    warnings.push('config/holidays-kr.json 에 holidays 배열이 없어 공휴일 없이 계산합니다');
    return [];
  }
  const out: Holiday[] = [];
  for (const h of list) {
    const date = (h as { date?: unknown } | null)?.date;
    const name = (h as { name?: unknown } | null)?.name;
    if (typeof date === 'string' && isValidDateString(date) && typeof name === 'string') {
      out.push({ date, name });
    } else {
      warnings.push(`공휴일 항목을 무시함: ${JSON.stringify(h)}`);
    }
  }
  return out;
}

/** 환경 변수에서 설정을 읽는다. env 를 넘기면 그것을 쓴다(시험용). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const warnings: string[] = [];

  const wikiEnv = env.WIKI_RADAR_WIKI?.trim();
  const wikiRoot = path.resolve(wikiEnv ? wikiEnv : DEFAULT_WIKI_ROOT);

  let fixedToday: string | null = null;
  const todayEnv = env.WIKI_RADAR_TODAY?.trim();
  if (todayEnv) {
    if (isValidDateString(todayEnv)) fixedToday = todayEnv;
    else warnings.push(`WIKI_RADAR_TODAY 값이 YYYY-MM-DD 날짜가 아니라 무시함: ${todayEnv}`);
  }

  const userDataEnv = env.WIKI_RADAR_USER_DATA?.trim();
  const userDataDir = userDataEnv ? path.resolve(userDataEnv) : null;

  const dataEnv = env.WIKI_RADAR_DATA?.trim();
  const dataDir = dataEnv ? path.resolve(dataEnv) : userDataDir;

  return { wikiRoot, fixedToday, holidays: readHolidays(warnings), userDataDir, dataDir, warnings };
}

/** 데이터 폴더를 정한다. 설정에 없으면 Electron 사용자 데이터 폴더(app.getPath('userData')). */
export function resolveDataDir(config: Pick<AppConfig, 'dataDir'>, electronUserData: string): string {
  return config.dataDir ?? path.resolve(electronUserData);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ClaudeLocation {
  /** 실행할 파일의 절대경로 */
  path: string;
  /** 어디서 찾았나: 환경 변수 · PATH · 기본 위치 */
  source: 'env' | 'path' | 'default';
  /** 그 경로에 파일이 실제로 있는가 */
  exists: boolean;
}

/**
 * claude 실행 파일을 찾는다: WIKI_RADAR_CLAUDE → PATH 의 claude.exe → DEFAULT_CLAUDE_PATH.
 * WIKI_RADAR_CLAUDE 가 .mjs·.cjs·.js 면 시험용 가짜 스크립트다(node 로 실행하는 것은 reflect.ts 가 한다).
 * 환경 변수로 준 값은 파일이 없어도 그대로 돌려준다(다른 곳으로 몰래 넘어가지 않는다 — exists 로 알린다).
 */
export function findClaudePath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isFile): ClaudeLocation {
  const fromEnv = env.WIKI_RADAR_CLAUDE?.trim().replace(/^"(.*)"$/, '$1');
  if (fromEnv) {
    const p = path.resolve(fromEnv);
    return { path: p, source: 'env', exists: exists(p) };
  }

  // Windows 의 process.env 는 이름의 대소문자를 가리지 않지만, 넘겨받은 일반 객체는 가린다(Path 로 올 수 있다).
  const pathVar = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const raw of pathVar.split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir)) continue; // 상대 경로 PATH 조각은 작업 폴더에 따라 달라지므로 보지 않는다
    const p = path.join(dir, exe);
    if (exists(p)) return { path: path.resolve(p), source: 'path', exists: true };
  }

  return { path: DEFAULT_CLAUDE_PATH, source: 'default', exists: exists(DEFAULT_CLAUDE_PATH) };
}

/** 지금 기준의 '오늘'. 고정 날짜가 있으면 그것, 없으면 로컬 오늘. */
export function currentToday(config: Pick<AppConfig, 'fixedToday'>): string {
  return config.fixedToday ?? localDateString();
}
