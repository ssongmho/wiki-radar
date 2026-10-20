// 보내고 저장 흐름(docs/stage2.5-contract.md §4) — 입력 검사, 발송 줄, 흐름 순서(검사 → 중복 → 할 일 → 원본·계정 →
// 조립·발송 → 기록 → 저장)와 실패 처리. 대부분 발송·저장을 가짜 함수로 바꾸고, 끝의 통합 시험만 로컬 smtp-server 와
// 실제로 대화한다. 실제 SMTP 서버에는 접속하지 않는다. 발송 기록은 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountResult, SmtpAccount } from '../../src/main/mail/account';
import { composeMessage, type ComposeInput, type ComposedMessage } from '../../src/main/mail/compose';
import { formatQuote, type ReplySource } from '../../src/main/mail/replyContext';
import {
  QUEUE_REPLY_LIMIT,
  createReplySaver,
  sendMailReplyFlow,
  sendReplyFlow,
  sentLine,
  validateSendInput,
  type SendMailReplyDeps,
  type SendReplyDeps,
} from '../../src/main/mail/sendReply';
import { sendRawMessage, type SmtpSendResult } from '../../src/main/mail/smtp';
import { MailSettingsStore, SentLog } from '../../src/main/mail/stores';
import { QueueStore } from '../../src/main/queue';
import type {
  MailSettings,
  SaveResultInput,
  SaveResultOutput,
  SendMailReplyInput,
  SendReplyInput,
  SentMailRecord,
  Task,
} from '../../src/shared/types';
import { addressOf } from '../../src/shared/reply';

// ---- 재료 ------------------------------------------------------------------

const MAIL = 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md';

const TASK: Task = {
  id: 'c:mailtask0001',
  source: 'checkbox',
  title: '통영공장 인벤토리 확인 회신',
  status: 'open',
  file: 'wiki/entities/한결케미칼.md',
  line: 12,
  mail: MAIL,
  company: '한결케미칼',
  bucket: 'thisWeek',
};

const SOURCE: ReplySource = {
  rel: MAIL,
  subject: '통영공장 인벤토리 확인 요청',
  from: '김담당 <kim@hangyeol.test>',
  to: ['me@sender.example'],
  cc: ['박과장 <park@hangyeol.test>'],
  date: '2026-09-15T17:28:00+09:00',
  messageId: 'abc123@hangyeol.test',
  suspicion: [],
  body: '안녕하세요.\n통영공장 인벤토리 확인 부탁드립니다.',
};

const ACCOUNT: SmtpAccount = {
  host: '127.0.0.1',
  port: 2525,
  secure: false,
  requireTLS: false,
  user: 'me@sender.example',
  pass: 'secret',
};

const SETTINGS: MailSettings = { fromName: '홍길동', signature: '홍길동 드림\n케미토피아', bccSelf: true };

let seq = 0;
/** 테스트마다 다른 sendId — 흐름의 '이번 실행 중 보낸 것' 기억이 테스트끼리 섞이지 않게 */
function newSendId(): string {
  seq += 1;
  return `test-send-${String(seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 10)}`;
}

function input(over: Partial<SendReplyInput> = {}): SendReplyInput {
  return {
    sendId: newSendId(),
    taskId: TASK.id,
    to: ['김담당 <kim@hangyeol.test>'],
    cc: [],
    subject: 'RE: 통영공장 인벤토리 확인 요청',
    body: '안녕하세요.\n요청하신 인벤토리 확인을 마쳤습니다.\n\n감사합니다.\n',
    quoteOriginal: false,
    save: { taskId: TASK.id, status: 'done', note: '인벤토리 확인 완료', reflect: false },
    ...over,
  };
}

/** 가짜 발송 기록(SentLog 의 공개 함수만) */
class FakeSentLog {
  records: SentMailRecord[] = [];
  emls: Buffer[] = [];
  failAdd: Error | null = null;
  failHas: Error | null = null;
  list(): SentMailRecord[] {
    return [...this.records];
  }
  has(id: string): boolean {
    if (this.failHas) throw this.failHas;
    return this.records.some((r) => r.id === id);
  }
  lastForTask(taskId: string): SentMailRecord | undefined {
    return this.records.filter((r) => r.taskId === taskId).at(-1);
  }
  add(record: Omit<SentMailRecord, 'eml'>, eml: Buffer): SentMailRecord {
    if (this.failAdd) throw this.failAdd;
    const full: SentMailRecord = { ...record, eml: `sent/${record.id.slice(0, 8)}.eml` };
    this.records.push(full);
    this.emls.push(eml);
    return full;
  }
}

function saveOutput(): SaveResultOutput {
  return {
    date: '2026-09-28',
    updated: [`${TASK.title} [done]`],
    loggedDone: [],
    loggedDelegated: [],
    loggedWip: [],
    unlogged: [],
    memo: true,
    unmatched: [],
    files: ['wiki/entities/한결케미칼.md', '_private/mgmt/할 일 메모.md'],
    warnings: [],
  };
}

interface Harness {
  deps: SendReplyDeps;
  log: FakeSentLog;
  composed: ComposeInput[];
  sent: ComposedMessage[];
  saved: { input: SaveResultInput; extra: { reply: string } }[];
}

function harness(over: Partial<SendReplyDeps> = {}, log = new FakeSentLog()): Harness {
  const composed: ComposeInput[] = [];
  const sent: ComposedMessage[] = [];
  const saved: { input: SaveResultInput; extra: { reply: string } }[] = [];
  const deps: SendReplyDeps = {
    findTask: (id) => (id === TASK.id ? TASK : undefined),
    readSource: (rel) => (rel === MAIL ? SOURCE : null),
    loadAccount: (): AccountResult => ({ ok: true, account: ACCOUNT }),
    settings: () => ({ ...SETTINGS }),
    sentLog: () => log as unknown as SentLog,
    compose: async (ci) => {
      composed.push(ci);
      return {
        raw: Buffer.from(`Subject: ${ci.subject}\r\n\r\n${ci.text}`, 'utf8'),
        messageId: `<${composed.length}.radar@sender.example>`,
        // 실제 compose 처럼 봉투에는 주소만
        envelope: { from: ci.from.address, to: [...ci.to, ...ci.cc, ...ci.bcc].map((x) => addressOf(x) ?? x) },
      };
    },
    send: async (_account, msg): Promise<SmtpSendResult> => {
      sent.push(msg);
      return { response: '250 2.0.0 OK queued', accepted: msg.envelope.to, rejected: [] };
    },
    save: (si, extra) => {
      saved.push({ input: si, extra });
      return saveOutput();
    },
    now: () => new Date('2026-09-28T05:02:03.000Z'),
    ...over,
  };
  return { deps, log, composed, sent, saved };
}

// ---- 입력 검사 ----------------------------------------------------------------

describe('validateSendInput', () => {
  it('맞는 입력은 그대로 돌려주고 본문 줄바꿈을 LF 로 맞춘다. 저장 입력도 2단계 규칙으로 다듬는다', () => {
    const raw = {
      ...input({ sendId: '0f8a9c3e-1d2b-4c5d-8e9f-001122334455' }),
      body: '첫 줄\r\n둘째 줄\r셋째 줄',
      save: { taskId: TASK.id, status: 'notmine', owner: '  김대리  ', note: '넘김\r\n', reflect: true, extra: 1 },
      unknown: 'ignored',
    };
    const v = validateSendInput(raw);
    expect(v.sendId).toBe('0f8a9c3e-1d2b-4c5d-8e9f-001122334455');
    expect(v.body).toBe('첫 줄\n둘째 줄\n셋째 줄');
    expect(v.save).toEqual({ taskId: TASK.id, status: 'notmine', owner: '김대리', note: '넘김\n', reflect: true });
    expect(v).not.toHaveProperty('unknown');
  });

  it('형·길이가 틀리면 거부한다', () => {
    const ok = input();
    const bad: [string, unknown][] = [
      ['객체 아님', 'x'],
      ['배열', [ok]],
      ['sendId 짧음', { ...ok, sendId: 'short' }],
      ['sendId 길음', { ...ok, sendId: 'a'.repeat(65) }],
      ['sendId 글자', { ...ok, sendId: 'abc_defg/123' }],
      ['taskId 없음', { ...ok, taskId: '' }],
      ['to 목록 아님', { ...ok, to: 'kim@hangyeol.test' }],
      ['cc 에 숫자', { ...ok, cc: [1] }],
      ['주소 한 칸 320자 넘음', { ...ok, to: [`${'a'.repeat(315)}@b.test`] }],
      ['합계 20명 넘음', { ...ok, to: Array.from({ length: 11 }, (_, i) => `a${i}@b.test`), cc: Array.from({ length: 10 }, (_, i) => `c${i}@b.test`) }],
      ['subject 문자열 아님', { ...ok, subject: 3 }],
      ['body 문자열 아님', { ...ok, body: null }],
      ['quoteOriginal 참거짓 아님', { ...ok, quoteOriginal: 'yes' }],
      ['save 없음', { ...ok, save: undefined }],
      ['save 상태 틀림', { ...ok, save: { ...ok.save, status: 'closed' } }],
      ['save 담당 대괄호', { ...ok, save: { ...ok.save, status: 'notmine', owner: '[김]' } }],
      ['save 메모 제어 문자', { ...ok, save: { ...ok.save, note: 'a\u0000b' } }],
    ];
    for (const [what, raw] of bad) {
      expect(() => validateSendInput(raw), what).toThrow();
    }
  });

  it('save.taskId 가 회신할 할 일과 다르면 거부한다', () => {
    const ok = input();
    expect(() => validateSendInput({ ...ok, save: { ...ok.save, taskId: 'c:other' } })).toThrow(/다릅니다/);
  });

  it('주소 형식·제목 규칙은 흐름(replyProblem)이 본다 — 여기서는 통과한다', () => {
    const v = validateSendInput(input({ to: ['a@b.c\r\nBcc: x@y.z'], subject: '' }));
    expect(v.to).toEqual(['a@b.c\r\nBcc: x@y.z']);
  });
});

// ---- 발송 줄 -------------------------------------------------------------------

describe('sentLine', () => {
  it('받는사람은 이름(없으면 주소)을 쉼표로 잇고, 참조가 있으면 인원을 붙인다', () => {
    expect(sentLine(['김담당 <kim@hangyeol.test>', 'lee@hangyeol.test'], ['park@hangyeol.test', '최 <choi@x.test>'], 'RE: 확인')).toBe(
      '메일 회신 발송 — 받는사람: 김담당, lee@hangyeol.test · 제목: RE: 확인 · 참조 2명',
    );
  });

  it('참조가 없으면 인원을 붙이지 않는다. 따옴표 이름은 걷는다', () => {
    expect(sentLine(['"김, 담당" <kim@hangyeol.test>'], [], 'RE: 건')).toBe('메일 회신 발송 — 받는사람: 김, 담당 · 제목: RE: 건');
  });
});

// ---- 흐름 ----------------------------------------------------------------------

describe('sendReplyFlow — 보내기 전 거부(아무것도 보내거나 쓰지 않는다)', () => {
  it('[확인 필요 가 남은 본문은 보내지 않는다', async () => {
    const h = harness();
    await expect(sendReplyFlow(h.deps, input({ body: '완료 예정일은 [확인 필요: 완료 예정일] 입니다.' }))).rejects.toThrow(
      /확인 필요/,
    );
    expect(h.composed).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.log.records).toEqual([]);
  });

  it('머리말 주입 주소·빈 받는사람·빈 제목은 보내지 않는다', async () => {
    const h = harness();
    await expect(sendReplyFlow(h.deps, input({ to: ['a@b.c\r\nBcc: x@y.z'] }))).rejects.toThrow(/주소/);
    await expect(sendReplyFlow(h.deps, input({ to: [] }))).rejects.toThrow(/받는사람/);
    await expect(sendReplyFlow(h.deps, input({ subject: '  ' }))).rejects.toThrow(/제목/);
    await expect(sendReplyFlow(h.deps, input({ body: '   \n' }))).rejects.toThrow(/본문/);
    expect(h.sent).toEqual([]);
  });

  it('할 일을 못 찾거나 메일 할 일이 아니면 거부한다', async () => {
    const h = harness({ findTask: () => undefined });
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/찾지 못했습니다/);
    const noMail: Task = { ...TASK, mail: undefined };
    const h2 = harness({ findTask: () => noMail });
    await expect(sendReplyFlow(h2.deps, input())).rejects.toThrow(/메일에서 온 할 일이 아니/);
    expect(h.sent.length + h2.sent.length).toBe(0);
  });

  it('원본 메일이 없거나 읽지 못하면 거부한다', async () => {
    const h = harness({ readSource: () => null });
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/원본 메일을 찾지 못했습니다/);
    const h2 = harness({
      readSource: () => {
        throw new Error('EBUSY');
      },
    });
    await expect(sendReplyFlow(h2.deps, input())).rejects.toThrow(/원본 메일을 읽지 못했습니다: EBUSY/);
    expect(h.sent.length + h2.sent.length).toBe(0);
  });

  it('계정이 없으면 problem 문장으로 거부한다', async () => {
    const problem = '메일 계정이 없습니다: `_mail-ingest/.env`에 MAILHOST_MAIL_USER·MAILHOST_MAIL_PASS를 넣으세요';
    const h = harness({ loadAccount: () => ({ ok: false, problem }) });
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(problem);
    expect(h.composed).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('설정을 읽지 못하면 보내지 않는다(서명 없이 몰래 보내지 않게)', async () => {
    const h = harness({
      settings: () => {
        throw new Error('잠김');
      },
    });
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/설정을 읽지 못했습니다: 잠김/);
    expect(h.sent).toEqual([]);
  });

  it('실제 설정 저장소(MailSettingsStore)를 읽지 못해도 보내지 않는다 — 가짜가 아니라 실제 배선(ipc.ts)과 같게', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-send-settings-'));
    try {
      // 설정 파일 자리에 폴더 — readTextFile 이 EISDIR 등으로 실패한다(잠김과 같은 경로)
      fs.mkdirSync(path.join(dataDir, 'mail-settings.json'));
      const store = new MailSettingsStore(dataDir, () => undefined);
      const h = harness({ settings: () => store.get() });
      await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/보내는 사람·서명 설정을 읽지 못했습니다: 메일 설정/);
      expect(h.composed).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.saved).toEqual([]);
      expect(h.log.records).toEqual([]);
      // 풀리면 보낸다(설정을 기억하지 않았으므로 다시 읽는다)
      fs.rmdirSync(path.join(dataDir, 'mail-settings.json'));
      fs.writeFileSync(path.join(dataDir, 'mail-settings.json'), JSON.stringify(SETTINGS), 'utf8');
      await sendReplyFlow(h.deps, input());
      expect(h.sent).toHaveLength(1);
      expect(h.composed[0].from).toEqual({ name: SETTINGS.fromName, address: ACCOUNT.user });
      expect(h.composed[0].text).toContain(SETTINGS.signature);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('보낼 메일(제목·본문·서명·인용)에 계정 비밀번호가 섞였으면 보내지 않는다(초안에 끼어든 경우의 이중 방어)', async () => {
    const pass = 'Hiw0rks-Pa55word';
    const account: SmtpAccount = { ...ACCOUNT, pass };
    const cases: [string, Partial<SendReplyDeps>, Partial<SendReplyInput>][] = [
      ['본문 끝', {}, { body: `안녕하세요.\n확인했습니다.\n\n참조번호: ${pass}` }],
      ['제목', {}, { subject: `RE: 확인 ${pass}` }],
      ['서명', { settings: () => ({ ...SETTINGS, signature: `홍길동\n${pass}` }) }, {}],
      ['원문 인용', { readSource: () => ({ ...SOURCE, body: `원문에 ${pass}` }) }, { quoteOriginal: true }],
    ];
    for (const [what, deps, over] of cases) {
      const h = harness({ loadAccount: () => ({ ok: true, account }), ...deps });
      await expect(sendReplyFlow(h.deps, input(over)), what).rejects.toThrow(/비밀번호와 같은 글/);
      expect(h.composed, what).toEqual([]);
      expect(h.sent, what).toEqual([]);
      expect(h.saved, what).toEqual([]);
      expect(h.log.records, what).toEqual([]);
    }
    // 비밀번호가 없는 본문은 그대로 보낸다
    const h = harness({ loadAccount: () => ({ ok: true, account }) });
    await sendReplyFlow(h.deps, input());
    expect(h.sent).toHaveLength(1);
  });

  it('발송 기록을 읽지 못하면 두 번 보냈는지 알 수 없어 보내지 않는다', async () => {
    const log = new FakeSentLog();
    log.failHas = new Error('sent-mail.json 을 읽지 못했습니다');
    const h = harness({}, log);
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/발송 기록을 읽지 못해/);
    expect(h.sent).toEqual([]);
  });

  it('메일을 만들지 못하면 보내지 않는다', async () => {
    const h = harness({
      compose: async () => {
        throw new Error('bad header');
      },
    });
    await expect(sendReplyFlow(h.deps, input())).rejects.toThrow(/메일을 만들지 못했습니다: bad header/);
    expect(h.sent).toEqual([]);
    expect(h.saved).toEqual([]);
  });
});

describe('sendReplyFlow — 같은 메일을 두 번 보내지 않는다', () => {
  it('보낸 sendId 를 다시 받으면 거부한다(이번 실행 기억)', async () => {
    const h = harness();
    const first = input();
    await sendReplyFlow(h.deps, first);
    await expect(sendReplyFlow(h.deps, first)).rejects.toThrow('이미 보낸 메일입니다(같은 작성 칸)');
    expect(h.sent).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
  });

  it('발송 기록에 있는 sendId 는 거부한다(앱을 다시 켠 뒤)', async () => {
    const log = new FakeSentLog();
    const again = input();
    log.records.push({
      id: again.sendId,
      at: '2026-09-27T01:00:00.000Z',
      taskId: TASK.id,
      taskTitle: TASK.title,
      mail: MAIL,
      to: again.to,
      cc: [],
      bcc: [],
      subject: again.subject,
      messageId: '<old@sender.example>',
    });
    const h = harness({}, log);
    await expect(sendReplyFlow(h.deps, again)).rejects.toThrow('이미 보낸 메일입니다(같은 작성 칸)');
    expect(h.sent).toEqual([]);
  });

  it('기록을 남기지 못했어도 이번 실행 중에는 같은 sendId 를 다시 보내지 않는다', async () => {
    const log = new FakeSentLog();
    log.failAdd = new Error('디스크 가득');
    const h = harness({}, log);
    const one = input();
    const out = await sendReplyFlow(h.deps, one);
    expect(out.warnings.join('\n')).toMatch(/발송 기록을 남기지 못했습니다: 디스크 가득/);
    await expect(sendReplyFlow(h.deps, one)).rejects.toThrow('이미 보낸 메일입니다');
    expect(h.sent).toHaveLength(1);
  });

  it('같은 sendId 가 겹쳐 오면 하나만 보낸다', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness();
    const slowSend = h.deps.send;
    h.deps.send = async (account, msg) => {
      await gate;
      return slowSend(account, msg);
    };
    const one = input();
    const a = sendReplyFlow(h.deps, one);
    await Promise.resolve();
    await Promise.resolve();
    await expect(sendReplyFlow(h.deps, one)).rejects.toThrow(/보내는 중/);
    release();
    await a;
    expect(h.sent).toHaveLength(1);
  });

  it('발송이 실패한 sendId 는 기억하지 않는다 — 사람이 다시 누르면 보낸다', async () => {
    let fail = true;
    const h = harness();
    const realSend = h.deps.send;
    h.deps.send = async (account, msg) => {
      if (fail) throw new Error('메일 서버에 연결하지 못했습니다');
      return realSend(account, msg);
    };
    const one = input();
    await expect(sendReplyFlow(h.deps, one)).rejects.toThrow('메일 서버에 연결하지 못했습니다');
    fail = false;
    const out = await sendReplyFlow(h.deps, one);
    expect(out.sent.id).toBe(one.sendId);
  });
});

describe('sendReplyFlow — 발송 실패는 위키·기록을 그대로 둔다', () => {
  it('send 가 던지면 그 오류를 그대로 던지고 기록·저장을 하지 않는다', async () => {
    const err = Object.assign(new Error('메일 계정 인증에 실패했습니다(메일 전용 비밀번호 확인)'), { kind: 'auth' });
    const h = harness({
      send: async () => {
        throw err;
      },
    });
    await expect(sendReplyFlow(h.deps, input())).rejects.toBe(err);
    expect(h.log.records).toEqual([]);
    expect(h.saved).toEqual([]);
  });
});

describe('sendReplyFlow — 보낸 뒤', () => {
  it('보내고 기록하고 저장한다: 기록 내용·반환값', async () => {
    const h = harness();
    const one = input({ cc: ['박과장 <park@hangyeol.test>'] });
    const out = await sendReplyFlow(h.deps, one);

    expect(h.sent).toHaveLength(1);
    expect(h.log.records).toHaveLength(1);
    expect(h.log.emls[0]).toBe(h.sent[0].raw); // 보낸 바이트 그대로 남긴다
    expect(out.sent).toEqual({
      id: one.sendId,
      at: '2026-09-28T05:02:03.000Z',
      taskId: TASK.id,
      taskTitle: TASK.title,
      mail: MAIL,
      to: ['김담당 <kim@hangyeol.test>'],
      cc: ['박과장 <park@hangyeol.test>'],
      bcc: ['me@sender.example'],
      subject: one.subject,
      messageId: '<1.radar@sender.example>',
      response: '250 2.0.0 OK queued',
      eml: `sent/${one.sendId.slice(0, 8)}.eml`,
    });
    expect(out.save).toEqual(saveOutput());
    expect(out.saveError).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  it('조립: 보내는 이름·계정 주소, 원본 Message-ID 로 In-Reply-To·References, 서명을 붙인다', async () => {
    const h = harness();
    await sendReplyFlow(h.deps, input());
    const ci = h.composed[0];
    expect(ci.from).toEqual({ name: '홍길동', address: 'me@sender.example' });
    expect(ci.to).toEqual(['김담당 <kim@hangyeol.test>']);
    expect(ci.cc).toEqual([]);
    expect(ci.subject).toBe('RE: 통영공장 인벤토리 확인 요청');
    expect(ci.inReplyTo).toBe('abc123@hangyeol.test');
    expect(ci.references).toBe('abc123@hangyeol.test');
    expect(ci.text).toBe('안녕하세요.\n요청하신 인벤토리 확인을 마쳤습니다.\n\n감사합니다.\n\n홍길동 드림\n케미토피아');
  });

  it('보내는 이름이 없으면 주소만, 원본에 Message-ID 가 없으면 In-Reply-To·References 를 넣지 않는다', async () => {
    const h = harness({
      settings: () => ({ fromName: '', signature: '', bccSelf: true }),
      readSource: () => ({ ...SOURCE, messageId: undefined }),
    });
    await sendReplyFlow(h.deps, input());
    const ci = h.composed[0];
    expect(ci.from).toEqual({ address: 'me@sender.example' });
    expect(ci).not.toHaveProperty('inReplyTo');
    expect(ci).not.toHaveProperty('references');
    expect(ci.text).toBe('안녕하세요.\n요청하신 인벤토리 확인을 마쳤습니다.\n\n감사합니다.');
  });

  it('원문 인용을 켜면 서명 뒤에 인용문이 붙고, 끄면 붙지 않는다', async () => {
    const h = harness();
    await sendReplyFlow(h.deps, input({ quoteOriginal: true }));
    await sendReplyFlow(h.deps, input({ quoteOriginal: false }));
    const quoted = h.composed[0].text;
    expect(quoted).toBe(
      `안녕하세요.\n요청하신 인벤토리 확인을 마쳤습니다.\n\n감사합니다.\n\n홍길동 드림\n케미토피아\n\n${formatQuote(SOURCE)}`,
    );
    expect(quoted).toContain('-----Original Message-----');
    expect(quoted).toContain('통영공장 인벤토리 확인 부탁드립니다.');
    expect(h.composed[1].text).not.toContain('-----Original Message-----');
  });

  it('나에게 숨은참조: 켜면 계정 주소를 bcc 로(머리말이 아니라 봉투), 끄면 없음', async () => {
    const on = harness();
    const outOn = await sendReplyFlow(on.deps, input());
    expect(on.composed[0].bcc).toEqual(['me@sender.example']);
    expect(outOn.sent.bcc).toEqual(['me@sender.example']);

    const off = harness({ settings: () => ({ ...SETTINGS, bccSelf: false }) });
    const outOff = await sendReplyFlow(off.deps, input());
    expect(off.composed[0].bcc).toEqual([]);
    expect(outOff.sent.bcc).toEqual([]);
  });

  it('처리 내용이 있으면 그 뒤에 발송 줄을, 없으면 발송 줄만 메모로 저장한다', async () => {
    const h = harness();
    await sendReplyFlow(h.deps, input({ save: { taskId: TASK.id, status: 'done', note: '인벤토리 확인 완료\n\n', reflect: true } }));
    await sendReplyFlow(h.deps, input({ cc: ['park@hangyeol.test'], save: { taskId: TASK.id, status: 'wip', reflect: false } }));
    expect(h.saved[0].input).toEqual({
      taskId: TASK.id,
      status: 'done',
      reflect: true,
      note: '인벤토리 확인 완료\n메일 회신 발송 — 받는사람: 김담당 · 제목: RE: 통영공장 인벤토리 확인 요청',
    });
    expect(h.saved[1].input).toEqual({
      taskId: TASK.id,
      status: 'wip',
      reflect: false,
      note: '메일 회신 발송 — 받는사람: 김담당 · 제목: RE: 통영공장 인벤토리 확인 요청 · 참조 1명',
    });
  });

  it('반영 대기열의 reply 는 서명·인용 뺀 본문, 4,000자까지', async () => {
    const h = harness();
    await sendReplyFlow(h.deps, input({ quoteOriginal: true }));
    expect(h.saved[0].extra.reply).toBe('안녕하세요.\n요청하신 인벤토리 확인을 마쳤습니다.\n\n감사합니다.');

    const long = '가'.repeat(QUEUE_REPLY_LIMIT + 500);
    await sendReplyFlow(h.deps, input({ body: long }));
    expect(h.saved[1].extra.reply).toBe('가'.repeat(QUEUE_REPLY_LIMIT));
    expect(QUEUE_REPLY_LIMIT).toBe(4000);

    // 끝에서 서로게이트 쌍을 가르지 않는다
    const emoji = `${'a'.repeat(QUEUE_REPLY_LIMIT - 1)}\u{1F600}끝`;
    await sendReplyFlow(h.deps, input({ body: emoji }));
    expect(h.saved[2].extra.reply).toBe('a'.repeat(QUEUE_REPLY_LIMIT - 1));
  });

  it('발송 기록을 남기지 못해도 저장은 한다(warnings 에 적는다)', async () => {
    const log = new FakeSentLog();
    log.failAdd = new Error('sent-mail.json 를 저장하지 못했습니다 (EPERM)');
    const h = harness({}, log);
    const one = input();
    const out = await sendReplyFlow(h.deps, one);
    expect(h.saved).toHaveLength(1);
    expect(out.save).toBeDefined();
    expect(out.sent.id).toBe(one.sendId);
    expect(out.sent).not.toHaveProperty('eml');
    expect(out.warnings).toEqual(['메일은 보냈지만 발송 기록을 남기지 못했습니다: sent-mail.json 를 저장하지 못했습니다 (EPERM)']);
  });

  it('기록은 남겼지만 .eml 사본을 못 썼으면 warnings 에 적는다', async () => {
    const log = new FakeSentLog();
    // 실제 SentLog 는 .eml 쓰기 실패를 경고 로그로만 남기고 eml 없이 기록한다
    log.add = function (record: Omit<SentMailRecord, 'eml'>): SentMailRecord {
      const full: SentMailRecord = { ...record };
      this.records.push(full);
      return full;
    };
    const h = harness({}, log);
    const out = await sendReplyFlow(h.deps, input());
    expect(out.sent).not.toHaveProperty('eml');
    expect(out.warnings).toEqual(['메일은 보냈지만 보낸 메일 사본(.eml)을 남기지 못했습니다']);
    expect(out.save).toBeDefined();
  });

  it('저장이 실패하면 던지지 않고 saveError 에 문장을 담는다(발송·기록은 된 것)', async () => {
    const h = harness({
      save: () => {
        throw new Error('위키에 일부만 저장했습니다: 할 일 메모.md 잠김');
      },
    });
    const out = await sendReplyFlow(h.deps, input());
    expect(out.saveError).toBe('위키에 일부만 저장했습니다: 할 일 메모.md 잠김');
    expect(out.save).toBeUndefined();
    expect(h.sent).toHaveLength(1);
    expect(h.log.records).toHaveLength(1);
  });

  it('서버가 일부 주소를 받지 않았으면 warnings 에 적는다', async () => {
    const h = harness({
      send: async (_a, msg) => ({ response: '250 OK', accepted: [msg.envelope.to[0]], rejected: ['park@hangyeol.test'] }),
    });
    const out = await sendReplyFlow(h.deps, input({ cc: ['park@hangyeol.test'] }));
    expect(out.warnings).toEqual(['메일 서버가 받지 않은 주소가 있습니다: park@hangyeol.test']);
    expect(out.save).toBeDefined();
  });
});

describe('sendReplyFlow — 받는 주소 처리', () => {
  it('받는사람·참조가 모두 거부되고 숨은참조(나)만 받았으면 실패로 본다 — 기록·저장 없음, 다시 보낼 수 있다', async () => {
    const h = harness({
      send: async (_a, msg) => ({
        response: '250 OK',
        accepted: ['me@sender.example'],
        rejected: msg.envelope.to.filter((a) => a !== 'me@sender.example'),
      }),
    });
    const one = input({ cc: ['박과장 <PARK@hangyeol.test>'] });
    await expect(sendReplyFlow(h.deps, one)).rejects.toThrow(/모두 거부했습니다/);
    expect(h.log.records).toEqual([]);
    expect(h.saved).toEqual([]);
    h.deps.send = async (_a, msg) => ({ response: '250 OK', accepted: msg.envelope.to, rejected: [] });
    await expect(sendReplyFlow(h.deps, one)).resolves.toMatchObject({ sent: { id: one.sendId } });
  });

  it('계정 아이디가 메일 주소가 아니면 숨은참조를 빼고 알린다', async () => {
    const h = harness({ loadAccount: () => ({ ok: true, account: { ...ACCOUNT, user: 'radar' } }) });
    const out = await sendReplyFlow(h.deps, input());
    expect(h.composed[0].bcc).toEqual([]);
    expect(h.composed[0].from).toEqual({ name: '홍길동', address: 'radar' });
    expect(out.sent.bcc).toEqual([]);
    expect(out.warnings).toEqual(['메일 계정 아이디가 메일 주소가 아니라 나에게 숨은참조를 넣지 못했습니다']);
  });
});

// ---- 통합: 실제 MIME 조립 + 로컬 smtp-server + 실제 발송 기록 ------------------------------
// 루프백(127.0.0.1)의 가짜 서버에만 접속한다. VITEST 가드가 켜져 있어 실제 서버로는 나가지 못한다.

interface Received {
  from: string;
  to: string[];
  raw: Buffer;
}

const SMTP_USER = 'me@sender.example';
const SMTP_PASS = 'secret';

describe('sendReplyFlow — 실제 조립·SMTP 대화(로컬 smtp-server)', () => {
  let server: SMTPServer;
  let port = 0;
  const received: Received[] = [];
  const temps: string[] = [];

  beforeAll(async () => {
    server = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN'],
      logger: false,
      onAuth(auth, _session, cb) {
        if (auth.username === SMTP_USER && auth.password === SMTP_PASS) cb(null, { user: auth.username });
        else cb(new Error('Invalid username or password'));
      },
      onRcptTo(address, _session, cb) {
        if (address.address.startsWith('reject')) {
          cb(Object.assign(new Error('5.1.1 Mailbox unavailable'), { responseCode: 550 }));
        } else {
          cb();
        }
      },
      onData(stream, session, cb) {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const mailFrom = session.envelope.mailFrom;
          received.push({
            from: mailFrom ? mailFrom.address : '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks),
          });
          cb();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function realHarness(over: { pass?: string; bccSelf?: boolean } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-send-'));
    temps.push(dataDir);
    const log = new SentLog(dataDir);
    const account: SmtpAccount = {
      host: '127.0.0.1',
      port,
      secure: false,
      requireTLS: false,
      user: SMTP_USER,
      pass: over.pass ?? SMTP_PASS,
    };
    const h = harness({
      loadAccount: () => ({ ok: true, account }),
      settings: () => ({ ...SETTINGS, bccSelf: over.bccSelf ?? true }),
      sentLog: () => log,
      compose: composeMessage,
      // 시험 가드를 켠 채로 보낸다(루프백만 허용)
      send: (a, msg) => sendRawMessage(a, msg, { VITEST: 'true' }),
    });
    return { ...h, dataDir, log };
  }

  it('보낸다 → 발송 기록(.eml 포함) → 저장: 서버가 받은 봉투·머리말·본문', async () => {
    received.length = 0;
    const h = realHarness();
    const one = input({ cc: ['박과장 <park@hangyeol.test>'], quoteOriginal: true });
    const out = await sendReplyFlow(h.deps, one);

    expect(received).toHaveLength(1);
    const got = received[0];
    expect(got.from).toBe(SMTP_USER);
    expect([...got.to].sort()).toEqual(['kim@hangyeol.test', 'me@sender.example', 'park@hangyeol.test']);
    const text = got.raw.toString('utf8');
    expect(text).toMatch(/^In-Reply-To: <abc123@hangyeol\.test>\r$/m);
    expect(text).toMatch(/^References: <abc123@hangyeol\.test>\r$/m);
    expect(text).toMatch(/^Subject: =\?UTF-8\?/m); // 한글 제목은 인코딩된다
    expect(text).not.toMatch(/^Bcc:/im); // 숨은참조는 봉투에만
    expect(text).toContain(`Message-ID: ${out.sent.messageId}`);

    // 기록: 다시 열어도 있고, .eml 은 보낸 바이트와 같은 메시지다
    expect(new SentLog(h.dataDir).has(one.sendId)).toBe(true);
    expect(out.sent.eml).toMatch(/^sent\/\d{8}T\d{6}_test-sen\.eml$/);
    const eml = fs.readFileSync(path.join(h.dataDir, out.sent.eml!), 'utf8');
    expect(eml).toContain(`Message-ID: ${out.sent.messageId}`);
    expect(eml).not.toMatch(/^Bcc:/im);
    expect(out.sent.response).toMatch(/^250/);
    expect(out.warnings).toEqual([]);

    // 저장: 발송 줄이 메모에
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].input.note).toBe(
      '인벤토리 확인 완료\n메일 회신 발송 — 받는사람: 김담당 · 제목: RE: 통영공장 인벤토리 확인 요청 · 참조 1명',
    );
  });

  it('인증 실패면 사람 말로 던지고 기록·저장하지 않는다', async () => {
    received.length = 0;
    const h = realHarness({ pass: 'wrong' });
    const one = input();
    await expect(sendReplyFlow(h.deps, one)).rejects.toMatchObject({ kind: 'auth' });
    expect(received).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(new SentLog(h.dataDir).list()).toEqual([]);
  });

  it('서버가 받는사람을 550 으로 거부하면 실패 — 숨은참조를 끄면 발송 자체가 거부된다', async () => {
    received.length = 0;
    const h = realHarness({ bccSelf: false });
    await expect(sendReplyFlow(h.deps, input({ to: ['reject@hangyeol.test'] }))).rejects.toMatchObject({
      kind: 'rejected',
      message: expect.stringMatching(/550/),
    });
    expect(received).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.log.list()).toEqual([]);
  });

  it('받는사람이 거부되고 숨은참조(나)만 받았으면 실패로 본다 — 위키·기록 그대로', async () => {
    received.length = 0;
    const h = realHarness({ bccSelf: true });
    await expect(sendReplyFlow(h.deps, input({ to: ['reject@hangyeol.test'] }))).rejects.toThrow(/모두 거부했습니다/);
    expect(h.saved).toEqual([]);
    expect(h.log.list()).toEqual([]);
  });

  it('시험 가드: 루프백이 아닌 서버에는 접속하지 않는다', async () => {
    const h = realHarness();
    h.deps.send = (a, msg) => sendRawMessage({ ...a, host: 'smtps.mailhost.test', port: 465, secure: true }, msg, { VITEST: 'true' });
    await expect(sendReplyFlow(h.deps, input())).rejects.toMatchObject({ kind: 'guard' });
    expect(h.saved).toEqual([]);
  });
});

// ---- 보낸 회신 본문을 반영 대기열까지(보냈지만 저장 실패 뒤의 [저장]) ------------------------------

describe('createReplySaver — 보낸 회신 본문(reply)이 반영 대기열에서 빠지지 않는다', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** ipc.ts saveResult 흉내: 쓰기(실패 방식을 고를 수 있다) + 반영을 켰으면 실제 QueueStore 에 넣는다 */
  function world() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-replysaver-'));
    dirs.push(dir);
    const queue = new QueueStore(dir);
    const state = { fail: 'none' as 'none' | 'full' | 'partial', calls: [] as { input: SaveResultInput; extra: { reply?: string } }[] };
    const saver = createReplySaver((si, extra) => {
      state.calls.push({ input: si, extra });
      if (state.fail === 'full') throw new Error('위키에 저장하지 못했습니다: 내 할 일.md 잠김 — 아무것도 쓰지 않았음');
      const queued = si.reflect
        ? queue.add({ kind: 'task', taskId: si.taskId, title: TASK.title, status: si.status, note: si.note ?? '', ...(extra.reply ? { reply: extra.reply } : {}) })
        : undefined;
      if (state.fail === 'partial') throw new Error('위키에 일부만 저장했습니다: 할 일 메모.md 잠김');
      return { ...saveOutput(), ...(queued ? { queued } : {}) };
    });
    return { queue, state, saver, h: harness({ save: (si, extra) => saver.afterSend(si, extra) }) };
  }

  const BODY = '안녕하세요.\n8월분 사용량 반영을 확인했습니다.\n\n감사합니다.';

  it('완전 실패(대기열에 아무것도 없음) 뒤 같은 할 일을 [저장]하면 보낸 본문이 대기열 항목에 들어간다', async () => {
    const { queue, state, saver, h } = world();
    state.fail = 'full';
    const out = await sendReplyFlow(h.deps, input({ body: BODY, save: { taskId: TASK.id, status: 'done', note: '확인', reflect: true } }));
    expect(out.saveError).toMatch(/저장하지 못했습니다/);
    expect(queue.list()).toEqual([]);
    expect(saver.pendingFor(TASK.id)).toBe(BODY);

    // 화면: 같은 상태로 다시 [저장] — IPC 저장 입력에는 reply 가 없다
    state.fail = 'none';
    const again = saver.save({ taskId: TASK.id, status: 'done', note: `확인\n${sentLine(input().to, [], input().subject)}`, reflect: true });
    expect(again.queued?.reply).toBe(BODY);
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].reply).toBe(BODY);
    expect(state.calls.at(-1)?.extra).toEqual({ reply: BODY });
    expect(saver.pendingFor(TASK.id), '대기열에 넣었으면 잊는다').toBeUndefined();
  });

  it('부분 저장(대기열에는 reply 와 함께 들어감) 뒤 다시 [저장]해도 reply 가 지워지지 않는다', async () => {
    const { queue, state, saver, h } = world();
    state.fail = 'partial';
    const out = await sendReplyFlow(h.deps, input({ body: BODY, save: { taskId: TASK.id, status: 'done', reflect: true } }));
    expect(out.saveError).toMatch(/일부만 저장/);
    expect(queue.list()[0].reply).toBe(BODY);
    state.fail = 'none';
    saver.save({ taskId: TASK.id, status: 'done', note: '다시 저장', reflect: true });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ note: '다시 저장', reply: BODY });
  });

  it('진행 중으로 보내고(반영 켬) 나중에 완료로 [저장]해도 reply 가 남는다 — 대기열이 이어받는다', async () => {
    const { queue, saver, h } = world();
    const out = await sendReplyFlow(h.deps, input({ body: BODY, save: { taskId: TASK.id, status: 'wip', reflect: true } }));
    expect(out.save?.queued?.reply).toBe(BODY);
    expect(saver.pendingFor(TASK.id)).toBeUndefined();
    saver.save({ taskId: TASK.id, status: 'done', note: '완료', reflect: true });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ status: 'done', note: '완료', reply: BODY });
  });

  it('반영을 끄고 보냈다가 나중에 반영을 켜고 [저장]하면 그때 보낸 본문을 넣는다. 다른 할 일에는 넣지 않는다', async () => {
    const { queue, state, saver, h } = world();
    await sendReplyFlow(h.deps, input({ body: BODY, save: { taskId: TASK.id, status: 'wip', reflect: false } }));
    expect(queue.list()).toEqual([]);
    saver.save({ taskId: 'c:other', status: 'done', reflect: true });
    expect(state.calls.at(-1)?.extra).toEqual({});
    expect(queue.list().find((x) => x.taskId === 'c:other')?.reply).toBeUndefined();
    saver.save({ taskId: TASK.id, status: 'done', reflect: true });
    expect(queue.list().find((x) => x.taskId === TASK.id)?.reply).toBe(BODY);
  });
});

// ---- 2.10단계 §7-1 메일함 회신(할 일 없이, 위키에 쓰지 않는다) --------------------------------------------

describe('sendMailReplyFlow — 메일함 회신', () => {
  function mailInput(over: Partial<SendMailReplyInput> = {}): SendMailReplyInput {
    return {
      sendId: newSendId(),
      path: MAIL,
      to: ['김담당 <kim@hangyeol.test>'],
      cc: [],
      subject: 'RE: 통영공장 인벤토리 확인 요청',
      body: '안녕하세요.\n확인했습니다.\n',
      quoteOriginal: true,
      archiveAfter: true,
      ...over,
    };
  }
  function mailHarness(over: Partial<SendMailReplyDeps> = {}) {
    const h = harness();
    const after: { mail: string; archive: boolean }[] = [];
    const { findTask: _f, save: _s, ...base } = h.deps;
    const deps: SendMailReplyDeps = {
      ...base,
      afterSend: (mail, archive) => {
        after.push({ mail, archive });
      },
      ...over,
    };
    return { ...h, deps, after };
  }

  it('보내고 기록(taskId·taskTitle 빈 글자 + origin mailbox) — 저장은 부르지 않는다', async () => {
    const h = mailHarness();
    const inp = mailInput();
    const out = await sendMailReplyFlow(h.deps, inp);
    expect(h.sent).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
    expect(out.sent).toMatchObject({ id: inp.sendId, taskId: '', taskTitle: '', mail: MAIL, origin: 'mailbox' });
    expect(h.log.records[0].origin).toBe('mailbox');
    expect(h.composed[0].inReplyTo).toBe(SOURCE.messageId);
    expect(h.composed[0].text).toContain('-----Original Message-----');
    expect(h.after).toEqual([{ mail: MAIL, archive: true }]);
    expect(out.warnings).toEqual([]);
  });

  it('보낸 뒤 상태 바꾸기 실패는 경고(메일은 보낸 것)', async () => {
    const h = mailHarness({
      afterSend: () => {
        throw new Error('잠김');
      },
    });
    const out = await sendMailReplyFlow(h.deps, mailInput());
    expect(h.sent).toHaveLength(1);
    expect(out.warnings.join()).toContain('메일 상태(회신 필요·처리함)를 바꾸지 못했습니다: 잠김');
  });

  it('같은 sendId 는 두 번 보내지 않는다 · 원본 없음·계정 없음·[확인 필요 는 보내기 전에 거부', async () => {
    const h = mailHarness();
    const inp = mailInput();
    await sendMailReplyFlow(h.deps, inp);
    await expect(sendMailReplyFlow(h.deps, inp)).rejects.toThrow('이미 보낸 메일');
    await expect(sendMailReplyFlow(h.deps, mailInput({ path: 'raw/mail/없음/2026/x.md' }))).rejects.toThrow('원본 메일을 찾지 못했습니다');
    const noAccount = mailHarness({ loadAccount: () => ({ ok: false, problem: '메일 계정이 없습니다' }) });
    await expect(sendMailReplyFlow(noAccount.deps, mailInput())).rejects.toThrow('메일 계정이 없습니다');
    await expect(sendMailReplyFlow(h.deps, mailInput({ body: '[확인 필요: 일정]' }))).rejects.toThrow();
    expect(h.sent).toHaveLength(1);
    expect(noAccount.after).toHaveLength(0);
  });
});

describe('SentLog — 메일함 기록(taskId 빈 글자 + origin)', () => {
  it('저장·다시 읽기·lastFor(할 일 + 같은 메일 경로)·lastForMail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-sentlog-'));
    try {
      const log = new SentLog(dir);
      const base = { to: ['a@x.example'], cc: [], bcc: [], subject: 'RE: x', messageId: '<m@x>' };
      log.add({ ...base, id: 'task-send-0001', at: '2026-09-20T00:00:00Z', taskId: TASK.id, taskTitle: TASK.title, mail: MAIL }, Buffer.from('a'));
      log.add({ ...base, id: 'mbox-send-0001', at: '2026-09-22T00:00:00Z', taskId: '', taskTitle: '', mail: MAIL, origin: 'mailbox' }, Buffer.from('b'));
      // 빈 taskId 는 origin 이 mailbox 일 때만
      expect(() => log.add({ ...base, id: 'bad-send-0001', at: '2026-09-22T00:00:00Z', taskId: '', taskTitle: '', mail: MAIL }, Buffer.from('c'))).toThrow();
      const reread = new SentLog(dir);
      expect(reread.list().map((r) => [r.id, r.origin])).toEqual([
        ['mbox-send-0001', 'mailbox'],
        ['task-send-0001', undefined],
      ]);
      expect(reread.lastForTask(TASK.id)?.id).toBe('task-send-0001');
      expect(reread.lastForTask('')).toBeUndefined();
      expect(reread.lastFor(TASK.id, [MAIL])?.id).toBe('mbox-send-0001');
      expect(reread.lastFor(TASK.id, [])?.id).toBe('task-send-0001');
      expect(reread.lastForMail([MAIL])?.id).toBe('mbox-send-0001');
      expect(reread.lastForMail(['raw/mail/a/2026/z.md'])).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
