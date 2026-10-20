// 팀 기본값(2.13단계 명세 §B). electron 을 import 하지 않는다.
//
// - 파일: 팀 위키 루트 아래 `.radar/team-settings.json`(점 폴더 — Obsidian 에 보이지 않고 2.8 동기화가 그대로 사본으로 옮긴다).
// - 읽는 순서: ① WIKI_RADAR_TEAM_SETTINGS(파일 경로 — 있으면 이것만) ② 팀 동기화가 켜져 있으면 내 PC 사본
//   ③ NAS 원본(5초 제한 — 비동기, UNC 가 멈춰도 앱이 막히지 않게) ④ 캐시 team-defaults-cache.json ⑤ 없음 → 내장 기본값.
// - 시험 모드는 ③ 을 teamSync 설정이 임시 폴더를 가리킬 때만 — DEFAULT_TEAM_REMOTE·UNC(\\…) 는 읽지 않는다(실제 NAS 를 부르지 않는다).
// - 팀원 누구나 고칠 수 있는 파일이라: 비밀 키(pass·password·key·apiKey·token·secret)가 어느 깊이든 있으면 파일 전체를 쓰지 않고,
//   AI(로컬 LLM 주소·모델) 칸 `ai` 는 통째로 버린다 — 각자 설정·[연결 시험](소유자 결정 2026-10-19).
// - 비밀번호가 가는 서버(메일 받기·보내기 서버, VOC 주소)는 내장 서버와 같은 도메인이거나 사설망·루프백 IP 일 때만 받는다 —
//   팀 파일 하나로 모두의 비밀번호를 다른 서버로 돌리지 못하게. 업데이트 서버는 끄기('off')만 받는다(받은 설치 파일을
//   서명 확인 없이 설치하므로, 팀 파일로 다른 서버를 가리키게 하지 못한다).
import fs from 'node:fs';
import path from 'node:path';
import type { TeamDefaultValues, TeamDefaultsSource, TeamDefaultsView } from '../../shared/types';
import { wikiPathProblem } from '../appSettings';
import { localDateTimeString } from '../config';
import { writeJsonAtomic } from '../queue';
import { DEFAULT_SMTP_HOST, isLoopbackHost } from '../mail/account';
import { VOC_DEFAULT_API_URL, normalizeVocApiUrl } from '../voc/api';
import { errCode, readTextFile } from '../wiki/fsutil';
import { hostProblem, intervalProblem, isPrivateIp, normalizeUpdateUrl, portProblem } from './fields';

/** 팀 위키 루트 기준 파일 위치 */
export const TEAM_SETTINGS_REL = '.radar/team-settings.json';
export const TEAM_DEFAULTS_CACHE_FILE = 'team-defaults-cache.json';
export const TEAM_SETTINGS_MAX_BYTES = 64 * 1024;
/** NAS 읽기 시간 제한 */
export const TEAM_REMOTE_TIMEOUT_MS = 5_000;
/** getTeamDefaults({refresh:true}) 를 이 안에 다시 부르면 기억한 것 */
export const TEAM_REFRESH_MIN_MS = 30_000;

const SECRET_KEY_NAMES: ReadonlySet<string> = new Set(['pass', 'password', 'key', 'apikey', 'token', 'secret']);
export const TEAM_SECRET_PROBLEM = '팀 설정 파일에 비밀번호·키가 들어 있어 쓰지 않습니다';
export const TEAM_VERSION_PROBLEM = '팀 설정 파일 형식이 다릅니다(version)';

/** 어느 깊이든 비밀 키 이름이 있나 */
function hasSecretKey(v: unknown, depth = 0): boolean {
  if (depth > 8 || !v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => hasSecretKey(x, depth + 1));
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY_NAMES.has(k.toLowerCase())) return true;
    if (hasSecretKey(x, depth + 1)) return true;
  }
  return false;
}

/** 호스트 이름의 끝 두 마디(예: smtps.example.com → example.com) */
function baseDomain(host: string): string {
  return host.toLowerCase().split('.').slice(-2).join('.');
}

/**
 * 팀 기본값으로 받는 비밀이 가는 서버인가: 내장 서버와 같은 도메인(그 아래 이름 포함), 또는 사설망·루프백 IP.
 * 아니면 문제 문장
 */
export function teamServerProblem(host: string, builtinHost: string): string | null {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateIp(h) || isLoopbackHost(h)) return null;
  const base = baseDomain(builtinHost);
  if (h === base || h.endsWith(`.${base}`)) return null;
  return `팀 기본값으로는 ${base} 의 서버나 사내망 IP 만 받습니다(비밀번호가 가는 서버라 — 다른 서버는 각자 설정에서 넣으세요)`;
}

const VOC_DEFAULT_HOST = new URL(VOC_DEFAULT_API_URL).hostname;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 팀 설정 JSON → 값·문제. 필드마다 화면 값과 같은 검사, 틀린 필드만 버린다(문제 목록에 남긴다). 모르는 키는 무시 */
export function parseTeamDefaults(raw: unknown): { values: TeamDefaultValues; problems: string[] } {
  const problems: string[] = [];
  const values: TeamDefaultValues = {};
  const r = obj(raw);
  if (!r || r.version !== 1) return { values, problems: [TEAM_VERSION_PROBLEM] };
  if (hasSecretKey(r)) return { values, problems: [TEAM_SECRET_PROBLEM] };
  const drop = (field: string, why: string) => problems.push(`팀 설정 ${field} 를 버림: ${why}`);

  const mi = obj(r.mailIn);
  if (mi) {
    const out: NonNullable<TeamDefaultValues['mailIn']> = {};
    if (mi.host !== undefined) {
      const p = hostProblem(mi.host) ?? teamServerProblem(mi.host as string, DEFAULT_SMTP_HOST);
      if (p) drop('mailIn.host', p);
      else out.host = (mi.host as string).trim();
    }
    if (mi.port !== undefined) (portProblem(mi.port) ? drop('mailIn.port', portProblem(mi.port) as string) : (out.port = mi.port as number));
    if (mi.ssl !== undefined) (typeof mi.ssl === 'boolean' ? (out.ssl = mi.ssl) : drop('mailIn.ssl', '참/거짓이 아닙니다'));
    if (mi.intervalMinutes !== undefined) {
      const p = intervalProblem(mi.intervalMinutes);
      if (p) drop('mailIn.intervalMinutes', p);
      else out.intervalMinutes = mi.intervalMinutes as number;
    }
    if (Object.keys(out).length) values.mailIn = out;
  }
  const mo = obj(r.mailOut);
  if (mo) {
    const out: NonNullable<TeamDefaultValues['mailOut']> = {};
    if (mo.host !== undefined) {
      const p = hostProblem(mo.host) ?? teamServerProblem(mo.host as string, DEFAULT_SMTP_HOST);
      if (p) drop('mailOut.host', p);
      else out.host = (mo.host as string).trim();
    }
    if (mo.port !== undefined) (portProblem(mo.port) ? drop('mailOut.port', portProblem(mo.port) as string) : (out.port = mo.port as number));
    if (mo.security !== undefined) {
      if (mo.security === 'ssl' || mo.security === 'starttls') out.security = mo.security;
      else drop('mailOut.security', 'ssl 또는 starttls 여야 합니다');
    }
    if (Object.keys(out).length) values.mailOut = out;
  }
  // AI(로컬 LLM 주소·모델)는 팀 기본값으로 받지 않는다 — 각자 설정 › AI 에서 넣고 [연결 시험]을 거친다(소유자 결정 2026-10-19)
  if (r.ai !== undefined) drop('ai', 'AI 는 팀 기본값으로 정하지 않습니다 — 각자 설정 › AI 에서 넣고 [연결 시험]을 누르세요');
  const voc = obj(r.voc);
  if (voc && voc.apiUrl !== undefined) {
    const u = normalizeVocApiUrl(voc.apiUrl);
    const p = u ? teamServerProblem(new URL(u).hostname, VOC_DEFAULT_HOST) : 'https://호스트[:포트] 모양이 아닙니다';
    if (u && !p) values.voc = { apiUrl: u };
    else drop('voc.apiUrl', p as string);
  }
  const up = obj(r.update);
  if (up && up.url !== undefined) {
    const u = normalizeUpdateUrl(up.url);
    if (!('url' in u)) drop('update.url', u.problem);
    else if (u.url !== 'off') drop('update.url', "팀 기본값으로는 자동 업데이트 끄기('off')만 됩니다 — 다른 업데이트 서버는 각자 설정 › 정보에서 넣으세요");
    else values.update = { url: u.url };
  }
  const ts = obj(r.teamSync);
  if (ts && ts.remote !== undefined) {
    const p = wikiPathProblem(ts.remote);
    if (p) drop('teamSync.remote', p);
    else values.teamSync = { remote: (ts.remote as string).trim() };
  }
  return { values, problems };
}

function isEmptyValues(v: TeamDefaultValues): boolean {
  return Object.keys(v).length === 0;
}

/** 파일 하나 읽기 결과 */
type FileRead = { ok: true; text: string; mtime?: string } | { ok: false; missing: boolean; problem?: string };

/** 시간 제한 안에서 비동기로 읽는다(크기 먼저) */
export async function readTeamFile(file: string, timeoutMs: number): Promise<FileRead> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FileRead>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, missing: false, problem: `팀 설정 파일을 ${Math.round(timeoutMs / 1000)}초 안에 읽지 못했습니다` }), timeoutMs);
    timer.unref?.();
  });
  const job = (async (): Promise<FileRead> => {
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) return { ok: false, missing: true };
      if (st.size > TEAM_SETTINGS_MAX_BYTES) return { ok: false, missing: false, problem: '팀 설정 파일이 너무 큽니다(64KB 넘음)' };
      const text = await fs.promises.readFile(file, 'utf8');
      return { ok: true, text, mtime: localDateTimeString(st.mtime) };
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, missing: true };
      return { ok: false, missing: false, problem: `팀 설정 파일을 읽지 못했습니다 (${code})` };
    }
  })();
  try {
    return await Promise.race([job, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CacheFile {
  readAt: string;
  from: string;
  values: TeamDefaultValues;
}

export function readTeamDefaultsCache(cacheFile: string): CacheFile | null {
  try {
    const raw = JSON.parse(readTextFile(cacheFile)) as unknown;
    const r = obj(raw);
    if (!r || typeof r.readAt !== 'string' || typeof r.from !== 'string') return null;
    // 캐시도 같은 검사를 거친다(사람이 고쳤을 수 있다)
    const parsed = parseTeamDefaults({ version: 1, ...(obj(r.values) ?? {}) });
    return { readAt: r.readAt, from: r.from, values: parsed.values };
  } catch {
    return null;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface TeamDefaultsReadOptions {
  env: NodeJS.ProcessEnv;
  /** 팀 동기화 설정(없으면 꺼짐·기본 경로). configured = app-settings 에 teamSync 가 있나 */
  teamSync: { enabled: boolean; remote: string; local: string; configured: boolean };
  /** 내장 NAS 경로(DEFAULT_TEAM_REMOTE) */
  defaultRemote: string;
  cacheFile: string;
  now: () => Date;
  testMode: boolean;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

/** UNC(\\서버\…) 경로인가 */
function isUnc(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p);
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).toLowerCase();
  return n(a) === n(b);
}

/** 폴더가 시간 제한 안에 보이나(NAS 가 멈춰도 앱이 막히지 않게) */
async function dirVisible(dir: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      fs.promises.stat(dir).then(
        (st) => st.isDirectory(),
        () => false,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 순서대로 읽는다(§B-1). 던지지 않는다 */
export async function readTeamDefaults(o: TeamDefaultsReadOptions): Promise<TeamDefaultsView> {
  const timeoutMs = o.timeoutMs ?? TEAM_REMOTE_TIMEOUT_MS;
  const problems: string[] = [];
  /** 파일 자체의 문제(형식·비밀 키·버린 필드·폴더는 보이는데 파일 없음) — 캐시로 넘어갈 때 점검에 warn 으로 낸다 */
  const fileProblems: string[] = [];
  const readAt = localDateTimeString(o.now());

  const tryFile = async (file: string, source: TeamDefaultsSource, root?: string): Promise<TeamDefaultsView | null> => {
    const r = await readTeamFile(file, timeoutMs);
    if (!r.ok) {
      // 시간 초과·읽기 오류는 「NAS 가 안 보임」. 폴더는 보이는데 파일만 없으면 지워진 것 — 파일 문제
      if (r.problem) problems.push(r.problem);
      else if (r.missing && root && (await dirVisible(root, timeoutMs))) fileProblems.push(`팀 설정 파일이 없습니다(${file})`);
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(r.text.replace(/^﻿/, ''));
    } catch {
      problems.push('팀 설정 파일이 JSON 이 아닙니다');
      fileProblems.push('팀 설정 파일이 JSON 이 아닙니다');
      return null;
    }
    const parsed = parseTeamDefaults(raw);
    problems.push(...parsed.problems);
    // 비밀이 들었거나 version 이 다르면 그 파일은 쓰지 않는다(값 없음) — 다음 출처를 본다
    if (isEmptyValues(parsed.values) && parsed.problems.length > 0) {
      fileProblems.push(...parsed.problems);
      return null;
    }
    const view: TeamDefaultsView = { source, path: file, readAt, problems: [...problems], values: parsed.values };
    if (r.mtime) view.fileMtime = r.mtime;
    return view;
  };

  // ① 환경 변수 — 있으면 이것만
  const envFile = o.env.WIKI_RADAR_TEAM_SETTINGS?.trim();
  if (envFile) {
    const got = await tryFile(path.resolve(envFile), 'env');
    return got ?? { source: 'none', path: path.resolve(envFile), problems: problems.length ? problems : ['WIKI_RADAR_TEAM_SETTINGS 의 파일이 없습니다'], values: {} };
  }

  let found: TeamDefaultsView | null = null;
  // ② 내 PC 사본
  if (o.teamSync.enabled && o.teamSync.local) {
    found = await tryFile(path.join(o.teamSync.local, ...TEAM_SETTINGS_REL.split('/')), 'local', o.teamSync.local);
  }
  // ③ NAS 원본
  if (!found) {
    const remote = o.teamSync.configured ? o.teamSync.remote : o.defaultRemote;
    const blocked = o.testMode && (!o.teamSync.configured || isUnc(remote) || samePath(remote, o.defaultRemote));
    if (remote && !blocked && !wikiPathProblem(remote)) {
      found = await tryFile(path.join(remote, ...TEAM_SETTINGS_REL.split('/')), 'remote', remote);
    }
  }
  if (found) {
    // 캐시: 값이 같으면 쓰지 않는다
    if (!isEmptyValues(found.values)) {
      const cached = readTeamDefaultsCache(o.cacheFile);
      if (!cached || !sameJson(cached.values, found.values) || cached.from !== found.path) {
        try {
          writeJsonAtomic(o.cacheFile, { readAt, from: found.path ?? '', values: found.values } satisfies CacheFile);
        } catch (err) {
          o.warn?.(`팀 기본값 캐시를 저장하지 못함: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return found;
  }
  // ④ 캐시
  const cached = readTeamDefaultsCache(o.cacheFile);
  if (cached && !isEmptyValues(cached.values)) {
    // problems 에는 파일 문제만 둔다 — 비어 있으면 점검은 「NAS 가 안 보임」(ok), 있으면 warn(§D-3)
    return { source: 'cache', path: cached.from, readAt: cached.readAt, problems: [...new Set(fileProblems)], values: cached.values };
  }
  // ⑤ 없음
  return { source: 'none', problems, values: {} };
}

/**
 * 팀 기본값을 들고 있는 것(main 이 하나). current() 는 동기(소비자가 부를 때마다 resolver 를 거친다) — 처음에는 캐시 파일,
 * refresh() 가 끝나면 새 값. 바뀌면 onChange
 */
export class TeamDefaultsHolder {
  private value: TeamDefaultsView;
  private lastReadMs = 0;
  private job: Promise<TeamDefaultsView> | null = null;

  constructor(
    private readonly opts: () => TeamDefaultsReadOptions,
    private readonly onChange: (view: TeamDefaultsView) => void = () => {},
    private readonly clock: () => number = Date.now,
  ) {
    const o = opts();
    const envFile = o.env.WIKI_RADAR_TEAM_SETTINGS?.trim();
    const cached = envFile ? null : readTeamDefaultsCache(o.cacheFile);
    this.value =
      cached && !isEmptyValues(cached.values)
        ? { source: 'cache', path: cached.from, readAt: cached.readAt, problems: [], values: cached.values }
        : { source: 'none', problems: [], values: {} };
  }

  current(): TeamDefaultsView {
    return this.value;
  }

  values(): TeamDefaultValues {
    return this.value.values;
  }

  /** 다시 읽는다. force 가 아니면 30초 안의 다시 부름은 기억한 것 */
  refresh(force = false): Promise<TeamDefaultsView> {
    if (this.job) return this.job;
    if (!force && this.lastReadMs !== 0 && this.clock() - this.lastReadMs < TEAM_REFRESH_MIN_MS) return Promise.resolve(this.value);
    const job = readTeamDefaults(this.opts())
      .then((next) => {
        const changed = !sameJson(next.values, this.value.values) || next.source !== this.value.source || !sameJson(next.problems, this.value.problems);
        this.value = next;
        this.lastReadMs = this.clock();
        if (changed) this.onChange(next);
        return next;
      })
      .finally(() => {
        this.job = null;
      });
    this.job = job;
    return job;
  }
}
