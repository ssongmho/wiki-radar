// 2.13단계 §A-3 우선순위: 환경 변수 > 화면 값 > 팀 기본값 > 내장 기본값 > (계정만) .env. 계정은 한 쌍으로, 섞지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SecretKey, TeamDefaultValues } from '../../src/shared/types';
import type { AppSettings } from '../../src/main/appSettings';
import { loadSmtpAccount, readDotEnvAccount, type DotEnvAccount } from '../../src/main/mail/account';
import {
  resolveAi,
  resolveField,
  resolveLlm,
  resolveMailIn,
  resolveMailOut,
  resolvePop3Account,
  resolveSmtpAccount,
  resolveUpdateUrl,
  type ResolveInput,
} from '../../src/main/settings/resolve';

function secrets(values: Partial<Record<SecretKey, string>> = {}) {
  return { has: (k: SecretKey) => values[k] !== undefined, get: (k: SecretKey) => values[k], storage: () => 'file' as const };
}

function input(o: { env?: NodeJS.ProcessEnv; settings?: AppSettings; secrets?: Partial<Record<SecretKey, string>>; team?: TeamDefaultValues; dotenv?: DotEnvAccount } = {}): ResolveInput {
  return {
    env: o.env ?? {},
    settings: o.settings ?? {},
    secrets: secrets(o.secrets),
    team: o.team ?? {},
    dotenv: () => o.dotenv ?? { ok: true },
  };
}

const DOT: DotEnvAccount = { ok: true, user: 'dot@example.com', pass: 'dot-pass-1234' };

describe('resolveField', () => {
  it('환경 변수 > 사람 > 팀 > 내장, 틀린 환경 변수는 잠그고 문제(다른 출처로 넘어가지 않음)', () => {
    const env = (raw: string) => ({ name: 'X', raw, parse: (r: string) => (r === 'bad' ? { problem: '틀림' } : { value: r }) });
    expect(resolveField(env('e'), 'u', 't', 'b')).toMatchObject({ value: 'e', source: 'env', envName: 'X', userValue: 'u', teamValue: 't', builtinValue: 'b' });
    expect(resolveField(env(''), 'u', 't', 'b')).toMatchObject({ value: 'u', source: 'user' });
    expect(resolveField(null, undefined, 't', 'b')).toMatchObject({ value: 't', source: 'team' });
    expect(resolveField(null, undefined, undefined, 'b')).toMatchObject({ value: 'b', source: 'builtin' });
    expect(resolveField(null, undefined, undefined, undefined)).toMatchObject({ value: null, source: 'none' });
    expect(resolveField(env('bad'), 'u', 't', 'b')).toMatchObject({ value: null, source: 'env', problem: 'X: 틀림' });
  });
});

describe('메일 받기(POP3)', () => {
  it('서버·포트·SSL·주기 — 필드마다 출처', () => {
    const r = resolveMailIn(input({ team: { mailIn: { host: 'pop.team.example', port: 1995, intervalMinutes: 15 } }, settings: { mailIn: { port: 2995 } } }));
    expect(r.fields.host).toMatchObject({ value: 'pop.team.example', source: 'team' });
    expect(r.fields.port).toMatchObject({ value: 2995, source: 'user' });
    expect(r.fields.ssl).toMatchObject({ value: true, source: 'builtin' });
    expect(r.fields.intervalMinutes).toMatchObject({ value: 15, source: 'team' });
    expect(r.fields.enabled).toMatchObject({ value: true, source: 'builtin' });
    expect(r.fields.firstDate.source).toBe('none');
  });

  it('SSL 끔이면 내장 포트는 110, 환경 변수가 이긴다', () => {
    expect(resolveMailIn(input({ settings: { mailIn: { ssl: false } } })).fields.port).toMatchObject({ value: 110, source: 'builtin' });
    const r = resolveMailIn(input({ env: { WIKI_RADAR_POP3_HOST: 'env.example', WIKI_RADAR_POP3_PORT: '1110', WIKI_RADAR_POP3_SSL: '0' }, settings: { mailIn: { host: 'user.example' } } }));
    expect(r.fields.host).toMatchObject({ value: 'env.example', source: 'env', envName: 'WIKI_RADAR_POP3_HOST' });
    expect(r.fields.port).toMatchObject({ value: 1110, source: 'env' });
    expect(r.fields.ssl).toMatchObject({ value: false, source: 'env' });
  });

  it('계정 쌍: 환경 변수 둘 다 → 화면(아이디 + 저장된 비밀번호) → .env. 섞지 않는다', () => {
    // 환경 변수 아이디만 → 쌍이 아님 → 화면 쌍
    let r = resolveMailIn(input({ env: { WIKI_RADAR_POP3_USER: 'env-user' }, settings: { mailIn: { user: 'me@example.com' } }, secrets: { 'mailIn.pass': 'user-pass-1' }, dotenv: DOT }));
    expect(r.account).toMatchObject({ source: 'user', user: 'me@example.com', pass: 'user-pass-1' });
    // 화면 아이디는 있는데 비밀번호가 없음 → 화면 아이디 + .env 비밀번호 조합을 만들지 않고 .env 쌍
    r = resolveMailIn(input({ settings: { mailIn: { user: 'me@example.com' } }, dotenv: DOT }));
    expect(r.account).toMatchObject({ source: 'dotenv', user: 'dot@example.com', pass: 'dot-pass-1234' });
    expect(r.fields.user).toMatchObject({ value: 'me@example.com', source: 'user' });
    // 화면과 실제 계정이 다르다는 것을 알린다
    expect(r.fields.user.problem).toMatch(/비밀번호가 저장되지 않아.*dot@example\.com/);
    // 환경 변수 둘 다
    r = resolveMailIn(input({ env: { WIKI_RADAR_POP3_USER: 'env-user', WIKI_RADAR_POP3_PASS: 'env-pass-1' }, settings: { mailIn: { user: 'me' } }, secrets: { 'mailIn.pass': 'x-pass-12' } }));
    expect(r.account).toMatchObject({ source: 'env', user: 'env-user', pass: 'env-pass-1' });
    expect(r.fields.user).toMatchObject({ source: 'env', envName: 'WIKI_RADAR_POP3_USER' });
    expect(r.secret).toMatchObject({ saved: true, source: 'env', envName: 'WIKI_RADAR_POP3_PASS' });
    // 아무것도 없음
    expect(resolveMailIn(input()).account.source).toBe('none');
  });

  it('resolvePop3Account: 서버 없으면 문제, 있으면 계정', () => {
    expect(resolvePop3Account(input({ dotenv: DOT })).ok).toBe(false);
    const r = resolvePop3Account(input({ team: { mailIn: { host: '127.0.0.1', port: 1100, ssl: false } }, dotenv: DOT }));
    expect(r).toEqual({ ok: true, account: { host: '127.0.0.1', port: 1100, ssl: false, user: 'dot@example.com', pass: 'dot-pass-1234' } });
  });
});

describe('메일 보내기(SMTP)', () => {
  it('설정 없음 + .env = 기존 loadSmtpAccount 와 같은 계정(동작 변화 없음)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-resolve-'));
    try {
      fs.mkdirSync(path.join(dir, '_mail-ingest'));
      fs.writeFileSync(path.join(dir, '_mail-ingest', '.env'), 'MAILHOST_MAIL_USER=old@example.com\nMAILHOST_MAIL_PASS="old-pass-999"\n');
      const legacy = loadSmtpAccount({}, dir);
      const now = resolveSmtpAccount({ env: {}, settings: {}, secrets: secrets(), team: {}, dotenv: () => readDotEnvAccount(dir) });
      expect(now).toEqual(legacy);
      expect(now).toMatchObject({ ok: true, account: { host: 'smtps.mailhost.test', port: 465, secure: true, requireTLS: false, user: 'old@example.com' } });
      // 환경 변수 SMTP 도 기존과 같다
      const env = { WIKI_RADAR_SMTP_HOST: '127.0.0.1', WIKI_RADAR_SMTP_PORT: '2525', WIKI_RADAR_SMTP_SECURE: '0', WIKI_RADAR_SMTP_USER: 'a@b.c', WIKI_RADAR_SMTP_PASS: 'pw-123456' };
      expect(resolveSmtpAccount({ env, settings: {}, secrets: secrets(), team: {}, dotenv: () => readDotEnvAccount(dir) })).toEqual(loadSmtpAccount(env, dir));
      // 틀린 환경 변수 문장도 같다
      const bad = { WIKI_RADAR_SMTP_PORT: '99999' };
      expect(resolveSmtpAccount({ env: bad, settings: {}, secrets: secrets(), team: {}, dotenv: () => readDotEnvAccount(dir) })).toEqual(loadSmtpAccount(bad, dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('같은 계정(기본 켬) → 메일 받기 쌍, 끄면 이 칸의 쌍 → .env', () => {
    const base = { settings: { mailIn: { user: 'in@example.com' } }, secrets: { 'mailIn.pass': 'in-pass-12', 'mailOut.pass': 'out-pass-12' } as Partial<Record<SecretKey, string>>, dotenv: DOT };
    expect(resolveMailOut(input(base)).account).toMatchObject({ source: 'user', user: 'in@example.com', pass: 'in-pass-12' });
    const off = input({ ...base, settings: { ...base.settings, mailOut: { sameAccount: false, user: 'out@example.com' } } });
    expect(resolveMailOut(off).account).toMatchObject({ source: 'user', user: 'out@example.com', pass: 'out-pass-12' });
    const offNoPass = input({ settings: { mailOut: { sameAccount: false, user: 'out@example.com' } }, dotenv: DOT });
    expect(resolveMailOut(offNoPass).account).toMatchObject({ source: 'dotenv' });
    // SMTP 환경 변수 쌍이 이긴다(같은 계정이어도)
    const env = input({ ...base, env: { WIKI_RADAR_SMTP_USER: 'e@x.y', WIKI_RADAR_SMTP_PASS: 'env-pass-9' } });
    expect(resolveMailOut(env).account).toMatchObject({ source: 'env', user: 'e@x.y' });
  });

  it('서버·포트·보안: 팀 기본값, 포트가 465 가 아니면 STARTTLS(루프백 아닌 곳은 requireTLS)', () => {
    const r = resolveSmtpAccount(input({ team: { mailOut: { host: 'smtp.team.example', port: 587 } }, dotenv: DOT }));
    expect(r).toMatchObject({ ok: true, account: { host: 'smtp.team.example', port: 587, secure: false, requireTLS: true } });
    const loop = resolveSmtpAccount(input({ settings: { mailOut: { host: '127.0.0.1', port: 2525, security: 'starttls' } }, dotenv: DOT }));
    expect(loop).toMatchObject({ ok: true, account: { host: '127.0.0.1', secure: false, requireTLS: false } });
    expect(resolveMailOut(input()).fields.host).toMatchObject({ value: 'smtps.mailhost.test', source: 'builtin' });
  });

  it('포트·보안은 한 쌍: 포트만 환경 변수면 보안은 포트에서(팀·내 값 ssl 을 섞지 않는다 — 기존 loadSmtpAccount 와 같다)', () => {
    const env = { WIKI_RADAR_SMTP_PORT: '587' };
    for (const o of [{ team: { mailOut: { port: 465, security: 'ssl' as const } } }, { settings: { mailOut: { security: 'ssl' as const } } }]) {
      const r = resolveMailOut(input({ env, ...o, dotenv: DOT }));
      expect(r.fields.port).toMatchObject({ value: 587, source: 'env' });
      expect(r.fields.security).toMatchObject({ value: 'starttls', source: 'builtin' });
      expect(resolveSmtpAccount(input({ env, ...o, dotenv: DOT }))).toMatchObject({ ok: true, account: { port: 587, secure: false, requireTLS: true } });
    }
    // 보안만 내 값이면 포트는 보안에서(팀 465 를 starttls 로 쓰지 않는다)
    const r = resolveMailOut(input({ team: { mailOut: { port: 465, security: 'ssl' } }, settings: { mailOut: { security: 'starttls' } } }));
    expect(r.fields.port).toMatchObject({ value: 587, source: 'builtin' });
    // 같은 출처면 그대로
    expect(resolveMailOut(input({ settings: { mailOut: { port: 2525, security: 'ssl' } } })).fields.security).toMatchObject({ value: 'ssl', source: 'user' });
    // 메일 받기: 팀 995 + SSL 끔 환경 변수 → 포트는 110, 포트 환경 변수 995 + 팀 SSL 끔 → SSL
    expect(resolveMailIn(input({ env: { WIKI_RADAR_POP3_SSL: '0' }, team: { mailIn: { port: 995 } } })).fields.port).toMatchObject({ value: 110 });
    expect(resolveMailIn(input({ env: { WIKI_RADAR_POP3_PORT: '995' }, team: { mailIn: { ssl: false } } })).fields.ssl).toMatchObject({ value: true });
  });

  it('계정이 없으면 설정 화면을 먼저 안내', () => {
    const r = resolveSmtpAccount(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/^메일 계정이 없습니다: 설정 › 메일 보내기/);
  });
});

describe('AI·업데이트', () => {
  it('로컬 LLM: 환경 변수 > 화면(팀 기본값은 보지 않음), 키는 SERVER_LLM_API_KEY > secrets', () => {
    // 팀 파일에 ai 가 남아 있어도(형식상 없어야 하지만) 쓰지 않는다 — AI 는 각자 설정(소유자 결정 2026-10-19)
    const team = { ai: { llmUrl: 'http://10.0.0.5:8000/v1', model: 'team-model' } } as unknown as TeamDefaultValues;
    const r = resolveAi(input({ team, settings: { ai: { model: 'my-model' } }, secrets: { 'ai.llmKey': 'user-key-123' } }));
    expect(r.fields.llmUrl).toMatchObject({ source: 'none' });
    expect(r.fields.llmUrl.teamValue).toBeUndefined();
    expect(r.fields.model).toMatchObject({ value: 'my-model', source: 'user' });
    expect(r.fields.model.teamValue).toBeUndefined();
    expect(r.fields.draftEngine).toMatchObject({ value: 'claude', source: 'builtin' });
    expect(r.key).toEqual({ value: 'user-key-123', source: 'user' });
    const e = resolveAi(input({ env: { SERVER_LLM_API_KEY: 'env-key-123', WIKI_RADAR_LLM_URL: 'http://127.0.0.1:9/v1' }, secrets: { 'ai.llmKey': 'user-key-123' } }));
    expect(e.key).toEqual({ value: 'env-key-123', source: 'env' });
    expect(e.secret).toMatchObject({ saved: true, source: 'env', envName: 'SERVER_LLM_API_KEY' });
    expect(e.fields.llmUrl).toMatchObject({ source: 'env', value: 'http://127.0.0.1:9/v1' });
    expect(resolveLlm(input()).ok).toBe(false);
    expect(resolveLlm(input({ team })).ok).toBe(false);
    expect(resolveLlm(input({ settings: { ai: { llmUrl: 'http://127.0.0.1:9/v1', model: 'm', keyHost: '127.0.0.1:9' } } }))).toEqual({
      ok: true,
      target: { url: 'http://127.0.0.1:9/v1', model: 'm' },
    });
  });

  it('로컬 LLM 은 출처·키 유무와 상관없이 [연결 시험]에 성공한 호스트(ai.keyHost)일 때만 쓴다', () => {
    const mine = { llmUrl: 'http://10.0.0.7:8000/v1', model: 'm' };
    // 내 설정 주소 — 키가 없어도 시험 전엔 쓰지 않는다
    const noKey = resolveLlm(input({ settings: { ai: mine } }));
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.problem).toBe('로컬 LLM(10.0.0.7:8000)을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다');
    expect(resolveLlm(input({ settings: { ai: mine }, secrets: { 'ai.llmKey': 'user-key-123' } })).ok).toBe(false);
    // 환경 변수 주소·키도 시험 전엔 쓰지 않는다
    const env = { WIKI_RADAR_LLM_URL: 'http://127.0.0.1:9/v1', WIKI_RADAR_LLM_MODEL: 'env-model', SERVER_LLM_API_KEY: 'env-key-1' };
    const envBlocked = resolveLlm(input({ env }));
    expect(envBlocked.ok).toBe(false);
    if (!envBlocked.ok) expect(envBlocked.problem).toMatch(/127\.0\.0\.1:9.*연결 시험/);
    // [연결 시험] 자체는 시험 전 호스트에도 보낸다
    expect(resolveLlm(input({ settings: { ai: mine } }), { testing: true }).ok).toBe(true);
    // 시험 성공 뒤엔 쓴다(키가 있으면 키도)
    expect(resolveLlm(input({ settings: { ai: { ...mine, keyHost: '10.0.0.7:8000' } } }))).toEqual({ ok: true, target: { url: mine.llmUrl, model: 'm' } });
    expect(resolveLlm(input({ settings: { ai: { ...mine, keyHost: '10.0.0.7:8000' } }, secrets: { 'ai.llmKey': 'user-key-123' } }))).toMatchObject({
      ok: true,
      target: { key: 'user-key-123' },
    });
    expect(resolveLlm(input({ env, settings: { ai: { keyHost: '127.0.0.1:9' } } }))).toEqual({
      ok: true,
      target: { url: 'http://127.0.0.1:9/v1', model: 'env-model', key: 'env-key-1' },
    });
    // 주소를 다른 호스트(포트 포함)로 바꾸면 다시 시험해야 한다 — 같은 호스트의 다른 경로는 그대로
    expect(resolveLlm(input({ settings: { ai: { ...mine, llmUrl: 'http://10.9.9.9:8000/v1', keyHost: '10.0.0.7:8000' } } })).ok).toBe(false);
    expect(resolveLlm(input({ settings: { ai: { ...mine, llmUrl: 'http://10.0.0.7:8001/v1', keyHost: '10.0.0.7:8000' } } })).ok).toBe(false);
    expect(resolveLlm(input({ settings: { ai: { ...mine, llmUrl: 'http://10.0.0.7:8000/v2', keyHost: '10.0.0.7:8000' } } })).ok).toBe(true);
  });

  it('업데이트 서버: 환경 변수 > 화면 > 팀 > 내장', () => {
    expect(resolveUpdateUrl({}, {}, {}, 'http://builtin/')).toMatchObject({ value: 'http://builtin/', source: 'builtin' });
    expect(resolveUpdateUrl({}, {}, { update: { url: 'http://team/' } }, 'http://builtin/')).toMatchObject({ value: 'http://team/', source: 'team' });
    expect(resolveUpdateUrl({}, { update: { url: 'off' } }, { update: { url: 'http://team/' } }, 'http://b/')).toMatchObject({ value: 'off', source: 'user' });
    expect(resolveUpdateUrl({ WIKI_RADAR_UPDATE_URL: 'off' }, { update: { url: 'http://u/' } }, {}, 'http://b/')).toMatchObject({ value: 'off', source: 'env' });
  });
});

