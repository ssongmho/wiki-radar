// 3a단계 §2-3 위키링크 뽑기·이름 사전·해석
import { describe, expect, it } from 'vitest';
import { buildNameDict, extractWikiLinks, maskCode, maskDataview, outgoingLinks, resolveLink } from '../../src/main/wiki/wikiLinks';
import { parseWikiLinkInner, wikiLinkKey } from '../../src/shared/wikiDocs';

describe('뽑기', () => {
  it('별칭·절·블록·포함·.md 꼬리', () => {
    const links = extractWikiLinks('[[가]] [[나|별칭]] [[다#절]] [[라#^blk1]] ![[마]] [[바.md]] [[ 사 ]]');
    expect(links.map((l) => [l.target, l.alias ?? null, l.heading ?? null, l.block ?? null, l.embed])).toEqual([
      ['가', null, null, null, false],
      ['나', '별칭', null, null, false],
      ['다', null, '절', null, false],
      ['라', null, null, 'blk1', false],
      ['마', null, null, null, true],
      ['바', null, null, null, false],
      ['사', null, null, null, false],
    ]);
    expect(links[2].key).toBe('다#절');
  });

  it('표 안의 \\| 는 별칭 구분자', () => {
    const [l] = extractWikiLinks('| [[한결케미칼\\|한결]] | 증상 |');
    expect(l.target).toBe('한결케미칼');
    expect(l.alias).toBe('한결');
    expect(l.key).toBe('한결케미칼');
    expect(wikiLinkKey('한결케미칼\\|한결')).toBe('한결케미칼');
  });

  it('코드 블록·인라인 코드 안은 뽑지 않는다', () => {
    const body = ['[[밖]]', '```', '[[코드]]', '```', '~~~js', '[[물결]]', '~~~', '`[[인라인]]` 과 ``[[두 개]]`` 뒤 [[뒤]]'].join('\n');
    expect(extractWikiLinks(body).map((l) => l.target)).toEqual(['밖', '뒤']);
  });

  it('maskCode 는 길이·줄을 지킨다, maskDataview 는 dataview 블록만', () => {
    const body = 'a `b` c\n```dataview\nLIST\n```\n```js\nx\n```';
    expect(maskCode(body).length).toBe(body.length);
    expect(maskCode(body).split('\n')).toHaveLength(body.split('\n').length);
    const dv = maskDataview(body);
    expect(dv).not.toContain('LIST');
    expect(dv).toContain('x');
    expect(dv).toContain('`b`');
  });

  it('나가는 링크: 중복 없이·같은 문서 링크 뺌·500개까지', () => {
    expect(outgoingLinks('[[가]] [[가|다른]] [[#절]] [[나#x]]')).toEqual(['가', '나']);
    const many = Array.from({ length: 600 }, (_, i) => `[[문서${i}]]`).join(' ');
    expect(outgoingLinks(many)).toHaveLength(500);
  });

  it('parseWikiLinkInner: NFC', () => {
    const nfd = '한결'.normalize('NFD');
    expect(parseWikiLinkInner(nfd).target).toBe('한결'.normalize('NFC'));
  });
});

describe('해석', () => {
  const personal = buildNameDict([
    { path: 'wiki/entities/한결케미칼.md', aliases: ['한결'] },
    { path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' },
    { path: '_private/mgmt/메모.md' },
    { path: 'archive/메모.md' },
    { path: 'wiki/topics/메모.md' },
    { path: 'a/b/같은이름.md' },
    { path: 'a/같은이름.md' },
    { path: 'z/같은이름.md' },
    { path: 'notes/dir/짧은.md' },
  ]);
  const team = buildNameDict([
    { path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' },
    { path: '운영/서버 점검.md' },
  ]);
  const dicts = { personal, team };
  const from = { source: 'personal' as const, path: 'wiki/topics/dev/배치.md' };

  it('파일 이름·별칭·대소문자', () => {
    expect(resolveLink(dicts, from, '한결케미칼')).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md' });
    expect(resolveLink(dicts, from, '한결')).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md' });
    expect(resolveLink(dicts, from, 'cms 인벤토리 사용량 집계#원인')).toEqual({
      source: 'personal',
      path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md',
      heading: '원인',
    });
  });

  it('경로 꼴: 볼트 기준 → 문서 폴더 기준', () => {
    expect(resolveLink(dicts, from, 'notes/dir/짧은')?.path).toBe('notes/dir/짧은.md');
    expect(resolveLink(dicts, { source: 'personal', path: 'notes/x.md' }, 'dir/짧은')?.path).toBe('notes/dir/짧은.md');
  });

  it('같은 이름 여럿: wiki/ 우선 → 같은 폴더 → 짧은 경로 → 사전순', () => {
    expect(resolveLink(dicts, { source: 'personal', path: '_private/mgmt/x.md' }, '메모')?.path).toBe('wiki/topics/메모.md');
    expect(resolveLink(dicts, { source: 'personal', path: 'z/x.md' }, '같은이름')?.path).toBe('z/같은이름.md');
    expect(resolveLink(dicts, { source: 'personal', path: 'q/x.md' }, '같은이름')?.path).toBe('a/같은이름.md');
  });

  it('같은 출처 우선, 없으면 다른 출처(crossSource), 미작성은 null', () => {
    const fromTeam = { source: 'team' as const, path: '운영/배포 절차.md' };
    expect(resolveLink(dicts, fromTeam, 'CMS 인벤토리 사용량 집계')).toEqual({ source: 'team', path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' });
    expect(resolveLink(dicts, fromTeam, '한결케미칼')).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md', crossSource: true });
    expect(resolveLink(dicts, from, '서버 점검')).toEqual({ source: 'team', path: '운영/서버 점검.md', crossSource: true });
    expect(resolveLink(dicts, from, '없는 문서')).toBeNull();
    expect(resolveLink({ personal }, from, '서버 점검')).toBeNull();
  });

  it('경로 꼴이 볼트·문서 폴더 기준으로 없으면 그 폴더로 끝나는 같은 이름 문서(검토 지적)', () => {
    const d = buildNameDict([{ path: 'wiki/topics/dev/설계.md' }, { path: 'wiki/entities/설계.md' }]);
    expect(resolveLink({ personal: d }, { source: 'personal', path: 'log.md' }, 'dev/설계')?.path).toBe('wiki/topics/dev/설계.md');
    expect(resolveLink({ personal: d }, { source: 'personal', path: 'x/y.md' }, 'topics/dev/설계')?.path).toBe('wiki/topics/dev/설계.md');
    // 폴더가 맞는 것이 없으면 전처럼 파일 이름으로
    expect(resolveLink({ personal: d }, { source: 'personal', path: 'log.md' }, 'other/설계')?.path).toBe('wiki/entities/설계.md');
  });

  it('[[#절]] 은 같은 문서', () => {
    expect(resolveLink(dicts, from, '#원인')).toEqual({ source: 'personal', path: from.path, heading: '원인' });
  });
});
