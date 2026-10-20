// 할 일 화면의 「팀 전체」 탭(2.9단계 명세 §4-1): 내비 오른쪽 전체 = 머리(탭 · 합계) | 담당 칸 목록 | 고른 칸의 할 일 | 상세 + 팀 할 일 입력.
// VOC 보드처럼 세 열이다. 칸·고른 할 일은 FullView 가 메모리에 들고 있다(탭·화면을 오가도 그대로).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import type { Task, TeamLane, TeamTaskBoard } from '../../../shared/types';
import { IconTicket, IconUser } from '../../components/Icons';
import { EmptyState, LoadingState } from '../../components/StateMessage';
import { cls } from '../../lib/cls';
import { BUCKETS, groupByBucket } from '../../lib/tasks';
import { laneTasks, teamBoardNote, teamLaneLabel, teamTotalsText } from '../../lib/teamTasks';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import type { TeamTaskFormProps } from './TeamTaskForm';

/** 팀 전체 탭에서 고른 것(FullView 가 들고 있다) */
export interface TeamSelection {
  lane: string | null;
  id: string | null;
  index: number;
}

export const INITIAL_TEAM_SELECTION: TeamSelection = { lane: null, id: null, index: 0 };

export interface TeamTasksViewProps {
  board: TeamTaskBoard | null;
  today: string;
  /** 머리의 [내 할 일 | 팀 전체] 탭 */
  tabs: ReactNode;
  selection: TeamSelection;
  onSelectionChange: (next: TeamSelection | ((prev: TeamSelection) => TeamSelection)) => void;
  /** 팀 할 일 입력(없으면 그리지 않는다) */
  teamForm?: (task: Task) => Omit<TeamTaskFormProps, 'task'>;
  onOpenTeamDoc: (path: string) => void;
  onOpenFile: (path: string) => void;
  notice?: ReactNode;
}

function LaneList({ lanes, selectedKey, onSelect }: { lanes: readonly TeamLane[]; selectedKey: string | null; onSelect: (lane: TeamLane) => void }): ReactElement {
  return (
    <nav className="vv-lanes tv-lanes scroll" aria-label="담당 칸">
      <ul className="vv-lane-list">
        {lanes.map((lane) => {
          const selected = lane.key === selectedKey;
          const unassigned = lane.key === 'unassigned';
          const count = lane.taskIds.length;
          return (
            <li key={lane.key}>
              <button
                type="button"
                className={cls('vv-lane', selected && 'is-selected', unassigned && 'vv-lane--unassigned', unassigned && count > 0 && 'is-attention')}
                data-testid="team-lane"
                data-lane={lane.key}
                data-count={count}
                aria-current={selected ? 'true' : undefined}
                aria-label={teamLaneLabel(lane)}
                onClick={() => onSelect(lane)}
              >
                <span className="vv-lane-head">
                  {unassigned ? <IconTicket size={16} /> : <IconUser size={16} />}
                  <span className="vv-lane-name">{lane.label}</span>
                  <span className={cls('vv-lane-count', count === 0 && 'is-zero')}>{count}</span>
                </span>
                {(lane.overdue > 0 || lane.thisWeek > 0) && (
                  <span className="vv-lane-meta" aria-hidden="true">
                    {lane.overdue > 0 && <span className="vv-lane-part tone-coral">지남 {lane.overdue}</span>}
                    {lane.thisWeek > 0 && <span className="vv-lane-part">이번 주 {lane.thisWeek}</span>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function TeamTasksView({
  board,
  today,
  tabs,
  selection,
  onSelectionChange,
  teamForm,
  onOpenTeamDoc,
  onOpenFile,
  notice,
}: TeamTasksViewProps): ReactElement {
  const ok = board?.state === 'ok';
  const lanes = ok ? board.lanes : [];
  const laneKey = lanes.some((l) => l.key === selection.lane) ? selection.lane : (lanes.find((l) => l.me)?.key ?? lanes[0]?.key ?? null);
  const tasks = useMemo(() => (ok && board ? laneTasks(board, laneKey) : []), [ok, board, laneKey]);
  const groups = useMemo(() => groupByBucket(tasks), [tasks]);
  const ordered = useMemo(() => BUCKETS.flatMap((b) => groups[b]), [groups]);
  const [otherOpen, setOtherOpen] = useState(true);

  const found = selection.id ? ordered.findIndex((t) => t.id === selection.id) : -1;
  const index = ordered.length === 0 ? -1 : found >= 0 ? found : Math.min(Math.max(selection.index, 0), ordered.length - 1);
  const selected: Task | null = index >= 0 ? ordered[index] : null;
  const visible = otherOpen ? ordered : ordered.filter((t) => t.bucket !== 'other');
  const focusableId = selected && visible.some((t) => t.id === selected.id) ? selected.id : (visible[0]?.id ?? null);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRow = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const select = useCallback(
    (task: Task) => onSelectionChange((prev) => ({ ...prev, lane: laneKey, id: task.id, index: Math.max(0, ordered.indexOf(task)) })),
    [onSelectionChange, laneKey, ordered],
  );
  // 고른 할 일이 빠지면(완료 등) 같은 자리의 할 일을 기억한다 — 다음 저장·키 이동이 그 자리에서 이어지게
  useEffect(() => {
    if (selected && selected.id !== selection.id) onSelectionChange((prev) => ({ ...prev, id: selected.id, index }));
  }, [selected, selection.id, index, onSelectionChange]);

  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [selected?.id]);

  // 목록 안에서 위/아래·처음/끝 키로 고른다
  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || visible.length === 0) return;
    const cur = selected ? visible.findIndex((t) => t.id === selected.id) : -1;
    const next =
      e.key === 'Home' ? 0
      : e.key === 'End' ? visible.length - 1
      : cur < 0 ? 0
      : Math.min(visible.length - 1, Math.max(0, cur + (e.key === 'ArrowDown' ? 1 : -1)));
    e.preventDefault();
    const task = visible[next];
    select(task);
    rowRefs.current.get(task.id)?.focus();
  };

  const note = teamBoardNote(board);

  return (
    <div className="vv tv" data-testid="team-view" data-state={board?.state ?? 'loading'}>
      <header className="vv-head tv-head">
        <div className="vv-head-text">
          {tabs}
          {ok && board && (
            <p
              className="vv-summary tv-totals"
              data-testid="team-totals"
              data-open={board.totals.open}
              data-unassigned={board.totals.unassigned}
              data-overdue={board.totals.overdue}
              data-this-week={board.totals.thisWeek}
            >
              {teamTotalsText(board)}
            </p>
          )}
        </div>
      </header>
      {!ok || !board ? (
        <div className="vv-state">
          {board ? <EmptyState title="팀 위키 할 일이 없습니다.">{note}</EmptyState> : <LoadingState text={note ?? undefined} />}
        </div>
      ) : (
        <>
          <LaneList
            lanes={lanes}
            selectedKey={laneKey}
            onSelect={(lane) => onSelectionChange({ lane: lane.key, id: null, index: 0 })}
          />
          <section className="vv-list tv-list" aria-label="고른 칸의 팀 할 일" onKeyDown={onListKey}>
            {board.me.names.length === 0 && (
              <p className="tv-note" data-testid="team-no-name">
                나의 이름이 없어 내 것으로 잡히는 팀 할 일이 없습니다 — 설정 › 나에서 이름을 정하세요.
              </p>
            )}
            <TaskList
              groups={groups}
              today={today}
              selectedId={selected?.id ?? null}
              focusableId={focusableId}
              otherOpen={otherOpen}
              onToggleOther={() => setOtherOpen((v) => !v)}
              onSelect={select}
              registerRow={registerRow}
              mixed
              idPrefix="tv"
              emptyTitle="이 칸에는 열린 팀 할 일이 없습니다."
              emptyText="팀 위키에 이 담당의 할 일이 생기면 여기에 나타납니다."
            />
          </section>
          <div className="tv-detail">
            <TaskDetail
              ref={detailRef}
              task={selected}
              today={today}
              onOpenFile={onOpenFile}
              onOpenTeamDoc={onOpenTeamDoc}
              teamForm={selected && teamForm ? teamForm(selected) : undefined}
              notice={notice}
            />
          </div>
        </>
      )}
    </div>
  );
}
