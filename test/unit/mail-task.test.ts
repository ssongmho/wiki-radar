// 메일함 [할 일로](docs/stage2.10-contract.md §7-3) — open_loops cmd_add 와 같은 줄, 절 끝에 넣기, 안전장치.
// 테스트 사본(test/fixtures/wiki)의 내 할 일.md 를 임시 폴더에 복사해 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIL_TASK_FILE,
  MAIL_TASK_NO_SECTION,
  appendTaskLine,
  findExistingMailTask,
  insertIntoSection,
  mailTaskLine,
} from '../../src/main/wiki/mailTask';
import { rmrf } from './mailFixtures';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'wiki', '_private', 'mgmt', '내 할 일.md');
const MAIL = 'raw/mail/대륙물산/2026/2026-09-20_1000_박담당_[긴급] 자재 문의_d1d2d3.md';
const NOW = new Date('2026-09-23T10:00:00+09:00');

const roots: string[] = [];
function wikiWith(text: string | Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailtask-'));
  roots.push(root);
  const abs = path.join(root, ...MAIL_TASK_FILE.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return root;
}
afterEach(() => {
  while (roots.length) rmrf(roots.pop() as string);
});
const read = (root: string): string => fs.readFileSync(path.join(root, ...MAIL_TASK_FILE.split('/')), 'utf8');

const INPUT = { title: '자재 문의 회신', pri: 2, due: '2026-10-01', mail: MAIL, thread: '긴급 자재 문의', opened: '2026-09-20' };
const GOLDEN =
  '- [ ] 자재 문의 회신 #내할일 [pri:: 2] [due:: 2026-10-01] ' +
  `[mail:: ${MAIL}] [thread:: 긴급 자재 문의] [opened:: 2026-09-20]`;

describe('mailTaskLine', () => {
  it('open_loops cmd_add 와 같은 줄(골든)', () => {
    expect(mailTaskLine(INPUT)).toBe(GOLDEN);
    expect(mailTaskLine({ title: ' 제목 ', mail: MAIL, thread: '', opened: '2026-09-20' })).toBe(
      `- [ ] 제목 #내할일 [mail:: ${MAIL}] [opened:: 2026-09-20]`,
    );
  });
});

describe('insertIntoSection', () => {
  it('절 끝(다음 ## 앞, 빈 줄 앞)', () => {
    const lines = ['# x', '', '## 메일 회신 대기 (브리핑 자동 적재)', '', '- [ ] a', '- [ ] b', '', '## 다음', 'z'];
    expect(insertIntoSection(lines, 'NEW')).toEqual(['# x', '', '## 메일 회신 대기 (브리핑 자동 적재)', '', '- [ ] a', '- [ ] b', 'NEW', '', '## 다음', 'z']);
    // 파일 끝 절
    expect(insertIntoSection(['## 메일 회신 대기 (브리핑 자동 적재)', '- [ ] a', ''], 'NEW')).toEqual(['## 메일 회신 대기 (브리핑 자동 적재)', '- [ ] a', 'NEW', '']);
    // 빈 절
    expect(insertIntoSection(['## 메일 회신 대기 (브리핑 자동 적재)', '## 다음'], 'NEW')).toEqual([
      '## 메일 회신 대기 (브리핑 자동 적재)',
      '',
      'NEW',
      '## 다음',
    ]);
    expect(() => insertIntoSection(['# 없음'], 'NEW')).toThrow(MAIL_TASK_NO_SECTION);
  });
});

describe('findExistingMailTask', () => {
  it('같은 mail·thread 줄([x] 포함), 흔한 제목 키는 경로로만', () => {
    const lines = ['- [x] 끝난 일 #내할일 [mail:: raw/mail/a/2026/x.md] [thread:: 같은 스레드 키]', '- [ ] 문의 건 [thread:: 문의]', '본문 [mail:: raw/mail/b/2026/y.md]'];
    expect(findExistingMailTask(lines, 'raw/mail/a/2026/x.md', '')).toBe(1);
    expect(findExistingMailTask(lines, 'raw/mail/z/2026/z.md', '같은 스레드 키')).toBe(1);
    expect(findExistingMailTask(lines, 'raw/mail/z/2026/z.md', '문의')).toBe(0);
    // 체크박스 줄이 아니면 보지 않는다
    expect(findExistingMailTask(lines, 'raw/mail/b/2026/y.md', '')).toBe(0);
  });
});

describe('appendTaskLine', () => {
  it('테스트 사본: 절 끝에 골든 줄 · 백업 · 다른 줄은 그대로', () => {
    const before = fs.readFileSync(FIXTURE, 'utf8');
    const root = wikiWith(before);
    const r = appendTaskLine({ ...INPUT, wikiRoot: root, now: NOW });
    expect(r.line).toBe(GOLDEN);
    expect(r.files).toEqual([MAIL_TASK_FILE]);
    const after = read(root);
    const lines = after.split('\n');
    const idx = lines.indexOf(GOLDEN);
    expect(idx).toBeGreaterThan(0);
    expect(lines[idx - 1]).toContain('[mail:: raw/mail/경영지원/2026/');
    expect(lines[idx + 1]).toBe('');
    expect(lines[idx + 2]).toBe('## 완료 로그 (아티팩트 동기화)');
    expect(after.replace(`${GOLDEN}\n`, '')).toBe(before);
    expect(r.backupDir).toMatch(/^_todo-sync\/backup\/\d{8}T\d{6}$/);
    expect(fs.readFileSync(path.join(root, ...(r.backupDir as string).split('/'), ...MAIL_TASK_FILE.split('/')), 'utf8')).toBe(before);
  });

  it('CRLF·BOM 보존', () => {
    const text = '﻿# 내 할 일\r\n\r\n## 메일 회신 대기 (브리핑 자동 적재)\r\n\r\n- [ ] a\r\n\r\n## 끝\r\n';
    const root = wikiWith(Buffer.from(text, 'utf8'));
    appendTaskLine({ ...INPUT, wikiRoot: root, now: NOW });
    const raw = fs.readFileSync(path.join(root, ...MAIL_TASK_FILE.split('/')));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.toString('utf8').slice(1)).toBe(`# 내 할 일\r\n\r\n## 메일 회신 대기 (브리핑 자동 적재)\r\n\r\n- [ ] a\r\n${GOLDEN}\r\n\r\n## 끝\r\n`);
  });

  it('같은 mail·thread 줄이 있으면 거부([x] 포함) — 파일 그대로', () => {
    const text = `## 메일 회신 대기 (브리핑 자동 적재)\n\n- [x] 끝 #내할일 [mail:: ${MAIL}]\n`;
    const root = wikiWith(text);
    expect(() => appendTaskLine({ ...INPUT, wikiRoot: root, now: NOW })).toThrow('이미 할 일이 있습니다');
    expect(read(root)).toBe(text);
    const byThread = wikiWith('## 메일 회신 대기 (브리핑 자동 적재)\n\n- [ ] 다른 줄 [thread:: 긴급 자재 문의]\n');
    expect(() => appendTaskLine({ ...INPUT, wikiRoot: byThread, now: NOW })).toThrow('이미 할 일이 있습니다');
    expect(fs.existsSync(path.join(root, '_todo-sync'))).toBe(false);
  });

  it('절이 없으면 거부(절을 만들지 않는다)', () => {
    const root = wikiWith('# 내 할 일\n\n- [ ] a\n');
    expect(() => appendTaskLine({ ...INPUT, wikiRoot: root, now: NOW })).toThrow(MAIL_TASK_NO_SECTION);
    expect(read(root)).toBe('# 내 할 일\n\n- [ ] a\n');
  });

  it('파일이 없으면 거부', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mailtask-'));
    roots.push(root);
    expect(() => appendTaskLine({ ...INPUT, wikiRoot: root, now: NOW })).toThrow('파일이 없음');
  });

  it('쓰기 직전 파일이 바뀌면 다시 읽는다(mtime 재확인)', () => {
    const root = wikiWith('## 메일 회신 대기 (브리핑 자동 적재)\n\n- [ ] a\n');
    const abs = path.join(root, ...MAIL_TASK_FILE.split('/'));
    let touched = false;
    const r = appendTaskLine(
      { ...INPUT, wikiRoot: root, now: NOW },
      {
        beforeRecheck: () => {
          if (touched) return;
          touched = true;
          fs.writeFileSync(abs, '## 메일 회신 대기 (브리핑 자동 적재)\n\n- [ ] a\n- [ ] 그사이 들어온 줄\n');
        },
      },
    );
    expect(r.warnings.join()).toContain('다시 읽음');
    expect(read(root)).toBe(`## 메일 회신 대기 (브리핑 자동 적재)\n\n- [ ] a\n- [ ] 그사이 들어온 줄\n${GOLDEN}\n`);
  });
});
