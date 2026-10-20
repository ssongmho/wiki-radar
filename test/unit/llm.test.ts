// 2.13단계 §C-4 로컬 LLM 클라이언트 — 가짜 fetch·가짜 서버(127.0.0.1)만. enable_thinking:false 가 늘 들어가는지, null content, 401, 시간 초과, 가드, 키 없으면 Authorization 없음.
import { afterEach, describe, expect, it } from 'vitest';
import { LLM_AUTH_PROBLEM, LLM_NULL_CONTENT_PROBLEM, chatComplete, chatRequestBody, listModels, testLlm, type FetchLike } from '../../src/main/ai/llm';
// @ts-expect-error — 시험용 .mjs(타입 없음)
import { FAKE_LLM_MODEL, startFakeLlm } from '../fixtures/fake-llm-server.mjs';

interface FakeLlm {
  url: string;
  requests: { path: string; auth?: string; body?: Record<string, unknown> }[];
  close(): Promise<void>;
}
const servers: FakeLlm[] = [];
async function fake(opts: Record<string, unknown> = {}): Promise<FakeLlm> {
  const s = (await startFakeLlm(opts)) as FakeLlm;
  servers.push(s);
  return s;
}
afterEach(async () => {
  while (servers.length) await (servers.pop() as FakeLlm).close();
});

type Call = { url: string; headers: Record<string, string>; body?: string };
function recordingFetch(respond: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const URL0 = 'http://127.0.0.1:9/v1';

describe('chatComplete', () => {
  it('요청 본문에 언제나 chat_template_kwargs.enable_thinking === false', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ok('안녕'));
    const r = await chatComplete({ url: URL0, model: 'm', messages: [{ role: 'user', content: 'x' }], fetchImpl });
    expect(r.content).toBe('안녕');
    const body = JSON.parse(calls[0].body as string);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.stream).toBe(false);
    expect(calls[0].url).toBe(`${URL0}/chat/completions`);
    expect(chatRequestBody({ model: 'm', messages: [] }).chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('키가 없으면 Authorization 머리말 없이, 있으면 Bearer', async () => {
    const a = recordingFetch(() => ok('x'));
    await chatComplete({ url: URL0, model: 'm', messages: [], fetchImpl: a.fetchImpl });
    expect(a.calls[0].headers.Authorization).toBeUndefined();
    const b = recordingFetch(() => ok('x'));
    await chatComplete({ url: URL0, model: 'm', messages: [], key: 'key-123456', fetchImpl: b.fetchImpl });
    expect(b.calls[0].headers.Authorization).toBe('Bearer key-123456');
  });

  it('content 가 null 이면 추론 모드 문장', async () => {
    const { fetchImpl } = recordingFetch(() => ok(null));
    await expect(chatComplete({ url: URL0, model: 'm', messages: [], fetchImpl })).rejects.toThrow(LLM_NULL_CONTENT_PROBLEM);
  });

  it('401 → 키가 맞지 않습니다, 오류 본문의 키는 가린다', async () => {
    const key = 'leaky-key-999';
    const a = recordingFetch(() => new Response('{}', { status: 401 }));
    await expect(chatComplete({ url: URL0, model: 'm', messages: [], key, fetchImpl: a.fetchImpl })).rejects.toThrow(LLM_AUTH_PROBLEM);
    const b = recordingFetch(() => new Response(JSON.stringify({ error: { message: `bad key ${key}` } }), { status: 500 }));
    const err = await chatComplete({ url: URL0, model: 'm', messages: [], key, fetchImpl: b.fetchImpl }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(key);
    expect(String((err as Error).message)).toContain('●●●');
  });

  it('시간 초과', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    await expect(chatComplete({ url: URL0, model: 'm', messages: [], fetchImpl, timeoutMs: 50 })).rejects.toThrow(/초 안에/);
  });

  it('시험 가드: 루프백 밖 주소는 부르기 전에 막는다', async () => {
    const { fetchImpl, calls } = recordingFetch(() => ok('x'));
    await expect(chatComplete({ url: 'http://10.0.0.5:8000/v1', model: 'm', messages: [], fetchImpl, env: { VITEST: 'true' } })).rejects.toThrow(/시험 중/);
    expect(calls).toEqual([]);
  });
});

describe('가짜 서버와 testLlm', () => {
  it('연결·인증·모델·응답 ok, 서버가 받은 요청에 enable_thinking:false', async () => {
    const s = await fake({ key: 'k-123456' });
    const r = await testLlm({ url: s.url, model: FAKE_LLM_MODEL, key: 'k-123456' });
    expect(r.ok).toBe(true);
    expect(r.steps.map((x) => x.label)).toEqual(['연결', '인증', '모델', '응답']);
    const chat = s.requests.find((q) => q.path === '/v1/chat/completions');
    expect((chat?.body as { chat_template_kwargs?: unknown }).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(await listModels({ url: s.url, key: 'k-123456' })).toEqual([FAKE_LLM_MODEL]);
  });

  it('틀린 키 → 인증 실패 "키가 맞지 않습니다", 모델이 목록에 없으면 경고(실패 아님)', async () => {
    const s = await fake({ key: 'right-key-1' });
    const bad = await testLlm({ url: s.url, model: FAKE_LLM_MODEL, key: 'wrong-key-1' });
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((x) => x.label === '인증')).toMatchObject({ ok: false, detail: LLM_AUTH_PROBLEM });
    const warn = await testLlm({ url: s.url, model: 'other-model', key: 'right-key-1' });
    expect(warn.ok).toBe(true);
    expect(warn.steps.find((x) => x.label === '모델')).toMatchObject({ ok: true, warn: true });
  });
});
