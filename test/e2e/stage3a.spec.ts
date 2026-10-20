// 3a단계 B(화면) 시험 — 「위키」 묶음 [검색] [변경] · 미리보기 · 사이드바 「변경 N」 · Ctrl+K (docs/stage3a-contract.md §14-3 (a)~(l)).
// 개인 위키는 테스트 사본의 임시 복사본, 팀 위키는 임시 NAS·사본 폴더(test/fixtures/team-wiki 복사본)만 쓴다. 실제 위키·NAS 는 부르지 않는다.
// 외부 링크·Obsidian 열기는 시험 모드라 <데이터 폴더>/open-log.jsonl 에만 적힌다. 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { FIXTURE_TEAM_WIKI, FIXTURE_WIKI, closeApp, createWikiSandbox, launchApp, treeDigest, watchLogs, windowByMode, type AppLogs, type WikiSandbox } from './app';

const NOW = '2026-09-23T10:00';
const BOUNDARY = 'wiki/topics/dev/배치 마감 경계 조건.md';
const HANGYEOL = 'wiki/entities/한결케미칼.md';
const CMS = 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md';
const DEPLOY = '운영/배포 절차.md';

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
    await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
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

interface Started {
  sidebar: Page;
  full: Page;
  team?: Team;
}

/** 앱을 띄우고 색인(팀이면 첫 동기화 뒤 기준선까지)을 기다린 뒤 풀스크린을 연다 */
async function start(opts: { team?: boolean; keep?: WikiSandbox } = {}): Promise<Started> {
  sandbox = opts.keep ?? createWikiSandbox('wiki-radar-e2e-3a-ui-');
  let team: Team | undefined;
  if (opts.team) {
    const t = tempDir('wiki-radar-e2e-3a-ui-team-');
    team = { remote: path.join(t, 'nas'), local: path.join(t, 'local') };
  }
  app = await launchApp({ wiki: sandbox.wiki, dataDir: sandbox.data, now: NOW, ...(team ? { team } : {}) });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  await expect
    .poll(async () => (await sidebar.evaluate(() => window.radar.getWikiDocs!())).sources.personal.state, { timeout: 20_000 })
    .toBe('ready');
  if (team) {
    await expect
      .poll(
        async () => {
          const s = await sidebar.evaluate(() => window.radar.getWikiDocs!());
          const c = await sidebar.evaluate(() => window.radar.getWikiChanges!({ source: 'team', offset: 0, limit: 10 }));
          return `${s.sources.team.state}/${c.state}`;
        },
        { timeout: 30_000 },
      )
      .toBe('ready/ready');
  }
  await sidebar.getByTestId('btn-full').click();
  const full = await windowByMode(app, 'full');
  await expect(full.getByTestId('full')).toBeVisible();
  return { sidebar, full, ...(team ? { team } : {}) };
}

function readOpenLog(dataDir: string): { kind: string; target: string }[] {
  const p = path.join(dataDir, 'open-log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { kind: string; target: string });
}

async function search(full: Page, q: string): Promise<void> {
  const input = full.getByTestId('wiki-search-input');
  await input.fill(q);
  // 결과(또는 결과 없음)가 이 질의의 것일 때까지
  await expect(full.locator('[data-testid="wiki-hits"]:not(.is-stale), [data-testid="wiki-search-empty"]').first()).toBeVisible({ timeout: 10_000 });
}

async function openHit(full: Page, source: 'personal' | 'team', p: string): Promise<void> {
  await full.locator(`[data-testid="wiki-hit"][data-source="${source}"][data-path="${p}"]`).click();
  await expect(full.locator(`[data-testid="wiki-preview"][data-source="${source}"][data-path="${p}"]`)).toBeVisible();
  await expect(full.getByTestId('wiki-preview-body')).toBeVisible();
}

const preview = (full: Page) => full.getByTestId('wiki-preview');

test('(a)(b)(c)(d)(e)(i)(k) 내비·검색·안전한 미리보기·외부 링크·같은 출처 우선·Ctrl+K·읽기만', async () => {
  test.setTimeout(180_000);
  const { sidebar, full, team } = await start({ team: true });
  const wikiBefore = treeDigest(sandbox!.wiki);
  const teamBefore = treeDigest(team!.local);
  const requests: string[] = [];
  full.on('request', (r) => requests.push(r.url()));

  await test.step('(a) 내비 「위키」 묶음·첫 실행 변경 0·사이드바 변경 0', async () => {
    const order = await full
      .locator('.fv-nav [data-testid]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')).filter((id) => /^nav-(group|search|changes$|voc$|queue$)/.test(id ?? '')));
    expect(order).toEqual(['nav-group-incoming', 'nav-voc', 'nav-group-wiki', 'nav-search', 'nav-changes', 'nav-group-record', 'nav-queue']);
    await expect(full.getByTestId('nav-group-wiki')).toHaveText('위키');
    await expect(full.getByTestId('nav-changes')).toHaveAttribute('data-count', '0');
    await expect(full.getByTestId('nav-changes').locator('.nav-item-count')).toHaveClass(/is-zero/);
    await expect(sidebar.getByTestId('sidebar-changes')).toHaveAttribute('data-count', '0');
    await expect(sidebar.getByTestId('sidebar-changes')).toHaveClass(/is-zero/);
  });

  await test.step('(i) 할 일 화면에서 Ctrl+K → 검색 화면 · 검색 칸 초점', async () => {
    await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'tasks');
    await full.locator('body').click({ position: { x: 600, y: 400 } }).catch(() => undefined);
    await full.keyboard.press('Control+K');
    await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'search');
    await expect(full.locator('.titlebar-page')).toHaveText('검색');
    await expect(full.getByTestId('wiki-search-input')).toBeFocused();
    // 빈 질의: 최근 바뀐 문서 10개 · 도움말 · 아무것도 고르지 않음
    await expect(full.getByTestId('wiki-recent-doc')).toHaveCount(10);
    await expect(full.getByTestId('search-view')).toContainText('Ctrl+K 로 어디서나 검색');
    await expect(full.locator('.wk-preview--empty')).toBeVisible();
  });

  await test.step('(b) 검색: 제목 우선·두 출처·강조·출처 칩·별칭·제외 폴더', async () => {
    await search(full, '인벤토리');
    await expect(full.getByTestId('wiki-hit').first().locator('.wk-hit-title')).toHaveText('CMS 인벤토리 사용량 집계');
    await expect(full.locator('[data-testid="wiki-hit"][data-source="team"]').first()).toBeVisible();
    await expect(full.locator('[data-testid="wiki-hit"][data-source="personal"]').first()).toBeVisible();
    expect(Number(await full.getByTestId('wiki-source-team').getAttribute('data-count'))).toBeGreaterThanOrEqual(1);
    await expect(full.getByTestId('wiki-hit-snippet').locator('mark').first()).toBeVisible();
    await full.getByTestId('wiki-source-team').click();
    await expect(full.getByTestId('wiki-source-team')).toHaveAttribute('aria-pressed', 'true');
    await expect(full.locator('[data-testid="wiki-hit"][data-source="personal"]')).toHaveCount(0);
    expect(await full.getByTestId('wiki-hit').count()).toBeGreaterThan(0);
    await full.getByTestId('wiki-source-all').click();

    await search(full, '대륙');
    await expect(full.getByTestId('wiki-hit').first()).toHaveAttribute('data-path', 'wiki/entities/대륙물산.md');
    for (const q of ['옛 회의록', '회의록 템플릿', '클로드명령전용문구', '템플릿전용문구', '자재 단가 문의']) {
      await search(full, q);
      const paths = await full.getByTestId('wiki-hit').evaluateAll((els) => els.map((e) => e.getAttribute('data-path') ?? ''));
      expect(paths.filter((p) => /(^|\/)(\.휴지통|templates|\.claude|raw)\//.test(p) || p.includes('(충돌')), q).toEqual([]);
    }
    await search(full, '클로드명령전용문구');
    await expect(full.getByTestId('wiki-search-empty')).toContainText('클로드명령전용문구');
    // 출처를 좁힌 채 결과가 없으면 [전체에서 찾기]
    await full.getByTestId('wiki-source-team').click();
    await search(full, '한결케미칼 통영공장');
    await expect(full.getByTestId('btn-wiki-search-all')).toBeVisible();
    await full.getByTestId('btn-wiki-search-all').click();
    await expect(full.getByTestId('wiki-source-all')).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('(c) 미리보기: 표·콜아웃·dataview 안내·HTML 은 글자·그림·위키링크·[뒤로]', async () => {
    await search(full, '경계 조건');
    await openHit(full, 'personal', BOUNDARY);
    const body = full.getByTestId('wiki-preview-body');
    await expect(body.locator('table')).toHaveCount(1);
    await expect(body.locator('blockquote.callout.callout-warning')).toContainText('주의');
    await expect(full.getByTestId('wiki-dataview-note')).toContainText('자동 목록(Dataview)');
    await expect(body).toContainText('<script>alert(1)</script>');
    await expect(body).toContainText('<img src=x onerror=alert(1)>');
    await expect(body.locator('img[src^="data:image/png"]')).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText('원격 그림 — 불러오지 않음');
    await expect(body.locator('.wl.is-missing')).toContainText('없는 문서');
    const unsafe = await body.evaluate((root) => {
      const bad: string[] = [];
      for (const el of root.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        if (['script', 'iframe', 'object', 'embed', 'style', 'svg', 'form', 'input'].includes(tag)) bad.push(tag);
        for (const a of el.getAttributeNames()) if (/^on/i.test(a)) bad.push(`${tag}[${a}]`);
        const href = el.getAttribute('href');
        if (href !== null && href !== '#') bad.push(`href=${href}`);
        const src = el.getAttribute('src');
        if (src !== null && !src.startsWith('data:image/')) bad.push(`src=${src}`);
      }
      return bad;
    });
    expect(unsafe).toEqual([]);
    // 위키링크 [[한결케미칼|한결]] → 그 문서 → [뒤로]
    await body.locator('[data-wiki-link="한결케미칼"]').first().click();
    await expect(preview(full)).toHaveAttribute('data-path', HANGYEOL);
    await full.getByTestId('btn-wiki-back').click();
    await expect(preview(full)).toHaveAttribute('data-path', BOUNDARY);
    await expect(full.getByTestId('btn-wiki-back')).toBeDisabled();
    // 개인 문서의 같은 이름 링크는 개인 문서로(같은 출처 우선)
    await body.locator('[data-wiki-link="CMS 인벤토리 사용량 집계#원인"]').click();
    await expect(preview(full)).toHaveAttribute('data-source', 'personal');
    await expect(preview(full)).toHaveAttribute('data-path', CMS);
    await full.getByTestId('btn-wiki-back').click();
    await expect(preview(full)).toHaveAttribute('data-path', BOUNDARY);
  });

  await test.step('(d) 외부 링크: 확인창 주소 전체 → [취소]는 기록 없음 → [열기] → open-log · Obsidian 열기(개인)', async () => {
    const body = full.getByTestId('wiki-preview-body');
    await body.locator('[data-ext-link]').first().click();
    const dialog = full.getByTestId('wiki-ext-confirm');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('wiki-ext-url')).toHaveText('https://example.invalid/guide');
    await dialog.getByTestId('btn-wiki-ext-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(readOpenLog(sandbox!.data)).toEqual([]);
    await body.locator('[data-ext-link]').first().click();
    await full.getByTestId('btn-wiki-ext-open').click();
    await expect.poll(() => readOpenLog(sandbox!.data).length).toBe(1);
    expect(readOpenLog(sandbox!.data)[0]).toMatchObject({ kind: 'external', target: 'https://example.invalid/guide' });
    await full.getByTestId('btn-wiki-obsidian').click();
    await expect.poll(() => readOpenLog(sandbox!.data).map((o) => o.kind)).toEqual(['external', 'obsidian']);
  });

  await test.step('(e) 팀 문서: 같은 출처 우선 · 개인에만 있는 문서는 다른 출처(is-cross) · 팀 그림 · Obsidian 열기(팀)', async () => {
    await search(full, '배포 절차');
    await openHit(full, 'team', DEPLOY);
    const body = full.getByTestId('wiki-preview-body');
    await expect(body.locator('img[src^="data:image/png"]')).toBeVisible({ timeout: 10_000 });
    await full.getByTestId('btn-wiki-obsidian').click();
    await expect.poll(() => readOpenLog(sandbox!.data).map((o) => o.kind)).toEqual(['external', 'obsidian', 'obsidian']);
    await body.locator('[data-wiki-link="CMS 인벤토리 사용량 집계"]').click();
    await expect(preview(full)).toHaveAttribute('data-source', 'team');
    await expect(preview(full)).toHaveAttribute('data-path', CMS);
    await full.getByTestId('btn-wiki-back').click();
    await expect(preview(full)).toHaveAttribute('data-path', DEPLOY);
    const cross = full.getByTestId('wiki-preview-body').locator('[data-wiki-link="한결케미칼"]');
    await expect(cross).toHaveClass(/is-cross/);
    await cross.click();
    await expect(preview(full)).toHaveAttribute('data-source', 'personal');
    await expect(preview(full)).toHaveAttribute('data-path', HANGYEOL);
  });

  await test.step('미리보기 동안 http(s) 요청 0건', async () => {
    expect(requests.filter((u) => /^(https?|wss?):/i.test(u))).toEqual([]);
  });

  await test.step('(i) 사이드바 창에서 Ctrl+K → 풀스크린 검색', async () => {
    await full.getByTestId('nav-tasks').click();
    await full.evaluate(() => window.radar.setMode('sidebar'));
    await expect.poll(async () => sidebar.evaluate(() => document.visibilityState)).toBe('visible');
    await sidebar.locator('body').click({ position: { x: 100, y: 200 } }).catch(() => undefined);
    await sidebar.keyboard.press('Control+K');
    await expect(full.getByTestId('full')).toHaveAttribute('data-page', 'search');
  });

  await test.step('(k) 읽기만: 위키·팀 사본은 그대로 · 데이터 폴더에 색인·읽음 기록', async () => {
    expect(treeDigest(sandbox!.wiki)).toEqual(wikiBefore);
    expect(treeDigest(team!.local)).toEqual(teamBefore);
    expect(fs.existsSync(path.join(sandbox!.data, 'wiki-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox!.data, 'wiki-seen.json'))).toBe(true);
  });
  expect(logs!.rendererErrors).toEqual([]);
});

test('(f)(g)(l) 개인 변경 화면: 바뀜(이유·줄 수)·새 문서·지움 → 1초 읽음·[읽음]·모두 읽음·되돌리기 · 할 일 저장은 늘지 않음 · 다시 시작', async () => {
  test.setTimeout(180_000);
  const { sidebar, full } = await start();
  const navChanges = full.getByTestId('nav-changes');

  await full.getByTestId('nav-changes').click();
  await expect(full.getByTestId('changes-view')).toHaveAttribute('data-tab', 'personal');
  await expect(full.locator('.titlebar-page')).toHaveText('변경');
  await expect(full.locator('[data-testid="wiki-changes-state"][data-state="empty"]')).toContainText('마지막으로 본 뒤 바뀐 문서가 없습니다');
  // 첫 실행: 최근 기록(log.md 14일)
  const recent = full.getByTestId('wiki-log-recent');
  await recent.locator('summary').click();
  await expect(recent).toContainText('한결케미칼 사용량 회신 정리');
  await expect(recent).not.toContainText('날짜가 틀린 머리');

  await test.step('(f) 감시 → 변경 3(내비·사이드바)', async () => {
    fs.appendFileSync(sandbox!.file(HANGYEOL), '\n- 사용량 회신 반영 완료\n', 'utf8');
    fs.appendFileSync(sandbox!.file('log.md'), '\n## [2026-09-23] update | 사용량 회신 반영\n\n[[한결케미칼]] 회신을 반영했다.\n', 'utf8');
    fs.writeFileSync(sandbox!.file('wiki/topics/새 주제.md'), '# 새 주제\n처음 쓰는 글\n', 'utf8');
    fs.rmSync(sandbox!.file('wiki/entities/해온정밀.md'));
    await expect(navChanges).toHaveAttribute('data-count', '3', { timeout: 10_000 });
    await expect(navChanges).toHaveAttribute('data-personal', '3');
    await expect(sidebar.getByTestId('sidebar-changes')).toHaveAttribute('data-count', '3');
    const row = full.locator(`[data-testid="wiki-change-row"][data-path="${HANGYEOL}"]`);
    await expect(row).toHaveAttribute('data-change', 'changed');
    await expect(row).toHaveAttribute('data-added', '1');
    await expect(row).toHaveAttribute('data-removed', '0');
    await expect(row.getByTestId('wiki-change-reason').first()).toContainText('[2026-09-23] update · 사용량 회신 반영');
    await expect(row).toContainText('+1 −0');
    await expect(full.locator('[data-testid="wiki-change-row"][data-path="wiki/topics/새 주제.md"]')).toHaveAttribute('data-change', 'new');
    await expect(full.locator('[data-testid="wiki-change-row"][data-path="wiki/entities/해온정밀.md"]')).toHaveAttribute('data-change', 'deleted');
    await expect(full.locator('.wk-day-title').first()).toHaveText('오늘');
  });

  await test.step('(f) 줄을 골라 1초 → 2 · 줄은 흐리게 남는다 · 변경 띠', async () => {
    const row = full.locator(`[data-testid="wiki-change-row"][data-path="${HANGYEOL}"]`);
    await row.locator('.wk-row-main').click();
    await expect(preview(full)).toHaveAttribute('data-path', HANGYEOL);
    await expect(full.getByTestId('wiki-change-band')).toContainText('사용량 회신 반영');
    await expect(navChanges).toHaveAttribute('data-count', '2', { timeout: 5_000 });
    await expect(row).toHaveAttribute('data-seen', 'true');
    // 지운 문서를 고르면 본문 대신 안내
    await full.locator('[data-testid="wiki-change-row"][data-change="deleted"] .wk-row-main').click();
    await expect(full.getByTestId('wiki-deleted-note')).toContainText('지운 문서');
    await expect(navChanges).toHaveAttribute('data-count', '1', { timeout: 5_000 });
    // 줄의 [읽음]
    await full.locator('[data-testid="wiki-change-row"][data-change="new"]').getByTestId('btn-wiki-seen').click();
    await expect(navChanges).toHaveAttribute('data-count', '0');
    await expect(full.locator('[data-testid="wiki-change-row"][data-seen="true"]')).toHaveCount(3);
  });

  await test.step('(f) [모두 읽음] → 0 → [되돌리기] → 다시 2 → [모두 읽음]', async () => {
    // 다른 화면에 다녀오면 흐린 줄은 빠진다 — 새 변경 둘을 만든다
    await full.getByTestId('nav-search').click();
    fs.appendFileSync(sandbox!.file('wiki/entities/서진화학.md'), '\n더한 줄 하나\n', 'utf8');
    fs.appendFileSync(sandbox!.file('wiki/entities/대륙물산.md'), '\n더한 줄 둘\n', 'utf8');
    await expect(navChanges).toHaveAttribute('data-count', '2', { timeout: 10_000 });
    await full.getByTestId('nav-changes').click();
    await expect(full.getByTestId('wiki-change-row')).toHaveCount(2);
    await full.getByTestId('btn-wiki-seen-all').click();
    await expect(navChanges).toHaveAttribute('data-count', '0');
    await expect(full.getByTestId('wiki-undo')).toBeVisible();
    await full.getByTestId('btn-wiki-undo').click();
    await expect(navChanges).toHaveAttribute('data-count', '2');
    await expect(full.getByTestId('wiki-change-row')).toHaveCount(2);
    await full.getByTestId('btn-wiki-seen-all').click();
    await expect(navChanges).toHaveAttribute('data-count', '0');
    await expect(sidebar.getByTestId('sidebar-changes')).toHaveAttribute('data-count', '0');
  });

  await test.step('(g) 할 일 처리 결과 저장 뒤에도 변경 수가 늘지 않는다', async () => {
    const taskId = await full.evaluate(async () => {
      const snap = await window.radar.getSnapshot();
      return snap.tasks.find((t) => /^[ic]:/.test(t.id))?.id ?? null;
    });
    expect(taskId).not.toBeNull();
    await full.evaluate((id) => window.radar.saveResult({ taskId: id!, status: 'wip', note: '3a 시험 메모', reflect: false }), taskId);
    await full.waitForTimeout(2_500);
    await full.evaluate(() => window.radar.refreshWikiDocs!());
    await expect(navChanges).toHaveAttribute('data-count', '0');
  });

  await test.step('(l) 앱을 끄고 문서를 고친 뒤 다시 띄우면 「바뀜」 + 줄 수', async () => {
    const keep = sandbox!;
    await closeApp(app!);
    app = null;
    sandbox = null;
    fs.appendFileSync(keep.file('wiki/entities/서진화학.md'), '\n꺼진 동안 더한 줄\n', 'utf8');
    const again = await start({ keep });
    await expect(again.full.getByTestId('nav-changes')).toHaveAttribute('data-count', '1', { timeout: 15_000 });
    await again.full.getByTestId('nav-changes').click();
    const row = again.full.locator('[data-testid="wiki-change-row"][data-path="wiki/entities/서진화학.md"]');
    await expect(row).toHaveAttribute('data-change', 'changed');
    await expect(row).toHaveAttribute('data-added', '1');
    await expect(row).toHaveAttribute('data-removed', '0');
  });
  expect(logs!.rendererErrors).toEqual([]);
});

test('(h) 팀 변경 화면: 받은 것(+줄 수·더해진 줄)만 · 내가 사본을 고친 것은 보이지 않음', async () => {
  test.setTimeout(180_000);
  const { full, team } = await start({ team: true });
  const navChanges = full.getByTestId('nav-changes');
  await navChanges.click();
  await full.getByTestId('wiki-changes-tab-team').click();
  await expect(full.getByTestId('changes-view')).toHaveAttribute('data-tab', 'team');
  await expect(full.locator('[data-testid="wiki-changes-state"][data-state="empty"]')).toBeVisible();
  await expect(full.getByTestId('wiki-log-recent')).toHaveCount(0);

  fs.appendFileSync(path.join(team!.remote, '회의록', '2026-09-22 주간회의.md'), '\n팀원이 더한 첫 줄\n팀원이 더한 둘째 줄\n', 'utf8');
  await full.evaluate(() => window.radar.runTeamSync());
  await expect(navChanges).toHaveAttribute('data-team', '1', { timeout: 15_000 });
  await expect(full.getByTestId('wiki-changes-tab-team')).toHaveAttribute('data-count', '1');
  const row = full.locator('[data-testid="wiki-change-row"][data-path="회의록/2026-09-22 주간회의.md"]');
  await expect(row).toHaveAttribute('data-change', 'changed');
  await expect(row).toHaveAttribute('data-added', '2');
  await expect(row).toHaveAttribute('data-removed', '0');
  await expect(row).toContainText('+2 −0 줄');
  await expect(row).toContainText('팀원이 더한 첫 줄');
  await row.locator('.wk-row-main').click();
  await expect(full.getByTestId('wiki-change-band')).toContainText('팀원이 더한 둘째 줄');
  await expect(navChanges).toHaveAttribute('data-team', '0', { timeout: 5_000 });

  // 내가 사본을 고침 → 감시가 색인해도 → 동기화(pushed) 뒤에도 팀 변경에 나오지 않는다
  fs.appendFileSync(path.join(team!.local, '운영', '서버 점검.md'), '\n내가 더한 줄\n', 'utf8');
  await full.waitForTimeout(2_500);
  await full.evaluate(() => window.radar.refreshWikiDocs!());
  await expect(navChanges).toHaveAttribute('data-team', '0');
  await full.evaluate(() => window.radar.runTeamSync());
  await full.waitForTimeout(1_000);
  await full.evaluate(() => window.radar.refreshWikiDocs!());
  await expect(navChanges).toHaveAttribute('data-team', '0');
  await expect(full.locator('[data-testid="wiki-change-row"][data-path="운영/서버 점검.md"]')).toHaveCount(0);
  expect(logs!.rendererErrors).toEqual([]);
});

test('(j) 쓸 수 없음: 팀 끔 → 팀 흐림 · 개인 위키 없음 + 팀 켬 → 개인 흐림 · 둘 다 없음 → 메뉴 흐림·사이드바 칸 없음', async () => {
  test.setTimeout(180_000);
  await test.step('팀 끔: 팀 칩·팀 탭 흐림 + 이유, 개인만 결과', async () => {
    const { full } = await start();
    await full.getByTestId('nav-search').click();
    const teamChip = full.getByTestId('wiki-source-team');
    await expect(teamChip).toHaveAttribute('data-unavailable', 'true');
    await expect(teamChip).toHaveAttribute('title', /꺼져/);
    await search(full, '배포');
    await expect(full.locator('[data-testid="wiki-hit"][data-source="team"]')).toHaveCount(0);
    await full.getByTestId('nav-changes').click();
    const tab = full.getByTestId('wiki-changes-tab-team');
    await expect(tab).toHaveAttribute('data-unavailable', 'true');
    await tab.click();
    await expect(full.locator('[data-testid="wiki-changes-state"][data-state="off"]')).toContainText('팀 위키 동기화가 꺼져 있습니다');
    await closeApp(app!);
    app = null;
  });

  await test.step('개인 위키 없음 + 팀 켬: 개인 흐림, 팀만', async () => {
    const t = tempDir('wiki-radar-e2e-3a-ui-noper-');
    const team = { remote: path.join(t, 'nas'), local: path.join(t, 'local') };
    app = await launchApp({ wiki: path.join(t, '없는 위키'), dataDir: path.join(t, 'data'), now: NOW, team });
    logs = watchLogs(app);
    const sidebar = await windowByMode(app, 'sidebar');
    await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getWikiDocs!())).sources.team.state, { timeout: 30_000 }).toBe('ready');
    await expect(sidebar.getByTestId('sidebar-changes')).toBeVisible();
    await sidebar.getByTestId('btn-full').click();
    const full = await windowByMode(app, 'full');
    await expect(full.getByTestId('nav-search')).not.toHaveAttribute('data-unavailable', 'true');
    await full.getByTestId('nav-search').click();
    await expect(full.getByTestId('wiki-source-personal')).toHaveAttribute('data-unavailable', 'true');
    await search(full, '배포');
    await expect(full.locator('[data-testid="wiki-hit"][data-source="personal"]')).toHaveCount(0);
    await expect(full.locator('[data-testid="wiki-hit"][data-source="team"]').first()).toBeVisible();
    await full.getByTestId('nav-changes').click();
    await expect(full.getByTestId('wiki-changes-tab-personal')).toHaveAttribute('data-unavailable', 'true');
    await expect(full.getByTestId('changes-view')).toHaveAttribute('data-tab', 'team');
    await closeApp(app!);
    app = null;
  });

  await test.step('둘 다 없음: nav-search·nav-changes 흐림, 사이드바 칸 없음', async () => {
    const t = tempDir('wiki-radar-e2e-3a-ui-none-');
    app = await launchApp({ wiki: path.join(t, '없는 위키'), dataDir: path.join(t, 'data'), now: NOW });
    logs = watchLogs(app);
    const sidebar = await windowByMode(app, 'sidebar');
    await expect.poll(async () => (await sidebar.evaluate(() => window.radar.getWikiDocs!())).sources.personal.state, { timeout: 20_000 }).toBe('noWiki');
    await sidebar.getByTestId('btn-full').click();
    const full = await windowByMode(app, 'full');
    await expect(full.getByTestId('nav-search')).toHaveAttribute('data-unavailable', 'true');
    await expect(full.getByTestId('nav-changes')).toHaveAttribute('data-unavailable', 'true');
    await expect(full.getByTestId('nav-changes')).toHaveAttribute('aria-description', '개인 위키도 팀 위키 동기화도 없습니다');
    await expect(sidebar.getByTestId('sidebar-changes')).toHaveCount(0);
  });
});
