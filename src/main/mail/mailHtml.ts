// 메일 원본 보기(docs/stage2.15-contract.md §J). electron 을 import 하지 않는 순수 모듈이다(외부 그림 받기는 주입).
//
// 메일 파일(md)의 frontmatter original 이 가리키는 원본 .eml 을 다시 파싱해 HTML 본문을 꺼내고, 화면에 넣을 수 있게 정리한다.
// - 화면은 이 문서를 sandbox iframe(스크립트 없음)에 srcdoc 으로 넣는다 — 여기 정리는 두 번째 방어선이다.
// - 스크립트·폼·틀·플러그인·메타 새로고침·base·외부 스타일시트를 걷고, on* 속성·javascript: 주소를 지운다.
// - cid: 그림은 같은 메일의 첨부(Content-ID)로 data: URL 을 만든다. 외부 그림(http/https)은 기본으로 막고(추적 픽셀),
//   remote=true 일 때만 주입된 fetchImage 로 받아 data: 로 넣는다. 문서 CSP 는 data: 그림·인라인 스타일만 허락한다.
// - 메일 본문은 데이터다 — 해석하거나 실행하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import type { MailHtmlView } from '../../shared/types';
import { isInsideDir } from '../wiki/fsutil';
import { mailOriginalRel, readMailText } from '../wiki/mail';
import { splitFrontmatter } from '../wiki/frontmatter';
import { splitLines } from '../wiki/fsutil';
import { MAIL_MAX_BYTES, parseMessage, type ParsedAttachment } from './mimeParse';

/** 문서에 넣는 그림 하나의 한도 */
export const MAIL_HTML_IMAGE_MAX = 5 * 1024 * 1024;
/** 외부 그림 받기 한도 */
export const MAIL_HTML_REMOTE_MAX = 30;
/** 문서 전체 한도(그림 포함) */
export const MAIL_HTML_DOC_MAX = 40 * 1024 * 1024;

export type FetchImage = (url: string) => Promise<{ contentType: string; data: Buffer } | null>;

/** 위험한 요소를 통째로 걷는다(여는·닫는 태그와 그 사이) */
const DROP_BLOCK_RE = /<\s*(script|noscript|iframe|frame|frameset|object|embed|applet|form|template|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
/** 홀로 쓰이는 위험한 태그 */
const DROP_TAG_RE = /<\s*\/?\s*(script|noscript|iframe|frame|frameset|object|embed|applet|form|input|button|select|textarea|link|meta|base|svg|math|template|portal)\b[^>]*>/gi;
/** on* 이벤트 속성 */
const EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
/** 주소를 받는 속성의 위험한 스킴 */
const BAD_URL_ATTR_RE = /\s+(href|src|action|formaction|background|xlink:href|poster)\s*=\s*("\s*(?:javascript|vbscript|data:text\/html|file):[^"]*"|'\s*(?:javascript|vbscript|data:text\/html|file):[^']*'|(?:javascript|vbscript|file):[^\s>]+)/gi;

/** 정리(sanitize) — iframe 샌드박스가 주 방어선이고 이것은 두 번째 */
export function sanitizeMailHtml(html: string): string {
  let s = html ?? '';
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  for (let i = 0; i < 3; i++) s = s.replace(DROP_BLOCK_RE, '');
  s = s.replace(DROP_TAG_RE, '');
  s = s.replace(EVENT_ATTR_RE, '');
  s = s.replace(BAD_URL_ATTR_RE, ' $1="#"');
  // CSS 의 외부 연결(@import·url(http…))은 문서 CSP 가 막지만, 글로도 지운다
  s = s.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)\s*(?:https?:|\/\/)[^)]*\)/gi, 'none');
  return s;
}

function dataUrl(contentType: string, data: Buffer): string {
  const ct = /^[\w.+-]+\/[\w.+-]+$/.test(contentType) ? contentType : 'application/octet-stream';
  return `data:${ct};base64,${data.toString('base64')}`;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
  const v = ` ${name}="${value.replace(/"/g, '&quot;')}"`;
  return re.test(tag) ? tag.replace(re, v) : tag.replace(/^<\s*img/i, `<img${v}`);
}

/** 그림 주소 바꾸기: cid: → data:, 외부 → (remote 면 받아서 data:, 아니면 비움). 그 밖(data: 그림 그대로, 상대경로 비움) */
export async function inlineImages(
  html: string,
  attachments: readonly ParsedAttachment[],
  opts: { remote: boolean; fetchImage?: FetchImage },
): Promise<{ html: string; blockedRemote: number; failedRemote: number }> {
  const byCid = new Map<string, ParsedAttachment>();
  for (const a of attachments) if (a.contentId && !a.blocked) byCid.set(a.contentId.toLowerCase(), a);
  const tags = [...html.matchAll(/<\s*img\b[^>]*>/gi)].map((m) => m[0]);
  const remoteUrls = new Map<string, string | null>();
  let blockedRemote = 0;
  let failedRemote = 0;
  if (opts.remote && opts.fetchImage) {
    const urls = [...new Set(tags.map((t) => attr(t, 'src') ?? '').filter((u) => /^https?:\/\//i.test(u.trim())))].slice(0, MAIL_HTML_REMOTE_MAX);
    for (const u of urls) {
      try {
        const got = await opts.fetchImage(u.trim());
        remoteUrls.set(u, got && got.contentType.startsWith('image/') && got.data.length <= MAIL_HTML_IMAGE_MAX ? dataUrl(got.contentType, got.data) : null);
      } catch {
        remoteUrls.set(u, null);
      }
    }
  }
  const out = html.replace(/<\s*img\b[^>]*>/gi, (tag) => {
    const src = (attr(tag, 'src') ?? '').trim();
    if (/^cid:/i.test(src)) {
      const a = byCid.get(decodeURIComponent(src.slice(4)).replace(/^<|>$/g, '').toLowerCase());
      if (a && a.data.length <= MAIL_HTML_IMAGE_MAX) return setAttr(tag, 'src', dataUrl(a.contentType, a.data));
      return setAttr(tag, 'src', '');
    }
    if (/^data:image\//i.test(src)) return tag;
    if (/^https?:\/\//i.test(src)) {
      if (!opts.remote) {
        blockedRemote++;
        return setAttr(setAttr(tag, 'src', ''), 'data-radar-blocked', 'remote');
      }
      const d = remoteUrls.get(src) ?? remoteUrls.get(attr(tag, 'src') ?? '');
      if (d) return setAttr(tag, 'src', d);
      failedRemote++;
      return setAttr(tag, 'src', '');
    }
    return setAttr(tag, 'src', '');
  });
  return { html: out, blockedRemote, failedRemote };
}

/** 문서 틀: CSP(그림은 data: 만, 스크립트·연결 없음) + 메일답게 흰 바탕 */
export function wrapMailDocument(body: string): string {
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<style>html,body{margin:0;padding:0;background:#fff;color:#111;}body{padding:12px 14px;font:14px/1.6 "Malgun Gothic","IBM Plex Sans KR",sans-serif;word-break:break-word;overflow-wrap:anywhere;}img{max-width:100%;height:auto;}table{max-width:100%;}a{color:#0b57d0;}img[data-radar-blocked]{display:none;}</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}

/** HTML 문서의 body 안쪽(없으면 전체) */
function bodyInner(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi)].map((x) => x[0]).join('');
  return styles + (m ? m[1] : html.replace(/<\/?(html|head|body)\b[^>]*>/gi, ''));
}

/** 글만 있는 메일 → 원본 보기 문서(줄바꿈 그대로) */
function textToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="white-space:pre-wrap;font:inherit;margin:0">${esc}</pre>`;
}

export interface BuildMailHtmlOptions {
  /** 메일 기준 폴더(그 안에 raw/mail) */
  base: string;
  /** raw/mail/…md */
  rel: string;
  remote: boolean;
  fetchImage?: FetchImage;
}

/** 원본 보기 문서. 메일·원본이 없으면 null */
export async function buildMailHtml(opts: BuildMailHtmlOptions): Promise<MailHtmlView | null> {
  const mail = readMailText(opts.base, opts.rel);
  if (!mail) return null;
  const fm = splitFrontmatter(splitLines(mail.text));
  const origRel = mailOriginalRel(fm.data?.original);
  if (!origRel) return null;
  const mailRoot = path.join(path.resolve(opts.base), 'raw', 'mail');
  const abs = path.join(mailRoot, ...origRel.split('/'));
  let raw: Buffer;
  try {
    const real = fs.realpathSync.native(abs);
    if (!isInsideDir(fs.realpathSync.native(mailRoot), real)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAIL_MAX_BYTES) return null;
    raw = fs.readFileSync(real);
  } catch {
    return null;
  }
  const parsed = parseMessage(raw);
  const inner = parsed.html.trim() ? bodyInner(sanitizeMailHtml(parsed.html)) : textToHtml(parsed.body);
  const inlined = await inlineImages(inner, parsed.attachments, { remote: opts.remote, ...(opts.fetchImage ? { fetchImage: opts.fetchImage } : {}) });
  let html = wrapMailDocument(inlined.html);
  if (html.length > MAIL_HTML_DOC_MAX) html = wrapMailDocument(textToHtml(parsed.body));
  return { html, blockedRemote: inlined.blockedRemote, failedRemote: inlined.failedRemote };
}
