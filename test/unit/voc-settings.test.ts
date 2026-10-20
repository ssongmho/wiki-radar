// VOC 설정(voc-settings.json)·쓰기 기록(voc-actions.json) — 명세 §4·§7. 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOC_SETTINGS,
  VOC_ACTIONS_FILE,
  VOC_ACTIONS_LIMIT,
  VOC_SETTINGS_FILE,
  VocActionLog,
  VocSettingsStore,
  validateVocSettings,
  type VocActionRecord,
} from '../../src/main/voc/settings';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-vocsettings-'));
  temps.push(dir);
  return dir;
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

const JAR = 'C:\\ij-work\\voc-platform\\voc-cli\\build\\libs\\voc-cli-1.2.0.jar';

describe('validateVocSettings', () => {
  it('빈 객체는 기본값', () => {
    expect(validateVocSettings({})).toEqual({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10 });
    expect(DEFAULT_VOC_SETTINGS).toEqual({ memberIds: [], systems: [], showAllUnassigned: false, pollMinutes: 10 });
  });

  it('기본값 객체는 고칠 수 없다', () => {
    expect(Object.isFrozen(DEFAULT_VOC_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VOC_SETTINGS.memberIds)).toBe(true);
  });

  it('알려진 필드만 남기고, 겹친 팀원·시스템은 순서를 지키며 뺀다', () => {
    const s = validateVocSettings({
      memberIds: [103, 101, 103, 102],
      myId: 101,
      systems: [' SYS0101 ', 'SYS0102', 'SYS0101'],
      showAllUnassigned: true,
      pollMinutes: 15,
      jarPath: `  "${JAR}"  `,
      extra: '버림',
    });
    expect(s).toEqual({
      memberIds: [103, 101, 102],
      myId: 101,
      systems: ['SYS0101', 'SYS0102'],
      showAllUnassigned: true,
      pollMinutes: 15,
      jarPath: JAR,
    });
  });

  it('null·빈 jarPath·myId 는 없음으로', () => {
    expect(validateVocSettings({ myId: null, jarPath: '' })).toEqual(validateVocSettings({}));
    expect(validateVocSettings({ jarPath: '   ' })).not.toHaveProperty('jarPath');
  });

  it('형식이 틀리면 한국어 오류', () => {
    expect(() => validateVocSettings(null)).toThrow('VOC 설정 형식이 맞지 않습니다');
    expect(() => validateVocSettings([])).toThrow('VOC 설정 형식');
    expect(() => validateVocSettings({ memberIds: ['101'] })).toThrow('팀원 목록 형식');
    expect(() => validateVocSettings({ memberIds: [0] })).toThrow('팀원 목록 형식');
    expect(() => validateVocSettings({ memberIds: [1.5] })).toThrow('팀원 목록 형식');
    expect(() => validateVocSettings({ myId: -1 })).toThrow('나(사용자 id)');
    expect(() => validateVocSettings({ systems: [1] })).toThrow('팀 시스템 목록 형식');
    expect(() => validateVocSettings({ systems: [''] })).toThrow('시스템 코드가 올바르지 않습니다');
    expect(() => validateVocSettings({ systems: ['A\nB'] })).toThrow('시스템 코드가 올바르지 않습니다');
    expect(() => validateVocSettings({ showAllUnassigned: 'yes' })).toThrow('미배정 전체 보기');
  });

  it('팀원 50명·시스템 100개까지', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(validateVocSettings({ memberIds: fifty }).memberIds).toHaveLength(50);
    expect(() => validateVocSettings({ memberIds: [...fifty, 51] })).toThrow('팀원은 50명까지');
    // 겹친 것은 세지 않는다
    expect(validateVocSettings({ memberIds: [...fifty, 1, 2] }).memberIds).toHaveLength(50);
    const hundred = Array.from({ length: 100 }, (_, i) => `SYS${i}`);
    expect(validateVocSettings({ systems: hundred }).systems).toHaveLength(100);
    expect(() => validateVocSettings({ systems: [...hundred, 'SYS999'] })).toThrow('팀 시스템은 100개까지');
  });

  it('받는 주기는 5~60분 정수', () => {
    expect(validateVocSettings({ pollMinutes: 5 }).pollMinutes).toBe(5);
    expect(validateVocSettings({ pollMinutes: 60 }).pollMinutes).toBe(60);
    for (const bad of [4, 61, 7.5, '10', Number.NaN]) {
      expect(() => validateVocSettings({ pollMinutes: bad })).toThrow('받는 주기는 5~60분');
    }
  });

  it('jarPath 는 .jar 로 끝나는 절대경로', () => {
    expect(validateVocSettings({ jarPath: JAR }).jarPath).toBe(JAR);
    expect(() => validateVocSettings({ jarPath: 'voc-cli-1.2.0.jar' })).toThrow('절대경로');
    expect(() => validateVocSettings({ jarPath: 'C:\\tools\\voc-cli.exe' })).toThrow('.jar 파일');
    expect(() => validateVocSettings({ jarPath: 'C:\\tools\\voc\ncli.jar' })).toThrow('jar 위치가 올바르지 않습니다');
    expect(() => validateVocSettings({ jarPath: 5 })).toThrow('jar 위치 형식');
    if (process.platform === 'win32') {
      // 드라이브 없는 '\폴더' 는 절대경로로 보지 않는다
      expect(() => validateVocSettings({ jarPath: '\\tools\\voc-cli.jar' })).toThrow('절대경로');
      expect(validateVocSettings({ jarPath: '\\\\server\\share\\voc-cli.jar' }).jarPath).toBe('\\\\server\\share\\voc-cli.jar');
      expect(validateVocSettings({ jarPath: 'D:/tools/VOC-CLI.JAR' }).jarPath).toBe('D:/tools/VOC-CLI.JAR');
    }
  });

  it('apiUrl(VOC 서버 주소 — 명세 §15)는 http(s)://호스트[:포트] 로 다듬어 남긴다', () => {
    expect(validateVocSettings({ apiUrl: 'https://voc.acme.test:11300' }).apiUrl).toBe('https://voc.acme.test:11300');
    // 앞뒤 공백·끝 / 는 걷고, 호스트는 소문자, 기본 포트는 생략
    expect(validateVocSettings({ apiUrl: '  http://127.0.0.1:18080/  ' }).apiUrl).toBe('http://127.0.0.1:18080');
    expect(validateVocSettings({ apiUrl: 'https://VOC-Test.Example.com:8443//' }).apiUrl).toBe('https://voc-test.example.com:8443');
    expect(validateVocSettings({ apiUrl: 'https://voc-test.example.com:443' }).apiUrl).toBe('https://voc-test.example.com');
    expect(validateVocSettings({ apiUrl: 'http://localhost' }).apiUrl).toBe('http://localhost');
  });

  it('null·빈 apiUrl 은 없음(기본 주소)', () => {
    for (const empty of ['', '   ', null, undefined]) expect(validateVocSettings({ apiUrl: empty })).not.toHaveProperty('apiUrl');
    expect(validateVocSettings({ apiUrl: '' })).toEqual(validateVocSettings({}));
  });

  it('apiUrl 이 http(s) 가 아니거나 경로·쿼리·계정이 있거나, 이 PC 밖 주소가 http 면 한국어 오류', () => {
    const msg = 'VOC 서버 주소는 https://호스트[:포트] 모양이어야 합니다(경로 없이, http 는 이 PC 주소만)';
    for (const bad of [
      'voc.acme.test:11300',
      // 평문 http 는 루프백에만 — 비밀번호·토큰이 네트워크에 평문으로 나가지 않게
      'http://voc.acme.test:11300',
      'http://10.0.0.5:8080',
      'http://127.0.0.1.example.test',
      'ftp://voc.acme.test',
      'file:///C:/voc',
      'javascript:alert(1)',
      'https://voc.acme.test:11300/api/v2',
      'https://voc.acme.test/?x=1',
      'https://voc.acme.test/#frag',
      'https://user:pw@voc.acme.test',
      'https://user@voc.acme.test',
      'https://voc.acme.test:99999',
      `https://${'a'.repeat(200)}.example.com`,
      5,
      true,
      ['https://voc.acme.test'],
    ]) {
      expect(() => validateVocSettings({ apiUrl: bad }), JSON.stringify(bad)).toThrow(msg);
    }
  });

  it('apiUrl 은 다른 필드와 함께 남는다', () => {
    expect(validateVocSettings({ memberIds: [101], pollMinutes: 15, apiUrl: 'http://127.0.0.1:18080', jarPath: JAR, loginId: 'hong' })).toEqual({
      memberIds: [101],
      systems: [],
      showAllUnassigned: false,
      pollMinutes: 15,
      apiUrl: 'http://127.0.0.1:18080',
      jarPath: JAR,
      loginId: 'hong',
    });
  });
});

describe('VocSettingsStore', () => {
  it('파일이 없으면 기본값, 저장하면 파일에 남는다', () => {
    const dir = tempDir();
    const store = new VocSettingsStore(dir);
    expect(store.filePath).toBe(path.join(dir, VOC_SETTINGS_FILE));
    expect(store.get()).toEqual(validateVocSettings({}));
    const saved = store.save({ memberIds: [101, 102], systems: ['SYS0101'], pollMinutes: 20, showAllUnassigned: false });
    expect(saved.memberIds).toEqual([101, 102]);
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8'))).toEqual(saved);
    expect(new VocSettingsStore(dir).get()).toEqual(saved);
    expect(leftovers(dir)).toEqual([]);
  });

  it('get 은 사본을 준다(고쳐도 저장값은 그대로)', () => {
    const store = new VocSettingsStore(tempDir());
    store.save({ memberIds: [101] });
    const a = store.get();
    a.memberIds.push(999);
    expect(store.get().memberIds).toEqual([101]);
  });

  it('틀린 값은 저장하지 않는다', () => {
    const dir = tempDir();
    const store = new VocSettingsStore(dir);
    expect(() => store.save({ pollMinutes: 1 })).toThrow('받는 주기');
    expect(fs.existsSync(store.filePath)).toBe(false);
  });

  it('깨진 파일은 옆으로 옮기고 기본값 + 알림, 저장하면 알림이 사라진다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, VOC_SETTINGS_FILE), '{ 깨짐', 'utf8');
    const warns: string[] = [];
    const store = new VocSettingsStore(dir, (m) => warns.push(m));
    expect(store.get()).toEqual(validateVocSettings({}));
    expect(warns.join('\n')).toContain('깨져 있어 기본값으로 시작합니다');
    expect(warns.join('\n')).toContain('JSON 이 아님');
    expect(store.notice).toContain('기본값');
    expect(fs.readdirSync(dir).some((n) => n.startsWith(`${VOC_SETTINGS_FILE}.broken-`))).toBe(true);
    expect(fs.existsSync(store.filePath)).toBe(false);
    store.save({});
    expect(store.notice).toBeNull();
  });

  it('형식이 틀린 파일(범위 밖 값)도 깨진 파일로 본다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, VOC_SETTINGS_FILE), JSON.stringify({ pollMinutes: 999 }), 'utf8');
    const warns: string[] = [];
    const store = new VocSettingsStore(dir, (m) => warns.push(m));
    expect(store.get().pollMinutes).toBe(10);
    expect(warns.join('\n')).toContain('받는 주기');
  });

  it('읽지 못하면(그 자리에 폴더) 이번에는 기본값을 주고 기억하지 않는다', () => {
    const dir = tempDir();
    const file = path.join(dir, VOC_SETTINGS_FILE);
    fs.mkdirSync(file);
    const warns: string[] = [];
    const store = new VocSettingsStore(dir, (m) => warns.push(m));
    expect(store.get()).toEqual(validateVocSettings({}));
    expect(warns.join('\n')).toContain('읽지 못해 이번에는 기본값');
    // 폴더를 옮기지 않았다(깨진 파일 처리와 다르다)
    expect(fs.statSync(file).isDirectory()).toBe(true);
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ memberIds: [102], pollMinutes: 30 }), 'utf8');
    expect(store.get()).toMatchObject({ memberIds: [102], pollMinutes: 30 });
  });
});

describe('VOC 서버 주소 저장(apiUrl — 명세 §15)', () => {
  it('저장하면 다듬은 주소가 파일에 남고, 다시 읽어도 같다', () => {
    const dir = tempDir();
    const store = new VocSettingsStore(dir);
    const saved = store.save({ memberIds: [101], apiUrl: 'http://127.0.0.1:18080/' });
    expect(saved.apiUrl).toBe('http://127.0.0.1:18080');
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8'))).toMatchObject({ apiUrl: 'http://127.0.0.1:18080' });
    expect(new VocSettingsStore(dir).get().apiUrl).toBe('http://127.0.0.1:18080');
    expect(leftovers(dir)).toEqual([]);
  });

  it('get 은 apiUrl 도 사본으로 준다', () => {
    const store = new VocSettingsStore(tempDir());
    store.save({ apiUrl: 'http://127.0.0.1:18080' });
    const a = store.get();
    a.apiUrl = 'http://127.0.0.1:1';
    expect(store.get().apiUrl).toBe('http://127.0.0.1:18080');
  });

  it('틀린 주소는 저장하지 않고 이전 설정을 지킨다', () => {
    const dir = tempDir();
    const store = new VocSettingsStore(dir);
    store.save({ apiUrl: 'http://127.0.0.1:18080' });
    expect(() => store.save({ apiUrl: 'https://voc.acme.test/api' })).toThrow('VOC 서버 주소는');
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8')).apiUrl).toBe('http://127.0.0.1:18080');
    expect(store.get().apiUrl).toBe('http://127.0.0.1:18080');
  });

  it('주소를 비워 저장하면 기본 주소로 돌아간다(파일에서 빠진다)', () => {
    const store = new VocSettingsStore(tempDir());
    store.save({ apiUrl: 'http://127.0.0.1:18080' });
    expect(store.save({ apiUrl: '' })).not.toHaveProperty('apiUrl');
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8'))).not.toHaveProperty('apiUrl');
  });

  it('파일의 주소가 틀리면 깨진 파일로 본다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, VOC_SETTINGS_FILE), JSON.stringify({ apiUrl: 'ftp://x' }), 'utf8');
    const warns: string[] = [];
    const store = new VocSettingsStore(dir, (m) => warns.push(m));
    expect(store.get()).not.toHaveProperty('apiUrl');
    expect(warns.join('\n')).toContain('VOC 서버 주소');
  });

  it('setLoginId·saveFromDialog 는 저장한 주소를 지킨다(saveFromDialog 는 보낸 주소로 바꾼다)', () => {
    const store = new VocSettingsStore(tempDir());
    store.save({ memberIds: [101], apiUrl: 'http://127.0.0.1:18080' });
    expect(store.setLoginId('hong')).toMatchObject({ apiUrl: 'http://127.0.0.1:18080', loginId: 'hong' });
    expect(store.saveFromDialog({ memberIds: [101], apiUrl: 'http://localhost:9000' })).toMatchObject({ apiUrl: 'http://localhost:9000', loginId: 'hong' });
    expect(store.get().apiUrl).toBe('http://localhost:9000');
  });
});

describe('로그인 아이디 기억(loginId — 명세 §13)', () => {
  it('검사: 영문·숫자·._@- 64자, 비면 없음, 그 밖은 한국어 오류(- ·@ 로 시작하면 voc-cli 가 옵션·@파일로 읽어 받지 않는다)', () => {
    expect(validateVocSettings({ loginId: 'hong' }).loginId).toBe('hong');
    expect(validateVocSettings({ loginId: 'a.b_c@d-e' }).loginId).toBe('a.b_c@d-e');
    expect(validateVocSettings({ loginId: 'x'.repeat(64) }).loginId).toHaveLength(64);
    for (const empty of ['', null, undefined]) expect(validateVocSettings({ loginId: empty })).not.toHaveProperty('loginId');
    for (const bad of [' hong', 'a b', '홍길동', '-u', '@file', 'x'.repeat(65), 'a\nb', 7, true]) {
      expect(() => validateVocSettings({ loginId: bad }), JSON.stringify(bad)).toThrow('로그인 아이디 형식이 맞지 않습니다');
    }
    // 비밀번호 같은 모르는 필드는 남기지 않는다
    expect(validateVocSettings({ loginId: 'hong', password: 'Pw-unit-7f3a9c' })).not.toHaveProperty('password');
  });

  it('setLoginId: 기억·지우기만 하고 다른 설정은 그대로, 같으면 쓰지 않는다', () => {
    const dir = tempDir();
    const store = new VocSettingsStore(dir);
    store.save({ memberIds: [101, 102], pollMinutes: 20 });
    expect(store.setLoginId('hong')).toMatchObject({ loginId: 'hong', memberIds: [101, 102], pollMinutes: 20 });
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8'))).toMatchObject({ loginId: 'hong', memberIds: [101, 102], pollMinutes: 20 });
    // 같은 아이디면 다시 쓰지 않는다(맞춰 둔 옛 수정 시각 그대로)
    fs.utimesSync(store.filePath, new Date(2020, 0, 1), new Date(2020, 0, 1));
    store.setLoginId('hong');
    expect(fs.statSync(store.filePath).mtime.getFullYear()).toBe(2020);
    const cleared = store.setLoginId(undefined);
    expect(cleared).not.toHaveProperty('loginId');
    expect(JSON.parse(fs.readFileSync(store.filePath, 'utf8'))).toEqual({ memberIds: [101, 102], systems: [], showAllUnassigned: false, pollMinutes: 20 });
    expect(() => store.setLoginId('-bad')).toThrow('로그인 아이디 형식');
    expect(leftovers(dir)).toEqual([]);
  });

  it('setLoginId: 설정 파일을 읽지 못했으면(잠김 등) 기본값으로 덮지 않고 던진다', () => {
    const dir = tempDir();
    const file = path.join(dir, VOC_SETTINGS_FILE);
    fs.mkdirSync(file);
    const store = new VocSettingsStore(dir, () => undefined);
    expect(() => store.setLoginId('hong')).toThrow('읽지 못해 아이디를 기억하지 못했습니다');
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('saveFromDialog(설정 대화상자의 [저장]): 보낸 loginId 는 버리고 기억한 아이디를 지킨다', () => {
    const store = new VocSettingsStore(tempDir());
    store.setLoginId('hong');
    expect(store.saveFromDialog({ memberIds: [103], pollMinutes: 30 })).toMatchObject({ memberIds: [103], pollMinutes: 30, loginId: 'hong' });
    expect(store.saveFromDialog({ memberIds: [103], loginId: 'other' }).loginId).toBe('hong');
    store.setLoginId(undefined);
    expect(store.saveFromDialog({ loginId: 'other' })).not.toHaveProperty('loginId');
    expect(() => store.saveFromDialog(null)).toThrow('VOC 설정 형식');
  });
});

function record(id: string, extra: Partial<VocActionRecord> = {}): VocActionRecord {
  return {
    id,
    at: '2026-09-28T01:02:03.000Z',
    kind: 'assign',
    ticketId: 1001,
    number: 'VOC-2026-0101',
    detail: 'VOC-2026-0101 → 김담당(102), new → assigned',
    ok: true,
    ...extra,
  };
}

describe('VocActionLog', () => {
  it('파일이 없으면 빈 기록', () => {
    const log = new VocActionLog(tempDir());
    expect(log.list()).toEqual([]);
    expect(log.has('a')).toBe(false);
  });

  it('더하면 최근 것부터 남고, 같은 id 는 두 번 넣지 못한다', () => {
    const dir = tempDir();
    const log = new VocActionLog(dir);
    log.add(record('a1'));
    log.add(record('a2', { kind: 'reply', ok: false, message: '400 — 거부' }));
    expect(log.list().map((r) => r.id)).toEqual(['a2', 'a1']);
    expect(log.has('a1')).toBe(true);
    expect(() => log.add(record('a1'))).toThrow('이미 실행한 동작');
    const reread = new VocActionLog(dir);
    expect(reread.list()).toEqual(log.list());
    expect(reread.has('a2')).toBe(true);
    expect(() => reread.add(record('a2'))).toThrow('이미 실행한 동작');
    expect(leftovers(dir)).toEqual([]);
  });

  it('알려진 필드만, 빈 선택 필드는 뺀다(등록 기록은 ticketId 없이도)', () => {
    const log = new VocActionLog(tempDir());
    log.add({ id: 'c1', at: '2026-09-28T02:00:00.000Z', kind: 'create', detail: '메일 → VOC', ok: true, number: '', message: '' });
    log.add({ ...record('x'), extra: '버림' } as VocActionRecord);
    const [x, c1] = log.list();
    expect(c1).toEqual({ id: 'c1', at: '2026-09-28T02:00:00.000Z', kind: 'create', detail: '메일 → VOC', ok: true });
    expect(x).not.toHaveProperty('extra');
  });

  it('형식이 틀린 기록은 거부한다', () => {
    const log = new VocActionLog(tempDir());
    expect(() => log.add({ ...record('b'), kind: 'delete' as VocActionRecord['kind'] })).toThrow('형식');
    expect(() => log.add({ ...record('b'), ok: 'yes' as unknown as boolean })).toThrow('형식');
    expect(() => log.add({ ...record(''), id: '' })).toThrow('형식');
    expect(log.list()).toEqual([]);
  });

  it(`최근 ${VOC_ACTIONS_LIMIT}건까지만 남긴다`, () => {
    const dir = tempDir();
    const many = Array.from({ length: VOC_ACTIONS_LIMIT }, (_, i) => record(`old-${i}`));
    fs.writeFileSync(path.join(dir, VOC_ACTIONS_FILE), JSON.stringify(many), 'utf8');
    const log = new VocActionLog(dir);
    log.add(record('new'));
    const list = log.list();
    expect(list).toHaveLength(VOC_ACTIONS_LIMIT);
    expect(list[0].id).toBe('new');
    expect(list.some((r) => r.id === `old-${VOC_ACTIONS_LIMIT - 1}`)).toBe(false);
  });

  it('깨진 파일은 옮기고 빈 기록으로 시작한다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, VOC_ACTIONS_FILE), 'not json', 'utf8');
    const warns: string[] = [];
    const log = new VocActionLog(dir, (m) => warns.push(m));
    expect(log.list()).toEqual([]);
    expect(warns.join('\n')).toContain('VOC 쓰기 기록');
    expect(fs.readdirSync(dir).some((n) => n.startsWith(`${VOC_ACTIONS_FILE}.broken-`))).toBe(true);
  });

  it('읽지 못하면 has 가 예외(두 번 실행했는지 알 수 없다)', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, VOC_ACTIONS_FILE));
    const log = new VocActionLog(dir);
    expect(() => log.has('a')).toThrow('읽지 못했습니다');
  });

  it('저장에 실패해도 이번 실행 중에는 같은 id 를 다시 받지 않는다', () => {
    const dir = tempDir();
    const log = new VocActionLog(dir);
    log.add(record('first'));
    // 파일 자리를 폴더로 바꿔 이름 바꾸기가 실패하게 한다
    const file = path.join(dir, VOC_ACTIONS_FILE);
    fs.rmSync(file);
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, 'keep'), 'x');
    expect(() => log.add(record('second'))).toThrow('저장하지 못했습니다');
    expect(log.has('second')).toBe(true);
    expect(() => log.add(record('second'))).toThrow('이미 실행한 동작');
    expect(log.list().map((r) => r.id)).toEqual(['first']);
    expect(leftovers(dir)).toEqual([]);
  });
});
