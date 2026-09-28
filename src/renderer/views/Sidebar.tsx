// 사이드바 모드(폭 320, 화면 오른쪽 고정). 흘깃 보는 용도라 한 줄 제목만 보여 준다.
// 머리는 끌어 옮기는 영역이고, 목록 영역만 스크롤한다. 맨 아래 상태 줄(시안 Main)은 2단계에서 "반영 N"만 둔다
// (변경·판단은 3단계).
import { useMemo, useState, type ReactElement } from 'react';
import type { Bucket, Snapshot, Task } from '../../shared/types';
import { FOCUS_QUEUE_VIEW } from '../api';
import { IconArchive, IconChevronRight, IconExpand, IconList, IconPin, IconPower, IconUpload } from '../components/Icons';
import { EmptyState, ErrorState, LoadingState, NoticeBar, PartialNote } from '../components/StateMessage';
import { BucketHeading, TaskRow } from '../components/TaskRow';
import { BreakNote, WeekTrack } from '../components/WeekTrack';
import type { SnapshotHook } from '../hooks/useSnapshot';
import { useNotice } from '../hooks/useNotice';
import { useQueue } from '../hooks/useQueue';
import { cls } from '../lib/cls';
import { formatLongDate, localYmd } from '../lib/date';
import { SIDEBAR_BUCKET_LIMIT, STALE_HINT, groupByBucket } from '../lib/tasks';

/** 사이드바에 줄로 펼쳐 보이는 구간(오래 열림·기타는 한 줄 요약) */
const LISTED_BUCKETS = ['overdue', 'thisWeek', 'chased'] as const satisfies readonly Bucket[];

interface SidebarBucketProps {
  bucket: Bucket;
  tasks: Task[];
  today: string;
  onOpen: (taskId?: string) => void;
}

function SidebarBucket({ bucket, tasks, today, onOpen }: SidebarBucketProps): ReactElement {
  const shown = tasks.slice(0, SIDEBAR_BUCKET_LIMIT);
  const hidden = tasks.length - shown.length;
  const headId = `sb-bucket-${bucket}`;
  return (
    <section className="bucket" data-testid={`bucket-${bucket}`} data-count={tasks.length} aria-labelledby={headId}>
      <BucketHeading bucket={bucket} count={tasks.length} id={headId} />
      {shown.length > 0 && (
        <ul className="rows">
          {shown.map((task, i) => (
            <li key={`${task.id}@${i}`}>
              <TaskRow task={task} today={today} variant="sidebar" onActivate={() => onOpen(task.id)} />
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="more-btn" onClick={() => onOpen(tasks[SIDEBAR_BUCKET_LIMIT]?.id)}>
          <span>{hidden}건 더 보기</span>
          <IconChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

function SidebarBody({ snapshot, onOpen }: { snapshot: Snapshot; onOpen: (taskId?: string) => void }): ReactElement {
  const { week, tasks } = snapshot;
  const groups = useMemo(() => groupByBucket(tasks), [tasks]);
  return (
    <>
      <section className="sb-week" aria-labelledby="sb-week-title">
        <div className="section-head">
          <h2 id="sb-week-title" className="section-title">
            이번 주
          </h2>
          <BreakNote week={week} />
        </div>
        <WeekTrack week={week} variant="sidebar" />
      </section>

      <div className="sb-list scroll">
        {snapshot.partial && <PartialNote />}
        {tasks.length === 0 ? (
          <EmptyState title="열린 할 일이 없습니다.">위키에 새 할 일이 생기면 여기에 바로 나타납니다.</EmptyState>
        ) : (
          <>
            {LISTED_BUCKETS.map((bucket) => (
              <SidebarBucket key={bucket} bucket={bucket} tasks={groups[bucket]} today={week.today} onOpen={onOpen} />
            ))}
            {groups.stale.length > 0 && (
              <button
                type="button"
                className="line-link line-link--dashed"
                data-testid="bucket-stale"
                data-count={groups.stale.length}
                aria-label={`정리 대상 ${groups.stale.length}건, ${STALE_HINT}`}
                title={STALE_HINT}
                onClick={() => onOpen(groups.stale[0]?.id)}
              >
                <IconArchive size={16} />
                <span className="line-link-text">정리 대상 {groups.stale.length}건</span>
                <IconChevronRight size={16} />
              </button>
            )}
            {groups.other.length > 0 && (
              <button
                type="button"
                className="line-link"
                data-testid="bucket-other"
                data-count={groups.other.length}
                onClick={() => onOpen(groups.other[0]?.id)}
              >
                <IconList size={16} />
                <span className="line-link-text">기타 {groups.other.length}건</span>
                <IconChevronRight size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 맨 아래 상태 줄(시안 Main 의 nav). 누르면 풀스크린의 그 화면이 열린다. 0이면 흐리게 */
function StatusLine({ queueCount, onQueue }: { queueCount: number; onQueue: () => void }): ReactElement {
  return (
    <nav className="sb-status" aria-label="다른 알림">
      <button
        type="button"
        className={cls('sb-status-item', queueCount === 0 && 'is-zero')}
        data-testid="sidebar-queue"
        data-count={queueCount}
        aria-description={`위키 지식 반영 대기 ${queueCount}건. 누르면 풀스크린의 반영 대기 화면이 열립니다.`}
        title="반영 대기 화면 열기"
        onClick={onQueue}
      >
        <IconUpload size={16} />
        <span>반영</span>
        <span className="sb-status-count">{queueCount}</span>
      </button>
    </nav>
  );
}

export function Sidebar({ state, reload }: SnapshotHook): ReactElement {
  const { notice, run } = useNotice();
  const queue = useQueue();
  // 사이드바 창은 항상 위(alwaysOnTop)로 열린다. 이후 값은 togglePin 의 결과를 따른다.
  const [pinned, setPinned] = useState(true);
  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const today = snapshot?.week.today ?? localYmd(new Date());

  const openFull = (taskId?: string): void => {
    void run((api) => (taskId ? api.setMode('full', taskId) : api.setMode('full')), '풀스크린으로 바꾸지 못했습니다.');
  };
  const togglePin = async (): Promise<void> => {
    const next = await run((api) => api.togglePin(), '항상 위 설정을 바꾸지 못했습니다.');
    if (typeof next === 'boolean') setPinned(next);
  };
  const quit = (): void => {
    void run((api) => api.quit(), '종료하지 못했습니다.');
  };
  const openQueue = (): void => {
    void run((api) => api.setMode('full', FOCUS_QUEUE_VIEW), '반영 대기 화면을 열지 못했습니다.');
  };

  return (
    <div className="sidebar" data-testid="sidebar">
      <header className="sb-head">
        <div className="brand">
          <span className="brand-name">wiki-radar</span>
          <span className="brand-date">{formatLongDate(today)}</span>
        </div>
        <div className="sb-actions">
          <button
            type="button"
            className="icon-btn"
            data-testid="btn-full"
            aria-label="풀스크린으로 전환"
            title="풀스크린으로 전환 (Ctrl+Alt+R)"
            onClick={() => openFull()}
          >
            <IconExpand size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="btn-pin"
            aria-label="항상 위에 고정"
            aria-pressed={pinned}
            title={pinned ? '항상 위 고정됨 (누르면 해제)' : '항상 위에 고정'}
            onClick={() => void togglePin()}
          >
            <IconPin size={18} />
          </button>
          <button type="button" className="icon-btn" data-testid="btn-quit" aria-label="wiki-radar 종료" title="종료" onClick={quit}>
            <IconPower size={18} />
          </button>
        </div>
      </header>

      {state.status === 'loading' && <LoadingState />}
      {state.status === 'error' && <ErrorState message={state.message} onRetry={reload} />}
      {snapshot && <SidebarBody snapshot={snapshot} onOpen={openFull} />}
      <StatusLine queueCount={queue.items.length} onQueue={openQueue} />
      <NoticeBar notice={notice} />
    </div>
  );
}
