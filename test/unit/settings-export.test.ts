// 2.13단계 §C-6b 내보내기·가져오기 — 비밀·loginId·myId·wikiRoot·teamSync.local 없음, 가져오기 검사·비밀 키 버림.
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../src/main/appSettings';
import { buildSettingsExport, countChanges, exportFileName, parseSettingsImport } from '../../src/main/settings/export';
import { ImportTokens, buildDiagnostics, maskId } from '../../src/main/settings/info';

const APP: AppSettings = {
  wikiRoot: 'C:\\Wiki',
  wikiNone: true,
  setupSeen: true,
  teamSync: { enabled: true, remote: '\\\\nas\\share\\WIKI', local: 'C:\\Users\\me\\dc-wiki' },
  me: { name: '홍길동', aliases: [] },
  mailIn: { host: 'pop.example.com', user: 'me@example.com', intervalMinutes: 15 },
  ai: { llmUrl: 'http://10.0.0.5:8000/v1', model: 'm', draftEngine: 'local' },
  update: { url: 'off' },
};

describe('buildSettingsExport', () => {
  it('비밀·VOC 로그인·PC 경로를 빼고 사람이 정한 값만', () => {
    const out = buildSettingsExport({
      app: APP,
      mail: { fromName: '홍길동', signature: '서명', bccSelf: true },
      voc: { memberIds: [1], systems: ['A'], showAllUnassigned: false, pollMinutes: 10, myId: 7, loginId: 'hong', jarPath: 'C:\\voc.jar', apiUrl: 'https://voc.example.com:11300' },
      appVersion: '1.4.0',
      exportedAt: '2026-10-20T09:00:00',
    });
    const text = JSON.stringify(out);
    for (const bad of ['wikiRoot', 'wikiNone', 'setupSeen', 'dc-wiki', 'loginId', 'myId', 'jarPath', '"hong"']) expect(text).not.toContain(bad);
    expect(out).toMatchObject({ kind: 'wiki-radar-settings', version: 1, appVersion: '1.4.0' });
    expect(out.app.teamSync).toEqual({ enabled: true, remote: '\\\\nas\\share\\WIKI' });
    expect(out.voc).toEqual({ memberIds: [1], systems: ['A'], showAllUnassigned: false, pollMinutes: 10, apiUrl: 'https://voc.example.com:11300' });
    expect(exportFileName('2026-10-20')).toBe('wiki-radar-settings-20261020.json');
  });
});

describe('parseSettingsImport', () => {
  it('되읽기: 내보낸 것은 다시 읽힌다', () => {
    const out = buildSettingsExport({ app: APP, mail: { fromName: 'a', signature: '', bccSelf: false }, voc: null, appVersion: '1', exportedAt: 'x' });
    const p = parseSettingsImport(JSON.stringify(out));
    expect(p.app.mailIn).toEqual(APP.mailIn);
    expect(p.app.teamSync).toEqual({ enabled: true, remote: '\\\\nas\\share\\WIKI', local: '' });
    expect(p.mail).toEqual({ fromName: 'a', signature: '', bccSelf: false });
    expect(p.skipped).toEqual({});
  });

  it('kind·version 확인', () => {
    expect(() => parseSettingsImport('{"kind":"x","version":1}')).toThrow(/kind/);
    expect(() => parseSettingsImport('{"kind":"wiki-radar-settings","version":2}')).toThrow(/version/);
    expect(() => parseSettingsImport('not json')).toThrow(/JSON/);
  });

  it('비밀 키가 든 필드·틀린 필드·VOC 로그인은 버리고 알린다', () => {
    const p = parseSettingsImport(
      JSON.stringify({
        kind: 'wiki-radar-settings',
        version: 1,
        app: { mailIn: { host: 'pop.example.com', password: 'p-123456', port: 'x' }, ai: { apiKey: 'k', model: 'm' } },
        voc: { memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10, loginId: 'hong', token: 't' },
      }),
    );
    expect(p.app.mailIn).toEqual({ host: 'pop.example.com' });
    expect(p.app.ai).toEqual({ model: 'm' });
    expect(p.skipped.mailIn).toEqual(expect.arrayContaining(['mailIn.password', 'mailIn.port']));
    expect(p.skipped.ai).toContain('ai.apiKey');
    expect(p.skipped.voc).toEqual(expect.arrayContaining(['voc.token', 'voc.loginId']));
    expect(JSON.stringify(p.app)).not.toContain('p-123456');
    expect(p.voc).toEqual({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10 });
  });

  it('바뀌는 필드 수', () => {
    expect(countChanges({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toBe(2);
    expect(countChanges(undefined, { a: 1, b: 2 })).toBe(2);
    expect(countChanges({ a: [1] }, { a: [1] })).toBe(0);
  });
});

describe('진단 정보·토큰', () => {
  it('아이디는 가리고 비밀은 저장됨/없음만, 마지막에 비밀을 한 번 더 가린다', () => {
    const text = buildDiagnostics({
      info: {
        version: '1.4.0', electron: '44', chrome: '1', node: '22', install: 'dev', os: 'Windows', dataDir: 'C:\\data', logsDir: 'C:\\data\\logs',
        update: { value: 'off', source: 'user' }, testMode: true, teamDefaults: { source: 'none', problems: [], values: {} }, teamDefaultsFile: '.radar/team-settings.json',
      },
      wiki: { path: 'C:\\Wiki', source: 'settings' },
      sections: [
        {
          section: 'mailIn',
          fields: { host: { value: 'pop.example.com', source: 'team' }, user: { value: 'hong@example.com', source: 'user' } },
          secrets: { 'mailIn.pass': { saved: true, source: 'user', storage: 'file' } },
          notes: [],
          team: { source: 'none', problems: [] },
        },
      ],
      setup: { mail: { ok: false, problem: '없음' } },
      recentWarnings: ['경고 my-secret-pass-1 이 섞임'],
      secrets: ['my-secret-pass-1'],
    });
    expect(text).toContain('pop.example.com');
    expect(text).toContain('h***@example.com');
    expect(text).not.toContain('hong@example.com');
    expect(text).toContain('mailIn.pass: 저장됨');
    expect(text).not.toContain('my-secret-pass-1');
    expect(maskId('abc')).toBe('a***');
  });

  it('미리보기 토큰은 한 번만, 만료되면 거부', () => {
    let now = 0;
    const t = new ImportTokens(1_000, () => now);
    const token = t.put({ app: {}, skipped: {} });
    expect(t.take(token)).toEqual({ app: {}, skipped: {} });
    expect(() => t.take(token)).toThrow(/만료/);
    const t2 = t.put({ app: {}, skipped: {} });
    now = 2_000;
    expect(() => t.take(t2)).toThrow(/만료/);
    expect(() => t.take('bad')).toThrow(/토큰/);
  });
});
