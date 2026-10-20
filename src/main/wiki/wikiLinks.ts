// 위키링크 뽑기 · 이름 사전 · 해석(docs/stage3a-contract.md §2-3). electron 을 import 하지 않는 순수 모듈이다.
//
// - 코드 블록(``` ``` ```·`~~~`)과 인라인 코드(`` ` ``) 안의 `[[…]]` 는 뽑지 않는다.
// - 해석 순서: 같은 출처(경로 꼴 → 파일 이름 → 별칭) → 다른 출처(같은 순서, crossSource) → 없음(null).
// - 같은 이름이 여럿이면 개인은 `wiki/` 아래 → 지금 문서와 같은 폴더 → 짧은 경로 → 사전순(결정적).
import path from 'node:path';
import type { WikiLinkTarget, WikiDocSource } from '../../shared/types';
import { parseWikiLinkInner, type WikiLinkParts } from '../../shared/wikiDocs';
import { compareCodeUnits } from './fsutil';

/** 문서 하나의 나가는 링크 최대 수 */
export const WIKI_LINKS_MAX = 500;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface FenceInfo {
  /** 이 줄이 코드 블록 안(여는·닫는 줄 포함)인가 */
  code: boolean;
  /** 코드 블록이면 정보 문자열의 첫 낱말(소문자) */
  lang?: string;
}

/** 줄마다 코드 블록 안인가. 닫히지 않은 블록은 문서 끝까지 */
export function fenceMap(lines: readonly string[]): FenceInfo[] {
  const out: FenceInfo[] = [];
  let open: { ch: string; len: number; lang: string } | null = null;
  for (const line of lines) {
    if (open) {
      const t = line.trim();
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      out.push({ code: true, lang: open.lang });
      if (close && close[1][0] === open.ch && close[1].length >= open.len && t.length > 0) open = null;
      continue;
    }
    const m = FENCE_OPEN_RE.exec(line);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      const lang = m[2].trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      open = { ch: m[1][0], len: m[1].length, lang };
      out.push({ code: true, lang });
      continue;
    }
    out.push({ code: false });
  }
  return out;
}

/** 한 줄의 인라인 코드(같은 길이 백틱 사이)를 공백으로 */
function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    const run = j - i;
    // 같은 길이의 닫는 백틱 찾기
    let k = j;
    let close = -1;
    while (k < line.length) {
      if (line[k] === '`') {
        let e = k;
        while (e < line.length && line[e] === '`') e++;
        if (e - k === run) {
          close = k;
          break;
        }
        k = e;
      } else {
        k++;
      }
    }
    if (close < 0) {
      out += line.slice(i, j);
      i = j;
      continue;
    }
    out += ' '.repeat(close + run - i);
    i = close + run;
  }
  return out;
}

/**
 * 코드 블록·인라인 코드를 같은 길이의 공백으로 바꾼 본문(줄바꿈은 그대로 — 위치가 원문과 같다).
 * 위키링크·그림 참조·제목 찾기에 쓴다.
 */
export function maskCode(body: string): string {
  const lines = body.split('\n');
  const fences = fenceMap(lines);
  return lines.map((l, i) => (fences[i].code ? ' '.repeat(l.length) : maskInlineCode(l))).join('\n');
}

/** Dataview(```dataview·```dataviewjs) 블록만 같은 길이의 공백으로(검색·조각에서 뺀다 — §4) */
export function maskDataview(body: string): string {
  if (!/dataview/i.test(body)) return body;
  const lines = body.split('\n');
  const fences = fenceMap(lines);
  return lines.map((l, i) => (fences[i].code && (fences[i].lang === 'dataview' || fences[i].lang === 'dataviewjs') ? ' '.repeat(l.length) : l)).join('\n');
}

export interface ExtractedLink extends WikiLinkParts {
  /** `![[…]]` (포함) */
  embed: boolean;
}

const WIKILINK_RE = /(!?)\[\[([^[\]\n]*?)\]\]/g;

/** 본문의 위키링크(코드 밖). 같은 것이 여러 번 나오면 여러 번 */
export function extractWikiLinks(body: string): ExtractedLink[] {
  const text = maskCode(body);
  const out: ExtractedLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const parts = parseWikiLinkInner(m[2]);
    if (!parts.key && !parts.target) continue;
    out.push({ ...parts, embed: m[1] === '!' });
  }
  return out;
}

/** 색인용: 나가는 링크 대상 이름(중복 없이, 최대 500 — 같은 문서 `[[#절]]` 은 뺀다) */
export function outgoingLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const l of extractWikiLinks(body)) {
    if (!l.target) continue;
    seen.add(l.target);
    if (seen.size >= WIKI_LINKS_MAX) break;
  }
  return [...seen];
}

// ---- 이름 사전 ------------------------------------------------------------------------------

export interface NameDict {
  /** 파일 이름(.md 뗌, 소문자, NFC) → 경로들 */
  byName: Map<string, string[]>;
  /** 별칭(소문자, NFC) → 경로들 */
  byAlias: Map<string, string[]>;
  /** 경로(.md 뗌, 소문자, NFC) → 경로 */
  byPath: Map<string, string>;
}

const lowerKey = (s: string): string => s.normalize('NFC').toLowerCase();

function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) {
    if (!arr.includes(value)) arr.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** 출처 하나의 이름 사전 */
export function buildNameDict(docs: Iterable<{ path: string; aliases?: readonly string[] }>): NameDict {
  const dict: NameDict = { byName: new Map(), byAlias: new Map(), byPath: new Map() };
  for (const d of docs) {
    const noExt = d.path.replace(/\.md$/i, '');
    dict.byPath.set(lowerKey(noExt), d.path);
    push(dict.byName, lowerKey(path.posix.basename(noExt)), d.path);
    for (const a of d.aliases ?? []) {
      const k = lowerKey(a.trim());
      if (k) push(dict.byAlias, k, d.path);
    }
  }
  return dict;
}

/** 같은 이름이 여럿일 때 하나(§2-3) */
export function pickCandidate(source: WikiDocSource, candidates: readonly string[], fromPath: string | null): string {
  if (candidates.length === 1) return candidates[0];
  const fromDir = fromPath ? path.posix.dirname(fromPath) : null;
  const rank = (p: string): number[] => [
    source === 'personal' && p.startsWith('wiki/') ? 0 : 1,
    fromDir !== null && path.posix.dirname(p) === fromDir ? 0 : 1,
    p.split('/').length,
    p.length,
  ];
  return [...candidates].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return compareCodeUnits(a, b);
  })[0];
}

/** 한 출처 안에서 대상 이름 하나 찾기(경로 꼴 → 파일 이름 → 별칭). 없으면 null */
export function lookupInDict(source: WikiDocSource, dict: NameDict, target: string, fromPath: string | null): string | null {
  const t = target.normalize('NFC').replace(/\\/g, '/');
  if (t.includes('/')) {
    const abs = dict.byPath.get(lowerKey(t.replace(/^\/+/, '')));
    if (abs) return abs;
    if (fromPath) {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), t));
      if (!joined.startsWith('../') && joined !== '..') {
        const rel = dict.byPath.get(lowerKey(joined));
        if (rel) return rel;
      }
    }
  }
  const name = lowerKey(t.includes('/') ? path.posix.basename(t) : t);
  const byName = dict.byName.get(name);
  if (byName && byName.length > 0) {
    if (t.includes('/')) {
      // 경로 꼴(`[[dev/설계]]`)은 링크에 적힌 폴더로 끝나는 후보를 먼저 — 없을 때만 파일 이름으로
      const suffix = `/${lowerKey(t.replace(/^\/+/, '').replace(/\.md$/i, ''))}`;
      const tail = byName.filter((p) => `/${lowerKey(p.replace(/\.md$/i, ''))}`.endsWith(suffix));
      if (tail.length > 0) return pickCandidate(source, tail, fromPath);
    }
    return pickCandidate(source, byName, fromPath);
  }
  const byAlias = dict.byAlias.get(lowerKey(t));
  if (byAlias && byAlias.length > 0) return pickCandidate(source, byAlias, fromPath);
  return null;
}

/**
 * 링크 해석(§2-3). key 는 `[[…]]` 의 별칭을 뗀 대상 원문(`대상#절` 꼴).
 * 같은 출처 먼저, 없으면 다른 출처(crossSource). 대상이 비면 같은 문서. 없으면 null.
 */
export function resolveLink(
  dicts: Partial<Record<WikiDocSource, NameDict>>,
  from: { source: WikiDocSource; path: string },
  key: string,
): WikiLinkTarget | null {
  const parts = parseWikiLinkInner(key);
  const extra = (t: WikiLinkTarget): WikiLinkTarget => {
    if (parts.heading) t.heading = parts.heading;
    if (parts.block) t.block = parts.block;
    return t;
  };
  if (!parts.target) return extra({ source: from.source, path: from.path });
  const same = dicts[from.source];
  if (same) {
    const hit = lookupInDict(from.source, same, parts.target, from.path);
    if (hit) return extra({ source: from.source, path: hit });
  }
  const other: WikiDocSource = from.source === 'personal' ? 'team' : 'personal';
  const od = dicts[other];
  if (od) {
    // 팀 위키는 개인 위키에서 보낸 문서를 같은 경로로 담는다(2.11) — 같은 폴더 기준도 그대로 쓴다
    const hit = lookupInDict(other, od, parts.target, from.path);
    if (hit) return extra({ source: other, path: hit, crossSource: true });
  }
  return null;
}
