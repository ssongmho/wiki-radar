// VOC·팀 위키 할 일과 개인 위키 잇기(2.6단계 명세 · 2.9단계 명세 §3). electron 을 import 하지 않는 모듈이다.
// ① 파일 스냅샷에 내 담당 VOC 할 일을 합친다(§5). VOC 보드가 새로 오면 위키 파일을 다시 읽지 않고 VOC 할 일만 바꿔
//    구간·건수·주간 트랙을 다시 매긴다. 구간 규칙은 snapshot.ts 와 같다(buckets.ts·calendar.ts) — 다만 VOC 할 일은
//    재촉 구간에 넣지 않는다(§5 "재촉(chased)은 없다").
// ② VOC 고객사·시스템 이름 → 위키 문서 표(§2-1, link_raw.py 매핑 + wiki/ 아래 문서 이름).
import fs from 'node:fs';
import path from 'node:path';
import type { Holiday, Snapshot, Task, TaskStatus, VocBoard } from '../../shared/types';
import { bucketOf, orderTasks, overdueDaysOf } from './buckets';
import { BusinessCalendar, addDays, buildWeekInfo, isValidYmd, mondayOf } from './calendar';
import { errCode, readTextFile, walkMarkdown } from './fsutil';
import { emptyMappings, parseLinkRaw, type LinkMappings } from './mappings';
import { WIKI_PATHS } from './snapshot';

export interface MergeOptions {
  /** 오늘(YYYY-MM-DD, 로컬). 보통 base 를 만든 날(base.week.today) */
  today: string;
  holidays: readonly Holiday[];
}

/** 스냅샷에 들어가는 상태(열린 것만 — snapshot.ts 와 같다) */
const OPEN_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['open', 'wip']);

/**
 * 구간·지난 영업일 수를 다시 매긴 사본. snapshot.ts 와 같은 순서(지난 영업일 수를 먼저 세고 → 구간).
 * VOC 할 일은 재촉 수·우선순위로 재촉 구간에 가지 않는다 — 기한·열린 영업일만 본다.
 */
function withBucket(task: Task, today: string, friday: string, cal: BusinessCalendar): Task {
  const out: Task = { ...task };
  delete out.overdueDays;
  const overdueDays = out.due !== undefined && out.due < today ? overdueDaysOf(out.due, today, cal) : undefined;
  const input =
    out.source === 'voc'
      ? { due: out.due, openDays: out.openDays, overdueDays }
      : { ...out, overdueDays };
  out.bucket = bucketOf(input, today, friday);
  if (overdueDays !== undefined) out.overdueDays = overdueDays;
  return out;
}

/** 합칠 VOC 할 일 하나를 다듬는다. 스냅샷에 넣을 수 없으면 null */
function cleanVocTask(task: Task): Task | null {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || task.id === '') return null;
  if (!OPEN_STATUSES.has(task.status)) return null;
  const out: Task = { ...task, source: 'voc' };
  // 날짜 형식이 아닌 기한은 버린다(영업일 계산이 던지지 않게 — snapshot.ts 도 형식이 아닌 날짜는 무시한다)
  if (out.due !== undefined && !isValidYmd(out.due)) delete out.due;
  delete out.chaseCount;
  return out;
}

/** 합칠 팀 위키 할 일 하나를 다듬는다(2.9단계 §3 — 구간 규칙은 체크박스와 같다). 넣을 수 없으면 null */
function cleanTeamTask(task: Task): Task | null {
  if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !task.id.startsWith('t:')) return null;
  if (!OPEN_STATUSES.has(task.status)) return null;
  const out: Task = { ...task, source: 'team' };
  if (out.due !== undefined && !isValidYmd(out.due)) delete out.due;
  return out;
}

/** 파일 스냅샷에 더할 할 일(내 담당 VOC 할 일 · 팀 위키 내 것) */
export interface ExtraTasks {
  voc?: readonly Task[];
  team?: readonly Task[];
}

/**
 * base(파일 스냅샷)의 VOC·팀 할 일을 빼고 extra 의 VOC·팀 할 일을 넣은 뒤 구간·순서·counts·주간 트랙을 다시 매긴다.
 * base 의 큐레이션·체크박스 항목은 그대로 둔다(같은 날이면 같은 객체) — 날짜가 base 와 다르면 그것들도 오늘 기준으로
 * 구간을 다시 매긴다. 같은 ID 의 할 일이 둘이면 처음 것만, base 항목과 ID 가 같으면 넣지 않는다.
 * VOC 할 일은 재촉 구간에 가지 않고(2.6단계 §5), 팀 할 일은 체크박스와 같은 구간 규칙이다(2.9단계 §3).
 * 파일은 다시 읽지 않는다. base·extra 는 고치지 않는다.
 */
export function mergeExtraTasks(base: Snapshot, extra: ExtraTasks, opts: MergeOptions): Snapshot {
  const { today } = opts;
  if (!isValidYmd(today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(today)}`);
  const cal = new BusinessCalendar(Array.isArray(opts.holidays) ? opts.holidays : []);
  const friday = addDays(mondayOf(today), 4);
  const sameDay = base.week.today === today;

  const all: Task[] = [];
  const ids = new Set<string>();
  for (const task of base.tasks) {
    if (task.source === 'voc' || task.source === 'team') continue;
    all.push(sameDay ? task : withBucket(task, today, friday, cal));
    ids.add(task.id);
  }
  const add = (list: readonly Task[] | undefined, clean: (t: Task) => Task | null): void => {
    for (const raw of Array.isArray(list) ? list : []) {
      const task = clean(raw);
      if (!task || ids.has(task.id)) continue;
      ids.add(task.id);
      all.push(withBucket(task, today, friday, cal));
    }
  };
  add(extra.voc, cleanVocTask);
  add(extra.team, cleanTeamTask);

  const { tasks, counts } = orderTasks(all);
  const week = buildWeekInfo(today, cal, tasks, counts.overdue);
  return { ...base, week, tasks, counts, warnings: [...base.warnings] };
}

/** VOC 할 일만 합친다(2.6단계 — mergeExtraTasks 의 VOC 몫) */
export function mergeVocTasks(base: Snapshot, vocTasks: Task[], opts: MergeOptions): Snapshot {
  return mergeExtraTasks(base, { voc: vocTasks }, opts);
}

/**
 * 개인 위키가 없을 때의 빈 개인 스냅샷(2.9단계 §3): 할 일 없음, 주간 트랙은 오늘 기준, 문서 0개, personalMissing.
 * 팀 동기화가 켜져 있을 때만 쓴다 — 팀 것(과 내 VOC)을 여기에 합친다.
 */
export function emptyPersonalSnapshot(opts: { today: string; holidays: readonly Holiday[]; wikiRoot: string; now?: Date }): Snapshot {
  const { today } = opts;
  if (!isValidYmd(today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(today)}`);
  const cal = new BusinessCalendar(Array.isArray(opts.holidays) ? [...opts.holidays] : []);
  const counts = { overdue: 0, thisWeek: 0, chased: 0, stale: 0, other: 0 };
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    wikiRoot: opts.wikiRoot,
    week: buildWeekInfo(today, cal, [], 0),
    tasks: [],
    counts,
    pageCount: 0,
    warnings: [],
    partial: false,
    personalMissing: true,
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * VOC 를 새로 받지 못하고 있을 때(로그인 필요·서버 문제·stale 등) 스냅샷 경고에 넣을 문장 — "VOC 할 일은 10:32 기준".
 * 받은 날이 오늘이 아니면 날짜도 붙인다("9/27 10:32 기준"). 새로 받고 있거나(ok·loading), 한 번도 받지 못했거나,
 * 남겨 둔 VOC 할 일이 없으면 undefined.
 */
export function vocStaleNote(
  board: Pick<VocBoard, 'state' | 'fetchedAt'>,
  taskCount: number,
  today: string,
): string | undefined {
  if (board.state === 'ok' || board.state === 'loading') return undefined;
  if (taskCount <= 0 || !board.fetchedAt) return undefined;
  const t = Date.parse(board.fetchedAt);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  const ymd = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const when = ymd === today ? clock : `${d.getMonth() + 1}/${d.getDate()} ${clock}`;
  return `VOC 할 일은 ${when} 기준`;
}

// ---------------------------------------------------------------------------
// VOC 고객사·시스템 → 위키 문서

/** VOC 고객사·시스템 이름 → 위키 문서를 찾는 표. voc/model.ts 의 VocPageMaps 와 같은 모양이다 */
export interface VocWikiPages {
  /** link_raw.py CUST_PAGE: VOC customer → 위키 페이지명 */
  custPage: ReadonlyMap<string, string>;
  /** link_raw.py SYSTEM_PAGE: 시스템명 → 위키 페이지명 */
  systemPage: ReadonlyMap<string, string>;
  /** 페이지명(파일 이름에서 .md 뺀 것) → 볼트 기준 경로(wiki/ 아래 전부). 이름이 겹치면 경로 이름순 처음 것 */
  pageIndex: ReadonlyMap<string, string>;
}

/** 위키 문서 폴더(볼트 기준) */
const WIKI_PAGES_DIR = 'wiki';

/**
 * link_raw.py 의 CUST_PAGE·SYSTEM_PAGE 와 wiki/ 아래 .md 이름 색인을 읽는다(파이썬은 실행하지 않는다).
 * 없는 파일·폴더는 빈 표로, 그 밖의 읽기 문제는 warn 으로 알리고 읽은 만큼만 쓴다(링크만 빠진다).
 */
export function loadVocWikiPages(wikiRoot: string, warn: (message: string) => void = () => undefined): VocWikiPages {
  const root = path.resolve(wikiRoot);
  let maps: LinkMappings = emptyMappings();
  try {
    maps = parseLinkRaw(readTextFile(path.join(root, ...WIKI_PATHS.linkRaw.split('/'))));
  } catch (err) {
    const code = errCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') warn(`VOC 문서 연결용 ${WIKI_PATHS.linkRaw} 을 읽지 못함(${code})`);
  }

  const pageIndex = new Map<string, string>();
  const pagesDir = path.join(root, WIKI_PAGES_DIR);
  if (fs.existsSync(pagesDir)) {
    const walk = walkMarkdown(pagesDir);
    for (const e of walk.errors) warn(`VOC 문서 연결: ${WIKI_PAGES_DIR}/ ${e}`);
    for (const rel of walk.files) {
      const name = path.posix.basename(rel).replace(/\.md$/i, '');
      if (name && !pageIndex.has(name)) pageIndex.set(name, `${WIKI_PAGES_DIR}/${rel}`);
    }
  }
  return { custPage: maps.custPage, systemPage: maps.systemPage, pageIndex };
}
