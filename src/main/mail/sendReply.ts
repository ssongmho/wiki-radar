// 보내고 저장 — 회신 메일을 보내고, 발송 기록을 남기고, 처리 결과를 2단계 저장으로 쓴다.
// electron 을 import 하지 않는 순수 모듈이다(발송·저장 함수는 주입받는다). 계약: docs/stage2.5-contract.md §4
//
// 저장 입력 검사(requireSaveInput)도 여기 둔다 — ipc.ts 의 처리 결과 저장과 보내고 저장이 같은 규칙을 쓴다.
import type {
  MailSettings,
  SaveResultInput,
  SaveResultOutput,
  SendMailReplyInput,
  SendMailReplyOutput,
  SendReplyInput,
  SendReplyOutput,
  SentMailRecord,
  Task,
  TaskStatus,
} from '../../shared/types';
import { REPLY_LIMITS, addressOf, assembleReplyBody, replyProblem, sentLine } from '../../shared/reply';
import { MAX_NOTE_LENGTH, MAX_OWNER_LENGTH, MAX_TASK_ID_LENGTH } from '../config';
import { SECRET_IN_MAIL_PROBLEM, containsSecret, type AccountResult, type SmtpAccount } from './account';
import type { ComposeInput, ComposedMessage } from './compose';
import { formatQuote, type ReplySource } from './replyContext';
import type { SmtpSendResult } from './smtp';
import type { SentLog } from './stores';

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// IPC 인자 검사 — 처리 결과 저장(ipc.ts)과 함께 쓴다. docs/stage2-contract.md §9-3

/** 1~maxLength 자 문자열, 제어 문자 없음(경로·ID 용). */
export function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`잘못된 요청입니다: ${name} 값이 문자열이 아닙니다`);
  if (value.length === 0 || value.length > maxLength) {
    throw new Error(`잘못된 요청입니다: ${name} 길이는 1~${maxLength}자여야 합니다`);
  }
  // 제어 문자(NUL·줄바꿈 등)는 경로·ID 어디에도 들어갈 일이 없다.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`잘못된 요청입니다: ${name}에 제어 문자가 있습니다`);
  return value;
}

const TASK_STATUSES: readonly TaskStatus[] = ['open', 'wip', 'done', 'notmine'];

function requireStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) return value as TaskStatus;
  throw new Error('잘못된 요청입니다: status 는 open·wip·done·notmine 중 하나여야 합니다');
}

/** 담당자(한 줄). 없거나 공백뿐이면 undefined — sync_todo 처럼 '타담당'으로 쓰인다. */
function optionalOwner(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('잘못된 요청입니다: owner 값이 문자열이 아닙니다');
  if (value.length > MAX_OWNER_LENGTH) throw new Error(`담당자는 ${MAX_OWNER_LENGTH}자까지 쓸 수 있습니다`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('담당자에는 줄바꿈·제어 문자를 쓸 수 없습니다');
  // 줄 끝의 [owner:: 값] 필드와 로그의 '담당 **값**'에 그대로 들어간다. 대괄호는 필드를 깨뜨린다.
  if (/[[\]]/.test(value)) throw new Error('담당자에는 대괄호([ ])를 쓸 수 없습니다');
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 처리 내용(여러 줄). 줄바꿈은 \n 으로 맞춘다. 없거나 공백뿐이면 undefined — 메모를 쓰지 않는다. */
function optionalNote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('잘못된 요청입니다: note 값이 문자열이 아닙니다');
  if (value.length > MAX_NOTE_LENGTH) throw new Error(`처리 내용은 ${MAX_NOTE_LENGTH}자까지 쓸 수 있습니다`);
  const note = value.replace(/\r\n?/g, '\n');
  // 줄바꿈·탭 말고 제어 문자(NUL 등)는 마크다운 파일에 들어갈 일이 없다.
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(note)) throw new Error('처리 내용에 쓸 수 없는 제어 문자가 있습니다');
  return note.trim() === '' ? undefined : note;
}

/** 처리 결과 저장 입력(2단계). 담당자·처리 내용 규칙은 docs/stage2-contract.md §9-3 */
export function requireSaveInput(value: unknown): SaveResultInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('잘못된 요청입니다: 저장 입력이 객체가 아닙니다');
  }
  const v = value as Record<string, unknown>;
  const taskId = requireString(v.taskId, 'taskId', MAX_TASK_ID_LENGTH);
  const status = requireStatus(v.status);
  const owner = optionalOwner(v.owner);
  const note = optionalNote(v.note);
  if (typeof v.reflect !== 'boolean') throw new Error('잘못된 요청입니다: reflect 값이 참·거짓이 아닙니다');
  const input: SaveResultInput = { taskId, status, reflect: v.reflect };
  if (owner !== undefined) input.owner = owner;
  if (note !== undefined) input.note = note;
  return input;
}

/** 주소 한 칸의 최대 길이(RFC 5321 경로 한도 256 + 이름 여유) */
export const MAX_ADDRESS_ITEM_LENGTH = 320;
export const SEND_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function requireAddressList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`잘못된 요청입니다: ${name} 값이 목록이 아닙니다`);
  if (value.length > REPLY_LIMITS.recipients) {
    throw new Error(`받는사람·참조는 합쳐 ${REPLY_LIMITS.recipients}명까지 보낼 수 있습니다`);
  }
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`잘못된 요청입니다: ${name}에 문자열이 아닌 값이 있습니다`);
    if (item.length > MAX_ADDRESS_ITEM_LENGTH) {
      throw new Error(`잘못된 요청입니다: ${name}의 주소 한 칸은 ${MAX_ADDRESS_ITEM_LENGTH}자까지입니다`);
    }
    return item;
  });
}

/**
 * sendReply IPC 인자 검사 — 형·길이와 save.taskId 일치만 본다. 주소 형식·제목·본문 규칙(명세 §2)은
 * sendReplyFlow 가 replyProblem 으로 본다. 본문 줄바꿈은 LF 로 맞춘다. 틀리면 Error.
 */
export function validateSendInput(raw: unknown): SendReplyInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('잘못된 요청입니다: 회신 입력이 객체가 아닙니다');
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.sendId !== 'string' || !SEND_ID_RE.test(v.sendId)) {
    throw new Error('잘못된 요청입니다: sendId 는 8~64자의 영문·숫자·하이픈이어야 합니다');
  }
  const taskId = requireString(v.taskId, 'taskId', MAX_TASK_ID_LENGTH);
  const to = requireAddressList(v.to, 'to');
  const cc = requireAddressList(v.cc, 'cc');
  if (to.length + cc.length > REPLY_LIMITS.recipients) {
    throw new Error(`받는사람·참조는 합쳐 ${REPLY_LIMITS.recipients}명까지 보낼 수 있습니다`);
  }
  if (typeof v.subject !== 'string') throw new Error('잘못된 요청입니다: subject 값이 문자열이 아닙니다');
  if (typeof v.body !== 'string') throw new Error('잘못된 요청입니다: body 값이 문자열이 아닙니다');
  if (typeof v.quoteOriginal !== 'boolean') {
    throw new Error('잘못된 요청입니다: quoteOriginal 값이 참·거짓이 아닙니다');
  }
  const save = requireSaveInput(v.save);
  if (save.taskId !== taskId) throw new Error('잘못된 요청입니다: 저장할 할 일과 회신할 할 일이 다릅니다');
  return {
    sendId: v.sendId,
    taskId,
    to,
    cc,
    subject: v.subject,
    body: v.body.replace(/\r\n?/g, '\n'),
    quoteOriginal: v.quoteOriginal,
    save,
  };
}

// ---------------------------------------------------------------------------
// 보내고 저장

/** 반영 대기열 항목의 reply 길이(명세 §4-2 ⑦) */
export const QUEUE_REPLY_LIMIT = 4000;

export interface SendReplyDeps {
  findTask(taskId: string): Task | undefined;
  readSource(rel: string): ReplySource | null;
  loadAccount(): AccountResult;
  settings(): MailSettings;
  sentLog(): SentLog;
  compose(input: ComposeInput): Promise<ComposedMessage>;
  send(account: SmtpAccount, msg: ComposedMessage): Promise<SmtpSendResult>;
  /** 2단계 저장. extra.reply 는 반영 대기열 항목의 reply 필드. 실패하면 throw */
  save(input: SaveResultInput, extra: { reply: string }): SaveResultOutput;
  now(): Date;
  /** 이 앱이 아는 다른 비밀(설정 › 비밀번호·키 — 2.13단계 §A-5). 보낼 글에 섞였으면 보내지 않는다. 없으면 계정 비밀번호만 */
  knownSecrets?(): string[];
  /** 보낸 MIME 원문을 메일함(보관소 '보낸 편지함')에 남긴다 — 본문·첨부(2.15). 실패하면 throw(보낸 뒤라 경고만) */
  saveSentMail?(raw: Buffer): void;
}

/** 이번 실행 중 보낸 sendId — 발송 기록을 남기지 못했어도 다시 보내지 않게 */
const sentIds = new Set<string>();
/** 지금 보내는 중인 sendId — 같은 작성 칸의 요청이 겹쳐 와도 한 번만 보낸다 */
const sendingIds = new Set<string>();

/** 처리 내용에 붙는 발송 줄(명세 §4-2 ⑦) — renderer 도 같은 줄을 쓰므로 shared/reply.ts 에 있다 */
export { sentLine };

/** 앞에서 max 글자. 끝이 서로게이트 쌍의 앞 반쪽이면 뗀다 */
function headChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** 보내기에 필요한 것(할 일 회신·메일함 회신이 같이 쓴다) */
type DeliverDeps = Pick<SendReplyDeps, 'loadAccount' | 'settings' | 'sentLog' | 'compose' | 'send' | 'now' | 'knownSecrets' | 'saveSentMail'>;

/** 보낼 글(검사를 거친 것) */
interface DeliverInput {
  sendId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  quoteOriginal: boolean;
}

/** 발송 기록에 적을 원본·할 일 */
interface DeliverMeta {
  taskId: string;
  taskTitle: string;
  mail: string;
  origin?: 'mailbox';
}

/**
 * ①~② 본문·주소 검사와 같은 작성 칸 중복 검사를 하고, 보내는 동안 sendId 를 잡아 둔다. 실패하면 던진다(아무것도 하지 않음).
 */
async function withSendGuard<T>(deps: Pick<SendReplyDeps, 'sentLog'>, input: DeliverInput, run: () => Promise<T>): Promise<T> {
  // ① 본문·주소 검사(renderer 와 같은 규칙, main 이 최종 판정)
  const problem = replyProblem({ to: input.to, cc: input.cc, subject: input.subject, body: input.body });
  if (problem) throw new Error(problem);

  // ② 같은 작성 칸을 두 번 보내지 않는다
  if (sentIds.has(input.sendId)) throw new Error('이미 보낸 메일입니다(같은 작성 칸)');
  if (sendingIds.has(input.sendId)) throw new Error('이 메일을 보내는 중입니다(같은 작성 칸)');
  let alreadySent: boolean;
  try {
    alreadySent = deps.sentLog().has(input.sendId);
  } catch (err) {
    // 기록을 못 읽으면 두 번 보냈는지 알 수 없다 — 보내지 않는다
    throw new Error(`발송 기록을 읽지 못해 보내지 않았습니다: ${describeError(err)}`);
  }
  if (alreadySent) throw new Error('이미 보낸 메일입니다(같은 작성 칸)');

  sendingIds.add(input.sendId);
  try {
    return await run();
  } finally {
    sendingIds.delete(input.sendId);
  }
}

/** ④ 원본 메일(발송 때마다 새로 읽는다). 없으면 던진다 */
function requireSource(readSource: (rel: string) => ReplySource | null, mail: string): ReplySource {
  let source: ReplySource | null;
  try {
    source = readSource(mail);
  } catch (err) {
    throw new Error(`원본 메일을 읽지 못했습니다: ${describeError(err)}`);
  }
  if (!source) throw new Error(`원본 메일을 찾지 못했습니다: ${mail}`);
  return source;
}

/**
 * ④ 계정 → ⑤ 조립·발송 → ⑥ 발송 기록. 보내기 전 실패는 던지고, 보낸 뒤에는 던지지 않는다(기록 실패는 warnings).
 */
async function deliver(
  deps: DeliverDeps,
  input: DeliverInput,
  source: ReplySource,
  meta: DeliverMeta,
): Promise<{ sent: SentMailRecord; warnings: string[] }> {
  const accountResult = deps.loadAccount();
  if (!accountResult.ok) throw new Error(accountResult.problem);
  const account = accountResult.account;

  // ⑤ 조립 → 발송. 보내는 이름·서명·나에게 숨은참조는 설정에서(renderer 가 보내지 않는다)
  let settings: MailSettings;
  try {
    settings = deps.settings();
  } catch (err) {
    throw new Error(`보내는 사람·서명 설정을 읽지 못했습니다: ${describeError(err)}`);
  }
  const text = assembleReplyBody(input.body, settings.signature, input.quoteOriginal ? formatQuote(source) : null);
  const warnings: string[] = [];
  // 계정 아이디가 메일 주소가 아니면(로그인 이름만 쓰는 서버) 숨은참조로 넣을 주소가 없다 — 빼고 알린다
  const selfAddress = addressOf(account.user);
  const bcc = settings.bccSelf && selfAddress !== null ? [selfAddress] : [];
  if (settings.bccSelf && selfAddress === null) {
    warnings.push('메일 계정 아이디가 메일 주소가 아니라 나에게 숨은참조를 넣지 못했습니다');
  }
  const fromName = settings.fromName.trim();
  // 보낼 글에 계정 비밀번호가 섞였으면(초안에 끼어든 것 등) 보내지 않는다 — 밖으로 나가면 되돌릴 수 없다
  let others: string[] = [];
  try {
    others = deps.knownSecrets?.() ?? [];
  } catch {
    others = [];
  }
  if (containsSecret([account.pass, ...others], [text, input.subject, fromName])) throw new Error(SECRET_IN_MAIL_PROBLEM);
  const composeInput: ComposeInput = {
    from: fromName ? { name: fromName, address: account.user } : { address: account.user },
    to: [...input.to],
    cc: [...input.cc],
    bcc,
    subject: input.subject,
    text,
    ...(source.messageId ? { inReplyTo: source.messageId, references: source.messageId } : {}),
  };
  let msg: ComposedMessage;
  try {
    msg = await deps.compose(composeInput);
  } catch (err) {
    throw new Error(`메일을 만들지 못했습니다: ${describeError(err)}`);
  }
  // 실패는 그대로 던진다(SmtpSendError 의 문장이 사람 말이다). 위키·기록은 그대로다.
  const result = await deps.send(account, msg);
  // 받는사람·참조가 모두 거부되고 숨은참조(나)만 받았으면 회신은 나가지 않은 것이다 — 실패로 본다
  const rejected = new Set(result.rejected.map((a) => a.toLowerCase()));
  const visible = [...input.to, ...input.cc].map((item) => (addressOf(item) ?? item).toLowerCase());
  if (rejected.size > 0 && visible.every((a) => rejected.has(a))) {
    throw new Error(`메일 서버가 받는사람·참조를 모두 거부했습니다: ${result.rejected.join(', ')}`);
  }

  // ⑥ 보냈다 — 이제부터는 던지지 않는다
  sentIds.add(input.sendId);
  if (result.rejected.length > 0) {
    warnings.push(`메일 서버가 받지 않은 주소가 있습니다: ${result.rejected.join(', ')}`);
  }
  const record: Omit<SentMailRecord, 'eml'> = {
    id: input.sendId,
    at: deps.now().toISOString(),
    taskId: meta.taskId,
    taskTitle: meta.taskTitle,
    mail: meta.mail,
    to: [...input.to],
    cc: [...input.cc],
    bcc,
    subject: input.subject,
    messageId: msg.messageId,
    ...(result.response ? { response: result.response } : {}),
    ...(meta.origin ? { origin: meta.origin } : {}),
  };
  let sent: SentMailRecord;
  try {
    sent = deps.sentLog().add(record, msg.raw);
    // 기록은 남겼지만 .eml 사본을 못 썼다(SentLog 는 경고 로그만 남긴다) — 화면에도 알린다
    if (sent.eml === undefined) warnings.push('메일은 보냈지만 보낸 메일 사본(.eml)을 남기지 못했습니다');
  } catch (err) {
    sent = { ...record };
    warnings.push(`메일은 보냈지만 발송 기록을 남기지 못했습니다: ${describeError(err)}`);
  }
  // 보낸 메일도 메일함에 — 어떻게 처리했는지가 스레드에 남아 위키 반영(2.14)의 재료가 된다
  if (deps.saveSentMail) {
    try {
      deps.saveSentMail(msg.raw);
    } catch (err) {
      warnings.push(`메일은 보냈지만 보낸 메일을 메일함에 남기지 못했습니다: ${describeError(err)}`);
    }
  }
  return { sent, warnings };
}

/**
 * 명세 §4-2 ①~⑧. 발송 전 단계(검사·중복·할 일·원본·계정·조립·발송)가 실패하면 예외를 던지고 아무것도
 * 기록·저장하지 않는다. 보낸 뒤에는 던지지 않는다 — 발송 기록 실패는 warnings, 저장 실패는 saveError.
 */
export async function sendReplyFlow(deps: SendReplyDeps, input: SendReplyInput): Promise<SendReplyOutput> {
  return withSendGuard(deps, input, async () => {
    // ③ 할 일
    const task = deps.findTask(input.taskId);
    if (!task) {
      throw new Error('회신할 할 일을 목록에서 찾지 못했습니다(그사이 위키가 바뀌었을 수 있습니다). 목록을 확인한 뒤 다시 보내세요');
    }
    const mail = task.mail;
    if (!mail) throw new Error('메일에서 온 할 일이 아니라 회신을 보낼 수 없습니다');

    // ④ 원본 메일·계정 → ⑤ 발송 → ⑥ 기록
    const source = requireSource(deps.readSource, mail);
    const { sent, warnings } = await deliver(deps, input, source, { taskId: task.id, taskTitle: task.title, mail });

    // ⑦ 처리 결과 저장 — 처리 내용 뒤에 발송 줄을 붙인다
    const line = sentLine(input.to, input.cc, input.subject);
    const note = input.save.note !== undefined ? `${input.save.note.trimEnd()}\n${line}` : line;
    const output: SendReplyOutput = { sent, warnings };
    try {
      output.save = deps.save({ ...input.save, note }, { reply: headChars(input.body.trimEnd(), QUEUE_REPLY_LIMIT) });
    } catch (err) {
      // ⑧ 메일은 보냈다 — 예외 대신 문장으로 돌려준다(부분 저장이면 PARTIAL_SAVE_PREFIX 로 시작한다)
      output.saveError = describeError(err);
    }
    return output;
  });
}

// ---------------------------------------------------------------------------
// 메일함 회신(2.10단계 §7-1) — 할 일 없이, 위키에 쓰지 않는다

export interface SendMailReplyDeps extends DeliverDeps {
  readSource(rel: string): ReplySource | null;
  /**
   * 보낸 뒤(기록까지 끝난 뒤): 그 메일의 회신 필요를 지우고 archive 면 스레드를 처리함으로. 실패는 던진다 — warnings 로 바꾼다
   */
  afterSend(mail: string, archive: boolean): void;
}

/**
 * 메일함 회신 보내기. 검사·중복·원본·계정·MIME·SMTP·발송 기록은 sendReplyFlow 와 같고, 처리 결과 저장(위키 쓰기)은 하지 않는다.
 * 기록은 taskId·taskTitle '' + origin 'mailbox'. 보낸 뒤 상태 바꾸기 실패는 warnings(메일은 보낸 것이다).
 */
export async function sendMailReplyFlow(deps: SendMailReplyDeps, input: SendMailReplyInput): Promise<SendMailReplyOutput> {
  return withSendGuard(deps, input, async () => {
    const source = requireSource(deps.readSource, input.path);
    const { sent, warnings } = await deliver(deps, input, source, { taskId: '', taskTitle: '', mail: input.path, origin: 'mailbox' });
    try {
      deps.afterSend(input.path, input.archiveAfter);
    } catch (err) {
      warnings.push(`메일은 보냈지만 메일 상태(회신 필요·처리함)를 바꾸지 못했습니다: ${describeError(err)}`);
    }
    return { sent, warnings };
  });
}

// ---------------------------------------------------------------------------
// 보낸 회신 본문을 반영 대기열까지 잇기

/** 2단계 저장(ipc.ts saveResult). extra.reply 가 있으면 반영 대기열 항목의 reply 로 넣는다. 실패하면 throw */
export type SaveWithReply = (input: SaveResultInput, extra: { reply?: string }) => SaveResultOutput;

export interface ReplySaver {
  /** 보내고 저장의 저장 — SendReplyDeps.save 로 쓴다 */
  afterSend(input: SaveResultInput, extra: { reply: string }): SaveResultOutput;
  /** 처리 결과 저장([저장]). 보냈지만 대기열에 넣지 못한 회신 본문이 이 할 일에 있으면 함께 넘긴다 */
  save(input: SaveResultInput): SaveResultOutput;
  /** 이 할 일에 대해 아직 대기열에 넣지 못한 회신 본문(시험·로그용) */
  pendingFor(taskId: string): string | undefined;
}

/** 기억해 두는 할 일 수(오래된 것부터 버린다) */
const PENDING_REPLY_LIMIT = 50;

/**
 * 보낸 회신 본문(reply)이 반영 대기열 항목에 들어갈 때까지 할 일별로 기억한다(이번 실행 동안, 메모리에만).
 * 보냈지만 저장이 실패했거나(완전 실패면 대기열에 아무것도 들어가지 않는다) 반영을 끄고 저장했으면 기억해 두었다가,
 * 같은 할 일을 [저장]할 때 넘긴다 — IPC 저장 입력에는 reply 가 없으므로 이것이 없으면 고객에게 나간 본문이
 * [위키에 반영] 프롬프트에서 빠진다(명세 §4-2 ⑦). 대기열에 들어가면(output.queued) 잊는다.
 * 대기열에 이미 들어간 reply 는 QueueStore.add 가 같은 할 일을 바꿀 때 이어받는다.
 */
export function createReplySaver(save: SaveWithReply): ReplySaver {
  const pending = new Map<string, string>();
  const remember = (taskId: string, reply: string): void => {
    pending.delete(taskId);
    pending.set(taskId, reply);
    while (pending.size > PENDING_REPLY_LIMIT) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
  };
  const run = (input: SaveResultInput, reply: string | undefined): SaveResultOutput => {
    let output: SaveResultOutput;
    try {
      output = save(input, reply !== undefined ? { reply } : {});
    } catch (err) {
      if (reply !== undefined) remember(input.taskId, reply);
      throw err;
    }
    if (reply !== undefined) {
      if (output.queued) pending.delete(input.taskId);
      else remember(input.taskId, reply);
    }
    return output;
  };
  return {
    afterSend: (input, extra) => run(input, typeof extra?.reply === 'string' && extra.reply.trim() !== '' ? extra.reply : undefined),
    save: (input) => run(input, pending.get(input.taskId)),
    pendingFor: (taskId) => pending.get(taskId),
  };
}
