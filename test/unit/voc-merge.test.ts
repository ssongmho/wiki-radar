// 2.6단계 명세 §5 — 파일 스냅샷에 내 담당 VOC 할 일 합치기(구간·counts·주간 트랙), §2-1 위키 문서 표.
// 시험 사본(test/fixtures/wiki)은 읽기만 한다. today = 2026-09-23(수, 9/24~26 추석)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Bucket, Holiday, Snapshot, Task } from '../../src/shared/types';
import { buildSnapshot } from '../../src/main/wiki/snapshot';
import { loadVocWikiPages, mergeVocTasks, vocStaleNote } from '../../src/main/wiki/merge';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const holidays: Holiday[] = holidaysJson.holidays;

let base: Snapshot;
let baseCopy: Snapshot;

beforeAll(() => {
  base = buildSnapshot({ wikiRoot: FIXTURE, today: TODAY, holidays });
  baseCopy = structuredClone(base);
});

/** vocTasksOf 가 만드는 모양의 VOC 할 일(구간은 합치는 쪽이 다시 매긴다) */
function vocTask(id: number, extra: Partial<Task> = {}): Task {
  return {
    id: `v:${id}`,
    source: 'voc',
    title: `VOC 티켓 ${id}`,
    status: 'open',
    bucket: 'other',
    company: '한결케미칼',
    voc: { id, number: `VOC-2026-${String(id).padStart(4, '0')}`, status: 'assigned', priority: 'P3' },
    ...extra,
  };
}

const VOC: Task[] = [
  vocTask(101, { due: '2026-09-22' }), // 어제 → 지남(1영업일)
  vocTask(102, { due: '2026-09-25', status: 'wip' }), // 금(공휴일) → 이번 주
  vocTask(103, { due: TODAY }), // 오늘 → 이번 주
  vocTask(104, { openDays: 20 }), // 기한 없이 20영업일 → 정리 대상
  vocTask(105, { pri: 1, openDays: 2 }), // P1 이지만 재촉 구간에 가지 않는다 → 기타
  vocTask(106, { due: '2026-07-01' }), // 30영업일 넘게 지남 → 정리 대상
  vocTask(107, { status: 'done' }), // 열린 것만
  vocTask(101, { title: '같은 티켓 두 번' }), // 같은 ID 는 처음 것만
];

function sum(counts: Record<Bucket, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function vocOf(s: Snapshot): Task[] {
  return s.tasks.filter((t) => t.source === 'voc');
}

function byId(s: Snapshot, id: string): Task {
  const t = s.tasks.find((x) => x.id === id);
  expect(t, id).toBeDefined();
  return t as Task;
}

describe('mergeVocTasks — 구간·counts·주간 트랙', () => {
  it('VOC 할 일이 1·2단계 구간 규칙대로 들어간다(재촉 구간은 없다)', () => {
    const merged = mergeVocTasks(base, VOC, { today: TODAY, holidays });
    expect(vocOf(merged).map((t) => t.id).sort()).toEqual(['v:101', 'v:102', 'v:103', 'v:104', 'v:105', 'v:106']);
    expect(byId(merged, 'v:101').bucket).toBe('overdue');
    expect(byId(merged, 'v:101').overdueDays).toBe(1);
    expect(byId(merged, 'v:102').bucket).toBe('thisWeek');
    expect(byId(merged, 'v:103').bucket).toBe('thisWeek');
    expect(byId(merged, 'v:104').bucket).toBe('stale');
    expect(byId(merged, 'v:105').bucket).toBe('other');
    expect(byId(merged, 'v:106').bucket).toBe('stale');
    expect(byId(merged, 'v:106').overdueDays).toBeGreaterThan(30);
    expect(byId(merged, 'v:101').title).toBe('VOC 티켓 101');
  });

  it('counts·week.overdueCount·dueCount 에 VOC 가 들어간다', () => {
    const merged = mergeVocTasks(base, VOC, { today: TODAY, holidays });
    expect(merged.counts).toEqual({
      overdue: base.counts.overdue + 1,
      thisWeek: base.counts.thisWeek + 2,
      chased: base.counts.chased,
      stale: base.counts.stale + 2,
      other: base.counts.other + 1,
    });
    expect(sum(merged.counts)).toBe(merged.tasks.length);
    expect(merged.week.overdueCount).toBe(merged.counts.overdue);
    const due = (s: Snapshot, date: string) => s.week.days.find((d) => d.date === date)?.dueCount;
    expect(due(merged, TODAY)).toBe((due(base, TODAY) ?? 0) + 1);
    expect(due(merged, '2026-09-25')).toBe((due(base, '2026-09-25') ?? 0) + 1);
    // 지난 날(월·화)은 dueCount 에 세지 않는다(overdueCount 로 간다)
    expect(due(merged, '2026-09-22')).toBe(0);
  });

  it('구간 순서대로 이어 붙이고, 구간 안에서는 정렬 규칙대로 섞인다', () => {
    const merged = mergeVocTasks(base, VOC, { today: TODAY, holidays });
    const order: Bucket[] = ['overdue', 'thisWeek', 'chased', 'stale', 'other'];
    const ranks = merged.tasks.map((t) => order.indexOf(t.bucket));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // 지남·이번 주는 기한 오름차순
    const overdueDues = merged.tasks.filter((t) => t.bucket === 'overdue').map((t) => t.due as string);
    expect(overdueDues).toEqual([...overdueDues].sort());
  });

  it('base 의 큐레이션·체크박스 항목은 그대로다(같은 객체·같은 순서), base 는 고치지 않는다', () => {
    const merged = mergeVocTasks(base, VOC, { today: TODAY, holidays });
    const rest = merged.tasks.filter((t) => t.source !== 'voc');
    expect(rest).toHaveLength(base.tasks.length);
    rest.forEach((t, i) => expect(t).toBe(base.tasks[i]));
    expect(base).toEqual(baseCopy);
    expect(merged.pageCount).toBe(base.pageCount);
    expect(merged.partial).toBe(base.partial);
    expect(merged.generatedAt).toBe(base.generatedAt);
    expect(merged.warnings).toEqual(base.warnings);
    expect(merged.warnings).not.toBe(base.warnings);
  });

  it('넘긴 VOC 할 일도 고치지 않는다', () => {
    const input = [vocTask(201, { due: '2026-09-22', bucket: 'other' })];
    const copy = structuredClone(input);
    mergeVocTasks(base, input, { today: TODAY, holidays });
    expect(input).toEqual(copy);
  });

  it('두 번 합쳐도 VOC 가 겹치지 않고, 새 목록으로 바뀐다', () => {
    const once = mergeVocTasks(base, VOC, { today: TODAY, holidays });
    const twice = mergeVocTasks(once, VOC, { today: TODAY, holidays });
    expect(twice.tasks.map((t) => t.id)).toEqual(once.tasks.map((t) => t.id));
    expect(twice.counts).toEqual(once.counts);
    expect(twice.week).toEqual(once.week);

    const replaced = mergeVocTasks(once, [vocTask(301)], { today: TODAY, holidays });
    expect(vocOf(replaced).map((t) => t.id)).toEqual(['v:301']);
    expect(replaced.counts).toEqual({ ...base.counts, other: base.counts.other + 1 });

    const cleared = mergeVocTasks(once, [], { today: TODAY, holidays });
    expect(cleared.tasks).toEqual(base.tasks);
    expect(cleared.counts).toEqual(base.counts);
    expect(cleared.week).toEqual(base.week);
  });

  it('VOC 할 일이 없으면 base 와 같다', () => {
    const merged = mergeVocTasks(base, [], { today: TODAY, holidays });
    expect(merged).toEqual(base);
  });

  it('base 항목과 ID 가 같은 것·ID 가 빈 것은 넣지 않고, 날짜 형식이 아닌 기한은 버린다', () => {
    const clash = { ...vocTask(401), id: base.tasks[0].id };
    const noId = { ...vocTask(402), id: '' };
    const badDue = vocTask(403, { due: '2026-13-40' });
    const merged = mergeVocTasks(base, [clash, noId, badDue], { today: TODAY, holidays });
    expect(merged.tasks).toHaveLength(base.tasks.length + 1);
    const t = byId(merged, 'v:403');
    expect(t.due).toBeUndefined();
    expect(t.bucket).toBe('other');
  });

  it('source 가 다르게 와도 VOC 로 합친다(재촉 수는 쓰지 않는다)', () => {
    const odd = { ...vocTask(501), source: 'checkbox' as const, chaseCount: 3 };
    const merged = mergeVocTasks(base, [odd], { today: TODAY, holidays });
    const t = byId(merged, 'v:501');
    expect(t.source).toBe('voc');
    expect(t.chaseCount).toBeUndefined();
    expect(t.bucket).toBe('other');
  });

  it('오늘이 base 를 만든 날과 다르면 base 항목도 오늘 기준으로 다시 매긴다', () => {
    const next = '2026-09-28'; // 추석 연휴 뒤 월요일
    const merged = mergeVocTasks(base, VOC, { today: next, holidays });
    expect(merged.week.today).toBe(next);
    expect(merged.week.monday).toBe(next);
    // 9/23 이 기한이던 이번 주 항목은 지남으로
    for (const t of merged.tasks) {
      if (t.due !== undefined && t.due < next) expect(['overdue', 'stale']).toContain(t.bucket);
    }
    expect(sum(merged.counts)).toBe(merged.tasks.length);
    expect(merged.week.overdueCount).toBe(merged.counts.overdue);
    expect(base).toEqual(baseCopy);
  });

  it('오늘 날짜 형식이 아니면 던진다', () => {
    expect(() => mergeVocTasks(base, VOC, { today: '2026/09/23', holidays })).toThrow(/날짜 형식/);
  });
});

describe('vocStaleNote — "VOC 할 일은 10:32 기준"', () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

  it('새로 받지 못하는 상태면 받은 시각(로컬)을 적는다', () => {
    for (const state of ['login', 'unavailable', 'stale', 'notConfigured'] as const) {
      expect(vocStaleNote({ state, fetchedAt: at(2026, 9, 23, 10, 32) }, 2, TODAY)).toBe('VOC 할 일은 10:32 기준');
    }
  });

  it('받은 날이 오늘이 아니면 날짜도 붙인다', () => {
    expect(vocStaleNote({ state: 'login', fetchedAt: at(2026, 9, 22, 9, 5) }, 1, TODAY)).toBe('VOC 할 일은 9/22 09:05 기준');
  });

  it('ok·loading·한 번도 받지 못함·남은 할 일 없음·읽을 수 없는 시각이면 없다', () => {
    const fetchedAt = at(2026, 9, 23, 10, 32);
    expect(vocStaleNote({ state: 'ok', fetchedAt }, 3, TODAY)).toBeUndefined();
    expect(vocStaleNote({ state: 'loading' }, 0, TODAY)).toBeUndefined();
    expect(vocStaleNote({ state: 'login' }, 3, TODAY)).toBeUndefined();
    expect(vocStaleNote({ state: 'login', fetchedAt }, 0, TODAY)).toBeUndefined();
    expect(vocStaleNote({ state: 'login', fetchedAt: 'yesterday' }, 3, TODAY)).toBeUndefined();
  });
});

describe('loadVocWikiPages — 고객사·시스템 → 위키 문서(§2-1)', () => {
  it('link_raw.py 의 CUST_PAGE·SYSTEM_PAGE 와 wiki/ 아래 문서 이름을 읽는다', () => {
    const warnings: string[] = [];
    const pages = loadVocWikiPages(FIXTURE, (m) => warnings.push(m));
    expect(pages.custPage.get('한결')).toBe('한결케미칼');
    expect(pages.systemPage.get('CMS(화학물질관리시스템)')).toBe('화학물질 관리시스템 (CMS)');
    expect(pages.pageIndex.get('한결케미칼')).toBe('wiki/entities/한결케미칼.md');
    expect(pages.pageIndex.get('서진화학')).toBe('wiki/entities/서진화학.md');
    expect(pages.pageIndex.get('CMS 인벤토리 사용량 집계')).toBe('wiki/topics/dev/CMS 인벤토리 사용량 집계.md');
    // wiki/ 밖의 문서는 색인하지 않는다
    expect(pages.pageIndex.has('내 할 일')).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('이름이 겹치면 경로 이름순 처음 것(entities 가 topics 보다 먼저)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-vocpages-'));
    try {
      for (const rel of ['wiki/topics/x/해온정밀.md', 'wiki/entities/해온정밀.md', 'wiki/topics/백업/.obsidian/무시.md']) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), '# 가짜\n');
      }
      const pages = loadVocWikiPages(tmp);
      expect(pages.pageIndex.get('해온정밀')).toBe('wiki/entities/해온정밀.md');
      expect(pages.pageIndex.has('무시')).toBe(false);
      expect(pages.custPage.size).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('위키 폴더가 없으면 빈 표(던지지 않는다)', () => {
    const warnings: string[] = [];
    const pages = loadVocWikiPages(path.join(os.tmpdir(), 'wr-no-such-wiki-2026'), (m) => warnings.push(m));
    expect(pages.custPage.size + pages.systemPage.size + pages.pageIndex.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});
