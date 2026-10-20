// 보류 이유·koffi 읽기(2.12단계 명세 §4·§12-1): QUNS 1~7·null → 이유 · quietHold 끔 → QUNS 무시 · 설정 조용한 시간 안/밖·경계 ·
// createKoffiProbe(로더 예외 → 한 번 경고·다시 로드 안 함 · hr ≠ 0 → null · 10번 연속 실패 경고) · 보낼 것이 없으면 probe 를 부르지 않음.
import { describe, expect, it } from 'vitest';
import { QUNS, qunsReason, quietReasonOf } from '../../src/main/notify/quiet';
import { QUNS_FAILURE_WARN, createKoffiProbe, type KoffiLike } from '../../src/main/notify/qunsProbe';
import { DEFAULT_NOTIFY_SETTINGS } from '../../src/shared/notify';
import { at, board, harness, ticket } from './notifyFixtures';

describe('QUNS → 보류 이유(§4-1)', () => {
  it('표 전부', () => {
    expect(qunsReason(QUNS.NOT_PRESENT)).toBe('away');
    expect(qunsReason(QUNS.BUSY)).toBe('fullscreen');
    expect(qunsReason(QUNS.RUNNING_D3D_FULL_SCREEN)).toBe('fullscreen');
    expect(qunsReason(QUNS.PRESENTATION_MODE)).toBe('presentation');
    expect(qunsReason(QUNS.ACCEPTS_NOTIFICATIONS)).toBeNull();
    expect(qunsReason(QUNS.QUIET_TIME)).toBe('windowsQuiet');
    expect(qunsReason(QUNS.APP)).toBe('fullscreen');
    expect(qunsReason(null)).toBeNull();
    expect(qunsReason(0)).toBeNull();
    expect(qunsReason(99)).toBeNull();
  });

  it('quietHold 를 끄면 QUNS 는 보지 않는다 · 설정 조용한 시간은 따로(끝 시각은 밖) · 둘 다면 설정 쪽', () => {
    const s = { ...DEFAULT_NOTIFY_SETTINGS };
    expect(quietReasonOf(QUNS.BUSY, at('2026-09-23T10:00'), s)).toBe('fullscreen');
    expect(quietReasonOf(QUNS.BUSY, at('2026-09-23T10:00'), { ...s, quietHold: false })).toBeNull();
    const lunch = { ...s, quietHold: false, quietStart: '12:00', quietEnd: '13:00' };
    expect(quietReasonOf(null, at('2026-09-23T11:59'), lunch)).toBeNull();
    expect(quietReasonOf(null, at('2026-09-23T12:00'), lunch)).toBe('userQuiet');
    expect(quietReasonOf(null, at('2026-09-23T12:59'), lunch)).toBe('userQuiet');
    expect(quietReasonOf(null, at('2026-09-23T13:00'), lunch)).toBeNull();
    expect(quietReasonOf(QUNS.PRESENTATION_MODE, at('2026-09-23T12:30'), { ...lunch, quietHold: true })).toBe('userQuiet');
  });
});

describe('createKoffiProbe(§4-2)', () => {
  function fakeKoffi(fn: (out: number[]) => unknown): { koffi: KoffiLike; sigs: string[] } {
    const sigs: string[] = [];
    return {
      sigs,
      koffi: {
        load: (dll: string) => {
          expect(dll).toBe('shell32.dll');
          return {
            func: (sig: string) => {
              sigs.push(sig);
              return (...args: unknown[]) => fn(args[0] as number[]);
            },
          };
        },
      },
    };
  }

  it('로더 예외 → 한 번만 경고하고 그 뒤로는 available:false(다시 로드하지 않는다)', () => {
    const warns: string[] = [];
    let loads = 0;
    const probe = createKoffiProbe(
      () => {
        loads++;
        throw new Error("Cannot find module 'koffi'");
      },
      (m) => warns.push(m),
    );
    expect(probe.read()).toEqual({ available: false, problem: "Cannot find module 'koffi'" });
    expect(probe.read().available).toBe(false);
    expect(loads).toBe(1);
    expect(warns).toEqual(["알림: 전체 화면·발표 중 감지를 쓸 수 없음(Cannot find module 'koffi') — 그대로 보냄"]);
  });

  it('부르기: hr 0 이면 out[0], hr ≠ 0·예외면 null(보낸다) — 10번 연속 실패면 경고 한 줄', () => {
    let mode: 'ok' | 'hr' | 'throw' = 'ok';
    const { koffi, sigs } = fakeKoffi((out) => {
      if (mode === 'throw') throw new Error('터짐');
      out[0] = 4;
      return mode === 'ok' ? 0 : -2147467259;
    });
    const warns: string[] = [];
    const probe = createKoffiProbe(() => koffi, (m) => warns.push(m));
    expect(probe.read()).toEqual({ available: true, quns: 4 });
    expect(sigs).toEqual(['long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)']);
    mode = 'hr';
    expect(probe.read()).toEqual({ available: true, quns: null });
    mode = 'throw';
    for (let i = 1; i < QUNS_FAILURE_WARN + 3; i++) probe.read();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/10번 연속 실패/);
    expect(sigs).toHaveLength(1);
  });

  it('보낼 것이 없으면 probe 를 부르지 않고, 보낼 것이 있을 때 판정마다 최대 한 번', () => {
    const h = harness('2026-09-23T09:00');
    h.service.setBoard(board({ mine: [] }));
    h.tickAt('2026-09-23T09:01');
    expect(h.probeCalls).toBe(0);
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' }), ticket(1005, { slaStatus: 'warning' })] }));
    expect(h.probeCalls).toBe(1);
    expect(h.toasts).toHaveLength(1);
    h.tickAt('2026-09-23T09:02');
    expect(h.probeCalls).toBe(1);
  });

  it('감지를 쓸 수 없으면 그대로 보낸다', () => {
    const h = harness('2026-09-23T09:00');
    h.probeAvailable = false;
    h.service.setBoard(board({ mine: [ticket(1004, { slaStatus: 'exceeded' })] }));
    expect(h.toasts).toHaveLength(1);
  });
});
