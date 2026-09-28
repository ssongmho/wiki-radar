// 파이썬 문자열 규칙 옮김(공백). electron 을 import 하지 않는 순수 모듈이다.
// build_todo.py·sync_todo.py 와 글자 단위로 같아야 하는 곳(체크박스 핵심문구·관리필드·로그·메모)이 함께 쓴다.
//
// 파이썬 re 의 `\s` 와 str.strip() 은 str.isspace() 인 글자를 공백으로 본다. JS 의 `\s`·trim() 과 다른 글자:
//   - 파이썬만 공백: \x1c-\x1f(정보 분리 문자), \x85(NEL)
//   - JS 만 공백: U+FEFF(BOM, 줄 가운데에 있으면 파이썬에는 보통 글자)
// 그래서 파이썬과 같은 결과가 필요한 곳에서는 JS `\s`·trim() 대신 아래를 쓴다.

/** 파이썬 str.isspace() 인 글자(= 파이썬 re 의 `\s`). 모두 BMP 라 코드 단위로 본다 */
export const PY_SPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** PY_SPACE 를 정규식 글자 모음으로(파이썬 `\s` 자리에 쓴다. `u` 깃발이 있어도 없어도 된다) */
export const PY_WS = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

/** 파이썬 `s.rstrip()` */
export function pyRstrip(s: string): string {
  let end = s.length;
  while (end > 0 && PY_SPACE.has(s.charCodeAt(end - 1))) end--;
  return s.slice(0, end);
}

/** 파이썬 `s.strip()` */
export function pyStrip(s: string): string {
  let start = 0;
  while (start < s.length && PY_SPACE.has(s.charCodeAt(start))) start++;
  return pyRstrip(s.slice(start));
}
