// 시험용 가짜 POP3 서버(127.0.0.1, 평문) — 2.13단계 명세 §F-4. 네트워크 밖으로 나가지 않는다. 계정·메일은 가짜다.
// - 계정 하나(user·pass), STAT 은 messages 통.
// - 받은 명령을 commands 에 남긴다(PASS 의 값은 '***' 로). DELE·RSET 을 받으면 기록하고 -ERR — 앱이 보내지 않는지 시험이 본다.
// - 틀린 비밀번호의 -ERR 줄에는 받은 비밀번호를 그대로 넣는다(앱이 오류 문장에서 가리는지 시험한다).
// - mode: 'ok' | 'hang'(인사를 보내지 않음 — 시간 초과 시험) · stls: CAPA 에 STLS 를 알리고 STLS 에 +OK(그 뒤 TLS 는 하지 않음)
// - mails: [{uid, raw}] 를 주면 UIDL·RETR 이 그 메일들(2.15 수집 시험). 없으면 messages 통의 간단한 가짜 메일(uid-1…).
//   서버 쪽 목록은 mails 배열을 바꾸면(push) 다음 연결부터 보인다. retrFail: [번호] 는 그 RETR 에 -ERR.
import net from 'node:net';

/**
 * @param {{ user?: string, pass?: string, messages?: number, mode?: 'ok'|'hang', stls?: boolean }} [opts]
 * @returns {Promise<{ port: number, commands: string[], connections: number, close: () => Promise<void> }>}
 */
export async function startFakePop3(opts = {}) {
  const user = opts.user ?? 'radar@example.com';
  const pass = opts.pass ?? 'pop3-secret-1';
  const mails =
    opts.mails ??
    Array.from({ length: opts.messages ?? 3 }, (_, i) => ({
      uid: `uid-${i + 1}`,
      raw: [`From: Fake <fake@example.com>`, 'To: radar@example.com', `Subject: fake ${i + 1}`, `Date: Mon, 21 Sep 2026 09:0${i % 10}:00 +0900`, `Message-ID: <fake-${i + 1}@example.com>`, '', `body ${i + 1}`, ''].join('\r\n'),
    }));
  const retrFail = new Set(opts.retrFail ?? []);
  const commands = [];
  const state = { connections: 0 };
  const sockets = new Set();

  const server = net.createServer((socket) => {
    state.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (opts.mode === 'hang') return;
    let buf = '';
    let givenUser = '';
    let authed = false;
    const send = (line) => socket.write(`${line}\r\n`);
    send('+OK fake POP3 ready');
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        commands.push(cmd === 'PASS' ? 'PASS ***' : line);
        switch (cmd) {
          case 'CAPA':
            send('+OK capability list follows');
            send('USER');
            send('UIDL');
            if (opts.stls) send('STLS');
            send('.');
            break;
          case 'STLS':
            if (opts.stls) send('+OK begin TLS negotiation');
            else send('-ERR STLS not supported');
            break;
          case 'USER':
            givenUser = arg;
            send('+OK');
            break;
          case 'PASS':
            if (givenUser === user && arg === pass) {
              authed = true;
              send('+OK logged in');
            } else send(`-ERR [AUTH] Authentication failed for ${givenUser} with ${arg}`);
            break;
          case 'STAT':
            send(authed ? `+OK ${mails.length} ${mails.length * 1024}` : '-ERR not logged in');
            break;
          case 'RETR': {
            const n = Number(arg);
            const m = mails[n - 1];
            if (!authed || !m) {
              send(authed ? '-ERR no such message' : '-ERR not logged in');
              break;
            }
            if (retrFail.has(n)) {
              send('-ERR temporary failure');
              break;
            }
            const raw = Buffer.isBuffer(m.raw) ? m.raw.toString('latin1') : Buffer.from(m.raw, 'utf8').toString('latin1');
            send('+OK message follows');
            const lines = raw.replace(/\r\n/g, '\n').split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            for (const l of lines) socket.write(Buffer.from(`${l.startsWith('.') ? '.' : ''}${l}\r\n`, 'latin1'));
            send('.');
            break;
          }
          case 'UIDL':
            if (!authed) {
              send('-ERR not logged in');
              break;
            }
            send('+OK');
            mails.forEach((m, i) => send(`${i + 1} ${m.uid}`));
            send('.');
            break;
          case 'DELE':
          case 'RSET':
            send('-ERR this fake server never deletes');
            break;
          case 'QUIT':
            send('+OK bye');
            socket.end();
            break;
          default:
            send('-ERR unknown command');
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port,
    commands,
    mails,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
