// 견고성·보안 회귀: 빌드된 앱을 시나리오마다 따로 띄운다(각 시나리오는 자기 임시 위키·userData 를 쓴다).
//  1. 아웃바운드 0 — 맞춤법 사전을 내려받지 않고(userData/Dictionaries 없음), 외부 요청이 하나도 없다
//  2. renderer 가 file:// 로 앱 밖 파일을 읽지 못한다(CSP connect-src 'none' + main webRequest 가드)
//  3. 시작 시 위키 폴더가 없어도 폴더가 생기면 스스로 회복하고, 그 뒤 감시도 살아 있다
//  4. 앱이 감시하는 동안 하위 폴더가 있는 폴더의 이름을 바꿀 수 있다(EPERM 없음)
//  5. 지난 공휴일 이름의 대비가 4.5:1 을 넘고, 긴 공휴일 이름은 잘리지 않으며 칸에 title 이 있다
// 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { FIXTURE_WIKI, closeApp, launchApp, treeDigest, watchLogs, windowByMode, type AppLogs } from './app';

const TODAY = '2026-09-23';
/** 명세 §3 + 2단계 §4-1: 테스트 사본의 열린 할 일 수(5+4+2+2+10) */
const FIXTURE_TASK_COUNT = 23;
/** main 의 감시 재시도 주기(config WATCH_RETRY_MS) + 여유 */
const WATCH_RETRY_WAIT_MS = 25_000;

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
function copyFixture(dest: string): void {
  fs.cpSync(FIXTURE_WIKI, dest, { recursive: true });
}
function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

let app: ElectronApplication | null = null;
let logs: AppLogs | null = null;
/** 몇 시나리오는 테스트 사본을 직접 읽는다(쓰지 않는다) — 끝난 뒤 그대로인지 본다 */
let fixtureBefore: Record<string, string> | undefined;

test.beforeAll(() => {
  fixtureBefore = treeDigest(FIXTURE_WIKI);
});

test.afterAll(() => {
  if (fixtureBefore) expect(treeDigest(FIXTURE_WIKI), '원본 test/fixtures/wiki 가 바뀌었다').toEqual(fixtureBefore);
});

test.afterEach(async ({}, testInfo) => {
  if (app && logs && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('renderer-console.txt', { body: logs.renderer.join('\n') || '(없음)', contentType: 'text/plain' });
    await testInfo.attach('main-console.txt', { body: logs.main.join('\n') || '(없음)', contentType: 'text/plain' });
  }
  if (app) await closeApp(app);
  app = null;
  logs = null;
  while (temps.length) {
    try {
      fs.rmSync(temps.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 임시 폴더라 남아도 괜찮다
    }
  }
});

async function launch(wiki: string, today = TODAY): Promise<{ app: ElectronApplication; logs: AppLogs; sidebar: Page }> {
  app = await launchApp({ wiki, today });
  logs = watchLogs(app);
  const sidebar = await windowByMode(app, 'sidebar');
  return { app, logs, sidebar };
}

/** 사이드바에 보이는 할 일 줄 수(지남·이번 주·재촉 구간만 줄로 보인다) */
const rows = (page: Page) => page.getByTestId('task-row');

test('아웃바운드 0: 맞춤법 사전을 내려받지 않고 외부 요청이 없다', async () => {
  const { app, logs, sidebar } = await launch(FIXTURE_WIKI);
  await expect(sidebar.getByTestId('week-track')).toBeVisible();
  // 사전 다운로드는 시작 직후(수백 ms 안에) 일어난다 — 넉넉히 기다린 뒤 본다
  await sidebar.waitForTimeout(4_000);

  const probe = await app.evaluate(({ app, session }) => ({
    userData: app.getPath('userData'),
    spellEnabled: session.defaultSession.isSpellCheckerEnabled(),
    spellLanguages: session.defaultSession.getSpellCheckerLanguages(),
  }));
  expect(probe.spellEnabled).toBe(false);
  expect(probe.spellLanguages).toEqual([]);
  expect(fs.existsSync(path.join(probe.userData, 'Dictionaries')), 'userData/Dictionaries 가 생기면 사전을 내려받은 것').toBe(false);

  // main 의 webRequest 가드는 허용되지 않은 요청을 만나면 '외부 요청을 막음' 을 남긴다 — 정상 실행에는 그런 요청 자체가 없어야 한다
  expect(logs.main.filter((l) => l.includes('외부 요청을 막음'))).toEqual([]);
  expect(logs.rendererErrors).toEqual([]);
});

test('renderer 는 file:// 로 앱 밖 파일을 읽지 못한다', async () => {
  const { app, sidebar } = await launch(FIXTURE_WIKI);
  await expect(sidebar.getByTestId('week-track')).toBeVisible();
  const full = await windowByMode(app, 'full');
  const wikiFile = path.join(FIXTURE_WIKI, '_private', 'mgmt', '내 할 일.md');

  const csp = await full.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("frame-src 'none'");

  const targets = ['file:///C:/Windows/win.ini', 'file:///C:/Windows/System32/drivers/etc/hosts', `file:///${wikiFile.replace(/\\/g, '/')}`];
  for (const url of targets) {
    const fetched = await full.evaluate(async (u) => {
      try {
        const r = await fetch(u);
        return { ok: true, status: r.status, len: (await r.text()).length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, url);
    expect(fetched.ok, `fetch(${url}) 가 막혀야 한다: ${JSON.stringify(fetched)}`).toBe(false);

    const xhr = await full.evaluate((u) => {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', u, false);
        x.send();
        return { status: x.status, len: x.responseText.length };
      } catch (e) {
        return { error: String(e) };
      }
    }, url);
    expect(xhr.status ?? 0, `XHR(${url}) 가 막혀야 한다: ${JSON.stringify(xhr)}`).toBe(0);

    const iframe = await full.evaluate(async (u) => {
      const f = document.createElement('iframe');
      f.src = u;
      document.body.appendChild(f);
      await new Promise((r) => setTimeout(r, 800));
      let text: string | null = null;
      try {
        text = f.contentDocument?.body?.innerText ?? null;
      } catch {
        text = null;
      }
      f.remove();
      return text ?? '';
    }, url);
    expect(iframe, `iframe(${url}) 로 내용을 읽을 수 없어야 한다`).toBe('');
  }

  // IPC 는 그대로 동작한다
  const ipc = await full.evaluate(async () => ({ mode: await window.radar.getMode(), tasks: (await window.radar.getSnapshot()).tasks.length }));
  expect(ipc).toEqual({ mode: 'full', tasks: FIXTURE_TASK_COUNT });
});

test('시작 시 위키 폴더가 없어도 폴더가 생기면 스스로 회복하고 감시가 살아 있다', async () => {
  test.setTimeout(120_000);
  const parent = tempDir('wiki-radar-e2e-late-');
  const wiki = path.join(parent, 'late', 'WIKI');
  const { logs, sidebar } = await launch(wiki);

  const error = sidebar.getByTestId('snapshot-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('위키 폴더를 찾을 수 없습니다');
  // 창 2개가 같은 실패를 요청해도 main 로그에는 Electron 의 핸들러 스택이 아니라 우리 한 줄만 남는다
  expect(logs.main.filter((l) => l.includes('Error occurred in handler'))).toEqual([]);
  expect(logs.main.filter((l) => l.includes('radar:getSnapshot 실패'))).toHaveLength(1);

  // 폴더가 생긴다 — '다시 시도' 를 누르지 않아도 스냅샷이 온다
  copyFixture(wiki);
  await expect(sidebar.getByTestId('snapshot-error')).toHaveCount(0, { timeout: WATCH_RETRY_WAIT_MS });
  await expect(sidebar.getByTestId('bucket-overdue')).toHaveAttribute('data-count', '5', { timeout: 15_000 });
  const before = await rows(sidebar).count();

  // 그 뒤의 변경도 화면에 반영된다(감시가 붙었다)
  fs.appendFileSync(at(wiki, '_private/mgmt/내 할 일.md'), '\n- [ ] 늦게 붙은 뒤 추가한 할 일 #내할일 [due:: 2026-09-25]\n', 'utf8');
  await expect(sidebar.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', '5', { timeout: 15_000 });
  expect(await rows(sidebar).count()).toBe(before + 1);
  expect(logs.rendererErrors).toEqual([]);
});

test('감시 중에도 하위 폴더가 있는 폴더의 이름을 바꿀 수 있고 목록이 따라온다', async () => {
  const wiki = path.join(tempDir('wiki-radar-e2e-rename-'), 'wiki');
  copyFixture(wiki);
  const { app, sidebar } = await launch(wiki);
  await expect(sidebar.getByTestId('bucket-overdue')).toHaveAttribute('data-count', '5');
  await sidebar.waitForTimeout(500);

  // chokidar 시절에는 wiki/topics(안에 dev/)·wiki·볼트 루트 모두 EPERM 이었다
  expect(() => fs.renameSync(at(wiki, 'wiki/topics'), at(wiki, 'wiki/topics2'))).not.toThrow();
  expect(() => fs.renameSync(at(wiki, 'wiki'), at(wiki, 'wiki-renamed'))).not.toThrow();

  // 옮긴 폴더 안의 변경이 화면에 반영된다(감시가 폴더 이름 바꾸기 뒤에도 이어진다)
  fs.appendFileSync(
    at(wiki, 'wiki-renamed/topics2/dev/CMS 인벤토리 사용량 집계.md'),
    '\n- [ ] 옮긴 폴더에서 추가한 할 일 #내할일 [due:: 2026-09-25]\n',
    'utf8',
  );
  await expect(sidebar.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', '5', { timeout: 15_000 });
  await expect(rows(sidebar).filter({ hasText: '옮긴 폴더에서 추가한 할 일' })).toHaveCount(1);

  // 되돌려도 계속 따라온다(추가한 줄은 파일에 남아 있으므로 이번 주 5건, 나머지는 정답표대로)
  fs.renameSync(at(wiki, 'wiki-renamed'), at(wiki, 'wiki'));
  fs.renameSync(at(wiki, 'wiki/topics2'), at(wiki, 'wiki/topics'));
  const full = await windowByMode(app, 'full');
  await expect(full.getByTestId('bucket-other')).toHaveAttribute('data-count', '10', { timeout: 15_000 });
  await expect(full.getByTestId('bucket-overdue')).toHaveAttribute('data-count', '5');
  await expect(full.getByTestId('bucket-thisWeek')).toHaveAttribute('data-count', '5');
  await expect(full.getByTestId('task-row').filter({ hasText: '옮긴 폴더에서 추가한 할 일' })).toHaveCount(1);
});

/** sRGB 상대 휘도 → 대비(WCAG). 색은 'rgb(r, g, b)' 또는 '#rrggbb' */
function contrastRatio(fg: string, bg: string): number {
  const parse = (c: string): [number, number, number] => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    const h = c.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const lum = (c: string) => {
    const [r, g, b] = parse(c).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('지난 공휴일 이름은 흐려지지 않아 대비 4.5:1 을 넘고, 칸에 전체 이름 title 이 있다', async () => {
  // 2026-10-06(화): 월 10/5 개천절 대체공휴일이 지난 칸
  const { app, sidebar } = await launch(FIXTURE_WIKI, '2026-10-06');
  await expect(sidebar.getByTestId('week-track')).toBeVisible();
  const full = await windowByMode(app, 'full');
  for (const page of [sidebar, full]) {
    const cell = page.locator('[data-testid="week-day"][data-date="2026-10-05"]');
    await expect(cell).toHaveAttribute('data-holiday', 'true');
    await expect(cell).toHaveAttribute('title', /개천절 대체공휴일/);
    const style = await cell.evaluate((el) => {
      const name = el.querySelector('.track-holiday') as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        opacity: cs.opacity,
        // 부모 사슬 어디에도 opacity 가 없어야 한다(자식 opacity 로는 되돌릴 수 없다)
        anyOpacity: (() => {
          let e: HTMLElement | null = el as HTMLElement;
          while (e) {
            if (getComputedStyle(e).opacity !== '1') return e.className;
            e = e.parentElement;
          }
          return null;
        })(),
        color: getComputedStyle(name).color,
        text: name.textContent,
      };
    });
    expect(style.opacity).toBe('1');
    expect(style.anyOpacity).toBeNull();
    expect(style.text).toBe('개천절');
    // 빗금의 두 색(#1B2936·#243446) 위에서 모두 4.5:1 이상
    for (const stripe of ['#1b2936', '#243446']) {
      expect(contrastRatio(style.color, stripe), `${style.color} on ${stripe}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('긴 공휴일 이름은 짧은 이름으로 보여 잘리지 않고, title 로 전체 이름을 볼 수 있다', async () => {
  // 2026-06-01(월) 주: 수 6/3 전국동시지방선거
  const { app, sidebar } = await launch(FIXTURE_WIKI, '2026-06-01');
  await expect(sidebar.getByTestId('week-track')).toBeVisible();
  const full = await windowByMode(app, 'full');
  for (const page of [sidebar, full]) {
    const cell = page.locator('[data-testid="week-day"][data-date="2026-06-03"]');
    await expect(cell).toHaveAttribute('title', /전국동시지방선거/);
    const m = await cell.locator('.track-holiday').evaluate((el) => ({
      text: el.textContent,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    expect(m.text).toBe('지방선거');
    expect(m.overflow, '말줄임 없이 다 보여야 한다').toBe(false);
  }
});
