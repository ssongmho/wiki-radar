// 2.15단계 §J 메일 원본 보기 — 정리(sanitize)·cid 그림·외부 그림 막기·원본 .eml 저장. 합성 메일·임시 폴더만.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMailHtml, inlineImages, sanitizeMailHtml } from '../../src/main/mail/mailHtml';
import { parseMessage } from '../../src/main/mail/mimeParse';
import { EMPTY_RULES, writeMail } from '../../src/main/mail/mailWrite';
import { readMailMessage } from '../../src/main/wiki/mail';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function htmlMail(): Buffer {
  return Buffer.from(
    [
      'From: 박담당 <park@daeryuk.example>',
      'To: radar@example.com',
      'Subject: =?UTF-8?B?' + Buffer.from('이미지 테스트').toString('base64') + '?=',
      'Date: Mon, 19 Oct 2026 17:37:25 +0900',
      'Message-ID: <html-1@daeryuk.example>',
      'Content-Type: multipart/related; boundary="REL"',
      '',
      '--REL',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body onload="x()">',
      '<p>이미지 테스트</p><p>감사합니다</p><img src="cid:logo@x"><img src="https://track.example/p.gif">',
      '<a href="javascript:alert(1)">나쁜 링크</a><a href="https://example.com/a">좋은 링크</a><form action="https://x"><input name="q"></form>',
      '</body></html>',
      '--REL',
      'Content-Type: image/png',
      'Content-ID: <logo@x>',
      'Content-Transfer-Encoding: base64',
      '',
      PNG.toString('base64'),
      '--REL--',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe('원본 보기', () => {
  it('파서: html 원문·cid 그림·HTML 글(줄바꿈 살림)', () => {
    const p = parseMessage(htmlMail());
    expect(p.html).toContain('<p>이미지 테스트</p>');
    expect(p.body).toBe('이미지 테스트\n\n감사합니다\n\n나쁜 링크좋은 링크');
    expect(p.attachments.find((a) => a.contentId === 'logo@x')?.data.equals(PNG)).toBe(true);
  });

  it('정리: 스크립트·폼·on* 속성·javascript: 를 걷는다', () => {
    const s = sanitizeMailHtml(parseMessage(htmlMail()).html);
    expect(s).not.toMatch(/<script|onload=|javascript:|<form|<input/i);
    expect(s).toContain('<style>p{color:red}</style>');
    expect(s).toContain('href="https://example.com/a"');
  });

  it('그림: cid → data:, 외부 그림은 막고 수를 센다 · remote 면 받은 것으로', async () => {
    const p = parseMessage(htmlMail());
    const blocked = await inlineImages(p.html, p.attachments, { remote: false });
    expect(blocked.html).toContain(`src="data:image/png;base64,${PNG.toString('base64')}"`);
    expect(blocked.html).not.toContain('track.example');
    expect(blocked.blockedRemote).toBe(1);
    const fetched = await inlineImages(p.html, p.attachments, { remote: true, fetchImage: async () => ({ contentType: 'image/gif', data: Buffer.from('GIF') }) });
    expect(fetched.html).toContain(`src="data:image/gif;base64,${Buffer.from('GIF').toString('base64')}"`);
    expect(fetched.blockedRemote).toBe(0);
  });

  it('저장한 메일: _original/<6자>.eml + frontmatter original → 읽기 hasOriginal · buildMailHtml 문서(CSP 포함)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailhtml-'));
    dirs.push(base);
    const mailRoot = path.join(base, 'raw', 'mail');
    const raw = htmlMail();
    const w = writeMail({ parsed: parseMessage(raw), uid: 'u-1', rules: EMPTY_RULES, mailRoot, today: '2026-10-20', original: raw });
    const short = w.rel.match(/_([0-9a-f]{6})\.md$/)?.[1];
    expect(fs.readFileSync(path.join(mailRoot, '_original', `${short}.eml`)).equals(raw)).toBe(true);
    const rel = `raw/mail/${w.rel}`;
    expect(readMailMessage(base, rel)?.hasOriginal).toBe(true);
    const doc = await buildMailHtml({ base, rel, remote: false });
    expect(doc?.blockedRemote).toBe(1);
    expect(doc?.html).toContain("Content-Security-Policy");
    expect(doc?.html).toContain("img-src data:");
    expect(doc?.html).toContain('<p>이미지 테스트</p>');
    expect(doc?.html).not.toMatch(/<script/i);
  });

  it('원본이 없는 옛 메일은 null', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailhtml-'));
    dirs.push(base);
    const mailRoot = path.join(base, 'raw', 'mail');
    const w = writeMail({ parsed: parseMessage(htmlMail()), uid: 'u-2', rules: EMPTY_RULES, mailRoot, today: '2026-10-20' });
    expect(readMailMessage(base, `raw/mail/${w.rel}`)?.hasOriginal).toBeUndefined();
    expect(await buildMailHtml({ base, rel: `raw/mail/${w.rel}`, remote: false })).toBeNull();
  });
});
