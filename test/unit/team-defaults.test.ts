// 2.13단계 §B 팀 기본값: 읽는 순서(env 파일 → 사본 → 원본 → 캐시 → 없음), 비밀 키 전체 거부, version, 64KB, 필드별 버림,
// LLM 주소 사설망만, 캐시 쓰기(같으면 안 씀), 시험 모드에서 UNC·기본 NAS 안 읽음.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEAM_SECRET_PROBLEM,
  TEAM_VERSION_PROBLEM,
  TeamDefaultsHolder,
  parseTeamDefaults,
  readTeamDefaults,
  type TeamDefaultsReadOptions,
  teamServerProblem,
} from '../../src/main/settings/teamDefaults';
import { DEFAULT_SMTP_HOST } from '../../src/main/mail/account';
import { VOC_DEFAULT_API_URL } from '../../src/main/voc/api';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-team-defaults-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function writeTeam(root: string, body: unknown): string {
  const f = path.join(root, '.radar', 'team-settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
}

const GOOD = {
  version: 1,
  mailIn: { host: '10.0.0.7', port: 995, ssl: true, intervalMinutes: 10 },
  mailOut: { host: '10.0.0.8', port: 465, security: 'ssl' },
  voc: { apiUrl: 'https://10.0.0.9:11300' },
  update: { url: 'off' },
};

function opts(o: Partial<TeamDefaultsReadOptions> & { root: string }): TeamDefaultsReadOptions {
  return {
    env: {},
    teamSync: { enabled: false, remote: path.join(o.root, 'nas'), local: path.join(o.root, 'local'), configured: true },
    defaultRemote: '\\\\192.0.2.1\\share\\WIKI',
    cacheFile: path.join(o.root, 'data', 'team-defaults-cache.json'),
    now: () => new Date(2026, 9, 19, 9, 12, 0),
    testMode: false,
    timeoutMs: 2_000,
    ...o,
  };
}

describe('parseTeamDefaults', () => {
  it('좋은 파일은 값으로', () => {
    const r = parseTeamDefaults(GOOD);
    expect(r.problems).toEqual([]);
    expect(r.values.mailIn).toEqual({ host: '10.0.0.7', port: 995, ssl: true, intervalMinutes: 10 });
    expect('ai' in r.values).toBe(false);
    expect(r.values.voc?.apiUrl).toBe('https://10.0.0.9:11300');
  });

  it('version 이 1 이 아니면 전체 버림', () => {
    expect(parseTeamDefaults({ ...GOOD, version: 2 })).toEqual({ values: {}, problems: [TEAM_VERSION_PROBLEM] });
  });

  it('어느 깊이든 비밀 키가 있으면 파일 전체를 쓰지 않는다', () => {
    for (const key of ['pass', 'Password', 'KEY', 'apiKey', 'token', 'secret']) {
      expect(parseTeamDefaults({ ...GOOD, mailIn: { ...GOOD.mailIn, nested: { [key]: 'x' } } })).toEqual({ values: {}, problems: [TEAM_SECRET_PROBLEM] });
    }
  });

  it('틀린 필드만 버리고 문제에 남긴다, 모르는 키는 무시', () => {
    const r = parseTeamDefaults({ version: 1, unknown: 1, mailIn: { host: 'bad host!', port: 70000, ssl: true }, mailOut: { security: 'tls' } });
    expect(r.values).toEqual({ mailIn: { ssl: true } });
    expect(r.problems.length).toBe(3);
  });

  it('ai(로컬 LLM)는 주소가 어디든 통째로 버리고 문제에 남긴다 — AI 는 각자 설정·연결 시험(소유자 결정 2026-10-19)', () => {
    for (const llmUrl of ['http://192.168.1.2:8000/v1', 'http://127.0.0.1:9/v1', 'https://llm.example.com/v1']) {
      const r = parseTeamDefaults({ version: 1, ai: { llmUrl, model: 'm' }, update: { url: 'off' } });
      expect(r.values).toEqual({ update: { url: 'off' } });
      expect(r.problems).toEqual(['팀 설정 ai 를 버림: AI 는 팀 기본값으로 정하지 않습니다 — 각자 설정 › AI 에서 넣고 [연결 시험]을 누르세요']);
    }
    // 비밀 키 검사는 ai 칸에도 그대로(파일 전체를 쓰지 않음)
    expect(parseTeamDefaults({ ...GOOD, ai: { apiKey: 'x' } })).toEqual({ values: {}, problems: [TEAM_SECRET_PROBLEM] });
  });
});

describe('parseTeamDefaults: 비밀이 가는 서버(검토 — 팀 파일로 비밀번호·설치 파일을 돌리지 못하게)', () => {
  it('메일 서버는 내장 메일 서버와 같은 도메인이나 사설망·루프백 IP 만', () => {
    const base = DEFAULT_SMTP_HOST.split('.').slice(-2).join('.');
    const r = parseTeamDefaults({ version: 1, mailIn: { host: 'pop3.attacker.example' }, mailOut: { host: 'smtp.attacker.example', port: 465 } });
    expect(r.values.mailIn).toBeUndefined();
    expect(r.values.mailOut).toEqual({ port: 465 });
    expect(r.problems.join(' ')).toMatch(/mailIn\.host.*mailOut\.host/);
    const ok = parseTeamDefaults({ version: 1, mailIn: { host: `pop3s.${base}` }, mailOut: { host: '192.168.0.9' } });
    expect(ok.values).toEqual({ mailIn: { host: `pop3s.${base}` }, mailOut: { host: '192.168.0.9' } });
    expect(teamServerProblem(`evil${base}`, DEFAULT_SMTP_HOST)).not.toBeNull();
  });

  it('VOC 주소는 내장 VOC 도메인이나 사설망 IP 만', () => {
    expect(parseTeamDefaults({ version: 1, voc: { apiUrl: 'https://voc.attacker.example' } }).values.voc).toBeUndefined();
    const host = new URL(VOC_DEFAULT_API_URL).hostname;
    expect(parseTeamDefaults({ version: 1, voc: { apiUrl: `https://${host}:443` } }).values.voc?.apiUrl).toBeDefined();
  });

  it("업데이트 서버는 끄기('off')만 — 다른 주소는 버림", () => {
    expect(parseTeamDefaults({ version: 1, update: { url: 'http://10.1.2.3:8080/' } }).values.update).toBeUndefined();
    expect(parseTeamDefaults({ version: 1, update: { url: 'off' } }).values.update).toEqual({ url: 'off' });
  });
});

describe('readTeamDefaults', () => {
  it('캐시로 넘어갈 때: NAS 가 안 보이면 문제 없음, 보이는데 파일이 깨졌거나 없으면 파일 문제', async () => {
    const root = tempDir();
    const nas = path.join(root, 'nas');
    const file = writeTeam(nas, { version: 1, mailIn: { host: '10.0.1.2' } });
    const o = opts({ root, teamSync: { enabled: false, remote: nas, local: path.join(root, 'local'), configured: true } });
    expect((await readTeamDefaults(o)).source).toBe('remote');
    fs.writeFileSync(file, 'not json');
    let r = await readTeamDefaults(o);
    expect(r).toMatchObject({ source: 'cache', problems: ['팀 설정 파일이 JSON 이 아닙니다'] });
    fs.writeFileSync(file, JSON.stringify({ version: 2 }));
    r = await readTeamDefaults(o);
    expect(r).toMatchObject({ source: 'cache', problems: [TEAM_VERSION_PROBLEM] });
    fs.rmSync(file);
    r = await readTeamDefaults(o);
    expect(r.source).toBe('cache');
    expect(r.problems[0]).toMatch(/팀 설정 파일이 없습니다/);
    fs.rmSync(nas, { recursive: true });
    r = await readTeamDefaults(o);
    expect(r).toMatchObject({ source: 'cache', problems: [] });
  });

  it('읽는 순서: 환경 변수 파일 → 사본 → 원본 → 캐시 → 없음', async () => {
    const root = tempDir();
    const local = path.join(root, 'local');
    const nas = path.join(root, 'nas');
    writeTeam(local, { version: 1, mailIn: { host: '10.0.1.1' } });
    writeTeam(nas, { version: 1, mailIn: { host: '10.0.1.2' } });
    const envFile = path.join(root, 'env-team.json');
    fs.writeFileSync(envFile, JSON.stringify({ version: 1, mailIn: { host: '10.0.1.3' } }));

    let r = await readTeamDefaults(opts({ root, env: { WIKI_RADAR_TEAM_SETTINGS: envFile }, teamSync: { enabled: true, remote: nas, local, configured: true } }));
    expect(r).toMatchObject({ source: 'env', values: { mailIn: { host: '10.0.1.3' } } });
    r = await readTeamDefaults(opts({ root, teamSync: { enabled: true, remote: nas, local, configured: true } }));
    expect(r).toMatchObject({ source: 'local', values: { mailIn: { host: '10.0.1.1' } }, readAt: '2026-10-19T09:12:00' });
    expect(r.fileMtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    r = await readTeamDefaults(opts({ root, teamSync: { enabled: false, remote: nas, local, configured: true } }));
    expect(r).toMatchObject({ source: 'remote', values: { mailIn: { host: '10.0.1.2' } } });
    // 원본이 사라지면 캐시(마지막으로 읽은 값)
    fs.rmSync(nas, { recursive: true });
    r = await readTeamDefaults(opts({ root, teamSync: { enabled: false, remote: nas, local, configured: true } }));
    expect(r).toMatchObject({ source: 'cache', values: { mailIn: { host: '10.0.1.2' } } });
    // 캐시도 없으면 없음
    fs.rmSync(path.join(root, 'data'), { recursive: true });
    r = await readTeamDefaults(opts({ root, teamSync: { enabled: false, remote: nas, local, configured: true } }));
    expect(r).toMatchObject({ source: 'none', values: {} });
  });

  it('환경 변수 파일이 있으면 그것만 — 비밀이 들면 값 없음 + 문제', async () => {
    const root = tempDir();
    const envFile = path.join(root, 't.json');
    fs.writeFileSync(envFile, JSON.stringify({ version: 1, mailIn: { host: 'x.example', password: 'nope' } }));
    writeTeam(path.join(root, 'nas'), GOOD);
    const r = await readTeamDefaults(opts({ root, env: { WIKI_RADAR_TEAM_SETTINGS: envFile } }));
    expect(r.source).toBe('none');
    expect(r.values).toEqual({});
    expect(r.problems).toContain(TEAM_SECRET_PROBLEM);
  });

  it('64KB 넘는 파일은 쓰지 않는다', async () => {
    const root = tempDir();
    writeTeam(path.join(root, 'nas'), JSON.stringify({ version: 1, pad: 'x'.repeat(70 * 1024) }));
    const r = await readTeamDefaults(opts({ root }));
    expect(r.source).toBe('none');
    expect(r.problems.join(' ')).toMatch(/64KB/);
  });

  it('캐시는 값이 같으면 다시 쓰지 않는다', async () => {
    const root = tempDir();
    writeTeam(path.join(root, 'nas'), GOOD);
    const o = opts({ root });
    await readTeamDefaults(o);
    const cache = o.cacheFile;
    const first = fs.statSync(cache).mtimeMs;
    const content = fs.readFileSync(cache, 'utf8');
    await new Promise((r) => setTimeout(r, 30));
    await readTeamDefaults({ ...o, now: () => new Date(2026, 9, 19, 10, 0, 0) });
    expect(fs.statSync(cache).mtimeMs).toBe(first);
    expect(fs.readFileSync(cache, 'utf8')).toBe(content);
  });

  it('시험 모드: 기본 NAS·UNC 는 읽지 않는다(설정이 임시 폴더를 가리킬 때만)', async () => {
    const root = tempDir();
    writeTeam(path.join(root, 'nas'), GOOD);
    // 설정이 없으면(기본 NAS) 읽지 않는다
    let r = await readTeamDefaults(opts({ root, testMode: true, teamSync: { enabled: false, remote: path.join(root, 'nas'), local: path.join(root, 'l'), configured: false }, defaultRemote: path.join(root, 'nas') }));
    expect(r.source).toBe('none');
    // UNC 는 읽지 않는다
    r = await readTeamDefaults(opts({ root, testMode: true, teamSync: { enabled: false, remote: '\\\\192.0.2.9\\share', local: path.join(root, 'l'), configured: true } }));
    expect(r.source).toBe('none');
    // 임시 폴더를 가리키는 설정이면 읽는다
    r = await readTeamDefaults(opts({ root, testMode: true }));
    expect(r.source).toBe('remote');
  });
});

describe('TeamDefaultsHolder', () => {
  it('처음에는 캐시, refresh 뒤 새 값 + onChange, 30초 안의 다시 부름은 기억한 것', async () => {
    const root = tempDir();
    writeTeam(path.join(root, 'nas'), GOOD);
    await readTeamDefaults(opts({ root })); // 캐시 만들기
    let clock = 1_000_000;
    const changes: string[] = [];
    const h = new TeamDefaultsHolder(() => opts({ root }), (v) => changes.push(v.source), () => clock);
    expect(h.current().source).toBe('cache');
    expect(h.values().mailIn?.host).toBe('10.0.0.7');
    await h.refresh();
    expect(h.current().source).toBe('remote');
    expect(changes).toEqual(['remote']);
    writeTeam(path.join(root, 'nas'), { version: 1, mailIn: { host: '10.0.1.4' } });
    clock += 10_000;
    await h.refresh();
    expect(h.values().mailIn?.host).toBe('10.0.0.7');
    clock += 30_000;
    await h.refresh();
    expect(h.values().mailIn?.host).toBe('10.0.1.4');
    await h.refresh(true);
    expect(changes.length).toBe(2);
  });
});
