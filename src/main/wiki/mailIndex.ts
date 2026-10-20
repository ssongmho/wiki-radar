// raw/mail 증분 색인 · 스레드 묶기(docs/stage2.10-contract.md §1·§2). electron 을 import 하지 않는 순수 모듈이다.
//
// - raw/ 는 읽기만 한다. 파일마다 머리(앞 16KB, 모자라면 64KB)의 frontmatter 만 읽고 본문은 들고 있지 않는다.
// - 캐시의 (경로, 크기, mtime) 가 같으면 다시 읽지 않는다 — 걷기(readdir) + stat 만.
// - 메일 본문은 데이터다. 여기서는 머리 필드를 글자로만 옮긴다.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MailIndexEntry, MailKey } from '../../shared/types';
import { addressOf, displayNameOf, splitAddressList } from '../../shared/reply';
import { THREAD_GAP_DAYS, isGroupableThreadKey, normThread } from '../../shared/mailThread';
import { splitFrontmatter } from './frontmatter';
import { compareCodeUnits, errCode, isInsideDir, splitLines, stripBom } from './fsutil';
import { cleanMessageId, mailListField, mailTextField } from './mail';

/** 머리를 먼저 이만큼 읽는다 */
export const MAIL_HEAD_BYTES = 16 * 1024;
/** 그래도 닫는 `---` 가 없으면 이만큼까지 */
export const MAIL_HEAD_MAX_BYTES = 64 * 1024;
/** 머리 읽기 동시 개수 */
export const MAIL_INDEX_CONCURRENCY = 16;

export const MAIL_ROOT_REL = 'raw/mail';
export const ATTACHMENTS_FOLDER = '_attachments';
/** 특수 메일함(§1) */
export const QUARANTINE_FOLDER = '_격리';
export const NOISE_FOLDER = '_노이즈-추정';
/** 내가 보낸 메일의 메일함(2026-10-20 소유자 결정 — 옛 이름 '내 메모') */
export const SENT_FOLDER = '보낸 편지함';
/** 옛 이름 — 파이썬 수집기 분류 규칙(`from= 내 주소 → 내 메모`)이 쓰던 것. 색인·읽기에서 SENT_FOLDER 로 보인다 */
export const LEGACY_SENT_FOLDERS: readonly string[] = ['내 메모'];
/** 보낸 편지함(코드 곳곳에서 쓰던 이름 — SENT_FOLDER 와 같다) */
export const MEMO_FOLDER = SENT_FOLDER;

/** 메일함 이름 정규화: 옛 '내 메모' → '보낸 편지함'(파일은 그대로 — 화면·색인에서만) */
export function normMailFolder(folder: string): string {
  return LEGACY_SENT_FOLDERS.includes(folder) ? SENT_FOLDER : folder;
}

const YEAR_RE = /^\d{4}$/;
const DAY_MS = 86_400_000;

// ---- 파일 시스템(시험에서 바꿔 끼운다) --------------------------------------------------------

export interface MailDirEntry {
  name: string;
  isDir: boolean;
  isFile: boolean;
}

export interface MailFs {
  /** 폴더 안 항목. 링크·정션은 넣지 않는다(따라가지 않는다) */
  readdir(abs: string): Promise<MailDirEntry[]>;
  stat(abs: string): Promise<{ size: number; mtimeMs: number; isFile: boolean }>;
  /** 앞 bytes 바이트(파일이 짧으면 그만큼) */
  readHead(abs: string, bytes: number): Promise<Buffer>;
  realpath(abs: string): Promise<string>;
}

/** node:fs 로 만든 기본 구현 */
export const nodeMailFs: MailFs = {
  async readdir(abs) {
    const ents = await fs.promises.readdir(abs, { withFileTypes: true });
    const out: MailDirEntry[] = [];
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (!isDir && !isFile) {
        // 재분석 지점(OneDrive 자리표시자 등)은 lstat 으로 다시 본다(walkMarkdown 과 같다)
        try {
          const st = await fs.promises.lstat(path.join(abs, ent.name));
          if (st.isSymbolicLink()) continue;
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      out.push({ name: ent.name, isDir, isFile });
    }
    return out;
  },
  async stat(abs) {
    const st = await fs.promises.stat(abs);
    return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() };
  },
  async readHead(abs, bytes) {
    const fh = await fs.promises.open(abs, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      let off = 0;
      while (off < bytes) {
        const { bytesRead } = await fh.read(buf, off, bytes - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return buf.subarray(0, off);
    } finally {
      await fh.close();
    }
  },
  realpath: (abs) => fs.promises.realpath(abs),
};

// ---- 키 -----------------------------------------------------------------------------------

function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Message-ID 를 비교용으로(꺾쇠·공백 걷고 소문자). 쓸 수 없으면 undefined */
export function normMessageId(v: unknown): string | undefined {
  return cleanMessageId(v)?.toLowerCase();
}

/** 상태 키(§2-1): Message-ID → uidl → 경로 */
export function mailKeyOf(messageId: string | undefined, uidl: string | undefined, rel: string): MailKey {
  const mid = messageId ? messageId.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase() : '';
  if (mid) return `m:${sha1Hex(mid).slice(0, 16)}`;
  const u = uidl?.trim() ?? '';
  if (u) return `u:${sha1Hex(u).slice(0, 16)}`;
  return `p:${sha1Hex(rel).slice(0, 16)}`;
}

/** 스레드 id(§2-3) */
export function threadIdOf(threadKey: string, firstKey: MailKey): string {
  return `th:${sha1Hex(`${threadKey}|${firstKey}`).slice(0, 12)}`;
}

// ---- 대상 경로 -------------------------------------------------------------------------------

/**
 * 색인 대상 경로인가: `raw/mail/<메일함>/<YYYY>/<이름>.md` 꼴만(메일함이 _attachments 가 아니고, 이름이 `.`·`~` 로 시작하지 않음).
 */
export function isMailFileRel(rel: string): boolean {
  const segs = rel.split('/');
  if (segs.length !== 5 || segs[0] !== 'raw' || segs[1] !== 'mail') return false;
  const [, , folder, year, name] = segs;
  if (folder === '' || folder.toLowerCase() === ATTACHMENTS_FOLDER || folder.startsWith('.')) return false;
  if (!YEAR_RE.test(year)) return false;
  return isMailFileName(name);
}

function isMailFileName(name: string): boolean {
  if (name.startsWith('.') || name.startsWith('~')) return false;
  return name.toLowerCase().endsWith('.md') && name.length > 3;
}

// ---- 머리 파서 ------------------------------------------------------------------------------

const FILE_NAME_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_(.*)_([0-9A-Za-z]{6})\.md$/i;

/** 파일 이름 `<YYYY-MM-DD>_<HHMM>_<보낸이>_<제목>_<6자>.md` 에서 날짜·보낸이·제목(KST) */
export function parseMailFileName(name: string): { date?: string; from?: string; subject?: string } {
  const m = FILE_NAME_RE.exec(name);
  if (!m) return {};
  const rest = m[4];
  const cut = rest.indexOf('_');
  const out: { date?: string; from?: string; subject?: string } = { date: `${m[1]}T${m[2]}:${m[3]}:00+09:00` };
  if (cut > 0) {
    out.from = rest.slice(0, cut);
    out.subject = rest.slice(cut + 1);
  } else if (rest) {
    out.subject = rest;
  }
  return out;
}

/** 닫는 frontmatter 줄이 있는가(첫 줄 `---` 다음) */
function hasClosedFrontmatter(lines: readonly string[]): boolean {
  if (lines.length === 0 || lines[0].trimEnd() !== '---') return true; // frontmatter 가 아예 없음 — 더 읽어도 같다
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (t === '---' || t === '...') return true;
  }
  return false;
}

/**
 * 머리 글(파일 앞부분) → 색인 항목(size·mtimeMs·mine 은 부르는 쪽이 채운다).
 * complete 는 글이 파일 끝까지인가(아니면 마지막 줄은 잘렸을 수 있어 버린다).
 */
export function parseMailHead(rel: string, headText: string, complete = true): Omit<MailIndexEntry, 'size' | 'mtimeMs'> {
  let lines = splitLines(stripBom(headText ?? ''));
  if (!complete && lines.length > 1) lines = lines.slice(0, -1);
  const segs = rel.split('/');
  const fileName = segs[segs.length - 1] ?? '';
  const pathFolder = segs[2] ?? '';
  const fromName = parseMailFileName(fileName);

  let problem: string | undefined;
  let data: Record<string, unknown> = {};
  let bodyLines: string[] = lines;
  if (lines.length === 0 || lines[0].trimEnd() !== '---') {
    problem = 'frontmatter 가 없음';
  } else if (!hasClosedFrontmatter(lines)) {
    problem = 'frontmatter 를 읽지 못함';
    // 닫히지 않은 머리 안의 `# …` 는 YAML 주석이다 — 제목으로 쓰지 않고 파일 이름에서 뽑는다
    bodyLines = [];
  } else {
    const fm = splitFrontmatter(lines);
    bodyLines = fm.bodyLines;
    if (fm.data) data = fm.data;
    else problem = 'frontmatter 형식이 틀림';
  }

  let subject = mailTextField(data.subject);
  if (subject === undefined) {
    const h1 = bodyLines.find((l) => /^#\s+\S/.test(l));
    subject = h1 ? h1.replace(/^#\s+/, '').trim() : problem ? fromName.subject : undefined;
  }
  if (!subject) subject = '(제목 없음)';
  const from = mailTextField(data.from) ?? (problem ? fromName.from ?? '' : '');
  const fromAddr = addressOf(from) ?? undefined;
  const name = displayNameOf(from) || (fromAddr ? fromAddr : from.trim());

  let date = mailTextField(data.date);
  if (date === undefined && fromName.date) date = fromName.date;
  const parsedMs = date ? Date.parse(date) : NaN;

  const folder = normMailFolder(mailTextField(data.folder) ?? pathFolder);
  const suspicion = mailListField(data.suspicion, (s) => (s.trim() ? [s.trim()] : []));
  const messageId = cleanMessageId(data.message_id);
  const uidl = mailTextField(data.uidl);
  const attachmentsRaw = Number(mailTextField(data.attachments) ?? '0');

  const entry: Omit<MailIndexEntry, 'size' | 'mtimeMs'> = {
    key: mailKeyOf(messageId, uidl, rel),
    path: rel,
    dateMs: Number.isFinite(parsedMs) ? parsedMs : 0,
    subject,
    from,
    fromName: name,
    to: mailListField(data.to, splitAddressList),
    ccCount: mailListField(data.cc, splitAddressList).length,
    folder,
    attachments: Number.isSafeInteger(attachmentsRaw) && attachmentsRaw > 0 ? attachmentsRaw : 0,
    suspicious: suspicion.length > 0 || folder === QUARANTINE_FOLDER,
    muted: folder === NOISE_FOLDER,
    mine: folder === MEMO_FOLDER,
    threadKey: normThread(subject),
  };
  if (date) entry.date = date;
  if (fromAddr) entry.fromAddr = fromAddr;
  if (messageId) entry.messageId = messageId;
  if (uidl) entry.uidl = uidl;
  const inReplyTo = normMessageId(data.in_reply_to);
  if (inReplyTo) entry.inReplyTo = inReplyTo;
  const references = mailListField(data.references, (s) => s.split(/[\s,]+/))
    .map((x) => normMessageId(x))
    .filter((x): x is string => !!x);
  if (references.length > 0) entry.references = [...new Set(references)].slice(0, 50);
  const ingested = mailTextField(data.ingested);
  if (ingested) entry.ingested = ingested;
  if (problem) entry.problem = problem;
  return entry;
}

/** 내가 보낸 사본인가: 메일함이 보낸 편지함(옛 '내 메모') 또는 보낸이 주소가 보내는 계정 주소 */
export function isMine(entry: Pick<MailIndexEntry, 'folder' | 'fromAddr'>, myAddress?: string): boolean {
  if (normMailFolder(entry.folder) === SENT_FOLDER) return true;
  if (!myAddress || !entry.fromAddr) return false;
  return entry.fromAddr.toLowerCase() === myAddress.trim().toLowerCase();
}

// ---- 같은 메일 두 파일 ---------------------------------------------------------------------------

/** 같은 키 중 하나: 노이즈·격리가 아닌 쪽 → ingested 늦은 쪽 → 경로 사전순 앞 */
function better(a: MailIndexEntry, b: MailIndexEntry): MailIndexEntry {
  const special = (e: MailIndexEntry): boolean => e.folder === NOISE_FOLDER || e.folder === QUARANTINE_FOLDER;
  if (special(a) !== special(b)) return special(a) ? b : a;
  const ia = a.ingested ?? '';
  const ib = b.ingested ?? '';
  if (ia !== ib) return ia > ib ? a : b;
  return compareCodeUnits(a.path, b.path) <= 0 ? a : b;
}

/** 파일별 항목 → 키별 하나(날짜순). 버린 수도 돌려준다 */
export function dedupeEntries(files: readonly MailIndexEntry[]): { entries: MailIndexEntry[]; duplicates: number; duplicateKeys: MailKey[] } {
  const byKey = new Map<MailKey, MailIndexEntry>();
  let duplicates = 0;
  const duplicateKeys: MailKey[] = [];
  for (const e of files) {
    const prev = byKey.get(e.key);
    if (!prev) {
      byKey.set(e.key, e);
      continue;
    }
    duplicates++;
    if (!duplicateKeys.includes(e.key)) duplicateKeys.push(e.key);
    byKey.set(e.key, better(prev, e));
  }
  const entries = [...byKey.values()].sort(compareEntries);
  return { entries, duplicates, duplicateKeys };
}

function compareEntries(a: MailIndexEntry, b: MailIndexEntry): number {
  return a.dateMs - b.dateMs || compareCodeUnits(a.path, b.path);
}

// ---- 스레드 ---------------------------------------------------------------------------------

export interface MailThread {
  id: string;
  /** 첫 메일의 threadKey */
  key: string;
  /** 날짜순 */
  mailKeys: MailKey[];
  latestMs: number;
  /** 가장 최근 메일 제목 */
  subject: string;
  /** 보낸이 이름(나 제외, 최근 순 앞 3명) */
  participants: string[];
  includesMe: boolean;
  folders: string[];
  count: number;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[i] !== r) {
      const next = this.parent[i];
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * 스레드 묶기(§2-3): ① In-Reply-To·References 가 가리키는 Message-ID 끼리 한 묶음 ② 같은 threadKey 끼리 날짜순으로 이어 붙이되
 * 앞 메일과 60일 넘게 떨어지면 끊는다 ③ 짧은 키·흔한 제목은 키로 묶지 않는다. 내 사본(mine)도 같은 스레드에 넣는다.
 * entries 는 dedupeEntries 결과(날짜순). 결과는 최근 메일 날짜 내림차순.
 */
export function buildThreads(entries: readonly MailIndexEntry[]): MailThread[] {
  const list = [...entries].sort(compareEntries);
  const uf = new UnionFind(list.length);

  const byMessageId = new Map<string, number>();
  list.forEach((e, i) => {
    const mid = e.messageId?.toLowerCase();
    if (mid && !byMessageId.has(mid)) byMessageId.set(mid, i);
  });
  list.forEach((e, i) => {
    for (const ref of [e.inReplyTo, ...(e.references ?? [])]) {
      if (!ref) continue;
      const j = byMessageId.get(ref);
      if (j !== undefined) uf.union(i, j);
    }
  });

  const byKey = new Map<string, number[]>();
  list.forEach((e, i) => {
    if (!isGroupableThreadKey(e.threadKey)) return;
    const arr = byKey.get(e.threadKey);
    if (arr) arr.push(i);
    else byKey.set(e.threadKey, [i]);
  });
  const gapMs = THREAD_GAP_DAYS * DAY_MS;
  for (const idx of byKey.values()) {
    for (let k = 1; k < idx.length; k++) {
      const prev = list[idx[k - 1]];
      const cur = list[idx[k]];
      // 날짜를 모르는 메일(0)은 끊지 않는다
      if (prev.dateMs > 0 && cur.dateMs > 0 && cur.dateMs - prev.dateMs > gapMs) continue;
      uf.union(idx[k - 1], idx[k]);
    }
  }

  const groups = new Map<number, number[]>();
  list.forEach((_, i) => {
    const r = uf.find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });

  const threads: MailThread[] = [];
  for (const idx of groups.values()) {
    const mails = idx.map((i) => list[i]); // 날짜순(list 가 날짜순이라 그대로)
    const first = mails[0];
    const latest = mails[mails.length - 1];
    const participants: string[] = [];
    for (let k = mails.length - 1; k >= 0 && participants.length < 3; k--) {
      const m = mails[k];
      if (m.mine) continue;
      const name = m.fromName || m.from;
      if (name && !participants.includes(name)) participants.push(name);
    }
    const folders: string[] = [];
    for (const m of mails) if (!folders.includes(m.folder)) folders.push(m.folder);
    threads.push({
      id: threadIdOf(first.threadKey, first.key),
      key: first.threadKey,
      mailKeys: mails.map((m) => m.key),
      latestMs: latest.dateMs,
      subject: latest.subject,
      participants,
      includesMe: mails.some((m) => m.mine),
      folders,
      count: mails.length,
    });
  }
  threads.sort((a, b) => b.latestMs - a.latestMs || compareCodeUnits(a.id, b.id));
  return threads;
}

// ---- 증분 색인 -------------------------------------------------------------------------------

export interface MailIndexStats {
  /** 대상 파일 수 */
  files: number;
  /** 머리를 새로 읽은 수 */
  read: number;
  /** 캐시를 그대로 쓴 수 */
  reused: number;
  /** 캐시에 있었지만 없어진 경로 수 */
  removed: number;
  /** 같은 키의 둘째 파일 수 */
  duplicates: number;
  /** problem 이 있는 항목 수 */
  problems: number;
  ms: number;
}

export interface BuildMailIndexOptions {
  wikiRoot: string;
  /** 지난 색인의 파일별 항목(mail-index.json) */
  cache?: readonly MailIndexEntry[];
  fs?: MailFs;
  /** 보내는 계정 주소(내 사본 판정) */
  myAddress?: string;
  concurrency?: number;
  /** 읽어야 할 파일이 정해진 뒤·하나 읽을 때마다 */
  onProgress?: (done: number, total: number) => void;
  /** 경고(같은 메일 두 파일·읽지 못한 폴더 등) */
  warn?: (message: string) => void;
  /** 시간 재기(시험용) */
  clock?: () => number;
}

export interface MailIndexResult {
  /** 파일별 항목(캐시 재료 — 같은 메일 두 파일도 둘 다) */
  files: MailIndexEntry[];
  /** 키별 하나(날짜순) */
  entries: MailIndexEntry[];
  threads: MailThread[];
  stats: MailIndexStats;
}

/** raw/mail 폴더가 없을 때 */
export class MailDirMissingError extends Error {
  constructor(dir: string) {
    super(`raw/mail 폴더가 없습니다: ${dir}`);
    this.name = 'MailDirMissingError';
  }
}

/** 동시 n 개까지 돌린다 */
async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/**
 * 증분 색인(§2-2). 걷기 + stat 만 하고, 캐시의 (경로, 크기, mtime) 가 같으면 머리를 다시 읽지 않는다.
 * 실제 경로(링크·정션)가 raw/mail 밖인 파일은 버린다. raw/mail 이 없으면 MailDirMissingError.
 */
export async function buildMailIndex(opts: BuildMailIndexOptions): Promise<MailIndexResult> {
  const clock = opts.clock ?? (() => Date.now());
  const started = clock();
  const mfs = opts.fs ?? nodeMailFs;
  const warn = opts.warn ?? (() => {});
  const concurrency = opts.concurrency ?? MAIL_INDEX_CONCURRENCY;
  const root = path.resolve(opts.wikiRoot);
  const mailRoot = path.join(root, 'raw', 'mail');

  let folders: MailDirEntry[];
  try {
    folders = await mfs.readdir(mailRoot);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new MailDirMissingError(mailRoot);
    throw new Error(`raw/mail 폴더를 읽지 못했습니다 (${code})`);
  }
  let realMailRoot: string;
  try {
    realMailRoot = await mfs.realpath(mailRoot);
  } catch (err) {
    throw new Error(`raw/mail 폴더를 확인하지 못했습니다 (${errCode(err)})`);
  }

  // 1) 걷기: raw/mail/<메일함>/<YYYY>/<이름>.md
  const rels: string[] = [];
  const yearDirs: { folder: string; year: string }[] = [];
  await runLimited(
    folders.filter((f) => f.isDir && f.name.toLowerCase() !== ATTACHMENTS_FOLDER && !f.name.startsWith('.')),
    concurrency,
    async (f) => {
      try {
        for (const y of await mfs.readdir(path.join(mailRoot, f.name))) {
          if (y.isDir && YEAR_RE.test(y.name)) yearDirs.push({ folder: f.name, year: y.name });
        }
      } catch (err) {
        warn(`메일함 폴더를 읽지 못함: ${f.name} (${errCode(err)})`);
      }
    },
  );
  await runLimited(yearDirs, concurrency, async ({ folder, year }) => {
    try {
      for (const ent of await mfs.readdir(path.join(mailRoot, folder, year))) {
        if (ent.isFile && isMailFileName(ent.name)) rels.push(`raw/mail/${folder}/${year}/${ent.name}`);
      }
    } catch (err) {
      warn(`메일함 폴더를 읽지 못함: ${folder}/${year} (${errCode(err)})`);
    }
  });
  rels.sort(compareCodeUnits);

  // 2) stat → 캐시 판정
  const cacheByPath = new Map<string, MailIndexEntry>();
  for (const e of opts.cache ?? []) if (e && typeof e.path === 'string') cacheByPath.set(e.path, e);
  const kept: MailIndexEntry[] = [];
  const toRead: { rel: string; size: number; mtimeMs: number }[] = [];
  await runLimited(rels, concurrency * 4, async (rel) => {
    const abs = path.join(root, ...rel.split('/'));
    let st: { size: number; mtimeMs: number; isFile: boolean };
    try {
      st = await mfs.stat(abs);
    } catch {
      return; // 그사이 지워짐
    }
    if (!st.isFile) return;
    const hit = cacheByPath.get(rel);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) kept.push(hit);
    else toRead.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
  });
  const seen = new Set(rels);
  let removed = 0;
  for (const p of cacheByPath.keys()) if (!seen.has(p)) removed++;

  // 3) 새 파일·바뀐 파일만 머리를 읽는다
  let done = 0;
  opts.onProgress?.(0, toRead.length);
  const fresh: MailIndexEntry[] = [];
  await runLimited(toRead, concurrency, async ({ rel, size, mtimeMs }) => {
    const abs = path.join(root, ...rel.split('/'));
    try {
      const real = await mfs.realpath(abs);
      if (!isInsideDir(realMailRoot, real)) {
        warn(`raw/mail 밖을 가리키는 메일 파일을 뺌: ${rel}`);
        return;
      }
      let buf = await mfs.readHead(abs, MAIL_HEAD_BYTES);
      let complete = buf.length < MAIL_HEAD_BYTES;
      const decode = (b: Buffer): string => new TextDecoder('utf-8').decode(b);
      if (!complete && !hasClosedFrontmatter(splitLines(stripBom(decode(buf))))) {
        buf = await mfs.readHead(abs, MAIL_HEAD_MAX_BYTES);
        complete = buf.length < MAIL_HEAD_MAX_BYTES;
      }
      const head = parseMailHead(rel, decode(buf), complete);
      fresh.push({ ...head, size, mtimeMs });
    } catch (err) {
      warn(`메일 머리를 읽지 못함: ${rel} (${errCode(err)})`);
    } finally {
      done++;
      opts.onProgress?.(done, toRead.length);
    }
  });

  const files = [...kept, ...fresh]
    .map((e) => ({ ...e, mine: isMine(e, opts.myAddress) }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  const { entries, duplicates, duplicateKeys } = dedupeEntries(files);
  if (duplicates > 0) warn(`같은 메일이 두 파일 이상: ${duplicates}개(키 ${duplicateKeys.slice(0, 3).join(', ')}${duplicateKeys.length > 3 ? ' …' : ''})`);
  const threads = buildThreads(entries);
  return {
    files,
    entries,
    threads,
    stats: {
      files: files.length,
      read: fresh.length,
      reused: kept.length,
      removed,
      duplicates,
      problems: entries.filter((e) => e.problem).length,
      ms: clock() - started,
    },
  };
}

// ---- 캐시 파일 -------------------------------------------------------------------------------

export const MAIL_INDEX_FILE = 'mail-index.json';
export const MAIL_INDEX_VERSION = 1;

export interface MailIndexCacheFile {
  version: 1;
  wikiRoot: string;
  builtAt: string;
  entries: MailIndexEntry[];
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 캐시 항목 하나의 모양 검사(틀리면 null — 그 파일은 다시 읽는다) */
function toCacheEntry(raw: unknown): MailIndexEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.path !== 'string' || !isMailFileRel(r.path)) return null;
  for (const k of ['size', 'mtimeMs', 'dateMs', 'ccCount', 'attachments'] as const) if (typeof r[k] !== 'number') return null;
  for (const k of ['subject', 'from', 'fromName', 'folder', 'threadKey'] as const) if (typeof r[k] !== 'string') return null;
  for (const k of ['suspicious', 'muted', 'mine'] as const) if (typeof r[k] !== 'boolean') return null;
  if (!isStrArray(r.to)) return null;
  for (const k of ['date', 'fromAddr', 'messageId', 'uidl', 'inReplyTo', 'problem', 'ingested'] as const) {
    if (r[k] !== undefined && typeof r[k] !== 'string') return null;
  }
  if (r.references !== undefined && !isStrArray(r.references)) return null;
  return raw as MailIndexEntry;
}

/** 캐시 파일 읽기. 없거나 깨졌거나 버전·위키가 다르면 빈 목록(다시 만들 수 있는 캐시라 옮기지 않는다) */
export function loadMailIndexCache(file: string, wikiRoot: string): MailIndexEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(stripBom(text)) as Partial<MailIndexCacheFile>;
    if (!data || data.version !== MAIL_INDEX_VERSION || data.wikiRoot !== path.resolve(wikiRoot) || !Array.isArray(data.entries)) return [];
    return data.entries.map(toCacheEntry).filter((e): e is MailIndexEntry => e !== null);
  } catch {
    return [];
  }
}

export function mailIndexCacheOf(wikiRoot: string, files: readonly MailIndexEntry[], builtAt: Date): MailIndexCacheFile {
  return { version: 1, wikiRoot: path.resolve(wikiRoot), builtAt: builtAt.toISOString(), entries: [...files] };
}
