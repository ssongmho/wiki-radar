// 메일함 서비스(docs/stage2.10-contract.md §3·§5·§6) — 임시 위키·임시 데이터 폴더·가짜 감시만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailboxSummary, SentMailRecord, Task } from '../../src/shared/types';
import { MAILBOX_PROBLEMS, MailboxService } from '../../src/main/mail/mailbox';
import { MAIL_INDEX_FILE } from '../../src/main/wiki/mailIndex';
import { mailRel, mailText, rmrf, tempWiki, writeFile } from './mailFixtures';

const NOW = new Date('2026-09-23T10:00:00+09:00');
const dirs: string[] = [];
const services: MailboxService[] = [];
afterEach(() => {
  while (services.length) services.pop()?.stop();
  while (dirs.length) rmrf(dirs.pop() as string);
});

const HG = '한결케미칼';
const A = mailRel(HG, '2026-09-12_0900_EHS팀_통영공장 CMS 인벤토리 사용량 확인 요청_aaaaa1');
const B = mailRel(HG, '2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3');
const ME = mailRel('내 메모', '2026-09-16_1000_나_RE 통영공장_aaaaa2');
const C = mailRel(HG, '2026-09-22_0900_EHS팀_RE RE 통영공장_aaaaa3');
const D = mailRel('대륙물산', '2026-09-21_1100_박담당_자재 단가 문의_d1d2d3');
const N1 = mailRel('_노이즈-추정', '2026-09-22_0700_뉴스_주간 소식 1_nnnnn1');
const Q = mailRel('_격리', '2026-09-22_0800_보안_계정 확인 필요_qqqqq1');

function setup(opts: { tasks?: () => readonly Task[]; sent?: () => readonly SentMailRecord[]; noMailDir?: boolean } = {}) {
  const root = tempWiki();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailbox-data-'));
  dirs.push(root, data);
  const subj = '통영공장 CMS 인벤토리 사용량 확인 요청';
  writeFile(root, A, mailText({ subject: subj, date: '2026-09-12T09:00:00+09:00', messageId: 'a@hg', folder: HG, from: 'EHS팀 <ehs@hangyeol.example>' }));
  writeFile(root, B, mailText({ subject: `RE: ${subj}`, date: '2026-09-15T17:28:40+09:00', messageId: 'b@hg', folder: HG, from: 'EHS팀 <ehs@hangyeol.example>' }));
  writeFile(root, ME, mailText({ subject: `RE: ${subj}`, date: '2026-09-16T10:00:00+09:00', messageId: 'me@hg', folder: '내 메모', from: '나 <owner@example.com>' }));
  writeFile(root, C, mailText({ subject: `RE: RE: ${subj}`, date: '2026-09-22T09:00:00+09:00', messageId: 'c@hg', folder: HG, attachments: 1, from: 'EHS팀 <ehs@hangyeol.example>' }));
  writeFile(root, D, mailText({ subject: '자재 단가 문의 드립니다', date: '2026-09-21T11:00:00+09:00', messageId: 'd@dr', folder: '대륙물산', from: '박담당 <park@daeryuk.example>' }));
  writeFile(root, N1, mailText({ subject: '주간 소식 1호', date: '2026-09-22T07:00:00+09:00', messageId: 'n1@news', folder: '_노이즈-추정', from: 'news@letter.example' }));
  writeFile(root, Q, mailText({ subject: '계정 확인 필요', date: '2026-09-22T08:00:00+09:00', messageId: 'q@x', folder: '_격리', suspicion: ['발신 도메인 불일치'] }));
  if (opts.noMailDir) fs.rmSync(path.join(root, 'raw', 'mail'), { recursive: true });
  let fire: (() => void) | null = null;
  const summaries: MailboxSummary[] = [];
  const svc = new MailboxService({
    wikiRoot: root,
    dataDir: data,
    now: () => NOW,
    myAddress: () => 'owner@example.com',
    tasks: opts.tasks ?? (() => []),
    sent: opts.sent ?? (() => []),
    onSummary: (s) => summaries.push(s),
    watch: (_root, onSettled) => {
      fire = onSettled;
      return { close: () => undefined };
    },
    cacheWriteDelayMs: 10,
  });
  services.push(svc);
  return { root, data, svc, summaries, fireWatch: () => fire?.() };
}

const ALL = { filter: 'all' as const, offset: 0, limit: 200 };

describe('MailboxService', () => {
  it('시작 → ready · 미확인(기준선 9/20 10:00 이후, 내 사본·노이즈 제외) · 사이드바 줄', async () => {
    const { svc, summaries } = setup();
    await svc.start();
    const s = svc.summary();
    expect(s.state).toBe('ready');
    expect(s.total).toBe(7);
    // 미확인 스레드: 한결(C 9/22) · 대륙(9/21) · 격리(9/22) — 노이즈는 빠진다
    expect(s.unread).toBe(3);
    expect(s.replyNeeded).toBe(0);
    expect(s.latestDate).toBe('2026-09-22T09:00:00+09:00');
    expect(s.top.map((r) => r.subject)).toEqual(['RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', '계정 확인 필요', '자재 단가 문의 드립니다']);
    expect(summaries.at(-1)?.state).toBe('ready');
  });

  it('목록: 스레드 묶음·칩 재료·노이즈 제외·폴더·검색', async () => {
    const { svc } = setup();
    await svc.start();
    const page = svc.list(ALL);
    expect(page.total).toBe(3);
    const hg = page.threads[0];
    expect(hg.count).toBe(4);
    expect(hg.includesMe).toBe(true);
    expect(hg.participants).toEqual(['EHS팀']);
    expect(hg.hasAttachments).toBe(true);
    expect(hg.links.replied).toBeUndefined();
    expect(page.threads.find((t) => t.subject === '계정 확인 필요')?.suspicious).toBe(true);
    expect(page.counts).toEqual({ all: 3, unread: 3, replyNeeded: 0, archived: 0 });
    expect(svc.list({ ...ALL, includeMuted: true }).total).toBe(4);
    expect(svc.list({ ...ALL, folder: '대륙물산' }).threads.map((t) => t.subject)).toEqual(['자재 단가 문의 드립니다']);
    expect(svc.list({ ...ALL, query: '박담당' }).total).toBe(1);
    expect(svc.list({ ...ALL, query: 'DAERYUK.example' }).total).toBe(1);
    expect(svc.list({ ...ALL, query: '한결' }).total).toBe(1);
    expect(svc.list({ ...ALL, query: '인벤토리   사용량' }).total).toBe(1);
    expect(svc.list({ ...ALL, query: '본문에만 있는 말' }).total).toBe(0);
    expect(svc.list({ ...ALL, offset: 1, limit: 1 }).threads).toHaveLength(1);
    const folders = page.folders.map((f) => f.name);
    expect(folders[0]).toBe(HG);
    expect(page.folders.find((f) => f.name === HG)).toEqual({ name: HG, count: 3, unread: 1 });
  });

  it('상태: 회신 필요 ↔ 처리함, 처리함 스레드에 새 메일이 오면 다시 전체에', async () => {
    const { root, svc, fireWatch } = setup();
    await svc.start();
    const hg = svc.list(ALL).threads[0];
    const detail = svc.thread(hg.id)!;
    const keys = detail.mails.map((m) => m.key);

    svc.setState([keys[1]], { replyNeeded: true });
    expect(svc.summary().replyNeeded).toBe(1);
    expect(svc.list({ ...ALL, filter: 'replyNeeded' }).threads.map((t) => t.id)).toEqual([hg.id]);
    expect(svc.summary().top[0].id).toBe(hg.id);

    const out = svc.setState([...keys, 'm:ffffffffffffffff'], { archived: true });
    expect(out.ignored).toBe(1);
    expect(svc.list(ALL).threads.some((t) => t.id === hg.id)).toBe(false);
    expect(svc.list({ ...ALL, filter: 'archived' }).threads.map((t) => t.id)).toEqual([hg.id]);
    expect(svc.summary().replyNeeded).toBe(0);

    // 같은 스레드에 새 메일
    writeFile(
      root,
      mailRel(HG, '2026-09-23_0900_EHS팀_RE RE RE 통영공장_aaaaa4'),
      mailText({ subject: 'RE: RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-09-23T09:00:00+09:00', messageId: 'e@hg', folder: HG }),
    );
    fireWatch();
    await svc.refresh();
    const back = svc.list(ALL).threads[0];
    expect(back.count).toBe(5);
    expect(back.archived).toBe(false);
    expect(back.unread).toBe(true);
  });

  it('처리함 스레드에 내 사본(bccSelf)이 들어와도 처리함 그대로 — 처리함 판정은 남이 보낸 메일만', async () => {
    const { root, svc, fireWatch } = setup();
    await svc.start();
    const hg = svc.list(ALL).threads[0];
    svc.setState(svc.thread(hg.id)!.mails.map((m) => m.key), { archived: true });
    writeFile(
      root,
      mailRel('내 메모', '2026-09-23_0930_나_RE RE RE 통영공장_aaaaa5'),
      mailText({ subject: 'RE: RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-09-23T09:30:00+09:00', messageId: 'me2@hg', folder: '내 메모', from: '나 <owner@example.com>' }),
    );
    fireWatch();
    await svc.refresh();
    expect(svc.list(ALL).threads.some((t) => t.id === hg.id || t.count === 5)).toBe(false);
    const arch = svc.list({ ...ALL, filter: 'archived' }).threads;
    expect(arch).toHaveLength(1);
    expect(arch[0].count).toBe(5);
    expect(arch[0].archived).toBe(true);
  });

  it('읽음·미확인으로 · 상태는 다시 열어도 남는다', async () => {
    const { svc, data } = setup();
    await svc.start();
    const d = svc.list({ ...ALL, folder: '대륙물산' }).threads[0];
    svc.setState([d.latestKey], { read: true });
    expect(svc.summary().unread).toBe(2);
    svc.setState([d.latestKey], { read: false });
    expect(svc.summary().unread).toBe(3);
    svc.setState([d.latestKey], { read: true });
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'mail-state.json'), 'utf8'));
    expect(saved.mails[d.latestKey].read).toBe(NOW.toISOString());
    expect(saved.baselineAt).toBe(new Date(NOW.getTime() - 72 * 3_600_000).toISOString());
  });

  it('keep: 「미확인」에서 읽음이 된 스레드도 남기되 수에는 넣지 않는다(지금 읽는 줄이 빠지지 않게)', async () => {
    const { svc } = setup();
    await svc.start();
    const UNREAD = { ...ALL, filter: 'unread' as const };
    const d = svc.list({ ...ALL, folder: '대륙물산' }).threads[0];
    svc.setState([d.latestKey], { read: true });
    expect(svc.list(UNREAD).threads.map((t) => t.id)).not.toContain(d.id);
    const kept = svc.list({ ...UNREAD, keep: [d.id] });
    expect(kept.threads.map((t) => t.id)).toContain(d.id);
    expect(kept.threads.find((t) => t.id === d.id)?.unread).toBe(false);
    expect(kept.counts.unread).toBe(2);
    // 없는 id 는 무시
    expect(svc.list({ ...UNREAD, keep: ['th:000000000000'] }).total).toBe(2);
  });

  it('스레드 상세·메일 키로 찾기·메일 읽기', async () => {
    const { svc } = setup();
    await svc.start();
    const hg = svc.list(ALL).threads[0];
    const detail = svc.thread(hg.id)!;
    expect(detail.mails.map((m) => m.path)).toEqual([A, B, ME, C]);
    expect(detail.mails[2].mine).toBe(true);
    expect(detail.links.replyGuess).toBeUndefined();
    expect(svc.findThread(detail.mails[0].key)).toEqual({ threadId: hg.id });
    expect(svc.findThread('m:0000000000000000')).toBeNull();
    expect(svc.thread('th:000000000000')).toBeNull();
    const msg = svc.message(B)!;
    expect(msg.key).toBe(detail.mails[1].key);
    expect(msg.body).toContain('안녕하세요');
    expect(svc.message('raw/mail/../wiki/x.md')).toBeNull();
  });

  it('연결: 스냅샷 할 일·발송 기록이 바뀌면 relink 로 다시 계산', async () => {
    let tasks: Task[] = [];
    let sent: SentMailRecord[] = [];
    const { svc } = setup({ tasks: () => tasks, sent: () => sent });
    await svc.start();
    const rev0 = svc.summary().revision;
    tasks = [{ id: 'c:t1', source: 'checkbox', title: '회신', status: 'open', bucket: 'thisWeek', mail: B, rawLine: '- [ ] 회신 [voc:: VOC-2026-0001]' }];
    sent = [
      {
        id: 's1',
        at: '2026-09-23T00:30:00Z',
        taskId: '',
        taskTitle: '',
        mail: C,
        to: ['ehs@hangyeol.example'],
        cc: [],
        bcc: [],
        subject: 'RE: x',
        messageId: 'x@y',
        origin: 'mailbox',
      },
    ];
    svc.relink();
    expect(svc.summary().revision).toBeGreaterThan(rev0);
    const hg = svc.list(ALL).threads[0];
    expect(hg.links).toEqual({ tasks: 1, voc: 'VOC-2026-0001', replied: 'sent' });
    expect(svc.thread(hg.id)?.links.sent[0]).toMatchObject({ mail: C, origin: 'mailbox' });
  });

  it('VOC·할 일 기록은 연결에 바로 보인다', async () => {
    const { svc } = setup();
    await svc.start();
    const d = svc.list({ ...ALL, folder: '대륙물산' }).threads[0];
    svc.markVoc(d.latestKey, { number: 'VOC-2026-0300', ticketId: 300 });
    svc.markTask(d.latestKey, '_private/mgmt/내 할 일.md');
    const row = svc.list({ ...ALL, folder: '대륙물산' }).threads[0];
    expect(row.links).toEqual({ tasks: 1, voc: 'VOC-2026-0300' });
    expect(svc.thread(d.id)?.mails[0]).toMatchObject({ voc: 'VOC-2026-0300', taskFile: '_private/mgmt/내 할 일.md' });
  });

  it('쓸 수 없음: raw/mail 없음 → noMailDir, 생기면 감시가 다시 색인', async () => {
    const { root, svc, fireWatch } = setup({ noMailDir: true });
    await svc.start();
    expect(svc.summary()).toMatchObject({ state: 'noMailDir', problem: MAILBOX_PROBLEMS.noMailDir, total: 0, unread: 0 });
    expect(svc.list(ALL).threads).toEqual([]);
    writeFile(root, D, mailText({ subject: '자재 단가 문의 드립니다', date: '2026-09-21T11:00:00+09:00', messageId: 'd@dr', folder: '대륙물산' }));
    fireWatch();
    await svc.refresh();
    expect(svc.summary()).toMatchObject({ state: 'ready', total: 1, unread: 1 });
  });

  it('개인 위키 없음 → noWiki', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailbox-data-'));
    dirs.push(data);
    const svc = new MailboxService({
      wikiRoot: path.join(data, '없는 위키'),
      dataDir: data,
      now: () => NOW,
      myAddress: () => undefined,
      tasks: () => [],
      sent: () => [],
      watch: () => ({ close: () => undefined }),
    });
    services.push(svc);
    await svc.start();
    expect(svc.summary()).toMatchObject({ state: 'noWiki', problem: MAILBOX_PROBLEMS.noWiki });
    expect(fs.existsSync(path.join(data, 'mail-state.json'))).toBe(false);
  });

  it('색인 캐시: 끄면 쓰고, 다시 켜면 캐시로 먼저 보인 뒤 다시 읽지 않는다', async () => {
    const { root, data, svc } = setup();
    await svc.start();
    svc.stop();
    services.length = 0;
    const cache = JSON.parse(fs.readFileSync(path.join(data, MAIL_INDEX_FILE), 'utf8'));
    expect(cache.version).toBe(1);
    expect(cache.entries).toHaveLength(7);
    const logs: string[] = [];
    const again = new MailboxService({
      wikiRoot: root,
      dataDir: data,
      now: () => NOW,
      myAddress: () => 'owner@example.com',
      tasks: () => [],
      sent: () => [],
      log: (m) => logs.push(m),
      watch: () => ({ close: () => undefined }),
    });
    services.push(again);
    const started = again.start();
    // 캐시로 바로 ready
    expect(again.summary().state).toBe('ready');
    await started;
    expect(again.summary().total).toBe(7);
    expect(logs.some((l) => l.includes('새로 읽음'))).toBe(false);
  });
});
