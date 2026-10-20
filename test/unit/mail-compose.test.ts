// 회신 MIME 조립(명세 §2) — In-Reply-To·References·Subject 인코딩·Bcc 머리말 없음·봉투에 숨은참조·CRLF.
// mailparser 없이 확인한다: 머리말은 접어 쓴 줄을 펴고 인코딩된 낱말(=?UTF-8?B/Q?…?=)을 직접 푼다.
import { describe, expect, it } from 'vitest';
import { composeMessage, type ComposeInput } from '../../src/main/mail/compose';

/** =?charset?B|Q?…?= 를 푼다. 붙어 있는 인코딩 낱말 사이의 공백은 버린다(RFC 2047) */
function decodeWords(value: string): string {
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, enc: string, text: string) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
    const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => `%${h}`);
    return decodeURIComponent(bytes);
  });
}

interface Parsed {
  headers: Map<string, string[]>;
  body: string;
}

function parse(raw: Buffer): Parsed {
  const text = raw.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  expect(split).toBeGreaterThan(0);
  const headers = new Map<string, string[]>();
  for (const line of text.slice(0, split).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    const key = line.slice(0, i).toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), line.slice(i + 1).trim()]);
  }
  const enc = (headers.get('content-transfer-encoding')?.[0] ?? '7bit').toLowerCase();
  const rawBody = text.slice(split + 4);
  let bodyBytes: Buffer;
  if (enc === 'quoted-printable') {
    const unsoft = rawBody.replace(/=\r\n/g, '');
    bodyBytes = Buffer.from(unsoft.replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  } else if (enc === 'base64') {
    bodyBytes = Buffer.from(rawBody.replace(/\s+/g, ''), 'base64');
  } else {
    bodyBytes = Buffer.from(rawBody, 'latin1');
  }
  return { headers, body: bodyBytes.toString('utf8') };
}

function header(p: Parsed, key: string): string | undefined {
  const v = p.headers.get(key.toLowerCase());
  return v ? decodeWords(v[0]) : undefined;
}

const BASE: ComposeInput = {
  from: { name: '홍길동', address: 'owner@example.com' },
  to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>', '"Kim, Hong" <kim@x.example>'],
  cc: ['한결(주) 담당 <cc@x.example>'],
  bcc: ['owner@example.com', 'secret-bcc@y.example', 'EHS@hangyeol.example'],
  subject: 'RE: 통영공장 CMS 인벤토리 사용량 확인 요청',
  text: '안녕하세요.\n\n8월 사용량 반영을 확인했습니다.\n감사합니다.\n\n홍길동\n\n-----Original Message-----\nFrom: 한결',
  inReplyTo: 'fixture-0001@hangyeol.example',
  references: 'fixture-0001@hangyeol.example',
};

describe('composeMessage — 머리말', () => {
  it('From·To·Cc·Subject(인코딩)·In-Reply-To·References·Message-ID·Date', async () => {
    const m = await composeMessage(BASE);
    const p = parse(m.raw);
    expect(header(p, 'From')).toBe('홍길동 <owner@example.com>');
    expect(header(p, 'To')).toBe('한결케미칼 EHS팀 <ehs@hangyeol.example>, "Kim, Hong" <kim@x.example>');
    // 이름의 괄호가 주석으로 읽혀 사라지지 않는다
    expect(header(p, 'Cc')).toBe('한결(주) 담당 <cc@x.example>');
    expect(m.raw.toString('latin1')).toContain('Subject: =?UTF-8?');
    expect(header(p, 'Subject')).toBe(BASE.subject);
    expect(p.headers.get('in-reply-to')).toEqual(['<fixture-0001@hangyeol.example>']);
    expect(p.headers.get('references')).toEqual(['<fixture-0001@hangyeol.example>']);
    expect(m.messageId).toMatch(/^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com>$/);
    expect(p.headers.get('message-id')).toEqual([m.messageId]);
    expect(p.headers.get('date')?.[0]).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
    expect(p.headers.get('mime-version')).toEqual(['1.0']);
    expect(p.headers.get('content-type')).toEqual(['text/plain; charset=utf-8']);
    expect(p.headers.has('x-mailer')).toBe(false);
  });

  it('숨은참조는 머리말에 없고 봉투에만 있다(대소문자 무시 중복 뺌)', async () => {
    const m = await composeMessage(BASE);
    const p = parse(m.raw);
    expect(p.headers.has('bcc')).toBe(false);
    expect(m.raw.toString('latin1')).not.toMatch(/^bcc:/im);
    expect(m.raw.toString('latin1')).not.toContain('secret-bcc@y.example');
    expect(m.envelope).toEqual({
      from: 'owner@example.com',
      to: ['ehs@hangyeol.example', 'kim@x.example', 'cc@x.example', 'owner@example.com', 'secret-bcc@y.example'],
    });
  });

  it('원본 Message-ID 가 없으면 In-Reply-To·References 를 뺀다', async () => {
    const m = await composeMessage({ ...BASE, inReplyTo: undefined, references: undefined });
    const p = parse(m.raw);
    expect(p.headers.has('in-reply-to')).toBe(false);
    expect(p.headers.has('references')).toBe(false);
  });

  it('꺾쇠가 이미 있어도 한 겹만, References 는 여러 개', async () => {
    const m = await composeMessage({ ...BASE, inReplyTo: '<a@x.co>', references: '<r1@x.co> r2@x.co\n <a@x.co>' });
    const p = parse(m.raw);
    expect(p.headers.get('in-reply-to')).toEqual(['<a@x.co>']);
    expect(p.headers.get('references')).toEqual(['<r1@x.co> <r2@x.co> <a@x.co>']);
  });

  it('공백·꺾쇠가 든 원본 Message-ID 는 넣지 않는다', async () => {
    const m = await composeMessage({ ...BASE, inReplyTo: 'a b@x.co', references: 'a<b@x.co' });
    const p = parse(m.raw);
    expect(p.headers.has('in-reply-to')).toBe(false);
    expect(p.headers.has('references')).toBe(false);
  });

  it('이름이 없으면 From 은 주소만, 이름의 따옴표·꺾쇠는 걷는다', async () => {
    const bare = parse((await composeMessage({ ...BASE, from: { address: 'owner@example.com' } })).raw);
    expect(bare.headers.get('from')).toEqual(['owner@example.com']);
    const quoted = parse((await composeMessage({ ...BASE, from: { name: '"홍<길>동"', address: 'owner@example.com' } })).raw);
    expect(header(quoted, 'From')).toBe('홍길동 <owner@example.com>');
  });

  it('참조가 없으면 Cc 머리말이 없다', async () => {
    const p = parse((await composeMessage({ ...BASE, cc: [] })).raw);
    expect(p.headers.has('cc')).toBe(false);
  });

  it('Message-ID 는 부를 때마다 새로, 도메인은 보내는 주소 도메인(없으면 wiki-radar.local)', async () => {
    const a = await composeMessage(BASE);
    const b = await composeMessage(BASE);
    expect(a.messageId).not.toBe(b.messageId);
    const radar = await composeMessage({ ...BASE, from: { address: 'radar' } });
    expect(radar.messageId).toMatch(/@wiki-radar\.local>$/);
    expect(radar.envelope.from).toBe('radar');
  });
});

describe('composeMessage — 본문', () => {
  it('text/plain 한 부분, 줄바꿈은 모두 CRLF, 풀면 원래 본문(CRLF)', async () => {
    const m = await composeMessage(BASE);
    const text = m.raw.toString('latin1');
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).not.toMatch(/\r(?!\n)/);
    expect(text.toLowerCase()).not.toContain('multipart');
    const p = parse(m.raw);
    expect(p.body.replace(/\r\n$/, '')).toBe(BASE.text.replace(/\n/g, '\r\n'));
  });

  it('긴 한국어 본문·CRLF·CR 섞인 본문도 그대로 돌아온다', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i + 1}번째 줄 — 인벤토리 사용량을 확인했습니다.`).join('\n');
    const m = await composeMessage({ ...BASE, text: `가\r\n나\r다\n${long}` });
    expect(parse(m.raw).body.replace(/\r\n$/, '')).toBe(`가\r\n나\r\n다\r\n${long.replace(/\n/g, '\r\n')}`);
  });
});

describe('composeMessage — 거부', () => {
  it.each<[string, Partial<ComposeInput>]>([
    ['받는사람 없음', { to: [] }],
    ['받는사람 형식', { to: ['이름만'] }],
    ['받는사람 머리말 주입', { to: ['a@b.co\r\nBcc: x@y.z'] }],
    ['이름 머리말 주입', { to: ['이름\r\nBcc: x@y.z <a@b.co>'] }],
    ['참조 형식', { cc: ['a@b'] }],
    ['숨은참조 형식', { bcc: ['x y@z.co'] }],
    ['제목 줄바꿈', { subject: 'RE: 제목\r\nBcc: x@y.z' }],
    ['보내는 주소 공백', { from: { address: 'a b@x.co' } }],
    ['보내는 주소 줄바꿈', { from: { address: 'a@x.co\r\nBcc: y@z.co' } }],
    ['보내는 주소 없음', { from: { address: '' } }],
  ])('%s', async (_label, patch) => {
    await expect(composeMessage({ ...BASE, ...patch })).rejects.toThrow(/형식|없습니다|줄바꿈/);
  });
});
