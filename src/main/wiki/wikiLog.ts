// 개인 위키 log.md → 「왜 바뀌었는지」(docs/stage3a-contract.md §5-5). electron 을 import 하지 않는 순수 모듈이다.
//
// - 머리 `## [YYYY-MM-DD] 종류 | 제목` (종류 없이 `## [YYYY-MM-DD] 제목` 도). 날짜가 달력에 없는 머리는 항목이 아니다.
// - 항목 본문은 다음 `## ` 앞까지. 링크는 개인 이름 사전으로만 해석한다(다른 출처로 넘어가지 않는다).
// - log.md 가 없거나 형식이 다르면 이유·최근 기록 없이 동작한다(오류 아님).
import type { WikiLogReason } from '../../shared/types';
import { addDays, isValidYmd } from './calendar';
import { extractWikiLinks, lookupInDict, type NameDict } from './wikiLinks';

export const LOG_EXCERPT_MAX = 200;
/** 최근 기록 기간·수 */
export const LOG_RECENT_DAYS = 14;
export const LOG_RECENT_MAX = 50;
/** 이유 최대 수 */
export const LOG_REASONS_MAX = 2;

export interface WikiLogItem {
  date: string;
  kind?: string;
  title: string;
  /** 머리 다음 줄부터 다음 `## ` 앞까지 */
  body: string;
  /** 파일 안 순서(0부터) */
  order: number;
}

const HEAD_RE = /^##[ \t]+\[(\d{4}-\d{2}-\d{2})\][ \t]*(.*)$/;

/** log.md 원문 → 항목들(파일 순서) */
export function parseWikiLog(text: string): WikiLogItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const out: WikiLogItem[] = [];
  let cur: { item: WikiLogItem; body: string[] } | null = null;
  const close = (): void => {
    if (!cur) return;
    cur.item.body = cur.body.join('\n').trim();
    out.push(cur.item);
    cur = null;
  };
  for (const line of lines) {
    if (/^##[ \t]/.test(line) || line === '##') {
      close();
      const m = HEAD_RE.exec(line);
      if (!m || !isValidYmd(m[1])) continue;
      const rest = m[2].trim();
      const bar = rest.indexOf('|');
      let kind: string | undefined;
      let title = rest;
      if (bar >= 0) {
        const k = rest.slice(0, bar).trim();
        title = rest.slice(bar + 1).trim();
        if (k) kind = k;
      }
      const item: WikiLogItem = { date: m[1], title: title || '(제목 없음)', body: '', order: out.length };
      if (kind) item.kind = kind;
      cur = { item, body: [] };
      continue;
    }
    if (/^#[ \t]/.test(line)) {
      // 더 큰 머리(# )도 항목을 끝낸다
      close();
      continue;
    }
    cur?.body.push(line);
  }
  close();
  return out.map((it, i) => ({ ...it, order: i }));
}

/** 본문 앞 200자(줄바꿈은 공백) */
export function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > LOG_EXCERPT_MAX ? `${chars.slice(0, LOG_EXCERPT_MAX).join('')}…` : flat;
}

export interface ResolvedLogItem extends WikiLogItem {
  /** 링크된 개인 문서 경로들(중복 없이) */
  docs: string[];
}

/** 항목마다 머리·본문의 위키링크를 개인 이름 사전으로 해석 */
export function resolveLogItems(items: readonly WikiLogItem[], dict: NameDict | undefined): ResolvedLogItem[] {
  return items.map((it) => {
    const docs: string[] = [];
    if (dict) {
      for (const l of extractWikiLinks(`${it.title}\n${it.body}`)) {
        if (!l.target) continue;
        const p = lookupInDict('personal', dict, l.target, 'log.md');
        if (p && !docs.includes(p)) docs.push(p);
      }
    }
    return { ...it, docs };
  });
}

/** 문서 → 그 문서를 가리키는 항목들(경로 → 항목, 최근 순) */
export function logItemsByDoc(items: readonly ResolvedLogItem[]): Map<string, ResolvedLogItem[]> {
  const map = new Map<string, ResolvedLogItem[]>();
  for (const it of items) {
    for (const p of it.docs) {
      const arr = map.get(p);
      if (arr) arr.push(it);
      else map.set(p, [it]);
    }
  }
  for (const arr of map.values()) arr.sort(compareRecent);
  return map;
}

function compareRecent(a: WikiLogItem, b: WikiLogItem): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : b.order - a.order;
}

function reasonOf(it: WikiLogItem): WikiLogReason {
  const r: WikiLogReason = { date: it.date, title: it.title, excerpt: excerptOf(it.body) };
  if (it.kind) r.kind = it.kind;
  return r;
}

/** 이유 붙이기(§5-5): 날짜 ≥ sinceDate 인 항목 최근 순 최대 2개 */
export function reasonsFor(byDoc: Map<string, ResolvedLogItem[]>, docPath: string, sinceDate: string): WikiLogReason[] {
  const items = byDoc.get(docPath) ?? [];
  return items.filter((it) => it.date >= sinceDate).slice(0, LOG_REASONS_MAX).map(reasonOf);
}

/** 최근 기록(§5-5): 오늘 기준 14일(오늘 포함), 최대 50개, 최근 순 */
export function recentLogItems(items: readonly ResolvedLogItem[], today: string): ResolvedLogItem[] {
  if (!isValidYmd(today)) return [];
  const since = addDays(today, -(LOG_RECENT_DAYS - 1));
  return items
    .filter((it) => it.date >= since && it.date <= today)
    .sort(compareRecent)
    .slice(0, LOG_RECENT_MAX);
}

export { reasonOf as logReasonOf };
