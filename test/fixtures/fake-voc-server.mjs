// 시험용 가짜 VOC 백엔드(HTTP, 127.0.0.1) — 앱이 VOC API 를 직접 부르는 경로(src/main/voc/api.ts, 명세 §15)를 시험한다.
// 자료·업무 규칙은 가짜 voc-cli(fake-voc-cli.mjs)를 그대로 쓴다: 요청을 voc-cli 인자로 바꿔 불러 그 --json 출력을 응답으로 돌려준다.
// 그래서 voc-cli 경로와 API 경로가 같은 자료·같은 규칙(담당자 없으면 해결 400, 작업시간, 첨부, fail-write 등)으로 답한다.
// 인증은 이 서버가 한다: POST /auth/login(비밀번호 password) → 토큰, 그 밖은 Bearer 필요, POST /auth/refresh 로 갱신(토큰을 바꾼다).
// 네트워크 밖으로 나가지 않는다. 사람·주소는 가짜다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-voc-cli.mjs');

/**
 * @param {{ state: string, now?: string, mode?: 'ok'|'fail-write', password?: string }} opts
 *   state 가짜 voc-cli 의 상태 폴더(FAKE_VOC_STATE), mode 가짜 voc-cli 모드
 */
export async function startFakeVocServer(opts) {
  const password = opts.password ?? 'secret';
  const requests = [];
  let accessTokens = new Set();
  let refreshTokens = new Set();
  let seq = 0;
  /** 모든 요청에 이 상태로 답한다(서버 오류·끊김 흉내). null 이면 평소대로 */
  let forcedStatus = null;

  const issue = () => {
    seq += 1;
    const access = `access-${seq}`;
    const refresh = `refresh-${seq}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    return { accessToken: access, refreshToken: refresh };
  };

  const runCli = (args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [FAKE_CLI, ...args],
        {
          env: { ...process.env, FAKE_VOC_STATE: opts.state, FAKE_VOC_MODE: opts.mode ?? 'ok', FAKE_VOC_NOW: opts.now ?? '2026-09-23T01:00:00Z' },
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        },
        (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }),
      );
    });

  /** 가짜 voc-cli 실패 → HTTP 상태·본문 */
  const cliError = (r) => {
    const line = (r.stderr.split(/\r?\n/).find((l) => l.startsWith('오류:')) ?? `오류: 가짜 voc-cli 종료 코드 ${r.code}`).slice(4).trim();
    const m = /^(\d{3})\s*—\s*(.*)$/.exec(line);
    return m ? { status: Number(m[1]), body: { message: m[2] } } : { status: 400, body: { message: line } };
  };

  const json = async (args) => {
    const r = await runCli(args);
    if (r.code !== 0) return cliError(r);
    return { status: 200, body: JSON.parse(r.stdout) };
  };

  const text = async (args) => {
    const r = await runCli(args);
    if (r.code !== 0) return cliError(r);
    return { status: 200, text: r.stdout };
  };

  /** 쓰기 뒤 티켓을 다시 읽어 TicketDto 로 */
  const ticketAfter = async (id, write) => {
    const r = await write;
    if (r.status !== 200) return r;
    return json(['ticket', 'get', String(id), '--json']);
  };

  async function route(method, url, body) {
    const p = url.pathname.replace(/^\/api\/v2/, '');
    const q = url.searchParams;
    let m;
    if (method === 'GET' && p === '/tickets') {
      const args = ['ticket', 'list'];
      if (q.get('showCompleted') === 'false') args.push('--hide-completed');
      args.push('--page', q.get('page') ?? '1', '--size', q.get('size') ?? '20', '--json');
      return json(args);
    }
    if ((m = /^\/tickets\/(\d+)$/.exec(p))) {
      const id = m[1];
      if (method === 'GET') return json(['ticket', 'get', id, '--json']);
      if (method === 'PUT') {
        const keys = Object.keys(body);
        if (keys.length === 1 && keys[0] === 'status' && ['resolved', 'closed', 'assigned'].includes(body.status)) {
          const cmd = body.status === 'resolved' ? 'resolve' : body.status === 'closed' ? 'close' : 'reopen';
          return ticketAfter(id, text(['ticket', cmd, id]));
        }
        const args = ['ticket', 'update', id];
        if (body.status !== undefined) args.push('-s', body.status);
        if (body.priority !== undefined) args.push('-p', body.priority);
        if (body.internalAssigneeId !== undefined) args.push('--assignee', String(body.internalAssigneeId));
        if (body.ictDueDate !== undefined) args.push('--ict-due', String(body.ictDueDate).slice(0, 10));
        if (body.clearIctDueDate === true) args.push('--clear-ict-due');
        args.push('--json');
        return json(args);
      }
    }
    if ((m = /^\/tickets\/(\d+)\/replies$/.exec(p))) {
      const id = m[1];
      if (method === 'GET') {
        const r = await json(['ticket', 'get', id, '--replies', '--json']);
        return r.status === 200 ? { status: 200, body: r.body.replies ?? [] } : r;
      }
      if (method === 'POST') {
        const r = await text(['ticket', 'reply', id, `--content=${body.content ?? ''}`]);
        if (r.status !== 200) return r;
        const rid = /답변 id=(\d+)/.exec(r.text);
        return { status: 201, body: { id: rid ? Number(rid[1]) : null, content: body.content } };
      }
    }
    if (method === 'POST' && p === '/tickets') {
      const args = ['ticket', 'create', `--title=${body.title ?? ''}`];
      if (body.description !== undefined) args.push(`--desc=${body.description}`);
      if (body.customerId !== undefined) args.push('--customer-id', String(body.customerId));
      if (body.system !== undefined) args.push('--system', body.system);
      if (body.requestType !== undefined) args.push('--type', body.requestType);
      if (body.priority !== undefined) args.push('-p', body.priority);
      if (body.internalAssigneeId !== undefined) args.push('--assignee', String(body.internalAssigneeId));
      if (body.source !== undefined) args.push('--source', body.source);
      args.push('--json');
      return json(args);
    }
    if (method === 'GET' && (m = /^\/tickets\/(\d+)\/email-logs$/.exec(p))) return json(['ticket', 'email-logs', m[1], '--json']);
    if (method === 'POST' && (m = /^\/tickets\/(\d+)\/email$/.exec(p))) {
      const args = ['ticket', 'email', m[1], `--to=${(body.toAddresses ?? []).join(',')}`];
      if ((body.ccAddresses ?? []).length > 0) args.push(`--cc=${body.ccAddresses.join(',')}`);
      if (body.changeStatus === true) args.push('--resolve');
      if (Array.isArray(body.replyIds) && body.replyIds.length > 0) args.push(`--reply-id=${body.replyIds.join(',')}`);
      args.push('--json');
      const r = await json(args);
      return r.status === 200 ? { status: 200, body: {} } : r;
    }
    if (method === 'GET' && p === '/work-logs') return json(['worklog', 'list', q.get('entityId') ?? '', '--json']);
    if (method === 'POST' && p === '/work-logs') {
      const args = ['worklog', 'add', String(body.entityId), `--hours=${body.hours}`, `--date=${body.workDate}`];
      if (body.note) args.push(`--note=${body.note}`);
      args.push('--json');
      return json(args);
    }
    if (method === 'POST' && (m = /^\/work-logs\/(\d+)\/delete$/.exec(p))) {
      const r = await text(['worklog', 'delete', m[1], '-y']);
      return r.status === 200 ? { status: 204 } : r;
    }
    if (method === 'GET' && p === '/users') return json(['user', 'list', ...(q.get('role') ? ['--role', q.get('role')] : []), '--json']);
    if (method === 'GET' && p === '/admin/codes') return json(['code', 'list', q.get('groupCode') ?? '', '--json']);
    if (method === 'GET' && p === '/admin/customers') return json(['customer', 'list', '--json']);
    if (method === 'GET' && p === '/auth/me') {
      const r = await text(['whoami']);
      if (r.status !== 200) return r;
      const keys = { '로그인 ID': 'loginId', 이름: 'name', 이메일: 'email', '권한(role)': 'role', 부서: 'department' };
      const me = {};
      for (const line of r.text.split(/\r?\n/)) {
        const lm = /^\s*([^:]+?)\s*:\s?(.*)$/.exec(line);
        if (lm && keys[lm[1]] && lm[2] !== '-') me[keys[lm[1]]] = lm[2];
      }
      return { status: 200, body: me };
    }
    if (method === 'GET' && (m = /^\/files\/(\d+)\/download$/.exec(p))) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-voc-dl-'));
      try {
        const r = await json(['file', 'download', m[1], `--out=${dir}${path.sep}`, '--json']);
        if (r.status !== 200) return r;
        return {
          status: 200,
          bytes: fs.readFileSync(r.body.path),
          headers: {
            'Content-Type': r.body.contentType ?? 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.body.filename)}`,
          },
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return { status: 404, body: { message: `가짜 서버에 없는 경로: ${method} ${p}` } };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const auth = req.headers.authorization ?? '';
      requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: url.pathname.endsWith('/auth/login') ? { ...body, password: body.password ? '***' : body.password } : body,
        auth,
        client: req.headers['x-client'],
        contentType: req.headers['content-type'],
      });
      const send = (r) => {
        if (r.bytes) {
          res.writeHead(r.status, r.headers);
          res.end(r.bytes);
          return;
        }
        if (r.status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.body ?? {}));
      };
      try {
        if (forcedStatus !== null) return send({ status: forcedStatus, body: { message: '가짜 서버 오류' } });
        const p = url.pathname;
        if (req.method === 'POST' && p === '/api/v2/auth/login') {
          if (body.password !== password) return send({ status: 401, body: { message: '아이디 또는 비밀번호가 올바르지 않습니다' } });
          return send({ status: 200, body: { ...issue(), user: { loginId: body.loginId, name: '홍길동', role: 'staff' } } });
        }
        if (req.method === 'POST' && p === '/api/v2/auth/refresh') {
          if (!refreshTokens.has(body.refreshToken)) return send({ status: 401, body: { message: 'refresh 토큰이 유효하지 않습니다' } });
          refreshTokens.delete(body.refreshToken);
          return send({ status: 200, body: issue() });
        }
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!accessTokens.has(token)) return send({ status: 401, body: { message: '인증이 필요합니다' } });
        send(await route(req.method, url, body));
      } catch (err) {
        send({ status: 500, body: { message: String(err?.message ?? err) } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** 지금 발급된 access 토큰을 모두 무효로(만료 흉내) — refresh 는 그대로 */
    expireAccess() {
      accessTokens = new Set();
    },
    /** refresh 토큰까지 모두 무효로(주말 지나 세션 만료 흉내) */
    expireAll() {
      accessTokens = new Set();
      refreshTokens = new Set();
    },
    /** 모든 요청에 이 상태로 답한다(null 이면 해제) */
    forceStatus(status) {
      forcedStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
