// 3a단계 A(main 색인·검색·변경·IPC) 연결 시험 — 화면 없이 window.radar 로 위키 문서 채널을 부른다(docs/stage3a-contract.md §11).
// 개인 위키는 테스트 사본의 임시 복사본, 팀 위키는 임시 NAS·사본 폴더(test/fixtures/team-wiki 복사본)만 쓴다.
// 위키·팀 사본은 시나리오 전후로 해시가 같아야 한다(시험이 스스로 고친 파일 제외). 외부 링크·Obsidian 열기는 시험 모드라
// <데이터 폴더>/open-log.jsonl 에만 적힌다. 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { WikiDocsSummary } from '../../src/shared/types';
import { FIXTURE_TEAM_WIKI, FIXTURE_WIKI, closeApp, createWikiSandbox, launchApp, treeDigest, watchLogs, windowByMode, type AppLogs, type WikiSandbox } from './app';

const NOW = '2026-09-23T10:00';
const BOUNDARY = 'wiki/topics/dev/배치 마감 경계 조건.md';

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
let sandbox: WikiSandbox | null = null;
const temps: string[] = [];
let fixtureBefore: Record<string, string> | undefined;
let teamFixtureBefore: Record<string, string> | undefined;

test.beforeAll(() => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
  teamFixtureBefore = treeDigest(FIXTURE_TEAM_WIKI);
});
test.afterAll(() => {
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
  if (teamFixtureBefore) expect(treeDigest(FIXTURE_TEAM_WIKI), '원본 test/fixtures/team-wiki 가 바뀌었다').toEqual(teamFixtureBefore);
});
test.afterEach(async ({}, testInfo) => {
  if (app && logs && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (app) await closeApp(app);
  app = null;
  logs = null;
  sandbox?.dispose();
  sandbox = null;
  while (temps.length) {
    try {
      fs.rmSync(temps.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 임시 폴더라 남아도 괜찮다
    }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface Team {
  remote: string;
  local: string;
}

async function start(opts: { team?: boolean; keep?: { sandbox: WikiSandbox; team?: Team } } = {}): Promise<{ page: Page; team?: Team }> {
  sandbox = opts.keep?.sandbox ?? createWikiSandbox('wiki-radar-e2e-3a-');
  let team = opts.keep?.team;
  if (opts.team && !team) {
    const t = tempDir('wiki-radar-e2e-3a-team-');
    team = { remote: path.join(t, 'nas'), local: path.join(t, 'local') };
  }
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW, ...(team ? { team } : {}) });
  logs = watchLogs(app);
  const page = await windowByMode(app, 'sidebar');
  await expect
    .poll(async () => (await page.evaluate(() => window.radar.getWikiDocs!())).sources.personal.state, { timeout: 20_000 })
    .toBe('ready');
  if (team) {
    // 첫 동기화(켜고 3초 뒤) 뒤 팀 출처가 색인되고 기준선이 잡힌다
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.radar.getWikiDocs!());
        const c = await page.evaluate(() => window.radar.getWikiChanges!({ source: 'team', offset: 0, limit: 10 }));
        return `${s.sources.team.state}/${c.state}`;
      }, { timeout: 30_000 })
      .toBe('ready/ready');
  }
  return { page, ...(team ? { team } : {}) };
}

const summaryOf = (page: Page): Promise<WikiDocsSummary> => page.evaluate(() => window.radar.getWikiDocs!());

function readOpenLog(dataDir: string): { kind: string; target: string }[] {
  const p = path.join(dataDir, 'open-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; target: string });
}

function appendLine(abs: string, text: string): void {
  fs.appendFileSync(abs, text, 'utf8');
}

test('검색·문서 읽기·그림·링크·외부 열기 기록·인자 검사·읽기 전용', async () => {
  test.setTimeout(120_000);
  const { page, team } = await start({ team: true });
  const wikiBefore = treeDigest(sandbox!.wiki);
  const teamBefore = treeDigest(team!.local);

  const sum = await summaryOf(page);
  expect(sum.sources.personal).toMatchObject({ state: 'ready', docs: 13 });
  expect(sum.sources.team).toMatchObject({ state: 'ready', docs: 5 });
  expect(sum.changes).toEqual({ personal: 0, team: 0, total: 0 });

  // (b) 검색
  const inv = await page.evaluate(() => window.radar.searchWiki!({ query: '인벤토리', source: 'all', limit: 50, offset: 0 }));
  expect(inv.hits[0].title).toBe('CMS 인벤토리 사용량 집계');
  expect(inv.counts.team).toBeGreaterThanOrEqual(1);
  expect(inv.counts.personal).toBeGreaterThanOrEqual(1);
  expect(inv.hits.some((h) => h.hits.length > 0)).toBe(true);
  const teamOnly = await page.evaluate(() => window.radar.searchWiki!({ query: '인벤토리', source: 'team', limit: 50, offset: 0 }));
  expect(teamOnly.hits.length).toBeGreaterThan(0);
  expect(teamOnly.hits.every((h) => h.source === 'team')).toBe(true);
  const dr = await page.evaluate(() => window.radar.searchWiki!({ query: '대륙', source: 'all', limit: 50, offset: 0 }));
  expect(dr.hits[0].path).toBe('wiki/entities/대륙물산.md');
  for (const q of ['옛 회의록', '회의록 템플릿', '클로드명령전용문구', '템플릿전용문구', '자재 단가 문의']) {
    const r = await page.evaluate((query) => window.radar.searchWiki!({ query, source: 'all', limit: 200, offset: 0 }), q);
    expect(
      r.hits.filter((h) => /(^|\/)(\.휴지통|templates|\.claude|raw)\//.test(h.path) || h.path.includes('(충돌')),
      q,
    ).toEqual([]);
  }
  expect((await page.evaluate(() => window.radar.searchWiki!({ query: '클로드명령전용문구', source: 'all', limit: 50, offset: 0 }))).total).toBe(0);
  expect((await page.evaluate(() => window.radar.recentWikiDocs!({ source: 'all', limit: 10 }))).length).toBe(10);

  // (c) 문서 읽기 — 링크·그림
  const pg = await page.evaluate((p) => window.radar.getWikiPage!({ source: 'personal', path: p }), BOUNDARY);
  expect(pg?.title).toBe('배치 마감 경계 조건');
  expect(pg?.links['한결케미칼']).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md' });
  expect(pg?.links['없는 문서']).toBeNull();
  expect(pg?.images['경계조건.png']).toEqual({ ok: true });
  expect(pg?.images['https://tracker.example.invalid/p.png']?.ok).toBe(false);
  const img = await page.evaluate((p) => window.radar.getWikiImage!({ source: 'personal', page: p, ref: '경계조건.png' }), BOUNDARY);
  expect('dataUrl' in img && img.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  const remote = await page.evaluate((p) => window.radar.getWikiImage!({ source: 'personal', page: p, ref: 'https://tracker.example.invalid/p.png' }), BOUNDARY);
  expect('problem' in remote).toBe(true);

  // (e) 같은 출처 우선
  const deploy = await page.evaluate(() => window.radar.getWikiPage!({ source: 'team', path: '운영/배포 절차.md' }));
  expect(deploy?.links['CMS 인벤토리 사용량 집계']).toEqual({ source: 'team', path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' });
  expect(deploy?.links['한결케미칼']).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md', crossSource: true });
  const teamImg = await page.evaluate(() => window.radar.getWikiImage!({ source: 'team', page: '운영/배포 절차.md', ref: '배포도.png' }));
  expect('dataUrl' in teamImg).toBe(true);

  // 색인에 없는 문서·잘못된 인자
  const rawMail = fs.readdirSync(sandbox!.file('raw/mail/대륙물산/2026'))[0];
  expect(await page.evaluate((p) => window.radar.getWikiPage!({ source: 'personal', path: p }), `raw/mail/대륙물산/2026/${rawMail}`)).toBeNull();
  expect(await page.evaluate(() => window.radar.getWikiPage!({ source: 'personal', path: 'templates/문서 틀.md' }))).toBeNull();
  for (const bad of [
    () => window.radar.getWikiPage!({ source: 'personal', path: '../secret.md' }),
    () => window.radar.getWikiPage!({ source: 'personal', path: 'C:/Windows/win.ini' }),
    () => window.radar.getWikiPage!({ source: 'all' as never, path: 'a.md' }),
    () => window.radar.searchWiki!({ query: '', source: 'all', limit: 50, offset: 0 }),
    () => window.radar.searchWiki!({ query: 'a', source: 'all', limit: 999, offset: 0 }),
    () => window.radar.markWikiSeen!({ items: [] }),
    () => window.radar.openExternalLink!('javascript:alert(1)'),
    () => window.radar.openExternalLink!('file:///C:/Windows/win.ini'),
    () => window.radar.openExternalLink!('https://user:pw@example.invalid/'),
  ]) {
    const msg = await page.evaluate(async (fnText) => {
      try {
        await (new Function(`return (${fnText})()`) as () => Promise<unknown>)();
        return 'ok';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }, bad.toString());
    expect(msg, bad.toString()).toMatch(/잘못된 요청/);
  }
  expect(readOpenLog(sandbox!.data)).toEqual([]);

  // (d) 외부 링크·Obsidian 열기 — 시험 모드라 기록만
  await page.evaluate(() => window.radar.openExternalLink!('https://example.invalid/guide'));
  await page.evaluate((p) => window.radar.openInObsidian(p), BOUNDARY);
  await page.evaluate(() => window.radar.openTeamDoc('운영/배포 절차.md'));
  const opened = readOpenLog(sandbox!.data);
  expect(opened.map((o) => o.kind)).toEqual(['external', 'obsidian', 'obsidian']);
  expect(opened[0].target).toBe('https://example.invalid/guide');
  expect(opened[1].target).toMatch(/^obsidian:\/\/open\?path=/);

  // (k) 읽기만 — 위키·팀 사본은 그대로, 데이터 폴더에 색인·읽음 기록
  await page.evaluate(() => window.radar.refreshWikiDocs!());
  expect(treeDigest(sandbox!.wiki)).toEqual(wikiBefore);
  expect(treeDigest(team!.local)).toEqual(teamBefore);
  await expect.poll(() => fs.existsSync(path.join(sandbox!.data, 'wiki-index.json')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => fs.existsSync(path.join(sandbox!.data, 'wiki-seen.json')), { timeout: 10_000 }).toBe(true);
});

test('개인 변경: 감시 → 바뀜(이유·줄 수)·새 문서·지움 → 읽음·모두 읽음·되돌리기 · 다시 시작', async () => {
  test.setTimeout(120_000);
  const { page } = await start();
  expect((await summaryOf(page)).changes.personal).toBe(0);
  // (f)
  appendLine(sandbox!.file('wiki/entities/한결케미칼.md'), '\n- 사용량 회신 반영 완료\n');
  appendLine(sandbox!.file('log.md'), '\n## [2026-09-23] update | 사용량 회신 반영\n\n[[한결케미칼]] 회신을 반영했다.\n');
  fs.writeFileSync(sandbox!.file('wiki/topics/새 주제.md'), '# 새 주제\n처음 쓰는 글\n', 'utf8');
  fs.rmSync(sandbox!.file('wiki/entities/해온정밀.md'));
  await expect.poll(async () => (await summaryOf(page)).changes.personal, { timeout: 10_000 }).toBe(3);
  const list = await page.evaluate(() => window.radar.getWikiChanges!({ source: 'personal', offset: 0, limit: 200 }));
  const hg = list.items.find((i) => i.path === 'wiki/entities/한결케미칼.md');
  expect(hg?.change).toBe('changed');
  expect(hg?.lines).toMatchObject({ added: 1, removed: 0 });
  expect(hg?.reasons?.[0]).toMatchObject({ date: '2026-09-23', title: '사용량 회신 반영' });
  expect(list.items.find((i) => i.path === 'wiki/topics/새 주제.md')?.change).toBe('new');
  expect(list.items.find((i) => i.path === 'wiki/entities/해온정밀.md')?.change).toBe('deleted');
  const recent = await page.evaluate(() => window.radar.getWikiLogRecent!());
  expect(recent[0]).toMatchObject({ date: '2026-09-23', title: '사용량 회신 반영' });

  const one = await page.evaluate(() => window.radar.markWikiSeen!({ items: [{ source: 'personal', path: 'wiki/entities/한결케미칼.md' }] }));
  expect(one.changes.personal).toBe(2);
  const all = await page.evaluate(() => window.radar.markWikiSeen!({ all: true, source: 'personal' }));
  expect(all.changes.personal).toBe(0);
  const undone = await page.evaluate((t) => window.radar.undoWikiSeen!(t), all.undoToken!);
  expect(undone.changes.personal).toBe(2);
  await page.evaluate(() => window.radar.markWikiSeen!({ all: true, source: 'personal' }));
  expect((await summaryOf(page)).changes.total).toBe(0);

  // (l) 다시 시작: 앱을 끄고 문서를 고친 뒤 다시 띄우면 「바뀜」 + 줄 수(캐시 본문으로 기준 내용)
  const keep = sandbox!;
  await closeApp(app!);
  app = null;
  sandbox = null;
  appendLine(keep.file('wiki/entities/서진화학.md'), '\n꺼진 동안 더한 줄\n');
  const again = await start({ keep: { sandbox: keep } });
  await expect.poll(async () => (await summaryOf(again.page)).changes.personal, { timeout: 15_000 }).toBe(1);
  const items = (await again.page.evaluate(() => window.radar.getWikiChanges!({ source: 'personal', offset: 0, limit: 200 }))).items;
  expect(items.map((i) => [i.path, i.change, i.lines?.added, i.lines?.removed])).toEqual([['wiki/entities/서진화학.md', 'changed', 1, 0]]);
});

test('팀 변경: 받은 것만(+줄 수) · 내가 사본을 고친 것은 동기화 전후 모두 보이지 않음', async () => {
  test.setTimeout(150_000);
  const { page, team } = await start({ team: true });
  // (h) 임시 NAS 의 회의록에 두 줄 → 동기화
  appendLine(path.join(team!.remote, '회의록', '2026-09-22 주간회의.md'), '\n팀원이 더한 첫 줄\n팀원이 더한 둘째 줄\n');
  await page.evaluate(() => window.radar.runTeamSync());
  await expect.poll(async () => (await summaryOf(page)).changes.team, { timeout: 15_000 }).toBe(1);
  const page1 = await page.evaluate(() => window.radar.getWikiChanges!({ source: 'team', offset: 0, limit: 200 }));
  expect(page1.items.map((i) => [i.path, i.change, i.lines?.added, i.lines?.removed, i.lines?.sample[0]])).toEqual([
    ['회의록/2026-09-22 주간회의.md', 'changed', 2, 0, '팀원이 더한 첫 줄'],
  ]);
  await page.evaluate(() => window.radar.markWikiSeen!({ all: true, source: 'team' }));

  // 내가 사본을 고침 → 감시가 색인해도 보이지 않고 → 동기화(pushed) 뒤에도 보이지 않는다
  appendLine(path.join(team!.local, '운영', '서버 점검.md'), '\n내가 더한 줄\n');
  await page.waitForTimeout(2_500);
  await page.evaluate(() => window.radar.refreshWikiDocs!());
  expect((await summaryOf(page)).changes.team).toBe(0);
  const synced = await page.evaluate(() => window.radar.runTeamSync());
  expect(synced.last?.pushed).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1_000);
  await page.evaluate(() => window.radar.refreshWikiDocs!());
  expect((await summaryOf(page)).changes.team).toBe(0);
  expect(fs.readFileSync(path.join(team!.remote, '운영', '서버 점검.md'), 'utf8')).toContain('내가 더한 줄');
});

test('쓸 수 없음: 팀 끔 → 개인만 · 개인 위키 없음 + 팀 켬 → 팀만', async () => {
  test.setTimeout(120_000);
  const { page } = await start();
  const s1 = await summaryOf(page);
  expect(s1.sources.team.state).toBe('off');
  expect(s1.sources.team.problem).toMatch(/꺼져/);
  const r = await page.evaluate(() => window.radar.searchWiki!({ query: '배포', source: 'all', limit: 50, offset: 0 }));
  expect(r.counts.team).toBe(0);
  expect((await page.evaluate(() => window.radar.getWikiChanges!({ source: 'team', offset: 0, limit: 10 }))).state).toBe('off');
  await closeApp(app!);
  app = null;

  // 개인 위키 없음 + 팀 켬
  const t = tempDir('wiki-radar-e2e-3a-noper-');
  const team = { remote: path.join(t, 'nas'), local: path.join(t, 'local') };
  app = await launchApp({ wiki: path.join(t, '없는 위키'), dataDir: path.join(t, 'data'), now: NOW, team });
  logs = watchLogs(app);
  const p2 = await windowByMode(app, 'sidebar');
  await expect.poll(async () => (await p2.evaluate(() => window.radar.getWikiDocs!())).sources.team.state, { timeout: 30_000 }).toBe('ready');
  const s2 = await p2.evaluate(() => window.radar.getWikiDocs!());
  expect(s2.sources.personal.state).toBe('noWiki');
  const r2 = await p2.evaluate(() => window.radar.searchWiki!({ query: '배포', source: 'all', limit: 50, offset: 0 }));
  expect(r2.counts.personal).toBe(0);
  expect(r2.counts.team).toBeGreaterThanOrEqual(1);
});
