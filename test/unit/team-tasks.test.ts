// 2.9단계 명세 §3·§12-1 — 팀 위키 할 일 읽기(test/fixtures/team-wiki, today = 2026-09-23) · 보드 · 개인 스냅샷에 합치기
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Holiday, Snapshot, Task } from '../../src/shared/types';
import { isMine, myNames, normName, ownersOf } from '../../src/shared/team';
import { buildSnapshot } from '../../src/main/wiki/snapshot';
import { emptyPersonalSnapshot, mergeExtraTasks } from '../../src/main/wiki/merge';
import { checkboxId, coreOf } from '../../src/main/wiki/checkbox';
import {
  buildTeamBoard,
  isTeamExcluded,
  readTeamTasks,
  readTemplateFolder,
  teamLineStatus,
  teamTaskId,
} from '../../src/main/wiki/teamTasks';
import { SnapshotService } from '../../src/main/ipc';
import { TeamTaskService } from '../../src/main/teamSync/tasks';

const TEAM = path.resolve(__dirname, '../fixtures/team-wiki');
const WIKI = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const HOLIDAYS = (holidaysJson as { holidays: Holiday[] }).holidays;
const MEETING = '회의록/2026-09-22 주간회의.md';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-team-tasks-'));
  temps.push(d);
  return d;
}

function read(names: string[] = ['홍길동']) {
  return readTeamTasks({ root: TEAM, today: TODAY, holidays: HOLIDAYS, names });
}

function byTitle(tasks: Task[], title: string): Task {
  const found = tasks.filter((t) => t.title === title);
  expect(found, `제목 "${title}"`).toHaveLength(1);
  return found[0];
}

describe('팀 위키 할 일 읽기 — §12-1 정답표', () => {
  const r = read();
  const board = buildTeamBoard(r, { names: ['홍길동'], source: 'settings' }, '2026-09-23T01:00:00.000Z');

  it('열린 6건, 제외(완료·st 완료·들여씀·충돌 사본·휴지통·템플릿)는 없다', () => {
    expect(r.tasks.map((t) => t.title).sort()).toEqual(
      ['백업 서버 디스크 교체 일정 잡기', '주간 점검표 갱신', '방화벽 정책 검토', '회의실 예약 시스템 문의 정리', '라이선스 갱신 확인', 'UPS 배터리 교체'].sort(),
    );
    const titles = r.tasks.map((t) => t.title);
    for (const gone of ['지난주 장애 보고서 공유', '들여쓴 하위 항목', '정리 끝난 항목', '충돌 사본의 할 일', '휴지통 할 일', '할 일']) {
      expect(titles).not.toContain(gone);
    }
    expect(r.partial).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('구간: 디스크 지남(1영업일) · 점검표·방화벽 이번 주 · 나머지 기타', () => {
    const disk = byTitle(r.tasks, '백업 서버 디스크 교체 일정 잡기');
    expect(disk.bucket).toBe('overdue');
    expect(disk.overdueDays).toBe(1);
    expect(byTitle(r.tasks, '주간 점검표 갱신').bucket).toBe('thisWeek');
    expect(byTitle(r.tasks, '방화벽 정책 검토').bucket).toBe('thisWeek');
    for (const t of ['회의실 예약 시스템 문의 정리', '라이선스 갱신 확인', 'UPS 배터리 교체']) {
      expect(byTitle(r.tasks, t).bucket).toBe('other');
    }
  });

  it('Task 모양: source team · t: ID · 팀 정보 · owner 필드는 상태에 영향 없음', () => {
    const disk = byTitle(r.tasks, '백업 서버 디스크 교체 일정 잡기');
    expect(disk.source).toBe('team');
    expect(disk.status).toBe('open');
    expect(disk.owner).toBeUndefined();
    expect(disk.file).toBe(MEETING);
    expect(disk.rawLine).toBe('- [ ] 백업 서버 디스크 교체 일정 잡기 [owner:: 홍길동] [due:: 2026-09-22]');
    expect(disk.team).toEqual({ file: MEETING, doc: '2026-09-22 주간회의', owners: ['홍길동'], mine: true });
    expect(disk.company).toBeUndefined();
    // ID 는 체크박스 c: 와 같은 핵심문구 규칙, 머리만 t:
    const sha = createHash('sha1').update(`${MEETING}|백업 서버 디스크 교체 일정 잡기`, 'utf8').digest('hex').slice(0, 12);
    expect(disk.id).toBe(`t:${sha}`);
    expect(disk.id.slice(2)).toBe(checkboxId(MEETING, disk.rawLine as string).slice(2));
    expect(coreOf(disk.rawLine as string)).toBe('백업 서버 디스크 교체 일정 잡기');
  });

  it('여러 담당·공백 무시', () => {
    expect(byTitle(r.tasks, 'UPS 배터리 교체').team?.owners).toEqual(['홍길동', '박담당']);
    expect(byTitle(r.tasks, 'UPS 배터리 교체').team?.mine).toBe(true);
    expect(byTitle(r.tasks, '라이선스 갱신 확인').team?.owners).toEqual(['홍 길동']);
    expect(byTitle(r.tasks, '라이선스 갱신 확인').team?.mine).toBe(true);
    expect(byTitle(r.tasks, '회의실 예약 시스템 문의 정리').team?.owners).toEqual([]);
  });

  it('보드: 합계 6·1·1·2·내 것 3, 칸 미배정 → 나 → 길동·김담당·박담당', () => {
    expect(board.state).toBe('ok');
    expect(board.totals).toEqual({ open: 6, unassigned: 1, mine: 3, overdue: 1, thisWeek: 2 });
    expect(board.lanes.map((l) => [l.key, l.label, l.taskIds.length])).toEqual([
      ['unassigned', '미배정', 1],
      ['me', '나', 3],
      ['owner:길동', '길동', 1],
      ['owner:김담당', '김담당', 1],
      ['owner:박담당', '박담당', 1],
    ]);
    const meLane = board.lanes[1];
    expect(meLane.me).toBe(true);
    expect(meLane.overdue).toBe(1);
    expect(board.lanes[2].thisWeek).toBe(1);
  });

  it('다른 표기 길동을 더하면 내 것 4, 「길동」 칸 없어짐', () => {
    const b = buildTeamBoard(read(['홍길동', '길동']), { names: ['홍길동', '길동'], source: 'settings' }, 'x');
    expect(b.totals.mine).toBe(4);
    expect(b.lanes.map((l) => l.key)).toEqual(['unassigned', 'me', 'owner:김담당', 'owner:박담당']);
    expect(b.lanes[1].taskIds).toHaveLength(4);
  });

  it('내 이름 없음 → 내 것 0(나 칸은 늘 있다)', () => {
    const b = buildTeamBoard(read([]), { names: [], source: 'none' }, 'x');
    expect(b.totals.mine).toBe(0);
    expect(b.lanes.find((l) => l.key === 'me')?.taskIds).toEqual([]);
    expect(b.lanes.map((l) => l.key)).toContain('owner:홍길동');
  });

  it('VOC 로그인 이름이 기본값(설정 이름이 비었을 때)', () => {
    const me = myNames({ aliases: [] }, '홍길동');
    expect(me).toEqual({ names: ['홍길동'], source: 'voc' });
    expect(buildTeamBoard(read(me.names), me, 'x').totals.mine).toBe(3);
    // 설정 이름이 있으면 VOC 이름은 쓰지 않는다
    expect(myNames({ name: '김담당', aliases: [] }, '홍길동').names).toEqual(['김담당']);
  });
});

describe('규칙 조각', () => {
  it('teamLineStatus: owner 가 있어도 open, [x]·st 완료 → done, wip → wip', () => {
    expect(teamLineStatus('- [ ] 일 [owner:: 홍길동]')).toBe('open');
    expect(teamLineStatus('- [x] 일 [owner:: 홍길동]')).toBe('done');
    expect(teamLineStatus('- [X] 일')).toBe('done');
    expect(teamLineStatus('- [ ] 일 [st:: 완 료 ]')).toBe('done');
    expect(teamLineStatus('- [ ] 일 [st:: 진행]')).toBe('open');
    expect(teamLineStatus('- [ ] 일 [wip:: 2026-09-20] [owner:: 김담당]')).toBe('wip');
  });

  it('ownersOf: 쉼표·[[문서|별칭]]·[[문서]]·@·빈 조각', () => {
    expect(ownersOf('홍길동, 김철수')).toEqual(['홍길동', '김철수']);
    expect(ownersOf('[[사람/홍길동|길동]], [[김철수]], @박담당, , ')).toEqual(['길동', '김철수', '박담당']);
    expect(ownersOf('')).toEqual([]);
    expect(ownersOf(undefined)).toEqual([]);
  });

  it('normName: 대소문자·공백·NFC', () => {
    expect(normName(' Hong  Gil ')).toBe('honggil');
    expect(normName('홍 길동')).toBe('홍길동');
    const nfd = '홍길동'.normalize('NFD');
    expect(nfd).not.toBe('홍길동');
    expect(normName(nfd)).toBe('홍길동');
    expect(isMine(['HONG'], ['hong'])).toBe(true);
    expect(isMine([], ['hong'])).toBe(false);
  });

  it('제외 판정 다섯 가지', () => {
    expect(isTeamExcluded('.휴지통/2026-09-20/옛 회의록.md', null)).toBe(true);
    expect(isTeamExcluded('#recycle/a.md', null)).toBe(true);
    expect(isTeamExcluded('.obsidian/x.md', null)).toBe(true);
    expect(isTeamExcluded('a/.hidden/b.md', null)).toBe(true);
    expect(isTeamExcluded('운영/서버 점검 (충돌 홍길동 09-22 1530).md', null)).toBe(true);
    expect(isTeamExcluded('templates/회의록 템플릿.md', 'templates')).toBe(true);
    expect(isTeamExcluded('Templates/회의록 템플릿.md', 'templates')).toBe(true);
    expect(isTeamExcluded('templates/회의록 템플릿.md', null)).toBe(false);
    expect(isTeamExcluded('운영/서버 점검.md', 'templates')).toBe(false);
    expect(isTeamExcluded('운영/~$임시.md', null)).toBe(true);
    expect(readTemplateFolder(TEAM)).toBe('templates');
  });

  it('템플릿 설정이 없으면 템플릿 폴더의 줄도 미배정 할 일이다(설정만 본다)', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'templates'));
    fs.writeFileSync(path.join(root, 'templates', 't.md'), '- [ ] 할 일 [owner:: ] [due:: ]\n');
    expect(readTeamTasks({ root, today: TODAY, holidays: HOLIDAYS, names: [] }).tasks).toHaveLength(1);
    fs.mkdirSync(path.join(root, '.obsidian'));
    fs.writeFileSync(path.join(root, '.obsidian', 'templates.json'), '{"folder":"/templates/"}');
    expect(readTeamTasks({ root, today: TODAY, holidays: HOLIDAYS, names: [] }).tasks).toHaveLength(0);
  });

  it('같은 ID 가 둘이면 -2 와 경고, 링크는 따라가지 않는다', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'a.md'), '- [ ] 같은 일 [due:: 2026-09-30]\n- [ ] 같은 일 [owner:: 김]\n');
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'b.md'), '- [ ] 밖의 일\n');
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    } catch {
      // 링크를 만들 수 없는 환경이면 링크 확인은 건너뛴다
    }
    const r = readTeamTasks({ root, today: TODAY, holidays: HOLIDAYS, names: [] });
    expect(r.tasks.map((t) => t.title)).toEqual(['같은 일', '같은 일']);
    expect(r.tasks.map((t) => t.id)).toEqual([teamTaskId('a.md', '- [ ] 같은 일'), `${teamTaskId('a.md', '- [ ] 같은 일')}-2`]);
    expect(r.warnings.some((w) => w.includes('같은 ID'))).toBe(true);
  });

  it('사본 폴더가 없으면 던진다', () => {
    expect(() => readTeamTasks({ root: path.join(tempDir(), 'none'), today: TODAY, holidays: HOLIDAYS, names: [] })).toThrow();
  });
});

describe('개인 스냅샷에 합치기(mergeExtraTasks)', () => {
  const base = buildSnapshot({ wikiRoot: WIKI, today: TODAY, holidays: HOLIDAYS });
  const mine = (names: string[]) => read(names).tasks.filter((t) => t.team?.mine);

  it('개인 사본 counts + 팀 내 것 3 → {overdue 6, thisWeek 4, chased 2, stale 2, other 12}', () => {
    expect(base.counts).toEqual({ overdue: 5, thisWeek: 4, chased: 2, stale: 2, other: 10 });
    const merged = mergeExtraTasks(base, { team: mine(['홍길동']) }, { today: TODAY, holidays: HOLIDAYS });
    expect(merged.counts).toEqual({ overdue: 6, thisWeek: 4, chased: 2, stale: 2, other: 12 });
    expect(merged.tasks.filter((t) => t.source === 'team')).toHaveLength(3);
    expect(merged.week.overdueCount).toBe(6);
  });

  it('길동을 더하면 thisWeek 5, 9/23 dueCount 3', () => {
    const merged = mergeExtraTasks(base, { team: mine(['홍길동', '길동']) }, { today: TODAY, holidays: HOLIDAYS });
    expect(merged.counts.thisWeek).toBe(5);
    expect(merged.week.days.find((d) => d.date === TODAY)?.dueCount).toBe(3);
  });

  it('VOC·팀을 같이 합치고, 다시 합치면 앞 것을 바꾼다(재촉 없음은 VOC 만)', () => {
    const voc: Task = { id: 'v:1004', source: 'voc', title: 'VOC 할 일', status: 'open', bucket: 'other', chaseCount: 3 };
    const team: Task = { ...mine(['홍길동'])[0], chaseCount: 2, due: undefined };
    delete team.due;
    const merged = mergeExtraTasks(base, { voc: [voc], team: [team] }, { today: TODAY, holidays: HOLIDAYS });
    expect(merged.tasks.find((t) => t.id === 'v:1004')?.bucket).toBe('other');
    expect(merged.tasks.find((t) => t.id === team.id)?.bucket).toBe('chased');
    const again = mergeExtraTasks(merged, { team: [] }, { today: TODAY, holidays: HOLIDAYS });
    expect(again.tasks.some((t) => t.source === 'team' || t.source === 'voc')).toBe(false);
    expect(again.counts).toEqual(base.counts);
  });

  it('t: 가 아닌 팀 할 일·닫힌 것은 넣지 않는다', () => {
    const bad: Task = { id: 'c:xx', source: 'team', title: 'x', status: 'open', bucket: 'other' };
    const done: Task = { ...mine(['홍길동'])[0], status: 'done' };
    const merged = mergeExtraTasks(base, { team: [bad, done] }, { today: TODAY, holidays: HOLIDAYS });
    expect(merged.tasks).toHaveLength(base.tasks.length);
  });
});

describe('개인 위키 없음 + 팀 켬 → personalMissing 스냅샷', () => {
  it('emptyPersonalSnapshot: 빈 할 일·오늘 기준 주간 트랙·문서 0', () => {
    const snap = emptyPersonalSnapshot({ today: TODAY, holidays: HOLIDAYS, wikiRoot: 'C:/없음' });
    expect(snap.personalMissing).toBe(true);
    expect(snap.tasks).toEqual([]);
    expect(snap.pageCount).toBe(0);
    expect(snap.week.today).toBe(TODAY);
    expect(snap.week.days).toHaveLength(5);
  });

  it('SnapshotService: 팀 켬이면 개인 위키가 없어도 팀 내 것으로, 끔이면 지금처럼 오류', () => {
    const missing = path.join(tempDir(), 'none');
    let enabled = true;
    const svc = new SnapshotService({ wikiRoot: missing, holidays: HOLIDAYS, getToday: () => TODAY, teamEnabled: () => enabled });
    const team = read(['홍길동']);
    const merged = svc.setTeamTasks({ tasks: team.tasks.filter((t) => t.team?.mine), warnings: ['경고 하나'], partial: false });
    expect(merged?.personalMissing).toBe(true);
    expect(merged?.tasks.map((t) => t.source)).toEqual(['team', 'team', 'team']);
    expect(merged?.counts).toEqual({ overdue: 1, thisWeek: 0, chased: 0, stale: 0, other: 2 });
    expect(merged?.warnings).toContain('팀 위키: 경고 하나');
    // 같은 것이 다시 오면 다시 방송하지 않는다
    expect(svc.setTeamTasks({ tasks: team.tasks.filter((t) => t.team?.mine), warnings: ['경고 하나'], partial: false })).toBeNull();
    expect(svc.current().personalMissing).toBe(true);

    enabled = false;
    const off = new SnapshotService({ wikiRoot: missing, holidays: HOLIDAYS, getToday: () => TODAY, teamEnabled: () => enabled });
    expect(() => off.current()).toThrow(/위키 폴더를 찾을 수 없습니다/);
  });

  it('SnapshotService: 개인 위키 없음 + 팀 켬으로 보이던 목록은 팀을 끄면 버리고(onCleared) 오류로 돌아간다', () => {
    const missing = path.join(tempDir(), 'none');
    let enabled = true;
    const cleared: string[] = [];
    const svc = new SnapshotService({
      wikiRoot: missing,
      holidays: HOLIDAYS,
      getToday: () => TODAY,
      teamEnabled: () => enabled,
      onCleared: (m) => cleared.push(m),
    });
    const team = read(['홍길동']);
    expect(svc.setTeamTasks({ tasks: team.tasks.filter((t) => t.team?.mine), warnings: [], partial: false })?.personalMissing).toBe(true);
    // 팀 끔: 팀 서비스가 빈 보드를 넘겨도 빈 personalMissing 목록을 방송하지 않는다
    enabled = false;
    expect(svc.setTeamTasks({ tasks: [], warnings: [], partial: false })).toBeNull();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/위키 폴더를 찾을 수 없습니다/);
    expect(() => svc.current()).toThrow(/위키 폴더를 찾을 수 없습니다/);
    // 다시 실패해도 한 번만 알린다
    expect(svc.refresh()).toBeNull();
    expect(cleared).toHaveLength(1);
    // 다시 켜면 다시 만든다
    enabled = true;
    expect(svc.current().personalMissing).toBe(true);
  });

  it('SnapshotService: 개인 위키가 있으면 팀 내 것을 합치고 팀 사본을 못 읽었으면 partial', () => {
    const svc = new SnapshotService({ wikiRoot: WIKI, holidays: HOLIDAYS, getToday: () => TODAY, teamEnabled: () => true });
    const first: Snapshot = svc.current();
    expect(first.personalMissing).toBeUndefined();
    const merged = svc.setTeamTasks({ tasks: read(['홍길동']).tasks.filter((t) => t.team?.mine), warnings: [], partial: true });
    expect(merged?.counts.overdue).toBe(6);
    expect(merged?.partial).toBe(true);
  });
});

describe('TeamTaskService', () => {
  it('꺼짐 → off, 사본 없음 → missing, 있으면 ok · 같은 보드는 다시 넘기지 않는다', () => {
    let cfg = { enabled: false, local: TEAM };
    let names = ['홍길동'];
    const boards: string[] = [];
    const svc = new TeamTaskService({
      config: () => cfg,
      me: () => ({ names, source: 'settings' }),
      today: () => TODAY,
      holidays: HOLIDAYS,
      onBoard: (b) => boards.push(`${b.state}:${b.totals.mine}`),
      watch: false,
    });
    svc.start();
    expect(svc.board().state).toBe('off');
    cfg = { enabled: true, local: path.join(tempDir(), 'none') };
    svc.reconfigure();
    expect(svc.board().state).toBe('missing');
    expect(svc.board().message).toContain('설정 › 점검');
    cfg = { enabled: true, local: TEAM };
    svc.reload();
    expect(svc.board().state).toBe('ok');
    expect(svc.mine()).toHaveLength(3);
    svc.reload();
    names = ['홍길동', '길동'];
    svc.reload('설정 › 나');
    expect(svc.mine()).toHaveLength(4);
    svc.stop();
    expect(boards).toEqual(['off:0', 'missing:0', 'ok:3', 'ok:4']);
  });

  it('켜져 있어도 설정 문제(개인 위키와 겹침 등)가 있으면 읽지 않고 error 보드', () => {
    const svc = new TeamTaskService({
      config: () => ({ enabled: true, local: TEAM, problem: '개인 위키 폴더(또는 그 상위·하위)는 팀 위키 사본으로 쓸 수 없습니다' }),
      me: () => ({ names: ['홍길동'], source: 'settings' }),
      today: () => TODAY,
      holidays: HOLIDAYS,
      onBoard: () => {},
      watch: false,
    });
    svc.start();
    expect(svc.board().state).toBe('error');
    expect(svc.board().message).toMatch(/개인 위키 폴더/);
    expect(svc.board().tasks).toEqual([]);
    expect(svc.mine()).toEqual([]);
    svc.stop();
  });
});

describe('담당이 위키 링크인 줄(명세 §3 — [[문서]]→문서, [[문서|별칭]]→별칭)', () => {
  it('readTeamTasks 가 링크 담당을 사람으로 읽고, 제목에 ]] 가 남지 않는다', () => {
    const root = tempDir();
    fs.writeFileSync(
      path.join(root, '링크.md'),
      [
        '- [ ] 링크 담당 일 [owner:: [[홍길동]]] [due:: 2026-09-25]',
        '- [ ] 별칭 담당 일 [owner:: [[사람/홍길동|길동]], 김] [due:: 2026-09-25]',
        '- [ ] 다른 사람 링크 [owner:: [[박담당]]]',
        '',
      ].join('\n'),
      'utf8',
    );
    const r = readTeamTasks({ root, today: TODAY, holidays: HOLIDAYS, names: ['홍길동', '길동'] });
    const a = byTitle(r.tasks, '링크 담당 일');
    expect(a.team?.owners).toEqual(['홍길동']);
    expect(a.team?.mine).toBe(true);
    expect(a.due).toBe('2026-09-25');
    const b = byTitle(r.tasks, '별칭 담당 일');
    expect(b.team?.owners).toEqual(['길동', '김']);
    expect(b.team?.mine).toBe(true);
    const c = byTitle(r.tasks, '다른 사람 링크');
    expect(c.team?.owners).toEqual(['박담당']);
    expect(c.team?.mine).toBe(false);
    const board = buildTeamBoard(r, { names: ['홍길동', '길동'], source: 'settings' }, '2026-09-23T01:00:00.000Z');
    expect(board.lanes.map((l) => l.label).filter((l) => l.includes('[')).length).toBe(0);
    expect(board.lanes.map((l) => l.label)).toContain('박담당');
  });

  it('한 겹 이하인 줄의 팀 ID 는 개인 핵심문구로 만든 것과 같다', () => {
    const line = '- [ ] 일 [mail:: raw/mail/a_[공지] b.md] [owner:: 김]';
    expect(teamTaskId('a.md', line)).toBe('t:' + createHash('sha1').update(`a.md|${coreOf(line)}`, 'utf8').digest('hex').slice(0, 12));
  });
});
