// 알림 N1 규칙(2.9단계 명세 §6·§12-2): 업무 시간 · 단계 순위(가족) · 같은 판정 한 묶음 · 5분 보류 · 하루 한도 10 · 풀스크린 초점 ·
// 종류 inbox/off · 문구 · 설정 검사. 가짜 시계로 NotifyService 를 직접 돌린다(electron 없음).
import { describe, expect, it } from 'vitest';
import {
  bundleText,
  bundleWindowPassed,
  checkNotifySettings,
  dropVanished,
  dueFamily,
  familyKind,
  isWorkTime,
  heldText,
  isWorse,
  morningText,
  morningTotalOf,
  parseNotifySettings,
} from '../../src/main/notify/rules';
import { BusinessCalendar } from '../../src/main/wiki/calendar';
import {
  DEFAULT_NOTIFY_SETTINGS,
  checkShellSettings,
  mergeNotifyInput,
  notifySettingsProblem,
  parseShellSettings,
  sameNotifySettings,
} from '../../src/shared/notify';
import { HOLIDAYS, at, board, harness, ticket } from './notifyFixtures';

const cal = new BusinessCalendar(HOLIDAYS);
const WORK = { workStart: '08:00', workEnd: '19:00' };

describe('업무 시간(§6-2)', () => {
  it('평일 08:00~19:00 만, 추석(9/24)·주말은 하루 종일 밖', () => {
    expect(isWorkTime(at('2026-09-23T08:00'), WORK, cal)).toBe(true);
    expect(isWorkTime(at('2026-09-23T18:59'), WORK, cal)).toBe(true);
    expect(isWorkTime(at('2026-09-23T07:59'), WORK, cal)).toBe(false);
    expect(isWorkTime(at('2026-09-23T19:00'), WORK, cal)).toBe(false);
    expect(isWorkTime(at('2026-09-24T10:00'), WORK, cal)).toBe(false); // 추석
    expect(isWorkTime(at('2026-09-27T10:00'), WORK, cal)).toBe(false); // 일요일
    expect(isWorkTime(at('2026-09-28T10:00'), WORK, cal)).toBe(true); // 월요일
    expect(isWorkTime(at('2026-09-28T09:30'), { workStart: '10:00', workEnd: '17:00' }, cal)).toBe(false);
  });
});

describe('단계 순위·가족(§6-1)', () => {
  it('기억한 순위보다 높을 때만 — 임박 → 초과는 다시, 초과 → 임박은 아님', () => {
    const fam = { 'voc:1:sla': { rank: 1, at: '2026-09-23T00:00:00.000Z' } };
    expect(isWorse(fam, { family: 'voc:1:sla', rank: 2 })).toBe(true);
    expect(isWorse(fam, { family: 'voc:1:sla', rank: 1 })).toBe(false);
    expect(isWorse({ 'voc:1:sla': { rank: 2, at: '' } }, { family: 'voc:1:sla', rank: 1 })).toBe(false);
    expect(isWorse({}, { family: 'voc:2:sla', rank: 1 })).toBe(true);
  });

  it('사라진 가족은 그 종류만 지운다. 오늘 마감 가족은 같은 날이면 둔다', () => {
    const today = '2026-09-23';
    const fam: Record<string, { rank: number; at: string }> = {
      'voc:1:sla': { rank: 1, at: at('2026-09-23T09:00').toISOString() },
      'voc:2:sla': { rank: 2, at: at('2026-09-23T09:00').toISOString() },
      'voc:3:assign': { rank: 1, at: at('2026-09-23T09:00').toISOString() },
      'task:c:aaa:due': { rank: 1, at: at('2026-09-23T14:00').toISOString() },
      'task:c:bbb:due': { rank: 1, at: at('2026-09-22T14:00').toISOString() },
    };
    dropVanished(fam, new Set(['vocSla']), new Set(['voc:2:sla']), today);
    expect(Object.keys(fam).sort()).toEqual(['task:c:aaa:due', 'task:c:bbb:due', 'voc:2:sla', 'voc:3:assign']);
    dropVanished(fam, new Set(['due']), new Set(), today);
    expect(Object.keys(fam).sort()).toEqual(['task:c:aaa:due', 'voc:2:sla', 'voc:3:assign']);
  });

  it('오늘 마감 가족 키에는 날짜가 붙고, 다른 날의 가족은 입력에 보여도(시각이 오늘이어도) 지운다', () => {
    const today = '2026-09-29';
    const fam: Record<string, { rank: number; at: string }> = {
      'task:c:aaa:due:2026-09-28': { rank: 1, at: at('2026-09-29T15:00').toISOString() },
      'task:c:aaa:due:2026-09-29': { rank: 1, at: at('2026-09-29T15:00').toISOString() },
    };
    expect(familyKind('task:c:aaa:due:2026-09-28')).toBe('due');
    dropVanished(fam, new Set(['due']), new Set(['task:c:aaa:due:2026-09-28']), today);
    expect(Object.keys(fam)).toEqual(['task:c:aaa:due:2026-09-29']);
    expect(dueFamily('c:aaa', today)).toBe('task:c:aaa:due:2026-09-29');
  });

  it('서비스: 임박 → 초과는 다시 알리고, 초과 → 임박은 아님. 정상으로 돌아가면 가족을 지워 다시 나빠질 때 또 알린다', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h.toasts.map((t) => t.keys)).toEqual([['voc:1004:sla-warning']]);
    expect(h.toasts[0].title).toBe('VOC SLA 임박');

    h.now = at('2026-09-23T09:10');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts.map((t) => t.keys[0])).toEqual(['voc:1004:sla-warning', 'voc:1004:sla-exceeded']);

    h.now = at('2026-09-23T09:20');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h.toasts).toHaveLength(2);

    h.now = at('2026-09-23T09:30');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'normal' })] }));
    expect(h.saved?.families['voc:1004:sla']).toBeUndefined();
    h.now = at('2026-09-23T09:40');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h.toasts).toHaveLength(3);
  });

  it('받지 못한 보드(stale)로는 가족을 지우지 않고 신호도 내지 않는다', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    h.now = at('2026-09-23T09:10');
    h.service.setBoard(board({ mine: [] }, { state: 'stale' }));
    expect(h.saved?.families['voc:1004:sla']).toEqual({ rank: 2, at: expect.any(String) });
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(1);
  });
});

describe('묶음·한도·초점(§6-2·§6-3)', () => {
  it('같은 판정에서 생긴 긴급 신호는 Windows 알림 한 장', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(
      board({ unassigned: [ticket(1001, { slaStatus: 'warning' })], mine: [ticket(1004, { slaStatus: 'exceeded' })] }),
    );
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].keys.sort()).toEqual(['voc:1001:sla-warning', 'voc:1004:sla-exceeded']);
    expect(h.toasts[0].target).toBe('view:inbox');
    expect(h.lastInbox().items).toHaveLength(2);
    expect(h.lastInbox().todayToasts).toBe(1);
  });

  it('마지막 알림 뒤 5분 안의 새 신호는 보류했다가 +5분 판정에 한 장으로', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h.toasts).toHaveLength(1);
    h.now = at('2026-09-23T09:02');
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' }), ticket(1005, { slaStatus: 'exceeded' })] }));
    h.now = at('2026-09-23T09:03');
    h.service.setBoard(
      board({ unassigned: [ticket(1004, { slaStatus: 'warning' }), ticket(1005, { slaStatus: 'exceeded' }), ticket(1006, { slaStatus: 'warning' })] }),
    );
    expect(h.toasts).toHaveLength(1);
    expect(h.saved?.pending?.itemIds).toHaveLength(2);
    h.tickAt('2026-09-23T09:04');
    expect(h.toasts).toHaveLength(1);
    h.tickAt('2026-09-23T09:05');
    expect(h.toasts).toHaveLength(2);
    expect(h.toasts[1].keys.sort()).toEqual(['voc:1005:sla-exceeded', 'voc:1006:sla-warning']);
    expect(h.saved?.pending).toBeNull();
    // 5분이 지난 뒤의 새 신호는 바로
    h.now = at('2026-09-23T09:11');
    h.service.setBoard(
      board({
        unassigned: [
          ticket(1004, { slaStatus: 'warning' }),
          ticket(1005, { slaStatus: 'exceeded' }),
          ticket(1006, { slaStatus: 'warning' }),
          ticket(1007, { slaStatus: 'warning' }),
        ],
      }),
    );
    expect(h.toasts).toHaveLength(3);
  });

  it('보류 중에 그 종류를 알림함만·끔으로 바꾸면 +5분 판정에 Windows 알림을 내지 않는다(보내는 때 종류 설정을 다시 봄)', () => {
    for (const mode of ['inbox', 'off'] as const) {
      const h = harness('2026-09-23T09:00');
      h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }));
      expect(h.toasts).toHaveLength(1);
      h.now = at('2026-09-23T09:02');
      h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' }), ticket(1005, { slaStatus: 'exceeded' })] }));
      expect(h.saved?.pending?.itemIds).toHaveLength(1);
      h.settings = { ...h.settings, kinds: { ...h.settings.kinds, vocSla: mode } };
      h.now = at('2026-09-23T09:03');
      h.service.refresh();
      h.tickAt('2026-09-23T09:05');
      h.tickAt('2026-09-23T09:10');
      expect(h.toasts, mode).toHaveLength(1);
      expect(h.saved?.pending ?? null).toBeNull();
      // 항목은 알림함에 남는다
      expect(h.lastInbox().items.some((i) => i.key === 'voc:1005:sla-exceeded')).toBe(true);
    }
  });

  it('알림 기록을 읽지 못하면(잠김) 판정·저장을 건너뛰고, 읽히면 그 기록으로 이어 간다(빈 상태로 덮어쓰지 않음)', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h.toasts).toHaveLength(1);
    const saved = h.saved;
    const h2 = harness('2026-09-23T10:00');
    h2.saved = saved;
    let locked = true;
    const realLoad = (h2.service as unknown as { opts: { store: { load: (now: Date) => unknown } } }).opts.store.load;
    (h2.service as unknown as { opts: { store: { load: (now: Date) => unknown } } }).opts.store.load = (now: Date) => {
      if (locked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return realLoad(now);
    };
    h2.service.setBoard(board({ unassigned: [ticket(1004, { slaStatus: 'warning' })] }));
    expect(h2.saves).toBe(0);
    expect(h2.toasts).toHaveLength(0);
    expect(h2.lastInbox().items).toEqual([]);
    locked = false;
    h2.tickAt('2026-09-23T10:01');
    // 기록의 가족이 살아 있어 같은 SLA 임박을 다시 알리지 않는다
    expect(h2.toasts).toHaveLength(0);
    expect(h2.lastInbox().items.some((i) => i.key === 'voc:1004:sla-warning')).toBe(true);
  });

  it('하루 한도 10 — 열한째부터는 알림함에만, 머리 수는 10/10', () => {
    const h = harness('2026-09-23T09:00');
    const tickets = [];
    for (let i = 0; i < 12; i++) {
      tickets.push(ticket(2000 + i, { slaStatus: 'warning' }));
      h.now = at(`2026-09-23T${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
      h.service.setBoard(board({ unassigned: [...tickets] }));
    }
    expect(h.toasts).toHaveLength(10);
    const inbox = h.lastInbox();
    expect(inbox.items).toHaveLength(12);
    expect(inbox.todayToasts).toBe(10);
    expect(inbox.dailyLimit).toBe(10);
    expect(inbox.items.filter((i) => i.toastAt === null)).toHaveLength(2);
  });

  it('풀스크린에 초점이 있으면 알림함만', () => {
    const h = harness('2026-09-23T09:00');
    h.focused = true;
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().unread).toBe(1);
    expect(h.lastInbox().unreadUrgent).toBe(1);
  });

  it('Windows 알림을 못 쓰면(unsupported) 알림함에만', () => {
    const h = harness('2026-09-23T09:00', { toastMode: 'unsupported' });
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items).toHaveLength(1);
    expect(h.lastInbox().toastMode).toBe('unsupported');
  });

  it('종류 inbox 는 알림함만, off 는 아무 데도 — 그래도 가족은 기록해 다시 켜도 옛 신호를 쏟지 않는다', () => {
    const h = harness('2026-09-23T09:00');
    h.settings = { ...h.settings, kinds: { ...h.settings.kinds, vocSla: 'inbox', vocAssign: 'off' } };
    h.service.setBoard(board({ mine: [] }));
    h.now = at('2026-09-23T09:01');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' }), ticket(1005)] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items.map((i) => i.key)).toEqual(['voc:1004:sla-exceeded']);
    expect(h.saved?.families['voc:1005:assign']).toEqual({ rank: 1, at: expect.any(String) });
    h.settings = { ...h.settings, kinds: { ...h.settings.kinds, vocSla: 'toast', vocAssign: 'toast' } };
    h.tickAt('2026-09-23T09:30');
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items).toHaveLength(1);
  });

  it('내용 숨김이면 Windows 알림 내용은 건수만(알림함 항목은 그대로)', () => {
    const h = harness('2026-09-23T09:00');
    h.settings = { ...h.settings, hideContent: true };
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded', title: '고객사 비밀 제목' })] }));
    expect(h.toasts[0]).toMatchObject({ title: 'VOC SLA 초과', body: '1건' });
    expect(h.lastInbox().items[0].body).toBe('VOC-2026-1004 · 고객사 비밀 제목');
    expect(h.lastInbox().hideContent).toBe(true);
  });

  it('업무 시간 밖은 보류(deferred) — Windows 알림 없음, 나중에 따로 보내지도 않는다', () => {
    const h = harness('2026-09-23T20:00');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(0);
    expect(h.lastInbox().items[0]).toMatchObject({ deferred: true, toastAt: null });
    h.tickAt('2026-09-24T10:00');
    expect(h.toasts).toHaveLength(0);
  });

  it('읽음: 열기는 그 항목만, 모두 읽음은 전부 · 알림함 이벤트를 보낸다', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' }), ticket(1005, { slaStatus: 'warning' })] }));
    const [a] = h.lastInbox().items;
    const sent = h.inboxes.length;
    expect(h.service.open(a.id)).toBe(a.target);
    expect(h.lastInbox().unread).toBe(1);
    expect(h.inboxes.length).toBe(sent + 1);
    expect(h.service.markRead('all').unread).toBe(0);
    expect(h.service.open('n_없음')).toBeNull();
  });
});

describe('문구(§6-3)', () => {
  const sig = (kind: 'due' | 'vocSla' | 'vocAssign', label: string, title: string, body: string) =>
    ({ kind, label, title, body }) as Parameters<typeof bundleText>[0][number];

  it('한 건 · 같은 종류 여러 건 · 섞인 것 · 내용 숨김', () => {
    expect(bundleText([sig('vocSla', 'SLA 초과', 'VOC SLA 초과', 'VOC-2026-0104 · 제목')], false)).toEqual({
      title: 'VOC SLA 초과',
      body: 'VOC-2026-0104 · 제목',
    });
    expect(bundleText([sig('due', '오늘 마감', '오늘 마감', '보고서 제출')], false)).toEqual({ title: '오늘 마감', body: '보고서 제출' });
    expect(
      bundleText(
        [sig('due', '오늘 마감', '오늘 마감', '가'), sig('due', '오늘 마감', '오늘 마감', '나'), sig('due', '오늘 마감', '오늘 마감', '다')],
        false,
      ),
    ).toEqual({ title: '오늘 마감 할 일 3건', body: '가, 나 외 1건' });
    expect(
      bundleText([sig('vocAssign', '새 배정', 'VOC 새 배정', 'VOC-1 · a'), sig('vocAssign', '새 배정', 'VOC 새 배정', 'VOC-2 · b')], false),
    ).toEqual({ title: 'VOC 새 배정 2건', body: 'VOC-1, VOC-2' });
    expect(
      bundleText(
        [
          sig('vocSla', 'SLA 초과', 'VOC SLA 초과', 'VOC-1 · a'),
          sig('vocSla', 'SLA 임박', 'VOC SLA 임박', 'VOC-2 · b'),
          sig('due', '오늘 마감', '오늘 마감', '가'),
          sig('due', '오늘 마감', '오늘 마감', '나'),
        ],
        false,
      ),
    ).toEqual({ title: '긴급 4건', body: 'SLA 초과 1 · SLA 임박 1 · 오늘 마감 2' });
    expect(bundleText([sig('due', '오늘 마감', '오늘 마감', '가'), sig('due', '오늘 마감', '오늘 마감', '나')], true).body).toBe('2건');
  });

  it('아침 요약: 0 은 빼고, 모두 0 이면 조용히(급한 것 없음)', () => {
    expect(morningText({ dueToday: 3, overdue: 2, slaWarning: 1, slaExceeded: 2, deferred: 3 }, false)).toEqual({
      title: '오늘 요약',
      body: '오늘 마감 3 · 지남 2 · SLA 임박 1 · 초과 2 · 보류 3',
      quiet: false,
    });
    expect(morningText({ dueToday: 0, overdue: 2, slaWarning: 0, slaExceeded: 0, deferred: 0 }, false).body).toBe('지남 2');
    expect(morningText({ dueToday: 0, overdue: 0, slaWarning: 0, slaExceeded: 0, deferred: 0 }, false)).toEqual({
      title: '오늘 요약 — 급한 것 없음',
      body: '',
      quiet: true,
    });
    expect(morningText({ dueToday: 1, overdue: 2, slaWarning: 0, slaExceeded: 0, deferred: 0 }, true).body).toBe('3건');
  });

  it('5분 묶음 창은 분 단위로 잰다', () => {
    expect(bundleWindowPassed(null, at('2026-09-23T09:00'))).toBe(true);
    const last = at('2026-09-23T14:00').toISOString();
    expect(bundleWindowPassed(new Date(at('2026-09-23T14:00').getTime() + 30_000).toISOString(), at('2026-09-23T14:05'))).toBe(true);
    expect(bundleWindowPassed(last, at('2026-09-23T14:04'))).toBe(false);
  });
});

describe('설정 검사(§9·§10)', () => {
  it('저장 입력은 엄격하게 — 키 넷·값 셋·HH:MM·시작<끝·불리언', () => {
    const ok = structuredClone(DEFAULT_NOTIFY_SETTINGS);
    expect(checkNotifySettings(ok)).toEqual(ok);
    expect(() => checkNotifySettings({ ...ok, kinds: { ...ok.kinds, due: 'loud' } })).toThrow(/kinds\.due/);
    expect(() => checkNotifySettings({ ...ok, kinds: { ...ok.kinds, extra: 'off' } })).toThrow(/kinds\.extra/);
    const { vocSla: _v, ...three } = ok.kinds;
    expect(() => checkNotifySettings({ ...ok, kinds: three })).toThrow(/kinds\.vocSla/);
    expect(() => checkNotifySettings({ ...ok, morningTime: '8:50' })).toThrow(/아침 요약 시각/);
    expect(() => checkNotifySettings({ ...ok, workStart: '24:00' })).toThrow(/업무 시작/);
    expect(() => checkNotifySettings({ ...ok, workStart: '19:00', workEnd: '08:00' })).toThrow(/늦어야/);
    expect(() => checkNotifySettings({ ...ok, hideContent: 'yes' })).toThrow(/hideContent/);
    expect(() => checkNotifySettings(null)).toThrow();
  });

  it('파일 값은 틀린 칸만 기본으로', () => {
    expect(parseNotifySettings(undefined)).toEqual(DEFAULT_NOTIFY_SETTINGS);
    const p = parseNotifySettings({ kinds: { due: 'inbox', vocSla: 'nope' }, morningTime: '09:30', workStart: 'x', hideContent: 1 });
    expect(p).toEqual({ ...DEFAULT_NOTIFY_SETTINGS, kinds: { ...DEFAULT_NOTIFY_SETTINGS.kinds, due: 'inbox' }, morningTime: '09:30' });
    expect(parseNotifySettings({ workStart: '20:00', workEnd: '07:00' })).toMatchObject({ workStart: '08:00', workEnd: '19:00' });
  });

  it('화면 입력 검사와 같은지 비교', () => {
    expect(notifySettingsProblem({ ...DEFAULT_NOTIFY_SETTINGS, workEnd: '08:00' })?.field).toBe('workEnd');
    expect(notifySettingsProblem(DEFAULT_NOTIFY_SETTINGS)).toBeNull();
    expect(sameNotifySettings(DEFAULT_NOTIFY_SETTINGS, structuredClone(DEFAULT_NOTIFY_SETTINGS))).toBe(true);
    expect(sameNotifySettings(DEFAULT_NOTIFY_SETTINGS, { ...DEFAULT_NOTIFY_SETTINGS, hideContent: true })).toBe(false);
  });
});

describe('2.12단계 — 문구·설정(§3-4·§5-1·§6-1)', () => {
  it('아침 요약의 「나중에 N」 — 순서 오늘 마감 · 지남 · SLA 임박 · 초과 · 보류 · 나중에, 나중에만 있어도 Windows 알림', () => {
    const n = { dueToday: 3, overdue: 2, slaWarning: 0, slaExceeded: 0, deferred: 1, snoozed: 1 };
    expect(morningText(n, false)).toEqual({ title: '오늘 요약', body: '오늘 마감 3 · 지남 2 · 보류 1 · 나중에 1', quiet: false });
    expect(morningText(n, true).body).toBe('7건');
    expect(morningText({ dueToday: 0, overdue: 0, slaWarning: 0, slaExceeded: 0, deferred: 0, snoozed: 2 }, false)).toEqual({
      title: '오늘 요약',
      body: '나중에 2',
      quiet: false,
    });
  });

  it('보류 요약 문구: 제목 「보류한 알림 N건」(긴급 + 1), 긴급 갈래는 섞임 문구 순서', () => {
    expect(heldText({ title: '오늘 요약', body: '' }, [{ label: '오늘 마감' }, { label: 'SLA 초과' }, { label: '오늘 마감' }], false)).toEqual({
      title: '보류한 알림 4건',
      body: '오늘 요약 · SLA 초과 1 · 오늘 마감 2',
    });
    expect(morningTotalOf('오늘 마감 3 · 지남 12 · 나중에 1')).toBe(16);
  });

  it('조용한 시간: 둘 다 비우거나 둘 다 HH:MM·시작 < 끝 — 파일은 한쪽만·시작 ≥ 끝이면 둘 다 빈 값', () => {
    const ok = structuredClone(DEFAULT_NOTIFY_SETTINGS);
    expect(notifySettingsProblem({ ...ok, quietStart: '12:00', quietEnd: '13:00' })).toBeNull();
    expect(notifySettingsProblem({ ...ok, quietStart: '12:00', quietEnd: '' })).toEqual({
      field: 'quietEnd',
      message: '조용한 시간은 HH:MM 두 칸 모두 적거나 모두 비우세요',
    });
    expect(notifySettingsProblem({ ...ok, quietStart: '', quietEnd: '13:00' })?.field).toBe('quietStart');
    expect(notifySettingsProblem({ ...ok, quietStart: '13:00', quietEnd: '13:00' })).toEqual({
      field: 'quietEnd',
      message: '조용한 시간 끝이 시작보다 늦어야 합니다',
    });
    expect(parseNotifySettings({ quietStart: '12:00' })).toMatchObject({ quietStart: '', quietEnd: '' });
    expect(parseNotifySettings({ quietStart: '14:00', quietEnd: '13:00' })).toMatchObject({ quietStart: '', quietEnd: '' });
    expect(parseNotifySettings({ quietStart: '12:00', quietEnd: '13:00', quietHold: false, sound: true })).toMatchObject({
      quietStart: '12:00',
      quietEnd: '13:00',
      quietHold: false,
      sound: true,
    });
    expect(parseNotifySettings({ quietHold: 'no', sound: 1 })).toMatchObject({ quietHold: true, sound: false });
  });

  it('IPC 저장: 새 칸은 빠져도 지금 저장값과 합쳐 통과, 들어온 칸은 엄격히(형·모르는 키)', () => {
    const cur = { ...structuredClone(DEFAULT_NOTIFY_SETTINGS), quietStart: '12:00', quietEnd: '13:00', sound: true };
    const old = { kinds: cur.kinds, morningTime: '09:00', workStart: '08:00', workEnd: '19:00', hideContent: false };
    expect(checkNotifySettings(mergeNotifyInput(cur, old))).toEqual({ ...cur, morningTime: '09:00' });
    expect(() => checkNotifySettings(mergeNotifyInput(cur, { ...old, sound: 'yes' }))).toThrow(/sound/);
    expect(() => checkNotifySettings(mergeNotifyInput(cur, { ...old, quietStart: '12:00:00' }))).toThrow(/quietStart/);
    expect(() => checkNotifySettings(mergeNotifyInput(cur, { ...old, extra: 1 }))).toThrow(/extra/);
    expect(() => checkNotifySettings(mergeNotifyInput(cur, { ...old, quietEnd: '' }))).toThrow(/모두 비우세요/);
    expect(sameNotifySettings(cur, { ...cur, quietHold: false })).toBe(false);
  });

  it('창 닫기 설정: closeAction 하나만, 파일은 틀리면 기본(tray)', () => {
    expect(checkShellSettings({ closeAction: 'quit' })).toEqual({ closeAction: 'quit' });
    expect(() => checkShellSettings({ closeAction: 'hide' })).toThrow(/closeAction/);
    expect(() => checkShellSettings({ closeAction: 'tray', x: 1 })).toThrow(/x/);
    expect(() => checkShellSettings(null)).toThrow();
    expect(parseShellSettings({ closeAction: 'nope' })).toEqual({ closeAction: 'tray' });
    expect(parseShellSettings({ closeAction: 'quit' })).toEqual({ closeAction: 'quit' });
  });
});
