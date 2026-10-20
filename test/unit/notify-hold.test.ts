// 보류(2.12단계 명세 §5·§12-1): NotifyService + 가짜 저장소·시계·probe. 보류 중 긴급 → 기록 없음·held · 풀리면 1장 ·
// 아침 요약 + 긴급 → 「보류한 알림 N건」 1장 · 아침 요약만 → morningText · 보류 중 업무 끝 → deferred·요약 버림 · 한도 → 아침 요약 부분만 ·
// 5분 창 안에서 풀림 → 창 지나서 · 보류 중 읽음·종류 끔 → 빠짐 · 내용 숨김 문구 · 설정 조용한 시간.
import { describe, expect, it } from 'vitest';
import { QUNS } from '../../src/main/notify/quiet';
import { heldText } from '../../src/main/notify/rules';
import { at, board, harness, snapshot, task, ticket } from './notifyFixtures';

const SLA_TWO = () => board({ unassigned: [ticket(1001, { slaStatus: 'warning' })], mine: [ticket(1004, { slaStatus: 'exceeded' })] });

describe('보류(§5-1)', () => {
  it('전체 화면 중 긴급은 기록하지 않고 모아 두었다가(held), 끝나면 그 판정에 1장', () => {
    const h = harness('2026-09-23T09:00');
    h.quns = QUNS.BUSY;
    h.service.setBoard(SLA_TWO());
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().held).toMatchObject({ reason: 'fullscreen', label: '전체 화면 앱 사용 중', count: 2 });
    expect(h.lastInbox().unreadUrgent).toBe(2);
    h.tickAt('2026-09-23T09:30');
    expect(h.toasts).toHaveLength(0);
    expect(h.saved?.pending?.held?.since).toBe(at('2026-09-23T09:00').toISOString());
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T09:31');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toMatchObject({ title: 'VOC SLA 2건', snoozable: true });
    expect(h.lastInbox().held).toBeNull();
    expect(h.lastInbox().todayToasts).toBe(1);
  });

  it('아침 요약 + 긴급이 함께 모였으면 「보류한 알림 N건」 1장(요약 + 긴급 2 = 3건, 「오늘 요약 ·」로 시작)', () => {
    const h = harness('2026-09-23T09:10');
    h.quns = QUNS.PRESENTATION_MODE;
    h.service.setBoard(SLA_TWO());
    h.service.setSnapshot(snapshot('2026-09-23', [task({ id: 'c:a', due: '2026-09-23' })], 2));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().held).toMatchObject({ reason: 'presentation', count: 3 });
    expect(h.saved?.pending?.morningItemId).toMatch(/^n_/);
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T09:20');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].title).toBe('보류한 알림 3건');
    expect(h.toasts[0].body).toBe('오늘 요약 · SLA 초과 1 · SLA 임박 1');
    expect(h.toasts[0]).toMatchObject({ target: 'view:inbox', snoozable: true });
    expect(h.toasts[0].kinds.sort()).toEqual(['morning', 'vocSla']);
    expect(h.lastInbox().items.every((i) => i.toastAt !== null)).toBe(true);
    expect(h.lastInbox().todayToasts).toBe(1);
  });

  it('아침 요약만 모였으면 morningText 그대로(단추 없음, 한도에 세지 않음)', () => {
    const h = harness('2026-09-23T09:10');
    h.quns = QUNS.NOT_PRESENT;
    h.service.setBoard(board({}));
    h.service.setSnapshot(snapshot('2026-09-23', [task({ id: 'c:a', due: '2026-09-23' })], 2));
    expect(h.lastInbox().held).toMatchObject({ reason: 'away', count: 1 });
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T09:40');
    expect(h.toasts).toEqual([
      expect.objectContaining({ title: '오늘 요약', body: '오늘 마감 1 · 지남 2', kinds: ['morning'], snoozable: false }),
    ]);
    expect(h.lastInbox().todayToasts).toBe(0);
  });

  it('보류 중 업무 시간이 끝나면 긴급은 deferred, 아침 요약 Windows 알림은 버린다', () => {
    const h = harness('2026-09-23T18:50');
    h.quns = QUNS.BUSY;
    h.service.setBoard(SLA_TWO());
    expect(h.lastInbox().held).not.toBeNull();
    h.tickAt('2026-09-23T19:00');
    expect(h.lastInbox().held).toBeNull();
    expect(h.lastInbox().items.every((i) => i.deferred)).toBe(true);
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T19:10');
    expect(h.toasts).toHaveLength(0);
  });

  it('하루 한도에 닿았으면 아침 요약 부분만 보낸다', () => {
    const h = harness('2026-09-23T09:00');
    h.settings = { ...h.settings, morningTime: '15:00' };
    const tickets = [];
    for (let i = 0; i < 10; i++) {
      tickets.push(ticket(2000 + i, { slaStatus: 'warning' }));
      h.now = at(`2026-09-23T${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
      h.service.setBoard(board({ unassigned: [...tickets] }));
    }
    expect(h.toasts).toHaveLength(10);
    h.quns = QUNS.BUSY;
    h.now = at('2026-09-23T15:00');
    h.service.setSnapshot(snapshot('2026-09-23', [], 3));
    tickets.push(ticket(3000, { slaStatus: 'exceeded' }));
    h.service.setBoard(board({ unassigned: [...tickets] }));
    expect(h.lastInbox().held?.count).toBe(2);
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T15:10');
    expect(h.toasts).toHaveLength(11);
    expect(h.toasts[10]).toMatchObject({ title: '오늘 요약', kinds: ['morning'] });
    expect(h.lastInbox().items.find((i) => i.key === 'voc:3000:sla-exceeded')?.toastAt).toBeNull();
  });

  it('5분 창 안에서 풀리면 창이 지날 때 보낸다', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(1);
    h.quns = QUNS.BUSY;
    h.now = at('2026-09-23T09:02');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })], unassigned: [ticket(1005, { slaStatus: 'warning' })] }));
    expect(h.lastInbox().held).not.toBeNull();
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T09:03');
    expect(h.toasts).toHaveLength(1);
    expect(h.lastInbox().held).toBeNull();
    h.tickAt('2026-09-23T09:05');
    expect(h.toasts).toHaveLength(2);
    expect(h.toasts[1].keys).toEqual(['voc:1005:sla-warning']);
  });

  it('보류 중 읽거나 종류를 끄면 묶음에서 빠진다', () => {
    {
      const h = harness('2026-09-23T09:00');
      h.quns = QUNS.BUSY;
      h.service.setBoard(SLA_TWO());
      h.service.markRead('all');
      h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
      h.tickAt('2026-09-23T09:10');
      expect(h.toasts).toHaveLength(0);
      expect(h.saved?.pending).toBeNull();
    }
    {
      const h = harness('2026-09-23T09:00');
      h.quns = QUNS.BUSY;
      h.service.setBoard(SLA_TWO());
      h.settings = { ...h.settings, kinds: { ...h.settings.kinds, vocSla: 'inbox' } };
      h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
      h.tickAt('2026-09-23T09:10');
      expect(h.toasts).toHaveLength(0);
    }
  });

  it('내용 숨김이면 보류 요약은 건수만', () => {
    expect(heldText({ title: '오늘 요약', body: '오늘 마감 1' }, [{ label: 'SLA 초과' }, { label: '오늘 마감' }], true)).toEqual({
      title: '보류한 알림 3건',
      body: '3건',
    });
    const h = harness('2026-09-23T09:10');
    h.settings = { ...h.settings, hideContent: true };
    h.quns = QUNS.BUSY;
    h.service.setBoard(board({}));
    h.service.setSnapshot(snapshot('2026-09-23', [task({ id: 'c:a', due: '2026-09-23' })], 2));
    h.quns = QUNS.ACCEPTS_NOTIFICATIONS;
    h.tickAt('2026-09-23T09:20');
    expect(h.toasts[0]).toMatchObject({ title: '오늘 요약', body: '3건' });
  });

  it('설정의 조용한 시간(12:00~13:00)은 quietHold·QUNS 와 상관없이 모으고, 13:00 판정에 1장(소리 켬이면 silent 거짓)', () => {
    const h = harness('2026-09-23T12:10');
    h.settings = { ...h.settings, quietStart: '12:00', quietEnd: '13:00', quietHold: false, sound: true };
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().held).toMatchObject({ reason: 'userQuiet', label: '조용한 시간(설정)' });
    expect(h.probeCalls).toBe(0);
    h.tickAt('2026-09-23T12:59');
    expect(h.toasts).toHaveLength(0);
    h.tickAt('2026-09-23T13:00');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].silent).toBe(false);
  });
});
