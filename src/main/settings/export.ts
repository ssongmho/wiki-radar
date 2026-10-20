// 설정 내보내기·가져오기(2.13단계 명세 §C-6b). electron 을 import 하지 않는 순수 모듈이다.
//
// - 내보내기: 사람이 정한 값(app-settings·mail-settings·voc-settings 에 저장된 것)만. 팀·내장 값은 넣지 않는다.
//   빼는 것: secrets.bin 전부 · voc-session.bin · voc-settings 의 loginId·myId·jarPath · wikiRoot·wikiNone·teamSync.local · setupSeen.
//   쓰기 전에 알려진 비밀이 글에 들어 있으면 쓰지 않는다(이중 방어 — 부르는 쪽이 containsSecret).
// - 가져오기: kind·version 확인 → 칸마다 기존 검사(parseAppSettings 필드 규칙·validateMailSettings·validateVocSettings)로 거른다.
//   환경 변수로 잠긴 필드는 건너뛰고 알린다. 비밀 키 이름(pass·password·key·apiKey·token·secret)이 든 필드는 버린다.
import type { MailSettings, VocSettings } from '../../shared/types';
import { parseAppSettings, type AppSettings } from '../appSettings';
import { validateMailSettings } from '../mail/stores';
import { validateVocSettings } from '../voc/settings';

export const SETTINGS_EXPORT_KIND = 'wiki-radar-settings';
export const SETTINGS_EXPORT_VERSION = 1;
export const SETTINGS_IMPORT_MAX_BYTES = 256 * 1024;

/** 가져오기 칸(화면 이름) */
export const IMPORT_SECTIONS: Readonly<Record<string, string>> = {
  teamSync: '팀 위키 동기화',
  me: '나',
  notify: '알림',
  shell: '창 닫기',
  mailIn: '메일 받기',
  mailOut: '메일 보내기',
  ai: 'AI',
  update: '업데이트 서버',
  mail: '보내는 사람·서명',
  voc: 'VOC',
};

const APP_KEYS = ['teamSync', 'me', 'notify', 'shell', 'mailIn', 'mailOut', 'ai', 'update'] as const;
type AppKey = (typeof APP_KEYS)[number];
const SECRET_NAMES: ReadonlySet<string> = new Set(['pass', 'password', 'key', 'apikey', 'token', 'secret']);

export interface SettingsExport {
  kind: typeof SETTINGS_EXPORT_KIND;
  version: typeof SETTINGS_EXPORT_VERSION;
  exportedAt: string;
  appVersion: string;
  app: Record<string, unknown>;
  mail?: MailSettings;
  voc?: Record<string, unknown>;
}

/** 내보낼 내용(비밀·로그인·PC 경로 없음) */
export function buildSettingsExport(input: {
  app: AppSettings;
  mail: MailSettings | null;
  voc: VocSettings | null;
  appVersion: string;
  exportedAt: string;
}): SettingsExport {
  const a = input.app;
  const app: Record<string, unknown> = {};
  if (a.teamSync) app.teamSync = { enabled: a.teamSync.enabled, remote: a.teamSync.remote };
  if (a.me) app.me = a.me;
  if (a.notify) app.notify = a.notify;
  if (a.shell) app.shell = a.shell;
  if (a.mailIn) app.mailIn = a.mailIn;
  if (a.mailOut) app.mailOut = a.mailOut;
  if (a.ai) app.ai = a.ai;
  if (a.update) app.update = a.update;
  const out: SettingsExport = { kind: SETTINGS_EXPORT_KIND, version: SETTINGS_EXPORT_VERSION, exportedAt: input.exportedAt, appVersion: input.appVersion, app };
  if (input.mail) out.mail = { fromName: input.mail.fromName, signature: input.mail.signature, bccSelf: input.mail.bccSelf };
  if (input.voc) {
    const v = input.voc;
    out.voc = { memberIds: [...v.memberIds], systems: [...v.systems], showAllUnassigned: v.showAllUnassigned, pollMinutes: v.pollMinutes, ...(v.apiUrl ? { apiUrl: v.apiUrl } : {}) };
  }
  return out;
}

/** 비밀 키 이름이 든 필드를 걷는다(얕게 — 칸 안 한 단계). 걷은 필드 이름 */
function stripSecretKeys(section: string, v: unknown, dropped: string[]): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_NAMES.has(k.toLowerCase())) {
      dropped.push(`${section}.${k}`);
      continue;
    }
    out[k] = x;
  }
  return out;
}

/** 두 값의 다른 잎 수(미리보기 「바뀌는 필드 수」) */
export function countChanges(a: unknown, b: unknown): number {
  if (a === b) return 0;
  const isObj = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const ka = a as Record<string, unknown>;
    const kb = b as Record<string, unknown>;
    let n = 0;
    for (const k of new Set([...Object.keys(ka), ...Object.keys(kb)])) n += countChanges(ka[k], kb[k]);
    return n;
  }
  if (isObj(a) || isObj(b)) {
    const o = (isObj(a) ? a : b) as Record<string, unknown>;
    return Math.max(1, Object.keys(o).length);
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

export interface ParsedImport {
  app: Partial<Pick<AppSettings, AppKey>>;
  mail?: MailSettings;
  /** 검사한 VOC 설정(로그인·PC 값 없음 — 적용할 때 지금 값과 합친다) */
  voc?: Pick<VocSettings, 'memberIds' | 'systems' | 'showAllUnassigned' | 'pollMinutes' | 'apiUrl'>;
  /** 칸별로 버린 필드(비밀 키·검사 실패) */
  skipped: Record<string, string[]>;
}

/** 가져오기 글 → 칸별 값. 틀리면 한국어 Error */
export function parseSettingsImport(text: string): ParsedImport {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > SETTINGS_IMPORT_MAX_BYTES) throw new Error('설정 파일이 너무 큽니다(256KB 넘음)');
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('설정 파일이 JSON 이 아닙니다');
  }
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r || r.kind !== SETTINGS_EXPORT_KIND) throw new Error('Radar 설정 내보내기 파일이 아닙니다(kind)');
  if (r.version !== SETTINGS_EXPORT_VERSION) throw new Error('설정 파일 형식이 다릅니다(version)');
  const skipped: Record<string, string[]> = {};
  const out: ParsedImport = { app: {}, skipped };
  const app = r.app && typeof r.app === 'object' && !Array.isArray(r.app) ? (r.app as Record<string, unknown>) : {};
  for (const key of APP_KEYS) {
    if (app[key] === undefined) continue;
    const dropped: string[] = [];
    const clean = stripSecretKeys(key, app[key], dropped);
    if (key === 'teamSync') {
      // 경로는 PC 마다 다르다 — 켬·NAS 경로만(local 은 지금 값을 쓴다). 검사는 적용할 때(setTeamSync)
      const t = clean as Record<string, unknown> | null;
      if (t && typeof t.enabled === 'boolean' && typeof t.remote === 'string' && t.remote.trim() !== '' && t.remote.length <= 1024) {
        out.app.teamSync = { enabled: t.enabled, remote: t.remote.trim(), local: '' };
      } else dropped.push('teamSync');
    } else {
      const parsed = parseAppSettings({ [key]: clean });
      const v = parsed[key];
      if (v === undefined) dropped.push(key);
      else {
        (out.app as Record<string, unknown>)[key] = v;
        // 형이 틀려 버린 필드
        if (clean && typeof clean === 'object' && typeof v === 'object') {
          for (const k of Object.keys(clean as Record<string, unknown>)) if (!(k in (v as Record<string, unknown>))) dropped.push(`${key}.${k}`);
        }
      }
    }
    if (dropped.length) skipped[key] = dropped;
  }
  if (r.mail !== undefined) {
    const dropped: string[] = [];
    try {
      out.mail = validateMailSettings(stripSecretKeys('mail', r.mail, dropped));
    } catch (err) {
      dropped.push(`mail (${err instanceof Error ? err.message : String(err)})`);
    }
    if (dropped.length) skipped.mail = dropped;
  }
  if (r.voc !== undefined) {
    const dropped: string[] = [];
    const v = stripSecretKeys('voc', r.voc, dropped) as Record<string, unknown> | null;
    if (v && typeof v === 'object') {
      for (const k of ['loginId', 'myId', 'jarPath']) {
        if (k in v) {
          dropped.push(`voc.${k}`);
          delete v[k];
        }
      }
      try {
        const checked = validateVocSettings(v);
        out.voc = {
          memberIds: checked.memberIds,
          systems: checked.systems,
          showAllUnassigned: checked.showAllUnassigned,
          pollMinutes: checked.pollMinutes,
          ...(checked.apiUrl ? { apiUrl: checked.apiUrl } : {}),
        };
      } catch (err) {
        dropped.push(`voc (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (dropped.length) skipped.voc = dropped;
  }
  return out;
}

/** 파일 이름 wiki-radar-settings-YYYYMMDD.json */
export function exportFileName(today: string): string {
  return `wiki-radar-settings-${today.replace(/-/g, '')}.json`;
}
