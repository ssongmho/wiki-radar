// _raw-link/link_raw.py 의 사전·집합 리터럴을 **텍스트로** 읽는다(파이썬을 실행하지 않는다).
// `#` 주석, 따옴표 문자열(작은·큰·세 겹, r/u/b 접두), 여러 줄 리터럴, 이어 붙인 문자열을 처리한다.

export interface LinkMappings {
  /** 메일함 → 위키 페이지명 */
  folderPage: Map<string, string>;
  /** 링크하지 않는 메일함 */
  folderSkip: Set<string>;
  /** VOC customer → 위키 페이지명 */
  custPage: Map<string, string>;
  /** 시스템명 → 위키 페이지명 */
  systemPage: Map<string, string>;
}

export function emptyMappings(): LinkMappings {
  return { folderPage: new Map(), folderSkip: new Set(), custPage: new Map(), systemPage: new Map() };
}

type Token =
  | { kind: 'str'; value: string }
  | { kind: 'open'; ch: string }
  | { kind: 'close'; ch: string }
  | { kind: 'colon' }
  | { kind: 'comma' }
  | { kind: 'word'; value: string }
  | { kind: 'other'; ch: string };

const OPENERS = '{[(';
const CLOSERS = '}])';

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** i 위치(따옴표)에서 파이썬 문자열 하나를 읽는다. raw 면 역슬래시를 해석하지 않는다. */
function readPyString(src: string, i: number, raw: boolean): { value: string; end: number } | null {
  const q = src[i];
  const triple = src.startsWith(q.repeat(3), i);
  const close = triple ? q.repeat(3) : q;
  let j = i + close.length;
  let out = '';
  while (j < src.length) {
    if (src.startsWith(close, j)) return { value: out, end: j + close.length };
    const ch = src[j];
    if (!triple && (ch === '\n' || ch === '\r')) return null; // 닫히지 않은 한 줄 문자열
    if (ch === '\\' && j + 1 < src.length) {
      const nx = src[j + 1];
      if (raw) {
        out += ch + nx;
        j += 2;
        continue;
      }
      j += 2;
      switch (nx) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '0': out += '\0'; break;
        case '\\': out += '\\'; break;
        case "'": out += "'"; break;
        case '"': out += '"'; break;
        case '\n': break; // 줄 이어짐
        case '\r':
          if (src[j] === '\n') j++;
          break;
        case 'x': {
          const hex = src.slice(j, j + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            j += 2;
          } else out += '\\x';
          break;
        }
        case 'u':
        case 'U': {
          const len = nx === 'u' ? 4 : 8;
          const hex = src.slice(j, j + len);
          if (new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            j += len;
          } else out += '\\' + nx;
          break;
        }
        default:
          out += '\\' + nx;
      }
      continue;
    }
    out += ch;
    j++;
  }
  return null;
}

/**
 * start 위치부터 괄호 하나가 닫힐 때까지 토큰으로 나눈다.
 * 첫 여는 괄호 앞에는 이름(`frozenset` 등)만 올 수 있다. 괄호가 없으면 null.
 */
function tokenizeLiteral(src: string, start: number): Token[] | null {
  const tokens: Token[] = [];
  let depth = 0;
  let started = false;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (!started && (ch === '\n' || ch === '\r')) {
        // 괄호가 열리기 전의 줄바꿈 — 이어짐 역슬래시가 없으면 대입문이 끝난 것이다.
        return null;
      }
      i++;
      continue;
    }
    if (ch === '\\' && (src[i + 1] === '\n' || src[i + 1] === '\r')) {
      i += 2;
      continue;
    }
    // 문자열(접두 r/u/b/f 조합 허용)
    const prefix = /^([rRuUbBfF]{0,2})(['"])/.exec(src.slice(i, i + 3));
    if (prefix && (prefix[1] === '' || !isWordChar(src[i - 1] ?? ' '))) {
      const raw = /[rR]/.test(prefix[1]);
      const s = readPyString(src, i + prefix[1].length, raw);
      if (!s) return null;
      const prev = tokens[tokens.length - 1];
      if (prev && prev.kind === 'str') prev.value += s.value; // "a" "b" → "ab"
      else tokens.push({ kind: 'str', value: s.value });
      i = s.end;
      continue;
    }
    if (OPENERS.includes(ch)) {
      depth++;
      started = true;
      tokens.push({ kind: 'open', ch });
      i++;
      continue;
    }
    if (CLOSERS.includes(ch)) {
      depth--;
      tokens.push({ kind: 'close', ch });
      i++;
      if (depth <= 0) return started ? tokens : null;
      continue;
    }
    if (!started) {
      // 여는 괄호 전에는 이름만 허용
      if (isWordChar(ch)) {
        let j = i;
        while (j < src.length && isWordChar(src[j])) j++;
        tokens.push({ kind: 'word', value: src.slice(i, j) });
        i = j;
        continue;
      }
      return null;
    }
    if (ch === ':') tokens.push({ kind: 'colon' });
    else if (ch === ',') tokens.push({ kind: 'comma' });
    else if (isWordChar(ch)) {
      let j = i;
      while (j < src.length && isWordChar(src[j])) j++;
      tokens.push({ kind: 'word', value: src.slice(i, j) });
      i = j;
      continue;
    } else tokens.push({ kind: 'other', ch });
    i++;
  }
  return null; // 괄호가 닫히지 않았다
}

/** `NAME = …` (타입 표기 `NAME: dict[str, str] = …` 포함) 대입의 오른쪽 시작 위치. 줄 맨 앞의 첫 대입만 본다. */
function findAssignment(src: string, name: string): number | null {
  const re = new RegExp(`^${name}\\s*(?::[^=\\n]*)?=(?!=)`, 'm');
  const m = re.exec(src);
  return m ? m.index + m[0].length : null;
}

/** 사전 리터럴 → Map. `"키": "값"` 쌍만 모은다(값이 문자열이 아닌 쌍은 건너뛴다). */
export function parseDictLiteral(src: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  const pos = findAssignment(src, name);
  if (pos === null) return out;
  const tokens = tokenizeLiteral(src, pos);
  if (!tokens) return out;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const c = tokens[i + 2];
    if (a.kind === 'str' && b.kind === 'colon' && c.kind === 'str') {
      // 뒤에 또 이어지는 것이 없어야 값이다(예: "a": "b" if x — 드묾, 무시)
      out.set(a.value, c.value);
      i += 2;
    }
  }
  return out;
}

/** 집합(또는 리스트·튜플·frozenset(...)) 리터럴 → Set. 문자열 원소만 모은다. */
export function parseSetLiteral(src: string, name: string): Set<string> {
  const out = new Set<string>();
  const pos = findAssignment(src, name);
  if (pos === null) return out;
  const tokens = tokenizeLiteral(src, pos);
  if (!tokens) return out;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind !== 'str') continue;
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    // 사전의 키·값은 원소가 아니다
    if ((next && next.kind === 'colon') || (prev && prev.kind === 'colon')) continue;
    out.add(tk.value);
  }
  return out;
}

/** link_raw.py 원문 → 매핑 표. 빈 문자열이면 빈 표. */
export function parseLinkRaw(src: string): LinkMappings {
  return {
    folderPage: parseDictLiteral(src, 'FOLDER_PAGE'),
    folderSkip: parseSetLiteral(src, 'FOLDER_SKIP'),
    custPage: parseDictLiteral(src, 'CUST_PAGE'),
    systemPage: parseDictLiteral(src, 'SYSTEM_PAGE'),
  };
}
