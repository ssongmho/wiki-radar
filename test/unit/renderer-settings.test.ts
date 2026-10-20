// 설정 칸 6개의 화면 쪽 계산(2.13단계 명세 §F-3 renderer-settings): 응답 검사, 바뀐 필드(patch), 출처 글, 칸 점·[고치기] 대상,
// 회신 초안 엔진에 따른 초안 막힘 이유, 점검의 새 줄(메일 받기·AI·팀 기본값·저장된 비밀).
import { describe, expect, it } from 'vitest';
import { LOCAL_LLM_MISSING, draftUnavailableOf } from '../../src/renderer/hooks/useDraftEngine';
import * as L from '../../src/renderer/lib/settings';
import { normalizeSetup, setupRows } from '../../src/renderer/lib/setup';
import { parseSettingsFocus } from '../../src/shared/ipc';
import type { SettingsSectionView, SetupStatus } from '../../src/shared/types';
import { FEATURES } from '../../src/shared/edition';

const TODAY = '2026-10-19';

function mailInView(over: Partial<SettingsSectionView['fields']> = {}): SettingsSectionView {
  return {
    section: 'mailIn',
    fields: {
      host: { value: 'pop.team.example', source: 'team', teamValue: 'pop.team.example' },
      port: { value: 995, source: 'builtin', builtinValue: 995 },
      ssl: { value: true, source: 'builtin', builtinValue: true },
      user: { value: 'me@example.com', source: 'user', userValue: 'me@example.com' },
      intervalMinutes: { value: 10, source: 'builtin', builtinValue: 10 },
      firstDate: { value: null, source: 'none' },
      enabled: { value: true, source: 'builtin', builtinValue: true },
      ...over,
    },
    secrets: { 'mailIn.pass': { saved: true, source: 'user', storage: 'file' } },
    notes: [],
    team: { source: 'env', problems: [], readAt: '2026-10-19T09:12:00' },
  };
}

describe('normalizeSectionView', () => {
  it('맞는 응답을 그대로 받고, 모르는 칸·틀린 출처의 필드는 버린다', () => {
    const v = L.normalizeSectionView({ ...mailInView(), extra: 1 }, 'mailIn');
    expect(v?.fields.host).toEqual({ value: 'pop.team.example', source: 'team', teamValue: 'pop.team.example' });
    expect(v?.secrets['mailIn.pass']).toEqual({ saved: true, source: 'user', storage: 'file' });
    expect(L.normalizeSectionView({ ...mailInView(), section: 'nope' })).toBeNull();
    expect(L.normalizeSectionView(mailInView(), 'ai')).toBeNull();
    const bad = L.normalizeSectionView({ ...mailInView(), fields: { host: { value: 'x', source: 'weird' }, port: { value: { a: 1 }, source: 'user' } } });
    expect(bad?.fields.host).toBeUndefined();
    expect(bad?.fields.port).toEqual({ value: null, source: 'user' });
  });

  it('비밀 칸은 saved·출처만 — 값이 섞여 와도 버린다', () => {
    const raw = { ...mailInView(), secrets: { 'mailIn.pass': { saved: true, source: 'user', value: 'leak-123456' }, 'other.key': { saved: true, source: 'user' } } };
    const v = L.normalizeSectionView(raw);
    expect(JSON.stringify(v)).not.toContain('leak-123456');
    expect(Object.keys(v?.secrets ?? {})).toEqual(['mailIn.pass']);
  });
});

describe('초안 → 바뀐 필드', () => {
  it('바뀐 것만, 숫자 칸은 숫자로, 같은 값으로 되돌리면 빈 patch', () => {
    const v = mailInView();
    expect(L.changedPatch('mailIn', v, { port: '110', host: 'pop.team.example' })).toEqual({ port: 110 });
    expect(L.changedPatch('mailIn', v, { port: '995' })).toEqual({});
    expect(L.changedPatch('mailIn', v, { ssl: false })).toEqual({ ssl: false });
    expect(L.patchIsEmpty(L.changedPatch('mailIn', v, {}))).toBe(true);
  });

  it('[팀 기본값으로](null)·빈 글은 내 값이 있을 때만 지움(null)', () => {
    const v = mailInView();
    expect(L.changedPatch('mailIn', v, { user: null })).toEqual({ user: null });
    expect(L.changedPatch('mailIn', v, { user: '  ' })).toEqual({ user: null });
    expect(L.changedPatch('mailIn', v, { host: null })).toEqual({});
  });

  it('환경 변수로 잠긴 필드는 보내지 않는다', () => {
    const v = mailInView({ host: { value: '127.0.0.1', source: 'env', envName: 'WIKI_RADAR_POP3_HOST' } });
    expect(L.changedPatch('mailIn', v, { host: 'other.example' })).toEqual({});
  });

  it('비밀: set 은 값이 있을 때만, clear 는 그대로', () => {
    const v = mailInView();
    expect(L.changedPatch('mailIn', v, {}, { action: 'set', value: '' })).toEqual({});
    expect(L.changedPatch('mailIn', v, {}, { action: 'set', value: 'pw-1' })).toEqual({ secret: { key: 'mailIn.pass', action: 'set', value: 'pw-1' } });
    expect(L.changedPatch('mailIn', v, {}, { action: 'clear', value: '' })).toEqual({ secret: { key: 'mailIn.pass', action: 'clear' } });
    expect(L.changedPatch('info', { ...v, section: 'info', fields: {} }, {}, { action: 'set', value: 'x' })).toEqual({});
  });

  it('보이는 값·출처: 초안 > 지움(팀·내장) > 지금 값', () => {
    const v = mailInView();
    expect(L.shownText(v, {}, 'port')).toBe('995');
    expect(L.shownText(v, { port: '110' }, 'port')).toBe('110');
    expect(L.shownSource(v, { port: '110' }, 'port')).toBe('user');
    expect(L.shownSource(v, {}, 'host')).toBe('team');
    expect(L.shownText(v, { user: null }, 'user')).toBe('');
    expect(L.shownSource(v, { user: null }, 'user')).toBe('none');
    expect(L.shownSource(mailInView({ host: { value: 'a', source: 'user', userValue: 'a', teamValue: 'pop.team.example' } }), { host: null }, 'host')).toBe('team');
    expect(L.shownBool(v, {}, 'ssl')).toBe(true);
  });
});

describe('검사 문장', () => {
  it('칸마다 틀린 값을 잡는다', () => {
    expect(L.patchProblems('mailIn', { port: 70000, intervalMinutes: 3 }, TODAY)).toEqual({
      port: expect.stringMatching(/1~65535/),
      intervalMinutes: expect.stringMatching(/5~60/),
    });
    expect(L.patchProblems('mailIn', { port: Number.NaN }, TODAY).port).toBe('숫자를 넣으세요');
    expect(L.patchProblems('mailIn', { firstDate: '2026-10-20' }, TODAY).firstDate).toMatch(/오늘/);
    expect(L.patchProblems('mailIn', { firstDate: '2026-02-30' }, TODAY).firstDate).toMatch(/YYYY-MM-DD/);
    expect(L.patchProblems('mailIn', { host: 'bad host', user: 'a b' }, TODAY)).toEqual({ host: expect.any(String), user: expect.any(String) });
    expect(L.patchProblems('ai', { llmUrl: 'ftp://x', model: 'a b' }, TODAY)).toEqual({ llmUrl: expect.any(String), model: expect.any(String) });
    expect(L.patchProblems('ai', { llmUrl: 'http://10.0.0.5:8000/v1', model: 'qwen-1.5:7b' }, TODAY)).toEqual({});
    expect(L.patchProblems('info', { updateUrl: 'off' }, TODAY)).toEqual({});
    expect(L.patchProblems('mailIn', { secret: { key: 'mailIn.pass', action: 'set', value: 'a\nb' } }, TODAY).secret).toMatch(/제어 문자/);
    expect(L.patchProblems('mailIn', { user: null }, TODAY)).toEqual({});
  });
});

describe('글', () => {
  it('출처 글', () => {
    expect(L.sourceText('env', 'WIKI_RADAR_SMTP_HOST')).toBe('환경 변수 WIKI_RADAR_SMTP_HOST 로 정해짐');
    expect(L.sourceText('team')).toBe('팀 기본값');
    expect(L.sourceText('builtin')).toBe('내장 기본값');
    expect(L.sourceText('dotenv')).toMatch(/\.env/);
    expect(L.sourceText('user')).toBe('');
  });
  it('칸 머리·비밀 상태·저장 결과', () => {
    expect(L.teamHeadText({ source: 'local', readAt: '2026-10-19T09:12:30', problems: [] })).toBe('팀 기본값: 내 PC 사본 · 2026-10-19 09:12 읽음');
    expect(L.teamHeadText({ source: 'none', problems: [] })).toBe('팀 기본값 없음 — 내장 기본값');
    expect(L.secretText({ saved: true, source: 'user' }, L.KEEP_SECRET)).toBe('저장됨');
    expect(L.secretText({ saved: true, source: 'user', storage: 'memory' }, L.KEEP_SECRET)).toMatch(/이번 실행/);
    expect(L.secretText({ saved: false, source: 'env', envName: 'SERVER_LLM_API_KEY' }, L.KEEP_SECRET)).toMatch(/SERVER_LLM_API_KEY/);
    expect(L.secretText(undefined, { action: 'clear', value: '' })).toMatch(/지움/);
    expect(L.saveResultText({ ignored: ['host'], secretStorage: 'memory' })).toMatch(/host.*이번 실행/);
    expect(L.saveResultText({ ignored: [], restartNeeded: true })).toMatch(/다시 시작/);
  });
  it('로컬 LLM 주소가 회사 밖인가', () => {
    expect(L.llmUrlOutside('http://192.168.50.1:8000/v1')).toBe(false);
    expect(L.llmUrlOutside('http://127.0.0.1:9/v1')).toBe(false);
    expect(L.llmUrlOutside('https://api.example.com/v1')).toBe(true);
    expect(L.llmUrlOutside('https://lgw.acme.test/v1')).toBe(false);
    expect(L.llmUrlOutside('https://acme.test/v1')).toBe(false);
    expect(L.llmUrlOutside('https://evilacme.test/v1')).toBe(true);
    expect(L.llmUrlOutside('https://acme.test.example.com/v1')).toBe(true);
    expect(L.llmUrlOutside('nope')).toBeNull();
  });
});

const BASE: SetupStatus = {
  wiki: { ok: true, path: 'C:/WIKI', source: 'settings' },
  claude: { ok: true, path: 'claude', source: 'path' },
  mail: { ok: true },
  seen: true,
};

describe('점검 줄 → 칸 점·[고치기]', () => {
  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc || !FEATURES.localLlm)('새 줄을 읽고, warn/off 가 가리키는 칸에 점', () => {
    const status = normalizeSetup({
      ...BASE,
      mailIn: { state: 'warn', text: '서버·계정을 넣으세요' },
      ai: { state: 'ok', text: '로컬 LLM x' },
      team: { state: 'ok', text: '팀 기본값 없음 — 내장 기본값', quiet: true },
      secrets: { state: 'bad', text: 'x' },
    });
    expect(status?.mailIn).toEqual({ state: 'warn', text: '서버·계정을 넣으세요' });
    expect(status?.secrets).toBeUndefined();
    const rows = setupRows(status as SetupStatus, null);
    expect(rows.map((r) => r.key)).toEqual(['wiki', 'claude', 'mail', 'mailIn', 'ai', 'voc', 'team']);
    expect(rows.find((r) => r.key === 'team')?.state).toBe('내장 기본값');
    const dots = L.tabDots(status, { state: 'ok', fetchedAt: 'x' } as never);
    expect([...dots]).toEqual(['mailIn']);
    expect(L.tabDots(status, null, 'warn').has('wiki')).toBe(true);
    expect(L.tabDots({ ...BASE, claude: { ok: false, path: '', source: 'path' } }, null).has('ai')).toBe(true);
  });

  it('[고치기] 대상 칸(§D-3)', () => {
    expect(L.SETUP_FIX_TAB).toMatchObject({ wiki: 'wiki', claude: 'ai', mail: 'mailOut', mailIn: 'mailIn', ai: 'ai', voc: 'voc', notify: 'notify', team: 'info', teamsync: 'wiki' });
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc)('칸 목록 9칸 순서·포커스 표시', () => {
    expect(L.SETTINGS_TAB_LIST.map((t) => t.label)).toEqual(['점검', '나', '위키', '메일 받기', '메일 보내기', 'AI', 'VOC', '알림', '정보']);
    expect(L.SETTINGS_TAB_LIST.map((t) => t.testid)[0]).toBe('settings-tab-check');
    expect(parseSettingsFocus('view:settings:ai')).toBe('ai');
    expect(parseSettingsFocus('view:settings:nope')).toBeNull();
  });
});

describe('회신 초안 엔진', () => {
  it('local 이면 로컬 LLM 준비 여부, claude 면 Claude Code 문장', () => {
    expect(draftUnavailableOf({ engine: 'local', localReady: false }, null)).toBe(LOCAL_LLM_MISSING);
    expect(draftUnavailableOf({ engine: 'local', localReady: true }, 'claude 없음')).toBeNull();
    expect(draftUnavailableOf({ engine: 'claude', localReady: true }, 'claude 없음')).toBe('claude 없음');
    // 주소·모델은 있는데 [연결 시험] 전이면 main 의 문장 그대로
    const untested = '로컬 LLM(127.0.0.1:9)을 아직 시험하지 않았습니다 — 설정 › AI 에서 [연결 시험]을 눌러 성공하면 씁니다';
    expect(draftUnavailableOf({ engine: 'local', localReady: false, localProblem: untested }, null)).toBe(untested);
    expect(draftUnavailableOf({ engine: 'claude', localReady: false, localProblem: untested }, null)).toBeNull();
  });

  it('AI 칸 응답의 llmProblem 을 받는다', () => {
    const v = L.normalizeSectionView({ section: 'ai', fields: {}, secrets: {}, notes: [], team: { source: 'none', problems: [] }, llmProblem: '시험 전' }, 'ai');
    expect(v?.llmProblem).toBe('시험 전');
  });
});

describe('연결 시험 응답', () => {
  it('단계만 골라 받는다', () => {
    const r = L.normalizeTestResult({ ok: false, steps: [{ label: '연결', ok: true }, { label: '로그인', ok: false, detail: '로그인 실패' }, { x: 1 }], ms: 120 });
    expect(r).toEqual({ ok: false, steps: [{ label: '연결', ok: true }, { label: '로그인', ok: false, detail: '로그인 실패' }], ms: 120 });
    expect(L.stepTone({ ok: true, warn: true })).toBe('warn');
    expect(L.normalizeTestResult(null)).toBeNull();
  });
});
