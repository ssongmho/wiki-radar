// voc-cli 로 보낼 글자 검사(CP949) — 명세 §1 "인자 글자 검사".
import { describe, expect, it } from 'vitest';
import { nonCp949Chars } from '../../src/main/voc/charset';

describe('nonCp949Chars', () => {
  it('한글·ASCII·흔한 기호는 괜찮다', () => {
    expect(nonCp949Chars('확인했습니다. 10/5 까지 처리 예정입니다 (P1) #3 & <a> ~ \\ ￦')).toEqual([]);
    expect(nonCp949Chars('· … ① ※ → 「」 ㈜ ℃')).toEqual([]);
  });

  it('줄바꿈·탭은 괜찮다', () => {
    expect(nonCp949Chars('첫 줄\n둘째 줄\r\n\t들여쓰기')).toEqual([]);
  });

  it('빈 글·문자열이 아닌 값은 빈 목록', () => {
    expect(nonCp949Chars('')).toEqual([]);
    expect(nonCp949Chars(undefined as unknown as string)).toEqual([]);
  });

  it('CP949 에 없는 글자를 처음 나온 순서로 중복 없이 돌려준다', () => {
    expect(nonCp949Chars('완료 ✓ 좋아요 😀 다시 ✓ 😀')).toEqual(['✓', '😀']);
  });

  it('서러게이트 쌍(이모지)은 한 글자로 본다', () => {
    const out = nonCp949Chars('👍🏻');
    // 손 모양 + 피부색 수정자 — 코드 포인트 둘
    expect(out).toEqual(['👍', '🏻']);
    for (const ch of out) expect([...ch]).toHaveLength(1);
  });

  it('짝 없는 서러게이트도 보낼 수 없는 글자다', () => {
    const lone = String.fromCharCode(0xd83d);
    expect(nonCp949Chars(`앞${lone}뒤`)).toEqual([lone]);
  });

  it('보이지 않는 nbsp·전각 대시처럼 CP949 에 없는 글자도 잡는다', () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(nonCp949Chars(`가${nbsp}나 — 다`)).toEqual([nbsp, '—']);
  });

  it('같은 글자를 여러 번 검사해도 결과가 같다(기억)', () => {
    expect(nonCp949Chars('é')).toEqual(['é']);
    expect(nonCp949Chars('éé')).toEqual(['é']);
    expect(nonCp949Chars('한')).toEqual([]);
  });
});
