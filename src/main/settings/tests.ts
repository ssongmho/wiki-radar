// 연결 시험 중 파일 쪽(2.13단계 명세 §C-1 위키 칸·§C-5 VOC 칸). electron 을 import 하지 않는다.
// POP3·SMTP·LLM 시험은 각 클라이언트(mail/pop3.ts·mail/smtp.ts·ai/llm.ts)가 한다 — 이 파일은 위키 폴더와 VOC 서버 응답.
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionTestResult, ConnectionTestStep } from '../../shared/types';
import { readTeamFile, TEAM_REMOTE_TIMEOUT_MS, TEAM_SETTINGS_REL } from './teamDefaults';

/** 사본 쓰기 시험에 쓰는 임시 파일 이름(동기화 제외 이름 — teamSync/engine 의 임시 파일 규칙) */
export const WIKI_WRITE_PROBE = '.wiki-radar-tmp';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 시간 제한 안에 폴더가 있고 읽히는가(UNC 가 멈춰도 막히지 않게 비동기) */
async function readableDir(p: string, timeoutMs: number): Promise<{ ok: true; entries: number } | { ok: false; problem: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; problem: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, problem: `${Math.round(timeoutMs / 1000)}초 안에 읽지 못했습니다` }), timeoutMs);
  });
  const job = fs.promises
    .readdir(p)
    .then((names) => ({ ok: true as const, entries: names.length }))
    .catch((err: NodeJS.ErrnoException) => ({ ok: false as const, problem: err.code === 'ENOENT' ? '폴더가 없습니다' : `읽지 못했습니다 (${err.code ?? err.message})` }));
  try {
    return await Promise.race([job, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WikiTestInput {
  /** 개인 위키: 폴더 경로, 또는 'none'(「없음」) */
  personal: string | 'none';
  team: { enabled: boolean; remote: string; local: string };
  testMode: boolean;
  now?: () => number;
  timeoutMs?: number;
}

/** 위키 칸 [연결 시험]: 개인 위키(있음·읽힘·위키 모양) · 팀(NAS 읽힘·사본 쓰기 가능·팀 기본값 파일). 던지지 않는다 */
export async function testWikiFolders(input: WikiTestInput): Promise<ConnectionTestResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const timeoutMs = input.timeoutMs ?? TEAM_REMOTE_TIMEOUT_MS;
  const steps: ConnectionTestStep[] = [];

  if (input.personal === 'none') {
    steps.push({ label: '개인 위키', ok: true, detail: '쓰지 않음(없음)' });
  } else {
    const r = await readableDir(input.personal, timeoutMs);
    if (!r.ok) steps.push({ label: '개인 위키', ok: false, detail: r.problem });
    else {
      const shaped = isDir(path.join(input.personal, 'wiki')) || isDir(path.join(input.personal, '_todo-sync'));
      steps.push(
        shaped
          ? { label: '개인 위키', ok: true, detail: '읽힘 · 위키 모양' }
          : { label: '개인 위키', ok: true, warn: true, detail: '읽히지만 wiki/·_todo-sync/ 가 없습니다 — 위키 폴더가 맞는지 확인하세요' },
      );
    }
  }

  if (input.team.enabled) {
    const unc = /^[\\/]{2}[^\\/]/.test(input.team.remote);
    if (input.testMode && unc) {
      steps.push({ label: 'NAS', ok: true, warn: true, detail: '시험 중이라 NAS(UNC)는 시험하지 않음' });
    } else {
      const r = await readableDir(input.team.remote, timeoutMs);
      steps.push(r.ok ? { label: 'NAS', ok: true, detail: '읽힘' } : { label: 'NAS', ok: false, detail: r.problem });
      if (r.ok) {
        const f = await readTeamFile(path.join(input.team.remote, ...TEAM_SETTINGS_REL.split('/')), timeoutMs);
        steps.push(
          f.ok
            ? { label: '팀 기본값 파일', ok: true, detail: TEAM_SETTINGS_REL }
            : { label: '팀 기본값 파일', ok: true, warn: true, detail: f.missing ? `없음(${TEAM_SETTINGS_REL}) — 내장 기본값을 씀` : (f.problem ?? '읽지 못함') },
        );
      }
    }
    // 사본 쓰기: 폴더가 없으면 첫 동기화가 만든다 — 상위 폴더에 쓸 수 있는지 본다
    const target = isDir(input.team.local) ? input.team.local : path.dirname(input.team.local);
    const probe = path.join(target, WIKI_WRITE_PROBE);
    try {
      fs.writeFileSync(probe, 'radar', { flag: 'wx' });
      fs.rmSync(probe, { force: true });
      steps.push({ label: '내 PC 사본', ok: true, detail: isDir(input.team.local) ? '쓰기 가능' : '아직 없음 — 첫 동기화가 만듦' });
    } catch (err) {
      try {
        fs.rmSync(probe, { force: true });
      } catch {
        // 남아도 동기화 제외 이름이다
      }
      steps.push({ label: '내 PC 사본', ok: false, detail: `쓰지 못했습니다 (${(err as NodeJS.ErrnoException).code ?? String(err)})` });
    }
  } else {
    steps.push({ label: '팀 위키', ok: true, detail: '동기화 꺼짐' });
  }
  return { ok: steps.every((s) => s.ok), steps, ms: Math.max(0, now() - started) };
}

/** 이 PC(루프백) 주소인가 */
export function isLocalHttpUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** VOC 서버 주소로 GET /(5초) — HTTP 응답이 오면 "서버 응답 · 로그인 필요". 시험 모드는 이 PC 주소만 */
export async function probeHttp(
  url: string,
  opts: { testMode: boolean; timeoutMs?: number; fetchImpl?: (u: string, init: { method: string; signal: AbortSignal }) => Promise<Response> },
): Promise<{ ok: true; status: number } | { ok: false; problem: string }> {
  if (opts.testMode && !isLocalHttpUrl(url)) return { ok: false, problem: '시험 중에는 이 PC 밖의 VOC 서버에 접속하지 않습니다' };
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const f = opts.fetchImpl ?? ((u: string, init: { method: string; signal: AbortSignal }) => fetch(u, init));
    const res = await f(`${url.replace(/\/+$/, '')}/`, { method: 'GET', signal: controller.signal });
    await res.body?.cancel().catch(() => undefined);
    return { ok: true, status: res.status };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, problem: `${Math.round(timeoutMs / 1000)}초 안에 응답이 없습니다` };
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    return { ok: false, problem: `연결하지 못했습니다${typeof code === 'string' ? ` (${code})` : ''}` };
  } finally {
    clearTimeout(timer);
  }
}
