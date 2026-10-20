// [나중에](2.12단계 명세 §3·§12-1): 「내일 아침」 깰 시각 · 미룸은 안 읽은 수에서 빠짐 · 1시간 깨움 → 긴급 후보(업무 시간 밖·초점·한도) ·
// 출처가 끝났으면 조용히 읽음 · 모르면 깨움 · 미룬 사이 나빠지면 새 알림 + 옛 항목 읽음 · 「내일 아침」 → 아침 요약 「나중에 N」 ·
// 묶음 대기 중 미루기 · 열기·모두 읽음이 미룸을 지움 · 아침 요약은 미루지 않음. 가짜 시계로 NotifyService 를 직접 돌린다.
import { describe, expect, it } from 'vitest';
import { nextMorning } from '../../src/main/notify/rules';
import { stillActive } from '../../src/main/notify/signals';
import { BusinessCalendar } from '../../src/main/wiki/calendar';
import { HOLIDAYS, at, board, harness, snapshot, task, ticket } from './notifyFixtures';

const cal = new BusinessCalendar(HOLIDAYS);
const local = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('「내일 아침」 깰 시각(§3-1)', () => {
  it('평일 → 다음날 · 금 → 월 · 9/23 → 추석·주말 건너 9/28 · 07:30 에 눌러도 내일', () => {
    expect(local(nextMorning(at('2026-09-22T14:00'), '08:50', cal))).toBe('2026-09-23T08:50');
    expect(local(nextMorning(at('2026-09-18T16:00'), '08:50', cal))).toBe('2026-09-21T08:50');
    expect(local(nextMorning(at('2026-09-23T14:00'), '08:50', cal))).toBe('2026-09-28T08:50');
    expect(local(nextMorning(at('2026-09-22T07:30'), '09:10', cal))).toBe('2026-09-23T09:10');
  });
});

/** 09:00 에 SLA 초과 하나 알린 서비스 */
function oneUrgent(start = '2026-09-23T09:00') {
  const h = harness(start);
  h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
  expect(h.toasts).toHaveLength(1);
  const item = h.lastInbox().items[0];
  return { h, item };
}

describe('미루기·깨우기(§3-1·§3-2)', () => {
  it('미룬 항목은 안 읽은 수·긴급 수에서 빠지고 「나중에」 수로, 1시간 뒤 깨면 다시 안 읽음 + Windows 알림(단추 둘)', () => {
    const { h, item } = oneUrgent();
    const inbox = h.service.snooze([item.id], '1h');
    expect(inbox).toMatchObject({ unread: 0, unreadUrgent: 0, snoozed: 1 });
    expect(inbox.items[0]).toMatchObject({ snooze: '1h', reminded: false });
    expect(local(new Date(inbox.items[0].snoozeUntil as string))).toBe('2026-09-23T10:00');
    h.tickAt('2026-09-23T09:59');
    expect(h.toasts).toHaveLength(1);
    h.tickAt('2026-09-23T10:00');
    expect(h.toasts).toHaveLength(2);
    expect(h.toasts[1]).toMatchObject({ keys: ['voc:1004:sla-exceeded'], snoozable: true, silent: true });
    const after = h.lastInbox();
    expect(after).toMatchObject({ unread: 1, unreadUrgent: 1, snoozed: 0 });
    expect(after.items[0]).toMatchObject({ snoozeUntil: null, snooze: null, reminded: true });
  });

  it('깰 때 업무 시간 밖이면 deferred · 풀스크린 초점이면 알림함만 · 한도에 닿았으면 알림함만', () => {
    {
      const { h, item } = oneUrgent('2026-09-23T18:30');
      h.service.snooze([item.id], '1h');
      h.tickAt('2026-09-23T19:30');
      expect(h.toasts).toHaveLength(1);
      expect(h.lastInbox().items[0]).toMatchObject({ deferred: true, reminded: true });
    }
    {
      const { h, item } = oneUrgent();
      h.service.snooze([item.id], '1h');
      h.focused = true;
      h.tickAt('2026-09-23T10:00');
      expect(h.toasts).toHaveLength(1);
      expect(h.lastInbox().unreadUrgent).toBe(1);
    }
    {
      const h = harness('2026-09-23T09:00');
      const tickets = [];
      for (let i = 0; i < 10; i++) {
        tickets.push(ticket(2000 + i, { slaStatus: 'warning' }));
        h.now = at(`2026-09-23T${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
        h.service.setBoard(board({ unassigned: [...tickets] }));
      }
      expect(h.toasts).toHaveLength(10);
      const first = h.lastInbox().items.find((i) => i.key === 'voc:2000:sla-warning');
      h.service.snooze([first?.id as string], '1h');
      h.tickAt('2026-09-23T15:30');
      expect(h.toasts).toHaveLength(10);
      expect(h.lastInbox().items.find((i) => i.key === 'voc:2000:sla-warning')).toMatchObject({ reminded: true, snoozeUntil: null });
    }
  });

  it('출처가 끝났으면 깰 때 조용히 읽음, 받지 못한 입력(stale 보드)이면 깨운다', () => {
    {
      const { h, item } = oneUrgent();
      h.service.snooze([item.id], '1h');
      h.now = at('2026-09-23T09:30');
      h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'normal' })] }));
      h.tickAt('2026-09-23T10:00');
      expect(h.toasts).toHaveLength(1);
      expect(h.lastInbox().items[0]).toMatchObject({ snoozeUntil: null, reminded: false });
      expect(h.lastInbox().items[0].readAt).not.toBeNull();
    }
    {
      const { h, item } = oneUrgent();
      h.service.snooze([item.id], '1h');
      h.now = at('2026-09-23T09:30');
      h.service.setBoard(board({ mine: [] }, { state: 'stale' }));
      h.tickAt('2026-09-23T10:00');
      expect(h.toasts).toHaveLength(2);
    }
  });

  it('stillActive: 스냅샷이 없으면 살아 있음, 완료된 할 일·사라진 티켓은 끝남, 내 칸에서 빠진 배정은 끝남', () => {
    const due = { kind: 'due', key: 'task:c:a:due-today', target: 'c:a' };
    expect(stillActive(due, null, null)).toBe(true);
    expect(stillActive(due, snapshot('2026-09-23', [task({ id: 'c:a', due: '2026-09-23' })]), null)).toBe(true);
    expect(stillActive(due, snapshot('2026-09-23', [task({ id: 'c:a', status: 'done' })]), null)).toBe(false);
    const sla = { kind: 'vocSla', key: 'voc:1004:sla-exceeded', target: 'view:voc:VOC-2026-1004' };
    expect(stillActive(sla, null, board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }))).toBe(true);
    expect(stillActive(sla, null, board({ other: [ticket(1004, { slaStatus: 'exceeded' })] }))).toBe(false);
    expect(stillActive(sla, null, board({}, { state: 'login' }))).toBe(true);
    const assign = { kind: 'vocAssign', key: 'voc:1005:assigned-me', target: 'view:voc:VOC-2026-1005' };
    expect(stillActive(assign, null, board({ mine: [ticket(1005)] }))).toBe(true);
    expect(stillActive(assign, null, board({ other: [ticket(1005)] }))).toBe(false);
  });

  it('미룬 사이 임박 → 초과: 미룬 것과 관계없이 새 항목 + Windows 알림, 옛 임박 항목은 미룸을 지우고 읽음', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [ticket(1001, { slaStatus: 'warning' })] }));
    const old = h.lastInbox().items[0];
    h.service.snooze([old.id], '1h');
    h.now = at('2026-09-23T09:30');
    h.service.setBoard(board({ mine: [ticket(1001, { slaStatus: 'exceeded' })] }));
    expect(h.toasts.map((t) => t.keys)).toEqual([['voc:1001:sla-warning'], ['voc:1001:sla-exceeded']]);
    const items = h.lastInbox().items;
    expect(items.find((i) => i.id === old.id)).toMatchObject({ snoozeUntil: null });
    expect(items.find((i) => i.id === old.id)?.readAt).not.toBeNull();
    // 옛 단계로 다시 깨지 않는다
    h.tickAt('2026-09-23T10:00');
    expect(h.toasts).toHaveLength(2);
  });

  it('묶음 대기 중인 항목을 미루면 묶음에서 빠진다(+5분에 Windows 알림 없음)', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }));
    h.now = at('2026-09-23T09:02');
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' }), ticket(1005, { slaStatus: 'exceeded' })] }));
    expect(h.saved?.pending?.itemIds).toHaveLength(1);
    const waiting = h.lastInbox().items.find((i) => i.key === 'voc:1005:sla-exceeded');
    h.service.snooze([waiting?.id as string], '1h');
    expect(h.saved?.pending).toBeNull();
    h.tickAt('2026-09-23T09:05');
    expect(h.toasts).toHaveLength(1);
  });

  it('열기·모두 읽음은 미룸을 지운다 · 아침 요약·읽은 항목은 미루지 않는다(건너뜀)', () => {
    const { h, item } = oneUrgent();
    h.service.snooze([item.id], 'morning');
    expect(h.service.open(item.id)).toBe(item.target);
    expect(h.lastInbox().items[0]).toMatchObject({ snoozeUntil: null, snooze: null });
    expect(h.service.snooze([item.id], '1h').snoozed).toBe(0);

    const h2 = harness('2026-09-23T09:10');
    h2.service.setSnapshot(snapshot('2026-09-23', [task({ id: 'c:a', due: '2026-09-23' })], 1));
    h2.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    const inbox = h2.lastInbox();
    const morning = inbox.items.find((i) => i.kind === 'morning');
    const urgent = inbox.items.find((i) => i.kind === 'vocSla');
    expect(h2.service.snooze([morning?.id as string], '1h').snoozed).toBe(0);
    h2.service.snooze([urgent?.id as string], '1h');
    expect(h2.service.markRead('all')).toMatchObject({ unread: 0, snoozed: 0 });
  });
});

describe('「내일 아침」 → 아침 요약 「나중에 N」(§3-2·§3-4)', () => {
  /** 9/23 16:00 오늘 마감 알림을 받고 「내일 아침」으로 미룬 서비스 */
  function snoozedMorning() {
    const h = harness('2026-09-23T09:10');
    const tasks = [task({ id: 'c:a', title: '보고서', due: '2026-09-23' })];
    h.service.setBoard(board({}));
    h.service.setSnapshot(snapshot('2026-09-23', tasks));
    expect(h.toasts.map((t) => t.kinds)).toEqual([['morning']]);
    h.tickAt('2026-09-23T16:00');
    expect(h.toasts).toHaveLength(2);
    const due = h.lastInbox().items.find((i) => i.kind === 'due');
    const inbox = h.service.snooze([due?.id as string], 'morning');
    expect(local(new Date(inbox.items.find((i) => i.kind === 'due')?.snoozeUntil as string))).toBe('2026-09-28T08:50');
    expect(local(new Date(inbox.nextMorningAt as string))).toBe('2026-09-28T08:50');
    return { h, tasks, dueId: due?.id as string };
  }

  it('다음 업무일 아침 요약에 「나중에 1」로 접고, 그 항목만의 Windows 알림은 없다(항목은 안 읽음)', () => {
    const { h, tasks, dueId } = snoozedMorning();
    h.tickAt('2026-09-23T18:00');
    h.tickAt('2026-09-24T09:00');
    expect(h.toasts).toHaveLength(2);
    h.now = at('2026-09-28T09:00');
    h.service.setSnapshot(snapshot('2026-09-28', tasks, 1));
    expect(h.toasts).toHaveLength(3);
    expect(h.toasts[2]).toMatchObject({ title: '오늘 요약', kinds: ['morning'], snoozable: false });
    expect(h.toasts[2].body).toContain('나중에 1');
    expect(h.lastInbox().items.find((i) => i.id === dueId)).toMatchObject({ readAt: null, snoozeUntil: null, reminded: true });
  });

  it('아침 요약이 끔이면 깰 때 긴급 후보로(따로 Windows 알림)', () => {
    const { h, tasks } = snoozedMorning();
    h.settings = { ...h.settings, kinds: { ...h.settings.kinds, morning: 'off' } };
    h.now = at('2026-09-28T08:50');
    h.service.setSnapshot(snapshot('2026-09-28', tasks));
    expect(h.toasts).toHaveLength(3);
    expect(h.toasts[2]).toMatchObject({ kinds: ['due'], snoozable: true });
  });

  it('오늘 아침 요약을 이미 보냈으면 깰 때 긴급 후보로', () => {
    const { h, tasks } = snoozedMorning();
    // 요약 시각을 08:30 으로 당겨 깰 시각(08:50) 전에 요약이 나가게
    h.settings = { ...h.settings, morningTime: '08:30' };
    h.now = at('2026-09-28T08:30');
    h.service.setSnapshot(snapshot('2026-09-28', tasks, 1));
    expect(h.toasts).toHaveLength(3);
    expect(h.toasts[2].kinds).toEqual(['morning']);
    h.tickAt('2026-09-28T08:50');
    expect(h.toasts).toHaveLength(4);
    expect(h.toasts[3].kinds).toEqual(['due']);
  });

  it('깰 날 업무 끝 뒤에 처음 켜면(오늘 요약은 더 못 나감) 깨워서 보이고 업무 시간 밖이라 보류 — 다음 아침 「보류 1」로 한 번만', () => {
    const { h, tasks, dueId } = snoozedMorning();
    h.now = at('2026-09-28T19:30');
    h.service.setSnapshot(snapshot('2026-09-28', tasks));
    expect(h.toasts).toHaveLength(2);
    expect(h.lastInbox().items.find((i) => i.id === dueId)).toMatchObject({ snoozeUntil: null, deferred: true, reminded: true });
    expect(h.lastInbox().unreadUrgent).toBe(1);
    h.now = at('2026-09-29T09:00');
    h.service.setSnapshot(snapshot('2026-09-29', tasks));
    expect(h.toasts).toHaveLength(3);
    expect(h.toasts[2].body).toContain('보류 1');
    expect(h.toasts[2].body).not.toContain('나중에');
  });

  it('업무 시간 밖에 생긴(보류) 항목을 「내일 아침」으로 미루면 아침 요약에서 「나중에 1」로만 센다(「보류」로 또 세지 않음)', () => {
    const h = harness('2026-09-23T09:10');
    h.service.setBoard(board({}));
    h.service.setSnapshot(snapshot('2026-09-23', []));
    h.now = at('2026-09-23T19:30');
    // 미배정 칸(새 배정 신호 없이 SLA 하나만)
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.lastInbox().items.filter((i) => i.deferred)).toHaveLength(1);
    const item = h.lastInbox().items.find((i) => i.kind === 'vocSla');
    expect(item).toMatchObject({ deferred: true });
    h.service.snooze([item?.id as string], 'morning');
    const before = h.toasts.length;
    h.now = at('2026-09-28T09:00');
    h.service.setSnapshot(snapshot('2026-09-28', []));
    expect(h.toasts).toHaveLength(before + 1);
    const body = h.toasts[before].body;
    expect(body).toContain('나중에 1');
    expect(body).not.toContain('보류');
  });

  it('「내일 아침」에서 깨운 긴급은 어제 생겼어도 오늘 안 읽은 긴급 수(트레이·오버레이·사이드바 띠)에 든다', () => {
    const { h, item } = oneUrgent();
    h.service.snooze([item.id], 'morning');
    expect(h.lastInbox().unreadUrgent).toBe(0);
    h.now = at('2026-09-28T09:00');
    h.service.setSnapshot(snapshot('2026-09-28', []));
    const inbox = h.lastInbox();
    expect(inbox.items.find((i) => i.id === item.id)).toMatchObject({ reminded: true, readAt: null });
    expect(inbox.unreadUrgent).toBe(1);
  });
});
