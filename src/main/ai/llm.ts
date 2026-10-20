// 로컬 LLM 클라이언트(OpenAI 호환 — 2.13단계 명세 §C-4). electron 을 import 하지 않는다(fetch 만).
//
// - 요청 본문에 **언제나** chat_template_kwargs:{enable_thinking:false} 를 넣는다(소유자 결정 — 빠지면 추론 모드라 content 가 null).
//   부르는 쪽이 잊을 수 없게 클라이언트가 넣는다.
// - 키가 없으면 Authorization 머리말 없이 부른다. 키는 어떤 오류 문장에도 넣지 않는다(redactSecrets).
// - 응답 64KB 한도. 시험 모드(VITEST·WIKI_RADAR_TEST_MODE=1)에서는 루프백 밖 주소를 부르기 전에 막는다.
import type { ConnectionTestResult, ConnectionTestStep } from '../../shared/types';
import { isLoopbackHost, redactSecrets } from '../mail/account';

export const LLM_RESPONSE_MAX_BYTES = 64 * 1024;
export const LLM_MODELS_TIMEOUT_MS = 5_000;
export const LLM_TEST_TIMEOUT_MS = 20_000;
export const LLM_TEST_GUARD_PROBLEM = '시험 중에는 이 PC 밖의 LLM 서버를 부르지 않습니다';
export const LLM_NULL_CONTENT_PROBLEM = '응답 내용이 비어 있습니다(추론 모드 — enable_thinking)';
export const LLM_AUTH_PROBLEM = '키가 맞지 않습니다';
const DETAIL_MAX = 200;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallBase {
  /** http(s)://호스트[:포트]/v1 같은 기준 주소(끝 / 없음) */
  url: string;
  key?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** 오류 문장에서 가릴 다른 비밀 */
  secrets?: readonly string[];
}

export interface ChatOptions extends LlmCallBase {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'guard' | 'connect' | 'auth' | 'http' | 'timeout' | 'format' | 'empty' | 'aborted',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return env.VITEST !== undefined || env.WIKI_RADAR_TEST_MODE === '1';
}

/** 시험 가드: 시험 중 루프백 밖 주소면 그 문장 */
export function llmGuardProblem(env: NodeJS.ProcessEnv, url: string): string | null {
  if (!isTestEnv(env)) return null;
  try {
    return isLoopbackHost(new URL(url).hostname) ? null : LLM_TEST_GUARD_PROBLEM;
  } catch {
    return LLM_TEST_GUARD_PROBLEM;
  }
}

function clip(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat;
}

/** 요청 본문(시험이 같은 함수를 본다) — enable_thinking:false 를 언제나 넣는다 */
export function chatRequestBody(o: Pick<ChatOptions, 'model' | 'messages' | 'maxTokens' | 'temperature'>): Record<string, unknown> {
  return {
    model: o.model,
    messages: o.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(o.maxTokens !== undefined ? { max_tokens: o.maxTokens } : {}),
    ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

async function readLimited(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > LLM_RESPONSE_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new LlmError('응답이 너무 큽니다(64KB 넘음)', 'format');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LLM_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LlmError('응답이 너무 큽니다(64KB 넘음)', 'format');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** 한 번 부르기 → { status, text }. 시간 제한·취소·가드·오류 문장(가림) */
async function call(o: LlmCallBase, method: 'GET' | 'POST', subPath: string, body?: unknown): Promise<{ status: number; text: string }> {
  const env = o.env ?? process.env;
  const guard = llmGuardProblem(env, o.url);
  if (guard) throw new LlmError(guard, 'guard');
  const secrets = [...(o.secrets ?? []), ...(o.key ? [o.key] : [])];
  const controller = new AbortController();
  const timeoutMs = o.timeoutMs ?? LLM_TEST_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  o.signal?.addEventListener('abort', onAbort);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.key) headers.Authorization = `Bearer ${o.key}`;
  const fetchImpl: FetchLike = o.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await fetchImpl(`${o.url}${subPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await readLimited(res);
    return { status: res.status, text };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (o.signal?.aborted) throw new LlmError('멈췄습니다', 'aborted');
    if (timedOut) throw new LlmError(`LLM 서버 응답이 ${Math.round(timeoutMs / 1000)}초 안에 오지 않았습니다`, 'timeout');
    const cause = (err as { cause?: { code?: unknown; message?: unknown } })?.cause;
    const code = typeof cause?.code === 'string' ? cause.code : '';
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmError(`LLM 서버에 연결하지 못했습니다${code ? `(${code})` : ''}: ${clip(redactSecrets(msg, secrets))}`, 'connect');
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}

function httpError(status: number, text: string, secrets: readonly string[]): LlmError {
  if (status === 401 || status === 403) return new LlmError(LLM_AUTH_PROBLEM, 'auth', status);
  let said = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === 'string' ? j.error : typeof j.error?.message === 'string' ? j.error.message : typeof j.message === 'string' ? j.message : '';
    if (m) said = m;
  } catch {
    // 본문 그대로
  }
  return new LlmError(`LLM 서버 오류 ${status}: ${clip(redactSecrets(said, secrets))}`, 'http', status);
}

/** GET <url>/models → 모델 id 목록 */
export async function listModels(o: LlmCallBase): Promise<string[]> {
  const secrets = [...(o.secrets ?? []), ...(o.key ? [o.key] : [])];
  const r = await call({ ...o, timeoutMs: o.timeoutMs ?? LLM_MODELS_TIMEOUT_MS }, 'GET', '/models');
  if (r.status < 200 || r.status > 299) throw httpError(r.status, r.text, secrets);
  let j: unknown;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new LlmError('모델 목록 응답이 JSON 이 아닙니다', 'format');
  }
  const data = (j as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new LlmError('모델 목록 응답 형식이 다릅니다(data 없음)', 'format');
  return data.map((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : '')).filter((x) => x !== '');
}

/** POST <url>/chat/completions → choices[0].message.content(문자열이 아니면 LLM_NULL_CONTENT_PROBLEM) */
export async function chatComplete(o: ChatOptions): Promise<{ content: string; ms: number; usage?: Record<string, number> }> {
  const started = Date.now();
  const secrets = [...(o.secrets ?? []), ...(o.key ? [o.key] : [])];
  const r = await call(o, 'POST', '/chat/completions', chatRequestBody(o));
  if (r.status < 200 || r.status > 299) throw httpError(r.status, r.text, secrets);
  let j: unknown;
  try {
    j = JSON.parse(r.text);
  } catch {
    throw new LlmError('응답이 JSON 이 아닙니다', 'format');
  }
  const choice = (j as { choices?: unknown })?.choices;
  const content = Array.isArray(choice) ? (choice[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined;
  if (typeof content !== 'string') throw new LlmError(LLM_NULL_CONTENT_PROBLEM, 'empty');
  const usageRaw = (j as { usage?: unknown })?.usage;
  const usage: Record<string, number> = {};
  if (usageRaw && typeof usageRaw === 'object') {
    for (const [k, v] of Object.entries(usageRaw as Record<string, unknown>)) if (typeof v === 'number') usage[k] = v;
  }
  return { content, ms: Date.now() - started, ...(Object.keys(usage).length ? { usage } : {}) };
}

export const LLM_TEST_PROMPT = '연결 시험입니다. OK 라고만 답하세요.';

/** 연결 시험: 연결 · 인증 · 모델 · 응답. 던지지 않는다 */
export async function testLlm(o: LlmCallBase & { model: string; now?: () => number }): Promise<ConnectionTestResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const steps: ConnectionTestStep[] = [];
  const secrets = [...(o.secrets ?? []), ...(o.key ? [o.key] : [])];
  const done = (): ConnectionTestResult => ({ ok: steps.length > 0 && steps.every((s) => s.ok), steps, ms: Math.max(0, now() - started) });
  const guard = llmGuardProblem(o.env ?? process.env, o.url);
  if (guard) {
    steps.push({ label: '연결', ok: false, detail: guard });
    return done();
  }
  let models: string[];
  try {
    models = await listModels({ ...o, timeoutMs: LLM_MODELS_TIMEOUT_MS });
    steps.push({ label: '연결', ok: true });
    steps.push({ label: '인증', ok: true, detail: o.key ? '키 사용' : '키 없이' });
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError(String(err), 'connect');
    if (e.kind === 'auth') {
      steps.push({ label: '연결', ok: true });
      steps.push({ label: '인증', ok: false, detail: e.message });
    } else steps.push({ label: '연결', ok: false, detail: redactSecrets(e.message, secrets) });
    return done();
  }
  if (models.includes(o.model)) steps.push({ label: '모델', ok: true, detail: o.model });
  else steps.push({ label: '모델', ok: true, warn: true, detail: `목록에 「${o.model}」 가 없습니다 — 서버 목록: ${models.slice(0, 5).join(', ') || '(없음)'}` });
  try {
    const r = await chatComplete({ ...o, messages: [{ role: 'user', content: LLM_TEST_PROMPT }], maxTokens: 16, temperature: 0, timeoutMs: LLM_TEST_TIMEOUT_MS });
    steps.push({ label: '응답', ok: true, detail: `${r.ms}ms · ${clip(r.content).slice(0, 40)}` });
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError(String(err), 'format');
    steps.push({ label: '응답', ok: false, detail: redactSecrets(e.message, secrets) });
  }
  return done();
}
