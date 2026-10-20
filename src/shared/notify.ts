// 알림 N1 의 설정 기본값·검사와 고정 값(2.9단계 명세 §6·§8-4·§9). main(규칙·IPC 검사)과 renderer(설정 › 알림 입력 검사)가 같이 쓴다.
// 순수 상수·함수만(electron·Node 없음).
import type { NotifyKind, NotifyMode, NotifySettings, QuietReason, ShellSettings } from './types';

export const NOTIFY_KINDS: readonly NotifyKind[] = ['due', 'vocSla', 'vocAssign', 'morning'];
export const NOTIFY_MODES: readonly NotifyMode[] = ['toast', 'inbox', 'off'];

/** 종류 이름(설정 줄·알림 띠) */
export const NOTIFY_KIND_LABEL: Record<NotifyKind, string> = {
  due: '오늘 마감 할 일',
  vocSla: 'VOC SLA',
  vocAssign: 'VOC 새 배정',
  morning: '아침 요약',
};

/** 오늘 마감 알림 시각(고정 — 오후 4시. 2026-10-19 소유자 결정으로 14:00 → 16:00) */
export const DUE_ALERT_TIME = '16:00';
/** 하루에 보내는 긴급 Windows 알림 수(묶음 하나 = 1, 아침 요약은 세지 않는다) */
export const DAILY_TOAST_LIMIT = 10; // 2026-10-19 소유자 결정으로 6 → 10
/** 마지막 긴급 Windows 알림 뒤 이 분 안의 새 신호는 모아서 보낸다 */
export const BUNDLE_MINUTES = 5;

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  kinds: { due: 'toast', vocSla: 'toast', vocAssign: 'toast', morning: 'toast' },
  morningTime: '08:50',
  workStart: '08:00',
  workEnd: '19:00',
  hideContent: false,
  quietStart: '',
  quietEnd: '',
  quietHold: true,
  sound: false,
};

/** 보류 이유의 화면 이름(2.12단계 §4-1) */
export const QUIET_REASON_LABEL: Record<QuietReason, string> = {
  away: '자리 비움(잠금 화면)',
  fullscreen: '전체 화면 앱 사용 중',
  presentation: '발표 중',
  windowsQuiet: 'Windows 조용한 시간',
  userQuiet: '조용한 시간(설정)',
};

export const QUIET_REASONS: readonly QuietReason[] = ['away', 'fullscreen', 'presentation', 'windowsQuiet', 'userQuiet'];

/** 미룬 「1시간 뒤」의 분 */
export const SNOOZE_HOUR_MINUTES = 60;

/** 창 닫기 기본(2.12단계 §6-1b) */
export const DEFAULT_SHELL_SETTINGS: ShellSettings = { closeAction: 'tray' };

/** IPC 저장 입력 검사(엄격 — closeAction 하나만) */
export function checkShellSettings(raw: unknown): ShellSettings {
  if (!isObject(raw)) throw new Error('잘못된 요청입니다: 창 설정');
  for (const key of Object.keys(raw)) {
    if (key !== 'closeAction') throw new Error(`잘못된 요청입니다: ${key.slice(0, 20)}`);
  }
  if (raw.closeAction !== 'tray' && raw.closeAction !== 'quit') throw new Error('잘못된 요청입니다: closeAction');
  return { closeAction: raw.closeAction };
}

/** 파일 값(관대 — 틀리면 기본) */
export function parseShellSettings(raw: unknown): ShellSettings {
  return isObject(raw) && (raw.closeAction === 'tray' || raw.closeAction === 'quit') ? { closeAction: raw.closeAction } : { ...DEFAULT_SHELL_SETTINGS };
}

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isHm(value: unknown): value is string {
  return typeof value === 'string' && HM_RE.test(value);
}

function isMode(value: unknown): value is NotifyMode {
  return typeof value === 'string' && (NOTIFY_MODES as readonly string[]).includes(value);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 기본값의 깊은 복사 */
export function defaultNotifySettings(): NotifySettings {
  return { ...DEFAULT_NOTIFY_SETTINGS, kinds: { ...DEFAULT_NOTIFY_SETTINGS.kinds } };
}

/**
 * 설정 값의 문제(사람이 읽는 문장). 없으면 null. 시각은 HH:MM, 업무 시작 < 끝.
 * 화면 입력 검사와 main 의 저장 검사가 같은 문장을 쓴다
 */
export type NotifyProblemField = 'morningTime' | 'workStart' | 'workEnd' | 'quietStart' | 'quietEnd';

export function notifySettingsProblem(s: NotifySettings): { field: NotifyProblemField; message: string } | null {
  if (!isHm(s.morningTime)) return { field: 'morningTime', message: '아침 요약 시각은 HH:MM(예: 08:50)으로 적으세요' };
  if (!isHm(s.workStart)) return { field: 'workStart', message: '업무 시작 시각은 HH:MM(예: 08:00)으로 적으세요' };
  if (!isHm(s.workEnd)) return { field: 'workEnd', message: '업무 끝 시각은 HH:MM(예: 19:00)으로 적으세요' };
  if (s.workStart >= s.workEnd) return { field: 'workEnd', message: '업무 끝 시각이 시작 시각보다 늦어야 합니다' };
  const qs = s.quietStart ?? '';
  const qe = s.quietEnd ?? '';
  if (!(qs === '' && qe === '') && !(isHm(qs) && isHm(qe))) {
    return { field: isHm(qs) ? 'quietEnd' : 'quietStart', message: '조용한 시간은 HH:MM 두 칸 모두 적거나 모두 비우세요' };
  }
  if (qs !== '' && qs >= qe) return { field: 'quietEnd', message: '조용한 시간 끝이 시작보다 늦어야 합니다' };
  return null;
}

/** 조용한 시간(설정) 안인가 — 시작 ≤ 지금 < 끝(끝 시각은 밖). 비어 있으면 거짓 */
export function inUserQuiet(hm: string, s: Pick<NotifySettings, 'quietStart' | 'quietEnd'>): boolean {
  if (!isHm(s.quietStart) || !isHm(s.quietEnd) || s.quietStart >= s.quietEnd) return false;
  return hm >= s.quietStart && hm < s.quietEnd;
}

/**
 * IPC 저장 입력을 지금 저장값과 합친다(2.12단계 §6-1 — 새 칸은 빠져도 된다. 옛 화면·muteNotifyKind 호환). 들어온 칸은 checkNotifySettings 가 엄격히 본다
 */
export function mergeNotifyInput(current: NotifySettings, raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  return { ...current, ...raw };
}

/** 알림 설정의 칸 이름(IPC 입력에 다른 키가 있으면 거부) */
export const NOTIFY_SETTING_KEYS = [
  'kinds',
  'morningTime',
  'workStart',
  'workEnd',
  'hideContent',
  'quietStart',
  'quietEnd',
  'quietHold',
  'sound',
] as const;

/**
 * IPC 저장 입력 검사(엄격 — 키 넷·값 셋 중 하나·시각·시작<끝·불리언). 틀리면 한국어 문장으로 예외
 */
export function checkNotifySettings(raw: unknown): NotifySettings {
  if (!isObject(raw)) throw new Error('잘못된 요청입니다: 알림 설정');
  if (!isObject(raw.kinds)) throw new Error('잘못된 요청입니다: kinds');
  const kinds = {} as Record<NotifyKind, NotifyMode>;
  for (const kind of NOTIFY_KINDS) {
    const mode = raw.kinds[kind];
    if (!isMode(mode)) throw new Error(`잘못된 요청입니다: kinds.${kind}`);
    kinds[kind] = mode;
  }
  for (const key of Object.keys(raw.kinds)) {
    if (!(NOTIFY_KINDS as readonly string[]).includes(key)) throw new Error(`잘못된 요청입니다: kinds.${key.slice(0, 20)}`);
  }
  for (const key of ['morningTime', 'workStart', 'workEnd'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length > 5) throw new Error(`잘못된 요청입니다: ${key}`);
  }
  if (typeof raw.hideContent !== 'boolean') throw new Error('잘못된 요청입니다: hideContent');
  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length > 5) throw new Error(`잘못된 요청입니다: ${key}`);
  }
  for (const key of ['quietHold', 'sound'] as const) {
    if (typeof raw[key] !== 'boolean') throw new Error(`잘못된 요청입니다: ${key}`);
  }
  for (const key of Object.keys(raw)) {
    if (!(NOTIFY_SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`잘못된 요청입니다: ${key.slice(0, 20)}`);
  }
  const out: NotifySettings = {
    kinds,
    morningTime: raw.morningTime as string,
    workStart: raw.workStart as string,
    workEnd: raw.workEnd as string,
    hideContent: raw.hideContent,
    quietStart: raw.quietStart as string,
    quietEnd: raw.quietEnd as string,
    quietHold: raw.quietHold as boolean,
    sound: raw.sound as boolean,
  };
  const problem = notifySettingsProblem(out);
  if (problem) throw new Error(problem.message);
  return out;
}

/**
 * 파일에서 읽은 값(관대 — 형이 틀린 칸만 기본으로 되돌린다, 전체를 버리지 않는다 — §9).
 * 시작 ≥ 끝이면 업무 시간 둘 다 기본으로
 */
export function parseNotifySettings(raw: unknown): NotifySettings {
  const out = defaultNotifySettings();
  if (!isObject(raw)) return out;
  if (isObject(raw.kinds)) {
    for (const kind of NOTIFY_KINDS) {
      const mode = raw.kinds[kind];
      if (isMode(mode)) out.kinds[kind] = mode;
    }
  }
  if (isHm(raw.morningTime)) out.morningTime = raw.morningTime;
  if (isHm(raw.workStart)) out.workStart = raw.workStart;
  if (isHm(raw.workEnd)) out.workEnd = raw.workEnd;
  if (out.workStart >= out.workEnd) {
    out.workStart = DEFAULT_NOTIFY_SETTINGS.workStart;
    out.workEnd = DEFAULT_NOTIFY_SETTINGS.workEnd;
  }
  if (typeof raw.hideContent === 'boolean') out.hideContent = raw.hideContent;
  // 조용한 시간: 한쪽만 맞거나 시작 ≥ 끝이면 둘 다 없음(2.12단계 §6-1)
  if (isHm(raw.quietStart) && isHm(raw.quietEnd) && raw.quietStart < raw.quietEnd) {
    out.quietStart = raw.quietStart;
    out.quietEnd = raw.quietEnd;
  }
  if (typeof raw.quietHold === 'boolean') out.quietHold = raw.quietHold;
  if (typeof raw.sound === 'boolean') out.sound = raw.sound;
  return out;
}

/** 같은 설정인가(저장 단추를 끌 때) */
export function sameNotifySettings(a: NotifySettings, b: NotifySettings): boolean {
  return (
    NOTIFY_KINDS.every((k) => a.kinds[k] === b.kinds[k]) &&
    a.morningTime === b.morningTime &&
    a.workStart === b.workStart &&
    a.workEnd === b.workEnd &&
    a.hideContent === b.hideContent &&
    a.quietStart === b.quietStart &&
    a.quietEnd === b.quietEnd &&
    a.quietHold === b.quietHold &&
    a.sound === b.sound
  );
}

/** 알림함 항목 id 모양(IPC 검사) */
export const NOTIFY_ITEM_ID_RE = /^n_[A-Za-z0-9]{1,32}$/;
