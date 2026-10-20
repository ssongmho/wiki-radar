// 풀스크린 목록 열: 모든 구간. 기타는 접었다 편다. 선택한 줄은 앰버 테두리.
// 줄은 roving tabindex(선택한 줄만 Tab 으로 들어온다). 위/아래 키 이동은 FullView 가 맡는다.
import type { ReactElement, Ref } from 'react';
import type { Bucket, Task } from '../../../shared/types';
import { IconChevronDown, IconList } from '../../components/Icons';
import { EmptyState } from '../../components/StateMessage';
import { BucketHeading, TaskRow } from '../../components/TaskRow';
import { cls } from '../../lib/cls';
import { BUCKETS } from '../../lib/tasks';

export interface TaskListProps {
  groups: Record<Bucket, Task[]>;
  today: string;
  selectedId: string | null;
  /** Tab 으로 들어올 줄(보통 선택한 줄. 선택이 접힌 기타에 있으면 첫 줄) */
  focusableId: string | null;
  otherOpen: boolean;
  onToggleOther: () => void;
  onSelect: (task: Task) => void;
  registerRow: (id: string, el: HTMLButtonElement | null) => void;
  /** 개인·팀 할 일이 섞인 목록(출처 칩을 보인다 — 2.9단계 §4-2) */
  mixed?: boolean;
  /** 빈 목록 문장(없으면 기본) */
  emptyTitle?: string;
  emptyText?: string;
  /** 기타 줄 묶음의 id(한 화면에 목록이 둘일 때 겹치지 않게) */
  idPrefix?: string;
  ref?: Ref<HTMLDivElement>;
}

const HINTS: Partial<Record<Bucket, string>> = {
  stale: '오래 밀렸거나 15영업일 넘게 열림',
};

export function TaskList(props: TaskListProps): ReactElement {
  const { groups, today, selectedId, focusableId, otherOpen, onToggleOther, onSelect, registerRow, mixed, ref } = props;
  const prefix = props.idPrefix ?? 'fv';
  const total = BUCKETS.reduce((n, b) => n + groups[b].length, 0);

  const renderRows = (bucket: Bucket, tasks: Task[], id?: string): ReactElement => (
    <ul className="rows" id={id}>
      {tasks.map((task, i) => (
        <li key={`${task.id}@${i}`}>
          <TaskRow
            task={task}
            today={today}
            variant="full"
            selected={task.id === selectedId}
            tabIndex={task.id === focusableId ? 0 : -1}
            onActivate={onSelect}
            mixed={mixed}
            ref={(el) => registerRow(task.id, el)}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <div className="fv-list-body scroll" ref={ref}>
      {total === 0 ? (
        <EmptyState title={props.emptyTitle ?? '열린 할 일이 없습니다.'}>
          {props.emptyText ?? '위키에 새 할 일이 생기면 여기에 바로 나타납니다.'}
        </EmptyState>
      ) : (
        BUCKETS.map((bucket) => {
          const tasks = groups[bucket];
          const headId = `${prefix}-bucket-${bucket}`;
          if (bucket === 'other' && tasks.length > 0) {
            return (
              <section key={bucket} className="bucket" data-testid="bucket-other" data-count={tasks.length}>
                <h3 className="bucket-head-wrap">
                  <button
                    type="button"
                    className={cls('bucket-toggle', otherOpen && 'is-open')}
                    aria-expanded={otherOpen}
                    aria-controls={otherOpen ? `${prefix}-other-rows` : undefined}
                    onClick={onToggleOther}
                  >
                    <IconList size={14} />
                    <span>기타</span>
                    <span className="bucket-count">{tasks.length}</span>
                    <span className="bucket-toggle-text">{otherOpen ? '접기' : '펴기'}</span>
                    <IconChevronDown size={14} className="bucket-toggle-chevron" />
                  </button>
                </h3>
                {otherOpen && renderRows(bucket, tasks, `${prefix}-other-rows`)}
              </section>
            );
          }
          return (
            <section
              key={bucket}
              className="bucket"
              data-testid={`bucket-${bucket}`}
              data-count={tasks.length}
              aria-labelledby={headId}
            >
              <BucketHeading bucket={bucket} count={tasks.length} id={headId} hint={HINTS[bucket]} />
              {tasks.length > 0 && renderRows(bucket, tasks)}
            </section>
          );
        })
      )}
    </div>
  );
}
