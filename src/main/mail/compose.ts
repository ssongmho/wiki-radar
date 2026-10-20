// 회신 MIME 조립(docs/stage2.5-contract.md §2). electron 을 import 하지 않는 순수 모듈이다.
//
// nodemailer 의 MailComposer 로 한 번 만들고 그 바이트 그대로 보내고(smtp.ts) 그대로 .eml 로 남긴다(stores.ts).
// - text/plain; charset=utf-8 한 부분만(HTML·첨부 없음). 줄바꿈은 CRLF.
// - 숨은참조는 머리말에 넣지 않고 봉투(RCPT)에만 넣는다 — MailComposer 에 bcc 를 넘기지 않는다.
// - Message-ID 는 '<uuid@보내는 주소 도메인>'.
import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { addressOf, displayNameOf } from '../../shared/reply';

export interface ComposeInput {
  from: { name?: string; address: string };
  /** '이름 <주소>' 또는 '주소' */
  to: string[];
  cc: string[];
  /** 봉투에만 넣는다(머리말 없음) */
  bcc: string[];
  subject: string;
  /** 보낼 본문 전체(서명·인용 포함, LF) */
  text: string;
  /** 원본 Message-ID(꺾쇠는 있어도 없어도 된다) */
  inReplyTo?: string;
  /** 공백으로 나눈 Message-ID 들 */
  references?: string;
}

export interface ComposedMessage {
  raw: Buffer;
  /** '<…@…>' 꺾쇠 포함 */
  messageId: string;
  /** envelope.to = to + cc + bcc 주소(대소문자 무시 중복 뺌) */
  envelope: { from: string; to: string[] };
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** 보내는 주소: 공백·꺾쇠·따옴표·쉼표 등 머리말을 깨는 글자가 없어야 한다(시험 계정은 '@' 가 없을 수 있다) */
const SENDER_RE = /^[^\s<>()",;\\[\]\u0000-\u001f\u007f]+$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const FALLBACK_DOMAIN = 'wiki-radar.local';

/**
 * 주소 목록 → 머리말용 {name, address}. 문자열로 넘기면 nodemailer 가 다시 파싱하며 이름의 괄호를 주석으로
 * 읽으므로 나눈 채로 넘긴다. 형식이 틀린 항목이 있으면 Error
 */
function headerAddresses(label: string, items: readonly string[]): { name: string; address: string }[] {
  if (!Array.isArray(items)) throw new Error(`${label} 형식이 맞지 않습니다`);
  return items.map((item) => {
    const address = addressOf(item);
    if (address === null) throw new Error(`${label} 주소 형식이 맞지 않습니다`);
    return { name: displayNameOf(item), address };
  });
}

/** 꺾쇠 없는 Message-ID 하나. 공백·꺾쇠·제어 문자가 있으면 null */
function bareMessageId(id: string): string | null {
  const s = id.trim().replace(/^<+/, '').replace(/>+$/, '');
  if (s === '' || s.length > 900 || /[\s<>\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

/** 이름이 없으면 주소 글만(nodemailer 가 '"" <a@b.c>' 를 만들지 않게) */
function asHeaderAddress(a: { name: string; address: string }): string | { name: string; address: string } {
  return a.name ? a : a.address;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at >= 0 ? address.slice(at + 1).toLowerCase() : '';
  return DOMAIN_RE.test(domain) ? domain : FALLBACK_DOMAIN;
}

/** MIME 한 통을 만든다. 입력이 머리말을 깰 수 있으면(주소 형식·제어 문자) Error */
export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const fromAddress = typeof input.from?.address === 'string' ? input.from.address.trim() : '';
  if (!SENDER_RE.test(fromAddress)) throw new Error('보내는 주소 형식이 맞지 않습니다');
  const fromName = (input.from.name ?? '').replace(/["<>]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

  const to = headerAddresses('받는사람', input.to);
  if (to.length === 0) throw new Error('받는사람이 없습니다');
  const cc = headerAddresses('참조', input.cc);

  if (typeof input.subject !== 'string' || CONTROL_RE.test(input.subject)) {
    throw new Error('제목에 줄바꿈이나 제어 문자를 넣을 수 없습니다');
  }

  const bcc = headerAddresses('숨은참조', input.bcc);
  const envelopeTo: string[] = [];
  for (const { address } of [...to, ...cc, ...bcc]) {
    if (!envelopeTo.some((x) => x.toLowerCase() === address.toLowerCase())) envelopeTo.push(address);
  }

  const messageId = `<${crypto.randomUUID()}@${domainOf(fromAddress)}>`;
  const inReplyTo = input.inReplyTo ? bareMessageId(input.inReplyTo) : null;
  const references = (input.references ?? '')
    .split(/\s+/)
    .map((x) => (x ? bareMessageId(x) : null))
    .filter((x): x is string => x !== null);

  const composer = new MailComposer({
    from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
    to: to.map(asHeaderAddress),
    cc: cc.length > 0 ? cc.map(asHeaderAddress) : undefined,
    subject: input.subject,
    messageId,
    date: new Date(),
    inReplyTo: inReplyTo ? `<${inReplyTo}>` : undefined,
    references: references.length > 0 ? references.map((x) => `<${x}>`) : undefined,
    text: {
      content: (input.text ?? '').replace(/\r\n?|\n/g, '\r\n'),
      contentType: 'text/plain; charset=utf-8',
    },
    newline: 'win',
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const node = composer.compile();
  node.keepBcc = false;
  const raw = await node.build();
  return { raw, messageId, envelope: { from: fromAddress, to: envelopeTo } };
}
