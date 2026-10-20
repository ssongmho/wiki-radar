// 처리 결과 즉시 반영(명세 §1) — 단위 시험. 테스트 사본을 임시 폴더에 복사해서만 쓴다(원본 fixture·실제 위키는 건드리지 않는다).
// 파이썬과의 바이트 대조는 writeback.golden.test.ts 가 한다. 여기서는 각 동작의 모양과 레이더가 더 지키는 것(§1-3)을 본다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Task, TaskStatus } from '../../src/shared/types';
import { ANCHOR_LINE_RE, checkboxId, curatedId, displayTitle } from '../../src/main/wiki/checkbox';
import { splitLines } from '../../src/main/wiki/fsutil';
import { buildSnapshot } from '../../src/main/wiki/snapshot';
import {
  BACKUP_ROOT,
  MAX_WRITE_ATTEMPTS,
  PartialWriteError,
  TEMP_SUFFIX,
  WRITE_RETRY_DELAYS_MS,
  WriteRefusedError,
  applyStatus,
  applyWriteback,
  applyWritebackWith,
  backupStamp,
  detectEol,
  syncTitleOf,
  type WritebackHooks,
  type WritebackInput,
  type WritebackResult,
} from '../../src/main/wiki/writeback';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const NOW = new Date(2026, 8, 23, 10, 0, 0);
const STAMP = '20260923T100000';
const TODO = '_private/mgmt/내 할 일.md';
const MEMO = '_private/mgmt/할 일 메모.md';
const WORK = '_private/mgmt/업무 현황 종합 분석.md';
const ENTITY = 'wiki/entities/한결케미칼.md';
const T_TONGYEONG = '한결케미칼 통영공장 사용량 미반영 회신';
const T_RENEW = '한결케미칼 연간 계약 갱신 검토';
const T_SERVER_QUOTE = '대륙물산 서버 교체 견적 방향 결정';
const T_LDAR = 'LDAR 견적서 회신';
const T_STRATEGY = '전략 검토';
const SERVER_QUOTE_SRC = 'wiki/analysis/메일브리핑_2026-09-18.md';

const temps: string[] = [];

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function copyFixture(): string {
  const dir = tempDir('wiki-radar-wb-');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function read(root: string, rel: string): string {
  return fs.readFileSync(at(root, rel), 'utf8');
}

function write(root: string, rel: string, text: string | Buffer): void {
  fs.writeFileSync(at(root, rel), text);
}

/** 볼트 안 모든 파일의 바이트(백업 포함) — 바뀐 것이 없는지 볼 때 */
function allFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(rel ? at(root, rel) : root, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(at(root, r)));
    }
  };
  walk('');
  return out;
}

function snapshotOf(root: string) {
  return buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
}

/** 스냅샷의 큐레이션 항목(없으면 스냅샷과 같은 모양으로 만든다 — 완료·위임 등 목록에 없는 것) */
function curatedTask(root: string, title: string): Task {
  const hit = snapshotOf(root).tasks.find((t) => t.source === 'curated' && t.title === title);
  if (hit) return hit;
  const items = JSON.parse(read(root, '_todo-sync/items.json')).items as { t: string; src?: string; a?: { f: string; m: string }[] }[];
  const it = items.find((x) => x.t === title);
  if (!it) throw new Error(`items.json 에 없음: ${title}`);
  const task: Task = { id: curatedId(title), source: 'curated', title, status: 'open', bucket: 'other' };
  if (it.src) task.src = it.src;
  if (it.a?.length) task.anchors = it.a.map((a) => ({ file: a.f, match: a.m }));
  return task;
}

/** 파일의 체크박스 줄(needle 이 든 첫 줄)로 만든 체크박스 항목 — 스냅샷과 같은 모양 */
function checkboxTask(root: string, file: string, needle: string, nth = 0): Task {
  const lines = splitLines(read(root, file));
  const idxs = lines.map((l, i) => (ANCHOR_LINE_RE.test(l) && l.includes(needle) ? i : -1)).filter((i) => i >= 0);
  const idx = idxs[nth];
  if (idx === undefined) throw new Error(`체크박스 줄이 없음: ${needle}`);
  return {
    id: checkboxId(file, lines[idx]),
    source: 'checkbox',
    title: displayTitle(lines[idx]),
    status: 'open',
    file,
    line: idx + 1,
    rawLine: lines[idx],
    bucket: 'other',
  };
}

function adhoc(title: string, anchors: { file: string; match: string }[], src = ''): Task {
  return { id: curatedId(title), source: 'curated', title, status: 'open', bucket: 'other', src, anchors };
}

function save(
  root: string,
  task: Task,
  status: TaskStatus,
  extra: Partial<WritebackInput> = {},
  hooks?: WritebackHooks,
): WritebackResult {
  const input: WritebackInput = { wikiRoot: root, today: TODAY, task, status, now: NOW, ...extra };
  return hooks ? applyWritebackWith(input, hooks) : applyWriteback(input);
}

function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function tempFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.endsWith(TEMP_SUFFIX));
}

// ---------------------------------------------------------------- 제목·필드

describe('syncTitleOf (명세 §1-1)', () => {
  const cb = (rawLine: string): Task => ({
    id: 'c:x',
    source: 'checkbox',
    title: displayTitle(rawLine),
    status: 'open',
    file: TODO,
    rawLine,
    bucket: 'other',
  });

  it('큐레이션은 items.json 제목', () => {
    expect(syncTitleOf({ id: 'i:x', source: 'curated', title: '전략 검토', status: 'open', bucket: 'other' })).toBe('전략 검토');
  });

  it('체크박스는 핵심문구(태그·굵게·그림 문자는 남고 필드는 빠진다)', () => {
    expect(syncTitleOf(cb('- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]'))).toBe('법인카드 지출결의서 작성 #내할일');
    expect(syncTitleOf(cb('- [ ] **월간 리포트** 초안 작성 #내할일 [wip:: 2026-09-20]'))).toBe('**월간 리포트** 초안 작성 #내할일');
    expect(syncTitleOf(cb('- [ ] 🔴 서진화학 EHS — 회신 [pri:: 1]'))).toBe('🔴 서진화학 EHS — 회신');
  });

  it('70자(코드 포인트) 넘으면 앞 70자 + …, 딱 70자면 그대로', () => {
    const seventy = '🔴' + '가'.repeat(69); // JS 길이 71, 코드 포인트 70
    expect(syncTitleOf(cb(`- [ ] ${seventy}`))).toBe(seventy);
    expect(syncTitleOf(cb(`- [ ] ${seventy}나 [due:: 2026-10-01]`))).toBe(`${seventy}…`);
  });

  it('줄이 없으면 표시 제목', () => {
    expect(syncTitleOf({ id: 'c:x', source: 'checkbox', title: '표시 제목', status: 'open', bucket: 'other' })).toBe('표시 제목');
  });
});

describe('applyStatus (sync_todo.apply_status)', () => {
  it.each<[string, TaskStatus, string | undefined, string]>([
    ['- [ ] 일 #내할일 [pri:: 1] [due:: 2026-09-18]', 'done', undefined, '- [x] 일 #내할일 [pri:: 1] [due:: 2026-09-18] [done:: 2026-09-23]'],
    ['- [ ] 앞 [wip:: 2026-09-01] 뒤 [pri:: 2]', 'done', undefined, '- [x] 앞 뒤 [pri:: 2] [done:: 2026-09-23]'],
    ['- [x] 일 [done:: 2026-09-01]   ', 'open', undefined, '- [ ] 일'],
    ['- [X] 일 [owner:: 김] [st:: 협의]', 'notmine', undefined, '- [ ] 일 [st:: 협의] [owner:: 타담당]'],
    ['- [ ] 일 [st:: 협의]', 'notmine', '박담당', '- [ ] 일 [st:: 협의] [owner:: 박담당]'],
    ['- [ ] 일 [due:: 2026-10-01]', 'wip', undefined, '- [ ] 일 [due:: 2026-10-01] [wip:: 2026-09-23]'],
    ['- [ ] 일\u3000[done:: x] 끝', 'wip', undefined, '- [ ] 일 끝 [wip:: 2026-09-23]'],
    // 파이썬 \s 와 JS \s 가 다른 글자: \x1c 는 파이썬만 공백, \ufeff 는 JS 만 공백
    ['- [ ] 일\x1c[done:: x]', 'open', undefined, '- [ ] 일'],
    ['- [ ] 일\ufeff[done:: x]', 'open', undefined, '- [ ] 일\ufeff'],
  ])('%s → %s', (line, status, owner, expected) => {
    expect(applyStatus(line, status, owner, TODAY)).toBe(expected);
  });
});

// ---------------------------------------------------------------- 각 동작

describe('앵커·체크박스 줄 고치기', () => {
  it('체크박스 done — 그 줄만 바뀌고 frontmatter updated 는 그대로', () => {
    const root = copyFixture();
    const before = read(root, TODO);
    const res = save(root, checkboxTask(root, TODO, '법인카드 지출결의서'), 'done');
    expect(res).toMatchObject({
      date: TODAY,
      updated: ['법인카드 지출결의서 작성 #내할일 [done]'],
      loggedDone: [],
      unmatched: [],
      memo: false,
      files: [TODO],
      backupDir: `${BACKUP_ROOT}/${STAMP}`,
      warnings: [],
    });
    expect(read(root, TODO)).toBe(
      before.replace(
        '- [ ] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23]\n',
        '- [x] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23] [done:: 2026-09-23]\n',
      ),
    );
  });

  it('큐레이션 앵커(엔티티) wip·notmine·open', () => {
    const root = copyFixture();
    const task = curatedTask(root, T_RENEW);
    expect(save(root, task, 'wip').updated).toEqual([`${T_RENEW} [wip]`]);
    expect(read(root, ENTITY)).toContain('\n- [ ] 연간 계약 갱신 검토 [due:: 2026-09-30] [wip:: 2026-09-23]\n');
    save(root, task, 'notmine', { owner: '  영업팀  ' });
    expect(read(root, ENTITY)).toContain('\n- [ ] 연간 계약 갱신 검토 [due:: 2026-09-30] [owner:: 영업팀]\n');
    save(root, task, 'open');
    expect(read(root, ENTITY)).toBe(read(FIXTURE, ENTITY));
  });

  it('같은 문구의 줄이 여럿이면 스냅샷이 가리킨 줄을 고친다(sync_todo 는 첫 줄)', () => {
    const root = copyFixture();
    fs.appendFileSync(at(root, WORK), '\n- [ ] 중복 문구 할 일 #내할일 [due:: 2026-10-01]\n- [ ] 중복 문구 할 일 #내할일 [due:: 2026-10-08]\n');
    const dup = snapshotOf(root).tasks.filter((t) => t.title === '중복 문구 할 일');
    expect(dup.map((t) => t.due)).toEqual(['2026-10-01', '2026-10-08']);
    save(root, dup[1], 'done');
    const text = read(root, WORK);
    expect(text).toContain('- [ ] 중복 문구 할 일 #내할일 [due:: 2026-10-01]\n');
    expect(text).toContain('- [x] 중복 문구 할 일 #내할일 [due:: 2026-10-08] [done:: 2026-09-23]\n');
  });

  it('앵커 줄이 이미 그 상태면 쓰지 않는다(updated 에는 남는다)', () => {
    const root = copyFixture();
    const res = save(root, curatedTask(root, T_TONGYEONG), 'open');
    expect(res.updated).toEqual([`${T_TONGYEONG} [open]`]);
    expect(res.files).toEqual([]);
    expect(res.backupDir).toBeUndefined();
    expect(fs.existsSync(at(root, `${BACKUP_ROOT}/${STAMP}`))).toBe(false);
  });
});

describe('로그 절 (앵커 없음·미발견)', () => {
  it('done → 완료 로그 끝에 붙이고 updated: 를 오늘로', () => {
    const root = copyFixture();
    const before = read(root, TODO);
    const res = save(root, curatedTask(root, T_SERVER_QUOTE), 'done');
    expect(res).toMatchObject({ updated: [], loggedDone: [T_SERVER_QUOTE], files: [TODO] });
    const prev = '- 2026-09-10 · 큐레이션 완료 항목 — 출처 `wiki/analysis/메일브리핑_2026-09-01.md`\n';
    expect(read(root, TODO)).toBe(
      before
        .replace('updated: 2026-09-22', 'updated: 2026-09-23')
        .replace(prev, `${prev}- 2026-09-23 · ${T_SERVER_QUOTE} — 출처 \`${SERVER_QUOTE_SRC}\`\n`),
    );
  });

  it('notmine → 위임 로그(담당·메모), 담당을 비우면 타담당', () => {
    const root = copyFixture();
    const res = save(root, curatedTask(root, T_LDAR), 'notmine', { owner: '영업팀', note: '초안은 영업팀이 회신' });
    expect(res.loggedDelegated).toEqual([T_LDAR]);
    expect(read(root, TODO)).toContain(
      '- 2026-09-11 · 큐레이션 위임 항목 → 담당 **박담당** — 개발팀에 이관\n- 2026-09-23 · LDAR 견적서 회신 → 담당 **영업팀** — 초안은 영업팀이 회신\n',
    );
    save(root, curatedTask(root, T_LDAR), 'notmine');
    const text = read(root, TODO);
    expect(text).toContain('- 2026-09-23 · LDAR 견적서 회신 → 담당 **타담당**\n');
    expect(text.match(/· LDAR 견적서 회신/g)).toHaveLength(1); // 같은 항목은 절 안에서 한 줄만
  });

  it('notmine 의 여러 줄 메모는 로그에 한 줄로(메모 파일에는 여러 줄) — 명세와 다른 점', () => {
    const root = copyFixture();
    save(root, curatedTask(root, T_LDAR), 'notmine', { owner: '영업팀', note: '첫 줄\n\n- [ ] 할 일처럼 보이는 줄\n## 제목처럼' });
    const todo = read(root, TODO);
    expect(todo).toContain('· LDAR 견적서 회신 → 담당 **영업팀** — 첫 줄 / - [ ] 할 일처럼 보이는 줄 / ## 제목처럼\n');
    expect(todo).not.toMatch(/^- \[ \] 할 일처럼/m);
    expect(read(root, MEMO)).toContain('- 2026-09-23 · 첫 줄\n  \n  - [ ] 할 일처럼 보이는 줄\n  ## 제목처럼\n');
  });

  it('wip → 진행 중 로그(파일 끝 절)', () => {
    const root = copyFixture();
    save(root, curatedTask(root, T_STRATEGY), 'wip');
    expect(read(root, TODO).endsWith('- 2026-09-19 · 큐레이션 진행 항목\n- 2026-09-23 · 전략 검토\n')).toBe(true);
  });

  it('open → 세 절에서 모두 회수(updated: 는 그대로), 없으면 쓰지 않는다', () => {
    const root = copyFixture();
    const before = read(root, TODO);
    const task = curatedTask(root, '큐레이션 완료 항목');
    const res = save(root, task, 'open');
    expect(res.unlogged).toEqual(['큐레이션 완료 항목']);
    expect(read(root, TODO)).toBe(before.replace('- 2026-09-10 · 큐레이션 완료 항목 — 출처 `wiki/analysis/메일브리핑_2026-09-01.md`\n', ''));
    const again = save(root, task, 'open');
    expect(again).toMatchObject({ unlogged: [], files: [] });
  });

  it('절이 없으면 파일 끝에 [빈 줄, 제목, 빈 줄, 안내문, 빈 줄] 로 만든다(끝 빈 줄을 걷고 항목을 붙인다)', () => {
    const root = copyFixture();
    const text = read(root, TODO);
    write(root, TODO, text.slice(0, text.indexOf('## 완료 로그')) + '\n\n');
    save(root, curatedTask(root, T_SERVER_QUOTE), 'done');
    // sync_todo 그대로: 새 절의 끝 빈 줄을 걷고 [항목, ""] 을 붙이므로 안내문 바로 다음 줄에 항목이 온다
    const tail =
      '[opened:: 2026-09-20] [열림:: 2영업일]\n\n## 완료 로그 (아티팩트 동기화)\n\n' +
      '> 아티팩트에서 처리했으나 위키에 대응 체크박스가 없던 항목이다. 원본 문서(종합분석·트리아지·메일브리핑)의 산문은 건드리지 않았다.\n' +
      `- 2026-09-23 · ${T_SERVER_QUOTE} — 출처 \`${SERVER_QUOTE_SRC}\`\n`;
    const after = read(root, TODO);
    expect(after.slice(-tail.length)).toBe(tail);
  });

  it('앵커 문구 미발견·파일 없음 → unmatched 에 적고 로그로', () => {
    const root = copyFixture();
    const res = save(root, curatedTask(root, '사라진 항목'), 'done');
    expect(res.unmatched).toEqual(['사라진 항목 — 문구 미발견: _private/mgmt/내 할 일.md / 존재하지 않는 문구']);
    expect(res.loggedDone).toEqual(['사라진 항목']);
    const gone = save(root, adhoc('없는 파일 항목', [{ file: 'wiki/entities/없는회사.md', match: '할 일' }]), 'wip');
    expect(gone.unmatched).toEqual(['없는 파일 항목 — 파일 없음: wiki/entities/없는회사.md']);
    expect(gone.loggedWip).toEqual(['없는 파일 항목']);
    expect(fs.existsSync(at(root, 'wiki/entities/없는회사.md'))).toBe(false);
  });

  it('필드가 문구 가운데 있어도 스냅샷이 가리킨 줄이 그대로면 그 줄을 고친다(sync_todo 는 로그로 떨어진다 — 2단계 명세 §9-1)', () => {
    const root = copyFixture();
    fs.appendFileSync(at(root, WORK), '\n- [ ] 가운데 [pri:: 2] 필드 #내할일\n');
    const res = save(root, checkboxTask(root, WORK, '가운데'), 'done');
    expect(res.updated).toEqual(['가운데 필드 #내할일 [done]']);
    expect(res.unmatched).toEqual([]);
    expect(res.loggedDone).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(read(root, WORK)).toContain('- [x] 가운데 [pri:: 2] 필드 #내할일 [done:: 2026-09-23]');
    expect(read(root, TODO)).not.toContain('가운데 필드');
  });

  it('메일 경로에 대괄호가 든 줄(`…_[재요청] 제목.md`)도 줄을 고친다 — 로그로 빠지지 않는다(2026-09-28 실제 사례)', () => {
    const root = copyFixture();
    const line =
      '- [ ] 🔴 거래처 선물 리스트 제출 (부서별 수량) #내할일 [pri:: 2] [due:: 2026-08-28] ' +
      '[mail:: raw/mail/경영지원/2026/2026-08-26_1112_총무팀_[재요청] 거래처 선물 리스트 제출_2914b9.md] [opened:: 2026-08-13]';
    write(root, TODO, read(root, TODO).replace('\n\n## 메일 회신 대기', `\n${line}\n\n## 메일 회신 대기`));
    const task = checkboxTask(root, TODO, '거래처 선물 리스트');
    // 스냅샷은 대괄호가 든 메일 경로를 끝까지 읽는다(회신 기능이 이 경로로 원본을 연다)
    const listed = snapshotOf(root).tasks.find((t) => t.id === task.id);
    expect(listed?.mail).toBe('raw/mail/경영지원/2026/2026-08-26_1112_총무팀_[재요청] 거래처 선물 리스트 제출_2914b9.md');
    expect(listed?.title).toBe('거래처 선물 리스트 제출 (부서별 수량)');
    const res = save(root, task, 'done');
    expect(res.updated).toEqual(['🔴 거래처 선물 리스트 제출 (부서별 수량) #내할일 [done]']);
    expect(res.loggedDone).toEqual([]);
    const text = read(root, TODO);
    expect(text).toContain(line.replace('- [ ] ', '- [x] ') + ' [done:: 2026-09-23]');
    expect(text).not.toContain('_2914b9.md] —');
    // 저장 뒤 목록에서 빠진다
    expect(snapshotOf(root).tasks.some((t) => t.title.includes('거래처 선물 리스트'))).toBe(false);
  });

  it('체크박스 항목의 줄이 사라졌으면 로그에 적지 않고 아무것도 쓰지 않은 채 실패한다', () => {
    const root = copyFixture();
    fs.appendFileSync(at(root, WORK), '\n- [ ] 곧 지워질 할 일 #내할일\n');
    const task = checkboxTask(root, WORK, '곧 지워질');
    write(root, WORK, read(root, WORK).replace('- [ ] 곧 지워질 할 일 #내할일\n', ''));
    const before = allFiles(root);
    expect(() => save(root, task, 'done', { note: '메모도 쓰지 않는다' })).toThrow(/할 일 줄을 찾지 못함\(_private\/mgmt\/업무 현황 종합 분석\.md\).*아무것도 쓰지 않았음/);
    expect(allFiles(root)).toEqual(before);
  });

  it('내 할 일.md 가 없으면 로그를 적지 않고 경고한다(파일을 만들지 않는다)', () => {
    const root = copyFixture();
    fs.rmSync(at(root, TODO));
    const res = save(root, curatedTask(root, T_SERVER_QUOTE), 'done');
    expect(res.loggedDone).toEqual([T_SERVER_QUOTE]); // sync_todo 와 같이 결과에는 남는다
    expect(res.files).toEqual([]);
    expect(res.warnings).toEqual([`${TODO} 가 없어 로그를 적지 못함: ${T_SERVER_QUOTE}`]);
    expect(fs.existsSync(at(root, TODO))).toBe(false);
  });
});

describe('메모 (할 일 메모.md)', () => {
  it('있는 절에 이어 쓰고, 여러 줄은 두 칸 들여쓴다(빈 줄은 "  ")', () => {
    const root = copyFixture();
    const before = read(root, MEMO);
    const res = save(root, curatedTask(root, T_STRATEGY), 'wip', { note: '1안: 유지\r\n2안: 확장\n\n결론은 다음 주  ' });
    expect(res.memo).toBe(true);
    expect(res.files).toEqual([TODO, MEMO]);
    expect(read(root, MEMO)).toBe(
      before
        .replace('updated: 2026-09-19', 'updated: 2026-09-23')
        .replace(
          '- 2026-08-13 · 상무님 보고 후 결정\n',
          '- 2026-08-13 · 상무님 보고 후 결정\n- 2026-09-23 · 1안: 유지\n  2안: 확장\n  \n  결론은 다음 주\n',
        ),
    );
    // 스냅샷은 마지막 메모를 읽는다
    const memo = snapshotOf(root).tasks.find((t) => t.title === T_STRATEGY)?.memo;
    expect(memo).toBe('1안: 유지\n2안: 확장\n\n결론은 다음 주');
  });

  it('절이 없으면 파일 끝에 [빈 줄, ## 제목, 출처, 빈 줄, 항목, 빈 줄]', () => {
    const root = copyFixture();
    save(root, curatedTask(root, T_SERVER_QUOTE), 'wip', { note: '방향 결정 회의 잡음' });
    expect(read(root, MEMO).endsWith(
      '- 2026-08-13 · 상무님 보고 후 결정\n\n## 대륙물산 서버 교체 견적 방향 결정\n출처 `wiki/analysis/메일브리핑_2026-09-18.md`\n\n- 2026-09-23 · 방향 결정 회의 잡음\n',
    )).toBe(true);
  });

  it('같은 메모가 절 안에 있으면 쓰지 않는다(memo false, 메모 파일은 그대로)', () => {
    const root = copyFixture();
    const before = fs.readFileSync(at(root, MEMO));
    const res = save(root, curatedTask(root, T_STRATEGY), 'wip', { note: '상무님 보고 후 결정' });
    expect(res.memo).toBe(false);
    expect(res.files).toEqual([TODO]);
    expect(fs.readFileSync(at(root, MEMO)).equals(before)).toBe(true);
  });

  it('메모 파일이 없으면 sync_todo 머리말로 만든다(백업 없음)', () => {
    const root = copyFixture();
    fs.rmSync(at(root, MEMO));
    const res = save(root, curatedTask(root, T_TONGYEONG), 'wip', { note: '확인 중' });
    expect(res.files).toEqual([TODO, MEMO]);
    expect(read(root, MEMO)).toBe(
      [
        '---',
        'type: note',
        'domain: [business]',
        'tags: [업무, 메모]',
        'created: 2026-09-23',
        'updated: 2026-09-23',
        '---',
        '',
        '# 할 일 메모',
        '',
        '> 아티팩트「내 할 일 — 위키 종합」에서 항목별로 적어 둔 의견을 모은다. 원본 태스크는 [[내 할 일]]과 각 고객사·주제 페이지에 있다.',
        '',
        `## ${T_TONGYEONG}`,
        '출처 `wiki/analysis/메일브리핑_2026-09-16.md`',
        '',
        '- 2026-09-23 · 확인 중',
        '',
      ].join('\n'),
    );
    expect(fs.existsSync(at(root, `${res.backupDir}/${MEMO}`))).toBe(false);
    expect(fs.existsSync(at(root, `${res.backupDir}/${TODO}`))).toBe(true);
  });

  it('메모만 공백이면 쓰지 않는다', () => {
    const root = copyFixture();
    const res = save(root, curatedTask(root, T_TONGYEONG), 'open', { note: ' \r\n\t ' });
    expect(res).toMatchObject({ memo: false, files: [] });
  });

  it('체크박스 항목의 메모는 sync 제목 절에 쌓이고 스냅샷이 그 이름으로 찾는다(명세 §5)', () => {
    const root = copyFixture();
    save(root, checkboxTask(root, TODO, '법인카드 지출결의서'), 'wip', { note: '영수증 모으는 중' });
    expect(read(root, MEMO)).toContain('\n## 법인카드 지출결의서 작성 #내할일\n출처 `_private/mgmt/내 할 일.md`\n\n- 2026-09-23 · 영수증 모으는 중\n');
    const t = snapshotOf(root).tasks.find((x) => x.title === '법인카드 지출결의서 작성');
    expect(t).toMatchObject({ status: 'wip', memo: '영수증 모으는 중' });
  });

  it('한 파일을 여러 동작이 고치면 한 번에 쓴다(메모 파일 안의 체크박스 + 메모)', () => {
    const root = copyFixture();
    fs.appendFileSync(at(root, MEMO), '- [ ] 메모 파일 안의 할 일 #내할일 [due:: 2026-10-02]\n');
    const renames: string[] = [];
    const res = save(root, checkboxTask(root, MEMO, '메모 파일 안의 할 일'), 'done', { note: '끝냄' }, {
      rename: (from, to) => {
        renames.push(path.basename(to));
        fs.renameSync(from, to);
      },
    });
    expect(res.files).toEqual([MEMO]);
    expect(renames).toEqual(['할 일 메모.md']);
    const text = read(root, MEMO);
    expect(text).toContain('- [x] 메모 파일 안의 할 일 #내할일 [due:: 2026-10-02] [done:: 2026-09-23]\n');
    expect(text.endsWith('\n## 메모 파일 안의 할 일 #내할일\n출처 `_private/mgmt/할 일 메모.md`\n\n- 2026-09-23 · 끝냄\n')).toBe(true);
  });
});

// ---------------------------------------------------------------- §1-3 레이더가 더 지키는 것

describe('줄바꿈·BOM 유지', () => {
  it('CRLF 파일은 새 줄까지 CRLF, LF 파일은 LF', () => {
    const root = copyFixture();
    write(root, TODO, crlf(read(root, TODO)));
    const res = save(root, curatedTask(root, T_SERVER_QUOTE), 'done', { note: '결정함\n견적 요청' });
    expect(res.files).toEqual([TODO, MEMO]);
    const todo = read(root, TODO);
    expect(todo.match(/\n/g)?.length).toBe(todo.match(/\r\n/g)?.length);
    expect(todo).toContain(`\r\n- 2026-09-23 · ${T_SERVER_QUOTE} — 출처 \`${SERVER_QUOTE_SRC}\`\r\n`);
    const memo = read(root, MEMO);
    expect(memo).not.toContain('\r');
    expect(memo).toContain('- 2026-09-23 · 결정함\n  견적 요청\n');
  });

  it('BOM 을 지키고, 백업은 원본 바이트 그대로', () => {
    const root = copyFixture();
    const original = Buffer.from('\ufeff' + crlf(read(root, ENTITY)), 'utf8');
    write(root, ENTITY, original);
    const res = save(root, curatedTask(root, T_RENEW), 'done');
    const buf = fs.readFileSync(at(root, ENTITY));
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString('utf8').charCodeAt(1)).toBe('-'.charCodeAt(0)); // BOM 이 두 번 붙지 않는다
    expect(buf.toString('utf8')).toContain('\r\n- [x] 연간 계약 갱신 검토 [due:: 2026-09-30] [done:: 2026-09-23]\r\n');
    expect(fs.readFileSync(at(root, `${res.backupDir}/${ENTITY}`)).equals(original)).toBe(true);
  });

  it('마지막 줄바꿈이 없던 파일은 없는 채로', () => {
    const root = copyFixture();
    write(root, WORK, read(root, WORK).replace(/\n+$/, ''));
    save(root, checkboxTask(root, WORK, '팀 회의록 공유'), 'wip');
    const text = read(root, WORK);
    expect(text.endsWith('- [ ] 태그 없는 메모 줄은 할 일이 아니다')).toBe(true);
    expect(text).toContain('- [ ] 팀 회의록 공유 #내할일, 사업부 채널에 [due:: 2026-09-22] [wip:: 2026-09-23]\n');
  });

  it('섞인 파일은 많은 쪽 줄바꿈으로', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
    expect(detectEol('a\r\nb\n')).toBe('\r\n'); // 같으면 처음 나온 쪽
    expect(detectEol('줄바꿈 없음')).toBe('\n');
    const root = copyFixture();
    const lines = read(root, ENTITY).split('\n');
    write(root, ENTITY, lines.map((l, i) => (i < lines.length - 1 ? l + (i < 3 ? '\n' : '\r\n') : l)).join(''));
    save(root, curatedTask(root, T_RENEW), 'wip');
    const text = read(root, ENTITY);
    expect(text.match(/\n/g)?.length).toBe(text.match(/\r\n/g)?.length);
  });
});

describe('쓰기 허용 목록', () => {
  const bad = [
    'raw/mail/한결케미칼/2026/2026-09-15_1728_EHS팀_통영공장 인벤토리 확인 요청_a1b2c3.md',
    'Raw/voc/2026/VOC-2026-0001.md',
    '_todo-sync/backup/20260901T000000/_private/mgmt/내 할 일.md',
    'wiki/topics/backup/x.md',
    '.obsidian/workspace.md',
    '_todo-sync/items.json',
    '_raw-link/link_raw.py',
    '../밖.md',
    'wiki/../../밖.md',
    'C:/Windows/win.md',
    '/abs.md',
    'wiki/entities/한결케미칼.md:stream',
    'wiki/entities/CON.md',
  ];

  it.each(bad)('%s → 거부, 아무 파일도 바뀌지 않는다', (file) => {
    const root = copyFixture();
    const before = allFiles(root);
    expect(() => save(root, adhoc('거부 항목', [{ file, match: '할 일' }]), 'done', { note: '메모' })).toThrow(WriteRefusedError);
    expect(allFiles(root)).toEqual(before);
  });

  it('체크박스 항목의 파일이 raw/ 면 거부', () => {
    const root = copyFixture();
    const task: Task = {
      id: 'c:x',
      source: 'checkbox',
      title: '할 일',
      status: 'open',
      file: 'raw/voc/2026/VOC-2026-0001.md',
      line: 1,
      rawLine: '- [ ] 할 일',
      bucket: 'other',
    };
    expect(() => save(root, task, 'done')).toThrow(/쓰기 허용 목록 밖.*raw/);
  });

  it('정션으로 위키 밖이나 raw/ 를 가리키면 거부', (ctx) => {
    const root = copyFixture();
    const outside = tempDir('wiki-radar-outside-');
    fs.writeFileSync(path.join(outside, 'a.md'), '- [ ] 밖의 할 일\n', 'utf8');
    try {
      fs.symlinkSync(outside, at(root, 'wiki/outlink'), 'junction');
      fs.symlinkSync(at(root, 'raw/voc'), at(root, 'wiki/vocjunction'), 'junction');
    } catch (err) {
      ctx.skip(`정션을 만들 수 없음: ${String(err)}`);
    }
    expect(() => save(root, adhoc('밖', [{ file: 'wiki/outlink/a.md', match: '밖의 할 일' }]), 'done')).toThrow(/위키 밖/);
    expect(() => save(root, adhoc('raw', [{ file: 'wiki/vocjunction/2026/VOC-2026-0001.md', match: '할 일' }]), 'done')).toThrow(
      /raw\/·제외 폴더/,
    );
    expect(fs.readFileSync(path.join(outside, 'a.md'), 'utf8')).toBe('- [ ] 밖의 할 일\n');
  });

  it('앵커에 .md 가 빠져 있으면 스냅샷처럼 .md 를 붙여 쓴다', () => {
    const root = copyFixture();
    const res = save(root, adhoc(T_RENEW, [{ file: 'wiki/entities/한결케미칼', match: '연간 계약 갱신' }]), 'done');
    expect(res.files).toEqual([ENTITY]);
    expect(res.updated).toEqual([`${T_RENEW} [done]`]);
  });

  it.runIf(process.platform === 'win32')('대소문자가 다른 앵커 경로로 써도 파일 이름 표기는 그대로(Windows)', () => {
    const root = copyFixture();
    const res = save(root, adhoc(T_RENEW, [{ file: 'WIKI/Entities/한결케미칼.MD', match: '연간 계약 갱신' }]), 'done');
    expect(res.updated).toEqual([`${T_RENEW} [done]`]);
    expect(fs.readdirSync(at(root, 'wiki'))).toContain('entities');
    expect(fs.readdirSync(at(root, 'wiki/entities'))).toContain('한결케미칼.md');
    expect(read(root, ENTITY)).toContain('[done:: 2026-09-23]');
  });

  it('알 수 없는 원천은 받지 않는다', () => {
    const root = copyFixture();
    const task = { ...curatedTask(root, T_SERVER_QUOTE), source: 'other' } as unknown as Task;
    expect(() => save(root, task, 'done')).toThrow(/알 수 없는 항목 원천/);
  });

  it('로그·메모 파일 자리가 폴더면 거부', () => {
    const root = copyFixture();
    fs.rmSync(at(root, MEMO));
    fs.mkdirSync(at(root, MEMO));
    expect(() => save(root, curatedTask(root, T_TONGYEONG), 'done', { note: 'x' })).toThrow(/파일이 아님/);
  });
});

describe('쓰기 직전 재확인', () => {
  it('첫 시도 뒤 파일이 바뀌면 다시 읽고 처음부터 — 남의 변경과 내 변경이 함께 남는다', () => {
    const root = copyFixture();
    const attempts: number[] = [];
    const res = save(root, curatedTask(root, T_RENEW), 'done', {}, {
      beforeRecheck: ({ attempt, files }) => {
        attempts.push(attempt);
        expect(files).toEqual([ENTITY]);
        if (attempt === 1) fs.appendFileSync(at(root, ENTITY), '- [ ] 그 사이 생긴 줄 #내할일\n');
      },
    });
    expect(attempts).toEqual([1, 2]);
    expect(res.warnings).toEqual([`저장 직전에 파일이 바뀌어 다시 읽음(1번째): ${ENTITY}`]);
    const text = read(root, ENTITY);
    expect(text).toContain('- [x] 연간 계약 갱신 검토 [due:: 2026-09-30] [done:: 2026-09-23]\n');
    expect(text.endsWith('- [ ] 그 사이 생긴 줄 #내할일\n')).toBe(true);
    // 백업은 실제로 고친 판(두 번째로 읽은 것)
    expect(read(root, `${res.backupDir}/${ENTITY}`).endsWith('- [ ] 그 사이 생긴 줄 #내할일\n')).toBe(true);
  });

  it('다시 읽으니 앵커 줄이 없어졌으면 로그로 떨어진다(처음부터 다시 적용)', () => {
    const root = copyFixture();
    const res = save(root, curatedTask(root, T_RENEW), 'done', {}, {
      beforeRecheck: ({ attempt }) => {
        if (attempt === 1) write(root, ENTITY, read(root, ENTITY).replace('- [ ] 연간 계약 갱신 검토 [due:: 2026-09-30]\n', ''));
      },
    });
    expect(res).toMatchObject({
      updated: [],
      loggedDone: [T_RENEW],
      unmatched: [`${T_RENEW} — 문구 미발견: ${ENTITY} / 연간 계약 갱신`],
      files: [TODO],
    });
  });

  it('읽기만 한 파일이 바뀌어도 다시 읽는다', () => {
    const root = copyFixture();
    const attempts: number[] = [];
    const res = save(root, curatedTask(root, T_TONGYEONG), 'open', { note: '다시 확인' }, {
      beforeRecheck: ({ attempt, files }) => {
        attempts.push(attempt);
        expect(files).toEqual([TODO, MEMO]);
        if (attempt === 1) fs.appendFileSync(at(root, TODO), '\n');
      },
    });
    expect(attempts).toEqual([1, 2]);
    expect(res.files).toEqual([MEMO]);
    expect(res.warnings[0]).toMatch(/다시 읽음\(1번째\): _private\/mgmt\/내 할 일\.md$/);
  });

  it(`${MAX_WRITE_ATTEMPTS}번 모두 바뀌면 아무것도 쓰지 않고 실패(백업도 없음)`, () => {
    const root = copyFixture();
    const attempts: number[] = [];
    let expected = read(root, ENTITY);
    expect(() =>
      save(root, curatedTask(root, T_RENEW), 'done', { note: '메모' }, {
        beforeRecheck: ({ attempt }) => {
          attempts.push(attempt);
          fs.appendFileSync(at(root, ENTITY), `- [ ] 계속 바뀌는 줄 ${attempt}\n`);
        },
      }),
    ).toThrow(/계속 바뀌고 있어 저장하지 못함\(3번 다시 읽음\)/);
    expect(attempts).toEqual([1, 2, 3]);
    expected += '- [ ] 계속 바뀌는 줄 1\n- [ ] 계속 바뀌는 줄 2\n- [ ] 계속 바뀌는 줄 3\n';
    expect(read(root, ENTITY)).toBe(expected);
    expect(read(root, MEMO)).toBe(read(FIXTURE, MEMO));
    expect(fs.readdirSync(at(root, BACKUP_ROOT))).toEqual(['20260901T000000']);
  });
});

describe('원자적 쓰기(임시 파일 → 이름 바꾸기)', () => {
  it('잠금(EBUSY)은 짧게 재시도해 쓴다, 임시 파일은 남지 않는다', () => {
    const root = copyFixture();
    const sleeps: number[] = [];
    let calls = 0;
    const res = save(root, curatedTask(root, T_RENEW), 'done', {}, {
      sleep: (ms) => sleeps.push(ms),
      rename: (from, to) => {
        calls++;
        expect(path.dirname(from)).toBe(path.dirname(to)); // 같은 폴더의 임시 파일
        expect(path.basename(from)).toMatch(/^\.wr-[0-9a-f]{8}-.+\.wiki-radar-tmp$/);
        if (calls <= 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        fs.renameSync(from, to);
      },
    });
    expect(res.files).toEqual([ENTITY]);
    expect(calls).toBe(3);
    expect(sleeps).toEqual(WRITE_RETRY_DELAYS_MS.slice(0, 2));
    expect(read(root, ENTITY)).toContain('[done:: 2026-09-23]');
    expect(tempFilesIn(at(root, 'wiki/entities'))).toEqual([]);
  });

  it('계속 잠겨 있으면 실패하고 원본·임시 파일을 남기지 않는다', () => {
    const root = copyFixture();
    const sleeps: number[] = [];
    expect(() =>
      save(root, curatedTask(root, T_RENEW), 'done', {}, {
        sleep: (ms) => sleeps.push(ms),
        rename: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        },
      }),
    ).toThrow(/파일을 쓰지 못함\(EPERM\): wiki\/entities\/한결케미칼\.md/);
    expect(sleeps).toEqual([...WRITE_RETRY_DELAYS_MS]);
    expect(read(root, ENTITY)).toBe(read(FIXTURE, ENTITY));
    expect(tempFilesIn(at(root, 'wiki/entities'))).toEqual([]);
    // 아무것도 쓰지 않았으므로 백업도 남기지 않는다
    expect(fs.readdirSync(at(root, BACKUP_ROOT))).toEqual(['20260901T000000']);
  });

  it('잠금이 풀리기를 기다리는 사이 다른 프로그램이 쓴 변경은 덮어쓰지 않는다 — 다시 읽고 처음부터', () => {
    const root = copyFixture();
    const other = '- [ ] 다른 기기에서 더한 할 일 #내할일';
    const sleeps: number[] = [];
    let calls = 0;
    const res = save(root, curatedTask(root, T_RENEW), 'done', {}, {
      sleep: (ms) => sleeps.push(ms),
      rename: (from, to) => {
        calls++;
        if (calls === 1) {
          // 파일을 잡고 있던 쪽(OneDrive 가 원격 변경을 받아 쓰는 중 등)이 쓰고 놓는다
          fs.appendFileSync(to, `${other}\n`);
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        fs.renameSync(from, to);
      },
    });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([WRITE_RETRY_DELAYS_MS[0]]);
    expect(res.files).toEqual([ENTITY]);
    expect(res.updated).toEqual([`${T_RENEW} [done]`]);
    expect(res.warnings).toEqual([`저장하는 사이에 파일이 바뀌어 다시 읽음(1번째): ${ENTITY}`]);
    const text = read(root, ENTITY);
    expect(text).toContain('- [x] 연간 계약 갱신 검토 [due:: 2026-09-30] [done:: 2026-09-23]\n');
    expect(text.endsWith(`${other}\n`), '남의 변경이 남아야 한다').toBe(true);
    // 백업은 한 폴더, 실제로 덮어쓴 판(남의 변경이 든 것)
    expect(res.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);
    expect(fs.readdirSync(at(root, BACKUP_ROOT)).sort()).toEqual(['20260901T000000', STAMP]);
    expect(read(root, `${res.backupDir}/${ENTITY}`)).toBe(read(FIXTURE, ENTITY) + `${other}\n`);
    expect(tempFilesIn(at(root, 'wiki/entities'))).toEqual([]);
  });

  it('다른 프로그램이 이름 바꾸기 때마다 파일을 바꾸면 3번 뒤 실패하고, 남의 변경은 모두 남는다', () => {
    const root = copyFixture();
    let calls = 0;
    expect(() =>
      save(root, curatedTask(root, T_RENEW), 'done', {}, {
        sleep: () => undefined,
        rename: (_from, to) => {
          calls++;
          fs.appendFileSync(to, `- [ ] 끼어든 줄 ${calls}\n`);
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        },
      }),
    ).toThrow(/계속 바뀌고 있어 저장하지 못함\(3번 다시 읽음\) — 아무것도 쓰지 않았음/);
    expect(calls).toBe(MAX_WRITE_ATTEMPTS);
    expect(read(root, ENTITY)).toBe(read(FIXTURE, ENTITY) + '- [ ] 끼어든 줄 1\n- [ ] 끼어든 줄 2\n- [ ] 끼어든 줄 3\n');
    expect(fs.readdirSync(at(root, BACKUP_ROOT))).toEqual(['20260901T000000']);
    expect(tempFilesIn(at(root, 'wiki/entities'))).toEqual([]);
  });
});

describe('여러 파일 저장의 실패(쓰는 순서·일부만 쓴 경우)', () => {
  const cardTask = (root: string) => checkboxTask(root, TODO, '법인카드 지출결의서');
  const lockOf =
    (target: string, code = 'EPERM') =>
    (from: string, to: string) => {
      if (path.basename(to) === path.basename(target)) throw Object.assign(new Error(code), { code });
      fs.renameSync(from, to);
    };

  it('메모 파일이 잠겨 있으면 할 일 줄도 쓰지 않는다(메모를 먼저 쓴다) — 목록에 남아 다시 저장할 수 있다', () => {
    const root = copyFixture();
    const order: string[] = [];
    expect(() =>
      save(root, cardTask(root), 'done', { note: '상신함' }, {
        sleep: () => undefined,
        rename: (from, to) => {
          order.push(path.basename(to));
          lockOf(MEMO)(from, to);
        },
      }),
    ).toThrow(/파일을 쓰지 못함\(EPERM\): _private\/mgmt\/할 일 메모\.md .* — 아무것도 쓰지 않았음$/);
    expect(new Set(order)).toEqual(new Set(['할 일 메모.md']));
    expect(read(root, TODO)).toBe(read(FIXTURE, TODO));
    expect(read(root, MEMO)).toBe(read(FIXTURE, MEMO));
    expect(fs.readdirSync(at(root, BACKUP_ROOT))).toEqual(['20260901T000000']);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
    expect(snapshotOf(root).tasks.some((t) => t.title === '법인카드 지출결의서 작성')).toBe(true);
    // 잠금이 풀린 뒤 같은 저장은 그대로 된다
    const res = save(root, cardTask(root), 'done', { note: '상신함', now: new Date(2026, 8, 23, 10, 0, 5) });
    expect(res.files).toEqual([TODO, MEMO]);
    expect(res.memo).toBe(true);
  });

  it('할 일 파일만 막히면 PartialWriteError — 메모만 쓰였고 백업도 메모만, 다시 저장하면 나머지가 된다', () => {
    const root = copyFixture();
    let err: unknown;
    try {
      save(root, cardTask(root), 'done', { note: '상신함' }, { sleep: () => undefined, rename: lockOf(TODO) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PartialWriteError);
    const partial = err as PartialWriteError;
    expect(partial.written).toEqual([MEMO]);
    expect(partial.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);
    expect(partial.message).toMatch(
      /파일을 쓰지 못함\(EPERM\): _private\/mgmt\/내 할 일\.md .* — 먼저 쓴 파일: _private\/mgmt\/할 일 메모\.md — 다시 저장하면 이어서 반영됨$/,
    );
    expect(read(root, TODO)).toBe(read(FIXTURE, TODO));
    expect(read(root, MEMO)).toContain('- 2026-09-23 · 상신함');
    // 백업은 실제로 쓴 메모 파일만
    const backupFiles = fs.readdirSync(at(root, `${BACKUP_ROOT}/${STAMP}`), { recursive: true, withFileTypes: true });
    expect(backupFiles.filter((e) => e.isFile()).map((e) => e.name)).toEqual(['할 일 메모.md']);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
    // 할 일은 목록에 남는다 → 같은 저장을 다시 하면 할 일 줄만 쓰고 메모는 다시 쓰지 않는다
    expect(snapshotOf(root).tasks.some((t) => t.title === '법인카드 지출결의서 작성')).toBe(true);
    const memoAfter = read(root, MEMO);
    const res = save(root, cardTask(root), 'done', { note: '상신함', now: new Date(2026, 8, 23, 10, 0, 5) });
    expect(res.files).toEqual([TODO]);
    expect(res.memo).toBe(false);
    expect(read(root, MEMO)).toBe(memoAfter);
    expect(read(root, TODO)).toContain('- [x] 법인카드 지출결의서 작성 #내할일 [pri:: 2] [due:: 2026-09-23] [done:: 2026-09-23]');
  });

  it('메모를 쓴 뒤 할 일 파일이 바뀌어 다시 읽어도 결과는 한 번의 저장 — 메모는 한 번, memo 는 참, 백업은 한 폴더', () => {
    const root = copyFixture();
    const other = '- [ ] 그 사이 생긴 줄 #내할일';
    let todoCalls = 0;
    const res = save(root, cardTask(root), 'done', { note: '상신함' }, {
      sleep: () => undefined,
      rename: (from, to) => {
        if (path.basename(to) === '내 할 일.md' && ++todoCalls === 1) {
          fs.appendFileSync(to, `\n${other}\n`);
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        }
        fs.renameSync(from, to);
      },
    });
    expect(res.files).toEqual([TODO, MEMO]);
    expect(res.memo).toBe(true);
    expect(res.warnings).toEqual([`저장하는 사이에 파일이 바뀌어 다시 읽음(1번째): ${TODO}`]);
    expect(read(root, TODO)).toContain(other);
    expect(read(root, TODO)).toContain('[done:: 2026-09-23]');
    expect(read(root, MEMO).split('- 2026-09-23 · 상신함').length - 1).toBe(1);
    expect(res.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);
    expect(fs.readdirSync(at(root, BACKUP_ROOT)).sort()).toEqual(['20260901T000000', STAMP]);
    // 메모 백업은 저장 전 원본, 할 일 백업은 실제로 덮어쓴 판(끼어든 줄이 든 것)
    expect(read(root, `${res.backupDir}/${MEMO}`)).toBe(read(FIXTURE, MEMO));
    expect(read(root, `${res.backupDir}/${TODO}`)).toContain(other);
  });

  it('읽기 전용 파일은 첫 파일을 쓰기 전에 걸러 낸다(아무것도 쓰지 않고 백업도 없음)', () => {
    const root = copyFixture();
    const memoAbs = at(root, MEMO);
    fs.chmodSync(memoAbs, 0o444);
    const sleeps: number[] = [];
    try {
      expect(() => save(root, cardTask(root), 'done', { note: '상신함' }, { sleep: (ms) => sleeps.push(ms) })).toThrow(
        /파일을 쓰지 못함\((EPERM|EACCES)\): _private\/mgmt\/할 일 메모\.md — 읽기 전용이거나 .* — 아무것도 쓰지 않았음$/,
      );
    } finally {
      fs.chmodSync(memoAbs, 0o666);
    }
    expect(sleeps).toEqual([...WRITE_RETRY_DELAYS_MS]);
    expect(read(root, TODO)).toBe(read(FIXTURE, TODO));
    expect(read(root, MEMO)).toBe(read(FIXTURE, MEMO));
    expect(fs.readdirSync(at(root, BACKUP_ROOT))).toEqual(['20260901T000000']);
    expect(tempFilesIn(at(root, '_private/mgmt'))).toEqual([]);
  });

  it('이름이 아주 긴 파일(229자)도 저장한다 — 임시 파일 이름은 원래 이름과 상관없이 짧다', () => {
    const root = copyFixture();
    const name = `${'가'.repeat(226)}.md`;
    const rel = `wiki/entities/${name}`;
    write(root, rel, '# 긴 이름\n\n- [ ] 긴 이름 파일의 할 일 #내할일\n');
    const temps: string[] = [];
    const res = save(root, checkboxTask(root, rel, '긴 이름 파일의 할 일'), 'done', {}, {
      rename: (from, to) => {
        temps.push(path.basename(from));
        fs.renameSync(from, to);
      },
    });
    expect(res.files).toEqual([rel]);
    expect(read(root, rel)).toContain('- [x] 긴 이름 파일의 할 일 #내할일 [done:: 2026-09-23]');
    expect(temps).toHaveLength(1);
    expect(temps[0].length).toBeLessThan(80);
    expect(read(root, `${res.backupDir}/${rel}`)).toBe('# 긴 이름\n\n- [ ] 긴 이름 파일의 할 일 #내할일\n');
  });
});

describe('백업', () => {
  it('<wiki>/_todo-sync/backup/<YYYYMMDDTHHMMSS>/<상대경로>, 원본 바이트·수정 시각 그대로', () => {
    expect(backupStamp(NOW)).toBe(STAMP);
    const root = copyFixture();
    const mtime = new Date(2026, 8, 20, 9, 30, 0);
    fs.utimesSync(at(root, TODO), mtime, mtime);
    const original = fs.readFileSync(at(root, TODO));
    const res = save(root, curatedTask(root, T_TONGYEONG), 'done', { note: '끝' });
    expect(res.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);
    const copy = at(root, `${BACKUP_ROOT}/${STAMP}/${TODO}`);
    expect(fs.readFileSync(copy).equals(original)).toBe(true);
    expect(Math.abs(fs.statSync(copy).mtimeMs - mtime.getTime())).toBeLessThan(1000);
    expect(fs.readFileSync(at(root, `${BACKUP_ROOT}/${STAMP}/${MEMO}`)).equals(fs.readFileSync(at(FIXTURE, MEMO)))).toBe(true);
  });

  it('같은 초에 또 저장하면 덮어쓰지 않고 -2 폴더', () => {
    const root = copyFixture();
    const first = save(root, curatedTask(root, T_SERVER_QUOTE), 'done');
    const afterFirst = fs.readFileSync(at(root, TODO));
    const second = save(root, curatedTask(root, T_LDAR), 'done');
    expect(first.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}`);
    expect(second.backupDir).toBe(`${BACKUP_ROOT}/${STAMP}-2`);
    expect(fs.readFileSync(at(root, `${first.backupDir}/${TODO}`)).equals(fs.readFileSync(at(FIXTURE, TODO)))).toBe(true);
    expect(fs.readFileSync(at(root, `${second.backupDir}/${TODO}`)).equals(afterFirst)).toBe(true);
  });
});

describe('멱등성 — 같은 저장 두 번', () => {
  it.each<[string, (root: string) => Task, TaskStatus, Partial<WritebackInput>]>([
    ['앵커 done + 메모', (r) => curatedTask(r, T_TONGYEONG), 'done', { note: '회신 완료\n후속 없음' }],
    ['로그 notmine + 메모', (r) => curatedTask(r, T_LDAR), 'notmine', { owner: '영업팀', note: '이관' }],
    ['로그 wip', (r) => curatedTask(r, T_STRATEGY), 'wip', {}],
    ['체크박스 notmine', (r) => checkboxTask(r, ENTITY, '담당자 교체 공지'), 'notmine', { owner: '한결 영업' }],
  ])('%s', (_name, taskOf, status, extra) => {
    const root = copyFixture();
    const task = taskOf(root);
    const first = save(root, task, status, extra);
    expect(first.files.length).toBeGreaterThan(0);
    const after = allFiles(root);
    const second = save(root, task, status, { ...extra, now: new Date(2026, 8, 23, 10, 0, 5) });
    expect(second.files).toEqual([]);
    expect(second.memo).toBe(false);
    expect(second.backupDir).toBeUndefined();
    expect(allFiles(root)).toEqual(after);
  });
});

describe('입력 검사', () => {
  it('날짜·상태·위키 폴더', () => {
    const root = copyFixture();
    const task = curatedTask(root, T_SERVER_QUOTE);
    expect(() => save(root, task, 'done', { today: '2026/09/23' })).toThrow(/오늘 날짜 형식/);
    expect(() => save(root, task, 'closed' as TaskStatus)).toThrow(/알 수 없는 상태/);
    expect(() => save(path.join(root, '없는-폴더'), task, 'done')).toThrow(/위키 폴더를 찾을 수 없음/);
  });

  it('담당에 대괄호·줄바꿈은 받지 않는다', () => {
    const root = copyFixture();
    const task = curatedTask(root, T_RENEW);
    expect(() => save(root, task, 'notmine', { owner: '김[팀장]' })).toThrow(/대괄호/);
    expect(() => save(root, task, 'notmine', { owner: '김\n이' })).toThrow(/줄바꿈/);
    expect(read(root, ENTITY)).toBe(read(FIXTURE, ENTITY));
  });

  it('핵심문구가 빈 체크박스 줄·줄 없는 체크박스 항목·줄바꿈 든 제목', () => {
    const root = copyFixture();
    const empty: Task = { id: 'c:x', source: 'checkbox', title: '(제목 없음)', status: 'open', file: TODO, line: 1, rawLine: '- [ ] [pri:: 1]', bucket: 'other' };
    expect(() => save(root, empty, 'done')).toThrow(/핵심문구가 비어/);
    expect(() => save(root, { ...empty, rawLine: undefined }, 'done')).toThrow(/파일·줄이 없음/);
    expect(() => save(root, adhoc('두\n줄', []), 'done')).toThrow(/줄바꿈/);
  });

  it('UTF-8 이 아닌 파일은 고치지 않는다', () => {
    const root = copyFixture();
    const broken = Buffer.concat([fs.readFileSync(at(root, ENTITY)), Buffer.from([0xff, 0xfe, 0x0a])]);
    write(root, ENTITY, broken);
    expect(() => save(root, curatedTask(root, T_RENEW), 'done')).toThrow(/UTF-8/);
    expect(fs.readFileSync(at(root, ENTITY)).equals(broken)).toBe(true);
  });
});

describe('저장 뒤 스냅샷', () => {
  it('done·notmine 은 목록에서 빠지고, open 으로 되돌리면 다시 나온다', () => {
    const root = copyFixture();
    const count = () => snapshotOf(root).tasks.length;
    const base = count();
    save(root, checkboxTask(root, TODO, '주간 업무보고'), 'done');
    expect(snapshotOf(root).tasks.some((t) => t.title === '주간 업무보고 작성')).toBe(false);
    save(root, curatedTask(root, T_SERVER_QUOTE), 'notmine', { owner: '경영혁신팀' });
    expect(snapshotOf(root).tasks.some((t) => t.title === T_SERVER_QUOTE)).toBe(false);
    expect(count()).toBe(base - 2);
    save(root, checkboxTask(root, TODO, '주간 업무보고'), 'open');
    save(root, curatedTask(root, T_SERVER_QUOTE), 'open');
    expect(count()).toBe(base);
    expect(snapshotOf(root).warnings).toEqual(snapshotOf(FIXTURE).warnings);
  });
});
