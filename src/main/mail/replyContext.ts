// 회신 문맥 — 원본 메일(raw/mail/…md)에서 받는사람·참조·제목·인용문 기본값을 만든다(docs/stage2.5-contract.md §1).
// electron 을 import 하지 않는 순수 모듈이다. 메일 본문은 데이터일 뿐이며 해석·실행하지 않는다.
import type { ReplyContext, ReplySender, SentMailRecord } from '../../shared/types';
import { addressOf, displayNameOf, formatAddress, replySubject, sameAddress, splitAddressList } from '../../shared/reply';
import { splitFrontmatter } from '../wiki/frontmatter';
import { splitLines, stripBom } from '../wiki/fsutil';
import { cleanMessageId, mailBodyLines, mailListField as listField, mailTextField as textField, readMailText } from '../wiki/mail';

/** 인용문에 넣는 원본 본문 한도(글자 수) */
export const QUOTE_BODY_MAX = 20_000;
const QUOTE_TRUNCATED = '…(이하 생략)';

/** 원본 메일 한 통(수집기 write_message 형식)에서 회신에 쓰는 것 */
export interface ReplySource {
  /** 메일 기준 폴더가 위키가 아니면(2.15 메일 보관소) 그 절대경로 — 초안이 claude 에 읽기를 허락한다 */
  base?: string;
  /** 볼트 기준 상대경로 */
  rel: string;
  subject: string;
  /** '이름 <주소>' 또는 '주소' (수집기가 적은 그대로) */
  from: string;
  to: string[];
  cc: string[];
  /** frontmatter date 그대로(보통 ISO) */
  date?: string;
  /** 꺾쇠 없는 Message-ID */
  messageId?: string;
  replyTo?: string;
  /** 피싱 의심 신호 */
  suspicion: string[];
  /** 본문(평문, 앞뒤 빈 줄 없음) */
  body: string;
}

/** 메일 파일 원문 → 회신 재료. 파일이 수집기 형식이 아니어도 가능한 만큼 채운다 */
export function parseReplySource(rel: string, text: string): ReplySource {
  const lines = splitLines(stripBom(text ?? ''));
  const fm = splitFrontmatter(lines);
  const data = fm.data ?? {};

  let subject = textField(data.subject);
  if (subject === undefined) {
    // frontmatter 에 제목이 없으면 첫 H1
    const h1 = fm.bodyLines.find((l) => /^#\s+\S/.test(l));
    subject = h1 ? h1.replace(/^#\s+/, '').trim() : '';
  }

  const source: ReplySource = {
    rel,
    subject,
    from: textField(data.from) ?? '',
    to: listField(data.to, splitAddressList),
    cc: listField(data.cc, splitAddressList),
    suspicion: listField(data.suspicion, (s) => (s.trim() ? [s.trim()] : [])),
    body: mailBodyLines(fm.bodyLines).join('\n'),
  };
  const date = textField(data.date);
  if (date) source.date = date;
  const messageId = cleanMessageId(data.message_id);
  if (messageId) source.messageId = messageId;
  const replyTo = textField(data.reply_to);
  if (replyTo) source.replyTo = replyTo;
  return source;
}

/** 볼트 기준 상대경로의 원본 메일을 읽는다. 경로 검사는 readMailSummary 와 같다. 못 읽으면 null */
export function readReplySource(wikiRoot: string, rel: string): ReplySource | null {
  const mail = readMailText(wikiRoot, rel);
  return mail ? parseReplySource(mail.rel, mail.text) : null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 로컬 시각 'YYYY-MM-DD HH:mm'. 날짜로 읽히지 않으면 null */
function localStamp(date: string | undefined): string | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 수집기(mailhost_mail.py defang)가 무력화해 저장한 URL. 원래 `https://docs.google.com/x` 가
 * `` `https[:]//docs[.]google[.]com/x` `` 로 저장된다(백틱으로 감싸고 첫 :// → [:]//, 모든 . → [.]).
 * 원래 URL 에는 공백·괄호·대괄호·따옴표가 없으므로(수집기 _URL_RE) 백틱 안의 [.]·[:] 는 모두 수집기가 넣은 것이다.
 */
const DEFANGED_URL_RE = /`(https?)\[:\]\/\/([^`\s]*)`/gi;

/** 수집기의 defang 을 되돌린다: 백틱을 벗기고 [:]// → ://, [.] → . (백틱으로 감싼 http(s) 토큰만) */
export function refangUrls(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text.includes('[:]//')) return text;
  return text.replace(DEFANGED_URL_RE, (_m, scheme: string, rest: string) => `${scheme}://${rest.replace(/\[\.\]/g, '.')}`);
}

/**
 * 원문 인용 블록(-----Original Message----- …). 본문은 줄마다 그대로, 20,000자에서 자른다.
 * 단 수집기가 무력화한 URL 은 되돌린다(받는 사람이 자기가 보낸 링크를 깨진 채 돌려받지 않게, 명세 §9-2).
 * 피싱 의심 메일(suspicion 이 있음)은 되돌리지 않는다 — 의심스러운 링크를 살려 참조한 사람들에게 퍼뜨리지 않게.
 */
export function formatQuote(source: ReplySource): string {
  const head = ['-----Original Message-----', `From: ${source.from}`];
  const sent = localStamp(source.date);
  if (sent) head.push(`Sent: ${sent}`);
  head.push(`To: ${source.to.join(', ')}`);
  if (source.cc.length > 0) head.push(`Cc: ${source.cc.join(', ')}`);
  head.push(`Subject: ${source.subject}`);

  const text = source.suspicion.length > 0 ? source.body : refangUrls(source.body);
  const chars = Array.from(text);
  const body = chars.length > QUOTE_BODY_MAX ? `${chars.slice(0, QUOTE_BODY_MAX).join('')}\n${QUOTE_TRUNCATED}` : text;
  return `${head.map((l) => l.trimEnd()).join('\n')}\n\n${body}`;
}

/** 주소 항목을 '이름 <주소>' 꼴로 다시 적는다. 주소 형식이 틀리면 null */
function normalizeAddress(item: string): string | null {
  const addr = addressOf(item);
  return addr === null ? null : formatAddress(displayNameOf(item), addr);
}

/** 맞는 주소만 정규화하고 exclude 에 걸리거나 앞에 나온 것(대소문자 무시)과 같은 주소는 뺀다 */
function addressList(items: readonly string[], exclude: (item: string) => boolean, seen: string[] = []): string[] {
  const out: string[] = [];
  for (const item of items) {
    const norm = normalizeAddress(item);
    if (norm === null || exclude(norm)) continue;
    if (seen.some((s) => sameAddress(s, norm)) || out.some((s) => sameAddress(s, norm))) continue;
    out.push(norm);
  }
  return out;
}

/**
 * 회신 문맥(§1). 받는사람 기본값 = reply_to(없으면 from). 그게 나(보내는 계정)면 — 내가 보낸 메일 — 원본 to.
 * 전체 회신 참조 = 원본 to + cc 에서 나·받는사람·중복을 뺀 것. 나를 모르면(sender.address 없음) 빼지 않는다.
 */
export function buildReplyContext(args: {
  taskId: string;
  source: ReplySource;
  sender: ReplySender;
  lastSent?: SentMailRecord;
}): ReplyContext {
  const { taskId, source, sender, lastSent } = args;
  const me = sender.address && addressOf(sender.address) !== null ? sender.address : undefined;
  const isMe = (item: string): boolean => (me ? sameAddress(item, me) : false);

  const candidates = source.replyTo ? splitAddressList(source.replyTo) : [source.from];
  let to = addressList(candidates, isMe);
  if (to.length === 0 && candidates.some((c) => isMe(c))) {
    // 내가 보낸 메일 — 원래 받는사람에게 다시 보낸다
    to = addressList(source.to, isMe);
    if (to.length === 0) to = addressList(source.to, () => false);
  }
  const ccAll = addressList([...source.to, ...source.cc], isMe, to);

  const context: ReplyContext = {
    taskId,
    mail: source.rel,
    original: {
      subject: source.subject,
      from: source.from,
      to: [...source.to],
      cc: [...source.cc],
    },
    to,
    ccAll,
    subject: replySubject(source.subject),
    quote: formatQuote(source),
    suspicious: [...source.suspicion],
    sender: { ...sender },
  };
  if (source.date) context.original.date = source.date;
  if (source.messageId) context.original.messageId = source.messageId;
  if (lastSent) context.lastSent = structuredClone(lastSent);
  return context;
}
