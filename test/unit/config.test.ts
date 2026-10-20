// claude 실행 파일 찾기(명세 §2: WIKI_RADAR_CLAUDE → PATH → 기본 위치). 앱이 실제로 쓰는 findClaudePath 를 시험한다.
// 진짜 claude 는 찾기만 하고 부르지 않는다. 임시 폴더의 빈 파일로 흉내 낸다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CLAUDE_PATH, currentToday, findClaudePath, loadConfig, localDateTimeString, parseLocalDateTime } from '../../src/main/config';

const temps: string[] = [];
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-config-'));
  temps.push(dir);
  return dir;
}

/** 빈 claude 실행 파일이 든 폴더 */
function binDir(): { dir: string; exe: string } {
  const dir = tempDir();
  const exe = path.join(dir, EXE);
  fs.writeFileSync(exe, '');
  return { dir, exe };
}

describe('findClaudePath', () => {
  it('WIKI_RADAR_CLAUDE → PATH 의 claude(.exe) → 기본 위치 순', () => {
    const { dir, exe } = binDir();
    const fake = path.join(tempDir(), 'fake.mjs');
    fs.writeFileSync(fake, '');
    expect(findClaudePath({ WIKI_RADAR_CLAUDE: `  ${fake} `, PATH: dir })).toEqual({ path: fake, source: 'env', exists: true });
    const emptyDir = tempDir();
    expect(findClaudePath({ WIKI_RADAR_CLAUDE: '', PATH: [emptyDir, dir].join(path.delimiter) })).toEqual({
      path: exe,
      source: 'path',
      exists: true,
    });
    const none = (): boolean => false;
    expect(findClaudePath({ PATH: emptyDir }, none)).toEqual({ path: DEFAULT_CLAUDE_PATH, source: 'default', exists: false });
    expect(findClaudePath({}, none)).toEqual({ path: DEFAULT_CLAUDE_PATH, source: 'default', exists: false });
  });

  it('환경 변수 값의 따옴표를 벗기고 절대경로로 바꾼다. 파일이 없어도 다른 곳으로 넘어가지 않고 exists:false', () => {
    const { dir } = binDir();
    const missing = path.join(tempDir(), '없는', 'fake.mjs');
    expect(findClaudePath({ WIKI_RADAR_CLAUDE: `"${missing}"`, PATH: dir })).toEqual({ path: missing, source: 'env', exists: false });
    // 상대경로는 지금 작업 폴더 기준 절대경로로(무엇을 실행하는지 로그·오류 문장에 분명히 남게)
    const rel = findClaudePath({ WIKI_RADAR_CLAUDE: 'relbin/fake.mjs' }, () => false);
    expect(path.isAbsolute(rel.path)).toBe(true);
    expect(rel.path).toBe(path.resolve('relbin/fake.mjs'));
    expect(rel.source).toBe('env');
  });

  it('PATH 의 상대경로 조각은 보지 않는다(작업 폴더에 따라 다른 파일을 실행하지 않게)', () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, 'relbin'));
    fs.writeFileSync(path.join(cwd, 'relbin', EXE), '');
    // 상대 조각이 가리키는 파일이 실제로 있어도 건너뛴다
    const seen: string[] = [];
    const exists = (p: string): boolean => {
      seen.push(p);
      return fs.existsSync(path.isAbsolute(p) ? p : path.join(cwd, p));
    };
    const loc = findClaudePath({ PATH: ['relbin', '.', ''].join(path.delimiter) }, exists);
    expect(loc.source).toBe('default');
    expect(loc.path).toBe(DEFAULT_CLAUDE_PATH);
    expect(seen).toEqual([DEFAULT_CLAUDE_PATH]);
  });

  it('PATH 조각의 따옴표를 벗기고, 이름이 Path 여도 읽는다', () => {
    const { dir, exe } = binDir();
    expect(findClaudePath({ Path: `"${dir}"` })).toEqual({ path: exe, source: 'path', exists: true });
  });
});

describe('시험 시계 WIKI_RADAR_NOW(2.9단계 §7-2)', () => {
  it('주면 그 시각에서 실제 시간만큼 흐르고, 오늘도 이 시계에서 나온다(WIKI_RADAR_TODAY 를 이긴다)', () => {
    let real = 1_000_000;
    const cfg = loadConfig({ WIKI_RADAR_NOW: '2026-09-23T14:00', WIKI_RADAR_TODAY: '2026-09-20' }, () => real);
    expect(cfg.clock.fixed).toBe(true);
    expect(localDateTimeString(cfg.clock.now())).toBe('2026-09-23T14:00:00');
    real += 65_000;
    expect(localDateTimeString(cfg.clock.now())).toBe('2026-09-23T14:01:05');
    expect(currentToday(cfg)).toBe('2026-09-23');
    expect(cfg.warnings.some((w) => /날짜가 달라 WIKI_RADAR_NOW 를 씀/.test(w))).toBe(true);
    // setNow 처럼 옮긴다
    expect(cfg.clock.set('2026-09-28T09:00:30')).toBe(true);
    expect(localDateTimeString(cfg.clock.now())).toBe('2026-09-28T09:00:30');
    expect(currentToday(cfg)).toBe('2026-09-28');
    expect(cfg.clock.set('nope')).toBe(false);
  });

  it('잘못된 값은 경고하고 버린다. WIKI_RADAR_TODAY 만 주면 그 날짜 + 실제 시각', () => {
    const bad = loadConfig({ WIKI_RADAR_NOW: '2026-02-30T10:00', WIKI_RADAR_TODAY: '2026-09-23' });
    expect(bad.clock.fixed).toBe(false);
    expect(bad.warnings.some((w) => /WIKI_RADAR_NOW 값이/.test(w))).toBe(true);
    expect(currentToday(bad)).toBe('2026-09-23');
    expect(parseLocalDateTime('2026-09-23T24:00')).toBeNull();
    expect(parseLocalDateTime('2026-09-23T09:05')?.getMinutes()).toBe(5);
    expect(parseLocalDateTime('2026-09-23 09:05')).toBeNull();
  });
});
