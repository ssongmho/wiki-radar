// 2.9단계 B 화면 순수 함수: 출처 칩 · 팀 칸 목록·합계 · 팀 할 일 입력 초안 · 나 미리보기 수 · 개인 위키 없음의 내비
import { describe, expect, it } from 'vitest';
import type { SetupStatus, Task, TeamTaskBoard } from '../../src/shared/types';
import * as T from '../../src/renderer/lib/tasks';
import * as TT from '../../src/renderer/lib/teamTasks';
import { mePreview } from '../../src/renderer/lib/me';
import { navAvailability } from '../../src/renderer/lib/setup';

const team = (p: Partial<Task> & { owners?: string[] } = {}): Task => {
  const { owners = ['홍길동'], ...rest } = p;
  return {
    id: 't:aaaaaaaaaaaa',
    source: 'team',
    title: '백업 서버 디스크 교체',
    status: 'open',
    bucket: 'overdue',
    file: '회의록/2026-09-22 주간회의.md',
    line: 10,
    rawLine: '- [ ] 백업 서버 디스크 교체 [owner:: 홍길동] [due:: 2026-09-22]',
    due: '2026-09-22',
    team: { file: '회의록/2026-09-22 주간회의.md', doc: '2026-09-22 주간회의', owners, mine: true },
    ...rest,
  };
};
const personal: Task = { id: 'c:1', source: 'checkbox', title: '개인 일', status: 'open', bucket: 'other' };
const voc: Task = { id: 'v:1', source: 'voc', title: 'VOC 일', status: 'open', bucket: 'other', voc: { id: 1, number: 'VOC-2026-0001', status: 'in_progress' } };

const board = (): TeamTaskBoard => ({
  state: 'ok',
  generatedAt: new Date(2026, 8, 23, 10, 32).toISOString(),
  me: { names: ['홍길동'], source: 'settings' },
  tasks: [
    team(),
    team({ id: 't:b', title: '방화벽', bucket: 'thisWeek', owners: ['김담당'] }),
    team({ id: 't:c', title: '회의실', bucket: 'other', owners: [] }),
  ],
  lanes: [
    { key: 'unassigned', label: '미배정', taskIds: ['t:c'], overdue: 0, thisWeek: 0 },
    { key: 'me', label: '나', me: true, taskIds: ['t:aaaaaaaaaaaa'], overdue: 1, thisWeek: 0 },
    { key: 'owner:김담당', label: '김담당', taskIds: ['t:b'], overdue: 0, thisWeek: 1 },
  ],
  totals: { open: 3, unassigned: 1, mine: 1, overdue: 1, thisWeek: 1 },
  warnings: [],
  partial: false,
});

describe('출처 칩(§4-2)', () => {
  it('sourceKind: team · personal(큐레이션·체크박스) · voc', () => {
    expect(T.sourceKind(team())).toBe('team');
    expect(T.sourceKind(personal)).toBe('personal');
    expect(T.sourceKind({ ...personal, source: 'curated' })).toBe('personal');
    expect(T.sourceKind(voc)).toBe('voc');
  });

  it('풀스크린은 섞일 때만 "팀 · 문서이름" / "개인", 사이드바는 팀만 "팀", VOC 는 없음', () => {
    expect(T.sourceChipText(team(), 'full', true)).toBe('팀 · 2026-09-22 주간회의');
    expect(T.sourceChipText(personal, 'full', true)).toBe('개인');
    expect(T.sourceChipText(team(), 'full', false)).toBeUndefined();
    expect(T.sourceChipText(personal, 'full', false)).toBeUndefined();
    expect(T.sourceChipText(team(), 'sidebar', false)).toBe('팀');
    expect(T.sourceChipText(personal, 'sidebar', true)).toBeUndefined();
    expect(T.sourceChipText(voc, 'full', true)).toBeUndefined();
    // 문서 이름이 없으면 파일 이름에서
    expect(T.teamDocOf(team({ team: { file: 'a/b.md', doc: '', owners: [], mine: false } }))).toBe('b');
  });

  it('상세 칩: 팀 위키 · 경로, 담당(여럿이면 ", ") 또는 미배정', () => {
    const chips = T.detailChips(team({ owners: ['홍길동', '박담당'] }), '2026-09-23');
    expect(chips.find((c) => c.key === 'team')?.text).toBe('팀 위키 · 회의록/2026-09-22 주간회의.md');
    expect(chips.find((c) => c.key === 'team-owner')?.text).toBe('담당 홍길동, 박담당');
    expect(T.detailChips(team({ owners: [] }), '2026-09-23').find((c) => c.key === 'team-owner')?.text).toBe('미배정');
    expect(T.detailChips(personal, '2026-09-23').some((c) => c.key === 'team')).toBe(false);
  });
});

describe('팀 보드(§4-1)', () => {
  it('normalizeTeamBoard: 모양 검사', () => {
    expect(TT.normalizeTeamBoard(null)).toBeNull();
    expect(TT.normalizeTeamBoard({ state: 'weird' })).toBeNull();
    const b = TT.normalizeTeamBoard({ ...board(), tasks: [...board().tasks, { nope: 1 }], lanes: [...board().lanes, 3] });
    expect(b?.tasks).toHaveLength(3);
    expect(b?.lanes).toHaveLength(3);
    expect(TT.normalizeTeamBoard({ state: 'off' })).toMatchObject({ state: 'off', tasks: [], lanes: [], totals: { open: 0 } });
  });

  it('칸의 할 일·합계 글자·칸 이름', () => {
    const b = board();
    expect(TT.laneTasks(b, 'owner:김담당').map((t) => t.id)).toEqual(['t:b']);
    expect(TT.laneTasks(b, '없는 칸').map((t) => t.id)).toEqual(['t:c']); // 첫 칸
    expect(TT.teamTotalsText(b)).toBe('팀 할 일 3 · 미배정 1 · 지남 1 · 이번 주 1 · 오전 10:32 읽음');
    expect(TT.teamLaneLabel(b.lanes[1])).toBe('나 1건, 지남 1');
  });

  it('안내 문장: off · missing · error', () => {
    expect(TT.teamBoardNote(null)).toContain('읽는 중');
    expect(TT.teamBoardNote({ ...board(), state: 'off' })).toContain('꺼져');
    expect(TT.teamBoardNote({ ...board(), state: 'missing' })).toBe('팀 위키 사본이 아직 없습니다 — 설정 › 점검에서 지금 동기화하세요');
    expect(TT.teamBoardNote({ ...board(), state: 'error', message: '읽지 못함' })).toBe('읽지 못함');
    expect(TT.teamBoardNote(board())).toBeNull();
  });

  it('알려진 담당(datalist): 나의 이름 + 담당, 같은 이름은 하나', () => {
    expect(TT.knownOwners(board())).toEqual(['홍길동', '김담당']);
    expect(TT.knownOwners(null)).toEqual([]);
  });

  it('나 미리보기 수: 보드의 담당 목록으로 센다', () => {
    const owners = TT.teamOwnerLists(board());
    expect(owners).toEqual([['홍길동'], ['김담당'], []]);
    expect(mePreview({ name: '홍길동', aliases: '' }, undefined, owners, true)).toMatchObject({ mine: 1, total: 3 });
    expect(mePreview({ name: '홍길동', aliases: '김 담당' }, undefined, owners, true)).toMatchObject({ mine: 2, total: 3 });
    expect(TT.teamOwnerLists({ ...board(), state: 'missing' })).toBeNull();
  });
});

describe('팀 할 일 입력(§4-3)', () => {
  it('처음 입력값 · 바뀐 것만 저장 입력으로', () => {
    const t = team({ status: 'wip' });
    const d = TT.teamDraftOf(t);
    expect(d).toEqual({ status: 'wip', owners: '홍길동', due: '2026-09-22' });
    expect(TT.teamSaveInput(t, d)).toBeNull();
    expect(TT.teamSaveInput(t, { ...d, owners: ' 홍 길동 ' })).toBeNull(); // 같은 이름(공백 무시)
    expect(TT.teamSaveInput(t, { ...d, status: 'done' })).toEqual({ taskId: t.id, rawLine: t.rawLine, status: 'done' });
    expect(TT.teamSaveInput(t, { ...d, owners: '김담당, 박담당', due: '' })).toEqual({
      taskId: t.id,
      rawLine: t.rawLine,
      owners: ['김담당', '박담당'],
      due: '',
    });
    expect(TT.teamSaveInput(t, { ...d, owners: '' })?.owners).toEqual([]);
  });

  it('입력 검사', () => {
    const d = TT.teamDraftOf(team());
    expect(TT.teamDraftProblem(d)).toBeNull();
    expect(TT.teamDraftProblem({ ...d, owners: '홍[길]동' })).toContain('담당');
    expect(TT.teamDraftProblem({ ...d, owners: Array.from({ length: 11 }, (_, i) => `사람${i}`).join(',') })).toContain('10명');
    expect(TT.teamDraftProblem({ ...d, due: '2026-02-30' })).toContain('기한');
  });

  it('담당을 내가 아닌 사람으로 바꾸면 내 것이 아니다', () => {
    expect(TT.staysMine({ status: 'open', owners: '김담당', due: '' }, ['홍길동'])).toBe(false);
    expect(TT.staysMine({ status: 'open', owners: '김담당, 홍 길동', due: '' }, ['홍길동'])).toBe(true);
  });

  it('저장 알림: 팀 위키에 저장 문장 · 경고면 warn · 실패는 error', () => {
    const t = team();
    const n = TT.teamSaveNotice(t, { taskId: t.id, rawLine: '', status: 'done' }, { file: 'a.md', changed: true, backupDir: 'team-backup/x', warnings: [] }, 1);
    expect(n.tone).toBe('ok');
    expect(n.title).toBe('‘백업 서버 디스크 교체’ — 완료');
    expect(n.lines[0].text).toBe('팀 위키에 저장했습니다 — 동기화가 곧 NAS 로 올립니다');
    const w = TT.teamSaveNotice(t, { taskId: t.id, rawLine: '', owners: [] }, { file: 'a.md', changed: true, warnings: ['멈춤'] }, 2);
    expect(w.tone).toBe('warn');
    expect(w.title).toContain('담당 지움');
    expect(TT.teamSaveFailure(t, '못 씀', 3).tone).toBe('error');
  });
});

describe('개인 위키 없음 + 팀 켬의 내비(§1·§3)', () => {
  const status: SetupStatus = {
    wiki: { ok: false, path: 'C:/없음', source: 'settings' },
    claude: { ok: true, path: 'claude', source: 'path' },
    mail: { ok: true },
    seen: true,
  };
  it('스냅샷(팀 것)이 있으면 할 일은 흐리지 않고 반영 대기만 흐리다', () => {
    const nav = navAvailability({ status, hasSnapshot: true, personalMissing: true, board: null });
    expect(nav.tasks).toBeUndefined();
    expect(nav.queue).toBe('개인 위키가 없어 반영할 수 없습니다');
    expect(navAvailability({ status, hasSnapshot: false, board: null }).tasks).toBe('위키 없음');
  });
});

describe('스냅샷 정리(§3)', () => {
  it('personalMissing 을 남긴다', async () => {
    const { normalizeSnapshot } = await import('../../src/renderer/lib/snapshot');
    expect(normalizeSnapshot({ tasks: [], personalMissing: true }).personalMissing).toBe(true);
    expect(normalizeSnapshot({ tasks: [] }).personalMissing).toBeUndefined();
  });
});
