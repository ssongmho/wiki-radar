#!/usr/bin/env node
// 빌드된 앱(.vite/build)을 띄워 사이드바·풀스크린(항목 선택)·처리 결과 입력·반영 대기·회신 작성·VOC 화면 스크린샷을 저장하고 끝낸다.
//
//   node scripts/shot.mjs [--wiki <위키 경로>] [--today YYYY-MM-DD] [--out <폴더>]
//                         [--views sidebar,full,form,queue,reply,voc,voc-task,voc-login,mailbox,mailbox-reply,mailbox-voc,mail-wiki,search,changes,changes-team,settings]
//                         [--task <taskId|제목 일부>] [--sample-queue] [--sample-mail] [--sample-changes] [--sample-settings] [--team]
//                         [--voc-mode ok|login|expired|offline|slow|fail-write]
//
// --wiki  기본값 test/fixtures/wiki(테스트 사본). 테스트 사본(그 안의 폴더 포함)이면 임시 폴더에 복사해 그 복사본을 띄운다 —
//         원본은 어떤 경우에도 바뀌지 않는다(끝나면 복사본을 지운다). 실제 위키를 줘도 shot 은 저장·[위키에 반영]·[보내기]를
//         누르지 않으므로 앱은 읽기만 한다(2단계 앱은 사람이 저장할 때만 쓴다). 대기열·실행 기록은 임시 폴더에 두고, claude 는 가짜로 막아 둔다.
// --today 기본값 없음(실제 오늘). 테스트 사본 정답표는 2026-09-23 기준.
// --out   기본값 test-results/shots. 화면마다 <화면>.png(sidebar·full·form·queue·reply·voc·voc-task·voc-login)를 쓴다. reply 는 작성 칸 아래쪽
//         (원문 인용·보내는 사람·서명 펼침·[보내고 저장])을 reply-send.png 로, voc·voc-task 는 상세 아래쪽 동작
//         (담당·일정 바꾸기 / 답변·상태)을 voc-actions.png·voc-task-actions.png 로 한 장씩 더 쓴다. voc 는 나의 칸 티켓의
//         첨부·작업시간(V4 — 읽기만)을 voc-work.png, 해결·고객 메일 버튼을 voc-finish.png 로도 찍는다.
// --views 찍을 화면(쉼표로 구분, 기본 voc-login 밖 전부). sidebar = 사이드바(맨 아래 상태 줄 포함), full = 풀스크린 상세(위쪽),
//         form = 상세를 '처리 결과 입력'까지 내린 것, queue = 풀스크린 '반영 대기' 화면,
//         reply = 메일 할 일의 '회신 메일 보내기'를 켜고 가짜 초안을 만든 작성 칸(2.5단계). 보내기는 누르지 않는다.
//         voc = 풀스크린 'VOC' 화면(2.6단계)에서 미배정 칸을 고르고 첫 티켓 상세를 연 것. 쓰기 버튼은 누르지 않는다.
//         voc-task = 내 담당 VOC 할 일 상세의 'VOC 처리'(답변·상태). 답변은 넣지도 보내지도 않는다.
//         voc-login = 로그인 필요 상태의 VOC 화면에서 로그인 대화상자(명세 §13)를 연 것(기본 목록에는 없다 — 따로 고른다).
//         임시 데이터 폴더의 VOC 설정에 가짜 아이디(hong)를 기억해 둔 채 띄워 '아이디 기억' 모습을 찍는다. 비밀번호는 넣지 않고
//         [로그인]도 누르지 않는다. --voc-mode 를 주지 않으면 이 화면을 고를 때 가짜 voc-cli 는 login 동작이다.
//         mailbox = 풀스크린 「메일」(2.10단계) 목록 + 한결케미칼 스레드 읽기. mailbox-reply = 메일함 회신 화면(대륙물산 메일 —
//         핵심 칸을 채우고 가짜 초안을 만든 뒤, 보내지 않는다). mailbox-voc = 메일함 VOC 등록 화면(가짜 voc-cli — 등록은 누르지 않는다).
//         mailbox-reply·mailbox-voc 는 기본 목록에 없다(고를 때만). 메일을 읽으면 읽음 표시가 임시 데이터 폴더(mail-state.json)에만 남는다.
// --task  풀스크린에서 열 항목(ID 또는 제목 일부). 기본은 사이드바의 첫 항목. reply 는 이 항목이 메일 할 일이면 그것,
//         아니면 원본 메일이 있는 첫 할 일을 연다.
// --sample-queue  임시 데이터 폴더에 표본 대기열(queue.json)·실행 기록(reflect-history.json)을 넣고 띄운다.
//         위키에는 쓰지 않는다(표본은 임시 폴더에만 있고 끝나면 지운다). 반영 대기 화면의 목록·결과를 보려고 쓴다.
// --sample-mail  임시 데이터 폴더에 표본 메일 상태(mail-state.json — 기준선 = 오늘 0시 − 72시간, 회신 필요 1통)를 넣는다.
//         raw/mail 에는 쓰지 않는다. 사이드바 메일 블록·내비 배지·메일함 칩이 보이게 하려고 쓴다(시험 시계는 쓰지 않는다).
//         --sample-mail 없이 --today 만 주면 기준선(그날 0시 − 72시간)만 넣는다. sidebar.png 는 메일 색인이 끝난 뒤 찍는다.
// 위키(3a단계 §14-4): search = 풀스크린 「검색」에서 "인벤토리"를 찾아 첫 결과 미리보기. changes = 「변경」 개인 탭 첫 줄 미리보기.
//         changes-team = 「변경」 팀 탭(--team 일 때 — --views 를 주지 않으면 --team 이 기본 목록에 더한다). 사이드바 사진에는 「변경 N」이 보인다.
// --sample-changes  임시 데이터 폴더에 표본 읽음 기록(wiki-seen.json — 기준선 + 테스트 사본 문서 둘의 해시를 옛 값으로, 없는 경로 하나는
//         「지움」)과 변경 기준 내용(wiki-change-base.json — 그 둘의 옛 본문)을 넣는다. 기준선은 앱을 한 번 띄워 색인한 뒤 그 기록을 고쳐 만든다
//         (앱이 두 번 뜬다). 위키에는 쓰지 않는다 — 테스트 사본은 지금처럼 임시 복사본으로 띄운다.
// --team  임시 NAS·사본 폴더에 test/fixtures/team-wiki 를 복사해 팀 위키 동기화를 켜고 띄운다(e2e 하네스와 같은 방식 — 실제 NAS 를 쓰지 않는다).
// 설정(2.13단계 §F-5): settings = 풀스크린 「설정」의 칸마다 settings-<칸>.png(check·wiki·mailIn·mailOut·ai·voc·info). 기본 목록에는 없다(--views settings).
//         [저장]은 누르지 않는다. 회신 계정(SMTP)은 아래의 가짜 SMTP 환경 변수로 정해져 메일 보내기 칸은 「환경 변수로 정해짐」 잠금으로 보인다.
// --sample-settings  임시 팀 설정 파일(WIKI_RADAR_TEAM_SETTINGS — 서버는 모두 127.0.0.1, 가짜 값)과 임시 데이터 폴더의 내 값 일부(app-settings.json)를
//         넣고, 127.0.0.1 의 가짜 POP3·가짜 로컬 LLM(test/fixtures/fake-*-server.mjs)을 띄워 메일 받기·AI 칸은 [연결 시험] 결과까지 찍는다
//         (메일 받기 비밀번호는 저장하지 않고 칸의 초안으로만 넣는다). 물려받은 WIKI_RADAR_POP3_*·LLM_*·TEAM_SETTINGS·UPDATE_URL·SERVER_LLM_API_KEY 는 늘 지운다.
//
// 메일: 물려받은 SMTP 설정(WIKI_RADAR_SMTP_*)은 지우고 127.0.0.1 의 가짜 SMTP 서버(끝나면 닫는다)를 계정으로 준다 —
// 회신 칸이 '계정 준비' 상태로 보이고, 실제 메일 계정·서버는 읽지도 부르지도 않는다. 시험 가드(WIKI_RADAR_TEST_MODE=1)도 켠다.
// VOC: voc-cli 는 언제나 가짜(test/fixtures/fake-voc-cli.mjs, 자료는 test/fixtures/voc 의 임시 복사본 — 끝나면 지운다).
// 물려받은 WIKI_RADAR_VOC_*·FAKE_VOC_* 는 지운다 — 실제 voc-cli(jar)·운영 VOC 는 부르지 않는다(시험 가드도 .mjs 가 아니면 막는다).
// --voc-mode 는 가짜의 동작(기본 ok). 띄운 뒤 VOC 를 한 번 받아 두고 찍는다 — 사이드바·목록에 내 담당 VOC 할 일이 섞여 보인다.
//
// 패키징된 exe 는 fuse 때문에 Playwright 가 붙지 못하므로 `electron .` 으로 띄운다. 먼저 `npm run package`.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';
import smtpServer from 'smtp-server';

const { _electron: electron } = playwright;
const { SMTPServer } = smtpServer;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_MAIN = path.join(ROOT, '.vite', 'build', 'main.js');
const FIXTURE_WIKI = path.join(ROOT, 'test', 'fixtures', 'wiki');
/** 가짜 voc-cli 와 그 자료(test/e2e/app.ts 와 같다) */
const FAKE_VOC_CLI = path.join(ROOT, 'test', 'fixtures', 'fake-voc-cli.mjs');
const FIXTURE_VOC = path.join(ROOT, 'test', 'fixtures', 'voc');
const VOC_MODES = ['ok', 'login', 'expired', 'offline', 'slow', 'fail-write'];
const BUCKETS = ['overdue', 'thisWeek', 'chased', 'stale', 'other'];
const VIEWS = [
  'sidebar',
  'full',
  'form',
  'queue',
  'reply',
  'voc',
  'voc-task',
  'voc-login',
  'mailbox',
  'mailbox-reply',
  'mailbox-voc',
  'mail-wiki',
  'search',
  'changes',
  'changes-team',
  'settings',
];
/** 기본으로 찍는 화면(voc-login 은 로그인 필요 상태가 따로 있어야 해서, 메일함 회신·VOC 등록은 고를 때만, 팀 변경은 --team 일 때만) */
const DEFAULT_VIEWS = VIEWS.filter((v) => !['voc-login', 'mailbox-reply', 'mailbox-voc', 'mail-wiki', 'changes-team', 'settings'].includes(v));
/** settings 화면에서 찍을 칸(순서대로) */
const SETTINGS_SHOTS = ['check', 'wiki', 'mailIn', 'mailOut', 'ai', 'voc', 'info'];
/** --sample-settings 의 가짜 POP3 비밀번호(가짜 서버 안에서만 쓴다 — 저장하지 않는다) */
const SAMPLE_POP3_PASS = 'shot-pop3-pass';
/** 팀 위키 시험 사본(test/e2e/app.ts 와 같다) — --team 은 이것을 임시 NAS 폴더에 복사한다 */
const FIXTURE_TEAM_WIKI = path.join(ROOT, 'test', 'fixtures', 'team-wiki');
/** search 화면의 질의 */
const SAMPLE_WIKI_QUERY = '인벤토리';
/** --sample-changes 가 「바뀜」으로 보이게 할 개인 문서 둘·「지움」으로 보이게 할 없는 경로·팀 문서 하나 */
const SAMPLE_CHANGED = ['wiki/entities/한결케미칼.md', 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md'];
const SAMPLE_DELETED = 'wiki/entities/옛 거래처.md';
const SAMPLE_TEAM_CHANGED = '회의록/2026-09-22 주간회의.md';
/** 표본 메일 상태(--sample-mail)의 회신 필요 메일 — 테스트 사본 대륙물산 메일의 Message-ID */
const SAMPLE_REPLY_NEEDED_ID = 'dr-1@daeryuk.example';
/** 메일함 화면에서 열 스레드(테스트 사본의 제목 일부) */
const SAMPLE_MAIL_THREAD = '통영공장 CMS 인벤토리';
const SAMPLE_MAIL_REPLY = '자재 단가 문의';
const SAMPLE_MAIL_NOTE = '단가표는 다음 주 화요일에 보내 드린다';
/** 로그인 화면에서 기억해 둔 것으로 보일 가짜 아이디(test/fixtures/voc/whoami.txt 와 같다) */
const SAMPLE_LOGIN_ID = 'hong';
/** 가짜 SMTP 계정(test/e2e/app.ts 와 같다). 사용자 이름이 보내는 주소가 된다 */
const FAKE_SMTP_USER = 'radar@example.com';
const FAKE_SMTP_PASS = 'secret';
/** reply 화면에서 처리 내용 칸에 넣는 표본(가짜 초안이 이것을 담는다). 저장하지 않는다 */
const SAMPLE_NOTE = '9/22 집계 배치 재실행으로 8월분 사용량 반영을 확인함';
const WATCHDOG_MS = 120_000;

const USAGE = `쓰기: node scripts/shot.mjs [--wiki <위키 경로>] [--today YYYY-MM-DD] [--out <폴더>]
                          [--views sidebar,full,form,queue,reply,voc,voc-task,voc-login,mailbox,mailbox-reply,mailbox-voc,mail-wiki,search,changes,changes-team,settings]
                          [--task <taskId|제목 일부>] [--sample-queue] [--sample-mail] [--sample-changes] [--sample-settings] [--team]
                          [--voc-mode ok|login|expired|offline|slow|fail-write]
  --wiki          읽을 위키 (기본 test/fixtures/wiki)
  --today         오늘로 칠 날짜 (기본 실제 오늘)
  --out           스크린샷 폴더 (기본 test-results/shots)
  --views         찍을 화면 (기본 sidebar,full,form,queue,reply,voc,voc-task,mailbox,search,changes — voc-login·mailbox-reply·mailbox-voc·settings 는
                  고를 때만, changes-team 은 --team 일 때)
  --task          풀스크린에서 열 항목 ID 또는 제목 일부 (기본 사이드바 첫 항목)
  --sample-queue  임시 데이터 폴더에 표본 대기열·실행 기록을 넣는다 (위키에는 쓰지 않음)
  --sample-mail   임시 데이터 폴더에 표본 메일 상태(기준선·회신 필요 1통)를 넣는다 (raw/mail 에는 쓰지 않음)
  --sample-changes 임시 데이터 폴더에 표본 위키 읽음 기록·변경 기준 내용을 넣는다 (위키에는 쓰지 않음 — 앱이 두 번 뜬다)
  --sample-settings 임시 팀 설정 파일·내 값 일부 + 가짜 POP3·로컬 LLM(127.0.0.1)으로 설정 칸의 연결 시험까지 찍는다(--views settings 와 함께)
  --team          임시 NAS·사본 폴더에 팀 위키 시험 사본을 복사해 팀 위키 동기화를 켜고 띄운다 (실제 NAS 는 쓰지 않음)
  --voc-mode      가짜 voc-cli 의 동작 (기본 ok, voc-login 을 고르면 login — 실제 voc-cli 는 부르지 않는다)`;

function fail(message) {
  console.error(`shot: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    wiki: FIXTURE_WIKI,
    today: undefined,
    out: path.join(ROOT, 'test-results', 'shots'),
    views: [...DEFAULT_VIEWS],
    task: undefined,
    sampleQueue: false,
    sampleMail: false,
    sampleChanges: false,
    sampleSettings: false,
    team: false,
    vocMode: undefined,
  };
  let viewsGiven = false;
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
      viewsGiven = true;
    } else if (key === '--task') opts.task = take();
    else if (key === '--sample-queue') opts.sampleQueue = true;
    else if (key === '--sample-mail') opts.sampleMail = true;
    else if (key === '--sample-changes') opts.sampleChanges = true;
    else if (key === '--sample-settings') opts.sampleSettings = true;
    else if (key === '--team') opts.team = true;
    else if (key === '--voc-mode') {
      opts.vocMode = take();
      if (!VOC_MODES.includes(opts.vocMode)) fail(`--voc-mode 는 ${VOC_MODES.join('·')} 중에서 고릅니다: ${opts.vocMode}`);
    } else fail(`모르는 인자: ${key}\n${USAGE}`);
  }
  // --team 이면 팀 변경 화면도 기본으로 찍는다. 팀 없이 changes-team 을 고르면 찍을 수 없다
  if (opts.team && !viewsGiven) opts.views = VIEWS.filter((v) => opts.views.includes(v) || v === 'changes-team');
  if (!opts.team && opts.views.includes('changes-team')) fail('changes-team 은 --team 과 함께 씁니다');
  if (opts.sampleSettings && !opts.views.includes('settings')) fail('--sample-settings 는 --views settings 와 함께 씁니다');
  // voc-login 은 로그인 필요 상태의 화면이다 — 동작을 주지 않았으면 가짜 voc-cli 를 login 으로
  opts.vocMode ??= opts.views.includes('voc-login') ? 'login' : 'ok';
  if (!fs.existsSync(opts.wiki) || !fs.statSync(opts.wiki).isDirectory()) fail(`위키 폴더가 없습니다: ${opts.wiki}`);
  if (opts.today !== undefined && !isValidDate(opts.today)) fail(`--today 는 YYYY-MM-DD 여야 합니다: ${opts.today}`);
  if (!fs.existsSync(BUILD_MAIN)) fail(`빌드 산출물이 없습니다: ${BUILD_MAIN}\n먼저 \`npm run package\` 를 실행하세요.`);
  // npm start 가 덮어쓴 개발 빌드는 개발 서버 주소를 띄운다 — 서버가 없으면 그 주소의 다른 앱이 뜬다(test/e2e/app.ts 와 같은 검사).
  const dev = /["'`](http:\/\/localhost:\d+)["'`]/.exec(fs.readFileSync(BUILD_MAIN, 'utf8'));
  if (dev) fail(`빌드 산출물이 개발 빌드입니다(${dev[1]} 를 띄움 — \`npm start\` 가 덮어쓴 것). 먼저 \`npm run package\` 로 다시 빌드하세요.`);
  return opts;
}

/** child 가 parent 자신이거나 그 안에 있는가(Windows 는 대소문자 무시) — test/e2e/app.ts isInside 와 같다 */
function isInside(parent, child) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 띄울 위키. 테스트 사본(test/fixtures/wiki)이면 임시 폴더에 복사한 것을 준다 — 스크린샷 도구가 원본 사본을 바꿀 길을 막는다.
 * 그 밖의 위키는 그대로(읽기만 한다). remove 는 복사본을 지운다(복사하지 않았으면 아무것도 하지 않는다).
 */
function prepareWiki(wiki) {
  if (!isInside(FIXTURE_WIKI, wiki)) return { root: wiki, remove: () => undefined };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-shot-wiki-'));
  const root = path.join(base, 'wiki');
  fs.cpSync(FIXTURE_WIKI, root, { recursive: true });
  // 테스트 사본 안의 폴더를 줬으면 복사본에서도 같은 자리
  const sub = path.relative(FIXTURE_WIKI, wiki);
  return {
    root: sub ? path.join(root, sub) : root,
    remove: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // 임시 폴더라 남아도 괜찮다
      }
    },
  };
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
    // 2.14: 메일함에서 [위키에 반영]으로 넣은 메일(테스트 사본의 한결케미칼 스레드 — 키는 Message-ID 로 계산)
    {
      id: 'sample-q3',
      kind: 'mail',
      createdAt: at('10:05'),
      title: '통영공장 CMS 인벤토리 사용량 확인 요청',
      note: '9월 사용량 0 표시 건과 월말 보고 일정만',
      mail: 'raw/mail/한결케미칼/2026/2026-09-22_1442_EHS팀_RE RE 통영공장 CMS 인벤토리 사용량 확인 요청_c7d8e9.md',
      mailKey: `m:${createHash('sha1').update('fixture-0003@hangyeol.example').digest('hex').slice(0, 16)}`,
      scope: 'thread',
      hint: '한결케미칼',
      from: '한결케미칼 EHS팀 <ehs@hangyeol.example>',
      mailDate: '2026-09-22T14:42:30+09:00',
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

/**
 * 메일함 표본 상태(2.10단계 §14-4 — 임시 데이터 폴더에만 쓴다): 기준선 = 오늘 0시(로컬) − 72시간, 대륙물산 메일 하나를 회신 필요로.
 * 키는 src/main/wiki/mailIndex.ts mailKeyOf 와 같다(m: + sha1(소문자 Message-ID) 앞 16자).
 */
function writeSampleMailState(dataDir, today, { replyNeeded = true } = {}) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = today ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const midnight = new Date(`${day}T00:00:00`);
  const baselineAt = new Date(midnight.getTime() - 72 * 3600_000).toISOString();
  const key = `m:${createHash('sha1').update(SAMPLE_REPLY_NEEDED_ID.toLowerCase(), 'utf8').digest('hex').slice(0, 16)}`;
  const state = { version: 1, baselineAt, mails: replyNeeded ? { [key]: { replyNeeded: midnight.toISOString() } } : {} };
  fs.writeFileSync(path.join(dataDir, 'mail-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 사이드바 메일 블록이 보일 수 있게 메일함 색인이 끝나기를(ready·noMailDir·noWiki·error) 기다린다 — 색인 중이면 블록이 숨어 있다.
 * 메일함이 없는 빌드면 null, 한도 안에 끝나지 않으면 마지막 상태
 */
async function waitMailboxIndexed(sidebar, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let state = null;
  for (;;) {
    state = await sidebar
      .evaluate(() => (typeof window.radar.getMailbox === 'function' ? window.radar.getMailbox().then((s) => s.state) : null))
      .catch(() => null);
    if (state === null || state !== 'indexing' || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (state === 'indexing') console.warn(`shot: 메일 색인이 ${timeoutMs / 1000}초 안에 끝나지 않아 사이드바 메일 블록 없이 찍습니다`);
  if (state === 'ready') {
    // 요약이 사이드바에 그려질 때까지 잠깐
    await sidebar.getByTestId('sidebar-mail').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  }
  return state;
}

/** 메일함 화면을 열고 색인이 끝나기를 기다린다. 메일함이 없는 빌드면 null */
async function openMailbox(full) {
  const nav = full.getByTestId('nav-mail');
  if (!(await nav.count())) {
    console.warn('shot: 내비에 메일이 없어 메일함 화면을 찍지 않았습니다(2.10단계 화면이 없는 빌드)');
    return null;
  }
  await nav.first().click();
  const view = full.getByTestId('mailbox-view');
  await view.waitFor({ state: 'visible', timeout: 15_000 });
  await full
    .locator('[data-testid="mailbox-view"][data-state="ready"], [data-testid="mailbox-view"][data-state="error"], [data-testid="mailbox-unavailable"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => undefined);
  if (await full.getByTestId('mailbox-unavailable').count()) {
    console.warn('shot: 메일함을 쓸 수 없는 위키입니다(raw/mail 없음 등) — 안내 화면을 찍습니다');
    return view;
  }
  await full.getByTestId('mail-thread-row').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  return view;
}

/** 목록에서 제목에 그 글이 든 스레드를 고르고 본문이 올 때까지 기다린다. 없으면 첫 스레드 */
async function pickMailThread(full, want) {
  const rows = full.getByTestId('mail-thread-row');
  const n = await rows.count();
  let target = null;
  for (let i = 0; i < n; i++) {
    const text = (await rows.nth(i).innerText()).replace(/\s+/g, ' ');
    if (text.includes(want)) {
      target = rows.nth(i);
      break;
    }
  }
  if (!target && n > 0) target = rows.first();
  if (!target) return null;
  await target.click();
  await full.getByTestId('mail-body').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  return (await target.getAttribute('data-thread-id')) ?? null;
}

/** mailbox 화면: 목록 + 한결케미칼 스레드 읽기. 찍었으면 요약 */
async function shootMailbox(full, opts, written) {
  const view = await openMailbox(full);
  if (!view) return undefined;
  const threadId = await pickMailThread(full, SAMPLE_MAIL_THREAD);
  await settle(full);
  const p = path.join(opts.out, 'mailbox.png');
  await full.screenshot({ path: p });
  written.push(['메일함', p]);
  return {
    state: (await view.getAttribute('data-state')) ?? '(모름)',
    rows: await full.getByTestId('mail-thread-row').count(),
    threadId,
    unread: (await full.getByTestId('nav-mail').first().getAttribute('data-count').catch(() => null)) ?? '-',
  };
}

/** mail-wiki 화면(2.14 §12-4): 한결케미칼 스레드 [위키에 반영] 폼을 연 읽기 칸. 넣지 않는다 */
async function shootMailWiki(full, opts, written) {
  const view = await openMailbox(full);
  if (!view) return undefined;
  await pickMailThread(full, SAMPLE_MAIL_THREAD);
  const btn = full.getByTestId('btn-mail-wiki');
  if (!(await btn.count()) || !(await btn.isEnabled())) {
    const why = (await btn.getAttribute('data-blocked-reason').catch(() => null)) ?? '버튼 없음';
    console.warn(`shot: [위키에 반영]을 누를 수 없어 mail-wiki.png 를 찍지 않았습니다(${why})`);
    return undefined;
  }
  await btn.click();
  const form = full.getByTestId('mail-wiki-form');
  await form.waitFor({ state: 'visible', timeout: 10_000 });
  await full.getByTestId('mail-wiki-note').fill('9월 사용량 0 표시 건과 월말 보고 일정만').catch(() => undefined);
  await full.getByTestId('mail-wiki-hint').fill('한결케미칼').catch(() => undefined);
  await form.scrollIntoViewIfNeeded().catch(() => undefined);
  await settle(full);
  const p = path.join(opts.out, 'mail-wiki.png');
  await full.screenshot({ path: p });
  written.push(['메일 → 위키에 반영 폼', p]);
  return { state: (await btn.getAttribute('data-wiki-state').catch(() => null)) ?? '(모름)' };
}

/** mailbox-reply 화면: 대륙물산 메일 [회신] → 핵심 칸 → 가짜 초안. 보내지 않는다 */
async function shootMailboxReply(full, opts, written) {
  const view = await openMailbox(full);
  if (!view) return undefined;
  await pickMailThread(full, SAMPLE_MAIL_REPLY);
  const btn = full.getByTestId('btn-mail-reply');
  if (!(await btn.count()) || !(await btn.isEnabled())) {
    const why = (await btn.getAttribute('data-blocked-reason').catch(() => null)) ?? '버튼 없음';
    console.warn(`shot: [회신]을 누를 수 없어 mailbox-reply.png 를 찍지 않았습니다(${why})`);
    return undefined;
  }
  await btn.click();
  await full.getByTestId('mail-reply-view').waitFor({ state: 'visible', timeout: 15_000 });
  await full.locator('[data-testid="reply-panel"][data-ready="true"]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  await full.getByTestId('mail-reply-note').fill(SAMPLE_MAIL_NOTE).catch(() => undefined);
  let draft = '(만들지 않음)';
  const draftButton = full.getByTestId('btn-draft');
  if ((await draftButton.count()) && (await draftButton.isEnabled())) {
    await draftButton.click();
    await full
      .locator('[data-testid="draft-status"][data-state="done"], [data-testid="draft-status"][data-state="failed"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
    draft = (await full.getByTestId('draft-status').first().getAttribute('data-state').catch(() => null)) ?? '(모름)';
  }
  // 본문 교체 확인이 뜨면(이미 적힌 본문이 있을 때) 초안으로 바꾼다 — 보내지는 않는다
  const replace = full.getByTestId('draft-replace-confirm');
  if (await replace.count()) await replace.getByRole('button', { name: '초안으로 바꾸기' }).click().catch(() => undefined);
  await settle(full);
  const p = path.join(opts.out, 'mailbox-reply.png');
  await full.screenshot({ path: p });
  written.push(['메일함 회신', p]);
  await full.getByTestId('btn-mail-back').first().click().catch(() => undefined);
  return { draft };
}

/** mailbox-voc 화면: 대륙물산 메일 [VOC로 등록] 작성 칸. 등록은 누르지 않는다 */
async function shootMailboxVoc(full, opts, written) {
  const view = await openMailbox(full);
  if (!view) return undefined;
  await pickMailThread(full, SAMPLE_MAIL_REPLY);
  const btn = full.getByTestId('btn-mail-voc');
  if (!(await btn.count()) || !(await btn.isEnabled())) {
    const why = (await btn.getAttribute('data-blocked-reason').catch(() => null)) ?? '버튼 없음';
    console.warn(`shot: [VOC로 등록]을 누를 수 없어 mailbox-voc.png 를 찍지 않았습니다(${why})`);
    return undefined;
  }
  await btn.click();
  await full.getByTestId('mail-voc-view').waitFor({ state: 'visible', timeout: 15_000 });
  await full.getByTestId('voc-create-title').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await settle(full);
  const p = path.join(opts.out, 'mailbox-voc.png');
  await full.screenshot({ path: p });
  written.push(['메일함 VOC 등록', p]);
  await full.getByTestId('btn-mail-back').first().click().catch(() => undefined);
  return { ok: true };
}

// ── 위키 검색·변경(3a단계 §14-4) ──

/**
 * --team: 임시 NAS·사본 폴더를 만들고 NAS 에 팀 위키 시험 사본을 복사한 뒤, 임시 데이터 폴더의 앱 설정에 동기화를 켠다.
 * 실제 NAS·저장소 안 폴더는 쓰지 않는다(임시 폴더만). remove 는 폴더를 지운다.
 */
function prepareTeam(dataDir) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-shot-team-'));
  const remote = path.join(base, 'nas');
  const local = path.join(base, 'local');
  fs.cpSync(FIXTURE_TEAM_WIKI, remote, { recursive: true });
  const settingsFile = path.join(dataDir, 'app-settings.json');
  const prev = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...prev, teamSync: { enabled: true, remote, local } }), 'utf8');
  return {
    remote,
    local,
    remove: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // 임시 폴더라 남아도 괜찮다
      }
    },
  };
}

/** 위키 문서 색인이 끝나기를(개인 — 팀이 켜져 있으면 팀 기준선까지) 기다린다. 위키 문서 기능이 없는 빌드면 null */
async function waitWikiIndexed(page, team, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await page
      .evaluate(async (team) => {
        if (typeof window.radar.getWikiDocs !== 'function') return null;
        const s = await window.radar.getWikiDocs();
        let teamState = 'skip';
        if (team) teamState = `${s.sources.team.state}/${(await window.radar.getWikiChanges({ source: 'team', offset: 0, limit: 1 })).state}`;
        return { personal: s.sources.personal.state, team: teamState, changes: s.changes.total };
      }, team)
      .catch(() => null);
    if (last === null) return null;
    const personalDone = last.personal !== 'indexing';
    const teamDone = !team || last.team === 'ready/ready' || /^(off|problem|missing|error)/.test(last.team);
    if ((personalDone && teamDone) || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

/** 줄바꿈을 LF 로·BOM 을 뗀 글(색인 해시와 같은 정규화 — src/main/wiki/docIndex.ts normalizeNewlines) */
function normalizeText(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** frontmatter(맨 위 --- … ---)를 뗀 본문(표본 기준 내용용 — 대략) */
function bodyOf(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return (m ? text.slice(m[0].length) : text).normalize('NFC');
}

/**
 * --sample-changes: 앱을 한 번 띄워 색인·기준선(wiki-seen.json)을 만들게 한 뒤 끄고, 그 기록을 고쳐 표본 변경을 만든다.
 * 고친 기록·기준 내용은 임시 데이터 폴더에만 있다(위키에는 쓰지 않는다). 옛 내용 = 지금 내용에서 끝 두 줄을 빼고 옛 줄 하나를 더한 것.
 */
async function seedSampleChanges(env, dataDir, wikiRoot, team, today) {
  const app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30_000 });
  try {
    const sidebar = await windowByMode(app, 'sidebar');
    const state = await waitWikiIndexed(sidebar, !!team);
    if (!state) {
      console.warn('shot: 위키 문서 기능이 없는 빌드라 --sample-changes 를 넣지 않았습니다');
      return false;
    }
    const seenFile = path.join(dataDir, 'wiki-seen.json');
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      try {
        const cur = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
        if (cur.sources?.personal && (!team || cur.sources?.team)) break;
      } catch {
        // 아직 없다
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await closeApp(app);
  }
  const seenFile = path.join(dataDir, 'wiki-seen.json');
  if (!fs.existsSync(seenFile)) {
    console.warn('shot: 읽음 기록이 만들어지지 않아 --sample-changes 를 넣지 않았습니다');
    return false;
  }
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  const base = { version: 1, items: {} };
  const day = today ?? new Date().toISOString().slice(0, 10);
  const detected = (hhmm) => new Date(`${day}T${hhmm}:00`).toISOString();
  const seenAt = new Date(`${day}T00:00:00`);
  seenAt.setDate(seenAt.getDate() - 3); // 3일 전에 본 것으로 — 그 뒤 log.md 항목이 「이유」로 붙는다
  const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');
  const oldVersion = (text) => {
    const lines = normalizeText(text).split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return [...lines.slice(0, Math.max(1, lines.length - 2)), '', '- 지난주에 적어 둔 옛 메모(표본)', ''].join('\n');
  };
  const plant = (source, root, rel, hhmm) => {
    const abs = path.join(root, ...rel.split('/'));
    const src = seen.sources?.[source];
    if (!src || !fs.existsSync(abs)) return false;
    const old = oldVersion(fs.readFileSync(abs, 'utf8'));
    const hash = sha1(old);
    src.docs[rel] = { hash, at: seenAt.toISOString() };
    base.items[`${source}:${rel}`] = { baseHash: hash, baseText: bodyOf(old), detectedAt: detected(hhmm) };
    return true;
  };
  let planted = 0;
  SAMPLE_CHANGED.forEach((rel, i) => {
    if (plant('personal', wikiRoot, rel, i === 0 ? '09:40' : '08:15')) planted++;
  });
  if (seen.sources?.personal) {
    seen.sources.personal.docs[SAMPLE_DELETED] = { hash: sha1('지운 문서(표본)'), at: seenAt.toISOString() };
    base.items[`personal:${SAMPLE_DELETED}`] = { detectedAt: detected('07:30') };
    planted++;
  }
  if (team && plant('team', team.local, SAMPLE_TEAM_CHANGED, '09:05')) planted++;
  fs.writeFileSync(seenFile, `${JSON.stringify(seen, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dataDir, 'wiki-change-base.json'), `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  return planted;
}

/** search 화면: 「검색」에서 "인벤토리" → 첫 결과 미리보기. 찍었으면 요약 */
async function shootSearch(full, opts, written) {
  const nav = full.getByTestId('nav-search');
  if (!(await nav.count())) {
    console.warn('shot: 내비에 검색이 없어 search.png 를 찍지 않았습니다(3a단계 화면이 없는 빌드)');
    return undefined;
  }
  await nav.first().click();
  await full.getByTestId('search-view').waitFor({ state: 'visible', timeout: 15_000 });
  await full.getByTestId('wiki-search-input').fill(SAMPLE_WIKI_QUERY);
  const hit = full.getByTestId('wiki-hit');
  await hit.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  const hits = await hit.count();
  let title;
  if (hits) {
    await hit.first().click();
    await full.getByTestId('wiki-preview-body').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    await full.locator('.wiki-img-el').first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
    title = (await full.locator('.wk-pv-title').first().innerText().catch(() => '')).trim();
  }
  await settle(full);
  const p = path.join(opts.out, 'search.png');
  await full.screenshot({ path: p });
  written.push(['위키 검색', p]);
  return { hits, title };
}

/** changes·changes-team 화면: 「변경」 그 탭의 첫 줄 미리보기. 찍었으면 요약 */
async function shootChanges(full, opts, written, tab) {
  const nav = full.getByTestId('nav-changes');
  if (!(await nav.count())) {
    console.warn('shot: 내비에 변경이 없어 changes.png 를 찍지 않았습니다(3a단계 화면이 없는 빌드)');
    return undefined;
  }
  await nav.first().click();
  await full.getByTestId('changes-view').waitFor({ state: 'visible', timeout: 15_000 });
  await full.getByTestId(`wiki-changes-tab-${tab}`).click();
  await full.locator(`[data-testid="changes-view"][data-tab="${tab}"]`).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  const row = full.getByTestId('wiki-change-row');
  await row
    .first()
    .or(full.getByTestId('wiki-changes-state').first())
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
  const rows = await row.count();
  if (rows) {
    // 지운 문서가 아닌 첫 줄(미리보기가 보이게)
    const pick = full.locator('[data-testid="wiki-change-row"]:not([data-change="deleted"]) .wk-row-main').first();
    if (await pick.count()) await pick.click();
    else await row.first().locator('.wk-row-main').click();
    await full.getByTestId('wiki-preview-body').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  }
  // 개인 탭이면 최근 기록(log.md)을 펼쳐 둔다
  const log = full.getByTestId('wiki-log-recent');
  if (tab === 'personal' && (await log.count())) await log.locator('summary').click().catch(() => undefined);
  await full.evaluate(() => document.fonts.ready);
  await full.waitForTimeout(150);
  const name = tab === 'team' ? 'changes-team.png' : 'changes.png';
  const p = path.join(opts.out, name);
  await full.screenshot({ path: p });
  written.push([tab === 'team' ? '위키 변경(팀)' : '위키 변경(개인)', p]);
  return { rows, count: (await nav.first().getAttribute('data-count')) ?? '-' };
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

/**
 * 127.0.0.1 의 빈 포트에 가짜 SMTP 서버를 띄운다(TLS 없음, 한 계정만 인증). shot 은 보내지 않으므로 받은 것은 버린다.
 * 회신 칸이 '계정 준비' 상태로 보이게 하려는 것이다.
 */
async function startFakeSmtp() {
  const server = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    disableReverseLookup: true,
    logger: false,
    closeTimeout: 2_000,
    onAuth(auth, _session, callback) {
      if (auth.username === FAKE_SMTP_USER && auth.password === FAKE_SMTP_PASS) callback(null, { user: auth.username });
      else callback(Object.assign(new Error('인증 실패(가짜 SMTP)'), { responseCode: 535 }));
    },
    onData(stream, _session, callback) {
      stream.on('data', () => undefined);
      stream.on('end', () => callback());
    },
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    const listener = server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(listener.address().port);
    });
  });
  server.on('error', () => undefined);
  let closing;
  return { port, close: () => (closing ??= new Promise((resolve) => server.close(() => resolve()))) };
}

/**
 * 회신 화면에 쓸 메일 할 일: --task 가 메일 할 일이면 그것, 아니면 원본 메일이 있는(회신 문맥이 나오는) 첫 할 일.
 * 없으면 null. 회신 API 가 없는 빌드면 예외.
 */
async function findMailTask(page, want) {
  return page.evaluate(async (want) => {
    const snap = await window.radar.getSnapshot();
    const withMail = snap.tasks.filter((t) => t.mail);
    const wanted = want ? withMail.filter((t) => t.id === want || t.title.includes(want)) : [];
    for (const t of [...wanted, ...withMail]) {
      if (await window.radar.getReplyContext(t.id)) return { id: t.id, title: t.title, bucket: t.bucket };
    }
    return null;
  }, want ?? null);
}

/**
 * reply 화면: 메일 할 일을 열어 처리 내용(표본)을 넣고 '회신 메일 보내기'를 켠 뒤 가짜 초안을 만들어 작성 칸을 찍는다.
 * [보내고 저장]·[저장]은 누르지 않는다(위키에도 메일 서버에도 아무것도 가지 않는다). 찍었으면 요약을, 못 찍었으면 undefined.
 */
async function shootReply(full, opts, written) {
  let task;
  try {
    task = await findMailTask(full, opts.task);
  } catch (err) {
    console.warn(`shot: 회신 문맥을 읽지 못해 reply.png 를 찍지 않았습니다(${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
  if (!task) {
    console.warn('shot: 원본 메일이 있는 할 일이 없어 reply.png 를 찍지 않았습니다');
    return undefined;
  }
  // 반영 대기 화면에 있었으면 할 일 화면으로(항목 열기도 할 일 화면으로 돌아가지만 먼저 옮겨 둔다)
  const navTasks = full.getByTestId('nav-tasks');
  if (await navTasks.count()) await navTasks.first().click();
  await full.evaluate((id) => window.radar.setMode('full', id), task.id);
  const detail = full.locator(`[data-testid="detail"][data-task-id="${task.id}"]`);
  await detail.waitFor({ state: 'visible', timeout: 15_000 });
  const toggle = detail.getByTestId('reply-toggle');
  if (!(await toggle.count())) {
    console.warn('shot: 상세에 "회신 메일 보내기"가 없어 reply.png 를 찍지 않았습니다(2.5단계 화면이 없는 빌드)');
    return undefined;
  }
  await detail.getByTestId('form-note').fill(SAMPLE_NOTE);
  await toggle.check();
  const panel = detail.getByTestId('reply-panel');
  await panel.waitFor({ state: 'visible', timeout: 15_000 });
  // 계정 준비(가짜 SMTP)가 화면에 올 때까지 조금 기다린다
  await detail
    .locator('[data-testid="reply-panel"][data-ready="true"]')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => undefined);
  let draft = '(만들지 않음)';
  const draftButton = panel.getByTestId('btn-draft');
  if ((await draftButton.count()) && (await draftButton.isEnabled())) {
    await draftButton.click();
    await panel
      .locator('[data-testid="draft-status"][data-state="done"], [data-testid="draft-status"][data-state="failed"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => undefined);
    draft = (await panel.getByTestId('draft-status').first().getAttribute('data-state').catch(() => null)) ?? '(모름)';
  }
  // 작성 칸이 화면 위에서 시작하도록 내린다
  await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settle(full);
  const p = path.join(opts.out, 'reply.png');
  await full.screenshot({ path: p });
  written.push(['회신 작성', p]);
  // 아래쪽(원문 인용·보내는 사람·서명·[보내고 저장])도 찍는다 — 접이식 설정을 펼치고 제출 버튼이 화면 아래에 오게.
  // 설정은 펼치기만 하고 저장하지 않는다.
  const settingsBox = panel.getByTestId('mail-settings');
  if (await settingsBox.count()) {
    await settingsBox.locator('summary').first().click();
    await settingsBox
      .getByTestId('mail-settings-name')
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => undefined);
  }
  const send = detail.getByTestId('btn-send');
  if (await send.count()) {
    await send.first().evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await settle(full);
    const pSend = path.join(opts.out, 'reply-send.png');
    await full.screenshot({ path: pSend });
    written.push(['회신 작성(아래·설정 펼침)', pSend]);
  }
  const ready = (await panel.getAttribute('data-ready')) ?? '(모름)';
  return { id: task.id, title: task.title, ready, draft };
}

/**
 * 가짜 voc-cli 자료의 임시 복사본과 호출 기록 자리(test/e2e/app.ts 와 같은 모양). remove 는 폴더를 지운다.
 * 자료가 아직 없으면 빈 폴더 — 앱은 그래도 가짜만 부른다.
 */
function prepareFakeVoc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-shot-voc-'));
  const state = path.join(root, 'state');
  if (fs.existsSync(FIXTURE_VOC)) fs.cpSync(FIXTURE_VOC, state, { recursive: true });
  else fs.mkdirSync(state, { recursive: true });
  return {
    state,
    log: path.join(root, 'calls.jsonl'),
    remove: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // 임시 폴더라 남아도 괜찮다
      }
    },
  };
}

/**
 * VOC 를 한 번 받아 둔다(시작 5초 뒤 첫 받기를 기다리지 않는다) — 사이드바·목록에 VOC 합계·내 담당 VOC 할 일이 들어간 뒤 찍으려고.
 * 보드 상태를 돌려준다. VOC 가 없는 빌드면 undefined.
 */
async function primeVoc(page) {
  const state = await page
    .evaluate(async () => {
      if (typeof window.radar.refreshVoc !== 'function') return undefined;
      const board = await window.radar.refreshVoc();
      return board.state;
    })
    .catch((err) => {
      console.warn(`shot: VOC 를 받지 못했습니다(${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    });
  // 보드 뒤에 오는 스냅샷 방송(내 담당 VOC 할 일 교체)을 기다린다
  if (state) await page.waitForTimeout(500);
  return state;
}

/**
 * voc 화면: 풀스크린 'VOC' 에서 미배정 칸(없으면 첫 칸)을 고르고 첫 티켓 상세를 연다. 쓰기 버튼·[VOC 에서 열기]는 누르지 않는다.
 * 찍었으면 요약을, 못 찍었으면 undefined.
 */
async function shootVoc(full, opts, written) {
  const nav = full.getByTestId('nav-voc');
  if (!(await nav.count())) {
    console.warn('shot: 내비에 VOC 가 없어 voc.png 를 찍지 않았습니다(2.6단계 화면이 없는 빌드)');
    return undefined;
  }
  await nav.first().click();
  const view = full.getByTestId('voc-view');
  await view.waitFor({ state: 'visible', timeout: 15_000 });
  const refresh = full.getByTestId('btn-voc-refresh');
  if ((await refresh.count()) && (await refresh.first().isEnabled())) await refresh.first().click();
  await full
    .locator('[data-testid="voc-view"]:not([data-state="loading"])')
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => undefined);
  const lanes = full.getByTestId('voc-lane');
  const lane = full.locator('[data-testid="voc-lane"][data-lane="unassigned"]');
  if (await lane.count()) await lane.first().click();
  else if (await lanes.count()) await lanes.first().click();
  let number;
  const ticket = full.getByTestId('voc-ticket');
  if (await ticket.count()) {
    await ticket.first().click();
    const detail = full.getByTestId('voc-detail');
    await detail.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    number = (await detail.getAttribute('data-ticket-id').catch(() => null)) ?? undefined;
  }
  await settle(full);
  const p = path.join(opts.out, 'voc.png');
  await full.screenshot({ path: p });
  written.push(['VOC', p]);
  // 아래쪽(담당·일정 바꾸기 — 누르지 않는다)도 한 장: voc-actions.png
  const assign = full.getByTestId('btn-voc-assign');
  if (await assign.count()) {
    await assign.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(full);
    const pa = path.join(opts.out, 'voc-actions.png');
    await full.screenshot({ path: pa });
    written.push(['VOC 동작', pa]);
  }
  // V4(명세 §14): 나의 칸 첫 티켓의 첨부·작업시간(읽기만 — [첨부 보기]·[작업시간 보기]·이미지 [보기], 쓰기 버튼은 누르지 않는다).
  // 첨부는 임시 데이터 폴더(WIKI_RADAR_DATA)에 받는다 → voc-work.png
  const mine = full.locator('[data-testid="voc-lane"][data-lane^="user:"]').first();
  const filesBtn = full.getByTestId('btn-voc-attachments');
  if ((await mine.count()) && (await filesBtn.count())) {
    await mine.click();
    // 첨부가 있는 티켓(가짜 자료 1004)을 먼저, 없으면 첫 티켓
    const withFiles = full.locator('[data-testid="voc-ticket"][data-ticket-id="1004"]');
    if (await withFiles.count()) await withFiles.click();
    else if (await ticket.count()) await ticket.first().click();
    await full.getByTestId('btn-voc-attachments').click();
    await full.getByTestId('voc-attachments').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    await full.getByTestId('btn-voc-worklogs').click();
    await full.getByTestId('voc-worklogs').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    const view1 = full.getByTestId('btn-voc-file-view');
    if (await view1.count()) {
      await view1.first().click();
      await full.getByTestId('voc-file-preview').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    }
    await full.getByTestId('btn-voc-attachments').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await settle(full);
    const pw = path.join(opts.out, 'voc-work.png');
    await full.screenshot({ path: pw });
    written.push(['VOC 첨부·작업시간', pw]);
    await full.getByTestId('btn-voc-resolve').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(full);
    const pf = path.join(opts.out, 'voc-finish.png');
    await full.screenshot({ path: pf });
    written.push(['VOC 해결·메일', pf]);
    // 대화상자 두 개(여는 것은 읽기뿐 — [실행]은 누르지 않고 [취소]로 닫는다): voc-resolve.png · voc-email.png
    for (const [button, name, label, ready] of [
      ['btn-voc-resolve', 'voc-resolve.png', 'VOC 해결 대화상자', 'voc-resolve-worklogs'],
      ['btn-voc-email', 'voc-email.png', 'VOC 고객 메일 대화상자', 'voc-email-logs'],
    ]) {
      const b = full.getByTestId(button);
      if (!(await b.count()) || !(await b.isEnabled())) continue;
      await b.click();
      const dialog = full.getByTestId('voc-confirm');
      await dialog.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
      await full
        .locator(`[data-testid="${ready}"]:not([data-count=""])`)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      await settle(full);
      const pd = path.join(opts.out, name);
      await full.screenshot({ path: pd });
      written.push([label, pd]);
      await full.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    }
  }
  return {
    state: (await view.getAttribute('data-state')) ?? '(모름)',
    lanes: await lanes.count(),
    unassigned: (await lane.first().getAttribute('data-count').catch(() => null)) ?? '-',
    ticketId: number,
  };
}

/**
 * voc-task 화면: 내 담당 VOC 할 일(source 'voc')을 풀스크린에서 열고 'VOC 처리'가 보이게 내려 찍는다.
 * 답변 칸에는 아무것도 넣지 않고 누르지도 않는다. 찍었으면 요약을, 못 찍었으면 undefined.
 */
async function shootVocTask(full, opts, written) {
  const task = await full
    .evaluate(async () => {
      const snap = await window.radar.getSnapshot();
      const t = snap.tasks.find((x) => x.source === 'voc');
      return t ? { id: t.id, title: t.title, bucket: t.bucket, number: t.voc?.number } : null;
    })
    .catch(() => null);
  if (!task) {
    console.warn('shot: 내 담당 VOC 할 일이 없어 voc-task.png 를 찍지 않았습니다(VOC 를 받지 못했거나 나의 칸이 비었음)');
    return undefined;
  }
  await full.evaluate((id) => window.radar.setMode('full', id), task.id);
  const detail = full.locator(`[data-testid="detail"][data-task-id="${task.id}"]`);
  await detail.waitFor({ state: 'visible', timeout: 15_000 });
  const panel = detail.getByTestId('voc-task-panel');
  // 'VOC 처리' 제목이 화면 위에서 시작하도록 내린다
  if (await panel.count()) await panel.first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  else console.warn('shot: 상세에 VOC 처리가 없습니다(2.6단계 화면이 없는 빌드) — 상세 위쪽만 찍습니다');
  await settle(full);
  const p = path.join(opts.out, 'voc-task.png');
  await full.screenshot({ path: p });
  written.push(['내 담당 VOC 할 일', p]);
  // 아래쪽(답변 달기·상태·VOC 웹 안내 — 넣지도 누르지도 않는다)도 한 장: voc-task-actions.png
  const status = detail.getByTestId('btn-voc-status');
  if (await status.count()) {
    await status.first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(full);
    const pa = path.join(opts.out, 'voc-task-actions.png');
    await full.screenshot({ path: pa });
    written.push(['내 담당 VOC 할 일(처리)', pa]);
  }
  return task;
}

/**
 * voc-login 화면: 풀스크린 VOC 화면을 열고 로그인 대화상자를 띄운다(사이드바 'VOC 로그인 필요'와 같은 요청 view:voc-login).
 * 비밀번호는 넣지 않고 [로그인]도 누르지 않는다. 찍었으면 요약을, 못 찍었으면 undefined.
 */
async function shootVocLogin(full, opts, written) {
  if (!(await full.getByTestId('nav-voc').count())) {
    console.warn('shot: 내비에 VOC 가 없어 voc-login.png 를 찍지 않았습니다(2.6단계 화면이 없는 빌드)');
    return undefined;
  }
  await full.evaluate(() => window.radar.setMode('full', 'view:voc-login'));
  const dialog = full.getByTestId('voc-login');
  try {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    console.warn('shot: 로그인 대화상자가 뜨지 않아 voc-login.png 를 찍지 않았습니다(앱 안 로그인이 없는 빌드)');
    return undefined;
  }
  const state = (await full.getByTestId('voc-view').getAttribute('data-state').catch(() => null)) ?? '(모름)';
  if (state !== 'login') console.warn(`shot: VOC 보드가 로그인 필요 상태가 아닙니다(${state}) — --voc-mode login 으로 찍으세요`);
  await settle(full);
  const p = path.join(opts.out, 'voc-login.png');
  await full.screenshot({ path: p });
  written.push(['VOC 로그인', p]);
  const id = await dialog.getByTestId('voc-login-id').inputValue().catch(() => '');
  const focused = await full.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '(없음)');
  return { state, id, focused };
}

async function textOfFirst(page, testId) {
  const el = page.getByTestId(testId);
  return (await el.count()) ? (await el.first().innerText()).replace(/\s+/g, ' ').trim() : undefined;
}

/**
 * --sample-settings: 가짜 POP3·가짜 로컬 LLM(127.0.0.1)을 띄우고, 임시 팀 설정 파일(서버는 모두 127.0.0.1 — 가짜 값, ai 없음)과
 * 임시 데이터 폴더의 내 값 일부(app-settings.json — AI 주소·모델·연결 시험 성공 호스트 포함)를 넣는다. 비밀은 어디에도 쓰지 않는다(메일 받기 비밀번호는 칸의 초안으로만).
 */
async function prepareSampleSettings(env, dataDir) {
  const { startFakePop3 } = await import(new URL('../test/fixtures/fake-pop3-server.mjs', import.meta.url).href);
  const llmMod = await import(new URL('../test/fixtures/fake-llm-server.mjs', import.meta.url).href);
  const pop = await startFakePop3({ user: FAKE_SMTP_USER, pass: SAMPLE_POP3_PASS });
  const llm = await llmMod.startFakeLlm({});
  const teamFile = path.join(dataDir, 'shot-team-settings.json');
  const teamSettings = {
    version: 1,
    mailIn: { host: '127.0.0.1', port: pop.port, ssl: false, intervalMinutes: 10 },
    mailOut: { host: '127.0.0.1', port: 2525, security: 'starttls' },
    // ai 는 넣지 않는다 — AI 는 팀 기본값이 없고 각자 설정·[연결 시험](소유자 결정 2026-10-19)
    update: { url: 'off' },
  };
  fs.writeFileSync(teamFile, `${JSON.stringify(teamSettings, null, 2)}\n`, 'utf8');
  env.WIKI_RADAR_TEAM_SETTINGS = teamFile;
  const settingsFile = path.join(dataDir, 'app-settings.json');
  const prev = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  // AI 는 내 값으로, 연결 시험에 성공한 상태(keyHost = 가짜 LLM 의 호스트)로 넣는다
  const ai = { llmUrl: llm.url, apiFormat: 'openai', model: llmMod.FAKE_LLM_MODEL, draftEngine: 'local', keyHost: new URL(llm.url).host };
  fs.writeFileSync(settingsFile, JSON.stringify({ ...prev, mailIn: { user: FAKE_SMTP_USER, intervalMinutes: 15 }, ai }), 'utf8');
  return {
    pop,
    llm,
    close: async () => {
      await pop.close().catch(() => undefined);
      await llm.close().catch(() => undefined);
    },
  };
}

/** 설정 칸마다 settings-<칸>.png. --sample-settings 면 메일 받기(비밀번호 초안)·AI 칸은 [연결 시험] 결과까지. [저장]은 누르지 않는다 */
async function shootSettings(full, opts, written, sample) {
  await full.getByTestId('nav-setup').click();
  await full.getByTestId('settings-view').waitFor({ state: 'visible', timeout: 15_000 });
  const tests = [];
  for (const key of SETTINGS_SHOTS) {
    await full.getByTestId(`settings-tab-${key}`).click();
    const panel = key === 'check' ? full.getByTestId('setup-view') : full.getByTestId(`settings-${key}`);
    await panel.waitFor({ state: 'visible', timeout: 15_000 });
    // 칸 값을 읽을 때까지(바닥이 그려짐)
    if (key !== 'check') await full.getByTestId('sv-status').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    if (sample && (key === 'mailIn' || key === 'ai')) {
      if (key === 'mailIn') {
        await full.getByTestId('sv-secret-change').click();
        await full.getByTestId('sv-secret-input').fill(SAMPLE_POP3_PASS);
      }
      await full.getByTestId('sv-test').click();
      const result = full.getByTestId('sv-test-result');
      await result.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
      tests.push(`${key}=${(await result.getAttribute('data-ok').catch(() => null)) ?? '-'}`);
      await result.scrollIntoViewIfNeeded().catch(() => undefined);
    }
    if (key === 'ai') await full.getByTestId('sv-claude').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await settle(full);
    const p = path.join(opts.out, `settings-${key}.png`);
    await full.screenshot({ path: p });
    written.push([`설정 › ${key}`, p]);
    // 다음 칸으로 옮기기 전에 초안을 버린다(떠나기 확인 대화상자가 뜨지 않게)
    const revert = full.getByTestId('sv-revert');
    if ((await revert.count()) && (await revert.first().isEnabled())) await revert.first().click();
  }
  const dots = await full
    .locator('[data-testid^="settings-dot-"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-dot-', '')).join(','));
  return { tabs: SETTINGS_SHOTS.length, tests: tests.join(' '), dots };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  const wants = (v) => opts.views.includes(v);

  const wiki = prepareWiki(opts.wiki);
  const env = { ...process.env, WIKI_RADAR_WIKI: wiki.root };
  if (opts.today) env.WIKI_RADAR_TODAY = opts.today;
  else delete env.WIKI_RADAR_TODAY;
  // 시험 시계(2.9단계 §7-2)가 셸에 남아 있으면 --today 를 덮고 알림 서비스가 켜져 사진에 알림이 섞인다
  delete env.WIKI_RADAR_NOW;
  delete env.ELECTRON_RUN_AS_NODE;
  // 임시 사용자 데이터 폴더: 떠 있는 실제 앱과 한 번만 실행 잠금이 부딪히지 않고, 실제 사용자 데이터도 건드리지 않는다.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-shot-'));
  env.WIKI_RADAR_USER_DATA = userDataDir;
  // 2단계: 대기열(queue.json)·실행 기록도 임시 폴더에. 물려받은 WIKI_RADAR_DATA 가 실제 폴더를 가리켜도 덮어쓴다.
  env.WIKI_RADAR_DATA = userDataDir;
  // claude 는 가짜(반영은 실패만 하는 모드)로 막아 둔다 — 스크린샷 도구가 진짜 claude 를 부를 일은 없다.
  // 회신 초안(reply 화면)은 가짜의 ok 초안 — 어떤 파일도 쓰지 않는다(실제 위키에서는 가짜가 아무것도 하지 않고 끝난다).
  env.WIKI_RADAR_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
  env.FAKE_CLAUDE_MODE = 'fail';
  env.FAKE_CLAUDE_DRAFT_MODE = 'ok';
  // 2.5단계 메일: 물려받은 SMTP 설정·계정을 지우고 가짜 SMTP 서버를 계정으로 준다. 시험 가드도 켠다(루프백 밖 연결 거부).
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_SMTP_|MAILHOST_MAIL_)/i.test(key)) delete env[key];
  }
  env.WIKI_RADAR_TEST_MODE = '1';
  const smtp = await startFakeSmtp();
  env.WIKI_RADAR_SMTP_HOST = '127.0.0.1';
  env.WIKI_RADAR_SMTP_PORT = String(smtp.port);
  env.WIKI_RADAR_SMTP_SECURE = '0';
  env.WIKI_RADAR_SMTP_USER = FAKE_SMTP_USER;
  env.WIKI_RADAR_SMTP_PASS = FAKE_SMTP_PASS;
  // 2.6단계 VOC: voc-cli 는 언제나 가짜. 물려받은 WIKI_RADAR_VOC_*·FAKE_VOC_* 는 지우고 덮어쓴다(실제 jar 로 새지 않게)
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_VOC_|FAKE_VOC_)/i.test(key)) delete env[key];
  }
  const voc = prepareFakeVoc();
  env.WIKI_RADAR_VOC_CLI = FAKE_VOC_CLI;
  env.FAKE_VOC_STATE = voc.state;
  env.FAKE_VOC_LOG = voc.log;
  env.FAKE_VOC_MODE = opts.vocMode;
  // 2.13단계: 물려받은 POP3·로컬 LLM·키·팀 설정·업데이트 주소는 지운다(개발 PC 의 실제 값이 사진에 섞이지 않게)
  for (const key of Object.keys(env)) {
    if (/^(WIKI_RADAR_POP3_|WIKI_RADAR_LLM_|WIKI_RADAR_TEAM_SETTINGS$|WIKI_RADAR_UPDATE_URL$|SERVER_LLM_API_KEY$)/i.test(key)) delete env[key];
  }
  const removeUserData = () => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 임시 폴더라 남아도 괜찮다
    }
  };
  const sampleSettings = opts.sampleSettings ? await prepareSampleSettings(env, userDataDir) : null;
  if (opts.sampleQueue) writeSampleQueue(userDataDir, opts.today);
  if (opts.sampleMail) writeSampleMailState(userDataDir, opts.today);
  // --today 만 주면 메일 기준선도 그날에 맞춘다(실제 시각 − 72시간이면 그날 메일이 모두 읽음으로 보여 사이드바 메일 블록이 늘 비어 보인다).
  // 기준선만 넣는다(표시 없음). raw/mail 에는 쓰지 않는다
  else if (opts.today) writeSampleMailState(userDataDir, opts.today, { replyNeeded: false });
  // voc-login: 로그인 대화상자가 '아이디 기억'으로 채운 모습이 보이게 임시 데이터 폴더의 VOC 설정에 가짜 아이디만 둔다(비밀번호는 없다)
  // 3a단계: 팀 위키(임시 NAS·사본) · 표본 위키 변경(앱을 한 번 띄워 기준선을 만든 뒤 고친다 — 위키에는 쓰지 않는다)
  const team = opts.team ? prepareTeam(userDataDir) : null;
  let sampleChanges;
  if (opts.sampleChanges) {
    try {
      sampleChanges = await seedSampleChanges(env, userDataDir, wiki.root, team, opts.today);
    } catch (err) {
      console.warn(`shot: 표본 위키 변경을 만들지 못했습니다(${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (wants('voc-login')) {
    const settings = { memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, loginId: SAMPLE_LOGIN_ID };
    fs.writeFileSync(path.join(userDataDir, 'voc-settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  let app;
  try {
    app = await electron.launch({ args: ['.'], cwd: ROOT, env, timeout: 30_000 });
  } catch (err) {
    removeUserData();
    wiki.remove();
    voc.remove();
    team?.remove();
    await smtp.close();
    await sampleSettings?.close();
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
    const vocState = await primeVoc(sidebar);
    const mailState = await waitMailboxIndexed(sidebar);
    // 위키 색인(「변경 N」)이 끝난 뒤 찍는다
    const wikiState = await waitWikiIndexed(sidebar, !!team);
    if (wikiState) await sidebar.getByTestId('sidebar-changes').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await settle(sidebar);
    if (wants('sidebar')) {
      const p = path.join(opts.out, 'sidebar.png');
      await sidebar.screenshot({ path: p });
      written.push(['사이드바', p]);
    }

    const errorText = await textOfFirst(sidebar, 'snapshot-error');
    const queueLineText = await textOfFirst(sidebar, 'sidebar-queue');
    const staleText = await textOfFirst(sidebar, 'bucket-stale');
    const vocLineText = await textOfFirst(sidebar, 'sidebar-voc');
    const mailBlockText = await textOfFirst(sidebar, 'sidebar-mail');
    const changesLineText = await textOfFirst(sidebar, 'sidebar-changes');

    let detailTitle;
    let selected;
    let counts = {};
    let replyInfo;
    let vocInfo;
    let vocTaskInfo;
    let vocLoginInfo;
    let mailboxInfo;
    let mailboxReplyInfo;
    let mailboxVocInfo;
    let changesInfo;
    let changesTeamInfo;
    let searchInfo;
    let settingsInfo;
    const fullViews = ['full', 'form', 'queue', 'reply', 'voc', 'voc-task', 'voc-login', 'mailbox', 'mailbox-reply', 'mailbox-voc', 'mail-wiki', 'search', 'changes', 'changes-team', 'settings'];
    if (fullViews.some(wants)) {
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

      if (wants('reply')) replyInfo = await shootReply(full, opts, written);
      if (wants('voc')) vocInfo = await shootVoc(full, opts, written);
      if (wants('voc-task')) vocTaskInfo = await shootVocTask(full, opts, written);
      if (wants('voc-login')) vocLoginInfo = await shootVocLogin(full, opts, written);
      if (wants('mailbox')) mailboxInfo = await shootMailbox(full, opts, written);
      if (wants('mailbox-reply')) mailboxReplyInfo = await shootMailboxReply(full, opts, written);
      if (wants('mail-wiki')) {
        const info = await shootMailWiki(full, opts, written);
        if (info) console.log(`메일 → 위키 폼: 버튼 상태 ${info.state}`);
      }
      if (wants('mailbox-voc')) mailboxVocInfo = await shootMailboxVoc(full, opts, written);
      // 변경을 먼저 찍는다(검색 미리보기가 1초 넘게 열리면 그 문서는 읽음이 된다)
      if (wants('changes')) changesInfo = await shootChanges(full, opts, written, 'personal');
      if (wants('changes-team')) changesTeamInfo = await shootChanges(full, opts, written, 'team');
      if (wants('search')) searchInfo = await shootSearch(full, opts, written);
      if (wants('settings')) settingsInfo = await shootSettings(full, opts, written, sampleSettings);
    }

    console.log(`위키: ${opts.wiki}${wiki.root !== opts.wiki ? ` (임시 복사본 ${wiki.root} 로 띄움)` : ''}`);
    console.log(`오늘: ${opts.today ?? '(실제 오늘)'}`);
    for (const [label, p] of written) console.log(`${label}: ${p}`);
    if (detailTitle) console.log(`선택: ${detailTitle}`);
    if (selected) console.log(`선택 항목: ${selected.id} [${selected.bucket}]`);
    if (replyInfo) console.log(`회신 항목: ${replyInfo.title} (${replyInfo.id}) · 계정 준비 ${replyInfo.ready} · 초안 ${replyInfo.draft}`);
    console.log(`VOC: 가짜 voc-cli(${opts.vocMode}) · 보드 ${vocState ?? '(받지 못함)'}`);
    if (vocInfo) {
      console.log(
        `VOC 화면: ${vocInfo.state} · 칸 ${vocInfo.lanes} · 미배정 ${vocInfo.unassigned}${vocInfo.ticketId ? ` · 상세 티켓 id ${vocInfo.ticketId}` : ''}`,
      );
    }
    if (vocTaskInfo) console.log(`VOC 할 일: ${vocTaskInfo.title} (${vocTaskInfo.id}${vocTaskInfo.number ? ` · ${vocTaskInfo.number}` : ''}) [${vocTaskInfo.bucket}]`);
    if (vocLoginInfo) console.log(`VOC 로그인: 보드 ${vocLoginInfo.state} · 아이디 칸 '${vocLoginInfo.id}' · 초점 ${vocLoginInfo.focused}`);
    if (vocLineText) console.log(`사이드바 VOC: ${vocLineText}`);
    if (mailBlockText) console.log(`사이드바 메일: ${mailBlockText}`);
    else if (mailState) console.log(`사이드바 메일: (블록 없음 — 메일함 ${mailState})`);
    if (mailboxInfo) console.log(`메일함: ${mailboxInfo.state} · 스레드 ${mailboxInfo.rows}줄 · 미확인 ${mailboxInfo.unread} · 고른 스레드 ${mailboxInfo.threadId ?? '-'}`);
    if (mailboxReplyInfo) console.log(`메일함 회신: 초안 ${mailboxReplyInfo.draft}`);
    if (mailboxVocInfo) console.log('메일함 VOC 등록: 작성 칸 열림');
    if (opts.team) console.log(`팀 위키: 임시 NAS·사본(${team?.local ?? '-'})`);
    if (opts.sampleChanges) console.log(`표본 위키 변경: ${sampleChanges ? `${sampleChanges}건` : '(넣지 못함)'}`);
    if (changesLineText) console.log(`사이드바 변경: ${changesLineText}`);
    if (changesInfo) console.log(`위키 변경(개인): 줄 ${changesInfo.rows} · 내비 수 ${changesInfo.count}`);
    if (changesTeamInfo) console.log(`위키 변경(팀): 줄 ${changesTeamInfo.rows}`);
    if (searchInfo) console.log(`위키 검색: '${SAMPLE_WIKI_QUERY}' 결과 ${searchInfo.hits}줄 · 미리보기 ${searchInfo.title ?? '-'}`);
    if (settingsInfo) console.log(`설정: 칸 ${settingsInfo.tabs} · 연결 시험 ${settingsInfo.tests || '(없음)'}${settingsInfo.dots ? ` · 점 ${settingsInfo.dots}` : ''}`);
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
    await smtp.close();
    await sampleSettings?.close();
    removeUserData();
    wiki.remove();
    voc.remove();
    team?.remove();
  }
}

main().catch((err) => {
  console.error(`shot: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
