// NotifyService(2.9단계 명세 §6·§7): 입력(스냅샷·VOC 보드·시계 tick)을 받아 규칙을 돌리고, 알림함(notifications.json)을 바꾸고,
// 내보낼 Windows 알림을 넘긴다. electron 없음 — Windows 알림·창 초점·시계는 index.ts 가 넣는다(단위 시험은 가짜를 넣는다).
//
// 한 번의 판정(tick):
//   ⓪ 미룬 항목 깨우기(2.12단계 §3-2) — 깰 시각이 된 것: 출처가 끝났으면 조용히 읽음, 「1시간 뒤」는 긴급 후보로,
//      「내일 아침」은 이번 판정의 아침 요약에 「나중에 N」으로 접는다(요약을 이미 보냈거나 끔·업무일 아님·업무 끝 뒤면 후보로)
//   ① 아침 요약(§6-4) — 업무일 · 요약 시각 뒤 · 업무 끝 전 · 그날 처음 · 입력 준비됨. 따로 한 장(하루 한도·묶음과 별개).
//      보류 중이면 항목만 만들고 묶음(pending.morningItemId)에 둔다
//   ② 긴급 신호(오늘 마감 · SLA · 새 배정) → 가족마다 더 나빠졌을 때만 항목(같은 가족의 미룬 옛 항목은 읽음 — 2.12 §3-3).
//      종류 설정(toast·inbox·off) → 업무 시간 밖(deferred) → 풀스크린 초점(알림함만) → 보류(2.12 §5) → 하루 한도(6) → 5분 묶음
//   ③ 5분 묶음·보류 내보내기 — 마지막 긴급 Windows 알림 뒤 5분(분 단위) 안이거나 보류 이유(전체 화면·발표 중·잠금·조용한 시간)가 있으면
//      모았다가 한 장으로(아침 요약과 긴급이 함께 모였으면 「보류한 알림 N건」)
import { QUIET_REASON_LABEL, SNOOZE_HOUR_MINUTES } from '../../shared/notify';
import type {
  Holiday,
  InboxState,
  NotifyItem,
  NotifyKind,
  NotifySettings,
  QuietReason,
  Snapshot,
  SnoozeKind,
  VocBoard,
} from '../../shared/types';
import { BusinessCalendar } from '../wiki/calendar';
import {
  DAILY_TOAST_LIMIT,
  bundleText,
  bundleWindowPassed,
  dropVanished,
  heldText,
  hmOf,
  isWorkTime,
  isWorse,
  limitReached,
  minuteOf,
  morningText,
  morningTotalOf,
  nextMorning,
  todayToastCount,
  ymdOf,
  type BundleLabel,
  type UrgentSignal,
} from './rules';
import { quietReasonOf } from './quiet';
import type { QunsProbe } from './qunsProbe';
import { assignSignals, dueSignals, morningCounts, morningDue, slaSignals, stillActive } from './signals';
import { emptyNotifyState, newItemId, pruneNotifyState, type NotifyState, type StoredItem } from './store';

/** 알림함으로 보내는 최대 항목 수(새것부터) */
export const INBOX_SEND_LIMIT = 200;
/** VOC 보드가 아직 loading 이어도 아침 요약을 보내는 때(앱을 켠 뒤) */
const MORNING_BOARD_WAIT_MS = 60_000;
/** 계속 보이는 가족의 시각을 갱신하는 간격(30일 정리용 — 매 tick 파일을 쓰지 않게) */
const FAMILY_TOUCH_MS = 3_600_000;

/** 내보낼 Windows 알림 한 장 */
export interface ToastRequest {
  title: string;
  body: string;
  /** 누르면 갈 곳(setMode 의 focus 글자) */
  target: string;
  kinds: NotifyKind[];
  keys: string[];
  /** 누르면 읽음으로 바꿀 항목 */
  itemIds: string[];
  /** 긴급이 들어 있다 — [열기]·[1시간 뒤] 단추를 둔다(2.12단계 §3-5). 아침 요약만이면 거짓 */
  snoozable: boolean;
  /** 소리 없음(설정 › 알림 「소리」의 반대) */
  silent: boolean;
}

export interface NotifyStoreLike {
  load(now: Date): NotifyState;
  save(state: NotifyState, now: Date): void;
}

export interface NotifyServiceOptions {
  store: NotifyStoreLike;
  now: () => Date;
  settings: () => NotifySettings;
  holidays: readonly Holiday[];
  /** toast Windows 알림 · log 시험 기록 · unsupported 보낼 수 없음(알림함에만) */
  toastMode: InboxState['toastMode'];
  /** Windows 알림을 보낸다. 보냈으면 참 */
  toast: (req: ToastRequest) => boolean;
  /** 풀스크린 창이 앞에 있고 초점이 있는가 */
  isFullFocused: () => boolean;
  /** 알림함이 바뀔 때마다 */
  onInbox: (inbox: InboxState) => void;
  log?: (message: string) => void;
  /** 전체 화면·발표 중 감지(2.12단계 §4-2). 없으면 QUNS 를 보지 않는다(설정 조용한 시간만) */
  probe?: QunsProbe;
}

const LABEL_OF_KEY: readonly [RegExp, BundleLabel][] = [
  [/:sla-exceeded$/, 'SLA 초과'],
  [/:sla-warning$/, 'SLA 임박'],
  [/:due-today$/, '오늘 마감'],
  [/:assigned-me$/, '새 배정'],
];

function labelOf(item: Pick<NotifyItem, 'key'>): BundleLabel {
  return LABEL_OF_KEY.find(([re]) => re.test(item.key))?.[1] ?? '새 배정';
}

/** 저장 항목 → 알림함 항목(가족 키·다시 알린 시각을 빼고 「다시 알림」 꼬리표를 계산한다) */
function publicItem(item: StoredItem): NotifyItem {
  const { family: _family, remindedAt, ...rest } = item;
  return { ...rest, reminded: remindedAt !== null && item.readAt === null };
}

/** 안 읽음으로 보이는가(미룬 것은 빼고 — 2.12단계 §3-1) */
function isVisibleUnread(i: StoredItem): boolean {
  return i.readAt === null && i.snoozeUntil === null;
}

function clearSnooze(i: StoredItem): void {
  i.snoozeUntil = null;
  i.snooze = null;
}

/** 서비스가 없을 때(시험 모드에서 꺼짐)의 빈 알림함 */
export function emptyInbox(toastMode: InboxState['toastMode'], hideContent = false): InboxState {
  return {
    items: [],
    unread: 0,
    unreadUrgent: 0,
    todayToasts: 0,
    dailyLimit: DAILY_TOAST_LIMIT,
    toastMode,
    hideContent,
    snoozed: 0,
    held: null,
  };
}

interface TickCtx {
  now: Date;
  nowIso: string;
  today: string;
  work: boolean;
  focused: boolean;
  canToast: boolean;
  settings: NotifySettings;
  /** 지금 보류 이유(판정마다 최대 한 번 읽는다 — 보낼 것이 있을 때만) */
  quiet: () => QuietReason | null;
}

export class NotifyService {
  private state: NotifyState | null = null;
  private snapshot: Snapshot | null = null;
  private snapshotMissing = false;
  private board: VocBoard | null = null;
  private readonly selfAssigned = new Map<number, number>();
  private readonly startedAt: number;
  private readonly cal: BusinessCalendar;
  private running = false;
  private lastSent = '';

  constructor(private readonly opts: NotifyServiceOptions) {
    this.startedAt = opts.now().getTime();
    this.cal = new BusinessCalendar(opts.holidays);
  }

  /**
   * 알림 기록. 읽지 못하면(잠김 등) null — 빈 상태로 판정·저장하면 원래 파일을 덮어써 같은 알림이 다시 나가므로
   * 그동안은 판정·저장을 하지 않고 다음 tick(1분마다)에서 다시 읽는다.
   */
  private load(now: Date): NotifyState | null {
    if (!this.state) {
      try {
        this.state = this.opts.store.load(now);
      } catch (err) {
        this.opts.log?.(`알림 기록을 읽지 못해 이번 판정은 건너뜀(다음에 다시 읽음): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }
    return this.state;
  }

  private save(state: NotifyState, now: Date): void {
    try {
      this.opts.store.save(state, now);
    } catch (err) {
      this.opts.log?.(`알림 기록을 저장하지 못함: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private safeSettings(): NotifySettings | null {
    try {
      return this.opts.settings();
    } catch {
      return null;
    }
  }

  /** 새 스냅샷(개인 위키 + 내 VOC + 팀 위키 내 것) */
  setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.snapshotMissing = false;
    this.tick();
  }

  /** 개인·팀 위키가 없어 스냅샷을 만들 수 없음이 확인됨(아침 요약은 VOC 숫자만으로 보낸다). 이미 스냅샷이 있으면 그대로 */
  noteSnapshotMissing(): void {
    if (this.snapshot) return;
    this.snapshotMissing = true;
    this.tick();
  }

  setBoard(board: VocBoard): void {
    this.board = board;
    this.tick();
  }

  /** 내가 앱에서 나에게 배정한 티켓 — 10분 동안 새 배정 신호에서 뺀다 */
  noteSelfAssign(ticketId: number): void {
    this.selfAssigned.set(ticketId, this.opts.now().getTime());
  }

  /** 판정 한 번. 한 번에 하나(재진입 없음) */
  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.run();
    } catch (err) {
      this.opts.log?.(`알림 판정 오류: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** 지금 보류 이유: 설정 조용한 시간 → (quietHold 면) QUNS. 설정 조용한 시간이면 probe 를 부르지 않는다 */
  private quietNow(now: Date, settings: NotifySettings): QuietReason | null {
    const user = quietReasonOf(null, now, { ...settings, quietHold: false });
    if (user) return user;
    if (!settings.quietHold || !this.opts.probe) return null;
    try {
      const r = this.opts.probe.read();
      if (!r.available) return null;
      return quietReasonOf(r.quns, now, settings);
    } catch (err) {
      this.opts.log?.(`알림: 전체 화면 감지 오류 — 그대로 보냄: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private run(): void {
    const now = this.opts.now();
    const nowIso = now.toISOString();
    const today = ymdOf(now);
    const st = this.load(now);
    if (!st) return;
    const before = JSON.stringify(st);
    pruneNotifyState(st, now);
    const settings = this.opts.settings();
    const work = isWorkTime(now, settings, this.cal);
    const focused = this.safeFocused();
    const created: StoredItem[] = [];
    const canToast = this.opts.toastMode !== 'unsupported';
    let quietCache: { reason: QuietReason | null } | null = null;
    const ctx: TickCtx = {
      now,
      nowIso,
      today,
      work,
      focused,
      canToast,
      settings,
      quiet: () => (quietCache ??= { reason: this.quietNow(now, settings) }).reason,
    };

    for (const [id, at] of this.selfAssigned) {
      if (now.getTime() - at > 3_600_000) this.selfAssigned.delete(id);
    }

    const boardReady = !!this.board && this.board.state !== 'loading';
    const ready =
      (this.snapshot !== null || this.snapshotMissing) && (boardReady || now.getTime() - this.startedAt >= MORNING_BOARD_WAIT_MS);
    const morningNow = morningDue({
      now,
      isBusinessDay: this.cal.isBusinessDay(today),
      morningTime: settings.morningTime,
      workEnd: settings.workEnd,
      lastMorning: st.morning,
      ready,
    });

    // ⓪ 미룬 항목 깨우기(2.12단계 §3-2)
    const candidates: string[] = [];
    let foldedMorning = 0;
    /** 이번 판정에서 아침 요약의 「나중에」로 접은 항목 — 「보류」로 또 세지 않는다 */
    const foldedIds = new Set<string>();
    const nowMinute = minuteOf(now);
    for (const item of st.items) {
      if (item.snoozeUntil === null) continue;
      if (item.readAt !== null) {
        clearSnooze(item);
        continue;
      }
      const until = new Date(item.snoozeUntil);
      if (!Number.isNaN(until.getTime()) && nowMinute < minuteOf(until)) continue;
      if (!stillActive(item, this.snapshot, this.board)) {
        // 끝난 일 — 조용히 정리(Windows 알림 없음)
        clearSnooze(item);
        item.readAt = nowIso;
        continue;
      }
      if (item.snooze === 'morning') {
        // 업무 끝 뒤면 오늘 아침 요약은 더는 나갈 수 없다 — 기다리지 않고 후보로(route 가 업무 시간 밖이라 deferred 로 둔다)
        const fallback =
          st.morning === today || settings.kinds.morning === 'off' || !this.cal.isBusinessDay(today) || hmOf(now) >= settings.workEnd;
        if (!fallback) {
          // 이번 판정에서 아침 요약을 만들면 그 숫자에 「나중에 N」으로(따로 Windows 알림 없음). 아니면 다음 판정까지 둔다
          if (morningNow) {
            this.wake(item, nowIso);
            foldedMorning++;
            foldedIds.add(item.id);
          }
          continue;
        }
      }
      this.wake(item, nowIso);
      this.route(item, ctx, candidates);
    }

    // ① 아침 요약
    if (morningNow) {
      st.morning = today;
      const family = `morning:${today}`;
      st.families[family] = { rank: 1, at: nowIso };
      const mode = settings.kinds.morning;
      if (mode !== 'off') {
        const counts = morningCounts(this.snapshot, this.board, today);
        const numbers = { ...counts, deferred: this.deferredSinceLastMorning(st, foldedIds), snoozed: foldedMorning };
        const full = morningText(numbers, false);
        const item = this.makeItem({
          key: family,
          family,
          kind: 'morning',
          grade: 'today',
          title: full.title,
          body: full.body,
          target: 'view:tasks',
          createdAt: nowIso,
        });
        created.push(item);
        if (mode === 'toast' && !full.quiet && work && !focused && canToast) {
          const reason = ctx.quiet();
          if (reason) {
            // 보류 — 항목은 만들고 풀리면 같이 보낸다(§5-1)
            const prev = st.pending;
            st.pending = {
              itemIds: prev?.itemIds ?? [],
              since: prev?.since ?? nowIso,
              held: prev?.held ?? { reason, since: nowIso },
              morningItemId: item.id,
            };
          } else {
            const text = morningText(numbers, settings.hideContent);
            const req: ToastRequest = {
              title: text.title,
              body: text.body,
              target: item.target,
              kinds: ['morning'],
              keys: [item.key],
              itemIds: [item.id],
              snoozable: false,
              silent: !settings.sound,
            };
            if (this.safeToast(req)) item.toastAt = nowIso;
          }
        }
      }
    }

    // ② 긴급 신호
    const signals: UrgentSignal[] = [];
    if (this.snapshot) {
      const due = dueSignals(this.snapshot, now);
      if (due) {
        dropVanished(st.families, new Set(['due']), due.present, today);
        signals.push(...due.signals);
      }
    }
    if (this.board && this.board.state === 'ok') {
      const sla = slaSignals(this.board);
      dropVanished(st.families, new Set(['vocSla']), sla.present, today);
      signals.push(...sla.signals);
      const assign = assignSignals(this.board, st.vocMine, this.selfAssigned, now);
      if (assign) {
        const base = assign.baseline;
        if (base && (!st.vocMine || st.vocMine.meId !== base.meId || st.vocMine.ids.join(',') !== base.ids.join(','))) {
          st.vocMine = base;
        }
        dropVanished(st.families, new Set(['vocAssign']), assign.present, today);
        signals.push(...assign.signals);
      }
    }

    for (const s of signals) {
      if (!isWorse(st.families, s)) {
        const rec = st.families[s.family];
        if (rec && now.getTime() - Date.parse(rec.at) >= FAMILY_TOUCH_MS) rec.at = nowIso;
        continue;
      }
      // 끄거나 보류한 신호도 가족은 기록한다(다시 켜도 옛 신호를 쏟지 않게 — §6-1)
      st.families[s.family] = { rank: s.rank, at: nowIso };
      const mode = settings.kinds[s.kind];
      if (mode === 'off') continue;
      // 같은 가족의 미룬 옛 항목은 새 항목이 대신한다(2.12단계 §3-3 — 나중에 옛 단계로 또 깨지 않게)
      for (const old of st.items) {
        if (old.family === s.family && old.snoozeUntil !== null) {
          clearSnooze(old);
          if (old.readAt === null) old.readAt = nowIso;
        }
      }
      const item = this.makeItem({
        key: s.key,
        family: s.family,
        kind: s.kind,
        grade: 'urgent',
        title: s.title,
        body: s.body,
        target: s.target,
        createdAt: nowIso,
      });
      created.push(item);
      this.route(item, ctx, candidates);
    }
    st.items.push(...created);

    // ③ 5분 묶음·보류 내보내기
    this.flush(st, candidates, ctx);

    if (JSON.stringify(st) !== before) this.save(st, now);
    this.emit(st, now, settings);
  }

  /** 미룬 항목을 깨운다(안 읽음으로 다시 보인다 — 「다시 알림」) */
  private wake(item: StoredItem, nowIso: string): void {
    clearSnooze(item);
    item.remindedAt = nowIso;
    item.toastAt = null;
  }

  /** 긴급 항목의 Windows 알림 여부(2.9 §6-2): 종류 설정 → 업무 시간 밖(deferred) → 풀스크린 초점·못 보냄 → 후보 */
  private route(item: StoredItem, ctx: TickCtx, candidates: string[]): void {
    if (ctx.settings.kinds[item.kind] !== 'toast') return;
    if (!ctx.work) {
      item.deferred = true;
      return;
    }
    if (ctx.focused || !ctx.canToast) return;
    candidates.push(item.id);
  }

  /**
   * 묶음·보류 내보내기. (보류 중 업무 끝 → deferred·요약 버림) → 보류 이유 있음 → 모아 둠 → 하루 한도(긴급만) → 5분 창 →
   * 업무 시간 밖 → 초점 → 보냄
   */
  private flush(st: NotifyState, candidates: string[], ctx: TickCtx): void {
    const pending = st.pending;
    const ids = [...new Set([...(pending?.itemIds ?? []), ...candidates])];
    const byId = new Map(st.items.map((i) => [i.id, i] as const));
    const kinds = ctx.settings.kinds;
    const items = ids
      .map((id) => byId.get(id))
      .filter((i): i is StoredItem => !!i && isVisibleUnread(i) && i.toastAt === null)
      // 보내는 때 §6-2 순서를 다시 본다 — ① 종류 설정: 모아 두는 사이 알림함만·끔으로 바꾼 종류는 Windows 알림으로 내지 않는다(항목은 알림함에 남음)
      .filter((i) => kinds[i.kind] === 'toast');
    let morning = pending?.morningItemId ? byId.get(pending.morningItemId) : undefined;
    if (morning && (morning.readAt !== null || morning.toastAt !== null || kinds.morning !== 'toast')) morning = undefined;
    const wasHeld = pending?.held;
    if (items.length === 0 && !morning) {
      st.pending = null;
      return;
    }
    if (!ctx.work && (wasHeld || morning)) {
      // 보류 중 업무 시간이 끝났다 — 긴급은 다음 아침 요약의 「보류 N」, 아침 요약 Windows 알림은 버린다(항목은 알림함에 있다)
      for (const i of items) i.deferred = true;
      st.pending = null;
      return;
    }
    const reason = ctx.quiet();
    if (reason) {
      st.pending = {
        itemIds: items.map((i) => i.id),
        since: pending?.since ?? ctx.nowIso,
        held: { reason, since: wasHeld?.since ?? ctx.nowIso },
        ...(morning ? { morningItemId: morning.id } : {}),
      };
      return;
    }
    let urgent = items;
    const sent = todayToastCount(st.toasts, ctx.today, (iso) => ymdOf(new Date(iso)));
    // 하루 한도 — 긴급은 알림함에만(보류 요약이면 아침 요약 부분만 보낸다)
    if (limitReached(sent)) urgent = [];
    if (urgent.length === 0 && !morning) {
      st.pending = null;
      return;
    }
    if (urgent.length > 0 && !bundleWindowPassed(st.lastToastAt, ctx.now)) {
      st.pending = {
        itemIds: urgent.map((i) => i.id),
        since: pending?.since ?? ctx.nowIso,
        ...(morning ? { morningItemId: morning.id } : {}),
      };
      return;
    }
    st.pending = null;
    if (!ctx.work) {
      // 모아 둔 사이 업무 시간이 끝났다 — 다음 아침 요약으로
      for (const i of urgent) i.deferred = true;
      return;
    }
    if (ctx.focused) return;
    const signals = urgent.map((i) => ({ kind: i.kind as UrgentSignal['kind'], label: labelOf(i), title: i.title, body: i.body }));
    const hide = ctx.settings.hideContent;
    let text: { title: string; body: string };
    let target: string;
    if (morning && urgent.length > 0) {
      text = heldText(morning, signals, hide);
      target = 'view:inbox';
    } else if (morning) {
      text = { title: morning.title, body: hide ? `${morningTotalOf(morning.body)}건` : morning.body };
      target = morning.target;
    } else {
      text = bundleText(signals, hide);
      target = urgent.length === 1 ? urgent[0].target : 'view:inbox';
    }
    const all = morning ? [morning, ...urgent] : urgent;
    const req: ToastRequest = {
      ...text,
      target,
      kinds: [...new Set(all.map((i) => i.kind))],
      keys: all.map((i) => i.key),
      itemIds: all.map((i) => i.id),
      snoozable: urgent.length > 0,
      silent: !ctx.settings.sound,
    };
    if (this.safeToast(req)) {
      for (const i of all) i.toastAt = ctx.nowIso;
      if (urgent.length > 0) {
        // 긴급이 섞인 보류 요약도 하루 한도에 1로 센다
        st.toasts.push(ctx.nowIso);
        st.lastToastAt = ctx.nowIso;
      }
    }
  }

  /**
   * 지난 아침 요약 뒤 보류(deferred) 항목 수. 이번 요약의 「나중에」로 접은 항목(exclude)과 아직 미룬 항목은 뺀다
   * — 한 항목을 「보류」와 「나중에」로 두 번 세지 않게(2.12단계 §3-4)
   */
  private deferredSinceLastMorning(st: NotifyState, exclude: ReadonlySet<string>): number {
    const lastMorning = st.items
      .filter((i) => i.kind === 'morning')
      .reduce<number>((m, i) => Math.max(m, Date.parse(i.createdAt)), Number.NEGATIVE_INFINITY);
    return st.items.filter(
      (i) => i.deferred && Date.parse(i.createdAt) > lastMorning && !exclude.has(i.id) && i.snoozeUntil === null,
    ).length;
  }

  private makeItem(
    fields: Omit<StoredItem, 'id' | 'readAt' | 'toastAt' | 'deferred' | 'snoozeUntil' | 'snooze' | 'remindedAt'>,
  ): StoredItem {
    return { id: newItemId(), readAt: null, toastAt: null, deferred: false, snoozeUntil: null, snooze: null, remindedAt: null, ...fields };
  }

  private safeToast(req: ToastRequest): boolean {
    try {
      return this.opts.toast(req);
    } catch (err) {
      this.opts.log?.(`Windows 알림을 보내지 못함: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private safeFocused(): boolean {
    try {
      return this.opts.isFullFocused();
    } catch {
      return false;
    }
  }

  /** 알림함 상태 */
  inbox(): InboxState {
    const now = this.opts.now();
    return this.inboxOf(this.load(now) ?? emptyNotifyState(), now, this.safeSettings());
  }

  private inboxOf(st: NotifyState, now: Date, settings: NotifySettings | null): InboxState {
    const today = ymdOf(now);
    const sorted = [...st.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const p = st.pending;
    const held = p?.held
      ? {
          reason: p.held.reason,
          label: QUIET_REASON_LABEL[p.held.reason],
          count: p.itemIds.length + (p.morningItemId ? 1 : 0),
          since: p.held.since,
        }
      : null;
    return {
      items: sorted.slice(0, INBOX_SEND_LIMIT).map(publicItem),
      unread: st.items.filter(isVisibleUnread).length,
      // 오늘 생겼거나 오늘 다시 알린(「내일 아침」·「1시간 뒤」에서 깨운) 안 읽은 긴급 — 트레이·오버레이·사이드바 띠가 종 배지와 어긋나지 않게
      unreadUrgent: st.items.filter(
        (i) =>
          isVisibleUnread(i) &&
          i.grade === 'urgent' &&
          (ymdOf(new Date(i.createdAt)) === today || (i.remindedAt !== null && ymdOf(new Date(i.remindedAt)) === today)),
      ).length,
      todayToasts: todayToastCount(st.toasts, today, (iso) => ymdOf(new Date(iso))),
      dailyLimit: DAILY_TOAST_LIMIT,
      toastMode: this.opts.toastMode,
      hideContent: settings?.hideContent ?? false,
      snoozed: st.items.filter((i) => i.readAt === null && i.snoozeUntil !== null).length,
      held,
      nextMorningAt: nextMorning(now, settings?.morningTime ?? '08:50', this.cal).toISOString(),
    };
  }

  /** 바뀌었을 때만 보낸다 */
  private emit(st: NotifyState, now: Date, settings: NotifySettings | null): void {
    const inbox = this.inboxOf(st, now, settings);
    const sig = JSON.stringify(inbox);
    if (sig === this.lastSent) return;
    this.lastSent = sig;
    try {
      this.opts.onInbox(inbox);
    } catch (err) {
      this.opts.log?.(`알림함을 보내지 못함: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 읽음으로 바꾼다('all' 이면 전부). 미룸도 지운다(2.12단계 §3-1) */
  markRead(ids: 'all' | readonly string[]): InboxState {
    const now = this.opts.now();
    const st = this.load(now);
    if (!st) return this.inbox();
    const want = ids === 'all' ? null : new Set(ids);
    let changed = false;
    for (const i of st.items) {
      if (i.readAt !== null) continue;
      if (want && !want.has(i.id)) continue;
      i.readAt = now.toISOString();
      clearSnooze(i);
      changed = true;
    }
    if (changed) this.save(st, now);
    const settings = this.safeSettings();
    this.emit(st, now, settings);
    return this.inboxOf(st, now, settings);
  }

  /**
   * [나중에](2.12단계 §3-1): 긴급·안 읽은 항목만 미룬다(그 밖의 id 는 건너뛴다 — 오류 아님). 이미 미룬 것은 새 시각으로.
   * 모아 둔 묶음에서 뺀다(지금 Windows 알림으로 나가지 않게)
   */
  snooze(ids: readonly string[], kind: SnoozeKind): InboxState {
    const now = this.opts.now();
    const st = this.load(now);
    if (!st) return this.inbox();
    const settings = this.safeSettings();
    const until =
      kind === '1h'
        ? new Date(now.getTime() + SNOOZE_HOUR_MINUTES * 60_000)
        : nextMorning(now, settings?.morningTime ?? '08:50', this.cal);
    const want = new Set(ids);
    const done = new Set<string>();
    for (const i of st.items) {
      if (!want.has(i.id) || i.grade !== 'urgent' || i.kind === 'morning' || i.readAt !== null) continue;
      i.snoozeUntil = until.toISOString();
      i.snooze = kind;
      done.add(i.id);
    }
    if (done.size > 0) {
      if (st.pending) {
        const rest = st.pending.itemIds.filter((id) => !done.has(id));
        st.pending = rest.length > 0 || st.pending.morningItemId ? { ...st.pending, itemIds: rest } : null;
      }
      this.save(st, now);
    }
    this.emit(st, now, settings);
    return this.inboxOf(st, now, settings);
  }

  /** 항목을 연다: 읽음으로 바꾸고 그 대상을 돌려준다(없는 id 면 null) */
  open(id: string): string | null {
    const st = this.load(this.opts.now());
    const item = st?.items.find((i) => i.id === id);
    if (!item) return null;
    this.markRead([id]);
    return item.target;
  }

  /** Windows 가 알림을 표시하지 못했다(Notification failed — 2.12단계 §1-4·§6-2) */
  noteToastFailure(): void {
    const now = this.opts.now();
    const st = this.load(now);
    if (!st) return;
    st.toastFailures.push(now.toISOString());
    this.save(st, now);
  }

  /** 오늘 Windows 알림 실패의 마지막 시각(ISO). 없으면 null */
  lastToastFailure(): string | null {
    const now = this.opts.now();
    const st = this.load(now);
    if (!st) return null;
    const today = ymdOf(now);
    const todays = st.toastFailures.filter((iso) => ymdOf(new Date(iso)) === today).sort();
    return todays.length > 0 ? todays[todays.length - 1] : null;
  }

  /** 설정이 바뀌었을 때 — 판정을 다시 돌리고 알림함(내용 숨김)을 보낸다 */
  refresh(): void {
    this.tick();
  }
}
