// 위키 감시(fs.watch recursive 하나) — 폴더 이름 바꾸기가 막히지 않는지, 루트가 늦게 생겨도 붙는지, 백오프.
// 테스트 사본을 임시 폴더에 복사해서만 바꾼다(원본 fixture·실제 위키는 건드리지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WATCHED_SPECIAL_FILES } from '../../src/main/config';
import { createPathFilter, createRetryBackoff, startWikiWatcher, type WikiWatcher } from '../../src/main/watcher';
import { EXCLUDED_DIRS } from '../../src/main/wiki/fsutil';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const temps: string[] = [];
const watchers: WikiWatcher[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function copyFixture(): string {
  const dir = tempDir('wiki-radar-watch-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

async function waitFor(cond: () => boolean, timeoutMs = 5_000, label = '조건'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 안에 ${label}이 참이 되지 않았다`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function watch(root: string, extra: Partial<Parameters<typeof startWikiWatcher>[0]> = {}) {
  const settled: number[] = [];
  const errors: unknown[] = [];
  const watching: boolean[] = [];
  const w = startWikiWatcher({
    wikiRoot: root,
    excludedDirs: EXCLUDED_DIRS,
    specialFiles: WATCHED_SPECIAL_FILES,
    debounceMs: 150,
    retryMs: 150,
    onSettled: () => settled.push(Date.now()),
    onError: (err) => errors.push(err),
    onWatching: ({ late }) => watching.push(late),
    ...extra,
  });
  watchers.push(w);
  return { w, settled, errors, watching };
}

afterEach(async () => {
  vi.useRealTimers();
  while (watchers.length) await (watchers.pop() as WikiWatcher).close();
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('경로 판정', () => {
  const root = 'C:\\vault';
  const { isRelevantFile, isRelevantDirEvent } = createPathFilter({
    wikiRoot: root,
    excludedDirs: EXCLUDED_DIRS,
    specialFiles: WATCHED_SPECIAL_FILES,
  });

  it('.md 와 특별 파일만, 제외 폴더 안은 특별 파일만', () => {
    expect(isRelevantFile(path.join(root, 'wiki', 'a.md'))).toBe(true);
    expect(isRelevantFile(path.join(root, 'wiki', 'A.MD'))).toBe(true);
    expect(isRelevantFile(path.join(root, 'wiki', 'a.txt'))).toBe(false);
    expect(isRelevantFile(path.join(root, 'raw', 'mail', 'x', 'a.md'))).toBe(false);
    expect(isRelevantFile(path.join(root, '.obsidian', 'workspace.md'))).toBe(false);
    expect(isRelevantFile(path.join(root, '_todo-sync', 'items.json'))).toBe(true);
    expect(isRelevantFile(path.join(root, '_todo-sync', 'backup', 'items.json'))).toBe(false);
    expect(isRelevantFile(path.join(root, '_raw-link', 'link_raw.py'))).toBe(true);
    expect(isRelevantFile(root)).toBe(false);
    expect(isRelevantFile('C:\\elsewhere\\a.md')).toBe(false);
  });

  it('폴더 이벤트: 지금 폴더이거나, 사라졌고 확장자가 없으면 폴더로 본다. 제외 폴더는 아니다', () => {
    const isDir = () => true;
    const gone = () => false;
    const isFile = () => null;
    expect(isRelevantDirEvent(path.join(root, 'wiki', 'topics2'), isDir)).toBe(true);
    expect(isRelevantDirEvent(path.join(root, 'wiki', 'topics'), gone)).toBe(true);
    expect(isRelevantDirEvent(path.join(root, 'wiki', 'note.tmp'), gone)).toBe(false);
    expect(isRelevantDirEvent(path.join(root, 'wiki', 'note.txt'), isFile)).toBe(false);
    expect(isRelevantDirEvent(path.join(root, 'raw', 'mail'), isDir)).toBe(false);
    expect(isRelevantDirEvent(path.join(root, 'backup'), isDir)).toBe(false);
    expect(isRelevantDirEvent(root, isDir)).toBe(false);
  });
});

describe('감시 동작(실제 fs.watch)', () => {
  it('.md 를 바꾸면 debounce 뒤 한 번 onSettled, 제외 폴더의 변경은 무시', async () => {
    const root = copyFixture();
    const { settled, errors, watching } = watch(root);
    expect(watching).toEqual([false]);
    await sleep(100); // 감시가 자리 잡을 시간

    fs.appendFileSync(at(root, '_private/mgmt/내 할 일.md'), '\n- [ ] 새 할 일 #내할일\n', 'utf8');
    fs.appendFileSync(at(root, '_private/mgmt/내 할 일.md'), '\n', 'utf8');
    await waitFor(() => settled.length >= 1, 5_000, 'onSettled');
    await sleep(400);
    expect(settled).toHaveLength(1); // 연달아 두 번 써도 한 번

    fs.appendFileSync(at(root, 'raw/voc/2026/VOC-2026-0001.md'), '\n- [ ] raw 안 #내할일\n', 'utf8');
    fs.writeFileSync(at(root, 'wiki/scratch.txt'), 'x', 'utf8');
    await sleep(600);
    expect(settled).toHaveLength(1);

    // 특별 파일(items.json)은 제외 폴더 안이지만 본다
    fs.appendFileSync(at(root, '_todo-sync/items.json'), '\n', 'utf8');
    await waitFor(() => settled.length >= 2, 5_000, '특별 파일 onSettled');
    expect(errors).toEqual([]);
  });

  it('감시 중에도 하위 폴더가 있는 폴더의 이름을 바꿀 수 있고(EPERM 없음), 그 변경이 onSettled 로 이어진다', async () => {
    const root = copyFixture();
    const { settled, errors } = watch(root);
    await sleep(100);

    // chokidar 는 wiki/topics/dev 에 핸들을 열어 이 rename 을 EPERM 으로 막았다
    expect(() => fs.renameSync(at(root, 'wiki/topics'), at(root, 'wiki/topics2'))).not.toThrow();
    await waitFor(() => settled.length >= 1, 5_000, '폴더 이름 바꾸기 onSettled');

    // 하위 폴더가 있는 최상위 폴더도
    expect(() => fs.renameSync(at(root, 'wiki'), at(root, 'wiki-renamed'))).not.toThrow();
    await waitFor(() => settled.length >= 2, 5_000, '최상위 폴더 이름 바꾸기 onSettled');

    // 옮긴 뒤에도 감시가 이어진다
    fs.appendFileSync(at(root, 'wiki-renamed/topics2/dev/CMS 인벤토리 사용량 집계.md'), '\n- [ ] 옮긴 뒤 #내할일\n', 'utf8');
    await waitFor(() => settled.length >= 3, 5_000, '옮긴 뒤 onSettled');
    expect(errors).toEqual([]);
  });

  it('루트 자체의 이름을 바꿔도 EPERM 이 나지 않고, 되돌리면 감시가 다시 붙는다', async () => {
    const parent = tempDir('wiki-radar-watch-parent-');
    const root = path.join(parent, 'vault');
    fs.cpSync(FIXTURE, root, { recursive: true });
    const { w, settled, watching } = watch(root);
    await sleep(100);

    expect(() => fs.renameSync(root, path.join(parent, 'vault-renamed'))).not.toThrow();
    // 핸들이 죽으면(오류 이벤트) 다시 붙기를 기다린다. 플랫폼에 따라 오류가 늦게 오거나 안 올 수 있으니 되돌린 뒤 결과만 본다.
    await sleep(300);
    fs.renameSync(path.join(parent, 'vault-renamed'), root);
    await waitFor(() => w.isWatching(), 5_000, '다시 붙음');
    await sleep(200);
    fs.appendFileSync(at(root, '_private/mgmt/내 할 일.md'), '\n- [ ] 되돌린 뒤 #내할일\n', 'utf8');
    await waitFor(() => settled.length >= 1, 5_000, '되돌린 뒤 onSettled');
    expect(watching[0]).toBe(false);
  });

  it('시작 시 루트가 없으면 조용히 기다리다 생기면 감시를 붙이고 onSettled 를 부른다', async () => {
    const parent = tempDir('wiki-radar-watch-late-');
    const root = path.join(parent, 'late', 'WIKI');
    const { w, settled, errors, watching } = watch(root);
    expect(w.isWatching()).toBe(false);
    expect(watching).toEqual([]);
    await sleep(400);
    expect(settled).toEqual([]);
    expect(errors).toEqual([]); // 루트 없음은 오류가 아니다

    fs.cpSync(FIXTURE, root, { recursive: true });
    await waitFor(() => w.isWatching(), 5_000, '늦게 붙음');
    expect(watching).toEqual([true]);
    await waitFor(() => settled.length >= 1, 5_000, '늦게 붙은 뒤 onSettled');

    // 그 뒤의 변경도 잡는다(명세 §5 감시가 세션 내내 살아 있다)
    await sleep(200);
    fs.appendFileSync(at(root, '_private/mgmt/내 할 일.md'), '\n- [ ] 늦게 붙은 뒤 #내할일\n', 'utf8');
    await waitFor(() => settled.length >= 2, 5_000, '늦게 붙은 뒤 변경 onSettled');
    expect(errors).toEqual([]);
  });

  it('close 뒤에는 아무것도 부르지 않는다', async () => {
    const root = copyFixture();
    const { w, settled } = watch(root);
    await w.close();
    fs.appendFileSync(at(root, '_private/mgmt/내 할 일.md'), '\n- [ ] 닫은 뒤 #내할일\n', 'utf8');
    await sleep(500);
    expect(settled).toEqual([]);
    expect(w.isWatching()).toBe(false);
  });
});

describe('재시도 백오프', () => {
  it('2배씩 늘어 상한에서 멈추고, 성공(reset)하면 처음으로 돌아간다', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const b = createRetryBackoff({ initialMs: 1_000, maxMs: 4_000, fn });
    expect(b.isPending()).toBe(false);

    b.schedule();
    b.schedule(); // 이미 예약돼 있으면 그대로
    expect(b.isPending()).toBe(true);
    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b.isPending()).toBe(false);

    b.schedule(); // 2초
    vi.advanceTimersByTime(2_000);
    expect(fn).toHaveBeenCalledTimes(2);
    b.schedule(); // 4초
    vi.advanceTimersByTime(4_000);
    expect(fn).toHaveBeenCalledTimes(3);
    b.schedule(); // 상한 4초
    expect(b.nextDelayMs()).toBe(4_000);
    vi.advanceTimersByTime(4_000);
    expect(fn).toHaveBeenCalledTimes(4);

    b.reset();
    expect(b.nextDelayMs()).toBe(1_000);
    b.schedule();
    b.reset(); // 예약 취소
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(4);

    b.schedule();
    b.stop();
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
