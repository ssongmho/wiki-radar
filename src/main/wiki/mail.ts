// raw/mail 메일 한 통의 요약. electron 을 import 하지 않는 순수 모듈이다.
import fs from 'node:fs';
import path from 'node:path';
import type { MailAttachment, MailMessage, MailSummary } from '../../shared/types';
import { splitAddressList } from '../../shared/reply';
import { scalarToString, splitFrontmatter } from './frontmatter';
import { isInsideDir, readTextFile, safeVaultRelative, splitLines, stripBom } from './fsutil';
import { normMailFolder } from './mailIndex';

/** 요약에 쓰는 본문 앞부분 길이(글자 수) */
export const EXCERPT_MAX = 400;
/** 이보다 큰 파일은 읽지 않는다(메일 한 통으로는 비정상) */
export const MAX_MAIL_BYTES = 8 * 1024 * 1024;

/**
 * 메일 경로 검사. '/' 로 정규화한 뒤 `raw/mail/` 로 시작하고 `.md` 로 끝나며
 * `..` 조각·드라이브·절대경로가 없을 때만 정규화한 경로를 돌려준다.
 */
export function normalizeMailPath(relPath: unknown): string | null {
  if (typeof relPath !== 'string') return null;
  const p = safeVaultRelative(relPath);
  if (p === null) return null;
  if (!p.startsWith('raw/mail/')) return null;
  if (!p.endsWith('.md') || p.length <= 'raw/mail/'.length + '.md'.length) return null;
  return p;
}

/**
 * relPath 는 볼트 기준 상대경로('raw/mail/...md'). wikiRoot/raw/mail 밖을 가리키거나(.., 절대경로)
 * .md 가 아니면 null. 파일이 없어도 null. 메일 본문은 데이터일 뿐이며 해석·실행하지 않는다.
 */
export function readMailSummary(wikiRoot: string, relPath: string): MailSummary | null {
  const mail = readMailText(wikiRoot, relPath);
  return mail ? summarizeMail(mail.rel, mail.text) : null;
}

/**
 * 메일 파일 원문(BOM 뗀 글). 경로 검사는 readMailSummary 와 같다 — raw/mail 안의 .md 만, 실제 경로(링크·정션)도
 * raw/mail 안, 8MB 이하. 조건이 맞지 않거나 읽지 못하면 null. rel 은 정규화한 볼트 기준 상대경로.
 */
export function readMailText(wikiRoot: string, relPath: string): { rel: string; text: string } | null {
  if (typeof wikiRoot !== 'string' || wikiRoot === '') return null;
  const rel = normalizeMailPath(relPath);
  if (rel === null) return null;

  const root = path.resolve(wikiRoot);
  const mailRoot = path.join(root, 'raw', 'mail');
  const abs = path.resolve(root, ...rel.split('/'));
  if (!isInsideDir(mailRoot, abs)) return null;

  // 링크·정션으로 밖을 가리키는 경우까지 막는다: 실제 경로로 한 번 더 확인
  let text: string;
  try {
    const realRoot = fs.realpathSync.native(mailRoot);
    const realAbs = fs.realpathSync.native(abs);
    if (!isInsideDir(realRoot, realAbs)) return null;
    const st = fs.statSync(realAbs);
    if (!st.isFile() || st.size > MAX_MAIL_BYTES) return null;
    text = readTextFile(realAbs);
  } catch {
    return null;
  }
  return { rel, text };
}

/** 메일 파일 원문 → 요약. 본문은 글자로만 다룬다. */
export function summarizeMail(rel: string, text: string): MailSummary {
  const lines = splitLines(text);
  const fm = splitFrontmatter(lines);
  const summary: MailSummary = { path: rel };
  const data = fm.data ?? {};
  const subject = scalarToString(data.subject);
  if (subject) summary.subject = subject.trim();
  const from = scalarToString(data.from);
  if (from) summary.from = from.trim();
  const date = scalarToString(data.date);
  if (date) summary.date = date.trim();
  const folder = scalarToString(data.folder) ?? /^raw\/mail\/([^/]+)\//.exec(rel)?.[1];
  if (folder) summary.folder = normMailFolder(folder.trim());

  const excerpt = makeExcerpt(bodyLinesOf(fm.bodyLines));
  if (excerpt) summary.excerpt = excerpt;
  return summary;
}

// ---- 머리 필드 도우미(회신 문맥·메일함 색인·메일 읽기가 같이 쓴다) ----------------------------------

/** frontmatter 목록 필드 → 문자열 목록. 목록이 아니고 글 하나면 splitter 로 나눈다 */
export function mailListField(v: unknown, splitter: (s: string) => string[]): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => scalarToString(x))
      .filter((x): x is string => x !== undefined)
      .map((x) => x.trim())
      .filter((x) => x !== '');
  }
  const s = scalarToString(v);
  return s === undefined ? [] : splitter(s);
}

/** 글 하나(앞뒤 공백 걷음). 비었으면 undefined */
export function mailTextField(v: unknown): string | undefined {
  const s = scalarToString(v)?.trim();
  return s ? s : undefined;
}

/** Message-ID: 둘러싼 꺾쇠를 걷는다. 공백·꺾쇠·제어 문자가 남으면 머리말에 넣지 않도록 버린다 */
export function cleanMessageId(v: unknown): string | undefined {
  const s = mailTextField(v);
  if (!s) return undefined;
  const id = s.replace(/^<+/, '').replace(/>+$/, '').trim();
  if (id === '' || id.length > 900 || /[\s<>\u0000-\u001f\u007f]/.test(id)) return undefined;
  return id;
}

const HTML_COMMENT_LINE_RE = /^\s*<!--.*-->\s*$/;

/** 앞뒤 빈 줄을 걷는다 */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * 본문 줄(2.5 회신 인용·2.10 메일 읽기): `## 본문` 다음 줄부터 끝까지. 없으면 머리(빈 줄·연결 블록·인용/경고 상자·H1·
 * `- **보낸사람**:` 같은 머리 목록) 다음부터. 어느 쪽이든 HTML 주석 줄을 빼고 앞뒤 빈 줄을 걷는다.
 */
export function mailBodyLines(afterFrontmatter: string[]): string[] {
  const bodyIdx = afterFrontmatter.findIndex((l) => /^##\s+본문\s*$/.test(l));
  let lines: string[];
  if (bodyIdx >= 0) {
    lines = afterFrontmatter.slice(bodyIdx + 1);
  } else {
    let i = 0;
    let inLinks = false;
    for (; i < afterFrontmatter.length; i++) {
      const t = afterFrontmatter[i].trim();
      if (inLinks) {
        if (t === '<!-- /links:auto -->') inLinks = false;
        continue;
      }
      if (t === '<!-- links:auto -->') {
        inLinks = true;
        continue;
      }
      if (t === '' || HTML_COMMENT_LINE_RE.test(t) || t.startsWith('>') || /^#\s/.test(t)) continue;
      if (/^[-*]\s+\*\*[^*]+\*\*\s*[:：]/.test(t)) continue;
      break;
    }
    lines = afterFrontmatter.slice(i);
  }
  return trimBlankLines(lines.filter((l) => !HTML_COMMENT_LINE_RE.test(l)));
}

// ---- 메일 한 통 읽기(2.10단계 §6-2) --------------------------------------------------------

/** 읽기 칸에 보내는 본문 한도(글자 수 — 코드 단위) */
export const MAIL_BODY_MAX = 100_000;
/** 메일 한 통의 첨부 줄은 이만큼까지만 읽는다 */
export const MAIL_ATTACHMENTS_MAX = 200;
const ATTACHMENTS_DIR = 'raw/mail/_attachments/';

/** raw/mail/_attachments 아래 경로인가(대소문자 무시) */
export function isUnderMailAttachments(rel: string): boolean {
  return rel.toLowerCase().startsWith(ATTACHMENTS_DIR.toLowerCase());
}

/** 바이트 수 '1,234' → 1234. 읽지 못하면 undefined */
function parseByteCount(text: string): number | undefined {
  const n = Number(text.replace(/,/g, ''));
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

// 정규식은 역추적이 늘지 않는 꼴만 쓴다(본문이 밖에서 온 데이터라 병적인 줄이 올 수 있다 — 메인 프로세스가 멈추지 않게)
const SAVED_ATTACHMENT_TAIL_RE = /\)\s+—\s+([\d,]+)\s+bytes(?:\s*,\s*`([^`]*)`)?\s*$/;
const BLOCKED_ATTACHMENT_RE = /^[-*]\s+\*\*([^*]+)\*\*\s+—\s+([\d,]+)\s+bytes\s+·\s+\*\*저장 안 함/;
/** 첨부 줄로 읽는 가장 긴 줄(이보다 길면 건너뛴다) */
const ATTACHMENT_LINE_MAX = 2_000;
/** `## 본문` 머리가 없는 옛 꼴에서 첨부 절을 찾는 머리 영역(줄) */
const ATTACHMENT_HEAD_LINES = 60;

/** 저장한 첨부 줄 `- [이름](_attachments/…) — 1,234 bytes, \`형식\`` → {name, link, size, type}. 아니면 null */
function parseSavedAttachmentLine(line: string): { name: string; link: string; size: string; type?: string } | null {
  if (!/^[-*]\s+\[/.test(line)) return null;
  const tail = SAVED_ATTACHMENT_TAIL_RE.exec(line);
  if (!tail) return null;
  const open = line.indexOf('[');
  const middle = line.slice(open + 1, tail.index);
  const split = middle.lastIndexOf('](_attachments/');
  if (split < 0) return null;
  const link = middle.slice(split + 2);
  if (link.length <= '_attachments/'.length) return null;
  return { name: middle.slice(0, split), link, size: tail[1], ...(tail[2] !== undefined ? { type: tail[2] } : {}) };
}

/**
 * `## 첨부` 절의 줄 → 첨부 목록. 저장한 것 `- [이름](_attachments/<6자>/<이름>) — 1,234 bytes, \`형식\``(링크는 raw/mail 기준),
 * 실행형 `- **이름** — 1,234 bytes · **저장 안 함(실행형 파일)** · …`. 링크가 raw/mail/_attachments 밖이면 rel 을 넣지 않는다.
 * 첨부 절은 머리 영역(`## 본문` 앞 — 없으면 앞 60줄)에서만 찾는다: 수집기는 첨부가 없으면 이 절을 만들지 않으므로,
 * 본문 속 `## 첨부` 줄(밖에서 온 데이터)을 첨부 목록으로 읽지 않게.
 */
export function parseMailAttachments(afterFrontmatter: readonly string[]): MailAttachment[] {
  const bodyAt = afterFrontmatter.findIndex((l) => /^##\s+본문\s*$/.test(l));
  const end = bodyAt >= 0 ? bodyAt : Math.min(afterFrontmatter.length, ATTACHMENT_HEAD_LINES);
  let head = -1;
  for (let i = 0; i < end; i++) {
    if (/^##\s+첨부\s*$/.test(afterFrontmatter[i])) {
      head = i;
      break;
    }
  }
  if (head < 0) return [];
  const out: MailAttachment[] = [];
  for (let i = head + 1; i < end && out.length < MAIL_ATTACHMENTS_MAX; i++) {
    const raw = afterFrontmatter[i];
    if (raw.length > ATTACHMENT_LINE_MAX) continue;
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    const saved = parseSavedAttachmentLine(line);
    if (saved) {
      const item: MailAttachment = { name: saved.name.trim() || saved.link.split('/').pop() || '', blocked: false };
      const size = parseByteCount(saved.size);
      if (size !== undefined) item.size = size;
      if (saved.type?.trim()) item.contentType = saved.type.trim();
      const rel = safeVaultRelative(`raw/mail/${saved.link.trim()}`);
      // raw/mail/_attachments/<폴더>/<이름> 꼴만
      if (rel !== null && isUnderMailAttachments(rel) && rel.split('/').length === 5) item.rel = rel;
      out.push(item);
      continue;
    }
    const blocked = BLOCKED_ATTACHMENT_RE.exec(line);
    if (blocked) {
      const item: MailAttachment = { name: blocked[1].trim(), blocked: true };
      const size = parseByteCount(blocked[2]);
      if (size !== undefined) item.size = size;
      out.push(item);
    }
  }
  return out;
}

/** `<!-- links:auto -->` 블록 안의 위키링크 이름(중복 없이) */
function autoLinkNames(afterFrontmatter: readonly string[]): string[] {
  const start = afterFrontmatter.findIndex((l) => l.trim() === '<!-- links:auto -->');
  if (start < 0) return [];
  const names: string[] = [];
  for (let i = start + 1; i < afterFrontmatter.length; i++) {
    const line = afterFrontmatter[i];
    if (line.trim() === '<!-- /links:auto -->') break;
    for (const m of line.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const name = m[1].trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** 메일 파일 원문 → 읽기 칸 재료. 본문은 평문 그대로(해석하지 않는다) */
export function parseMailMessage(rel: string, text: string): MailMessage {
  const lines = splitLines(stripBom(text ?? ''));
  const fm = splitFrontmatter(lines);
  const data = fm.data ?? {};
  let subject = mailTextField(data.subject);
  if (subject === undefined) {
    const h1 = fm.bodyLines.find((l) => /^#\s+\S/.test(l));
    subject = h1 ? h1.replace(/^#\s+/, '').trim() : '(제목 없음)';
  }
  const folder = normMailFolder(mailTextField(data.folder) ?? /^raw\/mail\/([^/]+)\//.exec(rel)?.[1] ?? '');
  const suspicion = mailListField(data.suspicion, (s) => (s.trim() ? [s.trim()] : []));
  const fullBody = mailBodyLines(fm.bodyLines).join('\n');
  let body = fullBody;
  let truncated = false;
  if (body.length > MAIL_BODY_MAX) {
    let end = MAIL_BODY_MAX;
    const code = body.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    body = body.slice(0, end);
    truncated = true;
  }
  const msg: MailMessage = {
    path: rel,
    subject,
    from: mailTextField(data.from) ?? '',
    to: mailListField(data.to, splitAddressList),
    cc: mailListField(data.cc, splitAddressList),
    folder,
    suspicion,
    suspicious: suspicion.length > 0 || folder === '_격리',
    body,
    truncated,
    attachments: parseMailAttachments(fm.bodyLines),
    wikiLinks: autoLinkNames(fm.bodyLines),
  };
  const replyTo = mailTextField(data.reply_to);
  if (replyTo) msg.replyTo = replyTo;
  const date = mailTextField(data.date);
  if (date) msg.date = date;
  const messageId = cleanMessageId(data.message_id);
  if (messageId) msg.messageId = messageId;
  if (mailOriginalRel(data.original)) msg.hasOriginal = true;
  return msg;
}

/** frontmatter original(`_original/<6자>.eml`) → raw/mail 기준 경로. 꼴이 틀리면 null(2.15 원본 보기) */
export function mailOriginalRel(v: unknown): string | null {
  const s = mailTextField(v);
  return s && /^_original\/[0-9a-f]{6}\.eml$/.test(s) ? s : null;
}

/**
 * 메일 한 통 읽기(§6-2). 경로 검사는 readMailText 와 같고(raw/mail 안 .md, 실제 경로도 안, 8MB 이하) raw/mail/_attachments
 * 아래는 거부한다. 못 읽으면 null.
 */
export function readMailMessage(wikiRoot: string, relPath: string): MailMessage | null {
  const rel = normalizeMailPath(relPath);
  if (rel === null || isUnderMailAttachments(rel)) return null;
  const mail = readMailText(wikiRoot, rel);
  return mail ? parseMailMessage(mail.rel, mail.text) : null;
}

/** `## 본문` 다음 줄부터. 없으면 frontmatter·연결 블록(<!-- links:auto --> … <!-- /links:auto -->) 다음부터 */
function bodyLinesOf(afterFrontmatter: string[]): string[] {
  const bodyIdx = afterFrontmatter.findIndex((l) => /^##\s+본문\s*$/.test(l));
  if (bodyIdx >= 0) return afterFrontmatter.slice(bodyIdx + 1);
  const linksEnd = afterFrontmatter.findIndex((l) => l.trim() === '<!-- /links:auto -->');
  if (linksEnd >= 0) return afterFrontmatter.slice(linksEnd + 1);
  return afterFrontmatter;
}

/** 마크다운 기호를 걷고 공백을 합쳐 EXCERPT_MAX 글자까지 */
export function makeExcerpt(lines: readonly string[]): string {
  let text = lines.join('\n');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // 코드 울타리 표시만 없앤다(안의 글은 남긴다)
  text = text.replace(/^\s*(```|~~~).*$/gm, ' ');
  const cleaned = text
    .split('\n')
    .map((line) => {
      let s = line;
      s = s.replace(/^\s*([-*_])(\s*\1){2,}\s*$/, ''); // 가로줄
      s = s.replace(/^\s{0,3}#{1,6}\s+/, ''); // 제목
      s = s.replace(/^(\s*>)+\s?/, ''); // 인용
      s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''); // 목록
      s = s.replace(/^\[[ xX]\]\s+/, ''); // 체크박스
      s = s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s\|\s/g, ' '); // 표
      return s;
    })
    .join(' ');
  let s = cleaned;
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 그림
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 링크
  s = s.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2'); // [[문서|별칭]]
  s = s.replace(/!?\[\[([^\]]*)\]\]/g, '$1'); // [[문서]]
  s = s.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, ' '); // HTML 태그(메일 주소 <a@b> 는 남는다)
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2'); // 굵게
  s = s.replace(/~~(.+?)~~/g, '$1'); // 취소선
  s = s.replace(/`+/g, ''); // 코드
  s = s.replace(/\*(\S(?:.*?\S)?)\*/g, '$1'); // *기울임*
  s = s.replace(/(^|\s)\*+(?=\s|$)/g, '$1'); // 홀로 남은 별표
  s = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > EXCERPT_MAX ? chars.slice(0, EXCERPT_MAX).join('') : s;
}
