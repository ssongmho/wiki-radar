// 3a단계 §1-2·§2 문서 색인: 제외 규칙·항목 파서·증분 색인·캐시
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROBLEM_BIG,
  PROBLEM_FM,
  WIKI_BODY_MAX_BYTES,
  buildDocIndex,
  loadWikiIndexCache,
  nodeDocFs,
  parseDocText,
  wikiIndexCacheOf,
  type DocFs,
} from '../../src/main/wiki/docIndex';
import { cutUnits } from '../../src/main/wiki/docIndex';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'wiki');
const TEAM_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'team-wiki');

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-docidx-'));
  temps.push(d);
  return d;
}

function write(root: string, rel: string, text: string | Buffer): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** 읽기 횟수를 세는 fs */
function countingFs(fail?: (abs: string) => NodeJS.ErrnoException | null): DocFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readdir: nodeDocFs.readdir,
    stat: nodeDocFs.stat,
    realpath: nodeDocFs.realpath,
    async readFile(abs) {
      reads.push(abs);
      const err = fail?.(abs);
      if (err) throw err;
      return nodeDocFs.readFile(abs);
    },
  };
}

describe('제외 규칙', () => {
  it('개인: raw·_mail-ingest·backup·점 폴더·templates 빠짐, _private 들어감', async () => {
    const root = tmp();
    fs.cpSync(FIXTURE, root, { recursive: true });
    write(root, '_mail-ingest/x.md', '# 수집기');
    write(root, 'backup/old.md', '# 옛것');
    write(root, '_templates/틀.md', '# 틀');
    const { entries, images } = await buildDocIndex({ source: 'personal', root });
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith('raw/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('_mail-ingest/') || p.startsWith('backup/') || p.startsWith('_todo-sync/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.claude/') || p.startsWith('templates/') || p.startsWith('_templates/'))).toBe(false);
    expect(paths).toContain('_private/mgmt/연간 목표.md');
    expect(paths).toContain('log.md');
    expect(paths).toHaveLength(13);
    const priv = entries.find((e) => e.path === '_private/mgmt/연간 목표.md');
    expect(priv?.private).toBe(true);
    expect(priv?.kind).toBe('private');
    expect(entries.find((e) => e.path === 'log.md')?.kind).toBe('meta');
    expect(entries.find((e) => e.path === 'wiki/entities/대륙물산.md')?.kind).toBe('entity');
    expect(entries.find((e) => e.path === 'wiki/topics/dev/배치 마감 경계 조건.md')?.kind).toBe('topic');
    // 그림 사전: 이름 → 경로(raw/ 아래 그림은 넣지 않는다)
    expect(images.byName.get('경계조건.png')?.map((f) => f.path)).toEqual(['wiki/topics/dev/_img/경계조건.png']);
    expect([...images.byPath.keys()].some((k) => k.startsWith('raw/'))).toBe(false);
  });

  it('팀: .휴지통·충돌 사본·템플릿 폴더 빠짐', async () => {
    const root = tmp();
    fs.cpSync(TEAM_FIXTURE, root, { recursive: true });
    write(root, 'a.svg', '<svg/>');
    const { entries, images } = await buildDocIndex({ source: 'team', root });
    expect(entries.map((e) => e.path)).toEqual([
      'README.md',
      'wiki/topics/dev/CMS 인벤토리 사용량 집계.md',
      '운영/배포 절차.md',
      '운영/서버 점검.md',
      '회의록/2026-09-22 주간회의.md',
    ]);
    expect(entries.every((e) => e.kind === 'team' && !e.private)).toBe(true);
    expect(images.byName.get('배포도.png')).toHaveLength(1);
    expect(images.byName.has('a.svg')).toBe(false);
  });
});

describe('항목 파서', () => {
  it('제목: frontmatter title → H1(코드 블록 밖, 앞 40줄) → 파일 이름', () => {
    expect(parseDocText('personal', 'a/x.md', '---\ntitle: 제목값\n---\n# H1').title).toBe('제목값');
    expect(parseDocText('personal', 'a/x.md', '```\n# 코드 안\n```\n# 진짜 제목 #').title).toBe('진짜 제목');
    expect(parseDocText('personal', 'a/x.md', `${'줄\n'.repeat(45)}# 늦은 제목`).title).toBe('x');
    expect(parseDocText('personal', 'a/파일.md', '본문만').title).toBe('파일');
  });

  it('frontmatter 일부: tags 문자열·#·aliases·공개범위 → 없으면 access', () => {
    const e = parseDocText('personal', 'x.md', '---\ntype: entity\ndomain: [chem, dev]\ntags: "#하나"\naliases: [대륙, 대륙상사]\naccess: internal\n공개범위: 팀\nupdated: 2026-09-21\n---\n본문');
    expect(e.fm).toEqual({ type: 'entity', domain: 'chem, dev', tags: ['하나'], aliases: ['대륙', '대륙상사'], scope: '팀', updated: '2026-09-21' });
    expect(parseDocText('personal', 'x.md', '---\naccess: internal\n---\n').fm.scope).toBe('internal');
    const long = parseDocText('personal', 'x.md', `---\ntype: ${'가'.repeat(300)}\ntags: [${Array.from({ length: 30 }, (_, i) => `t${i}`).join(', ')}]\n---\n`);
    expect(long.fm.type).toHaveLength(200);
    expect(long.fm.tags).toHaveLength(20);
  });

  it('깨진 frontmatter → problem + 본문은 색인', () => {
    const e = parseDocText('personal', 'x.md', '---\na: [b\n---\n# 제목\n본문 글자');
    expect(e.problem).toBe(PROBLEM_FM);
    expect(e.fm).toEqual({});
    expect(e.body).toContain('본문 글자');
    expect(e.title).toBe('제목');
  });

  it('해시는 CRLF/LF·BOM 에 무관, 링크를 뽑는다', () => {
    const a = parseDocText('personal', 'x.md', '# 가\n[[나]]\n');
    const b = parseDocText('personal', 'x.md', '﻿# 가\r\n[[나]]\r\n');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(a.links).toEqual(['나']);
  });

  it('2MB 넘는 파일은 제목·경로만', async () => {
    const root = tmp();
    write(root, 'big.md', `---\ntitle: 큰 문서\n---\n${'가나다라 '.repeat(Math.ceil(WIKI_BODY_MAX_BYTES / 10) + 10)}`);
    const { entries } = await buildDocIndex({ source: 'personal', root });
    expect(entries[0].title).toBe('큰 문서');
    expect(entries[0].body).toBe('');
    expect(entries[0].problem).toBe(PROBLEM_BIG);
    expect(entries[0].hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('증분 색인', () => {
  it('바뀌지 않은 파일은 다시 읽지 않는다 · mtime 만 바뀐 파일·새 파일은 읽는다 · 지운 파일은 빠진다', async () => {
    const root = tmp();
    write(root, 'a.md', '# A');
    write(root, 'b.md', '# B');
    write(root, 'c.md', '# C');
    const first = countingFs();
    const r1 = await buildDocIndex({ source: 'personal', root, fs: first });
    expect(first.reads).toHaveLength(3);
    expect(r1.stats.read).toBe(3);

    const again = countingFs();
    const r2 = await buildDocIndex({ source: 'personal', root, fs: again, cache: r1.entries });
    expect(again.reads).toHaveLength(0);
    expect(r2.stats).toMatchObject({ files: 3, read: 0, reused: 3, removed: 0 });

    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'a.md'), t, t);
    write(root, 'd.md', '# D');
    fs.rmSync(path.join(root, 'c.md'));
    const third = countingFs();
    const r3 = await buildDocIndex({ source: 'personal', root, fs: third, cache: r2.entries });
    expect(third.reads.map((p) => path.basename(p)).sort()).toEqual(['a.md', 'd.md']);
    expect(r3.stats).toMatchObject({ files: 3, read: 2, reused: 1, removed: 1 });
    expect(r3.entries.map((e) => e.path)).toEqual(['a.md', 'b.md', 'd.md']);
  });

  it('잠깐 못 읽은 파일은 이전 항목을 그대로 둔다(다음에 다시 읽는다)', async () => {
    const root = tmp();
    write(root, 'a.md', '# 원래');
    const r1 = await buildDocIndex({ source: 'personal', root });
    const t = new Date(Date.now() + 5000);
    write(root, 'a.md', '# 바뀜');
    fs.utimesSync(path.join(root, 'a.md'), t, t);
    const busy = countingFs(() => Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const r2 = await buildDocIndex({ source: 'personal', root, fs: busy, cache: r1.entries, retryDelays: [1, 1] });
    expect(busy.reads).toHaveLength(3); // 처음 + 다시 두 번
    expect(r2.entries[0].title).toBe('원래');
    expect(r2.entries[0].hash).toBe(r1.entries[0].hash);
    expect(r2.entries[0].problem).toMatch(/파일을 읽지 못함/);
    const r3 = await buildDocIndex({ source: 'personal', root, cache: r2.entries });
    expect(r3.entries[0].title).toBe('바뀜');
    expect(r3.entries[0].problem).toBeUndefined();
  });

  it('처음부터 못 읽은 파일: 제목 = 파일 이름, 해시 없음', async () => {
    const root = tmp();
    write(root, '잠김.md', '# 잠김');
    const r = await buildDocIndex({ source: 'personal', root, fs: countingFs(() => Object.assign(new Error('x'), { code: 'EACCES' })) });
    expect(r.entries[0]).toMatchObject({ title: '잠김', hash: '', body: '' });
  });
});

describe('캐시 파일', () => {
  it('root·버전이 다르면 버리고, 64MB 넘으면 본문 없이', async () => {
    const root = tmp();
    write(root, 'a.md', '# A\n본문');
    const r = await buildDocIndex({ source: 'personal', root });
    const file = path.join(tmp(), 'wiki-index.json');
    const { file: content } = wikiIndexCacheOf({ personal: { root, builtAt: 'x', entries: r.entries } });
    fs.writeFileSync(file, JSON.stringify(content));
    expect(loadWikiIndexCache(file, { personal: root }).personal?.entries).toHaveLength(1);
    expect(loadWikiIndexCache(file, { personal: path.join(root, 'other') }).personal).toBeUndefined();
    expect(loadWikiIndexCache(file, { team: root }).team).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ ...content, version: 2 }));
    expect(loadWikiIndexCache(file, { personal: root })).toEqual({});
    fs.writeFileSync(file, '{깨짐');
    expect(loadWikiIndexCache(file, { personal: root })).toEqual({});

    const small = wikiIndexCacheOf({ personal: { root, builtAt: 'x', entries: r.entries } }, 10);
    expect(small.withoutBody).toBe(true);
    expect(small.file.sources.personal?.entries[0].body).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify(small.file));
    const loaded = loadWikiIndexCache(file, { personal: root }).personal?.entries ?? [];
    // 본문 없는 캐시 항목은 다시 읽는다
    const counting = countingFs();
    const r2 = await buildDocIndex({ source: 'personal', root, cache: loaded, fs: counting });
    expect(counting.reads).toHaveLength(1);
    expect(r2.entries[0].body).toContain('본문');
  });
});

describe('자르기(검토 지적)', () => {
  it('서로게이트 쌍을 가르지 않는다', () => {
    const s = `${'가'.repeat(199)}𝔸끝`;
    expect(cutUnits(s, 200)).toBe('가'.repeat(199));
    expect(cutUnits(s, 201)).toBe(`${'가'.repeat(199)}𝔸`);
    expect(cutUnits('짧음', 200)).toBe('짧음');
  });
});
