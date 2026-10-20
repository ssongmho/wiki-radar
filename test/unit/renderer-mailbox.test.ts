// 메일함 화면의 순수 함수(2.10단계 명세 §8·§9·§14-2 renderer-mailbox): 시각 표기·칩·내비/사이드바 표시·키보드 판정·
// 선택 다시 잡기·스레드 안 이동·[할 일로] 입력·동작 막힘·응답 다듬기.
import { describe, expect, it } from 'vitest';
import type { MailThreadDetail, MailThreadMail, MailThreadRow, MailboxSummary } from '../../src/shared/types';
import {
  INITIAL_MAIL_SELECTION,
  cleanTaskTitle,
  latestText,
  mailDateText,
  mailKeyAction,
  mailTargetKey,
  mailTargetPath,
  mailTaskBlock,
  mailTaskProblem,
  mailTaskTitle,
  mailTimeLabel,
  mailVocDone,
  mailboxUnavailable,
  navMailInfo,
  normalizeMessage,
  normalizePage,
  normalizeSummary,
  parseMailFocus,
  participantsText,
  pickMail,
  prevYmd,
  recipientsShort,
  reselectIndex,
  rowChips,
  selectionForTarget,
  sidebarMailInfo,
  sizeText,
  stepMail,
  threadArchived,
  threadReadKeys,
  mailListKey,
  threadKeys,
  type MailKeyContext,
} from '../../src/renderer/lib/mailbox';
import { afterMailSendLines, buildMailSendInput, initialReply } from '../../src/renderer/lib/reply';
import { FEATURES } from '../../src/shared/edition';

const K1 = 'm:0123456789abcdef';
const K2 = 'm:1111111111111111';
const K3 = 'u:2222222222222222';

function row(over: Partial<MailThreadRow> = {}): MailThreadRow {
  return {
    id: 'th:aaaaaaaaaaaa',
    subject: '제목',
    participants: ['김담당'],
    includesMe: false,
    latestDate: '2026-09-22T14:42:30+09:00',
    latestMs: 1,
    count: 1,
    unread: false,
    replyNeeded: false,
    archived: false,
    hasAttachments: false,
    suspicious: false,
    muted: false,
    folders: ['한결케미칼'],
    latestKey: K1,
    links: { tasks: 0 },
    ...over,
  };
}

function mail(over: Partial<MailThreadMail> = {}): MailThreadMail {
  return {
    key: K1,
    path: 'raw/mail/한결케미칼/2026/a.md',
    date: '2026-09-12T09:00:00+09:00',
    from: 'EHS팀 <ehs@hangyeol.example>',
    fromName: 'EHS팀',
    to: ['owner@example.com'],
    ccCount: 0,
    subject: '제목',
    folder: '한결케미칼',
    attachments: 0,
    suspicious: false,
    mine: false,
    muted: false,
    unread: false,
    replyNeeded: false,
    archived: false,
    ...over,
  };
}

function detail(mails: MailThreadMail[], over: Partial<MailThreadDetail> = {}): MailThreadDetail {
  return { id: 'th:bbbbbbbbbbbb', threadKey: '제목', subject: '제목', mails, links: { tasks: [], voc: [], sent: [] }, ...over };
}

function summary(over: Partial<MailboxSummary> = {}): MailboxSummary {
  return { state: 'ready', total: 10, unread: 2, replyNeeded: 1, revision: 3, top: [], ...over };
}

describe('시각 표기', () => {
  it('오늘은 HH:MM, 어제는 어제, 그 전은 M/D, 다른 해는 해까지', () => {
    expect(mailTimeLabel('2026-09-23T09:05:00+09:00', '2026-09-23')).toBe('09:05');
    expect(mailTimeLabel('2026-09-22T23:59:00+09:00', '2026-09-23')).toBe('어제');
    expect(mailTimeLabel('2026-09-12T09:00:00+09:00', '2026-09-23')).toBe('9/12');
    expect(mailTimeLabel('2025-12-31T09:00:00+09:00', '2026-01-02')).toBe('2025/12/31');
    expect(mailTimeLabel(undefined, '2026-09-23')).toBe('');
    expect(mailTimeLabel('엉터리', '2026-09-23')).toBe('');
  });
  it('적힌 벽시계 그대로(UTC 로 바꾸지 않는다) · 하루 앞 날짜는 달·해 경계를 넘는다', () => {
    expect(mailTimeLabel('2026-09-23T00:30:00+09:00', '2026-09-23')).toBe('00:30');
    expect(prevYmd('2026-03-01')).toBe('2026-02-28');
    expect(prevYmd('2026-01-01')).toBe('2025-12-31');
  });
  it('읽기 칸 날짜·머리 줄 최근 시각·크기', () => {
    expect(mailDateText('2026-09-22T14:42:30+09:00', '2026-09-23')).toBe('9월 22일 14:42');
    expect(mailDateText('2025-09-22T14:42:30+09:00', '2026-09-23')).toBe('2025년 9월 22일 14:42');
    expect(latestText('2026-09-23T09:58:00+09:00', '2026-09-23')).toBe('09:58');
    expect(latestText('2026-09-22T14:42:30+09:00', '2026-09-23')).toBe('9/22 14:42');
    expect(sizeText(512)).toBe('512B');
    expect(sizeText(1536)).toBe('1.5KB');
    expect(sizeText(3 * 1024 * 1024)).toBe('3MB');
    expect(sizeText(undefined)).toBe('');
  });
});

describe('줄 표시', () => {
  it('보낸이: 내가 있으면 「나, …」', () => {
    expect(participantsText(row())).toBe('김담당');
    expect(participantsText(row({ includesMe: true }))).toBe('나, 김담당');
    expect(participantsText(row({ includesMe: true, participants: [] }))).toBe('나');
    expect(participantsText(row({ participants: [] }))).toBe('(보낸이 없음)');
  });
  it('칩 순서·처리함이면 회신 필요 칩 없음', () => {
    const chips = rowChips(
      row({ suspicious: true, replyNeeded: true, hasAttachments: true, links: { tasks: 1, voc: 'VOC-2026-0001', replied: 'guess' } }),
    );
    expect(chips.map((c) => c.kind)).toEqual(['suspicious', 'reply', 'task', 'voc', 'replied', 'attach']);
    expect(chips.find((c) => c.kind === 'replied')?.label).toBe('회신 추정');
    expect(rowChips(row({ replyNeeded: true, archived: true })).map((c) => c.kind)).toEqual([]);
    expect(rowChips(row({ links: { tasks: 0, replied: 'sent' } }))[0].label).toBe('회신함');
  });
  it('받는이 짧게', () => {
    expect(recipientsShort([])).toBe('(받는이 없음)');
    expect(recipientsShort(['홍길동 <a@example.com>', 'b@example.com'])).toBe('홍길동, b@example.com');
    expect(recipientsShort(['a <a@x>', 'b <b@x>', 'c <c@x>', 'd <d@x>'])).toBe('a, b 외 2명');
  });
});

describe('내비·사이드바', () => {
  it('내비: 수 = 미확인 스레드, 쓸 수 없으면 이유와 글자', () => {
    expect(navMailInfo(null)).toEqual({ count: 0, replyNeeded: 0 });
    expect(navMailInfo(summary())).toEqual({ count: 2, replyNeeded: 1 });
    expect(navMailInfo(summary({ state: 'noWiki' }))).toMatchObject({ note: '위키 없음', unavailable: expect.stringContaining('개인 위키') });
    expect(navMailInfo(summary({ state: 'noMailDir', problem: '없음!' }))).toMatchObject({ note: '메일 없음', unavailable: '없음!' });
    expect(navMailInfo(summary({ state: 'indexing' }))).toMatchObject({ note: '읽는 중' });
    expect(navMailInfo(summary({ state: 'indexing' })).unavailable).toBeUndefined();
    expect(mailboxUnavailable(summary({ state: 'error' }))).toBeNull();
    expect(mailboxUnavailable(summary({ state: 'noMailDir' }))).toContain('받은 메일이 없습니다');
  });
  it('사이드바: 쓸 수 없거나 색인 전이면 숨김, 둘 다 0 이면 접음, 3줄까지 제목만', () => {
    expect(sidebarMailInfo(null, '2026-09-23').hidden).toBe(true);
    expect(sidebarMailInfo(summary({ state: 'noMailDir' }), '2026-09-23').hidden).toBe(true);
    expect(sidebarMailInfo(summary({ state: 'indexing' }), '2026-09-23').hidden).toBe(true);
    expect(sidebarMailInfo(summary({ unread: 0, replyNeeded: 0 }), '2026-09-23').empty).toBe(true);
    const top = [
      row({ id: 'th:000000000001', replyNeeded: true, subject: '하나' }),
      row({ id: 'th:000000000002', unread: true, subject: '둘', latestDate: '2026-09-23T08:00:00+09:00' }),
      row({ id: 'th:000000000003', unread: true }),
      row({ id: 'th:000000000004', unread: true }),
    ];
    const info = sidebarMailInfo(summary({ top, latestDate: '2026-09-23T08:00:00+09:00' }), '2026-09-23');
    expect(info.rows).toHaveLength(3);
    expect(info.rows[0]).toMatchObject({ chip: '회신 필요', subject: '하나', key: K1 });
    expect(info.rows[1]).toMatchObject({ chip: '미확인', time: '08:00' });
    expect(info.latest).toBe('08:00');
    expect(Object.keys(info.rows[0]).sort()).toEqual(['chip', 'id', 'key', 'subject', 'time']);
  });
  it('바깥에서 여는 표시', () => {
    expect(parseMailFocus('view:mail')).toEqual({});
    expect(parseMailFocus(`view:mail:${K1}`)).toEqual({ key: K1 });
    expect(parseMailFocus('view:mail:엉터리')).toEqual({});
    expect(parseMailFocus('view:voc')).toBeNull();
    expect(parseMailFocus(3)).toBeNull();
  });
});

describe('선택 다시 잡기', () => {
  const rows = [row({ id: 'th:000000000001', latestKey: K1 }), row({ id: 'th:000000000002', latestKey: K2 }), row({ id: 'th:000000000003', latestKey: K3 })];
  it('같은 id → 같은 메일 키 → 같은 자리(다음 스레드)', () => {
    expect(reselectIndex([], { threadId: null, threadKeys: [], index: 0 })).toBe(-1);
    expect(reselectIndex(rows, { threadId: null, threadKeys: [], index: 2 })).toBe(-1);
    expect(reselectIndex(rows, { threadId: 'th:000000000002', threadKeys: [], index: 0 })).toBe(1);
    // id 가 바뀌었어도(첫 메일이 바뀜) 메일 키로 찾는다
    expect(reselectIndex(rows, { threadId: 'th:ffffffffffff', threadKeys: ['x', K3], index: 0 })).toBe(2);
    // 없어졌으면(처리함으로) 같은 자리 = 다음 스레드, 끝이면 마지막
    expect(reselectIndex(rows, { threadId: 'th:ffffffffffff', threadKeys: ['zz'], index: 1 })).toBe(1);
    expect(reselectIndex(rows, { threadId: 'th:ffffffffffff', threadKeys: [], index: 9 })).toBe(2);
  });
  it('스레드 안 보일 메일: 고른 키 → 가장 최근 받은 메일(내 사본 밖)', () => {
    const d = detail([mail({ key: K1 }), mail({ key: K2 }), mail({ key: K3, mine: true })]);
    expect(pickMail(null, null)).toBeNull();
    expect(pickMail(d, K1)?.key).toBe(K1);
    expect(pickMail(d, null)?.key).toBe(K2);
    expect(pickMail(d, 'm:nope')?.key).toBe(K2);
    expect(pickMail(detail([mail({ key: K3, mine: true })]), null)?.key).toBe(K3);
    expect(stepMail(d, K2, 1)).toBe(K3);
    expect(stepMail(d, K2, -1)).toBe(K1);
    expect(stepMail(d, K3, 1)).toBeNull();
    expect(stepMail(d, null, -1)).toBe(K3);
  });
  it('처리함·키 목록·바깥 열기 필터', () => {
    const d = detail([mail({ key: K1, archived: true }), mail({ key: K2, archived: true })]);
    expect(threadArchived(d)).toBe(true);
    expect(threadArchived(detail([mail({ archived: true }), mail({ key: K2 })]))).toBe(false);
    expect(threadArchived(detail([]))).toBe(false);
    expect(threadKeys(d)).toEqual([K1, K2]);
    expect(selectionForTarget(d, K2)).toMatchObject({ filter: 'archived', threadId: d.id, mailKey: K2, threadKeys: [K1, K2], sub: 'read' });
    expect(selectionForTarget(detail([mail({ muted: true })]), 'm:nope')).toMatchObject({ filter: 'all', includeMuted: true, mailKey: null });
    expect(INITIAL_MAIL_SELECTION.sub).toBe('read');
    // 바깥에서 고른 선택은 목록에서 찾을 때까지 고정
    expect(selectionForTarget(d, K2).pin).toBe(true);
    expect(INITIAL_MAIL_SELECTION.pin).toBe(false);
  });

  it('처리함 판정은 내 사본을 세지 않는다(보낸 뒤 처리함 → 내 회신 사본이 와도 그대로)', () => {
    expect(threadArchived(detail([mail({ key: K1, archived: true }), mail({ key: K3, mine: true })]))).toBe(true);
    expect(threadArchived(detail([mail({ key: K3, mine: true })]))).toBe(false);
    expect(threadArchived(detail([mail({ key: K3, mine: true, archived: true })]))).toBe(true);
  });

  it('읽음은 스레드 단위(§3-3) — 보이는 메일이 미확인일 때 그 스레드의 미확인 메일 모두', () => {
    const d = detail([mail({ key: K1, unread: true }), mail({ key: K2, unread: true }), mail({ key: K3, mine: true })]);
    expect(threadReadKeys(d, d.mails[1])).toEqual([K1, K2]);
    expect(threadReadKeys(d, d.mails[2])).toEqual([]);
    expect(threadReadKeys(null, null)).toEqual([]);
    const one = detail([mail({ key: K1 }), mail({ key: K2, unread: true })]);
    expect(threadReadKeys(one, one.mails[1])).toEqual([K2]);
  });

  it('목록 질의 열쇠: 같은 질의면 같다', () => {
    expect(mailListKey({ filter: 'all' })).toBe(mailListKey({ filter: 'all', folder: null, query: '', includeMuted: false }));
    expect(mailListKey({ filter: 'unread' })).not.toBe(mailListKey({ filter: 'all' }));
  });
});

describe('키보드(§8-4)', () => {
  const base: MailKeyContext = { key: '', editable: false, inDialog: false, inList: false };
  const k = (key: string, over: Partial<MailKeyContext> = {}) => mailKeyAction({ ...base, key, ...over });
  it('목록·읽기 칸 이동', () => {
    expect(k('ArrowDown')).toBe('next');
    expect(k('ArrowUp')).toBe('prev');
    expect(k('Enter', { inList: true })).toBe('enterReader');
    expect(k('ArrowRight', { inList: true })).toBe('enterReader');
    expect(k('Enter')).toBeNull();
    expect(k('Escape')).toBe('toList');
    expect(k('Escape', { inList: true })).toBeNull();
    expect(k('/')).toBe('search');
    expect(k('[')).toBe('prevMail');
    expect(k(']')).toBe('nextMail');
  });
  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc)('입력 칸 밖에서만 글자 단축키, 대화상자·수식키면 아무것도', () => {
    expect(['r', 'E', 'm', 'u', 'v', 't'].map((c) => k(c))).toEqual(['reply', 'archive', 'replyNeeded', 'unread', 'voc', 'task']);
    expect(k('r', { editable: true })).toBeNull();
    expect(k('ArrowDown', { editable: true })).toBeNull();
    expect(k('Escape', { editable: true })).toBeNull();
    expect(k('ArrowDown', { inDialog: true })).toBeNull();
    expect(k('r', { ctrlKey: true })).toBeNull();
    expect(k('ArrowDown', { shiftKey: true })).toBeNull();
    expect(k('x')).toBeNull();
  });
});

describe('[할 일로] 입력·동작 막힘', () => {
  it('제목 기본값: RE/FW 걷고 줄 형식을 깨는 글자 뺌', () => {
    expect(mailTaskTitle('RE: RE: 통영공장 [긴급] #1 확인')).toBe('통영공장 긴급 1 확인');
    expect(mailTaskTitle('Fwd: 회신：견적')).toBe('견적');
    expect(cleanTaskTitle('a\nb\u0007c')).toBe('a b c');
    expect(Array.from(mailTaskTitle('가'.repeat(300))).length).toBe(200);
  });
  it('입력 검사', () => {
    expect(mailTaskProblem({ title: '', pri: '', due: '' })).toContain('제목');
    expect(mailTaskProblem({ title: 'a[b', pri: '', due: '' })).toContain('[ ]');
    expect(mailTaskProblem({ title: 'ok', pri: '4', due: '' })).toContain('우선순위');
    expect(mailTaskProblem({ title: 'ok', pri: '', due: '2026-02-30' })).toContain('달력');
    expect(mailTaskProblem({ title: 'ok', pri: '2', due: '2026-10-01' })).toBeNull();
  });
  it('막힘: 개인 위키 없음 · 메일함에서 만든 줄 · 연결된 할 일', () => {
    const m = mail();
    expect(mailTaskBlock({ personalMissing: false, supported: true, detail: detail([m]), mail: m })).toBeNull();
    expect(mailTaskBlock({ personalMissing: true, supported: true, detail: detail([m]), mail: m })).toContain('개인 위키');
    expect(mailTaskBlock({ personalMissing: false, supported: false, detail: null, mail: m })).toContain('기능이 없습니다');
    expect(mailTaskBlock({ personalMissing: false, supported: true, detail: null, mail: mail({ taskFile: '_private/mgmt/내 할 일.md' }) })).toContain(
      '이미 할 일이 있습니다',
    );
    const linked = detail([m], { links: { tasks: [{ taskId: 't1', title: '회신', status: 'open' }], voc: [], sent: [] } });
    expect(mailTaskBlock({ personalMissing: false, supported: true, detail: linked, mail: m })).toBe('이미 할 일이 있습니다(회신).');
    expect(mailVocDone(mail({ voc: 'VOC-1' }), 'VOC-2')).toBe('VOC-1');
    expect(mailVocDone(mail(), 'VOC-2')).toBe('VOC-2');
    expect(mailVocDone(null)).toBeUndefined();
  });
  it('회신·VOC 작성 칸 열쇠는 할 일 id 와 섞이지 않는다', () => {
    const key = mailTargetKey('raw/mail/a/2026/b.md');
    expect(mailTargetPath(key)).toBe('raw/mail/a/2026/b.md');
    expect(mailTargetPath('task-123')).toBeNull();
  });
});

describe('메일함 회신(§7-1)', () => {
  it('보낸 뒤 안내: 회신 필요 해제 · 처리함 · 위키에 쓰지 않음/연결 할 일', () => {
    expect(afterMailSendLines(true, 0)).toEqual([
      '이 메일의 「회신 필요」 표시를 지웁니다.',
      '이 스레드를 처리함으로 옮깁니다.',
      '위키에는 아무것도 쓰지 않습니다(발송 기록만 앱 데이터에 남깁니다).',
    ]);
    expect(afterMailSendLines(false, 2)[1]).toContain('그대로 둡니다');
    expect(afterMailSendLines(false, 2)[2]).toContain('연결된 할 일은 그대로');
  });
  it('보내기 입력에는 taskId·save 가 없다', () => {
    const s = { ...initialReply('11111111-1111-4111-8111-111111111111'), to: '구매팀 <buy@daeryuk.example>', subject: 'RE: 문의', body: '안녕하세요' };
    const input = buildMailSendInput(s, 'raw/mail/대륙물산/2026/a.md', true);
    expect(input).toMatchObject({ path: 'raw/mail/대륙물산/2026/a.md', archiveAfter: true, to: ['구매팀 <buy@daeryuk.example>'], subject: 'RE: 문의' });
    expect(input).not.toHaveProperty('taskId');
    expect(input).not.toHaveProperty('save');
  });
});

describe('응답 다듬기', () => {
  it('요약·쪽: 모양이 틀리면 버리거나 기본값', () => {
    expect(normalizeSummary(null)).toBeNull();
    expect(normalizeSummary({ state: 'weird' })).toBeNull();
    const s = normalizeSummary({ state: 'ready', total: 3, unread: -1, replyNeeded: 'x', revision: 2, top: [{ id: 'bad' }, row()] });
    expect(s).toMatchObject({ state: 'ready', total: 3, unread: 0, replyNeeded: 0, revision: 2 });
    expect(s?.top).toHaveLength(1);
    const p = normalizePage({ threads: [row(), { id: 'th:zz' }], total: 5, counts: { all: 5 }, folders: [{ name: '가', count: 2, unread: 1 }, { count: 1 }] });
    expect(p.threads).toHaveLength(1);
    expect(p.counts).toEqual({ all: 5, unread: 0, replyNeeded: 0, archived: 0 });
    expect(p.folders).toEqual([{ name: '가', count: 2, unread: 1 }]);
    expect(normalizePage(undefined).threads).toEqual([]);
  });
  it('메일 한 통: 본문은 글자 그대로, 실행형 첨부는 경로를 버린다', () => {
    const body = '<script>alert(1)</script>\n<img src="https://tracker.example.invalid/p.gif">';
    const m = normalizeMessage({
      path: 'raw/mail/x/2026/a.md',
      subject: 's',
      from: 'f',
      to: ['a'],
      cc: 'x',
      folder: 'x',
      suspicion: ['s1'],
      suspicious: true,
      body,
      truncated: false,
      attachments: [
        { name: 'a.png', size: 10, rel: 'raw/mail/_attachments/abc123/a.png', blocked: false },
        { name: 'b.exe', size: 1, rel: 'raw/mail/_attachments/abc123/b.exe', blocked: true },
      ],
      wikiLinks: ['한결케미칼'],
    });
    expect(m?.body).toBe(body);
    expect(m?.cc).toEqual([]);
    expect(m?.attachments[0].rel).toBe('raw/mail/_attachments/abc123/a.png');
    expect(m?.attachments[1]).toEqual({ name: 'b.exe', size: 1, blocked: true });
    expect(normalizeMessage({ subject: 'no path' })).toBeNull();
  });
});
