// 위키 검색·변경 성능 한도(docs/stage3a-contract.md §12) — 임시 폴더 3,000문서·약 30MB(가상 글). 실제 위키는 부르지 않는다.
// npm run test 에 넣지 않고 npm run test:perf 로 따로 돈다. 한도는 명세 값 그대로이고, CI·WIKI_RADAR_PERF_SLACK 일 때만 3배까지.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocIndex, nodeDocFs, type DocFs, type WikiDocEntry } from '../../src/main/wiki/docIndex';
import { prepareSearchDoc, searchDocs, type SearchDoc } from '../../src/main/wiki/docSearch';
import { listChanges, makeBaseline, observeIndex, type ChangeBase } from '../../src/main/wiki/docChanges';

const SLACK = Math.min(3, Math.max(1, Number(process.env.WIKI_RADAR_PERF_SLACK) || (process.env.CI ? 3 : 1)));
const DOCS = 3000;
/** 문서 하나 약 10KB(한글 3바이트) → 합쳐 약 30MB */
const WORDS = ['한결케미칼', '인벤토리', '사용량', '집계', '배치', '마감', '고객사', '유지보수', '점검', '회의', '요청', '회신', '서버', '배포'];

let root = '';

function bodyOf(i: number): string {
  const lines: string[] = [`# 가상 문서 ${i} ${WORDS[i % WORDS.length]}`, ''];
  let bytes = 0;
  let k = i;
  while (bytes < 10_000) {
    const line = `- ${WORDS[k % WORDS.length]} ${WORDS[(k * 7) % WORDS.length]} 관련 가상 기록 ${k} 번째 줄입니다. [[가상 문서 ${(k * 13) % DOCS}]]`;
    lines.push(line);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    k++;
  }
  return lines.join('\n');
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-wiki-perf-'));
  for (let i = 0; i < DOCS; i++) {
    const dir = path.join(root, 'wiki', `폴더${i % 40}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `가상 문서 ${i}.md`), `---\ntype: topic\ntags: [가상]\n---\n${bodyOf(i)}\n`, 'utf8');
  }
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe(`성능(§12) — 임시 폴더 ${DOCS.toLocaleString('ko-KR')}문서 (한도 ×${SLACK})`, () => {
  let entries: WikiDocEntry[] = [];
  let docs: SearchDoc[] = [];

  it('첫 색인 10초 · 증분(바뀐 것 없음) 500ms 안, 읽기 0번', async () => {
    const t0 = performance.now();
    const first = await buildDocIndex({ source: 'personal', root });
    const firstMs = performance.now() - t0;
    entries = first.entries;
    expect(entries).toHaveLength(DOCS);
    const totalBytes = entries.reduce((n, e) => n + e.size, 0);
    expect(totalBytes).toBeGreaterThan(25 * 1024 * 1024);
    expect(firstMs).toBeLessThan(10_000 * SLACK);

    let reads = 0;
    const counting: DocFs = { ...nodeDocFs, readFile: (abs) => (reads++, nodeDocFs.readFile(abs)) };
    const t1 = performance.now();
    const again = await buildDocIndex({ source: 'personal', root, cache: entries, fs: counting });
    const incMs = performance.now() - t1;
    expect(reads).toBe(0);
    expect(again.stats.reused).toBe(DOCS);
    expect(incMs).toBeLessThan(500 * SLACK);
    console.log(`[wiki-perf] 첫 색인 ${firstMs.toFixed(0)}ms · 증분 ${incMs.toFixed(0)}ms · ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
  }, 60_000);

  it('검색 한 번 80ms 안(1글자·2낱말)', () => {
    const tp = performance.now();
    docs = entries.map(prepareSearchDoc);
    const prepMs = performance.now() - tp;
    for (const query of ['한', '인벤토리 사용량', '없는말', '가상 문서 2999']) {
      // 첫 호출은 JIT 준비 — 두 번째를 잰다
      searchDocs(docs, { query, source: 'all', limit: 50, offset: 0 });
      const t0 = performance.now();
      const r = searchDocs(docs, { query, source: 'all', limit: 50, offset: 0 });
      const ms = performance.now() - t0;
      console.log(`[wiki-perf] 검색 "${query}" ${r.total}건 ${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(80 * SLACK);
    }
    console.log(`[wiki-perf] 검색 준비(정규화) ${prepMs.toFixed(0)}ms`);
  });

  it('변경 계산 50ms 안', () => {
    const seen = makeBaseline(root, entries.values(), '2026-09-23T01:00:00.000Z');
    const next = new Map(entries.map((e) => [e.path, e]));
    // 300개를 바뀐 것으로
    for (const e of entries.slice(0, 300)) next.set(e.path, { ...e, hash: 'f'.repeat(40), body: `${e.body}\n더함` });
    const prev = new Map(entries.map((e) => [e.path, e]));
    const base: Record<string, ChangeBase> = {};
    const t0 = performance.now();
    observeIndex({ source: 'personal', prev, next, seen, base, nowIso: '2026-09-23T02:00:00.000Z' });
    const items = listChanges({ source: 'personal', entries: next, seen, base, localDate: (iso) => iso.slice(0, 10) });
    const ms = performance.now() - t0;
    expect(items).toHaveLength(300);
    console.log(`[wiki-perf] 변경 계산 ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(50 * SLACK);
  });

  it('메모리: 색인 + 정규화 본문 120MB 이하', () => {
    // 문자열 크기로 어림한다(V8 은 한글 글은 글자당 2바이트) — 본문·정규화 본문·제목·링크
    let bytes = 0;
    for (const d of docs) {
      const e = d.entry;
      bytes += (e.body.length + d.bodyN.length + d.metaN.length + e.title.length) * 2;
      for (const l of e.links) bytes += l.length * 2 + 16;
      bytes += 400; // 항목 객체·Map 칸
    }
    const mb = bytes / 1024 / 1024;
    console.log(`[wiki-perf] 색인+정규화 어림 ${mb.toFixed(0)}MB (문서 ${docs.length})`);
    expect(mb).toBeLessThan(120);
  });
});

// 검토 지적: 악의적이거나 망가진 본문이 메인 프로세스(그림 참조)·미리보기(위키링크)를 제곱 시간으로 멈추지 않는다
describe('병적인 본문 — 선형 시간', () => {
  it('그림 참조: `![` 15만 번(닫는 ] 없음)·`![](x (` 반복이 각각 100ms 안', async () => {
    const { imageRefsOf } = await import('../../src/main/wiki/docInput');
    for (const body of ['!['.repeat(150_000), '![](x ('.repeat(40_000), '![a](<'.repeat(50_000), `${'!['.repeat(100_000)}]`]) {
      const t0 = performance.now();
      imageRefsOf(body);
      const ms = performance.now() - t0;
      console.log(`[wiki-perf] 그림 참조 ${body.length}자 ${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(100 * SLACK);
    }
  });

  it('미리보기: 닫히지 않은 `[[ ` 10만 번이 1초 안(고치기 전 2.5초 — markdown-it 의 [ 처리만으로도 0.2초쯤)', async () => {
    const { renderWikiMarkdown } = await import('../../src/renderer/lib/wikiMarkdown');
    const body = '[[ '.repeat(100_000);
    const t0 = performance.now();
    renderWikiMarkdown({ source: 'personal', body, links: {}, images: {} });
    const ms = performance.now() - t0;
    console.log(`[wiki-perf] 위키링크 ${body.length}자 ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000 * SLACK);
  });
});
