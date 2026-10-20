// VOC IPC 인자 검사(2.6단계 명세 §3·§4·§6). electron 을 import 하지 않는 순수 모듈 — ipc.ts 가 쓰고 vitest 로 시험한다.
// 여기서는 모양(타입·길이·ID 형식·제어 문자)만 본다. 동작별 값의 뜻·CP949 검사·중복 actionId 는 VocService 가 한다.
import type {
  VocActionExpected,
  VocActionInput,
  VocActionKind,
  VocCreateInput,
  VocFileInput,
  VocFileOpenInput,
  VocLoginInput,
  VocWorkInput,
  VocWorkKind,
} from '../../shared/types';
import { VOC_EMAIL_RECIPIENTS_MAX, VOC_PASSWORD_MAX, VOC_WORKLOG_NOTE_MAX } from '../../shared/voc';
import { MAX_TASK_ID_LENGTH } from '../config';
import { requireString } from '../mail/sendReply';

/** actionId·createId: 화면이 만드는 UUID(영문·숫자·하이픈 8~64자) */
export const VOC_OP_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** 답변 내용 한도(명세 §5) */
export const VOC_REPLY_MAX = 5_000;
/** 등록 제목 한도(명세 §6) */
export const VOC_TITLE_MAX = 500;
/** 등록 내용 한도(명세 §6) */
export const VOC_DESCRIPTION_MAX = 10_000;
/** checkVocText 로 볼 수 있는 글 한도(등록 내용과 같다) */
export const VOC_CHECK_TEXT_MAX = VOC_DESCRIPTION_MAX;
/** 답변 밖 동작 값(user id·날짜·P1·상태)의 길이 한도 */
export const VOC_SHORT_VALUE_MAX = 32;
/**
 * 시스템·요청유형 코드(SYS0048·inquiry 등). 영문·숫자로 시작한다 — '-' 로 시작하는 값이 voc-cli 옵션으로
 * 읽히지 않게.
 */
export const VOC_CODE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const VOC_PRIORITIES: readonly string[] = ['P1', 'P2', 'P3'];
export const VOC_ACTION_KINDS: readonly VocActionKind[] = ['assign', 'ictDue', 'priority', 'status', 'reply'];

/** 줄바꿈·탭 밖의 제어 문자 */
const CONTROL_EXCEPT_LINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/** 모든 제어 문자(한 줄 값) */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 티켓·사용자·고객사 id: 양의 정수(숫자 값만 — 문자열 숫자는 받지 않는다) */
export function requireVocId(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`잘못된 요청입니다: ${name} 는 양의 정수여야 합니다`);
  }
  return value;
}

/** actionId·createId */
export function requireOpId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !VOC_OP_ID_RE.test(value)) {
    throw new Error(`잘못된 요청입니다: ${name} 는 영문·숫자·하이픈 8~64자여야 합니다`);
  }
  return value;
}

/**
 * voc-cli 로 보낼 글. multiline 이면 줄바꿈을 \n 으로 맞추고 줄바꿈·탭은 받는다. 한 줄이면 제어 문자를 모두 거부한다.
 * 길이는 0~max(빈 글을 막는 것은 부르는 쪽)
 */
export function requireVocText(value: unknown, what: string, max: number, multiline: boolean): string {
  if (typeof value !== 'string') throw new Error(`잘못된 요청입니다: ${what} 값이 문자열이 아닙니다`);
  const text = multiline ? value.replace(/\r\n?/g, '\n') : value;
  if (text.length > max) throw new Error(`${what}은(는) ${max}자까지 쓸 수 있습니다`);
  if ((multiline ? CONTROL_EXCEPT_LINE_RE : CONTROL_RE).test(text)) {
    throw new Error(`${what}에 쓸 수 없는 제어 문자가 있습니다`);
  }
  return text;
}

/** VOC 상태 이름(new·in_progress …) */
const VOC_STATUS_RE = /^[a-z][a-z_]{0,31}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * vocAction 의 expected(확인 대화상자가 보인 지금 값 — 쓰기 직전에 VOC 에서 다시 읽은 값과 비교한다). 없으면(undefined·null) undefined.
 * 키마다 모양이 틀리면 던진다. 모르는 키는 버린다
 */
export function parseVocExpected(raw: unknown): VocActionExpected | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: expected 가 객체가 아닙니다');
  const out: VocActionExpected = {};
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || !VOC_STATUS_RE.test(raw.status)) throw new Error('잘못된 요청입니다: expected.status 형식이 아닙니다');
    out.status = raw.status;
  }
  if (raw.assigneeId !== undefined) {
    out.assigneeId = raw.assigneeId === null ? null : requireVocId(raw.assigneeId, 'expected.assigneeId');
  }
  if (raw.priority !== undefined) {
    if (raw.priority !== null && (typeof raw.priority !== 'string' || raw.priority.length > VOC_SHORT_VALUE_MAX || CONTROL_RE.test(raw.priority))) {
      throw new Error('잘못된 요청입니다: expected.priority 형식이 아닙니다');
    }
    out.priority = raw.priority;
  }
  if (raw.ictDue !== undefined) {
    if (raw.ictDue !== null && (typeof raw.ictDue !== 'string' || !YMD_RE.test(raw.ictDue))) {
      throw new Error('잘못된 요청입니다: expected.ictDue 는 YYYY-MM-DD 여야 합니다');
    }
    out.ictDue = raw.ictDue;
  }
  return out;
}

/** vocAction 입력(명세 §4·§5). 값의 뜻(날짜·user id·상태 이름)은 VocService 가 다시 본다 */
export function requireVocActionInput(raw: unknown): VocActionInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: VOC 처리 입력이 객체가 아닙니다');
  const actionId = requireOpId(raw.actionId, 'actionId');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(VOC_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`잘못된 요청입니다: kind 는 ${VOC_ACTION_KINDS.join('·')} 중 하나여야 합니다`);
  }
  const ticketId = requireVocId(raw.ticketId, 'ticketId');
  let value: string;
  if (kind === 'reply') {
    value = requireVocText(raw.value, '답변 내용', VOC_REPLY_MAX, true);
    if (value.trim() === '') throw new Error('답변 내용을 적어 주세요');
  } else {
    value = requireVocText(raw.value, '값', VOC_SHORT_VALUE_MAX, false).trim();
    // ICT 예상완료일만 빈 값(지우기)을 받는다
    if (value === '' && kind !== 'ictDue') throw new Error('잘못된 요청입니다: 값이 비어 있습니다');
  }
  const input: VocActionInput = { actionId, kind: kind as VocActionKind, ticketId, value };
  const expected = parseVocExpected(raw.expected);
  if (expected) input.expected = expected;
  return input;
}

/** createVocTicket 입력(명세 §6). CP949 검사·고객사/시스템이 실제로 있는지는 VocService 가 본다 */
export function requireVocCreateInput(raw: unknown): VocCreateInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: VOC 등록 입력이 객체가 아닙니다');
  const createId = requireOpId(raw.createId, 'createId');
  const taskId = requireString(raw.taskId, 'taskId', MAX_TASK_ID_LENGTH);
  const title = requireVocText(raw.title, '제목', VOC_TITLE_MAX, false).trim();
  if (title === '') throw new Error('제목을 적어 주세요');
  const description = requireVocText(raw.description, '내용', VOC_DESCRIPTION_MAX, true);
  const customerId = requireVocId(raw.customerId, 'customerId');
  const system = requireCode(raw.system, '시스템');
  const requestType = requireCode(raw.requestType, '요청유형');
  const priority = raw.priority;
  if (typeof priority !== 'string' || !VOC_PRIORITIES.includes(priority)) {
    throw new Error('잘못된 요청입니다: 우선순위는 P1·P2·P3 중 하나여야 합니다');
  }
  const input: VocCreateInput = { createId, taskId, title, description, customerId, system, requestType, priority };
  if (raw.assigneeId !== undefined && raw.assigneeId !== null) input.assigneeId = requireVocId(raw.assigneeId, 'assigneeId');
  return input;
}

/** 로그인 아이디 길이 상한(명세 §13 — 글자 규칙은 VocService 가 vocLoginIdProblem 으로 본다) */
export const VOC_LOGIN_ID_MAX = 64;

/**
 * vocLogin 입력(명세 §13): 형·길이·줄바꿈만 본다(아이디 글자 규칙·비밀번호 규칙은 VocService 가 다시 본다).
 * 오류 문장에 입력 값을 넣지 않는다 — 이 문장은 main 로그(logFailureOnce)와 화면으로 나간다
 */
export function requireVocLoginInput(raw: unknown): VocLoginInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: VOC 로그인 입력이 객체가 아닙니다');
  const { loginId, password, remember } = raw;
  if (typeof loginId !== 'string') throw new Error('잘못된 요청입니다: 아이디 값이 문자열이 아닙니다');
  if (loginId.length === 0 || loginId.length > VOC_LOGIN_ID_MAX) {
    throw new Error(`잘못된 요청입니다: 아이디 길이는 1~${VOC_LOGIN_ID_MAX}자여야 합니다`);
  }
  if (CONTROL_RE.test(loginId)) throw new Error('잘못된 요청입니다: 아이디에 줄바꿈이나 제어 문자가 있습니다');
  if (typeof password !== 'string') throw new Error('잘못된 요청입니다: 비밀번호 값이 문자열이 아닙니다');
  // 코드 포인트 256자는 코드 단위로 512 안이다(정확한 글자 수는 VocService 가 센다)
  if (password.length === 0 || password.length > VOC_PASSWORD_MAX * 2) {
    throw new Error(`잘못된 요청입니다: 비밀번호 길이는 1~${VOC_PASSWORD_MAX}자여야 합니다`);
  }
  if (/[\r\n\u0000]/.test(password)) throw new Error('잘못된 요청입니다: 비밀번호에 줄바꿈이나 NUL 문자가 있습니다');
  if (typeof remember !== 'boolean') throw new Error('잘못된 요청입니다: remember 는 true·false 여야 합니다');
  return { loginId, password, remember };
}

/** V4 쓰기 종류(명세 §14) */
export const VOC_WORK_KINDS: readonly VocWorkKind[] = ['worklogAdd', 'worklogDelete', 'resolve', 'close', 'reopen', 'email'];
/** 메일 주소 한 개 길이 한도 */
const EMAIL_MAX = 254;
/** 메일에 담을 답변 수 한도 */
const REPLY_IDS_MAX = 200;

function requireAddressList(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`잘못된 요청입니다: ${what} 가 목록이 아닙니다`);
  if (value.length > max) throw new Error(`${what}은(는) ${max}명까지입니다`);
  return value.map((a) => {
    if (typeof a !== 'string' || a.length === 0 || a.length > EMAIL_MAX || CONTROL_RE.test(a)) {
      throw new Error(`잘못된 요청입니다: ${what} 주소 형식이 아닙니다`);
    }
    return a;
  });
}

/**
 * vocWork 입력(명세 §14) — 모양만 본다(주소 규칙·CP949·시간 단위·날짜 범위·담당·작업시간 선행조건은 VocService 가 다시 본다).
 * 종류에 쓰이지 않는 필드는 버린다
 */
export function requireVocWorkInput(raw: unknown): VocWorkInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: VOC 처리 입력이 객체가 아닙니다');
  const actionId = requireOpId(raw.actionId, 'actionId');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(VOC_WORK_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`잘못된 요청입니다: kind 는 ${VOC_WORK_KINDS.join('·')} 중 하나여야 합니다`);
  }
  const ticketId = requireVocId(raw.ticketId, 'ticketId');
  const input: VocWorkInput = { actionId, kind: kind as VocWorkKind, ticketId };
  if (raw.expectedStatus !== undefined && raw.expectedStatus !== null) {
    if (typeof raw.expectedStatus !== 'string' || !VOC_STATUS_RE.test(raw.expectedStatus)) {
      throw new Error('잘못된 요청입니다: expectedStatus 형식이 아닙니다');
    }
    input.expectedStatus = raw.expectedStatus;
  }
  const wantsWorklog = kind === 'worklogAdd' || kind === 'resolve' || kind === 'close';
  if (wantsWorklog && raw.worklog !== undefined && raw.worklog !== null) {
    if (!isRecord(raw.worklog)) throw new Error('잘못된 요청입니다: worklog 가 객체가 아닙니다');
    const { hours, date, note } = raw.worklog;
    if (typeof hours !== 'number' || !Number.isFinite(hours)) throw new Error('잘못된 요청입니다: 작업시간이 숫자가 아닙니다');
    if (typeof date !== 'string' || !YMD_RE.test(date)) throw new Error('잘못된 요청입니다: 작업일은 YYYY-MM-DD 여야 합니다');
    const text = requireVocText(note ?? '', '작업 메모', VOC_WORKLOG_NOTE_MAX * 2, false);
    input.worklog = { hours, date, note: text };
  }
  if (kind === 'worklogAdd' && !input.worklog) throw new Error('잘못된 요청입니다: 작업시간이 없습니다');
  if (kind === 'worklogDelete') input.workLogId = requireVocId(raw.workLogId, 'workLogId');
  if ((kind === 'email' || kind === 'resolve') && raw.email !== undefined && raw.email !== null) {
    if (!isRecord(raw.email)) throw new Error('잘못된 요청입니다: email 이 객체가 아닙니다');
    const to = requireAddressList(raw.email.to, '받는 사람', VOC_EMAIL_RECIPIENTS_MAX);
    const cc = requireAddressList(raw.email.cc ?? [], '참조', VOC_EMAIL_RECIPIENTS_MAX);
    const ids = raw.email.replyIds ?? [];
    if (!Array.isArray(ids) || ids.length > REPLY_IDS_MAX) throw new Error('잘못된 요청입니다: replyIds 형식이 아닙니다');
    input.email = { to, cc, replyIds: ids.map((id) => requireVocId(id, 'replyId')) };
  }
  if (kind === 'email' && !input.email) throw new Error('잘못된 요청입니다: 받는 사람이 없습니다');
  return input;
}

/** vocFile 입력(명세 §14) */
export function requireVocFileInput(raw: unknown): VocFileInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 첨부 입력이 객체가 아닙니다');
  const mode = raw.mode;
  if (mode !== 'preview' && mode !== 'download') throw new Error('잘못된 요청입니다: mode 는 preview·download 중 하나여야 합니다');
  return { ticketId: requireVocId(raw.ticketId, 'ticketId'), fileId: requireVocId(raw.fileId, 'fileId'), mode };
}

/** openVocFile 입력(명세 §14) — 경로는 받지 않는다(main 이 내려받은 기록에서 찾는다) */
export function requireVocFileOpenInput(raw: unknown): VocFileOpenInput {
  if (!isRecord(raw)) throw new Error('잘못된 요청입니다: 첨부 열기 입력이 객체가 아닙니다');
  const how = raw.how;
  if (how !== 'open' && how !== 'reveal') throw new Error('잘못된 요청입니다: how 는 open·reveal 중 하나여야 합니다');
  return { ticketId: requireVocId(raw.ticketId, 'ticketId'), fileId: requireVocId(raw.fileId, 'fileId'), how };
}

function requireCode(value: unknown, what: string): string {
  if (typeof value !== 'string' || !VOC_CODE_RE.test(value)) {
    throw new Error(`잘못된 요청입니다: ${what} 코드 형식이 아닙니다`);
  }
  return value;
}

/**
 * [VOC 에서 열기] 주소 확인(명세 §3-1): https, 경로는 /maintenance/tickets/<id> 만. 계정·검색어·조각이 붙은 주소는
 * 받지 않는다. 보드의 웹 주소(whoami 호스트)를 알면 그것과 같은 출처여야 한다(주소는 VocService 가 whoami 로 만든다 —
 * 이중 확인). 맞으면 열 주소, 아니면 null
 */
export function checkVocWebUrl(url: string | null | undefined, ticketId: number, webBase: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== `/maintenance/tickets/${ticketId}`) return null;
  if (webBase) {
    let base: URL;
    try {
      base = new URL(webBase);
    } catch {
      return null;
    }
    if (base.protocol !== 'https:' || u.origin !== base.origin) return null;
  }
  return u.href;
}
