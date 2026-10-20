// 3a단계 §5 변경 피드: 기준선·판정·기준 내용·줄 수·읽음·저장소
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangeBaseStore,
  WIKI_BASE_DOC_MAX_BYTES,
  WikiSeenStore,
  lineDiff,
  listChanges,
  makeBaseline,
  markSeenPaths,
  observeIndex,
  pruneWikiSeen,
  type ChangeBase,
  type SeenSource,
} from '../../src/main/wiki/docChanges';
import { parseDocText, type WikiDocEntry } from '../../src/main/wiki/docIndex';
import type { WikiDocSource } from '../../src/shared/types';

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-changes-'));
  temps.push(d);
  return d;
}

function doc(source: WikiDocSource, rel: string, text: string, mtimeMs = 1000): WikiDocEntry {
  return { ...parseDocText(source, rel, text), size: text.length, mtimeMs };
}
function mapOf(...entries: WikiDocEntry[]): Map<string, WikiDocEntry> {
  return new Map(entries.map((e) => [e.path, e]));
}
const localDate = (iso: string) => iso.slice(0, 10);
const T0 = '2026-09-23T01:00:00.000Z';
const T1 = '2026-09-23T02:00:00.000Z';
const T2 = '2026-09-23T03:00:00.000Z';

describe('줄 수', () => {
  it('다중집합 차이·줄 순서만 바뀜 0/0·표본 3개', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc\nd\ne')).toEqual({ added: 2, removed: 0, sample: ['d', 'e'] });
    expect(lineDiff('a\nb\nc', 'c\nb\na')).toEqual({ added: 0, removed: 0, sample: [] });
    expect(lineDiff('a\na\nb', 'a\n  \nx\ny\nz\nw')).toEqual({ added: 4, removed: 2, sample: ['x', 'y', 'z'] });
  });
});

describe('기준선·판정', () => {
  const a = doc('personal', 'wiki/a.md', '# A\n하나');
  const log = doc('personal', 'log.md', '# 로그');
  const todo = doc('personal', '_private/mgmt/내 할 일.md', '# 할 일');

  it('기준선은 지금 문서 전부 — log·index·할 일 원천은 뺀다', () => {
    const seen = makeBaseline('/w', [a, log, todo].values(), T0);
    expect(Object.keys(seen.docs)).toEqual(['wiki/a.md']);
    expect(listChanges({ source: 'personal', entries: mapOf(a, log, todo), seen, base: {}, localDate })).toEqual([]);
  });

  it('new·changed·deleted + 기준 내용(이전 본문)·되돌리면 지움', () => {
    const b = doc('personal', 'wiki/b.md', '# B');
    const seen = makeBaseline('/w', [a, b].values(), T0);
    const base: Record<string, ChangeBase> = {};
    const a2 = doc('personal', 'wiki/a.md', '# A\n하나\n둘\n셋', 2000);
    const c = doc('personal', 'wiki/c.md', '# C\n새 문서 첫 줄');
    const log2 = doc('personal', 'log.md', '# 로그\n바뀜');
    const prev = mapOf(a, b, log);
    const next = mapOf(a2, c, log2);
    const r = observeIndex({ source: 'personal', prev, next, seen, base, nowIso: T1 });
    expect(r).toEqual({ changed: true, detected: 3 });
    expect(base['personal:wiki/a.md']).toEqual({ baseHash: a.hash, baseText: a.body, detectedAt: T1 });
    const items = listChanges({ source: 'personal', entries: next, seen, base, localDate });
    expect(items.map((i) => [i.path, i.change])).toEqual([
      ['wiki/a.md', 'changed'],
      ['wiki/c.md', 'new'],
      ['wiki/b.md', 'deleted'],
    ]);
    expect(items[0].lines).toEqual({ added: 2, removed: 0, sample: ['둘', '셋'] });
    expect(items[1].firstLine).toBe('# C 새 문서 첫 줄');
    expect(items[2]).toMatchObject({ title: 'b', kind: 'other' });

    // 다시 관찰해도 처음 감지 시각은 그대로
    observeIndex({ source: 'personal', prev: next, next, seen, base, nowIso: T2 });
    expect(base['personal:wiki/a.md'].detectedAt).toBe(T1);

    // 되돌리면(읽음 해시로) 기준 내용을 지운다
    const back = mapOf(a, c);
    observeIndex({ source: 'personal', prev: next, next: back, seen, base, nowIso: T2 });
    expect(base['personal:wiki/a.md']).toBeUndefined();
    expect(listChanges({ source: 'personal', entries: back, seen, base, localDate }).map((i) => i.path)).toEqual(['wiki/c.md', 'wiki/b.md']);
  });

  it('이전 본문이 없으면(캐시 없음) 줄 수 모름, 256KB 넘는 기준 내용도 모름', () => {
    const seen = makeBaseline('/w', [a].values(), T0);
    const base: Record<string, ChangeBase> = {};
    const a2 = doc('personal', 'wiki/a.md', '# A 바뀜');
    observeIndex({ source: 'personal', prev: null, next: mapOf(a2), seen, base, nowIso: T1 });
    expect(listChanges({ source: 'personal', entries: mapOf(a2), seen, base, localDate })[0].lines).toBeNull();

    const big = doc('personal', 'wiki/big.md', `# 큰\n${'가'.repeat(WIKI_BASE_DOC_MAX_BYTES)}`);
    const seen2 = makeBaseline('/w', [big].values(), T0);
    const base2: Record<string, ChangeBase> = {};
    const big2 = doc('personal', 'wiki/big.md', '# 큰\n짧아짐');
    observeIndex({ source: 'personal', prev: mapOf(big), next: mapOf(big2), seen: seen2, base: base2, nowIso: T1 });
    expect(base2['personal:wiki/big.md'].baseText).toBeUndefined();
    expect(listChanges({ source: 'personal', entries: mapOf(big2), seen: seen2, base: base2, localDate })[0].lines).toBeNull();
  });

  it('루트가 바뀌면 부르는 쪽이 새 기준선(makeBaseline) — 대량 변경 수', () => {
    const many = Array.from({ length: 301 }, (_, i) => doc('personal', `wiki/n${i}.md`, `# ${i}`));
    const seen = makeBaseline('/w', [].values(), T0);
    const r = observeIndex({ source: 'personal', prev: null, next: mapOf(...many), seen, base: {}, nowIso: T1 });
    expect(r.detected).toBe(301);
  });

  it('이유: 읽음 날짜 이후 log 항목(reasons 콜백에 읽음 날짜를 넘긴다)', () => {
    const seen = makeBaseline('/w', [a].values(), '2026-09-20T01:00:00.000Z');
    const a2 = doc('personal', 'wiki/a.md', '# A 바뀜');
    const asked: string[] = [];
    listChanges({
      source: 'personal',
      entries: mapOf(a2),
      seen,
      base: {},
      localDate,
      reasons: (p, since) => {
        asked.push(`${p}@${since}`);
        return [];
      },
    });
    expect(asked).toEqual(['wiki/a.md@2026-09-20']);
  });
});

describe('팀 — 받은 것만', () => {
  const s1 = doc('team', '운영/서버 점검.md', '# 서버 점검\n하나');
  const m1 = doc('team', '회의록/주간.md', '# 주간\n하나');

  it('cutoff 뒤에 감지한 것은 다음 동기화까지 숨김 · pushed 는 읽음 · pulled 는 변경', () => {
    const seen: SeenSource = { ...makeBaseline('/t', [s1, m1].values(), T0), teamCutoffAt: T0 };
    const base: Record<string, ChangeBase> = {};
    // 내가 사본을 고침(동기화 전) — 감시가 색인
    const s2 = doc('team', '운영/서버 점검.md', '# 서버 점검\n하나\n내가 더함');
    observeIndex({ source: 'team', prev: mapOf(s1, m1), next: mapOf(s2, m1), seen, base, nowIso: T0 });
    expect(Date.parse(base['team:운영/서버 점검.md'].detectedAt)).toBeGreaterThan(Date.parse(T0));
    expect(listChanges({ source: 'team', entries: mapOf(s2, m1), seen, base, localDate })).toEqual([]);

    // 동기화: 회의록은 받음(pulled), 서버 점검은 올림(pushed)
    const m2 = doc('team', '회의록/주간.md', '# 주간\n하나\n둘\n셋');
    const next = mapOf(s2, m2);
    observeIndex({ source: 'team', prev: mapOf(s2, m1), next, seen, base, nowIso: T1 });
    markSeenPaths('team', ['운영/서버 점검.md'], next, seen, base, T1);
    seen.teamCutoffAt = T1;
    const items = listChanges({ source: 'team', entries: next, seen, base, localDate });
    expect(items.map((i) => [i.path, i.change, i.lines?.added, i.lines?.removed])).toEqual([['회의록/주간.md', 'changed', 2, 0]]);
    expect(items[0].reasons).toBeUndefined();
  });

  it('cutoff 가 없으면(첫 동기화 전) 아무것도 보이지 않는다', () => {
    const seen = makeBaseline('/t', [s1].values(), T0);
    const base: Record<string, ChangeBase> = {};
    const s2 = doc('team', '운영/서버 점검.md', '# 바뀜');
    observeIndex({ source: 'team', prev: null, next: mapOf(s2), seen, base, nowIso: T1 });
    expect(listChanges({ source: 'team', entries: mapOf(s2), seen, base, localDate })).toEqual([]);
  });
});

describe('읽음으로', () => {
  it('목록·지운 문서·앱 쓰기 뒤', () => {
    const a = doc('personal', 'wiki/a.md', '# A');
    const seen = makeBaseline('/w', [a].values(), T0);
    seen.docs['wiki/gone.md'] = { hash: a.hash, at: T0 };
    const base: Record<string, ChangeBase> = { 'personal:wiki/gone.md': { detectedAt: T1 } };
    const a2 = doc('personal', 'wiki/a.md', '# A 바뀜');
    const entries = mapOf(a2);
    expect(markSeenPaths('personal', ['wiki/a.md', 'wiki/gone.md'], entries, seen, base, T1)).toBeGreaterThan(0);
    expect(seen.docs['wiki/a.md']).toEqual({ hash: a2.hash, at: T1 });
    expect(seen.docs['wiki/gone.md']).toBeUndefined();
    expect(base).toEqual({});
    expect(listChanges({ source: 'personal', entries, seen, base, localDate })).toEqual([]);
  });
});

describe('저장소', () => {
  it('깨진 기록은 옮기고 새 기준선 + 경고', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'wiki-seen.json'), '{깨짐');
    const warns: string[] = [];
    const store = new WikiSeenStore(dir, { warn: (m) => warns.push(m) });
    expect(store.load()).toEqual({ version: 1, sources: {} });
    expect(warns[0]).toMatch(/깨져 있어 새 기준선/);
    expect(fs.readdirSync(dir).some((n) => /^wiki-seen\.broken-.*\.json$/.test(n))).toBe(true);
    store.mutate((d) => {
      d.sources.personal = { root: '/w', baselineAt: T0, docs: {} };
    });
    store.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'wiki-seen.json'), 'utf8')).sources.personal.root).toBe('/w');
  });

  it('잠긴 기록(ENOENT 아닌 읽기 실패)은 덮어쓰지 않는다', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'wiki-seen.json')); // 폴더라 읽기가 EISDIR 로 실패
    const warns: string[] = [];
    const store = new WikiSeenStore(dir, { warn: (m) => warns.push(m) });
    store.load();
    expect(store.problem).toMatch(/읽지 못했습니다/);
    expect(() => store.mutate(() => undefined)).toThrow(/읽지 못했습니다/);
    expect(store.writable()).toBe(false);
  });

  it('한도: 출처마다 문서 수를 넘으면 오래 전에 본 것부터', () => {
    const file = {
      version: 1 as const,
      sources: { personal: { root: '/w', baselineAt: T0, docs: { a: { hash: 'a'.repeat(40), at: T0 }, b: { hash: 'b'.repeat(40), at: T2 }, c: { hash: 'c'.repeat(40), at: T1 } } } },
    };
    expect(pruneWikiSeen(file, 2)).toBe(1);
    expect(Object.keys(file.sources.personal.docs).sort()).toEqual(['b', 'c']);
  });

  it('기준 내용 파일: 깨지면 새로', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'wiki-change-base.json'), 'null');
    const warns: string[] = [];
    const store = new ChangeBaseStore(dir, { warn: (m) => warns.push(m) });
    expect(store.items).toEqual({});
    expect(warns).toHaveLength(1);
    store.items['personal:a.md'] = { detectedAt: T0 };
    store.touch();
    store.flush();
    expect(new ChangeBaseStore(dir).items).toEqual({ 'personal:a.md': { detectedAt: T0 } });
  });
});
