// notifications.json·시험 기록(2.9단계 명세 §7·§12-2): 원자적 쓰기 · 30일·500건 정리 · 깨진 파일 옮김 · 기록 줄 모양. 임시 폴더만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTIFY_FILE,
  NOTIFY_LOG_FILE,
  NotifyStore,
  appendNotifyLog,
  emptyNotifyState,
  newItemId,
  normalizeNotifyState,
  pruneNotifyState,
  type StoredItem,
} from '../../src/main/notify/store';
import { at } from './notifyFixtures';

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-notify-'));
  temps.push(dir);
  return dir;
}

function item(createdAt: Date, over: Partial<StoredItem> = {}): StoredItem {
  return {
    id: newItemId(),
    key: 'voc:1:sla-warning',
    family: 'voc:1:sla',
    kind: 'vocSla',
    grade: 'urgent',
    title: 'VOC SLA 임박',
    body: 'VOC-1 · 제목',
    target: 'view:voc:VOC-1',
    createdAt: createdAt.toISOString(),
    readAt: null,
    toastAt: null,
    deferred: false,
    snoozeUntil: null,
    snooze: null,
    remindedAt: null,
    ...over,
  };
}

describe('NotifyStore', () => {
  it('없으면 빈 상태, 저장은 원자적(임시 파일이 남지 않는다)·다시 읽으면 같은 것', () => {
    const dir = tempDir();
    const store = new NotifyStore(dir);
    const now = at('2026-09-23T09:00');
    expect(store.load(now)).toEqual(emptyNotifyState());
    const st = emptyNotifyState();
    st.items.push(item(now));
    st.families['voc:1:sla'] = { rank: 1, at: now.toISOString() };
    st.morning = '2026-09-23';
    st.vocMine = { meId: 101, ids: [1004], at: now.toISOString() };
    store.save(st, now);
    expect(fs.readdirSync(dir)).toEqual([NOTIFY_FILE]);
    expect(store.load(now)).toEqual(st);
  });

  it('읽지 못하면(ENOENT 밖) 빈 상태로 돌려주지 않고 던진다 — 원래 파일은 그대로', () => {
    const dir = tempDir();
    // 폴더를 파일 자리에 두어 EISDIR 로 읽기 실패를 만든다
    fs.mkdirSync(path.join(dir, NOTIFY_FILE));
    const warnings: string[] = [];
    const store = new NotifyStore(dir, (m) => warnings.push(m));
    expect(() => store.load(at('2026-09-23T09:00'))).toThrow();
    expect(warnings[0]).toMatch(/읽지 못함/);
    expect(fs.statSync(path.join(dir, NOTIFY_FILE)).isDirectory()).toBe(true);
  });

  it('깨진 파일은 .broken-<시각> 으로 옮기고 빈 상태로 시작한다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, NOTIFY_FILE), '{ 깨짐', 'utf8');
    const warnings: string[] = [];
    const store = new NotifyStore(dir, (m) => warnings.push(m));
    expect(store.load(at('2026-09-23T09:00'))).toEqual(emptyNotifyState());
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(`${NOTIFY_FILE}.broken-20260923T090000`))).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, NOTIFY_FILE))).toBe(false);
    expect(warnings[0]).toMatch(/깨져/);
  });

  it('모양이 틀린 칸·항목은 버린다', () => {
    const now = at('2026-09-23T09:00');
    const st = normalizeNotifyState({
      items: [item(now), { id: 'x', key: 1 }, { ...item(now), kind: 'mail' }],
      families: { a: { rank: 1, at: now.toISOString() }, b: { rank: 'x' } },
      morning: '9/23',
      toasts: [now.toISOString(), 'nope'],
      pending: { itemIds: [], since: now.toISOString() },
      vocMine: { meId: '101' },
    });
    expect(st.items).toHaveLength(1);
    expect(Object.keys(st.families)).toEqual(['a']);
    expect(st.morning).toBeNull();
    expect(st.toasts).toHaveLength(1);
    expect(st.pending).toBeNull();
    expect(st.vocMine).toBeNull();
  });
});

describe('정리(§7-1)', () => {
  it('항목·가족 30일, 항목 500건(오래된 것부터), Windows 알림 기록 2일, 보류 묶음의 없어진 항목', () => {
    const now = at('2026-09-23T09:00');
    const day = 86_400_000;
    const st = emptyNotifyState();
    const old = item(new Date(now.getTime() - 31 * day));
    st.items.push(old);
    for (let i = 0; i < 505; i++) st.items.push(item(new Date(now.getTime() - i * 60_000)));
    st.families.old = { rank: 1, at: new Date(now.getTime() - 31 * day).toISOString() };
    st.families.fresh = { rank: 1, at: new Date(now.getTime() - 29 * day).toISOString() };
    st.toasts = [new Date(now.getTime() - 3 * day).toISOString(), new Date(now.getTime() - day).toISOString()];
    st.pending = { itemIds: [old.id], since: now.toISOString() };
    expect(pruneNotifyState(st, now)).toBe(true);
    expect(st.items).toHaveLength(500);
    expect(st.items.some((i) => i.id === old.id)).toBe(false);
    // 남은 것은 가장 새 500건
    expect(Math.max(...st.items.map((i) => now.getTime() - Date.parse(i.createdAt)))).toBe(499 * 60_000);
    expect(Object.keys(st.families)).toEqual(['fresh']);
    expect(st.toasts).toHaveLength(1);
    expect(st.pending).toBeNull();
    expect(pruneNotifyState(st, now)).toBe(false);
  });

  it('항목 id 는 n_ + 16자', () => {
    for (let i = 0; i < 20; i++) expect(newItemId()).toMatch(/^n_[A-Za-z0-9]{16}$/);
  });
});

describe('시험 기록 파일(§7-3)', () => {
  it('한 줄에 하나 — at·title·body·kinds·keys·target', () => {
    const dir = tempDir();
    appendNotifyLog(dir, {
      at: '2026-09-23T14:00:00',
      title: '오늘 마감',
      body: '보고서',
      kinds: ['due'],
      keys: ['task:c:abc:due-today'],
      target: 'c:abc',
    });
    appendNotifyLog(dir, { at: '2026-09-23T14:05:00', title: 'VOC 새 배정', body: 'VOC-1 · a', kinds: ['vocAssign'], keys: ['k'], target: 'view:voc:VOC-1' });
    const lines = fs.readFileSync(path.join(dir, NOTIFY_LOG_FILE), 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines[0]).toBe(
      '{"at":"2026-09-23T14:00:00","title":"오늘 마감","body":"보고서","kinds":["due"],"keys":["task:c:abc:due-today"],"target":"c:abc"}',
    );
    expect(JSON.parse(lines[1])).toMatchObject({ kinds: ['vocAssign'] });
  });
});

describe('2.12단계 — notifications.json v2(§7-1)', () => {
  it('v1 파일은 그대로 읽고(미룬 것·보류 없음) v2 로 저장한다', () => {
    const dir = tempDir();
    const now = at('2026-09-23T09:10');
    const v1 = {
      version: 1,
      items: [{ ...item(now), snoozeUntil: undefined, snooze: undefined, remindedAt: undefined }],
      families: { 'voc:1:sla': { rank: 1, at: now.toISOString() } },
      morning: '2026-09-23',
      toasts: [now.toISOString()],
      lastToastAt: now.toISOString(),
      pending: null,
      vocMine: null,
    };
    fs.writeFileSync(path.join(dir, NOTIFY_FILE), JSON.stringify(v1), 'utf8');
    const store = new NotifyStore(dir);
    const st = store.load(now);
    expect(st.items[0]).toMatchObject({ snoozeUntil: null, snooze: null, remindedAt: null });
    expect(st.morning).toBe('2026-09-23');
    expect(st.toastFailures).toEqual([]);
    store.save(st, now);
    expect(JSON.parse(fs.readFileSync(path.join(dir, NOTIFY_FILE), 'utf8')).version).toBe(2);
  });

  it('틀린 snooze 는 두 칸 다 버리고, morningItemId 만 있는 pending 도 살린다(held 이유가 틀리면 held 만 버림)', () => {
    const now = at('2026-09-23T09:10');
    const ok = item(now, { id: 'n_ok' });
    const st = normalizeNotifyState({
      items: [
        { ...item(now, { id: 'n_a' }), snooze: 'nap', snoozeUntil: now.toISOString() },
        { ...item(now, { id: 'n_b' }), snooze: '1h', snoozeUntil: 'x' },
        { ...ok, snooze: 'morning', snoozeUntil: now.toISOString(), remindedAt: now.toISOString() },
      ],
      pending: { since: now.toISOString(), morningItemId: 'n_ok', held: { reason: 'nap', since: now.toISOString() } },
      toastFailures: [now.toISOString(), 'x'],
    });
    expect(st.items.map((i) => [i.id, i.snooze, i.snoozeUntil !== null])).toEqual([
      ['n_a', null, false],
      ['n_b', null, false],
      ['n_ok', 'morning', true],
    ]);
    expect(st.items[2].remindedAt).toBe(now.toISOString());
    expect(st.pending).toEqual({ itemIds: [], since: now.toISOString(), morningItemId: 'n_ok' });
    expect(st.toastFailures).toEqual([now.toISOString()]);
    const held = normalizeNotifyState({ pending: { itemIds: ['n_x'], since: now.toISOString(), held: { reason: 'presentation', since: now.toISOString() } } });
    expect(held.pending?.held).toEqual({ reason: 'presentation', since: now.toISOString() });
  });

  it('정리: toastFailures 2일 · morningItemId 의 항목이 없으면 지움 · 미룬 항목은 깰 시각 전엔 30일이 지나도 둔다', () => {
    const now = at('2026-09-23T09:10');
    const st = emptyNotifyState();
    st.toastFailures = [at('2026-09-20T09:00').toISOString(), at('2026-09-22T10:00').toISOString()];
    st.pending = { itemIds: [], since: now.toISOString(), morningItemId: 'n_gone' };
    const old = item(at('2026-08-01T09:00'), { id: 'n_old', snooze: 'morning', snoozeUntil: at('2026-09-28T08:50').toISOString() });
    st.items.push(old, item(at('2026-08-01T09:00'), { id: 'n_drop' }));
    expect(pruneNotifyState(st, now)).toBe(true);
    expect(st.toastFailures).toHaveLength(1);
    expect(st.pending).toBeNull();
    expect(st.items.map((i) => i.id)).toEqual(['n_old']);
  });

  it('시험 기록 줄: 2.9 칸 순서 그대로, 새 칸(toastId·actions·silent)은 뒤에', () => {
    const dir = tempDir();
    appendNotifyLog(dir, {
      at: '2026-09-23T09:10:00',
      title: 't',
      body: 'b',
      kinds: ['vocSla'],
      keys: ['k'],
      target: 'view:inbox',
      toastId: 't_abcdefghijkl',
      actions: ['열기', '1시간 뒤'],
      silent: true,
    });
    const line = fs.readFileSync(path.join(dir, NOTIFY_LOG_FILE), 'utf8').trim();
    expect(Object.keys(JSON.parse(line))).toEqual(['at', 'title', 'body', 'kinds', 'keys', 'target', 'toastId', 'actions', 'silent']);
  });
});
