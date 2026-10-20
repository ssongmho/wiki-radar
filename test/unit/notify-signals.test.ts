// 알림 N1 신호(2.9단계 명세 §6-1·§6-4·§12-2): 오늘 마감 · SLA · 새 배정 · 아침 요약. 가짜 시계.
import { describe, expect, it } from 'vitest';
import { assignSignals, dueSignals, morningCounts, morningDue, slaSignals } from '../../src/main/notify/signals';
import { at, board, harness, snapshot, task, ticket } from './notifyFixtures';

const TODAY = '2026-09-23';

describe('오늘 마감(§6-1)', () => {
  const snap = snapshot(TODAY, [
    task({ id: 'c:aaa', due: TODAY, title: '보고서 제출' }),
    task({ id: 't:bbb', source: 'team', due: TODAY, title: '팀 점검표' }),
    task({ id: 'v:1004', source: 'voc', due: TODAY, title: 'VOC 할 일' }),
    task({ id: 'c:ccc', due: '2026-09-24' }),
    task({ id: 'c:ddd', due: TODAY, status: 'wip' }),
  ]);

  it('오후 4시 전에는 없고, 그 뒤 개인 + 팀 내 것(VOC 할 일 제외)', () => {
    expect(dueSignals(snap, at('2026-09-23T15:59'))?.signals).toEqual([]);
    const s = dueSignals(snap, at('2026-09-23T16:00'));
    expect(s?.signals.map((x) => x.key)).toEqual(['task:c:aaa:due-today', 'task:t:bbb:due-today', 'task:c:ddd:due-today']);
    expect(s?.signals[0]).toMatchObject({ kind: 'due', family: 'task:c:aaa:due:2026-09-23', title: '오늘 마감', body: '보고서 제출', target: 'c:aaa' });
  });

  it('스냅샷의 오늘이 지금 날짜와 다르면 판정하지 않는다', () => {
    expect(dueSignals(snap, at('2026-09-24T15:00'))).toBeNull();
  });

  it('서비스: 하루 한 번 — 16:00 에 한 장, 다시 판정해도·잠깐 빠졌다 돌아와도 다시 안 보낸다', () => {
    const h = harness('2026-09-23T15:00');
    h.settings = { ...h.settings, kinds: { ...h.settings.kinds, morning: 'off' } };
    h.service.setSnapshot(snap);
    expect(h.toasts).toHaveLength(0);
    h.tickAt('2026-09-23T16:00');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toMatchObject({ title: '오늘 마감 할 일 3건', body: '보고서 제출, 팀 점검표 외 1건', kinds: ['due'] });
    h.tickAt('2026-09-23T16:30');
    h.service.setSnapshot(snapshot(TODAY, [task({ id: 'c:aaa', due: TODAY })]));
    h.service.setSnapshot(snap);
    h.tickAt('2026-09-23T18:00');
    expect(h.toasts).toHaveLength(1);
  });
});

describe('오늘 마감 — 날짜가 바뀔 때(기한을 하루 미룸)', () => {
  it('어제 오늘 마감 알림 → 기한을 오늘로 미룸 → 오늘 오후 4시 뒤에 앱을 켜도 한 번 알린다', () => {
    const h = harness('2026-09-28T15:00');
    h.settings = { ...h.settings, kinds: { ...h.settings.kinds, morning: 'off' } };
    h.service.setSnapshot(snapshot('2026-09-28', [task({ id: 'c:aaa', due: '2026-09-28', title: '보고서 제출' })]));
    h.tickAt('2026-09-28T16:00');
    expect(h.toasts).toHaveLength(1);
    // 저장된 기록은 그대로 두고 다음 날 오후에 새로 켠다(그 사이 오전 판정 없음)
    const saved = h.saved;
    const h2 = harness('2026-09-29T17:00');
    h2.saved = saved;
    h2.settings = h.settings;
    h2.service.setSnapshot(snapshot('2026-09-29', [task({ id: 'c:aaa', due: '2026-09-29', title: '보고서 제출' })]));
    h2.tickAt('2026-09-29T17:01');
    expect(h2.toasts).toHaveLength(1);
    // 알림함: 어제 것 + 오늘 것
    expect(h2.lastInbox().items.filter((i) => i.kind === 'due')).toHaveLength(2);
    // 어제 가족은 지워지고 오늘 가족만 남는다
    expect(Object.keys(h2.saved?.families ?? {}).filter((f) => f.startsWith('task:'))).toEqual(['task:c:aaa:due:2026-09-29']);
  });
});

describe('SLA(§6-1)', () => {
  it('내 칸 + 미배정 칸만, normal·없음은 신호가 아니다', () => {
    const s = slaSignals(
      board({
        unassigned: [ticket(1001, { slaStatus: 'warning' }), ticket(1002, { slaStatus: 'normal' })],
        mine: [ticket(1004, { slaStatus: 'exceeded', title: 'LDAR 지연' }), ticket(1005)],
        other: [ticket(1008, { slaStatus: 'exceeded' })],
      }),
    );
    expect(s.signals.map((x) => [x.key, x.rank])).toEqual([
      ['voc:1001:sla-warning', 1],
      ['voc:1004:sla-exceeded', 2],
    ]);
    expect(s.signals[1]).toMatchObject({ title: 'VOC SLA 초과', body: 'VOC-2026-1004 · LDAR 지연', target: 'view:voc:VOC-2026-1004' });
    expect([...s.present].sort()).toEqual(['voc:1001:sla', 'voc:1004:sla']);
  });
});

describe('새 배정(§6-1)', () => {
  const now = at('2026-09-23T10:00');
  const none = new Map<number, number>();

  it('첫 보드는 기준만, 그다음 새로 생긴 id 만', () => {
    const first = assignSignals(board({ mine: [ticket(1004), ticket(1005)] }), null, none, now);
    expect(first?.signals).toEqual([]);
    expect(first?.baseline).toMatchObject({ meId: 101, ids: [1004, 1005] });
    const next = assignSignals(board({ mine: [ticket(1004), ticket(1005), ticket(1002)] }), first!.baseline, none, now);
    expect(next?.signals.map((s) => s.key)).toEqual(['voc:1002:assigned-me']);
    expect(next?.signals[0]).toMatchObject({ title: 'VOC 새 배정', target: 'view:voc:VOC-2026-1002' });
  });

  it('내가 나에게 배정한 티켓은 10분 동안 뺀다', () => {
    const base = { meId: 101, ids: [1004], at: now.toISOString() };
    const self = new Map([[1002, at('2026-09-23T09:55').getTime()]]);
    expect(assignSignals(board({ mine: [ticket(1004), ticket(1002)] }), base, self, now)?.signals).toEqual([]);
    expect(assignSignals(board({ mine: [ticket(1004), ticket(1002)] }), base, self, at('2026-09-23T10:06'))?.signals).toHaveLength(1);
  });

  it('stale·login 보드는 무시(기준도 그대로), me.id 가 바뀌면 기준만', () => {
    const base = { meId: 101, ids: [1004], at: now.toISOString() };
    expect(assignSignals(board({ mine: [ticket(1004), ticket(1002)] }, { state: 'stale' }), base, none, now)).toBeNull();
    expect(assignSignals(board({ mine: [] }, { state: 'login', me: undefined }), base, none, now)).toBeNull();
    const other = assignSignals(board({ mine: [ticket(1004), ticket(1002)] }, { me: { id: 102, name: '김담당' } }), base, none, now);
    expect(other?.signals).toEqual([]);
    expect(other?.baseline?.meId).toBe(102);
  });

  it('서비스: 처음 켤 때 내 티켓 전부가 쏟아지지 않고, 새 배정만 알린다', () => {
    const h = harness('2026-09-23T10:00');
    h.service.setBoard(board({ mine: [ticket(1004), ticket(1005)] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.saved?.vocMine?.ids).toEqual([1004, 1005]);
    h.now = at('2026-09-23T10:01');
    h.service.noteSelfAssign(1003);
    h.service.setBoard(board({ mine: [ticket(1004), ticket(1005), ticket(1002), ticket(1003)] }));
    expect(h.toasts.map((t) => t.keys)).toEqual([['voc:1002:assigned-me']]);
  });
});

describe('아침 요약(§6-4)', () => {
  const base = { isBusinessDay: true, morningTime: '08:50', workEnd: '19:00', lastMorning: null, ready: true };

  it('08:50 전 없음 · 뒤에 켜면 켤 때 · 휴일 없음 · 업무 끝 뒤 없음 · 하루 한 번 · 입력 준비 전 없음', () => {
    expect(morningDue({ ...base, now: at('2026-09-23T08:49') })).toBe(false);
    expect(morningDue({ ...base, now: at('2026-09-23T08:50') })).toBe(true);
    expect(morningDue({ ...base, now: at('2026-09-23T11:30') })).toBe(true);
    expect(morningDue({ ...base, now: at('2026-09-24T09:00'), isBusinessDay: false })).toBe(false);
    expect(morningDue({ ...base, now: at('2026-09-23T19:00') })).toBe(false);
    expect(morningDue({ ...base, now: at('2026-09-23T09:00'), lastMorning: TODAY })).toBe(false);
    expect(morningDue({ ...base, now: at('2026-09-23T09:00'), ready: false })).toBe(false);
  });

  it('숫자: 오늘 마감(VOC 제외) · 지남 · SLA(내 칸 + 미배정)', () => {
    const snap = snapshot(TODAY, [task({ id: 'c:a', due: TODAY }), task({ id: 'v:1', source: 'voc', due: TODAY })], 2);
    const b = board({
      unassigned: [ticket(1001, { slaStatus: 'warning' })],
      mine: [ticket(1004, { slaStatus: 'exceeded' })],
      other: [ticket(1008, { slaStatus: 'exceeded' })],
    });
    expect(morningCounts(snap, b, TODAY)).toEqual({ dueToday: 1, overdue: 2, slaWarning: 1, slaExceeded: 1 });
    expect(morningCounts(null, null, TODAY)).toEqual({ dueToday: 0, overdue: 0, slaWarning: 0, slaExceeded: 0 });
  });

  it('서비스: 스냅샷과 보드가 오면 한 장(따로 — 하루 한도·묶음과 별개), 하루 한 번', () => {
    const h = harness('2026-09-23T09:10');
    h.service.setSnapshot(snapshot(TODAY, [task({ id: 'c:a', due: TODAY })], 2));
    expect(h.toasts).toHaveLength(0); // VOC 보드가 아직 없다(loading)
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts.map((t) => t.title)).toEqual(['오늘 요약', 'VOC SLA 초과']);
    expect(h.toasts[0]).toMatchObject({ body: '오늘 마감 1 · 지남 2 · 초과 1', target: 'view:tasks', kinds: ['morning'] });
    expect(h.lastInbox().todayToasts).toBe(1); // 아침 요약은 세지 않는다
    h.tickAt('2026-09-23T11:00');
    expect(h.toasts.filter((t) => t.title === '오늘 요약')).toHaveLength(1);
  });

  it('서비스: VOC 보드가 loading 이어도 켠 지 60초가 지나면 보낸다', () => {
    const h = harness('2026-09-23T09:10');
    h.service.setSnapshot(snapshot(TODAY, [], 1));
    h.service.setBoard(board({}, { state: 'loading', lanes: [] }));
    expect(h.toasts).toHaveLength(0);
    h.tickAt('2026-09-23T09:11');
    expect(h.toasts.map((t) => t.body)).toEqual(['지남 1']);
  });

  it('서비스: 숫자가 모두 0 이면 Windows 알림 없이 알림함에만 "오늘 요약 — 급한 것 없음"', () => {
    const h = harness('2026-09-23T09:10');
    h.service.noteSnapshotMissing();
    h.service.setBoard(board({}));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items.map((i) => [i.kind, i.grade, i.title])).toEqual([['morning', 'today', '오늘 요약 — 급한 것 없음']]);
  });

  it('서비스: 업무 끝 뒤 보류한 것은 다음 업무일 요약에 "보류 N"(추석 연휴에는 요약 없음)', () => {
    const h = harness('2026-09-23T20:00');
    h.service.setSnapshot(snapshot(TODAY, []));
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })], unassigned: [ticket(1001, { slaStatus: 'warning' })] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items.every((i) => i.deferred)).toBe(true);
    h.service.setSnapshot(snapshot('2026-09-24', []));
    h.tickAt('2026-09-24T09:00');
    expect(h.toasts).toHaveLength(0);
    h.service.setSnapshot(snapshot('2026-09-28', []));
    h.tickAt('2026-09-28T09:00');
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].title).toBe('오늘 요약');
    expect(h.toasts[0].body).toContain('보류 2');
    // 보류 항목은 요약을 보내도 읽음이 되지 않는다
    expect(h.lastInbox().items.filter((i) => i.deferred && i.readAt === null)).toHaveLength(2);
  });
});
