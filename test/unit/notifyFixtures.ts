// 알림 N1 단위 시험 공용 도구(2.9단계 §12-2): 가짜 시계·가짜 저장소·스냅샷·VOC 보드 만들기. electron 없음.
import { loadConfig, parseLocalDateTime } from '../../src/main/config';
import { NotifyService, type ToastRequest } from '../../src/main/notify/service';
import { emptyNotifyState, type NotifyState } from '../../src/main/notify/store';
import { defaultNotifySettings } from '../../src/shared/notify';
import type { InboxState, NotifySettings, Snapshot, Task, VocBoard, VocLane, VocTicket } from '../../src/shared/types';

/** config/holidays-kr.json(9/24~26 추석) */
export const HOLIDAYS = loadConfig({}).holidays;

export function at(text: string): Date {
  const d = parseLocalDateTime(text);
  if (!d) throw new Error(`시각이 아님: ${text}`);
  return d;
}

export function task(over: Partial<Task> & { id: string }): Task {
  return { source: 'checkbox', title: `할 일 ${over.id}`, status: 'open', bucket: 'other', ...over };
}

export function snapshot(today: string, tasks: Task[], overdue = 0): Snapshot {
  return {
    generatedAt: `${today}T00:00:00.000Z`,
    wikiRoot: '/wiki',
    week: { today } as Snapshot['week'],
    tasks,
    counts: { overdue, thisWeek: 0, chased: 0, stale: 0, other: 0 },
    pageCount: 0,
    warnings: [],
    partial: false,
  };
}

export function ticket(id: number, over: Partial<VocTicket> = {}): VocTicket {
  return {
    id,
    number: `VOC-2026-${String(id).padStart(4, '0')}`,
    title: `티켓 ${id}`,
    status: 'in_progress',
    createdAt: '2026-09-20T00:00:00Z',
    text: '',
    ageDays: 1,
    ageBusinessDays: 1,
    ...over,
  };
}

function lane(key: string, tickets: VocTicket[], me = false): VocLane {
  return {
    key,
    label: key,
    ...(me ? { me: true } : {}),
    tickets,
    summary: { total: tickets.length, slaExceeded: 0, slaWarning: 0, p1: 0 },
  };
}

/** 미배정 · 나(101) · 다른 사람(102) 칸 */
export function board(
  parts: { unassigned?: VocTicket[]; mine?: VocTicket[]; other?: VocTicket[] },
  over: Partial<VocBoard> = {},
): VocBoard {
  return {
    state: 'ok',
    fetchedAt: '2026-09-23T00:00:00Z',
    lanes: [lane('unassigned', parts.unassigned ?? []), lane('user:101', parts.mine ?? [], true), lane('user:102', parts.other ?? [])],
    totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 },
    me: { id: 101, name: '홍길동' },
    ...over,
  };
}

/** 가짜 시계·저장소·Windows 알림으로 만든 NotifyService */
export function harness(start = '2026-09-23T09:10', opts: { toastMode?: InboxState['toastMode'] } = {}) {
  const h = {
    now: at(start),
    saved: null as NotifyState | null,
    saves: 0,
    toasts: [] as ToastRequest[],
    inboxes: [] as InboxState[],
    focused: false,
    settings: defaultNotifySettings() as NotifySettings,
    service: null as unknown as NotifyService,
    /** 가짜 QUNS(2.12단계) — 5 받을 수 있음 · 2 전체 화면 · 4 발표 중 … · null 실패. available 거짓이면 감지 없음 */
    quns: 5 as number | null,
    probeAvailable: true,
    probeCalls: 0,
    /** 시계를 옮기고 판정 */
    tickAt(text: string): void {
      h.now = at(text);
      h.service.tick();
    },
    lastInbox(): InboxState {
      return h.service.inbox();
    },
  };
  h.service = new NotifyService({
    store: {
      load: () => (h.saved ? structuredClone(h.saved) : emptyNotifyState()),
      save: (s) => {
        h.saves++;
        h.saved = structuredClone(s);
      },
    },
    now: () => new Date(h.now.getTime()),
    settings: () => h.settings,
    holidays: HOLIDAYS,
    toastMode: opts.toastMode ?? 'log',
    toast: (req) => {
      h.toasts.push(req);
      return true;
    },
    isFullFocused: () => h.focused,
    onInbox: (i) => h.inboxes.push(i),
    probe: {
      read: () => {
        h.probeCalls++;
        return h.probeAvailable ? { available: true, quns: h.quns } : { available: false, problem: '시험' };
      },
    },
  });
  return h;
}
