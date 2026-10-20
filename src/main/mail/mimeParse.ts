// 메일 원문(RFC 5322 바이트) → 정규화한 한 통(docs/stage2.15-contract.md §A-4). electron 을 import 하지 않는 순수 모듈이다.
//
// `WIKI/_mail-ingest/mailhost_mail.py parse_message` 를 옮긴 것이다 — 머리 RFC 2047 풀기, multipart 재귀, base64·quoted-printable,
// 문자셋(ks_c_5601-1987 계열 → cp949), text/plain 우선 · 없으면 HTML → 글, 첨부(실행형은 바이트를 버림), 피싱 신호, URL 깨기.
// 메일 본문은 데이터다 — 여기서는 글자로 옮기기만 한다. 새 의존성 없이 iconv-lite(이미 있음)만 쓴다.
import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';

/** 한 통 한도(넘으면 받지 않는다) */
export const MAIL_MAX_BYTES = 25 * 1024 * 1024;
/** multipart 깊이 한도(병적인 메일로 재귀가 깊어지지 않게) */
const MAX_DEPTH = 12;
/** 파트 수 한도 */
const MAX_PARTS = 500;

/** 저장하지 않는 첨부 확장자(수집기 BLOCKED_EXTS 와 같다). 이름·크기만 기록하고 바이트는 버린다 */
export const BLOCKED_EXTS: ReadonlySet<string> = new Set([
  '.exe', '.scr', '.com', '.pif', '.bat', '.cmd', '.msi', '.msp',
  '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1',
  '.hta', '.lnk', '.chm', '.reg', '.cpl', '.jar', '.iso', '.img', '.vhd',
]);

/** 우리 조직(사칭 판정) — 수집기 OWN_DOMAINS·OWN_NAMES */
export const OWN_DOMAINS: ReadonlySet<string> = new Set(['acme.test']);
export const OWN_NAMES: readonly string[] = ['acme', '예시회사'];

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** 실행형이면 빈 버퍼 */
  data: Buffer;
  blocked: boolean;
  /** 실행형만 sha256(16진) */
  sha256: string;
  inline: boolean;
  /** Content-ID(꺾쇠 없이) — HTML 본문의 cid: 그림(2.15 원본 보기) */
  contentId?: string;
}

export interface ParsedMail {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  replyTo: string;
  date: Date;
  messageId: string;
  inReplyTo: string;
  references: string;
  body: string;
  bodyFormat: 'plain' | 'html→text' | 'empty';
  /** HTML 본문(문자셋을 푼 원문 — 원본 보기용. 없으면 '') */
  html: string;
  attachments: ParsedAttachment[];
  signals: string[];
}

// ---- 문자셋 ---------------------------------------------------------------------------------

const KR_ALIASES: ReadonlySet<string> = new Set([
  'ks-c-5601-1987', 'ks-c-5601-1989', 'ksc5601', 'ksc-5601',
  'ks-x-1001', 'ksx1001', 'euc-kr', 'euckr', 'x-windows-949',
  'ms949', 'uhc', 'cp949',
]);

function normCharset(cs: string | undefined): string | undefined {
  if (!cs) return undefined;
  const c = cs.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!c) return undefined;
  if (KR_ALIASES.has(c.replace(/_/g, '-'))) return 'cp949';
  return c;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function tryDecode(raw: Buffer, cs: string): string | null {
  if (cs === 'utf-8' || cs === 'utf8') {
    try {
      return utf8Strict.decode(raw);
    } catch {
      return null;
    }
  }
  if (cs === 'us-ascii' || cs === 'ascii') {
    // 수집기(파이썬)는 ascii 로 안 풀리면 다음 후보로 간다
    for (const b of raw) if (b > 0x7f) return null;
    return raw.toString('latin1');
  }
  if (!iconv.encodingExists(cs)) return null;
  return iconv.decode(raw, cs);
}

/** 선언된 문자셋을 믿되 안 되면 utf-8 → cp949 → latin1(수집기 safe_decode) */
export function safeDecode(raw: Buffer, charset?: string): string {
  const cands: string[] = [];
  const declared = normCharset(charset);
  if (declared) cands.push(declared);
  for (const c of ['utf-8', 'cp949', 'latin1']) if (!cands.includes(c)) cands.push(c);
  for (const c of cands) {
    const s = tryDecode(raw, c);
    if (s !== null) return s;
  }
  return raw.toString('utf8');
}

/** 머리 값의 날 바이트(인코딩 안 된 8비트): utf-8 로 풀리면 utf-8, 아니면 cp949 */
function decodeRawHeaderBytes(s: string): string {
  if (!/[\u0080-ÿ]/.test(s)) return s;
  const buf = Buffer.from(s, 'latin1');
  return tryDecode(buf, 'utf-8') ?? iconv.decode(buf, 'cp949');
}

// ---- 전송 인코딩 ----------------------------------------------------------------------------

function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
}

/** quoted-printable(본문) → 바이트 */
export function decodeQuotedPrintable(raw: Buffer): Buffer {
  const out: number[] = [];
  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const c = raw[i];
    if (c !== 0x3d) {
      out.push(c);
      continue;
    }
    // '=' 다음
    const a = raw[i + 1];
    const b = raw[i + 2];
    if (a === 0x0d && b === 0x0a) {
      i += 2; // 부드러운 줄바꿈(CRLF)
      continue;
    }
    if (a === 0x0a) {
      i += 1; // 부드러운 줄바꿈(LF)
      continue;
    }
    // 줄 끝 공백 뒤 '=' 줄바꿈
    if (a === 0x20 || a === 0x09) {
      let j = i + 1;
      while (j < n && (raw[j] === 0x20 || raw[j] === 0x09)) j++;
      if (raw[j] === 0x0a || (raw[j] === 0x0d && raw[j + 1] === 0x0a)) {
        i = raw[j] === 0x0a ? j : j + 1;
        continue;
      }
    }
    const hex = a !== undefined && b !== undefined ? String.fromCharCode(a, b) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(c);
    }
  }
  return Buffer.from(out);
}

function decodeTransfer(raw: Buffer, cte: string): Buffer {
  const enc = cte.trim().toLowerCase();
  if (enc === 'base64') return decodeBase64(raw.toString('latin1'));
  if (enc === 'quoted-printable') return decodeQuotedPrintable(raw);
  return raw;
}

// ---- 머리 ----------------------------------------------------------------------------------

export interface HeaderBlock {
  /** 소문자 이름 → 값들(이어진 줄을 편 날 값, latin1 글자) */
  map: Map<string, string[]>;
}

/** 머리와 몸을 나눈다(첫 빈 줄). 머리는 latin1 글자로 */
function splitHeadBody(raw: Buffer): { head: string; body: Buffer } {
  let idx = -1;
  let skip = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x0a) continue;
    if (raw[i + 1] === 0x0a) {
      idx = i;
      skip = 2;
      break;
    }
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) {
      idx = i;
      skip = 3;
      break;
    }
  }
  if (idx < 0) {
    // 몸 없는 메일 — 맨 앞이 빈 줄이면 머리 없음
    return { head: raw.toString('latin1'), body: Buffer.alloc(0) };
  }
  if (idx === 0 && raw[0] === 0x0a) return { head: '', body: raw.subarray(1) };
  return { head: raw.subarray(0, idx).toString('latin1'), body: raw.subarray(idx + skip) };
}

export function parseHeaders(head: string): HeaderBlock {
  const map = new Map<string, string[]>();
  const lines = head.split(/\r?\n/);
  let name = '';
  let value = '';
  const flush = (): void => {
    if (!name) return;
    const key = name.toLowerCase();
    const arr = map.get(key) ?? [];
    arr.push(value);
    map.set(key, arr);
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name) {
      value += line.replace(/^[ \t]+/, ' ');
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    flush();
    name = line.slice(0, colon).trim();
    value = line.slice(colon + 1).trim();
  }
  flush();
  return { map };
}

function first(h: HeaderBlock, name: string): string | undefined {
  return h.map.get(name)?.[0];
}

const ENCODED_WORD_RE = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQWord(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '_') bytes.push(0x20);
    else if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/** RFC 2047 머리 풀기(수집기 decode_hdr). 인코딩된 낱말 사이 공백은 지운다 */
export function decodeHeader(value: string | undefined): string {
  if (!value) return '';
  // 이웃한 인코딩 낱말 사이 공백 지우기
  const joined = value.replace(/(\?=)\s+(?==\?)/g, '$1');
  // 같은 문자셋이 이어지면 바이트를 모아 한 번에 푼다(여러 바이트 글자가 낱말 경계에서 갈라진 메일)
  let out = '';
  let last = 0;
  let pending: { cs: string; bytes: Buffer[] } | null = null;
  const flushPending = (): void => {
    if (!pending) return;
    out += safeDecode(Buffer.concat(pending.bytes), pending.cs);
    pending = null;
  };
  for (const m of joined.matchAll(ENCODED_WORD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      flushPending();
      out += decodeRawHeaderBytes(joined.slice(last, idx));
    }
    const cs = m[1].split('*')[0];
    const bytes = m[2].toUpperCase() === 'B' ? decodeBase64(m[3]) : decodeQWord(m[3]);
    if (pending && pending.cs.toLowerCase() === cs.toLowerCase()) pending.bytes.push(bytes);
    else {
      flushPending();
      pending = { cs, bytes: [bytes] };
    }
    last = idx + m[0].length;
  }
  flushPending();
  if (last < joined.length) out += decodeRawHeaderBytes(joined.slice(last));
  return out.replace(/[\r\n]+/g, ' ').trim();
}

// ---- 주소 ----------------------------------------------------------------------------------

/** 쉼표로 나누되 따옴표·꺾쇠·괄호 안은 나누지 않는다 */
function splitAddressHeader(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && quote) {
      cur += ch + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"' && angle === 0 && paren === 0) quote = !quote;
    else if (!quote) {
      if (ch === '<') angle++;
      else if (ch === '>' && angle > 0) angle--;
      else if (ch === '(') paren++;
      else if (ch === ')' && paren > 0) paren--;
      else if ((ch === ',' || ch === ';') && angle === 0 && paren === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

/** 주소 머리 하나 → [이름, 주소] 들(파이썬 getaddresses 와 비슷하게) */
export function parseAddresses(values: readonly string[]): { name: string; addr: string }[] {
  const out: { name: string; addr: string }[] = [];
  for (const raw of values) {
    // 머리 전체(주소까지)를 인코딩 낱말 하나로 싼 메일: 밖에 '@' 가 없으면 먼저 풀고 나눈다
    const v = raw.replace(ENCODED_WORD_RE, '').includes('@') ? raw : decodeHeader(raw);
    for (const part of splitAddressHeader(v)) {
      const m = /^(.*?)<([^<>]*)>\s*(?:\(.*\))?$/.exec(part);
      if (m) {
        out.push({ name: decodeHeader(unquote(m[1])), addr: m[2].trim() });
        continue;
      }
      // 주소 (주석) 또는 주소만
      const c = /^([^\s()]+@[^\s()]+)\s*(?:\((.*)\))?$/.exec(part);
      if (c) {
        out.push({ name: c[2] ? decodeHeader(c[2]) : '', addr: c[1] });
        continue;
      }
      out.push({ name: decodeHeader(unquote(part)), addr: '' });
    }
  }
  return out;
}

/** 수집기 _addr_list: `이름 <주소>` · 주소 · 이름 */
export function addressList(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const out: string[] = [];
  for (const { name, addr } of parseAddresses(values)) {
    if (name && addr) out.push(`${name} <${addr}>`);
    else if (addr) out.push(addr);
    else if (name) out.push(name);
  }
  return out;
}

// ---- Content-Type 같은 매개변수 머리 --------------------------------------------------------

export interface ParamHeader {
  value: string;
  params: Map<string, string>;
}

/** `type/sub; a=b; c*=utf-8''%ED…; d*0=..; d*1=..` → 값·매개변수(RFC 2231 풀기, 이름은 소문자) */
export function parseParamHeader(raw: string | undefined): ParamHeader {
  const params = new Map<string, string>();
  if (!raw) return { value: '', params };
  const parts: string[] = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && quote) {
      cur += raw[i + 1] ?? '';
      i++;
      continue;
    }
    if (ch === '"') {
      quote = !quote;
      cur += ch;
      continue;
    }
    if (ch === ';' && !quote) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const value = (parts.shift() ?? '').trim().toLowerCase();
  // RFC 2231 조각 모으기
  const pieces = new Map<string, { idx: number; text: string; enc: boolean }[]>();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    const quoted = val.startsWith('"') && val.endsWith('"') && val.length >= 2;
    if (quoted) val = val.slice(1, -1);
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) {
      const base = m[1];
      const idx = m[2] !== undefined ? Number(m[2]) : 0;
      const enc = m[3] === '*' || (m[2] === undefined && key.endsWith('*'));
      const arr = pieces.get(base) ?? [];
      arr.push({ idx, text: val, enc });
      pieces.set(base, arr);
    } else if (!params.has(key)) {
      params.set(key, val);
    }
  }
  for (const [base, arr] of pieces) {
    arr.sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    arr.forEach((pc, i) => {
      let text = pc.text;
      if (pc.enc) {
        if (i === 0) {
          const m2 = /^([^']*)'[^']*'(.*)$/.exec(text);
          if (m2) {
            if (m2[1]) charset = m2[1];
            text = m2[2];
          }
        }
        const b: number[] = [];
        for (let k = 0; k < text.length; k++) {
          if (text[k] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(k + 1, k + 3))) {
            b.push(parseInt(text.slice(k + 1, k + 3), 16));
            k += 2;
          } else b.push(text.charCodeAt(k) & 0xff);
        }
        bytes.push(Buffer.from(b));
      } else {
        bytes.push(Buffer.from(text, 'latin1'));
      }
    });
    params.set(base, safeDecode(Buffer.concat(bytes), charset));
  }
  return { value, params };
}

// ---- HTML → 글(수집기 _HTMLToText) ---------------------------------------------------------

const HTML_SKIP: ReadonlySet<string> = new Set(['script', 'style', 'head', 'title']);
const HTML_BLOCK: ReadonlySet<string> = new Set([
  'p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'blockquote', 'section', 'article',
  // 수집기보다 더(2.15 — 웹메일 서명·표가 한 줄로 붙지 않게)
  'ul', 'ol', 'hr', 'pre', 'center', 'dl', 'dt', 'dd', 'header', 'footer', 'tbody', 'thead', 'caption', 'address',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', middot: '·',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', trade: '™',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (all, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v ?? all;
  });
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  let skipDepth = 0;
  // 주석·선언을 먼저 걷는다
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<![^>]*>/g, '');
  const tagRe = /<\s*(\/)?\s*([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g;
  let last = 0;
  for (const m of src.matchAll(tagRe)) {
    const idx = m.index ?? 0;
    if (idx > last && skipDepth === 0) out.push(decodeEntities(src.slice(last, idx)));
    last = idx + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (HTML_SKIP.has(tag)) {
      if (closing) {
        if (skipDepth > 0) skipDepth--;
      } else if (!/\/\s*>$/.test(m[0])) skipDepth++;
      continue;
    }
    if (HTML_BLOCK.has(tag)) out.push('\n');
    else if (tag === 'td' && !closing) out.push('\t');
  }
  if (last < src.length && skipDepth === 0) out.push(decodeEntities(src.slice(last)));
  let raw = out.join('');
  raw = raw.replace(/[ \t ]+/g, ' ');
  raw = raw.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

// ---- URL 깨기(수집기 defang) ------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gi;

export function defang(text: string): string {
  return (text ?? '').replace(URL_RE, (url) => '`' + url.replace('://', '[:]//').replace(/\./g, '[.]') + '`');
}

// ---- 피싱 신호(수집기 suspicion_signals) --------------------------------------------------------

export function domainOf(addr: string): string {
  let a = (addr ?? '').toLowerCase();
  const m = /<([^>]+)>/.exec(a);
  if (m) a = m[1];
  const at = a.lastIndexOf('@');
  return at >= 0 ? a.slice(at + 1).replace(/^[\s>]+|[\s>]+$/g, '') : '';
}

export function suspicionSignals(h: HeaderBlock, fromStr: string, attachments: readonly ParsedAttachment[]): string[] {
  const signals: string[] = [];
  const display = (fromStr ?? '').split('<')[0].toLowerCase();
  const fromDomain = domainOf(fromStr);
  if (fromDomain && !OWN_DOMAINS.has(fromDomain)) {
    if (OWN_NAMES.some((n) => display.includes(n)) || [...OWN_DOMAINS].some((d) => display.includes(d))) {
      signals.push(`사내사칭(표시명 사내 / 실제 @${fromDomain})`);
    }
  }
  const replyTo = decodeHeader(first(h, 'reply-to'));
  if (replyTo) {
    const rt = domainOf(replyTo);
    if (rt && fromDomain && rt !== fromDomain) signals.push(`회신주소불일치(From @${fromDomain} / Reply-To @${rt})`);
  }
  const auth = (h.map.get('authentication-results') ?? []).join(' ').toLowerCase();
  for (const mech of ['spf', 'dkim', 'dmarc']) {
    if (new RegExp(`\\b${mech}=(fail|softfail|permerror)`).test(auth)) signals.push(`${mech.toUpperCase()}실패`);
  }
  for (const att of attachments) if (att.blocked) signals.push(`위험첨부(${att.filename})`);
  return signals;
}

// ---- 몸(파트) -----------------------------------------------------------------------------

interface Part {
  headers: HeaderBlock;
  body: Buffer;
}

/** multipart 몸을 경계로 나눈다(앞말·뒷말은 버린다) */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const delim = Buffer.from(`--${boundary}`, 'latin1');
  const parts: Buffer[] = [];
  const starts: { at: number; end: boolean; lineEnd: number }[] = [];
  let pos = 0;
  while (pos < body.length) {
    const i = body.indexOf(delim, pos);
    if (i < 0) break;
    const atLineStart = i === 0 || body[i - 1] === 0x0a;
    let j = i + delim.length;
    const isEnd = body[j] === 0x2d && body[j + 1] === 0x2d;
    if (isEnd) j += 2;
    // 줄 끝까지(공백 허용)
    while (j < body.length && (body[j] === 0x20 || body[j] === 0x09)) j++;
    const okEnd = j >= body.length || body[j] === 0x0a || body[j] === 0x0d;
    if (atLineStart && okEnd) {
      let lineEnd = j;
      if (body[lineEnd] === 0x0d) lineEnd++;
      if (body[lineEnd] === 0x0a) lineEnd++;
      starts.push({ at: i, end: isEnd, lineEnd });
      if (isEnd) break;
    }
    pos = i + delim.length;
  }
  for (let k = 0; k < starts.length - 1; k++) {
    if (starts[k].end) break;
    let stop = starts[k + 1].at;
    // 경계 앞 줄바꿈은 파트에 넣지 않는다
    if (stop > 0 && body[stop - 1] === 0x0a) stop--;
    if (stop > 0 && body[stop - 1] === 0x0d) stop--;
    parts.push(body.subarray(starts[k].lineEnd, Math.max(starts[k].lineEnd, stop)));
  }
  // 닫는 경계가 없는 메일: 마지막 파트는 끝까지
  const lastStart = starts[starts.length - 1];
  if (lastStart && !lastStart.end) parts.push(body.subarray(lastStart.lineEnd));
  return parts;
}

function partOf(raw: Buffer): Part {
  const { head, body } = splitHeadBody(raw);
  return { headers: parseHeaders(head), body };
}

/** 잎 파트를 차례로(수집기 msg.walk 의 잎) */
function walk(part: Part, depth: number, out: Part[]): void {
  if (out.length >= MAX_PARTS) return;
  const ct = parseParamHeader(first(part.headers, 'content-type'));
  if (ct.value.startsWith('multipart/') && depth < MAX_DEPTH) {
    const boundary = ct.params.get('boundary');
    if (boundary) {
      for (const sub of splitMultipart(part.body, boundary)) walk(partOf(sub), depth + 1, out);
      return;
    }
  }
  out.push(part);
}

function partText(p: Part, charset: string | undefined): string {
  const data = decodeTransfer(p.body, first(p.headers, 'content-transfer-encoding') ?? '');
  return safeDecode(data, charset).replace(/\r\n?/g, '\n');
}

function pyStrip(s: string): string {
  return s.replace(/^\s+|\s+$/g, '');
}

/** 메일 Date 머리 → Date. 못 읽으면 null */
export function parseMailDate(v: string | undefined): Date | null {
  if (!v) return null;
  const s = v.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // "Mon, 20 Jul 2026 14:23:11 +0900 (KST)" 아닌 이상한 꼴: 요일 없이·초 없이
    const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Z]{1,5})?/.exec(s);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      t = Date.parse(`${m[1]} ${m[2]} ${year} ${m[4]}:${m[5]}:${m[6] ?? '00'} ${m[7] ?? '+0000'}`);
    }
  }
  return Number.isNaN(t) ? null : new Date(t);
}

/** 원문 바이트 → 한 통(수집기 parse_message). now 는 날짜가 없을 때 */
export function parseMessage(raw: Buffer, now: () => Date = () => new Date()): ParsedMail {
  const root = partOf(raw);
  const h = root.headers;

  const subject = decodeHeader(first(h, 'subject')) || '(제목 없음)';
  const sender = addressList(h.map.get('from'));
  const fromStr = sender[0] ?? '(발신자 없음)';
  const date = parseMailDate(first(h, 'date')) ?? now();

  const plain: string[] = [];
  const html: string[] = [];
  const attachments: ParsedAttachment[] = [];
  const leaves: Part[] = [];
  walk(root, 0, leaves);

  for (const p of leaves) {
    const ct = parseParamHeader(first(p.headers, 'content-type'));
    const ctype = ct.value || 'text/plain';
    const dispH = parseParamHeader(first(p.headers, 'content-disposition'));
    const disp = (first(p.headers, 'content-disposition') ?? '').toLowerCase();
    const rawName = dispH.params.get('filename') ?? ct.params.get('name');
    const filename = rawName ? decodeHeader(rawName) : undefined;
    const isAttachment = disp.includes('attachment') || (!!filename && ctype !== 'text/plain' && ctype !== 'text/html') || ctype === 'message/rfc822';
    if (isAttachment || (filename && disp.includes('inline'))) {
      const data = ctype === 'message/rfc822' ? p.body : decodeTransfer(p.body, first(p.headers, 'content-transfer-encoding') ?? '');
      const fname = filename || `unnamed.${ctype.split('/').pop() ?? 'bin'}`;
      const dot = fname.lastIndexOf('.');
      const ext = dot >= 0 ? `.${fname.slice(dot + 1).toLowerCase()}` : '';
      const blocked = BLOCKED_EXTS.has(ext);
      const cid = (first(p.headers, 'content-id') ?? '').trim().replace(/^<+/, '').replace(/>+$/, '');
      attachments.push({
        filename: fname,
        contentType: ctype,
        size: data.length,
        data: blocked ? Buffer.alloc(0) : data,
        blocked,
        sha256: blocked ? createHash('sha256').update(data).digest('hex') : '',
        inline: disp.includes('inline'),
        ...(cid ? { contentId: cid } : {}),
      });
      continue;
    }
    // 파일 이름 없는 본문 속 그림(Content-ID 만 있는 image/*) — 원본 보기용으로 첨부처럼 남긴다
    const cidOnly = (first(p.headers, 'content-id') ?? '').trim().replace(/^<+/, '').replace(/>+$/, '');
    if (cidOnly && ctype.startsWith('image/')) {
      const data = decodeTransfer(p.body, first(p.headers, 'content-transfer-encoding') ?? '');
      attachments.push({ filename: `inline-${attachments.length + 1}.${ctype.split('/')[1] ?? 'img'}`, contentType: ctype, size: data.length, data, blocked: false, sha256: '', inline: true, contentId: cidOnly });
      continue;
    }
    if (ctype === 'text/plain') plain.push(partText(p, ct.params.get('charset')));
    else if (ctype === 'text/html') html.push(partText(p, ct.params.get('charset')));
  }

  let body = pyStrip(plain.filter((x) => pyStrip(x) !== '').join('\n\n'));
  let bodyFormat: ParsedMail['bodyFormat'] = 'plain';
  const htmlText = html.length > 0 ? htmlToText(html.join('\n')) : '';
  if (!body && htmlText) {
    body = htmlText;
    bodyFormat = 'html→text';
  } else if (body && htmlText && !body.includes('\n') && (htmlText.match(/\n/g) ?? []).length >= 2) {
    // 글판이 줄바꿈 없이 한 줄로 붙어 온 메일(웹메일이 만든 글판) — HTML 에서 뽑은 글이 더 읽기 좋다
    body = htmlText;
    bodyFormat = 'html→text';
  }
  if (!body) {
    body = '(본문 없음)';
    bodyFormat = 'empty';
  }

  const stripAngles = (v: string | undefined): string => (v ?? '').trim().replace(/^<+/, '').replace(/>+$/, '');
  return {
    subject,
    from: fromStr,
    to: addressList(h.map.get('to')),
    cc: addressList(h.map.get('cc')),
    replyTo: decodeHeader(first(h, 'reply-to')),
    date,
    messageId: stripAngles(first(h, 'message-id')),
    inReplyTo: stripAngles(first(h, 'in-reply-to')),
    references: (first(h, 'references') ?? '').trim(),
    body: defang(body),
    bodyFormat,
    html: html.join('\n'),
    attachments,
    signals: suspicionSignals(h, fromStr, attachments),
  };
}
