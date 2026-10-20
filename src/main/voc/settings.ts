// VOC 보드 설정(voc-settings.json)과 VOC 쓰기 기록(voc-actions.json). electron 을 import 하지 않는다.
// 계약: docs/stage2.6-contract.md §4·§7
//
// - 저장은 queue.ts 의 원자적 쓰기(writeJsonAtomic)를 쓴다.
// - 깨진 voc-settings.json(JSON 아님·형식 틀림)은 `.broken-<시각>` 으로 옮기고 기본값으로 시작한다(mail/stores.ts
//   MailSettingsStore 와 같다). 잠겨서 읽지 못하면 이번에는 기본값을 주되 기억하지 않는다(다음에 다시 읽는다) — 보드는
//   읽기만 하므로 막을 까닭이 없고, 파일은 사람이 [저장]할 때만 덮어쓴다.
// - voc-actions.json 은 최근 것부터 500건. 깨진 파일은 loadJsonArray 규칙(옮기고 빈 기록), 읽지 못하면 예외 —
//   같은 actionId 를 두 번 실행했는지 알 수 없으므로 부르는 쪽이 쓰기를 막는다.
import fs from 'node:fs';
import path from 'node:path';
import type { VocActionKind, VocSettings, VocWorkKind } from '../../shared/types';
import { vocLoginIdProblem } from '../../shared/voc';
import { normalizeVocApiUrl } from './api';
import { compactStamp, loadJsonArray, writeJsonAtomic } from '../queue';
import { errCode, readTextFile } from '../wiki/fsutil';

export const VOC_SETTINGS_FILE = 'voc-settings.json';
export const VOC_ACTIONS_FILE = 'voc-actions.json';
/** voc-actions.json 에 남기는 최근 건수 */
export const VOC_ACTIONS_LIMIT = 500;

/** 설정 한도(명세 §7) */
export const VOC_MEMBERS_MAX = 50;
export const VOC_SYSTEMS_MAX = 100;
export const VOC_POLL_MIN_MINUTES = 5;
export const VOC_POLL_MAX_MINUTES = 60;
const SYSTEM_CODE_MAX = 100;
const JAR_PATH_MAX = 1024;

/** 빈 목록 = 명세 §2-2 기본값(팀원 = 나와 같은 부서, 팀 시스템 = 팀원 담당 티켓의 시스템) */
export const DEFAULT_VOC_SETTINGS: VocSettings = Object.freeze({
  memberIds: Object.freeze([]) as unknown as number[],
  systems: Object.freeze([]) as unknown as string[],
  showAllUnassigned: false,
  pollMinutes: 10,
});

/** 기본값의 새 사본(고쳐도 DEFAULT_VOC_SETTINGS 는 그대로) */
function defaults(): VocSettings {
  return { memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: DEFAULT_VOC_SETTINGS.pollMinutes };
}

function copySettings(s: VocSettings): VocSettings {
  const out: VocSettings = {
    memberIds: [...s.memberIds],
    systems: [...s.systems],
    showAllUnassigned: s.showAllUnassigned,
    pollMinutes: s.pollMinutes,
  };
  if (s.myId !== undefined) out.myId = s.myId;
  if (s.apiUrl !== undefined) out.apiUrl = s.apiUrl;
  if (s.jarPath !== undefined) out.jarPath = s.jarPath;
  if (s.loginId !== undefined) out.loginId = s.loginId;
  return out;
}

function isUserId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** 절대경로인가. Windows 는 드라이브(`C:\`)나 UNC(`\\서버\공유`)로 시작해야 한다(`\폴더`는 드라이브에 따라 달라진다) */
function isAbsoluteFilePath(p: string): boolean {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
  return path.isAbsolute(p);
}

/**
 * 설정 값 검사(명세 §7). 빠진 필드는 기본값, 형이 틀리거나 규칙에 맞지 않으면 한국어 Error.
 * 팀원·시스템은 겹친 것을 빼고 순서를 지킨다. 시스템 코드·jar 경로는 앞뒤 공백을 걷는다. 알려진 필드만 남긴다.
 */
export function validateVocSettings(value: unknown): VocSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VOC 설정 형식이 맞지 않습니다');
  const v = value as Record<string, unknown>;

  const memberIds = v.memberIds ?? [];
  if (!Array.isArray(memberIds) || !memberIds.every(isUserId)) throw new Error('팀원 목록 형식이 맞지 않습니다(사용자 id 숫자 목록)');
  const members = [...new Set(memberIds)];
  if (members.length > VOC_MEMBERS_MAX) throw new Error(`팀원은 ${VOC_MEMBERS_MAX}명까지 고를 수 있습니다`);

  let myId: number | undefined;
  if (v.myId !== undefined && v.myId !== null) {
    if (!isUserId(v.myId)) throw new Error('나(사용자 id) 형식이 맞지 않습니다');
    myId = v.myId;
  }

  const systemsRaw = v.systems ?? [];
  if (!Array.isArray(systemsRaw) || !systemsRaw.every((s) => typeof s === 'string')) {
    throw new Error('팀 시스템 목록 형식이 맞지 않습니다(시스템 코드 목록)');
  }
  const systems: string[] = [];
  for (const raw of systemsRaw as string[]) {
    const code = raw.trim();
    if (code === '' || code.length > SYSTEM_CODE_MAX || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new Error(`시스템 코드가 올바르지 않습니다: ${JSON.stringify(raw.slice(0, 40))}`);
    }
    if (!systems.includes(code)) systems.push(code);
  }
  if (systems.length > VOC_SYSTEMS_MAX) throw new Error(`팀 시스템은 ${VOC_SYSTEMS_MAX}개까지 고를 수 있습니다`);

  const showAllUnassigned = v.showAllUnassigned ?? DEFAULT_VOC_SETTINGS.showAllUnassigned;
  if (typeof showAllUnassigned !== 'boolean') throw new Error('미배정 전체 보기 값 형식이 맞지 않습니다');

  const pollMinutes = v.pollMinutes ?? DEFAULT_VOC_SETTINGS.pollMinutes;
  if (
    typeof pollMinutes !== 'number' ||
    !Number.isInteger(pollMinutes) ||
    pollMinutes < VOC_POLL_MIN_MINUTES ||
    pollMinutes > VOC_POLL_MAX_MINUTES
  ) {
    throw new Error(`받는 주기는 ${VOC_POLL_MIN_MINUTES}~${VOC_POLL_MAX_MINUTES}분(정수)이어야 합니다`);
  }

  let jarPath: string | undefined;
  if (v.jarPath !== undefined && v.jarPath !== null) {
    if (typeof v.jarPath !== 'string') throw new Error('jar 위치 형식이 맞지 않습니다');
    const p = v.jarPath.trim().replace(/^"(.*)"$/, '$1').trim();
    if (p !== '') {
      if (p.length > JAR_PATH_MAX || /[\u0000-\u001f\u007f]/.test(p)) throw new Error('jar 위치가 올바르지 않습니다');
      if (!/\.jar$/i.test(p)) throw new Error('jar 위치는 .jar 파일이어야 합니다');
      if (!isAbsoluteFilePath(p)) throw new Error('jar 위치는 절대경로여야 합니다(예: C:\\…\\voc-cli-1.2.0.jar)');
      jarPath = p;
    }
  }

  // VOC 백엔드 주소(명세 §15). 비면 기본 주소
  let apiUrl: string | undefined;
  // 공백뿐인 값도 비운 것으로 본다(jarPath 와 같게)
  if (v.apiUrl !== undefined && v.apiUrl !== null && !(typeof v.apiUrl === 'string' && v.apiUrl.trim() === '')) {
    const u = normalizeVocApiUrl(v.apiUrl);
    if (u === null) throw new Error('VOC 서버 주소는 https://호스트[:포트] 모양이어야 합니다(경로 없이, http 는 이 PC 주소만)');
    apiUrl = u;
  }

  // 로그인 대화상자의 '아이디 기억'(명세 §13). 비면 없음. 비밀번호는 이 파일에 두지 않는다(알려진 필드만 남긴다)
  let loginId: string | undefined;
  if (v.loginId !== undefined && v.loginId !== null && v.loginId !== '') {
    if (typeof v.loginId !== 'string' || vocLoginIdProblem(v.loginId) !== null) {
      throw new Error('로그인 아이디 형식이 맞지 않습니다(영문·숫자와 . _ @ - 로 64자까지)');
    }
    loginId = v.loginId;
  }

  const settings: VocSettings = { memberIds: members, systems, showAllUnassigned, pollMinutes };
  if (myId !== undefined) settings.myId = myId;
  if (apiUrl !== undefined) settings.apiUrl = apiUrl;
  if (jarPath !== undefined) settings.jarPath = jarPath;
  if (loginId !== undefined) settings.loginId = loginId;
  return settings;
}

/** `<파일>.broken-<시각>` 중 아직 없는 이름 */
function brokenPathFor(filePath: string): string {
  const base = `${filePath}.broken-${compactStamp()}`;
  if (!fs.existsSync(base)) return base;
  for (let i = 2; ; i++) {
    const p = `${base}-${i}`;
    if (!fs.existsSync(p)) return p;
  }
}

/** <데이터 폴더>/voc-settings.json */
export class VocSettingsStore {
  private readonly file: string;
  private readonly onWarn?: (message: string) => void;
  private cached: VocSettings | null = null;
  /** 깨진 설정 파일을 기본값으로 되돌린 뒤 아직 다시 저장하지 않았으면 그 알림 */
  private recovered: string | null = null;

  constructor(dataDir: string, warn?: (m: string) => void) {
    this.file = path.join(dataDir, VOC_SETTINGS_FILE);
    this.onWarn = warn;
  }

  /** voc-settings.json 절대경로 */
  get filePath(): string {
    return this.file;
  }

  /** 깨진 설정 파일을 기본값으로 되돌렸으면(아직 저장 전) 그 알림 문장, 아니면 null */
  get notice(): string | null {
    return this.recovered;
  }

  /**
   * 설정(없으면 기본값). 깨진 파일은 `.broken-<시각>` 으로 옮기고 기본값으로 시작한다.
   * 읽지 못하면(잠김 등) 경고를 남기고 기본값을 주되 기억하지 않는다 — 다음에 다시 읽는다.
   */
  get(): VocSettings {
    if (this.cached) return copySettings(this.cached);
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') {
        this.cached = defaults();
        return copySettings(this.cached);
      }
      this.onWarn?.(`VOC 설정(${VOC_SETTINGS_FILE})을 읽지 못해 이번에는 기본값을 씁니다 (${code})`);
      return defaults();
    }
    let settings: VocSettings;
    try {
      settings = validateVocSettings(JSON.parse(text));
    } catch (err) {
      const reason = err instanceof SyntaxError ? 'JSON 이 아님' : err instanceof Error ? err.message : String(err);
      this.setAside(reason);
      settings = defaults();
    }
    this.cached = settings;
    return copySettings(settings);
  }

  /** 검사(validateVocSettings) 후 원자적으로 저장하고 저장한 값을 돌려준다. 틀리면 한국어 Error */
  save(value: unknown): VocSettings {
    const settings = validateVocSettings(value);
    writeJsonAtomic(this.file, settings);
    this.cached = settings;
    this.recovered = null;
    return copySettings(settings);
  }

  /**
   * 설정 대화상자의 [저장]: 기억한 로그인 아이디(loginId)는 로그인 대화상자만 바꾸므로 보낸 값의 loginId 는 버리고 지금 값을 지킨다
   * (설정 대화상자를 연 사이 로그인해 기억한 아이디를 옛 값으로 덮지 않게)
   */
  saveFromDialog(value: unknown): VocSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return this.save(value);
    const { loginId: _ignored, ...rest } = value as Record<string, unknown>;
    const current = this.get().loginId;
    return this.save(current !== undefined ? { ...rest, loginId: current } : rest);
  }

  /**
   * 로그인 대화상자의 '아이디 기억'(명세 §13): 아이디를 기억하거나(문자열) 지운다(undefined). 그 밖의 설정은 그대로 둔다.
   * 설정 파일을 읽지 못했으면(잠김 등) 기본값으로 덮지 않게 던진다. 바뀌는 것이 없으면 쓰지 않는다
   */
  setLoginId(loginId: string | undefined): VocSettings {
    const current = this.get();
    if (!this.cached) throw new Error(`VOC 설정(${VOC_SETTINGS_FILE})을 읽지 못해 아이디를 기억하지 못했습니다`);
    if (current.loginId === loginId) return current;
    const next: VocSettings = { ...current };
    if (loginId === undefined) delete next.loginId;
    else next.loginId = loginId;
    // save 와 같되 깨진 설정 알림(notice)은 남긴다 — 사람이 설정 대화상자에서 [저장]할 때까지
    const settings = validateVocSettings(next);
    writeJsonAtomic(this.file, settings);
    this.cached = settings;
    return copySettings(settings);
  }

  private setAside(reason: string): void {
    const target = brokenPathFor(this.file);
    let moved = false;
    try {
      fs.renameSync(this.file, target);
      moved = true;
    } catch {
      try {
        fs.copyFileSync(this.file, target);
        moved = true;
      } catch {
        // 옮기지도 복사하지도 못하면 경고만 남긴다
      }
    }
    this.onWarn?.(
      `VOC 설정(${VOC_SETTINGS_FILE})이 깨져 있어 기본값으로 시작합니다. ` +
        (moved ? `원래 파일은 ${path.basename(target)} 로 옮겼습니다` : '원래 파일을 옮기지 못했습니다') +
        ` (원인: ${reason})`,
    );
    this.recovered =
      'VOC 설정 파일이 깨져 있어 기본값(팀원 = 나와 같은 부서)으로 되돌렸습니다' +
      (moved ? `(원래 파일은 데이터 폴더의 ${path.basename(target)})` : '') +
      '. 설정을 확인하고 [저장]을 누르세요.';
  }
}

// ---- 쓰기 기록 -------------------------------------------------------------------------------

/** voc-actions.json 한 건. id = actionId(동작) 또는 createId(등록) */
export interface VocActionRecord {
  id: string;
  at: string;
  kind: VocActionKind | 'create' | VocWorkKind;
  ticketId?: number;
  number?: string;
  detail: string;
  ok: boolean;
  message?: string;
}

const RECORD_KINDS: ReadonlySet<string> = new Set<VocActionRecord['kind']>([
  'assign',
  'ictDue',
  'priority',
  'status',
  'reply',
  'create',
  // V4(명세 §14)
  'worklogAdd',
  'worklogDelete',
  'resolve',
  'close',
  'reopen',
  'email',
]);

/** 저장·읽기 공용 정규화. 알려진 필드만 남긴다. 형식이 틀리면 null */
function toActionRecord(raw: unknown): VocActionRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return null;
  if (typeof r.at !== 'string' || r.at === '') return null;
  if (typeof r.kind !== 'string' || !RECORD_KINDS.has(r.kind)) return null;
  if (typeof r.detail !== 'string') return null;
  if (typeof r.ok !== 'boolean') return null;
  const record: VocActionRecord = { id: r.id, at: r.at, kind: r.kind as VocActionRecord['kind'], detail: r.detail, ok: r.ok };
  if (r.ticketId !== undefined && r.ticketId !== null) {
    if (typeof r.ticketId !== 'number' || !Number.isSafeInteger(r.ticketId)) return null;
    record.ticketId = r.ticketId;
  }
  if (r.number !== undefined && r.number !== null) {
    if (typeof r.number !== 'string') return null;
    if (r.number !== '') record.number = r.number;
  }
  if (r.message !== undefined && r.message !== null) {
    if (typeof r.message !== 'string') return null;
    if (r.message !== '') record.message = r.message;
  }
  return record;
}

/** <데이터 폴더>/voc-actions.json — 최근 것부터, VOC_ACTIONS_LIMIT 건까지 */
export class VocActionLog {
  private readonly file: string;
  private readonly onWarn?: (message: string) => void;
  /** 처음 쓸 때 읽는다. 읽지 못했으면(예외) null 로 남아 다음에 다시 읽는다 */
  private records: VocActionRecord[] | null = null;
  /** 이번 실행 중 add 로 받은 id — 파일에 쓰지 못했어도 같은 id 를 두 번 실행하지 않게 */
  private readonly seen = new Set<string>();

  constructor(dataDir: string, warn?: (m: string) => void) {
    this.file = path.join(dataDir, VOC_ACTIONS_FILE);
    this.onWarn = warn;
  }

  /** voc-actions.json 절대경로 */
  get filePath(): string {
    return this.file;
  }

  private load(): VocActionRecord[] {
    if (this.records) return this.records;
    const { items } = loadJsonArray(this.file, 'VOC 쓰기 기록', toActionRecord, this.onWarn);
    // 같은 id 가 두 번 있으면 앞(최근)의 것만
    const ids = new Set<string>();
    this.records = items
      .filter((x) => {
        if (ids.has(x.id)) return false;
        ids.add(x.id);
        return true;
      })
      .slice(0, VOC_ACTIONS_LIMIT);
    return this.records;
  }

  /** 이 id(actionId·createId)를 이미 실행했는가. 기록을 읽지 못하면 Error(부르는 쪽이 쓰기를 막는다) */
  has(id: string): boolean {
    if (this.seen.has(id)) return true;
    return this.load().some((r) => r.id === id);
  }

  /**
   * 맨 앞에 더하고 원자적으로 저장한다. 같은 id 가 이미 있거나 형식이 틀리면 Error.
   * 저장에 실패하면 Error 를 던지지만 이번 실행 중에는 has(id) 가 참이다.
   */
  add(r: VocActionRecord): void {
    const entry = toActionRecord(structuredClone(r));
    if (!entry) throw new Error('VOC 쓰기 기록 형식이 맞지 않습니다');
    if (this.seen.has(entry.id)) throw new Error('이미 실행한 동작입니다(같은 actionId)');
    const current = this.load();
    if (current.some((x) => x.id === entry.id)) throw new Error('이미 실행한 동작입니다(같은 actionId)');
    this.seen.add(entry.id);
    const next = [entry, ...current].slice(0, VOC_ACTIONS_LIMIT);
    writeJsonAtomic(this.file, next);
    this.records = next;
  }

  /** 최근 것부터 */
  list(): VocActionRecord[] {
    return this.load().map((r) => ({ ...r }));
  }
}
