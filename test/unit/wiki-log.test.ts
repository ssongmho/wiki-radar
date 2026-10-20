// 3a단계 §5-5 log.md 항목·이유·최근 기록
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNameDict } from '../../src/main/wiki/wikiLinks';
import { excerptOf, logItemsByDoc, parseWikiLog, reasonsFor, recentLogItems, resolveLogItems } from '../../src/main/wiki/wikiLog';

const FIXTURE_LOG = path.resolve(__dirname, '..', 'fixtures', 'wiki', 'log.md');

const dict = buildNameDict([
  { path: 'wiki/entities/한결케미칼.md', aliases: ['한결'] },
  { path: 'wiki/entities/대륙물산.md' },
  { path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' },
]);

describe('머리·경계', () => {
  it('종류 있음/없음/틀린 날짜, 항목 본문은 다음 ## 앞까지', () => {
    const items = parseWikiLog(
      [
        '# 로그',
        '머리 앞 글',
        '## [2026-09-22] update | 한결 정리',
        '본문 1',
        '### 소제목은 본문',
        '## [2026-09-10] 종류 없는 제목',
        '본문 2',
        '## [2026-02-30] update | 틀린 날짜',
        '틀린 날짜 본문',
        '## 날짜 없는 머리',
        '## [2026-09-11] ingest |',
      ].join('\n'),
    );
    expect(items.map((i) => [i.date, i.kind ?? null, i.title])).toEqual([
      ['2026-09-22', 'update', '한결 정리'],
      ['2026-09-10', null, '종류 없는 제목'],
      ['2026-09-11', 'ingest', '(제목 없음)'],
    ]);
    expect(items[0].body).toBe('본문 1\n### 소제목은 본문');
    expect(items[1].body).toBe('본문 2');
  });

  it('테스트 사본 log.md: 항목 6개(틀린 날짜 머리는 항목 아님)', () => {
    const items = parseWikiLog(fs.readFileSync(FIXTURE_LOG, 'utf8'));
    expect(items).toHaveLength(6);
    expect(items.some((i) => i.date === '2026-02-30')).toBe(false);
    expect(items.filter((i) => !i.kind)).toHaveLength(1);
  });

  it('발췌는 200자·줄바꿈은 공백', () => {
    expect(excerptOf('가\n\n나')).toBe('가 나');
    expect(Array.from(excerptOf('가'.repeat(300)))).toHaveLength(201);
  });
});

describe('링크·이유·최근 기록', () => {
  const items = resolveLogItems(
    parseWikiLog(
      [
        '## [2026-09-22] update | [[한결케미칼]] 사용량 회신',
        '관련 [[CMS 인벤토리 사용량 집계]] [[없는 문서]]',
        '## [2026-09-20] update | 한결 두 번째',
        '[[한결]] 별칭',
        '## [2026-09-15] ingest | 한결 오래된 것',
        '[[한결케미칼]]',
        '## [2026-09-22] note | 같은 날 뒤 항목',
        '[[한결케미칼]]',
      ].join('\n'),
    ),
    dict,
  );

  it('머리·본문의 링크를 개인 사전으로 해석', () => {
    expect(items[0].docs).toEqual(['wiki/entities/한결케미칼.md', 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md']);
    expect(items[1].docs).toEqual(['wiki/entities/한결케미칼.md']);
  });

  it('이유: 읽음 날짜 이후 항목만·최근 순(같은 날은 파일 뒤쪽 먼저)·최대 2', () => {
    const by = logItemsByDoc(items);
    expect(reasonsFor(by, 'wiki/entities/한결케미칼.md', '2026-09-16').map((r) => r.title)).toEqual(['같은 날 뒤 항목', '[[한결케미칼]] 사용량 회신']);
    expect(reasonsFor(by, 'wiki/entities/한결케미칼.md', '2026-09-23')).toEqual([]);
    expect(reasonsFor(by, 'wiki/entities/대륙물산.md', '2026-01-01')).toEqual([]);
    const r = reasonsFor(by, 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md', '2026-09-01')[0];
    expect(r).toMatchObject({ date: '2026-09-22', kind: 'update' });
    expect(r.excerpt).toContain('관련');
  });

  it('최근 14일(오늘 포함)·최근 순', () => {
    expect(recentLogItems(items, '2026-09-23').map((i) => i.date)).toEqual(['2026-09-22', '2026-09-22', '2026-09-20', '2026-09-15']);
    expect(recentLogItems(items, '2026-10-04').map((i) => i.date)).toEqual(['2026-09-22', '2026-09-22']);
    expect(recentLogItems(items, 'x')).toEqual([]);
  });

  it('사전이 없으면 링크 없이(오류 아님)', () => {
    expect(resolveLogItems(parseWikiLog('## [2026-09-22] a | b\n[[한결]]'), undefined)[0].docs).toEqual([]);
    expect(parseWikiLog('')).toEqual([]);
  });
});
