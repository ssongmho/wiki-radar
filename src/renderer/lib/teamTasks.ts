// 팀 위키 할 일(2.9단계 명세 §4) 화면 값: 보드 검사, 칸 목록·합계 글자, 팀 할 일 입력(상태·담당·기한)의 초안과 저장 알림.
// React 를 모르는 순수 함수만 둔다(시험하기 쉽게). 이름 비교 규칙은 main 과 같은 src/shared/team.ts.
import { ME_ALIASES_MAX, meNameProblem, normName, splitAliases } from '../../shared/team';
import type { SaveTeamTaskInput, SaveTeamTaskOutput, Task, TeamLane, TeamTaskBoard, TeamTaskStatus } from '../../shared/types';
import { formatClock, parseYmd } from './date';
import type { SaveNotice } from './result';
import { taskTitle, teamOwnersOf, textOf } from './tasks';

const STATES = new Set(['off', 'missing', 'ok', 'error']);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** main 응답 검사. 모양이 틀리면 null(할 일·칸은 모양이 맞는 것만 남긴다) */
export function normalizeTeamBoard(raw: unknown): TeamTaskBoard | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!STATES.has(r.state as string)) return null;
  const me = r.me as Record<string, unknown> | undefined;
  const names = me && Array.isArray(me.names) ? me.names.filter(isStr) : [];
  const source = me && (me.source === 'settings' || me.source === 'voc' || me.source === 'none') ? me.source : 'none';
  const tasks = Array.isArray(r.tasks)
    ? (r.tasks as unknown[]).filter((t): t is Task => !!t && typeof t === 'object' && isStr((t as Task).id) && isStr((t as Task).title))
    : [];
  const lanes = Array.isArray(r.lanes)
    ? (r.lanes as unknown[]).filter(
        (l): l is TeamLane => !!l && typeof l === 'object' && isStr((l as TeamLane).key) && isStr((l as TeamLane).label) && Array.isArray((l as TeamLane).taskIds),
      )
    : [];
  const t = (r.totals ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (isNum(v) ? v : 0);
  const board: TeamTaskBoard = {
    state: r.state as TeamTaskBoard['state'],
    me: { names, source },
    tasks,
    lanes,
    totals: { open: num(t.open), unassigned: num(t.unassigned), mine: num(t.mine), overdue: num(t.overdue), thisWeek: num(t.thisWeek) },
    warnings: Array.isArray(r.warnings) ? r.warnings.filter(isStr) : [],
    partial: r.partial === true,
  };
  if (isStr(r.message) && r.message) board.message = r.message;
  if (isStr(r.generatedAt) && r.generatedAt) board.generatedAt = r.generatedAt;
  return board;
}

/** 열린 팀 할 일마다의 담당 목록(설정 › 나 미리보기). 보드가 ok 가 아니면 null(수를 모른다) */
export function teamOwnerLists(board: TeamTaskBoard | null): string[][] | null {
  if (!board || board.state !== 'ok') return null;
  return board.tasks.map((t) => teamOwnersOf(t));
}

/** 칸의 할 일(보드 순서 = 구간 순서) */
export function laneTasks(board: TeamTaskBoard, laneKey: string | null): Task[] {
  const lane = board.lanes.find((l) => l.key === laneKey) ?? board.lanes[0];
  if (!lane) return [];
  const ids = new Set(lane.taskIds);
  return board.tasks.filter((t) => ids.has(t.id));
}

/** 머리 합계 글자: "팀 할 일 6 · 미배정 1 · 지남 1 · 이번 주 2 · 10:32 읽음" */
export function teamTotalsText(board: TeamTaskBoard): string {
  const { totals } = board;
  const parts = [`팀 할 일 ${totals.open}`, `미배정 ${totals.unassigned}`, `지남 ${totals.overdue}`, `이번 주 ${totals.thisWeek}`];
  const clock = board.generatedAt ? formatClock(board.generatedAt) : '';
  if (clock) parts.push(`${clock} 읽음`);
  return parts.join(' · ');
}

/** 상태 off·missing·error 의 안내 문장 */
export function teamBoardNote(board: TeamTaskBoard | null): string | null {
  if (!board) return '팀 위키 할 일을 읽는 중입니다…';
  if (board.state === 'off') return '팀 위키 동기화가 꺼져 있습니다 — 설정 › 점검에서 켜면 팀 위키의 할 일을 함께 봅니다';
  if (board.state === 'missing') return '팀 위키 사본이 아직 없습니다 — 설정 › 점검에서 지금 동기화하세요';
  if (board.state === 'error') return board.message ?? '팀 위키 할 일을 읽지 못했습니다';
  return null;
}

/** 칸 줄의 읽기 도구용 이름 */
export function teamLaneLabel(lane: TeamLane): string {
  const parts = [`${lane.label} ${lane.taskIds.length}건`];
  if (lane.overdue > 0) parts.push(`지남 ${lane.overdue}`);
  if (lane.thisWeek > 0) parts.push(`이번 주 ${lane.thisWeek}`);
  return parts.join(', ');
}

/** 담당 칸에 보일 알려진 담당 이름(datalist) — 칸 이름 + 나의 이름들, 같은 normName 은 하나 */
export function knownOwners(board: TeamTaskBoard | null): string[] {
  if (!board) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const key = normName(name);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const n of board.me.names) push(n);
  for (const lane of board.lanes) if (lane.key.startsWith('owner:')) push(lane.label);
  for (const t of board.tasks) for (const o of teamOwnersOf(t)) push(o);
  return out;
}

// ── 팀 할 일 입력(§4-3) ──

export interface TeamDraft {
  status: TeamTaskStatus;
  /** 담당 글자 칸 그대로(여럿이면 `,`) */
  owners: string;
  /** YYYY-MM-DD 또는 '' */
  due: string;
}

/** 할 일 → 처음 입력값(지금 상태·담당·기한) */
export function teamDraftOf(task: Task): TeamDraft {
  return {
    status: task.status === 'wip' ? 'wip' : 'open',
    owners: teamOwnersOf(task).join(', '),
    due: parseYmd(task.due) ? (task.due as string) : '',
  };
}

const ownersKey = (list: readonly string[]) => list.map(normName).join('\n');

/** 저장할 입력(바뀐 것만). 바뀐 것이 없으면 null */
export function teamSaveInput(task: Task, draft: TeamDraft): SaveTeamTaskInput | null {
  const base = teamDraftOf(task);
  const input: SaveTeamTaskInput = { taskId: task.id, rawLine: textOf(task.rawLine) ? (task.rawLine as string) : '' };
  let changed = false;
  if (draft.status !== base.status) {
    input.status = draft.status;
    changed = true;
  }
  const owners = splitAliases(draft.owners);
  if (ownersKey(owners) !== ownersKey(splitAliases(base.owners))) {
    input.owners = owners;
    changed = true;
  }
  if (draft.due !== base.due) {
    input.due = draft.due;
    changed = true;
  }
  return changed ? input : null;
}

/** 입력 문제(없으면 null) — main 의 requireSaveTeamTaskInput 과 같은 규칙 */
export function teamDraftProblem(draft: TeamDraft): string | null {
  const owners = splitAliases(draft.owners);
  if (owners.length > ME_ALIASES_MAX) return `담당은 ${ME_ALIASES_MAX}명까지입니다`;
  for (const o of owners) {
    const problem = meNameProblem(o);
    if (problem) return `담당 「${o.slice(0, 20)}」: ${problem}`;
  }
  if (draft.due !== '' && !parseYmd(draft.due)) return '기한은 날짜로 고르세요';
  return null;
}

/** 담당이 바뀐 뒤에도 내 것인가(내가 아닌 사람으로 바꾸면 내 할 일 목록에서 빠진다) */
export function staysMine(draft: TeamDraft, names: readonly string[]): boolean {
  const mine = new Set(names.map(normName));
  return splitAliases(draft.owners).some((o) => mine.has(normName(o)));
}

const STATUS_LABEL: Record<TeamTaskStatus, string> = { open: '대기', wip: '진행 중', done: '완료' };

export function teamStatusLabel(status: TeamTaskStatus): string {
  return STATUS_LABEL[status];
}

/** 저장 결과 알림(2단계 save-notice 와 같은 띠) */
export function teamSaveNotice(task: Task, input: SaveTeamTaskInput, out: SaveTeamTaskOutput, id: number): SaveNotice {
  const warnings = Array.isArray(out?.warnings) ? out.warnings.filter((w) => isStr(w) && w.trim() !== '') : [];
  const lines: SaveNotice['lines'] = [];
  if (out?.changed === false) lines.push({ text: '줄이 이미 그 내용이라 바꾸지 않았습니다.' });
  else {
    lines.push({ text: '팀 위키에 저장했습니다 — 동기화가 곧 NAS 로 올립니다' });
    if (isStr(out?.file)) lines.push({ text: `고친 문서: ${out.file}` });
    if (isStr(out?.backupDir)) lines.push({ text: `고치기 전 사본: ${out.backupDir}` });
  }
  const changes: string[] = [];
  if (input.status) changes.push(teamStatusLabel(input.status));
  if (input.owners) changes.push(input.owners.length > 0 ? `담당 ${input.owners.join(', ')}` : '담당 지움');
  if (input.due !== undefined) changes.push(input.due ? `기한 ${input.due}` : '기한 지움');
  for (const w of warnings) lines.push({ text: w, warn: true });
  return {
    id,
    tone: warnings.length > 0 ? 'warn' : 'ok',
    title: `‘${taskTitle(task)}’ — ${changes.join(' · ') || '저장'}`,
    lines,
  };
}

/** 저장 실패 알림 */
export function teamSaveFailure(task: Task, message: string, id: number): SaveNotice {
  return { id, tone: 'error', title: `‘${taskTitle(task)}’ — 팀 위키에 저장하지 못했습니다`, lines: [{ text: message, warn: true }] };
}
