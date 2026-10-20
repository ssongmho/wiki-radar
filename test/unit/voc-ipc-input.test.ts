// 2.6단계 VOC IPC 인자 검사(src/main/voc/ipcInput.ts) — id·actionId/createId·길이·제어 문자·웹 주소
import { describe, expect, it } from 'vitest';
import {
  VOC_DESCRIPTION_MAX,
  VOC_REPLY_MAX,
  VOC_TITLE_MAX,
  checkVocWebUrl,
  requireOpId,
  requireVocActionInput,
  requireVocCreateInput,
  requireVocId,
  requireVocLoginInput,
  requireVocText,
} from '../../src/main/voc/ipcInput';

const OP = '6f1c2a90-1b2c-4d5e-8f90-a1b2c3d4e5f6';

describe('requireVocId', () => {
  it('양의 정수만', () => {
    expect(requireVocId(1, 'ticketId')).toBe(1);
    expect(requireVocId(123456, 'ticketId')).toBe(123456);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '12', null, undefined, {}]) {
      expect(() => requireVocId(bad, 'ticketId'), String(bad)).toThrow(/양의 정수/);
    }
  });
});

describe('requireOpId', () => {
  it('영문·숫자·하이픈 8~64자', () => {
    expect(requireOpId(OP, 'actionId')).toBe(OP);
    expect(requireOpId('abcd1234', 'actionId')).toBe('abcd1234');
    expect(requireOpId('a'.repeat(64), 'actionId')).toHaveLength(64);
    for (const bad of ['abc1234', 'a'.repeat(65), 'abcd 1234', 'abcd_1234', '가나다라마바사아', `${OP}\n`, 12345678, undefined]) {
      expect(() => requireOpId(bad, 'actionId'), String(bad)).toThrow(/8~64/);
    }
  });
});

describe('requireVocText', () => {
  it('여러 줄이면 줄바꿈을 \\n 으로 맞추고 탭·줄바꿈만 받는다', () => {
    expect(requireVocText('가\r\n나\r다\t라', '답변', 100, true)).toBe('가\n나\n다\t라');
    expect(() => requireVocText('가\u0000나', '답변', 100, true)).toThrow(/제어 문자/);
    expect(() => requireVocText('가\u001b[31m', '답변', 100, true)).toThrow(/제어 문자/);
  });

  it('한 줄이면 줄바꿈도 거부, 길이·형 검사', () => {
    expect(() => requireVocText('가\n나', '제목', 100, false)).toThrow(/제어 문자/);
    expect(() => requireVocText('가'.repeat(101), '제목', 100, false)).toThrow(/100자/);
    expect(() => requireVocText(3, '제목', 100, false)).toThrow(/문자열/);
    expect(requireVocText('', '제목', 100, false)).toBe('');
  });
});

describe('requireVocActionInput', () => {
  const ok = { actionId: OP, kind: 'assign', ticketId: 42, value: '7' };

  it('알려진 필드만 돌려준다', () => {
    expect(requireVocActionInput({ ...ok, extra: 'x' })).toEqual(ok);
    expect(requireVocActionInput({ ...ok, kind: 'priority', value: ' P1 ' })).toEqual({ ...ok, kind: 'priority', value: 'P1' });
    expect(requireVocActionInput({ ...ok, kind: 'ictDue', value: '' })).toEqual({ ...ok, kind: 'ictDue', value: '' });
    expect(requireVocActionInput({ ...ok, kind: 'status', value: 'pending' }).value).toBe('pending');
  });

  it('답변은 여러 줄·5,000자까지, 비어 있으면 거부', () => {
    expect(requireVocActionInput({ ...ok, kind: 'reply', value: '확인했습니다.\r\n- 조치 내용' }).value).toBe('확인했습니다.\n- 조치 내용');
    expect(requireVocActionInput({ ...ok, kind: 'reply', value: '가'.repeat(VOC_REPLY_MAX) }).value).toHaveLength(VOC_REPLY_MAX);
    expect(() => requireVocActionInput({ ...ok, kind: 'reply', value: '가'.repeat(VOC_REPLY_MAX + 1) })).toThrow(/5000자/);
    expect(() => requireVocActionInput({ ...ok, kind: 'reply', value: ' \n ' })).toThrow(/답변 내용/);
  });

  it('형식이 틀리면 거부', () => {
    expect(() => requireVocActionInput(null)).toThrow(/객체/);
    expect(() => requireVocActionInput([ok])).toThrow(/객체/);
    expect(() => requireVocActionInput({ ...ok, actionId: 'short' })).toThrow(/actionId/);
    expect(() => requireVocActionInput({ ...ok, kind: 'delete' })).toThrow(/kind/);
    expect(() => requireVocActionInput({ ...ok, kind: 'resolve' })).toThrow(/kind/);
    expect(() => requireVocActionInput({ ...ok, ticketId: '42' })).toThrow(/ticketId/);
    expect(() => requireVocActionInput({ ...ok, value: '' })).toThrow(/비어/);
    expect(() => requireVocActionInput({ ...ok, value: '7\n--status closed' })).toThrow(/제어 문자/);
    expect(() => requireVocActionInput({ ...ok, value: '1'.repeat(33) })).toThrow(/32자/);
    expect(() => requireVocActionInput({ ...ok, value: 7 })).toThrow(/문자열/);
  });
});

describe('requireVocCreateInput', () => {
  const ok = {
    createId: OP,
    taskId: 'c:0123456789ab',
    title: '통영공장 인벤토리 확인 요청',
    description: '안녕하세요.\r\n확인 부탁드립니다.',
    customerId: 12,
    system: 'SYS0048',
    requestType: 'inquiry',
    priority: 'P3',
  };

  it('줄바꿈을 맞추고 제목 앞뒤 공백을 걷는다. 담당은 있을 때만', () => {
    const input = requireVocCreateInput({ ...ok, title: '  제목  ' });
    expect(input).toEqual({ ...ok, title: '제목', description: '안녕하세요.\n확인 부탁드립니다.' });
    expect(input).not.toHaveProperty('assigneeId');
    expect(requireVocCreateInput({ ...ok, assigneeId: 7 }).assigneeId).toBe(7);
    expect(requireVocCreateInput({ ...ok, assigneeId: null })).not.toHaveProperty('assigneeId');
    expect(requireVocCreateInput({ ...ok, description: '' }).description).toBe('');
  });

  it('제목 1~500자·한 줄, 내용 10,000자까지', () => {
    expect(requireVocCreateInput({ ...ok, title: '가'.repeat(VOC_TITLE_MAX) }).title).toHaveLength(VOC_TITLE_MAX);
    expect(() => requireVocCreateInput({ ...ok, title: '가'.repeat(VOC_TITLE_MAX + 1) })).toThrow(/500자/);
    expect(() => requireVocCreateInput({ ...ok, title: '   ' })).toThrow(/제목/);
    expect(() => requireVocCreateInput({ ...ok, title: '제목\n둘째 줄' })).toThrow(/제어 문자/);
    expect(() => requireVocCreateInput({ ...ok, description: '가'.repeat(VOC_DESCRIPTION_MAX + 1) })).toThrow(/10000자/);
  });

  it('id·코드·우선순위 형식', () => {
    expect(() => requireVocCreateInput({ ...ok, createId: 'x' })).toThrow(/createId/);
    expect(() => requireVocCreateInput({ ...ok, taskId: '' })).toThrow(/taskId/);
    expect(() => requireVocCreateInput({ ...ok, customerId: 0 })).toThrow(/customerId/);
    expect(() => requireVocCreateInput({ ...ok, customerId: undefined })).toThrow(/customerId/);
    expect(() => requireVocCreateInput({ ...ok, assigneeId: -3 })).toThrow(/assigneeId/);
    expect(() => requireVocCreateInput({ ...ok, system: '' })).toThrow(/시스템/);
    // '-' 로 시작하는 값이 voc-cli 옵션으로 읽히지 않게
    expect(() => requireVocCreateInput({ ...ok, system: '--assignee' })).toThrow(/시스템/);
    expect(() => requireVocCreateInput({ ...ok, requestType: 'in quiry' })).toThrow(/요청유형/);
    expect(() => requireVocCreateInput({ ...ok, priority: 'P4' })).toThrow(/우선순위/);
    expect(() => requireVocCreateInput({ ...ok, priority: undefined })).toThrow(/우선순위/);
  });
});

describe('checkVocWebUrl', () => {
  const base = 'https://voc.example.com';

  it('웹 주소와 같은 출처의 /maintenance/tickets/<id> 만', () => {
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42`, 42, base)).toBe(`${base}/maintenance/tickets/42`);
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42`, 42, `${base}/`)).toBe(`${base}/maintenance/tickets/42`);
  });

  it('다른 id·경로·출처·http·계정·검색어·조각은 거부', () => {
    expect(checkVocWebUrl(`${base}/maintenance/tickets/43`, 42, base)).toBeNull();
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42/edit`, 42, base)).toBeNull();
    expect(checkVocWebUrl('https://evil.example.org/maintenance/tickets/42', 42, base)).toBeNull();
    expect(checkVocWebUrl('https://voc.example.com:8443/maintenance/tickets/42', 42, base)).toBeNull();
    expect(checkVocWebUrl('http://voc.example.com/maintenance/tickets/42', 42, 'http://voc.example.com')).toBeNull();
    expect(checkVocWebUrl('https://u:p@voc.example.com/maintenance/tickets/42', 42, base)).toBeNull();
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42?x=1`, 42, base)).toBeNull();
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42#a`, 42, base)).toBeNull();
    expect(checkVocWebUrl('javascript:alert(1)', 42, base)).toBeNull();
  });

  it('주소를 모르면 없음, 보드 웹 주소를 모르면 https·경로만 본다', () => {
    expect(checkVocWebUrl(null, 42, base)).toBeNull();
    expect(checkVocWebUrl('not a url', 42, base)).toBeNull();
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42`, 42, undefined)).toBe(`${base}/maintenance/tickets/42`);
    expect(checkVocWebUrl('http://voc.example.com/maintenance/tickets/42', 42, undefined)).toBeNull();
    expect(checkVocWebUrl(`${base}/maintenance/tickets/42`, 42, 'not a url')).toBeNull();
  });
});

describe('requireVocLoginInput(명세 §13)', () => {
  const PW = 'Pw-unit-7f3a9c';

  it('아이디·비밀번호·아이디 기억만 골라 돌려준다', () => {
    expect(requireVocLoginInput({ loginId: 'hong', password: PW, remember: true, extra: 1 })).toEqual({ loginId: 'hong', password: PW, remember: true });
    expect(requireVocLoginInput({ loginId: 'hong', password: 'x'.repeat(256), remember: false }).remember).toBe(false);
  });

  it('형·길이·줄바꿈이 틀리면 던지고, 문장에 입력한 비밀번호를 넣지 않는다', () => {
    const cases: [unknown, RegExp][] = [
      [null, /객체가 아닙니다/],
      [[], /객체가 아닙니다/],
      [{ loginId: 7, password: PW, remember: true }, /아이디 값이 문자열이 아닙니다/],
      [{ loginId: '', password: PW, remember: true }, /아이디 길이는 1~64자/],
      [{ loginId: 'x'.repeat(65), password: PW, remember: true }, /아이디 길이는 1~64자/],
      [{ loginId: 'hong\n', password: PW, remember: true }, /아이디에 줄바꿈/],
      [{ loginId: 'hong', password: 7, remember: true }, /비밀번호 값이 문자열이 아닙니다/],
      [{ loginId: 'hong', password: '', remember: true }, /비밀번호 길이는 1~256자/],
      [{ loginId: 'hong', password: 'x'.repeat(513), remember: true }, /비밀번호 길이는 1~256자/],
      [{ loginId: 'hong', password: `${PW}\n`, remember: true }, /비밀번호에 줄바꿈이나 NUL/],
      [{ loginId: 'hong', password: `${PW}\r`, remember: true }, /비밀번호에 줄바꿈이나 NUL/],
      [{ loginId: 'hong', password: `${PW}${String.fromCharCode(0)}`, remember: true }, /비밀번호에 줄바꿈이나 NUL/],
      [{ loginId: 'hong', password: PW, remember: 'true' }, /remember/],
      [{ loginId: 'hong', password: PW }, /remember/],
    ];
    for (const [raw, pattern] of cases) {
      let message = '';
      try {
        requireVocLoginInput(raw);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(raw)).toMatch(pattern);
      expect(message).not.toContain(PW);
    }
  });
});
