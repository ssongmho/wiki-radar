// renderer 할 일 쪽 VOC(2.6단계 명세 §5 V3a 'VOC 처리' · §6 V3b '메일 → VOC 등록') 시험:
// VOC 할 일 칩·목록 메타(lib/tasks.ts), 입력 검사·확인 대화상자 문구·결과 알림·선택지·main 응답 다듬기(lib/vocTask.ts),
// taskId 별 보관소의 쓰기 흐름(hooks/useVocCreate.ts — 가짜 window.radar: actionId·createId·실행 중 막기·실패 뒤 입력 유지).
// 시험 자료의 사람·고객사는 가짜(홍길동·김담당·박담당, 한결케미칼·서진화학)다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Task,
  VocActionInput,
  VocBoard,
  VocCreateContext,
  VocCreateInput,
  VocLane,
  VocMember,
  VocTicket,
} from '../../src/shared/types';
import { VOC_CREATE_ID_USED } from '../../src/shared/voc';
import * as T from '../../src/renderer/lib/tasks';
import * as V from '../../src/renderer/lib/vocTask';
import { FEATURES } from '../../src/shared/edition';

const today = '2026-09-28';

const vocTask = (p: Partial<Task> = {}): Task => ({
  id: 'v:5012',
  source: 'voc',
  title: '통영공장 CMS 사용량 집계 오류',
  status: 'wip',
  bucket: 'thisWeek',
  company: '한결케미칼',
  due: '2026-09-30',
  opened: '2026-09-21',
  openDays: 5,
  pri: 2,
  voc: { id: 5012, number: 'VOC-2026-0012', status: 'in_progress', priority: 'P2', slaStatus: 'warning', systemName: 'CMS(화학물질관리시스템)' },
  ...p,
});

const mailTask = (p: Partial<Task> = {}): Task => ({
  id: 'c:mail1',
  source: 'checkbox',
  title: '통영공장 인벤토리 확인 회신',
  status: 'open',
  bucket: 'thisWeek',
  company: '한결케미칼',
  mail: 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_인벤토리 확인 요청_a1b2c3.md',
  rawLine: '- [ ] 통영공장 인벤토리 확인 회신 [due:: 2026-09-30] #내할일',
  ...p,
});

const member = (id: number, name: string): VocMember => ({ id, name, email: `u${id}@example.com`, department: '샘플팀' });
const me = member(101, '홍길동');
const kim = member(102, '김담당');
const park = member(103, '박담당');

const ticket = (p: Partial<VocTicket> = {}): VocTicket => ({
  id: 5012,
  number: 'VOC-2026-0012',
  title: '통영공장 CMS 사용량 집계 오류',
  status: 'in_progress',
  priority: 'P2',
  customerId: 11,
  customer: '한결케미칼',
  system: 'SYS0101',
  systemName: 'CMS(화학물질관리시스템)',
  assigneeId: 101,
  assigneeName: '홍길동',
  createdAt: '2026-09-21T01:30:00Z',
  lastReplyAt: '2026-09-25T06:05:00Z',
  customerDue: '2026-09-25',
  ictDue: '2026-10-05',
  slaStatus: 'warning',
  slaResolutionTarget: 2880,
  replyCount: 2,
  requesterName: '최외부',
  requestType: 'bug',
  text: '8월분 사용량이 0 으로 보입니다.',
  ageDays: 7,
  ageBusinessDays: 5,
  ...p,
});

const summary = { total: 1, slaExceeded: 0, slaWarning: 1, p1: 0 };
const lane = (key: string, label: string, tickets: VocTicket[], m?: VocMember, isMe?: boolean): VocLane => ({
  key,
  label,
  tickets,
  summary,
  ...(m ? { member: m } : {}),
  ...(isMe ? { me: true } : {}),
});

const board = (p: Partial<VocBoard> = {}): VocBoard => ({
  state: 'ok',
  fetchedAt: '2026-09-28T01:32:00Z',
  lanes: [
    lane('unassigned', '미배정', [ticket({ id: 5020, number: 'VOC-2026-0020', assigneeId: undefined, assigneeName: undefined })]),
    lane('user:101', '나', [ticket()], me, true),
    lane('user:102', '김담당', [ticket({ id: 5031, number: 'VOC-2026-0031', assigneeId: 102 })], kim),
    lane('user:103', '박담당', [], park),
  ],
  totals: { team: 3, unassigned: 1, slaExceeded: 0, slaWarning: 3 },
  me,
  webBase: 'https://voc.example.com',
  ...p,
});

const ctx = (p: Partial<VocCreateContext> = {}): VocCreateContext => ({
  taskId: 'c:mail1',
  title: '통영공장 CMS 인벤토리 사용량 확인 요청',
  description: '안녕하세요.\n8월분 사용량 확인 부탁드립니다.\n\n(메일 한결케미칼 EHS팀 · 2026-09-15 에서 등록)',
  customerId: 11,
  system: 'SYS0101',
  requestType: 'inquiry',
  priority: 'P3',
  directory: {
    users: [me, kim, park],
    systems: [
      { code: 'SYS0101', name: 'CMS(화학물질관리시스템)' },
      { code: 'SYS0102', name: 'MSDS 관리' },
    ],
    requestTypes: [
      { code: 'inquiry', name: '문의' },
      { code: 'bug', name: '오류' },
    ],
    customers: [
      { id: 12, name: '서진화학' },
      { id: 11, name: '한결케미칼' },
      { id: 13, name: '대륙물산' },
    ],
    me,
  },
  ...p,
});

// ── lib/tasks.ts ────────────────────────────────────────────────────────────

describe('VOC 할 일 칩·목록 메타(lib/tasks.ts)', () => {
  it('VOC 할 일 판별·상태 이름·칩 글자', () => {
    expect(T.isVocTask(vocTask())).toBe(true);
    expect(T.isVocTask(mailTask())).toBe(false);
    expect(T.vocStatusLabel('in_progress')).toBe('진행 중');
    expect(T.vocStatusLabel('pending')).toBe('보류');
    expect(T.vocStatusLabel('new')).toBe('신규');
    expect(T.vocStatusLabel('toString')).toBe('toString'); // 원형 속성을 이름으로 잘못 읽지 않는다
    expect(T.vocStatusLabel('reopened')).toBe('reopened');
    expect(T.vocStatusLabel('')).toBe('상태 없음');
    expect(T.vocChipText(vocTask())).toBe('VOC-2026-0012');
    expect(T.vocChipText(vocTask({ voc: { id: 1, number: '2026-0001', status: 'new' } }))).toBe('VOC 2026-0001');
    expect(T.vocChipText(vocTask({ voc: { id: 1, number: '  ', status: 'new' } }))).toBe('VOC');
    expect(T.vocChipText(mailTask())).toBeUndefined();
    expect(T.vocSlaMark('exceeded')).toEqual({ text: 'SLA 초과', tone: 'coral' });
    expect(T.vocSlaMark('normal')).toBeUndefined();
  });

  it('목록 메타: 할 일 상태(진행 중) 대신 VOC 상태 · SLA 임박/초과 — 보류는 wip 이어도 "진행 중"이 아니다', () => {
    expect(T.rowMeta(vocTask()).map((m) => [m.text, m.tone])).toEqual([
      ['한결케미칼', undefined],
      ['진행 중', 'amber'],
      ['SLA 임박', 'amber'],
    ]);
    const pending = vocTask({ voc: { id: 1, number: 'VOC-2026-0001', status: 'pending', slaStatus: 'exceeded' } });
    expect(T.rowMeta(pending).map((m) => [m.text, m.tone])).toEqual([
      ['한결케미칼', undefined],
      ['보류', undefined],
      ['SLA 초과', 'coral'],
    ]);
    // 재촉 구간(P1 로 들어옴)은 열린 기간을 함께
    const p1 = vocTask({ bucket: 'chased', pri: 1, openDays: 9, voc: { id: 2, number: 'VOC-2026-0002', status: 'assigned' } });
    expect(T.rowMeta(p1).map((m) => m.text)).toEqual(['한결케미칼', '열린 지 9영업일', '배정됨']);
    // 위키 할 일은 그대로
    expect(T.rowMeta(mailTask({ status: 'wip' })).map((m) => m.text)).toEqual(['한결케미칼', '진행 중']);
  });

  it('상세 칩: 맨 앞 VOC 칩(task-voc-chip, 티켓 아이콘) · VOC 상태 · SLA — "진행 중" 칩은 없다', () => {
    const chips = T.detailChips(vocTask(), today);
    expect(chips[0]).toEqual({ key: 'voc', text: 'VOC-2026-0012', icon: 'ticket', testId: 'task-voc-chip' });
    expect(chips.map((c) => c.text)).toEqual([
      'VOC-2026-0012',
      '한결케미칼',
      '기한 9월 30일 수요일',
      '열림 5영업일',
      'VOC 진행 중',
      'SLA 임박',
      '우선 P2',
    ]);
    expect(chips.find((c) => c.key === 'wip')).toBeUndefined();
    expect(T.detailChips(mailTask({ status: 'wip', due: '2026-09-30' }), today).map((c) => c.key)).toEqual(['company', 'due', 'wip']);
    expect(T.detailChips(mailTask(), today).some((c) => c.testId)).toBe(false);
  });
});

// ── lib/vocTask.ts: 글자 검사 ────────────────────────────────────────────────

describe('글자 다듬기·CP949 안내', () => {
  it('내용은 LF·제어 문자 떼기·앞뒤 공백, 제목은 한 줄로', () => {
    expect(V.cleanVocText('  안녕하세요\r\n확인\u0007했습니다\t끝\r\n ')).toBe('안녕하세요\n확인했습니다\t끝');
    expect(V.cleanVocTitle(' RE 없음\n두 줄\t제목 ')).toBe('RE 없음 두 줄 제목');
  });

  it('보낼 수 없는 글자 안내: 중복 없이, 글자는 따옴표로(문장부호와 섞이지 않게), 안 보이는 글자는 코드로 · 없으면 null', () => {
    expect(V.charsetProblemText([])).toBeNull();
    const text = V.charsetProblemText(['✓', '😀', '✓', '‍']);
    expect(text).toBe('VOC 로 보낼 수 없는 글자: ‘✓’, ‘😀’, U+200D(안 보이는 글자). 지우거나 다른 글자로 바꾸면 보낼 수 있습니다.');
    expect(V.charLabel('—')).toBe('—');
    expect(V.charLabel('️')).toBe('U+FE0F');
    // 가장 흔한 경우(메일 본문의 —): 문제 글자와 문장 구분이 헷갈리지 않고, 어느 칸에 있는지 알린다
    const dash = V.charsetProblemText(['—', '😀'], [
      { label: '제목', text: '확인 😀' },
      { label: '내용', text: '일정 — 다음 주 😀' },
    ]);
    expect(dash).toBe('VOC 로 보낼 수 없는 글자: ‘—’(내용), ‘😀’(제목·내용). 지우거나 다른 글자로 바꾸면 보낼 수 있습니다.');
    expect(dash).not.toMatch(/— —/);
  });

  it('확인을 기다리는 동안: 앞서 찾은 글자 중 글에 남은 것만(지우면 바로 사라진다) · 응답 다듬기', () => {
    expect(V.remainingChars(['😀', '—'], '확인 😀 부탁')).toEqual(['😀']);
    expect(V.remainingChars(['😀'], '확인 부탁')).toEqual([]);
    expect(V.normalizeCharset(['😀', '😀', 3, '', '✓'])).toEqual(['😀', '✓']);
    expect(V.normalizeCharset(null)).toEqual([]);
  });
});

// ── V3a VOC 처리 ─────────────────────────────────────────────────────────────

describe('V3a 답변·상태 검사와 확인 문구', () => {
  it('답변: 비면 안내만 · 5,000자 넘으면 문제 · CP949 밖 글자면 voc-charset-problem · 쓰는 중이면 막음', () => {
    expect(V.checkVocReply('  ', [], false)).toEqual({ ok: false, reason: '답변 내용을 적으면 등록할 수 있습니다.', problem: null, charset: null });
    expect(V.checkVocReply('확인했습니다.', [], false).ok).toBe(true);
    const long = V.checkVocReply('가'.repeat(5001), [], false);
    expect(long.ok).toBe(false);
    expect(long.problem).toContain('5,000자');
    expect(V.checkVocReply('가'.repeat(5000), [], false).ok).toBe(true);
    const emoji = V.checkVocReply('확인 😀', ['😀'], false);
    expect(emoji.ok).toBe(false);
    expect(emoji.charset).toContain('😀');
    expect(emoji.problem).toBeNull();
    expect(V.checkVocReply('확인', [], true).ok).toBe(false);
  });

  it('로그인 필요·설정 필요면 V3a·V3b 쓰기를 막는다(VOC 화면과 같은 규칙) — 보드를 못 받았거나 stale 이면 막지 않는다', () => {
    expect(V.taskWriteBlock(board({ state: 'login' }), '바꿀')).toBe('VOC 에 로그인한 뒤 바꿀 수 있습니다.');
    expect(V.taskWriteBlock(board({ state: 'notConfigured' }), '등록할')).toBe('voc-cli 위치를 설정한 뒤 등록할 수 있습니다.');
    expect(V.taskWriteBlock(board({ state: 'stale' }), '바꿀')).toBeNull();
    expect(V.taskWriteBlock(board(), '바꿀')).toBeNull();
    expect(V.taskWriteBlock(null, '바꿀')).toBeNull();
  });

  it('상태 고르기: 진행 중·보류 둘만 · 기본값은 지금 상태의 반대', () => {
    expect(V.VOC_STATUS_CHOICES.map((c) => c.value)).toEqual(['in_progress', 'pending']);
    expect(V.defaultStatusChoice('in_progress')).toBe('pending');
    expect(V.defaultStatusChoice('pending')).toBe('in_progress');
    expect(V.defaultStatusChoice('assigned')).toBe('in_progress');
    expect(V.isStatusChoice('resolved')).toBe(false);
  });

  it('확인 대화상자 문구(명세 §5): 답변은 고객 포털 안내, 상태는 이전 → 새 상태', () => {
    expect(V.replyConfirmLead('VOC-2026-0012')).toBe(
      'VOC-2026-0012에 답변을 등록합니다. VOC 쪽 알림·메일은 나가지 않지만 고객 포털에서 보일 수 있습니다.',
    );
    expect(V.statusConfirmLead('VOC-2026-0012', 'in_progress', 'pending')).toBe('VOC-2026-0012의 상태를 ‘진행 중’에서 ‘보류’로 바꿉니다.');
    expect(V.statusConfirmLead('VOC-2026-0012', 'pending', 'in_progress')).toBe('VOC-2026-0012의 상태를 ‘보류’에서 ‘진행 중’으로 바꿉니다.');
    expect(V.VOC_RESOLVE_NOTE).toContain('VOC 화면에서');
  });

  it('쓰기 결과 알림: ok 는 새로 받는다는 안내, ok:false 는 서버 문장 그대로(error) · 답변은 남아 있다', () => {
    const info: V.VocActionInfo = { kind: 'reply', number: 'VOC-2026-0012', value: '확인했습니다.' };
    const ok = V.actionNotice(info, { ok: true, message: '답변을 등록했습니다.' }, 1);
    expect(ok).toMatchObject({ id: 1, tone: 'ok', title: 'VOC-2026-0012에 답변을 등록했습니다.' });
    const fail = V.actionNotice(info, { ok: false, message: '400 — 티켓이 이미 종료되었습니다.' }, 2);
    expect(fail.tone).toBe('error');
    expect(fail.lines[0]).toEqual({ text: '400 — 티켓이 이미 종료되었습니다.', warn: true });
    expect(fail.lines[1].text).toContain('답변은 그대로');
    const status = V.actionNotice({ kind: 'status', number: 'VOC-2026-0012', from: 'in_progress', value: 'pending' }, { ok: true, message: '' }, 3);
    expect(status.title).toBe('VOC-2026-0012 상태를 ‘보류’로 바꿨습니다.');
    expect(V.normalizeActionResult({ ok: 'yes', message: 3 })).toEqual({ ok: false, message: '' });
    expect(V.normalizeActionResult({ ok: true, message: ' 끝 ', ticket: { id: 7 } })).toMatchObject({ ok: true, message: '끝', ticket: { id: 7 } });
  });
});

describe('보드에서 꺼내기 · 티켓 요약', () => {
  it('티켓 찾기(모든 칸) · 나 · 팀원(나 빼고 설정 순서) · 웹 주소', () => {
    const b = board();
    expect(V.ticketOnBoard(b, 5031)?.number).toBe('VOC-2026-0031');
    expect(V.ticketOnBoard(b, 5020)?.number).toBe('VOC-2026-0020');
    expect(V.ticketOnBoard(b, 9999)).toBeUndefined();
    expect(V.ticketOnBoard(null, 5012)).toBeUndefined();
    expect(V.boardMe(b)?.id).toBe(101);
    expect(V.boardMe({ ...b, me: undefined })?.id).toBe(101); // '나' 칸에서
    expect(V.boardTeam(b).map((m) => m.name)).toEqual(['김담당', '박담당']);
    expect(V.canOpenWeb(null)).toBe(true); // 보드를 아직 못 받았으면 main 이 정한다
    expect(V.canOpenWeb(b)).toBe(true);
    expect(V.canOpenWeb({ ...b, webBase: undefined })).toBe(false);
  });

  it('요약: 상태·우선순위·SLA(목표 시간)·고객사·시스템·요청자·요청유형·접수(KST)·기한(지나면 코랄)·답변', () => {
    const facts = V.ticketFacts(vocTask(), ticket(), today);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey.status).toMatchObject({ value: '진행 중', tone: 'amber' });
    expect(byKey.priority.value).toBe('P2');
    expect(byKey.sla).toMatchObject({ value: '임박 · 목표 48시간', tone: 'amber' });
    expect(byKey.customer.value).toBe('한결케미칼');
    expect(byKey.system.value).toBe('CMS(화학물질관리시스템)');
    expect(byKey.requester.value).toBe('최외부');
    expect(byKey.requestType.value).toBe('오류');
    expect(byKey.created.value).toBe('9월 21일 오전 10:30 · 7일째'); // UTC 01:30 → KST 10:30
    expect(byKey.customerDue).toMatchObject({ value: '9월 25일(지남)', tone: 'coral' });
    expect(byKey.ictDue).toMatchObject({ value: '10월 5일' });
    expect(byKey.replies.value).toBe('2건 · 마지막 9월 25일 오후 3:05');
    // 보드에 없으면 할 일에 든 값만
    expect(V.ticketFacts(vocTask(), undefined, today).map((f) => f.key)).toEqual(['status', 'priority', 'sla', 'customer', 'system']);
    expect(V.slaTargetText(90)).toBe('90분');
    expect(V.slaTargetText(0)).toBeUndefined();
  });

  it('요청 내용 접기: 12줄 넘으면 앞 12줄과 남은 줄 수', () => {
    const text = Array.from({ length: 15 }, (_, i) => `줄 ${i + 1}`).join('\n');
    expect(V.foldText(text)).toEqual({ head: text.split('\n').slice(0, 12).join('\n'), hidden: 3 });
    expect(V.foldText('짧다')).toEqual({ head: '짧다', hidden: 0 });
  });
});

// ── V3b 메일 → VOC 등록 ───────────────────────────────────────────────────────

describe('V3b 작성 칸', () => {
  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc)('할 일 줄의 [voc:: 번호] · VOC 로 등록할 수 있는 할 일', () => {
    expect(V.lineVocNumber('- [ ] 회신 [due:: 2026-09-30] [voc:: VOC-2026-9001]')).toBe('VOC-2026-9001');
    expect(V.lineVocNumber('- [ ] 회신 [voc:: ] [voc:: VOC-2026-9002]')).toBe('VOC-2026-9002');
    expect(V.lineVocNumber('- [ ] 회신 [vocx:: A]')).toBeUndefined();
    expect(V.lineVocNumber(undefined)).toBeUndefined();
    // 값이 빈·닫히지 않은 [voc:: 도 필드가 있는 것(main 의 hasLineField 와 같다 — 등록 버튼 대신 안내)
    for (const line of ['- [ ] 회신 [voc:: ]', '- [ ] 회신 [voc::]', '- [ ] 회신 [voc:: VOC-2026-0012', '- [ ] 회신 [ voc :: ']) {
      expect(V.lineVocNumber(line)).toBeUndefined();
      expect(V.lineHasVocField(line)).toBe(true);
    }
    expect(V.lineHasVocField('- [ ] 회신 [vocx:: A] [myvoc:: B]')).toBe(false);
    expect(V.lineHasVocField(undefined)).toBe(false);
    expect(V.canCreateVoc(mailTask())).toBe(true);
    expect(V.canCreateVoc(mailTask({ mail: ' ' }))).toBe(false);
    expect(V.canCreateVoc(vocTask({ mail: 'raw/mail/x.md' }))).toBe(false);
  });

  it('기본값은 한 번만 채운다(사람이 고친 값을 덮지 않는다) · 담당은 비움 · 고친 것이 있는가', () => {
    const blank = V.initialCreateDraft('11111111-2222-4333-8444-555555555555');
    expect(blank).toMatchObject({ prefilled: false, requestType: 'inquiry', priority: 'P3', assigneeId: '' });
    const filled = V.prefillCreateDraft(blank, ctx());
    expect(filled).toMatchObject({ prefilled: true, title: ctx().title, customerId: '11', system: 'SYS0101', assigneeId: '' });
    expect(V.prefillCreateDraft({ ...filled, title: '고친 제목' }, ctx()).title).toBe('고친 제목');
    expect(V.prefillCreateDraft(blank, ctx({ customerId: undefined, system: undefined, priority: 'high' }))).toMatchObject({
      customerId: '',
      system: '',
      priority: 'P3',
    });
    expect(V.isCreateDirty(filled, ctx())).toBe(false);
    expect(V.isCreateDirty({ ...filled, assigneeId: '102' }, ctx())).toBe(true);
    expect(V.isCreateDirty(blank, undefined)).toBe(false);
  });

  it('검사: 길이 → 보낼 수 없는 글자 → 빈 제목·고객사·시스템(안내) 순, 통과하면 입력 조립', () => {
    const d = V.prefillCreateDraft(V.initialCreateDraft('abcdefgh-0000-4000-8000-000000000000'), ctx());
    expect(V.checkVocCreate(d, [], false).ok).toBe(true);
    expect(V.checkVocCreate({ ...d, title: '가'.repeat(501) }, [], false).problem).toContain('500자');
    expect(V.checkVocCreate({ ...d, description: '가'.repeat(10_001) }, [], false).problem).toContain('10,000자');
    const dash = V.checkVocCreate({ ...d, description: `${d.description}\n일정 — 다음 주` }, ['—'], false);
    expect(dash.ok).toBe(false);
    expect(dash.charset).toContain('‘—’(내용)');
    // 글자 수는 한도 안이어도 VOC 에 보내는 모양(HTML — 꺾쇠는 &lt;)이 10,000자를 넘으면 막는다(서버 한도)
    const angles = V.checkVocCreate({ ...d, description: '<'.repeat(3000) }, [], false);
    expect(angles.ok).toBe(false);
    expect(angles.problem).toContain('VOC 에 보내는 모양');
    expect(angles.problem).toContain('12,007자');
    expect(V.checkVocCreate({ ...d, title: '  ' }, [], false).reason).toBe('제목을 적으면 등록할 수 있습니다.');
    expect(V.checkVocCreate({ ...d, customerId: '' }, [], false).reason).toBe('고객사를 고르면 등록할 수 있습니다.');
    expect(V.checkVocCreate({ ...d, system: '' }, [], false).reason).toBe('시스템을 고르면 등록할 수 있습니다.');
    expect(V.checkVocCreate(d, [], true).ok).toBe(false);

    expect(V.buildCreateInput(d, 'c:mail1')).toEqual<VocCreateInput>({
      createId: 'abcdefgh-0000-4000-8000-000000000000',
      taskId: 'c:mail1',
      title: ctx().title,
      description: ctx().description,
      customerId: 11,
      system: 'SYS0101',
      requestType: 'inquiry',
      priority: 'P3',
    });
    expect(V.buildCreateInput({ ...d, assigneeId: '102' }, 'c:mail1')?.assigneeId).toBe(102);
    expect(V.buildCreateInput({ ...d, customerId: '' }, 'c:mail1')).toBeNull();
    expect(V.buildCreateInput({ ...d, createId: '' }, 'c:mail1')).toBeNull();
  });

  it('선택지: 고객사 가나다순 · 시스템 "이름 (코드)" · 담당 = 비움·나·팀원(보드의 사람 칸) · 목록에 없는 지금 값은 맨 앞에', () => {
    const c = ctx();
    expect(V.customerOptions(c.directory.customers, '11').map((o) => o.label)).toEqual(['대륙물산', '서진화학', '한결케미칼']);
    expect(V.customerOptions([], '77')).toEqual([{ value: '77', label: '고객사 #77' }]);
    expect(V.systemOptions(c.directory.systems, 'SYS0101')[0]).toEqual({ value: 'SYS0101', label: 'CMS(화학물질관리시스템) (SYS0101)' });
    // 선택지가 비면(운영 VOC 의 code list SYSTEM 처럼) 지금 값 하나뿐 — main 이 받은 티켓의 시스템을 준다
    expect(V.systemOptions([], '')).toEqual([]);
    // 고른 고객사의 진행 중 티켓에 나온 시스템을 앞 묶음으로
    const systems = [
      { code: 'SYS0201', name: '그룹웨어', customerIds: [12, 14] },
      { code: 'SYS0101', name: 'CMS', customerIds: [11, 12] },
      { code: 'SYS0777', name: 'SYS0777' },
    ];
    expect(V.systemOptions(systems, '', '11')).toEqual([
      { value: 'SYS0101', label: 'CMS (SYS0101)', group: V.SYSTEM_GROUP_CUSTOMER },
      { value: 'SYS0201', label: '그룹웨어 (SYS0201)', group: V.SYSTEM_GROUP_OTHER },
      { value: 'SYS0777', label: 'SYS0777', group: V.SYSTEM_GROUP_OTHER },
    ]);
    expect(V.systemOptions(systems, '', '13').map((o) => [o.value, o.group])).toEqual([
      ['SYS0201', undefined],
      ['SYS0101', undefined],
      ['SYS0777', undefined],
    ]);
    expect(V.requestTypeOptions([], 'inquiry')).toEqual([{ value: 'inquiry', label: '문의' }]);
    expect(V.assigneeOptions(board(), c.directory.me, '')).toEqual([
      { value: '', label: '비움(지정하지 않음)' },
      { value: '101', label: '나(홍길동)' },
      { value: '102', label: '김담당' },
      { value: '103', label: '박담당' },
    ]);
    // 보드를 아직 못 받았으면 등록 문맥의 나만
    expect(V.assigneeOptions(null, c.directory.me, '').map((o) => o.value)).toEqual(['', '101']);
  });

  it('등록 문맥 응답 다듬기: null·모양이 틀리면 null, 빈 선택지·잘못된 항목은 걸러낸다', () => {
    expect(V.normalizeCreateContext(null)).toBeNull();
    const n = V.normalizeCreateContext({
      taskId: 'c:mail1',
      title: '제목',
      description: '한 줄\r\n두 줄',
      customerId: 11,
      system: 'SYS0101',
      existing: ' VOC-2026-9001 ',
      directory: { users: [{ id: 101, name: '홍길동' }, { id: 'x' }], customers: [{ id: 11, name: '한결케미칼' }, { id: '12' }], systems: [{ code: '' }] },
    });
    expect(n).toMatchObject({
      taskId: 'c:mail1',
      description: '한 줄\n두 줄',
      customerId: 11,
      existing: 'VOC-2026-9001',
      requestType: 'inquiry',
      priority: 'P3',
    });
    expect(n?.directory.users).toEqual([{ id: 101, name: '홍길동' }]);
    expect(n?.directory.customers).toEqual([{ id: 11, name: '한결케미칼' }]);
    expect(n?.directory.systems).toEqual([]);
  });

  it('확인 대화상자(명세 §6): Slack 알림·배정 메일·고객 메일 없음 + 제목·고객사·시스템·담당', () => {
    expect(V.CREATE_CONFIRM_LEAD).toContain('운영 Slack');
    expect(V.CREATE_CONFIRM_LEAD).toContain('담당을 지정하면 그 사람에게 배정 메일이 갑니다');
    expect(V.CREATE_CONFIRM_LEAD).toContain('고객에게는 메일이 가지 않습니다');
    const c = ctx();
    const d = V.prefillCreateDraft(V.initialCreateDraft('abcdefgh-0000-4000-8000-000000000000'), c);
    const args = {
      customers: V.customerOptions(c.directory.customers, d.customerId),
      systems: V.systemOptions(c.directory.systems, d.system),
      requestTypes: V.requestTypeOptions(c.directory.requestTypes, d.requestType),
      assignees: V.assigneeOptions(board(), c.directory.me, d.assigneeId),
    };
    const s = V.createConfirmSummary({ draft: d, ...args });
    expect(Object.fromEntries(s.rows.map((r) => [r.label, r.value]))).toEqual({
      제목: c.title,
      고객사: '한결케미칼',
      시스템: 'CMS(화학물질관리시스템) (SYS0101)',
      요청유형: '문의',
      우선순위: 'P3',
      담당: '비움',
    });
    expect(s.preview[0]).toBe('안녕하세요.');
    expect(s.after[0]).toContain('배정 메일은 가지 않습니다');
    const withKim = V.createConfirmSummary({ draft: { ...d, assigneeId: '102' }, ...args });
    expect(withKim.after[0]).toBe('담당 김담당에게 VOC 배정 메일이 갑니다.');
    expect(withKim.after.join(' ')).toContain('할 일 상태는 바꾸지 않습니다');
  });

  it('등록 결과: 줄에 붙였으면 ok, 못 붙였으면(lineError) warn + 번호 · 늘 "할 일은 그대로" · 배지 글자', () => {
    const ok = V.createNotice({ ticketId: 9001, number: 'VOC-2026-9001', lineUpdated: true, warnings: [] }, 1);
    expect(ok.tone).toBe('ok');
    expect(ok.title).toContain('VOC-2026-9001');
    expect(ok.lines.map((l) => l.text)).toEqual(['할 일 줄 끝에 [voc:: VOC-2026-9001]를 붙였습니다.', V.TASK_UNCHANGED_NOTE]);
    const lineFail = V.createNotice(
      { ticketId: 9001, number: 'VOC-2026-9001', lineUpdated: false, lineError: '할 일 줄을 찾지 못했습니다.', warnings: [] },
      2,
    );
    expect(lineFail.tone).toBe('warn');
    expect(lineFail.lines[0]).toEqual({ text: '할 일 줄에 번호를 붙이지 못했습니다. 할 일 줄을 찾지 못했습니다.', warn: true });
    expect(lineFail.lines[1].text).toContain('[voc:: VOC-2026-9001]');
    expect(lineFail.lines.at(-1)?.text).toBe('할 일은 그대로입니다. 끝났으면 완료로 저장하세요.');
    expect(V.createFailure('401 — 로그인이 필요합니다', 3)).toMatchObject({ tone: 'error', title: 'VOC 티켓을 만들지 못했습니다.' });
    expect(V.normalizeCreateResult({ ticketId: 9001, number: ' VOC-2026-9001 ', lineUpdated: true, warnings: ['', '주의'] })).toEqual({
      ticketId: 9001,
      number: 'VOC-2026-9001',
      lineUpdated: true,
      warnings: ['주의'],
    });
    expect(V.normalizeCreateResult({ number: 'VOC-1' })).toBeNull();
    expect(V.createdBadgeText('VOC-2026-9001')).toBe('VOC-2026-9001 로 등록함');
  });
});

// ── hooks/useVocCreate.ts: taskId 별 보관소와 쓰기 흐름(가짜 window.radar) ───────────────

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('쓰기 흐름(가짜 앱 연결)', () => {
  const api = {
    vocAction: vi.fn<(input: VocActionInput) => Promise<unknown>>(),
    checkVocText: vi.fn<(text: string) => Promise<unknown>>(),
    getVocCreateContext: vi.fn<(taskId: string) => Promise<unknown>>(),
    createVocTicket: vi.fn<(input: VocCreateInput) => Promise<unknown>>(),
    openVocWeb: vi.fn<(id: number) => Promise<void>>(),
    setMode: vi.fn<(mode: string, focus?: string) => Promise<void>>(),
  };
  let H: typeof import('../../src/renderer/hooks/useVocCreate');

  beforeEach(async () => {
    vi.resetModules();
    for (const f of Object.values(api)) f.mockReset();
    vi.stubGlobal('window', { radar: api });
    H = await import('../../src/renderer/hooks/useVocCreate');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('답변: 실행 중에는 같은 할 일의 다른 쓰기를 막고, 성공하면 칸을 비운다', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    api.vocAction.mockImplementation(() => new Promise((r) => (resolve = r)));
    H.updateVocTask('v:5012', { reply: '확인했습니다.\r\n' });
    const input: VocActionInput = { actionId: 'a1a1a1a1-0000-4000-8000-000000000000', kind: 'reply', ticketId: 5012, value: '확인했습니다.' };
    const info: V.VocActionInfo = { kind: 'reply', number: 'VOC-2026-0012', value: '확인했습니다.' };
    const first = H.runVocAction('v:5012', input, info);
    expect(H.peekVocTask('v:5012').busy).toBe('reply');
    expect(await H.runVocAction('v:5012', { ...input, actionId: 'b2b2b2b2-0000-4000-8000-000000000000', kind: 'status', value: 'pending' }, { ...info, kind: 'status', value: 'pending' })).toBe(false);
    resolve({ ok: true, message: '답변을 등록했습니다.' });
    expect(await first).toBe(true);
    expect(api.vocAction).toHaveBeenCalledTimes(1);
    expect(api.vocAction).toHaveBeenCalledWith(input);
    expect(H.peekVocTask('v:5012')).toMatchObject({ busy: null, reply: '' });
    expect(H.peekVocTask('v:5012').notice?.tone).toBe('ok');
  });

  it('답변 실패(ok:false·예외): 서버 문장을 알림으로, 적은 답변은 남긴다', async () => {
    H.updateVocTask('v:5012', { reply: '확인 중입니다.' });
    const info: V.VocActionInfo = { kind: 'reply', number: 'VOC-2026-0012', value: '확인 중입니다.' };
    api.vocAction.mockResolvedValueOnce({ ok: false, message: '400 — 작업 시간을 먼저 입력하세요.' });
    await H.runVocAction('v:5012', { actionId: 'c3c3c3c3-0000-4000-8000-000000000000', kind: 'reply', ticketId: 5012, value: '확인 중입니다.' }, info);
    expect(H.peekVocTask('v:5012')).toMatchObject({ busy: null, reply: '확인 중입니다.' });
    expect(H.peekVocTask('v:5012').notice).toMatchObject({ tone: 'error', lines: [{ text: '400 — 작업 시간을 먼저 입력하세요.', warn: true }, {}] });
    api.vocAction.mockRejectedValueOnce(new Error("Error invoking remote method 'radar:vocAction': Error: 형식이 틀립니다"));
    await H.runVocAction('v:5012', { actionId: 'd4d4d4d4-0000-4000-8000-000000000000', kind: 'reply', ticketId: 5012, value: '확인 중입니다.' }, info);
    expect(H.peekVocTask('v:5012').notice?.lines[0].text).toBe('형식이 틀립니다');
    expect(H.peekVocTask('v:5012').reply).toBe('확인 중입니다.');
  });

  it('CP949 검사: 같은 글은 다시 묻지 않고, 앱 연결에 없거나 실패하면 [](main 이 다시 검사한다)', async () => {
    api.checkVocText.mockResolvedValue(['😀']);
    expect(await H.checkCharsetNow('확인 😀')).toEqual(['😀']);
    expect(await H.checkCharsetNow('확인 😀')).toEqual(['😀']);
    expect(api.checkVocText).toHaveBeenCalledTimes(1);
    expect(await H.checkCharsetNow('   ')).toEqual([]);
    api.checkVocText.mockRejectedValueOnce(new Error('끊김'));
    expect(await H.checkCharsetNow('다른 글')).toEqual([]);
  });

  it('VOC 등록: 펴면 createId·기본값, 실패하면 입력·createId 그대로, 성공하면 배지·새 createId·칸 닫힘', async () => {
    api.getVocCreateContext.mockResolvedValue(ctx());
    H.openVocCreate('c:mail1');
    const opened = H.peekVocCreate('c:mail1');
    expect(opened.open).toBe(true);
    expect(opened.draft.createId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    await flush();
    expect(api.getVocCreateContext).toHaveBeenCalledWith('c:mail1');
    expect(H.peekVocCreate('c:mail1').context.status).toBe('ready');
    expect(H.peekVocCreate('c:mail1').draft).toMatchObject({ prefilled: true, title: ctx().title, customerId: '11' });
    const createId = H.peekVocCreate('c:mail1').draft.createId;
    // 다시 펴도 문맥을 또 읽지 않는다
    H.collapseVocCreate('c:mail1');
    H.openVocCreate('c:mail1');
    expect(api.getVocCreateContext).toHaveBeenCalledTimes(1);

    H.updateVocCreateDraft('c:mail1', { assigneeId: '102' });
    api.createVocTicket.mockRejectedValueOnce(new Error('VOC 서버에 연결하지 못했습니다'));
    expect(await H.submitVocCreate('c:mail1')).toBe(true);
    const failed = H.peekVocCreate('c:mail1');
    expect(failed).toMatchObject({ open: true, busy: false });
    expect(failed.created).toBeUndefined();
    expect(failed.draft).toMatchObject({ createId, assigneeId: '102' });
    expect(failed.notice?.tone).toBe('error');
    expect(api.createVocTicket.mock.calls[0][0]).toMatchObject({ createId, taskId: 'c:mail1', customerId: 11, system: 'SYS0101', assigneeId: 102 });

    // main 이 "이미 쓴 createId"(결과를 모르는 앞선 시도)로 거부하면 입력은 두고 createId 만 새로 — 확인 뒤 다시 누르면 새 티켓
    api.createVocTicket.mockRejectedValueOnce(
      new Error(`이 작성 칸의 앞선 등록 시도가 VOC 에 닿은 뒤 결과를 알 수 없습니다(시간 초과) — ${VOC_CREATE_ID_USED}. VOC 에 티켓이 생겼는지 확인하세요`),
    );
    await H.submitVocCreate('c:mail1');
    const rotated = H.peekVocCreate('c:mail1');
    expect(api.createVocTicket.mock.calls[1][0].createId).toBe(createId);
    expect(rotated.draft).toMatchObject({ assigneeId: '102' });
    expect(rotated.draft.createId).not.toBe(createId);
    expect(rotated.notice?.tone).toBe('error');
    const secondId = rotated.draft.createId;

    api.createVocTicket.mockResolvedValueOnce({ ticketId: 9001, number: 'VOC-2026-9001', lineUpdated: true, warnings: [] });
    await H.submitVocCreate('c:mail1');
    const done = H.peekVocCreate('c:mail1');
    expect(api.createVocTicket.mock.calls[2][0].createId).toBe(secondId);
    expect(done).toMatchObject({ open: false, busy: false, created: { number: 'VOC-2026-9001', ticketId: 9001 } });
    expect(done.draft.createId).not.toBe(createId);
    expect(done.notice?.lines.at(-1)?.text).toBe(V.TASK_UNCHANGED_NOTE);
  });

  it('VOC 등록: 검사를 통과하지 못한 작성 칸은 보내지 않는다 · 문맥이 null 이면 missing · 알아볼 수 없는 결과는 실패', async () => {
    api.getVocCreateContext.mockResolvedValueOnce(ctx({ customerId: undefined }));
    H.openVocCreate('c:mail2');
    await flush();
    expect(await H.submitVocCreate('c:mail2')).toBe(false); // 고객사를 고르지 않았다
    expect(api.createVocTicket).not.toHaveBeenCalled();

    H.updateVocCreateDraft('c:mail2', { customerId: '12' });
    api.createVocTicket.mockResolvedValueOnce({ ok: true });
    await H.submitVocCreate('c:mail2');
    expect(H.peekVocCreate('c:mail2').notice?.tone).toBe('error');
    expect(H.peekVocCreate('c:mail2').created).toBeUndefined();

    api.getVocCreateContext.mockResolvedValueOnce(null);
    H.openVocCreate('c:mail3');
    await flush();
    expect(H.peekVocCreate('c:mail3').context.status).toBe('missing');
  });

  it('로그인이 필요해 등록 문맥을 읽지 못한 칸은 로그인한 보드가 오면 다시 읽는다 — 받는 중에는 기다리고, 접은 칸·읽은 칸은 다시 읽지 않는다', async () => {
    let push: (b: unknown) => void = () => undefined;
    const withBoard = {
      ...api,
      getVocBoard: vi.fn(async () => board({ state: 'login', lanes: [] })),
      onVocBoard: vi.fn((cb: (b: unknown) => void) => {
        push = cb;
        return () => undefined;
      }),
    };
    vi.stubGlobal('window', { radar: withBoard });
    const loginError = new Error("Error invoking remote method 'radar:getVocCreateContext': Error: VOC 에 로그인이 필요합니다");
    api.getVocCreateContext.mockRejectedValue(loginError);
    H.openVocCreate('c:mail1'); // 펴 둔 칸
    H.openVocCreate('c:mail2');
    H.collapseVocCreate('c:mail2'); // 접은 칸
    await flush();
    expect(withBoard.getVocBoard).toHaveBeenCalledTimes(1);
    expect(H.peekVocCreate('c:mail1').context).toMatchObject({ status: 'error', message: 'VOC 에 로그인이 필요합니다' });
    expect(api.getVocCreateContext).toHaveBeenCalledTimes(2);

    // 로그인 → main 이 보드를 loading 으로 바꿔 방송 → 새로 받은 ok 보드
    api.getVocCreateContext.mockReset();
    api.getVocCreateContext.mockResolvedValue(ctx());
    push(board({ state: 'loading', lanes: [] }));
    await flush();
    expect(api.getVocCreateContext).not.toHaveBeenCalled();
    push(board());
    await flush();
    expect(api.getVocCreateContext).toHaveBeenCalledTimes(1);
    expect(api.getVocCreateContext).toHaveBeenCalledWith('c:mail1');
    expect(H.peekVocCreate('c:mail1').context.status).toBe('ready');
    expect(H.peekVocCreate('c:mail1').draft).toMatchObject({ prefilled: true, title: ctx().title });
    expect(H.peekVocCreate('c:mail2').context.status).toBe('error'); // 접은 칸은 펼 때 읽는다
    // 이어 오는 보드(폴링)에는 다시 읽지 않는다
    push(board());
    await flush();
    expect(api.getVocCreateContext).toHaveBeenCalledTimes(1);
    // 다시 로그인 필요 → 로그인: 읽은 칸(ready)은 다시 읽지 않는다
    push(board({ state: 'login' }));
    push(board({ state: 'stale' }));
    await flush();
    expect(api.getVocCreateContext).toHaveBeenCalledTimes(1);
  });

  it('배지 → VOC 화면의 그 티켓(view:voc:<번호>) · [VOC 에서 열기] 실패는 그 할 일의 알림으로', async () => {
    api.setMode.mockResolvedValue(undefined);
    H.showVocTicket('VOC-2026-9001');
    await flush();
    expect(api.setMode).toHaveBeenCalledWith('full', 'view:voc:VOC-2026-9001');
    api.openVocWeb.mockRejectedValueOnce(new Error('웹 주소를 모릅니다'));
    await H.openVocWeb('v:5012', 5012, 'VOC-2026-0012');
    expect(H.peekVocTask('v:5012').notice).toMatchObject({ tone: 'error', lines: [{ text: '웹 주소를 모릅니다', warn: true }] });
  });
});
