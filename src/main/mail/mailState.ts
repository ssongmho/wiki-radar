// 메일 상태(미확인·회신 필요·처리함) — <데이터 폴더>/mail-state.json. electron 을 import 하지 않는다.
// 계약: docs/stage2.10-contract.md §3
//
// - raw/ 는 건드리지 않는다. 상태는 앱 데이터 폴더에만 쓴다.
// - 원자적 쓰기(queue.ts writeJsonAtomic). 깨진 파일(JSON 아님·형식 틀림)은 mail-state.broken-<시각>.json 으로 옮기고 새로 시작한다.
// - ENOENT 가 아닌 읽기 실패(잠김·권한)는 빈 상태로 덮어쓰지 않는다 — 쓰기를 거부하고 다음에 다시 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import type { MailIndexEntry, MailKey, MailStateChange } from '../../shared/types';
import { MAIL_KEY_RE } from '../../shared/mailThread';
import { compactStamp, writeJsonAtomic } from '../queue';
import { errCode, readTextFile } from '../wiki/fsutil';

export const MAIL_STATE_FILE = 'mail-state.json';
/** 처음 실행 기준선: 처음 색인한 시각에서 이만큼 앞(§3-2) */
export const MAIL_BASELINE_BACK_MS = 72 * 3_600_000;
/** 항목 수 한도(넘으면 read 만 있는 오래된 항목부터 버린다) */
export const MAIL_STATE_MAX_ENTRIES = 20_000;
/** 파일 크기 한도 */
export const MAIL_STATE_MAX_BYTES = 4 * 1024 * 1024;

export interface MailMark {
  /** 읽음으로 바꾼 시각 */
  read?: string;
  /** 사람이 「미확인으로」 — read 보다 우선 */
  unread?: string;
  /** 「회신 필요」 표시 시각(사람만 켠다) */
  replyNeeded?: string;
  /** 「처리함」 시각 */
  archived?: string;
  /** 메일함에서 VOC 로 등록(할 일 없이 — §7-2) */
  voc?: { number: string; ticketId: number; at: string };
  /** 메일함에서 [할 일로] 만든 줄의 파일(§7-3) */
  task?: { file: string; at: string };
  /** 위키 반영 실행이 이 메일을 보냈고 성공함(2.14단계 §7-1) — skipped = Claude 가 건너뜀 */
  wiki?: { at: string; state: 'done' | 'skipped'; runId: string };
  /** 마지막으로 본 경로(판정에 쓰지 않음) */
  path?: string;
}

export interface MailStateFile {
  version: 1;
  /** 처음 색인한 시각 − 72시간. 이보다 오래된 메일은 표시가 없으면 읽음으로 본다 */
  baselineAt: string;
  mails: Record<MailKey, MailMark>;
}

export interface MailFlags {
  unread: boolean;
  replyNeeded: boolean;
  archived: boolean;
}

/**
 * 판정(§3-2). 미확인 = 내 사본·노이즈 추정·처리함이 아니고 (「미확인으로」 표시가 있거나 (읽음 표시가 없고 기준선 이후 메일)).
 * 회신 필요 = 표시가 있고 처리함이 아님. 처리함 = 표시가 있음.
 */
export function mailFlags(entry: Pick<MailIndexEntry, 'mine' | 'muted' | 'dateMs'>, mark: MailMark | undefined, baselineMs: number): MailFlags {
  const archived = !!mark?.archived;
  const unread =
    !entry.mine && !entry.muted && !archived && (!!mark?.unread || (!mark?.read && entry.dateMs >= baselineMs));
  return { unread, replyNeeded: !!mark?.replyNeeded && !archived, archived };
}

const isoOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** 표시 하나의 모양 검사 — 알려진 필드만 남긴다. 쓸 것이 없으면 null */
function toMark(raw: unknown): MailMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const m: MailMark = {};
  for (const k of ['read', 'unread', 'replyNeeded', 'archived'] as const) if (isoOk(r[k])) m[k] = r[k] as string;
  const v = r.voc as Record<string, unknown> | undefined;
  if (v && typeof v === 'object' && typeof v.number === 'string' && v.number.length <= 40 && typeof v.ticketId === 'number' && isoOk(v.at)) {
    m.voc = { number: v.number, ticketId: v.ticketId, at: v.at };
  }
  const t = r.task as Record<string, unknown> | undefined;
  if (t && typeof t === 'object' && typeof t.file === 'string' && t.file.length <= 1024 && isoOk(t.at)) m.task = { file: t.file, at: t.at };
  const w = r.wiki as Record<string, unknown> | undefined;
  if (w && typeof w === 'object' && isoOk(w.at) && (w.state === 'done' || w.state === 'skipped') && typeof w.runId === 'string' && w.runId.length <= 80) {
    m.wiki = { at: w.at, state: w.state, runId: w.runId };
  }
  if (typeof r.path === 'string' && r.path.length <= 1024) m.path = r.path;
  return Object.keys(m).length > 0 ? m : null;
}

/** 파일 내용 → 상태. 형식이 틀리면 null */
export function parseMailStateFile(value: unknown): MailStateFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !isoOk(v.baselineAt)) return null;
  if (!v.mails || typeof v.mails !== 'object' || Array.isArray(v.mails)) return null;
  const mails: Record<MailKey, MailMark> = {};
  for (const [key, raw] of Object.entries(v.mails as Record<string, unknown>)) {
    if (!MAIL_KEY_RE.test(key)) continue;
    const m = toMark(raw);
    if (m) mails[key] = m;
  }
  return { version: 1, baselineAt: v.baselineAt as string, mails };
}

/** 표시가 하나도 의미 없으면(빈 객체·path 만) 지운다 */
function isEmptyMark(m: MailMark): boolean {
  return !m.read && !m.unread && !m.replyNeeded && !m.archived && !m.voc && !m.task && !m.wiki;
}

/** read 만 있는 항목인가(버려도 판정이 거의 같다 — 기준선 이전 메일은 어차피 읽음). 위키 반영 표시가 있으면 남긴다 */
function readOnly(m: MailMark): boolean {
  return !!m.read && !m.unread && !m.replyNeeded && !m.archived && !m.voc && !m.task && !m.wiki;
}

/** 한도(§3-1): 항목 수·파일 크기를 넘으면 read 만 있는 오래된 항목부터 버린다 */
export function pruneMailState(state: MailStateFile, maxEntries = MAIL_STATE_MAX_ENTRIES, maxBytes = MAIL_STATE_MAX_BYTES): number {
  const keys = Object.keys(state.mails);
  const sizeOf = (): number => Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8');
  // 작은 상태는 크기를 재지 않는다(2,000개 × 수백 바이트 ≪ 4MB)
  const small = maxBytes >= MAIL_STATE_MAX_BYTES && keys.length < 2_000;
  if (keys.length <= maxEntries && (small || sizeOf() <= maxBytes)) return 0;
  const candidates = keys
    .filter((k) => readOnly(state.mails[k]))
    .sort((a, b) => Date.parse(state.mails[a].read as string) - Date.parse(state.mails[b].read as string));
  let dropped = 0;
  let count = keys.length;
  for (const k of candidates) {
    if (count <= maxEntries) break;
    delete state.mails[k];
    count--;
    dropped++;
  }
  // 크기는 한 번에 10% 씩 덜어 보며 맞춘다
  let rest = candidates.filter((k) => state.mails[k] !== undefined);
  while (rest.length > 0 && sizeOf() > maxBytes) {
    const n = Math.max(1, Math.floor(rest.length / 10));
    for (const k of rest.slice(0, n)) delete state.mails[k];
    dropped += n;
    rest = rest.slice(n);
  }
  return dropped;
}

/** 깨진 파일을 옮길 이름: mail-state.broken-<시각>.json(있으면 -2, -3 …) */
function brokenPathFor(file: string): string {
  const dir = path.dirname(file);
  const stem = path.basename(file, '.json');
  const base = path.join(dir, `${stem}.broken-${compactStamp()}`);
  if (!fs.existsSync(`${base}.json`)) return `${base}.json`;
  for (let i = 2; ; i++) {
    const p = `${base}-${i}.json`;
    if (!fs.existsSync(p)) return p;
  }
}

/** mail-state.json 저장소 */
export class MailStateStore {
  private readonly file: string;
  private readonly warn: (message: string) => void;
  private readonly now: () => Date;
  private state: MailStateFile | null = null;
  /** 마지막 읽기 실패(잠김 등) — 있으면 쓰지 않는다 */
  private readError: string | null = null;

  constructor(dataDir: string, opts: { warn?: (m: string) => void; now?: () => Date } = {}) {
    this.file = path.join(dataDir, MAIL_STATE_FILE);
    this.warn = opts.warn ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get filePath(): string {
    return this.file;
  }

  /** 읽지 못한 이유(있으면) */
  get problem(): string | null {
    return this.readError;
  }

  /**
   * 지금 상태. 처음이면 파일을 읽는다 — 없으면 기준선(지금 − 72시간)으로 새로 만들고(아직 쓰지 않는다), 깨졌으면 옮기고 새로.
   * 잠김 등으로 읽지 못하면 메모리의 빈 상태(기준선 지금 − 72시간)를 돌려주고 쓰기는 거부한다(다음 부를 때 다시 읽는다).
   */
  load(): MailStateFile {
    if (this.state) return this.state;
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') {
        this.readError = null;
        this.state = this.fresh();
        return this.state;
      }
      this.readError = `메일 상태(${MAIL_STATE_FILE})를 읽지 못했습니다 (${code}) — 덮어쓰지 않도록 바꾸기를 멈춥니다`;
      this.warn(this.readError);
      return this.fresh();
    }
    this.readError = null;
    let parsed: MailStateFile | null = null;
    let reason = '';
    try {
      parsed = parseMailStateFile(JSON.parse(text));
      if (!parsed) reason = '형식이 맞지 않음';
    } catch (err) {
      reason = text.trim() === '' ? '빈 파일' : `JSON 이 아님: ${errCode(err)}`;
    }
    if (!parsed) {
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
          // 옮기지 못하면 경고만
        }
      }
      this.warn(
        `메일 상태(${MAIL_STATE_FILE})가 깨져 있어 새로 시작합니다. ` +
          (moved ? `원래 파일은 ${path.basename(target)} 로 옮겼습니다` : '원래 파일을 옮기지 못했습니다') +
          ` (원인: ${reason})`,
      );
      parsed = this.fresh();
      this.state = parsed;
      try {
        this.persist();
      } catch (err) {
        this.warn(err instanceof Error ? err.message : String(err));
      }
      return parsed;
    }
    this.state = parsed;
    return parsed;
  }

  private fresh(): MailStateFile {
    return { version: 1, baselineAt: new Date(this.now().getTime() - MAIL_BASELINE_BACK_MS).toISOString(), mails: {} };
  }

  baselineMs(): number {
    const t = Date.parse(this.load().baselineAt);
    return Number.isNaN(t) ? 0 : t;
  }

  mark(key: MailKey): MailMark | undefined {
    return this.load().mails[key];
  }

  /** 파일이 아직 없으면 지금 기준선으로 만든다(처음 색인을 끝냈을 때 부른다) */
  ensureSaved(): void {
    if (this.readError) return;
    this.load();
    if (fs.existsSync(this.file)) return;
    try {
      this.persist();
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 상태 바꾸기(§3-3). 한 번에 하나. archived:true 는 replyNeeded 도 지우고, replyNeeded:true 는 archived 를 지운다.
   * read:true 는 「미확인으로」를 지우고 읽은 시각을 적는다. read:false 는 「미확인으로」를 적는다. 바뀐 키 수를 돌려준다.
   * 쓰지 못하면 던진다(메모리도 되돌린다).
   */
  apply(keys: readonly MailKey[], change: MailStateChange, paths?: ReadonlyMap<MailKey, string>): number {
    this.requireWritable();
    const state = this.load();
    const before = JSON.stringify(state.mails);
    const at = this.now().toISOString();
    let changed = 0;
    for (const key of keys) {
      const cur: MailMark = { ...(state.mails[key] ?? {}) };
      const was = JSON.stringify(cur);
      if ('read' in change) {
        if (change.read) {
          delete cur.unread;
          cur.read ??= at;
        } else {
          cur.unread = at;
        }
      } else if ('replyNeeded' in change) {
        if (change.replyNeeded) {
          cur.replyNeeded = at;
          delete cur.archived;
        } else {
          delete cur.replyNeeded;
        }
      } else if ('archived' in change) {
        if (change.archived) {
          cur.archived = at;
          delete cur.replyNeeded;
        } else {
          delete cur.archived;
        }
      }
      const p = paths?.get(key);
      if (p) cur.path = p;
      if (JSON.stringify(cur) === was) continue;
      changed++;
      if (isEmptyMark(cur)) delete state.mails[key];
      else state.mails[key] = cur;
    }
    if (changed === 0) return 0;
    this.commit(before);
    return changed;
  }

  /** 메일함 VOC 등록 기록(§7-2) */
  setVoc(key: MailKey, voc: { number: string; ticketId: number }, p?: string): void {
    this.update(key, (m) => {
      m.voc = { number: voc.number, ticketId: voc.ticketId, at: this.now().toISOString() };
      if (p) m.path = p;
    });
  }

  /** [할 일로] 기록(§7-3) */
  setTask(key: MailKey, file: string, p?: string): void {
    this.update(key, (m) => {
      m.task = { file, at: this.now().toISOString() };
      if (p) m.path = p;
    });
  }

  /** 위키 반영 기록(2.14단계 §4-3·§7-1) — 다시 반영하면 덮어쓴다. 한 번에 여러 키를 한 번 쓰기로 */
  setWiki(keys: readonly MailKey[], wiki: { state: 'done' | 'skipped'; runId: string }, paths?: ReadonlyMap<MailKey, string>): void {
    if (keys.length === 0) return;
    this.requireWritable();
    const state = this.load();
    const before = JSON.stringify(state.mails);
    const at = this.now().toISOString();
    for (const key of new Set(keys)) {
      const cur: MailMark = { ...(state.mails[key] ?? {}) };
      cur.wiki = { at, state: wiki.state, runId: wiki.runId };
      const p = paths?.get(key);
      if (p) cur.path = p;
      state.mails[key] = cur;
    }
    this.commit(before);
  }

  private update(key: MailKey, fn: (m: MailMark) => void): void {
    this.requireWritable();
    const state = this.load();
    const before = JSON.stringify(state.mails);
    const cur: MailMark = { ...(state.mails[key] ?? {}) };
    fn(cur);
    state.mails[key] = cur;
    this.commit(before);
  }

  private requireWritable(): void {
    // 읽기 실패였으면 다시 읽어 본다(잠김이 풀렸을 수 있다)
    if (this.readError) {
      this.state = null;
      this.load();
    }
    if (this.readError) throw new Error(this.readError);
  }

  /** 저장. 실패하면 메모리를 before 로 되돌리고 던진다 */
  private commit(beforeMails: string): void {
    const state = this.load();
    const dropped = pruneMailState(state);
    if (dropped > 0) this.warn(`메일 상태 항목이 한도를 넘어 오래된 읽음 표시 ${dropped}개를 버렸습니다`);
    try {
      this.persist();
    } catch (err) {
      state.mails = JSON.parse(beforeMails) as Record<MailKey, MailMark>;
      throw err;
    }
  }

  private persist(): void {
    if (!this.state) return;
    writeJsonAtomic(this.file, this.state);
  }
}
