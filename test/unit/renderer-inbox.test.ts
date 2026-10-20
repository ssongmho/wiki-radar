// 알림함 화면 도우미(2.9단계 명세 §8·§12-2): 응답 검사 · 시각 표기 · 종 배지 · 사이드바 긴급 띠 · 설정 › 알림 입력.
import { describe, expect, it } from 'vitest';
import {
  badgeTone,
  bellLabel,
  canSnooze,
  formatDayTime,
  formatInboxTime,
  heldBannerText,
  isSnoozed,
  snoozeOptionText,
  snoozeTagText,
  muteNoticeText,
  normalizeInbox,
  normalizeNotifySettings,
  notifyDraftProblem,
  toastCountText,
  urgentBand,
} from '../../src/renderer/lib/inbox';
import { DEFAULT_NOTIFY_SETTINGS } from '../../src/shared/notify';
import type { InboxState, NotifyItem } from '../../src/shared/types';
import { at } from './notifyFixtures';

const TODAY = '2026-09-23';

function item(over: Partial<NotifyItem>): NotifyItem {
  return {
    id: 'n_a',
    key: 'voc:1004:sla-exceeded',
    kind: 'vocSla',
    grade: 'urgent',
    title: 'VOC SLA 초과',
    body: 'VOC-2026-0104 · LDAR 측정 데이터 업로드 지연',
    target: 'view:voc:VOC-2026-0104',
    createdAt: at('2026-09-23T14:02').toISOString(),
    readAt: null,
    toastAt: null,
    deferred: false,
    snoozeUntil: null,
    snooze: null,
    reminded: false,
    ...over,
  };
}

function inbox(items: NotifyItem[], over: Partial<InboxState> = {}): InboxState {
  return {
    items,
    unread: items.filter((i) => i.readAt === null).length,
    unreadUrgent: items.filter((i) => i.readAt === null && i.grade === 'urgent').length,
    todayToasts: 2,
    dailyLimit: 6,
    toastMode: 'toast',
    hideContent: false,
    ...over,
  };
}

describe('알림함 응답·표기', () => {
  it('모양이 틀린 항목만 버린다', () => {
    const got = normalizeInbox({ items: [item({}), { id: 1 }, item({ kind: 'mail' as never })], unread: 1, unreadUrgent: 1, todayToasts: 'x' });
    expect(got?.items).toHaveLength(1);
    expect(got?.todayToasts).toBe(0);
    expect(got?.dailyLimit).toBe(6);
    expect(normalizeInbox({})).toBeNull();
  });

  it('시각: 오늘이면 "14:02", 아니면 "9/22 14:02"', () => {
    expect(formatInboxTime(at('2026-09-23T14:02').toISOString(), TODAY)).toBe('14:02');
    expect(formatInboxTime(at('2026-09-22T09:05').toISOString(), TODAY)).toBe('9/22 09:05');
    expect(formatInboxTime('nope', TODAY)).toBe('');
  });

  it('종 배지: 안 읽은 긴급이면 코랄, 오늘(아침 요약)만이면 중립, 0 이면 없음', () => {
    expect(badgeTone(inbox([item({})]))).toBe('urgent');
    expect(badgeTone(inbox([item({ grade: 'today', kind: 'morning' }), item({ id: 'n_b', readAt: 'x' })]))).toBe('neutral');
    expect(badgeTone(inbox([item({ readAt: 'x' })]))).toBeNull();
    expect(badgeTone(null)).toBeNull();
    expect(bellLabel(inbox([item({}), item({ id: 'n_b' })]))).toBe('알림 2건 안 읽음');
    expect(bellLabel(inbox([]))).toBe('알림');
  });

  it('Windows 알림 수 머리: 한도에 닿으면 "나머지는 알림함에만"', () => {
    expect(toastCountText(inbox([]))).toBe('Windows 알림 오늘 2/6');
    expect(toastCountText(inbox([], { todayToasts: 6 }))).toBe('Windows 알림 오늘 6/6 — 나머지는 알림함에만');
    expect(toastCountText(inbox([], { toastMode: 'unsupported' }))).toMatch(/보낼 수 없어/);
    expect(muteNoticeText('vocSla')).toBe('VOC SLA 알림을 껐습니다');
    expect(muteNoticeText('due')).toBe('오늘 마감 할 일 알림을 껐습니다');
  });
});

describe('사이드바 긴급 띠(§8-2)', () => {
  it('"긴급 N · 가장 새 항목 제목 + 번호", 내용 숨김이면 건수만, 없으면 띠 없음', () => {
    const items = [item({}), item({ id: 'n_b', key: 'task:c:a:due-today', kind: 'due', title: '오늘 마감', body: '보고서' })];
    expect(urgentBand(inbox(items), TODAY)).toEqual({ count: 2, text: '긴급 2 · VOC SLA 초과 VOC-2026-0104' });
    expect(urgentBand(inbox(items, { hideContent: true }), TODAY)).toEqual({ count: 2, text: '긴급 2' });
    expect(urgentBand(inbox([item({ readAt: 'x' })], { unreadUrgent: 0 }), TODAY)).toBeNull();
    expect(urgentBand(null, TODAY)).toBeNull();
  });
});

describe('설정 › 알림 입력(§8-4)', () => {
  it('시각 HH:MM · 시작 < 끝 — 틀리면 그 칸과 문장', () => {
    expect(notifyDraftProblem(DEFAULT_NOTIFY_SETTINGS)).toBeNull();
    expect(notifyDraftProblem({ ...DEFAULT_NOTIFY_SETTINGS, morningTime: '' })?.field).toBe('morningTime');
    expect(notifyDraftProblem({ ...DEFAULT_NOTIFY_SETTINGS, workStart: '19:00' })).toEqual({
      field: 'workEnd',
      message: '업무 끝 시각이 시작 시각보다 늦어야 합니다',
    });
  });

  it('main 응답 검사', () => {
    expect(normalizeNotifySettings(DEFAULT_NOTIFY_SETTINGS)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    expect(normalizeNotifySettings({ ...DEFAULT_NOTIFY_SETTINGS, kinds: { due: 'toast' } })).toBeNull();
  });
});

describe('2.12단계 — [나중에]·보류 표기(§10)', () => {
  it('미룸 꼬리표: 오늘이면 「15:10에 다시」, 다른 날이면 「9/28 08:50에 다시」 · 선택 글자', () => {
    expect(snoozeTagText(at('2026-09-23T15:10').toISOString(), TODAY)).toBe('15:10에 다시');
    expect(snoozeTagText(at('2026-09-28T08:50').toISOString(), TODAY)).toBe('9/28 08:50에 다시');
    expect(snoozeOptionText('1h', at('2026-09-23T15:10').toISOString())).toBe('1시간 뒤 · 15:10');
    expect(snoozeOptionText('morning', at('2026-09-28T08:50').toISOString())).toBe('내일 아침 · 9/28(월) 08:50');
    expect(snoozeOptionText('morning', null)).toBe('내일 아침');
    expect(formatDayTime('x')).toBe('');
  });

  it('[나중에]는 긴급·안 읽음·미루지 않은 것만, 미룬 것은 배지·긴급 띠에서 빠진다', () => {
    expect(canSnooze(item({}))).toBe(true);
    expect(canSnooze(item({ readAt: 'x' }))).toBe(false);
    expect(canSnooze(item({ grade: 'today', kind: 'morning' }))).toBe(false);
    const snoozed = item({ snoozeUntil: at('2026-09-23T15:10').toISOString(), snooze: '1h' });
    expect(canSnooze(snoozed)).toBe(false);
    expect(isSnoozed(snoozed)).toBe(true);
    expect(badgeTone(inbox([snoozed, item({ id: 'n_b', grade: 'today', kind: 'morning' })], { unread: 1 }))).toBe('neutral');
    expect(urgentBand(inbox([snoozed, item({ id: 'n_c', key: 'task:c:a:due-today', title: '오늘 마감', body: '보고서' })], { unreadUrgent: 1 }), TODAY)).toEqual({
      count: 1,
      text: '긴급 1 · 오늘 마감 보고서',
    });
    // 어제 생겼다가 「내일 아침」에서 깨운(다시 알림) 긴급도 띠의 제목으로 쓴다
    const reminded = item({ createdAt: at('2026-09-22T15:00').toISOString(), reminded: true });
    expect(urgentBand(inbox([reminded], { unreadUrgent: 1 }), TODAY)).toEqual({ count: 1, text: '긴급 1 · VOC SLA 초과 VOC-2026-0104' });
  });

  it('보류 문구 · 응답의 새 칸 검사', () => {
    expect(heldBannerText(inbox([], { held: { reason: 'presentation', label: '발표 중', count: 3, since: '' } }))).toBe(
      '보류 중 — 발표 중 · 3건 (끝나면 1건으로 보냅니다)',
    );
    expect(heldBannerText(inbox([]))).toBeNull();
    const got = normalizeInbox({ items: [{ ...item({}), snooze: 'nap', snoozeUntil: 'x', reminded: true }], held: { reason: 'nap' }, snoozed: 2, nextMorningAt: 'z' });
    expect(got?.items[0]).toMatchObject({ snooze: null, snoozeUntil: null, reminded: true });
    expect(got).toMatchObject({ held: null, snoozed: 2, nextMorningAt: 'z' });
    expect(normalizeInbox({ items: [], held: { reason: 'away', count: 1 } })?.held).toEqual({ reason: 'away', label: '자리 비움(잠금 화면)', count: 1, since: '' });
  });

  it('설정 응답: 옛 main(새 칸 없음)이면 기본값으로', () => {
    const { quietStart: _a, quietEnd: _b, quietHold: _c, sound: _d, ...old } = DEFAULT_NOTIFY_SETTINGS;
    expect(normalizeNotifySettings(old)).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });
});
