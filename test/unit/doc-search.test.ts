// 3a단계 §4 검색: 정규화·AND 낱말·제목 우선 순위·조각·출처 필터
import { describe, expect, it } from 'vitest';
import { parseDocText, type WikiDocEntry } from '../../src/main/wiki/docIndex';
import { makeSnippet, prepareSearchDoc, queryTerms, recentDocs, searchDocs, type SearchDoc } from '../../src/main/wiki/docSearch';
import { normText } from '../../src/shared/wikiDocs';
import type { WikiDocSource } from '../../src/shared/types';

function doc(source: WikiDocSource, rel: string, text: string, mtimeMs = 1000): WikiDocEntry {
  return { ...parseDocText(source, rel, text), size: text.length, mtimeMs };
}

function docs(...entries: WikiDocEntry[]): SearchDoc[] {
  return entries.map(prepareSearchDoc);
}

const q = (query: string, source: 'all' | WikiDocSource = 'all', limit = 50) => ({ query, source, limit, offset: 0 });

describe('정규화', () => {
  it('NFC/NFD · 대소문자 · 공백', () => {
    expect(normText('한결 CMS\n\n  배치'.normalize('NFD'))).toBe('한결 cms 배치');
    expect(queryTerms('  CMS  cms  배치 ')).toEqual(['cms', '배치']);
    expect(queryTerms('a b c d e f g h i j')).toHaveLength(8);
  });

  it('NFD 파일 이름도 찾는다', () => {
    const d = docs(doc('personal', `wiki/${'한결'.normalize('NFD')}.md`, '본문'));
    expect(searchDocs(d, q('한결')).total).toBe(1);
  });
});

describe('맞음·순위', () => {
  const meeting = doc('personal', 'notes/회의록.md', `# 회의록\n${'한결 이야기 '.repeat(30)}`, 9000);
  const company = doc('personal', 'wiki/entities/한결케미칼.md', '---\naliases: [한결]\n---\n# 한결케미칼\n고객사', 1000);
  const topic = doc('personal', 'wiki/topics/한결 정리.md', '# 한결 정리\n본문', 1000);
  const log = doc('personal', 'log.md', '# 로그\n한결 한결', 1000);

  it('낱말을 모두 포함해야 맞음(AND)', () => {
    const d = docs(meeting, company);
    expect(searchDocs(d, q('한결 고객사')).hits.map((h) => h.path)).toEqual(['wiki/entities/한결케미칼.md']);
    expect(searchDocs(d, q('한결 없는말')).total).toBe(0);
  });

  it('제목 우선: 본문에 많이 나오는 문서보다 제목(별칭) 문서가 위', () => {
    const r = searchDocs(docs(meeting, company, topic, log), q('한결'));
    expect(r.hits[0].path).toBe('wiki/entities/한결케미칼.md'); // 별칭 일치 +1000
    expect(r.hits[1].path).toBe('wiki/topics/한결 정리.md'); // 제목 시작 +500
    expect(r.hits.map((h) => h.path).indexOf('log.md')).toBe(3); // meta −50
    expect(r.hits[0].matchedTitle).toBe(true);
    expect(r.hits.find((h) => h.path === 'notes/회의록.md')?.matchedTitle).toBe(false);
  });

  it('같은 점수는 mtime 최근 → 개인 먼저 → 경로 사전순', () => {
    const a = doc('personal', 'b/같은.md', '# 같은', 1000);
    const b = doc('team', 'a/같은.md', '# 같은', 1000);
    const c = doc('personal', 'a/같은.md', '# 같은', 1000);
    const d = doc('team', 'z/같은.md', '# 같은', 5000);
    expect(searchDocs(docs(a, b, c, d), q('같은')).hits.map((h) => `${h.source}:${h.path}`)).toEqual([
      'team:z/같은.md',
      'personal:a/같은.md',
      'personal:b/같은.md',
      'team:a/같은.md',
    ]);
  });

  it('Dataview 블록 안은 검색하지 않는다', () => {
    const d = docs(doc('personal', 'x.md', '# 문서\n```dataview\nTABLE 특이어 FROM "wiki"\n```\n'));
    expect(searchDocs(d, q('특이어')).total).toBe(0);
  });

  it('출처 필터·출처별 수·limit·total', () => {
    const list = docs(...Array.from({ length: 5 }, (_, i) => doc(i < 3 ? 'personal' : 'team', `d${i}.md`, `# 문서 ${i}\n공통어`)));
    const all = searchDocs(list, q('공통어', 'all', 2));
    expect(all.hits).toHaveLength(2);
    expect(all.total).toBe(5);
    expect(all.counts).toEqual({ personal: 3, team: 2 });
    const team = searchDocs(list, q('공통어', 'team'));
    expect(team.total).toBe(2);
    expect(team.counts).toEqual({ personal: 3, team: 2 });
    expect(team.hits.every((h) => h.source === 'team')).toBe(true);
    expect(searchDocs(list, { query: '공통어', source: 'all', limit: 500, offset: 0 }).hits).toHaveLength(5);
  });
});

describe('조각', () => {
  it('앞뒤 40자·…·줄바꿈 합침·강조 범위', () => {
    const body = `${'가'.repeat(60)}\n\n앞말 인벤토리   사용량 뒷말 ${'나'.repeat(60)}`;
    const { snippet, hits } = makeSnippet(body, ['인벤토리'], '인벤토리');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toContain('\n');
    expect(snippet).toContain('앞말 인벤토리 사용량 뒷말');
    expect(hits).toHaveLength(1);
    expect(snippet.slice(hits[0][0], hits[0][1])).toBe('인벤토리');
    const chars = Array.from(snippet);
    expect(chars.length).toBeLessThanOrEqual(40 + 4 + 40 + 2);
  });

  it('질의 전체가 없으면 첫 낱말 위치, 강조는 모든 낱말', () => {
    const { snippet, hits } = makeSnippet('배치는 새벽에 돈다. 집계가 빠진다', ['집계', '배치'], '집계 배치');
    expect(snippet).toBe('배치는 새벽에 돈다. 집계가 빠진다');
    expect(hits.map(([s, e]) => snippet.slice(s, e))).toEqual(['배치', '집계']);
  });

  it('제목만 맞으면 본문 첫 80자·강조 없음', () => {
    const r = searchDocs(docs(doc('personal', 'x.md', `---\ntitle: 제목어\n---\n${'본'.repeat(100)}`)), q('제목어'));
    expect(r.hits[0].hits).toEqual([]);
    expect(r.hits[0].snippet.endsWith('…')).toBe(true);
  });

  it('대소문자 무시 강조', () => {
    const { snippet, hits } = makeSnippet('CMS 집계와 cms', ['cms'], 'cms');
    expect(hits.map(([s, e]) => snippet.slice(s, e))).toEqual(['CMS', 'cms']);
  });
});

describe('최근 문서', () => {
  it('mtime 순·출처 필터', () => {
    const list = [doc('personal', 'a.md', '#a', 1), doc('team', 'b.md', '#b', 3), doc('personal', 'c.md', '#c', 2)];
    expect(recentDocs(list, 'all', 10).map((d) => d.path)).toEqual(['b.md', 'c.md', 'a.md']);
    expect(recentDocs(list, 'personal', 1).map((d) => d.path)).toEqual(['c.md']);
  });
});
