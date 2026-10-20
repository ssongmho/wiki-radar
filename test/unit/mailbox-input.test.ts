// 메일함 IPC 인자 검사(docs/stage2.10-contract.md §11) — 길이·형식·개수 경계.
import { describe, expect, it } from 'vitest';
import {
  requireCreateMailTaskInput,
  requireMailDraftInput,
  requireMailKey,
  requireMailPath,
  requireMailThreadId,
  requireMailThreadQuery,
  requireMailVocCreateInput,
  requireRevealInput,
  requireSendMailReplyInput,
  requireSetMailStateInput,
} from '../../src/main/mail/mailboxInput';

const P = 'raw/mail/대륙물산/2026/2026-09-20_1000_박담당_자재 문의_d1d2d3.md';
const KEY = 'm:0123456789abcdef';

describe('requireMailPath', () => {
  it('raw/mail 안 .md 만, 1024자 이하, _attachments 아님', () => {
    expect(requireMailPath(P)).toBe(P);
    expect(requireMailPath(P.replace(/\//g, '\\'))).toBe(P);
    for (const bad of [
      '',
      'raw/mail/../wiki/x.md',
      'wiki/x.md',
      'C:/x/raw/mail/a.md',
      '/raw/mail/a/2026/x.md',
      'raw/mail/a/2026/x.txt',
      'raw/mail/_attachments/abc123/x.md',
      'raw/mail/a/2026/x\u0000.md',
      `raw/mail/${'가'.repeat(1100)}.md`,
      3,
      null,
    ]) {
      expect(() => requireMailPath(bad)).toThrow('잘못된 요청');
    }
  });
});

describe('키·id', () => {
  it('메일 키·스레드 id 형식', () => {
    expect(requireMailKey(KEY)).toBe(KEY);
    expect(() => requireMailKey('m:0123')).toThrow();
    expect(() => requireMailKey(1)).toThrow();
    expect(requireMailThreadId('th:0123456789ab')).toBe('th:0123456789ab');
    expect(() => requireMailThreadId('th:0123456789abc')).toThrow();
  });
});

describe('requireMailThreadQuery', () => {
  const ok = { filter: 'all', offset: 0, limit: 200 };
  it('경계', () => {
    expect(requireMailThreadQuery(ok)).toEqual(ok);
    expect(requireMailThreadQuery({ ...ok, offset: 100_000, limit: 1 })).toMatchObject({ offset: 100_000, limit: 1 });
    expect(() => requireMailThreadQuery({ ...ok, offset: 100_001 })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, offset: -1 })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, limit: 0 })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, limit: 201 })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, limit: 1.5 })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, filter: 'spam' })).toThrow();
  });
  it('folder 1~80자·제어 문자 없음, query 0~200자, includeMuted 불리언', () => {
    expect(requireMailThreadQuery({ ...ok, folder: '가'.repeat(80) }).folder).toHaveLength(80);
    expect(() => requireMailThreadQuery({ ...ok, folder: '가'.repeat(81) })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, folder: '' })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, folder: 'a\nb' })).toThrow();
    expect(requireMailThreadQuery({ ...ok, query: 'q'.repeat(200) }).query).toHaveLength(200);
    expect(() => requireMailThreadQuery({ ...ok, query: 'q'.repeat(201) })).toThrow();
    expect(requireMailThreadQuery({ ...ok, query: '   ' }).query).toBeUndefined();
    expect(requireMailThreadQuery({ ...ok, includeMuted: true }).includeMuted).toBe(true);
    expect(() => requireMailThreadQuery({ ...ok, includeMuted: 'yes' })).toThrow();
  });
  it('keep 은 스레드 id 0~5개', () => {
    expect(requireMailThreadQuery({ ...ok, keep: ['th:0123456789ab'] }).keep).toEqual(['th:0123456789ab']);
    expect(requireMailThreadQuery({ ...ok, keep: [] }).keep).toBeUndefined();
    expect(() => requireMailThreadQuery({ ...ok, keep: Array(6).fill('th:0123456789ab') })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, keep: ['../x'] })).toThrow();
    expect(() => requireMailThreadQuery({ ...ok, keep: 'th:0123456789ab' })).toThrow();
  });
});

describe('requireSetMailStateInput', () => {
  it('키 1~500개, 바꿀 것 하나(불리언)', () => {
    expect(requireSetMailStateInput({ keys: [KEY], change: { read: true } })).toEqual({ keys: [KEY], change: { read: true } });
    expect(requireSetMailStateInput({ keys: Array(500).fill(KEY), change: { archived: false } }).keys).toHaveLength(500);
    expect(() => requireSetMailStateInput({ keys: Array(501).fill(KEY), change: { read: true } })).toThrow();
    expect(() => requireSetMailStateInput({ keys: [], change: { read: true } })).toThrow();
    expect(() => requireSetMailStateInput({ keys: ['bad'], change: { read: true } })).toThrow();
    expect(() => requireSetMailStateInput({ keys: [KEY], change: { read: true, archived: true } })).toThrow();
    expect(() => requireSetMailStateInput({ keys: [KEY], change: { memo: true } })).toThrow();
    expect(() => requireSetMailStateInput({ keys: [KEY], change: { replyNeeded: 1 } })).toThrow();
  });
});

describe('requireRevealInput', () => {
  it('index 0~199 정수', () => {
    expect(requireRevealInput({ path: P, index: 199 })).toEqual({ path: P, index: 199 });
    expect(() => requireRevealInput({ path: P, index: 200 })).toThrow();
    expect(() => requireRevealInput({ path: P, index: -1 })).toThrow();
    expect(() => requireRevealInput({ path: 'wiki/x.md', index: 0 })).toThrow();
  });
});

describe('requireMailDraftInput', () => {
  it('note 0~4000자, hint 0~500자', () => {
    expect(requireMailDraftInput({ path: P, note: '' })).toEqual({ path: P, note: '' });
    expect(requireMailDraftInput({ path: P, note: 'a\r\nb', hint: ' 짧게 ' })).toEqual({ path: P, note: 'a\nb', hint: '짧게' });
    expect(() => requireMailDraftInput({ path: P, note: 'x'.repeat(4001) })).toThrow();
    expect(() => requireMailDraftInput({ path: P, note: '', hint: 'x'.repeat(501) })).toThrow();
    expect(() => requireMailDraftInput({ path: P, note: 'a\u0001' })).toThrow();
  });
});

describe('requireSendMailReplyInput', () => {
  const ok = {
    sendId: 'abcdef12-3456',
    path: P,
    to: ['a@x.example'],
    cc: [],
    subject: 'RE: 자재 문의',
    body: '본문\r\n둘째 줄',
    quoteOriginal: true,
    archiveAfter: true,
  };
  it('형·길이·archiveAfter', () => {
    expect(requireSendMailReplyInput(ok)).toEqual({ ...ok, body: '본문\n둘째 줄' });
    expect(() => requireSendMailReplyInput({ ...ok, sendId: 'short' })).toThrow('sendId');
    expect(() => requireSendMailReplyInput({ ...ok, archiveAfter: 'yes' })).toThrow('archiveAfter');
    expect(() => requireSendMailReplyInput({ ...ok, quoteOriginal: undefined })).toThrow('quoteOriginal');
    expect(() => requireSendMailReplyInput({ ...ok, to: Array(21).fill('a@x.example') })).toThrow('20명');
    expect(() => requireSendMailReplyInput({ ...ok, to: Array(15).fill('a@x.example'), cc: Array(6).fill('b@x.example') })).toThrow('20명');
    expect(() => requireSendMailReplyInput({ ...ok, path: 'wiki/x.md' })).toThrow();
    expect(() => requireSendMailReplyInput({ ...ok, to: ['x'.repeat(321)] })).toThrow();
  });
  it('taskId·save 는 받지 않는다(무시)', () => {
    const out = requireSendMailReplyInput({ ...ok, taskId: 'c:1', save: { x: 1 } }) as unknown as Record<string, unknown>;
    expect(out.taskId).toBeUndefined();
    expect(out.save).toBeUndefined();
  });
});

describe('requireMailVocCreateInput', () => {
  const ok = {
    createId: 'abcdef12-3456',
    path: P,
    title: '자재 문의',
    description: '내용',
    customerId: 7,
    system: 'SYS0001',
    requestType: 'inquiry',
    priority: 'P3',
  };
  it('2.6 규칙에서 taskId 대신 path', () => {
    const out = requireMailVocCreateInput(ok);
    expect(out).toEqual(ok);
    expect((out as unknown as Record<string, unknown>).taskId).toBeUndefined();
    expect(() => requireMailVocCreateInput({ ...ok, path: undefined })).toThrow();
    expect(() => requireMailVocCreateInput({ ...ok, priority: 'P9' })).toThrow();
    expect(() => requireMailVocCreateInput({ ...ok, title: ' ' })).toThrow('제목');
    expect(requireMailVocCreateInput({ ...ok, assigneeId: 3 }).assigneeId).toBe(3);
  });
});

describe('requireCreateMailTaskInput', () => {
  it('제목 1~200자, [ ] # 줄바꿈 없음, pri 1~3, due 달력 날짜', () => {
    expect(requireCreateMailTaskInput({ path: P, title: ' 자재 문의 회신 ' })).toEqual({ path: P, title: '자재 문의 회신' });
    expect(requireCreateMailTaskInput({ path: P, title: 'a', pri: 3, due: '2026-10-01' })).toEqual({ path: P, title: 'a', pri: 3, due: '2026-10-01' });
    expect(requireCreateMailTaskInput({ path: P, title: '가'.repeat(200) }).title).toHaveLength(200);
    expect(() => requireCreateMailTaskInput({ path: P, title: '가'.repeat(201) })).toThrow('200자');
    for (const bad of ['', '  ', 'a [b]', '#태그', 'a\nb', `a${String.fromCharCode(0x2028)}b`]) {
      expect(() => requireCreateMailTaskInput({ path: P, title: bad })).toThrow();
    }
    expect(() => requireCreateMailTaskInput({ path: P, title: 'a', pri: 0 })).toThrow();
    expect(() => requireCreateMailTaskInput({ path: P, title: 'a', pri: 4 })).toThrow();
    expect(() => requireCreateMailTaskInput({ path: P, title: 'a', due: '2026-02-30' })).toThrow('달력');
    expect(() => requireCreateMailTaskInput({ path: P, title: 'a', due: '2026/10/01' })).toThrow();
  });
});
