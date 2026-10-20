// 시험용 가짜 로컬 LLM(OpenAI 호환, 127.0.0.1) — 2.13단계 명세 §F-4. 네트워크 밖으로 나가지 않는다. 모델·키는 가짜다.
// - GET /v1/models → { data:[{id}] }
// - POST /v1/chat/completions: chat_template_kwargs.enable_thinking === false 가 **없으면 content: null**(실제 서버의 추론 모드 흉내).
//   키(key)를 주면 Authorization: Bearer <key> 가 아니면 401. 받은 요청(본문 JSON)을 requests 에 남긴다.
// - 답: 마지막 user 메시지가 '연결 시험' 이면 'OK', 아니면 reply(기본: 초안 JSON 한 줄)
import http from 'node:http';

export const FAKE_LLM_MODEL = 'fake-model';
export const FAKE_LLM_DRAFT_BODY = '안녕하세요.\n\n가짜 로컬 LLM 이 쓴 회신 초안입니다.\n\n감사합니다.';

/**
 * @param {{ key?: string, models?: string[], reply?: string, status?: number }} [opts]
 * @returns {Promise<{ port: number, url: string, requests: { path: string, auth?: string, body?: any }[], close: () => Promise<void> }>}
 */
export async function startFakeLlm(opts = {}) {
  const models = opts.models ?? [FAKE_LLM_MODEL];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const auth = req.headers.authorization;
      requests.push({ path: req.url ?? '', ...(auth ? { auth } : {}), ...(body !== undefined ? { body } : {}) });
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (opts.status) return json(opts.status, { error: { message: `forced ${opts.status}` } });
      if (opts.key && auth !== `Bearer ${opts.key}`) return json(401, { error: { message: 'invalid api key' } });
      if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const thinkingOff = body?.chat_template_kwargs?.enable_thinking === false;
        const msgs = Array.isArray(body?.messages) ? body.messages : [];
        const last = msgs.filter((m) => m.role === 'user').pop()?.content ?? '';
        const answer = /연결 시험/.test(last) ? 'OK' : (opts.reply ?? JSON.stringify({ body: FAKE_LLM_DRAFT_BODY, notes: '가짜 확인 사항' }));
        return json(200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: body?.model,
          choices: [{ index: 0, message: { role: 'assistant', content: thinkingOff ? answer : null, reasoning_content: 'thinking…' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
