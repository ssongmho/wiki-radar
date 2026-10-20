// 팀 위키 할 일 줄 쓰기(2.9단계 명세 §5). electron 을 import 하지 않는 순수 모듈이다.
//
// 쓰는 것은 팀 위키 사본(teamSync.local) 안 .md 의 할 일 줄 **하나**뿐이다. 개인 위키 쓰기 규칙(2단계 §1 — 허용 목록·로그 절·
// 메모 파일·_todo-sync/backup)과 섞지 않는다: 팀 위키에는 로그 절·메모 파일·반영 대기열이 없다.
// 안전장치는 2단계 §1-3 과 같은 것: 줄바꿈·BOM 유지, 쓰기 전 백업(데이터 폴더 — 사본 안에 두면 NAS 로 올라간다),
// 같은 폴더 임시 파일(동기화 제외 이름) → 이름 바꾸기, 이름 바꾸기 직전 mtime·크기 재확인(바뀌었으면 처음부터 — 최대 3번).
// NAS 로 올리는 것은 2.8 동기화(사본 감시)가 한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { meNameProblem } from '../../shared/team';
import type { SaveTeamTaskInput, TeamTaskStatus } from '../../shared/types';
import { isValidYmd } from './calendar';
import { CHECKBOX_RE, teamCoreOf } from './checkbox';
import { TRANSIENT_READ_ERRORS, errCode, isInsideDir, safeVaultRelative, sleepSync, splitLines, toPosix } from './fsutil';
import { PY_WS, pyRstrip } from './pystr';
import { isTeamExcluded, readTemplateFolder, teamTaskId } from './teamTasks';
import { backupStamp, detectEol } from './writeback';

/** 한 번의 저장에서 다시 읽고 처음부터 하는 최대 횟수 */
export const TEAM_MAX_WRITE_ATTEMPTS = 3;
/** 이름 바꾸기가 잠금(EPERM·EBUSY)에 걸릴 때 기다리는 간격(ms) */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400];
/** 임시 파일 꼬리(2.8 동기화가 올리지 않는 이름 — engine.ts SKIP_NAMES) */
export const TEAM_TEMP_SUFFIX = '.wiki-radar-tmp';
/** 백업을 남겨 두는 날 수 */
export const TEAM_BACKUP_KEEP_DAYS = 30;
/** 데이터 폴더 안 팀 백업 폴더 이름 */
export const TEAM_BACKUP_DIR = 'team-backup';

export const TEAM_LINE_NOT_FOUND =
  '할 일 줄을 찾지 못했습니다 — 그사이 팀 위키가 바뀌었을 수 있습니다. 목록을 새로 읽은 뒤 다시 저장하세요';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// ---------------------------------------------------------------------------
// 줄 고치기

/** 바꿀 것. 없는 키는 그대로 둔다 */
export interface TeamLineChange {
  status?: TeamTaskStatus;
  /** 빈 배열이면 담당 필드를 지운다 */
  owners?: string[];
  /** '' 이면 기한 필드를 지운다 */
  due?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `[키:: 값]` 필드(앞 공백 포함). 값 안의 짝 맞는 대괄호 두 겹까지 허용한다(`[owner:: [[홍길동]]]` — 팀 읽기 TEAM_FIELD_RE 와 같다.
 * 짝이 안 맞으면 첫 `]` 에서 끊는다).
 * 1: 앞 공백, 2: 값
 */
function fieldRe(key: string): RegExp {
  const k = escapeRegExp(key);
  return new RegExp(
    `(${PY_WS}*)\\[${PY_WS}*${k}${PY_WS}*::((?:[^\\[\\]]|\\[(?:[^\\[\\]]|\\[[^\\[\\]]*\\])*\\])*(?=\\])|[^\\]]*)\\]`,
    'gu',
  );
}

/** key 필드 중 keep(값)이 거짓인 것을 앞 공백째 지운다 */
function removeFields(line: string, key: string, drop: (value: string) => boolean = () => true): string {
  return line.replace(fieldRe(key), (whole, _ws: string, value: string) => (drop(value) ? '' : whole));
}

function hasField(line: string, key: string): boolean {
  return fieldRe(key).test(line);
}

/** 첫 key 필드 자리를 `[key:: value]` 로 바꾸고(앞 공백은 그대로) 나머지 key 필드는 지운다. 없으면 끝에 붙인다 */
function setField(line: string, key: string, value: string): string {
  let first = true;
  let found = false;
  const out = line.replace(fieldRe(key), (_whole, ws: string) => {
    found = true;
    if (!first) return '';
    first = false;
    return `${ws}[${key}:: ${value}]`;
  });
  return found ? out : appendField(out, key, value);
}

function appendField(line: string, key: string, value: string): string {
  return `${pyRstrip(line)} [${key}:: ${value}]`;
}

const isStDoneValue = (v: string): boolean => v.replace(/\s+/g, '') === '완료';

/**
 * 팀 할 일 줄 고치기(명세 §5 표). 다른 필드·글자는 그대로, 붙일 때는 오른쪽 공백을 떼고 담당 → 기한 → 상태 표식 순서로.
 * **owner 를 지우거나 상태로 바꾸지 않는다** — 개인 apply_status 는 owner 를 지우지만 팀 위키에서 owner 는 담당이다.
 */
export function applyTeamLineChange(line: string, change: TeamLineChange, today: string): string {
  if (!CHECKBOX_RE.test(line)) throw new Error('할 일 줄(- [ ] …)이 아님');
  let out = line;
  if (change.owners !== undefined) {
    const owners = change.owners.map((o) => o.trim()).filter((o) => o !== '');
    out = owners.length === 0 ? removeFields(out, 'owner') : setField(out, 'owner', owners.join(', '));
  }
  if (change.due !== undefined) {
    if (change.due === '') out = removeFields(out, 'due');
    else {
      if (!isValidYmd(change.due)) throw new Error(`기한 형식이 아님(YYYY-MM-DD): ${change.due}`);
      out = setField(out, 'due', change.due);
    }
  }
  if (change.status !== undefined) {
    if (!isValidYmd(today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(today)}`);
    const box = change.status === 'done' ? '- [x]' : '- [ ]';
    out = out.replace(/^- \[[ xX]\]/, () => box);
    if (change.status === 'done') {
      out = removeFields(removeFields(out, 'done'), 'wip');
      out = appendField(out, 'done', today);
    } else if (change.status === 'wip') {
      out = removeFields(removeFields(out, 'done'), 'st', isStDoneValue);
      if (!hasField(out, 'wip')) out = appendField(out, 'wip', today);
    } else {
      out = removeFields(removeFields(removeFields(out, 'done'), 'wip'), 'st', isStDoneValue);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 쓸 수 있는 곳

/** 팀 쓰기 거부 — 파일을 건드리기 전에 던진다 */
export class TeamWriteRefusedError extends Error {
  constructor(rel: string, reason: string) {
    super(`팀 위키에 쓸 수 없는 파일이라 저장하지 않음: ${rel} (${reason})`);
    this.name = 'TeamWriteRefusedError';
  }
}

/**
 * 쓸 수 있는 팀 위키 파일인가(명세 §5): 사본 안의 있는 `.md`, 동기화 제외·숨김 폴더·충돌 사본·템플릿 폴더가 아님,
 * 실제 경로(링크·정션을 푼 것)도 사본 안이고 제외에 걸리지 않음, 파일 자체가 링크가 아님. 통과하면 { abs, rel }.
 */
export function checkTeamWritable(root: string, relPath: string, templateFolder: string | null = readTemplateFolder(root)): { abs: string; rel: string } {
  const rel = safeVaultRelative(relPath);
  if (rel === null) throw new TeamWriteRefusedError(String(relPath), '사본 밖이거나 잘못된 경로');
  if (!rel.toLowerCase().endsWith('.md')) throw new TeamWriteRefusedError(rel, '.md 파일이 아님');
  if (isTeamExcluded(rel, templateFolder)) throw new TeamWriteRefusedError(rel, '동기화 제외·숨김 폴더·충돌 사본·템플릿');
  const rootAbs = path.resolve(root);
  const abs = path.join(rootAbs, ...rel.split('/'));
  if (!isInsideDir(rootAbs, abs)) throw new TeamWriteRefusedError(rel, '사본 밖');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    throw new TeamWriteRefusedError(rel, `파일 없음(${errCode(err)})`);
  }
  if (st.isSymbolicLink()) throw new TeamWriteRefusedError(rel, '링크 파일');
  if (!st.isFile()) throw new TeamWriteRefusedError(rel, '파일이 아님');
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = fs.realpathSync.native(rootAbs);
    realAbs = fs.realpathSync.native(abs);
  } catch (err) {
    throw new TeamWriteRefusedError(rel, `경로를 확인하지 못함(${errCode(err)})`);
  }
  if (!isInsideDir(realRoot, realAbs)) throw new TeamWriteRefusedError(rel, '링크를 따라가면 사본 밖');
  const realRel = toPosix(path.relative(realRoot, realAbs));
  if (isTeamExcluded(realRel, templateFolder)) throw new TeamWriteRefusedError(rel, '링크를 따라가면 제외 폴더 안');
  return { abs: realAbs, rel };
}

// ---------------------------------------------------------------------------
// 쓰기

export interface TeamWritebackInput {
  /** 팀 위키 사본(teamSync.local) */
  root: string;
  /** 백업 폴더(<데이터 폴더>/team-backup) — 사본 밖이어야 한다 */
  backupRoot: string;
  /** done·wip 필드에 쓰는 오늘 */
  today: string;
  /** 백업 폴더 이름의 시각(없으면 지금) */
  now?: Date;
  task: { id: string; file: string; line?: number; rawLine: string };
  change: TeamLineChange;
}

export interface TeamWritebackResult {
  /** 쓴 파일(사본 기준) */
  file: string;
  /** 고치기 전 사본 폴더(절대경로). 쓰지 않았으면 없음 */
  backupDir?: string;
  /** 새 줄 */
  line: string;
  changed: boolean;
  /** 다시 읽은 일 등 알릴 것 */
  warnings: string[];
}

export interface TeamWritebackHooks {
  /** 이름 바꾸기 직전(시험: 이때 파일을 바꿔 재확인을 일으킨다) */
  beforeRename?: (attempt: number) => void;
  sleep?: (ms: number) => void;
  rename?: (from: string, to: string) => void;
}

interface Sig {
  mtimeNs: bigint;
  size: bigint;
}

function sigOf(abs: string): Sig | null {
  try {
    const st = fs.statSync(abs, { bigint: true });
    return { mtimeNs: st.mtimeNs, size: st.size };
  } catch {
    return null;
  }
}

function sameSig(a: Sig | null, b: Sig | null): boolean {
  return !!a && !!b && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {
    // 지우기 실패는 본 오류를 가리지 않는다
  }
}

/** 줄 찾기(명세 §5): ① 그 자리에 원문 그대로 ② 체크박스 줄 중 ID 가 같은 줄이 정확히 하나. 못 찾으면 -1 */
export function findTeamLine(lines: readonly string[], rel: string, task: { id: string; line?: number; rawLine: string }): number {
  if (typeof task.line === 'number' && Number.isInteger(task.line) && task.line >= 1) {
    const i = task.line - 1;
    if (lines[i] === task.rawLine && CHECKBOX_RE.test(lines[i])) return i;
  }
  const hits: number[] = [];
  lines.forEach((ln, i) => {
    if (CHECKBOX_RE.test(ln) && teamTaskId(rel, ln) === task.id) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}

/** 같은 초에 이미 있으면 -2, -3 … */
function newBackupDir(backupRoot: string, stamp: string): string {
  let dir = path.join(backupRoot, stamp);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(backupRoot, `${stamp}-${n}`);
  return dir;
}

function renameWithRetry(tmp: string, abs: string, read: Sig, hooks: TeamWritebackHooks): 'ok' | 'changed' {
  const rename = hooks.rename ?? fs.renameSync;
  const sleep = hooks.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    if (!sameSig(read, sigOf(abs))) return 'changed';
    try {
      rename(tmp, abs);
      return 'ok';
    } catch (err) {
      const code = errCode(err);
      if (attempt < RENAME_RETRY_DELAYS_MS.length && (code === 'EPERM' || code === 'EBUSY' || TRANSIENT_READ_ERRORS.has(code))) {
        sleep(RENAME_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error(`파일을 쓰지 못함(${code}) — 다른 프로그램이 파일을 잡고 있을 수 있음`);
    }
  }
}

/** 팀 위키 줄 하나를 쓴다. 쓸 수 없거나 줄을 못 찾으면 파일을 건드리지 않고 던진다 */
export function applyTeamWriteback(input: TeamWritebackInput, hooks: TeamWritebackHooks = {}): TeamWritebackResult {
  if (!input || typeof input !== 'object') throw new Error('저장 입력이 없음');
  const root = path.resolve(input.root);
  const backupRoot = path.resolve(input.backupRoot);
  if (isInsideDir(root, backupRoot) || path.resolve(root).toLowerCase() === backupRoot.toLowerCase()) {
    throw new Error('팀 위키 백업 폴더가 사본 안이라 저장하지 않음(백업이 NAS 로 올라간다)');
  }
  const { task, change } = input;
  if (!task || typeof task.rawLine !== 'string' || typeof task.id !== 'string' || !task.id.startsWith('t:')) {
    throw new Error('팀 할 일이 아님');
  }
  const templateFolder = readTemplateFolder(root);
  const stamp = backupStamp(input.now ?? new Date());
  const warnings: string[] = [];
  let backupDir: string | undefined;

  for (let attempt = 1; attempt <= TEAM_MAX_WRITE_ATTEMPTS; attempt++) {
    const { abs, rel } = checkTeamWritable(root, task.file, templateFolder);
    const read = sigOf(abs);
    let raw: Buffer;
    try {
      raw = fs.readFileSync(abs);
    } catch (err) {
      throw new Error(`파일을 읽지 못함(${errCode(err)}): ${rel}`);
    }
    if (!read) throw new Error(`파일을 읽지 못함: ${rel}`);
    const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? raw.subarray(3) : raw);
    } catch {
      throw new Error(`UTF-8 로 읽을 수 없는 파일이라 저장하지 않음: ${rel}`);
    }
    const eol = detectEol(text);
    const lines = splitLines(text);
    const idx = findTeamLine(lines, rel, task);
    if (idx < 0) throw new Error(TEAM_LINE_NOT_FOUND);
    const old = lines[idx];
    const next = applyTeamLineChange(old, change, input.today);
    if (next === old) {
      if (backupDir) removeQuietly(backupDir);
      return { file: rel, line: old, changed: false, warnings };
    }
    if (teamCoreOf(next) !== teamCoreOf(old)) throw new Error(`줄을 고치면 할 일 문장이 바뀌어 쓰지 않음: ${rel}`);
    lines[idx] = next;
    let body = lines.join('\n');
    if (eol === '\r\n') body = body.replace(/\n/g, '\r\n');
    const data = bom ? Buffer.concat([BOM, Buffer.from(body, 'utf8')]) : Buffer.from(body, 'utf8');

    // 백업(읽은 바이트 그대로) — 한 저장에 폴더 하나, 다시 읽었으면 이번에 읽은 것으로 바꾼다
    backupDir ??= newBackupDir(backupRoot, stamp);
    try {
      const copy = path.join(backupDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, raw);
    } catch (err) {
      removeQuietly(backupDir);
      throw new Error(`고치기 전 사본을 만들지 못함(${errCode(err)}) — 아무것도 쓰지 않았음`);
    }

    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(4).toString('hex')}${TEAM_TEMP_SUFFIX}`);
    try {
      const fd = fs.openSync(tmp, 'wx');
      try {
        let off = 0;
        while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      removeQuietly(tmp);
      removeQuietly(backupDir);
      throw new Error(`임시 파일을 쓰지 못함(${errCode(err)}): ${rel} — 아무것도 쓰지 않았음`);
    }
    hooks.beforeRename?.(attempt);
    let outcome: 'ok' | 'changed';
    try {
      outcome = renameWithRetry(tmp, abs, read, hooks);
    } catch (err) {
      removeQuietly(tmp);
      removeQuietly(backupDir);
      throw new Error(`${err instanceof Error ? err.message : String(err)}: ${rel} — 아무것도 쓰지 않았음`);
    }
    if (outcome === 'changed') {
      removeQuietly(tmp);
      warnings.push(`저장 직전에 파일이 바뀌어 다시 읽음(${attempt}번째): ${rel}`);
      continue;
    }
    return { file: rel, backupDir, line: next, changed: true, warnings };
  }
  if (backupDir) removeQuietly(backupDir);
  throw new Error(`팀 위키 파일이 계속 바뀌고 있어 저장하지 못함(${TEAM_MAX_WRITE_ATTEMPTS}번 다시 읽음) — 아무것도 쓰지 않았음`);
}

/** 백업 폴더 이름 → 그 시각(로컬). 모양이 아니면 null */
function stampTime(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(name);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** keepDays 일 지난 백업 폴더를 지운다(시작할 때). 지운 수 */
export function pruneTeamBackups(backupRoot: string, now: Date = new Date(), keepDays = TEAM_BACKUP_KEEP_DAYS): number {
  let names: string[];
  try {
    names = fs.readdirSync(backupRoot);
  } catch {
    return 0;
  }
  const limit = now.getTime() - keepDays * 86_400_000;
  let removed = 0;
  for (const name of names) {
    const t = stampTime(name);
    if (t === null || t >= limit) continue;
    try {
      fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
      removed++;
    } catch {
      // 다음 시작 때 다시
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// IPC 입력 검사(명세 §10)

const TEAM_STATUSES: ReadonlySet<string> = new Set(['open', 'wip', 'done']);
export const TEAM_TASK_ID_MAX = 128;
export const TEAM_RAW_LINE_MAX = 4000;
export const TEAM_OWNERS_MAX = 10;
export const TEAM_DOC_PATH_MAX = 1024;

/** radar:saveTeamTask 입력 검사. 틀리면 한국어 문장으로 던진다 */
export function requireSaveTeamTaskInput(value: unknown): SaveTeamTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 요청입니다: 팀 할 일 저장 입력');
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== 'string' || v.taskId.length > TEAM_TASK_ID_MAX || !/^t:[A-Za-z0-9-]+$/.test(v.taskId)) {
    throw new Error('잘못된 요청입니다: taskId');
  }
  if (typeof v.rawLine !== 'string' || v.rawLine.length > TEAM_RAW_LINE_MAX || /[\r\n]/.test(v.rawLine)) {
    throw new Error('잘못된 요청입니다: rawLine');
  }
  const out: SaveTeamTaskInput = { taskId: v.taskId, rawLine: v.rawLine };
  if (v.status !== undefined) {
    if (typeof v.status !== 'string' || !TEAM_STATUSES.has(v.status)) throw new Error('잘못된 요청입니다: status');
    out.status = v.status as TeamTaskStatus;
  }
  if (v.owners !== undefined) {
    if (!Array.isArray(v.owners) || v.owners.length > TEAM_OWNERS_MAX) throw new Error(`담당은 ${TEAM_OWNERS_MAX}명까지입니다`);
    const owners: string[] = [];
    for (const o of v.owners) {
      if (typeof o !== 'string') throw new Error('잘못된 요청입니다: owners');
      const problem = meNameProblem(o);
      if (problem) throw new Error(`담당 「${o.trim().slice(0, 20)}」: ${problem}`);
      owners.push(o.trim());
    }
    out.owners = owners;
  }
  if (v.due !== undefined) {
    if (typeof v.due !== 'string' || (v.due !== '' && !isValidYmd(v.due))) throw new Error('기한은 YYYY-MM-DD 날짜여야 합니다');
    out.due = v.due;
  }
  if (out.status === undefined && out.owners === undefined && out.due === undefined) {
    throw new Error('잘못된 요청입니다: 바꿀 것이 없습니다');
  }
  return out;
}

/**
 * radar:openTeamDoc 경로 검사: 사본 기준 상대경로 1024자 이하, .md, 사본 안·제외 아님. 통과하면 절대경로.
 * 없는 파일이면 던진다(Obsidian 이 빈 문서를 만들지 않게).
 */
export function requireTeamDocPath(root: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEAM_DOC_PATH_MAX) throw new Error('잘못된 요청입니다: 문서 경로');
  return checkTeamWritable(root, value).abs;
}
