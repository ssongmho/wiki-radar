// 트레이·작업 표시줄 상태(2.12단계 명세 §1·§2·§12-1): 단계 우선순위(긴급 > 문제 > 오늘 > 평소) · 미룬 긴급은 세지 않음 ·
// 툴팁 문구·127자 · 「급한 것 없음」 · 메뉴 「알림함 (N)」 · 오버레이 0 → 지움, 10 → 9+ · 문제 목록 조건(동기화 오류 29분/31분).
import { describe, expect, it } from 'vitest';
import { PROBLEM, overlayLabel, problemList, sameShellView, shellViewOf, TOOLTIP_MAX } from '../../src/main/shell/state';
import type { InboxState, NotifyItem } from '../../src/shared/types';
import { at, snapshot, task } from './notifyFixtures';

const TODAY = '2026-09-23';

function item(over: Partial<NotifyItem>): NotifyItem {
  return {
    id: 'n_a',
    key: 'voc:1004:sla-exceeded',
    kind: 'vocSla',
    grade: 'urgent',
    title: 'VOC SLA 초과',
    body: 'VOC-2026-0104 · 비밀 제목',
    target: 'view:voc:VOC-2026-0104',
    createdAt: at('2026-09-23T09:10').toISOString(),
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
  const shown = items.filter((i) => i.readAt === null && i.snoozeUntil === null);
  return {
    items,
    unread: shown.length,
    unreadUrgent: shown.filter((i) => i.grade === 'urgent').length,
    todayToasts: 0,
    dailyLimit: 6,
    toastMode: 'log',
    hideContent: false,
    snoozed: items.length - shown.length,
    held: null,
    ...over,
  };
}

describe('트레이 단계·툴팁·메뉴·오버레이(§1-1~§1-3·§2)', () => {
  const snap = snapshot(TODAY, [task({ id: 'c:a', due: TODAY }), task({ id: 'c:b', due: TODAY })], 5);

  it('긴급 > 문제 > 오늘 > 평소, 겹친 것은 툴팁이 다 말한다(건수·종류 이름만)', () => {
    const two = inbox([item({}), item({ id: 'n_b', key: 'voc:1001:sla-warning' })]);
    const v = shellViewOf({ inbox: two, snapshot: snap, today: TODAY, problems: [PROBLEM.vocLogin] });
    expect(v.level).toBe('urgent');
    expect(v.tooltip).toBe('Radar · 긴급 2 · 오늘 마감 2 · 지남 5 · VOC 로그인 필요');
    expect(v.tooltip).not.toContain('비밀');
    expect(v.menu.inboxLabel).toBe('알림함 (2)');
    expect(v.overlay).toEqual({ count: 2, description: '안 읽은 긴급 2건' });
    expect(shellViewOf({ inbox: inbox([]), snapshot: snap, today: TODAY, problems: [PROBLEM.vocLogin] }).level).toBe('problem');
    expect(shellViewOf({ inbox: inbox([]), snapshot: snap, today: TODAY, problems: [] }).level).toBe('today');
    const morning = inbox([item({ kind: 'morning', grade: 'today', key: 'morning:2026-09-23' })]);
    expect(shellViewOf({ inbox: morning, snapshot: null, today: TODAY, problems: [] }).level).toBe('today');
    const none = shellViewOf({ inbox: inbox([]), snapshot: snapshot(TODAY, []), today: TODAY, problems: [] });
    expect(none).toMatchObject({ level: 'normal', tooltip: 'Radar — 급한 것 없음', menu: { inboxLabel: '알림함' } });
    expect(none.overlay).toEqual({ count: 0, description: '' });
  });

  it('미룬 긴급은 세지 않는다 · 문제 둘이면 「문제 2」 · 보류 중 · 스냅샷 날짜가 다르면 오늘 수 없음', () => {
    const snoozed = inbox([item({ snoozeUntil: at('2026-09-23T10:10').toISOString(), snooze: '1h' })]);
    const v = shellViewOf({ inbox: snoozed, snapshot: null, today: TODAY, problems: [PROBLEM.vocLogin, PROBLEM.toastFailed] });
    expect(v.level).toBe('problem');
    expect(v.overlay.count).toBe(0);
    expect(v.tooltip).toBe('Radar · 문제 2');
    const held = inbox([], { held: { reason: 'presentation', label: '발표 중', count: 2, since: '' } });
    expect(shellViewOf({ inbox: held, snapshot: null, today: TODAY, problems: [] }).tooltip).toBe('Radar · 보류 중');
    expect(shellViewOf({ inbox: null, snapshot: snap, today: '2026-09-24', problems: [] }).level).toBe('normal');
  });

  it('툴팁은 127자로 자른다 · 오버레이 글자 1~9, 10 이상은 9+', () => {
    const many = Array.from({ length: 30 }, (_, i) => `아주 긴 문제 이름 ${i}`);
    const v = shellViewOf({ inbox: inbox([], { unreadUrgent: 12, unread: 12 }), snapshot: snap, today: TODAY, problems: many.slice(0, 1).map((p) => p.repeat(10)) });
    expect(v.tooltip.length).toBe(TOOLTIP_MAX);
    expect(v.tooltip.endsWith('…')).toBe(true);
    expect(v.overlay).toEqual({ count: 12, description: '안 읽은 긴급 12건' });
    expect(overlayLabel(1)).toBe('1');
    expect(overlayLabel(9)).toBe('9');
    expect(overlayLabel(10)).toBe('9+');
    expect(overlayLabel(250)).toBe('9+');
  });

  it('같은 상태 비교', () => {
    const a = shellViewOf({ inbox: inbox([item({})]), snapshot: snap, today: TODAY, problems: [] });
    expect(sameShellView(null, a)).toBe(false);
    expect(sameShellView(a, structuredClone(a))).toBe(true);
    expect(sameShellView(a, { ...a, overlay: { count: 0, description: '' } })).toBe(false);
  });
});

describe('문제 목록(§1-4)', () => {
  const now = at('2026-09-23T10:00');
  const base = { board: null, team: null, wikiOk: true, toastFailedToday: false, now };
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

  it('VOC 로그인 · 팀 동기화 오류(30분 넘게 — 29분은 아님) · 확인 필요 · 위키 없음(팀 꺼짐) · Windows 알림 실패', () => {
    expect(problemList(base)).toEqual([]);
    expect(problemList({ ...base, board: { state: 'login' } })).toEqual(['VOC 로그인 필요']);
    expect(problemList({ ...base, board: { state: 'stale' } })).toEqual([]);
    const err = (lastOkAt?: string) => ({ enabled: true, phase: 'error' as const, ...(lastOkAt ? { lastOkAt } : {}) });
    expect(problemList({ ...base, team: err(ago(29)) })).toEqual([]);
    expect(problemList({ ...base, team: err(ago(31)) })).toEqual(['팀 위키 동기화 오류']);
    expect(problemList({ ...base, team: err() })).toEqual(['팀 위키 동기화 오류']);
    expect(problemList({ ...base, team: { enabled: false, phase: 'error' } })).toEqual([]);
    expect(problemList({ ...base, team: { enabled: true, phase: 'paused' } })).toEqual(['팀 위키 확인 필요']);
    expect(problemList({ ...base, wikiOk: false })).toEqual(['위키 폴더 없음']);
    expect(problemList({ ...base, wikiOk: false, team: { enabled: true, phase: 'idle' } })).toEqual([]);
    expect(problemList({ ...base, toastFailedToday: true })).toEqual(['Windows 알림 실패']);
  });
});
