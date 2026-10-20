// 메일 회신(2.5단계 명세 §7) — 작성 칸 상태·보내기 전 검사·초안 받기·확인 대화상자 요약·발송 결과 알림.
// React 를 모르는 순수 함수만 둔다. 주소 파싱·본문 검사는 main 과 같은 src/shared/reply.ts 를 쓴다(최종 판정은 main, 화면은 미리 막는다).
import {
  REPLY_LIMITS,
  addressOf,
  displayNameOf,
  formatAddress,
  recipientLabel,
  replyProblem,
  sameAddress,
  sentLine,
  splitAddressList,
} from '../../shared/reply';
import type {
  MailSettings,
  ReplyContext,
  ReplyDraft,
  SaveResultInput,
  SendMailReplyInput,
  SendMailReplyOutput,
  SendReplyInput,
  SendReplyOutput,
  SentMailRecord,
  Task,
} from '../../shared/types';
import { formatElapsed } from './queue';
import {
  DEFAULT_OWNER,
  buildSaveInput,
  isPartialSave,
  josaRo,
  leavesList,
  statusLabel,
  summarizeSave,
  type NoticeLine,
  type ResultDraft,
  type SaveNotice,
} from './result';
import { taskTitle, textOf } from './tasks';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

// ── 작성 칸 상태 ──

export type DraftRunState = 'idle' | 'running' | 'done' | 'failed';

/** [초안 만들기] 진행·결과 */
export interface ReplyDraftStatus {
  state: DraftRunState;
  /** 실패 이유·멈춤 안내 등 한 줄 */
  message?: string;
  /** 초안이 참고한 위키 문서(볼트 기준 상대경로) */
  references: string[];
  /** 소유자가 확인할 점(없으면 '') */
  notes: string;
  /** 만들기 시작한 시각(ms). 실행 표식이기도 하다 — 멈추거나 되돌린 뒤 늦게 온 옛 결과를 버린다 */
  startedAt?: number;
  /** 받은 초안이 걸린 시간 */
  durationMs?: number;
  /** 한 번이라도 초안을 받았는가([다시 만들기]) */
  received: boolean;
  /** 받은 초안을 만든 엔진(2.13단계 §E — 없으면 옛 main, Claude) */
  engine?: 'claude' | 'local';
}

/** 할 일 하나의 회신 작성 칸. FullView 가 taskId 별로 메모리에 들고 있다 */
export interface ReplyState {
  /** '회신 메일 보내기'를 켰는가 */
  enabled: boolean;
  /** 회신 문맥으로 받는사람·제목 기본값을 채웠는가 — 한 번만 채운다(사람이 고친 값을 덮지 않는다) */
  prefilled: boolean;
  /** 받는사람(쉼표로 구분한 한 줄) */
  to: string;
  cc: string;
  subject: string;
  /** 본문(서명·인용 전) */
  body: string;
  /** 초안에 더할 요청(선택, 예: '더 짧게') */
  hint: string;
  quoteOriginal: boolean;
  /** 작성 칸마다 새 UUID. main 은 같은 값을 두 번 보내지 않는다 */
  sendId: string;
  draft: ReplyDraftStatus;
  /** 받은 초안 — 지금 본문이 비어 있지 않아 바꿀지 확인을 기다린다 */
  pendingDraft?: ReplyDraft;
  /** [전체 회신]으로 참조를 채웠는가(버튼이 '참조 비우기'가 된다) */
  ccAllApplied: boolean;
  /** 메일함 회신(2.10단계 §8-3)의 「이번에 전할 핵심」 — 할 일 회신은 처리 결과 폼의 처리 내용을 쓴다 */
  note?: string;
}

/** 서명·보내는 이름 기본값(명세 §5-2) */
export const DEFAULT_MAIL_SETTINGS: MailSettings = { fromName: '', signature: '', bccSelf: true };

/** 초안 요청(hint) 길이 상한(화면 쪽) */
export const HINT_MAX = 500;

/** 확인 대화상자에 보이는 본문 앞 줄 수 */
export const PREVIEW_LINES = 6;

type CryptoLike = { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array };

/**
 * 새 sendId(UUID v4). crypto.randomUUID 가 없으면(보안 문맥이 아닌 창 등) getRandomValues 로 같은 꼴을 만든다.
 * main 은 8~64자의 영문·숫자·하이픈만 받는다.
 */
export function makeSendId(source: CryptoLike | undefined = globalThis.crypto as CryptoLike | undefined): string {
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function idleDraft(): ReplyDraftStatus {
  return { state: 'idle', references: [], notes: '', received: false };
}

/** 처음 여는 작성 칸: 꺼져 있고 비었다. 원문 인용은 기본으로 켠다 */
export function initialReply(sendId: string): ReplyState {
  return {
    enabled: false,
    prefilled: false,
    to: '',
    cc: '',
    subject: '',
    body: '',
    hint: '',
    quoteOriginal: true,
    sendId,
    draft: idleDraft(),
    ccAllApplied: false,
  };
}

/** 되돌릴 것이 있는가(켰거나, 본문을 적었거나, 초안이 확인을 기다린다) */
export function isReplyDirty(state: ReplyState): boolean {
  return state.enabled || state.body.trim() !== '' || state.pendingDraft !== undefined;
}

/**
 * 주소 목록 → 한 줄 입력값(', ' 로 잇는다). 이름에 쉼표·세미콜론이 있으면 따옴표로 감싸 다시 나눠도 한 주소로 남게 한다.
 * 형식이 틀린 항목은 받은 글자 그대로 둔다(검사가 알린다).
 */
export function joinAddresses(list: readonly string[]): string {
  return list
    .map((item) => {
      const addr = addressOf(item);
      return addr ? formatAddress(displayNameOf(item), addr) : item.trim();
    })
    .filter((s) => s !== '')
    .join(', ');
}

/** 회신 문맥으로 받는사람·제목 기본값을 채운다(한 번만). 참조는 비운다 — [전체 회신]이 채운다 */
export function prefillReply(state: ReplyState, ctx: ReplyContext): ReplyState {
  if (state.prefilled) return state;
  return { ...state, prefilled: true, to: joinAddresses(ctx.to), cc: '', subject: ctx.subject, ccAllApplied: false };
}

/** [전체 회신]이 참조에 더할 주소(받는사람·참조에 이미 있는 것은 뺀다) */
export function ccAllToAdd(state: ReplyState, ctx: ReplyContext): string[] {
  const present = [...splitAddressList(state.to), ...splitAddressList(state.cc)];
  const out: string[] = [];
  for (const item of ctx.ccAll) {
    if (present.some((p) => sameAddress(p, item)) || out.some((o) => sameAddress(o, item))) continue;
    out.push(item);
  }
  return out;
}

/** [전체 회신] ↔ [참조 비우기] */
export function toggleCcAll(state: ReplyState, ctx: ReplyContext): ReplyState {
  if (state.ccAllApplied) return { ...state, cc: '', ccAllApplied: false };
  const add = ccAllToAdd(state, ctx);
  if (add.length === 0) return state;
  return { ...state, cc: joinAddresses([...splitAddressList(state.cc), ...add]), ccAllApplied: true };
}

/** 작성 칸 → 보낼 값(주소는 나눠서, 제목은 앞뒤 공백을 떼고, 본문 줄바꿈은 LF) */
export function replyInput(state: ReplyState): { to: string[]; cc: string[]; subject: string; body: string } {
  return {
    to: splitAddressList(state.to),
    cc: splitAddressList(state.cc),
    subject: state.subject.trim(),
    body: state.body.replace(/\r\n?/g, '\n'),
  };
}

// ── 회신 문맥·설정 불러오기 상태 ──

export type ContextEntry =
  | { status: 'idle' }
  /** 읽는 중. ctx = 앞서 읽은 값(다시 읽는 동안에도 보인다) */
  | { status: 'loading'; ctx?: ReplyContext }
  | { status: 'ready'; ctx: ReplyContext }
  /** 메일 할 일이 아니거나 원본 메일 파일이 없다 */
  | { status: 'missing' }
  | { status: 'error'; message: string; ctx?: ReplyContext };

export const IDLE_CONTEXT: ContextEntry = { status: 'idle' };

/** 들고 있는 회신 문맥(읽는 중·실패여도 앞서 읽은 값) */
export function contextOf(entry: ContextEntry | undefined): ReplyContext | undefined {
  if (!entry) return undefined;
  return entry.status === 'loading' || entry.status === 'ready' || entry.status === 'error' ? entry.ctx : undefined;
}

/**
 * reply-panel 의 data-ready(명세 §9-5): 문맥을 다 읽었을 때만 붙는다. 읽는 중(다시 읽는 중 포함 — 앞서 읽은 값이
 * 화면에 남아 있어도)에는 없고, 원본이 없거나 읽기에 실패하면 'false'. 시험이 옛 값으로 지나가지 않게.
 */
export function panelReadyAttr(entry: ContextEntry | undefined): 'true' | 'false' | undefined {
  switch (entry?.status) {
    case 'ready':
      return entry.ctx.sender.ready ? 'true' : 'false';
    case 'missing':
    case 'error':
      return 'false';
    default:
      return undefined;
  }
}

/** 문장 끝 부호가 없으면 마침표를 붙인다(main 의 안내 문장 뒤에 화면 문장을 이을 때) */
export function asSentence(text: string): string {
  const t = (text ?? '').trimEnd();
  if (t === '') return '';
  return /[.!?。…]$/.test(t) ? t : `${t}.`;
}

export interface TextPart {
  text: string;
  /** 코드 글꼴로(사용자가 그대로 입력할 파일 경로·변수 이름) */
  code: boolean;
}

/** 백틱으로 감싼 부분, 계정 파일 경로, 환경변수 모양의 이름(대문자_대문자) */
const CODE_TOKEN_RE = /`([^`]+)`|(_mail-ingest\/\.env|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b)/g;

/**
 * 안내 문장 → 글·코드 조각. 계정 없음 안내(NO_ACCOUNT_PROBLEM)의 `_mail-ingest/.env`·MAILHOST_MAIL_PASS·
 * WIKI_RADAR_SMTP_USER 같은 이름을 코드 글꼴로 보여 낱말 중간에서 줄이 끊기지 않게 한다(화면은 nowrap).
 */
export function codeParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  const src = text ?? '';
  let last = 0;
  for (const m of src.matchAll(CODE_TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: src.slice(last, at), code: false });
    out.push({ text: m[1] ?? m[2] ?? '', code: true });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last), code: false });
  return out;
}

export interface SettingsEntry {
  status: 'idle' | 'loading' | 'ready' | 'error';
  value?: MailSettings;
  message?: string;
}

// ── 보내기 전 검사 ──

export interface ReplyCheck {
  /** [보내고 저장]을 누를 수 있는가 */
  ok: boolean;
  /** 못 누르는 이유(폼의 안내 문장). ok 면 null */
  reason: string | null;
  /** 입력을 고쳐야 하는 문제(reply-problem 으로 보인다). 없으면 null */
  problem: string | null;
}

/** 보내는 쪽이 준비되지 않았을 때 [보내고 저장] 옆 안내 */
export const SENDER_NOT_READY = '보내는 쪽(메일 계정·설정)이 준비되지 않아 보낼 수 없습니다. 회신 칸 위의 안내를 확인하세요.';

/**
 * 보낼 수 있는가(명세 §2 검사 + 계정 준비 + 초안 진행). 본문이 비어 있기만 한 것은 문제 문장 대신 안내로 둔다 —
 * 켜자마자 빨간 문장이 뜨지 않게.
 */
export function checkReply(state: ReplyState, entry: ContextEntry | undefined): ReplyCheck {
  const ctx = contextOf(entry);
  const fail = (reason: string, problem: string | null = null): ReplyCheck => ({ ok: false, reason, problem });
  if (!ctx || !state.prefilled) {
    if (entry?.status === 'missing') return fail('원본 메일을 찾지 못해 회신할 수 없습니다.');
    if (entry?.status === 'error') return fail(`회신 정보를 불러오지 못했습니다. (${entry.message})`);
    return fail('회신 정보를 불러오는 중입니다…');
  }
  const input = replyInput(state);
  const empty = input.body.trim() === '';
  // 본문이 비었을 때도 받는사람·제목 문제는 먼저 알린다
  const problem = replyProblem(empty ? { ...input, body: '-' } : input);
  // 자세한 이유(계정 없음 안내 등)는 회신 칸 위의 보내는 쪽 줄이 보인다 — 여기서는 같은 긴 문장을 되풀이하지 않는다
  if (!ctx.sender.ready) return fail(SENDER_NOT_READY, problem);
  if (state.draft.state === 'running') return fail('초안을 만드는 중에는 보낼 수 없습니다. 끝나거나 [중단]한 뒤 보내세요.', problem);
  if (state.pendingDraft) return fail('받은 초안으로 본문을 바꿀지 먼저 정해 주세요.', problem);
  if (problem) return fail('회신 입력의 문제를 고치면 보낼 수 있습니다.', problem);
  if (empty) return fail('본문을 적거나 [초안 만들기]로 초안을 받으면 보낼 수 있습니다.');
  return { ok: true, reason: null, problem: null };
}

/** 작성 칸 + 처리 결과 초안 → sendReply 입력 */
export function buildSendInput(state: ReplyState, task: Task, resultDraft: ResultDraft): SendReplyInput {
  const input = replyInput(state);
  return {
    sendId: state.sendId,
    taskId: task.id,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    quoteOriginal: state.quoteOriginal,
    save: buildSaveInput(task, resultDraft),
  };
}

// ── 초안 만들기 ──

/** 초안에 넘길 처리 내용(저장 입력과 같이 줄바꿈은 LF, 제어 문자는 떼고 앞뒤 공백을 걷는다) */
export function draftNote(note: string): string {
  return note
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

export function startDraftState(state: ReplyState, startedAt: number): ReplyState {
  return {
    ...state,
    pendingDraft: undefined,
    draft: { ...state.draft, state: 'running', message: undefined, startedAt },
  };
}

function normalizeDraft(raw: unknown): ReplyDraft {
  const d = isRecord(raw) ? raw : {};
  const body = typeof d.body === 'string' ? d.body.replace(/\r\n?/g, '\n') : '';
  return {
    body: Array.from(body).slice(0, REPLY_LIMITS.body).join(''),
    references: [...new Set(strings(d.references).map((r) => r.trim().replace(/\\/g, '/')))],
    notes: typeof d.notes === 'string' ? d.notes.trim() : '',
    durationMs: typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) ? Math.max(0, d.durationMs) : 0,
    ...(d.engine === 'local' || d.engine === 'claude' ? { engine: d.engine } : {}),
  };
}

function isCurrentRun(state: ReplyState, startedAt: number): boolean {
  return state.draft.state === 'running' && state.draft.startedAt === startedAt;
}

/**
 * 초안이 왔다. 지금 본문이 비었으면 바로 넣고, 아니면 바꿀지 확인을 기다린다(pendingDraft).
 * 그 사이 멈췄거나 되돌렸으면(실행 표식이 다르면) 버린다.
 */
export function receiveDraft(state: ReplyState, startedAt: number, raw: unknown): ReplyState {
  if (!isCurrentRun(state, startedAt)) return state;
  const draft = normalizeDraft(raw);
  if (draft.body.trim() === '') return failDraft(state, startedAt, '초안 본문이 비어 있습니다.');
  const status: ReplyDraftStatus = {
    state: 'done',
    references: draft.references,
    notes: draft.notes,
    durationMs: draft.durationMs,
    received: true,
    ...(draft.engine ? { engine: draft.engine } : {}),
  };
  if (state.body.trim() === '') return { ...state, body: draft.body, draft: status, pendingDraft: undefined };
  return { ...state, draft: status, pendingDraft: draft };
}

export function failDraft(state: ReplyState, startedAt: number, message: string): ReplyState {
  if (!isCurrentRun(state, startedAt)) return state;
  return { ...state, draft: { ...state.draft, state: 'failed', message, startedAt: undefined } };
}

/** [중단] — 늦게 오는 결과(또는 중단 오류)는 버린다 */
export function stopDraft(state: ReplyState): ReplyState {
  if (state.draft.state !== 'running') return state;
  return { ...state, draft: { ...state.draft, state: 'idle', message: '초안 만들기를 멈췄습니다.', startedAt: undefined } };
}

/** 확인을 기다리던 초안으로 본문을 바꾼다 */
export function acceptPendingDraft(state: ReplyState): ReplyState {
  if (!state.pendingDraft) return state;
  return { ...state, body: state.pendingDraft.body, pendingDraft: undefined, draft: { ...state.draft, message: undefined } };
}

/** 지금 본문을 그대로 둔다(받은 초안은 버리고, 참고 문서·확인할 점은 남긴다) */
export function rejectPendingDraft(state: ReplyState): ReplyState {
  if (!state.pendingDraft) return state;
  return {
    ...state,
    pendingDraft: undefined,
    draft: { ...state.draft, message: '초안을 받았지만 지금 본문을 그대로 두었습니다.' },
  };
}

/** 경과 시간 '0:35' · '1:05' · '12:00' */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 초안 진행·결과 문장. 실행 중의 경과 시간(timer)은 따로 준다 — 화면은 그것을 읽기 도구에 매초 읽히지 않게 둔다.
 */
export function draftStatus(state: ReplyState, nowMs: number): { text: string; timer?: string } {
  const d = state.draft;
  switch (d.state) {
    case 'running':
      return {
        text: 'Claude가 원본 메일과 위키를 읽는 중…',
        timer: formatTimer(d.startedAt !== undefined ? nowMs - d.startedAt : 0),
      };
    case 'failed':
      return { text: `초안을 만들지 못했습니다. (${d.message ?? '이유를 알 수 없습니다'})` };
    case 'done': {
      if (state.pendingDraft) return { text: '초안이 왔습니다. 지금 본문을 초안으로 바꿀지 정해 주세요.' };
      if (d.message) return { text: d.message };
      // 1초가 안 걸린 것(가짜 claude 등)은 '(0초)' 대신 걸린 시간을 빼고 말한다
      const took = d.durationMs && d.durationMs >= 1000 ? `(${formatElapsed(d.durationMs)})` : '';
      return { text: `초안을 받았습니다${took}. 사실·날짜를 확인하고 고친 뒤 보내세요.` };
    }
    default:
      return {
        text:
          d.message ??
          'Claude가 처리 내용·원본 메일·관련 위키를 읽고 본문 초안을 씁니다. 파일을 고치거나 메일을 보내지는 않습니다.',
      };
  }
}

// ── 표시 문구 ──

/** 주소 한 칸의 표시: 이름, 없으면 주소, 그것도 아니면 받은 글자(shared/reply.ts) */
export { recipientLabel };

/** '김담당, 이과장 외 2명' — 앞 max 명까지 이름으로 */
export function recipientsText(list: readonly string[], max = 3): string {
  const labels = list.map(recipientLabel).filter((s) => s !== '');
  if (labels.length === 0) return '(없음)';
  if (labels.length <= max) return labels.join(', ');
  return `${labels.slice(0, max).join(', ')} 외 ${labels.length - max}명`;
}

/**
 * 처리 내용에 붙는 발송 줄(명세 §4-2 ⑦). main 이 메모에 넣는 줄과 같은 함수(shared/reply.ts sentLine)다.
 * 보냈는데 저장이 실패했을 때 처리 내용에 붙여 두어, 다시 [저장]하면 메모에 남게 한다.
 */
export const sentLineText = sentLine;

/**
 * 처리 결과 초안의 처리 내용 끝에 발송 줄을 붙인다(이미 있으면 그대로). 붙인 줄은 sentLines 에도 적어 두어
 * 처리 내용 길이 검사(NOTE_MAX — 사람이 적는 몫)에서 뺀다 — 처리 내용이 한도 가까이 있어도 다시 [저장]할 수 있게.
 */
export function withSentLine(draft: ResultDraft, input: Pick<SendReplyInput, 'to' | 'cc' | 'subject'>): ResultDraft {
  const line = sentLineText(input.to, input.cc, input.subject);
  const sentLines = draft.sentLines?.includes(line) ? draft.sentLines : [...(draft.sentLines ?? []), line];
  if (draft.note.includes(line)) return sentLines === draft.sentLines ? draft : { ...draft, sentLines };
  const note = draft.note.trim() === '' ? line : `${draft.note.trimEnd()}\n${line}`;
  return { ...draft, note, sentLines };
}

/** 발송 시각 '9/28 14:02'(이 PC 시간대). 해가 today 와 다르면 '2025/9/28 14:02'. 알아볼 수 없으면 '' */
export function sentAtText(iso: unknown, today: string): string {
  if (typeof iso !== 'string' || iso.trim() === '') return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const year = d.getFullYear();
  const prefix = today.startsWith(`${year}-`) ? '' : `${year}/`;
  return `${prefix}${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 지난 발송 배지 '회신함 9/28 14:02 · 받는사람 김담당' */
export function lastSentText(record: SentMailRecord, today: string): string {
  const at = sentAtText(record.at, today);
  return `회신함${at ? ` ${at}` : ''} · 받는사람 ${recipientsText(record.to)}`;
}

/** 지난 발송 배지의 풀이(마우스를 올리면 보인다) */
export function lastSentDetail(record: SentMailRecord): string {
  const parts = [`제목: ${record.subject}`, `받는사람: ${record.to.join(', ')}`];
  if (record.cc.length > 0) parts.push(`참조: ${record.cc.join(', ')}`);
  return parts.join('\n');
}

/** 보내는 사람 표시 '홍길동 <me@x>'. 설정의 이름을 먼저 쓴다 */
export function senderText(ctx: ReplyContext, settings?: MailSettings): string {
  const address = textOf(ctx.sender.address);
  if (!address) return '';
  const name = settings ? settings.fromName : (ctx.sender.name ?? '');
  return formatAddress(name, address);
}

/** 나에게 숨은참조가 켜졌는가(설정을 읽었으면 그것, 아니면 문맥의 값) */
export function bccSelfOn(ctx: ReplyContext | undefined, settings?: MailSettings): boolean {
  if (settings) return settings.bccSelf;
  return ctx?.sender.bccSelf !== false;
}

/** 접이식 '보내는 사람·서명' 머리의 요약 */
export function settingsSummary(s: MailSettings): string {
  const parts = [s.fromName.trim() ? `이름 ${s.fromName.trim()}` : '이름 없음(주소만)'];
  const sig = s.signature.trim();
  parts.push(sig ? `서명 ${sig.split('\n').length}줄` : '서명 없음');
  if (s.bccSelf) parts.push('나에게 숨은참조');
  return parts.join(' · ');
}

// ── 확인 대화상자 ──

export interface ReplyConfirmSummary {
  /** 보내는 사람('이름 <주소>') */
  from: string;
  to: string[];
  cc: string[];
  /** 숨은참조(나에게 숨은참조) */
  bcc: string[];
  subject: string;
  /** 본문 앞 6줄 */
  preview: string[];
  /** 앞 6줄 뒤에 더 있는 줄 수 */
  moreLines: number;
  /** 본문 뒤에 붙는 것(서명·원문 인용) */
  appended: string[];
  /** 보낸 뒤 일어나는 일 */
  after: string[];
  /** 피싱 의심 신호(비어 있지 않으면 굵은 경고를 넣는다) */
  suspicious: string[];
}

/** 본문 앞 n줄(앞쪽 빈 줄은 건너뛴다)과 나머지 줄 수 */
export function previewLines(body: string, n = PREVIEW_LINES): { lines: string[]; more: number } {
  const all = body.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  while (all.length > 0 && all[0].trim() === '') all.shift();
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** 보낸 뒤 할 일에 일어나는 일(확인 대화상자) */
export function afterSendLines(task: Task, save: SaveResultInput): string[] {
  const label = statusLabel(save.status);
  const lines: string[] = [];
  if (save.status !== task.status) lines.push(`할 일을 ‘${label}’${josaRo(label)} 저장합니다.`);
  else lines.push(`할 일 상태는 ‘${label}’ 그대로 둡니다.`);
  if (save.status === 'notmine') lines.push(`넘길 담당: ${save.owner ?? DEFAULT_OWNER}`);
  lines.push(save.note ? '처리 내용과 발송 줄을 ‘할 일 메모’에 남깁니다.' : '발송 줄(받는사람·제목)을 ‘할 일 메모’에 남깁니다.');
  if (save.reflect) lines.push('반영 대기열에 넣습니다(보낸 본문 포함).');
  if (leavesList(save.status)) lines.push('목록에서 빠지고 다음 할 일로 넘어갑니다.');
  return lines;
}

export function confirmSummary(args: {
  task: Task;
  state: ReplyState;
  ctx: ReplyContext;
  settings?: MailSettings;
  save: SaveResultInput;
}): ReplyConfirmSummary {
  const { task, save } = args;
  return baseConfirmSummary(args, afterSendLines(task, save));
}

/** 메일함 회신(2.10단계 §7-1)의 '보낸 뒤' — 위키는 쓰지 않는다 */
export function afterMailSendLines(archiveAfter: boolean, linkedTasks: number): string[] {
  const lines = ['이 메일의 「회신 필요」 표시를 지웁니다.'];
  lines.push(archiveAfter ? '이 스레드를 처리함으로 옮깁니다.' : '스레드는 받은편지함에 그대로 둡니다.');
  lines.push(
    linkedTasks > 0
      ? '연결된 할 일은 그대로입니다 — 끝났으면 할 일에서 완료로 저장하세요.'
      : '위키에는 아무것도 쓰지 않습니다(발송 기록만 앱 데이터에 남깁니다).',
  );
  return lines;
}

/** 메일함 회신 확인 대화상자 요약 */
export function mailConfirmSummary(args: {
  state: ReplyState;
  ctx: ReplyContext;
  settings?: MailSettings;
  archiveAfter: boolean;
  linkedTasks: number;
}): ReplyConfirmSummary {
  return baseConfirmSummary(args, afterMailSendLines(args.archiveAfter, args.linkedTasks));
}

/** 작성 칸 → 메일함 sendMailReply 입력(처리 결과 저장 없음) */
export function buildMailSendInput(state: ReplyState, path: string, archiveAfter: boolean): SendMailReplyInput {
  const input = replyInput(state);
  return {
    sendId: state.sendId,
    path,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    quoteOriginal: state.quoteOriginal,
    archiveAfter,
  };
}

/** 메일함 회신 결과 알림 */
export function summarizeMailSend(input: SendMailReplyInput, out: SendMailReplyOutput, id: number): SaveNotice {
  const sent = isRecord(out?.sent) ? out.sent : undefined;
  const to = strings(sent?.to).length > 0 ? strings(sent?.to) : input.to;
  const cc = Array.isArray(sent?.cc) ? strings(sent?.cc) : input.cc;
  const bcc = strings(sent?.bcc);
  const subject = textOf(sent?.subject) ?? input.subject;
  const lines: NoticeLine[] = [{ text: `제목: ${subject}` }];
  if (cc.length > 0) lines.push({ text: `참조: ${recipientsText(cc)}` });
  if (bcc.length > 0) lines.push({ text: `숨은참조: ${recipientsText(bcc)}` });
  lines.push({ text: input.archiveAfter ? '회신 필요 표시를 지우고 스레드를 처리함으로 옮겼습니다.' : '회신 필요 표시를 지웠습니다.' });
  lines.push({ text: '위키에는 쓰지 않았습니다. 연결된 할 일이 있으면 할 일에서 완료로 저장하세요.' });
  for (const w of strings(out?.warnings)) lines.push({ text: w, warn: true });
  return {
    id,
    tone: lines.some((l) => l.warn) ? 'warn' : 'ok',
    title: `회신을 보냈습니다 — 받는사람 ${recipientsText(to)}`,
    lines,
  };
}

/** 메일함 회신 실패 */
export function mailSendFailure(message: string, id: number): SaveNotice {
  return {
    id,
    tone: 'error',
    title: '회신을 보내지 못했습니다.',
    lines: [
      { text: message, warn: true },
      { text: '적은 회신은 그대로 남아 있습니다. 확인한 뒤 다시 보내 주세요.' },
    ],
  };
}

function baseConfirmSummary(
  args: { state: ReplyState; ctx: ReplyContext; settings?: MailSettings },
  after: string[],
): ReplyConfirmSummary {
  const { state, ctx, settings } = args;
  const input = replyInput(state);
  const { lines, more } = previewLines(input.body);
  // main 은 계정 아이디가 메일 주소일 때만 나에게 숨은참조를 넣는다(sendReply.ts) — 같은 기준으로 보여준다
  const address = textOf(ctx.sender.address);
  const selfAddress = address ? addressOf(address) : null;
  const appended: string[] = [];
  if (settings && settings.signature.trim() !== '') appended.push('서명');
  if (state.quoteOriginal) appended.push('원문 인용');
  return {
    from: senderText(ctx, settings) || '(보내는 주소 없음)',
    to: input.to,
    cc: input.cc,
    bcc: selfAddress && bccSelfOn(ctx, settings) ? [selfAddress] : [],
    subject: input.subject,
    preview: lines,
    moreLines: more,
    appended,
    after,
    suspicious: [...ctx.suspicious],
  };
}

// ── 발송 결과 알림(2단계 save-notice 를 그대로 쓴다) ──

/**
 * 발송 결과 → 알림.
 * - 보내고 저장함: ok(경고가 있으면 warn) — '‘…’ 회신을 보냈습니다 — 받는사람 … · 완료로 저장했습니다' + 저장 알림 줄들
 * - 보냈지만 저장 실패: warn — '메일은 보냈습니다. 위키 기록은 실패 — 같은 상태로 다시 [저장]하세요'
 */
export function summarizeSend(task: Task, input: SendReplyInput, out: SendReplyOutput, id: number): SaveNotice {
  const title = taskTitle(task);
  const sent = isRecord(out?.sent) ? out.sent : undefined;
  const to = strings(sent?.to).length > 0 ? strings(sent?.to) : input.to;
  const cc = Array.isArray(sent?.cc) ? strings(sent?.cc) : input.cc;
  const bcc = strings(sent?.bcc);
  const subject = textOf(sent?.subject) ?? input.subject;
  const rcpt = recipientsText(to);
  const warnings: NoticeLine[] = strings(out?.warnings).map((text) => ({ text, warn: true }));

  const head: NoticeLine[] = [{ text: `제목: ${subject}` }];
  if (cc.length > 0) head.push({ text: `참조: ${recipientsText(cc)}` });
  if (bcc.length > 0) head.push({ text: `숨은참조: ${recipientsText(bcc)}` });

  const saveError = textOf(out?.saveError);
  if (saveError || !isRecord(out?.save)) {
    return {
      id,
      tone: 'warn',
      title: '메일은 보냈습니다. 위키 기록은 실패 — 같은 상태로 다시 [저장]하세요',
      lines: [
        { text: `‘${title}’ 회신 — 받는사람 ${rcpt}` },
        ...head,
        { text: saveError ?? '처리 결과를 저장했는지 확인하지 못했습니다.', warn: true },
        {
          text: isPartialSave(saveError ?? '')
            ? '위키에 일부만 저장했습니다. 회신 칸은 닫았고 발송 줄은 처리 내용에 붙여 두었습니다 — 다시 [저장]하면 이어서 반영됩니다(메일은 다시 보내지 않습니다).'
            : '회신 칸은 닫았고 발송 줄은 처리 내용에 붙여 두었습니다. 다시 [저장]해도 메일은 다시 보내지 않습니다.',
        },
        ...warnings,
      ],
    };
  }

  // 저장 알림 줄을 그대로 쓰되 메모 줄은 발송 줄을 넣어 다시 말한다(처리 내용이 없어도 발송 줄은 메모에 남는다)
  const saved = summarizeSave(task, { ...input.save, note: undefined }, out.save, id);
  const memo: NoticeLine =
    out.save.memo === true
      ? { text: input.save.note ? '처리 내용과 발송 줄을 ‘할 일 메모’에 남겼습니다.' : '발송 줄을 ‘할 일 메모’에 남겼습니다.' }
      : { text: '같은 메모가 이미 있어 메모는 다시 쓰지 않았습니다.' };
  const lines: NoticeLine[] = [
    ...head,
    ...saved.lines.filter((l) => !l.warn),
    memo,
    ...saved.lines.filter((l) => l.warn),
    ...warnings,
  ];
  const label = statusLabel(input.save.status);
  return {
    id,
    tone: lines.some((l) => l.warn) ? 'warn' : 'ok',
    title: `‘${title}’ 회신을 보냈습니다 — 받는사람 ${rcpt} · ${label}${josaRo(label)} 저장했습니다`,
    lines,
  };
}

/** 발송 실패(error) — 위키는 그대로이고 입력은 남아 있다 */
export function sendFailure(task: Task, message: string, id: number): SaveNotice {
  return {
    id,
    tone: 'error',
    title: `‘${taskTitle(task)}’ 회신을 보내지 못했습니다.`,
    lines: [
      { text: message, warn: true },
      { text: '위키는 그대로이고 입력한 회신도 남아 있습니다. 확인한 뒤 다시 보내 주세요.' },
    ],
  };
}

// ── main 응답 다듬기 ──

function normalizeSent(raw: unknown): SentMailRecord | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'string') return undefined;
  return {
    id: raw.id,
    at: raw.at,
    taskId: textOf(raw.taskId) ?? '',
    taskTitle: textOf(raw.taskTitle) ?? '',
    mail: textOf(raw.mail) ?? '',
    to: strings(raw.to),
    cc: strings(raw.cc),
    bcc: strings(raw.bcc),
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    messageId: textOf(raw.messageId) ?? '',
    ...(textOf(raw.response) ? { response: textOf(raw.response) } : {}),
    ...(textOf(raw.eml) ? { eml: textOf(raw.eml) } : {}),
  };
}

/** 회신 문맥 응답 → ReplyContext. 없거나(null) 모양이 틀리면 null */
export function normalizeReplyContext(raw: unknown): ReplyContext | null {
  if (!isRecord(raw)) return null;
  const original = isRecord(raw.original) ? raw.original : {};
  const sender = isRecord(raw.sender) ? raw.sender : {};
  const ctx: ReplyContext = {
    taskId: textOf(raw.taskId) ?? '',
    mail: textOf(raw.mail) ?? '',
    original: {
      subject: typeof original.subject === 'string' ? original.subject : '',
      from: typeof original.from === 'string' ? original.from : '',
      to: strings(original.to),
      cc: strings(original.cc),
    },
    to: strings(raw.to),
    ccAll: strings(raw.ccAll),
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    quote: typeof raw.quote === 'string' ? raw.quote : '',
    suspicious: strings(raw.suspicious),
    sender: {
      ready: sender.ready === true,
      bccSelf: sender.bccSelf !== false,
    },
  };
  const date = textOf(original.date);
  if (date) ctx.original.date = date;
  const messageId = textOf(original.messageId);
  if (messageId) ctx.original.messageId = messageId;
  for (const key of ['address', 'name', 'problem', 'notice'] as const) {
    const v = textOf(sender[key]);
    if (v) ctx.sender[key] = v;
  }
  const last = normalizeSent(raw.lastSent);
  if (last) ctx.lastSent = last;
  return ctx;
}

export function normalizeMailSettings(raw: unknown): MailSettings {
  const s = isRecord(raw) ? raw : {};
  return {
    fromName: typeof s.fromName === 'string' ? s.fromName : '',
    signature: typeof s.signature === 'string' ? s.signature : '',
    bccSelf: s.bccSelf !== false,
  };
}
