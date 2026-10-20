// 1단계 명세 §3 정답표 + 2단계 명세 §4-1 변경 — test/fixtures/wiki, today = 2026-09-23
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Bucket, Snapshot, Task } from '../../src/shared/types';
import { buildSnapshot } from '../../src/main/wiki/snapshot';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const MY_TASKS = '_private/mgmt/내 할 일.md';
const HANGYEOL_MAIL =
  'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md';

let snap: Snapshot;

function sha12(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
}

function titlesOf(bucket: Bucket): string[] {
  return snap.tasks.filter((t) => t.bucket === bucket).map((t) => t.title);
}

function task(title: string): Task {
  const found = snap.tasks.filter((t) => t.title === title);
  expect(found, `제목 "${title}" 인 할 일이 정확히 1건이어야 한다`).toHaveLength(1);
  return found[0];
}

/** 1단계 명세 §3 의 21행 + 2단계 §4-1 의 2행(오래 밀린 견적 검토 → stale, 진행 메모가 있는 건 → other) */
const TABLE: { bucket: Bucket; title: string; source: Task['source'] }[] = [
  { bucket: 'overdue', title: 'LDAR 견적서 회신', source: 'curated' },
  { bucket: 'overdue', title: '한결케미칼 통영공장 사용량 미반영 회신', source: 'curated' },
  { bucket: 'overdue', title: '서진화학 EHS 잔여 오류 목록 — 우선순위 회신', source: 'checkbox' },
  { bucket: 'overdue', title: '계약관리 권한 오류 수정 (26년 이전 계약 조회)', source: 'checkbox' },
  { bucket: 'overdue', title: '팀 회의록 공유, 사업부 채널에', source: 'checkbox' },
  { bucket: 'thisWeek', title: '누리소재 MSDS 개정차수 반영 — 완료 예정일 회신', source: 'checkbox' },
  { bucket: 'thisWeek', title: '법인카드 지출결의서 작성', source: 'checkbox' },
  { bucket: 'thisWeek', title: '대륙물산 서버 교체 견적 방향 결정', source: 'curated' },
  { bucket: 'thisWeek', title: '주간 업무보고 작성', source: 'checkbox' },
  { bucket: 'chased', title: '해온정밀 HR 연계 — 유지보수 범위 판단·회신', source: 'checkbox' },
  { bucket: 'chased', title: 'VOC 장기건 메뉴별 오류 정리', source: 'checkbox' },
  { bucket: 'stale', title: '오래 밀린 견적 검토', source: 'checkbox' },
  { bucket: 'stale', title: '신규 고객사 명함 제출 (표준템플릿)', source: 'checkbox' },
  { bucket: 'other', title: '월간 리포트 초안 작성', source: 'checkbox' },
  { bucket: 'other', title: '한결케미칼 연간 계약 갱신 검토', source: 'curated' },
  { bucket: 'other', title: '분기 법정교육 이수', source: 'checkbox' },
  { bucket: 'other', title: '사내 교육 수강신청 완료', source: 'checkbox' },
  { bucket: 'other', title: '진행 메모가 있는 건', source: 'checkbox' },
  { bucket: 'other', title: '담당자 교체 공지 확인', source: 'checkbox' },
  { bucket: 'other', title: '사라진 항목', source: 'curated' },
  { bucket: 'other', title: '인수인계서 검토·부족분 회신', source: 'checkbox' },
  { bucket: 'other', title: '전략 검토', source: 'curated' },
  { bucket: 'other', title: '큐레이션 진행 항목', source: 'curated' },
];

beforeAll(() => {
  snap = buildSnapshot({ wikiRoot: FIXTURE, today: TODAY, holidays: holidaysJson.holidays });
});

describe('구간과 순서', () => {
  it('tasks 는 정답표 23행과 같은 순서·구간·원천이다', () => {
    expect(snap.tasks.map((t) => [t.bucket, t.title, t.source])).toEqual(
      TABLE.map((r) => [r.bucket, r.title, r.source]),
    );
  });

  it('구간별 제목 순서', () => {
    expect(titlesOf('overdue')).toEqual([
      'LDAR 견적서 회신',
      '한결케미칼 통영공장 사용량 미반영 회신',
      '서진화학 EHS 잔여 오류 목록 — 우선순위 회신',
      '계약관리 권한 오류 수정 (26년 이전 계약 조회)',
      '팀 회의록 공유, 사업부 채널에',
    ]);
    expect(titlesOf('thisWeek')).toEqual([
      '누리소재 MSDS 개정차수 반영 — 완료 예정일 회신',
      '법인카드 지출결의서 작성',
      '대륙물산 서버 교체 견적 방향 결정',
      '주간 업무보고 작성',
    ]);
    expect(titlesOf('chased')).toEqual(['해온정밀 HR 연계 — 유지보수 범위 판단·회신', 'VOC 장기건 메뉴별 오류 정리']);
    // 정리 대상: overdueDays 내림차순 → openDays 내림차순 → 제목 (2단계 §4)
    expect(titlesOf('stale')).toEqual(['오래 밀린 견적 검토', '신규 고객사 명함 제출 (표준템플릿)']);
    expect(titlesOf('other')).toEqual([
      '월간 리포트 초안 작성',
      '한결케미칼 연간 계약 갱신 검토',
      '분기 법정교육 이수',
      '사내 교육 수강신청 완료',
      '진행 메모가 있는 건',
      '담당자 교체 공지 확인',
      '사라진 항목',
      '인수인계서 검토·부족분 회신',
      '전략 검토',
      '큐레이션 진행 항목',
    ]);
  });

  it('counts', () => {
    expect(snap.counts).toEqual({ overdue: 5, thisWeek: 4, chased: 2, stale: 2, other: 10 });
    const sum = Object.values(snap.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(snap.tasks.length);
  });

  it('warnings 는 사라진 항목 1건', () => {
    expect(snap.warnings).toEqual([
      '앵커를 찾지 못함: 사라진 항목 (_private/mgmt/내 할 일.md / 존재하지 않는 문구)',
    ]);
  });

  it('pageCount 15(3a단계 fixture 포함 — templates/·.claude/ 도 센다)', () => {
    expect(snap.pageCount).toBe(15);
  });

  it('열린 것(open·wip)만 들어간다', () => {
    for (const t of snap.tasks) expect(['open', 'wip']).toContain(t.status);
  });

  it('overdueDays 는 기한이 지난 것(지남·30영업일 넘게 밀려 정리 대상으로 간 것)에만 있다', () => {
    for (const t of snap.tasks) {
      if (t.due !== undefined && t.due < TODAY) {
        expect(t.overdueDays, t.title).toBeTypeOf('number');
        expect(t.bucket, t.title).toBe((t.overdueDays as number) > 30 ? 'stale' : 'overdue');
      } else {
        expect(t.overdueDays, t.title).toBeUndefined();
      }
    }
  });

  it('지남 구간에는 30영업일 넘게 밀린 것이 없다(2단계 §4)', () => {
    for (const t of snap.tasks.filter((x) => x.bucket === 'overdue')) expect(t.overdueDays).toBeLessThanOrEqual(30);
  });
});

describe('정답표의 값', () => {
  it('1 LDAR 견적서 회신', () => {
    const t = task('LDAR 견적서 회신');
    expect(t).toMatchObject({ due: '2026-09-10', overdueDays: 9, group: 'over', kind: 'push', status: 'open' });
    expect(t.id).toBe('i:' + sha12('LDAR 견적서 회신'));
  });

  it('2 한결케미칼 통영공장 사용량 미반영 회신 (앵커)', () => {
    const t = task('한결케미칼 통영공장 사용량 미반영 회신');
    const lines = fs.readFileSync(path.join(FIXTURE, MY_TASKS), 'utf8').split(/\r?\n/);
    const lineNo = lines.findIndex((l) => l.includes('통영공장 인벤토리 사용량 미반영')) + 1;
    expect(t).toMatchObject({
      source: 'curated',
      status: 'open',
      due: '2026-09-18',
      overdueDays: 3,
      chaseCount: 2,
      openDays: 7,
      pri: 1,
      opened: '2026-09-15',
      thread: '통영공장 인벤토리 확인 요청',
      company: '한결케미칼',
      mail: HANGYEOL_MAIL,
      file: MY_TASKS,
      line: lineNo,
      rawLine: lines[lineNo - 1],
      memo: '배치 로그를 확인함. 8월 집계 누락은 마감일 경계 조건 때문으로 보임.\n재실행 일정은 연휴 전으로 잡음',
      group: 'now',
      kind: 'do',
      risk: 1,
      who: '한결케미칼 EHS팀',
    });
    expect(t.anchors).toEqual([{ file: MY_TASKS, match: '통영공장 인벤토리 사용량 미반영' }]);
    expect(t.id).toBe('i:' + sha12('한결케미칼 통영공장 사용량 미반영 회신'));
  });

  it('3 서진화학 EHS 잔여 오류 목록', () => {
    const t = task('서진화학 EHS 잔여 오류 목록 — 우선순위 회신');
    expect(t).toMatchObject({ due: '2026-09-21', overdueDays: 2, chaseCount: 4, company: '서진화학', file: MY_TASKS });
  });

  it('4 계약관리 권한 오류 수정', () => {
    const t = task('계약관리 권한 오류 수정 (26년 이전 계약 조회)');
    expect(t).toMatchObject({ due: '2026-09-22', overdueDays: 1, file: '_private/business/계약관리시스템.md' });
    expect(t.company).toBeUndefined();
  });

  it('5 팀 회의록 공유 (#내할일, 대상 밖 파일)', () => {
    const t = task('팀 회의록 공유, 사업부 채널에');
    expect(t).toMatchObject({ due: '2026-09-22', overdueDays: 1, file: '_private/mgmt/업무 현황 종합 분석.md' });
    expect(t.id).toBe('c:' + sha12('_private/mgmt/업무 현황 종합 분석.md|팀 회의록 공유 #내할일, 사업부 채널에'));
  });

  it('6 누리소재 MSDS 개정차수 반영', () => {
    const t = task('누리소재 MSDS 개정차수 반영 — 완료 예정일 회신');
    expect(t).toMatchObject({ due: '2026-09-23', company: '누리소재' });
  });

  it('7 법인카드 지출결의서 작성', () => {
    const t = task('법인카드 지출결의서 작성');
    expect(t).toMatchObject({ due: '2026-09-23', pri: 2 });
    expect(t.id).toBe('c:' + sha12(`${MY_TASKS}|법인카드 지출결의서 작성 #내할일`));
    expect(t.id).toBe('c:213ed98fa26d');
  });

  it('8 대륙물산 서버 교체 견적 방향 결정', () => {
    const t = task('대륙물산 서버 교체 견적 방향 결정');
    expect(t).toMatchObject({ due: '2026-09-24', source: 'curated', kind: 'dec' });
    expect(t.file).toBeUndefined();
  });

  it('9 주간 업무보고 작성', () => {
    expect(task('주간 업무보고 작성')).toMatchObject({ due: '2026-09-25' });
  });

  it('10 해온정밀 HR 연계 (FOLDER_PAGE 해온→해온정밀)', () => {
    const t = task('해온정밀 HR 연계 — 유지보수 범위 판단·회신');
    expect(t).toMatchObject({ chaseCount: 3, company: '해온정밀', openDays: 26 });
    expect(t.due).toBeUndefined();
  });

  it('11 VOC 장기건 메뉴별 오류 정리', () => {
    const t = task('VOC 장기건 메뉴별 오류 정리');
    expect(t).toMatchObject({ pri: 1 });
    expect(t.due).toBeUndefined();
  });

  it('4-1 오래 밀린 견적 검토 (기한 49영업일 지남 → 정리 대상)', () => {
    const t = task('오래 밀린 견적 검토');
    expect(t).toMatchObject({ bucket: 'stale', due: '2026-07-15', overdueDays: 49, pri: 2, status: 'open', file: MY_TASKS });
  });

  it('4-1 진행 메모가 있는 건 ([st:: 협의] 는 상태에 영향 없음)', () => {
    const t = task('진행 메모가 있는 건');
    expect(t).toMatchObject({ bucket: 'other', status: 'open', st: '협의', due: '2026-10-12', file: MY_TASKS });
    expect(t.overdueDays).toBeUndefined();
  });

  it('12 신규 고객사 명함 제출 (_미분류 → 업체 없음)', () => {
    const t = task('신규 고객사 명함 제출 (표준템플릿)');
    expect(t).toMatchObject({ openDays: 38, bucket: 'stale' });
    expect(t.company).toBeUndefined();
    expect(t.overdueDays).toBeUndefined();
  });

  it('13 월간 리포트 초안 작성 (wip)', () => {
    expect(task('월간 리포트 초안 작성')).toMatchObject({ due: '2026-09-30', status: 'wip' });
  });

  it('14 한결케미칼 연간 계약 갱신 검토 (엔티티 앵커)', () => {
    const t = task('한결케미칼 연간 계약 갱신 검토');
    expect(t).toMatchObject({
      due: '2026-09-30',
      company: '한결케미칼',
      source: 'curated',
      file: 'wiki/entities/한결케미칼.md',
      status: 'open',
    });
  });

  it('15 분기 법정교육 이수 (태그 없음, 대상 파일)', () => {
    expect(task('분기 법정교육 이수')).toMatchObject({ due: '2026-10-05', file: MY_TASKS });
  });

  it('16 사내 교육 수강신청 완료 (사내 조직은 엔티티 아님 → 폴더)', () => {
    expect(task('사내 교육 수강신청 완료')).toMatchObject({ due: '2026-10-07', company: '경영지원' });
  });

  it('17 담당자 교체 공지 확인 (엔티티)', () => {
    expect(task('담당자 교체 공지 확인')).toMatchObject({
      company: '한결케미칼',
      file: 'wiki/entities/한결케미칼.md',
      pri: 3,
    });
  });

  it('18 사라진 항목 (앵커 미발견)', () => {
    const t = task('사라진 항목');
    expect(t).toMatchObject({ status: 'open', source: 'curated' });
    expect(t.file).toBeUndefined();
  });

  it('19 인수인계서 검토·부족분 회신', () => {
    expect(task('인수인계서 검토·부족분 회신')).toMatchObject({ pri: 3 });
  });

  it('20 전략 검토 (메모)', () => {
    expect(task('전략 검토')).toMatchObject({ memo: '상무님 보고 후 결정', source: 'curated', group: 'str' });
  });

  it('21 큐레이션 진행 항목 (진행 로그)', () => {
    expect(task('큐레이션 진행 항목')).toMatchObject({ status: 'wip', source: 'curated' });
  });

  it('ID 는 형식이 맞고 모두 다르다', () => {
    const ids = snap.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of snap.tasks) {
      expect(t.id).toMatch(t.source === 'curated' ? /^i:[0-9a-f]{12}$/ : /^c:[0-9a-f]{12}$/);
    }
  });
});

describe('나오면 안 되는 것', () => {
  const forbidden = [
    '상반기 평가 작성',
    '백산 SSL 교통정리',
    '큐레이션 완료 항목',
    '큐레이션 위임 항목',
    '구간이 완료인 항목',
    'VOC-2026-1234', // g=voc — VOC 시스템에서 처리한다
    '백업 사본에만 있는 할 일',
    'raw 안의 체크박스',
    '계약 조회 권한 개선 배포',
    '태그 없는 메모 줄',
    '협의 끝난 건 정리', // [st:: 완료] → done (2단계 §4)
  ];
  it.each(forbidden)('%s', (needle) => {
    expect(snap.tasks.filter((t) => t.title.includes(needle))).toEqual([]);
  });

  it('앵커에 걸린 한결 통영 체크박스 줄은 따로 나오지 않는다(큐레이션 #2 에 합쳐짐)', () => {
    const tongyeong = snap.tasks.filter((t) => t.title.includes('통영') || t.rawLine?.includes('통영'));
    expect(tongyeong.map((t) => t.title)).toEqual(['한결케미칼 통영공장 사용량 미반영 회신']);
    expect(tongyeong[0].source).toBe('curated');
  });

  it('엔티티의 앵커 줄(연간 계약 갱신)도 따로 나오지 않는다', () => {
    const renew = snap.tasks.filter((t) => t.title.includes('연간 계약 갱신'));
    expect(renew.map((t) => t.source)).toEqual(['curated']);
  });

  it('제외 폴더(raw, _todo-sync)의 파일은 쓰지 않는다', () => {
    for (const t of snap.tasks) {
      if (t.file) expect(t.file).not.toMatch(/(^|\/)(raw|_todo-sync|backup)\//);
    }
  });
});

describe('주간 정보', () => {
  it('전부', () => {
    expect(snap.week).toEqual({
      today: '2026-09-23',
      monday: '2026-09-21',
      friday: '2026-09-25',
      days: [
        { date: '2026-09-21', label: '9/21', weekday: '월', isToday: false, isPast: true, isHoliday: false, dueCount: 0 },
        { date: '2026-09-22', label: '9/22', weekday: '화', isToday: false, isPast: true, isHoliday: false, dueCount: 0 },
        { date: '2026-09-23', label: '9/23', weekday: '수', isToday: true, isPast: false, isHoliday: false, dueCount: 2 },
        {
          date: '2026-09-24',
          label: '9/24',
          weekday: '목',
          isToday: false,
          isPast: false,
          isHoliday: true,
          holidayName: '추석',
          dueCount: 1,
        },
        {
          date: '2026-09-25',
          label: '9/25',
          weekday: '금',
          isToday: false,
          isPast: false,
          isHoliday: true,
          holidayName: '추석',
          dueCount: 1,
        },
      ],
      overdueCount: 5,
      nextBusinessDay: '2026-09-28',
      beforeHolidayBreak: true,
      breakName: '추석',
    });
  });
});

describe('스냅샷 머리', () => {
  it('wikiRoot·generatedAt', () => {
    expect(snap.wikiRoot).toBe(FIXTURE);
    expect(Number.isNaN(Date.parse(snap.generatedAt))).toBe(false);
  });

  it('두 번 만들어도 같은 결과(generatedAt 제외)', () => {
    const again = buildSnapshot({ wikiRoot: FIXTURE, today: TODAY, holidays: holidaysJson.holidays });
    expect({ ...again, generatedAt: '' }).toEqual({ ...snap, generatedAt: '' });
  });
});

describe('체크박스 메모는 두 이름으로 찾는다 (2단계 명세 §5)', () => {
  const temps: string[] = [];
  afterAll(() => {
    while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
  });

  /** 사본의 할 일 메모.md 끝에 절들을 붙이고 '법인카드 지출결의서 작성' 의 메모를 돌려준다 */
  function memoWith(sections: string): string | undefined {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-memo2-'));
    temps.push(root);
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.appendFileSync(path.join(root, '_private', 'mgmt', '할 일 메모.md'), sections, 'utf8');
    const s = buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
    return s.tasks.find((t) => t.title === '법인카드 지출결의서 작성')?.memo;
  }

  const bySync = '\n## 법인카드 지출결의서 작성 #내할일\n출처 `_private/mgmt/내 할 일.md`\n\n- 2026-09-22 · 동기화 제목 메모\n';
  const byTitle = '\n## 법인카드 지출결의서 작성\n- 2026-09-22 · 표시 제목 메모\n';

  it('① sync_todo 제목(핵심문구) 절', () => {
    expect(memoWith(bySync)).toBe('동기화 제목 메모');
  });

  it('② 표시 제목 절', () => {
    expect(memoWith(byTitle)).toBe('표시 제목 메모');
  });

  it('둘 다 있으면 ① 을 먼저 본다', () => {
    expect(memoWith(byTitle + bySync)).toBe('동기화 제목 메모');
    expect(memoWith(bySync + byTitle)).toBe('동기화 제목 메모');
  });

  it('70자 넘는 핵심문구는 앞 70자 + … 이름', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-memo2-'));
    temps.push(root);
    fs.cpSync(FIXTURE, root, { recursive: true });
    const core = '🔴 ' + '긴 할 일 문장 '.repeat(12) + '끝 #내할일';
    const todo = path.join(root, '_private', 'mgmt', '내 할 일.md');
    fs.writeFileSync(todo, fs.readFileSync(todo, 'utf8').replace('\n\n## 메일 회신 대기', `\n- [ ] ${core} [due:: 2026-10-20]\n\n## 메일 회신 대기`), 'utf8');
    const name = Array.from(core).slice(0, 70).join('') + '…';
    fs.appendFileSync(path.join(root, '_private', 'mgmt', '할 일 메모.md'), `\n## ${name}\n- 2026-09-22 · 긴 제목 메모\n`, 'utf8');
    const s = buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
    expect(s.tasks.find((t) => t.title.startsWith('긴 할 일 문장'))?.memo).toBe('긴 제목 메모');
  });
});
