// renderer VOC 보드 순수 함수(2.6단계 명세 §3·§4·§7 — src/renderer/lib/voc.ts) 시험:
// 이름표·표식·기한·경과·조사, main 응답 다듬기, 머리·띠·사이드바 문구, 칸 요약, 선택·초점 요청, 확인 대화상자 문구, 결과 알림, 설정 검사.
// 사람·고객사 이름은 가짜(홍길동·김담당·박담당·이담당·최외부, 한결케미칼·서진화학)만 쓴다.
import { describe, expect, it } from 'vitest';
import type { VocBoard, VocLane, VocMember, VocTicket } from '../../src/shared/types';
import { FOCUS_VOC_LOGIN, FOCUS_VOC_VIEW, vocFocusId } from '../../src/renderer/api';
import * as V from '../../src/renderer/lib/voc';
import { VOC_EXPIRED_MESSAGE, VOC_LOGIN_MESSAGE } from '../../src/main/voc/cli';

const TODAY = '2026-09-28';

const me: VocMember = { id: 11, name: '홍길동', email: 'hong@example.com', department: '운영2팀' };
const kim: VocMember = { id: 12, name: '김담당', email: 'kim@example.com', department: '운영2팀' };
const park: VocMember = { id: 13, name: '박담당', email: 'park@example.com', department: '운영2팀' };
const lee: VocMember = { id: 14, name: '이담당', department: '운영1팀' };
const choi: VocMember = { id: 15, name: '최외부' };

const ticket = (p: Partial<VocTicket> = {}): VocTicket => ({
  id: 101,
  number: 'VOC-2026-0101',
  title: 'CMS 인벤토리 사용량 조회 오류',
  status: 'new',
  priority: 'P2',
  customer: '한결케미칼',
  system: 'SYS0048',
  systemName: 'CMS',
  createdAt: '2026-09-21T06:04:00Z',
  text: '사용량 화면에서 합계가 다르게 나옵니다.',
  ageDays: 7,
  ageBusinessDays: 5,
  ...p,
});

const lane = (key: string, tickets: VocTicket[], p: Partial<VocLane> = {}): VocLane => ({
  key,
  label: key === 'unassigned' ? '미배정' : key,
  tickets,
  summary: V.summarizeTickets(tickets),
  ...p,
});

const board = (p: Partial<VocBoard> = {}): VocBoard => {
  const lanes = p.lanes ?? [
    lane('unassigned', [ticket(), ticket({ id: 102, number: 'VOC-2026-0102', slaStatus: 'exceeded', priority: 'P1', ageDays: 12 })]),
    lane('user:11', [ticket({ id: 103, number: 'VOC-2026-0103', status: 'in_progress', assigneeId: 11, assigneeName: '홍길동' })], {
      label: '나',
      member: me,
      me: true,
    }),
    lane('user:12', [], { label: '김담당', member: kim }),
  ];
  return { state: 'ok', fetchedAt: '2026-09-28T01:32:00.000Z', lanes, totals: V.totalsOf(lanes), me, ...p };
};

describe('이름표·표식', () => {
  it('VOC 상태·요청유형을 한국어로(모르는 값은 그대로)', () => {
    expect(V.vocStatusLabel('in_progress')).toBe('진행 중');
    expect(V.vocStatusLabel('pending')).toBe('보류');
    expect(V.vocStatusLabel('weird')).toBe('weird');
    expect(V.vocStatusLabel(undefined)).toBe('상태 없음');
    expect(V.vocStatusText('new')).toBe('신규(new)');
    expect(V.vocStatusText('odd')).toBe('odd');
    expect(V.requestTypeLabel('inquiry')).toBe('문의');
    expect(V.requestTypeLabel('오류')).toBe('오류');
    expect(V.requestTypeLabel('')).toBeUndefined();
  });

  it('우선순위 표식: P1 앰버 · P3 흐림 · 그 밖은 —', () => {
    expect(V.priorityMark('P1')).toEqual({ text: 'P1', tone: 'amber', label: '우선순위 P1' });
    expect(V.priorityMark('P2')).toEqual({ text: 'P2', tone: undefined, label: '우선순위 P2' });
    expect(V.priorityMark('P3').tone).toBe('muted');
    expect(V.priorityMark('medium')).toEqual({ text: '—', tone: 'muted', label: '우선순위 medium' });
    expect(V.priorityMark(undefined).label).toBe('우선순위 없음');
  });

  it('SLA 표식: 초과 코랄 · 임박 앰버 · 정상 · 미적용(null)', () => {
    expect(V.slaMark('exceeded')).toMatchObject({ text: 'SLA 초과', tone: 'coral' });
    expect(V.slaMark('warning')).toMatchObject({ text: 'SLA 임박', tone: 'amber' });
    expect(V.slaMark('normal')).toMatchObject({ text: 'SLA 정상' });
    expect(V.slaMark(null)).toBeNull();
    expect(V.slaKey('other')).toBe('none');
  });

  it('해결 목표(분) → 시간', () => {
    expect(V.slaTargetText(2880)).toBe('목표 48시간');
    expect(V.slaTargetText(90)).toBe('목표 1시간 30분');
    expect(V.slaTargetText(45)).toBe('목표 45분');
    expect(V.slaTargetText(0)).toBeUndefined();
    expect(V.slaTargetText('x')).toBeUndefined();
  });

  it('경과 · 날짜 · KST 시각', () => {
    expect(V.ageText(3)).toBe('3일째');
    expect(V.ageText(0)).toBe('오늘 접수');
    expect(V.dateText('2026-10-05', TODAY)).toBe('10월 5일(월)');
    expect(V.dateText('2027-01-04', TODAY)).toBe('2027년 1월 4일(월)');
    // UTC 06:04 = KST 15:04, UTC 전날 16:30 = KST 01:30(날이 바뀐다)
    expect(V.kstDateTimeText('2026-09-21T06:04:00Z', TODAY)).toBe('9월 21일 오후 3:04');
    expect(V.kstDateTimeText('2026-09-20T16:30:00Z', TODAY)).toBe('9월 21일 오전 1:30');
    expect(V.kstDateTimeText(undefined, TODAY)).toBe('');
  });

  it('기한: ICT 예상일 우선, 없으면 고객 희망일, 지났으면 지남', () => {
    expect(V.vocDue({ ictDue: '2026-10-05', customerDue: '2026-09-30' }, TODAY)).toEqual({
      date: '2026-10-05',
      kind: 'ict',
      short: '예상 10/5',
      long: 'ICT 예상완료일 10월 5일(월)',
      overdue: false,
    });
    const past = V.vocDue({ customerDue: '2026-09-25' }, TODAY);
    expect(past).toMatchObject({ kind: 'customer', short: '희망 9/25 지남', overdue: true });
    expect(past?.long).toBe('고객 희망일 9월 25일(금) — 지남');
    expect(V.vocDue({ ictDue: TODAY }, TODAY)?.overdue).toBe(false);
    expect(V.vocDue({}, TODAY)).toBeNull();
  });

  it('조사: 받침·숫자 읽기에 맞춘다', () => {
    expect(V.objectParticle('VOC-2026-0001')).toBe('을'); // 일
    expect(V.objectParticle('VOC-2026-0002')).toBe('를'); // 이
    expect(V.objectParticle('VOC-2026-0010')).toBe('을'); // 십
    expect(V.objectParticle('홍길동')).toBe('을');
    expect(V.objectParticle('나(홍길동)')).toBe('를'); // 괄호 앞 '나'
    expect(V.objectParticle('abc')).toBe('을(를)');
    expect(V.directionParticle('10/5')).toBe('로');
    expect(V.directionParticle('10/3')).toBe('으로');
    expect(V.directionParticle('10/1')).toBe('로'); // ㄹ 받침
    expect(V.directionParticle('10/10')).toBe('으로');
    expect(V.directionParticle('진행 중(in_progress)')).toBe('으로');
    expect(V.directionParticle('보류(pending)')).toBe('로');
  });
});

describe('main 응답 다듬기', () => {
  it('모양이 틀린 보드는 unavailable 로', () => {
    expect(V.normalizeVocBoard(null)).toMatchObject({ state: 'unavailable', lanes: [], totals: { team: 0, unassigned: 0 } });
    expect(V.normalizeVocBoard({ state: 'weird' }).state).toBe('unavailable');
  });

  it('칸·티켓을 거르고, 요약·합계가 없으면 센다', () => {
    const raw = {
      state: 'ok',
      fetchedAt: '2026-09-28T01:32:00Z',
      lanes: [
        {
          key: 'unassigned',
          tickets: [
            { id: 1, number: 'VOC-1', title: 'a', status: 'new', slaStatus: 'exceeded', priority: 'P1', ageDays: 4, createdAt: 'x', text: '' },
            { id: 1, number: 'VOC-1 중복' },
            { number: 'id 없음' },
            { id: 2, number: 'VOC-2', slaStatus: 'warning', ageDays: 9, ictDue: '2026-13-01', customerPage: '../밖.md' },
          ],
        },
        { key: 'user:12', label: '김담당', member: { id: 12, name: '김담당' }, tickets: [{ id: 3, number: 'VOC-3', customerPage: 'wiki/entities/한결케미칼.md' }] },
        { key: 'user:12', tickets: [] },
        { key: 'team:1', tickets: [] },
      ],
      webBase: 'https://voc.example.test',
      loginCommand: 'voc-cli login -u hong',
    };
    const b = V.normalizeVocBoard(raw);
    expect(b.lanes.map((l) => l.key)).toEqual(['unassigned', 'user:12']);
    expect(b.lanes[0].label).toBe('미배정');
    expect(b.lanes[0].tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(b.lanes[0].summary).toEqual({ total: 2, slaExceeded: 1, slaWarning: 1, p1: 1, oldestDays: 9 });
    expect(b.lanes[0].tickets[1].ictDue).toBeUndefined();
    expect(b.lanes[0].tickets[1].customerPage).toBeUndefined();
    expect(b.lanes[0].tickets[0].title).toBe('a');
    expect(b.lanes[1].tickets[0]).toMatchObject({ title: '(제목 없음)', customerPage: 'wiki/entities/한결케미칼.md', ageDays: 0 });
    expect(b.totals).toEqual({ team: 3, unassigned: 2, slaExceeded: 1, slaWarning: 1 });
    expect(b.webBase).toBe('https://voc.example.test');
    expect(b.loginCommand).toBe('voc-cli login -u hong');
  });

  it('main 이 보낸 합계는 그대로 쓰고, 웹 주소는 https://호스트 만 받는다', () => {
    const b = V.normalizeVocBoard({ state: 'stale', lanes: [], totals: { team: 9, unassigned: 4, slaExceeded: 2, slaWarning: 1 }, webBase: 'http://x/y' });
    expect(b.totals).toEqual({ team: 9, unassigned: 4, slaExceeded: 2, slaWarning: 1 });
    expect(b.webBase).toBeUndefined();
    expect(V.normalizeVocBoard({ state: 'ok', lanes: [], webBase: 'https://h/maintenance' }).webBase).toBeUndefined();
  });

  it('티켓 상세: 티켓이 없으면 오류, 답변은 모양 맞는 것만', () => {
    expect(() => V.normalizeTicketDetail({})).toThrow('티켓 상세');
    const d = V.normalizeTicketDetail({
      ticket: ticket(),
      replies: [{ id: 5, authorName: '김담당', authorType: 'internal', createdAt: '2026-09-22T01:00:00Z', text: '확인 중입니다' }, { text: 'id 없음' }],
    });
    expect(d.replies).toEqual([{ id: 5, authorName: '김담당', authorType: 'internal', createdAt: '2026-09-22T01:00:00Z', text: '확인 중입니다' }]);
    expect(V.replyAuthorType('customer')).toBe('고객');
    expect(V.replyAuthorType('internal')).toBe('내부');
  });

  it('선택지·설정', () => {
    const dir = V.normalizeDirectory({
      users: [kim, { id: 'x' }, kim],
      systems: [{ code: 'SYS0048', name: 'CMS' }, { code: '' }],
      requestTypes: [{ code: 'inquiry' }],
      customers: [{ id: 3, name: '서진화학' }],
      me,
    });
    expect(dir.users).toEqual([kim]);
    expect(dir.systems).toEqual([{ code: 'SYS0048', name: 'CMS' }]);
    expect(dir.requestTypes).toEqual([{ code: 'inquiry', name: 'inquiry' }]);
    expect(dir.customers).toEqual([{ id: 3, name: '서진화학' }]);
    expect(dir.me).toEqual(me);
    expect(V.normalizeVocSettings(null)).toEqual({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10 });
    expect(V.normalizeVocSettings({ pollMinutes: 10, apiUrl: ' http://127.0.0.1:18080 ' })).toMatchObject({ apiUrl: 'http://127.0.0.1:18080' });
    expect(V.normalizeVocSettings({ pollMinutes: 10, apiUrl: 5 })).not.toHaveProperty('apiUrl');
    expect(V.normalizeVocSettings({ memberIds: [12, 12, -1, 'a'], systems: ['A', 'A', ''], pollMinutes: 15, myId: 11, jarPath: ' C:\\x\\voc-cli.jar ' })).toEqual({
      memberIds: [12],
      systems: ['A'],
      showAllUnassigned: false,
      pollMinutes: 15,
      myId: 11,
      jarPath: 'C:\\x\\voc-cli.jar',
    });
  });
});

describe('머리·띠·사이드바 문구', () => {
  // 이 PC 시간대로 만든 시각(시험이 어느 시간대에서 돌아도 같게)
  const at = (h: number, m: number, day = 28): string => new Date(2026, 8, day, h, m).toISOString();
  const ms = (h: number, m: number, day = 28): number => new Date(2026, 8, day, h, m).getTime();

  it('받은 시각 + 얼마 전', () => {
    expect(V.fetchedText(at(10, 32), ms(10, 35), TODAY)).toBe('오전 10:32 받음(3분 전)');
    expect(V.fetchedText(at(10, 32), ms(10, 32), TODAY)).toBe('오전 10:32 받음(방금)');
    expect(V.fetchedText(at(8, 0), ms(10, 35), TODAY)).toBe('오전 8:00 받음(2시간 전)');
    expect(V.fetchedText(at(17, 5, 27), ms(10, 35), TODAY)).toBe('9월 27일 오후 5:05 받음(17시간 전)');
    expect(V.fetchedText(undefined, 0, TODAY)).toBe('');
    expect(V.fetchedClock(at(14, 2), TODAY)).toBe('오후 2:02');
  });

  it('머리 요약: 진행 중·미배정·SLA 초과·임박(있으면 색)', () => {
    const parts = V.boardHeadParts({ totals: { team: 5, unassigned: 2, slaExceeded: 1, slaWarning: 0 } });
    expect(parts.map((p) => p.text)).toEqual(['진행 중 5', '미배정 2', 'SLA 초과 1', '임박 0']);
    expect(parts.map((p) => p.tone)).toEqual([undefined, 'amber', 'coral', undefined]);
  });

  it('띠: ok 면 없음, 상태마다 명세 §1 문구', () => {
    expect(V.vocBanner(board(), TODAY)).toBeNull();
    expect(V.vocBanner(board({ state: 'loading' }), TODAY)).toMatchObject({ busy: true, tone: 'muted' });
    const login = V.vocBanner(board({ state: 'login', message: '세션이 만료되었습니다' }), TODAY);
    expect(login).toMatchObject({ title: 'VOC 에 로그인이 필요합니다', detail: '세션이 만료되었습니다.', login: true });
    expect(login?.hint).toContain('주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다');
    // 앱이 VOC API 를 직접 부르면(main 이 loginCommand 를 보내지 않는다) 앱 안 로그인만 — 터미널 명령·안내가 없다(명세 §15)
    expect(login).not.toHaveProperty('command');
    expect(login).not.toHaveProperty('commandHint');
    // voc-cli 를 띄울 때(main 이 loginCommand 를 보낸다)만 터미널 명령을 그대로 보인다
    expect(V.vocBanner(board({ state: 'login', message: '세션이 만료되었습니다', loginCommand: V.DEFAULT_LOGIN_COMMAND }), TODAY)).toMatchObject({
      login: true,
      command: V.DEFAULT_LOGIN_COMMAND,
      commandHint: '터미널에서 아래 명령으로 로그인한 뒤 [다시 확인]을 누르세요.',
    });
    expect(V.vocBanner(board({ state: 'login', loginCommand: '' }), TODAY)).not.toHaveProperty('command');
    expect(V.vocBanner(board({ state: 'login', message: 'VOC 에 로그인이 필요합니다', loginCommand: 'voc-cli login -u hong' }), TODAY)).toMatchObject({
      detail: undefined,
      command: 'voc-cli login -u hong',
    });
    // main 이 실제로 보내는 문장(cli.ts)으로: 제목·주말 안내가 띠(role=alert)에 한 번씩만
    const plain = V.vocBanner(board({ state: 'login', message: VOC_LOGIN_MESSAGE }), TODAY);
    expect(plain).toMatchObject({ detail: undefined, hint: '[로그인]을 눌러 VOC 아이디·비밀번호를 넣으세요. 주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다.' });
    const expired = V.vocBanner(board({ state: 'login', message: VOC_EXPIRED_MESSAGE }), TODAY);
    expect(expired).toMatchObject({
      title: 'VOC 에 로그인이 필요합니다',
      detail: '세션이 만료되었습니다(주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다).',
      hint: '[로그인]을 눌러 VOC 아이디·비밀번호를 넣으세요.',
    });
    for (const info of [plain, expired]) {
      const shown = [info?.title, info?.detail, info?.hint].filter(Boolean).join('\n');
      expect(shown.split('VOC 에 로그인이 필요합니다').length - 1, shown).toBe(1);
      expect(shown.split('주말처럼 하루 넘게 쓰지 않으면').length - 1, shown).toBe(1);
    }
    expect(V.vocBanner(board({ state: 'unavailable', message: '백엔드에 연결할 수 없습니다' }), TODAY)).toMatchObject({
      tone: 'coral',
      title: 'VOC 서버에 연결하지 못했습니다',
      detail: '백엔드에 연결할 수 없습니다.',
    });
    const stale = V.vocBanner(board({ state: 'stale', fetchedAt: at(10, 32) }), TODAY);
    expect(stale?.title).toBe('VOC 목록을 새로 받지 못했습니다 — 오전 10:32에 받은 목록입니다');
    expect(V.vocBanner(board({ state: 'notConfigured' }), TODAY)).toMatchObject({ title: V.NOT_CONFIGURED_TEXT, settings: true });
  });

  it('사이드바: 합계만, 0이면 흐리게, 초과는 따로, 로그인 필요', () => {
    expect(V.sidebarVocInfo(null, TODAY)).toMatchObject({ state: 'loading', label: 'VOC 받는 중', showCount: false, dim: true });
    const ok = V.sidebarVocInfo(board(), TODAY);
    expect(ok).toMatchObject({ state: 'ok', label: 'VOC 미배정', count: 2, exceeded: 1, showCount: true, dim: false, attention: false });
    expect(ok.description).toBe('VOC 팀 미배정 2건, SLA 초과 1건. 누르면 풀스크린의 VOC 화면이 열립니다.');
    const empty = V.sidebarVocInfo(board({ lanes: [], totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 } }), TODAY);
    expect(empty).toMatchObject({ count: 0, dim: true, showCount: true });
    expect(V.sidebarVocInfo(board({ state: 'login' }), TODAY)).toMatchObject({ label: 'VOC 로그인 필요', attention: true, showCount: false, count: 2 });
    expect(V.sidebarVocInfo(board({ state: 'notConfigured' }), TODAY)).toMatchObject({ label: 'VOC 설정 필요', dim: true });
    expect(V.sidebarVocInfo(board({ state: 'unavailable', fetchedAt: undefined }), TODAY).label).toBe('VOC 연결 안 됨');
    const stale = V.sidebarVocInfo(board({ state: 'stale', fetchedAt: at(10, 32) }), TODAY);
    expect(stale).toMatchObject({ label: 'VOC 미배정', showCount: true });
    expect(stale.title).toBe('VOC 화면 열기 — 오전 10:32에 받은 목록');
    // 담당자별 내역(이름)은 넣지 않는다
    expect(JSON.stringify(ok)).not.toContain('홍길동');
    expect(V.navVocCount(board())).toBe(2);
    expect(V.navVocCount(null)).toBe(0);
  });

  it('내비 VOC: 수가 사실일 때만 수 — 받는 중·로그인 필요·설정 필요·받은 적 없는 연결 실패는 글자(0건으로 보이지 않게)', () => {
    expect(V.navVocInfo(board())).toEqual({ count: 2, description: '팀 미배정 2건' });
    expect(V.navVocInfo(board({ state: 'stale' }))).toEqual({ count: 2, description: '팀 미배정 2건' });
    const empty = { lanes: [], totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 } };
    expect(V.navVocInfo(null)).toMatchObject({ count: 0, note: '받는 중' });
    expect(V.navVocInfo(board({ state: 'loading', fetchedAt: undefined, ...empty }))).toMatchObject({ note: '받는 중' });
    expect(V.navVocInfo(board({ state: 'login' }))).toMatchObject({ note: '로그인 필요', description: 'VOC 에 로그인이 필요합니다.' });
    expect(V.navVocInfo(board({ state: 'notConfigured', fetchedAt: undefined, ...empty }))).toMatchObject({ note: '설정 필요' });
    const offline = V.navVocInfo(board({ state: 'unavailable', fetchedAt: undefined, ...empty }));
    expect(offline).toMatchObject({ count: 0, note: '연결 안 됨' });
    expect(offline.description).not.toContain('0건');
  });

  it('나를 찾지 못해 팀을 정하지 못함(meMissing + 사람 칸 없음): 머리·사이드바·내비가 0건을 사실로 보이지 않고 설정을 안내', () => {
    const lanes = [lane('unassigned', [])];
    const lost = board({ lanes, totals: V.totalsOf(lanes), me: undefined, meMissing: true });
    expect(V.boardTeamUnknown(lost)).toBe(true);
    expect(V.vocSetupBanner(lost)?.title).toBe('VOC 에서 나를 찾지 못했습니다 — 설정에서 나를 고르세요');
    expect(V.vocSetupBanner(lost)?.detail).toContain('미배정이 0건이라는 뜻이 아닙니다');
    expect(V.sidebarVocInfo(lost, TODAY)).toMatchObject({ label: 'VOC 설정 필요', showCount: false, attention: true });
    expect(V.navVocInfo(lost)).toMatchObject({ note: '설정 필요' });
    // 팀원을 골라 사람 칸은 있다 — 합계는 사실이고, 띠는 내 담당 VOC 할 일이 없다는 것만 알린다
    const withTeam = board({ me: undefined, meMissing: true });
    expect(V.boardTeamUnknown(withTeam)).toBe(false);
    expect(V.vocSetupBanner(withTeam)?.detail).toContain('내 담당 VOC 할 일');
    expect(V.navVocInfo(withTeam).note).toBeUndefined();
    // 나를 찾았거나, 받은 적이 없거나, 로그인 필요면 띠가 없다
    expect(V.vocSetupBanner(board())).toBeNull();
    expect(V.vocSetupBanner(board({ meMissing: true, fetchedAt: undefined }))).toBeNull();
    expect(V.vocSetupBanner(board({ meMissing: true, state: 'login' }))).toBeNull();
    // main 이 보낸 표식을 다듬어도 남는다
    expect(V.normalizeVocBoard({ ...lost }).meMissing).toBe(true);
    expect(V.normalizeVocBoard({ ...board(), meMissing: true }).meMissing).toBeUndefined(); // 나를 알면 무시
  });

  it('로그인 명령 복사 알림: <아이디> 자리가 있을 때만 바꾸라고 한다', () => {
    expect(V.loginCopiedText('voc-cli login -u <아이디>')).toContain('<아이디>를 내 VOC 아이디로 바꿔');
    expect(V.loginCopiedText('voc-cli login -u hong')).toBe('로그인 명령을 복사했습니다. 터미널에 붙여 넣어 실행하세요.');
  });

  it('설정 대화상자에서 목록을 못 받았을 때 안내는 보드 상태에 맞게(jar 없음이면 로그인하라고 하지 않는다)', () => {
    expect(V.directoryErrorHint('notConfigured')).toContain('VOC 서버 주소');
    expect(V.directoryErrorHint('notConfigured')).toContain('jar·java 위치');
    expect(V.directoryErrorHint('notConfigured')).not.toContain('로그인');
    expect(V.directoryErrorHint('login')).toContain('로그인한 뒤');
    expect(V.directoryErrorHint('unavailable')).toContain('VOC 서버에 연결되면');
    expect(V.directoryErrorHint('stale')).toContain('VOC 서버에 연결되면');
    expect(V.directoryErrorHint(undefined)).not.toContain('로그인');
  });

  it('바깥에서 고른 티켓이 보드에 없을 때: 받지 못한 것과 보드 밖인 것을 가르고, 조사는 받침에 맞게', () => {
    expect(V.targetMissingText({ fetchedAt: undefined }, 'VOC-2026-0101')).toBe('VOC 목록을 아직 받지 못해 VOC-2026-0101을 찾을 수 없습니다.');
    expect(V.targetMissingText({ fetchedAt: '2026-09-28T01:00:00Z' }, 'VOC-2026-0101')).toBe(
      '보드에 VOC-2026-0101이 없습니다. 진행 중이 아니거나, 팀 밖 사람이 담당이거나, 팀 시스템 밖의 미배정 티켓입니다.',
    );
    expect(V.targetMissingText({ fetchedAt: '2026-09-28T01:00:00Z' }, 'VOC-2026-0102')).toMatch(/^보드에 VOC-2026-0102가 없습니다/);
    expect(V.subjectParticle('VOC-2026-0101')).toBe('이');
    expect(V.subjectParticle('VOC-2026-0104')).toBe('가');
    expect(V.subjectParticle('VOC-2026-0100')).toBe('이');
    expect(V.subjectParticle('abc')).toBe('이(가)');
  });

  it('쓰기에 함께 보내는 expected(대화상자가 보인 지금 값): 동작이 바꾸는 값만, 없음은 null', () => {
    const t = ticket({ status: 'new', priority: 'P2', ictDue: undefined, assigneeId: undefined });
    expect(V.expectedOf(t, 'assign')).toEqual({ assigneeId: null, status: 'new' });
    expect(V.expectedOf(ticket({ status: 'in_progress', assigneeId: 12 }), 'assign')).toEqual({ assigneeId: 12, status: 'in_progress' });
    expect(V.expectedOf(t, 'priority')).toEqual({ priority: 'P2' });
    expect(V.expectedOf(ticket({ priority: undefined }), 'priority')).toEqual({ priority: null });
    expect(V.expectedOf(t, 'ictDue')).toEqual({ ictDue: null });
    expect(V.expectedOf(ticket({ ictDue: '2026-10-05' }), 'ictDue')).toEqual({ ictDue: '2026-10-05' });
    expect(V.expectedOf(ticket({ status: 'pending' }), 'status')).toEqual({ status: 'pending' });
    expect(V.expectedOf(t, 'reply')).toBeUndefined();
  });

  it('화면을 열 때 새로 받기: 2분 넘게 지났거나 받은 적이 없을 때, 로그인 필요·설정 필요면 아니다', () => {
    const fetched = '2026-09-28T01:00:00.000Z';
    const base = Date.parse(fetched);
    expect(V.shouldRefreshOnOpen(board({ fetchedAt: fetched }), base + 60_000)).toBe(false);
    expect(V.shouldRefreshOnOpen(board({ fetchedAt: fetched }), base + 3 * 60_000)).toBe(true);
    expect(V.shouldRefreshOnOpen(board({ state: 'stale', fetchedAt: fetched }), base + 3 * 60_000)).toBe(true);
    expect(V.shouldRefreshOnOpen(board({ state: 'login', fetchedAt: fetched }), base + 10 * 60_000)).toBe(false);
    expect(V.shouldRefreshOnOpen(board({ state: 'login', fetchedAt: undefined }), base)).toBe(false);
    expect(V.shouldRefreshOnOpen(board({ state: 'notConfigured', fetchedAt: undefined }), base)).toBe(false);
    // 처음(시작 5초 뒤 첫 받기 전)은 늘 받는다
    expect(V.shouldRefreshOnOpen(board({ state: 'loading', fetchedAt: undefined }), base)).toBe(true);
    expect(V.shouldRefreshOnOpen(board({ state: 'unavailable', fetchedAt: undefined }), base)).toBe(true);
    expect(V.shouldRefreshOnOpen(null, base)).toBe(false);
  });

  it('쓰기를 막는 이유', () => {
    expect(V.writeBlockReason(board(), true)).toBeNull();
    expect(V.writeBlockReason(board({ state: 'stale' }), true)).toBeNull();
    expect(V.writeBlockReason(board({ state: 'login' }), true)).toContain('로그인');
    expect(V.writeBlockReason(board({ state: 'notConfigured' }), true)).toContain('voc-cli');
    expect(V.writeBlockReason(board(), false)).toContain('앱 연결');
    expect(V.writeBlockReason(null, true)).not.toBeNull();
  });
});

describe('칸·줄', () => {
  it('칸 요약 조각과 읽기 도구 이름', () => {
    const s = { total: 3, slaExceeded: 1, slaWarning: 2, p1: 1, oldestDays: 12 };
    expect(V.laneSummaryParts(s)).toEqual([
      { key: 'exceeded', text: '초과 1', tone: 'coral' },
      { key: 'warning', text: '임박 2', tone: 'amber' },
      { key: 'p1', text: 'P1 1' },
      { key: 'oldest', text: '최장 12일' },
    ]);
    expect(V.laneSummaryParts({ total: 0, slaExceeded: 0, slaWarning: 0, p1: 0 })).toEqual([]);
    expect(V.laneAriaLabel({ label: '미배정', summary: s })).toBe('미배정 3건, SLA 초과 1건, SLA 임박 2건, P1 1건, 가장 오래된 건 12일째');
    expect(V.laneSubLabel({ label: '나', member: me, me: true })).toBe('홍길동');
    expect(V.laneSubLabel({ label: '김담당', member: kim })).toBeUndefined();
  });

  it('처음 고를 칸: 미배정(건 있음) → 나 → 건 있는 첫 칸 → 첫 칸', () => {
    const b = board();
    expect(V.defaultLaneKey(b.lanes)).toBe('unassigned');
    const noUnassigned = [lane('unassigned', []), ...b.lanes.slice(1)];
    expect(V.defaultLaneKey(noUnassigned)).toBe('user:11');
    const onlyKim = [lane('unassigned', []), lane('user:11', [], { me: true }), lane('user:12', [ticket()])];
    expect(V.defaultLaneKey(onlyKim)).toBe('user:12');
    expect(V.defaultLaneKey([lane('unassigned', [])])).toBe('unassigned');
    expect(V.defaultLaneKey([])).toBeNull();
  });

  it('티켓 줄 메타: 고객사 · 시스템, 경과, 기한(지났으면 코랄)', () => {
    const t = ticket({ ictDue: '2026-09-25' });
    expect(V.ticketMetaParts(t, TODAY)).toEqual([
      { key: 'where', text: '한결케미칼 · CMS' },
      { key: 'age', text: '7일째' },
      { key: 'due', text: '예상 9/25 지남', tone: 'coral' },
    ]);
    expect(V.ticketMetaParts(ticket({ customer: undefined, systemName: undefined, ageDays: 0 }), TODAY)).toEqual([
      { key: 'where', text: 'SYS0048' },
      { key: 'age', text: '오늘 접수' },
    ]);
    expect(V.ticketAriaLabel(ticket({ slaStatus: 'exceeded' }), TODAY)).toBe(
      'VOC-2026-0101, CMS 인벤토리 사용량 조회 오류, 우선순위 P2, SLA 초과, 한결케미칼 · CMS, 7일째',
    );
  });

  it('요청 내용 접기: 12줄 또는 1,500자', () => {
    const many = Array.from({ length: 15 }, (_, i) => `줄 ${i + 1}`).join('\n');
    const f = V.foldText(many);
    expect(f.folded).toBe(true);
    expect(f.hiddenLines).toBe(3);
    expect(f.text.split('\n')).toHaveLength(12);
    expect(V.foldText('짧은 글')).toEqual({ text: '짧은 글', folded: false, hiddenLines: 0 });
    const long = V.foldText('가'.repeat(2000));
    expect(long).toMatchObject({ folded: true, hiddenLines: 0 });
    expect(long.text).toHaveLength(V.TEXT_FOLD_CHARS);
  });
});

describe('선택·초점 요청', () => {
  it('번호(대소문자 무시) 또는 내부 id 로 티켓을 찾는다', () => {
    const b = board();
    expect(V.findTicket(b, 'voc-2026-0103')).toMatchObject({ lane: 'user:11', ticket: { id: 103 } });
    expect(V.findTicket(b, 102)).toMatchObject({ lane: 'unassigned', ticket: { id: 102 } });
    expect(V.findTicket(b, '999')).toBeNull();
    expect(V.findTicket(null, 'VOC-2026-0101')).toBeNull();
  });

  it("'view:voc' · 'view:voc:<티켓>'", () => {
    expect(FOCUS_VOC_VIEW).toBe('view:voc');
    expect(vocFocusId(' VOC-2026-0101 ')).toBe('view:voc:VOC-2026-0101');
    expect(V.parseVocFocus('view:voc')).toEqual({});
    expect(V.parseVocFocus(vocFocusId('VOC-2026-0101'))).toEqual({ ref: 'VOC-2026-0101' });
    expect(V.parseVocFocus(vocFocusId(101))).toEqual({ ref: '101' });
    expect(V.parseVocFocus('view:voc:')).toEqual({});
    expect(V.parseVocFocus('view:queue')).toBeNull();
    expect(V.parseVocFocus('v:101')).toBeNull();
    expect(V.parseVocFocus(null)).toBeNull();
  });

  it("'view:voc-login' → VOC 화면 + 로그인 대화상자(명세 §13) — 티켓 고르기와 겹치지 않는다", () => {
    expect(FOCUS_VOC_LOGIN).toBe('view:voc-login');
    expect(V.parseVocFocus(FOCUS_VOC_LOGIN)).toEqual({ login: true });
    expect(V.parseVocFocus(vocFocusId('login'))).toEqual({ ref: 'login' });
  });
});

describe('앱 안 로그인(명세 §13)', () => {
  const PW = 'Pw-unit-7f3a9c';

  it('로그인 필요 띠: [로그인]이 먼저, 터미널 명령은 접어 둔 안내와 함께', () => {
    const login = V.vocBanner(board({ state: 'login', loginCommand: 'voc-cli login -u hong' }), TODAY);
    expect(login).toMatchObject({ state: 'login', login: true, command: 'voc-cli login -u hong' });
    expect(login?.hint).toContain('[로그인]');
    expect(login?.commandHint).toContain('터미널에서 아래 명령으로 로그인한 뒤 [다시 확인]');
    for (const state of ['ok', 'loading', 'stale', 'unavailable', 'notConfigured'] as const) {
      expect(V.vocBanner(board({ state }), TODAY)?.login, state).toBeUndefined();
    }
    expect(V.needsVocLogin(board({ state: 'login' }))).toBe(true);
    expect(V.needsVocLogin(board())).toBe(false);
    expect(V.needsVocLogin(null)).toBe(false);
    expect(V.directoryErrorHint('login')).toContain('[로그인]');
    expect(V.sidebarVocInfo(board({ state: 'login' }), TODAY)).toMatchObject({ title: 'VOC 로그인 창 열기' });
    expect(V.sidebarVocInfo(board({ state: 'login' }), TODAY).description).toContain('로그인 창이 열립니다');
  });

  it('보드·설정의 loginId 는 아이디 규칙에 맞을 때만 받는다', () => {
    expect(V.normalizeVocBoard({ ...board({ state: 'login' }), loginId: 'hong' }).loginId).toBe('hong');
    for (const bad of ['-h', '@x', 'a b', 'x'.repeat(65), 7, '']) {
      expect(V.normalizeVocBoard({ ...board({ state: 'login' }), loginId: bad }).loginId, String(bad)).toBeUndefined();
    }
    expect(V.normalizeVocSettings({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, loginId: 'hong' }).loginId).toBe('hong');
    expect(V.normalizeVocSettings({ loginId: '-x' })).not.toHaveProperty('loginId');
  });

  it('보내기 전 검사: 아이디(앞뒤 공백은 걷는다) → 비밀번호, 고칠 칸을 알린다 — 문장에 비밀번호가 없다', () => {
    expect(V.vocLoginProblem(' hong ', PW)).toBeNull();
    expect(V.vocLoginProblem('', PW)).toEqual({ field: 'id', message: '아이디를 적어 주세요.' });
    expect(V.vocLoginProblem('a b', PW)?.field).toBe('id');
    expect(V.vocLoginProblem('-u', PW)?.message).toBe('아이디는 - 나 @ 로 시작할 수 없습니다.');
    expect(V.vocLoginProblem('hong', '')).toEqual({ field: 'password', message: '비밀번호를 적어 주세요.' });
    const multi = V.vocLoginProblem('hong', `${PW}\n다음 줄`);
    expect(multi?.field).toBe('password');
    expect(multi?.message).not.toContain(PW);
    expect(V.vocLoginProblem('hong', '가'.repeat(256))).toBeNull();
    expect(V.vocLoginProblem('hong', '가'.repeat(257))?.message).toBe('비밀번호는 256자까지입니다.');
  });
});

describe('쓰기 — 확인 대화상자·결과(명세 §4·§5)', () => {
  const ctx: V.VocConfirmContext = { members: [me, kim, park], me, today: TODAY };
  const pending = (kind: V.VocPendingAction['kind'], value: string, t: Partial<VocTicket> = {}): V.VocPendingAction => ({
    actionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    kind,
    value,
    ticket: ticket({ number: 'VOC-2026-0001', ...t }),
  });

  it('actionId 는 UUID', () => {
    expect(V.makeActionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(V.makeActionId()).not.toBe(V.makeActionId());
  });

  it('담당 지정 선택지: 보드의 나·팀원(칸 순서), 지금 담당은 뺀다', () => {
    const b = board();
    expect(V.assignOptions(b, {})).toEqual([
      { id: 11, label: '나(홍길동)' },
      { id: 12, label: '김담당' },
    ]);
    expect(V.assignOptions(b, { assigneeId: 11 })).toEqual([{ id: 12, label: '김담당' }]);
    expect(V.assignOptions(null, {})).toEqual([]);
    expect(V.boardMembers(b).map((m) => m.id)).toEqual([11, 12]);
  });

  it('담당 지정: 명세 문구, new 면 상태 new → assigned', () => {
    const s = V.vocConfirm(pending('assign', '12'), ctx);
    expect(s.lead).toBe('VOC-2026-0001을 김담당에게 지정합니다.');
    expect(s.lines).toEqual(['김담당에게 VOC 배정 메일이 갑니다(본인 지정도).', '상태 new → assigned']);
    expect(s).toMatchObject({ kind: 'assign', confirmText: '지정', subject: 'VOC-2026-0001 CMS 인벤토리 사용량 조회 오류' });
    const self = V.vocConfirm(pending('assign', '11', { status: 'assigned', assigneeName: '박담당', number: 'VOC-2026-0002' }), ctx);
    expect(self.lead).toBe('VOC-2026-0002를 나(홍길동)에게 지정합니다.');
    expect(self.lines).toEqual(['홍길동에게 VOC 배정 메일이 갑니다(본인 지정도).', '상태는 그대로입니다(배정됨(assigned)).', '지금 담당: 박담당']);
    expect(V.vocConfirm(pending('assign', '99'), ctx).lead).toBe('VOC-2026-0001을 사용자 99에게 지정합니다.');
  });

  it('ICT 예상완료일: 바꾸기·지우기(고객 희망일은 그대로)', () => {
    const s = V.vocConfirm(pending('ictDue', '2026-10-05', { ictDue: '2026-10-03', customerDue: '2026-10-10' }), ctx);
    expect(s.lead).toBe('ICT 예상완료일을 10/5로 바꿉니다(고객 희망일은 그대로).');
    expect(s.lines).toEqual(['지금 ICT 예상완료일: 10/3', '고객 희망일: 10/10']);
    expect(V.vocConfirm(pending('ictDue', '2026-10-03'), ctx).lead).toBe('ICT 예상완료일을 10/3으로 바꿉니다(고객 희망일은 그대로).');
    const clear = V.vocConfirm(pending('ictDue', '', { ictDue: '2026-10-03' }), ctx);
    expect(clear).toMatchObject({ lead: 'ICT 예상완료일을 지웁니다(고객 희망일은 그대로).', confirmText: '지우기' });
    expect(clear.lines).toEqual(['지금 ICT 예상완료일: 10/3', '고객 희망일: 없음']);
  });

  it('우선순위: P3 → P1 — SLA 목표가 바뀝니다', () => {
    expect(V.vocConfirm(pending('priority', 'P1', { priority: 'P3' }), ctx).lead).toBe('우선순위 P3 → P1 — SLA 목표가 바뀝니다.');
    expect(V.vocConfirm(pending('priority', 'P2', { priority: undefined }), ctx).lead).toBe('우선순위 없음 → P2 — SLA 목표가 바뀝니다.');
  });

  it('상태·답변(V3a)', () => {
    const st = V.vocConfirm(pending('status', 'pending', { status: 'in_progress' }), ctx);
    expect(st.lead).toBe('VOC-2026-0001의 상태를 보류(pending)로 바꿉니다.');
    expect(st.lines[0]).toBe('지금 상태: 진행 중(in_progress)');
    expect(V.vocConfirm(pending('status', 'in_progress'), ctx).lead).toBe('VOC-2026-0001의 상태를 진행 중(in_progress)으로 바꿉니다.');
    const rp = V.vocConfirm(pending('reply', '확인했습니다.\n내일 조치합니다.'), ctx);
    expect(rp.lead).toBe('VOC-2026-0001에 답변을 등록합니다. VOC 쪽 알림·메일은 나가지 않지만 고객 포털에서 보일 수 있습니다.');
    expect(rp.preview).toEqual({ lines: ['확인했습니다.', '내일 조치합니다.'], more: 0 });
  });

  it('결과 알림: 성공은 main 문장, 실패는 서버 문장 그대로', () => {
    const p = pending('assign', '12');
    expect(V.actionNotice({ ok: true, message: 'VOC-2026-0001을 김담당에게 지정했습니다.' }, p, 1)).toEqual({
      id: 1,
      tone: 'ok',
      title: 'VOC-2026-0001을 김담당에게 지정했습니다.',
      lines: [],
      ticketId: 101,
      kind: 'assign',
    });
    expect(V.actionNotice({ ok: true, message: '' }, p, 2).title).toBe('VOC-2026-0001 담당 지정을 마쳤습니다.');
    const failed = V.actionNotice({ ok: false, message: '400 — 작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.' }, p, 3);
    expect(failed).toMatchObject({ tone: 'error', title: 'VOC-2026-0001 담당 지정에 실패했습니다.' });
    expect(failed.lines).toEqual(['400 — 작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.']);
    expect(V.actionFailure('앱 연결 끊김', pending('priority', 'P1'), 4)).toMatchObject({
      tone: 'error',
      title: 'VOC-2026-0001 우선순위 변경에 실패했습니다.',
      lines: ['앱 연결 끊김'],
    });
    expect(V.actionNotice(null, p, 5).lines[0]).toContain('이유가 전해지지 않았습니다');
  });
});

describe('설정(명세 §7)', () => {
  const base = V.settingsDraftOf({ memberIds: [11, 12], systems: ['SYS0048'], showAllUnassigned: false, pollMinutes: 10 });

  it('입력 값 ↔ 설정', () => {
    expect(base).toEqual({ myId: '', memberIds: [11, 12], systems: ['SYS0048'], showAllUnassigned: false, pollMinutes: '10', apiUrl: '', jarPath: '' });
    expect(V.settingsFromDraft({ ...base, myId: '11', pollMinutes: ' 15 ', jarPath: ' C:\\tools\\voc-cli.jar ' })).toEqual({
      memberIds: [11, 12],
      systems: ['SYS0048'],
      showAllUnassigned: false,
      pollMinutes: 15,
      myId: 11,
      jarPath: 'C:\\tools\\voc-cli.jar',
    });
    expect(V.settingsFromDraft(base)).not.toHaveProperty('myId');
    expect(V.settingsFromDraft(base)).not.toHaveProperty('jarPath');
    expect(V.settingsFromDraft(base)).not.toHaveProperty('apiUrl');
    expect(V.sameDraft(base, { ...base })).toBe(true);
    expect(V.sameDraft(base, { ...base, memberIds: [12, 11] })).toBe(false);
    expect(V.sameDraft(base, { ...base, pollMinutes: '10 ' })).toBe(true);
  });

  it('검사: 팀원 ≤ 50, 시스템 ≤ 100, 주기 5~60 정수, jar 는 .jar 절대경로', () => {
    expect(V.vocSettingsProblem(base)).toBeNull();
    expect(V.vocSettingsProblem({ ...base, memberIds: Array.from({ length: 51 }, (_, i) => i + 1) })).toContain('50명');
    expect(V.vocSettingsProblem({ ...base, systems: Array.from({ length: 101 }, (_, i) => `S${i}`) })).toContain('100개');
    for (const poll of ['4', '61', '7.5', '', 'abc']) expect(V.vocSettingsProblem({ ...base, pollMinutes: poll })).toContain('5~60분');
    expect(V.vocSettingsProblem({ ...base, pollMinutes: '60' })).toBeNull();
    expect(V.vocSettingsProblem({ ...base, jarPath: 'voc-cli.jar' })).toContain('절대경로');
    expect(V.vocSettingsProblem({ ...base, jarPath: 'C:\\tools\\voc-cli.exe' })).toContain('.jar');
    expect(V.vocSettingsProblem({ ...base, jarPath: 'C:\\tools\\voc-cli-1.2.jar' })).toBeNull();
    expect(V.vocSettingsProblem({ ...base, jarPath: '\\\\server\\share\\voc-cli.jar' })).toBeNull();
  });

  it('VOC 서버 주소: 입력 값 ↔ 설정(기본 주소·빈 값은 적지 않고, 끝 / 는 걷는다)', () => {
    const withUrl = V.settingsDraftOf({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, apiUrl: 'http://127.0.0.1:18080' });
    expect(withUrl.apiUrl).toBe('http://127.0.0.1:18080');
    expect(V.settingsFromDraft(withUrl).apiUrl).toBe('http://127.0.0.1:18080');
    expect(V.settingsFromDraft({ ...base, apiUrl: '  https://voc-test.example.com:8443/  ' }).apiUrl).toBe('https://voc-test.example.com:8443');
    expect(V.settingsFromDraft({ ...base, apiUrl: 'HTTPS://VOC-Test.Example.com:8443' }).apiUrl).toBe('https://voc-test.example.com:8443');
    // 기본 주소를 그대로 적거나(끝 / 포함) 비우면 설정에 남기지 않는다 — 기본이 바뀌면 따라간다
    expect(V.DEFAULT_VOC_API_URL).toBe('https://voc.acme.test:11300');
    for (const apiUrl of ['', '   ', V.DEFAULT_VOC_API_URL, `${V.DEFAULT_VOC_API_URL}/`, ' https://voc.acme.test:11300// ']) {
      expect(V.settingsFromDraft({ ...base, apiUrl }), apiUrl).not.toHaveProperty('apiUrl');
    }
    // jarPath 는 화면에 칸이 없어도 저장할 때 지우지 않는다
    const kept = V.settingsDraftOf({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, jarPath: 'C:\tools\voc-cli.jar' });
    expect(V.settingsFromDraft({ ...kept, apiUrl: 'http://localhost:9000' })).toMatchObject({ apiUrl: 'http://localhost:9000', jarPath: 'C:\tools\voc-cli.jar' });
  });

  it('VOC 서버 주소 검사: https://호스트[:포트] 만(경로·계정·쿼리 없이, http 는 이 PC 주소만), 비면 기본', () => {
    const msg = 'VOC 서버 주소는 https://호스트:포트 모양으로 적어 주세요(http 는 이 PC 주소만, 비워 두면 기본 주소).';
    for (const ok of ['', '  ', 'https://voc.acme.test:11300', 'https://voc.acme.test:11300/', 'http://127.0.0.1:18080', 'http://localhost', 'http://[::1]:9000', ' https://voc-test.example.com ']) {
      expect(V.vocSettingsProblem({ ...base, apiUrl: ok }), ok).toBeNull();
    }
    for (const bad of [
      'voc.acme.test:11300',
      'http://voc.acme.test:11300',
      'http://192.168.0.10:8080',
      'http://localhost.example.test',
      'ftp://voc.acme.test',
      'file:///C:/voc',
      'https://voc.acme.test:11300/api/v2',
      'https://voc.acme.test/?x=1',
      'https://voc.acme.test/#a',
      'https://user:pw@voc.acme.test',
      'https://voc.acme.test:99999',
      'https://',
      'not a url',
    ]) {
      expect(V.vocSettingsProblem({ ...base, apiUrl: bad }), bad).toBe(msg);
    }
  });

  it('VOC 서버 주소도 바뀐 것으로 본다(앞뒤 공백은 같게)', () => {
    expect(V.sameDraft(base, { ...base, apiUrl: 'http://localhost:9000' })).toBe(false);
    expect(V.sameDraft({ ...base, apiUrl: 'http://localhost:9000' }, { ...base, apiUrl: ' http://localhost:9000 ' })).toBe(true);
  });

  it('체크 목록: 넣으면 끝에(칸 순서), 부서별 묶음(내 부서 먼저·부서 없음 맨 뒤)', () => {
    expect(V.toggleIn([11, 12], 13, true)).toEqual([11, 12, 13]);
    expect(V.toggleIn([11, 12], 12, true)).toEqual([11, 12]);
    expect(V.toggleIn([11, 12], 11, false)).toEqual([12]);
    const groups = V.groupMembers([lee, choi, park, kim, me], '운영2팀');
    expect(groups.map((g) => g.department)).toEqual(['운영2팀', '운영1팀', V.NO_DEPARTMENT]);
    expect(groups[0].members.map((m) => m.name)).toEqual(['김담당', '박담당', '홍길동']);
    expect(V.sameDepartmentIds([lee, park, kim, me], me)).toEqual([11, 13, 12]);
    expect(V.sameDepartmentIds([choi], choi)).toEqual([15]);
    expect(V.sameDepartmentIds([], undefined)).toEqual([]);
  });

  it('시스템 선택지·찾기', () => {
    expect(V.systemChoices([{ code: 'SYS0048', name: 'CMS' }], ['SYS0048', 'SYS9999'])).toEqual([
      { code: 'SYS0048', name: 'CMS' },
      { code: 'SYS9999', name: 'SYS9999' },
    ]);
    expect(V.matchesFilter('cms', 'CMS', 'SYS0048')).toBe(true);
    expect(V.matchesFilter('운영1', '이담당', '운영1팀')).toBe(true);
    expect(V.matchesFilter('없음', '김담당')).toBe(false);
    expect(V.matchesFilter('  ', '김담당')).toBe(true);
  });
});
