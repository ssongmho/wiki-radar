// 2.15단계 §A-4 MIME 파서 — mailhost_mail.py parse_message 이식. 합성 메일만(실제 메일 없음).
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { decodeHeader, decodeQuotedPrintable, defang, htmlToText, parseMessage, parseParamHeader, safeDecode } from '../../src/main/mail/mimeParse';

const crlf = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8');
const b64 = (s: string, enc = 'utf8'): string => (enc === 'utf8' ? Buffer.from(s, 'utf8') : iconv.encode(s, enc)).toString('base64');

describe('머리 풀기', () => {
  it('RFC 2047 B·Q, euc-kr·utf-8, 이웃한 낱말 사이 공백은 지운다', () => {
    expect(decodeHeader(`=?euc-kr?B?${b64('견적 회신', 'euc-kr')}?=`)).toBe('견적 회신');
    expect(decodeHeader(`=?UTF-8?B?${b64('통영공장')}?= =?UTF-8?B?${b64(' 인벤토리')}?=`)).toBe('통영공장 인벤토리');
    expect(decodeHeader('=?utf-8?Q?RE=3A_=EA=B2=AC=EC=A0=81?=')).toBe('RE: 견적');
    expect(decodeHeader('plain subject')).toBe('plain subject');
  });

  it('ks_c_5601-1987 은 cp949 로', () => {
    expect(decodeHeader(`=?ks_c_5601-1987?B?${b64('한결케미칼', 'cp949')}?=`)).toBe('한결케미칼');
  });

  it('낱말 경계에서 갈라진 여러 바이트 글자도 모아서 푼다', () => {
    const bytes = Buffer.from('가나', 'utf8');
    const a = bytes.subarray(0, 4).toString('base64');
    const b = bytes.subarray(4).toString('base64');
    expect(decodeHeader(`=?UTF-8?B?${a}?= =?UTF-8?B?${b}?=`)).toBe('가나');
  });

  it('인코딩 안 된 8비트 머리: utf-8 이면 utf-8, 아니면 cp949', () => {
    expect(decodeHeader(Buffer.from('메일', 'utf8').toString('latin1'))).toBe('메일');
    expect(decodeHeader(iconv.encode('메일', 'cp949').toString('latin1'))).toBe('메일');
  });

  it('매개변수: RFC 2231 조각·인코딩', () => {
    const p = parseParamHeader(`attachment; filename*0*=utf-8''%ED%95%9C; filename*1*=%EA%B8%80.xlsx`);
    expect(p.value).toBe('attachment');
    expect(p.params.get('filename')).toBe('한글.xlsx');
    expect(parseParamHeader('text/plain; charset="EUC-KR"').params.get('charset')).toBe('EUC-KR');
  });
});

describe('본문', () => {
  it('quoted-printable: 부드러운 줄바꿈·16진', () => {
    expect(decodeQuotedPrintable(Buffer.from('a=3Db=\r\nc', 'latin1')).toString('latin1')).toBe('a=bc');
  });

  it('문자셋 후보: 선언 → utf-8 → cp949', () => {
    expect(safeDecode(iconv.encode('안녕', 'cp949'), 'ks_c_5601-1987')).toBe('안녕');
    expect(safeDecode(iconv.encode('안녕', 'cp949'), 'utf-8')).toBe('안녕');
    expect(safeDecode(Buffer.from('안녕', 'utf8'))).toBe('안녕');
  });

  it('HTML → 글: script·style 버림, 블록은 줄바꿈, 엔터티', () => {
    const t = htmlToText('<html><head><title>x</title><style>p{}</style></head><body><p>첫&nbsp;줄</p><div>둘째 &amp; 셋</div><script>evil()</script></body></html>');
    expect(t).toBe('첫 줄\n\n둘째 & 셋');
  });

  it('URL 깨기(defang)', () => {
    expect(defang('see https://evil.example.com/a?b=1 now')).toBe('see `https[:]//evil[.]example[.]com/a?b=1` now');
  });
});

describe('parseMessage', () => {
  it('단순 메일: 머리·주소·날짜·Message-ID·본문', () => {
    const m = parseMessage(
      crlf([
        `From: =?UTF-8?B?${b64('최고객')}?= <cjd@example.co.kr>`,
        'To: "김사용" <user1@acme.test>, b@example.com',
        'Cc: c@example.com (참조자)',
        `Subject: =?UTF-8?B?${b64('LDAR 견적 회신')}?=`,
        'Date: Mon, 20 Jul 2026 14:23:11 +0900',
        'Message-ID: <abc@example.co.kr>',
        'In-Reply-To: <prev@example.co.kr>',
        'References: <a@x> <prev@example.co.kr>',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64('안녕하세요.\r\n견적 보냅니다.\r\n'),
      ]),
    );
    expect(m.subject).toBe('LDAR 견적 회신');
    expect(m.from).toBe('최고객 <cjd@example.co.kr>');
    expect(m.to).toEqual(['김사용 <user1@acme.test>', 'b@example.com']);
    expect(m.cc).toEqual(['참조자 <c@example.com>']);
    expect(m.date.toISOString()).toBe('2026-07-20T05:23:11.000Z');
    expect(m.messageId).toBe('abc@example.co.kr');
    expect(m.inReplyTo).toBe('prev@example.co.kr');
    expect(m.references).toBe('<a@x> <prev@example.co.kr>');
    expect(m.body).toBe('안녕하세요.\n견적 보냅니다.');
    expect(m.bodyFormat).toBe('plain');
    expect(m.signals).toEqual([]);
  });

  it('multipart/mixed + alternative: text/plain 우선, 한글 첨부(2231), 실행형 첨부는 바이트를 버림', () => {
    const m = parseMessage(
      crlf([
        'From: a@example.com',
        'Subject: att',
        'Date: Tue, 21 Jul 2026 09:00:00 +0900',
        'Content-Type: multipart/mixed; boundary="MIX"',
        '',
        'preamble',
        '--MIX',
        'Content-Type: multipart/alternative; boundary=ALT',
        '',
        '--ALT',
        'Content-Type: text/plain; charset=ks_c_5601-1987',
        'Content-Transfer-Encoding: base64',
        '',
        b64('본문입니다', 'cp949'),
        '--ALT',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>HTML 본문</p>',
        '--ALT--',
        '--MIX',
        "Content-Type: application/vnd.ms-excel; name*=utf-8''%ED%91%9C.xlsx",
        "Content-Disposition: attachment; filename*=utf-8''%ED%91%9C.xlsx",
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('XLSXDATA').toString('base64'),
        '--MIX',
        'Content-Type: application/octet-stream; name="run.exe"',
        'Content-Disposition: attachment; filename="run.exe"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('MZ....').toString('base64'),
        '--MIX--',
        'epilogue',
      ]),
    );
    expect(m.body).toBe('본문입니다');
    expect(m.attachments.map((a) => [a.filename, a.size, a.blocked])).toEqual([
      ['표.xlsx', 8, false],
      ['run.exe', 6, true],
    ]);
    expect(m.attachments[0].data.toString()).toBe('XLSXDATA');
    expect(m.attachments[1].data.length).toBe(0);
    expect(m.attachments[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.signals).toEqual(['위험첨부(run.exe)']);
  });

  it('HTML 만 있으면 글로 바꾼다', () => {
    const m = parseMessage(crlf(['From: a@example.com', 'Subject: h', 'Content-Type: text/html; charset=utf-8', '', '<div>가</div><div>나</div>']));
    expect(m.body).toBe('가\n\n나');
    expect(m.bodyFormat).toBe('html→text');
  });

  it('본문·제목·보낸이가 없으면 기본 글', () => {
    const m = parseMessage(crlf(['X-Empty: 1', '', '']), () => new Date('2026-09-01T00:00:00Z'));
    expect(m.subject).toBe('(제목 없음)');
    expect(m.from).toBe('(발신자 없음)');
    expect(m.body).toBe('(본문 없음)');
    expect(m.date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('피싱 신호: 사내 사칭 · 회신 주소 도메인 다름 · SPF 실패', () => {
    const m = parseMessage(
      crlf([
        'From: "Acme 관리자" <admin@evil.example>',
        'Reply-To: x@other.example',
        'Authentication-Results: mx; spf=fail smtp.mailfrom=evil.example',
        'Subject: 계정 확인',
        '',
        'click https://evil.example/login',
      ]),
    );
    expect(m.signals).toEqual(['사내사칭(표시명 사내 / 실제 @evil.example)', '회신주소불일치(From @evil.example / Reply-To @other.example)', 'SPF실패']);
    expect(m.body).toContain('`https[:]//evil[.]example/login`');
  });

  it('LF 만 쓴 메일(POP3 RETR 를 LF 로 이은 꼴)', () => {
    const m = parseMessage(Buffer.from('From: a@example.com\nSubject: lf\n\nline1\nline2\n', 'utf8'));
    expect(m.subject).toBe('lf');
    expect(m.body).toBe('line1\nline2');
  });
});

describe('주소 머리 전체가 인코딩 낱말 하나', () => {
  it('풀고 나서 나눈다(파이썬 email 이 만드는 꼴)', () => {
    const enc = (s: string): string => `=?utf-8?b?${Buffer.from(s, 'utf8').toString('base64')}?=`;
    const m = parseMessage(Buffer.from([`From: ${enc('"예시회사 보안팀" <sec@evil.example>')}`, `To: ${enc('김사용 <user1@acme.test>, other@x.com')}`, 'Subject: s', '', 'b'].join('\r\n'), 'utf8'));
    expect(m.from).toBe('예시회사 보안팀 <sec@evil.example>');
    expect(m.to).toEqual(['김사용 <user1@acme.test>', 'other@x.com']);
  });
});
