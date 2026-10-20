// 처음 실행 점검(2.7단계 명세): 앱 설정 파일(src/main/appSettings.ts)과 점검 줄(src/renderer/lib/setup.ts).
// 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_SETTINGS_FILE,
  AppSettingsStore,
  parseAppSettings,
  resolveWikiRoot,
  wikiPathProblem,
} from '../../src/main/appSettings';
import { FOCUS_SETUP_VIEW } from '../../src/renderer/api';
import * as S from '../../src/renderer/lib/setup';
import type { SetupStatus, VocBoard } from '../../src/shared/types';
import { FEATURES } from '../../src/shared/edition';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-appsettings-'));
  temps.push(dir);
  return dir;
}

const ABS = process.platform === 'win32' ? 'C:\\Users\\someone\\WIKI' : '/home/someone/WIKI';
const DEFAULT = process.platform === 'win32' ? 'C:\\Users\\someone\\OneDrive\\Obsidian\\WIKI' : '/home/someone/default/WIKI';

describe('앱 설정 — 위키 폴더 값', () => {
  it('전체 경로만 받는다', () => {
    expect(wikiPathProblem(ABS)).toBeNull();
    expect(wikiPathProblem('')).toMatch(/고르세요/);
    expect(wikiPathProblem('   ')).toMatch(/고르세요/);
    expect(wikiPathProblem(42)).toMatch(/고르세요/);
    expect(wikiPathProblem('WIKI')).toMatch(/전체 경로/);
    expect(wikiPathProblem(`${ABS}\n`.replace('\n', '\u0001'))).toMatch(/쓸 수 없는 글자/);
    expect(wikiPathProblem(ABS + 'x'.repeat(1100))).toMatch(/너무 깁니다/);
  });

  it.runIf(process.platform === 'win32')('Windows 는 드라이브 또는 UNC 경로만', () => {
    expect(wikiPathProblem('\\WIKI')).toMatch(/전체 경로/);
    expect(wikiPathProblem('\\\\server\\share\\WIKI')).toBeNull();
    expect(wikiPathProblem('D:/WIKI')).toBeNull();
  });

  it('알려진 필드만 남기고 형이 틀린 값은 버린다', () => {
    expect(parseAppSettings({ wikiRoot: ABS, setupSeen: true, extra: 1 })).toEqual({ wikiRoot: path.resolve(ABS), setupSeen: true });
    expect(parseAppSettings({ wikiRoot: 'relative', setupSeen: 'yes' })).toEqual({});
    expect(parseAppSettings(null)).toEqual({});
    expect(parseAppSettings([1, 2])).toEqual({});
  });

  it('위키 위치: 환경 변수 → 고른 폴더 → 기본 위치', () => {
    expect(resolveWikiRoot({ WIKI_RADAR_WIKI: ` ${ABS} ` }, { wikiRoot: DEFAULT }, DEFAULT)).toEqual({
      path: path.resolve(ABS),
      source: 'env',
    });
    expect(resolveWikiRoot({ WIKI_RADAR_WIKI: '  ' }, { wikiRoot: ABS }, DEFAULT)).toEqual({ path: path.resolve(ABS), source: 'settings' });
    expect(resolveWikiRoot({}, {}, DEFAULT)).toEqual({ path: path.resolve(DEFAULT), source: 'default' });
  });
});

describe('앱 설정 — 파일', () => {
  it('없으면 빈 설정, 바꾸면 원자적으로 쓰고 다시 읽힌다', () => {
    const dir = tempDir();
    const store = new AppSettingsStore(dir);
    expect(store.get()).toEqual({});
    expect(store.update({ wikiRoot: ABS })).toEqual({ wikiRoot: path.resolve(ABS) });
    expect(store.update({ setupSeen: true })).toEqual({ wikiRoot: path.resolve(ABS), setupSeen: true });
    expect(new AppSettingsStore(dir).get()).toEqual({ wikiRoot: path.resolve(ABS), setupSeen: true });
    // undefined 는 그 필드를 지운다
    expect(store.update({ wikiRoot: undefined })).toEqual({ setupSeen: true });
    expect(fs.readdirSync(dir)).toEqual([APP_SETTINGS_FILE]); // 임시 파일이 남지 않는다
  });

  it('깨진 파일은 경고하고 빈 설정으로 시작한다(덮어쓰지 않는다)', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, APP_SETTINGS_FILE), '{ 깨짐', 'utf8');
    const warnings: string[] = [];
    const store = new AppSettingsStore(dir, (m) => warnings.push(m));
    expect(store.get()).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, APP_SETTINGS_FILE), 'utf8')).toBe('{ 깨짐');
  });

  it('형이 틀린 값은 쓰지 않는다', () => {
    const store = new AppSettingsStore(tempDir());
    expect(store.update({ wikiRoot: 'relative' })).toEqual({});
  });
});

const OK: SetupStatus = {
  wiki: { ok: true, path: ABS, source: 'settings' },
  claude: { ok: true, path: 'C:\\claude.exe', source: 'path' },
  mail: { ok: true },
  seen: false,
};

function board(over: Partial<VocBoard>): VocBoard {
  return {
    state: 'ok',
    lanes: [],
    totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 },
    ...over,
  };
}

describe('점검 줄(renderer)', () => {
  it('FOCUS_SETUP_VIEW 는 다른 초점 표시와 겹치지 않는다', () => {
    expect(FOCUS_SETUP_VIEW).toBe('view:setup');
  });

  it('main 응답을 다듬는다 — 모양이 틀리면 null', () => {
    expect(S.normalizeSetup(OK)).toEqual(OK);
    expect(S.normalizeSetup({ ...OK, wiki: { ...OK.wiki, pending: 'D:\\W' }, mail: { ok: false, problem: '없음' } })).toEqual({
      ...OK,
      wiki: { ...OK.wiki, pending: 'D:\\W' },
      mail: { ok: false, problem: '없음' },
    });
    expect(S.normalizeSetup({ ...OK, wiki: { ...OK.wiki, source: 'other' } })).toBeNull();
    expect(S.normalizeSetup({ ...OK, claude: null })).toBeNull();
    expect(S.normalizeSetup(undefined)).toBeNull();
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc || !FEATURES.localLlm)('모두 있으면 VOC 로그인만 본다', () => {
    const rows = S.setupRows(OK, board({ fetchedAt: '2026-10-08T09:00:00+09:00', me: { id: 1, name: '홍길동' } }));
    expect(rows.map((r) => [r.key, r.tone, r.state])).toEqual([
      ['wiki', 'ok', '사용 가능'],
      ['claude', 'ok', '사용 가능'],
      ['mail', 'ok', '사용 가능'],
      ['voc', 'ok', '로그인됨'],
    ]);
    expect(rows[3].detail).toContain('홍길동');
    expect(rows.every((r) => r.effect === undefined)).toBe(true);
    expect(S.setupProblemCount(OK, board({ fetchedAt: '2026-10-08T09:00:00+09:00' }))).toBe(0);
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc || !FEATURES.localLlm)('없는 것은 꺼지는 기능과 고치는 방법을 적는다', () => {
    const status: SetupStatus = {
      wiki: { ok: false, path: DEFAULT, source: 'default' },
      claude: { ok: false, path: 'C:\\Users\\x\\.local\\bin\\claude.exe', source: 'default' },
      mail: { ok: false, problem: '메일 계정이 없습니다' },
      seen: false,
    };
    const rows = S.setupRows(status, board({ state: 'login' }));
    expect(rows.map((r) => [r.key, r.tone, r.state])).toEqual([
      ['wiki', 'off', '없음'],
      ['claude', 'off', '없음'],
      ['mail', 'off', '없음'],
      ['voc', 'off', '로그인 필요'],
    ]);
    expect(rows[0].effect).toBe('할 일 · 반영 대기 · 메일 회신');
    expect(rows[0].detail).toContain('[폴더 고르기]');
    expect(rows[1].effect).toBe('위키 반영 · 회신 초안 만들기');
    expect(rows[2].detail).toBe('메일 계정이 없습니다');
    expect(S.setupProblemCount(status, board({ state: 'login' }))).toBe(4);
    expect(S.wikiMissing(status)).toBe(true);
    expect(S.claudeProblem(status)).toMatch(/Claude Code/);
  });

  it('환경 변수로 정한 위키·claude 가 없으면 환경 변수를 고치라고 한다', () => {
    const rows = S.setupRows(
      { ...OK, wiki: { ok: false, path: ABS, source: 'env' }, claude: { ok: false, path: 'x.exe', source: 'env' } },
      null,
    );
    expect(rows[0].detail).toContain('WIKI_RADAR_WIKI');
    expect(rows[1].detail).toContain('WIKI_RADAR_CLAUDE');
  });

  it('새로 고른 폴더는 다시 시작해야 적용된다', () => {
    const rows = S.setupRows({ ...OK, wiki: { ...OK.wiki, ok: false, pending: 'D:\\WIKI' } }, null);
    expect(rows[0]).toMatchObject({ tone: 'warn', state: '다시 시작 필요' });
    expect(rows[0].detail).toContain('D:\\WIKI');
  });

  // 공개판(src/shared/edition.ts)에서 가린 기능
  it.skipIf(!FEATURES.voc)('VOC: 받는 중·설정 필요·연결 안 됨', () => {
    expect(S.setupRows(OK, null)[3]).toMatchObject({ tone: 'wait', state: '확인 중' });
    expect(S.setupRows(OK, board({ state: 'loading' }))[3]).toMatchObject({ tone: 'wait' });
    expect(S.setupRows(OK, board({ state: 'notConfigured', message: '설정하세요' }))[3]).toMatchObject({
      tone: 'off',
      detail: '설정하세요',
    });
    expect(S.setupRows(OK, board({ state: 'unavailable' }))[3]).toMatchObject({ tone: 'warn', state: '연결 안 됨' });
  });

  it('모르면(아직 읽지 않음) 아무것도 끄지 않는다', () => {
    expect(S.wikiMissing(null)).toBe(false);
    expect(S.claudeProblem(null)).toBeNull();
    expect(S.setupProblemCount(null, null)).toBe(0);
  });
});

describe('2.9단계 — app-settings.json 의 me·notify(§9)', () => {
  it('notify 는 형이 틀린 칸만 기본으로 되돌린다(전체를 버리지 않는다). 없으면 필드도 없다', () => {
    expect(parseAppSettings({ setupSeen: true })).toEqual({ setupSeen: true });
    const s = parseAppSettings({ notify: { kinds: { vocSla: 'off', due: 'nope' }, morningTime: '09:00', workEnd: 'x', hideContent: true } });
    expect(s.notify).toEqual({
      kinds: { due: 'toast', vocSla: 'off', vocAssign: 'toast', morning: 'toast' },
      morningTime: '09:00',
      workStart: '08:00',
      workEnd: '19:00',
      hideContent: true,
      quietStart: '',
      quietEnd: '',
      quietHold: true,
      sound: false,
    });
    expect(parseAppSettings({ notify: 'x' }).notify?.kinds.due).toBe('toast');
  });

  it('me 가 틀리면 me 만 버리고 나머지는 읽는다', () => {
    expect(parseAppSettings({ setupSeen: true, me: { name: 'a]b', aliases: [] } })).toEqual({ setupSeen: true });
    expect(parseAppSettings({ me: { name: ' 홍길동 ', aliases: ['길동'] } }).me).toEqual({ name: '홍길동', aliases: ['길동'] });
  });

  it('저장소: 사람이 저장할 때만 notify 를 쓴다', () => {
    const dir = tempDir();
    const store = new AppSettingsStore(dir);
    store.update({ setupSeen: true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, APP_SETTINGS_FILE), 'utf8'))).toEqual({ setupSeen: true });
    store.update({
      notify: {
        kinds: { due: 'inbox', vocSla: 'toast', vocAssign: 'off', morning: 'toast' },
        morningTime: '08:30',
        workStart: '08:00',
        workEnd: '18:00',
        hideContent: false,
        quietStart: '',
        quietEnd: '',
        quietHold: true,
        sound: false,
      },
    });
    expect(new AppSettingsStore(dir).get().notify?.kinds.vocAssign).toBe('off');
  });
});

describe('2.9단계 — 점검 「알림」 줄(§8-5)', () => {
  it('지원되면 ok 와 오늘 수, 시험 기록이면 ok, 지원 안 되면 warn — off 가 되지 않아 「설정」 수가 그대로다', () => {
    const row = (notify: SetupStatus['notify']) => S.setupRows({ ...OK, notify }, null).find((r) => r.key === 'notify');
    expect(row(undefined)).toBeUndefined();
    expect(row({ supported: true, mode: 'toast', todayToasts: 2 })).toMatchObject({ tone: 'ok', detail: '사용 가능 — 오늘 Windows 알림 2건' });
    expect(row({ supported: true, mode: 'log', todayToasts: 0 })).toMatchObject({ tone: 'ok', detail: '시험 기록 파일에 씁니다.' });
    expect(row({ supported: false, mode: 'toast', todayToasts: 0 })).toMatchObject({ tone: 'warn' });
    const unsupported = { ...OK, notify: { supported: false, mode: 'toast' as const, todayToasts: 0 } };
    expect(S.setupProblemCount(unsupported, board({ fetchedAt: '2026-10-08T09:00:00+09:00' }))).toBe(0);
  });

  it('main 응답의 notify 를 검사해 살린다(틀리면 줄 없음)', () => {
    const raw = { ...OK, notify: { supported: true, mode: 'log', todayToasts: 3 } };
    expect(S.normalizeSetup(raw)?.notify).toEqual({ supported: true, mode: 'log', todayToasts: 3 });
    expect(S.normalizeSetup({ ...OK, notify: { supported: 'yes', mode: 'log' } })?.notify).toBeUndefined();
  });
});

describe('2.12단계 — 점검 「알림」 줄 우선순위(§6-2)', () => {
  const row = (notify: SetupStatus['notify']) => S.setupRows({ ...OK, notify }, null).find((r) => r.key === 'notify');
  const toast = { supported: true, mode: 'toast' as const, todayToasts: 2 };

  it('보낼 수 없음 → 표시 실패 → 보류 중 → 감지 없음 → 시험 기록/사용 가능, 어느 경우도 off 아님', () => {
    const fail = { at: new Date(2026, 8, 23, 14, 2).toISOString() };
    const held = { state: 'held' as const, label: '발표 중' };
    const cases = [
      [{ ...toast, supported: false, lastFailure: fail, quiet: held }, 'warn', 'Windows 알림을 보낼 수 없습니다 — 알림함에만 남습니다.'],
      [{ ...toast, lastFailure: fail, quiet: held }, 'warn', 'Windows 가 알림을 표시하지 못했습니다(14:02) — 알림함에는 남습니다.'],
      [{ ...toast, quiet: held }, 'warn', '지금 보낼 수 없음 — 발표 중. 끝나면 1건으로 보냅니다.'],
      [{ ...toast, quiet: { state: 'unavailable' as const } }, 'warn', '전체 화면·발표 중 감지를 쓸 수 없습니다 — 그대로 보냅니다.'],
      [{ ...toast, quiet: { state: 'off' as const } }, 'ok', '사용 가능 — 오늘 Windows 알림 2건'],
      [{ ...toast, mode: 'log' as const, quiet: { state: 'ok' as const } }, 'ok', '시험 기록 파일에 씁니다.'],
    ] as const;
    for (const [notify, tone, detail] of cases) {
      const r = row(notify);
      expect(r).toMatchObject({ tone, detail });
      expect(r?.tone).not.toBe('off');
      expect(r?.quiet).toBe(notify.quiet.state);
    }
    // 시험 기록이어도 보류는 보인다
    expect(row({ ...toast, mode: 'log', quiet: held })).toMatchObject({ tone: 'warn', quiet: 'held' });
  });

  it('main 응답의 quiet·lastFailure 를 검사해 살린다(틀리면 그 칸만 버림)', () => {
    const at = new Date(2026, 8, 23, 14, 2).toISOString();
    const raw = { ...OK, notify: { supported: true, mode: 'toast', todayToasts: 1, quiet: { state: 'held', label: '발표 중' }, lastFailure: { at } } };
    expect(S.normalizeSetup(raw)?.notify).toEqual({ supported: true, mode: 'toast', todayToasts: 1, quiet: { state: 'held', label: '발표 중' }, lastFailure: { at } });
    const bad = { ...OK, notify: { supported: true, mode: 'toast', todayToasts: 1, quiet: { state: 'nap' }, lastFailure: { at: 'x' } } };
    expect(S.normalizeSetup(bad)?.notify).toEqual({ supported: true, mode: 'toast', todayToasts: 1 });
  });
});

describe('2.12단계 — app-settings.json 의 shell(§6-1b)', () => {
  it('읽기: 틀리면 기본(tray), 없으면 필드도 없다 · 저장소는 사람이 저장할 때만 쓴다', () => {
    expect(parseAppSettings({ shell: { closeAction: 'quit' } }).shell).toEqual({ closeAction: 'quit' });
    expect(parseAppSettings({ shell: { closeAction: 'x' } }).shell).toEqual({ closeAction: 'tray' });
    expect(parseAppSettings({ setupSeen: true })).toEqual({ setupSeen: true });
    const dir = tempDir();
    const store = new AppSettingsStore(dir);
    expect(store.get().shell).toBeUndefined();
    expect(fs.existsSync(path.join(dir, APP_SETTINGS_FILE))).toBe(false);
    store.update({ shell: { closeAction: 'quit' } });
    expect(JSON.parse(fs.readFileSync(path.join(dir, APP_SETTINGS_FILE), 'utf8'))).toEqual({ shell: { closeAction: 'quit' } });
  });
});
