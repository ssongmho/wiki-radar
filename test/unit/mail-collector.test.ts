// 2.15단계 §A-1~3·§A-6 메일 보관소·가져오기·옮기기·수집기 — 가짜 POP3(127.0.0.1)와 fixture 위키 임시 복사본만.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailCollectStatus } from '../../src/shared/types';
import { MailCollector } from '../../src/main/mail/collector';
import { MailCollectState, mailBaseList, storeMailRoot } from '../../src/main/mail/mailStore';
// @ts-expect-error — 시험용 .mjs(타입 없음)
import { startFakePop3 } from '../fixtures/fake-pop3-server.mjs';

const FIXTURE_WIKI = path.join(__dirname, '..', 'fixtures', 'wiki');
const USER = 'radar@example.com';
const PASS = 'pop3-secret-1';

interface FakePop3 {
  port: number;
  commands: string[];
  mails: { uid: string; raw: string }[];
  close(): Promise<void>;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await (cleanups.pop() as () => Promise<void> | void)();
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** fixture 위키 임시 복사본 + 수집기 state.json·rules.txt */
function wikiCopy(seen: string[] = []): string {
  const w = path.join(tmp('radar-collect-wiki-'), 'WIKI');
  fs.cpSync(FIXTURE_WIKI, w, { recursive: true });
  fs.mkdirSync(path.join(w, '_mail-ingest'), { recursive: true });
  fs.writeFileSync(path.join(w, '_mail-ingest', 'state.json'), JSON.stringify({ seen, last_run: null }));
  fs.writeFileSync(path.join(w, '_mail-ingest', 'rules.txt'), 'from@ | daeryuk.example | 대륙물산\nfrom@ | spam.example | 휴지통\n');
  return w;
}

function rawMail(n: number, opts: { from?: string; date?: string; subject?: string } = {}): string {
  return [
    `From: ${opts.from ?? `박담당 <park@daeryuk.example>`}`,
    'To: radar@example.com',
    `Subject: ${opts.subject ?? `=?UTF-8?B?${Buffer.from(`새 문의 ${n}`).toString('base64')}?=`}`,
    `Date: ${opts.date ?? 'Mon, 19 Oct 2026 09:00:00 +0900'}`,
    `Message-ID: <new-${n}@daeryuk.example>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `본문 ${n}`,
    '.점으로 시작하는 줄',
    '',
  ].join('\r\n');
}

async function fakePop3(mails: { uid: string; raw: string }[], extra: Record<string, unknown> = {}): Promise<FakePop3> {
  const s = (await startFakePop3({ user: USER, pass: PASS, mails, ...extra })) as FakePop3;
  cleanups.push(() => s.close());
  return s;
}

function collector(opts: { wiki: string | null; dataDir: string; port: number; enabled?: boolean; firstDate?: string; archiveRoot?: string; statuses?: MailCollectStatus[]; bases?: string[][] }): MailCollector {
  return new MailCollector({
    dataDir: opts.dataDir,
    wikiRoot: () => opts.wiki,
    settings: () => ({ enabled: opts.enabled ?? true, intervalMinutes: 10, ...(opts.firstDate ? { firstDate: opts.firstDate } : {}) }),
    account: () => ({ ok: true, account: { host: '127.0.0.1', port: opts.port, ssl: false, user: USER, pass: PASS } }),
    env: process.env,
    now: () => new Date('2026-10-19T12:00:00Z'),
    today: () => '2026-10-19',
    contributor: () => '홍길동',
    onStatus: (s) => opts.statuses?.push(s),
    manual: true,
  });
}

/** 폴더 아래 파일(상대경로, 정렬) */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out.sort();
}

describe('보관소', () => {
  it('메일함이 읽는 곳은 앱 데이터 메일 보관소 하나(위키 raw/mail 은 읽지 않는다)', () => {
    const data = tmp('radar-collect-data-');
    expect(mailBaseList(data)).toEqual([path.join(data, 'mail-store')]);
  });

  it('수집 상태 파일: seen 저장·다시 읽기, 깨진 파일은 옆에 남기고 새로', () => {
    const data = tmp('radar-collect-data-');
    const a = new MailCollectState(data);
    a.addSeen(['b', 'a', 'a']);
    a.update({ lastRun: 'x' });
    a.save();
    const b = new MailCollectState(data);
    expect(b.get().seen).toEqual(['a', 'b']);
    expect(b.hasSeen('a')).toBe(true);
    fs.writeFileSync(path.join(data, 'mail-collect.json'), '{broken');
    const warns: string[] = [];
    const c = new MailCollectState(data, (m) => warns.push(m));
    expect(c.seenCount()).toBe(0);
    expect(warns[0]).toMatch(/깨져/);
    expect(fs.readdirSync(data).some((f) => f.startsWith('mail-collect.json.broken-'))).toBe(true);
  });
});

describe('수집기', () => {
  it('첫 회: seen·규칙 이어받기(옛 메일은 복사하지 않음) → 새 것만 RETR → 보관소에 쓰기, DELE 없음', async () => {
    const wiki = wikiCopy(['old-1']);
    const data = tmp('radar-collect-data-');
    const server = await fakePop3([
      { uid: 'old-1', raw: rawMail(0) },
      { uid: 'new-1', raw: rawMail(1) },
      { uid: 'new-2', raw: rawMail(2, { from: 'x@spam.example' }) },
      { uid: 'old-date', raw: rawMail(3, { date: 'Mon, 1 Jan 2024 09:00:00 +0900' }) },
    ]);
    const wikiFilesBefore = filesUnder(path.join(wiki, 'raw', 'mail'));
    const c = collector({ wiki, dataDir: data, port: server.port, firstDate: '2026-01-01' });
    c.start();
    const st = await c.runNow();
    expect(st.state).toBe('idle');
    expect(st.lastCount).toBe(1);
    expect(st.store.newMail).toBe(path.join(data, 'mail-store'));
    expect(c.mailBases()).toEqual([path.join(data, 'mail-store')]);
    // 옛 메일은 복사하지 않았다 — 보관소에는 새로 받은 메일(+첨부)만, 위키는 그대로
    expect(filesUnder(storeMailRoot(data)).filter((f) => !f.startsWith('_original/')).every((f) => f.includes('새 문의'))).toBe(true);
    expect(filesUnder(path.join(wiki, 'raw', 'mail'))).toEqual(wikiFilesBefore);
    // RETR 은 새 것만(old-1 은 이어받은 seen), DELE·RSET 없음
    expect(server.commands.filter((x) => x.startsWith('RETR'))).toEqual(['RETR 2', 'RETR 3', 'RETR 4']);
    expect(server.commands.some((x) => /^(DELE|RSET)/.test(x))).toBe(false);
    // 규칙(앱 데이터로 복사됨)으로 분류: 대륙물산, 휴지통·기간 밖은 쓰지 않고 받은 것으로만
    expect(fs.existsSync(path.join(data, 'mail-rules.txt'))).toBe(true);
    const written = filesUnder(path.join(storeMailRoot(data), '대륙물산')).filter((f) => f.includes('새 문의 1'));
    expect(written).toHaveLength(1);
    const text = fs.readFileSync(path.join(storeMailRoot(data), '대륙물산', ...written[0].split('/')), 'utf8');
    expect(text).toContain('contributors: [홍길동]');
    expect(text).toContain('본문 1\n.점으로 시작하는 줄');
    expect(c.state.get().seen).toEqual(['new-1', 'new-2', 'old-1', 'old-date']);
    // 다음 회: 새 것 없음
    server.commands.length = 0;
    const again = await c.runNow();
    expect(again.lastCount).toBe(0);
    expect(server.commands.some((x) => x.startsWith('RETR'))).toBe(false);
    c.stop();
  });

  it('한 통 실패는 그 통만 건너뛰고 다음 회에 다시', async () => {
    const data = tmp('radar-collect-data-');
    const server = await fakePop3([{ uid: 'a', raw: rawMail(1) }, { uid: 'b', raw: rawMail(2) }], { retrFail: [1] });
    const c = collector({ wiki: null, dataDir: data, port: server.port, firstDate: '2026-01-01' });
    const st = await c.runNow();
    expect(st.lastCount).toBe(1);
    expect(st.lastError).toMatch(/1통을 받지 못했습니다/);
    expect(c.state.hasSeen('a')).toBe(false);
    expect(c.state.hasSeen('b')).toBe(true);
  });

  it('꺼져 있으면 연결하지 않는다 · 로그인 실패는 error 상태(비밀번호는 문장에 없음)', async () => {
    const data = tmp('radar-collect-data-');
    const server = await fakePop3([{ uid: 'a', raw: rawMail(1) }]);
    const off = collector({ wiki: null, dataDir: data, port: server.port, enabled: false });
    expect((await off.runNow()).state).toBe('off');
    expect(server.commands).toHaveLength(0);
    const bad = new MailCollector({
      dataDir: data,
      wikiRoot: () => null,
      settings: () => ({ enabled: true, intervalMinutes: 10 }),
      account: () => ({ ok: true, account: { host: '127.0.0.1', port: server.port, ssl: false, user: USER, pass: 'wrong-pass-123' } }),
      env: process.env,
      now: () => new Date(),
      today: () => '2026-10-19',
      manual: true,
    });
    const st = await bad.runNow();
    expect(st.state).toBe('error');
    expect(st.problem).toMatch(/로그인 실패/);
    expect(JSON.stringify(st)).not.toContain('wrong-pass-123');
  });

  it('시험 중에는 루프백 밖 서버에 나가지 않는다', async () => {
    const data = tmp('radar-collect-data-');
    const c = new MailCollector({
      dataDir: data,
      wikiRoot: () => null,
      settings: () => ({ enabled: true, intervalMinutes: 10 }),
      account: () => ({ ok: true, account: { host: 'pop3s.mailhost.test', port: 995, ssl: true, user: USER, pass: PASS } }),
      env: process.env,
      now: () => new Date(),
      today: () => '2026-10-19',
      manual: true,
    });
    const st = await c.runNow();
    expect(st.lastError).toMatch(/시험 중에는/);
  });
});

describe('보낸 메일 저장', () => {
  /** nodemailer 로 보낸 것과 같은 꼴의 원문(첨부 하나) */
  async function sentRaw(): Promise<Buffer> {
    const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
    return new MailComposer({
      from: { name: '홍길동', address: USER },
      to: '박담당 <park@daeryuk.example>',
      subject: 'RE: 자재 단가 문의 드립니다',
      messageId: '<sent-1@example.com>',
      inReplyTo: '<dr-1@daeryuk.example>',
      date: new Date('2026-10-19T03:00:00Z'),
      text: '단가표 보내 드립니다.\r\n감사합니다.',
      attachments: [{ filename: '단가표.xlsx', content: Buffer.from('XLSX') }],
      newline: 'win',
    })
      .compile()
      .build();
  }

  it('보낸 원문 → 보관소 보낸 편지함(본문·첨부·In-Reply-To), 같은 것은 다시 쓰지 않는다', async () => {
    const data = tmp('radar-collect-data-');
    let refreshed = 0;
    const c = new MailCollector({
      dataDir: data,
      wikiRoot: () => null,
      settings: () => ({ enabled: true, intervalMinutes: 10 }),
      account: () => ({ ok: false, problem: 'x' }),
      env: process.env,
      now: () => new Date('2026-10-19T12:00:00Z'),
      today: () => '2026-10-19',
      contributor: () => '홍길동',
      onNewMail: () => refreshed++,
      manual: true,
    });
    const raw = await sentRaw();
    const rel = c.saveSent(raw);
    expect(rel).toMatch(/^보낸 편지함\/2026\/2026-10-19_1200_홍길동_RE 자재 단가 문의 드립니다_[0-9a-f]{6}\.md$/);
    const text = fs.readFileSync(path.join(storeMailRoot(data), ...rel.split('/')), 'utf8');
    expect(text).toContain('folder: "보낸 편지함"');
    expect(text).toContain('in_reply_to: "<dr-1@daeryuk.example>"');
    expect(text).toContain('단가표 보내 드립니다.\n감사합니다.');
    expect(text).toMatch(/- \[단가표\.xlsx\]\(_attachments\/[0-9a-f]{6}\/단가표\.xlsx\) — 4 bytes/);
    expect(text).not.toContain('suspicion');
    const att = filesUnder(path.join(storeMailRoot(data), '_attachments'));
    expect(att).toHaveLength(1);
    expect(fs.readFileSync(path.join(storeMailRoot(data), '_attachments', ...att[0].split('/')), 'utf8')).toBe('XLSX');
    expect(refreshed).toBe(1);
    expect(c.saveSent(raw)).toBe(rel);
    expect(refreshed).toBe(1);
  });

  it('수집: 숨은참조로 돌아온 내 사본은 이미 남긴 것이면 쓰지 않고, 아니면 규칙 없이도 보낸 편지함', async () => {
    const data = tmp('radar-collect-data-');
    const raw = (await sentRaw()).toString('latin1');
    const other = raw.replace('<sent-1@example.com>', '<sent-2@example.com>');
    const server = await fakePop3([
      { uid: 'own-1', raw },
      { uid: 'own-2', raw: other },
    ]);
    const c = new MailCollector({
      dataDir: data,
      wikiRoot: () => null,
      settings: () => ({ enabled: true, intervalMinutes: 10, firstDate: '2026-01-01' }),
      account: () => ({ ok: true, account: { host: '127.0.0.1', port: server.port, ssl: false, user: USER, pass: PASS } }),
      env: process.env,
      now: () => new Date('2026-10-19T12:00:00Z'),
      today: () => '2026-10-19',
      isOwnSent: (mid) => mid === 'sent-1@example.com',
      manual: true,
    });
    const st = await c.runNow();
    expect(st.lastCount).toBe(1);
    const memo = filesUnder(path.join(storeMailRoot(data), '보낸 편지함'));
    expect(memo).toHaveLength(1);
    expect(fs.readFileSync(path.join(storeMailRoot(data), '보낸 편지함', ...memo[0].split('/')), 'utf8')).toContain('message_id: "sent-2@example.com"');
  });
});
