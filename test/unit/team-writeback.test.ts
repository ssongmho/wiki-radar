// 2.9단계 명세 §5·§10 — 팀 위키 할 일 줄 쓰기(임시 폴더의 test/fixtures/team-wiki 복사본에만 쓴다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSynced } from '../../src/main/teamSync/engine';
import { teamTaskId } from '../../src/main/wiki/teamTasks';
import {
  TEAM_LINE_NOT_FOUND,
  applyTeamLineChange,
  applyTeamWriteback,
  checkTeamWritable,
  pruneTeamBackups,
  requireSaveTeamTaskInput,
  requireTeamDocPath,
} from '../../src/main/wiki/teamWriteback';
import { applyStatus } from '../../src/main/wiki/writeback';

const FIXTURE = path.resolve(__dirname, '../fixtures/team-wiki');
const TODAY = '2026-09-23';
const MEETING = '회의록/2026-09-22 주간회의.md';
const DISK = '- [ ] 백업 서버 디스크 교체 일정 잡기 [owner:: 홍길동] [due:: 2026-09-22]';
const ROOM = '- [ ] 회의실 예약 시스템 문의 정리 [due:: 2026-10-02]';
const NOW = new Date(2026, 8, 23, 10, 30, 5);

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

function sandbox(): { root: string; backupRoot: string; data: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-team-wb-'));
  temps.push(base);
  const root = path.join(base, 'dc-wiki');
  fs.cpSync(FIXTURE, root, { recursive: true });
  const data = path.join(base, 'data');
  return { root, backupRoot: path.join(data, 'team-backup'), data };
}

function readLines(root: string, rel: string): string[] {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').split('\n');
}

function lineNo(root: string, rel: string, raw: string): number {
  return readLines(root, rel).indexOf(raw) + 1;
}

function task(root: string, rel: string, raw: string) {
  return { id: teamTaskId(rel, raw), file: rel, line: lineNo(root, rel, raw), rawLine: raw };
}

describe('applyTeamLineChange — 줄 고치기', () => {
  it('완료: [x] + done, wip·done 은 지우고 owner·due 는 그대로(개인 apply_status 와 다름)', () => {
    const line = '- [ ] 일 [owner:: 홍길동] [wip:: 2026-09-20] [due:: 2026-09-22]';
    expect(applyTeamLineChange(line, { status: 'done' }, TODAY)).toBe('- [x] 일 [owner:: 홍길동] [due:: 2026-09-22] [done:: 2026-09-23]');
    // 개인 위키 규칙은 owner 를 지운다 — 팀은 담당이라 지우지 않는다
    expect(applyStatus(line, 'done', undefined, TODAY)).not.toContain('owner');
  });

  it('진행 중: [ ] + wip(있으면 그대로), done·st 완료는 지운다', () => {
    expect(applyTeamLineChange('- [x] 일 [owner:: 김] [done:: 2026-09-21] [st:: 완료]', { status: 'wip' }, TODAY)).toBe(
      '- [ ] 일 [owner:: 김] [wip:: 2026-09-23]',
    );
    expect(applyTeamLineChange('- [ ] 일 [wip:: 2026-09-20] [st:: 진행]', { status: 'wip' }, TODAY)).toBe(
      '- [ ] 일 [wip:: 2026-09-20] [st:: 진행]',
    );
  });

  it('되돌리기(대기): done·wip·st 완료를 지운다', () => {
    expect(applyTeamLineChange('- [X] 일 [wip:: 2026-09-20] [done:: 2026-09-21] [owner:: 김]', { status: 'open' }, TODAY)).toBe(
      '- [ ] 일 [owner:: 김]',
    );
  });

  it('담당 바꾸기(첫 자리)·지우기·붙이기', () => {
    expect(applyTeamLineChange('- [ ] 일 [owner:: 홍길동] [due:: 2026-09-30] [owner:: 옛]', { owners: ['김담당', '박담당'] }, TODAY)).toBe(
      '- [ ] 일 [owner:: 김담당, 박담당] [due:: 2026-09-30]',
    );
    expect(applyTeamLineChange('- [ ] 일 [owner:: 홍길동] [due:: 2026-09-30]', { owners: [] }, TODAY)).toBe('- [ ] 일 [due:: 2026-09-30]');
    expect(applyTeamLineChange('- [ ] 일   ', { owners: ['홍길동'] }, TODAY)).toBe('- [ ] 일 [owner:: 홍길동]');
  });

  it('기한 바꾸기(그 자리)·지우기·붙이기, 붙이는 순서는 담당 → 기한 → 상태', () => {
    expect(applyTeamLineChange('- [ ] 일 [due:: 2026-09-22] 끝', { due: '2026-09-29' }, TODAY)).toBe('- [ ] 일 [due:: 2026-09-29] 끝');
    expect(applyTeamLineChange('- [ ] 일 [due:: 2026-09-22] 끝', { due: '' }, TODAY)).toBe('- [ ] 일 끝');
    expect(applyTeamLineChange('- [ ] 일', { status: 'done', due: '2026-09-30', owners: ['홍길동'] }, TODAY)).toBe(
      '- [x] 일 [owner:: 홍길동] [due:: 2026-09-30] [done:: 2026-09-23]',
    );
  });

  it('값 안의 짝 맞는 대괄호 한 겹은 필드의 일부', () => {
    expect(applyTeamLineChange('- [ ] 일 [mail:: raw/mail/a_[공지] b.md] [owner:: 김]', { owners: ['박'] }, TODAY)).toBe(
      '- [ ] 일 [mail:: raw/mail/a_[공지] b.md] [owner:: 박]',
    );
  });

  it('담당이 위키 링크([[이름]]·[[문서|별칭]])여도 필드 통째로 고친다 — 남는 ]] 가 없다', () => {
    const line = '- [ ] a [owner:: [[홍길동]]] [due:: 2026-09-22]';
    expect(applyTeamLineChange(line, { owners: ['김'] }, TODAY)).toBe('- [ ] a [owner:: 김] [due:: 2026-09-22]');
    expect(applyTeamLineChange(line, { due: '2026-09-30' }, TODAY)).toBe('- [ ] a [owner:: [[홍길동]]] [due:: 2026-09-30]');
    expect(applyTeamLineChange(line, { owners: [] }, TODAY)).toBe('- [ ] a [due:: 2026-09-22]');
    expect(applyTeamLineChange('- [ ] a [owner:: [[사람/홍길동|홍길동]], 김] [due:: 2026-09-22]', { status: 'done' }, TODAY)).toBe(
      '- [x] a [owner:: [[사람/홍길동|홍길동]], 김] [due:: 2026-09-22] [done:: 2026-09-23]',
    );
  });

  it('할 일 줄이 아니면 던진다', () => {
    expect(() => applyTeamLineChange('  - [ ] 들여씀', { status: 'done' }, TODAY)).toThrow();
  });
});

describe('applyTeamWriteback — 쓰기', () => {
  it('완료 저장: 그 줄만 바뀌고 백업은 데이터 폴더(사본 밖)', () => {
    const { root, backupRoot } = sandbox();
    const before = fs.readFileSync(path.join(root, MEETING), 'utf8');
    const r = applyTeamWriteback({ root, backupRoot, today: TODAY, now: NOW, task: task(root, MEETING, DISK), change: { status: 'done' } });
    expect(r.changed).toBe(true);
    expect(r.line).toBe('- [x] 백업 서버 디스크 교체 일정 잡기 [owner:: 홍길동] [due:: 2026-09-22] [done:: 2026-09-23]');
    const after = fs.readFileSync(path.join(root, MEETING), 'utf8');
    expect(after).toBe(before.replace(DISK, r.line));
    expect(r.backupDir).toBe(path.join(backupRoot, '20260923T103005'));
    expect(fs.readFileSync(path.join(r.backupDir as string, ...MEETING.split('/')), 'utf8')).toBe(before);
    expect(r.backupDir?.startsWith(root)).toBe(false);
    // 임시 파일이 남지 않는다
    expect(fs.readdirSync(path.join(root, '회의록')).filter((n) => n.endsWith('.wiki-radar-tmp'))).toEqual([]);
    // 같은 초에 또 저장하면 -2
    const r2 = applyTeamWriteback({
      root,
      backupRoot,
      today: TODAY,
      now: NOW,
      task: task(root, MEETING, ROOM),
      change: { owners: ['홍길동'] },
    });
    expect(r2.backupDir).toBe(path.join(backupRoot, '20260923T103005-2'));
    expect(readLines(root, MEETING)).toContain('- [ ] 회의실 예약 시스템 문의 정리 [due:: 2026-10-02] [owner:: 홍길동]');
  });

  it('담당이 [[이름]] 인 줄: 담당·기한 저장이 그 줄만 바르게 고친다(ID 는 담당을 바꿔도 같다)', () => {
    const { root, backupRoot } = sandbox();
    const rel = '링크 담당.md';
    const raw = '- [ ] 링크 담당 일 [owner:: [[홍길동]]] [due:: 2026-09-22]';
    fs.writeFileSync(path.join(root, rel), `# 링크
${raw}
`, 'utf8');
    const t = task(root, rel, raw);
    const r = applyTeamWriteback({ root, backupRoot, today: TODAY, now: NOW, task: t, change: { due: '2026-09-29' } });
    expect(r.line).toBe('- [ ] 링크 담당 일 [owner:: [[홍길동]]] [due:: 2026-09-29]');
    const r2 = applyTeamWriteback({ root, backupRoot, today: TODAY, now: NOW, task: task(root, rel, r.line), change: { owners: ['김담당'] } });
    expect(r2.line).toBe('- [ ] 링크 담당 일 [owner:: 김담당] [due:: 2026-09-29]');
    expect(readLines(root, rel)).toEqual(['# 링크', r2.line, '']);
    expect(teamTaskId(rel, r2.line)).toBe(t.id);
  });

  it('내용 그대로면 쓰지도 백업하지도 않는다', () => {
    const { root, backupRoot } = sandbox();
    const r = applyTeamWriteback({ root, backupRoot, today: TODAY, task: task(root, MEETING, DISK), change: { due: '2026-09-22' } });
    expect(r.changed).toBe(false);
    expect(r.backupDir).toBeUndefined();
    expect(fs.existsSync(backupRoot)).toBe(false);
  });

  it('줄 위치가 바뀌어도 ID 로 찾는다 · 같은 ID 둘이면 실패 · 줄이 없으면 실패', () => {
    const { root, backupRoot } = sandbox();
    const t = task(root, MEETING, DISK);
    const abs = path.join(root, MEETING);
    // 위에 줄을 더해 자리가 바뀌고, 그 줄의 필드도 바뀜(rawLine 이 다름)
    fs.writeFileSync(abs, '맨 위에 더한 줄\n' + fs.readFileSync(abs, 'utf8').replace(DISK, DISK.replace('[due:: 2026-09-22]', '[due:: 2026-09-24]')));
    const r = applyTeamWriteback({ root, backupRoot, today: TODAY, task: t, change: { status: 'wip' } });
    expect(r.line).toBe('- [ ] 백업 서버 디스크 교체 일정 잡기 [owner:: 홍길동] [due:: 2026-09-24] [wip:: 2026-09-23]');

    // 같은 문장의 줄이 둘이면 어느 것인지 모른다
    const dup = path.join(root, '운영', '서버 점검.md');
    const ups = '- [ ] UPS 배터리 교체 [owner:: 홍길동, 박담당] [due:: 2026-09-30]';
    const upsTask = task(root, '운영/서버 점검.md', ups);
    fs.writeFileSync(dup, fs.readFileSync(dup, 'utf8').replace(ups, '- [ ] UPS 배터리 교체 [due:: 2026-10-01]\n- [ ] UPS 배터리 교체 [owner:: 김]'));
    expect(() => applyTeamWriteback({ root, backupRoot, today: TODAY, task: upsTask, change: { status: 'done' } })).toThrow(TEAM_LINE_NOT_FOUND);

    // 줄이 없어짐
    const room = task(root, MEETING, ROOM);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(ROOM, ''));
    expect(() => applyTeamWriteback({ root, backupRoot, today: TODAY, task: room, change: { status: 'done' } })).toThrow(TEAM_LINE_NOT_FOUND);
    expect(fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : []).toHaveLength(1); // 첫 저장의 것만
  });

  it('CRLF·BOM 을 유지한다', () => {
    const { root, backupRoot } = sandbox();
    const rel = '운영/crlf.md';
    const abs = path.join(root, ...rel.split('/'));
    const body = '\ufeff# 제목\r\n- [ ] 일 하나 [owner:: 김]\r\n- [ ] 일 둘\r\n';
    fs.writeFileSync(abs, body, 'utf8');
    const raw = '- [ ] 일 하나 [owner:: 김]';
    applyTeamWriteback({ root, backupRoot, today: TODAY, task: { id: teamTaskId(rel, raw), file: rel, line: 2, rawLine: raw }, change: { status: 'done' } });
    const bytes = fs.readFileSync(abs);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toBe('\ufeff# 제목\r\n- [x] 일 하나 [owner:: 김] [done:: 2026-09-23]\r\n- [ ] 일 둘\r\n');
  });

  it('임시 파일 이름은 동기화 제외(.<이름>.<rand>.wiki-radar-tmp)', () => {
    const { root, backupRoot } = sandbox();
    let seen: string[] = [];
    applyTeamWriteback(
      { root, backupRoot, today: TODAY, task: task(root, MEETING, DISK), change: { status: 'done' } },
      {
        beforeRename: () => {
          seen = fs.readdirSync(path.join(root, '회의록')).filter((n) => n.endsWith('.wiki-radar-tmp'));
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\.2026-09-22 주간회의\.md\.[0-9a-f]{8}\.wiki-radar-tmp$/);
    expect(isSynced(`회의록/${seen[0]}`)).toBe(false);
  });

  it('쓰기 직전에 파일이 바뀌면 다시 읽고(그 변경을 지키고), 3번 다 바뀌면 실패', () => {
    const { root, backupRoot } = sandbox();
    const abs = path.join(root, MEETING);
    let n = 0;
    const r = applyTeamWriteback(
      { root, backupRoot, today: TODAY, task: task(root, MEETING, DISK), change: { status: 'done' } },
      {
        beforeRename: () => {
          if (n++ === 0) fs.appendFileSync(abs, '\n동기화가 받은 줄');
        },
      },
    );
    expect(r.warnings[0]).toContain('다시 읽음');
    const text = fs.readFileSync(abs, 'utf8');
    expect(text).toContain('동기화가 받은 줄');
    expect(text).toContain('[done:: 2026-09-23]');

    const { root: root2, backupRoot: backup2 } = sandbox();
    const abs2 = path.join(root2, MEETING);
    let m = 0;
    expect(() =>
      applyTeamWriteback(
        { root: root2, backupRoot: backup2, today: TODAY, task: task(root2, MEETING, DISK), change: { status: 'done' } },
        { beforeRename: () => fs.appendFileSync(abs2, `\n바뀜 ${m++}`) },
      ),
    ).toThrow(/3번/);
    expect(fs.readFileSync(abs2, 'utf8')).toContain(DISK);
    expect(fs.existsSync(backup2) ? fs.readdirSync(backup2) : []).toEqual([]);
  });

  it('거부: 사본 밖 · .md 아님 · 충돌 사본 · 템플릿 · 휴지통 · 정션 — 파일을 건드리지 않는다', () => {
    const { root, backupRoot } = sandbox();
    const refuse = (file: string) =>
      expect(() =>
        applyTeamWriteback({ root, backupRoot, today: TODAY, task: { id: 't:aaaa', file, rawLine: '- [ ] x' }, change: { status: 'done' } }),
      ).toThrow(/쓸 수 없는/);
    refuse('../밖.md');
    refuse('C:/Windows/win.ini');
    refuse('README.txt');
    refuse('운영/서버 점검 (충돌 홍길동 09-22 1530).md');
    refuse('templates/회의록 템플릿.md');
    refuse('.휴지통/2026-09-20/옛 회의록.md');
    refuse('.obsidian/templates.json');
    refuse('없는 문서.md');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-team-out-'));
    temps.push(outside);
    fs.writeFileSync(path.join(outside, 'x.md'), '- [ ] 밖\n');
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      linked = true;
    } catch {
      // 링크를 만들 수 없는 환경
    }
    if (linked) refuse('link/x.md');
    expect(fs.readFileSync(path.join(outside, 'x.md'), 'utf8')).toBe('- [ ] 밖\n');
    expect(() => checkTeamWritable(root, MEETING)).not.toThrow();
  });

  it('백업 폴더가 사본 안이면 거부', () => {
    const { root } = sandbox();
    expect(() =>
      applyTeamWriteback({ root, backupRoot: path.join(root, 'team-backup'), today: TODAY, task: task(root, MEETING, DISK), change: { status: 'done' } }),
    ).toThrow(/NAS/);
  });

  it('30일 지난 백업 폴더만 지운다', () => {
    const { backupRoot } = sandbox();
    for (const name of ['20260801T090000', '20260901T090000-2', '20260922T090000', '이상한 폴더']) fs.mkdirSync(path.join(backupRoot, name), { recursive: true });
    expect(pruneTeamBackups(backupRoot, NOW)).toBe(1);
    expect(fs.readdirSync(backupRoot).sort()).toEqual(['20260901T090000-2', '20260922T090000', '이상한 폴더'].sort());
    expect(pruneTeamBackups(path.join(backupRoot, '없음'), NOW)).toBe(0);
  });
});

describe('IPC 입력 검사', () => {
  const ok = { taskId: 't:0123456789ab', rawLine: '- [ ] 일' };

  it('맞는 입력', () => {
    expect(requireSaveTeamTaskInput({ ...ok, status: 'done', extra: 1 })).toEqual({ ...ok, status: 'done' });
    expect(requireSaveTeamTaskInput({ ...ok, owners: [' 홍길동 ', '김'], due: '' })).toEqual({ ...ok, owners: ['홍길동', '김'], due: '' });
    expect(requireSaveTeamTaskInput({ ...ok, due: '2026-09-30' }).due).toBe('2026-09-30');
  });

  it('틀린 입력', () => {
    const bad = (v: unknown) => expect(() => requireSaveTeamTaskInput(v)).toThrow();
    bad(null);
    bad([]);
    bad({ ...ok }); // 바꿀 것 없음
    bad({ ...ok, taskId: 'c:0123', status: 'done' });
    bad({ ...ok, taskId: 't:' + 'a'.repeat(200), status: 'done' });
    bad({ ...ok, rawLine: '- [ ] a\n- [ ] b', status: 'done' });
    bad({ ...ok, rawLine: 'x'.repeat(4001), status: 'done' });
    bad({ ...ok, status: 'notmine' });
    bad({ ...ok, owners: '홍길동' });
    bad({ ...ok, owners: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] });
    bad({ ...ok, owners: ['홍[길]동'] });
    bad({ ...ok, owners: ['홍,길동'] });
    bad({ ...ok, owners: [''] });
    bad({ ...ok, owners: ['x'.repeat(51)] });
    bad({ ...ok, due: '2026-02-30' });
    bad({ ...ok, due: '9/30' });
  });

  it('문서 열기 경로: 사본 안의 있는 .md 만', () => {
    const { root } = sandbox();
    expect(requireTeamDocPath(root, MEETING)).toBe(fs.realpathSync.native(path.join(root, ...MEETING.split('/'))));
    for (const bad of ['', '../x.md', 'README.txt', '운영/서버 점검 (충돌 홍길동 09-22 1530).md', 'x'.repeat(1025), 3]) {
      expect(() => requireTeamDocPath(root, bad)).toThrow();
    }
  });
});
