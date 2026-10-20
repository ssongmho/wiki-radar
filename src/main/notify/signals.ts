// 알림 N1 신호(2.9단계 명세 §6-1·§6-4): 스냅샷·VOC 보드 → 긴급 신호(오늘 마감 · SLA · 새 배정)와 아침 요약 숫자.
// electron 없음. 시각·오늘은 인자로 받는다.
import { DUE_ALERT_TIME } from '../../shared/notify';
import type { Snapshot, VocBoard, VocTicket } from '../../shared/types';
import { dueFamily, hmOf, ymdOf, type UrgentSignal } from './rules';

/** VOC 화면에서 그 티켓을 고르라는 표시(renderer 의 vocFocusId 와 같은 모양) */
export function vocTarget(ticket: Pick<VocTicket, 'id' | 'number'>): string {
  return `view:voc:${String(ticket.number || ticket.id).trim()}`;
}

/** 오늘 마감 신호와 그 출처의 지금 가족(오늘 마감인 열린 할 일 전부) */
export interface SignalSet {
  signals: UrgentSignal[];
  /** 지금 입력에 보이는 가족 — 여기 없는 그 종류의 가족은 지운다 */
  present: Set<string>;
}

/**
 * 오늘 마감(§6-1): 오늘 마감인 열린 할 일(개인 + 팀 내 것, VOC 할 일 제외) — DUE_ALERT_TIME(오후 4시)부터.
 * 스냅샷의 오늘이 지금 날짜와 다르면(날짜가 막 바뀐 사이) 아무것도 내지 않는다(null — 가족도 건드리지 않는다)
 */
export function dueSignals(snapshot: Snapshot, now: Date): SignalSet | null {
  const today = ymdOf(now);
  if (snapshot.week.today !== today) return null;
  const out: SignalSet = { signals: [], present: new Set() };
  if (hmOf(now) < DUE_ALERT_TIME) return out;
  const seen = new Set<string>();
  for (const task of snapshot.tasks) {
    if (task.source === 'voc' || task.due !== today) continue;
    if (task.status !== 'open' && task.status !== 'wip') continue;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const family = dueFamily(task.id, today);
    out.present.add(family);
    out.signals.push({
      kind: 'due',
      family,
      key: `task:${task.id}:due-today`,
      rank: 1,
      title: '오늘 마감',
      body: task.title,
      target: task.id,
      label: '오늘 마감',
    });
  }
  return out;
}

/** 내 칸 + 미배정 칸의 티켓(같은 티켓은 한 번) */
export function watchedTickets(board: VocBoard): VocTicket[] {
  const out: VocTicket[] = [];
  const seen = new Set<number>();
  for (const lane of board.lanes) {
    if (!(lane.me === true || lane.key === 'unassigned')) continue;
    for (const t of lane.tickets) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** 내 칸의 티켓 id(보드가 나를 찾았을 때만) */
export function myTicketIds(board: VocBoard): number[] {
  const lane = board.lanes.find((l) => l.me === true);
  return lane ? lane.tickets.map((t) => t.id) : [];
}

/** SLA(§6-1): 내 칸 + 미배정 칸 티켓의 서버 slaStatus — warning 임박(1), exceeded 초과(2). normal·없음은 신호가 아니다 */
export function slaSignals(board: VocBoard): SignalSet {
  const out: SignalSet = { signals: [], present: new Set() };
  for (const t of watchedTickets(board)) {
    if (t.slaStatus !== 'warning' && t.slaStatus !== 'exceeded') continue;
    const exceeded = t.slaStatus === 'exceeded';
    const family = `voc:${t.id}:sla`;
    out.present.add(family);
    out.signals.push({
      kind: 'vocSla',
      family,
      key: `voc:${t.id}:${exceeded ? 'sla-exceeded' : 'sla-warning'}`,
      rank: exceeded ? 2 : 1,
      title: exceeded ? 'VOC SLA 초과' : 'VOC SLA 임박',
      body: `${t.number} · ${t.title}`,
      target: vocTarget(t),
      label: exceeded ? 'SLA 초과' : 'SLA 임박',
    });
  }
  return out;
}

/** 새 배정 기준(notifications.json 의 vocMine) */
export interface VocMineBaseline {
  meId: number;
  ids: number[];
  at: string;
}

export interface AssignResult extends SignalSet {
  /** 바꿀 기준(보드가 ok 이고 나를 찾았을 때만 — 아니면 null 이고 기준을 그대로 둔다) */
  baseline: VocMineBaseline | null;
}

/** 내가 앱에서 나에게 배정한 티켓을 신호에서 빼는 시간(§6-1) */
export const SELF_ASSIGN_QUIET_MS = 10 * 60_000;

/**
 * 새 배정(§6-1): ok 보드(나를 찾음)의 내 칸 id 를 기준과 비교해 새로 생긴 id 가 신호다. 기준이 없거나 me.id 가 바뀌었으면 기준만 기록한다.
 * stale·login 등 받지 못한 보드로는 기준을 바꾸지 않는다(null). selfAssigned: 티켓 id → 내가 나에게 배정한 시각(ms)
 */
export function assignSignals(
  board: VocBoard,
  baseline: VocMineBaseline | null,
  selfAssigned: ReadonlyMap<number, number>,
  now: Date,
): AssignResult | null {
  if (board.state !== 'ok' || !board.me) return null;
  const lane = board.lanes.find((l) => l.me === true);
  if (!lane) return null;
  const ids = lane.tickets.map((t) => t.id);
  const next: VocMineBaseline = { meId: board.me.id, ids, at: now.toISOString() };
  const out: AssignResult = { signals: [], present: new Set(ids.map((id) => `voc:${id}:assign`)), baseline: next };
  if (!baseline || baseline.meId !== board.me.id) return out;
  const before = new Set(baseline.ids);
  for (const t of lane.tickets) {
    if (before.has(t.id)) continue;
    const mine = selfAssigned.get(t.id);
    if (mine !== undefined && now.getTime() - mine < SELF_ASSIGN_QUIET_MS) continue;
    out.signals.push({
      kind: 'vocAssign',
      family: `voc:${t.id}:assign`,
      key: `voc:${t.id}:assigned-me`,
      rank: 1,
      title: 'VOC 새 배정',
      body: `${t.number} · ${t.title}`,
      target: vocTarget(t),
      label: '새 배정',
    });
  }
  return out;
}

/** 아침 요약의 숫자(보류 제외 — 보류는 알림함에서 센다) */
export function morningCounts(
  snapshot: Snapshot | null,
  board: VocBoard | null,
  today: string,
): { dueToday: number; overdue: number; slaWarning: number; slaExceeded: number } {
  let dueToday = 0;
  let overdue = 0;
  if (snapshot) {
    dueToday = snapshot.tasks.filter((t) => t.source !== 'voc' && t.due === today).length;
    overdue = snapshot.counts.overdue;
  }
  let slaWarning = 0;
  let slaExceeded = 0;
  if (board && board.lanes.length > 0) {
    for (const t of watchedTickets(board)) {
      if (t.slaStatus === 'warning') slaWarning++;
      else if (t.slaStatus === 'exceeded') slaExceeded++;
    }
  }
  return { dueToday, overdue, slaWarning, slaExceeded };
}

/**
 * 아침 요약을 지금 보낼 때인가(§6-4): 업무일 · 지금 ≥ 요약 시각 · 지금 < 업무 끝 · 그날 아직 안 보냄 · 입력 준비됨.
 * 앱을 08:50 뒤에 켜면 켤 때, 업무 끝 뒤에 처음 켠 날은 보내지 않는다
 */
export function morningDue(input: {
  now: Date;
  isBusinessDay: boolean;
  morningTime: string;
  workEnd: string;
  lastMorning: string | null;
  ready: boolean;
}): boolean {
  const hm = hmOf(input.now);
  return (
    input.isBusinessDay &&
    hm >= input.morningTime &&
    hm < input.workEnd &&
    input.lastMorning !== ymdOf(input.now) &&
    input.ready
  );
}

/** 단계 키에서 VOC 티켓 id(voc:<id>:…). 아니면 null */
function vocIdOfKey(key: string): number | null {
  const m = /^voc:(\d+):/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * 미룬 항목의 출처가 아직 살아 있나(2.12단계 §3-2). 받지 못한 입력(스냅샷 없음·보드가 ok 아님)으로는 "끝났다"고 판정하지 않는다 — 모르면 참
 */
export function stillActive(
  item: { kind: string; key: string; target: string },
  snapshot: Snapshot | null,
  board: VocBoard | null,
): boolean {
  if (item.kind === 'due') {
    if (!snapshot) return true;
    return snapshot.tasks.some((t) => t.id === item.target && (t.status === 'open' || t.status === 'wip'));
  }
  if (item.kind === 'vocSla') {
    if (!board || board.state !== 'ok') return true;
    const id = vocIdOfKey(item.key);
    if (id === null) return true;
    return watchedTickets(board).some((t) => t.id === id && (t.slaStatus === 'warning' || t.slaStatus === 'exceeded'));
  }
  if (item.kind === 'vocAssign') {
    if (!board || board.state !== 'ok') return true;
    const lane = board.lanes.find((l) => l.me === true);
    const id = vocIdOfKey(item.key);
    if (!lane || id === null) return true;
    return lane.tickets.some((t) => t.id === id);
  }
  return true;
}
