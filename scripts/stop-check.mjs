#!/usr/bin/env node
// Claude Code Stop 훅: 작업을 끝내기 전에 타입 검사와 단위 테스트를 돌린다.
//
//   통과 → exit 0
//   실패 + stop_hook_active=false → stderr 에 실패 요약(최대 60줄), exit 2 (Claude 가 이어서 고친다)
//   stop_hook_active=true → 검사 없이 exit 0 (이미 한 번 막아서 이어가는 중: 무한 반복 방지)
//
// 입력: stdin 의 훅 JSON. 프로젝트 루트는 이 스크립트 위치(scripts/..) 기준이다.
// 마지막으로 통과한 뒤 소스·설정 파일이 그대로면 다시 돌리지 않는다(--force 로 무시).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_LINES = 60;
/** 훅 제한 시간(180초)보다 먼저 끝나도록 */
const STEP_TIMEOUT_MS = 150_000;
const STDIN_TIMEOUT_MS = 5_000;
const CACHE_FILE = path.join(ROOT, 'node_modules', '.cache', 'wiki-radar', 'stop-check.json');

/** 검사 목록. 로컬 bin 을 node 로 바로 돌리고(npx 와 같은 도구), 없으면 npx 로 돌린다. */
const CHECKS = [
  {
    name: '타입 검사',
    display: 'npx tsc --noEmit -p tsconfig.json',
    bin: path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    npx: 'tsc',
    args: ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'],
    pick: pickTscLines,
  },
  {
    name: '단위 테스트',
    display: 'npx vitest run --reporter=dot',
    bin: path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
    npx: 'vitest',
    // 아직 단위 테스트 파일이 없을 때 '테스트 없음'으로 막지 않는다
    args: ['run', '--reporter=dot', '--passWithNoTests'],
    pick: pickVitestLines,
  },
];

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => {
      // 입력이 닫히지 않은 채 제한 시간이 지나도 프로세스가 붙잡히지 않게 한다
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

function parseHookInput(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

// ── 변경 감지: 타입 검사·단위 테스트 결과를 바꿀 수 있는 파일의 크기·수정 시각 ──

const SIG_DIRS = ['src', 'test', 'config'];
const SIG_SKIP = new Set(['node_modules', '.git', '.vite', 'out', 'test-results', 'playwright-report']);

function sourceSignature() {
  const entries = [];
  const add = (abs) => {
    const st = fs.statSync(abs);
    entries.push(`${path.relative(ROOT, abs).replace(/\\/g, '/')}|${st.size}|${st.mtimeMs}`);
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SIG_SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) add(abs);
    }
  };
  for (const d of SIG_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs);
  }
  // 루트의 설정 파일(tsconfig·package·vite·vitest·forge·playwright 등)
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && /\.(ts|mts|cts|json)$/.test(e.name)) add(path.join(ROOT, e.name));
  }
  entries.sort();
  return createHash('sha1').update(entries.join('\n')).digest('hex');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(signature) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ passed: signature, at: new Date().toISOString() }) + '\n');
  } catch {
    // 캐시는 편의 기능이다. 못 써도 검사 결과에는 영향이 없다.
  }
}

// ── 실행 ──

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

function runCheck(check) {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const useBin = fs.existsSync(check.bin);
    const child = useBin
      ? spawn(process.execPath, [check.bin, ...check.args], { cwd: ROOT, env, windowsHide: true })
      : spawn(['npx', '--no-install', check.npx, ...check.args].join(' '), {
          cwd: ROOT,
          env,
          shell: true,
          windowsHide: true,
        });
    let output = '';
    let timedOut = false;
    const onData = (chunk) => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, STEP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ check, ok: false, code: null, output: `${output}\n실행하지 못함: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\n${STEP_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단함`;
      resolve({ check, ok: !timedOut && code === 0, code, output });
    });
  });
}

// ── 요약 ──

function cleanLines(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
}

/** tsc: 오류 줄(과 그 아래 들여쓴 설명)만. 없으면 전체 */
function pickTscLines(text) {
  const lines = cleanLines(text);
  const picked = [];
  let inError = false;
  for (const l of lines) {
    if (/error TS\d+/.test(l)) {
      inError = true;
      picked.push(l);
    } else if (inError && /^\s/.test(l)) {
      picked.push(l);
    } else {
      inError = false;
    }
  }
  const summary = lines.filter((l) => /^Found \d+ errors?/.test(l));
  return { body: picked.length ? picked : lines, tail: summary };
}

/** vitest: 첫 실패 절부터, 끝의 합계 줄(Test Files·Tests)은 항상 남긴다 */
function pickVitestLines(text) {
  const lines = cleanLines(text).filter((l) => !/^\s*[·.×x*-]+\s*$/.test(l));
  const isSummary = (l) => /^\s*(Test Files|Tests|Errors)\s{2,}/.test(l);
  const isNoise = (l) => /^\s*(Start at|Duration|RUN)\s/.test(l);
  const tail = lines.filter(isSummary);
  const start = lines.findIndex((l) => /Failed Tests|Failed Suites|Unhandled|FAIL\s|Error:/.test(l));
  const body = (start >= 0 ? lines.slice(start) : lines).filter((l) => !isSummary(l) && !isNoise(l));
  return { body, tail };
}

function summarize(failures) {
  const out = ['wiki-radar 작업 종료 검사 실패 — 아래를 고친 뒤 다시 끝내세요.'];
  const perCheck = Math.floor((MAX_LINES - out.length) / failures.length);
  for (const { check, code, output } of failures) {
    const header = `[${check.name} 실패] ${check.display} (exit ${code ?? '-'})`;
    const { body, tail } = check.pick(output);
    const room = Math.max(1, perCheck - 1 - tail.length);
    const shown = body.slice(0, room);
    if (body.length > room) shown[room - 1] = `  … ${body.length - room + 1}줄 생략`;
    out.push(header, ...shown, ...tail.slice(0, Math.max(0, perCheck - 1 - shown.length)));
  }
  return out.slice(0, MAX_LINES).join('\n');
}

async function main() {
  const force = process.argv.includes('--force');
  const input = parseHookInput(await readStdin());

  if (input.stop_hook_active === true) {
    // 이미 한 번 막았다. 다시 막으면 끝없이 이어질 수 있으므로 통과시킨다.
    return 0;
  }

  let signature;
  try {
    signature = sourceSignature();
  } catch {
    signature = undefined;
  }
  if (!force && signature && readCache().passed === signature) {
    console.log('작업 종료 검사: 마지막 통과 뒤 바뀐 파일이 없어 건너뜀');
    return 0;
  }

  const results = await Promise.all(CHECKS.map(runCheck));
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    // 검사하는 동안 파일이 바뀌었으면 통과로 기록하지 않는다
    if (signature) {
      let after;
      try {
        after = sourceSignature();
      } catch {
        after = undefined;
      }
      if (after === signature) writeCache(signature);
    }
    console.log('작업 종료 검사 통과: 타입 검사·단위 테스트');
    return 0;
  }

  process.stderr.write(summarize(failures) + '\n');
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // 스크립트 자체의 문제로 작업을 막지는 않는다(비차단 오류로 알린다)
    process.stderr.write(`stop-check 내부 오류: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
