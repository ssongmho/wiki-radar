// 팀 위키 사본 → 팀 할 일(2.9단계 명세 §3). electron 을 import 하지 않는 순수 모듈이다(vitest 로 바로 시험한다).
//
// - 줄 문법은 개인 위키 1단계 규칙 그대로(새 문법을 만들지 않는다 — CLAUDE.md 규칙 6): 줄 머리 `- [ ] `, 필드 `[키:: 값]`,
//   표시 제목·핵심문구. 다만 팀 위키에서는 **모든** 체크박스 줄이 할 일이고(`#내할일` 태그 필요 없음),
//   `owner` 는 "내 일 아님"이 아니라 "담당"이다 — 상태에 영향이 없다(teamLineStatus).
// - ID 는 체크박스 `c:` 와 같은 방식에 머리만 `t:`(sha1(파일 + '|' + 핵심문구) 앞 12자).
// - 빼는 파일: 동기화 제외(isSynced 거짓) · `.` 로 시작하는 폴더 아래 · 충돌 사본 · Obsidian 템플릿 폴더 · 링크(따라가지 않음).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Holiday, MeSource, Task, TaskStatus, TeamLane, TeamTaskBoard } from '../../shared/types';
import { isMine, normName, ownersOf } from '../../shared/team';
import { isSynced } from '../teamSync/engine';
import { bucketOf, orderTasks, overdueDaysOf } from './buckets';
import { BusinessCalendar, addDays, isValidYmd, mondayOf } from './calendar';
import { CHECKBOX_RE, displayTitle, isStDone, parseFields, teamCoreOf, type LineFields } from './checkbox';
import { RetryBudget, errCode, readTextFile, splitLines, walkMarkdown } from './fsutil';
import { READ_RETRY_BUDGET_MS } from './snapshot';

/** 충돌 사본 이름(2.8단계 conflictName 의 모양): `문서 (충돌 홍길동 09-22 1530).md` */
export const TEAM_CONFLICT_RE = / \(충돌 [^()]+ \d{2}-\d{2} \d{4}\)\.md$/;

/** Obsidian 템플릿 설정 파일(사본 기준) */
export const TEAM_TEMPLATES_FILE = '.obsidian/templates.json';

const DONE_MARK_RE = /^- \[[xX]\]/;

/**
 * 팀 위키 줄의 상태: `- [x]` → done, `[st:: 완료]`(공백 무시) → done, `[wip::]` → wip, 그 밖 → open.
 * **owner 는 상태에 영향이 없다**(개인 lineStatus 는 owner 가 있으면 notmine — 팀 위키에서 owner 는 담당이다).
 */
export function teamLineStatus(line: string, fields: LineFields = parseFields(line, true)): Exclude<TaskStatus, 'notmine'> {
  if (DONE_MARK_RE.test(line)) return 'done';
  if (isStDone(fields.st)) return 'done';
  if (fields.hasWip) return 'wip';
  return 'open';
}

/** 팀 할 일 ID: 't:' + sha1(파일 + '|' + 핵심문구) 앞 12자 */
export function teamTaskId(file: string, line: string): string {
  return 't:' + createHash('sha1').update(`${file}|${teamCoreOf(line)}`, 'utf8').digest('hex').slice(0, 12);
}

/** 문서 이름: 파일 이름에서 .md 뺀 것 */
export function teamDocName(rel: string): string {
  return path.posix.basename(rel).replace(/\.md$/i, '');
}

/**
 * `.obsidian/templates.json` 의 folder(사본 기준 '/' 경로, 앞뒤 '/' 뗌). 없거나 읽지 못하거나 모양이 틀리면 null.
 * Obsidian 은 사람이 적은 그대로 둔다(`templates/`·`/templates` 도 같은 폴더).
 */
export function readTemplateFolder(root: string): string | null {
  let text: string;
  try {
    text = readTextFile(path.join(root, ...TEAM_TEMPLATES_FILE.split('/')));
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    const folder = raw && typeof raw === 'object' ? (raw as { folder?: unknown }).folder : undefined;
    if (typeof folder !== 'string') return null;
    const norm = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    return norm === '' || norm === '.' ? null : norm;
  } catch {
    return null;
  }
}

/** 폴더 이름 하나가 팀 할 일 읽기에서 빠지는가(`.` 로 시작 — `.obsidian`·`.휴지통`·`.trash`·`.git` — 또는 동기화 제외 폴더) */
export function isTeamSkippedDir(name: string): boolean {
  return name.startsWith('.') || !isSynced(`${name}/x.md`);
}

/**
 * 팀 할 일 읽기·쓰기에서 빼는 파일인가(사본 기준 '/' 상대경로). 명세 §3 의 제외 1~4:
 * 동기화 제외 · `.` 로 시작하는 폴더 아래 · 충돌 사본 · 템플릿 폴더 아래.
 */
export function isTeamExcluded(rel: string, templateFolder: string | null): boolean {
  if (!isSynced(rel)) return true;
  const segs = rel.split('/');
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => s.startsWith('.'))) return true;
  if (TEAM_CONFLICT_RE.test(rel)) return true;
  if (templateFolder) {
    const key = (s: string) => s.normalize('NFC').toLowerCase();
    const t = key(templateFolder);
    if (key(rel).startsWith(`${t}/`)) return true;
  }
  return false;
}

export interface TeamReadOptions {
  /** 팀 위키 사본(teamSync.local) 절대경로 */
  root: string;
  /** 오늘(YYYY-MM-DD, 로컬) */
  today: string;
  holidays: readonly Holiday[];
  /** 나의 이름들(설정 이름 또는 VOC 이름 + 다른 표기) */
  names: readonly string[];
}

export interface TeamReadResult {
  /** 열린 팀 할 일 전부(구간 순서) */
  tasks: Task[];
  warnings: string[];
  partial: boolean;
  /** 읽은 .md 수 */
  fileCount: number;
}

/** 팀 사본의 열린 할 일을 읽는다. 사본 폴더가 없으면 던진다(부르는 쪽이 missing 으로 본다) */
export function readTeamTasks(opts: TeamReadOptions): TeamReadResult {
  const { today } = opts;
  if (!isValidYmd(today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(today)}`);
  const root = path.resolve(opts.root);
  let st: fs.Stats | null;
  try {
    st = fs.statSync(root);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw new Error(`팀 위키 사본 폴더를 찾을 수 없음: ${opts.root}`);

  const warnings: string[] = [];
  const cal = new BusinessCalendar(Array.isArray(opts.holidays) ? opts.holidays : []);
  const friday = addDays(mondayOf(today), 4);
  const budget = new RetryBudget(READ_RETRY_BUDGET_MS);
  const templateFolder = readTemplateFolder(root);

  const walk = walkMarkdown(root, { skipDir: (name) => isTeamSkippedDir(name) });
  warnings.push(...walk.errors);
  const files = walk.files.filter((rel) => !isTeamExcluded(rel, templateFolder));
  let unreadable = 0;

  const found: Task[] = [];
  for (const rel of files) {
    let text: string;
    try {
      text = readTextFile(path.join(root, ...rel.split('/')), { budget });
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue; // 그사이 동기화가 옮김
      warnings.push(`파일을 읽지 못함: ${rel} (${code}) — 이 파일의 할 일은 목록에 없음, 잠시 뒤 다시 읽음`);
      unreadable++;
      continue;
    }
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CHECKBOX_RE.test(line)) continue;
      const fields = parseFields(line, true);
      const status = teamLineStatus(line, fields);
      if (status === 'done') continue;
      let title = displayTitle(line, true);
      if (!title) {
        title = '(제목 없음)';
        warnings.push(`제목이 빈 할 일: ${rel}:${i + 1}`);
      }
      const owners = ownersOf(fields.owner);
      const task: Task = {
        id: teamTaskId(rel, line),
        source: 'team',
        title,
        status,
        file: rel,
        line: i + 1,
        rawLine: line,
        bucket: 'other',
        team: { file: rel, doc: teamDocName(rel), owners, mine: isMine(owners, opts.names) },
      };
      if (fields.due !== undefined) task.due = fields.due;
      if (fields.pri !== undefined) task.pri = fields.pri;
      if (fields.mail !== undefined) task.mail = fields.mail;
      if (fields.opened !== undefined) task.opened = fields.opened;
      if (fields.openDays !== undefined) task.openDays = fields.openDays;
      if (fields.chaseCount !== undefined) task.chaseCount = fields.chaseCount;
      if (fields.thread !== undefined) task.thread = fields.thread;
      if (fields.st !== undefined) task.st = fields.st;
      found.push(task);
    }
  }

  const usedIds = new Map<string, number>();
  for (const task of found) {
    const overdueDays = task.due !== undefined && task.due < today ? overdueDaysOf(task.due, today, cal) : undefined;
    task.bucket = bucketOf({ ...task, overdueDays }, today, friday);
    if (overdueDays !== undefined) task.overdueDays = overdueDays;
    const seen = usedIds.get(task.id) ?? 0;
    usedIds.set(task.id, seen + 1);
    if (seen > 0) {
      warnings.push(`같은 ID 의 할 일이 여럿: ${task.title} (${task.file})`);
      task.id = `${task.id}-${seen + 1}`;
    }
  }
  const { tasks } = orderTasks(found);
  return { tasks, warnings, partial: walk.errors.length > 0 || unreadable > 0, fileCount: files.length };
}

/** 이름 정렬(가나다순) */
const collator = new Intl.Collator('ko');

/**
 * 읽은 팀 할 일 → 보드(칸·합계). 담당이 여럿이면 담당마다의 칸에 다 들어가고(나도 그중이면 나 칸에도),
 * 나의 이름들에 걸리는 담당은 따로 칸을 만들지 않는다. 미배정·나 칸은 0건이어도 늘 있다.
 * 다른 담당 칸의 이름은 그 담당이 처음 나온 줄의 표기.
 */
export function buildTeamBoard(
  read: TeamReadResult,
  me: { names: string[]; source: MeSource },
  generatedAt: string,
): TeamTaskBoard {
  const mineKeys = new Set(me.names.map(normName).filter((n) => n !== ''));
  const unassigned: TeamLane = { key: 'unassigned', label: '미배정', taskIds: [], overdue: 0, thisWeek: 0 };
  const mine: TeamLane = { key: 'me', label: '나', me: true, taskIds: [], overdue: 0, thisWeek: 0 };
  const others = new Map<string, TeamLane>();
  const add = (lane: TeamLane, task: Task): void => {
    if (lane.taskIds.includes(task.id)) return;
    lane.taskIds.push(task.id);
    if (task.bucket === 'overdue') lane.overdue++;
    if (task.bucket === 'thisWeek') lane.thisWeek++;
  };
  const totals = { open: 0, unassigned: 0, mine: 0, overdue: 0, thisWeek: 0 };
  const tasks = read.tasks.map((t) => {
    const owners = t.team?.owners ?? [];
    return t.team ? { ...t, team: { ...t.team, mine: owners.some((o) => mineKeys.has(normName(o))) } } : t;
  });
  for (const task of tasks) {
    totals.open++;
    if (task.bucket === 'overdue') totals.overdue++;
    if (task.bucket === 'thisWeek') totals.thisWeek++;
    const owners = task.team?.owners ?? [];
    if (owners.length === 0) {
      totals.unassigned++;
      add(unassigned, task);
      continue;
    }
    if (task.team?.mine) totals.mine++;
    for (const owner of owners) {
      const key = normName(owner);
      if (key === '') continue;
      if (mineKeys.has(key)) {
        add(mine, task);
        continue;
      }
      let lane = others.get(key);
      if (!lane) {
        lane = { key: `owner:${key}`, label: owner, taskIds: [], overdue: 0, thisWeek: 0 };
        others.set(key, lane);
      }
      add(lane, task);
    }
  }
  const sorted = [...others.values()].sort((a, b) => collator.compare(a.label, b.label));
  return {
    state: 'ok',
    generatedAt,
    me: { names: [...me.names], source: me.source },
    tasks,
    lanes: [unassigned, mine, ...sorted],
    totals,
    warnings: [...read.warnings],
    partial: read.partial,
  };
}

/** 상태가 off·missing·error 인 빈 보드 */
export function emptyTeamBoard(
  state: 'off' | 'missing' | 'error',
  me: { names: string[]; source: MeSource },
  message?: string,
): TeamTaskBoard {
  const board: TeamTaskBoard = {
    state,
    me: { names: [...me.names], source: me.source },
    tasks: [],
    lanes: [],
    totals: { open: 0, unassigned: 0, mine: 0, overdue: 0, thisWeek: 0 },
    warnings: [],
    partial: false,
  };
  if (message) board.message = message;
  return board;
}
