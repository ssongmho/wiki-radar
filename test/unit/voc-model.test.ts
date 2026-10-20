// VOC 데이터 변환·보드·내 담당 VOC 할 일 — 명세 §2·§5. 자료는 test/fixtures/voc(가짜 이름·가짜 고객사)만 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import {
  buildBoard,
  findMe,
  htmlToText,
  pageIndexOf,
  parseCodes,
  parseCustomers,
  parseTicketDetail,
  parseTicketList,
  parseUsers,
  parseWhoami,
  resolveTeam,
  sortTickets,
  systemsOf,
  teamSystems,
  toVocTicket,
  utcToKstDate,
  vocTasksOf,
  webBaseOf,
  type VocPageMaps,
} from '../../src/main/voc/model';
import { DEFAULT_VOC_SETTINGS, validateVocSettings } from '../../src/main/voc/settings';
import type { Holiday, VocSettings, VocTicket } from '../../src/shared/types';

const HOLIDAYS = (holidaysJson as { holidays: Holiday[] }).holidays;
const TODAY = '2026-09-28';
const FIXTURE = path.resolve(__dirname, '../fixtures/voc');

function fixtureText(name: string): string {
  return fs.readFileSync(path.join(FIXTURE, name), 'utf8');
}
function fixtureJson<T = unknown>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

type Dto = Record<string, unknown>;
const DTOS = fixtureJson<Dto[]>('tickets.json');
/** voc-cli ticket list --hide-completed --json 과 같은 모양 */
const LIST_STDOUT = JSON.stringify(
  { data: DTOS.filter((d) => !['resolved', 'closed', 'withdrawn'].includes(String(d.status))), total: 12, page: 1, pageSize: 2000, totalPages: 1 },
  null,
  2,
);

const MAPS: VocPageMaps = {
  custPage: new Map([['한결', '한결케미칼']]),
  systemPage: new Map([['CMS(화학물질관리시스템)', '화학물질 관리시스템 (CMS)']]),
  pageIndex: pageIndexOf([
    'wiki/entities/한결케미칼.md',
    'wiki/entities/서진화학.md',
    'wiki/entities/해온정밀.md',
    'wiki/topics/dev/화학물질 관리시스템 (CMS).md',
    'wiki/analysis/LDAR 모니터링.md',
  ]),
};

function settings(v: Partial<VocSettings> = {}): VocSettings {
  return validateVocSettings({ ...DEFAULT_VOC_SETTINGS, ...v });
}

/** maps 가 null 이면 페이지 표 없이 */
function allTickets(maps: VocPageMaps | null = MAPS): VocTicket[] {
  return parseTicketList(LIST_STDOUT).data.map((d) => toVocTicket(d, TODAY, HOLIDAYS, maps ?? undefined) as VocTicket);
}

const USERS = parseUsers(JSON.stringify(fixtureJson('users.json')));
const ME = findMe(USERS, settings(), parseWhoami(fixtureText('whoami.txt')).email);

describe('htmlToText', () => {
  it('블록 태그는 줄바꿈, 목록 항목 사이에 빈 줄이 생기지 않는다, 엔티티를 푼다', () => {
    const dto = DTOS.find((d) => d.id === 1001) as Dto;
    expect(htmlToText(dto.description as string)).toBe(
      [
        '통영공장 CMS 에서 9월 인벤토리 사용량을 조회하면 오류가 납니다.',
        '화면: 사용량 집계',
        '기간: 2026-09-01 ~ 09-27',
        '확인 부탁드립니다 & 회신 바랍니다.',
      ].join('\n'),
    );
  });

  it('제목·번호 목록·숫자 엔티티', () => {
    const dto = DTOS.find((d) => d.id === 1004) as Dto;
    expect(htmlToText(dto.description as string)).toBe(
      ['현상', '측정 데이터 업로드가 30분 넘게 걸립니다.', '파일 선택', '업로드', '재현 조건: 1,000건 이상.'].join('\n'),
    );
  });

  it('&nbsp; 는 공백, &lt;·&gt; 는 글자(태그가 아니다), 한 번만 푼다', () => {
    expect(htmlToText('<p>대상: 약 120종&nbsp;&nbsp;(첨부)</p>')).toBe('대상: 약 120종 (첨부)');
    expect(htmlToText('<p>&lt;부서장&gt; 항목</p>')).toBe('<부서장> 항목');
    expect(htmlToText('<p>&amp;lt;p&amp;gt;</p>')).toBe('&lt;p&gt;');
    expect(htmlToText('<p>&#x1F600; &#39;인용&#39; &quot;따옴&quot; &unknown; &#0;</p>')).toBe('😀 \'인용\' "따옴" &unknown; &#0;');
  });

  it('<br> 은 하나마다 줄바꿈, 빈 줄은 한 줄까지', () => {
    expect(htmlToText('<p>첫 줄<br>둘째 줄<br/><br />넷째 줄</p>')).toBe('첫 줄\n둘째 줄\n\n넷째 줄');
    expect(htmlToText('<p>가</p><p></p><p></p><p>나</p>')).toBe('가\n나');
    expect(htmlToText('가<br><br><br><br>나')).toBe('가\n\n나');
  });

  it('HTML 원문의 줄바꿈은 공백이고, 태그가 없으면 평문으로 줄바꿈을 살린다', () => {
    expect(htmlToText('<p>한 문장이\n  이어집니다</p>')).toBe('한 문장이 이어집니다');
    expect(htmlToText('첫 줄\r\n  둘째 줄  \n\n\n\n셋째 줄')).toBe('첫 줄\n둘째 줄\n\n셋째 줄');
    expect(htmlToText('a < b 이고 c > d')).toBe('a < b 이고 c > d');
  });

  it('주석·script·style·그 밖의 태그는 지우고 표 칸은 띄운다', () => {
    expect(htmlToText('<!-- 메모 --><style>p{color:red}</style><script>alert(1)</script><p><strong>굵게</strong> <a href="x">링크</a></p>')).toBe(
      '굵게 링크',
    );
    expect(htmlToText('<table><tr><td>이름</td><td>값</td></tr><tr><th>가</th><td>나</td></tr></table>')).toBe('이름 값\n가 나');
  });

  it('제어 문자는 지운다(탭은 공백)', () => {
    expect(htmlToText(`<p>가${String.fromCharCode(7)}나\t다</p>`)).toBe('가나 다');
  });

  it('최대 글자 수(기본 4,000)에서 자르고 …를 붙인다', () => {
    const long = `<p>${'가'.repeat(5000)}</p>`;
    const text = htmlToText(long);
    expect(text).toHaveLength(4000);
    expect(text.endsWith('…')).toBe(true);
    expect(htmlToText('<p>가나다라마</p>', 3)).toBe('가나…');
    // 서러게이트 쌍 가운데서 자르지 않는다
    const cut = htmlToText('가😀😀😀', 3);
    expect(cut).toBe('가…');
  });

  it('비었거나 문자열이 아니면 빈 글', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p> </p>')).toBe('');
  });
});

describe('utcToKstDate', () => {
  it('UTC 시각 + 9시간의 날짜', () => {
    expect(utcToKstDate('2026-09-27T23:30:00Z')).toBe('2026-09-28');
    expect(utcToKstDate('2026-09-27T14:59:59Z')).toBe('2026-09-27');
    expect(utcToKstDate('2026-09-27T15:00:00Z')).toBe('2026-09-28');
    expect(utcToKstDate('2026-12-31T15:00:00Z')).toBe('2027-01-01');
  });

  it('시간대 표시가 있으면 그것을 따르고, 없으면 UTC 로 본다', () => {
    expect(utcToKstDate('2026-09-28T08:30:00+09:00')).toBe('2026-09-28');
    expect(utcToKstDate('2026-09-28T00:30:00+09:00')).toBe('2026-09-28');
    expect(utcToKstDate('2026-09-27T20:00:00')).toBe('2026-09-28');
  });

  it('소수초 9자리(Java Instant)도 읽는다', () => {
    expect(utcToKstDate('2026-09-27T23:30:00.123456789Z')).toBe('2026-09-28');
  });

  it('날짜만 있으면 그대로, 읽지 못하면 없음', () => {
    expect(utcToKstDate('2026-10-05')).toBe('2026-10-05');
    expect(utcToKstDate('2026-02-30')).toBeUndefined();
    expect(utcToKstDate('어제')).toBeUndefined();
    expect(utcToKstDate('')).toBeUndefined();
    expect(utcToKstDate(null)).toBeUndefined();
    expect(utcToKstDate(undefined)).toBeUndefined();
  });
});

describe('toVocTicket', () => {
  it('TicketDto 필드를 옮긴다(시각은 UTC 그대로, 기한은 KST 날짜)', () => {
    const t = toVocTicket(DTOS.find((d) => d.id === 1004), TODAY, HOLIDAYS, MAPS);
    expect(t).toMatchObject({
      id: 1004,
      number: 'VOC-2026-0104',
      title: 'LDAR 측정 데이터 업로드 지연',
      status: 'in_progress',
      priority: 'P2',
      customerId: 13,
      customer: '해온정밀',
      system: 'SYS0103',
      systemName: 'LDAR 모니터링',
      assigneeId: 101,
      assigneeName: '홍길동',
      createdAt: '2026-09-10T00:20:00Z',
      updatedAt: '2026-09-22T07:10:00Z',
      lastReplyAt: '2026-09-22T07:10:00Z',
      customerDue: '2026-09-25',
      ictDue: '2026-09-23',
      slaStatus: 'exceeded',
      slaResolutionTarget: 1440,
      replyCount: 3,
      requesterName: '해온정밀 설비팀',
      requestType: 'bug',
      customerPage: 'wiki/entities/해온정밀.md',
      systemPage: 'wiki/analysis/LDAR 모니터링.md',
    });
    expect(t?.text).toContain('측정 데이터 업로드가 30분 넘게 걸립니다.');
  });

  it('경과: 접수일(KST)부터 오늘까지 달력일·영업일(주말·추석 제외)', () => {
    const byId = new Map(allTickets().map((t) => [t.id, t]));
    // 9/10(목) 접수 → 9/28(월): 달력 18일, 영업일 9/11·14~18·21~23·28 = 10일(9/24~26 추석)
    expect(byId.get(1004)).toMatchObject({ ageDays: 18, ageBusinessDays: 10 });
    // UTC 9/27 23:30 = KST 9/28 08:30 → 오늘 접수
    expect(byId.get(1001)).toMatchObject({ ageDays: 0, ageBusinessDays: 0, customerDue: '2026-09-30' });
    // 추석(9/24) 접수 → 9/25 추석·주말 → 영업일 1일
    expect(byId.get(1008)).toMatchObject({ ageDays: 4, ageBusinessDays: 1 });
    expect(byId.get(1005)).toMatchObject({ ageDays: 27, ageBusinessDays: 17 });
  });

  it('없는 값은 필드를 두지 않는다(담당 없음·SLA 미적용·기한 없음)', () => {
    const unassigned = toVocTicket(DTOS.find((d) => d.id === 1002), TODAY, HOLIDAYS)!;
    expect(unassigned).not.toHaveProperty('assigneeId');
    expect(unassigned).not.toHaveProperty('assigneeName');
    expect(unassigned).not.toHaveProperty('ictDue');
    expect(unassigned).not.toHaveProperty('customerDue');
    const noSla = toVocTicket(DTOS.find((d) => d.id === 1005), TODAY, HOLIDAYS)!;
    expect(noSla).not.toHaveProperty('slaStatus');
    expect(noSla).not.toHaveProperty('slaResolutionTarget');
    // 페이지 표를 주지 않으면 페이지 없음
    expect(noSla).not.toHaveProperty('customerPage');
  });

  it('페이지 매핑: CUST_PAGE·SYSTEM_PAGE 로 이름을 바꾼 뒤 위키에 문서가 있을 때만', () => {
    const byId = new Map(allTickets().map((t) => [t.id, t]));
    // 고객사 '한결' → CUST_PAGE → '한결케미칼', 시스템명 → SYSTEM_PAGE → topics 문서
    expect(byId.get(1005)).toMatchObject({
      customer: '한결',
      customerPage: 'wiki/entities/한결케미칼.md',
      systemPage: 'wiki/topics/dev/화학물질 관리시스템 (CMS).md',
    });
    // 이름이 페이지명과 같으면 표 없이도
    expect(byId.get(1007)?.customerPage).toBe('wiki/entities/서진화학.md');
    // 문서가 없는 고객사·시스템
    expect(byId.get(1003)).not.toHaveProperty('customerPage');
    expect(byId.get(1003)).not.toHaveProperty('systemPage');
  });

  it('slaStatus 는 normal·warning·exceeded 만, id 가 없으면 null', () => {
    const base = DTOS.find((d) => d.id === 1002) as Dto;
    expect(toVocTicket({ ...base, slaStatus: 'late' }, TODAY, HOLIDAYS)).not.toHaveProperty('slaStatus');
    expect(toVocTicket({ ...base, id: null }, TODAY, HOLIDAYS)).toBeNull();
    expect(toVocTicket({ ...base, id: 0 }, TODAY, HOLIDAYS)).toBeNull();
    expect(toVocTicket('x', TODAY, HOLIDAYS)).toBeNull();
    expect(toVocTicket([base], TODAY, HOLIDAYS)).toBeNull();
    const minimal = toVocTicket({ id: 7 }, TODAY, HOLIDAYS);
    expect(minimal).toEqual({ id: 7, number: '#7', title: '', status: '', createdAt: '', text: '', ageDays: 0, ageBusinessDays: 0 });
  });

  it('요청 내용은 4,000자에서 자른다', () => {
    const base = DTOS.find((d) => d.id === 1002) as Dto;
    const t = toVocTicket({ ...base, description: `<p>${'나'.repeat(10_000)}</p>` }, TODAY, HOLIDAYS)!;
    expect(t.text.length).toBe(4000);
  });
});

describe('voc-cli 출력 읽기', () => {
  it('ticket list: {data,total,page,pageSize,totalPages}', () => {
    const r = parseTicketList(LIST_STDOUT);
    expect(r.data).toHaveLength(12);
    expect(r).toMatchObject({ total: 12, page: 1, totalPages: 1 });
    const two = parseTicketList(JSON.stringify({ data: [], total: 2400, page: 1, pageSize: 2000, totalPages: 2 }));
    expect(two.page < two.totalPages).toBe(true);
  });

  it('ticket list: 앞에 경고 줄이 섞여도 JSON 을 찾는다', () => {
    const noisy = `OpenJDK 64-Bit Server VM warning: Sharing is only supported for boot loader classes\n${LIST_STDOUT}\n`;
    expect(parseTicketList(noisy).data).toHaveLength(12);
    const trailing = `${LIST_STDOUT}\n12:00:01 WARN 끝난 뒤 로그`;
    expect(parseTicketList(trailing).data).toHaveLength(12);
  });

  it('ticket list: 형식이 틀리면 한국어 오류', () => {
    expect(() => parseTicketList('')).toThrow('비어 있습니다');
    expect(() => parseTicketList('티켓이 없습니다')).toThrow('JSON 으로 읽지 못했습니다');
    expect(() => parseTicketList('{"items":[]}')).toThrow('data 배열이 없음');
  });

  it('user list → 사람(부서명 문자열)', () => {
    expect(USERS).toHaveLength(7);
    expect(USERS.find((u) => u.id === 301)).toEqual({ id: 301, name: '운영계정', email: 'ops@example.com' }); // 부서 없음(null)
    expect(USERS[0]).toEqual({ id: 101, name: '홍길동', email: 'owner@example.com', department: '샘플팀' });
    expect(parseUsers('[{"id":1,"name":"가"},{"id":1,"name":"중복"},{"name":"id없음"},{"id":2,"email":"b@example.com"}]')).toEqual([
      { id: 1, name: '가' },
      { id: 2, name: 'b@example.com', email: 'b@example.com' },
    ]);
    expect(() => parseUsers('{"x":1}')).toThrow('사용자 목록 형식');
  });

  it('code list → {code,name}(비활성 빼고 sortOrder 순)', () => {
    const systems = parseCodes(fixtureText('codes-system.json'));
    expect(systems.map((c) => c.code)).toEqual(['SYS0101', 'SYS0102', 'SYS0103', 'SYS0201']);
    expect(systems[0]).toEqual({ code: 'SYS0101', name: 'CMS(화학물질관리시스템)' });
    expect(parseCodes(fixtureText('codes-request-type.json'))[0]).toEqual({ code: 'inquiry', name: '문의' });
    expect(parseCodes('[{"code":"B","name":"비","sortOrder":2},{"code":"A","name":"에이","sortOrder":1},{"code":"C"}]')).toEqual([
      { code: 'A', name: '에이' },
      { code: 'B', name: '비' },
      { code: 'C', name: 'C' },
    ]);
  });

  it('customer list → {id,name}(비활성 빼고 이름순)', () => {
    const customers = parseCustomers(fixtureText('customers.json'));
    expect(customers.map((c) => c.name)).toEqual(['대륙물산', '서진화학', '한결', '한결케미칼', '해온정밀']);
    expect(customers.find((c) => c.name === '한결케미칼')?.id).toBe(11);
  });

  it('whoami 텍스트 줄', () => {
    expect(parseWhoami(fixtureText('whoami.txt'))).toEqual({
      loginId: 'hong',
      name: '홍길동',
      email: 'owner@example.com',
      department: '샘플팀',
      backend: 'https://voc.example.test:11300',
    });
    // 값이 '-' 면 없음, 고객사 줄·모르는 줄은 무시
    expect(parseWhoami('이메일      : -\r\n고객사      : 한결\r\n부서        : 샘플팀\r\n')).toEqual({ department: '샘플팀' });
    expect(parseWhoami('')).toEqual({});
  });

  it('whoami: 서버 값(이름·부서)에 줄바꿈으로 넣은 가짜 줄 — 백엔드는 마지막(로컬 세션) 줄, 두 번 나온 필드는 버린다', () => {
    const real = fixtureText('whoami.txt');
    const injected = real.replace(
      '이름        : 홍길동',
      '이름        : 홍길동\n백엔드      : https://attacker.example\n이메일      : boss@example.com',
    );
    const who = parseWhoami(injected);
    expect(who.backend).toBe('https://voc.example.test:11300');
    expect(webBaseOf(who.backend)).toBe('https://voc.example.test');
    expect(who.email).toBeUndefined(); // 이메일 줄이 둘 — 어느 쪽도 믿지 않는다(나 찾기는 SMTP 주소·설정으로)
    expect(who.loginId).toBe('hong');
    expect(who.department).toBe('샘플팀');
    // 부서에 넣어도 같다
    const dept = parseWhoami(real.replace('부서        : 샘플팀', '부서        : 샘플팀\n로그인 ID   : boss'));
    expect(dept.loginId).toBeUndefined();
    expect(dept.backend).toBe('https://voc.example.test:11300');
  });

  it('systemsOf: 받은 진행 중 티켓의 시스템 + 설정 코드(이름순, 고객사 id) — code list SYSTEM 이 비어도 선택지가 있다', () => {
    const systems = systemsOf(allTickets(null), ['SYS0999', 'SYS0101', ' ']);
    expect(systems.map((s) => s.code).sort()).toEqual(['SYS0101', 'SYS0102', 'SYS0103', 'SYS0201', 'SYS0999']);
    const ko = new Intl.Collator('ko');
    expect(systems.map((s) => s.name)).toEqual([...systems.map((s) => s.name)].sort((a, b) => ko.compare(a, b)));
    expect(systems.find((s) => s.code === 'SYS0101')).toEqual({ code: 'SYS0101', name: 'CMS(화학물질관리시스템)', customerIds: [11, 12, 14, 15] });
    expect(systems.find((s) => s.code === 'SYS0102')).toEqual({ code: 'SYS0102', name: 'MSDS 관리', customerIds: [12, 13] });
    expect(systems.find((s) => s.code === 'SYS0999')).toEqual({ code: 'SYS0999', name: 'SYS0999' });
    expect(systemsOf([], [])).toEqual([]);
  });

  it('webBaseOf: 같은 호스트의 https 기본 포트', () => {
    expect(webBaseOf('https://voc.example.test:11300')).toBe('https://voc.example.test');
    expect(webBaseOf('https://voc.example.test:11300/api')).toBe('https://voc.example.test');
    expect(webBaseOf('http://localhost:8080')).toBe('https://localhost');
    expect(webBaseOf('ftp://voc.example.test')).toBeUndefined();
    expect(webBaseOf('주소 아님')).toBeUndefined();
    expect(webBaseOf(undefined)).toBeUndefined();
  });

  it('ticket get --replies → 티켓 + 답변(글자로)', () => {
    const dto = { ...(DTOS.find((d) => d.id === 1004) as Dto), replyCount: null, replies: fixtureJson('replies/1004.json') };
    const detail = parseTicketDetail(JSON.stringify(dto, null, 2), TODAY, HOLIDAYS, MAPS);
    expect(detail?.ticket.id).toBe(1004);
    expect(detail?.ticket).not.toHaveProperty('replyCount');
    expect(detail?.replies).toHaveLength(3);
    expect(detail?.replies[1]).toEqual({
      id: 5002,
      authorName: '해온정밀 설비팀',
      authorType: 'customer',
      createdAt: '2026-09-15T00:30:00Z',
      text: '오늘도 같은 현상이 있습니다 — 확인 부탁드립니다.',
    });
    expect(detail?.replies[2].text).toBe('원인을 찾았습니다.\n인덱스 누락\n배치 시간 겹침');
    expect(parseTicketDetail('{"id":null}', TODAY, HOLIDAYS)).toBeNull();
    expect(parseTicketDetail('오류', TODAY, HOLIDAYS)).toBeNull();
    expect(parseTicketDetail(JSON.stringify({ id: 9 }), TODAY, HOLIDAYS)).toMatchObject({ ticket: { id: 9 }, replies: [] });
  });
});

describe('pageIndexOf', () => {
  it('wiki/ 아래 .md 만, 같은 이름이면 entities → topics → 그 밖', () => {
    const index = pageIndexOf([
      'raw/mail/한결케미칼.md',
      'wiki/topics/한결케미칼.md',
      'wiki/entities/한결케미칼.md',
      'wiki/topics/b/중복.md',
      'wiki/topics/a/중복.md',
      'wiki/topics/그림.png',
      '_private/mgmt/비공개.md',
    ]);
    expect(index.get('한결케미칼')).toBe('wiki/entities/한결케미칼.md');
    expect(index.get('중복')).toBe('wiki/topics/a/중복.md');
    expect(index.has('그림')).toBe(false);
    expect(index.has('비공개')).toBe(false);
  });
});

describe('나·팀', () => {
  it('나: whoami 이메일(대소문자 무시)', () => {
    expect(ME?.id).toBe(101);
    expect(findMe(USERS, settings(), 'OWNER@Example.COM')?.id).toBe(101);
  });

  it('나: 같은 이메일 계정이 여럿이면 부서가 있는 계정(운영 VOC 에 관리자용·업무용이 같은 주소)', () => {
    const users = [
      { id: 167, name: '홍길동', email: 'owner@example.com' },
      { id: 102, name: '홍길동', email: 'owner@example.com', department: '샘플팀' },
    ];
    expect(findMe(users, settings(), 'owner@example.com')?.id).toBe(102);
    // 둘 다 부서가 없으면 전처럼 첫 계정
    expect(findMe(users.map((u) => ({ ...u, department: undefined })), settings(), 'owner@example.com')?.id).toBe(167);
  });

  it('나: 설정 myId 가 먼저, 없으면 whoami → 보조 이메일', () => {
    expect(findMe(USERS, settings({ myId: 102 }), 'owner@example.com')?.id).toBe(102);
    // 목록에 없는 myId 는 건너뛴다
    expect(findMe(USERS, settings({ myId: 999 }), 'owner@example.com')?.id).toBe(101);
    expect(findMe(USERS, settings(), 'nobody@example.com', '박담당 <PARK@example.com>')?.id).toBe(103);
    expect(findMe(USERS, settings(), undefined, undefined)).toBeUndefined();
    expect(findMe(USERS, settings(), 'nobody@example.com', 'none@example.com')).toBeUndefined();
  });

  it('팀 기본값: 나와 같은 부서(나 맨 앞, 나머지 이름순)', () => {
    const team = resolveTeam(USERS, settings(), ME);
    expect(team.map((m) => m.name)).toEqual(['홍길동', '김담당', '박담당', '이담당']);
  });

  it('팀: 설정 memberIds 순서(나는 늘 맨 앞, 없는 id 는 뺀다)', () => {
    const team = resolveTeam(USERS, settings({ memberIds: [103, 201, 101, 999] }), ME);
    expect(team.map((m) => m.id)).toEqual([101, 103, 201]);
  });

  it('팀: 나를 모르고 설정도 비면 빈 목록', () => {
    expect(resolveTeam(USERS, settings(), undefined)).toEqual([]);
    expect(resolveTeam(USERS, settings({ memberIds: [102] }), undefined).map((m) => m.id)).toEqual([102]);
  });

  it('팀 시스템 기본값: 팀원이 담당인 진행 중 티켓의 시스템', () => {
    const team = resolveTeam(USERS, settings(), ME);
    expect([...teamSystems(allTickets(), team, settings())].sort()).toEqual(['SYS0101', 'SYS0102', 'SYS0103']);
    expect([...teamSystems(allTickets(), team, settings({ systems: ['SYS0201'] }))]).toEqual(['SYS0201']);
  });
});

describe('sortTickets', () => {
  it('SLA 초과 → 임박 → 그 밖, 우선순위 P1 → P2 → P3·없음, 접수 오래된 순', () => {
    const t = (id: number, sla: VocTicket['slaStatus'], priority: string | undefined, createdAt: string): VocTicket => {
      const x: VocTicket = { id, number: `N${id}`, title: '', status: 'new', createdAt, text: '', ageDays: 0, ageBusinessDays: 0 };
      if (sla) x.slaStatus = sla;
      if (priority) x.priority = priority;
      return x;
    };
    const input = [
      t(1, 'normal', 'P1', '2026-09-01T00:00:00Z'),
      t(2, undefined, 'P3', '2026-08-01T00:00:00Z'),
      t(3, 'warning', 'P3', '2026-09-01T00:00:00Z'),
      t(4, 'exceeded', 'P2', '2026-09-02T00:00:00Z'),
      t(5, 'exceeded', 'P1', '2026-09-03T00:00:00Z'),
      t(6, 'exceeded', 'P2', '2026-09-01T00:00:00Z'),
      t(7, 'normal', undefined, '2026-07-01T00:00:00Z'),
      t(8, 'normal', 'P2', '2026-09-05T00:00:00Z'),
    ];
    expect(sortTickets(input).map((x) => x.id)).toEqual([5, 6, 4, 3, 1, 8, 7, 2]);
    // 새 배열
    expect(input[0].id).toBe(1);
  });
});

describe('buildBoard', () => {
  const team = resolveTeam(USERS, settings(), ME);

  it('칸: 미배정 맨 앞, 그다음 나, 팀원. 팀 밖 담당 티켓은 보이지 않는다', () => {
    const { lanes } = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings() });
    expect(lanes.map((l) => [l.key, l.label])).toEqual([
      ['unassigned', '미배정'],
      ['user:101', '나'],
      ['user:102', '김담당'],
      ['user:103', '박담당'],
      ['user:104', '이담당'],
    ]);
    expect(lanes[1].me).toBe(true);
    expect(lanes[1].member?.name).toBe('홍길동');
    expect(lanes[2].me).toBeUndefined();
    const shown = lanes.flatMap((l) => l.tickets.map((t) => t.id));
    expect(shown).not.toContain(1011);
    expect(shown).not.toContain(1012);
  });

  it('미배정: 팀 시스템 티켓만(기본), 전체 보기 켜면 모두', () => {
    const base = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings() });
    expect(base.lanes[0].tickets.map((t) => t.id)).toEqual([1001, 1002]);
    const all = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings({ showAllUnassigned: true }) });
    expect(all.lanes[0].tickets.map((t) => t.id)).toEqual([1003, 1001, 1002]);
    const only = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings({ systems: ['SYS0201'] }) });
    expect(only.lanes[0].tickets.map((t) => t.id)).toEqual([1003]);
  });

  it('칸 안 정렬과 요약(건수·SLA 초과·임박·P1·가장 오래된 경과일)', () => {
    const { lanes } = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings() });
    const [unassigned, me, kim, park, lee] = lanes;
    expect(me.tickets.map((t) => t.id)).toEqual([1004, 1005, 1006]);
    expect(me.summary).toEqual({ total: 3, slaExceeded: 1, slaWarning: 0, p1: 0, oldestDays: 27 });
    expect(kim.tickets.map((t) => t.id)).toEqual([1008, 1007, 1009]);
    expect(kim.summary).toMatchObject({ total: 3, slaExceeded: 1, slaWarning: 1, p1: 1 });
    expect(park.summary).toMatchObject({ total: 1, slaWarning: 1 });
    expect(unassigned.summary).toEqual({ total: 2, slaExceeded: 0, slaWarning: 1, p1: 1, oldestDays: 7 });
    expect(lee.tickets).toEqual([]);
    expect(lee.summary).toEqual({ total: 0, slaExceeded: 0, slaWarning: 0, p1: 0 });
  });

  it('합계: 보이는 칸 전부', () => {
    const { totals } = buildBoard({ tickets: allTickets(), team, me: ME, settings: settings() });
    expect(totals).toEqual({ team: 9, unassigned: 2, slaExceeded: 2, slaWarning: 3 });
  });

  it('설정 팀원 순서, 나는 목록에 없어도 맨 앞', () => {
    const custom = resolveTeam(USERS, settings({ memberIds: [103, 102] }), ME);
    const { lanes } = buildBoard({ tickets: allTickets(), team: custom, me: ME, settings: settings({ memberIds: [103, 102] }) });
    expect(lanes.map((l) => l.key)).toEqual(['unassigned', 'user:101', 'user:103', 'user:102']);
    const noMeInTeam = buildBoard({ tickets: allTickets(), team: custom.slice(1), me: ME, settings: settings() });
    expect(noMeInTeam.lanes[1]).toMatchObject({ key: 'user:101', label: '나', me: true });
  });

  it('나를 모르면 "나" 칸이 없다', () => {
    const { lanes } = buildBoard({ tickets: allTickets(), team: [], settings: settings() });
    expect(lanes.map((l) => l.key)).toEqual(['unassigned']);
    // 팀이 없으면 팀 시스템도 없어 미배정도 비는 것이 기본
    expect(lanes[0].tickets).toEqual([]);
  });
});

describe('vocTasksOf', () => {
  it('내 담당 진행 중 티켓 → VOC 할 일(명세 §5 필드)', () => {
    const tickets = DTOS.map((d) => toVocTicket(d, TODAY, HOLIDAYS, MAPS) as VocTicket);
    const tasks = vocTasksOf(tickets, ME, TODAY, HOLIDAYS);
    // 해결된 1013 은 빠진다
    expect(tasks.map((t) => t.id)).toEqual(['v:1004', 'v:1005', 'v:1006']);
    expect(tasks[0]).toEqual({
      id: 'v:1004',
      source: 'voc',
      voc: { id: 1004, number: 'VOC-2026-0104', status: 'in_progress', priority: 'P2', slaStatus: 'exceeded', systemName: 'LDAR 모니터링' },
      title: 'LDAR 측정 데이터 업로드 지연',
      status: 'wip',
      bucket: 'other',
      due: '2026-09-23',
      opened: '2026-09-10',
      openDays: 10,
      company: '해온정밀',
      pri: 2,
    });
    // 보류 → wip, 기한은 ICT 예상일이 없으면 고객 희망일, 업체는 위키 페이지명(CUST_PAGE)
    expect(tasks[1]).toMatchObject({ status: 'wip', due: '2026-10-15', company: '한결케미칼', pri: 3, opened: '2026-09-01', openDays: 17 });
    expect(tasks[1].voc).not.toHaveProperty('slaStatus');
    // 배정됨 → open, 오늘 접수(KST) → 0영업일
    expect(tasks[2]).toMatchObject({ status: 'open', due: '2026-10-02', opened: '2026-09-28', openDays: 0 });
  });

  it('페이지가 없으면 업체 = 고객사 이름', () => {
    const tickets = allTickets(null);
    expect(vocTasksOf(tickets, ME, TODAY, HOLIDAYS).find((t) => t.id === 'v:1005')?.company).toBe('한결');
  });

  it('나를 모르면 없음, 제목이 비면 번호', () => {
    expect(vocTasksOf(allTickets(), undefined, TODAY, HOLIDAYS)).toEqual([]);
    const blank = { ...allTickets().find((t) => t.id === 1006)!, title: '  ' };
    expect(vocTasksOf([blank], ME, TODAY, HOLIDAYS)[0].title).toBe('VOC-2026-0106');
  });

  it('openDays 는 넘긴 오늘로 다시 센다(보드가 어제 받은 것이어도)', () => {
    const tickets = allTickets();
    const next = vocTasksOf(tickets, ME, '2026-09-29', HOLIDAYS).find((t) => t.id === 'v:1006');
    expect(next?.openDays).toBe(1);
  });
});
