// 설정 칸의 필드 형·검사(2.13단계 명세 §A-1·§C). electron 을 import 하지 않는 순수 모듈이다.
// app-settings.json 읽기(parseAppSettings — 틀린 필드만 버림)·저장 검사·팀 기본값 검사가 같은 함수를 쓴다.
import net from 'node:net';
import { isValidDateString } from '../config';
import { HOST_RE, isLoopbackHost } from '../mail/account';

/** 메일 받기(POP3) — 모든 필드 선택(없으면 사람이 정하지 않음) */
export interface MailInSettings {
  host?: string;
  port?: number;
  ssl?: boolean;
  user?: string;
  /** 5~60 정수(분) */
  intervalMinutes?: number;
  /** YYYY-MM-DD */
  firstDate?: string;
  /** 수집 켬(다음 작업이 읽는다). 이번엔 저장만 */
  enabled?: boolean;
}

/** 메일 보내기(SMTP). 보내는 이름·서명·숨은참조는 mail-settings.json(2.5) 그대로 */
export interface MailOutSettings {
  /** 받기와 같은 계정(기본 켬) */
  sameAccount?: boolean;
  host?: string;
  port?: number;
  security?: 'ssl' | 'starttls';
  user?: string;
}

export interface AiSettings {
  llmUrl?: string;
  apiFormat?: 'openai';
  model?: string;
  draftEngine?: 'claude' | 'local';
  /**
   * [연결 시험]에 성공한 로컬 LLM 호스트(host[:port]) — 키 유무와 상관없이 시험이 성공할 때만 적는다.
   * 주소의 출처(내 설정·환경 변수)와 상관없이 지금 주소의 호스트가 이것과 다르면 쓰지 않는다(소유자 결정 2026-10-19).
   * 이름은 예전(키를 보낼 호스트) 그대로 — 저장된 app-settings.json 과 맞추려고
   */
  keyHost?: string;
}

export interface UpdateSettings {
  /** http(s) 주소 또는 'off' */
  url?: string;
}

export const POP3_SSL_PORT = 995;
export const POP3_PLAIN_PORT = 110;
export const MAIL_IN_INTERVAL_DEFAULT = 10;
export const MAIL_IN_INTERVAL_MIN = 5;
export const MAIL_IN_INTERVAL_MAX = 60;
export const SMTP_SSL_PORT = 465;
export const SMTP_STARTTLS_PORT = 587;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
const URL_MAX = 200;

// ---- 검사(문제가 있으면 한국어 문장) -------------------------------------------------------------

export function hostProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return '서버 이름을 넣으세요';
  const h = v.trim();
  if (h.length > 253 || !HOST_RE.test(h)) return '서버 이름 형식이 맞지 않습니다(서버 이름 또는 IP)';
  return null;
}

export function portProblem(v: unknown): string | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? null : '포트는 1~65535 사이의 숫자여야 합니다';
}

/** 메일 아이디: 제어 문자·공백 없음, 320자까지 */
export function mailUserProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return '아이디를 넣으세요';
  const u = v.trim();
  if (u.length > 320 || CONTROL_RE.test(u) || /\s/.test(u)) return '아이디에 쓸 수 없는 글자(공백·제어 문자)가 있거나 너무 깁니다';
  return null;
}

export function intervalProblem(v: unknown): string | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= MAIL_IN_INTERVAL_MIN && v <= MAIL_IN_INTERVAL_MAX
    ? null
    : `받는 주기는 ${MAIL_IN_INTERVAL_MIN}~${MAIL_IN_INTERVAL_MAX}분 사이의 정수여야 합니다`;
}

/** 처음 받을 날짜: YYYY-MM-DD, 2000-01-01 이후, today 를 주면 그날까지 */
export function firstDateProblem(v: unknown, today?: string): string | null {
  if (typeof v !== 'string' || !isValidDateString(v)) return '처음 받을 날짜는 YYYY-MM-DD 날짜여야 합니다';
  if (v < '2000-01-01') return '처음 받을 날짜는 2000-01-01 이후여야 합니다';
  if (today && v > today) return '처음 받을 날짜는 오늘이거나 그 전이어야 합니다';
  return null;
}

/** IPv4 사설망·루프백(10/8 · 172.16/12 · 192.168/16 · 127/8) 또는 ::1 인가 — IP 글자일 때만 참 */
export function isPrivateIp(host: string): boolean {
  let h = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '::1') return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/**
 * 로컬 LLM 주소: http(s)://호스트[:포트][/경로] ≤200, 자격·쿼리·조각 없음, 끝 / 뗌. http 는 사설망·루프백 IP 글자에만.
 * 맞으면 정리한 주소, 아니면 문제 문장
 */
export function normalizeLlmUrl(v: unknown): { url: string } | { problem: string } {
  if (typeof v !== 'string' || v.trim() === '') return { problem: '로컬 LLM 주소를 넣으세요' };
  const s = v.trim().replace(/\/+$/, '');
  if (s.length > URL_MAX) return { problem: `주소가 너무 깁니다(${URL_MAX}자까지)` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { problem: '주소 형식이 맞지 않습니다(http(s)://호스트[:포트]/경로)' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { problem: '주소는 http:// 또는 https:// 로 시작해야 합니다' };
  if (u.username || u.password || u.search || u.hash || s.includes('?') || s.includes('#')) {
    return { problem: '주소에 아이디·비밀번호·물음표(?)·# 을 넣을 수 없습니다' };
  }
  if (u.protocol === 'http:' && !isPrivateIp(u.hostname)) {
    return { problem: 'http 주소는 사내망·이 PC IP(10.x·172.16~31.x·192.168.x·127.x)에만 씁니다 — 그 밖은 https 로' };
  }
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

export function llmUrlProblem(v: unknown): string | null {
  const r = normalizeLlmUrl(v);
  return 'problem' in r ? r.problem : null;
}

/** 회사 도메인 — 공인 DNS 지만 회사 nginx 가 사내망만 받는다(lgw.acme.test 게이트웨이 등) */
export const COMPANY_DOMAIN = 'acme.test';

/** 회사 도메인(그 아래 이름 포함)인가 */
export function isCompanyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === COMPANY_DOMAIN || h.endsWith(`.${COMPANY_DOMAIN}`);
}

/** 로컬 LLM 주소가 사설망·루프백·회사 도메인 밖인가(회사 밖으로 나감) */
export function llmUrlOutside(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !isPrivateIp(h) && !isLoopbackHost(h) && !isCompanyHost(h);
  } catch {
    return true;
  }
}

export function modelProblem(v: unknown): string | null {
  return typeof v === 'string' && MODEL_RE.test(v.trim()) ? null : '모델 이름은 1~100자의 영문·숫자·. _ : / - 여야 합니다';
}

/** 업데이트 서버: 'off' 또는 http(s):// 주소(≤200, 자격·쿼리·조각 없음). 맞으면 정리한 값 */
export function normalizeUpdateUrl(v: unknown): { url: string } | { problem: string } {
  if (typeof v !== 'string' || v.trim() === '') return { problem: '업데이트 서버 주소를 넣으세요(끄려면 off)' };
  const s = v.trim();
  if (s.toLowerCase() === 'off') return { url: 'off' };
  if (s.length > URL_MAX) return { problem: `주소가 너무 깁니다(${URL_MAX}자까지)` };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { problem: '주소 형식이 맞지 않습니다(http(s)://호스트[:포트]/)' };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) {
    return { problem: '업데이트 서버는 http(s):// 주소 또는 off 여야 합니다' };
  }
  return { url: u.href };
}

// ---- 파일 읽기(틀린 필드만 버린다) ---------------------------------------------------------------

function obj(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function parseMailInSettings(raw: unknown): MailInSettings {
  const r = obj(raw);
  const out: MailInSettings = {};
  if (!r) return out;
  if (hostProblem(r.host) === null) out.host = (r.host as string).trim();
  if (portProblem(r.port) === null) out.port = r.port as number;
  if (typeof r.ssl === 'boolean') out.ssl = r.ssl;
  if (mailUserProblem(r.user) === null) out.user = (r.user as string).trim();
  if (intervalProblem(r.intervalMinutes) === null) out.intervalMinutes = r.intervalMinutes as number;
  if (firstDateProblem(r.firstDate) === null) out.firstDate = r.firstDate as string;
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  return out;
}

export function parseMailOutSettings(raw: unknown): MailOutSettings {
  const r = obj(raw);
  const out: MailOutSettings = {};
  if (!r) return out;
  if (typeof r.sameAccount === 'boolean') out.sameAccount = r.sameAccount;
  if (hostProblem(r.host) === null) out.host = (r.host as string).trim();
  if (portProblem(r.port) === null) out.port = r.port as number;
  if (r.security === 'ssl' || r.security === 'starttls') out.security = r.security;
  if (mailUserProblem(r.user) === null) out.user = (r.user as string).trim();
  return out;
}

export function parseAiSettings(raw: unknown): AiSettings {
  const r = obj(raw);
  const out: AiSettings = {};
  if (!r) return out;
  const url = normalizeLlmUrl(r.llmUrl);
  if ('url' in url) out.llmUrl = url.url;
  if (r.apiFormat === 'openai') out.apiFormat = 'openai';
  if (modelProblem(r.model) === null) out.model = (r.model as string).trim();
  if (r.draftEngine === 'claude' || r.draftEngine === 'local') out.draftEngine = r.draftEngine;
  if (typeof r.keyHost === 'string' && /^[a-z0-9.:[\]-]{1,300}$/i.test(r.keyHost)) out.keyHost = r.keyHost.toLowerCase();
  return out;
}

export function parseUpdateSettings(raw: unknown): UpdateSettings {
  const r = obj(raw);
  const out: UpdateSettings = {};
  if (!r) return out;
  const url = normalizeUpdateUrl(r.url);
  if ('url' in url) out.url = url.url;
  return out;
}

/** 빈 객체면 undefined(파일에 빈 칸을 남기지 않는다) */
export function nonEmpty<T extends object>(v: T): T | undefined {
  return Object.keys(v).length > 0 ? v : undefined;
}
