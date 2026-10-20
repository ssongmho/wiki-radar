// 위키 검색(docs/stage3a-contract.md §4). electron 을 import 하지 않는 순수 모듈이다.
// DESIGN §4 「DB 는 두지 않는다. 전부 메모리에 올리고 검색은 전체 스캔」 — 정규화 글을 미리 만들어 두고 훑는다.
import path from 'node:path';
import type { WikiDocRef, WikiSearchHit, WikiSearchSource } from '../../shared/types';
import { normText } from '../../shared/wikiDocs';
import { compareCodeUnits } from './fsutil';
import type { WikiDocEntry } from './docIndex';
import { maskDataview } from './wikiLinks';

/** 결과 한도 */
export const WIKI_SEARCH_DEFAULT_LIMIT = 50;
export const WIKI_SEARCH_MAX_LIMIT = 200;
/** 낱말 최대 수 */
export const WIKI_SEARCH_MAX_TERMS = 8;
/** 조각 앞뒤 글자 수(코드 포인트) */
export const SNIPPET_SIDE = 40;
/** 제목만 맞을 때 조각 길이 */
export const SNIPPET_HEAD = 80;
const HITS_MAX = 10;

/** 검색용으로 미리 만든 문서 */
export interface SearchDoc {
  entry: WikiDocEntry;
  titleN: string;
  aliasesN: string[];
  nameN: string;
  /** 제목·별칭·파일 이름을 합친 것 */
  metaN: string;
  /** 본문(Dataview 블록 뺌) 정규화 */
  bodyN: string;
}

/** 항목 → 검색 문서(본문 정규화). 항목 객체가 같으면 다시 만들지 않도록 부르는 쪽이 캐시한다 */
export function prepareSearchDoc(entry: WikiDocEntry): SearchDoc {
  const titleN = normText(entry.title).trim();
  const aliasesN = (entry.fm.aliases ?? []).map((a) => normText(a).trim()).filter((a) => a !== '');
  const nameN = normText(path.posix.basename(entry.path).replace(/\.md$/i, '')).trim();
  const body = entry.body ?? '';
  return {
    entry,
    titleN,
    aliasesN,
    nameN,
    metaN: [titleN, ...aliasesN, nameN].join('\u0001'),
    bodyN: body ? normText(maskDataview(body)) : '',
  };
}

/** 질의 → 낱말(중복 없이 최대 8개). 비면 [] */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const t of normText(query).trim().split(' ')) {
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= WIKI_SEARCH_MAX_TERMS) break;
  }
  return out;
}

const KIND_BONUS: Partial<Record<WikiDocEntry['kind'], number>> = { entity: 30, topic: 10, analysis: 5, meta: -50 };

function countOccurrences(hay: string, needle: string, max: number): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < max) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

interface Scored {
  doc: SearchDoc;
  score: number;
  matchedTitle: boolean;
}

/** 한 문서의 점수(맞지 않으면 null) */
export function scoreDoc(doc: SearchDoc, terms: readonly string[], phrase: string): Scored | null {
  let allMeta = true;
  for (const t of terms) {
    const inMeta = doc.metaN.includes(t);
    if (!inMeta) allMeta = false;
    if (!inMeta && !doc.bodyN.includes(t)) return null;
  }
  let score = 0;
  if (doc.titleN === phrase || doc.aliasesN.includes(phrase)) score += 1000;
  else if (doc.titleN.startsWith(phrase)) score += 500;
  else if (doc.titleN.includes(phrase)) score += 300;
  if (allMeta) score += 200;
  if (doc.entry.source === 'personal') score += KIND_BONUS[doc.entry.kind] ?? 0;
  let count = countOccurrences(doc.bodyN, phrase, 20);
  if (count === 0 && terms.length > 1) count = countOccurrences(doc.bodyN, terms[0], 20);
  score += Math.min(20, count);
  return { doc, score, matchedTitle: allMeta };
}

function compareScored(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    b.doc.entry.mtimeMs - a.doc.entry.mtimeMs ||
    (a.doc.entry.source === b.doc.entry.source ? 0 : a.doc.entry.source === 'personal' ? -1 : 1) ||
    compareCodeUnits(a.doc.entry.path, b.doc.entry.path)
  );
}

/** 공백 묶음을 하나로(코드 포인트 배열) */
function collapse(chars: readonly string[]): string {
  return chars.join('').replace(/\s+/g, ' ');
}

/**
 * 조각(§4): 본문에서 질의 전체(없으면 본문에 있는 첫 낱말)의 첫 위치를 중심으로 앞뒤 40자. 줄바꿈·연속 공백은 공백 하나,
 * 잘린 쪽에 `…`. 강조 범위는 조각 안의 모든 낱말(최대 10개). 본문에서 못 찾으면 본문 첫 80자·강조 없음.
 */
export function makeSnippet(body: string, terms: readonly string[], phrase: string): { snippet: string; hits: [number, number][] } {
  const text = maskDataview(body);
  const lower = text.toLowerCase();
  const lowerSafe = lower.length === text.length;
  let at = -1;
  let len = 0;
  if (lowerSafe) {
    at = lower.indexOf(phrase);
    len = phrase.length;
    if (at < 0) {
      for (const t of terms) {
        const i = lower.indexOf(t);
        if (i >= 0) {
          at = i;
          len = t.length;
          break;
        }
      }
    }
  }
  if (at < 0) {
    const chars = Array.from(text.trimStart());
    const head = collapse(chars.slice(0, SNIPPET_HEAD)).trim();
    return { snippet: chars.length > SNIPPET_HEAD ? `${head}…` : head, hits: [] };
  }
  // 코드 포인트 기준으로 앞뒤 40자
  const before = Array.from(text.slice(0, at));
  const match = Array.from(text.slice(at, at + len));
  const after = Array.from(text.slice(at + len));
  const pre = before.slice(Math.max(0, before.length - SNIPPET_SIDE));
  const post = after.slice(0, SNIPPET_SIDE);
  let snippet = collapse([...pre, ...match, ...post]);
  const cutStart = before.length > SNIPPET_SIDE;
  const cutEnd = after.length > SNIPPET_SIDE;
  if (!cutStart) snippet = snippet.trimStart();
  if (!cutEnd) snippet = snippet.trimEnd();
  if (cutStart) snippet = `…${snippet}`;
  if (cutEnd) snippet = `${snippet}…`;
  const snipLower = snippet.toLowerCase();
  const hits: [number, number][] = [];
  if (snipLower.length === snippet.length) {
    const ranges: [number, number][] = [];
    for (const t of terms) {
      let i = snipLower.indexOf(t);
      while (i >= 0 && ranges.length < 50) {
        ranges.push([i, i + t.length]);
        i = snipLower.indexOf(t, i + t.length);
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    for (const r of ranges) {
      const last = hits[hits.length - 1];
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
        continue;
      }
      hits.push([r[0], r[1]]);
      if (hits.length >= HITS_MAX) break;
    }
  }
  return { snippet, hits };
}

export interface SearchOptions {
  query: string;
  source: WikiSearchSource;
  limit: number;
  offset: number;
}

export interface SearchResult {
  hits: WikiSearchHit[];
  total: number;
  counts: { personal: number; team: number };
}

/** 메모리 전체 훑기 */
export function searchDocs(docs: Iterable<SearchDoc>, opts: SearchOptions): SearchResult {
  const terms = queryTerms(opts.query);
  const counts = { personal: 0, team: 0 };
  if (terms.length === 0) return { hits: [], total: 0, counts };
  const phrase = terms.join(' ');
  const matched: Scored[] = [];
  for (const doc of docs) {
    const s = scoreDoc(doc, terms, phrase);
    if (!s) continue;
    counts[doc.entry.source]++;
    if (opts.source === 'all' || opts.source === doc.entry.source) matched.push(s);
  }
  matched.sort(compareScored);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), WIKI_SEARCH_MAX_LIMIT);
  const offset = Math.max(0, Math.floor(opts.offset));
  const hits = matched.slice(offset, offset + limit).map((s): WikiSearchHit => {
    const e = s.doc.entry;
    const { snippet, hits: ranges } = makeSnippet(e.body ?? '', terms, phrase);
    return {
      source: e.source,
      path: e.path,
      title: e.title,
      kind: e.kind,
      private: e.private,
      snippet,
      hits: ranges,
      matchedTitle: s.matchedTitle,
      mtimeMs: e.mtimeMs,
    };
  });
  return { hits, total: matched.length, counts };
}

/** 항목 → 참조 */
export function docRefOf(e: WikiDocEntry): WikiDocRef {
  return { source: e.source, path: e.path, title: e.title, kind: e.kind, private: e.private, mtimeMs: e.mtimeMs };
}

/** 최근 바뀐 문서(mtime 순 — 빈 질의 화면) */
export function recentDocs(entries: Iterable<WikiDocEntry>, source: WikiSearchSource, limit: number): WikiDocRef[] {
  const list: WikiDocEntry[] = [];
  for (const e of entries) if (source === 'all' || e.source === source) list.push(e);
  list.sort(
    (a, b) =>
      b.mtimeMs - a.mtimeMs ||
      (a.source === b.source ? 0 : a.source === 'personal' ? -1 : 1) ||
      compareCodeUnits(a.path, b.path),
  );
  return list.slice(0, Math.max(1, Math.min(50, limit))).map(docRefOf);
}
