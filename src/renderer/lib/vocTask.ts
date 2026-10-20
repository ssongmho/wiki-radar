// 할 일 쪽 VOC 화면(2.6단계 명세 §5 V3a 'VOC 처리' · §6 V3b '메일 → VOC 등록') — 입력 상태·보내기 전 검사·확인 대화상자 문구·
// 결과 알림·main 응답 다듬기. React 를 모르는 순수 함수만 둔다. 최종 판정(CP949·길이·같은 actionId/createId)은 main 이 하고,
// 화면은 미리 막는다. 티켓 내용·메일 본문은 데이터다 — 글자로만 보이고 HTML 로 해석하지 않는다.
import type {
  Task,
  VocActionKind,
  VocActionResult,
  VocBoard,
  VocCode,
  VocCreateContext,
  VocCreateInput,
  VocCreateResult,
  VocCustomer,
  VocDirectory,
  VocMember,
  VocTicket,
} from '../../shared/types';
import { FEATURES } from '../../shared/edition';
import { VOC_REPLY_HTML_MAX, vocHtmlLength } from '../../shared/vocHtml';
import { formatMailDate, formatMonthDay, parseYmd, yearOf } from './date';
import { previewLines } from './reply';
import { josaRo, type NoticeLine, type SaveNotice } from './result';
import { numberOf, textOf, vocStatusLabel } from './tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** 길이 상한(명세 §5·§6 — voc-cli·서버와 같다. main 도 따로 검사한다) */
export const VOC_LIMITS = { reply: 5000, title: 500, description: 10_000 } as const;

/** 확인 대화상자·요청 내용 미리보기 줄 수 */
export const VOC_PREVIEW_LINES = 6;

/** 요청 내용이 이 줄 수를 넘으면 접는다(명세 §3-1) */
export const VOC_TEXT_FOLD_LINES = 12;

// ── 글자 다듬기·검사 ──

/** 여러 줄 내용(답변·요청 내용): 줄바꿈은 LF, 줄바꿈·탭 말고 제어 문자는 떼고 앞뒤 공백을 걷는다 */
export function cleanVocText(text: string): string {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

/** 한 줄 제목: 줄바꿈·탭·제어 문자는 공백 하나로, 앞뒤 공백을 걷는다 */
export function cleanVocTitle(text: string): string {
  return (text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** 안 보이는 글자(결합 문자·서식 문자·특수 공백)는 'U+200D' 처럼 코드로 보인다 */
export function charLabel(ch: string): string {
  if (/^[\p{M}\p{Cf}\p{Cc}\p{Z}]+$/u.test(ch)) {
    return [...ch].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
  }
  return ch;
}

/** 안내에 보일 글자 하나: 보이는 글자는 ‘—’ 처럼 따옴표로(문장의 문장부호와 섞이지 않게), 안 보이는 글자는 코드로 */
function quotedChar(ch: string): string {
  const label = charLabel(ch);
  return label === ch ? `‘${ch}’` : `${label}(안 보이는 글자)`;
}

/** 검사한 칸(제목·내용) — 안내가 글자가 어느 칸에 있는지 알린다 */
export interface CharsetField {
  label: string;
  text: string;
}

/**
 * CP949 로 보낼 수 없는 글자 안내(voc-charset-problem). 없으면 null.
 * 'VOC 로 보낼 수 없는 글자: ‘—’(내용), ‘😀’(제목·내용). 지우거나 …' — fields 를 주면 글자마다 들어 있는 칸을 붙인다
 */
export function charsetProblemText(chars: readonly string[], fields: readonly CharsetField[] = []): string | null {
  const list = [...new Set(chars.filter((c) => typeof c === 'string' && c !== ''))];
  if (list.length === 0) return null;
  const parts = list.map((c) => {
    const where = fields.filter((f) => typeof f.text === 'string' && f.text.includes(c)).map((f) => f.label);
    return where.length > 0 ? `${quotedChar(c)}(${where.join('·')})` : quotedChar(c);
  });
  return `VOC 로 보낼 수 없는 글자: ${parts.join(', ')}. 지우거나 다른 글자로 바꾸면 보낼 수 있습니다.`;
}

/**
 * 확인하는 동안 보일 글자: 앞서 찾은 문제 글자 가운데 아직 글에 남은 것(지운 글자는 바로 사라진다 — 새 결과가 오기 전에도).
 */
export function remainingChars(chars: readonly string[], text: string): string[] {
  return chars.filter((c) => c !== '' && text.includes(c));
}

/** main 의 checkVocText 응답 → 글자 목록 */
export function normalizeCharset(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((c): c is string => typeof c === 'string' && c !== ''))] : [];
}

export interface VocCheck {
  /** 누를 수 있는가 */
  ok: boolean;
  /** 못 누르는 이유(버튼 옆 안내). ok 면 null */
  reason: string | null;
  /** 입력을 고쳐야 하는 문제(길이 등 — form-problem 으로 보인다). 없으면 null */
  problem: string | null;
  /** CP949 불가 글자 안내(voc-charset-problem). 없으면 null */
  charset: string | null;
}

function lengthText(n: number): string {
  return n.toLocaleString('ko-KR');
}

/** VOC 에 보내는 모양(HTML)이 한도를 넘을 때의 문제 문장 — 글자 수는 한도 안이어도 줄바꿈·꺾쇠가 많으면 넘는다 */
function htmlTooLong(what: string, max: number, length: number): string {
  return `${what}은 VOC 에 보내는 모양(줄바꿈·꺾쇠 등을 HTML 로 바꾼 것)으로 ${lengthText(max)}자까지입니다(지금 ${lengthText(length)}자).`;
}

/**
 * 할 일 쪽(V3a 처리·V3b 등록) 쓰기를 막는 이유: 로그인 필요·설정 필요면 VOC 로 보내 봐야 확인 대화상자 뒤에 실패한다
 * (VOC 화면의 writeBlockReason 과 같은 규칙). 보드를 아직 못 받았으면 막지 않는다(main 이 판정). 없으면 null
 */
export function taskWriteBlock(board: VocBoard | null | undefined, verb: '바꿀' | '등록할'): string | null {
  if (!board) return null;
  if (board.state === 'login') return `VOC 에 로그인한 뒤 ${verb} 수 있습니다.`;
  if (board.state === 'notConfigured') return `voc-cli 위치를 설정한 뒤 ${verb} 수 있습니다.`;
  return null;
}

// ── V3a VOC 처리: 답변·상태 ──

/** 앱에서 바꿀 수 있는 상태(명세 §5 — 해결·완료는 VOC 웹에서) */
export const VOC_STATUS_CHOICES: readonly { value: 'in_progress' | 'pending'; label: string }[] = [
  { value: 'in_progress', label: '진행 중' },
  { value: 'pending', label: '보류' },
];

export function isStatusChoice(value: unknown): value is 'in_progress' | 'pending' {
  return value === 'in_progress' || value === 'pending';
}

/** 상태 고르기의 기본값: 지금이 진행 중이면 보류, 그 밖(보류·배정됨·접수)이면 진행 중 */
export function defaultStatusChoice(current: unknown): 'in_progress' | 'pending' {
  return current === 'in_progress' ? 'pending' : 'in_progress';
}

/** 답변 달기 검사. 비어 있기만 한 것은 문제 문장 대신 안내로 둔다(쓰기 전부터 빨간 문장이 뜨지 않게) */
export function checkVocReply(text: string, chars: readonly string[], busy: boolean): VocCheck {
  const body = cleanVocText(text);
  const charset = charsetProblemText(chars);
  const fail = (reason: string, problem: string | null = null): VocCheck => ({ ok: false, reason, problem, charset });
  if (busy) return fail('VOC 에 쓰는 중입니다. 끝나면 다시 할 수 있습니다.');
  if (body.length > VOC_LIMITS.reply) {
    return fail(
      '답변 길이를 줄이면 등록할 수 있습니다.',
      `답변은 ${lengthText(VOC_LIMITS.reply)}자까지 적을 수 있습니다(지금 ${lengthText(body.length)}자).`,
    );
  }
  // 답변 5,000자는 앱 한도(서버는 답변 길이를 보지 않는다) — 사람이 보는 글자 수로 센다. 내용 한도는 서버 것이라 HTML 로 센다.
  // 다만 꺾쇠·탭이 많아 바꾼 모양이 명령줄 한도를 넘으면 막는다(main 과 같은 상한)
  const html = vocHtmlLength(body);
  if (html > VOC_REPLY_HTML_MAX) return fail('답변 길이를 줄이면 등록할 수 있습니다.', htmlTooLong('답변', VOC_REPLY_HTML_MAX, html));
  if (charset) return fail('VOC 로 보낼 수 없는 글자를 지우면 등록할 수 있습니다.');
  if (body === '') return fail('답변 내용을 적으면 등록할 수 있습니다.');
  return { ok: true, reason: null, problem: null, charset: null };
}

/** 답변 확인 대화상자 첫 문장(명세 §5) */
export function replyConfirmLead(number: string): string {
  return `${number}에 답변을 등록합니다. VOC 쪽 알림·메일은 나가지 않지만 고객 포털에서 보일 수 있습니다.`;
}

/** 상태 확인 대화상자 첫 문장 */
export function statusConfirmLead(number: string, from: unknown, to: string): string {
  const next = vocStatusLabel(to);
  return `${number}의 상태를 ‘${vocStatusLabel(from)}’에서 ‘${next}’${josaRo(next)} 바꿉니다.`;
}

/** 해결·완료 안내(명세 §5 — 작업시간 입력이 먼저 필요하고 voc-cli 에 그 명령이 없다) */
export const VOC_RESOLVE_NOTE =
  '첨부·작업시간·해결·완료·고객 메일은 VOC 화면에서 합니다([VOC 화면에서 보기]). VOC 웹에서 해도 됩니다.';

export function normalizeActionResult(raw: unknown): VocActionResult {
  const r = isRecord(raw) ? raw : {};
  const out: VocActionResult = { ok: r.ok === true, message: typeof r.message === 'string' ? r.message.trim() : '' };
  if (isRecord(r.ticket) && typeof r.ticket.id === 'number') out.ticket = r.ticket as unknown as VocTicket;
  return out;
}

export interface VocActionInfo {
  kind: Extract<VocActionKind, 'reply' | 'status'>;
  /** 티켓 번호(VOC-…) */
  number: string;
  /** status 일 때 바꾸기 전·뒤 상태 */
  from?: string;
  value: string;
}

/** 쓰기 결과(ok·실패) → 알림(voc-action-notice). 실패 문장은 서버 문장 그대로 */
export function actionNotice(info: VocActionInfo, result: VocActionResult, id: number): SaveNotice {
  const message = textOf(result.message);
  if (result.ok) {
    const next = vocStatusLabel(info.value);
    const title =
      info.kind === 'reply' ? `${info.number}에 답변을 등록했습니다.` : `${info.number} 상태를 ‘${next}’${josaRo(next)} 바꿨습니다.`;
    const lines: NoticeLine[] = [];
    if (message && message !== title) lines.push({ text: message });
    lines.push({ text: 'VOC 목록을 새로 받습니다. 이 할 일도 곧 새 내용으로 바뀝니다.' });
    return { id, tone: 'ok', title, lines };
  }
  return actionFailure(info, message ?? '이유를 알 수 없습니다.', id);
}

/** 쓰기 실패(ok:false·예외) → 알림 */
export function actionFailure(info: VocActionInfo, message: string, id: number): SaveNotice {
  return {
    id,
    tone: 'error',
    title: info.kind === 'reply' ? `${info.number}에 답변을 등록하지 못했습니다.` : `${info.number} 상태를 바꾸지 못했습니다.`,
    lines: [
      { text: message, warn: true },
      {
        text:
          info.kind === 'reply'
            ? '적은 답변은 그대로 남아 있습니다. 확인한 뒤 다시 등록해 주세요.'
            : 'VOC 쪽 상태는 그대로입니다. 확인한 뒤 다시 해 주세요.',
      },
    ],
  };
}

// ── 보드에서 꺼내기 ──

/** 보드의 모든 칸에서 그 티켓(없으면 undefined) */
export function ticketOnBoard(board: VocBoard | null | undefined, ticketId: number): VocTicket | undefined {
  if (!board || !Array.isArray(board.lanes)) return undefined;
  for (const lane of board.lanes) {
    const found = Array.isArray(lane?.tickets) ? lane.tickets.find((t) => t?.id === ticketId) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** 나(보드의 me → '나' 칸 사람) */
export function boardMe(board: VocBoard | null | undefined): VocMember | undefined {
  if (!board) return undefined;
  if (board.me && typeof board.me.id === 'number') return board.me;
  return Array.isArray(board.lanes) ? board.lanes.find((l) => l?.me && l.member)?.member : undefined;
}

/** 팀원(보드의 사람 칸 — 나 빼고, 설정 순서) */
export function boardTeam(board: VocBoard | null | undefined): VocMember[] {
  if (!board || !Array.isArray(board.lanes)) return [];
  const me = boardMe(board);
  const out: VocMember[] = [];
  for (const lane of board.lanes) {
    const m = lane?.member;
    if (!m || typeof m.id !== 'number' || lane.me || m.id === me?.id || out.some((o) => o.id === m.id)) continue;
    out.push(m);
  }
  return out;
}

/** [VOC 에서 열기]를 누를 수 있는가: 보드를 아직 못 받았으면 main 이 정한다(true), 받았는데 웹 주소가 없으면 false */
export function canOpenWeb(board: VocBoard | null | undefined): boolean {
  return !board || !!textOf(board.webBase);
}

// ── 티켓 요약(V3a 패널) ──

export interface TicketFact {
  key: string;
  label: string;
  value: string;
  tone?: 'coral' | 'amber';
}

const SLA_LABEL: Record<string, string> = { normal: '정상', warning: '임박', exceeded: '초과' };

/** 해결 목표(분) → '48시간' · '90분' */
export function slaTargetText(minutes: unknown): string | undefined {
  const m = numberOf(minutes);
  if (m === undefined || m <= 0) return undefined;
  if (m % 60 === 0) return `${m / 60}시간`;
  return `${m}분`;
}

/** UTC ISO → KST '9월 15일 오후 5:28'(해가 today 와 다르면 해를 붙인다) */
export function kstDateTime(iso: unknown, today: string): string | undefined {
  const text = textOf(iso);
  if (!text) return undefined;
  const out = formatMailDate(text, { refYear: yearOf(today), offsetMinutes: 9 * 60 });
  return out || undefined;
}

function dueFact(key: string, label: string, date: unknown, today: string): TicketFact | undefined {
  if (!parseYmd(date)) return undefined;
  const d = date as string;
  const text = formatMonthDay(d, yearOf(today));
  return d < today ? { key, label, value: `${text}(지남)`, tone: 'coral' } : { key, label, value: text };
}

/**
 * 상세 VOC 처리 칸의 티켓 요약. 보드에서 찾은 티켓이 있으면 그것으로, 없으면(보드를 아직 못 받음·칸이 바뀜) 할 일에 든 값으로.
 * 사실만 적는다(명세 §0 — 판단어 없음).
 */
export function ticketFacts(task: Task, ticket: VocTicket | undefined, today: string): TicketFact[] {
  const info = task.voc;
  const facts: TicketFact[] = [];
  const status = textOf(ticket?.status) ?? textOf(info?.status);
  if (status) facts.push({ key: 'status', label: '상태', value: vocStatusLabel(status), tone: status === 'in_progress' ? 'amber' : undefined });
  const priority = textOf(ticket?.priority) ?? textOf(info?.priority);
  facts.push({ key: 'priority', label: '우선순위', value: priority ?? '없음' });
  const sla = ticket?.slaStatus ?? info?.slaStatus;
  if (sla && SLA_LABEL[sla]) {
    const target = slaTargetText(ticket?.slaResolutionTarget);
    facts.push({
      key: 'sla',
      label: 'SLA',
      value: target ? `${SLA_LABEL[sla]} · 목표 ${target}` : SLA_LABEL[sla],
      tone: sla === 'exceeded' ? 'coral' : sla === 'warning' ? 'amber' : undefined,
    });
  }
  const customer = textOf(ticket?.customer) ?? textOf(task.company);
  if (customer) facts.push({ key: 'customer', label: '고객사', value: customer });
  const system = textOf(ticket?.systemName) ?? textOf(info?.systemName) ?? textOf(ticket?.system);
  if (system) facts.push({ key: 'system', label: '시스템', value: system });
  const requester = textOf(ticket?.requesterName);
  if (requester) facts.push({ key: 'requester', label: '요청자', value: requester });
  const requestType = textOf(ticket?.requestType);
  if (requestType) facts.push({ key: 'requestType', label: '요청유형', value: requestTypeLabel(requestType) });
  const created = kstDateTime(ticket?.createdAt, today);
  if (created) {
    const age = numberOf(ticket?.ageDays);
    facts.push({ key: 'created', label: '접수', value: age !== undefined ? `${created} · ${age}일째` : created });
  }
  const customerDue = dueFact('customerDue', '고객 희망일', ticket?.customerDue, today);
  if (customerDue) facts.push(customerDue);
  const ictDue = dueFact('ictDue', 'ICT 예상일', ticket?.ictDue, today);
  if (ictDue) facts.push(ictDue);
  const replies = numberOf(ticket?.replyCount);
  if (replies !== undefined) {
    const last = kstDateTime(ticket?.lastReplyAt, today);
    facts.push({ key: 'replies', label: '답변', value: last ? `${replies}건 · 마지막 ${last}` : `${replies}건` });
  }
  return facts;
}

/** 요청 내용 접기: 앞 n줄과 접힌 줄 수 */
export function foldText(text: string, n = VOC_TEXT_FOLD_LINES): { head: string; hidden: number } {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').trimEnd().split('\n');
  if (lines.length <= n) return { head: lines.join('\n'), hidden: 0 };
  return { head: lines.slice(0, n).join('\n'), hidden: lines.length - n };
}

// ── V3b 메일 → VOC 등록 ──

/** 요청유형 이름(code list REQUEST_TYPE 을 못 받았을 때의 풀이) */
const REQUEST_TYPE_LABEL: Record<string, string> = {
  inquiry: '문의',
  bug: '오류',
  enhancement: '개선',
  data_request: '데이터 요청',
  access: '권한',
  other: '기타',
  substance_registration: '물질 등록',
};

export function requestTypeLabel(code: string, codes?: readonly VocCode[]): string {
  const found = codes?.find((c) => c.code === code);
  if (found && textOf(found.name)) return found.name;
  return REQUEST_TYPE_LABEL[code] ?? code;
}

export const VOC_PRIORITIES: readonly string[] = ['P1', 'P2', 'P3'];
export const DEFAULT_REQUEST_TYPE = 'inquiry';
export const DEFAULT_PRIORITY = 'P3';

/** 할 일 줄의 [voc:: 번호](이미 등록함). 없거나 비었으면 undefined */
export function lineVocNumber(rawLine: unknown): string | undefined {
  if (typeof rawLine !== 'string') return undefined;
  for (const m of rawLine.matchAll(/\[voc::([^\]]*)\]/g)) {
    const value = m[1].trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * 할 일 줄에 [voc:: …] 필드가 있는가 — 값이 비었거나 ] 로 닫히지 않은 모양도 있는 것으로 본다(main 의 hasLineField 와 같은 판정:
 * 줄 붙이기가 거부하므로 티켓을 만들면 안 된다). lineVocNumber 가 없는데 이것이 참이면 [VOC 로 등록] 대신 안내를 보인다
 */
export function lineHasVocField(rawLine: unknown): boolean {
  return typeof rawLine === 'string' && /\[\s*voc\s*::/u.test(rawLine);
}

/** VOC 로 등록할 수 있는 할 일: 메일 할 일(task.mail)이고 VOC 할 일이 아니다. 공개판은 VOC 가 없다(src/shared/edition.ts) */
export function canCreateVoc(task: Task): boolean {
  return FEATURES.voc && task.source !== 'voc' && !!textOf(task.mail);
}

/** 할 일 하나의 VOC 등록 작성 칸. 상세의 훅(useVocCreate)이 taskId 별로 메모리에 들고 있다 */
export interface VocCreateDraft {
  /** 작성 칸마다 새 UUID(성공하면 새로). main 은 같은 값을 두 번 실행하지 않는다 */
  createId: string;
  /** 등록 문맥으로 기본값을 채웠는가 — 한 번만(사람이 고친 값을 덮지 않는다) */
  prefilled: boolean;
  title: string;
  description: string;
  /** 고른 고객사 id(select 값, '' = 고르지 않음) */
  customerId: string;
  /** 시스템 코드('' = 고르지 않음) */
  system: string;
  requestType: string;
  priority: string;
  /** 담당 user id('' = 비움) */
  assigneeId: string;
}

export function initialCreateDraft(createId: string): VocCreateDraft {
  return {
    createId,
    prefilled: false,
    title: '',
    description: '',
    customerId: '',
    system: '',
    requestType: DEFAULT_REQUEST_TYPE,
    priority: DEFAULT_PRIORITY,
    assigneeId: '',
  };
}

/** 등록 문맥으로 기본값을 채운다(한 번만). 담당은 비운다(명세 §6) */
export function prefillCreateDraft(draft: VocCreateDraft, ctx: VocCreateContext): VocCreateDraft {
  if (draft.prefilled) return draft;
  return {
    ...draft,
    prefilled: true,
    title: ctx.title,
    description: ctx.description,
    customerId: ctx.customerId !== undefined ? String(ctx.customerId) : '',
    system: ctx.system ?? '',
    requestType: textOf(ctx.requestType) ?? DEFAULT_REQUEST_TYPE,
    priority: VOC_PRIORITIES.includes(ctx.priority) ? ctx.priority : DEFAULT_PRIORITY,
    assigneeId: '',
  };
}

/** 처음 채운 값과 다른가(사람이 고쳤는가) */
export function isCreateDirty(draft: VocCreateDraft, ctx: VocCreateContext | undefined): boolean {
  if (!ctx || !draft.prefilled) return false;
  const base = prefillCreateDraft({ ...draft, prefilled: false }, ctx);
  return (
    draft.title !== base.title ||
    draft.description !== base.description ||
    draft.customerId !== base.customerId ||
    draft.system !== base.system ||
    draft.requestType !== base.requestType ||
    draft.priority !== base.priority ||
    draft.assigneeId !== base.assigneeId
  );
}

/** CP949 검사에 넘길 글(제목과 내용) */
export function createCharsetText(draft: VocCreateDraft): string {
  return `${draft.title}\n${draft.description}`;
}

/** 등록 검사: 길이 문제 → 보낼 수 없는 글자 → 빈 제목·고르지 않은 고객사·시스템(안내) 순 */
export function checkVocCreate(draft: VocCreateDraft, chars: readonly string[], busy: boolean): VocCheck {
  const title = cleanVocTitle(draft.title);
  const description = cleanVocText(draft.description);
  const charset = charsetProblemText(chars, [
    { label: '제목', text: draft.title },
    { label: '내용', text: draft.description },
  ]);
  const fail = (reason: string, problem: string | null = null): VocCheck => ({ ok: false, reason, problem, charset });
  if (busy) return fail('VOC 티켓을 만드는 중입니다…');
  if (title.length > VOC_LIMITS.title) {
    return fail('제목을 줄이면 등록할 수 있습니다.', `제목은 ${lengthText(VOC_LIMITS.title)}자까지 적을 수 있습니다(지금 ${lengthText(title.length)}자).`);
  }
  if (description.length > VOC_LIMITS.description) {
    return fail(
      '내용을 줄이면 등록할 수 있습니다.',
      `내용은 ${lengthText(VOC_LIMITS.description)}자까지 적을 수 있습니다(지금 ${lengthText(description.length)}자).`,
    );
  }
  const html = vocHtmlLength(description);
  if (html > VOC_LIMITS.description) return fail('내용을 줄이면 등록할 수 있습니다.', htmlTooLong('내용', VOC_LIMITS.description, html));
  if (charset) return fail('VOC 로 보낼 수 없는 글자를 지우면 등록할 수 있습니다.');
  if (title === '') return fail('제목을 적으면 등록할 수 있습니다.');
  if (!/^\d+$/.test(draft.customerId)) return fail('고객사를 고르면 등록할 수 있습니다.');
  if (draft.system.trim() === '') return fail('시스템을 고르면 등록할 수 있습니다.');
  return { ok: true, reason: null, problem: null, charset: null };
}

/** 작성 칸 → createVocTicket 입력(검사를 통과하지 못하면 null) */
export function buildCreateInput(draft: VocCreateDraft, taskId: string): VocCreateInput | null {
  if (!draft.createId || !checkVocCreate(draft, [], false).ok) return null;
  const input: VocCreateInput = {
    createId: draft.createId,
    taskId,
    title: cleanVocTitle(draft.title),
    description: cleanVocText(draft.description),
    customerId: Number(draft.customerId),
    system: draft.system.trim(),
    requestType: textOf(draft.requestType) ?? DEFAULT_REQUEST_TYPE,
    priority: VOC_PRIORITIES.includes(draft.priority) ? draft.priority : DEFAULT_PRIORITY,
  };
  if (/^\d+$/.test(draft.assigneeId)) input.assigneeId = Number(draft.assigneeId);
  return input;
}

// ── 선택지 ──

export interface SelectOption {
  value: string;
  label: string;
  /** 묶음 이름(optgroup). 없으면 묶지 않는다 */
  group?: string;
}

/** 시스템 선택지 묶음: 고른 고객사의 진행 중 티켓에 나온 시스템 / 그 밖 */
export const SYSTEM_GROUP_CUSTOMER = '이 고객사의 진행 중 티켓에 나온 시스템';
export const SYSTEM_GROUP_OTHER = '그 밖의 시스템';

/** 지금 값이 선택지에 없으면(목록을 못 받음 등) 그 값을 맨 앞에 넣어 select 가 다른 항목을 보이지 않게 한다 */
function withCurrent(options: SelectOption[], value: string, label: string): SelectOption[] {
  if (value === '' || options.some((o) => o.value === value)) return options;
  return [{ value, label }, ...options];
}

/** 고객사: 이름순(가나다) */
export function customerOptions(customers: readonly VocCustomer[], current: string): SelectOption[] {
  const list = customers
    .filter((c) => typeof c?.id === 'number' && textOf(c.name))
    .map((c) => ({ value: String(c.id), label: c.name.trim() }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  return withCurrent(list, current, `고객사 #${current}`);
}

/**
 * 시스템: 받은 순서(main 이 이름순으로 준다) — '이름 (코드)'. 선택지는 main 이 받은 진행 중 티켓의 시스템 + 설정의 팀 시스템으로
 * 만든다(운영 VOC 의 `code list SYSTEM` 은 비어 있다). customerId 를 주면 그 고객사 티켓에 나온 시스템을 앞 묶음으로 둔다
 */
export function systemOptions(systems: readonly VocCode[], current: string, customerId?: string): SelectOption[] {
  const valid = systems.filter((s) => textOf(s?.code));
  const cid = customerId !== undefined && /^\d+$/.test(customerId) ? Number(customerId) : undefined;
  const mine = cid !== undefined ? valid.filter((s) => Array.isArray(s.customerIds) && s.customerIds.includes(cid)) : [];
  const label = (s: VocCode): string => (textOf(s.name) && s.name.trim() !== s.code ? `${s.name.trim()} (${s.code})` : s.code);
  const grouped = mine.length > 0 && mine.length < valid.length;
  const list: SelectOption[] =
    mine.length > 0
      ? [
          ...mine.map((s) => ({ value: s.code, label: label(s), ...(grouped ? { group: SYSTEM_GROUP_CUSTOMER } : {}) })),
          ...valid.filter((s) => !mine.includes(s)).map((s) => ({ value: s.code, label: label(s), group: SYSTEM_GROUP_OTHER })),
        ]
      : valid.map((s) => ({ value: s.code, label: label(s) }));
  return withCurrent(list, current, current);
}

/** 요청유형: 받은 목록(없으면 지금 값 하나) */
export function requestTypeOptions(codes: readonly VocCode[], current: string): SelectOption[] {
  const list = codes.filter((c) => textOf(c?.code)).map((c) => ({ value: c.code, label: requestTypeLabel(c.code, codes) }));
  return withCurrent(list, current, requestTypeLabel(current));
}

/** 담당: 비움 · 나 · 팀원(보드의 사람 칸, 명세 §6). 나는 보드에서, 없으면 등록 문맥의 directory.me 로 */
export function assigneeOptions(board: VocBoard | null | undefined, directoryMe: VocMember | undefined, current: string): SelectOption[] {
  const out: SelectOption[] = [{ value: '', label: '비움(지정하지 않음)' }];
  const me = boardMe(board) ?? (directoryMe && typeof directoryMe.id === 'number' ? directoryMe : undefined);
  if (me) out.push({ value: String(me.id), label: textOf(me.name) ? `나(${me.name.trim()})` : '나' });
  for (const m of boardTeam(board)) {
    if (out.some((o) => o.value === String(m.id))) continue;
    out.push({ value: String(m.id), label: textOf(m.name) ?? `#${m.id}` });
  }
  return withCurrent(out, current, `#${current}`);
}

function optionLabel(options: readonly SelectOption[], value: string, fallback: string): string {
  return options.find((o) => o.value === value)?.label ?? fallback;
}

// ── 등록 문맥 불러오기 상태 ──

export type CreateContextEntry =
  | { status: 'idle' }
  /** 읽는 중. ctx = 앞서 읽은 값 */
  | { status: 'loading'; ctx?: VocCreateContext }
  | { status: 'ready'; ctx: VocCreateContext }
  /** 메일 할 일이 아니거나 원본 메일이 없다(null 응답) */
  | { status: 'missing' }
  | { status: 'error'; message: string; ctx?: VocCreateContext };

export const IDLE_CREATE_CONTEXT: CreateContextEntry = { status: 'idle' };

export function createContextOf(entry: CreateContextEntry | undefined): VocCreateContext | undefined {
  if (!entry) return undefined;
  return entry.status === 'loading' || entry.status === 'ready' || entry.status === 'error' ? entry.ctx : undefined;
}

function normalizeMember(raw: unknown): VocMember | null {
  if (!isRecord(raw) || typeof raw.id !== 'number' || !Number.isFinite(raw.id)) return null;
  const m: VocMember = { id: raw.id, name: textOf(raw.name) ?? `#${raw.id}` };
  const email = textOf(raw.email);
  if (email) m.email = email;
  const department = textOf(raw.department);
  if (department) m.department = department;
  return m;
}

function normalizeCodes(raw: unknown): VocCode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => isRecord(c) && typeof c.code === 'string' && c.code.trim() !== '')
    .map((c) => {
      const out: VocCode = { code: (c.code as string).trim(), name: typeof c.name === 'string' ? c.name : '' };
      if (Array.isArray(c.customerIds)) {
        const ids = c.customerIds.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
        if (ids.length > 0) out.customerIds = [...new Set(ids)];
      }
      return out;
    });
}

export function normalizeDirectory(raw: unknown): VocDirectory {
  const d = isRecord(raw) ? raw : {};
  const users = Array.isArray(d.users) ? d.users.map(normalizeMember).filter((m): m is VocMember => m !== null) : [];
  const customers = Array.isArray(d.customers)
    ? d.customers
        .filter((c): c is Record<string, unknown> => isRecord(c) && typeof c.id === 'number' && typeof c.name === 'string')
        .map((c) => ({ id: c.id as number, name: c.name as string }))
    : [];
  const dir: VocDirectory = { users, systems: normalizeCodes(d.systems), requestTypes: normalizeCodes(d.requestTypes), customers };
  const me = normalizeMember(d.me);
  if (me) dir.me = me;
  return dir;
}

/** 등록 문맥 응답 → VocCreateContext. 없거나(null) 모양이 틀리면 null */
export function normalizeCreateContext(raw: unknown): VocCreateContext | null {
  if (!isRecord(raw)) return null;
  const ctx: VocCreateContext = {
    taskId: textOf(raw.taskId) ?? '',
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description.replace(/\r\n?/g, '\n') : '',
    requestType: textOf(raw.requestType) ?? DEFAULT_REQUEST_TYPE,
    priority: textOf(raw.priority) ?? DEFAULT_PRIORITY,
    directory: normalizeDirectory(raw.directory),
  };
  const existing = textOf(raw.existing);
  if (existing) ctx.existing = existing;
  if (typeof raw.customerId === 'number' && Number.isFinite(raw.customerId)) ctx.customerId = raw.customerId;
  const system = textOf(raw.system);
  if (system) ctx.system = system;
  return ctx;
}

// ── 확인 대화상자·결과 ──

/** 등록 확인 대화상자 첫 문장(명세 §6 그대로) */
export const CREATE_CONFIRM_LEAD =
  'VOC 티켓을 만듭니다. 운영 Slack 에 ‘신규 VOC 등록’ 알림이 갑니다. 담당을 지정하면 그 사람에게 배정 메일이 갑니다. 고객에게는 메일이 가지 않습니다.';

export interface VocCreateConfirm {
  rows: { label: string; value: string }[];
  /** 내용 앞 줄 */
  preview: string[];
  moreLines: number;
  /** 만든 뒤 일어나는 일 */
  after: string[];
}

export function createConfirmSummary(args: {
  draft: VocCreateDraft;
  customers: readonly SelectOption[];
  systems: readonly SelectOption[];
  requestTypes: readonly SelectOption[];
  assignees: readonly SelectOption[];
  /** 'mail' = 메일함에서 할 일 없이 등록(2.10단계 §7-2) — 줄에 붙이지 않고 메일 상태에만 남긴다 */
  target?: 'task' | 'mail';
}): VocCreateConfirm {
  const { draft, customers, systems, requestTypes, assignees } = args;
  const mailOnly = args.target === 'mail';
  const assigned = draft.assigneeId !== '';
  const assignee = assigned ? optionLabel(assignees, draft.assigneeId, `#${draft.assigneeId}`) : '비움';
  const { lines, more } = previewLines(cleanVocText(draft.description), VOC_PREVIEW_LINES);
  const after: string[] = [
    assigned ? `담당 ${assignee}에게 VOC 배정 메일이 갑니다.` : '담당을 비워 둡니다 — 배정 메일은 가지 않습니다.',
    ...(mailOnly
      ? ['만든 뒤 번호를 메일 상태(앱 데이터)에 남깁니다. 연결된 할 일이 없어 위키에는 쓰지 않습니다.']
      : ['만든 뒤 이 할 일 줄 끝에 [voc:: 번호]를 붙입니다(쓰기 전에 줄을 다시 확인하고 백업합니다).', '할 일 상태는 바꾸지 않습니다.']),
  ];
  return {
    rows: [
      { label: '제목', value: cleanVocTitle(draft.title) },
      { label: '고객사', value: optionLabel(customers, draft.customerId, `#${draft.customerId}`) },
      { label: '시스템', value: optionLabel(systems, draft.system, draft.system) },
      { label: '요청유형', value: optionLabel(requestTypes, draft.requestType, requestTypeLabel(draft.requestType)) },
      { label: '우선순위', value: draft.priority },
      { label: '담당', value: assignee },
    ],
    preview: lines.length === 1 && lines[0] === '' ? [] : lines,
    moreLines: more,
    after,
  };
}

/** 할 일은 그대로라는 안내(명세 §6 ③) */
export const TASK_UNCHANGED_NOTE = '할 일은 그대로입니다. 끝났으면 완료로 저장하세요.';

export function normalizeCreateResult(raw: unknown): VocCreateResult | null {
  if (!isRecord(raw) || typeof raw.ticketId !== 'number' || !textOf(raw.number)) return null;
  const out: VocCreateResult = {
    ticketId: raw.ticketId,
    number: (raw.number as string).trim(),
    lineUpdated: raw.lineUpdated === true,
    warnings: strings(raw.warnings),
  };
  const lineError = textOf(raw.lineError);
  if (lineError) out.lineError = lineError;
  return out;
}

/** 등록 결과 → 알림. 줄에 붙이지 못했으면(lineError) 경고색 — 티켓은 만들어졌고 번호를 보인다(사람이 줄에 적을 수 있게) */
export function createNotice(result: VocCreateResult, id: number): SaveNotice {
  const lines: NoticeLine[] = [];
  if (result.lineUpdated && !result.lineError) {
    lines.push({ text: `할 일 줄 끝에 [voc:: ${result.number}]를 붙였습니다.` });
  } else {
    lines.push({ text: `할 일 줄에 번호를 붙이지 못했습니다. ${result.lineError ?? '이유를 알 수 없습니다.'}`, warn: true });
    lines.push({ text: `티켓은 만들어졌습니다. 필요하면 할 일 줄 끝에 [voc:: ${result.number}]를 직접 적어 두세요.`, warn: true });
  }
  for (const w of result.warnings) lines.push({ text: w, warn: true });
  lines.push({ text: TASK_UNCHANGED_NOTE });
  return {
    id,
    tone: lines.some((l) => l.warn) ? 'warn' : 'ok',
    title: `VOC 티켓 ${result.number}을(를) 만들었습니다.`,
    lines,
  };
}

/** 메일만으로 등록한 결과(2.10단계 §7-2) → 알림. 위키에는 쓰지 않는다 */
export function mailCreateNotice(result: VocCreateResult, id: number): SaveNotice {
  const lines: NoticeLine[] = [{ text: `번호를 메일 상태에 남겼습니다 — 메일함에서 「${result.number}」 배지로 보입니다.` }];
  for (const w of result.warnings) lines.push({ text: w, warn: true });
  if (result.lineError) lines.push({ text: result.lineError, warn: true });
  lines.push({ text: '위키에는 쓰지 않았습니다(연결된 할 일 없음).' });
  return {
    id,
    tone: lines.some((l) => l.warn) ? 'warn' : 'ok',
    title: `VOC 티켓 ${result.number}을(를) 만들었습니다.`,
    lines,
  };
}

/** 등록 실패(예외) → 알림. 입력은 남아 있다 */
export function createFailure(message: string, id: number): SaveNotice {
  return {
    id,
    tone: 'error',
    title: 'VOC 티켓을 만들지 못했습니다.',
    lines: [
      { text: message, warn: true },
      { text: '적은 내용은 그대로 남아 있습니다. VOC 에 티켓이 생기지 않았는지 확인한 뒤 다시 등록해 주세요.' },
    ],
  };
}

/** 'VOC-2026-0013 로 등록함' 배지 글자(명세 §6) */
export function createdBadgeText(number: string): string {
  return `${number} 로 등록함`;
}
