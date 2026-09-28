// 체크박스 줄: 필드 파싱·상태·표시 제목·핵심문구·ID (명세 §1-2 ~ §1-4)
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkboxAnchorMatch,
  checkboxId,
  checkboxSyncTitle,
  codePointLength,
  codePointSlice,
  coreOf,
  curatedId,
  displayTitle,
  hasMyTaskTag,
  isCheckboxLine,
  isStDone,
  lineStatus,
  parseFields,
} from '../../src/main/wiki/checkbox';

const sha12 = (s: string) => createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);

describe('체크박스 줄 판정', () => {
  it.each([
    ['- [ ] 할 일', true],
    ['- [x] 끝난 일', true],
    ['- [X] 끝난 일', true],
    ['  - [ ] 들여쓴 줄은 할 일이 아니다', false],
    ['\t- [ ] 탭 들여쓰기', false],
    ['- [ ]붙은 글', false],
    ['* [ ] 별표 목록', false],
    ['- [-] 취소 표시', false],
    ['- 일반 목록', false],
    ['-[ ] 공백 없음', false],
  ])('%s → %s', (line, expected) => {
    expect(isCheckboxLine(line)).toBe(expected);
  });
});

describe('#내할일 태그', () => {
  it.each([
    ['- [ ] 할 일 #내할일', true],
    ['- [ ] 할 일 #내할일 [due:: 2026-09-23]', true],
    ['- [ ] 팀 회의록 공유 #내할일, 사업부 채널에', true],
    ['- [ ] #내할일/하위 태그', true],
    ['- [ ] 할 일 #내할일가', false],
    ['- [ ] 할 일 #내할일abc', false],
    ['- [ ] 할 일 #내할일2', false],
    ['- [ ] 할 일 #내할일ㅋ', false],
    ['- [ ] 할 일 내할일', false],
    ['- [ ] 할 일', false],
  ])('%s → %s', (line, expected) => {
    expect(hasMyTaskTag(line)).toBe(expected);
  });

  it('여러 번 불러도 결과가 같다(정규식 상태가 남지 않는다)', () => {
    const line = '- [ ] 할 일 #내할일';
    expect([hasMyTaskTag(line), hasMyTaskTag(line), hasMyTaskTag(line)]).toEqual([true, true, true]);
  });
});

describe('필드 파싱', () => {
  const line =
    '- [ ] 🔴 한결케미칼 통영공장 인벤토리 사용량 미반영 — 검토·회신 (EHS팀) #내할일 [pri:: 1] [due:: 2026-09-18] ' +
    '[mail:: raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md] ' +
    '[opened:: 2026-09-15] [열림:: 7영업일] [재촉:: 2회] [thread:: 통영공장 인벤토리 확인 요청]';

  it('알려진 키', () => {
    expect(parseFields(line)).toEqual({
      pri: 1,
      due: '2026-09-18',
      mail: 'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md',
      opened: '2026-09-15',
      openDays: 7,
      chaseCount: 2,
      thread: '통영공장 인벤토리 확인 요청',
      hasOwner: false,
      hasWip: false,
    });
  });

  it('owner·wip·done·st', () => {
    const f = parseFields('- [ ] 일 [owner:: 김담당] [wip:: 2026-09-20] [done:: 2026-09-21] [st:: 보류]');
    expect(f).toMatchObject({ owner: '김담당', hasOwner: true, wip: '2026-09-20', hasWip: true, done: '2026-09-21', st: '보류' });
  });

  it('모르는 키는 무시한다', () => {
    const f = parseFields('- [ ] 일 [foo:: bar] [우선:: 1]');
    expect(f).toEqual({ hasOwner: false, hasWip: false });
  });

  it('날짜 형식이 아니면 무시한다', () => {
    expect(parseFields('- [ ] 일 [due:: 2026-9-18]').due).toBeUndefined();
    expect(parseFields('- [ ] 일 [due:: 2026-02-30]').due).toBeUndefined();
    expect(parseFields('- [ ] 일 [due:: 다음 주]').due).toBeUndefined();
    expect(parseFields('- [ ] 일 [opened:: 어제]').opened).toBeUndefined();
    expect(parseFields('- [ ] 일 [due:: 2028-02-29]').due).toBe('2028-02-29');
  });

  it('형식이 안 맞는 숫자 값은 무시한다', () => {
    const f = parseFields('- [ ] 일 [pri:: 높음] [열림:: 7일] [재촉:: 두 번]');
    expect(f.pri).toBeUndefined();
    expect(f.openDays).toBeUndefined();
    expect(f.chaseCount).toBeUndefined();
  });

  it('값 앞뒤 공백·키 공백을 다듬는다', () => {
    expect(parseFields('- [ ] 일 [ due ::   2026-09-18  ]').due).toBe('2026-09-18');
    expect(parseFields('- [ ] 일 [pri::2]').pri).toBe(2);
  });

  it('같은 키가 여럿이면 처음 것', () => {
    expect(parseFields('- [ ] 일 [due:: 2026-09-18] [due:: 2026-09-30]').due).toBe('2026-09-18');
  });

  it('mail 은 raw/mail/ 경로만, 역슬래시는 / 로', () => {
    expect(parseFields('- [ ] 일 [mail:: wiki/x.md]').mail).toBeUndefined();
    expect(parseFields('- [ ] 일 [mail:: raw\\mail\\a\\b.md]').mail).toBe('raw/mail/a/b.md');
  });

  it('값 안에 짝 맞는 대괄호가 든 메일 경로', () => {
    const l = '- [ ] 선물 리스트 제출 #내할일 [mail:: raw/mail/사내/2026/2026-09-01_[공지] 선물 리스트 제출_2914b9.md] [pri:: 2]';
    expect(parseFields(l)).toMatchObject({ mail: 'raw/mail/사내/2026/2026-09-01_[공지] 선물 리스트 제출_2914b9.md', pri: 2 });
    expect(displayTitle(l)).toBe('선물 리스트 제출');
  });

  it('값 안에 짝 없는 여는 대괄호', () => {
    const l = '- [ ] 일 [mail:: raw/mail/a/2026/[공지 안내.md] [pri:: 2]';
    expect(parseFields(l)).toMatchObject({ mail: 'raw/mail/a/2026/[공지 안내.md', pri: 2 });
    expect(displayTitle(l)).toBe('일');
  });
});

describe('상태', () => {
  it.each([
    ['- [ ] 일', 'open'],
    ['- [x] 일', 'done'],
    ['- [X] 일', 'done'],
    ['- [ ] 일 [wip:: 2026-09-20]', 'wip'],
    ['- [x] 일 [wip:: 2026-09-20]', 'done'],
    ['- [ ] 일 [owner:: 김담당]', 'notmine'],
    ['- [x] 일 [owner:: 김담당]', 'notmine'],
    ['- [ ] 일 [owner:: ]', 'notmine'],
    ['- [ ] 일 [done:: 2026-09-20]', 'open'],
    // 2단계 §4: [st:: 완료](공백 무시) → done, 그 밖의 st 는 상태에 영향 없음
    ['- [ ] 일 [st:: 완료]', 'done'],
    ['- [ ] 일 [st::완료]', 'done'],
    ['- [ ] 일 [st::  완 료 ]', 'done'],
    ['- [ ] 일 [ st :: 완료]', 'done'],
    ['- [ ] 일 [wip:: 2026-09-20] [st:: 완료]', 'done'],
    ['- [ ] 일 [owner:: 김담당] [st:: 완료]', 'notmine'],
    ['- [ ] 일 [st:: 협의]', 'open'],
    ['- [ ] 일 [st:: 진행]', 'open'],
    ['- [ ] 일 [st:: 미완료]', 'open'],
    ['- [ ] 일 [st:: 완료 예정]', 'open'],
    ['- [ ] 일 [wip:: 2026-09-20] [st:: 확인]', 'wip'],
  ])('%s → %s', (line, expected) => {
    expect(lineStatus(line)).toBe(expected);
  });

  it('isStDone', () => {
    expect(isStDone('완료')).toBe(true);
    expect(isStDone(' 완 료\t')).toBe(true);
    expect(isStDone(undefined)).toBe(false);
    expect(isStDone('')).toBe(false);
    expect(isStDone('완료함')).toBe(false);
  });

  it('st 값은 필드로 읽힌다', () => {
    expect(parseFields('- [ ] 일 [st:: 협의] [due:: 2026-10-12]')).toMatchObject({ st: '협의', due: '2026-10-12' });
  });
});

describe('sync_todo 제목·앵커 문구 (2단계 명세 §1-1)', () => {
  it('코드 포인트 단위(파이썬 str 처럼)', () => {
    expect(codePointLength('🔴가')).toBe(2);
    expect(codePointSlice('🔴🟡가나', 3)).toBe('🔴🟡가');
    expect(codePointSlice('가', 5)).toBe('가');
  });

  it('제목: 핵심문구가 70자를 넘으면 앞 70자 + …', () => {
    const core = '🔴' + '가'.repeat(70);
    expect(checkboxSyncTitle(`- [ ] ${core} [due:: 2026-10-01]`)).toBe('🔴' + '가'.repeat(69) + '…');
    expect(checkboxSyncTitle('- [ ] 짧은 일 #내할일 [pri:: 1]')).toBe('짧은 일 #내할일');
  });

  it('앵커 문구: 핵심문구 앞 40자', () => {
    const core = '🔴🟡' + '나'.repeat(50);
    expect(checkboxAnchorMatch(`- [x] ${core} [done:: 2026-09-01]`)).toBe('🔴🟡' + '나'.repeat(38));
    expect(checkboxAnchorMatch('- [ ] 짧은 일 [pri:: 1]')).toBe('짧은 일');
  });
});

describe('표시 제목', () => {
  it.each([
    ['- [ ] 🔴 서진화학 EHS 잔여 오류 목록 — 우선순위 회신 #내할일 [pri:: 1]', '서진화학 EHS 잔여 오류 목록 — 우선순위 회신'],
    ['- [ ] **월간 리포트** 초안 작성 #내할일 [pri:: 2] [due:: 2026-09-30]', '월간 리포트 초안 작성'],
    ['- [ ] [[한결케미칼|한결]] 계약 검토', '한결 계약 검토'],
    ['- [ ] [[CMS 인벤토리 사용량 집계]] 확인', 'CMS 인벤토리 사용량 집계 확인'],
    ['- [ ] 팀 회의록 공유 #내할일, 사업부 채널에 [due:: 2026-09-22]', '팀 회의록 공유, 사업부 채널에'],
    ['- [ ] 명함 제출 (표준템플릿 ) 끝 .', '명함 제출 (표준템플릿) 끝.'],
    ['- [ ]   여러    칸   공백  ', '여러 칸 공백'],
    ['- [x] ⚠️ 경고 표시 #내할일', '경고 표시'],
    ['- [ ] 🔴🟡 두 개 #내할일', '두 개'],
    ['- [ ] 👍🏽 피부색 수식자', '피부색 수식자'],
    ['- [ ] 🇰🇷 국기', '국기'],
    ['- [ ] 1️⃣ 숫자 키캡은 글자가 남는다', '1️⃣ 숫자 키캡은 글자가 남는다'],
    ['- [ ] #내할일 🔴 태그가 앞에', '태그가 앞에'],
    ['- [ ] 가운데 🔴 그림은 둔다', '가운데 🔴 그림은 둔다'],
    ['- [ ] 다른 태그 #내할일가 는 남는다', '다른 태그 #내할일가 는 남는다'],
  ])('%s', (line, expected) => {
    expect(displayTitle(line)).toBe(expected);
  });
});

describe('핵심문구·ID', () => {
  const FILE = '_private/mgmt/내 할 일.md';

  it('핵심문구 = 체크박스·필드를 뗀 뒤 앞뒤 공백 제거(태그·그림 문자는 남는다)', () => {
    expect(coreOf('- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]')).toBe('법인카드 지출결의서 작성 #내할일');
    expect(coreOf('- [x] 🔴 **굵게** 일 [done:: 2026-09-20]')).toBe('🔴 **굵게** 일');
    expect(coreOf('- [ ] 앞 [pri:: 1] 뒤')).toBe('앞 뒤');
  });

  // 기대값은 build_todo.py core_of 를 파이썬으로 직접 돌려 얻은 것이다(글자 단위로 같아야 ID 가 같다).
  it.each([
    ['- [ ] 앞 [pri:: 1] 뒤', '앞 뒤'],
    ['- [ ]   여러 공백 시작 [due:: 2026-09-23]', '여러 공백 시작'],
    ['- [ ] 키에 공백 [due date:: x] 남음', '키에 공백 [due date:: x] 남음'],
    ['- [ ] 메일 [mail:: raw/mail/a/_[공지] 제목.md] 끝', '메일 제목.md] 끝'],
    ['- [ ] 한글 키 [열림:: 7영업일] [재촉:: 2회]', '한글 키'],
    ['- [X] 대문자 X\t[done:: 2026-09-01]\r', '대문자 X'],
    // 파이썬 공백 규칙(JS \s·trim 과 다른 글자): U+FEFF 는 글자, \x1c-\x1f·\x85 는 공백
    ['- [ ] 일 [pri:: 1]﻿', '일﻿'],
    ['- [ ] ﻿일 [pri:: 1]', '﻿일'],
    ['- [ ] 일\x1c[pri:: 1] 끝', '일 끝'],
    ['- [ ] 특이 공백 #내할일 [pri:: 1]\x85', '특이 공백 #내할일'],
    ['- [ ]\x85앞 공백 [due:: 2026-09-23]', '앞 공백'],
    ['- [ ] 끝 분리\x1f', '끝 분리'],
    ['- [ ] 줄 구분 [pri:: 1]', '줄 구분'],
  ])('build_todo core_of 와 같다: %j', (line, expected) => {
    expect(coreOf(line)).toBe(expected);
  });

  it('체크박스 ID 는 고정 값이다', () => {
    const line = '- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]';
    expect(checkboxId(FILE, line)).toBe('c:213ed98fa26d');
    expect(checkboxId(FILE, line)).toBe('c:' + sha12(`${FILE}|법인카드 지출결의서 작성 #내할일`));
  });

  it('필드·체크 상태가 바뀌어도 ID 는 같다', () => {
    const a = checkboxId(FILE, '- [ ] 주간 업무보고 작성 #내할일 [pri:: 2] [due:: 2026-09-25]');
    const b = checkboxId(FILE, '- [x] 주간 업무보고 작성 #내할일 [pri:: 1] [due:: 2026-10-02] [done:: 2026-09-25]');
    const c = checkboxId(FILE, '- [ ] 주간 업무보고 작성 #내할일   [wip:: 2026-09-24]');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('파일이나 문장이 다르면 ID 가 다르다', () => {
    const line = '- [ ] 주간 업무보고 작성 #내할일';
    expect(checkboxId('wiki/entities/한결케미칼.md', line)).not.toBe(checkboxId(FILE, line));
    expect(checkboxId(FILE, '- [ ] 주간 업무보고 작성')).not.toBe(checkboxId(FILE, line));
  });

  it('큐레이션 ID 는 제목의 sha1 앞 12자', () => {
    expect(curatedId('LDAR 견적서 회신')).toBe('i:91b581d0bccc');
    expect(curatedId('LDAR 견적서 회신')).toBe('i:' + sha12('LDAR 견적서 회신'));
    expect(curatedId('LDAR 견적서 회신 ')).not.toBe(curatedId('LDAR 견적서 회신'));
  });
});
