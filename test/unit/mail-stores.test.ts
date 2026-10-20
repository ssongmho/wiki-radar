// 발송 기록(sent-mail.json + sent/*.eml)·메일 설정(mail-settings.json) — 명세 §4-3·§5-2.
// 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAIL_SETTINGS,
  MailSettingsStore,
  SENT_DIR,
  SENT_FILE,
  SENT_LIMIT,
  SETTINGS_FILE,
  SentLog,
  validateMailSettings,
} from '../../src/main/mail/stores';
import { compactStamp } from '../../src/main/queue';
import type { SentMailRecord } from '../../src/shared/types';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-mailstore-'));
  temps.push(dir);
  return dir;
}

function rec(id: string, extra: Partial<SentMailRecord> = {}): Omit<SentMailRecord, 'eml'> {
  return {
    id,
    at: '2026-09-28T05:02:03.000Z',
    taskId: 'c:abc',
    taskTitle: '통영공장 인벤토리 확인',
    mail: 'raw/mail/한결케미칼/2026/a.md',
    to: ['한결케미칼 EHS팀 <ehs@hangyeol.example>'],
    cc: [],
    bcc: ['owner@example.com'],
    subject: 'RE: 통영공장 CMS 인벤토리',
    messageId: `<${id}@example.com>`,
    response: '250 OK: queued',
    ...extra,
  };
}

const EML = Buffer.from('From: owner@example.com\r\nSubject: =?UTF-8?B?7ZWc?=\r\n\r\n본문\r\n', 'utf8');

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

describe('SentLog', () => {
  it('파일이 없으면 빈 기록', () => {
    const log = new SentLog(tempDir());
    expect(log.list()).toEqual([]);
    expect(log.has('x')).toBe(false);
    expect(log.lastForTask('c:abc')).toBeUndefined();
  });

  it('eml 을 sent/<시각>_<id 앞 8자>.eml 로 쓰고 기록에 상대경로를 남긴다', () => {
    const dir = tempDir();
    const log = new SentLog(dir);
    const id = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const saved = log.add(rec(id), EML);
    const stamp = compactStamp(new Date('2026-09-28T05:02:03.000Z'));
    expect(saved.eml).toBe(`${SENT_DIR}/${stamp}_1a2b3c4d.eml`);
    expect(fs.readFileSync(path.join(dir, ...(saved.eml as string).split('/')))).toEqual(EML);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, SENT_FILE), 'utf8')) as SentMailRecord[];
    expect(onDisk).toEqual([{ ...rec(id), eml: saved.eml }]);
    expect(leftovers(dir)).toEqual([]);
    expect(log.has(id)).toBe(true);
    // 새로 연 저장소도 같은 기록을 읽는다
    expect(new SentLog(dir).list()).toEqual([saved]);
  });

  it('같은 이름의 eml 이 있으면 -2, -3 을 붙인다(덮어쓰지 않는다)', () => {
    const dir = tempDir();
    const log = new SentLog(dir);
    const a = log.add(rec('same-prefix-1'), Buffer.from('A'));
    const b = log.add(rec('same-prefix-2'), Buffer.from('B'));
    const c = log.add(rec('same-prefix-3'), Buffer.from('C'));
    expect(a.eml).toMatch(/_same-pre\.eml$/);
    expect(b.eml).toMatch(/_same-pre-2\.eml$/);
    expect(c.eml).toMatch(/_same-pre-3\.eml$/);
    expect(fs.readFileSync(path.join(dir, ...(a.eml as string).split('/')), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(dir, ...(b.eml as string).split('/')), 'utf8')).toBe('B');
  });

  it('id 의 파일 이름에 못 쓰는 글자는 걷는다', () => {
    const log = new SentLog(tempDir());
    expect(log.add(rec('../../x:y'), EML).eml).toMatch(new RegExp(`^${SENT_DIR}/\\d{8}T\\d{6}_xy\\.eml$`));
  });

  it('최근 것부터, 같은 id 는 거부한다', () => {
    const log = new SentLog(tempDir());
    log.add(rec('s1', { at: '2026-09-28T01:00:00.000Z' }), EML);
    log.add(rec('s2', { at: '2026-09-28T02:00:00.000Z' }), EML);
    expect(log.list().map((r) => r.id)).toEqual(['s2', 's1']);
    expect(() => log.add(rec('s1'), EML)).toThrow('이미 보낸 메일입니다');
    expect(log.list()).toHaveLength(2);
  });

  it('lastForTask: 그 할 일의 가장 최근 발송(at 기준)', () => {
    const log = new SentLog(tempDir());
    log.add(rec('a', { taskId: 't1', at: '2026-09-28T03:00:00.000Z' }), EML);
    log.add(rec('b', { taskId: 't1', at: '2026-09-28T01:00:00.000Z' }), EML);
    log.add(rec('c', { taskId: 't2', at: '2026-09-28T09:00:00.000Z' }), EML);
    expect(log.lastForTask('t1')?.id).toBe('a');
    expect(log.lastForTask('t2')?.id).toBe('c');
    expect(log.lastForTask('t3')).toBeUndefined();
  });

  it('돌려준 기록을 고쳐도 저장소는 그대로', () => {
    const log = new SentLog(tempDir());
    const saved = log.add(rec('a'), EML);
    saved.to.push('x@y.co');
    log.list()[0].cc.push('z@y.co');
    (log.lastForTask('c:abc') as SentMailRecord).bcc.length = 0;
    expect(log.list()[0]).toMatchObject({ to: rec('a').to, cc: [], bcc: ['owner@example.com'] });
  });

  it(`최근 ${SENT_LIMIT}건만 남긴다(오래된 eml 파일은 지우지 않는다)`, () => {
    const dir = tempDir();
    const seeded = Array.from({ length: SENT_LIMIT }, (_, i) => ({ ...rec(`old-${i}`), eml: `${SENT_DIR}/old-${i}.eml` }));
    fs.writeFileSync(path.join(dir, SENT_FILE), JSON.stringify(seeded));
    const log = new SentLog(dir);
    log.add(rec('new-1'), EML);
    log.add(rec('new-2'), EML);
    const ids = log.list().map((r) => r.id);
    expect(ids).toHaveLength(SENT_LIMIT);
    expect(ids.slice(0, 3)).toEqual(['new-2', 'new-1', 'old-0']);
    expect(ids).not.toContain(`old-${SENT_LIMIT - 1}`);
    expect(fs.readdirSync(path.join(dir, SENT_DIR))).toHaveLength(2);
  });

  it('형식이 틀린 기록은 거부한다', () => {
    const log = new SentLog(tempDir());
    expect(() => log.add({ ...rec('a'), to: 'x' as unknown as string[] }, EML)).toThrow('형식');
    expect(() => log.add({ ...rec('a'), id: '' }, EML)).toThrow('형식');
    expect(log.list()).toEqual([]);
  });

  it('eml 을 쓰지 못하면 경고하고 eml 없이 기록한다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, SENT_DIR), '폴더 자리에 파일');
    const warns: string[] = [];
    const log = new SentLog(dir, (m) => warns.push(m));
    const saved = log.add(rec('a'), EML);
    expect(saved.eml).toBeUndefined();
    expect(log.has('a')).toBe(true);
    expect(warns.join('\n')).toContain('.eml');
  });

  it('깨진 sent-mail.json 은 옆으로 옮기고 빈 기록으로 시작한다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, SENT_FILE), '{ 깨짐');
    const warns: string[] = [];
    const log = new SentLog(dir, (m) => warns.push(m));
    expect(log.list()).toEqual([]);
    expect(warns[0]).toContain('발송 기록');
    expect(fs.readdirSync(dir).some((n) => n.startsWith(`${SENT_FILE}.broken-`))).toBe(true);
    log.add(rec('a'), EML);
    expect(new SentLog(dir).list().map((r) => r.id)).toEqual(['a']);
  });

  it('형식이 틀린 원소만 빼고 읽는다(원래 파일은 복사해 둔다)', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, SENT_FILE), JSON.stringify([{ ...rec('good'), eml: 'sent/x.eml' }, { id: 'bad' }, 42]));
    const warns: string[] = [];
    const log = new SentLog(dir, (m) => warns.push(m));
    expect(log.list().map((r) => r.id)).toEqual(['good']);
    expect(log.list()[0].eml).toBe('sent/x.eml');
    expect(warns[0]).toContain('2건');
  });

  it('읽지 못하는 기록 파일은 덮어쓰지 않도록 예외', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, SENT_FILE));
    const log = new SentLog(dir);
    expect(() => log.has('a')).toThrow('읽지 못했습니다');
    expect(() => log.add(rec('a'), EML)).toThrow('읽지 못했습니다');
  });
});

describe('validateMailSettings', () => {
  it('맞는 값 · 빠진 필드는 기본값 · 알려진 필드만', () => {
    expect(validateMailSettings({ fromName: ' 홍길동 ', signature: '홍길동\r\n한결소프트', bccSelf: false, extra: 1 })).toEqual({
      fromName: '홍길동',
      signature: '홍길동\n한결소프트',
      bccSelf: false,
    });
    expect(validateMailSettings({})).toEqual(DEFAULT_MAIL_SETTINGS);
    expect(DEFAULT_MAIL_SETTINGS).toEqual({ fromName: '', signature: '', bccSelf: true });
  });

  it.each([
    [null, '형식'],
    [[], '형식'],
    ['문자열', '형식'],
    [{ fromName: 1 }, '보내는 이름'],
    [{ signature: [] }, '서명'],
    [{ bccSelf: 'yes' }, '숨은참조'],
    [{ fromName: '가'.repeat(61) }, '60자'],
    [{ fromName: '송"명호' }, '보내는 이름'],
    [{ fromName: '송\n명호' }, '보내는 이름'],
    [{ signature: '가'.repeat(2001) }, '2,000자'],
    [{ signature: '서명\u0007' }, '제어 문자'],
  ])('틀리면 한국어 Error: %j', (value, message) => {
    expect(() => validateMailSettings(value)).toThrow(message);
  });
});

describe('MailSettingsStore', () => {
  it('파일이 없으면 기본값', () => {
    expect(new MailSettingsStore(tempDir()).get()).toEqual({ fromName: '', signature: '', bccSelf: true });
  });

  it('검사 후 원자적으로 저장하고 다시 읽는다', () => {
    const dir = tempDir();
    const store = new MailSettingsStore(dir);
    const saved = store.save({ fromName: '홍길동', signature: '홍길동 드림', bccSelf: false });
    expect(saved).toEqual({ fromName: '홍길동', signature: '홍길동 드림', bccSelf: false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(saved);
    expect(leftovers(dir)).toEqual([]);
    expect(store.get()).toEqual(saved);
    expect(new MailSettingsStore(dir).get()).toEqual(saved);
  });

  it('틀린 값은 저장하지 않는다', () => {
    const dir = tempDir();
    const store = new MailSettingsStore(dir);
    store.save({ fromName: '홍길동', signature: '', bccSelf: true });
    expect(() => store.save({ fromName: '<script>', signature: '', bccSelf: true })).toThrow('보내는 이름');
    expect(store.get().fromName).toBe('홍길동');
    expect(new MailSettingsStore(dir).get().fromName).toBe('홍길동');
  });

  it('돌려준 값을 고쳐도 저장소는 그대로', () => {
    const store = new MailSettingsStore(tempDir());
    store.get().fromName = '바뀜';
    expect(store.get().fromName).toBe('');
  });

  it.each([['{ 깨짐'], ['[]'], ['{"fromName": 3}'], [JSON.stringify({ fromName: '가'.repeat(100) })]])(
    '깨졌거나 규칙에 맞지 않는 파일은 옆으로 옮기고 기본값: %s',
    (text) => {
      const dir = tempDir();
      fs.writeFileSync(path.join(dir, SETTINGS_FILE), text);
      const warns: string[] = [];
      const store = new MailSettingsStore(dir, (m) => warns.push(m));
      expect(store.get()).toEqual(DEFAULT_MAIL_SETTINGS);
      expect(warns[0]).toContain('메일 설정');
      expect(fs.existsSync(path.join(dir, SETTINGS_FILE))).toBe(false);
      expect(fs.readdirSync(dir).some((n) => n.startsWith(`${SETTINGS_FILE}.broken-`))).toBe(true);
      // 기본값으로 되돌린 것을 화면(회신 문맥)에 알린다 — 다시 저장하면 사라진다
      expect(store.notice).toMatch(/깨져 있어 기본값.*\.broken-/);
      store.save({ fromName: '홍길동', signature: '', bccSelf: true });
      expect(store.notice).toBeNull();
    },
  );

  it('파일이 없거나 맞으면 알림이 없다', () => {
    const dir = tempDir();
    const store = new MailSettingsStore(dir);
    store.get();
    expect(store.notice).toBeNull();
    store.save({ fromName: '홍길동', signature: '', bccSelf: false });
    const again = new MailSettingsStore(dir);
    expect(again.get().bccSelf).toBe(false);
    expect(again.notice).toBeNull();
  });

  it('읽지 못하면(잠김·그 자리에 폴더) 기본값으로 속이지 않고 던진다 — 기억하지 않고 다음에 다시 읽는다(명세 §9-3)', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, SETTINGS_FILE));
    const warns: string[] = [];
    const store = new MailSettingsStore(dir, (m) => warns.push(m));
    expect(() => store.get()).toThrow(/메일 설정\(mail-settings\.json\)을 읽지 못했습니다 \(E[A-Z]+\)/);
    expect(warns[0]).toContain('읽지 못했습니다');
    expect(store.notice).toBeNull();
    // 폴더는 옮기지 않는다(깨진 파일로 보지 않는다)
    expect(fs.statSync(path.join(dir, SETTINGS_FILE)).isDirectory()).toBe(true);
    fs.rmdirSync(path.join(dir, SETTINGS_FILE));
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ fromName: '나중', signature: '', bccSelf: true }));
    expect(store.get().fromName).toBe('나중');
  });
});
