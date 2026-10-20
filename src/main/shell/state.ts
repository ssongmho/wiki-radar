// 트레이·작업 표시줄 상태(2.12단계 명세 §1-1~§1-4·§2): 알림함·스냅샷·문제 목록 → 트레이 단계·툴팁·메뉴 글자·오버레이 수.
// electron 없음 — 순수 함수(시험은 vitest). 툴팁·메뉴·오버레이 설명에는 건수와 종류 이름만 넣는다(할 일·티켓 제목·고객 이름 없음 — DESIGN §13-1 ⑦).
import type { InboxState, Snapshot, TeamSyncStatus, TrayLevel, VocBoard } from '../../shared/types';

export interface ShellView {
  level: TrayLevel;
  tooltip: string;
  menu: { inboxLabel: string };
  /** count 0 이면 지움 */
  overlay: { count: number; description: string };
}

export interface ShellPort {
  /** 같은 view·dark 면 아무것도 하지 않는다 */
  update(view: ShellView, dark: boolean): void;
  destroy(): void;
}

/** Windows 트레이 툴팁 길이 한도 */
export const TOOLTIP_MAX = 127;
/** 팀 위키 동기화 오류가 이만큼 이어지면 문제(DESIGN §13-2 "30분 지속") */
export const TEAM_ERROR_PROBLEM_MS = 30 * 60_000;

/** 문제 목록의 짧은 이름(§1-4) */
export const PROBLEM = {
  vocLogin: 'VOC 로그인 필요',
  teamError: '팀 위키 동기화 오류',
  teamPaused: '팀 위키 확인 필요',
  wikiMissing: '위키 폴더 없음',
  toastFailed: 'Windows 알림 실패',
} as const;

export interface ProblemInput {
  board: Pick<VocBoard, 'state'> | null;
  team: Pick<TeamSyncStatus, 'enabled' | 'phase' | 'lastOkAt'> | null;
  /** 개인 위키 폴더가 있는가 */
  wikiOk: boolean;
  /** 오늘 Windows 알림 실패가 있었나 */
  toastFailedToday: boolean;
  now: Date;
}

/** 문제 목록(짧은 이름만) */
export function problemList(input: ProblemInput): string[] {
  const out: string[] = [];
  if (input.board?.state === 'login') out.push(PROBLEM.vocLogin);
  const team = input.team;
  const teamOn = team?.enabled === true;
  if (team && teamOn) {
    if (team.phase === 'error') {
      const ok = team.lastOkAt ? Date.parse(team.lastOkAt) : Number.NaN;
      if (Number.isNaN(ok) || input.now.getTime() - ok > TEAM_ERROR_PROBLEM_MS) out.push(PROBLEM.teamError);
    } else if (team.phase === 'paused') {
      out.push(PROBLEM.teamPaused);
    }
  }
  if (!input.wikiOk && !teamOn) out.push(PROBLEM.wikiMissing);
  if (input.toastFailedToday) out.push(PROBLEM.toastFailed);
  return out;
}

export interface ShellInput {
  inbox: InboxState | null;
  snapshot: Snapshot | null;
  /** 로컬 YYYY-MM-DD */
  today: string;
  problems: readonly string[];
}

/** 오늘 마감 열린 할 일(VOC 제외 — 아침 요약의 dueToday 와 같은 셈) */
function dueTodayOf(snapshot: Snapshot | null, today: string): number {
  if (!snapshot || snapshot.week?.today !== today) return 0;
  return snapshot.tasks.filter((t) => t.source !== 'voc' && t.due === today).length;
}

/** 오버레이 숫자 글자: 1~9, 10 이상은 9+ */
export function overlayLabel(count: number): string {
  return count >= 10 ? '9+' : String(Math.max(0, Math.floor(count)));
}

/** 알림함·스냅샷·문제 → 트레이·오버레이 상태 */
export function shellViewOf(input: ShellInput): ShellView {
  const inbox = input.inbox;
  const urgent = inbox?.unreadUrgent ?? 0;
  const dueToday = dueTodayOf(input.snapshot, input.today);
  const overdue = input.snapshot && input.snapshot.week?.today === input.today ? input.snapshot.counts.overdue : 0;
  const unreadToday = inbox ? inbox.items.filter((i) => i.grade === 'today' && i.readAt === null && i.snoozeUntil === null).length : 0;
  const problems = input.problems;

  let level: TrayLevel = 'normal';
  if (urgent > 0) level = 'urgent';
  else if (problems.length > 0) level = 'problem';
  else if (dueToday + overdue + unreadToday > 0) level = 'today';

  const parts: string[] = [];
  if (urgent > 0) parts.push(`긴급 ${urgent}`);
  if (dueToday > 0) parts.push(`오늘 마감 ${dueToday}`);
  if (overdue > 0) parts.push(`지남 ${overdue}`);
  if (problems.length === 1) parts.push(problems[0]);
  else if (problems.length > 1) parts.push(`문제 ${problems.length}`);
  if (inbox?.held) parts.push('보류 중');
  let tooltip = parts.length > 0 ? ['Radar', ...parts].join(' · ') : 'Radar — 급한 것 없음';
  if (tooltip.length > TOOLTIP_MAX) tooltip = tooltip.slice(0, TOOLTIP_MAX - 1) + '…';

  const unread = inbox?.unread ?? 0;
  return {
    level,
    tooltip,
    menu: { inboxLabel: unread > 0 ? `알림함 (${unread})` : '알림함' },
    overlay: { count: urgent, description: urgent > 0 ? `안 읽은 긴급 ${urgent}건` : '' },
  };
}

/** 같은 상태인가(포트가 같은 것을 다시 그리지 않게) */
export function sameShellView(a: ShellView | null, b: ShellView): boolean {
  return (
    !!a &&
    a.level === b.level &&
    a.tooltip === b.tooltip &&
    a.menu.inboxLabel === b.menu.inboxLabel &&
    a.overlay.count === b.overlay.count &&
    a.overlay.description === b.overlay.description
  );
}
