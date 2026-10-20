// 3a단계 §11 IPC 인자 검사 · §7-4 그림 참조 풀기 · §7-3 외부 링크 주소 검사
import { describe, expect, it } from 'vitest';
import { emptyImageDict } from '../../src/main/wiki/docIndex';
import {
  IMAGE_REASONS,
  findImageRef,
  imageRefsOf,
  imageTypeOf,
  requireChangesInput,
  requireExternalUrl,
  requireImageInput,
  requireMarkSeenInput,
  requireRecentInput,
  requireSearchQuery,
  requireUndoToken,
  requireWikiDocInput,
  requireWikiDocPath,
  resolveImageRef,
} from '../../src/main/wiki/docInput';

describe('경로·출처', () => {
  it('받는 경로', () => {
    expect(requireWikiDocPath('wiki/entities/한결케미칼.md')).toBe('wiki/entities/한결케미칼.md');
    expect(requireWikiDocPath('wiki\\a.MD')).toBe('wiki/a.MD');
    expect(requireWikiDocPath('한결'.normalize('NFD') + '.md')).toBe('한결.md');
  });

  it('거부: 길이·..·절대경로·드라이브·장치 이름·제어 문자·.md 아님', () => {
    for (const bad of ['', 'a'.repeat(1022) + '.md' + 'x', '../a.md', 'a/../../b.md', '/a.md', 'C:/a.md', 'C:a.md', '\\\\srv\\a.md', 'con.md', 'a/nul.md', 'a\u0000.md', 'a.txt', '.md', 'a/b', 'a. /b.md', 42, null]) {
      expect(() => requireWikiDocPath(bad), String(bad)).toThrow(/잘못된 요청/);
    }
    expect(() => requireWikiDocPath(`${'a'.repeat(1025)}.md`)).toThrow();
  });

  it('출처는 personal|team', () => {
    expect(requireWikiDocInput({ source: 'team', path: 'a.md' })).toEqual({ source: 'team', path: 'a.md' });
    for (const bad of [{ source: 'all', path: 'a.md' }, { source: 'x', path: 'a.md' }, { path: 'a.md' }, null, [], 'a.md']) {
      expect(() => requireWikiDocInput(bad)).toThrow(/잘못된 요청/);
    }
  });
});

describe('검색·목록·읽음', () => {
  it('검색어 1~200자·제어 문자 없음·limit 1~200·offset 0~10000', () => {
    expect(requireSearchQuery({ query: '인벤토리', source: 'all', limit: 50, offset: 0 })).toEqual({ query: '인벤토리', source: 'all', limit: 50, offset: 0 });
    expect(requireSearchQuery({ query: 'x'.repeat(200), source: 'team', limit: 200, offset: 10_000 }).limit).toBe(200);
    for (const bad of [
      { query: '', source: 'all', limit: 1, offset: 0 },
      { query: '   ', source: 'all', limit: 1, offset: 0 },
      { query: 'x'.repeat(201), source: 'all', limit: 1, offset: 0 },
      { query: 'a\u0001', source: 'all', limit: 1, offset: 0 },
      { query: 'a', source: 'x', limit: 1, offset: 0 },
      { query: 'a', source: 'all', limit: 0, offset: 0 },
      { query: 'a', source: 'all', limit: 201, offset: 0 },
      { query: 'a', source: 'all', limit: 1.5, offset: 0 },
      { query: 'a', source: 'all', limit: 1, offset: -1 },
      { query: 'a', source: 'all', limit: 1, offset: 10_001 },
    ]) {
      expect(() => requireSearchQuery(bad), JSON.stringify(bad)).toThrow(/잘못된 요청/);
    }
  });

  it('최근·변경 목록·되돌리기', () => {
    expect(requireRecentInput({ source: 'personal', limit: 50 })).toEqual({ source: 'personal', limit: 50 });
    expect(() => requireRecentInput({ source: 'personal', limit: 51 })).toThrow();
    expect(requireChangesInput({ source: 'team', offset: 2000, limit: 200 })).toEqual({ source: 'team', offset: 2000, limit: 200 });
    expect(() => requireChangesInput({ source: 'all', offset: 0, limit: 1 })).toThrow();
    expect(() => requireChangesInput({ source: 'team', offset: 2001, limit: 1 })).toThrow();
    expect(requireUndoToken('u1abc')).toBe('u1abc');
    expect(() => requireUndoToken('../x')).toThrow();
  });

  it('읽음: 1~500개 또는 all', () => {
    expect(requireMarkSeenInput({ all: true, source: 'team' })).toEqual({ all: true, source: 'team' });
    expect(requireMarkSeenInput({ items: [{ source: 'personal', path: 'wiki/지운 문서.md' }] })).toEqual({ items: [{ source: 'personal', path: 'wiki/지운 문서.md' }] });
    const many = Array.from({ length: 501 }, (_, i) => ({ source: 'personal', path: `a${i}.md` }));
    for (const bad of [{ items: [] }, { items: many }, { items: [{ source: 'personal', path: '../a.md' }] }, { all: 'yes', source: 'team' }, { all: true, source: 'all' }]) {
      expect(() => requireMarkSeenInput(bad)).toThrow(/잘못된 요청/);
    }
    expect((requireMarkSeenInput({ items: many.slice(0, 500) }) as { items: unknown[] }).items).toHaveLength(500);
  });

  it('그림 요청: ref 1~512자·제어 문자 없음·page 는 문서 경로', () => {
    expect(requireImageInput({ source: 'personal', page: 'a.md', ref: '그림.png' })).toEqual({ source: 'personal', page: 'a.md', ref: '그림.png' });
    for (const bad of [
      { source: 'personal', page: 'a.md', ref: '' },
      { source: 'personal', page: 'a.md', ref: 'x'.repeat(513) },
      { source: 'personal', page: 'a.md', ref: 'a\nb' },
      { source: 'personal', page: '../a.md', ref: 'a.png' },
      { source: 'personal', page: 'a.png', ref: 'a.png' },
    ]) {
      expect(() => requireImageInput(bad)).toThrow(/잘못된 요청/);
    }
  });
});

describe('외부 링크 주소', () => {
  it('http·https 만, 정규화한 href', () => {
    expect(requireExternalUrl('https://example.invalid/guide')).toBe('https://example.invalid/guide');
    expect(requireExternalUrl('http://EXAMPLE.invalid/a?b=1#c')).toBe('http://example.invalid/a?b=1#c');
  });

  it('거부: javascript·file·data·mailto·obsidian·사용자 정보·공백·제어 문자·2049자', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'data:text/html,<b>x</b>',
      'mailto:a@example.invalid',
      'obsidian://open?vault=x',
      'https://user:pass@example.invalid/',
      'https://user@example.invalid/',
      'https://example.invalid/a b',
      'https://example.invalid/\u0000',
      ' https://example.invalid/',
      'relative/path',
      `https://example.invalid/${'a'.repeat(2049)}`,
      '',
      42,
    ]) {
      expect(() => requireExternalUrl(bad), String(bad)).toThrow(/잘못된 요청/);
    }
    expect(requireExternalUrl(`https://example.invalid/${'a'.repeat(2048 - 24)}`)).toHaveLength(2048);
  });
});

describe('그림 참조', () => {
  const body = [
    '![[경계조건.png]] ![[문서 포함]] ![[작게.png|300]] ![[다이어그램.svg]]',
    '![원격](https://tracker.example.invalid/p.png) ![상대](_img/a%20b.png "제목") ![위](../밖.png) ![루트](/raw/mail/_attachments/x.jpg)',
    '`![[코드.png]]`',
  ].join('\n');

  it('본문의 그림 참조만(포함 문서·코드 안 제외)', () => {
    expect(imageRefsOf(body).map((r) => `${r.kind}:${r.ref}`)).toEqual([
      'embed:경계조건.png',
      'embed:작게.png',
      'embed:다이어그램.svg',
      'md:https://tracker.example.invalid/p.png',
      'md:_img/a%20b.png',
      'md:../밖.png',
      'md:/raw/mail/_attachments/x.jpg',
    ]);
    expect(findImageRef(body, '_img/a b.png')?.ref).toBe('_img/a%20b.png');
    expect(findImageRef(body, '없는.png')).toBeNull();
  });

  it('![…](…) 꼴: 꺾쇠 주소·괄호 제목·대체 글의 [ ·줄을 넘는 대체 글·닫히지 않은 ![ 뒤', () => {
    const refs = (b: string) => imageRefsOf(b).map((r) => r.ref);
    expect(refs('![가 [나](<a b.png>) ![x](c.png (제목)) ![y](d(1).png)')).toEqual(['a b.png', 'c.png', 'd(1).png']);
    expect(refs('![줄을\n넘음](e.png) ![ ![ ![z](f.png) ![w] (g.png) ![v](h.png "제목")')).toEqual(['f.png', 'h.png']);
    expect(refs('![a](x.png (안 닫힘')).toEqual([]);
  });

  it('풀기: 이름 사전·문서 폴더 기준·볼트 기준·원격·SVG·밖', () => {
    const dict = emptyImageDict();
    const f1 = { path: 'wiki/topics/dev/_img/경계조건.png', size: 10 };
    const f2 = { path: 'other/경계조건.png', size: 10 };
    dict.byName.set('경계조건.png', [f2, f1]);
    dict.byPath.set(f1.path.toLowerCase(), f1);
    dict.byPath.set(f2.path.toLowerCase(), f2);
    const page = 'wiki/topics/dev/문서.md';
    const exists = (rel: string) => rel === 'wiki/topics/dev/_img/a b.png' || rel === 'raw/mail/_attachments/x.jpg';
    const refs = imageRefsOf(body);
    const res = (ref: string) => resolveImageRef(refs.find((r) => r.ref === ref)!, page, dict, exists);
    expect(res('경계조건.png')).toEqual({ ok: true, path: 'other/경계조건.png' }); // 같은 폴더가 아니면 짧은 경로
    expect(resolveImageRef({ ref: '경계조건.png', kind: 'embed' }, 'wiki/topics/dev/_img/x.md', dict, exists)).toEqual({ ok: true, path: f1.path });
    expect(res('_img/a%20b.png')).toEqual({ ok: true, path: 'wiki/topics/dev/_img/a b.png' });
    expect(res('/raw/mail/_attachments/x.jpg')).toEqual({ ok: true, path: 'raw/mail/_attachments/x.jpg' });
    expect(res('https://tracker.example.invalid/p.png')).toEqual({ ok: false, reason: IMAGE_REASONS.remote });
    expect(res('다이어그램.svg')).toEqual({ ok: false, reason: IMAGE_REASONS.svg });
    expect(resolveImageRef({ ref: '../../../../밖.png', kind: 'md' }, page, dict, () => true)).toEqual({ ok: false, reason: IMAGE_REASONS.outside });
    expect(resolveImageRef({ ref: 'file:///C:/a.png', kind: 'md' }, page, dict, () => true)).toEqual({ ok: false, reason: IMAGE_REASONS.scheme });
    expect(resolveImageRef({ ref: 'data:image/png;base64,AAAA', kind: 'md' }, page, dict, () => true)).toEqual({ ok: false, reason: IMAGE_REASONS.scheme });
    expect(resolveImageRef({ ref: '없음.png', kind: 'embed' }, page, dict, () => false)).toEqual({ ok: false, reason: IMAGE_REASONS.missing });
    expect(resolveImageRef({ ref: 'a.bmp', kind: 'md' }, page, dict, () => true)).toEqual({ ok: false, reason: IMAGE_REASONS.ext });
  });

  it('서명', () => {
    expect(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(imageTypeOf(Buffer.from('GIF89a', 'latin1'))).toBe('gif');
    expect(imageTypeOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});
