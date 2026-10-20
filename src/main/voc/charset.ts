// voc-cli 로 보낼 글자 검사(CP949). electron 을 import 하지 않는다. 계약: docs/stage2.6-contract.md §1
//
// voc-cli(java)는 Windows 에서 명령줄 인자를 시스템 ANSI 코드페이지(CP949)로 받는다. 한글·ASCII 는 그대로 가지만
// 이모지처럼 CP949 에 없는 글자는 `?`(또는 비슷한 글자)로 바뀌어 VOC 에 저장된다. 쓰기 전에 그런 글자를 찾아
// 사람이 지우거나 바꾸게 한다(앱이 몰래 바꾸지 않는다).
import iconv from 'iconv-lite';

/** 글자 하나 → CP949 왕복이 되는가(한 번 본 글자는 기억한다) */
const roundTripCache = new Map<string, boolean>();
/** 기억할 글자 수 상한(그 뒤는 기억하지 않고 매번 본다) */
const CACHE_LIMIT = 20_000;

/** 검사하지 않는 글자: 줄바꿈·탭(voc-cli 인자로 그대로 간다) */
const ALWAYS_OK: ReadonlySet<string> = new Set(['\n', '\r', '\t']);

function roundTrips(ch: string): boolean {
  // ASCII 는 CP949 에서 같은 바이트다
  if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return true;
  const known = roundTripCache.get(ch);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    ok = iconv.decode(iconv.encode(ch, 'cp949'), 'cp949') === ch;
  } catch {
    ok = false;
  }
  if (roundTripCache.size < CACHE_LIMIT) roundTripCache.set(ch, ok);
  return ok;
}

/**
 * CP949 로 왕복하지 못하는 글자(중복 없이 처음 나온 순서). 서러게이트 쌍(이모지 등)은 한 글자로 본다.
 * 짝 없는 서러게이트도 보낼 수 없는 글자로 돌려준다. 줄바꿈·탭은 괜찮다.
 */
export function nonCp949Chars(text: string): string[] {
  if (typeof text !== 'string' || text === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // for…of 는 코드 포인트 단위로 돈다(서러게이트 쌍 = 한 번)
  for (const ch of text) {
    if (ALWAYS_OK.has(ch) || seen.has(ch)) continue;
    seen.add(ch);
    if (!roundTrips(ch)) out.push(ch);
  }
  return out;
}
