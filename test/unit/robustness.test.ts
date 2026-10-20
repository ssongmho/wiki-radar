// 스냅샷의 견고성 — 테스트 사본을 임시 폴더에 복사해서만 바꾼다(원본 fixture·실제 위키는 건드리지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Snapshot } from '../../src/shared/types';
import {
  EXCLUDED_DIRS,
  READ_RETRY_DELAYS_MS,
  RetryBudget,
  isInExcludedDir,
  readTextFile,
  safeVaultRelative,
  splitLines,
  stripBom,
  walkMarkdown,
} from '../../src/main/wiki/fsutil';
import { READ_RETRY_BUDGET_MS, buildSnapshot, isTargetFile } from '../../src/main/wiki/snapshot';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const temps: string[] = [];

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-snap-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  temps.push(dir);
  return dir;
}

function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function build(root: string): Snapshot {
  return buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
}

/** generatedAt·wikiRoot 를 뺀 비교용 */
function comparable(s: Snapshot) {
  return { ...s, generatedAt: '', wikiRoot: '' };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

describe('items.json 문제', () => {
  it('없으면 큐레이션 없이 계속하고 경고한다', () => {
    const root = copyFixture();
    fs.rmSync(at(root, '_todo-sync/items.json'));
    const s = build(root);
    expect(s.warnings).toEqual(['items.json 이 없음 — 큐레이션 항목 없이 계속함']);
    expect(s.tasks.every((t) => t.source === 'checkbox')).toBe(true);
    // 앵커가 사라졌으니 한결 통영 줄·엔티티의 연간 계약 갱신 줄이 체크박스 항목으로 나온다
    expect(s.tasks.some((t) => t.title.startsWith('한결케미칼 통영공장 인벤토리 사용량 미반영'))).toBe(true);
    expect(s.tasks.some((t) => t.title === '연간 계약 갱신 검토')).toBe(true);
    expect(s.tasks).toHaveLength(18);
  });

  it('깨졌으면 큐레이션 없이 계속하고 경고한다', () => {
    const root = copyFixture();
    fs.writeFileSync(at(root, '_todo-sync/items.json'), '{"items": [ {"t": "x",', 'utf8');
    const s = build(root);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/^items\.json 을 읽지 못함\(JSON 오류: .+\) — 큐레이션 항목 없이 계속함$/);
    expect(s.tasks.filter((t) => t.source === 'curated')).toEqual([]);
    expect(s.tasks.length).toBeGreaterThan(0);
  });

  it('BOM 이 붙은 items.json 도 읽는다', () => {
    const root = copyFixture();
    const p = at(root, '_todo-sync/items.json');
    fs.writeFileSync(p, '\ufeff' + fs.readFileSync(p, 'utf8'), 'utf8');
    expect(comparable(build(root))).toEqual(comparable(build(FIXTURE)));
  });
});

describe('파일 형식', () => {
  it('모든 .md 를 BOM + \\r\\n 으로 바꿔도 결과가 같다', () => {
    const root = copyFixture();
    for (const rel of walkMarkdown(root).files) {
      const p = at(root, rel);
      const text = fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n');
      fs.writeFileSync(p, '\ufeff' + text, 'utf8');
    }
    const s = build(root);
    const base = build(FIXTURE);
    // rawLine 에 \r 이 남지 않아야 하고, 나머지도 모두 같아야 한다
    expect(comparable(s)).toEqual(comparable(base));
    expect(s.tasks.every((t) => !t.rawLine?.includes('\r'))).toBe(true);
  });

  it('link_raw.py 가 없으면 빈 표(해온 → 폴더 이름 그대로, _미분류 도 업체로)', () => {
    const root = copyFixture();
    fs.rmSync(at(root, '_raw-link/link_raw.py'));
    const s = build(root);
    expect(s.warnings).toHaveLength(1);
    expect(s.tasks.find((t) => t.title.startsWith('해온정밀 HR 연계'))?.company).toBe('해온');
    expect(s.tasks.find((t) => t.title.startsWith('신규 고객사 명함 제출'))?.company).toBe('_미분류');
  });

  it('할 일 메모.md 가 없으면 메모 없이', () => {
    const root = copyFixture();
    fs.rmSync(at(root, '_private/mgmt/할 일 메모.md'));
    const s = build(root);
    expect(s.tasks.filter((t) => t.memo)).toEqual([]);
    // 3a단계 fixture(log·index·가상 문서 3개·templates·.claude) 포함 — 1단계 pageCount 규칙은 templates/·.claude/ 도 센다
    expect(s.pageCount).toBe(14);
  });

  it('앵커 파일 이름에 .md 가 빠져 있어도 찾는다', () => {
    const root = copyFixture();
    const p = at(root, '_todo-sync/items.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"f": "wiki/entities/한결케미칼.md"', '"f": "wiki/entities/한결케미칼"'), 'utf8');
    const s = build(root);
    expect(s.tasks.filter((t) => t.title.includes('연간 계약 갱신')).map((t) => [t.source, t.file])).toEqual([
      ['curated', 'wiki/entities/한결케미칼.md'],
    ]);
  });

  it.each([
    ['대소문자가 다른 앵커 경로', 'Wiki/Entities/한결케미칼.md'],
    ['NFD 로 쓴 앵커 경로', `wiki/entities/${'한결케미칼'.normalize('NFD')}.md`],
    ['역슬래시 앵커 경로', 'wiki\\entities\\한결케미칼.md'],
  ])('%s도 훑은 파일 표기로 맞춰 앵커 줄을 합친다', (_name, f) => {
    const root = copyFixture();
    const p = at(root, '_todo-sync/items.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const item = json.items.find((x: { t: string }) => x.t === '한결케미칼 연간 계약 갱신 검토');
    item.a[0].f = f;
    fs.writeFileSync(p, JSON.stringify(json), 'utf8');
    const s = build(root);
    expect(s.tasks.filter((t) => t.title.includes('연간 계약 갱신')).map((t) => [t.source, t.file, t.company])).toEqual([
      ['curated', 'wiki/entities/한결케미칼.md', '한결케미칼'],
    ]);
    expect(s.warnings).toHaveLength(1);
  });

  it('볼트 밖을 가리키는 앵커는 읽지 않고 경고한다', () => {
    const root = copyFixture();
    const p = at(root, '_todo-sync/items.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"f": "_private/mgmt/내 할 일.md", "m": "존재하지', '"f": "../밖.md", "m": "존재하지'), 'utf8');
    const s = build(root);
    expect(s.warnings).toEqual(['앵커를 찾지 못함: 사라진 항목 (../밖.md / 존재하지 않는 문구)']);
  });
});

describe('앵커 상태', () => {
  it('앵커 줄이 [x] 로 닫히면 큐레이션 항목도 빠진다', () => {
    const root = copyFixture();
    const p = at(root, '_private/mgmt/내 할 일.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- [ ] 🔴 한결케미칼 통영공장', '- [x] 🔴 한결케미칼 통영공장'), 'utf8');
    const s = build(root);
    expect(s.tasks.filter((t) => t.title.includes('통영'))).toEqual([]);
    expect(s.counts.overdue).toBe(4);
  });

  it('앵커 줄에 [owner::] 가 붙으면 빠지고, [wip::] 면 진행 중', () => {
    const root = copyFixture();
    const p = at(root, 'wiki/entities/한결케미칼.md');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('연간 계약 갱신 검토 [due:: 2026-09-30]', '연간 계약 갱신 검토 [due:: 2026-10-10] [wip:: 2026-09-22]'), 'utf8');
    const s = build(root);
    const t = s.tasks.find((x) => x.title === '한결케미칼 연간 계약 갱신 검토');
    expect(t).toMatchObject({ status: 'wip', due: '2026-10-10' }); // due 는 줄의 값이 이긴다
  });

  it('앵커가 여럿이면 처음 나온 open 이 아닌 값이 이긴다', () => {
    const root = copyFixture();
    const p = at(root, '_todo-sync/items.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const item = json.items.find((x: { t: string }) => x.t === '한결케미칼 연간 계약 갱신 검토');
    item.a.push({ f: '_private/mgmt/내 할 일.md', m: '백산 SSL 교통정리' }); // owner 줄
    fs.writeFileSync(p, JSON.stringify(json), 'utf8');
    const s = build(root);
    expect(s.tasks.find((x) => x.title === '한결케미칼 연간 계약 갱신 검토')).toBeUndefined();
  });
});

describe('ID 중복', () => {
  it('같은 파일에 같은 문장의 열린 줄이 둘이면 둘 다 보여 주고 뒤의 것에 번호를 붙인다', () => {
    const root = copyFixture();
    const p = at(root, '_private/mgmt/업무 현황 종합 분석.md');
    fs.appendFileSync(p, '\n- [ ] 중복 할 일 #내할일 [due:: 2026-10-01]\n- [ ] 중복 할 일 #내할일 [due:: 2026-10-08]\n', 'utf8');
    const s = build(root);
    const dup = s.tasks.filter((t) => t.title === '중복 할 일');
    expect(dup).toHaveLength(2);
    expect(dup[1].id).toBe(`${dup[0].id}-2`);
    expect(new Set(s.tasks.map((t) => t.id)).size).toBe(s.tasks.length);
    expect(s.warnings).toContain('같은 ID 의 할 일이 여럿: 중복 할 일 (_private/mgmt/업무 현황 종합 분석.md)');
  });
});

/** fs.readFileSync 가 특정 파일에서 count 번 code 오류를 내게 한다(그 뒤에는 정상). 시도 횟수를 돌려준다 */
function failReadsOf(fileName: string, code: string, count: number): { calls: () => number } {
  const original = fs.readFileSync;
  let failures = 0;
  let calls = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
    if (typeof p === 'string' && p.endsWith(fileName)) {
      calls++;
      if (failures < count) {
        failures++;
        const err = new Error(`${code}: resource busy or locked, open '${p}'`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
    }
    return original.call(fs, p, o as BufferEncoding);
  }) as typeof fs.readFileSync);
  return { calls: () => calls };
}

describe('잠긴 파일(EBUSY 등) — 재시도와 부분 스냅샷', () => {
  const MY_TASKS = '내 할 일.md';

  it('readTextFile 은 일시적 오류를 재시도하고 예산이 다하면 던진다', () => {
    const root = copyFixture();
    const abs = at(root, `_private/mgmt/${MY_TASKS}`);
    const waits: number[] = [];
    const sleep = (ms: number) => waits.push(ms);

    // 두 번 EBUSY 뒤 성공 → 세 번 시도, 두 번 대기
    let probe = failReadsOf(MY_TASKS, 'EBUSY', 2);
    expect(readTextFile(abs, { sleep })).toContain('# 내 할 일');
    expect(probe.calls()).toBe(3);
    expect(waits).toEqual(READ_RETRY_DELAYS_MS.slice(0, 2));
    vi.restoreAllMocks();

    // 계속 EBUSY → 대기 세 번 뒤 그대로 던진다
    waits.length = 0;
    probe = failReadsOf(MY_TASKS, 'EBUSY', 99);
    expect(() => readTextFile(abs, { sleep })).toThrow(/EBUSY/);
    expect(probe.calls()).toBe(READ_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...READ_RETRY_DELAYS_MS]);
    vi.restoreAllMocks();

    // ENOENT 같은 영구 오류는 재시도하지 않는다
    waits.length = 0;
    probe = failReadsOf(MY_TASKS, 'ENOENT', 99);
    expect(() => readTextFile(abs, { sleep })).toThrow(/ENOENT/);
    expect(probe.calls()).toBe(1);
    expect(waits).toEqual([]);
    vi.restoreAllMocks();

    // 예산이 첫 대기만 허용하면 두 번째 대기 전에 던진다
    waits.length = 0;
    probe = failReadsOf(MY_TASKS, 'EPERM', 99);
    const budget = new RetryBudget(READ_RETRY_DELAYS_MS[0]);
    expect(() => readTextFile(abs, { sleep, budget })).toThrow(/EPERM/);
    expect(probe.calls()).toBe(2);
    expect(budget.remaining).toBe(0);
  });

  it('잠깐 잠긴 파일은 재시도로 읽어 완전한 스냅샷을 만든다', () => {
    const root = copyFixture();
    const sleeps = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    failReadsOf(MY_TASKS, 'EBUSY', 1);
    const s = build(root);
    expect(s.partial).toBe(false);
    expect(s.tasks).toHaveLength(23);
    expect(s.warnings).toEqual(['앵커를 찾지 못함: 사라진 항목 (_private/mgmt/내 할 일.md / 존재하지 않는 문구)']);
    expect(sleeps).toHaveBeenCalledTimes(1);
  });

  it('계속 잠긴 파일은 partial 스냅샷 — 그 파일의 할 일이 빠지고 경고가 남는다', () => {
    const root = copyFixture();
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    failReadsOf(MY_TASKS, 'EBUSY', Infinity);
    const s = build(root);
    expect(s.partial).toBe(true);
    expect(s.warnings.some((w) => /^파일을 읽지 못함: _private\/mgmt\/내 할 일\.md \(EBUSY\)/.test(w))).toBe(true);
    // 내 할 일.md 의 할 일이 빠졌다(완전한 스냅샷은 23건)
    expect(s.tasks.length).toBeLessThan(23);
    expect(s.tasks.every((t) => t.file !== '_private/mgmt/내 할 일.md')).toBe(true);
    // 잠금이 풀리면(같은 사본을 다시 만들면) 완전한 스냅샷 — main 은 이 재생성을 백오프로 예약한다
    vi.restoreAllMocks();
    const again = build(root);
    expect(again.partial).toBe(false);
    expect(again.tasks).toHaveLength(23);
  });

  it('잠긴 파일이 많아도 재시도 대기는 스냅샷당 예산 안에서만 한다', () => {
    const root = copyFixture();
    const waits: number[] = [];
    vi.spyOn(Atomics, 'wait').mockImplementation(((_a: unknown, _i: unknown, _v: unknown, ms?: number) => {
      waits.push(ms ?? 0);
      return 'timed-out';
    }) as typeof Atomics.wait);
    failReadsOf('.md', 'EBUSY', Infinity); // 모든 .md
    const s = build(root);
    expect(s.partial).toBe(true);
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(READ_RETRY_BUDGET_MS);
    expect(waits.length).toBeGreaterThan(0);
  });
});

describe('입력 검사', () => {
  it('위키 폴더가 없으면 예외', () => {
    expect(() => buildSnapshot({ wikiRoot: path.join(os.tmpdir(), 'wiki-radar-없는-폴더-xyz'), today: TODAY, holidays: [] })).toThrow(
      /위키 폴더를 찾을 수 없음/,
    );
  });

  it('today 형식이 틀리면 예외', () => {
    expect(() => buildSnapshot({ wikiRoot: FIXTURE, today: '2026/09/23', holidays: [] })).toThrow(/오늘 날짜 형식/);
  });
});

describe('볼트 훑기', () => {
  it('제외 폴더는 내려가기 전에 잘라낸다(안을 읽지 않는다)', () => {
    const root = copyFixture();
    // 제외 폴더를 여러 깊이에 만든다
    for (const rel of [
      'wiki/topics/backup/x.md',
      'wiki/node_modules/pkg/readme.md',
      'deep/a/b/.trash/x.md',
      'raw/voc/deep/y.md',
      '.obsidian/workspace.md',
    ]) {
      fs.mkdirSync(path.dirname(at(root, rel)), { recursive: true });
      fs.writeFileSync(at(root, rel), '- [ ] 잡히면 안 된다 #내할일\n', 'utf8');
    }
    // 이름만 비슷한 폴더는 제외가 아니다
    fs.mkdirSync(at(root, 'wiki/raw-notes'), { recursive: true });
    fs.writeFileSync(at(root, 'wiki/raw-notes/n.md'), '# 노트\n', 'utf8');

    const spy = vi.spyOn(fs, 'readdirSync');
    const w = walkMarkdown(root);
    const visited = spy.mock.calls.map((c) => path.relative(root, String(c[0])).replace(/\\/g, '/'));
    for (const v of visited) {
      expect(v.split('/').some((seg) => EXCLUDED_DIRS.has(seg)), `내려가면 안 되는 폴더: ${v}`).toBe(false);
    }
    expect(w.files).toContain('wiki/raw-notes/n.md');
    expect(w.files.filter((f) => isInExcludedDir(f))).toEqual([]);
    expect(w.files).toHaveLength(16);
    spy.mockRestore();

    const s = build(root);
    expect(s.pageCount).toBe(16);
    expect(s.tasks.filter((t) => t.title.includes('잡히면 안 된다'))).toEqual([]);
  });

  it('파일 목록은 이름순, / 구분', () => {
    const w = walkMarkdown(FIXTURE);
    expect(w.errors).toEqual([]);
    expect(w.files).toEqual([
      '.claude/commands/x.md',
      '_private/business/계약관리시스템.md',
      '_private/mgmt/내 할 일.md',
      '_private/mgmt/업무 현황 종합 분석.md',
      '_private/mgmt/연간 목표.md',
      '_private/mgmt/할 일 메모.md',
      'index.md',
      'log.md',
      'templates/문서 틀.md',
      'wiki/entities/대륙물산.md',
      'wiki/entities/서진화학.md',
      'wiki/entities/한결케미칼.md',
      'wiki/entities/해온정밀.md',
      'wiki/topics/dev/CMS 인벤토리 사용량 집계.md',
      'wiki/topics/dev/배치 마감 경계 조건.md',
    ]);
  });
});

describe('도우미', () => {
  it('검사 대상 파일', () => {
    expect(isTargetFile('_private/mgmt/내 할 일.md')).toBe(true);
    expect(isTargetFile('_private/business/계약관리시스템.md')).toBe(true);
    expect(isTargetFile('wiki/entities/한결케미칼.md')).toBe(true);
    expect(isTargetFile('wiki/entities/sub/한결케미칼.md')).toBe(false);
    expect(isTargetFile('_private/mgmt/업무 현황 종합 분석.md')).toBe(false);
  });

  it('BOM·줄바꿈', () => {
    expect(stripBom('\ufeff가')).toBe('가');
    expect(splitLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('볼트 상대경로 검사', () => {
    expect(safeVaultRelative('a\\b.md')).toBe('a/b.md');
    expect(safeVaultRelative('./a/b.md')).toBe('a/b.md');
    for (const bad of ['../a.md', 'a/../../b.md', '/a.md', 'C:/a.md', 'a//b.md', 'a/./b.md', '', 'a/b.md\u0000']) {
      expect(safeVaultRelative(bad), bad).toBeNull();
    }
  });
});
