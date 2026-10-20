// 처리 결과 → 위키(할 일 줄·로그 절·메모 파일). sync_todo.py 한 항목분과 같은 결과를 낸다.
// electron 을 import 하지 않는 순수 모듈이다. 계약: docs/stage2-contract.md §1
//
// 정본은 WIKI/_todo-sync/sync_todo.py 다(apply_status·set_field·sync·section·log·unlog·write_memo).
// 파이썬과 같게 옮긴 곳에는 원래 줄을 주석으로 붙였다. 파이썬과 글자 단위로 같아야 하는 부분:
//   - 공백: 파이썬 `\s`·strip() 은 str.isspace() 글자(JS `\s` 와 \x1c-\x1f·\x85·﻿ 가 다르다) → pystr.ts
//   - 자르기·길이: 파이썬 str 은 코드 포인트 단위(🔴 가 한 글자) → codePointSlice
//   - `head not in lines`·`lines.index(head)` 는 줄 전체가 같은지 본다(앞뒤 공백이 있으면 다른 줄)
// 레이더가 더 지키는 것(§1-3): 줄바꿈(CRLF/LF)·BOM 유지, 쓰기 허용 목록, 쓰기 직전 mtime·크기 재확인(최대 3번),
// 같은 폴더 임시 파일 → rename(원자적 쓰기, 잠금이면 짧게 재시도하되 기다리는 동안 파일이 바뀌면 처음부터 다시 읽는다).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SaveResultOutput, Task, TaskStatus } from '../../shared/types';
import { isValidYmd } from './calendar';
import { ANCHOR_LINE_RE, checkboxAnchorMatch, checkboxSyncTitle, codePointLength, codePointSlice, coreOf, rawFields } from './checkbox';
import { LOG_HEADINGS } from './curated';
import {
  EXCLUDED_DIRS,
  READ_RETRY_DELAYS_MS,
  TRANSIENT_READ_ERRORS,
  compareCodeUnits,
  errCode,
  isInsideDir,
  safeVaultRelative,
  sleepSync,
  splitLines,
} from './fsutil';
import { PY_WS, pyRstrip, pyStrip } from './pystr';
import { WIKI_PATHS } from './snapshot';

export interface WritebackInput {
  /** 마스터 볼트 절대경로 */
  wikiRoot: string;
  /** 오늘 YYYY-MM-DD — 필드·로그·메모에 쓰는 날짜 */
  today: string;
  /** 스냅샷의 항목(source·title·anchors·file·rawLine·src 를 쓴다) */
  task: Task;
  status: TaskStatus;
  /** notmine 일 때 담당 */
  owner?: string;
  /** 처리 내용(메모). 비어 있으면 메모를 쓰지 않는다 */
  note?: string;
  /** 백업 폴더 이름(YYYYMMDDTHHMMSS)에 쓸 시각. 시험에서 고정한다. 없으면 지금 */
  now?: Date;
}

/** 저장 결과(대기열 항목 queued 는 main 이 채운다) */
export type WritebackResult = Omit<SaveResultOutput, 'queued'>;

/** 시험용 끼워 넣기. 앱은 쓰지 않는다(applyWriteback 은 모두 기본값). */
export interface WritebackHooks {
  /**
   * 쓰기 직전 재확인(mtime·크기) 바로 앞에 부른다. 이때 파일을 바꾸면 경합이 난다.
   * attempt 는 1부터, files 는 이번 시도에서 읽은 파일(볼트 기준 상대경로).
   */
  beforeRecheck?: (info: { attempt: number; files: string[] }) => void;
  /**
   * 임시 파일 → 본 파일 이름 바꾸기(잠금 흉내용). 기본 fs.renameSync.
   * 부를 때마다 바로 앞에서 본 파일이 읽은 뒤 바뀌지 않았는지 다시 본다(바뀌었으면 부르지 않고 처음부터 다시 읽는다).
   */
  rename?: (from: string, to: string) => void;
  /** 재시도 대기. 기본 동기 대기 */
  sleep?: (ms: number) => void;
}

const TODO = WIKI_PATHS.myTasks;
const MEMO = WIKI_PATHS.memos;
const H_DONE = LOG_HEADINGS.done;
const H_DELG = LOG_HEADINGS.delegated;
const H_WIP = LOG_HEADINGS.wip;
/** 관리필드는 done·wip·owner 셋뿐이다. st/due/pri 등 기존 필드는 보존한다. */
const MANAGED = ['done', 'wip', 'owner'] as const;
const LOG_INTRO =
  '> 아티팩트에서 처리했으나 위키에 대응 체크박스가 없던 항목이다.' +
  ' 원본 문서(종합분석·트리아지·메일브리핑)의 산문은 건드리지 않았다.';
/** notmine 인데 담당을 비웠을 때 */
export const DEFAULT_OWNER = '타담당';

/** 백업 폴더(볼트 기준): <wiki>/_todo-sync/backup/<YYYYMMDDTHHMMSS>/<상대경로> */
export const BACKUP_ROOT = '_todo-sync/backup';
/** 쓰기 직전 재확인에서 파일이 바뀌었으면 다시 읽고 처음부터 — 모두 이만큼 */
export const MAX_WRITE_ATTEMPTS = 3;
/**
 * 쓰기 확인(쓰기로 열어 보기)·rename 이 잠금(EBUSY·EPERM 등)으로 막힐 때 재시도 대기(ms). 합쳐 0.75초.
 * rename 은 기다린 뒤마다 파일이 그대로인지 다시 보고, 바뀌었으면(잠근 쪽이 썼으면) 덮어쓰지 않고 처음부터 다시 읽는다.
 */
export const WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];
const WRITE_LOCK_ERRORS: ReadonlySet<string> = new Set([...TRANSIENT_READ_ERRORS, 'EACCES']);
/** 임시 파일 이름 끝(`.md` 가 아니라 감시·Obsidian 이 문서로 보지 않는다. 이름 앞의 `.` 로 숨긴다) */
export const TEMP_SUFFIX = '.wiki-radar-tmp';
/** 임시 파일 이름 앞(`.wr-<원래 이름 sha1 앞 8자>-<pid>-<시각>-<n>.wiki-radar-tmp` — 원래 이름이 길어도 짧다) */
export const TEMP_PREFIX = '.wr-';
/** 담당 이름에 쓰면 `[owner:: …]` 필드나 줄이 깨지는 글자 */
const BAD_OWNER_RE = /[[\]\r\n]/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---------------------------------------------------------------- 파이썬과 같은 공백·문자열 처리(pystr.ts)

/** `ln.strip() == ""` */
function isBlank(s: string): boolean {
  return pyStrip(s) === '';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * def set_field(ln, name, val):
 *     ln = re.sub(r"\s*\[%s::[^\]]*\]" % re.escape(name), "", ln).rstrip()
 *     return ln + " [%s:: %s]" % (name, val) if val else ln
 */
function setField(ln: string, name: string, val: string | null): string {
  const re = new RegExp(`${PY_WS}*\\[${escapeRegExp(name)}::[^\\]]*\\]`, 'g');
  const out = pyRstrip(ln.replace(re, ''));
  return val ? `${out} [${name}:: ${val}]` : out;
}

/** sync_todo.apply_status — 체크 표시와 관리필드(done·wip·owner)만 바꾼다. 다른 필드는 그대로 */
export function applyStatus(ln: string, status: TaskStatus, owner: string | undefined, today: string): string {
  // box = "- [x]" if status == "done" else "- [ ]"
  // ln = re.sub(r"^- \[[ xX]\]", box, ln, count=1)
  const box = status === 'done' ? '- [x]' : '- [ ]';
  let out = ln.replace(/^- \[[ xX]\]/, () => box);
  for (const f of MANAGED) out = setField(out, f, null); // 관리필드 초기화
  if (status === 'done') out = setField(out, 'done', today);
  else if (status === 'wip') out = setField(out, 'wip', today);
  else if (status === 'notmine') out = setField(out, 'owner', owner || DEFAULT_OWNER);
  return out;
}

// ---------------------------------------------------------------- 입력 → sync_todo 항목 (명세 §1-1)

/** sync_todo 의 항목 제목 t — curated 는 items.json 제목, checkbox 는 핵심문구(70자 넘으면 앞 70자 + '…') */
export function syncTitleOf(task: Task): string {
  if (task.source === 'checkbox' && typeof task.rawLine === 'string') {
    const t = checkboxSyncTitle(task.rawLine);
    if (t) return t;
  }
  return task.title;
}

interface SyncAnchor {
  /** items.json 에 적힌 그대로(메시지용) */
  f: string;
  m: string;
  /** 쓰기 허용 검사를 거친 볼트 기준 상대경로. null 이면 없는 파일(= 파일 없음) */
  rel: string | null;
  /** 체크박스 항목: 스냅샷이 가리킨 줄(0부터)과 그 원문 — 같은 문구의 줄이 여럿일 때 이 줄을 고른다 */
  preferLine?: { index: number; text: string };
}

/** state.json 의 items[] 한 개와 같은 뜻 */
interface SyncItem {
  t: string;
  s: TaskStatus;
  o?: string;
  /** strip 한 메모 */
  n: string;
  src: string;
  anchors: SyncAnchor[];
  source: Task['source'];
}

const STATUSES: ReadonlySet<string> = new Set(['open', 'wip', 'done', 'notmine']);

/** 쓰기 허용 목록 밖이면 던진다 */
export class WriteRefusedError extends Error {
  constructor(rel: string, reason: string) {
    super(`쓰기 허용 목록 밖이라 저장하지 않음: ${rel} (${reason})`);
    this.name = 'WriteRefusedError';
  }
}

/**
 * 파일을 하나 이상 쓴 뒤에 실패했다. written 은 이미 쓴 파일(볼트 기준, 이름순), backupDir 는 그 파일들의 저장 전 사본.
 * sync_todo 규칙은 여러 번 돌려도 같으므로 같은 저장을 다시 하면 나머지가 반영된다(같은 메모는 다시 쓰지 않는다).
 */
export class PartialWriteError extends Error {
  readonly written: readonly string[];
  readonly backupDir: string | undefined;

  constructor(cause: string, written: readonly string[], backupDir: string | undefined) {
    super(`${cause} — 먼저 쓴 파일: ${written.join(', ')} — 다시 저장하면 이어서 반영됨`);
    this.name = 'PartialWriteError';
    this.written = written;
    this.backupDir = backupDir;
  }
}

/** 이름 바꾸기 바로 앞에서 본 파일이 읽은 뒤 바뀐 것을 알았다 — 덮어쓰지 않고 처음부터 다시 읽는다 */
class ChangedBeforeRename extends Error {
  readonly rel: string;

  constructor(rel: string) {
    super(`저장하는 사이에 파일이 바뀜: ${rel}`);
    this.name = 'ChangedBeforeRename';
    this.rel = rel;
  }
}

function isExcludedSegment(seg: string): boolean {
  return EXCLUDED_DIRS.has(seg.toLowerCase());
}

function lstatOrNull(abs: string): fs.Stats | null {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 쓰기 허용 검사(명세 §1-3): 위키 안의 `.md` 이고, 경로 조각에 raw/·제외 폴더가 없고(대소문자 무시),
 * 링크·정션을 따라가도 위키 밖·제외 폴더로 나가지 않으며, 파일 자체가 링크가 아니어야 한다. 통과하면 절대경로.
 */
function checkWritable(root: string, realRoot: string, rel: string): string {
  const p = safeVaultRelative(rel);
  if (p === null) throw new WriteRefusedError(rel, '위키 밖이거나 잘못된 경로');
  if (!p.toLowerCase().endsWith('.md')) throw new WriteRefusedError(rel, '.md 파일이 아님');
  const segs = p.split('/');
  if (segs.slice(0, -1).some(isExcludedSegment)) throw new WriteRefusedError(rel, 'raw/·제외 폴더 안');
  const abs = path.join(root, ...segs);
  if (!isInsideDir(root, abs)) throw new WriteRefusedError(rel, '위키 밖');

  // 이미 있는 가장 가까운 상위 폴더의 실제 경로(링크·정션·짧은 이름을 푼 것)가 위키 안이고 제외 폴더가 아니어야 한다
  let dir = path.dirname(abs);
  while (lstatOrNull(dir) === null && isInsideDir(root, dir)) dir = path.dirname(dir);
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch (err) {
    throw new WriteRefusedError(rel, `폴더를 확인하지 못함 ${errCode(err)}`);
  }
  const relReal = path.relative(realRoot, realDir);
  if (relReal !== '' && !isInsideDir(realRoot, realDir)) throw new WriteRefusedError(rel, '링크를 따라가면 위키 밖');
  if (relReal !== '' && relReal.split(/[\\/]/).some(isExcludedSegment)) {
    throw new WriteRefusedError(rel, '링크를 따라가면 raw/·제외 폴더 안');
  }
  const st = lstatOrNull(abs);
  if (st && st.isSymbolicLink()) throw new WriteRefusedError(rel, '링크 파일');
  if (st && !st.isFile()) throw new WriteRefusedError(rel, '파일이 아님');
  // 있는 파일은 실제 표기(대소문자)의 경로로 쓴다 — 앵커가 대소문자를 달리 적었어도 이름 바꾸기로 파일 이름이 바뀌지 않게
  return st ? fs.realpathSync.native(abs) : abs;
}

/**
 * 앵커 파일 경로를 정한다. items.json 에 `.md` 가 빠져 있으면 스냅샷처럼 `.md` 를 붙여 본다.
 * `.md` 가 아닌 파일이 실제로 있으면 거부(던짐), 없으면 null(= sync_todo 의 '파일 없음').
 */
function resolveAnchorRel(root: string, realRoot: string, f: string): string | null {
  const p = safeVaultRelative(f);
  if (p === null) throw new WriteRefusedError(f, '위키 밖이거나 잘못된 경로');
  if (!p.toLowerCase().endsWith('.md')) {
    const withMd = `${p}.md`;
    if (lstatOrNull(path.join(root, ...withMd.split('/')))?.isFile()) {
      checkWritable(root, realRoot, withMd);
      return withMd;
    }
    if (lstatOrNull(path.join(root, ...p.split('/'))) !== null) throw new WriteRefusedError(f, '.md 파일이 아님');
    return null;
  }
  checkWritable(root, realRoot, p);
  return p;
}

function toSyncItem(input: WritebackInput, root: string, realRoot: string): SyncItem {
  const { task } = input;
  if (!task || typeof task !== 'object') throw new Error('저장할 항목이 없음');
  if (task.source !== 'curated' && task.source !== 'checkbox') throw new Error(`알 수 없는 항목 원천: ${String(task.source)}`);
  if (!STATUSES.has(input.status)) throw new Error(`알 수 없는 상태: ${String(input.status)}`);

  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  if (input.status === 'notmine' && BAD_OWNER_RE.test(owner)) {
    throw new Error('담당자 이름에는 대괄호([ ])나 줄바꿈을 쓸 수 없음');
  }
  // 입력 창의 줄바꿈(\r\n·\r)은 \n 으로 맞춘 뒤 sync_todo 처럼 strip 한다: note = (it.get("n") or "").strip()
  const note = pyStrip((typeof input.note === 'string' ? input.note : '').replace(/\r\n?/g, '\n'));

  let t: string;
  let src: string;
  const anchors: SyncAnchor[] = [];
  if (task.source === 'checkbox') {
    if (typeof task.file !== 'string' || typeof task.rawLine !== 'string') {
      throw new Error(`체크박스 항목에 파일·줄이 없음: ${task.title}`);
    }
    const m = checkboxAnchorMatch(task.rawLine);
    // 빈 문구는 파일의 첫 체크박스 줄에 걸린다 — 쓰지 않는다
    if (pyStrip(m) === '') throw new Error(`체크박스 줄의 핵심문구가 비어 있어 저장할 수 없음: ${task.file}`);
    t = syncTitleOf(task);
    src = task.file;
    const a: SyncAnchor = { f: task.file, m, rel: resolveAnchorRel(root, realRoot, task.file) };
    if (typeof task.line === 'number' && Number.isInteger(task.line) && task.line >= 1) {
      a.preferLine = { index: task.line - 1, text: task.rawLine };
    }
    anchors.push(a);
  } else {
    t = task.title;
    src = task.src ?? '';
    for (const a of task.anchors ?? []) {
      if (!a || typeof a.file !== 'string' || typeof a.match !== 'string' || a.match === '') {
        throw new Error(`앵커 형식이 잘못됨: ${task.title}`);
      }
      anchors.push({ f: a.file, m: a.match, rel: resolveAnchorRel(root, realRoot, a.file) });
    }
  }
  if (typeof t !== 'string' || pyStrip(t) === '') throw new Error('항목 제목이 비어 있음');
  if (/[\r\n]/.test(t)) throw new Error(`항목 제목에 줄바꿈이 있어 저장할 수 없음: ${t}`);

  const item: SyncItem = { t, s: input.status, n: note, src, anchors, source: task.source };
  if (owner) item.o = owner;
  return item;
}

// ---------------------------------------------------------------- 파일 읽기·쓰기

/** 파일의 정체(바뀌었는지 보는 값) */
interface FileSig {
  mtimeNs: bigint;
  size: bigint;
  ino: bigint;
}

interface FileState {
  /** 볼트 기준 상대경로(처음 부른 표기) */
  rel: string;
  abs: string;
  /** 읽은 때의 정체. 없던 파일이면 null */
  sig: FileSig | null;
  /** 읽은 원문 바이트(백업에 그대로 쓴다). 없던 파일이면 null */
  raw: Buffer | null;
  /** sync_todo 의 cache[rel] — 줄 목록. 없던 파일이면 null(put 하면 생긴다) */
  lines: string[] | null;
  /** 읽은 때의 줄을 \n 으로 이은 것(바뀌었는지 비교용) */
  originalText: string | null;
  bom: boolean;
  eol: '\n' | '\r\n';
  /** sync_todo 의 dirty */
  dirty: boolean;
}

function sigOf(st: fs.BigIntStats): FileSig {
  return { mtimeNs: st.mtimeNs, size: st.size, ino: st.ino };
}

function sameSig(a: FileSig | null, b: FileSig | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino;
}

/** 지금의 정체. 없으면 null, 확인하지 못하면 undefined(= 바뀐 것으로 본다) */
function currentSig(abs: string): FileSig | null | undefined {
  try {
    const st = fs.statSync(abs, { bigint: true, throwIfNoEntry: false });
    return st ? sigOf(st) : null;
  } catch {
    return undefined;
  }
}

function changedSince(f: FileState): boolean {
  const now = currentSig(f.abs);
  return now === undefined || !sameSig(f.sig, now);
}

/** 한 번 열어 정체와 내용을 함께 읽는다. 없으면 null. 잠금 같은 일시적 오류는 짧게 재시도 */
function readWithSig(abs: string, rel: string, sleep: (ms: number) => void): { sig: FileSig; raw: Buffer } | null {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const st = fs.fstatSync(fd, { bigint: true });
        if (!st.isFile()) throw new WriteRefusedError(rel, '파일이 아님');
        return { sig: sigOf(st), raw: fs.readFileSync(fd) };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if (err instanceof WriteRefusedError) throw err;
      const code = errCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (attempt >= READ_RETRY_DELAYS_MS.length || !TRANSIENT_READ_ERRORS.has(code)) {
        throw new Error(`파일을 읽지 못함(${code}): ${rel}`);
      }
      sleep(READ_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** 파일의 줄바꿈: CRLF 와 LF 중 많은 쪽(같으면 처음 나온 쪽, 줄바꿈이 없으면 LF) */
export function detectEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  let first: '\n' | '\r\n' | null = null;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) {
      crlf++;
      first ??= '\r\n';
    } else {
      lf++;
      first ??= '\n';
    }
  }
  if (crlf !== lf) return crlf > lf ? '\r\n' : '\n';
  return first ?? '\n';
}

/** 파일 내용: 줄을 \n 으로 잇고(sync_todo 의 "\n".join) 파일의 줄바꿈·BOM 으로 되돌린다 */
function render(f: FileState): Buffer {
  let text = (f.lines ?? []).join('\n');
  if (f.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  const body = Buffer.from(text, 'utf8');
  return f.bom ? Buffer.concat([BOM, body]) : body;
}

function fileKey(rel: string): string {
  // Windows 는 파일 이름의 대소문자를 가리지 않는다 — 같은 파일을 두 번 읽고 한쪽 변경을 덮어쓰지 않게
  return process.platform === 'win32' ? rel.toLowerCase() : rel;
}

/** sync_todo 의 cache·dirty — 한 번의 시도 동안 파일을 한 번만 읽고 여러 동작의 변경을 쌓는다 */
class FileCache {
  private readonly files = new Map<string, FileState>();

  constructor(
    private readonly root: string,
    private readonly realRoot: string,
    private readonly sleep: (ms: number) => void,
  ) {}

  /** def load(rel) — 쓰기 허용 목록을 통과한 파일만 읽는다 */
  load(rel: string): FileState {
    const key = fileKey(rel);
    const hit = this.files.get(key);
    if (hit) return hit;
    const abs = checkWritable(this.root, this.realRoot, rel);
    const read = readWithSig(abs, rel, this.sleep);
    let state: FileState;
    if (read === null) {
      state = { rel, abs, sig: null, raw: null, lines: null, originalText: null, bom: false, eol: '\n', dirty: false };
    } else {
      const bom = read.raw.length >= 3 && read.raw[0] === 0xef && read.raw[1] === 0xbb && read.raw[2] === 0xbf;
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? read.raw.subarray(3) : read.raw);
      } catch {
        throw new Error(`UTF-8 로 읽을 수 없는 파일이라 저장하지 않음: ${rel}`);
      }
      // 파이썬 read_text 의 보편 줄바꿈(\r\n·\r → \n) 뒤 split("\n") 과 같다
      const lines = splitLines(text);
      state = {
        rel,
        abs,
        sig: read.sig,
        raw: read.raw,
        lines,
        originalText: lines.join('\n'),
        bom,
        eol: detectEol(text),
        dirty: false,
      };
    }
    this.files.set(key, state);
    return state;
  }

  /** def put(rel, lines) */
  put(f: FileState, lines: string[]): void {
    f.lines = lines;
    f.dirty = true;
  }

  all(): FileState[] {
    return [...this.files.values()];
  }

  /**
   * 실제로 쓸 파일: dirty 이고 내용이 달라진 것(같은 내용이면 쓰지 않는다). 쓰는 순서대로 —
   * 메모 파일(덧붙이기만 한다)을 먼저, 나머지(앵커 줄·로그 절 — 목록에서 항목을 빼는 파일)는 이름순으로 뒤에.
   * 중간에 실패해도 항목이 목록에 남아 다시 저장할 수 있게 하려는 것이다(같은 메모는 다시 쓰지 않는다).
   */
  toWrite(): FileState[] {
    const memoKey = fileKey(MEMO);
    const rank = (f: FileState): number => (fileKey(f.rel) === memoKey ? 0 : 1);
    return this.all()
      .filter((f) => f.dirty && f.lines !== null && f.lines.join('\n') !== f.originalText)
      .sort((a, b) => rank(a) - rank(b) || compareCodeUnits(a.rel, b.rel));
  }
}

function writeAll(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
}

function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 지우기 실패는 본 오류를 가리지 않는다
  }
}

let tempCounter = 0;

/**
 * 같은 폴더의 임시 파일 경로. 원래 이름을 넣지 않고 짧은 해시만 쓴다 — 이름이 긴 파일(220자 넘게)에 꼬리를 붙이면
 * 한 이름 255자 한도를 넘어 만들 수 없다.
 */
function tempPathFor(abs: string): string {
  const tag = createHash('sha1').update(path.basename(abs), 'utf8').digest('hex').slice(0, 8);
  const name = `${TEMP_PREFIX}${tag}-${process.pid}-${Date.now().toString(36)}-${++tempCounter}${TEMP_SUFFIX}`;
  return path.join(path.dirname(abs), name);
}

/**
 * 이미 있는 파일을 쓰기로 열어 본다(열기만 하고 쓰지 않는다 — 내용·수정 시각은 그대로). 읽기 전용이거나 다른 프로그램이
 * 쓰기 공유 없이 연 파일은 여기서 걸려 첫 파일을 쓰기 전에 실패한다. 잠금은 짧게 재시도한다.
 * 삭제 공유 없이만 연 파일(이름 바꾸기만 막힌다)은 Node 로 미리 알 수 없다 — 쓰는 순서(toWrite)로 피해를 줄인다.
 */
function checkWriteAccess(f: FileState, sleep: (ms: number) => void): void {
  if (f.sig === null) return;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.closeSync(fs.openSync(f.abs, 'r+'));
      return;
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return; // 그사이 지워졌다 — 이름 바꾸기 앞의 재확인이 잡는다
      if (attempt < WRITE_RETRY_DELAYS_MS.length && WRITE_LOCK_ERRORS.has(code)) {
        sleep(WRITE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(`파일을 쓰지 못함(${code}): ${f.rel} — 읽기 전용이거나 다른 프로그램이 파일을 잡고 있을 수 있음`);
    }
  }
}

/** 같은 폴더의 임시 파일에 다 쓰고 fsync 한다. 임시 파일 경로를 돌려준다 */
function prepareTemp(f: FileState, data: Buffer): string {
  const tmp = tempPathFor(f.abs);
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(f.abs), { recursive: true });
    fd = fs.openSync(tmp, 'wx');
  } catch (err) {
    throw new Error(`임시 파일을 만들지 못함(${errCode(err)}): ${f.rel}`);
  }
  try {
    writeAll(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // 본 오류를 가리지 않는다
    }
    removeQuietly(tmp);
    throw new Error(`임시 파일을 쓰지 못함(${errCode(err)}): ${f.rel}`);
  }
  try {
    fs.closeSync(fd);
  } catch (err) {
    removeQuietly(tmp);
    throw new Error(`임시 파일을 쓰지 못함(${errCode(err)}): ${f.rel}`);
  }
  return tmp;
}

/**
 * 임시 파일 → 본 파일 이름 바꾸기. 바꾸기 바로 앞마다(처음과 잠금이 풀리기를 기다린 뒤마다) 본 파일이 읽은 때 그대로인지
 * 다시 본다 — 잠금은 다른 프로그램(OneDrive 가 원격 변경을 받아 쓰는 중·스크립트)이 쓰고 있다는 뜻일 수 있어,
 * 풀린 뒤 그대로 덮어쓰면 그 변경이 사라진다. 바뀌었으면 ChangedBeforeRename 을 던진다(부르는 쪽이 처음부터 다시 읽는다).
 * 임시 파일은 지우지 않는다(부르는 쪽이 치운다).
 */
function commitTemp(f: FileState, tmp: string, hooks: WritebackHooks): void {
  const rename = hooks.rename ?? fs.renameSync;
  const sleep = hooks.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    if (changedSince(f)) throw new ChangedBeforeRename(f.rel);
    try {
      rename(tmp, f.abs);
      return;
    } catch (err) {
      const code = errCode(err);
      if (attempt < WRITE_RETRY_DELAYS_MS.length && WRITE_LOCK_ERRORS.has(code)) {
        sleep(WRITE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(`파일을 쓰지 못함(${code}): ${f.rel} — 다른 프로그램이 파일을 잡고 있을 수 있음`);
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** datetime.now().strftime("%Y%m%dT%H%M%S") — 로컬 시각 */
export function backupStamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

/** 한 번의 저장(여러 시도)이 쓰는 백업 폴더와 거기 만든 사본 */
interface BackupState {
  /** 볼트 기준 백업 폴더. 아직 만들지 않았으면 undefined */
  dirRel: string | undefined;
  /** fileKey → 만든 사본의 절대경로 */
  made: Map<string, string>;
}

/**
 * 쓰기 전에 원본을 <wiki>/_todo-sync/backup/<stamp>/<상대경로> 로 남긴다(읽은 바이트 그대로, 수정 시각도 원본대로 —
 * shutil.copy2 처럼). 같은 초에 이미 저장한 백업 폴더가 있으면 덮어쓰지 않고 `<stamp>-2`, `-3` … 을 쓴다.
 * 새로 만드는 파일(원본 없음)은 백업할 것이 없다. 한 저장이 다시 읽고 처음부터 할 때는 같은 폴더를 쓴다 —
 * 이미 써 버린 파일의 사본(저장 전 원본)은 그대로 두고, 아직 쓰지 않은 파일의 사본은 이번에 읽은 것으로 바꾼다.
 */
function writeBackups(root: string, stamp: string, files: FileState[], backup: BackupState, writtenKeys: ReadonlySet<string>): void {
  const existing = files.filter((f) => f.raw !== null);
  if (existing.length === 0) return;
  if (backup.dirRel === undefined) {
    const base = `${BACKUP_ROOT}/${stamp}`;
    let dirRel = base;
    for (let n = 2; lstatOrNull(path.join(root, ...dirRel.split('/'))) !== null; n++) dirRel = `${base}-${n}`;
    backup.dirRel = dirRel;
  }
  for (const f of existing) {
    const key = fileKey(f.rel);
    const prev = backup.made.get(key);
    if (prev !== undefined) {
      if (writtenKeys.has(key)) continue;
      fs.rmSync(prev, { force: true });
      backup.made.delete(key);
    }
    const dst = path.join(root, ...backup.dirRel.split('/'), ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.raw as Buffer, { flag: 'wx' });
    backup.made.set(key, dst);
    if (f.sig) {
      const mtime = new Date(Number(f.sig.mtimeNs / 1_000_000n));
      try {
        fs.utimesSync(dst, mtime, mtime);
      } catch {
        // 시각을 못 맞춰도 백업 내용은 온전하다
      }
    }
  }
}

/**
 * 쓰지 않은 파일의 사본을 지운다(이 저장에서 만든 사본만). 비게 된 폴더도 백업 폴더까지 지우고, 남은 사본이 없으면
 * 백업 폴더도 지운다 — 실패한 저장이 쓸모없는 백업을 남기지 않게.
 */
function pruneBackups(root: string, backup: BackupState, keep: ReadonlySet<string>): void {
  if (backup.dirRel === undefined) return;
  const base = path.join(root, ...backup.dirRel.split('/'));
  for (const [key, dst] of [...backup.made]) {
    if (keep.has(key)) continue;
    backup.made.delete(key);
    removeQuietly(dst);
    for (let dir = path.dirname(dst); isInsideDir(base, dir); dir = path.dirname(dir)) {
      try {
        fs.rmdirSync(dir);
      } catch {
        break; // 비지 않았다
      }
    }
  }
  if (backup.made.size === 0) {
    try {
      fs.rmdirSync(base);
    } catch {
      // 비지 않았으면 둔다
    }
    backup.dirRel = undefined;
  }
}

// ---------------------------------------------------------------- sync_todo 본체(한 항목분)

type SyncResult = Omit<WritebackResult, 'files' | 'backupDir'>;

/**
 * def section(lines, head, intro): 섹션의 (시작, 끝) 인덱스를 돌려준다. 없으면 만든다.
 *     if head not in lines:
 *         while lines and lines[-1].strip() == "": lines.pop()
 *         lines += ["", head, "", intro, ""]
 */
function section(lines: string[], head: string, intro: string): [number, number] {
  if (!lines.includes(head)) {
    while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
    lines.push('', head, '', intro, '');
  }
  const s = lines.indexOf(head);
  let e = lines.length;
  for (let j = s + 1; j < lines.length; j++) {
    if (lines[j].startsWith('## ')) {
      e = j;
      break;
    }
  }
  return [s, e];
}

/** 앞 12줄 안의 첫 `updated:` 줄을 바꾼다 */
function touchUpdated(lines: string[], date: string): void {
  for (let i = 0; i < Math.min(12, lines.length); i++) {
    if (lines[i].startsWith('updated:')) {
      lines[i] = 'updated: ' + date;
      break;
    }
  }
}

function runSync(cache: FileCache, it: SyncItem, today: string): SyncResult {
  const res: SyncResult = {
    date: today,
    updated: [],
    loggedDone: [],
    loggedDelegated: [],
    loggedWip: [],
    unlogged: [],
    memo: false,
    unmatched: [],
    warnings: [],
  };

  /** def log(head, entry, title) */
  const log = (head: string, entry: string, title: string): void => {
    const f = cache.load(TODO);
    if (f.lines === null) {
      res.warnings.push(`${TODO} 가 없어 로그를 적지 못함: ${title}`);
      return;
    }
    const lines = f.lines;
    const [s, e] = section(lines, head, LOG_INTRO);
    // block = [b for b in block if ("· " + title) not in b]      # 같은 항목 재기록 방지
    const block = lines.slice(s, e).filter((b) => !b.includes('· ' + title));
    while (block.length > 0 && isBlank(block[block.length - 1])) block.pop();
    block.push(entry, '');
    lines.splice(s, e - s, ...block);
    // lines[i] = "updated: " + entry.split(" · ")[0].lstrip("- ")
    touchUpdated(lines, entry.split(' · ')[0].replace(/^[- ]+/, ''));
    cache.put(f, lines);
  };

  /** def unlog(head, title): 대기로 되돌린 항목을 로그에서 뺀다. 지운 것이 있으면 true */
  const unlog = (head: string, title: string): boolean => {
    const f = cache.load(TODO);
    const lines = f.lines;
    if (lines === null || !lines.includes(head)) return false;
    const [s, e] = section(lines, head, '');
    const block = lines.slice(s, e);
    const keep = block.filter((b) => !b.includes('· ' + title));
    if (keep.length === block.length) return false;
    lines.splice(s, e - s, ...keep);
    cache.put(f, lines);
    return true;
  };

  /** def write_memo(it, note, today) — 새로 썼으면 true, 같은 메모가 이미 있으면 false */
  const writeMemo = (note: string): boolean => {
    const f = cache.load(MEMO);
    // 파이썬은 캐시의 목록을 그 자리에서 고치지만 put 하지 않으면(중복) 쓰지 않는다 — 여기서는 사본을 고쳐 put 할 때만 넘긴다
    const lines =
      f.lines !== null
        ? f.lines.slice()
        : [
            '---',
            'type: note',
            'domain: [business]',
            'tags: [업무, 메모]',
            `created: ${today}`,
            `updated: ${today}`,
            '---',
            '',
            '# 할 일 메모',
            '',
            '> 아티팩트「내 할 일 — 위키 종합」에서 항목별로 적어 둔 의견을 모은다.' +
              ' 원본 태스크는 [[내 할 일]]과 각 고객사·주제 페이지에 있다.',
            '',
          ];
    touchUpdated(lines, today);
    const head = '## ' + it.t;
    // body = note.replace("\r", "").strip()
    const body = pyStrip(note.replace(/\r/g, ''));
    // entry = "- %s · %s" % (today, body.replace("\n", "\n  "))
    const indented = body.split('\n').join('\n  ');
    const entry = `- ${today} · ${indented}`;
    if (!lines.includes(head)) {
      while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
      lines.push('', head, `출처 \`${it.src}\``, '', entry, '');
    } else {
      const s = lines.indexOf(head);
      let e = lines.length;
      for (let j = s + 1; j < lines.length; j++) {
        if (lines[j].startsWith('## ')) {
          e = j;
          break;
        }
      }
      const block = lines.slice(s, e);
      // if body.replace("\n", "\n  ") in "\n".join(block): return False   # 같은 메모 중복 방지(여러 줄 포함)
      if (block.join('\n').includes(indented)) return false;
      while (block.length > 0 && isBlank(block[block.length - 1])) block.pop();
      block.push(entry, '');
      lines.splice(s, e - s, ...block);
    }
    cache.put(f, lines);
    return true;
  };

  // ---- def sync(): for it in pl["items"] 의 한 항목분
  const status = it.s;
  const note = it.n;
  let hit = false;
  for (const a of it.anchors) {
    if (a.rel === null) {
      res.unmatched.push(`${it.t} — 파일 없음: ${a.f}`);
      continue;
    }
    const f = cache.load(a.rel);
    const lines = f.lines;
    if (lines === null) {
      res.unmatched.push(`${it.t} — 파일 없음: ${a.f}`);
      continue;
    }
    // if re.match(r"^- \[[ xX]\]", ln) and a["m"] in ln:
    const matches = (ln: string) => ANCHOR_LINE_RE.test(ln) && ln.includes(a.m);
    // 체크박스 항목은 스냅샷이 가리킨 줄이 글자 그대로 있으면 그 줄(같은 문구의 줄이 여럿일 때 엉뚱한 줄을 고치지 않게).
    // 줄 전체가 같으면 문구 포함 여부는 보지 않는다 — 핵심문구 규칙이 어긋나도(값 안의 대괄호 등) 그 줄을 놓치지 않게.
    // 그 밖에는 sync_todo 처럼 조건에 맞는 첫 줄.
    let idx = -1;
    const pref = a.preferLine;
    if (pref && lines[pref.index] === pref.text && ANCHOR_LINE_RE.test(pref.text)) idx = pref.index;
    if (idx < 0) idx = lines.findIndex(matches);
    if (idx >= 0) {
      const ln = lines[idx];
      const next = applyStatus(ln, status, it.o, today);
      if (next !== ln) {
        lines[idx] = next;
        cache.put(f, lines);
      }
      hit = true;
    } else {
      // "%s — 문구 미발견: %s / %s" % (it["t"], a["f"], a["m"][:28])
      res.unmatched.push(`${it.t} — 문구 미발견: ${a.f} / ${codePointSlice(a.m, 28)}`);
    }
  }

  // 체크박스 항목은 자기 줄이 곧 상태다. 줄을 못 찾았는데 sync_todo 처럼 로그 절에 적으면 줄은 그대로라
  // 목록에서 영영 안 빠지고 로그에만 기록이 남는다(2026-09-28 실제로 일어났다) — 아무것도 쓰지 않고 멈춘다.
  if (!hit && it.source === 'checkbox') {
    const where = it.anchors.map((a) => a.f).join(', ');
    throw new Error(
      `할 일 줄을 찾지 못함(${where}) — 그사이 줄이 바뀌었거나 지워졌을 수 있음. 목록을 새로 읽은 뒤 다시 저장하세요 — 아무것도 쓰지 않았음`,
    );
  }

  if (hit) {
    res.updated.push(`${it.t} [${status}]`);
  } else if (status === 'done') {
    log(H_DONE, `- ${today} · ${it.t} — 출처 \`${it.src}\``, it.t);
    res.loggedDone.push(it.t);
  } else if (status === 'notmine') {
    // 여러 줄 메모는 로그에는 한 줄로 적는다(sync_todo 는 그대로 넣어 둘째 줄부터가 절 안의 맨 줄이 된다 —
    // `## `·`- [ ]` 로 시작하면 절이나 할 일이 새로 생기고, 다시 기록할 때 첫 줄만 지워진다). 메모 파일에는 여러 줄 그대로 남는다.
    const logNote = note.includes('\n') ? note.split('\n').map(pyStrip).filter(Boolean).join(' / ') : note;
    log(H_DELG, `- ${today} · ${it.t} → 담당 **${it.o || DEFAULT_OWNER}**${logNote ? ' — ' + logNote : ''}`, it.t);
    res.loggedDelegated.push(it.t);
  } else if (status === 'wip') {
    log(H_WIP, `- ${today} · ${it.t}`, it.t);
    res.loggedWip.push(it.t);
  } else {
    // open — 이전 기록 회수
    let removed = false;
    for (const h of [H_DONE, H_DELG, H_WIP]) if (unlog(h, it.t)) removed = true;
    if (removed) res.unlogged.push(it.t);
  }
  if (note) {
    if (writeMemo(note)) res.memo = true;
  }
  return res;
}

// ---------------------------------------------------------------- 진입점

export function applyWriteback(input: WritebackInput): WritebackResult {
  return applyWritebackWith(input, {});
}

/**
 * applyWriteback 과 같고 시험용 끼워 넣기를 받는다.
 * 순서: 읽기(파일마다 한 번) → sync_todo 한 항목분 적용 → 쓰기 직전 재확인(읽은 파일 전부의 mtime·크기·파일 번호.
 * 바뀌었으면 다시 읽고 처음부터, 모두 3번) → 쓸 파일마다 쓰기로 열어 보기 → 임시 파일 모두 준비(fsync) → 백업 →
 * 이름 바꾸기(메모 파일 먼저, 목록에서 항목을 빼는 파일은 뒤에). 이름 바꾸기 바로 앞마다 그 파일을 다시 확인해,
 * 바뀌었으면 덮어쓰지 않고 다시 읽고 처음부터 한다(3번 안에 센다).
 * 3번 모두 바뀌거나 쓰지 못하면 던진다 — 파일을 하나도 쓰지 않았으면 Error(백업도 남기지 않는다),
 * 하나라도 썼으면 PartialWriteError(쓴 파일과 그 백업만 남는다).
 */
export function applyWritebackWith(input: WritebackInput, hooks: WritebackHooks): WritebackResult {
  if (!input || typeof input !== 'object') throw new Error('저장 입력이 없음');
  if (!isValidYmd(input.today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(input.today)}`);
  if (typeof input.wikiRoot !== 'string' || input.wikiRoot === '') throw new Error('위키 폴더가 지정되지 않음');
  const root = path.resolve(input.wikiRoot);
  if (!isDirectory(root)) throw new Error(`위키 폴더를 찾을 수 없음: ${input.wikiRoot}`);
  const realRoot = fs.realpathSync.native(root);
  const sleep = hooks.sleep ?? sleepSync;

  const item = toSyncItem(input, root, realRoot);
  // 로그·메모 파일도 허용 목록 검사를 먼저 거친다(링크로 위키 밖을 가리키면 아무것도 하지 않는다)
  checkWritable(root, realRoot, TODO);
  checkWritable(root, realRoot, MEMO);
  const stamp = backupStamp(input.now ?? new Date());
  const retryWarnings: string[] = [];
  // 이 저장에서 이미 쓴 파일(시도를 넘어 쌓인다 — 다시 읽고 처음부터 할 때 앞 시도에서 쓴 파일은 내용이 같아 다시 쓰지 않는다)
  const written = new Map<string, string>();
  const backup: BackupState = { dirRel: undefined, made: new Map() };
  const memoKey = fileKey(MEMO);

  const writtenList = (): string[] => [...written.values()].sort(compareCodeUnits);
  /** 실패: 쓰지 않은 파일의 백업을 치우고 던진다 */
  const fail = (cause: string): never => {
    pruneBackups(root, backup, new Set(written.keys()));
    if (written.size > 0) throw new PartialWriteError(cause, writtenList(), backup.dirRel);
    throw new Error(`${cause} — 아무것도 쓰지 않았음`);
  };
  const finish = (res: SyncResult, warnings: string[]): WritebackResult => {
    pruneBackups(root, backup, new Set(written.keys()));
    // 앞 시도에서 메모를 이미 썼으면 이번 시도는 '같은 메모가 있음'으로 보지만, 이 저장이 쓴 것이다
    const out: WritebackResult = { ...res, memo: res.memo || written.has(memoKey), files: writtenList(), warnings };
    if (written.size > 0 && backup.dirRel !== undefined) out.backupDir = backup.dirRel;
    return out;
  };

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const cache = new FileCache(root, realRoot, sleep);
    const res = runSync(cache, item, input.today);
    const toWrite = cache.toWrite();

    // 쓰기 직전 재확인: 이번 시도에서 읽은 파일이 그 사이 바뀌었으면(OneDrive·Obsidian·open_loops) 다시 읽고 처음부터
    hooks.beforeRecheck?.({ attempt, files: cache.all().map((f) => f.rel) });
    const moved = cache.all().filter(changedSince);
    if (moved.length > 0) {
      retryWarnings.push(`저장 직전에 파일이 바뀌어 다시 읽음(${attempt}번째): ${moved.map((f) => f.rel).join(', ')}`);
      continue;
    }

    const warnings = [...retryWarnings, ...res.warnings];
    if (toWrite.length === 0) return finish(res, warnings);

    // 첫 파일을 쓰기 전에 걸러 낼 수 있는 실패(읽기 전용·쓰기 잠금·임시 파일을 못 만듦)는 여기서 — 백업도 남기지 않는다
    try {
      for (const f of toWrite) checkWriteAccess(f, sleep);
    } catch (err) {
      fail(errCode(err));
    }
    const temps: (string | null)[] = [];
    const dropTemps = (): void => {
      for (const t of temps) if (t !== null) removeQuietly(t);
    };
    try {
      for (const f of toWrite) temps.push(prepareTemp(f, render(f)));
      writeBackups(root, stamp, toWrite, backup, new Set(written.keys()));
    } catch (err) {
      dropTemps();
      const msg = errCode(err);
      fail(msg.startsWith('임시 파일') ? msg : `고치기 전 사본을 만들지 못함(${msg})`);
    }

    let changed: string | null = null;
    for (let i = 0; i < toWrite.length; i++) {
      const f = toWrite[i];
      try {
        commitTemp(f, temps[i] as string, hooks);
      } catch (err) {
        dropTemps();
        if (err instanceof ChangedBeforeRename) {
          changed = err.rel;
          break;
        }
        fail(errCode(err));
      }
      temps[i] = null;
      written.set(fileKey(f.rel), f.rel);
    }
    if (changed !== null) {
      // 잠금이 풀리기를 기다리는 사이 등에 다른 프로그램이 썼다 — 덮어쓰지 않고 다시 읽는다
      retryWarnings.push(`저장하는 사이에 파일이 바뀌어 다시 읽음(${attempt}번째): ${changed}`);
      continue;
    }
    return finish(res, warnings);
  }
  return fail(`파일이 계속 바뀌고 있어 저장하지 못함(${MAX_WRITE_ATTEMPTS}번 다시 읽음)`);
}

// ---------------------------------------------------------------- 할 일 줄에 필드 하나 붙이기(2.6단계 §6)

export interface LineFieldInput {
  /** 마스터 볼트 절대경로 */
  wikiRoot: string;
  /** 오늘 YYYY-MM-DD(형식만 본다 — 줄 필드는 날짜를 쓰지 않는다) */
  today: string;
  /** 스냅샷의 체크박스 할 일, 또는 체크박스 줄에 연결된 큐레이션 할 일(file·line·rawLine·anchors 를 쓴다) */
  task: Task;
  /** 필드 이름(예: voc). 글자·숫자·_ 만 */
  key: string;
  /** 필드 값(예: VOC-2026-0012). 대괄호·줄바꿈 없음 */
  value: string;
  /** 백업 폴더 이름에 쓸 시각. 없으면 지금 */
  now?: Date;
}

export interface LineFieldResult {
  /** 쓴 파일(볼트 기준 상대경로) */
  files: string[];
  /** 백업 폴더(볼트 기준 상대경로) */
  backupDir?: string;
  warnings: string[];
}

/**
 * 필드 이름: build_todo core_of 가 떼어 내는 이름(`\w+` — CORE_FIELD_RE)만 받는다. 그래야 붙인 뒤에도
 * 핵심문구(ID·앵커)가 그대로다.
 */
const LINE_FIELD_KEY_RE = /^[\p{L}\p{N}_]{1,40}$/u;
/** 필드 값에 쓸 수 없는 글자: 대괄호(필드가 깨진다)·제어 문자(줄바꿈 포함) */
const BAD_LINE_FIELD_VALUE_RE = /[[\]\u0000-\u001f\u007f\u2028\u2029]/;
const LINE_FIELD_VALUE_MAX = 200;

/** 줄의 `[key:: 값]` 값(앞뒤 공백 걷음). 없으면 undefined, 값이 비어 있으면 '' */
export function lineFieldValue(line: string, key: string): string | undefined {
  if (typeof line !== 'string' || typeof key !== 'string' || key === '') return undefined;
  return rawFields(line).get(key);
}

/**
 * 이 줄에 key 필드가 이미 있는가 — 값이 빈 `[voc::]`, rawFields 가 못 읽는 모양(`[voc::` 뒤에 `]` 가 없음 등)도 있는 것으로 본다.
 * applyLineField 가 같은 판정으로 거부하므로, 줄에 붙이기 전에 되돌릴 수 없는 일(VOC 티켓 만들기)을 하는 쪽도 이것으로 먼저 본다
 */
export function hasLineField(line: string, key: string): boolean {
  if (typeof line !== 'string' || typeof key !== 'string' || key === '') return false;
  if (lineFieldValue(line, key) !== undefined) return true;
  return new RegExp(`\\[${PY_WS}*${escapeRegExp(key)}${PY_WS}*::`, 'u').test(line);
}

/**
 * 줄을 다시 찾을 때 쓸 문구: 체크박스 할 일은 핵심문구 앞 40자(checkboxAnchorMatch), 큐레이션 할 일은 스냅샷이
 * 연결한 줄(file·rawLine)에 든 items.json 앵커 문구(sync_todo 가 그 줄을 찾는 문구와 같다 — 없으면 핵심문구).
 */
function lineAnchorOf(task: Task & { rawLine: string }): string {
  if (task.source === 'curated') {
    const hit = (task.anchors ?? []).find((a) => a && typeof a.match === 'string' && a.match !== '' && task.rawLine.includes(a.match));
    if (hit) return hit.match;
  }
  return checkboxAnchorMatch(task.rawLine);
}

/**
 * 파일 줄에서 할 일 줄을 찾는다(0부터, 없으면 -1): 스냅샷이 가리킨 자리에 원문 그대로 있으면 그 줄 →
 * 원문 그대로인 다른 줄(위에 줄이 늘거나 줄었을 때) → 앵커 문구(lineAnchorOf)가 든 첫 체크박스 줄.
 */
function findTaskLine(lines: readonly string[], task: Task, anchor: string): number {
  const raw = task.rawLine as string;
  if (typeof task.line === 'number' && Number.isInteger(task.line) && task.line >= 1) {
    const i = task.line - 1;
    if (lines[i] === raw && ANCHOR_LINE_RE.test(raw)) return i;
  }
  const same = lines.findIndex((ln) => ln === raw && ANCHOR_LINE_RE.test(ln));
  if (same >= 0) return same;
  return lines.findIndex((ln) => ANCHOR_LINE_RE.test(ln) && ln.includes(anchor));
}

/**
 * 체크박스 할 일 줄(큐레이션 할 일이면 스냅샷이 연결한 앵커 줄) 끝에 ` [key:: value]` 를 붙인다(2.6단계 §6 — VOC 등록 번호). 같은 key 가 줄에 이미 있으면
 * 바꾸지 않고 던진다. 안전장치는 applyWriteback 과 같다: 쓰기 허용 목록, 쓰기 직전 재확인(바뀌었으면 다시 읽고
 * 처음부터 — 모두 3번), 쓰기로 열어 보기, 백업, 같은 폴더 임시 파일 → 이름 바꾸기, 줄바꿈·BOM 유지.
 * 핵심문구(ID)는 바뀌지 않는다(필드는 core_of 가 떼어 낸다). sync_todo 는 모르는 필드를 그대로 둔다.
 */
export function applyLineField(input: LineFieldInput): LineFieldResult {
  return applyLineFieldWith(input, {});
}

/** applyLineField 와 같고 시험용 끼워 넣기를 받는다 */
export function applyLineFieldWith(input: LineFieldInput, hooks: WritebackHooks): LineFieldResult {
  if (!input || typeof input !== 'object') throw new Error('저장 입력이 없음');
  if (!isValidYmd(input.today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(input.today)}`);
  if (typeof input.wikiRoot !== 'string' || input.wikiRoot === '') throw new Error('위키 폴더가 지정되지 않음');
  const { task, key } = input;
  if (typeof key !== 'string' || !LINE_FIELD_KEY_RE.test(key)) throw new Error(`필드 이름 형식이 아님: ${String(key)}`);
  const value = typeof input.value === 'string' ? pyStrip(input.value) : '';
  if (value === '') throw new Error(`[${key}::] 에 넣을 값이 비어 있음`);
  if (BAD_LINE_FIELD_VALUE_RE.test(value)) throw new Error(`[${key}::] 값에는 대괄호([ ])나 줄바꿈을 쓸 수 없음`);
  if (codePointLength(value) > LINE_FIELD_VALUE_MAX) throw new Error(`[${key}::] 값이 너무 김(${LINE_FIELD_VALUE_MAX}자까지)`);
  if (!task || typeof task !== 'object') throw new Error('저장할 항목이 없음');
  if (task.source !== 'checkbox' && task.source !== 'curated') throw new Error('줄 필드는 위키 체크박스 줄이 있는 할 일에만 붙일 수 있음');
  if (typeof task.file !== 'string' || typeof task.rawLine !== 'string') {
    throw new Error(
      task.source === 'curated'
        ? `연결된 체크박스 줄이 없는 할 일이라 줄 필드를 붙일 수 없음: ${task.title}`
        : `체크박스 항목에 파일·줄이 없음: ${task.title}`,
    );
  }
  const anchor = lineAnchorOf(task as Task & { rawLine: string });
  // 빈 문구는 파일의 첫 체크박스 줄에 걸린다 — 쓰지 않는다
  if (pyStrip(anchor) === '') throw new Error(`체크박스 줄의 핵심문구가 비어 있어 저장할 수 없음: ${task.file}`);

  const root = path.resolve(input.wikiRoot);
  if (!isDirectory(root)) throw new Error(`위키 폴더를 찾을 수 없음: ${input.wikiRoot}`);
  const realRoot = fs.realpathSync.native(root);
  const sleep = hooks.sleep ?? sleepSync;
  const rel = resolveAnchorRel(root, realRoot, task.file);
  if (rel === null) throw new Error(`할 일 파일이 없음: ${task.file} — 아무것도 쓰지 않았음`);
  const stamp = backupStamp(input.now ?? new Date());
  const retryWarnings: string[] = [];
  const backup: BackupState = { dirRel: undefined, made: new Map() };
  const none: ReadonlySet<string> = new Set();

  /** 실패: 파일은 하나뿐이라 이름 바꾸기 전에 멈추면 쓴 것이 없다 — 만든 백업을 치우고 던진다 */
  const fail = (cause: string): never => {
    pruneBackups(root, backup, none);
    throw new Error(`${cause} — 아무것도 쓰지 않았음`);
  };

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const cache = new FileCache(root, realRoot, sleep);
    const f = cache.load(rel);
    if (f.lines === null) fail(`할 일 파일이 없음: ${task.file}`);
    const lines = (f.lines as string[]).slice();
    const idx = findTaskLine(lines, task, anchor);
    if (idx < 0) {
      fail(`할 일 줄을 찾지 못함(${task.file}) — 그사이 줄이 바뀌었거나 지워졌을 수 있음. 목록을 새로 읽은 뒤 다시 하세요`);
    }
    const ln = lines[idx];
    if (hasLineField(ln, key)) {
      const existing = lineFieldValue(ln, key);
      fail(`이미 [${key}:: ${existing ?? '…'}] 가 있음(${task.file} ${idx + 1}번째 줄)`);
    }
    const next = `${pyRstrip(ln)} [${key}:: ${value}]`;
    // 붙인 필드가 핵심문구에 섞이면(= ID·앵커가 바뀌면) 목록이 그 줄을 다른 할 일로 본다 — 쓰지 않는다
    if (coreOf(next) !== coreOf(ln) || lineFieldValue(next, key) !== value) {
      fail(`필드를 붙이면 할 일 줄의 핵심문구가 바뀌어 쓰지 않음: ${task.file}`);
    }
    lines[idx] = next;
    cache.put(f, lines);

    // 쓰기 직전 재확인: 읽은 뒤 파일이 바뀌었으면(OneDrive·Obsidian·open_loops) 다시 읽고 처음부터
    hooks.beforeRecheck?.({ attempt, files: cache.all().map((x) => x.rel) });
    if (changedSince(f)) {
      retryWarnings.push(`저장 직전에 파일이 바뀌어 다시 읽음(${attempt}번째): ${f.rel}`);
      continue;
    }

    try {
      checkWriteAccess(f, sleep);
    } catch (err) {
      fail(errCode(err));
    }
    let tmp: string | null = null;
    try {
      tmp = prepareTemp(f, render(f));
      writeBackups(root, stamp, [f], backup, none);
    } catch (err) {
      if (tmp !== null) removeQuietly(tmp);
      const msg = errCode(err);
      fail(msg.startsWith('임시 파일') ? msg : `고치기 전 사본을 만들지 못함(${msg})`);
    }
    try {
      commitTemp(f, tmp as string, hooks);
    } catch (err) {
      removeQuietly(tmp as string);
      if (err instanceof ChangedBeforeRename) {
        retryWarnings.push(`저장하는 사이에 파일이 바뀌어 다시 읽음(${attempt}번째): ${err.rel}`);
        continue;
      }
      fail(errCode(err));
    }
    const out: LineFieldResult = { files: [f.rel], warnings: retryWarnings };
    if (backup.dirRel !== undefined) out.backupDir = backup.dirRel;
    return out;
  }
  return fail(`파일이 계속 바뀌고 있어 저장하지 못함(${MAX_WRITE_ATTEMPTS}번 다시 읽음)`);
}

// ---------------------------------------------------------------- 파일 하나 고치기(2.10단계 §7-3 — 메일함 [할 일로])

export interface FileEditInput {
  /** 마스터 볼트 절대경로 */
  wikiRoot: string;
  /** 고칠 파일(볼트 기준 상대경로 — 쓰기 허용 목록 검사를 거친다) */
  rel: string;
  /** 백업 폴더 이름에 쓸 시각. 없으면 지금 */
  now?: Date;
}

/** 고치기 함수가 이 파일을 고치지 않기로 했다(이미 있음·절 없음 등) — 문장 그대로 던진다(파일은 그대로) */
export class EditRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditRefusedError';
  }
}

/**
 * 파일 하나를 줄 단위로 고친다. edit 은 읽은 줄(복사본)을 받아 새 줄을 돌려주거나 EditRefusedError 를 던진다.
 * 안전장치는 applyLineField 와 같다: 쓰기 허용 목록, 쓰기 직전 재확인(바뀌었으면 다시 읽고 처음부터 — 모두 3번),
 * 쓰기로 열어 보기, _todo-sync/backup 백업, 같은 폴더 임시 파일 → 이름 바꾸기, 줄바꿈·BOM 유지. 파일이 없으면 거부한다(만들지 않는다).
 */
export function applyFileEditWith(
  input: FileEditInput,
  edit: (lines: string[]) => string[],
  hooks: WritebackHooks = {},
): LineFieldResult {
  if (!input || typeof input !== 'object') throw new Error('저장 입력이 없음');
  if (typeof input.wikiRoot !== 'string' || input.wikiRoot === '') throw new Error('위키 폴더가 지정되지 않음');
  const root = path.resolve(input.wikiRoot);
  if (!isDirectory(root)) throw new Error(`위키 폴더를 찾을 수 없음: ${input.wikiRoot}`);
  const realRoot = fs.realpathSync.native(root);
  const sleep = hooks.sleep ?? sleepSync;
  const rel = safeVaultRelative(input.rel);
  if (rel === null) throw new WriteRefusedError(input.rel, '위키 밖이거나 잘못된 경로');
  checkWritable(root, realRoot, rel);
  const stamp = backupStamp(input.now ?? new Date());
  const retryWarnings: string[] = [];
  const backup: BackupState = { dirRel: undefined, made: new Map() };
  const none: ReadonlySet<string> = new Set();

  const fail = (cause: string): never => {
    pruneBackups(root, backup, none);
    throw new Error(`${cause} — 아무것도 쓰지 않았음`);
  };

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const cache = new FileCache(root, realRoot, sleep);
    const f = cache.load(rel);
    if (f.lines === null) fail(`파일이 없음: ${rel}`);
    let next: string[];
    try {
      next = edit((f.lines as string[]).slice());
    } catch (err) {
      pruneBackups(root, backup, none);
      throw err;
    }
    cache.put(f, next);
    if (next.join('\n') === f.originalText) return { files: [], warnings: retryWarnings };

    hooks.beforeRecheck?.({ attempt, files: cache.all().map((x) => x.rel) });
    if (changedSince(f)) {
      retryWarnings.push(`저장 직전에 파일이 바뀌어 다시 읽음(${attempt}번째): ${f.rel}`);
      continue;
    }
    try {
      checkWriteAccess(f, sleep);
    } catch (err) {
      fail(errCode(err));
    }
    let tmp: string | null = null;
    try {
      tmp = prepareTemp(f, render(f));
      writeBackups(root, stamp, [f], backup, none);
    } catch (err) {
      if (tmp !== null) removeQuietly(tmp);
      const msg = errCode(err);
      fail(msg.startsWith('임시 파일') ? msg : `고치기 전 사본을 만들지 못함(${msg})`);
    }
    try {
      commitTemp(f, tmp as string, hooks);
    } catch (err) {
      removeQuietly(tmp as string);
      if (err instanceof ChangedBeforeRename) {
        retryWarnings.push(`저장하는 사이에 파일이 바뀌어 다시 읽음(${attempt}번째): ${err.rel}`);
        continue;
      }
      fail(errCode(err));
    }
    const out: LineFieldResult = { files: [f.rel], warnings: retryWarnings };
    if (backup.dirRel !== undefined) out.backupDir = backup.dirRel;
    return out;
  }
  return fail(`파일이 계속 바뀌고 있어 저장하지 못함(${MAX_WRITE_ATTEMPTS}번 다시 읽음)`);
}
