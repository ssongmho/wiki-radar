// 2.14단계 반영 실행 배선(src/main/ipc.ts ReflectController) — 가짜 claude(test/fixtures/fake-claude.mjs)와
// 테스트 사본(test/fixtures/wiki)의 임시 복사본만 쓴다. electron 은 가짜로 바꾼다. 실제 위키·claude 는 부르지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sent: [] as { channel: string; payload: unknown }[] }));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) },
      },
    ],
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: async () => undefined },
}));

import type { ReflectRun } from '../../src/shared/types';
import { ReflectController, skippedItemIds } from '../../src/main/ipc';
import { QueueStore } from '../../src/main/queue';
import { ReflectHistory, stopActiveReflect } from '../../src/main/reflect';
import { MailboxService } from '../../src/main/mail/mailbox';
import { queueMailForWiki } from '../../src/main/mail/mailWiki';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const FAKE = path.resolve(__dirname, '../fixtures/fake-claude.mjs');
const HG_THREAD_LATEST = 'raw/mail/한결케미칼/2026/2026-09-22_1442_EHS팀_RE RE 통영공장 CMS 인벤토리 사용량 확인 요청_c7d8e9.md';
const DR = 'raw/mail/대륙물산/2026/2026-09-21_1100_박담당_자재 단가 문의_d1d2d3.md';
const NOW = new Date('2026-09-23T10:00:00+09:00');

const temps: string[] = [];
const services: MailboxService[] = [];
afterEach(() => {
  stopActiveReflect('시험 정리');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (services.length) services.pop()?.stop();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  h.sent.length = 0;
});

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

async function setup(env: Record<string, string> = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const wiki = tempDir('radar-mwipc-wiki-');
  fs.cpSync(FIXTURE, wiki, { recursive: true });
  const data = tempDir('radar-mwipc-data-');
  const logFile = path.join(data, 'fake-claude-log.json');
  vi.stubEnv('FAKE_CLAUDE_MODE', 'ok');
  vi.stubEnv('FAKE_CLAUDE_LOG', logFile);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const queue = new QueueStore(data);
  const history = new ReflectHistory(data);
  let svc: MailboxService | null = null;
  const reflect = new ReflectController({
    wikiRoot: wiki,
    queue: () => queue,
    history: () => history,
    getClaudePath: () => ({ path: FAKE, source: 'env', exists: true }),
    mailbox: () => svc,
  });
  svc = new MailboxService({
    wikiRoot: wiki,
    dataDir: data,
    now: () => NOW,
    myAddress: () => 'owner@example.com',
    tasks: () => [],
    sent: () => [],
    watch: () => ({ close: () => undefined }),
    cacheWriteDelayMs: 10,
    wikiPending: () => reflect.wikiPending(),
  });
  services.push(svc);
  await svc.start();
  const key = (rel: string): string => svc!.entryOfPath(rel)!.key;
  const readLog = () => JSON.parse(fs.readFileSync(logFile, 'utf8')) as { argv: string[]; mails: { ref: string; mails: { key: string }[] }[]; cwd: string };
  return { wiki, data, queue, history, reflect, svc: svc as MailboxService, key, readLog };
}

async function waitDone(reflect: ReflectController): Promise<ReflectRun> {
  for (let i = 0; i < 300; i++) {
    const run = reflect.current();
    if (run && run.state !== 'running') return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('반영이 끝나지 않음');
}

describe('ReflectController — kind mail(§3·§4-3)', () => {
  it('성공 → 보낸 항목만 빠지고 held 는 남음 · 스레드 키 모두 done · 진행 기록에 「이번 반영에서 뺌」', async () => {
    const { wiki, queue, reflect, svc, key, readLog } = await setup();
    const thread = queueMailForWiki({ key: key(HG_THREAD_LATEST), scope: 'thread', note: '' }, { mailbox: svc, queue });
    const lost = queueMailForWiki({ key: key(DR), scope: 'mail', note: '단가표' }, { mailbox: svc, queue });
    if (thread.status !== 'queued' || lost.status !== 'queued') throw new Error('넣기 실패');
    queue.add({ kind: 'task', taskId: 'i:1', title: '할 일 하나', status: 'done', note: '처리함' });
    fs.rmSync(path.join(wiki, ...DR.split('/')));
    await svc.refresh();
    expect(reflect.queueView().find((x) => x.id === lost.item.id)?.blocked).toBe('메일을 찾을 수 없음');

    const started = reflect.start();
    expect(started.itemIds).toHaveLength(2);
    expect(started.log.join('\n')).toContain('이번 반영에서 뺌(메일을 찾을 수 없음)');
    const run = await waitDone(reflect);
    expect(run.state).toBe('done');
    expect(queue.list().map((x) => x.id)).toEqual([lost.item.id]);

    const log = readLog();
    expect(log.mails).toHaveLength(1);
    expect(log.mails[0].ref).toBe(thread.item.id);
    const threadKeys = svc.threadMailsOf(key(HG_THREAD_LATEST)).map((e) => e.key);
    expect(log.mails[0].mails.map((m) => m.key)).toEqual(threadKeys);
    for (const k of threadKeys) expect(svc.markOf(k)?.wiki).toMatchObject({ state: 'done', runId: run.id });
    // 대기열이 바뀌면 blocked 를 붙여 방송한다
    const lastQueue = h.sent.filter((s) => s.channel === 'radar:queue').at(-1)?.payload as { id: string; blocked?: string }[];
    expect(lastQueue).toEqual([expect.objectContaining({ id: lost.item.id, blocked: '메일을 찾을 수 없음' })]);
  });

  it('FAKE_CLAUDE_SKIP_TITLES → skipped 표시', async () => {
    const { queue, reflect, svc, key } = await setup({ FAKE_CLAUDE_SKIP_TITLES: JSON.stringify(['자재 단가 문의 드립니다']) });
    const out = queueMailForWiki({ key: key(DR), scope: 'mail', note: '' }, { mailbox: svc, queue });
    if (out.status !== 'queued') throw new Error('넣기 실패');
    reflect.start();
    const run = await waitDone(reflect);
    expect(run.state).toBe('done');
    expect(run.skipped?.map((s) => s.title)).toEqual(['자재 단가 문의 드립니다']);
    expect(svc.markOf(key(DR))?.wiki?.state).toBe('skipped');
  });

  it('같은 스레드의 메일 두 통(제목 같음) 중 하나만 건너뛰면 그 메일만 skipped — id 로 맞춘다', async () => {
    const { queue, reflect, svc, key } = await setup();
    const thread = svc.threadMailsOf(key(HG_THREAD_LATEST));
    expect(thread.length).toBeGreaterThanOrEqual(2);
    const first = thread[0]!;
    const last = thread[thread.length - 1]!;
    const a = queueMailForWiki({ key: first.key, scope: 'mail', note: '메모 X' }, { mailbox: svc, queue });
    const b = queueMailForWiki({ key: last.key, scope: 'mail', note: '메모 Y' }, { mailbox: svc, queue });
    if (a.status !== 'queued' || b.status !== 'queued') throw new Error('넣기 실패');
    expect(a.item.title).toBe(b.item.title);
    vi.stubEnv('FAKE_CLAUDE_SKIP_IDS', JSON.stringify([b.item.id]));
    reflect.start();
    const run = await waitDone(reflect);
    expect(run.state).toBe('done');
    expect(run.skipped).toEqual([{ id: b.item.id, title: b.item.title, reason: expect.any(String) }]);
    expect(svc.markOf(first.key)?.wiki?.state).toBe('done');
    expect(svc.markOf(last.key)?.wiki?.state).toBe('skipped');
  });

  it('skippedItemIds: id 가 있으면 id 로, 없으면 이번 실행에 하나뿐인 제목만', () => {
    const sent = [
      { id: 'a', title: '견적 요청' },
      { id: 'b', title: '견적 요청' },
      { id: 'c', title: '단가 문의' },
    ];
    expect([...skippedItemIds([{ id: 'b', title: '견적 요청' }], sent)]).toEqual(['b']);
    expect([...skippedItemIds([{ title: '견적 요청' }], sent)]).toEqual([]);
    expect([...skippedItemIds([{ title: '단가 문의' }], sent)]).toEqual(['c']);
    expect([...skippedItemIds([{ id: 'zz', title: '단가 문의' }], sent)]).toEqual(['c']);
  });

  it('실패 → 표시를 쓰지 않고 대기열 그대로', async () => {
    const { queue, reflect, svc, key } = await setup({ FAKE_CLAUDE_MODE: 'fail' });
    const out = queueMailForWiki({ key: key(DR), scope: 'mail', note: '' }, { mailbox: svc, queue });
    if (out.status !== 'queued') throw new Error('넣기 실패');
    reflect.start();
    const run = await waitDone(reflect);
    expect(run.state).toBe('failed');
    expect(queue.list()).toHaveLength(1);
    expect(svc.markOf(key(DR))?.wiki).toBeUndefined();
  });

  it('보낼 항목이 없으면 실행 기록 없이 거부', async () => {
    const { wiki, queue, history, reflect, svc, key } = await setup();
    const out = queueMailForWiki({ key: key(DR), scope: 'mail', note: '' }, { mailbox: svc, queue });
    if (out.status !== 'queued') throw new Error('넣기 실패');
    fs.rmSync(path.join(wiki, ...DR.split('/')));
    await svc.refresh();
    expect(() => reflect.start()).toThrow('보낼 수 있는 항목이 없습니다 — 메일을 찾을 수 없음 1건');
    expect(history.list()).toEqual([]);
    expect(reflect.current()).toBeNull();
  });

  it('반영 중에는 메일함 표시가 running', async () => {
    const { queue, reflect, svc, key } = await setup({ FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' });
    const out = queueMailForWiki({ key: key(DR), scope: 'mail', note: '' }, { mailbox: svc, queue });
    if (out.status !== 'queued') throw new Error('넣기 실패');
    reflect.start();
    expect(svc.wikiMarkOf(key(DR))?.state).toBe('running');
    await waitDone(reflect);
    expect(svc.wikiMarkOf(key(DR))?.state).toBe('done');
  });
});
