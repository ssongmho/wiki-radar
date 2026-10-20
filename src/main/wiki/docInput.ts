// 3a단계 IPC 인자 검사 · 그림 참조 풀기 · 외부 링크 주소 검사(docs/stage3a-contract.md §6·§7·§11).
// electron 을 import 하지 않는다. renderer 가 보낸 값은 모두 여기서 모양·길이를 본 뒤에만 쓴다.
import path from 'node:path';
import type { MarkWikiSeenInput, WikiDocInput, WikiSearchQuery, WikiSearchSource, WikiDocSource } from '../../shared/types';
import { isWikiImageName } from '../../shared/wikiDocs';
import { safeVaultRelative } from './fsutil';
import type { ImageDict, WikiImageFile } from './docIndex';
import { maskCode } from './wikiLinks';

export const WIKI_QUERY_MAX = 200;
export const WIKI_PATH_MAX = 1024;
export const WIKI_REF_MAX = 512;
export const WIKI_URL_MAX = 2048;
export const WIKI_SEEN_ITEMS_MAX = 500;
export const WIKI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function bad(what: string): never {
  throw new Error(`잘못된 요청입니다: ${what}`);
}

function plainObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(what);
  return v as Record<string, unknown>;
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) bad(what);
  return v;
}

export function requireWikiSource(v: unknown): WikiDocSource {
  if (v === 'personal' || v === 'team') return v;
  bad('출처');
}

export function requireSearchSource(v: unknown): WikiSearchSource {
  if (v === 'all' || v === 'personal' || v === 'team') return v;
  bad('출처');
}

/**
 * 문서 경로(출처 루트 기준): 1024자 이하 · safeVaultRelative(`..`·절대경로·드라이브·제어 문자·장치 이름 거부) · `.md`. NFC 로 돌려준다
 */
export function requireWikiDocPath(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > WIKI_PATH_MAX) bad('문서 경로');
  const rel = safeVaultRelative(v);
  if (!rel || !rel.toLowerCase().endsWith('.md') || rel.length <= 3) bad('문서 경로');
  return rel.normalize('NFC');
}

export function requireWikiDocInput(v: unknown): WikiDocInput {
  const o = plainObject(v, '문서');
  return { source: requireWikiSource(o.source), path: requireWikiDocPath(o.path) };
}

export function requireSearchQuery(v: unknown): WikiSearchQuery {
  const o = plainObject(v, '검색');
  const q = o.query;
  if (typeof q !== 'string' || q.length === 0 || q.length > WIKI_QUERY_MAX || CONTROL_RE.test(q.replace(/[\t\n\r]/g, ' '))) bad('검색어');
  if (q.trim() === '') bad('검색어');
  return {
    query: q,
    source: requireSearchSource(o.source),
    limit: intIn(o.limit, 1, 200, 'limit'),
    offset: intIn(o.offset, 0, 10_000, 'offset'),
  };
}

export function requireRecentInput(v: unknown): { source: WikiSearchSource; limit: number } {
  const o = plainObject(v, '최근 문서');
  return { source: requireSearchSource(o.source), limit: intIn(o.limit, 1, 50, 'limit') };
}

export function requireChangesInput(v: unknown): { source: WikiDocSource; offset: number; limit: number } {
  const o = plainObject(v, '변경 목록');
  return { source: requireWikiSource(o.source), offset: intIn(o.offset, 0, 2_000, 'offset'), limit: intIn(o.limit, 1, 200, 'limit') };
}

export function requireImageInput(v: unknown): { source: WikiDocSource; page: string; ref: string } {
  const o = plainObject(v, '그림');
  const ref = o.ref;
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > WIKI_REF_MAX || CONTROL_RE.test(ref)) bad('그림 참조');
  return { source: requireWikiSource(o.source), page: requireWikiDocPath(o.page), ref };
}

/** 읽음으로: {items: 1~500} 또는 {all: true, source}. 경로는 색인에 없어도 된다(지운 문서) */
export function requireMarkSeenInput(v: unknown): MarkWikiSeenInput {
  const o = plainObject(v, '읽음');
  if (o.all === true) return { all: true, source: requireWikiSource(o.source) };
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > WIKI_SEEN_ITEMS_MAX) bad('읽음 목록');
  return { items: o.items.map(requireWikiDocInput) };
}

export function requireUndoToken(v: unknown): string {
  if (typeof v === 'string' && /^u[0-9a-z]{1,32}$/.test(v)) return v;
  bad('되돌리기');
}

/**
 * 외부 링크 주소(§7-3): 1~2048자 · `new URL` 로 파싱 · http/https 만 · 사용자 정보·제어 문자·공백 없음. 정규화한 href
 */
export function requireExternalUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > WIKI_URL_MAX) bad('주소');
  if (CONTROL_RE.test(v) || /\s/.test(v)) bad('주소');
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    bad('주소');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') bad('주소(http·https 만 엽니다)');
  if (url.username || url.password) bad('주소(사용자 정보가 든 주소는 열지 않습니다)');
  if (!url.hostname) bad('주소');
  return url.href;
}

// ---- 그림 참조(§7-4) ----------------------------------------------------------------------------

export interface ImageRef {
  /** renderer 가 보내는 참조 원문(`![[…]]` 의 대상 또는 `![…](…)` 의 주소) */
  ref: string;
  kind: 'embed' | 'md';
}

const EMBED_RE = /!\[\[([^[\]\n]*?)\]\]/g;
/**
 * `![대체 글](주소 "제목")` 에서 `]` 뒤 꼬리(sticky). 대체 글은 정규식으로 찾지 않는다 — `![` 가 많고 `]` 가 없는 줄에서
 * 시작 위치마다 줄 끝까지 다시 훑어 제곱 시간이 되기 때문(메인 프로세스가 멈춘다). 꺾쇠 주소·괄호 제목은 여는 괄호에서도 멈추고
 * (CommonMark 도 이스케이프 없는 `<`·`(` 를 허용하지 않는다), 따옴표 제목은 길이를 묶는다.
 */
const MD_IMG_TAIL_RE =
  /\(\s*(<[^<>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]{0,1000}"|'[^'\n]{0,1000}'|\([^()\n]*\)))?\s*\)/y;

/** 본문의 `![…](…)` 주소 원문들 — 한 번 훑는 선형 시간(같은 `]` 를 함께 쓰는 `![` 들은 한 번만 본다) */
function mdImageUrls(text: string): string[] {
  const out: string[] = [];
  let close = -1; // 지금 `![` 뒤 첫 `]`
  let nl = -1; // 지금 `![` 뒤 첫 줄바꿈(없으면 끝)
  let i = 0;
  for (;;) {
    i = text.indexOf('![', i);
    if (i < 0) break;
    const from = i + 2;
    if (close < from) {
      close = text.indexOf(']', from);
      if (close < 0) break;
    }
    if (nl < from) {
      nl = text.indexOf('\n', from);
      if (nl < 0) nl = text.length;
    }
    if (nl < close) {
      i = nl + 1; // 대체 글은 줄을 넘지 않는다
      continue;
    }
    MD_IMG_TAIL_RE.lastIndex = close + 1;
    const m = MD_IMG_TAIL_RE.exec(text);
    if (m) {
      out.push(m[1]);
      i = MD_IMG_TAIL_RE.lastIndex;
    } else {
      i = close + 1; // 이 `]` 를 함께 쓰는 다른 `![` 도 꼬리가 같아 실패한다
    }
  }
  return out;
}

/** 본문의 그림 참조(코드 밖). `![[문서]]`(포함) 처럼 그림이 아닌 포함은 뺀다 */
export function imageRefsOf(body: string): ImageRef[] {
  const text = maskCode(body);
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(EMBED_RE)) {
    const inner = m[1];
    const cut = inner.search(/\\?\|/);
    const target = (cut >= 0 ? inner.slice(0, cut) : inner).trim();
    const name = target.split('#')[0].trim();
    if (!name || (!isWikiImageName(name) && !name.toLowerCase().endsWith('.svg'))) continue;
    if (!seen.has(`e:${target}`)) {
      seen.add(`e:${target}`);
      out.push({ ref: target, kind: 'embed' });
    }
  }
  for (const raw of mdImageUrls(text)) {
    let url = raw.trim();
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim();
    if (!url) continue;
    if (!seen.has(`m:${url}`)) {
      seen.add(`m:${url}`);
      out.push({ ref: url, kind: 'md' });
    }
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** renderer 가 보낸 ref 가 본문의 그림 참조인가(markdown-it 가 주소를 %-인코딩해도 맞게 — 풀어서도 비교) */
export function findImageRef(body: string, ref: string): ImageRef | null {
  const refs = imageRefsOf(body);
  const exact = refs.find((r) => r.ref === ref);
  if (exact) return exact;
  const dec = safeDecode(ref);
  return refs.find((r) => safeDecode(r.ref) === dec) ?? null;
}

export type ImageResolution = { ok: true; path: string } | { ok: false; reason: string };

export const IMAGE_REASONS = {
  remote: '원격 그림 — 불러오지 않음',
  svg: 'SVG 그림 — Obsidian 에서 보기',
  scheme: '위키 밖 주소의 그림 — 불러오지 않음',
  ext: '미리보기를 하지 않는 그림 형식',
  missing: '그림 파일을 찾지 못함',
  outside: '위키 밖 경로의 그림 — 불러오지 않음',
  big: '그림이 커서(5MB 넘음) 보이지 않음',
  signature: '그림 파일 형식이 확장자와 맞지 않음',
} as const;

function pickImage(files: readonly WikiImageFile[], fromDir: string): WikiImageFile {
  return [...files].sort((a, b) => {
    const sa = path.posix.dirname(a.path) === fromDir ? 0 : 1;
    const sb = path.posix.dirname(b.path) === fromDir ? 0 : 1;
    return sa - sb || a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  })[0];
}

/**
 * 참조 → 출처 루트 기준 그림 경로(파일 존재는 exists 로 확인). 위키 안의 그림만 — 원격·SVG·다른 스킴은 이유와 함께 거부.
 * 경로는 그림 사전(이름) 또는 문서 폴더 기준 상대경로(볼트 기준 `/…` 도)로 푼다.
 */
export function resolveImageRef(
  r: ImageRef,
  pagePath: string,
  dict: ImageDict,
  exists: (rel: string) => boolean,
): ImageResolution {
  const fromDir = path.posix.dirname(pagePath);
  let target = r.ref;
  if (r.kind === 'md') {
    if (/^https?:/i.test(target) || target.startsWith('//')) return { ok: false, reason: IMAGE_REASONS.remote };
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return { ok: false, reason: IMAGE_REASONS.scheme };
    target = safeDecode(target.split('#')[0].split('?')[0]);
  } else {
    target = target.split('#')[0].trim();
  }
  const lower = target.toLowerCase();
  if (lower.endsWith('.svg')) return { ok: false, reason: IMAGE_REASONS.svg };
  if (!isWikiImageName(lower)) return { ok: false, reason: IMAGE_REASONS.ext };
  const candidates: string[] = [];
  const norm = target.replace(/\\/g, '/');
  if (norm.startsWith('/')) {
    candidates.push(norm.replace(/^\/+/, ''));
  } else {
    candidates.push(path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, norm)));
    if (r.kind === 'embed' && norm.includes('/')) candidates.push(norm);
  }
  for (const c of candidates) {
    const safe = safeVaultRelative(c);
    if (!safe) {
      if (c.startsWith('..') || c.startsWith('/')) return { ok: false, reason: IMAGE_REASONS.outside };
      continue;
    }
    const known = dict.byPath.get(safe.normalize('NFC').toLowerCase());
    if (known) return { ok: true, path: known.path };
    if (exists(safe)) return { ok: true, path: safe };
  }
  if (r.kind === 'embed') {
    const byName = dict.byName.get(path.posix.basename(norm).normalize('NFC').toLowerCase());
    if (byName && byName.length > 0) return { ok: true, path: pickImage(byName, fromDir).path };
  }
  return { ok: false, reason: IMAGE_REASONS.missing };
}

/** 파일 앞 바이트의 형식(서명). 맞는 것이 없으면 null */
export function imageTypeOf(buf: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  const b = buf;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  return null;
}

/** 확장자 → 형식 */
export function imageTypeOfName(name: string): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  const l = name.toLowerCase();
  if (l.endsWith('.png')) return 'png';
  if (l.endsWith('.jpg') || l.endsWith('.jpeg')) return 'jpeg';
  if (l.endsWith('.gif')) return 'gif';
  if (l.endsWith('.webp')) return 'webp';
  return null;
}
