// 앱 설정(app-settings.json): 위키 폴더 위치와 처음 실행 점검을 닫았는지, 팀 위키 동기화, 설정 › 나·알림. electron 을 import 하지 않는다.
// 계약: docs/stage2.7-contract.md §1·§2, docs/stage2.8-contract.md, docs/stage2.9-contract.md §9
//
// - 저장은 queue.ts 의 원자적 쓰기(writeJsonAtomic). 깨졌거나(JSON 아님) 읽지 못하면 빈 설정으로 시작하고 경고만 남긴다
//   — 위키 위치를 못 읽으면 기본 위치를 쓰고, 점검 화면이 한 번 더 뜰 뿐이다. 파일은 사람이 고를 때만 덮어쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { parseNotifySettings, parseShellSettings } from '../shared/notify';
import { ME_ALIASES_MAX, meNameProblem, normName } from '../shared/team';
import type { MeSettings, NotifySettings, ShellSettings, WikiSource } from '../shared/types';
import { writeJsonAtomic } from './queue';
import {
  nonEmpty,
  parseAiSettings,
  parseMailInSettings,
  parseMailOutSettings,
  parseUpdateSettings,
  type AiSettings,
  type MailInSettings,
  type MailOutSettings,
  type UpdateSettings,
} from './settings/fields';
import { errCode, readTextFile } from './wiki/fsutil';

export const APP_SETTINGS_FILE = 'app-settings.json';
const WIKI_PATH_MAX = 1024;

export interface AppSettings {
  /** 사람이 고른 위키 폴더(절대경로). 없으면 기본 위치 */
  wikiRoot?: string;
  /** 처음 실행 점검 화면을 [확인]으로 닫았는가 */
  setupSeen?: boolean;
  /** 팀 위키 동기화(2.8단계). 없으면 꺼짐·기본 경로 */
  teamSync?: { enabled: boolean; remote: string; local: string };
  /** 설정 › 나(2.9단계). 사람이 저장할 때만 생긴다 */
  me?: MeSettings;
  /** 설정 › 알림(2.9단계 §9). 사람이 저장할 때만 생긴다 — 없으면 기본값 */
  notify?: NotifySettings;
  /** 창 닫기 동작(2.12단계 §6-1b). 사람이 저장할 때만 생긴다 — 없으면 'tray' */
  shell?: ShellSettings;
  // ---- 2.13단계(설정 나머지 칸) — 모든 필드 선택, 없으면 "사람이 정하지 않음"(출처 계산의 근거 — settings/resolve.ts)
  /** 개인 위키 「없음」을 골랐다(wikiRoot 보다 앞선다 — wikiRoot 는 남겨 두어 「폴더」로 돌아올 수 있게) */
  wikiNone?: true;
  mailIn?: MailInSettings;
  mailOut?: MailOutSettings;
  ai?: AiSettings;
  update?: UpdateSettings;
}

/** 개인 위키 「없음」일 때 config.wikiRoot 에 넣는 자리 표시 경로(데이터 폴더 안 — 만들지 않는다). 2.13단계 §C-1 */
export const NO_PERSONAL_WIKI_DIR = '.no-personal-wiki';
/** 개인 위키 「없음」에서 위키 쓰기를 거부하는 문장 */
export const WIKI_NONE_REFUSED = '개인 위키를 쓰지 않도록 설정했습니다(설정 › 위키)';

/** 팀 위키 기본 위치: 업무 NAS 원본과 내 PC 사본(2.8단계) */
export const DEFAULT_TEAM_REMOTE = '\\\\192.168.50.133\\team-share\\WIKI';
export function defaultTeamLocal(home: string): string {
  return path.join(home, 'dc-wiki');
}

/** 절대경로인가. Windows 는 드라이브(`C:\`)나 UNC(`\\서버\공유`)로 시작해야 한다 */
export function isAbsoluteDirPath(p: string): boolean {
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
  return path.isAbsolute(p);
}

/** 위키 폴더 값 검사. 문제가 있으면 한국어 문장 */
export function wikiPathProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return '위키 폴더를 고르세요';
  const p = value.trim();
  if (p.length > WIKI_PATH_MAX) return '위키 폴더 경로가 너무 깁니다';
  if (/[\u0000-\u001f]/.test(p)) return '위키 폴더 경로에 쓸 수 없는 글자가 있습니다';
  if (!isAbsoluteDirPath(p)) return '위키 폴더는 전체 경로(C:\\… 또는 \\\\서버\\…)여야 합니다';
  return null;
}

/**
 * 설정 › 나 입력 검사(2.9단계 §9). 이름·표기마다 앞뒤 공백을 떼고 1~50자, `[`·`]`·`,`·줄바꿈·제어 문자 없음, 표기 10개까지,
 * 같은 normName 은 하나로(이름과 같은 표기도 뺀다). 틀리면 한국어 문장으로 예외
 */
export function checkMeSettings(raw: unknown): MeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('잘못된 요청입니다: 나 설정');
  const r = raw as Record<string, unknown>;
  const out: MeSettings = { aliases: [] };
  if (r.name !== undefined && r.name !== null) {
    if (typeof r.name !== 'string') throw new Error('잘못된 요청입니다: name');
    const name = r.name.trim();
    if (name !== '') {
      const problem = meNameProblem(name);
      if (problem) throw new Error(`이름: ${problem}`);
      out.name = name;
    }
  }
  const aliases = r.aliases ?? [];
  if (!Array.isArray(aliases)) throw new Error('잘못된 요청입니다: aliases');
  if (aliases.length > ME_ALIASES_MAX * 4) throw new Error('잘못된 요청입니다: aliases');
  const seen = new Set<string>(out.name ? [normName(out.name)] : []);
  for (const a of aliases) {
    if (typeof a !== 'string') throw new Error('잘못된 요청입니다: aliases');
    const alias = a.trim();
    const problem = meNameProblem(alias);
    if (problem) throw new Error(`다른 표기 「${alias.slice(0, 20)}」: ${problem}`);
    const key = normName(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    out.aliases.push(alias);
  }
  if (out.aliases.length > ME_ALIASES_MAX) throw new Error(`다른 표기는 ${ME_ALIASES_MAX}개까지입니다`);
  return out;
}

/** 파일 내용 → 설정. 알려진 필드만, 형이 틀린 필드는 버린다 */
export function parseAppSettings(raw: unknown): AppSettings {
  const out: AppSettings = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.wikiRoot === 'string' && !wikiPathProblem(r.wikiRoot)) out.wikiRoot = path.resolve(r.wikiRoot.trim());
  if (r.setupSeen === true) out.setupSeen = true;
  const ts = r.teamSync as Record<string, unknown> | undefined;
  if (
    ts &&
    typeof ts === 'object' &&
    typeof ts.enabled === 'boolean' &&
    typeof ts.remote === 'string' &&
    typeof ts.local === 'string' &&
    !wikiPathProblem(ts.remote) &&
    !wikiPathProblem(ts.local)
  ) {
    out.teamSync = { enabled: ts.enabled, remote: ts.remote.trim(), local: path.resolve(ts.local.trim()) };
  }
  if (r.me !== undefined) {
    try {
      out.me = checkMeSettings(r.me);
    } catch {
      // 사람이 파일을 고쳐 틀렸으면 나 설정만 버린다(VOC 로그인 이름으로 돌아간다)
    }
  }
  // 알림 설정은 형이 틀린 칸만 기본으로 되돌린다(전체를 버리지 않는다 — 2.9단계 §9)
  if (r.notify !== undefined) out.notify = parseNotifySettings(r.notify);
  if (r.shell !== undefined) out.shell = parseShellSettings(r.shell);
  // 2.13단계: 칸 안에서 형이 틀린 필드만 버린다(칸 전체를 버리지 않는다)
  if (r.wikiNone === true) out.wikiNone = true;
  const mailIn = nonEmpty(parseMailInSettings(r.mailIn));
  if (mailIn) out.mailIn = mailIn;
  const mailOut = nonEmpty(parseMailOutSettings(r.mailOut));
  if (mailOut) out.mailOut = mailOut;
  const ai = nonEmpty(parseAiSettings(r.ai));
  if (ai) out.ai = ai;
  const update = nonEmpty(parseUpdateSettings(r.update));
  if (update) out.update = update;
  return out;
}

export interface WikiLocation {
  path: string;
  source: WikiSource;
}

/**
 * 위키 폴더: WIKI_RADAR_WIKI → 설정 「없음」(dataDir 를 주면 — 자리 표시 경로, source 'none') → 설정 wikiRoot → 기본 위치.
 * 「없음」에 빈 경로를 쓰지 않는 이유: path.resolve('') 는 작업 폴더라 위키를 쓰는 27곳이 엉뚱한 폴더를 보게 된다(2.13단계 §C-1)
 */
export function resolveWikiRoot(env: NodeJS.ProcessEnv, settings: AppSettings, defaultRoot: string, dataDir?: string): WikiLocation {
  const fromEnv = env.WIKI_RADAR_WIKI?.trim();
  if (fromEnv) return { path: path.resolve(fromEnv), source: 'env' };
  if (settings.wikiNone && dataDir) return { path: path.resolve(dataDir, NO_PERSONAL_WIKI_DIR), source: 'none' };
  if (settings.wikiRoot) return { path: path.resolve(settings.wikiRoot), source: 'settings' };
  return { path: path.resolve(defaultRoot), source: 'default' };
}

export class AppSettingsStore {
  readonly file: string;
  private cache: AppSettings | null = null;

  constructor(
    dataDir: string,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.file = path.join(dataDir, APP_SETTINGS_FILE);
  }

  get(): AppSettings {
    if (this.cache) return { ...this.cache };
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code !== 'ENOENT') this.warn(`앱 설정(${APP_SETTINGS_FILE})을 읽지 못해 기본값을 씀 (${code})`);
      else this.cache = {};
      return {};
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.warn(`앱 설정(${APP_SETTINGS_FILE})이 JSON 이 아니라 기본값을 씀`);
      raw = null;
    }
    this.cache = parseAppSettings(raw);
    return { ...this.cache };
  }

  /** 바꿀 필드만 넘긴다. undefined 인 필드는 지운다 */
  update(patch: Partial<Record<keyof AppSettings, AppSettings[keyof AppSettings] | undefined>>): AppSettings {
    const next: AppSettings = { ...this.get() };
    for (const [key, value] of Object.entries(patch) as [keyof AppSettings, unknown][]) {
      if (value === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = value;
    }
    const clean = parseAppSettings(next);
    writeJsonAtomic(this.file, clean);
    this.cache = clean;
    return { ...clean };
  }
}

/** 폴더가 있는가 */
export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
