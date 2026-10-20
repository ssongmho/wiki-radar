// 3a단계 B — 미리보기 렌더(renderWikiMarkdown, 명세 §7)와 화면 도우미(lib/wiki.ts) 시험. DOM 없이 문자열로 본다.
import { describe, expect, it } from 'vitest';
import type { WikiChangeItem, WikiDocsSummary, WikiPage } from '../../src/shared/types';
import { isExternalUrl, renderWikiMarkdown, type WikiRenderPage } from '../../src/renderer/lib/wikiMarkdown';
import {
  changeDayLabel,
  groupChanges,
  isQuickSearchKey,
  linesText,
  mergeRetained,
  navWikiInfo,
  normalizeWikiSummary,
  queryWords,
  sourceReason,
  splitHighlights,
  titleHits,
} from '../../src/renderer/lib/wiki';
import { defaultChangesTab } from '../../src/renderer/views/full/wiki/ChangesView';

function page(body: string, extra: Partial<WikiRenderPage> = {}): WikiRenderPage {
  return { source: 'personal', body, links: {}, images: {}, ...extra };
}

/** 출력의 태그(<…>)만 — 본문 글자로 이스케이프된 것은 빼고 본다. 속성 값(따옴표 안 — escapeHtml 을 거친 글자)은 비운다 */
function tags(html: string): string[] {
  return (html.match(/<[^>]*>/g) ?? []).map((t) => t.replace(/"[^"]*"/g, '""'));
}

const MALICIOUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe src="https://evil.example.invalid"></iframe>',
  '[누르기](javascript:alert(1))',
  '[데이터](data:text/html;base64,PHNjcmlwdD4=)',
  '[파일](file:///C:/Windows/win.ini)',
  '[vb](vbscript:msgbox(1))',
  '![x](javascript:alert(1))',
  '![원격](https://tracker.example.invalid/p.png)',
  '![로컬](../../../Windows/x.png)',
  '<https://example.invalid/auto>',
  '[링크](https://example.invalid/a"onmouseover="alert(1))',
  '[[a" onclick="alert(1)|b]]',
  '[[x]]{onclick=alert(1)}',
  '<svg onload=alert(1)>',
  '<style>body{display:none}</style>',
  '> [!warning" onclick="x] 제목',
  '> [!WARNING] 대문자',
  '- [ ] <b onmouseover=alert(1)>상자</b>',
  '| a | b |\n|:-:|--:|\n| [[x\\|y]] | <i>z</i> |',
  '```dataview\nTABLE x FROM "<script>"\n```',
  '```js" onclick="x\ncode\n```',
  '# 제목 <img src=x onerror=1>',
  'javascript:alert(1)',
  '[ref]: javascript:alert(1)\n\n[ref]',
  '![[그림.svg]]',
  '![[문서 포함]]',
].join('\n\n');

describe('renderWikiMarkdown — 안전(§7-1)', () => {
  const { html } = renderWikiMarkdown(
    page(MALICIOUS, {
      links: { 'a" onclick="alert(1)': { source: 'personal', path: 'a.md' }, x: { source: 'team', path: 'x.md', crossSource: true } },
      images: { 'https://tracker.example.invalid/p.png': { ok: false, reason: '원격 그림 — 불러오지 않음' }, '그림.svg': { ok: false, reason: 'SVG 그림 — Obsidian 에서 보기' } },
    }),
  );
  const t = tags(html).join('\n');

  it('태그에 script·iframe·style·svg·img 요소가 없다', () => {
    expect(t).not.toMatch(/<(script|iframe|style|svg|img|object|embed|input|form)\b/i);
  });
  it('태그에 on* 속성이 없다', () => {
    expect(t).not.toMatch(/\son[a-z]+\s*=/i);
  });
  it('href 는 모두 "#", src 속성은 없다', () => {
    const raw = (html.match(/<[^>]*>/g) ?? []).join('\n');
    expect(raw).not.toMatch(/href="http/i);
    expect(raw).not.toMatch(/src="http/i);
    expect(raw).not.toMatch(/(href|src)="\s*javascript:/i);
    const hrefs = [...raw.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toBe('#');
    expect(t).not.toMatch(/\ssrc=/i);
  });
  it('허용한 속성만 나온다(href·alt·title·class·id·data-*)', () => {
    for (const tag of tags(html)) {
      for (const m of tag.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)=/g)) {
        expect(['href', 'alt', 'title', 'class', 'id'].includes(m[1]) || m[1].startsWith('data-'), `${m[1]} in ${tag}`).toBe(true);
      }
    }
  });
  it('원문 HTML 은 글자로 이스케이프된다', () => {
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('외부 링크는 data-ext-link 자리표시자, 원격 그림은 안내 글자', () => {
    expect(html).toContain('data-ext-link="https://example.invalid/auto"');
    expect(html).toContain('원격 그림 — 불러오지 않음');
    expect(html).toContain('SVG 그림 — Obsidian 에서 보기');
  });
});

describe('renderWikiMarkdown — 규칙(§7-2)', () => {
  it('위키링크: 해석됨 · 미작성 · 다른 출처 · 별칭 · 절', () => {
    const { html } = renderWikiMarkdown(
      page('[[한결케미칼|한결]] [[없는 문서]] [[팀 문서]] [[문서#원인]]', {
        links: {
          한결케미칼: { source: 'personal', path: 'wiki/entities/한결케미칼.md' },
          '없는 문서': null,
          '팀 문서': { source: 'team', path: '팀 문서.md', crossSource: true },
          '문서#원인': { source: 'personal', path: '문서.md', heading: '원인' },
        },
      }),
    );
    expect(html).toContain('<a href="#" class="wl" data-wiki-link="한결케미칼"');
    expect(html).toContain('>한결</a>');
    expect(html).toContain('<span class="wl is-missing" title="없는 문서">없는 문서</span>');
    expect(html).toMatch(/class="wl is-cross" data-wiki-link="팀 문서"[^>]*>팀 문서<\/a><span class="wl-chip">팀<\/span>/);
    expect(html).toContain('data-wiki-link="문서#원인"');
    expect(html).toContain('문서 › 원인');
  });
  it('표 안 \\| 는 별칭 구분자 · 코드 안은 링크 아님', () => {
    const { html } = renderWikiMarkdown(
      page('| a | b |\n|---|---|\n| [[한결케미칼\\|한결]] | c |\n\n`[[코드]]`', { links: { 한결케미칼: { source: 'personal', path: 'h.md' } } }),
    );
    expect(html).toContain('data-wiki-link="한결케미칼"');
    expect(html).toContain('<code>[[코드]]</code>');
  });
  it('포함 ![[문서]] 는 펼치지 않고 링크 줄, ![[그림.png]] 는 자리표시자', () => {
    const { html, images } = renderWikiMarkdown(
      page('![[다른 문서]]\n\n![[그림.png|설명]]\n\n![대체](img/a%20b.png)', {
        links: { '다른 문서': { source: 'personal', path: '다른 문서.md' } },
        images: { '그림.png': { ok: true }, 'img/a b.png': { ok: true } },
      }),
    );
    expect(html).toContain('<span class="wl-embed">포함된 문서: <a href="#" class="wl" data-wiki-link="다른 문서"');
    expect(html).toContain('data-img-ref="그림.png" data-img-state="wait"');
    expect(html).toContain('data-img-ref="img/a%20b.png" data-img-state="wait" data-alt="대체"');
    expect(images).toBe(2);
  });
  it('dataview 블록은 안내 상자, 질의는 접어서 글자로', () => {
    const { html } = renderWikiMarkdown(page('```dataview\nLIST FROM "x"\n```\n\n```dataviewjs\ndv.list()\n```\n\n`= this.file.name`'));
    expect(html.match(/data-testid="wiki-dataview-note"/g)?.length).toBe(2);
    expect(html).toContain('<details><summary>질의 보기</summary><pre><code>LIST FROM &quot;x&quot;');
    expect(html).toContain('<code>= this.file.name</code>');
  });
  it('콜아웃: 종류 검사·색 · 제목 줄', () => {
    const a = renderWikiMarkdown(page('> [!warning] 주의\n> 본문')).html;
    expect(a).toContain('<blockquote class="callout callout-warning callout--amber">');
    expect(a).toContain('<p class="callout-title">주의</p>');
    expect(a).toContain('<p>본문</p>');
    expect(renderWikiMarkdown(page('> [!danger]\n> x')).html).toContain('callout-danger callout--coral');
    expect(renderWikiMarkdown(page('> [!info] 안내')).html).toContain('callout-info callout--cyan');
    expect(renderWikiMarkdown(page('> [!x" y=1] 제목')).html).toContain('class="callout callout-note callout--cyan"');
  });
  it('체크박스 줄은 누를 수 없는 상자', () => {
    const { html } = renderWikiMarkdown(page('- [ ] 할 것\n- [x] 한 것 [due:: 2026-09-30]'));
    expect(html).toContain('<li class="task-item"><span class="task-box" data-done="false"');
    expect(html).toContain('data-done="true"');
    expect(html).toContain('[due:: 2026-09-30]');
    expect(html).not.toMatch(/<input/);
  });
  it('제목 앵커 id 는 순번(원문 글자로 만들지 않는다)', () => {
    const r = renderWikiMarkdown(page('# 하나\n## 둘 [[링크|별칭]]\n### 셋\n#### 넷\n##### 다섯'));
    expect(r.headings.map((h) => [h.level, h.id, h.text])).toEqual([
      [1, 'h-1', '하나'],
      [2, 'h-2', '둘 별칭'],
      [3, 'h-3', '셋'],
      [4, 'h-4', '넷'],
    ]);
    expect(r.html).toContain('<h1 id="h-1">');
    expect(r.html).toContain('<h5>');
  });
  it('표 정렬은 style 대신 class', () => {
    const { html } = renderWikiMarkdown(page('| a | b |\n|:-:|--:|\n| 1 | 2 |'));
    expect(html).not.toMatch(/style=/);
    expect(html).toContain('<th class="ta-center">');
    expect(html).toContain('<td class="ta-right">');
  });
  it('http(s) 가 아닌 링크는 글자(주소는 title)', () => {
    const { html } = renderWikiMarkdown(page('[메일](mailto:a@example.invalid) [옵](obsidian://open?x) [상대](other.md)'));
    expect(html).not.toMatch(/data-ext-link/);
    expect(html).toContain('<span class="link-text" title="mailto:a@example.invalid">메일</span>');
  });
  it('isExternalUrl', () => {
    expect(isExternalUrl('https://example.invalid/guide')).toBe(true);
    expect(isExternalUrl('http://a.example')).toBe(true);
    expect(isExternalUrl('https://user:pw@example.invalid/')).toBe(false);
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('https://a b')).toBe(false);
    expect(isExternalUrl(`https://a.example/${'x'.repeat(2048)}`)).toBe(false);
  });
  it('fixture 문서 모양(WikiPage 전체)도 받는다', () => {
    const full: WikiPage = {
      source: 'team', path: 'a.md', title: 'a', kind: 'team', private: false, mtimeMs: 1, hash: 'h', fm: {}, body: '# a', truncated: false, links: {}, images: {},
    };
    expect(renderWikiMarkdown(full).html).toContain('<h1 id="h-1">a</h1>');
  });
});

describe('lib/wiki', () => {
  it('splitHighlights: 겹침·밖 범위 정리', () => {
    expect(splitHighlights('가나다라마', [[1, 3], [2, 4], [9, 12]])).toEqual([
      { text: '가', mark: false },
      { text: '나다라', mark: true },
      { text: '마', mark: false },
    ]);
    expect(splitHighlights('abc', [])).toEqual([{ text: 'abc', mark: false }]);
    expect(splitHighlights('', [])).toEqual([{ text: '', mark: false }]);
  });
  it('queryWords · titleHits', () => {
    expect(queryWords('  CMS  인벤토리 cms ')).toEqual(['cms', '인벤토리']);
    expect(titleHits('CMS 인벤토리 사용량 집계', '인벤토리 cms')).toEqual([[4, 8], [0, 3]]);
    expect(titleHits('İstanbul', 'i')).toEqual([]); // 소문자화로 길이가 바뀌면 강조하지 않는다
  });
  it('날짜 묶음: 오늘 · 어제 · M/D (받은 순서 유지)', () => {
    const at = (d: string): string => new Date(`${d}T10:00:00`).toISOString();
    expect(changeDayLabel(at('2026-09-23'), '2026-09-23')).toBe('오늘');
    expect(changeDayLabel(at('2026-09-22'), '2026-09-23')).toBe('어제');
    expect(changeDayLabel(at('2026-09-01'), '2026-09-23')).toBe('9/1');
    expect(changeDayLabel(at('2026-12-31'), '2027-01-01')).toBe('어제');
    const g = groupChanges([{ detectedAt: at('2026-09-23') }, { detectedAt: at('2026-09-23') }, { detectedAt: at('2026-09-20') }], '2026-09-23');
    expect(g.map((x) => [x.label, x.items.length])).toEqual([
      ['오늘', 2],
      ['9/20', 1],
    ]);
  });
  it('linesText', () => {
    expect(linesText({ added: 3, removed: 1, sample: [] })).toBe('+3 −1');
    expect(linesText({ added: 2, removed: 0, sample: [] }, ' 줄')).toBe('+2 −0 줄');
    expect(linesText({ added: 0, removed: 0, sample: [] })).toBe('내용 변화 없음(줄 순서만)');
    expect(linesText(null)).toBe('줄 수 모름');
    expect(linesText(undefined)).toBe('');
  });
  const info = (state: WikiDocsSummary['sources']['personal']['state'], docs = 3) => ({ state, docs });
  const sum = (p: ReturnType<typeof info>, t: ReturnType<typeof info>, cp = 0, ct = 0): WikiDocsSummary => ({
    sources: { personal: p, team: t },
    changes: { personal: cp, team: ct, total: cp + ct },
    revision: 1,
  });
  it('navWikiInfo · sourceReason · 기본 탭', () => {
    expect(navWikiInfo(sum(info('ready'), info('off'), 2, 0))).toEqual({ count: 2, personal: 2, team: 0 });
    expect(navWikiInfo(sum(info('noWiki', 0), info('off', 0))).unavailable).toBe('개인 위키도 팀 위키 동기화도 없습니다');
    expect(navWikiInfo(sum(info('indexing', 0), info('off', 0))).note).toBe('읽는 중');
    expect(navWikiInfo(null).note).toBe('읽는 중');
    expect(sourceReason(info('off'), 'team')).toBe('팀 위키 동기화가 꺼져 있습니다');
    expect(sourceReason({ state: 'problem', docs: 0, problem: '겹칩니다' }, 'team')).toBe('겹칩니다');
    expect(sourceReason(info('ready'), 'team')).toBeNull();
    expect(defaultChangesTab(sum(info('ready'), info('ready'), 0, 1))).toBe('team');
    expect(defaultChangesTab(sum(info('ready'), info('ready'), 1, 1))).toBe('personal');
    expect(defaultChangesTab(sum(info('noWiki'), info('ready')))).toBe('team');
    expect(defaultChangesTab(null)).toBe('personal');
  });
  it('normalizeWikiSummary: 깨진 값은 null, total 은 다시 센다', () => {
    expect(normalizeWikiSummary(null)).toBeNull();
    expect(normalizeWikiSummary({ sources: {}, changes: {} })?.sources.personal.state).toBe('error');
    const s = normalizeWikiSummary({ sources: { personal: { state: 'ready', docs: 5 }, team: { state: 'off', docs: 0 } }, changes: { personal: 2, team: 1, total: 99 }, revision: 4 });
    expect(s?.changes).toEqual({ personal: 2, team: 1, total: 3 });
  });
  it('mergeRetained: 읽음 처리한 줄은 예전 자리에 남는다', () => {
    const it = (path: string): WikiChangeItem => ({ source: 'personal', path, title: path, kind: 'other', private: false, mtimeMs: 0, change: 'changed', detectedAt: '' });
    const prev = [it('a'), it('b'), it('c')];
    const fresh = [it('a'), it('c')];
    expect(mergeRetained(fresh, prev, new Set(['personal:b'])).map((x) => x.path)).toEqual(['a', 'b', 'c']);
    expect(mergeRetained(fresh, prev, new Set()).map((x) => x.path)).toEqual(['a', 'c']);
    expect(mergeRetained([], prev, new Set(['personal:a'])).map((x) => x.path)).toEqual(['a']);
  });
  it('isQuickSearchKey', () => {
    const base = { key: 'k', ctrlKey: true, altKey: false, shiftKey: false };
    expect(isQuickSearchKey(base)).toBe(true);
    expect(isQuickSearchKey({ ...base, key: 'K' })).toBe(true);
    expect(isQuickSearchKey({ ...base, key: 'ㅏ', code: 'KeyK' })).toBe(true);
    expect(isQuickSearchKey({ ...base, isComposing: true })).toBe(false);
    expect(isQuickSearchKey({ ...base, altKey: true })).toBe(false);
    expect(isQuickSearchKey({ ...base, ctrlKey: false })).toBe(false);
  });
});
