// 2.13단계 §C-2b POP3 클라이언트 — 가짜 POP3(127.0.0.1)로 성공·로그인 실패·시간 초과·STLS·가드, DELE 를 보내지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POP3_COMMANDS, pop3SecurityPlan, testPop3 } from '../../src/main/mail/pop3';
// @ts-expect-error — 시험용 .mjs(타입 없음)
import { startFakePop3 } from '../fixtures/fake-pop3-server.mjs';

interface FakePop3 {
  port: number;
  commands: string[];
  connections: number;
  close(): Promise<void>;
}

const servers: FakePop3[] = [];
async function fake(opts: Record<string, unknown> = {}): Promise<FakePop3> {
  const s = (await startFakePop3(opts)) as FakePop3;
  servers.push(s);
  return s;
}
afterEach(async () => {
  while (servers.length) await (servers.pop() as FakePop3).close();
});

const USER = 'radar@example.com';
const PASS = 'pop3-secret-1';

describe('testPop3', () => {
  it('성공: 연결 · 보안(이 PC 시험 서버라 평문) · 로그인 · 메일함 3통, QUIT 으로 끝낸다', async () => {
    const s = await fake();
    const r = await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: PASS, env: process.env });
    expect(r.ok).toBe(true);
    expect(r.steps.map((x) => x.label)).toEqual(['연결', '보안', '로그인', '메일함']);
    expect(r.steps[1].detail).toBe('이 PC 시험 서버라 평문');
    expect(r.steps[3].detail).toBe('3통');
    await new Promise((res) => setTimeout(res, 50));
    expect(s.commands).toContain('QUIT');
    expect(s.commands).toContain('PASS ***');
  });

  it('로그인 실패: 서버 -ERR 글을 보이되 비밀번호는 가린다', async () => {
    const s = await fake();
    const wrong = 'wrong-password-zz';
    const r = await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: wrong, env: process.env });
    expect(r.ok).toBe(false);
    const login = r.steps.find((x) => x.label === '로그인');
    expect(login?.ok).toBe(false);
    expect(login?.detail).toMatch(/로그인 실패/);
    expect(JSON.stringify(r)).not.toContain(wrong);
    expect(login?.detail).toContain('●●●');
  });

  it('DELE·RSET 을 보내지 않는다 — 허용 목록에도, 소스의 명령 글자에도 없다', async () => {
    const s = await fake();
    await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: PASS, env: process.env });
    expect(s.commands.some((c) => /^(DELE|RSET)\b/i.test(c))).toBe(false);
    expect((POP3_COMMANDS as readonly string[]).includes('DELE')).toBe(false);
    expect((POP3_COMMANDS as readonly string[]).includes('RSET')).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'mail', 'pop3.ts'), 'utf8');
    expect(src).not.toMatch(/['"`]DELE|['"`]RSET/);
  });

  it('시간 초과: 인사가 오지 않으면 연결 단계 실패', async () => {
    const s = await fake({ mode: 'hang' });
    const r = await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: PASS, env: process.env, replyTimeoutMs: 300, totalMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ label: '연결', ok: false });
    expect(r.steps[0].detail).toMatch(/초 안에/);
  });

  it('STLS: 서버가 알리면 쓴다(TLS 협상이 실패하면 보안 단계 실패)', async () => {
    const s = await fake({ stls: true });
    const r = await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: PASS, env: process.env, replyTimeoutMs: 800, totalMs: 3_000 });
    expect(s.commands).toContain('STLS');
    expect(r.ok).toBe(false);
    expect(r.steps.find((x) => x.label === '보안' || x.label === '연결' || x.label === '응답')?.ok === false || r.steps.some((x) => !x.ok)).toBe(true);
    expect(s.commands.some((c) => c.startsWith('USER'))).toBe(false); // 평문으로 아이디를 보내지 않았다
  });

  it('시험 가드: 시험 중에는 루프백 밖 서버에 연결하지 않는다(연결 전)', async () => {
    const r = await testPop3({ host: 'pop3s.example.com', port: 995, ssl: true, user: USER, pass: PASS, env: { VITEST: 'true' } });
    expect(r.ok).toBe(false);
    expect(r.steps[0].detail).toMatch(/시험 중/);
  });

  it('CR/LF 든 비밀번호는 보내지 않는다', async () => {
    const s = await fake();
    const r = await testPop3({ host: '127.0.0.1', port: s.port, ssl: false, user: USER, pass: 'abc\r\nDELE 1', env: process.env });
    expect(r.ok).toBe(false);
    expect(r.steps.find((x) => x.label === '로그인')?.detail).toMatch(/줄바꿈/);
    expect(s.commands.some((c) => /^DELE/i.test(c))).toBe(false);
  });

  it('보안 계획: SSL · 루프백 평문 · 그 밖은 STLS 필수', () => {
    expect(pop3SecurityPlan('pop.example.com', true)).toBe('ssl');
    expect(pop3SecurityPlan('127.0.0.1', false)).toBe('plain-loopback');
    expect(pop3SecurityPlan('pop.example.com', false)).toBe('stls');
  });
});
