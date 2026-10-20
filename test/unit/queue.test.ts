// 반영 대기열 저장소(queue.json) — 원자적 쓰기, 깨진 파일 복구, 같은 taskId 교체, 오래된 것부터.
// 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_FILE, QueueStore, writeJsonAtomic, type NewQueueItem } from '../../src/main/queue';
import type { QueueItem } from '../../src/shared/types';

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-queue-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function task(taskId: string, note: string, extra: Partial<NewQueueItem> = {}): NewQueueItem {
  return { kind: 'task', taskId, title: `제목 ${taskId}`, status: 'done', note, ...extra };
}

function readQueueFile(dir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8'));
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('QueueStore 기본 동작', () => {
  it('파일이 없으면 빈 대기열이고 경고가 없다', () => {
    const dir = tempDir();
    const warns: string[] = [];
    const q = new QueueStore(dir, (m) => warns.push(m));
    expect(q.list()).toEqual([]);
    expect(warns).toEqual([]);
    expect(fs.existsSync(path.join(dir, QUEUE_FILE))).toBe(false);
  });

  it('추가하면 id(UUID)·createdAt 을 채워 저장하고, 다시 열어도 그대로다', () => {
    const dir = path.join(tempDir(), '아직 없는 폴더');
    const q = new QueueStore(dir);
    const added = q.add(task('c:abc', '처리함', { company: '한결케미칼', mail: 'raw/mail/한결케미칼/x.md', owner: '' }));
    expect(added.id).toMatch(UUID_RE);
    expect(Number.isNaN(Date.parse(added.createdAt))).toBe(false);
    expect(added.company).toBe('한결케미칼');
    expect('owner' in added).toBe(false); // 빈 선택 필드는 저장하지 않는다
    expect(readQueueFile(dir)).toEqual([added]);
    expect(new QueueStore(dir).list()).toEqual([added]);
    expect(leftovers(dir)).toEqual([]);
  });

  it('목록은 오래된 것부터다(넣은 순서와 달라도)', () => {
    const q = new QueueStore(tempDir());
    q.add(task('b', '둘째', { createdAt: '2026-09-23T02:00:00.000Z' }));
    q.add(task('a', '첫째', { createdAt: '2026-09-23T01:00:00.000Z' }));
    q.add(task('c', '셋째', { createdAt: '2026-09-23T03:00:00.000Z' }));
    expect(q.list().map((x) => x.taskId)).toEqual(['a', 'b', 'c']);
  });

  it('같은 taskId(kind task)는 새 것으로 교체되고 맨 뒤로 간다', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    const first = q.add(task('c:1', '처음 메모', { createdAt: '2026-09-23T01:00:00.000Z' }));
    q.add(task('c:2', '다른 항목', { createdAt: '2026-09-23T02:00:00.000Z' }));
    const second = q.add(task('c:1', '고친 메모', { status: 'notmine', owner: '김대리', createdAt: '2026-09-23T03:00:00.000Z' }));
    const list = q.list();
    expect(list.map((x) => [x.taskId, x.note])).toEqual([
      ['c:2', '다른 항목'],
      ['c:1', '고친 메모'],
    ]);
    expect(second.id).not.toBe(first.id);
    expect(list.find((x) => x.id === first.id)).toBeUndefined();
    expect(new QueueStore(dir).list()).toEqual(list);
  });

  it('decision 항목·taskId 없는 항목은 서로 교체하지 않는다', () => {
    const q = new QueueStore(tempDir());
    q.add({ kind: 'decision', title: '결정 1', note: '보류', context: '2026-09-20 로그' });
    q.add({ kind: 'decision', title: '결정 2', note: '진행' });
    q.add({ kind: 'decision', taskId: 'x', title: '결정 3', note: '가' });
    q.add({ kind: 'decision', taskId: 'x', title: '결정 4', note: '나' });
    q.add(task('x', '할 일')); // kind 가 다르면 같은 taskId 라도 교체하지 않는다
    expect(q.list().map((x) => x.title)).toEqual(['결정 1', '결정 2', '결정 3', '결정 4', '제목 x']);
  });

  it('같은 id 로 넣으면 그 항목을 바꾼다', () => {
    const q = new QueueStore(tempDir());
    q.add({ id: 'fixed', kind: 'decision', title: '처음', note: '' });
    q.add({ id: 'fixed', kind: 'decision', title: '다시', note: '' });
    expect(q.list().map((x) => x.title)).toEqual(['다시']);
  });

  it('remove·removeMany 는 남은 목록을 돌려주고 저장한다. 없는 id 는 무시한다', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    const a = q.add(task('a', '1', { createdAt: '2026-09-23T01:00:00.000Z' }));
    const b = q.add(task('b', '2', { createdAt: '2026-09-23T02:00:00.000Z' }));
    const c = q.add(task('c', '3', { createdAt: '2026-09-23T03:00:00.000Z' }));
    expect(q.remove(b.id).map((x) => x.id)).toEqual([a.id, c.id]);
    expect(q.remove('없는-id').map((x) => x.id)).toEqual([a.id, c.id]);
    expect(q.removeMany([a.id, c.id, '없는-id'])).toEqual([]);
    expect(readQueueFile(dir)).toEqual([]);
    expect(new QueueStore(dir).list()).toEqual([]);
  });

  it('돌려준 목록을 바꿔도 저장소는 바뀌지 않는다', () => {
    const q = new QueueStore(tempDir());
    q.add(task('a', '원래'));
    const list = q.list();
    list[0].note = '밖에서 고침';
    list.pop();
    expect(q.list().map((x) => x.note)).toEqual(['원래']);
  });

  it('회신 본문(reply)을 저장하고 다시 읽는다. 빈 reply 는 저장하지 않는다(2.5단계)', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    const body = '안녕하세요.\n요청하신 인벤토리 확인 결과를 보내드립니다.\n\n감사합니다.';
    const withReply = q.add(task('c:mail', '회신함', { reply: body, mail: 'raw/mail/한결케미칼/x.md' }));
    const noReply = q.add(task('c:plain', '회신 없음', { reply: '' }));
    expect(withReply.reply).toBe(body);
    expect('reply' in noReply).toBe(false);
    const again = new QueueStore(dir).list();
    expect(again.find((x) => x.taskId === 'c:mail')?.reply).toBe(body);
    expect(again.find((x) => x.taskId === 'c:plain')).not.toHaveProperty('reply');
    expect((readQueueFile(dir) as QueueItem[]).find((x) => x.taskId === 'c:mail')?.reply).toBe(body);
  });

  it('같은 할 일을 reply 없이 다시 넣으면 앞 항목의 reply(보낸 회신 본문)를 이어받는다 — 새 reply 가 있으면 새 것', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    const sentBody = '안녕하세요.\n8월분 반영을 확인했습니다.';
    // 보내고 저장(진행 중) → 대기열에 reply 와 함께
    q.add(task('c:mail', '확인 중\n메일 회신 발송 — 받는사람: 김담당 · 제목: RE: 건', { status: 'wip', reply: sentBody }));
    // 나중에 [저장](완료) — IPC saveResult 는 reply 를 넘기지 않는다
    const resaved = q.add(task('c:mail', '완료', { status: 'done' }));
    expect(resaved.reply).toBe(sentBody);
    expect(q.list()).toHaveLength(1);
    expect(q.list()[0]).toMatchObject({ taskId: 'c:mail', note: '완료', status: 'done', reply: sentBody });
    expect(new QueueStore(dir).list()[0].reply, '파일에도 이어받은 reply').toBe(sentBody);
    // 새로 보낸 회신은 새 본문으로 바꾼다
    q.add(task('c:mail', '다시 보냄', { reply: '두 번째 회신' }));
    expect(q.list()[0].reply).toBe('두 번째 회신');
    // 다른 할 일·decision 은 이어받지 않는다
    expect(q.add(task('c:other', '다른 일')).reply).toBeUndefined();
    const decision = q.add({ kind: 'decision', title: '결정', note: '승인' });
    expect(decision.reply).toBeUndefined();
  });

  it('reply 가 문자열이 아닌 항목은 형식이 틀린 것으로 본다', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    expect(() => q.add(task('c:bad', 'x', { reply: 42 as unknown as string }))).toThrow(/형식/);
    const good: QueueItem = { id: 'g', kind: 'task', createdAt: '2026-09-28T00:00:00.000Z', title: '좋음', note: '', reply: '본문' };
    fs.writeFileSync(path.join(dir, QUEUE_FILE), JSON.stringify([good, { ...good, id: 'b', reply: ['배열'] }]), 'utf8');
    const warns: string[] = [];
    expect(new QueueStore(dir, (m) => warns.push(m)).list()).toEqual([good]);
    expect(warns[0]).toMatch(/1건/);
  });

  it('형식이 틀린 항목은 넣지 않는다', () => {
    const q = new QueueStore(tempDir());
    expect(() => q.add({ kind: 'bogus' as unknown as 'task', title: 't', note: '' })).toThrow(/형식/);
    expect(() => q.add({ kind: 'task', title: 't', note: '', status: 'closed' as unknown as 'done' })).toThrow(/형식/);
    expect(q.list()).toEqual([]);
  });
});

describe('QueueStore 깨진 파일 복구', () => {
  it('JSON 이 아니면 .broken-<시각> 으로 옮기고 빈 상태로 시작하며 경고한다', () => {
    const dir = tempDir();
    const file = path.join(dir, QUEUE_FILE);
    fs.writeFileSync(file, '[{"id": "a", 깨짐', 'utf8');
    const warns: string[] = [];
    const q = new QueueStore(dir, (m) => warns.push(m));
    expect(q.list()).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/깨져/);
    const broken = fs.readdirSync(dir).filter((n) => n.startsWith(`${QUEUE_FILE}.broken-`));
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatch(/^queue\.json\.broken-\d{8}T\d{6}$/);
    expect(warns[0]).toContain(broken[0]);
    expect(fs.readFileSync(path.join(dir, broken[0]), 'utf8')).toBe('[{"id": "a", 깨짐');
    expect(fs.existsSync(file)).toBe(false);

    // 그 뒤 저장은 정상 파일을 만든다
    q.add(task('a', '새로'));
    expect(readQueueFile(dir)).toHaveLength(1);
  });

  it('빈 파일·배열이 아닌 JSON 도 깨진 것으로 본다. 이미 같은 이름이 있으면 번호를 붙인다', () => {
    const dir = tempDir();
    const file = path.join(dir, QUEUE_FILE);
    fs.writeFileSync(file, '', 'utf8');
    new QueueStore(dir, () => {}).list();
    fs.writeFileSync(file, '{"hello": 1}', 'utf8');
    const warns: string[] = [];
    expect(new QueueStore(dir, (m) => warns.push(m)).list()).toEqual([]);
    expect(warns[0]).toMatch(/배열이 아님/);
    const broken = fs.readdirSync(dir).filter((n) => n.startsWith(`${QUEUE_FILE}.broken-`)).sort();
    expect(broken.length).toBe(2);
  });

  it('BOM 과 { items: [...] } 꼴도 읽는다', () => {
    const dir = tempDir();
    const item: QueueItem = { id: 'x1', kind: 'task', createdAt: '2026-09-23T00:00:00.000Z', title: '제목', note: '메모' };
    fs.writeFileSync(path.join(dir, QUEUE_FILE), `﻿${JSON.stringify({ items: [item] })}`, 'utf8');
    const warns: string[] = [];
    expect(new QueueStore(dir, (m) => warns.push(m)).list()).toEqual([item]);
    expect(warns).toEqual([]);
  });

  it('일부 항목만 틀리면 맞는 것은 살리고 원래 파일을 .broken 으로 복사해 둔다', () => {
    const dir = tempDir();
    const good: QueueItem = { id: 'g', kind: 'task', createdAt: '2026-09-23T00:00:00.000Z', title: '좋음', note: '' };
    const original = JSON.stringify([good, { id: 'bad' }, 'string', null]);
    fs.writeFileSync(path.join(dir, QUEUE_FILE), original, 'utf8');
    const warns: string[] = [];
    const q = new QueueStore(dir, (m) => warns.push(m));
    expect(q.list()).toEqual([good]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/3건/);
    const broken = fs.readdirSync(dir).filter((n) => n.startsWith(`${QUEUE_FILE}.broken-`));
    expect(broken).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, broken[0]), 'utf8')).toBe(original);
  });

  it('읽을 수 없는 파일(잠김 등)은 덮어쓰지 않도록 예외를 던진다', () => {
    const dir = tempDir();
    // queue.json 자리에 폴더가 있으면 읽기가 EISDIR 로 실패한다
    fs.mkdirSync(path.join(dir, QUEUE_FILE));
    const q = new QueueStore(dir);
    expect(() => q.list()).toThrow(/읽지 못했습니다/);
    expect(() => q.add(task('a', 'x'))).toThrow(/읽지 못했습니다/);
    expect(fs.statSync(path.join(dir, QUEUE_FILE)).isDirectory()).toBe(true);
  });
});

describe('원자적 쓰기', () => {
  it('이름 바꾸기가 계속 실패하면 원래 파일과 메모리 상태를 그대로 두고 임시 파일을 지운다', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    const kept = q.add(task('a', '저장된 것'));
    const before = fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8');

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: 가짜 잠금'), { code: 'EPERM' });
    });
    expect(() => q.add(task('b', '저장 안 될 것'))).toThrow(/저장하지 못했습니다 \(EPERM\)/);
    vi.restoreAllMocks();

    expect(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8')).toBe(before);
    expect(leftovers(dir)).toEqual([]);
    expect(q.list()).toEqual([kept]);
  });

  it('이름 바꾸기가 잠깐 막혔다 풀리면 다시 해서 저장한다', () => {
    const dir = tempDir();
    const real = fs.renameSync;
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return real(from, to);
    });
    const q = new QueueStore(dir);
    q.add(task('a', '한 번 막힘'));
    expect(calls).toBe(2);
    expect(readQueueFile(dir)).toHaveLength(1);
    expect(leftovers(dir)).toEqual([]);
  });

  it('쓰는 도중(임시 파일 단계)에 멈춰도 queue.json 은 이전 내용 그대로다', () => {
    const dir = tempDir();
    const file = path.join(dir, QUEUE_FILE);
    writeJsonAtomic(file, [{ v: 1 }]);
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    expect(() => writeJsonAtomic(file, [{ v: 2 }])).toThrow(/EIO/);
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([{ v: 1 }]);
    expect(leftovers(dir)).toEqual([]);
  });

  it('여러 번 저장해도 임시 파일이 남지 않고 마지막 내용만 남는다', () => {
    const dir = tempDir();
    const q = new QueueStore(dir);
    for (let i = 0; i < 30; i++) q.add(task(`t${i % 5}`, `메모 ${i}`));
    expect(q.list()).toHaveLength(5);
    expect(readQueueFile(dir)).toEqual(q.list());
    expect(fs.readdirSync(dir)).toEqual([QUEUE_FILE]);
  });
});
