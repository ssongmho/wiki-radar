// 메일함 IPC 인자 검사(docs/stage2.10-contract.md §11). electron 을 import 하지 않는 순수 모듈 — ipc.ts 가 쓰고 vitest 로 시험한다.
// 여기서는 모양(타입·길이·형식)만 본다. 메일 경로의 실제 경로 검사(링크·정션)는 파일을 읽는 쪽(readMailText)이 한다.
import type {
  CreateMailTaskInput,
  MailFilter,
  MailKey,
  MailReplyDraftInput,
  MailStateChange,
  MailThreadQuery,
  MailVocCreateInput,
  QueueMailInput,
  SendMailReplyInput,
  SetMailStateInput,
} from '../../shared/types';
import { MAIL_KEY_RE, MAIL_THREAD_ID_RE } from '../../shared/mailThread';
import { REPLY_LIMITS } from '../../shared/reply';
import { MAX_REL_PATH_LENGTH } from '../config';
import { requireVocCreateInput } from '../voc/ipcInput';
import { isValidYmd } from '../wiki/calendar';
import { isUnderMailAttachments, normalizeMailPath } from '../wiki/mail';
import { SEND_ID_RE, requireAddressList } from './sendReply';

export const MAIL_FILTERS: readonly MailFilter[] = ['all', 'unread', 'replyNeeded', 'archived'];
export const MAIL_FOLDER_MAX = 80;
export const MAIL_QUERY_MAX = 200;
/** 목록 질의 keep(필터에 안 맞아도 남길 스레드) 최대 수 */
export const MAIL_KEEP_MAX = 5;
export const MAIL_OFFSET_MAX = 100_000;
export const MAIL_LIMIT_MAX = 200;
export const MAIL_STATE_KEYS_MAX = 500;
export const MAIL_ATTACHMENT_INDEX_MAX = 199;
/** 메일함 회신 「이번에 전할 핵심」 */
export const MAIL_NOTE_MAX = 4_000;
export const MAIL_HINT_MAX = 500;
/** [할 일로] 제목 */
export const MAIL_TASK_TITLE_MAX = 200;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_LINES_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** 메일 경로: 1024자 이하 → normalizeMailPath(raw/mail 안 .md, `..`·절대경로 없음) · raw/mail/_attachments 아래 아님 */
export function requireMailPath(value: unknown, name = 'path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REL_PATH_LENGTH) {
    throw new Error(`잘못된 요청입니다: ${name} 는 1~${MAX_REL_PATH_LENGTH}자 메일 경로여야 합니다`);
  }
  const rel = normalizeMailPath(value);
  if (rel === null) throw new Error(`잘못된 요청입니다: ${name} 는 raw/mail 안의 .md 여야 합니다`);
  if (isUnderMailAttachments(rel)) throw new Error(`잘못된 요청입니다: ${name} 가 첨부 폴더 안입니다`);
  return rel;
}

export function requireMailKey(value: unknown): MailKey {
  if (typeof value === 'string' && MAIL_KEY_RE.test(value)) return value;
  throw new Error('잘못된 요청입니다: 메일 키 형식이 아닙니다');
}

export function requireMailThreadId(value: unknown): string {
  if (typeof value === 'string' && MAIL_THREAD_ID_RE.test(value)) return value;
  throw new Error('잘못된 요청입니다: 스레드 id 형식이 아닙니다');
}

/** 목록 질의(§11) */
export function requireMailThreadQuery(raw: unknown): MailThreadQuery {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 목록 질의가 객체가 아닙니다');
  if (typeof raw.filter !== 'string' || !(MAIL_FILTERS as readonly string[]).includes(raw.filter)) {
    throw new Error('잘못된 요청입니다: filter 는 all·unread·replyNeeded·archived 중 하나여야 합니다');
  }
  if (!isInt(raw.offset, 0, MAIL_OFFSET_MAX)) throw new Error(`잘못된 요청입니다: offset 은 0~${MAIL_OFFSET_MAX} 정수여야 합니다`);
  if (!isInt(raw.limit, 1, MAIL_LIMIT_MAX)) throw new Error(`잘못된 요청입니다: limit 은 1~${MAIL_LIMIT_MAX} 정수여야 합니다`);
  const q: MailThreadQuery = { filter: raw.filter as MailFilter, offset: raw.offset, limit: raw.limit };
  if (raw.folder !== undefined && raw.folder !== null) {
    if (typeof raw.folder !== 'string' || raw.folder.length === 0 || raw.folder.length > MAIL_FOLDER_MAX || CONTROL_RE.test(raw.folder)) {
      throw new Error(`잘못된 요청입니다: folder 는 1~${MAIL_FOLDER_MAX}자, 제어 문자 없음`);
    }
    q.folder = raw.folder;
  }
  if (raw.query !== undefined && raw.query !== null) {
    if (typeof raw.query !== 'string' || raw.query.length > MAIL_QUERY_MAX) {
      throw new Error(`잘못된 요청입니다: query 는 ${MAIL_QUERY_MAX}자까지입니다`);
    }
    if (CONTROL_EXCEPT_LINES_RE.test(raw.query)) throw new Error('잘못된 요청입니다: query 에 제어 문자가 있습니다');
    if (raw.query.trim() !== '') q.query = raw.query;
  }
  if (raw.includeMuted !== undefined) {
    if (typeof raw.includeMuted !== 'boolean') throw new Error('잘못된 요청입니다: includeMuted 는 참·거짓이어야 합니다');
    q.includeMuted = raw.includeMuted;
  }
  if (raw.keep !== undefined && raw.keep !== null) {
    if (!Array.isArray(raw.keep) || raw.keep.length > MAIL_KEEP_MAX) {
      throw new Error(`잘못된 요청입니다: keep 은 스레드 id ${MAIL_KEEP_MAX}개까지입니다`);
    }
    if (raw.keep.length > 0) q.keep = raw.keep.map(requireMailThreadId);
  }
  return q;
}

/** 상태 바꾸기(§3-3): 키 1~500개, 바꿀 것 하나(불리언) */
export function requireSetMailStateInput(raw: unknown): SetMailStateInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 상태 입력이 객체가 아닙니다');
  if (!Array.isArray(raw.keys) || raw.keys.length === 0 || raw.keys.length > MAIL_STATE_KEYS_MAX) {
    throw new Error(`잘못된 요청입니다: keys 는 1~${MAIL_STATE_KEYS_MAX}개여야 합니다`);
  }
  const keys = raw.keys.map(requireMailKey);
  const c = raw.change;
  if (!isRecord(c)) throw new Error('잘못된 요청입니다: change 가 객체가 아닙니다');
  const names = Object.keys(c);
  if (names.length !== 1 || !['read', 'replyNeeded', 'archived'].includes(names[0])) {
    throw new Error('잘못된 요청입니다: change 는 read·replyNeeded·archived 중 하나만');
  }
  const value = c[names[0]];
  if (typeof value !== 'boolean') throw new Error('잘못된 요청입니다: change 값은 참·거짓이어야 합니다');
  const change = { [names[0]]: value } as MailStateChange;
  return { keys, change };
}

/** 첨부 보기(§6-3) */
export function requireRevealInput(raw: unknown): { path: string; index: number } {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 첨부 입력이 객체가 아닙니다');
  const p = requireMailPath(raw.path);
  if (!isInt(raw.index, 0, MAIL_ATTACHMENT_INDEX_MAX)) {
    throw new Error(`잘못된 요청입니다: index 는 0~${MAIL_ATTACHMENT_INDEX_MAX} 정수여야 합니다`);
  }
  return { path: p, index: raw.index };
}

/** 여러 줄 글(줄바꿈 LF 로), 줄바꿈·탭 밖 제어 문자 거부. 없으면 '' */
function optionalText(value: unknown, what: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`잘못된 요청입니다: ${what} 값이 문자열이 아닙니다`);
  if (value.length > max) throw new Error(`${what}은(는) ${max}자까지 쓸 수 있습니다`);
  const text = value.replace(/\r\n?/g, '\n');
  if (CONTROL_EXCEPT_LINES_RE.test(text)) throw new Error(`${what}에 쓸 수 없는 제어 문자가 있습니다`);
  return text;
}

/** 메일함 회신 초안(§7-1) */
export function requireMailDraftInput(raw: unknown): MailReplyDraftInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 초안 입력이 객체가 아닙니다');
  const input: MailReplyDraftInput = {
    path: requireMailPath(raw.path),
    note: optionalText(raw.note, '이번에 전할 핵심', MAIL_NOTE_MAX),
  };
  const hint = optionalText(raw.hint, '추가 요청', MAIL_HINT_MAX).trim();
  if (hint) input.hint = hint;
  return input;
}

/**
 * 메일함 회신 보내기(§7-1): 2.5 validateSendInput 의 sendId·주소 목록·제목·본문 형 규칙 + path + archiveAfter(taskId·save 없음).
 * 주소 형식·제목·본문 내용 규칙은 흐름이 replyProblem 으로 본다.
 */
export function requireSendMailReplyInput(raw: unknown): SendMailReplyInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 회신 입력이 객체가 아닙니다');
  if (typeof raw.sendId !== 'string' || !SEND_ID_RE.test(raw.sendId)) {
    throw new Error('잘못된 요청입니다: sendId 는 8~64자의 영문·숫자·하이픈이어야 합니다');
  }
  const p = requireMailPath(raw.path);
  const to = requireAddressList(raw.to, 'to');
  const cc = requireAddressList(raw.cc, 'cc');
  if (to.length + cc.length > REPLY_LIMITS.recipients) {
    throw new Error(`받는사람·참조는 합쳐 ${REPLY_LIMITS.recipients}명까지 보낼 수 있습니다`);
  }
  if (typeof raw.subject !== 'string') throw new Error('잘못된 요청입니다: subject 값이 문자열이 아닙니다');
  if (typeof raw.body !== 'string') throw new Error('잘못된 요청입니다: body 값이 문자열이 아닙니다');
  if (typeof raw.quoteOriginal !== 'boolean') throw new Error('잘못된 요청입니다: quoteOriginal 값이 참·거짓이 아닙니다');
  if (typeof raw.archiveAfter !== 'boolean') throw new Error('잘못된 요청입니다: archiveAfter 값이 참·거짓이 아닙니다');
  return {
    sendId: raw.sendId,
    path: p,
    to,
    cc,
    subject: raw.subject,
    body: raw.body.replace(/\r\n?/g, '\n'),
    quoteOriginal: raw.quoteOriginal,
    archiveAfter: raw.archiveAfter,
  };
}

/** 메일만 VOC 등록(§7-2): 2.6 requireVocCreateInput 규칙에서 taskId 대신 path */
export function requireMailVocCreateInput(raw: unknown): MailVocCreateInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: VOC 등록 입력이 객체가 아닙니다');
  const p = requireMailPath(raw.path);
  const { taskId: _ignored, ...rest } = requireVocCreateInput({ ...raw, taskId: 'mail' });
  return { ...rest, path: p };
}

/** [할 일로] 제목에 쓸 수 없는 글자: 대괄호(필드)·#(태그)·제어 문자(줄바꿈 포함) */
const BAD_TASK_TITLE_RE = /[[\]#\u0000-\u001f\u007f]|\u2028|\u2029/;

/** [할 일로](§7-3) */
export function requireCreateMailTaskInput(raw: unknown): CreateMailTaskInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 할 일 입력이 객체가 아닙니다');
  const p = requireMailPath(raw.path);
  if (typeof raw.title !== 'string') throw new Error('잘못된 요청입니다: 제목이 문자열이 아닙니다');
  const title = raw.title.trim();
  if (title === '') throw new Error('제목을 적어 주세요');
  if (Array.from(title).length > MAIL_TASK_TITLE_MAX) throw new Error(`제목은 ${MAIL_TASK_TITLE_MAX}자까지입니다`);
  if (BAD_TASK_TITLE_RE.test(title)) throw new Error('제목에는 대괄호([ ])·#·줄바꿈을 쓸 수 없습니다');
  const input: CreateMailTaskInput = { path: p, title };
  if (raw.pri !== undefined && raw.pri !== null) {
    if (!isInt(raw.pri, 1, 3)) throw new Error('잘못된 요청입니다: 우선순위는 1~3 이어야 합니다');
    input.pri = raw.pri;
  }
  if (raw.due !== undefined && raw.due !== null && raw.due !== '') {
    if (!isValidYmd(raw.due)) throw new Error('기한은 달력에 있는 날짜(YYYY-MM-DD)여야 합니다');
    input.due = raw.due;
  }
  return input;
}

/** [위키에 반영](2.14단계 §6): 메모·힌트 한도 */
export const QUEUE_MAIL_NOTE_MAX = 4_000;
export const QUEUE_MAIL_HINT_MAX = 200;
const LINE_SEP_RE = new RegExp('[\\u2028\\u2029]');
const QUEUE_MAIL_FIELDS: ReadonlySet<string> = new Set(['key', 'scope', 'note', 'hint', 'replace']);

/**
 * [위키에 반영](2.14단계 §6): {key, scope, note, hint?, replace?} — 모르는 필드(path 포함)는 거부한다.
 * 경로는 받지 않는다 — main 이 키로 찾는다.
 */
export function requireQueueMailInput(raw: unknown): QueueMailInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 위키 반영 입력이 객체가 아닙니다');
  for (const name of Object.keys(raw)) {
    if (!QUEUE_MAIL_FIELDS.has(name)) throw new Error(`잘못된 요청입니다: 모르는 필드 ${name.slice(0, 40)}`);
  }
  const key = requireMailKey(raw.key);
  if (raw.scope !== 'mail' && raw.scope !== 'thread') throw new Error('잘못된 요청입니다: scope 는 mail·thread 중 하나여야 합니다');
  if (typeof raw.note !== 'string') throw new Error('잘못된 요청입니다: note 값이 문자열이 아닙니다');
  const note = optionalText(raw.note, '남길 것', QUEUE_MAIL_NOTE_MAX);
  const input: QueueMailInput = { key, scope: raw.scope, note };
  if (raw.hint !== undefined && raw.hint !== null) {
    if (typeof raw.hint !== 'string') throw new Error('잘못된 요청입니다: hint 값이 문자열이 아닙니다');
    if (raw.hint.length > QUEUE_MAIL_HINT_MAX) throw new Error(`업체·주제는 ${QUEUE_MAIL_HINT_MAX}자까지 쓸 수 있습니다`);
    if (CONTROL_RE.test(raw.hint) || LINE_SEP_RE.test(raw.hint)) throw new Error('업체·주제에는 줄바꿈·제어 문자를 쓸 수 없습니다');
    if (raw.hint.trim() !== '') input.hint = raw.hint.trim();
  }
  if (raw.replace !== undefined && raw.replace !== null) {
    if (typeof raw.replace !== 'boolean') throw new Error('잘못된 요청입니다: replace 는 참·거짓이어야 합니다');
    if (raw.replace) input.replace = true;
  }
  return input;
}
