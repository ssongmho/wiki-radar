// SHQueryUserNotificationState 읽기(2.12단계 명세 §4-2) — koffi(미리 빌드된 바이너리)로 shell32 를 부른다. electron 없음.
// koffi 는 주입한다(로더) — 없거나 로드에 실패하면 한 번만 경고하고 그 뒤로는 "쓸 수 없음"(다시 로드하지 않는다). 앱은 그대로 뜬다.

export type QunsRead = { available: true; quns: number | null } | { available: false; problem: string };

export interface QunsProbe {
  read(): QunsRead;
}

/** koffi 에서 쓰는 만큼의 모양 */
export interface KoffiLike {
  load(path: string): { func(signature: string): (...args: unknown[]) => unknown };
}

/** 연속 실패가 이 수에 닿으면 경고 한 줄 */
export const QUNS_FAILURE_WARN = 10;

export const QUNS_SIGNATURE = 'long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)';

export function createKoffiProbe(load: () => KoffiLike, warn: (message: string) => void): QunsProbe {
  let fn: ((...args: unknown[]) => unknown) | null = null;
  let problem: string | null = null;
  let failures = 0;
  return {
    read(): QunsRead {
      if (problem !== null) return { available: false, problem };
      if (!fn) {
        try {
          fn = load().load('shell32.dll').func(QUNS_SIGNATURE);
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err);
          warn(`알림: 전체 화면·발표 중 감지를 쓸 수 없음(${problem}) — 그대로 보냄`);
          return { available: false, problem };
        }
      }
      try {
        // koffi 의 _Out_ 인자는 한 칸짜리 배열로 받는다
        const out = [0];
        const hr = fn(out);
        if (hr === 0 && typeof out[0] === 'number' && Number.isFinite(out[0])) {
          failures = 0;
          return { available: true, quns: out[0] };
        }
        throw new Error(`HRESULT ${String(hr)}`);
      } catch (err) {
        failures++;
        if (failures === QUNS_FAILURE_WARN) {
          warn(`알림: 전체 화면 감지 호출이 ${QUNS_FAILURE_WARN}번 연속 실패함(${err instanceof Error ? err.message : String(err)}) — 그대로 보냄`);
        }
        return { available: true, quns: null };
      }
    },
  };
}

/** 시험·koffi 없는 환경의 고정 값 probe */
export function fixedProbe(get: () => QunsRead): QunsProbe {
  return { read: get };
}
