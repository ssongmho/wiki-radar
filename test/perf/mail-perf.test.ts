// 메일함 성능 한도(docs/stage2.10-contract.md §12) — 임시 폴더 3,000통·스레드 2,000개. 실제 위키는 부르지 않는다.
// 다른 단위 시험과 함께 돌면 서로 느려지므로 따로(vitest.perf.config.ts — 파일 하나씩) 돌린다. 한도는 명세 값 그대로이고,
// CI(환경 변수 CI)나 느린 PC(WIKI_RADAR_PERF_SLACK=배수)에서만 3배까지 느슨하게 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MailboxService } from '../../src/main/mail/mailbox';
import { buildMailIndex, nodeMailFs, type MailFs } from '../../src/main/wiki/mailIndex';
import { mailRel, mailText, rmrf, tempWiki, writeFile } from '../unit/mailFixtures';

const SLACK = Math.min(3, Math.max(1, Number(process.env.WIKI_RADAR_PERF_SLACK) || (process.env.CI ? 3 : 1)));
const MAILS = 3000;
const THREADS = 2000;

let root = '';
const dirs: string[] = [];

beforeAll(() => {
  root = tempWiki('radar-mail-perf-');
  dirs.push(root);
  const folders = Array.from({ length: 30 }, (_, i) => `가상업체${i}`);
  for (let i = 0; i < MAILS; i++) {
    const folder = folders[i % folders.length];
    const day = String((i % 28) + 1).padStart(2, '0');
    const hour = String(8 + (i % 10)).padStart(2, '0');
    writeFile(
      root,
      mailRel(folder, `2026-09-${day}_${hour}00_보낸이_제목${i}_${i.toString(16).padStart(6, '0')}`),
      mailText({
        messageId: `perf-${i}@x`,
        subject: `${i >= THREADS ? 'RE: ' : ''}제목 ${i % THREADS} 요청 건`,
        folder,
        from: `담당${i % 50} <p${i % 50}@vendor${i % 30}.example>`,
        date: `2026-09-${day}T${hour}:00:00+09:00`,
        body: 'x'.repeat(4000),
      }),
    );
  }
});

afterAll(() => {
  while (dirs.length) rmrf(dirs.pop() as string);
});

describe(`성능(§12) — 임시 폴더 ${MAILS.toLocaleString('ko-KR')}통 (한도 ×${SLACK})`, () => {
  it('첫 색인 10초 · 증분(바뀐 것 없음) 500ms 안, 머리 읽기 0번', async () => {
    const t0 = performance.now();
    const first = await buildMailIndex({ wikiRoot: root });
    const firstMs = performance.now() - t0;
    expect(first.entries).toHaveLength(MAILS);
    expect(firstMs).toBeLessThan(10_000 * SLACK);

    const reads: string[] = [];
    const counter: MailFs = {
      readdir: (abs) => nodeMailFs.readdir(abs),
      stat: (abs) => nodeMailFs.stat(abs),
      realpath: (abs) => nodeMailFs.realpath(abs),
      readHead: (abs, bytes) => {
        reads.push(abs);
        return nodeMailFs.readHead(abs, bytes);
      },
    };
    const t1 = performance.now();
    const again = await buildMailIndex({ wikiRoot: root, cache: first.files, fs: counter });
    const againMs = performance.now() - t1;
    expect(reads).toHaveLength(0);
    expect(again.stats.reused).toBe(MAILS);
    console.info(`[perf] 첫 색인 ${Math.round(firstMs)}ms · 증분 ${Math.round(againMs)}ms`);
    expect(againMs).toBeLessThan(500 * SLACK);
  }, 120_000);

  it(`목록 질의 50ms 안(스레드 ${THREADS.toLocaleString('ko-KR')}개 · 필터·폴더·검색)`, async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mail-perf-data-'));
    dirs.push(data);
    const svc = new MailboxService({
      wikiRoot: root,
      dataDir: data,
      now: () => new Date('2026-09-23T10:00:00+09:00'),
      myAddress: () => 'owner@example.com',
      tasks: () => [],
      sent: () => [],
      onSummary: () => undefined,
      watch: () => ({ close: () => undefined }),
      cacheWriteDelayMs: 10,
    });
    try {
      await svc.start();
      const page = svc.list({ filter: 'all', offset: 0, limit: 200 });
      expect(page.total).toBe(THREADS);
      const queries = [
        { filter: 'all' as const },
        { filter: 'unread' as const },
        { filter: 'archived' as const },
        { filter: 'all' as const, folder: '가상업체7' },
        { filter: 'all' as const, query: '제목 1' },
        { filter: 'all' as const, query: '요청 건' },
        { filter: 'all' as const, query: 'vendor3' },
        { filter: 'all' as const, query: '없는검색어', includeMuted: true },
      ];
      // 한 번 데운 뒤 잰다(검색 입력마다 부르는 경로)
      for (const q of queries) svc.list({ ...q, offset: 0, limit: 200 });
      const times: number[] = [];
      for (let round = 0; round < 5; round++) {
        for (const q of queries) {
          const t = performance.now();
          svc.list({ ...q, offset: 0, limit: 200 });
          times.push(performance.now() - t);
        }
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)];
      const worst = times[times.length - 1];
      console.info(`[perf] 목록 질의 중앙값 ${median.toFixed(1)}ms · 최대 ${worst.toFixed(1)}ms`);
      expect(median).toBeLessThan(50 * SLACK);
      // 한 번쯤 GC 가 끼어도 되게 가장 느린 것은 3배까지
      expect(worst).toBeLessThan(150 * SLACK);
    } finally {
      svc.stop();
    }
  }, 120_000);
});
