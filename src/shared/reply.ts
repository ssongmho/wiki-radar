// 메일 회신의 주소·제목·본문 검사(docs/stage2.5-contract.md §1·§2·§5-2). main 과 renderer 가 같이 쓴다.
// 의존성 없는 순수 함수만 둔다(node 모듈 import 금지). 최종 판정은 main 이 하고, renderer 는 같은 규칙으로 미리 막는다.

/** 길이 한도(글자 수 = 코드 포인트) */
export const REPLY_LIMITS = { recipients: 20, subject: 300, body: 20000, fromName: 60, signature: 2000 } as const;

/** 초안이 모르는 사실을 표시하는 자리(§3). 본문에 남아 있으면 보내지 않는다 */
export const CONFIRM_MARK = '[확인 필요';

/** 명세 §1 유효 주소 */
const ADDRESS_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
/** 제어 문자 전부(줄바꿈·탭 포함) */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** 줄바꿈(\r·\n)·탭 밖의 제어 문자 */
const CONTROL_EXCEPT_LINES_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** 글자 수(코드 포인트). 한글은 한 글자가 하나다 */
function charCount(s: string): number {
  return Array.from(s).length;
}

/** 문제 문장에 넣을 때 쓰는 짧은 표시(제어 문자는 ⏎ 로, 60자까지) */
function shown(s: string): string {
  const flat = s.replace(/\r\n|\r|\n/g, '⏎').replace(/[\u0000-\u001f\u007f]/g, ' ');
  const chars = Array.from(flat);
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : flat;
}

/**
 * 쉼표·세미콜론·줄바꿈으로 나눈다. 따옴표("…", \" 이스케이프 포함)·꺾쇠(<…>) 안은 나누지 않는다.
 * 앞뒤 공백을 걷고 빈 것은 뺀다. 주소가 맞는지는 보지 않는다.
 */
export function splitAddressList(text: string): string[] {
  if (typeof text !== 'string') return [];
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  let inAngle = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i];
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (inAngle) {
      cur += ch;
      if (ch === '>') inAngle = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      cur += ch;
    } else if (ch === '<') {
      inAngle = true;
      cur += ch;
    } else if (ch === ',' || ch === ';' || ch === '\n' || ch === '\r') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** '이름 <주소>' 꼴이면 [이름 부분, 주소 부분], 아니면 null */
function splitAngle(item: string): [string, string] | null {
  const m = /^([^<>]*)<([^<>]*)>$/.exec(item);
  return m ? [m[1], m[2]] : null;
}

/**
 * '이름 <a@b.c>' 또는 'a@b.c' → 주소(대소문자는 그대로). 형식이 틀리면 null.
 * 제어 문자(줄바꿈 포함)가 어디든 있으면 틀린 것으로 본다 — 머리말 주입(`a@b.c\r\nBcc: x@y.z`)을 막는다.
 */
export function addressOf(item: string): string | null {
  if (typeof item !== 'string') return null;
  if (CONTROL_RE.test(item)) return null;
  const s = item.trim();
  if (s === '') return null;
  const angle = splitAngle(s);
  const addr = angle ? angle[1].trim() : s;
  return isValidAddress(addr) ? addr : null;
}

/** 이름(둘러싼 따옴표를 걷고, 따옴표·꺾쇠·줄바꿈을 뺀 것). 이름이 없으면 '' */
export function displayNameOf(item: string): string {
  if (typeof item !== 'string') return '';
  const angle = splitAngle(item.trim());
  if (!angle) return '';
  let name = angle[0].trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return cleanName(name);
}

/** 이름의 따옴표·꺾쇠를 빼고 줄바꿈·제어 문자는 공백으로, 공백을 하나로 합친다 */
function cleanName(name: string): string {
  return name
    .replace(/["<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 명세 §1 정규식 */
export function isValidAddress(addr: string): boolean {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

/**
 * 이름이 있으면 '이름 <addr>'(이름의 " < > 줄바꿈은 걷는다), 없으면 addr.
 * 이름에 쉼표·세미콜론이 있으면 '"이름" <addr>' 로 감싼다 — 한 줄로 이어 붙였다가 다시 나눠도 한 주소로 남게.
 */
export function formatAddress(name: string, address: string): string {
  const clean = cleanName(typeof name === 'string' ? name : '').replace(/\\/g, '');
  if (clean === '') return address;
  return /[,;]/.test(clean) ? `"${clean}" <${address}>` : `${clean} <${address}>`;
}

/** 두 항목의 주소가 같은가(대소문자 무시). 어느 쪽이든 형식이 틀리면 false */
export function sameAddress(a: string, b: string): boolean {
  const x = addressOf(a);
  const y = addressOf(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

/** RE:·Re:·회신:·답장:·FW:·Fwd:·전달: 접두(여러 겹, 콜론은 : 또는 ：, 대소문자 무시) */
const REPLY_PREFIX_RE = /^\s*(?:re|fwd|fw|회신|답장|전달)\s*[:：]\s*/i;

/** 제목 앞의 회신·전달 접두를 여러 겹 걷는다 */
export function stripReplyPrefixes(subject: string): string {
  let s = typeof subject === 'string' ? subject : '';
  for (;;) {
    const next = s.replace(REPLY_PREFIX_RE, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** 'RE: ' + 접두 걷은 제목. 비면 'RE: (제목 없음)'. 제목 안의 줄바꿈·제어 문자는 공백 하나로 */
export function replySubject(original: string): string {
  const flat = (typeof original === 'string' ? original : '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const s = stripReplyPrefixes(flat).replace(/\s+/g, ' ');
  return s === '' ? 'RE: (제목 없음)' : `RE: ${s}`;
}

/** 받는사람·참조 목록 검사 */
function recipientProblem(to: unknown, cc: unknown): string | null {
  if (!Array.isArray(to) || !Array.isArray(cc)) return '받는사람·참조 형식이 맞지 않습니다';
  if (to.length === 0) return '받는사람을 한 명 이상 넣으세요';
  const total = to.length + cc.length;
  if (total > REPLY_LIMITS.recipients) {
    return `받는사람과 참조는 합쳐 ${REPLY_LIMITS.recipients}명까지입니다(지금 ${total}명)`;
  }
  for (const [label, list] of [
    ['받는사람', to],
    ['참조', cc],
  ] as const) {
    for (const item of list) {
      if (typeof item !== 'string' || addressOf(item) === null) {
        return `${label} 주소 형식이 맞지 않습니다: ${typeof item === 'string' ? shown(item) : String(item)}`;
      }
    }
  }
  return null;
}

/**
 * 보내기 전 검사(명세 §2). 문제가 있으면 한국어 문장, 없으면 null.
 * body 는 서명·인용을 붙이기 전의 본문이다.
 */
export function replyProblem(input: { to: string[]; cc: string[]; subject: string; body: string }): string | null {
  if (!input || typeof input !== 'object') return '회신 입력 형식이 맞지 않습니다';
  const rp = recipientProblem(input.to, input.cc);
  if (rp) return rp;

  const subject = input.subject;
  if (typeof subject !== 'string' || subject.trim() === '') return '제목을 넣으세요';
  if (CONTROL_RE.test(subject)) return '제목에 줄바꿈이나 제어 문자를 넣을 수 없습니다';
  const subjectLen = charCount(subject);
  if (subjectLen > REPLY_LIMITS.subject) {
    return `제목은 ${REPLY_LIMITS.subject}자까지입니다(지금 ${subjectLen}자)`;
  }

  const body = input.body;
  if (typeof body !== 'string' || body.trim() === '') return '본문을 쓰세요';
  const bodyLen = charCount(body);
  if (bodyLen > REPLY_LIMITS.body) {
    return `본문은 ${REPLY_LIMITS.body.toLocaleString('en-US')}자까지입니다(지금 ${bodyLen.toLocaleString('en-US')}자)`;
  }
  if (CONTROL_EXCEPT_LINES_RE.test(body)) return '본문에 줄바꿈·탭 밖의 제어 문자가 있습니다';
  if (body.includes(CONFIRM_MARK)) return '초안의 [확인 필요: …] 표시를 채우거나 지운 뒤 보내세요';
  return null;
}

/** 받는사람 한 명의 표시: 이름, 없으면 주소, 둘 다 없으면 적힌 그대로 */
export function recipientLabel(item: string): string {
  return displayNameOf(item) || addressOf(item) || (typeof item === 'string' ? item.trim() : '');
}

/**
 * 처리 내용에 붙는 발송 줄(명세 §4-2 ⑦). main 이 메모에 넣고, 보냈는데 저장이 실패하면 renderer 가
 * 처리 내용에 같은 줄을 붙여 둔다 — 두 쪽이 이 함수 하나를 쓴다.
 */
export function sentLine(to: readonly string[], cc: readonly string[], subject: string): string {
  const who = to.map(recipientLabel).join(', ');
  return `메일 회신 발송 — 받는사람: ${who} · 제목: ${subject}` + (cc.length > 0 ? ` · 참조 ${cc.length}명` : '');
}

/** 줄바꿈을 LF 로 */
function toLf(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * 보낼 본문 = body.trimEnd() + (서명이 있으면 "\n\n" + 서명) + (인용이 있으면 "\n\n" + quote). 줄바꿈은 LF.
 * quote 가 null 이면 원문 인용을 붙이지 않는다.
 */
export function assembleReplyBody(body: string, signature: string, quote: string | null): string {
  let out = toLf(body ?? '').trimEnd();
  const sig = toLf(signature ?? '').trimEnd();
  if (sig.trim() !== '') out += `\n\n${sig}`;
  if (quote !== null && quote !== undefined) {
    const q = toLf(quote).trimEnd();
    if (q !== '') out += `\n\n${q}`;
  }
  return out;
}

/** 보내는 이름·서명 검사(명세 §5-2). 문제가 있으면 한국어 문장, 없으면 null */
export function settingsProblem(s: { fromName: string; signature: string }): string | null {
  if (!s || typeof s !== 'object') return '메일 설정 형식이 맞지 않습니다';
  const { fromName, signature } = s;
  if (typeof fromName !== 'string') return '보내는 이름 형식이 맞지 않습니다';
  if (charCount(fromName) > REPLY_LIMITS.fromName) return `보내는 이름은 ${REPLY_LIMITS.fromName}자까지입니다`;
  if (CONTROL_RE.test(fromName) || /["<>]/.test(fromName)) {
    return '보내는 이름에 줄바꿈·제어 문자나 " < > 를 넣을 수 없습니다';
  }
  if (typeof signature !== 'string') return '서명 형식이 맞지 않습니다';
  if (charCount(signature) > REPLY_LIMITS.signature) {
    return `서명은 ${REPLY_LIMITS.signature.toLocaleString('en-US')}자까지입니다`;
  }
  if (CONTROL_EXCEPT_LINES_RE.test(signature)) return '서명에 줄바꿈·탭 밖의 제어 문자를 넣을 수 없습니다';
  return null;
}
