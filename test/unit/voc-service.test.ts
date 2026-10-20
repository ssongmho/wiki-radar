// VOC 서비스 흐름(2.6단계 §2-3·§4·§5·§6) — 단위 시험. voc-cli 는 가짜 runner(인자 기록·응답 주입)만 쓴다.
// 실제 voc-cli·운영 VOC 에 닿지 않는다. 설정·쓰기 기록은 임시 폴더에만 쓴다. 사람·고객사 이름은 가짜다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Task, VocBoard, VocLoginResult } from '../../src/shared/types';
import type { ReplySource } from '../../src/main/mail/replyContext';
import { VOC_GUARD_MESSAGE, VOC_LOGIN_COMMAND, VocRunError, type VocRunResult } from '../../src/main/voc/cli';
import type { VocPageMaps } from '../../src/main/voc/model';
import { VocActionLog, VocSettingsStore } from '../../src/main/voc/settings';
import {
  VOC_LIST_ARGS,
  VOC_LOGIN_BUSY_MESSAGE,
  VOC_LOGIN_TIMEOUT_MESSAGE,
  VOC_START_DELAY_MS,
  VocService,
  loginFailedMessage,
  textOption,
  vocSafeDefault,
  type VocServiceDeps,
} from '../../src/main/voc/service';
import {
  VOC_LINE_FIELD_BROKEN,
  VOC_LOGIN_FAIL_LIMIT,
  VOC_LOGIN_LOCK_MS,
  VOC_LOGIN_LOCK_NOTE,
  VOC_SERVER_LOGIN_FAIL_LIMIT,
  VOC_SERVER_LOGIN_LOCK_MS,
} from '../../src/shared/voc';
import { vocTextToHtml } from '../../src/shared/vocHtml';
import { captureConsole } from './consoleCapture';

const TODAY = '2026-09-28';
const NOW = new Date('2026-09-28T01:30:00Z');
const LIST = VOC_LIST_ARGS.join(' ');

const temps: string[] = [];

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-voc-'));
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------- 가짜 VOC(서버 상태 + voc-cli 응답)

const WHOAMI = [
  '로그인 ID   : hong',
  '이름        : 홍길동',
  '이메일      : Hong@Example.com',
  '권한(role)  : admin',
  '부서        : 레이더팀',
  '백엔드      : https://voc.example.test:11300',
  '',
].join('\n');

const USERS = [
  { id: 11, name: '홍길동', email: 'hong@example.com', department: '레이더팀', role: 'admin' },
  { id: 12, name: '김담당', email: 'kim@example.com', department: '레이더팀', role: 'staff' },
  { id: 13, name: '박담당', email: 'park@example.com', department: '레이더팀', role: 'staff' },
  { id: 21, name: '최외부', email: 'choi@example.com', department: '다른팀', role: 'staff' },
];
const REQUEST_TYPES = [
  { id: 1, code: 'inquiry', name: '문의', enabled: true },
  { id: 2, code: 'error', name: '오류', enabled: true },
];
const CUSTOMERS = [
  { id: 101, customerName: '한결케미칼', enabled: true },
  { id: 102, customerName: '서진화학', enabled: true },
  { id: 103, customerName: '해온정밀', enabled: true },
];

type Dto = Record<string, unknown>;

function dto(id: number, extra: Dto): Dto {
  return {
    id,
    ticketNumber: `VOC-2026-${String(id - 1000).padStart(4, '0')}`,
    title: `티켓 ${id}`,
    description: `<p>요청 ${id}</p>`,
    status: 'assigned',
    priority: 'P3',
    customerId: 101,
    customer: '한결케미칼',
    system: 'SYS0001',
    systemName: 'CMS',
    createdAt: '2026-09-20T01:00:00Z',
    updatedAt: '2026-09-21T01:00:00Z',
    slaStatus: 'normal',
    replyCount: 0,
    ...extra,
  };
}

/** 진행 중 6건: 미배정(팀 시스템)·미배정(팀 밖 시스템)·나 2건·김담당·팀 밖 담당 */
function initialTickets(): Dto[] {
  return [
    dto(1001, { status: 'new', priority: 'P2', slaStatus: 'warning', internalAssigneeId: null }),
    dto(1002, {
      status: 'in_progress',
      priority: 'P1',
      internalAssigneeId: 11,
      internalAssigneeName: '홍길동',
      ictDueDate: '2026-09-30T15:00:00Z',
      replyCount: 2,
    }),
    dto(1003, { customerId: 102, customer: '서진화학', system: 'SYS0002', systemName: 'EHS', internalAssigneeId: 12, internalAssigneeName: '김담당' }),
    dto(1004, { system: 'SYS0009', systemName: 'ERP', internalAssigneeId: 21, internalAssigneeName: '최외부' }),
    dto(1005, { status: 'new', system: 'SYS0009', systemName: 'ERP' }),
    dto(1006, {
      priority: 'P2',
      slaStatus: 'exceeded',
      internalAssigneeId: 11,
      internalAssigneeName: '홍길동',
      customerDueDate: '2026-09-25T15:00:00Z',
      createdAt: '2026-09-01T01:00:00Z',
    }),
  ];
}

type Mode = 'ok' | 'login' | 'expired' | 'offline' | 'fail-write' | 'slow-timeout';

interface Call {
  args: string[];
  write?: boolean;
  timeoutMs?: number;
  /** 표준입력으로 받은 글(login) */
  stdin?: string;
}

/** 가짜 voc-cli: 인자를 기록하고 서버 상태(tickets)를 고친다. hold 가 있으면 그 약속이 풀릴 때까지 기다린다 */
class FakeVoc {
  mode: Mode = 'ok';
  tickets: Dto[] = initialTickets();
  users: Record<string, unknown>[] = USERS.map((u) => ({ ...u }));
  whoami = WHOAMI;
  /** ticket reply 로 받은 내용(보낸 그대로) */
  readonly replies: string[] = [];
  readonly calls: Call[] = [];
  nextId = 1100;
  /** 다음 쓰기를 잡아 둔다(동시 동작 시험) */
  hold: Promise<void> | null = null;
  /** 실행 전에 거부(VocRunError) */
  reject: VocRunError | null = null;
  /** create 결과 JSON 을 바꾼다 */
  createOutput: ((d: Dto) => string) | null = null;
  /** login 이 받는 비밀번호(가짜 값) */
  password = 'Pw-unit-7f3a9c';
  /** 다음 login 을 잡아 둔다(동시 로그인 시험) */
  loginHold: Promise<void> | null = null;
  /** login 결과를 바꾼다(시간 초과·되비춤 등) */
  loginResult: ((stdin: string) => VocRunResult) | null = null;
  /**
   * 서버의 로그인 잠금(voc20-backend LoginAttemptService 와 같다): 아이디별 연속 실패 수와 잠금 끝(ms, 0 = 잠그지 않음).
   * 5번째 실패에 10분 잠그고, 셈은 시간으로 줄지 않는다(성공하거나 잠금이 풀린 뒤 다음 시도에서 지운다)
   */
  readonly attempts = new Map<string, { count: number; lockedUntil: number }>();
  /** 서버가 잠근 아이디(잠근 차례) */
  readonly serverLocks: string[] = [];
  /** 서버 시각(ms) — 서비스 시험 시계와 잇는다 */
  now: () => number = () => Date.now();

  readonly runner = {
    run: async (args: string[], opts?: { write?: boolean; timeoutMs?: number; stdin?: string }): Promise<VocRunResult> => {
      const call: Call = { args: [...args], write: opts?.write, timeoutMs: opts?.timeoutMs };
      if (opts?.stdin !== undefined) call.stdin = opts.stdin;
      this.calls.push(call);
      if (this.reject) throw this.reject;
      if (args[0] === 'login') {
        if (this.loginHold) await this.loginHold;
        return this.respondLogin(args[2] ?? '', opts?.stdin ?? '');
      }
      const write = ['ticket update', 'ticket reply', 'ticket create'].includes(args.slice(0, 2).join(' '));
      if (write && this.hold) await this.hold;
      return this.respond(args, write);
    },
  };

  /**
   * voc-cli login(표준입력 한 줄 = 비밀번호). 맞으면 세션이 생긴 것처럼 mode 를 ok 로. 서버처럼 잠긴 아이디는 비밀번호를 보지 않고
   * 거부하고, voc-cli 처럼 그 401 도 '로그인 실패: …확인하세요.'로 낸다(잠금 문장이 사라진다)
   */
  private respondLogin(loginId: string, stdin: string): VocRunResult {
    if (this.loginResult) return this.loginResult(stdin);
    if (this.mode === 'offline') return this.err('백엔드에 연결할 수 없습니다: https://voc.example.test:11300 — 서버가 실행 중인지 확인하세요.');
    const line = stdin.split('\n')[0];
    if (line === '') return this.err('비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.');
    const held = this.attempts.get(loginId);
    if (held && held.lockedUntil !== 0) {
      // LoginAttemptService.isLocked: 잠금이 풀렸으면 지운다
      if (this.now() > held.lockedUntil) this.attempts.delete(loginId);
      else return this.err('로그인 실패: 아이디 또는 비밀번호를 확인하세요.');
    }
    if (line !== this.password) {
      const count = (this.attempts.get(loginId)?.count ?? 0) + 1;
      const locked = count >= 5;
      this.attempts.set(loginId, { count, lockedUntil: locked ? this.now() + 600_000 : 0 });
      if (locked) this.serverLocks.push(loginId);
      return this.err('로그인 실패: 아이디 또는 비밀번호를 확인하세요.');
    }
    this.attempts.delete(loginId);
    this.mode = 'ok';
    // picocli 는 콘솔이 없으면 입력 안내를 같은 줄 앞에 찍는다
    return this.ok(
      'Enter value for --password (비밀번호 (생략하면 안전하게 입력받음)): 로그인 성공: 홍길동 (admin) @ https://voc.example.test:11300\n' +
        '세션 저장 위치: C:\\Users\\sample\\.voc-cli\\session.json\n',
    );
  }

  commands(): string[] {
    return this.calls.map((c) => c.args.join(' '));
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.write);
  }

  ok(stdout: string): VocRunResult {
    return { code: 0, stdout, stderr: '', timedOut: false };
  }

  err(line: string, code = 1): VocRunResult {
    return { code, stdout: '', stderr: `오류: ${line}\n`, timedOut: false };
  }

  private respond(args: string[], write: boolean): VocRunResult {
    if (this.mode === 'login') return this.err('로그인이 필요합니다. 먼저 `voc-cli login` 을 실행하세요.');
    if (this.mode === 'expired') return this.err('세션이 만료되었습니다. `voc-cli login` 으로 다시 로그인하세요.');
    if (this.mode === 'offline') return this.err('백엔드에 연결할 수 없습니다: https://voc.example.test:11300 — 서버가 실행 중인지 확인하세요.');
    if (write && this.mode === 'fail-write') return this.err('400 — 작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.');
    if (write && this.mode === 'slow-timeout') return { code: -1, stdout: '', stderr: '', timedOut: true };
    const cmd = args.join(' ');
    if (cmd === 'whoami') return this.ok(this.whoami);
    if (cmd === 'user list --role staff,admin --json') return this.ok(JSON.stringify(this.users, null, 2));
    // 운영처럼: SYSTEM 코드 그룹은 꺼져 있어 빈 배열(시스템은 voc_sys_programs 로 옮겨졌다)
    if (cmd === 'code list SYSTEM --json') return this.ok('[]');
    if (cmd === 'code list REQUEST_TYPE --json') return this.ok(JSON.stringify(REQUEST_TYPES));
    if (cmd === 'customer list --json') return this.ok(JSON.stringify(CUSTOMERS));
    if (cmd === LIST) {
      return this.ok(JSON.stringify({ data: this.tickets, total: this.tickets.length, page: 1, pageSize: 2000, totalPages: 1 }));
    }
    const [a, b, idText] = args;
    /** 옵션 값: `-t 값`·`--title 값`·`--title=값` 어느 모양이든(picocli 처럼) */
    const opt = (...names: string[]): string | undefined => {
      for (let i = 0; i < args.length; i++) {
        for (const name of names) {
          if (args[i] === name) return args[i + 1];
          if (name.startsWith('--') && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
        }
      }
      return undefined;
    };
    if (a === 'ticket' && b === 'get') {
      const t = this.find(Number(idText));
      if (!t) return this.err('404 — 티켓을 찾을 수 없습니다.');
      const body: Dto = { ...t, replyCount: null };
      if (args.includes('--replies')) {
        body.replies = [{ id: 1, content: '<p>확인 중입니다</p>', authorName: '김담당', authorType: 'internal', createdAt: '2026-09-22T02:00:00Z' }];
      }
      return this.ok(JSON.stringify(body));
    }
    if (a === 'ticket' && b === 'update') {
      const t = this.find(Number(idText));
      if (!t) return this.err('404 — 티켓을 찾을 수 없습니다.');
      const assignee = opt('--assignee');
      if (assignee) {
        t.internalAssigneeId = Number(assignee);
        t.internalAssigneeName = USERS.find((u) => u.id === Number(assignee))?.name;
      }
      const status = opt('--status', '-s');
      if (status) t.status = status;
      const pri = opt('-p', '--priority');
      if (pri) t.priority = pri;
      const ict = opt('--ict-due');
      if (ict) t.ictDueDate = `${ict}T00:00:00Z`;
      if (args.includes('--clear-ict-due')) t.ictDueDate = null;
      t.updatedAt = '2026-09-28T01:31:00Z';
      return this.ok(JSON.stringify({ ...t, replyCount: null }, null, 2));
    }
    if (a === 'ticket' && b === 'reply') {
      const t = this.find(Number(idText));
      if (!t) return this.err('404 — 티켓을 찾을 수 없습니다.');
      t.replyCount = Number(t.replyCount ?? 0) + 1;
      this.replies.push(opt('-c', '--content') ?? '');
      return this.ok('답변이 등록되었습니다. (답변 id=77)');
    }
    if (a === 'ticket' && b === 'create') {
      const id = this.nextId++;
      const d = dto(id, {
        status: opt('--assignee') ? 'assigned' : 'new',
        title: opt('-t', '--title'),
        description: opt('-d', '--desc') ?? '',
        customerId: Number(opt('--customer-id')),
        customer: CUSTOMERS.find((c) => c.id === Number(opt('--customer-id')))?.customerName,
        system: opt('--system'),
        priority: opt('-p', '--priority'),
        requestType: opt('--type'),
        internalAssigneeId: opt('--assignee') ? Number(opt('--assignee')) : null,
        createdAt: '2026-09-28T01:31:00Z',
      });
      this.tickets.unshift(d);
      return this.ok(this.createOutput ? this.createOutput(d) : JSON.stringify(d, null, 2));
    }
    return this.err('알 수 없는 명령', 2);
  }

  private find(id: number): Dto | undefined {
    return this.tickets.find((t) => t.id === id);
  }
}

// ---------------------------------------------------------------- 가짜 타이머

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
}

function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, FakeTimer>();
  const setTimer = ((fn: () => void, ms: number) => {
    const id = ++seq;
    pending.set(id, { id, fn, ms });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((id: number) => {
    pending.delete(id);
  }) as unknown as typeof clearTimeout;
  return {
    setTimer,
    clearTimer,
    /** 걸려 있는 타이머의 지연(ms) */
    delays: (): number[] => [...pending.values()].map((t) => t.ms),
    /** 걸려 있는 타이머 하나를 지금 부른다 */
    fire(): void {
      const first = [...pending.values()][0];
      if (!first) throw new Error('걸린 타이머가 없음');
      pending.delete(first.id);
      first.fn();
    },
  };
}

// ---------------------------------------------------------------- 서비스 만들기

const PAGE_MAPS: VocPageMaps = {
  custPage: new Map([['한결케미칼(주)', '한결케미칼']]),
  systemPage: new Map(),
  pageIndex: new Map([
    ['한결케미칼', 'wiki/entities/한결케미칼.md'],
    ['서진화학', 'wiki/entities/서진화학.md'],
  ]),
};

interface Harness {
  service: VocService;
  voc: FakeVoc;
  timers: ReturnType<typeof fakeTimers>;
  boards: { board: VocBoard; tasks: Task[] }[];
  dataDir: string;
  settings: VocSettingsStore;
  log: VocActionLog;
  clock: { now: Date };
}

function makeService(opts: { pollMinutes?: number; dataDir?: string; deps?: Partial<VocServiceDeps> } = {}): Harness {
  const dataDir = opts.dataDir ?? tempDir();
  const settings = new VocSettingsStore(dataDir);
  if (opts.pollMinutes !== undefined) settings.save({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: opts.pollMinutes });
  const log = new VocActionLog(dataDir);
  const voc = new FakeVoc();
  const timers = fakeTimers();
  const boards: { board: VocBoard; tasks: Task[] }[] = [];
  const clock = { now: new Date(NOW) };
  voc.now = () => clock.now.getTime();
  const service = new VocService({
    runner: voc.runner,
    settings: () => settings,
    actions: () => log,
    today: () => TODAY,
    holidays: holidaysJson.holidays,
    pageMaps: () => PAGE_MAPS,
    now: () => clock.now,
    onBoard: (board, tasks) => boards.push({ board, tasks }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...opts.deps,
  });
  return { service, voc, timers, boards, dataDir, settings, log, clock };
}

async function loaded(opts: Parameters<typeof makeService>[0] = {}): Promise<Harness> {
  const h = makeService(opts);
  const board = await h.service.refresh();
  expect(board.state).toBe('ok');
  h.voc.calls.length = 0;
  h.boards.length = 0;
  return h;
}

function laneOf(board: VocBoard, key: string) {
  const lane = board.lanes.find((l) => l.key === key);
  if (!lane) throw new Error(`칸이 없음: ${key}`);
  return lane;
}

function ids(board: VocBoard, key: string): number[] {
  return laneOf(board, key).tickets.map((t) => t.id);
}

let opSeq = 0;
function opId(): string {
  opSeq++;
  return `00000000-0000-4000-8000-${String(opSeq).padStart(12, '0')}`;
}

// ---------------------------------------------------------------- 받기·상태

describe('VocService 받기(명세 §2-3)', () => {
  it('시작 5초 뒤 첫 받기 — whoami·user list·ticket list, 칸·합계·나·웹 주소, onBoard 에 내 VOC 할 일', async () => {
    const h = makeService({ pollMinutes: 15 });
    expect(h.service.board().state).toBe('loading');
    h.service.start();
    expect(h.timers.delays()).toEqual([VOC_START_DELAY_MS]);
    expect(h.voc.calls).toEqual([]);

    h.timers.fire();
    const board = await h.service.refresh(); // 타이머가 시작한 받기를 기다린다
    expect(h.voc.commands()).toEqual(['whoami', 'user list --role staff,admin --json', LIST]);
    expect(h.voc.calls.every((c) => c.write === false)).toBe(true);

    expect(board.state).toBe('ok');
    expect(board.message).toBeUndefined();
    expect(board.fetchedAt).toBe(NOW.toISOString());
    expect(board.me?.id).toBe(11);
    expect(board.webBase).toBe('https://voc.example.test');
    expect(board.lanes.map((l) => l.key)).toEqual(['unassigned', 'user:11', 'user:12', 'user:13']);
    expect(laneOf(board, 'user:11').me).toBe(true);
    expect(ids(board, 'unassigned')).toEqual([1001]); // 1005 는 팀 밖 시스템
    expect(ids(board, 'user:11')).toEqual([1006, 1002]); // SLA 초과가 먼저
    expect(ids(board, 'user:12')).toEqual([1003]);
    expect(board.totals).toEqual({ team: 4, unassigned: 1, slaExceeded: 1, slaWarning: 1 });

    // onBoard: 보드와 내 담당 VOC 할 일
    expect(h.boards).toHaveLength(1);
    expect(h.boards[0].board).toBe(board);
    const tasks = h.boards[0].tasks;
    expect(tasks.map((t) => t.id)).toEqual(['v:1006', 'v:1002']);
    expect(tasks[1]).toMatchObject({ source: 'voc', status: 'wip', pri: 1, due: '2026-10-01', company: '한결케미칼' });
    expect(tasks[1].voc).toMatchObject({ id: 1002, number: 'VOC-2026-0002', status: 'in_progress' });
    expect(h.service.tasks()).toBe(tasks);

    // 다음 받기는 설정 주기(15분) 뒤
    expect(h.timers.delays()).toEqual([15 * 60_000]);
    h.service.stop();
    expect(h.timers.delays()).toEqual([]);
  });

  it('폴링: 주기마다 목록만 다시 받는다(사람 목록은 하루 캐시), 주기는 5~60분 안으로', async () => {
    const h = makeService({ pollMinutes: 5 });
    h.service.start();
    h.timers.fire();
    await h.service.refresh();
    h.voc.calls.length = 0;
    expect(h.timers.delays()).toEqual([5 * 60_000]);

    h.voc.tickets = h.voc.tickets.filter((t) => t.id !== 1003);
    h.timers.fire();
    const board = await h.service.refresh();
    expect(h.voc.commands()).toEqual([LIST]);
    expect(ids(board, 'user:12')).toEqual([]);
    expect(h.timers.delays()).toEqual([5 * 60_000]);

    // 설정 파일의 주기가 범위 밖이어도 5~60분
    fs.writeFileSync(h.settings.filePath, JSON.stringify({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 1 }));
    const h2 = makeService({ dataDir: h.dataDir });
    h2.service.start();
    h2.timers.fire();
    await h2.service.refresh();
    const delay = h2.timers.delays()[0];
    expect(delay).toBeGreaterThanOrEqual(5 * 60_000);
    expect(delay).toBeLessThanOrEqual(60 * 60_000);
  });

  it('새로고침 합치기: 받는 중에 또 부르면 같은 약속, voc-cli 는 한 번', async () => {
    const h = makeService();
    const a = h.service.refresh();
    const b = h.service.refresh();
    expect(b).toBe(a);
    await a;
    expect(h.voc.commands().filter((c) => c === LIST)).toHaveLength(1);
    // 끝난 뒤 부르면 새로 받는다
    await h.service.refresh();
    expect(h.voc.commands().filter((c) => c === LIST)).toHaveLength(2);
  });

  it('로그인 필요면 폴링을 멈추고(타이머 없음) 화면 열기·깨어남에도 부르지 않는다 — [다시 확인]으로 돌아온다', async () => {
    const h = makeService();
    h.voc.mode = 'login';
    h.service.start();
    h.timers.fire();
    const board = await h.service.refresh();
    expect(board.state).toBe('login');
    expect(board.message).toContain('로그인이 필요합니다');
    expect(board.loginCommand).toBe(VOC_LOGIN_COMMAND);
    expect(h.voc.commands()).toEqual(['whoami']);
    expect(h.timers.delays()).toEqual([]);
    expect(h.boards.at(-1)?.tasks).toEqual([]); // 한 번도 받지 못했으면 VOC 할 일은 없다

    h.clock.now = new Date(NOW.getTime() + 60 * 60_000);
    h.service.refreshIfOlder(2 * 60_000);
    h.service.onResume();
    expect(h.voc.commands()).toEqual(['whoami']);

    h.voc.mode = 'ok';
    const back = await h.service.refresh(); // [다시 확인]
    expect(back.state).toBe('ok');
    expect(back.loginCommand).toBeUndefined();
    expect(h.timers.delays()).toEqual([10 * 60_000]);
  });

  it('받은 뒤 세션이 만료되면 login — 마지막 칸·VOC 할 일은 그대로, 명령에 로그인 ID', async () => {
    const h = await loaded();
    const before = h.service.tasks();
    h.voc.mode = 'expired';
    const board = await h.service.refresh();
    expect(board.state).toBe('login');
    expect(board.message).toContain('세션이 만료되었습니다');
    expect(board.loginCommand).toBe('voc-cli login -u hong');
    expect(ids(board, 'user:11')).toEqual([1006, 1002]);
    expect(h.service.tasks()).toBe(before);
    expect(h.boards.at(-1)?.tasks).toBe(before);
  });

  it('terminalLogin:false(앱이 VOC API 를 직접 부른다 — 명세 §15)면 login 보드에 터미널 명령이 없다 — 기본 아이디는 그대로', async () => {
    const first = makeService({ deps: { terminalLogin: false } });
    first.voc.mode = 'login';
    const plain = await first.service.refresh();
    expect(plain.state).toBe('login');
    expect(plain).not.toHaveProperty('loginCommand');
    expect(first.boards.at(-1)?.board).not.toHaveProperty('loginCommand');

    const h = await loaded({ deps: { terminalLogin: false } });
    h.voc.mode = 'expired';
    const board = await h.service.refresh();
    expect(board.state).toBe('login');
    expect(board.message).toContain('세션이 만료되었습니다');
    expect(board).not.toHaveProperty('loginCommand');
    expect(board.loginId).toBe('hong');
    expect(h.service.board()).not.toHaveProperty('loginCommand');
    // 다시 확인해도(login 이 이어져도) 명령이 붙지 않는다
    expect(await h.service.refresh()).not.toHaveProperty('loginCommand');
  });

  it('terminalLogin 을 주지 않거나 true 면(voc-cli 를 띄운다) login 보드에 터미널 명령이 있다', async () => {
    for (const deps of [{}, { terminalLogin: true }]) {
      const h = await loaded({ deps });
      h.voc.mode = 'expired';
      const board = await h.service.refresh();
      expect(board, JSON.stringify(deps)).toMatchObject({ state: 'login', loginId: 'hong', loginCommand: 'voc-cli login -u hong' });
    }
  });

  it('받은 뒤 서버에 못 닿으면 stale(마지막 보드 + 이유), 처음부터 못 닿으면 unavailable', async () => {
    const h = await loaded();
    const fetchedAt = h.service.board().fetchedAt;
    h.voc.mode = 'offline';
    h.clock.now = new Date(NOW.getTime() + 10 * 60_000);
    const board = await h.service.refresh();
    expect(board.state).toBe('stale');
    expect(board.message).toContain('VOC 서버에 연결하지 못했습니다');
    expect(board.fetchedAt).toBe(fetchedAt);
    expect(board.totals.team).toBe(4);
    expect(h.boards.at(-1)?.tasks.map((t) => t.id)).toEqual(['v:1006', 'v:1002']);

    h.voc.mode = 'ok';
    const again = await h.service.refresh();
    expect(again.state).toBe('ok');
    expect(again.message).toBeUndefined();
    expect(again.fetchedAt).toBe(h.clock.now.toISOString());

    const fresh = makeService();
    fresh.voc.mode = 'offline';
    expect((await fresh.service.refresh()).state).toBe('unavailable');
  });

  it('voc-cli 를 실행하지 못하면(jar 없음) notConfigured', async () => {
    const h = makeService();
    h.voc.reject = new VocRunError({ state: 'notConfigured', message: 'voc-cli jar 를 찾지 못했습니다 — 설정에서 위치를 지정하세요' });
    const board = await h.service.refresh();
    expect(board.state).toBe('notConfigured');
    expect(board.message).toContain('jar 를 찾지 못했습니다');
  });

  it('화면을 열 때: 마지막 받기가 2분 넘었을 때만 받는다, 깨어나면 한 번', async () => {
    const h = await loaded();
    h.clock.now = new Date(NOW.getTime() + 60_000);
    h.service.refreshIfOlder(2 * 60_000);
    expect(h.voc.calls).toEqual([]);
    h.clock.now = new Date(NOW.getTime() + 3 * 60_000);
    h.service.refreshIfOlder(2 * 60_000);
    await h.service.refresh();
    expect(h.voc.commands()).toEqual([LIST]);

    h.voc.calls.length = 0;
    h.service.onResume(); // 시작하지 않았으면 부르지 않는다
    expect(h.voc.calls).toEqual([]);
    h.service.start();
    h.service.onResume();
    await h.service.refresh();
    expect(h.voc.commands()).toEqual([LIST]);
    h.service.stop();
  });

  it('여러 쪽 목록은 --page N 으로 이어 받고 같은 id 는 한 번', async () => {
    const h = makeService();
    const pageOf = (n: number): Dto[] => (n === 1 ? h.voc.tickets.slice(0, 4) : h.voc.tickets.slice(3));
    const inner = h.voc.runner.run;
    h.voc.runner.run = async (args, opts) => {
      if (args.slice(0, 2).join(' ') === 'ticket list') {
        h.voc.calls.push({ args: [...args], write: opts?.write });
        const i = args.indexOf('--page');
        const page = i >= 0 ? Number(args[i + 1]) : 1;
        return { code: 0, stdout: JSON.stringify({ data: pageOf(page), total: 7, page, pageSize: 4, totalPages: 2 }), stderr: '', timedOut: false };
      }
      return inner(args, opts);
    };
    const board = await h.service.refresh();
    expect(h.voc.commands().filter((c) => c.startsWith('ticket list'))).toEqual([LIST, `${LIST} --page 2`]);
    expect(board.totals.team).toBe(4);
    expect(ids(board, 'user:11')).toEqual([1006, 1002]);
  });
});

// ---------------------------------------------------------------- 쓰기 — V2·V3a

describe('VocService 쓰기(명세 §4·§5)', () => {
  it('담당 지정 — 지금 상태가 new 면 --status assigned 도, 결과로 보드를 바로 고치고 목록을 다시 받는다', async () => {
    const h = await loaded();
    const actionId = opId();
    const res = await h.service.action({ actionId, kind: 'assign', ticketId: 1001, value: '12' });
    expect(res.ok).toBe(true);
    expect(res.message).toBe('담당 지정: VOC-2026-0001 → 김담당 · 상태 new → assigned');
    expect(res.ticket).toMatchObject({ id: 1001, assigneeId: 12, status: 'assigned' });
    expect(h.voc.writes()).toEqual([
      { args: ['ticket', 'update', '1001', '--assignee', '12', '--status', 'assigned', '--json'], write: true, timeoutMs: 90_000 },
    ]);
    // 바로 고친 보드가 먼저 방송된다(미배정 → 김담당 칸)
    expect(ids(h.boards[0].board, 'unassigned')).toEqual([]);
    expect(ids(h.boards[0].board, 'user:12')).toContain(1001);
    // 이어서 목록을 새로 받는다
    const board = await h.service.refresh();
    expect(h.voc.commands().at(-1)).toBe(LIST);
    expect(ids(board, 'user:12').sort()).toEqual([1001, 1003]);
    // 기록
    const rec = h.log.list()[0];
    expect(rec).toMatchObject({ id: actionId, kind: 'assign', ticketId: 1001, number: 'VOC-2026-0001', ok: true });
    expect(rec.detail).toContain('김담당(12)');
  });

  it('담당 지정 — new 가 아니면 --assignee 만, 같은 사람·모르는 사람은 막는다', async () => {
    const h = await loaded();
    const res = await h.service.action({ actionId: opId(), kind: 'assign', ticketId: 1003, value: '13' });
    expect(res.ok).toBe(true);
    expect(h.voc.writes()[0].args).toEqual(['ticket', 'update', '1003', '--assignee', '13', '--json']);
    await h.service.refresh();

    const same = await h.service.action({ actionId: opId(), kind: 'assign', ticketId: 1003, value: '13' });
    expect(same).toEqual({ ok: false, message: '이미 박담당 담당입니다' });
    const unknown = await h.service.action({ actionId: opId(), kind: 'assign', ticketId: 1003, value: '999' });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('사용자 목록에 없는');
    expect(h.voc.writes()).toHaveLength(1);
  });

  it('ICT 예상완료일 바꾸기·지우기, 우선순위', async () => {
    const h = await loaded();
    const set = await h.service.action({ actionId: opId(), kind: 'ictDue', ticketId: 1003, value: '2026-10-05' });
    expect(set.ok).toBe(true);
    expect(set.message).toBe('ICT 예상완료일: VOC-2026-0003 없음 → 10/5');
    await h.service.refresh();
    const clear = await h.service.action({ actionId: opId(), kind: 'ictDue', ticketId: 1002, value: '' });
    expect(clear.ok).toBe(true);
    expect(clear.ticket?.ictDue).toBeUndefined();
    await h.service.refresh();
    const pri = await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(pri.ok).toBe(true);
    expect(pri.message).toBe('우선순위: VOC-2026-0003 P3 → P1');
    expect(h.voc.writes().map((c) => c.args)).toEqual([
      ['ticket', 'update', '1003', '--ict-due', '2026-10-05', '--json'],
      ['ticket', 'update', '1002', '--clear-ict-due', '--json'],
      ['ticket', 'update', '1003', '-p', 'P1', '--json'],
    ]);
    await h.service.refresh();
    // 이미 비어 있는 날짜 지우기·같은 우선순위는 부르지 않는다
    expect((await h.service.action({ actionId: opId(), kind: 'ictDue', ticketId: 1002, value: '' })).ok).toBe(false);
    expect((await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P1' })).ok).toBe(false);
    expect(h.voc.writes()).toHaveLength(3);
  });

  it('답변(ticket reply <id> --content=<HTML>)·상태(-s in_progress|pending)', async () => {
    const h = await loaded();
    const text = '확인했습니다.\r\n다음 주 월요일까지 반영하겠습니다.';
    const reply = await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value: text });
    expect(reply).toEqual({ ok: true, message: 'VOC-2026-0002 에 답변을 등록했습니다' });
    await h.service.refresh();
    const status = await h.service.action({ actionId: opId(), kind: 'status', ticketId: 1006, value: 'pending' });
    expect(status.ok).toBe(true);
    expect(status.message).toBe('상태: VOC-2026-0006 배정됨 → 보류');
    // VOC 는 답변을 HTML 로 저장하고 그린다 — 줄바꿈은 <br>(평문 그대로면 한 문단으로 붙는다)
    expect(h.voc.writes().map((c) => c.args)).toEqual([
      ['ticket', 'reply', '1002', '--content=<p>확인했습니다.<br>다음 주 월요일까지 반영하겠습니다.</p>'],
      ['ticket', 'update', '1006', '-s', 'pending', '--json'],
    ]);
    // 답변에는 쓰기 직전 다시 읽기가 없다(덮어쓰는 값이 없다), 상태는 한 번 읽는다
    expect(h.voc.commands().filter((c) => c.startsWith('ticket get'))).toEqual(['ticket get 1006 --json']);
    // 답변 수는 목록에서 새로 받는다(get·update 결과에는 없다)
    const board = await h.service.refresh();
    expect(laneOf(board, 'user:11').tickets.find((t) => t.id === 1002)?.replyCount).toBe(3);
    expect(h.service.tasks().find((t) => t.id === 'v:1006')?.status).toBe('wip');
  });

  it("사람이 쓴 글(답변·제목·내용)은 늘 --긴이름=값 한 인자로 — '-'·'@'·'*' 로 시작해도 옵션·@파일·와일드카드로 읽히지 않게", async () => {
    expect(textOption('--content', '확인')).toBe('--content=확인');
    expect(textOption('--title', '-p로 바꿨습니다')).toBe('--title=-p로 바꿨습니다');
    const h = await loaded();
    for (const value of ['- 1차 반영\n- 2차 확인', '*', '@@확인', '@C:\\Windows\\win.ini', 'C:\\logs\\*.txt']) {
      expect((await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value })).ok).toBe(true);
    }
    await h.service.create(createInput({ title: '-긴급 확인', description: '--desc 처럼 보이는 내용' }), mailTask(), () => ({ ok: true }));
    await h.service.create(
      createInput({ taskId: 'c:at0000000001', title: '@secret.txt', description: '*' }),
      mailTask({ id: 'c:at0000000001' }),
      () => ({ ok: true }),
    );
    const writes = h.voc.writes().map((w) => w.args);
    expect(writes.slice(0, 5)).toEqual([
      ['ticket', 'reply', '1002', '--content=<p>- 1차 반영<br>- 2차 확인</p>'],
      ['ticket', 'reply', '1002', '--content=<p>*</p>'],
      ['ticket', 'reply', '1002', '--content=<p>@@확인</p>'],
      ['ticket', 'reply', '1002', '--content=<p>@C:\\Windows\\win.ini</p>'],
      ['ticket', 'reply', '1002', '--content=<p>C:\\logs\\*.txt</p>'],
    ]);
    expect(writes[5].slice(0, 4)).toEqual(['ticket', 'create', '--title=-긴급 확인', '--desc=<p>--desc 처럼 보이는 내용</p>']);
    expect(writes[6].slice(0, 4)).toEqual(['ticket', 'create', '--title=@secret.txt', '--desc=<p>*</p>']);
    // 글 값이 따로 떨어진 인자(-c <값>·-t <값>·-d <값>)로 나가는 일이 없다
    for (const args of writes) {
      for (const short of ['-c', '-t', '-d', '--content', '--title', '--desc']) expect(args).not.toContain(short);
    }
  });

  it('같은 actionId 는 두 번 실행하지 않는다(다시 띄운 앱에서도 — voc-actions.json)', async () => {
    const h = await loaded();
    const actionId = opId();
    expect((await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P2' })).ok).toBe(true);
    await h.service.refresh();
    const again = await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(again.ok).toBe(false);
    expect(again.message).toContain('이미 실행한 동작입니다');

    const h2 = await loaded({ dataDir: h.dataDir });
    const restarted = await h2.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(restarted.ok).toBe(false);
    expect(restarted.message).toContain('이미 실행한 동작입니다');
    expect(h.voc.writes().length + h2.voc.writes().length).toBe(1);
  });

  it('실행 중에는 같은 티켓의 다른 동작·같은 actionId 를 막는다', async () => {
    const h = await loaded();
    let release: () => void = () => undefined;
    h.voc.hold = new Promise<void>((r) => {
      release = r;
    });
    const actionId = opId();
    const first = h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' });
    await Promise.resolve();
    const other = await h.service.action({ actionId: opId(), kind: 'ictDue', ticketId: 1003, value: '2026-10-05' });
    expect(other).toEqual({ ok: false, message: '이 티켓의 다른 동작을 실행하는 중입니다 — 끝난 뒤 다시 하세요' });
    const dup = await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(dup.message).toBe('이 동작을 실행하는 중입니다(같은 입력)');
    // 다른 티켓은 된다(runner 가 차례로 돌린다)
    const elsewhere = h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1006, value: 'P1' });
    release();
    expect((await first).ok).toBe(true);
    expect((await elsewhere).ok).toBe(true);
    expect(h.voc.writes()).toHaveLength(2);
  });

  it('CP949 로 보낼 수 없는 글자는 막는다(voc-cli 를 부르지 않는다)', async () => {
    const h = await loaded();
    expect(h.service.checkText('확인 ✓ 완료 😀 ✓')).toEqual(['✓', '😀']);
    expect(h.service.checkText('한글·ASCII 와\n줄바꿈은 됩니다')).toEqual([]);
    const res = await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value: '확인 ✓ 완료 😀' });
    expect(res).toEqual({ ok: false, message: 'VOC 로 보낼 수 없는 글자: ✓ 😀' });
    expect(h.voc.calls).toEqual([]);
    expect(h.log.list()).toEqual([]);
  });

  it('쓰기 실패(fail-write)는 서버 문장 그대로, 보드는 그대로, 기록은 ok:false', async () => {
    const h = await loaded();
    const before = h.service.board();
    h.voc.mode = 'fail-write';
    const actionId = opId();
    const res = await h.service.action({ actionId, kind: 'status', ticketId: 1006, value: 'in_progress' });
    expect(res).toEqual({ ok: false, message: '작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.' });
    expect(h.service.board()).toBe(before);
    expect(h.boards).toEqual([]);
    expect(h.voc.commands().filter((c) => c === LIST)).toEqual([]); // 실패하면 다시 받지 않는다
    expect(h.log.list()[0]).toMatchObject({ id: actionId, kind: 'status', ok: false, message: res.message });
    // 서버에 닿은 시도였으므로 같은 actionId 는 다시 실행하지 않는다
    h.voc.mode = 'ok';
    expect((await h.service.action({ actionId, kind: 'status', ticketId: 1006, value: 'in_progress' })).ok).toBe(false);
  });

  it('시간 초과는 결과를 모른다고 알리고, 로그인 필요는 기록 없이 보드를 login 으로', async () => {
    const h = await loaded();
    h.voc.mode = 'slow-timeout';
    const slow = await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(slow.ok).toBe(false);
    expect(slow.message).toContain('반영됐는지 VOC 에서 확인하세요');

    h.voc.mode = 'login';
    const actionId = opId();
    const login = await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P2' });
    expect(login.ok).toBe(false);
    expect(h.service.board().state).toBe('login');
    expect(h.boards.at(-1)?.board.state).toBe('login');
    expect(h.log.list().map((r) => r.id)).not.toContain(actionId);
    // 로그인한 뒤 같은 동작을 다시 할 수 있다(서버에 닿지 않았다)
    h.voc.mode = 'ok';
    await h.service.refresh();
    expect((await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P2' })).ok).toBe(true);
  });

  it('입력 형식이 틀리면 던지고, 보드에 없는 티켓은 ok:false', async () => {
    const h = await loaded();
    const bad = (input: Record<string, unknown>) => h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P1', ...input } as never);
    await expect(bad({ actionId: 'short' })).rejects.toThrow(/actionId/);
    await expect(bad({ kind: 'delete' })).rejects.toThrow(/알 수 없는 동작/);
    await expect(bad({ ticketId: 0 })).rejects.toThrow(/ticketId/);
    await expect(bad({ ticketId: 1.5 })).rejects.toThrow(/ticketId/);
    await expect(bad({ value: 'P9' })).rejects.toThrow(/우선순위/);
    await expect(bad({ kind: 'ictDue', value: '2026/10/05' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(bad({ kind: 'assign', value: '-1' })).rejects.toThrow(/담당자 id/);
    await expect(bad({ kind: 'status', value: 'resolved' })).rejects.toThrow(/in_progress·pending/);
    const missing = await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 4242, value: 'P1' });
    expect(missing).toEqual({ ok: false, message: '보드에 없는 티켓입니다 — 새로고침한 뒤 다시 하세요' });
    expect(h.voc.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- 쓰기 직전 다시 읽기(묵은 보드로 남의 변경을 덮지 않는다)

describe('VocService 쓰기 직전 다시 읽기', () => {
  /** 보드를 받은 뒤 동료가 VOC 웹에서 1001 을 가져가 진행 중으로 바꿨다(앱은 아직 모른다) */
  function colleagueTakes(h: Harness): void {
    const t = h.voc.tickets.find((x) => x.id === 1001) as Dto;
    t.internalAssigneeId = 13;
    t.internalAssigneeName = '박담당';
    t.status = 'in_progress';
  }

  it('보드가 묵었으면(그사이 동료가 가져가 진행 중) 담당 지정을 실행하지 않고, 보드를 지금 값으로 고친다', async () => {
    const h = await loaded();
    colleagueTakes(h);
    const res = await h.service.action({ actionId: opId(), kind: 'assign', ticketId: 1001, value: '12' });
    expect(res.ok).toBe(false);
    expect(res.message).toBe(
      '그사이 VOC 에서 바뀌어 실행하지 않았습니다(담당 미배정 → 박담당 · 상태 신규 → 진행 중) — 바뀐 내용을 확인한 뒤 다시 하세요',
    );
    expect(res.ticket).toMatchObject({ id: 1001, assigneeId: 13, status: 'in_progress' });
    expect(h.voc.commands()).toEqual(['ticket get 1001 --json']);
    expect(h.voc.writes()).toEqual([]);
    // 서버 값은 그대로(동료의 배정·진행 상태를 덮지 않았다), 보드는 지금 값으로 바로 고쳐 방송했다
    expect(h.voc.tickets.find((x) => x.id === 1001)).toMatchObject({ internalAssigneeId: 13, status: 'in_progress' });
    expect(ids(h.boards.at(-1)?.board as VocBoard, 'user:13')).toContain(1001);
    expect(ids(h.service.board(), 'unassigned')).not.toContain(1001);
    expect(h.log.list()).toEqual([]); // 서버에 쓰지 않았으니 기록도 없다
  });

  it('보드는 이미 새것이어도 확인 대화상자가 옛 값을 보였으면(expected) 실행하지 않는다', async () => {
    const h = await loaded();
    colleagueTakes(h);
    await h.service.refresh(); // 대화상자를 열어 둔 사이 새 보드가 왔다
    h.voc.calls.length = 0;
    const res = await h.service.action({
      actionId: opId(),
      kind: 'assign',
      ticketId: 1001,
      value: '12',
      expected: { assigneeId: null, status: 'new' },
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('담당 미배정 → 박담당');
    expect(h.voc.writes()).toEqual([]);
  });

  it('대화상자가 보인 값과 VOC 의 지금 값이 같으면 실행한다 — --status assigned 는 방금 읽은 상태가 new 일 때만', async () => {
    const h = await loaded();
    // 보드는 new 인데 서버는 그사이 assigned(미배정)로 바뀌었다 — 대화상자도 새 값을 보였다
    const t = h.voc.tickets.find((x) => x.id === 1001) as Dto;
    t.status = 'assigned';
    const res = await h.service.action({
      actionId: opId(),
      kind: 'assign',
      ticketId: 1001,
      value: '12',
      expected: { assigneeId: null, status: 'assigned' },
    });
    expect(res.ok).toBe(true);
    expect(h.voc.writes().map((w) => w.args)).toEqual([['ticket', 'update', '1001', '--assignee', '12', '--json']]);
    expect(res.message).toBe('담당 지정: VOC-2026-0001 → 김담당');
  });

  it('우선순위·ICT 예상일·상태도 그사이 바뀌었으면 덮지 않는다', async () => {
    const h = await loaded();
    const t = h.voc.tickets.find((x) => x.id === 1003) as Dto;
    t.priority = 'P1';
    t.ictDueDate = '2026-10-09T15:00:00Z';
    t.status = 'pending';
    const pri = await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P2', expected: { priority: 'P3' } });
    expect(pri.message).toContain('우선순위 P3 → P1');
    const due = await h.service.action({ actionId: opId(), kind: 'ictDue', ticketId: 1003, value: '2026-10-05', expected: { ictDue: null } });
    expect(due.message).toContain('ICT 예상완료일 없음 → 10/10');
    const status = await h.service.action({ actionId: opId(), kind: 'status', ticketId: 1006, value: 'pending' });
    expect(status.ok).toBe(true); // 1006 은 바뀌지 않았다
    const st = await h.service.action({ actionId: opId(), kind: 'status', ticketId: 1003, value: 'in_progress', expected: { status: 'assigned' } });
    expect(st.message).toContain('상태 배정됨 → 보류');
    expect(h.voc.writes().map((w) => w.args[2])).toEqual(['1006']);
  });

  it('그사이 해결·완료됐으면 실행하지 않고 보드에서 뺀다', async () => {
    const h = await loaded();
    (h.voc.tickets.find((x) => x.id === 1006) as Dto).status = 'resolved';
    const res = await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1006, value: 'P1' });
    expect(res).toEqual({ ok: false, message: '그사이 VOC 에서 해결 처리되어 실행하지 않았습니다(VOC-2026-0006)' });
    expect(ids(h.service.board(), 'user:11')).toEqual([1002]);
    expect(h.voc.writes()).toEqual([]);
  });

  it('다시 읽지 못하면(연결 실패·로그인 필요) 실행하지 않는다 — 기록 없음, 같은 actionId 로 다시 할 수 있다', async () => {
    const h = await loaded();
    h.voc.mode = 'offline';
    const actionId = opId();
    const res = await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^VOC 에서 지금 값을 다시 읽지 못해 실행하지 않았습니다 — VOC 서버에 연결하지 못했습니다/);
    expect(h.voc.writes()).toEqual([]);
    expect(h.log.list()).toEqual([]);
    h.voc.mode = 'login';
    expect((await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' })).ok).toBe(false);
    expect(h.service.board().state).toBe('login');
    h.voc.mode = 'ok';
    await h.service.refresh();
    expect((await h.service.action({ actionId, kind: 'priority', ticketId: 1003, value: 'P1' })).ok).toBe(true);
  });

  it('expected 모양이 틀리면 던진다', async () => {
    const h = await loaded();
    const bad = (expected: unknown) =>
      h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1003, value: 'P1', expected } as never);
    await expect(bad('P3')).rejects.toThrow(/expected/);
    await expect(bad({ assigneeId: -1 })).rejects.toThrow(/assigneeId/);
    await expect(bad({ ictDue: '2026/10/05' })).rejects.toThrow(/ictDue/);
    await expect(bad({ status: 'In Progress' })).rejects.toThrow(/status/);
    expect(h.voc.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- VOC 로 보내는 글은 HTML(이스케이프·줄바꿈)

describe('VocService 보내는 글 = VOC HTML', () => {
  it('답변의 꺾쇠·따옴표는 엔티티로(태그가 VOC 웹에서 실행되지 않게), 빈 줄은 문단, 줄바꿈은 <br>', async () => {
    const h = await loaded();
    const text = '확인했습니다.\n\nFrom: 홍길동 <hong@example.com>\n<img src=x onerror="alert(1)"> a<b & c';
    expect((await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value: text })).ok).toBe(true);
    const sent = h.voc.replies[0];
    expect(sent).toBe(
      '<p>확인했습니다.</p><p>From: 홍길동 &lt;hong@example.com&gt;<br>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; a&lt;b &amp; c</p>',
    );
    expect(sent).not.toMatch(/<img|<hong/);
  });

  it('등록 내용도 HTML 로 — 출처 줄의 보낸 사람 <주소> 가 사라지지 않는다', async () => {
    const h = await loaded();
    const ctx = await h.service.createContext(mailTask(), SOURCE);
    await h.service.create(createInput({ description: ctx.description }), mailTask(), () => ({ ok: true }));
    const desc = (h.voc.writes()[0].args.find((a) => a.startsWith('--desc=')) ?? '').slice('--desc='.length);
    expect(desc).toBe(vocTextToHtml(ctx.description));
    expect(desc).toBe(
      '<p>안녕하세요.<br>8월 사용량이 실적 화면에 보이지 않습니다.<br>확인 부탁드립니다.</p><p>(메일 EHS팀 &lt;ehs@example.com&gt; · 2026-09-15 에서 등록)</p>',
    );
    // 가짜 VOC 에 저장된 내용을 되읽으면 원래 글자(문단 사이 빈 줄은 줄바꿈 하나로 — htmlToText 규칙)
    const board = await h.service.refresh();
    expect(laneOf(board, 'unassigned').tickets.find((t) => t.id === 1100)?.text).toBe(ctx.description.replace(/\n\n/g, '\n'));
  });

  it('내용 한도(10,000자)는 HTML 로 바꾼 길이로 — 넘으면 voc-cli 를 부르지 않는다, 기본 내용은 넘지 않게 줄인다', async () => {
    const h = await loaded();
    const many = '<'.repeat(3000); // 글자 3,000 → HTML 12,007
    await expect(h.service.create(createInput({ description: many }), mailTask(), () => ({ ok: true }))).rejects.toThrow(
      /내용은 VOC 에 보내는 모양\(줄바꿈·꺾쇠 등을 HTML 로 바꾼 것\)으로 10,000자까지입니다\(지금 12,007자\)/,
    );
    expect(h.voc.writes()).toEqual([]);

    // 짧은 줄이 많은 메일(글자 8,000 · 줄 4,000): 기본 내용을 HTML 10,000자 안으로 줄인다
    const lines = await h.service.createContext(mailTask(), { ...SOURCE, body: 'a\n'.repeat(4000) });
    expect(vocTextToHtml(lines.description).length).toBeLessThanOrEqual(10_000);
    expect(vocTextToHtml(lines.description).length).toBeGreaterThan(9_000);
    expect(lines.description).toMatch(/\n…\(이하 생략\)\n\n\(메일 EHS팀 <ehs@example\.com> · 2026-09-15 에서 등록\)$/);
    await h.service.create(createInput({ description: lines.description }), mailTask(), () => ({ ok: true }));
    expect(h.voc.writes()).toHaveLength(1);
  });

  it('답변은 사람이 적은 글자 수로 5,000자(앱 한도) — HTML 이 명령줄 상한(2만 자)을 넘으면 막는다', async () => {
    const h = await loaded();
    expect((await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value: `${'가\n'.repeat(2499)}가` })).ok).toBe(true);
    const tabs = await h.service.action({ actionId: opId(), kind: 'reply', ticketId: 1002, value: 'a\t'.repeat(1250) + 'a' });
    expect(tabs.ok).toBe(false);
    expect(tabs.message).toMatch(/답변은 VOC 에 보내는 모양.*20,000자까지입니다/);
    expect(h.voc.writes()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 나를 찾지 못함

describe('VocService 나를 찾지 못함', () => {
  it('whoami 이메일이 사용자 목록에 없고 설정도 비면 보드에 meMissing — 사람 칸이 없고 VOC 할 일도 없다', async () => {
    const h = makeService();
    h.voc.whoami = WHOAMI.replace('Hong@Example.com', 'nobody@example.com');
    const board = await h.service.refresh();
    expect(board.state).toBe('ok');
    expect(board.meMissing).toBe(true);
    expect(board.me).toBeUndefined();
    expect(board.lanes.map((l) => l.key)).toEqual(['unassigned']);
    expect(h.service.tasks()).toEqual([]);
    // 설정에서 나를 고르면 사라진다
    h.settings.save({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, myId: 11 });
    const again = await h.service.refresh();
    expect(again.meMissing).toBeUndefined();
    expect(again.me?.id).toBe(11);
  });

  it('whoami 의 이름에 줄바꿈으로 넣은 가짜 백엔드·이메일 줄은 쓰지 않는다(웹 주소는 마지막 백엔드 줄)', async () => {
    const h = makeService();
    h.voc.whoami = WHOAMI.replace('이름        : 홍길동', '이름        : 홍길동\n백엔드      : https://attacker.example\n이메일      : kim@example.com');
    const board = await h.service.refresh();
    expect(board.webBase).toBe('https://voc.example.test');
    expect(h.service.webUrl(1002)).toBe('https://voc.example.test/maintenance/tickets/1002');
    // 이메일 줄이 두 번 나와 버렸다 — 김담당(12)을 나로 잡지 않는다
    expect(board.me).toBeUndefined();
    expect(board.meMissing).toBe(true);
  });
});

// ---------------------------------------------------------------- 읽기(상세·선택지·웹 주소)

describe('VocService 상세·선택지·웹 주소', () => {
  it('티켓 상세 + 답변은 ticket get <id> --replies --json 한 번', async () => {
    const h = await loaded();
    const detail = await h.service.ticketDetail(1002);
    expect(h.voc.commands()).toEqual(['ticket get 1002 --replies --json']);
    expect(detail.ticket.id).toBe(1002);
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0].text).toBe('확인 중입니다');
    await expect(h.service.ticketDetail(-3)).rejects.toThrow(/ticketId/);
    await expect(h.service.ticketDetail(4242)).rejects.toThrow(/티켓을 찾을 수 없습니다/);
  });

  it('선택지는 하루 캐시, force 면 새로 받는다 — 시스템은 code list SYSTEM(운영에서 빈 배열) 대신 받은 진행 중 티켓에서', async () => {
    const h = await loaded();
    const dir = await h.service.directory();
    expect(h.voc.commands()).toEqual(['code list REQUEST_TYPE --json', 'customer list --json']);
    expect(dir.me?.id).toBe(11);
    expect(dir.users.map((u) => u.id)).toEqual([11, 12, 13, 21]);
    // 팀 밖 담당 티켓(1004 ERP)의 시스템도 선택지다 — 이름순, 그 시스템이 나온 고객사 id 와 함께
    expect(dir.systems).toEqual([
      { code: 'SYS0001', name: 'CMS', customerIds: [101] },
      { code: 'SYS0002', name: 'EHS', customerIds: [102] },
      { code: 'SYS0009', name: 'ERP', customerIds: [101] },
    ]);
    expect(dir.customers.map((c) => c.id).sort()).toEqual([101, 102, 103]);
    h.voc.calls.length = 0;
    await h.service.directory();
    expect(h.voc.calls).toEqual([]);
    await h.service.directory(true);
    expect(h.voc.commands()).toEqual(['whoami', 'user list --role staff,admin --json', 'code list REQUEST_TYPE --json', 'customer list --json']);

    // 설정에 저장한 팀 시스템은 티켓에 없어도 선택지에 남는다(이름을 모르면 코드)
    h.settings.save({ memberIds: [], systems: ['SYS0777', 'SYS0002'], showAllUnassigned: false, pollMinutes: 10 });
    const saved = await h.service.directory();
    expect(saved.systems.map((s) => s.code)).toEqual(['SYS0001', 'SYS0002', 'SYS0009', 'SYS0777']);
    expect(saved.systems.find((s) => s.code === 'SYS0777')).toEqual({ code: 'SYS0777', name: 'SYS0777' });
  });

  it('다시 로그인하면(다른 VOC 서버로 바꿨을 수 있다) 고객사·요청유형 하루 캐시도 버리고 새로 받는다', async () => {
    const h = await loaded();
    const before = await h.service.directory();
    expect(before.customers.map((c) => c.id).sort()).toEqual([101, 102, 103]);
    // 설정에서 서버 주소를 바꾼 것처럼: 새 서버는 고객사·요청유형이 다르고 세션이 없다
    h.voc.mode = 'login';
    const otherCustomers = [{ id: 901, customerName: '새서버고객', enabled: true }];
    const otherTypes = [{ id: 9, code: 'other', name: '기타', enabled: true }];
    const respond = h.voc.runner.run;
    h.voc.runner.run = async (args, o) => {
      const cmd = args.join(' ');
      if (h.voc.mode === 'ok' && cmd === 'customer list --json') {
        h.voc.calls.push({ args: [...args], write: o?.write, timeoutMs: o?.timeoutMs });
        return h.voc.ok(JSON.stringify(otherCustomers));
      }
      if (h.voc.mode === 'ok' && cmd === 'code list REQUEST_TYPE --json') {
        h.voc.calls.push({ args: [...args], write: o?.write, timeoutMs: o?.timeoutMs });
        return h.voc.ok(JSON.stringify(otherTypes));
      }
      return respond(args, o);
    };
    expect((await h.service.login({ loginId: 'hong', password: PW, remember: false })).ok).toBe(true);
    await h.service.refresh();
    h.voc.calls.length = 0;
    const after = await h.service.directory();
    expect(h.voc.commands()).toContain('customer list --json');
    expect(h.voc.commands()).toContain('code list REQUEST_TYPE --json');
    expect(after.customers.map((c) => c.id)).toEqual([901]);
    expect(after.requestTypes.map((t) => t.code)).toEqual(['other']);
  });

  it('로그인 전에 시작한 선택지 받기가 로그인 뒤에 끝나도 그 결과(옛 서버 것)는 캐시에 넣지 않는다', async () => {
    const h = await loaded();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const respond = h.voc.runner.run;
    let held = true;
    h.voc.runner.run = async (args, o) => {
      if (held && args.join(' ') === 'customer list --json') await gate;
      return respond(args, o);
    };
    const stale = h.service.directory();
    await new Promise((r) => setImmediate(r));
    h.voc.mode = 'login';
    expect((await h.service.login({ loginId: 'hong', password: PW, remember: false })).ok).toBe(true);
    held = false;
    release();
    await stale;
    await h.service.refresh();
    h.voc.calls.length = 0;
    await h.service.directory();
    // 캐시가 비어 있어 새로 받는다
    expect(h.voc.commands()).toEqual(['code list REQUEST_TYPE --json', 'customer list --json']);
  });

  it('목록을 한 번도 받지 않았으면 선택지를 만들기 전에 먼저 받는다(시스템이 비지 않게)', async () => {
    const h = makeService();
    const dir = await h.service.directory();
    expect(h.voc.commands().slice(0, 3)).toEqual(['whoami', 'user list --role staff,admin --json', LIST]);
    expect(dir.systems.map((s) => s.code)).toEqual(['SYS0001', 'SYS0002', 'SYS0009']);
    expect(h.service.board().state).toBe('ok');
  });

  it('선택지를 못 받으면 Error(사람 문장)', async () => {
    const h = makeService();
    h.voc.mode = 'offline';
    await expect(h.service.directory()).rejects.toThrow(/VOC 서버에 연결하지 못했습니다/);
  });

  it('webUrl: whoami 호스트의 https + /maintenance/tickets/<정수 id> 만', async () => {
    const before = makeService();
    expect(before.service.webUrl(1002)).toBeNull(); // 아직 whoami 를 모른다
    const h = await loaded();
    expect(h.service.webUrl(1002)).toBe('https://voc.example.test/maintenance/tickets/1002');
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1002' as unknown as number]) {
      expect(h.service.webUrl(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- V3b 메일 → VOC

function mailTask(extra: Partial<Task> = {}): Task {
  return {
    id: 'c:abc123def456',
    source: 'checkbox',
    title: '한결케미칼 통영공장 인벤토리 사용량 미반영 — 검토·회신',
    status: 'open',
    file: '_private/mgmt/내 할 일.md',
    line: 20,
    rawLine: '- [ ] 한결케미칼 통영공장 인벤토리 사용량 미반영 — 검토·회신 #내할일 [mail:: raw/mail/한결케미칼/2026/a.md]',
    mail: 'raw/mail/한결케미칼/2026/a.md',
    company: '한결케미칼',
    bucket: 'other',
    ...extra,
  };
}

const SOURCE: ReplySource = {
  rel: 'raw/mail/한결케미칼/2026/a.md',
  subject: 'RE: FW: 통영공장 인벤토리 확인 요청',
  from: 'EHS팀 <ehs@example.com>',
  to: ['hong@example.com'],
  cc: [],
  date: '2026-09-15T08:28:00+09:00',
  suspicion: [],
  body: '안녕하세요.\n8월 사용량이 실적 화면에 보이지 않습니다.\n확인 부탁드립니다.',
};

function createInput(extra: Record<string, unknown> = {}) {
  return {
    createId: opId(),
    taskId: 'c:abc123def456',
    title: '통영공장 인벤토리 확인 요청',
    description: '8월 사용량이 실적 화면에 보이지 않습니다.',
    customerId: 101,
    system: 'SYS0001',
    requestType: 'inquiry',
    priority: 'P3',
    ...extra,
  };
}

describe('VocService 메일 → VOC 등록(명세 §6)', () => {
  it('작성 칸 기본값의 안 보이는 글자(nbsp·좁은 공백·폭 없는 글자)는 CP949 로 보낼 수 있게 고른다 — 보이는 대시는 그대로', async () => {
    const ch = (c: number) => String.fromCharCode(c);
    expect(vocSafeDefault(`가${ch(0xa0)}나${ch(0x202f)}다${ch(0x200b)}라${ch(0xfeff)}`)).toBe('가 나 다라');
    const h = await loaded();
    const body = `안녕하세요.${ch(0xa0)}${ch(0xa0)}확인 부탁드립니다${ch(0x200d)}.\n일정 — 다음 주`;
    const ctx = await h.service.createContext(mailTask(), { ...SOURCE, subject: `RE:${ch(0xa0)}통영공장 확인`, body });
    expect(ctx.title).toBe('통영공장 확인');
    expect(ctx.description.startsWith('안녕하세요.  확인 부탁드립니다.\n일정 — 다음 주\n\n(메일 ')).toBe(true);
    expect(h.service.checkText(ctx.description)).toEqual(['—']);
  });

  it('작성 칸 기본값: 제목(접두 걷음)·내용(본문 + 출처 줄)·고객사(업체 이름)·시스템(그 고객사 티켓에 가장 많은 것)', async () => {
    const h = await loaded();
    const ctx = await h.service.createContext(mailTask(), SOURCE);
    expect(ctx).toMatchObject({
      taskId: 'c:abc123def456',
      title: '통영공장 인벤토리 확인 요청',
      customerId: 101,
      system: 'SYS0001',
      requestType: 'inquiry',
      priority: 'P3',
    });
    expect(ctx.existing).toBeUndefined();
    expect(ctx.description).toBe(`${SOURCE.body}\n\n(메일 EHS팀 <ehs@example.com> · 2026-09-15 에서 등록)`);
    expect(ctx.directory.customers.length).toBe(3);

    // 이름은 공백·대소문자를 가리지 않는다, 이미 등록한 번호는 그대로 넘긴다
    const spaced = await h.service.createContext(mailTask({ company: ' 서진 화학 ' }), null, 'VOC-2026-0042');
    expect(spaced.customerId).toBe(102);
    expect(spaced.system).toBe('SYS0002');
    expect(spaced.existing).toBe('VOC-2026-0042');
    expect(spaced.title).toBe(mailTask().title); // 원본이 없으면 할 일 제목
    expect(spaced.description).toBe('');

    // 모르는 업체 → 고객사·시스템 없음(사람이 고른다), 긴 본문은 8,000자에서 자른다
    const long = await h.service.createContext(mailTask({ company: '대륙물산' }), { ...SOURCE, body: '가'.repeat(9000) });
    expect(long.customerId).toBeUndefined();
    expect(long.system).toBeUndefined();
    expect(long.description.startsWith('가'.repeat(8000) + '\n…(이하 생략)\n\n(메일 ')).toBe(true);
  });

  it('진행 중 티켓이 없는 고객사도 시스템을 고를 수 있다(code list SYSTEM 이 비어도 받은 티켓의 시스템이 선택지)', async () => {
    const h = await loaded();
    const ctx = await h.service.createContext(mailTask({ company: '해온정밀' }), SOURCE);
    expect(ctx.customerId).toBe(103);
    expect(ctx.system).toBeUndefined(); // 이 고객사 티켓이 없으니 기본값은 없다
    expect(ctx.directory.systems.map((s) => s.code)).toEqual(['SYS0001', 'SYS0002', 'SYS0009']);
    // 고른 시스템으로 등록할 수 있다(목록에 있으니 main 도 받는다)
    const res = await h.service.create(createInput({ customerId: 103, system: 'SYS0002' }), mailTask({ company: '해온정밀' }), () => ({ ok: true }));
    expect(res.number).toMatch(/^VOC-2026-/);
    expect(h.voc.writes()[0].args).toContain('SYS0002');
  });

  it('보드를 받기 전에 작성 칸을 열어도 먼저 받아 시스템 기본값·선택지를 채운다', async () => {
    const h = makeService();
    const ctx = await h.service.createContext(mailTask(), SOURCE);
    expect(ctx.system).toBe('SYS0001');
    expect(ctx.directory.systems.length).toBe(3);
  });

  it('등록: ticket create … --source email --json → 번호로 할 일 줄에 붙이고 목록을 다시 받는다', async () => {
    const h = await loaded();
    const lines: string[] = [];
    const input = createInput({ assigneeId: 12 });
    const res = await h.service.create(input, mailTask(), (n) => {
      lines.push(n);
      return { ok: true };
    });
    expect(res).toEqual({ ticketId: 1100, number: 'VOC-2026-0100', lineUpdated: true, warnings: [] });
    expect(lines).toEqual(['VOC-2026-0100']);
    const create = h.voc.writes()[0];
    expect(create.args).toEqual([
      'ticket', 'create',
      '--title=통영공장 인벤토리 확인 요청',
      '--desc=<p>8월 사용량이 실적 화면에 보이지 않습니다.</p>',
      '--customer-id', '101',
      '--system', 'SYS0001',
      '--type', 'inquiry',
      '-p', 'P3',
      '--assignee', '12',
      '--source', 'email',
      '--json',
    ]);
    expect(create.timeoutMs).toBe(90_000);
    const rec = h.log.list()[0];
    expect(rec).toMatchObject({ id: input.createId, kind: 'create', ticketId: 1100, number: 'VOC-2026-0100', ok: true });
    const board = await h.service.refresh();
    expect(h.voc.commands().at(-1)).toBe(LIST);
    expect(ids(board, 'user:12')).toContain(1100);
  });

  it('줄에 붙이지 못해도 티켓은 만들어졌다 — lineError 와 번호', async () => {
    const h = await loaded();
    const res = await h.service.create(createInput(), mailTask(), () => ({ ok: false, error: '할 일 줄을 찾지 못함(_private/mgmt/내 할 일.md)' }));
    expect(res.ticketId).toBe(1100);
    expect(res.number).toBe('VOC-2026-0100');
    expect(res.lineUpdated).toBe(false);
    expect(res.lineError).toBe('할 일 줄을 찾지 못함(_private/mgmt/내 할 일.md)');

    const thrown = await h.service.create(createInput(), mailTask({ id: 'c:other0000001' }), () => {
      throw new Error('쓰기 허용 목록 밖');
    }).catch((e: Error) => e);
    expect(thrown).toBeInstanceOf(Error); // taskId 가 다르면 형식 오류
    const res2 = await h.service.create(createInput({ taskId: 'c:other0000001' }), mailTask({ id: 'c:other0000001' }), () => {
      throw new Error('쓰기 허용 목록 밖');
    });
    expect(res2.lineUpdated).toBe(false);
    expect(res2.lineError).toBe('쓰기 허용 목록 밖');

    // 결과에서 번호를 못 읽으면 줄에 붙이지 않고 알린다
    h.voc.createOutput = () => '티켓이 생성되었습니다.';
    let called = false;
    const res3 = await h.service.create(createInput({ taskId: 'c:third0000001' }), mailTask({ id: 'c:third0000001' }), () => {
      called = true;
      return { ok: true };
    });
    expect(called).toBe(false);
    expect(res3.lineUpdated).toBe(false);
    expect(res3.lineError).toContain('번호를 읽지 못했습니다');
  });

  it('같은 createId 는 한 번만, 등록 중 같은 할 일은 막는다', async () => {
    const h = await loaded();
    const input = createInput();
    await h.service.create(input, mailTask(), () => ({ ok: true }));
    await expect(h.service.create(input, mailTask(), () => ({ ok: true }))).rejects.toThrow(/이미 등록했습니다/);
    // 앱을 다시 띄워도(voc-actions.json)
    const h2 = await loaded({ dataDir: h.dataDir });
    await expect(h2.service.create(input, mailTask(), () => ({ ok: true }))).rejects.toThrow(/이미 등록했습니다/);

    let release: () => void = () => undefined;
    h.voc.hold = new Promise<void>((r) => {
      release = r;
    });
    const task = mailTask({ id: 'c:busy00000001' });
    const first = h.service.create(createInput({ taskId: task.id }), task, () => ({ ok: true }));
    await expect(h.service.create(createInput({ taskId: task.id }), task, () => ({ ok: true }))).rejects.toThrow(/등록하는 중입니다/);
    release();
    await first;
    expect(h.voc.writes()).toHaveLength(2);
    expect(h2.voc.writes()).toHaveLength(0);
  });

  it('등록 전에 막는 것: CP949 밖 글자·이미 [voc::] 가 있는 줄·메일 할 일 아님·목록에 없는 고객사/시스템·서버 거부', async () => {
    const h = await loaded();
    const ok = () => ({ ok: true }) as const;
    await expect(h.service.create(createInput({ title: '확인 요청 ✓' }), mailTask(), ok)).rejects.toThrow('VOC 로 보낼 수 없는 글자: ✓');
    await expect(h.service.create(createInput({ description: '내용 😀' }), mailTask(), ok)).rejects.toThrow('VOC 로 보낼 수 없는 글자: 😀');
    await expect(
      h.service.create(createInput(), mailTask({ rawLine: `${mailTask().rawLine} [voc:: VOC-2026-0042]` }), ok),
    ).rejects.toThrow('이미 VOC-2026-0042 로 등록한 할 일입니다');
    // 값이 빈 [voc::]·닫히지 않은 [voc:: 도 이미 있는 것(줄 붙이기가 거부한다) — 티켓을 만들기 전에 막는다
    for (const tail of [' [voc:: ]', ' [voc::]', ' [voc:: VOC-2026-0012', ' [ voc :: ']) {
      await expect(h.service.create(createInput(), mailTask({ rawLine: `${mailTask().rawLine}${tail}` }), ok)).rejects.toThrow(
        VOC_LINE_FIELD_BROKEN,
      );
    }
    expect(h.voc.calls).toEqual([]);
    await expect(h.service.create(createInput(), mailTask({ mail: undefined }), ok)).rejects.toThrow(/메일 할 일만/);
    await expect(h.service.create(createInput({ customerId: 999 }), mailTask(), ok)).rejects.toThrow(/고객사 목록에 없는/);
    await expect(h.service.create(createInput({ system: 'SYS9999' }), mailTask(), ok)).rejects.toThrow(/시스템 목록에 없는/);
    await expect(h.service.create(createInput({ assigneeId: 999 }), mailTask(), ok)).rejects.toThrow(/사용자 목록에 없는/);
    await expect(h.service.create(createInput({ title: '  ' }), mailTask(), ok)).rejects.toThrow(/제목을 적어/);
    await expect(h.service.create(createInput({ title: '줄\n바꿈' }), mailTask(), ok)).rejects.toThrow(/줄바꿈/);
    await expect(h.service.create(createInput({ description: '가'.repeat(10_001) }), mailTask(), ok)).rejects.toThrow(/10,000자까지/);
    await expect(h.service.create(createInput({ priority: 'P0' }), mailTask(), ok)).rejects.toThrow(/우선순위/);
    expect(h.voc.writes()).toEqual([]);

    // 서버가 분명히 거부(400)하면 티켓이 없다 — 기록은 남기되(거부 표시 id) 같은 작성 칸으로 고쳐 다시 보낼 수 있다
    h.voc.mode = 'fail-write';
    const input = createInput();
    await expect(h.service.create(input, mailTask(), ok)).rejects.toThrow('작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.');
    const rejected = h.log.list()[0];
    expect(rejected).toMatchObject({ kind: 'create', ok: false });
    expect(rejected.id.startsWith(`${input.createId}:rejected:`)).toBe(true);
    h.voc.mode = 'ok';
    const res = await h.service.create(input, mailTask(), ok);
    expect(res.number).toMatch(/^VOC-2026-/);
    expect(h.log.list()[0]).toMatchObject({ id: input.createId, kind: 'create', ok: true });
    await expect(h.service.create(input, mailTask(), ok)).rejects.toThrow(/이미 등록했습니다 — 같은 작성 칸으로는 다시 만들지 않습니다/);
  });

  it('결과를 모르는 등록(시간 초과)은 같은 createId 로 다시 만들지 않는다 — 거부 문장 끝에 화면이 보는 표식', async () => {
    const h = await loaded();
    const ok = () => ({ ok: true }) as const;
    h.voc.mode = 'slow-timeout';
    const input = createInput();
    await expect(h.service.create(input, mailTask(), ok)).rejects.toThrow(/티켓이 만들어졌는지 VOC 에서 확인하세요/);
    expect(h.log.list()[0]).toMatchObject({ id: input.createId, kind: 'create', ok: false });
    h.voc.mode = 'ok';
    await expect(h.service.create(input, mailTask(), ok)).rejects.toThrow(
      /앞선 등록 시도가 VOC 에 닿은 뒤 결과를 알 수 없습니다.* — 같은 작성 칸으로는 다시 만들지 않습니다/,
    );
    expect(h.voc.writes()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 앱 안 로그인(명세 §13)

/** 가짜 비밀번호(시험용 — 실제 값이 아니다) */
const PW = 'Pw-unit-7f3a9c';
const LOGIN_ARGS = ['login', '-u', 'hong', '--password'];
const WRONG = '로그인 실패: 아이디 또는 비밀번호를 확인하세요.';

/** 로그인 필요 상태의 서비스(폴링 시작 — 로그인 필요라 타이머 없음) */
async function loginNeeded(opts: Parameters<typeof makeService>[0] = {}): Promise<Harness> {
  const h = makeService(opts);
  h.voc.mode = 'login';
  h.service.start();
  h.timers.fire();
  const board = await h.service.refresh();
  expect(board.state).toBe('login');
  expect(h.timers.delays()).toEqual([]);
  h.voc.calls.length = 0;
  h.boards.length = 0;
  return h;
}

const loginCalls = (h: Harness) => h.voc.calls.filter((c) => c.args[0] === 'login');

/** 폴더 안 모든 파일 내용(하위 폴더 포함) */
function allFileText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${e.name}\n${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

describe('VocService 앱 안 로그인(명세 §13)', () => {
  it('인자는 login -u <아이디> --password, 비밀번호는 표준입력 한 줄(쓰기 차례·30초) — 틀리면 그 문장, 보드·폴링·설정 그대로', async () => {
    const h = await loginNeeded();
    const bad = await h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    expect(bad).toEqual({ ok: false, message: loginFailedMessage(WRONG, 1) });
    expect(h.voc.calls).toEqual([{ args: LOGIN_ARGS, write: true, timeoutMs: 30_000, stdin: 'wrong-pass\n' }]);
    expect(h.service.board().state).toBe('login');
    expect(h.boards).toEqual([]);
    expect(h.timers.delays()).toEqual([]);
    expect(h.settings.get().loginId).toBeUndefined();
  });

  it('성공하면 아이디를 기억(설정 loginId)하고 보드를 새로 받는다 — 받는 동안 loading, 끝나면 ok 와 폴링', async () => {
    const h = await loginNeeded({ pollMinutes: 15 });
    const res = await h.service.login({ loginId: 'hong', password: PW, remember: true });
    expect(res).toEqual({ ok: true, message: 'VOC 에 로그인했습니다(홍길동). 목록을 새로 받습니다' });
    // 안내 띠가 곧 '받는 중'으로(로그인 안내 명령·기본 아이디는 뗀다)
    expect(h.boards[0].board.state).toBe('loading');
    expect(h.boards[0].board.loginCommand).toBeUndefined();
    expect(h.boards[0].board.loginId).toBeUndefined();
    const board = await h.service.refresh(); // 로그인 뒤 시작한 받기에 합류
    expect(board.state).toBe('ok');
    expect(h.voc.commands()).toEqual(['login -u hong --password', 'whoami', 'user list --role staff,admin --json', LIST]);
    expect(h.timers.delays()).toEqual([15 * 60_000]);
    expect(h.settings.get()).toMatchObject({ loginId: 'hong', pollMinutes: 15 });
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'voc-settings.json'), 'utf8'))).toMatchObject({ loginId: 'hong', pollMinutes: 15 });
  });

  it('로그인 창 기본 아이디: 기억한 아이디 → whoami 의 로그인 ID. 아이디 기억을 끄고 로그인하면 지우고 whoami 것도 쓰지 않는다', async () => {
    const h = await loaded();
    h.voc.mode = 'expired';
    let b = await h.service.refresh();
    expect(b).toMatchObject({ state: 'login', loginId: 'hong', loginCommand: 'voc-cli login -u hong' });

    // 다른 아이디로 들어오면 사람 목록(whoami)부터 새로 — 나·팀이 바뀔 수 있다
    h.voc.calls.length = 0;
    expect((await h.service.login({ loginId: 'kim.d', password: PW, remember: true })).ok).toBe(true);
    await h.service.refresh();
    expect(h.voc.commands()).toContain('whoami');
    h.voc.mode = 'expired';
    b = await h.service.refresh();
    expect(b).toMatchObject({ loginId: 'kim.d', loginCommand: 'voc-cli login -u kim.d' });

    expect((await h.service.login({ loginId: 'kim.d', password: PW, remember: false })).ok).toBe(true);
    await h.service.refresh();
    expect(h.settings.get().loginId).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'voc-settings.json'), 'utf8'))).not.toHaveProperty('loginId');
    h.voc.mode = 'expired';
    b = await h.service.refresh();
    expect(b.loginId).toBeUndefined();
    expect(b.loginCommand).toBe(VOC_LOGIN_COMMAND);
  });

  it('검사: 아이디·비밀번호 규칙에 맞지 않으면 voc-cli 를 부르지 않고 ok:false, 형이 틀리면 던진다 — 어느 문장에도 비밀번호가 없다', async () => {
    const h = makeService();
    for (const loginId of ['', 'a b', '-h', '@secret.txt', 'x'.repeat(65), '홍길동', 'hong\n']) {
      const r = await h.service.login({ loginId, password: PW, remember: true });
      expect(r.ok, JSON.stringify(loginId)).toBe(false);
      expect(r.message).toMatch(/아이디/);
      expect(r.message).not.toContain(PW);
    }
    for (const password of ['', `${PW}\n`, `${PW}\r`, `${PW}${String.fromCharCode(0)}`, 'x'.repeat(257)]) {
      const r = await h.service.login({ loginId: 'hong', password, remember: true });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/비밀번호/);
      expect(r.message).not.toContain(PW);
    }
    expect(h.voc.calls).toEqual([]);
    for (const bad of [
      null,
      'hong',
      [],
      { loginId: 1, password: PW, remember: true },
      { loginId: 'hong', password: 7, remember: true },
      { loginId: 'hong', password: PW, remember: 'yes' },
      { loginId: 'hong', password: PW },
    ]) {
      const err = await h.service.login(bad as never).catch((e: unknown) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^잘못된 요청입니다/);
      expect((err as Error).message).not.toContain(PW);
    }
    // 256자(코드 포인트)까지는 받는다
    await h.service.login({ loginId: 'hong', password: '가'.repeat(256), remember: false });
    expect(loginCalls(h)).toHaveLength(1);
  });

  it('동시 로그인은 거부한다(로그인하는 중입니다)', async () => {
    const h = await loginNeeded();
    let release!: () => void;
    h.voc.loginHold = new Promise<void>((r) => {
      release = r;
    });
    const first = h.service.login({ loginId: 'hong', password: PW, remember: true });
    const second = await h.service.login({ loginId: 'hong', password: PW, remember: true });
    expect(second).toEqual({ ok: false, message: VOC_LOGIN_BUSY_MESSAGE });
    release();
    expect((await first).ok).toBe(true);
    expect(loginCalls(h)).toHaveLength(1);
  });

  it('서버 한도(5번)보다 먼저 3번째 실패에서 10분 막는다 — 첫 실패부터 서버 잠금을 알리고, 막힌 동안 voc-cli 를 부르지 않으며, 서버는 잠그지 않았다', async () => {
    expect([VOC_LOGIN_FAIL_LIMIT, VOC_LOGIN_LOCK_MS]).toEqual([3, 600_000]);
    expect(VOC_LOGIN_FAIL_LIMIT).toBeLessThan(VOC_SERVER_LOGIN_FAIL_LIMIT);
    expect(VOC_LOGIN_LOCK_MS).toBeGreaterThanOrEqual(VOC_SERVER_LOGIN_LOCK_MS);
    expect(VOC_LOGIN_LOCK_NOTE).toBe("VOC 서버는 5번 연달아 틀리면 계정을 10분 잠급니다. 잠긴 동안에는 맞는 비밀번호도 '확인하세요'로 나옵니다.");
    const h = await loginNeeded();
    const wrong = () => h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    const right = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    expect((await wrong()).message).toBe(`${WRONG} 연달아 1번 실패했습니다(3번이면 앱이 10분 동안 로그인을 막습니다). ${VOC_LOGIN_LOCK_NOTE}`);
    expect((await wrong()).message).toBe(`${WRONG} 연달아 2번 실패했습니다(3번이면 앱이 10분 동안 로그인을 막습니다). ${VOC_LOGIN_LOCK_NOTE}`);
    expect((await wrong()).message).toBe(`${WRONG} 연달아 3번 실패해 10분 동안 로그인을 막습니다. ${VOC_LOGIN_LOCK_NOTE}`);
    expect(await right()).toEqual({
      ok: false,
      message: `로그인을 연달아 3번 실패해 막아 두었습니다 — 비밀번호를 확인하고 10분 뒤에 다시 하세요. ${VOC_LOGIN_LOCK_NOTE}`,
    });
    h.clock.now = new Date(NOW.getTime() + 5 * 60_000);
    expect((await right()).message).toContain('5분 뒤에 다시 하세요');
    h.clock.now = new Date(NOW.getTime() + VOC_LOGIN_LOCK_MS - 30_000);
    expect((await right()).message).toContain('30초 뒤에 다시 하세요');
    expect(loginCalls(h)).toHaveLength(3);
    // 서버 셈은 3 — 잠그지 않았다. 10분 뒤 맞는 비밀번호로 들어가면 앱·서버 셈 모두 0
    expect(h.voc.serverLocks).toEqual([]);
    expect(h.voc.attempts.get('hong')).toEqual({ count: 3, lockedUntil: 0 });
    h.clock.now = new Date(NOW.getTime() + VOC_LOGIN_LOCK_MS + 1);
    expect((await right()).ok).toBe(true);
    expect(loginCalls(h)).toHaveLength(4);
    expect(h.voc.attempts.has('hong')).toBe(false);
    expect((await wrong()).message).toContain('연달아 1번 실패했습니다');
  });

  it('웹·터미널에서 틀린 수가 서버에 쌓여 있으면 앱 3번째 실패에 서버가 잠근다 — 앱도 10분 막아 그동안 맞는 비밀번호가 "틀림"으로 보이지 않고, 10분 뒤 들어간다', async () => {
    const h = await loginNeeded();
    h.voc.attempts.set('hong', { count: 2, lockedUntil: 0 }); // VOC 웹에서 2번 틀렸다
    const wrong = () => h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    const right = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    // 첫 실패부터 서버 잠금 규칙을 알린다(서버에 얼마나 쌓였는지 앱은 모른다)
    expect((await wrong()).message).toContain(VOC_LOGIN_LOCK_NOTE);
    await wrong();
    expect((await wrong()).message).toContain('10분 동안 로그인을 막습니다');
    expect(h.voc.serverLocks).toEqual(['hong']);
    // 서버가 잠근 동안: 맞는 비밀번호를 서버로 보내지 않는다(보냈으면 '확인하세요'가 나왔다)
    h.clock.now = new Date(NOW.getTime() + 9 * 60_000);
    expect((await right()).message).toMatch(/^로그인을 연달아 3번 실패해 막아 두었습니다/);
    expect(loginCalls(h)).toHaveLength(3);
    h.clock.now = new Date(NOW.getTime() + VOC_LOGIN_LOCK_MS + 1);
    expect(await right()).toMatchObject({ ok: true });
  });

  it('막아 둔 10분이 지나도 셈은 그대로(서버 셈처럼 시간으로 줄지 않는다) — 한 번 더 틀리면 다시 10분, 서버 한도에 닿은 셈만 10분 뒤 처음부터', async () => {
    const h = await loginNeeded();
    const at = (ms: number) => (h.clock.now = new Date(NOW.getTime() + ms));
    const wrong = () => h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    const right = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    for (let i = 0; i < 3; i++) await wrong();
    at(VOC_LOGIN_LOCK_MS + 1);
    expect((await wrong()).message).toBe(loginFailedMessage(WRONG, 4));
    expect(loginFailedMessage(WRONG, 4)).toContain('연달아 4번 실패해 10분 동안 로그인을 막습니다');
    expect((await right()).message).toMatch(/^로그인을 연달아 4번 실패해 막아 두었습니다 — 비밀번호를 확인하고 10분 뒤에/);
    expect(loginCalls(h)).toHaveLength(4);
    // 다섯 번째 — 서버 한도라 서버가 잠갔다
    at(2 * (VOC_LOGIN_LOCK_MS + 1));
    expect((await wrong()).message).toBe(loginFailedMessage(WRONG, 5));
    expect(h.voc.serverLocks).toEqual(['hong']);
    expect((await right()).message).toMatch(/^로그인을 연달아 5번 실패해 막아 두었습니다/);
    expect(loginCalls(h)).toHaveLength(5);
    // 10분 뒤: 서버 잠금이 풀리며 서버 셈도 0 — 앱도 처음부터 센다(한 번 틀려도 막지 않는다)
    at(3 * (VOC_LOGIN_LOCK_MS + 1));
    expect((await wrong()).message).toBe(loginFailedMessage(WRONG, 1));
    expect(h.voc.attempts.get('hong')).toEqual({ count: 1, lockedUntil: 0 });
    expect((await right()).ok).toBe(true);
    expect(loginCalls(h)).toHaveLength(7);
  });

  it('성공하면 셈을 0 으로 — 틀림 2번 → 성공 → 틀림 1번은 1번째(막지 않는다)', async () => {
    const h = await loginNeeded();
    const wrong = () => h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    await wrong();
    expect((await wrong()).message).toContain('연달아 2번 실패했습니다');
    expect((await h.service.login({ loginId: 'hong', password: PW, remember: true })).ok).toBe(true);
    expect((await wrong()).message).toBe(loginFailedMessage(WRONG, 1));
    expect((await wrong()).message).toBe(loginFailedMessage(WRONG, 2));
    expect(loginCalls(h)).toHaveLength(5);
  });

  it('시간 초과도 센다 — 3번째 시간 초과에 10분 막고, 막힌 동안 voc-cli 를 부르지 않는다', async () => {
    const h = await loginNeeded();
    h.voc.loginResult = () => ({ code: -1, stdout: '', stderr: '', timedOut: true });
    const go = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    expect((await go()).message).toBe(`${VOC_LOGIN_TIMEOUT_MESSAGE}. 연달아 1번 실패했습니다(3번이면 앱이 10분 동안 로그인을 막습니다). ${VOC_LOGIN_LOCK_NOTE}`);
    expect((await go()).message).toBe(loginFailedMessage(VOC_LOGIN_TIMEOUT_MESSAGE, 2));
    expect((await go()).message).toBe(loginFailedMessage(VOC_LOGIN_TIMEOUT_MESSAGE, 3));
    expect((await go()).message).toMatch(/^로그인을 연달아 3번 실패해 막아 두었습니다/);
    expect(loginCalls(h)).toHaveLength(3);
  });

  it('셈은 아이디별 — hong 이 막혀도 다른 아이디는 voc-cli 를 부른다', async () => {
    const h = await loginNeeded();
    for (let i = 0; i < 3; i++) await h.service.login({ loginId: 'hong', password: 'wrong-pass', remember: true });
    expect((await h.service.login({ loginId: 'hong', password: PW, remember: true })).message).toMatch(/막아 두었습니다/);
    expect((await h.service.login({ loginId: 'kim.d', password: 'wrong-pass', remember: true })).message).toBe(loginFailedMessage(WRONG, 1));
    expect((await h.service.login({ loginId: 'kim.d', password: PW, remember: true })).ok).toBe(true);
    expect(loginCalls(h).map((c) => c.args[2])).toEqual(['hong', 'hong', 'hong', 'kim.d', 'kim.d']);
    // hong 은 여전히 막혀 있다(kim.d 의 성공이 hong 의 셈을 지우지 않는다)
    expect((await h.service.login({ loginId: 'hong', password: PW, remember: true })).message).toMatch(/막아 두었습니다/);
  });

  it('연결 실패(서버에 닿지 않음)는 세지 않는다', async () => {
    const off = await loginNeeded();
    off.voc.mode = 'offline';
    for (let i = 0; i < 6; i++) {
      const r = await off.service.login({ loginId: 'hong', password: PW, remember: true });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^VOC 서버에 연결하지 못했습니다 — /);
      expect(r.message).not.toContain('연달아');
    }
    off.voc.mode = 'login';
    expect((await off.service.login({ loginId: 'hong', password: PW, remember: true })).ok).toBe(true);
  });

  it('terminalLogin:false(API 모드)면 결과·표준입력 문제 문장에 voc-cli·터미널 안내가 없다', async () => {
    const h = await loginNeeded({ deps: { terminalLogin: false } });
    const go = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    h.voc.loginResult = () => h.voc.ok('알 수 없는 출력\n');
    const unread = (await go()).message;
    expect(unread).toContain('로그인 결과를 읽지 못했습니다');
    expect(unread).not.toMatch(/voc-cli|터미널/);
    h.voc.loginResult = () => h.voc.err('비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.');
    const stdin = (await go()).message;
    expect(stdin).toContain('앱 버그');
    expect(stdin).not.toMatch(/voc-cli|터미널/);
  });

  it('시간 초과·실행하지 못함·표준입력을 읽지 못함·결과를 읽지 못함', async () => {
    const h = await loginNeeded();
    const go = () => h.service.login({ loginId: 'hong', password: PW, remember: true });
    h.voc.loginResult = () => ({ code: -1, stdout: '', stderr: '', timedOut: true });
    expect(await go()).toEqual({ ok: false, message: loginFailedMessage(VOC_LOGIN_TIMEOUT_MESSAGE, 1) });
    expect(VOC_LOGIN_TIMEOUT_MESSAGE).toMatch(/^로그인이 제한 시간\(30초\)을 넘겼습니다/);
    h.voc.loginResult = () => h.voc.ok('알 수 없는 출력\n');
    expect((await go()).message).toContain('로그인 결과를 읽지 못했습니다');
    h.voc.loginResult = () => h.voc.err('비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.');
    expect((await go()).message).toContain('표준입력에서 비밀번호를 읽지 못했습니다');
    h.voc.loginResult = null;
    h.voc.reject = new VocRunError({ state: 'notConfigured', message: VOC_GUARD_MESSAGE });
    expect(await go()).toEqual({ ok: false, message: VOC_GUARD_MESSAGE });
    expect(h.service.board().state).toBe('login');
  });

  it('비밀번호는 결과·오류·보드·VOC 할 일·설정·쓰기 기록·로그 어디에도 없다(voc-cli 가 되비춰도 가린다)', async () => {
    // 객체로 찍은 값도 속성까지 편다(String() 이면 '[object Object]' 라 객체 누출을 보지 못한다 — consoleCapture.ts)
    const cap = captureConsole();
    const logged = cap.lines;
    try {
      const h = await loaded({ pollMinutes: 15 });
      // 쓰기 기록(voc-actions.json)도 하나 남긴다
      expect((await h.service.action({ actionId: opId(), kind: 'priority', ticketId: 1001, value: 'P1' })).ok).toBe(true);
      h.voc.mode = 'expired';
      await h.service.refresh();
      const results: VocLoginResult[] = [];
      results.push(await h.service.login({ loginId: 'hong', password: 'Wrong-pass-x9', remember: true }));
      h.voc.loginResult = (stdin) => h.voc.err(`요청 실패: ${stdin.trim()} 를 보내지 못했습니다`);
      results.push(await h.service.login({ loginId: 'hong', password: PW, remember: true }));
      expect(results[1].message).toContain('(가림)');
      h.voc.loginResult = null;
      results.push(await h.service.login({ loginId: 'hong', password: PW, remember: true }));
      expect(results[2].ok).toBe(true);
      await h.service.refresh();
      // 비밀번호는 표준입력으로만 갔다
      expect(loginCalls(h).map((c) => c.stdin)).toEqual(['Wrong-pass-x9\n', `${PW}\n`, `${PW}\n`]);
      expect(JSON.stringify(loginCalls(h).map((c) => c.args))).not.toMatch(/Pw-unit|Wrong-pass/);

      const everything = [
        JSON.stringify(results),
        JSON.stringify(h.boards),
        JSON.stringify(h.service.board()),
        JSON.stringify(h.service.tasks()),
        allFileText(h.dataDir),
        logged.join('\n'),
      ].join('\n');
      expect(everything).not.toContain(PW);
      expect(everything).not.toContain('Wrong-pass-x9');
      // 기억하는 것은 아이디뿐
      expect(allFileText(h.dataDir)).toContain('"loginId": "hong"');
    } finally {
      cap.restore();
    }
  });
});

// ---------------------------------------------------------------- 2.10단계 §7-2 메일만으로 VOC 등록

describe('VocService 메일만으로 등록(2.10단계 §7-2)', () => {
  const MAIL = 'raw/mail/한결케미칼/2026/a.md';
  const mailInput = (extra: Record<string, unknown> = {}) => {
    const { taskId: _t, ...rest } = createInput(extra);
    return { ...rest, path: MAIL };
  };

  it('기본값: V3b 와 같고 고객사는 메일함 이름으로 찾는다 · 메일함 이름이 없으면 고객사 없음', async () => {
    const h = await loaded();
    const ctx = await h.service.createContextForMail(SOURCE, '한결케미칼');
    expect(ctx).toMatchObject({ title: '통영공장 인벤토리 확인 요청', customerId: 101, system: 'SYS0001', requestType: 'inquiry', priority: 'P3' });
    expect((ctx as Record<string, unknown>).taskId).toBeUndefined();
    expect(ctx.description).toBe(`${SOURCE.body}\n\n(메일 EHS팀 <ehs@example.com> · 2026-09-15 에서 등록)`);
    const none = await h.service.createContextForMail(SOURCE, undefined, 'VOC-2026-0042');
    expect(none.customerId).toBeUndefined();
    expect(none.existing).toBe('VOC-2026-0042');
  });

  it('등록: ticket create … --source email → onCreated(메일 상태) · 줄은 붙이지 않는다', async () => {
    const h = await loaded();
    const made: { number: string; ticketId: number }[] = [];
    const res = await h.service.createForMail(mailInput(), (m) => {
      made.push(m);
      return { ok: true };
    });
    expect(res).toEqual({ ticketId: 1100, number: 'VOC-2026-0100', lineUpdated: false, warnings: [] });
    expect(made).toEqual([{ number: 'VOC-2026-0100', ticketId: 1100 }]);
    const create = h.voc.writes()[0];
    expect(create.args.slice(0, 2)).toEqual(['ticket', 'create']);
    expect(create.args).toContain('--source');
    const rec = h.log.list().find((r) => r.kind === 'create');
    expect(rec?.detail).toContain(`메일 ${MAIL}`);
  });

  it('onCreated 실패는 warnings(티켓은 만들어졌다) · 같은 createId 는 다시 실행하지 않는다', async () => {
    const h = await loaded();
    const input = mailInput();
    const res = await h.service.createForMail(input, () => ({ ok: false, error: '잠김' }));
    expect(res.number).toBe('VOC-2026-0100');
    expect(res.warnings.join()).toContain('메일 상태에 적지 못했습니다: 잠김');
    await expect(h.service.createForMail(input, () => ({ ok: true }))).rejects.toThrow();
    expect(h.voc.writes()).toHaveLength(1);
  });

  it('CP949 밖 글자·경로 없음은 만들기 전에 거부', async () => {
    const h = await loaded();
    await expect(h.service.createForMail(mailInput({ title: '확인 😀' }), () => ({ ok: true }))).rejects.toThrow('VOC 로 보낼 수 없는 글자');
    await expect(h.service.createForMail({ ...mailInput(), path: '' }, () => ({ ok: true }))).rejects.toThrow('메일 경로');
    expect(h.voc.writes()).toHaveLength(0);
  });
});
