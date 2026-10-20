// 발송 기록(sent-mail.json + sent/*.eml)과 보내는 이름·서명 설정(mail-settings.json).
// electron 을 import 하지 않는다. 계약: docs/stage2.5-contract.md §4-3·§5-2
//
// - 저장은 queue.ts 의 원자적 쓰기(writeJsonAtomic)를 쓴다. 깨진 sent-mail.json 은 `.broken-<시각>` 으로 옮기고
//   빈 기록으로 시작한다(loadJsonArray). 읽을 수 없으면(잠김 등) 덮어쓰지 않도록 예외를 던진다.
// - .eml 은 보낸 MIME 바이트 그대로(숨은참조 머리말 없음). 같은 이름이 있으면 -2, -3 … 을 붙인다.
import fs from 'node:fs';
import path from 'node:path';
import type { MailSettings, SentMailRecord } from '../../shared/types';
import { settingsProblem } from '../../shared/reply';
import { compactStamp, loadJsonArray, writeJsonAtomic } from '../queue';
import { errCode, readTextFile } from '../wiki/fsutil';

export const SENT_FILE = 'sent-mail.json';
export const SENT_DIR = 'sent';
/** sent-mail.json 에 남기는 최근 건수(오래된 .eml 파일은 지우지 않는다) */
export const SENT_LIMIT = 500;
export const SETTINGS_FILE = 'mail-settings.json';

export const DEFAULT_MAIL_SETTINGS: Readonly<MailSettings> = Object.freeze({ fromName: '', signature: '', bccSelf: true });

// ---- 발송 기록 ------------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 저장·읽기 공용 정규화. 알려진 필드만 남긴다. 형식이 틀리면 null */
function toSentRecord(raw: unknown): SentMailRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  for (const key of ['id', 'at', 'mail', 'messageId'] as const) {
    if (typeof r[key] !== 'string' || r[key] === '') return null;
  }
  // 메일함 회신(2.10단계 §7-1)은 할 일 없이 보내 taskId 가 '' 다 — origin 'mailbox' 일 때만 빈 값을 받는다
  const origin = r.origin === 'mailbox' ? 'mailbox' : undefined;
  if (r.origin !== undefined && r.origin !== null && origin === undefined) return null;
  if (typeof r.taskId !== 'string' || (r.taskId === '' && origin === undefined)) return null;
  if (typeof r.taskTitle !== 'string' || typeof r.subject !== 'string') return null;
  if (!isStringArray(r.to) || !isStringArray(r.cc) || !isStringArray(r.bcc)) return null;
  const record: SentMailRecord = {
    id: r.id as string,
    at: r.at as string,
    taskId: r.taskId as string,
    taskTitle: r.taskTitle,
    mail: r.mail as string,
    to: [...r.to],
    cc: [...r.cc],
    bcc: [...r.bcc],
    subject: r.subject,
    messageId: r.messageId as string,
  };
  if (r.response !== undefined && r.response !== null) {
    if (typeof r.response !== 'string') return null;
    record.response = r.response;
  }
  if (r.eml !== undefined && r.eml !== null) {
    if (typeof r.eml !== 'string') return null;
    if (r.eml !== '') record.eml = r.eml;
  }
  if (origin) record.origin = origin;
  return record;
}

function copyRecord(r: SentMailRecord): SentMailRecord {
  return structuredClone(r);
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** sendId 앞 8자(파일 이름에 쓸 수 있는 글자만) */
function idPrefix(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8);
  return safe === '' ? 'mail' : safe;
}

/** 새 파일을 만들어 쓰고 fsync 한다. 이미 있으면 EEXIST 로 실패한다(덮어쓰지 않는다) */
function writeNewFile(filePath: string, data: Buffer): void {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** <데이터 폴더>/sent-mail.json — 최근 것부터, SENT_LIMIT 건까지 */
export class SentLog {
  private readonly dataDir: string;
  private readonly file: string;
  private readonly onWarn?: (message: string) => void;
  /** 처음 쓸 때 읽는다. 읽지 못했으면(예외) null 로 남아 다음에 다시 읽는다 */
  private records: SentMailRecord[] | null = null;

  constructor(dataDir: string, warn?: (m: string) => void) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, SENT_FILE);
    this.onWarn = warn;
  }

  /** sent-mail.json 절대경로 */
  get filePath(): string {
    return this.file;
  }

  private load(): SentMailRecord[] {
    if (this.records) return this.records;
    const { items } = loadJsonArray(this.file, '발송 기록', toSentRecord, this.onWarn);
    // 같은 id 가 두 번 있으면 앞(최근)의 것만
    const seen = new Set<string>();
    this.records = items
      .filter((x) => {
        if (seen.has(x.id)) return false;
        seen.add(x.id);
        return true;
      })
      .slice(0, SENT_LIMIT);
    return this.records;
  }

  /** 최근 것부터 */
  list(): SentMailRecord[] {
    return this.load().map(copyRecord);
  }

  has(id: string): boolean {
    return this.load().some((r) => r.id === id);
  }

  /** 이 할 일로 보낸 가장 최근 기록(at 기준, 같으면 나중에 넣은 것) */
  lastForTask(taskId: string): SentMailRecord | undefined {
    // 메일함 회신(taskId '')은 어떤 할 일과도 맞지 않는다
    if (taskId === '') return undefined;
    let best: SentMailRecord | undefined;
    for (const r of this.load()) {
      if (r.taskId !== taskId) continue;
      if (!best || timeOf(r.at) > timeOf(best.at)) best = r;
    }
    return best ? copyRecord(best) : undefined;
  }

  /**
   * 이 할 일로 보낸 가장 최근 기록 — mailPaths 를 주면 그 메일 경로로 메일함에서 보낸 기록(origin 'mailbox')도 본다(2.10단계 §7-1).
   * at 기준, 같으면 나중에 넣은 것
   */
  lastFor(taskId: string, mailPaths: readonly string[] = []): SentMailRecord | undefined {
    let best: SentMailRecord | undefined;
    for (const r of this.load()) {
      const hit = (taskId !== '' && r.taskId === taskId) || (r.origin === 'mailbox' && mailPaths.includes(r.mail));
      if (!hit) continue;
      if (!best || timeOf(r.at) > timeOf(best.at)) best = r;
    }
    return best ? copyRecord(best) : undefined;
  }

  /** 이 메일 경로들로 보낸 가장 최근 기록(할 일 회신·메일함 회신 모두) */
  lastForMail(mailPaths: readonly string[]): SentMailRecord | undefined {
    let best: SentMailRecord | undefined;
    for (const r of this.load()) {
      if (!mailPaths.includes(r.mail)) continue;
      if (!best || timeOf(r.at) > timeOf(best.at)) best = r;
    }
    return best ? copyRecord(best) : undefined;
  }

  /**
   * .eml 을 먼저 쓰고 기록을 맨 앞에 더한다(원자적 쓰기). 같은 id 가 이미 있으면 Error.
   * .eml 을 쓰지 못하면 경고(warn)만 남기고 eml 없이 기록한다 — 발송 기록(중복 발송 방지)이 더 중요하다.
   * 기록 파일을 쓰지 못하면 Error(.eml 은 남는다).
   */
  add(record: Omit<SentMailRecord, 'eml'>, eml: Buffer): SentMailRecord {
    const current = this.load();
    const entry = toSentRecord({ ...record, eml: undefined });
    if (!entry) throw new Error('발송 기록 형식이 맞지 않습니다');
    if (current.some((r) => r.id === entry.id)) throw new Error('이미 보낸 메일입니다(같은 작성 칸)');

    if (Buffer.isBuffer(eml) && eml.length > 0) {
      try {
        entry.eml = this.writeEml(entry, eml);
      } catch (err) {
        this.onWarn?.(`보낸 메일 사본(.eml)을 저장하지 못했습니다 (${errCode(err)})`);
      }
    }

    const next = [entry, ...current].slice(0, SENT_LIMIT);
    writeJsonAtomic(this.file, next);
    this.records = next;
    return copyRecord(entry);
  }

  /** sent/<YYYYMMDDTHHMMSS>_<id 앞 8자>.eml (있으면 -2, -3 …). 데이터 폴더 기준 상대경로('/')를 돌려준다 */
  private writeEml(entry: SentMailRecord, eml: Buffer): string {
    const dir = path.join(this.dataDir, SENT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const t = Date.parse(entry.at);
    const stem = `${compactStamp(Number.isNaN(t) ? new Date() : new Date(t))}_${idPrefix(entry.id)}`;
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `${stem}.eml` : `${stem}-${i}.eml`;
      try {
        writeNewFile(path.join(dir, name), eml);
        return `${SENT_DIR}/${name}`;
      } catch (err) {
        if (errCode(err) !== 'EEXIST') throw err;
      }
    }
    throw new Error('같은 이름의 사본이 너무 많습니다');
  }
}

// ---- 보내는 이름·서명 -------------------------------------------------------------------------

/** 줄바꿈을 LF 로 */
function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * 설정 값 검사(명세 §5-2). 빠진 필드는 기본값, 형이 틀리거나 규칙에 맞지 않으면 한국어 Error.
 * 보내는 이름은 앞뒤 공백을 걷고, 서명은 줄바꿈을 LF 로 바꾼다. 알려진 필드만 남긴다.
 */
export function validateMailSettings(value: unknown): MailSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('메일 설정 형식이 맞지 않습니다');
  const v = value as Record<string, unknown>;
  const fromName = v.fromName ?? DEFAULT_MAIL_SETTINGS.fromName;
  const signature = v.signature ?? DEFAULT_MAIL_SETTINGS.signature;
  const bccSelf = v.bccSelf ?? DEFAULT_MAIL_SETTINGS.bccSelf;
  if (typeof fromName !== 'string') throw new Error('보내는 이름 형식이 맞지 않습니다');
  if (typeof signature !== 'string') throw new Error('서명 형식이 맞지 않습니다');
  if (typeof bccSelf !== 'boolean') throw new Error('나에게 숨은참조 값 형식이 맞지 않습니다');
  const settings: MailSettings = { fromName: fromName.trim(), signature: toLf(signature), bccSelf };
  const problem = settingsProblem(settings);
  if (problem) throw new Error(problem);
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

/** <데이터 폴더>/mail-settings.json */
export class MailSettingsStore {
  private readonly file: string;
  private readonly onWarn?: (message: string) => void;
  private cached: MailSettings | null = null;
  /** 깨진 파일을 옮기고 기본값으로 시작했다는 알림 — 사람이 설정을 다시 저장할 때까지 회신 문맥에 보인다 */
  private recovered: string | null = null;

  constructor(dataDir: string, warn?: (m: string) => void) {
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.onWarn = warn;
  }

  /** mail-settings.json 절대경로 */
  get filePath(): string {
    return this.file;
  }

  /** 깨진 설정 파일을 기본값으로 되돌린 뒤 아직 다시 저장하지 않았으면 그 알림 문장, 아니면 null */
  get notice(): string | null {
    return this.recovered;
  }

  /**
   * 설정(없으면 기본값). 깨진 파일(JSON 아님·형식 틀림)은 `.broken-<시각>` 으로 옮기고 기본값으로 시작한다(notice 에 남긴다).
   * 읽지 못하면(잠김·권한·그 자리에 폴더 등) 기본값으로 속이지 않고 Error 를 던진다 — 보내는 이름·서명 없이 몰래 보내지
   * 않게(2.5단계 명세 §9-3). 기억하지 않으므로 다음에 다시 읽는다.
   */
  get(): MailSettings {
    if (this.cached) return { ...this.cached };
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') {
        this.cached = { ...DEFAULT_MAIL_SETTINGS };
        return { ...this.cached };
      }
      const message = `메일 설정(${SETTINGS_FILE})을 읽지 못했습니다 (${code})`;
      this.onWarn?.(message);
      throw new Error(message);
    }
    let settings: MailSettings;
    try {
      settings = validateMailSettings(JSON.parse(text));
    } catch (err) {
      const reason = err instanceof SyntaxError ? 'JSON 이 아님' : err instanceof Error ? err.message : String(err);
      this.setAside(reason);
      settings = { ...DEFAULT_MAIL_SETTINGS };
    }
    this.cached = settings;
    return { ...settings };
  }

  /** 검사(validateMailSettings) 후 원자적으로 저장하고 저장한 값을 돌려준다. 틀리면 한국어 Error */
  save(value: unknown): MailSettings {
    const settings = validateMailSettings(value);
    writeJsonAtomic(this.file, settings);
    this.cached = settings;
    this.recovered = null;
    return { ...settings };
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
      `메일 설정(${SETTINGS_FILE})이 깨져 있어 기본값으로 시작합니다. ` +
        (moved ? `원래 파일은 ${path.basename(target)} 로 옮겼습니다` : '원래 파일을 옮기지 못했습니다') +
        ` (원인: ${reason})`,
    );
    this.recovered =
      '메일 설정 파일이 깨져 있어 기본값(보내는 이름·서명 없음)으로 되돌렸습니다' +
      (moved ? `(원래 파일은 데이터 폴더의 ${path.basename(target)})` : '') +
      '. 보내는 사람·서명을 확인하고 [설정 저장]을 누르세요.';
  }
}
