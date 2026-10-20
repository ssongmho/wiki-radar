// 스레드 키 normThread — open_loops.py norm_thread 와 글자까지 같은지(docs/stage2.10-contract.md §2-3).
// 기대값은 파이썬 norm_thread 를 같은 입력으로 돌려 얻은 것이다.
import { describe, expect, it } from 'vitest';
import {
  GENERIC_THREAD_KEYS,
  MAIL_KEY_RE,
  MAIL_THREAD_ID_RE,
  isGroupableThreadKey,
  normThread,
} from '../../src/shared/mailThread';

const ch = (code: number): string => String.fromCharCode(code);

describe('normThread', () => {
  const cases: [string, string][] = [
    ['RE: RE: 통영공장 CMS 인벤토리 사용량 확인 요청', '통영공장 cms 인벤토리 사용량 확인 요청'],
    ['Fwd: FW:  [BDS] NEXACRO 라이선스 (2026년 2월분)', 'bds nexacro 라이선스 2026년 2월분'],
    [`회신${ch(0xff1a)} 답장:전달 : 견적 요청`, '견적 요청'],
    ['  re:Re :RE: Hello   World ', 'hello world'],
    ['★긴급★ 【공지】 「안내」 <중요> 서버 점검', '긴급 공지 안내 중요 서버 점검'],
    [`${ch(0x3000)}RE:${ch(0x3000)}전각 공백`, '전각 공백'],
    ['', ''],
    ['RE: 문의', '문의'],
    [`RE:FWD:fw: x${ch(0x1c)}y`, 'x y'],
    [`제목${ch(0x85)}끝`, '제목 끝'],
    ['ÄBC İ test', `äbc i${ch(0x307)} test`],
  ];
  it.each(cases)('%j → %j', (input, expected) => {
    expect(normThread(input)).toBe(expected);
  });

  it('80글자(코드 포인트)에서 자른다', () => {
    expect(normThread(`Re: ${'가'.repeat(100)}`)).toBe('가'.repeat(80));
    const emoji = '😀'.repeat(90);
    expect(Array.from(normThread(emoji)).length).toBe(80);
  });

  it('없는 값은 빈 키', () => {
    expect(normThread(undefined)).toBe('');
    expect(normThread(null)).toBe('');
  });

  it('접두가 중간에 있으면 걷지 않는다', () => {
    expect(normThread('견적 RE: 요청')).toBe('견적 re: 요청');
  });
});

describe('isGroupableThreadKey', () => {
  it('짧은 키·흔한 제목은 묶지 않는다', () => {
    expect(isGroupableThreadKey('abc')).toBe(false);
    expect(isGroupableThreadKey('가나다')).toBe(false);
    expect(isGroupableThreadKey('가나다라')).toBe(true);
    for (const k of GENERIC_THREAD_KEYS) expect(isGroupableThreadKey(k)).toBe(false);
    expect(isGroupableThreadKey(normThread('(제목 없음)'))).toBe(false);
    expect(isGroupableThreadKey(normThread('RE: 문의드립니다'))).toBe(false);
    expect(isGroupableThreadKey(normThread('통영공장 인벤토리 확인 요청'))).toBe(true);
  });
});

describe('키 형식', () => {
  it('메일 키·스레드 id', () => {
    expect(MAIL_KEY_RE.test('m:0123456789abcdef')).toBe(true);
    expect(MAIL_KEY_RE.test('x:0123456789abcdef')).toBe(false);
    expect(MAIL_KEY_RE.test('m:0123456789ABCDEF')).toBe(false);
    expect(MAIL_THREAD_ID_RE.test('th:0123456789ab')).toBe(true);
    expect(MAIL_THREAD_ID_RE.test('th:0123456789a')).toBe(false);
  });
});
