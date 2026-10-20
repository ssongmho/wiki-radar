// notifications.json(2.9단계 명세 §7-1): 알림함 항목·중복 제거 가족·아침 요약 날짜·Windows 알림 기록·묶음 보류·VOC 배정 기준.
// 원자적 쓰기(queue.ts writeJsonAtomic). 깨진 파일은 `.broken-<시각>` 으로 옮기고 빈 상태로 시작한다. 시험 모드의 Windows 알림 기록(notify-log.jsonl)도 여기.
// 2.12단계 §7-1: version 2 — 항목의 미룸(snoozeUntil·snooze·remindedAt), 보류 묶음의 held·morningItemId, Windows 알림 실패 기록(toastFailures).
// v1 파일은 그대로 읽고(새 칸 없음 = 미룬 것·보류 없음), 언제나 v2 로 쓴다. 옛 앱이 v2 를 읽으면 새 칸을 버릴 뿐 깨지지 않는다.
// electron 없음.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NotifyGrade, NotifyItem, NotifyKind, QuietReason, SnoozeKind } from '../../shared/types';
import { compactStamp, writeJsonAtomic } from '../queue';
import { errCode, readTextFile } from '../wiki/fsutil';
import type { FamilyRecord } from './rules';
import type { VocMineBaseline } from './signals';

export const NOTIFY_FILE = 'notifications.json';
export const NOTIFY_LOG_FILE = 'notify-log.jsonl';

/** 항목·가족을 지우는 나이(일) */
export const NOTIFY_MAX_AGE_DAYS = 30;
/** 항목 최대 수(오래된 것부터 지운다) */
export const NOTIFY_MAX_ITEMS = 500;
/** Windows 알림 기록은 최근 2일만 */
const TOAST_KEEP_MS = 2 * 86_400_000;
const DAY_MS = 86_400_000;

/** 파일의 항목 = 알림함 항목(reminded 는 계산 값이라 빼고) + 가족 키 + 다시 알린 시각 */
export interface StoredItem extends Omit<NotifyItem, 'reminded'> {
  family: string;
  /** 미뤘다가 깨워 다시 알린 시각(ISO). 없으면 null */
  remindedAt: string | null;
}

/** 모아 둔 Windows 알림(5분 묶음 · 보류) */
export interface PendingBundle {
  itemIds: string[];
  since: string;
  /** 보류 중이면 그 이유와 시작 시각(2.12단계 §5-1) */
  held?: { reason: QuietReason; since: string };
  /** 보류 중에 만든 아침 요약 항목(풀리면 같이 보낸다) */
  morningItemId?: string;
}

export interface NotifyState {
  version: 2;
  items: StoredItem[];
  families: Record<string, FamilyRecord>;
  /** 아침 요약을 보낸 날(YYYY-MM-DD) */
  morning: string | null;
  /** 보낸 긴급 Windows 알림 시각(ISO) — 하루 한도 */
  toasts: string[];
  lastToastAt: string | null;
  /** 5분 묶음·보류로 모아 둔 것 */
  pending: PendingBundle | null;
  vocMine: VocMineBaseline | null;
  /** Windows 가 알림을 표시하지 못한 시각(ISO) — 최근 2일(2.12단계 §1-4·§6-2) */
  toastFailures: string[];
}

export function emptyNotifyState(): NotifyState {
  return {
    version: 2,
    items: [],
    families: {},
    morning: null,
    toasts: [],
    lastToastAt: null,
    pending: null,
    vocMine: null,
    toastFailures: [],
  };
}

const SNOOZE_KINDS: ReadonlySet<string> = new Set<SnoozeKind>(['1h', 'morning']);
const QUIET_REASONS: ReadonlySet<string> = new Set<QuietReason>(['away', 'fullscreen', 'presentation', 'windowsQuiet', 'userQuiet']);

const KINDS: ReadonlySet<string> = new Set<NotifyKind>(['due', 'vocSla', 'vocAssign', 'morning']);
const GRADES: ReadonlySet<string> = new Set<NotifyGrade>(['urgent', 'today']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));

function itemOf(raw: unknown): StoredItem | null {
  if (!isObject(raw)) return null;
  const r = raw;
  if (!isStr(r.id) || !/^n_[A-Za-z0-9]{1,32}$/.test(r.id)) return null;
  if (!isStr(r.key) || !isStr(r.kind) || !KINDS.has(r.kind) || !isStr(r.grade) || !GRADES.has(r.grade)) return null;
  if (!isStr(r.title) || !isStr(r.body) || !isStr(r.target) || !isIso(r.createdAt)) return null;
  return {
    id: r.id,
    key: r.key,
    kind: r.kind as NotifyKind,
    grade: r.grade as NotifyGrade,
    title: r.title,
    body: r.body,
    target: r.target,
    createdAt: r.createdAt,
    readAt: isIso(r.readAt) ? r.readAt : null,
    toastAt: isIso(r.toastAt) ? r.toastAt : null,
    deferred: r.deferred === true,
    family: isStr(r.family) ? r.family : r.key,
    ...snoozeOf(r),
    remindedAt: isIso(r.remindedAt) ? r.remindedAt : null,
  };
}

/** 미룸 두 칸 — 하나라도 틀리면 둘 다 버린다(§7-1) */
function snoozeOf(r: Record<string, unknown>): { snoozeUntil: string | null; snooze: SnoozeKind | null } {
  if (isStr(r.snooze) && SNOOZE_KINDS.has(r.snooze) && isIso(r.snoozeUntil)) return { snoozeUntil: r.snoozeUntil, snooze: r.snooze as SnoozeKind };
  return { snoozeUntil: null, snooze: null };
}

/** 파일 내용 → 상태. 모양이 틀린 칸·항목은 버린다 */
export function normalizeNotifyState(raw: unknown): NotifyState {
  const out = emptyNotifyState();
  if (!isObject(raw)) return out;
  if (Array.isArray(raw.items)) {
    for (const r of raw.items) {
      const item = itemOf(r);
      if (item) out.items.push(item);
    }
  }
  if (isObject(raw.families)) {
    for (const [k, v] of Object.entries(raw.families)) {
      if (isObject(v) && typeof v.rank === 'number' && Number.isFinite(v.rank) && isIso(v.at)) out.families[k] = { rank: v.rank, at: v.at };
    }
  }
  if (isStr(raw.morning) && /^\d{4}-\d{2}-\d{2}$/.test(raw.morning)) out.morning = raw.morning;
  if (Array.isArray(raw.toasts)) out.toasts = raw.toasts.filter(isIso);
  if (isIso(raw.lastToastAt)) out.lastToastAt = raw.lastToastAt;
  if (isObject(raw.pending) && isIso(raw.pending.since)) {
    const p = raw.pending;
    const ids = Array.isArray(p.itemIds) ? p.itemIds.filter(isStr) : [];
    const morningItemId = isStr(p.morningItemId) && p.morningItemId !== '' ? p.morningItemId : undefined;
    if (ids.length > 0 || morningItemId) {
      const pending: PendingBundle = { itemIds: ids, since: p.since as string };
      if (isObject(p.held) && isStr(p.held.reason) && QUIET_REASONS.has(p.held.reason) && isIso(p.held.since)) {
        pending.held = { reason: p.held.reason as QuietReason, since: p.held.since };
      }
      if (morningItemId) pending.morningItemId = morningItemId;
      out.pending = pending;
    }
  }
  if (Array.isArray(raw.toastFailures)) out.toastFailures = raw.toastFailures.filter(isIso);
  const vm = raw.vocMine;
  if (isObject(vm) && typeof vm.meId === 'number' && Array.isArray(vm.ids) && isIso(vm.at)) {
    out.vocMine = { meId: vm.meId, ids: vm.ids.filter((n): n is number => typeof n === 'number'), at: vm.at };
  }
  return out;
}

/**
 * 오래된 것을 정리한다(읽기·쓰기 때마다): 항목 30일·500건, Windows 알림 기록 2일, 30일 넘게 갱신이 없는 가족,
 * 보류 묶음에서 없어진 항목. 바뀌었으면 참
 */
export function pruneNotifyState(state: NotifyState, now: Date): boolean {
  const t = now.getTime();
  const before = JSON.stringify([
    state.items.length,
    Object.keys(state.families).length,
    state.toasts.length,
    state.pending,
    state.toastFailures.length,
  ]);
  // 미룬 항목은 깰 시각이 지나기 전엔 지우지 않는다(§7-1 — 방어)
  state.items = state.items.filter(
    (i) => t - Date.parse(i.createdAt) <= NOTIFY_MAX_AGE_DAYS * DAY_MS || (i.snoozeUntil !== null && Date.parse(i.snoozeUntil) > t),
  );
  if (state.items.length > NOTIFY_MAX_ITEMS) {
    state.items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    state.items = state.items.slice(state.items.length - NOTIFY_MAX_ITEMS);
  }
  state.toasts = state.toasts.filter((iso) => t - Date.parse(iso) <= TOAST_KEEP_MS);
  state.toastFailures = state.toastFailures.filter((iso) => t - Date.parse(iso) <= TOAST_KEEP_MS);
  for (const [k, rec] of Object.entries(state.families)) {
    if (t - Date.parse(rec.at) > NOTIFY_MAX_AGE_DAYS * DAY_MS) delete state.families[k];
  }
  if (state.pending) {
    const alive = new Set(state.items.map((i) => i.id));
    const ids = state.pending.itemIds.filter((id) => alive.has(id));
    const next: PendingBundle = { ...state.pending, itemIds: ids };
    if (next.morningItemId !== undefined && !alive.has(next.morningItemId)) delete next.morningItemId;
    state.pending = ids.length > 0 || next.morningItemId !== undefined ? next : null;
  }
  const after = JSON.stringify([
    state.items.length,
    Object.keys(state.families).length,
    state.toasts.length,
    state.pending,
    state.toastFailures.length,
  ]);
  return before !== after;
}

/** 항목 id: 'n_' + 무작위 16자 */
export function newItemId(): string {
  return 'n_' + crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(16, '0').slice(0, 16);
}

/** `<파일>.broken-<시각>` 으로 옮긴다(실패하면 복사). 옮긴 경로 또는 null */
function setAside(file: string, now: Date): string | null {
  let target = `${file}.broken-${compactStamp(now)}`;
  for (let i = 2; fs.existsSync(target); i++) target = `${file}.broken-${compactStamp(now)}-${i}`;
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    try {
      fs.copyFileSync(file, target);
      return target;
    } catch {
      return null;
    }
  }
}

export class NotifyStore {
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.file = path.join(dataDir, NOTIFY_FILE);
  }

  /**
   * 읽는다. 없으면 빈 상태, 깨졌으면 옮기고 빈 상태.
   * 읽지 못하면(잠김 EBUSY·EPERM 등 — readTextFile 이 잠깐씩 다시 읽어 본 뒤에도) **던진다**: 빈 상태로 시작해 다음 저장이
   * 원래 파일(가족·아침 요약 날짜·VOC 기준·오늘 보낸 수)을 덮어쓰면 같은 알림이 다시 나간다. 부르는 쪽은 다음 판정에서 다시 읽는다.
   */
  load(now: Date = new Date()): NotifyState {
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return emptyNotifyState();
      this.warn(`알림 기록(${NOTIFY_FILE})을 읽지 못함 (${code}) — 다음 판정에서 다시 읽음`);
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    if (!isObject(raw)) {
      const moved = setAside(this.file, now);
      this.warn(`알림 기록(${NOTIFY_FILE})이 깨져 ${moved ? path.basename(moved) + ' 로 옮기고 ' : ''}빈 상태로 시작함`);
      return emptyNotifyState();
    }
    const state = normalizeNotifyState(raw);
    pruneNotifyState(state, now);
    return state;
  }

  save(state: NotifyState, now: Date = new Date()): void {
    pruneNotifyState(state, now);
    writeJsonAtomic(this.file, state);
  }
}

/** 시험 모드의 Windows 알림 대신 한 줄(§7-3) */
export interface NotifyLogLine {
  /** 시험 시계의 로컬 시각 'YYYY-MM-DDTHH:mm:ss' */
  at: string;
  title: string;
  body: string;
  kinds: NotifyKind[];
  keys: string[];
  target: string;
  /** 2.12단계 §8 — Windows 알림 id(누르기·단추 시험용) */
  toastId?: string;
  /** 단추 이름(없으면 []) */
  actions?: string[];
  silent?: boolean;
}

/** 한 줄 JSON. 2.9 칸·순서 그대로, 새 칸은 뒤에 */
export function notifyLogLine(line: NotifyLogLine): string {
  const out: Record<string, unknown> = {
    at: line.at,
    title: line.title,
    body: line.body,
    kinds: line.kinds,
    keys: line.keys,
    target: line.target,
  };
  if (line.toastId !== undefined) out.toastId = line.toastId;
  if (line.actions !== undefined) out.actions = line.actions;
  if (line.silent !== undefined) out.silent = line.silent;
  return JSON.stringify(out) + '\n';
}

/** 기록 파일에 한 줄 더한다 */
export function appendNotifyLog(dataDir: string, line: NotifyLogLine): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, NOTIFY_LOG_FILE), notifyLogLine(line), 'utf8');
}
