// 2.9단계 A: 설정 › 나(이름 규칙 src/shared/team.ts · 앱 설정 me · 화면 상태 src/renderer/lib/me.ts)와
// 메뉴의 쓸 수 없는 이유(src/renderer/lib/setup.ts navAvailability)·설정 칸 초점 표시. 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_SETTINGS_FILE, AppSettingsStore, checkMeSettings, parseAppSettings } from '../../src/main/appSettings';
import { FOCUS_QUEUE_VIEW, FOCUS_SETTINGS_ME, FOCUS_SETTINGS_NOTIFY, FOCUS_SETUP_VIEW, FOCUS_VOC_VIEW } from '../../src/renderer/api';
import * as M from '../../src/renderer/lib/me';
import * as S from '../../src/renderer/lib/setup';
import { countMine, isMine, meInfoOf, meNameProblem, myNames, normName, ownersOf, splitAliases } from '../../src/shared/team';
import type { SetupStatus, VocBoard } from '../../src/shared/types';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-me-'));
  temps.push(dir);
  return dir;
}

describe('이름 규칙(shared/team)', () => {
  it('normName: NFC · 소문자 · 모든 공백 제거', () => {
    expect(normName(' 홍 길동 ')).toBe('홍길동');
    expect(normName('Hong\tGil\u00a0Dong')).toBe('honggildong');
    // 자모가 나뉜(NFD) 한글도 같은 이름
    expect(normName('홍길동'.normalize('NFD'))).toBe(normName('홍길동'));
  });

  it('ownersOf: 쉼표로 나누고 [[링크]]·@ 를 뗀다, 빈 조각은 버린다', () => {
    expect(ownersOf('홍길동, 박담당')).toEqual(['홍길동', '박담당']);
    expect(ownersOf('[[사람/홍길동|길동]], [[김담당]], @hong')).toEqual(['길동', '김담당', 'hong']);
    expect(ownersOf('  ,  ')).toEqual([]);
    expect(ownersOf(' ')).toEqual([]);
    expect(ownersOf(undefined)).toEqual([]);
  });

  it('meNameProblem: 1~50자, [ ] , 줄바꿈·제어 문자 없음', () => {
    expect(meNameProblem(' 홍길동 ')).toBeNull();
    expect(meNameProblem('')).not.toBeNull();
    expect(meNameProblem('가'.repeat(50))).toBeNull();
    expect(meNameProblem('가'.repeat(51))).not.toBeNull();
    for (const bad of ['홍[길동', '홍]길동', '홍,길동', '홍\n길동', '홍\u0007']) expect(meNameProblem(bad)).not.toBeNull();
  });

  it('myNames: 설정 이름이 없으면 VOC 이름, 다른 표기를 더하고 같은 normName 은 하나로', () => {
    expect(myNames({ name: '홍길동', aliases: ['길동'] }, '김철수')).toEqual({ names: ['홍길동', '길동'], source: 'settings' });
    expect(myNames({ aliases: ['길동', ' 홍 길동'] }, '홍길동')).toEqual({ names: ['홍길동', '길동'], source: 'voc' });
    expect(myNames(undefined, undefined)).toEqual({ names: [], source: 'none' });
    expect(myNames({ aliases: ['hong'] }, undefined)).toEqual({ names: ['hong'], source: 'none' });
  });

  it('isMine·countMine: 대소문자·공백을 보지 않는다', () => {
    expect(isMine(['김담당', ' 홍 길동 '], ['홍길동'])).toBe(true);
    expect(isMine(['HONG'], ['hong'])).toBe(true);
    expect(isMine([], ['홍길동'])).toBe(false);
    expect(isMine(['홍길동'], [])).toBe(false);
    expect(countMine([['홍길동'], ['길동'], [], ['김담당', '홍길동']], ['홍길동'])).toBe(2);
    expect(countMine([['홍길동'], ['길동'], [], ['김담당', '홍길동']], ['홍길동', '길동'])).toBe(3);
  });

  it('meInfoOf: getMe 결과 모양', () => {
    expect(meInfoOf(undefined, '홍길동')).toEqual({ settings: { aliases: [] }, vocName: '홍길동', effective: ['홍길동'], source: 'voc' });
    expect(meInfoOf({ name: '홍길동', aliases: ['길동'] }, undefined)).toEqual({
      settings: { name: '홍길동', aliases: ['길동'] },
      effective: ['홍길동', '길동'],
      source: 'settings',
    });
  });
});

describe('앱 설정 — me(2.9단계 §9)', () => {
  it('checkMeSettings: 다듬고 같은 표기는 하나로(이름과 같은 표기도 뺀다)', () => {
    expect(checkMeSettings({ name: ' 홍길동 ', aliases: [' 길동', '길 동', 'HONG', 'hong', '홍 길동'] })).toEqual({
      name: '홍길동',
      aliases: ['길동', 'HONG'],
    });
    expect(checkMeSettings({ name: '  ', aliases: [] })).toEqual({ aliases: [] });
    expect(checkMeSettings({ aliases: [] })).toEqual({ aliases: [] });
  });

  it('checkMeSettings: 틀리면 거부', () => {
    expect(() => checkMeSettings(null)).toThrow();
    expect(() => checkMeSettings([])).toThrow();
    expect(() => checkMeSettings({ name: 3, aliases: [] })).toThrow(/name/);
    expect(() => checkMeSettings({ name: '홍[길동]', aliases: [] })).toThrow(/이름/);
    expect(() => checkMeSettings({ name: '홍길동', aliases: 'a' })).toThrow(/aliases/);
    expect(() => checkMeSettings({ aliases: [''] })).toThrow(/다른 표기/);
    expect(() => checkMeSettings({ aliases: ['a,b'] })).toThrow(/다른 표기/);
    expect(() => checkMeSettings({ aliases: [1] })).toThrow(/aliases/);
    expect(() => checkMeSettings({ aliases: Array.from({ length: 11 }, (_, i) => `n${i}`) })).toThrow(/10개/);
    expect(checkMeSettings({ aliases: Array.from({ length: 10 }, (_, i) => `n${i}`) }).aliases).toHaveLength(10);
  });

  it('파일: 사람이 저장할 때만 생기고, 틀린 me 는 그것만 버린다', () => {
    const dir = tempDir();
    const store = new AppSettingsStore(dir);
    expect(store.get()).toEqual({});
    expect(fs.existsSync(path.join(dir, APP_SETTINGS_FILE))).toBe(false);
    expect(store.update({ setupSeen: true, me: { name: '홍길동', aliases: ['길동'] } })).toEqual({
      setupSeen: true,
      me: { name: '홍길동', aliases: ['길동'] },
    });
    expect(new AppSettingsStore(dir).get().me).toEqual({ name: '홍길동', aliases: ['길동'] });
    expect(parseAppSettings({ setupSeen: true, me: { name: '홍[', aliases: [] } })).toEqual({ setupSeen: true });
    expect(parseAppSettings({ me: 'x' })).toEqual({});
  });
});

describe('설정 › 나 화면 상태(renderer/lib/me)', () => {
  const info = { settings: { name: '홍길동', aliases: ['길동'] }, vocName: '홍길동', effective: ['홍길동', '길동'], source: 'settings' };

  it('normalizeMe: 모양이 틀리면 null', () => {
    expect(M.normalizeMe(info)).toEqual(info);
    expect(M.normalizeMe({ ...info, vocName: ' ' })).toEqual({ ...info, vocName: undefined });
    expect(M.normalizeMe({ ...info, source: 'mail' })).toBeNull();
    expect(M.normalizeMe({ ...info, settings: { aliases: 'x' } })).toBeNull();
    expect(M.normalizeMe({ ...info, effective: [1] })).toBeNull();
    expect(M.normalizeMe(null)).toBeNull();
  });

  it('입력 칸 ↔ 설정, 바뀜·문제', () => {
    const settings = { name: '홍길동', aliases: ['길동', 'hong'] };
    const draft = M.meDraftOf(settings);
    expect(draft).toEqual({ name: '홍길동', aliases: '길동, hong' });
    expect(M.meDraftChanged(settings, draft)).toBe(false);
    expect(M.meDraftChanged(settings, { name: ' 홍길동 ', aliases: '길동,hong ,' })).toBe(false);
    expect(M.meDraftChanged(settings, { name: '홍길동', aliases: '길동' })).toBe(true);
    expect(M.meSettingsOf({ name: '  ', aliases: ' a , , b ' })).toEqual({ aliases: ['a', 'b'] });
    expect(M.meDraftProblem({ name: '', aliases: '' })).toBeNull();
    expect(M.meDraftProblem({ name: '홍[', aliases: '' })).toMatch(/이름/);
    expect(M.meDraftProblem({ name: '', aliases: 'a]' })).toMatch(/다른 표기/);
    expect(M.meDraftProblem({ name: '', aliases: Array.from({ length: 11 }, (_, i) => `n${i}`).join(',') })).toMatch(/10개/);
    expect(splitAliases('a, ,b')).toEqual(['a', 'b']);
  });

  it('VOC 이름 안내', () => {
    expect(M.vocNameNote('홍길동')).toBe('VOC 로그인 이름: 홍길동(비워 두면 이것)');
    expect(M.vocNameNote(undefined)).toBe('VOC 에 로그인하지 않아 기본 이름이 없습니다');
  });

  it('미리보기: 입력하는 동안 내 것을 센다(§12-1 팀 시험 사본의 담당 모양)', () => {
    // 열린 팀 할 일 6건의 담당: 디스크(홍길동) · 점검표(길동) · 방화벽(김담당) · 회의실(미배정) · 라이선스(" 홍 길동 ") · UPS(홍길동, 박담당)
    const owners = [['홍길동'], ['길동'], ['김담당'], [], ['홍 길동'], ['홍길동', '박담당']];
    expect(M.mePreview({ name: '홍길동', aliases: '' }, undefined, owners, true)).toMatchObject({ mine: 3, total: 6 });
    expect(M.mePreview({ name: '홍길동', aliases: '길동' }, undefined, owners, true)).toMatchObject({ mine: 4, total: 6 });
    // 이름을 비우면 VOC 이름
    expect(M.mePreview({ name: '', aliases: '' }, '홍길동', owners, true)).toMatchObject({ mine: 3, names: ['홍길동'] });
    expect(M.mePreview({ name: '', aliases: '' }, undefined, owners, true)).toMatchObject({ mine: 0, names: [] });
    expect(M.mePreview({ name: '홍길동', aliases: '' }, undefined, owners, false).note).toBe('팀 위키 동기화가 꺼져 있습니다');
    expect(M.mePreview({ name: '홍길동', aliases: '' }, undefined, null, true).note).toBeTruthy();
  });
});

const OK: SetupStatus = {
  wiki: { ok: true, path: 'C:\\W', source: 'settings' },
  claude: { ok: true, path: 'C:\\claude.exe', source: 'path' },
  mail: { ok: true },
  seen: true,
};
const board = (over: Partial<VocBoard>): VocBoard => ({
  state: 'ok',
  lanes: [],
  totals: { team: 0, unassigned: 0, slaExceeded: 0, slaWarning: 0 },
  ...over,
});

describe('내비 — 쓸 수 없는 메뉴(2.9단계 §1)', () => {
  it('모두 있으면 없음', () => {
    expect(S.navAvailability({ status: OK, hasSnapshot: true, board: board({}) })).toEqual({});
    // 점검 전(모름)이면 흐리게 하지 않는다
    expect(S.navAvailability({ status: null, hasSnapshot: false, board: null })).toEqual({});
  });

  it('위키 없음: 할 일·반영 대기', () => {
    const noWiki = { ...OK, wiki: { ...OK.wiki, ok: false } };
    expect(S.navAvailability({ status: noWiki, hasSnapshot: false, board: null })).toEqual({
      tasks: '위키 없음',
      queue: '개인 위키가 없어 반영할 수 없습니다',
    });
    // 팀 위키 할 일로 스냅샷이 있으면 할 일은 쓸 수 있다
    expect(S.navAvailability({ status: noWiki, hasSnapshot: true, personalMissing: true, board: null })).toEqual({
      queue: '개인 위키가 없어 반영할 수 없습니다',
    });
  });

  it('claude 없음 → 반영 대기, VOC 설정 필요 → VOC', () => {
    const noClaude = { ...OK, claude: { ...OK.claude, ok: false } };
    expect(S.navAvailability({ status: noClaude, hasSnapshot: true, board: board({ state: 'notConfigured', message: 'voc-cli 없음' }) })).toEqual({
      queue: 'Claude Code 없음',
      voc: 'voc-cli 없음',
    });
    // 로그인 필요는 흐리게 하지 않는다(글자로만)
    expect(S.navAvailability({ status: OK, hasSnapshot: true, board: board({ state: 'login' }) })).toEqual({});
  });

  it('문장은 「설정 › 점검」을 가리킨다', () => {
    expect(S.QUEUE_NO_WIKI).toContain('설정 › 점검');
    expect(S.claudeProblem({ ...OK, claude: { ...OK.claude, ok: false } })).toContain('설정 › 점검');
  });

  it('설정 칸 초점 표시는 서로·다른 화면 표시와 겹치지 않는다', () => {
    const all = [FOCUS_SETUP_VIEW, FOCUS_SETTINGS_ME, FOCUS_SETTINGS_NOTIFY, FOCUS_QUEUE_VIEW, FOCUS_VOC_VIEW];
    expect(new Set(all).size).toBe(all.length);
    expect(FOCUS_SETTINGS_ME).toBe('view:settings:me');
    expect(FOCUS_SETTINGS_NOTIFY).toBe('view:settings:notify');
    expect(FOCUS_SETTINGS_ME.startsWith(`${FOCUS_VOC_VIEW}:`)).toBe(false);
  });
});
