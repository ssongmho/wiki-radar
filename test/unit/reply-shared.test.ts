// 회신 공유 함수(src/shared/reply.ts) — 주소 파싱·검사, 제목 접두, 본문 검사·조립, 설정 검사(명세 §1·§2·§5-2)
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_MARK,
  REPLY_LIMITS,
  addressOf,
  assembleReplyBody,
  displayNameOf,
  formatAddress,
  isValidAddress,
  replyProblem,
  replySubject,
  sameAddress,
  settingsProblem,
  splitAddressList,
  stripReplyPrefixes,
} from '../../src/shared/reply';

describe('splitAddressList', () => {
  it('쉼표·세미콜론·줄바꿈으로 나누고 공백·빈 항목을 걷는다', () => {
    expect(splitAddressList(' a@b.co , c@d.co;e@f.co\n\r\ng@h.co ,, ; ')).toEqual(['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co']);
  });

  it('따옴표·꺾쇠 안은 나누지 않는다', () => {
    expect(splitAddressList('"Kim, Hong" <kim@x.co>, 이름 <a,b@c.co>; "세미;콜론" <s@x.co>')).toEqual([
      '"Kim, Hong" <kim@x.co>',
      '이름 <a,b@c.co>',
      '"세미;콜론" <s@x.co>',
    ]);
  });

  it('따옴표 안의 \\" 이스케이프를 넘긴다', () => {
    expect(splitAddressList('"a \\"b, c\\"" <x@y.co>, z@y.co')).toEqual(['"a \\"b, c\\"" <x@y.co>', 'z@y.co']);
  });

  it('빈 글·문자열 아닌 값은 빈 목록', () => {
    expect(splitAddressList('')).toEqual([]);
    expect(splitAddressList('  \n ')).toEqual([]);
    expect(splitAddressList(undefined as unknown as string)).toEqual([]);
  });
});

describe('addressOf · displayNameOf', () => {
  it.each([
    ['a@b.co', 'a@b.co', ''],
    ['  A.Kim@Example.CO  ', 'A.Kim@Example.CO', ''],
    ['한결케미칼 EHS팀 <ehs@hangyeol.example>', 'ehs@hangyeol.example', '한결케미칼 EHS팀'],
    ['"Kim, Hong" <kim@x.co>', 'kim@x.co', 'Kim, Hong'],
    ['"a \\"b\\"" <x@y.co>', 'x@y.co', 'a b'],
    ['<only@x.co>', 'only@x.co', ''],
    ['이름<붙음@x.co>', '붙음@x.co', '이름'],
  ])('%s', (item, addr, name) => {
    expect(addressOf(item)).toBe(addr);
    expect(displayNameOf(item)).toBe(name);
  });

  it.each([
    [''],
    ['   '],
    ['이름만'],
    ['a@b'],
    ['a@@b.co'],
    ['a b@c.co'],
    ['이름 <a@b.co'],
    ['이름 <a@b.co> 뒤'],
    ['<a@b.co> <c@d.co>'],
    ['a@b.co\r\nBcc: x@y.z'],
    ['a@b.co\nBcc: x@y.z'],
    ['이름\r\nBcc: x@y.z <a@b.co>'],
    ['a@b.co\u0000'],
    ['"q"@b.co'],
    ['a@b.co,c@d.co'],
  ])('형식이 틀리면 null: %j', (item) => {
    expect(addressOf(item)).toBeNull();
  });

  it('문자열이 아니면 null · 빈 이름', () => {
    expect(addressOf(42 as unknown as string)).toBeNull();
    expect(displayNameOf(null as unknown as string)).toBe('');
  });

  it('이름의 따옴표·줄바꿈은 걷는다', () => {
    expect(displayNameOf('"a\r\nb" <x@y.co>')).toBe('a b');
    expect(displayNameOf('a"b <x@y.co>')).toBe('ab');
    // 이름 안에 꺾쇠가 있으면 이름·주소를 가를 수 없다 — 주소도 틀린 것으로 본다
    expect(displayNameOf('"a<b>" <x@y.co>')).toBe('');
    expect(addressOf('"a<b>" <x@y.co>')).toBeNull();
  });
});

describe('isValidAddress', () => {
  it('명세 §1 정규식', () => {
    expect(isValidAddress('a@b.co')).toBe(true);
    expect(isValidAddress('first.last+tag@sub.example.co.kr')).toBe(true);
    expect(isValidAddress('한글@도메인.한국')).toBe(true);
    for (const bad of ['a@b', '@b.co', 'a@.co', 'a@b.', 'a(b)@c.co', 'a@b.co ', 'a:b@c.co', 'a\\b@c.co', 'a[b]@c.co', 'a;b@c.co']) {
      expect(isValidAddress(bad), bad).toBe(false);
    }
    expect(isValidAddress(undefined as unknown as string)).toBe(false);
  });
});

describe('formatAddress · sameAddress', () => {
  it('이름이 있으면 이름 <주소>, 없으면 주소', () => {
    expect(formatAddress('홍길동', 'owner@example.com')).toBe('홍길동 <owner@example.com>');
    expect(formatAddress('', 'owner@example.com')).toBe('owner@example.com');
    expect(formatAddress('  ', 'owner@example.com')).toBe('owner@example.com');
  });

  it('이름의 따옴표·꺾쇠·줄바꿈을 걷는다', () => {
    expect(formatAddress('"악\r\nBcc: x@y.z" <', 'a@b.co')).toBe('악 Bcc: x@y.z <a@b.co>');
  });

  it('쉼표·세미콜론이 든 이름은 따옴표로 감싸 다시 나눠도 한 주소로 남는다', () => {
    const s = formatAddress('Kim, Hong', 'kim@x.co');
    expect(s).toBe('"Kim, Hong" <kim@x.co>');
    expect(splitAddressList(`${s}, other@x.co`)).toEqual([s, 'other@x.co']);
    expect(addressOf(s)).toBe('kim@x.co');
    expect(displayNameOf(s)).toBe('Kim, Hong');
  });

  it('주소만 대소문자 무시로 비교한다', () => {
    expect(sameAddress('Owner@Example.com', '홍길동 <owner@example.COM>')).toBe(true);
    expect(sameAddress('a@b.co', 'a@b.com')).toBe(false);
    expect(sameAddress('이름만', '이름만')).toBe(false);
  });
});

describe('제목 접두', () => {
  it.each([
    ['RE: 통영공장 확인 요청', '통영공장 확인 요청'],
    ['Re: re: RE:제목', '제목'],
    ['FW: Fwd: 전달: 회신: 답장: 제목', '제목'],
    ['fwd : 제목', '제목'],
    ['RE： 전각 콜론', '전각 콜론'],
    ['회신：RE: 섞임', '섞임'],
    ['  RE:  앞뒤 공백  ', '앞뒤 공백'],
    ['READ: 접두 아님', 'READ: 접두 아님'],
    ['Report: 접두 아님', 'Report: 접두 아님'],
    ['제목 RE: 가운데', '제목 RE: 가운데'],
    ['RE:', ''],
    ['', ''],
  ])('%j → %j', (subject, stripped) => {
    expect(stripReplyPrefixes(subject)).toBe(stripped);
  });

  it('RE: 를 한 번 붙이고, 비면 (제목 없음)', () => {
    expect(replySubject('RE: RE: FW: 통영공장 CMS 인벤토리')).toBe('RE: 통영공장 CMS 인벤토리');
    expect(replySubject('인벤토리')).toBe('RE: 인벤토리');
    expect(replySubject('')).toBe('RE: (제목 없음)');
    expect(replySubject('Re: ')).toBe('RE: (제목 없음)');
    expect(replySubject(undefined as unknown as string)).toBe('RE: (제목 없음)');
  });

  it('제목 안의 줄바꿈은 공백 하나로', () => {
    expect(replySubject('RE: 첫 줄\r\n 둘째 줄')).toBe('RE: 첫 줄 둘째 줄');
  });
});

describe('replyProblem', () => {
  const ok = { to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'], cc: ['cc@x.co'], subject: 'RE: 제목', body: '안녕하세요.\n\t확인했습니다.' };

  it('맞으면 null', () => {
    expect(replyProblem(ok)).toBeNull();
    expect(replyProblem({ ...ok, body: '줄\r\n바꿈' })).toBeNull();
  });

  it('받는사람이 없으면', () => {
    expect(replyProblem({ ...ok, to: [] })).toContain('받는사람');
  });

  it('받는사람+참조 20명까지', () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}@x.co`);
    expect(replyProblem({ ...ok, to: many(10, 't'), cc: many(10, 'c') })).toBeNull();
    const p = replyProblem({ ...ok, to: many(10, 't'), cc: many(11, 'c') });
    expect(p).toContain(`${REPLY_LIMITS.recipients}명`);
    expect(p).toContain('21명');
  });

  it('주소 형식·머리말 주입을 거부한다', () => {
    expect(replyProblem({ ...ok, to: ['a@b.co\r\nBcc: x@y.z'] })).toMatch(/^받는사람 주소 형식이 맞지 않습니다/);
    expect(replyProblem({ ...ok, cc: ['이름만'] })).toMatch(/^참조 주소 형식이 맞지 않습니다: 이름만/);
    expect(replyProblem({ ...ok, to: [42 as unknown as string] })).toContain('주소 형식');
    expect(replyProblem({ ...ok, to: 'a@b.co' as unknown as string[] })).toContain('형식');
  });

  it('제목 1~300자, 줄바꿈·제어 문자 없음', () => {
    expect(replyProblem({ ...ok, subject: '' })).toContain('제목');
    expect(replyProblem({ ...ok, subject: '   ' })).toContain('제목');
    expect(replyProblem({ ...ok, subject: '가'.repeat(300) })).toBeNull();
    expect(replyProblem({ ...ok, subject: '가'.repeat(301) })).toContain('300자');
    expect(replyProblem({ ...ok, subject: 'RE: 제목\r\nBcc: x@y.z' })).toContain('줄바꿈');
    expect(replyProblem({ ...ok, subject: 'RE:\t탭' })).toContain('제어 문자');
  });

  it('본문: 공백만이면 거부, 20,000자까지, 줄바꿈·탭 밖의 제어 문자 없음', () => {
    expect(replyProblem({ ...ok, body: ' \n\t ' })).toContain('본문');
    expect(replyProblem({ ...ok, body: '가'.repeat(20000) })).toBeNull();
    expect(replyProblem({ ...ok, body: '가'.repeat(20001) })).toContain('20,000자');
    expect(replyProblem({ ...ok, body: '벨\u0007' })).toContain('제어 문자');
    expect(replyProblem({ ...ok, body: 'NUL\u0000' })).toContain('제어 문자');
  });

  it('[확인 필요 가 남아 있으면 거부한다', () => {
    const p = replyProblem({ ...ok, body: '완료 예정일은 [확인 필요: 완료 예정일] 입니다.' });
    expect(p).toBe('초안의 [확인 필요: …] 표시를 채우거나 지운 뒤 보내세요');
    expect(replyProblem({ ...ok, body: `앞 ${CONFIRM_MARK}` })).toBe(p);
    expect(replyProblem({ ...ok, body: '확인 필요한 점은 없습니다' })).toBeNull();
  });

  it('입력이 객체가 아니면', () => {
    expect(replyProblem(null as unknown as Parameters<typeof replyProblem>[0])).toContain('형식');
  });
});

describe('assembleReplyBody', () => {
  const quote = '-----Original Message-----\nFrom: a@b.co\n\n원문';

  it('본문 → 서명 → 인용 순서, 사이는 빈 줄 하나', () => {
    expect(assembleReplyBody('안녕하세요.\n\n', '홍길동\n한결소프트', quote)).toBe(
      `안녕하세요.\n\n홍길동\n한결소프트\n\n${quote}`,
    );
  });

  it('서명이 비었으면 서명 없이, 인용이 null 이면 인용 없이', () => {
    expect(assembleReplyBody('본문', '', quote)).toBe(`본문\n\n${quote}`);
    expect(assembleReplyBody('본문', '  \n ', null)).toBe('본문');
    expect(assembleReplyBody('본문  \n', '서명', null)).toBe('본문\n\n서명');
  });

  it('줄바꿈은 LF 로', () => {
    expect(assembleReplyBody('가\r\n나\r다', '서\r\n명', 'Q\r\nR')).toBe('가\n나\n다\n\n서\n명\n\nQ\nR');
  });

  it('본문 앞 공백·빈 줄은 그대로 둔다(trimEnd 만)', () => {
    expect(assembleReplyBody('\n  들여쓰기\n', '', null)).toBe('\n  들여쓰기');
  });
});

describe('settingsProblem', () => {
  it('맞으면 null', () => {
    expect(settingsProblem({ fromName: '', signature: '' })).toBeNull();
    expect(settingsProblem({ fromName: '홍길동', signature: '홍길동\n한결소프트\t팀' })).toBeNull();
    expect(settingsProblem({ fromName: '가'.repeat(60), signature: '가'.repeat(2000) })).toBeNull();
  });

  it('보내는 이름: 60자까지, 줄바꿈·제어 문자·" < > 없음', () => {
    expect(settingsProblem({ fromName: '가'.repeat(61), signature: '' })).toContain('60자');
    for (const bad of ['송\n명호', '송\t명호', '"홍길동"', '송<명호>', '송>']) {
      expect(settingsProblem({ fromName: bad, signature: '' }), bad).toContain('보내는 이름');
    }
  });

  it('서명: 2,000자까지, 탭·줄바꿈 밖의 제어 문자 없음', () => {
    expect(settingsProblem({ fromName: '', signature: '가'.repeat(2001) })).toContain('2,000자');
    expect(settingsProblem({ fromName: '', signature: '서명\u0001' })).toContain('제어 문자');
  });

  it('형이 틀리면', () => {
    expect(settingsProblem({ fromName: 1 as unknown as string, signature: '' })).toContain('형식');
    expect(settingsProblem({ fromName: '', signature: null as unknown as string })).toContain('형식');
  });
});
