// 2.13단계 §A-1 app-settings.json 의 새 칸(틀린 필드만 버림)·개인 위키 「없음」(자리 표시 경로, source none)
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_PERSONAL_WIKI_DIR, parseAppSettings, resolveWikiRoot } from '../../src/main/appSettings';
import { firstDateProblem, isPrivateIp, llmUrlOutside, normalizeLlmUrl, normalizeUpdateUrl } from '../../src/main/settings/fields';

describe('parseAppSettings 새 칸', () => {
  it('형이 틀린 필드만 버린다(칸 전체를 버리지 않는다)', () => {
    const s = parseAppSettings({
      mailIn: { host: 'pop.example.com', port: 'x', ssl: true, user: 'a b', intervalMinutes: 3, firstDate: '2026-02-30', enabled: false },
      mailOut: { sameAccount: false, host: '127.0.0.1', port: 2525, security: 'tls', user: 'me@example.com' },
      ai: { llmUrl: 'http://example.com/v1', apiFormat: 'openai', model: 'qwen:27b', draftEngine: 'local' },
      update: { url: 'ftp://x' },
    });
    expect(s.mailIn).toEqual({ host: 'pop.example.com', ssl: true, enabled: false });
    expect(s.mailOut).toEqual({ sameAccount: false, host: '127.0.0.1', port: 2525, user: 'me@example.com' });
    // http 는 사설망 IP 에만 — 호스트 이름 http 는 버림
    expect(s.ai).toEqual({ apiFormat: 'openai', model: 'qwen:27b', draftEngine: 'local' });
    expect(s.update).toBeUndefined();
  });

  it('빈 칸은 남기지 않고, wikiNone 은 true 만', () => {
    expect(parseAppSettings({ mailIn: {}, wikiNone: 'yes' })).toEqual({});
    expect(parseAppSettings({ wikiNone: true, update: { url: 'off' } })).toEqual({ wikiNone: true, update: { url: 'off' } });
  });
});

describe('resolveWikiRoot 「없음」', () => {
  const data = path.resolve('C:/radar-data');
  it('wikiNone → 데이터 폴더 안 자리 표시 경로, source none(빈 경로가 아님)', () => {
    const loc = resolveWikiRoot({}, { wikiNone: true, wikiRoot: 'C:\\Wiki' }, 'C:\\Default', data);
    expect(loc).toEqual({ path: path.join(data, NO_PERSONAL_WIKI_DIR), source: 'none' });
    expect(loc.path).not.toBe(path.resolve(''));
  });
  it('환경 변수가 이기고, 「폴더」로 돌아오면 남겨 둔 wikiRoot', () => {
    expect(resolveWikiRoot({ WIKI_RADAR_WIKI: 'C:\\EnvWiki' }, { wikiNone: true }, 'C:\\Default', data).source).toBe('env');
    expect(resolveWikiRoot({}, { wikiRoot: 'C:\\Wiki' }, 'C:\\Default', data)).toEqual({ path: path.resolve('C:\\Wiki'), source: 'settings' });
    // dataDir 를 주지 않는 옛 호출은 그대로
    expect(resolveWikiRoot({}, { wikiNone: true }, 'C:\\Default').source).toBe('default');
  });
});

describe('필드 검사', () => {
  it('LLM 주소: 자격·쿼리 금지, 끝 / 뗌, http 는 사설망 IP 만', () => {
    expect(normalizeLlmUrl('http://192.168.50.9:8000/v1/')).toEqual({ url: 'http://192.168.50.9:8000/v1' });
    expect(normalizeLlmUrl('https://llm.example.com/v1')).toEqual({ url: 'https://llm.example.com/v1' });
    expect('problem' in normalizeLlmUrl('http://llm.example.com/v1')).toBe(true);
    expect('problem' in normalizeLlmUrl('http://u:p@10.0.0.1/v1')).toBe(true);
    expect('problem' in normalizeLlmUrl('http://10.0.0.1/v1?x=1')).toBe(true);
    expect('problem' in normalizeLlmUrl('ftp://10.0.0.1/')).toBe(true);
  });
  it('사설망 판정', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '::1', '[::1]']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['172.32.0.1', '8.8.8.8', 'example.com', '192.169.0.1']) expect(isPrivateIp(ip)).toBe(false);
  });
  it('LLM 주소 회사 밖 판정: 사설망·루프백·회사 도메인은 안', () => {
    for (const u of ['http://192.168.50.151:8000/v1', 'http://127.0.0.1:9/v1', 'https://lgw.acme.test/v1', 'https://LGW.Acme.test./v1', 'https://acme.test/v1'])
      expect(llmUrlOutside(u)).toBe(false);
    for (const u of ['https://api.example.com/v1', 'https://evilacme.test/v1', 'https://acme.test.example.com/v1', 'nope']) expect(llmUrlOutside(u)).toBe(true);
  });
  it('처음 받을 날짜: 2000 이후, 오늘까지', () => {
    expect(firstDateProblem('2026-10-19', '2026-10-19')).toBeNull();
    expect(firstDateProblem('2026-10-20', '2026-10-19')).toMatch(/오늘/);
    expect(firstDateProblem('1999-12-31')).toMatch(/2000/);
  });
  it('업데이트 서버: off 또는 http(s)', () => {
    expect(normalizeUpdateUrl('OFF')).toEqual({ url: 'off' });
    expect(normalizeUpdateUrl('http://10.0.0.6:18090')).toEqual({ url: 'http://10.0.0.6:18090/' });
    expect('problem' in normalizeUpdateUrl('file:///c:/x')).toBe(true);
  });
});
