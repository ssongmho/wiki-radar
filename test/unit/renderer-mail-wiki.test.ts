// 2.14단계 화면 순수 함수(docs/stage2.14-contract.md §8·§9): 목록 칩 · 단축키 W · 버튼 막힘·글자 · 스레드 줄 표시 ·
// 이미 대기 중인 항목 찾기 · 회사 밖 안내 · 반영 대기 화면의 mail 항목 표시 · 옛 preload(버튼 숨김) 판정.
import { describe, expect, it } from 'vitest';
import type { MailThreadDetail, MailThreadMail, MailThreadRow, QueueItem } from '../../src/shared/types';
import {
  mailKeyAction,
  mailWikiBlock,
  mailWikiButtonLabel,
  mailWikiDuplicateText,
  mailWikiExisting,
  mailWikiOutsideText,
  mailWikiState,
  mailWikiSupported,
  normalizePage,
  rowChips,
  threadHasSuspicious,
  threadWikiText,
} from '../../src/renderer/lib/mailbox';
import { normalizeQueue, queueMailCount, queueSendCounts, queueSourceText, queueStatusText } from '../../src/renderer/lib/queue';

const TODAY = '2026-09-23';

function row(links: MailThreadRow['links']): MailThreadRow {
  return {
    id: 'th:000000000001',
    subject: '제목',
    participants: ['김담당'],
    includesMe: false,
    latestMs: 0,
    count: 1,
    unread: false,
    replyNeeded: false,
    archived: false,
    hasAttachments: false,
    suspicious: false,
    muted: false,
    folders: ['가상상사'],
    latestKey: 'm:0000000000000001',
    links,
  };
}

function mail(key: string, over: Partial<MailThreadMail> = {}): MailThreadMail {
  return {
    key,
    path: `raw/mail/가상상사/2026/${key.slice(2)}.md`,
    from: '김담당 <kim@vendor.example>',
    fromName: '김담당',
    to: [],
    ccCount: 0,
    subject: '제목',
    folder: '가상상사',
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

function detail(mails: MailThreadMail[]): MailThreadDetail {
  return { id: 'th:000000000001', threadKey: '제목', subject: '제목', mails, links: { tasks: [], voc: [], sent: [] } };
}

const K1 = 'm:0000000000000001';
const K2 = 'm:0000000000000002';

describe('목록 칩·단축키(§8-1·§8-3)', () => {
  it('위키 반영 대기(시안) · 위키 반영됨(중립) · data-state', () => {
    expect(rowChips(row({ tasks: 0, wiki: 'queued' })).find((c) => c.kind === 'wiki')).toEqual({ kind: 'wiki', label: '위키 반영 대기', tone: 'cyan', state: 'queued' });
    expect(rowChips(row({ tasks: 0, wiki: 'done' })).find((c) => c.kind === 'wiki')).toEqual({ kind: 'wiki', label: '위키 반영됨', tone: 'plain', state: 'done' });
    expect(rowChips(row({ tasks: 0 })).some((c) => c.kind === 'wiki')).toBe(false);
  });

  it('응답 다듬기에서 links.wiki 를 남기고 모르는 값은 버린다', () => {
    const page = normalizePage({ threads: [{ ...row({ tasks: 0 }), links: { tasks: 0, wiki: 'done' } }, { ...row({ tasks: 0 }), id: 'th:000000000002', links: { tasks: 0, wiki: 'x' } }], total: 2 });
    expect(page.threads.map((t) => t.links.wiki)).toEqual(['done', undefined]);
  });

  it('W 는 위키에 반영(입력 칸·대화상자·보조 키에서는 아님)', () => {
    const base = { editable: false, inDialog: false, inList: true };
    expect(mailKeyAction({ ...base, key: 'w' })).toBe('wiki');
    expect(mailKeyAction({ ...base, key: 'W', shiftKey: true })).toBe('wiki');
    expect(mailKeyAction({ ...base, key: 'w', editable: true })).toBeNull();
    expect(mailKeyAction({ ...base, key: 'w', inDialog: true })).toBeNull();
    expect(mailKeyAction({ ...base, key: 'w', ctrlKey: true })).toBeNull();
  });
});

describe('[위키에 반영] 버튼(§8-1)', () => {
  it('옛 preload 면 숨김(기능 없음)', () => {
    expect(mailWikiSupported(null)).toBe(false);
    expect(mailWikiSupported({})).toBe(false);
    expect(mailWikiSupported({ queueMailForWiki: () => undefined })).toBe(true);
  });

  it('막힘: 피싱 의심 → 메일함 준비 안 됨 → 개인 위키 없음', () => {
    const ok = { personalMissing: false, mailboxReady: true };
    expect(mailWikiBlock({ ...ok, mail: mail(K1) })).toBeNull();
    expect(mailWikiBlock({ ...ok, mail: mail(K1, { suspicious: true }) })).toBe('피싱 의심 메일은 위키에 반영할 수 없습니다');
    expect(mailWikiBlock({ ...ok, mail: mail(K1), suspicious: true })).toBe('피싱 의심 메일은 위키에 반영할 수 없습니다');
    expect(mailWikiBlock({ personalMissing: false, mailboxReady: false, mail: mail(K1) })).toMatch(/메일함을 읽는 중/);
    expect(mailWikiBlock({ personalMissing: true, mailboxReady: true, mail: mail(K1) })).toMatch(/개인 위키가 없어/);
  });

  it('상태·글자', () => {
    expect(mailWikiState(null)).toBe('none');
    expect(mailWikiState(mail(K1, { wiki: { state: 'queued', at: '2026-09-23T01:00:00Z' } }))).toBe('queued');
    expect(mailWikiButtonLabel('none')).toBe('위키에 반영');
    expect(mailWikiButtonLabel('queued')).toBe('반영 대기 중');
    expect(mailWikiButtonLabel('running')).toBe('반영 중');
    expect(mailWikiButtonLabel('done')).toBe('위키에 반영');
  });

  it('스레드 줄 글자: 반영 대기 · 반영 중 · 반영됨 M/D · 건너뜀', () => {
    expect(threadWikiText(undefined)).toBe('');
    expect(threadWikiText({ state: 'queued' })).toBe('반영 대기');
    expect(threadWikiText({ state: 'running' })).toBe('반영 중');
    expect(threadWikiText({ state: 'done', at: '2026-09-22T05:00:00.000Z' })).toBe('반영됨 9/22');
    expect(threadWikiText({ state: 'skipped', at: '2026-09-22T05:00:00.000Z' })).toBe('건너뜀');
  });
});

describe('폼(§8-2·§5)', () => {
  const item = (over: Partial<QueueItem>): QueueItem => ({ id: 'q', kind: 'mail', createdAt: '2026-09-23T01:00:00.000Z', title: '제목', note: '', ...over });

  it('이미 대기 중인 항목: 이 메일 키 · 같은 스레드의 스레드 범위 항목', () => {
    const d = detail([mail(K1), mail(K2)]);
    expect(mailWikiExisting([item({ id: 'a', mailKey: K1, scope: 'mail' })], d, mail(K1))?.id).toBe('a');
    expect(mailWikiExisting([item({ id: 'b', mailKey: K2, scope: 'thread' })], d, mail(K1))?.id).toBe('b');
    expect(mailWikiExisting([item({ id: 'c', mailKey: K2, scope: 'mail' })], d, mail(K1))).toBeUndefined();
    expect(mailWikiExisting([item({ id: 'd', kind: 'task' })], d, mail(K1))).toBeUndefined();
  });

  it('회사 밖 안내 · 중복 안내 · 스레드 피싱 의심', () => {
    expect(mailWikiOutsideText('mail', 1)).toContain('회사 밖');
    expect(mailWikiOutsideText('thread', 3)).toContain('이 스레드 3통');
    const dup = mailWikiDuplicateText(item({ scope: 'thread', note: '가'.repeat(50) }), TODAY);
    expect(dup).toMatch(/^이 메일은 이미 반영 대기에 있습니다\(9월 23일 .*, 범위 스레드, 메모 '가{40}…'\)\. 새 내용으로 바꿀까요\?$/);
    expect(threadHasSuspicious(detail([mail(K1), mail(K2, { suspicious: true })]))).toBe(true);
    expect(threadHasSuspicious(detail([mail(K1)]))).toBe(false);
  });
});

describe('반영 대기 화면의 mail 항목(§9)', () => {
  const raw = {
    id: 'q-2',
    kind: 'mail',
    createdAt: '2026-09-23T01:00:00.000Z',
    title: '통영공장 확인',
    note: '',
    mail: 'raw/mail/x.md',
    mailKey: K1,
    scope: 'thread',
    hint: '가상케미칼',
    from: '가상케미칼 EHS팀 <ehs@vendor.example>',
    mailDate: '2026-09-22T14:42:30+09:00',
    blocked: '메일을 찾을 수 없음',
  };

  it('kind mail 과 새 필드를 남긴다 · 상태 자리 · 출처 줄 · 확인 대화상자 수(blocked 제외)', () => {
    const [item] = normalizeQueue([raw]);
    expect(item).toMatchObject({ kind: 'mail', mailKey: K1, scope: 'thread', hint: '가상케미칼', blocked: '메일을 찾을 수 없음' });
    expect(queueStatusText(item)).toBe('메일 · 스레드');
    expect(queueStatusText({ ...item, scope: 'mail' })).toBe('메일');
    expect(queueSourceText(item, TODAY)).toBe('출처: 메일 · 가상케미칼 EHS팀 · 9월 22일 14:42 · 가상케미칼');
    expect(queueSourceText({ ...item, kind: 'task' }, TODAY)).toBe('');
    expect(queueMailCount([item, { ...item, id: 'q-3', blocked: undefined }])).toBe(1);
    expect(queueSendCounts([item, { ...item, id: 'q-3', blocked: undefined }])).toEqual({ send: 1, blocked: 1 });
  });
});
