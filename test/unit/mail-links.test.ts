// 메일 ↔ 할 일·VOC·발송 기록 연결(docs/stage2.10-contract.md §4).
import { describe, expect, it } from 'vitest';
import type { MailIndexEntry, SentMailRecord, Task } from '../../src/shared/types';
import { computeMailLinks } from '../../src/main/mail/mailLinks';
import type { MailMark } from '../../src/main/mail/mailState';
import { buildThreads, parseMailHead } from '../../src/main/wiki/mailIndex';
import { mailRel, mailText } from './mailFixtures';

function entry(id: string, subject: string, date: string, over: Partial<MailIndexEntry> = {}): MailIndexEntry {
  const folder = over.folder ?? '한결케미칼';
  const head = parseMailHead(mailRel(folder, id), mailText({ subject, date, messageId: `${id}@x`, folder }));
  return { ...head, size: 1, mtimeMs: 1, ...over };
}

const A = entry('a', '통영공장 CMS 인벤토리 사용량 확인 요청', '2026-09-12T09:00:00+09:00');
const B = entry('b', 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청', '2026-09-15T09:00:00+09:00');
const ME = entry('m', 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청', '2026-09-16T09:00:00+09:00', { folder: '내 메모', mine: true });
const C = entry('c', 'RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', '2026-09-22T09:00:00+09:00');
const OTHER = entry('o', '전혀 다른 메일 제목입니다', '2026-09-20T09:00:00+09:00', { folder: '대륙물산' });
const ENTRIES = [A, B, ME, C, OTHER];
const THREADS = buildThreads(ENTRIES);
const threadOf = (key: string) => THREADS.find((t) => t.mailKeys.includes(key))!;

const task = (over: Partial<Task>): Task => ({ id: 'c:t1', source: 'checkbox', title: '회신', status: 'open', bucket: 'thisWeek', ...over });

const sent = (over: Partial<SentMailRecord>): SentMailRecord => ({
  id: 's1',
  at: '2026-09-23T01:00:00Z',
  taskId: '',
  taskTitle: '',
  mail: B.path,
  to: ['ehs@hangyeol.example'],
  cc: [],
  bcc: [],
  subject: 'RE: x',
  messageId: 'mid@x',
  origin: 'mailbox',
  ...over,
});

function run(opts: { tasks?: Task[]; marks?: Record<string, MailMark>; sent?: SentMailRecord[] }) {
  return computeMailLinks({
    entries: ENTRIES,
    threads: THREADS,
    tasks: opts.tasks ?? [],
    marks: (k) => opts.marks?.[k],
    sent: opts.sent ?? [],
  });
}

describe('computeMailLinks', () => {
  it('task.mail 경로로 연결 · 줄의 [voc::]', () => {
    const t = task({ mail: B.path, rawLine: '- [ ] 회신 #내할일 [voc:: VOC-2026-0001]' });
    const r = run({ tasks: [t] });
    expect(r.byMail.get(B.key)?.tasks.map((x) => x.id)).toEqual(['c:t1']);
    expect(r.byMail.get(A.key)?.tasks).toEqual([]);
    const th = threadOf(B.key);
    expect(r.rowLinks.get(th.id)).toMatchObject({ tasks: 1, voc: 'VOC-2026-0001' });
    expect(r.threadLinks.get(th.id)?.tasks).toEqual([{ taskId: 'c:t1', title: '회신', status: 'open', mail: B.path }]);
  });

  it('task.thread 가 threadKey 와 같으면 경로가 달라도 연결(메일함을 옮긴 경우)', () => {
    const t = task({ mail: 'raw/mail/_미분류/2026/옛경로.md', thread: '통영공장 CMS 인벤토리 사용량 확인 요청' });
    const r = run({ tasks: [t] });
    expect(r.byMail.get(A.key)?.tasks).toHaveLength(1);
    expect(r.byMail.get(C.key)?.tasks).toHaveLength(1);
    expect(r.byMail.get(OTHER.key)?.tasks).toHaveLength(0);
  });

  it('흔한 제목의 [thread::] 는 연결하지 않는다', () => {
    const r = run({ tasks: [task({ thread: '문의' })] });
    for (const e of ENTRIES) expect(r.byMail.get(e.key)?.tasks).toHaveLength(0);
  });

  it('mark.voc·mark.task', () => {
    const r = run({ marks: { [OTHER.key]: { voc: { number: 'VOC-2026-0200', ticketId: 200, at: 'x' }, task: { file: '_private/mgmt/내 할 일.md', at: 'x' } } } });
    expect(r.byMail.get(OTHER.key)?.voc).toEqual(['VOC-2026-0200']);
    expect(r.byMail.get(OTHER.key)?.taskFile).toBe('_private/mgmt/내 할 일.md');
    expect(r.rowLinks.get(threadOf(OTHER.key).id)).toEqual({ tasks: 1, voc: 'VOC-2026-0200' });
  });

  it('발송 기록: 스레드의 메일 경로로 보낸 것 · 최근 받은 메일 뒤면 sent', () => {
    const late = run({ sent: [sent({ at: '2026-09-23T01:00:00Z' })] });
    const th = threadOf(B.key);
    expect(late.rowLinks.get(th.id)?.replied).toBe('sent');
    expect(late.threadLinks.get(th.id)?.sent).toHaveLength(1);
    expect(late.byMail.get(B.key)?.sent).toHaveLength(1);
    // 마지막 받은 메일(9/22)보다 앞에 보냈으면 sent 아님 — 9/16 내 사본도 9/22 앞이라 guess 도 아님
    const early = run({ sent: [sent({ at: '2026-09-16T01:00:00Z' })] });
    expect(early.rowLinks.get(th.id)?.replied).toBeUndefined();
  });

  it('회신 추정: 같은 스레드에 늦은 내 사본', () => {
    const r = run({});
    expect(r.byMail.get(B.key)?.replyGuess).toBe(ME.date);
    expect(r.byMail.get(A.key)?.replyGuess).toBe(ME.date);
    expect(r.byMail.get(C.key)?.replyGuess).toBeUndefined();
    // 스레드 줄은 가장 최근 받은 메일(C) 뒤의 내 사본만 본다
    expect(r.rowLinks.get(threadOf(B.key).id)?.replied).toBeUndefined();
    const onlyFirst = computeMailLinks({ entries: [A, B, ME], threads: buildThreads([A, B, ME]), tasks: [], marks: () => undefined, sent: [] });
    const th = buildThreads([A, B, ME])[0];
    expect(onlyFirst.rowLinks.get(th.id)?.replied).toBe('guess');
    expect(onlyFirst.threadLinks.get(th.id)?.replyGuess).toBe(ME.date);
  });
});
