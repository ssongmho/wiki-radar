// 설정 칸 6개의 main 쪽(2.13단계 명세 §A·§C·§D·§F). electron 을 import 하지 않는다 — 대화상자·창·VOC 는 index.ts 가 deps 로 준다.
//
// - view(section): 칸 값·출처(SettingsSectionView). 비밀은 저장됨/없음만.
// - save(section, patch): 바뀐 필드만 받는다(null = 내 값을 지움). 환경 변수로 잠긴 필드는 무시하고 ignored 로 알린다.
//   쓰는 순서 app-settings → mail-settings → secrets. 앞이 성공하고 뒤가 실패하면 "일부만 저장했습니다: …".
// - test(section, draft): 저장 전 초안 값으로 연결 시험(비밀이 비면 저장된 것). 같은 칸 시험이 돌고 있으면 거부.
// - 바로 적용: 쓰는 쪽(발송·초안·VOC·업데이트)이 부를 때마다 resolver 를 거치므로 저장 즉시 다음 호출에 적용된다(개인 위키만 다시 시작).
import path from 'node:path';
import type {
  ClaudeStatusView,
  ConnectionTestResult,
  FieldView,
  MailSettings,
  SecretKey,
  SettingsPatch,
  SettingsImportPreview,
  SettingsSaveResult,
  SettingsSection,
  SettingsSectionView,
  SetupLine,
  TeamDefaultsView,
  TeamSyncInput,
  TestableSection,
} from '../../shared/types';
import {
  DEFAULT_TEAM_REMOTE,
  isDirectory,
  resolveWikiRoot,
  wikiPathProblem,
  type AppSettings,
  type AppSettingsStore,
  type WikiLocation,
} from '../appSettings';
import { localDateTimeString } from '../config';
import { WIKI_PENDING_NONE } from '../../shared/ipc';
import {
  MAIL_ENV_FILE,
  knownSecrets as knownSecretsOf,
  readDotEnvAccount,
  type AccountResult,
  type DotEnvAccount,
} from '../mail/account';
import { testPop3 } from '../mail/pop3';
import { verifySmtp } from '../mail/smtp';
import { DEFAULT_MAIL_SETTINGS, validateMailSettings, type MailSettingsStore } from '../mail/stores';
import { testLlm } from '../ai/llm';
import { isInside, teamSyncConfigProblem, type TeamSyncConfig } from '../teamSync/service';
import {
  firstDateProblem,
  hostProblem,
  intervalProblem,
  llmUrlOutside,
  mailUserProblem,
  modelProblem,
  nonEmpty,
  normalizeLlmUrl,
  normalizeUpdateUrl,
  portProblem,
} from './fields';
import {
  resolveAi,
  resolveField,
  llmHostOf,
  resolveLlm,
  resolveMailIn,
  resolveMailOut,
  resolvePop3Account,
  resolveSmtpAccount,
  resolveUpdateUrl,
  type LlmTarget,
  type ResolveInput,
  type SecretReader,
} from './resolve';
import { isSecretKey, type SecretStore } from './secrets';
import { FEATURES } from '../../shared/edition';
import type { TeamDefaultsHolder } from './teamDefaults';
import { testWikiFolders } from './tests';
import { IMPORT_SECTIONS, countChanges, type ParsedImport } from './export';

/** 칸마다 받는 필드(이 밖의 이름은 거부) */
export const SECTION_FIELDS: Readonly<Record<SettingsSection, readonly string[]>> = {
  wiki: ['wikiMode', 'wikiRoot', 'teamEnabled', 'teamRemote', 'teamLocal'],
  mailIn: ['host', 'port', 'ssl', 'user', 'intervalMinutes', 'firstDate', 'enabled'],
  mailOut: ['sameAccount', 'host', 'port', 'security', 'user', 'fromName', 'signature', 'bccSelf'],
  ai: ['llmUrl', 'apiFormat', 'model', 'draftEngine'],
  info: ['updateUrl'],
};
/** 칸마다 쓸 수 있는 비밀 */
const SECTION_SECRET: Readonly<Partial<Record<SettingsSection, SecretKey>>> = { mailIn: 'mailIn.pass', mailOut: 'mailOut.pass', ai: 'ai.llmKey' };
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['wiki', 'mailIn', 'mailOut', 'ai', 'info'];
export const TESTABLE_SECTIONS: readonly TestableSection[] = ['wiki', 'mailIn', 'mailOut', 'ai', 'voc'];
/** 글 필드 한도(서명은 mail-settings 검사가 따로 본다) */
const TEXT_MAX = 8_000;
const PATCH_KEYS_MAX = 20;

export const PARTIAL_SETTINGS_PREFIX = '일부만 저장했습니다';

/** IPC 입력 검사: 객체 깊이 2(비밀만 한 단계 더), 칸의 필드 이름만, 값은 null·참거짓·숫자·글(8000자) */
export function requireSettingsPatch(section: SettingsSection, raw: unknown): SettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('잘못된 요청입니다: 설정 값');
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length > PATCH_KEYS_MAX) throw new Error('잘못된 요청입니다: 필드가 너무 많습니다');
  const allowed = SECTION_FIELDS[section];
  const out: SettingsPatch = {};
  for (const key of keys) {
    const v = r[key];
    if (key === 'secret') {
      if (v === undefined || v === null) continue;
      const want = SECTION_SECRET[section];
      if (!want || !v || typeof v !== 'object' || Array.isArray(v)) throw new Error('잘못된 요청입니다: secret');
      const s = v as Record<string, unknown>;
      for (const k of Object.keys(s)) if (k !== 'key' && k !== 'action' && k !== 'value') throw new Error('잘못된 요청입니다: secret');
      if (!isSecretKey(s.key) || s.key !== want) throw new Error('잘못된 요청입니다: secret.key');
      if (s.action !== 'keep' && s.action !== 'set' && s.action !== 'clear') throw new Error('잘못된 요청입니다: secret.action');
      if (s.value !== undefined && (typeof s.value !== 'string' || s.value.length > 1024)) throw new Error('잘못된 요청입니다: secret.value');
      out.secret = { key: s.key, action: s.action, ...(typeof s.value === 'string' ? { value: s.value } : {}) };
      continue;
    }
    if (!allowed.includes(key)) throw new Error(`잘못된 요청입니다: ${key.slice(0, 30)}`);
    if (v === null || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && v.length <= TEXT_MAX) out[key] = v;
    else throw new Error(`잘못된 요청입니다: ${key}`);
  }
  return out;
}

export interface SettingsServiceDeps {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  appSettings: AppSettingsStore;
  secrets: SecretStore;
  team: TeamDefaultsHolder;
  mailSettings: () => MailSettingsStore;
  /** 지금 쓰는 개인 위키(시작할 때 정해짐 — 바꾸면 다시 시작) */
  wiki: { location: WikiLocation; defaultRoot: string; pending: () => string | undefined; setPending: (p: string | undefined) => void };
  /** 팀 위키 동기화(index.ts — 검사·적용은 기존 setTeamSync) */
  teamSync: { config: () => TeamSyncConfig; configured: () => boolean; set: (input: TeamSyncInput) => unknown };
  today: () => string;
  now: () => Date;
  testMode: boolean;
  /** updater.ts DEFAULT_UPDATE_URL */
  builtinUpdateUrl: string;
  /** AI 칸의 Claude Code 상태 */
  claude?: () => ClaudeStatusView;
  /** VOC 칸 연결 시험(apiUrl 초안 — 없으면 지금 주소) */
  vocTest?: (apiUrl: string | undefined) => Promise<ConnectionTestResult>;
  onChanged: (section: string) => void;
  log?: (message: string) => void;
}

/** 설정 쪽의 문장들(점검 줄) */
export interface SettingsSetupLines {
  mailIn: SetupLine;
  ai: SetupLine;
  team: SetupLine;
  secrets?: SetupLine;
}

/** 비밀 덮어보기(시험 초안) */
function overlaySecrets(base: SecretReader, patch: SettingsPatch['secret']): SecretReader {
  if (!patch || patch.action === 'keep') return base;
  return {
    has: (k) => (k === patch.key ? patch.action === 'set' && !!patch.value : base.has(k)),
    get: (k) => (k === patch.key ? (patch.action === 'set' ? patch.value || undefined : undefined) : base.get(k)),
    ...(base.storage ? { storage: () => (base.storage as () => 'file' | 'memory')() } : {}),
  };
}

function strip<T>(v: FieldView<T>): FieldView {
  return v as FieldView<unknown>;
}

export class SettingsService {
  private readonly testing = new Set<TestableSection>();
  private lastAiTest: { ok: boolean; at: string } | null = null;

  constructor(private readonly deps: SettingsServiceDeps) {}

  // ---- 입력 ----------------------------------------------------------------------------------

  private wikiRootForDotenv(): string {
    return this.deps.wiki.location.source === 'none' ? '' : this.deps.wiki.location.path;
  }

  resolveInput(over: { settings?: AppSettings; secrets?: SecretReader } = {}): ResolveInput {
    const wikiRoot = this.wikiRootForDotenv();
    return {
      env: this.deps.env,
      settings: over.settings ?? this.deps.appSettings.get(),
      secrets: over.secrets ?? this.deps.secrets,
      team: this.deps.team.values(),
      dotenv: (): DotEnvAccount => (wikiRoot ? readDotEnvAccount(wikiRoot) : { ok: true }),
    };
  }

  /** 이 앱이 아는 비밀 전부(비교·가리기용 — 응답에 담지 않는다) */
  knownSecrets(): string[] {
    return knownSecretsOf(this.deps.env, this.wikiRootForDotenv(), this.deps.secrets.all());
  }

  /** 발송·문맥이 부를 때마다(캐시 없음) */
  smtpAccount(): AccountResult {
    return resolveSmtpAccount(this.resolveInput());
  }

  /** 메일 받기 계정(수집기가 회차마다 — 2.15) */
  pop3Account(): ReturnType<typeof resolvePop3Account> {
    return resolvePop3Account(this.resolveInput());
  }

  /** 수집 켜짐·주기·처음 받을 날짜(2.15) */
  collectSettings(): { enabled: boolean; intervalMinutes: number; firstDate?: string } {
    const f = resolveMailIn(this.resolveInput()).fields;
    const out: { enabled: boolean; intervalMinutes: number; firstDate?: string } = {
      enabled: f.enabled.value !== false,
      intervalMinutes: typeof f.intervalMinutes.value === 'number' ? f.intervalMinutes.value : 10,
    };
    if (typeof f.firstDate.value === 'string' && f.firstDate.value) out.firstDate = f.firstDate.value;
    return out;
  }

  llmTarget(): ReturnType<typeof resolveLlm> {
    // 공개판은 로컬 LLM 을 쓰지 않는다(src/shared/edition.ts) — 남은 설정이 있어도 연결하지 않는다
    if (!FEATURES.localLlm) return { ok: false, problem: '이 판에서는 로컬 LLM 을 쓰지 않습니다' };
    return resolveLlm(this.resolveInput());
  }

  draftEngine(): 'claude' | 'local' {
    if (!FEATURES.localLlm) return 'claude';
    return resolveAi(this.resolveInput()).fields.draftEngine.value === 'local' ? 'local' : 'claude';
  }

  updateUrl(): FieldView<string> {
    return resolveUpdateUrl(this.deps.env, this.deps.appSettings.get(), this.deps.team.values(), this.deps.builtinUpdateUrl);
  }

  teamDefaults(): TeamDefaultsView {
    return this.deps.team.current();
  }

  // ---- 보기 ----------------------------------------------------------------------------------

  private teamSummary(): SettingsSectionView['team'] {
    const { values: _values, ...summary } = this.deps.team.current();
    return { ...summary, problems: [...summary.problems] };
  }

  private dotenvInfo(): SettingsSectionView['dotenv'] {
    const root = this.wikiRootForDotenv();
    const dot = root ? readDotEnvAccount(root) : ({ ok: true } as DotEnvAccount);
    return { available: dot.ok && !!dot.user, file: MAIL_ENV_FILE };
  }

  view(section: SettingsSection): SettingsSectionView {
    const settings = this.deps.appSettings.get();
    const input = this.resolveInput({ settings });
    const base = { section, team: this.teamSummary() };
    switch (section) {
      case 'wiki': {
        const loc = this.deps.wiki.location;
        const envWiki = loc.source === 'env';
        const cfg = this.deps.teamSync.config();
        const teamRemoteDefault = this.deps.team.values().teamSync?.remote;
        const ts = settings.teamSync;
        const fields: Record<string, FieldView> = {
          wikiMode: envWiki
            ? { value: 'folder', source: 'env', envName: 'WIKI_RADAR_WIKI' }
            : strip(resolveField<'folder' | 'none'>(null, settings.wikiNone ? 'none' : settings.wikiRoot ? 'folder' : undefined, undefined, 'folder')),
          wikiRoot: envWiki
            ? { value: loc.path, source: 'env', envName: 'WIKI_RADAR_WIKI' }
            : strip(resolveField<string>(null, settings.wikiRoot, undefined, path.resolve(this.deps.wiki.defaultRoot))),
          teamEnabled: strip(resolveField<boolean>(null, ts ? ts.enabled : undefined, undefined, false)),
          teamRemote: strip(resolveField<string>(null, ts?.remote, teamRemoteDefault, DEFAULT_TEAM_REMOTE)),
          teamLocal: strip(resolveField<string>(null, ts?.local, undefined, cfg.local)),
        };
        const notes: string[] = [];
        if (loc.source === 'none') notes.push('개인 위키를 쓰지 않습니다 — 할 일은 팀 위키(동기화 켬)에서만 나옵니다.');
        if (envWiki) notes.push('개인 위키를 환경 변수 WIKI_RADAR_WIKI 로 정해 두어 여기서 바꿀 수 없습니다.');
        const pending = this.deps.wiki.pending();
        return { ...base, fields, secrets: {}, notes, ...(pending ? { restartPending: pending } : {}) };
      }
      case 'mailIn': {
        const r = resolveMailIn(input);
        const notes = ['수집 주체: Radar(파이썬 수집기는 2026-10-19 꺼짐). 받은 메일은 앱 데이터 폴더의 메일 보관소에 쌓입니다(위키에 두지 않음).', '서버의 메일은 지우지 않습니다.'];
        if (r.account.source === 'dotenv') notes.push(`계정은 위키의 ${MAIL_ENV_FILE} 에서 읽음 — [이 계정을 설정으로 옮기기]로 옮길 수 있습니다(.env 는 그대로 둡니다).`);
        if (r.account.problem) notes.push(r.account.problem);
        return { ...base, fields: r.fields as unknown as Record<string, FieldView>, secrets: { 'mailIn.pass': r.secret }, notes, dotenv: this.dotenvInfo() };
      }
      case 'mailOut': {
        const r = resolveMailOut(input);
        let mail: MailSettings = { ...DEFAULT_MAIL_SETTINGS };
        const notes: string[] = [];
        try {
          mail = this.deps.mailSettings().get();
        } catch (err) {
          notes.push(err instanceof Error ? err.message : String(err));
        }
        const fields: Record<string, FieldView> = {
          ...(r.fields as unknown as Record<string, FieldView>),
          fromName: { value: mail.fromName, source: mail.fromName ? 'user' : 'builtin' },
          signature: { value: mail.signature, source: mail.signature ? 'user' : 'builtin' },
          bccSelf: { value: mail.bccSelf, source: 'user' },
        };
        if (r.account.source === 'dotenv') notes.push(`계정은 위키의 ${MAIL_ENV_FILE} 에서 읽음.`);
        if (r.account.source === 'env') notes.push('계정을 환경 변수로 정해 두었습니다.');
        const smtp = resolveSmtpAccount(input);
        if (!smtp.ok) notes.push(smtp.problem);
        const view: SettingsSectionView = { ...base, fields, secrets: { 'mailOut.pass': r.secret }, notes, dotenv: this.dotenvInfo() };
        if (r.fields.sameAccount.value !== false && r.account.user) view.sameAccountUser = r.account.user;
        return view;
      }
      case 'ai': {
        const r = resolveAi(input);
        const notes: string[] = [];
        const llm = resolveLlm(input);
        // 주소·모델은 있는데 못 쓰는 이유(연결 시험 전 등) — 칸 안내와 회신 초안 버튼 이유에 그대로
        const llmProblem = !llm.ok && r.fields.llmUrl.value && r.fields.model.value ? llm.problem : undefined;
        if (r.fields.draftEngine.value === 'local' && (!r.fields.llmUrl.value || !r.fields.model.value)) notes.push('설정 › AI 에서 로컬 LLM 을 넣으세요 — 회신 초안을 만들 수 없습니다.');
        else if (llmProblem) notes.push(llmProblem);
        const view: SettingsSectionView = { ...base, fields: r.fields as unknown as Record<string, FieldView>, secrets: { 'ai.llmKey': r.secret }, notes };
        if (llmProblem) view.llmProblem = llmProblem;
        if (r.fields.llmUrl.value) view.llmOutside = llmUrlOutside(r.fields.llmUrl.value);
        if (this.lastAiTest) view.lastTest = { ...this.lastAiTest };
        if (this.deps.claude) view.claude = this.deps.claude();
        return view;
      }
      case 'info': {
        return { ...base, fields: { updateUrl: strip(this.updateUrl()) }, secrets: {}, notes: [] };
      }
    }
  }

  // ---- 저장 ----------------------------------------------------------------------------------

  /** 필드 하나의 값 검사·정리. 틀리면 한국어 Error */
  private checkField(section: SettingsSection, field: string, value: unknown): unknown {
    const fail = (p: string | null): never => {
      throw new Error(p ?? `${field} 값이 맞지 않습니다`);
    };
    const bool = () => (typeof value === 'boolean' ? value : fail(`${field} 는 참/거짓이어야 합니다`));
    const str = () => (typeof value === 'string' ? value.trim() : fail(`${field} 는 글이어야 합니다`));
    switch (`${section}.${field}`) {
      case 'mailIn.host':
      case 'mailOut.host':
        return hostProblem(value) ? fail(hostProblem(value)) : str();
      case 'mailIn.port':
      case 'mailOut.port':
        return portProblem(value) ? fail(portProblem(value)) : value;
      case 'mailIn.ssl':
      case 'mailIn.enabled':
      case 'mailOut.sameAccount':
      case 'mailOut.bccSelf':
      case 'wiki.teamEnabled':
        return bool();
      case 'mailIn.user':
      case 'mailOut.user':
        return mailUserProblem(value) ? fail(mailUserProblem(value)) : str();
      case 'mailIn.intervalMinutes':
        return intervalProblem(value) ? fail(intervalProblem(value)) : value;
      case 'mailIn.firstDate':
        return firstDateProblem(value, this.deps.today()) ? fail(firstDateProblem(value, this.deps.today())) : value;
      case 'mailOut.security':
        return value === 'ssl' || value === 'starttls' ? value : fail('보안은 ssl 또는 starttls 여야 합니다');
      case 'mailOut.fromName':
      case 'mailOut.signature':
        return typeof value === 'string' ? value : fail(`${field} 는 글이어야 합니다`);
      case 'ai.llmUrl': {
        const r = normalizeLlmUrl(value);
        return 'url' in r ? r.url : fail(r.problem);
      }
      case 'ai.apiFormat':
        return value === 'openai' ? value : fail('API 형식은 OpenAI 호환만 됩니다');
      case 'ai.model':
        return modelProblem(value) ? fail(modelProblem(value)) : str();
      case 'ai.draftEngine':
        return value === 'claude' || value === 'local' ? value : fail('회신 초안 엔진은 claude 또는 local 이어야 합니다');
      case 'info.updateUrl': {
        const r = normalizeUpdateUrl(value);
        return 'url' in r ? r.url : fail(r.problem);
      }
      case 'wiki.wikiMode':
        return value === 'folder' || value === 'none' ? value : fail('개인 위키는 폴더 또는 없음이어야 합니다');
      case 'wiki.wikiRoot':
      case 'wiki.teamRemote':
      case 'wiki.teamLocal':
        return wikiPathProblem(value) ? fail(wikiPathProblem(value)) : str();
      default:
        return fail(`잘못된 요청입니다: ${field}`);
    }
  }

  /** 환경 변수로 잠긴 필드 이름 */
  private lockedFields(section: SettingsSection): Set<string> {
    if (section === 'wiki') return new Set(this.deps.wiki.location.source === 'env' ? ['wikiMode', 'wikiRoot'] : []);
    const v = this.view(section);
    return new Set(Object.entries(v.fields).filter(([, f]) => f.source === 'env').map(([k]) => k));
  }

  private secretLocked(section: SettingsSection): boolean {
    const key = SECTION_SECRET[section];
    if (!key) return false;
    const v = this.view(section).secrets[key];
    return v?.source === 'env';
  }

  /** 칸 저장(§D-1). patch 는 requireSettingsPatch 를 거친 것 */
  save(section: SettingsSection, patch: SettingsPatch): SettingsSaveResult {
    const ignored: string[] = [];
    const locked = this.lockedFields(section);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'secret') continue;
      if (locked.has(k)) {
        ignored.push(k);
        continue;
      }
      fields[k] = v === null ? null : this.checkField(section, k, v);
    }
    let secretPatch = patch.secret && patch.secret.action !== 'keep' ? patch.secret : undefined;
    if (secretPatch && this.secretLocked(section)) {
      ignored.push('secret');
      secretPatch = undefined;
    }
    if (secretPatch?.action === 'set' && secretPatch.value === undefined) throw new Error('잘못된 요청입니다: secret.value');

    const result: SettingsSaveResult = { view: this.view(section), ignored };
    const done: string[] = [];
    try {
      if (section === 'wiki') this.saveWiki(fields, result);
      else if (section === 'mailOut') {
        const { fromName, signature, bccSelf, ...rest } = fields;
        if (Object.keys(rest).length) {
          this.saveAppSection('mailOut', rest);
          done.push('메일 보내기 서버');
        }
        if (fromName !== undefined || signature !== undefined || bccSelf !== undefined) {
          const store = this.deps.mailSettings();
          let cur: MailSettings;
          try {
            cur = store.get();
          } catch {
            cur = { ...DEFAULT_MAIL_SETTINGS };
          }
          const next = {
            fromName: fromName === undefined ? cur.fromName : fromName === null ? DEFAULT_MAIL_SETTINGS.fromName : fromName,
            signature: signature === undefined ? cur.signature : signature === null ? DEFAULT_MAIL_SETTINGS.signature : signature,
            bccSelf: bccSelf === undefined ? cur.bccSelf : bccSelf === null ? DEFAULT_MAIL_SETTINGS.bccSelf : bccSelf,
          };
          store.save(validateMailSettings(next));
          done.push('보내는 사람·서명');
        }
      } else if (section === 'info') {
        if ('updateUrl' in fields) this.saveAppSection('update', { url: fields.updateUrl });
      } else if (Object.keys(fields).length) {
        this.saveAppSection(section, fields);
        done.push('설정');
      }
      if (secretPatch) {
        const storage = secretPatch.action === 'set' ? this.deps.secrets.set(secretPatch.key, secretPatch.value as string) : this.deps.secrets.clear(secretPatch.key);
        result.secretStorage = storage;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (done.length) throw new Error(`${PARTIAL_SETTINGS_PREFIX}: ${done.join('·')} 은 저장했고 나머지는 실패 — ${message}`);
      throw err;
    } finally {
      this.deps.onChanged(section);
    }
    result.view = this.view(section);
    this.deps.log?.(
      `설정 › ${section} 저장(${Object.keys(fields).join(',') || '필드 없음'}${secretPatch ? ` · 비밀 ${secretPatch.action === 'set' ? '바꿈' : '지움'}` : ''}${ignored.length ? ` · 무시 ${ignored.join(',')}` : ''})`,
    );
    return result;
  }

  /** [연결 시험]에 성공한 로컬 LLM 호스트를 적는다(ai.keyHost — resolveLlm 은 이 호스트일 때만 쓴다) */
  private confirmLlmKeyHost(url: string): void {
    const keyHost = llmHostOf(url);
    const cur = this.deps.appSettings.get().ai ?? {};
    if (!keyHost || cur.keyHost === keyHost) return;
    this.deps.appSettings.update({ ai: { ...cur, keyHost } });
    this.deps.log?.(`설정 › AI: 로컬 LLM 연결 시험에 성공한 호스트를 적음(${keyHost})`);
    // 점검 줄·회신 초안 버튼(시험 전 이유)이 바로 바뀌게
    this.deps.onChanged('ai');
  }

  /** app-settings 의 한 칸에 필드를 덮는다(null 은 지움) */
  private saveAppSection(key: 'mailIn' | 'mailOut' | 'ai' | 'update', fields: Record<string, unknown>): void {
    const cur = ((this.deps.appSettings.get()[key] ?? {}) as Record<string, unknown>);
    const next: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    this.deps.appSettings.update({ [key]: nonEmpty(next) } as Partial<Record<keyof AppSettings, AppSettings[keyof AppSettings] | undefined>>);
  }

  private saveWiki(fields: Record<string, unknown>, result: SettingsSaveResult): void {
    const settings = this.deps.appSettings.get();
    const loc = this.deps.wiki.location;
    // 개인 위키
    if ('wikiMode' in fields || 'wikiRoot' in fields) {
      const mode = fields.wikiMode === undefined ? (settings.wikiNone ? 'none' : 'folder') : fields.wikiMode === null ? 'folder' : fields.wikiMode;
      const root = fields.wikiRoot === undefined ? settings.wikiRoot : fields.wikiRoot === null ? undefined : (fields.wikiRoot as string);
      if (mode === 'folder' && root !== undefined) {
        if (!isDirectory(root)) throw new Error(`폴더를 찾을 수 없습니다: ${root}`);
        const team = this.deps.teamSync.config();
        if (team.enabled && team.local && (isInside(root, team.local) || isInside(team.local, root))) {
          throw new Error('팀 위키 사본 폴더(또는 그 상위·하위)는 개인 위키로 쓸 수 없습니다 — 다른 폴더를 고르세요');
        }
      }
      this.deps.appSettings.update({ wikiNone: mode === 'none' ? true : undefined, wikiRoot: root ? path.resolve(root) : undefined });
      const next = resolveWikiRoot(this.deps.env, this.deps.appSettings.get(), this.deps.wiki.defaultRoot, this.deps.dataDir);
      const same = next.source === 'none' ? loc.source === 'none' : loc.source !== 'none' && path.resolve(next.path).toLowerCase() === path.resolve(loc.path).toLowerCase();
      this.deps.wiki.setPending(same ? undefined : next.source === 'none' ? WIKI_PENDING_NONE : next.path);
      if (!same) result.restartNeeded = true;
    }
    // 팀 위키 동기화(기존 setTeamSync — 바로 적용)
    if ('teamEnabled' in fields || 'teamRemote' in fields || 'teamLocal' in fields) {
      const cur = this.deps.teamSync.config();
      const teamRemoteDefault = this.deps.team.values().teamSync?.remote ?? DEFAULT_TEAM_REMOTE;
      const input: TeamSyncInput = {
        enabled: fields.teamEnabled === undefined ? cur.enabled : fields.teamEnabled === null ? false : (fields.teamEnabled as boolean),
        remote: fields.teamRemote === undefined ? cur.remote : fields.teamRemote === null ? teamRemoteDefault : (fields.teamRemote as string),
        local: fields.teamLocal === undefined ? cur.local : fields.teamLocal === null ? cur.local : (fields.teamLocal as string),
      };
      this.deps.teamSync.set(input);
    }
  }

  /** [이 계정을 설정으로 옮기기](§A-4): .env 아이디 → mailIn.user, 비밀번호 → secrets. .env 는 고치지 않는다 */
  importDotEnvAccount(): SettingsSectionView {
    const root = this.wikiRootForDotenv();
    const dot = root ? readDotEnvAccount(root) : ({ ok: true } as DotEnvAccount);
    if (!dot.ok) throw new Error(dot.problem);
    if (!dot.user || !dot.pass) throw new Error(`위키의 ${MAIL_ENV_FILE} 에 계정(MAILHOST_MAIL_USER·MAILHOST_MAIL_PASS)이 없습니다`);
    const userProblem = mailUserProblem(dot.user);
    if (userProblem) throw new Error(userProblem);
    this.saveAppSection('mailIn', { user: dot.user });
    try {
      this.deps.secrets.set('mailIn.pass', dot.pass);
    } finally {
      this.deps.onChanged('mailIn');
    }
    this.deps.log?.('설정 › 메일 받기: .env 계정을 설정으로 옮김(.env 는 그대로)');
    return this.view('mailIn');
  }

  // ---- 연결 시험 -----------------------------------------------------------------------------

  /** 초안을 덮은 설정(저장하지 않는다). 검사에 걸리면 Error */
  private draftSettings(section: SettingsSection, draft: SettingsPatch): AppSettings {
    const settings: AppSettings = JSON.parse(JSON.stringify(this.deps.appSettings.get())) as AppSettings;
    const key = section === 'info' ? 'update' : section;
    if (key !== 'mailIn' && key !== 'mailOut' && key !== 'ai') return settings;
    const cur = { ...((settings[key] ?? {}) as Record<string, unknown>) };
    for (const [k, v] of Object.entries(draft)) {
      if (k === 'secret' || (key === 'mailOut' && (k === 'fromName' || k === 'signature' || k === 'bccSelf'))) continue;
      if (v === null) delete cur[k];
      else cur[k] = this.checkField(section, k, v);
    }
    (settings as Record<string, unknown>)[key] = cur;
    return settings;
  }

  async test(section: TestableSection, draft: SettingsPatch): Promise<ConnectionTestResult> {
    if (this.testing.has(section)) throw new Error('이 칸의 연결 시험이 이미 돌고 있습니다');
    this.testing.add(section);
    const started = Date.now();
    const fail = (detail: string): ConnectionTestResult => ({ ok: false, steps: [{ label: '설정', ok: false, detail }], ms: Date.now() - started });
    try {
      const secrets = this.knownSecrets();
      if (draft.secret?.value) secrets.push(draft.secret.value);
      switch (section) {
        case 'mailIn': {
          const input = this.resolveInput({ settings: this.draftSettings('mailIn', draft), secrets: overlaySecrets(this.deps.secrets, draft.secret) });
          const acc = resolvePop3Account(input);
          if (!acc.ok) return fail(acc.problem);
          return await testPop3({ ...acc.account, env: this.deps.env, secrets });
        }
        case 'mailOut': {
          const input = this.resolveInput({ settings: this.draftSettings('mailOut', draft), secrets: overlaySecrets(this.deps.secrets, draft.secret) });
          const acc = resolveSmtpAccount(input);
          if (!acc.ok) return fail(acc.problem);
          return await verifySmtp(acc.account, this.deps.env, { secrets });
        }
        case 'ai': {
          const input = this.resolveInput({ settings: this.draftSettings('ai', draft), secrets: overlaySecrets(this.deps.secrets, draft.secret) });
          // 사람이 화면에서 주소를 보고 누른 시험 — 아직 시험 안 한 호스트에도 보낸다. 성공하면 그 호스트를 적는다
          const t = resolveLlm(input, { testing: true });
          if (!t.ok) return fail(t.problem);
          const r = await testLlm({ url: t.target.url, model: t.target.model, ...(t.target.key ? { key: t.target.key } : {}), env: this.deps.env, secrets });
          this.lastAiTest = { ok: r.ok, at: localDateTimeString(this.deps.now()) };
          // 성공한 호스트만 쓴다(키 유무와 상관없이 — resolveLlm)
          if (r.ok) this.confirmLlmKeyHost(t.target.url);
          return r;
        }
        case 'wiki': {
          const settings = this.deps.appSettings.get();
          const loc = this.deps.wiki.location;
          let personal: string | 'none';
          if (loc.source === 'env') personal = loc.path;
          else {
            const mode = draft.wikiMode === undefined ? (settings.wikiNone ? 'none' : 'folder') : draft.wikiMode === null ? 'folder' : this.checkField('wiki', 'wikiMode', draft.wikiMode);
            const root = typeof draft.wikiRoot === 'string' ? (this.checkField('wiki', 'wikiRoot', draft.wikiRoot) as string) : settings.wikiRoot ?? this.deps.wiki.defaultRoot;
            personal = mode === 'none' ? 'none' : root;
          }
          const cur = this.deps.teamSync.config();
          const team = {
            enabled: typeof draft.teamEnabled === 'boolean' ? draft.teamEnabled : cur.enabled,
            remote: typeof draft.teamRemote === 'string' ? (this.checkField('wiki', 'teamRemote', draft.teamRemote) as string) : cur.remote,
            local: typeof draft.teamLocal === 'string' ? (this.checkField('wiki', 'teamLocal', draft.teamLocal) as string) : cur.local,
          };
          if (team.enabled) {
            const p = teamSyncConfigProblem(team, personal === 'none' ? [] : [personal]);
            if (p) return fail(p);
          }
          return await testWikiFolders({ personal, team, testMode: this.deps.testMode });
        }
        case 'voc': {
          if (!this.deps.vocTest) return fail('VOC 를 쓸 수 없습니다');
          const apiUrl = typeof draft.apiUrl === 'string' && draft.apiUrl.trim() !== '' ? draft.apiUrl.trim() : undefined;
          return await this.deps.vocTest(apiUrl);
        }
      }
    } finally {
      this.testing.delete(section);
    }
  }

  // ---- 점검 줄(§D-3) ---------------------------------------------------------------------------

  setupLines(): SettingsSetupLines {
    const input = this.resolveInput();
    const pop = resolvePop3Account(input);
    const mailIn: SetupLine = pop.ok ? { state: 'ok', text: '설정됨 — Radar 가 받는 주기마다 메일을 받습니다' } : { state: 'warn', text: `서버·계정을 넣으세요(${pop.problem})` };
    const ai = resolveAi(input);
    const llm = resolveLlm(input);
    let aiLine: SetupLine;
    if (ai.fields.llmUrl.value && ai.fields.model.value && !llm.ok) {
      aiLine = { state: 'warn', text: llm.problem };
    } else if (ai.fields.llmUrl.value && ai.fields.model.value) {
      const t = this.lastAiTest;
      aiLine = { state: 'ok', text: `로컬 LLM ${ai.fields.model.value}${t ? ` · 연결 시험 ${t.ok ? '성공' : '실패'}(${t.at.replace('T', ' ').slice(0, 16)})` : ''}` };
    } else if (ai.fields.draftEngine.value === 'local') {
      aiLine = { state: 'off', text: '로컬 LLM 이 설정되지 않아 회신 초안을 만들 수 없습니다' };
    } else {
      aiLine = { state: 'warn', text: '로컬 LLM 이 설정되지 않았습니다(회신 초안은 Claude)' };
    }
    const t = this.deps.team.current();
    const when = t.readAt ? t.readAt.replace('T', ' ').slice(0, 16) : '';
    const where = t.source === 'env' ? '환경 변수 파일' : t.source === 'local' ? '내 PC 사본' : t.source === 'remote' ? 'NAS' : '';
    let team: SetupLine;
    if (t.problems.length && t.source === 'none') team = { state: 'warn', text: `팀 기본값 파일 문제: ${t.problems[0]}` };
    else if (t.source === 'cache' && t.problems.length) team = { state: 'warn', text: `팀 기본값: 마지막 값(${when})을 씀 — ${t.problems[0]}` };
    else if (t.source === 'cache') team = { state: 'ok', text: `팀 기본값: 마지막 값(${when}) — NAS 가 안 보임` };
    else if (t.source === 'none') team = { state: 'ok', text: '팀 기본값 없음 — 내장 기본값', quiet: true };
    else if (t.problems.length) team = { state: 'warn', text: `팀 기본값: ${where} · ${when} 읽음 — ${t.problems[0]}` };
    else team = { state: 'ok', text: `팀 기본값: ${where} · ${when} 읽음` };
    const out: SettingsSetupLines = { mailIn, ai: aiLine, team };
    const broken = this.deps.secrets.loadProblem();
    if (broken) out.secrets = { state: 'warn', text: broken };
    return out;
  }

  // ---- 가져오기(§C-6b) ------------------------------------------------------------------------

  /** 환경 변수로 잠긴 필드를 걷는다(칸 → 걷은 필드 이름) */
  private dropLocked(parsed: ParsedImport): void {
    const map: [keyof ParsedImport['app'], SettingsSection, (f: string) => string][] = [
      ['mailIn', 'mailIn', (f) => f],
      ['mailOut', 'mailOut', (f) => f],
      ['ai', 'ai', (f) => f],
      ['update', 'info', (f) => (f === 'url' ? 'updateUrl' : f)],
    ];
    for (const [key, section, viewName] of map) {
      const v = parsed.app[key] as Record<string, unknown> | undefined;
      if (!v) continue;
      const locked = this.lockedFields(section);
      for (const f of Object.keys(v)) {
        if (locked.has(viewName(f)) || (f === 'user' && locked.has('user'))) {
          delete v[f];
          (parsed.skipped[key] ??= []).push(`${key}.${f} (환경 변수로 정해짐)`);
        }
      }
      if (Object.keys(v).length === 0) delete parsed.app[key];
    }
  }

  /** 미리보기: 칸마다 바뀌는 필드 수·건너뛴 것 */
  previewImport(parsed: ParsedImport, current: { mail: MailSettings | null; voc: Record<string, unknown> | null }): SettingsImportPreview['sections'] {
    this.dropLocked(parsed);
    const app = this.deps.appSettings.get();
    const out: SettingsImportPreview['sections'] = [];
    const keys = new Set<string>([...Object.keys(parsed.app), ...(parsed.mail ? ['mail'] : []), ...(parsed.voc ? ['voc'] : []), ...Object.keys(parsed.skipped)]);
    for (const key of Object.keys(IMPORT_SECTIONS)) {
      if (!keys.has(key)) continue;
      let changes = 0;
      if (key === 'mail') changes = parsed.mail ? countChanges(current.mail, parsed.mail) : 0;
      else if (key === 'voc') {
        const cur = current.voc ? Object.fromEntries(Object.entries(current.voc).filter(([k]) => ['memberIds', 'systems', 'showAllUnassigned', 'pollMinutes', 'apiUrl'].includes(k))) : null;
        changes = parsed.voc ? countChanges(cur, parsed.voc) : 0;
      } else if (key === 'teamSync') {
        const t = parsed.app.teamSync;
        changes = t ? countChanges({ enabled: app.teamSync?.enabled ?? false, remote: app.teamSync?.remote }, { enabled: t.enabled, remote: t.remote }) : 0;
      } else {
        const v = (parsed.app as Record<string, unknown>)[key];
        changes = v === undefined ? 0 : countChanges((app as Record<string, unknown>)[key], v);
      }
      out.push({ key, label: IMPORT_SECTIONS[key], changes, skipped: [...(parsed.skipped[key] ?? [])] });
    }
    return out;
  }

  /**
   * 고른 칸만 적용(바로 적용 — 위키 경로는 가져오지 않으므로 다시 시작 없음). 적용한 칸 이름.
   * voc 는 saveVoc(지금 값과 합쳐 저장 — loginId·myId·jarPath 는 지금 것)
   */
  applyImport(parsed: ParsedImport, sections: readonly string[], saveVoc: (v: NonNullable<ParsedImport['voc']>) => void): string[] {
    this.dropLocked(parsed);
    const applied: string[] = [];
    const want = new Set(sections);
    try {
      const patch: Partial<Record<keyof AppSettings, AppSettings[keyof AppSettings] | undefined>> = {};
      for (const key of ['me', 'notify', 'shell', 'mailIn', 'mailOut', 'ai', 'update'] as const) {
        const v = parsed.app[key];
        if (want.has(key) && v !== undefined) {
          (patch as Record<string, unknown>)[key] = v;
          applied.push(key);
        }
      }
      if (Object.keys(patch).length) this.deps.appSettings.update(patch);
      if (want.has('teamSync') && parsed.app.teamSync) {
        const cur = this.deps.teamSync.config();
        this.deps.teamSync.set({ enabled: parsed.app.teamSync.enabled, remote: parsed.app.teamSync.remote, local: cur.local });
        applied.push('teamSync');
      }
      if (want.has('mail') && parsed.mail) {
        this.deps.mailSettings().save(parsed.mail);
        applied.push('mail');
      }
      if (want.has('voc') && parsed.voc) {
        saveVoc(parsed.voc);
        applied.push('voc');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (applied.length) throw new Error(`${PARTIAL_SETTINGS_PREFIX}: ${applied.map((k) => IMPORT_SECTIONS[k] ?? k).join('·')} 은 가져왔고 나머지는 실패 — ${message}`);
      throw err;
    } finally {
      this.deps.onChanged('import');
    }
    this.deps.log?.(`설정 가져오기: ${applied.join(',') || '없음'}`);
    return applied;
  }

  // ---- 팀 기본값을 쓰는 설정 --------------------------------------------------------------------

  /** 팀 위키 동기화 설정(없으면 팀 기본값 NAS → 내장) */
  static teamSyncConfigOf(ts: AppSettings['teamSync'], teamRemote: string | undefined, defaultLocal: string): TeamSyncConfig {
    return { enabled: ts?.enabled === true, remote: ts?.remote ?? teamRemote ?? DEFAULT_TEAM_REMOTE, local: ts?.local ?? defaultLocal };
  }
}
