// renderer 메일 회신 순수 함수(2.5단계 명세 §7 — src/renderer/lib/reply.ts) 시험:
// 작성 칸 기본값·전체 회신·보내기 전 검사·초안 받기·확인 대화상자 요약·발송 결과 알림·main 응답 다듬기.
import { describe, expect, it } from 'vitest';
import { PARTIAL_SAVE_PREFIX } from '../../src/shared/ipc';
import type { ReplyContext, SaveResultOutput, SendReplyInput, SendReplyOutput, SentMailRecord, Task } from '../../src/shared/types';
import * as P from '../../src/renderer/lib/reply';
import { NOTE_MAX, NOTE_SAVE_MAX, buildSaveInput, draftProblem, initialDraft, noteInputMax, ownNoteLength } from '../../src/renderer/lib/result';

const task: Task = {
  id: 'c:mail1',
  source: 'checkbox',
  title: '통영공장 인벤토리 확인 회신',
  status: 'open',
  bucket: 'thisWeek',
  mail: 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md',
};

const ctx = (p: Partial<ReplyContext> = {}): ReplyContext => ({
  taskId: task.id,
  mail: task.mail as string,
  original: {
    subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
    from: '한결케미칼 EHS팀 <ehs@hangyeol.example>',
    to: ['owner@example.com'],
    cc: ['Kim <kim@hangyeol.example>'],
    messageId: 'fixture-0001@hangyeol.example',
  },
  to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
  ccAll: ['Kim <kim@hangyeol.example>', 'lee@hangyeol.example'],
  subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
  quote: '-----Original Message-----\nFrom: 한결케미칼 EHS팀 <ehs@hangyeol.example>',
  suspicious: [],
  sender: { ready: true, address: 'owner@example.com', name: '송담당', bccSelf: true },
  ...p,
});

const ready = (p: Partial<ReplyContext> = {}): P.ContextEntry => ({ status: 'ready', ctx: ctx(p) });

/** 기본값을 채운 작성 칸 */
const filled = (p: Partial<P.ReplyState> = {}): P.ReplyState => ({
  ...P.prefillReply({ ...P.initialReply('11111111-2222-4333-8444-555555555555'), enabled: true }, ctx()),
  ...p,
});

describe('작성 칸 기본값', () => {
  it('sendId: randomUUID 를 쓰고, 없으면 getRandomValues 로 같은 꼴(main 이 받는 8~64자 영문·숫자·하이픈)', () => {
    expect(P.makeSendId({ randomUUID: () => 'abcdef12-0000-4000-8000-000000000000' })).toBe('abcdef12-0000-4000-8000-000000000000');
    const id = P.makeSendId({ getRandomValues: (a: Uint8Array) => a.fill(0xab) });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(P.makeSendId({})).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(P.makeSendId()).not.toBe(P.makeSendId());
  });
  it('처음 칸: 꺼짐·빈 입력·원문 인용 켬', () => {
    const s = P.initialReply('id-12345678');
    expect(s).toMatchObject({ enabled: false, prefilled: false, to: '', cc: '', subject: '', body: '', quoteOriginal: true, ccAllApplied: false });
    expect(s.draft).toEqual({ state: 'idle', references: [], notes: '', received: false });
    expect(P.isReplyDirty(s)).toBe(false);
    expect(P.isReplyDirty({ ...s, enabled: true })).toBe(true);
    expect(P.isReplyDirty({ ...s, body: '  ' })).toBe(false);
    expect(P.isReplyDirty({ ...s, body: '안녕하세요' })).toBe(true);
  });
  it('회신 문맥으로 받는사람(", " 로 이음)·제목을 한 번만 채운다 — 참조는 비운다', () => {
    const s = filled();
    expect(s.prefilled).toBe(true);
    expect(s.to).toBe('한결케미칼 EHS팀 <ehs@hangyeol.example>');
    expect(s.subject).toBe('RE: 통영공장 CMS 인벤토리 사용량 확인 요청');
    expect(s.cc).toBe('');
    // 사람이 고친 값은 다시 채우지 않는다
    const edited = { ...s, to: 'x@y.zz', subject: '바꾼 제목' };
    expect(P.prefillReply(edited, ctx({ to: ['other@a.bc'] }))).toBe(edited);
  });
  it('주소 잇기: 이름에 쉼표가 있으면 따옴표로 감싸 다시 나눠도 한 주소', () => {
    const joined = P.joinAddresses(['"Kim, A" <a@x.com>', 'b@y.com', '  ']);
    expect(joined).toBe('"Kim, A" <a@x.com>, b@y.com');
    expect(P.replyInput({ ...filled(), to: joined }).to).toEqual(['"Kim, A" <a@x.com>', 'b@y.com']);
  });
  it('보낼 값: 쉼표·세미콜론·줄바꿈으로 나누고, 제목은 앞뒤 공백을 떼고, 본문은 LF', () => {
    const input = P.replyInput(filled({ to: 'a@x.com; B <b@y.com>\nc@z.com', cc: '', subject: '  RE: 제목 ', body: '가\r\n나\r다' }));
    expect(input).toEqual({ to: ['a@x.com', 'B <b@y.com>', 'c@z.com'], cc: [], subject: 'RE: 제목', body: '가\n나\n다' });
  });
});

describe('전체 회신', () => {
  it('ccAll 을 참조에 채우고(받는사람·참조에 이미 있는 것·대소문자만 다른 것은 뺀다), 다시 누르면 참조를 비운다', () => {
    const c = ctx({ ccAll: ['Kim <KIM@hangyeol.example>', 'ehs@hangyeol.example', 'lee@hangyeol.example', 'Lee2 <LEE@hangyeol.example>'] });
    const s = filled({ cc: 'kim@hangyeol.example' });
    expect(P.ccAllToAdd(s, c)).toEqual(['lee@hangyeol.example']);
    const on = P.toggleCcAll(s, c);
    expect(on.cc).toBe('kim@hangyeol.example, lee@hangyeol.example');
    expect(on.ccAllApplied).toBe(true);
    const off = P.toggleCcAll(on, c);
    expect(off.cc).toBe('');
    expect(off.ccAllApplied).toBe(false);
  });
  it('더할 주소가 없으면 그대로', () => {
    const s = filled();
    expect(P.toggleCcAll(s, ctx({ ccAll: [] }))).toBe(s);
    expect(P.toggleCcAll(s, ctx({ ccAll: ['한결 <EHS@hangyeol.example>'] }))).toBe(s);
  });
});

describe('보내기 전 검사', () => {
  it('문맥을 읽는 중·원본 없음·불러오기 실패면 보낼 수 없다(문제 문장은 없다)', () => {
    const s = filled();
    expect(P.checkReply(s, { status: 'idle' })).toEqual({ ok: false, reason: '회신 정보를 불러오는 중입니다…', problem: null });
    expect(P.checkReply(s, { status: 'loading' }).ok).toBe(false);
    expect(P.checkReply(s, { status: 'missing' }).reason).toContain('원본 메일을 찾지 못해');
    expect(P.checkReply(s, { status: 'error', message: '읽기 실패' }).reason).toContain('읽기 실패');
    // 다시 읽는 중이어도 앞서 읽은 문맥이 있으면 그것으로 판단한다
    expect(P.checkReply({ ...s, body: '회신 본문' }, { status: 'loading', ctx: ctx() }).ok).toBe(true);
    // 기본값을 아직 못 채웠으면(켜자마자) 기다린다
    expect(P.checkReply({ ...P.initialReply('x-12345678'), enabled: true }, ready()).ok).toBe(false);
  });
  it('본문이 비기만 했으면 안내만(빨간 문제 문장 없음), 받는사람 문제는 본문이 비어도 알린다', () => {
    const empty = P.checkReply(filled(), ready());
    expect(empty.ok).toBe(false);
    expect(empty.problem).toBeNull();
    expect(empty.reason).toContain('[초안 만들기]');
    const badTo = P.checkReply(filled({ to: '' }), ready());
    expect(badTo.problem).toContain('받는사람');
    expect(P.checkReply(filled({ to: 'a@b.c\r\nBcc: x@y.z', body: '본문' }), ready()).problem).toContain('주소 형식');
  });
  it('[확인 필요 가 남은 본문은 거부', () => {
    const r = P.checkReply(filled({ body: '완료 예정일은 [확인 필요: 완료 예정일]입니다.' }), ready());
    expect(r.ok).toBe(false);
    expect(r.problem).toContain('[확인 필요');
    expect(r.reason).toContain('문제를 고치면');
  });
  it('계정이 없으면 막는다 — 이유는 짧은 안내(자세한 sender.problem 은 보내는 쪽 줄이 보인다), 입력 문제는 그대로 보인다', () => {
    const problem = '메일 계정이 없습니다: _mail-ingest/.env에 MAILHOST_MAIL_USER·MAILHOST_MAIL_PASS를 넣으세요';
    const noAccount = ready({ sender: { ready: false, problem, bccSelf: true } });
    const r = P.checkReply(filled({ body: '회신 본문' }), noAccount);
    expect(r).toEqual({ ok: false, reason: P.SENDER_NOT_READY, problem: null });
    // [보내고 저장] 옆 안내가 같은 긴 문장을 되풀이하지 않는다
    expect(r.reason).not.toContain('MAILHOST_MAIL_PASS');
    expect(P.checkReply(filled({ body: '[확인 필요: x]' }), noAccount).problem).toContain('[확인 필요');
  });

  it('안내 문장 잇기: 끝 부호가 없으면 마침표를 붙인다', () => {
    expect(P.asSentence('메일 계정이 없습니다: …를 설정하세요')).toBe('메일 계정이 없습니다: …를 설정하세요.');
    expect(P.asSentence('시험 중에는 실제 메일 서버에 접속하지 않습니다')).toBe('시험 중에는 실제 메일 서버에 접속하지 않습니다.');
    expect(P.asSentence('메일 계정 파일(_mail-ingest/.env)을 읽지 못했습니다 (EBUSY)')).toBe(
      '메일 계정 파일(_mail-ingest/.env)을 읽지 못했습니다 (EBUSY).',
    );
    expect(P.asSentence('이미 끝남.  ')).toBe('이미 끝남.');
    expect(P.asSentence('정말?')).toBe('정말?');
    expect(P.asSentence('')).toBe('');
  });

  it('안내 문장의 파일 경로·변수 이름은 코드 조각으로(줄이 이름 중간에서 끊기지 않게)', () => {
    const text =
      '메일 계정이 없습니다: _mail-ingest/.env에 MAILHOST_MAIL_USER·MAILHOST_MAIL_PASS를 넣거나 WIKI_RADAR_SMTP_USER·WIKI_RADAR_SMTP_PASS를 설정하세요.';
    const parts = P.codeParts(text);
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual([
      '_mail-ingest/.env',
      'MAILHOST_MAIL_USER',
      'MAILHOST_MAIL_PASS',
      'WIKI_RADAR_SMTP_USER',
      'WIKI_RADAR_SMTP_PASS',
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    // 백틱으로 감싼 것도 코드(백틱은 뗀다). 대문자 약어(ENOENT)·밑줄 없는 낱말은 코드가 아니다
    expect(P.codeParts('파일 `a b.txt` (ENOENT) SMTP')).toEqual([
      { text: '파일 ', code: false },
      { text: 'a b.txt', code: true },
      { text: ' (ENOENT) SMTP', code: false },
    ]);
    expect(P.codeParts('')).toEqual([]);
  });

  it('reply-panel data-ready: 다 읽었을 때만 — 다시 읽는 중에는 옛 값이 있어도 없고, 실패·원본 없음은 false', () => {
    const readyCtx = ctx();
    const notReady = ctx({ sender: { ready: false, problem: '계정 없음', bccSelf: true } });
    expect(P.panelReadyAttr({ status: 'ready', ctx: readyCtx })).toBe('true');
    expect(P.panelReadyAttr({ status: 'ready', ctx: notReady })).toBe('false');
    expect(P.panelReadyAttr({ status: 'idle' })).toBeUndefined();
    expect(P.panelReadyAttr({ status: 'loading' })).toBeUndefined();
    expect(P.panelReadyAttr({ status: 'loading', ctx: readyCtx }), '다시 읽는 중에는 옛 값을 붙이지 않는다').toBeUndefined();
    expect(P.panelReadyAttr({ status: 'loading', ctx: notReady })).toBeUndefined();
    expect(P.panelReadyAttr({ status: 'missing' })).toBe('false');
    expect(P.panelReadyAttr({ status: 'error', message: 'x' })).toBe('false');
    expect(P.panelReadyAttr({ status: 'error', message: 'x', ctx: readyCtx }), '다시 읽기 실패도 false').toBe('false');
    expect(P.panelReadyAttr(undefined)).toBeUndefined();
  });
  it('초안을 만드는 중·초안 확인을 기다리는 중에는 보낼 수 없다', () => {
    const running = P.startDraftState(filled({ body: '본문' }), 1000);
    expect(P.checkReply(running, ready()).reason).toContain('초안을 만드는 중');
    const pending = P.receiveDraft(running, 1000, { body: '새 초안', references: [], notes: '', durationMs: 5 });
    expect(pending.pendingDraft).toBeDefined();
    expect(P.checkReply(pending, ready()).reason).toContain('바꿀지 먼저');
  });
  it('문제없으면 보낼 수 있다', () => {
    expect(P.checkReply(filled({ body: '안녕하세요.\n확인했습니다.' }), ready())).toEqual({ ok: true, reason: null, problem: null });
  });
});

describe('sendReply 입력', () => {
  it('sendId·나눈 주소·quoteOriginal + 2단계 저장 입력(상태를 안 바꾸고 처리 내용이 없어도 된다)', () => {
    const s = filled({ cc: 'lee@hangyeol.example', body: '확인했습니다.\r\n감사합니다.', quoteOriginal: false });
    const input = P.buildSendInput(s, task, initialDraft(task));
    expect(input).toEqual({
      sendId: '11111111-2222-4333-8444-555555555555',
      taskId: task.id,
      to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
      cc: ['lee@hangyeol.example'],
      subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
      body: '확인했습니다.\n감사합니다.',
      quoteOriginal: false,
      save: { taskId: task.id, status: 'open', reflect: false },
    });
    const done = P.buildSendInput(s, task, { ...initialDraft(task), status: 'done', note: ' 8월분 재집계 반영 ', reflect: true });
    expect(done.save).toEqual({ taskId: task.id, status: 'done', note: '8월분 재집계 반영', reflect: true });
  });
  it('초안에 넘길 처리 내용은 저장 입력처럼 다듬는다', () => {
    expect(P.draftNote(' 첫 줄\r\n둘째\u0007 줄 \n')).toBe('첫 줄\n둘째 줄');
    expect(P.draftNote('a\tb')).toBe('a\tb');
  });
});

describe('초안 받기', () => {
  const draft = { body: '안녕하세요.\n8월 사용량을 다시 반영했습니다.', references: ['wiki/entities/한결케미칼.md', 'wiki\\entities\\한결케미칼.md', ''], notes: '반영 시각 확인', durationMs: 35_000 };
  it('본문이 비었으면 바로 넣는다', () => {
    const run = P.startDraftState(filled(), 500);
    expect(run.draft).toMatchObject({ state: 'running', startedAt: 500 });
    const got = P.receiveDraft(run, 500, draft);
    expect(got.body).toBe(draft.body);
    expect(got.pendingDraft).toBeUndefined();
    expect(got.draft).toEqual({ state: 'done', references: ['wiki/entities/한결케미칼.md'], notes: '반영 시각 확인', durationMs: 35_000, received: true });
  });
  it('본문이 있으면 바꿀지 묻는다 — 바꾸기/그대로 두기', () => {
    const run = P.startDraftState(filled({ body: '내가 쓴 본문' }), 500);
    const got = P.receiveDraft(run, 500, draft);
    expect(got.body).toBe('내가 쓴 본문');
    expect(got.pendingDraft?.body).toBe(draft.body);
    const yes = P.acceptPendingDraft(got);
    expect(yes.body).toBe(draft.body);
    expect(yes.pendingDraft).toBeUndefined();
    const no = P.rejectPendingDraft(got);
    expect(no.body).toBe('내가 쓴 본문');
    expect(no.pendingDraft).toBeUndefined();
    expect(no.draft.references).toEqual(['wiki/entities/한결케미칼.md']);
    expect(P.draftStatus(no, 0).text).toContain('그대로 두었습니다');
  });
  it('멈춘 뒤·다른 실행의 늦은 결과는 버린다', () => {
    const run = P.startDraftState(filled(), 500);
    expect(P.receiveDraft(run, 499, draft)).toBe(run);
    const stopped = P.stopDraft(run);
    expect(stopped.draft).toMatchObject({ state: 'idle', message: '초안 만들기를 멈췄습니다.' });
    expect(P.receiveDraft(stopped, 500, draft)).toBe(stopped);
    expect(P.failDraft(stopped, 500, '중단됨')).toBe(stopped);
    expect(P.stopDraft(stopped)).toBe(stopped);
  });
  it('실패·빈 초안·망가진 결과', () => {
    const run = P.startDraftState(filled(), 7);
    const failed = P.failDraft(run, 7, '초안 형식을 읽지 못했습니다');
    expect(failed.draft).toMatchObject({ state: 'failed', message: '초안 형식을 읽지 못했습니다' });
    expect(failed.draft.startedAt).toBeUndefined();
    expect(P.receiveDraft(run, 7, { body: '   ' }).draft.state).toBe('failed');
    expect(P.receiveDraft(run, 7, null).draft.state).toBe('failed');
    const odd = P.receiveDraft(run, 7, { body: '가'.repeat(20_010), references: 'x', notes: 3 });
    expect(Array.from(odd.body).length).toBe(20_000);
    expect(odd.draft).toMatchObject({ references: [], notes: '', durationMs: 0 });
  });
  it('다시 만들면 확인을 기다리던 초안은 버리고, 받은 적이 있는지(다시 만들기)는 남긴다', () => {
    const got = P.receiveDraft(P.startDraftState(filled({ body: '본문' }), 1), 1, draft);
    const again = P.startDraftState(got, 2);
    expect(again.pendingDraft).toBeUndefined();
    expect(again.draft).toMatchObject({ state: 'running', received: true, message: undefined });
  });
});

describe('초안 진행 문장', () => {
  it('경과 시간 m:ss', () => {
    expect(P.formatTimer(0)).toBe('0:00');
    expect(P.formatTimer(35_400)).toBe('0:35');
    expect(P.formatTimer(65_000)).toBe('1:05');
    expect(P.formatTimer(720_000)).toBe('12:00');
    expect(P.formatTimer(-5)).toBe('0:00');
    expect(P.formatTimer(Number.NaN)).toBe('0:00');
  });
  it('실행 중·받음·확인 대기·실패·처음', () => {
    const run = P.startDraftState(filled(), 10_000);
    expect(P.draftStatus(run, 45_000)).toEqual({ text: 'Claude가 원본 메일과 위키를 읽는 중…', timer: '0:35' });
    const done = P.receiveDraft(run, 10_000, { body: '본문', references: [], notes: '', durationMs: 35_000 });
    expect(P.draftStatus(done, 0).text).toBe('초안을 받았습니다(35초). 사실·날짜를 확인하고 고친 뒤 보내세요.');
    // 1초가 안 걸렸으면 '(0초)'를 붙이지 않는다
    const quick = P.receiveDraft(P.startDraftState(filled(), 7), 7, { body: '본문', durationMs: 420 });
    expect(P.draftStatus(quick, 0).text).toBe('초안을 받았습니다. 사실·날짜를 확인하고 고친 뒤 보내세요.');
    const pending = P.receiveDraft(P.startDraftState({ ...done, body: '고친 본문' }, 1), 1, { body: '새 초안' });
    expect(P.draftStatus(pending, 0).text).toContain('바꿀지');
    expect(P.draftStatus(P.failDraft(P.startDraftState(filled(), 3), 3, '시간 초과'), 0).text).toBe('초안을 만들지 못했습니다. (시간 초과)');
    expect(P.draftStatus(filled(), 0).text).toContain('메일을 보내지는 않습니다');
    expect(P.draftStatus(filled(), 0).timer).toBeUndefined();
  });
});

describe('표시 문구', () => {
  it('받는사람 요약: 이름(없으면 주소), 3명 넘으면 외 N명', () => {
    expect(P.recipientsText(['한결 EHS <ehs@h.example>', 'kim@h.example'])).toBe('한결 EHS, kim@h.example');
    expect(P.recipientsText(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co', 'e@x.co'])).toBe('a@x.co, b@x.co, c@x.co 외 2명');
    expect(P.recipientsText([])).toBe('(없음)');
  });
  it('발송 줄은 main 과 같은 꼴 — 참조가 있으면 끝에 참조 N명', () => {
    expect(P.sentLineText(['한결케미칼 EHS팀 <ehs@hangyeol.example>'], [], 'RE: 확인')).toBe(
      '메일 회신 발송 — 받는사람: 한결케미칼 EHS팀 · 제목: RE: 확인',
    );
    expect(P.sentLineText(['a@x.co', 'B <b@x.co>'], ['c@x.co', 'd@x.co'], 'RE: 확인')).toBe(
      '메일 회신 발송 — 받는사람: a@x.co, B · 제목: RE: 확인 · 참조 2명',
    );
  });
  it('보냈지만 저장 실패: 처리 내용이 한도 가까이 있어도 발송 줄을 붙인 뒤 다시 [저장]할 수 있다', () => {
    const input = { to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'], cc: ['lee@hangyeol.example'], subject: 'RE: 통영공장 인벤토리 확인 요청' };
    const note = '가'.repeat(NOTE_MAX - 30);
    const draft = { ...initialDraft(task), status: 'done' as const, note };
    expect(draftProblem(draft)).toBeNull();
    const after = P.withSentLine(draft, input);
    expect(after.note.length).toBeGreaterThan(NOTE_MAX);
    expect(after.note.endsWith(P.sentLineText(input.to, input.cc, input.subject))).toBe(true);
    expect(after.sentLines).toEqual([P.sentLineText(input.to, input.cc, input.subject)]);
    expect(draftProblem(after), '앱이 붙인 발송 줄은 처리 내용 한도(4000자)에 세지 않는다').toBeNull();
    expect(ownNoteLength(after)).toBe(note.length);
    expect(noteInputMax(after)).toBe(NOTE_MAX + P.sentLineText(input.to, input.cc, input.subject).length + 1);
    // 저장 입력에는 발송 줄까지 그대로 들어간다(main 한도 8000자 안)
    expect(buildSaveInput(task, after).note).toBe(after.note);
    expect((buildSaveInput(task, after).note ?? '').length).toBeLessThanOrEqual(NOTE_SAVE_MAX);
    // 사람이 더 적어 제 몫이 한도를 넘으면 그때는 막는다
    expect(draftProblem({ ...after, note: `${'나'.repeat(40)}${after.note}` })).toContain(`${NOTE_MAX}자`);
    // 발송 줄을 지우면 보통 검사로 돌아간다
    expect(draftProblem({ ...after, note: '가'.repeat(NOTE_MAX + 1) })).toContain(`${NOTE_MAX}자`);
    // 두 번 보냈다 실패하면 두 줄 모두 세지 않는다
    const twice = P.withSentLine(after, { ...input, subject: 'RE: 두 번째' });
    expect(twice.sentLines).toHaveLength(2);
    expect(draftProblem(twice)).toBeNull();
    // 합친 길이가 main 한도를 넘으면 알린다
    expect(draftProblem({ ...after, note: `${note}\n${'다'.repeat(NOTE_SAVE_MAX)}`, sentLines: ['다'.repeat(NOTE_SAVE_MAX)] })).toContain(
      `${NOTE_SAVE_MAX}자`,
    );
  });
  it('보냈지만 저장 실패: 처리 내용 끝에 발송 줄을 붙인다(한 번만)', () => {
    const input = { to: ['a@x.co'], cc: [], subject: 'RE: 확인' };
    const base = initialDraft(task);
    const once = P.withSentLine({ ...base, note: '재집계함\n' }, input);
    expect(once.note).toBe('재집계함\n메일 회신 발송 — 받는사람: a@x.co · 제목: RE: 확인');
    expect(P.withSentLine(once, input)).toBe(once);
    expect(P.withSentLine(base, input).note).toBe('메일 회신 발송 — 받는사람: a@x.co · 제목: RE: 확인');
  });
  it('지난 발송 배지 "회신함 9/28 14:02 · 받는사람 …"(이 PC 시간대), 해가 다르면 해를 붙인다', () => {
    const at = new Date(2026, 8, 28, 14, 2).toISOString();
    const record: SentMailRecord = {
      id: 's1',
      at,
      taskId: task.id,
      taskTitle: task.title,
      mail: task.mail as string,
      to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
      cc: ['lee@hangyeol.example'],
      bcc: ['owner@example.com'],
      subject: 'RE: 확인',
      messageId: '<m1@example.com>',
    };
    expect(P.lastSentText(record, '2026-09-28')).toBe('회신함 9/28 14:02 · 받는사람 한결케미칼 EHS팀');
    expect(P.sentAtText(new Date(2025, 11, 31, 9, 5).toISOString(), '2026-01-02')).toBe('2025/12/31 09:05');
    expect(P.sentAtText('어제', '2026-09-28')).toBe('');
    expect(P.lastSentText({ ...record, at: '' }, '2026-09-28')).toBe('회신함 · 받는사람 한결케미칼 EHS팀');
    expect(P.lastSentDetail(record)).toBe('제목: RE: 확인\n받는사람: 한결케미칼 EHS팀 <ehs@hangyeol.example>\n참조: lee@hangyeol.example');
  });
  it('보내는 사람: 설정의 이름을 먼저, 없으면 문맥의 이름, 주소가 없으면 빈 글자', () => {
    expect(P.senderText(ctx())).toBe('송담당 <owner@example.com>');
    expect(P.senderText(ctx(), { fromName: '홍길동', signature: '', bccSelf: true })).toBe('홍길동 <owner@example.com>');
    expect(P.senderText(ctx(), { fromName: '', signature: '', bccSelf: true })).toBe('owner@example.com');
    expect(P.senderText(ctx({ sender: { ready: false, bccSelf: true } }))).toBe('');
    expect(P.bccSelfOn(ctx(), { fromName: '', signature: '', bccSelf: false })).toBe(false);
    expect(P.bccSelfOn(ctx({ sender: { ready: true, bccSelf: false } }))).toBe(false);
  });
  it('설정 요약', () => {
    expect(P.settingsSummary(P.DEFAULT_MAIL_SETTINGS)).toBe('이름 없음(주소만) · 서명 없음 · 나에게 숨은참조');
    expect(P.settingsSummary({ fromName: ' 홍길동 ', signature: '홍길동 드림\n010-0000-0000\n', bccSelf: false })).toBe('이름 홍길동 · 서명 2줄');
  });
});

describe('확인 대화상자 요약', () => {
  it('받는사람·참조·숨은참조(나)·제목·본문 앞 6줄(앞 빈 줄은 건너뜀)·붙는 것·보낸 뒤', () => {
    const body = '\n\n1\n2\n3\n4\n5\n6\n7\n8\n';
    const state = filled({ cc: 'lee@hangyeol.example', body });
    const save = { taskId: task.id, status: 'done' as const, note: '반영함', reflect: true };
    const s = P.confirmSummary({ task, state, ctx: ctx(), settings: { fromName: '홍길동', signature: '홍길동 드림', bccSelf: true }, save });
    expect(s.from).toBe('홍길동 <owner@example.com>');
    expect(s.to).toEqual(['한결케미칼 EHS팀 <ehs@hangyeol.example>']);
    expect(s.cc).toEqual(['lee@hangyeol.example']);
    expect(s.bcc).toEqual(['owner@example.com']);
    expect(s.subject).toBe('RE: 통영공장 CMS 인벤토리 사용량 확인 요청');
    expect(s.preview).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(s.moreLines).toBe(2);
    expect(s.appended).toEqual(['서명', '원문 인용']);
    expect(s.suspicious).toEqual([]);
    expect(s.after).toEqual([
      '할 일을 ‘완료’로 저장합니다.',
      '처리 내용과 발송 줄을 ‘할 일 메모’에 남깁니다.',
      '반영 대기열에 넣습니다(보낸 본문 포함).',
      '목록에서 빠지고 다음 할 일로 넘어갑니다.',
    ]);
  });
  it('숨은참조를 끄면 없음, 서명·인용이 없으면 붙는 것 없음, 피싱 의심 신호는 그대로', () => {
    const state = filled({ body: '짧은 본문', quoteOriginal: false });
    const s = P.confirmSummary({
      task,
      state,
      ctx: ctx({ suspicious: ['보낸사람 도메인 불일치'] }),
      settings: { fromName: '', signature: '  ', bccSelf: false },
      save: { taskId: task.id, status: 'open', reflect: false },
    });
    expect(s.bcc).toEqual([]);
    expect(s.appended).toEqual([]);
    expect(s.moreLines).toBe(0);
    expect(s.suspicious).toEqual(['보낸사람 도메인 불일치']);
    expect(s.after).toEqual(['할 일 상태는 ‘대기’ 그대로 둡니다.', '발송 줄(받는사람·제목)을 ‘할 일 메모’에 남깁니다.']);
  });
  it('계정 아이디가 메일 주소가 아니면 숨은참조를 보이지 않는다(main 도 넣지 않는다)', () => {
    const s = P.confirmSummary({
      task,
      state: filled({ body: '본문' }),
      ctx: ctx({ sender: { ready: true, address: 'radar', bccSelf: true } }),
      settings: { fromName: '', signature: '', bccSelf: true },
      save: { taskId: task.id, status: 'done', reflect: false },
    });
    expect(s.from).toBe('radar');
    expect(s.bcc).toEqual([]);
  });
  it('내 일 아님은 넘길 담당을 보인다(비우면 타담당)', () => {
    expect(P.afterSendLines(task, { taskId: task.id, status: 'notmine', reflect: false })).toContain('넘길 담당: 타담당');
    expect(P.afterSendLines(task, { taskId: task.id, status: 'notmine', owner: '박담당', reflect: false })[0]).toBe(
      '할 일을 ‘내 일 아님’으로 저장합니다.',
    );
  });
});

describe('발송 결과 알림', () => {
  const input: SendReplyInput = {
    sendId: 'send-0001',
    taskId: task.id,
    to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
    cc: [],
    subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
    body: '확인했습니다.',
    quoteOriginal: true,
    save: { taskId: task.id, status: 'done', reflect: false },
  };
  const sent: SentMailRecord = {
    id: 'send-0001',
    at: '2026-09-28T05:02:00.000Z',
    taskId: task.id,
    taskTitle: task.title,
    mail: task.mail as string,
    to: input.to,
    cc: [],
    bcc: ['owner@example.com'],
    subject: input.subject,
    messageId: '<m1@example.com>',
  };
  const saved: SaveResultOutput = {
    date: '2026-09-28',
    updated: ['통영공장 인벤토리 확인 회신 [done]'],
    loggedDone: [],
    loggedDelegated: [],
    loggedWip: [],
    unlogged: [],
    memo: true,
    unmatched: [],
    files: ['_private/mgmt/내 할 일.md', '_private/mgmt/할 일 메모.md'],
    backupDir: '_todo-sync/backup/20260928T140200',
    warnings: [],
  };

  it('보내고 저장함: ok — 제목에 받는사람·저장 상태, 저장 알림 줄 + 발송 줄 메모', () => {
    const n = P.summarizeSend(task, input, { sent, save: saved, warnings: [] }, 3);
    expect(n.id).toBe(3);
    expect(n.tone).toBe('ok');
    expect(n.title).toBe('‘통영공장 인벤토리 확인 회신’ 회신을 보냈습니다 — 받는사람 한결케미칼 EHS팀 · 완료로 저장했습니다');
    const texts = n.lines.map((l) => l.text);
    expect(texts[0]).toBe('제목: RE: 통영공장 CMS 인벤토리 사용량 확인 요청');
    expect(texts).toContain('숨은참조: owner@example.com');
    expect(texts).toContain('위키 파일 2개를 고쳤습니다.');
    expect(texts).toContain('발송 줄을 ‘할 일 메모’에 남겼습니다.');
    expect(texts.some((t) => t.startsWith('처리 내용을'))).toBe(false);
    const withNote = P.summarizeSend(task, { ...input, save: { ...input.save, note: '반영함' } }, { sent, save: saved, warnings: [] }, 4);
    expect(withNote.lines.map((l) => l.text)).toContain('처리 내용과 발송 줄을 ‘할 일 메모’에 남겼습니다.');
  });
  it('발송 기록 경고·찾지 못한 앵커가 있으면 warn(경고 줄은 뒤로)', () => {
    const n = P.summarizeSend(
      task,
      input,
      { sent, save: { ...saved, unmatched: ['x — 문구 미발견: a.md / y'] }, warnings: ['발송 기록을 남기지 못했습니다'] },
      5,
    );
    expect(n.tone).toBe('warn');
    const warn = n.lines.filter((l) => l.warn).map((l) => l.text);
    expect(warn).toEqual(['찾지 못함: x — 문구 미발견: a.md / y', '발송 기록을 남기지 못했습니다']);
    expect(n.lines[n.lines.length - 1].text).toBe('발송 기록을 남기지 못했습니다');
  });
  it('보냈지만 저장 실패: warn — "메일은 보냈습니다. 위키 기록은 실패 — 같은 상태로 다시 [저장]하세요"', () => {
    const out: SendReplyOutput = { sent, saveError: '위키에 저장하지 못했습니다: 파일이 계속 바뀜', warnings: [] };
    const n = P.summarizeSend(task, input, out, 6);
    expect(n.tone).toBe('warn');
    expect(n.title).toBe('메일은 보냈습니다. 위키 기록은 실패 — 같은 상태로 다시 [저장]하세요');
    expect(n.lines[0].text).toBe('‘통영공장 인벤토리 확인 회신’ 회신 — 받는사람 한결케미칼 EHS팀');
    expect(n.lines.find((l) => l.warn)?.text).toBe('위키에 저장하지 못했습니다: 파일이 계속 바뀜');
    expect(n.lines.some((l) => l.text.includes('메일은 다시 보내지 않습니다'))).toBe(true);
    const partial = P.summarizeSend(task, input, { ...out, saveError: `${PARTIAL_SAVE_PREFIX}: x` }, 7);
    expect(partial.lines.some((l) => l.text.includes('일부만 저장했습니다'))).toBe(true);
    // 저장 결과가 아예 없어도 보낸 것으로 알린다
    expect(P.summarizeSend(task, input, { sent, warnings: [] }, 8).title).toContain('메일은 보냈습니다');
  });
  it('망가진 응답도 견딘다(보낸 값은 입력에서)', () => {
    const n = P.summarizeSend(task, input, {} as SendReplyOutput, 9);
    expect(n.tone).toBe('warn');
    expect(n.lines[0].text).toContain('받는사람 한결케미칼 EHS팀');
  });
  it('발송 실패: error — 입력은 남아 있다', () => {
    const n = P.sendFailure(task, '메일 계정 인증에 실패했습니다(메일 전용 비밀번호 확인)', 10);
    expect(n.tone).toBe('error');
    expect(n.title).toBe('‘통영공장 인벤토리 확인 회신’ 회신을 보내지 못했습니다.');
    expect(n.lines[0]).toEqual({ text: '메일 계정 인증에 실패했습니다(메일 전용 비밀번호 확인)', warn: true });
    expect(n.lines[1].text).toContain('입력한 회신도 남아 있습니다');
  });
});

describe('main 응답 다듬기', () => {
  it('회신 문맥: null·모양이 틀린 값은 null, 빠진 칸은 기본값', () => {
    expect(P.normalizeReplyContext(null)).toBeNull();
    expect(P.normalizeReplyContext('x')).toBeNull();
    const c = P.normalizeReplyContext({ to: ['a@x.co', 3, ''], sender: { ready: 'yes' }, suspicious: 'no' });
    expect(c).toMatchObject({
      to: ['a@x.co'],
      ccAll: [],
      subject: '',
      quote: '',
      suspicious: [],
      sender: { ready: false, bccSelf: true },
      original: { subject: '', from: '', to: [], cc: [] },
    });
    expect(c?.lastSent).toBeUndefined();
  });
  it('회신 문맥: 제대로 된 값은 그대로(지난 발송 포함)', () => {
    const full = { ...ctx(), lastSent: { id: 's1', at: '2026-09-28T05:02:00.000Z', to: ['a@x.co'], cc: [], bcc: [], subject: 'RE: x', messageId: '<m>', taskId: task.id, taskTitle: task.title, mail: 'raw/mail/a.md' } };
    const c = P.normalizeReplyContext(full);
    expect(c).toEqual(full);
    expect(P.normalizeReplyContext({ ...full, lastSent: { id: 's1' } })?.lastSent).toBeUndefined();
  });
  it('설정: 빠진 칸은 기본값(나에게 숨은참조 켬)', () => {
    expect(P.normalizeMailSettings(null)).toEqual({ fromName: '', signature: '', bccSelf: true });
    expect(P.normalizeMailSettings({ fromName: '홍길동', signature: 1, bccSelf: false })).toEqual({ fromName: '홍길동', signature: '', bccSelf: false });
  });
  it('들고 있는 문맥: 읽는 중·실패여도 앞서 읽은 값', () => {
    const c = ctx();
    expect(P.contextOf(undefined)).toBeUndefined();
    expect(P.contextOf({ status: 'idle' })).toBeUndefined();
    expect(P.contextOf({ status: 'missing' })).toBeUndefined();
    expect(P.contextOf({ status: 'loading', ctx: c })).toBe(c);
    expect(P.contextOf({ status: 'error', message: 'x', ctx: c })).toBe(c);
    expect(P.contextOf({ status: 'ready', ctx: c })).toBe(c);
  });
});
