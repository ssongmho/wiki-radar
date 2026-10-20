// 설정 값의 우선순위(2.13단계 명세 §A-3). electron 을 import 하지 않는 순수 모듈이다 — 저장소는 인자로 받는다.
//
//   환경 변수 > 화면 값(app-settings.json / secrets.bin) > 팀 기본값 > 내장 기본값 > (메일 아이디·비밀번호만) 위키 _mail-ingest/.env
//
// - 필드마다 resolveField 하나의 규칙. 환경 변수로 정해진 필드는 잠긴다(화면 disabled, 저장 요청은 무시 — service.ts).
// - 아이디·비밀번호는 한 쌍으로 정한다: 환경 변수 둘 다 → 화면 값(아이디 + 저장된 비밀번호) 둘 다 → .env 둘 다. 섞지 않는다.
// - 「같은 계정」(기본 켬)이면 SMTP 계정 = 메일 받기 칸에서 정해진 쌍. 단 WIKI_RADAR_SMTP_USER+PASS 가 있으면 그것이 이긴다.
// - 아무 설정도 없으면 SMTP 는 지금처럼 smtps.mailhost.test:465 + .env 계정(loadSmtpAccount 와 같은 결과 — 단위 시험).
import type { FieldSource, FieldView, SecretKey, SecretView, TeamDefaultValues } from '../../shared/types';
import type { AppSettings } from '../appSettings';
import {
  CONTROL_RE,
  DEFAULT_SMTP_HOST,
  NO_ACCOUNT_PROBLEM,
  isLoopbackHost,
  type AccountResult,
  type DotEnvAccount,
  type SmtpAccount,
} from '../mail/account';
import {
  MAIL_IN_INTERVAL_DEFAULT,
  POP3_PLAIN_PORT,
  POP3_SSL_PORT,
  SMTP_SSL_PORT,
  SMTP_STARTTLS_PORT,
  hostProblem,
  modelProblem,
  normalizeLlmUrl,
  normalizeUpdateUrl,
} from './fields';

/** 비밀 읽기(secrets.ts SecretStore 의 일부) */
export interface SecretReader {
  has(key: SecretKey): boolean;
  get(key: SecretKey): string | undefined;
  storage?(): 'file' | 'memory';
}

export interface ResolveInput {
  env: NodeJS.ProcessEnv;
  settings: AppSettings;
  secrets: SecretReader | null;
  team: TeamDefaultValues;
  /** 위키 _mail-ingest/.env 계정(부를 때 읽는다 — 예비로만) */
  dotenv: () => DotEnvAccount;
}

type EnvParse<T> = { value: T } | { problem: string };

const SOURCE_RANK: Record<FieldSource, number> = { env: 0, user: 1, team: 2, builtin: 3, dotenv: 4, none: 5 };

/**
 * 포트와 보안(SSL) 방식은 한 쌍이다 — 출처가 다르면 높은 쪽(환경 변수 > 내 값 > 팀 값)을 따르고, 낮은 쪽은 그 값에서 정한다.
 * 예: WIKI_RADAR_SMTP_PORT=587 만 주면 보안은 팀 값 ssl 이 아니라 포트에서 정한 starttls(기존 loadSmtpAccount 와 같다)
 */
function pairWith<A, B>(lead: FieldView<A>, follow: FieldView<B>, derive: (a: A) => B): FieldView<B> {
  if (lead.value === null || SOURCE_RANK[lead.source] >= SOURCE_RANK[follow.source]) return follow;
  const { userValue, teamValue } = follow;
  const value = derive(lead.value);
  return { ...(userValue !== undefined ? { userValue } : {}), ...(teamValue !== undefined ? { teamValue } : {}), builtinValue: value, value, source: 'builtin' };
}

function envText(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 필드 하나: 환경 변수(이름·해석) > 사람 값 > 팀 값 > 내장 값. 환경 변수 값이 틀리면 source env + problem(값 없음) —
 * 다른 출처로 몰래 넘어가지 않는다(기존 SMTP 환경 변수 규칙과 같다)
 */
export function resolveField<T>(
  env: { name: string; raw: string; parse: (raw: string) => EnvParse<T> } | null,
  user: T | undefined,
  team: T | undefined,
  builtin: T | undefined,
): FieldView<T> {
  const base: Omit<FieldView<T>, 'value' | 'source'> = {};
  if (user !== undefined) base.userValue = user;
  if (team !== undefined) base.teamValue = team;
  if (builtin !== undefined) base.builtinValue = builtin;
  if (env && env.raw !== '') {
    const parsed = env.parse(env.raw);
    if ('value' in parsed) return { ...base, value: parsed.value, source: 'env', envName: env.name };
    return { ...base, value: null, source: 'env', envName: env.name, problem: `${env.name}: ${parsed.problem}` };
  }
  if (user !== undefined) return { ...base, value: user, source: 'user' };
  if (team !== undefined) return { ...base, value: team, source: 'team' };
  if (builtin !== undefined) return { ...base, value: builtin, source: 'builtin' };
  return { ...base, value: null, source: 'none' };
}

const envHost = (name: string) => (env: NodeJS.ProcessEnv) => ({
  name,
  raw: envText(env, name),
  parse: (raw: string): EnvParse<string> => {
    const p = hostProblem(raw);
    return p ? { problem: p } : { value: raw };
  },
});
const envPort = (name: string) => (env: NodeJS.ProcessEnv) => ({
  name,
  raw: envText(env, name),
  parse: (raw: string): EnvParse<number> => {
    const n = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
    return n >= 1 && n <= 65535 ? { value: n } : { problem: '1~65535 사이의 숫자여야 합니다' };
  },
});
const envFlag = (name: string) => (env: NodeJS.ProcessEnv) => ({
  name,
  raw: envText(env, name),
  parse: (raw: string): EnvParse<boolean> => (raw === '1' ? { value: true } : raw === '0' ? { value: false } : { problem: '1 또는 0 이어야 합니다' }),
});

// ---- 계정(아이디·비밀번호 한 쌍) -------------------------------------------------------------------

export type AccountSource = 'env' | 'user' | 'dotenv' | 'none';

export interface AccountPair {
  source: AccountSource;
  user?: string;
  pass?: string;
  /** env 면 아이디·비밀번호 환경 변수 이름 */
  envNames?: [string, string];
  /** .env 를 읽다 생긴 문제(계정 없음으로 본다) */
  problem?: string;
}

function envPair(env: NodeJS.ProcessEnv, userName: string, passName: string): AccountPair | null {
  const user = envText(env, userName);
  const pass = typeof env[passName] === 'string' ? (env[passName] as string) : '';
  return user !== '' && pass !== '' ? { source: 'env', user, pass, envNames: [userName, passName] } : null;
}

function dotenvPair(input: ResolveInput): AccountPair {
  let dot: DotEnvAccount;
  try {
    dot = input.dotenv();
  } catch (err) {
    return { source: 'none', problem: `메일 계정 파일을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!dot.ok) return { source: 'none', problem: dot.problem };
  return dot.user && dot.pass ? { source: 'dotenv', user: dot.user, pass: dot.pass } : { source: 'none' };
}

/** 메일 받기 계정: WIKI_RADAR_POP3_USER+PASS → 화면 아이디 + secrets mailIn.pass → .env */
export function resolveMailInAccount(input: ResolveInput): AccountPair {
  const fromEnv = envPair(input.env, 'WIKI_RADAR_POP3_USER', 'WIKI_RADAR_POP3_PASS');
  if (fromEnv) return fromEnv;
  const user = input.settings.mailIn?.user;
  const pass = input.secrets?.get('mailIn.pass');
  if (user && pass) return { source: 'user', user, pass };
  return dotenvPair(input);
}

/** 메일 보내기 계정: WIKI_RADAR_SMTP_USER+PASS → (같은 계정이면) 메일 받기 쌍 → 화면 아이디 + secrets mailOut.pass → .env */
export function resolveMailOutAccount(input: ResolveInput): AccountPair {
  const fromEnv = envPair(input.env, 'WIKI_RADAR_SMTP_USER', 'WIKI_RADAR_SMTP_PASS');
  if (fromEnv) return fromEnv;
  if (input.settings.mailOut?.sameAccount !== false) return resolveMailInAccount(input);
  const user = input.settings.mailOut?.user;
  const pass = input.secrets?.get('mailOut.pass');
  if (user && pass) return { source: 'user', user, pass };
  return dotenvPair(input);
}

function secretView(input: ResolveInput, key: SecretKey, pair: { source: AccountSource; envNames?: [string, string] }): SecretView {
  const out: SecretView = { saved: !!input.secrets?.has(key), source: pair.source };
  if (pair.envNames) out.envName = pair.envNames[1];
  const storage = input.secrets?.storage?.();
  if (storage) out.storage = storage;
  return out;
}

/** 아이디 필드: 환경 변수 쌍 > 화면 아이디 > .env 쌍 */
function userField(pair: AccountPair, userValue: string | undefined): FieldView<string> {
  const base: Partial<FieldView<string>> = userValue !== undefined ? { userValue } : {};
  if (pair.source === 'env') return { ...base, value: pair.user ?? null, source: 'env', ...(pair.envNames ? { envName: pair.envNames[0] } : {}) };
  if (userValue !== undefined) {
    // 화면 아이디만 있고 비밀번호가 없으면 실제로는 다른 쌍(.env)을 쓴다 — 화면과 실제가 다르다는 것을 알린다
    if (pair.source !== 'user') {
      const actual = pair.source === 'dotenv' && pair.user ? `위키 _mail-ingest/.env 계정(${pair.user})을 씁니다` : '계정이 없습니다';
      return { ...base, value: userValue, source: 'user', problem: `비밀번호가 저장되지 않아 이 아이디는 쓰지 않고 ${actual} — 비밀번호도 넣으세요` };
    }
    return { ...base, value: userValue, source: 'user' };
  }
  if (pair.source === 'dotenv') return { ...base, value: pair.user ?? null, source: 'dotenv' };
  return { ...base, value: null, source: 'none' };
}

// ---- 칸별 ---------------------------------------------------------------------------------------

export interface MailInResolved {
  fields: {
    host: FieldView<string>;
    port: FieldView<number>;
    ssl: FieldView<boolean>;
    user: FieldView<string>;
    intervalMinutes: FieldView<number>;
    firstDate: FieldView<string>;
    enabled: FieldView<boolean>;
  };
  account: AccountPair;
  secret: SecretView;
}

export function resolveMailIn(input: ResolveInput): MailInResolved {
  const { env, settings, team } = input;
  const mi = settings.mailIn ?? {};
  const tm = team.mailIn ?? {};
  const ssl0 = resolveField(envFlag('WIKI_RADAR_POP3_SSL')(env), mi.ssl, tm.ssl, true);
  const port0 = resolveField(envPort('WIKI_RADAR_POP3_PORT')(env), mi.port, tm.port, ssl0.value === false ? POP3_PLAIN_PORT : POP3_SSL_PORT);
  // 한 쌍(pairWith): 포트가 더 높은 출처면 SSL 은 포트에서(110 이면 평문), SSL 이 더 높으면 포트는 SSL 에서
  const ssl = pairWith(port0, ssl0, (port) => port !== POP3_PLAIN_PORT);
  const port = pairWith(ssl0, port0, (on) => (on ? POP3_SSL_PORT : POP3_PLAIN_PORT));
  const account = resolveMailInAccount(input);
  return {
    fields: {
      host: resolveField(envHost('WIKI_RADAR_POP3_HOST')(env), mi.host, tm.host, undefined),
      port,
      ssl,
      user: userField(account, mi.user),
      intervalMinutes: resolveField(null, mi.intervalMinutes, tm.intervalMinutes, MAIL_IN_INTERVAL_DEFAULT),
      firstDate: resolveField(null, mi.firstDate, undefined, undefined),
      enabled: resolveField(null, mi.enabled, undefined, true),
    },
    account,
    secret: secretView(input, 'mailIn.pass', account),
  };
}

export interface MailOutResolved {
  fields: {
    sameAccount: FieldView<boolean>;
    host: FieldView<string>;
    port: FieldView<number>;
    security: FieldView<'ssl' | 'starttls'>;
    user: FieldView<string>;
  };
  account: AccountPair;
  secret: SecretView;
}

export function resolveMailOut(input: ResolveInput): MailOutResolved {
  const { env, settings, team } = input;
  const mo = settings.mailOut ?? {};
  const tm = team.mailOut ?? {};
  const port0 = resolveField(envPort('WIKI_RADAR_SMTP_PORT')(env), mo.port, tm.port, SMTP_SSL_PORT);
  const security0 = resolveField<'ssl' | 'starttls'>(
    {
      name: 'WIKI_RADAR_SMTP_SECURE',
      raw: envText(env, 'WIKI_RADAR_SMTP_SECURE'),
      parse: (raw) => (raw === '1' ? { value: 'ssl' } : raw === '0' ? { value: 'starttls' } : { problem: '1 또는 0 이어야 합니다' }),
    },
    mo.security,
    tm.security,
    // 내장: 포트가 465면 SSL(기존 WIKI_RADAR_SMTP_SECURE 기본값과 같다)
    (port0.value ?? SMTP_SSL_PORT) === SMTP_SSL_PORT ? 'ssl' : 'starttls',
  );
  // 한 쌍(pairWith): 포트가 더 높은 출처면 보안은 포트에서(465 → ssl), 보안이 더 높으면 포트는 보안에서(ssl → 465, 아니면 587)
  const security = pairWith<number, 'ssl' | 'starttls'>(port0, security0, (p) => (p === SMTP_SSL_PORT ? 'ssl' : 'starttls'));
  const port = pairWith<'ssl' | 'starttls', number>(security0, port0, (sec) => (sec === 'ssl' ? SMTP_SSL_PORT : SMTP_STARTTLS_PORT));
  const account = resolveMailOutAccount(input);
  // 같은 계정이고 SMTP 환경 변수 쌍이 없으면 아이디 필드는 받기 칸의 것을 보인다(이 칸의 아이디는 쓰지 않는다)
  const sameAccount = resolveField(null, mo.sameAccount, undefined, true);
  return {
    fields: {
      sameAccount,
      host: resolveField(envHost('WIKI_RADAR_SMTP_HOST')(env), mo.host, tm.host, DEFAULT_SMTP_HOST),
      port,
      security,
      user: userField(account, sameAccount.value === false || account.source === 'env' ? mo.user : undefined),
    },
    account,
    secret: secretView(input, 'mailOut.pass', account),
  };
}

export interface AiResolved {
  fields: {
    llmUrl: FieldView<string>;
    apiFormat: FieldView<'openai'>;
    model: FieldView<string>;
    draftEngine: FieldView<'claude' | 'local'>;
  };
  key: { value?: string; source: 'env' | 'user' | 'none' };
  secret: SecretView;
}

export function resolveAi(input: ResolveInput): AiResolved {
  // 팀 기본값은 보지 않는다(AI 는 각자 설정·시험 — 소유자 결정 2026-10-19)
  const { env, settings } = input;
  const ai = settings.ai ?? {};
  const envKey = typeof env.SERVER_LLM_API_KEY === 'string' ? env.SERVER_LLM_API_KEY.trim() : '';
  const userKey = input.secrets?.get('ai.llmKey');
  const key: AiResolved['key'] = envKey ? { value: envKey, source: 'env' } : userKey ? { value: userKey, source: 'user' } : { source: 'none' };
  const secret: SecretView = { saved: !!input.secrets?.has('ai.llmKey'), source: key.source };
  if (key.source === 'env') secret.envName = 'SERVER_LLM_API_KEY';
  const storage = input.secrets?.storage?.();
  if (storage) secret.storage = storage;
  return {
    fields: {
      llmUrl: resolveField<string>(
        {
          name: 'WIKI_RADAR_LLM_URL',
          raw: envText(env, 'WIKI_RADAR_LLM_URL'),
          parse: (raw) => {
            const r = normalizeLlmUrl(raw);
            return 'url' in r ? { value: r.url } : r;
          },
        },
        ai.llmUrl,
        undefined,
        undefined,
      ),
      apiFormat: resolveField(null, ai.apiFormat, undefined, 'openai'),
      model: resolveField<string>(
        {
          name: 'WIKI_RADAR_LLM_MODEL',
          raw: envText(env, 'WIKI_RADAR_LLM_MODEL'),
          parse: (raw) => {
            const p = modelProblem(raw);
            return p ? { problem: p } : { value: raw };
          },
        },
        ai.model,
        undefined,
        undefined,
      ),
      draftEngine: resolveField(null, ai.draftEngine, undefined, 'claude'),
    },
    key,
    secret,
  };
}

/** 업데이트 서버: WIKI_RADAR_UPDATE_URL > 화면 > 팀 > 내장(builtin — updater.ts 의 DEFAULT_UPDATE_URL) */
export function resolveUpdateUrl(env: NodeJS.ProcessEnv, settings: AppSettings, team: TeamDefaultValues, builtin: string): FieldView<string> {
  return resolveField<string>(
    {
      name: 'WIKI_RADAR_UPDATE_URL',
      raw: envText(env, 'WIKI_RADAR_UPDATE_URL'),
      parse: (raw) => {
        const r = normalizeUpdateUrl(raw);
        return 'url' in r ? { value: r.url } : r;
      },
    },
    settings.update?.url,
    team.update?.url,
    builtin,
  );
}

// ---- 쓰는 쪽(발송·연결)이 부르는 것 ----------------------------------------------------------------

function accountProblem(user: string, pass: string): string | null {
  if (CONTROL_RE.test(user) || /\s/.test(user) || user.length > 320 || CONTROL_RE.test(pass)) {
    return '메일 계정 아이디나 비밀번호에 쓸 수 없는 글자가 있습니다';
  }
  return null;
}

/**
 * SMTP 계정(2.13단계 §C-3 — 기존 loadSmtpAccount 를 넓힌 것). 부를 때마다 새로 계산한다(캐시 없음 — 저장 즉시 다음 발송에 적용).
 * 환경 변수 값이 틀리면 기존과 같은 문장
 */
export function resolveSmtpAccount(input: ResolveInput): AccountResult {
  const r = resolveMailOut(input);
  const { host, port, security } = r.fields;
  if (host.source === 'env' && host.problem) return { ok: false, problem: 'WIKI_RADAR_SMTP_HOST 형식이 맞지 않습니다(서버 이름 또는 IP)' };
  if (port.source === 'env' && port.problem) return { ok: false, problem: 'WIKI_RADAR_SMTP_PORT 는 1~65535 사이의 숫자여야 합니다' };
  if (security.source === 'env' && security.problem) return { ok: false, problem: 'WIKI_RADAR_SMTP_SECURE 는 1 또는 0 이어야 합니다' };
  if (!host.value || !port.value || !security.value) return { ok: false, problem: '메일 보내기 서버 설정이 비어 있습니다 — 설정 › 메일 보내기를 확인하세요' };
  const a = r.account;
  if (a.source === 'none' || !a.user || !a.pass) return { ok: false, problem: a.problem ?? NO_ACCOUNT_PROBLEM };
  const bad = accountProblem(a.user, a.pass);
  if (bad) return { ok: false, problem: bad };
  const secure = security.value === 'ssl';
  // 처음부터 TLS 가 아니면 STARTTLS 를 반드시 거친다(비밀번호를 평문으로 보내지 않게). 루프백 가짜 서버만 예외
  const requireTLS = !secure && !isLoopbackHost(host.value);
  const account: SmtpAccount = { host: host.value, port: port.value, secure, requireTLS, user: a.user, pass: a.pass };
  return { ok: true, account };
}

export interface Pop3Account {
  host: string;
  port: number;
  ssl: boolean;
  user: string;
  pass: string;
}

/** POP3 계정(연결 시험·다음 작업의 수집기). 서버·계정이 없으면 problem */
export function resolvePop3Account(input: ResolveInput): { ok: true; account: Pop3Account } | { ok: false; problem: string } {
  const r = resolveMailIn(input);
  const { host, port, ssl } = r.fields;
  for (const f of [host, port, ssl]) if (f.source === 'env' && f.problem) return { ok: false, problem: f.problem };
  if (!host.value) return { ok: false, problem: '메일 받기 서버가 없습니다 — 설정 › 메일 받기에서 넣으세요' };
  const a = r.account;
  if (a.source === 'none' || !a.user || !a.pass) return { ok: false, problem: a.problem ?? '메일 받기 계정이 없습니다 — 설정 › 메일 받기에서 아이디·비밀번호를 넣으세요' };
  const bad = accountProblem(a.user, a.pass);
  if (bad) return { ok: false, problem: bad };
  return { ok: true, account: { host: host.value, port: port.value ?? POP3_SSL_PORT, ssl: ssl.value !== false, user: a.user, pass: a.pass } };
}

export interface LlmTarget {
  url: string;
  model: string;
  key?: string;
}

/** 로컬 LLM 주소의 host[:port](소문자) — 키를 보내도 되는 호스트 비교용 */
export function llmHostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 로컬 LLM(회신 초안·연결 시험). 주소·모델이 없으면 problem.
 * 주소의 출처(내 설정·환경 변수)·키 유무와 상관없이 **[연결 시험]에 성공한 호스트(ai.keyHost)일 때만** 쓴다(소유자 결정
 * 2026-10-19 — AI 는 사용자가 정하고 시험해서 쓰는 값). testing 은 사람이 누른 [연결 시험] 자체만
 */
export function resolveLlm(input: ResolveInput, opts: { testing?: boolean } = {}): { ok: true; target: LlmTarget } | { ok: false; problem: string; untested?: true } {
  const r = resolveAi(input);
  const { llmUrl, model } = r.fields;
  if (llmUrl.problem) return { ok: false, problem: llmUrl.problem };
  if (model.problem) return { ok: false, problem: model.problem };
  if (!llmUrl.value || !model.value) return { ok: false, problem: '설정 › AI 에서 로컬 LLM 주소·모델을 넣으세요' };
  if (!opts.testing && input.settings.ai?.keyHost !== llmHostOf(llmUrl.value)) {
    return {
      ok: false,
      untested: true,
      problem: `로컬 LLM(${llmHostOf(llmUrl.value)})을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다`,
    };
  }
  return { ok: true, target: { url: llmUrl.value, model: model.value, ...(r.key.value ? { key: r.key.value } : {}) } };
}

/** 출처 → 화면 글(진단 정보·로그) */
export function sourceLabel(source: FieldSource): string {
  switch (source) {
    case 'env':
      return '환경 변수';
    case 'user':
      return '내 설정';
    case 'team':
      return '팀 기본값';
    case 'builtin':
      return '내장 기본값';
    case 'dotenv':
      return '위키 _mail-ingest/.env';
    default:
      return '없음';
  }
}
