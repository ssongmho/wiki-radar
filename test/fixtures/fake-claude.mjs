// 시험용 가짜 claude (docs/stage2-contract.md §6). runReflect 가 `node fake-claude.mjs <인자…>` 로 부른다.
// 네트워크를 쓰지 않고, 작업 폴더(cwd = 위키 사본) 밖에는 쓰지 않는다. 실제 위키에서 부르면 아무것도 하지 않고 끝난다.
//
// 환경변수
//   FAKE_CLAUDE_MODE     ok(기본) · fail · timeout · nojson · slow · noresult · iserror
//   FAKE_CLAUDE_LOG      있으면 받은 인자·작업 폴더·표준입력 앞부분을 이 파일에 JSON 으로 적는다(인자·프롬프트 검증용)
//   FAKE_CLAUDE_CHANGED  ok·slow 에서 결과 JSON 의 changed 를 이 JSON 배열로 바꾼다(경로 정규화 시험용)
//   FAKE_CLAUDE_DELAY_MS slow 의 대기 시간(기본 1500)
//   FAKE_CLAUDE_STDERR_LINES 있으면 시작할 때 표준에러에 이만큼 줄을 찍는다(진행 기록 줄 수 제한 시험용)
//
// 모드
//   ok       wiki/entities/한결케미칼.md 끝에 한 줄을 덧붙이고 Claude --output-format json 형식의 성공 결과를 낸다
//   slow     표준에러에 진행 줄을 찍으며 잠시 기다린 뒤 ok 와 같다
//   fail     표준에러에 오류를 찍고 is_error 결과와 함께 종료 코드 1
//   timeout  손자 프로세스를 하나 띄우고(트리 종료 확인용, pid 를 로그에 적는다) 끝나지 않는다
//   nojson   JSON 이 아닌 글을 내고 종료 코드 0
//   noresult 성공 결과지만 result 글 끝에 결과 JSON 이 없다
//   iserror  종료 코드 0 이지만 is_error:true (대화 한도 초과)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_WIKI = path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI').toLowerCase();
const ENTITY = path.join('wiki', 'entities', '한결케미칼.md');
const STDIN_HEAD_CHARS = 20_000;

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const logPath = process.env.FAKE_CLAUDE_LOG;
const record = {
  pid: process.pid,
  mode,
  argv: process.argv.slice(2),
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

/** 프롬프트의 <items> 블록을 JSON 으로 읽는다(블록이 온전한지 확인). 못 읽으면 null */
function parseItems(prompt) {
  const open = prompt.indexOf('\n<items>\n');
  const close = prompt.indexOf('\n</items>\n');
  if (open < 0 || close < 0 || close < open) return null;
  // 여는·닫는 태그가 하나씩만 있어야 한다(메모 속 </items> 가 블록을 깨면 여기서 걸린다)
  if (prompt.split('<items>').length !== 2 || prompt.split('</items>').length !== 2) return null;
  try {
    const items = JSON.parse(prompt.slice(open + '\n<items>\n'.length, close));
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
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
  const skipped = items
    .filter((it) => typeof it.note !== 'string' || it.note.trim() === '')
    .map((it) => ({ title: String(it.title ?? ''), reason: '처리 내용이 비어 있음' }));
  const final = { changed, skipped, summary: `가짜 claude: 항목 ${items.length}건 중 ${items.length - skipped.length}건 반영` };
  const text = ['반영을 마쳤습니다.', '', '- 한결케미칼 페이지에 한 줄을 덧붙였습니다.', '', JSON.stringify(final)].join('\n');
  printResult(successEnvelope(text));
}

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

  const items = parseItems(prompt);
  if (mode !== 'timeout' && items === null) {
    process.stderr.write('가짜 claude: 프롬프트의 items 블록을 읽지 못했습니다\n');
    process.exitCode = 3;
    return;
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
