// 보류 이유(2.12단계 명세 §4-1): Windows SHQueryUserNotificationState(QUNS) 값과 설정의 조용한 시간 → 보류 이유.
// electron·koffi 없음 — QUNS 값은 qunsProbe.ts 가 읽어 넘긴다(시험은 가짜 값).
import { inUserQuiet } from '../../shared/notify';
import type { NotifySettings, QuietReason } from '../../shared/types';
import { hmOf } from './rules';

/** QUNS_* 값 */
export const QUNS = {
  NOT_PRESENT: 1,
  BUSY: 2,
  RUNNING_D3D_FULL_SCREEN: 3,
  PRESENTATION_MODE: 4,
  ACCEPTS_NOTIFICATIONS: 5,
  QUIET_TIME: 6,
  APP: 7,
} as const;

/** QUNS 값 → 보류 이유. 받을 수 있음·실패·그 밖 값은 null(보낸다) */
export function qunsReason(quns: number | null): QuietReason | null {
  switch (quns) {
    case QUNS.NOT_PRESENT:
      return 'away';
    case QUNS.BUSY:
    case QUNS.RUNNING_D3D_FULL_SCREEN:
    case QUNS.APP:
      return 'fullscreen';
    case QUNS.PRESENTATION_MODE:
      return 'presentation';
    case QUNS.QUIET_TIME:
      return 'windowsQuiet';
    default:
      return null;
  }
}

/**
 * 지금 Windows 알림을 모아 둘 이유. 설정의 조용한 시간이 먼저(둘 다면 설정 쪽). quietHold 가 거짓이면 QUNS 는 보지 않는다
 */
export function quietReasonOf(
  quns: number | null,
  now: Date,
  settings: Pick<NotifySettings, 'quietStart' | 'quietEnd' | 'quietHold'>,
): QuietReason | null {
  if (inUserQuiet(hmOf(now), settings)) return 'userQuiet';
  if (!settings.quietHold) return null;
  return qunsReason(quns);
}
