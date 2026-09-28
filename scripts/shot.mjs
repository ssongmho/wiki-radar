#!/usr/bin/env node
// 빌드된 앱(.vite/build)을 띄워 사이드바·풀스크린(항목 선택)·처리 결과 입력·반영 대기 화면 스크린샷을 저장하고 끝낸다.
//
//   node scripts/shot.mjs [--wiki <위키 경로>] [--today YYYY-MM-DD] [--out <폴더>]
//                         [--views sidebar,full,form,queue] [--task <taskId|제목 일부>] [--sample-queue]
//
// --wiki  기본값 test/fixtures/wiki(테스트 사본). 실제 위키를 줘도 shot 은 저장·[위키에 반영]을 누르지 않으므로
//         앱은 읽기만 한다(2단계 앱은 사람이 저장할 때만 쓴다). 대기열·실행 기록은 임시 폴더에 두고, claude 는 가짜로 막아 둔다.
// --today 기본값 없음(실제 오늘). 테스트 사본 정답표는 2026-09-23 기준.
// --out   기본값 test-results/shots. 화면마다 <화면>.png(sidebar·full·form·queue)를 쓴다.
// --views 찍을 화면(쉼표로 구분, 기본 전부). sidebar = 사이드바(맨 아래 상태 줄 포함), full = 풀스크린 상세(위쪽),
//         form = 상세를 '처리 결과 입력'까지 내린 것, queue = 풀스크린 '반영 대기' 화면.
// --task  풀스크린에서 열 항목(ID 또는 제목 일부). 기본은 사이드바의 첫 항목.
// --sample-queue  임시 데이터 폴더에 표본 대기열(queue.json)·실행 기록(reflect-history.json)을 넣고 띄운다.
//         위키에는 쓰지 않는다(표본은 임시 폴더에만 있고 끝나면 지운다). 반영 대기 화면의 목록·결과를 보려고 쓴다.
//
// 패키징된 exe 는 fuse 때문에 Playwright 가 붙지 못하므로 `electron .` 으로 띄운다. 먼저 `npm run package`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';

const { _electron: electron } = playwright;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_MAIN = path.join(ROOT, '.vite', 'build', 'main.js');
const FIXTURE_WIKI = path.join(ROOT, 'test', 'fixtures', 'wiki');
const BUCKETS = ['overdue', 'thisWeek', 'chased', 'stale', 'other'];
const VIEWS = ['sidebar', 'full', 'form', 'queue'];
const WATCHDOG_MS = 120_000;

const USAGE = `쓰기: node scripts/shot.mjs [--wiki <위키 경로>] [--today YYYY-MM-DD] [--out <폴더>]
                          [--views sidebar,full,form,queue] [--task <taskId|제목 일부>] [--sample-queue]
  --wiki          읽을 위키 (기본 test/fixtures/wiki)
  --today         오늘로 칠 날짜 (기본 실제 오늘)
  --out           스크린샷 폴더 (기본 test-results/shots)
  --views         찍을 화면 (기본 sidebar,full,form,queue)
  --task          풀스크린에서 열 항목 ID 또는 제목 일부 (기본 사이드바 첫 항목)
  --sample-queue  임시 데이터 폴더에 표본 대기열·실행 기록을 넣는다 (위키에는 쓰지 않음)`;

function fail(message) {
  console.error(`shot: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    wiki: FIXTURE_WIKI,
    today: undefined,
    out: path.join(ROOT, 'test-results', 'shots'),
    views: [...VIEWS],
    task: undefined,
    sampleQueue: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    let value;
    const eq = key.indexOf('=');
    if (key.startsWith('--') && eq > 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const take = () => {
      if (value !== undefined) return value;
      const next = argv[++i];
      if (next === undefined || next.startsWith('--')) fail(`${key} 뒤에 값이 필요합니다\n${USAGE}`);
      return next;
    };
    if (key === '--help' || key === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (key === '--wiki') opts.wiki = path.resolve(take());
    else if (key === '--today') opts.today = take();
    else if (key === '--out') opts.out = path.resolve(take());
    else if (key === '--views') {
      const list = take()
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const bad = list.filter((v) => !VIEWS.includes(v));
      if (bad.length || list.length === 0) fail(`--views 는 ${VIEWS.join('·')} 중에서 고릅니다: ${bad.join(', ') || '(비어 있음)'}`);
      opts.views = VIEWS.filter((v) => list.includes(v));
    } else if (key === '--task') opts.task = take();
    else if (key === '--sample-queue') opts.sampleQueue = true;
    else fail(`모르는 인자: ${key}\n${USAGE}`);
  }
  if (!fs.existsSync(opts.wiki) || !fs.statSync(opts.wiki).isDirectory()) fail(`위키 폴더가 없습니다: ${opts.wiki}`);
  if (opts.today !== undefined && !isValidDate(opts.today)) fail(`--today 는 YYYY-MM-DD 여야 합니다: ${opts.today}`);
  if (!fs.existsSync(BUILD_MAIN)) fail(`빌드 산출물이 없습니다: ${BUILD_MAIN}\n먼저 \`npm run package\` 를 실행하세요.`);
  // npm start 가 덮어쓴 개발 빌드는 개발 서버 주소를 띄운다 — 서버가 없으면 그 주소의 다른 앱이 뜬다(test/e2e/app.ts 와 같은 검사).
  const dev = /["'`](http:\/\/localhost:\d+)["'`]/.exec(fs.readFileSync(BUILD_MAIN, 'utf8'));
  if (dev) fail(`빌드 산출물이 개발 빌드입니다(${dev[1]} 를 띄움 — \`npm start\` 가 덮어쓴 것). 먼저 \`npm run package\` 로 다시 빌드하세요.`);
  return opts;
}

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function modeOfUrl(url) {
  const m = /[?&#]mode=(sidebar|full)\b/.exec(url);
  return m ? m[1] : undefined;
}

async function windowByMode(app, mode, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = app.windows().find((p) => modeOfUrl(p.url()) === mode);
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    if (app.process().exitCode !== null) {
      throw new Error(
        `앱이 ${mode} 창을 띄우기 전에 끝났습니다(exit ${app.process().exitCode}). ` +
          '시작 로그(main 콘솔)를 확인하세요 — 빌드가 깨졌거나 main 에서 예외가 났을 수 있습니다.',
      );
    }
    if (Date.now() > deadline) throw new Error(`mode=${mode} 창을 찾지 못했습니다`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function windowVisibility(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const out = {};
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const m = /[?&#]mode=(sidebar|full)\b/.exec(w.webContents.getURL());
      if (m) out[m[1]] = w.isVisible();
    }
    return out;
  });
}

async function waitUntilVisible(app, mode, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await windowVisibility(app))[mode]) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${mode} 창이 ${timeoutMs}ms 안에 보이지 않았습니다`);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(300);
}

async function closeApp(app, timeoutMs = 10_000) {
  const proc = app.process();
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([app.close().catch(() => undefined), timedOut]);
  clearTimeout(timer);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
}

async function readCounts(page) {
  const counts = {};
  for (const bucket of BUCKETS) {
    const el = page.locator(`[data-testid="bucket-${bucket}"]`).first();
    if (await el.count()) counts[bucket] = await el.getAttribute('data-count');
  }
  return counts;
}

/**
 * 반영 대기 화면을 보여주기 위한 표본(임시 데이터 폴더에만 쓴다). 형식은 src/main/queue.ts·reflect.ts 가 읽는 JSON 배열.
 * 실제 할 일과 이어지지 않는 설명용 항목이다 — 위키 파일은 건드리지 않는다.
 */
function writeSampleQueue(dataDir, today) {
  // 로컬 날짜(toISOString 은 UTC 라 오전 9시 전에는 하루 밀린다)
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = today ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const at = (hhmm) => new Date(`${day}T${hhmm}:00`).toISOString();
  const queue = [
    {
      id: 'sample-q1',
      kind: 'task',
      createdAt: at('09:12'),
      taskId: 'i:sample00001',
      title: '한결케미칼 통영공장 사용량 미반영 회신',
      status: 'done',
      note: '9/22 집계 배치 재실행으로 8월분 반영 확인\n고객 담당자에게 회신 완료',
      company: '한결케미칼',
      file: 'wiki/entities/한결케미칼.md',
    },
    {
      id: 'sample-q2',
      kind: 'task',
      createdAt: at('09:40'),
      taskId: 'i:sample00002',
      title: '견적 양식 개정안 검토',
      status: 'notmine',
      owner: '박담당',
      note: '영업지원팀으로 이관',
      src: '_private/mgmt/내 할 일.md',
    },
  ];
  const history = [
    {
      id: 'sample-run1',
      startedAt: at('08:30'),
      finishedAt: at('08:33'),
      state: 'done',
      itemIds: ['sample-q0'],
      summary: '한결케미칼 페이지에 8월 사용량 반영 이력을 더하고 log.md 에 남겼다.',
      changed: ['wiki/entities/한결케미칼.md', 'log.md'],
      skipped: [{ title: '회의록 정리', reason: '관련 topic 페이지를 찾지 못함' }],
      log: ['시작: 대기 항목 2건을 claude 로 반영합니다', '종료: 코드 0 · 2분 41초', '결과: 바뀐 파일 2개 · 건너뜀 1건'],
    },
  ];
  fs.writeFileSync(path.join(dataDir, 'queue.json'), `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, 'reflect-history.json'), `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

/** --task 로 고른 사이드바 줄(ID 가 같거나 제목에 그 글이 든 첫 줄). 없으면 null */
async function findRow(sidebar, want) {
  const rows = sidebar.getByTestId('task-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const id = await row.getAttribute('data-task-id');
    const text = (await row.innerText()).replace(/\s+/g, ' ');
    if (id === want || text.includes(want)) return row;
  }
  return null;
}

async function textOfFirst(page, testId) {
  const el = page.getByTestId(testId);
  return (await el.count()) ? (await el.first().innerText()).replace(/\s+/g, ' ').trim() : undefined;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  const wants = (v) => opts.views.includes(v);

  const env = { ...process.env, WIKI_RADAR_WIKI: opts.wiki };
  if (opts.today) env.WIKI_RADAR_TODAY = opts.today;
  else delete env.WIKI_RADAR_TODAY;
  delete env.ELECTRON_RUN_AS_NODE;
  // 임시 사용자 데이터 폴더: 떠 있는 실제 앱과 한 번만 실행 잠금이 부딪히지 않고, 실제 사용자 데이터도 건드리지 않는다.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-shot-'));
  env.WIKI_RADAR_USER_DATA = userDataDir;
  // 2단계: 대기열(queue.json)·실행 기록도 임시 폴더에. 물려받은 WIKI_RADAR_DATA 가 실제 폴더를 가리켜도 덮어쓴다.
  env.WIKI_RADAR_DATA = userDataDir;
  // claude 는 가짜(실패만 하는 모드)로 막아 둔다 — 스크린샷 도구가 진짜 claude 를 부를 일은 없다.
  env.WIKI_RADAR_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
  env.FAKE_CLAUDE_MODE = 'fail';
  const removeUserData = () => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 임시 폴더라 남아도 괜찮다
    }
  };
  if (opts.sampleQueue) writeSampleQueue(userDataDir, opts.today);

  let app;
  try {
    app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30_000 });
  } catch (err) {
    removeUserData();
    throw err;
  }
  const watchdog = setTimeout(() => {
    console.error(`shot: ${WATCHDOG_MS / 1000}초 안에 끝나지 않아 앱을 강제로 끝냅니다`);
    app.process().kill();
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();

  const consoleErrors = [];
  const attach = (page) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${modeOfUrl(page.url()) ?? page.url()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`[${modeOfUrl(page.url()) ?? page.url()}] ${err.message}`));
  };
  app.windows().forEach(attach);
  app.on('window', attach);

  const written = [];
  try {
    // 사이드바: 스냅샷이 오거나(트랙) 오류 문구가 뜰 때까지
    const sidebar = await windowByMode(app, 'sidebar');
    await sidebar
      .locator('[data-testid="week-track"], [data-testid="snapshot-error"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await settle(sidebar);
    if (wants('sidebar')) {
      const p = path.join(opts.out, 'sidebar.png');
      await sidebar.screenshot({ path: p });
      written.push(['사이드바', p]);
    }

    const errorText = await textOfFirst(sidebar, 'snapshot-error');
    const queueLineText = await textOfFirst(sidebar, 'sidebar-queue');
    const staleText = await textOfFirst(sidebar, 'bucket-stale');

    let detailTitle;
    let selected;
    let counts = {};
    if (wants('full') || wants('form') || wants('queue')) {
      // 풀스크린: 고른 항목(없으면 첫 항목)을 눌러 연다(항목이 없으면 풀스크린 전환 버튼)
      const describeRow = async (row) => ({
        id: await row.getAttribute('data-task-id'),
        bucket: await row.getAttribute('data-bucket'),
        text: (await row.innerText()).replace(/\s+/g, ' ').trim(),
      });
      let row = null;
      // 사이드바는 정리 대상·기타를 한 줄 요약으로 접어 두므로, 거기 없으면 풀스크린 목록(기타 펼침)에서 찾는다
      let lookInFull = false;
      if (opts.task) {
        row = await findRow(sidebar, opts.task);
        lookInFull = !row;
      }
      if (!row && !lookInFull && (await sidebar.getByTestId('task-row').count())) row = sidebar.getByTestId('task-row').first();
      if (row) {
        selected = await describeRow(row);
        await row.click();
      } else {
        await sidebar.getByTestId('btn-full').click();
      }
      await waitUntilVisible(app, 'full');
      const full = await windowByMode(app, 'full');
      await full.getByTestId('full').waitFor({ state: 'visible', timeout: 15_000 });
      if (lookInFull) {
        await full.getByTestId('task-row').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
        let fullRow = await findRow(full, opts.task);
        const otherToggle = full.locator('[data-testid="bucket-other"] button[aria-expanded="false"]');
        if (!fullRow && (await otherToggle.count())) {
          await otherToggle.first().click();
          fullRow = await findRow(full, opts.task);
        }
        if (!fullRow) {
          console.warn(`shot: --task '${opts.task}' 에 맞는 할 일이 없어 첫 항목을 엽니다`);
          if (await full.getByTestId('task-row').count()) fullRow = full.getByTestId('task-row').first();
        }
        if (fullRow) {
          selected = await describeRow(fullRow);
          await fullRow.click();
        }
      }
      if (selected) {
        await full.getByTestId('detail-title').waitFor({ state: 'visible', timeout: 15_000 });
        // 원 메일이 있는 항목이면 요약이 올 때까지 조금 기다린다(없으면 그냥 넘어간다)
        await full
          .getByTestId('mail-subject')
          .waitFor({ state: 'visible', timeout: 3_000 })
          .catch(() => undefined);
      }
      await settle(full);
      if (wants('full')) {
        const p = path.join(opts.out, 'full.png');
        await full.screenshot({ path: p });
        written.push(['풀스크린', p]);
      }
      if (selected) detailTitle = (await full.getByTestId('detail-title').innerText()).trim();
      counts = await readCounts(full);

      if (wants('form') && selected) {
        // 상세 열을 '처리 결과 입력'이 보이도록 내린다(저장은 누르지 않는다)
        const form = full.locator('form.result-form');
        if (await form.count()) {
          await form.first().scrollIntoViewIfNeeded();
          await full.waitForTimeout(200);
          const p = path.join(opts.out, 'form.png');
          await full.screenshot({ path: p });
          written.push(['처리 결과 입력', p]);
        } else {
          console.warn('shot: 상세에 처리 결과 입력이 없어 form.png 를 찍지 않았습니다');
        }
      }

      if (wants('queue')) {
        await full.getByTestId('nav-queue').click();
        await full.getByTestId('queue-list').waitFor({ state: 'visible', timeout: 15_000 });
        await full
          .getByTestId('reflect-result')
          .waitFor({ state: 'visible', timeout: 3_000 })
          .catch(() => undefined);
        await settle(full);
        const p = path.join(opts.out, 'queue.png');
        await full.screenshot({ path: p });
        written.push(['반영 대기', p]);
      }
    }

    console.log(`위키: ${opts.wiki}`);
    console.log(`오늘: ${opts.today ?? '(실제 오늘)'}`);
    for (const [label, p] of written) console.log(`${label}: ${p}`);
    if (detailTitle) console.log(`선택: ${detailTitle}`);
    if (selected) console.log(`선택 항목: ${selected.id} [${selected.bucket}]`);
    if (Object.keys(counts).length) console.log(`구간 수: ${BUCKETS.map((b) => `${b}=${counts[b] ?? '-'}`).join(' ')}`);
    if (staleText) console.log(`사이드바 정리 대상 구간: ${staleText}`);
    if (queueLineText) console.log(`사이드바 상태 줄: ${queueLineText}`);
    if (errorText) console.log(`오류 문구: ${errorText}`);
    if (consoleErrors.length) {
      console.error(`콘솔 에러 ${consoleErrors.length}건:`);
      for (const line of consoleErrors.slice(0, 20)) console.error(`  ${line}`);
    } else {
      console.log('콘솔 에러: 없음');
    }
  } finally {
    clearTimeout(watchdog);
    await closeApp(app);
    removeUserData();
  }
}

main().catch((err) => {
  console.error(`shot: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
