// 할 일 줄에 필드 하나 붙이기(2.6단계 §6 applyLineField) — 단위 시험. 테스트 사본을 임시 폴더에 복사해서만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Task } from '../../src/shared/types';
import { checkboxId, displayTitle } from '../../src/main/wiki/checkbox';
import { splitLines } from '../../src/main/wiki/fsutil';
import { buildSnapshot } from '../../src/main/wiki/snapshot';
import {
  BACKUP_ROOT,
  MAX_WRITE_ATTEMPTS,
  TEMP_SUFFIX,
  applyLineField,
  applyLineFieldWith,
  applyStatus,
  applyWriteback,
  hasLineField,
  lineFieldValue,
  type LineFieldInput,
  type WritebackHooks,
} from '../../src/main/wiki/writeback';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const NOW = new Date(2026, 8, 23, 10, 0, 0);
const STAMP = '20260923T100000';
const TODO = '_private/mgmt/내 할 일.md';
const ENTITY = 'wiki/entities/한결케미칼.md';
const OLD_BACKUP = '20260901T000000';
const NUMBER = 'VOC-2026-0101';

const temps: string[] = [];

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-lf-'));
  temps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function read(root: string, rel: string): string {
  return fs.readFileSync(at(root, rel), 'utf8');
}

function snapshotOf(root: string) {
  return buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
}

/** 스냅샷에서 제목에 needle 이 든 체크박스 할 일 */
function taskOf(root: string, needle: string): Task {
  const hit = snapshotOf(root).tasks.find((t) => t.source === 'checkbox' && t.title.includes(needle));
  if (!hit) throw new Error(`스냅샷에 없음: ${needle}`);
  return hit;
}

/** 메일 할 일(서진화학 EHS 잔여 오류 — 내 할 일.md. 통영공장 줄은 큐레이션 항목이 가져간다) */
function mailTask(root: string): Task {
  const t = taskOf(root, '서진화학 EHS 잔여 오류');
  expect(t.mail).toBeTruthy();
  expect(t.file).toBe(TODO);
  return t;
}

function add(root: string, task: Task, extra: Partial<LineFieldInput> = {}, hooks?: WritebackHooks) {
  const input: LineFieldInput = { wikiRoot: root, today: TODAY, task, key: 'voc', value: NUMBER, now: NOW, ...extra };
  return hooks ? applyLineFieldWith(input, hooks) : applyLineField(input);
}

/** 백업 폴더 목록(이름순) */
function backups(root: string): string[] {
  return fs.readdirSync(at(root, BACKUP_ROOT)).sort();
}

function tempFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith(TEMP_SUFFIX));
}

describe('lineFieldValue', () => {
  it('줄의 [key:: 값] — 앞뒤 공백을 걷는다', () => {
    const line = '- [ ] 일 #내할일 [pri:: 1] [voc:: VOC-2026-0001] [ 담당 :: 김담당 ]';
    expect(lineFieldValue(line, 'voc')).toBe('VOC-2026-0001');
    expect(lineFieldValue(line, 'pri')).toBe('1');
    expect(lineFieldValue(line, '담당')).toBe('김담당');
  });

  it('없으면 undefined, 값이 비면 빈 글자', () => {
    expect(lineFieldValue('- [ ] 일 [pri:: 1]', 'voc')).toBeUndefined();
    expect(lineFieldValue('- [ ] 일 [voc::]', 'voc')).toBe('');
    expect(lineFieldValue('- [ ] 일', '')).toBeUndefined();
  });

  it('hasLineField: 값이 빈·닫히지 않은 필드도 있는 것(applyLineField 가 거부하는 판정 — VOC 등록 전 검사가 같이 쓴다)', () => {
    for (const line of ['- [ ] 일 [voc:: VOC-2026-0001]', '- [ ] 일 [voc:: ]', '- [ ] 일 [voc::]', '- [ ] 일 [voc:: VOC-2026-', '- [ ] 일 [ voc :: ']) {
      expect(hasLineField(line, 'voc')).toBe(true);
    }
    expect(hasLineField('- [ ] 일 [vocx:: A] [myvoc:: B]', 'voc')).toBe(false);
    expect(hasLineField('- [ ] 일', 'voc')).toBe(false);
    expect(hasLineField('- [ ] 일 [voc:: ]', '')).toBe(false);
  });
});

describe('applyLineField — 붙이기', () => {
  it('할 일 줄 끝에 [voc:: 번호] 를 붙이고 다른 줄·ID·제목은 그대로, 백업을 남긴다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const before = read(root, TODO);

    const res = add(root, task);
    expect(res.files).toEqual([TODO]);
    expect(res.warnings).toEqual([]);
    expect(res.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);

    const beforeLines = splitLines(before);
    const afterLines = splitLines(read(root, TODO));
    const idx = (task.line as number) - 1;
    expect(afterLines[idx]).toBe(`${task.rawLine} [voc:: ${NUMBER}]`);
    expect(afterLines.filter((_, i) => i !== idx)).toEqual(beforeLines.filter((_, i) => i !== idx));

    // 백업은 고치기 전 그대로
    expect(fs.readFileSync(at(root, `${res.backupDir}/${TODO}`), 'utf8')).toBe(before);
    expect(backups(root)).toEqual([OLD_BACKUP, STAMP]);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);

    // 새로 읽어도 같은 할 일(ID·제목·메일)이고 줄에 번호가 있다
    const again = snapshotOf(root).tasks.find((t) => t.id === task.id);
    expect(again).toBeDefined();
    expect(again?.title).toBe(task.title);
    expect(again?.mail).toBe(task.mail);
    expect(lineFieldValue(again?.rawLine ?? '', 'voc')).toBe(NUMBER);
    expect(checkboxId(TODO, afterLines[idx])).toBe(task.id);
    expect(displayTitle(afterLines[idx])).toBe(task.title);
  });

  it('줄 끝의 공백은 걷고 붙인다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const lines = splitLines(read(root, TODO));
    const idx = (task.line as number) - 1;
    lines[idx] = `${lines[idx]}   `;
    fs.writeFileSync(at(root, TODO), lines.join('\n'));
    const fresh = mailTask(root);
    add(root, fresh);
    expect(splitLines(read(root, TODO))[idx]).toBe(`${task.rawLine} [voc:: ${NUMBER}]`);
  });

  it('같은 키가 이미 있으면 바꾸지 않고 실패(파일·백업 그대로)', () => {
    const root = copyFixture();
    const task = mailTask(root);
    add(root, task);
    const after = fs.readFileSync(at(root, TODO));

    // 스냅샷을 새로 읽은 항목으로도, 앞서 받은(번호 없는 줄의) 항목으로도 거부
    expect(() => add(root, mailTask(root), { value: 'VOC-2026-0999', now: new Date(2026, 8, 23, 11, 0, 0) })).toThrow(
      /이미 \[voc:: VOC-2026-0101\] 가 있음/,
    );
    expect(() => add(root, task, { value: 'VOC-2026-0999', now: new Date(2026, 8, 23, 11, 0, 0) })).toThrow(/이미 \[voc:: VOC-2026-0101\] 가 있음/);
    expect(fs.readFileSync(at(root, TODO)).equals(after)).toBe(true);
    expect(backups(root)).toEqual([OLD_BACKUP, STAMP]);
  });

  it('값이 빈 [voc::] 나 닫히지 않은 [voc:: 도 이미 있는 것으로 본다', () => {
    for (const tail of [' [voc::]', ' [voc:: VOC-2026-']) {
      const root = copyFixture();
      const task = mailTask(root);
      const lines = splitLines(read(root, TODO));
      const idx = (task.line as number) - 1;
      lines[idx] = `${lines[idx]}${tail}`;
      fs.writeFileSync(at(root, TODO), lines.join('\n'));
      const before = read(root, TODO);
      expect(() => add(root, task)).toThrow(/이미 \[voc:: .*\] 가 있음/);
      expect(read(root, TODO)).toBe(before);
    }
  });

  it('스냅샷 뒤 위에 줄이 늘어도 같은 줄을 찾는다(원문 그대로인 줄)', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const lines = splitLines(read(root, TODO));
    const idx = (task.line as number) - 1;
    lines.splice(idx - 1, 0, '- [ ] 다른 기기에서 더한 할 일 #내할일');
    fs.writeFileSync(at(root, TODO), lines.join('\n'));

    add(root, task);
    const after = splitLines(read(root, TODO));
    expect(after[idx + 1]).toBe(`${task.rawLine} [voc:: ${NUMBER}]`);
    expect(after[idx - 1]).toBe('- [ ] 다른 기기에서 더한 할 일 #내할일');
  });

  it('줄의 필드가 바뀌었으면(원문이 다르면) 핵심문구 앵커로 찾는다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const lines = splitLines(read(root, TODO));
    const idx = (task.line as number) - 1;
    lines[idx] = lines[idx].replace('[재촉:: 4회]', '[재촉:: 5회]');
    const changed = lines[idx];
    fs.writeFileSync(at(root, TODO), lines.join('\n'));

    add(root, task);
    expect(splitLines(read(root, TODO))[idx]).toBe(`${changed} [voc:: ${NUMBER}]`);
  });

  it('줄을 찾지 못하면 아무것도 쓰지 않는다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const lines = splitLines(read(root, TODO)).filter((_, i) => i !== (task.line as number) - 1);
    fs.writeFileSync(at(root, TODO), lines.join('\n'));
    const before = read(root, TODO);
    expect(() => add(root, task)).toThrow(/할 일 줄을 찾지 못함.*아무것도 쓰지 않았음/);
    expect(read(root, TODO)).toBe(before);
    expect(backups(root)).toEqual([OLD_BACKUP]);
  });

  it('큐레이션 메일 할 일은 스냅샷이 연결한 앵커 줄에 붙인다(ID·연결은 그대로)', () => {
    const root = copyFixture();
    const task = snapshotOf(root).tasks.find((t) => t.source === 'curated' && t.title === '한결케미칼 통영공장 사용량 미반영 회신');
    expect(task?.mail).toBeTruthy();
    expect(task?.file).toBe(TODO);
    const cur = task as Task;
    const before = splitLines(read(root, TODO));
    const idx = (cur.line as number) - 1;

    const res = add(root, cur, { value: 'VOC-2026-0103' });
    expect(res.files).toEqual([TODO]);
    const after = splitLines(read(root, TODO));
    expect(after[idx]).toBe(`${cur.rawLine} [voc:: VOC-2026-0103]`);
    expect(after.filter((_, i) => i !== idx)).toEqual(before.filter((_, i) => i !== idx));

    const again = snapshotOf(root).tasks.find((t) => t.id === cur.id);
    expect(again?.source).toBe('curated');
    expect(again?.line).toBe(cur.line);
    expect(lineFieldValue(again?.rawLine ?? '', 'voc')).toBe('VOC-2026-0103');
    // 두 번째는 같은 키로 거부
    expect(() => add(root, again as Task, { value: 'VOC-2026-0104' })).toThrow(/이미 \[voc:: VOC-2026-0103\] 가 있음/);
  });

  it('큐레이션 할 일의 줄이 바뀌었으면 items.json 앵커 문구로 찾는다', () => {
    const root = copyFixture();
    const cur = snapshotOf(root).tasks.find((t) => t.source === 'curated' && t.title === '한결케미칼 통영공장 사용량 미반영 회신') as Task;
    const lines = splitLines(read(root, TODO));
    const idx = (cur.line as number) - 1;
    lines[idx] = lines[idx].replace('[재촉:: 2회]', '[재촉:: 3회]');
    const changed = lines[idx];
    lines.splice(idx - 1, 0, '- [ ] 다른 기기에서 더한 할 일 #내할일');
    fs.writeFileSync(at(root, TODO), lines.join('\n'));

    add(root, cur);
    expect(splitLines(read(root, TODO))[idx + 1]).toBe(`${changed} [voc:: ${NUMBER}]`);
  });

  it('다른 파일(업체 페이지)의 체크박스 할 일에도 붙인다', () => {
    const root = copyFixture();
    const task = taskOf(root, '담당자 교체 공지');
    expect(task.file).toBe(ENTITY);
    const res = add(root, task, { value: 'VOC-2026-0102' });
    expect(res.files).toEqual([ENTITY]);
    expect(read(root, ENTITY)).toContain('- [ ] 담당자 교체 공지 확인 #내할일 [pri:: 3] [voc:: VOC-2026-0102]\n');
  });
});

describe('applyLineField — 쓰기 전 재확인·줄바꿈', () => {
  it('재확인에서 파일이 바뀌었으면 다시 읽고 처음부터(남의 변경을 덮어쓰지 않는다)', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const other = '- [ ] 재확인 사이에 더한 할 일 #내할일';
    const res = add(root, task, {}, {
      beforeRecheck: ({ attempt, files }) => {
        expect(files).toEqual([TODO]);
        if (attempt === 1) fs.appendFileSync(at(root, TODO), `\n${other}`);
      },
    });
    expect(res.warnings).toEqual([`저장 직전에 파일이 바뀌어 다시 읽음(1번째): ${TODO}`]);
    const text = read(root, TODO);
    expect(text).toContain(`${task.rawLine} [voc:: ${NUMBER}]\n`);
    expect(text.endsWith(`\n${other}`)).toBe(true);
    // 백업은 실제로 덮어쓴 판(남의 변경이 든 것)
    expect(read(root, `${res.backupDir}/${TODO}`).endsWith(`\n${other}`)).toBe(true);
  });

  it('이름 바꾸기 직전에 바뀌어도(잠금이 풀리기를 기다리는 사이) 다시 읽는다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const other = '- [ ] 잠금 사이에 더한 할 일 #내할일';
    let calls = 0;
    const res = add(root, task, {}, {
      sleep: () => undefined,
      rename: (from, to) => {
        calls++;
        if (calls === 1) {
          fs.appendFileSync(to, `\n${other}`);
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        fs.renameSync(from, to);
      },
    });
    expect(calls).toBe(2);
    expect(res.warnings).toEqual([`저장하는 사이에 파일이 바뀌어 다시 읽음(1번째): ${TODO}`]);
    const text = read(root, TODO);
    expect(text).toContain(`${task.rawLine} [voc:: ${NUMBER}]\n`);
    expect(text.endsWith(`\n${other}`)).toBe(true);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
  });

  it('계속 바뀌면 실패하고 백업·임시 파일을 남기지 않는다', () => {
    const root = copyFixture();
    const task = mailTask(root);
    let n = 0;
    expect(() =>
      add(root, task, {}, {
        beforeRecheck: () => {
          fs.appendFileSync(at(root, TODO), `\n- [ ] 계속 더하는 할 일 ${++n}`);
        },
      }),
    ).toThrow(new RegExp(`계속 바뀌고 있어 저장하지 못함\\(${MAX_WRITE_ATTEMPTS}번 다시 읽음\\) — 아무것도 쓰지 않았음`));
    expect(n).toBe(MAX_WRITE_ATTEMPTS);
    expect(read(root, TODO)).not.toContain('[voc::');
    expect(backups(root)).toEqual([OLD_BACKUP]);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
  });

  it('쓸 수 없는 파일(계속 잠김)이면 실패하고 원본 그대로', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const before = read(root, TODO);
    expect(() =>
      add(root, task, {}, {
        sleep: () => undefined,
        rename: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        },
      }),
    ).toThrow(/파일을 쓰지 못함\(EPERM\).*아무것도 쓰지 않았음/);
    expect(read(root, TODO)).toBe(before);
    expect(backups(root)).toEqual([OLD_BACKUP]);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
  });

  it('CRLF·BOM 파일은 CRLF·BOM 그대로(그 줄만 바뀐다)', () => {
    const root = copyFixture();
    const lf = read(root, TODO);
    const crlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')]);
    fs.writeFileSync(at(root, TODO), crlf);
    const task = mailTask(root);

    add(root, task);
    const raw = fs.readFileSync(at(root, TODO));
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = raw.subarray(3).toString('utf8');
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false); // LF 만 있는 줄바꿈 없음
    const expected = lf.replace(`${task.rawLine}\n`, `${task.rawLine} [voc:: ${NUMBER}]\n`).replace(/\n/g, '\r\n');
    expect(text).toBe(expected);
  });
});

describe('applyLineField — 붙인 뒤 저장(sync_todo apply_status)', () => {
  it('apply_status 는 [voc::] 를 그대로 둔다', () => {
    const line = `- [ ] 🔴 일 #내할일 [pri:: 1] [mail:: raw/mail/x.md] [voc:: ${NUMBER}]`;
    const done = applyStatus(line, 'done', undefined, TODAY);
    expect(done).toBe(`- [x] 🔴 일 #내할일 [pri:: 1] [mail:: raw/mail/x.md] [voc:: ${NUMBER}] [done:: ${TODAY}]`);
    expect(lineFieldValue(applyStatus(line, 'wip', undefined, TODAY), 'voc')).toBe(NUMBER);
    expect(lineFieldValue(applyStatus(line, 'notmine', '박담당', TODAY), 'voc')).toBe(NUMBER);
    expect(applyStatus(done, 'open', undefined, TODAY)).toBe(line);
  });

  it('번호를 붙인 할 일을 완료로 저장해도 필드가 남는다(applyWriteback)', () => {
    const root = copyFixture();
    add(root, mailTask(root));
    const task = mailTask(root); // 새로 읽은 항목(줄에 번호가 있다)
    const res = applyWriteback({ wikiRoot: root, today: TODAY, task, status: 'done', now: new Date(2026, 8, 23, 12, 0, 0) });
    expect(res.files).toEqual([TODO]);
    const line = splitLines(read(root, TODO))[(task.line as number) - 1];
    expect(line.startsWith('- [x] ')).toBe(true);
    expect(lineFieldValue(line, 'voc')).toBe(NUMBER);
    expect(lineFieldValue(line, 'done')).toBe(TODAY);
  });
});

describe('applyLineField — 거부', () => {
  it('위키 줄이 없는 할 일(VOC·연결된 줄이 없는 큐레이션)은 거부', () => {
    const root = copyFixture();
    const task = mailTask(root);
    expect(() => add(root, { ...task, source: 'voc' })).toThrow(/체크박스 줄이 있는 할 일에만/);
    const { rawLine: _raw, ...noLine } = task;
    expect(() => add(root, noLine as Task)).toThrow(/파일·줄이 없음/);
    const curatedNoLine = snapshotOf(root).tasks.find((t) => t.source === 'curated' && t.title === 'LDAR 견적서 회신');
    expect(curatedNoLine?.rawLine).toBeUndefined();
    expect(() => add(root, curatedNoLine as Task)).toThrow(/연결된 체크박스 줄이 없는 할 일/);
    expect(backups(root)).toEqual([OLD_BACKUP]);
  });

  it('값·키 형식이 틀리면 거부(파일 그대로)', () => {
    const root = copyFixture();
    const task = mailTask(root);
    const before = read(root, TODO);
    expect(() => add(root, task, { value: 'VOC-1] [done:: x' })).toThrow(/대괄호/);
    expect(() => add(root, task, { value: 'VOC-1\n- [ ] 새 줄' })).toThrow(/줄바꿈/);
    expect(() => add(root, task, { value: '   ' })).toThrow(/비어 있음/);
    expect(() => add(root, task, { value: 'V'.repeat(201) })).toThrow(/너무 김/);
    expect(() => add(root, task, { key: 'vo c' })).toThrow(/필드 이름 형식/);
    expect(() => add(root, task, { key: 'voc]' })).toThrow(/필드 이름 형식/);
    expect(() => add(root, task, { today: '2026-9-23' })).toThrow(/오늘 날짜/);
    expect(read(root, TODO)).toBe(before);
    expect(backups(root)).toEqual([OLD_BACKUP]);
  });

  it('쓰기 허용 목록 밖(raw/·위키 밖)이면 거부', () => {
    const root = copyFixture();
    const task = mailTask(root);
    expect(() => add(root, { ...task, file: '../밖.md' })).toThrow(/쓰기 허용 목록 밖/);
    expect(() => add(root, { ...task, file: task.mail as string })).toThrow(/쓰기 허용 목록 밖/);
    expect(() => add(root, { ...task, file: '_private/mgmt/없는 파일.md' })).toThrow(/할 일 파일이 없음/);
  });
});
