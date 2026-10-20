// 설정 칸 6개의 화면 쪽 계산(2.13단계 명세 §C·§D·§F-2). 순수 함수만 — main 응답 검사(normalizeSectionView), 초안 → 바뀐 필드(patch),
// 칸마다의 간단한 검사 문장, 출처 글, 점검 줄 → 칸 점·[고치기] 대상. 강한 검사는 main 이 저장·시험 때 한 번 더 한다.
import { FEATURES } from '../../shared/edition';
import { SETTINGS_TABS, type SettingsTabKey } from '../../shared/ipc';
import type {
  ConnectionTestResult,
  FieldSource,
  FieldView,
  SecretKey,
  SecretView,
  SettingsPatch,
  SettingsSection,
  SettingsSectionView,
  SetupStatus,
  TeamDefaultsSummary,
  VocBoard,
} from '../../shared/types';
import { setupRows, type SetupKey } from './setup';

export type SettingsTab = SettingsTabKey;

/** 칸 이름(순서 = 화면 순서, DESIGN §12) */
export const SETTINGS_TAB_LABEL: Readonly<Record<SettingsTab, string>> = {
  check: '점검',
  me: '나',
  wiki: '위키',
  mailIn: '메일 받기',
  mailOut: '메일 보내기',
  ai: 'AI',
  voc: 'VOC',
  notify: '알림',
  info: '정보',
};

/** 공개판에서 가린 칸(src/shared/edition.ts) — 「나」(담당 이름)는 팀 할 일·VOC 에만 쓴다 */
const HIDDEN_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  ...(FEATURES.voc ? [] : (['voc'] as const)),
  ...(FEATURES.voc || FEATURES.teamWiki ? [] : (['me'] as const)),
]);

export const SETTINGS_TAB_LIST: readonly { key: SettingsTab; label: string; testid: string }[] = SETTINGS_TABS.filter((key) => !HIDDEN_TABS.has(key)).map((key) => ({
  key,
  label: SETTINGS_TAB_LABEL[key],
  testid: `settings-tab-${key}`,
}));

/** 점검 줄 → 그 줄을 고치는 칸(§D-3) */
export const SETUP_FIX_TAB: Readonly<Record<SetupKey | 'teamsync', SettingsTab>> = {
  wiki: 'wiki',
  claude: 'ai',
  mail: 'mailOut',
  mailIn: 'mailIn',
  ai: 'ai',
  voc: 'voc',
  notify: 'notify',
  team: 'info',
  secrets: 'mailIn',
  teamsync: 'wiki',
};

/** 칸 옆 앰버 점: 점검 줄의 warn/off 가 가리키는 칸들 */
export function tabDots(status: SetupStatus | null, board: VocBoard | null, teamSyncTone?: string | null): Set<SettingsTab> {
  const out = new Set<SettingsTab>();
  if (status) {
    for (const row of setupRows(status, board)) {
      if (row.tone === 'warn' || row.tone === 'off') out.add(SETUP_FIX_TAB[row.key]);
    }
  }
  if (teamSyncTone === 'warn' || teamSyncTone === 'off') out.add('wiki');
  return out;
}

// ---- 응답 검사 ----------------------------------------------------------------------------------

const SECTIONS = new Set<SettingsSection>(['wiki', 'mailIn', 'mailOut', 'ai', 'info']);
const SOURCES = new Set<FieldSource>(['env', 'user', 'team', 'builtin', 'dotenv', 'none']);
const SECRET_KEYS: readonly SecretKey[] = ['mailIn.pass', 'mailOut.pass', 'ai.llmKey'];
const SECRET_SOURCES = new Set(['env', 'user', 'dotenv', 'none']);
const TEAM_SOURCES = new Set(['env', 'local', 'remote', 'cache', 'none']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function scalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function normalizeField(raw: unknown): FieldView | null {
  if (!isObject(raw) || !SOURCES.has(raw.source as FieldSource)) return null;
  const out: FieldView = { value: scalar(raw.value) ? (raw.value as unknown) : null, source: raw.source as FieldSource };
  if (typeof raw.envName === 'string') out.envName = raw.envName;
  for (const k of ['userValue', 'teamValue', 'builtinValue'] as const) {
    if (raw[k] !== undefined && raw[k] !== null && scalar(raw[k])) out[k] = raw[k];
  }
  if (typeof raw.problem === 'string' && raw.problem !== '') out.problem = raw.problem;
  return out;
}

export function normalizeTeamSummary(raw: unknown): TeamDefaultsSummary {
  const r = isObject(raw) ? raw : {};
  const out: TeamDefaultsSummary = {
    source: TEAM_SOURCES.has(r.source as string) ? (r.source as TeamDefaultsSummary['source']) : 'none',
    problems: strings(r.problems),
  };
  if (typeof r.path === 'string' && r.path) out.path = r.path;
  if (typeof r.readAt === 'string' && r.readAt) out.readAt = r.readAt;
  if (typeof r.fileMtime === 'string' && r.fileMtime) out.fileMtime = r.fileMtime;
  return out;
}

/** main 의 SettingsSectionView 검사. 모양이 틀리면 null(비밀 값은 원래 담기지 않는다 — 혹시 와도 버린다) */
export function normalizeSectionView(raw: unknown, want?: SettingsSection): SettingsSectionView | null {
  if (!isObject(raw) || !SECTIONS.has(raw.section as SettingsSection) || !isObject(raw.fields)) return null;
  if (want && raw.section !== want) return null;
  const fields: Record<string, FieldView> = {};
  for (const [k, v] of Object.entries(raw.fields)) {
    const f = normalizeField(v);
    if (f) fields[k] = f;
  }
  const secrets: SettingsSectionView['secrets'] = {};
  if (isObject(raw.secrets)) {
    for (const key of SECRET_KEYS) {
      const s = raw.secrets[key];
      if (!isObject(s) || typeof s.saved !== 'boolean' || !SECRET_SOURCES.has(s.source as string)) continue;
      const view: SecretView = { saved: s.saved, source: s.source as SecretView['source'] };
      if (typeof s.envName === 'string') view.envName = s.envName;
      if (s.storage === 'file' || s.storage === 'memory') view.storage = s.storage;
      secrets[key] = view;
    }
  }
  const out: SettingsSectionView = {
    section: raw.section as SettingsSection,
    fields,
    secrets,
    notes: strings(raw.notes),
    team: normalizeTeamSummary(raw.team),
  };
  if (typeof raw.restartPending === 'string' && raw.restartPending) out.restartPending = raw.restartPending;
  if (isObject(raw.dotenv) && typeof raw.dotenv.available === 'boolean') {
    out.dotenv = { available: raw.dotenv.available, file: typeof raw.dotenv.file === 'string' ? raw.dotenv.file : '' };
  }
  if (typeof raw.sameAccountUser === 'string' && raw.sameAccountUser) out.sameAccountUser = raw.sameAccountUser;
  if (isObject(raw.claude) && typeof raw.claude.path === 'string' && typeof raw.claude.exists === 'boolean') {
    const c = raw.claude;
    out.claude = {
      path: c.path as string,
      source: c.source === 'env' || c.source === 'path' ? c.source : 'default',
      exists: c.exists as boolean,
      ...(c.fake === true ? { fake: true } : {}),
      ...(typeof c.version === 'string' && c.version ? { version: c.version } : {}),
      ...(typeof c.installCommand === 'string' ? { installCommand: c.installCommand } : {}),
    };
    const lr = c.lastRun;
    if (isObject(lr) && typeof lr.at === 'string' && typeof lr.ok === 'boolean' && typeof lr.what === 'string') {
      out.claude.lastRun = { at: lr.at, ok: lr.ok, what: lr.what, ...(typeof lr.message === 'string' ? { message: lr.message } : {}) };
    }
  }
  if (typeof raw.llmProblem === 'string' && raw.llmProblem) out.llmProblem = raw.llmProblem;
  if (typeof raw.llmOutside === 'boolean') out.llmOutside = raw.llmOutside;
  if (isObject(raw.lastTest) && typeof raw.lastTest.ok === 'boolean' && typeof raw.lastTest.at === 'string') {
    out.lastTest = { ok: raw.lastTest.ok, at: raw.lastTest.at };
  }
  return out;
}

export function normalizeTestResult(raw: unknown): ConnectionTestResult | null {
  if (!isObject(raw) || typeof raw.ok !== 'boolean' || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .filter((s): s is Record<string, unknown> => isObject(s) && typeof s.label === 'string' && typeof s.ok === 'boolean')
    .map((s) => ({
      label: s.label as string,
      ok: s.ok as boolean,
      ...(s.warn === true ? { warn: true } : {}),
      ...(typeof s.detail === 'string' && s.detail ? { detail: s.detail } : {}),
    }));
  return { ok: raw.ok, steps, ms: typeof raw.ms === 'number' && raw.ms >= 0 ? raw.ms : 0 };
}

// ---- 초안 ---------------------------------------------------------------------------------------

/** 필드의 입력 꼴 */
export type FieldKind = 'text' | 'int' | 'bool' | 'enum' | 'rawText';

/** 칸마다 필드의 꼴(main settings/service.ts SECTION_FIELDS 와 같은 이름) */
export const FIELD_KINDS: Readonly<Record<SettingsSection, Readonly<Record<string, FieldKind>>>> = {
  wiki: { wikiMode: 'enum', wikiRoot: 'text', teamEnabled: 'bool', teamRemote: 'text', teamLocal: 'text' },
  mailIn: { host: 'text', port: 'int', ssl: 'bool', user: 'text', intervalMinutes: 'int', firstDate: 'text', enabled: 'bool' },
  mailOut: { sameAccount: 'bool', host: 'text', port: 'int', security: 'enum', user: 'text', fromName: 'rawText', signature: 'rawText', bccSelf: 'bool' },
  ai: { llmUrl: 'text', apiFormat: 'enum', model: 'text', draftEngine: 'enum' },
  info: { updateUrl: 'text' },
};

/** 초안: 필드 → 입력 값(글 칸은 글 그대로) · null = 내 값을 지움([팀 기본값으로]) */
export type SettingsDraft = Record<string, string | boolean | null>;

/** 비밀 칸 초안 */
export interface SecretDraft {
  action: 'keep' | 'set' | 'clear';
  value: string;
}
export const KEEP_SECRET: SecretDraft = { action: 'keep', value: '' };

/** 칸의 비밀 키(없으면 없음) */
export const SECTION_SECRET: Readonly<Partial<Record<SettingsSection, SecretKey>>> = {
  mailIn: 'mailIn.pass',
  mailOut: 'mailOut.pass',
  ai: 'ai.llmKey',
};

/** 화면에 보일 값: 초안 → (지움이면 팀·내장) → 지금 값 */
export function shownValue(view: SettingsSectionView, draft: SettingsDraft, field: string): string | boolean | null {
  const f = view.fields[field];
  if (field in draft) {
    const d = draft[field];
    if (d !== null) return d;
    return toInput(f?.teamValue ?? f?.builtinValue);
  }
  return f ? toInput(f.value) : null;
}

function toInput(v: unknown): string | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

/** 화면에 보일 글(입력 칸 value) */
export function shownText(view: SettingsSectionView, draft: SettingsDraft, field: string): string {
  const v = shownValue(view, draft, field);
  return typeof v === 'string' ? v : '';
}

export function shownBool(view: SettingsSectionView, draft: SettingsDraft, field: string): boolean {
  return shownValue(view, draft, field) === true;
}

/** 이 필드가 저장 전 초안에서 「팀 기본값으로」 되돌려졌나 */
export function isResetDraft(draft: SettingsDraft, field: string): boolean {
  return field in draft && draft[field] === null;
}

/** 지금 보이는 출처(초안을 고쳤으면 user, 지움이면 팀·내장) */
export function shownSource(view: SettingsSectionView, draft: SettingsDraft, field: string): FieldSource {
  const f = view.fields[field];
  if (!f) return 'none';
  if (f.source === 'env') return 'env';
  if (field in draft) {
    if (draft[field] !== null) return 'user';
    return f.teamValue !== undefined ? 'team' : f.builtinValue !== undefined ? 'builtin' : 'none';
  }
  return f.source;
}

/** 입력 글 → 저장할 값. 빈 글 = 지움(null). int 가 숫자가 아니면 NaN(검사 문장이 잡는다) */
function patchValue(kind: FieldKind, v: string | boolean): unknown {
  if (kind === 'bool' || typeof v === 'boolean') return v;
  if (kind === 'rawText') return v;
  const t = v.trim();
  if (t === '') return null;
  if (kind === 'int') return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
  return t;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

/** 바뀐 필드만의 patch(§D-1). 비밀은 action 이 keep 이 아니면 */
export function changedPatch(
  section: SettingsSection,
  view: SettingsSectionView,
  draft: SettingsDraft,
  secret: SecretDraft = KEEP_SECRET,
): SettingsPatch {
  const kinds = FIELD_KINDS[section];
  const out: SettingsPatch = {};
  for (const [field, raw] of Object.entries(draft)) {
    const kind = kinds[field];
    const f = view.fields[field];
    if (!kind || !f || f.source === 'env') continue;
    if (raw === null) {
      if (f.userValue !== undefined) out[field] = null;
      continue;
    }
    const value = patchValue(kind, raw);
    if (value === null) {
      if (f.userValue !== undefined) out[field] = null;
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) {
      out[field] = value;
      continue;
    }
    // 지금 적용되는 값과 같으면 바뀐 것이 아니다(고쳤다가 되돌린 경우)
    if (sameValue(value, f.value)) continue;
    out[field] = value;
  }
  const key = SECTION_SECRET[section];
  if (key && secret.action === 'clear') out.secret = { key, action: 'clear' };
  else if (key && secret.action === 'set' && secret.value !== '') out.secret = { key, action: 'set', value: secret.value };
  return out;
}

export function patchIsEmpty(patch: SettingsPatch): boolean {
  return Object.keys(patch).length === 0;
}

// ---- 검사(화면 쪽 — 간단히) -------------------------------------------------------------------

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 바뀐 필드마다 문제 문장(필드 → 문장). 없으면 빈 객체 */
export function patchProblems(section: SettingsSection, patch: SettingsPatch, today: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, v] of Object.entries(patch)) {
    if (field === 'secret' || v === null) continue;
    const p = fieldProblem(section, field, v, today);
    if (p) out[field] = p;
  }
  const s = patch.secret;
  if (s?.action === 'set' && typeof s.value === 'string') {
    const max = s.key === 'ai.llmKey' ? 512 : 256;
    if (s.value.length > max || /[\u0000-\u001f\u007f]/.test(s.value)) out.secret = `${s.key === 'ai.llmKey' ? '키' : '비밀번호'}는 ${max}자까지, 제어 문자 없이 넣으세요`;
  }
  return out;
}

export function fieldProblem(section: SettingsSection, field: string, v: unknown, today: string): string | null {
  const kind = FIELD_KINDS[section][field];
  if (kind === 'int' && (typeof v !== 'number' || Number.isNaN(v))) return '숫자를 넣으세요';
  switch (`${section}.${field}`) {
    case 'mailIn.host':
    case 'mailOut.host':
      return typeof v === 'string' && HOST_RE.test(v) ? null : '서버 이름 형식이 맞지 않습니다(서버 이름 또는 IP)';
    case 'mailIn.port':
    case 'mailOut.port':
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? null : '포트는 1~65535 사이의 숫자여야 합니다';
    case 'mailIn.user':
    case 'mailOut.user':
      return typeof v === 'string' && v.length <= 320 && !/\s|[\u0000-\u001f\u007f]/.test(v) ? null : '아이디에 공백·제어 문자를 넣을 수 없습니다';
    case 'mailIn.intervalMinutes':
      return typeof v === 'number' && Number.isInteger(v) && v >= 5 && v <= 60 ? null : '받는 주기는 5~60분 사이의 정수여야 합니다';
    case 'mailIn.firstDate':
      if (typeof v !== 'string' || !validDate(v)) return '처음 받을 날짜는 YYYY-MM-DD 날짜여야 합니다';
      if (v < '2000-01-01') return '처음 받을 날짜는 2000-01-01 이후여야 합니다';
      if (today && v > today) return '처음 받을 날짜는 오늘이거나 그 전이어야 합니다';
      return null;
    case 'ai.llmUrl':
      return typeof v === 'string' && /^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i.test(v) && v.length <= 200
        ? null
        : '주소 형식이 맞지 않습니다(http(s)://호스트[:포트]/경로)';
    case 'ai.model':
      return typeof v === 'string' && MODEL_RE.test(v) ? null : '모델 이름은 1~100자의 영문·숫자·. _ : / - 여야 합니다';
    case 'info.updateUrl':
      return typeof v === 'string' && (v.toLowerCase() === 'off' || /^https?:\/\/[^\s?#@]+$/i.test(v)) ? null : '업데이트 서버는 http(s):// 주소 또는 off 여야 합니다';
    case 'mailOut.signature':
      return typeof v === 'string' && v.length > 2000 ? '서명은 2000자까지입니다' : null;
    case 'mailOut.fromName':
      return typeof v === 'string' && v.length > 100 ? '보내는 이름은 100자까지입니다' : null;
    default:
      return null;
  }
}

// ---- 글 -----------------------------------------------------------------------------------------

/** 필드 아래 출처 글(사람 값이면 빈 글) */
export function sourceText(source: FieldSource, envName?: string): string {
  switch (source) {
    case 'env':
      return `환경 변수 ${envName ?? ''} 로 정해짐`.replace('  ', ' ');
    case 'team':
      return '팀 기본값';
    case 'builtin':
      return '내장 기본값';
    case 'dotenv':
      return '위키의 _mail-ingest/.env 에서 읽음';
    case 'none':
      return '정하지 않음';
    default:
      return '';
  }
}

/** 'YYYY-MM-DDTHH:mm:ss' → 'YYYY-MM-DD HH:mm' */
export function shortDateTime(s: string | undefined): string {
  return s ? s.replace('T', ' ').slice(0, 16) : '';
}

/** 칸 머리 한 줄(§B-5) */
export function teamHeadText(team: TeamDefaultsSummary): string {
  const when = shortDateTime(team.readAt);
  switch (team.source) {
    case 'env':
      return `팀 기본값: 환경 변수 파일 · ${when} 읽음`;
    case 'local':
      return `팀 기본값: 내 PC 사본 · ${when} 읽음`;
    case 'remote':
      return `팀 기본값: NAS · ${when} 읽음`;
    case 'cache':
      return `팀 기본값: 마지막 값(${when}) — NAS 가 안 보임`;
    default:
      return '팀 기본값 없음 — 내장 기본값';
  }
}

/** 비밀 칸 상태 글 */
export function secretText(view: SecretView | undefined, draft: SecretDraft): string {
  if (draft.action === 'set') return draft.value ? '새 값 — 저장하면 바뀜' : '새 값을 넣으세요';
  if (draft.action === 'clear') return '지움 — 저장하면 지워짐';
  if (!view) return '없음';
  if (view.source === 'env') return `환경 변수 ${view.envName ?? ''} 로 정해짐`;
  if (view.saved) return view.storage === 'memory' ? '저장됨(이번 실행 동안만)' : '저장됨';
  if (view.source === 'dotenv') return '위키의 _mail-ingest/.env 에서 읽음';
  return '없음';
}

/** 저장 결과 한 줄 */
export function saveResultText(r: { ignored: string[]; restartNeeded?: boolean; secretStorage?: 'file' | 'memory' }): string {
  const parts = [r.restartNeeded ? '저장했습니다. 다시 시작하면 새 위키를 읽습니다.' : '저장했습니다. 바로 적용됩니다.'];
  if (r.ignored.length) parts.push(`환경 변수로 정해진 ${r.ignored.join(', ')} 은 바꾸지 않았습니다.`);
  if (r.secretStorage === 'memory') parts.push('비밀은 이번 실행 동안만 기억합니다(이 PC 에서 암호화를 쓸 수 없음).');
  return parts.join(' ');
}

/** 연결 시험 단계 상태 */
export function stepTone(step: { ok: boolean; warn?: boolean }): 'ok' | 'warn' | 'fail' {
  return !step.ok ? 'fail' : step.warn ? 'warn' : 'ok';
}

/** 회사 도메인 — main settings/fields.ts 의 COMPANY_DOMAIN 과 같게 */
const COMPANY_DOMAIN = 'acme.test';

/** 로컬 LLM 주소가 사설망·루프백(IP 글자)·회사 도메인 밖인가 — 「회사 밖으로 나가나」 열(§C-4). 모양이 틀리면 null */
export function llmUrlOutside(url: string): boolean | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '::1' || host === 'localhost') return false;
  const bare = host.replace(/\.$/, '');
  if (bare === COMPANY_DOMAIN || bare.endsWith(`.${COMPANY_DOMAIN}`)) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return !(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}
