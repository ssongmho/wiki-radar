// 2.6단계 배선(src/main/ipc.ts) — electron 을 가짜로 바꿔 핸들러를 직접 부른다. VocService 도 가짜(voc-cli 를 부르지 않는다).
// 위키는 test/fixtures/wiki 의 임시 복사본에만 쓴다. today = 2026-09-23
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  sent: [] as { channel: string; payload: unknown }[],
  opened: [] as string[],
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }),
        },
      },
    ],
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => h.handlers.set(channel, fn),
    removeHandler: (channel: string) => h.handlers.delete(channel),
  },
  shell: {
    openExternal: async (url: string) => {
      h.opened.push(url);
    },
  },
}));

import holidaysJson from '../../config/holidays-kr.json';
import { IPC, type IpcReply } from '../../src/shared/ipc';
import type { Holiday, Snapshot, Task, VocBoard, VocCreateResult, VocSettings, WindowMode } from '../../src/shared/types';
import {
  ReflectController,
  SnapshotService,
  VOC_TASK_SAVE_REFUSED,
  broadcastSnapshot,
  registerIpc,
  type IpcDeps,
} from '../../src/main/ipc';
import { QueueStore } from '../../src/main/queue';
import { ReflectHistory } from '../../src/main/reflect';
import { MailSettingsStore, SentLog } from '../../src/main/mail/stores';
import { VocSettingsStore } from '../../src/main/voc/settings';
import { VOC_LINE_FIELD_BROKEN } from '../../src/shared/voc';
import { captureConsole } from './consoleCapture';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const holidays: Holiday[] = holidaysJson.holidays;
const MY_TASKS = '_private/mgmt/내 할 일.md';
const SEOJIN_TITLE = '서진화학 EHS 잔여 오류 목록 — 우선순위 회신';
const HANGYEOL_TITLE = '한결케미칼 통영공장 사용량 미반영 회신';
const OP = '6f1c2a90-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const WEB = 'https://voc.example.com';

let tmp: string;
let wikiRoot: string;
let dataDir: string;
let snapshots: SnapshotService;
let queue: QueueStore;
let shown: boolean;
let mode: WindowMode;
let board: VocBoard;
let voc: ReturnType<typeof fakeVoc>;

function vocTask(id: number, extra: Partial<Task> = {}): Task {
  return {
    id: `v:${id}`,
    source: 'voc',
    title: `VOC 티켓 ${id}`,
    status: 'open',
    bucket: 'other',
    voc: { id, number: `VOC-2026-${String(id).padStart(4, '0')}`, status: 'in_progress' },
    ...extra,
  };
}

function fakeVoc() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    board: vi.fn(() => board),
    tasks: vi.fn(() => [] as Task[]),
    refresh: vi.fn(async () => board),
    refreshIfOlder: vi.fn(),
    onResume: vi.fn(),
    directory: vi.fn(async (_force?: boolean) => ({ users: [], systems: [], requestTypes: [], customers: [] })),
    ticketDetail: vi.fn(),
    checkText: vi.fn((text: string) => (text.includes('😀') ? ['😀'] : [])),
    action: vi.fn(async () => ({ ok: true, message: '바꿨습니다' })),
    createContext: vi.fn(async (task: Task, source: { subject: string } | null, existing?: string) => ({
      taskId: task.id,
      ...(existing ? { existing } : {}),
      title: source?.subject ?? task.title,
      description: '',
      requestType: 'inquiry',
      priority: 'P3',
      directory: { users: [], systems: [], requestTypes: [], customers: [] },
    })),
    create: vi.fn(
      async (
        _input: unknown,
        _task: Task,
        applyLine: (n: string) => { ok: true } | { ok: false; error: string },
      ): Promise<VocCreateResult> => {
        const r = applyLine('VOC-2026-0099');
        return { ticketId: 99, number: 'VOC-2026-0099', lineUpdated: r.ok, ...(r.ok ? {} : { lineError: r.error }), warnings: [] };
      },
    ),
    webUrl: vi.fn((id: number) => `${WEB}/maintenance/tickets/${id}`),
    login: vi.fn(async (_input: unknown): Promise<{ ok: boolean; message: string }> => ({ ok: true, message: 'VOC 에 로그인했습니다' })),
  };
}

async function call<T>(channel: string, ...args: unknown[]): Promise<IpcReply<T>> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`핸들러 없음: ${channel}`);
  return (await fn({ sender: { id: 1 } }, ...args)) as IpcReply<T>;
}

async function value<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = await call<T>(channel, ...args);
  if (!reply.ok) throw new Error(reply.message);
  return reply.value;
}

function taskByTitle(title: string): Task {
  const t = snapshots.current().tasks.find((x) => x.title === title);
  expect(t, title).toBeDefined();
  return t as Task;
}

function readMyTasks(): string {
  return fs.readFileSync(path.join(wikiRoot, ...MY_TASKS.split('/')), 'utf8');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-vocipc-'));
  wikiRoot = path.join(tmp, 'wiki');
  dataDir = path.join(tmp, 'data');
  fs.cpSync(FIXTURE, wikiRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  h.handlers.clear();
  h.sent.length = 0;
  h.opened.length = 0;
  shown = true;
  mode = 'full';
  board = {
    state: 'ok',
    fetchedAt: new Date().toISOString(),
    lanes: [],
    totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 },
    webBase: WEB,
  };
  voc = fakeVoc();
  snapshots = new SnapshotService({ wikiRoot, holidays, getToday: () => TODAY });
  queue = new QueueStore(dataDir);
  const deps: IpcDeps = {
    wikiRoot,
    snapshots,
    windows: {
      isAppContents: () => true,
      modeOf: () => mode,
      isShown: () => shown,
      setMode: () => undefined,
      togglePin: () => false,
      quit: () => undefined,
    },
    getToday: () => TODAY,
    refreshSnapshot: () => {
      const s = snapshots.refresh();
      if (s) broadcastSnapshot(s);
      return s;
    },
    queue: () => queue,
    reflect: new ReflectController({
      wikiRoot,
      queue: () => queue,
      history: () => new ReflectHistory(dataDir),
      getClaudePath: () => ({ path: 'claude.exe', source: 'default', exists: false }),
    }),
    sentLog: () => new SentLog(dataDir),
    mailSettings: () => new MailSettingsStore(dataDir),
    getClaudePath: () => ({ path: 'claude.exe', source: 'default', exists: false }),
    env: { VITEST: '1' },
    voc: voc as unknown as IpcDeps['voc'],
    vocSettings: () => new VocSettingsStore(dataDir),
  };
  registerIpc(deps);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SnapshotService — VOC 할 일 합치기', () => {
  it('VOC 할 일이 바뀌면 파일을 다시 읽지 않고 합친 스냅샷을 돌려준다', () => {
    const first = snapshots.current();
    // 파일을 바꿔도 VOC 교체는 파일을 다시 읽지 않는다
    fs.appendFileSync(path.join(wikiRoot, ...MY_TASKS.split('/')), '\n- [ ] 새로 적은 할 일 #내할일\n');
    const merged = snapshots.setVocTasks([vocTask(7, { due: '2026-09-22' })]);
    expect(merged).not.toBeNull();
    const s = merged as Snapshot;
    expect(s.tasks.filter((t) => t.source === 'voc').map((t) => t.id)).toEqual(['v:7']);
    expect(s.tasks.find((t) => t.id === 'v:7')?.bucket).toBe('overdue');
    expect(s.counts.overdue).toBe(first.counts.overdue + 1);
    expect(s.tasks.some((t) => t.title === '새로 적은 할 일')).toBe(false);
    expect(snapshots.current()).toBe(s);

    // 같은 것이 다시 오면 방송할 것이 없다
    expect(snapshots.setVocTasks([vocTask(7, { due: '2026-09-22' })])).toBeNull();

    // 파일을 새로 읽을 때도 VOC 할 일을 합친다
    const rebuilt = snapshots.refresh() as Snapshot;
    expect(rebuilt.tasks.some((t) => t.title === '새로 적은 할 일')).toBe(true);
    expect(rebuilt.tasks.filter((t) => t.source === 'voc').map((t) => t.id)).toEqual(['v:7']);
  });

  it('경고 문장은 스냅샷 warnings 끝에 붙고, 비우면 빠진다', () => {
    const base = snapshots.current();
    const withNote = snapshots.setVocTasks([vocTask(8)], 'VOC 할 일은 10:32 기준') as Snapshot;
    expect(withNote.warnings).toEqual([...base.warnings, 'VOC 할 일은 10:32 기준']);
    const cleared = snapshots.setVocTasks([]) as Snapshot;
    expect(cleared.warnings).toEqual(base.warnings);
    expect(cleared.tasks).toEqual(base.tasks);
  });

  it('파일 스냅샷을 만들기 전이면 null — 처음 만들 때 합친다', () => {
    const fresh = new SnapshotService({ wikiRoot, holidays, getToday: () => TODAY });
    expect(fresh.setVocTasks([vocTask(9)])).toBeNull();
    expect(fresh.current().tasks.some((t) => t.id === 'v:9')).toBe(true);
  });
});

describe('saveResult — VOC 할 일 거부(§5)', () => {
  it('VOC 할 일은 저장하지 않고 반영 대기열에도 넣지 않는다', async () => {
    snapshots.current();
    snapshots.setVocTasks([vocTask(11)]);
    const before = readMyTasks();
    const reply = await call(IPC.saveResult, { taskId: 'v:11', status: 'done', note: '처리함', reflect: true });
    expect(reply).toEqual({ ok: false, message: VOC_TASK_SAVE_REFUSED });
    expect(queue.list()).toEqual([]);
    expect(readMyTasks()).toBe(before);
  });

  it('위키 할 일 저장은 그대로 된다', async () => {
    const task = taskByTitle(SEOJIN_TITLE);
    const out = await value<{ files: string[] }>(IPC.saveResult, { taskId: task.id, status: 'wip', reflect: false });
    expect(out.files).toContain(MY_TASKS);
  });
});

describe('VOC 보드·설정 핸들러', () => {
  it('getVocBoard: 보이는 풀스크린 창에서 온 요청만 2분 기준 새로 받기를 건다', async () => {
    expect(await value<VocBoard>(IPC.getVocBoard)).toBe(board);
    expect(voc.refreshIfOlder).toHaveBeenCalledWith(120_000);
    voc.refreshIfOlder.mockClear();
    mode = 'sidebar';
    await value(IPC.getVocBoard);
    mode = 'full';
    shown = false;
    await value(IPC.getVocBoard);
    expect(voc.refreshIfOlder).not.toHaveBeenCalled();
  });

  it('getVocDirectory: 처음은 새로 받고, 1분 안에 또 오면 캐시', async () => {
    await value(IPC.getVocDirectory);
    await value(IPC.getVocDirectory);
    expect(voc.directory.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('saveVocSettings: 검사해 저장하고 보드를 새로 받는다', async () => {
    const saved = await value<VocSettings>(IPC.saveVocSettings, {
      memberIds: [3, 3, 5],
      systems: ['SYS0048'],
      showAllUnassigned: true,
      pollMinutes: 15,
    });
    expect(saved).toMatchObject({ memberIds: [3, 5], systems: ['SYS0048'], showAllUnassigned: true, pollMinutes: 15 });
    expect(await value<VocSettings>(IPC.getVocSettings)).toEqual(saved);
    expect(voc.refresh).toHaveBeenCalledTimes(1);
    const bad = await call(IPC.saveVocSettings, { memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 1 });
    expect(bad.ok).toBe(false);
  });

  it('getVocTicket·vocAction·checkVocText 는 인자를 검사한 뒤에만 VocService 를 부른다', async () => {
    expect((await call(IPC.getVocTicket, '12')).ok).toBe(false);
    expect(voc.ticketDetail).not.toHaveBeenCalled();

    expect((await call(IPC.vocAction, { actionId: 'x', kind: 'assign', ticketId: 1, value: '2' })).ok).toBe(false);
    expect((await call(IPC.vocAction, { actionId: OP, kind: 'delete', ticketId: 1, value: '2' })).ok).toBe(false);
    expect(voc.action).not.toHaveBeenCalled();
    await value(IPC.vocAction, { actionId: OP, kind: 'reply', ticketId: 1, value: '확인\r\n했습니다' });
    expect(voc.action).toHaveBeenCalledWith({ actionId: OP, kind: 'reply', ticketId: 1, value: '확인\n했습니다' });

    expect(await value<string[]>(IPC.checkVocText, '답변 😀')).toEqual(['😀']);
    expect((await call(IPC.checkVocText, 5)).ok).toBe(false);
  });

  it('openVocWeb: whoami 호스트의 /maintenance/tickets/<id> 만 연다', async () => {
    await value(IPC.openVocWeb, 42);
    expect(h.opened).toEqual([`${WEB}/maintenance/tickets/42`]);

    voc.webUrl.mockReturnValueOnce('https://evil.example.org/maintenance/tickets/43');
    expect((await call(IPC.openVocWeb, 43)).ok).toBe(false);
    voc.webUrl.mockReturnValueOnce(null as unknown as string);
    expect((await call(IPC.openVocWeb, 44)).ok).toBe(false);
    expect((await call(IPC.openVocWeb, -1)).ok).toBe(false);
    expect(h.opened).toHaveLength(1);
  });

  it('saveVocSettings: 기억한 로그인 아이디는 설정 대화상자의 저장으로 바뀌지 않는다(명세 §13)', async () => {
    new VocSettingsStore(dataDir).setLoginId('hong');
    const saved = await value<VocSettings>(IPC.saveVocSettings, {
      memberIds: [3],
      systems: [],
      showAllUnassigned: false,
      pollMinutes: 10,
      loginId: 'other',
    });
    expect(saved.loginId).toBe('hong');
    expect((await value<VocSettings>(IPC.getVocSettings)).loginId).toBe('hong');
  });

  it('console 가로채기(양성 대조): 객체·Map·오류로 찍은 값도 글자로 모은다 — 객체로 찍은 비밀번호도 로그 검사가 본다', async () => {
    const PW = 'Pw-unit-7f3a9c';
    const cap = captureConsole();
    try {
      console.warn('실패', { loginId: 'hong', password: PW });
      console.log('입력', new Map([['password', PW]]), [{ nested: { deep: { password: PW } } }]);
      console.error(new Error(`boom ${PW}`));
    } finally {
      cap.restore();
    }
    expect(cap.lines).toHaveLength(3);
    for (const line of cap.lines) expect(line).toContain(PW);
    // 누출 변이: VocService 가 입력 객체를 그대로 찍으면 모은 글에 비밀번호가 보인다(아래 vocLogin 시험의 검사가 실패한다)
    const leak = captureConsole();
    try {
      voc.login.mockImplementationOnce(async (input: unknown): Promise<{ ok: boolean; message: string }> => {
        console.log('x', input);
        return { ok: false, message: '로그인 실패' };
      });
      await value(IPC.vocLogin, { loginId: 'hong', password: PW, remember: true });
    } finally {
      leak.restore();
    }
    expect(leak.text()).toContain(PW);
  });

  it('vocLogin: 입력을 검사한 뒤에만 VocService 를 부르고, 로그에는 아이디까지만(비밀번호는 로그·오류 어디에도 없다)', async () => {
    const PW = 'Pw-unit-7f3a9c';
    const cap = captureConsole();
    const logged = cap.lines;
    try {
      // 틀린 입력: VocService 를 부르지 않는다
      for (const bad of [
        { loginId: 'hong', password: `${PW}\n`, remember: true },
        { loginId: '', password: PW, remember: true },
        { loginId: 'hong', password: PW, remember: 'yes' },
        'hong',
      ]) {
        const reply = await call(IPC.vocLogin, bad);
        expect(reply.ok, JSON.stringify(bad)).toBe(false);
        expect(JSON.stringify(reply)).not.toContain(PW);
      }
      expect(voc.login).not.toHaveBeenCalled();

      voc.login.mockResolvedValueOnce({ ok: false, message: '로그인 실패: 아이디 또는 비밀번호를 확인하세요.' });
      expect(await value(IPC.vocLogin, { loginId: 'hong', password: PW, remember: true, extra: 'x' })).toEqual({
        ok: false,
        message: '로그인 실패: 아이디 또는 비밀번호를 확인하세요.',
      });
      expect(voc.login).toHaveBeenCalledWith({ loginId: 'hong', password: PW, remember: true });
      expect(await value(IPC.vocLogin, { loginId: 'hong', password: PW, remember: false })).toEqual({ ok: true, message: 'VOC 에 로그인했습니다' });
      expect(logged.join('\n')).toContain('VOC 로그인: hong');
      expect(logged.join('\n')).not.toContain(PW);
    } finally {
      cap.restore();
    }
  });
});

describe('메일 → VOC 등록(§6)', () => {
  it('getVocCreateContext: 메일 할 일만, 원본 메일을 넘긴다', async () => {
    const hangyeol = taskByTitle(HANGYEOL_TITLE);
    await value(IPC.getVocCreateContext, hangyeol.id);
    const [task, source, existing] = voc.createContext.mock.calls[0];
    expect(task.id).toBe(hangyeol.id);
    expect(source?.subject).toBe('RE: 통영공장 CMS 인벤토리 사용량 확인 요청');
    expect(existing).toBeUndefined();

    // 원본 파일이 없는 메일 할 일은 원본 없이
    const seojin = taskByTitle(SEOJIN_TITLE);
    await value(IPC.getVocCreateContext, seojin.id);
    expect(voc.createContext.mock.calls[1][1]).toBeNull();

    // 메일 할 일이 아니거나 VOC 할 일·없는 할 일이면 null
    const noMail = snapshots.current().tasks.find((t) => !t.mail) as Task;
    snapshots.setVocTasks([vocTask(12)]);
    expect(await value(IPC.getVocCreateContext, noMail.id)).toBeNull();
    expect(await value(IPC.getVocCreateContext, 'v:12')).toBeNull();
    expect(await value(IPC.getVocCreateContext, 'c:없는할일')).toBeNull();
    expect(voc.createContext).toHaveBeenCalledTimes(2);
  });

  it('createVocTicket: 줄 끝에 [voc:: 번호] 를 붙이고 목록을 새로 만든다. 같은 할 일은 두 번 등록하지 않는다', async () => {
    const seojin = taskByTitle(SEOJIN_TITLE);
    const input = {
      createId: OP,
      taskId: seojin.id,
      title: 'EHS 잔여 오류 목록',
      description: '내용',
      customerId: 3,
      system: 'SYS0048',
      requestType: 'inquiry',
      priority: 'P3',
    };
    const result = await value<VocCreateResult>(IPC.createVocTicket, input);
    expect(result).toMatchObject({ ticketId: 99, number: 'VOC-2026-0099', lineUpdated: true });
    expect(readMyTasks()).toContain(`${seojin.rawLine} [voc:: VOC-2026-0099]`);
    // 목록을 새로 만들어 방송했고, 그 줄은 같은 할 일(같은 ID)이다
    const broadcasted = h.sent.filter((m) => m.channel === IPC.snapshot);
    expect(broadcasted.length).toBeGreaterThan(0);
    const after = snapshots.current().tasks.find((t) => t.id === seojin.id) as Task;
    expect(after.rawLine).toContain('[voc:: VOC-2026-0099]');

    // 다시 누르면 티켓을 만들지 않고 거부
    const again = await call(IPC.createVocTicket, { ...input, createId: `${OP}-2` });
    expect(again.ok).toBe(false);
    expect(again.ok ? '' : again.message).toContain('VOC-2026-0099');
    expect(voc.create).toHaveBeenCalledTimes(1);

    // 이미 붙은 번호는 작성 칸 문맥의 existing 으로
    await value(IPC.getVocCreateContext, seojin.id);
    expect(voc.createContext.mock.calls.at(-1)?.[2]).toBe('VOC-2026-0099');
  });

  it('createVocTicket: 줄에 값이 빈 [voc::]·닫히지 않은 [voc:: 가 있으면 VocService 를 부르기 전에 거부한다(티켓이 먼저 생기지 않게)', async () => {
    const seojin = taskByTitle(SEOJIN_TITLE);
    const file = path.join(wikiRoot, ...MY_TASKS.split('/'));
    const original = fs.readFileSync(file, 'utf8');
    for (const tail of [' [voc:: ]', ' [voc:: VOC-2026-0012']) {
      fs.writeFileSync(file, original.split(seojin.rawLine as string).join(`${seojin.rawLine}${tail}`), 'utf8');
      snapshots.refresh();
      // 닫히지 않은 필드는 핵심문구에 섞여 ID·제목이 바뀔 수 있다 — 줄 끝으로 찾는다
      const task = snapshots.current().tasks.find((t) => t.mail && t.rawLine?.endsWith(tail)) as Task;
      expect(task, tail).toBeDefined();
      const reply = await call(IPC.createVocTicket, {
        createId: OP,
        taskId: task.id,
        title: 'EHS 잔여 오류 목록',
        description: '내용',
        customerId: 3,
        system: 'SYS0048',
        requestType: 'inquiry',
        priority: 'P3',
      });
      expect(reply).toEqual({ ok: false, message: VOC_LINE_FIELD_BROKEN });
    }
    expect(voc.create).not.toHaveBeenCalled();
  });

  it('vocAction: 확인 대화상자가 보인 값(expected)을 검사해 VocService 로 넘긴다', async () => {
    await value(IPC.vocAction, { actionId: OP, kind: 'assign', ticketId: 1, value: '2', expected: { assigneeId: null, status: 'new' } });
    expect(voc.action).toHaveBeenCalledWith({ actionId: OP, kind: 'assign', ticketId: 1, value: '2', expected: { assigneeId: null, status: 'new' } });
    expect((await call(IPC.vocAction, { actionId: OP, kind: 'priority', ticketId: 1, value: 'P1', expected: { priority: 5 } })).ok).toBe(false);
    expect(voc.action).toHaveBeenCalledTimes(1);
  });

  it('createVocTicket: 입력이 틀리거나 메일 할 일이 아니면 VocService 를 부르지 않는다', async () => {
    const noMail = snapshots.current().tasks.find((t) => !t.mail && t.source === 'checkbox') as Task;
    const input = {
      createId: OP,
      taskId: noMail.id,
      title: '제목',
      description: '',
      customerId: 3,
      system: 'SYS0048',
      requestType: 'inquiry',
      priority: 'P3',
    };
    expect((await call(IPC.createVocTicket, input)).ok).toBe(false);
    expect((await call(IPC.createVocTicket, { ...input, customerId: '3' })).ok).toBe(false);
    expect(voc.create).not.toHaveBeenCalled();
  });
});
