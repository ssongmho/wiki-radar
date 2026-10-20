// 시험용 가짜 claude (docs/stage2-contract.md §6, docs/stage2.5-contract.md §6). runReflect·runReplyDraft 가
// `node fake-claude.mjs <인자…>` 로 부른다. 네트워크를 쓰지 않고, 작업 폴더(cwd = 위키 사본) 밖에는 쓰지 않는다.
// 실제 위키에서 부르면 아무것도 하지 않고 끝난다.
//
// 인자 --tools 값에 Edit 가 있으면 반영 실행, 없으면 회신 초안 실행으로 본다.
//
// 환경변수
//   FAKE_CLAUDE_MODE     반영 모드: ok(기본) · fail · timeout · nojson · slow · noresult · iserror
//   FAKE_CLAUDE_DRAFT_MODE 초안 모드: ok(기본) · fail · nojson · slow · confirm · iserror
//   FAKE_CLAUDE_LOG      있으면 받은 인자·작업 폴더·표준입력 앞부분을 이 파일에 JSON 으로 적는다(인자·프롬프트 검증용)
//   FAKE_CLAUDE_CHANGED  반영 ok·slow 에서 결과 JSON 의 changed 를 이 JSON 배열로 바꾼다(경로 정규화 시험용)
//   FAKE_CLAUDE_DELAY_MS 반영 slow 의 대기 시간(기본 1500)
//   FAKE_CLAUDE_STDERR_LINES 있으면 시작할 때 표준에러에 이만큼 줄을 찍는다(진행 기록 줄 수 제한 시험용)
//   FAKE_CLAUDE_DRAFT_REFS 초안 ok·slow·confirm 에서 references 를 이 JSON 배열로 바꾼다(경로 정규화 시험용)
//   FAKE_CLAUDE_DRAFT_DELAY_MS 초안 slow 의 대기 시간(기본 30000)
//   FAKE_CLAUDE_SKIP_TITLES 반영 ok·slow 에서 이 JSON 배열의 제목인 항목을 skipped 로 보고한다(2.14 — 메일 「건너뜀」 표시 시험용)
//   FAKE_CLAUDE_SKIP_IDS 반영 ok·slow 에서 이 JSON 배열의 id 인 항목을 skipped 로 보고한다(같은 제목 항목 구분 시험용)
//   (skipped 원소에는 늘 그 항목의 id·title·reason 을 적는다)
//
// 반영 실행(2.14단계 §11): 표준입력에 <items> 와 <mails> 블록이 온전해야 한다. kind mail 항목은 같은 ref 의 mails 원소가 있어야 하고
// (없으면 종료 코드 3), note 가 비어도 skipped 로 보지 않는다. --disallowedTools 에 Read(raw/mail/_attachments/**) 가 없어도 종료 코드 3.
// FAKE_CLAUDE_LOG 에는 읽은 mails 블록(mails)과 표준입력의 </mails> 수(mailsCloseCount)를 함께 적는다.
//
// 반영 모드
//   ok       wiki/entities/한결케미칼.md 끝에 한 줄을 덧붙이고 Claude --output-format json 형식의 성공 결과를 낸다
//   slow     표준에러에 진행 줄을 찍으며 잠시 기다린 뒤 ok 와 같다
//   fail     표준에러에 오류를 찍고 is_error 결과와 함께 종료 코드 1
//   timeout  손자 프로세스를 하나 띄우고(트리 종료 확인용, pid 를 로그에 적는다) 끝나지 않는다
//   nojson   JSON 이 아닌 글을 내고 종료 코드 0
//   noresult 성공 결과지만 result 글 끝에 결과 JSON 이 없다
//   iserror  종료 코드 0 이지만 is_error:true (대화 한도 초과)
//
// 초안 모드 — 어떤 파일도 쓰지 않는다(FAKE_CLAUDE_LOG 제외). 표준입력의 <task>(메일함 회신은 <request>)·<mail> 블록이 온전해야 한다.
//   인자의 --tools·--allowedTools 에 Edit·Write·Bash·PowerShell 이 있거나 권한 우회 인자가 있으면 종료 코드 3
//   --disallowedTools 에 계정 파일 읽기 금지(Read(_mail-ingest/**)·Read(**/.env)·Read(**/.env.*))가 없어도 종료 코드 3(반영도 같다)
//   ok       <task> 의 note 를 담은 짧은 회신 본문 + references ['wiki/entities/한결케미칼.md'] + notes ''
//   confirm  ok 와 같되 본문에 '[확인 필요: 완료 예정일]'
//   fail     표준에러에 오류를 찍고 종료 코드 1
//   nojson   성공 결과지만 result 글에 JSON 이 없다
//   slow     손자 프로세스를 하나 띄우고(pid 를 로그에 적는다) 표준에러에 진행 줄을 찍으며 기다린 뒤 ok 와 같다(취소·시간 초과 시험용)
//   iserror  종료 코드 0 이지만 is_error:true (대화 한도 초과)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_WIKI = path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI').toLowerCase();
const ENTITY = path.join('wiki', 'entities', '한결케미칼.md');
const STDIN_HEAD_CHARS = 20_000;

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const draftMode = process.env.FAKE_CLAUDE_DRAFT_MODE || 'ok';
const logPath = process.env.FAKE_CLAUDE_LOG;
const record = {
  pid: process.pid,
  mode,
  draftMode,
  argv,
  cwd: process.cwd(),
  stdinLength: 0,
  stdinHead: '',
};

function writeLog(extra = {}) {
  if (!logPath) return;
  Object.assign(record, extra);
  fs.writeFileSync(logPath, JSON.stringify(record, null, 2), 'utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 인자 name 다음 값. 인자가 없으면 null */
function argValue(name) {
  const i = argv.indexOf(name);
  return i < 0 ? null : (argv[i + 1] ?? '');
}

function toolList(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 프롬프트의 <tag> 블록을 JSON 으로 읽는다(블록이 온전한지 확인). 못 읽으면 null */
function parseBlock(prompt, tag) {
  const openTag = `\n<${tag}>\n`;
  const closeTag = `\n</${tag}>\n`;
  const open = prompt.indexOf(openTag);
  const close = prompt.indexOf(closeTag);
  if (open < 0 || close < 0 || close < open) return null;
  // 여는·닫는 태그가 하나씩만 있어야 한다(메모 속 </items> 가 블록을 깨면 여기서 걸린다)
  if (prompt.split(`<${tag}>`).length !== 2 || prompt.split(`</${tag}>`).length !== 2) return null;
  try {
    return JSON.parse(prompt.slice(open + openTag.length, close));
  } catch {
    return null;
  }
}

/** 프롬프트의 <items> 블록(반영). 배열이 아니면 null */
function parseItems(prompt) {
  const items = parseBlock(prompt, 'items');
  return Array.isArray(items) ? items : null;
}

function printResult(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function successEnvelope(result) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 3,
    result,
    session_id: 'fake-session',
    total_cost_usd: 0,
  };
}

function appendEntityLine() {
  const file = path.join(process.cwd(), ENTITY);
  if (!fs.existsSync(file)) {
    process.stderr.write(`가짜 claude: 작업 폴더에 ${ENTITY} 가 없습니다 (cwd=${process.cwd()})\n`);
    return false;
  }
  const text = fs.readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text.length === 0 || text.endsWith('\n') ? '' : eol;
  fs.appendFileSync(file, `${sep}- (가짜 claude) 처리 결과 반영 확인 줄${eol}`, 'utf8');
  return true;
}

async function doOk(items) {
  if (!appendEntityLine()) {
    process.exitCode = 2;
    return;
  }
  let changed = ['wiki/entities/한결케미칼.md'];
  if (process.env.FAKE_CLAUDE_CHANGED) changed = JSON.parse(process.env.FAKE_CLAUDE_CHANGED);
  const skipTitles = process.env.FAKE_CLAUDE_SKIP_TITLES ? JSON.parse(process.env.FAKE_CLAUDE_SKIP_TITLES) : [];
  const skipIds = process.env.FAKE_CLAUDE_SKIP_IDS ? JSON.parse(process.env.FAKE_CLAUDE_SKIP_IDS) : [];
  const forced = (it) => skipTitles.includes(it.title) || skipIds.includes(it.id);
  const skipped = items
    .filter(
      (it) =>
        forced(it) ||
        // kind mail 은 메모 없이도 메일 내용에서 고른다(2.14)
        (it.kind !== 'mail' && (typeof it.note !== 'string' || it.note.trim() === '')),
    )
    .map((it) => ({ id: String(it.id ?? ''), title: String(it.title ?? ''), reason: forced(it) ? '가짜 claude: 건너뛰라고 함' : '처리 내용이 비어 있음' }));
  const final = { changed, skipped, summary: `가짜 claude: 항목 ${items.length}건 중 ${items.length - skipped.length}건 반영` };
  const text = ['반영을 마쳤습니다.', '', '- 한결케미칼 페이지에 한 줄을 덧붙였습니다.', '', JSON.stringify(final)].join('\n');
  printResult(successEnvelope(text));
}

// ---- 초안 실행 ------------------------------------------------------------------------------

/** 반영 실행에서 메일 첨부 읽기 금지(2.14단계 §4-4) */
const ATTACHMENTS_READ_DENY = 'Read(raw/mail/_attachments/**)';

/** 메일 계정 파일(_mail-ingest/.env 등) 읽기 금지가 --disallowedTools 에 있어야 한다(반영·초안 공통) */
const SECRET_READ_DENY = ['Read(_mail-ingest/**)', 'Read(**/.env)', 'Read(**/.env.*)'];

/** 비밀 파일 읽기 금지가 빠졌으면 그 설명 */
function secretDenyProblem() {
  const denied = new Set(toolList(argValue('--disallowedTools')));
  const missing = SECRET_READ_DENY.filter((rule) => !denied.has(rule));
  return missing.length > 0 ? `--disallowedTools 에 ${missing.join(',')} 없음` : null;
}

/** 초안 인자 검사: 편집·셸 도구나 권한 우회가 있거나 계정 파일 읽기 금지가 없으면 그 설명 */
function draftArgsProblem() {
  const banned = new Set(['Edit', 'Write', 'Bash', 'PowerShell']);
  for (const name of ['--tools', '--allowedTools']) {
    const bad = toolList(argValue(name))
      .map((t) => t.replace(/\(.*$/, ''))
      .filter((t) => banned.has(t));
    if (bad.length > 0) return `${name} 에 ${bad.join(',')}`;
  }
  if (argv.some((a) => /dangerously|bypassPermissions/i.test(a))) return '권한 우회 인자';
  return secretDenyProblem();
}

function draftOk(task, withConfirm) {
  const note = typeof task.note === 'string' ? task.note : '';
  const body = withConfirm
    ? `안녕하세요.\n\n문의하신 건 회신드립니다.\n${note}\n완료 예정일은 [확인 필요: 완료 예정일]입니다.\n\n감사합니다.`
    : `안녕하세요.\n\n문의하신 건 회신드립니다.\n${note}\n\n감사합니다.`;
  let references = ['wiki/entities/한결케미칼.md'];
  if (process.env.FAKE_CLAUDE_DRAFT_REFS) references = JSON.parse(process.env.FAKE_CLAUDE_DRAFT_REFS);
  const final = { body, references, notes: withConfirm ? '완료 예정일을 확인하세요' : '' };
  const text = ['초안을 썼습니다.', '', '- 원본 메일과 한결케미칼 페이지를 읽었습니다.', '', JSON.stringify(final)].join('\n');
  printResult(successEnvelope(text));
}

async function draftMain(prompt) {
  const problem = draftArgsProblem();
  if (problem) {
    process.stderr.write(`가짜 claude: 초안 실행에 허용되지 않은 인자 — ${problem}\n`);
    process.exitCode = 3;
    return;
  }
  // 메일함 회신(2.10단계 §7-1)은 <task> 대신 <request> 블록(note·hint·to)
  const task = parseBlock(prompt, 'task') ?? parseBlock(prompt, 'request');
  const mail = parseBlock(prompt, 'mail');
  if (!task || typeof task !== 'object' || !mail || typeof mail !== 'object') {
    process.stderr.write('가짜 claude: 프롬프트의 task·mail 블록을 읽지 못했습니다\n');
    process.exitCode = 3;
    return;
  }

  switch (draftMode) {
    case 'ok':
      draftOk(task, false);
      return;
    case 'confirm':
      draftOk(task, true);
      return;
    case 'slow': {
      // 손자 프로세스: 트리째 끝나는지 보려고 띄운다. 끝내지 못해도 60초 뒤 스스로 끝난다
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
      writeLog({ grandchildPid: grandchild.pid });
      const delay = Number(process.env.FAKE_CLAUDE_DRAFT_DELAY_MS || 30_000);
      const step = 300;
      for (let t = 0; t < delay; t += step) {
        process.stderr.write(`초안 쓰는 중… ${t}ms\n`);
        await sleep(Math.min(step, delay - t));
      }
      grandchild.kill();
      draftOk(task, false);
      return;
    }
    case 'fail':
      process.stderr.write('Error: 가짜 초안 실패 — 인증이 만료되었습니다\n');
      process.stderr.write('다시 로그인하세요\n');
      process.exitCode = 1;
      return;
    case 'nojson':
      printResult(successEnvelope('초안을 썼습니다. 그런데 결과 JSON 은 쓰지 않았습니다.'));
      return;
    case 'iserror':
      process.stderr.write('대화 한도에 걸렸습니다\n');
      printResult({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
      return;
    default:
      process.stderr.write(`가짜 claude: 모르는 초안 모드 ${draftMode}\n`);
      process.exitCode = 4;
  }
}

// ---- 시작 ---------------------------------------------------------------------------------

async function main() {
  const prompt = await readStdin();
  writeLog({ stdinLength: prompt.length, stdinHead: prompt.slice(0, STDIN_HEAD_CHARS) });

  const cwdLower = path.resolve(process.cwd()).toLowerCase();
  if (cwdLower === REAL_WIKI || cwdLower.startsWith(`${REAL_WIKI}\\`)) {
    process.stderr.write('가짜 claude: 실제 위키에서는 동작하지 않습니다\n');
    process.exitCode = 9;
    return;
  }

  const noise = Number(process.env.FAKE_CLAUDE_STDERR_LINES || 0);
  for (let i = 1; i <= noise; i++) process.stderr.write(`잡음 줄 ${i}\n`);

  // --tools 에 Edit 가 없으면 회신 초안 실행(읽기 전용)
  if (!toolList(argValue('--tools')).includes('Edit')) {
    await draftMain(prompt);
    return;
  }

  const secret = secretDenyProblem();
  if (secret) {
    process.stderr.write(`가짜 claude: 반영 실행에 계정 파일 읽기 금지가 없습니다 — ${secret}\n`);
    process.exitCode = 3;
    return;
  }

  const items = parseItems(prompt);
  if (mode !== 'timeout' && items === null) {
    process.stderr.write('가짜 claude: 프롬프트의 items 블록을 읽지 못했습니다\n');
    process.exitCode = 3;
    return;
  }

  // 2.14: 메일 첨부 읽기 금지 · <mails> 블록(늘 있다) · mail 항목마다 같은 ref 의 원소
  if (!toolList(argValue('--disallowedTools')).includes(ATTACHMENTS_READ_DENY)) {
    process.stderr.write(`가짜 claude: 반영 실행에 ${ATTACHMENTS_READ_DENY} 가 없습니다\n`);
    process.exitCode = 3;
    return;
  }
  const mails = parseBlock(prompt, 'mails');
  writeLog({ mails, mailsCloseCount: prompt.split('</mails>').length - 1 });
  if (mode !== 'timeout') {
    if (!Array.isArray(mails)) {
      process.stderr.write('가짜 claude: 프롬프트의 mails 블록을 읽지 못했습니다\n');
      process.exitCode = 3;
      return;
    }
    const refs = new Set(mails.map((m) => m && m.ref));
    const lost = items.filter((it) => it.kind === 'mail' && !refs.has(it.id));
    if (lost.length > 0) {
      process.stderr.write(`가짜 claude: mail 항목 ${lost.length}건의 mails 원소가 없습니다\n`);
      process.exitCode = 3;
      return;
    }
  }

  switch (mode) {
    case 'ok':
      await doOk(items);
      return;
    case 'slow': {
      const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS || 1500);
      const step = 300;
      for (let t = 0; t < delay; t += step) {
        process.stderr.write(`진행 중… ${t}ms\n`);
        await sleep(Math.min(step, delay - t));
      }
      await doOk(items);
      return;
    }
    case 'fail':
      process.stderr.write('Error: 가짜 실패 — 인증이 만료되었습니다\n');
      process.stderr.write('다시 로그인하세요\n');
      printResult({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '가짜 실패: 인증 만료' });
      process.exitCode = 1;
      return;
    case 'timeout': {
      // 손자 프로세스: 트리째 끝나는지 보려고 띄운다. 끝내지 못해도 60초 뒤 스스로 끝난다
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
      writeLog({ grandchildPid: grandchild.pid });
      process.stderr.write('생각하는 중…\n');
      // 끝나지 않는다(가짜가 남아도 2분 뒤 스스로 끝난다)
      setTimeout(() => process.exit(0), 120_000);
      return;
    }
    case 'nojson':
      process.stdout.write('이것은 JSON 이 아닌 출력입니다\n');
      return;
    case 'noresult':
      printResult(successEnvelope('반영을 마쳤습니다. 결과 JSON 은 쓰지 않았습니다.'));
      return;
    case 'iserror':
      printResult({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
      return;
    default:
      process.stderr.write(`가짜 claude: 모르는 모드 ${mode}\n`);
      process.exitCode = 4;
  }
}

main().catch((err) => {
  process.stderr.write(`가짜 claude 오류: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 5;
});
