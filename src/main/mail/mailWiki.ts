// 메일 → 위키 지식화(docs/stage2.14-contract.md §2·§3·§5). electron 을 import 하지 않는다.
//
// - 넣기(queueMailForWiki): 메일함 읽기 칸 [위키에 반영] → 반영 대기열(queue.json)에 kind mail 항목 하나. 본문은 대기열에 두지 않는다.
// - 실행(resolveMailItems): [위키에 반영] 실행 직전에 메일 키로 메일을 다시 찾아 본문을 <mails> 블록 재료로 만든다.
//   못 찾았거나 그사이 피싱 의심이 된 메일·분량이 넘치는 항목은 이번 반영에서 빼고 대기열에 남긴다(held).
// - 앱은 위키 문서를 쓰지 않는다. 메일(raw/)은 읽기만 한다. 오류·진행 문장에 메일 본문을 넣지 않는다(제목까지).
// - 대기열 항목은 경로가 아니라 메일 키로 메일을 찾는다(§3-3) — 메일이 위키 밖(앱 데이터)으로 옮겨 가도 항목은 그대로 쓴다.
import type { MailIndexEntry, MailKey, MailMessage, MailboxSummary, QueueItem, QueueMailInput, QueueMailResult } from '../../shared/types';
import { stripSubjectPrefix } from '../../shared/mailThread';
import { QUEUE_MAIL_LIMITS, type NewQueueItem, type QueueStore } from '../queue';
import type { MailReflectBlock, MailReflectMail } from '../reflect';
import { DRAFT_MAIL_BODY_LIMIT } from '../replyDraft';
import type { MailWikiPending } from './mailbox';

/** 길이 한도(§3-5) */
export const MAIL_REFLECT_LIMITS = {
  /** 메일 한 통 본문(회신 초안과 같다) */
  body: DRAFT_MAIL_BODY_LIMIT,
  /** 스레드 범위의 최근 메일 수 */
  threadMails: 20,
  /** 항목 하나 본문 합 */
  itemBody: 40_000,
  /** 실행 한 번 메일 본문 합 */
  runBody: 120_000,
  /** 메일 한 통 첨부 이름 수 */
  attachments: 30,
  /** 첨부 이름 길이 */
  attachmentName: 200,
} as const;

const TRUNCATED_MARK = '\n…(이하 생략)';
/** 제어 문자와 줄 구분자(U+2028·U+2029) */
const CONTROL_OR_LINE_SEP_RE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]', 'g');

export const MAIL_WIKI_PROBLEMS = {
  indexing: '메일함을 읽는 중입니다 — 끝난 뒤 다시 누르세요',
  notFound: '메일을 찾을 수 없습니다 — 메일함을 새로 읽은 뒤 다시 하세요',
  suspicious: '피싱 의심 메일은 위키에 반영할 수 없습니다',
  suspiciousThread: '스레드에 피싱 의심 메일이 있어 스레드 전체는 넣을 수 없습니다 — 이 메일만 넣으세요',
  noClaude: 'claude 가 없어 지금은 반영할 수 없습니다 — 대기열에는 넣었습니다',
  running: '이 메일은 지금 위키에 반영하는 중입니다 — 끝난 뒤 다시 하세요',
} as const;

/** 실행 때 빠지는 이유(§3-1·§3-4) — 화면 blocked·진행 기록에 쓴다 */
export const MAIL_HELD_REASONS = {
  noMailbox: '메일함을 쓸 수 없음',
  notFound: '메일을 찾을 수 없음',
  suspicious: '피싱 의심으로 바뀜',
  tooLarge: '분량이 커서 다음 반영으로',
} as const;

/** 이 모듈이 쓰는 메일함 기능(MailboxService 의 일부 — 시험에서 바꿔 끼울 수 있게) */
export interface MailWikiMailbox {
  summary(): MailboxSummary;
  entryOfKey(key: MailKey): MailIndexEntry | undefined;
  entryOfPath(rel: string): MailIndexEntry | undefined;
  threadMailsOf(key: MailKey): MailIndexEntry[];
  coveredKeysOf(key: MailKey, scope: 'mail' | 'thread'): MailKey[];
  message(rel: string): MailMessage | null;
}

export interface QueueMailDeps {
  mailbox: MailWikiMailbox;
  queue: QueueStore;
  /** claude 실행 파일이 있는가(없어도 넣기는 막지 않는다 — 경고만) */
  claudeAvailable?: () => boolean;
  /** 지금 반영 실행에 들어간 대기열 항목 id — 겹치면 넣지도 바꾸지도 않는다 */
  runningIds?: () => ReadonlySet<string>;
  now?: () => Date;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** 대기열 항목 제목: RE:/FW: 접두를 걷은 메일 제목(제어 문자는 공백으로, 1~200자) */
export function mailWikiTitle(subject: string): string {
  const s = stripSubjectPrefix(subject)
    .replace(CONTROL_OR_LINE_SEP_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(s, QUEUE_MAIL_LIMITS.title).trim() || '(제목 없음)';
}

/** 메일함을 쓸 수 있는가 — 쓸 수 없으면 사람이 읽는 이유 */
function mailboxProblem(summary: MailboxSummary): string | null {
  if (summary.state === 'ready' || summary.state === 'error') return null;
  if (summary.state === 'indexing') return MAIL_WIKI_PROBLEMS.indexing;
  return summary.problem ?? MAIL_WIKI_PROBLEMS.indexing;
}

/** 범위의 메일(색인 기준, 날짜순) */
function rangeOf(mailbox: MailWikiMailbox, entry: MailIndexEntry, scope: 'mail' | 'thread'): MailIndexEntry[] {
  if (scope === 'mail') return [entry];
  const thread = mailbox.threadMailsOf(entry.key);
  return thread.length > 0 ? thread : [entry];
}

/** 대기열의 mail 항목 중 이 키 집합과 겹치는 것(§5 — 덮는 키는 지금 색인 기준) */
export function overlappingMailItems(items: readonly QueueItem[], keys: ReadonlySet<MailKey>, mailbox: MailWikiMailbox): QueueItem[] {
  return items.filter(
    (x) => x.kind === 'mail' && x.mailKey !== undefined && mailbox.coveredKeysOf(x.mailKey, x.scope ?? 'mail').some((k) => keys.has(k)),
  );
}

/**
 * 넣기(§2). 입력은 requireQueueMailInput 이 검사한 것. 저장 큐(serialSave) 안에서 부른다.
 * 거부는 던진다(사람이 읽는 문장 — 본문 없음). 겹치는 대기 항목이 있고 replace 가 없으면 duplicate.
 */
export function queueMailForWiki(input: QueueMailInput, deps: QueueMailDeps): QueueMailResult {
  const { mailbox, queue } = deps;
  const problem = mailboxProblem(mailbox.summary());
  if (problem) throw new Error(problem);
  const entry = mailbox.entryOfKey(input.key);
  if (!entry) throw new Error(MAIL_WIKI_PROBLEMS.notFound);
  const range = rangeOf(mailbox, entry, input.scope);
  if (range.some((e) => e.suspicious)) {
    throw new Error(input.scope === 'thread' && !entry.suspicious ? MAIL_WIKI_PROBLEMS.suspiciousThread : MAIL_WIKI_PROBLEMS.suspicious);
  }

  const keys = new Set(range.map((e) => e.key));
  const overlaps = overlappingMailItems(queue.list(), keys, mailbox);
  const running = deps.runningIds?.() ?? new Set<string>();
  if (overlaps.some((x) => running.has(x.id))) throw new Error(MAIL_WIKI_PROBLEMS.running);
  if (overlaps.length > 0 && input.replace !== true) return { status: 'duplicate', existing: overlaps[0] };

  const note = input.note.replace(/\r\n?/g, '\n').trim();
  const hint = (input.hint ?? '').trim();
  const item: NewQueueItem = {
    kind: 'mail',
    title: mailWikiTitle(entry.subject),
    note,
    mail: entry.path,
    mailKey: entry.key,
    scope: input.scope,
    ...(deps.now ? { createdAt: deps.now().toISOString() } : {}),
  };
  if (hint) item.hint = hint;
  const from = cut(entry.from ?? '', QUEUE_MAIL_LIMITS.from).trim();
  if (from) item.from = from;
  if (entry.date && entry.date.length <= QUEUE_MAIL_LIMITS.mailDate && !Number.isNaN(Date.parse(entry.date))) item.mailDate = entry.date;
  const added = queue.add(item, { replaceIds: overlaps.map((x) => x.id) });
  const warnings: string[] = [];
  let claude = true;
  try {
    claude = deps.claudeAvailable ? deps.claudeAvailable() : true;
  } catch {
    claude = false;
  }
  if (!claude) warnings.push(MAIL_WIKI_PROBLEMS.noClaude);
  return { status: 'queued', item: added, warnings };
}

/**
 * 키로 메일 찾기(§3-3): ① 키로 → 지금 경로 ② 항목의 mail 경로가 지금 색인에 있고 그 키가 같거나 항목 키가 경로 키(p:)면 그 경로
 * ③ 없으면 undefined(보류).
 */
export function findMailEntry(item: Pick<QueueItem, 'mailKey' | 'mail'>, mailbox: Pick<MailWikiMailbox, 'entryOfKey' | 'entryOfPath'>): MailIndexEntry | undefined {
  if (!item.mailKey) return undefined;
  const byKey = mailbox.entryOfKey(item.mailKey);
  if (byKey) return byKey;
  if (item.mail) {
    const byPath = mailbox.entryOfPath(item.mail);
    if (byPath && (byPath.key === item.mailKey || item.mailKey.startsWith('p:'))) return byPath;
  }
  return undefined;
}

/** 화면용 blocked(§3-4) — 파일은 읽지 않고 색인만 본다. 보낼 수 있으면 undefined */
export function blockedOf(item: QueueItem, mailbox: MailWikiMailbox | null | undefined): string | undefined {
  if (item.kind !== 'mail') return undefined;
  if (!mailbox) return MAIL_HELD_REASONS.noMailbox;
  const entry = findMailEntry(item, mailbox);
  if (!entry) {
    // 메일함을 아직 읽는 중이면 막힘으로 보이지 않는다(실행 때 다시 본다)
    return mailbox.summary().state === 'indexing' ? undefined : MAIL_HELD_REASONS.notFound;
  }
  if (rangeOf(mailbox, entry, item.scope ?? 'mail').some((e) => e.suspicious)) return MAIL_HELD_REASONS.suspicious;
  return undefined;
}

/** getQueue·onQueue 로 보낼 목록: mail 항목에 blocked 를 붙인다(저장하지 않는다) */
export function withBlocked(items: readonly QueueItem[], mailbox: MailWikiMailbox | null | undefined): QueueItem[] {
  return items.map((item) => {
    const copy: QueueItem = { ...item };
    delete copy.blocked;
    const blocked = blockedOf(item, mailbox);
    if (blocked) copy.blocked = blocked;
    return copy;
  });
}

/** 메일함 「위키 반영 대기」 표시 재료(§7-2) */
export function wikiPendingOf(items: readonly QueueItem[], runningIds: ReadonlySet<string>): MailWikiPending[] {
  const out: MailWikiPending[] = [];
  for (const x of items) {
    if (x.kind !== 'mail' || !x.mailKey) continue;
    out.push({ mailKey: x.mailKey, scope: x.scope ?? 'mail', createdAt: x.createdAt, running: runningIds.has(x.id) });
  }
  return out;
}

export interface HeldItem {
  id: string;
  title: string;
  reason: string;
}

export interface ResolvedMailItems {
  /** 이번 실행에 보낼 항목(대기열 순서) */
  send: QueueItem[];
  /** 보낼 mail 항목의 메일 내용 */
  mails: MailReflectBlock[];
  /** 이번엔 빼고 대기열에 남기는 mail 항목 */
  held: HeldItem[];
}

/** 메일 한 통 → 블록 원소. 첨부는 이름(과 크기)만 */
function reflectMail(entry: MailIndexEntry, msg: MailMessage): MailReflectMail {
  const body = typeof msg.body === 'string' ? msg.body : '';
  const out: MailReflectMail = {
    key: entry.key,
    path: entry.path,
    subject: msg.subject || entry.subject,
    from: msg.from || entry.from,
    to: [...(msg.to ?? entry.to)],
    ccCount: Array.isArray(msg.cc) ? msg.cc.length : entry.ccCount,
    folder: msg.folder || entry.folder,
    attachments: [],
    body,
  };
  const date = msg.date ?? entry.date;
  if (date) out.date = date;
  if (entry.mine) out.mine = true;
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  out.attachments = atts.slice(0, MAIL_REFLECT_LIMITS.attachments).map((a) => {
    const att: { name: string; size?: number } = { name: cut(String(a.name ?? ''), MAIL_REFLECT_LIMITS.attachmentName) };
    if (typeof a.size === 'number' && Number.isFinite(a.size)) att.size = a.size;
    return att;
  });
  if (atts.length > MAIL_REFLECT_LIMITS.attachments) out.attachmentsOmitted = atts.length - MAIL_REFLECT_LIMITS.attachments;
  if (body.length > MAIL_REFLECT_LIMITS.body) {
    out.body = cut(body, MAIL_REFLECT_LIMITS.body) + TRUNCATED_MARK;
    out.bodyTruncated = true;
  }
  return out;
}

function bodyTotal(mails: readonly MailReflectMail[]): number {
  return mails.reduce((n, m) => n + m.body.length, 0);
}

/** 항목 하나 40,000자(§3-5): 오래된 메일부터 본문을 비운다. 가장 최근 메일 본문은 늘 남긴다 */
function fitItemBudget(mails: MailReflectMail[]): void {
  for (let i = 0; i < mails.length - 1 && bodyTotal(mails) > MAIL_REFLECT_LIMITS.itemBody; i++) {
    if (mails[i].body === '') continue;
    mails[i].body = '';
    mails[i].bodyOmitted = true;
    delete mails[i].bodyTruncated;
  }
}

/** mail 항목 하나 → 블록(못 쓰면 보류 이유) */
function resolveOne(item: QueueItem, mailbox: MailWikiMailbox): { block: MailReflectBlock } | { reason: string } {
  const entry = findMailEntry(item, mailbox);
  if (!entry) return { reason: MAIL_HELD_REASONS.notFound };
  const scope = item.scope ?? 'mail';
  const range = rangeOf(mailbox, entry, scope);
  if (range.some((e) => e.suspicious)) return { reason: MAIL_HELD_REASONS.suspicious };
  const omitted = Math.max(0, range.length - MAIL_REFLECT_LIMITS.threadMails);
  const recent = range.slice(omitted);
  const mails: MailReflectMail[] = [];
  let missing = 0;
  for (const e of recent) {
    let msg: MailMessage | null;
    try {
      msg = mailbox.message(e.path);
    } catch {
      msg = null;
    }
    if (!msg) {
      missing++;
      continue;
    }
    // 읽은 뒤 다시 본다(그사이 격리됐을 수 있다)
    if (msg.suspicious) return { reason: MAIL_HELD_REASONS.suspicious };
    mails.push(reflectMail(e, msg));
  }
  // 고른 메일(scope mail) 자체를 읽지 못했거나 스레드에서 한 통도 못 읽으면 보류
  if (mails.length === 0 || (scope === 'mail' && missing > 0)) return { reason: MAIL_HELD_REASONS.notFound };
  fitItemBudget(mails);
  const block: MailReflectBlock = { ref: item.id, scope, mails };
  if (omitted > 0) block.omittedMails = omitted;
  return { block };
}

/**
 * 실행 직전(§3-1): 대기열 순서대로 보낼 항목과 메일 블록을 고른다. mail 이 아닌 항목은 그대로 보낸다.
 * 실행 한 번 120,000자를 넘기는 mail 항목은 이번엔 보내지 않는다(첫 mail 항목은 넘어도 보낸다).
 * 메일함 색인을 기다리지 않는다(지금 색인으로 찾는다). 못 찾으면 보류일 뿐 지우지 않는다.
 */
export function resolveMailItems(items: readonly QueueItem[], mailbox: MailWikiMailbox | null | undefined): ResolvedMailItems {
  const send: QueueItem[] = [];
  const mails: MailReflectBlock[] = [];
  const held: HeldItem[] = [];
  let used = 0;
  for (const item of items) {
    if (item.kind !== 'mail') {
      send.push(item);
      continue;
    }
    if (!mailbox) {
      held.push({ id: item.id, title: item.title, reason: MAIL_HELD_REASONS.noMailbox });
      continue;
    }
    const r = resolveOne(item, mailbox);
    if ('reason' in r) {
      held.push({ id: item.id, title: item.title, reason: r.reason });
      continue;
    }
    const size = bodyTotal(r.block.mails);
    if (mails.length > 0 && used + size > MAIL_REFLECT_LIMITS.runBody) {
      held.push({ id: item.id, title: item.title, reason: MAIL_HELD_REASONS.tooLarge });
      continue;
    }
    used += size;
    send.push(item);
    mails.push(r.block);
  }
  return { send, mails, held };
}

/** 진행 기록 한 줄(본문 없음 — 제목까지) */
export function heldLogLine(h: HeldItem): string {
  return `이번 반영에서 뺌(${h.reason}): ${h.title}`;
}

/** 보낼 항목이 없을 때 거부 문장(§3-1) */
export function nothingToSendMessage(held: readonly HeldItem[]): string {
  const counts = new Map<string, number>();
  for (const h of held) counts.set(h.reason, (counts.get(h.reason) ?? 0) + 1);
  const parts = [...counts].map(([reason, n]) => `${reason} ${n}건`);
  return `보낼 수 있는 항목이 없습니다${parts.length > 0 ? ` — ${parts.join(' · ')}` : ''}`;
}
