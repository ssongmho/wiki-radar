// raw/mail 증분 색인·스레드(docs/stage2.10-contract.md §2). 임시 폴더에 가짜 메일을 만들어 시험한다(실제 위키는 부르지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailIndexEntry } from '../../src/shared/types';
import {
  MAIL_HEAD_BYTES,
  buildMailIndex,
  buildThreads,
  dedupeEntries,
  isMailFileRel,
  loadMailIndexCache,
  mailIndexCacheOf,
  mailKeyOf,
  nodeMailFs,
  parseMailFileName,
  parseMailHead,
  type MailFs,
} from '../../src/main/wiki/mailIndex';
import { mailRel, mailText, rmrf, tempWiki, writeFile } from './mailFixtures';

const roots: string[] = [];
function wiki(): string {
  const r = tempWiki();
  roots.push(r);
  return r;
}
afterEach(() => {
  while (roots.length) rmrf(roots.pop() as string);
});

/** 머리 읽기 횟수를 세는 파일 시스템 */
function countingFs(): MailFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readdir: (abs) => nodeMailFs.readdir(abs),
    stat: (abs) => nodeMailFs.stat(abs),
    realpath: (abs) => nodeMailFs.realpath(abs),
    readHead: (abs, bytes) => {
      reads.push(abs);
      return nodeMailFs.readHead(abs, bytes);
    },
  };
}

describe('parseMailHead', () => {
  it('목록 to·cc·suspicion·따옴표·첨부 수', () => {
    const text = mailText({
      subject: 'RE: "견적" 확인 요청',
      from: '"김 담당" <Kim@Vendor.example>',
      to: ['owner@example.com', '박담당 <park@vendor.example>'],
      cc: ['a@vendor.example', 'b@vendor.example'],
      messageId: '<ABC-1@Vendor.example>',
      uidl: 'U1',
      attachments: 2,
      suspicion: ['발신 도메인 불일치'],
      folder: '가상상사',
    });
    const e = parseMailHead(mailRel('가상상사', '2026-09-15_1728_김담당_견적_aaaaaa'), text);
    expect(e.subject).toBe('RE: "견적" 확인 요청');
    expect(e.from).toBe('"김 담당" <Kim@Vendor.example>');
    expect(e.fromName).toBe('김 담당');
    expect(e.fromAddr).toBe('Kim@Vendor.example');
    expect(e.to).toEqual(['owner@example.com', '박담당 <park@vendor.example>']);
    expect(e.ccCount).toBe(2);
    expect(e.attachments).toBe(2);
    expect(e.suspicious).toBe(true);
    expect(e.messageId).toBe('ABC-1@Vendor.example');
    expect(e.uidl).toBe('U1');
    expect(e.threadKey).toBe('"견적" 확인 요청');
    expect(e.dateMs).toBe(Date.parse('2026-09-15T17:28:40+09:00'));
    expect(e.problem).toBeUndefined();
  });

  it('옛 파일(uidl·cc 없음)·격리·노이즈·내 메모', () => {
    const old = parseMailHead(mailRel('_격리', 'x'), mailText({ folder: '_격리', messageId: 'id@x' }));
    expect(old.uidl).toBeUndefined();
    expect(old.ccCount).toBe(0);
    expect(old.suspicious).toBe(true);
    expect(parseMailHead(mailRel('_노이즈-추정', 'x'), mailText({ folder: '_노이즈-추정' })).muted).toBe(true);
    expect(parseMailHead(mailRel('내 메모', 'x'), mailText({ folder: '내 메모' })).mine).toBe(true);
  });

  it('frontmatter 가 없거나 닫히지 않으면 problem + 파일 이름에서 날짜·보낸이·제목', () => {
    const rel = mailRel('가상상사', '2026-09-10_0930_홍길동_서버 점검 안내_abc123');
    for (const broken of ['none', 'unclosed'] as const) {
      const e = parseMailHead(rel, mailText({ broken, subject: '무시됨' }), true);
      expect(e.problem).toBeTruthy();
      expect(e.date).toBe('2026-09-10T09:30:00+09:00');
      if (broken === 'unclosed') {
        expect(e.from).toBe('홍길동');
        expect(e.subject).toBe('서버 점검 안내');
      } else {
        // frontmatter 가 없으면 첫 H1 을 제목으로 쓴다
        expect(e.subject).toBe('무시됨');
      }
      expect(e.folder).toBe('가상상사');
    }
    expect(parseMailFileName('2026-09-10_0930_홍길동_서버_점검_abc123.md')).toEqual({
      date: '2026-09-10T09:30:00+09:00',
      from: '홍길동',
      subject: '서버_점검',
    });
  });

  it('제목이 없으면 첫 H1, 그것도 없으면 (제목 없음)', () => {
    const text = '---\nfrom: "a@b.example"\nfolder: "x"\n---\n\n본문만\n';
    expect(parseMailHead(mailRel('x', 'n'), text).subject).toBe('(제목 없음)');
  });

  it('in_reply_to·references 가 있으면 읽는다', () => {
    const e = parseMailHead(mailRel('x', 'n'), mailText({ inReplyTo: '<P@X>', references: ['<A@X>', 'b@x'] }));
    expect(e.inReplyTo).toBe('p@x');
    expect(e.references).toEqual(['a@x', 'b@x']);
  });
});

describe('키', () => {
  it('Message-ID(꺾쇠·대소문자 무시) → uidl → 경로', () => {
    const a = mailKeyOf('ABC@X.example', undefined, 'raw/mail/a/2026/1.md');
    const b = mailKeyOf('<abc@x.example>', 'u9', 'raw/mail/b/2026/2.md');
    expect(a).toBe(b);
    expect(a.startsWith('m:')).toBe(true);
    expect(mailKeyOf(undefined, 'u9', 'p').startsWith('u:')).toBe(true);
    expect(mailKeyOf('', '', 'raw/mail/a/2026/1.md').startsWith('p:')).toBe(true);
    expect(a).toMatch(/^[mup]:[0-9a-f]{16}$/);
  });
});

describe('대상 경로', () => {
  it('raw/mail/<메일함>/<YYYY>/<이름>.md 만', () => {
    expect(isMailFileRel('raw/mail/가상상사/2026/a.md')).toBe(true);
    expect(isMailFileRel('raw/mail/가상상사/a.md')).toBe(false);
    expect(isMailFileRel('raw/mail/가상상사/2026/x/a.md')).toBe(false);
    expect(isMailFileRel('raw/mail/_attachments/abc123/a.md')).toBe(false);
    expect(isMailFileRel('raw/mail/가상상사/26/a.md')).toBe(false);
    expect(isMailFileRel('raw/mail/가상상사/2026/.a.md')).toBe(false);
    expect(isMailFileRel('raw/mail/가상상사/2026/a.txt')).toBe(false);
  });
});

describe('buildMailIndex', () => {
  it('깊이 규칙·_attachments 제외·같은 키 두 파일', async () => {
    const root = wiki();
    writeFile(root, mailRel('가상상사', 'a'), mailText({ messageId: 'one@x', folder: '가상상사', ingested: '2026-09-16' }));
    writeFile(root, mailRel('_노이즈-추정', 'a'), mailText({ messageId: 'ONE@x', folder: '_노이즈-추정', ingested: '2026-09-20' }));
    writeFile(root, 'raw/mail/_attachments/abc123/안내.md', mailText({ messageId: 'att@x' }));
    writeFile(root, 'raw/mail/가상상사/flat.md', mailText({ messageId: 'flat@x' }));
    writeFile(root, 'raw/mail/가상상사/2026/deep/x.md', mailText({ messageId: 'deep@x' }));
    const warns: string[] = [];
    const r = await buildMailIndex({ wikiRoot: root, warn: (m) => warns.push(m) });
    expect(r.files.map((e) => e.path).sort()).toEqual([mailRel('_노이즈-추정', 'a'), mailRel('가상상사', 'a')].sort());
    expect(r.entries).toHaveLength(1);
    // 노이즈·격리가 아닌 쪽을 고른다(ingested 가 늦어도)
    expect(r.entries[0].folder).toBe('가상상사');
    expect(r.stats.duplicates).toBe(1);
    expect(warns.some((w) => w.includes('같은 메일'))).toBe(true);
  });

  it('같은 키: ingested 늦은 쪽 → 경로 사전순 앞', () => {
    const base = parseMailHead(mailRel('a', 'x'), mailText({ messageId: 'k@x' }));
    const mk = (p: string, ingested: string): MailIndexEntry => ({ ...base, path: p, ingested, size: 1, mtimeMs: 1 });
    expect(dedupeEntries([mk('raw/mail/a/2026/1.md', '2026-09-01'), mk('raw/mail/b/2026/1.md', '2026-09-02')]).entries[0].path).toBe(
      'raw/mail/b/2026/1.md',
    );
    expect(dedupeEntries([mk('raw/mail/b/2026/1.md', '2026-09-01'), mk('raw/mail/a/2026/1.md', '2026-09-01')]).entries[0].path).toBe(
      'raw/mail/a/2026/1.md',
    );
  });

  it('링크(정션)로 raw/mail 밖을 가리키는 폴더·파일은 뺀다', async () => {
    const root = wiki();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-outside-'));
    roots.push(outside);
    writeFile(outside, '2026/secret.md', mailText({ messageId: 'out@x' }));
    writeFile(root, mailRel('가상상사', 'ok'), mailText({ messageId: 'in@x' }));
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, 'raw', 'mail', '바깥'), 'junction');
      linked = true;
    } catch {
      // 정션을 만들 수 없는 환경이면 링크 부분만 건너뛴다
    }
    const r = await buildMailIndex({ wikiRoot: root });
    expect(r.files.map((e) => e.path)).toEqual([mailRel('가상상사', 'ok')]);
    if (linked) expect(fs.existsSync(path.join(root, 'raw', 'mail', '바깥', '2026', 'secret.md'))).toBe(true);
  });

  it('raw/mail 이 없으면 MailDirMissingError', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-nomail-'));
    roots.push(root);
    await expect(buildMailIndex({ wikiRoot: root })).rejects.toThrow('raw/mail 폴더가 없습니다');
  });

  it('캐시: 바뀌지 않은 파일은 다시 읽지 않고, mtime 만 바뀐 파일은 다시 읽고, 지운 파일은 빠진다', async () => {
    const root = wiki();
    const t0 = Date.parse('2026-09-15T00:00:00Z');
    writeFile(root, mailRel('가상상사', 'a'), mailText({ messageId: 'a@x' }), t0);
    writeFile(root, mailRel('가상상사', 'b'), mailText({ messageId: 'b@x' }), t0);
    writeFile(root, mailRel('가상상사', 'c'), mailText({ messageId: 'c@x' }), t0);
    const fs1 = countingFs();
    const first = await buildMailIndex({ wikiRoot: root, fs: fs1 });
    expect(first.stats.read).toBe(3);
    expect(fs1.reads).toHaveLength(3);

    const fs2 = countingFs();
    const second = await buildMailIndex({ wikiRoot: root, fs: fs2, cache: first.files });
    expect(fs2.reads).toHaveLength(0);
    expect(second.stats).toMatchObject({ read: 0, reused: 3, removed: 0 });

    // link_raw.py 가 연결 블록만 고친 경우처럼 mtime 만 바뀜
    const absB = path.join(root, ...mailRel('가상상사', 'b').split('/'));
    fs.utimesSync(absB, new Date(t0 + 60_000), new Date(t0 + 60_000));
    fs.rmSync(path.join(root, ...mailRel('가상상사', 'c').split('/')));
    const fs3 = countingFs();
    const third = await buildMailIndex({ wikiRoot: root, fs: fs3, cache: second.files });
    expect(fs3.reads.map((p) => path.basename(p))).toEqual(['b.md']);
    expect(third.stats).toMatchObject({ read: 1, reused: 1, removed: 1, files: 2 });
  });

  it('메일함을 옮긴 파일(경로 바뀜)도 키는 그대로', async () => {
    const root = wiki();
    writeFile(root, mailRel('_미분류', 'a'), mailText({ messageId: 'move@x', folder: '_미분류' }));
    const first = await buildMailIndex({ wikiRoot: root });
    const key = first.entries[0].key;
    fs.mkdirSync(path.join(root, 'raw', 'mail', '가상상사', '2026'), { recursive: true });
    fs.renameSync(path.join(root, ...mailRel('_미분류', 'a').split('/')), path.join(root, ...mailRel('가상상사', 'a').split('/')));
    const second = await buildMailIndex({ wikiRoot: root, cache: first.files });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].key).toBe(key);
    expect(second.entries[0].path).toBe(mailRel('가상상사', 'a'));
  });

  it('16KB 를 넘는 머리는 64KB 까지 더 읽는다', async () => {
    const root = wiki();
    const long = Array.from({ length: 900 }, (_, i) => `받는사람${i}@vendor.example`);
    writeFile(root, mailRel('가상상사', 'big'), mailText({ messageId: 'big@x', to: long, subject: '큰 머리' }));
    expect(fs.statSync(path.join(root, ...mailRel('가상상사', 'big').split('/'))).size).toBeGreaterThan(MAIL_HEAD_BYTES);
    const r = await buildMailIndex({ wikiRoot: root });
    expect(r.entries[0].subject).toBe('큰 머리');
    expect(r.entries[0].to).toHaveLength(900);
    expect(r.entries[0].problem).toBeUndefined();
  });

  it('내 사본: 내 메모 또는 보내는 계정 주소', async () => {
    const root = wiki();
    writeFile(root, mailRel('가상상사', 'a'), mailText({ messageId: 'a@x', from: '나 <Owner@Example.com>' }));
    writeFile(root, mailRel('가상상사', 'b'), mailText({ messageId: 'b@x' }));
    const r = await buildMailIndex({ wikiRoot: root, myAddress: 'owner@example.com' });
    expect(r.entries.find((e) => e.messageId === 'a@x')?.mine).toBe(true);
    expect(r.entries.find((e) => e.messageId === 'b@x')?.mine).toBe(false);
  });
});

describe('buildThreads', () => {
  const entry = (over: Partial<MailIndexEntry> & { subject: string; date: string; id: string }): MailIndexEntry => {
    const head = parseMailHead(
      mailRel(over.folder ?? '가상상사', over.id),
      mailText({ subject: over.subject, date: over.date, messageId: `${over.id}@x`, folder: over.folder ?? '가상상사' }),
    );
    return { ...head, size: 1, mtimeMs: 1, ...over };
  };

  it('같은 키·60일 안은 한 스레드, 60일 넘게 떨어지면 새 스레드', () => {
    const list = [
      entry({ id: 'a', subject: '통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-09-12T09:00:00+09:00' }),
      entry({ id: 'b', subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-09-15T09:00:00+09:00' }),
      entry({ id: 'c', subject: 'RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-09-22T09:00:00+09:00' }),
      entry({ id: 'd', subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청', date: '2026-12-01T09:00:00+09:00' }),
    ];
    const threads = buildThreads(list);
    expect(threads).toHaveLength(2);
    // 최근 순
    expect(threads[0].count).toBe(1);
    expect(threads[1].count).toBe(3);
    expect(threads[1].subject).toBe('RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청');
    expect(threads[1].id).toMatch(/^th:[0-9a-f]{12}$/);
  });

  it('흔한 제목·짧은 키는 묶지 않는다', () => {
    const list = [
      entry({ id: 'a', subject: '문의', date: '2026-06-01T09:00:00+09:00' }),
      entry({ id: 'b', subject: 'RE: 문의', date: '2026-06-02T09:00:00+09:00' }),
      entry({ id: 'c', subject: 'abc', date: '2026-06-02T09:00:00+09:00' }),
      entry({ id: 'd', subject: 'abc', date: '2026-06-03T09:00:00+09:00' }),
    ];
    expect(buildThreads(list)).toHaveLength(4);
  });

  it('references 가 있으면 제목이 달라도 한 묶음', () => {
    const a = entry({ id: 'a', subject: '첫 메일 제목입니다', date: '2026-06-01T09:00:00+09:00' });
    const b = { ...entry({ id: 'b', subject: '전혀 다른 제목입니다', date: '2026-06-05T09:00:00+09:00' }), references: ['a@x'] };
    const threads = buildThreads([a, b]);
    expect(threads).toHaveLength(1);
    expect(threads[0].mailKeys).toEqual([a.key, b.key]);
  });

  it('참여자: 나 제외 최근 순 3명, 내 사본 있으면 includesMe', () => {
    const list = [
      entry({ id: 'a', subject: '같은 스레드 제목', date: '2026-06-01T09:00:00+09:00', fromName: '김담당' }),
      entry({ id: 'b', subject: 'RE: 같은 스레드 제목', date: '2026-06-02T09:00:00+09:00', fromName: '나', mine: true, folder: '내 메모' }),
      entry({ id: 'c', subject: 'RE: 같은 스레드 제목', date: '2026-06-03T09:00:00+09:00', fromName: '박담당' }),
    ];
    const [t] = buildThreads(list);
    expect(t.participants).toEqual(['박담당', '김담당']);
    expect(t.includesMe).toBe(true);
    expect(t.folders).toEqual(['가상상사', '내 메모']);
  });
});

describe('캐시 파일', () => {
  it('버전·위키가 다르거나 깨졌으면 버린다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-cache-'));
    roots.push(dir);
    const file = path.join(dir, 'mail-index.json');
    const e: MailIndexEntry = { ...parseMailHead(mailRel('a', 'x'), mailText({ messageId: 'k@x' })), size: 3, mtimeMs: 4 };
    fs.writeFileSync(file, JSON.stringify(mailIndexCacheOf('C:/wiki', [e], new Date())));
    expect(loadMailIndexCache(file, 'C:/wiki')).toHaveLength(1);
    expect(loadMailIndexCache(file, 'C:/other')).toEqual([]);
    fs.writeFileSync(file, '{ 깨짐');
    expect(loadMailIndexCache(file, 'C:/wiki')).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ ...mailIndexCacheOf('C:/wiki', [e], new Date()), version: 2 }));
    expect(loadMailIndexCache(file, 'C:/wiki')).toEqual([]);
  });
});

// 성능(§12 — 3,000통 첫 색인·증분·목록 질의)은 test/perf/mail-perf.test.ts 에서 따로 돌린다(다른 시험과 함께 돌면 서로 느려진다)
