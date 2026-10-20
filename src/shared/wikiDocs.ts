// 위키 문서(3a단계 — docs/stage3a-contract.md) 순수 도우미. main·renderer 가 같이 쓴다(Node·DOM 없음).
import type { WikiDocKind, WikiDocSource } from './types';

/** 검색 정규화(§4): NFC → 소문자(로캘 무관) → 연속 공백·줄바꿈을 공백 하나로 */
export function normText(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/** 문서 키 `<출처>:<경로>` */
export function wikiDocKey(source: WikiDocSource, path: string): string {
  return `${source}:${path}`;
}

/** 종류 칩 글자(§8-2) */
export const WIKI_KIND_LABEL: Readonly<Record<WikiDocKind, string>> = {
  entity: '업체',
  topic: '주제',
  analysis: '분석',
  private: '비공개',
  meta: '기록',
  other: '문서',
  team: '팀',
};

/** 출처 칩 글자 */
export const WIKI_SOURCE_LABEL: Readonly<Record<WikiDocSource, string>> = {
  personal: '개인',
  team: '팀',
};

export interface WikiLinkParts {
  /** links 사전의 키 — 별칭을 뗀 대상 원문(앞뒤 공백 뗌). 예: `문서#절` */
  key: string;
  /** 대상 이름(`.md` 뗌, NFC). 빈 문자열이면 같은 문서(`[[#절]]`) */
  target: string;
  heading?: string;
  block?: string;
  alias?: string;
}

/**
 * `[[…]]` 안쪽 글을 나눈다(§2-3): `대상|별칭` · 표 안의 `대상\|별칭` · `대상#절` · `대상#^블록`.
 * 대상은 앞뒤 공백·`.md` 를 떼고 NFC 로.
 */
export function parseWikiLinkInner(inner: string): WikiLinkParts {
  let rest = inner;
  let alias: string | undefined;
  const esc = rest.indexOf('\\|');
  const bar = rest.indexOf('|');
  let cut = -1;
  let cutLen = 1;
  if (esc >= 0 && (bar < 0 || esc < bar)) {
    cut = esc;
    cutLen = 2;
  } else if (bar >= 0) {
    cut = bar;
  }
  if (cut >= 0) {
    alias = rest.slice(cut + cutLen).trim();
    rest = rest.slice(0, cut);
  }
  const key = rest.trim().normalize('NFC');
  let target = key;
  let heading: string | undefined;
  let block: string | undefined;
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const frag = target.slice(hash + 1).trim();
    target = target.slice(0, hash).trim();
    if (frag.startsWith('^')) block = frag.slice(1);
    else if (frag) heading = frag;
  }
  target = target.replace(/\.md$/i, '').trim();
  const out: WikiLinkParts = { key, target };
  if (heading) out.heading = heading;
  if (block) out.block = block;
  if (alias) out.alias = alias;
  return out;
}

/** 위키링크 키(별칭을 뗀 대상 원문) — renderer 가 page.links 를 찾는 데 쓴다 */
export function wikiLinkKey(inner: string): string {
  return parseWikiLinkInner(inner).key;
}

/** 그림 확장자(§2-4) — `.svg` 는 넣지 않는다 */
export const WIKI_IMAGE_EXTS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** 파일 이름이 미리보기 그림 확장자인가(대소문자 무시) */
export function isWikiImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return WIKI_IMAGE_EXTS.some((e) => lower.endsWith(e));
}
