// 메일 스레드 키·메일 키 규칙(docs/stage2.10-contract.md §2). main 과 renderer 가 같이 쓴다.
// 의존성 없는 순수 함수만 둔다(node 모듈 import 금지).
//
// normThread 는 `WIKI/_mail-ingest/open_loops.py norm_thread` 와 글자까지 같아야 한다 — 할 일 줄의 `[thread:: …]` 값과
// 그대로 맞아야 메일 ↔ 할 일 연결이 된다(CLAUDE.md 규칙 6). 파이썬 원문:
//
//     RE_PREFIX = re.compile(r"^\s*(?:re|fw|fwd|답장|전달|회신)\s*[:：]\s*", re.I)
//     def norm_thread(subject):
//         s = subject or ""
//         prev = None
//         while prev != s:
//             prev = s
//             s = RE_PREFIX.sub("", s)
//         s = re.sub(r"[\[\]()★☆<>「」【】]", " ", s)
//         s = re.sub(r"\s+", " ", s).strip().lower()
//         return s[:80]

/** 메일 상태 키: m: Message-ID · u: uidl · p: 경로 — 뒤는 sha1 앞 16자(소문자 hex) */
export const MAIL_KEY_RE = /^[mup]:[0-9a-f]{16}$/;

/** 스레드 id: 'th:' + sha1(threadKey | 첫 메일 키) 앞 12자 */
export const MAIL_THREAD_ID_RE = /^th:[0-9a-f]{12}$/;

/** 이 글자 수(코드 포인트) 미만의 스레드 키는 묶지 않는다 */
export const THREAD_KEY_MIN_CHARS = 4;

/** 같은 키라도 앞 메일과 이만큼(일) 넘게 떨어지면 새 스레드 */
export const THREAD_GAP_DAYS = 60;

/** 흔한 제목 — 같은 키라도 묶지 않는다(1통 = 1스레드). normThread 를 거친 모양으로 적는다 */
export const GENERIC_THREAD_KEYS: ReadonlySet<string> = new Set([
  '제목 없음',
  '문의',
  '문의드립니다',
  '안녕하세요',
  '요청',
  '확인 요청',
  '견적 요청',
]);

/**
 * 파이썬 re `\s`(= str.isspace()) 글자 모음. src/main/wiki/pystr.ts PY_WS 와 같다(shared 는 main 을 import 하지 않아 옮겨 둔다).
 * JS `\s` 와 달리 \x1c-\x1f·\x85 를 넣고 U+FEFF 를 뺀다.
 */
const PY_WS = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const RE_PREFIX = new RegExp(`^${PY_WS}*(?:re|fw|fwd|답장|전달|회신)${PY_WS}*[:：]${PY_WS}*`, 'i');
const BRACKETS_RE = /[[\]()★☆<>「」【】]/g;
const WS_RUN_RE = new RegExp(`${PY_WS}+`, 'g');
const WS_EDGE_RE = new RegExp(`^${PY_WS}+|${PY_WS}+$`, 'g');

/** 제목 앞의 RE:·FW:·답장: 등을 모두 걷는다(normThread 와 같은 접두 규칙 — 나머지 글자는 그대로) */
export function stripSubjectPrefix(subject: string | null | undefined): string {
  let s = typeof subject === 'string' ? subject : '';
  let prev: string | null = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(RE_PREFIX, '');
  }
  return s;
}

/** 제목 → 스레드 키(open_loops norm_thread 와 같다) */
export function normThread(subject: string | null | undefined): string {
  let s = typeof subject === 'string' ? subject : '';
  let prev: string | null = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(RE_PREFIX, '');
  }
  s = s.replace(BRACKETS_RE, ' ');
  s = s.replace(WS_RUN_RE, ' ').replace(WS_EDGE_RE, '').toLowerCase();
  // 파이썬 s[:80] 은 코드 포인트 단위
  const chars = Array.from(s);
  return chars.length > 80 ? chars.slice(0, 80).join('') : s;
}

/** 이 키로 여러 메일을 묶어도 되는가(4글자 이상 · 흔한 제목 아님) */
export function isGroupableThreadKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (Array.from(key).length < THREAD_KEY_MIN_CHARS) return false;
  return !GENERIC_THREAD_KEYS.has(key);
}
