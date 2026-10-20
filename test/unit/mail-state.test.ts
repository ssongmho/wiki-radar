// 메일 상태 mail-state.json(docs/stage2.10-contract.md §3). 임시 데이터 폴더에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIL_BASELINE_BACK_MS,
  MAIL_STATE_FILE,
  MailStateStore,
  mailFlags,
  pruneMailState,
  type MailStateFile,
} from '../../src/main/mail/mailState';
import { rmrf } from './mailFixtures';

const dirs: string[] = [];
function dataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailstate-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop() as string);
});

const NOW = new Date('2026-09-23T10:00:00+09:00');
const K1 = 'm:0000000000000001';
const K2 = 'm:0000000000000002';

describe('mailFlags', () => {
  const baseline = NOW.getTime() - MAIL_BASELINE_BACK_MS;
  const fresh = { mine: false, muted: false, dateMs: baseline + 1 };
  const old = { mine: false, muted: false, dateMs: baseline - 1 };

  it('기준선 이후·표시 없음 → 미확인, 이전 → 읽음', () => {
    expect(mailFlags(fresh, undefined, baseline).unread).toBe(true);
    expect(mailFlags(old, undefined, baseline).unread).toBe(false);
  });

  it('읽음·미확인으로', () => {
    expect(mailFlags(fresh, { read: NOW.toISOString() }, baseline).unread).toBe(false);
    expect(mailFlags(old, { unread: NOW.toISOString() }, baseline).unread).toBe(true);
    // 미확인으로가 읽음보다 우선
    expect(mailFlags(fresh, { read: 'x', unread: NOW.toISOString() }, baseline).unread).toBe(true);
  });

  it('내 사본·노이즈 추정·처리함은 미확인이 아니다', () => {
    expect(mailFlags({ ...fresh, mine: true }, undefined, baseline).unread).toBe(false);
    expect(mailFlags({ ...fresh, muted: true }, undefined, baseline).unread).toBe(false);
    expect(mailFlags(fresh, { archived: NOW.toISOString(), unread: NOW.toISOString() }, baseline)).toEqual({
      unread: false,
      replyNeeded: false,
      archived: true,
    });
  });

  it('회신 필요는 처리함이 아닐 때만', () => {
    expect(mailFlags(old, { replyNeeded: 'x' }, baseline).replyNeeded).toBe(true);
    expect(mailFlags(old, { replyNeeded: 'x', archived: 'y' }, baseline).replyNeeded).toBe(false);
  });
});

describe('MailStateStore', () => {
  it('처음: 기준선 = 지금 − 72시간, ensureSaved 로 파일을 만든다', () => {
    const dir = dataDir();
    const store = new MailStateStore(dir, { now: () => NOW });
    expect(store.baselineMs()).toBe(NOW.getTime() - 72 * 3_600_000);
    expect(fs.existsSync(path.join(dir, MAIL_STATE_FILE))).toBe(false);
    store.ensureSaved();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, MAIL_STATE_FILE), 'utf8')) as MailStateFile;
    expect(saved).toEqual({ version: 1, baselineAt: new Date(NOW.getTime() - MAIL_BASELINE_BACK_MS).toISOString(), mails: {} });
    // 다시 열어도 기준선은 그대로(처음 색인한 시각 기준)
    const later = new MailStateStore(dir, { now: () => new Date(NOW.getTime() + 86_400_000) });
    expect(later.baselineMs()).toBe(NOW.getTime() - MAIL_BASELINE_BACK_MS);
  });

  it('읽음/미확인으로/회신 필요 ↔ 처리함', () => {
    const dir = dataDir();
    const store = new MailStateStore(dir, { now: () => NOW });
    expect(store.apply([K1], { read: true })).toBe(1);
    expect(store.mark(K1)?.read).toBe(NOW.toISOString());
    expect(store.apply([K1], { read: true })).toBe(0);
    store.apply([K1], { read: false });
    expect(store.mark(K1)?.unread).toBeTruthy();
    store.apply([K1], { read: true });
    expect(store.mark(K1)?.unread).toBeUndefined();

    store.apply([K2], { replyNeeded: true });
    expect(store.mark(K2)?.replyNeeded).toBeTruthy();
    store.apply([K2], { archived: true });
    expect(store.mark(K2)?.replyNeeded).toBeUndefined();
    expect(store.mark(K2)?.archived).toBeTruthy();
    store.apply([K2], { replyNeeded: true });
    expect(store.mark(K2)?.archived).toBeUndefined();
    store.apply([K2], { replyNeeded: false });
    // 의미 있는 표시가 없으면 항목을 지운다
    expect(store.mark(K2)).toBeUndefined();

    const reread = new MailStateStore(dir, { now: () => NOW });
    expect(reread.mark(K1)?.read).toBe(NOW.toISOString());
  });

  it('VOC·할 일 기록', () => {
    const dir = dataDir();
    const store = new MailStateStore(dir, { now: () => NOW });
    store.setVoc(K1, { number: 'VOC-2026-0100', ticketId: 100 }, 'raw/mail/a/2026/x.md');
    store.setTask(K1, '_private/mgmt/내 할 일.md');
    const m = new MailStateStore(dir, { now: () => NOW }).mark(K1);
    expect(m?.voc).toEqual({ number: 'VOC-2026-0100', ticketId: 100, at: NOW.toISOString() });
    expect(m?.task?.file).toBe('_private/mgmt/내 할 일.md');
    expect(m?.path).toBe('raw/mail/a/2026/x.md');
  });

  it('깨진 파일은 mail-state.broken-<시각>.json 으로 옮기고 새로 시작', () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, MAIL_STATE_FILE), '{ 깨짐');
    const warns: string[] = [];
    const store = new MailStateStore(dir, { now: () => NOW, warn: (m) => warns.push(m) });
    expect(store.mark(K1)).toBeUndefined();
    const broken = fs.readdirSync(dir).filter((n) => /^mail-state\.broken-\d{8}T\d{6}(-\d+)?\.json$/.test(n));
    expect(broken).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, broken[0]), 'utf8')).toBe('{ 깨짐');
    expect(warns.join()).toContain('깨져');
    // 형식이 틀린 것도
    fs.writeFileSync(path.join(dir, MAIL_STATE_FILE), JSON.stringify({ version: 9 }));
    new MailStateStore(dir, { now: () => NOW }).load();
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('mail-state.broken-'))).toHaveLength(2);
  });

  it('잠김(ENOENT 아닌 읽기 실패)은 덮어쓰지 않고 쓰기를 거부', () => {
    const dir = dataDir();
    // 파일 자리에 폴더 — 읽기는 EISDIR 로 실패한다
    fs.mkdirSync(path.join(dir, MAIL_STATE_FILE));
    const warns: string[] = [];
    const store = new MailStateStore(dir, { now: () => NOW, warn: (m) => warns.push(m) });
    expect(store.mark(K1)).toBeUndefined();
    expect(store.problem).toContain('읽지 못했습니다');
    expect(() => store.apply([K1], { read: true })).toThrow('덮어쓰지 않도록');
    store.ensureSaved();
    expect(fs.statSync(path.join(dir, MAIL_STATE_FILE)).isDirectory()).toBe(true);
  });

  it('형식이 틀린 표시·키는 버린다', () => {
    const dir = dataDir();
    fs.writeFileSync(
      path.join(dir, MAIL_STATE_FILE),
      JSON.stringify({ version: 1, baselineAt: NOW.toISOString(), mails: { [K1]: { read: NOW.toISOString(), x: 1 }, 'bad-key': { read: 'x' }, [K2]: { read: 3 } } }),
    );
    const store = new MailStateStore(dir, { now: () => NOW });
    expect(store.mark(K1)).toEqual({ read: NOW.toISOString() });
    expect(store.mark(K2)).toBeUndefined();
  });
});

describe('pruneMailState', () => {
  it('항목 한도: read 만 있는 오래된 것부터 버린다', () => {
    const state: MailStateFile = { version: 1, baselineAt: NOW.toISOString(), mails: {} };
    for (let i = 0; i < 10; i++) {
      state.mails[`m:${i.toString(16).padStart(16, '0')}`] = { read: new Date(NOW.getTime() + i * 1000).toISOString() };
    }
    state.mails['m:ffffffffffffffff'] = { replyNeeded: NOW.toISOString() };
    expect(pruneMailState(state, 5)).toBe(6);
    expect(Object.keys(state.mails)).toHaveLength(5);
    expect(state.mails['m:ffffffffffffffff']).toBeDefined();
    expect(state.mails['m:0000000000000009']).toBeDefined();
    expect(state.mails['m:0000000000000000']).toBeUndefined();
  });

  it('크기 한도', () => {
    const state: MailStateFile = { version: 1, baselineAt: NOW.toISOString(), mails: {} };
    for (let i = 0; i < 200; i++) state.mails[`m:${i.toString(16).padStart(16, '0')}`] = { read: NOW.toISOString() };
    const dropped = pruneMailState(state, 20_000, 4_000);
    expect(dropped).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(state, null, 2))).toBeLessThanOrEqual(4_000);
  });
});
