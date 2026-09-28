// raw/mail 메일 한 통의 요약. electron 을 import 하지 않는 순수 모듈이다.
import fs from 'node:fs';
import path from 'node:path';
import type { MailSummary } from '../../shared/types';
import { scalarToString, splitFrontmatter } from './frontmatter';
import { isInsideDir, readTextFile, safeVaultRelative, splitLines } from './fsutil';

/** 요약에 쓰는 본문 앞부분 길이(글자 수) */
export const EXCERPT_MAX = 400;
/** 이보다 큰 파일은 읽지 않는다(메일 한 통으로는 비정상) */
const MAX_MAIL_BYTES = 8 * 1024 * 1024;

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
  return summarizeMail(rel, text);
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
  if (folder) summary.folder = folder.trim();

  const excerpt = makeExcerpt(bodyLinesOf(fm.bodyLines));
  if (excerpt) summary.excerpt = excerpt;
  return summary;
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
