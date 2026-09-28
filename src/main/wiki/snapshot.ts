// 위키 → 스냅샷. electron 을 import 하지 않는 순수 모듈이다(vitest 로 바로 시험한다).
// 계약: docs/stage1-contract.md
import fs from 'node:fs';
import path from 'node:path';
import type { Holiday, Snapshot, Task, TaskStatus } from '../../shared/types';
import { bucketOf, orderTasks, overdueDaysOf } from './buckets';
import { BusinessCalendar, addDays, buildWeekInfo, holidayTableWarning, isValidYmd, mondayOf } from './calendar';
import {
  ANCHOR_LINE_RE,
  CHECKBOX_RE,
  checkboxId,
  checkboxSyncTitle,
  curatedId,
  displayTitle,
  hasMyTaskTag,
  lineStatus,
  parseFields,
  type LineFields,
} from './checkbox';
import { entityNameOf, resolveCompany } from './company';
import { lookupLogStatus, parseItemsJson, parseLogSections, parseMemos, type CuratedItem } from './curated';
import { RetryBudget, errCode, readTextFile, safeVaultRelative, splitLines, walkMarkdown } from './fsutil';
import { emptyMappings, parseLinkRaw, type LinkMappings } from './mappings';

export interface BuildOptions {
  /** 마스터 볼트 절대경로 (예: %USERPROFILE%\OneDrive\Obsidian\WIKI) */
  wikiRoot: string;
  /** 오늘 날짜 YYYY-MM-DD (로컬 기준) */
  today: string;
  holidays: Holiday[];
}

/** 한 스냅샷을 만들면서 잠긴 파일 재시도에 기다릴 수 있는 총 시간(ms) */
export const READ_RETRY_BUDGET_MS = 1_500;

/** 볼트 안에서 쓰는 고정 경로 */
export const WIKI_PATHS = {
  items: '_todo-sync/items.json',
  myTasks: '_private/mgmt/내 할 일.md',
  memos: '_private/mgmt/할 일 메모.md',
  contracts: '_private/business/계약관리시스템.md',
  linkRaw: '_raw-link/link_raw.py',
} as const;

/** 모든 체크박스를 보는 파일인가(그 밖의 파일은 `#내할일` 태그가 있는 줄만) */
export function isTargetFile(rel: string): boolean {
  return rel === WIKI_PATHS.myTasks || rel === WIKI_PATHS.contracts || entityNameOf(rel) !== null;
}

/**
 * 파일을 한 번만 읽도록 줄 목록을 기억한다. 없는 파일은 조용히 null.
 * 읽기 오류는 잠깐 재시도한 뒤에도 실패하면 경고로 남기고 unreadable 에 적는다(스냅샷이 partial 이 된다).
 */
class VaultReader {
  private readonly cache = new Map<string, string[] | null>();
  private readonly budget = new RetryBudget(READ_RETRY_BUDGET_MS);
  /** 재시도 뒤에도 읽지 못한 파일(볼트 기준 상대경로) */
  readonly unreadable: string[] = [];

  constructor(
    private readonly root: string,
    private readonly warnings: string[],
  ) {}

  private abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  text(rel: string): string | null {
    try {
      return readTextFile(this.abs(rel), { budget: this.budget });
    } catch (err) {
      const code = errCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.warnings.push(`파일을 읽지 못함: ${rel} (${code}) — 이 파일의 할 일은 목록에 없음, 잠시 뒤 다시 읽음`);
        this.unreadable.push(rel);
      }
      return null;
    }
  }

  lines(rel: string): string[] | null {
    const hit = this.cache.get(rel);
    if (hit !== undefined) return hit;
    const text = this.text(rel);
    const lines = text === null ? null : splitLines(text);
    this.cache.set(rel, lines);
    return lines;
  }

  isFile(rel: string): boolean {
    if (this.cache.get(rel)) return true;
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }
}

interface LinkedLine {
  file: string;
  lineNo: number;
  text: string;
  fields: LineFields;
  status: TaskStatus;
}

/** 줄의 필드로 할 일을 채운다(due 는 호출하는 쪽이 정한다). */
function applyLineFields(task: Task, f: LineFields): void {
  if (f.pri !== undefined) task.pri = f.pri;
  if (f.mail !== undefined) task.mail = f.mail;
  if (f.opened !== undefined) task.opened = f.opened;
  if (f.openDays !== undefined) task.openDays = f.openDays;
  if (f.chaseCount !== undefined) task.chaseCount = f.chaseCount;
  if (f.thread !== undefined) task.thread = f.thread;
  if (f.st !== undefined) task.st = f.st;
}

export function buildSnapshot(opts: BuildOptions): Snapshot {
  const { today } = opts;
  if (!isValidYmd(today)) throw new Error(`오늘 날짜 형식이 아님(YYYY-MM-DD): ${String(today)}`);
  const root = path.resolve(opts.wikiRoot);
  let rootStat: fs.Stats | null;
  try {
    rootStat = fs.statSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`위키 폴더를 찾을 수 없음: ${opts.wikiRoot}`);

  const warnings: string[] = [];
  const cal = new BusinessCalendar(Array.isArray(opts.holidays) ? opts.holidays : []);
  const friday = addDays(mondayOf(today), 4);
  const reader = new VaultReader(root, warnings);

  // ---- 볼트 훑기(제외 폴더는 내려가기 전에 잘라낸다)
  const walk = walkMarkdown(root);
  warnings.push(...walk.errors);
  const entityNames = new Set<string>();
  for (const rel of walk.files) {
    const name = entityNameOf(rel);
    if (name) entityNames.add(name);
  }

  // ---- 매핑 표·큐레이션·로그·메모
  const linkRawText = reader.text(WIKI_PATHS.linkRaw);
  const maps: LinkMappings = linkRawText === null ? emptyMappings() : parseLinkRaw(linkRawText);

  let items: CuratedItem[] = [];
  const itemsText = reader.text(WIKI_PATHS.items);
  if (itemsText === null) {
    warnings.push('items.json 이 없음 — 큐레이션 항목 없이 계속함');
  } else {
    const parsed = parseItemsJson(itemsText);
    items = parsed.items;
    warnings.push(...parsed.warnings);
  }

  const logs = parseLogSections(reader.lines(WIKI_PATHS.myTasks) ?? []);
  const memos = parseMemos(reader.lines(WIKI_PATHS.memos) ?? []);

  // 앵커 경로를 훑은 파일의 표기로 맞추기 위한 색인(Windows 는 대소문자를, 맥 동기화본은 NFC/NFD 를 가리지 않는다)
  const fileKey = (rel: string) => rel.normalize('NFC').toLowerCase();
  const walkedByKey = new Map<string, string>();
  for (const rel of walk.files) walkedByKey.set(fileKey(rel), rel);

  /** 앵커 파일 경로 해석: 그대로 → 없으면 '.md' 를 붙여 본다(Obsidian 식 표기). 볼트 밖이면 null */
  const resolveAnchorFile = (f: string): string | null => {
    const p = safeVaultRelative(f);
    if (p === null) return null;
    const withMd = p.toLowerCase().endsWith('.md') ? null : `${p}.md`;
    const walked = walkedByKey.get(fileKey(p)) ?? (withMd ? walkedByKey.get(fileKey(withMd)) : undefined);
    if (walked) return walked;
    // 제외 폴더 안의 파일 등 훑지 않은 곳은 디스크에서 직접 확인
    if (reader.isFile(p)) return p;
    if (withMd && reader.isFile(withMd)) return withMd;
    return p;
  };

  // 어떤 큐레이션 항목의 앵커에 걸린 줄은 체크박스 항목으로 만들지 않는다(상태와 무관).
  const anchoredMatches = new Map<string, string[]>();
  const resolvedAnchors = new Map<CuratedItem, (string | null)[]>();
  for (const item of items) {
    const files = item.a.map((a) => resolveAnchorFile(a.f));
    resolvedAnchors.set(item, files);
    item.a.forEach((a, i) => {
      const file = files[i];
      if (file === null) return;
      const list = anchoredMatches.get(file) ?? [];
      list.push(a.m);
      anchoredMatches.set(file, list);
    });
  }

  const found: Task[] = [];

  // ---- 1-1. 큐레이션 항목
  for (const item of items) {
    const task: Task = {
      id: curatedId(item.t),
      source: 'curated',
      title: item.t,
      status: 'open',
      bucket: 'other',
    };
    if (item.g !== undefined) task.group = item.g;
    if (item.k !== undefined) task.kind = item.k;
    if (item.risk !== undefined) task.risk = item.risk;
    if (item.why !== undefined) task.why = item.why;
    if (item.who !== undefined) task.who = item.who;
    if (item.src !== undefined) task.src = item.src;
    if (item.due !== undefined) task.due = item.due;

    if (item.a.length > 0) {
      task.anchors = item.a.map((a) => ({ file: a.f, match: a.m }));
      const files = resolvedAnchors.get(item) ?? [];
      let first: LinkedLine | null = null;
      let winner: LinkedLine | null = null;
      for (let i = 0; i < item.a.length; i++) {
        const a = item.a[i];
        const file = files[i];
        const lines = file === null ? null : reader.lines(file);
        const idx = lines ? lines.findIndex((l) => ANCHOR_LINE_RE.test(l) && l.includes(a.m)) : -1;
        if (file === null || lines === null || idx < 0) {
          warnings.push(`앵커를 찾지 못함: ${item.t} (${a.f} / ${a.m})`);
          continue;
        }
        const text = lines[idx];
        const fields = parseFields(text);
        const hit: LinkedLine = { file, lineNo: idx + 1, text, fields, status: lineStatus(text, fields) };
        if (!first) first = hit;
        if (!winner && hit.status !== 'open') winner = hit;
      }
      const linked = winner ?? first;
      if (linked) {
        const { file, lineNo, text, fields, status } = linked;
        task.status = status;
        task.file = file;
        task.line = lineNo;
        task.rawLine = text;
        if (status === 'notmine' && fields.owner) task.owner = fields.owner;
        // due 는 줄의 값이 있으면 줄의 값, 없으면 items.json 값
        if (fields.due !== undefined) task.due = fields.due;
        applyLineFields(task, fields);
      }
    } else {
      const log = lookupLogStatus(logs, item.t);
      if (log) {
        task.status = log.status;
        if (log.owner) task.owner = log.owner;
      }
    }
    if (item.g === 'done') task.status = 'done';

    const company = resolveCompany({ file: task.file, mail: task.mail, src: task.src }, maps, entityNames);
    if (company) task.company = company;
    found.push(task);
  }

  // ---- 1-2. 체크박스 항목
  for (const rel of walk.files) {
    const lines = reader.lines(rel);
    if (!lines) continue;
    const target = isTargetFile(rel);
    const suppress = anchoredMatches.get(rel);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (!CHECKBOX_RE.test(text)) continue;
      if (!target && !hasMyTaskTag(text)) continue;
      if (suppress && suppress.some((m) => text.includes(m))) continue;
      const fields = parseFields(text);
      const status = lineStatus(text, fields);
      if (status === 'done' || status === 'notmine') continue;
      let title = displayTitle(text);
      if (!title) {
        title = '(제목 없음)';
        warnings.push(`제목이 빈 할 일: ${rel}:${i + 1}`);
      }
      const task: Task = {
        id: checkboxId(rel, text),
        source: 'checkbox',
        title,
        status,
        file: rel,
        line: i + 1,
        rawLine: text,
        bucket: 'other',
      };
      if (fields.due !== undefined) task.due = fields.due;
      applyLineFields(task, fields);
      const company = resolveCompany({ file: rel, mail: task.mail }, maps, entityNames);
      if (company) task.company = company;
      found.push(task);
    }
  }

  // ---- 열린 것만. 메모·구간·ID 중복 정리
  const open: Task[] = [];
  const usedIds = new Map<string, number>();
  for (const task of found) {
    if (task.status !== 'open' && task.status !== 'wip') continue;
    // 체크박스 항목의 메모는 두 이름으로 찾는다(2단계 명세 §5): ① sync_todo 제목(핵심문구 70자 규칙 — 저장은 항상 이 이름)
    // ② 표시 제목. 기존 아티팩트가 쓴 메모도 ① 로 쌓여 있다.
    const syncTitle = task.source === 'checkbox' && task.rawLine !== undefined ? checkboxSyncTitle(task.rawLine) : '';
    const memo = (syncTitle ? memos.get(syncTitle) : undefined) ?? memos.get(task.title);
    if (memo) task.memo = memo;
    // 기한이 지났으면 지난 영업일 수를 먼저 센다 — 30영업일을 넘게 밀린 것은 지남이 아니라 정리 대상(2단계 명세 §4)
    const overdueDays = task.due !== undefined && task.due < today ? overdueDaysOf(task.due, today, cal) : undefined;
    task.bucket = bucketOf({ ...task, overdueDays }, today, friday);
    if (overdueDays !== undefined) task.overdueDays = overdueDays;
    const seen = usedIds.get(task.id) ?? 0;
    usedIds.set(task.id, seen + 1);
    if (seen > 0) {
      // 같은 파일에 같은 문장의 열린 줄이 둘 이상이거나, items.json 에 같은 제목이 둘 이상인 경우
      warnings.push(`같은 ID 의 할 일이 여럿: ${task.title} (${task.file ?? '큐레이션'})`);
      task.id = `${task.id}-${seen + 1}`;
    }
    open.push(task);
  }

  const { tasks, counts } = orderTasks(open);
  const week = buildWeekInfo(today, cal, tasks, counts.overdue);

  // 공휴일 표가 곧 끝나면 알린다(표 밖의 날은 소리 없이 영업일로 계산되므로).
  const tableWarning = holidayTableWarning(Array.isArray(opts.holidays) ? opts.holidays : [], today);
  if (tableWarning) warnings.push(tableWarning);

  return {
    generatedAt: new Date().toISOString(),
    wikiRoot: opts.wikiRoot,
    week,
    tasks,
    counts,
    pageCount: walk.files.length,
    warnings,
    // 폴더를 못 읽었거나(walk.errors) 파일을 못 읽었으면 목록이 불완전하다.
    partial: walk.errors.length > 0 || reader.unreadable.length > 0,
  };
}
